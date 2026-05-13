import assert from "node:assert/strict";
import test from "node:test";
import {
  handleCustomEngineReconcileOutcome
} from "../auto/workflow-custom-engine-reconcile-outcome.js";
function makeDeps() {
  const calls = [];
  const deps = {
    stopAuto: async (reason) => {
      calls.push(["stopAuto", reason]);
    },
    pauseAuto: async () => {
      calls.push(["pauseAuto"]);
    },
    report: (action, details) => calls.push(["report", action, details]),
    finishTurn: (status, failureClass, error) => calls.push(["finishTurn", status, failureClass, error])
  };
  return { deps, calls };
}
test("handleCustomEngineReconcileOutcome stops completed workflow", async () => {
  const { deps, calls } = makeDeps();
  const flow = await handleCustomEngineReconcileOutcome({
    outcome: {
      decision: { action: "complete-workflow", stopReason: "Workflow complete" }
    },
    unitType: "execute-task",
    unitId: "T01",
    deps
  });
  assert.deepEqual(flow, { action: "break" });
  assert.deepEqual(calls, [
    ["stopAuto", "Workflow complete"],
    ["report", "milestone-complete", { unitType: "execute-task", unitId: "T01" }],
    ["finishTurn", "completed", void 0, void 0]
  ]);
});
test("handleCustomEngineReconcileOutcome pauses for manual attention", async () => {
  const { deps, calls } = makeDeps();
  const flow = await handleCustomEngineReconcileOutcome({
    outcome: {
      decision: { action: "pause" }
    },
    unitType: "verify-slice",
    unitId: "S01",
    deps
  });
  assert.deepEqual(flow, { action: "break" });
  assert.deepEqual(calls, [
    ["pauseAuto"],
    ["report", "pause", { unitType: "verify-slice", unitId: "S01" }],
    ["finishTurn", "paused", "manual-attention", void 0]
  ]);
});
test("handleCustomEngineReconcileOutcome stops with reconcile reason", async () => {
  const { deps, calls } = makeDeps();
  const flow = await handleCustomEngineReconcileOutcome({
    outcome: {
      decision: { action: "stop", reason: "blocked" },
      reason: "blocked"
    },
    unitType: "complete-slice",
    unitId: "S01",
    deps
  });
  assert.deepEqual(flow, { action: "break" });
  assert.deepEqual(calls, [
    ["stopAuto", "blocked"],
    ["report", "stop", { unitType: "complete-slice", unitId: "S01", reason: "blocked" }],
    ["finishTurn", "stopped", "manual-attention", "blocked"]
  ]);
});
test("handleCustomEngineReconcileOutcome continues after completed unit", async () => {
  const { deps, calls } = makeDeps();
  const flow = await handleCustomEngineReconcileOutcome({
    outcome: {
      decision: { action: "continue" }
    },
    unitType: "research-slice",
    unitId: "S01",
    deps
  });
  assert.deepEqual(flow, { action: "continue" });
  assert.deepEqual(calls, [
    ["report", "continue", { unitType: "research-slice", unitId: "S01" }],
    ["finishTurn", "completed", void 0, void 0]
  ]);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy93b3JrZmxvdy1jdXN0b20tZW5naW5lLXJlY29uY2lsZS1vdXRjb21lLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFByb2plY3QvQXBwOiBHU0QtMlxuLy8gRmlsZSBQdXJwb3NlOiBVbml0IHRlc3RzIGZvciBjdXN0b20tZW5naW5lIHJlY29uY2lsZSBvdXRjb21lIHNpZGUtZWZmZWN0IGFkYXB0ZXIuXG5cbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuXG5pbXBvcnQge1xuICBoYW5kbGVDdXN0b21FbmdpbmVSZWNvbmNpbGVPdXRjb21lLFxuICB0eXBlIEhhbmRsZUN1c3RvbUVuZ2luZVJlY29uY2lsZU91dGNvbWVEZXBzLFxufSBmcm9tIFwiLi4vYXV0by93b3JrZmxvdy1jdXN0b20tZW5naW5lLXJlY29uY2lsZS1vdXRjb21lLnRzXCI7XG5cbmZ1bmN0aW9uIG1ha2VEZXBzKCk6IHtcbiAgZGVwczogSGFuZGxlQ3VzdG9tRW5naW5lUmVjb25jaWxlT3V0Y29tZURlcHM7XG4gIGNhbGxzOiB1bmtub3duW107XG59IHtcbiAgY29uc3QgY2FsbHM6IHVua25vd25bXSA9IFtdO1xuICBjb25zdCBkZXBzOiBIYW5kbGVDdXN0b21FbmdpbmVSZWNvbmNpbGVPdXRjb21lRGVwcyA9IHtcbiAgICBzdG9wQXV0bzogYXN5bmMgcmVhc29uID0+IHtcbiAgICAgIGNhbGxzLnB1c2goW1wic3RvcEF1dG9cIiwgcmVhc29uXSk7XG4gICAgfSxcbiAgICBwYXVzZUF1dG86IGFzeW5jICgpID0+IHtcbiAgICAgIGNhbGxzLnB1c2goW1wicGF1c2VBdXRvXCJdKTtcbiAgICB9LFxuICAgIHJlcG9ydDogKGFjdGlvbiwgZGV0YWlscykgPT4gY2FsbHMucHVzaChbXCJyZXBvcnRcIiwgYWN0aW9uLCBkZXRhaWxzXSksXG4gICAgZmluaXNoVHVybjogKHN0YXR1cywgZmFpbHVyZUNsYXNzLCBlcnJvcikgPT4gY2FsbHMucHVzaChbXCJmaW5pc2hUdXJuXCIsIHN0YXR1cywgZmFpbHVyZUNsYXNzLCBlcnJvcl0pLFxuICB9O1xuICByZXR1cm4geyBkZXBzLCBjYWxscyB9O1xufVxuXG50ZXN0KFwiaGFuZGxlQ3VzdG9tRW5naW5lUmVjb25jaWxlT3V0Y29tZSBzdG9wcyBjb21wbGV0ZWQgd29ya2Zsb3dcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IGRlcHMsIGNhbGxzIH0gPSBtYWtlRGVwcygpO1xuXG4gIGNvbnN0IGZsb3cgPSBhd2FpdCBoYW5kbGVDdXN0b21FbmdpbmVSZWNvbmNpbGVPdXRjb21lKHtcbiAgICBvdXRjb21lOiB7XG4gICAgICBkZWNpc2lvbjogeyBhY3Rpb246IFwiY29tcGxldGUtd29ya2Zsb3dcIiwgc3RvcFJlYXNvbjogXCJXb3JrZmxvdyBjb21wbGV0ZVwiIH0sXG4gICAgfSxcbiAgICB1bml0VHlwZTogXCJleGVjdXRlLXRhc2tcIixcbiAgICB1bml0SWQ6IFwiVDAxXCIsXG4gICAgZGVwcyxcbiAgfSk7XG5cbiAgYXNzZXJ0LmRlZXBFcXVhbChmbG93LCB7IGFjdGlvbjogXCJicmVha1wiIH0pO1xuICBhc3NlcnQuZGVlcEVxdWFsKGNhbGxzLCBbXG4gICAgW1wic3RvcEF1dG9cIiwgXCJXb3JrZmxvdyBjb21wbGV0ZVwiXSxcbiAgICBbXCJyZXBvcnRcIiwgXCJtaWxlc3RvbmUtY29tcGxldGVcIiwgeyB1bml0VHlwZTogXCJleGVjdXRlLXRhc2tcIiwgdW5pdElkOiBcIlQwMVwiIH1dLFxuICAgIFtcImZpbmlzaFR1cm5cIiwgXCJjb21wbGV0ZWRcIiwgdW5kZWZpbmVkLCB1bmRlZmluZWRdLFxuICBdKTtcbn0pO1xuXG50ZXN0KFwiaGFuZGxlQ3VzdG9tRW5naW5lUmVjb25jaWxlT3V0Y29tZSBwYXVzZXMgZm9yIG1hbnVhbCBhdHRlbnRpb25cIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IGRlcHMsIGNhbGxzIH0gPSBtYWtlRGVwcygpO1xuXG4gIGNvbnN0IGZsb3cgPSBhd2FpdCBoYW5kbGVDdXN0b21FbmdpbmVSZWNvbmNpbGVPdXRjb21lKHtcbiAgICBvdXRjb21lOiB7XG4gICAgICBkZWNpc2lvbjogeyBhY3Rpb246IFwicGF1c2VcIiB9LFxuICAgIH0sXG4gICAgdW5pdFR5cGU6IFwidmVyaWZ5LXNsaWNlXCIsXG4gICAgdW5pdElkOiBcIlMwMVwiLFxuICAgIGRlcHMsXG4gIH0pO1xuXG4gIGFzc2VydC5kZWVwRXF1YWwoZmxvdywgeyBhY3Rpb246IFwiYnJlYWtcIiB9KTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChjYWxscywgW1xuICAgIFtcInBhdXNlQXV0b1wiXSxcbiAgICBbXCJyZXBvcnRcIiwgXCJwYXVzZVwiLCB7IHVuaXRUeXBlOiBcInZlcmlmeS1zbGljZVwiLCB1bml0SWQ6IFwiUzAxXCIgfV0sXG4gICAgW1wiZmluaXNoVHVyblwiLCBcInBhdXNlZFwiLCBcIm1hbnVhbC1hdHRlbnRpb25cIiwgdW5kZWZpbmVkXSxcbiAgXSk7XG59KTtcblxudGVzdChcImhhbmRsZUN1c3RvbUVuZ2luZVJlY29uY2lsZU91dGNvbWUgc3RvcHMgd2l0aCByZWNvbmNpbGUgcmVhc29uXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyBkZXBzLCBjYWxscyB9ID0gbWFrZURlcHMoKTtcblxuICBjb25zdCBmbG93ID0gYXdhaXQgaGFuZGxlQ3VzdG9tRW5naW5lUmVjb25jaWxlT3V0Y29tZSh7XG4gICAgb3V0Y29tZToge1xuICAgICAgZGVjaXNpb246IHsgYWN0aW9uOiBcInN0b3BcIiwgcmVhc29uOiBcImJsb2NrZWRcIiB9LFxuICAgICAgcmVhc29uOiBcImJsb2NrZWRcIixcbiAgICB9LFxuICAgIHVuaXRUeXBlOiBcImNvbXBsZXRlLXNsaWNlXCIsXG4gICAgdW5pdElkOiBcIlMwMVwiLFxuICAgIGRlcHMsXG4gIH0pO1xuXG4gIGFzc2VydC5kZWVwRXF1YWwoZmxvdywgeyBhY3Rpb246IFwiYnJlYWtcIiB9KTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChjYWxscywgW1xuICAgIFtcInN0b3BBdXRvXCIsIFwiYmxvY2tlZFwiXSxcbiAgICBbXCJyZXBvcnRcIiwgXCJzdG9wXCIsIHsgdW5pdFR5cGU6IFwiY29tcGxldGUtc2xpY2VcIiwgdW5pdElkOiBcIlMwMVwiLCByZWFzb246IFwiYmxvY2tlZFwiIH1dLFxuICAgIFtcImZpbmlzaFR1cm5cIiwgXCJzdG9wcGVkXCIsIFwibWFudWFsLWF0dGVudGlvblwiLCBcImJsb2NrZWRcIl0sXG4gIF0pO1xufSk7XG5cbnRlc3QoXCJoYW5kbGVDdXN0b21FbmdpbmVSZWNvbmNpbGVPdXRjb21lIGNvbnRpbnVlcyBhZnRlciBjb21wbGV0ZWQgdW5pdFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgZGVwcywgY2FsbHMgfSA9IG1ha2VEZXBzKCk7XG5cbiAgY29uc3QgZmxvdyA9IGF3YWl0IGhhbmRsZUN1c3RvbUVuZ2luZVJlY29uY2lsZU91dGNvbWUoe1xuICAgIG91dGNvbWU6IHtcbiAgICAgIGRlY2lzaW9uOiB7IGFjdGlvbjogXCJjb250aW51ZVwiIH0sXG4gICAgfSxcbiAgICB1bml0VHlwZTogXCJyZXNlYXJjaC1zbGljZVwiLFxuICAgIHVuaXRJZDogXCJTMDFcIixcbiAgICBkZXBzLFxuICB9KTtcblxuICBhc3NlcnQuZGVlcEVxdWFsKGZsb3csIHsgYWN0aW9uOiBcImNvbnRpbnVlXCIgfSk7XG4gIGFzc2VydC5kZWVwRXF1YWwoY2FsbHMsIFtcbiAgICBbXCJyZXBvcnRcIiwgXCJjb250aW51ZVwiLCB7IHVuaXRUeXBlOiBcInJlc2VhcmNoLXNsaWNlXCIsIHVuaXRJZDogXCJTMDFcIiB9XSxcbiAgICBbXCJmaW5pc2hUdXJuXCIsIFwiY29tcGxldGVkXCIsIHVuZGVmaW5lZCwgdW5kZWZpbmVkXSxcbiAgXSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6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
