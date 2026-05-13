import { join } from "node:path";
import { mkdirSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { logWarning, logError } from "./workflow-logger.js";
import { readEvents, findForkPoint, getSessionId } from "./workflow-events.js";
import {
  transaction,
  updateTaskStatus,
  updateSliceStatus,
  updateMilestoneStatus,
  getSliceTasks,
  insertMilestone,
  getMilestoneSlices,
  insertVerificationEvidence,
  upsertDecision,
  openDatabase,
  setTaskBlockerDiscovered,
  insertOrIgnoreSlice,
  insertOrIgnoreTask
} from "./gsd-db.js";
import { isClosedStatus } from "./status-guards.js";
import { invalidateStateCache } from "./state.js";
import { clearPathCache, resolveGsdPathContract } from "./paths.js";
import { clearParseCache } from "./files.js";
import { writeManifest } from "./workflow-manifest.js";
import { atomicWriteSync } from "./atomic-write.js";
import { acquireSyncLock, releaseSyncLock } from "./sync-lock.js";
function replaySliceComplete(milestoneId, sliceId, ts) {
  const tasks = getSliceTasks(milestoneId, sliceId);
  if (tasks.length > 0) {
    const incompleteTasks = tasks.filter((t) => !isClosedStatus(t.status));
    if (incompleteTasks.length > 0) {
      process.stderr.write(
        `[gsd] reconcile: skipping complete_slice replay for ${sliceId} \u2014 ${incompleteTasks.length} task(s) still pending
`
      );
      return;
    }
  }
  updateSliceStatus(milestoneId, sliceId, "done", ts);
}
function replayEvents(events) {
  transaction(() => {
    for (const event of events) {
      const p = event.params;
      if (typeof event.cmd !== "string") {
        logWarning("reconcile", `Event with non-string cmd skipped: ${JSON.stringify(event.cmd)}`);
        continue;
      }
      const cmd = event.cmd.replace(/-/g, "_");
      switch (cmd) {
        case "complete_task": {
          const milestoneId = p["milestoneId"];
          const sliceId = p["sliceId"];
          const taskId = p["taskId"];
          updateTaskStatus(milestoneId, sliceId, taskId, "done", event.ts);
          break;
        }
        case "start_task": {
          const milestoneId = p["milestoneId"];
          const sliceId = p["sliceId"];
          const taskId = p["taskId"];
          updateTaskStatus(milestoneId, sliceId, taskId, "in-progress", event.ts);
          break;
        }
        case "report_blocker": {
          const milestoneId = p["milestoneId"];
          const sliceId = p["sliceId"];
          const taskId = p["taskId"];
          updateTaskStatus(milestoneId, sliceId, taskId, "blocked");
          setTaskBlockerDiscovered(milestoneId, sliceId, taskId, true);
          break;
        }
        case "record_verification": {
          const milestoneId = p["milestoneId"];
          const sliceId = p["sliceId"];
          const taskId = p["taskId"];
          insertVerificationEvidence({
            taskId,
            sliceId,
            milestoneId,
            command: p["command"] ?? "",
            exitCode: p["exitCode"] ?? 0,
            verdict: p["verdict"] ?? "",
            durationMs: p["durationMs"] ?? 0
          });
          break;
        }
        case "complete_slice": {
          const milestoneId = p["milestoneId"];
          const sliceId = p["sliceId"];
          replaySliceComplete(milestoneId, sliceId, event.ts);
          break;
        }
        case "complete_milestone": {
          const milestoneId = p["milestoneId"];
          if (!milestoneId) break;
          const mSlices = getMilestoneSlices(milestoneId);
          const allClosed = mSlices.length === 0 || mSlices.every((s) => isClosedStatus(s.status));
          if (allClosed) {
            updateMilestoneStatus(milestoneId, "complete", event.ts);
          } else {
            logWarning("reconcile", `Skipping complete_milestone replay for ${milestoneId}: not all slices are closed`);
          }
          break;
        }
        case "plan_milestone": {
          const mId = p["milestoneId"];
          if (mId) {
            insertMilestone({ id: mId, title: p["title"] ?? mId });
          }
          break;
        }
        case "plan_slice": {
          const milestoneId = p["milestoneId"];
          const sliceId = p["sliceId"];
          if (milestoneId && sliceId) {
            insertOrIgnoreSlice({
              milestoneId,
              sliceId,
              title: p["title"] ?? sliceId,
              createdAt: event.ts
            });
          }
          break;
        }
        case "plan_task": {
          const milestoneId = p["milestoneId"];
          const sliceId = p["sliceId"];
          const taskId = p["taskId"];
          if (milestoneId && sliceId && taskId) {
            insertOrIgnoreTask({
              milestoneId,
              sliceId,
              taskId,
              title: p["title"] ?? taskId,
              createdAt: event.ts
            });
          }
          break;
        }
        case "replan_slice": {
          break;
        }
        case "save_decision": {
          upsertDecision({
            id: p["id"] ?? `${p["scope"]}:${p["decision"]}`,
            when_context: p["when_context"] ?? p["whenContext"] ?? "",
            scope: p["scope"] ?? "",
            decision: p["decision"] ?? "",
            choice: p["choice"] ?? "",
            rationale: p["rationale"] ?? "",
            revisable: p["revisable"] ?? "yes",
            made_by: p["made_by"] ?? p["madeBy"] ?? "agent",
            superseded_by: p["superseded_by"] ?? p["supersededBy"] ?? null
          });
          break;
        }
        default:
          logWarning("reconcile", `Unknown event cmd during replay: "${event.cmd}" \u2014 skipped`);
          break;
      }
    }
  });
}
function extractEntityKey(event) {
  const p = event.params;
  if (typeof event.cmd !== "string") return null;
  const cmd = event.cmd.replace(/-/g, "_");
  switch (cmd) {
    case "complete_task":
    case "start_task":
    case "report_blocker":
    case "record_verification":
    case "plan_task":
      return typeof p["taskId"] === "string" ? { type: "task", id: p["taskId"] } : null;
    case "complete_slice":
    case "replan_slice":
      return typeof p["sliceId"] === "string" ? { type: "slice", id: p["sliceId"] } : null;
    case "plan_slice":
      return typeof p["sliceId"] === "string" ? { type: "slice_plan", id: p["sliceId"] } : null;
    case "complete_milestone":
    case "plan_milestone":
      return typeof p["milestoneId"] === "string" ? { type: "milestone", id: p["milestoneId"] } : null;
    case "save_decision":
      if (typeof p["scope"] === "string" && typeof p["decision"] === "string") {
        return { type: "decision", id: `${p["scope"]}:${p["decision"]}` };
      }
      return null;
    default:
      return null;
  }
}
function detectConflicts(mainDiverged, wtDiverged) {
  const mainByEntity = /* @__PURE__ */ new Map();
  for (const event of mainDiverged) {
    const key = extractEntityKey(event);
    if (!key) continue;
    const bucket = mainByEntity.get(`${key.type}:${key.id}`) ?? [];
    bucket.push(event);
    mainByEntity.set(`${key.type}:${key.id}`, bucket);
  }
  const wtByEntity = /* @__PURE__ */ new Map();
  for (const event of wtDiverged) {
    const key = extractEntityKey(event);
    if (!key) continue;
    const bucket = wtByEntity.get(`${key.type}:${key.id}`) ?? [];
    bucket.push(event);
    wtByEntity.set(`${key.type}:${key.id}`, bucket);
  }
  const conflicts = [];
  for (const [entityKey, mainEvents] of mainByEntity) {
    const wtEvents = wtByEntity.get(entityKey);
    if (!wtEvents) continue;
    const colonIdx = entityKey.indexOf(":");
    const entityType = entityKey.slice(0, colonIdx);
    const entityId = entityKey.slice(colonIdx + 1);
    conflicts.push({
      entityType,
      entityId,
      mainSideEvents: mainEvents,
      worktreeSideEvents: wtEvents
    });
  }
  return conflicts;
}
function rewriteDivergedEventsForEntity(divergedEvents, entityType, entityId, replacementEvents) {
  const rewritten = [];
  let inserted = false;
  for (const event of divergedEvents) {
    const key = extractEntityKey(event);
    if (key?.type === entityType && key.id === entityId) {
      if (!inserted) {
        rewritten.push(...replacementEvents);
        inserted = true;
      }
      continue;
    }
    rewritten.push(event);
  }
  if (!inserted) {
    rewritten.push(...replacementEvents);
  }
  return rewritten;
}
function writeEventLog(basePath, events) {
  const dir = join(basePath, ".gsd");
  mkdirSync(dir, { recursive: true });
  const content = events.map((e) => JSON.stringify(e)).join("\n") + (events.length > 0 ? "\n" : "");
  atomicWriteSync(join(dir, "event-log.jsonl"), content);
}
function writeConflictsFile(basePath, conflicts, worktreePath) {
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  const lines = [
    `# Merge Conflicts \u2014 ${timestamp}`,
    "",
    `Conflicts detected merging worktree \`${worktreePath}\` into \`${basePath}\`.`,
    `Run \`gsd resolve-conflict\` to resolve each conflict.`,
    ""
  ];
  conflicts.forEach((conflict, idx) => {
    lines.push(`## Conflict ${idx + 1}: ${conflict.entityType} ${conflict.entityId}`);
    lines.push("");
    lines.push("**Main side events:**");
    for (const event of conflict.mainSideEvents) {
      lines.push(`- ${event.cmd} at ${event.ts} (hash: ${event.hash})`);
      lines.push(`  params: ${JSON.stringify(event.params)}`);
    }
    lines.push("");
    lines.push("**Worktree side events:**");
    for (const event of conflict.worktreeSideEvents) {
      lines.push(`- ${event.cmd} at ${event.ts} (hash: ${event.hash})`);
      lines.push(`  params: ${JSON.stringify(event.params)}`);
    }
    lines.push("");
    lines.push(`**Resolve with:** \`gsd resolve-conflict --entity ${conflict.entityType}:${conflict.entityId} --pick [main|worktree]\``);
    lines.push("");
  });
  const content = lines.join("\n");
  const dir = join(basePath, ".gsd");
  mkdirSync(dir, { recursive: true });
  atomicWriteSync(join(dir, "CONFLICTS.md"), content);
}
function reconcileWorktreeLogs(mainBasePath, worktreeBasePath) {
  const lock = acquireSyncLock(mainBasePath);
  if (!lock.acquired) {
    logWarning("reconcile", "could not acquire sync lock \u2014 another reconciliation may be in progress");
    return { autoMerged: 0, conflicts: [] };
  }
  try {
    return _reconcileWorktreeLogsInner(mainBasePath, worktreeBasePath);
  } finally {
    releaseSyncLock(mainBasePath);
  }
}
function _reconcileWorktreeLogsInner(mainBasePath, worktreeBasePath) {
  const mainLogPath = join(mainBasePath, ".gsd", "event-log.jsonl");
  const wtLogPath = join(worktreeBasePath, ".gsd", "event-log.jsonl");
  const mainEvents = readEvents(mainLogPath);
  const wtEvents = readEvents(wtLogPath);
  const forkPoint = findForkPoint(mainEvents, wtEvents);
  const mainDiverged = mainEvents.slice(forkPoint + 1);
  const wtDiverged = wtEvents.slice(forkPoint + 1);
  if (mainDiverged.length === 0 && wtDiverged.length === 0) {
    return { autoMerged: 0, conflicts: [] };
  }
  const conflicts = detectConflicts(mainDiverged, wtDiverged);
  if (conflicts.length > 0) {
    writeConflictsFile(mainBasePath, conflicts, worktreeBasePath);
    const conflictSummary = conflicts.slice(0, 3).map((c) => `${c.entityType}:${c.entityId}`).join(", ");
    const truncated = conflicts.length > 3 ? `... and ${conflicts.length - 3} more` : "";
    logError("reconcile", `${conflicts.length} conflict(s) detected on ${conflictSummary}${truncated}. Details: .gsd/CONFLICTS.md`, { count: String(conflicts.length), path: join(mainBasePath, ".gsd", "CONFLICTS.md") });
    return { autoMerged: 0, conflicts };
  }
  const indexed = [...mainDiverged, ...wtDiverged].map((e, i) => ({ e, i }));
  indexed.sort((a, b) => a.e.ts.localeCompare(b.e.ts) || a.i - b.i);
  const merged = indexed.map(({ e }) => e);
  const preWriteEvents = readEvents(mainLogPath);
  if (preWriteEvents.length > mainEvents.length) {
    logWarning("reconcile", `Event log grew during reconcile (${mainEvents.length} \u2192 ${preWriteEvents.length}), retrying with fresh read`);
    return _reconcileWorktreeLogsInner(mainBasePath, worktreeBasePath);
  }
  const baseEvents = mainEvents.slice(0, forkPoint + 1);
  const mergedLog = baseEvents.concat(merged);
  const logContent = mergedLog.map((e) => JSON.stringify(e)).join("\n") + (mergedLog.length > 0 ? "\n" : "");
  mkdirSync(join(mainBasePath, ".gsd"), { recursive: true });
  atomicWriteSync(join(mainBasePath, ".gsd", "event-log.jsonl"), logContent);
  openDatabase(resolveGsdPathContract(mainBasePath).projectDb);
  replayEvents(merged);
  try {
    writeManifest(mainBasePath);
  } catch (err) {
    logWarning("reconcile", "manifest write failed (non-fatal)", { error: err.message });
  }
  invalidateStateCache();
  clearPathCache();
  clearParseCache();
  return { autoMerged: merged.length, conflicts: [] };
}
function listConflicts(basePath) {
  const conflictsPath = join(basePath, ".gsd", "CONFLICTS.md");
  if (!existsSync(conflictsPath)) return [];
  const content = readFileSync(conflictsPath, "utf-8");
  const conflicts = [];
  const sections = content.split(/^## Conflict \d+:/m).slice(1);
  for (const section of sections) {
    const headingMatch = section.match(/^\s+(\S+)\s+(\S+)/);
    if (!headingMatch) continue;
    const entityType = headingMatch[1];
    const entityId = headingMatch[2];
    const mainMatch = section.split("**Main side events:**")[1];
    const wtMatch = mainMatch?.split("**Worktree side events:**");
    const mainBlock = wtMatch?.[0] ?? "";
    const wtBlock = wtMatch?.[1] ?? "";
    const mainSideEvents = parseEventBlock(mainBlock);
    const worktreeSideEvents = parseEventBlock(wtBlock);
    conflicts.push({ entityType, entityId, mainSideEvents, worktreeSideEvents });
  }
  return conflicts;
}
function parseEventBlock(block) {
  const events = [];
  const lines = block.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.startsWith("- ")) {
      const eventMatch = line.match(/^-\s+(\S+)\s+at\s+(\S+)\s+\(hash:\s+(\S+)\)$/);
      if (eventMatch) {
        const cmd = eventMatch[1];
        const ts = eventMatch[2];
        const hash = eventMatch[3];
        let params = {};
        const nextLine = lines[i + 1];
        if (nextLine) {
          const paramsMatch = nextLine.trim().match(/^params:\s+(.+)$/);
          if (paramsMatch) {
            try {
              params = JSON.parse(paramsMatch[1]);
            } catch (e) {
              logWarning("reconcile", `tool call params parse failed: ${e.message}`);
            }
            i++;
          }
        }
        events.push({ cmd, params, ts, hash, actor: "agent", session_id: getSessionId() });
      }
    }
    i++;
  }
  return events;
}
function resolveConflict(basePath, worktreeBasePath, entityKey, pick) {
  const conflicts = listConflicts(basePath);
  const colonIdx = entityKey.indexOf(":");
  const entityType = entityKey.slice(0, colonIdx);
  const entityId = entityKey.slice(colonIdx + 1);
  const idx = conflicts.findIndex((c) => c.entityType === entityType && c.entityId === entityId);
  if (idx === -1) throw new Error(`No conflict found for entity ${entityKey}`);
  const conflict = conflicts[idx];
  const eventsToReplay = pick === "main" ? conflict.mainSideEvents : conflict.worktreeSideEvents;
  const mainLogPath = join(basePath, ".gsd", "event-log.jsonl");
  const wtLogPath = join(worktreeBasePath, ".gsd", "event-log.jsonl");
  const mainEvents = readEvents(mainLogPath);
  const wtEvents = readEvents(wtLogPath);
  const forkPoint = findForkPoint(mainEvents, wtEvents);
  const mainBaseEvents = mainEvents.slice(0, forkPoint + 1);
  const wtBaseEvents = wtEvents.slice(0, forkPoint + 1);
  const mainDiverged = mainEvents.slice(forkPoint + 1);
  const wtDiverged = wtEvents.slice(forkPoint + 1);
  const rewrittenTargetEvents = pick === "main" ? rewriteDivergedEventsForEntity(wtDiverged, entityType, entityId, eventsToReplay) : rewriteDivergedEventsForEntity(mainDiverged, entityType, entityId, eventsToReplay);
  const targetBasePath = pick === "main" ? worktreeBasePath : basePath;
  const targetBaseEvents = pick === "main" ? wtBaseEvents : mainBaseEvents;
  writeEventLog(targetBasePath, targetBaseEvents.concat(rewrittenTargetEvents));
  openDatabase(resolveGsdPathContract(basePath).projectDb);
  replayEvents(eventsToReplay);
  invalidateStateCache();
  clearPathCache();
  clearParseCache();
  conflicts.splice(idx, 1);
  if (conflicts.length === 0) {
    removeConflictsFile(basePath);
    if (worktreeBasePath) {
      reconcileWorktreeLogs(basePath, worktreeBasePath);
    }
  } else {
    writeConflictsFile(basePath, conflicts, worktreeBasePath);
  }
}
function removeConflictsFile(basePath) {
  const conflictsPath = join(basePath, ".gsd", "CONFLICTS.md");
  if (existsSync(conflictsPath)) {
    unlinkSync(conflictsPath);
  }
}
export {
  detectConflicts,
  extractEntityKey,
  listConflicts,
  reconcileWorktreeLogs,
  removeConflictsFile,
  replaySliceComplete,
  resolveConflict,
  writeConflictsFile
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC93b3JrZmxvdy1yZWNvbmNpbGUudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBta2RpclN5bmMsIGV4aXN0c1N5bmMsIHJlYWRGaWxlU3luYywgdW5saW5rU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBsb2dXYXJuaW5nLCBsb2dFcnJvciB9IGZyb20gXCIuL3dvcmtmbG93LWxvZ2dlci5qc1wiO1xuaW1wb3J0IHsgcmVhZEV2ZW50cywgZmluZEZvcmtQb2ludCwgZ2V0U2Vzc2lvbklkIH0gZnJvbSBcIi4vd29ya2Zsb3ctZXZlbnRzLmpzXCI7XG5pbXBvcnQgdHlwZSB7IFdvcmtmbG93RXZlbnQgfSBmcm9tIFwiLi93b3JrZmxvdy1ldmVudHMuanNcIjtcbmltcG9ydCB7XG4gIHRyYW5zYWN0aW9uLFxuICB1cGRhdGVUYXNrU3RhdHVzLFxuICB1cGRhdGVTbGljZVN0YXR1cyxcbiAgdXBkYXRlTWlsZXN0b25lU3RhdHVzLFxuICBnZXRTbGljZVRhc2tzLFxuICBpbnNlcnRNaWxlc3RvbmUsXG4gIGdldE1pbGVzdG9uZVNsaWNlcyxcbiAgaW5zZXJ0VmVyaWZpY2F0aW9uRXZpZGVuY2UsXG4gIHVwc2VydERlY2lzaW9uLFxuICBvcGVuRGF0YWJhc2UsXG4gIHNldFRhc2tCbG9ja2VyRGlzY292ZXJlZCxcbiAgaW5zZXJ0T3JJZ25vcmVTbGljZSxcbiAgaW5zZXJ0T3JJZ25vcmVUYXNrLFxufSBmcm9tIFwiLi9nc2QtZGIuanNcIjtcbmltcG9ydCB7IGlzQ2xvc2VkU3RhdHVzIH0gZnJvbSBcIi4vc3RhdHVzLWd1YXJkcy5qc1wiO1xuaW1wb3J0IHsgaW52YWxpZGF0ZVN0YXRlQ2FjaGUgfSBmcm9tIFwiLi9zdGF0ZS5qc1wiO1xuaW1wb3J0IHsgY2xlYXJQYXRoQ2FjaGUsIHJlc29sdmVHc2RQYXRoQ29udHJhY3QgfSBmcm9tIFwiLi9wYXRocy5qc1wiO1xuaW1wb3J0IHsgY2xlYXJQYXJzZUNhY2hlIH0gZnJvbSBcIi4vZmlsZXMuanNcIjtcbmltcG9ydCB7IHdyaXRlTWFuaWZlc3QgfSBmcm9tIFwiLi93b3JrZmxvdy1tYW5pZmVzdC5qc1wiO1xuaW1wb3J0IHsgYXRvbWljV3JpdGVTeW5jIH0gZnJvbSBcIi4vYXRvbWljLXdyaXRlLmpzXCI7XG5pbXBvcnQgeyBhY3F1aXJlU3luY0xvY2ssIHJlbGVhc2VTeW5jTG9jayB9IGZyb20gXCIuL3N5bmMtbG9jay5qc1wiO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUmVwbGF5IEhlbHBlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogUmVwbGF5IGEgY29tcGxldGVfc2xpY2UgZXZlbnQgd2l0aCB0YXNrIHZhbGlkYXRpb24uXG4gKlxuICogIzI5NDUgQnVnIDI6IFRoZSBvcmlnaW5hbCByZXBsYXkgYmxpbmRseSBjYWxsZWQgdXBkYXRlU2xpY2VTdGF0dXMoXCJkb25lXCIpXG4gKiB3aXRob3V0IGNoZWNraW5nIHdoZXRoZXIgYWxsIHRhc2tzIGluIHRoZSBzbGljZSBhcmUgYWN0dWFsbHkgY29tcGxldGUuXG4gKiBEdXJpbmcgQVBJIG92ZXJsb2FkIG9yIHBhcnRpYWwgZXhlY3V0aW9uLCBhIGNvbXBsZXRlX3NsaWNlIGV2ZW50IGNvdWxkXG4gKiBiZSBsb2dnZWQgZXZlbiB3aGVuIHRhc2tzIHdlcmUgc2tpcHBlZCwgY2F1c2luZyB0aGUgbWlsZXN0b25lIGNvbXBsZXRpb25cbiAqIGd1YXJkIHRvIHNlZSB0aGUgc2xpY2UgYXMgXCJkb25lXCIgYW5kIGFsbG93IHByZW1hdHVyZSBtaWxlc3RvbmUgY29tcGxldGlvbi5cbiAqXG4gKiBUaGlzIGZ1bmN0aW9uIHZhbGlkYXRlcyB0aGF0IGV2ZXJ5IHRhc2sgaW4gdGhlIHNsaWNlIGhhcyBhIGNsb3NlZCBzdGF0dXNcbiAqIGJlZm9yZSBtYXJraW5nIHRoZSBzbGljZSBhcyBkb25lLiBJZiBhbnkgdGFzayBpcyBzdGlsbCBwZW5kaW5nLCB0aGUgc2xpY2VcbiAqIHN0YXR1cyBpcyBsZWZ0IHVuY2hhbmdlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlcGxheVNsaWNlQ29tcGxldGUobWlsZXN0b25lSWQ6IHN0cmluZywgc2xpY2VJZDogc3RyaW5nLCB0czogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHRhc2tzID0gZ2V0U2xpY2VUYXNrcyhtaWxlc3RvbmVJZCwgc2xpY2VJZCk7XG4gIC8vIElmIHRoZXJlIGFyZSB0YXNrcyBhbmQgYW55IGFyZSBub3QgY2xvc2VkLCBza2lwIHRoZSBzdGF0dXMgdXBkYXRlXG4gIGlmICh0YXNrcy5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgaW5jb21wbGV0ZVRhc2tzID0gdGFza3MuZmlsdGVyKHQgPT4gIWlzQ2xvc2VkU3RhdHVzKHQuc3RhdHVzKSk7XG4gICAgaWYgKGluY29tcGxldGVUYXNrcy5sZW5ndGggPiAwKSB7XG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgYFtnc2RdIHJlY29uY2lsZTogc2tpcHBpbmcgY29tcGxldGVfc2xpY2UgcmVwbGF5IGZvciAke3NsaWNlSWR9IFx1MjAxNCBgICtcbiAgICAgICAgYCR7aW5jb21wbGV0ZVRhc2tzLmxlbmd0aH0gdGFzayhzKSBzdGlsbCBwZW5kaW5nXFxuYCxcbiAgICAgICk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICB9XG4gIHVwZGF0ZVNsaWNlU3RhdHVzKG1pbGVzdG9uZUlkLCBzbGljZUlkLCBcImRvbmVcIiwgdHMpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUHVibGljIFR5cGVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgaW50ZXJmYWNlIENvbmZsaWN0RW50cnkge1xuICBlbnRpdHlUeXBlOiBzdHJpbmc7XG4gIGVudGl0eUlkOiBzdHJpbmc7XG4gIG1haW5TaWRlRXZlbnRzOiBXb3JrZmxvd0V2ZW50W107XG4gIHdvcmt0cmVlU2lkZUV2ZW50czogV29ya2Zsb3dFdmVudFtdO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFJlY29uY2lsZVJlc3VsdCB7XG4gIGF1dG9NZXJnZWQ6IG51bWJlcjtcbiAgY29uZmxpY3RzOiBDb25mbGljdEVudHJ5W107XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCByZXBsYXlFdmVudHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogUmVwbGF5IGEgbGlzdCBvZiBXb3JrZmxvd0V2ZW50cyBieSBkaXNwYXRjaGluZyBlYWNoIHRvIHRoZSBhcHByb3ByaWF0ZVxuICogZ3NkLWRiIGZ1bmN0aW9uLiAgVGhpcyByZXBsYWNlcyB0aGUgb2xkIGVuZ2luZS5yZXBsYXlBbGwoKSBwYXR0ZXJuIHdpdGhcbiAqIGRpcmVjdCBEQiBjYWxscy5cbiAqL1xuZnVuY3Rpb24gcmVwbGF5RXZlbnRzKGV2ZW50czogV29ya2Zsb3dFdmVudFtdKTogdm9pZCB7XG4gIHRyYW5zYWN0aW9uKCgpID0+IHtcbiAgZm9yIChjb25zdCBldmVudCBvZiBldmVudHMpIHtcbiAgICBjb25zdCBwID0gZXZlbnQucGFyYW1zO1xuICAgIC8vIE5vcm1hbGl6ZSBjbWQgZm9ybWF0OiBjb21wbGV0aW9uIHRvb2xzIHdyaXRlIGh5cGhlbnMgKFwiY29tcGxldGUtdGFza1wiKSxcbiAgICAvLyBsZWdhY3kgbG9ncyB1c2UgdW5kZXJzY29yZXMgKFwiY29tcGxldGVfdGFza1wiKS4gQWNjZXB0IGJvdGggZm9ybWF0cy5cbiAgICAvLyBUeXBlIGd1YXJkOiBtYWxmb3JtZWQgZXZlbnQgbGluZXMgd2l0aCBub24tc3RyaW5nIGNtZCBhcmUgc2tpcHBlZC5cbiAgICBpZiAodHlwZW9mIGV2ZW50LmNtZCAhPT0gXCJzdHJpbmdcIikge1xuICAgICAgbG9nV2FybmluZyhcInJlY29uY2lsZVwiLCBgRXZlbnQgd2l0aCBub24tc3RyaW5nIGNtZCBza2lwcGVkOiAke0pTT04uc3RyaW5naWZ5KGV2ZW50LmNtZCl9YCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgY21kID0gZXZlbnQuY21kLnJlcGxhY2UoLy0vZywgXCJfXCIpO1xuICAgIHN3aXRjaCAoY21kKSB7XG4gICAgICBjYXNlIFwiY29tcGxldGVfdGFza1wiOiB7XG4gICAgICAgIGNvbnN0IG1pbGVzdG9uZUlkID0gcFtcIm1pbGVzdG9uZUlkXCJdIGFzIHN0cmluZztcbiAgICAgICAgY29uc3Qgc2xpY2VJZCA9IHBbXCJzbGljZUlkXCJdIGFzIHN0cmluZztcbiAgICAgICAgY29uc3QgdGFza0lkID0gcFtcInRhc2tJZFwiXSBhcyBzdHJpbmc7XG4gICAgICAgIHVwZGF0ZVRhc2tTdGF0dXMobWlsZXN0b25lSWQsIHNsaWNlSWQsIHRhc2tJZCwgXCJkb25lXCIsIGV2ZW50LnRzKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwic3RhcnRfdGFza1wiOiB7XG4gICAgICAgIGNvbnN0IG1pbGVzdG9uZUlkID0gcFtcIm1pbGVzdG9uZUlkXCJdIGFzIHN0cmluZztcbiAgICAgICAgY29uc3Qgc2xpY2VJZCA9IHBbXCJzbGljZUlkXCJdIGFzIHN0cmluZztcbiAgICAgICAgY29uc3QgdGFza0lkID0gcFtcInRhc2tJZFwiXSBhcyBzdHJpbmc7XG4gICAgICAgIHVwZGF0ZVRhc2tTdGF0dXMobWlsZXN0b25lSWQsIHNsaWNlSWQsIHRhc2tJZCwgXCJpbi1wcm9ncmVzc1wiLCBldmVudC50cyk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcInJlcG9ydF9ibG9ja2VyXCI6IHtcbiAgICAgICAgY29uc3QgbWlsZXN0b25lSWQgPSBwW1wibWlsZXN0b25lSWRcIl0gYXMgc3RyaW5nO1xuICAgICAgICBjb25zdCBzbGljZUlkID0gcFtcInNsaWNlSWRcIl0gYXMgc3RyaW5nO1xuICAgICAgICBjb25zdCB0YXNrSWQgPSBwW1widGFza0lkXCJdIGFzIHN0cmluZztcbiAgICAgICAgdXBkYXRlVGFza1N0YXR1cyhtaWxlc3RvbmVJZCwgc2xpY2VJZCwgdGFza0lkLCBcImJsb2NrZWRcIik7XG4gICAgICAgIHNldFRhc2tCbG9ja2VyRGlzY292ZXJlZChtaWxlc3RvbmVJZCwgc2xpY2VJZCwgdGFza0lkLCB0cnVlKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwicmVjb3JkX3ZlcmlmaWNhdGlvblwiOiB7XG4gICAgICAgIGNvbnN0IG1pbGVzdG9uZUlkID0gcFtcIm1pbGVzdG9uZUlkXCJdIGFzIHN0cmluZztcbiAgICAgICAgY29uc3Qgc2xpY2VJZCA9IHBbXCJzbGljZUlkXCJdIGFzIHN0cmluZztcbiAgICAgICAgY29uc3QgdGFza0lkID0gcFtcInRhc2tJZFwiXSBhcyBzdHJpbmc7XG4gICAgICAgIGluc2VydFZlcmlmaWNhdGlvbkV2aWRlbmNlKHtcbiAgICAgICAgICB0YXNrSWQsXG4gICAgICAgICAgc2xpY2VJZCxcbiAgICAgICAgICBtaWxlc3RvbmVJZCxcbiAgICAgICAgICBjb21tYW5kOiAocFtcImNvbW1hbmRcIl0gYXMgc3RyaW5nKSA/PyBcIlwiLFxuICAgICAgICAgIGV4aXRDb2RlOiAocFtcImV4aXRDb2RlXCJdIGFzIG51bWJlcikgPz8gMCxcbiAgICAgICAgICB2ZXJkaWN0OiAocFtcInZlcmRpY3RcIl0gYXMgc3RyaW5nKSA/PyBcIlwiLFxuICAgICAgICAgIGR1cmF0aW9uTXM6IChwW1wiZHVyYXRpb25Nc1wiXSBhcyBudW1iZXIpID8/IDAsXG4gICAgICAgIH0pO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJjb21wbGV0ZV9zbGljZVwiOiB7XG4gICAgICAgIGNvbnN0IG1pbGVzdG9uZUlkID0gcFtcIm1pbGVzdG9uZUlkXCJdIGFzIHN0cmluZztcbiAgICAgICAgY29uc3Qgc2xpY2VJZCA9IHBbXCJzbGljZUlkXCJdIGFzIHN0cmluZztcbiAgICAgICAgLy8gIzI5NDUgQnVnIDI6IHZhbGlkYXRlIHRhc2tzIGJlZm9yZSBtYXJraW5nIHNsaWNlIGRvbmVcbiAgICAgICAgcmVwbGF5U2xpY2VDb21wbGV0ZShtaWxlc3RvbmVJZCwgc2xpY2VJZCwgZXZlbnQudHMpO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJjb21wbGV0ZV9taWxlc3RvbmVcIjoge1xuICAgICAgICBjb25zdCBtaWxlc3RvbmVJZCA9IHBbXCJtaWxlc3RvbmVJZFwiXSBhcyBzdHJpbmc7XG4gICAgICAgIGlmICghbWlsZXN0b25lSWQpIGJyZWFrO1xuICAgICAgICAvLyBJbnZhcmlhbnQgY2hlY2s6IG9ubHkgbWFyayBjb21wbGV0ZSBpZiBhbGwgc2xpY2VzIGFyZSBjbG9zZWQuXG4gICAgICAgIC8vIFdpdGhvdXQgdGhpcyBndWFyZCwgYSByZW9yZGVyZWQvcGFydGlhbCBldmVudCBzdHJlYW0gY291bGQgY2xvc2VcbiAgICAgICAgLy8gYSBtaWxlc3RvbmUgd2hpbGUgd29yayBpcyBzdGlsbCBpbmNvbXBsZXRlLlxuICAgICAgICBjb25zdCBtU2xpY2VzID0gZ2V0TWlsZXN0b25lU2xpY2VzKG1pbGVzdG9uZUlkKTtcbiAgICAgICAgY29uc3QgYWxsQ2xvc2VkID0gbVNsaWNlcy5sZW5ndGggPT09IDAgfHwgbVNsaWNlcy5ldmVyeShzID0+IGlzQ2xvc2VkU3RhdHVzKHMuc3RhdHVzKSk7XG4gICAgICAgIGlmIChhbGxDbG9zZWQpIHtcbiAgICAgICAgICB1cGRhdGVNaWxlc3RvbmVTdGF0dXMobWlsZXN0b25lSWQsIFwiY29tcGxldGVcIiwgZXZlbnQudHMpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGxvZ1dhcm5pbmcoXCJyZWNvbmNpbGVcIiwgYFNraXBwaW5nIGNvbXBsZXRlX21pbGVzdG9uZSByZXBsYXkgZm9yICR7bWlsZXN0b25lSWR9OiBub3QgYWxsIHNsaWNlcyBhcmUgY2xvc2VkYCk7XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwicGxhbl9taWxlc3RvbmVcIjoge1xuICAgICAgICAvLyBSZXBsYXkgbWlsZXN0b25lIGNyZWF0aW9uIFx1MjAxNCB1c2VzIElOU0VSVCBPUiBJR05PUkUgKGdzZC1kYidzIGluc2VydE1pbGVzdG9uZSBpcyBzYWZlKVxuICAgICAgICBjb25zdCBtSWQgPSBwW1wibWlsZXN0b25lSWRcIl0gYXMgc3RyaW5nO1xuICAgICAgICBpZiAobUlkKSB7XG4gICAgICAgICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IG1JZCwgdGl0bGU6IChwW1widGl0bGVcIl0gYXMgc3RyaW5nKSA/PyBtSWQgfSk7XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwicGxhbl9zbGljZVwiOiB7XG4gICAgICAgIC8vIFJlcGxheSBzbGljZSBjcmVhdGlvbiBcdTIwMTQgc3RyaWN0IElOU0VSVCBPUiBJR05PUkUgdG8gYXZvaWQgb3ZlcndyaXRpbmdcbiAgICAgICAgLy8gcHJvZ3Jlc3NlZCBzdGF0dXMuIGluc2VydFNsaWNlKCkgdXNlcyBPTiBDT05GTElDVCBETyBVUERBVEUgd2hpY2hcbiAgICAgICAgLy8gY291bGQgZG93bmdyYWRlIGEgY29tcGxldGVkIHNsaWNlIGJhY2sgdG8gcGVuZGluZy5cbiAgICAgICAgY29uc3QgbWlsZXN0b25lSWQgPSBwW1wibWlsZXN0b25lSWRcIl0gYXMgc3RyaW5nO1xuICAgICAgICBjb25zdCBzbGljZUlkID0gcFtcInNsaWNlSWRcIl0gYXMgc3RyaW5nO1xuICAgICAgICBpZiAobWlsZXN0b25lSWQgJiYgc2xpY2VJZCkge1xuICAgICAgICAgIGluc2VydE9ySWdub3JlU2xpY2Uoe1xuICAgICAgICAgICAgbWlsZXN0b25lSWQsXG4gICAgICAgICAgICBzbGljZUlkLFxuICAgICAgICAgICAgdGl0bGU6IChwW1widGl0bGVcIl0gYXMgc3RyaW5nKSA/PyBzbGljZUlkLFxuICAgICAgICAgICAgY3JlYXRlZEF0OiBldmVudC50cyxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgXCJwbGFuX3Rhc2tcIjoge1xuICAgICAgICAvLyBSZXBsYXkgdGFzayBjcmVhdGlvbiBcdTIwMTQgc3RyaWN0IElOU0VSVCBPUiBJR05PUkUgdG8gYXZvaWQgb3ZlcndyaXRpbmdcbiAgICAgICAgLy8gcHJvZ3Jlc3NlZCBzdGF0dXMuIGluc2VydFRhc2soKSB1c2VzIE9OIENPTkZMSUNUIERPIFVQREFURSB3aGljaFxuICAgICAgICAvLyBjb3VsZCBkb3duZ3JhZGUgYSBkb25lL2luLXByb2dyZXNzIHRhc2sgYmFjayB0byBwZW5kaW5nLlxuICAgICAgICBjb25zdCBtaWxlc3RvbmVJZCA9IHBbXCJtaWxlc3RvbmVJZFwiXSBhcyBzdHJpbmc7XG4gICAgICAgIGNvbnN0IHNsaWNlSWQgPSBwW1wic2xpY2VJZFwiXSBhcyBzdHJpbmc7XG4gICAgICAgIGNvbnN0IHRhc2tJZCA9IHBbXCJ0YXNrSWRcIl0gYXMgc3RyaW5nO1xuICAgICAgICBpZiAobWlsZXN0b25lSWQgJiYgc2xpY2VJZCAmJiB0YXNrSWQpIHtcbiAgICAgICAgICBpbnNlcnRPcklnbm9yZVRhc2soe1xuICAgICAgICAgICAgbWlsZXN0b25lSWQsXG4gICAgICAgICAgICBzbGljZUlkLFxuICAgICAgICAgICAgdGFza0lkLFxuICAgICAgICAgICAgdGl0bGU6IChwW1widGl0bGVcIl0gYXMgc3RyaW5nKSA/PyB0YXNrSWQsXG4gICAgICAgICAgICBjcmVhdGVkQXQ6IGV2ZW50LnRzLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSBcInJlcGxhbl9zbGljZVwiOiB7XG4gICAgICAgIC8vIEluZm9ybWF0aW9uYWwgXHUyMDE0IHJlcGxhbiBldmVudHMgZG9uJ3QgbXV0YXRlIERCIGR1cmluZyByZXBsYXlcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlIFwic2F2ZV9kZWNpc2lvblwiOiB7XG4gICAgICAgIHVwc2VydERlY2lzaW9uKHtcbiAgICAgICAgICBpZDogKHBbXCJpZFwiXSBhcyBzdHJpbmcpID8/IGAke3BbXCJzY29wZVwiXX06JHtwW1wiZGVjaXNpb25cIl19YCxcbiAgICAgICAgICB3aGVuX2NvbnRleHQ6IChwW1wid2hlbl9jb250ZXh0XCJdIGFzIHN0cmluZykgPz8gKHBbXCJ3aGVuQ29udGV4dFwiXSBhcyBzdHJpbmcpID8/IFwiXCIsXG4gICAgICAgICAgc2NvcGU6IChwW1wic2NvcGVcIl0gYXMgc3RyaW5nKSA/PyBcIlwiLFxuICAgICAgICAgIGRlY2lzaW9uOiAocFtcImRlY2lzaW9uXCJdIGFzIHN0cmluZykgPz8gXCJcIixcbiAgICAgICAgICBjaG9pY2U6IChwW1wiY2hvaWNlXCJdIGFzIHN0cmluZykgPz8gXCJcIixcbiAgICAgICAgICByYXRpb25hbGU6IChwW1wicmF0aW9uYWxlXCJdIGFzIHN0cmluZykgPz8gXCJcIixcbiAgICAgICAgICByZXZpc2FibGU6IChwW1wicmV2aXNhYmxlXCJdIGFzIHN0cmluZykgPz8gXCJ5ZXNcIixcbiAgICAgICAgICBtYWRlX2J5OiAoKHBbXCJtYWRlX2J5XCJdIGFzIHN0cmluZykgPz8gKHBbXCJtYWRlQnlcIl0gYXMgc3RyaW5nKSA/PyBcImFnZW50XCIpIGFzIFwiYWdlbnRcIixcbiAgICAgICAgICBzdXBlcnNlZGVkX2J5OiAocFtcInN1cGVyc2VkZWRfYnlcIl0gYXMgc3RyaW5nKSA/PyAocFtcInN1cGVyc2VkZWRCeVwiXSBhcyBzdHJpbmcpID8/IG51bGwsXG4gICAgICAgIH0pO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIGxvZ1dhcm5pbmcoXCJyZWNvbmNpbGVcIiwgYFVua25vd24gZXZlbnQgY21kIGR1cmluZyByZXBsYXk6IFwiJHtldmVudC5jbWR9XCIgXHUyMDE0IHNraXBwZWRgKTtcbiAgICAgICAgYnJlYWs7XG4gICAgfVxuICB9XG4gIH0pOyAvLyBlbmQgdHJhbnNhY3Rpb25cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGV4dHJhY3RFbnRpdHlLZXkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogTWFwIGEgV29ya2Zsb3dFdmVudCBjb21tYW5kIHRvIGl0cyBhZmZlY3RlZCBlbnRpdHkgdHlwZSBhbmQgSUQuXG4gKiBSZXR1cm5zIG51bGwgZm9yIGNvbW1hbmRzIHRoYXQgZG9uJ3QgdG91Y2ggYSBuYW1lZCBlbnRpdHlcbiAqIChlLmcuIHVua25vd24gb3IgZnV0dXJlIGNtZHMpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZXh0cmFjdEVudGl0eUtleShcbiAgZXZlbnQ6IFdvcmtmbG93RXZlbnQsXG4pOiB7IHR5cGU6IHN0cmluZzsgaWQ6IHN0cmluZyB9IHwgbnVsbCB7XG4gIGNvbnN0IHAgPSBldmVudC5wYXJhbXM7XG4gIC8vIE5vcm1hbGl6ZSBjbWQgZm9ybWF0OiBhY2NlcHQgYm90aCBoeXBoZW5zIGFuZCB1bmRlcnNjb3Jlc1xuICBpZiAodHlwZW9mIGV2ZW50LmNtZCAhPT0gXCJzdHJpbmdcIikgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGNtZCA9IGV2ZW50LmNtZC5yZXBsYWNlKC8tL2csIFwiX1wiKTtcblxuICBzd2l0Y2ggKGNtZCkge1xuICAgIGNhc2UgXCJjb21wbGV0ZV90YXNrXCI6XG4gICAgY2FzZSBcInN0YXJ0X3Rhc2tcIjpcbiAgICBjYXNlIFwicmVwb3J0X2Jsb2NrZXJcIjpcbiAgICBjYXNlIFwicmVjb3JkX3ZlcmlmaWNhdGlvblwiOlxuICAgIGNhc2UgXCJwbGFuX3Rhc2tcIjpcbiAgICAgIHJldHVybiB0eXBlb2YgcFtcInRhc2tJZFwiXSA9PT0gXCJzdHJpbmdcIlxuICAgICAgICA/IHsgdHlwZTogXCJ0YXNrXCIsIGlkOiBwW1widGFza0lkXCJdIH1cbiAgICAgICAgOiBudWxsO1xuXG4gICAgY2FzZSBcImNvbXBsZXRlX3NsaWNlXCI6XG4gICAgY2FzZSBcInJlcGxhbl9zbGljZVwiOlxuICAgICAgcmV0dXJuIHR5cGVvZiBwW1wic2xpY2VJZFwiXSA9PT0gXCJzdHJpbmdcIlxuICAgICAgICA/IHsgdHlwZTogXCJzbGljZVwiLCBpZDogcFtcInNsaWNlSWRcIl0gfVxuICAgICAgICA6IG51bGw7XG5cbiAgICBjYXNlIFwicGxhbl9zbGljZVwiOlxuICAgICAgcmV0dXJuIHR5cGVvZiBwW1wic2xpY2VJZFwiXSA9PT0gXCJzdHJpbmdcIlxuICAgICAgICA/IHsgdHlwZTogXCJzbGljZV9wbGFuXCIsIGlkOiBwW1wic2xpY2VJZFwiXSB9XG4gICAgICAgIDogbnVsbDtcblxuICAgIGNhc2UgXCJjb21wbGV0ZV9taWxlc3RvbmVcIjpcbiAgICBjYXNlIFwicGxhbl9taWxlc3RvbmVcIjpcbiAgICAgIHJldHVybiB0eXBlb2YgcFtcIm1pbGVzdG9uZUlkXCJdID09PSBcInN0cmluZ1wiXG4gICAgICAgID8geyB0eXBlOiBcIm1pbGVzdG9uZVwiLCBpZDogcFtcIm1pbGVzdG9uZUlkXCJdIH1cbiAgICAgICAgOiBudWxsO1xuXG4gICAgY2FzZSBcInNhdmVfZGVjaXNpb25cIjpcbiAgICAgIGlmICh0eXBlb2YgcFtcInNjb3BlXCJdID09PSBcInN0cmluZ1wiICYmIHR5cGVvZiBwW1wiZGVjaXNpb25cIl0gPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgcmV0dXJuIHsgdHlwZTogXCJkZWNpc2lvblwiLCBpZDogYCR7cFtcInNjb3BlXCJdfToke3BbXCJkZWNpc2lvblwiXX1gIH07XG4gICAgICB9XG4gICAgICByZXR1cm4gbnVsbDtcblxuICAgIGRlZmF1bHQ6XG4gICAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgZGV0ZWN0Q29uZmxpY3RzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIENvbXBhcmUgdHdvIHNldHMgb2YgZGl2ZXJnZWQgZXZlbnRzLiBSZXR1cm5zIGNvbmZsaWN0IGVudHJpZXMgZm9yIGFueVxuICogZW50aXR5IHRvdWNoZWQgYnkgYm90aCBzaWRlcy5cbiAqXG4gKiBFbnRpdHktbGV2ZWwgZ3JhbnVsYXJpdHk6IGlmIGJvdGggc2lkZXMgdG91Y2hlZCB0YXNrIFQwMSAod2l0aCBhbnkgY21kKSxcbiAqIHRoYXQgaXMgb25lIGNvbmZsaWN0IHJlZ2FyZGxlc3Mgb2YgZmllbGQtbGV2ZWwgZGlmZmVyZW5jZXMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZXRlY3RDb25mbGljdHMoXG4gIG1haW5EaXZlcmdlZDogV29ya2Zsb3dFdmVudFtdLFxuICB3dERpdmVyZ2VkOiBXb3JrZmxvd0V2ZW50W10sXG4pOiBDb25mbGljdEVudHJ5W10ge1xuICAvLyBHcm91cCBlYWNoIHNpZGUncyBldmVudHMgYnkgZW50aXR5IGtleVxuICBjb25zdCBtYWluQnlFbnRpdHkgPSBuZXcgTWFwPHN0cmluZywgV29ya2Zsb3dFdmVudFtdPigpO1xuICBmb3IgKGNvbnN0IGV2ZW50IG9mIG1haW5EaXZlcmdlZCkge1xuICAgIGNvbnN0IGtleSA9IGV4dHJhY3RFbnRpdHlLZXkoZXZlbnQpO1xuICAgIGlmICgha2V5KSBjb250aW51ZTtcbiAgICBjb25zdCBidWNrZXQgPSBtYWluQnlFbnRpdHkuZ2V0KGAke2tleS50eXBlfToke2tleS5pZH1gKSA/PyBbXTtcbiAgICBidWNrZXQucHVzaChldmVudCk7XG4gICAgbWFpbkJ5RW50aXR5LnNldChgJHtrZXkudHlwZX06JHtrZXkuaWR9YCwgYnVja2V0KTtcbiAgfVxuXG4gIGNvbnN0IHd0QnlFbnRpdHkgPSBuZXcgTWFwPHN0cmluZywgV29ya2Zsb3dFdmVudFtdPigpO1xuICBmb3IgKGNvbnN0IGV2ZW50IG9mIHd0RGl2ZXJnZWQpIHtcbiAgICBjb25zdCBrZXkgPSBleHRyYWN0RW50aXR5S2V5KGV2ZW50KTtcbiAgICBpZiAoIWtleSkgY29udGludWU7XG4gICAgY29uc3QgYnVja2V0ID0gd3RCeUVudGl0eS5nZXQoYCR7a2V5LnR5cGV9OiR7a2V5LmlkfWApID8/IFtdO1xuICAgIGJ1Y2tldC5wdXNoKGV2ZW50KTtcbiAgICB3dEJ5RW50aXR5LnNldChgJHtrZXkudHlwZX06JHtrZXkuaWR9YCwgYnVja2V0KTtcbiAgfVxuXG4gIC8vIEZpbmQgZW50aXRpZXMgdG91Y2hlZCBieSBib3RoIHNpZGVzXG4gIGNvbnN0IGNvbmZsaWN0czogQ29uZmxpY3RFbnRyeVtdID0gW107XG4gIGZvciAoY29uc3QgW2VudGl0eUtleSwgbWFpbkV2ZW50c10gb2YgbWFpbkJ5RW50aXR5KSB7XG4gICAgY29uc3Qgd3RFdmVudHMgPSB3dEJ5RW50aXR5LmdldChlbnRpdHlLZXkpO1xuICAgIGlmICghd3RFdmVudHMpIGNvbnRpbnVlO1xuXG4gICAgY29uc3QgY29sb25JZHggPSBlbnRpdHlLZXkuaW5kZXhPZihcIjpcIik7XG4gICAgY29uc3QgZW50aXR5VHlwZSA9IGVudGl0eUtleS5zbGljZSgwLCBjb2xvbklkeCk7XG4gICAgY29uc3QgZW50aXR5SWQgPSBlbnRpdHlLZXkuc2xpY2UoY29sb25JZHggKyAxKTtcblxuICAgIGNvbmZsaWN0cy5wdXNoKHtcbiAgICAgIGVudGl0eVR5cGUsXG4gICAgICBlbnRpdHlJZCxcbiAgICAgIG1haW5TaWRlRXZlbnRzOiBtYWluRXZlbnRzLFxuICAgICAgd29ya3RyZWVTaWRlRXZlbnRzOiB3dEV2ZW50cyxcbiAgICB9KTtcbiAgfVxuXG4gIHJldHVybiBjb25mbGljdHM7XG59XG5cbmZ1bmN0aW9uIHJld3JpdGVEaXZlcmdlZEV2ZW50c0ZvckVudGl0eShcbiAgZGl2ZXJnZWRFdmVudHM6IFdvcmtmbG93RXZlbnRbXSxcbiAgZW50aXR5VHlwZTogc3RyaW5nLFxuICBlbnRpdHlJZDogc3RyaW5nLFxuICByZXBsYWNlbWVudEV2ZW50czogV29ya2Zsb3dFdmVudFtdLFxuKTogV29ya2Zsb3dFdmVudFtdIHtcbiAgY29uc3QgcmV3cml0dGVuOiBXb3JrZmxvd0V2ZW50W10gPSBbXTtcbiAgbGV0IGluc2VydGVkID0gZmFsc2U7XG5cbiAgZm9yIChjb25zdCBldmVudCBvZiBkaXZlcmdlZEV2ZW50cykge1xuICAgIGNvbnN0IGtleSA9IGV4dHJhY3RFbnRpdHlLZXkoZXZlbnQpO1xuICAgIGlmIChrZXk/LnR5cGUgPT09IGVudGl0eVR5cGUgJiYga2V5LmlkID09PSBlbnRpdHlJZCkge1xuICAgICAgaWYgKCFpbnNlcnRlZCkge1xuICAgICAgICByZXdyaXR0ZW4ucHVzaCguLi5yZXBsYWNlbWVudEV2ZW50cyk7XG4gICAgICAgIGluc2VydGVkID0gdHJ1ZTtcbiAgICAgIH1cbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICByZXdyaXR0ZW4ucHVzaChldmVudCk7XG4gIH1cblxuICBpZiAoIWluc2VydGVkKSB7XG4gICAgcmV3cml0dGVuLnB1c2goLi4ucmVwbGFjZW1lbnRFdmVudHMpO1xuICB9XG5cbiAgcmV0dXJuIHJld3JpdHRlbjtcbn1cblxuZnVuY3Rpb24gd3JpdGVFdmVudExvZyhiYXNlUGF0aDogc3RyaW5nLCBldmVudHM6IFdvcmtmbG93RXZlbnRbXSk6IHZvaWQge1xuICBjb25zdCBkaXIgPSBqb2luKGJhc2VQYXRoLCBcIi5nc2RcIik7XG4gIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBjb25zdCBjb250ZW50ID0gZXZlbnRzLm1hcCgoZSkgPT4gSlNPTi5zdHJpbmdpZnkoZSkpLmpvaW4oXCJcXG5cIikgKyAoZXZlbnRzLmxlbmd0aCA+IDAgPyBcIlxcblwiIDogXCJcIik7XG4gIGF0b21pY1dyaXRlU3luYyhqb2luKGRpciwgXCJldmVudC1sb2cuanNvbmxcIiksIGNvbnRlbnQpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgd3JpdGVDb25mbGljdHNGaWxlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFdyaXRlIGEgaHVtYW4tcmVhZGFibGUgQ09ORkxJQ1RTLm1kIHRvIGJhc2VQYXRoLy5nc2QvQ09ORkxJQ1RTLm1kLlxuICogTGlzdHMgZWFjaCBjb25mbGljdCB3aXRoIGJvdGggc2lkZXMnIGV2ZW50IHBheWxvYWRzIGFuZCByZXNvbHV0aW9uIGluc3RydWN0aW9ucy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdyaXRlQ29uZmxpY3RzRmlsZShcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgY29uZmxpY3RzOiBDb25mbGljdEVudHJ5W10sXG4gIHdvcmt0cmVlUGF0aDogc3RyaW5nLFxuKTogdm9pZCB7XG4gIGNvbnN0IHRpbWVzdGFtcCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcbiAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW1xuICAgIGAjIE1lcmdlIENvbmZsaWN0cyBcdTIwMTQgJHt0aW1lc3RhbXB9YCxcbiAgICBcIlwiLFxuICAgIGBDb25mbGljdHMgZGV0ZWN0ZWQgbWVyZ2luZyB3b3JrdHJlZSBcXGAke3dvcmt0cmVlUGF0aH1cXGAgaW50byBcXGAke2Jhc2VQYXRofVxcYC5gLFxuICAgIGBSdW4gXFxgZ3NkIHJlc29sdmUtY29uZmxpY3RcXGAgdG8gcmVzb2x2ZSBlYWNoIGNvbmZsaWN0LmAsXG4gICAgXCJcIixcbiAgXTtcblxuICBjb25mbGljdHMuZm9yRWFjaCgoY29uZmxpY3QsIGlkeCkgPT4ge1xuICAgIGxpbmVzLnB1c2goYCMjIENvbmZsaWN0ICR7aWR4ICsgMX06ICR7Y29uZmxpY3QuZW50aXR5VHlwZX0gJHtjb25mbGljdC5lbnRpdHlJZH1gKTtcbiAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICAgIGxpbmVzLnB1c2goXCIqKk1haW4gc2lkZSBldmVudHM6KipcIik7XG4gICAgZm9yIChjb25zdCBldmVudCBvZiBjb25mbGljdC5tYWluU2lkZUV2ZW50cykge1xuICAgICAgbGluZXMucHVzaChgLSAke2V2ZW50LmNtZH0gYXQgJHtldmVudC50c30gKGhhc2g6ICR7ZXZlbnQuaGFzaH0pYCk7XG4gICAgICBsaW5lcy5wdXNoKGAgIHBhcmFtczogJHtKU09OLnN0cmluZ2lmeShldmVudC5wYXJhbXMpfWApO1xuICAgIH1cbiAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICAgIGxpbmVzLnB1c2goXCIqKldvcmt0cmVlIHNpZGUgZXZlbnRzOioqXCIpO1xuICAgIGZvciAoY29uc3QgZXZlbnQgb2YgY29uZmxpY3Qud29ya3RyZWVTaWRlRXZlbnRzKSB7XG4gICAgICBsaW5lcy5wdXNoKGAtICR7ZXZlbnQuY21kfSBhdCAke2V2ZW50LnRzfSAoaGFzaDogJHtldmVudC5oYXNofSlgKTtcbiAgICAgIGxpbmVzLnB1c2goYCAgcGFyYW1zOiAke0pTT04uc3RyaW5naWZ5KGV2ZW50LnBhcmFtcyl9YCk7XG4gICAgfVxuICAgIGxpbmVzLnB1c2goXCJcIik7XG4gICAgbGluZXMucHVzaChgKipSZXNvbHZlIHdpdGg6KiogXFxgZ3NkIHJlc29sdmUtY29uZmxpY3QgLS1lbnRpdHkgJHtjb25mbGljdC5lbnRpdHlUeXBlfToke2NvbmZsaWN0LmVudGl0eUlkfSAtLXBpY2sgW21haW58d29ya3RyZWVdXFxgYCk7XG4gICAgbGluZXMucHVzaChcIlwiKTtcbiAgfSk7XG5cbiAgY29uc3QgY29udGVudCA9IGxpbmVzLmpvaW4oXCJcXG5cIik7XG4gIGNvbnN0IGRpciA9IGpvaW4oYmFzZVBhdGgsIFwiLmdzZFwiKTtcbiAgbWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGF0b21pY1dyaXRlU3luYyhqb2luKGRpciwgXCJDT05GTElDVFMubWRcIiksIGNvbnRlbnQpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgcmVjb25jaWxlV29ya3RyZWVMb2dzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIEV2ZW50LWxvZy1iYXNlZCByZWNvbmNpbGlhdGlvbiBhbGdvcml0aG06XG4gKlxuICogMS4gUmVhZCBib3RoIGV2ZW50IGxvZ3NcbiAqIDIuIEZpbmQgZm9yayBwb2ludCAobGFzdCBjb21tb24gZXZlbnQgYnkgaGFzaClcbiAqIDMuIFNsaWNlIGRpdmVyZ2VkIHNldHMgZnJvbSBlYWNoIHNpZGVcbiAqIDQuIElmIG5vIGRpdmVyZ2VuY2Ugb24gZWl0aGVyIHNpZGUgXHUyMTkyIHJldHVybiBhdXRvTWVyZ2VkOiAwLCBjb25mbGljdHM6IFtdXG4gKiA1LiBkZXRlY3RDb25mbGljdHMoKSBcdTIwMTQgaWYgYW55LCB3cml0ZUNvbmZsaWN0c0ZpbGUgKyByZXR1cm4gZWFybHkgKEQtMDQgYWxsLW9yLW5vdGhpbmcpXG4gKiA2LiBJZiBjbGVhbjogc29ydCBtZXJnZWQgPSBtYWluRGl2ZXJnZWQgKyB3dERpdmVyZ2VkIGJ5IHRpbWVzdGFtcCwgcmVwbGF5QWxsXG4gKiA3LiBXcml0ZSBtZXJnZWQgZXZlbnQgbG9nIChiYXNlICsgbWVyZ2VkIGluIHRpbWVzdGFtcCBvcmRlcilcbiAqIDguIHdyaXRlTWFuaWZlc3RcbiAqIDkuIFJldHVybiB7IGF1dG9NZXJnZWQ6IG1lcmdlZC5sZW5ndGgsIGNvbmZsaWN0czogW10gfVxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVjb25jaWxlV29ya3RyZWVMb2dzKFxuICBtYWluQmFzZVBhdGg6IHN0cmluZyxcbiAgd29ya3RyZWVCYXNlUGF0aDogc3RyaW5nLFxuKTogUmVjb25jaWxlUmVzdWx0IHtcbiAgLy8gQWNxdWlyZSBhZHZpc29yeSBsb2NrIHRvIHByZXZlbnQgY29uY3VycmVudCByZWNvbmNpbGUgKyBhcHBlbmQgcmFjZXNcbiAgY29uc3QgbG9jayA9IGFjcXVpcmVTeW5jTG9jayhtYWluQmFzZVBhdGgpO1xuICBpZiAoIWxvY2suYWNxdWlyZWQpIHtcbiAgICBsb2dXYXJuaW5nKFwicmVjb25jaWxlXCIsIFwiY291bGQgbm90IGFjcXVpcmUgc3luYyBsb2NrIFx1MjAxNCBhbm90aGVyIHJlY29uY2lsaWF0aW9uIG1heSBiZSBpbiBwcm9ncmVzc1wiKTtcbiAgICByZXR1cm4geyBhdXRvTWVyZ2VkOiAwLCBjb25mbGljdHM6IFtdIH07XG4gIH1cblxuICB0cnkge1xuICAgIHJldHVybiBfcmVjb25jaWxlV29ya3RyZWVMb2dzSW5uZXIobWFpbkJhc2VQYXRoLCB3b3JrdHJlZUJhc2VQYXRoKTtcbiAgfSBmaW5hbGx5IHtcbiAgICByZWxlYXNlU3luY0xvY2sobWFpbkJhc2VQYXRoKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBfcmVjb25jaWxlV29ya3RyZWVMb2dzSW5uZXIoXG4gIG1haW5CYXNlUGF0aDogc3RyaW5nLFxuICB3b3JrdHJlZUJhc2VQYXRoOiBzdHJpbmcsXG4pOiBSZWNvbmNpbGVSZXN1bHQge1xuICAvLyBTdGVwIDE6IFJlYWQgYm90aCBsb2dzXG4gIGNvbnN0IG1haW5Mb2dQYXRoID0gam9pbihtYWluQmFzZVBhdGgsIFwiLmdzZFwiLCBcImV2ZW50LWxvZy5qc29ubFwiKTtcbiAgY29uc3Qgd3RMb2dQYXRoID0gam9pbih3b3JrdHJlZUJhc2VQYXRoLCBcIi5nc2RcIiwgXCJldmVudC1sb2cuanNvbmxcIik7XG5cbiAgY29uc3QgbWFpbkV2ZW50cyA9IHJlYWRFdmVudHMobWFpbkxvZ1BhdGgpO1xuICBjb25zdCB3dEV2ZW50cyA9IHJlYWRFdmVudHMod3RMb2dQYXRoKTtcblxuICAvLyBTdGVwIDI6IEZpbmQgZm9yayBwb2ludFxuICBjb25zdCBmb3JrUG9pbnQgPSBmaW5kRm9ya1BvaW50KG1haW5FdmVudHMsIHd0RXZlbnRzKTtcblxuICAvLyBTdGVwIDM6IFNsaWNlIGRpdmVyZ2VkIHNldHNcbiAgY29uc3QgbWFpbkRpdmVyZ2VkID0gbWFpbkV2ZW50cy5zbGljZShmb3JrUG9pbnQgKyAxKTtcbiAgY29uc3Qgd3REaXZlcmdlZCA9IHd0RXZlbnRzLnNsaWNlKGZvcmtQb2ludCArIDEpO1xuXG4gIC8vIFN0ZXAgNDogTm8gZGl2ZXJnZW5jZSBvbiBlaXRoZXIgc2lkZVxuICBpZiAobWFpbkRpdmVyZ2VkLmxlbmd0aCA9PT0gMCAmJiB3dERpdmVyZ2VkLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiB7IGF1dG9NZXJnZWQ6IDAsIGNvbmZsaWN0czogW10gfTtcbiAgfVxuXG4gIC8vIFN0ZXAgNTogRGV0ZWN0IGNvbmZsaWN0cyAoZW50aXR5LWxldmVsKVxuICBjb25zdCBjb25mbGljdHMgPSBkZXRlY3RDb25mbGljdHMobWFpbkRpdmVyZ2VkLCB3dERpdmVyZ2VkKTtcbiAgaWYgKGNvbmZsaWN0cy5sZW5ndGggPiAwKSB7XG4gICAgLy8gRC0wNDogYXRvbWljIGFsbC1vci1ub3RoaW5nIFx1MjAxNCBibG9jayBlbnRpcmUgbWVyZ2VcbiAgICB3cml0ZUNvbmZsaWN0c0ZpbGUobWFpbkJhc2VQYXRoLCBjb25mbGljdHMsIHdvcmt0cmVlQmFzZVBhdGgpO1xuICAgIGNvbnN0IGNvbmZsaWN0U3VtbWFyeSA9IGNvbmZsaWN0cy5zbGljZSgwLCAzKS5tYXAoYyA9PiBgJHtjLmVudGl0eVR5cGV9OiR7Yy5lbnRpdHlJZH1gKS5qb2luKFwiLCBcIik7XG4gICAgY29uc3QgdHJ1bmNhdGVkID0gY29uZmxpY3RzLmxlbmd0aCA+IDMgPyBgLi4uIGFuZCAke2NvbmZsaWN0cy5sZW5ndGggLSAzfSBtb3JlYCA6IFwiXCI7XG4gICAgbG9nRXJyb3IoXCJyZWNvbmNpbGVcIiwgYCR7Y29uZmxpY3RzLmxlbmd0aH0gY29uZmxpY3QocykgZGV0ZWN0ZWQgb24gJHtjb25mbGljdFN1bW1hcnl9JHt0cnVuY2F0ZWR9LiBEZXRhaWxzOiAuZ3NkL0NPTkZMSUNUUy5tZGAsIHsgY291bnQ6IFN0cmluZyhjb25mbGljdHMubGVuZ3RoKSwgcGF0aDogam9pbihtYWluQmFzZVBhdGgsIFwiLmdzZFwiLCBcIkNPTkZMSUNUUy5tZFwiKSB9KTtcbiAgICByZXR1cm4geyBhdXRvTWVyZ2VkOiAwLCBjb25mbGljdHMgfTtcbiAgfVxuXG4gIC8vIFN0ZXAgNjogQ2xlYW4gbWVyZ2UgXHUyMDE0IHN0YWJsZSBzb3J0IGJ5IHRpbWVzdGFtcCAoaW5kZXgtYmFzZWQgdGllYnJlYWtlcilcbiAgY29uc3QgaW5kZXhlZCA9IFsuLi5tYWluRGl2ZXJnZWQsIC4uLnd0RGl2ZXJnZWRdLm1hcCgoZSwgaSkgPT4gKHsgZSwgaSB9KSk7XG4gIGluZGV4ZWQuc29ydCgoYSwgYikgPT4gYS5lLnRzLmxvY2FsZUNvbXBhcmUoYi5lLnRzKSB8fCBhLmkgLSBiLmkpO1xuICBjb25zdCBtZXJnZWQgPSBpbmRleGVkLm1hcCgoeyBlIH0pID0+IGUpO1xuXG4gIC8vIFN0ZXAgNzogV3JpdGUgbWVyZ2VkIGV2ZW50IGxvZyBGSVJTVCAoc28gY3Jhc2ggcmVjb3ZlcnkgY2FuIHJlLWRlcml2ZSBEQiBzdGF0ZSlcbiAgLy8gR3VhcmQ6IGRldGVjdCBjb25jdXJyZW50IGFwcGVuZEV2ZW50IGNhbGxzIGJldHdlZW4gb3VyIHJlYWQgKHN0ZXAgMSkgYW5kXG4gIC8vIHRoaXMgcmV3cml0ZS4gSWYgdGhlIGxvZyBncmV3LCByZS1yZWFkIGFuZCByZXRyeSB0byBhdm9pZCBkcm9wcGluZyBldmVudHMuXG4gIGNvbnN0IHByZVdyaXRlRXZlbnRzID0gcmVhZEV2ZW50cyhtYWluTG9nUGF0aCk7XG4gIGlmIChwcmVXcml0ZUV2ZW50cy5sZW5ndGggPiBtYWluRXZlbnRzLmxlbmd0aCkge1xuICAgIGxvZ1dhcm5pbmcoXCJyZWNvbmNpbGVcIiwgYEV2ZW50IGxvZyBncmV3IGR1cmluZyByZWNvbmNpbGUgKCR7bWFpbkV2ZW50cy5sZW5ndGh9IFx1MjE5MiAke3ByZVdyaXRlRXZlbnRzLmxlbmd0aH0pLCByZXRyeWluZyB3aXRoIGZyZXNoIHJlYWRgKTtcbiAgICByZXR1cm4gX3JlY29uY2lsZVdvcmt0cmVlTG9nc0lubmVyKG1haW5CYXNlUGF0aCwgd29ya3RyZWVCYXNlUGF0aCk7XG4gIH1cblxuICBjb25zdCBiYXNlRXZlbnRzID0gbWFpbkV2ZW50cy5zbGljZSgwLCBmb3JrUG9pbnQgKyAxKTtcbiAgY29uc3QgbWVyZ2VkTG9nID0gYmFzZUV2ZW50cy5jb25jYXQobWVyZ2VkKTtcbiAgY29uc3QgbG9nQ29udGVudCA9IG1lcmdlZExvZy5tYXAoKGUpID0+IEpTT04uc3RyaW5naWZ5KGUpKS5qb2luKFwiXFxuXCIpICsgKG1lcmdlZExvZy5sZW5ndGggPiAwID8gXCJcXG5cIiA6IFwiXCIpO1xuICBta2RpclN5bmMoam9pbihtYWluQmFzZVBhdGgsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGF0b21pY1dyaXRlU3luYyhqb2luKG1haW5CYXNlUGF0aCwgXCIuZ3NkXCIsIFwiZXZlbnQtbG9nLmpzb25sXCIpLCBsb2dDb250ZW50KTtcblxuICAvLyBTdGVwIDg6IFJlcGxheSBpbnRvIERCICh3cmFwcGVkIGluIGEgdHJhbnNhY3Rpb24gYnkgcmVwbGF5RXZlbnRzKVxuICBvcGVuRGF0YWJhc2UocmVzb2x2ZUdzZFBhdGhDb250cmFjdChtYWluQmFzZVBhdGgpLnByb2plY3REYik7XG4gIHJlcGxheUV2ZW50cyhtZXJnZWQpO1xuXG4gIC8vIFN0ZXAgOTogV3JpdGUgbWFuaWZlc3RcbiAgdHJ5IHtcbiAgICB3cml0ZU1hbmlmZXN0KG1haW5CYXNlUGF0aCk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGxvZ1dhcm5pbmcoXCJyZWNvbmNpbGVcIiwgXCJtYW5pZmVzdCB3cml0ZSBmYWlsZWQgKG5vbi1mYXRhbClcIiwgeyBlcnJvcjogKGVyciBhcyBFcnJvcikubWVzc2FnZSB9KTtcbiAgfVxuXG4gIC8vIFN0ZXAgMTA6IEludmFsaWRhdGUgY2FjaGVzIHNvIGRlcml2ZVN0YXRlKCkgc2VlcyBwb3N0LXJlY29uY2lsZSBEQiBzdGF0ZS5cbiAgLy8gVXNlIHRhcmdldGVkIGludmFsaWRhdGlvbiAobm90IGludmFsaWRhdGVBbGxDYWNoZXMpIHRvIGF2b2lkIHdpcGluZyBhcnRpZmFjdHMgdGFibGUuXG4gIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gIGNsZWFyUGF0aENhY2hlKCk7XG4gIGNsZWFyUGFyc2VDYWNoZSgpO1xuXG4gIHJldHVybiB7IGF1dG9NZXJnZWQ6IG1lcmdlZC5sZW5ndGgsIGNvbmZsaWN0czogW10gfTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIENvbmZsaWN0IFJlc29sdXRpb24gKEQtMDYpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFBhcnNlIENPTkZMSUNUUy5tZCBhbmQgcmV0dXJuIHN0cnVjdHVyZWQgQ29uZmxpY3RFbnRyeVtdLlxuICogUmV0dXJucyBlbXB0eSBhcnJheSB3aGVuIENPTkZMSUNUUy5tZCBkb2VzIG5vdCBleGlzdC5cbiAqXG4gKiBQYXJzZXMgdGhlIGZvcm1hdCB3cml0dGVuIGJ5IHdyaXRlQ29uZmxpY3RzRmlsZTpcbiAqICAgIyMgQ29uZmxpY3QgTjoge2VudGl0eVR5cGV9IHtlbnRpdHlJZH1cbiAqICAgKipNYWluIHNpZGUgZXZlbnRzOioqXG4gKiAgIC0ge2NtZH0gYXQge3RzfSAoaGFzaDoge2hhc2h9KVxuICogICAgIHBhcmFtczoge0pTT059XG4gKiAgICoqV29ya3RyZWUgc2lkZSBldmVudHM6KipcbiAqICAgLSB7Y21kfSBhdCB7dHN9IChoYXNoOiB7aGFzaH0pXG4gKiAgICAgcGFyYW1zOiB7SlNPTn1cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxpc3RDb25mbGljdHMoYmFzZVBhdGg6IHN0cmluZyk6IENvbmZsaWN0RW50cnlbXSB7XG4gIGNvbnN0IGNvbmZsaWN0c1BhdGggPSBqb2luKGJhc2VQYXRoLCBcIi5nc2RcIiwgXCJDT05GTElDVFMubWRcIik7XG4gIGlmICghZXhpc3RzU3luYyhjb25mbGljdHNQYXRoKSkgcmV0dXJuIFtdO1xuXG4gIGNvbnN0IGNvbnRlbnQgPSByZWFkRmlsZVN5bmMoY29uZmxpY3RzUGF0aCwgXCJ1dGYtOFwiKTtcbiAgY29uc3QgY29uZmxpY3RzOiBDb25mbGljdEVudHJ5W10gPSBbXTtcblxuICAvLyBTcGxpdCBpbnRvIHBlci1jb25mbGljdCBzZWN0aW9ucyBvbiBcIiMjIENvbmZsaWN0IE46XCIgaGVhZGluZ3NcbiAgY29uc3Qgc2VjdGlvbnMgPSBjb250ZW50LnNwbGl0KC9eIyMgQ29uZmxpY3QgXFxkKzovbSkuc2xpY2UoMSk7XG5cbiAgZm9yIChjb25zdCBzZWN0aW9uIG9mIHNlY3Rpb25zKSB7XG4gICAgLy8gRXh0cmFjdCBlbnRpdHkgdHlwZSBhbmQgaWQgZnJvbSBmaXJzdCBsaW5lOiBcIiB7ZW50aXR5VHlwZX0ge2VudGl0eUlkfVwiXG4gICAgY29uc3QgaGVhZGluZ01hdGNoID0gc2VjdGlvbi5tYXRjaCgvXlxccysoXFxTKylcXHMrKFxcUyspLyk7XG4gICAgaWYgKCFoZWFkaW5nTWF0Y2gpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGVudGl0eVR5cGUgPSBoZWFkaW5nTWF0Y2hbMV0hO1xuICAgIGNvbnN0IGVudGl0eUlkID0gaGVhZGluZ01hdGNoWzJdITtcblxuICAgIC8vIFNwbGl0IGludG8gbWFpbi93b3JrdHJlZSBibG9ja3NcbiAgICBjb25zdCBtYWluTWF0Y2ggPSBzZWN0aW9uLnNwbGl0KFwiKipNYWluIHNpZGUgZXZlbnRzOioqXCIpWzFdO1xuICAgIGNvbnN0IHd0TWF0Y2ggPSBtYWluTWF0Y2g/LnNwbGl0KFwiKipXb3JrdHJlZSBzaWRlIGV2ZW50czoqKlwiKTtcblxuICAgIGNvbnN0IG1haW5CbG9jayA9IHd0TWF0Y2g/LlswXSA/PyBcIlwiO1xuICAgIGNvbnN0IHd0QmxvY2sgPSB3dE1hdGNoPy5bMV0gPz8gXCJcIjtcblxuICAgIGNvbnN0IG1haW5TaWRlRXZlbnRzID0gcGFyc2VFdmVudEJsb2NrKG1haW5CbG9jayk7XG4gICAgY29uc3Qgd29ya3RyZWVTaWRlRXZlbnRzID0gcGFyc2VFdmVudEJsb2NrKHd0QmxvY2spO1xuXG4gICAgY29uZmxpY3RzLnB1c2goeyBlbnRpdHlUeXBlLCBlbnRpdHlJZCwgbWFpblNpZGVFdmVudHMsIHdvcmt0cmVlU2lkZUV2ZW50cyB9KTtcbiAgfVxuXG4gIHJldHVybiBjb25mbGljdHM7XG59XG5cbi8qKlxuICogUGFyc2UgYSBibG9jayBvZiBldmVudCBsaW5lcyBmcm9tIENPTkZMSUNUUy5tZCBpbnRvIFdvcmtmbG93RXZlbnRbXS5cbiAqIEVhY2ggZXZlbnQgc3BhbnMgdHdvIGxpbmVzOlxuICogICAtIHtjbWR9IGF0IHt0c30gKGhhc2g6IHtoYXNofSlcbiAqICAgICBwYXJhbXM6IHtKU09OfVxuICovXG5mdW5jdGlvbiBwYXJzZUV2ZW50QmxvY2soYmxvY2s6IHN0cmluZyk6IFdvcmtmbG93RXZlbnRbXSB7XG4gIGNvbnN0IGV2ZW50czogV29ya2Zsb3dFdmVudFtdID0gW107XG4gIC8vIEZpbmQgbGluZXMgc3RhcnRpbmcgd2l0aCBcIi0gXCIgKGV2ZW50IGxpbmVzKVxuICBjb25zdCBsaW5lcyA9IGJsb2NrLnNwbGl0KFwiXFxuXCIpO1xuICBsZXQgaSA9IDA7XG4gIHdoaWxlIChpIDwgbGluZXMubGVuZ3RoKSB7XG4gICAgY29uc3QgbGluZSA9IGxpbmVzW2ldIS50cmltKCk7XG4gICAgaWYgKGxpbmUuc3RhcnRzV2l0aChcIi0gXCIpKSB7XG4gICAgICAvLyBQYXJzZTogLSB7Y21kfSBhdCB7dHN9IChoYXNoOiB7aGFzaH0pXG4gICAgICBjb25zdCBldmVudE1hdGNoID0gbGluZS5tYXRjaCgvXi1cXHMrKFxcUyspXFxzK2F0XFxzKyhcXFMrKVxccytcXChoYXNoOlxccysoXFxTKylcXCkkLyk7XG4gICAgICBpZiAoZXZlbnRNYXRjaCkge1xuICAgICAgICBjb25zdCBjbWQgPSBldmVudE1hdGNoWzFdITtcbiAgICAgICAgY29uc3QgdHMgPSBldmVudE1hdGNoWzJdITtcbiAgICAgICAgY29uc3QgaGFzaCA9IGV2ZW50TWF0Y2hbM10hO1xuXG4gICAgICAgIC8vIE5leHQgbGluZTogXCIgIHBhcmFtczoge0pTT059XCJcbiAgICAgICAgbGV0IHBhcmFtczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgICAgICAgY29uc3QgbmV4dExpbmUgPSBsaW5lc1tpICsgMV07XG4gICAgICAgIGlmIChuZXh0TGluZSkge1xuICAgICAgICAgIGNvbnN0IHBhcmFtc01hdGNoID0gbmV4dExpbmUudHJpbSgpLm1hdGNoKC9ecGFyYW1zOlxccysoLispJC8pO1xuICAgICAgICAgIGlmIChwYXJhbXNNYXRjaCkge1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgcGFyYW1zID0gSlNPTi5wYXJzZShwYXJhbXNNYXRjaFsxXSEpIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICBsb2dXYXJuaW5nKFwicmVjb25jaWxlXCIsIGB0b29sIGNhbGwgcGFyYW1zIHBhcnNlIGZhaWxlZDogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGkrKzsgLy8gY29uc3VtZSBwYXJhbXMgbGluZVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGV2ZW50cy5wdXNoKHsgY21kLCBwYXJhbXMsIHRzLCBoYXNoLCBhY3RvcjogXCJhZ2VudFwiLCBzZXNzaW9uX2lkOiBnZXRTZXNzaW9uSWQoKSB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgaSsrO1xuICB9XG4gIHJldHVybiBldmVudHM7XG59XG5cbi8qKlxuICogUmVzb2x2ZSBhIHNpbmdsZSBjb25mbGljdCBieSBwaWNraW5nIG9uZSBzaWRlJ3MgZXZlbnRzLlxuICogUmVwbGF5cyB0aGUgcGlja2VkIGV2ZW50cyB0aHJvdWdoIHRoZSBEQiBoZWxwZXJzLCByZXdyaXRlcyB0aGUgY2hvc2VuIHNpZGUnc1xuICogZXZlbnQgbG9nIHNvIHRoZSBjb25mbGljdCBpcyBkdXJhYmxlLCBhbmQgdXBkYXRlcyBvciByZW1vdmVzIENPTkZMSUNUUy5tZC5cbiAqXG4gKiBXaGVuIHRoZSBsYXN0IGNvbmZsaWN0IGlzIHJlc29sdmVkLCBub24tY29uZmxpY3RpbmcgZXZlbnRzIGZyb20gYm90aCBzaWRlc1xuICogYXJlIGFsc28gcmVwbGF5ZWQgKHRoZXkgd2VyZSBibG9ja2VkIGJ5IHRoZSBhbGwtb3Itbm90aGluZyBELTA0IHJ1bGUpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZUNvbmZsaWN0KFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICB3b3JrdHJlZUJhc2VQYXRoOiBzdHJpbmcsXG4gIGVudGl0eUtleTogc3RyaW5nLCAgLy8gZS5nLiBcInRhc2s6VDAxXCJcbiAgcGljazogXCJtYWluXCIgfCBcIndvcmt0cmVlXCIsXG4pOiB2b2lkIHtcbiAgY29uc3QgY29uZmxpY3RzID0gbGlzdENvbmZsaWN0cyhiYXNlUGF0aCk7XG4gIGNvbnN0IGNvbG9uSWR4ID0gZW50aXR5S2V5LmluZGV4T2YoXCI6XCIpO1xuICBjb25zdCBlbnRpdHlUeXBlID0gZW50aXR5S2V5LnNsaWNlKDAsIGNvbG9uSWR4KTtcbiAgY29uc3QgZW50aXR5SWQgPSBlbnRpdHlLZXkuc2xpY2UoY29sb25JZHggKyAxKTtcblxuICBjb25zdCBpZHggPSBjb25mbGljdHMuZmluZEluZGV4KChjKSA9PiBjLmVudGl0eVR5cGUgPT09IGVudGl0eVR5cGUgJiYgYy5lbnRpdHlJZCA9PT0gZW50aXR5SWQpO1xuICBpZiAoaWR4ID09PSAtMSkgdGhyb3cgbmV3IEVycm9yKGBObyBjb25mbGljdCBmb3VuZCBmb3IgZW50aXR5ICR7ZW50aXR5S2V5fWApO1xuXG4gIGNvbnN0IGNvbmZsaWN0ID0gY29uZmxpY3RzW2lkeF0hO1xuICBjb25zdCBldmVudHNUb1JlcGxheSA9IHBpY2sgPT09IFwibWFpblwiID8gY29uZmxpY3QubWFpblNpZGVFdmVudHMgOiBjb25mbGljdC53b3JrdHJlZVNpZGVFdmVudHM7XG5cbiAgY29uc3QgbWFpbkxvZ1BhdGggPSBqb2luKGJhc2VQYXRoLCBcIi5nc2RcIiwgXCJldmVudC1sb2cuanNvbmxcIik7XG4gIGNvbnN0IHd0TG9nUGF0aCA9IGpvaW4od29ya3RyZWVCYXNlUGF0aCwgXCIuZ3NkXCIsIFwiZXZlbnQtbG9nLmpzb25sXCIpO1xuICBjb25zdCBtYWluRXZlbnRzID0gcmVhZEV2ZW50cyhtYWluTG9nUGF0aCk7XG4gIGNvbnN0IHd0RXZlbnRzID0gcmVhZEV2ZW50cyh3dExvZ1BhdGgpO1xuICBjb25zdCBmb3JrUG9pbnQgPSBmaW5kRm9ya1BvaW50KG1haW5FdmVudHMsIHd0RXZlbnRzKTtcbiAgY29uc3QgbWFpbkJhc2VFdmVudHMgPSBtYWluRXZlbnRzLnNsaWNlKDAsIGZvcmtQb2ludCArIDEpO1xuICBjb25zdCB3dEJhc2VFdmVudHMgPSB3dEV2ZW50cy5zbGljZSgwLCBmb3JrUG9pbnQgKyAxKTtcbiAgY29uc3QgbWFpbkRpdmVyZ2VkID0gbWFpbkV2ZW50cy5zbGljZShmb3JrUG9pbnQgKyAxKTtcbiAgY29uc3Qgd3REaXZlcmdlZCA9IHd0RXZlbnRzLnNsaWNlKGZvcmtQb2ludCArIDEpO1xuXG4gIGNvbnN0IHJld3JpdHRlblRhcmdldEV2ZW50cyA9IHBpY2sgPT09IFwibWFpblwiXG4gICAgPyByZXdyaXRlRGl2ZXJnZWRFdmVudHNGb3JFbnRpdHkod3REaXZlcmdlZCwgZW50aXR5VHlwZSwgZW50aXR5SWQsIGV2ZW50c1RvUmVwbGF5KVxuICAgIDogcmV3cml0ZURpdmVyZ2VkRXZlbnRzRm9yRW50aXR5KG1haW5EaXZlcmdlZCwgZW50aXR5VHlwZSwgZW50aXR5SWQsIGV2ZW50c1RvUmVwbGF5KTtcblxuICBjb25zdCB0YXJnZXRCYXNlUGF0aCA9IHBpY2sgPT09IFwibWFpblwiID8gd29ya3RyZWVCYXNlUGF0aCA6IGJhc2VQYXRoO1xuICBjb25zdCB0YXJnZXRCYXNlRXZlbnRzID0gcGljayA9PT0gXCJtYWluXCIgPyB3dEJhc2VFdmVudHMgOiBtYWluQmFzZUV2ZW50cztcbiAgd3JpdGVFdmVudExvZyh0YXJnZXRCYXNlUGF0aCwgdGFyZ2V0QmFzZUV2ZW50cy5jb25jYXQocmV3cml0dGVuVGFyZ2V0RXZlbnRzKSk7XG5cbiAgLy8gUmVwbGF5IHJlc29sdmVkIGV2ZW50cyB0aHJvdWdoIHRoZSBEQiAodXBkYXRlcyBEQiBzdGF0ZSlcbiAgb3BlbkRhdGFiYXNlKHJlc29sdmVHc2RQYXRoQ29udHJhY3QoYmFzZVBhdGgpLnByb2plY3REYik7XG4gIHJlcGxheUV2ZW50cyhldmVudHNUb1JlcGxheSk7XG4gIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gIGNsZWFyUGF0aENhY2hlKCk7XG4gIGNsZWFyUGFyc2VDYWNoZSgpO1xuXG4gIC8vIFJlbW92ZSByZXNvbHZlZCBjb25mbGljdCBmcm9tIGxpc3RcbiAgY29uZmxpY3RzLnNwbGljZShpZHgsIDEpO1xuXG4gIGlmIChjb25mbGljdHMubGVuZ3RoID09PSAwKSB7XG4gICAgLy8gQWxsIGNvbmZsaWN0cyByZXNvbHZlZCBcdTIwMTQgcmVtb3ZlIENPTkZMSUNUUy5tZCBhbmQgcmUtcnVuIHJlY29uY2lsaWF0aW9uXG4gICAgLy8gdG8gcGljayB1cCBub24tY29uZmxpY3RpbmcgZXZlbnRzIHRoYXQgd2VyZSBibG9ja2VkIGJ5IEQtMDQgYWxsLW9yLW5vdGhpbmcuXG4gICAgcmVtb3ZlQ29uZmxpY3RzRmlsZShiYXNlUGF0aCk7XG4gICAgaWYgKHdvcmt0cmVlQmFzZVBhdGgpIHtcbiAgICAgIHJlY29uY2lsZVdvcmt0cmVlTG9ncyhiYXNlUGF0aCwgd29ya3RyZWVCYXNlUGF0aCk7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIC8vIFJlLXdyaXRlIENPTkZMSUNUUy5tZCB3aXRoIHJlbWFpbmluZyBjb25mbGljdHNcbiAgICB3cml0ZUNvbmZsaWN0c0ZpbGUoYmFzZVBhdGgsIGNvbmZsaWN0cywgd29ya3RyZWVCYXNlUGF0aCk7XG4gIH1cbn1cblxuLyoqXG4gKiBSZW1vdmUgQ09ORkxJQ1RTLm1kIFx1MjAxNCBjYWxsZWQgd2hlbiBhbGwgY29uZmxpY3RzIGFyZSByZXNvbHZlZC5cbiAqIE5vLW9wIGlmIENPTkZMSUNUUy5tZCBkb2VzIG5vdCBleGlzdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlbW92ZUNvbmZsaWN0c0ZpbGUoYmFzZVBhdGg6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBjb25mbGljdHNQYXRoID0gam9pbihiYXNlUGF0aCwgXCIuZ3NkXCIsIFwiQ09ORkxJQ1RTLm1kXCIpO1xuICBpZiAoZXhpc3RzU3luYyhjb25mbGljdHNQYXRoKSkge1xuICAgIHVubGlua1N5bmMoY29uZmxpY3RzUGF0aCk7XG4gIH1cbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsWUFBWTtBQUNyQixTQUFTLFdBQVcsWUFBWSxjQUFjLGtCQUFrQjtBQUNoRSxTQUFTLFlBQVksZ0JBQWdCO0FBQ3JDLFNBQVMsWUFBWSxlQUFlLG9CQUFvQjtBQUV4RDtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtB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
