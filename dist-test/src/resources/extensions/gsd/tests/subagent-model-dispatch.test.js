import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validatePreferences } from "../preferences-validation.js";
import {
  buildGateEvaluatePrompt,
  buildParallelResearchSlicesPrompt,
  buildReactiveExecutePrompt
} from "../auto-prompts.js";
function writeReactiveFixture(repo) {
  const gsd = join(repo, ".gsd", "milestones", "M001", "slices", "S01");
  mkdirSync(join(gsd, "tasks"), { recursive: true });
  writeFileSync(
    join(gsd, "S01-PLAN.md"),
    [
      "# S01: Test Slice",
      "",
      "**Goal:** Verify model injection",
      "**Demo:** Model appears in subagent prompt",
      "",
      "## Tasks",
      "",
      "- [ ] **T01: Task One** `est:15m`",
      "  Do something.",
      ""
    ].join("\n")
  );
  writeFileSync(
    join(gsd, "tasks", "T01-PLAN.md"),
    [
      "# T01: Task One",
      "",
      "## Description",
      "Do something.",
      "",
      "## Inputs",
      "",
      "- `src/config.json` \u2014 Config",
      "",
      "## Expected Output",
      "",
      "- `src/out.ts` \u2014 Result"
    ].join("\n")
  );
}
test("reactive_execution subagent_model is preserved in validated preferences", () => {
  const result = validatePreferences({
    reactive_execution: {
      enabled: true,
      max_parallel: 2,
      isolation_mode: "same-tree",
      subagent_model: "claude-opus-4-6"
    }
  });
  assert.equal(result.errors.length, 0);
  assert.equal(result.preferences.reactive_execution?.subagent_model, "claude-opus-4-6");
});
test("reactive_execution subagent_model rejects empty string", () => {
  const result = validatePreferences({
    reactive_execution: {
      enabled: true,
      max_parallel: 2,
      isolation_mode: "same-tree",
      subagent_model: ""
    }
  });
  assert.ok(result.errors.some((e) => e.includes("subagent_model")));
});
test("buildReactiveExecutePrompt injects subagent model when provided", async (t) => {
  const repo = mkdtempSync(join(tmpdir(), "gsd-subagent-model-reactive-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeReactiveFixture(repo);
  const prompt = await buildReactiveExecutePrompt(
    "M001",
    "Test Milestone",
    "S01",
    "Test Slice",
    ["T01"],
    repo,
    "claude-opus-4-6"
  );
  assert.match(prompt, /model: "claude-opus-4-6"/);
  assert.match(prompt, /Context Mode \(execution lane\):/);
  assert.match(prompt, /## Context Mode/);
});
test("buildReactiveExecutePrompt omits model instruction when subagentModel is omitted", async (t) => {
  const repo = mkdtempSync(join(tmpdir(), "gsd-subagent-model-none-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeReactiveFixture(repo);
  const prompt = await buildReactiveExecutePrompt(
    "M001",
    "Test Milestone",
    "S01",
    "Test Slice",
    ["T01"],
    repo
  );
  assert.doesNotMatch(prompt, /with model:/);
});
test("buildParallelResearchSlicesPrompt injects subagent model for each slice", async (t) => {
  const repo = mkdtempSync(join(tmpdir(), "gsd-subagent-model-parallel-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
  const prompt = await buildParallelResearchSlicesPrompt(
    "M001",
    "Test Milestone",
    [{ id: "S01", title: "Research Slice" }],
    repo,
    "claude-opus-4-6"
  );
  assert.match(prompt, /model: "claude-opus-4-6"/);
});
test("buildGateEvaluatePrompt uses nested context guidance and model instruction", async (t) => {
  const { closeDatabase, insertGateRow, insertMilestone, insertSlice, openDatabase } = await import("../gsd-db.js");
  const repo = mkdtempSync(join(tmpdir(), "gsd-subagent-model-gate-"));
  t.after(() => {
    try {
      closeDatabase();
    } catch {
    }
    rmSync(repo, { recursive: true, force: true });
  });
  const sliceDir = join(repo, ".gsd", "milestones", "M001", "slices", "S01");
  mkdirSync(sliceDir, { recursive: true });
  writeFileSync(join(sliceDir, "S01-PLAN.md"), "# S01 Plan\n\n## Verification\n- Run checks.\n");
  openDatabase(join(repo, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test Milestone", status: "active", depends_on: [] });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Test Slice",
    status: "planned",
    risk: "low",
    depends: [],
    demo: "",
    sequence: 1
  });
  insertGateRow({
    milestoneId: "M001",
    sliceId: "S01",
    gateId: "Q3",
    scope: "slice"
  });
  const prompt = await buildGateEvaluatePrompt(
    "M001",
    "Test Milestone",
    "S01",
    "Test Slice",
    repo,
    "claude-opus-4-6"
  );
  assert.match(prompt, /Context Mode \(verification lane\):/);
  assert.match(prompt, /## Context Mode/);
  assert.match(prompt, /model: "claude-opus-4-6"/);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9zdWJhZ2VudC1tb2RlbC1kaXNwYXRjaC50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBHU0QtMiBcdTIwMTQgU3ViYWdlbnQgbW9kZWwgZGlzcGF0Y2ggYmVoYXZpb3IgdGVzdHMuXG5cbmltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuXG5pbXBvcnQgeyB2YWxpZGF0ZVByZWZlcmVuY2VzIH0gZnJvbSBcIi4uL3ByZWZlcmVuY2VzLXZhbGlkYXRpb24udHNcIjtcbmltcG9ydCB7XG4gIGJ1aWxkR2F0ZUV2YWx1YXRlUHJvbXB0LFxuICBidWlsZFBhcmFsbGVsUmVzZWFyY2hTbGljZXNQcm9tcHQsXG4gIGJ1aWxkUmVhY3RpdmVFeGVjdXRlUHJvbXB0LFxufSBmcm9tIFwiLi4vYXV0by1wcm9tcHRzLnRzXCI7XG5cbmZ1bmN0aW9uIHdyaXRlUmVhY3RpdmVGaXh0dXJlKHJlcG86IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBnc2QgPSBqb2luKHJlcG8sIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIpO1xuICBta2RpclN5bmMoam9pbihnc2QsIFwidGFza3NcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4oZ3NkLCBcIlMwMS1QTEFOLm1kXCIpLFxuICAgIFtcbiAgICAgIFwiIyBTMDE6IFRlc3QgU2xpY2VcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIioqR29hbDoqKiBWZXJpZnkgbW9kZWwgaW5qZWN0aW9uXCIsXG4gICAgICBcIioqRGVtbzoqKiBNb2RlbCBhcHBlYXJzIGluIHN1YmFnZW50IHByb21wdFwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMgVGFza3NcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIi0gWyBdICoqVDAxOiBUYXNrIE9uZSoqIGBlc3Q6MTVtYFwiLFxuICAgICAgXCIgIERvIHNvbWV0aGluZy5cIixcbiAgICAgIFwiXCIsXG4gICAgXS5qb2luKFwiXFxuXCIpLFxuICApO1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4oZ3NkLCBcInRhc2tzXCIsIFwiVDAxLVBMQU4ubWRcIiksXG4gICAgW1xuICAgICAgXCIjIFQwMTogVGFzayBPbmVcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIERlc2NyaXB0aW9uXCIsXG4gICAgICBcIkRvIHNvbWV0aGluZy5cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIElucHV0c1wiLFxuICAgICAgXCJcIixcbiAgICAgIFwiLSBgc3JjL2NvbmZpZy5qc29uYCBcdTIwMTQgQ29uZmlnXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBFeHBlY3RlZCBPdXRwdXRcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIi0gYHNyYy9vdXQudHNgIFx1MjAxNCBSZXN1bHRcIixcbiAgICBdLmpvaW4oXCJcXG5cIiksXG4gICk7XG59XG5cbnRlc3QoXCJyZWFjdGl2ZV9leGVjdXRpb24gc3ViYWdlbnRfbW9kZWwgaXMgcHJlc2VydmVkIGluIHZhbGlkYXRlZCBwcmVmZXJlbmNlc1wiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHZhbGlkYXRlUHJlZmVyZW5jZXMoe1xuICAgIHJlYWN0aXZlX2V4ZWN1dGlvbjoge1xuICAgICAgZW5hYmxlZDogdHJ1ZSxcbiAgICAgIG1heF9wYXJhbGxlbDogMixcbiAgICAgIGlzb2xhdGlvbl9tb2RlOiBcInNhbWUtdHJlZVwiLFxuICAgICAgc3ViYWdlbnRfbW9kZWw6IFwiY2xhdWRlLW9wdXMtNC02XCIsXG4gICAgfSxcbiAgfSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQuZXJyb3JzLmxlbmd0aCwgMCk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQucHJlZmVyZW5jZXMucmVhY3RpdmVfZXhlY3V0aW9uPy5zdWJhZ2VudF9tb2RlbCwgXCJjbGF1ZGUtb3B1cy00LTZcIik7XG59KTtcblxudGVzdChcInJlYWN0aXZlX2V4ZWN1dGlvbiBzdWJhZ2VudF9tb2RlbCByZWplY3RzIGVtcHR5IHN0cmluZ1wiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHZhbGlkYXRlUHJlZmVyZW5jZXMoe1xuICAgIHJlYWN0aXZlX2V4ZWN1dGlvbjoge1xuICAgICAgZW5hYmxlZDogdHJ1ZSxcbiAgICAgIG1heF9wYXJhbGxlbDogMixcbiAgICAgIGlzb2xhdGlvbl9tb2RlOiBcInNhbWUtdHJlZVwiLFxuICAgICAgc3ViYWdlbnRfbW9kZWw6IFwiXCIsXG4gICAgfSBhcyBhbnksXG4gIH0pO1xuICBhc3NlcnQub2socmVzdWx0LmVycm9ycy5zb21lKChlKSA9PiBlLmluY2x1ZGVzKFwic3ViYWdlbnRfbW9kZWxcIikpKTtcbn0pO1xuXG50ZXN0KFwiYnVpbGRSZWFjdGl2ZUV4ZWN1dGVQcm9tcHQgaW5qZWN0cyBzdWJhZ2VudCBtb2RlbCB3aGVuIHByb3ZpZGVkXCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IHJlcG8gPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1zdWJhZ2VudC1tb2RlbC1yZWFjdGl2ZS1cIikpO1xuICB0LmFmdGVyKCgpID0+IHJtU3luYyhyZXBvLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuICB3cml0ZVJlYWN0aXZlRml4dHVyZShyZXBvKTtcblxuICBjb25zdCBwcm9tcHQgPSBhd2FpdCBidWlsZFJlYWN0aXZlRXhlY3V0ZVByb21wdChcbiAgICBcIk0wMDFcIixcbiAgICBcIlRlc3QgTWlsZXN0b25lXCIsXG4gICAgXCJTMDFcIixcbiAgICBcIlRlc3QgU2xpY2VcIixcbiAgICBbXCJUMDFcIl0sXG4gICAgcmVwbyxcbiAgICBcImNsYXVkZS1vcHVzLTQtNlwiLFxuICApO1xuXG4gIGFzc2VydC5tYXRjaChwcm9tcHQsIC9tb2RlbDogXCJjbGF1ZGUtb3B1cy00LTZcIi8pO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvQ29udGV4dCBNb2RlIFxcKGV4ZWN1dGlvbiBsYW5lXFwpOi8pO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvIyMgQ29udGV4dCBNb2RlLyk7XG59KTtcblxudGVzdChcImJ1aWxkUmVhY3RpdmVFeGVjdXRlUHJvbXB0IG9taXRzIG1vZGVsIGluc3RydWN0aW9uIHdoZW4gc3ViYWdlbnRNb2RlbCBpcyBvbWl0dGVkXCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IHJlcG8gPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1zdWJhZ2VudC1tb2RlbC1ub25lLVwiKSk7XG4gIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKHJlcG8sIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG4gIHdyaXRlUmVhY3RpdmVGaXh0dXJlKHJlcG8pO1xuXG4gIGNvbnN0IHByb21wdCA9IGF3YWl0IGJ1aWxkUmVhY3RpdmVFeGVjdXRlUHJvbXB0KFxuICAgIFwiTTAwMVwiLFxuICAgIFwiVGVzdCBNaWxlc3RvbmVcIixcbiAgICBcIlMwMVwiLFxuICAgIFwiVGVzdCBTbGljZVwiLFxuICAgIFtcIlQwMVwiXSxcbiAgICByZXBvLFxuICApO1xuXG4gIGFzc2VydC5kb2VzTm90TWF0Y2gocHJvbXB0LCAvd2l0aCBtb2RlbDovKTtcbn0pO1xuXG50ZXN0KFwiYnVpbGRQYXJhbGxlbFJlc2VhcmNoU2xpY2VzUHJvbXB0IGluamVjdHMgc3ViYWdlbnQgbW9kZWwgZm9yIGVhY2ggc2xpY2VcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgcmVwbyA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXN1YmFnZW50LW1vZGVsLXBhcmFsbGVsLVwiKSk7XG4gIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKHJlcG8sIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG4gIG1rZGlyU3luYyhqb2luKHJlcG8sIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICBjb25zdCBwcm9tcHQgPSBhd2FpdCBidWlsZFBhcmFsbGVsUmVzZWFyY2hTbGljZXNQcm9tcHQoXG4gICAgXCJNMDAxXCIsXG4gICAgXCJUZXN0IE1pbGVzdG9uZVwiLFxuICAgIFt7IGlkOiBcIlMwMVwiLCB0aXRsZTogXCJSZXNlYXJjaCBTbGljZVwiIH1dLFxuICAgIHJlcG8sXG4gICAgXCJjbGF1ZGUtb3B1cy00LTZcIixcbiAgKTtcblxuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvbW9kZWw6IFwiY2xhdWRlLW9wdXMtNC02XCIvKTtcbn0pO1xuXG50ZXN0KFwiYnVpbGRHYXRlRXZhbHVhdGVQcm9tcHQgdXNlcyBuZXN0ZWQgY29udGV4dCBndWlkYW5jZSBhbmQgbW9kZWwgaW5zdHJ1Y3Rpb25cIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgeyBjbG9zZURhdGFiYXNlLCBpbnNlcnRHYXRlUm93LCBpbnNlcnRNaWxlc3RvbmUsIGluc2VydFNsaWNlLCBvcGVuRGF0YWJhc2UgfSA9IGF3YWl0IGltcG9ydChcIi4uL2dzZC1kYi50c1wiKTtcbiAgY29uc3QgcmVwbyA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXN1YmFnZW50LW1vZGVsLWdhdGUtXCIpKTtcbiAgdC5hZnRlcigoKSA9PiB7XG4gICAgdHJ5IHsgY2xvc2VEYXRhYmFzZSgpOyB9IGNhdGNoIHsgLyogbm9vcCAqLyB9XG4gICAgcm1TeW5jKHJlcG8sIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfSk7XG5cbiAgY29uc3Qgc2xpY2VEaXIgPSBqb2luKHJlcG8sIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIpO1xuICBta2RpclN5bmMoc2xpY2VEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oc2xpY2VEaXIsIFwiUzAxLVBMQU4ubWRcIiksIFwiIyBTMDEgUGxhblxcblxcbiMjIFZlcmlmaWNhdGlvblxcbi0gUnVuIGNoZWNrcy5cXG5cIik7XG4gIG9wZW5EYXRhYmFzZShqb2luKHJlcG8sIFwiLmdzZFwiLCBcImdzZC5kYlwiKSk7XG4gIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdCBNaWxlc3RvbmVcIiwgc3RhdHVzOiBcImFjdGl2ZVwiLCBkZXBlbmRzX29uOiBbXSB9KTtcbiAgaW5zZXJ0U2xpY2Uoe1xuICAgIGlkOiBcIlMwMVwiLFxuICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICB0aXRsZTogXCJUZXN0IFNsaWNlXCIsXG4gICAgc3RhdHVzOiBcInBsYW5uZWRcIixcbiAgICByaXNrOiBcImxvd1wiLFxuICAgIGRlcGVuZHM6IFtdLFxuICAgIGRlbW86IFwiXCIsXG4gICAgc2VxdWVuY2U6IDEsXG4gIH0pO1xuICBpbnNlcnRHYXRlUm93KHtcbiAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgc2xpY2VJZDogXCJTMDFcIixcbiAgICBnYXRlSWQ6IFwiUTNcIixcbiAgICBzY29wZTogXCJzbGljZVwiLFxuICB9KTtcblxuICBjb25zdCBwcm9tcHQgPSBhd2FpdCBidWlsZEdhdGVFdmFsdWF0ZVByb21wdChcbiAgICBcIk0wMDFcIixcbiAgICBcIlRlc3QgTWlsZXN0b25lXCIsXG4gICAgXCJTMDFcIixcbiAgICBcIlRlc3QgU2xpY2VcIixcbiAgICByZXBvLFxuICAgIFwiY2xhdWRlLW9wdXMtNC02XCIsXG4gICk7XG5cbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL0NvbnRleHQgTW9kZSBcXCh2ZXJpZmljYXRpb24gbGFuZVxcKTovKTtcbiAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgLyMjIENvbnRleHQgTW9kZS8pO1xuICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvbW9kZWw6IFwiY2xhdWRlLW9wdXMtNC02XCIvKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBRUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUNuQixTQUFTLGFBQWEsV0FBVyxRQUFRLHFCQUFxQjtBQUM5RCxTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBRXZCLFNBQVMsMkJBQTJCO0FBQ3BDO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUVQLFNBQVMscUJBQXFCLE1BQW9CO0FBQ2hELFFBQU0sTUFBTSxLQUFLLE1BQU0sUUFBUSxjQUFjLFFBQVEsVUFBVSxLQUFLO0FBQ3BFLFlBQVUsS0FBSyxLQUFLLE9BQU8sR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ2pEO0FBQUEsSUFDRSxLQUFLLEtBQUssYUFBYTtBQUFBLElBQ3ZCO0FBQUEsTUFDRTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLElBQ0YsRUFBRSxLQUFLLElBQUk7QUFBQSxFQUNiO0FBQ0E7QUFBQSxJQUNFLEtBQUssS0FBSyxTQUFTLGFBQWE7QUFBQSxJQUNoQztBQUFBLE1BQ0U7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLElBQ0YsRUFBRSxLQUFLLElBQUk7QUFBQSxFQUNiO0FBQ0Y7QUFFQSxLQUFLLDJFQUEyRSxN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
