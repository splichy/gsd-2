import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { isClosedStatus } from "../status-guards.js";
import {
  transaction,
  insertMilestone,
  insertSlice,
  insertTask,
  insertVerificationEvidence,
  getMilestone,
  getSlice,
  getTask,
  updateTaskStatus,
  deleteVerificationEvidence,
  saveGateResult,
  getPendingGatesForTurn
} from "../gsd-db.js";
import { getGatesForTurn } from "../gate-registry.js";
import { resolveTasksDir, clearPathCache } from "../paths.js";
import { checkOwnership, taskUnitKey } from "../unit-ownership.js";
import { saveFile, clearParseCache } from "../files.js";
import { invalidateStateCache } from "../state.js";
import { renderPlanCheckboxes } from "../markdown-renderer.js";
import { renderAllProjections, renderSummaryContent } from "../workflow-projections.js";
import { writeManifest } from "../workflow-manifest.js";
import { appendEvent } from "../workflow-events.js";
import { logWarning, logError } from "../workflow-logger.js";
import { loadEffectiveGSDPreferences } from "../preferences.js";
import { isStaleWrite } from "../auto/turn-epoch.js";
import { buildEscalationArtifact, writeEscalationArtifact } from "../escalation.js";
function taskGateFieldForId(id, params) {
  switch (id) {
    case "Q5":
      return params.failureModes;
    case "Q6":
      return params.loadProfile;
    case "Q7":
      return params.negativeTests;
    default:
      return void 0;
  }
}
function normalizeListParam(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.trim()) {
    return value.split(/\n/).map((s) => s.replace(/^[\s\-*•]+/, "").trim()).filter(Boolean);
  }
  return [];
}
function paramsToTaskRow(params, completedAt) {
  return {
    milestone_id: params.milestoneId,
    slice_id: params.sliceId,
    id: params.taskId,
    title: params.oneLiner || params.taskId,
    status: "complete",
    one_liner: params.oneLiner,
    narrative: params.narrative,
    verification_result: params.verification,
    duration: "",
    completed_at: completedAt,
    blocker_discovered: params.blockerDiscovered ?? false,
    deviations: params.deviations ?? "",
    known_issues: params.knownIssues ?? "",
    key_files: normalizeListParam(params.keyFiles),
    key_decisions: normalizeListParam(params.keyDecisions),
    full_summary_md: "",
    description: "",
    estimate: "",
    files: [],
    verify: "",
    inputs: [],
    expected_output: [],
    observability_impact: "",
    full_plan_md: "",
    sequence: 0,
    blocker_source: "",
    escalation_pending: 0,
    escalation_awaiting_review: 0,
    escalation_artifact_path: null,
    escalation_override_applied_at: null
  };
}
async function handleCompleteTask(params, basePath) {
  if (!params.taskId || typeof params.taskId !== "string" || params.taskId.trim() === "") {
    return { error: "taskId is required and must be a non-empty string" };
  }
  if (!params.sliceId || typeof params.sliceId !== "string" || params.sliceId.trim() === "") {
    return { error: "sliceId is required and must be a non-empty string" };
  }
  if (!params.milestoneId || typeof params.milestoneId !== "string" || params.milestoneId.trim() === "") {
    return { error: "milestoneId is required and must be a non-empty string" };
  }
  const ownershipErr = checkOwnership(
    basePath,
    taskUnitKey(params.milestoneId, params.sliceId, params.taskId),
    params.actorName
  );
  if (ownershipErr) {
    return { error: ownershipErr };
  }
  const completedAt = (/* @__PURE__ */ new Date()).toISOString();
  let guardError = null;
  let summaryMd = "";
  let validatedEscalationArtifact = null;
  let escalationWriteEnabled = false;
  if (params.escalation) {
    escalationWriteEnabled = loadEffectiveGSDPreferences()?.preferences?.phases?.mid_execution_escalation === true;
    if (escalationWriteEnabled) {
      try {
        validatedEscalationArtifact = buildEscalationArtifact({
          taskId: params.taskId,
          sliceId: params.sliceId,
          milestoneId: params.milestoneId,
          question: params.escalation.question,
          options: params.escalation.options,
          recommendation: params.escalation.recommendation,
          recommendationRationale: params.escalation.recommendationRationale,
          continueWithDefault: params.escalation.continueWithDefault
        });
      } catch (validationErr) {
        return {
          error: `complete-task escalation payload invalid for ${params.milestoneId}/${params.sliceId}/${params.taskId}: ${validationErr.message}`
        };
      }
    }
  }
  transaction(() => {
    const milestone = getMilestone(params.milestoneId);
    if (milestone && isClosedStatus(milestone.status)) {
      guardError = `cannot complete task in a closed milestone: ${params.milestoneId} (status: ${milestone.status})`;
      return;
    }
    const slice = getSlice(params.milestoneId, params.sliceId);
    if (slice && isClosedStatus(slice.status)) {
      guardError = `cannot complete task in a closed slice: ${params.sliceId} (status: ${slice.status})`;
      return;
    }
    const existingTask = getTask(params.milestoneId, params.sliceId, params.taskId);
    if (existingTask && isClosedStatus(existingTask.status)) {
      if (isStaleWrite("complete-task")) {
        guardError = "__stale_duplicate__";
        return;
      }
      guardError = `task ${params.taskId} is already complete \u2014 use gsd_task_reopen first if you need to redo it`;
      return;
    }
    const taskRow = paramsToTaskRow(params, completedAt);
    summaryMd = renderSummaryContent(taskRow, params.sliceId, params.milestoneId, params.verificationEvidence ?? []);
    insertMilestone({ id: params.milestoneId, title: params.milestoneId });
    insertSlice({ id: params.sliceId, milestoneId: params.milestoneId, title: params.sliceId });
    insertTask({
      id: params.taskId,
      sliceId: params.sliceId,
      milestoneId: params.milestoneId,
      title: params.oneLiner,
      status: "complete",
      oneLiner: params.oneLiner,
      narrative: params.narrative,
      verificationResult: params.verification,
      duration: "",
      blockerDiscovered: params.blockerDiscovered ?? false,
      deviations: params.deviations ?? "None.",
      knownIssues: params.knownIssues ?? "None.",
      keyFiles: params.keyFiles ?? [],
      keyDecisions: params.keyDecisions ?? [],
      fullSummaryMd: summaryMd
    });
    for (const evidence of params.verificationEvidence ?? []) {
      insertVerificationEvidence({
        taskId: params.taskId,
        sliceId: params.sliceId,
        milestoneId: params.milestoneId,
        command: evidence.command,
        exitCode: evidence.exitCode,
        verdict: evidence.verdict,
        durationMs: evidence.durationMs
      });
    }
  });
  if (guardError === "__stale_duplicate__") {
    const tasksDir2 = resolveTasksDir(basePath, params.milestoneId, params.sliceId);
    const staleSummaryPath = tasksDir2 ? join(tasksDir2, `${params.taskId}-SUMMARY.md`) : join(
      basePath,
      ".gsd",
      "milestones",
      params.milestoneId,
      "slices",
      params.sliceId,
      "tasks",
      `${params.taskId}-SUMMARY.md`
    );
    return {
      taskId: params.taskId,
      sliceId: params.sliceId,
      milestoneId: params.milestoneId,
      summaryPath: staleSummaryPath,
      duplicate: true,
      stale: true
    };
  }
  if (guardError) {
    return { error: guardError };
  }
  let projectionStale = false;
  let summaryPath;
  const tasksDir = resolveTasksDir(basePath, params.milestoneId, params.sliceId);
  if (tasksDir) {
    summaryPath = join(tasksDir, `${params.taskId}-SUMMARY.md`);
  } else {
    const gsdDir = join(basePath, ".gsd");
    const manualTasksDir = join(gsdDir, "milestones", params.milestoneId, "slices", params.sliceId, "tasks");
    mkdirSync(manualTasksDir, { recursive: true });
    summaryPath = join(manualTasksDir, `${params.taskId}-SUMMARY.md`);
  }
  try {
    await saveFile(summaryPath, summaryMd);
    await renderPlanCheckboxes(basePath, params.milestoneId, params.sliceId);
  } catch (renderErr) {
    projectionStale = true;
    logWarning("projection", `complete_task projection write failed for ${params.milestoneId}/${params.sliceId}/${params.taskId}; DB completion remains committed`, {
      error: renderErr.message
    });
  }
  try {
    const pendingGates = getPendingGatesForTurn(
      params.milestoneId,
      params.sliceId,
      "execute-task",
      params.taskId
    );
    if (pendingGates.length > 0) {
      const ownedDefs = new Map(getGatesForTurn("execute-task").map((g) => [g.id, g]));
      for (const row of pendingGates) {
        const def = ownedDefs.get(row.gate_id);
        if (!def) continue;
        const field = taskGateFieldForId(def.id, params);
        const hasContent = typeof field === "string" && field.trim().length > 0;
        saveGateResult({
          milestoneId: params.milestoneId,
          sliceId: params.sliceId,
          taskId: params.taskId,
          gateId: def.id,
          verdict: hasContent ? "pass" : "omitted",
          rationale: hasContent ? `${def.promptSection} section populated in task summary` : `${def.promptSection} section left empty \u2014 recorded as omitted`,
          findings: hasContent ? field.trim() : ""
        });
      }
    }
  } catch (gateErr) {
    logWarning(
      "tool",
      `complete-task gate close warning for ${params.milestoneId}/${params.sliceId}/${params.taskId}: ${gateErr.message}`
    );
  }
  if (validatedEscalationArtifact) {
    try {
      writeEscalationArtifact(basePath, validatedEscalationArtifact);
    } catch (escalationErr) {
      const msg = `complete-task escalation write failed for ${params.milestoneId}/${params.sliceId}/${params.taskId}: ${escalationErr.message}`;
      logWarning("tool", msg);
      if (validatedEscalationArtifact.continueWithDefault === false) {
        try {
          deleteVerificationEvidence(params.milestoneId, params.sliceId, params.taskId);
          updateTaskStatus(params.milestoneId, params.sliceId, params.taskId, "pending");
          invalidateStateCache();
          logWarning(
            "tool",
            `complete-task rolled back DB completion for ${params.milestoneId}/${params.sliceId}/${params.taskId} after escalation write failure; SUMMARY.md left on disk for retry.`
          );
        } catch (rollbackErr) {
          logWarning(
            "tool",
            `complete-task rollback failed after escalation write failure for ${params.milestoneId}/${params.sliceId}/${params.taskId}: ${rollbackErr.message}`
          );
        }
        return { error: msg };
      }
    }
  } else if (params.escalation && !escalationWriteEnabled) {
    logWarning(
      "tool",
      `complete-task received escalation payload but phases.mid_execution_escalation is not enabled; ignoring (${params.milestoneId}/${params.sliceId}/${params.taskId})`
    );
  }
  invalidateStateCache();
  clearPathCache();
  clearParseCache();
  try {
    await renderAllProjections(basePath, params.milestoneId);
  } catch (projErr) {
    logWarning("tool", `complete-task projection warning: ${projErr.message}`);
  }
  try {
    writeManifest(basePath);
  } catch (mfErr) {
    logWarning("tool", `complete-task manifest warning: ${mfErr.message}`);
  }
  try {
    appendEvent(basePath, {
      cmd: "complete-task",
      params: { milestoneId: params.milestoneId, sliceId: params.sliceId, taskId: params.taskId },
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      actor: "agent",
      actor_name: params.actorName,
      trigger_reason: params.triggerReason
    });
  } catch (eventErr) {
    logError("tool", `complete-task event log FAILED \u2014 completion invisible to reconciliation`, { error: eventErr.message });
  }
  return {
    taskId: params.taskId,
    sliceId: params.sliceId,
    milestoneId: params.milestoneId,
    summaryPath,
    ...projectionStale ? { stale: true } : {}
  };
}
export {
  handleCompleteTask,
  normalizeListParam
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90b29scy9jb21wbGV0ZS10YXNrLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBQcm9qZWN0L0FwcDogR1NELTJcbi8vIEZpbGUgUHVycG9zZTogQ29tcGxldGUtdGFzayB0b29sIGhhbmRsZXIgZm9yIEdTRCB3b3JrZmxvdyBzdGF0ZSBhbmQgc3VtbWFyaWVzLlxuXG4vKipcbiAqIGNvbXBsZXRlLXRhc2sgaGFuZGxlciBcdTIwMTQgdGhlIGNvcmUgb3BlcmF0aW9uIGJlaGluZCBnc2RfY29tcGxldGVfdGFzay5cbiAqXG4gKiBWYWxpZGF0ZXMgaW5wdXRzLCB3cml0ZXMgdGFzayByb3cgYW5kIHJlbmRlcmVkIFNVTU1BUlkubWQgdG8gREIgaW4gYVxuICogdHJhbnNhY3Rpb24sIHRoZW4gcmVuZGVycyBwcm9qZWN0aW9ucyB0byBkaXNrIGFuZCBpbnZhbGlkYXRlcyBjYWNoZXMuXG4gKiBQcm9qZWN0aW9uIHdyaXRlIGZhaWx1cmVzIGFyZSByZXBvcnRlZCBhcyBzdGFsZSBwcm9qZWN0aW9ucyBhbmQgZG8gbm90IHJvbGxcbiAqIGJhY2sgY29tbWl0dGVkIERCIHN0YXRlLlxuICovXG5cbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBta2RpclN5bmMsIGV4aXN0c1N5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuXG5pbXBvcnQgdHlwZSB7IENvbXBsZXRlVGFza1BhcmFtcyB9IGZyb20gXCIuLi90eXBlcy5qc1wiO1xuaW1wb3J0IHsgaXNDbG9zZWRTdGF0dXMgfSBmcm9tIFwiLi4vc3RhdHVzLWd1YXJkcy5qc1wiO1xuaW1wb3J0IHtcbiAgdHJhbnNhY3Rpb24sXG4gIGluc2VydE1pbGVzdG9uZSxcbiAgaW5zZXJ0U2xpY2UsXG4gIGluc2VydFRhc2ssXG4gIGluc2VydFZlcmlmaWNhdGlvbkV2aWRlbmNlLFxuICBnZXRNaWxlc3RvbmUsXG4gIGdldFNsaWNlLFxuICBnZXRUYXNrLFxuICB1cGRhdGVUYXNrU3RhdHVzLFxuICBkZWxldGVWZXJpZmljYXRpb25FdmlkZW5jZSxcbiAgc2F2ZUdhdGVSZXN1bHQsXG4gIGdldFBlbmRpbmdHYXRlc0ZvclR1cm4sXG59IGZyb20gXCIuLi9nc2QtZGIuanNcIjtcbmltcG9ydCB7IGdldEdhdGVzRm9yVHVybiB9IGZyb20gXCIuLi9nYXRlLXJlZ2lzdHJ5LmpzXCI7XG5pbXBvcnQgeyByZXNvbHZlVGFza3NEaXIsIGNsZWFyUGF0aENhY2hlIH0gZnJvbSBcIi4uL3BhdGhzLmpzXCI7XG5pbXBvcnQgeyBjaGVja093bmVyc2hpcCwgdGFza1VuaXRLZXkgfSBmcm9tIFwiLi4vdW5pdC1vd25lcnNoaXAuanNcIjtcbmltcG9ydCB7IHNhdmVGaWxlLCBjbGVhclBhcnNlQ2FjaGUgfSBmcm9tIFwiLi4vZmlsZXMuanNcIjtcbmltcG9ydCB7IGludmFsaWRhdGVTdGF0ZUNhY2hlIH0gZnJvbSBcIi4uL3N0YXRlLmpzXCI7XG5pbXBvcnQgeyByZW5kZXJQbGFuQ2hlY2tib3hlcyB9IGZyb20gXCIuLi9tYXJrZG93bi1yZW5kZXJlci5qc1wiO1xuaW1wb3J0IHsgcmVuZGVyQWxsUHJvamVjdGlvbnMsIHJlbmRlclN1bW1hcnlDb250ZW50IH0gZnJvbSBcIi4uL3dvcmtmbG93LXByb2plY3Rpb25zLmpzXCI7XG5pbXBvcnQgeyB3cml0ZU1hbmlmZXN0IH0gZnJvbSBcIi4uL3dvcmtmbG93LW1hbmlmZXN0LmpzXCI7XG5pbXBvcnQgeyBhcHBlbmRFdmVudCB9IGZyb20gXCIuLi93b3JrZmxvdy1ldmVudHMuanNcIjtcbmltcG9ydCB7IGxvZ1dhcm5pbmcsIGxvZ0Vycm9yIH0gZnJvbSBcIi4uL3dvcmtmbG93LWxvZ2dlci5qc1wiO1xuaW1wb3J0IHsgbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzIH0gZnJvbSBcIi4uL3ByZWZlcmVuY2VzLmpzXCI7XG5pbXBvcnQgeyBpc1N0YWxlV3JpdGUgfSBmcm9tIFwiLi4vYXV0by90dXJuLWVwb2NoLmpzXCI7XG5pbXBvcnQgeyBidWlsZEVzY2FsYXRpb25BcnRpZmFjdCwgd3JpdGVFc2NhbGF0aW9uQXJ0aWZhY3QgfSBmcm9tIFwiLi4vZXNjYWxhdGlvbi5qc1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIENvbXBsZXRlVGFza1Jlc3VsdCB7XG4gIHRhc2tJZDogc3RyaW5nO1xuICBzbGljZUlkOiBzdHJpbmc7XG4gIG1pbGVzdG9uZUlkOiBzdHJpbmc7XG4gIHN1bW1hcnlQYXRoOiBzdHJpbmc7XG4gIC8qKlxuICAgKiBUcnVlIHdoZW4gdGhpcyBjYWxsIHJlLWNvbXBsZXRlZCBhbiBhbHJlYWR5LWNsb3NlZCB0YXNrIGZyb20gYSB0dXJuIHRoYXRcbiAgICogaGFkIGJlZW4gc3VwZXJzZWRlZCBieSB0aW1lb3V0IHJlY292ZXJ5IG9yIGNhbmNlbGxhdGlvbi4gVGhlIHVuZGVybHlpbmdcbiAgICogc3RhdGUgd2FzIG5vdCBtdXRhdGVkOyB0aGUgcmVzcG9uc2UgaXMgYSBuby1vcCBzaGFwZWQgbGlrZSBhIHN1Y2Nlc3Mgc29cbiAgICogdGhlIG9ycGhhbmVkIExMTSB0b29sIGNhbGwgcmVzb2x2ZXMgY2xlYW5seS5cbiAgICovXG4gIGR1cGxpY2F0ZT86IGJvb2xlYW47XG4gIHN0YWxlPzogYm9vbGVhbjtcbn1cblxuaW1wb3J0IHR5cGUgeyBUYXNrUm93IH0gZnJvbSBcIi4uL2RiLXRhc2stc2xpY2Utcm93cy5qc1wiO1xuXG4vKipcbiAqIE1hcCBhbiBleGVjdXRlLXRhc2stb3duZWQgZ2F0ZSBpZCB0byB0aGUgQ29tcGxldGVUYXNrUGFyYW1zIGZpZWxkIHdob3NlXG4gKiBwcmVzZW5jZSBkcml2ZXMgYHBhc3NgIHZzLiBgb21pdHRlZGAuIEtlZXAgaW4gbG9ja3N0ZXAgd2l0aCB0aGUgZ2F0ZXNcbiAqIGRlY2xhcmVkIGluIGdhdGUtcmVnaXN0cnkudHMgdW5kZXIgb3duZXJUdXJuIFwiZXhlY3V0ZS10YXNrXCIuXG4gKi9cbmZ1bmN0aW9uIHRhc2tHYXRlRmllbGRGb3JJZChcbiAgaWQ6IHN0cmluZyxcbiAgcGFyYW1zOiBDb21wbGV0ZVRhc2tQYXJhbXMsXG4pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBzd2l0Y2ggKGlkKSB7XG4gICAgY2FzZSBcIlE1XCI6XG4gICAgICByZXR1cm4gcGFyYW1zLmZhaWx1cmVNb2RlcztcbiAgICBjYXNlIFwiUTZcIjpcbiAgICAgIHJldHVybiBwYXJhbXMubG9hZFByb2ZpbGU7XG4gICAgY2FzZSBcIlE3XCI6XG4gICAgICByZXR1cm4gcGFyYW1zLm5lZ2F0aXZlVGVzdHM7XG4gICAgZGVmYXVsdDpcbiAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbn1cblxuLyoqXG4gKiBOb3JtYWxpemUgYSBsaXN0IHBhcmFtZXRlciB0aGF0IG1heSBhcnJpdmUgYXMgYSBzdHJpbmcgKG5ld2xpbmUtZGVsaW1pdGVkXG4gKiBidWxsZXQgbGlzdCBmcm9tIHRoZSBMTE0pIGludG8gYSBzdHJpbmcgYXJyYXkgKCMzMzYxKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZUxpc3RQYXJhbSh2YWx1ZTogdW5rbm93bik6IHN0cmluZ1tdIHtcbiAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSByZXR1cm4gdmFsdWUubWFwKFN0cmluZyk7XG4gIGlmICh0eXBlb2YgdmFsdWUgPT09IFwic3RyaW5nXCIgJiYgdmFsdWUudHJpbSgpKSB7XG4gICAgcmV0dXJuIHZhbHVlLnNwbGl0KC9cXG4vKS5tYXAocyA9PiBzLnJlcGxhY2UoL15bXFxzXFwtKlx1MjAyMl0rLywgXCJcIikudHJpbSgpKS5maWx0ZXIoQm9vbGVhbik7XG4gIH1cbiAgcmV0dXJuIFtdO1xufVxuXG4vKipcbiAqIEJ1aWxkIGEgVGFza1Jvdy1zaGFwZWQgb2JqZWN0IGZyb20gQ29tcGxldGVUYXNrUGFyYW1zIHNvIHRoZSB1bmlmaWVkXG4gKiByZW5kZXJTdW1tYXJ5Q29udGVudCgpIGNhbiBiZSB1c2VkIGF0IGNvbXBsZXRpb24gdGltZSAoIzI3MjApLlxuICovXG5mdW5jdGlvbiBwYXJhbXNUb1Rhc2tSb3cocGFyYW1zOiBDb21wbGV0ZVRhc2tQYXJhbXMsIGNvbXBsZXRlZEF0OiBzdHJpbmcpOiBUYXNrUm93IHtcbiAgcmV0dXJuIHtcbiAgICBtaWxlc3RvbmVfaWQ6IHBhcmFtcy5taWxlc3RvbmVJZCxcbiAgICBzbGljZV9pZDogcGFyYW1zLnNsaWNlSWQsXG4gICAgaWQ6IHBhcmFtcy50YXNrSWQsXG4gICAgdGl0bGU6IHBhcmFtcy5vbmVMaW5lciB8fCBwYXJhbXMudGFza0lkLFxuICAgIHN0YXR1czogXCJjb21wbGV0ZVwiLFxuICAgIG9uZV9saW5lcjogcGFyYW1zLm9uZUxpbmVyLFxuICAgIG5hcnJhdGl2ZTogcGFyYW1zLm5hcnJhdGl2ZSxcbiAgICB2ZXJpZmljYXRpb25fcmVzdWx0OiBwYXJhbXMudmVyaWZpY2F0aW9uLFxuICAgIGR1cmF0aW9uOiBcIlwiLFxuICAgIGNvbXBsZXRlZF9hdDogY29tcGxldGVkQXQsXG4gICAgYmxvY2tlcl9kaXNjb3ZlcmVkOiBwYXJhbXMuYmxvY2tlckRpc2NvdmVyZWQgPz8gZmFsc2UsXG4gICAgZGV2aWF0aW9uczogcGFyYW1zLmRldmlhdGlvbnMgPz8gXCJcIixcbiAgICBrbm93bl9pc3N1ZXM6IHBhcmFtcy5rbm93bklzc3VlcyA/PyBcIlwiLFxuICAgIGtleV9maWxlczogbm9ybWFsaXplTGlzdFBhcmFtKHBhcmFtcy5rZXlGaWxlcyksXG4gICAga2V5X2RlY2lzaW9uczogbm9ybWFsaXplTGlzdFBhcmFtKHBhcmFtcy5rZXlEZWNpc2lvbnMpLFxuICAgIGZ1bGxfc3VtbWFyeV9tZDogXCJcIixcbiAgICBkZXNjcmlwdGlvbjogXCJcIixcbiAgICBlc3RpbWF0ZTogXCJcIixcbiAgICBmaWxlczogW10sXG4gICAgdmVyaWZ5OiBcIlwiLFxuICAgIGlucHV0czogW10sXG4gICAgZXhwZWN0ZWRfb3V0cHV0OiBbXSxcbiAgICBvYnNlcnZhYmlsaXR5X2ltcGFjdDogXCJcIixcbiAgICBmdWxsX3BsYW5fbWQ6IFwiXCIsXG4gICAgc2VxdWVuY2U6IDAsXG4gICAgYmxvY2tlcl9zb3VyY2U6IFwiXCIsXG4gICAgZXNjYWxhdGlvbl9wZW5kaW5nOiAwLFxuICAgIGVzY2FsYXRpb25fYXdhaXRpbmdfcmV2aWV3OiAwLFxuICAgIGVzY2FsYXRpb25fYXJ0aWZhY3RfcGF0aDogbnVsbCxcbiAgICBlc2NhbGF0aW9uX292ZXJyaWRlX2FwcGxpZWRfYXQ6IG51bGwsXG4gIH07XG59XG5cbi8qKlxuICogSGFuZGxlIHRoZSBjb21wbGV0ZV90YXNrIG9wZXJhdGlvbiBlbmQtdG8tZW5kLlxuICpcbiAqIDEuIFZhbGlkYXRlIHJlcXVpcmVkIGZpZWxkc1xuICogMi4gV3JpdGUgREIgaW4gYSB0cmFuc2FjdGlvbiAobWlsZXN0b25lLCBzbGljZSwgdGFzaywgdmVyaWZpY2F0aW9uIGV2aWRlbmNlKVxuICogMy4gUmVuZGVyIFNVTU1BUlkubWQgdG8gZGlza1xuICogNC4gVG9nZ2xlIHBsYW4gY2hlY2tib3hcbiAqIDUuIFN0b3JlIHJlbmRlcmVkIG1hcmtkb3duIGJhY2sgaW4gREIgKGZvciBEMDA0IHJlY292ZXJ5KVxuICogNi4gSW52YWxpZGF0ZSBjYWNoZXNcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZUNvbXBsZXRlVGFzayhcbiAgcGFyYW1zOiBDb21wbGV0ZVRhc2tQYXJhbXMsXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4pOiBQcm9taXNlPENvbXBsZXRlVGFza1Jlc3VsdCB8IHsgZXJyb3I6IHN0cmluZyB9PiB7XG4gIC8vIFx1MjUwMFx1MjUwMCBWYWxpZGF0ZSByZXF1aXJlZCBmaWVsZHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGlmICghcGFyYW1zLnRhc2tJZCB8fCB0eXBlb2YgcGFyYW1zLnRhc2tJZCAhPT0gXCJzdHJpbmdcIiB8fCBwYXJhbXMudGFza0lkLnRyaW0oKSA9PT0gXCJcIikge1xuICAgIHJldHVybiB7IGVycm9yOiBcInRhc2tJZCBpcyByZXF1aXJlZCBhbmQgbXVzdCBiZSBhIG5vbi1lbXB0eSBzdHJpbmdcIiB9O1xuICB9XG4gIGlmICghcGFyYW1zLnNsaWNlSWQgfHwgdHlwZW9mIHBhcmFtcy5zbGljZUlkICE9PSBcInN0cmluZ1wiIHx8IHBhcmFtcy5zbGljZUlkLnRyaW0oKSA9PT0gXCJcIikge1xuICAgIHJldHVybiB7IGVycm9yOiBcInNsaWNlSWQgaXMgcmVxdWlyZWQgYW5kIG11c3QgYmUgYSBub24tZW1wdHkgc3RyaW5nXCIgfTtcbiAgfVxuICBpZiAoIXBhcmFtcy5taWxlc3RvbmVJZCB8fCB0eXBlb2YgcGFyYW1zLm1pbGVzdG9uZUlkICE9PSBcInN0cmluZ1wiIHx8IHBhcmFtcy5taWxlc3RvbmVJZC50cmltKCkgPT09IFwiXCIpIHtcbiAgICByZXR1cm4geyBlcnJvcjogXCJtaWxlc3RvbmVJZCBpcyByZXF1aXJlZCBhbmQgbXVzdCBiZSBhIG5vbi1lbXB0eSBzdHJpbmdcIiB9O1xuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIE93bmVyc2hpcCBjaGVjayAob3B0LWluOiBvbmx5IGVuZm9yY2VkIHdoZW4gY2xhaW0gZmlsZSBleGlzdHMpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBjb25zdCBvd25lcnNoaXBFcnIgPSBjaGVja093bmVyc2hpcChcbiAgICBiYXNlUGF0aCxcbiAgICB0YXNrVW5pdEtleShwYXJhbXMubWlsZXN0b25lSWQsIHBhcmFtcy5zbGljZUlkLCBwYXJhbXMudGFza0lkKSxcbiAgICBwYXJhbXMuYWN0b3JOYW1lLFxuICApO1xuICBpZiAob3duZXJzaGlwRXJyKSB7XG4gICAgcmV0dXJuIHsgZXJyb3I6IG93bmVyc2hpcEVyciB9O1xuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIEd1YXJkcyArIERCIHdyaXRlcyBpbnNpZGUgYSBzaW5nbGUgdHJhbnNhY3Rpb24gKHByZXZlbnRzIFRPQ1RPVSkgXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGNvbnN0IGNvbXBsZXRlZEF0ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuICBsZXQgZ3VhcmRFcnJvcjogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIGxldCBzdW1tYXJ5TWQgPSBcIlwiO1xuXG4gIC8vIFx1MjUwMFx1MjUwMCBBRFItMDExIFBoYXNlIDI6IHZhbGlkYXRlIGVzY2FsYXRpb24gcGF5bG9hZCBCRUZPUkUgYW55IHNpZGUgZWZmZWN0cyBcdTI1MDBcbiAgLy8gQnVpbGRpbmcgdGhlIGFydGlmYWN0IHJ1bnMgdGhlIGZ1bGwgc2hhcGUgdmFsaWRhdGlvbiAoMi00IG9wdGlvbnMsIHVuaXF1ZVxuICAvLyBpZHMsIHJlY29tbWVuZGF0aW9uIHJlZmVyZW5jZXMgYSByZWFsIGlkKS4gSWYgdGhlIHBheWxvYWQgaXMgbWFsZm9ybWVkXG4gIC8vIHdlIG11c3QgcmVqZWN0IHRoZSBjYWxsIGJlZm9yZSBtYXJraW5nIHRoZSB0YXNrIGNvbXBsZXRlLCB3cml0aW5nXG4gIC8vIFNVTU1BUlkubWQsIGZsaXBwaW5nIHRoZSBwbGFuIGNoZWNrYm94LCBvciBjbG9zaW5nIGV4ZWN1dGUtdGFzayBnYXRlcyBcdTIwMTRcbiAgLy8gb3RoZXJ3aXNlIGEgcmVqZWN0ZWQgcGF5bG9hZCB3b3VsZCBsZWF2ZSB0aGUgdGFzayBtYXJrZWQgY29tcGxldGUgd2l0aFxuICAvLyBubyBlc2NhbGF0aW9uIHJlY29yZGVkLCBhbmQgdGhlIGxvb3Agd291bGQgc2lsZW50bHkgYWR2YW5jZSBwYXN0IGl0LlxuICAvLyBUaGUgZmlsZXN5c3RlbSB3cml0ZSBoYXBwZW5zIGxhdGVyIChhZnRlciBzaWRlIGVmZmVjdHMpIGJlY2F1c2UgdGhhdCdzXG4gIC8vIHRoZSBjaGVhcGVzdCBvcmRlcmluZyBhbmQgdmFsaWRhdGlvbiBpcyB3aGVyZSA5OSUgb2YgZmFpbHVyZXMgbGl2ZS5cbiAgbGV0IHZhbGlkYXRlZEVzY2FsYXRpb25BcnRpZmFjdDogUmV0dXJuVHlwZTx0eXBlb2YgYnVpbGRFc2NhbGF0aW9uQXJ0aWZhY3Q+IHwgbnVsbCA9IG51bGw7XG4gIGxldCBlc2NhbGF0aW9uV3JpdGVFbmFibGVkID0gZmFsc2U7XG4gIGlmIChwYXJhbXMuZXNjYWxhdGlvbikge1xuICAgIGVzY2FsYXRpb25Xcml0ZUVuYWJsZWQgPSBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMoKT8ucHJlZmVyZW5jZXM/LnBoYXNlcz8ubWlkX2V4ZWN1dGlvbl9lc2NhbGF0aW9uID09PSB0cnVlO1xuICAgIGlmIChlc2NhbGF0aW9uV3JpdGVFbmFibGVkKSB7XG4gICAgICB0cnkge1xuICAgICAgICB2YWxpZGF0ZWRFc2NhbGF0aW9uQXJ0aWZhY3QgPSBidWlsZEVzY2FsYXRpb25BcnRpZmFjdCh7XG4gICAgICAgICAgdGFza0lkOiBwYXJhbXMudGFza0lkLFxuICAgICAgICAgIHNsaWNlSWQ6IHBhcmFtcy5zbGljZUlkLFxuICAgICAgICAgIG1pbGVzdG9uZUlkOiBwYXJhbXMubWlsZXN0b25lSWQsXG4gICAgICAgICAgcXVlc3Rpb246IHBhcmFtcy5lc2NhbGF0aW9uLnF1ZXN0aW9uLFxuICAgICAgICAgIG9wdGlvbnM6IHBhcmFtcy5lc2NhbGF0aW9uLm9wdGlvbnMsXG4gICAgICAgICAgcmVjb21tZW5kYXRpb246IHBhcmFtcy5lc2NhbGF0aW9uLnJlY29tbWVuZGF0aW9uLFxuICAgICAgICAgIHJlY29tbWVuZGF0aW9uUmF0aW9uYWxlOiBwYXJhbXMuZXNjYWxhdGlvbi5yZWNvbW1lbmRhdGlvblJhdGlvbmFsZSxcbiAgICAgICAgICBjb250aW51ZVdpdGhEZWZhdWx0OiBwYXJhbXMuZXNjYWxhdGlvbi5jb250aW51ZVdpdGhEZWZhdWx0LFxuICAgICAgICB9KTtcbiAgICAgIH0gY2F0Y2ggKHZhbGlkYXRpb25FcnIpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBlcnJvcjogYGNvbXBsZXRlLXRhc2sgZXNjYWxhdGlvbiBwYXlsb2FkIGludmFsaWQgZm9yICR7cGFyYW1zLm1pbGVzdG9uZUlkfS8ke3BhcmFtcy5zbGljZUlkfS8ke3BhcmFtcy50YXNrSWR9OiAkeyh2YWxpZGF0aW9uRXJyIGFzIEVycm9yKS5tZXNzYWdlfWAsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgdHJhbnNhY3Rpb24oKCkgPT4ge1xuICAgIC8vIFN0YXRlIG1hY2hpbmUgcHJlY29uZGl0aW9ucyAoaW5zaWRlIHR4biBmb3IgYXRvbWljaXR5KS5cbiAgICAvLyBNaWxlc3RvbmUvc2xpY2Ugbm90IGV4aXN0aW5nIGlzIE9LIFx1MjAxNCBpbnNlcnRNaWxlc3RvbmUvaW5zZXJ0U2xpY2UgYmVsb3cgd2lsbCBhdXRvLWNyZWF0ZS5cbiAgICAvLyBPbmx5IGJsb2NrIGlmIHRoZXkgZXhpc3QgYW5kIGFyZSBjbG9zZWQuXG4gICAgY29uc3QgbWlsZXN0b25lID0gZ2V0TWlsZXN0b25lKHBhcmFtcy5taWxlc3RvbmVJZCk7XG4gICAgaWYgKG1pbGVzdG9uZSAmJiBpc0Nsb3NlZFN0YXR1cyhtaWxlc3RvbmUuc3RhdHVzKSkge1xuICAgICAgZ3VhcmRFcnJvciA9IGBjYW5ub3QgY29tcGxldGUgdGFzayBpbiBhIGNsb3NlZCBtaWxlc3RvbmU6ICR7cGFyYW1zLm1pbGVzdG9uZUlkfSAoc3RhdHVzOiAke21pbGVzdG9uZS5zdGF0dXN9KWA7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3Qgc2xpY2UgPSBnZXRTbGljZShwYXJhbXMubWlsZXN0b25lSWQsIHBhcmFtcy5zbGljZUlkKTtcbiAgICBpZiAoc2xpY2UgJiYgaXNDbG9zZWRTdGF0dXMoc2xpY2Uuc3RhdHVzKSkge1xuICAgICAgZ3VhcmRFcnJvciA9IGBjYW5ub3QgY29tcGxldGUgdGFzayBpbiBhIGNsb3NlZCBzbGljZTogJHtwYXJhbXMuc2xpY2VJZH0gKHN0YXR1czogJHtzbGljZS5zdGF0dXN9KWA7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgZXhpc3RpbmdUYXNrID0gZ2V0VGFzayhwYXJhbXMubWlsZXN0b25lSWQsIHBhcmFtcy5zbGljZUlkLCBwYXJhbXMudGFza0lkKTtcbiAgICBpZiAoZXhpc3RpbmdUYXNrICYmIGlzQ2xvc2VkU3RhdHVzKGV4aXN0aW5nVGFzay5zdGF0dXMpKSB7XG4gICAgICAvLyBTdGFsZS10dXJuIHBhdGg6IGEgdGltZWQtb3V0IHR1cm4gdGhhdCB3YXMgc3VwZXJzZWRlZCBieSByZWNvdmVyeVxuICAgICAgLy8gY2FuIHN0aWxsIHJlYWNoIHRoaXMgY29kZSB3aGVuIGl0cyBMTE0gY2FsbCBldmVudHVhbGx5IHJldHVybnMgYW5kXG4gICAgICAvLyBpbnZva2VzIGdzZF9jb21wbGV0ZV90YXNrLiBSZXR1cm5pbmcgYW4gZXJyb3Igd291bGQgcHJvZHVjZSBub2lzeVxuICAgICAgLy8gXCJhbHJlYWR5IGNvbXBsZXRlIFx1MjAxNCB1c2UgcmVvcGVuIGZpcnN0XCIgbG9ncyBpbiB0aGUgb3JwaGFuZWQgdHVybi5cbiAgICAgIC8vIEluc3RlYWQsIHNpZ25hbCB0aGUgZHVwbGljYXRlIHZpYSBhIG5vbi1tdXRhdGluZyBzdWNjZXNzIHNoYXBlIHRoYXRcbiAgICAgIC8vIGNhbGxlcnMgY2FuIGRldGVjdCB2aWEgYGR1cGxpY2F0ZTogdHJ1ZWAgLyBgc3RhbGU6IHRydWVgLlxuICAgICAgaWYgKGlzU3RhbGVXcml0ZShcImNvbXBsZXRlLXRhc2tcIikpIHtcbiAgICAgICAgLy8gU2VudGluZWwgaGFuZGxlZCBiZWxvdyBcdTIwMTQgb3V0c2lkZSB0aGUgdHJhbnNhY3Rpb24gXHUyMDE0IHNvIHdlIGRvbid0XG4gICAgICAgIC8vIHJlbmRlciBTVU1NQVJZLm1kIG9yIGZsaXAgcGxhbiBjaGVja2JveGVzIGZvciBhIHN0YWxlIGR1cGxpY2F0ZS5cbiAgICAgICAgZ3VhcmRFcnJvciA9IFwiX19zdGFsZV9kdXBsaWNhdGVfX1wiO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBndWFyZEVycm9yID0gYHRhc2sgJHtwYXJhbXMudGFza0lkfSBpcyBhbHJlYWR5IGNvbXBsZXRlIFx1MjAxNCB1c2UgZ3NkX3Rhc2tfcmVvcGVuIGZpcnN0IGlmIHlvdSBuZWVkIHRvIHJlZG8gaXRgO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIEFsbCBndWFyZHMgcGFzc2VkIFx1MjAxNCBwZXJmb3JtIHdyaXRlc1xuICAgIGNvbnN0IHRhc2tSb3cgPSBwYXJhbXNUb1Rhc2tSb3cocGFyYW1zLCBjb21wbGV0ZWRBdCk7XG4gICAgc3VtbWFyeU1kID0gcmVuZGVyU3VtbWFyeUNvbnRlbnQodGFza1JvdywgcGFyYW1zLnNsaWNlSWQsIHBhcmFtcy5taWxlc3RvbmVJZCwgcGFyYW1zLnZlcmlmaWNhdGlvbkV2aWRlbmNlID8/IFtdKTtcblxuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBwYXJhbXMubWlsZXN0b25lSWQsIHRpdGxlOiBwYXJhbXMubWlsZXN0b25lSWQgfSk7XG4gICAgaW5zZXJ0U2xpY2UoeyBpZDogcGFyYW1zLnNsaWNlSWQsIG1pbGVzdG9uZUlkOiBwYXJhbXMubWlsZXN0b25lSWQsIHRpdGxlOiBwYXJhbXMuc2xpY2VJZCB9KTtcbiAgICBpbnNlcnRUYXNrKHtcbiAgICAgIGlkOiBwYXJhbXMudGFza0lkLFxuICAgICAgc2xpY2VJZDogcGFyYW1zLnNsaWNlSWQsXG4gICAgICBtaWxlc3RvbmVJZDogcGFyYW1zLm1pbGVzdG9uZUlkLFxuICAgICAgdGl0bGU6IHBhcmFtcy5vbmVMaW5lcixcbiAgICAgIHN0YXR1czogXCJjb21wbGV0ZVwiLFxuICAgICAgb25lTGluZXI6IHBhcmFtcy5vbmVMaW5lcixcbiAgICAgIG5hcnJhdGl2ZTogcGFyYW1zLm5hcnJhdGl2ZSxcbiAgICAgIHZlcmlmaWNhdGlvblJlc3VsdDogcGFyYW1zLnZlcmlmaWNhdGlvbixcbiAgICAgIGR1cmF0aW9uOiBcIlwiLFxuICAgICAgYmxvY2tlckRpc2NvdmVyZWQ6IHBhcmFtcy5ibG9ja2VyRGlzY292ZXJlZCA/PyBmYWxzZSxcbiAgICAgIGRldmlhdGlvbnM6IHBhcmFtcy5kZXZpYXRpb25zID8/IFwiTm9uZS5cIixcbiAgICAgIGtub3duSXNzdWVzOiBwYXJhbXMua25vd25Jc3N1ZXMgPz8gXCJOb25lLlwiLFxuICAgICAga2V5RmlsZXM6IHBhcmFtcy5rZXlGaWxlcyA/PyBbXSxcbiAgICAgIGtleURlY2lzaW9uczogcGFyYW1zLmtleURlY2lzaW9ucyA/PyBbXSxcbiAgICAgIGZ1bGxTdW1tYXJ5TWQ6IHN1bW1hcnlNZCxcbiAgICB9KTtcblxuICAgIGZvciAoY29uc3QgZXZpZGVuY2Ugb2YgKHBhcmFtcy52ZXJpZmljYXRpb25FdmlkZW5jZSA/PyBbXSkpIHtcbiAgICAgIGluc2VydFZlcmlmaWNhdGlvbkV2aWRlbmNlKHtcbiAgICAgICAgdGFza0lkOiBwYXJhbXMudGFza0lkLFxuICAgICAgICBzbGljZUlkOiBwYXJhbXMuc2xpY2VJZCxcbiAgICAgICAgbWlsZXN0b25lSWQ6IHBhcmFtcy5taWxlc3RvbmVJZCxcbiAgICAgICAgY29tbWFuZDogZXZpZGVuY2UuY29tbWFuZCxcbiAgICAgICAgZXhpdENvZGU6IGV2aWRlbmNlLmV4aXRDb2RlLFxuICAgICAgICB2ZXJkaWN0OiBldmlkZW5jZS52ZXJkaWN0LFxuICAgICAgICBkdXJhdGlvbk1zOiBldmlkZW5jZS5kdXJhdGlvbk1zLFxuICAgICAgfSk7XG4gICAgfVxuICB9KTtcblxuICBpZiAoZ3VhcmRFcnJvciA9PT0gXCJfX3N0YWxlX2R1cGxpY2F0ZV9fXCIpIHtcbiAgICAvLyBPcnBoYW5lZC10dXJuIGR1cGxpY2F0ZTogdGhlIHRhc2sgaXMgYWxyZWFkeSBjb21wbGV0ZSBmcm9tIHRoZVxuICAgIC8vIHN1cGVyc2VkZWQgdHVybidzIGVhcmxpZXIgKHJlYWwpIGNhbGwuIFJldHVybiBhIG5vbi1tdXRhdGluZyBzdWNjZXNzXG4gICAgLy8gc28gdGhlIHN0YWxlIExMTSB0b29sIGNhbGwgdW53aW5kcyBjbGVhbmx5LiBzdW1tYXJ5UGF0aCBpcyBzeW50aGVzaXplZFxuICAgIC8vIGZyb20gdGhlIGV4aXN0aW5nIG9uLWRpc2sgbGF5b3V0OyBubyBmaWxlIGlzIHdyaXR0ZW4uXG4gICAgY29uc3QgdGFza3NEaXIgPSByZXNvbHZlVGFza3NEaXIoYmFzZVBhdGgsIHBhcmFtcy5taWxlc3RvbmVJZCwgcGFyYW1zLnNsaWNlSWQpO1xuICAgIGNvbnN0IHN0YWxlU3VtbWFyeVBhdGggPSB0YXNrc0RpclxuICAgICAgPyBqb2luKHRhc2tzRGlyLCBgJHtwYXJhbXMudGFza0lkfS1TVU1NQVJZLm1kYClcbiAgICAgIDogam9pbihcbiAgICAgICAgICBiYXNlUGF0aCxcbiAgICAgICAgICBcIi5nc2RcIixcbiAgICAgICAgICBcIm1pbGVzdG9uZXNcIixcbiAgICAgICAgICBwYXJhbXMubWlsZXN0b25lSWQsXG4gICAgICAgICAgXCJzbGljZXNcIixcbiAgICAgICAgICBwYXJhbXMuc2xpY2VJZCxcbiAgICAgICAgICBcInRhc2tzXCIsXG4gICAgICAgICAgYCR7cGFyYW1zLnRhc2tJZH0tU1VNTUFSWS5tZGAsXG4gICAgICAgICk7XG4gICAgcmV0dXJuIHtcbiAgICAgIHRhc2tJZDogcGFyYW1zLnRhc2tJZCxcbiAgICAgIHNsaWNlSWQ6IHBhcmFtcy5zbGljZUlkLFxuICAgICAgbWlsZXN0b25lSWQ6IHBhcmFtcy5taWxlc3RvbmVJZCxcbiAgICAgIHN1bW1hcnlQYXRoOiBzdGFsZVN1bW1hcnlQYXRoLFxuICAgICAgZHVwbGljYXRlOiB0cnVlLFxuICAgICAgc3RhbGU6IHRydWUsXG4gICAgfTtcbiAgfVxuXG4gIGlmIChndWFyZEVycm9yKSB7XG4gICAgcmV0dXJuIHsgZXJyb3I6IGd1YXJkRXJyb3IgfTtcbiAgfVxuXG4gIGxldCBwcm9qZWN0aW9uU3RhbGUgPSBmYWxzZTtcblxuICAvLyBSZXNvbHZlIGFuZCB3cml0ZSBzdW1tYXJ5IHRvIGRpc2tcbiAgbGV0IHN1bW1hcnlQYXRoOiBzdHJpbmc7XG4gIGNvbnN0IHRhc2tzRGlyID0gcmVzb2x2ZVRhc2tzRGlyKGJhc2VQYXRoLCBwYXJhbXMubWlsZXN0b25lSWQsIHBhcmFtcy5zbGljZUlkKTtcbiAgaWYgKHRhc2tzRGlyKSB7XG4gICAgc3VtbWFyeVBhdGggPSBqb2luKHRhc2tzRGlyLCBgJHtwYXJhbXMudGFza0lkfS1TVU1NQVJZLm1kYCk7XG4gIH0gZWxzZSB7XG4gICAgLy8gVGFza3MgZGlyIGRvZXNuJ3QgZXhpc3Qgb24gZGlzayB5ZXQgXHUyMDE0IGJ1aWxkIHBhdGggbWFudWFsbHkgYW5kIGVuc3VyZSBkaXJzXG4gICAgY29uc3QgZ3NkRGlyID0gam9pbihiYXNlUGF0aCwgXCIuZ3NkXCIpO1xuICAgIGNvbnN0IG1hbnVhbFRhc2tzRGlyID0gam9pbihnc2REaXIsIFwibWlsZXN0b25lc1wiLCBwYXJhbXMubWlsZXN0b25lSWQsIFwic2xpY2VzXCIsIHBhcmFtcy5zbGljZUlkLCBcInRhc2tzXCIpO1xuICAgIG1rZGlyU3luYyhtYW51YWxUYXNrc0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgc3VtbWFyeVBhdGggPSBqb2luKG1hbnVhbFRhc2tzRGlyLCBgJHtwYXJhbXMudGFza0lkfS1TVU1NQVJZLm1kYCk7XG4gIH1cblxuICB0cnkge1xuICAgIGF3YWl0IHNhdmVGaWxlKHN1bW1hcnlQYXRoLCBzdW1tYXJ5TWQpO1xuXG4gICAgLy8gVG9nZ2xlIG9yIHJlZ2VuZXJhdGUgdGhlIHBsYW4gcHJvamVjdGlvbiBmcm9tIERCLiBNaXNzaW5nIHByb2plY3Rpb25cbiAgICAvLyBmaWxlcyBhcmUgcmVidWlsdCBieSB0aGUgcmVuZGVyZXIgaW5zdGVhZCBvZiBiZWluZyBza2lwcGVkLlxuICAgIGF3YWl0IHJlbmRlclBsYW5DaGVja2JveGVzKGJhc2VQYXRoLCBwYXJhbXMubWlsZXN0b25lSWQsIHBhcmFtcy5zbGljZUlkKTtcbiAgfSBjYXRjaCAocmVuZGVyRXJyKSB7XG4gICAgcHJvamVjdGlvblN0YWxlID0gdHJ1ZTtcbiAgICBsb2dXYXJuaW5nKFwicHJvamVjdGlvblwiLCBgY29tcGxldGVfdGFzayBwcm9qZWN0aW9uIHdyaXRlIGZhaWxlZCBmb3IgJHtwYXJhbXMubWlsZXN0b25lSWR9LyR7cGFyYW1zLnNsaWNlSWR9LyR7cGFyYW1zLnRhc2tJZH07IERCIGNvbXBsZXRpb24gcmVtYWlucyBjb21taXR0ZWRgLCB7XG4gICAgICBlcnJvcjogKHJlbmRlckVyciBhcyBFcnJvcikubWVzc2FnZSxcbiAgICB9KTtcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBDbG9zZSBnYXRlcyBvd25lZCBieSBleGVjdXRlLXRhc2sgKFE1L1E2L1E3KSBmb3IgdGhpcyB0YXNrIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAvLyBFYWNoIGdhdGUgaWQgbWFwcyB0byBhIHNwZWNpZmljIHBhcmFtcyBmaWVsZCB2aWEgdGFza0dhdGVGaWVsZEZvcklkLlxuICAvLyBXaGVuIHRoZSBtb2RlbCBwb3B1bGF0ZXMgdGhlIGZpZWxkLCByZWNvcmQgYHBhc3NgOyB3aGVuIGl0J3MgZW1wdHksXG4gIC8vIHJlY29yZCBgb21pdHRlZGAuIFRhc2stc2NvcGVkIHJvd3MgYXJlIGZpbHRlcmVkIGJ5IHRhc2tJZCBzbyBhIHNpbmdsZVxuICAvLyB0YXNrJ3MgY29tcGxldGlvbiBkb2Vzbid0IHRvdWNoIHNpYmxpbmcgdGFza3MnIGdhdGUgcm93cy5cbiAgdHJ5IHtcbiAgICBjb25zdCBwZW5kaW5nR2F0ZXMgPSBnZXRQZW5kaW5nR2F0ZXNGb3JUdXJuKFxuICAgICAgcGFyYW1zLm1pbGVzdG9uZUlkLFxuICAgICAgcGFyYW1zLnNsaWNlSWQsXG4gICAgICBcImV4ZWN1dGUtdGFza1wiLFxuICAgICAgcGFyYW1zLnRhc2tJZCxcbiAgICApO1xuICAgIGlmIChwZW5kaW5nR2F0ZXMubGVuZ3RoID4gMCkge1xuICAgICAgY29uc3Qgb3duZWREZWZzID0gbmV3IE1hcChnZXRHYXRlc0ZvclR1cm4oXCJleGVjdXRlLXRhc2tcIikubWFwKChnKSA9PiBbZy5pZCwgZ10gYXMgY29uc3QpKTtcbiAgICAgIGZvciAoY29uc3Qgcm93IG9mIHBlbmRpbmdHYXRlcykge1xuICAgICAgICBjb25zdCBkZWYgPSBvd25lZERlZnMuZ2V0KHJvdy5nYXRlX2lkKTtcbiAgICAgICAgaWYgKCFkZWYpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBmaWVsZCA9IHRhc2tHYXRlRmllbGRGb3JJZChkZWYuaWQsIHBhcmFtcyk7XG4gICAgICAgIGNvbnN0IGhhc0NvbnRlbnQgPSB0eXBlb2YgZmllbGQgPT09IFwic3RyaW5nXCIgJiYgZmllbGQudHJpbSgpLmxlbmd0aCA+IDA7XG4gICAgICAgIHNhdmVHYXRlUmVzdWx0KHtcbiAgICAgICAgICBtaWxlc3RvbmVJZDogcGFyYW1zLm1pbGVzdG9uZUlkLFxuICAgICAgICAgIHNsaWNlSWQ6IHBhcmFtcy5zbGljZUlkLFxuICAgICAgICAgIHRhc2tJZDogcGFyYW1zLnRhc2tJZCxcbiAgICAgICAgICBnYXRlSWQ6IGRlZi5pZCxcbiAgICAgICAgICB2ZXJkaWN0OiBoYXNDb250ZW50ID8gXCJwYXNzXCIgOiBcIm9taXR0ZWRcIixcbiAgICAgICAgICByYXRpb25hbGU6IGhhc0NvbnRlbnRcbiAgICAgICAgICAgID8gYCR7ZGVmLnByb21wdFNlY3Rpb259IHNlY3Rpb24gcG9wdWxhdGVkIGluIHRhc2sgc3VtbWFyeWBcbiAgICAgICAgICAgIDogYCR7ZGVmLnByb21wdFNlY3Rpb259IHNlY3Rpb24gbGVmdCBlbXB0eSBcdTIwMTQgcmVjb3JkZWQgYXMgb21pdHRlZGAsXG4gICAgICAgICAgZmluZGluZ3M6IGhhc0NvbnRlbnQgPyAoZmllbGQgYXMgc3RyaW5nKS50cmltKCkgOiBcIlwiLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2ggKGdhdGVFcnIpIHtcbiAgICBsb2dXYXJuaW5nKFxuICAgICAgXCJ0b29sXCIsXG4gICAgICBgY29tcGxldGUtdGFzayBnYXRlIGNsb3NlIHdhcm5pbmcgZm9yICR7cGFyYW1zLm1pbGVzdG9uZUlkfS8ke3BhcmFtcy5zbGljZUlkfS8ke3BhcmFtcy50YXNrSWR9OiAkeyhnYXRlRXJyIGFzIEVycm9yKS5tZXNzYWdlfWAsXG4gICAgKTtcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBBRFItMDExIFBoYXNlIDI6IHdyaXRlIGVzY2FsYXRpb24gYXJ0aWZhY3QgKG9wdC1pbikgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIC8vIFZhbGlkYXRpb24gYWxyZWFkeSBoYXBwZW5lZCBCRUZPUkUgc2lkZSBlZmZlY3RzIFx1MjAxNCB0aGlzIGJsb2NrIG9ubHlcbiAgLy8gcGVyZm9ybXMgdGhlIGRpc2sgd3JpdGUgZm9yIGEgcHJlLXZhbGlkYXRlZCBhcnRpZmFjdC4gRm9yXG4gIC8vIGNvbnRpbnVlV2l0aERlZmF1bHQ9ZmFsc2UsIGEgd3JpdGUgZmFpbHVyZSBoZXJlIHdvdWxkIG90aGVyd2lzZSBsZWF2ZVxuICAvLyB0aGUgdGFzayBtYXJrZWQgY29tcGxldGUgd2l0aCBTVU1NQVJZLm1kICsgY2xvc2VkIGdhdGVzIGJ1dCBub1xuICAvLyBlc2NhbGF0aW9uLCB3aGljaCBzaWxlbnRseSBhZHZhbmNlcyB0aGUgbG9vcCBwYXN0IGEgcGF1c2UgdGhlIHVzZXJcbiAgLy8gYXNrZWQgZm9yLiBXZSBjb21wZW5zYXRlIGJ5IHJldmVydGluZyB0aGUgREItbGV2ZWwgY29tcGxldGlvbjogc2V0XG4gIC8vIHN0YXR1cyBiYWNrIHRvICdwZW5kaW5nJyBhbmQgZGVsZXRlIHRoZSB2ZXJpZmljYXRpb25fZXZpZGVuY2Ugcm93c1xuICAvLyAoc2FtZSBzaGFwZSBhcyB0aGUgZGlzay1yZW5kZXItZmFpbHVyZSByb2xsYmFjayBhYm92ZSkuIFNVTU1BUlkubWRcbiAgLy8gb24gZGlzayBpcyBsZWZ0IGluIHBsYWNlIGJlY2F1c2UgdGhlIG5leHQgY29tcGxldGUtdGFzayByZXRyeSB3aWxsXG4gIC8vIG92ZXJ3cml0ZSBpdDsgZ2F0ZSByb3dzIGFyZSBVUFNFUlQta2V5ZWQgcGVyIHRhc2sgYW5kIHdpbGwgYWxzbyBiZVxuICAvLyBvdmVyd3JpdHRlbi4gVGhpcyByZXN0b3JlcyB0aGUgaW52YXJpYW50IHRoYXQgZGVyaXZlU3RhdGUoKSBzZWVzIGFcbiAgLy8gY29uc2lzdGVudCBcInRhc2sgbm90IGRvbmVcIiB2aWV3IHNvIHRoZSBsb29wIHJlLWRpc3BhdGNoZXMgdGhlIHRhc2suXG4gIGlmICh2YWxpZGF0ZWRFc2NhbGF0aW9uQXJ0aWZhY3QpIHtcbiAgICB0cnkge1xuICAgICAgd3JpdGVFc2NhbGF0aW9uQXJ0aWZhY3QoYmFzZVBhdGgsIHZhbGlkYXRlZEVzY2FsYXRpb25BcnRpZmFjdCk7XG4gICAgfSBjYXRjaCAoZXNjYWxhdGlvbkVycikge1xuICAgICAgY29uc3QgbXNnID0gYGNvbXBsZXRlLXRhc2sgZXNjYWxhdGlvbiB3cml0ZSBmYWlsZWQgZm9yICR7cGFyYW1zLm1pbGVzdG9uZUlkfS8ke3BhcmFtcy5zbGljZUlkfS8ke3BhcmFtcy50YXNrSWR9OiAkeyhlc2NhbGF0aW9uRXJyIGFzIEVycm9yKS5tZXNzYWdlfWA7XG4gICAgICBsb2dXYXJuaW5nKFwidG9vbFwiLCBtc2cpO1xuICAgICAgaWYgKHZhbGlkYXRlZEVzY2FsYXRpb25BcnRpZmFjdC5jb250aW51ZVdpdGhEZWZhdWx0ID09PSBmYWxzZSkge1xuICAgICAgICAvLyBDb21wZW5zYXRpbmcgcm9sbGJhY2s6IHJldmVydCBEQiBjb21wbGV0aW9uIHNvIHRoZSBsb29wIHBhdXNlcyBvblxuICAgICAgICAvLyByZS1kaXNwYXRjaCBpbnN0ZWFkIG9mIHNpbGVudGx5IGFkdmFuY2luZy4gTWlycm9yIHRoZSBleGlzdGluZ1xuICAgICAgICAvLyByZW5kZXJFcnIgcm9sbGJhY2sgKGxpbmUgfjI2MSkuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgZGVsZXRlVmVyaWZpY2F0aW9uRXZpZGVuY2UocGFyYW1zLm1pbGVzdG9uZUlkLCBwYXJhbXMuc2xpY2VJZCwgcGFyYW1zLnRhc2tJZCk7XG4gICAgICAgICAgdXBkYXRlVGFza1N0YXR1cyhwYXJhbXMubWlsZXN0b25lSWQsIHBhcmFtcy5zbGljZUlkLCBwYXJhbXMudGFza0lkLCAncGVuZGluZycpO1xuICAgICAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICAgICAgbG9nV2FybmluZyhcbiAgICAgICAgICAgIFwidG9vbFwiLFxuICAgICAgICAgICAgYGNvbXBsZXRlLXRhc2sgcm9sbGVkIGJhY2sgREIgY29tcGxldGlvbiBmb3IgJHtwYXJhbXMubWlsZXN0b25lSWR9LyR7cGFyYW1zLnNsaWNlSWR9LyR7cGFyYW1zLnRhc2tJZH0gYWZ0ZXIgZXNjYWxhdGlvbiB3cml0ZSBmYWlsdXJlOyBTVU1NQVJZLm1kIGxlZnQgb24gZGlzayBmb3IgcmV0cnkuYCxcbiAgICAgICAgICApO1xuICAgICAgICB9IGNhdGNoIChyb2xsYmFja0Vycikge1xuICAgICAgICAgIGxvZ1dhcm5pbmcoXG4gICAgICAgICAgICBcInRvb2xcIixcbiAgICAgICAgICAgIGBjb21wbGV0ZS10YXNrIHJvbGxiYWNrIGZhaWxlZCBhZnRlciBlc2NhbGF0aW9uIHdyaXRlIGZhaWx1cmUgZm9yICR7cGFyYW1zLm1pbGVzdG9uZUlkfS8ke3BhcmFtcy5zbGljZUlkfS8ke3BhcmFtcy50YXNrSWR9OiAkeyhyb2xsYmFja0VyciBhcyBFcnJvcikubWVzc2FnZX1gLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHsgZXJyb3I6IG1zZyB9O1xuICAgICAgfVxuICAgIH1cbiAgfSBlbHNlIGlmIChwYXJhbXMuZXNjYWxhdGlvbiAmJiAhZXNjYWxhdGlvbldyaXRlRW5hYmxlZCkge1xuICAgIGxvZ1dhcm5pbmcoXG4gICAgICBcInRvb2xcIixcbiAgICAgIGBjb21wbGV0ZS10YXNrIHJlY2VpdmVkIGVzY2FsYXRpb24gcGF5bG9hZCBidXQgcGhhc2VzLm1pZF9leGVjdXRpb25fZXNjYWxhdGlvbiBpcyBub3QgZW5hYmxlZDsgaWdub3JpbmcgKCR7cGFyYW1zLm1pbGVzdG9uZUlkfS8ke3BhcmFtcy5zbGljZUlkfS8ke3BhcmFtcy50YXNrSWR9KWAsXG4gICAgKTtcbiAgfVxuXG4gIC8vIEludmFsaWRhdGUgYWxsIGNhY2hlc1xuICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICBjbGVhclBhdGhDYWNoZSgpO1xuICBjbGVhclBhcnNlQ2FjaGUoKTtcblxuICAvLyBcdTI1MDBcdTI1MDAgUG9zdC1tdXRhdGlvbiBob29rOiBwcm9qZWN0aW9ucywgbWFuaWZlc3QsIGV2ZW50IGxvZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgLy8gU2VwYXJhdGUgdHJ5L2NhdGNoIHBlciBzdGVwIHNvIGEgcHJvamVjdGlvbiBmYWlsdXJlIGRvZXNuJ3QgcHJldmVudFxuICAvLyB0aGUgZXZlbnQgbG9nIGVudHJ5IChjcml0aWNhbCBmb3Igd29ya3RyZWUgcmVjb25jaWxpYXRpb24pLlxuICB0cnkge1xuICAgIGF3YWl0IHJlbmRlckFsbFByb2plY3Rpb25zKGJhc2VQYXRoLCBwYXJhbXMubWlsZXN0b25lSWQpO1xuICB9IGNhdGNoIChwcm9qRXJyKSB7XG4gICAgbG9nV2FybmluZyhcInRvb2xcIiwgYGNvbXBsZXRlLXRhc2sgcHJvamVjdGlvbiB3YXJuaW5nOiAkeyhwcm9qRXJyIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuICB9XG4gIHRyeSB7XG4gICAgd3JpdGVNYW5pZmVzdChiYXNlUGF0aCk7XG4gIH0gY2F0Y2ggKG1mRXJyKSB7XG4gICAgbG9nV2FybmluZyhcInRvb2xcIiwgYGNvbXBsZXRlLXRhc2sgbWFuaWZlc3Qgd2FybmluZzogJHsobWZFcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gIH1cbiAgdHJ5IHtcbiAgICBhcHBlbmRFdmVudChiYXNlUGF0aCwge1xuICAgICAgY21kOiBcImNvbXBsZXRlLXRhc2tcIixcbiAgICAgIHBhcmFtczogeyBtaWxlc3RvbmVJZDogcGFyYW1zLm1pbGVzdG9uZUlkLCBzbGljZUlkOiBwYXJhbXMuc2xpY2VJZCwgdGFza0lkOiBwYXJhbXMudGFza0lkIH0sXG4gICAgICB0czogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgYWN0b3I6IFwiYWdlbnRcIixcbiAgICAgIGFjdG9yX25hbWU6IHBhcmFtcy5hY3Rvck5hbWUsXG4gICAgICB0cmlnZ2VyX3JlYXNvbjogcGFyYW1zLnRyaWdnZXJSZWFzb24sXG4gICAgfSk7XG4gIH0gY2F0Y2ggKGV2ZW50RXJyKSB7XG4gICAgbG9nRXJyb3IoXCJ0b29sXCIsIGBjb21wbGV0ZS10YXNrIGV2ZW50IGxvZyBGQUlMRUQgXHUyMDE0IGNvbXBsZXRpb24gaW52aXNpYmxlIHRvIHJlY29uY2lsaWF0aW9uYCwgeyBlcnJvcjogKGV2ZW50RXJyIGFzIEVycm9yKS5tZXNzYWdlIH0pO1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICB0YXNrSWQ6IHBhcmFtcy50YXNrSWQsXG4gICAgc2xpY2VJZDogcGFyYW1zLnNsaWNlSWQsXG4gICAgbWlsZXN0b25lSWQ6IHBhcmFtcy5taWxlc3RvbmVJZCxcbiAgICBzdW1tYXJ5UGF0aCxcbiAgICAuLi4ocHJvamVjdGlvblN0YWxlID8geyBzdGFsZTogdHJ1ZSB9IDoge30pLFxuICB9O1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBWUEsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsaUJBQTZCO0FBR3RDLFNBQVMsc0JBQXNCO0FBQy9CO0FB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
