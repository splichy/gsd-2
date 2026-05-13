import test from "node:test";
import assert from "node:assert/strict";
import { decideVerificationVerdict } from "../verification-verdict.js";
function makeResult(overrides = {}) {
  return {
    passed: true,
    checks: [],
    discoverySource: "none",
    timestamp: 1,
    ...overrides
  };
}
test("execute-task fails closed when no host-owned checks are discovered", () => {
  const verdict = decideVerificationVerdict("execute-task", makeResult());
  assert.equal(verdict.passed, false);
  assert.equal(verdict.reason, "no-host-checks");
  assert.equal(verdict.retryable, false);
  assert.match(verdict.failureContext, /No runnable host-owned verification command/);
});
test("non execute-task units preserve no-check pass semantics", () => {
  const verdict = decideVerificationVerdict("plan-slice", makeResult());
  assert.equal(verdict.passed, true);
  assert.equal(verdict.reason, "passed");
});
test("execute-task command failure remains retryable verification failure", () => {
  const verdict = decideVerificationVerdict(
    "execute-task",
    makeResult({
      passed: false,
      discoverySource: "package-json",
      checks: [
        {
          command: "npm test",
          exitCode: 1,
          stdout: "",
          stderr: "failed",
          durationMs: 10
        }
      ]
    })
  );
  assert.equal(verdict.passed, false);
  assert.equal(verdict.reason, "checks-failed");
  assert.equal(verdict.retryable, true);
});
test("execute-task passes when a discovered host check succeeds", () => {
  const verdict = decideVerificationVerdict(
    "execute-task",
    makeResult({
      discoverySource: "preference",
      checks: [
        {
          command: "npm test",
          exitCode: 0,
          stdout: "ok",
          stderr: "",
          durationMs: 10
        }
      ]
    })
  );
  assert.equal(verdict.passed, true);
  assert.equal(verdict.reason, "passed");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy92ZXJpZmljYXRpb24tdmVyZGljdC50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBQcm9qZWN0L0FwcDogR1NELTJcbi8vIEZpbGUgUHVycG9zZTogVGVzdHMgZm9yIGhvc3Qtb3duZWQgYXV0by1tb2RlIHZlcmlmaWNhdGlvbiB2ZXJkaWN0IHBvbGljeS5cblxuaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5cbmltcG9ydCB7IGRlY2lkZVZlcmlmaWNhdGlvblZlcmRpY3QgfSBmcm9tIFwiLi4vdmVyaWZpY2F0aW9uLXZlcmRpY3QudHNcIjtcbmltcG9ydCB0eXBlIHsgVmVyaWZpY2F0aW9uUmVzdWx0IH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5cbmZ1bmN0aW9uIG1ha2VSZXN1bHQob3ZlcnJpZGVzOiBQYXJ0aWFsPFZlcmlmaWNhdGlvblJlc3VsdD4gPSB7fSk6IFZlcmlmaWNhdGlvblJlc3VsdCB7XG4gIHJldHVybiB7XG4gICAgcGFzc2VkOiB0cnVlLFxuICAgIGNoZWNrczogW10sXG4gICAgZGlzY292ZXJ5U291cmNlOiBcIm5vbmVcIixcbiAgICB0aW1lc3RhbXA6IDEsXG4gICAgLi4ub3ZlcnJpZGVzLFxuICB9O1xufVxuXG50ZXN0KFwiZXhlY3V0ZS10YXNrIGZhaWxzIGNsb3NlZCB3aGVuIG5vIGhvc3Qtb3duZWQgY2hlY2tzIGFyZSBkaXNjb3ZlcmVkXCIsICgpID0+IHtcbiAgY29uc3QgdmVyZGljdCA9IGRlY2lkZVZlcmlmaWNhdGlvblZlcmRpY3QoXCJleGVjdXRlLXRhc2tcIiwgbWFrZVJlc3VsdCgpKTtcblxuICBhc3NlcnQuZXF1YWwodmVyZGljdC5wYXNzZWQsIGZhbHNlKTtcbiAgYXNzZXJ0LmVxdWFsKHZlcmRpY3QucmVhc29uLCBcIm5vLWhvc3QtY2hlY2tzXCIpO1xuICBhc3NlcnQuZXF1YWwodmVyZGljdC5yZXRyeWFibGUsIGZhbHNlKTtcbiAgYXNzZXJ0Lm1hdGNoKHZlcmRpY3QuZmFpbHVyZUNvbnRleHQsIC9ObyBydW5uYWJsZSBob3N0LW93bmVkIHZlcmlmaWNhdGlvbiBjb21tYW5kLyk7XG59KTtcblxudGVzdChcIm5vbiBleGVjdXRlLXRhc2sgdW5pdHMgcHJlc2VydmUgbm8tY2hlY2sgcGFzcyBzZW1hbnRpY3NcIiwgKCkgPT4ge1xuICBjb25zdCB2ZXJkaWN0ID0gZGVjaWRlVmVyaWZpY2F0aW9uVmVyZGljdChcInBsYW4tc2xpY2VcIiwgbWFrZVJlc3VsdCgpKTtcblxuICBhc3NlcnQuZXF1YWwodmVyZGljdC5wYXNzZWQsIHRydWUpO1xuICBhc3NlcnQuZXF1YWwodmVyZGljdC5yZWFzb24sIFwicGFzc2VkXCIpO1xufSk7XG5cbnRlc3QoXCJleGVjdXRlLXRhc2sgY29tbWFuZCBmYWlsdXJlIHJlbWFpbnMgcmV0cnlhYmxlIHZlcmlmaWNhdGlvbiBmYWlsdXJlXCIsICgpID0+IHtcbiAgY29uc3QgdmVyZGljdCA9IGRlY2lkZVZlcmlmaWNhdGlvblZlcmRpY3QoXG4gICAgXCJleGVjdXRlLXRhc2tcIixcbiAgICBtYWtlUmVzdWx0KHtcbiAgICAgIHBhc3NlZDogZmFsc2UsXG4gICAgICBkaXNjb3ZlcnlTb3VyY2U6IFwicGFja2FnZS1qc29uXCIsXG4gICAgICBjaGVja3M6IFtcbiAgICAgICAge1xuICAgICAgICAgIGNvbW1hbmQ6IFwibnBtIHRlc3RcIixcbiAgICAgICAgICBleGl0Q29kZTogMSxcbiAgICAgICAgICBzdGRvdXQ6IFwiXCIsXG4gICAgICAgICAgc3RkZXJyOiBcImZhaWxlZFwiLFxuICAgICAgICAgIGR1cmF0aW9uTXM6IDEwLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9KSxcbiAgKTtcblxuICBhc3NlcnQuZXF1YWwodmVyZGljdC5wYXNzZWQsIGZhbHNlKTtcbiAgYXNzZXJ0LmVxdWFsKHZlcmRpY3QucmVhc29uLCBcImNoZWNrcy1mYWlsZWRcIik7XG4gIGFzc2VydC5lcXVhbCh2ZXJkaWN0LnJldHJ5YWJsZSwgdHJ1ZSk7XG59KTtcblxudGVzdChcImV4ZWN1dGUtdGFzayBwYXNzZXMgd2hlbiBhIGRpc2NvdmVyZWQgaG9zdCBjaGVjayBzdWNjZWVkc1wiLCAoKSA9PiB7XG4gIGNvbnN0IHZlcmRpY3QgPSBkZWNpZGVWZXJpZmljYXRpb25WZXJkaWN0KFxuICAgIFwiZXhlY3V0ZS10YXNrXCIsXG4gICAgbWFrZVJlc3VsdCh7XG4gICAgICBkaXNjb3ZlcnlTb3VyY2U6IFwicHJlZmVyZW5jZVwiLFxuICAgICAgY2hlY2tzOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBjb21tYW5kOiBcIm5wbSB0ZXN0XCIsXG4gICAgICAgICAgZXhpdENvZGU6IDAsXG4gICAgICAgICAgc3Rkb3V0OiBcIm9rXCIsXG4gICAgICAgICAgc3RkZXJyOiBcIlwiLFxuICAgICAgICAgIGR1cmF0aW9uTXM6IDEwLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9KSxcbiAgKTtcblxuICBhc3NlcnQuZXF1YWwodmVyZGljdC5wYXNzZWQsIHRydWUpO1xuICBhc3NlcnQuZXF1YWwodmVyZGljdC5yZWFzb24sIFwicGFzc2VkXCIpO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFHQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBRW5CLFNBQVMsaUNBQWlDO0FBRzFDLFNBQVMsV0FBVyxZQUF5QyxDQUFDLEdBQXVCO0FBQ25GLFNBQU87QUFBQSxJQUNMLFFBQVE7QUFBQSxJQUNSLFFBQVEsQ0FBQztBQUFBLElBQ1QsaUJBQWlCO0FBQUEsSUFDakIsV0FBVztBQUFBLElBQ1gsR0FBRztBQUFBLEVBQ0w7QUFDRjtBQUVBLEtBQUssc0VBQXNFLE1BQU07QUFDL0UsUUFBTSxVQUFVLDBCQUEwQixnQkFBZ0IsV0FBVyxDQUFDO0FBRXRFLFNBQU8sTUFBTSxRQUFRLFFBQVEsS0FBSztBQUNsQyxTQUFPLE1BQU0sUUFBUSxRQUFRLGdCQUFnQjtBQUM3QyxTQUFPLE1BQU0sUUFBUSxXQUFXLEtBQUs7QUFDckMsU0FBTyxNQUFNLFFBQVEsZ0JBQWdCLDZDQUE2QztBQUNwRixDQUFDO0FBRUQsS0FBSywyREFBMkQsTUFBTTtBQUNwRSxRQUFNLFVBQVUsMEJBQTBCLGNBQWMsV0FBVyxDQUFDO0FBRXBFLFNBQU8sTUFBTSxRQUFRLFFBQVEsSUFBSTtBQUNqQyxTQUFPLE1BQU0sUUFBUSxRQUFRLFFBQVE7QUFDdkMsQ0FBQztBQUVELEtBQUssdUVBQXVFLE1BQU07QUFDaEYsUUFBTSxVQUFVO0FBQUEsSUFDZDtBQUFBLElBQ0EsV0FBVztBQUFBLE1BQ1QsUUFBUTtBQUFBLE1BQ1IsaUJBQWlCO0FBQUEsTUFDakIsUUFBUTtBQUFBLFFBQ047QUFBQSxVQUNFLFNBQVM7QUFBQSxVQUNULFVBQVU7QUFBQSxVQUNWLFFBQVE7QUFBQSxVQUNSLFFBQVE7QUFBQSxVQUNSLFlBQVk7QUFBQSxRQUNkO0FBQUEsTUFDRjtBQUFBLElBQ0YsQ0FBQztBQUFBLEVBQ0g7QUFFQSxTQUFPLE1BQU0sUUFBUSxRQUFRLEtBQUs7QUFDbEMsU0FBTyxNQUFNLFFBQVEsUUFBUSxlQUFlO0FBQzVDLFNBQU8sTUFBTSxRQUFRLFdBQVcsSUFBSTtBQUN0QyxDQUFDO0FBRUQsS0FBSyw2REFBNkQsTUFBTTtBQUN0RSxRQUFNLFVBQVU7QUFBQSxJQUNkO0FBQUEsSUFDQSxXQUFXO0FBQUEsTUFDVCxpQkFBaUI7QUFBQSxNQUNqQixRQUFRO0FBQUEsUUFDTjtBQUFBLFVBQ0UsU0FBUztBQUFBLFVBQ1QsVUFBVTtBQUFBLFVBQ1YsUUFBUTtBQUFBLFVBQ1IsUUFBUTtBQUFBLFVBQ1IsWUFBWTtBQUFBLFFBQ2Q7QUFBQSxNQUNGO0FBQUEsSUFDRixDQUFDO0FBQUEsRUFDSDtBQUVBLFNBQU8sTUFBTSxRQUFRLFFBQVEsSUFBSTtBQUNqQyxTQUFPLE1BQU0sUUFBUSxRQUFRLFFBQVE7QUFDdkMsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
