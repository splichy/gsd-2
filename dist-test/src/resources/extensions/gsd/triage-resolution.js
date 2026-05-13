import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { atomicWriteSync } from "./atomic-write.js";
import { join } from "node:path";
import { createRequire } from "node:module";
import { gsdRoot, milestonesDir } from "./paths.js";
import { MILESTONE_ID_RE } from "./milestone-ids.js";
import {
  loadAllCaptures,
  loadActionableCaptures,
  markCaptureExecuted,
  stampCaptureMilestone
} from "./captures.js";
function executeInject(basePath, mid, sid, capture) {
  try {
    const planPath = join(gsdRoot(basePath), "milestones", mid, "slices", sid, `${sid}-PLAN.md`);
    if (!existsSync(planPath)) return null;
    const content = readFileSync(planPath, "utf-8");
    const taskMatches = [...content.matchAll(/- \[[ x]\] \*\*T(\d+):/g)];
    if (taskMatches.length === 0) return null;
    const maxId = Math.max(...taskMatches.map((m) => parseInt(m[1], 10)));
    const newId = `T${String(maxId + 1).padStart(2, "0")}`;
    const newTask = [
      `- [ ] **${newId}: ${capture.text}** \`est:30m\``,
      `  - Why: Injected from capture ${capture.id} during triage`,
      `  - Do: ${capture.text}`,
      `  - Done when: Capture intent fulfilled`
    ].join("\n");
    const filesSection = content.indexOf("## Files Likely Touched");
    if (filesSection !== -1) {
      const updated = content.slice(0, filesSection) + newTask + "\n\n" + content.slice(filesSection);
      atomicWriteSync(planPath, updated, "utf-8");
    } else {
      atomicWriteSync(planPath, content.trimEnd() + "\n\n" + newTask + "\n", "utf-8");
    }
    return newId;
  } catch {
    return null;
  }
}
function executeReplan(basePath, mid, sid, capture) {
  try {
    const triggerPath = join(
      basePath,
      ".gsd",
      "milestones",
      mid,
      "slices",
      sid,
      `${sid}-REPLAN-TRIGGER.md`
    );
    const ts = (/* @__PURE__ */ new Date()).toISOString();
    const content = [
      `# Replan Trigger`,
      ``,
      `**Source:** Capture ${capture.id}`,
      `**Capture:** ${capture.text}`,
      `**Rationale:** ${capture.rationale ?? "User-initiated replan via capture triage"}`,
      `**Triggered:** ${ts}`,
      ``,
      `This file was created by the triage pipeline. The next dispatch cycle`,
      `will detect it and enter the replanning-slice phase.`
    ].join("\n");
    atomicWriteSync(triggerPath, content, "utf-8");
    try {
      const req = createRequire(import.meta.url);
      const { isDbAvailable, setSliceReplanTriggeredAt } = req("./gsd-db.js");
      if (isDbAvailable()) {
        setSliceReplanTriggeredAt(mid, sid, ts);
      }
    } catch {
    }
    return true;
  } catch {
    return false;
  }
}
function executeBacktrack(basePath, currentMilestoneId, capture) {
  try {
    const sourceText = capture.resolution ?? capture.text;
    const allMatches = [...sourceText.matchAll(/\b(M\d{3}(?:-[a-z0-9]{6})?)\b/g)].map((m) => m[1]).filter((id) => id !== currentMilestoneId);
    const uniqueTargets = [...new Set(allMatches)];
    const targetMilestoneId = uniqueTargets.length === 1 ? uniqueTargets[0] : null;
    const ts = (/* @__PURE__ */ new Date()).toISOString();
    const triggerPath = join(gsdRoot(basePath), "BACKTRACK-TRIGGER.md");
    const content = [
      `# Backtrack Trigger`,
      ``,
      `**Source:** Capture ${capture.id}`,
      `**Capture:** ${capture.text}`,
      `**Rationale:** ${capture.rationale ?? "User-initiated milestone backtrack"}`,
      `**From:** ${currentMilestoneId}`,
      `**Target:** ${targetMilestoneId ?? "(user to specify)"}`,
      `**Triggered:** ${ts}`,
      ``,
      `Auto-mode was paused by this backtrack directive. The user directed`,
      `that the current milestone (${currentMilestoneId}) be abandoned and work`,
      `should return to ${targetMilestoneId ?? "a previous milestone"}.`,
      ``,
      `## Recovery Steps`,
      ``,
      `1. Review what went wrong in ${currentMilestoneId}`,
      `2. Identify missing features/requirements from the target milestone`,
      `3. Resume auto-mode \u2014 the state machine will re-enter discussion for the target`
    ].join("\n");
    atomicWriteSync(triggerPath, content, "utf-8");
    if (targetMilestoneId) {
      try {
        const targetDir = join(milestonesDir(basePath), targetMilestoneId);
        if (existsSync(targetDir)) {
          const regressionPath = join(targetDir, `${targetMilestoneId}-REGRESSION.md`);
          atomicWriteSync(regressionPath, [
            `# Milestone Regression`,
            ``,
            `**From:** ${currentMilestoneId}`,
            `**Reason:** ${capture.text}`,
            `**Triggered:** ${ts}`,
            ``,
            `This milestone is being revisited because downstream milestone`,
            `${currentMilestoneId} failed or missed critical features that should`,
            `have been part of this milestone's scope.`,
            ``,
            `The discuss phase should re-evaluate requirements and identify gaps.`
          ].join("\n"), "utf-8");
        }
      } catch {
      }
    }
    return targetMilestoneId;
  } catch {
    return null;
  }
}
function readBacktrackTrigger(basePath) {
  const triggerPath = join(gsdRoot(basePath), "BACKTRACK-TRIGGER.md");
  if (!existsSync(triggerPath)) return null;
  try {
    const content = readFileSync(triggerPath, "utf-8");
    const target = content.match(/\*\*Target:\*\*\s*(.+)/)?.[1]?.trim() ?? null;
    const from = content.match(/\*\*From:\*\*\s*(.+)/)?.[1]?.trim() ?? null;
    const capture = content.match(/\*\*Capture:\*\*\s*(.+)/)?.[1]?.trim() ?? "";
    const triggeredAt = content.match(/\*\*Triggered:\*\*\s*(.+)/)?.[1]?.trim() ?? "";
    return {
      target: target === "(user to specify)" ? null : target,
      from,
      capture,
      triggeredAt
    };
  } catch {
    return null;
  }
}
function clearBacktrackTrigger(basePath) {
  const triggerPath = join(gsdRoot(basePath), "BACKTRACK-TRIGGER.md");
  try {
    if (existsSync(triggerPath)) {
      unlinkSync(triggerPath);
    }
  } catch {
  }
}
function detectFileOverlap(affectedFiles, planContent) {
  if (!affectedFiles || affectedFiles.length === 0) return [];
  const overlappingTasks = [];
  const normalizedAffected = new Set(
    affectedFiles.map((f) => f.replace(/^\.\//, "").toLowerCase())
  );
  const taskPattern = /- \[ \] \*\*(T\d+):[^*]*\*\*/g;
  const tasks = [...planContent.matchAll(taskPattern)];
  for (const taskMatch of tasks) {
    const taskId = taskMatch[1];
    const taskStart = taskMatch.index;
    const nextTask = planContent.indexOf("- [", taskStart + 1);
    const sectionEnd = planContent.indexOf("##", taskStart + 1);
    const taskEnd = Math.min(
      nextTask === -1 ? planContent.length : nextTask,
      sectionEnd === -1 ? planContent.length : sectionEnd
    );
    const taskContent = planContent.slice(taskStart, taskEnd);
    const fileRefs = [...taskContent.matchAll(/`([^`]+\.[a-z]+)`/g)].map((m) => m[1].replace(/^\.\//, "").toLowerCase());
    const hasOverlap = fileRefs.some((f) => normalizedAffected.has(f));
    if (hasOverlap) {
      overlappingTasks.push(taskId);
    }
  }
  return overlappingTasks;
}
function ensureDeferMilestoneDir(basePath, targetMilestone, captures) {
  if (!MILESTONE_ID_RE.test(targetMilestone)) return false;
  const msDir = join(milestonesDir(basePath), targetMilestone);
  if (existsSync(msDir)) return true;
  try {
    mkdirSync(msDir, { recursive: true });
    const captureList = captures.map((c) => `- **${c.id}:** ${c.text}`).join("\n");
    const draftContent = [
      `# ${targetMilestone}: Deferred Work`,
      ``,
      `This milestone was created by triage when captures were deferred here.`,
      `Discuss scope and goals before planning slices.`,
      ``,
      `## Deferred Captures`,
      ``,
      captureList || `(no captures yet)`,
      ``
    ].join("\n");
    atomicWriteSync(
      join(msDir, `${targetMilestone}-CONTEXT-DRAFT.md`),
      draftContent,
      "utf-8"
    );
    return true;
  } catch {
    return false;
  }
}
function loadDeferredCaptures(basePath) {
  return loadAllCaptures(basePath).filter((c) => c.classification === "defer");
}
function loadReplanCaptures(basePath) {
  return loadAllCaptures(basePath).filter((c) => c.classification === "replan");
}
function buildQuickTaskPrompt(capture) {
  return [
    `You are executing a quick one-off task captured during a GSD auto-mode session.`,
    ``,
    `## Quick Task`,
    ``,
    `**Capture ID:** ${capture.id}`,
    `**Task:** ${capture.text}`,
    ``,
    `## Instructions`,
    ``,
    `1. **Verify the issue still exists.** Before making any changes, inspect the`,
    `   relevant code to confirm the problem described above is actually present in`,
    `   the current codebase. If the issue has already been fixed (e.g., by planned`,
    `   milestone work), report "Already resolved \u2014 no changes needed." and stop.`,
    `2. Execute this task as a small, self-contained change.`,
    `3. Do NOT modify any \`.gsd/\` plan files \u2014 this is a one-off, not a planned task.`,
    `4. Commit your changes with a descriptive message.`,
    `5. Keep changes minimal and focused on the capture text.`,
    `6. When done, say: "Quick task complete."`
  ].join("\n");
}
function executeTriageResolutions(basePath, mid, sid) {
  const result = {
    injected: 0,
    replanned: 0,
    deferredMilestones: 0,
    quickTasks: [],
    stopped: 0,
    backtracks: [],
    actions: []
  };
  const actionable = loadActionableCaptures(basePath, mid || void 0);
  if (mid) {
    for (const capture of actionable) {
      if (!capture.resolvedInMilestone) {
        stampCaptureMilestone(basePath, capture.id, mid);
      }
    }
  }
  const deferrable = loadAllCaptures(basePath).filter(
    (c) => c.status === "resolved" && !c.executed && (c.classification === "defer" || c.classification === "milestone")
  );
  if (deferrable.length > 0) {
    const byMilestone = /* @__PURE__ */ new Map();
    for (const cap of deferrable) {
      const target = cap.resolution?.match(/\b(M\d{3}(?:-[a-z0-9]{6})?)\b/)?.[1];
      if (target) {
        const list = byMilestone.get(target) ?? [];
        list.push(cap);
        byMilestone.set(target, list);
      }
    }
    for (const [milestoneId, captures] of byMilestone) {
      const msDir = join(milestonesDir(basePath), milestoneId);
      if (!existsSync(msDir)) {
        const created = ensureDeferMilestoneDir(basePath, milestoneId, captures);
        if (created) {
          result.deferredMilestones++;
          result.actions.push(`Created milestone ${milestoneId} for ${captures.length} deferred capture(s)`);
        }
      }
    }
    for (const cap of deferrable) {
      if (!cap.executed) {
        markCaptureExecuted(basePath, cap.id);
      }
    }
  }
  const notes = loadAllCaptures(basePath).filter(
    (c) => c.status === "resolved" && !c.executed && c.classification === "note"
  );
  for (const cap of notes) {
    markCaptureExecuted(basePath, cap.id);
    result.actions.push(`Note acknowledged: ${cap.id} \u2014 "${cap.text}"`);
  }
  if (actionable.length === 0) return result;
  for (const capture of actionable) {
    switch (capture.classification) {
      case "inject": {
        const newTaskId = executeInject(basePath, mid, sid, capture);
        if (newTaskId) {
          markCaptureExecuted(basePath, capture.id);
          result.injected++;
          result.actions.push(`Injected ${newTaskId} from ${capture.id}: "${capture.text}"`);
        } else {
          result.actions.push(`Failed to inject ${capture.id}: "${capture.text}" (no plan file or parse error)`);
        }
        break;
      }
      case "replan": {
        const success = executeReplan(basePath, mid, sid, capture);
        if (success) {
          markCaptureExecuted(basePath, capture.id);
          result.replanned++;
          result.actions.push(`Replan triggered from ${capture.id}: "${capture.text}"`);
        } else {
          result.actions.push(`Failed to trigger replan from ${capture.id}: "${capture.text}"`);
        }
        break;
      }
      case "quick-task": {
        result.quickTasks.push(capture);
        result.actions.push(`Quick-task queued from ${capture.id}: "${capture.text}"`);
        break;
      }
    }
  }
  const allCaptures = loadAllCaptures(basePath);
  for (const cap of allCaptures) {
    if (cap.status !== "resolved" || cap.executed) continue;
    if (cap.classification === "stop") {
      result.stopped++;
      result.actions.push(`Stop directive from ${cap.id}: "${cap.text}" \u2014 will pause on next dispatch`);
    } else if (cap.classification === "backtrack") {
      result.backtracks.push(cap);
      result.actions.push(`Backtrack directive from ${cap.id}: "${cap.text}" \u2014 will trigger milestone regression on next dispatch`);
    }
  }
  return result;
}
export {
  buildQuickTaskPrompt,
  clearBacktrackTrigger,
  detectFileOverlap,
  ensureDeferMilestoneDir,
  executeBacktrack,
  executeInject,
  executeReplan,
  executeTriageResolutions,
  loadDeferredCaptures,
  loadReplanCaptures,
  readBacktrackTrigger
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90cmlhZ2UtcmVzb2x1dGlvbi50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBHU0QgVHJpYWdlIFJlc29sdXRpb24gXHUyMDE0IEV4ZWN1dGUgdHJpYWdlIGNsYXNzaWZpY2F0aW9uc1xuICpcbiAqIFByb3ZpZGVzIHJlc29sdXRpb24gZXhlY3V0b3JzIGZvciBlYWNoIGNhcHR1cmUgY2xhc3NpZmljYXRpb24gdHlwZTpcbiAqXG4gKiAtIGluamVjdDogYXBwZW5kcyBhIG5ldyB0YXNrIHRvIHRoZSBjdXJyZW50IHNsaWNlIHBsYW5cbiAqIC0gcmVwbGFuOiB3cml0ZXMgUkVQTEFOLVRSSUdHRVIubWQgc28gbmV4dCBkaXNwYXRjaE5leHRVbml0IGVudGVycyByZXBsYW5uaW5nLXNsaWNlXG4gKiAtIGRlZmVyL25vdGU6IHF1ZXJ5IGhlbHBlcnMgZm9yIGxvYWRpbmcgZGVmZXJyZWQvcmVwbGFuIGNhcHR1cmVzXG4gKlxuICogQWxzbyBwcm92aWRlcyBkZXRlY3RGaWxlT3ZlcmxhcCgpIGZvciBzdXJmYWNpbmcgZG93bnN0cmVhbSBpbXBhY3Qgb24gcXVpY2sgdGFza3MuXG4gKi9cblxuaW1wb3J0IHsgZXhpc3RzU3luYywgbWtkaXJTeW5jLCByZWFkRmlsZVN5bmMsIHVubGlua1N5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgYXRvbWljV3JpdGVTeW5jIH0gZnJvbSBcIi4vYXRvbWljLXdyaXRlLmpzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgY3JlYXRlUmVxdWlyZSB9IGZyb20gXCJub2RlOm1vZHVsZVwiO1xuaW1wb3J0IHsgZ3NkUm9vdCwgbWlsZXN0b25lc0RpciB9IGZyb20gXCIuL3BhdGhzLmpzXCI7XG5pbXBvcnQgeyBNSUxFU1RPTkVfSURfUkUgfSBmcm9tIFwiLi9taWxlc3RvbmUtaWRzLmpzXCI7XG5pbXBvcnQgdHlwZSB7IENsYXNzaWZpY2F0aW9uLCBDYXB0dXJlRW50cnkgfSBmcm9tIFwiLi9jYXB0dXJlcy5qc1wiO1xuaW1wb3J0IHtcbiAgbG9hZFBlbmRpbmdDYXB0dXJlcyxcbiAgbG9hZEFsbENhcHR1cmVzLFxuICBsb2FkQWN0aW9uYWJsZUNhcHR1cmVzLFxuICBtYXJrQ2FwdHVyZVJlc29sdmVkLFxuICBtYXJrQ2FwdHVyZUV4ZWN1dGVkLFxuICBzdGFtcENhcHR1cmVNaWxlc3RvbmUsXG59IGZyb20gXCIuL2NhcHR1cmVzLmpzXCI7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBSZXNvbHV0aW9uIEV4ZWN1dG9ycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBJbmplY3QgYSBuZXcgdGFzayBpbnRvIHRoZSBjdXJyZW50IHNsaWNlIHBsYW4uXG4gKiBSZWFkcyB0aGUgcGxhbiwgZmluZHMgdGhlIGhpZ2hlc3QgdGFzayBJRCwgYXBwZW5kcyBhIG5ldyB0YXNrIGVudHJ5LlxuICogUmV0dXJucyB0aGUgbmV3IHRhc2sgSUQsIG9yIG51bGwgaWYgaW5qZWN0aW9uIGZhaWxlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGV4ZWN1dGVJbmplY3QoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIG1pZDogc3RyaW5nLFxuICBzaWQ6IHN0cmluZyxcbiAgY2FwdHVyZTogQ2FwdHVyZUVudHJ5LFxuKTogc3RyaW5nIHwgbnVsbCB7XG4gIHRyeSB7XG4gICAgLy8gUmVzb2x2ZSB0aGUgcGxhbiBmaWxlIHBhdGhcbiAgICBjb25zdCBwbGFuUGF0aCA9IGpvaW4oZ3NkUm9vdChiYXNlUGF0aCksIFwibWlsZXN0b25lc1wiLCBtaWQsIFwic2xpY2VzXCIsIHNpZCwgYCR7c2lkfS1QTEFOLm1kYCk7XG4gICAgaWYgKCFleGlzdHNTeW5jKHBsYW5QYXRoKSkgcmV0dXJuIG51bGw7XG5cbiAgICBjb25zdCBjb250ZW50ID0gcmVhZEZpbGVTeW5jKHBsYW5QYXRoLCBcInV0Zi04XCIpO1xuXG4gICAgLy8gRmluZCB0aGUgaGlnaGVzdCBleGlzdGluZyB0YXNrIElEXG4gICAgY29uc3QgdGFza01hdGNoZXMgPSBbLi4uY29udGVudC5tYXRjaEFsbCgvLSBcXFtbIHhdXFxdIFxcKlxcKlQoXFxkKyk6L2cpXTtcbiAgICBpZiAodGFza01hdGNoZXMubGVuZ3RoID09PSAwKSByZXR1cm4gbnVsbDtcblxuICAgIGNvbnN0IG1heElkID0gTWF0aC5tYXgoLi4udGFza01hdGNoZXMubWFwKG0gPT4gcGFyc2VJbnQobVsxXSwgMTApKSk7XG4gICAgY29uc3QgbmV3SWQgPSBgVCR7U3RyaW5nKG1heElkICsgMSkucGFkU3RhcnQoMiwgXCIwXCIpfWA7XG5cbiAgICAvLyBCdWlsZCB0aGUgbmV3IHRhc2sgZW50cnlcbiAgICBjb25zdCBuZXdUYXNrID0gW1xuICAgICAgYC0gWyBdICoqJHtuZXdJZH06ICR7Y2FwdHVyZS50ZXh0fSoqIFxcYGVzdDozMG1cXGBgLFxuICAgICAgYCAgLSBXaHk6IEluamVjdGVkIGZyb20gY2FwdHVyZSAke2NhcHR1cmUuaWR9IGR1cmluZyB0cmlhZ2VgLFxuICAgICAgYCAgLSBEbzogJHtjYXB0dXJlLnRleHR9YCxcbiAgICAgIGAgIC0gRG9uZSB3aGVuOiBDYXB0dXJlIGludGVudCBmdWxmaWxsZWRgLFxuICAgIF0uam9pbihcIlxcblwiKTtcblxuICAgIC8vIEZpbmQgdGhlIGxhc3QgdGFzayBlbnRyeSBhbmQgYXBwZW5kIGFmdGVyIGl0XG4gICAgLy8gTG9vayBmb3IgdGhlIFwiIyMgRmlsZXMgTGlrZWx5IFRvdWNoZWRcIiBzZWN0aW9uIGFzIHRoZSBib3VuZGFyeVxuICAgIGNvbnN0IGZpbGVzU2VjdGlvbiA9IGNvbnRlbnQuaW5kZXhPZihcIiMjIEZpbGVzIExpa2VseSBUb3VjaGVkXCIpO1xuICAgIGlmIChmaWxlc1NlY3Rpb24gIT09IC0xKSB7XG4gICAgICBjb25zdCB1cGRhdGVkID0gY29udGVudC5zbGljZSgwLCBmaWxlc1NlY3Rpb24pICsgbmV3VGFzayArIFwiXFxuXFxuXCIgKyBjb250ZW50LnNsaWNlKGZpbGVzU2VjdGlvbik7XG4gICAgICBhdG9taWNXcml0ZVN5bmMocGxhblBhdGgsIHVwZGF0ZWQsIFwidXRmLThcIik7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIE5vIEZpbGVzIHNlY3Rpb24gXHUyMDE0IGFwcGVuZCBhdCBlbmRcbiAgICAgIGF0b21pY1dyaXRlU3luYyhwbGFuUGF0aCwgY29udGVudC50cmltRW5kKCkgKyBcIlxcblxcblwiICsgbmV3VGFzayArIFwiXFxuXCIsIFwidXRmLThcIik7XG4gICAgfVxuXG4gICAgcmV0dXJuIG5ld0lkO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG4vKipcbiAqIFRyaWdnZXIgcmVwbGFubmluZyBieSB3cml0aW5nIGEgUkVQTEFOLVRSSUdHRVIubWQgbWFya2VyIGZpbGUuXG4gKiBUaGUgZXhpc3Rpbmcgc3RhdGUudHMgZGVyaXZhdGlvbiBkZXRlY3RzIHRoaXMgYW5kIHNldHMgcGhhc2UgdG8gXCJyZXBsYW5uaW5nLXNsaWNlXCIuXG4gKiBSZXR1cm5zIHRydWUgaWYgdGhlIHRyaWdnZXIgd2FzIHdyaXR0ZW4gc3VjY2Vzc2Z1bGx5LlxuICovXG5leHBvcnQgZnVuY3Rpb24gZXhlY3V0ZVJlcGxhbihcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgbWlkOiBzdHJpbmcsXG4gIHNpZDogc3RyaW5nLFxuICBjYXB0dXJlOiBDYXB0dXJlRW50cnksXG4pOiBib29sZWFuIHtcbiAgdHJ5IHtcbiAgICBjb25zdCB0cmlnZ2VyUGF0aCA9IGpvaW4oXG4gICAgICBiYXNlUGF0aCwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBtaWQsIFwic2xpY2VzXCIsIHNpZCwgYCR7c2lkfS1SRVBMQU4tVFJJR0dFUi5tZGAsXG4gICAgKTtcbiAgICBjb25zdCB0cyA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcbiAgICBjb25zdCBjb250ZW50ID0gW1xuICAgICAgYCMgUmVwbGFuIFRyaWdnZXJgLFxuICAgICAgYGAsXG4gICAgICBgKipTb3VyY2U6KiogQ2FwdHVyZSAke2NhcHR1cmUuaWR9YCxcbiAgICAgIGAqKkNhcHR1cmU6KiogJHtjYXB0dXJlLnRleHR9YCxcbiAgICAgIGAqKlJhdGlvbmFsZToqKiAke2NhcHR1cmUucmF0aW9uYWxlID8/IFwiVXNlci1pbml0aWF0ZWQgcmVwbGFuIHZpYSBjYXB0dXJlIHRyaWFnZVwifWAsXG4gICAgICBgKipUcmlnZ2VyZWQ6KiogJHt0c31gLFxuICAgICAgYGAsXG4gICAgICBgVGhpcyBmaWxlIHdhcyBjcmVhdGVkIGJ5IHRoZSB0cmlhZ2UgcGlwZWxpbmUuIFRoZSBuZXh0IGRpc3BhdGNoIGN5Y2xlYCxcbiAgICAgIGB3aWxsIGRldGVjdCBpdCBhbmQgZW50ZXIgdGhlIHJlcGxhbm5pbmctc2xpY2UgcGhhc2UuYCxcbiAgICBdLmpvaW4oXCJcXG5cIik7XG5cbiAgICBhdG9taWNXcml0ZVN5bmModHJpZ2dlclBhdGgsIGNvbnRlbnQsIFwidXRmLThcIik7XG5cbiAgICAvLyBBbHNvIHdyaXRlIHJlcGxhbl90cmlnZ2VyZWRfYXQgY29sdW1uIGZvciBEQi1iYWNrZWQgZGV0ZWN0aW9uXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlcSA9IGNyZWF0ZVJlcXVpcmUoaW1wb3J0Lm1ldGEudXJsKTtcbiAgICAgIGNvbnN0IHsgaXNEYkF2YWlsYWJsZSwgc2V0U2xpY2VSZXBsYW5UcmlnZ2VyZWRBdCB9ID0gcmVxKFwiLi9nc2QtZGIuanNcIik7XG4gICAgICBpZiAoaXNEYkF2YWlsYWJsZSgpKSB7XG4gICAgICAgIHNldFNsaWNlUmVwbGFuVHJpZ2dlcmVkQXQobWlkLCBzaWQsIHRzKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIERCIHdyaXRlIGlzIGJlc3QtZWZmb3J0IFx1MjAxNCBkaXNrIGZpbGUgaXMgdGhlIHByaW1hcnkgdHJpZ2dlciBmb3IgZmFsbGJhY2sgcGF0aFxuICAgIH1cblxuICAgIHJldHVybiB0cnVlO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEJhY2t0cmFjayAoTWlsZXN0b25lIFJlZ3Jlc3Npb24pIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIEV4ZWN1dGUgYSBiYWNrdHJhY2sgZGlyZWN0aXZlIFx1MjAxNCB1c2VyIHdhbnRzIHRvIGFiYW5kb24gY3VycmVudCBtaWxlc3RvbmVcbiAqIGFuZCByZXR1cm4gdG8gYSBwcmV2aW91cyBvbmUgKG1pbGVzdG9uZSByZWdyZXNzaW9uKS5cbiAqXG4gKiBXcml0ZXMgYSBCQUNLVFJBQ0stVFJJR0dFUi5tZCBtYXJrZXIgYXQgYC5nc2QvQkFDS1RSQUNLLVRSSUdHRVIubWRgIHdpdGhcbiAqIHRoZSB0YXJnZXQgbWlsZXN0b25lLCByZWFzb24sIGFuZCB0aW1lc3RhbXAuIFRoZSBzdGF0ZSBtYWNoaW5lIChkZXJpdmVTdGF0ZSlcbiAqIGRldGVjdHMgdGhpcyBhbmQgdHJhbnNpdGlvbnMgdGhlIHByb2plY3QgdG8gdGhlIHRhcmdldCBtaWxlc3RvbmUsIHJlc2V0dGluZ1xuICogaXRzIHNsaWNlcyB0byBhbGxvdyByZS1wbGFubmluZy5cbiAqXG4gKiBSZXR1cm5zIHRoZSBleHRyYWN0ZWQgdGFyZ2V0IG1pbGVzdG9uZSBJRCwgb3IgbnVsbCBpZiBleHRyYWN0aW9uIGZhaWxlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGV4ZWN1dGVCYWNrdHJhY2soXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIGN1cnJlbnRNaWxlc3RvbmVJZDogc3RyaW5nLFxuICBjYXB0dXJlOiBDYXB0dXJlRW50cnksXG4pOiBzdHJpbmcgfCBudWxsIHtcbiAgdHJ5IHtcbiAgICAvLyBFeHRyYWN0IHRhcmdldCBtaWxlc3RvbmUgZnJvbSBjYXB0dXJlIHRleHQgb3IgcmVzb2x1dGlvbi5cbiAgICAvLyBGaWx0ZXIgb3V0IHRoZSBjdXJyZW50IG1pbGVzdG9uZSBJRCB0byBhdm9pZCBwaWNraW5nIGl0IGFzIHRoZSBiYWNrdHJhY2sgdGFyZ2V0XG4gICAgLy8gd2hlbiB0aGUgdGV4dCBtZW50aW9ucyBib3RoIGN1cnJlbnQgYW5kIHRhcmdldCBtaWxlc3RvbmVzIChlLmcuIFwiYmFja3RyYWNrIGZyb20gTTAwNCB0byBNMDAzXCIpLlxuICAgIGNvbnN0IHNvdXJjZVRleHQgPSBjYXB0dXJlLnJlc29sdXRpb24gPz8gY2FwdHVyZS50ZXh0O1xuICAgIGNvbnN0IGFsbE1hdGNoZXMgPSBbLi4uc291cmNlVGV4dC5tYXRjaEFsbCgvXFxiKE1cXGR7M30oPzotW2EtejAtOV17Nn0pPylcXGIvZyldXG4gICAgICAubWFwKG0gPT4gbVsxXSlcbiAgICAgIC5maWx0ZXIoaWQgPT4gaWQgIT09IGN1cnJlbnRNaWxlc3RvbmVJZCk7XG4gICAgLy8gUmVqZWN0IGFtYmlndW91cyBtdWx0aS10YXJnZXQgc3RyaW5ncyBcdTIwMTQgaWYgbW9yZSB0aGFuIG9uZSBkaXN0aW5jdCB0YXJnZXQgcmVtYWlucyxcbiAgICAvLyBkb24ndCBndWVzczsgbGV0IHRoZSB1c2VyIGNsYXJpZnkuXG4gICAgY29uc3QgdW5pcXVlVGFyZ2V0cyA9IFsuLi5uZXcgU2V0KGFsbE1hdGNoZXMpXTtcbiAgICBjb25zdCB0YXJnZXRNaWxlc3RvbmVJZCA9IHVuaXF1ZVRhcmdldHMubGVuZ3RoID09PSAxID8gdW5pcXVlVGFyZ2V0c1swXSA6IG51bGw7XG5cbiAgICBjb25zdCB0cyA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcbiAgICBjb25zdCB0cmlnZ2VyUGF0aCA9IGpvaW4oZ3NkUm9vdChiYXNlUGF0aCksIFwiQkFDS1RSQUNLLVRSSUdHRVIubWRcIik7XG4gICAgY29uc3QgY29udGVudCA9IFtcbiAgICAgIGAjIEJhY2t0cmFjayBUcmlnZ2VyYCxcbiAgICAgIGBgLFxuICAgICAgYCoqU291cmNlOioqIENhcHR1cmUgJHtjYXB0dXJlLmlkfWAsXG4gICAgICBgKipDYXB0dXJlOioqICR7Y2FwdHVyZS50ZXh0fWAsXG4gICAgICBgKipSYXRpb25hbGU6KiogJHtjYXB0dXJlLnJhdGlvbmFsZSA/PyBcIlVzZXItaW5pdGlhdGVkIG1pbGVzdG9uZSBiYWNrdHJhY2tcIn1gLFxuICAgICAgYCoqRnJvbToqKiAke2N1cnJlbnRNaWxlc3RvbmVJZH1gLFxuICAgICAgYCoqVGFyZ2V0OioqICR7dGFyZ2V0TWlsZXN0b25lSWQgPz8gXCIodXNlciB0byBzcGVjaWZ5KVwifWAsXG4gICAgICBgKipUcmlnZ2VyZWQ6KiogJHt0c31gLFxuICAgICAgYGAsXG4gICAgICBgQXV0by1tb2RlIHdhcyBwYXVzZWQgYnkgdGhpcyBiYWNrdHJhY2sgZGlyZWN0aXZlLiBUaGUgdXNlciBkaXJlY3RlZGAsXG4gICAgICBgdGhhdCB0aGUgY3VycmVudCBtaWxlc3RvbmUgKCR7Y3VycmVudE1pbGVzdG9uZUlkfSkgYmUgYWJhbmRvbmVkIGFuZCB3b3JrYCxcbiAgICAgIGBzaG91bGQgcmV0dXJuIHRvICR7dGFyZ2V0TWlsZXN0b25lSWQgPz8gXCJhIHByZXZpb3VzIG1pbGVzdG9uZVwifS5gLFxuICAgICAgYGAsXG4gICAgICBgIyMgUmVjb3ZlcnkgU3RlcHNgLFxuICAgICAgYGAsXG4gICAgICBgMS4gUmV2aWV3IHdoYXQgd2VudCB3cm9uZyBpbiAke2N1cnJlbnRNaWxlc3RvbmVJZH1gLFxuICAgICAgYDIuIElkZW50aWZ5IG1pc3NpbmcgZmVhdHVyZXMvcmVxdWlyZW1lbnRzIGZyb20gdGhlIHRhcmdldCBtaWxlc3RvbmVgLFxuICAgICAgYDMuIFJlc3VtZSBhdXRvLW1vZGUgXHUyMDE0IHRoZSBzdGF0ZSBtYWNoaW5lIHdpbGwgcmUtZW50ZXIgZGlzY3Vzc2lvbiBmb3IgdGhlIHRhcmdldGAsXG4gICAgXS5qb2luKFwiXFxuXCIpO1xuXG4gICAgYXRvbWljV3JpdGVTeW5jKHRyaWdnZXJQYXRoLCBjb250ZW50LCBcInV0Zi04XCIpO1xuXG4gICAgLy8gSWYgd2UgaGF2ZSBhIHZhbGlkIHRhcmdldCwgYWxzbyByZXNldCB0aGF0IG1pbGVzdG9uZSdzIGNvbXBsZXRpb24gc3RhdHVzXG4gICAgLy8gc28gZGVyaXZlU3RhdGUoKSB3aWxsIHJlLWVudGVyIGl0IGFzIHRoZSBhY3RpdmUgbWlsZXN0b25lLlxuICAgIGlmICh0YXJnZXRNaWxlc3RvbmVJZCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgdGFyZ2V0RGlyID0gam9pbihtaWxlc3RvbmVzRGlyKGJhc2VQYXRoKSwgdGFyZ2V0TWlsZXN0b25lSWQpO1xuICAgICAgICBpZiAoZXhpc3RzU3luYyh0YXJnZXREaXIpKSB7XG4gICAgICAgICAgLy8gV3JpdGUgYSByZWdyZXNzaW9uIG1hcmtlciBzbyB0aGUgc3RhdGUgbWFjaGluZSBrbm93cyB0aGlzIG1pbGVzdG9uZVxuICAgICAgICAgIC8vIG5lZWRzIHJlLWRpc2N1c3Npb24sIG5vdCBqdXN0IHJlLWV4ZWN1dGlvblxuICAgICAgICAgIGNvbnN0IHJlZ3Jlc3Npb25QYXRoID0gam9pbih0YXJnZXREaXIsIGAke3RhcmdldE1pbGVzdG9uZUlkfS1SRUdSRVNTSU9OLm1kYCk7XG4gICAgICAgICAgYXRvbWljV3JpdGVTeW5jKHJlZ3Jlc3Npb25QYXRoLCBbXG4gICAgICAgICAgICBgIyBNaWxlc3RvbmUgUmVncmVzc2lvbmAsXG4gICAgICAgICAgICBgYCxcbiAgICAgICAgICAgIGAqKkZyb206KiogJHtjdXJyZW50TWlsZXN0b25lSWR9YCxcbiAgICAgICAgICAgIGAqKlJlYXNvbjoqKiAke2NhcHR1cmUudGV4dH1gLFxuICAgICAgICAgICAgYCoqVHJpZ2dlcmVkOioqICR7dHN9YCxcbiAgICAgICAgICAgIGBgLFxuICAgICAgICAgICAgYFRoaXMgbWlsZXN0b25lIGlzIGJlaW5nIHJldmlzaXRlZCBiZWNhdXNlIGRvd25zdHJlYW0gbWlsZXN0b25lYCxcbiAgICAgICAgICAgIGAke2N1cnJlbnRNaWxlc3RvbmVJZH0gZmFpbGVkIG9yIG1pc3NlZCBjcml0aWNhbCBmZWF0dXJlcyB0aGF0IHNob3VsZGAsXG4gICAgICAgICAgICBgaGF2ZSBiZWVuIHBhcnQgb2YgdGhpcyBtaWxlc3RvbmUncyBzY29wZS5gLFxuICAgICAgICAgICAgYGAsXG4gICAgICAgICAgICBgVGhlIGRpc2N1c3MgcGhhc2Ugc2hvdWxkIHJlLWV2YWx1YXRlIHJlcXVpcmVtZW50cyBhbmQgaWRlbnRpZnkgZ2Fwcy5gLFxuICAgICAgICAgIF0uam9pbihcIlxcblwiKSwgXCJ1dGYtOFwiKTtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCB7IC8qIGJlc3QtZWZmb3J0ICovIH1cbiAgICB9XG5cbiAgICByZXR1cm4gdGFyZ2V0TWlsZXN0b25lSWQ7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8qKlxuICogUmVhZCB0aGUgYmFja3RyYWNrIHRyaWdnZXIgZmlsZSBpZiBpdCBleGlzdHMuXG4gKiBSZXR1cm5zIHRoZSBwYXJzZWQgdGFyZ2V0IG1pbGVzdG9uZSBhbmQgbWV0YWRhdGEsIG9yIG51bGwuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWFkQmFja3RyYWNrVHJpZ2dlcihiYXNlUGF0aDogc3RyaW5nKToge1xuICB0YXJnZXQ6IHN0cmluZyB8IG51bGw7XG4gIGZyb206IHN0cmluZyB8IG51bGw7XG4gIGNhcHR1cmU6IHN0cmluZztcbiAgdHJpZ2dlcmVkQXQ6IHN0cmluZztcbn0gfCBudWxsIHtcbiAgY29uc3QgdHJpZ2dlclBhdGggPSBqb2luKGdzZFJvb3QoYmFzZVBhdGgpLCBcIkJBQ0tUUkFDSy1UUklHR0VSLm1kXCIpO1xuICBpZiAoIWV4aXN0c1N5bmModHJpZ2dlclBhdGgpKSByZXR1cm4gbnVsbDtcblxuICB0cnkge1xuICAgIGNvbnN0IGNvbnRlbnQgPSByZWFkRmlsZVN5bmModHJpZ2dlclBhdGgsIFwidXRmLThcIik7XG4gICAgY29uc3QgdGFyZ2V0ID0gY29udGVudC5tYXRjaCgvXFwqXFwqVGFyZ2V0OlxcKlxcKlxccyooLispLyk/LlsxXT8udHJpbSgpID8/IG51bGw7XG4gICAgY29uc3QgZnJvbSA9IGNvbnRlbnQubWF0Y2goL1xcKlxcKkZyb206XFwqXFwqXFxzKiguKykvKT8uWzFdPy50cmltKCkgPz8gbnVsbDtcbiAgICBjb25zdCBjYXB0dXJlID0gY29udGVudC5tYXRjaCgvXFwqXFwqQ2FwdHVyZTpcXCpcXCpcXHMqKC4rKS8pPy5bMV0/LnRyaW0oKSA/PyBcIlwiO1xuICAgIGNvbnN0IHRyaWdnZXJlZEF0ID0gY29udGVudC5tYXRjaCgvXFwqXFwqVHJpZ2dlcmVkOlxcKlxcKlxccyooLispLyk/LlsxXT8udHJpbSgpID8/IFwiXCI7XG4gICAgcmV0dXJuIHtcbiAgICAgIHRhcmdldDogdGFyZ2V0ID09PSBcIih1c2VyIHRvIHNwZWNpZnkpXCIgPyBudWxsIDogdGFyZ2V0LFxuICAgICAgZnJvbSxcbiAgICAgIGNhcHR1cmUsXG4gICAgICB0cmlnZ2VyZWRBdCxcbiAgICB9O1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG4vKipcbiAqIFJlbW92ZSB0aGUgYmFja3RyYWNrIHRyaWdnZXIgYWZ0ZXIgaXQgaGFzIGJlZW4gcHJvY2Vzc2VkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY2xlYXJCYWNrdHJhY2tUcmlnZ2VyKGJhc2VQYXRoOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgdHJpZ2dlclBhdGggPSBqb2luKGdzZFJvb3QoYmFzZVBhdGgpLCBcIkJBQ0tUUkFDSy1UUklHR0VSLm1kXCIpO1xuICB0cnkge1xuICAgIGlmIChleGlzdHNTeW5jKHRyaWdnZXJQYXRoKSkge1xuICAgICAgdW5saW5rU3luYyh0cmlnZ2VyUGF0aCk7XG4gICAgfVxuICB9IGNhdGNoIHsgLyogYmVzdC1lZmZvcnQgKi8gfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRmlsZSBPdmVybGFwIERldGVjdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBEZXRlY3QgZmlsZSBvdmVybGFwIGJldHdlZW4gYSBjYXB0dXJlJ3MgYWZmZWN0ZWQgZmlsZXMgYW5kIHBsYW5uZWQgdGFza3MuXG4gKlxuICogUGFyc2VzIHRoZSBzbGljZSBwbGFuIGZvciB0YXNrIGZpbGUgcmVmZXJlbmNlcyBhbmQgcmV0dXJucyB0YXNrIElEc1xuICogd2hvc2UgZmlsZXMgb3ZlcmxhcCB3aXRoIHRoZSBjYXB0dXJlJ3MgYWZmZWN0ZWQgZmlsZXMuXG4gKlxuICogQHBhcmFtIGFmZmVjdGVkRmlsZXMgLSBGaWxlcyB0aGUgY2FwdHVyZSB3b3VsZCB0b3VjaFxuICogQHBhcmFtIHBsYW5Db250ZW50IC0gQ29udGVudCBvZiB0aGUgc2xpY2UgcGxhbi5tZFxuICogQHJldHVybnMgQXJyYXkgb2YgdGFzayBJRHMgKGUuZy4sIFtcIlQwM1wiLCBcIlQwNFwiXSkgd2hvc2UgZmlsZXMgb3ZlcmxhcFxuICovXG5leHBvcnQgZnVuY3Rpb24gZGV0ZWN0RmlsZU92ZXJsYXAoXG4gIGFmZmVjdGVkRmlsZXM6IHN0cmluZ1tdLFxuICBwbGFuQ29udGVudDogc3RyaW5nLFxuKTogc3RyaW5nW10ge1xuICBpZiAoIWFmZmVjdGVkRmlsZXMgfHwgYWZmZWN0ZWRGaWxlcy5sZW5ndGggPT09IDApIHJldHVybiBbXTtcblxuICBjb25zdCBvdmVybGFwcGluZ1Rhc2tzOiBzdHJpbmdbXSA9IFtdO1xuXG4gIC8vIE5vcm1hbGl6ZSBhZmZlY3RlZCBmaWxlcyBmb3IgY29tcGFyaXNvblxuICBjb25zdCBub3JtYWxpemVkQWZmZWN0ZWQgPSBuZXcgU2V0KFxuICAgIGFmZmVjdGVkRmlsZXMubWFwKGYgPT4gZi5yZXBsYWNlKC9eXFwuXFwvLywgXCJcIikudG9Mb3dlckNhc2UoKSksXG4gICk7XG5cbiAgLy8gUGFyc2UgcGxhbiBmb3IgaW5jb21wbGV0ZSB0YXNrcyBhbmQgdGhlaXIgZmlsZSByZWZlcmVuY2VzXG4gIGNvbnN0IHRhc2tQYXR0ZXJuID0gLy0gXFxbIFxcXSBcXCpcXCooVFxcZCspOlteKl0qXFwqXFwqL2c7XG4gIGNvbnN0IHRhc2tzID0gWy4uLnBsYW5Db250ZW50Lm1hdGNoQWxsKHRhc2tQYXR0ZXJuKV07XG5cbiAgZm9yIChjb25zdCB0YXNrTWF0Y2ggb2YgdGFza3MpIHtcbiAgICBjb25zdCB0YXNrSWQgPSB0YXNrTWF0Y2hbMV07XG4gICAgY29uc3QgdGFza1N0YXJ0ID0gdGFza01hdGNoLmluZGV4ITtcblxuICAgIC8vIEZpbmQgdGhlIGVuZCBvZiB0aGlzIHRhc2sgKG5leHQgdGFzayBvciBlbmQgb2Ygc2VjdGlvbilcbiAgICBjb25zdCBuZXh0VGFzayA9IHBsYW5Db250ZW50LmluZGV4T2YoXCItIFtcIiwgdGFza1N0YXJ0ICsgMSk7XG4gICAgY29uc3Qgc2VjdGlvbkVuZCA9IHBsYW5Db250ZW50LmluZGV4T2YoXCIjI1wiLCB0YXNrU3RhcnQgKyAxKTtcbiAgICBjb25zdCB0YXNrRW5kID0gTWF0aC5taW4oXG4gICAgICBuZXh0VGFzayA9PT0gLTEgPyBwbGFuQ29udGVudC5sZW5ndGggOiBuZXh0VGFzayxcbiAgICAgIHNlY3Rpb25FbmQgPT09IC0xID8gcGxhbkNvbnRlbnQubGVuZ3RoIDogc2VjdGlvbkVuZCxcbiAgICApO1xuXG4gICAgY29uc3QgdGFza0NvbnRlbnQgPSBwbGFuQ29udGVudC5zbGljZSh0YXNrU3RhcnQsIHRhc2tFbmQpO1xuXG4gICAgLy8gRXh0cmFjdCBmaWxlIHJlZmVyZW5jZXMgXHUyMDE0IGxvb2sgZm9yIGJhY2t0aWNrLXF1b3RlZCBwYXRoc1xuICAgIGNvbnN0IGZpbGVSZWZzID0gWy4uLnRhc2tDb250ZW50Lm1hdGNoQWxsKC9gKFteYF0rXFwuW2Etel0rKWAvZyldXG4gICAgICAubWFwKG0gPT4gbVsxXS5yZXBsYWNlKC9eXFwuXFwvLywgXCJcIikudG9Mb3dlckNhc2UoKSk7XG5cbiAgICAvLyBDaGVjayBmb3Igb3ZlcmxhcFxuICAgIGNvbnN0IGhhc092ZXJsYXAgPSBmaWxlUmVmcy5zb21lKGYgPT4gbm9ybWFsaXplZEFmZmVjdGVkLmhhcyhmKSk7XG4gICAgaWYgKGhhc092ZXJsYXApIHtcbiAgICAgIG92ZXJsYXBwaW5nVGFza3MucHVzaCh0YXNrSWQpO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBvdmVybGFwcGluZ1Rhc2tzO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRGVmZXIgTWlsZXN0b25lIENyZWF0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIEVuc3VyZSB0aGUgbWlsZXN0b25lIGRpcmVjdG9yeSBleGlzdHMgd2hlbiB0cmlhZ2UgZGVmZXJzIGEgY2FwdHVyZSB0byBhXG4gKiBub3QteWV0LWNyZWF0ZWQgbWlsZXN0b25lIChlLmcuLCBcIk0wMDVcIikuXG4gKlxuICogQ3JlYXRlcyB0aGUgZGlyZWN0b3J5IHdpdGggYSBzZWVkIENPTlRFWFQtRFJBRlQubWQgc28gdGhhdCBgZGVyaXZlU3RhdGUoKWBcbiAqIGRpc2NvdmVycyB0aGUgbWlsZXN0b25lIGFuZCBlbnRlcnMgdGhlIGRpc2N1c3Npb24gcGhhc2UgaW5zdGVhZCBvZlxuICogdHJlYXRpbmcgdGhlIHByb2plY3QgYXMgZnVsbHkgY29tcGxldGUuXG4gKlxuICogQHBhcmFtIGJhc2VQYXRoIC0gUHJvamVjdCByb290XG4gKiBAcGFyYW0gdGFyZ2V0TWlsZXN0b25lIC0gVGhlIG1pbGVzdG9uZSBJRCB0byBkZWZlciB0byAoZS5nLiwgXCJNMDA1XCIpXG4gKiBAcGFyYW0gY2FwdHVyZXMgLSBDYXB0dXJlcyBiZWluZyBkZWZlcnJlZCB0byB0aGlzIG1pbGVzdG9uZVxuICogQHJldHVybnMgdHJ1ZSBpZiB0aGUgZGlyZWN0b3J5IHdhcyBjcmVhdGVkIChvciBhbHJlYWR5IGV4aXN0ZWQpLCBmYWxzZSBvbiBlcnJvclxuICovXG5leHBvcnQgZnVuY3Rpb24gZW5zdXJlRGVmZXJNaWxlc3RvbmVEaXIoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIHRhcmdldE1pbGVzdG9uZTogc3RyaW5nLFxuICBjYXB0dXJlczogQ2FwdHVyZUVudHJ5W10sXG4pOiBib29sZWFuIHtcbiAgaWYgKCFNSUxFU1RPTkVfSURfUkUudGVzdCh0YXJnZXRNaWxlc3RvbmUpKSByZXR1cm4gZmFsc2U7XG5cbiAgY29uc3QgbXNEaXIgPSBqb2luKG1pbGVzdG9uZXNEaXIoYmFzZVBhdGgpLCB0YXJnZXRNaWxlc3RvbmUpO1xuICBpZiAoZXhpc3RzU3luYyhtc0RpcikpIHJldHVybiB0cnVlO1xuXG4gIHRyeSB7XG4gICAgbWtkaXJTeW5jKG1zRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAgIC8vIFNlZWQgQ09OVEVYVC1EUkFGVC5tZCB3aXRoIGRlZmVycmVkIGNhcHR1cmUgY29udGV4dFxuICAgIGNvbnN0IGNhcHR1cmVMaXN0ID0gY2FwdHVyZXNcbiAgICAgIC5tYXAoYyA9PiBgLSAqKiR7Yy5pZH06KiogJHtjLnRleHR9YClcbiAgICAgIC5qb2luKFwiXFxuXCIpO1xuXG4gICAgY29uc3QgZHJhZnRDb250ZW50ID0gW1xuICAgICAgYCMgJHt0YXJnZXRNaWxlc3RvbmV9OiBEZWZlcnJlZCBXb3JrYCxcbiAgICAgIGBgLFxuICAgICAgYFRoaXMgbWlsZXN0b25lIHdhcyBjcmVhdGVkIGJ5IHRyaWFnZSB3aGVuIGNhcHR1cmVzIHdlcmUgZGVmZXJyZWQgaGVyZS5gLFxuICAgICAgYERpc2N1c3Mgc2NvcGUgYW5kIGdvYWxzIGJlZm9yZSBwbGFubmluZyBzbGljZXMuYCxcbiAgICAgIGBgLFxuICAgICAgYCMjIERlZmVycmVkIENhcHR1cmVzYCxcbiAgICAgIGBgLFxuICAgICAgY2FwdHVyZUxpc3QgfHwgYChubyBjYXB0dXJlcyB5ZXQpYCxcbiAgICAgIGBgLFxuICAgIF0uam9pbihcIlxcblwiKTtcblxuICAgIGF0b21pY1dyaXRlU3luYyhcbiAgICAgIGpvaW4obXNEaXIsIGAke3RhcmdldE1pbGVzdG9uZX0tQ09OVEVYVC1EUkFGVC5tZGApLFxuICAgICAgZHJhZnRDb250ZW50LFxuICAgICAgXCJ1dGYtOFwiLFxuICAgICk7XG5cbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbi8qKlxuICogTG9hZCBkZWZlcnJlZCBjYXB0dXJlcyAoY2xhc3NpZmljYXRpb24gPT09IFwiZGVmZXJcIikgZm9yIGluamVjdGlvbiBpbnRvXG4gKiByZWFzc2Vzcy1yb2FkbWFwIHByb21wdHMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBsb2FkRGVmZXJyZWRDYXB0dXJlcyhiYXNlUGF0aDogc3RyaW5nKTogQ2FwdHVyZUVudHJ5W10ge1xuICByZXR1cm4gbG9hZEFsbENhcHR1cmVzKGJhc2VQYXRoKS5maWx0ZXIoYyA9PiBjLmNsYXNzaWZpY2F0aW9uID09PSBcImRlZmVyXCIpO1xufVxuXG4vKipcbiAqIExvYWQgcmVwbGFuLXRyaWdnZXJpbmcgY2FwdHVyZXMgZm9yIGluamVjdGlvbiBpbnRvIHJlcGxhbi1zbGljZSBwcm9tcHRzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbG9hZFJlcGxhbkNhcHR1cmVzKGJhc2VQYXRoOiBzdHJpbmcpOiBDYXB0dXJlRW50cnlbXSB7XG4gIHJldHVybiBsb2FkQWxsQ2FwdHVyZXMoYmFzZVBhdGgpLmZpbHRlcihjID0+IGMuY2xhc3NpZmljYXRpb24gPT09IFwicmVwbGFuXCIpO1xufVxuXG4vKipcbiAqIEJ1aWxkIGEgcXVpY2stdGFzayBleGVjdXRpb24gcHJvbXB0IGZyb20gYSBjYXB0dXJlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRRdWlja1Rhc2tQcm9tcHQoY2FwdHVyZTogQ2FwdHVyZUVudHJ5KTogc3RyaW5nIHtcbiAgcmV0dXJuIFtcbiAgICBgWW91IGFyZSBleGVjdXRpbmcgYSBxdWljayBvbmUtb2ZmIHRhc2sgY2FwdHVyZWQgZHVyaW5nIGEgR1NEIGF1dG8tbW9kZSBzZXNzaW9uLmAsXG4gICAgYGAsXG4gICAgYCMjIFF1aWNrIFRhc2tgLFxuICAgIGBgLFxuICAgIGAqKkNhcHR1cmUgSUQ6KiogJHtjYXB0dXJlLmlkfWAsXG4gICAgYCoqVGFzazoqKiAke2NhcHR1cmUudGV4dH1gLFxuICAgIGBgLFxuICAgIGAjIyBJbnN0cnVjdGlvbnNgLFxuICAgIGBgLFxuICAgIGAxLiAqKlZlcmlmeSB0aGUgaXNzdWUgc3RpbGwgZXhpc3RzLioqIEJlZm9yZSBtYWtpbmcgYW55IGNoYW5nZXMsIGluc3BlY3QgdGhlYCxcbiAgICBgICAgcmVsZXZhbnQgY29kZSB0byBjb25maXJtIHRoZSBwcm9ibGVtIGRlc2NyaWJlZCBhYm92ZSBpcyBhY3R1YWxseSBwcmVzZW50IGluYCxcbiAgICBgICAgdGhlIGN1cnJlbnQgY29kZWJhc2UuIElmIHRoZSBpc3N1ZSBoYXMgYWxyZWFkeSBiZWVuIGZpeGVkIChlLmcuLCBieSBwbGFubmVkYCxcbiAgICBgICAgbWlsZXN0b25lIHdvcmspLCByZXBvcnQgXCJBbHJlYWR5IHJlc29sdmVkIFx1MjAxNCBubyBjaGFuZ2VzIG5lZWRlZC5cIiBhbmQgc3RvcC5gLFxuICAgIGAyLiBFeGVjdXRlIHRoaXMgdGFzayBhcyBhIHNtYWxsLCBzZWxmLWNvbnRhaW5lZCBjaGFuZ2UuYCxcbiAgICBgMy4gRG8gTk9UIG1vZGlmeSBhbnkgXFxgLmdzZC9cXGAgcGxhbiBmaWxlcyBcdTIwMTQgdGhpcyBpcyBhIG9uZS1vZmYsIG5vdCBhIHBsYW5uZWQgdGFzay5gLFxuICAgIGA0LiBDb21taXQgeW91ciBjaGFuZ2VzIHdpdGggYSBkZXNjcmlwdGl2ZSBtZXNzYWdlLmAsXG4gICAgYDUuIEtlZXAgY2hhbmdlcyBtaW5pbWFsIGFuZCBmb2N1c2VkIG9uIHRoZSBjYXB0dXJlIHRleHQuYCxcbiAgICBgNi4gV2hlbiBkb25lLCBzYXk6IFwiUXVpY2sgdGFzayBjb21wbGV0ZS5cImAsXG4gIF0uam9pbihcIlxcblwiKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFBvc3QtVHJpYWdlIFJlc29sdXRpb24gRXhlY3V0b3IgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogUmVzdWx0IG9mIGV4ZWN1dGluZyB0cmlhZ2UgcmVzb2x1dGlvbnMgYWZ0ZXIgYSB0cmlhZ2UtY2FwdHVyZXMgdW5pdCBjb21wbGV0ZXMuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgVHJpYWdlRXhlY3V0aW9uUmVzdWx0IHtcbiAgLyoqIE51bWJlciBvZiBpbmplY3QgcmVzb2x1dGlvbnMgZXhlY3V0ZWQgKHRhc2tzIGFkZGVkIHRvIHBsYW4pICovXG4gIGluamVjdGVkOiBudW1iZXI7XG4gIC8qKiBOdW1iZXIgb2YgcmVwbGFuIHRyaWdnZXJzIHdyaXR0ZW4gKi9cbiAgcmVwbGFubmVkOiBudW1iZXI7XG4gIC8qKiBOdW1iZXIgb2YgZGVmZXIgbWlsZXN0b25lIGRpcmVjdG9yaWVzIGNyZWF0ZWQgKi9cbiAgZGVmZXJyZWRNaWxlc3RvbmVzOiBudW1iZXI7XG4gIC8qKiBDYXB0dXJlcyBjbGFzc2lmaWVkIGFzIHF1aWNrLXRhc2sgdGhhdCBuZWVkIGRpc3BhdGNoICovXG4gIHF1aWNrVGFza3M6IENhcHR1cmVFbnRyeVtdO1xuICAvKiogTnVtYmVyIG9mIHN0b3AgZGlyZWN0aXZlcyAod2lsbCBwYXVzZSBhdXRvLW1vZGUgdmlhIGd1YXJkKSAqL1xuICBzdG9wcGVkOiBudW1iZXI7XG4gIC8qKiBCYWNrdHJhY2sgY2FwdHVyZXMgKHdpbGwgdHJpZ2dlciBtaWxlc3RvbmUgcmVncmVzc2lvbiB2aWEgZ3VhcmQpICovXG4gIGJhY2t0cmFja3M6IENhcHR1cmVFbnRyeVtdO1xuICAvKiogRGV0YWlscyBvZiBlYWNoIGFjdGlvbiB0YWtlbiwgZm9yIGxvZ2dpbmcgKi9cbiAgYWN0aW9uczogc3RyaW5nW107XG59XG5cbi8qKlxuICogRXhlY3V0ZSBwZW5kaW5nIHRyaWFnZSByZXNvbHV0aW9ucy5cbiAqXG4gKiBDYWxsZWQgYWZ0ZXIgYSB0cmlhZ2UtY2FwdHVyZXMgdW5pdCBjb21wbGV0ZXMuIFJlYWRzIENBUFRVUkVTLm1kIGZvclxuICogcmVzb2x2ZWQgY2FwdHVyZXMgdGhhdCBoYXZlIGFjdGlvbmFibGUgY2xhc3NpZmljYXRpb25zIChpbmplY3QsIHJlcGxhbixcbiAqIHF1aWNrLXRhc2spIGJ1dCBoYXZlbid0IGJlZW4gZXhlY3V0ZWQgeWV0LCB0aGVuOlxuICpcbiAqIC0gaW5qZWN0OiBjYWxscyBleGVjdXRlSW5qZWN0KCkgdG8gYWRkIGEgdGFzayB0byB0aGUgY3VycmVudCBzbGljZSBwbGFuXG4gKiAtIHJlcGxhbjogY2FsbHMgZXhlY3V0ZVJlcGxhbigpIHRvIHdyaXRlIHRoZSBSRVBMQU4tVFJJR0dFUi5tZCBtYXJrZXJcbiAqIC0gcXVpY2stdGFzazogY29sbGVjdHMgZm9yIGRpc3BhdGNoIChjYWxsZXIgaGFuZGxlcyBkaXNwYXRjaGluZyBxdWljay10YXNrIHVuaXRzKVxuICpcbiAqIEVhY2ggY2FwdHVyZSBpcyBtYXJrZWQgYXMgZXhlY3V0ZWQgYWZ0ZXIgaXRzIHJlc29sdXRpb24gYWN0aW9uIHN1Y2NlZWRzLFxuICogcHJldmVudGluZyBkb3VibGUtZXhlY3V0aW9uIG9uIHJldHJpZXMgb3IgcmVzdGFydHMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBleGVjdXRlVHJpYWdlUmVzb2x1dGlvbnMoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIG1pZDogc3RyaW5nLFxuICBzaWQ6IHN0cmluZyxcbik6IFRyaWFnZUV4ZWN1dGlvblJlc3VsdCB7XG4gIGNvbnN0IHJlc3VsdDogVHJpYWdlRXhlY3V0aW9uUmVzdWx0ID0ge1xuICAgIGluamVjdGVkOiAwLFxuICAgIHJlcGxhbm5lZDogMCxcbiAgICBkZWZlcnJlZE1pbGVzdG9uZXM6IDAsXG4gICAgcXVpY2tUYXNrczogW10sXG4gICAgc3RvcHBlZDogMCxcbiAgICBiYWNrdHJhY2tzOiBbXSxcbiAgICBhY3Rpb25zOiBbXSxcbiAgfTtcblxuICBjb25zdCBhY3Rpb25hYmxlID0gbG9hZEFjdGlvbmFibGVDYXB0dXJlcyhiYXNlUGF0aCwgbWlkIHx8IHVuZGVmaW5lZCk7XG5cbiAgLy8gUmVjb25jaWxpYXRpb246IHN0YW1wIGFjdGlvbmFibGUgY2FwdHVyZXMgdGhhdCBhcmUgbWlzc2luZyB0aGUgTWlsZXN0b25lIGZpZWxkXG4gIC8vIHdpdGggdGhlIGN1cnJlbnQgbWlsZXN0b25lIElELiAgVGhpcyBjb3ZlcnMgY2FwdHVyZXMgcmVzb2x2ZWQgYnkgdGhlIHRyaWFnZSBMTE1cbiAgLy8gYmVmb3JlIHRoZSBwcm9tcHQgaW5jbHVkZWQgdGhlIE1pbGVzdG9uZSBpbnN0cnVjdGlvbiwgYW5kIGFjdHMgYXMgYSBzYWZldHkgbmV0XG4gIC8vIHdoZW4gdGhlIExMTSBvbWl0cyB0aGUgZmllbGQgKCMyODcyKS5cbiAgaWYgKG1pZCkge1xuICAgIGZvciAoY29uc3QgY2FwdHVyZSBvZiBhY3Rpb25hYmxlKSB7XG4gICAgICBpZiAoIWNhcHR1cmUucmVzb2x2ZWRJbk1pbGVzdG9uZSkge1xuICAgICAgICBzdGFtcENhcHR1cmVNaWxlc3RvbmUoYmFzZVBhdGgsIGNhcHR1cmUuaWQsIG1pZCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gQWxzbyBwcm9jZXNzIGRlZmVycmVkIGFuZCBtaWxlc3RvbmUtY2xhc3MgY2FwdHVyZXMgKCMzNTQyKS5cbiAgLy8gQSBkZWZlci9taWxlc3RvbmUgY2FwdHVyZSdzIFwiYWN0aW9uXCIgaXMgdGhlIHRyaWFnZSBkZWNpc2lvbiBpdHNlbGYgXHUyMDE0XG4gIC8vIG9uY2UgY2xhc3NpZmllZCBhbmQgcmVzb2x2ZWQsIHRoZSBjYXB0dXJlIGlzIGRvbmUuIFRoZSB0YXJnZXQgbWlsZXN0b25lXG4gIC8vIHBpY2tzIHVwIHRoZSB3b3JrIG5hdHVyYWxseSBmcm9tIGl0cyBwbGFubmluZyBjb250ZXh0LlxuICBjb25zdCBkZWZlcnJhYmxlID0gbG9hZEFsbENhcHR1cmVzKGJhc2VQYXRoKS5maWx0ZXIoXG4gICAgYyA9PiBjLnN0YXR1cyA9PT0gXCJyZXNvbHZlZFwiICYmICFjLmV4ZWN1dGVkICYmXG4gICAgICAoYy5jbGFzc2lmaWNhdGlvbiA9PT0gXCJkZWZlclwiIHx8IChjLmNsYXNzaWZpY2F0aW9uIGFzIHN0cmluZykgPT09IFwibWlsZXN0b25lXCIpLFxuICApO1xuICBpZiAoZGVmZXJyYWJsZS5sZW5ndGggPiAwKSB7XG4gICAgLy8gR3JvdXAgY2FwdHVyZXMgdGhhdCByZWZlcmVuY2UgYSBzcGVjaWZpYyBtaWxlc3RvbmUgXHUyMDE0IGNyZWF0ZSBkaXJzIGFzIG5lZWRlZC5cbiAgICBjb25zdCBieU1pbGVzdG9uZSA9IG5ldyBNYXA8c3RyaW5nLCBDYXB0dXJlRW50cnlbXT4oKTtcbiAgICBmb3IgKGNvbnN0IGNhcCBvZiBkZWZlcnJhYmxlKSB7XG4gICAgICBjb25zdCB0YXJnZXQgPSBjYXAucmVzb2x1dGlvbj8ubWF0Y2goL1xcYihNXFxkezN9KD86LVthLXowLTldezZ9KT8pXFxiLyk/LlsxXTtcbiAgICAgIGlmICh0YXJnZXQpIHtcbiAgICAgICAgY29uc3QgbGlzdCA9IGJ5TWlsZXN0b25lLmdldCh0YXJnZXQpID8/IFtdO1xuICAgICAgICBsaXN0LnB1c2goY2FwKTtcbiAgICAgICAgYnlNaWxlc3RvbmUuc2V0KHRhcmdldCwgbGlzdCk7XG4gICAgICB9XG4gICAgfVxuICAgIGZvciAoY29uc3QgW21pbGVzdG9uZUlkLCBjYXB0dXJlc10gb2YgYnlNaWxlc3RvbmUpIHtcbiAgICAgIGNvbnN0IG1zRGlyID0gam9pbihtaWxlc3RvbmVzRGlyKGJhc2VQYXRoKSwgbWlsZXN0b25lSWQpO1xuICAgICAgaWYgKCFleGlzdHNTeW5jKG1zRGlyKSkge1xuICAgICAgICBjb25zdCBjcmVhdGVkID0gZW5zdXJlRGVmZXJNaWxlc3RvbmVEaXIoYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBjYXB0dXJlcyk7XG4gICAgICAgIGlmIChjcmVhdGVkKSB7XG4gICAgICAgICAgcmVzdWx0LmRlZmVycmVkTWlsZXN0b25lcysrO1xuICAgICAgICAgIHJlc3VsdC5hY3Rpb25zLnB1c2goYENyZWF0ZWQgbWlsZXN0b25lICR7bWlsZXN0b25lSWR9IGZvciAke2NhcHR1cmVzLmxlbmd0aH0gZGVmZXJyZWQgY2FwdHVyZShzKWApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIC8vIFN0YW1wIEFMTCBkZWZlci9taWxlc3RvbmUgY2FwdHVyZXMgYXMgZXhlY3V0ZWQgKCMzNTQyIGdhcHMgMS0zKS5cbiAgICAvLyBQcmV2aW91c2x5IG9ubHkgY2FwdHVyZXMgdGhhdCB0cmlnZ2VyZWQgZGlyIGNyZWF0aW9uIHdlcmUgc3RhbXBlZC5cbiAgICAvLyBDYXB0dXJlcyB3aXRob3V0IGEgbWlsZXN0b25lIElEIGluIHJlc29sdXRpb24gdGV4dCwgb3IgdGFyZ2V0aW5nIGFuXG4gICAgLy8gZXhpc3RpbmcgZGlyZWN0b3J5LCB3ZXJlIHNpbGVudGx5IGRyb3BwZWQgXHUyMDE0IG5ldmVyIHN0YW1wZWQuXG4gICAgZm9yIChjb25zdCBjYXAgb2YgZGVmZXJyYWJsZSkge1xuICAgICAgaWYgKCFjYXAuZXhlY3V0ZWQpIHtcbiAgICAgICAgbWFya0NhcHR1cmVFeGVjdXRlZChiYXNlUGF0aCwgY2FwLmlkKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyBNYXJrIG5vdGUgY2FwdHVyZXMgYXMgZXhlY3V0ZWQgXHUyMDE0IHRoZXkncmUgaW5mb3JtYXRpb25hbCBvbmx5LCBubyBhY3Rpb25cbiAgLy8gbmVlZGVkLiBXaXRob3V0IHRoaXMgdGhleSBzdGF5IGluIFwicmVzb2x2ZWQgYnV0IG5vdCBleGVjdXRlZFwiIGxpbWJvICgjMzU3OCkuXG4gIGNvbnN0IG5vdGVzID0gbG9hZEFsbENhcHR1cmVzKGJhc2VQYXRoKS5maWx0ZXIoXG4gICAgYyA9PiBjLnN0YXR1cyA9PT0gXCJyZXNvbHZlZFwiICYmICFjLmV4ZWN1dGVkICYmIGMuY2xhc3NpZmljYXRpb24gPT09IFwibm90ZVwiLFxuICApO1xuICBmb3IgKGNvbnN0IGNhcCBvZiBub3Rlcykge1xuICAgIG1hcmtDYXB0dXJlRXhlY3V0ZWQoYmFzZVBhdGgsIGNhcC5pZCk7XG4gICAgcmVzdWx0LmFjdGlvbnMucHVzaChgTm90ZSBhY2tub3dsZWRnZWQ6ICR7Y2FwLmlkfSBcdTIwMTQgXCIke2NhcC50ZXh0fVwiYCk7XG4gIH1cblxuICBpZiAoYWN0aW9uYWJsZS5sZW5ndGggPT09IDApIHJldHVybiByZXN1bHQ7XG5cbiAgZm9yIChjb25zdCBjYXB0dXJlIG9mIGFjdGlvbmFibGUpIHtcbiAgICBzd2l0Y2ggKGNhcHR1cmUuY2xhc3NpZmljYXRpb24pIHtcbiAgICAgIGNhc2UgXCJpbmplY3RcIjoge1xuICAgICAgICBjb25zdCBuZXdUYXNrSWQgPSBleGVjdXRlSW5qZWN0KGJhc2VQYXRoLCBtaWQsIHNpZCwgY2FwdHVyZSk7XG4gICAgICAgIGlmIChuZXdUYXNrSWQpIHtcbiAgICAgICAgICBtYXJrQ2FwdHVyZUV4ZWN1dGVkKGJhc2VQYXRoLCBjYXB0dXJlLmlkKTtcbiAgICAgICAgICByZXN1bHQuaW5qZWN0ZWQrKztcbiAgICAgICAgICByZXN1bHQuYWN0aW9ucy5wdXNoKGBJbmplY3RlZCAke25ld1Rhc2tJZH0gZnJvbSAke2NhcHR1cmUuaWR9OiBcIiR7Y2FwdHVyZS50ZXh0fVwiYCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcmVzdWx0LmFjdGlvbnMucHVzaChgRmFpbGVkIHRvIGluamVjdCAke2NhcHR1cmUuaWR9OiBcIiR7Y2FwdHVyZS50ZXh0fVwiIChubyBwbGFuIGZpbGUgb3IgcGFyc2UgZXJyb3IpYCk7XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwicmVwbGFuXCI6IHtcbiAgICAgICAgY29uc3Qgc3VjY2VzcyA9IGV4ZWN1dGVSZXBsYW4oYmFzZVBhdGgsIG1pZCwgc2lkLCBjYXB0dXJlKTtcbiAgICAgICAgaWYgKHN1Y2Nlc3MpIHtcbiAgICAgICAgICBtYXJrQ2FwdHVyZUV4ZWN1dGVkKGJhc2VQYXRoLCBjYXB0dXJlLmlkKTtcbiAgICAgICAgICByZXN1bHQucmVwbGFubmVkKys7XG4gICAgICAgICAgcmVzdWx0LmFjdGlvbnMucHVzaChgUmVwbGFuIHRyaWdnZXJlZCBmcm9tICR7Y2FwdHVyZS5pZH06IFwiJHtjYXB0dXJlLnRleHR9XCJgKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICByZXN1bHQuYWN0aW9ucy5wdXNoKGBGYWlsZWQgdG8gdHJpZ2dlciByZXBsYW4gZnJvbSAke2NhcHR1cmUuaWR9OiBcIiR7Y2FwdHVyZS50ZXh0fVwiYCk7XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwicXVpY2stdGFza1wiOiB7XG4gICAgICAgIC8vIFF1aWNrLXRhc2tzIGFyZSBjb2xsZWN0ZWQgZm9yIGRpc3BhdGNoLCBub3QgZXhlY3V0ZWQgaW5saW5lXG4gICAgICAgIHJlc3VsdC5xdWlja1Rhc2tzLnB1c2goY2FwdHVyZSk7XG4gICAgICAgIHJlc3VsdC5hY3Rpb25zLnB1c2goYFF1aWNrLXRhc2sgcXVldWVkIGZyb20gJHtjYXB0dXJlLmlkfTogXCIke2NhcHR1cmUudGV4dH1cImApO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyBDb3VudCBzdG9wL2JhY2t0cmFjayBjYXB0dXJlcyBcdTIwMTQgdGhlc2UgYXJlIGhhbmRsZWQgYnkgdGhlIHByZS1kaXNwYXRjaCBndWFyZFxuICAvLyBpbiBydW5HdWFyZHMoKSwgbm90IGhlcmUuIFdlIGp1c3QgcmVwb3J0IHRoZW0gZm9yIGxvZ2dpbmcgcHVycG9zZXMuXG4gIGNvbnN0IGFsbENhcHR1cmVzID0gbG9hZEFsbENhcHR1cmVzKGJhc2VQYXRoKTtcbiAgZm9yIChjb25zdCBjYXAgb2YgYWxsQ2FwdHVyZXMpIHtcbiAgICBpZiAoY2FwLnN0YXR1cyAhPT0gXCJyZXNvbHZlZFwiIHx8IGNhcC5leGVjdXRlZCkgY29udGludWU7XG4gICAgaWYgKGNhcC5jbGFzc2lmaWNhdGlvbiA9PT0gXCJzdG9wXCIpIHtcbiAgICAgIHJlc3VsdC5zdG9wcGVkKys7XG4gICAgICByZXN1bHQuYWN0aW9ucy5wdXNoKGBTdG9wIGRpcmVjdGl2ZSBmcm9tICR7Y2FwLmlkfTogXCIke2NhcC50ZXh0fVwiIFx1MjAxNCB3aWxsIHBhdXNlIG9uIG5leHQgZGlzcGF0Y2hgKTtcbiAgICB9IGVsc2UgaWYgKGNhcC5jbGFzc2lmaWNhdGlvbiA9PT0gXCJiYWNrdHJhY2tcIikge1xuICAgICAgcmVzdWx0LmJhY2t0cmFja3MucHVzaChjYXApO1xuICAgICAgcmVzdWx0LmFjdGlvbnMucHVzaChgQmFja3RyYWNrIGRpcmVjdGl2ZSBmcm9tICR7Y2FwLmlkfTogXCIke2NhcC50ZXh0fVwiIFx1MjAxNCB3aWxsIHRyaWdnZXIgbWlsZXN0b25lIHJlZ3Jlc3Npb24gb24gbmV4dCBkaXNwYXRjaGApO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiByZXN1bHQ7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFZQSxTQUFTLFlBQVksV0FBVyxjQUFjLGtCQUFrQjtBQUNoRSxTQUFTLHVCQUF1QjtBQUNoQyxTQUFTLFlBQVk7QUFDckIsU0FBUyxxQkFBcUI7QUFDOUIsU0FBUyxTQUFTLHFCQUFxQjtBQUN2QyxTQUFTLHVCQUF1QjtBQUVoQztBQUFBLEVBRUU7QUFBQSxFQUNBO0FBQUEsRUFFQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBU0EsU0FBUyxjQUNkLFVBQ0EsS0FDQSxLQUNBLFNBQ2U7QUFDZixNQUFJO0FBRUYsVUFBTSxXQUFXLEtBQUss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
