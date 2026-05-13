import {
  _getAdapter,
  isDbAvailable,
  getMilestone,
  getMilestoneSlices,
  getSliceTasks,
  getVerificationEvidence
} from "./gsd-db.js";
import { atomicWriteSync } from "./atomic-write.js";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { logWarning } from "./workflow-logger.js";
import { isClosedStatus } from "./status-guards.js";
import { deriveState } from "./state.js";
import { renderRoadmapFromDb } from "./markdown-renderer.js";
function stripIdPrefix(title, id) {
  const prefix = `${id}: `;
  let result = title;
  while (result.startsWith(prefix)) {
    result = result.slice(prefix.length);
  }
  return result.trim() || title;
}
function renderPlanContent(sliceRow, taskRows) {
  const lines = [];
  const displayTitle = stripIdPrefix(sliceRow.title, sliceRow.id);
  lines.push(`# ${sliceRow.id}: ${displayTitle}`);
  lines.push("");
  lines.push(`**Goal:** ${sliceRow.goal || "TBD"}`);
  lines.push(`**Demo:** After this: ${sliceRow.demo || "TBD"}`);
  lines.push("");
  lines.push("## Tasks");
  for (const task of taskRows) {
    const checkbox = isClosedStatus(task.status) ? "[x]" : "[ ]";
    lines.push(`- ${checkbox} **${task.id}: ${task.title}** \u2014 ${task.description}`);
    if (task.estimate) {
      lines.push(`  - Estimate: ${task.estimate}`);
    }
    if (task.files && task.files.length > 0) {
      lines.push(`  - Files: ${task.files.join(", ")}`);
    }
    if (task.verify) {
      lines.push(`  - Verify: ${task.verify}`);
    }
    if (task.duration) {
      lines.push(`  - Duration: ${task.duration}`);
    }
    if (task.blocker_discovered && task.known_issues) {
      lines.push(`  - Blocker: ${task.known_issues}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
function renderPlanProjection(basePath, milestoneId, sliceId) {
  const sliceRows = getMilestoneSlices(milestoneId);
  const sliceRow = sliceRows.find((s) => s.id === sliceId);
  if (!sliceRow) return;
  const taskRows = getSliceTasks(milestoneId, sliceId);
  const content = renderPlanContent(sliceRow, taskRows);
  const dir = join(basePath, ".gsd", "milestones", milestoneId, "slices", sliceId);
  mkdirSync(dir, { recursive: true });
  atomicWriteSync(join(dir, `${sliceId}-PLAN.md`), content);
}
function renderRoadmapContent(milestoneRow, sliceRows) {
  const lines = [];
  const displayTitle = stripIdPrefix(milestoneRow.title, milestoneRow.id);
  lines.push(`# ${milestoneRow.id}: ${displayTitle}`);
  lines.push("");
  lines.push("## Vision");
  lines.push(milestoneRow.vision || milestoneRow.title || "TBD");
  lines.push("");
  lines.push("## Slice Overview");
  lines.push("| ID | Slice | Risk | Depends | Done | After this |");
  lines.push("|----|-------|------|---------|------|------------|");
  for (const slice of sliceRows) {
    const done = isClosedStatus(slice.status) ? "\u2705" : "\u2B1C";
    let depends = "\u2014";
    if (slice.depends && slice.depends.length > 0) {
      depends = slice.depends.join(", ");
    }
    const risk = (slice.risk || "low").toLowerCase();
    const demo = slice.demo || "TBD";
    lines.push(`| ${slice.id} | ${slice.title} | ${risk} | ${depends} | ${done} | ${demo} |`);
  }
  lines.push("");
  return lines.join("\n");
}
function renderRoadmapProjection(basePath, milestoneId) {
  const milestoneRow = getMilestone(milestoneId);
  if (!milestoneRow) return;
  const sliceRows = getMilestoneSlices(milestoneId);
  const content = renderRoadmapContent(milestoneRow, sliceRows);
  const dir = join(basePath, ".gsd", "milestones", milestoneId);
  mkdirSync(dir, { recursive: true });
  atomicWriteSync(join(dir, `${milestoneId}-ROADMAP.md`), content);
}
function renderSummaryContent(taskRow, sliceId, milestoneId, evidence) {
  if (taskRow.full_summary_md && taskRow.full_summary_md.trimStart().startsWith("---")) {
    return taskRow.full_summary_md;
  }
  const keyFilesYaml = taskRow.key_files && taskRow.key_files.length > 0 ? `
${taskRow.key_files.map((f) => `  - ${f}`).join("\n")}` : " []";
  const keyDecisionsYaml = taskRow.key_decisions && taskRow.key_decisions.length > 0 ? `
${taskRow.key_decisions.map((d) => `  - ${d}`).join("\n")}` : " []";
  const evidenceList = evidence ?? [];
  const allPassed = evidenceList.length > 0 && evidenceList.every((e) => {
    const code = e.exitCode ?? e.exit_code ?? -1;
    return code === 0 || e.verdict.includes("\u2705") || e.verdict.toLowerCase().includes("pass");
  });
  const verificationResult = taskRow.verification_result ? allPassed ? "passed" : evidenceList.length === 0 ? "untested" : "mixed" : allPassed ? "passed" : evidenceList.length === 0 ? "untested" : "mixed";
  let evidenceTable = "| # | Command | Exit Code | Verdict | Duration |\n|---|---------|-----------|---------|----------|\n";
  if (evidenceList.length > 0) {
    evidenceList.forEach((e, i) => {
      const code = e.exitCode ?? e.exit_code ?? 0;
      const dur = e.durationMs ?? e.duration_ms ?? 0;
      evidenceTable += `| ${i + 1} | \`${e.command}\` | ${code} | ${e.verdict} | ${dur}ms |
`;
    });
  } else {
    evidenceTable += "| \u2014 | No verification commands discovered | \u2014 | \u2014 | \u2014 |\n";
  }
  const title = taskRow.one_liner || taskRow.title || taskRow.id;
  return `---
id: ${taskRow.id}
parent: ${sliceId}
milestone: ${milestoneId}
key_files:${keyFilesYaml}
key_decisions:${keyDecisionsYaml}
duration: ${taskRow.duration || ""}
verification_result: ${verificationResult}
completed_at: ${taskRow.completed_at || ""}
blocker_discovered: ${taskRow.blocker_discovered ? "true" : "false"}
---

# ${taskRow.id}: ${title}

**${taskRow.one_liner || ""}**

## What Happened

${taskRow.narrative || "No summary recorded."}

## Verification

${taskRow.verification_result || "No verification recorded."}

## Verification Evidence

${evidenceTable}
## Deviations

${taskRow.deviations || "None."}

## Known Issues

${taskRow.known_issues || "None."}

## Files Created/Modified

${taskRow.key_files && taskRow.key_files.length > 0 ? taskRow.key_files.map((f) => `- \`${f}\``).join("\n") : "None."}
`;
}
function renderSummaryProjection(basePath, milestoneId, sliceId, taskId) {
  const taskRows = getSliceTasks(milestoneId, sliceId);
  const taskRow = taskRows.find((t) => t.id === taskId);
  if (!taskRow) return;
  const evidenceRows = getVerificationEvidence(milestoneId, sliceId, taskId);
  const content = renderSummaryContent(taskRow, sliceId, milestoneId, evidenceRows);
  const dir = join(basePath, ".gsd", "milestones", milestoneId, "slices", sliceId, "tasks");
  mkdirSync(dir, { recursive: true });
  atomicWriteSync(join(dir, `${taskId}-SUMMARY.md`), content);
}
function renderStateContent(state) {
  const lines = [];
  lines.push("# GSD State", "");
  const activeSlice = state.activeSlice ? `${state.activeSlice.id}: ${stripIdPrefix(state.activeSlice.title, state.activeSlice.id)}` : "None";
  if (state.phase === "complete" && state.lastCompletedMilestone) {
    lines.push(`**Last Completed Milestone:** ${state.lastCompletedMilestone.id}: ${state.lastCompletedMilestone.title}`);
  } else {
    const activeMilestone = state.activeMilestone ? `${state.activeMilestone.id}: ${stripIdPrefix(state.activeMilestone.title, state.activeMilestone.id)}` : "None";
    lines.push(`**Active Milestone:** ${activeMilestone}`);
  }
  lines.push(`**Active Slice:** ${activeSlice}`);
  lines.push(`**Phase:** ${state.phase}`);
  if (state.requirements) {
    lines.push(`**Requirements Status:** ${state.requirements.active} active \xB7 ${state.requirements.validated} validated \xB7 ${state.requirements.deferred} deferred \xB7 ${state.requirements.outOfScope} out of scope`);
  }
  lines.push("");
  lines.push("## Milestone Registry");
  for (const entry of state.registry) {
    const glyph = entry.status === "complete" ? "\u2705" : entry.status === "active" ? "\u{1F504}" : entry.status === "parked" ? "\u23F8\uFE0F" : "\u2B1C";
    lines.push(`- ${glyph} **${entry.id}:** ${stripIdPrefix(entry.title, entry.id)}`);
  }
  lines.push("");
  lines.push("## Recent Decisions");
  if (state.recentDecisions.length > 0) {
    for (const decision of state.recentDecisions) lines.push(`- ${decision}`);
  } else {
    lines.push("- None recorded");
  }
  lines.push("");
  lines.push("## Blockers");
  if (state.blockers.length > 0) {
    for (const blocker of state.blockers) lines.push(`- ${blocker}`);
  } else {
    lines.push("- None");
  }
  lines.push("");
  lines.push("## Next Action");
  lines.push(state.nextAction || "None");
  lines.push("");
  return lines.join("\n");
}
async function renderStateProjection(basePath) {
  try {
    if (!isDbAvailable()) return;
    const adapter = _getAdapter();
    if (!adapter) return;
    try {
      adapter.prepare("SELECT 1").get();
    } catch (err) {
      logWarning("projection", "renderStateProjection: DB handle probe failed, skipping render", {
        error: err.message
      });
      return;
    }
    const state = await deriveState(basePath);
    const content = renderStateContent(state);
    const dir = join(basePath, ".gsd");
    mkdirSync(dir, { recursive: true });
    atomicWriteSync(join(dir, "STATE.md"), content);
  } catch (err) {
    logWarning("projection", `renderStateProjection failed: ${err.message}`);
  }
}
async function renderAllProjections(basePath, milestoneId) {
  try {
    await renderRoadmapFromDb(basePath, milestoneId);
  } catch (err) {
    logWarning("projection", `renderRoadmapFromDb failed for ${milestoneId}: ${err.message}`);
  }
  const sliceRows = getMilestoneSlices(milestoneId);
  for (const slice of sliceRows) {
    const taskRows = getSliceTasks(milestoneId, slice.id);
    const doneTasks = taskRows.filter((t) => t.status === "done" || t.status === "complete");
    for (const task of doneTasks) {
      try {
        renderSummaryProjection(basePath, milestoneId, slice.id, task.id);
      } catch (err) {
        logWarning("projection", `renderSummaryProjection failed for ${milestoneId}/${slice.id}/${task.id}: ${err.message}`);
      }
    }
  }
  try {
    await renderStateProjection(basePath);
  } catch (err) {
    logWarning("projection", `renderStateProjection failed: ${err.message}`);
  }
}
async function regenerateIfMissing(basePath, milestoneId, sliceId, fileType) {
  let filePath;
  switch (fileType) {
    case "PLAN":
      filePath = join(basePath, ".gsd", "milestones", milestoneId, "slices", sliceId, `${sliceId}-PLAN.md`);
      break;
    case "ROADMAP":
      filePath = join(basePath, ".gsd", "milestones", milestoneId, `${milestoneId}-ROADMAP.md`);
      break;
    case "SUMMARY":
      filePath = join(basePath, ".gsd", "milestones", milestoneId, "slices", sliceId, "tasks");
      break;
    case "STATE":
      filePath = join(basePath, ".gsd", "STATE.md");
      break;
  }
  if (fileType === "SUMMARY") {
    const taskRows = getSliceTasks(milestoneId, sliceId);
    const doneTasks = taskRows.filter((t) => t.status === "done" || t.status === "complete");
    let regenerated = 0;
    for (const task of doneTasks) {
      const summaryPath = join(basePath, ".gsd", "milestones", milestoneId, "slices", sliceId, "tasks", `${task.id}-SUMMARY.md`);
      if (!existsSync(summaryPath)) {
        try {
          renderSummaryProjection(basePath, milestoneId, sliceId, task.id);
          regenerated++;
        } catch (err) {
          logWarning("projection", `regenerateIfMissing SUMMARY failed for ${task.id}: ${err.message}`);
        }
      }
    }
    return regenerated > 0;
  }
  if (existsSync(filePath)) {
    return false;
  }
  try {
    switch (fileType) {
      case "PLAN":
        renderPlanProjection(basePath, milestoneId, sliceId);
        return existsSync(filePath);
      case "ROADMAP":
        await renderRoadmapFromDb(basePath, milestoneId);
        return existsSync(filePath);
      case "STATE":
        await renderStateProjection(basePath);
        return existsSync(filePath);
    }
  } catch (err) {
    logWarning("projection", `regenerateIfMissing ${fileType} failed: ${err.message}`);
    return false;
  }
}
export {
  regenerateIfMissing,
  renderAllProjections,
  renderPlanContent,
  renderPlanProjection,
  renderRoadmapContent,
  renderRoadmapProjection,
  renderStateContent,
  renderStateProjection,
  renderSummaryContent,
  renderSummaryProjection,
  stripIdPrefix
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC93b3JrZmxvdy1wcm9qZWN0aW9ucy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IFByb2plY3Rpb24gcmVuZGVyZXJzIGZvciBHU0Qgd29ya2Zsb3cgZGF0YWJhc2Ugcm93cy5cbi8vIEdTRCBFeHRlbnNpb24gXHUyMDE0IFByb2plY3Rpb24gUmVuZGVyZXJzIChEQiAtPiBNYXJrZG93bilcbi8vIFJlbmRlcnMgUExBTi5tZCwgUk9BRE1BUC5tZCwgU1VNTUFSWS5tZCwgYW5kIFNUQVRFLm1kIGZyb20gZGF0YWJhc2Ugcm93cy5cbi8vIFByb2plY3Rpb25zIGFyZSByZWFkLW9ubHkgdmlld3Mgb2YgZW5naW5lIHN0YXRlIChMYXllciAzIG9mIHRoZSBhcmNoaXRlY3R1cmUpLlxuXG5pbXBvcnQge1xuICBfZ2V0QWRhcHRlcixcbiAgaXNEYkF2YWlsYWJsZSxcbiAgZ2V0QWxsTWlsZXN0b25lcyxcbiAgZ2V0TWlsZXN0b25lLFxuICBnZXRNaWxlc3RvbmVTbGljZXMsXG4gIGdldFNsaWNlVGFza3MsXG4gIGdldFZlcmlmaWNhdGlvbkV2aWRlbmNlLFxufSBmcm9tIFwiLi9nc2QtZGIuanNcIjtcbmltcG9ydCB0eXBlIHsgTWlsZXN0b25lUm93IH0gZnJvbSBcIi4vZGItbWlsZXN0b25lLWFydGlmYWN0LXJvd3MuanNcIjtcbmltcG9ydCB0eXBlIHsgU2xpY2VSb3csIFRhc2tSb3cgfSBmcm9tIFwiLi9kYi10YXNrLXNsaWNlLXJvd3MuanNcIjtcbmltcG9ydCB0eXBlIHsgVmVyaWZpY2F0aW9uRXZpZGVuY2VSb3cgfSBmcm9tIFwiLi9kYi12ZXJpZmljYXRpb24tZXZpZGVuY2Utcm93cy5qc1wiO1xuaW1wb3J0IHsgYXRvbWljV3JpdGVTeW5jIH0gZnJvbSBcIi4vYXRvbWljLXdyaXRlLmpzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgbWtkaXJTeW5jLCBleGlzdHNTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGxvZ1dhcm5pbmcgfSBmcm9tIFwiLi93b3JrZmxvdy1sb2dnZXIuanNcIjtcbmltcG9ydCB7IGlzQ2xvc2VkU3RhdHVzIH0gZnJvbSBcIi4vc3RhdHVzLWd1YXJkcy5qc1wiO1xuaW1wb3J0IHsgZGVyaXZlU3RhdGUgfSBmcm9tIFwiLi9zdGF0ZS5qc1wiO1xuaW1wb3J0IHR5cGUgeyBHU0RTdGF0ZSB9IGZyb20gXCIuL3R5cGVzLmpzXCI7XG5pbXBvcnQgeyByZW5kZXJSb2FkbWFwRnJvbURiIH0gZnJvbSBcIi4vbWFya2Rvd24tcmVuZGVyZXIuanNcIjtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEhlbHBlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogU3RyaXAgYSBsZWFkaW5nIElEIHByZWZpeCAoZS5nLiBcIk0wMDE6IFwiIG9yIFwiUzA0OiBcIikgZnJvbSBhIHRpdGxlXG4gKiB0byBwcmV2ZW50IGRvdWJsZS1wcmVmaXhpbmcgd2hlbiB0aGUgcmVuZGVyZXIgYWRkcyBpdHMgb3duIHByZWZpeC5cbiAqIEhhbmRsZXMgcmVwZWF0ZWQgcHJlZml4ZXMgKGUuZy4gXCJNMDAxOiBNMDAxOiBNMDAxOiBUaXRsZVwiIFx1MjE5MiBcIlRpdGxlXCIpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3RyaXBJZFByZWZpeCh0aXRsZTogc3RyaW5nLCBpZDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgcHJlZml4ID0gYCR7aWR9OiBgO1xuICBsZXQgcmVzdWx0ID0gdGl0bGU7XG4gIHdoaWxlIChyZXN1bHQuc3RhcnRzV2l0aChwcmVmaXgpKSB7XG4gICAgcmVzdWx0ID0gcmVzdWx0LnNsaWNlKHByZWZpeC5sZW5ndGgpO1xuICB9XG4gIHJldHVybiByZXN1bHQudHJpbSgpIHx8IHRpdGxlO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUExBTi5tZCBQcm9qZWN0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFJlbmRlciBQTEFOLm1kIGNvbnRlbnQgZnJvbSBhIHNsaWNlIHJvdyBhbmQgaXRzIHRhc2sgcm93cy5cbiAqIFB1cmUgZnVuY3Rpb24gXHUyMDE0IG5vIHNpZGUgZWZmZWN0cy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlclBsYW5Db250ZW50KHNsaWNlUm93OiBTbGljZVJvdywgdGFza1Jvd3M6IFRhc2tSb3dbXSk6IHN0cmluZyB7XG4gIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuXG4gIGNvbnN0IGRpc3BsYXlUaXRsZSA9IHN0cmlwSWRQcmVmaXgoc2xpY2VSb3cudGl0bGUsIHNsaWNlUm93LmlkKTtcbiAgbGluZXMucHVzaChgIyAke3NsaWNlUm93LmlkfTogJHtkaXNwbGF5VGl0bGV9YCk7XG4gIGxpbmVzLnB1c2goXCJcIik7XG4gIC8vICMyOTQ1OiBuZXZlciB1c2UgZnVsbF9zdW1tYXJ5X21kL2Z1bGxfdWF0X21kIGFzIGRpc3BsYXkgZmFsbGJhY2tzIFx1MjAxNFxuICAvLyB0aGV5IGNvbnRhaW4gbXVsdGktbGluZSByZW5kZXJlZCBtYXJrZG93biB0aGF0IGNvcnJ1cHRzIHNpbmdsZS1saW5lIGZpZWxkcy5cbiAgbGluZXMucHVzaChgKipHb2FsOioqICR7c2xpY2VSb3cuZ29hbCB8fCBcIlRCRFwifWApO1xuICBsaW5lcy5wdXNoKGAqKkRlbW86KiogQWZ0ZXIgdGhpczogJHtzbGljZVJvdy5kZW1vIHx8IFwiVEJEXCJ9YCk7XG4gIGxpbmVzLnB1c2goXCJcIik7XG4gIGxpbmVzLnB1c2goXCIjIyBUYXNrc1wiKTtcblxuICBmb3IgKGNvbnN0IHRhc2sgb2YgdGFza1Jvd3MpIHtcbiAgICBjb25zdCBjaGVja2JveCA9IGlzQ2xvc2VkU3RhdHVzKHRhc2suc3RhdHVzKSA/IFwiW3hdXCIgOiBcIlsgXVwiO1xuICAgIGxpbmVzLnB1c2goYC0gJHtjaGVja2JveH0gKioke3Rhc2suaWR9OiAke3Rhc2sudGl0bGV9KiogXFx1MjAxNCAke3Rhc2suZGVzY3JpcHRpb259YCk7XG5cbiAgICAvLyBFc3RpbWF0ZSBzdWJsaW5lIChhbHdheXMgcHJlc2VudCBpZiBub24tZW1wdHkpXG4gICAgaWYgKHRhc2suZXN0aW1hdGUpIHtcbiAgICAgIGxpbmVzLnB1c2goYCAgLSBFc3RpbWF0ZTogJHt0YXNrLmVzdGltYXRlfWApO1xuICAgIH1cblxuICAgIC8vIEZpbGVzIHN1YmxpbmUgKG9ubHkgaWYgbm9uLWVtcHR5IGFycmF5KVxuICAgIGlmICh0YXNrLmZpbGVzICYmIHRhc2suZmlsZXMubGVuZ3RoID4gMCkge1xuICAgICAgbGluZXMucHVzaChgICAtIEZpbGVzOiAke3Rhc2suZmlsZXMuam9pbihcIiwgXCIpfWApO1xuICAgIH1cblxuICAgIC8vIFZlcmlmeSBzdWJsaW5lIChvbmx5IGlmIG5vbi1udWxsKVxuICAgIGlmICh0YXNrLnZlcmlmeSkge1xuICAgICAgbGluZXMucHVzaChgICAtIFZlcmlmeTogJHt0YXNrLnZlcmlmeX1gKTtcbiAgICB9XG5cbiAgICAvLyBEdXJhdGlvbiBzdWJsaW5lIChvbmx5IGlmIHJlY29yZGVkKVxuICAgIGlmICh0YXNrLmR1cmF0aW9uKSB7XG4gICAgICBsaW5lcy5wdXNoKGAgIC0gRHVyYXRpb246ICR7dGFzay5kdXJhdGlvbn1gKTtcbiAgICB9XG5cbiAgICAvLyBCbG9ja2VyIHN1YmxpbmUgKGlmIGRpc2NvdmVyZWQpXG4gICAgaWYgKHRhc2suYmxvY2tlcl9kaXNjb3ZlcmVkICYmIHRhc2sua25vd25faXNzdWVzKSB7XG4gICAgICBsaW5lcy5wdXNoKGAgIC0gQmxvY2tlcjogJHt0YXNrLmtub3duX2lzc3Vlc31gKTtcbiAgICB9XG4gIH1cblxuICBsaW5lcy5wdXNoKFwiXCIpO1xuICByZXR1cm4gbGluZXMuam9pbihcIlxcblwiKTtcbn1cblxuLyoqXG4gKiBSZW5kZXIgUExBTi5tZCBwcm9qZWN0aW9uIHRvIGRpc2sgZm9yIGEgc3BlY2lmaWMgc2xpY2UuXG4gKiBRdWVyaWVzIERCIHZpYSBoZWxwZXIgZnVuY3Rpb25zLCByZW5kZXJzIGNvbnRlbnQsIHdyaXRlcyB2aWEgYXRvbWljV3JpdGVTeW5jLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVuZGVyUGxhblByb2plY3Rpb24oYmFzZVBhdGg6IHN0cmluZywgbWlsZXN0b25lSWQ6IHN0cmluZywgc2xpY2VJZDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHNsaWNlUm93cyA9IGdldE1pbGVzdG9uZVNsaWNlcyhtaWxlc3RvbmVJZCk7XG4gIGNvbnN0IHNsaWNlUm93ID0gc2xpY2VSb3dzLmZpbmQocyA9PiBzLmlkID09PSBzbGljZUlkKTtcbiAgaWYgKCFzbGljZVJvdykgcmV0dXJuO1xuXG4gIGNvbnN0IHRhc2tSb3dzID0gZ2V0U2xpY2VUYXNrcyhtaWxlc3RvbmVJZCwgc2xpY2VJZCk7XG5cbiAgY29uc3QgY29udGVudCA9IHJlbmRlclBsYW5Db250ZW50KHNsaWNlUm93LCB0YXNrUm93cyk7XG4gIGNvbnN0IGRpciA9IGpvaW4oYmFzZVBhdGgsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgbWlsZXN0b25lSWQsIFwic2xpY2VzXCIsIHNsaWNlSWQpO1xuICBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgYXRvbWljV3JpdGVTeW5jKGpvaW4oZGlyLCBgJHtzbGljZUlkfS1QTEFOLm1kYCksIGNvbnRlbnQpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUk9BRE1BUC5tZCBQcm9qZWN0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFJlbmRlciBST0FETUFQLm1kIGNvbnRlbnQgZnJvbSBhIG1pbGVzdG9uZSByb3cgYW5kIGl0cyBzbGljZSByb3dzLlxuICogUHVyZSBmdW5jdGlvbiBcdTIwMTQgbm8gc2lkZSBlZmZlY3RzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVuZGVyUm9hZG1hcENvbnRlbnQobWlsZXN0b25lUm93OiBNaWxlc3RvbmVSb3csIHNsaWNlUm93czogU2xpY2VSb3dbXSk6IHN0cmluZyB7XG4gIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuXG4gIGNvbnN0IGRpc3BsYXlUaXRsZSA9IHN0cmlwSWRQcmVmaXgobWlsZXN0b25lUm93LnRpdGxlLCBtaWxlc3RvbmVSb3cuaWQpO1xuICBsaW5lcy5wdXNoKGAjICR7bWlsZXN0b25lUm93LmlkfTogJHtkaXNwbGF5VGl0bGV9YCk7XG4gIGxpbmVzLnB1c2goXCJcIik7XG4gIGxpbmVzLnB1c2goXCIjIyBWaXNpb25cIik7XG4gIGxpbmVzLnB1c2gobWlsZXN0b25lUm93LnZpc2lvbiB8fCBtaWxlc3RvbmVSb3cudGl0bGUgfHwgXCJUQkRcIik7XG4gIGxpbmVzLnB1c2goXCJcIik7XG4gIGxpbmVzLnB1c2goXCIjIyBTbGljZSBPdmVydmlld1wiKTtcbiAgbGluZXMucHVzaChcInwgSUQgfCBTbGljZSB8IFJpc2sgfCBEZXBlbmRzIHwgRG9uZSB8IEFmdGVyIHRoaXMgfFwiKTtcbiAgbGluZXMucHVzaChcInwtLS0tfC0tLS0tLS18LS0tLS0tfC0tLS0tLS0tLXwtLS0tLS18LS0tLS0tLS0tLS0tfFwiKTtcblxuICBmb3IgKGNvbnN0IHNsaWNlIG9mIHNsaWNlUm93cykge1xuICAgIGNvbnN0IGRvbmUgPSBpc0Nsb3NlZFN0YXR1cyhzbGljZS5zdGF0dXMpID8gXCJcXHUyNzA1XCIgOiBcIlxcdTJCMUNcIjtcblxuICAgIC8vIGRlcGVuZHMgaXMgYWxyZWFkeSBwYXJzZWQgdG8gc3RyaW5nW10gYnkgcm93VG9TbGljZVxuICAgIGxldCBkZXBlbmRzID0gXCJcXHUyMDE0XCI7XG4gICAgaWYgKHNsaWNlLmRlcGVuZHMgJiYgc2xpY2UuZGVwZW5kcy5sZW5ndGggPiAwKSB7XG4gICAgICBkZXBlbmRzID0gc2xpY2UuZGVwZW5kcy5qb2luKFwiLCBcIik7XG4gICAgfVxuXG4gICAgY29uc3QgcmlzayA9IChzbGljZS5yaXNrIHx8IFwibG93XCIpLnRvTG93ZXJDYXNlKCk7XG4gICAgLy8gIzI5NDUgQnVnIDE6IG5ldmVyIHVzZSBmdWxsX3VhdF9tZCBhcyBhIHRhYmxlIGNlbGwgZmFsbGJhY2sgXHUyMDE0IGl0IGNvbnRhaW5zXG4gICAgLy8gbXVsdGktbGluZSBVQVQgY29udGVudCAocHJlY29uZGl0aW9ucywgc3RlcHMsIGV4cGVjdGVkIHJlc3VsdHMpIHRoYXRcbiAgICAvLyBjb3JydXB0cyB0aGUgbWFya2Rvd24gdGFibGUgYW5kIG1ha2VzIHN1YnNlcXVlbnQgc2xpY2VzIGludmlzaWJsZS5cbiAgICBjb25zdCBkZW1vID0gc2xpY2UuZGVtbyB8fCBcIlRCRFwiO1xuXG4gICAgbGluZXMucHVzaChgfCAke3NsaWNlLmlkfSB8ICR7c2xpY2UudGl0bGV9IHwgJHtyaXNrfSB8ICR7ZGVwZW5kc30gfCAke2RvbmV9IHwgJHtkZW1vfSB8YCk7XG4gIH1cblxuICBsaW5lcy5wdXNoKFwiXCIpO1xuICByZXR1cm4gbGluZXMuam9pbihcIlxcblwiKTtcbn1cblxuLyoqXG4gKiBSZW5kZXIgUk9BRE1BUC5tZCBwcm9qZWN0aW9uIHRvIGRpc2sgZm9yIGEgc3BlY2lmaWMgbWlsZXN0b25lLlxuICogUXVlcmllcyBEQiB2aWEgaGVscGVyIGZ1bmN0aW9ucywgcmVuZGVycyBjb250ZW50LCB3cml0ZXMgdmlhIGF0b21pY1dyaXRlU3luYy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlclJvYWRtYXBQcm9qZWN0aW9uKGJhc2VQYXRoOiBzdHJpbmcsIG1pbGVzdG9uZUlkOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgbWlsZXN0b25lUm93ID0gZ2V0TWlsZXN0b25lKG1pbGVzdG9uZUlkKTtcbiAgaWYgKCFtaWxlc3RvbmVSb3cpIHJldHVybjtcblxuICBjb25zdCBzbGljZVJvd3MgPSBnZXRNaWxlc3RvbmVTbGljZXMobWlsZXN0b25lSWQpO1xuXG4gIGNvbnN0IGNvbnRlbnQgPSByZW5kZXJSb2FkbWFwQ29udGVudChtaWxlc3RvbmVSb3csIHNsaWNlUm93cyk7XG4gIGNvbnN0IGRpciA9IGpvaW4oYmFzZVBhdGgsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgbWlsZXN0b25lSWQpO1xuICBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgYXRvbWljV3JpdGVTeW5jKGpvaW4oZGlyLCBgJHttaWxlc3RvbmVJZH0tUk9BRE1BUC5tZGApLCBjb250ZW50KTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNVTU1BUlkubWQgUHJvamVjdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBSZW5kZXIgU1VNTUFSWS5tZCBjb250ZW50IGZyb20gYSB0YXNrIHJvdy5cbiAqIFNpbmdsZSBzb3VyY2Ugb2YgdHJ1dGggZm9yIHN1bW1hcnkgcmVuZGVyaW5nIFx1MjAxNCB1c2VkIGJvdGggYXQgY29tcGxldGlvblxuICogdGltZSBhbmQgYXQgcHJvamVjdGlvbiByZWdlbmVyYXRpb24gdGltZSAoIzI3MjApLlxuICpcbiAqIEBwYXJhbSBldmlkZW5jZSAtIE9wdGlvbmFsIHZlcmlmaWNhdGlvbiBldmlkZW5jZSByb3dzLiBXaGVuIGNhbGxlZCBmcm9tXG4gKiAgIGNvbXBsZXRlLXRhc2ssIHRoZXNlIGFyZSBwYXNzZWQgZGlyZWN0bHkuIFdoZW4gY2FsbGVkIGZyb20gcHJvamVjdGlvblxuICogICByZWdlbmVyYXRpb24sIHRoZXkgYXJlIHF1ZXJpZWQgZnJvbSB0aGUgREIgYnkgcmVuZGVyU3VtbWFyeVByb2plY3Rpb24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJTdW1tYXJ5Q29udGVudChcbiAgdGFza1JvdzogVGFza1JvdyxcbiAgc2xpY2VJZDogc3RyaW5nLFxuICBtaWxlc3RvbmVJZDogc3RyaW5nLFxuICBldmlkZW5jZT86IEFycmF5PHsgY29tbWFuZDogc3RyaW5nOyBleGl0Q29kZT86IG51bWJlcjsgZXhpdF9jb2RlPzogbnVtYmVyOyB2ZXJkaWN0OiBzdHJpbmc7IGR1cmF0aW9uTXM/OiBudW1iZXI7IGR1cmF0aW9uX21zPzogbnVtYmVyIH0+LFxuKTogc3RyaW5nIHtcbiAgLy8gSWYgdGhlIHRhc2sgYWxyZWFkeSBoYXMgYSBmdWxseSByZW5kZXJlZCBzdW1tYXJ5ICh3cml0dGVuIGJ5IGhhbmRsZUNvbXBsZXRlVGFzaydzXG4gIC8vIHJlbmRlclN1bW1hcnlNYXJrZG93biksIHVzZSBpdCBhcy1pcy4gVGhhdCBjb250ZW50IGFscmVhZHkgaW5jbHVkZXMgZnJvbnRtYXR0ZXIsXG4gIC8vIGhlYWRpbmcsIGFuZCBhbGwgc2VjdGlvbnMuIFJlLXdyYXBwaW5nIGl0IGluc2lkZSBhIHNlY29uZCBmcm9udG1hdHRlci9oZWFkaW5nXG4gIC8vIGVudmVsb3BlIHByb2R1Y2VzIGRvdWJsZSBmcm9udG1hdHRlciBhbmQgZHVwbGljYXRlIHNlY3Rpb25zLlxuICBpZiAodGFza1Jvdy5mdWxsX3N1bW1hcnlfbWQgJiYgdGFza1Jvdy5mdWxsX3N1bW1hcnlfbWQudHJpbVN0YXJ0KCkuc3RhcnRzV2l0aChcIi0tLVwiKSkge1xuICAgIHJldHVybiB0YXNrUm93LmZ1bGxfc3VtbWFyeV9tZDtcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBGcm9udG1hdHRlciAoWUFNTCBsaXN0IGZvcm1hdCwgbWF0Y2hlcyBwYXJzZVN1bW1hcnkoKSBleHBlY3RhdGlvbnMpIFx1MjUwMFx1MjUwMFxuICBjb25zdCBrZXlGaWxlc1lhbWwgPSB0YXNrUm93LmtleV9maWxlcyAmJiB0YXNrUm93LmtleV9maWxlcy5sZW5ndGggPiAwXG4gICAgPyBgXFxuJHt0YXNrUm93LmtleV9maWxlcy5tYXAoZiA9PiBgICAtICR7Zn1gKS5qb2luKFwiXFxuXCIpfWBcbiAgICA6IFwiIFtdXCI7XG4gIGNvbnN0IGtleURlY2lzaW9uc1lhbWwgPSB0YXNrUm93LmtleV9kZWNpc2lvbnMgJiYgdGFza1Jvdy5rZXlfZGVjaXNpb25zLmxlbmd0aCA+IDBcbiAgICA/IGBcXG4ke3Rhc2tSb3cua2V5X2RlY2lzaW9ucy5tYXAoZCA9PiBgICAtICR7ZH1gKS5qb2luKFwiXFxuXCIpfWBcbiAgICA6IFwiIFtdXCI7XG5cbiAgLy8gRGVyaXZlIHZlcmlmaWNhdGlvbl9yZXN1bHQgZnJvbSBldmlkZW5jZSBpZiBhdmFpbGFibGVcbiAgY29uc3QgZXZpZGVuY2VMaXN0ID0gZXZpZGVuY2UgPz8gW107XG4gIGNvbnN0IGFsbFBhc3NlZCA9IGV2aWRlbmNlTGlzdC5sZW5ndGggPiAwICYmXG4gICAgZXZpZGVuY2VMaXN0LmV2ZXJ5KGUgPT4ge1xuICAgICAgY29uc3QgY29kZSA9IGUuZXhpdENvZGUgPz8gZS5leGl0X2NvZGUgPz8gLTE7XG4gICAgICByZXR1cm4gY29kZSA9PT0gMCB8fCBlLnZlcmRpY3QuaW5jbHVkZXMoXCJcXHUyNzA1XCIpIHx8IGUudmVyZGljdC50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKFwicGFzc1wiKTtcbiAgICB9KTtcbiAgY29uc3QgdmVyaWZpY2F0aW9uUmVzdWx0ID0gdGFza1Jvdy52ZXJpZmljYXRpb25fcmVzdWx0XG4gICAgPyAoYWxsUGFzc2VkID8gXCJwYXNzZWRcIiA6IChldmlkZW5jZUxpc3QubGVuZ3RoID09PSAwID8gXCJ1bnRlc3RlZFwiIDogXCJtaXhlZFwiKSlcbiAgICA6IChhbGxQYXNzZWQgPyBcInBhc3NlZFwiIDogKGV2aWRlbmNlTGlzdC5sZW5ndGggPT09IDAgPyBcInVudGVzdGVkXCIgOiBcIm1peGVkXCIpKTtcblxuICAvLyBCdWlsZCB2ZXJpZmljYXRpb24gZXZpZGVuY2UgdGFibGVcbiAgbGV0IGV2aWRlbmNlVGFibGUgPSBcInwgIyB8IENvbW1hbmQgfCBFeGl0IENvZGUgfCBWZXJkaWN0IHwgRHVyYXRpb24gfFxcbnwtLS18LS0tLS0tLS0tfC0tLS0tLS0tLS0tfC0tLS0tLS0tLXwtLS0tLS0tLS0tfFxcblwiO1xuICBpZiAoZXZpZGVuY2VMaXN0Lmxlbmd0aCA+IDApIHtcbiAgICBldmlkZW5jZUxpc3QuZm9yRWFjaCgoZSwgaSkgPT4ge1xuICAgICAgY29uc3QgY29kZSA9IGUuZXhpdENvZGUgPz8gZS5leGl0X2NvZGUgPz8gMDtcbiAgICAgIGNvbnN0IGR1ciA9IGUuZHVyYXRpb25NcyA/PyBlLmR1cmF0aW9uX21zID8/IDA7XG4gICAgICBldmlkZW5jZVRhYmxlICs9IGB8ICR7aSArIDF9IHwgXFxgJHtlLmNvbW1hbmR9XFxgIHwgJHtjb2RlfSB8ICR7ZS52ZXJkaWN0fSB8ICR7ZHVyfW1zIHxcXG5gO1xuICAgIH0pO1xuICB9IGVsc2Uge1xuICAgIGV2aWRlbmNlVGFibGUgKz0gXCJ8IFxcdTIwMTQgfCBObyB2ZXJpZmljYXRpb24gY29tbWFuZHMgZGlzY292ZXJlZCB8IFxcdTIwMTQgfCBcXHUyMDE0IHwgXFx1MjAxNCB8XFxuXCI7XG4gIH1cblxuICBjb25zdCB0aXRsZSA9IHRhc2tSb3cub25lX2xpbmVyIHx8IHRhc2tSb3cudGl0bGUgfHwgdGFza1Jvdy5pZDtcblxuICByZXR1cm4gYC0tLVxuaWQ6ICR7dGFza1Jvdy5pZH1cbnBhcmVudDogJHtzbGljZUlkfVxubWlsZXN0b25lOiAke21pbGVzdG9uZUlkfVxua2V5X2ZpbGVzOiR7a2V5RmlsZXNZYW1sfVxua2V5X2RlY2lzaW9uczoke2tleURlY2lzaW9uc1lhbWx9XG5kdXJhdGlvbjogJHt0YXNrUm93LmR1cmF0aW9uIHx8IFwiXCJ9XG52ZXJpZmljYXRpb25fcmVzdWx0OiAke3ZlcmlmaWNhdGlvblJlc3VsdH1cbmNvbXBsZXRlZF9hdDogJHt0YXNrUm93LmNvbXBsZXRlZF9hdCB8fCBcIlwifVxuYmxvY2tlcl9kaXNjb3ZlcmVkOiAke3Rhc2tSb3cuYmxvY2tlcl9kaXNjb3ZlcmVkID8gXCJ0cnVlXCIgOiBcImZhbHNlXCJ9XG4tLS1cblxuIyAke3Rhc2tSb3cuaWR9OiAke3RpdGxlfVxuXG4qKiR7dGFza1Jvdy5vbmVfbGluZXIgfHwgXCJcIn0qKlxuXG4jIyBXaGF0IEhhcHBlbmVkXG5cbiR7dGFza1Jvdy5uYXJyYXRpdmUgfHwgXCJObyBzdW1tYXJ5IHJlY29yZGVkLlwifVxuXG4jIyBWZXJpZmljYXRpb25cblxuJHt0YXNrUm93LnZlcmlmaWNhdGlvbl9yZXN1bHQgfHwgXCJObyB2ZXJpZmljYXRpb24gcmVjb3JkZWQuXCJ9XG5cbiMjIFZlcmlmaWNhdGlvbiBFdmlkZW5jZVxuXG4ke2V2aWRlbmNlVGFibGV9XG4jIyBEZXZpYXRpb25zXG5cbiR7dGFza1Jvdy5kZXZpYXRpb25zIHx8IFwiTm9uZS5cIn1cblxuIyMgS25vd24gSXNzdWVzXG5cbiR7dGFza1Jvdy5rbm93bl9pc3N1ZXMgfHwgXCJOb25lLlwifVxuXG4jIyBGaWxlcyBDcmVhdGVkL01vZGlmaWVkXG5cbiR7dGFza1Jvdy5rZXlfZmlsZXMgJiYgdGFza1Jvdy5rZXlfZmlsZXMubGVuZ3RoID4gMCA/IHRhc2tSb3cua2V5X2ZpbGVzLm1hcChmID0+IGAtIFxcYCR7Zn1cXGBgKS5qb2luKFwiXFxuXCIpIDogXCJOb25lLlwifVxuYDtcbn1cblxuLyoqXG4gKiBSZW5kZXIgU1VNTUFSWS5tZCBwcm9qZWN0aW9uIHRvIGRpc2sgZm9yIGEgc3BlY2lmaWMgdGFzay5cbiAqIFF1ZXJpZXMgREIgdmlhIGhlbHBlciBmdW5jdGlvbnMsIHJlbmRlcnMgY29udGVudCwgd3JpdGVzIHZpYSBhdG9taWNXcml0ZVN5bmMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJTdW1tYXJ5UHJvamVjdGlvbihiYXNlUGF0aDogc3RyaW5nLCBtaWxlc3RvbmVJZDogc3RyaW5nLCBzbGljZUlkOiBzdHJpbmcsIHRhc2tJZDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHRhc2tSb3dzID0gZ2V0U2xpY2VUYXNrcyhtaWxlc3RvbmVJZCwgc2xpY2VJZCk7XG4gIGNvbnN0IHRhc2tSb3cgPSB0YXNrUm93cy5maW5kKHQgPT4gdC5pZCA9PT0gdGFza0lkKTtcbiAgaWYgKCF0YXNrUm93KSByZXR1cm47XG5cbiAgY29uc3QgZXZpZGVuY2VSb3dzID0gZ2V0VmVyaWZpY2F0aW9uRXZpZGVuY2UobWlsZXN0b25lSWQsIHNsaWNlSWQsIHRhc2tJZCk7XG4gIGNvbnN0IGNvbnRlbnQgPSByZW5kZXJTdW1tYXJ5Q29udGVudCh0YXNrUm93LCBzbGljZUlkLCBtaWxlc3RvbmVJZCwgZXZpZGVuY2VSb3dzKTtcbiAgY29uc3QgZGlyID0gam9pbihiYXNlUGF0aCwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBtaWxlc3RvbmVJZCwgXCJzbGljZXNcIiwgc2xpY2VJZCwgXCJ0YXNrc1wiKTtcbiAgbWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGF0b21pY1dyaXRlU3luYyhqb2luKGRpciwgYCR7dGFza0lkfS1TVU1NQVJZLm1kYCksIGNvbnRlbnQpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU1RBVEUubWQgUHJvamVjdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBSZW5kZXIgU1RBVEUubWQgY29udGVudCBmcm9tIEdTRFN0YXRlLlxuICogTWF0Y2hlcyB0aGUgYnVpbGRTdGF0ZU1hcmtkb3duIG91dHB1dCBmb3JtYXQgZnJvbSBkb2N0b3IudHMgZXhhY3RseS5cbiAqIFB1cmUgZnVuY3Rpb24gXHUyMDE0IG5vIHNpZGUgZWZmZWN0cy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlclN0YXRlQ29udGVudChzdGF0ZTogR1NEU3RhdGUpOiBzdHJpbmcge1xuICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcbiAgbGluZXMucHVzaChcIiMgR1NEIFN0YXRlXCIsIFwiXCIpO1xuXG4gIGNvbnN0IGFjdGl2ZVNsaWNlID0gc3RhdGUuYWN0aXZlU2xpY2VcbiAgICA/IGAke3N0YXRlLmFjdGl2ZVNsaWNlLmlkfTogJHtzdHJpcElkUHJlZml4KHN0YXRlLmFjdGl2ZVNsaWNlLnRpdGxlLCBzdGF0ZS5hY3RpdmVTbGljZS5pZCl9YFxuICAgIDogXCJOb25lXCI7XG5cbiAgaWYgKHN0YXRlLnBoYXNlID09PSAnY29tcGxldGUnICYmIHN0YXRlLmxhc3RDb21wbGV0ZWRNaWxlc3RvbmUpIHtcbiAgICBsaW5lcy5wdXNoKGAqKkxhc3QgQ29tcGxldGVkIE1pbGVzdG9uZToqKiAke3N0YXRlLmxhc3RDb21wbGV0ZWRNaWxlc3RvbmUuaWR9OiAke3N0YXRlLmxhc3RDb21wbGV0ZWRNaWxlc3RvbmUudGl0bGV9YCk7XG4gIH0gZWxzZSB7XG4gICAgY29uc3QgYWN0aXZlTWlsZXN0b25lID0gc3RhdGUuYWN0aXZlTWlsZXN0b25lXG4gICAgICA/IGAke3N0YXRlLmFjdGl2ZU1pbGVzdG9uZS5pZH06ICR7c3RyaXBJZFByZWZpeChzdGF0ZS5hY3RpdmVNaWxlc3RvbmUudGl0bGUsIHN0YXRlLmFjdGl2ZU1pbGVzdG9uZS5pZCl9YFxuICAgICAgOiBcIk5vbmVcIjtcbiAgICBsaW5lcy5wdXNoKGAqKkFjdGl2ZSBNaWxlc3RvbmU6KiogJHthY3RpdmVNaWxlc3RvbmV9YCk7XG4gIH1cbiAgbGluZXMucHVzaChgKipBY3RpdmUgU2xpY2U6KiogJHthY3RpdmVTbGljZX1gKTtcbiAgbGluZXMucHVzaChgKipQaGFzZToqKiAke3N0YXRlLnBoYXNlfWApO1xuICBpZiAoc3RhdGUucmVxdWlyZW1lbnRzKSB7XG4gICAgbGluZXMucHVzaChgKipSZXF1aXJlbWVudHMgU3RhdHVzOioqICR7c3RhdGUucmVxdWlyZW1lbnRzLmFjdGl2ZX0gYWN0aXZlIFxcdTAwYjcgJHtzdGF0ZS5yZXF1aXJlbWVudHMudmFsaWRhdGVkfSB2YWxpZGF0ZWQgXFx1MDBiNyAke3N0YXRlLnJlcXVpcmVtZW50cy5kZWZlcnJlZH0gZGVmZXJyZWQgXFx1MDBiNyAke3N0YXRlLnJlcXVpcmVtZW50cy5vdXRPZlNjb3BlfSBvdXQgb2Ygc2NvcGVgKTtcbiAgfVxuICBsaW5lcy5wdXNoKFwiXCIpO1xuICBsaW5lcy5wdXNoKFwiIyMgTWlsZXN0b25lIFJlZ2lzdHJ5XCIpO1xuXG4gIGZvciAoY29uc3QgZW50cnkgb2Ygc3RhdGUucmVnaXN0cnkpIHtcbiAgICBjb25zdCBnbHlwaCA9IGVudHJ5LnN0YXR1cyA9PT0gXCJjb21wbGV0ZVwiID8gXCJcXHUyNzA1XCIgOiBlbnRyeS5zdGF0dXMgPT09IFwiYWN0aXZlXCIgPyBcIlxcdUQ4M0RcXHVERDA0XCIgOiBlbnRyeS5zdGF0dXMgPT09IFwicGFya2VkXCIgPyBcIlxcdTIzRjhcXHVGRTBGXCIgOiBcIlxcdTJCMUNcIjtcbiAgICBsaW5lcy5wdXNoKGAtICR7Z2x5cGh9ICoqJHtlbnRyeS5pZH06KiogJHtzdHJpcElkUHJlZml4KGVudHJ5LnRpdGxlLCBlbnRyeS5pZCl9YCk7XG4gIH1cblxuICBsaW5lcy5wdXNoKFwiXCIpO1xuICBsaW5lcy5wdXNoKFwiIyMgUmVjZW50IERlY2lzaW9uc1wiKTtcbiAgaWYgKHN0YXRlLnJlY2VudERlY2lzaW9ucy5sZW5ndGggPiAwKSB7XG4gICAgZm9yIChjb25zdCBkZWNpc2lvbiBvZiBzdGF0ZS5yZWNlbnREZWNpc2lvbnMpIGxpbmVzLnB1c2goYC0gJHtkZWNpc2lvbn1gKTtcbiAgfSBlbHNlIHtcbiAgICBsaW5lcy5wdXNoKFwiLSBOb25lIHJlY29yZGVkXCIpO1xuICB9XG5cbiAgbGluZXMucHVzaChcIlwiKTtcbiAgbGluZXMucHVzaChcIiMjIEJsb2NrZXJzXCIpO1xuICBpZiAoc3RhdGUuYmxvY2tlcnMubGVuZ3RoID4gMCkge1xuICAgIGZvciAoY29uc3QgYmxvY2tlciBvZiBzdGF0ZS5ibG9ja2VycykgbGluZXMucHVzaChgLSAke2Jsb2NrZXJ9YCk7XG4gIH0gZWxzZSB7XG4gICAgbGluZXMucHVzaChcIi0gTm9uZVwiKTtcbiAgfVxuXG4gIGxpbmVzLnB1c2goXCJcIik7XG4gIGxpbmVzLnB1c2goXCIjIyBOZXh0IEFjdGlvblwiKTtcbiAgbGluZXMucHVzaChzdGF0ZS5uZXh0QWN0aW9uIHx8IFwiTm9uZVwiKTtcbiAgbGluZXMucHVzaChcIlwiKTtcblxuICByZXR1cm4gbGluZXMuam9pbihcIlxcblwiKTtcbn1cblxuLyoqXG4gKiBSZW5kZXIgU1RBVEUubWQgcHJvamVjdGlvbiB0byBkaXNrLlxuICogRGVyaXZlcyBzdGF0ZSBmcm9tIERCLCByZW5kZXJzIGNvbnRlbnQsIHdyaXRlcyB2aWEgYXRvbWljV3JpdGVTeW5jLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVuZGVyU3RhdGVQcm9qZWN0aW9uKGJhc2VQYXRoOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgdHJ5IHtcbiAgICBpZiAoIWlzRGJBdmFpbGFibGUoKSkgcmV0dXJuO1xuICAgIC8vIFByb2JlIERCIGhhbmRsZSBcdTIwMTQgYWRhcHRlciBtYXkgYmUgc2V0IGJ1dCB1bmRlcmx5aW5nIGhhbmRsZSBjbG9zZWRcbiAgICBjb25zdCBhZGFwdGVyID0gX2dldEFkYXB0ZXIoKTtcbiAgICBpZiAoIWFkYXB0ZXIpIHJldHVybjtcbiAgICB0cnkge1xuICAgICAgYWRhcHRlci5wcmVwYXJlKFwiU0VMRUNUIDFcIikuZ2V0KCk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBsb2dXYXJuaW5nKFwicHJvamVjdGlvblwiLCBcInJlbmRlclN0YXRlUHJvamVjdGlvbjogREIgaGFuZGxlIHByb2JlIGZhaWxlZCwgc2tpcHBpbmcgcmVuZGVyXCIsIHtcbiAgICAgICAgZXJyb3I6IChlcnIgYXMgRXJyb3IpLm1lc3NhZ2UsXG4gICAgICB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlUGF0aCk7XG4gICAgY29uc3QgY29udGVudCA9IHJlbmRlclN0YXRlQ29udGVudChzdGF0ZSk7XG4gICAgY29uc3QgZGlyID0gam9pbihiYXNlUGF0aCwgXCIuZ3NkXCIpO1xuICAgIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIGF0b21pY1dyaXRlU3luYyhqb2luKGRpciwgXCJTVEFURS5tZFwiKSwgY29udGVudCk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGxvZ1dhcm5pbmcoXCJwcm9qZWN0aW9uXCIsIGByZW5kZXJTdGF0ZVByb2plY3Rpb24gZmFpbGVkOiAkeyhlcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHJlbmRlckFsbFByb2plY3Rpb25zIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFJlZ2VuZXJhdGUgYWxsIHByb2plY3Rpb24gZmlsZXMgZm9yIGEgbWlsZXN0b25lIGZyb20gREIgc3RhdGUuXG4gKiBBbGwgY2FsbHMgYXJlIHdyYXBwZWQgaW4gdHJ5L2NhdGNoIFx1MjAxNCBwcm9qZWN0aW9uIGZhaWx1cmUgaXMgbm9uLWZhdGFsIHBlciBELTAyLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVuZGVyQWxsUHJvamVjdGlvbnMoYmFzZVBhdGg6IHN0cmluZywgbWlsZXN0b25lSWQ6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICAvLyBEZWxlZ2F0ZSB0byB0aGUgYXV0aG9yaXRhdGl2ZSByb2FkbWFwIHJlbmRlcmVyIFx1MjAxNCB0aGUgcmVkdWNlZFxuICAvLyByZW5kZXJSb2FkbWFwUHJvamVjdGlvbiBvbWl0cyBzZWN0aW9ucyBsaWtlICMjIEJvdW5kYXJ5IE1hcCBhbmQgd291bGRcbiAgLy8gY2xvYmJlciB0aGUgb3V0cHV0IHdyaXR0ZW4gYnkgcGxhbi1taWxlc3RvbmUgLyByZWFzc2Vzcy1yb2FkbWFwLlxuICB0cnkge1xuICAgIGF3YWl0IHJlbmRlclJvYWRtYXBGcm9tRGIoYmFzZVBhdGgsIG1pbGVzdG9uZUlkKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgbG9nV2FybmluZyhcInByb2plY3Rpb25cIiwgYHJlbmRlclJvYWRtYXBGcm9tRGIgZmFpbGVkIGZvciAke21pbGVzdG9uZUlkfTogJHsoZXJyIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuICB9XG5cbiAgLy8gUXVlcnkgYWxsIHNsaWNlcyBmb3IgdGhpcyBtaWxlc3RvbmVcbiAgY29uc3Qgc2xpY2VSb3dzID0gZ2V0TWlsZXN0b25lU2xpY2VzKG1pbGVzdG9uZUlkKTtcblxuICBmb3IgKGNvbnN0IHNsaWNlIG9mIHNsaWNlUm93cykge1xuICAgIC8vIFBMQU4ubWQgaXMgcmVuZGVyZWQgYnkgdGhlIGF1dGhvcml0YXRpdmUgbWFya2Rvd24tcmVuZGVyZXIuanMgaW5cbiAgICAvLyBwbGFuLXNsaWNlL3JlcGxhbi1zbGljZSB0b29scy4gRG8gTk9UIG92ZXJ3cml0ZSBpdCBoZXJlIFx1MjAxNCB0aGUgc2ltcGxpZmllZFxuICAgIC8vIHByb2plY3Rpb24gaXMgbWlzc2luZyBrZXkgc2VjdGlvbnMgKE11c3QtSGF2ZXMsIFZlcmlmaWNhdGlvbiwgRmlsZXNcbiAgICAvLyBMaWtlbHkgVG91Y2hlZCkgYW5kIGNvcnJ1cHRzIG11bHRpLWxpbmUgdGFzayBkZXNjcmlwdGlvbnMgKCMzNjUxKS5cblxuICAgIC8vIFJlbmRlciBTVU1NQVJZLm1kIGZvciBlYWNoIGNvbXBsZXRlZCB0YXNrXG4gICAgY29uc3QgdGFza1Jvd3MgPSBnZXRTbGljZVRhc2tzKG1pbGVzdG9uZUlkLCBzbGljZS5pZCk7XG4gICAgY29uc3QgZG9uZVRhc2tzID0gdGFza1Jvd3MuZmlsdGVyKHQgPT4gdC5zdGF0dXMgPT09IFwiZG9uZVwiIHx8IHQuc3RhdHVzID09PSBcImNvbXBsZXRlXCIpO1xuXG4gICAgZm9yIChjb25zdCB0YXNrIG9mIGRvbmVUYXNrcykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgcmVuZGVyU3VtbWFyeVByb2plY3Rpb24oYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBzbGljZS5pZCwgdGFzay5pZCk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgbG9nV2FybmluZyhcInByb2plY3Rpb25cIiwgYHJlbmRlclN1bW1hcnlQcm9qZWN0aW9uIGZhaWxlZCBmb3IgJHttaWxlc3RvbmVJZH0vJHtzbGljZS5pZH0vJHt0YXNrLmlkfTogJHsoZXJyIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8vIFJlbmRlciBTVEFURS5tZFxuICB0cnkge1xuICAgIGF3YWl0IHJlbmRlclN0YXRlUHJvamVjdGlvbihiYXNlUGF0aCk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGxvZ1dhcm5pbmcoXCJwcm9qZWN0aW9uXCIsIGByZW5kZXJTdGF0ZVByb2plY3Rpb24gZmFpbGVkOiAkeyhlcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHJlZ2VuZXJhdGVJZk1pc3NpbmcgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogQ2hlY2sgaWYgYSBwcm9qZWN0aW9uIGZpbGUgZXhpc3RzIG9uIGRpc2suIElmIG1pc3NpbmcsIHJlZ2VuZXJhdGUgaXQgZnJvbSBEQi5cbiAqIFJldHVybnMgdHJ1ZSBpZiB0aGUgZmlsZSB3YXMgcmVnZW5lcmF0ZWQsIGZhbHNlIGlmIGl0IGFscmVhZHkgZXhpc3RlZCBvclxuICogcmVnZW5lcmF0aW9uIGZhaWxlZC5cbiAqIFNhdGlzZmllcyBQUk9KLTA1IChjb3JydXB0ZWQvZGVsZXRlZCBwcm9qZWN0aW9ucyByZWdlbmVyYXRlIG9uIGRlbWFuZCkuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWdlbmVyYXRlSWZNaXNzaW5nKFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICBtaWxlc3RvbmVJZDogc3RyaW5nLFxuICBzbGljZUlkOiBzdHJpbmcsXG4gIGZpbGVUeXBlOiBcIlBMQU5cIiB8IFwiUk9BRE1BUFwiIHwgXCJTVU1NQVJZXCIgfCBcIlNUQVRFXCIsXG4pOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgbGV0IGZpbGVQYXRoOiBzdHJpbmc7XG5cbiAgc3dpdGNoIChmaWxlVHlwZSkge1xuICAgIGNhc2UgXCJQTEFOXCI6XG4gICAgICBmaWxlUGF0aCA9IGpvaW4oYmFzZVBhdGgsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgbWlsZXN0b25lSWQsIFwic2xpY2VzXCIsIHNsaWNlSWQsIGAke3NsaWNlSWR9LVBMQU4ubWRgKTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJST0FETUFQXCI6XG4gICAgICBmaWxlUGF0aCA9IGpvaW4oYmFzZVBhdGgsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgbWlsZXN0b25lSWQsIGAke21pbGVzdG9uZUlkfS1ST0FETUFQLm1kYCk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwiU1VNTUFSWVwiOlxuICAgICAgLy8gRm9yIFNVTU1BUlksIHdlIHJlZ2VuZXJhdGUgYWxsIHRhc2sgc3VtbWFyaWVzIGluIHRoZSBzbGljZVxuICAgICAgZmlsZVBhdGggPSBqb2luKGJhc2VQYXRoLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIG1pbGVzdG9uZUlkLCBcInNsaWNlc1wiLCBzbGljZUlkLCBcInRhc2tzXCIpO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcIlNUQVRFXCI6XG4gICAgICBmaWxlUGF0aCA9IGpvaW4oYmFzZVBhdGgsIFwiLmdzZFwiLCBcIlNUQVRFLm1kXCIpO1xuICAgICAgYnJlYWs7XG4gIH1cblxuICBpZiAoZmlsZVR5cGUgPT09IFwiU1VNTUFSWVwiKSB7XG4gICAgLy8gQ2hlY2sgZWFjaCBjb21wbGV0ZWQgdGFzaydzIFNVTU1BUlkgZmlsZSBpbmRpdmlkdWFsbHkgKG5vdCBqdXN0IHRoZSBkaXJlY3RvcnkpXG4gICAgY29uc3QgdGFza1Jvd3MgPSBnZXRTbGljZVRhc2tzKG1pbGVzdG9uZUlkLCBzbGljZUlkKTtcbiAgICBjb25zdCBkb25lVGFza3MgPSB0YXNrUm93cy5maWx0ZXIodCA9PiB0LnN0YXR1cyA9PT0gXCJkb25lXCIgfHwgdC5zdGF0dXMgPT09IFwiY29tcGxldGVcIik7XG4gICAgbGV0IHJlZ2VuZXJhdGVkID0gMDtcbiAgICBmb3IgKGNvbnN0IHRhc2sgb2YgZG9uZVRhc2tzKSB7XG4gICAgICBjb25zdCBzdW1tYXJ5UGF0aCA9IGpvaW4oYmFzZVBhdGgsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgbWlsZXN0b25lSWQsIFwic2xpY2VzXCIsIHNsaWNlSWQsIFwidGFza3NcIiwgYCR7dGFzay5pZH0tU1VNTUFSWS5tZGApO1xuICAgICAgaWYgKCFleGlzdHNTeW5jKHN1bW1hcnlQYXRoKSkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHJlbmRlclN1bW1hcnlQcm9qZWN0aW9uKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgc2xpY2VJZCwgdGFzay5pZCk7XG4gICAgICAgICAgcmVnZW5lcmF0ZWQrKztcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgbG9nV2FybmluZyhcInByb2plY3Rpb25cIiwgYHJlZ2VuZXJhdGVJZk1pc3NpbmcgU1VNTUFSWSBmYWlsZWQgZm9yICR7dGFzay5pZH06ICR7KGVyciBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gcmVnZW5lcmF0ZWQgPiAwO1xuICB9XG5cbiAgaWYgKGV4aXN0c1N5bmMoZmlsZVBhdGgpKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgLy8gUmVnZW5lcmF0ZSB0aGUgbWlzc2luZyBmaWxlLiBFYWNoIHJlbmRlcmVyIG1heSBzd2FsbG93IGl0cyBvd24gZXJyb3JzXG4gIC8vIChlLmcuIHJlbmRlclN0YXRlUHJvamVjdGlvbiksIHNvIGNvbmZpcm0gdGhlIGZpbGUgYWN0dWFsbHkgZXhpc3RzIG9uXG4gIC8vIGRpc2sgYmVmb3JlIHJlcG9ydGluZyBzdWNjZXNzIFx1MjAxNCB0cnVlIG11c3QgbWVhbiBcImZpbGUgaXMgdGhlcmUgbm93XCIuXG4gIHRyeSB7XG4gICAgc3dpdGNoIChmaWxlVHlwZSkge1xuICAgICAgY2FzZSBcIlBMQU5cIjpcbiAgICAgICAgcmVuZGVyUGxhblByb2plY3Rpb24oYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBzbGljZUlkKTtcbiAgICAgICAgcmV0dXJuIGV4aXN0c1N5bmMoZmlsZVBhdGgpO1xuICAgICAgY2FzZSBcIlJPQURNQVBcIjpcbiAgICAgICAgYXdhaXQgcmVuZGVyUm9hZG1hcEZyb21EYihiYXNlUGF0aCwgbWlsZXN0b25lSWQpO1xuICAgICAgICByZXR1cm4gZXhpc3RzU3luYyhmaWxlUGF0aCk7XG4gICAgICBjYXNlIFwiU1RBVEVcIjpcbiAgICAgICAgYXdhaXQgcmVuZGVyU3RhdGVQcm9qZWN0aW9uKGJhc2VQYXRoKTtcbiAgICAgICAgcmV0dXJuIGV4aXN0c1N5bmMoZmlsZVBhdGgpO1xuICAgIH1cbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgbG9nV2FybmluZyhcInByb2plY3Rpb25cIiwgYHJlZ2VuZXJhdGVJZk1pc3NpbmcgJHtmaWxlVHlwZX0gZmFpbGVkOiAkeyhlcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFNQTtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFFQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFJUCxTQUFTLHVCQUF1QjtBQUNoQyxTQUFTLFlBQVk7QUFDckIsU0FBUyxXQUFXLGtCQUFrQjtBQUN0QyxTQUFTLGtCQUFrQjtBQUMzQixTQUFTLHNCQUFzQjtBQUMvQixTQUFTLG1CQUFtQjtBQUU1QixTQUFTLDJCQUEyQjtBQVM3QixTQUFTLGNBQWMsT0FBZSxJQUFvQjtBQUMvRCxRQUFNLFNBQVMsR0FBRyxFQUFFO0FBQ3BCLE1BQUksU0FBUztBQUNiLFNBQU8sT0FBTyxXQUFXLE1BQU0sR0FBRztBQUNoQyxhQUFTLE9BQU8sTUFBTSxPQUFPLE1BQU07QUFBQSxFQUNyQztBQUNBLFNBQU8sT0FBTyxLQUFLLEtBQUs7QUFDMUI7QUFRTyxTQUFTLGtCQUFrQixVQUFvQixVQUE2QjtBQUNqRixRQUFNLFFBQWtCLENBQUM7QUFFekIsUUFBTSxlQUFlLGNBQWMsU0FBUyxPQUFPLFNBQVMsRUFBRTtBQUM5RCxRQUFNLEtBQUssS0FBSyxTQUFTLEVBQUUsS0FBSyxZQUFZLEVBQUU7QUFDOUMsUUFBTSxLQUFLLEVBQUU7QUFHYixRQUFNLEtBQUssYUFBYSxTQUFTLFFBQVEsS0FBSyxFQUFFO0FBQ2hELFFBQU0sS0FBSyx5QkFBeUIsU0FBUyxRQUFRLEtBQUssRUFBRTtBQUM1RCxRQUFNLEtBQUssRUFBRTtBQUNiLFFBQU0sS0FBSyxVQUFVO0FBRXJCLGFBQVcsUUFBUSxVQUFVO0FBQzNCLFVBQU0sV0FBVyxlQUFlLEtBQUssTUFBTSxJQUFJLFFBQVE7QUFDdkQsVUFBTSxLQUFLLEtBQUssUUFBUSxNQUFNLEtBQUssRUFBRSxLQUFLLEtBQUssS0FBSyxhQUFhLEtBQUssV0FBVyxFQUFFO0FBR25GLFFBQUksS0FBSyxVQUFVO0FBQ2pCLFlBQU0sS0FBSyxpQkFBaUIsS0FBSyxRQUFRLEVBQUU7QUFBQSxJQUM3QztBQUdBLFFBQUksS0FBSyxTQUFTLEtBQUssTUFBTSxTQUFTLEdBQUc7QUFDdkMsWUFBTSxLQUFLLGNBQWMsS0FBSyxNQUFNLEtBQUssSUFBSSxDQUFDLEVBQUU7QUFBQSxJQUNsRDtBQUdBLFFBQUksS0FBSyxRQUFRO0FBQ2YsWUFBTSxLQUFLLGVBQWUsS0FBSyxNQUFNLEVBQUU7QUFBQSxJQUN6QztBQUdBLFFBQUksS0FBSyxVQUFVO0FBQ2pCLFlBQU0sS0FBSyxpQkFBaUIsS0FBSyxRQUFRLEVBQUU7QUFBQSxJQUM3QztBQUdBLFFBQUksS0FBSyxzQkFBc0IsS0FBSyxjQUFjO0FBQ2hELFlBQU0sS0FBSyxnQkFBZ0IsS0FBSyxZQUFZLEVBQUU7QUFBQSxJQUNoRDtBQUFBLEVBQ0Y7QUFFQSxRQUFNLEtBQUssRUFBRTtBQUNiLFNBQU8sTUFBTSxLQUFLLElBQUk7QUFDeEI7QUFNTyxTQUFTLHFCQUFxQixVQUFrQixhQUFxQixTQUF1QjtBQUNqRyxRQUFNLFlBQVksbUJBQW1CLFdBQVc7QUFDaEQsUUFBTSxXQUFXLFVBQVUsS0FBSyxPQUFLLEVBQUUsT0FBTyxPQUFPO0FBQ3JELE1BQUksQ0FBQyxTQUFVO0FBRWYsUUFBTSxXQUFXLGNBQWMsYUFBYSxPQUFPO0FBRW5ELFFBQU0sVUFBVSxrQkFBa0IsVUFBVSxRQUFRO0FBQ3BELFFBQU0sTUFBTSxLQUFLLFVBQVUsUUFBUSxjQUFjLGFBQWEsVUFBVSxPQUFPO0FBQy9FLFlBQVUsS0FBSyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ2xDLGtCQUFnQixLQUFLLEtBQUssR0FBRyxPQUFPLFVBQVUsR0FBRyxPQUFPO0FBQzFEO0FBUU8sU0FBUyxxQkFBcUIsY0FBNEIsV0FBK0I7QUFDOUYsUUFBTSxRQUFrQixDQUFDO0FBRXpCLFFBQU0sZUFBZSxjQUFjLGFBQWEsT0FBTyxhQUFhLEVBQUU7QUFDdEUsUUFBTSxLQUFLLEtBQUssYUFBYSxFQUFFLEtBQUssWUFBWSxFQUFFO0FBQ2xELFFBQU0sS0FBSyxFQUFFO0FBQ2IsUUFBTSxLQUFLLFdBQVc7QUFDdEIsUUFBTSxLQUFLLGFBQWEsVUFBVSxhQUFhLFNBQVMsS0FBSztBQUM3RCxRQUFNLEtBQUssRUFBRTtBQUNiLFFBQU0sS0FBSyxtQkFBbUI7QUFDOUIsUUFBTSxLQUFLLHFEQUFxRDtBQUNoRSxRQUFNLEtBQUsscURBQXFEO0FBRWhFLGFBQVcsU0FBUyxXQUFXO0FBQzdCLFVBQU0sT0FBTyxlQUFlLE1BQU0sTUFBTSxJQUFJLFdBQVc7QUFHdkQsUUFBSSxVQUFVO0FBQ2QsUUFBSSxNQUFNLFdBQVcsTUFBTSxRQUFRLFNBQVMsR0FBRztBQUM3QyxnQkFBVSxNQUFNLFFBQVEsS0FBSyxJQUFJO0FBQUEsSUFDbkM7QUFFQSxVQUFNLFFBQVEsTUFBTSxRQUFRLE9BQU8sWUFBWTtBQUkvQyxVQUFNLE9BQU8sTUFBTSxRQUFRO0FBRTNCLFVBQU0sS0FBSyxLQUFLLE1BQU0sRUFBRSxNQUFNLE1BQU0sS0FBSyxNQUFNLElBQUksTUFBTSxPQUFPLE1BQU0sSUFBSSxNQUFNLElBQUksSUFBSTtBQUFBLEVBQzFGO0FBRUEsUUFBTSxLQUFLLEVBQUU7QUFDYixTQUFPLE1BQU0sS0FBSyxJQUFJO0FBQ3hCO0FBTU8sU0FBUyx3QkFBd0IsVUFBa0IsYUFBMkI7QUFDbkYsUUFBTSxlQUFlLGFBQWEsV0FBVztBQUM3QyxNQUFJLENBQUMsYUFBYztBQUVuQixRQUFNLFlBQVksbUJBQW1CLFdBQVc7QUFFaEQsUUFBTSxVQUFVLHFCQUFxQixjQUFjLFNBQVM7QUFDNUQsUUFBTSxNQUFNLEtBQUssVUFBVSxRQUFRLGNBQWMsV0FBVztBQUM1RCxZQUFVLEtBQUssRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNsQyxrQkFBZ0IsS0FBSyxLQUFLLEdBQUcsV0FBVyxhQUFhLEdBQUcsT0FBTztBQUNqRTtBQWFPLFNBQVMscUJBQ2QsU0FDQSxTQUNBLGFBQ0EsVUFDUTtBQUtSLE1BQUksUUFBUSxtQkFBbUIsUUFBUSxnQkFBZ0IsVUFBVSxFQUFFLFdBQVcsS0FBSyxHQUFHO0FBQ3BGLFdBQU8sUUFBUTtBQUFBLEVBQ2pCO0FBR0EsUUFBTSxlQUFlLFFBQVEsYUFBYSxRQUFRLFVBQVUsU0FBUyxJQUNqRTtBQUFBLEVBQUssUUFBUSxVQUFVLElBQUksT0FBSyxPQUFPLENBQUMsRUFBRSxFQUFFLEtBQUssSUFBSSxDQUFDLEtBQ3REO0FBQ0osUUFBTSxtQkFBbUIsUUFBUSxpQkFBaUIsUUFBUSxjQUFjLFNBQVMsSUFDN0U7QUFBQSxFQUFLLFFBQVEsY0FBYyxJQUFJLE9BQUssT0FBTyxDQUFDLEVBQUUsRUFBRSxLQUFLLElBQUksQ0FBQyxLQUMxRDtBQUdKLFFBQU0sZUFBZSxZQUFZLENBQUM7QUFDbEMsUUFBTSxZQUFZLGFBQWEsU0FBUyxLQUN0QyxhQUFhLE1BQU0sT0FBSztBQUN0QixVQUFNLE9BQU8sRUFBRSxZQUFZLEVBQUUsYUFBYTtBQUMxQyxXQUFPLFNBQVMsS0FBSyxFQUFFLFFBQVEsU0FBUyxRQUFRLEtBQUssRUFBRSxRQUFRLFlBQVksRUFBRSxTQUFTLE1BQU07QUFBQSxFQUM5RixDQUFDO0FBQ0gsUUFBTSxxQkFBcUIsUUFBUSxzQkFDOUIsWUFBWSxXQUFZLGFBQWEsV0FBVyxJQUFJLGFBQWEsVUFDakUsWUFBWSxXQUFZLGFBQWEsV0FBVyxJQUFJLGFBQWE7QUFHdEUsTUFBSSxnQkFBZ0I7QUFDcEIsTUFBSSxhQUFhLFNBQVMsR0FBRztBQUMzQixpQkFBYSxRQUFRLENBQUMsR0FBRyxNQUFNO0FBQzdCLFlBQU0sT0FBTyxFQUFFLFlBQVksRUFBRSxhQUFhO0FBQzFDLFlBQU0sTUFBTSxFQUFFLGNBQWMsRUFBRSxlQUFlO0FBQzdDLHVCQUFpQixLQUFLLElBQUksQ0FBQyxRQUFRLEVBQUUsT0FBTyxRQUFRLElBQUksTUFBTSxFQUFFLE9BQU8sTUFBTSxHQUFHO0FBQUE7QUFBQSxJQUNsRixDQUFDO0FBQUEsRUFDSCxPQUFPO0FBQ0wscUJBQWlCO0FBQUEsRUFDbkI7QUFFQSxRQUFNLFFBQVEsUUFBUSxhQUFhLFFBQVEsU0FBUyxRQUFRO0FBRTVELFNBQU87QUFBQSxNQUNILFFBQVEsRUFBRTtBQUFBLFVBQ04sT0FBTztBQUFBLGFBQ0osV0FBVztBQUFBLFlBQ1osWUFBWTtBQUFBLGdCQUNSLGdCQUFnQjtBQUFBLFlBQ3BCLFFBQVEsWUFBWSxFQUFFO0FBQUEsdUJBQ1gsa0JBQWtCO0FBQUEsZ0JBQ3pCLFFBQVEsZ0JBQWdCLEVBQUU7QUFBQSxzQkFDcEIsUUFBUSxxQkFBcUIsU0FBUyxPQUFPO0FBQUE7QUFBQTtBQUFBLElBRy9ELFFBQVEsRUFBRSxLQUFLLEtBQUs7QUFBQTtBQUFBLElBRXBCLFFBQVEsYUFBYSxFQUFFO0FBQUE7QUFBQTtBQUFBO0FBQUEsRUFJekIsUUFBUSxhQUFhLHNCQUFzQjtBQUFBO0FBQUE7QUFBQTtBQUFBLEVBSTNDLFFBQVEsdUJBQXVCLDJCQUEyQjtBQUFBO0FBQUE7QUFBQTtBQUFBLEVBSTFELGFBQWE7QUFBQTtBQUFBO0FBQUEsRUFHYixRQUFRLGNBQWMsT0FBTztBQUFBO0FBQUE7QUFBQTtBQUFBLEVBSTdCLFFBQVEsZ0JBQWdCLE9BQU87QUFBQTtBQUFBO0FBQUE7QUFBQSxFQUkvQixRQUFRLGFBQWEsUUFBUSxVQUFVLFNBQVMsSUFBSSxRQUFRLFVBQVUsSUFBSSxPQUFLLE9BQU8sQ0FBQyxJQUFJLEVBQUUsS0FBSyxJQUFJLElBQUksT0FBTztBQUFBO0FBRW5IO0FBTU8sU0FBUyx3QkFBd0IsVUFBa0IsYUFBcUIsU0FBaUIsUUFBc0I7QUFDcEgsUUFBTSxXQUFXLGNBQWMsYUFBYSxPQUFPO0FBQ25ELFFBQU0sVUFBVSxTQUFTLEtBQUssT0FBSyxFQUFFLE9BQU8sTUFBTTtBQUNsRCxNQUFJLENBQUMsUUFBUztBQUVkLFFBQU0sZUFBZSx3QkFBd0IsYUFBYSxTQUFTLE1BQU07QUFDekUsUUFBTSxVQUFVLHFCQUFxQixTQUFTLFNBQVMsYUFBYSxZQUFZO0FBQ2hGLFFBQU0sTUFBTSxLQUFLLFVBQVUsUUFBUSxjQUFjLGFBQWEsVUFBVSxTQUFTLE9BQU87QUFDeEYsWUFBVSxLQUFLLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDbEMsa0JBQWdCLEtBQUssS0FBSyxHQUFHLE1BQU0sYUFBYSxHQUFHLE9BQU87QUFDNUQ7QUFTTyxTQUFTLG1CQUFtQixPQUF5QjtBQUMxRCxRQUFNLFFBQWtCLENBQUM7QUFDekIsUUFBTSxLQUFLLGVBQWUsRUFBRTtBQUU1QixRQUFNLGNBQWMsTUFBTSxjQUN0QixHQUFHLE1BQU0sWUFBWSxFQUFFLEtBQUssY0FBYyxNQUFNLFlBQVksT0FBTyxNQUFNLFlBQVksRUFBRSxDQUFDLEtBQ3hGO0FBRUosTUFBSSxNQUFNLFVBQVUsY0FBYyxNQUFNLHdCQUF3QjtBQUM5RCxVQUFNLEtBQUssaUNBQWlDLE1BQU0sdUJBQXVCLEVBQUUsS0FBSyxNQUFNLHVCQUF1QixLQUFLLEVBQUU7QUFBQSxFQUN0SCxPQUFPO0FBQ0wsVUFBTSxrQkFBa0IsTUFBTSxrQkFDMUIsR0FBRyxNQUFNLGdCQUFnQixFQUFFLEtBQUssY0FBYyxNQUFNLGdCQUFnQixPQUFPLE1BQU0sZ0JBQWdCLEVBQUUsQ0FBQyxLQUNwRztBQUNKLFVBQU0sS0FBSyx5QkFBeUIsZUFBZSxFQUFFO0FBQUEsRUFDdkQ7QUFDQSxRQUFNLEtBQUsscUJBQXFCLFdBQVcsRUFBRTtBQUM3QyxRQUFNLEtBQUssY0FBYyxNQUFNLEtBQUssRUFBRTtBQUN0QyxNQUFJLE1BQU0sY0FBYztBQUN0QixVQUFNLEtBQUssNEJBQTRCLE1BQU0sYUFBYSxNQUFNLGdCQUFrQixNQUFNLGFBQWEsU0FBUyxtQkFBcUIsTUFBTSxhQUFhLFFBQVEsa0JBQW9CLE1BQU0sYUFBYSxVQUFVLGVBQWU7QUFBQSxFQUNoTztBQUNBLFFBQU0sS0FBSyxFQUFFO0FBQ2IsUUFBTSxLQUFLLHVCQUF1QjtBQUVsQyxhQUFXLFNBQVMsTUFBTSxVQUFVO0FBQ2xDLFVBQU0sUUFBUSxNQUFNLFdBQVcsYUFBYSxXQUFXLE1BQU0sV0FBVyxXQUFXLGNBQWlCLE1BQU0sV0FBVyxXQUFXLGlCQUFpQjtBQUNqSixVQUFNLEtBQUssS0FBSyxLQUFLLE1BQU0sTUFBTSxFQUFFLE9BQU8sY0FBYyxNQUFNLE9BQU8sTUFBTSxFQUFFLENBQUMsRUFBRTtBQUFBLEVBQ2xGO0FBRUEsUUFBTSxLQUFLLEVBQUU7QUFDYixRQUFNLEtBQUsscUJBQXFCO0FBQ2hDLE1BQUksTUFBTSxnQkFBZ0IsU0FBUyxHQUFHO0FBQ3BDLGVBQVcsWUFBWSxNQUFNLGdCQUFpQixPQUFNLEtBQUssS0FBSyxRQUFRLEVBQUU7QUFBQSxFQUMxRSxPQUFPO0FBQ0wsVUFBTSxLQUFLLGlCQUFpQjtBQUFBLEVBQzlCO0FBRUEsUUFBTSxLQUFLLEVBQUU7QUFDYixRQUFNLEtBQUssYUFBYTtBQUN4QixNQUFJLE1BQU0sU0FBUyxTQUFTLEdBQUc7QUFDN0IsZUFBVyxXQUFXLE1BQU0sU0FBVSxPQUFNLEtBQUssS0FBSyxPQUFPLEVBQUU7QUFBQSxFQUNqRSxPQUFPO0FBQ0wsVUFBTSxLQUFLLFFBQVE7QUFBQSxFQUNyQjtBQUVBLFFBQU0sS0FBSyxFQUFFO0FBQ2IsUUFBTSxLQUFLLGdCQUFnQjtBQUMzQixRQUFNLEtBQUssTUFBTSxjQUFjLE1BQU07QUFDckMsUUFBTSxLQUFLLEVBQUU7QUFFYixTQUFPLE1BQU0sS0FBSyxJQUFJO0FBQ3hCO0FBTUEsZUFBc0Isc0JBQXNCLFVBQWlDO0FBQzNFLE1BQUk7QUFDRixRQUFJLENBQUMsY0FBYyxFQUFHO0FBRXRCLFVBQU0sVUFBVSxZQUFZO0FBQzVCLFFBQUksQ0FBQyxRQUFTO0FBQ2QsUUFBSTtBQUNGLGNBQVEsUUFBUSxVQUFVLEVBQUUsSUFBSTtBQUFBLElBQ2xDLFNBQVMsS0FBSztBQUNaLGlCQUFXLGNBQWMsa0VBQWtFO0FBQUEsUUFDekYsT0FBUSxJQUFjO0FBQUEsTUFDeEIsQ0FBQztBQUNEO0FBQUEsSUFDRjtBQUNBLFVBQU0sUUFBUSxNQUFNLFlBQVksUUFBUTtBQUN4QyxVQUFNLFVBQVUsbUJBQW1CLEtBQUs7QUFDeEMsVUFBTSxNQUFNLEtBQUssVUFBVSxNQUFNO0FBQ2pDLGNBQVUsS0FBSyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ2xDLG9CQUFnQixLQUFLLEtBQUssVUFBVSxHQUFHLE9BQU87QUFBQSxFQUNoRCxTQUFTLEtBQUs7QUFDWixlQUFXLGNBQWMsaUNBQWtDLElBQWMsT0FBTyxFQUFFO0FBQUEsRUFDcEY7QUFDRjtBQVFBLGVBQXNCLHFCQUFxQixVQUFrQixhQUFvQztBQUkvRixNQUFJO0FBQ0YsVUFBTSxvQkFBb0IsVUFBVSxXQUFXO0FBQUEsRUFDakQsU0FBUyxLQUFLO0FBQ1osZUFBVyxjQUFjLGtDQUFrQyxXQUFXLEtBQU0sSUFBYyxPQUFPLEVBQUU7QUFBQSxFQUNyRztBQUdBLFFBQU0sWUFBWSxtQkFBbUIsV0FBVztBQUVoRCxhQUFXLFNBQVMsV0FBVztBQU83QixVQUFNLFdBQVcsY0FBYyxhQUFhLE1BQU0sRUFBRTtBQUNwRCxVQUFNLFlBQVksU0FBUyxPQUFPLE9BQUssRUFBRSxXQUFXLFVBQVUsRUFBRSxXQUFXLFVBQVU7QUFFckYsZUFBVyxRQUFRLFdBQVc7QUFDNUIsVUFBSTtBQUNGLGdDQUF3QixVQUFVLGFBQWEsTUFBTSxJQUFJLEtBQUssRUFBRTtBQUFBLE1BQ2xFLFNBQVMsS0FBSztBQUNaLG1CQUFXLGNBQWMsc0NBQXNDLFdBQVcsSUFBSSxNQUFNLEVBQUUsSUFBSSxLQUFLLEVBQUUsS0FBTSxJQUFjLE9BQU8sRUFBRTtBQUFBLE1BQ2hJO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFHQSxNQUFJO0FBQ0YsVUFBTSxzQkFBc0IsUUFBUTtBQUFBLEVBQ3RDLFNBQVMsS0FBSztBQUNaLGVBQVcsY0FBYyxpQ0FBa0MsSUFBYyxPQUFPLEVBQUU7QUFBQSxFQUNwRjtBQUNGO0FBVUEsZUFBc0Isb0JBQ3BCLFVBQ0EsYUFDQSxTQUNBLFVBQ2tCO0FBQ2xCLE1BQUk7QUFFSixVQUFRLFVBQVU7QUFBQSxJQUNoQixLQUFLO0FBQ0gsaUJBQVcsS0FBSyxVQUFVLFFBQVEsY0FBYyxhQUFhLFVBQVUsU0FBUyxHQUFHLE9BQU8sVUFBVTtBQUNwRztBQUFBLElBQ0YsS0FBSztBQUNILGlCQUFXLEtBQUssVUFBVSxRQUFRLGNBQWMsYUFBYSxHQUFHLFdBQVcsYUFBYTtBQUN4RjtBQUFBLElBQ0YsS0FBSztBQUVILGlCQUFXLEtBQUssVUFBVSxRQUFRLGNBQWMsYUFBYSxVQUFVLFNBQVMsT0FBTztBQUN2RjtBQUFBLElBQ0YsS0FBSztBQUNILGlCQUFXLEtBQUssVUFBVSxRQUFRLFVBQVU7QUFDNUM7QUFBQSxFQUNKO0FBRUEsTUFBSSxhQUFhLFdBQVc7QUFFMUIsVUFBTSxXQUFXLGNBQWMsYUFBYSxPQUFPO0FBQ25ELFVBQU0sWUFBWSxTQUFTLE9BQU8sT0FBSyxFQUFFLFdBQVcsVUFBVSxFQUFFLFdBQVcsVUFBVTtBQUNyRixRQUFJLGNBQWM7QUFDbEIsZUFBVyxRQUFRLFdBQVc7QUFDNUIsWUFBTSxjQUFjLEtBQUssVUFBVSxRQUFRLGNBQWMsYUFBYSxVQUFVLFNBQVMsU0FBUyxHQUFHLEtBQUssRUFBRSxhQUFhO0FBQ3pILFVBQUksQ0FBQyxXQUFXLFdBQVcsR0FBRztBQUM1QixZQUFJO0FBQ0Ysa0NBQXdCLFVBQVUsYUFBYSxTQUFTLEtBQUssRUFBRTtBQUMvRDtBQUFBLFFBQ0YsU0FBUyxLQUFLO0FBQ1oscUJBQVcsY0FBYywwQ0FBMEMsS0FBSyxFQUFFLEtBQU0sSUFBYyxPQUFPLEVBQUU7QUFBQSxRQUN6RztBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBQ0EsV0FBTyxjQUFjO0FBQUEsRUFDdkI7QUFFQSxNQUFJLFdBQVcsUUFBUSxHQUFHO0FBQ3hCLFdBQU87QUFBQSxFQUNUO0FBS0EsTUFBSTtBQUNGLFlBQVEsVUFBVTtBQUFBLE1BQ2hCLEtBQUs7QUFDSCw2QkFBcUIsVUFBVSxhQUFhLE9BQU87QUFDbkQsZUFBTyxXQUFXLFFBQVE7QUFBQSxNQUM1QixLQUFLO0FBQ0gsY0FBTSxvQkFBb0IsVUFBVSxXQUFXO0FBQy9DLGVBQU8sV0FBVyxRQUFRO0FBQUEsTUFDNUIsS0FBSztBQUNILGNBQU0sc0JBQXNCLFFBQVE7QUFDcEMsZUFBTyxXQUFXLFFBQVE7QUFBQSxJQUM5QjtBQUFBLEVBQ0YsU0FBUyxLQUFLO0FBQ1osZUFBVyxjQUFjLHVCQUF1QixRQUFRLFlBQWEsSUFBYyxPQUFPLEVBQUU7QUFDNUYsV0FBTztBQUFBLEVBQ1Q7QUFDRjsiLAogICJuYW1lcyI6IFtdCn0K
