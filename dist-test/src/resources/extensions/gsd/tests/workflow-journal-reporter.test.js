import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowJournalReporter } from "../auto/workflow-journal-reporter.js";
test("workflow journal reporter emits timestamped sequenced journal entries", () => {
  const entries = [];
  let seq = 0;
  const reporter = createWorkflowJournalReporter({
    emitJournalEvent: (entry) => entries.push(entry),
    flowId: "flow-1",
    nextSeq: () => {
      seq += 1;
      return seq;
    },
    now: () => "2026-05-04T00:00:00.000Z"
  });
  reporter.emit("iteration-start", { iteration: 1 });
  reporter.emit("unit-end", {
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    status: "blocked"
  });
  assert.deepEqual(entries, [
    {
      ts: "2026-05-04T00:00:00.000Z",
      flowId: "flow-1",
      seq: 1,
      eventType: "iteration-start",
      data: { iteration: 1 }
    },
    {
      ts: "2026-05-04T00:00:00.000Z",
      flowId: "flow-1",
      seq: 2,
      eventType: "unit-end",
      data: {
        unitType: "execute-task",
        unitId: "M001/S01/T01",
        status: "blocked"
      }
    }
  ]);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy93b3JrZmxvdy1qb3VybmFsLXJlcG9ydGVyLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFByb2plY3QvQXBwOiBHU0QtMlxuLy8gRmlsZSBQdXJwb3NlOiBVbml0IHRlc3RzIGZvciB3b3JrZmxvdyBqb3VybmFsIGV2ZW50IGVtaXNzaW9uIGFkYXB0ZXIuXG5cbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuXG5pbXBvcnQgeyBjcmVhdGVXb3JrZmxvd0pvdXJuYWxSZXBvcnRlciB9IGZyb20gXCIuLi9hdXRvL3dvcmtmbG93LWpvdXJuYWwtcmVwb3J0ZXIudHNcIjtcblxudGVzdChcIndvcmtmbG93IGpvdXJuYWwgcmVwb3J0ZXIgZW1pdHMgdGltZXN0YW1wZWQgc2VxdWVuY2VkIGpvdXJuYWwgZW50cmllc1wiLCAoKSA9PiB7XG4gIGNvbnN0IGVudHJpZXM6IHVua25vd25bXSA9IFtdO1xuICBsZXQgc2VxID0gMDtcbiAgY29uc3QgcmVwb3J0ZXIgPSBjcmVhdGVXb3JrZmxvd0pvdXJuYWxSZXBvcnRlcih7XG4gICAgZW1pdEpvdXJuYWxFdmVudDogZW50cnkgPT4gZW50cmllcy5wdXNoKGVudHJ5KSxcbiAgICBmbG93SWQ6IFwiZmxvdy0xXCIsXG4gICAgbmV4dFNlcTogKCkgPT4ge1xuICAgICAgc2VxICs9IDE7XG4gICAgICByZXR1cm4gc2VxO1xuICAgIH0sXG4gICAgbm93OiAoKSA9PiBcIjIwMjYtMDUtMDRUMDA6MDA6MDAuMDAwWlwiLFxuICB9KTtcblxuICByZXBvcnRlci5lbWl0KFwiaXRlcmF0aW9uLXN0YXJ0XCIsIHsgaXRlcmF0aW9uOiAxIH0pO1xuICByZXBvcnRlci5lbWl0KFwidW5pdC1lbmRcIiwge1xuICAgIHVuaXRUeXBlOiBcImV4ZWN1dGUtdGFza1wiLFxuICAgIHVuaXRJZDogXCJNMDAxL1MwMS9UMDFcIixcbiAgICBzdGF0dXM6IFwiYmxvY2tlZFwiLFxuICB9KTtcblxuICBhc3NlcnQuZGVlcEVxdWFsKGVudHJpZXMsIFtcbiAgICB7XG4gICAgICB0czogXCIyMDI2LTA1LTA0VDAwOjAwOjAwLjAwMFpcIixcbiAgICAgIGZsb3dJZDogXCJmbG93LTFcIixcbiAgICAgIHNlcTogMSxcbiAgICAgIGV2ZW50VHlwZTogXCJpdGVyYXRpb24tc3RhcnRcIixcbiAgICAgIGRhdGE6IHsgaXRlcmF0aW9uOiAxIH0sXG4gICAgfSxcbiAgICB7XG4gICAgICB0czogXCIyMDI2LTA1LTA0VDAwOjAwOjAwLjAwMFpcIixcbiAgICAgIGZsb3dJZDogXCJmbG93LTFcIixcbiAgICAgIHNlcTogMixcbiAgICAgIGV2ZW50VHlwZTogXCJ1bml0LWVuZFwiLFxuICAgICAgZGF0YToge1xuICAgICAgICB1bml0VHlwZTogXCJleGVjdXRlLXRhc2tcIixcbiAgICAgICAgdW5pdElkOiBcIk0wMDEvUzAxL1QwMVwiLFxuICAgICAgICBzdGF0dXM6IFwiYmxvY2tlZFwiLFxuICAgICAgfSxcbiAgICB9LFxuICBdKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBR0EsT0FBTyxZQUFZO0FBQ25CLE9BQU8sVUFBVTtBQUVqQixTQUFTLHFDQUFxQztBQUU5QyxLQUFLLHlFQUF5RSxNQUFNO0FBQ2xGLFFBQU0sVUFBcUIsQ0FBQztBQUM1QixNQUFJLE1BQU07QUFDVixRQUFNLFdBQVcsOEJBQThCO0FBQUEsSUFDN0Msa0JBQWtCLFdBQVMsUUFBUSxLQUFLLEtBQUs7QUFBQSxJQUM3QyxRQUFRO0FBQUEsSUFDUixTQUFTLE1BQU07QUFDYixhQUFPO0FBQ1AsYUFBTztBQUFBLElBQ1Q7QUFBQSxJQUNBLEtBQUssTUFBTTtBQUFBLEVBQ2IsQ0FBQztBQUVELFdBQVMsS0FBSyxtQkFBbUIsRUFBRSxXQUFXLEVBQUUsQ0FBQztBQUNqRCxXQUFTLEtBQUssWUFBWTtBQUFBLElBQ3hCLFVBQVU7QUFBQSxJQUNWLFFBQVE7QUFBQSxJQUNSLFFBQVE7QUFBQSxFQUNWLENBQUM7QUFFRCxTQUFPLFVBQVUsU0FBUztBQUFBLElBQ3hCO0FBQUEsTUFDRSxJQUFJO0FBQUEsTUFDSixRQUFRO0FBQUEsTUFDUixLQUFLO0FBQUEsTUFDTCxXQUFXO0FBQUEsTUFDWCxNQUFNLEVBQUUsV0FBVyxFQUFFO0FBQUEsSUFDdkI7QUFBQSxJQUNBO0FBQUEsTUFDRSxJQUFJO0FBQUEsTUFDSixRQUFRO0FBQUEsTUFDUixLQUFLO0FBQUEsTUFDTCxXQUFXO0FBQUEsTUFDWCxNQUFNO0FBQUEsUUFDSixVQUFVO0FBQUEsUUFDVixRQUFRO0FBQUEsUUFDUixRQUFRO0FBQUEsTUFDVjtBQUFBLElBQ0Y7QUFBQSxFQUNGLENBQUM7QUFDSCxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
