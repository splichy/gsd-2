import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendCapture,
  countPendingCaptures,
  hasPendingCaptures,
  loadPendingCaptures,
  markCaptureExecuted,
  markCaptureResolved
} from "../captures.js";
import { checkPostUnitHooks } from "../post-unit-hooks.js";
import {
  _shouldDispatchQuickTaskForTest,
  _shouldDispatchTriageForTest
} from "../auto-post-unit.js";
import {
  buildQuickTaskPrompt,
  loadDeferredCaptures,
  loadReplanCaptures
} from "../triage-resolution.js";
function makeProject() {
  const base = mkdtempSync(join(tmpdir(), "gsd-triage-dispatch-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
    [
      "# M001",
      "",
      "## Slices",
      "- [ ] **S01: Slice** `risk:low` `depends:[]`"
    ].join("\n")
  );
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"),
    "# S01 Plan\n\n## Tasks\n- [ ] **T01: Task** `est:10m`\n"
  );
  return base;
}
test("post-unit hooks exclude triage and quick-task units", () => {
  assert.equal(checkPostUnitHooks("triage-captures", "M001/S01/triage", "/tmp/project"), null);
  assert.equal(checkPostUnitHooks("quick-task", "M001/CAP-1", "/tmp/project"), null);
});
test("triage dispatch guard excludes step mode, hook units, triage units, and quick tasks", () => {
  const normal = { stepMode: false, currentUnit: { type: "execute-task", id: "M001/S01/T01", startedAt: 1 } };
  assert.equal(_shouldDispatchTriageForTest(normal), true);
  assert.equal(_shouldDispatchTriageForTest({ ...normal, stepMode: true }), false);
  assert.equal(
    _shouldDispatchTriageForTest({ stepMode: false, currentUnit: { type: "hook/review", id: "M001/S01/T01", startedAt: 1 } }),
    false
  );
  assert.equal(
    _shouldDispatchTriageForTest({ stepMode: false, currentUnit: { type: "triage-captures", id: "M001/S01/triage", startedAt: 1 } }),
    false
  );
  assert.equal(
    _shouldDispatchTriageForTest({ stepMode: false, currentUnit: { type: "quick-task", id: "M001/CAP-1", startedAt: 1 } }),
    false
  );
});
test("quick-task dispatch guard requires queued captures and avoids quick-task recursion", () => {
  const capture = {
    id: "CAP-test",
    text: "Fix typo",
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    status: "resolved",
    classification: "quick-task"
  };
  assert.equal(
    _shouldDispatchQuickTaskForTest({
      stepMode: false,
      currentUnit: { type: "execute-task", id: "M001/S01/T01", startedAt: 1 },
      pendingQuickTasks: [capture]
    }),
    true
  );
  assert.equal(
    _shouldDispatchQuickTaskForTest({
      stepMode: false,
      currentUnit: { type: "quick-task", id: "M001/CAP-test", startedAt: 1 },
      pendingQuickTasks: [capture]
    }),
    false
  );
  assert.equal(
    _shouldDispatchQuickTaskForTest({
      stepMode: false,
      currentUnit: { type: "execute-task", id: "M001/S01/T01", startedAt: 1 },
      pendingQuickTasks: []
    }),
    false
  );
});
test("capture lifecycle exposes pending, replan, deferred, and executed states", () => {
  const base = makeProject();
  try {
    const pendingId = appendCapture(base, "Need a quick follow-up.");
    const replanId = appendCapture(base, "Plan needs a new task.");
    const deferId = appendCapture(base, "Create a future milestone.");
    assert.equal(hasPendingCaptures(base), true);
    assert.equal(countPendingCaptures(base), 3);
    assert.deepEqual(loadPendingCaptures(base).map((entry) => entry.id).sort(), [deferId, pendingId, replanId].sort());
    markCaptureResolved(base, replanId, "replan", "replan slice", "Need plan update", "M001");
    markCaptureResolved(base, deferId, "defer", "defer milestone", "Out of current scope", "M001");
    markCaptureExecuted(base, replanId);
    assert.equal(loadReplanCaptures(base).some((entry) => entry.id === replanId), true);
    assert.equal(loadDeferredCaptures(base).some((entry) => entry.id === deferId), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("quick-task prompt carries capture identity and completion instruction", () => {
  const prompt = buildQuickTaskPrompt({
    id: "CAP-quick",
    text: "Fix the CLI typo",
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    status: "resolved",
    classification: "quick-task"
  });
  assert.match(prompt, /CAP-quick/);
  assert.match(prompt, /Fix the CLI typo/);
  assert.match(prompt, /Quick task complete/);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy90cmlhZ2UtZGlzcGF0Y2gudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NELTIgXHUyMDE0IFRyaWFnZSBhbmQgcXVpY2stdGFzayBkaXNwYXRjaCBiZWhhdmlvciB0ZXN0cy5cblxuaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5cbmltcG9ydCB7XG4gIGFwcGVuZENhcHR1cmUsXG4gIGNvdW50UGVuZGluZ0NhcHR1cmVzLFxuICBoYXNQZW5kaW5nQ2FwdHVyZXMsXG4gIGxvYWRQZW5kaW5nQ2FwdHVyZXMsXG4gIG1hcmtDYXB0dXJlRXhlY3V0ZWQsXG4gIG1hcmtDYXB0dXJlUmVzb2x2ZWQsXG59IGZyb20gXCIuLi9jYXB0dXJlcy50c1wiO1xuaW1wb3J0IHsgY2hlY2tQb3N0VW5pdEhvb2tzIH0gZnJvbSBcIi4uL3Bvc3QtdW5pdC1ob29rcy50c1wiO1xuaW1wb3J0IHtcbiAgX3Nob3VsZERpc3BhdGNoUXVpY2tUYXNrRm9yVGVzdCxcbiAgX3Nob3VsZERpc3BhdGNoVHJpYWdlRm9yVGVzdCxcbn0gZnJvbSBcIi4uL2F1dG8tcG9zdC11bml0LnRzXCI7XG5pbXBvcnQge1xuICBidWlsZFF1aWNrVGFza1Byb21wdCxcbiAgbG9hZERlZmVycmVkQ2FwdHVyZXMsXG4gIGxvYWRSZXBsYW5DYXB0dXJlcyxcbn0gZnJvbSBcIi4uL3RyaWFnZS1yZXNvbHV0aW9uLnRzXCI7XG5cbmZ1bmN0aW9uIG1ha2VQcm9qZWN0KCk6IHN0cmluZyB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC10cmlhZ2UtZGlzcGF0Y2gtXCIpKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJNMDAxLVJPQURNQVAubWRcIiksXG4gICAgW1xuICAgICAgXCIjIE0wMDFcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFNsaWNlc1wiLFxuICAgICAgXCItIFsgXSAqKlMwMTogU2xpY2UqKiBgcmlzazpsb3dgIGBkZXBlbmRzOltdYFwiLFxuICAgIF0uam9pbihcIlxcblwiKSxcbiAgKTtcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIsIFwiUzAxLVBMQU4ubWRcIiksXG4gICAgXCIjIFMwMSBQbGFuXFxuXFxuIyMgVGFza3NcXG4tIFsgXSAqKlQwMTogVGFzayoqIGBlc3Q6MTBtYFxcblwiLFxuICApO1xuICByZXR1cm4gYmFzZTtcbn1cblxudGVzdChcInBvc3QtdW5pdCBob29rcyBleGNsdWRlIHRyaWFnZSBhbmQgcXVpY2stdGFzayB1bml0c1wiLCAoKSA9PiB7XG4gIGFzc2VydC5lcXVhbChjaGVja1Bvc3RVbml0SG9va3MoXCJ0cmlhZ2UtY2FwdHVyZXNcIiwgXCJNMDAxL1MwMS90cmlhZ2VcIiwgXCIvdG1wL3Byb2plY3RcIiksIG51bGwpO1xuICBhc3NlcnQuZXF1YWwoY2hlY2tQb3N0VW5pdEhvb2tzKFwicXVpY2stdGFza1wiLCBcIk0wMDEvQ0FQLTFcIiwgXCIvdG1wL3Byb2plY3RcIiksIG51bGwpO1xufSk7XG5cbnRlc3QoXCJ0cmlhZ2UgZGlzcGF0Y2ggZ3VhcmQgZXhjbHVkZXMgc3RlcCBtb2RlLCBob29rIHVuaXRzLCB0cmlhZ2UgdW5pdHMsIGFuZCBxdWljayB0YXNrc1wiLCAoKSA9PiB7XG4gIGNvbnN0IG5vcm1hbCA9IHsgc3RlcE1vZGU6IGZhbHNlLCBjdXJyZW50VW5pdDogeyB0eXBlOiBcImV4ZWN1dGUtdGFza1wiLCBpZDogXCJNMDAxL1MwMS9UMDFcIiwgc3RhcnRlZEF0OiAxIH0gfTtcbiAgYXNzZXJ0LmVxdWFsKF9zaG91bGREaXNwYXRjaFRyaWFnZUZvclRlc3Qobm9ybWFsIGFzIGFueSksIHRydWUpO1xuICBhc3NlcnQuZXF1YWwoX3Nob3VsZERpc3BhdGNoVHJpYWdlRm9yVGVzdCh7IC4uLm5vcm1hbCwgc3RlcE1vZGU6IHRydWUgfSBhcyBhbnkpLCBmYWxzZSk7XG4gIGFzc2VydC5lcXVhbChcbiAgICBfc2hvdWxkRGlzcGF0Y2hUcmlhZ2VGb3JUZXN0KHsgc3RlcE1vZGU6IGZhbHNlLCBjdXJyZW50VW5pdDogeyB0eXBlOiBcImhvb2svcmV2aWV3XCIsIGlkOiBcIk0wMDEvUzAxL1QwMVwiLCBzdGFydGVkQXQ6IDEgfSB9IGFzIGFueSksXG4gICAgZmFsc2UsXG4gICk7XG4gIGFzc2VydC5lcXVhbChcbiAgICBfc2hvdWxkRGlzcGF0Y2hUcmlhZ2VGb3JUZXN0KHsgc3RlcE1vZGU6IGZhbHNlLCBjdXJyZW50VW5pdDogeyB0eXBlOiBcInRyaWFnZS1jYXB0dXJlc1wiLCBpZDogXCJNMDAxL1MwMS90cmlhZ2VcIiwgc3RhcnRlZEF0OiAxIH0gfSBhcyBhbnkpLFxuICAgIGZhbHNlLFxuICApO1xuICBhc3NlcnQuZXF1YWwoXG4gICAgX3Nob3VsZERpc3BhdGNoVHJpYWdlRm9yVGVzdCh7IHN0ZXBNb2RlOiBmYWxzZSwgY3VycmVudFVuaXQ6IHsgdHlwZTogXCJxdWljay10YXNrXCIsIGlkOiBcIk0wMDEvQ0FQLTFcIiwgc3RhcnRlZEF0OiAxIH0gfSBhcyBhbnkpLFxuICAgIGZhbHNlLFxuICApO1xufSk7XG5cbnRlc3QoXCJxdWljay10YXNrIGRpc3BhdGNoIGd1YXJkIHJlcXVpcmVzIHF1ZXVlZCBjYXB0dXJlcyBhbmQgYXZvaWRzIHF1aWNrLXRhc2sgcmVjdXJzaW9uXCIsICgpID0+IHtcbiAgY29uc3QgY2FwdHVyZSA9IHtcbiAgICBpZDogXCJDQVAtdGVzdFwiLFxuICAgIHRleHQ6IFwiRml4IHR5cG9cIixcbiAgICB0aW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICBzdGF0dXM6IFwicmVzb2x2ZWRcIiBhcyBjb25zdCxcbiAgICBjbGFzc2lmaWNhdGlvbjogXCJxdWljay10YXNrXCIgYXMgY29uc3QsXG4gIH07XG4gIGFzc2VydC5lcXVhbChcbiAgICBfc2hvdWxkRGlzcGF0Y2hRdWlja1Rhc2tGb3JUZXN0KHtcbiAgICAgIHN0ZXBNb2RlOiBmYWxzZSxcbiAgICAgIGN1cnJlbnRVbml0OiB7IHR5cGU6IFwiZXhlY3V0ZS10YXNrXCIsIGlkOiBcIk0wMDEvUzAxL1QwMVwiLCBzdGFydGVkQXQ6IDEgfSxcbiAgICAgIHBlbmRpbmdRdWlja1Rhc2tzOiBbY2FwdHVyZV0sXG4gICAgfSBhcyBhbnkpLFxuICAgIHRydWUsXG4gICk7XG4gIGFzc2VydC5lcXVhbChcbiAgICBfc2hvdWxkRGlzcGF0Y2hRdWlja1Rhc2tGb3JUZXN0KHtcbiAgICAgIHN0ZXBNb2RlOiBmYWxzZSxcbiAgICAgIGN1cnJlbnRVbml0OiB7IHR5cGU6IFwicXVpY2stdGFza1wiLCBpZDogXCJNMDAxL0NBUC10ZXN0XCIsIHN0YXJ0ZWRBdDogMSB9LFxuICAgICAgcGVuZGluZ1F1aWNrVGFza3M6IFtjYXB0dXJlXSxcbiAgICB9IGFzIGFueSksXG4gICAgZmFsc2UsXG4gICk7XG4gIGFzc2VydC5lcXVhbChcbiAgICBfc2hvdWxkRGlzcGF0Y2hRdWlja1Rhc2tGb3JUZXN0KHtcbiAgICAgIHN0ZXBNb2RlOiBmYWxzZSxcbiAgICAgIGN1cnJlbnRVbml0OiB7IHR5cGU6IFwiZXhlY3V0ZS10YXNrXCIsIGlkOiBcIk0wMDEvUzAxL1QwMVwiLCBzdGFydGVkQXQ6IDEgfSxcbiAgICAgIHBlbmRpbmdRdWlja1Rhc2tzOiBbXSxcbiAgICB9IGFzIGFueSksXG4gICAgZmFsc2UsXG4gICk7XG59KTtcblxudGVzdChcImNhcHR1cmUgbGlmZWN5Y2xlIGV4cG9zZXMgcGVuZGluZywgcmVwbGFuLCBkZWZlcnJlZCwgYW5kIGV4ZWN1dGVkIHN0YXRlc1wiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlUHJvamVjdCgpO1xuICB0cnkge1xuICAgIGNvbnN0IHBlbmRpbmdJZCA9IGFwcGVuZENhcHR1cmUoYmFzZSwgXCJOZWVkIGEgcXVpY2sgZm9sbG93LXVwLlwiKTtcbiAgICBjb25zdCByZXBsYW5JZCA9IGFwcGVuZENhcHR1cmUoYmFzZSwgXCJQbGFuIG5lZWRzIGEgbmV3IHRhc2suXCIpO1xuICAgIGNvbnN0IGRlZmVySWQgPSBhcHBlbmRDYXB0dXJlKGJhc2UsIFwiQ3JlYXRlIGEgZnV0dXJlIG1pbGVzdG9uZS5cIik7XG5cbiAgICBhc3NlcnQuZXF1YWwoaGFzUGVuZGluZ0NhcHR1cmVzKGJhc2UpLCB0cnVlKTtcbiAgICBhc3NlcnQuZXF1YWwoY291bnRQZW5kaW5nQ2FwdHVyZXMoYmFzZSksIDMpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwobG9hZFBlbmRpbmdDYXB0dXJlcyhiYXNlKS5tYXAoKGVudHJ5KSA9PiBlbnRyeS5pZCkuc29ydCgpLCBbZGVmZXJJZCwgcGVuZGluZ0lkLCByZXBsYW5JZF0uc29ydCgpKTtcblxuICAgIG1hcmtDYXB0dXJlUmVzb2x2ZWQoYmFzZSwgcmVwbGFuSWQsIFwicmVwbGFuXCIsIFwicmVwbGFuIHNsaWNlXCIsIFwiTmVlZCBwbGFuIHVwZGF0ZVwiLCBcIk0wMDFcIik7XG4gICAgbWFya0NhcHR1cmVSZXNvbHZlZChiYXNlLCBkZWZlcklkLCBcImRlZmVyXCIsIFwiZGVmZXIgbWlsZXN0b25lXCIsIFwiT3V0IG9mIGN1cnJlbnQgc2NvcGVcIiwgXCJNMDAxXCIpO1xuICAgIG1hcmtDYXB0dXJlRXhlY3V0ZWQoYmFzZSwgcmVwbGFuSWQpO1xuXG4gICAgYXNzZXJ0LmVxdWFsKGxvYWRSZXBsYW5DYXB0dXJlcyhiYXNlKS5zb21lKChlbnRyeSkgPT4gZW50cnkuaWQgPT09IHJlcGxhbklkKSwgdHJ1ZSk7XG4gICAgYXNzZXJ0LmVxdWFsKGxvYWREZWZlcnJlZENhcHR1cmVzKGJhc2UpLnNvbWUoKGVudHJ5KSA9PiBlbnRyeS5pZCA9PT0gZGVmZXJJZCksIHRydWUpO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwicXVpY2stdGFzayBwcm9tcHQgY2FycmllcyBjYXB0dXJlIGlkZW50aXR5IGFuZCBjb21wbGV0aW9uIGluc3RydWN0aW9uXCIsICgpID0+IHtcbiAgY29uc3QgcHJvbXB0ID0gYnVpbGRRdWlja1Rhc2tQcm9tcHQoe1xuICAgIGlkOiBcIkNBUC1xdWlja1wiLFxuICAgIHRleHQ6IFwiRml4IHRoZSBDTEkgdHlwb1wiLFxuICAgIHRpbWVzdGFtcDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgIHN0YXR1czogXCJyZXNvbHZlZFwiLFxuICAgIGNsYXNzaWZpY2F0aW9uOiBcInF1aWNrLXRhc2tcIixcbiAgfSk7XG5cbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL0NBUC1xdWljay8pO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvRml4IHRoZSBDTEkgdHlwby8pO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvUXVpY2sgdGFzayBjb21wbGV0ZS8pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFFQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxXQUFXLFFBQVEscUJBQXFCO0FBQzlELFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFFdkI7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
