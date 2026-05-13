import test from "node:test";
import assert from "node:assert/strict";
import {
  drainAndSummarize,
  formatForNotification,
  hasAnyIssues,
  logError,
  logWarning,
  peekLogs,
  _resetLogs,
  setStderrLoggingEnabled
} from "../workflow-logger.js";
import { detectStuck } from "../auto/detect-stuck.js";
test("drainAndSummarize summarizes and clears the workflow log buffer", () => {
  const previous = setStderrLoggingEnabled(false);
  try {
    _resetLogs();
    logWarning("projection", "STATE.md render failed", { file: "STATE.md" });
    logError("db", "WAL checkpoint failed");
    assert.equal(hasAnyIssues(), true);
    const drained = drainAndSummarize();
    assert.equal(drained.logs.length, 2);
    assert.match(drained.summary ?? "", /STATE\.md render failed/);
    assert.match(drained.summary ?? "", /WAL checkpoint failed/);
    assert.equal(peekLogs().length, 0);
  } finally {
    _resetLogs();
    setStderrLoggingEnabled(previous);
  }
});
test("formatForNotification includes component and useful context", () => {
  const text = formatForNotification([
    {
      ts: "2026-01-01T00:00:00.000Z",
      severity: "warn",
      component: "projection",
      message: "render failed",
      context: { file: "STATE.md", command: "derive" }
    }
  ]);
  assert.match(text, /\[projection\] render failed/);
  assert.match(text, /file: STATE\.md/);
  assert.match(text, /command: derive/);
});
test("detectStuck reason includes workflow-logger summary when logs present", () => {
  const previous = setStderrLoggingEnabled(false);
  try {
    _resetLogs();
    logWarning("projection", "STATE.md render failed");
    logError("db", "WAL checkpoint failed");
    const result = detectStuck([
      { key: "execute-task/slice-A/task-1", error: "ENOENT: no such file" },
      { key: "execute-task/slice-A/task-1", error: "ENOENT: no such file" }
    ]);
    assert.notEqual(result, null);
    assert.equal(result.stuck, true);
    assert.match(result.reason, /Same error repeated:/);
    assert.match(result.reason, /STATE\.md render failed/);
    assert.match(result.reason, /WAL checkpoint failed/);
    assert.equal(peekLogs().length, 2, "detect-stuck must not drain the buffer");
  } finally {
    _resetLogs();
    setStderrLoggingEnabled(previous);
  }
});
test("detectStuck reason unchanged when logger buffer is empty", () => {
  const previous = setStderrLoggingEnabled(false);
  try {
    _resetLogs();
    const result = detectStuck([
      { key: "A", error: "boom" },
      { key: "A", error: "boom" }
    ]);
    assert.notEqual(result, null);
    assert.doesNotMatch(result.reason, / — \d+ (error|warning)/);
  } finally {
    _resetLogs();
    setStderrLoggingEnabled(previous);
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy93b3JrZmxvdy1sb2dnZXItd2lyaW5nLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRC0yIFx1MjAxNCB3b3JrZmxvdy1sb2dnZXIgYmVoYXZpb3IgcmVncmVzc2lvbiB0ZXN0cy5cblxuaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5cbmltcG9ydCB7XG4gIGRyYWluQW5kU3VtbWFyaXplLFxuICBmb3JtYXRGb3JOb3RpZmljYXRpb24sXG4gIGhhc0FueUlzc3VlcyxcbiAgbG9nRXJyb3IsXG4gIGxvZ1dhcm5pbmcsXG4gIHBlZWtMb2dzLFxuICBfcmVzZXRMb2dzLFxuICBzZXRTdGRlcnJMb2dnaW5nRW5hYmxlZCxcbn0gZnJvbSBcIi4uL3dvcmtmbG93LWxvZ2dlci50c1wiO1xuaW1wb3J0IHsgZGV0ZWN0U3R1Y2sgfSBmcm9tIFwiLi4vYXV0by9kZXRlY3Qtc3R1Y2sudHNcIjtcblxudGVzdChcImRyYWluQW5kU3VtbWFyaXplIHN1bW1hcml6ZXMgYW5kIGNsZWFycyB0aGUgd29ya2Zsb3cgbG9nIGJ1ZmZlclwiLCAoKSA9PiB7XG4gIGNvbnN0IHByZXZpb3VzID0gc2V0U3RkZXJyTG9nZ2luZ0VuYWJsZWQoZmFsc2UpO1xuICB0cnkge1xuICAgIF9yZXNldExvZ3MoKTtcbiAgICBsb2dXYXJuaW5nKFwicHJvamVjdGlvblwiLCBcIlNUQVRFLm1kIHJlbmRlciBmYWlsZWRcIiwgeyBmaWxlOiBcIlNUQVRFLm1kXCIgfSk7XG4gICAgbG9nRXJyb3IoXCJkYlwiLCBcIldBTCBjaGVja3BvaW50IGZhaWxlZFwiKTtcblxuICAgIGFzc2VydC5lcXVhbChoYXNBbnlJc3N1ZXMoKSwgdHJ1ZSk7XG4gICAgY29uc3QgZHJhaW5lZCA9IGRyYWluQW5kU3VtbWFyaXplKCk7XG5cbiAgICBhc3NlcnQuZXF1YWwoZHJhaW5lZC5sb2dzLmxlbmd0aCwgMik7XG4gICAgYXNzZXJ0Lm1hdGNoKGRyYWluZWQuc3VtbWFyeSA/PyBcIlwiLCAvU1RBVEVcXC5tZCByZW5kZXIgZmFpbGVkLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKGRyYWluZWQuc3VtbWFyeSA/PyBcIlwiLCAvV0FMIGNoZWNrcG9pbnQgZmFpbGVkLyk7XG4gICAgYXNzZXJ0LmVxdWFsKHBlZWtMb2dzKCkubGVuZ3RoLCAwKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBfcmVzZXRMb2dzKCk7XG4gICAgc2V0U3RkZXJyTG9nZ2luZ0VuYWJsZWQocHJldmlvdXMpO1xuICB9XG59KTtcblxudGVzdChcImZvcm1hdEZvck5vdGlmaWNhdGlvbiBpbmNsdWRlcyBjb21wb25lbnQgYW5kIHVzZWZ1bCBjb250ZXh0XCIsICgpID0+IHtcbiAgY29uc3QgdGV4dCA9IGZvcm1hdEZvck5vdGlmaWNhdGlvbihbXG4gICAge1xuICAgICAgdHM6IFwiMjAyNi0wMS0wMVQwMDowMDowMC4wMDBaXCIsXG4gICAgICBzZXZlcml0eTogXCJ3YXJuXCIsXG4gICAgICBjb21wb25lbnQ6IFwicHJvamVjdGlvblwiLFxuICAgICAgbWVzc2FnZTogXCJyZW5kZXIgZmFpbGVkXCIsXG4gICAgICBjb250ZXh0OiB7IGZpbGU6IFwiU1RBVEUubWRcIiwgY29tbWFuZDogXCJkZXJpdmVcIiB9LFxuICAgIH0sXG4gIF0pO1xuXG4gIGFzc2VydC5tYXRjaCh0ZXh0LCAvXFxbcHJvamVjdGlvblxcXSByZW5kZXIgZmFpbGVkLyk7XG4gIGFzc2VydC5tYXRjaCh0ZXh0LCAvZmlsZTogU1RBVEVcXC5tZC8pO1xuICBhc3NlcnQubWF0Y2godGV4dCwgL2NvbW1hbmQ6IGRlcml2ZS8pO1xufSk7XG5cbnRlc3QoXCJkZXRlY3RTdHVjayByZWFzb24gaW5jbHVkZXMgd29ya2Zsb3ctbG9nZ2VyIHN1bW1hcnkgd2hlbiBsb2dzIHByZXNlbnRcIiwgKCkgPT4ge1xuICBjb25zdCBwcmV2aW91cyA9IHNldFN0ZGVyckxvZ2dpbmdFbmFibGVkKGZhbHNlKTtcbiAgdHJ5IHtcbiAgICBfcmVzZXRMb2dzKCk7XG4gICAgbG9nV2FybmluZyhcInByb2plY3Rpb25cIiwgXCJTVEFURS5tZCByZW5kZXIgZmFpbGVkXCIpO1xuICAgIGxvZ0Vycm9yKFwiZGJcIiwgXCJXQUwgY2hlY2twb2ludCBmYWlsZWRcIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSBkZXRlY3RTdHVjayhbXG4gICAgICB7IGtleTogXCJleGVjdXRlLXRhc2svc2xpY2UtQS90YXNrLTFcIiwgZXJyb3I6IFwiRU5PRU5UOiBubyBzdWNoIGZpbGVcIiB9LFxuICAgICAgeyBrZXk6IFwiZXhlY3V0ZS10YXNrL3NsaWNlLUEvdGFzay0xXCIsIGVycm9yOiBcIkVOT0VOVDogbm8gc3VjaCBmaWxlXCIgfSxcbiAgICBdKTtcblxuICAgIGFzc2VydC5ub3RFcXVhbChyZXN1bHQsIG51bGwpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQhLnN0dWNrLCB0cnVlKTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0IS5yZWFzb24sIC9TYW1lIGVycm9yIHJlcGVhdGVkOi8pO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQhLnJlYXNvbiwgL1NUQVRFXFwubWQgcmVuZGVyIGZhaWxlZC8pO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQhLnJlYXNvbiwgL1dBTCBjaGVja3BvaW50IGZhaWxlZC8pO1xuICAgIGFzc2VydC5lcXVhbChwZWVrTG9ncygpLmxlbmd0aCwgMiwgXCJkZXRlY3Qtc3R1Y2sgbXVzdCBub3QgZHJhaW4gdGhlIGJ1ZmZlclwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBfcmVzZXRMb2dzKCk7XG4gICAgc2V0U3RkZXJyTG9nZ2luZ0VuYWJsZWQocHJldmlvdXMpO1xuICB9XG59KTtcblxudGVzdChcImRldGVjdFN0dWNrIHJlYXNvbiB1bmNoYW5nZWQgd2hlbiBsb2dnZXIgYnVmZmVyIGlzIGVtcHR5XCIsICgpID0+IHtcbiAgY29uc3QgcHJldmlvdXMgPSBzZXRTdGRlcnJMb2dnaW5nRW5hYmxlZChmYWxzZSk7XG4gIHRyeSB7XG4gICAgX3Jlc2V0TG9ncygpO1xuICAgIGNvbnN0IHJlc3VsdCA9IGRldGVjdFN0dWNrKFtcbiAgICAgIHsga2V5OiBcIkFcIiwgZXJyb3I6IFwiYm9vbVwiIH0sXG4gICAgICB7IGtleTogXCJBXCIsIGVycm9yOiBcImJvb21cIiB9LFxuICAgIF0pO1xuICAgIGFzc2VydC5ub3RFcXVhbChyZXN1bHQsIG51bGwpO1xuICAgIGFzc2VydC5kb2VzTm90TWF0Y2gocmVzdWx0IS5yZWFzb24sIC8gXHUyMDE0IFxcZCsgKGVycm9yfHdhcm5pbmcpLyk7XG4gIH0gZmluYWxseSB7XG4gICAgX3Jlc2V0TG9ncygpO1xuICAgIHNldFN0ZGVyckxvZ2dpbmdFbmFibGVkKHByZXZpb3VzKTtcbiAgfVxufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFFQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBRW5CO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1AsU0FBUyxtQkFBbUI7QUFFNUIsS0FBSyxtRUFBbUUsTUFBTTtBQUM1RSxRQUFNLFdBQVcsd0JBQXdCLEtBQUs7QUFDOUMsTUFBSTtBQUNGLGVBQVc7QUFDWCxlQUFXLGNBQWMsMEJBQTBCLEVBQUUsTUFBTSxXQUFXLENBQUM7QUFDdkUsYUFBUyxNQUFNLHVCQUF1QjtBQUV0QyxXQUFPLE1BQU0sYUFBYSxHQUFHLElBQUk7QUFDakMsVUFBTSxVQUFVLGtCQUFrQjtBQUVsQyxXQUFPLE1BQU0sUUFBUSxLQUFLLFFBQVEsQ0FBQztBQUNuQyxXQUFPLE1BQU0sUUFBUSxXQUFXLElBQUkseUJBQXlCO0FBQzdELFdBQU8sTUFBTSxRQUFRLFdBQVcsSUFBSSx1QkFBdUI7QUFDM0QsV0FBTyxNQUFNLFNBQVMsRUFBRSxRQUFRLENBQUM7QUFBQSxFQUNuQyxVQUFFO0FBQ0EsZUFBVztBQUNYLDRCQUF3QixRQUFRO0FBQUEsRUFDbEM7QUFDRixDQUFDO0FBRUQsS0FBSywrREFBK0QsTUFBTTtBQUN4RSxRQUFNLE9BQU8sc0JBQXNCO0FBQUEsSUFDakM7QUFBQSxNQUNFLElBQUk7QUFBQSxNQUNKLFVBQVU7QUFBQSxNQUNWLFdBQVc7QUFBQSxNQUNYLFNBQVM7QUFBQSxNQUNULFNBQVMsRUFBRSxNQUFNLFlBQVksU0FBUyxTQUFTO0FBQUEsSUFDakQ7QUFBQSxFQUNGLENBQUM7QUFFRCxTQUFPLE1BQU0sTUFBTSw4QkFBOEI7QUFDakQsU0FBTyxNQUFNLE1BQU0saUJBQWlCO0FBQ3BDLFNBQU8sTUFBTSxNQUFNLGlCQUFpQjtBQUN0QyxDQUFDO0FBRUQsS0FBSyx5RUFBeUUsTUFBTTtBQUNsRixRQUFNLFdBQVcsd0JBQXdCLEtBQUs7QUFDOUMsTUFBSTtBQUNGLGVBQVc7QUFDWCxlQUFXLGNBQWMsd0JBQXdCO0FBQ2pELGFBQVMsTUFBTSx1QkFBdUI7QUFFdEMsVUFBTSxTQUFTLFlBQVk7QUFBQSxNQUN6QixFQUFFLEtBQUssK0JBQStCLE9BQU8sdUJBQXVCO0FBQUEsTUFDcEUsRUFBRSxLQUFLLCtCQUErQixPQUFPLHVCQUF1QjtBQUFBLElBQ3RFLENBQUM7QUFFRCxXQUFPLFNBQVMsUUFBUSxJQUFJO0FBQzVCLFdBQU8sTUFBTSxPQUFRLE9BQU8sSUFBSTtBQUNoQyxXQUFPLE1BQU0sT0FBUSxRQUFRLHNCQUFzQjtBQUNuRCxXQUFPLE1BQU0sT0FBUSxRQUFRLHlCQUF5QjtBQUN0RCxXQUFPLE1BQU0sT0FBUSxRQUFRLHVCQUF1QjtBQUNwRCxXQUFPLE1BQU0sU0FBUyxFQUFFLFFBQVEsR0FBRyx3Q0FBd0M7QUFBQSxFQUM3RSxVQUFFO0FBQ0EsZUFBVztBQUNYLDRCQUF3QixRQUFRO0FBQUEsRUFDbEM7QUFDRixDQUFDO0FBRUQsS0FBSyw0REFBNEQsTUFBTTtBQUNyRSxRQUFNLFdBQVcsd0JBQXdCLEtBQUs7QUFDOUMsTUFBSTtBQUNGLGVBQVc7QUFDWCxVQUFNLFNBQVMsWUFBWTtBQUFBLE1BQ3pCLEVBQUUsS0FBSyxLQUFLLE9BQU8sT0FBTztBQUFBLE1BQzFCLEVBQUUsS0FBSyxLQUFLLE9BQU8sT0FBTztBQUFBLElBQzVCLENBQUM7QUFDRCxXQUFPLFNBQVMsUUFBUSxJQUFJO0FBQzVCLFdBQU8sYUFBYSxPQUFRLFFBQVEsd0JBQXdCO0FBQUEsRUFDOUQsVUFBRTtBQUNBLGVBQVc7QUFDWCw0QkFBd0IsUUFBUTtBQUFBLEVBQ2xDO0FBQ0YsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
