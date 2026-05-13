import { createTestContext } from "./test-helpers.js";
import { runPreDispatch } from "../auto/phases.js";
const { assertTrue, report } = createTestContext();
console.log("\n=== #2766: Non-MergeConflictError stops auto mode ===");
const notifications = [];
const calls = [];
const basePath = "/tmp/gsd-test";
const ic = {
  ctx: {
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      }
    }
  },
  pi: {},
  s: {
    basePath,
    originalBasePath: basePath,
    canonicalProjectRoot: basePath,
    resourceVersionOnStart: "test",
    currentMilestoneId: "M001",
    currentUnit: null,
    milestoneMergedInPhases: false
  },
  prefs: void 0,
  iteration: 1,
  flowId: "test-flow",
  nextSeq: () => 1,
  deps: {
    checkResourcesStale() {
      return null;
    },
    invalidateAllCaches() {
      calls.push("invalidate");
    },
    async preDispatchHealthGate() {
      calls.push("health");
      return { proceed: true, fixesApplied: [] };
    },
    async deriveState(projectRoot) {
      calls.push(`derive:${projectRoot}`);
      return {
        phase: "complete",
        activeMilestone: { id: "M001", title: "Milestone one" },
        activeSlice: null,
        activeTask: null,
        registry: [{ id: "M001", status: "complete" }],
        nextAction: "complete"
      };
    },
    syncCmuxSidebar() {
      calls.push("sync-sidebar");
    },
    setActiveMilestoneId(_basePath, mid) {
      calls.push(`set-active:${mid}`);
    },
    reconcileMergeState() {
      calls.push("reconcile");
      return "clean";
    },
    preflightCleanRoot() {
      calls.push("preflight");
      return { ok: true, stashPushed: true, stashMarker: "marker" };
    },
    postflightPopStash() {
      calls.push("postflight");
      return { ok: true, needsManualRecovery: false };
    },
    lifecycle: {
      exitMilestone() {
        calls.push("merge");
        return {
          ok: false,
          reason: "teardown-failed",
          cause: new Error("remote rejected push")
        };
      }
    },
    async stopAuto(_ctx, _pi, reason) {
      calls.push(`stop:${reason}`);
    }
  }
};
const result = await runPreDispatch(ic, {
  recentUnits: [],
  stuckRecoveryAttempts: 0,
  consecutiveFinalizeTimeouts: 0
});
assertTrue(result.action === "break", "non-conflict merge error returns break");
if (result.action === "break") {
  assertTrue(result.reason === "merge-failed", "non-conflict merge error uses merge-failed reason");
}
assertTrue(
  calls.join(" > ") === "invalidate > health > derive:/tmp/gsd-test > sync-sidebar > set-active:M001 > reconcile > preflight > merge > postflight > stop:Merge error on milestone M001: Error: remote rejected push",
  `pre-dispatch stops immediately after non-conflict merge failure (${calls.join(" > ")})`
);
assertTrue(
  notifications.some((n) => n.level === "error" && n.message.includes("Merge failed: remote rejected push")),
  "user is notified with an error that merge failed"
);
report();
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9waGFzZXMtbWVyZ2UtZXJyb3Itc3RvcHMtYXV0by50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIHBoYXNlcy1tZXJnZS1lcnJvci1zdG9wcy1hdXRvLnRlc3QudHMgXHUyMDE0IFJlZ3Jlc3Npb24gdGVzdCBmb3IgIzI3NjYuXG4gKlxuICogV2hlbiBtZXJnZUFuZEV4aXQgdGhyb3dzIGEgbm9uLU1lcmdlQ29uZmxpY3RFcnJvciwgdGhlIGF1dG8gbG9vcCBtdXN0XG4gKiBzdG9wIGluc3RlYWQgb2YgY29udGludWluZyB3aXRoIHVubWVyZ2VkIHdvcmsuIFRoaXMgdGVzdCB2ZXJpZmllcyB0aGF0XG4gKiBhbGwgY2F0Y2ggYmxvY2tzIGluIGF1dG8vcGhhc2VzLnRzIHRoYXQgaGFuZGxlIG1lcmdlQW5kRXhpdCBlcnJvcnNcbiAqIGNhbGwgc3RvcEF1dG8gYW5kIHJldHVybiB7IGFjdGlvbjogXCJicmVha1wiIH0gZm9yIG5vbi1jb25mbGljdCBlcnJvcnMuXG4gKi9cblxuaW1wb3J0IHsgY3JlYXRlVGVzdENvbnRleHQgfSBmcm9tIFwiLi90ZXN0LWhlbHBlcnMudHNcIjtcbmltcG9ydCB7IHJ1blByZURpc3BhdGNoIH0gZnJvbSBcIi4uL2F1dG8vcGhhc2VzLnRzXCI7XG5cbmNvbnN0IHsgYXNzZXJ0VHJ1ZSwgcmVwb3J0IH0gPSBjcmVhdGVUZXN0Q29udGV4dCgpO1xuXG5jb25zb2xlLmxvZyhcIlxcbj09PSAjMjc2NjogTm9uLU1lcmdlQ29uZmxpY3RFcnJvciBzdG9wcyBhdXRvIG1vZGUgPT09XCIpO1xuXG5jb25zdCBub3RpZmljYXRpb25zOiBBcnJheTx7IG1lc3NhZ2U6IHN0cmluZzsgbGV2ZWw/OiBzdHJpbmcgfT4gPSBbXTtcbmNvbnN0IGNhbGxzOiBzdHJpbmdbXSA9IFtdO1xuY29uc3QgYmFzZVBhdGggPSBcIi90bXAvZ3NkLXRlc3RcIjtcbmNvbnN0IGljID0ge1xuICBjdHg6IHtcbiAgICB1aToge1xuICAgICAgbm90aWZ5KG1lc3NhZ2U6IHN0cmluZywgbGV2ZWw/OiBzdHJpbmcpIHtcbiAgICAgICAgbm90aWZpY2F0aW9ucy5wdXNoKHsgbWVzc2FnZSwgbGV2ZWwgfSk7XG4gICAgICB9LFxuICAgIH0sXG4gIH0sXG4gIHBpOiB7fSxcbiAgczoge1xuICAgIGJhc2VQYXRoLFxuICAgIG9yaWdpbmFsQmFzZVBhdGg6IGJhc2VQYXRoLFxuICAgIGNhbm9uaWNhbFByb2plY3RSb290OiBiYXNlUGF0aCxcbiAgICByZXNvdXJjZVZlcnNpb25PblN0YXJ0OiBcInRlc3RcIixcbiAgICBjdXJyZW50TWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgIGN1cnJlbnRVbml0OiBudWxsLFxuICAgIG1pbGVzdG9uZU1lcmdlZEluUGhhc2VzOiBmYWxzZSxcbiAgfSxcbiAgcHJlZnM6IHVuZGVmaW5lZCxcbiAgaXRlcmF0aW9uOiAxLFxuICBmbG93SWQ6IFwidGVzdC1mbG93XCIsXG4gIG5leHRTZXE6ICgpID0+IDEsXG4gIGRlcHM6IHtcbiAgICBjaGVja1Jlc291cmNlc1N0YWxlKCkge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfSxcbiAgICBpbnZhbGlkYXRlQWxsQ2FjaGVzKCkge1xuICAgICAgY2FsbHMucHVzaChcImludmFsaWRhdGVcIik7XG4gICAgfSxcbiAgICBhc3luYyBwcmVEaXNwYXRjaEhlYWx0aEdhdGUoKSB7XG4gICAgICBjYWxscy5wdXNoKFwiaGVhbHRoXCIpO1xuICAgICAgcmV0dXJuIHsgcHJvY2VlZDogdHJ1ZSwgZml4ZXNBcHBsaWVkOiBbXSB9O1xuICAgIH0sXG4gICAgYXN5bmMgZGVyaXZlU3RhdGUocHJvamVjdFJvb3Q6IHN0cmluZykge1xuICAgICAgY2FsbHMucHVzaChgZGVyaXZlOiR7cHJvamVjdFJvb3R9YCk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBwaGFzZTogXCJjb21wbGV0ZVwiLFxuICAgICAgICBhY3RpdmVNaWxlc3RvbmU6IHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJNaWxlc3RvbmUgb25lXCIgfSxcbiAgICAgICAgYWN0aXZlU2xpY2U6IG51bGwsXG4gICAgICAgIGFjdGl2ZVRhc2s6IG51bGwsXG4gICAgICAgIHJlZ2lzdHJ5OiBbeyBpZDogXCJNMDAxXCIsIHN0YXR1czogXCJjb21wbGV0ZVwiIH1dLFxuICAgICAgICBuZXh0QWN0aW9uOiBcImNvbXBsZXRlXCIsXG4gICAgICB9O1xuICAgIH0sXG4gICAgc3luY0NtdXhTaWRlYmFyKCkge1xuICAgICAgY2FsbHMucHVzaChcInN5bmMtc2lkZWJhclwiKTtcbiAgICB9LFxuICAgIHNldEFjdGl2ZU1pbGVzdG9uZUlkKF9iYXNlUGF0aDogc3RyaW5nLCBtaWQ6IHN0cmluZykge1xuICAgICAgY2FsbHMucHVzaChgc2V0LWFjdGl2ZToke21pZH1gKTtcbiAgICB9LFxuICAgIHJlY29uY2lsZU1lcmdlU3RhdGUoKSB7XG4gICAgICBjYWxscy5wdXNoKFwicmVjb25jaWxlXCIpO1xuICAgICAgcmV0dXJuIFwiY2xlYW5cIjtcbiAgICB9LFxuICAgIHByZWZsaWdodENsZWFuUm9vdCgpIHtcbiAgICAgIGNhbGxzLnB1c2goXCJwcmVmbGlnaHRcIik7XG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgc3Rhc2hQdXNoZWQ6IHRydWUsIHN0YXNoTWFya2VyOiBcIm1hcmtlclwiIH07XG4gICAgfSxcbiAgICBwb3N0ZmxpZ2h0UG9wU3Rhc2goKSB7XG4gICAgICBjYWxscy5wdXNoKFwicG9zdGZsaWdodFwiKTtcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBuZWVkc01hbnVhbFJlY292ZXJ5OiBmYWxzZSB9O1xuICAgIH0sXG4gICAgbGlmZWN5Y2xlOiB7XG4gICAgICBleGl0TWlsZXN0b25lKCkge1xuICAgICAgICBjYWxscy5wdXNoKFwibWVyZ2VcIik7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgIHJlYXNvbjogXCJ0ZWFyZG93bi1mYWlsZWRcIixcbiAgICAgICAgICBjYXVzZTogbmV3IEVycm9yKFwicmVtb3RlIHJlamVjdGVkIHB1c2hcIiksXG4gICAgICAgIH07XG4gICAgICB9LFxuICAgIH0sXG4gICAgYXN5bmMgc3RvcEF1dG8oX2N0eDogdW5rbm93biwgX3BpOiB1bmtub3duLCByZWFzb24/OiBzdHJpbmcpIHtcbiAgICAgIGNhbGxzLnB1c2goYHN0b3A6JHtyZWFzb259YCk7XG4gICAgfSxcbiAgfSxcbn0gYXMgYW55O1xuXG5jb25zdCByZXN1bHQgPSBhd2FpdCBydW5QcmVEaXNwYXRjaChpYywge1xuICByZWNlbnRVbml0czogW10sXG4gIHN0dWNrUmVjb3ZlcnlBdHRlbXB0czogMCxcbiAgY29uc2VjdXRpdmVGaW5hbGl6ZVRpbWVvdXRzOiAwLFxufSk7XG5cbmFzc2VydFRydWUocmVzdWx0LmFjdGlvbiA9PT0gXCJicmVha1wiLCBcIm5vbi1jb25mbGljdCBtZXJnZSBlcnJvciByZXR1cm5zIGJyZWFrXCIpO1xuaWYgKHJlc3VsdC5hY3Rpb24gPT09IFwiYnJlYWtcIikge1xuICBhc3NlcnRUcnVlKHJlc3VsdC5yZWFzb24gPT09IFwibWVyZ2UtZmFpbGVkXCIsIFwibm9uLWNvbmZsaWN0IG1lcmdlIGVycm9yIHVzZXMgbWVyZ2UtZmFpbGVkIHJlYXNvblwiKTtcbn1cbmFzc2VydFRydWUoXG4gIGNhbGxzLmpvaW4oXCIgPiBcIikgPT09IFwiaW52YWxpZGF0ZSA+IGhlYWx0aCA+IGRlcml2ZTovdG1wL2dzZC10ZXN0ID4gc3luYy1zaWRlYmFyID4gc2V0LWFjdGl2ZTpNMDAxID4gcmVjb25jaWxlID4gcHJlZmxpZ2h0ID4gbWVyZ2UgPiBwb3N0ZmxpZ2h0ID4gc3RvcDpNZXJnZSBlcnJvciBvbiBtaWxlc3RvbmUgTTAwMTogRXJyb3I6IHJlbW90ZSByZWplY3RlZCBwdXNoXCIsXG4gIGBwcmUtZGlzcGF0Y2ggc3RvcHMgaW1tZWRpYXRlbHkgYWZ0ZXIgbm9uLWNvbmZsaWN0IG1lcmdlIGZhaWx1cmUgKCR7Y2FsbHMuam9pbihcIiA+IFwiKX0pYCxcbik7XG5hc3NlcnRUcnVlKFxuICBub3RpZmljYXRpb25zLnNvbWUoKG4pID0+IG4ubGV2ZWwgPT09IFwiZXJyb3JcIiAmJiBuLm1lc3NhZ2UuaW5jbHVkZXMoXCJNZXJnZSBmYWlsZWQ6IHJlbW90ZSByZWplY3RlZCBwdXNoXCIpKSxcbiAgXCJ1c2VyIGlzIG5vdGlmaWVkIHdpdGggYW4gZXJyb3IgdGhhdCBtZXJnZSBmYWlsZWRcIixcbik7XG5cbnJlcG9ydCgpO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBU0EsU0FBUyx5QkFBeUI7QUFDbEMsU0FBUyxzQkFBc0I7QUFFL0IsTUFBTSxFQUFFLFlBQVksT0FBTyxJQUFJLGtCQUFrQjtBQUVqRCxRQUFRLElBQUkseURBQXlEO0FBRXJFLE1BQU0sZ0JBQTRELENBQUM7QUFDbkUsTUFBTSxRQUFrQixDQUFDO0FBQ3pCLE1BQU0sV0FBVztBQUNqQixNQUFNLEtBQUs7QUFBQSxFQUNULEtBQUs7QUFBQSxJQUNILElBQUk7QUFBQSxNQUNGLE9BQU8sU0FBaUIsT0FBZ0I7QUFDdEMsc0JBQWMsS0FBSyxFQUFFLFNBQVMsTUFBTSxDQUFDO0FBQUEsTUFDdkM7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUFBLEVBQ0EsSUFBSSxDQUFDO0FBQUEsRUFDTCxHQUFHO0FBQUEsSUFDRDtBQUFBLElBQ0Esa0JBQWtCO0FBQUEsSUFDbEIsc0JBQXNCO0FBQUEsSUFDdEIsd0JBQXdCO0FBQUEsSUFDeEIsb0JBQW9CO0FBQUEsSUFDcEIsYUFBYTtBQUFBLElBQ2IseUJBQXlCO0FBQUEsRUFDM0I7QUFBQSxFQUNBLE9BQU87QUFBQSxFQUNQLFdBQVc7QUFBQSxFQUNYLFFBQVE7QUFBQSxFQUNSLFNBQVMsTUFBTTtBQUFBLEVBQ2YsTUFBTTtBQUFBLElBQ0osc0JBQXNCO0FBQ3BCLGFBQU87QUFBQSxJQUNUO0FBQUEsSUFDQSxzQkFBc0I7QUFDcEIsWUFBTSxLQUFLLFlBQVk7QUFBQSxJQUN6QjtBQUFBLElBQ0EsTUFBTSx3QkFBd0I7QUFDNUIsWUFBTSxLQUFLLFFBQVE7QUFDbkIsYUFBTyxFQUFFLFNBQVMsTUFBTSxjQUFjLENBQUMsRUFBRTtBQUFBLElBQzNDO0FBQUEsSUFDQSxNQUFNLFlBQVksYUFBcUI7QUFDckMsWUFBTSxLQUFLLFVBQVUsV0FBVyxFQUFFO0FBQ2xDLGFBQU87QUFBQSxRQUNMLE9BQU87QUFBQSxRQUNQLGlCQUFpQixFQUFFLElBQUksUUFBUSxPQUFPLGdCQUFnQjtBQUFBLFFBQ3RELGFBQWE7QUFBQSxRQUNiLFlBQVk7QUFBQSxRQUNaLFVBQVUsQ0FBQyxFQUFFLElBQUksUUFBUSxRQUFRLFdBQVcsQ0FBQztBQUFBLFFBQzdDLFlBQVk7QUFBQSxNQUNkO0FBQUEsSUFDRjtBQUFBLElBQ0Esa0JBQWtCO0FBQ2hCLFlBQU0sS0FBSyxjQUFjO0FBQUEsSUFDM0I7QUFBQSxJQUNBLHFCQUFxQixXQUFtQixLQUFhO0FBQ25ELFlBQU0sS0FBSyxjQUFjLEdBQUcsRUFBRTtBQUFBLElBQ2hDO0FBQUEsSUFDQSxzQkFBc0I7QUFDcEIsWUFBTSxLQUFLLFdBQVc7QUFDdEIsYUFBTztBQUFBLElBQ1Q7QUFBQSxJQUNBLHFCQUFxQjtBQUNuQixZQUFNLEtBQUssV0FBVztBQUN0QixhQUFPLEVBQUUsSUFBSSxNQUFNLGFBQWEsTUFBTSxhQUFhLFNBQVM7QUFBQSxJQUM5RDtBQUFBLElBQ0EscUJBQXFCO0FBQ25CLFlBQU0sS0FBSyxZQUFZO0FBQ3ZCLGFBQU8sRUFBRSxJQUFJLE1BQU0scUJBQXFCLE1BQU07QUFBQSxJQUNoRDtBQUFBLElBQ0EsV0FBVztBQUFBLE1BQ1QsZ0JBQWdCO0FBQ2QsY0FBTSxLQUFLLE9BQU87QUFDbEIsZUFBTztBQUFBLFVBQ0wsSUFBSTtBQUFBLFVBQ0osUUFBUTtBQUFBLFVBQ1IsT0FBTyxJQUFJLE1BQU0sc0JBQXNCO0FBQUEsUUFDekM7QUFBQSxNQUNGO0FBQUEsSUFDRjtBQUFBLElBQ0EsTUFBTSxTQUFTLE1BQWUsS0FBYyxRQUFpQjtBQUMzRCxZQUFNLEtBQUssUUFBUSxNQUFNLEVBQUU7QUFBQSxJQUM3QjtBQUFBLEVBQ0Y7QUFDRjtBQUVBLE1BQU0sU0FBUyxNQUFNLGVBQWUsSUFBSTtBQUFBLEVBQ3RDLGFBQWEsQ0FBQztBQUFBLEVBQ2QsdUJBQXVCO0FBQUEsRUFDdkIsNkJBQTZCO0FBQy9CLENBQUM7QUFFRCxXQUFXLE9BQU8sV0FBVyxTQUFTLHdDQUF3QztBQUM5RSxJQUFJLE9BQU8sV0FBVyxTQUFTO0FBQzdCLGFBQVcsT0FBTyxXQUFXLGdCQUFnQixtREFBbUQ7QUFDbEc7QUFDQTtBQUFBLEVBQ0UsTUFBTSxLQUFLLEtBQUssTUFBTTtBQUFBLEVBQ3RCLG9FQUFvRSxNQUFNLEtBQUssS0FBSyxDQUFDO0FBQ3ZGO0FBQ0E7QUFBQSxFQUNFLGNBQWMsS0FBSyxDQUFDLE1BQU0sRUFBRSxVQUFVLFdBQVcsRUFBRSxRQUFRLFNBQVMsb0NBQW9DLENBQUM7QUFBQSxFQUN6RztBQUNGO0FBRUEsT0FBTzsiLAogICJuYW1lcyI6IFtdCn0K
