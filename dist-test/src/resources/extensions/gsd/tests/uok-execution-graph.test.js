import test from "node:test";
import assert from "node:assert/strict";
import {
  selectConflictFreeBatch,
  selectReactiveDispatchBatch,
  buildSidecarQueueNodes,
  buildExecutionGraphSnapshot,
  scheduleSidecarQueue
} from "../uok/execution-graph.js";
test("uok execution graph selects deterministic conflict-free IDs", () => {
  const selected = selectConflictFreeBatch({
    orderedIds: ["S01", "S02", "S03", "S04"],
    maxParallel: 4,
    hasConflict: (candidate, existing) => candidate === "S02" && existing === "S01" || candidate === "S01" && existing === "S02"
  });
  assert.deepEqual(selected, ["S01", "S03", "S04"]);
});
test("uok execution graph reactive batch honors file conflicts and in-flight writes", () => {
  const result = selectReactiveDispatchBatch({
    graph: [
      { id: "T01", dependsOn: [], outputFiles: ["src/a.ts"] },
      { id: "T02", dependsOn: [], outputFiles: ["src/a.ts"] },
      { id: "T03", dependsOn: [], outputFiles: ["src/b.ts"] },
      { id: "T04", dependsOn: ["T03"], outputFiles: ["src/c.ts"] }
    ],
    readyIds: ["T01", "T02", "T03", "T04"],
    maxParallel: 3,
    inFlightOutputs: /* @__PURE__ */ new Set(["src/c.ts"])
  });
  assert.deepEqual(result.selected, ["T01", "T03"]);
  assert.ok(
    result.conflicts.some((c) => c.nodeA === "T01" && c.nodeB === "T02" && c.file === "src/a.ts"),
    "conflict list should include overlapping outputs"
  );
});
test("uok execution graph sidecar nodes map queue kinds to supported DAG kinds", () => {
  const queue = [
    { kind: "hook", unitType: "execute-task", unitId: "M001/S01/T01", prompt: "hook" },
    { kind: "triage", unitType: "triage", unitId: "M001/S01", prompt: "triage" },
    { kind: "quick-task", unitType: "quick-task", unitId: "M001/S01/Q01", prompt: "quick" }
  ];
  const nodes = buildSidecarQueueNodes(queue);
  assert.equal(nodes[0]?.kind, "hook");
  assert.equal(nodes[1]?.kind, "verification");
  assert.equal(nodes[2]?.kind, "team-worker");
  assert.equal(nodes[1]?.dependsOn.length, 1);
});
test("uok execution graph sidecar scheduler preserves deterministic queue order", async () => {
  const queue = [
    { kind: "quick-task", unitType: "quick-task", unitId: "M001/S01/Q01", prompt: "q1" },
    { kind: "hook", unitType: "hook", unitId: "M001/S01/H01", prompt: "h1" },
    { kind: "triage", unitType: "triage", unitId: "M001/S01/TR1", prompt: "t1" }
  ];
  const scheduled = await scheduleSidecarQueue(queue);
  assert.deepEqual(
    scheduled.map((item) => item.unitId),
    queue.map((item) => item.unitId)
  );
});
test("uok execution graph snapshot captures deterministic order and conflicts", () => {
  const snapshot = buildExecutionGraphSnapshot(
    [
      { id: "b", kind: "unit", dependsOn: ["a"], writes: ["src/shared.ts"] },
      { id: "a", kind: "unit", dependsOn: [], writes: ["src/a.ts"] },
      { id: "c", kind: "verification", dependsOn: [], writes: ["src/shared.ts"] }
    ],
    "before-unit"
  );
  assert.equal(snapshot.phase, "before-unit");
  assert.deepEqual(snapshot.order, ["a", "b", "c"]);
  assert.ok(snapshot.conflicts.some((c) => c.file === "src/shared.ts"));
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy91b2stZXhlY3V0aW9uLWdyYXBoLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHR5cGUgeyBTaWRlY2FySXRlbSB9IGZyb20gXCIuLi9hdXRvL3Nlc3Npb24udHNcIjtcbmltcG9ydCB7XG4gIHNlbGVjdENvbmZsaWN0RnJlZUJhdGNoLFxuICBzZWxlY3RSZWFjdGl2ZURpc3BhdGNoQmF0Y2gsXG4gIGJ1aWxkU2lkZWNhclF1ZXVlTm9kZXMsXG4gIGJ1aWxkRXhlY3V0aW9uR3JhcGhTbmFwc2hvdCxcbiAgc2NoZWR1bGVTaWRlY2FyUXVldWUsXG59IGZyb20gXCIuLi91b2svZXhlY3V0aW9uLWdyYXBoLnRzXCI7XG5cbnRlc3QoXCJ1b2sgZXhlY3V0aW9uIGdyYXBoIHNlbGVjdHMgZGV0ZXJtaW5pc3RpYyBjb25mbGljdC1mcmVlIElEc1wiLCAoKSA9PiB7XG4gIGNvbnN0IHNlbGVjdGVkID0gc2VsZWN0Q29uZmxpY3RGcmVlQmF0Y2goe1xuICAgIG9yZGVyZWRJZHM6IFtcIlMwMVwiLCBcIlMwMlwiLCBcIlMwM1wiLCBcIlMwNFwiXSxcbiAgICBtYXhQYXJhbGxlbDogNCxcbiAgICBoYXNDb25mbGljdDogKGNhbmRpZGF0ZSwgZXhpc3RpbmcpID0+XG4gICAgICAoY2FuZGlkYXRlID09PSBcIlMwMlwiICYmIGV4aXN0aW5nID09PSBcIlMwMVwiKSB8fFxuICAgICAgKGNhbmRpZGF0ZSA9PT0gXCJTMDFcIiAmJiBleGlzdGluZyA9PT0gXCJTMDJcIiksXG4gIH0pO1xuXG4gIGFzc2VydC5kZWVwRXF1YWwoc2VsZWN0ZWQsIFtcIlMwMVwiLCBcIlMwM1wiLCBcIlMwNFwiXSk7XG59KTtcblxudGVzdChcInVvayBleGVjdXRpb24gZ3JhcGggcmVhY3RpdmUgYmF0Y2ggaG9ub3JzIGZpbGUgY29uZmxpY3RzIGFuZCBpbi1mbGlnaHQgd3JpdGVzXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gc2VsZWN0UmVhY3RpdmVEaXNwYXRjaEJhdGNoKHtcbiAgICBncmFwaDogW1xuICAgICAgeyBpZDogXCJUMDFcIiwgZGVwZW5kc09uOiBbXSwgb3V0cHV0RmlsZXM6IFtcInNyYy9hLnRzXCJdIH0sXG4gICAgICB7IGlkOiBcIlQwMlwiLCBkZXBlbmRzT246IFtdLCBvdXRwdXRGaWxlczogW1wic3JjL2EudHNcIl0gfSxcbiAgICAgIHsgaWQ6IFwiVDAzXCIsIGRlcGVuZHNPbjogW10sIG91dHB1dEZpbGVzOiBbXCJzcmMvYi50c1wiXSB9LFxuICAgICAgeyBpZDogXCJUMDRcIiwgZGVwZW5kc09uOiBbXCJUMDNcIl0sIG91dHB1dEZpbGVzOiBbXCJzcmMvYy50c1wiXSB9LFxuICAgIF0sXG4gICAgcmVhZHlJZHM6IFtcIlQwMVwiLCBcIlQwMlwiLCBcIlQwM1wiLCBcIlQwNFwiXSxcbiAgICBtYXhQYXJhbGxlbDogMyxcbiAgICBpbkZsaWdodE91dHB1dHM6IG5ldyBTZXQoW1wic3JjL2MudHNcIl0pLFxuICB9KTtcblxuICBhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdC5zZWxlY3RlZCwgW1wiVDAxXCIsIFwiVDAzXCJdKTtcbiAgYXNzZXJ0Lm9rKFxuICAgIHJlc3VsdC5jb25mbGljdHMuc29tZSgoYykgPT4gYy5ub2RlQSA9PT0gXCJUMDFcIiAmJiBjLm5vZGVCID09PSBcIlQwMlwiICYmIGMuZmlsZSA9PT0gXCJzcmMvYS50c1wiKSxcbiAgICBcImNvbmZsaWN0IGxpc3Qgc2hvdWxkIGluY2x1ZGUgb3ZlcmxhcHBpbmcgb3V0cHV0c1wiLFxuICApO1xufSk7XG5cbnRlc3QoXCJ1b2sgZXhlY3V0aW9uIGdyYXBoIHNpZGVjYXIgbm9kZXMgbWFwIHF1ZXVlIGtpbmRzIHRvIHN1cHBvcnRlZCBEQUcga2luZHNcIiwgKCkgPT4ge1xuICBjb25zdCBxdWV1ZTogU2lkZWNhckl0ZW1bXSA9IFtcbiAgICB7IGtpbmQ6IFwiaG9va1wiLCB1bml0VHlwZTogXCJleGVjdXRlLXRhc2tcIiwgdW5pdElkOiBcIk0wMDEvUzAxL1QwMVwiLCBwcm9tcHQ6IFwiaG9va1wiIH0sXG4gICAgeyBraW5kOiBcInRyaWFnZVwiLCB1bml0VHlwZTogXCJ0cmlhZ2VcIiwgdW5pdElkOiBcIk0wMDEvUzAxXCIsIHByb21wdDogXCJ0cmlhZ2VcIiB9LFxuICAgIHsga2luZDogXCJxdWljay10YXNrXCIsIHVuaXRUeXBlOiBcInF1aWNrLXRhc2tcIiwgdW5pdElkOiBcIk0wMDEvUzAxL1EwMVwiLCBwcm9tcHQ6IFwicXVpY2tcIiB9LFxuICBdO1xuXG4gIGNvbnN0IG5vZGVzID0gYnVpbGRTaWRlY2FyUXVldWVOb2RlcyhxdWV1ZSk7XG4gIGFzc2VydC5lcXVhbChub2Rlc1swXT8ua2luZCwgXCJob29rXCIpO1xuICBhc3NlcnQuZXF1YWwobm9kZXNbMV0/LmtpbmQsIFwidmVyaWZpY2F0aW9uXCIpO1xuICBhc3NlcnQuZXF1YWwobm9kZXNbMl0/LmtpbmQsIFwidGVhbS13b3JrZXJcIik7XG4gIGFzc2VydC5lcXVhbChub2Rlc1sxXT8uZGVwZW5kc09uLmxlbmd0aCwgMSk7XG59KTtcblxudGVzdChcInVvayBleGVjdXRpb24gZ3JhcGggc2lkZWNhciBzY2hlZHVsZXIgcHJlc2VydmVzIGRldGVybWluaXN0aWMgcXVldWUgb3JkZXJcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBxdWV1ZTogU2lkZWNhckl0ZW1bXSA9IFtcbiAgICB7IGtpbmQ6IFwicXVpY2stdGFza1wiLCB1bml0VHlwZTogXCJxdWljay10YXNrXCIsIHVuaXRJZDogXCJNMDAxL1MwMS9RMDFcIiwgcHJvbXB0OiBcInExXCIgfSxcbiAgICB7IGtpbmQ6IFwiaG9va1wiLCB1bml0VHlwZTogXCJob29rXCIsIHVuaXRJZDogXCJNMDAxL1MwMS9IMDFcIiwgcHJvbXB0OiBcImgxXCIgfSxcbiAgICB7IGtpbmQ6IFwidHJpYWdlXCIsIHVuaXRUeXBlOiBcInRyaWFnZVwiLCB1bml0SWQ6IFwiTTAwMS9TMDEvVFIxXCIsIHByb21wdDogXCJ0MVwiIH0sXG4gIF07XG5cbiAgY29uc3Qgc2NoZWR1bGVkID0gYXdhaXQgc2NoZWR1bGVTaWRlY2FyUXVldWUocXVldWUpO1xuICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgIHNjaGVkdWxlZC5tYXAoKGl0ZW0pID0+IGl0ZW0udW5pdElkKSxcbiAgICBxdWV1ZS5tYXAoKGl0ZW0pID0+IGl0ZW0udW5pdElkKSxcbiAgKTtcbn0pO1xuXG50ZXN0KFwidW9rIGV4ZWN1dGlvbiBncmFwaCBzbmFwc2hvdCBjYXB0dXJlcyBkZXRlcm1pbmlzdGljIG9yZGVyIGFuZCBjb25mbGljdHNcIiwgKCkgPT4ge1xuICBjb25zdCBzbmFwc2hvdCA9IGJ1aWxkRXhlY3V0aW9uR3JhcGhTbmFwc2hvdChcbiAgICBbXG4gICAgICB7IGlkOiBcImJcIiwga2luZDogXCJ1bml0XCIsIGRlcGVuZHNPbjogW1wiYVwiXSwgd3JpdGVzOiBbXCJzcmMvc2hhcmVkLnRzXCJdIH0sXG4gICAgICB7IGlkOiBcImFcIiwga2luZDogXCJ1bml0XCIsIGRlcGVuZHNPbjogW10sIHdyaXRlczogW1wic3JjL2EudHNcIl0gfSxcbiAgICAgIHsgaWQ6IFwiY1wiLCBraW5kOiBcInZlcmlmaWNhdGlvblwiLCBkZXBlbmRzT246IFtdLCB3cml0ZXM6IFtcInNyYy9zaGFyZWQudHNcIl0gfSxcbiAgICBdLFxuICAgIFwiYmVmb3JlLXVuaXRcIixcbiAgKTtcblxuICBhc3NlcnQuZXF1YWwoc25hcHNob3QucGhhc2UsIFwiYmVmb3JlLXVuaXRcIik7XG4gIGFzc2VydC5kZWVwRXF1YWwoc25hcHNob3Qub3JkZXIsIFtcImFcIiwgXCJiXCIsIFwiY1wiXSk7XG4gIGFzc2VydC5vayhzbmFwc2hvdC5jb25mbGljdHMuc29tZSgoYykgPT4gYy5maWxlID09PSBcInNyYy9z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
