import { Type } from "@sinclair/typebox";
import { ensureDbOpen, resolveCtxCwd } from "./dynamic-tools.js";
function registerQueryTools(pi) {
  pi.registerTool({
    name: "gsd_milestone_status",
    label: "Milestone Status",
    description: "Read the current status of a milestone and all its slices from the GSD database. Returns milestone metadata, per-slice status, and task counts per slice. Use this instead of querying .gsd/gsd.db directly via sqlite3 or better-sqlite3.",
    promptSnippet: "Get milestone status, slice statuses, and task counts for a given milestoneId",
    promptGuidelines: [
      "Use this tool \u2014 not sqlite3 or better-sqlite3 \u2014 to inspect milestone or slice state from the DB."
    ],
    parameters: Type.Object({
      milestoneId: Type.String({ description: "Milestone ID to query (e.g. M001)" })
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const dbAvailable = await ensureDbOpen(resolveCtxCwd(_ctx));
      if (!dbAvailable) {
        return {
          content: [{ type: "text", text: "Error: GSD database is not available. Cannot read milestone status." }],
          details: { operation: "milestone_status", error: "db_unavailable" }
        };
      }
      const { executeMilestoneStatus } = await import("../tools/workflow-tool-executors.js");
      return executeMilestoneStatus(params);
    }
  });
  pi.registerTool({
    name: "gsd_checkpoint_db",
    label: "Checkpoint GSD Database",
    description: "Flush the SQLite WAL (Write-Ahead Log) into the base gsd.db file. Call this before `git add .gsd/gsd.db` to ensure the committed database contains current milestone/slice/task state rather than stale pre-session content. Safe to call at any time while GSD is running.",
    promptSnippet: "Flush WAL into gsd.db so git add stages current state",
    promptGuidelines: [
      "Call gsd_checkpoint_db immediately before staging .gsd/gsd.db with git add.",
      "Do not use sqlite3 or shell commands to checkpoint \u2014 they are blocked. Use this tool instead."
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const dbAvailable = await ensureDbOpen(resolveCtxCwd(_ctx));
      if (!dbAvailable) {
        return {
          content: [{ type: "text", text: "Error: GSD database is not available. Cannot checkpoint." }],
          details: { operation: "checkpoint_db", error: "db_unavailable" }
        };
      }
      const { checkpointDatabase } = await import("../gsd-db.js");
      checkpointDatabase();
      return {
        content: [{ type: "text", text: "WAL checkpoint complete. gsd.db is now up to date and safe to stage with git add." }],
        details: { operation: "checkpoint_db", status: "ok" }
      };
    }
  });
}
export {
  registerQueryTools
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9ib290c3RyYXAvcXVlcnktdG9vbHMudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFByb2plY3QvQXBwOiBHU0QtMlxuLy8gRmlsZSBQdXJwb3NlOiBSZWdpc3RlcnMgcmVhZC1vbmx5IERCIHF1ZXJ5IHRvb2xzLlxuLy8gR1NEMiBcdTIwMTQgUmVhZC1vbmx5IHF1ZXJ5IHRvb2xzIGV4cG9zaW5nIERCIHN0YXRlIHRvIHRoZSBMTE0gdmlhIHRoZSBXQUwgY29ubmVjdGlvblxuXG5pbXBvcnQgeyBUeXBlIH0gZnJvbSBcIkBzaW5jbGFpci90eXBlYm94XCI7XG5pbXBvcnQgdHlwZSB7IEV4dGVuc2lvbkFQSSB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuaW1wb3J0IHsgZW5zdXJlRGJPcGVuLCByZXNvbHZlQ3R4Q3dkIH0gZnJvbSBcIi4vZHluYW1pYy10b29scy5qc1wiO1xuXG5cbmV4cG9ydCBmdW5jdGlvbiByZWdpc3RlclF1ZXJ5VG9vbHMocGk6IEV4dGVuc2lvbkFQSSk6IHZvaWQge1xuICBwaS5yZWdpc3RlclRvb2woe1xuICAgIG5hbWU6IFwiZ3NkX21pbGVzdG9uZV9zdGF0dXNcIixcbiAgICBsYWJlbDogXCJNaWxlc3RvbmUgU3RhdHVzXCIsXG4gICAgZGVzY3JpcHRpb246XG4gICAgICBcIlJlYWQgdGhlIGN1cnJlbnQgc3RhdHVzIG9mIGEgbWlsZXN0b25lIGFuZCBhbGwgaXRzIHNsaWNlcyBmcm9tIHRoZSBHU0QgZGF0YWJhc2UuIFwiICtcbiAgICAgIFwiUmV0dXJucyBtaWxlc3RvbmUgbWV0YWRhdGEsIHBlci1zbGljZSBzdGF0dXMsIGFuZCB0YXNrIGNvdW50cyBwZXIgc2xpY2UuIFwiICtcbiAgICAgIFwiVXNlIHRoaXMgaW5zdGVhZCBvZiBxdWVyeWluZyAuZ3NkL2dzZC5kYiBkaXJlY3RseSB2aWEgc3FsaXRlMyBvciBiZXR0ZXItc3FsaXRlMy5cIixcbiAgICBwcm9tcHRTbmlwcGV0OiBcIkdldCBtaWxlc3RvbmUgc3RhdHVzLCBzbGljZSBzdGF0dXNlcywgYW5kIHRhc2sgY291bnRzIGZvciBhIGdpdmVuIG1pbGVzdG9uZUlkXCIsXG4gICAgcHJvbXB0R3VpZGVsaW5lczogW1xuICAgICAgXCJVc2UgdGhpcyB0b29sIFx1MjAxNCBub3Qgc3FsaXRlMyBvciBiZXR0ZXItc3FsaXRlMyBcdTIwMTQgdG8gaW5zcGVjdCBtaWxlc3RvbmUgb3Igc2xpY2Ugc3RhdGUgZnJvbSB0aGUgREIuXCIsXG4gICAgXSxcbiAgICBwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG4gICAgICBtaWxlc3RvbmVJZDogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJNaWxlc3RvbmUgSUQgdG8gcXVlcnkgKGUuZy4gTTAwMSlcIiB9KSxcbiAgICB9KSxcbiAgICBhc3luYyBleGVjdXRlKF90b29sQ2FsbElkLCBwYXJhbXMsIF9zaWduYWwsIF9vblVwZGF0ZSwgX2N0eCkge1xuICAgICAgY29uc3QgZGJBdmFpbGFibGUgPSBhd2FpdCBlbnN1cmVEYk9wZW4ocmVzb2x2ZUN0eEN3ZChfY3R4KSk7XG4gICAgICBpZiAoIWRiQXZhaWxhYmxlKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiRXJyb3I6IEdTRCBkYXRhYmFzZSBpcyBub3QgYXZhaWxhYmxlLiBDYW5ub3QgcmVhZCBtaWxlc3RvbmUgc3RhdHVzLlwiIH1dLFxuICAgICAgICAgIGRldGFpbHM6IHsgb3BlcmF0aW9uOiBcIm1pbGVzdG9uZV9zdGF0dXNcIiwgZXJyb3I6IFwiZGJfdW5hdmFpbGFibGVcIiB9LFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgY29uc3QgeyBleGVjdXRlTWlsZXN0b25lU3RhdHVzIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi90b29scy93b3JrZmxvdy10b29sLWV4ZWN1dG9ycy5qc1wiKTtcbiAgICAgIHJldHVybiBleGVjdXRlTWlsZXN0b25lU3RhdHVzKHBhcmFtcyk7XG4gICAgfSxcbiAgfSk7XG5cbiAgcGkucmVnaXN0ZXJUb29sKHtcbiAgICBuYW1lOiBcImdzZF9jaGVja3BvaW50X2RiXCIsXG4gICAgbGFiZWw6IFwiQ2hlY2twb2ludCBHU0QgRGF0YWJhc2VcIixcbiAgICBkZXNjcmlwdGlvbjpcbiAgICAgIFwiRmx1c2ggdGhlIFNRTGl0ZSBXQUwgKFdyaXRlLUFoZWFkIExvZykgaW50byB0aGUgYmFzZSBnc2QuZGIgZmlsZS4gXCIgK1xuICAgICAgXCJDYWxsIHRoaXMgYmVmb3JlIGBnaXQgYWRkIC5nc2QvZ3NkLmRiYCB0byBlbnN1cmUgdGhlIGNvbW1pdHRlZCBkYXRhYmFzZSBcIiArXG4gICAgICBcImNvbnRhaW5zIGN1cnJlbnQgbWlsZXN0b25lL3NsaWNlL3Rhc2sgc3RhdGUgcmF0aGVyIHRoYW4gc3RhbGUgcHJlLXNlc3Npb24gY29udGVudC4gXCIgK1xuICAgICAgXCJTYWZlIHRvIGNhbGwgYXQgYW55IHRpbWUgd2hpbGUgR1NEIGlzIHJ1bm5pbmcuXCIsXG4gICAgcHJvbXB0U25pcHBldDogXCJGbHVzaCBXQUwgaW50byBnc2QuZGIgc28gZ2l0IGFkZCBzdGFnZXMgY3VycmVudCBzdGF0ZVwiLFxuICAgIHByb21wdEd1aWRlbGluZXM6IFtcbiAgICAgIFwiQ2FsbCBnc2RfY2hlY2twb2ludF9kYiBpbW1lZGlhdGVseSBiZWZvcmUgc3RhZ2luZyAuZ3NkL2dzZC5kYiB3aXRoIGdpdCBhZGQuXCIsXG4gICAgICBcIkRvIG5vdCB1c2Ugc3FsaXRlMyBvciBzaGVsbCBjb21tYW5kcyB0byBjaGVja3BvaW50IFx1MjAxNCB0aGV5IGFyZSBibG9ja2VkLiBVc2UgdGhpcyB0b29sIGluc3RlYWQuXCIsXG4gICAgXSxcbiAgICBwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7fSksXG4gICAgYXN5bmMgZXhlY3V0ZShfdG9vbENhbGxJZCwgX3BhcmFtcywgX3NpZ25hbCwgX29uVXBkYXRlLCBfY3R4KSB7XG4gICAgICBjb25zdCBkYkF2YWlsYWJsZSA9IGF3YWl0IGVuc3VyZURiT3BlbihyZXNvbHZlQ3R4Q3dkKF9jdHgpKTtcbiAgICAgIGlmICghZGJBdmFpbGFibGUpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJFcnJvcjogR1NEIGRhdGFiYXNlIGlzIG5vdCBhdmFpbGFibGUuIENhbm5vdCBjaGVja3BvaW50LlwiIH1dLFxuICAgICAgICAgIGRldGFpbHM6IHsgb3BlcmF0aW9uOiBcImNoZWNrcG9pbnRfZGJcIiwgZXJyb3I6IFwiZGJfdW5hdmFpbGFibGVcIiB9LFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgY29uc3QgeyBjaGVja3BvaW50RGF0YWJhc2UgfSA9IGF3YWl0IGltcG9ydChcIi4uL2dzZC1kYi5qc1wiKTtcbiAgICAgIGNoZWNrcG9pbnREYXRhYmFzZSgpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiV0FMIGNoZWNrcG9pbnQgY29tcGxldGUuIGdzZC5kYiBpcyBub3cgdXAgdG8gZGF0ZSBhbmQgc2FmZSB0byBzdGFnZSB3aXRoIGdpdCBhZGQuXCIgfV0sXG4gICAgICAgIGRldGFpbHM6IHsgb3BlcmF0aW9uOiBcImNoZWNrcG9pbnRfZGJcIiwgc3RhdHVzOiBcIm9rXCIgfSxcbiAgICAgIH07XG4gICAgfSxcbiAgfSk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFJQSxTQUFTLFlBQVk7QUFFckIsU0FBUyxjQUFjLHFCQUFxQjtBQUdyQyxTQUFTLG1CQUFtQixJQUF3QjtBQUN6RCxLQUFHLGFBQWE7QUFBQSxJQUNkLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLGFBQ0U7QUFBQSxJQUdGLGVBQWU7QUFBQSxJQUNmLGtCQUFrQjtBQUFBLE1BQ2hCO0FBQUEsSUFDRjtBQUFBLElBQ0EsWUFBWSxLQUFLLE9BQU87QUFBQSxNQUN0QixhQUFhLEtBQUssT0FBTyxFQUFFLGFBQWEsb0NBQW9DLENBQUM7QUFBQSxJQUMvRSxDQUFDO0FBQUEsSUFDRCxNQUFNLFFBQVEsYUFBYSxRQUFRLFNBQVMsV0FBVyxNQUFNO0FBQzNELFlBQU0sY0FBYyxNQUFNLGFBQWEsY0FBYyxJQUFJLENBQUM7QUFDMUQsVUFBSSxDQUFDLGFBQWE7QUFDaEIsZUFBTztBQUFBLFVBQ0wsU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFRLE1BQU0sc0VBQXNFLENBQUM7QUFBQSxVQUN2RyxTQUFTLEVBQUUsV0FBVyxvQkFBb0IsT0FBTyxpQkFBaUI7QUFBQSxRQUNwRTtBQUFBLE1BQ0Y7QUFDQSxZQUFNLEVBQUUsdUJBQXVCLElBQUksTUFBTSxPQUFPLHFDQUFxQztBQUNyRixhQUFPLHVCQUF1QixNQUFNO0FBQUEsSUFDdEM7QUFBQSxFQUNGLENBQUM7QUFFRCxLQUFHLGFBQWE7QUFBQSxJQUNkLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLGFBQ0U7QUFBQSxJQUlGLGVBQWU7QUFBQSxJQUNmLGtCQUFrQjtBQUFBLE1BQ2hCO0FBQUEsTUFDQTtBQUFBLElBQ0Y7QUFBQSxJQUNBLFlBQVksS0FBSyxPQUFPLENBQUMsQ0FBQztBQUFBLElBQzFCLE1BQU0sUUFBUSxhQUFhLFNBQVMsU0FBUyxXQUFXLE1BQU07QUFDNUQsWUFBTSxjQUFjLE1BQU0sYUFBYSxjQUFjLElBQUksQ0FBQztBQUMxRCxVQUFJLENBQUMsYUFBYTtBQUNoQixlQUFPO0FBQUEsVUFDTCxTQUFTLENBQUMsRUFBRSxNQUFNLFFBQVEsTUFBTSwyREFBMkQsQ0FBQztBQUFBLFVBQzVGLFNBQVMsRUFBRSxXQUFXLGlCQUFpQixPQUFPLGlCQUFpQjtBQUFBLFFBQ2pFO0FBQUEsTUFDRjtBQUNBLFlBQU0sRUFBRSxtQkFBbUIsSUFBSSxNQUFNLE9BQU8sY0FBYztBQUMxRCx5QkFBbUI7QUFDbkIsYUFBTztBQUFBLFFBQ0wsU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFRLE1BQU0sb0ZBQW9GLENBQUM7QUFBQSxRQUNySCxTQUFTLEVBQUUsV0FBVyxpQkFBaUIsUUFBUSxLQUFLO0FBQUEsTUFDdEQ7QUFBQSxJQUNGO0FBQUEsRUFDRixDQUFDO0FBQ0g7IiwKICAibmFtZXMiOiBbXQp9Cg==
