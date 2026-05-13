import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { isDbAvailable, _getAdapter } from "./gsd-db.js";
import { resolveGsdPathContract, resolveMilestoneFile } from "./paths.js";
import { deriveState } from "./state.js";
import { readEvents } from "./workflow-events.js";
import { renderAllProjections } from "./workflow-projections.js";
async function checkEngineHealth(basePath, issues, fixesApplied) {
  const dbPath = resolveGsdPathContract(basePath).projectDb;
  if (!isDbAvailable() && existsSync(dbPath)) {
    issues.push({
      severity: "warning",
      code: "db_unavailable",
      scope: "project",
      unitId: "project",
      message: "Database unavailable \u2014 using filesystem state derivation (degraded mode). State queries may be slower and less reliable.",
      file: ".gsd/gsd.db",
      fixable: false
    });
  }
  try {
    if (isDbAvailable()) {
      const adapter = _getAdapter();
      try {
        const orphanedTasks = adapter.prepare(
          `SELECT t.id, t.slice_id, t.milestone_id
             FROM tasks t
             LEFT JOIN slices s ON t.milestone_id = s.milestone_id AND t.slice_id = s.id
             WHERE s.id IS NULL`
        ).all();
        for (const row of orphanedTasks) {
          issues.push({
            severity: "error",
            code: "db_orphaned_task",
            scope: "task",
            unitId: `${row.milestone_id}/${row.slice_id}/${row.id}`,
            message: `Task ${row.id} references slice ${row.slice_id} in milestone ${row.milestone_id} but no such slice exists in the database`,
            fixable: false
          });
        }
      } catch {
      }
      try {
        const orphanedSlices = adapter.prepare(
          `SELECT s.id, s.milestone_id
             FROM slices s
             LEFT JOIN milestones m ON s.milestone_id = m.id
             WHERE m.id IS NULL`
        ).all();
        for (const row of orphanedSlices) {
          issues.push({
            severity: "error",
            code: "db_orphaned_slice",
            scope: "slice",
            unitId: `${row.milestone_id}/${row.id}`,
            message: `Slice ${row.id} references milestone ${row.milestone_id} but no such milestone exists in the database`,
            fixable: false
          });
        }
      } catch {
      }
      try {
        const doneTasks = adapter.prepare(
          `SELECT id, slice_id, milestone_id FROM tasks
             WHERE status = 'done' AND (summary IS NULL OR summary = '')`
        ).all();
        for (const row of doneTasks) {
          issues.push({
            severity: "warning",
            code: "db_done_task_no_summary",
            scope: "task",
            unitId: `${row.milestone_id}/${row.slice_id}/${row.id}`,
            message: `Task ${row.id} is marked done but has no summary in the database`,
            fixable: false
          });
        }
      } catch {
      }
      try {
        const dupMilestones = adapter.prepare("SELECT id, COUNT(*) as cnt FROM milestones GROUP BY id HAVING cnt > 1").all();
        for (const row of dupMilestones) {
          issues.push({
            severity: "error",
            code: "db_duplicate_id",
            scope: "milestone",
            unitId: row.id,
            message: `Duplicate milestone ID "${row.id}" appears ${row.cnt} times in the database`,
            fixable: false
          });
        }
        const dupSlices = adapter.prepare("SELECT id, milestone_id, COUNT(*) as cnt FROM slices GROUP BY id, milestone_id HAVING cnt > 1").all();
        for (const row of dupSlices) {
          issues.push({
            severity: "error",
            code: "db_duplicate_id",
            scope: "slice",
            unitId: `${row.milestone_id}/${row.id}`,
            message: `Duplicate slice ID "${row.id}" in milestone ${row.milestone_id} appears ${row.cnt} times`,
            fixable: false
          });
        }
        const dupTasks = adapter.prepare("SELECT id, slice_id, milestone_id, COUNT(*) as cnt FROM tasks GROUP BY id, slice_id, milestone_id HAVING cnt > 1").all();
        for (const row of dupTasks) {
          issues.push({
            severity: "error",
            code: "db_duplicate_id",
            scope: "task",
            unitId: `${row.milestone_id}/${row.slice_id}/${row.id}`,
            message: `Duplicate task ID "${row.id}" in slice ${row.slice_id} appears ${row.cnt} times`,
            fixable: false
          });
        }
      } catch {
      }
    }
  } catch {
  }
  try {
    if (isDbAvailable()) {
      const eventLogPath = join(basePath, ".gsd", "event-log.jsonl");
      const events = readEvents(eventLogPath);
      if (events.length > 0) {
        const lastEventTs = new Date(events[events.length - 1].ts).getTime();
        const state = await deriveState(basePath);
        for (const milestone of state.registry) {
          if (milestone.status === "complete") continue;
          const roadmapPath = resolveMilestoneFile(basePath, milestone.id, "ROADMAP");
          if (!roadmapPath || !existsSync(roadmapPath)) {
            try {
              await renderAllProjections(basePath, milestone.id);
              fixesApplied.push(`re-rendered missing projections for ${milestone.id}`);
            } catch {
            }
            continue;
          }
          const projectionMtime = statSync(roadmapPath).mtimeMs;
          if (lastEventTs > projectionMtime) {
            try {
              await renderAllProjections(basePath, milestone.id);
              fixesApplied.push(`re-rendered stale projections for ${milestone.id}`);
            } catch {
            }
          }
        }
      }
    }
  } catch {
  }
}
export {
  checkEngineHealth
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9kb2N0b3ItZW5naW5lLWNoZWNrcy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgZXhpc3RzU3luYywgc3RhdFN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcblxuaW1wb3J0IHR5cGUgeyBEb2N0b3JJc3N1ZSB9IGZyb20gXCIuL2RvY3Rvci10eXBlcy5qc1wiO1xuaW1wb3J0IHsgaXNEYkF2YWlsYWJsZSwgX2dldEFkYXB0ZXIgfSBmcm9tIFwiLi9nc2QtZGIuanNcIjtcbmltcG9ydCB7IHJlc29sdmVHc2RQYXRoQ29udHJhY3QsIHJlc29sdmVNaWxlc3RvbmVGaWxlIH0gZnJvbSBcIi4vcGF0aHMuanNcIjtcbmltcG9ydCB7IGRlcml2ZVN0YXRlIH0gZnJvbSBcIi4vc3RhdGUuanNcIjtcbmltcG9ydCB7IHJlYWRFdmVudHMgfSBmcm9tIFwiLi93b3JrZmxvdy1ldmVudHMuanNcIjtcbmltcG9ydCB7IHJlbmRlckFsbFByb2plY3Rpb25zIH0gZnJvbSBcIi4vd29ya2Zsb3ctcHJvamVjdGlvbnMuanNcIjtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNoZWNrRW5naW5lSGVhbHRoKFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICBpc3N1ZXM6IERvY3Rvcklzc3VlW10sXG4gIGZpeGVzQXBwbGllZDogc3RyaW5nW10sXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgZGJQYXRoID0gcmVzb2x2ZUdzZFBhdGhDb250cmFjdChiYXNlUGF0aCkucHJvamVjdERiO1xuXG4gIGlmICghaXNEYkF2YWlsYWJsZSgpICYmIGV4aXN0c1N5bmMoZGJQYXRoKSkge1xuICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgIHNldmVyaXR5OiBcIndhcm5pbmdcIixcbiAgICAgIGNvZGU6IFwiZGJfdW5hdmFpbGFibGVcIixcbiAgICAgIHNjb3BlOiBcInByb2plY3RcIixcbiAgICAgIHVuaXRJZDogXCJwcm9qZWN0XCIsXG4gICAgICBtZXNzYWdlOiBcIkRhdGFiYXNlIHVuYXZhaWxhYmxlIFx1MjAxNCB1c2luZyBmaWxlc3lzdGVtIHN0YXRlIGRlcml2YXRpb24gKGRlZ3JhZGVkIG1vZGUpLiBTdGF0ZSBxdWVyaWVzIG1heSBiZSBzbG93ZXIgYW5kIGxlc3MgcmVsaWFibGUuXCIsXG4gICAgICBmaWxlOiBcIi5nc2QvZ3NkLmRiXCIsXG4gICAgICBmaXhhYmxlOiBmYWxzZSxcbiAgICB9KTtcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBEQiBjb25zdHJhaW50IHZpb2xhdGlvbiBkZXRlY3Rpb24gKGZ1bGwgZG9jdG9yIG9ubHksIG5vdCBwcmUtZGlzcGF0Y2ggcGVyIEQtMTApIFx1MjUwMFx1MjUwMFxuICB0cnkge1xuICAgIGlmIChpc0RiQXZhaWxhYmxlKCkpIHtcbiAgICAgIGNvbnN0IGFkYXB0ZXIgPSBfZ2V0QWRhcHRlcigpITtcblxuICAgICAgLy8gYS4gT3JwaGFuZWQgdGFza3MgKHRhc2suc2xpY2VfaWQgcG9pbnRzIHRvIG5vbi1leGlzdGVudCBzbGljZSlcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IG9ycGhhbmVkVGFza3MgPSBhZGFwdGVyXG4gICAgICAgICAgLnByZXBhcmUoXG4gICAgICAgICAgICBgU0VMRUNUIHQuaWQsIHQuc2xpY2VfaWQsIHQubWlsZXN0b25lX2lkXG4gICAgICAgICAgICAgRlJPTSB0YXNrcyB0XG4gICAgICAgICAgICAgTEVGVCBKT0lOIHNsaWNlcyBzIE9OIHQubWlsZXN0b25lX2lkID0gcy5taWxlc3RvbmVfaWQgQU5EIHQuc2xpY2VfaWQgPSBzLmlkXG4gICAgICAgICAgICAgV0hFUkUgcy5pZCBJUyBOVUxMYCxcbiAgICAgICAgICApXG4gICAgICAgICAgLmFsbCgpIGFzIEFycmF5PHsgaWQ6IHN0cmluZzsgc2xpY2VfaWQ6IHN0cmluZzsgbWlsZXN0b25lX2lkOiBzdHJpbmcgfT47XG5cbiAgICAgICAgZm9yIChjb25zdCByb3cgb2Ygb3JwaGFuZWRUYXNrcykge1xuICAgICAgICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgICAgICAgIHNldmVyaXR5OiBcImVycm9yXCIsXG4gICAgICAgICAgICBjb2RlOiBcImRiX29ycGhhbmVkX3Rhc2tcIixcbiAgICAgICAgICAgIHNjb3BlOiBcInRhc2tcIixcbiAgICAgICAgICAgIHVuaXRJZDogYCR7cm93Lm1pbGVzdG9uZV9pZH0vJHtyb3cuc2xpY2VfaWR9LyR7cm93LmlkfWAsXG4gICAgICAgICAgICBtZXNzYWdlOiBgVGFzayAke3Jvdy5pZH0gcmVmZXJlbmNlcyBzbGljZSAke3Jvdy5zbGljZV9pZH0gaW4gbWlsZXN0b25lICR7cm93Lm1pbGVzdG9uZV9pZH0gYnV0IG5vIHN1Y2ggc2xpY2UgZXhpc3RzIGluIHRoZSBkYXRhYmFzZWAsXG4gICAgICAgICAgICBmaXhhYmxlOiBmYWxzZSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIE5vbi1mYXRhbCBcdTIwMTQgb3JwaGFuZWQgdGFzayBjaGVjayBmYWlsZWRcbiAgICAgIH1cblxuICAgICAgLy8gYi4gT3JwaGFuZWQgc2xpY2VzIChzbGljZS5taWxlc3RvbmVfaWQgcG9pbnRzIHRvIG5vbi1leGlzdGVudCBtaWxlc3RvbmUpXG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBvcnBoYW5lZFNsaWNlcyA9IGFkYXB0ZXJcbiAgICAgICAgICAucHJlcGFyZShcbiAgICAgICAgICAgIGBTRUxFQ1Qgcy5pZCwgcy5taWxlc3RvbmVfaWRcbiAgICAgICAgICAgICBGUk9NIHNsaWNlcyBzXG4gICAgICAgICAgICAgTEVGVCBKT0lOIG1pbGVzdG9uZXMgbSBPTiBzLm1pbGVzdG9uZV9pZCA9IG0uaWRcbiAgICAgICAgICAgICBXSEVSRSBtLmlkIElTIE5VTExgLFxuICAgICAgICAgIClcbiAgICAgICAgICAuYWxsKCkgYXMgQXJyYXk8eyBpZDogc3RyaW5nOyBtaWxlc3RvbmVfaWQ6IHN0cmluZyB9PjtcblxuICAgICAgICBmb3IgKGNvbnN0IHJvdyBvZiBvcnBoYW5lZFNsaWNlcykge1xuICAgICAgICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgICAgICAgIHNldmVyaXR5OiBcImVycm9yXCIsXG4gICAgICAgICAgICBjb2RlOiBcImRiX29ycGhhbmVkX3NsaWNlXCIsXG4gICAgICAgICAgICBzY29wZTogXCJzbGljZVwiLFxuICAgICAgICAgICAgdW5pdElkOiBgJHtyb3cubWlsZXN0b25lX2lkfS8ke3Jvdy5pZH1gLFxuICAgICAgICAgICAgbWVzc2FnZTogYFNsaWNlICR7cm93LmlkfSByZWZlcmVuY2VzIG1pbGVzdG9uZSAke3Jvdy5taWxlc3RvbmVfaWR9IGJ1dCBubyBzdWNoIG1pbGVzdG9uZSBleGlzdHMgaW4gdGhlIGRhdGFiYXNlYCxcbiAgICAgICAgICAgIGZpeGFibGU6IGZhbHNlLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gTm9uLWZhdGFsIFx1MjAxNCBvcnBoYW5lZCBzbGljZSBjaGVjayBmYWlsZWRcbiAgICAgIH1cblxuICAgICAgLy8gYy4gVGFza3MgbWFya2VkIGNvbXBsZXRlIHdpdGhvdXQgc3VtbWFyaWVzXG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBkb25lVGFza3MgPSBhZGFwdGVyXG4gICAgICAgICAgLnByZXBhcmUoXG4gICAgICAgICAgICBgU0VMRUNUIGlkLCBzbGljZV9pZCwgbWlsZXN0b25lX2lkIEZST00gdGFza3NcbiAgICAgICAgICAgICBXSEVSRSBzdGF0dXMgPSAnZG9uZScgQU5EIChzdW1tYXJ5IElTIE5VTEwgT1Igc3VtbWFyeSA9ICcnKWAsXG4gICAgICAgICAgKVxuICAgICAgICAgIC5hbGwoKSBhcyBBcnJheTx7IGlkOiBzdHJpbmc7IHNsaWNlX2lkOiBzdHJpbmc7IG1pbGVzdG9uZV9pZDogc3RyaW5nIH0+O1xuXG4gICAgICAgIGZvciAoY29uc3Qgcm93IG9mIGRvbmVUYXNrcykge1xuICAgICAgICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgICAgICAgIHNldmVyaXR5OiBcIndhcm5pbmdcIixcbiAgICAgICAgICAgIGNvZGU6IFwiZGJfZG9uZV90YXNrX25vX3N1bW1hcnlcIixcbiAgICAgICAgICAgIHNjb3BlOiBcInRhc2tcIixcbiAgICAgICAgICAgIHVuaXRJZDogYCR7cm93Lm1pbGVzdG9uZV9pZH0vJHtyb3cuc2xpY2VfaWR9LyR7cm93LmlkfWAsXG4gICAgICAgICAgICBtZXNzYWdlOiBgVGFzayAke3Jvdy5pZH0gaXMgbWFya2VkIGRvbmUgYnV0IGhhcyBubyBzdW1tYXJ5IGluIHRoZSBkYXRhYmFzZWAsXG4gICAgICAgICAgICBmaXhhYmxlOiBmYWxzZSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIE5vbi1mYXRhbCBcdTIwMTQgZG9uZS10YXNrLW5vLXN1bW1hcnkgY2hlY2sgZmFpbGVkXG4gICAgICB9XG5cbiAgICAgIC8vIGQuIER1cGxpY2F0ZSBlbnRpdHkgSURzIChzYWZldHkgY2hlY2spXG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBkdXBNaWxlc3RvbmVzID0gYWRhcHRlclxuICAgICAgICAgIC5wcmVwYXJlKFwiU0VMRUNUIGlkLCBDT1VOVCgqKSBhcyBjbnQgRlJPTSBtaWxlc3RvbmVzIEdST1VQIEJZIGlkIEhBVklORyBjbnQgPiAxXCIpXG4gICAgICAgICAgLmFsbCgpIGFzIEFycmF5PHsgaWQ6IHN0cmluZzsgY250OiBudW1iZXIgfT47XG4gICAgICAgIGZvciAoY29uc3Qgcm93IG9mIGR1cE1pbGVzdG9uZXMpIHtcbiAgICAgICAgICBpc3N1ZXMucHVzaCh7XG4gICAgICAgICAgICBzZXZlcml0eTogXCJlcnJvclwiLFxuICAgICAgICAgICAgY29kZTogXCJkYl9kdXBsaWNhdGVfaWRcIixcbiAgICAgICAgICAgIHNjb3BlOiBcIm1pbGVzdG9uZVwiLFxuICAgICAgICAgICAgdW5pdElkOiByb3cuaWQsXG4gICAgICAgICAgICBtZXNzYWdlOiBgRHVwbGljYXRlIG1pbGVzdG9uZSBJRCBcIiR7cm93LmlkfVwiIGFwcGVhcnMgJHtyb3cuY250fSB0aW1lcyBpbiB0aGUgZGF0YWJhc2VgLFxuICAgICAgICAgICAgZml4YWJsZTogZmFsc2UsXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBkdXBTbGljZXMgPSBhZGFwdGVyXG4gICAgICAgICAgLnByZXBhcmUoXCJTRUxFQ1QgaWQsIG1pbGVzdG9uZV9pZCwgQ09VTlQoKikgYXMgY250IEZST00gc2xpY2VzIEdST1VQIEJZIGlkLCBtaWxlc3RvbmVfaWQgSEFWSU5HIGNudCA+IDFcIilcbiAgICAgICAgICAuYWxsKCkgYXMgQXJyYXk8eyBpZDogc3RyaW5nOyBtaWxlc3RvbmVfaWQ6IHN0cmluZzsgY250OiBudW1iZXIgfT47XG4gICAgICAgIGZvciAoY29uc3Qgcm93IG9mIGR1cFNsaWNlcykge1xuICAgICAgICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgICAgICAgIHNldmVyaXR5OiBcImVycm9yXCIsXG4gICAgICAgICAgICBjb2RlOiBcImRiX2R1cGxpY2F0ZV9pZFwiLFxuICAgICAgICAgICAgc2NvcGU6IFwic2xpY2VcIixcbiAgICAgICAgICAgIHVuaXRJZDogYCR7cm93Lm1pbGVzdG9uZV9pZH0vJHtyb3cuaWR9YCxcbiAgICAgICAgICAgIG1lc3NhZ2U6IGBEdXBsaWNhdGUgc2xpY2UgSUQgXCIke3Jvdy5pZH1cIiBpbiBtaWxlc3RvbmUgJHtyb3cubWlsZXN0b25lX2lkfSBhcHBlYXJzICR7cm93LmNudH0gdGltZXNgLFxuICAgICAgICAgICAgZml4YWJsZTogZmFsc2UsXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBkdXBUYXNrcyA9IGFkYXB0ZXJcbiAgICAgICAgICAucHJlcGFyZShcIlNFTEVDVCBpZCwgc2xpY2VfaWQsIG1pbGVzdG9uZV9pZCwgQ09VTlQoKikgYXMgY250IEZST00gdGFza3MgR1JPVVAgQlkgaWQsIHNsaWNlX2lkLCBtaWxlc3RvbmVfaWQgSEFWSU5HIGNudCA+IDFcIilcbiAgICAgICAgICAuYWxsKCkgYXMgQXJyYXk8eyBpZDogc3RyaW5nOyBzbGljZV9pZDogc3RyaW5nOyBtaWxlc3RvbmVfaWQ6IHN0cmluZzsgY250OiBudW1iZXIgfT47XG4gICAgICAgIGZvciAoY29uc3Qgcm93IG9mIGR1cFRhc2tzKSB7XG4gICAgICAgICAgaXNzdWVzLnB1c2goe1xuICAgICAgICAgICAgc2V2ZXJpdHk6IFwiZXJyb3JcIixcbiAgICAgICAgICAgIGNvZGU6IFwiZGJfZHVwbGljYXRlX2lkXCIsXG4gICAgICAgICAgICBzY29wZTogXCJ0YXNrXCIsXG4gICAgICAgICAgICB1bml0SWQ6IGAke3Jvdy5taWxlc3RvbmVfaWR9LyR7cm93LnNsaWNlX2lkfS8ke3Jvdy5pZH1gLFxuICAgICAgICAgICAgbWVzc2FnZTogYER1cGxpY2F0ZSB0YXNrIElEIFwiJHtyb3cuaWR9XCIgaW4gc2xpY2UgJHtyb3cuc2xpY2VfaWR9IGFwcGVhcnMgJHtyb3cuY250fSB0aW1lc2AsXG4gICAgICAgICAgICBmaXhhYmxlOiBmYWxzZSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIE5vbi1mYXRhbCBcdTIwMTQgZHVwbGljYXRlIElEIGNoZWNrIGZhaWxlZFxuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gTm9uLWZhdGFsIFx1MjAxNCBEQiBjb25zdHJhaW50IGNoZWNrcyBmYWlsZWQgZW50aXJlbHlcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBQcm9qZWN0aW9uIGRyaWZ0IGRldGVjdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgLy8gSWYgdGhlIERCIGlzIGF2YWlsYWJsZSwgY2hlY2sgd2hldGhlciBtYXJrZG93biBwcm9qZWN0aW9ucyBhcmUgc3RhbGVcbiAgLy8gcmVsYXRpdmUgdG8gdGhlIGV2ZW50IGxvZyBhbmQgcmUtcmVuZGVyIHRoZW0uXG4gIHRyeSB7XG4gICAgaWYgKGlzRGJBdmFpbGFibGUoKSkge1xuICAgICAgY29uc3QgZXZlbnRMb2dQYXRoID0gam9pbihiYXNlUGF0aCwgXCIuZ3NkXCIsIFwiZXZlbnQtbG9nLmpzb25sXCIpO1xuICAgICAgY29uc3QgZXZlbnRzID0gcmVhZEV2ZW50cyhldmVudExvZ1BhdGgpO1xuICAgICAgaWYgKGV2ZW50cy5sZW5ndGggPiAwKSB7XG4gICAgICAgIGNvbnN0IGxhc3RFdmVudFRzID0gbmV3IERhdGUoZXZlbnRzW2V2ZW50cy5sZW5ndGggLSAxXSEudHMpLmdldFRpbWUoKTtcbiAgICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlUGF0aCk7XG4gICAgICAgIGZvciAoY29uc3QgbWlsZXN0b25lIG9mIHN0YXRlLnJlZ2lzdHJ5KSB7XG4gICAgICAgICAgaWYgKG1pbGVzdG9uZS5zdGF0dXMgPT09IFwiY29tcGxldGVcIikgY29udGludWU7XG4gICAgICAgICAgY29uc3Qgcm9hZG1hcFBhdGggPSByZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlUGF0aCwgbWlsZXN0b25lLmlkLCBcIlJPQURNQVBcIik7XG4gICAgICAgICAgaWYgKCFyb2FkbWFwUGF0aCB8fCAhZXhpc3RzU3luYyhyb2FkbWFwUGF0aCkpIHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIGF3YWl0IHJlbmRlckFsbFByb2plY3Rpb25zKGJhc2VQYXRoLCBtaWxlc3RvbmUuaWQpO1xuICAgICAgICAgICAgICBmaXhlc0FwcGxpZWQucHVzaChgcmUtcmVuZGVyZWQgbWlzc2luZyBwcm9qZWN0aW9ucyBmb3IgJHttaWxlc3RvbmUuaWR9YCk7XG4gICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgLy8gTm9uLWZhdGFsIFx1MjAxNCBwcm9qZWN0aW9uIHJlLXJlbmRlciBmYWlsZWRcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgIH1cbiAgICAgICAgICBjb25zdCBwcm9qZWN0aW9uTXRpbWUgPSBzdGF0U3luYyhyb2FkbWFwUGF0aCkubXRpbWVNcztcbiAgICAgICAgICBpZiAobGFzdEV2ZW50VHMgPiBwcm9qZWN0aW9uTXRpbWUpIHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIGF3YWl0IHJlbmRlckFsbFByb2plY3Rpb25zKGJhc2VQYXRoLCBtaWxlc3RvbmUuaWQpO1xuICAgICAgICAgICAgICBmaXhlc0FwcGxpZWQucHVzaChgcmUtcmVuZGVyZWQgc3RhbGUgcHJvamVjdGlvbnMgZm9yICR7bWlsZXN0b25lLmlkfWApO1xuICAgICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAgIC8vIE5vbi1mYXRhbCBcdTIwMTQgcHJvamVjdGlvbiByZS1yZW5kZXIgZmFpbGVkXG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICAvLyBOb24tZmF0YWwgXHUyMDE0IHByb2plY3Rpb24gZHJpZnQgY2hlY2sgbXVzdCBuZXZlciBibG9jayBkb2N0b3JcbiAgfVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxZQUFZLGdCQUFnQjtBQUNyQyxTQUFTLFlBQVk7QUFHckIsU0FBUyxl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
