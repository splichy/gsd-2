import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadSliceTaskIO,
  deriveTaskGraph,
  isGraphAmbiguous,
  getReadyTasks,
  chooseNonConflictingSubset,
  loadReactiveState,
  saveReactiveState,
  clearReactiveState
} from "../reactive-graph.js";
import { validatePreferences } from "../preferences-validation.js";
import { parseUnitId } from "../unit-id.js";
test("reactive_execution validation accepts valid config", () => {
  const result = validatePreferences({
    reactive_execution: {
      enabled: true,
      max_parallel: 4,
      isolation_mode: "same-tree"
    }
  });
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.preferences.reactive_execution, {
    enabled: true,
    max_parallel: 4,
    isolation_mode: "same-tree"
  });
});
test("reactive_execution validation rejects max_parallel out of range", () => {
  const result = validatePreferences({
    reactive_execution: {
      enabled: true,
      max_parallel: 10,
      isolation_mode: "same-tree"
    }
  });
  assert.ok(result.errors.some((e) => e.includes("max_parallel")));
});
test("reactive_execution validation rejects invalid isolation_mode", () => {
  const result = validatePreferences({
    reactive_execution: {
      enabled: true,
      max_parallel: 2,
      isolation_mode: "separate-branch"
    }
  });
  assert.ok(result.errors.some((e) => e.includes("isolation_mode")));
});
test("reactive_execution validation warns on unknown keys", () => {
  const result = validatePreferences({
    reactive_execution: {
      enabled: true,
      max_parallel: 2,
      isolation_mode: "same-tree",
      unknown_thing: true
    }
  });
  assert.equal(result.errors.length, 0);
  assert.ok(result.warnings.some((w) => w.includes("unknown_thing")));
});
test("reactive dispatch requires enabled config and multiple ready tasks", async () => {
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-dispatch-"));
  try {
    const gsd = join(repo, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(join(gsd, "tasks"), { recursive: true });
    writeFileSync(
      join(gsd, "S01-PLAN.md"),
      [
        "# S01: Test Slice",
        "",
        "**Goal:** Test reactive execution",
        "**Demo:** All three tasks run in parallel",
        "",
        "## Tasks",
        "",
        "- [ ] **T01: First** `est:15m`",
        "  Create initial types",
        "- [ ] **T02: Second** `est:15m`",
        "  Create models",
        "- [ ] **T03: Third** `est:15m`",
        "  Create service layer",
        ""
      ].join("\n")
    );
    writeFileSync(
      join(gsd, "tasks", "T01-PLAN.md"),
      [
        "# T01: First",
        "",
        "## Description",
        "Create types.",
        "",
        "## Inputs",
        "",
        "- `src/config.json` \u2014 Config schema",
        "",
        "## Expected Output",
        "",
        "- `src/types.ts` \u2014 Type definitions"
      ].join("\n")
    );
    writeFileSync(
      join(gsd, "tasks", "T02-PLAN.md"),
      [
        "# T02: Second",
        "",
        "## Description",
        "Create models.",
        "",
        "## Inputs",
        "",
        "- `src/schema.json` \u2014 Schema file",
        "",
        "## Expected Output",
        "",
        "- `src/models.ts` \u2014 Model definitions"
      ].join("\n")
    );
    writeFileSync(
      join(gsd, "tasks", "T03-PLAN.md"),
      [
        "# T03: Third",
        "",
        "## Description",
        "Create service.",
        "",
        "## Inputs",
        "",
        "- `src/api.json` \u2014 API spec",
        "",
        "## Expected Output",
        "",
        "- `src/service.ts` \u2014 Service layer"
      ].join("\n")
    );
    const basePath = repo;
    const taskIO = await loadSliceTaskIO(basePath, "M001", "S01");
    assert.equal(taskIO.length, 3);
    const graph = deriveTaskGraph(taskIO);
    assert.equal(isGraphAmbiguous(graph), false, "Graph should not be ambiguous");
    const ready = getReadyTasks(graph, /* @__PURE__ */ new Set(), /* @__PURE__ */ new Set());
    assert.equal(ready.length, 3);
    const selected = chooseNonConflictingSubset(ready, graph, 2, /* @__PURE__ */ new Set());
    assert.equal(selected.length, 2);
    assert.deepEqual(selected, ["T01", "T02"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
test("reactive dispatch falls back when graph is ambiguous (task without IO)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-ambiguous-"));
  try {
    const gsd = join(repo, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(join(gsd, "tasks"), { recursive: true });
    writeFileSync(
      join(gsd, "S01-PLAN.md"),
      [
        "# S01: Test",
        "",
        "**Goal:** Test",
        "**Demo:** Test",
        "",
        "## Tasks",
        "",
        "- [ ] **T01: A** `est:15m`",
        "- [ ] **T02: B** `est:15m`",
        ""
      ].join("\n")
    );
    writeFileSync(
      join(gsd, "tasks", "T01-PLAN.md"),
      "# T01: A\n\n## Inputs\n\n- `src/a.ts`\n\n## Expected Output\n\n- `src/b.ts`\n"
    );
    writeFileSync(
      join(gsd, "tasks", "T02-PLAN.md"),
      "# T02: B\n\n## Description\n\nNo IO sections.\n"
    );
    const taskIO = await loadSliceTaskIO(repo, "M001", "S01");
    const graph = deriveTaskGraph(taskIO);
    assert.equal(isGraphAmbiguous(graph), true, "Graph should be ambiguous");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
test("single ready task falls through to sequential", async () => {
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-single-"));
  try {
    const gsd = join(repo, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(join(gsd, "tasks"), { recursive: true });
    writeFileSync(
      join(gsd, "S01-PLAN.md"),
      [
        "# S01: Linear",
        "",
        "**Goal:** Linear chain",
        "**Demo:** Sequential",
        "",
        "## Tasks",
        "",
        "- [ ] **T01: First** `est:15m`",
        "- [ ] **T02: Second** `est:15m`",
        ""
      ].join("\n")
    );
    writeFileSync(
      join(gsd, "tasks", "T01-PLAN.md"),
      "# T01: First\n\n## Inputs\n\n- `src/config.json`\n\n## Expected Output\n\n- `src/a.ts`\n"
    );
    writeFileSync(
      join(gsd, "tasks", "T02-PLAN.md"),
      "# T02: Second\n\n## Inputs\n\n- `src/a.ts`\n\n## Expected Output\n\n- `src/b.ts`\n"
    );
    const taskIO = await loadSliceTaskIO(repo, "M001", "S01");
    const graph = deriveTaskGraph(taskIO);
    const ready = getReadyTasks(graph, /* @__PURE__ */ new Set(), /* @__PURE__ */ new Set());
    assert.equal(ready.length, 1);
    assert.deepEqual(ready, ["T01"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
test("saveReactiveState and loadReactiveState round-trip", () => {
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-state-"));
  mkdirSync(join(repo, ".gsd", "runtime"), { recursive: true });
  try {
    const state = {
      sliceId: "S01",
      completed: ["T01", "T02"],
      dispatched: ["T03"],
      graphSnapshot: { taskCount: 4, edgeCount: 2, readySetSize: 1, ambiguous: false },
      updatedAt: "2025-01-01T00:00:00Z"
    };
    saveReactiveState(repo, "M001", "S01", state);
    const loaded = loadReactiveState(repo, "M001", "S01");
    assert.deepEqual(loaded, state);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
test("clearReactiveState removes the file", () => {
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-clear-"));
  mkdirSync(join(repo, ".gsd", "runtime"), { recursive: true });
  try {
    const state = {
      sliceId: "S01",
      completed: [],
      dispatched: ["T01", "T02"],
      graphSnapshot: { taskCount: 2, edgeCount: 0, readySetSize: 2, ambiguous: false },
      updatedAt: "2025-01-01T00:00:00Z"
    };
    saveReactiveState(repo, "M001", "S01", state);
    assert.ok(existsSync(join(repo, ".gsd", "runtime", "M001-S01-reactive.json")));
    clearReactiveState(repo, "M001", "S01");
    assert.ok(!existsSync(join(repo, ".gsd", "runtime", "M001-S01-reactive.json")));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
test("loadReactiveState returns null when no file exists", () => {
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-nofile-"));
  mkdirSync(join(repo, ".gsd", "runtime"), { recursive: true });
  try {
    const loaded = loadReactiveState(repo, "M001", "S01");
    assert.equal(loaded, null);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
test("completed tasks are not re-dispatched on next iteration", async () => {
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-reentry-"));
  try {
    const gsd = join(repo, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(join(gsd, "tasks"), { recursive: true });
    mkdirSync(join(repo, ".gsd", "runtime"), { recursive: true });
    writeFileSync(
      join(gsd, "S01-PLAN.md"),
      [
        "# S01: Reentry Test",
        "",
        "**Goal:** Test re-entry",
        "**Demo:** Correct resumption",
        "",
        "## Tasks",
        "",
        "- [x] **T01: Done** `est:15m`",
        "- [ ] **T02: Pending** `est:15m`",
        "- [ ] **T03: Also Pending** `est:15m`",
        ""
      ].join("\n")
    );
    writeFileSync(
      join(gsd, "tasks", "T01-PLAN.md"),
      "# T01: Done\n\n## Inputs\n\n- `src/config.json`\n\n## Expected Output\n\n- `src/a.ts`\n"
    );
    writeFileSync(
      join(gsd, "tasks", "T02-PLAN.md"),
      "# T02: Pending\n\n## Inputs\n\n- `src/a.ts`\n\n## Expected Output\n\n- `src/b.ts`\n"
    );
    writeFileSync(
      join(gsd, "tasks", "T03-PLAN.md"),
      "# T03: Also Pending\n\n## Inputs\n\n- `src/a.ts`\n\n## Expected Output\n\n- `src/c.ts`\n"
    );
    const taskIO = await loadSliceTaskIO(repo, "M001", "S01");
    const graph = deriveTaskGraph(taskIO);
    const completed = /* @__PURE__ */ new Set(["T01"]);
    const ready = getReadyTasks(graph, completed, /* @__PURE__ */ new Set());
    assert.deepEqual(ready, ["T02", "T03"]);
    completed.add("T02");
    const ready2 = getReadyTasks(graph, completed, /* @__PURE__ */ new Set());
    assert.deepEqual(ready2, ["T03"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
test("verifyExpectedArtifact: reactive-execute passes when all dispatched summaries exist", async () => {
  const { verifyExpectedArtifact } = await import("../auto-recovery.js");
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-verify-pass-"));
  try {
    const tasksDir = join(repo, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "T02-SUMMARY.md"), "---\nid: T02\n---\n# T02: Done\n");
    writeFileSync(join(tasksDir, "T03-SUMMARY.md"), "---\nid: T03\n---\n# T03: Done\n");
    const result = verifyExpectedArtifact("reactive-execute", "M001/S01/reactive+T02,T03", repo);
    assert.equal(result, true, "Should pass when all dispatched task summaries exist");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
test("verifyExpectedArtifact: reactive-execute fails when a dispatched summary is missing", async () => {
  const { verifyExpectedArtifact } = await import("../auto-recovery.js");
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-verify-fail-"));
  try {
    const tasksDir = join(repo, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "T02-SUMMARY.md"), "---\nid: T02\n---\n# T02: Done\n");
    const result = verifyExpectedArtifact("reactive-execute", "M001/S01/reactive+T02,T03", repo);
    assert.equal(result, false, "Should fail when dispatched task T03 summary is missing");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
test("verifyExpectedArtifact: reactive-execute fails even with pre-existing summaries from other tasks", async () => {
  const { verifyExpectedArtifact } = await import("../auto-recovery.js");
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-verify-preexisting-"));
  try {
    const tasksDir = join(repo, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "---\nid: T01\n---\n# T01: Prior\n");
    const result = verifyExpectedArtifact("reactive-execute", "M001/S01/reactive+T02,T03", repo);
    assert.equal(result, false, "Pre-existing T01 summary should not satisfy T02,T03 batch");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
test("verifyExpectedArtifact: reactive-execute legacy format (no batch IDs) falls back", async () => {
  const { verifyExpectedArtifact } = await import("../auto-recovery.js");
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-verify-legacy-"));
  try {
    const tasksDir = join(repo, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "---\nid: T01\n---\n# T01\n");
    const result = verifyExpectedArtifact("reactive-execute", "M001/S01/reactive", repo);
    assert.equal(result, true, "Legacy format should fall back to any-summary check");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
test("unitId batch encoding round-trips correctly", () => {
  const mid = "M001";
  const sid = "S01";
  const selected = ["T02", "T03", "T05"];
  const unitId = `${mid}/${sid}/reactive+${selected.join(",")}`;
  const { milestone, slice, task: batchPart } = parseUnitId(unitId);
  assert.equal(milestone, "M001");
  assert.equal(slice, "S01");
  const plusIdx = batchPart.indexOf("+");
  assert.ok(plusIdx > 0, "Should have + separator");
  const batchIds = batchPart.slice(plusIdx + 1).split(",");
  assert.deepEqual(batchIds, ["T02", "T03", "T05"]);
});
test("getDependencyTaskSummaryPaths returns only dependency summaries", async () => {
  const { getDependencyTaskSummaryPaths } = await import("../auto-prompts.js");
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-depcarry-"));
  try {
    const tasksDir = join(repo, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "---\nid: T01\n---\n# T01\n");
    writeFileSync(join(tasksDir, "T02-SUMMARY.md"), "---\nid: T02\n---\n# T02\n");
    writeFileSync(join(tasksDir, "T03-SUMMARY.md"), "---\nid: T03\n---\n# T03\n");
    const paths = await getDependencyTaskSummaryPaths("M001", "S01", "T04", ["T01", "T03"], repo);
    assert.equal(paths.length, 2, "Should get exactly 2 dependency summaries");
    assert.ok(paths.some((p) => p.includes("T01-SUMMARY")), "Should include T01");
    assert.ok(paths.some((p) => p.includes("T03-SUMMARY")), "Should include T03");
    assert.ok(!paths.some((p) => p.includes("T02-SUMMARY")), "Should NOT include T02");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
test("getDependencyTaskSummaryPaths falls back to order-based for root tasks", async () => {
  const { getDependencyTaskSummaryPaths } = await import("../auto-prompts.js");
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-depcarry-root-"));
  try {
    const tasksDir = join(repo, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "---\nid: T01\n---\n# T01\n");
    const paths = await getDependencyTaskSummaryPaths("M001", "S01", "T02", [], repo);
    assert.equal(paths.length, 1, "Root task should get order-based prior summaries");
    assert.ok(paths[0].includes("T01-SUMMARY"), "Should include T01 via order fallback");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
test("getDependencyTaskSummaryPaths handles missing dependency summaries gracefully", async () => {
  const { getDependencyTaskSummaryPaths } = await import("../auto-prompts.js");
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-depcarry-missing-"));
  try {
    const tasksDir = join(repo, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "---\nid: T01\n---\n# T01\n");
    const paths = await getDependencyTaskSummaryPaths("M001", "S01", "T03", ["T01", "T02"], repo);
    assert.equal(paths.length, 1, "Should only return existing dependency summaries");
    assert.ok(paths[0].includes("T01-SUMMARY"), "Should include T01 (exists)");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9yZWFjdGl2ZS1leGVjdXRvci50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBta2RpclN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYywgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHtcbiAgbG9hZFNsaWNlVGFza0lPLFxuICBkZXJpdmVUYXNrR3JhcGgsXG4gIGlzR3JhcGhBbWJpZ3VvdXMsXG4gIGdldFJlYWR5VGFza3MsXG4gIGNob29zZU5vbkNvbmZsaWN0aW5nU3Vic2V0LFxuICBsb2FkUmVhY3RpdmVTdGF0ZSxcbiAgc2F2ZVJlYWN0aXZlU3RhdGUsXG4gIGNsZWFyUmVhY3RpdmVTdGF0ZSxcbn0gZnJvbSBcIi4uL3JlYWN0aXZlLWdyYXBoLnRzXCI7XG5pbXBvcnQgeyB2YWxpZGF0ZVByZWZlcmVuY2VzIH0gZnJvbSBcIi4uL3ByZWZlcmVuY2VzLXZhbGlkYXRpb24udHNcIjtcbmltcG9ydCB0eXBlIHsgUmVhY3RpdmVFeGVjdXRpb25TdGF0ZSB9IGZyb20gXCIuLi90eXBlcy50c1wiO1xuaW1wb3J0IHsgcGFyc2VVbml0SWQgfSBmcm9tIFwiLi4vdW5pdC1pZC50c1wiO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUHJlZmVyZW5jZSBWYWxpZGF0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwicmVhY3RpdmVfZXhlY3V0aW9uIHZhbGlkYXRpb24gYWNjZXB0cyB2YWxpZCBjb25maWdcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSB2YWxpZGF0ZVByZWZlcmVuY2VzKHtcbiAgICByZWFjdGl2ZV9leGVjdXRpb246IHtcbiAgICAgIGVuYWJsZWQ6IHRydWUsXG4gICAgICBtYXhfcGFyYWxsZWw6IDQsXG4gICAgICBpc29sYXRpb25fbW9kZTogXCJzYW1lLXRyZWVcIixcbiAgICB9LFxuICB9KTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5lcnJvcnMubGVuZ3RoLCAwKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQucHJlZmVyZW5jZXMucmVhY3RpdmVfZXhlY3V0aW9uLCB7XG4gICAgZW5hYmxlZDogdHJ1ZSxcbiAgICBtYXhfcGFyYWxsZWw6IDQsXG4gICAgaXNvbGF0aW9uX21vZGU6IFwic2FtZS10cmVlXCIsXG4gIH0pO1xufSk7XG5cbnRlc3QoXCJyZWFjdGl2ZV9leGVjdXRpb24gdmFsaWRhdGlvbiByZWplY3RzIG1heF9wYXJhbGxlbCBvdXQgb2YgcmFuZ2VcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSB2YWxpZGF0ZVByZWZlcmVuY2VzKHtcbiAgICByZWFjdGl2ZV9leGVjdXRpb246IHtcbiAgICAgIGVuYWJsZWQ6IHRydWUsXG4gICAgICBtYXhfcGFyYWxsZWw6IDEwLFxuICAgICAgaXNvbGF0aW9uX21vZGU6IFwic2FtZS10cmVlXCIsXG4gICAgfSBhcyBhbnksXG4gIH0pO1xuICBhc3NlcnQub2socmVzdWx0LmVycm9ycy5zb21lKChlKSA9PiBlLmluY2x1ZGVzKFwibWF4X3BhcmFsbGVsXCIpKSk7XG59KTtcblxudGVzdChcInJlYWN0aXZlX2V4ZWN1dGlvbiB2YWxpZGF0aW9uIHJlamVjdHMgaW52YWxpZCBpc29sYXRpb25fbW9kZVwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHZhbGlkYXRlUHJlZmVyZW5jZXMoe1xuICAgIHJlYWN0aXZlX2V4ZWN1dGlvbjoge1xuICAgICAgZW5hYmxlZDogdHJ1ZSxcbiAgICAgIG1heF9wYXJhbGxlbDogMixcbiAgICAgIGlzb2xhdGlvbl9tb2RlOiBcInNlcGFyYXRlLWJyYW5jaFwiLFxuICAgIH0gYXMgYW55LFxuICB9KTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdC5lcnJvcnMuc29tZSgoZSkgPT4gZS5pbmNsdWRlcyhcImlzb2xhdGlvbl9tb2RlXCIpKSk7XG59KTtcblxudGVzdChcInJlYWN0aXZlX2V4ZWN1dGlvbiB2YWxpZGF0aW9uIHdhcm5zIG9uIHVua25vd24ga2V5c1wiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHZhbGlkYXRlUHJlZmVyZW5jZXMoe1xuICAgIHJlYWN0aXZlX2V4ZWN1dGlvbjoge1xuICAgICAgZW5hYmxlZDogdHJ1ZSxcbiAgICAgIG1heF9wYXJhbGxlbDogMixcbiAgICAgIGlzb2xhdGlvbl9tb2RlOiBcInNhbWUtdHJlZVwiLFxuICAgICAgdW5rbm93bl90aGluZzogdHJ1ZSxcbiAgICB9IGFzIGFueSxcbiAgfSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQuZXJyb3JzLmxlbmd0aCwgMCk7XG4gIGFzc2VydC5vayhyZXN1bHQud2FybmluZ3Muc29tZSgodykgPT4gdy5pbmNsdWRlcyhcInVua25vd25fdGhpbmdcIikpKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRGlzcGF0Y2ggUnVsZSBNYXRjaGluZyBMb2dpYyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcInJlYWN0aXZlIGRpc3BhdGNoIHJlcXVpcmVzIGVuYWJsZWQgY29uZmlnIGFuZCBtdWx0aXBsZSByZWFkeSB0YXNrc1wiLCBhc3luYyAoKSA9PiB7XG4gIC8vIEJ1aWxkIGEgbWluaW1hbCBmaWxlc3lzdGVtIHdpdGggYSBzbGljZSBwbGFuIGFuZCB0YXNrIHBsYW5zXG4gIGNvbnN0IHJlcG8gPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1yZWFjdGl2ZS1kaXNwYXRjaC1cIikpO1xuICB0cnkge1xuICAgIGNvbnN0IGdzZCA9IGpvaW4ocmVwbywgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIik7XG4gICAgbWtkaXJTeW5jKGpvaW4oZ3NkLCBcInRhc2tzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAgIC8vIFNsaWNlIHBsYW4gd2l0aCAzIHRhc2tzXG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4oZ3NkLCBcIlMwMS1QTEFOLm1kXCIpLFxuICAgICAgW1xuICAgICAgICBcIiMgUzAxOiBUZXN0IFNsaWNlXCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiKipHb2FsOioqIFRlc3QgcmVhY3RpdmUgZXhlY3V0aW9uXCIsXG4gICAgICAgIFwiKipEZW1vOioqIEFsbCB0aHJlZSB0YXNrcyBydW4gaW4gcGFyYWxsZWxcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCIjIyBUYXNrc1wiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIi0gWyBdICoqVDAxOiBGaXJzdCoqIGBlc3Q6MTVtYFwiLFxuICAgICAgICBcIiAgQ3JlYXRlIGluaXRpYWwgdHlwZXNcIixcbiAgICAgICAgXCItIFsgXSAqKlQwMjogU2Vjb25kKiogYGVzdDoxNW1gXCIsXG4gICAgICAgIFwiICBDcmVhdGUgbW9kZWxzXCIsXG4gICAgICAgIFwiLSBbIF0gKipUMDM6IFRoaXJkKiogYGVzdDoxNW1gXCIsXG4gICAgICAgIFwiICBDcmVhdGUgc2VydmljZSBsYXllclwiLFxuICAgICAgICBcIlwiLFxuICAgICAgXS5qb2luKFwiXFxuXCIpLFxuICAgICk7XG5cbiAgICAvLyBUYXNrIHBsYW5zIHdpdGggbm9uLW92ZXJsYXBwaW5nIElPIChhbGwgaW5kZXBlbmRlbnQpXG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4oZ3NkLCBcInRhc2tzXCIsIFwiVDAxLVBMQU4ubWRcIiksXG4gICAgICBbXG4gICAgICAgIFwiIyBUMDE6IEZpcnN0XCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiIyMgRGVzY3JpcHRpb25cIixcbiAgICAgICAgXCJDcmVhdGUgdHlwZXMuXCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiIyMgSW5wdXRzXCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiLSBgc3JjL2NvbmZpZy5qc29uYCBcdTIwMTQgQ29uZmlnIHNjaGVtYVwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIiMjIEV4cGVjdGVkIE91dHB1dFwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIi0gYHNyYy90eXBlcy50c2AgXHUyMDE0IFR5cGUgZGVmaW5pdGlvbnNcIixcbiAgICAgIF0uam9pbihcIlxcblwiKSxcbiAgICApO1xuXG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4oZ3NkLCBcInRhc2tzXCIsIFwiVDAyLVBMQU4ubWRcIiksXG4gICAgICBbXG4gICAgICAgIFwiIyBUMDI6IFNlY29uZFwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIiMjIERlc2NyaXB0aW9uXCIsXG4gICAgICAgIFwiQ3JlYXRlIG1vZGVscy5cIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCIjIyBJbnB1dHNcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCItIGBzcmMvc2NoZW1hLmpzb25gIFx1MjAxNCBTY2hlbWEgZmlsZVwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIiMjIEV4cGVjdGVkIE91dHB1dFwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIi0gYHNyYy9tb2RlbHMudHNgIFx1MjAxNCBNb2RlbCBkZWZpbml0aW9uc1wiLFxuICAgICAgXS5qb2luKFwiXFxuXCIpLFxuICAgICk7XG5cbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihnc2QsIFwidGFza3NcIiwgXCJUMDMtUExBTi5tZFwiKSxcbiAgICAgIFtcbiAgICAgICAgXCIjIFQwMzogVGhpcmRcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCIjIyBEZXNjcmlwdGlvblwiLFxuICAgICAgICBcIkNyZWF0ZSBzZXJ2aWNlLlwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIiMjIElucHV0c1wiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIi0gYHNyYy9hcGkuanNvbmAgXHUyMDE0IEFQSSBzcGVjXCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiIyMgRXhwZWN0ZWQgT3V0cHV0XCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiLSBgc3JjL3NlcnZpY2UudHNgIFx1MjAxNCBTZXJ2aWNlIGxheWVyXCIsXG4gICAgICBdLmpvaW4oXCJcXG5cIiksXG4gICAgKTtcblxuICAgIC8vIExvYWQgSU8gYW5kIGJ1aWxkIGdyYXBoXG4gICAgY29uc3QgYmFzZVBhdGggPSByZXBvO1xuICAgIGNvbnN0IHRhc2tJTyA9IGF3YWl0IGxvYWRTbGljZVRhc2tJTyhiYXNlUGF0aCwgXCJNMDAxXCIsIFwiUzAxXCIpO1xuICAgIGFzc2VydC5lcXVhbCh0YXNrSU8ubGVuZ3RoLCAzKTtcblxuICAgIGNvbnN0IGdyYXBoID0gZGVyaXZlVGFza0dyYXBoKHRhc2tJTyk7XG4gICAgYXNzZXJ0LmVxdWFsKGlzR3JhcGhBbWJpZ3VvdXMoZ3JhcGgpLCBmYWxzZSwgXCJHcmFwaCBzaG91bGQgbm90IGJlIGFtYmlndW91c1wiKTtcblxuICAgIC8vIEFsbCBpbmRlcGVuZGVudCBcdTIxOTIgYWxsIHNob3VsZCBiZSByZWFkeVxuICAgIGNvbnN0IHJlYWR5ID0gZ2V0UmVhZHlUYXNrcyhncmFwaCwgbmV3IFNldCgpLCBuZXcgU2V0KCkpO1xuICAgIGFzc2VydC5lcXVhbChyZWFkeS5sZW5ndGgsIDMpO1xuXG4gICAgLy8gQ2hvb3NlIHN1YnNldCB3aXRoIG1heF9wYXJhbGxlbD0yXG4gICAgY29uc3Qgc2VsZWN0ZWQgPSBjaG9vc2VOb25Db25mbGljdGluZ1N1YnNldChyZWFkeSwgZ3JhcGgsIDIsIG5ldyBTZXQoKSk7XG4gICAgYXNzZXJ0LmVxdWFsKHNlbGVjdGVkLmxlbmd0aCwgMik7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChzZWxlY3RlZCwgW1wiVDAxXCIsIFwiVDAyXCJdKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmMocmVwbywgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcInJlYWN0aXZlIGRpc3BhdGNoIGZhbGxzIGJhY2sgd2hlbiBncmFwaCBpcyBhbWJpZ3VvdXMgKHRhc2sgd2l0aG91dCBJTylcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCByZXBvID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtcmVhY3RpdmUtYW1iaWd1b3VzLVwiKSk7XG4gIHRyeSB7XG4gICAgY29uc3QgZ3NkID0gam9pbihyZXBvLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiKTtcbiAgICBta2RpclN5bmMoam9pbihnc2QsIFwidGFza3NcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4oZ3NkLCBcIlMwMS1QTEFOLm1kXCIpLFxuICAgICAgW1xuICAgICAgICBcIiMgUzAxOiBUZXN0XCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiKipHb2FsOioqIFRlc3RcIixcbiAgICAgICAgXCIqKkRlbW86KiogVGVzdFwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIiMjIFRhc2tzXCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiLSBbIF0gKipUMDE6IEEqKiBgZXN0OjE1bWBcIixcbiAgICAgICAgXCItIFsgXSAqKlQwMjogQioqIGBlc3Q6MTVtYFwiLFxuICAgICAgICBcIlwiLFxuICAgICAgXS5qb2luKFwiXFxuXCIpLFxuICAgICk7XG5cbiAgICAvLyBUMDEgaGFzIElPLCBUMDIgaGFzIE5PIElPIHNlY3Rpb25zIFx1MjE5MiBhbWJpZ3VvdXNcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihnc2QsIFwidGFza3NcIiwgXCJUMDEtUExBTi5tZFwiKSxcbiAgICAgIFwiIyBUMDE6IEFcXG5cXG4jIyBJbnB1dHNcXG5cXG4tIGBzcmMvYS50c2BcXG5cXG4jIyBFeHBlY3RlZCBPdXRwdXRcXG5cXG4tIGBzcmMvYi50c2BcXG5cIixcbiAgICApO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKGdzZCwgXCJ0YXNrc1wiLCBcIlQwMi1QTEFOLm1kXCIpLFxuICAgICAgXCIjIFQwMjogQlxcblxcbiMjIERlc2NyaXB0aW9uXFxuXFxuTm8gSU8gc2VjdGlvbnMuXFxuXCIsXG4gICAgKTtcblxuICAgIGNvbnN0IHRhc2tJTyA9IGF3YWl0IGxvYWRTbGljZVRhc2tJTyhyZXBvLCBcIk0wMDFcIiwgXCJTMDFcIik7XG4gICAgY29uc3QgZ3JhcGggPSBkZXJpdmVUYXNrR3JhcGgodGFza0lPKTtcbiAgICBhc3NlcnQuZXF1YWwoaXNHcmFwaEFtYmlndW91cyhncmFwaCksIHRydWUsIFwiR3JhcGggc2hvdWxkIGJlIGFtYmlndW91c1wiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmMocmVwbywgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcInNpbmdsZSByZWFkeSB0YXNrIGZhbGxzIHRocm91Z2ggdG8gc2VxdWVudGlhbFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHJlcG8gPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1yZWFjdGl2ZS1zaW5nbGUtXCIpKTtcbiAgdHJ5IHtcbiAgICBjb25zdCBnc2QgPSBqb2luKHJlcG8sIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIpO1xuICAgIG1rZGlyU3luYyhqb2luKGdzZCwgXCJ0YXNrc1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihnc2QsIFwiUzAxLVBMQU4ubWRcIiksXG4gICAgICBbXG4gICAgICAgIFwiIyBTMDE6IExpbmVhclwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIioqR29hbDoqKiBMaW5lYXIgY2hhaW5cIixcbiAgICAgICAgXCIqKkRlbW86KiogU2VxdWVudGlhbFwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIiMjIFRhc2tzXCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiLSBbIF0gKipUMDE6IEZpcnN0KiogYGVzdDoxNW1gXCIsXG4gICAgICAgIFwiLSBbIF0gKipUMDI6IFNlY29uZCoqIGBlc3Q6MTVtYFwiLFxuICAgICAgICBcIlwiLFxuICAgICAgXS5qb2luKFwiXFxuXCIpLFxuICAgICk7XG5cbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihnc2QsIFwidGFza3NcIiwgXCJUMDEtUExBTi5tZFwiKSxcbiAgICAgIFwiIyBUMDE6IEZpcnN0XFxuXFxuIyMgSW5wdXRzXFxuXFxuLSBgc3JjL2NvbmZpZy5qc29uYFxcblxcbiMjIEV4cGVjdGVkIE91dHB1dFxcblxcbi0gYHNyYy9hLnRzYFxcblwiLFxuICAgICk7XG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4oZ3NkLCBcInRhc2tzXCIsIFwiVDAyLVBMQU4ubWRcIiksXG4gICAgICBcIiMgVDAyOiBTZWNvbmRcXG5cXG4jIyBJbnB1dHNcXG5cXG4tIGBzcmMvYS50c2BcXG5cXG4jIyBFeHBlY3RlZCBPdXRwdXRcXG5cXG4tIGBzcmMvYi50c2BcXG5cIixcbiAgICApO1xuXG4gICAgY29uc3QgdGFza0lPID0gYXdhaXQgbG9hZFNsaWNlVGFza0lPKHJlcG8sIFwiTTAwMVwiLCBcIlMwMVwiKTtcbiAgICBjb25zdCBncmFwaCA9IGRlcml2ZVRhc2tHcmFwaCh0YXNrSU8pO1xuICAgIGNvbnN0IHJlYWR5ID0gZ2V0UmVhZHlUYXNrcyhncmFwaCwgbmV3IFNldCgpLCBuZXcgU2V0KCkpO1xuICAgIC8vIE9ubHkgVDAxIGlzIHJlYWR5IChUMDIgZGVwZW5kcyBvbiBUMDEpXG4gICAgYXNzZXJ0LmVxdWFsKHJlYWR5Lmxlbmd0aCwgMSk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChyZWFkeSwgW1wiVDAxXCJdKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmMocmVwbywgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFN0YXRlIFBlcnNpc3RlbmNlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwic2F2ZVJlYWN0aXZlU3RhdGUgYW5kIGxvYWRSZWFjdGl2ZVN0YXRlIHJvdW5kLXRyaXBcIiwgKCkgPT4ge1xuICBjb25zdCByZXBvID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtcmVhY3RpdmUtc3RhdGUtXCIpKTtcbiAgbWtkaXJTeW5jKGpvaW4ocmVwbywgXCIuZ3NkXCIsIFwicnVudGltZVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHRyeSB7XG4gICAgY29uc3Qgc3RhdGU6IFJlYWN0aXZlRXhlY3V0aW9uU3RhdGUgPSB7XG4gICAgICBzbGljZUlkOiBcIlMwMVwiLFxuICAgICAgY29tcGxldGVkOiBbXCJUMDFcIiwgXCJUMDJcIl0sXG4gICAgICBkaXNwYXRjaGVkOiBbXCJUMDNcIl0sXG4gICAgICBncmFwaFNuYXBzaG90OiB7IHRhc2tDb3VudDogNCwgZWRnZUNvdW50OiAyLCByZWFkeVNldFNpemU6IDEsIGFtYmlndW91czogZmFsc2UgfSxcbiAgICAgIHVwZGF0ZWRBdDogXCIyMDI1LTAxLTAxVDAwOjAwOjAwWlwiLFxuICAgIH07XG5cbiAgICBzYXZlUmVhY3RpdmVTdGF0ZShyZXBvLCBcIk0wMDFcIiwgXCJTMDFcIiwgc3RhdGUpO1xuICAgIGNvbnN0IGxvYWRlZCA9IGxvYWRSZWFjdGl2ZVN0YXRlKHJlcG8sIFwiTTAwMVwiLCBcIlMwMVwiKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKGxvYWRlZCwgc3RhdGUpO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhyZXBvLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiY2xlYXJSZWFjdGl2ZVN0YXRlIHJlbW92ZXMgdGhlIGZpbGVcIiwgKCkgPT4ge1xuICBjb25zdCByZXBvID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtcmVhY3RpdmUtY2xlYXItXCIpKTtcbiAgbWtkaXJTeW5jKGpvaW4ocmVwbywgXCIuZ3NkXCIsIFwicnVudGltZVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHRyeSB7XG4gICAgY29uc3Qgc3RhdGU6IFJlYWN0aXZlRXhlY3V0aW9uU3RhdGUgPSB7XG4gICAgICBzbGljZUlkOiBcIlMwMVwiLFxuICAgICAgY29tcGxldGVkOiBbXSxcbiAgICAgIGRpc3BhdGNoZWQ6IFtcIlQwMVwiLCBcIlQwMlwiXSxcbiAgICAgIGdyYXBoU25hcHNob3Q6IHsgdGFza0NvdW50OiAyLCBlZGdlQ291bnQ6IDAsIHJlYWR5U2V0U2l6ZTogMiwgYW1iaWd1b3VzOiBmYWxzZSB9LFxuICAgICAgdXBkYXRlZEF0OiBcIjIwMjUtMDEtMDFUMDA6MDA6MDBaXCIsXG4gICAgfTtcblxuICAgIHNhdmVSZWFjdGl2ZVN0YXRlKHJlcG8sIFwiTTAwMVwiLCBcIlMwMVwiLCBzdGF0ZSk7XG4gICAgYXNzZXJ0Lm9rKGV4aXN0c1N5bmMoam9pbihyZXBvLCBcIi5nc2RcIiwgXCJydW50aW1lXCIsIFwiTTAwMS1TMDEtcmVhY3RpdmUuanNvblwiKSkpO1xuXG4gICAgY2xlYXJSZWFjdGl2ZVN0YXRlKHJlcG8sIFwiTTAwMVwiLCBcIlMwMVwiKTtcbiAgICBhc3NlcnQub2soIWV4aXN0c1N5bmMoam9pbihyZXBvLCBcIi5nc2RcIiwgXCJydW50aW1lXCIsIFwiTTAwMS1TMDEtcmVhY3RpdmUuanNvblwiKSkpO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhyZXBvLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwibG9hZFJlYWN0aXZlU3RhdGUgcmV0dXJucyBudWxsIHdoZW4gbm8gZmlsZSBleGlzdHNcIiwgKCkgPT4ge1xuICBjb25zdCByZXBvID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtcmVhY3RpdmUtbm9maWxlLVwiKSk7XG4gIG1rZGlyU3luYyhqb2luKHJlcG8sIFwiLmdzZFwiLCBcInJ1bnRpbWVcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB0cnkge1xuICAgIGNvbnN0IGxvYWRlZCA9IGxvYWRSZWFjdGl2ZVN0YXRlKHJlcG8sIFwiTTAwMVwiLCBcIlMwMVwiKTtcbiAgICBhc3NlcnQuZXF1YWwobG9hZGVkLCBudWxsKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmMocmVwbywgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcImNvbXBsZXRlZCB0YXNrcyBhcmUgbm90IHJlLWRpc3BhdGNoZWQgb24gbmV4dCBpdGVyYXRpb25cIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCByZXBvID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtcmVhY3RpdmUtcmVlbnRyeS1cIikpO1xuICB0cnkge1xuICAgIGNvbnN0IGdzZCA9IGpvaW4ocmVwbywgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIik7XG4gICAgbWtkaXJTeW5jKGpvaW4oZ3NkLCBcInRhc2tzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBta2RpclN5bmMoam9pbihyZXBvLCBcIi5nc2RcIiwgXCJydW50aW1lXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKGdzZCwgXCJTMDEtUExBTi5tZFwiKSxcbiAgICAgIFtcbiAgICAgICAgXCIjIFMwMTogUmVlbnRyeSBUZXN0XCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiKipHb2FsOioqIFRlc3QgcmUtZW50cnlcIixcbiAgICAgICAgXCIqKkRlbW86KiogQ29ycmVjdCByZXN1bXB0aW9uXCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiIyMgVGFza3NcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCItIFt4XSAqKlQwMTogRG9uZSoqIGBlc3Q6MTVtYFwiLFxuICAgICAgICBcIi0gWyBdICoqVDAyOiBQZW5kaW5nKiogYGVzdDoxNW1gXCIsXG4gICAgICAgIFwiLSBbIF0gKipUMDM6IEFsc28gUGVuZGluZyoqIGBlc3Q6MTVtYFwiLFxuICAgICAgICBcIlwiLFxuICAgICAgXS5qb2luKFwiXFxuXCIpLFxuICAgICk7XG5cbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihnc2QsIFwidGFza3NcIiwgXCJUMDEtUExBTi5tZFwiKSxcbiAgICAgIFwiIyBUMDE6IERvbmVcXG5cXG4jIyBJbnB1dHNcXG5cXG4tIGBzcmMvY29uZmlnLmpzb25gXFxuXFxuIyMgRXhwZWN0ZWQgT3V0cHV0XFxuXFxuLSBgc3JjL2EudHNgXFxuXCIsXG4gICAgKTtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihnc2QsIFwidGFza3NcIiwgXCJUMDItUExBTi5tZFwiKSxcbiAgICAgIFwiIyBUMDI6IFBlbmRpbmdcXG5cXG4jIyBJbnB1dHNcXG5cXG4tIGBzcmMvYS50c2BcXG5cXG4jIyBFeHBlY3RlZCBPdXRwdXRcXG5cXG4tIGBzcmMvYi50c2BcXG5cIixcbiAgICApO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKGdzZCwgXCJ0YXNrc1wiLCBcIlQwMy1QTEFOLm1kXCIpLFxuICAgICAgXCIjIFQwMzogQWxzbyBQZW5kaW5nXFxuXFxuIyMgSW5wdXRzXFxuXFxuLSBgc3JjL2EudHNgXFxuXFxuIyMgRXhwZWN0ZWQgT3V0cHV0XFxuXFxuLSBgc3JjL2MudHNgXFxuXCIsXG4gICAgKTtcblxuICAgIGNvbnN0IHRhc2tJTyA9IGF3YWl0IGxvYWRTbGljZVRhc2tJTyhyZXBvLCBcIk0wMDFcIiwgXCJTMDFcIik7XG4gICAgY29uc3QgZ3JhcGggPSBkZXJpdmVUYXNrR3JhcGgodGFza0lPKTtcblxuICAgIC8vIFQwMSBpcyBkb25lLCBUMDIgYW5kIFQwMyBkZXBlbmQgb24gVDAxXG4gICAgY29uc3QgY29tcGxldGVkID0gbmV3IFNldChbXCJUMDFcIl0pO1xuICAgIGNvbnN0IHJlYWR5ID0gZ2V0UmVhZHlUYXNrcyhncmFwaCwgY29tcGxldGVkLCBuZXcgU2V0KCkpO1xuICAgIC8vIEJvdGggVDAyIGFuZCBUMDMgc2hvdWxkIGJlIHJlYWR5IChUMDEgaXMgY29tcGxldGUpXG4gICAgYXNzZXJ0LmRlZXBFcXVhbChyZWFkeSwgW1wiVDAyXCIsIFwiVDAzXCJdKTtcblxuICAgIC8vIFNpbXVsYXRlIFQwMiBjb21wbGV0ZXMsIHJlLWRlcml2ZVxuICAgIGNvbXBsZXRlZC5hZGQoXCJUMDJcIik7XG4gICAgY29uc3QgcmVhZHkyID0gZ2V0UmVhZHlUYXNrcyhncmFwaCwgY29tcGxldGVkLCBuZXcgU2V0KCkpO1xuICAgIC8vIE9ubHkgVDAzIHNob3VsZCBiZSByZWFkeVxuICAgIGFzc2VydC5kZWVwRXF1YWwocmVhZHkyLCBbXCJUMDNcIl0pO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhyZXBvLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQmF0Y2ggVmVyaWZpY2F0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwidmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdDogcmVhY3RpdmUtZXhlY3V0ZSBwYXNzZXMgd2hlbiBhbGwgZGlzcGF0Y2hlZCBzdW1tYXJpZXMgZXhpc3RcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QgfSA9IGF3YWl0IGltcG9ydChcIi4uL2F1dG8tcmVjb3ZlcnkudHNcIik7XG4gIGNvbnN0IHJlcG8gPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1yZWFjdGl2ZS12ZXJpZnktcGFzcy1cIikpO1xuICB0cnkge1xuICAgIGNvbnN0IHRhc2tzRGlyID0gam9pbihyZXBvLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiLCBcInRhc2tzXCIpO1xuICAgIG1rZGlyU3luYyh0YXNrc0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHRhc2tzRGlyLCBcIlQwMi1TVU1NQVJZLm1kXCIpLCBcIi0tLVxcbmlkOiBUMDJcXG4tLS1cXG4jIFQwMjogRG9uZVxcblwiKTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4odGFza3NEaXIsIFwiVDAzLVNVTU1BUlkubWRcIiksIFwiLS0tXFxuaWQ6IFQwM1xcbi0tLVxcbiMgVDAzOiBEb25lXFxuXCIpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gdmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdChcInJlYWN0aXZlLWV4ZWN1dGVcIiwgXCJNMDAxL1MwMS9yZWFjdGl2ZStUMDIsVDAzXCIsIHJlcG8pO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIHRydWUsIFwiU2hvdWxkIHBhc3Mgd2hlbiBhbGwgZGlzcGF0Y2hlZCB0YXNrIHN1bW1hcmllcyBleGlzdFwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmMocmVwbywgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcInZlcmlmeUV4cGVjdGVkQXJ0aWZhY3Q6IHJlYWN0aXZlLWV4ZWN1dGUgZmFpbHMgd2hlbiBhIGRpc3BhdGNoZWQgc3VtbWFyeSBpcyBtaXNzaW5nXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0IH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9hdXRvLXJlY292ZXJ5LnRzXCIpO1xuICBjb25zdCByZXBvID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtcmVhY3RpdmUtdmVyaWZ5LWZhaWwtXCIpKTtcbiAgdHJ5IHtcbiAgICBjb25zdCB0YXNrc0RpciA9IGpvaW4ocmVwbywgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIiwgXCJ0YXNrc1wiKTtcbiAgICBta2RpclN5bmModGFza3NEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIC8vIE9ubHkgVDAyIGhhcyBhIHN1bW1hcnksIFQwMyBkb2VzIG5vdFxuICAgIHdyaXRlRmlsZVN5bmMoam9pbih0YXNrc0RpciwgXCJUMDItU1VNTUFSWS5tZFwiKSwgXCItLS1cXG5pZDogVDAyXFxuLS0tXFxuIyBUMDI6IERvbmVcXG5cIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0KFwicmVhY3RpdmUtZXhlY3V0ZVwiLCBcIk0wMDEvUzAxL3JlYWN0aXZlK1QwMixUMDNcIiwgcmVwbyk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgZmFsc2UsIFwiU2hvdWxkIGZhaWwgd2hlbiBkaXNwYXRjaGVkIHRhc2sgVDAzIHN1bW1hcnkgaXMgbWlzc2luZ1wiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmMocmVwbywgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcInZlcmlmeUV4cGVjdGVkQXJ0aWZhY3Q6IHJlYWN0aXZlLWV4ZWN1dGUgZmFpbHMgZXZlbiB3aXRoIHByZS1leGlzdGluZyBzdW1tYXJpZXMgZnJvbSBvdGhlciB0YXNrc1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgdmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdCB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vYXV0by1yZWNvdmVyeS50c1wiKTtcbiAgY29uc3QgcmVwbyA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXJlYWN0aXZlLXZlcmlmeS1wcmVleGlzdGluZy1cIikpO1xuICB0cnkge1xuICAgIGNvbnN0IHRhc2tzRGlyID0gam9pbihyZXBvLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiLCBcInRhc2tzXCIpO1xuICAgIG1rZGlyU3luYyh0YXNrc0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgLy8gVDAxIHN1bW1hcnkgZXhpc3RzIGZyb20gYmVmb3JlLCBidXQgVDAyIGFuZCBUMDMgd2VyZSBkaXNwYXRjaGVkXG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHRhc2tzRGlyLCBcIlQwMS1TVU1NQVJZLm1kXCIpLCBcIi0tLVxcbmlkOiBUMDFcXG4tLS1cXG4jIFQwMTogUHJpb3JcXG5cIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0KFwicmVhY3RpdmUtZXhlY3V0ZVwiLCBcIk0wMDEvUzAxL3JlYWN0aXZlK1QwMixUMDNcIiwgcmVwbyk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgZmFsc2UsIFwiUHJlLWV4aXN0aW5nIFQwMSBzdW1tYXJ5IHNob3VsZCBub3Qgc2F0aXNmeSBUMDIsVDAzIGJhdGNoXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhyZXBvLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwidmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdDogcmVhY3RpdmUtZXhlY3V0ZSBsZWdhY3kgZm9ybWF0IChubyBiYXRjaCBJRHMpIGZhbGxzIGJhY2tcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QgfSA9IGF3YWl0IGltcG9ydChcIi4uL2F1dG8tcmVjb3ZlcnkudHNcIik7XG4gIGNvbnN0IHJlcG8gPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1yZWFjdGl2ZS12ZXJpZnktbGVnYWN5LVwiKSk7XG4gIHRyeSB7XG4gICAgY29uc3QgdGFza3NEaXIgPSBqb2luKHJlcG8sIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIsIFwidGFza3NcIik7XG4gICAgbWtkaXJTeW5jKHRhc2tzRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4odGFza3NEaXIsIFwiVDAxLVNVTU1BUlkubWRcIiksIFwiLS0tXFxuaWQ6IFQwMVxcbi0tLVxcbiMgVDAxXFxuXCIpO1xuXG4gICAgLy8gTGVnYWN5IGZvcm1hdCB3aXRob3V0ICtiYXRjaCBzdWZmaXhcbiAgICBjb25zdCByZXN1bHQgPSB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0KFwicmVhY3RpdmUtZXhlY3V0ZVwiLCBcIk0wMDEvUzAxL3JlYWN0aXZlXCIsIHJlcG8pO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIHRydWUsIFwiTGVnYWN5IGZvcm1hdCBzaG91bGQgZmFsbCBiYWNrIHRvIGFueS1zdW1tYXJ5IGNoZWNrXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhyZXBvLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwidW5pdElkIGJhdGNoIGVuY29kaW5nIHJvdW5kLXRyaXBzIGNvcnJlY3RseVwiLCAoKSA9PiB7XG4gIGNvbnN0IG1pZCA9IFwiTTAwMVwiO1xuICBjb25zdCBzaWQgPSBcIlMwMVwiO1xuICBjb25zdCBzZWxlY3RlZCA9IFtcIlQwMlwiLCBcIlQwM1wiLCBcIlQwNVwiXTtcbiAgY29uc3QgdW5pdElkID0gYCR7bWlkfS8ke3NpZH0vcmVhY3RpdmUrJHtzZWxlY3RlZC5qb2luKFwiLFwiKX1gO1xuXG4gIC8vIFBhcnNlIGl0IGJhY2tcbiAgY29uc3QgeyBtaWxlc3RvbmUsIHNsaWNlLCB0YXNrOiBiYXRjaFBhcnQgfSA9IHBhcnNlVW5pdElkKHVuaXRJZCk7XG4gIGFzc2VydC5lcXVhbChtaWxlc3RvbmUsIFwiTTAwMVwiKTtcbiAgYXNzZXJ0LmVxdWFsKHNsaWNlLCBcIlMwMVwiKTtcbiAgY29uc3QgcGx1c0lkeCA9IGJhdGNoUGFydCEuaW5kZXhPZihcIitcIik7XG4gIGFzc2VydC5vayhwbHVzSWR4ID4gMCwgXCJTaG91bGQgaGF2ZSArIHNlcGFyYXRvclwiKTtcbiAgY29uc3QgYmF0Y2hJZHMgPSBiYXRjaFBhcnQhLnNsaWNlKHBsdXNJZHggKyAxKS5zcGxpdChcIixcIik7XG4gIGFzc2VydC5kZWVwRXF1YWwoYmF0Y2hJZHMsIFtcIlQwMlwiLCBcIlQwM1wiLCBcIlQwNVwiXSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIERlcGVuZGVuY3ktQmFzZWQgQ2FycnktRm9yd2FyZCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcImdldERlcGVuZGVuY3lUYXNrU3VtbWFyeVBhdGhzIHJldHVybnMgb25seSBkZXBlbmRlbmN5IHN1bW1hcmllc1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgZ2V0RGVwZW5kZW5jeVRhc2tTdW1tYXJ5UGF0aHMgfSA9IGF3YWl0IGltcG9ydChcIi4uL2F1dG8tcHJvbXB0cy50c1wiKTtcbiAgY29uc3QgcmVwbyA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXJlYWN0aXZlLWRlcGNhcnJ5LVwiKSk7XG4gIHRyeSB7XG4gICAgY29uc3QgdGFza3NEaXIgPSBqb2luKHJlcG8sIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIsIFwidGFza3NcIik7XG4gICAgbWtkaXJTeW5jKHRhc2tzRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAvLyBUMDEsIFQwMiwgVDAzIGFsbCBoYXZlIHN1bW1hcmllc1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbih0YXNrc0RpciwgXCJUMDEtU1VNTUFSWS5tZFwiKSwgXCItLS1cXG5pZDogVDAxXFxuLS0tXFxuIyBUMDFcXG5cIik7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHRhc2tzRGlyLCBcIlQwMi1TVU1NQVJZLm1kXCIpLCBcIi0tLVxcbmlkOiBUMDJcXG4tLS1cXG4jIFQwMlxcblwiKTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4odGFza3NEaXIsIFwiVDAzLVNVTU1BUlkubWRcIiksIFwiLS0tXFxuaWQ6IFQwM1xcbi0tLVxcbiMgVDAzXFxuXCIpO1xuXG4gICAgLy8gVDA0IGRlcGVuZHMgb25seSBvbiBUMDEgYW5kIFQwMyBcdTIwMTQgc2hvdWxkIE5PVCBnZXQgVDAyXG4gICAgY29uc3QgcGF0aHMgPSBhd2FpdCBnZXREZXBlbmRlbmN5VGFza1N1bW1hcnlQYXRocyhcIk0wMDFcIiwgXCJTMDFcIiwgXCJUMDRcIiwgW1wiVDAxXCIsIFwiVDAzXCJdLCByZXBvKTtcbiAgICBhc3NlcnQuZXF1YWwocGF0aHMubGVuZ3RoLCAyLCBcIlNob3VsZCBnZXQgZXhhY3RseSAyIGRlcGVuZGVuY3kgc3VtbWFyaWVzXCIpO1xuICAgIGFzc2VydC5vayhwYXRocy5zb21lKChwKSA9PiBwLmluY2x1ZGVzKFwiVDAxLVNVTU1BUllcIikpLCBcIlNob3VsZCBpbmNsdWRlIFQwMVwiKTtcbiAgICBhc3NlcnQub2socGF0aHMuc29tZSgocCkgPT4gcC5pbmNsdWRlcyhcIlQwMy1TVU1NQVJZXCIpKSwgXCJTaG91bGQgaW5jbHVkZSBUMDNcIik7XG4gICAgYXNzZXJ0Lm9rKCFwYXRocy5zb21lKChwKSA9PiBwLmluY2x1ZGVzKFwiVDAyLVNVTU1BUllcIikpLCBcIlNob3VsZCBOT1QgaW5jbHVkZSBUMDJcIik7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKHJlcG8sIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJnZXREZXBlbmRlbmN5VGFza1N1bW1hcnlQYXRocyBmYWxscyBiYWNrIHRvIG9yZGVyLWJhc2VkIGZvciByb290IHRhc2tzXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyBnZXREZXBlbmRlbmN5VGFza1N1bW1hcnlQYXRocyB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vYXV0by1wcm9tcHRzLnRzXCIpO1xuICBjb25zdCByZXBvID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtcmVhY3RpdmUtZGVwY2Fycnktcm9vdC1cIikpO1xuICB0cnkge1xuICAgIGNvbnN0IHRhc2tzRGlyID0gam9pbihyZXBvLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiLCBcInRhc2tzXCIpO1xuICAgIG1rZGlyU3luYyh0YXNrc0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHRhc2tzRGlyLCBcIlQwMS1TVU1NQVJZLm1kXCIpLCBcIi0tLVxcbmlkOiBUMDFcXG4tLS1cXG4jIFQwMVxcblwiKTtcblxuICAgIC8vIFQwMiBoYXMgbm8gZGVwZW5kZW5jaWVzIChyb290IHRhc2spIFx1MjAxNCBzaG91bGQgZmFsbCBiYWNrIHRvIG9yZGVyLWJhc2VkXG4gICAgY29uc3QgcGF0aHMgPSBhd2FpdCBnZXREZXBlbmRlbmN5VGFza1N1bW1hcnlQYXRocyhcIk0wMDFcIiwgXCJTMDFcIiwgXCJUMDJcIiwgW10sIHJlcG8pO1xuICAgIGFzc2VydC5lcXVhbChwYXRocy5sZW5ndGgsIDEsIFwiUm9vdCB0YXNrIHNob3VsZCBnZXQgb3JkZXItYmFzZWQgcHJpb3Igc3VtbWFyaWVzXCIpO1xuICAgIGFzc2VydC5vayhwYXRoc1swXS5pbmNsdWRlcyhcIlQwMS1TVU1NQVJZXCIpLCBcIlNob3VsZCBpbmNsdWRlIFQwMSB2aWEgb3JkZXIgZmFsbGJhY2tcIik7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKHJlcG8sIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJnZXREZXBlbmRlbmN5VGFza1N1bW1hcnlQYXRocyBoYW5kbGVzIG1pc3NpbmcgZGVwZW5kZW5jeSBzdW1tYXJpZXMgZ3JhY2VmdWxseVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgZ2V0RGVwZW5kZW5jeVRhc2tTdW1tYXJ5UGF0aHMgfSA9IGF3YWl0IGltcG9ydChcIi4uL2F1dG8tcHJvbXB0cy50c1wiKTtcbiAgY29uc3QgcmVwbyA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXJlYWN0aXZlLWRlcGNhcnJ5LW1pc3NpbmctXCIpKTtcbiAgdHJ5IHtcbiAgICBjb25zdCB0YXNrc0RpciA9IGpvaW4ocmVwbywgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIiwgXCJ0YXNrc1wiKTtcbiAgICBta2RpclN5bmModGFza3NEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIC8vIE9ubHkgVDAxIGhhcyBhIHN1bW1hcnksIFQwMiBkb2VzIG5vdFxuICAgIHdyaXRlRmlsZVN5bmMoam9pbih0YXNrc0RpciwgXCJUMDEtU1VNTUFSWS5tZFwiKSwgXCItLS1cXG5pZDogVDAxXFxuLS0tXFxuIyBUMDFcXG5cIik7XG5cbiAgICAvLyBUMDMgZGVwZW5kcyBvbiBUMDEgYW5kIFQwMiwgYnV0IFQwMiBzdW1tYXJ5IGRvZXNuJ3QgZXhpc3RcbiAgICBjb25zdCBwYXRocyA9IGF3YWl0IGdldERlcGVuZGVuY3lUYXNrU3VtbWFyeVBhdGhzKFwiTTAwMVwiLCBcIlMwMVwiLCBcIlQwM1wiLCBbXCJUMDFcIiwgXCJUMDJcIl0sIHJlcG8pO1xuICAgIGFzc2VydC5lcXVhbChwYXRocy5sZW5ndGgsIDEsIFwiU2hvdWxkIG9ubHkgcmV0dXJuIGV4aXN0aW5nIGRlcGVuZGVuY3kgc3VtbWFyaWVzXCIpO1xuICAgIGFzc2VydC5vayhwYXRoc1swXS5pbmNsdWRlcyhcIlQwMS1TVU1NQVJZXCIpLCBcIlNob3VsZCBpbmNsdWRlIFQwMSAoZXhpc3RzKVwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmMocmVwbywgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhLFdBQVcsUUFBUSxlQUFlLGtCQUFnQztBQUN4RixTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBQ3ZCO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1AsU0FBUywyQkFBMkI7QUFFcEMsU0FBUyxtQkFBbUI7QUFJNUIsS0FBSyxzREFBc0QsTUFBTTtBQUMvRCxRQUFNLFNBQVMsb0JBQW9CO0FBQUEsSUFDakMsb0JBQW9CO0FBQUEsTUFDbEIsU0FBUztBQUFBLE1BQ1QsY0FBYztBQUFBLE1BQ2QsZ0JBQWdCO0FBQUEsSUFDbEI7QUFBQSxFQUNGLENBQUM7QUFDRCxTQUFPLE1BQU0sT0FBTyxPQUFPLFFBQVEsQ0FBQztBQUNwQyxTQUFPLFVBQVUsT0FBTyxZQUFZLG9CQUFvQjtBQUFBLElBQ3RELFNBQVM7QUFBQSxJQUNULGNB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
