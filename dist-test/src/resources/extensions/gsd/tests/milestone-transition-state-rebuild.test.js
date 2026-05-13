import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AutoSession } from "../auto/session.js";
import { runPreDispatch } from "../auto/phases.js";
test("milestone transition archives completed units and rebuilds state", async () => {
  const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-cu-reset-")));
  const calls = [];
  try {
    const gsdDir = join(tempDir, ".gsd");
    mkdirSync(gsdDir, { recursive: true });
    const completedKeysPath = join(gsdDir, "completed-units.json");
    const staleEntries = [
      "context-gather/M001",
      "roadmap-plan/M001",
      "plan-slice/S01",
      "execute-task/T01"
    ];
    writeFileSync(completedKeysPath, JSON.stringify(staleEntries, null, 2));
    const s = new AutoSession();
    s.basePath = tempDir;
    s.originalBasePath = tempDir;
    s.currentMilestoneId = "M001";
    s.unitDispatchCount.set("old", 1);
    s.unitRecoveryCount.set("old", 1);
    s.unitLifetimeDispatches.set("old", 1);
    const state = {
      phase: "planning",
      activeMilestone: { id: "M002", title: "Next" },
      activeSlice: null,
      activeTask: null,
      recentDecisions: [],
      blockers: [],
      nextAction: "Plan M002",
      registry: [
        { id: "M001", title: "Done", status: "complete" },
        { id: "M002", title: "Next", status: "active" }
      ]
    };
    const result = await runPreDispatch({
      ctx: { ui: { notify() {
      } } },
      pi: {},
      s,
      prefs: void 0,
      iteration: 1,
      flowId: "test-flow",
      nextSeq: () => 1,
      deps: {
        checkResourcesStale: () => null,
        invalidateAllCaches: () => calls.push("invalidate"),
        preDispatchHealthGate: async () => ({ proceed: true, fixesApplied: [] }),
        syncProjectRootToWorktree: () => {
        },
        deriveState: async () => state,
        syncCmuxSidebar: () => {
        },
        preflightCleanRoot: () => ({ ok: true, stashPushed: false }),
        postflightPopStash: () => ({ ok: true, needsManualRecovery: false }),
        resolver: {
          mergeAndExit: () => calls.push("merge")
        },
        lifecycle: {
          enterMilestone: (mid) => {
            calls.push(`enter:${mid}`);
            return { ok: true, mode: "worktree", path: `/wt/${mid}` };
          },
          exitMilestone: (mid, opts) => {
            calls.push(opts.merge ? `merge:${mid}` : `exit:${mid}`);
            return { ok: true, merged: opts.merge, codeFilesChanged: false };
          }
        },
        sendDesktopNotification: () => {
        },
        logCmuxEvent: () => {
        },
        getIsolationMode: () => "none",
        captureIntegrationBranch: () => {
        },
        pruneQueueOrder: (_base, pending) => calls.push(`prune:${pending.join(",")}`),
        rebuildState: async () => calls.push("rebuild"),
        setActiveMilestoneId: (_base, mid) => calls.push(`active:${mid}`),
        reconcileMergeState: () => "clean",
        emitJournalEvent: () => {
        },
        stopAuto: async () => {
        },
        pauseAuto: async () => {
        },
        closeoutUnit: async () => {
        },
        buildSnapshotOpts: () => ({})
      }
    }, {
      recentUnits: [{ key: "stale" }],
      stuckRecoveryAttempts: 2,
      consecutiveFinalizeTimeouts: 0
    });
    assert.equal(result.action, "next");
    assert.equal(s.currentMilestoneId, "M002");
    assert.equal(s.unitDispatchCount.size, 0);
    assert.equal(s.unitRecoveryCount.size, 0);
    assert.equal(s.unitLifetimeDispatches.size, 0);
    assert.ok(existsSync(join(gsdDir, "completed-units-M001.json")));
    const after = JSON.parse(readFileSync(completedKeysPath, "utf-8"));
    assert.deepEqual(after, []);
    assert.ok(
      calls.indexOf("prune:M002") < calls.indexOf("rebuild"),
      `expected prune before rebuild, got ${calls.join(" > ")}`
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9taWxlc3RvbmUtdHJhbnNpdGlvbi1zdGF0ZS1yZWJ1aWxkLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogbWlsZXN0b25lLXRyYW5zaXRpb24tc3RhdGUtcmVidWlsZC50ZXN0LnRzIFx1MjAxNCBUZXN0cyBmb3IgIzE1NzYgZml4LlxuICpcbiAqIFZlcmlmaWVzIHRoYXQ6XG4gKiAxLiByZWJ1aWxkU3RhdGUoKSBpcyBjYWxsZWQgYWZ0ZXIgbWlsZXN0b25lIHRyYW5zaXRpb25zIHNvIFNUQVRFLm1kXG4gKiAgICByZWZsZWN0cyB0aGUgbmV3IGFjdGl2ZSBtaWxlc3RvbmUuXG4gKiAyLiBjb21wbGV0ZWQtdW5pdHMuanNvbiBpcyByZXNldCB3aGVuIHRoZSBhY3RpdmUgbWlsZXN0b25lIGNoYW5nZXMsXG4gKiAgICBwcmV2ZW50aW5nIHN0YWxlIGVudHJpZXMgZnJvbSBjYXVzaW5nIGRpc3BhdGNoIHNraXBzLlxuICovXG5cbmltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgcmVhZEZpbGVTeW5jLCBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCB3cml0ZUZpbGVTeW5jLCBleGlzdHNTeW5jLCBybVN5bmMsIHJlYWxwYXRoU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IEF1dG9TZXNzaW9uIH0gZnJvbSBcIi4uL2F1dG8vc2Vzc2lvbi50c1wiO1xuaW1wb3J0IHsgcnVuUHJlRGlzcGF0Y2ggfSBmcm9tIFwiLi4vYXV0by9waGFzZXMudHNcIjtcblxudGVzdChcIm1pbGVzdG9uZSB0cmFuc2l0aW9uIGFyY2hpdmVzIGNvbXBsZXRlZCB1bml0cyBhbmQgcmVidWlsZHMgc3RhdGVcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB0ZW1wRGlyID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLWN1LXJlc2V0LVwiKSkpO1xuICBjb25zdCBjYWxsczogc3RyaW5nW10gPSBbXTtcbiAgdHJ5IHtcbiAgICBjb25zdCBnc2REaXIgPSBqb2luKHRlbXBEaXIsIFwiLmdzZFwiKTtcbiAgICBta2RpclN5bmMoZ3NkRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAgIGNvbnN0IGNvbXBsZXRlZEtleXNQYXRoID0gam9pbihnc2REaXIsIFwiY29tcGxldGVkLXVuaXRzLmpzb25cIik7XG4gICAgY29uc3Qgc3RhbGVFbnRyaWVzID0gW1xuICAgICAgXCJjb250ZXh0LWdhdGhlci9NMDAxXCIsXG4gICAgICBcInJvYWRtYXAtcGxhbi9NMDAxXCIsXG4gICAgICBcInBsYW4tc2xpY2UvUzAxXCIsXG4gICAgICBcImV4ZWN1dGUtdGFzay9UMDFcIixcbiAgICBdO1xuICAgIHdyaXRlRmlsZVN5bmMoY29tcGxldGVkS2V5c1BhdGgsIEpTT04uc3RyaW5naWZ5KHN0YWxlRW50cmllcywgbnVsbCwgMikpO1xuXG4gICAgY29uc3QgcyA9IG5ldyBBdXRvU2Vzc2lvbigpO1xuICAgIHMuYmFzZVBhdGggPSB0ZW1wRGlyO1xuICAgIHMub3JpZ2luYWxCYXNlUGF0aCA9IHRlbXBEaXI7XG4gICAgcy5jdXJyZW50TWlsZXN0b25lSWQgPSBcIk0wMDFcIjtcbiAgICBzLnVuaXREaXNwYXRjaENvdW50LnNldChcIm9sZFwiLCAxKTtcbiAgICBzLnVuaXRSZWNvdmVyeUNvdW50LnNldChcIm9sZFwiLCAxKTtcbiAgICBzLnVuaXRMaWZldGltZURpc3BhdGNoZXMuc2V0KFwib2xkXCIsIDEpO1xuXG4gICAgY29uc3Qgc3RhdGUgPSB7XG4gICAgICBwaGFzZTogXCJwbGFubmluZ1wiLFxuICAgICAgYWN0aXZlTWlsZXN0b25lOiB7IGlkOiBcIk0wMDJcIiwgdGl0bGU6IFwiTmV4dFwiIH0sXG4gICAgICBhY3RpdmVTbGljZTogbnVsbCxcbiAgICAgIGFjdGl2ZVRhc2s6IG51bGwsXG4gICAgICByZWNlbnREZWNpc2lvbnM6IFtdLFxuICAgICAgYmxvY2tlcnM6IFtdLFxuICAgICAgbmV4dEFjdGlvbjogXCJQbGFuIE0wMDJcIixcbiAgICAgIHJlZ2lzdHJ5OiBbXG4gICAgICAgIHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJEb25lXCIsIHN0YXR1czogXCJjb21wbGV0ZVwiIH0sXG4gICAgICAgIHsgaWQ6IFwiTTAwMlwiLCB0aXRsZTogXCJOZXh0XCIsIHN0YXR1czogXCJhY3RpdmVcIiB9LFxuICAgICAgXSxcbiAgICB9O1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuUHJlRGlzcGF0Y2goe1xuICAgICAgY3R4OiB7IHVpOiB7IG5vdGlmeSgpIHt9IH0gfSxcbiAgICAgIHBpOiB7fSxcbiAgICAgIHMsXG4gICAgICBwcmVmczogdW5kZWZpbmVkLFxuICAgICAgaXRlcmF0aW9uOiAxLFxuICAgICAgZmxvd0lkOiBcInRlc3QtZmxvd1wiLFxuICAgICAgbmV4dFNlcTogKCkgPT4gMSxcbiAgICAgIGRlcHM6IHtcbiAgICAgICAgY2hlY2tSZXNvdXJjZXNTdGFsZTogKCkgPT4gbnVsbCxcbiAgICAgICAgaW52YWxpZGF0ZUFsbENhY2hlczogKCkgPT4gY2FsbHMucHVzaChcImludmFsaWRhdGVcIiksXG4gICAgICAgIHByZURpc3BhdGNoSGVhbHRoR2F0ZTogYXN5bmMgKCkgPT4gKHsgcHJvY2VlZDogdHJ1ZSwgZml4ZXNBcHBsaWVkOiBbXSB9KSxcbiAgICAgICAgc3luY1Byb2plY3RSb290VG9Xb3JrdHJlZTogKCkgPT4ge30sXG4gICAgICAgIGRlcml2ZVN0YXRlOiBhc3luYyAoKSA9PiBzdGF0ZSxcbiAgICAgICAgc3luY0NtdXhTaWRlYmFyOiAoKSA9PiB7fSxcbiAgICAgICAgcHJlZmxpZ2h0Q2xlYW5Sb290OiAoKSA9PiAoeyBvazogdHJ1ZSwgc3Rhc2hQdXNoZWQ6IGZhbHNlIH0pLFxuICAgICAgICBwb3N0ZmxpZ2h0UG9wU3Rhc2g6ICgpID0+ICh7IG9rOiB0cnVlLCBuZWVkc01hbnVhbFJlY292ZXJ5OiBmYWxzZSB9KSxcbiAgICAgICAgcmVzb2x2ZXI6IHtcbiAgICAgICAgICBtZXJnZUFuZEV4aXQ6ICgpID0+IGNhbGxzLnB1c2goXCJtZXJnZVwiKSxcbiAgICAgICAgfSxcbiAgICAgICAgbGlmZWN5Y2xlOiB7XG4gICAgICAgICAgZW50ZXJNaWxlc3RvbmU6IChtaWQ6IHN0cmluZykgPT4ge1xuICAgICAgICAgICAgY2FsbHMucHVzaChgZW50ZXI6JHttaWR9YCk7XG4gICAgICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgbW9kZTogXCJ3b3JrdHJlZVwiLCBwYXRoOiBgL3d0LyR7bWlkfWAgfTtcbiAgICAgICAgICB9LFxuICAgICAgICAgIGV4aXRNaWxlc3RvbmU6IChtaWQ6IHN0cmluZywgb3B0czogeyBtZXJnZTogYm9vbGVhbiB9KSA9PiB7XG4gICAgICAgICAgICBjYWxscy5wdXNoKG9wdHMubWVyZ2UgPyBgbWVyZ2U6JHttaWR9YCA6IGBleGl0OiR7bWlkfWApO1xuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIG1lcmdlZDogb3B0cy5tZXJnZSwgY29kZUZpbGVzQ2hhbmdlZDogZmFsc2UgfTtcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgICBzZW5kRGVza3RvcE5vdGlmaWNhdGlvbjogKCkgPT4ge30sXG4gICAgICAgIGxvZ0NtdXhFdmVudDogKCkgPT4ge30sXG4gICAgICAgIGdldElzb2xhdGlvbk1vZGU6ICgpID0+IFwibm9uZVwiLFxuICAgICAgICBjYXB0dXJlSW50ZWdyYXRpb25CcmFuY2g6ICgpID0+IHt9LFxuICAgICAgICBwcnVuZVF1ZXVlT3JkZXI6IChfYmFzZTogc3RyaW5nLCBwZW5kaW5nOiBzdHJpbmdbXSkgPT4gY2FsbHMucHVzaChgcHJ1bmU6JHtwZW5kaW5nLmpvaW4oXCIsXCIpfWApLFxuICAgICAgICByZWJ1aWxkU3RhdGU6IGFzeW5jICgpID0+IGNhbGxzLnB1c2goXCJyZWJ1aWxkXCIpLFxuICAgICAgICBzZXRBY3RpdmVNaWxlc3RvbmVJZDogKF9iYXNlOiBzdHJpbmcsIG1pZDogc3RyaW5nKSA9PiBjYWxscy5wdXNoKGBhY3RpdmU6JHttaWR9YCksXG4gICAgICAgIHJlY29uY2lsZU1lcmdlU3RhdGU6ICgpID0+IFwiY2xlYW5cIixcbiAgICAgICAgZW1pdEpvdXJuYWxFdmVudDogKCkgPT4ge30sXG4gICAgICAgIHN0b3BBdXRvOiBhc3luYyAoKSA9PiB7fSxcbiAgICAgICAgcGF1c2VBdXRvOiBhc3luYyAoKSA9PiB7fSxcbiAgICAgICAgY2xvc2VvdXRVbml0OiBhc3luYyAoKSA9PiB7fSxcbiAgICAgICAgYnVpbGRTbmFwc2hvdE9wdHM6ICgpID0+ICh7fSksXG4gICAgICB9LFxuICAgIH0gYXMgYW55LCB7XG4gICAgICByZWNlbnRVbml0czogW3sga2V5OiBcInN0YWxlXCIgfV0sXG4gICAgICBzdHVja1JlY292ZXJ5QXR0ZW1wdHM6IDIsXG4gICAgICBjb25zZWN1dGl2ZUZpbmFsaXplVGltZW91dHM6IDAsXG4gICAgfSk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmFjdGlvbiwgXCJuZXh0XCIpO1xuICAgIGFzc2VydC5lcXVhbChzLmN1cnJlbnRNaWxlc3RvbmVJZCwgXCJNMDAyXCIpO1xuICAgIGFzc2VydC5lcXVhbChzLnVuaXREaXNwYXRjaENvdW50LnNpemUsIDApO1xuICAgIGFzc2VydC5lcXVhbChzLnVuaXRSZWNvdmVyeUNvdW50LnNpemUsIDApO1xuICAgIGFzc2VydC5lcXVhbChzLnVuaXRMaWZldGltZURpc3BhdGNoZXMuc2l6ZSwgMCk7XG4gICAgYXNzZXJ0Lm9rKGV4aXN0c1N5bmMoam9pbihnc2REaXIsIFwiY29tcGxldGVkLXVuaXRzLU0wMDEuanNvblwiKSkpO1xuICAgIGNvbnN0IGFmdGVyID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoY29tcGxldGVkS2V5c1BhdGgsIFwidXRmLThcIikpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwoYWZ0ZXIsIFtdKTtcbiAgICBhc3NlcnQub2soXG4gICAgICBjYWxscy5pbmRleE9mKFwicHJ1bmU6TTAwMlwiKSA8IGNhbGxzLmluZGV4T2YoXCJyZWJ1aWxkXCIpLFxuICAgICAgYGV4cGVjdGVkIHBydW5lIGJlZm9yZSByZWJ1aWxkLCBnb3QgJHtjYWxscy5qb2luKFwiID4gXCIpfWAsXG4gICAgKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQVVBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxjQUFjLGFBQWEsV0FBVyxlQUFlLFlBQVksUUFBUSxvQkFBb0I7QUFDdEcsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUN2QixTQUFTLG1CQUFtQjtBQUM1QixTQUFTLHNCQUFzQjtBQUUvQixLQUFLLG9FQUFvRSxZQUFZO0FBQ25GLFFBQU0sVUFBVSxhQUFhLFlBQVksS0FBSyxPQUFPLEdBQUcsZUFBZSxDQUFDLENBQUM7QUFDekUsUUFBTSxRQUFrQixDQUFDO0FBQ3pCLE1BQUk7QUFDRixVQUFNLFNBQVMsS0FBSyxTQUFTLE1BQU07QUFDbkMsY0FBVSxRQUFRLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFFckMsVUFBTSxvQkFBb0IsS0FBSyxRQUFRLHNCQUFzQjtBQUM3RCxVQUFNLGVBQWU7QUFBQSxNQUNuQjtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLElBQ0Y7QUFDQSxrQkFBYyxtQkFBbUIsS0FBSyxVQUFVLGNBQWMsTUFBTSxDQUFDLENBQUM7QUFFdEUsVUFBTSxJQUFJLElBQUksWUFBWTtBQUMxQixNQUFFLFdBQVc7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
