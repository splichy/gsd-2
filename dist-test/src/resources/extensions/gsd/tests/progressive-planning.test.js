import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  setSliceSketchFlag,
  getSlice
} from "../gsd-db.js";
import { autoHealSketchFlags } from "../state-reconciliation/drift/sketch-flag.js";
import { deriveStateFromDb } from "../state.js";
import { resolveDispatch } from "../auto-dispatch.js";
function makeFixtureBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr011-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S02"), { recursive: true });
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
  return base;
}
function writePreferences(base, phasesBlock) {
  const prefsPath = join(base, ".gsd", "PREFERENCES.md");
  const body = [
    "---",
    "version: 1",
    phasesBlock,
    "---"
  ].join("\n");
  writeFileSync(prefsPath, body);
}
function seedMilestoneWithSketchedS02(base) {
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Foundation",
    status: "complete",
    risk: "high",
    depends: [],
    demo: "S01 done.",
    sequence: 1,
    isSketch: false
  });
  insertSlice({
    id: "S02",
    milestoneId: "M001",
    title: "Feature",
    status: "pending",
    risk: "medium",
    depends: ["S01"],
    demo: "S02 demo.",
    sequence: 2,
    isSketch: true,
    sketchScope: "Scope limited to feature X in module Y; no cross-cutting refactors."
  });
}
function writeS01Artifacts(base) {
  writeFileSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"), "# S01 Plan\n");
  writeFileSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md"), "# S01 Summary\n");
}
function cleanup(base, originalCwd) {
  try {
    closeDatabase();
  } catch {
  }
  process.chdir(originalCwd);
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
  }
}
test("ADR-011: sketch slice + progressive_planning ON \u2192 phase='refining'", async (t) => {
  const originalCwd = process.cwd();
  const base = makeFixtureBase();
  t.after(() => cleanup(base, originalCwd));
  seedMilestoneWithSketchedS02(base);
  writeS01Artifacts(base);
  writePreferences(base, "phases:\n  progressive_planning: true");
  process.chdir(base);
  const state = await deriveStateFromDb(base);
  assert.equal(state.activeSlice?.id, "S02", "S02 should be the active slice (S01 complete)");
  assert.equal(state.phase, "refining", "sketch slice with flag ON must yield refining phase");
});
test("ADR-011: sketch slice + progressive_planning OFF \u2192 DB sketch metadata still yields refining", async (t) => {
  const originalCwd = process.cwd();
  const base = makeFixtureBase();
  t.after(() => cleanup(base, originalCwd));
  seedMilestoneWithSketchedS02(base);
  writeS01Artifacts(base);
  writePreferences(base, "phases:\n  skip_research: false");
  process.chdir(base);
  const state = await deriveStateFromDb(base);
  assert.equal(state.activeSlice?.id, "S02");
  assert.equal(state.phase, "refining", "flag absent must not override DB sketch metadata");
});
test("ADR-011: dispatch rule maps refining \u2192 refine-slice unit", async (t) => {
  const originalCwd = process.cwd();
  const base = makeFixtureBase();
  t.after(() => cleanup(base, originalCwd));
  seedMilestoneWithSketchedS02(base);
  writeS01Artifacts(base);
  writePreferences(base, "phases:\n  progressive_planning: true");
  process.chdir(base);
  const state = await deriveStateFromDb(base);
  const ctx = {
    basePath: base,
    mid: "M001",
    midTitle: "Test",
    state,
    // Disable reassess-roadmap so it doesn't fire first on the just-completed S01.
    prefs: { phases: { progressive_planning: true, reassess_after_slice: false } }
  };
  const result = await resolveDispatch(ctx);
  assert.equal(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.equal(result.unitType, "refine-slice");
    assert.equal(result.unitId, "M001/S02");
  }
});
test("ADR-011: refining + flag flipped OFF mid-milestone \u2192 falls through to plan-slice (no dead-end)", async (t) => {
  const originalCwd = process.cwd();
  const base = makeFixtureBase();
  t.after(() => cleanup(base, originalCwd));
  seedMilestoneWithSketchedS02(base);
  writeS01Artifacts(base);
  writePreferences(base, "phases:\n  progressive_planning: true");
  process.chdir(base);
  const state = await deriveStateFromDb(base);
  assert.equal(state.phase, "refining");
  const ctx = {
    basePath: base,
    mid: "M001",
    midTitle: "Test",
    state,
    prefs: { phases: { progressive_planning: false, reassess_after_slice: false } }
  };
  const result = await resolveDispatch(ctx);
  assert.equal(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.equal(result.unitType, "plan-slice", "flag-off must downgrade to plan-slice");
  }
});
test("ADR-011: autoHealSketchFlags flips is_sketch=0 when PLAN file exists", async (t) => {
  const originalCwd = process.cwd();
  const base = makeFixtureBase();
  t.after(() => cleanup(base, originalCwd));
  seedMilestoneWithSketchedS02(base);
  writeS01Artifacts(base);
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", "S02", "S02-PLAN.md"),
    "# S02 Plan\n"
  );
  assert.equal(getSlice("M001", "S02")?.is_sketch, 1, "pre: flagged as sketch");
  const { existsSync } = await import("node:fs");
  autoHealSketchFlags("M001", (sid) => {
    const planPath = join(base, ".gsd", "milestones", "M001", "slices", sid, `${sid}-PLAN.md`);
    return existsSync(planPath);
  });
  assert.equal(getSlice("M001", "S02")?.is_sketch, 0, "post-heal: flag cleared");
});
test("ADR-011: schema v16 is idempotent \u2014 re-opening DB preserves is_sketch and sketch_scope columns", async (t) => {
  const originalCwd = process.cwd();
  const base = mkdtempSync(join(tmpdir(), "gsd-adr011-schema-"));
  t.after(() => {
    try {
      closeDatabase();
    } catch {
    }
    if (process.cwd() !== originalCwd) process.chdir(originalCwd);
    rmSync(base, { recursive: true, force: true });
  });
  const dbPath = join(base, "gsd.db");
  openDatabase(dbPath);
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "X",
    isSketch: true,
    sketchScope: "narrow scope"
  });
  assert.equal(getSlice("M001", "S01")?.is_sketch, 1);
  assert.equal(getSlice("M001", "S01")?.sketch_scope, "narrow scope");
  closeDatabase();
  openDatabase(dbPath);
  assert.equal(getSlice("M001", "S01")?.is_sketch, 1, "data survives re-open");
  assert.equal(getSlice("M001", "S01")?.sketch_scope, "narrow scope");
  insertSlice({ id: "S02", milestoneId: "M001", title: "Y" });
  assert.equal(getSlice("M001", "S02")?.is_sketch, 0, "default is_sketch=0");
  assert.equal(getSlice("M001", "S02")?.sketch_scope, "", "default sketch_scope=''");
  setSliceSketchFlag("M001", "S01", false);
  assert.equal(getSlice("M001", "S01")?.is_sketch, 0);
});
test("ADR-011 ON CONFLICT: omitted isSketch preserves existing is_sketch=1", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr011-conflict-"));
  t.after(() => {
    try {
      closeDatabase();
    } catch {
    }
    rmSync(base, { recursive: true, force: true });
  });
  openDatabase(join(base, "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "X",
    isSketch: true,
    sketchScope: "narrow scope"
  });
  assert.equal(getSlice("M001", "S01")?.is_sketch, 1);
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "X (updated title)"
    // isSketch intentionally omitted
  });
  assert.equal(
    getSlice("M001", "S01")?.is_sketch,
    1,
    "omitted isSketch must preserve the existing sketch flag on ON CONFLICT"
  );
  assert.equal(
    getSlice("M001", "S01")?.sketch_scope,
    "narrow scope",
    "omitted sketchScope must preserve existing scope on ON CONFLICT"
  );
});
test("ADR-011 ON CONFLICT: explicit isSketch=false clears existing sketch flag", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr011-conflict-false-"));
  t.after(() => {
    try {
      closeDatabase();
    } catch {
    }
    rmSync(base, { recursive: true, force: true });
  });
  openDatabase(join(base, "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "X",
    isSketch: true,
    sketchScope: "narrow scope"
  });
  assert.equal(getSlice("M001", "S01")?.is_sketch, 1);
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "X",
    isSketch: false
  });
  assert.equal(
    getSlice("M001", "S01")?.is_sketch,
    0,
    "explicit isSketch=false must clear the sketch flag"
  );
});
test("ADR-011 ON CONFLICT: isSketch=true upgrades existing non-sketch to sketch", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr011-conflict-true-"));
  t.after(() => {
    try {
      closeDatabase();
    } catch {
    }
    rmSync(base, { recursive: true, force: true });
  });
  openDatabase(join(base, "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "X" });
  assert.equal(getSlice("M001", "S01")?.is_sketch, 0);
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "X",
    isSketch: true,
    sketchScope: "new scope"
  });
  assert.equal(getSlice("M001", "S01")?.is_sketch, 1);
  assert.equal(getSlice("M001", "S01")?.sketch_scope, "new scope");
});
test("ADR-011 ON CONFLICT: empty-string sketchScope clears existing scope (not preserves it)", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr011-conflict-empty-"));
  t.after(() => {
    try {
      closeDatabase();
    } catch {
    }
    rmSync(base, { recursive: true, force: true });
  });
  openDatabase(join(base, "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "X",
    isSketch: true,
    sketchScope: "existing scope"
  });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "X",
    isSketch: false,
    sketchScope: ""
  });
  assert.equal(getSlice("M001", "S01")?.sketch_scope, "", "explicit '' must clear, not preserve");
});
test("ADR-011 P3 #19: refine-slice prompt incorporates prior slice findings + sketch scope as hard constraint", async (t) => {
  const originalCwd = process.cwd();
  const base = makeFixtureBase();
  t.after(() => cleanup(base, originalCwd));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Integration test milestone", status: "active" });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Foundation",
    status: "complete",
    risk: "high",
    depends: [],
    sequence: 1,
    isSketch: false
  });
  insertSlice({
    id: "S02",
    milestoneId: "M001",
    title: "Feature built on foundation",
    status: "pending",
    risk: "medium",
    depends: ["S01"],
    sequence: 2,
    isSketch: true,
    sketchScope: "Feature X in module Y only; do not refactor the foundation."
  });
  insertSlice({
    id: "S03",
    milestoneId: "M001",
    title: "Polish",
    status: "pending",
    risk: "low",
    depends: ["S02"],
    sequence: 3,
    isSketch: true,
    sketchScope: "Polish + docs for Feature X."
  });
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "ROADMAP.md"),
    [
      "# M001: Integration test milestone",
      "",
      "## Slices",
      "",
      "- [x] **S01: Foundation** `risk:high` `depends:[]`",
      "- [ ] **S02: Feature built on foundation** `risk:medium` `depends:[S01]`",
      "- [ ] **S03: Polish** `risk:low` `depends:[S02]`",
      ""
    ].join("\n")
  );
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"),
    "# S01 Plan\n"
  );
  const s01Findings = [
    "# S01 Summary",
    "",
    "## Findings",
    "",
    "- FINDING-MARKER-AUTH: chose JWT over sessions for statelessness.",
    "- FINDING-MARKER-DB: schema v17 migration required before S02 can safely add the feature table.",
    "",
    "## Key Decisions",
    "",
    "- Do not introduce a background worker yet \u2014 premature."
  ].join("\n");
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md"),
    s01Findings
  );
  writePreferences(base, "phases:\n  progressive_planning: true");
  process.chdir(base);
  const { buildRefineSlicePrompt } = await import("../auto-prompts.js");
  const prompt = await buildRefineSlicePrompt(
    "M001",
    "Integration test milestone",
    "S02",
    "Feature built on foundation",
    base
  );
  assert.match(
    prompt,
    /## Sketch Scope \(hard constraint\)/,
    "refine prompt must frame sketch_scope as a hard constraint"
  );
  assert.match(
    prompt,
    /Feature X in module Y only/,
    "refine prompt must include the stored sketch_scope text verbatim"
  );
  assert.match(
    prompt,
    /FINDING-MARKER-AUTH/,
    "S01's auth finding must surface in the S02 refine prompt"
  );
  assert.match(
    prompt,
    /FINDING-MARKER-DB/,
    "S01's DB finding must surface in the S02 refine prompt"
  );
  assert.match(
    prompt,
    /S01 Summary/,
    "inlineDependencySummaries must label the injected block with S01's section header"
  );
  assert.doesNotMatch(
    prompt,
    /Prior Sketch Scope \(soft hint — non-binding\)/,
    "refine prompt must NOT use the soft-hint framing (that's the plan-slice flag-off downgrade)"
  );
});
test("ADR-011 P3 #26: refine-slice dispatch latency is bounded vs plan-slice baseline", async (t) => {
  const originalCwd = process.cwd();
  const base = makeFixtureBase();
  t.after(() => cleanup(base, originalCwd));
  seedMilestoneWithSketchedS02(base);
  writeS01Artifacts(base);
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "ROADMAP.md"),
    [
      "# M001: Test",
      "",
      "## Slices",
      "",
      "- [x] **S01: Foundation** `risk:high` `depends:[]`",
      "- [ ] **S02: Feature** `risk:medium` `depends:[S01]`",
      ""
    ].join("\n")
  );
  writePreferences(base, "phases:\n  progressive_planning: true");
  process.chdir(base);
  const { buildRefineSlicePrompt, buildPlanSlicePrompt } = await import("../auto-prompts.js");
  await buildPlanSlicePrompt("M001", "Test", "S02", "Feature", base);
  await buildRefineSlicePrompt("M001", "Test", "S02", "Feature", base);
  const measure = async (fn) => {
    const start = performance.now();
    await fn();
    return performance.now() - start;
  };
  const planSamples = [];
  const refineSamples = [];
  for (let i = 0; i < 5; i++) {
    planSamples.push(await measure(() => buildPlanSlicePrompt("M001", "Test", "S02", "Feature", base)));
    refineSamples.push(await measure(() => buildRefineSlicePrompt("M001", "Test", "S02", "Feature", base)));
  }
  const bestPlan = Math.min(...planSamples);
  const bestRefine = Math.min(...refineSamples);
  assert.ok(
    bestRefine < 500,
    `refine-slice prompt build must complete under 500ms (best=${bestRefine.toFixed(1)}ms, samples=${refineSamples.map((n) => n.toFixed(1)).join(",")})`
  );
  if (bestPlan >= 20) {
    assert.ok(
      bestRefine < bestPlan * 3,
      `refine-slice must not exceed 3x plan-slice baseline (refine=${bestRefine.toFixed(1)}ms, plan=${bestPlan.toFixed(1)}ms)`
    );
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wcm9ncmVzc2l2ZS1wbGFubmluZy50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBHU0QgRXh0ZW5zaW9uIFx1MjAxNCBBRFItMDExIFByb2dyZXNzaXZlIFBsYW5uaW5nIHRlc3RzXG4vLyBTa2V0Y2ggZGV0ZWN0aW9uIFx1MjE5MiByZWZpbmluZyBwaGFzZSwgZGlzcGF0Y2ggcm91dGluZywgYXV0by1oZWFsLCBtaWdyYXRpb24gaWRlbXBvdGVuY3kuXG5cbmltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgcGVyZm9ybWFuY2UgfSBmcm9tIFwibm9kZTpwZXJmX2hvb2tzXCI7XG5cbmltcG9ydCB7XG4gIG9wZW5EYXRhYmFzZSxcbiAgY2xvc2VEYXRhYmFzZSxcbiAgaW5zZXJ0TWlsZXN0b25lLFxuICBpbnNlcnRTbGljZSxcbiAgc2V0U2xpY2VTa2V0Y2hGbGFnLFxuICBnZXRTbGljZSxcbn0gZnJvbSBcIi4uL2dzZC1kYi50c1wiO1xuaW1wb3J0IHsgYXV0b0hlYWxTa2V0Y2hGbGFncyB9IGZyb20gXCIuLi9zdGF0ZS1yZWNvbmNpbGlhdGlvbi9kcmlmdC9za2V0Y2gtZmxhZy50c1wiO1xuaW1wb3J0IHsgZGVyaXZlU3RhdGVGcm9tRGIgfSBmcm9tIFwiLi4vc3RhdGUudHNcIjtcbmltcG9ydCB7IHJlc29sdmVEaXNwYXRjaCB9IGZyb20gXCIuLi9hdXRvLWRpc3BhdGNoLnRzXCI7XG5pbXBvcnQgdHlwZSB7IERpc3BhdGNoQ29udGV4dCB9IGZyb20gXCIuLi9hdXRvLWRpc3BhdGNoLnRzXCI7XG5cbmZ1bmN0aW9uIG1ha2VGaXh0dXJlQmFzZSgpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtYWRyMDExLVwiKSk7XG4gIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAyXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICByZXR1cm4gYmFzZTtcbn1cblxuZnVuY3Rpb24gd3JpdGVQcmVmZXJlbmNlcyhiYXNlOiBzdHJpbmcsIHBoYXNlc0Jsb2NrOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgcHJlZnNQYXRoID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJQUkVGRVJFTkNFUy5tZFwiKTtcbiAgY29uc3QgYm9keSA9IFtcbiAgICBcIi0tLVwiLFxuICAgIFwidmVyc2lvbjogMVwiLFxuICAgIHBoYXNlc0Jsb2NrLFxuICAgIFwiLS0tXCIsXG4gIF0uam9pbihcIlxcblwiKTtcbiAgd3JpdGVGaWxlU3luYyhwcmVmc1BhdGgsIGJvZHkpO1xufVxuXG5mdW5jdGlvbiBzZWVkTWlsZXN0b25lV2l0aFNrZXRjaGVkUzAyKGJhc2U6IHN0cmluZyk6IHZvaWQge1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJnc2QuZGJcIikpO1xuICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuICAvLyBTMDE6IGZ1bGwgc2xpY2UsIGNvbXBsZXRlXG4gIGluc2VydFNsaWNlKHtcbiAgICBpZDogXCJTMDFcIixcbiAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgdGl0bGU6IFwiRm91bmRhdGlvblwiLFxuICAgIHN0YXR1czogXCJjb21wbGV0ZVwiLFxuICAgIHJpc2s6IFwiaGlnaFwiLFxuICAgIGRlcGVuZHM6IFtdLFxuICAgIGRlbW86IFwiUzAxIGRvbmUuXCIsXG4gICAgc2VxdWVuY2U6IDEsXG4gICAgaXNTa2V0Y2g6IGZhbHNlLFxuICB9KTtcbiAgLy8gUzAyOiBza2V0Y2ggc2xpY2UsIHBlbmRpbmdcbiAgaW5zZXJ0U2xpY2Uoe1xuICAgIGlkOiBcIlMwMlwiLFxuICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICB0aXRsZTogXCJGZWF0dXJlXCIsXG4gICAgc3RhdHVzOiBcInBlbmRpbmdcIixcbiAgICByaXNrOiBcIm1lZGl1bVwiLFxuICAgIGRlcGVuZHM6IFtcIlMwMVwiXSxcbiAgICBkZW1vOiBcIlMwMiBkZW1vLlwiLFxuICAgIHNlcXVlbmNlOiAyLFxuICAgIGlzU2tldGNoOiB0cnVlLFxuICAgIHNrZXRjaFNjb3BlOiBcIlNjb3BlIGxpbWl0ZWQgdG8gZmVhdHVyZSBYIGluIG1vZHVsZSBZOyBubyBjcm9zcy1jdXR0aW5nIHJlZmFjdG9ycy5cIixcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHdyaXRlUzAxQXJ0aWZhY3RzKGJhc2U6IHN0cmluZyk6IHZvaWQge1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIiwgXCJTMDEtUExBTi5tZFwiKSwgXCIjIFMwMSBQbGFuXFxuXCIpO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIiwgXCJTMDEtU1VNTUFSWS5tZFwiKSwgXCIjIFMwMSBTdW1tYXJ5XFxuXCIpO1xufVxuXG5mdW5jdGlvbiBjbGVhbnVwKGJhc2U6IHN0cmluZywgb3JpZ2luYWxDd2Q6IHN0cmluZyk6IHZvaWQge1xuICB0cnkgeyBjbG9zZURhdGFiYXNlKCk7IH0gY2F0Y2ggeyAvKiBub29wICovIH1cbiAgcHJvY2Vzcy5jaGRpcihvcmlnaW5hbEN3ZCk7XG4gIHRyeSB7IHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0gY2F0Y2ggeyAvKiBub29wICovIH1cbn1cblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBUZXN0c1xuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbnRlc3QoXCJBRFItMDExOiBza2V0Y2ggc2xpY2UgKyBwcm9ncmVzc2l2ZV9wbGFubmluZyBPTiBcdTIxOTIgcGhhc2U9J3JlZmluaW5nJ1wiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBvcmlnaW5hbEN3ZCA9IHByb2Nlc3MuY3dkKCk7XG4gIGNvbnN0IGJhc2UgPSBtYWtlRml4dHVyZUJhc2UoKTtcbiAgdC5hZnRlcigoKSA9PiBjbGVhbnVwKGJhc2UsIG9yaWdpbmFsQ3dkKSk7XG5cbiAgc2VlZE1pbGVzdG9uZVdpdGhTa2V0Y2hlZFMwMihiYXNlKTtcbiAgd3JpdGVTMDFBcnRpZmFjdHMoYmFzZSk7XG4gIHdyaXRlUHJlZmVyZW5jZXMoYmFzZSwgXCJwaGFzZXM6XFxuICBwcm9ncmVzc2l2ZV9wbGFubmluZzogdHJ1ZVwiKTtcbiAgcHJvY2Vzcy5jaGRpcihiYXNlKTtcblxuICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlRnJvbURiKGJhc2UpO1xuICBhc3NlcnQuZXF1YWwoc3RhdGUuYWN0aXZlU2xpY2U/LmlkLCBcIlMwMlwiLCBcIlMwMiBzaG91bGQgYmUgdGhlIGFjdGl2ZSBzbGljZSAoUzAxIGNvbXBsZXRlKVwiKTtcbiAgYXNzZXJ0LmVxdWFsKHN0YXRlLnBoYXNlLCBcInJlZmluaW5nXCIsIFwic2tldGNoIHNsaWNlIHdpdGggZmxhZyBPTiBtdXN0IHlpZWxkIHJlZmluaW5nIHBoYXNlXCIpO1xufSk7XG5cbnRlc3QoXCJBRFItMDExOiBza2V0Y2ggc2xpY2UgKyBwcm9ncmVzc2l2ZV9wbGFubmluZyBPRkYgXHUyMTkyIERCIHNrZXRjaCBtZXRhZGF0YSBzdGlsbCB5aWVsZHMgcmVmaW5pbmdcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3Qgb3JpZ2luYWxDd2QgPSBwcm9jZXNzLmN3ZCgpO1xuICBjb25zdCBiYXNlID0gbWFrZUZpeHR1cmVCYXNlKCk7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChiYXNlLCBvcmlnaW5hbEN3ZCkpO1xuXG4gIHNlZWRNaWxlc3RvbmVXaXRoU2tldGNoZWRTMDIoYmFzZSk7XG4gIHdyaXRlUzAxQXJ0aWZhY3RzKGJhc2UpO1xuICAvLyBXcml0ZSBhIFBSRUZFUkVOQ0VTLm1kIHdpdGhvdXQgdGhlIGZsYWcuIERCIHNsaWNlIG1ldGFkYXRhIHJlbWFpbnNcbiAgLy8gYXV0aG9yaXRhdGl2ZSBmb3Igd2hldGhlciB0aGlzIHNsaWNlIG5lZWRzIHJlZmluZW1lbnQuXG4gIHdyaXRlUHJlZmVyZW5jZXMoYmFzZSwgXCJwaGFzZXM6XFxuICBza2lwX3Jlc2VhcmNoOiBmYWxzZVwiKTtcbiAgcHJvY2Vzcy5jaGRpcihiYXNlKTtcblxuICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlRnJvbURiKGJhc2UpO1xuICBhc3NlcnQuZXF1YWwoc3RhdGUuYWN0aXZlU2xpY2U/LmlkLCBcIlMwMlwiKTtcbiAgYXNzZXJ0LmVxdWFsKHN0YXRlLnBoYXNlLCBcInJlZmluaW5nXCIsIFwiZmxhZyBhYnNlbnQgbXVzdCBub3Qgb3ZlcnJpZGUgREIgc2tldGNoIG1ldGFkYXRhXCIpO1xufSk7XG5cbnRlc3QoXCJBRFItMDExOiBkaXNwYXRjaCBydWxlIG1hcHMgcmVmaW5pbmcgXHUyMTkyIHJlZmluZS1zbGljZSB1bml0XCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IG9yaWdpbmFsQ3dkID0gcHJvY2Vzcy5jd2QoKTtcbiAgY29uc3QgYmFzZSA9IG1ha2VGaXh0dXJlQmFzZSgpO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXAoYmFzZSwgb3JpZ2luYWxDd2QpKTtcblxuICBzZWVkTWlsZXN0b25lV2l0aFNrZXRjaGVkUzAyKGJhc2UpO1xuICB3cml0ZVMwMUFydGlmYWN0cyhiYXNlKTtcbiAgd3JpdGVQcmVmZXJlbmNlcyhiYXNlLCBcInBoYXNlczpcXG4gIHByb2dyZXNzaXZlX3BsYW5uaW5nOiB0cnVlXCIpO1xuICBwcm9jZXNzLmNoZGlyKGJhc2UpO1xuXG4gIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGVGcm9tRGIoYmFzZSk7XG4gIGNvbnN0IGN0eDogRGlzcGF0Y2hDb250ZXh0ID0ge1xuICAgIGJhc2VQYXRoOiBiYXNlLFxuICAgIG1pZDogXCJNMDAxXCIsXG4gICAgbWlkVGl0bGU6IFwiVGVzdFwiLFxuICAgIHN0YXRlLFxuICAgIC8vIERpc2FibGUgcmVhc3Nlc3Mtcm9hZG1hcCBzbyBpdCBkb2Vzbid0IGZpcmUgZmlyc3Qgb24gdGhlIGp1c3QtY29tcGxldGVkIFMwMS5cbiAgICBwcmVmczogeyBwaGFzZXM6IHsgcHJvZ3Jlc3NpdmVfcGxhbm5pbmc6IHRydWUsIHJlYXNzZXNzX2FmdGVyX3NsaWNlOiBmYWxzZSB9IH0gYXMgYW55LFxuICB9O1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXNvbHZlRGlzcGF0Y2goY3R4KTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5hY3Rpb24sIFwiZGlzcGF0Y2hcIik7XG4gIGlmIChyZXN1bHQuYWN0aW9uID09PSBcImRpc3BhdGNoXCIpIHtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnVuaXRUeXBlLCBcInJlZmluZS1zbGljZVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnVuaXRJZCwgXCJNMDAxL1MwMlwiKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJBRFItMDExOiByZWZpbmluZyArIGZsYWcgZmxpcHBlZCBPRkYgbWlkLW1pbGVzdG9uZSBcdTIxOTIgZmFsbHMgdGhyb3VnaCB0byBwbGFuLXNsaWNlIChubyBkZWFkLWVuZClcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3Qgb3JpZ2luYWxDd2QgPSBwcm9jZXNzLmN3ZCgpO1xuICBjb25zdCBiYXNlID0gbWFrZUZpeHR1cmVCYXNlKCk7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChiYXNlLCBvcmlnaW5hbEN3ZCkpO1xuXG4gIHNlZWRNaWxlc3RvbmVXaXRoU2tldGNoZWRTMDIoYmFzZSk7XG4gIHdyaXRlUzAxQXJ0aWZhY3RzKGJhc2UpO1xuICAvLyBwcmVmcyBPTiBzbyBzdGF0ZSBkZXJpdmF0aW9uIHlpZWxkcyAncmVmaW5pbmcnLi4uXG4gIHdyaXRlUHJlZmVyZW5jZXMoYmFzZSwgXCJwaGFzZXM6XFxuICBwcm9ncmVzc2l2ZV9wbGFubmluZzogdHJ1ZVwiKTtcbiAgcHJvY2Vzcy5jaGRpcihiYXNlKTtcbiAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZUZyb21EYihiYXNlKTtcbiAgYXNzZXJ0LmVxdWFsKHN0YXRlLnBoYXNlLCBcInJlZmluaW5nXCIpO1xuXG4gIC8vIC4uLnRoZW4gZGlzcGF0Y2ggaXMgaW52b2tlZCB3aXRoIHRoZSBmbGFnIE9GRiAoc2ltdWxhdGVzIHVzZXIgdG9nZ2xpbmdcbiAgLy8gcHJvZ3Jlc3NpdmVfcGxhbm5pbmcgb2ZmIHdoaWxlIGEgc2xpY2Ugc2l0cyBpbiAncmVmaW5pbmcnKS4gVGhlIHJ1bGVcbiAgLy8gbXVzdCBncmFjZWZ1bGx5IGRvd25ncmFkZSB0byBwbGFuLXNsaWNlLCBub3QgcmV0dXJuIG51bGwgKGRlYWQtZW5kKS5cbiAgY29uc3QgY3R4OiBEaXNwYXRjaENvbnRleHQgPSB7XG4gICAgYmFzZVBhdGg6IGJhc2UsXG4gICAgbWlkOiBcIk0wMDFcIixcbiAgICBtaWRUaXRsZTogXCJUZXN0XCIsXG4gICAgc3RhdGUsXG4gICAgcHJlZnM6IHsgcGhhc2VzOiB7IHByb2dyZXNzaXZlX3BsYW5uaW5nOiBmYWxzZSwgcmVhc3Nlc3NfYWZ0ZXJfc2xpY2U6IGZhbHNlIH0gfSBhcyBhbnksXG4gIH07XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlc29sdmVEaXNwYXRjaChjdHgpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LmFjdGlvbiwgXCJkaXNwYXRjaFwiKTtcbiAgaWYgKHJlc3VsdC5hY3Rpb24gPT09IFwiZGlzcGF0Y2hcIikge1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQudW5pdFR5cGUsIFwicGxhbi1zbGljZVwiLCBcImZsYWctb2ZmIG11c3QgZG93bmdyYWRlIHRvIHBsYW4tc2xpY2VcIik7XG4gIH1cbn0pO1xuXG50ZXN0KFwiQURSLTAxMTogYXV0b0hlYWxTa2V0Y2hGbGFncyBmbGlwcyBpc19za2V0Y2g9MCB3aGVuIFBMQU4gZmlsZSBleGlzdHNcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3Qgb3JpZ2luYWxDd2QgPSBwcm9jZXNzLmN3ZCgpO1xuICBjb25zdCBiYXNlID0gbWFrZUZpeHR1cmVCYXNlKCk7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChiYXNlLCBvcmlnaW5hbEN3ZCkpO1xuXG4gIHNlZWRNaWxlc3RvbmVXaXRoU2tldGNoZWRTMDIoYmFzZSk7XG4gIHdyaXRlUzAxQXJ0aWZhY3RzKGJhc2UpO1xuICAvLyBTaW11bGF0ZSBjcmFzaCBiZXR3ZWVuIHBsYW4tc2xpY2Ugd3JpdGUgYW5kIHNrZXRjaCBmbGlwOiBQTEFOLm1kIGV4aXN0c1xuICAvLyBidXQgaXNfc2tldGNoIGlzIHN0aWxsIDEuXG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMlwiLCBcIlMwMi1QTEFOLm1kXCIpLFxuICAgIFwiIyBTMDIgUGxhblxcblwiLFxuICApO1xuICBhc3NlcnQuZXF1YWwoZ2V0U2xpY2UoXCJNMDAxXCIsIFwiUzAyXCIpPy5pc19za2V0Y2gsIDEsIFwicHJlOiBmbGFnZ2VkIGFzIHNrZXRjaFwiKTtcblxuICBjb25zdCB7IGV4aXN0c1N5bmMgfSA9IGF3YWl0IGltcG9ydChcIm5vZGU6ZnNcIik7XG4gIGF1dG9IZWFsU2tldGNoRmxhZ3MoXCJNMDAxXCIsIChzaWQpID0+IHtcbiAgICBjb25zdCBwbGFuUGF0aCA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgc2lkLCBgJHtzaWR9LVBMQU4ubWRgKTtcbiAgICByZXR1cm4gZXhpc3RzU3luYyhwbGFuUGF0aCk7XG4gIH0pO1xuXG4gIGFzc2VydC5lcXVhbChnZXRTbGljZShcIk0wMDFcIiwgXCJTMDJcIik/LmlzX3NrZXRjaCwgMCwgXCJwb3N0LWhlYWw6IGZsYWcgY2xlYXJlZFwiKTtcbn0pO1xuXG50ZXN0KFwiQURSLTAxMTogc2NoZW1hIHYxNiBpcyBpZGVtcG90ZW50IFx1MjAxNCByZS1vcGVuaW5nIERCIHByZXNlcnZlcyBpc19za2V0Y2ggYW5kIHNrZXRjaF9zY29wZSBjb2x1bW5zXCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IG9yaWdpbmFsQ3dkID0gcHJvY2Vzcy5jd2QoKTtcbiAgY29uc3QgYmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLWFkcjAxMS1zY2hlbWEtXCIpKTtcbiAgdC5hZnRlcigoKSA9PiB7XG4gICAgdHJ5IHsgY2xvc2VEYXRhYmFzZSgpOyB9IGNhdGNoIHsgLyogbm9vcCAqLyB9XG4gICAgLy8gUmVzdG9yZSBjd2QgZXZlbiB0aG91Z2ggdGhpcyB0ZXN0IGRvZXNuJ3QgY2hkaXIgXHUyMDE0IGd1YXJkcyBhZ2FpbnN0XG4gICAgLy8gbGVha2VkIGN3ZCBmcm9tIGFueSBlYXJsaWVyIHRlc3QgaW4gdGhlIGZpbGUuXG4gICAgaWYgKHByb2Nlc3MuY3dkKCkgIT09IG9yaWdpbmFsQ3dkKSBwcm9jZXNzLmNoZGlyKG9yaWdpbmFsQ3dkKTtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcblxuICBjb25zdCBkYlBhdGggPSBqb2luKGJhc2UsIFwiZ3NkLmRiXCIpO1xuICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcbiAgLy8gSW5zZXJ0IGEgc2tldGNoIHNsaWNlIFx1MjAxNCByb3VuZC10cmlwIHByb3ZlcyB0aGUgY29sdW1ucyBleGlzdCB3aXRoIGNvcnJlY3RcbiAgLy8gZGVmYXVsdHMuIElmIG1pZ3JhdGlvbiBoYWRuJ3QgcnVuLCBpbnNlcnRTbGljZSB3b3VsZCB0aHJvdyBvbiB0aGUgbmV3XG4gIC8vIG5hbWVkIHBhcmFtcy5cbiAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIsIHN0YXR1czogXCJhY3RpdmVcIiB9KTtcbiAgaW5zZXJ0U2xpY2Uoe1xuICAgIGlkOiBcIlMwMVwiLFxuICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICB0aXRsZTogXCJYXCIsXG4gICAgaXNTa2V0Y2g6IHRydWUsXG4gICAgc2tldGNoU2NvcGU6IFwibmFycm93IHNjb3BlXCIsXG4gIH0pO1xuICBhc3NlcnQuZXF1YWwoZ2V0U2xpY2UoXCJNMDAxXCIsIFwiUzAxXCIpPy5pc19za2V0Y2gsIDEpO1xuICBhc3NlcnQuZXF1YWwoZ2V0U2xpY2UoXCJNMDAxXCIsIFwiUzAxXCIpPy5za2V0Y2hfc2NvcGUsIFwibmFycm93IHNjb3BlXCIpO1xuXG4gIC8vIENsb3NlIGFuZCByZS1vcGVuIFx1MjAxNCBtaWdyYXRpb24gbXVzdCBiZSBhIG5vLW9wIHRoZSBzZWNvbmQgdGltZSBhbmRcbiAgLy8gZGF0YSBtdXN0IHBlcnNpc3QuXG4gIGNsb3NlRGF0YWJhc2UoKTtcbiAgb3BlbkRhdGFiYXNlKGRiUGF0aCk7XG4gIGFzc2VydC5lcXVhbChnZXRTbGljZShcIk0wMDFcIiwgXCJTMDFcIik/LmlzX3NrZXRjaCwgMSwgXCJkYXRhIHN1cnZpdmVzIHJlLW9wZW5cIik7XG4gIGFzc2VydC5lcXVhbChnZXRTbGljZShcIk0wMDFcIiwgXCJTMDFcIik/LnNrZXRjaF9zY29wZSwgXCJuYXJyb3cgc2NvcGVcIik7XG5cbiAgLy8gSW5zZXJ0aW5nIGEgZnVsbCAobm9uLXNrZXRjaCkgc2xpY2UgdXNlcyB0aGUgZGVmYXVsdCBjb2x1bW4gdmFsdWVzLlxuICBpbnNlcnRTbGljZSh7IGlkOiBcIlMwMlwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHRpdGxlOiBcIllcIiB9KTtcbiAgYXNzZXJ0LmVxdWFsKGdldFNsaWNlKFwiTTAwMVwiLCBcIlMwMlwiKT8uaXNfc2tldGNoLCAwLCBcImRlZmF1bHQgaXNfc2tldGNoPTBcIik7XG4gIGFzc2VydC5lcXVhbChnZXRTbGljZShcIk0wMDFcIiwgXCJTMDJcIik/LnNrZXRjaF9zY29wZSwgXCJcIiwgXCJkZWZhdWx0IHNrZXRjaF9zY29wZT0nJ1wiKTtcblxuICAvLyBzZXRTbGljZVNrZXRjaEZsYWcgcm91bmQtdHJpcC5cbiAgc2V0U2xpY2VTa2V0Y2hGbGFnKFwiTTAwMVwiLCBcIlMwMVwiLCBmYWxzZSk7XG4gIGFzc2VydC5lcXVhbChnZXRTbGljZShcIk0wMDFcIiwgXCJTMDFcIik/LmlzX3NrZXRjaCwgMCk7XG59KTtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBBRFItMDExOiBpbnNlcnRTbGljZSBPTiBDT05GTElDVCBza2V0Y2gtZmxhZyBwcmVzZXJ2YXRpb24gbWF0cml4XG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIFJlZ3Jlc3Npb24gY292ZXJhZ2UgZm9yIHRoZSAzLXZhbHVlZCBpc1NrZXRjaCBzZW1hbnRpY3MgKHRydWUvZmFsc2UvdW5kZWZpbmVkKS5cbi8vIFJlLXBsYW5uaW5nIGEgbWlsZXN0b25lIG11c3QgTk9UIHNpbGVudGx5IGZsaXAgYSBza2V0Y2ggc2xpY2UgdG8gbm9uLXNrZXRjaFxuLy8gKG9yIHZpY2UgdmVyc2EpIHVubGVzcyB0aGUgY2FsbGVyIGV4cGxpY2l0bHkgaW50ZW5kcyB0aGUgY2hhbmdlLlxuXG50ZXN0KFwiQURSLTAxMSBPTiBDT05GTElDVDogb21pdHRlZCBpc1NrZXRjaCBwcmVzZXJ2ZXMgZXhpc3RpbmcgaXNfc2tldGNoPTFcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLWFkcjAxMS1jb25mbGljdC1cIikpO1xuICB0LmFmdGVyKCgpID0+IHtcbiAgICB0cnkgeyBjbG9zZURhdGFiYXNlKCk7IH0gY2F0Y2ggeyAvKiBub29wICovIH1cbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgXCJnc2QuZGJcIikpO1xuICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuXG4gIC8vIFNlZWQ6IFMwMSBpcyBhIHNrZXRjaC5cbiAgaW5zZXJ0U2xpY2Uoe1xuICAgIGlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHRpdGxlOiBcIlhcIixcbiAgICBpc1NrZXRjaDogdHJ1ZSwgc2tldGNoU2NvcGU6IFwibmFycm93IHNjb3BlXCIsXG4gIH0pO1xuICBhc3NlcnQuZXF1YWwoZ2V0U2xpY2UoXCJNMDAxXCIsIFwiUzAxXCIpPy5pc19za2V0Y2gsIDEpO1xuXG4gIC8vIFJlLXBsYW4gd2l0aCBpc1NrZXRjaCBvbWl0dGVkICh1bmRlZmluZWQpIFx1MjAxNCBNVVNUIHByZXNlcnZlIHNrZXRjaCBzdGF0ZS5cbiAgaW5zZXJ0U2xpY2Uoe1xuICAgIGlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHRpdGxlOiBcIlggKHVwZGF0ZWQgdGl0bGUpXCIsXG4gICAgLy8gaXNTa2V0Y2ggaW50ZW50aW9uYWxseSBvbWl0dGVkXG4gIH0pO1xuICBhc3NlcnQuZXF1YWwoXG4gICAgZ2V0U2xpY2UoXCJNMDAxXCIsIFwiUzAxXCIpPy5pc19za2V0Y2gsIDEsXG4gICAgXCJvbWl0dGVkIGlzU2tldGNoIG11c3QgcHJlc2VydmUgdGhlIGV4aXN0aW5nIHNrZXRjaCBmbGFnIG9uIE9OIENPTkZMSUNUXCIsXG4gICk7XG4gIGFzc2VydC5lcXVhbChcbiAgICBnZXRTbGljZShcIk0wMDFcIiwgXCJTMDFcIik/LnNrZXRjaF9zY29wZSwgXCJuYXJyb3cgc2NvcGVcIixcbiAgICBcIm9taXR0ZWQgc2tldGNoU2NvcGUgbXVzdCBwcmVzZXJ2ZSBleGlzdGluZyBzY29wZSBvbiBPTiBDT05GTElDVFwiLFxuICApO1xufSk7XG5cbnRlc3QoXCJBRFItMDExIE9OIENPTkZMSUNUOiBleHBsaWNpdCBpc1NrZXRjaD1mYWxzZSBjbGVhcnMgZXhpc3Rpbmcgc2tldGNoIGZsYWdcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLWFkcjAxMS1jb25mbGljdC1mYWxzZS1cIikpO1xuICB0LmFmdGVyKCgpID0+IHtcbiAgICB0cnkgeyBjbG9zZURhdGFiYXNlKCk7IH0gY2F0Y2ggeyAvKiBub29wICovIH1cbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgXCJnc2QuZGJcIikpO1xuICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuXG4gIGluc2VydFNsaWNlKHtcbiAgICBpZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJYXCIsXG4gICAgaXNTa2V0Y2g6IHRydWUsIHNrZXRjaFNjb3BlOiBcIm5hcnJvdyBzY29wZVwiLFxuICB9KTtcbiAgYXNzZXJ0LmVxdWFsKGdldFNsaWNlKFwiTTAwMVwiLCBcIlMwMVwiKT8uaXNfc2tldGNoLCAxKTtcblxuICAvLyBFeHBsaWNpdCBpc1NrZXRjaD1mYWxzZSBpbnRlbnRpb25hbGx5IGNsZWFycyB0aGUgZmxhZyAoZS5nLiwgdXNlciByZS1wbGFuc1xuICAvLyBza2V0Y2ggYXMgZnVsbCBzbGljZSkuXG4gIGluc2VydFNsaWNlKHtcbiAgICBpZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJYXCIsXG4gICAgaXNTa2V0Y2g6IGZhbHNlLFxuICB9KTtcbiAgYXNzZXJ0LmVxdWFsKFxuICAgIGdldFNsaWNlKFwiTTAwMVwiLCBcIlMwMVwiKT8uaXNfc2tldGNoLCAwLFxuICAgIFwiZXhwbGljaXQgaXNTa2V0Y2g9ZmFsc2UgbXVzdCBjbGVhciB0aGUgc2tldGNoIGZsYWdcIixcbiAgKTtcbn0pO1xuXG50ZXN0KFwiQURSLTAxMSBPTiBDT05GTElDVDogaXNTa2V0Y2g9dHJ1ZSB1cGdyYWRlcyBleGlzdGluZyBub24tc2tldGNoIHRvIHNrZXRjaFwiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtYWRyMDExLWNvbmZsaWN0LXRydWUtXCIpKTtcbiAgdC5hZnRlcigoKSA9PiB7XG4gICAgdHJ5IHsgY2xvc2VEYXRhYmFzZSgpOyB9IGNhdGNoIHsgLyogbm9vcCAqLyB9XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfSk7XG4gIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsIFwiZ3NkLmRiXCIpKTtcbiAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIsIHN0YXR1czogXCJhY3RpdmVcIiB9KTtcblxuICAvLyBTZWVkIGFzIGZ1bGwgc2xpY2UuXG4gIGluc2VydFNsaWNlKHsgaWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiWFwiIH0pO1xuICBhc3NlcnQuZXF1YWwoZ2V0U2xpY2UoXCJNMDAxXCIsIFwiUzAxXCIpPy5pc19za2V0Y2gsIDApO1xuXG4gIC8vIFJlLXBsYW4gdXBncmFkaW5nIHRvIHNrZXRjaC5cbiAgaW5zZXJ0U2xpY2Uoe1xuICAgIGlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHRpdGxlOiBcIlhcIixcbiAgICBpc1NrZXRjaDogdHJ1ZSwgc2tldGNoU2NvcGU6IFwibmV3IHNjb3BlXCIsXG4gIH0pO1xuICBhc3NlcnQuZXF1YWwoZ2V0U2xpY2UoXCJNMDAxXCIsIFwiUzAxXCIpPy5pc19za2V0Y2gsIDEpO1xuICBhc3NlcnQuZXF1YWwoZ2V0U2xpY2UoXCJNMDAxXCIsIFwiUzAxXCIpPy5za2V0Y2hfc2NvcGUsIFwibmV3IHNjb3BlXCIpO1xufSk7XG5cbnRlc3QoXCJBRFItMDExIE9OIENPTkZMSUNUOiBlbXB0eS1zdHJpbmcgc2tldGNoU2NvcGUgY2xlYXJzIGV4aXN0aW5nIHNjb3BlIChub3QgcHJlc2VydmVzIGl0KVwiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtYWRyMDExLWNvbmZsaWN0LWVtcHR5LVwiKSk7XG4gIHQuYWZ0ZXIoKCkgPT4ge1xuICAgIHRyeSB7IGNsb3NlRGF0YWJhc2UoKTsgfSBjYXRjaCB7IC8qIG5vb3AgKi8gfVxuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH0pO1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCBcImdzZC5kYlwiKSk7XG4gIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdFwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSk7XG5cbiAgaW5zZXJ0U2xpY2Uoe1xuICAgIGlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHRpdGxlOiBcIlhcIixcbiAgICBpc1NrZXRjaDogdHJ1ZSwgc2tldGNoU2NvcGU6IFwiZXhpc3Rpbmcgc2NvcGVcIixcbiAgfSk7XG4gIC8vIEV4cGxpY2l0IGVtcHR5IHN0cmluZyBpcyB0aGUgY2FsbGVyIHNheWluZyBcImNsZWFyIGl0XCIgXHUyMDE0IG11c3Qgbm90IGJlXG4gIC8vIHRyZWF0ZWQgYXMgYWJzZW50ICh0aGUgYD8/IG51bGxgIGZvb3RndW4gdGhlIHBlZXIgcmV2aWV3IGZsYWdnZWQpLlxuICBpbnNlcnRTbGljZSh7XG4gICAgaWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiWFwiLFxuICAgIGlzU2tldGNoOiBmYWxzZSwgc2tldGNoU2NvcGU6IFwiXCIsXG4gIH0pO1xuICBhc3NlcnQuZXF1YWwoZ2V0U2xpY2UoXCJNMDAxXCIsIFwiUzAxXCIpPy5za2V0Y2hfc2NvcGUsIFwiXCIsIFwiZXhwbGljaXQgJycgbXVzdCBjbGVhciwgbm90IHByZXNlcnZlXCIpO1xufSk7XG5cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuLy8gQURSLTAxMSBQaGFzZSAzIFx1MjAxNCBJbnRlZ3JhdGlvbjogUHJvZ3Jlc3NpdmUgUGxhbm5pbmdcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG50ZXN0KFwiQURSLTAxMSBQMyAjMTk6IHJlZmluZS1zbGljZSBwcm9tcHQgaW5jb3Jwb3JhdGVzIHByaW9yIHNsaWNlIGZpbmRpbmdzICsgc2tldGNoIHNjb3BlIGFzIGhhcmQgY29uc3RyYWludFwiLCBhc3luYyAodCkgPT4ge1xuICAvLyBFeGVyY2lzZXMgdGhlIGVuZC10by1lbmQgcGF0aCB0aGF0IG1ha2VzIHByb2dyZXNzaXZlIHBsYW5uaW5nIHVzZWZ1bDpcbiAgLy8gICAxLiBNMDAxIGhhcyAzIHNsaWNlcy4gUzAxIGlzIGZ1bGwgYW5kIGNvbXBsZXRlLCB3aXRoIGEgU1VNTUFSWS5tZCB0aGF0XG4gIC8vICAgICAgY29udGFpbnMgc3BlY2lmaWMgZmluZGluZ3MuIFMwMiBpcyBhIHNrZXRjaCB0aGF0IGRlcGVuZHMgb24gUzAxLlxuICAvLyAgIDIuIFRoZSByZWZpbmluZy1waGFzZSBkaXNwYXRjaCBidWlsZHMgUzAyJ3MgcHJvbXB0IHZpYSBidWlsZFJlZmluZVNsaWNlUHJvbXB0LlxuICAvLyAgIDMuIFRoZSBnZW5lcmF0ZWQgcHJvbXB0IG11c3QgY29udGFpbiBCT1RIIHRoZSBTMDEgZmluZGluZ3MgKHZpYVxuICAvLyAgICAgIGlubGluZURlcGVuZGVuY3lTdW1tYXJpZXMsIHNhbWUgcGF0aCBwbGFuLXNsaWNlIHVzZXMpIEFORCB0aGUgc3RvcmVkXG4gIC8vICAgICAgc2tldGNoX3Njb3BlIHByZXBlbmRlZCBhcyBhIGhhcmQtY29uc3RyYWludCBibG9jayAoZXNjYWxhdGlvbi1mcmVlXG4gIC8vICAgICAgUGhhc2UgMSBjb250cmFjdCkuXG4gIC8vXG4gIC8vIFRoaXMgaXMgdGhlIGNvcmUgdmFsdWUgcHJvcG9zaXRpb24gb2YgQURSLTAxMTogcmVmaW5lIGFnYWluc3QgdGhlIGxhdGVzdFxuICAvLyBjb2RlYmFzZSBzdGF0ZSArIHVwc3RyZWFtIGZpbmRpbmdzLCBub3QgdGhlIGJsYW5rIHNuYXBzaG90IGZyb20gaW5pdGlhbFxuICAvLyBwbGFuLW1pbGVzdG9uZS4gSWYgZWl0aGVyIHBpZWNlIGlzIG1pc3NpbmcsIHRoZSByZWZpbmUgZmxvdyBoYXMgcmVncmVzc2VkLlxuICBjb25zdCBvcmlnaW5hbEN3ZCA9IHByb2Nlc3MuY3dkKCk7XG4gIGNvbnN0IGJhc2UgPSBtYWtlRml4dHVyZUJhc2UoKTtcbiAgdC5hZnRlcigoKSA9PiBjbGVhbnVwKGJhc2UsIG9yaWdpbmFsQ3dkKSk7XG5cbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpKTtcbiAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJJbnRlZ3JhdGlvbiB0ZXN0IG1pbGVzdG9uZVwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSk7XG4gIGluc2VydFNsaWNlKHtcbiAgICBpZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJGb3VuZGF0aW9uXCIsXG4gICAgc3RhdHVzOiBcImNvbXBsZXRlXCIsIHJpc2s6IFwiaGlnaFwiLCBkZXBlbmRzOiBbXSwgc2VxdWVuY2U6IDEsXG4gICAgaXNTa2V0Y2g6IGZhbHNlLFxuICB9KTtcbiAgaW5zZXJ0U2xpY2Uoe1xuICAgIGlkOiBcIlMwMlwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHRpdGxlOiBcIkZlYXR1cmUgYnVpbHQgb24gZm91bmRhdGlvblwiLFxuICAgIHN0YXR1czogXCJwZW5kaW5nXCIsIHJpc2s6IFwibWVkaXVtXCIsIGRlcGVuZHM6IFtcIlMwMVwiXSwgc2VxdWVuY2U6IDIsXG4gICAgaXNTa2V0Y2g6IHRydWUsXG4gICAgc2tldGNoU2NvcGU6IFwiRmVhdHVyZSBYIGluIG1vZHVsZSBZIG9ubHk7IGRvIG5vdCByZWZhY3RvciB0aGUgZm91bmRhdGlvbi5cIixcbiAgfSk7XG4gIGluc2VydFNsaWNlKHtcbiAgICBpZDogXCJTMDNcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJQb2xpc2hcIixcbiAgICBzdGF0dXM6IFwicGVuZGluZ1wiLCByaXNrOiBcImxvd1wiLCBkZXBlbmRzOiBbXCJTMDJcIl0sIHNlcXVlbmNlOiAzLFxuICAgIGlzU2tldGNoOiB0cnVlLFxuICAgIHNrZXRjaFNjb3BlOiBcIlBvbGlzaCArIGRvY3MgZm9yIEZlYXR1cmUgWC5cIixcbiAgfSk7XG5cbiAgLy8gTWluaW1hbCByb2FkbWFwIHNvIGlubGluZVJvYWRtYXBFeGNlcnB0IGhhcyBzb21ldGhpbmcgdG8gcmVhZC5cbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwiUk9BRE1BUC5tZFwiKSxcbiAgICBbXG4gICAgICBcIiMgTTAwMTogSW50ZWdyYXRpb24gdGVzdCBtaWxlc3RvbmVcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFNsaWNlc1wiLFxuICAgICAgXCJcIixcbiAgICAgIFwiLSBbeF0gKipTMDE6IEZvdW5kYXRpb24qKiBgcmlzazpoaWdoYCBgZGVwZW5kczpbXWBcIixcbiAgICAgIFwiLSBbIF0gKipTMDI6IEZlYXR1cmUgYnVpbHQgb24gZm91bmRhdGlvbioqIGByaXNrOm1lZGl1bWAgYGRlcGVuZHM6W1MwMV1gXCIsXG4gICAgICBcIi0gWyBdICoqUzAzOiBQb2xpc2gqKiBgcmlzazpsb3dgIGBkZXBlbmRzOltTMDJdYFwiLFxuICAgICAgXCJcIixcbiAgICBdLmpvaW4oXCJcXG5cIiksXG4gICk7XG5cbiAgLy8gV3JpdGUgUzAxIGFydGlmYWN0cyBcdTIwMTQgdGhlIFNVTU1BUlkgY2FycmllcyBmaW5kaW5ncyB0aGF0IFMwMidzIHJlZmluZSBwYXNzXG4gIC8vIG11c3QgaW5jb3Jwb3JhdGUuIFRoZSBzcGVjaWZpYyBtYXJrZXJzIGJlbG93IGFyZSB3aGF0IHRoZSBhc3NlcnRpb24gcGlucy5cbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIsIFwiUzAxLVBMQU4ubWRcIiksXG4gICAgXCIjIFMwMSBQbGFuXFxuXCIsXG4gICk7XG4gIGNvbnN0IHMwMUZpbmRpbmdzID0gW1xuICAgIFwiIyBTMDEgU3VtbWFyeVwiLFxuICAgIFwiXCIsXG4gICAgXCIjIyBGaW5kaW5nc1wiLFxuICAgIFwiXCIsXG4gICAgXCItIEZJTkRJTkctTUFSS0VSLUFVVEg6IGNob3NlIEpXVCBvdmVyIHNlc3Npb25zIGZvciBzdGF0ZWxlc3NuZXNzLlwiLFxuICAgIFwiLSBGSU5ESU5HLU1BUktFUi1EQjogc2NoZW1hIHYxNyBtaWdyYXRpb24gcmVxdWlyZWQgYmVmb3JlIFMwMiBjYW4gc2FmZWx5IGFkZCB0aGUgZmVhdHVyZSB0YWJsZS5cIixcbiAgICBcIlwiLFxuICAgIFwiIyMgS2V5IERlY2lzaW9uc1wiLFxuICAgIFwiXCIsXG4gICAgXCItIERvIG5vdCBpbnRyb2R1Y2UgYSBiYWNrZ3JvdW5kIHdvcmtlciB5ZXQgXHUyMDE0IHByZW1hdHVyZS5cIixcbiAgXS5qb2luKFwiXFxuXCIpO1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIiwgXCJTMDEtU1VNTUFSWS5tZFwiKSxcbiAgICBzMDFGaW5kaW5ncyxcbiAgKTtcblxuICB3cml0ZVByZWZlcmVuY2VzKGJhc2UsIFwicGhhc2VzOlxcbiAgcHJvZ3Jlc3NpdmVfcGxhbm5pbmc6IHRydWVcIik7XG4gIHByb2Nlc3MuY2hkaXIoYmFzZSk7XG5cbiAgLy8gQnVpbGQgdGhlIHJlZmluZSBwcm9tcHQgZm9yIFMwMiBcdTIwMTQgdGhlIHNhbWUgY2FsbCB0aGUgcmVmaW5pbmctcGhhc2VcbiAgLy8gZGlzcGF0Y2ggcnVsZSB3b3VsZCBtYWtlIGluIHByb2R1Y3Rpb24uXG4gIGNvbnN0IHsgYnVpbGRSZWZpbmVTbGljZVByb21wdCB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vYXV0by1wcm9tcHRzLnRzXCIpO1xuICBjb25zdCBwcm9tcHQgPSBhd2FpdCBidWlsZFJlZmluZVNsaWNlUHJvbXB0KFxuICAgIFwiTTAwMVwiLCBcIkludGVncmF0aW9uIHRlc3QgbWlsZXN0b25lXCIsIFwiUzAyXCIsIFwiRmVhdHVyZSBidWlsdCBvbiBmb3VuZGF0aW9uXCIsIGJhc2UsXG4gICk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwIFNrZXRjaCBzY29wZSBpbmplY3RlZCBhcyBhIGhhcmQgY29uc3RyYWludCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgYXNzZXJ0Lm1hdGNoKFxuICAgIHByb21wdCxcbiAgICAvIyMgU2tldGNoIFNjb3BlIFxcKGhhcmQgY29uc3RyYWludFxcKS8sXG4gICAgXCJyZWZpbmUgcHJvbXB0IG11c3QgZnJhbWUgc2tldGNoX3Njb3BlIGFzIGEgaGFyZCBjb25zdHJhaW50XCIsXG4gICk7XG4gIGFzc2VydC5tYXRjaChcbiAgICBwcm9tcHQsXG4gICAgL0ZlYXR1cmUgWCBpbiBtb2R1bGUgWSBvbmx5LyxcbiAgICBcInJlZmluZSBwcm9tcHQgbXVzdCBpbmNsdWRlIHRoZSBzdG9yZWQgc2tldGNoX3Njb3BlIHRleHQgdmVyYmF0aW1cIixcbiAgKTtcblxuICAvLyBcdTI1MDBcdTI1MDAgUHJpb3Igc2xpY2UgZmluZGluZ3MgY2FycmllZCBmb3J3YXJkIGZyb20gUzAxLVNVTU1BUlkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGFzc2VydC5tYXRjaChcbiAgICBwcm9tcHQsXG4gICAgL0ZJTkRJTkctTUFSS0VSLUFVVEgvLFxuICAgIFwiUzAxJ3MgYXV0aCBmaW5kaW5nIG11c3Qgc3VyZmFjZSBpbiB0aGUgUzAyIHJlZmluZSBwcm9tcHRcIixcbiAgKTtcbiAgYXNzZXJ0Lm1hdGNoKFxuICAgIHByb21wdCxcbiAgICAvRklORElORy1NQVJLRVItREIvLFxuICAgIFwiUzAxJ3MgREIgZmluZGluZyBtdXN0IHN1cmZhY2UgaW4gdGhlIFMwMiByZWZpbmUgcHJvbXB0XCIsXG4gICk7XG4gIGFzc2VydC5tYXRjaChcbiAgICBwcm9tcHQsXG4gICAgL1MwMSBTdW1tYXJ5LyxcbiAgICBcImlubGluZURlcGVuZGVuY3lTdW1tYXJpZXMgbXVzdCBsYWJlbCB0aGUgaW5qZWN0ZWQgYmxvY2sgd2l0aCBTMDEncyBzZWN0aW9uIGhlYWRlclwiLFxuICApO1xuXG4gIC8vIFx1MjUwMFx1MjUwMCBOb3QgdGhlIHN0YWxlIGJsYW5rLXNsYXRlIHBsYW4tc2xpY2UgZnJhbWluZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgLy8gVGhlIHJlZmluZSBwcm9tcHQgaXMgYSAqdHJhbnNmb3JtYXRpb24qLCBub3QgYSBibGFuay1zaGVldCBwbGFuLiBQaW4gdGhlXG4gIC8vIGRpc3RpbmN0aW9uIHNvIGZ1dHVyZSBwcm9tcHQgZWRpdHMgZG9uJ3Qgc2lsZW50bHkgY29sbGFwc2UgdGhlIHR3byBwYXRocy5cbiAgYXNzZXJ0LmRvZXNOb3RNYXRjaChcbiAgICBwcm9tcHQsXG4gICAgL1ByaW9yIFNrZXRjaCBTY29wZSBcXChzb2Z0IGhpbnQgXHUyMDE0IG5vbi1iaW5kaW5nXFwpLyxcbiAgICBcInJlZmluZSBwcm9tcHQgbXVzdCBOT1QgdXNlIHRoZSBzb2Z0LWhpbnQgZnJhbWluZyAodGhhdCdzIHRoZSBwbGFuLXNsaWNlIGZsYWctb2ZmIGRvd25ncmFkZSlcIixcbiAgKTtcbn0pO1xuXG50ZXN0KFwiQURSLTAxMSBQMyAjMjY6IHJlZmluZS1zbGljZSBkaXNwYXRjaCBsYXRlbmN5IGlzIGJvdW5kZWQgdnMgcGxhbi1zbGljZSBiYXNlbGluZVwiLCBhc3luYyAodCkgPT4ge1xuICAvLyBQaW5zIHRoZSBaeWxvcyAyMDI2IHJlc2VhcmNoIGNsYWltIHRoYXQgcHJvZ3Jlc3NpdmUgcGxhbm5pbmcgdHJhZGVzIGFcbiAgLy8gc21hbGwgZGlzcGF0Y2gtdGltZSBjb3N0IGZvciBzaWduaWZpY2FudCBwbGFuIHF1YWxpdHkuIFRoZSByZWZpbmUgcGF0aFxuICAvLyBkb2VzIGV4dHJhIHdvcms6IGl0IHJlYWRzIHNrZXRjaF9zY29wZSBmcm9tIHRoZSBEQiBhbmQgaW5saW5lcyB0aGVcbiAgLy8gZGVwZW5kZW5jeSBzdW1tYXJpZXMuIE5laXRoZXIgb3BlcmF0aW9uIHNob3VsZCBkb21pbmF0ZSB0aGUgcHJvbXB0IGJ1aWxkLlxuICAvL1xuICAvLyBBYnNvbHV0ZTogPCA1MDBtcyB3YWxsIGNsb2NrLiBSZWxhdGl2ZTogPCAzeCBwbGFuLXNsaWNlIGJhc2VsaW5lLlxuICAvLyBCb3RoIGJvdW5kcyBhcmUgZGVsaWJlcmF0ZWx5IGdlbmVyb3VzIFx1MjAxNCB0aGlzIHRlc3QgaXMgYSByZWdyZXNzaW9uIGdhdGUsXG4gIC8vIG5vdCBhIGJlbmNobWFyay4gVGhlIGdvYWwgaXMgY2F0Y2hpbmcgYWNjaWRlbnRhbCBPKE4pIGZzIHdhbGtzIG9yIERCXG4gIC8vIHF1ZXJpZXMgdGhhdCB3b3VsZCBtdWx0aXBseSBkaXNwYXRjaCB0aW1lIGFzIG1pbGVzdG9uZXMgZ3Jvdy5cbiAgY29uc3Qgb3JpZ2luYWxDd2QgPSBwcm9jZXNzLmN3ZCgpO1xuICBjb25zdCBiYXNlID0gbWFrZUZpeHR1cmVCYXNlKCk7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChiYXNlLCBvcmlnaW5hbEN3ZCkpO1xuXG4gIHNlZWRNaWxlc3RvbmVXaXRoU2tldGNoZWRTMDIoYmFzZSk7XG4gIHdyaXRlUzAxQXJ0aWZhY3RzKGJhc2UpO1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJST0FETUFQLm1kXCIpLFxuICAgIFtcbiAgICAgIFwiIyBNMDAxOiBUZXN0XCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBTbGljZXNcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIi0gW3hdICoqUzAxOiBGb3VuZGF0aW9uKiogYHJpc2s6aGlnaGAgYGRlcGVuZHM6W11gXCIsXG4gICAgICBcIi0gWyBdICoqUzAyOiBGZWF0dXJlKiogYHJpc2s6bWVkaXVtYCBgZGVwZW5kczpbUzAxXWBcIixcbiAgICAgIFwiXCIsXG4gICAgXS5qb2luKFwiXFxuXCIpLFxuICApO1xuICB3cml0ZVByZWZlcmVuY2VzKGJhc2UsIFwicGhhc2VzOlxcbiAgcHJvZ3Jlc3NpdmVfcGxhbm5pbmc6IHRydWVcIik7XG4gIHByb2Nlc3MuY2hkaXIoYmFzZSk7XG5cbiAgY29uc3QgeyBidWlsZFJlZmluZVNsaWNlUHJvbXB0LCBidWlsZFBsYW5TbGljZVByb21wdCB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vYXV0by1wcm9tcHRzLnRzXCIpO1xuXG4gIC8vIFdhcm0tdXAgcGFzcyBcdTIwMTQgZmlyc3QgY2FsbCBsb2FkcyB0aGUgcHJvbXB0IHRlbXBsYXRlIGZyb20gZGlzayBhbmQgcHJpbWVzXG4gIC8vIGZzL0RCIGNhY2hlcy4gTWVhc3VyaW5nIHRoZSBjb2xkIHBhdGggd291bGQgYmUgbm9pc3kgYW5kIG1pc2xlYWRpbmcuXG4gIGF3YWl0IGJ1aWxkUGxhblNsaWNlUHJvbXB0KFwiTTAwMVwiLCBcIlRlc3RcIiwgXCJTMDJcIiwgXCJGZWF0dXJlXCIsIGJhc2UpO1xuICBhd2FpdCBidWlsZFJlZmluZVNsaWNlUHJvbXB0KFwiTTAwMVwiLCBcIlRlc3RcIiwgXCJTMDJcIiwgXCJGZWF0dXJlXCIsIGJhc2UpO1xuXG4gIGNvbnN0IG1lYXN1cmUgPSBhc3luYyAoZm46ICgpID0+IFByb21pc2U8c3RyaW5nPik6IFByb21pc2U8bnVtYmVyPiA9PiB7XG4gICAgY29uc3Qgc3RhcnQgPSBwZXJmb3JtYW5jZS5ub3coKTtcbiAgICBhd2FpdCBmbigpO1xuICAgIHJldHVybiBwZXJmb3JtYW5jZS5ub3coKSAtIHN0YXJ0O1xuICB9O1xuXG4gIGNvbnN0IHBsYW5TYW1wbGVzOiBudW1iZXJbXSA9IFtdO1xuICBjb25zdCByZWZpbmVTYW1wbGVzOiBudW1iZXJbXSA9IFtdO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IDU7IGkrKykge1xuICAgIHBsYW5TYW1wbGVzLnB1c2goYXdhaXQgbWVhc3VyZSgoKSA9PiBidWlsZFBsYW5TbGljZVByb21wdChcIk0wMDFcIiwgXCJUZXN0XCIsIFwiUzAyXCIsIFwiRmVhdHVyZVwiLCBiYXNlKSkpO1xuICAgIHJlZmluZVNhbXBsZXMucHVzaChhd2FpdCBtZWFzdXJlKCgpID0+IGJ1aWxkUmVmaW5lU2xpY2VQcm9tcHQoXCJNMDAxXCIsIFwiVGVzdFwiLCBcIlMwMlwiLCBcIkZlYXR1cmVcIiwgYmFzZSkpKTtcbiAgfVxuICBjb25zdCBiZXN0UGxhbiA9IE1hdGgubWluKC4uLnBsYW5TYW1wbGVzKTtcbiAgY29uc3QgYmVzdFJlZmluZSA9IE1hdGgubWluKC4uLnJlZmluZVNhbXBsZXMpO1xuXG4gIGFzc2VydC5vayhcbiAgICBiZXN0UmVmaW5lIDwgNTAwLFxuICAgIGByZWZpbmUtc2xpY2UgcHJvbXB0IGJ1aWxkIG11c3QgY29tcGxldGUgdW5kZXIgNTAwbXMgKGJlc3Q9JHtiZXN0UmVmaW5lLnRvRml4ZWQoMSl9bXMsIHNhbXBsZXM9JHtyZWZpbmVTYW1wbGVzLm1hcChuID0+IG4udG9GaXhlZCgxKSkuam9pbihcIixcIil9KWAsXG4gICk7XG4gIC8vIEd1YXJkIHRoZSByYXRpbyBvbmx5IHdoZW4gdGhlIGJhc2VsaW5lIGlzIGxhcmdlIGVub3VnaCB0byBiZSBtZWFuaW5nZnVsIFx1MjAxNFxuICAvLyBpZiBwbGFuLXNsaWNlIG1lYXN1cmVzIGluIHNpbmdsZS1kaWdpdCBtaWxsaXNlY29uZHMsIHRoZSByYXRpbyBpcyBkb21pbmF0ZWRcbiAgLy8gYnkgc2NoZWR1bGVyIGFuZCBmaWxlc3lzdGVtIG5vaXNlIHVuZGVyIHRoZSBjb25jdXJyZW50IHRlc3QgcnVubmVyLlxuICBpZiAoYmVzdFBsYW4gPj0gMjApIHtcbiAgICBhc3NlcnQub2soXG4gICAgICBiZXN0UmVmaW5lIDwgYmVzdFBsYW4gKiAzLFxuICAgICAgYHJlZmluZS1zbGljZSBtdXN0IG5vdCBleGNlZWQgM3ggcGxhbi1zbGljZSBiYXNlbGluZSAocmVmaW5lPSR7YmVzdFJlZmluZS50b0ZpeGVkKDEpfW1zLCBwbGFuPSR7YmVzdFBsYW4udG9GaXhlZCgxKX1tcylgLFxuICAgICk7XG4gIH1cbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBR0EsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUNuQixTQUFTLGFBQWEsV0FBVyxRQUFRLHFCQUFxQjtBQUM5RCxTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsbUJBQW1CO0FBRTVCO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFD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
