import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendCapture,
  loadAllCaptures,
  loadPendingCaptures,
  loadActionableCaptures,
  hasPendingCaptures,
  markCaptureResolved,
  markCaptureExecuted,
  stampCaptureMilestone,
  resolveCapturesPath,
  parseTriageOutput
} from "../captures.js";
function makeTempDir(prefix) {
  const dir = join(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}
test("captures: appendCapture creates CAPTURES.md on first call", (t) => {
  const tmp = makeTempDir("cap-create");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const id = appendCapture(tmp, "first thought");
  assert.ok(id.startsWith("CAP-"), "ID should start with CAP-");
  assert.ok(
    existsSync(join(tmp, ".gsd", "CAPTURES.md")),
    "CAPTURES.md should exist"
  );
  const content = readFileSync(join(tmp, ".gsd", "CAPTURES.md"), "utf-8");
  assert.ok(content.includes("# Captures"), "should have header");
  assert.ok(content.includes(`### ${id}`), "should have entry heading");
  assert.ok(
    content.includes("**Text:** first thought"),
    "should have text field"
  );
  assert.ok(
    content.includes("**Status:** pending"),
    "should have pending status"
  );
});
test("captures: appendCapture appends to existing file", (t) => {
  const tmp = makeTempDir("cap-append");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const id1 = appendCapture(tmp, "thought one");
  const id2 = appendCapture(tmp, "thought two");
  assert.notStrictEqual(id1, id2, "IDs should be unique");
  const content = readFileSync(join(tmp, ".gsd", "CAPTURES.md"), "utf-8");
  assert.ok(content.includes(`### ${id1}`), "should have first entry");
  assert.ok(content.includes(`### ${id2}`), "should have second entry");
  assert.ok(
    content.includes("**Text:** thought one"),
    "should have first text"
  );
  assert.ok(
    content.includes("**Text:** thought two"),
    "should have second text"
  );
});
test("captures: loadAllCaptures parses entries correctly", (t) => {
  const tmp = makeTempDir("cap-load");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  appendCapture(tmp, "alpha");
  appendCapture(tmp, "beta");
  const all = loadAllCaptures(tmp);
  assert.strictEqual(all.length, 2, "should have 2 entries");
  assert.strictEqual(all[0].text, "alpha");
  assert.strictEqual(all[1].text, "beta");
  assert.strictEqual(all[0].status, "pending");
  assert.strictEqual(all[1].status, "pending");
});
test("captures: loadAllCaptures returns empty array when no file", (t) => {
  const tmp = makeTempDir("cap-nofile");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const all = loadAllCaptures(tmp);
  assert.strictEqual(all.length, 0);
});
test("captures: loadPendingCaptures filters resolved entries", (t) => {
  const tmp = makeTempDir("cap-pending");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const id1 = appendCapture(tmp, "pending one");
  appendCapture(tmp, "pending two");
  markCaptureResolved(tmp, id1, "note", "acknowledged", "just a note");
  const pending = loadPendingCaptures(tmp);
  assert.strictEqual(pending.length, 1, "should have 1 pending");
  assert.strictEqual(pending[0].text, "pending two");
});
test("captures: loadAllCaptures preserves resolved entries", (t) => {
  const tmp = makeTempDir("cap-all-resolved");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const id1 = appendCapture(tmp, "pending one");
  appendCapture(tmp, "pending two");
  markCaptureResolved(tmp, id1, "note", "acknowledged", "just a note");
  const all = loadAllCaptures(tmp);
  assert.strictEqual(all.length, 2, "all should still have 2");
  assert.strictEqual(all[0].status, "resolved");
  assert.strictEqual(all[1].status, "pending");
});
test("captures: hasPendingCaptures returns false when no file", (t) => {
  const tmp = makeTempDir("cap-has-nofile");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  assert.strictEqual(hasPendingCaptures(tmp), false);
});
test("captures: hasPendingCaptures returns true with pending entries", (t) => {
  const tmp = makeTempDir("cap-has-true");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  appendCapture(tmp, "something");
  assert.strictEqual(hasPendingCaptures(tmp), true);
});
test("captures: hasPendingCaptures returns false when all resolved", (t) => {
  const tmp = makeTempDir("cap-has-false");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const id = appendCapture(tmp, "will resolve");
  markCaptureResolved(tmp, id, "note", "done", "resolved it");
  assert.strictEqual(hasPendingCaptures(tmp), false);
});
test("captures: markCaptureResolved updates entry in place", (t) => {
  const tmp = makeTempDir("cap-resolve");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const id1 = appendCapture(tmp, "keep pending");
  const id2 = appendCapture(tmp, "will resolve");
  appendCapture(tmp, "also pending");
  markCaptureResolved(tmp, id2, "quick-task", "executed inline", "small fix");
  const all = loadAllCaptures(tmp);
  assert.strictEqual(all.length, 3, "should still have 3 entries");
  const resolved = all.find((c) => c.id === id2);
  assert.strictEqual(resolved.status, "resolved");
  assert.strictEqual(resolved.classification, "quick-task");
  assert.strictEqual(resolved.resolution, "executed inline");
  assert.strictEqual(resolved.rationale, "small fix");
  assert.ok(resolved.resolvedAt, "should have resolved timestamp");
  const kept = all.find((c) => c.id === id1);
  assert.strictEqual(kept.status, "pending");
  assert.strictEqual(kept.classification, void 0);
});
test("captures: resolveCapturesPath returns .gsd/CAPTURES.md for normal path", () => {
  const base = join(tmpdir(), "cap-test-project");
  const result = resolveCapturesPath(base);
  assert.ok(result.endsWith(join(".gsd", "CAPTURES.md")));
  assert.ok(result.startsWith(base));
});
test("captures: resolveCapturesPath resolves worktree path to project root", () => {
  const base = join(tmpdir(), "cap-test-project");
  const worktreePath = join(base, ".gsd", "worktrees", "M004");
  const result = resolveCapturesPath(worktreePath);
  assert.ok(
    result.endsWith(join(".gsd", "CAPTURES.md")),
    `should end with .gsd/CAPTURES.md, got: ${result}`
  );
  assert.ok(
    !result.includes("worktrees"),
    `should not contain worktrees, got: ${result}`
  );
  assert.ok(
    result.startsWith(base),
    `should start with ${base}, got: ${result}`
  );
});
test("triage: parseTriageOutput handles valid JSON array", () => {
  const input = JSON.stringify([
    {
      captureId: "CAP-abc123",
      classification: "quick-task",
      rationale: "Small fix",
      affectedFiles: ["src/foo.ts"]
    },
    {
      captureId: "CAP-def456",
      classification: "defer",
      rationale: "Future work",
      targetSlice: "S03"
    }
  ]);
  const results = parseTriageOutput(input);
  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[0].captureId, "CAP-abc123");
  assert.strictEqual(results[0].classification, "quick-task");
  assert.deepStrictEqual(results[0].affectedFiles, ["src/foo.ts"]);
  assert.strictEqual(results[1].classification, "defer");
  assert.strictEqual(results[1].targetSlice, "S03");
});
test("triage: parseTriageOutput handles fenced code block", () => {
  const input = `Here are my classifications:

\`\`\`json
[
  {
    "captureId": "CAP-aaa",
    "classification": "note",
    "rationale": "Just informational"
  }
]
\`\`\`

That's my analysis.`;
  const results = parseTriageOutput(input);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].captureId, "CAP-aaa");
  assert.strictEqual(results[0].classification, "note");
});
test("triage: parseTriageOutput handles JSON with leading/trailing prose", () => {
  const input = `I've analyzed the captures. Here are my results:
[{"captureId": "CAP-bbb", "classification": "inject", "rationale": "Needs a new task"}]
Let me know if you need changes.`;
  const results = parseTriageOutput(input);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].classification, "inject");
});
test("triage: parseTriageOutput returns empty array on malformed JSON", () => {
  const results = parseTriageOutput("this is not json at all");
  assert.strictEqual(results.length, 0);
});
test("triage: parseTriageOutput returns empty array on empty input", () => {
  assert.strictEqual(parseTriageOutput("").length, 0);
  assert.strictEqual(parseTriageOutput("  ").length, 0);
});
test("triage: parseTriageOutput filters invalid entries from partial results", () => {
  const input = JSON.stringify([
    {
      captureId: "CAP-good",
      classification: "note",
      rationale: "Valid entry"
    },
    {
      captureId: "CAP-bad",
      classification: "invalid-type",
      rationale: "Bad classification"
    },
    {
      // Missing required fields
      captureId: "CAP-incomplete"
    },
    {
      captureId: "CAP-also-good",
      classification: "replan",
      rationale: "Needs restructuring"
    }
  ]);
  const results = parseTriageOutput(input);
  assert.strictEqual(results.length, 2, "should keep only valid entries");
  assert.strictEqual(results[0].captureId, "CAP-good");
  assert.strictEqual(results[1].captureId, "CAP-also-good");
});
test("triage: parseTriageOutput wraps single object in array", () => {
  const input = JSON.stringify({
    captureId: "CAP-single",
    classification: "quick-task",
    rationale: "Just one"
  });
  const results = parseTriageOutput(input);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].captureId, "CAP-single");
});
test("triage: parseTriageOutput handles all five classification types", () => {
  const types = [
    "quick-task",
    "inject",
    "defer",
    "replan",
    "note"
  ];
  const input = JSON.stringify(
    types.map((t, i) => ({
      captureId: `CAP-${i}`,
      classification: t,
      rationale: `Type: ${t}`
    }))
  );
  const results = parseTriageOutput(input);
  assert.strictEqual(results.length, 5);
  for (let i = 0; i < types.length; i++) {
    assert.strictEqual(results[i].classification, types[i]);
  }
});
test("captures: appendCapture handles special characters in text", (t) => {
  const tmp = makeTempDir("cap-special");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const id = appendCapture(tmp, 'text with "quotes" and **bold** and `code`');
  const all = loadAllCaptures(tmp);
  assert.strictEqual(all.length, 1);
  assert.ok(all[0].text.includes('"quotes"'), "should preserve quotes");
  assert.ok(all[0].text.includes("**bold**"), "should preserve bold");
});
test("captures: markCaptureResolved is no-op for non-existent ID", (t) => {
  const tmp = makeTempDir("cap-noop");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  appendCapture(tmp, "real capture");
  markCaptureResolved(tmp, "CAP-nonexistent", "note", "test", "test");
  const all = loadAllCaptures(tmp);
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].status, "pending", "original should be unchanged");
});
test("captures: markCaptureResolved is no-op when no file exists", (t) => {
  const tmp = makeTempDir("cap-nofile-resolve");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  markCaptureResolved(tmp, "CAP-abc", "note", "test", "test");
});
test("captures: re-resolving a capture overwrites previous resolution", (t) => {
  const tmp = makeTempDir("cap-reresolve");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const id = appendCapture(tmp, "will re-resolve");
  markCaptureResolved(tmp, id, "note", "first resolution", "first rationale");
  markCaptureResolved(tmp, id, "inject", "second resolution", "second rationale");
  const all = loadAllCaptures(tmp);
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].classification, "inject", "should have updated classification");
  assert.strictEqual(all[0].resolution, "second resolution");
  assert.strictEqual(all[0].rationale, "second rationale");
});
test("triage: parseTriageOutput preserves affectedFiles and targetSlice", () => {
  const input = JSON.stringify([
    {
      captureId: "CAP-files",
      classification: "quick-task",
      rationale: "Has files",
      affectedFiles: ["src/a.ts", "src/b.ts"]
    },
    {
      captureId: "CAP-target",
      classification: "defer",
      rationale: "Has target",
      targetSlice: "S04"
    }
  ]);
  const results = parseTriageOutput(input);
  assert.deepStrictEqual(results[0].affectedFiles, ["src/a.ts", "src/b.ts"]);
  assert.strictEqual(results[0].targetSlice, void 0);
  assert.strictEqual(results[1].targetSlice, "S04");
  assert.strictEqual(results[1].affectedFiles, void 0);
});
test("captures: markCaptureResolved stores milestone ID when provided", (t) => {
  const tmp = makeTempDir("cap-milestone");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const id = appendCapture(tmp, "fix dialog width");
  markCaptureResolved(tmp, id, "quick-task", "widen the dialog", "small fix", "M003");
  const all = loadAllCaptures(tmp);
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].resolvedInMilestone, "M003", "should store milestone ID");
});
test("captures: loadActionableCaptures excludes captures resolved in prior milestones", (t) => {
  const tmp = makeTempDir("cap-stale-filter");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const id1 = appendCapture(tmp, "dialog too narrow");
  markCaptureResolved(tmp, id1, "quick-task", "widen it", "small fix", "M003");
  const id2 = appendCapture(tmp, "button misaligned");
  markCaptureResolved(tmp, id2, "quick-task", "fix alignment", "css fix", "M004");
  const id3 = appendCapture(tmp, "typo in label");
  markCaptureResolved(tmp, id3, "quick-task", "fix typo", "trivial");
  const actionable = loadActionableCaptures(tmp, "M004");
  const ids = actionable.map((c) => c.id);
  assert.ok(!ids.includes(id1), "should exclude capture resolved in M003");
  assert.ok(ids.includes(id2), "should include capture resolved in M004");
  assert.ok(ids.includes(id3), "should include capture with no milestone (legacy)");
});
test("captures: loadActionableCaptures without milestone returns all actionable", (t) => {
  const tmp = makeTempDir("cap-no-milestone-filter");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const id1 = appendCapture(tmp, "issue one");
  markCaptureResolved(tmp, id1, "quick-task", "fix it", "small", "M003");
  const id2 = appendCapture(tmp, "issue two");
  markCaptureResolved(tmp, id2, "inject", "inject it", "needed", "M004");
  const actionable = loadActionableCaptures(tmp);
  assert.strictEqual(actionable.length, 2, "should return all actionable without filter");
});
test("captures: loadActionableCaptures excludes already-executed captures", (t) => {
  const tmp = makeTempDir("cap-executed-filter");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const id1 = appendCapture(tmp, "already done");
  markCaptureResolved(tmp, id1, "quick-task", "fix it", "small", "M004");
  markCaptureExecuted(tmp, id1);
  const id2 = appendCapture(tmp, "still pending");
  markCaptureResolved(tmp, id2, "quick-task", "fix it too", "small", "M004");
  const actionable = loadActionableCaptures(tmp, "M004");
  assert.strictEqual(actionable.length, 1, "should exclude executed capture");
  assert.strictEqual(actionable[0].id, id2);
});
test("captures: stampCaptureMilestone adds milestone to capture missing it", (t) => {
  const tmp = makeTempDir("cap-stamp-milestone");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const id = appendCapture(tmp, "fix alignment");
  markCaptureResolved(tmp, id, "quick-task", "fix it", "small");
  let all = loadAllCaptures(tmp);
  assert.strictEqual(all[0].resolvedInMilestone, void 0, "should have no milestone initially");
  stampCaptureMilestone(tmp, id, "M004");
  all = loadAllCaptures(tmp);
  assert.strictEqual(all[0].resolvedInMilestone, "M004", "should have milestone after stamping");
});
test("captures: stampCaptureMilestone is no-op if milestone already present", (t) => {
  const tmp = makeTempDir("cap-stamp-noop");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const id = appendCapture(tmp, "fix alignment");
  markCaptureResolved(tmp, id, "quick-task", "fix it", "small", "M003");
  stampCaptureMilestone(tmp, id, "M004");
  const all = loadAllCaptures(tmp);
  assert.strictEqual(all[0].resolvedInMilestone, "M003", "should keep original milestone");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jYXB0dXJlcy50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFVuaXQgdGVzdHMgZm9yIEdTRCBDYXB0dXJlcyBcdTIwMTQgZmlsZSBJL08sIHBhcnNpbmcsIGFuZCB3b3JrdHJlZSBwYXRoIHJlc29sdXRpb24uXG4gKlxuICogRXhlcmNpc2VzIHRoZSBib3VuZGFyeSBjb250cmFjdCB0aGF0IFMwMiAoYXV0by1tb2RlIGRpc3BhdGNoKSBkZXBlbmRzIG9uOlxuICogLSBhcHBlbmRDYXB0dXJlIGNyZWF0ZXMvYXBwZW5kcyBlbnRyaWVzIHRvIENBUFRVUkVTLm1kXG4gKiAtIGxvYWRBbGxDYXB0dXJlcyAvIGxvYWRQZW5kaW5nQ2FwdHVyZXMgcGFyc2UgYW5kIGZpbHRlciBjb3JyZWN0bHlcbiAqIC0gaGFzUGVuZGluZ0NhcHR1cmVzIGRvZXMgZmFzdCByZWdleCBjaGVjayB3aXRob3V0IGZ1bGwgcGFyc2VcbiAqIC0gbWFya0NhcHR1cmVSZXNvbHZlZCB1cGRhdGVzIGVudHJ5IGluIHBsYWNlXG4gKiAtIHJlc29sdmVDYXB0dXJlc1BhdGggaGFuZGxlcyB3b3JrdHJlZSBwYXRoc1xuICogLSBwYXJzZVRyaWFnZU91dHB1dCBoYW5kbGVzIHZhbGlkLCBtYWxmb3JtZWQsIGFuZCBwYXJ0aWFsIEpTT05cbiAqL1xuXG5pbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZGlyU3luYywgcmVhZEZpbGVTeW5jLCB3cml0ZUZpbGVTeW5jLCBybVN5bmMsIGV4aXN0c1N5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQge1xuICBhcHBlbmRDYXB0dXJlLFxuICBsb2FkQWxsQ2FwdHVyZXMsXG4gIGxvYWRQZW5kaW5nQ2FwdHVyZXMsXG4gIGxvYWRBY3Rpb25hYmxlQ2FwdHVyZXMsXG4gIGhhc1BlbmRpbmdDYXB0dXJlcyxcbiAgbWFya0NhcHR1cmVSZXNvbHZlZCxcbiAgbWFya0NhcHR1cmVFeGVjdXRlZCxcbiAgc3RhbXBDYXB0dXJlTWlsZXN0b25lLFxuICByZXNvbHZlQ2FwdHVyZXNQYXRoLFxuICBwYXJzZVRyaWFnZU91dHB1dCxcbn0gZnJvbSBcIi4uL2NhcHR1cmVzLnRzXCI7XG5cbmZ1bmN0aW9uIG1ha2VUZW1wRGlyKHByZWZpeDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgZGlyID0gam9pbihcbiAgICB0bXBkaXIoKSxcbiAgICBgJHtwcmVmaXh9LSR7RGF0ZS5ub3coKX0tJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyKX1gLFxuICApO1xuICBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgcmV0dXJuIGRpcjtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGFwcGVuZENhcHR1cmUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJjYXB0dXJlczogYXBwZW5kQ2FwdHVyZSBjcmVhdGVzIENBUFRVUkVTLm1kIG9uIGZpcnN0IGNhbGxcIiwgKHQpID0+IHtcbiAgY29uc3QgdG1wID0gbWFrZVRlbXBEaXIoXCJjYXAtY3JlYXRlXCIpO1xuICB0LmFmdGVyKCgpID0+IHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG5cbiAgY29uc3QgaWQgPSBhcHBlbmRDYXB0dXJlKHRtcCwgXCJmaXJzdCB0aG91Z2h0XCIpO1xuICBhc3NlcnQub2soaWQuc3RhcnRzV2l0aChcIkNBUC1cIiksIFwiSUQgc2hvdWxkIHN0YXJ0IHdpdGggQ0FQLVwiKTtcbiAgYXNzZXJ0Lm9rKFxuICAgIGV4aXN0c1N5bmMoam9pbih0bXAsIFwiLmdzZFwiLCBcIkNBUFRVUkVTLm1kXCIpKSxcbiAgICBcIkNBUFRVUkVTLm1kIHNob3VsZCBleGlzdFwiLFxuICApO1xuICBjb25zdCBjb250ZW50ID0gcmVhZEZpbGVTeW5jKGpvaW4odG1wLCBcIi5nc2RcIiwgXCJDQVBUVVJFUy5tZFwiKSwgXCJ1dGYtOFwiKTtcbiAgYXNzZXJ0Lm9rKGNvbnRlbnQuaW5jbHVkZXMoXCIjIENhcHR1cmVzXCIpLCBcInNob3VsZCBoYXZlIGhlYWRlclwiKTtcbiAgYXNzZXJ0Lm9rKGNvbnRlbnQuaW5jbHVkZXMoYCMjIyAke2lkfWApLCBcInNob3VsZCBoYXZlIGVudHJ5IGhlYWRpbmdcIik7XG4gIGFzc2VydC5vayhcbiAgICBjb250ZW50LmluY2x1ZGVzKFwiKipUZXh0OioqIGZpcnN0IHRob3VnaHRcIiksXG4gICAgXCJzaG91bGQgaGF2ZSB0ZXh0IGZpZWxkXCIsXG4gICk7XG4gIGFzc2VydC5vayhcbiAgICBjb250ZW50LmluY2x1ZGVzKFwiKipTdGF0dXM6KiogcGVuZGluZ1wiKSxcbiAgICBcInNob3VsZCBoYXZlIHBlbmRpbmcgc3RhdHVzXCIsXG4gICk7XG59KTtcblxudGVzdChcImNhcHR1cmVzOiBhcHBlbmRDYXB0dXJlIGFwcGVuZHMgdG8gZXhpc3RpbmcgZmlsZVwiLCAodCkgPT4ge1xuICBjb25zdCB0bXAgPSBtYWtlVGVtcERpcihcImNhcC1hcHBlbmRcIik7XG4gIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcblxuICBjb25zdCBpZDEgPSBhcHBlbmRDYXB0dXJlKHRtcCwgXCJ0aG91Z2h0IG9uZVwiKTtcbiAgY29uc3QgaWQyID0gYXBwZW5kQ2FwdHVyZSh0bXAsIFwidGhvdWdodCB0d29cIik7XG4gIGFzc2VydC5ub3RTdHJpY3RFcXVhbChpZDEsIGlkMiwgXCJJRHMgc2hvdWxkIGJlIHVuaXF1ZVwiKTtcblxuICBjb25zdCBjb250ZW50ID0gcmVhZEZpbGVTeW5jKGpvaW4odG1wLCBcIi5nc2RcIiwgXCJDQVBUVVJFUy5tZFwiKSwgXCJ1dGYtOFwiKTtcbiAgYXNzZXJ0Lm9rKGNvbnRlbnQuaW5jbHVkZXMoYCMjIyAke2lkMX1gKSwgXCJzaG91bGQgaGF2ZSBmaXJzdCBlbnRyeVwiKTtcbiAgYXNzZXJ0Lm9rKGNvbnRlbnQuaW5jbHVkZXMoYCMjIyAke2lkMn1gKSwgXCJzaG91bGQgaGF2ZSBzZWNvbmQgZW50cnlcIik7XG4gIGFzc2VydC5vayhcbiAgICBjb250ZW50LmluY2x1ZGVzKFwiKipUZXh0OioqIHRob3VnaHQgb25lXCIpLFxuICAgIFwic2hvdWxkIGhhdmUgZmlyc3QgdGV4dFwiLFxuICApO1xuICBhc3NlcnQub2soXG4gICAgY29udGVudC5pbmNsdWRlcyhcIioqVGV4dDoqKiB0aG91Z2h0IHR3b1wiKSxcbiAgICBcInNob3VsZCBoYXZlIHNlY29uZCB0ZXh0XCIsXG4gICk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGxvYWRBbGxDYXB0dXJlcyAvIGxvYWRQZW5kaW5nQ2FwdHVyZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJjYXB0dXJlczogbG9hZEFsbENhcHR1cmVzIHBhcnNlcyBlbnRyaWVzIGNvcnJlY3RseVwiLCAodCkgPT4ge1xuICBjb25zdCB0bXAgPSBtYWtlVGVtcERpcihcImNhcC1sb2FkXCIpO1xuICB0LmFmdGVyKCgpID0+IHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG5cbiAgYXBwZW5kQ2FwdHVyZSh0bXAsIFwiYWxwaGFcIik7XG4gIGFwcGVuZENhcHR1cmUodG1wLCBcImJldGFcIik7XG5cbiAgY29uc3QgYWxsID0gbG9hZEFsbENhcHR1cmVzKHRtcCk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChhbGwubGVuZ3RoLCAyLCBcInNob3VsZCBoYXZlIDIgZW50cmllc1wiKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKGFsbFswXS50ZXh0LCBcImFscGhhXCIpO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwoYWxsWzFdLnRleHQsIFwiYmV0YVwiKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKGFsbFswXS5zdGF0dXMsIFwicGVuZGluZ1wiKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKGFsbFsxXS5zdGF0dXMsIFwicGVuZGluZ1wiKTtcbn0pO1xuXG50ZXN0KFwiY2FwdHVyZXM6IGxvYWRBbGxDYXB0dXJlcyByZXR1cm5zIGVtcHR5IGFycmF5IHdoZW4gbm8gZmlsZVwiLCAodCkgPT4ge1xuICBjb25zdCB0bXAgPSBtYWtlVGVtcERpcihcImNhcC1ub2ZpbGVcIik7XG4gIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcblxuICBjb25zdCBhbGwgPSBsb2FkQWxsQ2FwdHVyZXModG1wKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKGFsbC5sZW5ndGgsIDApO1xufSk7XG5cbnRlc3QoXCJjYXB0dXJlczogbG9hZFBlbmRpbmdDYXB0dXJlcyBmaWx0ZXJzIHJlc29sdmVkIGVudHJpZXNcIiwgKHQpID0+IHtcbiAgY29uc3QgdG1wID0gbWFrZVRlbXBEaXIoXCJjYXAtcGVuZGluZ1wiKTtcbiAgdC5hZnRlcigoKSA9PiBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuXG4gIGNvbnN0IGlkMSA9IGFwcGVuZENhcHR1cmUodG1wLCBcInBlbmRpbmcgb25lXCIpO1xuICBhcHBlbmRDYXB0dXJlKHRtcCwgXCJwZW5kaW5nIHR3b1wiKTtcblxuICBtYXJrQ2FwdHVyZVJlc29sdmVkKHRtcCwgaWQxLCBcIm5vdGVcIiwgXCJhY2tub3dsZWRnZWRcIiwgXCJqdXN0IGEgbm90ZVwiKTtcblxuICBjb25zdCBwZW5kaW5nID0gbG9hZFBlbmRpbmdDYXB0dXJlcyh0bXApO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwocGVuZGluZy5sZW5ndGgsIDEsIFwic2hvdWxkIGhhdmUgMSBwZW5kaW5nXCIpO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwocGVuZGluZ1swXS50ZXh0LCBcInBlbmRpbmcgdHdvXCIpO1xufSk7XG5cbnRlc3QoXCJjYXB0dXJlczogbG9hZEFsbENhcHR1cmVzIHByZXNlcnZlcyByZXNvbHZlZCBlbnRyaWVzXCIsICh0KSA9PiB7XG4gIGNvbnN0IHRtcCA9IG1ha2VUZW1wRGlyKFwiY2FwLWFsbC1yZXNvbHZlZFwiKTtcbiAgdC5hZnRlcigoKSA9PiBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuXG4gIGNvbnN0IGlkMSA9IGFwcGVuZENhcHR1cmUodG1wLCBcInBlbmRpbmcgb25lXCIpO1xuICBhcHBlbmRDYXB0dXJlKHRtcCwgXCJwZW5kaW5nIHR3b1wiKTtcblxuICBtYXJrQ2FwdHVyZVJlc29sdmVkKHRtcCwgaWQxLCBcIm5vdGVcIiwgXCJhY2tub3dsZWRnZWRcIiwgXCJqdXN0IGEgbm90ZVwiKTtcblxuICBjb25zdCBhbGwgPSBsb2FkQWxsQ2FwdHVyZXModG1wKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKGFsbC5sZW5ndGgsIDIsIFwiYWxsIHNob3VsZCBzdGlsbCBoYXZlIDJcIik7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChhbGxbMF0uc3RhdHVzLCBcInJlc29sdmVkXCIpO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwoYWxsWzFdLnN0YXR1cywgXCJwZW5kaW5nXCIpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBoYXNQZW5kaW5nQ2FwdHVyZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJjYXB0dXJlczogaGFzUGVuZGluZ0NhcHR1cmVzIHJldHVybnMgZmFsc2Ugd2hlbiBubyBmaWxlXCIsICh0KSA9PiB7XG4gIGNvbnN0IHRtcCA9IG1ha2VUZW1wRGlyKFwiY2FwLWhhcy1ub2ZpbGVcIik7XG4gIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcblxuICBhc3NlcnQuc3RyaWN0RXF1YWwoaGFzUGVuZGluZ0NhcHR1cmVzKHRtcCksIGZhbHNlKTtcbn0pO1xuXG50ZXN0KFwiY2FwdHVyZXM6IGhhc1BlbmRpbmdDYXB0dXJlcyByZXR1cm5zIHRydWUgd2l0aCBwZW5kaW5nIGVudHJpZXNcIiwgKHQpID0+IHtcbiAgY29uc3QgdG1wID0gbWFrZVRlbXBEaXIoXCJjYXAtaGFzLXRydWVcIik7XG4gIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcblxuICBhcHBlbmRDYXB0dXJlKHRtcCwgXCJzb21ldGhpbmdcIik7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChoYXNQZW5kaW5nQ2FwdHVyZXModG1wKSwgdHJ1ZSk7XG59KTtcblxudGVzdChcImNhcHR1cmVzOiBoYXNQZW5kaW5nQ2FwdHVyZXMgcmV0dXJucyBmYWxzZSB3aGVuIGFsbCByZXNvbHZlZFwiLCAodCkgPT4ge1xuICBjb25zdCB0bXAgPSBtYWtlVGVtcERpcihcImNhcC1oYXMtZmFsc2VcIik7XG4gIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcblxuICBjb25zdCBpZCA9IGFwcGVuZENhcHR1cmUodG1wLCBcIndpbGwgcmVzb2x2ZVwiKTtcbiAgbWFya0NhcHR1cmVSZXNvbHZlZCh0bXAsIGlkLCBcIm5vdGVcIiwgXCJkb25lXCIsIFwicmVzb2x2ZWQgaXRcIik7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChoYXNQZW5kaW5nQ2FwdHVyZXModG1wKSwgZmFsc2UpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBtYXJrQ2FwdHVyZVJlc29sdmVkIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiY2FwdHVyZXM6IG1hcmtDYXB0dXJlUmVzb2x2ZWQgdXBkYXRlcyBlbnRyeSBpbiBwbGFjZVwiLCAodCkgPT4ge1xuICBjb25zdCB0bXAgPSBtYWtlVGVtcERpcihcImNhcC1yZXNvbHZlXCIpO1xuICB0LmFmdGVyKCgpID0+IHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG5cbiAgY29uc3QgaWQxID0gYXBwZW5kQ2FwdHVyZSh0bXAsIFwia2VlcCBwZW5kaW5nXCIpO1xuICBjb25zdCBpZDIgPSBhcHBlbmRDYXB0dXJlKHRtcCwgXCJ3aWxsIHJlc29sdmVcIik7XG4gIGFwcGVuZENhcHR1cmUodG1wLCBcImFsc28gcGVuZGluZ1wiKTtcblxuICBtYXJrQ2FwdHVyZVJlc29sdmVkKHRtcCwgaWQyLCBcInF1aWNrLXRhc2tcIiwgXCJleGVjdXRlZCBpbmxpbmVcIiwgXCJzbWFsbCBmaXhcIik7XG5cbiAgY29uc3QgYWxsID0gbG9hZEFsbENhcHR1cmVzKHRtcCk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChhbGwubGVuZ3RoLCAzLCBcInNob3VsZCBzdGlsbCBoYXZlIDMgZW50cmllc1wiKTtcblxuICBjb25zdCByZXNvbHZlZCA9IGFsbC5maW5kKChjKSA9PiBjLmlkID09PSBpZDIpITtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc29sdmVkLnN0YXR1cywgXCJyZXNvbHZlZFwiKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc29sdmVkLmNsYXNzaWZpY2F0aW9uLCBcInF1aWNrLXRhc2tcIik7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXNvbHZlZC5yZXNvbHV0aW9uLCBcImV4ZWN1dGVkIGlubGluZVwiKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc29sdmVkLnJhdGlvbmFsZSwgXCJzbWFsbCBmaXhcIik7XG4gIGFzc2VydC5vayhyZXNvbHZlZC5yZXNvbHZlZEF0LCBcInNob3VsZCBoYXZlIHJlc29sdmVkIHRpbWVzdGFtcFwiKTtcblxuICAvLyBPdGhlcnMgc2hvdWxkIGJlIHVuYWZmZWN0ZWRcbiAgY29uc3Qga2VwdCA9IGFsbC5maW5kKChjKSA9PiBjLmlkID09PSBpZDEpITtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKGtlcHQuc3RhdHVzLCBcInBlbmRpbmdcIik7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChrZXB0LmNsYXNzaWZpY2F0aW9uLCB1bmRlZmluZWQpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCByZXNvbHZlQ2FwdHVyZXNQYXRoIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiY2FwdHVyZXM6IHJlc29sdmVDYXB0dXJlc1BhdGggcmV0dXJucyAuZ3NkL0NBUFRVUkVTLm1kIGZvciBub3JtYWwgcGF0aFwiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBqb2luKHRtcGRpcigpLCBcImNhcC10ZXN0LXByb2plY3RcIik7XG4gIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVDYXB0dXJlc1BhdGgoYmFzZSk7XG4gIGFzc2VydC5vayhyZXN1bHQuZW5kc1dpdGgoam9pbihcIi5nc2RcIiwgXCJDQVBUVVJFUy5tZFwiKSkpO1xuICBhc3NlcnQub2socmVzdWx0LnN0YXJ0c1dpdGgoYmFzZSkpO1xufSk7XG5cbnRlc3QoXCJjYXB0dXJlczogcmVzb2x2ZUNhcHR1cmVzUGF0aCByZXNvbHZlcyB3b3JrdHJlZSBwYXRoIHRvIHByb2plY3Qgcm9vdFwiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBqb2luKHRtcGRpcigpLCBcImNhcC10ZXN0LXByb2plY3RcIik7XG4gIGNvbnN0IHdvcmt0cmVlUGF0aCA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwid29ya3RyZWVzXCIsIFwiTTAwNFwiKTtcbiAgY29uc3QgcmVzdWx0ID0gcmVzb2x2ZUNhcHR1cmVzUGF0aCh3b3JrdHJlZVBhdGgpO1xuICBhc3NlcnQub2soXG4gICAgcmVzdWx0LmVuZHNXaXRoKGpvaW4oXCIuZ3NkXCIsIFwiQ0FQVFVSRVMubWRcIikpLFxuICAgIGBzaG91bGQgZW5kIHdpdGggLmdzZC9DQVBUVVJFUy5tZCwgZ290OiAke3Jlc3VsdH1gLFxuICApO1xuICAvLyBTaG91bGQgcmVzb2x2ZSB0byBwcm9qZWN0IHJvb3QsIG5vdCB3b3JrdHJlZSByb290XG4gIGFzc2VydC5vayhcbiAgICAhcmVzdWx0LmluY2x1ZGVzKFwid29ya3RyZWVzXCIpLFxuICAgIGBzaG91bGQgbm90IGNvbnRhaW4gd29ya3RyZWVzLCBnb3Q6ICR7cmVzdWx0fWAsXG4gICk7XG4gIGFzc2VydC5vayhcbiAgICByZXN1bHQuc3RhcnRzV2l0aChiYXNlKSxcbiAgICBgc2hvdWxkIHN0YXJ0IHdpdGggJHtiYXNlfSwgZ290OiAke3Jlc3VsdH1gLFxuICApO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBwYXJzZVRyaWFnZU91dHB1dCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcInRyaWFnZTogcGFyc2VUcmlhZ2VPdXRwdXQgaGFuZGxlcyB2YWxpZCBKU09OIGFycmF5XCIsICgpID0+IHtcbiAgY29uc3QgaW5wdXQgPSBKU09OLnN0cmluZ2lmeShbXG4gICAge1xuICAgICAgY2FwdHVyZUlkOiBcIkNBUC1hYmMxMjNcIixcbiAgICAgIGNsYXNzaWZpY2F0aW9uOiBcInF1aWNrLXRhc2tcIixcbiAgICAgIHJhdGlvbmFsZTogXCJTbWFsbCBmaXhcIixcbiAgICAgIGFmZmVjdGVkRmlsZXM6IFtcInNyYy9mb28udHNcIl0sXG4gICAgfSxcbiAgICB7XG4gICAgICBjYXB0dXJlSWQ6IFwiQ0FQLWRlZjQ1NlwiLFxuICAgICAgY2xhc3NpZmljYXRpb246IFwiZGVmZXJcIixcbiAgICAgIHJhdGlvbmFsZTogXCJGdXR1cmUgd29ya1wiLFxuICAgICAgdGFyZ2V0U2xpY2U6IFwiUzAzXCIsXG4gICAgfSxcbiAgXSk7XG5cbiAgY29uc3QgcmVzdWx0cyA9IHBhcnNlVHJpYWdlT3V0cHV0KGlucHV0KTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdHMubGVuZ3RoLCAyKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdHNbMF0uY2FwdHVyZUlkLCBcIkNBUC1hYmMxMjNcIik7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHRzWzBdLmNsYXNzaWZpY2F0aW9uLCBcInF1aWNrLXRhc2tcIik7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0c1swXS5hZmZlY3RlZEZpbGVzLCBbXCJzcmMvZm9vLnRzXCJdKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdHNbMV0uY2xhc3NpZmljYXRpb24sIFwiZGVmZXJcIik7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHRzWzFdLnRhcmdldFNsaWNlLCBcIlMwM1wiKTtcbn0pO1xuXG50ZXN0KFwidHJpYWdlOiBwYXJzZVRyaWFnZU91dHB1dCBoYW5kbGVzIGZlbmNlZCBjb2RlIGJsb2NrXCIsICgpID0+IHtcbiAgY29uc3QgaW5wdXQgPSBgSGVyZSBhcmUgbXkgY2xhc3NpZmljYXRpb25zOlxuXG5cXGBcXGBcXGBqc29uXG5bXG4gIHtcbiAgICBcImNhcHR1cmVJZFwiOiBcIkNBUC1hYWFcIixcbiAgICBcImNsYXNzaWZpY2F0aW9uXCI6IFwibm90ZVwiLFxuICAgIFwicmF0aW9uYWxlXCI6IFwiSnVzdCBpbmZvcm1hdGlvbmFsXCJcbiAgfVxuXVxuXFxgXFxgXFxgXG5cblRoYXQncyBteSBhbmFseXNpcy5gO1xuXG4gIGNvbnN0IHJlc3VsdHMgPSBwYXJzZVRyaWFnZU91dHB1dChpbnB1dCk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHRzLmxlbmd0aCwgMSk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHRzWzBdLmNhcHR1cmVJZCwgXCJDQVAtYWFhXCIpO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0c1swXS5jbGFzc2lmaWNhdGlvbiwgXCJub3RlXCIpO1xufSk7XG5cbnRlc3QoXCJ0cmlhZ2U6IHBhcnNlVHJpYWdlT3V0cHV0IGhhbmRsZXMgSlNPTiB3aXRoIGxlYWRpbmcvdHJhaWxpbmcgcHJvc2VcIiwgKCkgPT4ge1xuICBjb25zdCBpbnB1dCA9IGBJJ3ZlIGFuYWx5emVkIHRoZSBjYXB0dXJlcy4gSGVyZSBhcmUgbXkgcmVzdWx0czpcblt7XCJjYXB0dXJlSWRcIjogXCJDQVAtYmJiXCIsIFwiY2xhc3NpZmljYXRpb25cIjogXCJpbmplY3RcIiwgXCJyYXRpb25hbGVcIjogXCJOZWVkcyBhIG5ldyB0YXNrXCJ9XVxuTGV0IG1lIGtub3cgaWYgeW91IG5lZWQgY2hhbmdlcy5gO1xuXG4gIGNvbnN0IHJlc3VsdHMgPSBwYXJzZVRyaWFnZU91dHB1dChpbnB1dCk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHRzLmxlbmd0aCwgMSk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHRzWzBdLmNsYXNzaWZpY2F0aW9uLCBcImluamVjdFwiKTtcbn0pO1xuXG50ZXN0KFwidHJpYWdlOiBwYXJzZVRyaWFnZU91dHB1dCByZXR1cm5zIGVtcHR5IGFycmF5IG9uIG1hbGZvcm1lZCBKU09OXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0cyA9IHBhcnNlVHJpYWdlT3V0cHV0KFwidGhpcyBpcyBub3QganNvbiBhdCBhbGxcIik7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHRzLmxlbmd0aCwgMCk7XG59KTtcblxudGVzdChcInRyaWFnZTogcGFyc2VUcmlhZ2VPdXRwdXQgcmV0dXJucyBlbXB0eSBhcnJheSBvbiBlbXB0eSBpbnB1dFwiLCAoKSA9PiB7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChwYXJzZVRyaWFnZU91dHB1dChcIlwiKS5sZW5ndGgsIDApO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwocGFyc2VUcmlhZ2VPdXRwdXQoXCIgIFwiKS5sZW5ndGgsIDApO1xufSk7XG5cbnRlc3QoXCJ0cmlhZ2U6IHBhcnNlVHJpYWdlT3V0cHV0IGZpbHRlcnMgaW52YWxpZCBlbnRyaWVzIGZyb20gcGFydGlhbCByZXN1bHRzXCIsICgpID0+IHtcbiAgY29uc3QgaW5wdXQgPSBKU09OLnN0cmluZ2lmeShbXG4gICAge1xuICAgICAgY2FwdHVyZUlkOiBcIkNBUC1nb29kXCIsXG4gICAgICBjbGFzc2lmaWNhdGlvbjogXCJub3RlXCIsXG4gICAgICByYXRpb25hbGU6IFwiVmFsaWQgZW50cnlcIixcbiAgICB9LFxuICAgIHtcbiAgICAgIGNhcHR1cmVJZDogXCJDQVAtYmFkXCIsXG4gICAgICBjbGFzc2lmaWNhdGlvbjogXCJpbnZhbGlkLXR5cGVcIixcbiAgICAgIHJhdGlvbmFsZTogXCJCYWQgY2xhc3NpZmljYXRpb25cIixcbiAgICB9LFxuICAgIHtcbiAgICAgIC8vIE1pc3NpbmcgcmVxdWlyZWQgZmllbGRzXG4gICAgICBjYXB0dXJlSWQ6IFwiQ0FQLWluY29tcGxldGVcIixcbiAgICB9LFxuICAgIHtcbiAgICAgIGNhcHR1cmVJZDogXCJDQVAtYWxzby1nb29kXCIsXG4gICAgICBjbGFzc2lmaWNhdGlvbjogXCJyZXBsYW5cIixcbiAgICAgIHJhdGlvbmFsZTogXCJOZWVkcyByZXN0cnVjdHVyaW5nXCIsXG4gICAgfSxcbiAgXSk7XG5cbiAgY29uc3QgcmVzdWx0cyA9IHBhcnNlVHJpYWdlT3V0cHV0KGlucHV0KTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdHMubGVuZ3RoLCAyLCBcInNob3VsZCBrZWVwIG9ubHkgdmFsaWQgZW50cmllc1wiKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdHNbMF0uY2FwdHVyZUlkLCBcIkNBUC1nb29kXCIpO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0c1sxXS5jYXB0dXJlSWQsIFwiQ0FQLWFsc28tZ29vZFwiKTtcbn0pO1xuXG50ZXN0KFwidHJpYWdlOiBwYXJzZVRyaWFnZU91dHB1dCB3cmFwcyBzaW5nbGUgb2JqZWN0IGluIGFycmF5XCIsICgpID0+IHtcbiAgY29uc3QgaW5wdXQgPSBKU09OLnN0cmluZ2lmeSh7XG4gICAgY2FwdHVyZUlkOiBcIkNBUC1zaW5nbGVcIixcbiAgICBjbGFzc2lmaWNhdGlvbjogXCJxdWljay10YXNrXCIsXG4gICAgcmF0aW9uYWxlOiBcIkp1c3Qgb25lXCIsXG4gIH0pO1xuXG4gIGNvbnN0IHJlc3VsdHMgPSBwYXJzZVRyaWFnZU91dHB1dChpbnB1dCk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHRzLmxlbmd0aCwgMSk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHRzWzBdLmNhcHR1cmVJZCwgXCJDQVAtc2luZ2xlXCIpO1xufSk7XG5cbnRlc3QoXCJ0cmlhZ2U6IHBhcnNlVHJpYWdlT3V0cHV0IGhhbmRsZXMgYWxsIGZpdmUgY2xhc3NpZmljYXRpb24gdHlwZXNcIiwgKCkgPT4ge1xuICBjb25zdCB0eXBlcyA9IFtcbiAgICBcInF1aWNrLXRhc2tcIixcbiAgICBcImluamVjdFwiLFxuICAgIFwiZGVmZXJcIixcbiAgICBcInJlcGxhblwiLFxuICAgIFwibm90ZVwiLFxuICBdIGFzIGNvbnN0O1xuXG4gIGNvbnN0IGlucHV0ID0gSlNPTi5zdHJpbmdpZnkoXG4gICAgdHlwZXMubWFwKCh0LCBpKSA9PiAoe1xuICAgICAgY2FwdHVyZUlkOiBgQ0FQLSR7aX1gLFxuICAgICAgY2xhc3NpZmljYXRpb246IHQsXG4gICAgICByYXRpb25hbGU6IGBUeXBlOiAke3R9YCxcbiAgICB9KSksXG4gICk7XG5cbiAgY29uc3QgcmVzdWx0cyA9IHBhcnNlVHJpYWdlT3V0cHV0KGlucHV0KTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdHMubGVuZ3RoLCA1KTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCB0eXBlcy5sZW5ndGg7IGkrKykge1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHRzW2ldLmNsYXNzaWZpY2F0aW9uLCB0eXBlc1tpXSk7XG4gIH1cbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRWRnZSBDYXNlcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcImNhcHR1cmVzOiBhcHBlbmRDYXB0dXJlIGhhbmRsZXMgc3BlY2lhbCBjaGFyYWN0ZXJzIGluIHRleHRcIiwgKHQpID0+IHtcbiAgY29uc3QgdG1wID0gbWFrZVRlbXBEaXIoXCJjYXAtc3BlY2lhbFwiKTtcbiAgdC5hZnRlcigoKSA9PiBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuXG4gIGNvbnN0IGlkID0gYXBwZW5kQ2FwdHVyZSh0bXAsICd0ZXh0IHdpdGggXCJxdW90ZXNcIiBhbmQgKipib2xkKiogYW5kIGBjb2RlYCcpO1xuICBjb25zdCBhbGwgPSBsb2FkQWxsQ2FwdHVyZXModG1wKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKGFsbC5sZW5ndGgsIDEpO1xuICBhc3NlcnQub2soYWxsWzBdLnRleHQuaW5jbHVkZXMoJ1wicXVvdGVzXCInKSwgXCJzaG91bGQgcHJlc2VydmUgcXVvdGVzXCIpO1xuICBhc3NlcnQub2soYWxsWzBdLnRleHQuaW5jbHVkZXMoXCIqKmJvbGQqKlwiKSwgXCJzaG91bGQgcHJlc2VydmUgYm9sZFwiKTtcbn0pO1xuXG50ZXN0KFwiY2FwdHVyZXM6IG1hcmtDYXB0dXJlUmVzb2x2ZWQgaXMgbm8tb3AgZm9yIG5vbi1leGlzdGVudCBJRFwiLCAodCkgPT4ge1xuICBjb25zdCB0bXAgPSBtYWtlVGVtcERpcihcImNhcC1ub29wXCIpO1xuICB0LmFmdGVyKCgpID0+IHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG5cbiAgYXBwZW5kQ2FwdHVyZSh0bXAsIFwicmVhbCBjYXB0dXJlXCIpO1xuICAvLyBTaG91bGQgbm90IHRocm93XG4gIG1hcmtDYXB0dXJlUmVzb2x2ZWQodG1wLCBcIkNBUC1ub25leGlzdGVudFwiLCBcIm5vdGVcIiwgXCJ0ZXN0XCIsIFwidGVzdFwiKTtcbiAgY29uc3QgYWxsID0gbG9hZEFsbENhcHR1cmVzKHRtcCk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChhbGwubGVuZ3RoLCAxKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKGFsbFswXS5zdGF0dXMsIFwicGVuZGluZ1wiLCBcIm9yaWdpbmFsIHNob3VsZCBiZSB1bmNoYW5nZWRcIik7XG59KTtcblxudGVzdChcImNhcHR1cmVzOiBtYXJrQ2FwdHVyZVJlc29sdmVkIGlzIG5vLW9wIHdoZW4gbm8gZmlsZSBleGlzdHNcIiwgKHQpID0+IHtcbiAgY29uc3QgdG1wID0gbWFrZVRlbXBEaXIoXCJjYXAtbm9maWxlLXJlc29sdmVcIik7XG4gIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcblxuICAvLyBTaG91bGQgbm90IHRocm93XG4gIG1hcmtDYXB0dXJlUmVzb2x2ZWQodG1wLCBcIkNBUC1hYmNcIiwgXCJub3RlXCIsIFwidGVzdFwiLCBcInRlc3RcIik7XG59KTtcblxudGVzdChcImNhcHR1cmVzOiByZS1yZXNvbHZpbmcgYSBjYXB0dXJlIG92ZXJ3cml0ZXMgcHJldmlvdXMgcmVzb2x1dGlvblwiLCAodCkgPT4ge1xuICBjb25zdCB0bXAgPSBtYWtlVGVtcERpcihcImNhcC1yZXJlc29sdmVcIik7XG4gIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcblxuICBjb25zdCBpZCA9IGFwcGVuZENhcHR1cmUodG1wLCBcIndpbGwgcmUtcmVzb2x2ZVwiKTtcbiAgbWFya0NhcHR1cmVSZXNvbHZlZCh0bXAsIGlkLCBcIm5vdGVcIiwgXCJmaXJzdCByZXNvbHV0aW9uXCIsIFwiZmlyc3QgcmF0aW9uYWxlXCIpO1xuICBtYXJrQ2FwdHVyZVJlc29sdmVkKHRtcCwgaWQsIFwiaW5qZWN0XCIsIFwic2Vjb25kIHJlc29sdXRpb25cIiwgXCJzZWNvbmQgcmF0aW9uYWxlXCIpO1xuXG4gIGNvbnN0IGFsbCA9IGxvYWRBbGxDYXB0dXJlcyh0bXApO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwoYWxsLmxlbmd0aCwgMSk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChhbGxbMF0uY2xhc3NpZmljYXRpb24sIFwiaW5qZWN0XCIsIFwic2hvdWxkIGhhdmUgdXBkYXRlZCBjbGFzc2lmaWNhdGlvblwiKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKGFsbFswXS5yZXNvbHV0aW9uLCBcInNlY29uZCByZXNvbHV0aW9uXCIpO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwoYWxsWzBdLnJhdGlvbmFsZSwgXCJzZWNvbmQgcmF0aW9uYWxlXCIpO1xufSk7XG5cbnRlc3QoXCJ0cmlhZ2U6IHBhcnNlVHJpYWdlT3V0cHV0IHByZXNlcnZlcyBhZmZlY3RlZEZpbGVzIGFuZCB0YXJnZXRTbGljZVwiLCAoKSA9PiB7XG4gIGNvbnN0IGlucHV0ID0gSlNPTi5zdHJpbmdpZnkoW1xuICAgIHtcbiAgICAgIGNhcHR1cmVJZDogXCJDQVAtZmlsZXNcIixcbiAgICAgIGNsYXNzaWZpY2F0aW9uOiBcInF1aWNrLXRhc2tcIixcbiAgICAgIHJhdGlvbmFsZTogXCJIYXMgZmlsZXNcIixcbiAgICAgIGFmZmVjdGVkRmlsZXM6IFtcInNyYy9hLnRzXCIsIFwic3JjL2IudHNcIl0sXG4gICAgfSxcbiAgICB7XG4gICAgICBjYXB0dXJlSWQ6IFwiQ0FQLXRhcmdldFwiLFxuICAgICAgY2xhc3NpZmljYXRpb246IFwiZGVmZXJcIixcbiAgICAgIHJhdGlvbmFsZTogXCJIYXMgdGFyZ2V0XCIsXG4gICAgICB0YXJnZXRTbGljZTogXCJTMDRcIixcbiAgICB9LFxuICBdKTtcblxuICBjb25zdCByZXN1bHRzID0gcGFyc2VUcmlhZ2VPdXRwdXQoaW5wdXQpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdHNbMF0uYWZmZWN0ZWRGaWxlcywgW1wic3JjL2EudHNcIiwgXCJzcmMvYi50c1wiXSk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHRzWzBdLnRhcmdldFNsaWNlLCB1bmRlZmluZWQpO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0c1sxXS50YXJnZXRTbGljZSwgXCJTMDRcIik7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHRzWzFdLmFmZmVjdGVkRmlsZXMsIHVuZGVmaW5lZCk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFN0YWxlIFF1aWNrLVRhc2sgQ2FwdHVyZXMgKCMyODcyKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcImNhcHR1cmVzOiBtYXJrQ2FwdHVyZVJlc29sdmVkIHN0b3JlcyBtaWxlc3RvbmUgSUQgd2hlbiBwcm92aWRlZFwiLCAodCkgPT4ge1xuICBjb25zdCB0bXAgPSBtYWtlVGVtcERpcihcImNhcC1taWxlc3RvbmVcIik7XG4gIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcblxuICBjb25zdCBpZCA9IGFwcGVuZENhcHR1cmUodG1wLCBcImZpeCBkaWFsb2cgd2lkdGhcIik7XG4gIG1hcmtDYXB0dXJlUmVzb2x2ZWQodG1wLCBpZCwgXCJxdWljay10YXNrXCIsIFwid2lkZW4gdGhlIGRpYWxvZ1wiLCBcInNtYWxsIGZpeFwiLCBcIk0wMDNcIik7XG5cbiAgY29uc3QgYWxsID0gbG9hZEFsbENhcHR1cmVzKHRtcCk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChhbGwubGVuZ3RoLCAxKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKGFsbFswXS5yZXNvbHZlZEluTWlsZXN0b25lLCBcIk0wMDNcIiwgXCJzaG91bGQgc3RvcmUgbWlsZXN0b25lIElEXCIpO1xufSk7XG5cbnRlc3QoXCJjYXB0dXJlczogbG9hZEFjdGlvbmFibGVDYXB0dXJlcyBleGNsdWRlcyBjYXB0dXJlcyByZXNvbHZlZCBpbiBwcmlvciBtaWxlc3RvbmVzXCIsICh0KSA9PiB7XG4gIGNvbnN0IHRtcCA9IG1ha2VUZW1wRGlyKFwiY2FwLXN0YWxlLWZpbHRlclwiKTtcbiAgdC5hZnRlcigoKSA9PiBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuXG4gIC8vIENhcHR1cmUgcmVzb2x2ZWQgaW4gTTAwMyAocHJpb3IgbWlsZXN0b25lKVxuICBjb25zdCBpZDEgPSBhcHBlbmRDYXB0dXJlKHRtcCwgXCJkaWFsb2cgdG9vIG5hcnJvd1wiKTtcbiAgbWFya0NhcHR1cmVSZXNvbHZlZCh0bXAsIGlkMSwgXCJxdWljay10YXNrXCIsIFwid2lkZW4gaXRcIiwgXCJzbWFsbCBmaXhcIiwgXCJNMDAzXCIpO1xuXG4gIC8vIENhcHR1cmUgcmVzb2x2ZWQgaW4gTTAwNCAoY3VycmVudCBtaWxlc3RvbmUpXG4gIGNvbnN0IGlkMiA9IGFwcGVuZENhcHR1cmUodG1wLCBcImJ1dHRvbiBtaXNhbGlnbmVkXCIpO1xuICBtYXJrQ2FwdHVyZVJlc29sdmVkKHRtcCwgaWQyLCBcInF1aWNrLXRhc2tcIiwgXCJmaXggYWxpZ25tZW50XCIsIFwiY3NzIGZpeFwiLCBcIk0wMDRcIik7XG5cbiAgLy8gQ2FwdHVyZSByZXNvbHZlZCB3aXRob3V0IG1pbGVzdG9uZSBjb250ZXh0IChsZWdhY3kpXG4gIGNvbnN0IGlkMyA9IGFwcGVuZENhcHR1cmUodG1wLCBcInR5cG8gaW4gbGFiZWxcIik7XG4gIG1hcmtDYXB0dXJlUmVzb2x2ZWQodG1wLCBpZDMsIFwicXVpY2stdGFza1wiLCBcImZpeCB0eXBvXCIsIFwidHJpdmlhbFwiKTtcblxuICAvLyBXaGVuIGxvYWRpbmcgZm9yIE0wMDQsIG9ubHkgTTAwNCBhbmQgbm8tbWlsZXN0b25lIGNhcHR1cmVzIHNob3VsZCBiZSByZXR1cm5lZFxuICBjb25zdCBhY3Rpb25hYmxlID0gbG9hZEFjdGlvbmFibGVDYXB0dXJlcyh0bXAsIFwiTTAwNFwiKTtcbiAgY29uc3QgaWRzID0gYWN0aW9uYWJsZS5tYXAoYyA9PiBjLmlkKTtcblxuICBhc3NlcnQub2soIWlkcy5pbmNsdWRlcyhpZDEpLCBcInNob3VsZCBleGNsdWRlIGNhcHR1cmUgcmVzb2x2ZWQgaW4gTTAwM1wiKTtcbiAgYXNzZXJ0Lm9rKGlkcy5pbmNsdWRlcyhpZDIpLCBcInNob3VsZCBpbmNsdWRlIGNhcHR1cmUgcmVzb2x2ZWQgaW4gTTAwNFwiKTtcbiAgYXNzZXJ0Lm9rKGlkcy5pbmNsdWRlcyhpZDMpLCBcInNob3VsZCBpbmNsdWRlIGNhcHR1cmUgd2l0aCBubyBtaWxlc3RvbmUgKGxlZ2FjeSlcIik7XG59KTtcblxudGVzdChcImNhcHR1cmVzOiBsb2FkQWN0aW9uYWJsZUNhcHR1cmVzIHdpdGhvdXQgbWlsZXN0b25lIHJldHVybnMgYWxsIGFjdGlvbmFibGVcIiwgKHQpID0+IHtcbiAgY29uc3QgdG1wID0gbWFrZVRlbXBEaXIoXCJjYXAtbm8tbWlsZXN0b25lLWZpbHRlclwiKTtcbiAgdC5hZnRlcigoKSA9PiBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuXG4gIGNvbnN0IGlkMSA9IGFwcGVuZENhcHR1cmUodG1wLCBcImlzc3VlIG9uZVwiKTtcbiAgbWFya0NhcHR1cmVSZXNvbHZlZCh0bXAsIGlkMSwgXCJxdWljay10YXNrXCIsIFwiZml4IGl0XCIsIFwic21hbGxcIiwgXCJNMDAzXCIpO1xuXG4gIGNvbnN0IGlkMiA9IGFwcGVuZENhcHR1cmUodG1wLCBcImlzc3VlIHR3b1wiKTtcbiAgbWFya0NhcHR1cmVSZXNvbHZlZCh0bXAsIGlkMiwgXCJpbmplY3RcIiwgXCJpbmplY3QgaXRcIiwgXCJuZWVkZWRcIiwgXCJNMDA0XCIpO1xuXG4gIC8vIFdpdGhvdXQgbWlsZXN0b25lIGZpbHRlciwgYWxsIGFjdGlvbmFibGUgY2FwdHVyZXMgYXJlIHJldHVybmVkIChiYWNrd2FyZCBjb21wYXQpXG4gIGNvbnN0IGFjdGlvbmFibGUgPSBsb2FkQWN0aW9uYWJsZUNhcHR1cmVzKHRtcCk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChhY3Rpb25hYmxlLmxlbmd0aCwgMiwgXCJzaG91bGQgcmV0dXJuIGFsbCBhY3Rpb25hYmxlIHdpdGhvdXQgZmlsdGVyXCIpO1xufSk7XG5cbnRlc3QoXCJjYXB0dXJlczogbG9hZEFjdGlvbmFibGVDYXB0dXJlcyBleGNsdWRlcyBhbHJlYWR5LWV4ZWN1dGVkIGNhcHR1cmVzXCIsICh0KSA9PiB7XG4gIGNvbnN0IHRtcCA9IG1ha2VUZW1wRGlyKFwiY2FwLWV4ZWN1dGVkLWZpbHRlclwiKTtcbiAgdC5hZnRlcigoKSA9PiBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuXG4gIGNvbnN0IGlkMSA9IGFwcGVuZENhcHR1cmUodG1wLCBcImFscmVhZHkgZG9uZVwiKTtcbiAgbWFya0NhcHR1cmVSZXNvbHZlZCh0bXAsIGlkMSwgXCJxdWljay10YXNrXCIsIFwiZml4IGl0XCIsIFwic21hbGxcIiwgXCJNMDA0XCIpO1xuICBtYXJrQ2FwdHVyZUV4ZWN1dGVkKHRtcCwgaWQxKTtcblxuICBjb25zdCBpZDIgPSBhcHBlbmRDYXB0dXJlKHRtcCwgXCJzdGlsbCBwZW5kaW5nXCIpO1xuICBtYXJrQ2FwdHVyZVJlc29sdmVkKHRtcCwgaWQyLCBcInF1aWNrLXRhc2tcIiwgXCJmaXggaXQgdG9vXCIsIFwic21hbGxcIiwgXCJNMDA0XCIpO1xuXG4gIGNvbnN0IGFjdGlvbmFibGUgPSBsb2FkQWN0aW9uYWJsZUNhcHR1cmVzKHRtcCwgXCJNMDA0XCIpO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwoYWN0aW9uYWJsZS5sZW5ndGgsIDEsIFwic2hvdWxkIGV4Y2x1ZGUgZXhlY3V0ZWQgY2FwdHVyZVwiKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKGFjdGlvbmFibGVbMF0uaWQsIGlkMik7XG59KTtcblxudGVzdChcImNhcHR1cmVzOiBzdGFtcENhcHR1cmVNaWxlc3RvbmUgYWRkcyBtaWxlc3RvbmUgdG8gY2FwdHVyZSBtaXNzaW5nIGl0XCIsICh0KSA9PiB7XG4gIGNvbnN0IHRtcCA9IG1ha2VUZW1wRGlyKFwiY2FwLXN0YW1wLW1pbGVzdG9uZVwiKTtcbiAgdC5hZnRlcigoKSA9PiBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuXG4gIGNvbnN0IGlkID0gYXBwZW5kQ2FwdHVyZSh0bXAsIFwiZml4IGFsaWdubWVudFwiKTtcbiAgbWFya0NhcHR1cmVSZXNvbHZlZCh0bXAsIGlkLCBcInF1aWNrLXRhc2tcIiwgXCJmaXggaXRcIiwgXCJzbWFsbFwiKTtcblxuICAvLyBCZWZvcmUgc3RhbXBpbmcsIG5vIG1pbGVzdG9uZVxuICBsZXQgYWxsID0gbG9hZEFsbENhcHR1cmVzKHRtcCk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChhbGxbMF0ucmVzb2x2ZWRJbk1pbGVzdG9uZSwgdW5kZWZpbmVkLCBcInNob3VsZCBoYXZlIG5vIG1pbGVzdG9uZSBpbml0aWFsbHlcIik7XG5cbiAgc3RhbXBDYXB0dXJlTWlsZXN0b25lKHRtcCwgaWQsIFwiTTAwNFwiKTtcblxuICBhbGwgPSBsb2FkQWxsQ2FwdHVyZXModG1wKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKGFsbFswXS5yZXNvbHZlZEluTWlsZXN0b25lLCBcIk0wMDRcIiwgXCJzaG91bGQgaGF2ZSBtaWxlc3RvbmUgYWZ0ZXIgc3RhbXBpbmdcIik7XG59KTtcblxudGVzdChcImNhcHR1cmVzOiBzdGFtcENhcHR1cmVNaWxlc3RvbmUgaXMgbm8tb3AgaWYgbWlsZXN0b25lIGFscmVhZHkgcHJlc2VudFwiLCAodCkgPT4ge1xuICBjb25zdCB0bXAgPSBtYWtlVGVtcERpcihcImNhcC1zdGFtcC1ub29wXCIpO1xuICB0LmFmdGVyKCgpID0+IHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG5cbiAgY29uc3QgaWQgPSBhcHBlbmRDYXB0dXJlKHRtcCwgXCJmaXggYWxpZ25tZW50XCIpO1xuICBtYXJrQ2FwdHVyZVJlc29sdmVkKHRtcCwgaWQsIFwicXVpY2stdGFza1wiLCBcImZpeCBpdFwiLCBcInNtYWxsXCIsIFwiTTAwM1wiKTtcblxuICBzdGFtcENhcHR1cmVNaWxlc3RvbmUodG1wLCBpZCwgXCJNMDA0XCIpO1xuXG4gIGNvbnN0IGFsbCA9IGxvYWRBbGxDYXB0dXJlcyh0bXApO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwoYWxsWzBdLnJlc29sdmVkSW5NaWxlc3RvbmUsIFwiTTAwM1wiLCBcInNob3VsZCBrZWVwIG9yaWdpbmFsIG1pbGVzdG9uZVwiKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBWUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUNuQixTQUFTLFdBQVcsY0FBNkIsUUFBUSxrQkFBa0I7QUFDM0UsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUN2QjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBRVAsU0FBUyxZQUFZLFFBQXdCO0FBQzNDLFFBQU0sTUFBTTtBQUFBLElBQ1YsT0FBTztBQUFBLElBQ1AsR0FBRyxNQUFNLElBQUksS0FBSyxJQUFJLENBQUMsSUFBSSxLQUFLLE9BQU8sRUFBRSxTQUFTLEVBQUUsRUFBRSxNQUFNLENBQUMs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
