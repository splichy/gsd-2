import { existsSync, readFileSync, unlinkSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { nativeRevertCommit, nativeRevertAbort } from "./native-git-bridge.js";
import { atomicWriteSync } from "./atomic-write.js";
import { parseUnitId } from "./unit-id.js";
import { deriveState } from "./state.js";
import { invalidateAllCaches } from "./cache.js";
import { gsdRoot, resolveTasksDir, resolveSlicePath, resolveTaskFile, buildTaskFileName, buildSliceFileName } from "./paths.js";
import { sendDesktopNotification } from "./notifications.js";
import { getTask, getSlice, getSliceTasks, updateTaskStatus, updateSliceStatus } from "./gsd-db.js";
import { renderPlanCheckboxes, renderRoadmapCheckboxes } from "./markdown-renderer.js";
async function handleUndo(args, ctx, _pi, basePath) {
  const force = args.includes("--force");
  const activityDir = join(gsdRoot(basePath), "activity");
  if (!existsSync(activityDir)) {
    ctx.ui.notify("Nothing to undo \u2014 no activity logs found.", "info");
    return;
  }
  const files = readdirSync(activityDir).filter((f) => f.endsWith(".jsonl")).sort().reverse();
  if (files.length === 0) {
    ctx.ui.notify("Nothing to undo \u2014 no activity logs found.", "info");
    return;
  }
  const match = files[0].match(/^\d+-(.+?)-(.+)\.jsonl$/);
  if (!match) {
    ctx.ui.notify("Nothing to undo \u2014 could not parse latest activity log.", "warning");
    return;
  }
  const unitType = match[1];
  const unitId = match[2].replace(/-/g, "/");
  if (!force) {
    ctx.ui.notify(
      `Will undo: ${unitType} (${unitId})
This will:
  - Delete summary artifacts
  - Uncheck task in PLAN (if execute-task)
  - Attempt to revert associated git commits

Run /gsd undo --force to confirm.`,
      "warning"
    );
    return;
  }
  const { milestone, slice, task } = parseUnitId(unitId);
  let summaryRemoved = false;
  if (task !== void 0 && slice !== void 0) {
    const [mid, sid, tid] = [milestone, slice, task];
    const tasksDir = resolveTasksDir(basePath, mid, sid);
    if (tasksDir) {
      const summaryFile = join(tasksDir, buildTaskFileName(tid, "SUMMARY"));
      if (existsSync(summaryFile)) {
        unlinkSync(summaryFile);
        summaryRemoved = true;
      }
    }
  } else if (slice !== void 0) {
    const [mid, sid] = [milestone, slice];
    const slicePath = resolveSlicePath(basePath, mid, sid);
    if (slicePath) {
      for (const suffix of ["SUMMARY", "COMPLETE"]) {
        const candidates = findFileWithPrefix(slicePath, sid, suffix);
        for (const f of candidates) {
          unlinkSync(f);
          summaryRemoved = true;
        }
      }
    }
  }
  let planUpdated = false;
  if (unitType === "execute-task" && task !== void 0 && slice !== void 0) {
    const [mid, sid, tid] = [milestone, slice, task];
    planUpdated = uncheckTaskInPlan(basePath, mid, sid, tid);
  }
  let commitsReverted = 0;
  try {
    const commits = findCommitsForUnit(activityDir, unitType, unitId);
    if (commits.length > 0) {
      for (const sha of commits.reverse()) {
        try {
          nativeRevertCommit(basePath, sha);
          commitsReverted++;
        } catch {
          try {
            nativeRevertAbort(basePath);
          } catch {
          }
          break;
        }
      }
    }
  } finally {
    invalidateAllCaches();
    await deriveState(basePath);
  }
  const results = [`Undone: ${unitType} (${unitId})`];
  if (summaryRemoved) results.push(`  - Deleted summary artifact`);
  if (planUpdated) results.push(`  - Unchecked task in PLAN`);
  if (commitsReverted > 0) {
    results.push(`  - Reverted ${commitsReverted} commit(s) (staged, not committed)`);
    results.push(`  Review with 'git diff --cached' then 'git commit' or 'git reset HEAD'`);
  }
  ctx.ui.notify(results.join("\n"), "success");
  sendDesktopNotification("GSD", `Undone: ${unitType} (${unitId})`, "info", "complete", basename(basePath));
}
async function parseTaskId(raw, basePath) {
  const parts = raw.split("/");
  if (parts.length === 3) {
    return { mid: parts[0], sid: parts[1], tid: parts[2] };
  }
  const state = await deriveState(basePath);
  if (parts.length === 2) {
    const mid = state.activeMilestone?.id;
    if (!mid) return "Cannot resolve milestone \u2014 no active milestone in state.";
    return { mid, sid: parts[0], tid: parts[1] };
  }
  if (parts.length === 1) {
    const mid = state.activeMilestone?.id;
    const sid = state.activeSlice?.id;
    if (!mid) return "Cannot resolve milestone \u2014 no active milestone in state.";
    if (!sid) return "Cannot resolve slice \u2014 no active slice in state.";
    return { mid, sid, tid: parts[0] };
  }
  return "Invalid task ID format. Use T01, S01/T01, or M001/S01/T01.";
}
async function parseSliceId(raw, basePath) {
  const parts = raw.split("/");
  if (parts.length === 2) {
    return { mid: parts[0], sid: parts[1] };
  }
  if (parts.length === 1) {
    const state = await deriveState(basePath);
    const mid = state.activeMilestone?.id;
    if (!mid) return "Cannot resolve milestone \u2014 no active milestone in state.";
    return { mid, sid: parts[0] };
  }
  return "Invalid slice ID format. Use S01 or M001/S01.";
}
async function handleUndoTask(args, ctx, _pi, basePath) {
  const force = args.includes("--force");
  const rawId = args.replace("--force", "").trim();
  if (!rawId) {
    ctx.ui.notify(
      "Usage: /gsd undo-task <taskId> [--force]\n\nAccepts: T01, S01/T01, or M001/S01/T01\nResets the task's DB status to pending and re-renders plan checkboxes.",
      "warning"
    );
    return;
  }
  const parsed = await parseTaskId(rawId, basePath);
  if (typeof parsed === "string") {
    ctx.ui.notify(parsed, "error");
    return;
  }
  const { mid, sid, tid } = parsed;
  const task = getTask(mid, sid, tid);
  if (!task) {
    ctx.ui.notify(`Task ${mid}/${sid}/${tid} not found in database.`, "error");
    return;
  }
  if (!force) {
    ctx.ui.notify(
      `Will reset: task ${mid}/${sid}/${tid}
  Current status: ${task.status}
This will:
  - Set task status to "pending" in DB
  - Delete task summary file (if exists)
  - Re-render plan checkboxes

Run /gsd undo-task ${rawId} --force to confirm.`,
      "warning"
    );
    return;
  }
  updateTaskStatus(mid, sid, tid, "pending");
  let summaryDeleted = false;
  const summaryPath = resolveTaskFile(basePath, mid, sid, tid, "SUMMARY");
  if (summaryPath && existsSync(summaryPath)) {
    unlinkSync(summaryPath);
    summaryDeleted = true;
  }
  await renderPlanCheckboxes(basePath, mid, sid);
  invalidateAllCaches();
  const results = [`Reset task ${mid}/${sid}/${tid} to "pending".`];
  if (summaryDeleted) results.push("  - Deleted task summary file");
  results.push("  - Plan checkboxes re-rendered");
  ctx.ui.notify(results.join("\n"), "success");
}
async function handleResetSlice(args, ctx, _pi, basePath) {
  const force = args.includes("--force");
  const rawId = args.replace("--force", "").trim();
  if (!rawId) {
    ctx.ui.notify(
      "Usage: /gsd reset-slice <sliceId> [--force]\n\nAccepts: S01 or M001/S01\nResets the slice and all its tasks, re-renders plan + roadmap checkboxes.",
      "warning"
    );
    return;
  }
  const parsed = await parseSliceId(rawId, basePath);
  if (typeof parsed === "string") {
    ctx.ui.notify(parsed, "error");
    return;
  }
  const { mid, sid } = parsed;
  const slice = getSlice(mid, sid);
  if (!slice) {
    ctx.ui.notify(`Slice ${mid}/${sid} not found in database.`, "error");
    return;
  }
  const tasks = getSliceTasks(mid, sid);
  if (!force) {
    ctx.ui.notify(
      `Will reset: slice ${mid}/${sid}
  Current status: ${slice.status}
  Tasks to reset: ${tasks.length}
This will:
  - Set all task statuses to "pending" in DB
  - Set slice status to "active" in DB
  - Delete task summary files, slice summary, and UAT files
  - Re-render plan + roadmap checkboxes

Run /gsd reset-slice ${rawId} --force to confirm.`,
      "warning"
    );
    return;
  }
  let tasksReset = 0;
  let summariesDeleted = 0;
  for (const t of tasks) {
    updateTaskStatus(mid, sid, t.id, "pending");
    tasksReset++;
    const summaryPath = resolveTaskFile(basePath, mid, sid, t.id, "SUMMARY");
    if (summaryPath && existsSync(summaryPath)) {
      unlinkSync(summaryPath);
      summariesDeleted++;
    }
  }
  updateSliceStatus(mid, sid, "active");
  let sliceFilesDeleted = 0;
  const slicePath = resolveSlicePath(basePath, mid, sid);
  if (slicePath) {
    for (const suffix of ["SUMMARY", "UAT"]) {
      const filePath = join(slicePath, buildSliceFileName(sid, suffix));
      if (existsSync(filePath)) {
        unlinkSync(filePath);
        sliceFilesDeleted++;
      }
    }
  }
  await renderPlanCheckboxes(basePath, mid, sid);
  await renderRoadmapCheckboxes(basePath, mid);
  invalidateAllCaches();
  const results = [
    `Reset slice ${mid}/${sid} to "active".`,
    `  - ${tasksReset} task(s) reset to "pending"`
  ];
  if (summariesDeleted > 0) results.push(`  - ${summariesDeleted} task summary file(s) deleted`);
  if (sliceFilesDeleted > 0) results.push(`  - ${sliceFilesDeleted} slice file(s) deleted (summary/UAT)`);
  results.push("  - Plan + roadmap checkboxes re-rendered");
  ctx.ui.notify(results.join("\n"), "success");
}
function uncheckTaskInPlan(basePath, mid, sid, tid) {
  const slicePath = resolveSlicePath(basePath, mid, sid);
  if (!slicePath) return false;
  const planCandidates = findFileWithPrefix(slicePath, sid, "PLAN");
  if (planCandidates.length === 0) return false;
  const planFile = planCandidates[0];
  let content = readFileSync(planFile, "utf-8");
  const regex = new RegExp(`^(\\s*-\\s*)\\[x\\](\\s*\\**${tid}\\**[:\\s])`, "mi");
  if (regex.test(content)) {
    content = content.replace(regex, "$1[ ]$2");
    atomicWriteSync(planFile, content);
    return true;
  }
  return false;
}
function findFileWithPrefix(dir, prefix, suffix) {
  try {
    const files = readdirSync(dir);
    return files.filter((f) => f.includes(suffix) && (f.startsWith(prefix) || f.startsWith(`${prefix}-`))).map((f) => join(dir, f));
  } catch {
    return [];
  }
}
function findCommitsForUnit(activityDir, unitType, unitId) {
  const safeUnitId = unitId.replace(/\//g, "-");
  const commitSet = /* @__PURE__ */ new Set();
  const commits = [];
  try {
    const files = readdirSync(activityDir).filter((f) => f.includes(unitType) && f.includes(safeUnitId) && f.endsWith(".jsonl")).sort().reverse();
    if (files.length === 0) return [];
    const content = readFileSync(join(activityDir, files[0]), "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry?.message?.content) {
          const blocks = Array.isArray(entry.message.content) ? entry.message.content : [];
          for (const block of blocks) {
            if (block.type === "tool_result" && typeof block.content === "string") {
              for (const sha of extractCommitShas(block.content)) {
                if (!commitSet.has(sha)) {
                  commitSet.add(sha);
                  commits.push(sha);
                }
              }
            }
          }
        }
      } catch {
      }
    }
  } catch {
  }
  return commits;
}
function extractCommitShas(content) {
  const seen = /* @__PURE__ */ new Set();
  const commits = [];
  for (const match of content.matchAll(/\[[\w/.-]+\s+([a-f0-9]{7,40})\]/g)) {
    const sha = match[1];
    if (sha && !seen.has(sha)) {
      seen.add(sha);
      commits.push(sha);
    }
  }
  return commits;
}
export {
  extractCommitShas,
  findCommitsForUnit,
  handleResetSlice,
  handleUndo,
  handleUndoTask,
  uncheckTaskInPlan
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC91bmRvLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBHU0QgRXh0ZW5zaW9uIFx1MjAxNCBVbmRvIExhc3QgVW5pdCArIFRhcmdldGVkIFN0YXRlIFJlc2V0XG4vLyBoYW5kbGVVbmRvOiBSb2xsYmFjayB0aGUgbW9zdCByZWNlbnQgY29tcGxldGVkIHVuaXQgKHJldmVydCBnaXQsIHJlbW92ZSBzdGF0ZSwgdW5jaGVjayBwbGFucykuXG4vLyBoYW5kbGVVbmRvVGFzazogUmVzZXQgYSBzaW5nbGUgdGFzaydzIERCIHN0YXR1cyB0byBcInBlbmRpbmdcIiBhbmQgcmUtcmVuZGVyIG1hcmtkb3duLlxuLy8gaGFuZGxlUmVzZXRTbGljZTogUmVzZXQgYSBzbGljZSBhbmQgYWxsIGl0cyB0YXNrcywgcmUtcmVuZGVyaW5nIHBsYW4gKyByb2FkbWFwLlxuXG5pbXBvcnQgdHlwZSB7IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LCBFeHRlbnNpb25BUEkgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMsIHJlYWRGaWxlU3luYywgdW5saW5rU3luYywgcmVhZGRpclN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiwgYmFzZW5hbWUgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBuYXRpdmVSZXZlcnRDb21taXQsIG5hdGl2ZVJldmVydEFib3J0IH0gZnJvbSBcIi4vbmF0aXZlLWdpdC1icmlkZ2UuanNcIjtcbmltcG9ydCB7IGF0b21pY1dyaXRlU3luYyB9IGZyb20gXCIuL2F0b21pYy13cml0ZS5qc1wiO1xuaW1wb3J0IHsgcGFyc2VVbml0SWQgfSBmcm9tIFwiLi91bml0LWlkLmpzXCI7XG5pbXBvcnQgeyBkZXJpdmVTdGF0ZSB9IGZyb20gXCIuL3N0YXRlLmpzXCI7XG5pbXBvcnQgeyBpbnZhbGlkYXRlQWxsQ2FjaGVzIH0gZnJvbSBcIi4vY2FjaGUuanNcIjtcbmltcG9ydCB7IGdzZFJvb3QsIHJlc29sdmVUYXNrc0RpciwgcmVzb2x2ZVNsaWNlUGF0aCwgcmVzb2x2ZVRhc2tGaWxlLCBidWlsZFRhc2tGaWxlTmFtZSwgYnVpbGRTbGljZUZpbGVOYW1lIH0gZnJvbSBcIi4vcGF0aHMuanNcIjtcbmltcG9ydCB7IHNlbmREZXNrdG9wTm90aWZpY2F0aW9uIH0gZnJvbSBcIi4vbm90aWZpY2F0aW9ucy5qc1wiO1xuaW1wb3J0IHsgZ2V0VGFzaywgZ2V0U2xpY2UsIGdldFNsaWNlVGFza3MsIHVwZGF0ZVRhc2tTdGF0dXMsIHVwZGF0ZVNsaWNlU3RhdHVzIH0gZnJvbSBcIi4vZ3NkLWRiLmpzXCI7XG5pbXBvcnQgeyByZW5kZXJQbGFuQ2hlY2tib3hlcywgcmVuZGVyUm9hZG1hcENoZWNrYm94ZXMgfSBmcm9tIFwiLi9tYXJrZG93bi1yZW5kZXJlci5qc1wiO1xuXG4vKipcbiAqIFVuZG8gdGhlIGxhc3QgY29tcGxldGVkIHVuaXQ6IHJldmVydCBnaXQgY29tbWl0cyxcbiAqIGRlbGV0ZSBzdW1tYXJ5IGFydGlmYWN0cywgYW5kIHVuY2hlY2sgdGhlIHRhc2sgaW4gUExBTi5cbiAqIGRlcml2ZVN0YXRlKCkgaGFuZGxlcyByZS1kZXJpdmF0aW9uIGFmdGVyIHJldmVydC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZVVuZG8oYXJnczogc3RyaW5nLCBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LCBfcGk6IEV4dGVuc2lvbkFQSSwgYmFzZVBhdGg6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBmb3JjZSA9IGFyZ3MuaW5jbHVkZXMoXCItLWZvcmNlXCIpO1xuXG4gIC8vIEZpbmQgdGhlIGxhc3QgR1NELXJlbGF0ZWQgY29tbWl0IGZyb20gZ2l0IGFjdGl2aXR5IGxvZ3NcbiAgY29uc3QgYWN0aXZpdHlEaXIgPSBqb2luKGdzZFJvb3QoYmFzZVBhdGgpLCBcImFjdGl2aXR5XCIpO1xuICBpZiAoIWV4aXN0c1N5bmMoYWN0aXZpdHlEaXIpKSB7XG4gICAgY3R4LnVpLm5vdGlmeShcIk5vdGhpbmcgdG8gdW5kbyBcdTIwMTQgbm8gYWN0aXZpdHkgbG9ncyBmb3VuZC5cIiwgXCJpbmZvXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFBhcnNlIGFjdGl2aXR5IGxvZ3MgdG8gZmluZCB0aGUgbW9zdCByZWNlbnQgdW5pdFxuICBjb25zdCBmaWxlcyA9IHJlYWRkaXJTeW5jKGFjdGl2aXR5RGlyKVxuICAgIC5maWx0ZXIoZiA9PiBmLmVuZHNXaXRoKFwiLmpzb25sXCIpKVxuICAgIC5zb3J0KClcbiAgICAucmV2ZXJzZSgpO1xuXG4gIGlmIChmaWxlcy5sZW5ndGggPT09IDApIHtcbiAgICBjdHgudWkubm90aWZ5KFwiTm90aGluZyB0byB1bmRvIFx1MjAxNCBubyBhY3Rpdml0eSBsb2dzIGZvdW5kLlwiLCBcImluZm9cIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gRXh0cmFjdCB1bml0IHR5cGUgYW5kIElEIGZyb20gdGhlIG1vc3QgcmVjZW50IGFjdGl2aXR5IGxvZyBmaWxlbmFtZVxuICAvLyBGb3JtYXQ6IDxzZXE+LTx1bml0VHlwZT4tPHVuaXRJZD4uanNvbmxcbiAgY29uc3QgbWF0Y2ggPSBmaWxlc1swXS5tYXRjaCgvXlxcZCstKC4rPyktKC4rKVxcLmpzb25sJC8pO1xuICBpZiAoIW1hdGNoKSB7XG4gICAgY3R4LnVpLm5vdGlmeShcIk5vdGhpbmcgdG8gdW5kbyBcdTIwMTQgY291bGQgbm90IHBhcnNlIGxhdGVzdCBhY3Rpdml0eSBsb2cuXCIsIFwid2FybmluZ1wiKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCB1bml0VHlwZSA9IG1hdGNoWzFdO1xuICBjb25zdCB1bml0SWQgPSBtYXRjaFsyXS5yZXBsYWNlKC8tL2csIFwiL1wiKTtcblxuICBpZiAoIWZvcmNlKSB7XG4gICAgY3R4LnVpLm5vdGlmeShcbiAgICAgIGBXaWxsIHVuZG86ICR7dW5pdFR5cGV9ICgke3VuaXRJZH0pXFxuYCArXG4gICAgICBgVGhpcyB3aWxsOlxcbmAgK1xuICAgICAgYCAgLSBEZWxldGUgc3VtbWFyeSBhcnRpZmFjdHNcXG5gICtcbiAgICAgIGAgIC0gVW5jaGVjayB0YXNrIGluIFBMQU4gKGlmIGV4ZWN1dGUtdGFzaylcXG5gICtcbiAgICAgIGAgIC0gQXR0ZW1wdCB0byByZXZlcnQgYXNzb2NpYXRlZCBnaXQgY29tbWl0c1xcblxcbmAgK1xuICAgICAgYFJ1biAvZ3NkIHVuZG8gLS1mb3JjZSB0byBjb25maXJtLmAsXG4gICAgICBcIndhcm5pbmdcIixcbiAgICApO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIDEuIERlbGV0ZSBzdW1tYXJ5IGFydGlmYWN0XG4gIGNvbnN0IHsgbWlsZXN0b25lLCBzbGljZSwgdGFzayB9ID0gcGFyc2VVbml0SWQodW5pdElkKTtcbiAgbGV0IHN1bW1hcnlSZW1vdmVkID0gZmFsc2U7XG4gIGlmICh0YXNrICE9PSB1bmRlZmluZWQgJiYgc2xpY2UgIT09IHVuZGVmaW5lZCkge1xuICAgIC8vIFRhc2stbGV2ZWw6IE0wMDEvUzAxL1QwMVxuICAgIGNvbnN0IFttaWQsIHNpZCwgdGlkXSA9IFttaWxlc3RvbmUsIHNsaWNlLCB0YXNrXTtcbiAgICBjb25zdCB0YXNrc0RpciA9IHJlc29sdmVUYXNrc0RpcihiYXNlUGF0aCwgbWlkLCBzaWQpO1xuICAgIGlmICh0YXNrc0Rpcikge1xuICAgICAgY29uc3Qgc3VtbWFyeUZpbGUgPSBqb2luKHRhc2tzRGlyLCBidWlsZFRhc2tGaWxlTmFtZSh0aWQsIFwiU1VNTUFSWVwiKSk7XG4gICAgICBpZiAoZXhpc3RzU3luYyhzdW1tYXJ5RmlsZSkpIHtcbiAgICAgICAgdW5saW5rU3luYyhzdW1tYXJ5RmlsZSk7XG4gICAgICAgIHN1bW1hcnlSZW1vdmVkID0gdHJ1ZTtcbiAgICAgIH1cbiAgICB9XG4gIH0gZWxzZSBpZiAoc2xpY2UgIT09IHVuZGVmaW5lZCkge1xuICAgIC8vIFNsaWNlLWxldmVsOiBNMDAxL1MwMVxuICAgIGNvbnN0IFttaWQsIHNpZF0gPSBbbWlsZXN0b25lLCBzbGljZV07XG4gICAgY29uc3Qgc2xpY2VQYXRoID0gcmVzb2x2ZVNsaWNlUGF0aChiYXNlUGF0aCwgbWlkLCBzaWQpO1xuICAgIGlmIChzbGljZVBhdGgpIHtcbiAgICAgIGZvciAoY29uc3Qgc3VmZml4IG9mIFtcIlNVTU1BUllcIiwgXCJDT01QTEVURVwiXSkge1xuICAgICAgICBjb25zdCBjYW5kaWRhdGVzID0gZmluZEZpbGVXaXRoUHJlZml4KHNsaWNlUGF0aCwgc2lkLCBzdWZmaXgpO1xuICAgICAgICBmb3IgKGNvbnN0IGYgb2YgY2FuZGlkYXRlcykge1xuICAgICAgICAgIHVubGlua1N5bmMoZik7XG4gICAgICAgICAgc3VtbWFyeVJlbW92ZWQgPSB0cnVlO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gMi4gVW5jaGVjayB0YXNrIGluIFBMQU4gaWYgZXhlY3V0ZS10YXNrXG4gIGxldCBwbGFuVXBkYXRlZCA9IGZhbHNlO1xuICBpZiAodW5pdFR5cGUgPT09IFwiZXhlY3V0ZS10YXNrXCIgJiYgdGFzayAhPT0gdW5kZWZpbmVkICYmIHNsaWNlICE9PSB1bmRlZmluZWQpIHtcbiAgICBjb25zdCBbbWlkLCBzaWQsIHRpZF0gPSBbbWlsZXN0b25lLCBzbGljZSwgdGFza107XG4gICAgcGxhblVwZGF0ZWQgPSB1bmNoZWNrVGFza0luUGxhbihiYXNlUGF0aCwgbWlkLCBzaWQsIHRpZCk7XG4gIH1cblxuICAvLyAzLiBUcnkgdG8gcmV2ZXJ0IGdpdCBjb21taXRzIGZyb20gYWN0aXZpdHkgbG9nXG4gIGxldCBjb21taXRzUmV2ZXJ0ZWQgPSAwO1xuICB0cnkge1xuICAgIGNvbnN0IGNvbW1pdHMgPSBmaW5kQ29tbWl0c0ZvclVuaXQoYWN0aXZpdHlEaXIsIHVuaXRUeXBlLCB1bml0SWQpO1xuICAgIGlmIChjb21taXRzLmxlbmd0aCA+IDApIHtcbiAgICAgIGZvciAoY29uc3Qgc2hhIG9mIGNvbW1pdHMucmV2ZXJzZSgpKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgbmF0aXZlUmV2ZXJ0Q29tbWl0KGJhc2VQYXRoLCBzaGEpO1xuICAgICAgICAgIGNvbW1pdHNSZXZlcnRlZCsrO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAvLyBSZXZlcnQgY29uZmxpY3Qgb3IgYWxyZWFkeSByZXZlcnRlZCBcdTIwMTQgc2tpcFxuICAgICAgICAgIHRyeSB7IG5hdGl2ZVJldmVydEFib3J0KGJhc2VQYXRoKTsgfSBjYXRjaCB7IC8qIG5vLW9wICovIH1cbiAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfSBmaW5hbGx5IHtcbiAgICAvLyA0LiBSZS1kZXJpdmUgc3RhdGUgXHUyMDE0IGFsd2F5cyBpbnZhbGlkYXRlIGNhY2hlcyBldmVuIGlmIGdpdCBvcGVyYXRpb25zIGZhaWxcbiAgICBpbnZhbGlkYXRlQWxsQ2FjaGVzKCk7XG4gICAgYXdhaXQgZGVyaXZlU3RhdGUoYmFzZVBhdGgpO1xuICB9XG5cbiAgLy8gQnVpbGQgcmVzdWx0IG1lc3NhZ2VcbiAgY29uc3QgcmVzdWx0czogc3RyaW5nW10gPSBbYFVuZG9uZTogJHt1bml0VHlwZX0gKCR7dW5pdElkfSlgXTtcbiAgaWYgKHN1bW1hcnlSZW1vdmVkKSByZXN1bHRzLnB1c2goYCAgLSBEZWxldGVkIHN1bW1hcnkgYXJ0aWZhY3RgKTtcbiAgaWYgKHBsYW5VcGRhdGVkKSByZXN1bHRzLnB1c2goYCAgLSBVbmNoZWNrZWQgdGFzayBpbiBQTEFOYCk7XG4gIGlmIChjb21taXRzUmV2ZXJ0ZWQgPiAwKSB7XG4gICAgcmVzdWx0cy5wdXNoKGAgIC0gUmV2ZXJ0ZWQgJHtjb21taXRzUmV2ZXJ0ZWR9IGNvbW1pdChzKSAoc3RhZ2VkLCBub3QgY29tbWl0dGVkKWApO1xuICAgIHJlc3VsdHMucHVzaChgICBSZXZpZXcgd2l0aCAnZ2l0IGRpZmYgLS1jYWNoZWQnIHRoZW4gJ2dpdCBjb21taXQnIG9yICdnaXQgcmVzZXQgSEVBRCdgKTtcbiAgfVxuXG4gIGN0eC51aS5ub3RpZnkocmVzdWx0cy5qb2luKFwiXFxuXCIpLCBcInN1Y2Nlc3NcIik7XG4gIHNlbmREZXNrdG9wTm90aWZpY2F0aW9uKFwiR1NEXCIsIGBVbmRvbmU6ICR7dW5pdFR5cGV9ICgke3VuaXRJZH0pYCwgXCJpbmZvXCIsIFwiY29tcGxldGVcIiwgYmFzZW5hbWUoYmFzZVBhdGgpKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRhcmdldGVkIFN0YXRlIFJlc2V0IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFBhcnNlIGEgdGFzayBpZGVudGlmaWVyIGZyb20gYXJncy4gQWNjZXB0czpcbiAqICAgVDAxLCBTMDEvVDAxLCBNMDAxL1MwMS9UMDFcbiAqIFJlc29sdmVzIG1pc3NpbmcgcGFydHMgZnJvbSBjdXJyZW50IHN0YXRlIHZpYSBkZXJpdmVTdGF0ZSgpLlxuICovXG5hc3luYyBmdW5jdGlvbiBwYXJzZVRhc2tJZChcbiAgcmF3OiBzdHJpbmcsXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4pOiBQcm9taXNlPHsgbWlkOiBzdHJpbmc7IHNpZDogc3RyaW5nOyB0aWQ6IHN0cmluZyB9IHwgc3RyaW5nPiB7XG4gIGNvbnN0IHBhcnRzID0gcmF3LnNwbGl0KFwiL1wiKTtcbiAgaWYgKHBhcnRzLmxlbmd0aCA9PT0gMykge1xuICAgIHJldHVybiB7IG1pZDogcGFydHNbMF0sIHNpZDogcGFydHNbMV0sIHRpZDogcGFydHNbMl0gfTtcbiAgfVxuICAvLyBOZWVkIHRvIHJlc29sdmUgZnJvbSBzdGF0ZVxuICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2VQYXRoKTtcbiAgaWYgKHBhcnRzLmxlbmd0aCA9PT0gMikge1xuICAgIC8vIFMwMS9UMDEgXHUyMDE0IHJlc29sdmUgbWlsZXN0b25lXG4gICAgY29uc3QgbWlkID0gc3RhdGUuYWN0aXZlTWlsZXN0b25lPy5pZDtcbiAgICBpZiAoIW1pZCkgcmV0dXJuIFwiQ2Fubm90IHJlc29sdmUgbWlsZXN0b25lIFx1MjAxNCBubyBhY3RpdmUgbWlsZXN0b25lIGluIHN0YXRlLlwiO1xuICAgIHJldHVybiB7IG1pZCwgc2lkOiBwYXJ0c1swXSwgdGlkOiBwYXJ0c1sxXSB9O1xuICB9XG4gIGlmIChwYXJ0cy5sZW5ndGggPT09IDEpIHtcbiAgICAvLyBUMDEgXHUyMDE0IHJlc29sdmUgbWlsZXN0b25lICsgc2xpY2VcbiAgICBjb25zdCBtaWQgPSBzdGF0ZS5hY3RpdmVNaWxlc3RvbmU/LmlkO1xuICAgIGNvbnN0IHNpZCA9IHN0YXRlLmFjdGl2ZVNsaWNlPy5pZDtcbiAgICBpZiAoIW1pZCkgcmV0dXJuIFwiQ2Fubm90IHJlc29sdmUgbWlsZXN0b25lIFx1MjAxNCBubyBhY3RpdmUgbWlsZXN0b25lIGluIHN0YXRlLlwiO1xuICAgIGlmICghc2lkKSByZXR1cm4gXCJDYW5ub3QgcmVzb2x2ZSBzbGljZSBcdTIwMTQgbm8gYWN0aXZlIHNsaWNlIGluIHN0YXRlLlwiO1xuICAgIHJldHVybiB7IG1pZCwgc2lkLCB0aWQ6IHBhcnRzWzBdIH07XG4gIH1cbiAgcmV0dXJuIFwiSW52YWxpZCB0YXNrIElEIGZvcm1hdC4gVXNlIFQwMSwgUzAxL1QwMSwgb3IgTTAwMS9TMDEvVDAxLlwiO1xufVxuXG4vKipcbiAqIFBhcnNlIGEgc2xpY2UgaWRlbnRpZmllciBmcm9tIGFyZ3MuIEFjY2VwdHM6XG4gKiAgIFMwMSwgTTAwMS9TMDFcbiAqIFJlc29sdmVzIG1pc3NpbmcgbWlsZXN0b25lIGZyb20gY3VycmVudCBzdGF0ZS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gcGFyc2VTbGljZUlkKFxuICByYXc6IHN0cmluZyxcbiAgYmFzZVBhdGg6IHN0cmluZyxcbik6IFByb21pc2U8eyBtaWQ6IHN0cmluZzsgc2lkOiBzdHJpbmcgfSB8IHN0cmluZz4ge1xuICBjb25zdCBwYXJ0cyA9IHJhdy5zcGxpdChcIi9cIik7XG4gIGlmIChwYXJ0cy5sZW5ndGggPT09IDIpIHtcbiAgICByZXR1cm4geyBtaWQ6IHBhcnRzWzBdLCBzaWQ6IHBhcnRzWzFdIH07XG4gIH1cbiAgaWYgKHBhcnRzLmxlbmd0aCA9PT0gMSkge1xuICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZVBhdGgpO1xuICAgIGNvbnN0IG1pZCA9IHN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQ7XG4gICAgaWYgKCFtaWQpIHJldHVybiBcIkNhbm5vdCByZXNvbHZlIG1pbGVzdG9uZSBcdTIwMTQgbm8gYWN0aXZlIG1pbGVzdG9uZSBpbiBzdGF0ZS5cIjtcbiAgICByZXR1cm4geyBtaWQsIHNpZDogcGFydHNbMF0gfTtcbiAgfVxuICByZXR1cm4gXCJJbnZhbGlkIHNsaWNlIElEIGZvcm1hdC4gVXNlIFMwMSBvciBNMDAxL1MwMS5cIjtcbn1cblxuLyoqXG4gKiBSZXNldCBhIHNpbmdsZSB0YXNrJ3MgY29tcGxldGlvbiBzdGF0ZTpcbiAqIC0gU2V0IERCIHN0YXR1cyB0byBcInBlbmRpbmdcIlxuICogLSBEZWxldGUgdGhlIHRhc2sgc3VtbWFyeSBmaWxlXG4gKiAtIFJlLXJlbmRlciBwbGFuIGNoZWNrYm94ZXNcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZVVuZG9UYXNrKFxuICBhcmdzOiBzdHJpbmcsXG4gIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsXG4gIF9waTogRXh0ZW5zaW9uQVBJLFxuICBiYXNlUGF0aDogc3RyaW5nLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGZvcmNlID0gYXJncy5pbmNsdWRlcyhcIi0tZm9yY2VcIik7XG4gIGNvbnN0IHJhd0lkID0gYXJncy5yZXBsYWNlKFwiLS1mb3JjZVwiLCBcIlwiKS50cmltKCk7XG5cbiAgaWYgKCFyYXdJZCkge1xuICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICBcIlVzYWdlOiAvZ3NkIHVuZG8tdGFzayA8dGFza0lkPiBbLS1mb3JjZV1cXG5cXG5cIiArXG4gICAgICBcIkFjY2VwdHM6IFQwMSwgUzAxL1QwMSwgb3IgTTAwMS9TMDEvVDAxXFxuXCIgK1xuICAgICAgXCJSZXNldHMgdGhlIHRhc2sncyBEQiBzdGF0dXMgdG8gcGVuZGluZyBhbmQgcmUtcmVuZGVycyBwbGFuIGNoZWNrYm94ZXMuXCIsXG4gICAgICBcIndhcm5pbmdcIixcbiAgICApO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHBhcnNlZCA9IGF3YWl0IHBhcnNlVGFza0lkKHJhd0lkLCBiYXNlUGF0aCk7XG4gIGlmICh0eXBlb2YgcGFyc2VkID09PSBcInN0cmluZ1wiKSB7XG4gICAgY3R4LnVpLm5vdGlmeShwYXJzZWQsIFwiZXJyb3JcIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgeyBtaWQsIHNpZCwgdGlkIH0gPSBwYXJzZWQ7XG5cbiAgLy8gVmFsaWRhdGUgdGFzayBleGlzdHMgaW4gREJcbiAgY29uc3QgdGFzayA9IGdldFRhc2sobWlkLCBzaWQsIHRpZCk7XG4gIGlmICghdGFzaykge1xuICAgIGN0eC51aS5ub3RpZnkoYFRhc2sgJHttaWR9LyR7c2lkfS8ke3RpZH0gbm90IGZvdW5kIGluIGRhdGFiYXNlLmAsIFwiZXJyb3JcIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKCFmb3JjZSkge1xuICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICBgV2lsbCByZXNldDogdGFzayAke21pZH0vJHtzaWR9LyR7dGlkfVxcbmAgK1xuICAgICAgYCAgQ3VycmVudCBzdGF0dXM6ICR7dGFzay5zdGF0dXN9XFxuYCArXG4gICAgICBgVGhpcyB3aWxsOlxcbmAgK1xuICAgICAgYCAgLSBTZXQgdGFzayBzdGF0dXMgdG8gXCJwZW5kaW5nXCIgaW4gREJcXG5gICtcbiAgICAgIGAgIC0gRGVsZXRlIHRhc2sgc3VtbWFyeSBmaWxlIChpZiBleGlzdHMpXFxuYCArXG4gICAgICBgICAtIFJlLXJlbmRlciBwbGFuIGNoZWNrYm94ZXNcXG5cXG5gICtcbiAgICAgIGBSdW4gL2dzZCB1bmRvLXRhc2sgJHtyYXdJZH0gLS1mb3JjZSB0byBjb25maXJtLmAsXG4gICAgICBcIndhcm5pbmdcIixcbiAgICApO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFJlc2V0IERCIHN0YXR1c1xuICB1cGRhdGVUYXNrU3RhdHVzKG1pZCwgc2lkLCB0aWQsIFwicGVuZGluZ1wiKTtcblxuICAvLyBEZWxldGUgc3VtbWFyeSBmaWxlXG4gIGxldCBzdW1tYXJ5RGVsZXRlZCA9IGZhbHNlO1xuICBjb25zdCBzdW1tYXJ5UGF0aCA9IHJlc29sdmVUYXNrRmlsZShiYXNlUGF0aCwgbWlkLCBzaWQsIHRpZCwgXCJTVU1NQVJZXCIpO1xuICBpZiAoc3VtbWFyeVBhdGggJiYgZXhpc3RzU3luYyhzdW1tYXJ5UGF0aCkpIHtcbiAgICB1bmxpbmtTeW5jKHN1bW1hcnlQYXRoKTtcbiAgICBzdW1tYXJ5RGVsZXRlZCA9IHRydWU7XG4gIH1cblxuICAvLyBSZS1yZW5kZXIgcGxhbiBjaGVja2JveGVzXG4gIGF3YWl0IHJlbmRlclBsYW5DaGVja2JveGVzKGJhc2VQYXRoLCBtaWQsIHNpZCk7XG5cbiAgLy8gSW52YWxpZGF0ZSBjYWNoZXNcbiAgaW52YWxpZGF0ZUFsbENhY2hlcygpO1xuXG4gIGNvbnN0IHJlc3VsdHM6IHN0cmluZ1tdID0gW2BSZXNldCB0YXNrICR7bWlkfS8ke3NpZH0vJHt0aWR9IHRvIFwicGVuZGluZ1wiLmBdO1xuICBpZiAoc3VtbWFyeURlbGV0ZWQpIHJlc3VsdHMucHVzaChcIiAgLSBEZWxldGVkIHRhc2sgc3VtbWFyeSBmaWxlXCIpO1xuICByZXN1bHRzLnB1c2goXCIgIC0gUGxhbiBjaGVja2JveGVzIHJlLXJlbmRlcmVkXCIpO1xuXG4gIGN0eC51aS5ub3RpZnkocmVzdWx0cy5qb2luKFwiXFxuXCIpLCBcInN1Y2Nlc3NcIik7XG59XG5cbi8qKlxuICogUmVzZXQgYSBzbGljZSBhbmQgYWxsIGl0cyB0YXNrczpcbiAqIC0gU2V0IGFsbCB0YXNrIERCIHN0YXR1c2VzIHRvIFwicGVuZGluZ1wiXG4gKiAtIFNldCBzbGljZSBEQiBzdGF0dXMgdG8gXCJhY3RpdmVcIlxuICogLSBEZWxldGUgdGFzayBzdW1tYXJ5IGZpbGVzLCBzbGljZSBzdW1tYXJ5LCBhbmQgVUFUIGZpbGVzXG4gKiAtIFJlLXJlbmRlciBwbGFuICsgcm9hZG1hcCBjaGVja2JveGVzXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBoYW5kbGVSZXNldFNsaWNlKFxuICBhcmdzOiBzdHJpbmcsXG4gIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsXG4gIF9waTogRXh0ZW5zaW9uQVBJLFxuICBiYXNlUGF0aDogc3RyaW5nLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGZvcmNlID0gYXJncy5pbmNsdWRlcyhcIi0tZm9yY2VcIik7XG4gIGNvbnN0IHJhd0lkID0gYXJncy5yZXBsYWNlKFwiLS1mb3JjZVwiLCBcIlwiKS50cmltKCk7XG5cbiAgaWYgKCFyYXdJZCkge1xuICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICBcIlVzYWdlOiAvZ3NkIHJlc2V0LXNsaWNlIDxzbGljZUlkPiBbLS1mb3JjZV1cXG5cXG5cIiArXG4gICAgICBcIkFjY2VwdHM6IFMwMSBvciBNMDAxL1MwMVxcblwiICtcbiAgICAgIFwiUmVzZXRzIHRoZSBzbGljZSBhbmQgYWxsIGl0cyB0YXNrcywgcmUtcmVuZGVycyBwbGFuICsgcm9hZG1hcCBjaGVja2JveGVzLlwiLFxuICAgICAgXCJ3YXJuaW5nXCIsXG4gICAgKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBwYXJzZWQgPSBhd2FpdCBwYXJzZVNsaWNlSWQocmF3SWQsIGJhc2VQYXRoKTtcbiAgaWYgKHR5cGVvZiBwYXJzZWQgPT09IFwic3RyaW5nXCIpIHtcbiAgICBjdHgudWkubm90aWZ5KHBhcnNlZCwgXCJlcnJvclwiKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCB7IG1pZCwgc2lkIH0gPSBwYXJzZWQ7XG5cbiAgLy8gVmFsaWRhdGUgc2xpY2UgZXhpc3RzIGluIERCXG4gIGNvbnN0IHNsaWNlID0gZ2V0U2xpY2UobWlkLCBzaWQpO1xuICBpZiAoIXNsaWNlKSB7XG4gICAgY3R4LnVpLm5vdGlmeShgU2xpY2UgJHttaWR9LyR7c2lkfSBub3QgZm91bmQgaW4gZGF0YWJhc2UuYCwgXCJlcnJvclwiKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCB0YXNrcyA9IGdldFNsaWNlVGFza3MobWlkLCBzaWQpO1xuXG4gIGlmICghZm9yY2UpIHtcbiAgICBjdHgudWkubm90aWZ5KFxuICAgICAgYFdpbGwgcmVzZXQ6IHNsaWNlICR7bWlkfS8ke3NpZH1cXG5gICtcbiAgICAgIGAgIEN1cnJlbnQgc3RhdHVzOiAke3NsaWNlLnN0YXR1c31cXG5gICtcbiAgICAgIGAgIFRhc2tzIHRvIHJlc2V0OiAke3Rhc2tzLmxlbmd0aH1cXG5gICtcbiAgICAgIGBUaGlzIHdpbGw6XFxuYCArXG4gICAgICBgICAtIFNldCBhbGwgdGFzayBzdGF0dXNlcyB0byBcInBlbmRpbmdcIiBpbiBEQlxcbmAgK1xuICAgICAgYCAgLSBTZXQgc2xpY2Ugc3RhdHVzIHRvIFwiYWN0aXZlXCIgaW4gREJcXG5gICtcbiAgICAgIGAgIC0gRGVsZXRlIHRhc2sgc3VtbWFyeSBmaWxlcywgc2xpY2Ugc3VtbWFyeSwgYW5kIFVBVCBmaWxlc1xcbmAgK1xuICAgICAgYCAgLSBSZS1yZW5kZXIgcGxhbiArIHJvYWRtYXAgY2hlY2tib3hlc1xcblxcbmAgK1xuICAgICAgYFJ1biAvZ3NkIHJlc2V0LXNsaWNlICR7cmF3SWR9IC0tZm9yY2UgdG8gY29uZmlybS5gLFxuICAgICAgXCJ3YXJuaW5nXCIsXG4gICAgKTtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBSZXNldCBhbGwgdGFza3NcbiAgbGV0IHRhc2tzUmVzZXQgPSAwO1xuICBsZXQgc3VtbWFyaWVzRGVsZXRlZCA9IDA7XG4gIGZvciAoY29uc3QgdCBvZiB0YXNrcykge1xuICAgIHVwZGF0ZVRhc2tTdGF0dXMobWlkLCBzaWQsIHQuaWQsIFwicGVuZGluZ1wiKTtcbiAgICB0YXNrc1Jlc2V0Kys7XG4gICAgY29uc3Qgc3VtbWFyeVBhdGggPSByZXNvbHZlVGFza0ZpbGUoYmFzZVBhdGgsIG1pZCwgc2lkLCB0LmlkLCBcIlNVTU1BUllcIik7XG4gICAgaWYgKHN1bW1hcnlQYXRoICYmIGV4aXN0c1N5bmMoc3VtbWFyeVBhdGgpKSB7XG4gICAgICB1bmxpbmtTeW5jKHN1bW1hcnlQYXRoKTtcbiAgICAgIHN1bW1hcmllc0RlbGV0ZWQrKztcbiAgICB9XG4gIH1cblxuICAvLyBSZXNldCBzbGljZSBzdGF0dXNcbiAgdXBkYXRlU2xpY2VTdGF0dXMobWlkLCBzaWQsIFwiYWN0aXZlXCIpO1xuXG4gIC8vIERlbGV0ZSBzbGljZSBzdW1tYXJ5IGFuZCBVQVQgZmlsZXNcbiAgbGV0IHNsaWNlRmlsZXNEZWxldGVkID0gMDtcbiAgY29uc3Qgc2xpY2VQYXRoID0gcmVzb2x2ZVNsaWNlUGF0aChiYXNlUGF0aCwgbWlkLCBzaWQpO1xuICBpZiAoc2xpY2VQYXRoKSB7XG4gICAgZm9yIChjb25zdCBzdWZmaXggb2YgW1wiU1VNTUFSWVwiLCBcIlVBVFwiXSkge1xuICAgICAgY29uc3QgZmlsZVBhdGggPSBqb2luKHNsaWNlUGF0aCwgYnVpbGRTbGljZUZpbGVOYW1lKHNpZCwgc3VmZml4KSk7XG4gICAgICBpZiAoZXhpc3RzU3luYyhmaWxlUGF0aCkpIHtcbiAgICAgICAgdW5saW5rU3luYyhmaWxlUGF0aCk7XG4gICAgICAgIHNsaWNlRmlsZXNEZWxldGVkKys7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gUmUtcmVuZGVyIHBsYW4gKyByb2FkbWFwIGNoZWNrYm94ZXNcbiAgYXdhaXQgcmVuZGVyUGxhbkNoZWNrYm94ZXMoYmFzZVBhdGgsIG1pZCwgc2lkKTtcbiAgYXdhaXQgcmVuZGVyUm9hZG1hcENoZWNrYm94ZXMoYmFzZVBhdGgsIG1pZCk7XG5cbiAgLy8gSW52YWxpZGF0ZSBjYWNoZXNcbiAgaW52YWxpZGF0ZUFsbENhY2hlcygpO1xuXG4gIGNvbnN0IHJlc3VsdHM6IHN0cmluZ1tdID0gW1xuICAgIGBSZXNldCBzbGljZSAke21pZH0vJHtzaWR9IHRvIFwiYWN0aXZlXCIuYCxcbiAgICBgICAtICR7dGFza3NSZXNldH0gdGFzayhzKSByZXNldCB0byBcInBlbmRpbmdcImAsXG4gIF07XG4gIGlmIChzdW1tYXJpZXNEZWxldGVkID4gMCkgcmVzdWx0cy5wdXNoKGAgIC0gJHtzdW1tYXJpZXNEZWxldGVkfSB0YXNrIHN1bW1hcnkgZmlsZShzKSBkZWxldGVkYCk7XG4gIGlmIChzbGljZUZpbGVzRGVsZXRlZCA+IDApIHJlc3VsdHMucHVzaChgICAtICR7c2xpY2VGaWxlc0RlbGV0ZWR9IHNsaWNlIGZpbGUocykgZGVsZXRlZCAoc3VtbWFyeS9VQVQpYCk7XG4gIHJlc3VsdHMucHVzaChcIiAgLSBQbGFuICsgcm9hZG1hcCBjaGVja2JveGVzIHJlLXJlbmRlcmVkXCIpO1xuXG4gIGN0eC51aS5ub3RpZnkocmVzdWx0cy5qb2luKFwiXFxuXCIpLCBcInN1Y2Nlc3NcIik7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBIZWxwZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgZnVuY3Rpb24gdW5jaGVja1Rhc2tJblBsYW4oYmFzZVBhdGg6IHN0cmluZywgbWlkOiBzdHJpbmcsIHNpZDogc3RyaW5nLCB0aWQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBzbGljZVBhdGggPSByZXNvbHZlU2xpY2VQYXRoKGJhc2VQYXRoLCBtaWQsIHNpZCk7XG4gIGlmICghc2xpY2VQYXRoKSByZXR1cm4gZmFsc2U7XG5cbiAgLy8gRmluZCB0aGUgUExBTiBmaWxlXG4gIGNvbnN0IHBsYW5DYW5kaWRhdGVzID0gZmluZEZpbGVXaXRoUHJlZml4KHNsaWNlUGF0aCwgc2lkLCBcIlBMQU5cIik7XG4gIGlmIChwbGFuQ2FuZGlkYXRlcy5sZW5ndGggPT09IDApIHJldHVybiBmYWxzZTtcblxuICBjb25zdCBwbGFuRmlsZSA9IHBsYW5DYW5kaWRhdGVzWzBdO1xuICBsZXQgY29udGVudCA9IHJlYWRGaWxlU3luYyhwbGFuRmlsZSwgXCJ1dGYtOFwiKTtcblxuICAvLyBNYXRjaCBjaGVja2VkIHRhc2sgbGluZTogLSBbeF0gKipUMDEqKiBvciAtIFt4XSBUMDE6XG4gIGNvbnN0IHJlZ2V4ID0gbmV3IFJlZ0V4cChgXihcXFxccyotXFxcXHMqKVxcXFxbeFxcXFxdKFxcXFxzKlxcXFwqKiR7dGlkfVxcXFwqKls6XFxcXHNdKWAsIFwibWlcIik7XG4gIGlmIChyZWdleC50ZXN0KGNvbnRlbnQpKSB7XG4gICAgY29udGVudCA9IGNvbnRlbnQucmVwbGFjZShyZWdleCwgXCIkMVsgXSQyXCIpO1xuICAgIGF0b21pY1dyaXRlU3luYyhwbGFuRmlsZSwgY29udGVudCk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgcmV0dXJuIGZhbHNlO1xufVxuXG5mdW5jdGlvbiBmaW5kRmlsZVdpdGhQcmVmaXgoZGlyOiBzdHJpbmcsIHByZWZpeDogc3RyaW5nLCBzdWZmaXg6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBmaWxlcyA9IHJlYWRkaXJTeW5jKGRpcik7XG4gICAgcmV0dXJuIGZpbGVzXG4gICAgICAuZmlsdGVyKGYgPT4gZi5pbmNsdWRlcyhzdWZmaXgpICYmIChmLnN0YXJ0c1dpdGgocHJlZml4KSB8fCBmLnN0YXJ0c1dpdGgoYCR7cHJlZml4fS1gKSkpXG4gICAgICAubWFwKGYgPT4gam9pbihkaXIsIGYpKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBmaW5kQ29tbWl0c0ZvclVuaXQoYWN0aXZpdHlEaXI6IHN0cmluZywgdW5pdFR5cGU6IHN0cmluZywgdW5pdElkOiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IHNhZmVVbml0SWQgPSB1bml0SWQucmVwbGFjZSgvXFwvL2csIFwiLVwiKTtcbiAgY29uc3QgY29tbWl0U2V0ID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IGNvbW1pdHM6IHN0cmluZ1tdID0gW107XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBmaWxlcyA9IHJlYWRkaXJTeW5jKGFjdGl2aXR5RGlyKVxuICAgICAgLmZpbHRlcihmID0+IGYuaW5jbHVkZXModW5pdFR5cGUpICYmIGYuaW5jbHVkZXMoc2FmZVVuaXRJZCkgJiYgZi5lbmRzV2l0aChcIi5qc29ubFwiKSlcbiAgICAgIC5zb3J0KClcbiAgICAgIC5yZXZlcnNlKCk7XG5cbiAgICBpZiAoZmlsZXMubGVuZ3RoID09PSAwKSByZXR1cm4gW107XG5cbiAgICAvLyBQYXJzZSB0aGUgbW9zdCByZWNlbnQgYWN0aXZpdHkgbG9nIGZvciB0aGlzIHVuaXRcbiAgICBjb25zdCBjb250ZW50ID0gcmVhZEZpbGVTeW5jKGpvaW4oYWN0aXZpdHlEaXIsIGZpbGVzWzBdKSwgXCJ1dGYtOFwiKTtcbiAgICBmb3IgKGNvbnN0IGxpbmUgb2YgY29udGVudC5zcGxpdChcIlxcblwiKSkge1xuICAgICAgaWYgKCFsaW5lLnRyaW0oKSkgY29udGludWU7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBlbnRyeSA9IEpTT04ucGFyc2UobGluZSk7XG4gICAgICAgIC8vIExvb2sgZm9yIHRvb2wgcmVzdWx0cyBjb250YWluaW5nIGdpdCBjb21taXQgb3V0cHV0XG4gICAgICAgIGlmIChlbnRyeT8ubWVzc2FnZT8uY29udGVudCkge1xuICAgICAgICAgIGNvbnN0IGJsb2NrcyA9IEFycmF5LmlzQXJyYXkoZW50cnkubWVzc2FnZS5jb250ZW50KSA/IGVudHJ5Lm1lc3NhZ2UuY29udGVudCA6IFtdO1xuICAgICAgICAgIGZvciAoY29uc3QgYmxvY2sgb2YgYmxvY2tzKSB7XG4gICAgICAgICAgICBpZiAoYmxvY2sudHlwZSA9PT0gXCJ0b29sX3Jlc3VsdFwiICYmIHR5cGVvZiBibG9jay5jb250ZW50ID09PSBcInN0cmluZ1wiKSB7XG4gICAgICAgICAgICAgIGZvciAoY29uc3Qgc2hhIG9mIGV4dHJhY3RDb21taXRTaGFzKGJsb2NrLmNvbnRlbnQpKSB7XG4gICAgICAgICAgICAgICAgaWYgKCFjb21taXRTZXQuaGFzKHNoYSkpIHtcbiAgICAgICAgICAgICAgICAgIGNvbW1pdFNldC5hZGQoc2hhKTtcbiAgICAgICAgICAgICAgICAgIGNvbW1pdHMucHVzaChzaGEpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCB7IC8qIG1hbGZvcm1lZCBKU09OIGxpbmUgXHUyMDE0IHNraXAgKi8gfVxuICAgIH1cbiAgfSBjYXRjaCB7IC8qIGFjdGl2aXR5IGRpciBpc3N1ZXMgXHUyMDE0IHNraXAgKi8gfVxuXG4gIHJldHVybiBjb21taXRzO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZXh0cmFjdENvbW1pdFNoYXMoY29udGVudDogc3RyaW5nKTogc3RyaW5nW10ge1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IGNvbW1pdHM6IHN0cmluZ1tdID0gW107XG4gIGZvciAoY29uc3QgbWF0Y2ggb2YgY29udGVudC5tYXRjaEFsbCgvXFxbW1xcdy8uLV0rXFxzKyhbYS1mMC05XXs3LDQwfSlcXF0vZykpIHtcbiAgICBjb25zdCBzaGEgPSBtYXRjaFsxXTtcbiAgICBpZiAoc2hhICYmICFzZWVuLmhhcyhzaGEpKSB7XG4gICAgICBzZWVuLmFkZChzaGEpO1xuICAgICAgY29tbWl0cy5wdXNoKHNoYSk7XG4gICAgfVxuICB9XG4gIHJldHVybiBjb21taXRzO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBTUEsU0FBUyxZQUFZLGNBQWMsWUFBWSxtQkFBbUI7QUFDbEUsU0FBUyxNQUFNLGdCQUFnQjtBQUMvQixTQUFTLG9CQUFvQix5QkFBeUI7QUFDdEQsU0FBUyx1QkFBdUI7QUFDaEMsU0FBUyxtQkFBbUI7QUFDNUIsU0FBUyxtQkFBbUI7QUFDNUIsU0FBUywyQkFBMkI7QUFDcEMsU0FBUyxTQUFTLGlCQUFpQixrQkFBa0IsaUJBQWlCLG1CQUFtQiwwQkFBMEI7QUFDbkgsU0FBUywrQkFBK0I7QUFDeEMsU0FBUyxTQUFTLFVBQVUsZUFBZSxrQkFBa0IseUJBQXlCO0FBQ3RGLFNBQVMsc0JBQXNCLCtCQUErQjtBQU85RCxlQUFzQixXQUFXLE1BQWMsS0FBOEIsS0FBbUIsVUFBaUM7QUFDL0gsUUFBTSxRQUFRLEtBQUssU0FBUyxTQUFTO0FBR3JDLFFBQU0sY0FBYyxLQUFLLFFBQVEs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
