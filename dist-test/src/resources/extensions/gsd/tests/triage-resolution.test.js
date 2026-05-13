import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendCapture, markCaptureResolved, markCaptureExecuted, loadAllCaptures, loadActionableCaptures } from "../captures.js";
import { executeInject, executeReplan, detectFileOverlap, loadDeferredCaptures, loadReplanCaptures, buildQuickTaskPrompt, executeTriageResolutions, ensureDeferMilestoneDir } from "../triage-resolution.js";
function makeTempDir(prefix) {
  const dir = join(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}
function setupPlanFile(tmp, mid, sid, content) {
  const planDir = join(tmp, ".gsd", "milestones", mid, "slices", sid);
  mkdirSync(planDir, { recursive: true });
  const planPath = join(planDir, `${sid}-PLAN.md`);
  writeFileSync(planPath, content, "utf-8");
  return planPath;
}
const SAMPLE_PLAN = `# S01: Test Slice

**Goal:** Test
**Demo:** Test

## Must-Haves

- Something works

## Tasks

- [x] **T01: First task** \`est:1h\`
  - Why: Setup
  - Files: \`src/foo.ts\`, \`src/bar.ts\`
  - Do: Build it
  - Done when: Tests pass

- [ ] **T02: Second task** \`est:1h\`
  - Why: Feature
  - Files: \`src/baz.ts\`, \`src/qux.ts\`
  - Do: Build it
  - Done when: Tests pass

- [ ] **T03: Third task** \`est:30m\`
  - Why: Polish
  - Files: \`src/qux.ts\`, \`src/config.ts\`
  - Do: Build it
  - Done when: Tests pass

## Files Likely Touched

- \`src/foo.ts\`
- \`src/bar.ts\`
`;
test("resolution: executeInject appends a new task to the plan", () => {
  const tmp = makeTempDir("res-inject");
  try {
    const planPath = setupPlanFile(tmp, "M001", "S01", SAMPLE_PLAN);
    const captureId = appendCapture(tmp, "add retry logic");
    const captures = loadAllCaptures(tmp);
    const capture = captures[0];
    const newId = executeInject(tmp, "M001", "S01", capture);
    assert.strictEqual(newId, "T04", "should be T04 (next after T03)");
    const updated = readFileSync(planPath, "utf-8");
    assert.ok(updated.includes("**T04:"), "should have T04 in plan");
    assert.ok(updated.includes(capture.text), "should include capture text");
    assert.ok(updated.includes("## Files Likely Touched"), "should preserve files section");
    const t04Pos = updated.indexOf("**T04:");
    const filesPos = updated.indexOf("## Files Likely Touched");
    assert.ok(t04Pos < filesPos, "T04 should be before Files section");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("resolution: executeInject returns null when plan doesn't exist", () => {
  const tmp = makeTempDir("res-inject-noplan");
  try {
    const captureId = appendCapture(tmp, "some task");
    const captures = loadAllCaptures(tmp);
    const result = executeInject(tmp, "M001", "S01", captures[0]);
    assert.strictEqual(result, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("resolution: executeReplan writes REPLAN-TRIGGER.md", () => {
  const tmp = makeTempDir("res-replan");
  try {
    setupPlanFile(tmp, "M001", "S01", SAMPLE_PLAN);
    const captureId = appendCapture(tmp, "approach is wrong, need different strategy");
    const captures = loadAllCaptures(tmp);
    const capture = captures[0];
    const result = executeReplan(tmp, "M001", "S01", capture);
    assert.strictEqual(result, true);
    const triggerPath = join(
      tmp,
      ".gsd",
      "milestones",
      "M001",
      "slices",
      "S01",
      "S01-REPLAN-TRIGGER.md"
    );
    assert.ok(existsSync(triggerPath), "trigger file should exist");
    const content = readFileSync(triggerPath, "utf-8");
    assert.ok(content.includes(capture.id), "should include capture ID");
    assert.ok(content.includes(capture.text), "should include capture text");
    assert.ok(content.includes("# Replan Trigger"), "should have header");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("resolution: detectFileOverlap finds overlapping incomplete tasks", () => {
  const overlaps = detectFileOverlap(["src/qux.ts"], SAMPLE_PLAN);
  assert.deepStrictEqual(overlaps, ["T02", "T03"]);
});
test("resolution: detectFileOverlap ignores completed tasks", () => {
  const overlaps = detectFileOverlap(["src/foo.ts"], SAMPLE_PLAN);
  assert.deepStrictEqual(overlaps, []);
});
test("resolution: detectFileOverlap returns empty when no overlap", () => {
  const overlaps = detectFileOverlap(["src/unrelated.ts"], SAMPLE_PLAN);
  assert.deepStrictEqual(overlaps, []);
});
test("resolution: detectFileOverlap returns empty for empty affected files", () => {
  assert.deepStrictEqual(detectFileOverlap([], SAMPLE_PLAN), []);
});
test("resolution: detectFileOverlap is case-insensitive", () => {
  const overlaps = detectFileOverlap(["SRC/QUX.TS"], SAMPLE_PLAN);
  assert.deepStrictEqual(overlaps, ["T02", "T03"]);
});
test("resolution: loadDeferredCaptures returns only deferred captures", () => {
  const tmp = makeTempDir("res-deferred");
  try {
    const id1 = appendCapture(tmp, "deferred one");
    const id2 = appendCapture(tmp, "note one");
    const id3 = appendCapture(tmp, "deferred two");
    markCaptureResolved(tmp, id1, "defer", "deferred to S03", "future work");
    markCaptureResolved(tmp, id2, "note", "acknowledged", "just a note");
    markCaptureResolved(tmp, id3, "defer", "deferred to S04", "later");
    const deferred = loadDeferredCaptures(tmp);
    assert.strictEqual(deferred.length, 2);
    assert.strictEqual(deferred[0].id, id1);
    assert.strictEqual(deferred[1].id, id3);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("resolution: loadReplanCaptures returns only replan captures", () => {
  const tmp = makeTempDir("res-replan-load");
  try {
    const id1 = appendCapture(tmp, "needs replan");
    const id2 = appendCapture(tmp, "just a note");
    markCaptureResolved(tmp, id1, "replan", "replan triggered", "approach changed");
    markCaptureResolved(tmp, id2, "note", "acknowledged", "info only");
    const replans = loadReplanCaptures(tmp);
    assert.strictEqual(replans.length, 1);
    assert.strictEqual(replans[0].id, id1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("resolution: buildQuickTaskPrompt includes capture text and ID", () => {
  const prompt = buildQuickTaskPrompt({
    id: "CAP-abc123",
    text: "add retry logic to OAuth",
    timestamp: "2026-03-15T20:00:00Z",
    status: "resolved",
    classification: "quick-task"
  });
  assert.ok(prompt.includes("CAP-abc123"), "should include capture ID");
  assert.ok(prompt.includes("add retry logic to OAuth"), "should include capture text");
  assert.ok(prompt.includes("Quick Task"), "should have Quick Task header");
  assert.ok(prompt.includes("Do NOT modify"), "should warn about plan files");
  assert.ok(
    prompt.includes("Verify the issue still exists"),
    "should instruct agent to verify issue still exists (#2872)"
  );
  assert.ok(
    prompt.includes("Already resolved"),
    "should instruct agent to report already resolved if fixed (#2872)"
  );
});
test("resolution: markCaptureExecuted adds Executed field to capture", () => {
  const tmp = makeTempDir("res-executed");
  try {
    const id = appendCapture(tmp, "fix the button");
    markCaptureResolved(tmp, id, "quick-task", "execute as quick-task", "small fix");
    markCaptureExecuted(tmp, id);
    const all = loadAllCaptures(tmp);
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].executed, true, "should be marked as executed");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("resolution: markCaptureExecuted is idempotent", () => {
  const tmp = makeTempDir("res-executed-idem");
  try {
    const id = appendCapture(tmp, "fix something");
    markCaptureResolved(tmp, id, "inject", "inject task", "needed");
    markCaptureExecuted(tmp, id);
    markCaptureExecuted(tmp, id);
    const filePath = join(tmp, ".gsd", "CAPTURES.md");
    const content = readFileSync(filePath, "utf-8");
    const executedMatches = content.match(/\*\*Executed:\*\*/g);
    assert.strictEqual(executedMatches?.length, 1, "should have exactly one Executed field");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("resolution: executeTriageResolutions stamps note captures as executed", () => {
  const tmp = makeTempDir("res-exec-note");
  try {
    const id = appendCapture(tmp, "FYI the API changed");
    markCaptureResolved(tmp, id, "note", "acknowledged", "informational");
    const result = executeTriageResolutions(tmp, "M001", "S01");
    const all = loadAllCaptures(tmp);
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].executed, true, "note capture should be marked as executed");
    assert.ok(
      result.actions.some((a) => a.includes(id) && a.includes("Note acknowledged")),
      "actions should include a note-acknowledged entry"
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("resolution: executeTriageResolutions does not double-stamp already-executed notes", () => {
  const tmp = makeTempDir("res-exec-note-idem");
  try {
    const id = appendCapture(tmp, "informational note");
    markCaptureResolved(tmp, id, "note", "acknowledged", "info");
    executeTriageResolutions(tmp, "M001", "S01");
    const result2 = executeTriageResolutions(tmp, "M001", "S01");
    assert.strictEqual(result2.actions.length, 0, "second call should produce no actions");
    const filePath = join(tmp, ".gsd", "CAPTURES.md");
    const content = readFileSync(filePath, "utf-8");
    const executedMatches = content.match(/\*\*Executed:\*\*/g);
    assert.strictEqual(executedMatches?.length, 1, "should have exactly one Executed field");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("resolution: loadActionableCaptures returns only unexecuted actionable captures", () => {
  const tmp = makeTempDir("res-actionable");
  try {
    const id1 = appendCapture(tmp, "inject this task");
    const id2 = appendCapture(tmp, "quick fix");
    const id3 = appendCapture(tmp, "just a note");
    const id4 = appendCapture(tmp, "replan needed");
    const id5 = appendCapture(tmp, "already executed inject");
    markCaptureResolved(tmp, id1, "inject", "add task", "needed");
    markCaptureResolved(tmp, id2, "quick-task", "quick fix", "small");
    markCaptureResolved(tmp, id3, "note", "acknowledged", "info");
    markCaptureResolved(tmp, id4, "replan", "replan triggered", "approach changed");
    markCaptureResolved(tmp, id5, "inject", "add task", "needed");
    markCaptureExecuted(tmp, id5);
    const actionable = loadActionableCaptures(tmp);
    assert.strictEqual(actionable.length, 3, "should have 3 actionable captures");
    assert.deepStrictEqual(
      actionable.map((c) => c.id),
      [id1, id2, id4],
      "should include inject, quick-task, replan but not note or executed inject"
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("resolution: executeTriageResolutions executes inject captures", () => {
  const tmp = makeTempDir("res-exec-inject");
  try {
    setupPlanFile(tmp, "M001", "S01", SAMPLE_PLAN);
    const id1 = appendCapture(tmp, "add error handling");
    const id2 = appendCapture(tmp, "add retry logic");
    markCaptureResolved(tmp, id1, "inject", "add task", "needed");
    markCaptureResolved(tmp, id2, "inject", "add task", "also needed");
    const result = executeTriageResolutions(tmp, "M001", "S01");
    assert.strictEqual(result.injected, 2, "should inject 2 tasks");
    assert.strictEqual(result.replanned, 0);
    assert.strictEqual(result.quickTasks.length, 0);
    const planPath = join(tmp, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md");
    const planContent = readFileSync(planPath, "utf-8");
    assert.ok(planContent.includes("**T04:"), "should have T04");
    assert.ok(planContent.includes("**T05:"), "should have T05");
    const all = loadAllCaptures(tmp);
    assert.strictEqual(all[0].executed, true, "first capture should be executed");
    assert.strictEqual(all[1].executed, true, "second capture should be executed");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("resolution: executeTriageResolutions executes replan captures", () => {
  const tmp = makeTempDir("res-exec-replan");
  try {
    setupPlanFile(tmp, "M001", "S01", SAMPLE_PLAN);
    const id = appendCapture(tmp, "approach is wrong");
    markCaptureResolved(tmp, id, "replan", "replan triggered", "wrong approach");
    const result = executeTriageResolutions(tmp, "M001", "S01");
    assert.strictEqual(result.injected, 0);
    assert.strictEqual(result.replanned, 1, "should trigger 1 replan");
    assert.strictEqual(result.quickTasks.length, 0);
    const triggerPath = join(
      tmp,
      ".gsd",
      "milestones",
      "M001",
      "slices",
      "S01",
      "S01-REPLAN-TRIGGER.md"
    );
    assert.ok(existsSync(triggerPath), "replan trigger should exist");
    const all = loadAllCaptures(tmp);
    assert.strictEqual(all[0].executed, true, "capture should be executed");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("resolution: executeTriageResolutions queues quick-tasks without executing inline", () => {
  const tmp = makeTempDir("res-exec-qt");
  try {
    const id = appendCapture(tmp, "fix typo in readme");
    markCaptureResolved(tmp, id, "quick-task", "execute as quick-task", "small fix");
    const result = executeTriageResolutions(tmp, "M001", "S01");
    assert.strictEqual(result.injected, 0);
    assert.strictEqual(result.replanned, 0);
    assert.strictEqual(result.quickTasks.length, 1, "should queue 1 quick-task");
    assert.strictEqual(result.quickTasks[0].id, id);
    const all = loadAllCaptures(tmp);
    assert.ok(!all[0].executed, "quick-task should not be executed yet");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("resolution: executeTriageResolutions handles mixed classifications", () => {
  const tmp = makeTempDir("res-exec-mixed");
  try {
    setupPlanFile(tmp, "M001", "S01", SAMPLE_PLAN);
    const id1 = appendCapture(tmp, "inject a task");
    const id2 = appendCapture(tmp, "quick fix typo");
    const id3 = appendCapture(tmp, "just a note");
    const id4 = appendCapture(tmp, "defer to later");
    markCaptureResolved(tmp, id1, "inject", "add task", "needed");
    markCaptureResolved(tmp, id2, "quick-task", "quick fix", "small");
    markCaptureResolved(tmp, id3, "note", "acknowledged", "info");
    markCaptureResolved(tmp, id4, "defer", "deferred", "later");
    const result = executeTriageResolutions(tmp, "M001", "S01");
    assert.strictEqual(result.injected, 1, "should inject 1 task");
    assert.strictEqual(result.replanned, 0);
    assert.strictEqual(result.quickTasks.length, 1, "should queue 1 quick-task");
    assert.strictEqual(result.actions.length, 3, "should have 3 action entries (inject + quick-task + note acknowledged; defer excluded)");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("resolution: executeTriageResolutions skips already-executed captures", () => {
  const tmp = makeTempDir("res-exec-skip");
  try {
    setupPlanFile(tmp, "M001", "S01", SAMPLE_PLAN);
    const id = appendCapture(tmp, "already done");
    markCaptureResolved(tmp, id, "inject", "add task", "needed");
    markCaptureExecuted(tmp, id);
    const result = executeTriageResolutions(tmp, "M001", "S01");
    assert.strictEqual(result.injected, 0, "should not inject again");
    assert.strictEqual(result.actions.length, 0, "should have no actions");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("resolution: executeTriageResolutions returns empty result when no actionable captures", () => {
  const tmp = makeTempDir("res-exec-empty");
  try {
    const result = executeTriageResolutions(tmp, "M001", "S01");
    assert.strictEqual(result.injected, 0);
    assert.strictEqual(result.replanned, 0);
    assert.strictEqual(result.quickTasks.length, 0);
    assert.strictEqual(result.actions.length, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("resolution: ensureDeferMilestoneDir creates milestone directory with CONTEXT-DRAFT.md", () => {
  const tmp = makeTempDir("res-defer-create");
  try {
    mkdirSync(join(tmp, ".gsd", "milestones"), { recursive: true });
    const captures = [
      { id: "CAP-aaa111", text: "add performance monitoring", timestamp: "2026-03-15T20:00:00Z", status: "resolved", classification: "defer" },
      { id: "CAP-bbb222", text: "optimize database queries", timestamp: "2026-03-15T20:01:00Z", status: "resolved", classification: "defer" }
    ];
    const created = ensureDeferMilestoneDir(tmp, "M005", captures);
    assert.strictEqual(created, true, "should return true");
    const msDir = join(tmp, ".gsd", "milestones", "M005");
    assert.ok(existsSync(msDir), "milestone directory should exist");
    const draftPath = join(msDir, "M005-CONTEXT-DRAFT.md");
    assert.ok(existsSync(draftPath), "CONTEXT-DRAFT.md should exist");
    const content = readFileSync(draftPath, "utf-8");
    assert.ok(content.includes("# M005:"), "should have milestone heading");
    assert.ok(content.includes("CAP-aaa111"), "should list first capture");
    assert.ok(content.includes("CAP-bbb222"), "should list second capture");
    assert.ok(content.includes("add performance monitoring"), "should include capture text");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("resolution: ensureDeferMilestoneDir returns true without overwriting existing directory", () => {
  const tmp = makeTempDir("res-defer-exists");
  try {
    const msDir = join(tmp, ".gsd", "milestones", "M003");
    mkdirSync(msDir, { recursive: true });
    writeFileSync(join(msDir, "M003-CONTEXT.md"), "# M003: Existing\n", "utf-8");
    const created = ensureDeferMilestoneDir(tmp, "M003", []);
    assert.strictEqual(created, true, "should return true for existing dir");
    assert.ok(existsSync(join(msDir, "M003-CONTEXT.md")), "existing files should be preserved");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("resolution: ensureDeferMilestoneDir rejects invalid milestone IDs", () => {
  const tmp = makeTempDir("res-defer-invalid");
  try {
    mkdirSync(join(tmp, ".gsd", "milestones"), { recursive: true });
    assert.strictEqual(ensureDeferMilestoneDir(tmp, "S03", []), false, "should reject slice IDs");
    assert.strictEqual(ensureDeferMilestoneDir(tmp, "not-a-milestone", []), false, "should reject arbitrary strings");
    assert.strictEqual(ensureDeferMilestoneDir(tmp, "", []), false, "should reject empty string");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("resolution: ensureDeferMilestoneDir handles unique milestone IDs (M005-abc123)", () => {
  const tmp = makeTempDir("res-defer-unique");
  try {
    mkdirSync(join(tmp, ".gsd", "milestones"), { recursive: true });
    const created = ensureDeferMilestoneDir(tmp, "M005-abc123", [
      { id: "CAP-ccc333", text: "future work", timestamp: "2026-03-15T20:00:00Z", status: "resolved", classification: "defer" }
    ]);
    assert.strictEqual(created, true);
    const msDir = join(tmp, ".gsd", "milestones", "M005-abc123");
    assert.ok(existsSync(msDir), "milestone directory should exist");
    assert.ok(
      existsSync(join(msDir, "M005-abc123-CONTEXT-DRAFT.md")),
      "CONTEXT-DRAFT.md should use full milestone ID"
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("resolution: executeTriageResolutions creates milestone dir for deferred captures", () => {
  const tmp = makeTempDir("res-exec-defer");
  try {
    mkdirSync(join(tmp, ".gsd", "milestones"), { recursive: true });
    const id1 = appendCapture(tmp, "add caching layer");
    const id2 = appendCapture(tmp, "optimize queries");
    markCaptureResolved(tmp, id1, "defer", "deferred to M005", "future perf work");
    markCaptureResolved(tmp, id2, "defer", "deferred to M005", "future perf work");
    const result = executeTriageResolutions(tmp, "M001", "S01");
    assert.strictEqual(result.deferredMilestones, 1, "should create 1 milestone");
    assert.ok(
      existsSync(join(tmp, ".gsd", "milestones", "M005")),
      "M005 directory should exist"
    );
    assert.ok(
      existsSync(join(tmp, ".gsd", "milestones", "M005", "M005-CONTEXT-DRAFT.md")),
      "CONTEXT-DRAFT.md should exist"
    );
    const all = loadAllCaptures(tmp);
    assert.strictEqual(all[0].executed, true, "first defer should be marked executed");
    assert.strictEqual(all[1].executed, true, "second defer should be marked executed");
    const draft = readFileSync(join(tmp, ".gsd", "milestones", "M005", "M005-CONTEXT-DRAFT.md"), "utf-8");
    assert.ok(draft.includes("add caching layer"), "should include first capture text");
    assert.ok(draft.includes("optimize queries"), "should include second capture text");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("resolution: executeTriageResolutions skips defer when milestone already exists", () => {
  const tmp = makeTempDir("res-exec-defer-exists");
  try {
    const msDir = join(tmp, ".gsd", "milestones", "M005");
    mkdirSync(msDir, { recursive: true });
    writeFileSync(join(msDir, "M005-CONTEXT.md"), "# M005: Already Planned\n", "utf-8");
    const id = appendCapture(tmp, "defer this");
    markCaptureResolved(tmp, id, "defer", "deferred to M005", "later");
    const result = executeTriageResolutions(tmp, "M001", "S01");
    assert.strictEqual(result.deferredMilestones, 0, "should not count existing milestone");
    assert.ok(existsSync(join(msDir, "M005-CONTEXT.md")), "existing files should be preserved");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy90cmlhZ2UtcmVzb2x1dGlvbi50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFVuaXQgdGVzdHMgZm9yIEdTRCBUcmlhZ2UgUmVzb2x1dGlvbiBcdTIwMTQgcmVzb2x1dGlvbiBleGVjdXRpb24gYW5kIGZpbGUgb3ZlcmxhcCBkZXRlY3Rpb24uXG4gKi9cblxuaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2RpclN5bmMsIHJlYWRGaWxlU3luYywgd3JpdGVGaWxlU3luYywgcm1TeW5jLCBleGlzdHNTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgYXBwZW5kQ2FwdHVyZSwgbWFya0NhcHR1cmVSZXNvbHZlZCwgbWFya0NhcHR1cmVFeGVjdXRlZCwgbG9hZEFsbENhcHR1cmVzLCBsb2FkQWN0aW9uYWJsZUNhcHR1cmVzIH0gZnJvbSBcIi4uL2NhcHR1cmVzLnRzXCI7XG4vLyBJbXBvcnQgb25seSB0aGUgZnVuY3Rpb25zIHRoYXQgZG9uJ3QgZGVwZW5kIG9uIEBnc2QvcGktY29kaW5nLWFnZW50XG4vLyAodHJpYWdlLXVpLnRzIGltcG9ydHMgbmV4dC1hY3Rpb24tdWkudHMgd2hpY2ggaW1wb3J0cyB0aGUgdW5hdmFpbGFibGUgcGFja2FnZSlcbmltcG9ydCB7IGV4ZWN1dGVJbmplY3QsIGV4ZWN1dGVSZXBsYW4sIGRldGVjdEZpbGVPdmVybGFwLCBsb2FkRGVmZXJyZWRDYXB0dXJlcywgbG9hZFJlcGxhbkNhcHR1cmVzLCBidWlsZFF1aWNrVGFza1Byb21wdCwgZXhlY3V0ZVRyaWFnZVJlc29sdXRpb25zLCBlbnN1cmVEZWZlck1pbGVzdG9uZURpciB9IGZyb20gXCIuLi90cmlhZ2UtcmVzb2x1dGlvbi50c1wiO1xuXG5mdW5jdGlvbiBtYWtlVGVtcERpcihwcmVmaXg6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGRpciA9IGpvaW4oXG4gICAgdG1wZGlyKCksXG4gICAgYCR7cHJlZml4fS0ke0RhdGUubm93KCl9LSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMil9YCxcbiAgKTtcbiAgbWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHJldHVybiBkaXI7XG59XG5cbmZ1bmN0aW9uIHNldHVwUGxhbkZpbGUodG1wOiBzdHJpbmcsIG1pZDogc3RyaW5nLCBzaWQ6IHN0cmluZywgY29udGVudDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgcGxhbkRpciA9IGpvaW4odG1wLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIG1pZCwgXCJzbGljZXNcIiwgc2lkKTtcbiAgbWtkaXJTeW5jKHBsYW5EaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBjb25zdCBwbGFuUGF0aCA9IGpvaW4ocGxhbkRpciwgYCR7c2lkfS1QTEFOLm1kYCk7XG4gIHdyaXRlRmlsZVN5bmMocGxhblBhdGgsIGNvbnRlbnQsIFwidXRmLThcIik7XG4gIHJldHVybiBwbGFuUGF0aDtcbn1cblxuY29uc3QgU0FNUExFX1BMQU4gPSBgIyBTMDE6IFRlc3QgU2xpY2VcblxuKipHb2FsOioqIFRlc3RcbioqRGVtbzoqKiBUZXN0XG5cbiMjIE11c3QtSGF2ZXNcblxuLSBTb21ldGhpbmcgd29ya3NcblxuIyMgVGFza3NcblxuLSBbeF0gKipUMDE6IEZpcnN0IHRhc2sqKiBcXGBlc3Q6MWhcXGBcbiAgLSBXaHk6IFNldHVwXG4gIC0gRmlsZXM6IFxcYHNyYy9mb28udHNcXGAsIFxcYHNyYy9iYXIudHNcXGBcbiAgLSBEbzogQnVpbGQgaXRcbiAgLSBEb25lIHdoZW46IFRlc3RzIHBhc3NcblxuLSBbIF0gKipUMDI6IFNlY29uZCB0YXNrKiogXFxgZXN0OjFoXFxgXG4gIC0gV2h5OiBGZWF0dXJlXG4gIC0gRmlsZXM6IFxcYHNyYy9iYXoudHNcXGAsIFxcYHNyYy9xdXgudHNcXGBcbiAgLSBEbzogQnVpbGQgaXRcbiAgLSBEb25lIHdoZW46IFRlc3RzIHBhc3NcblxuLSBbIF0gKipUMDM6IFRoaXJkIHRhc2sqKiBcXGBlc3Q6MzBtXFxgXG4gIC0gV2h5OiBQb2xpc2hcbiAgLSBGaWxlczogXFxgc3JjL3F1eC50c1xcYCwgXFxgc3JjL2NvbmZpZy50c1xcYFxuICAtIERvOiBCdWlsZCBpdFxuICAtIERvbmUgd2hlbjogVGVzdHMgcGFzc1xuXG4jIyBGaWxlcyBMaWtlbHkgVG91Y2hlZFxuXG4tIFxcYHNyYy9mb28udHNcXGBcbi0gXFxgc3JjL2Jhci50c1xcYFxuYDtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGV4ZWN1dGVJbmplY3QgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJyZXNvbHV0aW9uOiBleGVjdXRlSW5qZWN0IGFwcGVuZHMgYSBuZXcgdGFzayB0byB0aGUgcGxhblwiLCAoKSA9PiB7XG4gIGNvbnN0IHRtcCA9IG1ha2VUZW1wRGlyKFwicmVzLWluamVjdFwiKTtcbiAgdHJ5IHtcbiAgICBjb25zdCBwbGFuUGF0aCA9IHNldHVwUGxhbkZpbGUodG1wLCBcIk0wMDFcIiwgXCJTMDFcIiwgU0FNUExFX1BMQU4pO1xuICAgIGNvbnN0IGNhcHR1cmVJZCA9IGFwcGVuZENhcHR1cmUodG1wLCBcImFkZCByZXRyeSBsb2dpY1wiKTtcbiAgICBjb25zdCBjYXB0dXJlcyA9IGxvYWRBbGxDYXB0dXJlcyh0bXApO1xuICAgIGNvbnN0IGNhcHR1cmUgPSBjYXB0dXJlc1swXTtcblxuICAgIGNvbnN0IG5ld0lkID0gZXhlY3V0ZUluamVjdCh0bXAsIFwiTTAwMVwiLCBcIlMwMVwiLCBjYXB0dXJlKTtcblxuICAgIGFzc2VydC5zdHJpY3RFcXVhbChuZXdJZCwgXCJUMDRcIiwgXCJzaG91bGQgYmUgVDA0IChuZXh0IGFmdGVyIFQwMylcIik7XG5cbiAgICBjb25zdCB1cGRhdGVkID0gcmVhZEZpbGVTeW5jKHBsYW5QYXRoLCBcInV0Zi04XCIpO1xuICAgIGFzc2VydC5vayh1cGRhdGVkLmluY2x1ZGVzKFwiKipUMDQ6XCIpLCBcInNob3VsZCBoYXZlIFQwNCBpbiBwbGFuXCIpO1xuICAgIGFzc2VydC5vayh1cGRhdGVkLmluY2x1ZGVzKGNhcHR1cmUudGV4dCksIFwic2hvdWxkIGluY2x1ZGUgY2FwdHVyZSB0ZXh0XCIpO1xuICAgIGFzc2VydC5vayh1cGRhdGVkLmluY2x1ZGVzKFwiIyMgRmlsZXMgTGlrZWx5IFRvdWNoZWRcIiksIFwic2hvdWxkIHByZXNlcnZlIGZpbGVzIHNlY3Rpb25cIik7XG5cbiAgICAvLyBUMDQgc2hvdWxkIGFwcGVhciBiZWZvcmUgRmlsZXMgTGlrZWx5IFRvdWNoZWRcbiAgICBjb25zdCB0MDRQb3MgPSB1cGRhdGVkLmluZGV4T2YoXCIqKlQwNDpcIik7XG4gICAgY29uc3QgZmlsZXNQb3MgPSB1cGRhdGVkLmluZGV4T2YoXCIjIyBGaWxlcyBMaWtlbHkgVG91Y2hlZFwiKTtcbiAgICBhc3NlcnQub2sodDA0UG9zIDwgZmlsZXNQb3MsIFwiVDA0IHNob3VsZCBiZSBiZWZvcmUgRmlsZXMgc2VjdGlvblwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwicmVzb2x1dGlvbjogZXhlY3V0ZUluamVjdCByZXR1cm5zIG51bGwgd2hlbiBwbGFuIGRvZXNuJ3QgZXhpc3RcIiwgKCkgPT4ge1xuICBjb25zdCB0bXAgPSBtYWtlVGVtcERpcihcInJlcy1pbmplY3Qtbm9wbGFuXCIpO1xuICB0cnkge1xuICAgIGNvbnN0IGNhcHR1cmVJZCA9IGFwcGVuZENhcHR1cmUodG1wLCBcInNvbWUgdGFza1wiKTtcbiAgICBjb25zdCBjYXB0dXJlcyA9IGxvYWRBbGxDYXB0dXJlcyh0bXApO1xuICAgIGNvbnN0IHJlc3VsdCA9IGV4ZWN1dGVJbmplY3QodG1wLCBcIk0wMDFcIiwgXCJTMDFcIiwgY2FwdHVyZXNbMF0pO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQsIG51bGwpO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBleGVjdXRlUmVwbGFuIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwicmVzb2x1dGlvbjogZXhlY3V0ZVJlcGxhbiB3cml0ZXMgUkVQTEFOLVRSSUdHRVIubWRcIiwgKCkgPT4ge1xuICBjb25zdCB0bXAgPSBtYWtlVGVtcERpcihcInJlcy1yZXBsYW5cIik7XG4gIHRyeSB7XG4gICAgc2V0dXBQbGFuRmlsZSh0bXAsIFwiTTAwMVwiLCBcIlMwMVwiLCBTQU1QTEVfUExBTik7XG4gICAgY29uc3QgY2FwdHVyZUlkID0gYXBwZW5kQ2FwdHVyZSh0bXAsIFwiYXBwcm9hY2ggaXMgd3JvbmcsIG5lZWQgZGlmZmVyZW50IHN0cmF0ZWd5XCIpO1xuICAgIGNvbnN0IGNhcHR1cmVzID0gbG9hZEFsbENhcHR1cmVzKHRtcCk7XG4gICAgY29uc3QgY2FwdHVyZSA9IGNhcHR1cmVzWzBdO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gZXhlY3V0ZVJlcGxhbih0bXAsIFwiTTAwMVwiLCBcIlMwMVwiLCBjYXB0dXJlKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LCB0cnVlKTtcblxuICAgIGNvbnN0IHRyaWdnZXJQYXRoID0gam9pbihcbiAgICAgIHRtcCwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIiwgXCJTMDEtUkVQTEFOLVRSSUdHRVIubWRcIixcbiAgICApO1xuICAgIGFzc2VydC5vayhleGlzdHNTeW5jKHRyaWdnZXJQYXRoKSwgXCJ0cmlnZ2VyIGZpbGUgc2hvdWxkIGV4aXN0XCIpO1xuXG4gICAgY29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyh0cmlnZ2VyUGF0aCwgXCJ1dGYtOFwiKTtcbiAgICBhc3NlcnQub2soY29udGVudC5pbmNsdWRlcyhjYXB0dXJlLmlkKSwgXCJzaG91bGQgaW5jbHVkZSBjYXB0dXJlIElEXCIpO1xuICAgIGFzc2VydC5vayhjb250ZW50LmluY2x1ZGVzKGNhcHR1cmUudGV4dCksIFwic2hvdWxkIGluY2x1ZGUgY2FwdHVyZSB0ZXh0XCIpO1xuICAgIGFzc2VydC5vayhjb250ZW50LmluY2x1ZGVzKFwiIyBSZXBsYW4gVHJpZ2dlclwiKSwgXCJzaG91bGQgaGF2ZSBoZWFkZXJcIik7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGRldGVjdEZpbGVPdmVybGFwIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwicmVzb2x1dGlvbjogZGV0ZWN0RmlsZU92ZXJsYXAgZmluZHMgb3ZlcmxhcHBpbmcgaW5jb21wbGV0ZSB0YXNrc1wiLCAoKSA9PiB7XG4gIGNvbnN0IG92ZXJsYXBzID0gZGV0ZWN0RmlsZU92ZXJsYXAoW1wic3JjL3F1eC50c1wiXSwgU0FNUExFX1BMQU4pO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKG92ZXJsYXBzLCBbXCJUMDJcIiwgXCJUMDNcIl0pO1xufSk7XG5cbnRlc3QoXCJyZXNvbHV0aW9uOiBkZXRlY3RGaWxlT3ZlcmxhcCBpZ25vcmVzIGNvbXBsZXRlZCB0YXNrc1wiLCAoKSA9PiB7XG4gIC8vIFQwMSBpcyBbeF0gYW5kIHVzZXMgc3JjL2Zvby50cyBcdTIwMTQgc2hvdWxkIE5PVCBiZSByZXR1cm5lZFxuICBjb25zdCBvdmVybGFwcyA9IGRldGVjdEZpbGVPdmVybGFwKFtcInNyYy9mb28udHNcIl0sIFNBTVBMRV9QTEFOKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChvdmVybGFwcywgW10pO1xufSk7XG5cbnRlc3QoXCJyZXNvbHV0aW9uOiBkZXRlY3RGaWxlT3ZlcmxhcCByZXR1cm5zIGVtcHR5IHdoZW4gbm8gb3ZlcmxhcFwiLCAoKSA9PiB7XG4gIGNvbnN0IG92ZXJsYXBzID0gZGV0ZWN0RmlsZU92ZXJsYXAoW1wic3JjL3VucmVsYXRlZC50c1wiXSwgU0FNUExFX1BMQU4pO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKG92ZXJsYXBzLCBbXSk7XG59KTtcblxudGVzdChcInJlc29sdXRpb246IGRldGVjdEZpbGVPdmVybGFwIHJldHVybnMgZW1wdHkgZm9yIGVtcHR5IGFmZmVjdGVkIGZpbGVzXCIsICgpID0+IHtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkZXRlY3RGaWxlT3ZlcmxhcChbXSwgU0FNUExFX1BMQU4pLCBbXSk7XG59KTtcblxudGVzdChcInJlc29sdXRpb246IGRldGVjdEZpbGVPdmVybGFwIGlzIGNhc2UtaW5zZW5zaXRpdmVcIiwgKCkgPT4ge1xuICBjb25zdCBvdmVybGFwcyA9IGRldGVjdEZpbGVPdmVybGFwKFtcIlNSQy9RVVguVFNcIl0sIFNBTVBMRV9QTEFOKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChvdmVybGFwcywgW1wiVDAyXCIsIFwiVDAzXCJdKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgbG9hZERlZmVycmVkQ2FwdHVyZXMgLyBsb2FkUmVwbGFuQ2FwdHVyZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJyZXNvbHV0aW9uOiBsb2FkRGVmZXJyZWRDYXB0dXJlcyByZXR1cm5zIG9ubHkgZGVmZXJyZWQgY2FwdHVyZXNcIiwgKCkgPT4ge1xuICBjb25zdCB0bXAgPSBtYWtlVGVtcERpcihcInJlcy1kZWZlcnJlZFwiKTtcbiAgdHJ5IHtcbiAgICBjb25zdCBpZDEgPSBhcHBlbmRDYXB0dXJlKHRtcCwgXCJkZWZlcnJlZCBvbmVcIik7XG4gICAgY29uc3QgaWQyID0gYXBwZW5kQ2FwdHVyZSh0bXAsIFwibm90ZSBvbmVcIik7XG4gICAgY29uc3QgaWQzID0gYXBwZW5kQ2FwdHVyZSh0bXAsIFwiZGVmZXJyZWQgdHdvXCIpO1xuXG4gICAgbWFya0NhcHR1cmVSZXNvbHZlZCh0bXAsIGlkMSwgXCJkZWZlclwiLCBcImRlZmVycmVkIHRvIFMwM1wiLCBcImZ1dHVyZSB3b3JrXCIpO1xuICAgIG1hcmtDYXB0dXJlUmVzb2x2ZWQodG1wLCBpZDIsIFwibm90ZVwiLCBcImFja25vd2xlZGdlZFwiLCBcImp1c3QgYSBub3RlXCIpO1xuICAgIG1hcmtDYXB0dXJlUmVzb2x2ZWQodG1wLCBpZDMsIFwiZGVmZXJcIiwgXCJkZWZlcnJlZCB0byBTMDRcIiwgXCJsYXRlclwiKTtcblxuICAgIGNvbnN0IGRlZmVycmVkID0gbG9hZERlZmVycmVkQ2FwdHVyZXModG1wKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoZGVmZXJyZWQubGVuZ3RoLCAyKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoZGVmZXJyZWRbMF0uaWQsIGlkMSk7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKGRlZmVycmVkWzFdLmlkLCBpZDMpO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJyZXNvbHV0aW9uOiBsb2FkUmVwbGFuQ2FwdHVyZXMgcmV0dXJucyBvbmx5IHJlcGxhbiBjYXB0dXJlc1wiLCAoKSA9PiB7XG4gIGNvbnN0IHRtcCA9IG1ha2VUZW1wRGlyKFwicmVzLXJlcGxhbi1sb2FkXCIpO1xuICB0cnkge1xuICAgIGNvbnN0IGlkMSA9IGFwcGVuZENhcHR1cmUodG1wLCBcIm5lZWRzIHJlcGxhblwiKTtcbiAgICBjb25zdCBpZDIgPSBhcHBlbmRDYXB0dXJlKHRtcCwgXCJqdXN0IGEgbm90ZVwiKTtcblxuICAgIG1hcmtDYXB0dXJlUmVzb2x2ZWQodG1wLCBpZDEsIFwicmVwbGFuXCIsIFwicmVwbGFuIHRyaWdnZXJlZFwiLCBcImFwcHJvYWNoIGNoYW5nZWRcIik7XG4gICAgbWFya0NhcHR1cmVSZXNvbHZlZCh0bXAsIGlkMiwgXCJub3RlXCIsIFwiYWNrbm93bGVkZ2VkXCIsIFwiaW5mbyBvbmx5XCIpO1xuXG4gICAgY29uc3QgcmVwbGFucyA9IGxvYWRSZXBsYW5DYXB0dXJlcyh0bXApO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChyZXBsYW5zLmxlbmd0aCwgMSk7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlcGxhbnNbMF0uaWQsIGlkMSk7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGJ1aWxkUXVpY2tUYXNrUHJvbXB0IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwicmVzb2x1dGlvbjogYnVpbGRRdWlja1Rhc2tQcm9tcHQgaW5jbHVkZXMgY2FwdHVyZSB0ZXh0IGFuZCBJRFwiLCAoKSA9PiB7XG4gIGNvbnN0IHByb21wdCA9IGJ1aWxkUXVpY2tUYXNrUHJvbXB0KHtcbiAgICBpZDogXCJDQVAtYWJjMTIzXCIsXG4gICAgdGV4dDogXCJhZGQgcmV0cnkgbG9naWMgdG8gT0F1dGhcIixcbiAgICB0aW1lc3RhbXA6IFwiMjAyNi0wMy0xNVQyMDowMDowMFpcIixcbiAgICBzdGF0dXM6IFwicmVzb2x2ZWRcIixcbiAgICBjbGFzc2lmaWNhdGlvbjogXCJxdWljay10YXNrXCIsXG4gIH0pO1xuXG4gIGFzc2VydC5vayhwcm9tcHQuaW5jbHVkZXMoXCJDQVAtYWJjMTIzXCIpLCBcInNob3VsZCBpbmNsdWRlIGNhcHR1cmUgSURcIik7XG4gIGFzc2VydC5vayhwcm9tcHQuaW5jbHVkZXMoXCJhZGQgcmV0cnkgbG9naWMgdG8gT0F1dGhcIiksIFwic2hvdWxkIGluY2x1ZGUgY2FwdHVyZSB0ZXh0XCIpO1xuICBhc3NlcnQub2socHJvbXB0LmluY2x1ZGVzKFwiUXVpY2sgVGFza1wiKSwgXCJzaG91bGQgaGF2ZSBRdWljayBUYXNrIGhlYWRlclwiKTtcbiAgYXNzZXJ0Lm9rKHByb21wdC5pbmNsdWRlcyhcIkRvIE5PVCBtb2RpZnlcIiksIFwic2hvdWxkIHdhcm4gYWJvdXQgcGxhbiBmaWxlc1wiKTtcbiAgYXNzZXJ0Lm9rKFxuICAgIHByb21wdC5pbmNsdWRlcyhcIlZlcmlmeSB0aGUgaXNzdWUgc3RpbGwgZXhpc3RzXCIpLFxuICAgIFwic2hvdWxkIGluc3RydWN0IGFnZW50IHRvIHZlcmlmeSBpc3N1ZSBzdGlsbCBleGlzdHMgKCMyODcyKVwiLFxuICApO1xuICBhc3NlcnQub2soXG4gICAgcHJvbXB0LmluY2x1ZGVzKFwiQWxyZWFkeSByZXNvbHZlZFwiKSxcbiAgICBcInNob3VsZCBpbnN0cnVjdCBhZ2VudCB0byByZXBvcnQgYWxyZWFkeSByZXNvbHZlZCBpZiBmaXhlZCAoIzI4NzIpXCIsXG4gICk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIG1hcmtDYXB0dXJlRXhlY3V0ZWQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJyZXNvbHV0aW9uOiBtYXJrQ2FwdHVyZUV4ZWN1dGVkIGFkZHMgRXhlY3V0ZWQgZmllbGQgdG8gY2FwdHVyZVwiLCAoKSA9PiB7XG4gIGNvbnN0IHRtcCA9IG1ha2VUZW1wRGlyKFwicmVzLWV4ZWN1dGVkXCIpO1xuICB0cnkge1xuICAgIGNvbnN0IGlkID0gYXBwZW5kQ2FwdHVyZSh0bXAsIFwiZml4IHRoZSBidXR0b25cIik7XG4gICAgbWFya0NhcHR1cmVSZXNvbHZlZCh0bXAsIGlkLCBcInF1aWNrLXRhc2tcIiwgXCJleGVjdXRlIGFzIHF1aWNrLXRhc2tcIiwgXCJzbWFsbCBmaXhcIik7XG5cbiAgICBtYXJrQ2FwdHVyZUV4ZWN1dGVkKHRtcCwgaWQpO1xuXG4gICAgY29uc3QgYWxsID0gbG9hZEFsbENhcHR1cmVzKHRtcCk7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKGFsbC5sZW5ndGgsIDEpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChhbGxbMF0uZXhlY3V0ZWQsIHRydWUsIFwic2hvdWxkIGJlIG1hcmtlZCBhcyBleGVjdXRlZFwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwicmVzb2x1dGlvbjogbWFya0NhcHR1cmVFeGVjdXRlZCBpcyBpZGVtcG90ZW50XCIsICgpID0+IHtcbiAgY29uc3QgdG1wID0gbWFrZVRlbXBEaXIoXCJyZXMtZXhlY3V0ZWQtaWRlbVwiKTtcbiAgdHJ5IHtcbiAgICBjb25zdCBpZCA9IGFwcGVuZENhcHR1cmUodG1wLCBcImZpeCBzb21ldGhpbmdcIik7XG4gICAgbWFya0NhcHR1cmVSZXNvbHZlZCh0bXAsIGlkLCBcImluamVjdFwiLCBcImluamVjdCB0YXNrXCIsIFwibmVlZGVkXCIpO1xuXG4gICAgbWFya0NhcHR1cmVFeGVjdXRlZCh0bXAsIGlkKTtcbiAgICBtYXJrQ2FwdHVyZUV4ZWN1dGVkKHRtcCwgaWQpOyAvLyBjYWxsIGFnYWluIFx1MjAxNCBzaG91bGQgbm90IGR1cGxpY2F0ZVxuXG4gICAgY29uc3QgZmlsZVBhdGggPSBqb2luKHRtcCwgXCIuZ3NkXCIsIFwiQ0FQVFVSRVMubWRcIik7XG4gICAgY29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhmaWxlUGF0aCwgXCJ1dGYtOFwiKTtcbiAgICBjb25zdCBleGVjdXRlZE1hdGNoZXMgPSBjb250ZW50Lm1hdGNoKC9cXCpcXCpFeGVjdXRlZDpcXCpcXCovZyk7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKGV4ZWN1dGVkTWF0Y2hlcz8ubGVuZ3RoLCAxLCBcInNob3VsZCBoYXZlIGV4YWN0bHkgb25lIEV4ZWN1dGVkIGZpZWxkXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBleGVjdXRlVHJpYWdlUmVzb2x1dGlvbnMgKyBub3RlIGV4ZWN1dGlvbiAoIzM1NzgpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwicmVzb2x1dGlvbjogZXhlY3V0ZVRyaWFnZVJlc29sdXRpb25zIHN0YW1wcyBub3RlIGNhcHR1cmVzIGFzIGV4ZWN1dGVkXCIsICgpID0+IHtcbiAgY29uc3QgdG1wID0gbWFrZVRlbXBEaXIoXCJyZXMtZXhlYy1ub3RlXCIpO1xuICB0cnkge1xuICAgIGNvbnN0IGlkID0gYXBwZW5kQ2FwdHVyZSh0bXAsIFwiRllJIHRoZSBBUEkgY2hhbmdlZFwiKTtcbiAgICBtYXJrQ2FwdHVyZVJlc29sdmVkKHRtcCwgaWQsIFwibm90ZVwiLCBcImFja25vd2xlZGdlZFwiLCBcImluZm9ybWF0aW9uYWxcIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSBleGVjdXRlVHJpYWdlUmVzb2x1dGlvbnModG1wLCBcIk0wMDFcIiwgXCJTMDFcIik7XG5cbiAgICAvLyBUaGUgbm90ZSBzaG91bGQgbm93IGJlIG1hcmtlZCBhcyBleGVjdXRlZFxuICAgIGNvbnN0IGFsbCA9IGxvYWRBbGxDYXB0dXJlcyh0bXApO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChhbGwubGVuZ3RoLCAxKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoYWxsWzBdLmV4ZWN1dGVkLCB0cnVlLCBcIm5vdGUgY2FwdHVyZSBzaG91bGQgYmUgbWFya2VkIGFzIGV4ZWN1dGVkXCIpO1xuXG4gICAgLy8gSXQgc2hvdWxkIGFwcGVhciBpbiB0aGUgYWN0aW9ucyBsb2dcbiAgICBhc3NlcnQub2soXG4gICAgICByZXN1bHQuYWN0aW9ucy5zb21lKGEgPT4gYS5pbmNsdWRlcyhpZCkgJiYgYS5pbmNsdWRlcyhcIk5vdGUgYWNrbm93bGVkZ2VkXCIpKSxcbiAgICAgIFwiYWN0aW9ucyBzaG91bGQgaW5jbHVkZSBhIG5vdGUtYWNrbm93bGVkZ2VkIGVudHJ5XCIsXG4gICAgKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwicmVzb2x1dGlvbjogZXhlY3V0ZVRyaWFnZVJlc29sdXRpb25zIGRvZXMgbm90IGRvdWJsZS1zdGFtcCBhbHJlYWR5LWV4ZWN1dGVkIG5vdGVzXCIsICgpID0+IHtcbiAgY29uc3QgdG1wID0gbWFrZVRlbXBEaXIoXCJyZXMtZXhlYy1ub3RlLWlkZW1cIik7XG4gIHRyeSB7XG4gICAgY29uc3QgaWQgPSBhcHBlbmRDYXB0dXJlKHRtcCwgXCJpbmZvcm1hdGlvbmFsIG5vdGVcIik7XG4gICAgbWFya0NhcHR1cmVSZXNvbHZlZCh0bXAsIGlkLCBcIm5vdGVcIiwgXCJhY2tub3dsZWRnZWRcIiwgXCJpbmZvXCIpO1xuXG4gICAgLy8gRmlyc3QgZXhlY3V0aW9uIFx1MjAxNCBzdGFtcHMgdGhlIG5vdGVcbiAgICBleGVjdXRlVHJpYWdlUmVzb2x1dGlvbnModG1wLCBcIk0wMDFcIiwgXCJTMDFcIik7XG5cbiAgICAvLyBTZWNvbmQgZXhlY3V0aW9uIFx1MjAxNCBzaG91bGQgYmUgYSBuby1vcCBmb3IgdGhlIG5vdGVcbiAgICBjb25zdCByZXN1bHQyID0gZXhlY3V0ZVRyaWFnZVJlc29sdXRpb25zKHRtcCwgXCJNMDAxXCIsIFwiUzAxXCIpO1xuXG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdDIuYWN0aW9ucy5sZW5ndGgsIDAsIFwic2Vjb25kIGNhbGwgc2hvdWxkIHByb2R1Y2Ugbm8gYWN0aW9uc1wiKTtcblxuICAgIC8vIFZlcmlmeSB0aGUgRXhlY3V0ZWQgZmllbGQgd2FzIG5vdCBkdXBsaWNhdGVkIGluIHRoZSBmaWxlXG4gICAgY29uc3QgZmlsZVBhdGggPSBqb2luKHRtcCwgXCIuZ3NkXCIsIFwiQ0FQVFVSRVMubWRcIik7XG4gICAgY29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhmaWxlUGF0aCwgXCJ1dGYtOFwiKTtcbiAgICBjb25zdCBleGVjdXRlZE1hdGNoZXMgPSBjb250ZW50Lm1hdGNoKC9cXCpcXCpFeGVjdXRlZDpcXCpcXCovZyk7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKGV4ZWN1dGVkTWF0Y2hlcz8ubGVuZ3RoLCAxLCBcInNob3VsZCBoYXZlIGV4YWN0bHkgb25lIEV4ZWN1dGVkIGZpZWxkXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBsb2FkQWN0aW9uYWJsZUNhcHR1cmVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwicmVzb2x1dGlvbjogbG9hZEFjdGlvbmFibGVDYXB0dXJlcyByZXR1cm5zIG9ubHkgdW5leGVjdXRlZCBhY3Rpb25hYmxlIGNhcHR1cmVzXCIsICgpID0+IHtcbiAgY29uc3QgdG1wID0gbWFrZVRlbXBEaXIoXCJyZXMtYWN0aW9uYWJsZVwiKTtcbiAgdHJ5IHtcbiAgICBjb25zdCBpZDEgPSBhcHBlbmRDYXB0dXJlKHRtcCwgXCJpbmplY3QgdGhpcyB0YXNrXCIpO1xuICAgIGNvbnN0IGlkMiA9IGFwcGVuZENhcHR1cmUodG1wLCBcInF1aWNrIGZpeFwiKTtcbiAgICBjb25zdCBpZDMgPSBhcHBlbmRDYXB0dXJlKHRtcCwgXCJqdXN0IGEgbm90ZVwiKTtcbiAgICBjb25zdCBpZDQgPSBhcHBlbmRDYXB0dXJlKHRtcCwgXCJyZXBsYW4gbmVlZGVkXCIpO1xuICAgIGNvbnN0IGlkNSA9IGFwcGVuZENhcHR1cmUodG1wLCBcImFscmVhZHkgZXhlY3V0ZWQgaW5qZWN0XCIpO1xuXG4gICAgbWFya0NhcHR1cmVSZXNvbHZlZCh0bXAsIGlkMSwgXCJpbmplY3RcIiwgXCJhZGQgdGFza1wiLCBcIm5lZWRlZFwiKTtcbiAgICBtYXJrQ2FwdHVyZVJlc29sdmVkKHRtcCwgaWQyLCBcInF1aWNrLXRhc2tcIiwgXCJxdWljayBmaXhcIiwgXCJzbWFsbFwiKTtcbiAgICBtYXJrQ2FwdHVyZVJlc29sdmVkKHRtcCwgaWQzLCBcIm5vdGVcIiwgXCJhY2tub3dsZWRnZWRcIiwgXCJpbmZvXCIpO1xuICAgIG1hcmtDYXB0dXJlUmVzb2x2ZWQodG1wLCBpZDQsIFwicmVwbGFuXCIsIFwicmVwbGFuIHRyaWdnZXJlZFwiLCBcImFwcHJvYWNoIGNoYW5nZWRcIik7XG4gICAgbWFya0NhcHR1cmVSZXNvbHZlZCh0bXAsIGlkNSwgXCJpbmplY3RcIiwgXCJhZGQgdGFza1wiLCBcIm5lZWRlZFwiKTtcbiAgICBtYXJrQ2FwdHVyZUV4ZWN1dGVkKHRtcCwgaWQ1KTsgLy8gbWFyayBhcyBleGVjdXRlZFxuXG4gICAgY29uc3QgYWN0aW9uYWJsZSA9IGxvYWRBY3Rpb25hYmxlQ2FwdHVyZXModG1wKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoYWN0aW9uYWJsZS5sZW5ndGgsIDMsIFwic2hvdWxkIGhhdmUgMyBhY3Rpb25hYmxlIGNhcHR1cmVzXCIpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoXG4gICAgICBhY3Rpb25hYmxlLm1hcChjID0+IGMuaWQpLFxuICAgICAgW2lkMSwgaWQyLCBpZDRdLFxuICAgICAgXCJzaG91bGQgaW5jbHVkZSBpbmplY3QsIHF1aWNrLXRhc2ssIHJlcGxhbiBidXQgbm90IG5vdGUgb3IgZXhlY3V0ZWQgaW5qZWN0XCIsXG4gICAgKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgZXhlY3V0ZVRyaWFnZVJlc29sdXRpb25zIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwicmVzb2x1dGlvbjogZXhlY3V0ZVRyaWFnZVJlc29sdXRpb25zIGV4ZWN1dGVzIGluamVjdCBjYXB0dXJlc1wiLCAoKSA9PiB7XG4gIGNvbnN0IHRtcCA9IG1ha2VUZW1wRGlyKFwicmVzLWV4ZWMtaW5qZWN0XCIpO1xuICB0cnkge1xuICAgIHNldHVwUGxhbkZpbGUodG1wLCBcIk0wMDFcIiwgXCJTMDFcIiwgU0FNUExFX1BMQU4pO1xuICAgIGNvbnN0IGlkMSA9IGFwcGVuZENhcHR1cmUodG1wLCBcImFkZCBlcnJvciBoYW5kbGluZ1wiKTtcbiAgICBjb25zdCBpZDIgPSBhcHBlbmRDYXB0dXJlKHRtcCwgXCJhZGQgcmV0cnkgbG9naWNcIik7XG4gICAgbWFya0NhcHR1cmVSZXNvbHZlZCh0bXAsIGlkMSwgXCJpbmplY3RcIiwgXCJhZGQgdGFza1wiLCBcIm5lZWRlZFwiKTtcbiAgICBtYXJrQ2FwdHVyZVJlc29sdmVkKHRtcCwgaWQyLCBcImluamVjdFwiLCBcImFkZCB0YXNrXCIsIFwiYWxzbyBuZWVkZWRcIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSBleGVjdXRlVHJpYWdlUmVzb2x1dGlvbnModG1wLCBcIk0wMDFcIiwgXCJTMDFcIik7XG5cbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LmluamVjdGVkLCAyLCBcInNob3VsZCBpbmplY3QgMiB0YXNrc1wiKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LnJlcGxhbm5lZCwgMCk7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5xdWlja1Rhc2tzLmxlbmd0aCwgMCk7XG5cbiAgICAvLyBWZXJpZnkgdGFza3Mgd2VyZSBhZGRlZCB0byBwbGFuXG4gICAgY29uc3QgcGxhblBhdGggPSBqb2luKHRtcCwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIiwgXCJTMDEtUExBTi5tZFwiKTtcbiAgICBjb25zdCBwbGFuQ29udGVudCA9IHJlYWRGaWxlU3luYyhwbGFuUGF0aCwgXCJ1dGYtOFwiKTtcbiAgICBhc3NlcnQub2socGxhbkNvbnRlbnQuaW5jbHVkZXMoXCIqKlQwNDpcIiksIFwic2hvdWxkIGhhdmUgVDA0XCIpO1xuICAgIGFzc2VydC5vayhwbGFuQ29udGVudC5pbmNsdWRlcyhcIioqVDA1OlwiKSwgXCJzaG91bGQgaGF2ZSBUMDVcIik7XG5cbiAgICAvLyBWZXJpZnkgY2FwdHVyZXMgbWFya2VkIGFzIGV4ZWN1dGVkXG4gICAgY29uc3QgYWxsID0gbG9hZEFsbENhcHR1cmVzKHRtcCk7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKGFsbFswXS5leGVjdXRlZCwgdHJ1ZSwgXCJmaXJzdCBjYXB0dXJlIHNob3VsZCBiZSBleGVjdXRlZFwiKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoYWxsWzFdLmV4ZWN1dGVkLCB0cnVlLCBcInNlY29uZCBjYXB0dXJlIHNob3VsZCBiZSBleGVjdXRlZFwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwicmVzb2x1dGlvbjogZXhlY3V0ZVRyaWFnZVJlc29sdXRpb25zIGV4ZWN1dGVzIHJlcGxhbiBjYXB0dXJlc1wiLCAoKSA9PiB7XG4gIGNvbnN0IHRtcCA9IG1ha2VUZW1wRGlyKFwicmVzLWV4ZWMtcmVwbGFuXCIpO1xuICB0cnkge1xuICAgIHNldHVwUGxhbkZpbGUodG1wLCBcIk0wMDFcIiwgXCJTMDFcIiwgU0FNUExFX1BMQU4pO1xuICAgIGNvbnN0IGlkID0gYXBwZW5kQ2FwdHVyZSh0bXAsIFwiYXBwcm9hY2ggaXMgd3JvbmdcIik7XG4gICAgbWFya0NhcHR1cmVSZXNvbHZlZCh0bXAsIGlkLCBcInJlcGxhblwiLCBcInJlcGxhbiB0cmlnZ2VyZWRcIiwgXCJ3cm9uZyBhcHByb2FjaFwiKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGV4ZWN1dGVUcmlhZ2VSZXNvbHV0aW9ucyh0bXAsIFwiTTAwMVwiLCBcIlMwMVwiKTtcblxuICAgIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuaW5qZWN0ZWQsIDApO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQucmVwbGFubmVkLCAxLCBcInNob3VsZCB0cmlnZ2VyIDEgcmVwbGFuXCIpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQucXVpY2tUYXNrcy5sZW5ndGgsIDApO1xuXG4gICAgLy8gVmVyaWZ5IHRyaWdnZXIgZmlsZSB3YXMgd3JpdHRlblxuICAgIGNvbnN0IHRyaWdnZXJQYXRoID0gam9pbihcbiAgICAgIHRtcCwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIiwgXCJTMDEtUkVQTEFOLVRSSUdHRVIubWRcIixcbiAgICApO1xuICAgIGFzc2VydC5vayhleGlzdHNTeW5jKHRyaWdnZXJQYXRoKSwgXCJyZXBsYW4gdHJpZ2dlciBzaG91bGQgZXhpc3RcIik7XG5cbiAgICAvLyBWZXJpZnkgY2FwdHVyZSBtYXJrZWQgYXMgZXhlY3V0ZWRcbiAgICBjb25zdCBhbGwgPSBsb2FkQWxsQ2FwdHVyZXModG1wKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoYWxsWzBdLmV4ZWN1dGVkLCB0cnVlLCBcImNhcHR1cmUgc2hvdWxkIGJlIGV4ZWN1dGVkXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJyZXNvbHV0aW9uOiBleGVjdXRlVHJpYWdlUmVzb2x1dGlvbnMgcXVldWVzIHF1aWNrLXRhc2tzIHdpdGhvdXQgZXhlY3V0aW5nIGlubGluZVwiLCAoKSA9PiB7XG4gIGNvbnN0IHRtcCA9IG1ha2VUZW1wRGlyKFwicmVzLWV4ZWMtcXRcIik7XG4gIHRyeSB7XG4gICAgY29uc3QgaWQgPSBhcHBlbmRDYXB0dXJlKHRtcCwgXCJmaXggdHlwbyBpbiByZWFkbWVcIik7XG4gICAgbWFya0NhcHR1cmVSZXNvbHZlZCh0bXAsIGlkLCBcInF1aWNrLXRhc2tcIiwgXCJleGVjdXRlIGFzIHF1aWNrLXRhc2tcIiwgXCJzbWFsbCBmaXhcIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSBleGVjdXRlVHJpYWdlUmVzb2x1dGlvbnModG1wLCBcIk0wMDFcIiwgXCJTMDFcIik7XG5cbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LmluamVjdGVkLCAwKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LnJlcGxhbm5lZCwgMCk7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5xdWlja1Rhc2tzLmxlbmd0aCwgMSwgXCJzaG91bGQgcXVldWUgMSBxdWljay10YXNrXCIpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQucXVpY2tUYXNrc1swXS5pZCwgaWQpO1xuXG4gICAgLy8gUXVpY2stdGFza3Mgc2hvdWxkIE5PVCBiZSBtYXJrZWQgYXMgZXhlY3V0ZWQgeWV0IChjYWxsZXIgbWFya3MgYWZ0ZXIgZGlzcGF0Y2gpXG4gICAgY29uc3QgYWxsID0gbG9hZEFsbENhcHR1cmVzKHRtcCk7XG4gICAgYXNzZXJ0Lm9rKCFhbGxbMF0uZXhlY3V0ZWQsIFwicXVpY2stdGFzayBzaG91bGQgbm90IGJlIGV4ZWN1dGVkIHlldFwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwicmVzb2x1dGlvbjogZXhlY3V0ZVRyaWFnZVJlc29sdXRpb25zIGhhbmRsZXMgbWl4ZWQgY2xhc3NpZmljYXRpb25zXCIsICgpID0+IHtcbiAgY29uc3QgdG1wID0gbWFrZVRlbXBEaXIoXCJyZXMtZXhlYy1taXhlZFwiKTtcbiAgdHJ5IHtcbiAgICBzZXR1cFBsYW5GaWxlKHRtcCwgXCJNMDAxXCIsIFwiUzAxXCIsIFNBTVBMRV9QTEFOKTtcbiAgICBjb25zdCBpZDEgPSBhcHBlbmRDYXB0dXJlKHRtcCwgXCJpbmplY3QgYSB0YXNrXCIpO1xuICAgIGNvbnN0IGlkMiA9IGFwcGVuZENhcHR1cmUodG1wLCBcInF1aWNrIGZpeCB0eXBvXCIpO1xuICAgIGNvbnN0IGlkMyA9IGFwcGVuZENhcHR1cmUodG1wLCBcImp1c3QgYSBub3RlXCIpO1xuICAgIGNvbnN0IGlkNCA9IGFwcGVuZENhcHR1cmUodG1wLCBcImRlZmVyIHRvIGxhdGVyXCIpO1xuXG4gICAgbWFya0NhcHR1cmVSZXNvbHZlZCh0bXAsIGlkMSwgXCJpbmplY3RcIiwgXCJhZGQgdGFza1wiLCBcIm5lZWRlZFwiKTtcbiAgICBtYXJrQ2FwdHVyZVJlc29sdmVkKHRtcCwgaWQyLCBcInF1aWNrLXRhc2tcIiwgXCJxdWljayBmaXhcIiwgXCJzbWFsbFwiKTtcbiAgICBtYXJrQ2FwdHVyZVJlc29sdmVkKHRtcCwgaWQzLCBcIm5vdGVcIiwgXCJhY2tub3dsZWRnZWRcIiwgXCJpbmZvXCIpO1xuICAgIG1hcmtDYXB0dXJlUmVzb2x2ZWQodG1wLCBpZDQsIFwiZGVmZXJcIiwgXCJkZWZlcnJlZFwiLCBcImxhdGVyXCIpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gZXhlY3V0ZVRyaWFnZVJlc29sdXRpb25zKHRtcCwgXCJNMDAxXCIsIFwiUzAxXCIpO1xuXG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5pbmplY3RlZCwgMSwgXCJzaG91bGQgaW5qZWN0IDEgdGFza1wiKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LnJlcGxhbm5lZCwgMCk7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5xdWlja1Rhc2tzLmxlbmd0aCwgMSwgXCJzaG91bGQgcXVldWUgMSBxdWljay10YXNrXCIpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuYWN0aW9ucy5sZW5ndGgsIDMsIFwic2hvdWxkIGhhdmUgMyBhY3Rpb24gZW50cmllcyAoaW5qZWN0ICsgcXVpY2stdGFzayArIG5vdGUgYWNrbm93bGVkZ2VkOyBkZWZlciBleGNsdWRlZClcIik7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcInJlc29sdXRpb246IGV4ZWN1dGVUcmlhZ2VSZXNvbHV0aW9ucyBza2lwcyBhbHJlYWR5LWV4ZWN1dGVkIGNhcHR1cmVzXCIsICgpID0+IHtcbiAgY29uc3QgdG1wID0gbWFrZVRlbXBEaXIoXCJyZXMtZXhlYy1za2lwXCIpO1xuICB0cnkge1xuICAgIHNldHVwUGxhbkZpbGUodG1wLCBcIk0wMDFcIiwgXCJTMDFcIiwgU0FNUExFX1BMQU4pO1xuICAgIGNvbnN0IGlkID0gYXBwZW5kQ2FwdHVyZSh0bXAsIFwiYWxyZWFkeSBkb25lXCIpO1xuICAgIG1hcmtDYXB0dXJlUmVzb2x2ZWQodG1wLCBpZCwgXCJpbmplY3RcIiwgXCJhZGQgdGFza1wiLCBcIm5lZWRlZFwiKTtcbiAgICBtYXJrQ2FwdHVyZUV4ZWN1dGVkKHRtcCwgaWQpOyAvLyBhbHJlYWR5IGV4ZWN1dGVkXG5cbiAgICBjb25zdCByZXN1bHQgPSBleGVjdXRlVHJpYWdlUmVzb2x1dGlvbnModG1wLCBcIk0wMDFcIiwgXCJTMDFcIik7XG5cbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LmluamVjdGVkLCAwLCBcInNob3VsZCBub3QgaW5qZWN0IGFnYWluXCIpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuYWN0aW9ucy5sZW5ndGgsIDAsIFwic2hvdWxkIGhhdmUgbm8gYWN0aW9uc1wiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwicmVzb2x1dGlvbjogZXhlY3V0ZVRyaWFnZVJlc29sdXRpb25zIHJldHVybnMgZW1wdHkgcmVzdWx0IHdoZW4gbm8gYWN0aW9uYWJsZSBjYXB0dXJlc1wiLCAoKSA9PiB7XG4gIGNvbnN0IHRtcCA9IG1ha2VUZW1wRGlyKFwicmVzLWV4ZWMtZW1wdHlcIik7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gZXhlY3V0ZVRyaWFnZVJlc29sdXRpb25zKHRtcCwgXCJNMDAxXCIsIFwiUzAxXCIpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuaW5qZWN0ZWQsIDApO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQucmVwbGFubmVkLCAwKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LnF1aWNrVGFza3MubGVuZ3RoLCAwKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LmFjdGlvbnMubGVuZ3RoLCAwKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgZW5zdXJlRGVmZXJNaWxlc3RvbmVEaXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJyZXNvbHV0aW9uOiBlbnN1cmVEZWZlck1pbGVzdG9uZURpciBjcmVhdGVzIG1pbGVzdG9uZSBkaXJlY3Rvcnkgd2l0aCBDT05URVhULURSQUZULm1kXCIsICgpID0+IHtcbiAgY29uc3QgdG1wID0gbWFrZVRlbXBEaXIoXCJyZXMtZGVmZXItY3JlYXRlXCIpO1xuICB0cnkge1xuICAgIG1rZGlyU3luYyhqb2luKHRtcCwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgICBjb25zdCBjYXB0dXJlcyA9IFtcbiAgICAgIHsgaWQ6IFwiQ0FQLWFhYTExMVwiLCB0ZXh0OiBcImFkZCBwZXJmb3JtYW5jZSBtb25pdG9yaW5nXCIsIHRpbWVzdGFtcDogXCIyMDI2LTAzLTE1VDIwOjAwOjAwWlwiLCBzdGF0dXM6IFwicmVzb2x2ZWRcIiBhcyBjb25zdCwgY2xhc3NpZmljYXRpb246IFwiZGVmZXJcIiBhcyBjb25zdCB9LFxuICAgICAgeyBpZDogXCJDQVAtYmJiMjIyXCIsIHRleHQ6IFwib3B0aW1pemUgZGF0YWJhc2UgcXVlcmllc1wiLCB0aW1lc3RhbXA6IFwiMjAyNi0wMy0xNVQyMDowMTowMFpcIiwgc3RhdHVzOiBcInJlc29sdmVkXCIgYXMgY29uc3QsIGNsYXNzaWZpY2F0aW9uOiBcImRlZmVyXCIgYXMgY29uc3QgfSxcbiAgICBdO1xuXG4gICAgY29uc3QgY3JlYXRlZCA9IGVuc3VyZURlZmVyTWlsZXN0b25lRGlyKHRtcCwgXCJNMDA1XCIsIGNhcHR1cmVzKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoY3JlYXRlZCwgdHJ1ZSwgXCJzaG91bGQgcmV0dXJuIHRydWVcIik7XG5cbiAgICBjb25zdCBtc0RpciA9IGpvaW4odG1wLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwNVwiKTtcbiAgICBhc3NlcnQub2soZXhpc3RzU3luYyhtc0RpciksIFwibWlsZXN0b25lIGRpcmVjdG9yeSBzaG91bGQgZXhpc3RcIik7XG5cbiAgICBjb25zdCBkcmFmdFBhdGggPSBqb2luKG1zRGlyLCBcIk0wMDUtQ09OVEVYVC1EUkFGVC5tZFwiKTtcbiAgICBhc3NlcnQub2soZXhpc3RzU3luYyhkcmFmdFBhdGgpLCBcIkNPTlRFWFQtRFJBRlQubWQgc2hvdWxkIGV4aXN0XCIpO1xuXG4gICAgY29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhkcmFmdFBhdGgsIFwidXRmLThcIik7XG4gICAgYXNzZXJ0Lm9rKGNvbnRlbnQuaW5jbHVkZXMoXCIjIE0wMDU6XCIpLCBcInNob3VsZCBoYXZlIG1pbGVzdG9uZSBoZWFkaW5nXCIpO1xuICAgIGFzc2VydC5vayhjb250ZW50LmluY2x1ZGVzKFwiQ0FQLWFhYTExMVwiKSwgXCJzaG91bGQgbGlzdCBmaXJzdCBjYXB0dXJlXCIpO1xuICAgIGFzc2VydC5vayhjb250ZW50LmluY2x1ZGVzKFwiQ0FQLWJiYjIyMlwiKSwgXCJzaG91bGQgbGlzdCBzZWNvbmQgY2FwdHVyZVwiKTtcbiAgICBhc3NlcnQub2soY29udGVudC5pbmNsdWRlcyhcImFkZCBwZXJmb3JtYW5jZSBtb25pdG9yaW5nXCIpLCBcInNob3VsZCBpbmNsdWRlIGNhcHR1cmUgdGV4dFwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwicmVzb2x1dGlvbjogZW5zdXJlRGVmZXJNaWxlc3RvbmVEaXIgcmV0dXJucyB0cnVlIHdpdGhvdXQgb3ZlcndyaXRpbmcgZXhpc3RpbmcgZGlyZWN0b3J5XCIsICgpID0+IHtcbiAgY29uc3QgdG1wID0gbWFrZVRlbXBEaXIoXCJyZXMtZGVmZXItZXhpc3RzXCIpO1xuICB0cnkge1xuICAgIGNvbnN0IG1zRGlyID0gam9pbih0bXAsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAzXCIpO1xuICAgIG1rZGlyU3luYyhtc0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKG1zRGlyLCBcIk0wMDMtQ09OVEVYVC5tZFwiKSwgXCIjIE0wMDM6IEV4aXN0aW5nXFxuXCIsIFwidXRmLThcIik7XG5cbiAgICBjb25zdCBjcmVhdGVkID0gZW5zdXJlRGVmZXJNaWxlc3RvbmVEaXIodG1wLCBcIk0wMDNcIiwgW10pO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChjcmVhdGVkLCB0cnVlLCBcInNob3VsZCByZXR1cm4gdHJ1ZSBmb3IgZXhpc3RpbmcgZGlyXCIpO1xuICAgIC8vIE9yaWdpbmFsIGZpbGUgc2hvdWxkIHN0aWxsIGJlIHRoZXJlXG4gICAgYXNzZXJ0Lm9rKGV4aXN0c1N5bmMoam9pbihtc0RpciwgXCJNMDAzLUNPTlRFWFQubWRcIikpLCBcImV4aXN0aW5nIGZpbGVzIHNob3VsZCBiZSBwcmVzZXJ2ZWRcIik7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcInJlc29sdXRpb246IGVuc3VyZURlZmVyTWlsZXN0b25lRGlyIHJlamVjdHMgaW52YWxpZCBtaWxlc3RvbmUgSURzXCIsICgpID0+IHtcbiAgY29uc3QgdG1wID0gbWFrZVRlbXBEaXIoXCJyZXMtZGVmZXItaW52YWxpZFwiKTtcbiAgdHJ5IHtcbiAgICBta2RpclN5bmMoam9pbih0bXAsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChlbnN1cmVEZWZlck1pbGVzdG9uZURpcih0bXAsIFwiUzAzXCIsIFtdKSwgZmFsc2UsIFwic2hvdWxkIHJlamVjdCBzbGljZSBJRHNcIik7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKGVuc3VyZURlZmVyTWlsZXN0b25lRGlyKHRtcCwgXCJub3QtYS1taWxlc3RvbmVcIiwgW10pLCBmYWxzZSwgXCJzaG91bGQgcmVqZWN0IGFyYml0cmFyeSBzdHJpbmdzXCIpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChlbnN1cmVEZWZlck1pbGVzdG9uZURpcih0bXAsIFwiXCIsIFtdKSwgZmFsc2UsIFwic2hvdWxkIHJlamVjdCBlbXB0eSBzdHJpbmdcIik7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcInJlc29sdXRpb246IGVuc3VyZURlZmVyTWlsZXN0b25lRGlyIGhhbmRsZXMgdW5pcXVlIG1pbGVzdG9uZSBJRHMgKE0wMDUtYWJjMTIzKVwiLCAoKSA9PiB7XG4gIGNvbnN0IHRtcCA9IG1ha2VUZW1wRGlyKFwicmVzLWRlZmVyLXVuaXF1ZVwiKTtcbiAgdHJ5IHtcbiAgICBta2RpclN5bmMoam9pbih0bXAsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gICAgY29uc3QgY3JlYXRlZCA9IGVuc3VyZURlZmVyTWlsZXN0b25lRGlyKHRtcCwgXCJNMDA1LWFiYzEyM1wiLCBbXG4gICAgICB7IGlkOiBcIkNBUC1jY2MzMzNcIiwgdGV4dDogXCJmdXR1cmUgd29ya1wiLCB0aW1lc3RhbXA6IFwiMjAyNi0wMy0xNVQyMDowMDowMFpcIiwgc3RhdHVzOiBcInJlc29sdmVkXCIgYXMgY29uc3QsIGNsYXNzaWZpY2F0aW9uOiBcImRlZmVyXCIgYXMgY29uc3QgfSxcbiAgICBdKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoY3JlYXRlZCwgdHJ1ZSk7XG5cbiAgICBjb25zdCBtc0RpciA9IGpvaW4odG1wLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwNS1hYmMxMjNcIik7XG4gICAgYXNzZXJ0Lm9rKGV4aXN0c1N5bmMobXNEaXIpLCBcIm1pbGVzdG9uZSBkaXJlY3Rvcnkgc2hvdWxkIGV4aXN0XCIpO1xuICAgIGFzc2VydC5vayhcbiAgICAgIGV4aXN0c1N5bmMoam9pbihtc0RpciwgXCJNMDA1LWFiYzEyMy1DT05URVhULURSQUZULm1kXCIpKSxcbiAgICAgIFwiQ09OVEVYVC1EUkFGVC5tZCBzaG91bGQgdXNlIGZ1bGwgbWlsZXN0b25lIElEXCIsXG4gICAgKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgZXhlY3V0ZVRyaWFnZVJlc29sdXRpb25zICsgZGVmZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJyZXNvbHV0aW9uOiBleGVjdXRlVHJpYWdlUmVzb2x1dGlvbnMgY3JlYXRlcyBtaWxlc3RvbmUgZGlyIGZvciBkZWZlcnJlZCBjYXB0dXJlc1wiLCAoKSA9PiB7XG4gIGNvbnN0IHRtcCA9IG1ha2VUZW1wRGlyKFwicmVzLWV4ZWMtZGVmZXJcIik7XG4gIHRyeSB7XG4gICAgbWtkaXJTeW5jKGpvaW4odG1wLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAgIGNvbnN0IGlkMSA9IGFwcGVuZENhcHR1cmUodG1wLCBcImFkZCBjYWNoaW5nIGxheWVyXCIpO1xuICAgIGNvbnN0IGlkMiA9IGFwcGVuZENhcHR1cmUodG1wLCBcIm9wdGltaXplIHF1ZXJpZXNcIik7XG4gICAgbWFya0NhcHR1cmVSZXNvbHZlZCh0bXAsIGlkMSwgXCJkZWZlclwiLCBcImRlZmVycmVkIHRvIE0wMDVcIiwgXCJmdXR1cmUgcGVyZiB3b3JrXCIpO1xuICAgIG1hcmtDYXB0dXJlUmVzb2x2ZWQodG1wLCBpZDIsIFwiZGVmZXJcIiwgXCJkZWZlcnJlZCB0byBNMDA1XCIsIFwiZnV0dXJlIHBlcmYgd29ya1wiKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGV4ZWN1dGVUcmlhZ2VSZXNvbHV0aW9ucyh0bXAsIFwiTTAwMVwiLCBcIlMwMVwiKTtcblxuICAgIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuZGVmZXJyZWRNaWxlc3RvbmVzLCAxLCBcInNob3VsZCBjcmVhdGUgMSBtaWxlc3RvbmVcIik7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgZXhpc3RzU3luYyhqb2luKHRtcCwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDVcIikpLFxuICAgICAgXCJNMDA1IGRpcmVjdG9yeSBzaG91bGQgZXhpc3RcIixcbiAgICApO1xuICAgIGFzc2VydC5vayhcbiAgICAgIGV4aXN0c1N5bmMoam9pbih0bXAsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDA1XCIsIFwiTTAwNS1DT05URVhULURSQUZULm1kXCIpKSxcbiAgICAgIFwiQ09OVEVYVC1EUkFGVC5tZCBzaG91bGQgZXhpc3RcIixcbiAgICApO1xuXG4gICAgLy8gRGVmZXJyZWQgY2FwdHVyZXMgc2hvdWxkIGJlIG1hcmtlZCBhcyBleGVjdXRlZFxuICAgIGNvbnN0IGFsbCA9IGxvYWRBbGxDYXB0dXJlcyh0bXApO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChhbGxbMF0uZXhlY3V0ZWQsIHRydWUsIFwiZmlyc3QgZGVmZXIgc2hvdWxkIGJlIG1hcmtlZCBleGVjdXRlZFwiKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoYWxsWzFdLmV4ZWN1dGVkLCB0cnVlLCBcInNlY29uZCBkZWZlciBzaG91bGQgYmUgbWFya2VkIGV4ZWN1dGVkXCIpO1xuXG4gICAgLy8gVmVyaWZ5IHRoZSBkcmFmdCBjb250ZW50IGluY2x1ZGVzIGJvdGggY2FwdHVyZXNcbiAgICBjb25zdCBkcmFmdCA9IHJlYWRGaWxlU3luYyhqb2luKHRtcCwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDVcIiwgXCJNMDA1LUNPTlRFWFQtRFJBRlQubWRcIiksIFwidXRmLThcIik7XG4gICAgYXNzZXJ0Lm9rKGRyYWZ0LmluY2x1ZGVzKFwiYWRkIGNhY2hpbmcgbGF5ZXJcIiksIFwic2hvdWxkIGluY2x1ZGUgZmlyc3QgY2FwdHVyZSB0ZXh0XCIpO1xuICAgIGFzc2VydC5vayhkcmFmdC5pbmNsdWRlcyhcIm9wdGltaXplIHF1ZXJpZXNcIiksIFwic2hvdWxkIGluY2x1ZGUgc2Vjb25kIGNhcHR1cmUgdGV4dFwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwicmVzb2x1dGlvbjogZXhlY3V0ZVRyaWFnZVJlc29sdXRpb25zIHNraXBzIGRlZmVyIHdoZW4gbWlsZXN0b25lIGFscmVhZHkgZXhpc3RzXCIsICgpID0+IHtcbiAgY29uc3QgdG1wID0gbWFrZVRlbXBEaXIoXCJyZXMtZXhlYy1kZWZlci1leGlzdHNcIik7XG4gIHRyeSB7XG4gICAgLy8gUHJlLWNyZWF0ZSBNMDA1XG4gICAgY29uc3QgbXNEaXIgPSBqb2luKHRtcCwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDVcIik7XG4gICAgbWtkaXJTeW5jKG1zRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4obXNEaXIsIFwiTTAwNS1DT05URVhULm1kXCIpLCBcIiMgTTAwNTogQWxyZWFkeSBQbGFubmVkXFxuXCIsIFwidXRmLThcIik7XG5cbiAgICBjb25zdCBpZCA9IGFwcGVuZENhcHR1cmUodG1wLCBcImRlZmVyIHRoaXNcIik7XG4gICAgbWFya0NhcHR1cmVSZXNvbHZlZCh0bXAsIGlkLCBcImRlZmVyXCIsIFwiZGVmZXJyZWQgdG8gTTAwNVwiLCBcImxhdGVyXCIpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gZXhlY3V0ZVRyaWFnZVJlc29sdXRpb25zKHRtcCwgXCJNMDAxXCIsIFwiUzAxXCIpO1xuXG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5kZWZlcnJlZE1pbGVzdG9uZXMsIDAsIFwic2hvdWxkIG5vdCBjb3VudCBleGlzdGluZyBtaWxlc3RvbmVcIik7XG4gICAgLy8gT3JpZ2luYWwgZmlsZSBzaG91bGQgYmUgcHJlc2VydmVkXG4gICAgYXNzZXJ0Lm9rKGV4aXN0c1N5bmMoam9pbihtc0RpciwgXCJNMDA1LUNPTlRFWFQubWRcIikpLCBcImV4aXN0aW5nIGZpbGVzIHNob3VsZCBiZSBwcmVzZXJ2ZWRcIik7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUlBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxXQUFXLGNBQWMsZUFBZSxRQUFRLGtCQUFrQjtBQUMzRSxTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsZUFBZSxxQkFBcUIscUJB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
