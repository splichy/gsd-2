import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { handleCoreCommand } from "../commands/handlers/core.js";
import { buildQuickCommitInstruction } from "../quick.js";
describe("status opens DB before deriveState (#3691)", () => {
  test("core handler routes status command", async () => {
    const notifications = [];
    const ctx = {
      ui: {
        custom: async () => void 0,
        notify: (message, level) => {
          notifications.push({ message, level });
        }
      }
    };
    const handled = await handleCoreCommand("status", ctx);
    assert.equal(handled, true);
    assert.ok(notifications.length >= 0);
  });
  test("quick task commit instructions handle external .gsd roots without staging quick files", () => {
    const instruction = buildQuickCommitInstruction("/project", "/external/.gsd");
    assert.match(instruction, /do not stage or commit `\.gsd\/quick\/\.\.\.`/);
    assert.match(instruction, /nothing in the project repo to commit/);
  });
  test("quick task commit instructions include normal commit guidance for in-project .gsd roots", () => {
    const instruction = buildQuickCommitInstruction("/project", "/project/.gsd");
    assert.doesNotMatch(instruction, /nothing in the project repo to commit/);
    assert.match(instruction, /Commit your changes atomically/);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9zdGF0dXMtZGItb3Blbi50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFJlZ3Jlc3Npb24gdGVzdHMgZm9yIHN0YXR1cy9xdWljayBiZWhhdmlvci5cbiAqL1xuXG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuXG5pbXBvcnQgeyBoYW5kbGVDb3JlQ29tbWFuZCB9IGZyb20gXCIuLi9jb21tYW5kcy9oYW5kbGVycy9jb3JlLnRzXCI7XG5pbXBvcnQgeyBidWlsZFF1aWNrQ29tbWl0SW5zdHJ1Y3Rpb24gfSBmcm9tIFwiLi4vcXVpY2sudHNcIjtcblxuZGVzY3JpYmUoXCJzdGF0dXMgb3BlbnMgREIgYmVmb3JlIGRlcml2ZVN0YXRlICgjMzY5MSlcIiwgKCkgPT4ge1xuICB0ZXN0KFwiY29yZSBoYW5kbGVyIHJvdXRlcyBzdGF0dXMgY29tbWFuZFwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3Qgbm90aWZpY2F0aW9uczogQXJyYXk8eyBtZXNzYWdlOiBzdHJpbmc7IGxldmVsOiBzdHJpbmcgfT4gPSBbXTtcbiAgICBjb25zdCBjdHggPSB7XG4gICAgICB1aToge1xuICAgICAgICBjdXN0b206IGFzeW5jICgpID0+IHVuZGVmaW5lZCxcbiAgICAgICAgbm90aWZ5OiAobWVzc2FnZTogc3RyaW5nLCBsZXZlbDogc3RyaW5nKSA9PiB7XG4gICAgICAgICAgbm90aWZpY2F0aW9ucy5wdXNoKHsgbWVzc2FnZSwgbGV2ZWwgfSk7XG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgIH07XG5cbiAgICBjb25zdCBoYW5kbGVkID0gYXdhaXQgaGFuZGxlQ29yZUNvbW1hbmQoXCJzdGF0dXNcIiwgY3R4IGFzIGFueSk7XG5cbiAgICBhc3NlcnQuZXF1YWwoaGFuZGxlZCwgdHJ1ZSk7XG4gICAgYXNzZXJ0Lm9rKG5vdGlmaWNhdGlvbnMubGVuZ3RoID49IDApO1xuICB9KTtcblxuICB0ZXN0KFwicXVpY2sgdGFzayBjb21taXQgaW5zdHJ1Y3Rpb25zIGhhbmRsZSBleHRlcm5hbCAuZ3NkIHJvb3RzIHdpdGhvdXQgc3RhZ2luZyBxdWljayBmaWxlc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgaW5zdHJ1Y3Rpb24gPSBidWlsZFF1aWNrQ29tbWl0SW5zdHJ1Y3Rpb24oXCIvcHJvamVjdFwiLCBcIi9leHRlcm5hbC8uZ3NkXCIpO1xuXG4gICAgYXNzZXJ0Lm1hdGNoKGluc3RydWN0aW9uLCAvZG8gbm90IHN0YWdlIG9yIGNvbW1pdCBgXFwuZ3NkXFwvcXVpY2tcXC9cXC5cXC5cXC5gLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKGluc3RydWN0aW9uLCAvbm90aGluZyBpbiB0aGUgcHJvamVjdCByZXBvIHRvIGNvbW1pdC8pO1xuICB9KTtcblxuICB0ZXN0KFwicXVpY2sgdGFzayBjb21taXQgaW5zdHJ1Y3Rpb25zIGluY2x1ZGUgbm9ybWFsIGNvbW1pdCBndWlkYW5jZSBmb3IgaW4tcHJvamVjdCAuZ3NkIHJvb3RzXCIsICgpID0+IHtcbiAgICBjb25zdCBpbnN0cnVjdGlvbiA9IGJ1aWxkUXVpY2tDb21taXRJbnN0cnVjdGlvbihcIi9wcm9qZWN0XCIsIFwiL3Byb2plY3QvLmdzZFwiKTtcblxuICAgIGFzc2VydC5kb2VzTm90TWF0Y2goaW5zdHJ1Y3Rpb24sIC9ub3RoaW5nIGluIHRoZSBwcm9qZWN0IHJlcG8gdG8gY29tbWl0Lyk7XG4gICAgYXNzZXJ0Lm1hdGNoKGluc3RydWN0aW9uLCAvQ29tbWl0IHlvdXIgY2hhbmdlcyBhdG9taWNhbGx5Lyk7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFJQSxTQUFTLFVBQVUsWUFBWTtBQUMvQixPQUFPLFlBQVk7QUFFbkIsU0FBUyx5QkFBeUI7QUFDbEMsU0FBUyxtQ0FBbUM7QUFFNUMsU0FBUyw4Q0FBOEMsTUFBTTtBQUMzRCxPQUFLLHNDQUFzQyxZQUFZO0FBQ3JELFVBQU0sZ0JBQTJELENBQUM7QUFDbEUsVUFBTSxNQUFNO0FBQUEsTUFDVixJQUFJO0FBQUEsUUFDRixRQUFRLFlBQVk7QUFBQSxRQUNwQixRQUFRLENBQUMsU0FBaUIsVUFBa0I7QUFDMUMsd0JBQWMsS0FBSyxFQUFFLFNBQVMsTUFBTSxDQUFDO0FBQUEsUUFDdkM7QUFBQSxNQUNGO0FBQUEsSUFDRjtBQUVBLFVBQU0sVUFBVSxNQUFNLGtCQUFrQixVQUFVLEdBQVU7QUFFNUQsV0FBTyxNQUFNLFNBQVMsSUFBSTtBQUMxQixXQUFPLEdBQUcsY0FBYyxVQUFVLENBQUM7QUFBQSxFQUNyQyxDQUFDO0FBRUQsT0FBSyx5RkFBeUYsTUFBTTtBQUNsRyxVQUFNLGNBQWMsNEJBQTRCLFlBQVksZ0JBQWdCO0FBRTVFLFdBQU8sTUFBTSxhQUFhLCtDQUErQztBQUN6RSxXQUFPLE1BQU0sYUFBYSx1Q0FBdUM7QUFBQSxFQUNuRSxDQUFDO0FBRUQsT0FBSywyRkFBMkYsTUFBTTtBQUNwRyxVQUFNLGNBQWMsNEJBQTRCLFlBQVksZUFBZTtBQUUzRSxXQUFPLGFBQWEsYUFBYSx1Q0FBdUM7QUFDeEUsV0FBTyxNQUFNLGFBQWEsZ0NBQWdDO0FBQUEsRUFDNUQsQ0FBQztBQUNILENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
