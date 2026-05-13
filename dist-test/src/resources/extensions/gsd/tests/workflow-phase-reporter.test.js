import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowPhaseReporter } from "../auto/workflow-phase-reporter.js";
test("workflow phase reporter forwards phase results to observer", () => {
  const phases = [];
  const reporter = createWorkflowPhaseReporter({
    observer: {
      onTurnStart: () => {
      },
      onPhaseResult: (phase, action, data) => phases.push({ phase, action, data }),
      onTurnResult: () => {
      }
    }
  });
  reporter.report("dispatch", "sidecar", {
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    sidecarKind: "quick-task"
  });
  assert.deepEqual(phases, [{
    phase: "dispatch",
    action: "sidecar",
    data: {
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      sidecarKind: "quick-task"
    }
  }]);
});
test("workflow phase reporter tolerates missing observer", () => {
  const reporter = createWorkflowPhaseReporter({});
  assert.doesNotThrow(() => reporter.report("finalize", "next"));
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy93b3JrZmxvdy1waGFzZS1yZXBvcnRlci50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBQcm9qZWN0L0FwcDogR1NELTJcbi8vIEZpbGUgUHVycG9zZTogVW5pdCB0ZXN0cyBmb3Igd29ya2Zsb3cgcGhhc2UtcmVzdWx0IHJlcG9ydGluZyBhZGFwdGVyLlxuXG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcblxuaW1wb3J0IHsgY3JlYXRlV29ya2Zsb3dQaGFzZVJlcG9ydGVyIH0gZnJvbSBcIi4uL2F1dG8vd29ya2Zsb3ctcGhhc2UtcmVwb3J0ZXIudHNcIjtcblxudGVzdChcIndvcmtmbG93IHBoYXNlIHJlcG9ydGVyIGZvcndhcmRzIHBoYXNlIHJlc3VsdHMgdG8gb2JzZXJ2ZXJcIiwgKCkgPT4ge1xuICBjb25zdCBwaGFzZXM6IHVua25vd25bXSA9IFtdO1xuICBjb25zdCByZXBvcnRlciA9IGNyZWF0ZVdvcmtmbG93UGhhc2VSZXBvcnRlcih7XG4gICAgb2JzZXJ2ZXI6IHtcbiAgICAgIG9uVHVyblN0YXJ0OiAoKSA9PiB7fSxcbiAgICAgIG9uUGhhc2VSZXN1bHQ6IChwaGFzZSwgYWN0aW9uLCBkYXRhKSA9PiBwaGFzZXMucHVzaCh7IHBoYXNlLCBhY3Rpb24sIGRhdGEgfSksXG4gICAgICBvblR1cm5SZXN1bHQ6ICgpID0+IHt9LFxuICAgIH0sXG4gIH0pO1xuXG4gIHJlcG9ydGVyLnJlcG9ydChcImRpc3BhdGNoXCIsIFwic2lkZWNhclwiLCB7XG4gICAgdW5pdFR5cGU6IFwiZXhlY3V0ZS10YXNrXCIsXG4gICAgdW5pdElkOiBcIk0wMDEvUzAxL1QwMVwiLFxuICAgIHNpZGVjYXJLaW5kOiBcInF1aWNrLXRhc2tcIixcbiAgfSk7XG5cbiAgYXNzZXJ0LmRlZXBFcXVhbChwaGFzZXMsIFt7XG4gICAgcGhhc2U6IFwiZGlzcGF0Y2hcIixcbiAgICBhY3Rpb246IFwic2lkZWNhclwiLFxuICAgIGRhdGE6IHtcbiAgICAgIHVuaXRUeXBlOiBcImV4ZWN1dGUtdGFza1wiLFxuICAgICAgdW5pdElkOiBcIk0wMDEvUzAxL1QwMVwiLFxuICAgICAgc2lkZWNhcktpbmQ6IFwicXVpY2stdGFza1wiLFxuICAgIH0sXG4gIH1dKTtcbn0pO1xuXG50ZXN0KFwid29ya2Zsb3cgcGhhc2UgcmVwb3J0ZXIgdG9sZXJhdGVzIG1pc3Npbmcgb2JzZXJ2ZXJcIiwgKCkgPT4ge1xuICBjb25zdCByZXBvcnRlciA9IGNyZWF0ZVdvcmtmbG93UGhhc2VSZXBvcnRlcih7fSk7XG5cbiAgYXNzZXJ0LmRvZXNOb3RUaHJvdygoKSA9PiByZXBvcnRlci5yZXBvcnQoXCJmaW5hbGl6ZVwiLCBcIm5leHRcIikpO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFHQSxPQUFPLFlBQVk7QUFDbkIsT0FBTyxVQUFVO0FBRWpCLFNBQVMsbUNBQW1DO0FBRTVDLEtBQUssOERBQThELE1BQU07QUFDdkUsUUFBTSxTQUFvQixDQUFDO0FBQzNCLFFBQU0sV0FBVyw0QkFBNEI7QUFBQSxJQUMzQyxVQUFVO0FBQUEsTUFDUixhQUFhLE1BQU07QUFBQSxNQUFDO0FBQUEsTUFDcEIsZUFBZSxDQUFDLE9BQU8sUUFBUSxTQUFTLE9BQU8sS0FBSyxFQUFFLE9BQU8sUUFBUSxLQUFLLENBQUM7QUFBQSxNQUMzRSxjQUFjLE1BQU07QUFBQSxNQUFDO0FBQUEsSUFDdkI7QUFBQSxFQUNGLENBQUM7QUFFRCxXQUFTLE9BQU8sWUFBWSxXQUFXO0FBQUEsSUFDckMsVUFBVTtBQUFBLElBQ1YsUUFBUTtBQUFBLElBQ1IsYUFBYTtBQUFBLEVBQ2YsQ0FBQztBQUVELFNBQU8sVUFBVSxRQUFRLENBQUM7QUFBQSxJQUN4QixPQUFPO0FBQUEsSUFDUCxRQUFRO0FBQUEsSUFDUixNQUFNO0FBQUEsTUFDSixVQUFVO0FBQUEsTUFDVixRQUFRO0FBQUEsTUFDUixhQUFhO0FBQUEsSUFDZjtBQUFBLEVBQ0YsQ0FBQyxDQUFDO0FBQ0osQ0FBQztBQUVELEtBQUssc0RBQXNELE1BQU07QUFDL0QsUUFBTSxXQUFXLDRCQUE0QixDQUFDLENBQUM7QUFFL0MsU0FBTyxhQUFhLE1BQU0sU0FBUyxPQUFPLFlBQVksTUFBTSxDQUFDO0FBQy9ELENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
