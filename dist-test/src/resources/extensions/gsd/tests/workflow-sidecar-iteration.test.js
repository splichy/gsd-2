import assert from "node:assert/strict";
import test from "node:test";
import { buildSidecarIterationData } from "../auto/workflow-sidecar-iteration.js";
function makeSidecarItem(overrides) {
  return {
    kind: "hook",
    unitType: "sidecar/hook",
    unitId: "hook-1",
    prompt: "Run hook",
    ...overrides
  };
}
test("buildSidecarIterationData derives state from canonical project root", async () => {
  const roots = [];
  const state = {
    phase: "executing",
    activeMilestone: { id: "M001", title: "Milestone 1" },
    activeSlice: { id: "S01" },
    activeTask: { id: "T01" }
  };
  await buildSidecarIterationData({
    sidecarItem: makeSidecarItem(),
    basePath: "/worktree",
    canonicalProjectRoot: "/project",
    deriveState: async (root) => {
      roots.push(root);
      return state;
    },
    logPostDerive: () => {
    }
  });
  assert.deepEqual(roots, ["/project"]);
});
test("buildSidecarIterationData maps sidecar item and milestone state into iteration data", async () => {
  const state = {
    phase: "executing",
    activeMilestone: { id: "M001", title: "Milestone 1" }
  };
  const iterData = await buildSidecarIterationData({
    sidecarItem: makeSidecarItem({
      unitType: "sidecar/quick-task",
      unitId: "capture-1",
      prompt: "Do captured task"
    }),
    basePath: "/worktree",
    canonicalProjectRoot: "/project",
    deriveState: async () => state,
    logPostDerive: () => {
    }
  });
  assert.equal(iterData.unitType, "sidecar/quick-task");
  assert.equal(iterData.unitId, "capture-1");
  assert.equal(iterData.prompt, "Do captured task");
  assert.equal(iterData.finalPrompt, "Do captured task");
  assert.equal(iterData.pauseAfterUatDispatch, false);
  assert.equal(iterData.state, state);
  assert.equal(iterData.mid, "M001");
  assert.equal(iterData.midTitle, "Milestone 1");
  assert.equal(iterData.isRetry, false);
  assert.equal(iterData.previousTier, void 0);
});
test("buildSidecarIterationData logs task, slice, or milestone active unit", async () => {
  const logs = [];
  await buildSidecarIterationData({
    sidecarItem: makeSidecarItem(),
    basePath: "/worktree",
    canonicalProjectRoot: "/project",
    deriveState: async () => ({
      phase: "planning",
      activeMilestone: { id: "M001", title: "Milestone 1" },
      activeSlice: { id: "S01" },
      activeTask: { id: "T01" }
    }),
    logPostDerive: (details) => logs.push(details)
  });
  assert.deepEqual(logs, [{
    site: "sidecar",
    basePath: "/worktree",
    canonicalProjectRoot: "/project",
    derivedPhase: "planning",
    activeUnit: "T01"
  }]);
});
test("buildSidecarIterationData handles missing active milestone", async () => {
  const iterData = await buildSidecarIterationData({
    sidecarItem: makeSidecarItem(),
    basePath: "/worktree",
    canonicalProjectRoot: "/project",
    deriveState: async () => ({ phase: "blocked" }),
    logPostDerive: () => {
    }
  });
  assert.equal(iterData.mid, void 0);
  assert.equal(iterData.midTitle, void 0);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy93b3JrZmxvdy1zaWRlY2FyLWl0ZXJhdGlvbi50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBQcm9qZWN0L0FwcDogR1NELTJcbi8vIEZpbGUgUHVycG9zZTogVW5pdCB0ZXN0cyBmb3IgYXV0by1tb2RlIHNpZGVjYXIgaXRlcmF0aW9uLWRhdGEgYWRhcHRlci5cblxuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5cbmltcG9ydCB0eXBlIHsgR1NEU3RhdGUgfSBmcm9tIFwiLi4vdHlwZXMudHNcIjtcbmltcG9ydCB0eXBlIHsgU2lkZWNhckl0ZW0gfSBmcm9tIFwiLi4vYXV0by9zZXNzaW9uLnRzXCI7XG5pbXBvcnQgeyBidWlsZFNpZGVjYXJJdGVyYXRpb25EYXRhIH0gZnJvbSBcIi4uL2F1dG8vd29ya2Zsb3ctc2lkZWNhci1pdGVyYXRpb24udHNcIjtcblxuZnVuY3Rpb24gbWFrZVNpZGVjYXJJdGVtKG92ZXJyaWRlcz86IFBhcnRpYWw8U2lkZWNhckl0ZW0+KTogU2lkZWNhckl0ZW0ge1xuICByZXR1cm4ge1xuICAgIGtpbmQ6IFwiaG9va1wiLFxuICAgIHVuaXRUeXBlOiBcInNpZGVjYXIvaG9va1wiLFxuICAgIHVuaXRJZDogXCJob29rLTFcIixcbiAgICBwcm9tcHQ6IFwiUnVuIGhvb2tcIixcbiAgICAuLi5vdmVycmlkZXMsXG4gIH07XG59XG5cbnRlc3QoXCJidWlsZFNpZGVjYXJJdGVyYXRpb25EYXRhIGRlcml2ZXMgc3RhdGUgZnJvbSBjYW5vbmljYWwgcHJvamVjdCByb290XCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3Qgcm9vdHM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHN0YXRlID0ge1xuICAgIHBoYXNlOiBcImV4ZWN1dGluZ1wiLFxuICAgIGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIk1pbGVzdG9uZSAxXCIgfSxcbiAgICBhY3RpdmVTbGljZTogeyBpZDogXCJTMDFcIiB9LFxuICAgIGFjdGl2ZVRhc2s6IHsgaWQ6IFwiVDAxXCIgfSxcbiAgfSBhcyBHU0RTdGF0ZTtcblxuICBhd2FpdCBidWlsZFNpZGVjYXJJdGVyYXRpb25EYXRhKHtcbiAgICBzaWRlY2FySXRlbTogbWFrZVNpZGVjYXJJdGVtKCksXG4gICAgYmFzZVBhdGg6IFwiL3dvcmt0cmVlXCIsXG4gICAgY2Fub25pY2FsUHJvamVjdFJvb3Q6IFwiL3Byb2plY3RcIixcbiAgICBkZXJpdmVTdGF0ZTogYXN5bmMgcm9vdCA9PiB7XG4gICAgICByb290cy5wdXNoKHJvb3QpO1xuICAgICAgcmV0dXJuIHN0YXRlO1xuICAgIH0sXG4gICAgbG9nUG9zdERlcml2ZTogKCkgPT4ge30sXG4gIH0pO1xuXG4gIGFzc2VydC5kZWVwRXF1YWwocm9vdHMsIFtcIi9wcm9qZWN0XCJdKTtcbn0pO1xuXG50ZXN0KFwiYnVpbGRTaWRlY2FySXRlcmF0aW9uRGF0YSBtYXBzIHNpZGVjYXIgaXRlbSBhbmQgbWlsZXN0b25lIHN0YXRlIGludG8gaXRlcmF0aW9uIGRhdGFcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBzdGF0ZSA9IHtcbiAgICBwaGFzZTogXCJleGVjdXRpbmdcIixcbiAgICBhY3RpdmVNaWxlc3RvbmU6IHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJNaWxlc3RvbmUgMVwiIH0sXG4gIH0gYXMgR1NEU3RhdGU7XG5cbiAgY29uc3QgaXRlckRhdGEgPSBhd2FpdCBidWlsZFNpZGVjYXJJdGVyYXRpb25EYXRhKHtcbiAgICBzaWRlY2FySXRlbTogbWFrZVNpZGVjYXJJdGVtKHtcbiAgICAgIHVuaXRUeXBlOiBcInNpZGVjYXIvcXVpY2stdGFza1wiLFxuICAgICAgdW5pdElkOiBcImNhcHR1cmUtMVwiLFxuICAgICAgcHJvbXB0OiBcIkRvIGNhcHR1cmVkIHRhc2tcIixcbiAgICB9KSxcbiAgICBiYXNlUGF0aDogXCIvd29ya3RyZWVcIixcbiAgICBjYW5vbmljYWxQcm9qZWN0Um9vdDogXCIvcHJvamVjdFwiLFxuICAgIGRlcml2ZVN0YXRlOiBhc3luYyAoKSA9PiBzdGF0ZSxcbiAgICBsb2dQb3N0RGVyaXZlOiAoKSA9PiB7fSxcbiAgfSk7XG5cbiAgYXNzZXJ0LmVxdWFsKGl0ZXJEYXRhLnVuaXRUeXBlLCBcInNpZGVjYXIvcXVpY2stdGFza1wiKTtcbiAgYXNzZXJ0LmVxdWFsKGl0ZXJEYXRhLnVuaXRJZCwgXCJjYXB0dXJlLTFcIik7XG4gIGFzc2VydC5lcXVhbChpdGVyRGF0YS5wcm9tcHQsIFwiRG8gY2FwdHVyZWQgdGFza1wiKTtcbiAgYXNzZXJ0LmVxdWFsKGl0ZXJEYXRhLmZpbmFsUHJvbXB0LCBcIkRvIGNhcHR1cmVkIHRhc2tcIik7XG4gIGFzc2VydC5lcXVhbChpdGVyRGF0YS5wYXVzZUFmdGVyVWF0RGlzcGF0Y2gsIGZhbHNlKTtcbiAgYXNzZXJ0LmVxdWFsKGl0ZXJEYXRhLnN0YXRlLCBzdGF0ZSk7XG4gIGFzc2VydC5lcXVhbChpdGVyRGF0YS5taWQsIFwiTTAwMVwiKTtcbiAgYXNzZXJ0LmVxdWFsKGl0ZXJEYXRhLm1pZFRpdGxlLCBcIk1pbGVzdG9uZSAxXCIpO1xuICBhc3NlcnQuZXF1YWwoaXRlckRhdGEuaXNSZXRyeSwgZmFsc2UpO1xuICBhc3NlcnQuZXF1YWwoaXRlckRhdGEucHJldmlvdXNUaWVyLCB1bmRlZmluZWQpO1xufSk7XG5cbnRlc3QoXCJidWlsZFNpZGVjYXJJdGVyYXRpb25EYXRhIGxvZ3MgdGFzaywgc2xpY2UsIG9yIG1pbGVzdG9uZSBhY3RpdmUgdW5pdFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGxvZ3M6IHVua25vd25bXSA9IFtdO1xuXG4gIGF3YWl0IGJ1aWxkU2lkZWNhckl0ZXJhdGlvbkRhdGEoe1xuICAgIHNpZGVjYXJJdGVtOiBtYWtlU2lkZWNhckl0ZW0oKSxcbiAgICBiYXNlUGF0aDogXCIvd29ya3RyZWVcIixcbiAgICBjYW5vbmljYWxQcm9qZWN0Um9vdDogXCIvcHJvamVjdFwiLFxuICAgIGRlcml2ZVN0YXRlOiBhc3luYyAoKSA9PiAoe1xuICAgICAgcGhhc2U6IFwicGxhbm5pbmdcIixcbiAgICAgIGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIk1pbGVzdG9uZSAxXCIgfSxcbiAgICAgIGFjdGl2ZVNsaWNlOiB7IGlkOiBcIlMwMVwiIH0sXG4gICAgICBhY3RpdmVUYXNrOiB7IGlkOiBcIlQwMVwiIH0sXG4gICAgfSkgYXMgR1NEU3RhdGUsXG4gICAgbG9nUG9zdERlcml2ZTogZGV0YWlscyA9PiBsb2dzLnB1c2goZGV0YWlscyksXG4gIH0pO1xuXG4gIGFzc2VydC5kZWVwRXF1YWwobG9ncywgW3tcbiAgICBzaXRlOiBcInNpZGVjYXJcIixcbiAgICBiYXNlUGF0aDogXCIvd29ya3RyZWVcIixcbiAgICBjYW5vbmljYWxQcm9qZWN0Um9vdDogXCIvcHJvamVjdFwiLFxuICAgIGRlcml2ZWRQaGFzZTogXCJwbGFubmluZ1wiLFxuICAgIGFjdGl2ZVVuaXQ6IFwiVDAxXCIsXG4gIH1dKTtcbn0pO1xuXG50ZXN0KFwiYnVpbGRTaWRlY2FySXRlcmF0aW9uRGF0YSBoYW5kbGVzIG1pc3NpbmcgYWN0aXZlIG1pbGVzdG9uZVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGl0ZXJEYXRhID0gYXdhaXQgYnVpbGRTaWRlY2FySXRlcmF0aW9uRGF0YSh7XG4gICAgc2lkZWNhckl0ZW06IG1ha2VTaWRlY2FySXRlbSgpLFxuICAgIGJhc2VQYXRoOiBcIi93b3JrdHJlZVwiLFxuICAgIGNhbm9uaWNhbFByb2plY3RSb290OiBcIi9wcm9qZWN0XCIsXG4gICAgZGVyaXZlU3RhdGU6IGFzeW5jICgpID0+ICh7IHBoYXNlOiBcImJsb2NrZWRcIiB9KSBhcyBHU0RTdGF0ZSxcbiAgICBsb2dQb3N0RGVyaXZlOiAoKSA9PiB7fSxcbiAgfSk7XG5cbiAgYXNzZXJ0LmVxdWFsKGl0ZXJEYXRhLm1pZCwgdW5kZWZpbmVkKTtcbiAgYXNzZXJ0LmVxdWFsKGl0ZXJEYXRhLm1pZFRpdGxlLCB1bmRlZmluZWQpO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFHQSxPQUFPLFlBQVk7QUFDbkIsT0FBTyxVQUFVO0FBSWpCLFNBQVMsaUNBQWlDO0FBRTFDLFNBQVMsZ0JBQWdCLFdBQStDO0FBQ3RFLFNBQU87QUFBQSxJQUNMLE1BQU07QUFBQSxJQUNOLFVBQVU7QUFBQSxJQUNWLFFBQVE7QUFBQSxJQUNSLFFBQVE7QUFBQSxJQUNSLEdBQUc7QUFBQSxFQUNMO0FBQ0Y7QUFFQSxLQUFLLHVFQUF1RSxZQUFZO0FBQ3RGLFFBQU0sUUFBa0IsQ0FBQztBQUN6QixRQUFNLFFBQVE7QUFBQSxJQUNaLE9BQU87QUFBQSxJQUNQLGlCQUFpQixFQUFFLElBQUksUUFBUSxPQUFPLGNBQWM7QUFBQSxJQUNwRCxhQUFhLEVBQUUsSUFBSSxNQUFNO0FBQUEsSUFDekIsWUFBWSxFQUFFLElBQUksTUFBTTtBQUFBLEVBQzFCO0FBRUEsUUFBTSwwQkFBMEI7QUFBQSxJQUM5QixhQUFhLGdCQUFnQjtBQUFBLElBQzdCLFVBQVU7QUFBQSxJQUNWLHNCQUFzQjtBQUFBLElBQ3RCLGFBQWEsT0FBTSxTQUFRO0FBQ3pCLFlBQU0sS0FBSyxJQUFJO0FBQ2YsYUFBTztBQUFBLElBQ1Q7QUFBQSxJQUNBLGVBQWUsTUFBTTtBQUFBLElBQUM7QUFBQSxFQUN4QixDQUFDO0FBRUQsU0FBTyxVQUFVLE9BQU8sQ0FBQyxVQUFVLENBQUM7QUFDdEMsQ0FBQztBQUVELEtBQUssdUZBQXVGLFlBQVk7QUFDdEcsUUFBTSxRQUFRO0FBQUEsSUFDWixPQUFPO0FBQUEsSUFDUCxpQkFBaUIsRUFBRSxJQUFJLFFBQVEsT0FBTyxjQUFjO0FBQUEsRUFDdEQ7QUFFQSxRQUFNLFdBQVcsTUFBTSwwQkFBMEI7QUFBQSxJQUMvQyxhQUFhLGdCQUFnQjtBQUFBLE1BQzNCLFVBQVU7QUFBQSxNQUNWLFFBQVE7QUFBQSxNQUNSLFFBQVE7QUFBQSxJQUNWLENBQUM7QUFBQSxJQUNELFVBQVU7QUFBQSxJQUNWLHNCQUFzQjtBQUFBLElBQ3RCLGFBQWEsWUFBWTtBQUFBLElBQ3pCLGVBQWUsTUFBTTtBQUFBLElBQUM7QUFBQSxFQUN4QixDQUFDO0FBRUQsU0FBTyxNQUFNLFNBQVMsVUFBVSxvQkFBb0I7QUFDcEQsU0FBTyxNQUFNLFNBQVMsUUFBUSxXQUFXO0FBQ3pDLFNBQU8sTUFBTSxTQUFTLFFBQVEsa0JBQWtCO0FBQ2hELFNBQU8sTUFBTSxTQUFTLGFBQWEsa0JBQWtCO0FBQ3JELFNBQU8sTUFBTSxTQUFTLHVCQUF1QixLQUFLO0FBQ2xELFNBQU8sTUFBTSxTQUFTLE9BQU8sS0FBSztBQUNsQyxTQUFPLE1BQU0sU0FBUyxLQUFLLE1BQU07QUFDakMsU0FBTyxNQUFNLFNBQVMsVUFBVSxhQUFhO0FBQzdDLFNBQU8sTUFBTSxTQUFTLFNBQVMsS0FBSztBQUNwQyxTQUFPLE1BQU0sU0FBUyxjQUFjLE1BQVM7QUFDL0MsQ0FBQztBQUVELEtBQUssd0VBQXdFLFlBQVk7QUFDdkYsUUFBTSxPQUFrQixDQUFDO0FBRXpCLFFBQU0sMEJBQTBCO0FBQUEsSUFDOUIsYUFBYSxnQkFBZ0I7QUFBQSxJQUM3QixVQUFVO0FBQUEsSUFDVixzQkFBc0I7QUFBQSxJQUN0QixhQUFhLGFBQWE7QUFBQSxNQUN4QixPQUFPO0FBQUEsTUFDUCxpQkFBaUIsRUFBRSxJQUFJLFFBQVEsT0FBTyxjQUFjO0FBQUEsTUFDcEQsYUFBYSxFQUFFLElBQUksTUFBTTtBQUFBLE1BQ3pCLFlBQVksRUFBRSxJQUFJLE1BQU07QUFBQSxJQUMxQjtBQUFBLElBQ0EsZUFBZSxhQUFXLEtBQUssS0FBSyxPQUFPO0FBQUEsRUFDN0MsQ0FBQztBQUVELFNBQU8sVUFBVSxNQUFNLENBQUM7QUFBQSxJQUN0QixNQUFNO0FBQUEsSUFDTixVQUFVO0FBQUEsSUFDVixzQkFBc0I7QUFBQSxJQUN0QixjQUFjO0FBQUEsSUFDZCxZQUFZO0FBQUEsRUFDZCxDQUFDLENBQUM7QUFDSixDQUFDO0FBRUQsS0FBSyw4REFBOEQsWUFBWTtBQUM3RSxRQUFNLFdBQVcsTUFBTSwwQkFBMEI7QUFBQSxJQUMvQyxhQUFhLGdCQUFnQjtBQUFBLElBQzdCLFVBQVU7QUFBQSxJQUNWLHNCQUFzQjtBQUFBLElBQ3RCLGFBQWEsYUFBYSxFQUFFLE9BQU8sVUFBVTtBQUFBLElBQzdDLGVBQWUsTUFBTTtBQUFBLElBQUM7QUFBQSxFQUN4QixDQUFDO0FBRUQsU0FBTyxNQUFNLFNBQVMsS0FBSyxNQUFTO0FBQ3BDLFNBQU8sTUFBTSxTQUFTLFVBQVUsTUFBUztBQUMzQyxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
