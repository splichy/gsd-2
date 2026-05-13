import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { invalidateStateCache, deriveStateFromDb, getActiveMilestoneId } from "../state.js";
import {
  openDatabase,
  closeDatabase,
  insertAssessment,
  insertMilestone,
  insertRequirement,
  insertSlice,
  insertTask,
  setMilestoneQueueOrder
} from "../gsd-db.js";
function createFixtureBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-helpers-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}
function writeFile(base, relativePath, content) {
  const full = join(base, ".gsd", relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}
function cleanup(base) {
  rmSync(base, { recursive: true, force: true });
}
const ROADMAP_CONTENT = `# M001: Test Milestone

**Vision:** Test helpers.

## Slices

- [ ] **S01: First Slice** \`risk:low\` \`depends:[]\`
  > After this: Slice done.

- [ ] **S02: Second Slice** \`risk:low\` \`depends:[S01]\`
  > After this: All done.
`;
const PLAN_CONTENT = `# S01: First Slice

**Goal:** Test executing.
**Demo:** Tests pass.

## Tasks

- [ ] **T01: First Task** \`est:10m\`
  First task description.

- [x] **T02: Done Task** \`est:10m\`
  Already done.
`;
describe("derive-state-helpers", () => {
  test("handleNoActiveMilestone: all milestones parked returns pre-planning with unpark hint", async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, "milestones/M001/M001-CONTEXT.md", "# M001\n\nContext.");
      writeFile(base, "milestones/M001/M001-PARKED.md", "Parked.");
      writeFile(base, "milestones/M002/M002-CONTEXT.md", "# M002\n\nContext.");
      writeFile(base, "milestones/M002/M002-PARKED.md", "Also parked.");
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "First", status: "parked" });
      insertMilestone({ id: "M002", title: "Second", status: "parked" });
      invalidateStateCache();
      const state = await deriveStateFromDb(base);
      assert.equal(state.phase, "pre-planning", "all-parked: phase is pre-planning");
      assert.equal(state.activeMilestone, null, "all-parked: no active milestone");
      assert.ok(state.nextAction.includes("parked"), "all-parked: nextAction mentions parked");
      assert.ok(state.nextAction.includes("unpark"), "all-parked: nextAction hints unpark");
      assert.equal(state.registry.length, 2, "all-parked: both in registry");
      assert.ok(state.registry.every((e) => e.status === "parked"), "all-parked: all registry entries parked");
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("handleNoActiveMilestone: all complete with unmapped requirements", async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, "milestones/M001/M001-SUMMARY.md", "# M001 Summary\n\nDone.");
      writeFile(base, "REQUIREMENTS.md", `# Requirements

## Active

### R001 \u2014 Unmapped
- Status: active
- Description: Not mapped.
`);
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "First", status: "complete" });
      insertRequirement({
        id: "R001",
        class: "functional",
        status: "active",
        description: "Unmapped",
        why: "test",
        source: "test",
        primary_owner: "",
        supporting_slices: "",
        validation: "",
        notes: "",
        full_content: "",
        superseded_by: null
      });
      invalidateStateCache();
      const state = await deriveStateFromDb(base);
      assert.equal(state.phase, "complete", "complete-reqs: phase is complete");
      assert.ok(state.nextAction.includes("1 active requirement"), "complete-reqs: nextAction notes unmapped reqs");
      assert.equal(state.requirements?.active, 1, "complete-reqs: requirements.active = 1");
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("resolveSliceDependencies: GSD_SLICE_LOCK pointing to non-existent slice returns blocked", async () => {
    const base = createFixtureBase();
    const origLock = process.env.GSD_SLICE_LOCK;
    const origWorker = process.env.GSD_PARALLEL_WORKER;
    try {
      writeFile(base, "milestones/M001/M001-ROADMAP.md", ROADMAP_CONTENT);
      writeFile(base, "milestones/M001/slices/S01/S01-PLAN.md", PLAN_CONTENT);
      writeFile(base, "milestones/M001/slices/S01/tasks/.gitkeep", "");
      writeFile(base, "milestones/M001/slices/S01/tasks/T01-PLAN.md", "# T01 Plan");
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "First", status: "active", risk: "low", depends: [] });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "First Task", status: "pending" });
      process.env.GSD_SLICE_LOCK = "S99";
      process.env.GSD_PARALLEL_WORKER = "1";
      invalidateStateCache();
      const state = await deriveStateFromDb(base);
      assert.equal(state.phase, "blocked", "slice-lock-miss: phase is blocked");
      assert.ok(state.blockers.some((b) => b.includes("GSD_SLICE_LOCK=S99")), "slice-lock-miss: blocker mentions lock");
    } finally {
      if (origLock !== void 0) process.env.GSD_SLICE_LOCK = origLock;
      else delete process.env.GSD_SLICE_LOCK;
      if (origWorker !== void 0) process.env.GSD_PARALLEL_WORKER = origWorker;
      else delete process.env.GSD_PARALLEL_WORKER;
      closeDatabase();
      cleanup(base);
    }
  });
  test("resolveSliceDependencies: GSD_SLICE_LOCK targeting valid slice bypasses deps", async () => {
    const base = createFixtureBase();
    const origLock = process.env.GSD_SLICE_LOCK;
    const origWorker = process.env.GSD_PARALLEL_WORKER;
    try {
      writeFile(base, "milestones/M001/M001-ROADMAP.md", ROADMAP_CONTENT);
      writeFile(base, "milestones/M001/slices/S02/S02-PLAN.md", `# S02

**Goal:** Test.
**Demo:** Pass.

## Tasks

- [ ] **T01: Task** \`est:5m\`
  Do thing.
`);
      writeFile(base, "milestones/M001/slices/S02/tasks/.gitkeep", "");
      writeFile(base, "milestones/M001/slices/S02/tasks/T01-PLAN.md", "# T01 Plan");
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "First", status: "pending", risk: "low", depends: [] });
      insertSlice({ id: "S02", milestoneId: "M001", title: "Second", status: "pending", risk: "low", depends: ["S01"] });
      insertTask({ id: "T01", sliceId: "S02", milestoneId: "M001", title: "Task", status: "pending" });
      process.env.GSD_SLICE_LOCK = "S02";
      process.env.GSD_PARALLEL_WORKER = "1";
      invalidateStateCache();
      const state = await deriveStateFromDb(base);
      assert.equal(state.activeSlice?.id, "S02", "slice-lock-valid: activeSlice is S02 (locked)");
      assert.equal(state.phase, "executing", "slice-lock-valid: phase is executing");
    } finally {
      if (origLock !== void 0) process.env.GSD_SLICE_LOCK = origLock;
      else delete process.env.GSD_SLICE_LOCK;
      if (origWorker !== void 0) process.env.GSD_PARALLEL_WORKER = origWorker;
      else delete process.env.GSD_PARALLEL_WORKER;
      closeDatabase();
      cleanup(base);
    }
  });
  test("deriveStateFromDb: DB-empty task list does not import PLAN tasks", async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, "milestones/M001/M001-ROADMAP.md", ROADMAP_CONTENT);
      writeFile(base, "milestones/M001/slices/S01/S01-PLAN.md", PLAN_CONTENT);
      writeFile(base, "milestones/M001/slices/S01/tasks/.gitkeep", "");
      writeFile(base, "milestones/M001/slices/S01/tasks/T01-PLAN.md", "# T01 Plan");
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "First", status: "active", risk: "low", depends: [] });
      insertSlice({ id: "S02", milestoneId: "M001", title: "Second", status: "pending", risk: "low", depends: ["S01"] });
      invalidateStateCache();
      const state = await deriveStateFromDb(base);
      assert.equal(state.phase, "planning", "db-empty-tasks: phase is planning");
      assert.equal(state.activeTask, null, "db-empty-tasks: no active task");
      assert.equal(state.progress?.tasks?.total, 0, "db-empty-tasks: no tasks imported");
      assert.equal(state.progress?.tasks?.done, 0, "db-empty-tasks: no completed tasks imported");
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("deriveStateFromDb: disk SUMMARY does not reconcile pending task", async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, "milestones/M001/M001-ROADMAP.md", ROADMAP_CONTENT);
      writeFile(base, "milestones/M001/slices/S01/S01-PLAN.md", PLAN_CONTENT);
      writeFile(base, "milestones/M001/slices/S01/tasks/.gitkeep", "");
      writeFile(base, "milestones/M001/slices/S01/tasks/T01-PLAN.md", "# T01 Plan");
      writeFile(base, "milestones/M001/slices/S01/tasks/T01-SUMMARY.md", "# T01 Summary\n\nDone on disk.");
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "First", status: "active", risk: "low", depends: [] });
      insertSlice({ id: "S02", milestoneId: "M001", title: "Second", status: "pending", risk: "low", depends: ["S01"] });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "First Task", status: "pending" });
      insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Done Task", status: "complete" });
      invalidateStateCache();
      const state = await deriveStateFromDb(base);
      assert.equal(state.phase, "executing", "disk-summary-ignored: phase is executing");
      assert.equal(state.activeTask?.id, "T01", "disk-summary-ignored: T01 remains active");
      assert.equal(state.progress?.tasks?.done, 1, "disk-summary-ignored: only DB-complete task is done");
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("detectBlockers: task with blocker_discovered triggers replanning-slice", async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, "milestones/M001/M001-ROADMAP.md", ROADMAP_CONTENT);
      writeFile(base, "milestones/M001/slices/S01/S01-PLAN.md", PLAN_CONTENT);
      writeFile(base, "milestones/M001/slices/S01/tasks/.gitkeep", "");
      writeFile(base, "milestones/M001/slices/S01/tasks/T01-PLAN.md", "# T01 Plan");
      writeFile(
        base,
        "milestones/M001/slices/S01/tasks/T02-SUMMARY.md",
        "---\nblocker_discovered: true\n---\n\n# T02 Summary\n\nFound a blocker."
      );
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "First", status: "active", risk: "low", depends: [] });
      insertSlice({ id: "S02", milestoneId: "M001", title: "Second", status: "pending", risk: "low", depends: ["S01"] });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "First Task", status: "pending" });
      insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Done Task", status: "complete", blockerDiscovered: true });
      invalidateStateCache();
      const state = await deriveStateFromDb(base);
      assert.equal(state.phase, "replanning-slice", "blocker: phase is replanning-slice");
      assert.ok(state.blockers.some((b) => b.includes("T02")), "blocker: blockers mention T02");
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("deriveStateFromDb: continue.md projection does not trigger resume nextAction", async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, "milestones/M001/M001-ROADMAP.md", ROADMAP_CONTENT);
      writeFile(base, "milestones/M001/slices/S01/S01-PLAN.md", PLAN_CONTENT);
      writeFile(base, "milestones/M001/slices/S01/tasks/.gitkeep", "");
      writeFile(base, "milestones/M001/slices/S01/tasks/T01-PLAN.md", "# T01 Plan");
      writeFile(base, "milestones/M001/slices/S01/S01-CONTINUE.md", "Resume from here.");
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "First", status: "active", risk: "low", depends: [] });
      insertSlice({ id: "S02", milestoneId: "M001", title: "Second", status: "pending", risk: "low", depends: ["S01"] });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "First Task", status: "pending" });
      insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Done Task", status: "complete" });
      invalidateStateCache();
      const state = await deriveStateFromDb(base);
      assert.equal(state.phase, "executing", "continue: phase is still executing");
      assert.ok(!state.nextAction.includes("Resume interrupted work"), "continue: nextAction does not mention resume");
      assert.ok(!state.nextAction.includes("continue.md"), "continue: nextAction does not mention continue.md");
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("buildCompletenessSet: DB status=complete marks milestone complete", async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, "milestones/M001/M001-ROADMAP.md", ROADMAP_CONTENT);
      writeFile(base, "milestones/M001/M001-SUMMARY.md", "# M001 Summary\n\nDone.");
      writeFile(base, "milestones/M002/M002-CONTEXT.md", "# M002\n\nActive.");
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "First", status: "complete" });
      insertMilestone({ id: "M002", title: "Second", status: "active" });
      invalidateStateCache();
      const state = await deriveStateFromDb(base);
      const m1 = state.registry.find((e) => e.id === "M001");
      assert.equal(m1?.status, "complete", "DB status=complete \u2192 registry entry complete");
      assert.equal(state.activeMilestone?.id, "M002", "M002 is the active milestone");
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("buildCompletenessSet (#4179): orphan SUMMARY on disk does not mark DB-active milestone complete", async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, "milestones/M001/M001-ROADMAP.md", ROADMAP_CONTENT);
      writeFile(base, "milestones/M001/M001-SUMMARY.md", "# M001 Orphan Summary\n\nLeft over from crashed turn.");
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "First", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "First", status: "active", risk: "low", depends: [] });
      insertSlice({ id: "S02", milestoneId: "M001", title: "Second", status: "pending", risk: "low", depends: ["S01"] });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "In-flight", status: "pending" });
      invalidateStateCache();
      const state = await deriveStateFromDb(base);
      const m1 = state.registry.find((e) => e.id === "M001");
      assert.notEqual(m1?.status, "complete", "orphan SUMMARY must not mark milestone complete");
      assert.equal(m1?.status, "active", "M001 remains active \u2014 DB is authoritative");
      assert.equal(state.activeMilestone?.id, "M001", "M001 is still the active milestone");
      assert.notEqual(state.phase, "completing-milestone", "must not short-circuit into completion");
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("buildRegistryAndFindActive (#4179): orphan SUMMARY with validation-terminal falls through to completing-milestone", async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, "milestones/M001/M001-ROADMAP.md", ROADMAP_CONTENT);
      writeFile(base, "milestones/M001/slices/S01/S01-PLAN.md", PLAN_CONTENT);
      writeFile(base, "milestones/M001/slices/S02/S02-PLAN.md", PLAN_CONTENT);
      writeFile(base, "milestones/M001/M001-VALIDATION.md", "---\nverdict: passed\n---\n# Validation\nAll good.");
      writeFile(base, "milestones/M001/M001-SUMMARY.md", "# M001 Orphan Summary\n\nLeft over.");
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "First", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "First", status: "complete", risk: "low", depends: [] });
      insertSlice({ id: "S02", milestoneId: "M001", title: "Second", status: "complete", risk: "low", depends: ["S01"] });
      insertAssessment({
        path: "milestones/M001/M001-VALIDATION.md",
        milestoneId: "M001",
        status: "pass",
        scope: "milestone-validation",
        fullContent: "verdict: passed"
      });
      invalidateStateCache();
      const state = await deriveStateFromDb(base);
      const m1 = state.registry.find((e) => e.id === "M001");
      assert.equal(m1?.status, "active", "M001 stays active despite orphan SUMMARY + validation-terminal");
      assert.equal(state.activeMilestone?.id, "M001", "M001 is still the active milestone");
      assert.equal(state.phase, "completing-milestone", "phase flows through completing-milestone (re-run)");
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("deriveStateFromDb: ROADMAP slices missing from DB are not auto-inserted", async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, "milestones/M001/M001-ROADMAP.md", ROADMAP_CONTENT);
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "Test", status: "active" });
      invalidateStateCache();
      const state = await deriveStateFromDb(base);
      assert.equal(state.activeMilestone?.id, "M001", "roadmap-projection: M001 is active");
      assert.equal(state.activeSlice, null, "roadmap-projection: no active slice imported");
      assert.equal(state.phase, "pre-planning", "roadmap-projection: no DB slices routes to pre-planning");
      assert.equal(state.progress?.slices, void 0, "roadmap-projection: no slice progress from projection");
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("deriveStateFromDb ignores QUEUE-ORDER.json and uses DB sequence", async () => {
    const base = createFixtureBase();
    try {
      const queueOrder = JSON.stringify({ order: ["M003", "M001", "M002"], updatedAt: (/* @__PURE__ */ new Date()).toISOString() });
      writeFileSync(join(base, ".gsd", "QUEUE-ORDER.json"), queueOrder);
      writeFile(base, "milestones/M001/M001-CONTEXT.md", "# M001\n\nContext.");
      writeFile(base, "milestones/M002/M002-CONTEXT.md", "# M002\n\nContext.");
      writeFile(base, "milestones/M003/M003-CONTEXT.md", "# M003\n\nContext.");
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "First", status: "active" });
      insertMilestone({ id: "M002", title: "Second", status: "active" });
      insertMilestone({ id: "M003", title: "Third", status: "active" });
      setMilestoneQueueOrder(["M002", "M001", "M003"]);
      invalidateStateCache();
      const state = await deriveStateFromDb(base);
      assert.equal(state.activeMilestone?.id, "M002", "queue-order: DB sequence chooses M002");
      assert.equal(state.registry[0]?.id, "M002", "queue-order: registry[0] follows DB sequence");
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("getActiveMilestoneId: DB lock path ignores PARKED flag projection", async () => {
    const base = createFixtureBase();
    const previousLock = process.env.GSD_MILESTONE_LOCK;
    const previousWorker = process.env.GSD_PARALLEL_WORKER;
    try {
      process.env.GSD_MILESTONE_LOCK = "M001";
      process.env.GSD_PARALLEL_WORKER = "1";
      writeFile(base, "milestones/M001/M001-PARKED.md", "# Parked on disk");
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "Active in DB", status: "active" });
      const id = await getActiveMilestoneId(base);
      assert.equal(id, "M001", "DB status remains authoritative despite PARKED projection");
    } finally {
      if (previousLock === void 0) delete process.env.GSD_MILESTONE_LOCK;
      else process.env.GSD_MILESTONE_LOCK = previousLock;
      if (previousWorker === void 0) delete process.env.GSD_PARALLEL_WORKER;
      else process.env.GSD_PARALLEL_WORKER = previousWorker;
      closeDatabase();
      cleanup(base);
    }
  });
  test("handleAllSlicesDone: needs-remediation with all slices done returns blocked", async () => {
    const base = createFixtureBase();
    try {
      const doneRoadmap = `# M001: Remediation Test

**Vision:** Test.

## Slices

- [x] **S01: Done** \`risk:low\` \`depends:[]\`
  > Done.
`;
      writeFile(base, "milestones/M001/M001-ROADMAP.md", doneRoadmap);
      writeFile(
        base,
        "milestones/M001/M001-VALIDATION.md",
        "---\nverdict: needs-remediation\nremediation_round: 1\n---\n\n# Validation\nNeeds remediation."
      );
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "Remediation Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "Done", status: "complete", risk: "low", depends: [] });
      insertAssessment({
        path: "milestones/M001/M001-VALIDATION.md",
        milestoneId: "M001",
        status: "needs-remediation",
        scope: "milestone-validation",
        fullContent: "verdict: needs-remediation"
      });
      invalidateStateCache();
      const state = await deriveStateFromDb(base);
      assert.equal(state.phase, "blocked", "remediation-stuck: phase is blocked (no infinite re-dispatch)");
      assert.equal(state.activeMilestone?.id, "M001", "remediation-stuck: activeMilestone is M001");
      assert.ok(
        state.blockers.some((b) => b.includes("needs-remediation") && b.includes("M001")),
        "remediation-stuck: blocker message mentions milestone and verdict"
      );
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("buildRegistryAndFindActive: queued shell deferred, later real milestone becomes active (#3470)", async () => {
    const base = createFixtureBase();
    try {
      mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
      writeFile(base, "milestones/M002/M002-CONTEXT.md", "# M002: Real\n\nActive milestone.");
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "Shell", status: "queued" });
      insertMilestone({ id: "M002", title: "Real", status: "active" });
      invalidateStateCache();
      const state = await deriveStateFromDb(base);
      assert.equal(state.activeMilestone?.id, "M002", "deferred-shell: M002 is active (shell deferred)");
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9kZXJpdmUtc3RhdGUtaGVscGVycy50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBHU0QgRXh0ZW5zaW9uIFx1MjAxNCBUZXN0cyBmb3IgREItYXV0aG9yaXRhdGl2ZSBkZXJpdmVTdGF0ZUZyb21EYiBiZWhhdmlvclxuLy8gQ29weXJpZ2h0IChjKSAyMDI2IEplcmVteSBNY1NwYWRkZW4gPGplcmVteUBmbHV4bGFicy5uZXQ+XG4vL1xuLy8gUHJpdmF0ZSBoZWxwZXIgYmVoYXZpb3IgaXMgZXhlcmNpc2VkIHRocm91Z2ggZGVyaXZlU3RhdGVGcm9tRGIgaW50ZWdyYXRpb24uXG4vLyBNYXJrZG93biBmaWxlcyBpbiB0aGVzZSB0ZXN0cyBhcmUgcHJvamVjdGlvbnMgdW5sZXNzIHRoZSBEQiByb3cgZXhwbGljaXRseVxuLy8gbWFrZXMgdGhlbSBhdXRob3JpdGF0aXZlLlxuXG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCwgYmVmb3JlRWFjaCwgYWZ0ZXJFYWNoIH0gZnJvbSAnbm9kZTp0ZXN0JztcbmltcG9ydCBhc3NlcnQgZnJvbSAnbm9kZTphc3NlcnQvc3RyaWN0JztcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBta2RpclN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gJ25vZGU6ZnMnO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gJ25vZGU6cGF0aCc7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tICdub2RlOm9zJztcblxuaW1wb3J0IHsgaW52YWxpZGF0ZVN0YXRlQ2FjaGUsIGRlcml2ZVN0YXRlRnJvbURiLCBnZXRBY3RpdmVNaWxlc3RvbmVJZCB9IGZyb20gJy4uL3N0YXRlLnRzJztcbmltcG9ydCB7XG4gIG9wZW5EYXRhYmFzZSxcbiAgY2xvc2VEYXRhYmFzZSxcbiAgaW5zZXJ0QXNzZXNzbWVudCxcbiAgaW5zZXJ0TWlsZXN0b25lLFxuICBpbnNlcnRSZXF1aXJlbWVudCxcbiAgaW5zZXJ0U2xpY2UsXG4gIGluc2VydFRhc2ssXG4gIHNldE1pbGVzdG9uZVF1ZXVlT3JkZXIsXG4gIHVwZGF0ZVRhc2tTdGF0dXMsXG59IGZyb20gJy4uL2dzZC1kYi50cyc7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBGaXh0dXJlIEhlbHBlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIGNyZWF0ZUZpeHR1cmVCYXNlKCk6IHN0cmluZyB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCAnZ3NkLWhlbHBlcnMtJykpO1xuICBta2RpclN5bmMoam9pbihiYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICByZXR1cm4gYmFzZTtcbn1cblxuZnVuY3Rpb24gd3JpdGVGaWxlKGJhc2U6IHN0cmluZywgcmVsYXRpdmVQYXRoOiBzdHJpbmcsIGNvbnRlbnQ6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBmdWxsID0gam9pbihiYXNlLCAnLmdzZCcsIHJlbGF0aXZlUGF0aCk7XG4gIG1rZGlyU3luYyhqb2luKGZ1bGwsICcuLicpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhmdWxsLCBjb250ZW50KTtcbn1cblxuZnVuY3Rpb24gY2xlYW51cChiYXNlOiBzdHJpbmcpOiB2b2lkIHtcbiAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbn1cblxuY29uc3QgUk9BRE1BUF9DT05URU5UID0gYCMgTTAwMTogVGVzdCBNaWxlc3RvbmVcblxuKipWaXNpb246KiogVGVzdCBoZWxwZXJzLlxuXG4jIyBTbGljZXNcblxuLSBbIF0gKipTMDE6IEZpcnN0IFNsaWNlKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbXVxcYFxuICA+IEFmdGVyIHRoaXM6IFNsaWNlIGRvbmUuXG5cbi0gWyBdICoqUzAyOiBTZWNvbmQgU2xpY2UqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltTMDFdXFxgXG4gID4gQWZ0ZXIgdGhpczogQWxsIGRvbmUuXG5gO1xuXG5jb25zdCBQTEFOX0NPTlRFTlQgPSBgIyBTMDE6IEZpcnN0IFNsaWNlXG5cbioqR29hbDoqKiBUZXN0IGV4ZWN1dGluZy5cbioqRGVtbzoqKiBUZXN0cyBwYXNzLlxuXG4jIyBUYXNrc1xuXG4tIFsgXSAqKlQwMTogRmlyc3QgVGFzayoqIFxcYGVzdDoxMG1cXGBcbiAgRmlyc3QgdGFzayBkZXNjcmlwdGlvbi5cblxuLSBbeF0gKipUMDI6IERvbmUgVGFzayoqIFxcYGVzdDoxMG1cXGBcbiAgQWxyZWFkeSBkb25lLlxuYDtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBUZXN0c1xuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbmRlc2NyaWJlKCdkZXJpdmUtc3RhdGUtaGVscGVycycsICgpID0+IHtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgaGFuZGxlTm9BY3RpdmVNaWxlc3RvbmU6IGFsbCBwYXJrZWQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIHRlc3QoJ2hhbmRsZU5vQWN0aXZlTWlsZXN0b25lOiBhbGwgbWlsZXN0b25lcyBwYXJrZWQgcmV0dXJucyBwcmUtcGxhbm5pbmcgd2l0aCB1bnBhcmsgaGludCcsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvTTAwMS1DT05URVhULm1kJywgJyMgTTAwMVxcblxcbkNvbnRleHQuJyk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9NMDAxLVBBUktFRC5tZCcsICdQYXJrZWQuJyk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMi9NMDAyLUNPTlRFWFQubWQnLCAnIyBNMDAyXFxuXFxuQ29udGV4dC4nKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAyL00wMDItUEFSS0VELm1kJywgJ0Fsc28gcGFya2VkLicpO1xuXG4gICAgICBvcGVuRGF0YWJhc2UoJzptZW1vcnk6Jyk7XG4gICAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogJ00wMDEnLCB0aXRsZTogJ0ZpcnN0Jywgc3RhdHVzOiAncGFya2VkJyB9KTtcbiAgICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiAnTTAwMicsIHRpdGxlOiAnU2Vjb25kJywgc3RhdHVzOiAncGFya2VkJyB9KTtcblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGVGcm9tRGIoYmFzZSk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5waGFzZSwgJ3ByZS1wbGFubmluZycsICdhbGwtcGFya2VkOiBwaGFzZSBpcyBwcmUtcGxhbm5pbmcnKTtcbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5hY3RpdmVNaWxlc3RvbmUsIG51bGwsICdhbGwtcGFya2VkOiBubyBhY3RpdmUgbWlsZXN0b25lJyk7XG4gICAgICBhc3NlcnQub2soc3RhdGUubmV4dEFjdGlvbi5pbmNsdWRlcygncGFya2VkJyksICdhbGwtcGFya2VkOiBuZXh0QWN0aW9uIG1lbnRpb25zIHBhcmtlZCcpO1xuICAgICAgYXNzZXJ0Lm9rKHN0YXRlLm5leHRBY3Rpb24uaW5jbHVkZXMoJ3VucGFyaycpLCAnYWxsLXBhcmtlZDogbmV4dEFjdGlvbiBoaW50cyB1bnBhcmsnKTtcbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5yZWdpc3RyeS5sZW5ndGgsIDIsICdhbGwtcGFya2VkOiBib3RoIGluIHJlZ2lzdHJ5Jyk7XG4gICAgICBhc3NlcnQub2soc3RhdGUucmVnaXN0cnkuZXZlcnkoZSA9PiBlLnN0YXR1cyA9PT0gJ3BhcmtlZCcpLCAnYWxsLXBhcmtlZDogYWxsIHJlZ2lzdHJ5IGVudHJpZXMgcGFya2VkJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgaGFuZGxlTm9BY3RpdmVNaWxlc3RvbmU6IGFsbCBjb21wbGV0ZSB3aXRoIGFjdGl2ZSByZXF1aXJlbWVudHMgXHUyNTAwXHUyNTAwXG4gIHRlc3QoJ2hhbmRsZU5vQWN0aXZlTWlsZXN0b25lOiBhbGwgY29tcGxldGUgd2l0aCB1bm1hcHBlZCByZXF1aXJlbWVudHMnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL00wMDEtU1VNTUFSWS5tZCcsICcjIE0wMDEgU3VtbWFyeVxcblxcbkRvbmUuJyk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ1JFUVVJUkVNRU5UUy5tZCcsIGAjIFJlcXVpcmVtZW50c1xcblxcbiMjIEFjdGl2ZVxcblxcbiMjIyBSMDAxIFx1MjAxNCBVbm1hcHBlZFxcbi0gU3RhdHVzOiBhY3RpdmVcXG4tIERlc2NyaXB0aW9uOiBOb3QgbWFwcGVkLlxcbmApO1xuXG4gICAgICBvcGVuRGF0YWJhc2UoJzptZW1vcnk6Jyk7XG4gICAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogJ00wMDEnLCB0aXRsZTogJ0ZpcnN0Jywgc3RhdHVzOiAnY29tcGxldGUnIH0pO1xuICAgICAgaW5zZXJ0UmVxdWlyZW1lbnQoe1xuICAgICAgICBpZDogJ1IwMDEnLFxuICAgICAgICBjbGFzczogJ2Z1bmN0aW9uYWwnLFxuICAgICAgICBzdGF0dXM6ICdhY3RpdmUnLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ1VubWFwcGVkJyxcbiAgICAgICAgd2h5OiAndGVzdCcsXG4gICAgICAgIHNvdXJjZTogJ3Rlc3QnLFxuICAgICAgICBwcmltYXJ5X293bmVyOiAnJyxcbiAgICAgICAgc3VwcG9ydGluZ19zbGljZXM6ICcnLFxuICAgICAgICB2YWxpZGF0aW9uOiAnJyxcbiAgICAgICAgbm90ZXM6ICcnLFxuICAgICAgICBmdWxsX2NvbnRlbnQ6ICcnLFxuICAgICAgICBzdXBlcnNlZGVkX2J5OiBudWxsLFxuICAgICAgfSk7XG5cbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlRnJvbURiKGJhc2UpO1xuXG4gICAgICBhc3NlcnQuZXF1YWwoc3RhdGUucGhhc2UsICdjb21wbGV0ZScsICdjb21wbGV0ZS1yZXFzOiBwaGFzZSBpcyBjb21wbGV0ZScpO1xuICAgICAgYXNzZXJ0Lm9rKHN0YXRlLm5leHRBY3Rpb24uaW5jbHVkZXMoJzEgYWN0aXZlIHJlcXVpcmVtZW50JyksICdjb21wbGV0ZS1yZXFzOiBuZXh0QWN0aW9uIG5vdGVzIHVubWFwcGVkIHJlcXMnKTtcbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5yZXF1aXJlbWVudHM/LmFjdGl2ZSwgMSwgJ2NvbXBsZXRlLXJlcXM6IHJlcXVpcmVtZW50cy5hY3RpdmUgPSAxJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgcmVzb2x2ZVNsaWNlRGVwZW5kZW5jaWVzOiBHU0RfU0xJQ0VfTE9DSyB3aXRoIG1pc3Npbmcgc2xpY2UgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cdCAgdGVzdCgncmVzb2x2ZVNsaWNlRGVwZW5kZW5jaWVzOiBHU0RfU0xJQ0VfTE9DSyBwb2ludGluZyB0byBub24tZXhpc3RlbnQgc2xpY2UgcmV0dXJucyBibG9ja2VkJywgYXN5bmMgKCkgPT4ge1xuXHQgICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG5cdCAgICBjb25zdCBvcmlnTG9jayA9IHByb2Nlc3MuZW52LkdTRF9TTElDRV9MT0NLO1xuXHQgICAgY29uc3Qgb3JpZ1dvcmtlciA9IHByb2Nlc3MuZW52LkdTRF9QQVJBTExFTF9XT1JLRVI7XG5cdCAgICB0cnkge1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvTTAwMS1ST0FETUFQLm1kJywgUk9BRE1BUF9DT05URU5UKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvUzAxLVBMQU4ubWQnLCBQTEFOX0NPTlRFTlQpO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMS90YXNrcy8uZ2l0a2VlcCcsICcnKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvdGFza3MvVDAxLVBMQU4ubWQnLCAnIyBUMDEgUGxhbicpO1xuXG4gICAgICBvcGVuRGF0YWJhc2UoJzptZW1vcnk6Jyk7XG4gICAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogJ00wMDEnLCB0aXRsZTogJ1Rlc3QnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuICAgICAgaW5zZXJ0U2xpY2UoeyBpZDogJ1MwMScsIG1pbGVzdG9uZUlkOiAnTTAwMScsIHRpdGxlOiAnRmlyc3QnLCBzdGF0dXM6ICdhY3RpdmUnLCByaXNrOiAnbG93JywgZGVwZW5kczogW10gfSk7XG4gICAgICBpbnNlcnRUYXNrKHsgaWQ6ICdUMDEnLCBzbGljZUlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdGaXJzdCBUYXNrJywgc3RhdHVzOiAncGVuZGluZycgfSk7XG5cblx0ICAgICAgcHJvY2Vzcy5lbnYuR1NEX1NMSUNFX0xPQ0sgPSAnUzk5Jztcblx0ICAgICAgcHJvY2Vzcy5lbnYuR1NEX1BBUkFMTEVMX1dPUktFUiA9ICcxJztcblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGVGcm9tRGIoYmFzZSk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5waGFzZSwgJ2Jsb2NrZWQnLCAnc2xpY2UtbG9jay1taXNzOiBwaGFzZSBpcyBibG9ja2VkJyk7XG4gICAgICBhc3NlcnQub2soc3RhdGUuYmxvY2tlcnMuc29tZShiID0+IGIuaW5jbHVkZXMoJ0dTRF9TTElDRV9MT0NLPVM5OScpKSwgJ3NsaWNlLWxvY2stbWlzczogYmxvY2tlciBtZW50aW9ucyBsb2NrJyk7XG5cdCAgICB9IGZpbmFsbHkge1xuXHQgICAgICBpZiAob3JpZ0xvY2sgIT09IHVuZGVmaW5lZCkgcHJvY2Vzcy5lbnYuR1NEX1NMSUNFX0xPQ0sgPSBvcmlnTG9jaztcblx0ICAgICAgZWxzZSBkZWxldGUgcHJvY2Vzcy5lbnYuR1NEX1NMSUNFX0xPQ0s7XG5cdCAgICAgIGlmIChvcmlnV29ya2VyICE9PSB1bmRlZmluZWQpIHByb2Nlc3MuZW52LkdTRF9QQVJBTExFTF9XT1JLRVIgPSBvcmlnV29ya2VyO1xuXHQgICAgICBlbHNlIGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfUEFSQUxMRUxfV09SS0VSO1xuXHQgICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHJlc29sdmVTbGljZURlcGVuZGVuY2llczogR1NEX1NMSUNFX0xPQ0sgd2l0aCB2YWxpZCBzbGljZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblx0ICB0ZXN0KCdyZXNvbHZlU2xpY2VEZXBlbmRlbmNpZXM6IEdTRF9TTElDRV9MT0NLIHRhcmdldGluZyB2YWxpZCBzbGljZSBieXBhc3NlcyBkZXBzJywgYXN5bmMgKCkgPT4ge1xuXHQgICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG5cdCAgICBjb25zdCBvcmlnTG9jayA9IHByb2Nlc3MuZW52LkdTRF9TTElDRV9MT0NLO1xuXHQgICAgY29uc3Qgb3JpZ1dvcmtlciA9IHByb2Nlc3MuZW52LkdTRF9QQVJBTExFTF9XT1JLRVI7XG5cdCAgICB0cnkge1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvTTAwMS1ST0FETUFQLm1kJywgUk9BRE1BUF9DT05URU5UKTtcbiAgICAgIC8vIFMwMiBkZXBlbmRzIG9uIFMwMSBidXQgd2UgbG9jayB0byBTMDIgZGlyZWN0bHlcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDIvUzAyLVBMQU4ubWQnLCBgIyBTMDJcXG5cXG4qKkdvYWw6KiogVGVzdC5cXG4qKkRlbW86KiogUGFzcy5cXG5cXG4jIyBUYXNrc1xcblxcbi0gWyBdICoqVDAxOiBUYXNrKiogXFxgZXN0OjVtXFxgXFxuICBEbyB0aGluZy5cXG5gKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDIvdGFza3MvLmdpdGtlZXAnLCAnJyk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzAyL3Rhc2tzL1QwMS1QTEFOLm1kJywgJyMgVDAxIFBsYW4nKTtcblxuICAgICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuICAgICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdUZXN0Jywgc3RhdHVzOiAnYWN0aXZlJyB9KTtcbiAgICAgIGluc2VydFNsaWNlKHsgaWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ0ZpcnN0Jywgc3RhdHVzOiAncGVuZGluZycsIHJpc2s6ICdsb3cnLCBkZXBlbmRzOiBbXSB9KTtcbiAgICAgIGluc2VydFNsaWNlKHsgaWQ6ICdTMDInLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ1NlY29uZCcsIHN0YXR1czogJ3BlbmRpbmcnLCByaXNrOiAnbG93JywgZGVwZW5kczogWydTMDEnXSB9KTtcbiAgICAgIGluc2VydFRhc2soeyBpZDogJ1QwMScsIHNsaWNlSWQ6ICdTMDInLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ1Rhc2snLCBzdGF0dXM6ICdwZW5kaW5nJyB9KTtcblxuXHQgICAgICBwcm9jZXNzLmVudi5HU0RfU0xJQ0VfTE9DSyA9ICdTMDInO1xuXHQgICAgICBwcm9jZXNzLmVudi5HU0RfUEFSQUxMRUxfV09SS0VSID0gJzEnO1xuXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZUZyb21EYihiYXNlKTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLmFjdGl2ZVNsaWNlPy5pZCwgJ1MwMicsICdzbGljZS1sb2NrLXZhbGlkOiBhY3RpdmVTbGljZSBpcyBTMDIgKGxvY2tlZCknKTtcbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5waGFzZSwgJ2V4ZWN1dGluZycsICdzbGljZS1sb2NrLXZhbGlkOiBwaGFzZSBpcyBleGVjdXRpbmcnKTtcblx0ICAgIH0gZmluYWxseSB7XG5cdCAgICAgIGlmIChvcmlnTG9jayAhPT0gdW5kZWZpbmVkKSBwcm9jZXNzLmVudi5HU0RfU0xJQ0VfTE9DSyA9IG9yaWdMb2NrO1xuXHQgICAgICBlbHNlIGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfU0xJQ0VfTE9DSztcblx0ICAgICAgaWYgKG9yaWdXb3JrZXIgIT09IHVuZGVmaW5lZCkgcHJvY2Vzcy5lbnYuR1NEX1BBUkFMTEVMX1dPUktFUiA9IG9yaWdXb3JrZXI7XG5cdCAgICAgIGVsc2UgZGVsZXRlIHByb2Nlc3MuZW52LkdTRF9QQVJBTExFTF9XT1JLRVI7XG5cdCAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgREItYXV0aG9yaXRhdGl2ZSB0YXNrczogcGxhbiBwcm9qZWN0aW9uIGRvZXMgbm90IGltcG9ydCB0YXNrcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgdGVzdCgnZGVyaXZlU3RhdGVGcm9tRGI6IERCLWVtcHR5IHRhc2sgbGlzdCBkb2VzIG5vdCBpbXBvcnQgUExBTiB0YXNrcycsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvTTAwMS1ST0FETUFQLm1kJywgUk9BRE1BUF9DT05URU5UKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvUzAxLVBMQU4ubWQnLCBQTEFOX0NPTlRFTlQpO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMS90YXNrcy8uZ2l0a2VlcCcsICcnKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvdGFza3MvVDAxLVBMQU4ubWQnLCAnIyBUMDEgUGxhbicpO1xuXG4gICAgICBvcGVuRGF0YWJhc2UoJzptZW1vcnk6Jyk7XG4gICAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogJ00wMDEnLCB0aXRsZTogJ1Rlc3QnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuICAgICAgaW5zZXJ0U2xpY2UoeyBpZDogJ1MwMScsIG1pbGVzdG9uZUlkOiAnTTAwMScsIHRpdGxlOiAnRmlyc3QnLCBzdGF0dXM6ICdhY3RpdmUnLCByaXNrOiAnbG93JywgZGVwZW5kczogW10gfSk7XG4gICAgICBpbnNlcnRTbGljZSh7IGlkOiAnUzAyJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdTZWNvbmQnLCBzdGF0dXM6ICdwZW5kaW5nJywgcmlzazogJ2xvdycsIGRlcGVuZHM6IFsnUzAxJ10gfSk7XG4gICAgICAvLyBObyB0YXNrcyBpbnNlcnRlZCBcdTIwMTQgUExBTi5tZCBpcyBhIHByb2plY3Rpb24gYW5kIG11c3Qgbm90IGJlIGltcG9ydGVkLlxuXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZUZyb21EYihiYXNlKTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLnBoYXNlLCAncGxhbm5pbmcnLCAnZGItZW1wdHktdGFza3M6IHBoYXNlIGlzIHBsYW5uaW5nJyk7XG4gICAgICBhc3NlcnQuZXF1YWwoc3RhdGUuYWN0aXZlVGFzaywgbnVsbCwgJ2RiLWVtcHR5LXRhc2tzOiBubyBhY3RpdmUgdGFzaycpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLnByb2dyZXNzPy50YXNrcz8udG90YWwsIDAsICdkYi1lbXB0eS10YXNrczogbm8gdGFza3MgaW1wb3J0ZWQnKTtcbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5wcm9ncmVzcz8udGFza3M/LmRvbmUsIDAsICdkYi1lbXB0eS10YXNrczogbm8gY29tcGxldGVkIHRhc2tzIGltcG9ydGVkJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgREItYXV0aG9yaXRhdGl2ZSB0YXNrczogU1VNTUFSWSBwcm9qZWN0aW9uIGRvZXMgbm90IGNvbXBsZXRlIHRhc2sgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIHRlc3QoJ2Rlcml2ZVN0YXRlRnJvbURiOiBkaXNrIFNVTU1BUlkgZG9lcyBub3QgcmVjb25jaWxlIHBlbmRpbmcgdGFzaycsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvTTAwMS1ST0FETUFQLm1kJywgUk9BRE1BUF9DT05URU5UKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvUzAxLVBMQU4ubWQnLCBQTEFOX0NPTlRFTlQpO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMS90YXNrcy8uZ2l0a2VlcCcsICcnKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvdGFza3MvVDAxLVBMQU4ubWQnLCAnIyBUMDEgUGxhbicpO1xuICAgICAgLy8gVDAxIGhhcyBhIHN1bW1hcnkgb24gZGlzayBidXQgREIgc3RpbGwgc2F5cyBwZW5kaW5nXG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzAxL3Rhc2tzL1QwMS1TVU1NQVJZLm1kJywgJyMgVDAxIFN1bW1hcnlcXG5cXG5Eb25lIG9uIGRpc2suJyk7XG5cbiAgICAgIG9wZW5EYXRhYmFzZSgnOm1lbW9yeTonKTtcbiAgICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiAnTTAwMScsIHRpdGxlOiAnVGVzdCcsIHN0YXR1czogJ2FjdGl2ZScgfSk7XG4gICAgICBpbnNlcnRTbGljZSh7IGlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdGaXJzdCcsIHN0YXR1czogJ2FjdGl2ZScsIHJpc2s6ICdsb3cnLCBkZXBlbmRzOiBbXSB9KTtcbiAgICAgIGluc2VydFNsaWNlKHsgaWQ6ICdTMDInLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ1NlY29uZCcsIHN0YXR1czogJ3BlbmRpbmcnLCByaXNrOiAnbG93JywgZGVwZW5kczogWydTMDEnXSB9KTtcbiAgICAgIGluc2VydFRhc2soeyBpZDogJ1QwMScsIHNsaWNlSWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ0ZpcnN0IFRhc2snLCBzdGF0dXM6ICdwZW5kaW5nJyB9KTtcbiAgICAgIGluc2VydFRhc2soeyBpZDogJ1QwMicsIHNsaWNlSWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ0RvbmUgVGFzaycsIHN0YXR1czogJ2NvbXBsZXRlJyB9KTtcblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGVGcm9tRGIoYmFzZSk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5waGFzZSwgJ2V4ZWN1dGluZycsICdkaXNrLXN1bW1hcnktaWdub3JlZDogcGhhc2UgaXMgZXhlY3V0aW5nJyk7XG4gICAgICBhc3NlcnQuZXF1YWwoc3RhdGUuYWN0aXZlVGFzaz8uaWQsICdUMDEnLCAnZGlzay1zdW1tYXJ5LWlnbm9yZWQ6IFQwMSByZW1haW5zIGFjdGl2ZScpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLnByb2dyZXNzPy50YXNrcz8uZG9uZSwgMSwgJ2Rpc2stc3VtbWFyeS1pZ25vcmVkOiBvbmx5IERCLWNvbXBsZXRlIHRhc2sgaXMgZG9uZScpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGRldGVjdEJsb2NrZXJzOiBibG9ja2VyX2Rpc2NvdmVyZWQgdHJpZ2dlcnMgcmVwbGFubmluZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgdGVzdCgnZGV0ZWN0QmxvY2tlcnM6IHRhc2sgd2l0aCBibG9ja2VyX2Rpc2NvdmVyZWQgdHJpZ2dlcnMgcmVwbGFubmluZy1zbGljZScsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvTTAwMS1ST0FETUFQLm1kJywgUk9BRE1BUF9DT05URU5UKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvUzAxLVBMQU4ubWQnLCBQTEFOX0NPTlRFTlQpO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMS90YXNrcy8uZ2l0a2VlcCcsICcnKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvdGFza3MvVDAxLVBMQU4ubWQnLCAnIyBUMDEgUGxhbicpO1xuICAgICAgLy8gVDAyIGNvbXBsZXRlZCB3aXRoIGJsb2NrZXIgZGlzY292ZXJlZC4gVGhlIGRpc2sgc3VtbWFyeSBpcyBhIHByb2plY3Rpb247XG4gICAgICAvLyBvbmx5IHRoZSBEQiBibG9ja2VyIGZsYWcgaXMgYXV0aG9yaXRhdGl2ZSBmb3IgZGVyaXZlU3RhdGVGcm9tRGIoKS5cbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvdGFza3MvVDAyLVNVTU1BUlkubWQnLFxuICAgICAgICAnLS0tXFxuYmxvY2tlcl9kaXNjb3ZlcmVkOiB0cnVlXFxuLS0tXFxuXFxuIyBUMDIgU3VtbWFyeVxcblxcbkZvdW5kIGEgYmxvY2tlci4nKTtcblxuICAgICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuICAgICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdUZXN0Jywgc3RhdHVzOiAnYWN0aXZlJyB9KTtcbiAgICAgIGluc2VydFNsaWNlKHsgaWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ0ZpcnN0Jywgc3RhdHVzOiAnYWN0aXZlJywgcmlzazogJ2xvdycsIGRlcGVuZHM6IFtdIH0pO1xuICAgICAgaW5zZXJ0U2xpY2UoeyBpZDogJ1MwMicsIG1pbGVzdG9uZUlkOiAnTTAwMScsIHRpdGxlOiAnU2Vjb25kJywgc3RhdHVzOiAncGVuZGluZycsIHJpc2s6ICdsb3cnLCBkZXBlbmRzOiBbJ1MwMSddIH0pO1xuICAgICAgaW5zZXJ0VGFzayh7IGlkOiAnVDAxJywgc2xpY2VJZDogJ1MwMScsIG1pbGVzdG9uZUlkOiAnTTAwMScsIHRpdGxlOiAnRmlyc3QgVGFzaycsIHN0YXR1czogJ3BlbmRpbmcnIH0pO1xuICAgICAgaW5zZXJ0VGFzayh7IGlkOiAnVDAyJywgc2xpY2VJZDogJ1MwMScsIG1pbGVzdG9uZUlkOiAnTTAwMScsIHRpdGxlOiAnRG9uZSBUYXNrJywgc3RhdHVzOiAnY29tcGxldGUnLCBibG9ja2VyRGlzY292ZXJlZDogdHJ1ZSB9KTtcblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGVGcm9tRGIoYmFzZSk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5waGFzZSwgJ3JlcGxhbm5pbmctc2xpY2UnLCAnYmxvY2tlcjogcGhhc2UgaXMgcmVwbGFubmluZy1zbGljZScpO1xuICAgICAgYXNzZXJ0Lm9rKHN0YXRlLmJsb2NrZXJzLnNvbWUoYiA9PiBiLmluY2x1ZGVzKCdUMDInKSksICdibG9ja2VyOiBibG9ja2VycyBtZW50aW9uIFQwMicpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIENPTlRJTlVFLm1kIHByb2plY3Rpb24gaXMgaWdub3JlZCBieSBEQiBkZXJpdmUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIHRlc3QoJ2Rlcml2ZVN0YXRlRnJvbURiOiBjb250aW51ZS5tZCBwcm9qZWN0aW9uIGRvZXMgbm90IHRyaWdnZXIgcmVzdW1lIG5leHRBY3Rpb24nLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL00wMDEtUk9BRE1BUC5tZCcsIFJPQURNQVBfQ09OVEVOVCk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzAxL1MwMS1QTEFOLm1kJywgUExBTl9DT05URU5UKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvdGFza3MvLmdpdGtlZXAnLCAnJyk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzAxL3Rhc2tzL1QwMS1QTEFOLm1kJywgJyMgVDAxIFBsYW4nKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvUzAxLUNPTlRJTlVFLm1kJywgJ1Jlc3VtZSBmcm9tIGhlcmUuJyk7XG5cbiAgICAgIG9wZW5EYXRhYmFzZSgnOm1lbW9yeTonKTtcbiAgICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiAnTTAwMScsIHRpdGxlOiAnVGVzdCcsIHN0YXR1czogJ2FjdGl2ZScgfSk7XG4gICAgICBpbnNlcnRTbGljZSh7IGlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdGaXJzdCcsIHN0YXR1czogJ2FjdGl2ZScsIHJpc2s6ICdsb3cnLCBkZXBlbmRzOiBbXSB9KTtcbiAgICAgIGluc2VydFNsaWNlKHsgaWQ6ICdTMDInLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ1NlY29uZCcsIHN0YXR1czogJ3BlbmRpbmcnLCByaXNrOiAnbG93JywgZGVwZW5kczogWydTMDEnXSB9KTtcbiAgICAgIGluc2VydFRhc2soeyBpZDogJ1QwMScsIHNsaWNlSWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ0ZpcnN0IFRhc2snLCBzdGF0dXM6ICdwZW5kaW5nJyB9KTtcbiAgICAgIGluc2VydFRhc2soeyBpZDogJ1QwMicsIHNsaWNlSWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ0RvbmUgVGFzaycsIHN0YXR1czogJ2NvbXBsZXRlJyB9KTtcblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGVGcm9tRGIoYmFzZSk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5waGFzZSwgJ2V4ZWN1dGluZycsICdjb250aW51ZTogcGhhc2UgaXMgc3RpbGwgZXhlY3V0aW5nJyk7XG4gICAgICBhc3NlcnQub2soIXN0YXRlLm5leHRBY3Rpb24uaW5jbHVkZXMoJ1Jlc3VtZSBpbnRlcnJ1cHRlZCB3b3JrJyksICdjb250aW51ZTogbmV4dEFjdGlvbiBkb2VzIG5vdCBtZW50aW9uIHJlc3VtZScpO1xuICAgICAgYXNzZXJ0Lm9rKCFzdGF0ZS5uZXh0QWN0aW9uLmluY2x1ZGVzKCdjb250aW51ZS5tZCcpLCAnY29udGludWU6IG5leHRBY3Rpb24gZG9lcyBub3QgbWVudGlvbiBjb250aW51ZS5tZCcpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGJ1aWxkQ29tcGxldGVuZXNzU2V0OiBEQiBzdGF0dXMgaXMgYXV0aG9yaXRhdGl2ZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgdGVzdCgnYnVpbGRDb21wbGV0ZW5lc3NTZXQ6IERCIHN0YXR1cz1jb21wbGV0ZSBtYXJrcyBtaWxlc3RvbmUgY29tcGxldGUnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL00wMDEtUk9BRE1BUC5tZCcsIFJPQURNQVBfQ09OVEVOVCk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9NMDAxLVNVTU1BUlkubWQnLCAnIyBNMDAxIFN1bW1hcnlcXG5cXG5Eb25lLicpO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDIvTTAwMi1DT05URVhULm1kJywgJyMgTTAwMlxcblxcbkFjdGl2ZS4nKTtcblxuICAgICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuICAgICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdGaXJzdCcsIHN0YXR1czogJ2NvbXBsZXRlJyB9KTtcbiAgICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiAnTTAwMicsIHRpdGxlOiAnU2Vjb25kJywgc3RhdHVzOiAnYWN0aXZlJyB9KTtcblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGVGcm9tRGIoYmFzZSk7XG5cbiAgICAgIGNvbnN0IG0xID0gc3RhdGUucmVnaXN0cnkuZmluZChlID0+IGUuaWQgPT09ICdNMDAxJyk7XG4gICAgICBhc3NlcnQuZXF1YWwobTE/LnN0YXR1cywgJ2NvbXBsZXRlJywgJ0RCIHN0YXR1cz1jb21wbGV0ZSBcdTIxOTIgcmVnaXN0cnkgZW50cnkgY29tcGxldGUnKTtcbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5hY3RpdmVNaWxlc3RvbmU/LmlkLCAnTTAwMicsICdNMDAyIGlzIHRoZSBhY3RpdmUgbWlsZXN0b25lJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgUmVncmVzc2lvbiAjNDE3OTogb3JwaGFuIFNVTU1BUlkgbXVzdCBOT1QgZmxpcCBEQi1hY3RpdmUgbWlsZXN0b25lIFx1MjUwMFx1MjUwMFx1MjUwMFxuICAvLyBBIGNyYXNoZWQgY29tcGxldGUtbWlsZXN0b25lIHR1cm4gKG9yIHN0YWxlL21hbnVhbCBTVU1NQVJZLm1kKSBjYW4gbGVhdmVcbiAgLy8gYSBtaWxlc3RvbmUgU1VNTUFSWSBvbiBkaXNrIHdoaWxlIHRoZSBEQiByb3cgc3RpbGwgcmVhZHMgJ2FjdGl2ZScuIFRoZVxuICAvLyByZWFkLXNpZGUgb2Ygc3RhdGUgZGVyaXZhdGlvbiBtdXN0IE5PVCB0cmVhdCB0aGUgb3JwaGFuIFNVTU1BUlkgYXMgYVxuICAvLyBjb21wbGV0aW9uIHNpZ25hbCwgb3IgdGhlIGF1dG8tbG9vcCBhZHZhbmNlcyBhbmQgbWVyZ2VzIHdvcmsgdGhhdCB3YXNcbiAgLy8gbmV2ZXIgYWN0dWFsbHkgZmluaXNoZWQgKHNhbWUgZmFpbHVyZSBjbGFzcyBhcyAjNDE3NSwgcmVhZC1zaWRlIHR3aW4pLlxuICB0ZXN0KCdidWlsZENvbXBsZXRlbmVzc1NldCAoIzQxNzkpOiBvcnBoYW4gU1VNTUFSWSBvbiBkaXNrIGRvZXMgbm90IG1hcmsgREItYWN0aXZlIG1pbGVzdG9uZSBjb21wbGV0ZScsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvTTAwMS1ST0FETUFQLm1kJywgUk9BRE1BUF9DT05URU5UKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL00wMDEtU1VNTUFSWS5tZCcsICcjIE0wMDEgT3JwaGFuIFN1bW1hcnlcXG5cXG5MZWZ0IG92ZXIgZnJvbSBjcmFzaGVkIHR1cm4uJyk7XG5cbiAgICAgIG9wZW5EYXRhYmFzZSgnOm1lbW9yeTonKTtcbiAgICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiAnTTAwMScsIHRpdGxlOiAnRmlyc3QnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuICAgICAgLy8gU2xpY2Ugc3RpbGwgaW4tZmxpZ2h0IFx1MjAxNCBhdXRvIHNob3VsZCByZXN1bWUsIG5vdCBtZXJnZS5cbiAgICAgIGluc2VydFNsaWNlKHsgaWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ0ZpcnN0Jywgc3RhdHVzOiAnYWN0aXZlJywgcmlzazogJ2xvdycsIGRlcGVuZHM6IFtdIH0pO1xuICAgICAgaW5zZXJ0U2xpY2UoeyBpZDogJ1MwMicsIG1pbGVzdG9uZUlkOiAnTTAwMScsIHRpdGxlOiAnU2Vjb25kJywgc3RhdHVzOiAncGVuZGluZycsIHJpc2s6ICdsb3cnLCBkZXBlbmRzOiBbJ1MwMSddIH0pO1xuICAgICAgaW5zZXJ0VGFzayh7IGlkOiAnVDAxJywgc2xpY2VJZDogJ1MwMScsIG1pbGVzdG9uZUlkOiAnTTAwMScsIHRpdGxlOiAnSW4tZmxpZ2h0Jywgc3RhdHVzOiAncGVuZGluZycgfSk7XG5cbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlRnJvbURiKGJhc2UpO1xuXG4gICAgICBjb25zdCBtMSA9IHN0YXRlLnJlZ2lzdHJ5LmZpbmQoZSA9PiBlLmlkID09PSAnTTAwMScpO1xuICAgICAgYXNzZXJ0Lm5vdEVxdWFsKG0xPy5zdGF0dXMsICdjb21wbGV0ZScsICdvcnBoYW4gU1VNTUFSWSBtdXN0IG5vdCBtYXJrIG1pbGVzdG9uZSBjb21wbGV0ZScpO1xuICAgICAgYXNzZXJ0LmVxdWFsKG0xPy5zdGF0dXMsICdhY3RpdmUnLCAnTTAwMSByZW1haW5zIGFjdGl2ZSBcdTIwMTQgREIgaXMgYXV0aG9yaXRhdGl2ZScpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQsICdNMDAxJywgJ00wMDEgaXMgc3RpbGwgdGhlIGFjdGl2ZSBtaWxlc3RvbmUnKTtcbiAgICAgIGFzc2VydC5ub3RFcXVhbChzdGF0ZS5waGFzZSwgJ2NvbXBsZXRpbmctbWlsZXN0b25lJywgJ211c3Qgbm90IHNob3J0LWNpcmN1aXQgaW50byBjb21wbGV0aW9uJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICAvLyBSZWdyZXNzaW9uICM0MTc5IChjb21wYW5pb24pOiBEQi1hY3RpdmUgbWlsZXN0b25lIHdpdGggYWxsIHNsaWNlcyBkb25lICtcbiAgLy8gdmFsaWRhdGlvbiB0ZXJtaW5hbCArIG9ycGhhbiBTVU1NQVJZIG11c3Qgc3RpbGwgZmxvdyB0aHJvdWdoIGNvbXBsZXRpbmctbWlsZXN0b25lXG4gIC8vIChyZS1ydW5zIGNvbXBsZXRlLW1pbGVzdG9uZSksIG5vdCBiZSByZXBvcnRlZCBhcyBhbHJlYWR5LWNvbXBsZXRlLlxuICB0ZXN0KCdidWlsZFJlZ2lzdHJ5QW5kRmluZEFjdGl2ZSAoIzQxNzkpOiBvcnBoYW4gU1VNTUFSWSB3aXRoIHZhbGlkYXRpb24tdGVybWluYWwgZmFsbHMgdGhyb3VnaCB0byBjb21wbGV0aW5nLW1pbGVzdG9uZScsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvTTAwMS1ST0FETUFQLm1kJywgUk9BRE1BUF9DT05URU5UKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvUzAxLVBMQU4ubWQnLCBQTEFOX0NPTlRFTlQpO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMi9TMDItUExBTi5tZCcsIFBMQU5fQ09OVEVOVCk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9NMDAxLVZBTElEQVRJT04ubWQnLCAnLS0tXFxudmVyZGljdDogcGFzc2VkXFxuLS0tXFxuIyBWYWxpZGF0aW9uXFxuQWxsIGdvb2QuJyk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9NMDAxLVNVTU1BUlkubWQnLCAnIyBNMDAxIE9ycGhhbiBTdW1tYXJ5XFxuXFxuTGVmdCBvdmVyLicpO1xuXG4gICAgICBvcGVuRGF0YWJhc2UoJzptZW1vcnk6Jyk7XG4gICAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogJ00wMDEnLCB0aXRsZTogJ0ZpcnN0Jywgc3RhdHVzOiAnYWN0aXZlJyB9KTtcbiAgICAgIGluc2VydFNsaWNlKHsgaWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ0ZpcnN0Jywgc3RhdHVzOiAnY29tcGxldGUnLCByaXNrOiAnbG93JywgZGVwZW5kczogW10gfSk7XG4gICAgICBpbnNlcnRTbGljZSh7IGlkOiAnUzAyJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdTZWNvbmQnLCBzdGF0dXM6ICdjb21wbGV0ZScsIHJpc2s6ICdsb3cnLCBkZXBlbmRzOiBbJ1MwMSddIH0pO1xuICAgICAgaW5zZXJ0QXNzZXNzbWVudCh7XG4gICAgICAgIHBhdGg6ICdtaWxlc3RvbmVzL00wMDEvTTAwMS1WQUxJREFUSU9OLm1kJyxcbiAgICAgICAgbWlsZXN0b25lSWQ6ICdNMDAxJyxcbiAgICAgICAgc3RhdHVzOiAncGFzcycsXG4gICAgICAgIHNjb3BlOiAnbWlsZXN0b25lLXZhbGlkYXRpb24nLFxuICAgICAgICBmdWxsQ29udGVudDogJ3ZlcmRpY3Q6IHBhc3NlZCcsXG4gICAgICB9KTtcblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGVGcm9tRGIoYmFzZSk7XG5cbiAgICAgIGNvbnN0IG0xID0gc3RhdGUucmVnaXN0cnkuZmluZChlID0+IGUuaWQgPT09ICdNMDAxJyk7XG4gICAgICBhc3NlcnQuZXF1YWwobTE/LnN0YXR1cywgJ2FjdGl2ZScsICdNMDAxIHN0YXlzIGFjdGl2ZSBkZXNwaXRlIG9ycGhhbiBTVU1NQVJZICsgdmFsaWRhdGlvbi10ZXJtaW5hbCcpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQsICdNMDAxJywgJ00wMDEgaXMgc3RpbGwgdGhlIGFjdGl2ZSBtaWxlc3RvbmUnKTtcbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5waGFzZSwgJ2NvbXBsZXRpbmctbWlsZXN0b25lJywgJ3BoYXNlIGZsb3dzIHRocm91Z2ggY29tcGxldGluZy1taWxlc3RvbmUgKHJlLXJ1biknKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBEQi1hdXRob3JpdGF0aXZlIHNsaWNlczogcm9hZG1hcCBwcm9qZWN0aW9uIGRvZXMgbm90IGluc2VydCBzbGljZXMgXHUyNTAwXHUyNTAwXHUyNTAwXG4gIHRlc3QoJ2Rlcml2ZVN0YXRlRnJvbURiOiBST0FETUFQIHNsaWNlcyBtaXNzaW5nIGZyb20gREIgYXJlIG5vdCBhdXRvLWluc2VydGVkJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9NMDAxLVJPQURNQVAubWQnLCBST0FETUFQX0NPTlRFTlQpO1xuXG4gICAgICBvcGVuRGF0YWJhc2UoJzptZW1vcnk6Jyk7XG4gICAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogJ00wMDEnLCB0aXRsZTogJ1Rlc3QnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuICAgICAgLy8gTm8gc2xpY2VzIGluc2VydGVkIFx1MjAxNCBST0FETUFQLm1kIGlzIGEgcHJvamVjdGlvbiBhbmQgbXVzdCBub3QgYmUgaW1wb3J0ZWQuXG5cbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlRnJvbURiKGJhc2UpO1xuXG4gICAgICBhc3NlcnQuZXF1YWwoc3RhdGUuYWN0aXZlTWlsZXN0b25lPy5pZCwgJ00wMDEnLCAncm9hZG1hcC1wcm9qZWN0aW9uOiBNMDAxIGlzIGFjdGl2ZScpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLmFjdGl2ZVNsaWNlLCBudWxsLCAncm9hZG1hcC1wcm9qZWN0aW9uOiBubyBhY3RpdmUgc2xpY2UgaW1wb3J0ZWQnKTtcbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5waGFzZSwgJ3ByZS1wbGFubmluZycsICdyb2FkbWFwLXByb2plY3Rpb246IG5vIERCIHNsaWNlcyByb3V0ZXMgdG8gcHJlLXBsYW5uaW5nJyk7XG4gICAgICBhc3NlcnQuZXF1YWwoc3RhdGUucHJvZ3Jlc3M/LnNsaWNlcywgdW5kZWZpbmVkLCAncm9hZG1hcC1wcm9qZWN0aW9uOiBubyBzbGljZSBwcm9ncmVzcyBmcm9tIHByb2plY3Rpb24nKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBRdWV1ZSBvcmRlcjogREIgc2VxdWVuY2UgaXMgYXV0aG9yaXRhdGl2ZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgdGVzdCgnZGVyaXZlU3RhdGVGcm9tRGIgaWdub3JlcyBRVUVVRS1PUkRFUi5qc29uIGFuZCB1c2VzIERCIHNlcXVlbmNlJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICAvLyBRVUVVRS1PUkRFUi5qc29uIGlzIGEgcHJvamVjdGlvbiBhbmQgc2hvdWxkIG5vdCBkcml2ZSBEQiBkZXJpdmF0aW9uLlxuICAgICAgY29uc3QgcXVldWVPcmRlciA9IEpTT04uc3RyaW5naWZ5KHsgb3JkZXI6IFsnTTAwMycsICdNMDAxJywgJ00wMDInXSwgdXBkYXRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkgfSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgJy5nc2QnLCAnUVVFVUUtT1JERVIuanNvbicpLCBxdWV1ZU9yZGVyKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL00wMDEtQ09OVEVYVC5tZCcsICcjIE0wMDFcXG5cXG5Db250ZXh0LicpO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDIvTTAwMi1DT05URVhULm1kJywgJyMgTTAwMlxcblxcbkNvbnRleHQuJyk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMy9NMDAzLUNPTlRFWFQubWQnLCAnIyBNMDAzXFxuXFxuQ29udGV4dC4nKTtcblxuICAgICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuICAgICAgLy8gSW5zZXJ0IGluIG5hdHVyYWwgb3JkZXIsIHRoZW4gc3RvcmUgdGhlIGF1dGhvcml0YXRpdmUgREIgc2VxdWVuY2UuXG4gICAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogJ00wMDEnLCB0aXRsZTogJ0ZpcnN0Jywgc3RhdHVzOiAnYWN0aXZlJyB9KTtcbiAgICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiAnTTAwMicsIHRpdGxlOiAnU2Vjb25kJywgc3RhdHVzOiAnYWN0aXZlJyB9KTtcbiAgICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiAnTTAwMycsIHRpdGxlOiAnVGhpcmQnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuICAgICAgc2V0TWlsZXN0b25lUXVldWVPcmRlcihbJ00wMDInLCAnTTAwMScsICdNMDAzJ10pO1xuXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZUZyb21EYihiYXNlKTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQsICdNMDAyJywgJ3F1ZXVlLW9yZGVyOiBEQiBzZXF1ZW5jZSBjaG9vc2VzIE0wMDInKTtcbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5yZWdpc3RyeVswXT8uaWQsICdNMDAyJywgJ3F1ZXVlLW9yZGVyOiByZWdpc3RyeVswXSBmb2xsb3dzIERCIHNlcXVlbmNlJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuXHQgIHRlc3QoJ2dldEFjdGl2ZU1pbGVzdG9uZUlkOiBEQiBsb2NrIHBhdGggaWdub3JlcyBQQVJLRUQgZmxhZyBwcm9qZWN0aW9uJywgYXN5bmMgKCkgPT4ge1xuXHQgICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG5cdCAgICBjb25zdCBwcmV2aW91c0xvY2sgPSBwcm9jZXNzLmVudi5HU0RfTUlMRVNUT05FX0xPQ0s7XG5cdCAgICBjb25zdCBwcmV2aW91c1dvcmtlciA9IHByb2Nlc3MuZW52LkdTRF9QQVJBTExFTF9XT1JLRVI7XG5cdCAgICB0cnkge1xuXHQgICAgICBwcm9jZXNzLmVudi5HU0RfTUlMRVNUT05FX0xPQ0sgPSAnTTAwMSc7XG5cdCAgICAgIHByb2Nlc3MuZW52LkdTRF9QQVJBTExFTF9XT1JLRVIgPSAnMSc7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9NMDAxLVBBUktFRC5tZCcsICcjIFBhcmtlZCBvbiBkaXNrJyk7XG5cbiAgICAgIG9wZW5EYXRhYmFzZSgnOm1lbW9yeTonKTtcbiAgICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiAnTTAwMScsIHRpdGxlOiAnQWN0aXZlIGluIERCJywgc3RhdHVzOiAnYWN0aXZlJyB9KTtcblxuICAgICAgY29uc3QgaWQgPSBhd2FpdCBnZXRBY3RpdmVNaWxlc3RvbmVJZChiYXNlKTtcbiAgICAgIGFzc2VydC5lcXVhbChpZCwgJ00wMDEnLCAnREIgc3RhdHVzIHJlbWFpbnMgYXV0aG9yaXRhdGl2ZSBkZXNwaXRlIFBBUktFRCBwcm9qZWN0aW9uJyk7XG5cdCAgICB9IGZpbmFsbHkge1xuXHQgICAgICBpZiAocHJldmlvdXNMb2NrID09PSB1bmRlZmluZWQpIGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfTUlMRVNUT05FX0xPQ0s7XG5cdCAgICAgIGVsc2UgcHJvY2Vzcy5lbnYuR1NEX01JTEVTVE9ORV9MT0NLID0gcHJldmlvdXNMb2NrO1xuXHQgICAgICBpZiAocHJldmlvdXNXb3JrZXIgPT09IHVuZGVmaW5lZCkgZGVsZXRlIHByb2Nlc3MuZW52LkdTRF9QQVJBTExFTF9XT1JLRVI7XG5cdCAgICAgIGVsc2UgcHJvY2Vzcy5lbnYuR1NEX1BBUkFMTEVMX1dPUktFUiA9IHByZXZpb3VzV29ya2VyO1xuXHQgICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGhhbmRsZUFsbFNsaWNlc0RvbmU6IG5lZWRzLXJlbWVkaWF0aW9uICsgYWxsIHNsaWNlcyBkb25lIFx1MjE5MiBibG9ja2VkICgjNDUwNikgXHUyNTAwXHUyNTAwXG4gIHRlc3QoJ2hhbmRsZUFsbFNsaWNlc0RvbmU6IG5lZWRzLXJlbWVkaWF0aW9uIHdpdGggYWxsIHNsaWNlcyBkb25lIHJldHVybnMgYmxvY2tlZCcsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgZG9uZVJvYWRtYXAgPSBgIyBNMDAxOiBSZW1lZGlhdGlvbiBUZXN0XFxuXFxuKipWaXNpb246KiogVGVzdC5cXG5cXG4jIyBTbGljZXNcXG5cXG4tIFt4XSAqKlMwMTogRG9uZSoqIFxcYHJpc2s6bG93XFxgIFxcYGRlcGVuZHM6W11cXGBcXG4gID4gRG9uZS5cXG5gO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvTTAwMS1ST0FETUFQLm1kJywgZG9uZVJvYWRtYXApO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvTTAwMS1WQUxJREFUSU9OLm1kJyxcbiAgICAgICAgJy0tLVxcbnZlcmRpY3Q6IG5lZWRzLXJlbWVkaWF0aW9uXFxucmVtZWRpYXRpb25fcm91bmQ6IDFcXG4tLS1cXG5cXG4jIFZhbGlkYXRpb25cXG5OZWVkcyByZW1lZGlhdGlvbi4nKTtcblxuICAgICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuICAgICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdSZW1lZGlhdGlvbiBUZXN0Jywgc3RhdHVzOiAnYWN0aXZlJyB9KTtcbiAgICAgIGluc2VydFNsaWNlKHsgaWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ0RvbmUnLCBzdGF0dXM6ICdjb21wbGV0ZScsIHJpc2s6ICdsb3cnLCBkZXBlbmRzOiBbXSB9KTtcbiAgICAgIGluc2VydEFzc2Vzc21lbnQoe1xuICAgICAgICBwYXRoOiAnbWlsZXN0b25lcy9NMDAxL00wMDEtVkFMSURBVElPTi5tZCcsXG4gICAgICAgIG1pbGVzdG9uZUlkOiAnTTAwMScsXG4gICAgICAgIHN0YXR1czogJ25lZWRzLXJlbWVkaWF0aW9uJyxcbiAgICAgICAgc2NvcGU6ICdtaWxlc3RvbmUtdmFsaWRhdGlvbicsXG4gICAgICAgIGZ1bGxDb250ZW50OiAndmVyZGljdDogbmVlZHMtcmVtZWRpYXRpb24nLFxuICAgICAgfSk7XG5cbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlRnJvbURiKGJhc2UpO1xuXG4gICAgICBhc3NlcnQuZXF1YWwoc3RhdGUucGhhc2UsICdibG9ja2VkJywgJ3JlbWVkaWF0aW9uLXN0dWNrOiBwaGFzZSBpcyBibG9ja2VkIChubyBpbmZpbml0ZSByZS1kaXNwYXRjaCknKTtcbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5hY3RpdmVNaWxlc3RvbmU/LmlkLCAnTTAwMScsICdyZW1lZGlhdGlvbi1zdHVjazogYWN0aXZlTWlsZXN0b25lIGlzIE0wMDEnKTtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgc3RhdGUuYmxvY2tlcnMuc29tZShiID0+IGIuaW5jbHVkZXMoJ25lZWRzLXJlbWVkaWF0aW9uJykgJiYgYi5pbmNsdWRlcygnTTAwMScpKSxcbiAgICAgICAgJ3JlbWVkaWF0aW9uLXN0dWNrOiBibG9ja2VyIG1lc3NhZ2UgbWVudGlvbnMgbWlsZXN0b25lIGFuZCB2ZXJkaWN0JyxcbiAgICAgICk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgRGVmZXJyZWQgcXVldWVkIHNoZWxsOiBzaGVsbCBtaWxlc3RvbmUgZGVmZXJyZWQsIHJlYWwgb25lIHByb21vdGVkIFx1MjUwMFx1MjUwMFxuICB0ZXN0KCdidWlsZFJlZ2lzdHJ5QW5kRmluZEFjdGl2ZTogcXVldWVkIHNoZWxsIGRlZmVycmVkLCBsYXRlciByZWFsIG1pbGVzdG9uZSBiZWNvbWVzIGFjdGl2ZSAoIzM0NzApJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICAvLyBNMDAxOiBxdWV1ZWQgc2hlbGwgXHUyMDE0IG5vIGNvbnRlbnQsIG5vIHNsaWNlc1xuICAgICAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgLy8gTTAwMjogcmVhbCBtaWxlc3RvbmUgd2l0aCBjb250ZXh0XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMi9NMDAyLUNPTlRFWFQubWQnLCAnIyBNMDAyOiBSZWFsXFxuXFxuQWN0aXZlIG1pbGVzdG9uZS4nKTtcblxuICAgICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuICAgICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdTaGVsbCcsIHN0YXR1czogJ3F1ZXVlZCcgfSk7XG4gICAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogJ00wMDInLCB0aXRsZTogJ1JlYWwnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZUZyb21EYihiYXNlKTtcblxuICAgICAgLy8gTTAwMiBzaG91bGQgYmUgYWN0aXZlIChNMDAxIHF1ZXVlZCBzaGVsbCBkZWZlcnJlZClcbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5hY3RpdmVNaWxlc3RvbmU/LmlkLCAnTTAwMicsICdkZWZlcnJlZC1zaGVsbDogTTAwMiBpcyBhY3RpdmUgKHNoZWxsIGRlZmVycmVkKScpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQU9BLFNBQVMsVUFBVSxZQUFtQztBQUN0RCxPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhLFdBQVcsUUFBUSxxQkFBcUI7QUFDOUQsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUV2QixTQUFTLHNCQUFzQixtQkFBbUIsNEJBQTRCO0FBQzlFO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUVLO0FBSVAsU0FBUyxvQkFBNEI7QUFDbkMsUUFBTSxPQUFPLFlBQVksS0FBSyxPQUFPLEdBQUcsY0FBYyxDQUFDO0FBQ3ZELFlBQVUsS0FBSyxNQUFNLFFBQVEsWUFBWSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDL0QsU0FBTztBQUNUO0FBRUEsU0FBUyxVQUFVLE1BQWMsY0FBc0IsU0FBdUI7QUFDNUUsUUFBTSxPQUFPLEtBQUssTUFBTSxRQUFRLFlBQVk7QUFDNUMsWUFBVSxLQUFLLE1BQU0sSUFBSSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDL0MsZ0JBQWMsTUFBTSxPQUFPO0FBQzdCO0FBRUEsU0FBUyxRQUFRLE1BQW9CO0FBQ25DLFNBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUMvQztBQUVBLE1BQU0sa0JBQWtCO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQWF4QixNQUFNLGVBQWU7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7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
