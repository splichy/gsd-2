import test from "node:test";
import assert from "node:assert/strict";
import {
  isSuspiciousGhostCompletion,
  snapshotUnitActivity
} from "../auto-unit-closeout.js";
function makeCtx(entries) {
  return {
    sessionManager: {
      getEntries: () => entries
    }
  };
}
test("isSuspiciousGhostCompletion rejects fast completions with no assistant output or tools", () => {
  const startedAt = Date.now();
  const ctx = makeCtx([]);
  assert.equal(isSuspiciousGhostCompletion(ctx, startedAt, 500), true);
});
test("isSuspiciousGhostCompletion allows fast completions with assistant output", () => {
  const startedAt = Date.now();
  const ctx = makeCtx([
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Done." }]
      }
    }
  ]);
  assert.equal(isSuspiciousGhostCompletion(ctx, startedAt, 500), false);
});
test("snapshotUnitActivity counts assistant messages and tool calls", () => {
  const ctx = makeCtx([
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Working." },
          { type: "toolCall", name: "read_file" }
        ]
      }
    },
    {
      type: "message",
      message: {
        role: "user",
        content: "continue"
      }
    }
  ]);
  assert.deepEqual(snapshotUnitActivity(ctx, 1e3, 1250), {
    elapsedMs: 250,
    toolCalls: 1,
    assistantMessages: 1
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9hdXRvLXVuaXQtY2xvc2VvdXQudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IFJlZ3Jlc3Npb24gdGVzdHMgZm9yIGF1dG8tdW5pdCBjbG9zZW91dCBhY3Rpdml0eSBjbGFzc2lmaWNhdGlvbi5cblxuaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5cbmltcG9ydCB7XG4gIGlzU3VzcGljaW91c0dob3N0Q29tcGxldGlvbixcbiAgc25hcHNob3RVbml0QWN0aXZpdHksXG59IGZyb20gXCIuLi9hdXRvLXVuaXQtY2xvc2VvdXQudHNcIjtcblxuZnVuY3Rpb24gbWFrZUN0eChlbnRyaWVzOiB1bmtub3duW10pIHtcbiAgcmV0dXJuIHtcbiAgICBzZXNzaW9uTWFuYWdlcjoge1xuICAgICAgZ2V0RW50cmllczogKCkgPT4gZW50cmllcyxcbiAgICB9LFxuICB9IGFzIGFueTtcbn1cblxudGVzdChcImlzU3VzcGljaW91c0dob3N0Q29tcGxldGlvbiByZWplY3RzIGZhc3QgY29tcGxldGlvbnMgd2l0aCBubyBhc3Npc3RhbnQgb3V0cHV0IG9yIHRvb2xzXCIsICgpID0+IHtcbiAgY29uc3Qgc3RhcnRlZEF0ID0gRGF0ZS5ub3coKTtcbiAgY29uc3QgY3R4ID0gbWFrZUN0eChbXSk7XG5cbiAgYXNzZXJ0LmVxdWFsKGlzU3VzcGljaW91c0dob3N0Q29tcGxldGlvbihjdHgsIHN0YXJ0ZWRBdCwgNTAwKSwgdHJ1ZSk7XG59KTtcblxudGVzdChcImlzU3VzcGljaW91c0dob3N0Q29tcGxldGlvbiBhbGxvd3MgZmFzdCBjb21wbGV0aW9ucyB3aXRoIGFzc2lzdGFudCBvdXRwdXRcIiwgKCkgPT4ge1xuICBjb25zdCBzdGFydGVkQXQgPSBEYXRlLm5vdygpO1xuICBjb25zdCBjdHggPSBtYWtlQ3R4KFtcbiAgICB7XG4gICAgICB0eXBlOiBcIm1lc3NhZ2VcIixcbiAgICAgIG1lc3NhZ2U6IHtcbiAgICAgICAgcm9sZTogXCJhc3Npc3RhbnRcIixcbiAgICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiRG9uZS5cIiB9XSxcbiAgICAgIH0sXG4gICAgfSxcbiAgXSk7XG5cbiAgYXNzZXJ0LmVxdWFsKGlzU3VzcGljaW91c0dob3N0Q29tcGxldGlvbihjdHgsIHN0YXJ0ZWRBdCwgNTAwKSwgZmFsc2UpO1xufSk7XG5cbnRlc3QoXCJzbmFwc2hvdFVuaXRBY3Rpdml0eSBjb3VudHMgYXNzaXN0YW50IG1lc3NhZ2VzIGFuZCB0b29sIGNhbGxzXCIsICgpID0+IHtcbiAgY29uc3QgY3R4ID0gbWFrZUN0eChbXG4gICAge1xuICAgICAgdHlwZTogXCJtZXNzYWdlXCIsXG4gICAgICBtZXNzYWdlOiB7XG4gICAgICAgIHJvbGU6IFwiYXNzaXN0YW50XCIsXG4gICAgICAgIGNvbnRlbnQ6IFtcbiAgICAgICAgICB7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIldvcmtpbmcuXCIgfSxcbiAgICAgICAgICB7IHR5cGU6IFwidG9vbENhbGxcIiwgbmFtZTogXCJyZWFkX2ZpbGVcIiB9LFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICB9LFxuICAgIHtcbiAgICAgIHR5cGU6IFwibWVzc2FnZVwiLFxuICAgICAgbWVzc2FnZToge1xuICAgICAgICByb2xlOiBcInVzZXJcIixcbiAgICAgICAgY29udGVudDogXCJjb250aW51ZVwiLFxuICAgICAgfSxcbiAgICB9LFxuICBdKTtcblxuICBhc3NlcnQuZGVlcEVxdWFsKHNuYXBzaG90VW5pdEFjdGl2aXR5KGN0eCwgMV8wMDAsIDFfMjUwKSwge1xuICAgIGVsYXBzZWRNczogMjUwLFxuICAgIHRvb2xDYWxsczogMSxcbiAgICBhc3Npc3RhbnRNZXNzYWdlczogMSxcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUdBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7QUFFbkI7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFFUCxTQUFTLFFBQVEsU0FBb0I7QUFDbkMsU0FBTztBQUFBLElBQ0wsZ0JBQWdCO0FBQUEsTUFDZCxZQUFZLE1BQU07QUFBQSxJQUNwQjtBQUFBLEVBQ0Y7QUFDRjtBQUVBLEtBQUssMEZBQTBGLE1BQU07QUFDbkcsUUFBTSxZQUFZLEtBQUssSUFBSTtBQUMzQixRQUFNLE1BQU0sUUFBUSxDQUFDLENBQUM7QUFFdEIsU0FBTyxNQUFNLDRCQUE0QixLQUFLLFdBQVcsR0FBRyxHQUFHLElBQUk7QUFDckUsQ0FBQztBQUVELEtBQUssNkVBQTZFLE1BQU07QUFDdEYsUUFBTSxZQUFZLEtBQUssSUFBSTtBQUMzQixRQUFNLE1BQU0sUUFBUTtBQUFBLElBQ2xCO0FBQUEsTUFDRSxNQUFNO0FBQUEsTUFDTixTQUFTO0FBQUEsUUFDUCxNQUFNO0FBQUEsUUFDTixTQUFTLENBQUMsRUFBRSxNQUFNLFFBQVEsTUFBTSxRQUFRLENBQUM7QUFBQSxNQUMzQztBQUFBLElBQ0Y7QUFBQSxFQUNGLENBQUM7QUFFRCxTQUFPLE1BQU0sNEJBQTRCLEtBQUssV0FBVyxHQUFHLEdBQUcsS0FBSztBQUN0RSxDQUFDO0FBRUQsS0FBSyxpRUFBaUUsTUFBTTtBQUMxRSxRQUFNLE1BQU0sUUFBUTtBQUFBLElBQ2xCO0FBQUEsTUFDRSxNQUFNO0FBQUEsTUFDTixTQUFTO0FBQUEsUUFDUCxNQUFNO0FBQUEsUUFDTixTQUFTO0FBQUEsVUFDUCxFQUFFLE1BQU0sUUFBUSxNQUFNLFdBQVc7QUFBQSxVQUNqQyxFQUFFLE1BQU0sWUFBWSxNQUFNLFlBQVk7QUFBQSxRQUN4QztBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBQUEsSUFDQTtBQUFBLE1BQ0UsTUFBTTtBQUFBLE1BQ04sU0FBUztBQUFBLFFBQ1AsTUFBTTtBQUFBLFFBQ04sU0FBUztBQUFBLE1BQ1g7QUFBQSxJQUNGO0FBQUEsRUFDRixDQUFDO0FBRUQsU0FBTyxVQUFVLHFCQUFxQixLQUFLLEtBQU8sSUFBSyxHQUFHO0FBQUEsSUFDeEQsV0FBVztBQUFBLElBQ1gsV0FBVztBQUFBLElBQ1gsbUJBQW1CO0FBQUEsRUFDckIsQ0FBQztBQUNILENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
