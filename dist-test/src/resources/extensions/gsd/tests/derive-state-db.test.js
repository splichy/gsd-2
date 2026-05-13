import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveState, invalidateStateCache, _deriveStateImpl, deriveStateFromDb, isGhostMilestone } from "../state.js";
import {
  openDatabase,
  closeDatabase,
  insertArtifact,
  isDbAvailable,
  insertMilestone,
  insertRequirement,
  insertAssessment,
  getAllMilestones,
  insertSlice,
  insertTask,
  getSliceTasks,
  updateTaskStatus
} from "../gsd-db.js";
function createFixtureBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-derive-db-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}
function writeFile(base, relativePath, content) {
  const full = join(base, ".gsd", relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}
function insertArtifactRow(relativePath, content, opts) {
  insertArtifact({
    path: relativePath,
    artifact_type: opts?.artifact_type ?? "planning",
    milestone_id: opts?.milestone_id ?? null,
    slice_id: opts?.slice_id ?? null,
    task_id: opts?.task_id ?? null,
    full_content: content
  });
}
function insertRequirementRow(id, status) {
  insertRequirement({
    id,
    class: "functional",
    status,
    description: `${id} ${status}`,
    why: "test",
    source: "test",
    primary_owner: "",
    supporting_slices: "",
    validation: "",
    notes: "",
    full_content: "",
    superseded_by: null
  });
}
function cleanup(base) {
  rmSync(base, { recursive: true, force: true });
}
const ROADMAP_CONTENT = `# M001: Test Milestone

**Vision:** Test DB-backed derive state.

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
const REQUIREMENTS_CONTENT = `# Requirements

## Active

### R001 \u2014 First Requirement
- Status: active
- Description: Something active.

### R002 \u2014 Second Requirement
- Status: active
- Description: Another active.

## Validated

### R003 \u2014 Validated
- Status: validated
- Description: Already validated.
`;
describe("derive-state-db", async () => {
  test("derive-state-db: DB path matches file path", async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, "milestones/M001/M001-ROADMAP.md", ROADMAP_CONTENT);
      writeFile(base, "milestones/M001/slices/S01/S01-PLAN.md", PLAN_CONTENT);
      writeFile(base, "milestones/M001/slices/S01/tasks/.gitkeep", "");
      writeFile(base, "milestones/M001/slices/S01/tasks/T01-PLAN.md", "# T01 Plan");
      writeFile(base, "REQUIREMENTS.md", REQUIREMENTS_CONTENT);
      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);
      openDatabase(":memory:");
      assert.ok(isDbAvailable(), "db-match: DB is available after open");
      insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "First Slice", status: "active", risk: "low", depends: [] });
      insertSlice({ id: "S02", milestoneId: "M001", title: "Second Slice", status: "pending", risk: "low", depends: ["S01"] });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "First Task", status: "pending" });
      insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Done Task", status: "complete" });
      insertRequirementRow("R001", "active");
      insertRequirementRow("R002", "active");
      insertRequirementRow("R003", "validated");
      insertArtifactRow("milestones/M001/M001-ROADMAP.md", ROADMAP_CONTENT, {
        artifact_type: "roadmap",
        milestone_id: "M001"
      });
      insertArtifactRow("milestones/M001/slices/S01/S01-PLAN.md", PLAN_CONTENT, {
        artifact_type: "plan",
        milestone_id: "M001",
        slice_id: "S01"
      });
      insertArtifactRow("REQUIREMENTS.md", REQUIREMENTS_CONTENT, {
        artifact_type: "requirements"
      });
      invalidateStateCache();
      const dbState = await deriveState(base);
      assert.deepStrictEqual(dbState.phase, fileState.phase, "db-match: phase matches");
      assert.deepStrictEqual(dbState.activeMilestone?.id, fileState.activeMilestone?.id, "db-match: activeMilestone.id matches");
      assert.deepStrictEqual(dbState.activeMilestone?.title, fileState.activeMilestone?.title, "db-match: activeMilestone.title matches");
      assert.deepStrictEqual(dbState.activeSlice?.id, fileState.activeSlice?.id, "db-match: activeSlice.id matches");
      assert.deepStrictEqual(dbState.activeSlice?.title, fileState.activeSlice?.title, "db-match: activeSlice.title matches");
      assert.deepStrictEqual(dbState.activeTask?.id, fileState.activeTask?.id, "db-match: activeTask.id matches");
      assert.deepStrictEqual(dbState.activeTask?.title, fileState.activeTask?.title, "db-match: activeTask.title matches");
      assert.deepStrictEqual(dbState.blockers, fileState.blockers, "db-match: blockers match");
      assert.deepStrictEqual(dbState.registry.length, fileState.registry.length, "db-match: registry length matches");
      assert.deepStrictEqual(dbState.registry[0]?.status, fileState.registry[0]?.status, "db-match: registry[0] status matches");
      assert.deepStrictEqual(dbState.requirements?.active, fileState.requirements?.active, "db-match: requirements.active matches");
      assert.deepStrictEqual(dbState.requirements?.validated, fileState.requirements?.validated, "db-match: requirements.validated matches");
      assert.deepStrictEqual(dbState.requirements?.total, fileState.requirements?.total, "db-match: requirements.total matches");
      assert.deepStrictEqual(dbState.progress?.milestones?.done, fileState.progress?.milestones?.done, "db-match: milestones.done matches");
      assert.deepStrictEqual(dbState.progress?.milestones?.total, fileState.progress?.milestones?.total, "db-match: milestones.total matches");
      assert.deepStrictEqual(dbState.progress?.slices?.done, fileState.progress?.slices?.done, "db-match: slices.done matches");
      assert.deepStrictEqual(dbState.progress?.slices?.total, fileState.progress?.slices?.total, "db-match: slices.total matches");
      assert.deepStrictEqual(dbState.progress?.tasks?.done, fileState.progress?.tasks?.done, "db-match: tasks.done matches");
      assert.deepStrictEqual(dbState.progress?.tasks?.total, fileState.progress?.tasks?.total, "db-match: tasks.total matches");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("derive-state-db: DB-unavailable runtime does not derive from markdown by default", async () => {
    const base = createFixtureBase();
    const prev = process.env.GSD_ALLOW_MARKDOWN_DERIVE_FALLBACK;
    try {
      process.env.GSD_ALLOW_MARKDOWN_DERIVE_FALLBACK = "0";
      writeFile(base, "milestones/M001/M001-ROADMAP.md", ROADMAP_CONTENT);
      writeFile(base, "milestones/M001/slices/S01/S01-PLAN.md", PLAN_CONTENT);
      writeFile(base, "milestones/M001/slices/S01/tasks/.gitkeep", "");
      writeFile(base, "milestones/M001/slices/S01/tasks/T01-PLAN.md", "# T01 Plan");
      assert.ok(!isDbAvailable(), "fallback: DB is not available");
      invalidateStateCache();
      const state = await deriveState(base);
      assert.deepStrictEqual(state.phase, "pre-planning", "runtime degrade: phase is pre-planning");
      assert.deepStrictEqual(state.activeMilestone, null, "runtime degrade: markdown milestone is not imported");
      assert.deepStrictEqual(state.activeSlice, null, "runtime degrade: markdown slice is not imported");
      assert.deepStrictEqual(state.activeTask, null, "runtime degrade: markdown task is not imported");
      assert.ok(
        state.blockers.some((b) => b.includes("DB unavailable")),
        "runtime degrade: blocker explains unavailable DB"
      );
    } finally {
      if (prev === void 0) delete process.env.GSD_ALLOW_MARKDOWN_DERIVE_FALLBACK;
      else process.env.GSD_ALLOW_MARKDOWN_DERIVE_FALLBACK = prev;
      cleanup(base);
    }
  });
  test("derive-state-db: explicit legacy markdown fallback remains opt-in", async () => {
    const base = createFixtureBase();
    const prev = process.env.GSD_ALLOW_MARKDOWN_DERIVE_FALLBACK;
    try {
      writeFile(base, "milestones/M001/M001-ROADMAP.md", ROADMAP_CONTENT);
      writeFile(base, "milestones/M001/slices/S01/S01-PLAN.md", PLAN_CONTENT);
      writeFile(base, "milestones/M001/slices/S01/tasks/.gitkeep", "");
      writeFile(base, "milestones/M001/slices/S01/tasks/T01-PLAN.md", "# T01 Plan");
      process.env.GSD_ALLOW_MARKDOWN_DERIVE_FALLBACK = "1";
      assert.ok(!isDbAvailable(), "fallback: DB is not available");
      invalidateStateCache();
      const state = await deriveState(base);
      assert.deepStrictEqual(state.phase, "executing", "fallback: phase is executing");
      assert.deepStrictEqual(state.activeMilestone?.id, "M001", "fallback: activeMilestone is M001");
      assert.deepStrictEqual(state.activeSlice?.id, "S01", "fallback: activeSlice is S01");
      assert.deepStrictEqual(state.activeTask?.id, "T01", "fallback: activeTask is T01");
    } finally {
      if (prev === void 0) delete process.env.GSD_ALLOW_MARKDOWN_DERIVE_FALLBACK;
      else process.env.GSD_ALLOW_MARKDOWN_DERIVE_FALLBACK = prev;
      cleanup(base);
    }
  });
  test("derive-state-db: empty DB does not import markdown milestones", async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, "milestones/M001/M001-ROADMAP.md", ROADMAP_CONTENT);
      writeFile(base, "milestones/M001/slices/S01/S01-PLAN.md", PLAN_CONTENT);
      writeFile(base, "milestones/M001/slices/S01/tasks/.gitkeep", "");
      writeFile(base, "milestones/M001/slices/S01/tasks/T01-PLAN.md", "# T01 Plan");
      openDatabase(":memory:");
      assert.ok(isDbAvailable(), "empty-db: DB is available");
      invalidateStateCache();
      const state = await deriveState(base);
      assert.deepStrictEqual(getAllMilestones().length, 0, "empty-db: markdown milestones are not imported");
      assert.deepStrictEqual(state.activeMilestone, null, "empty-db: no active milestone from disk");
      assert.deepStrictEqual(state.registry, [], "empty-db: registry remains empty");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("derive-state-db: partial DB does not fill requirements from disk", async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, "milestones/M001/M001-ROADMAP.md", ROADMAP_CONTENT);
      writeFile(base, "milestones/M001/slices/S01/S01-PLAN.md", PLAN_CONTENT);
      writeFile(base, "milestones/M001/slices/S01/tasks/.gitkeep", "");
      writeFile(base, "milestones/M001/slices/S01/tasks/T01-PLAN.md", "# T01 Plan");
      writeFile(base, "REQUIREMENTS.md", REQUIREMENTS_CONTENT);
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "First Slice", status: "active", risk: "low", depends: [] });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "First Task", status: "pending" });
      insertArtifactRow("milestones/M001/M001-ROADMAP.md", ROADMAP_CONTENT, {
        artifact_type: "roadmap",
        milestone_id: "M001"
      });
      invalidateStateCache();
      const state = await deriveState(base);
      assert.deepStrictEqual(state.phase, "executing", "partial-db: phase is executing");
      assert.deepStrictEqual(state.activeMilestone?.id, "M001", "partial-db: activeMilestone is M001");
      assert.deepStrictEqual(state.activeSlice?.id, "S01", "partial-db: activeSlice is S01");
      assert.deepStrictEqual(state.activeTask?.id, "T01", "partial-db: activeTask is T01");
      assert.deepStrictEqual(state.requirements?.active, 0, "partial-db: requirements.active not imported from disk");
      assert.deepStrictEqual(state.requirements?.validated, 0, "partial-db: requirements.validated not imported from disk");
      assert.deepStrictEqual(state.requirements?.total, 0, "partial-db: requirements.total not imported from disk");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("derive-state-db: partial task rows do not import missing plan tasks", async (t) => {
    const base = createFixtureBase();
    t.after(() => {
      closeDatabase();
      cleanup(base);
    });
    const partialTaskPlan = `# S01: First Slice

**Goal:** Test partial task DB reconciliation.
**Demo:** Tests pass.

## Tasks

- [x] **T01: Existing Complete** \`est:10m\`
  Already complete in DB.

- [ ] **T02: Missing Pending** \`est:10m\`
  Missing from DB but present in the plan.
`;
    writeFile(base, "milestones/M001/M001-ROADMAP.md", ROADMAP_CONTENT);
    writeFile(base, "milestones/M001/slices/S01/S01-PLAN.md", partialTaskPlan);
    writeFile(base, "milestones/M001/slices/S01/tasks/.gitkeep", "");
    writeFile(base, "milestones/M001/slices/S01/tasks/T01-PLAN.md", "# T01 Plan");
    writeFile(base, "milestones/M001/slices/S01/tasks/T02-PLAN.md", "# T02 Plan");
    openDatabase(":memory:");
    insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "First Slice", status: "active", risk: "low", depends: [] });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Existing Complete", status: "complete" });
    invalidateStateCache();
    const state = await deriveState(base);
    const dbTasks = getSliceTasks("M001", "S01");
    assert.deepStrictEqual(dbTasks.length, 1, "partial-task-db: missing T02 is not imported from plan");
    assert.deepStrictEqual(dbTasks.find((t2) => t2.id === "T01")?.status, "complete", "partial-task-db: existing complete T01 preserved");
    assert.deepStrictEqual(dbTasks.find((t2) => t2.id === "T02"), void 0, "partial-task-db: missing T02 absent from DB");
    assert.deepStrictEqual(state.phase, "summarizing", "partial-task-db: phase follows DB tasks only");
    assert.deepStrictEqual(state.activeTask, null, "partial-task-db: no active task from disk-only plan row");
    assert.deepStrictEqual(state.progress?.tasks, { done: 1, total: 1 }, "partial-task-db: task progress is DB-only");
  });
  test("derive-state-db: disk SUMMARY does not complete a pending DB task", async (t) => {
    const base = createFixtureBase();
    t.after(() => {
      closeDatabase();
      cleanup(base);
    });
    writeFile(base, "milestones/M001/M001-ROADMAP.md", ROADMAP_CONTENT);
    writeFile(base, "milestones/M001/slices/S01/S01-PLAN.md", PLAN_CONTENT);
    writeFile(base, "milestones/M001/slices/S01/tasks/T01-SUMMARY.md", "# T01 Summary\n\nManual disk edit.");
    openDatabase(":memory:");
    insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "First Slice", status: "active", risk: "low", depends: [] });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "First Task", status: "pending" });
    invalidateStateCache();
    const state = await deriveStateFromDb(base);
    assert.deepStrictEqual(getSliceTasks("M001", "S01").find((t2) => t2.id === "T01")?.status, "pending");
    assert.deepStrictEqual(state.phase, "executing");
    assert.deepStrictEqual(state.activeTask?.id, "T01");
  });
  test("derive-state-db: empty DB does not import milestone completion and dependencies", async (t) => {
    const base = createFixtureBase();
    t.after(() => {
      closeDatabase();
      cleanup(base);
    });
    writeFile(base, "milestones/M001/M001-ROADMAP.md", `# M001: Foundation

**Vision:** Foundation.

## Slices

- [x] **S01: Done** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
    writeFile(base, "milestones/M001/M001-VALIDATION.md", "---\nverdict: pass\nremediation_round: 0\n---\n\nPassed.");
    writeFile(base, "milestones/M001/M001-SUMMARY.md", "# M001 Summary\n\nDone.");
    writeFile(base, "milestones/M002/M002-CONTEXT.md", "---\ndepends_on:\n  - M001\n---\n\n# M002: Dependent\n");
    writeFile(base, "milestones/M002/M002-ROADMAP.md", `# M002: Dependent

**Vision:** Active work.

## Slices

- [ ] **S01: Work** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
    writeFile(base, "milestones/M003/M003-CONTEXT.md", "---\ndepends_on:\n  - M002\n---\n\n# M003: Blocked\n");
    openDatabase(":memory:");
    invalidateStateCache();
    const state = await deriveState(base);
    const milestones = getAllMilestones();
    assert.deepStrictEqual(milestones.length, 0, "disk-import: markdown milestones are not imported");
    assert.deepStrictEqual(state.activeMilestone, null, "disk-import: no active milestone from markdown");
    assert.deepStrictEqual(state.registry, [], "disk-import: registry remains DB-only");
  });
  test("derive-state-db: explicit legacy derivation counts requirements from disk content", async () => {
    const base = createFixtureBase();
    try {
      mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
      writeFile(base, "REQUIREMENTS.md", REQUIREMENTS_CONTENT);
      invalidateStateCache();
      const state = await _deriveStateImpl(base);
      assert.deepStrictEqual(state.requirements?.active, 2, "req-from-disk: requirements.active = 2");
      assert.deepStrictEqual(state.requirements?.validated, 1, "req-from-disk: requirements.validated = 1");
      assert.deepStrictEqual(state.requirements?.total, 3, "req-from-disk: requirements.total = 3");
    } finally {
      cleanup(base);
    }
  });
  test("derive-state-db: multi-milestone from DB", async () => {
    const base = createFixtureBase();
    const completedRoadmap = `# M001: First Milestone

**Vision:** Already done.

## Slices

- [x] **S01: Done** \`risk:low\` \`depends:[]\`
  > After this: Done.
`;
    const summaryContent = `# M001 Summary

First milestone complete.`;
    const activeRoadmap = `# M002: Second Milestone

**Vision:** Currently active.

## Slices

- [ ] **S01: In Progress** \`risk:low\` \`depends:[]\`
  > After this: Done.
`;
    try {
      mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
      mkdirSync(join(base, ".gsd", "milestones", "M002"), { recursive: true });
      writeFile(base, "milestones/M001/M001-ROADMAP.md", completedRoadmap);
      writeFile(base, "milestones/M001/M001-VALIDATION.md", `---
verdict: pass
remediation_round: 0
---

# Validation
Passed.`);
      writeFile(base, "milestones/M001/M001-SUMMARY.md", summaryContent);
      writeFile(base, "milestones/M002/M002-ROADMAP.md", activeRoadmap);
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "First Milestone", status: "complete" });
      insertMilestone({ id: "M002", title: "Second Milestone", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "Done", status: "complete", risk: "low", depends: [] });
      insertSlice({ id: "S01", milestoneId: "M002", title: "In Progress", status: "active", risk: "low", depends: [] });
      insertArtifactRow("milestones/M001/M001-ROADMAP.md", completedRoadmap, {
        artifact_type: "roadmap",
        milestone_id: "M001"
      });
      insertArtifactRow("milestones/M001/M001-SUMMARY.md", summaryContent, {
        artifact_type: "summary",
        milestone_id: "M001"
      });
      insertArtifactRow("milestones/M002/M002-ROADMAP.md", activeRoadmap, {
        artifact_type: "roadmap",
        milestone_id: "M002"
      });
      invalidateStateCache();
      const state = await deriveState(base);
      assert.deepStrictEqual(state.registry.length, 2, "multi-ms-db: registry has 2 entries");
      assert.deepStrictEqual(state.registry[0]?.id, "M001", "multi-ms-db: registry[0] is M001");
      assert.deepStrictEqual(state.registry[0]?.status, "complete", "multi-ms-db: M001 is complete");
      assert.deepStrictEqual(state.registry[1]?.id, "M002", "multi-ms-db: registry[1] is M002");
      assert.deepStrictEqual(state.registry[1]?.status, "active", "multi-ms-db: M002 is active");
      assert.deepStrictEqual(state.activeMilestone?.id, "M002", "multi-ms-db: activeMilestone is M002");
      assert.deepStrictEqual(state.phase, "planning", "multi-ms-db: phase is planning (no plan for S01)");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("derive-state-db: cache invalidation", async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, "milestones/M001/M001-ROADMAP.md", ROADMAP_CONTENT);
      writeFile(base, "milestones/M001/slices/S01/S01-PLAN.md", PLAN_CONTENT);
      writeFile(base, "milestones/M001/slices/S01/tasks/.gitkeep", "");
      writeFile(base, "milestones/M001/slices/S01/tasks/T01-PLAN.md", "# T01 Plan");
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "First Slice", status: "active", risk: "low", depends: [] });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "First Task", status: "pending" });
      insertArtifactRow("milestones/M001/M001-ROADMAP.md", ROADMAP_CONTENT, {
        artifact_type: "roadmap",
        milestone_id: "M001"
      });
      insertArtifactRow("milestones/M001/slices/S01/S01-PLAN.md", PLAN_CONTENT, {
        artifact_type: "plan",
        milestone_id: "M001",
        slice_id: "S01"
      });
      invalidateStateCache();
      const state1 = await deriveState(base);
      assert.deepStrictEqual(state1.activeTask?.id, "T01", "cache-inv: first call gets T01");
      const updatedPlan = PLAN_CONTENT.replace("- [ ] **T01:", "- [x] **T01:");
      insertArtifactRow("milestones/M001/slices/S01/S01-PLAN.md", updatedPlan, {
        artifact_type: "plan",
        milestone_id: "M001",
        slice_id: "S01"
      });
      writeFile(base, "milestones/M001/slices/S01/S01-PLAN.md", updatedPlan);
      updateTaskStatus("M001", "S01", "T01", "complete");
      const state2 = await deriveState(base);
      assert.deepStrictEqual(state2.activeTask?.id, "T01", "cache-inv: cached result still has T01");
      invalidateStateCache();
      const state3 = await deriveState(base);
      assert.deepStrictEqual(state3.phase, "summarizing", "cache-inv: after invalidation, phase is summarizing (all tasks done)");
      assert.deepStrictEqual(state3.activeTask, null, "cache-inv: activeTask is null after all done");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("derive-state-db: pre-planning via DB", async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, "milestones/M001/M001-CONTEXT.md", "# M001: First\n\nSome context.");
      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "First", status: "active" });
      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);
      assert.deepStrictEqual(dbState.phase, fileState.phase, "pre-plan-db: phase matches");
      assert.deepStrictEqual(dbState.activeMilestone?.id, fileState.activeMilestone?.id, "pre-plan-db: activeMilestone.id matches");
      assert.deepStrictEqual(dbState.activeSlice, fileState.activeSlice, "pre-plan-db: activeSlice matches");
      assert.deepStrictEqual(dbState.activeTask, fileState.activeTask, "pre-plan-db: activeTask matches");
      assert.deepStrictEqual(dbState.registry.length, fileState.registry.length, "pre-plan-db: registry length matches");
      assert.deepStrictEqual(dbState.registry[0]?.status, fileState.registry[0]?.status, "pre-plan-db: registry[0] status matches");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("derive-state-db: executing via DB", async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, "milestones/M001/M001-ROADMAP.md", ROADMAP_CONTENT);
      writeFile(base, "milestones/M001/slices/S01/S01-PLAN.md", PLAN_CONTENT);
      writeFile(base, "milestones/M001/slices/S01/tasks/.gitkeep", "");
      writeFile(base, "milestones/M001/slices/S01/tasks/T01-PLAN.md", "# T01 Plan");
      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "First Slice", status: "active", risk: "low", depends: [] });
      insertSlice({ id: "S02", milestoneId: "M001", title: "Second Slice", status: "pending", risk: "low", depends: ["S01"] });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "First Task", status: "pending" });
      insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Done Task", status: "complete" });
      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);
      assert.deepStrictEqual(dbState.phase, "executing", "exec-db: phase is executing");
      assert.deepStrictEqual(dbState.activeMilestone?.id, "M001", "exec-db: activeMilestone is M001");
      assert.deepStrictEqual(dbState.activeSlice?.id, "S01", "exec-db: activeSlice is S01");
      assert.deepStrictEqual(dbState.activeTask?.id, "T01", "exec-db: activeTask is T01");
      assert.deepStrictEqual(dbState.progress?.tasks?.done, 1, "exec-db: tasks.done = 1");
      assert.deepStrictEqual(dbState.progress?.tasks?.total, 2, "exec-db: tasks.total = 2");
      assert.deepStrictEqual(dbState.phase, fileState.phase, "exec-db: phase matches filesystem");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("derive-state-db: summarizing via DB", async () => {
    const base = createFixtureBase();
    try {
      const allDonePlan = `# S01: First Slice

**Goal:** Test summarizing.
**Demo:** Tests pass.

## Tasks

- [x] **T01: First Task** \`est:10m\`
  First task description.

- [x] **T02: Done Task** \`est:10m\`
  Already done.
`;
      writeFile(base, "milestones/M001/M001-ROADMAP.md", ROADMAP_CONTENT);
      writeFile(base, "milestones/M001/slices/S01/S01-PLAN.md", allDonePlan);
      writeFile(base, "milestones/M001/slices/S01/tasks/.gitkeep", "");
      writeFile(base, "milestones/M001/slices/S01/tasks/T01-PLAN.md", "# T01 Plan");
      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "First Slice", status: "active", risk: "low", depends: [] });
      insertSlice({ id: "S02", milestoneId: "M001", title: "Second Slice", status: "pending", risk: "low", depends: ["S01"] });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "First Task", status: "complete" });
      insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Done Task", status: "complete" });
      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);
      assert.deepStrictEqual(dbState.phase, "summarizing", "summarize-db: phase is summarizing");
      assert.deepStrictEqual(dbState.phase, fileState.phase, "summarize-db: phase matches filesystem");
      assert.deepStrictEqual(dbState.activeSlice?.id, "S01", "summarize-db: activeSlice is S01");
      assert.deepStrictEqual(dbState.activeTask, null, "summarize-db: activeTask is null");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("derive-state-db: all complete via DB", async () => {
    const base = createFixtureBase();
    try {
      const completedRoadmap = `# M001: Done Milestone

**Vision:** Already done.

## Slices

- [x] **S01: Done** \`risk:low\` \`depends:[]\`
  > After this: Done.
`;
      writeFile(base, "milestones/M001/M001-ROADMAP.md", completedRoadmap);
      writeFile(base, "milestones/M001/M001-VALIDATION.md", "---\nverdict: pass\nremediation_round: 0\n---\n\n# Validation\nPassed.");
      writeFile(base, "milestones/M001/M001-SUMMARY.md", "# M001 Summary\n\nDone.");
      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "Done Milestone", status: "complete" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "Done", status: "complete", risk: "low", depends: [] });
      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);
      assert.deepStrictEqual(dbState.phase, "complete", "complete-db: phase is complete");
      assert.deepStrictEqual(dbState.phase, fileState.phase, "complete-db: phase matches filesystem");
      assert.deepStrictEqual(dbState.registry.length, 1, "complete-db: registry has 1 entry");
      assert.deepStrictEqual(dbState.registry[0]?.status, "complete", "complete-db: M001 is complete");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("derive-state-db: blocked slice via DB", async () => {
    const base = createFixtureBase();
    try {
      const blockedRoadmap = `# M001: Blocked Test

**Vision:** Test blocked state.

## Slices

- [ ] **S01: First** \`risk:low\` \`depends:[S02]\`
  > After this: First done.

- [ ] **S02: Second** \`risk:low\` \`depends:[S01]\`
  > After this: Second done.
`;
      writeFile(base, "milestones/M001/M001-ROADMAP.md", blockedRoadmap);
      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "Blocked Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "First", status: "pending", risk: "low", depends: ["S02"] });
      insertSlice({ id: "S02", milestoneId: "M001", title: "Second", status: "pending", risk: "low", depends: ["S01"] });
      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);
      assert.deepStrictEqual(dbState.phase, "blocked", "blocked-db: phase is blocked when no slice deps are satisfied");
      assert.deepStrictEqual(dbState.phase, fileState.phase, "blocked-db: phase matches filesystem");
      assert.deepStrictEqual(dbState.activeSlice, null, "blocked-db: no activeSlice is selected through unmet deps");
      assert.ok(dbState.blockers.some((b) => b.includes("No slice eligible")), "blocked-db: blocker explains no eligible slice");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("derive-state-db: parked milestone via DB", async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, "milestones/M001/M001-ROADMAP.md", ROADMAP_CONTENT);
      writeFile(base, "milestones/M001/M001-PARKED.md", "Parked for now.");
      writeFile(base, "milestones/M002/M002-CONTEXT.md", "# M002: Active After Park\n\nReady.");
      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "Test Milestone", status: "parked" });
      insertMilestone({ id: "M002", title: "Active After Park", status: "active" });
      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);
      assert.deepStrictEqual(dbState.phase, fileState.phase, "parked-db: phase matches filesystem");
      assert.deepStrictEqual(dbState.activeMilestone?.id, "M002", "parked-db: activeMilestone is M002");
      assert.ok(dbState.registry.some((e) => e.id === "M001" && e.status === "parked"), "parked-db: M001 is parked in registry");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("derive-state-db: validating-milestone via DB", async () => {
    const base = createFixtureBase();
    try {
      const doneRoadmap = `# M001: Validate Test

**Vision:** Test validation.

## Slices

- [x] **S01: Done Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.
`;
      writeFile(base, "milestones/M001/M001-ROADMAP.md", doneRoadmap);
      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "Validate Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "Done Slice", status: "complete", risk: "low", depends: [] });
      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);
      assert.deepStrictEqual(dbState.phase, "validating-milestone", "validate-db: phase is validating-milestone");
      assert.deepStrictEqual(dbState.phase, fileState.phase, "validate-db: phase matches filesystem");
      assert.deepStrictEqual(dbState.activeMilestone?.id, "M001", "validate-db: activeMilestone is M001");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("derive-state-db: needs-remediation with all slices done returns blocked (#4506)", async () => {
    const base = createFixtureBase();
    try {
      const doneRoadmap = `# M001: Stuck Remediation

**Vision:** Test needs-remediation loop guard.

## Slices

- [x] **S01: Done Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.
`;
      writeFile(base, "milestones/M001/M001-ROADMAP.md", doneRoadmap);
      writeFile(
        base,
        "milestones/M001/M001-VALIDATION.md",
        "---\nverdict: needs-remediation\nremediation_round: 1\n---\n\n# Validation\nNeeds fixes."
      );
      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "Stuck Remediation", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "Done Slice", status: "complete", risk: "low", depends: [] });
      insertAssessment({
        path: "milestones/M001/M001-VALIDATION.md",
        milestoneId: "M001",
        status: "needs-remediation",
        scope: "milestone-validation",
        fullContent: "verdict: needs-remediation"
      });
      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);
      assert.deepStrictEqual(dbState.phase, "blocked", "remediation-stuck-db: phase is blocked");
      assert.deepStrictEqual(dbState.phase, fileState.phase, "remediation-stuck-db: phase matches filesystem");
      assert.deepStrictEqual(dbState.activeMilestone?.id, "M001", "remediation-stuck-db: activeMilestone is M001");
      assert.ok(
        dbState.blockers.some((b) => b.includes("needs-remediation") && b.includes("M001")),
        "remediation-stuck-db: blocker message mentions milestone and verdict"
      );
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("derive-state-db: completing-milestone via DB", async () => {
    const base = createFixtureBase();
    try {
      const doneRoadmap = `# M001: Complete Test

**Vision:** Test completion.

## Slices

- [x] **S01: Done Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.
`;
      writeFile(base, "milestones/M001/M001-ROADMAP.md", doneRoadmap);
      writeFile(base, "milestones/M001/M001-VALIDATION.md", "---\nverdict: pass\nremediation_round: 0\n---\n\n# Validation\nPassed.");
      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "Complete Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "Done Slice", status: "complete", risk: "low", depends: [] });
      insertAssessment({
        path: "milestones/M001/M001-VALIDATION.md",
        milestoneId: "M001",
        status: "pass",
        scope: "milestone-validation",
        fullContent: "verdict: pass"
      });
      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);
      assert.deepStrictEqual(dbState.phase, "completing-milestone", "completing-db: phase is completing-milestone");
      assert.deepStrictEqual(dbState.phase, fileState.phase, "completing-db: phase matches filesystem");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("derive-state-db: replanning-slice via DB", async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, "milestones/M001/M001-ROADMAP.md", ROADMAP_CONTENT);
      writeFile(base, "milestones/M001/slices/S01/S01-PLAN.md", PLAN_CONTENT);
      writeFile(base, "milestones/M001/slices/S01/tasks/.gitkeep", "");
      writeFile(base, "milestones/M001/slices/S01/tasks/T01-PLAN.md", "# T01 Plan");
      writeFile(base, "milestones/M001/slices/S01/S01-REPLAN-TRIGGER.md", "Replan triggered.");
      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "First Slice", status: "active", risk: "low", depends: [] });
      insertSlice({ id: "S02", milestoneId: "M001", title: "Second Slice", status: "pending", risk: "low", depends: ["S01"] });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "First Task", status: "pending" });
      insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Done Task", status: "complete" });
      const { _getAdapter } = await import("../gsd-db.js");
      const adapter = _getAdapter();
      adapter.prepare(
        "UPDATE slices SET replan_triggered_at = :ts WHERE milestone_id = :mid AND id = :sid"
      ).run({ ":ts": (/* @__PURE__ */ new Date()).toISOString(), ":mid": "M001", ":sid": "S01" });
      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);
      assert.deepStrictEqual(dbState.phase, "replanning-slice", "replan-db: phase is replanning-slice");
      assert.deepStrictEqual(dbState.phase, fileState.phase, "replan-db: phase matches filesystem");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("derive-state-db: performance assertion", async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, "milestones/M001/M001-ROADMAP.md", ROADMAP_CONTENT);
      writeFile(base, "milestones/M001/slices/S01/S01-PLAN.md", PLAN_CONTENT);
      writeFile(base, "milestones/M001/slices/S01/tasks/.gitkeep", "");
      writeFile(base, "milestones/M001/slices/S01/tasks/T01-PLAN.md", "# T01 Plan");
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "First Slice", status: "active", risk: "low", depends: [] });
      insertSlice({ id: "S02", milestoneId: "M001", title: "Second Slice", status: "pending", risk: "low", depends: ["S01"] });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "First Task", status: "pending" });
      insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Done Task", status: "complete" });
      invalidateStateCache();
      await deriveStateFromDb(base);
      const start = performance.now();
      invalidateStateCache();
      await deriveStateFromDb(base);
      const elapsed = performance.now() - start;
      console.log(`  deriveStateFromDb() took ${elapsed.toFixed(3)}ms`);
      assert.ok(elapsed < 25, `perf-db: deriveStateFromDb() <25ms (got ${elapsed.toFixed(3)}ms)`);
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("derive-state-db: multi-milestone deps via DB", async () => {
    const base = createFixtureBase();
    try {
      const m1Roadmap = `# M001: First

**Vision:** First.

## Slices

- [x] **S01: Done** \`risk:low\` \`depends:[]\`
  > After this: Done.
`;
      const m2Roadmap = `# M002: Second

**Vision:** Second.

## Slices

- [ ] **S01: Active** \`risk:low\` \`depends:[]\`
  > After this: Done.
`;
      writeFile(base, "milestones/M001/M001-ROADMAP.md", m1Roadmap);
      writeFile(base, "milestones/M001/M001-VALIDATION.md", "---\nverdict: pass\nremediation_round: 0\n---\n\nPassed.");
      writeFile(base, "milestones/M001/M001-SUMMARY.md", "# M001 Summary\n\nDone.");
      writeFile(base, "milestones/M002/M002-ROADMAP.md", m2Roadmap);
      writeFile(base, "milestones/M002/M002-CONTEXT.md", "---\ndepends_on:\n  - M001\n---\n\n# M002: Second\n\nDepends on M001.");
      writeFile(base, "milestones/M003/M003-CONTEXT.md", "---\ndepends_on:\n  - M002\n---\n\n# M003: Third\n\nDepends on M002.");
      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "First", status: "complete", depends_on: [] });
      insertSlice({ id: "S01", milestoneId: "M001", title: "Done", status: "complete", risk: "low", depends: [] });
      insertMilestone({ id: "M002", title: "Second", status: "active", depends_on: ["M001"] });
      insertSlice({ id: "S01", milestoneId: "M002", title: "Active", status: "pending", risk: "low", depends: [] });
      insertMilestone({ id: "M003", title: "Third", status: "active", depends_on: ["M002"] });
      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);
      assert.deepStrictEqual(dbState.registry.length, fileState.registry.length, "multi-deps-db: registry length matches");
      assert.deepStrictEqual(dbState.activeMilestone?.id, "M002", "multi-deps-db: activeMilestone is M002 (M001 complete, M003 dep unmet)");
      assert.deepStrictEqual(dbState.activeMilestone?.id, fileState.activeMilestone?.id, "multi-deps-db: activeMilestone matches filesystem");
      assert.deepStrictEqual(dbState.phase, fileState.phase, "multi-deps-db: phase matches filesystem");
      const m1reg = dbState.registry.find((e) => e.id === "M001");
      const m2reg = dbState.registry.find((e) => e.id === "M002");
      const m3reg = dbState.registry.find((e) => e.id === "M003");
      assert.deepStrictEqual(m1reg?.status, "complete", "multi-deps-db: M001 is complete");
      assert.deepStrictEqual(m2reg?.status, "active", "multi-deps-db: M002 is active");
      assert.deepStrictEqual(m3reg?.status, "pending", "multi-deps-db: M003 is pending (dep M002 unmet)");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("derive-state-db: K002 status handling", async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, "milestones/M001/M001-ROADMAP.md", ROADMAP_CONTENT);
      writeFile(base, "milestones/M001/slices/S01/S01-PLAN.md", PLAN_CONTENT);
      writeFile(base, "milestones/M001/slices/S01/tasks/.gitkeep", "");
      writeFile(base, "milestones/M001/slices/S01/tasks/T01-PLAN.md", "# T01 Plan");
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "First Slice", status: "active", risk: "low", depends: [] });
      insertSlice({ id: "S02", milestoneId: "M001", title: "Second Slice", status: "pending", risk: "low", depends: ["S01"] });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "First Task", status: "pending" });
      insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Done Task", status: "done" });
      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);
      assert.deepStrictEqual(dbState.phase, "executing", "k002-db: phase is executing");
      assert.deepStrictEqual(dbState.activeTask?.id, "T01", "k002-db: activeTask is T01 (T02 done)");
      assert.deepStrictEqual(dbState.progress?.tasks?.done, 1, "k002-db: tasks.done counts done status");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("derive-state-db: dual-path wiring", async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, "milestones/M001/M001-ROADMAP.md", ROADMAP_CONTENT);
      writeFile(base, "milestones/M001/slices/S01/S01-PLAN.md", PLAN_CONTENT);
      writeFile(base, "milestones/M001/slices/S01/tasks/.gitkeep", "");
      writeFile(base, "milestones/M001/slices/S01/tasks/T01-PLAN.md", "# T01 Plan");
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "First Slice", status: "active", risk: "low", depends: [] });
      insertSlice({ id: "S02", milestoneId: "M001", title: "Second Slice", status: "pending", risk: "low", depends: ["S01"] });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "First Task", status: "pending" });
      insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Done Task", status: "complete" });
      invalidateStateCache();
      const state = await deriveState(base);
      assert.deepStrictEqual(state.phase, "executing", "dual-path: phase is executing");
      assert.deepStrictEqual(state.activeMilestone?.id, "M001", "dual-path: activeMilestone is M001");
      assert.deepStrictEqual(state.activeSlice?.id, "S01", "dual-path: activeSlice is S01");
      assert.deepStrictEqual(state.activeTask?.id, "T01", "dual-path: activeTask is T01");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("derive-state-db: ghost milestone skipped when no DB row and no worktree", async () => {
    const base = createFixtureBase();
    try {
      mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
      writeFileSync(join(base, ".gsd", "milestones", "M001", "META.json"), "{}");
      writeFile(base, "milestones/M002/M002-CONTEXT.md", "# M002: Real\n\nReal milestone.");
      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);
      openDatabase(":memory:");
      insertMilestone({ id: "M002", title: "Real", status: "active" });
      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);
      assert.deepStrictEqual(dbState.activeMilestone?.id, "M002", "ghost-db: activeMilestone is M002 (ghost skipped)");
      assert.deepStrictEqual(dbState.activeMilestone?.id, fileState.activeMilestone?.id, "ghost-db: matches filesystem");
      assert.ok(!dbState.registry.some((e) => e.id === "M001"), "ghost-db: M001 not in registry");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("derive-state-db: needs-discussion via DB status", async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, "milestones/M001/M001-CONTEXT-DRAFT.md", "# M001: Draft\n\nDraft content.");
      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "Draft", status: "needs-discussion" });
      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);
      assert.deepStrictEqual(dbState.phase, "needs-discussion", "discuss-db: phase is needs-discussion");
      assert.deepStrictEqual(dbState.phase, fileState.phase, "discuss-db: phase matches filesystem");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("derive-state-db: disk-only milestone auto-synced into DB (#2416)", async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, "milestones/M001/M001-SUMMARY.md", "# M001 Summary\n\nDone.");
      writeFile(base, "milestones/M002/M002-CONTEXT.md", "# M002: Queued\n\nQueued milestone.");
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "First", status: "complete" });
      invalidateStateCache();
      const state = await deriveStateFromDb(base);
      assert.deepStrictEqual(state.phase, "complete", "disk-sync-2416: disk-only milestone is not imported");
      assert.deepStrictEqual(state.registry.length, 1, "disk-sync-2416: only DB milestones visible in registry");
      assert.deepStrictEqual(state.registry[0]?.id, "M001", "disk-sync-2416: registry[0] is M001");
      assert.deepStrictEqual(state.registry[0]?.status, "complete", "disk-sync-2416: M001 is complete");
      assert.deepStrictEqual(state.registry[1], void 0, "disk-sync-2416: M002 remains absent without explicit import");
      assert.deepStrictEqual(state.activeMilestone, null, "disk-sync-2416: no active milestone from disk-only row");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("derive-state-db: queued milestone row survives gsd_plan_milestone INSERT OR IGNORE", async () => {
    try {
      openDatabase(":memory:");
      insertMilestone({ id: "M001", status: "queued" });
      const before = getAllMilestones();
      assert.equal(before.length, 1, "queued-row: one row after generate_id");
      assert.equal(before[0].status, "queued", "queued-row: status is queued");
      insertMilestone({ id: "M001", title: "Planned Title", status: "active" });
      const after = getAllMilestones();
      assert.equal(after.length, 1, "queued-row: still one row after plan");
      assert.equal(after[0].status, "queued", "queued-row: INSERT OR IGNORE preserves original status");
      closeDatabase();
    } finally {
      closeDatabase();
    }
  });
  test("derive-state-db: queued milestone with worktree not flagged as ghost (#2921)", async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, "milestones/M001/M001-SUMMARY.md", "# M001 Summary\n\nDone.");
      mkdirSync(join(base, ".gsd", "milestones", "M002", "slices"), { recursive: true });
      mkdirSync(join(base, ".gsd", "worktrees", "M002"), { recursive: true });
      assert.ok(!isGhostMilestone(base, "M002"), "ghost-wt: M002 with worktree is NOT a ghost");
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "First", status: "complete" });
      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);
      const m002Entry = dbState.registry.find((e) => e.id === "M002");
      assert.equal(m002Entry, void 0, "ghost-wt: M002 should not be imported into registry");
      assert.deepStrictEqual(dbState.activeMilestone, null, "ghost-wt: no active milestone from disk-only worktree");
      assert.equal(dbState.phase, "complete", "ghost-wt: DB-only M001 completion drives state");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("derive-state-db: queued milestone with DB row not flagged as ghost (#2921)", async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, "milestones/M001/M001-SUMMARY.md", "# M001 Summary\n\nDone.");
      mkdirSync(join(base, ".gsd", "milestones", "M002", "slices"), { recursive: true });
      writeFile(base, "milestones/M002/M002-CONTEXT.md", "# M002 Context\n\nPlanned milestone.");
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "First", status: "complete" });
      insertMilestone({ id: "M002", title: "Second", status: "queued" });
      assert.ok(!isGhostMilestone(base, "M002"), "ghost-dbrow: M002 with DB row and content is NOT a ghost");
      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);
      const m002Entry = dbState.registry.find((e) => e.id === "M002");
      assert.ok(m002Entry !== void 0, "ghost-dbrow: M002 should be in registry");
      assert.deepStrictEqual(dbState.activeMilestone?.id, "M002", "ghost-dbrow: M002 should be active");
      assert.notEqual(dbState.phase, "complete", "ghost-dbrow: phase should not be complete");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9kZXJpdmUtc3RhdGUtZGIudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QgfSBmcm9tICdub2RlOnRlc3QnO1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSAnbm9kZTpmcyc7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJztcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gJ25vZGU6b3MnO1xuXG5pbXBvcnQgeyBkZXJpdmVTdGF0ZSwgaW52YWxpZGF0ZVN0YXRlQ2FjaGUsIF9kZXJpdmVTdGF0ZUltcGwsIGRlcml2ZVN0YXRlRnJvbURiLCBpc0dob3N0TWlsZXN0b25lIH0gZnJvbSAnLi4vc3RhdGUudHMnO1xuaW1wb3J0IHtcbiAgb3BlbkRhdGFiYXNlLFxuICBjbG9zZURhdGFiYXNlLFxuICBpbnNlcnRBcnRpZmFjdCxcbiAgaXNEYkF2YWlsYWJsZSxcbiAgaW5zZXJ0TWlsZXN0b25lLFxuICBpbnNlcnRSZXF1aXJlbWVudCxcbiAgaW5zZXJ0QXNzZXNzbWVudCxcbiAgZ2V0QWxsTWlsZXN0b25lcyxcbiAgaW5zZXJ0U2xpY2UsXG4gIGluc2VydFRhc2ssXG4gIGdldFNsaWNlVGFza3MsXG4gIHVwZGF0ZVRhc2tTdGF0dXMsXG59IGZyb20gJy4uL2dzZC1kYi50cyc7XG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRml4dHVyZSBIZWxwZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBjcmVhdGVGaXh0dXJlQmFzZSgpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgJ2dzZC1kZXJpdmUtZGItJykpO1xuICBta2RpclN5bmMoam9pbihiYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICByZXR1cm4gYmFzZTtcbn1cblxuZnVuY3Rpb24gd3JpdGVGaWxlKGJhc2U6IHN0cmluZywgcmVsYXRpdmVQYXRoOiBzdHJpbmcsIGNvbnRlbnQ6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBmdWxsID0gam9pbihiYXNlLCAnLmdzZCcsIHJlbGF0aXZlUGF0aCk7XG4gIG1rZGlyU3luYyhqb2luKGZ1bGwsICcuLicpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhmdWxsLCBjb250ZW50KTtcbn1cblxuZnVuY3Rpb24gaW5zZXJ0QXJ0aWZhY3RSb3cocmVsYXRpdmVQYXRoOiBzdHJpbmcsIGNvbnRlbnQ6IHN0cmluZywgb3B0cz86IHtcbiAgYXJ0aWZhY3RfdHlwZT86IHN0cmluZztcbiAgbWlsZXN0b25lX2lkPzogc3RyaW5nIHwgbnVsbDtcbiAgc2xpY2VfaWQ/OiBzdHJpbmcgfCBudWxsO1xuICB0YXNrX2lkPzogc3RyaW5nIHwgbnVsbDtcbn0pOiB2b2lkIHtcbiAgaW5zZXJ0QXJ0aWZhY3Qoe1xuICAgIHBhdGg6IHJlbGF0aXZlUGF0aCxcbiAgICBhcnRpZmFjdF90eXBlOiBvcHRzPy5hcnRpZmFjdF90eXBlID8/ICdwbGFubmluZycsXG4gICAgbWlsZXN0b25lX2lkOiBvcHRzPy5taWxlc3RvbmVfaWQgPz8gbnVsbCxcbiAgICBzbGljZV9pZDogb3B0cz8uc2xpY2VfaWQgPz8gbnVsbCxcbiAgICB0YXNrX2lkOiBvcHRzPy50YXNrX2lkID8/IG51bGwsXG4gICAgZnVsbF9jb250ZW50OiBjb250ZW50LFxuICB9KTtcbn1cblxuZnVuY3Rpb24gaW5zZXJ0UmVxdWlyZW1lbnRSb3coaWQ6IHN0cmluZywgc3RhdHVzOiBzdHJpbmcpOiB2b2lkIHtcbiAgaW5zZXJ0UmVxdWlyZW1lbnQoe1xuICAgIGlkLFxuICAgIGNsYXNzOiAnZnVuY3Rpb25hbCcsXG4gICAgc3RhdHVzLFxuICAgIGRlc2NyaXB0aW9uOiBgJHtpZH0gJHtzdGF0dXN9YCxcbiAgICB3aHk6ICd0ZXN0JyxcbiAgICBzb3VyY2U6ICd0ZXN0JyxcbiAgICBwcmltYXJ5X293bmVyOiAnJyxcbiAgICBzdXBwb3J0aW5nX3NsaWNlczogJycsXG4gICAgdmFsaWRhdGlvbjogJycsXG4gICAgbm90ZXM6ICcnLFxuICAgIGZ1bGxfY29udGVudDogJycsXG4gICAgc3VwZXJzZWRlZF9ieTogbnVsbCxcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGNsZWFudXAoYmFzZTogc3RyaW5nKTogdm9pZCB7XG4gIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG59XG5cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuLy8gVGVzdCBHcm91cHNcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG5jb25zdCBST0FETUFQX0NPTlRFTlQgPSBgIyBNMDAxOiBUZXN0IE1pbGVzdG9uZVxuXG4qKlZpc2lvbjoqKiBUZXN0IERCLWJhY2tlZCBkZXJpdmUgc3RhdGUuXG5cbiMjIFNsaWNlc1xuXG4tIFsgXSAqKlMwMTogRmlyc3QgU2xpY2UqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXG4gID4gQWZ0ZXIgdGhpczogU2xpY2UgZG9uZS5cblxuLSBbIF0gKipTMDI6IFNlY29uZCBTbGljZSoqIFxcYHJpc2s6bG93XFxgIFxcYGRlcGVuZHM6W1MwMV1cXGBcbiAgPiBBZnRlciB0aGlzOiBBbGwgZG9uZS5cbmA7XG5cbmNvbnN0IFBMQU5fQ09OVEVOVCA9IGAjIFMwMTogRmlyc3QgU2xpY2VcblxuKipHb2FsOioqIFRlc3QgZXhlY3V0aW5nLlxuKipEZW1vOioqIFRlc3RzIHBhc3MuXG5cbiMjIFRhc2tzXG5cbi0gWyBdICoqVDAxOiBGaXJzdCBUYXNrKiogXFxgZXN0OjEwbVxcYFxuICBGaXJzdCB0YXNrIGRlc2NyaXB0aW9uLlxuXG4tIFt4XSAqKlQwMjogRG9uZSBUYXNrKiogXFxgZXN0OjEwbVxcYFxuICBBbHJlYWR5IGRvbmUuXG5gO1xuXG5jb25zdCBSRVFVSVJFTUVOVFNfQ09OVEVOVCA9IGAjIFJlcXVpcmVtZW50c1xuXG4jIyBBY3RpdmVcblxuIyMjIFIwMDEgXHUyMDE0IEZpcnN0IFJlcXVpcmVtZW50XG4tIFN0YXR1czogYWN0aXZlXG4tIERlc2NyaXB0aW9uOiBTb21ldGhpbmcgYWN0aXZlLlxuXG4jIyMgUjAwMiBcdTIwMTQgU2Vjb25kIFJlcXVpcmVtZW50XG4tIFN0YXR1czogYWN0aXZlXG4tIERlc2NyaXB0aW9uOiBBbm90aGVyIGFjdGl2ZS5cblxuIyMgVmFsaWRhdGVkXG5cbiMjIyBSMDAzIFx1MjAxNCBWYWxpZGF0ZWRcbi0gU3RhdHVzOiB2YWxpZGF0ZWRcbi0gRGVzY3JpcHRpb246IEFscmVhZHkgdmFsaWRhdGVkLlxuYDtcblxuZGVzY3JpYmUoJ2Rlcml2ZS1zdGF0ZS1kYicsIGFzeW5jICgpID0+IHtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCAxOiBEQi1iYWNrZWQgZGVyaXZlU3RhdGUgcHJvZHVjZXMgaWRlbnRpY2FsIEdTRFN0YXRlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICB0ZXN0KCdkZXJpdmUtc3RhdGUtZGI6IERCIHBhdGggbWF0Y2hlcyBmaWxlIHBhdGgnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIC8vIFdyaXRlIGZpbGVzIHRvIGRpc2sgKGZvciBmaWxlLW9ubHkgcGF0aClcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL00wMDEtUk9BRE1BUC5tZCcsIFJPQURNQVBfQ09OVEVOVCk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzAxL1MwMS1QTEFOLm1kJywgUExBTl9DT05URU5UKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvdGFza3MvLmdpdGtlZXAnLCAnJyk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzAxL3Rhc2tzL1QwMS1QTEFOLm1kJywgJyMgVDAxIFBsYW4nKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnUkVRVUlSRU1FTlRTLm1kJywgUkVRVUlSRU1FTlRTX0NPTlRFTlQpO1xuXG4gICAgICAvLyBEZXJpdmUgc3RhdGUgZnJvbSB0aGUgZXhwbGljaXQgbGVnYWN5IGZpbGUtb25seSBwYXRoIChubyBEQilcbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBmaWxlU3RhdGUgPSBhd2FpdCBfZGVyaXZlU3RhdGVJbXBsKGJhc2UpO1xuXG4gICAgICAvLyBOb3cgb3BlbiBEQiwgaW5zZXJ0IG1hdGNoaW5nIGFydGlmYWN0cyArIG1pbGVzdG9uZSBoaWVyYXJjaHlcbiAgICAgIG9wZW5EYXRhYmFzZSgnOm1lbW9yeTonKTtcbiAgICAgIGFzc2VydC5vayhpc0RiQXZhaWxhYmxlKCksICdkYi1tYXRjaDogREIgaXMgYXZhaWxhYmxlIGFmdGVyIG9wZW4nKTtcblxuICAgICAgLy8gSW5zZXJ0IG1pbGVzdG9uZSBoaWVyYXJjaHkgc28gZGVyaXZlU3RhdGUgdGFrZXMgdGhlIERCIHBhdGggKCMyNjMxIGZpeClcbiAgICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiAnTTAwMScsIHRpdGxlOiAnVGVzdCBNaWxlc3RvbmUnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuICAgICAgaW5zZXJ0U2xpY2UoeyBpZDogJ1MwMScsIG1pbGVzdG9uZUlkOiAnTTAwMScsIHRpdGxlOiAnRmlyc3QgU2xpY2UnLCBzdGF0dXM6ICdhY3RpdmUnLCByaXNrOiAnbG93JywgZGVwZW5kczogW10gfSk7XG4gICAgICBpbnNlcnRTbGljZSh7IGlkOiAnUzAyJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdTZWNvbmQgU2xpY2UnLCBzdGF0dXM6ICdwZW5kaW5nJywgcmlzazogJ2xvdycsIGRlcGVuZHM6IFsnUzAxJ10gfSk7XG4gICAgICBpbnNlcnRUYXNrKHsgaWQ6ICdUMDEnLCBzbGljZUlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdGaXJzdCBUYXNrJywgc3RhdHVzOiAncGVuZGluZycgfSk7XG4gICAgICBpbnNlcnRUYXNrKHsgaWQ6ICdUMDInLCBzbGljZUlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdEb25lIFRhc2snLCBzdGF0dXM6ICdjb21wbGV0ZScgfSk7XG4gICAgICBpbnNlcnRSZXF1aXJlbWVudFJvdygnUjAwMScsICdhY3RpdmUnKTtcbiAgICAgIGluc2VydFJlcXVpcmVtZW50Um93KCdSMDAyJywgJ2FjdGl2ZScpO1xuICAgICAgaW5zZXJ0UmVxdWlyZW1lbnRSb3coJ1IwMDMnLCAndmFsaWRhdGVkJyk7XG5cbiAgICAgIGluc2VydEFydGlmYWN0Um93KCdtaWxlc3RvbmVzL00wMDEvTTAwMS1ST0FETUFQLm1kJywgUk9BRE1BUF9DT05URU5ULCB7XG4gICAgICAgIGFydGlmYWN0X3R5cGU6ICdyb2FkbWFwJyxcbiAgICAgICAgbWlsZXN0b25lX2lkOiAnTTAwMScsXG4gICAgICB9KTtcbiAgICAgIGluc2VydEFydGlmYWN0Um93KCdtaWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMS9TMDEtUExBTi5tZCcsIFBMQU5fQ09OVEVOVCwge1xuICAgICAgICBhcnRpZmFjdF90eXBlOiAncGxhbicsXG4gICAgICAgIG1pbGVzdG9uZV9pZDogJ00wMDEnLFxuICAgICAgICBzbGljZV9pZDogJ1MwMScsXG4gICAgICB9KTtcbiAgICAgIGluc2VydEFydGlmYWN0Um93KCdSRVFVSVJFTUVOVFMubWQnLCBSRVFVSVJFTUVOVFNfQ09OVEVOVCwge1xuICAgICAgICBhcnRpZmFjdF90eXBlOiAncmVxdWlyZW1lbnRzJyxcbiAgICAgIH0pO1xuXG4gICAgICAvLyBEZXJpdmUgc3RhdGUgZnJvbSBEQlxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IGRiU3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcblxuICAgICAgLy8gRmllbGQtYnktZmllbGQgZXF1YWxpdHlcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGJTdGF0ZS5waGFzZSwgZmlsZVN0YXRlLnBoYXNlLCAnZGItbWF0Y2g6IHBoYXNlIG1hdGNoZXMnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGJTdGF0ZS5hY3RpdmVNaWxlc3RvbmU/LmlkLCBmaWxlU3RhdGUuYWN0aXZlTWlsZXN0b25lPy5pZCwgJ2RiLW1hdGNoOiBhY3RpdmVNaWxlc3RvbmUuaWQgbWF0Y2hlcycpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8udGl0bGUsIGZpbGVTdGF0ZS5hY3RpdmVNaWxlc3RvbmU/LnRpdGxlLCAnZGItbWF0Y2g6IGFjdGl2ZU1pbGVzdG9uZS50aXRsZSBtYXRjaGVzJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUuYWN0aXZlU2xpY2U/LmlkLCBmaWxlU3RhdGUuYWN0aXZlU2xpY2U/LmlkLCAnZGItbWF0Y2g6IGFjdGl2ZVNsaWNlLmlkIG1hdGNoZXMnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGJTdGF0ZS5hY3RpdmVTbGljZT8udGl0bGUsIGZpbGVTdGF0ZS5hY3RpdmVTbGljZT8udGl0bGUsICdkYi1tYXRjaDogYWN0aXZlU2xpY2UudGl0bGUgbWF0Y2hlcycpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLmFjdGl2ZVRhc2s/LmlkLCBmaWxlU3RhdGUuYWN0aXZlVGFzaz8uaWQsICdkYi1tYXRjaDogYWN0aXZlVGFzay5pZCBtYXRjaGVzJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUuYWN0aXZlVGFzaz8udGl0bGUsIGZpbGVTdGF0ZS5hY3RpdmVUYXNrPy50aXRsZSwgJ2RiLW1hdGNoOiBhY3RpdmVUYXNrLnRpdGxlIG1hdGNoZXMnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGJTdGF0ZS5ibG9ja2VycywgZmlsZVN0YXRlLmJsb2NrZXJzLCAnZGItbWF0Y2g6IGJsb2NrZXJzIG1hdGNoJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUucmVnaXN0cnkubGVuZ3RoLCBmaWxlU3RhdGUucmVnaXN0cnkubGVuZ3RoLCAnZGItbWF0Y2g6IHJlZ2lzdHJ5IGxlbmd0aCBtYXRjaGVzJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUucmVnaXN0cnlbMF0/LnN0YXR1cywgZmlsZVN0YXRlLnJlZ2lzdHJ5WzBdPy5zdGF0dXMsICdkYi1tYXRjaDogcmVnaXN0cnlbMF0gc3RhdHVzIG1hdGNoZXMnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGJTdGF0ZS5yZXF1aXJlbWVudHM/LmFjdGl2ZSwgZmlsZVN0YXRlLnJlcXVpcmVtZW50cz8uYWN0aXZlLCAnZGItbWF0Y2g6IHJlcXVpcmVtZW50cy5hY3RpdmUgbWF0Y2hlcycpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLnJlcXVpcmVtZW50cz8udmFsaWRhdGVkLCBmaWxlU3RhdGUucmVxdWlyZW1lbnRzPy52YWxpZGF0ZWQsICdkYi1tYXRjaDogcmVxdWlyZW1lbnRzLnZhbGlkYXRlZCBtYXRjaGVzJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUucmVxdWlyZW1lbnRzPy50b3RhbCwgZmlsZVN0YXRlLnJlcXVpcmVtZW50cz8udG90YWwsICdkYi1tYXRjaDogcmVxdWlyZW1lbnRzLnRvdGFsIG1hdGNoZXMnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGJTdGF0ZS5wcm9ncmVzcz8ubWlsZXN0b25lcz8uZG9uZSwgZmlsZVN0YXRlLnByb2dyZXNzPy5taWxlc3RvbmVzPy5kb25lLCAnZGItbWF0Y2g6IG1pbGVzdG9uZXMuZG9uZSBtYXRjaGVzJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUucHJvZ3Jlc3M/Lm1pbGVzdG9uZXM/LnRvdGFsLCBmaWxlU3RhdGUucHJvZ3Jlc3M/Lm1pbGVzdG9uZXM/LnRvdGFsLCAnZGItbWF0Y2g6IG1pbGVzdG9uZXMudG90YWwgbWF0Y2hlcycpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLnByb2dyZXNzPy5zbGljZXM/LmRvbmUsIGZpbGVTdGF0ZS5wcm9ncmVzcz8uc2xpY2VzPy5kb25lLCAnZGItbWF0Y2g6IHNsaWNlcy5kb25lIG1hdGNoZXMnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGJTdGF0ZS5wcm9ncmVzcz8uc2xpY2VzPy50b3RhbCwgZmlsZVN0YXRlLnByb2dyZXNzPy5zbGljZXM/LnRvdGFsLCAnZGItbWF0Y2g6IHNsaWNlcy50b3RhbCBtYXRjaGVzJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUucHJvZ3Jlc3M/LnRhc2tzPy5kb25lLCBmaWxlU3RhdGUucHJvZ3Jlc3M/LnRhc2tzPy5kb25lLCAnZGItbWF0Y2g6IHRhc2tzLmRvbmUgbWF0Y2hlcycpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLnByb2dyZXNzPy50YXNrcz8udG90YWwsIGZpbGVTdGF0ZS5wcm9ncmVzcz8udGFza3M/LnRvdGFsLCAnZGItbWF0Y2g6IHRhc2tzLnRvdGFsIG1hdGNoZXMnKTtcblxuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRlc3QgMjogREItdW5hdmFpbGFibGUgcnVudGltZSBkb2VzIG5vdCBkZXJpdmUgZnJvbSBtYXJrZG93biBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgdGVzdCgnZGVyaXZlLXN0YXRlLWRiOiBEQi11bmF2YWlsYWJsZSBydW50aW1lIGRvZXMgbm90IGRlcml2ZSBmcm9tIG1hcmtkb3duIGJ5IGRlZmF1bHQnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgY29uc3QgcHJldiA9IHByb2Nlc3MuZW52LkdTRF9BTExPV19NQVJLRE9XTl9ERVJJVkVfRkFMTEJBQ0s7XG4gICAgdHJ5IHtcbiAgICAgIHByb2Nlc3MuZW52LkdTRF9BTExPV19NQVJLRE9XTl9ERVJJVkVfRkFMTEJBQ0sgPSAnMCc7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9NMDAxLVJPQURNQVAubWQnLCBST0FETUFQX0NPTlRFTlQpO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMS9TMDEtUExBTi5tZCcsIFBMQU5fQ09OVEVOVCk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzAxL3Rhc2tzLy5naXRrZWVwJywgJycpO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMS90YXNrcy9UMDEtUExBTi5tZCcsICcjIFQwMSBQbGFuJyk7XG5cbiAgICAgIC8vIE5vIERCIG9wZW4gXHUyMDE0IGlzRGJBdmFpbGFibGUoKSBpcyBmYWxzZVxuICAgICAgYXNzZXJ0Lm9rKCFpc0RiQXZhaWxhYmxlKCksICdmYWxsYmFjazogREIgaXMgbm90IGF2YWlsYWJsZScpO1xuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG5cbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucGhhc2UsICdwcmUtcGxhbm5pbmcnLCAncnVudGltZSBkZWdyYWRlOiBwaGFzZSBpcyBwcmUtcGxhbm5pbmcnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUuYWN0aXZlTWlsZXN0b25lLCBudWxsLCAncnVudGltZSBkZWdyYWRlOiBtYXJrZG93biBtaWxlc3RvbmUgaXMgbm90IGltcG9ydGVkJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLmFjdGl2ZVNsaWNlLCBudWxsLCAncnVudGltZSBkZWdyYWRlOiBtYXJrZG93biBzbGljZSBpcyBub3QgaW1wb3J0ZWQnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUuYWN0aXZlVGFzaywgbnVsbCwgJ3J1bnRpbWUgZGVncmFkZTogbWFya2Rvd24gdGFzayBpcyBub3QgaW1wb3J0ZWQnKTtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgc3RhdGUuYmxvY2tlcnMuc29tZShiID0+IGIuaW5jbHVkZXMoJ0RCIHVuYXZhaWxhYmxlJykpLFxuICAgICAgICAncnVudGltZSBkZWdyYWRlOiBibG9ja2VyIGV4cGxhaW5zIHVuYXZhaWxhYmxlIERCJyxcbiAgICAgICk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGlmIChwcmV2ID09PSB1bmRlZmluZWQpIGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfQUxMT1dfTUFSS0RPV05fREVSSVZFX0ZBTExCQUNLO1xuICAgICAgZWxzZSBwcm9jZXNzLmVudi5HU0RfQUxMT1dfTUFSS0RPV05fREVSSVZFX0ZBTExCQUNLID0gcHJldjtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KCdkZXJpdmUtc3RhdGUtZGI6IGV4cGxpY2l0IGxlZ2FjeSBtYXJrZG93biBmYWxsYmFjayByZW1haW5zIG9wdC1pbicsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICBjb25zdCBwcmV2ID0gcHJvY2Vzcy5lbnYuR1NEX0FMTE9XX01BUktET1dOX0RFUklWRV9GQUxMQkFDSztcbiAgICB0cnkge1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvTTAwMS1ST0FETUFQLm1kJywgUk9BRE1BUF9DT05URU5UKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvUzAxLVBMQU4ubWQnLCBQTEFOX0NPTlRFTlQpO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMS90YXNrcy8uZ2l0a2VlcCcsICcnKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvdGFza3MvVDAxLVBMQU4ubWQnLCAnIyBUMDEgUGxhbicpO1xuXG4gICAgICBwcm9jZXNzLmVudi5HU0RfQUxMT1dfTUFSS0RPV05fREVSSVZFX0ZBTExCQUNLID0gJzEnO1xuXG4gICAgICBhc3NlcnQub2soIWlzRGJBdmFpbGFibGUoKSwgJ2ZhbGxiYWNrOiBEQiBpcyBub3QgYXZhaWxhYmxlJyk7XG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcblxuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5waGFzZSwgJ2V4ZWN1dGluZycsICdmYWxsYmFjazogcGhhc2UgaXMgZXhlY3V0aW5nJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQsICdNMDAxJywgJ2ZhbGxiYWNrOiBhY3RpdmVNaWxlc3RvbmUgaXMgTTAwMScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5hY3RpdmVTbGljZT8uaWQsICdTMDEnLCAnZmFsbGJhY2s6IGFjdGl2ZVNsaWNlIGlzIFMwMScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5hY3RpdmVUYXNrPy5pZCwgJ1QwMScsICdmYWxsYmFjazogYWN0aXZlVGFzayBpcyBUMDEnKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgaWYgKHByZXYgPT09IHVuZGVmaW5lZCkgZGVsZXRlIHByb2Nlc3MuZW52LkdTRF9BTExPV19NQVJLRE9XTl9ERVJJVkVfRkFMTEJBQ0s7XG4gICAgICBlbHNlIHByb2Nlc3MuZW52LkdTRF9BTExPV19NQVJLRE9XTl9ERVJJVkVfRkFMTEJBQ0sgPSBwcmV2O1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0IDM6IEVtcHR5IERCIHJlbWFpbnMgYXV0aG9yaXRhdGl2ZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgdGVzdCgnZGVyaXZlLXN0YXRlLWRiOiBlbXB0eSBEQiBkb2VzIG5vdCBpbXBvcnQgbWFya2Rvd24gbWlsZXN0b25lcycsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvTTAwMS1ST0FETUFQLm1kJywgUk9BRE1BUF9DT05URU5UKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvUzAxLVBMQU4ubWQnLCBQTEFOX0NPTlRFTlQpO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMS90YXNrcy8uZ2l0a2VlcCcsICcnKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvdGFza3MvVDAxLVBMQU4ubWQnLCAnIyBUMDEgUGxhbicpO1xuXG4gICAgICAvLyBPcGVuIERCIGJ1dCBpbnNlcnQgbm90aGluZyBcdTIwMTQgZW1wdHkgREIgaXMgYXV0aG9yaXRhdGl2ZSBhdCBydW50aW1lLlxuICAgICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuICAgICAgYXNzZXJ0Lm9rKGlzRGJBdmFpbGFibGUoKSwgJ2VtcHR5LWRiOiBEQiBpcyBhdmFpbGFibGUnKTtcblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG5cbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZ2V0QWxsTWlsZXN0b25lcygpLmxlbmd0aCwgMCwgJ2VtcHR5LWRiOiBtYXJrZG93biBtaWxlc3RvbmVzIGFyZSBub3QgaW1wb3J0ZWQnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUuYWN0aXZlTWlsZXN0b25lLCBudWxsLCAnZW1wdHktZGI6IG5vIGFjdGl2ZSBtaWxlc3RvbmUgZnJvbSBkaXNrJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnJlZ2lzdHJ5LCBbXSwgJ2VtcHR5LWRiOiByZWdpc3RyeSByZW1haW5zIGVtcHR5Jyk7XG5cbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0IDQ6IFBhcnRpYWwgREIgY29udGVudCBkb2VzIG5vdCBmaWxsIGdhcHMgZnJvbSBkaXNrIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICB0ZXN0KCdkZXJpdmUtc3RhdGUtZGI6IHBhcnRpYWwgREIgZG9lcyBub3QgZmlsbCByZXF1aXJlbWVudHMgZnJvbSBkaXNrJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICAvLyBXcml0ZSBhbGwgZmlsZXMgdG8gZGlza1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvTTAwMS1ST0FETUFQLm1kJywgUk9BRE1BUF9DT05URU5UKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvUzAxLVBMQU4ubWQnLCBQTEFOX0NPTlRFTlQpO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMS90YXNrcy8uZ2l0a2VlcCcsICcnKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvdGFza3MvVDAxLVBMQU4ubWQnLCAnIyBUMDEgUGxhbicpO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdSRVFVSVJFTUVOVFMubWQnLCBSRVFVSVJFTUVOVFNfQ09OVEVOVCk7XG5cbiAgICAgIC8vIE9wZW4gREIgXHUyMDE0IGluc2VydCBtaWxlc3RvbmUgaGllcmFyY2h5ICsgcGFydGlhbCBhcnRpZmFjdHMgKCMyNjMxIGZpeClcbiAgICAgIG9wZW5EYXRhYmFzZSgnOm1lbW9yeTonKTtcbiAgICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiAnTTAwMScsIHRpdGxlOiAnVGVzdCBNaWxlc3RvbmUnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuICAgICAgaW5zZXJ0U2xpY2UoeyBpZDogJ1MwMScsIG1pbGVzdG9uZUlkOiAnTTAwMScsIHRpdGxlOiAnRmlyc3QgU2xpY2UnLCBzdGF0dXM6ICdhY3RpdmUnLCByaXNrOiAnbG93JywgZGVwZW5kczogW10gfSk7XG4gICAgICBpbnNlcnRUYXNrKHsgaWQ6ICdUMDEnLCBzbGljZUlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdGaXJzdCBUYXNrJywgc3RhdHVzOiAncGVuZGluZycgfSk7XG4gICAgICAvLyBPbmx5IGluc2VydCB0aGUgcm9hZG1hcCBhcnRpZmFjdCBcdTIwMTQgcGxhbiBhbmQgcmVxdWlyZW1lbnRzIG1pc3NpbmcgZnJvbSBEQlxuICAgICAgaW5zZXJ0QXJ0aWZhY3RSb3coJ21pbGVzdG9uZXMvTTAwMS9NMDAxLVJPQURNQVAubWQnLCBST0FETUFQX0NPTlRFTlQsIHtcbiAgICAgICAgYXJ0aWZhY3RfdHlwZTogJ3JvYWRtYXAnLFxuICAgICAgICBtaWxlc3RvbmVfaWQ6ICdNMDAxJyxcbiAgICAgIH0pO1xuXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcblxuICAgICAgLy8gU2hvdWxkIHdvcmsgZnJvbSBEQiBoaWVyYXJjaHksIGJ1dCByZXF1aXJlbWVudHMgYXJlIERCLWF1dGhvcml0YXRpdmUuXG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnBoYXNlLCAnZXhlY3V0aW5nJywgJ3BhcnRpYWwtZGI6IHBoYXNlIGlzIGV4ZWN1dGluZycpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5hY3RpdmVNaWxlc3RvbmU/LmlkLCAnTTAwMScsICdwYXJ0aWFsLWRiOiBhY3RpdmVNaWxlc3RvbmUgaXMgTTAwMScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5hY3RpdmVTbGljZT8uaWQsICdTMDEnLCAncGFydGlhbC1kYjogYWN0aXZlU2xpY2UgaXMgUzAxJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLmFjdGl2ZVRhc2s/LmlkLCAnVDAxJywgJ3BhcnRpYWwtZGI6IGFjdGl2ZVRhc2sgaXMgVDAxJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnJlcXVpcmVtZW50cz8uYWN0aXZlLCAwLCAncGFydGlhbC1kYjogcmVxdWlyZW1lbnRzLmFjdGl2ZSBub3QgaW1wb3J0ZWQgZnJvbSBkaXNrJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnJlcXVpcmVtZW50cz8udmFsaWRhdGVkLCAwLCAncGFydGlhbC1kYjogcmVxdWlyZW1lbnRzLnZhbGlkYXRlZCBub3QgaW1wb3J0ZWQgZnJvbSBkaXNrJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnJlcXVpcmVtZW50cz8udG90YWwsIDAsICdwYXJ0aWFsLWRiOiByZXF1aXJlbWVudHMudG90YWwgbm90IGltcG9ydGVkIGZyb20gZGlzaycpO1xuXG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KCdkZXJpdmUtc3RhdGUtZGI6IHBhcnRpYWwgdGFzayByb3dzIGRvIG5vdCBpbXBvcnQgbWlzc2luZyBwbGFuIHRhc2tzJywgYXN5bmMgKHQpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0LmFmdGVyKCgpID0+IHtcbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfSk7XG5cbiAgICBjb25zdCBwYXJ0aWFsVGFza1BsYW4gPSBgIyBTMDE6IEZpcnN0IFNsaWNlXG5cbioqR29hbDoqKiBUZXN0IHBhcnRpYWwgdGFzayBEQiByZWNvbmNpbGlhdGlvbi5cbioqRGVtbzoqKiBUZXN0cyBwYXNzLlxuXG4jIyBUYXNrc1xuXG4tIFt4XSAqKlQwMTogRXhpc3RpbmcgQ29tcGxldGUqKiBcXGBlc3Q6MTBtXFxgXG4gIEFscmVhZHkgY29tcGxldGUgaW4gREIuXG5cbi0gWyBdICoqVDAyOiBNaXNzaW5nIFBlbmRpbmcqKiBcXGBlc3Q6MTBtXFxgXG4gIE1pc3NpbmcgZnJvbSBEQiBidXQgcHJlc2VudCBpbiB0aGUgcGxhbi5cbmA7XG4gICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvTTAwMS1ST0FETUFQLm1kJywgUk9BRE1BUF9DT05URU5UKTtcbiAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzAxL1MwMS1QTEFOLm1kJywgcGFydGlhbFRhc2tQbGFuKTtcbiAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzAxL3Rhc2tzLy5naXRrZWVwJywgJycpO1xuICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvdGFza3MvVDAxLVBMQU4ubWQnLCAnIyBUMDEgUGxhbicpO1xuICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvdGFza3MvVDAyLVBMQU4ubWQnLCAnIyBUMDIgUGxhbicpO1xuXG4gICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiAnTTAwMScsIHRpdGxlOiAnVGVzdCBNaWxlc3RvbmUnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuICAgIGluc2VydFNsaWNlKHsgaWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ0ZpcnN0IFNsaWNlJywgc3RhdHVzOiAnYWN0aXZlJywgcmlzazogJ2xvdycsIGRlcGVuZHM6IFtdIH0pO1xuICAgIGluc2VydFRhc2soeyBpZDogJ1QwMScsIHNsaWNlSWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ0V4aXN0aW5nIENvbXBsZXRlJywgc3RhdHVzOiAnY29tcGxldGUnIH0pO1xuXG4gICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuXG4gICAgY29uc3QgZGJUYXNrcyA9IGdldFNsaWNlVGFza3MoJ00wMDEnLCAnUzAxJyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlRhc2tzLmxlbmd0aCwgMSwgJ3BhcnRpYWwtdGFzay1kYjogbWlzc2luZyBUMDIgaXMgbm90IGltcG9ydGVkIGZyb20gcGxhbicpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGJUYXNrcy5maW5kKHQgPT4gdC5pZCA9PT0gJ1QwMScpPy5zdGF0dXMsICdjb21wbGV0ZScsICdwYXJ0aWFsLXRhc2stZGI6IGV4aXN0aW5nIGNvbXBsZXRlIFQwMSBwcmVzZXJ2ZWQnKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiVGFza3MuZmluZCh0ID0+IHQuaWQgPT09ICdUMDInKSwgdW5kZWZpbmVkLCAncGFydGlhbC10YXNrLWRiOiBtaXNzaW5nIFQwMiBhYnNlbnQgZnJvbSBEQicpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucGhhc2UsICdzdW1tYXJpemluZycsICdwYXJ0aWFsLXRhc2stZGI6IHBoYXNlIGZvbGxvd3MgREIgdGFza3Mgb25seScpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUuYWN0aXZlVGFzaywgbnVsbCwgJ3BhcnRpYWwtdGFzay1kYjogbm8gYWN0aXZlIHRhc2sgZnJvbSBkaXNrLW9ubHkgcGxhbiByb3cnKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnByb2dyZXNzPy50YXNrcywgeyBkb25lOiAxLCB0b3RhbDogMSB9LCAncGFydGlhbC10YXNrLWRiOiB0YXNrIHByb2dyZXNzIGlzIERCLW9ubHknKTtcbiAgfSk7XG5cbiAgdGVzdCgnZGVyaXZlLXN0YXRlLWRiOiBkaXNrIFNVTU1BUlkgZG9lcyBub3QgY29tcGxldGUgYSBwZW5kaW5nIERCIHRhc2snLCBhc3luYyAodCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHQuYWZ0ZXIoKCkgPT4ge1xuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9KTtcblxuICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL00wMDEtUk9BRE1BUC5tZCcsIFJPQURNQVBfQ09OVEVOVCk7XG4gICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMS9TMDEtUExBTi5tZCcsIFBMQU5fQ09OVEVOVCk7XG4gICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMS90YXNrcy9UMDEtU1VNTUFSWS5tZCcsICcjIFQwMSBTdW1tYXJ5XFxuXFxuTWFudWFsIGRpc2sgZWRpdC4nKTtcblxuICAgIG9wZW5EYXRhYmFzZSgnOm1lbW9yeTonKTtcbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogJ00wMDEnLCB0aXRsZTogJ1Rlc3QgTWlsZXN0b25lJywgc3RhdHVzOiAnYWN0aXZlJyB9KTtcbiAgICBpbnNlcnRTbGljZSh7IGlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdGaXJzdCBTbGljZScsIHN0YXR1czogJ2FjdGl2ZScsIHJpc2s6ICdsb3cnLCBkZXBlbmRzOiBbXSB9KTtcbiAgICBpbnNlcnRUYXNrKHsgaWQ6ICdUMDEnLCBzbGljZUlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdGaXJzdCBUYXNrJywgc3RhdHVzOiAncGVuZGluZycgfSk7XG5cbiAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGVGcm9tRGIoYmFzZSk7XG5cbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGdldFNsaWNlVGFza3MoJ00wMDEnLCAnUzAxJykuZmluZCh0ID0+IHQuaWQgPT09ICdUMDEnKT8uc3RhdHVzLCAncGVuZGluZycpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucGhhc2UsICdleGVjdXRpbmcnKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLmFjdGl2ZVRhc2s/LmlkLCAnVDAxJyk7XG4gIH0pO1xuXG4gIHRlc3QoJ2Rlcml2ZS1zdGF0ZS1kYjogZW1wdHkgREIgZG9lcyBub3QgaW1wb3J0IG1pbGVzdG9uZSBjb21wbGV0aW9uIGFuZCBkZXBlbmRlbmNpZXMnLCBhc3luYyAodCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHQuYWZ0ZXIoKCkgPT4ge1xuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9KTtcblxuICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL00wMDEtUk9BRE1BUC5tZCcsIGAjIE0wMDE6IEZvdW5kYXRpb25cblxuKipWaXNpb246KiogRm91bmRhdGlvbi5cblxuIyMgU2xpY2VzXG5cbi0gW3hdICoqUzAxOiBEb25lKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbXVxcYFxuICA+IEFmdGVyIHRoaXM6IERvbmUuXG5gKTtcbiAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9NMDAxLVZBTElEQVRJT04ubWQnLCAnLS0tXFxudmVyZGljdDogcGFzc1xcbnJlbWVkaWF0aW9uX3JvdW5kOiAwXFxuLS0tXFxuXFxuUGFzc2VkLicpO1xuICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL00wMDEtU1VNTUFSWS5tZCcsICcjIE0wMDEgU3VtbWFyeVxcblxcbkRvbmUuJyk7XG4gICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDIvTTAwMi1DT05URVhULm1kJywgJy0tLVxcbmRlcGVuZHNfb246XFxuICAtIE0wMDFcXG4tLS1cXG5cXG4jIE0wMDI6IERlcGVuZGVudFxcbicpO1xuICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAyL00wMDItUk9BRE1BUC5tZCcsIGAjIE0wMDI6IERlcGVuZGVudFxuXG4qKlZpc2lvbjoqKiBBY3RpdmUgd29yay5cblxuIyMgU2xpY2VzXG5cbi0gWyBdICoqUzAxOiBXb3JrKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbXVxcYFxuICA+IEFmdGVyIHRoaXM6IERvbmUuXG5gKTtcbiAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMy9NMDAzLUNPTlRFWFQubWQnLCAnLS0tXFxuZGVwZW5kc19vbjpcXG4gIC0gTTAwMlxcbi0tLVxcblxcbiMgTTAwMzogQmxvY2tlZFxcbicpO1xuXG4gICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuXG4gICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuXG4gICAgY29uc3QgbWlsZXN0b25lcyA9IGdldEFsbE1pbGVzdG9uZXMoKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKG1pbGVzdG9uZXMubGVuZ3RoLCAwLCAnZGlzay1pbXBvcnQ6IG1hcmtkb3duIG1pbGVzdG9uZXMgYXJlIG5vdCBpbXBvcnRlZCcpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUuYWN0aXZlTWlsZXN0b25lLCBudWxsLCAnZGlzay1pbXBvcnQ6IG5vIGFjdGl2ZSBtaWxlc3RvbmUgZnJvbSBtYXJrZG93bicpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucmVnaXN0cnksIFtdLCAnZGlzay1pbXBvcnQ6IHJlZ2lzdHJ5IHJlbWFpbnMgREItb25seScpO1xuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCA1OiBMZWdhY3kgcmVxdWlyZW1lbnRzIGNvdW50aW5nIGZyb20gZGlzayBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgdGVzdCgnZGVyaXZlLXN0YXRlLWRiOiBleHBsaWNpdCBsZWdhY3kgZGVyaXZhdGlvbiBjb3VudHMgcmVxdWlyZW1lbnRzIGZyb20gZGlzayBjb250ZW50JywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICAvLyBXcml0ZSBtaW5pbWFsIG1pbGVzdG9uZSBkaXIgKG5lZWRlZCBmb3IgbWlsZXN0b25lIGRpc2NvdmVyeSlcbiAgICAgIG1rZGlyU3luYyhqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIC8vIFdyaXRlIFJFUVVJUkVNRU5UUy5tZCB0byBkaXNrIChEQiBjb250ZW50IGlzIG5vIGxvbmdlciB1c2VkIGJ5IGRlcml2ZVN0YXRlKVxuICAgICAgd3JpdGVGaWxlKGJhc2UsICdSRVFVSVJFTUVOVFMubWQnLCBSRVFVSVJFTUVOVFNfQ09OVEVOVCk7XG5cbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IF9kZXJpdmVTdGF0ZUltcGwoYmFzZSk7XG5cbiAgICAgIC8vIEV4cGxpY2l0IGxlZ2FjeSBkZXJpdmF0aW9uIHN0aWxsIHJlYWRzIHJlcXVpcmVtZW50cyBmcm9tIGRpc2suXG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnJlcXVpcmVtZW50cz8uYWN0aXZlLCAyLCAncmVxLWZyb20tZGlzazogcmVxdWlyZW1lbnRzLmFjdGl2ZSA9IDInKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucmVxdWlyZW1lbnRzPy52YWxpZGF0ZWQsIDEsICdyZXEtZnJvbS1kaXNrOiByZXF1aXJlbWVudHMudmFsaWRhdGVkID0gMScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5yZXF1aXJlbWVudHM/LnRvdGFsLCAzLCAncmVxLWZyb20tZGlzazogcmVxdWlyZW1lbnRzLnRvdGFsID0gMycpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRlc3QgNjogREIgY29udGVudCB3aXRoIG11bHRpLW1pbGVzdG9uZSByZWdpc3RyeSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgdGVzdCgnZGVyaXZlLXN0YXRlLWRiOiBtdWx0aS1taWxlc3RvbmUgZnJvbSBEQicsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcblxuICAgIGNvbnN0IGNvbXBsZXRlZFJvYWRtYXAgPSBgIyBNMDAxOiBGaXJzdCBNaWxlc3RvbmVcblxuKipWaXNpb246KiogQWxyZWFkeSBkb25lLlxuXG4jIyBTbGljZXNcblxuLSBbeF0gKipTMDE6IERvbmUqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXG4gID4gQWZ0ZXIgdGhpczogRG9uZS5cbmA7XG4gICAgY29uc3Qgc3VtbWFyeUNvbnRlbnQgPSBgIyBNMDAxIFN1bW1hcnlcXG5cXG5GaXJzdCBtaWxlc3RvbmUgY29tcGxldGUuYDtcblxuICAgIGNvbnN0IGFjdGl2ZVJvYWRtYXAgPSBgIyBNMDAyOiBTZWNvbmQgTWlsZXN0b25lXG5cbioqVmlzaW9uOioqIEN1cnJlbnRseSBhY3RpdmUuXG5cbiMjIFNsaWNlc1xuXG4tIFsgXSAqKlMwMTogSW4gUHJvZ3Jlc3MqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXG4gID4gQWZ0ZXIgdGhpczogRG9uZS5cbmA7XG5cbiAgICB0cnkge1xuICAgICAgLy8gQ3JlYXRlIG1pbGVzdG9uZSBkaXJzIG9uIGRpc2sgKG5lZWRlZCBmb3IgZGlyZWN0b3J5IHNjYW5uaW5nKVxuICAgICAgLy8gQWxzbyB3cml0ZSByb2FkbWFwIGZpbGVzIHRvIGRpc2sgXHUyMDE0IHJlc29sdmVNaWxlc3RvbmVGaWxlIGNoZWNrcyBmaWxlIGV4aXN0ZW5jZVxuICAgICAgLy8gVGhlIERCIG9ubHkgcHJvdmlkZXMgY29udGVudCwgbm90IGZpbGUgZGlzY292ZXJ5XG4gICAgICBta2RpclN5bmMoam9pbihiYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgJ00wMDEnKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICBta2RpclN5bmMoam9pbihiYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgJ00wMDInKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9NMDAxLVJPQURNQVAubWQnLCBjb21wbGV0ZWRSb2FkbWFwKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL00wMDEtVkFMSURBVElPTi5tZCcsIGAtLS1cXG52ZXJkaWN0OiBwYXNzXFxucmVtZWRpYXRpb25fcm91bmQ6IDBcXG4tLS1cXG5cXG4jIFZhbGlkYXRpb25cXG5QYXNzZWQuYCk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9NMDAxLVNVTU1BUlkubWQnLCBzdW1tYXJ5Q29udGVudCk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMi9NMDAyLVJPQURNQVAubWQnLCBhY3RpdmVSb2FkbWFwKTtcblxuICAgICAgLy8gUHV0IHJvYWRtYXAgY29udGVudCBpbiBEQiBvbmx5XG4gICAgICBvcGVuRGF0YWJhc2UoJzptZW1vcnk6Jyk7XG4gICAgICAvLyBJbnNlcnQgbWlsZXN0b25lIHJvd3Mgc28gZGVyaXZlU3RhdGUgdGFrZXMgdGhlIERCIHBhdGggKCMyNjMxIGZpeDpcbiAgICAgIC8vIGVtcHR5IG1pbGVzdG9uZXMgdGFibGUgbm93IHRyaWdnZXJzIGRpc2tcdTIxOTJEQiBzeW5jLCB3aGljaCB3b3VsZCBjcmVhdGVcbiAgICAgIC8vIHJvd3Mgd2l0aG91dCBzbGljZXMgXHUyMDE0IGluc2VydCBleHBsaWNpdGx5IHRvIGdldCB0aGUgZnVsbCBEQiBwYXRoKS5cbiAgICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiAnTTAwMScsIHRpdGxlOiAnRmlyc3QgTWlsZXN0b25lJywgc3RhdHVzOiAnY29tcGxldGUnIH0pO1xuICAgICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAyJywgdGl0bGU6ICdTZWNvbmQgTWlsZXN0b25lJywgc3RhdHVzOiAnYWN0aXZlJyB9KTtcbiAgICAgIGluc2VydFNsaWNlKHsgaWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ0RvbmUnLCBzdGF0dXM6ICdjb21wbGV0ZScsIHJpc2s6ICdsb3cnLCBkZXBlbmRzOiBbXSB9KTtcbiAgICAgIGluc2VydFNsaWNlKHsgaWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDInLCB0aXRsZTogJ0luIFByb2dyZXNzJywgc3RhdHVzOiAnYWN0aXZlJywgcmlzazogJ2xvdycsIGRlcGVuZHM6IFtdIH0pO1xuICAgICAgaW5zZXJ0QXJ0aWZhY3RSb3coJ21pbGVzdG9uZXMvTTAwMS9NMDAxLVJPQURNQVAubWQnLCBjb21wbGV0ZWRSb2FkbWFwLCB7XG4gICAgICAgIGFydGlmYWN0X3R5cGU6ICdyb2FkbWFwJyxcbiAgICAgICAgbWlsZXN0b25lX2lkOiAnTTAwMScsXG4gICAgICB9KTtcbiAgICAgIGluc2VydEFydGlmYWN0Um93KCdtaWxlc3RvbmVzL00wMDEvTTAwMS1TVU1NQVJZLm1kJywgc3VtbWFyeUNvbnRlbnQsIHtcbiAgICAgICAgYXJ0aWZhY3RfdHlwZTogJ3N1bW1hcnknLFxuICAgICAgICBtaWxlc3RvbmVfaWQ6ICdNMDAxJyxcbiAgICAgIH0pO1xuICAgICAgaW5zZXJ0QXJ0aWZhY3RSb3coJ21pbGVzdG9uZXMvTTAwMi9NMDAyLVJPQURNQVAubWQnLCBhY3RpdmVSb2FkbWFwLCB7XG4gICAgICAgIGFydGlmYWN0X3R5cGU6ICdyb2FkbWFwJyxcbiAgICAgICAgbWlsZXN0b25lX2lkOiAnTTAwMicsXG4gICAgICB9KTtcblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG5cbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucmVnaXN0cnkubGVuZ3RoLCAyLCAnbXVsdGktbXMtZGI6IHJlZ2lzdHJ5IGhhcyAyIGVudHJpZXMnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucmVnaXN0cnlbMF0/LmlkLCAnTTAwMScsICdtdWx0aS1tcy1kYjogcmVnaXN0cnlbMF0gaXMgTTAwMScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5yZWdpc3RyeVswXT8uc3RhdHVzLCAnY29tcGxldGUnLCAnbXVsdGktbXMtZGI6IE0wMDEgaXMgY29tcGxldGUnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucmVnaXN0cnlbMV0/LmlkLCAnTTAwMicsICdtdWx0aS1tcy1kYjogcmVnaXN0cnlbMV0gaXMgTTAwMicpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5yZWdpc3RyeVsxXT8uc3RhdHVzLCAnYWN0aXZlJywgJ211bHRpLW1zLWRiOiBNMDAyIGlzIGFjdGl2ZScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5hY3RpdmVNaWxlc3RvbmU/LmlkLCAnTTAwMicsICdtdWx0aS1tcy1kYjogYWN0aXZlTWlsZXN0b25lIGlzIE0wMDInKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucGhhc2UsICdwbGFubmluZycsICdtdWx0aS1tcy1kYjogcGhhc2UgaXMgcGxhbm5pbmcgKG5vIHBsYW4gZm9yIFMwMSknKTtcblxuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRlc3QgNzogQ2FjaGUgaW52YWxpZGF0aW9uIHdvcmtzIGZvciBEQiBwYXRoIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICB0ZXN0KCdkZXJpdmUtc3RhdGUtZGI6IGNhY2hlIGludmFsaWRhdGlvbicsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvTTAwMS1ST0FETUFQLm1kJywgUk9BRE1BUF9DT05URU5UKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvUzAxLVBMQU4ubWQnLCBQTEFOX0NPTlRFTlQpO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMS90YXNrcy8uZ2l0a2VlcCcsICcnKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvdGFza3MvVDAxLVBMQU4ubWQnLCAnIyBUMDEgUGxhbicpO1xuXG4gICAgICBvcGVuRGF0YWJhc2UoJzptZW1vcnk6Jyk7XG4gICAgICAvLyBJbnNlcnQgbWlsZXN0b25lL3NsaWNlL3Rhc2sgcm93cyBzbyBkZXJpdmVTdGF0ZSB0YWtlcyB0aGUgREIgcGF0aCAoIzI2MzEgZml4KVxuICAgICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdUZXN0IE1pbGVzdG9uZScsIHN0YXR1czogJ2FjdGl2ZScgfSk7XG4gICAgICBpbnNlcnRTbGljZSh7IGlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdGaXJzdCBTbGljZScsIHN0YXR1czogJ2FjdGl2ZScsIHJpc2s6ICdsb3cnLCBkZXBlbmRzOiBbXSB9KTtcbiAgICAgIGluc2VydFRhc2soeyBpZDogJ1QwMScsIHNsaWNlSWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ0ZpcnN0IFRhc2snLCBzdGF0dXM6ICdwZW5kaW5nJyB9KTtcbiAgICAgIGluc2VydEFydGlmYWN0Um93KCdtaWxlc3RvbmVzL00wMDEvTTAwMS1ST0FETUFQLm1kJywgUk9BRE1BUF9DT05URU5ULCB7XG4gICAgICAgIGFydGlmYWN0X3R5cGU6ICdyb2FkbWFwJyxcbiAgICAgICAgbWlsZXN0b25lX2lkOiAnTTAwMScsXG4gICAgICB9KTtcbiAgICAgIGluc2VydEFydGlmYWN0Um93KCdtaWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMS9TMDEtUExBTi5tZCcsIFBMQU5fQ09OVEVOVCwge1xuICAgICAgICBhcnRpZmFjdF90eXBlOiAncGxhbicsXG4gICAgICAgIG1pbGVzdG9uZV9pZDogJ00wMDEnLFxuICAgICAgICBzbGljZV9pZDogJ1MwMScsXG4gICAgICB9KTtcblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IHN0YXRlMSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZTEuYWN0aXZlVGFzaz8uaWQsICdUMDEnLCAnY2FjaGUtaW52OiBmaXJzdCBjYWxsIGdldHMgVDAxJyk7XG5cbiAgICAgIC8vIFNpbXVsYXRlIHRhc2sgY29tcGxldGlvbiBieSB1cGRhdGluZyB0aGUgcGxhbiBpbiBEQlxuICAgICAgY29uc3QgdXBkYXRlZFBsYW4gPSBQTEFOX0NPTlRFTlQucmVwbGFjZSgnLSBbIF0gKipUMDE6JywgJy0gW3hdICoqVDAxOicpO1xuICAgICAgaW5zZXJ0QXJ0aWZhY3RSb3coJ21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzAxL1MwMS1QTEFOLm1kJywgdXBkYXRlZFBsYW4sIHtcbiAgICAgICAgYXJ0aWZhY3RfdHlwZTogJ3BsYW4nLFxuICAgICAgICBtaWxlc3RvbmVfaWQ6ICdNMDAxJyxcbiAgICAgICAgc2xpY2VfaWQ6ICdTMDEnLFxuICAgICAgfSk7XG4gICAgICAvLyBBbHNvIHVwZGF0ZSBmaWxlIG9uIGRpc2sgKGNhY2hlZExvYWRGaWxlIG1heSByZWFkIGZyb20gZGlzayBmb3Igc29tZSBwYXRocylcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvUzAxLVBMQU4ubWQnLCB1cGRhdGVkUGxhbik7XG4gICAgICAvLyBVcGRhdGUgdGFzayBzdGF0dXMgaW4gREIgc28gREItcGF0aCBhbHNvIHNlZXMgY29tcGxldGlvbiAoIzI2MzEgZml4KVxuICAgICAgdXBkYXRlVGFza1N0YXR1cygnTTAwMScsICdTMDEnLCAnVDAxJywgJ2NvbXBsZXRlJyk7XG5cbiAgICAgIC8vIFdpdGhvdXQgaW52YWxpZGF0aW9uLCBzaG91bGQgcmV0dXJuIGNhY2hlZCByZXN1bHQgKFQwMSBzdGlsbCBhY3RpdmUpXG4gICAgICBjb25zdCBzdGF0ZTIgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUyLmFjdGl2ZVRhc2s/LmlkLCAnVDAxJywgJ2NhY2hlLWludjogY2FjaGVkIHJlc3VsdCBzdGlsbCBoYXMgVDAxJyk7XG5cbiAgICAgIC8vIEFmdGVyIGludmFsaWRhdGlvbiwgc2hvdWxkIHBpY2sgdXAgdXBkYXRlZCBjb250ZW50XG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUzID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlMy5waGFzZSwgJ3N1bW1hcml6aW5nJywgJ2NhY2hlLWludjogYWZ0ZXIgaW52YWxpZGF0aW9uLCBwaGFzZSBpcyBzdW1tYXJpemluZyAoYWxsIHRhc2tzIGRvbmUpJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlMy5hY3RpdmVUYXNrLCBudWxsLCAnY2FjaGUtaW52OiBhY3RpdmVUYXNrIGlzIG51bGwgYWZ0ZXIgYWxsIGRvbmUnKTtcblxuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4gIC8vIE5ldzogZGVyaXZlU3RhdGVGcm9tRGIoKSBjcm9zcy12YWxpZGF0aW9uIHRlc3RzXG4gIC8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0IDg6IFByZS1wbGFubmluZyBcdTIwMTQgbWlsZXN0b25lIGV4aXN0cywgbm8gcm9hZG1hcCwgbm8gc2xpY2VzIFx1MjUwMFx1MjUwMFx1MjUwMFxuICB0ZXN0KCdkZXJpdmUtc3RhdGUtZGI6IHByZS1wbGFubmluZyB2aWEgREInLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIC8vIENyZWF0ZSBtaWxlc3RvbmUgZGlyIG9uIGRpc2sgd2l0aCBhIENPTlRFWFQgZmlsZSAobm90IGEgZ2hvc3QpXG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9NMDAxLUNPTlRFWFQubWQnLCAnIyBNMDAxOiBGaXJzdFxcblxcblNvbWUgY29udGV4dC4nKTtcblxuICAgICAgLy8gRmlsZXN5c3RlbS1vbmx5IHN0YXRlXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3QgZmlsZVN0YXRlID0gYXdhaXQgX2Rlcml2ZVN0YXRlSW1wbChiYXNlKTtcblxuICAgICAgLy8gTm93IG9wZW4gREIsIHBvcHVsYXRlIGhpZXJhcmNoeVxuICAgICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuICAgICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdGaXJzdCcsIHN0YXR1czogJ2FjdGl2ZScgfSk7XG5cbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBkYlN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGVGcm9tRGIoYmFzZSk7XG5cbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGJTdGF0ZS5waGFzZSwgZmlsZVN0YXRlLnBoYXNlLCAncHJlLXBsYW4tZGI6IHBoYXNlIG1hdGNoZXMnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGJTdGF0ZS5hY3RpdmVNaWxlc3RvbmU/LmlkLCBmaWxlU3RhdGUuYWN0aXZlTWlsZXN0b25lPy5pZCwgJ3ByZS1wbGFuLWRiOiBhY3RpdmVNaWxlc3RvbmUuaWQgbWF0Y2hlcycpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLmFjdGl2ZVNsaWNlLCBmaWxlU3RhdGUuYWN0aXZlU2xpY2UsICdwcmUtcGxhbi1kYjogYWN0aXZlU2xpY2UgbWF0Y2hlcycpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLmFjdGl2ZVRhc2ssIGZpbGVTdGF0ZS5hY3RpdmVUYXNrLCAncHJlLXBsYW4tZGI6IGFjdGl2ZVRhc2sgbWF0Y2hlcycpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLnJlZ2lzdHJ5Lmxlbmd0aCwgZmlsZVN0YXRlLnJlZ2lzdHJ5Lmxlbmd0aCwgJ3ByZS1wbGFuLWRiOiByZWdpc3RyeSBsZW5ndGggbWF0Y2hlcycpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLnJlZ2lzdHJ5WzBdPy5zdGF0dXMsIGZpbGVTdGF0ZS5yZWdpc3RyeVswXT8uc3RhdHVzLCAncHJlLXBsYW4tZGI6IHJlZ2lzdHJ5WzBdIHN0YXR1cyBtYXRjaGVzJyk7XG5cbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0IDk6IEV4ZWN1dGluZyBcdTIwMTQgYWN0aXZlIHRhc2sgd2l0aCBwYXJ0aWFsIGNvbXBsZXRpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIHRlc3QoJ2Rlcml2ZS1zdGF0ZS1kYjogZXhlY3V0aW5nIHZpYSBEQicsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgLy8gQnVpbGQgZmlsZXN5c3RlbSBmaXh0dXJlXG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9NMDAxLVJPQURNQVAubWQnLCBST0FETUFQX0NPTlRFTlQpO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMS9TMDEtUExBTi5tZCcsIFBMQU5fQ09OVEVOVCk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzAxL3Rhc2tzLy5naXRrZWVwJywgJycpO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMS90YXNrcy9UMDEtUExBTi5tZCcsICcjIFQwMSBQbGFuJyk7XG5cbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBmaWxlU3RhdGUgPSBhd2FpdCBfZGVyaXZlU3RhdGVJbXBsKGJhc2UpO1xuXG4gICAgICAvLyBCdWlsZCBtYXRjaGluZyBEQiBzdGF0ZVxuICAgICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuICAgICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdUZXN0IE1pbGVzdG9uZScsIHN0YXR1czogJ2FjdGl2ZScgfSk7XG4gICAgICBpbnNlcnRTbGljZSh7IGlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdGaXJzdCBTbGljZScsIHN0YXR1czogJ2FjdGl2ZScsIHJpc2s6ICdsb3cnLCBkZXBlbmRzOiBbXSB9KTtcbiAgICAgIGluc2VydFNsaWNlKHsgaWQ6ICdTMDInLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ1NlY29uZCBTbGljZScsIHN0YXR1czogJ3BlbmRpbmcnLCByaXNrOiAnbG93JywgZGVwZW5kczogWydTMDEnXSB9KTtcbiAgICAgIGluc2VydFRhc2soeyBpZDogJ1QwMScsIHNsaWNlSWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ0ZpcnN0IFRhc2snLCBzdGF0dXM6ICdwZW5kaW5nJyB9KTtcbiAgICAgIGluc2VydFRhc2soeyBpZDogJ1QwMicsIHNsaWNlSWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ0RvbmUgVGFzaycsIHN0YXR1czogJ2NvbXBsZXRlJyB9KTtcblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IGRiU3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZUZyb21EYihiYXNlKTtcblxuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLnBoYXNlLCAnZXhlY3V0aW5nJywgJ2V4ZWMtZGI6IHBoYXNlIGlzIGV4ZWN1dGluZycpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQsICdNMDAxJywgJ2V4ZWMtZGI6IGFjdGl2ZU1pbGVzdG9uZSBpcyBNMDAxJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUuYWN0aXZlU2xpY2U/LmlkLCAnUzAxJywgJ2V4ZWMtZGI6IGFjdGl2ZVNsaWNlIGlzIFMwMScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLmFjdGl2ZVRhc2s/LmlkLCAnVDAxJywgJ2V4ZWMtZGI6IGFjdGl2ZVRhc2sgaXMgVDAxJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUucHJvZ3Jlc3M/LnRhc2tzPy5kb25lLCAxLCAnZXhlYy1kYjogdGFza3MuZG9uZSA9IDEnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGJTdGF0ZS5wcm9ncmVzcz8udGFza3M/LnRvdGFsLCAyLCAnZXhlYy1kYjogdGFza3MudG90YWwgPSAyJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUucGhhc2UsIGZpbGVTdGF0ZS5waGFzZSwgJ2V4ZWMtZGI6IHBoYXNlIG1hdGNoZXMgZmlsZXN5c3RlbScpO1xuXG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCAxMDogU3VtbWFyaXppbmcgXHUyMDE0IGFsbCB0YXNrcyBjb21wbGV0ZSwgbm8gc2xpY2Ugc3VtbWFyeSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgdGVzdCgnZGVyaXZlLXN0YXRlLWRiOiBzdW1tYXJpemluZyB2aWEgREInLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGFsbERvbmVQbGFuID0gYCMgUzAxOiBGaXJzdCBTbGljZVxuXG4qKkdvYWw6KiogVGVzdCBzdW1tYXJpemluZy5cbioqRGVtbzoqKiBUZXN0cyBwYXNzLlxuXG4jIyBUYXNrc1xuXG4tIFt4XSAqKlQwMTogRmlyc3QgVGFzayoqIFxcYGVzdDoxMG1cXGBcbiAgRmlyc3QgdGFzayBkZXNjcmlwdGlvbi5cblxuLSBbeF0gKipUMDI6IERvbmUgVGFzayoqIFxcYGVzdDoxMG1cXGBcbiAgQWxyZWFkeSBkb25lLlxuYDtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL00wMDEtUk9BRE1BUC5tZCcsIFJPQURNQVBfQ09OVEVOVCk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzAxL1MwMS1QTEFOLm1kJywgYWxsRG9uZVBsYW4pO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMS90YXNrcy8uZ2l0a2VlcCcsICcnKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvdGFza3MvVDAxLVBMQU4ubWQnLCAnIyBUMDEgUGxhbicpO1xuXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3QgZmlsZVN0YXRlID0gYXdhaXQgX2Rlcml2ZVN0YXRlSW1wbChiYXNlKTtcblxuICAgICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuICAgICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdUZXN0IE1pbGVzdG9uZScsIHN0YXR1czogJ2FjdGl2ZScgfSk7XG4gICAgICBpbnNlcnRTbGljZSh7IGlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdGaXJzdCBTbGljZScsIHN0YXR1czogJ2FjdGl2ZScsIHJpc2s6ICdsb3cnLCBkZXBlbmRzOiBbXSB9KTtcbiAgICAgIGluc2VydFNsaWNlKHsgaWQ6ICdTMDInLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ1NlY29uZCBTbGljZScsIHN0YXR1czogJ3BlbmRpbmcnLCByaXNrOiAnbG93JywgZGVwZW5kczogWydTMDEnXSB9KTtcbiAgICAgIGluc2VydFRhc2soeyBpZDogJ1QwMScsIHNsaWNlSWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ0ZpcnN0IFRhc2snLCBzdGF0dXM6ICdjb21wbGV0ZScgfSk7XG4gICAgICBpbnNlcnRUYXNrKHsgaWQ6ICdUMDInLCBzbGljZUlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdEb25lIFRhc2snLCBzdGF0dXM6ICdjb21wbGV0ZScgfSk7XG5cbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBkYlN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGVGcm9tRGIoYmFzZSk7XG5cbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGJTdGF0ZS5waGFzZSwgJ3N1bW1hcml6aW5nJywgJ3N1bW1hcml6ZS1kYjogcGhhc2UgaXMgc3VtbWFyaXppbmcnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGJTdGF0ZS5waGFzZSwgZmlsZVN0YXRlLnBoYXNlLCAnc3VtbWFyaXplLWRiOiBwaGFzZSBtYXRjaGVzIGZpbGVzeXN0ZW0nKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGJTdGF0ZS5hY3RpdmVTbGljZT8uaWQsICdTMDEnLCAnc3VtbWFyaXplLWRiOiBhY3RpdmVTbGljZSBpcyBTMDEnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGJTdGF0ZS5hY3RpdmVUYXNrLCBudWxsLCAnc3VtbWFyaXplLWRiOiBhY3RpdmVUYXNrIGlzIG51bGwnKTtcblxuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRlc3QgMTE6IENvbXBsZXRlIFx1MjAxNCBhbGwgbWlsZXN0b25lcyBjb21wbGV0ZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgdGVzdCgnZGVyaXZlLXN0YXRlLWRiOiBhbGwgY29tcGxldGUgdmlhIERCJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBjb21wbGV0ZWRSb2FkbWFwID0gYCMgTTAwMTogRG9uZSBNaWxlc3RvbmVcblxuKipWaXNpb246KiogQWxyZWFkeSBkb25lLlxuXG4jIyBTbGljZXNcblxuLSBbeF0gKipTMDE6IERvbmUqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXG4gID4gQWZ0ZXIgdGhpczogRG9uZS5cbmA7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9NMDAxLVJPQURNQVAubWQnLCBjb21wbGV0ZWRSb2FkbWFwKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL00wMDEtVkFMSURBVElPTi5tZCcsICctLS1cXG52ZXJkaWN0OiBwYXNzXFxucmVtZWRpYXRpb25fcm91bmQ6IDBcXG4tLS1cXG5cXG4jIFZhbGlkYXRpb25cXG5QYXNzZWQuJyk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9NMDAxLVNVTU1BUlkubWQnLCAnIyBNMDAxIFN1bW1hcnlcXG5cXG5Eb25lLicpO1xuXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3QgZmlsZVN0YXRlID0gYXdhaXQgX2Rlcml2ZVN0YXRlSW1wbChiYXNlKTtcblxuICAgICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuICAgICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdEb25lIE1pbGVzdG9uZScsIHN0YXR1czogJ2NvbXBsZXRlJyB9KTtcbiAgICAgIGluc2VydFNsaWNlKHsgaWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ0RvbmUnLCBzdGF0dXM6ICdjb21wbGV0ZScsIHJpc2s6ICdsb3cnLCBkZXBlbmRzOiBbXSB9KTtcblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IGRiU3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZUZyb21EYihiYXNlKTtcblxuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLnBoYXNlLCAnY29tcGxldGUnLCAnY29tcGxldGUtZGI6IHBoYXNlIGlzIGNvbXBsZXRlJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUucGhhc2UsIGZpbGVTdGF0ZS5waGFzZSwgJ2NvbXBsZXRlLWRiOiBwaGFzZSBtYXRjaGVzIGZpbGVzeXN0ZW0nKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGJTdGF0ZS5yZWdpc3RyeS5sZW5ndGgsIDEsICdjb21wbGV0ZS1kYjogcmVnaXN0cnkgaGFzIDEgZW50cnknKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGJTdGF0ZS5yZWdpc3RyeVswXT8uc3RhdHVzLCAnY29tcGxldGUnLCAnY29tcGxldGUtZGI6IE0wMDEgaXMgY29tcGxldGUnKTtcblxuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRlc3QgMTI6IEJsb2NrZWQgXHUyMDE0IHNsaWNlIGRlcHMgdW5tZXQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIHRlc3QoJ2Rlcml2ZS1zdGF0ZS1kYjogYmxvY2tlZCBzbGljZSB2aWEgREInLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIC8vIFJvYWRtYXAgd2l0aCBTMDIgZGVwZW5kaW5nIG9uIFMwMSwgYnV0IFMwMSBub3QgZG9uZVxuICAgICAgY29uc3QgYmxvY2tlZFJvYWRtYXAgPSBgIyBNMDAxOiBCbG9ja2VkIFRlc3RcblxuKipWaXNpb246KiogVGVzdCBibG9ja2VkIHN0YXRlLlxuXG4jIyBTbGljZXNcblxuLSBbIF0gKipTMDE6IEZpcnN0KiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbUzAyXVxcYFxuICA+IEFmdGVyIHRoaXM6IEZpcnN0IGRvbmUuXG5cbi0gWyBdICoqUzAyOiBTZWNvbmQqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltTMDFdXFxgXG4gID4gQWZ0ZXIgdGhpczogU2Vjb25kIGRvbmUuXG5gO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvTTAwMS1ST0FETUFQLm1kJywgYmxvY2tlZFJvYWRtYXApO1xuXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3QgZmlsZVN0YXRlID0gYXdhaXQgX2Rlcml2ZVN0YXRlSW1wbChiYXNlKTtcblxuICAgICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuICAgICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdCbG9ja2VkIFRlc3QnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuICAgICAgLy8gQ2lyY3VsYXIgZGVwcyBcdTIwMTQgYm90aCBkZXBlbmQgb24gZWFjaCBvdGhlciwgbmVpdGhlciBkb25lXG4gICAgICBpbnNlcnRTbGljZSh7IGlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdGaXJzdCcsIHN0YXR1czogJ3BlbmRpbmcnLCByaXNrOiAnbG93JywgZGVwZW5kczogWydTMDInXSB9KTtcbiAgICAgIGluc2VydFNsaWNlKHsgaWQ6ICdTMDInLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ1NlY29uZCcsIHN0YXR1czogJ3BlbmRpbmcnLCByaXNrOiAnbG93JywgZGVwZW5kczogWydTMDEnXSB9KTtcblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IGRiU3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZUZyb21EYihiYXNlKTtcblxuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLnBoYXNlLCAnYmxvY2tlZCcsICdibG9ja2VkLWRiOiBwaGFzZSBpcyBibG9ja2VkIHdoZW4gbm8gc2xpY2UgZGVwcyBhcmUgc2F0aXNmaWVkJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUucGhhc2UsIGZpbGVTdGF0ZS5waGFzZSwgJ2Jsb2NrZWQtZGI6IHBoYXNlIG1hdGNoZXMgZmlsZXN5c3RlbScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLmFjdGl2ZVNsaWNlLCBudWxsLCAnYmxvY2tlZC1kYjogbm8gYWN0aXZlU2xpY2UgaXMgc2VsZWN0ZWQgdGhyb3VnaCB1bm1ldCBkZXBzJyk7XG4gICAgICBhc3NlcnQub2soZGJTdGF0ZS5ibG9ja2Vycy5zb21lKGIgPT4gYi5pbmNsdWRlcygnTm8gc2xpY2UgZWxpZ2libGUnKSksICdibG9ja2VkLWRiOiBibG9ja2VyIGV4cGxhaW5zIG5vIGVsaWdpYmxlIHNsaWNlJyk7XG5cbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0IDEzOiBQYXJrZWQgbWlsZXN0b25lIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICB0ZXN0KCdkZXJpdmUtc3RhdGUtZGI6IHBhcmtlZCBtaWxlc3RvbmUgdmlhIERCJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9NMDAxLVJPQURNQVAubWQnLCBST0FETUFQX0NPTlRFTlQpO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvTTAwMS1QQVJLRUQubWQnLCAnUGFya2VkIGZvciBub3cuJyk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMi9NMDAyLUNPTlRFWFQubWQnLCAnIyBNMDAyOiBBY3RpdmUgQWZ0ZXIgUGFya1xcblxcblJlYWR5LicpO1xuXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3QgZmlsZVN0YXRlID0gYXdhaXQgX2Rlcml2ZVN0YXRlSW1wbChiYXNlKTtcblxuICAgICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuICAgICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdUZXN0IE1pbGVzdG9uZScsIHN0YXR1czogJ3BhcmtlZCcgfSk7XG4gICAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogJ00wMDInLCB0aXRsZTogJ0FjdGl2ZSBBZnRlciBQYXJrJywgc3RhdHVzOiAnYWN0aXZlJyB9KTtcblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IGRiU3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZUZyb21EYihiYXNlKTtcblxuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLnBoYXNlLCBmaWxlU3RhdGUucGhhc2UsICdwYXJrZWQtZGI6IHBoYXNlIG1hdGNoZXMgZmlsZXN5c3RlbScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQsICdNMDAyJywgJ3BhcmtlZC1kYjogYWN0aXZlTWlsZXN0b25lIGlzIE0wMDInKTtcbiAgICAgIGFzc2VydC5vayhkYlN0YXRlLnJlZ2lzdHJ5LnNvbWUoZSA9PiBlLmlkID09PSAnTTAwMScgJiYgZS5zdGF0dXMgPT09ICdwYXJrZWQnKSwgJ3BhcmtlZC1kYjogTTAwMSBpcyBwYXJrZWQgaW4gcmVnaXN0cnknKTtcblxuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRlc3QgMTQ6IFZhbGlkYXRpbmctbWlsZXN0b25lIFx1MjAxNCBhbGwgc2xpY2VzIGRvbmUsIG5vIHRlcm1pbmFsIHZhbGlkYXRpb24gXHUyNTAwXG4gIHRlc3QoJ2Rlcml2ZS1zdGF0ZS1kYjogdmFsaWRhdGluZy1taWxlc3RvbmUgdmlhIERCJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBkb25lUm9hZG1hcCA9IGAjIE0wMDE6IFZhbGlkYXRlIFRlc3RcblxuKipWaXNpb246KiogVGVzdCB2YWxpZGF0aW9uLlxuXG4jIyBTbGljZXNcblxuLSBbeF0gKipTMDE6IERvbmUgU2xpY2UqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXG4gID4gQWZ0ZXIgdGhpczogRG9uZS5cbmA7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9NMDAxLVJPQURNQVAubWQnLCBkb25lUm9hZG1hcCk7XG4gICAgICAvLyBObyBWQUxJREFUSU9OIGZpbGUgXHUyMTkyIHZhbGlkYXRpbmctbWlsZXN0b25lIHBoYXNlXG5cbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBmaWxlU3RhdGUgPSBhd2FpdCBfZGVyaXZlU3RhdGVJbXBsKGJhc2UpO1xuXG4gICAgICBvcGVuRGF0YWJhc2UoJzptZW1vcnk6Jyk7XG4gICAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogJ00wMDEnLCB0aXRsZTogJ1ZhbGlkYXRlIFRlc3QnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuICAgICAgaW5zZXJ0U2xpY2UoeyBpZDogJ1MwMScsIG1pbGVzdG9uZUlkOiAnTTAwMScsIHRpdGxlOiAnRG9uZSBTbGljZScsIHN0YXR1czogJ2NvbXBsZXRlJywgcmlzazogJ2xvdycsIGRlcGVuZHM6IFtdIH0pO1xuXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3QgZGJTdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlRnJvbURiKGJhc2UpO1xuXG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUucGhhc2UsICd2YWxpZGF0aW5nLW1pbGVzdG9uZScsICd2YWxpZGF0ZS1kYjogcGhhc2UgaXMgdmFsaWRhdGluZy1taWxlc3RvbmUnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGJTdGF0ZS5waGFzZSwgZmlsZVN0YXRlLnBoYXNlLCAndmFsaWRhdGUtZGI6IHBoYXNlIG1hdGNoZXMgZmlsZXN5c3RlbScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQsICdNMDAxJywgJ3ZhbGlkYXRlLWRiOiBhY3RpdmVNaWxlc3RvbmUgaXMgTTAwMScpO1xuXG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCAxNGI6IG5lZWRzLXJlbWVkaWF0aW9uICsgYWxsIHNsaWNlcyBkb25lIFx1MjE5MiBibG9ja2VkICgjNDUwNikgXHUyNTAwXHUyNTAwXG4gIHRlc3QoJ2Rlcml2ZS1zdGF0ZS1kYjogbmVlZHMtcmVtZWRpYXRpb24gd2l0aCBhbGwgc2xpY2VzIGRvbmUgcmV0dXJucyBibG9ja2VkICgjNDUwNiknLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGRvbmVSb2FkbWFwID0gYCMgTTAwMTogU3R1Y2sgUmVtZWRpYXRpb25cblxuKipWaXNpb246KiogVGVzdCBuZWVkcy1yZW1lZGlhdGlvbiBsb29wIGd1YXJkLlxuXG4jIyBTbGljZXNcblxuLSBbeF0gKipTMDE6IERvbmUgU2xpY2UqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXG4gID4gQWZ0ZXIgdGhpczogRG9uZS5cbmA7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9NMDAxLVJPQURNQVAubWQnLCBkb25lUm9hZG1hcCk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9NMDAxLVZBTElEQVRJT04ubWQnLFxuICAgICAgICAnLS0tXFxudmVyZGljdDogbmVlZHMtcmVtZWRpYXRpb25cXG5yZW1lZGlhdGlvbl9yb3VuZDogMVxcbi0tLVxcblxcbiMgVmFsaWRhdGlvblxcbk5lZWRzIGZpeGVzLicpO1xuXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3QgZmlsZVN0YXRlID0gYXdhaXQgX2Rlcml2ZVN0YXRlSW1wbChiYXNlKTtcblxuICAgICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuICAgICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdTdHVjayBSZW1lZGlhdGlvbicsIHN0YXR1czogJ2FjdGl2ZScgfSk7XG4gICAgICBpbnNlcnRTbGljZSh7IGlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdEb25lIFNsaWNlJywgc3RhdHVzOiAnY29tcGxldGUnLCByaXNrOiAnbG93JywgZGVwZW5kczogW10gfSk7XG4gICAgICBpbnNlcnRBc3Nlc3NtZW50KHtcbiAgICAgICAgcGF0aDogJ21pbGVzdG9uZXMvTTAwMS9NMDAxLVZBTElEQVRJT04ubWQnLFxuICAgICAgICBtaWxlc3RvbmVJZDogJ00wMDEnLFxuICAgICAgICBzdGF0dXM6ICduZWVkcy1yZW1lZGlhdGlvbicsXG4gICAgICAgIHNjb3BlOiAnbWlsZXN0b25lLXZhbGlkYXRpb24nLFxuICAgICAgICBmdWxsQ29udGVudDogJ3ZlcmRpY3Q6IG5lZWRzLXJlbWVkaWF0aW9uJyxcbiAgICAgIH0pO1xuXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3QgZGJTdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlRnJvbURiKGJhc2UpO1xuXG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUucGhhc2UsICdibG9ja2VkJywgJ3JlbWVkaWF0aW9uLXN0dWNrLWRiOiBwaGFzZSBpcyBibG9ja2VkJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUucGhhc2UsIGZpbGVTdGF0ZS5waGFzZSwgJ3JlbWVkaWF0aW9uLXN0dWNrLWRiOiBwaGFzZSBtYXRjaGVzIGZpbGVzeXN0ZW0nKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGJTdGF0ZS5hY3RpdmVNaWxlc3RvbmU/LmlkLCAnTTAwMScsICdyZW1lZGlhdGlvbi1zdHVjay1kYjogYWN0aXZlTWlsZXN0b25lIGlzIE0wMDEnKTtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgZGJTdGF0ZS5ibG9ja2Vycy5zb21lKGIgPT4gYi5pbmNsdWRlcygnbmVlZHMtcmVtZWRpYXRpb24nKSAmJiBiLmluY2x1ZGVzKCdNMDAxJykpLFxuICAgICAgICAncmVtZWRpYXRpb24tc3R1Y2stZGI6IGJsb2NrZXIgbWVzc2FnZSBtZW50aW9ucyBtaWxlc3RvbmUgYW5kIHZlcmRpY3QnLFxuICAgICAgKTtcblxuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRlc3QgMTU6IENvbXBsZXRpbmctbWlsZXN0b25lIFx1MjAxNCB0ZXJtaW5hbCB2YWxpZGF0aW9uLCBubyBzdW1tYXJ5IFx1MjUwMFx1MjUwMFxuICB0ZXN0KCdkZXJpdmUtc3RhdGUtZGI6IGNvbXBsZXRpbmctbWlsZXN0b25lIHZpYSBEQicsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgZG9uZVJvYWRtYXAgPSBgIyBNMDAxOiBDb21wbGV0ZSBUZXN0XG5cbioqVmlzaW9uOioqIFRlc3QgY29tcGxldGlvbi5cblxuIyMgU2xpY2VzXG5cbi0gW3hdICoqUzAxOiBEb25lIFNsaWNlKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbXVxcYFxuICA+IEFmdGVyIHRoaXM6IERvbmUuXG5gO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvTTAwMS1ST0FETUFQLm1kJywgZG9uZVJvYWRtYXApO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvTTAwMS1WQUxJREFUSU9OLm1kJywgJy0tLVxcbnZlcmRpY3Q6IHBhc3NcXG5yZW1lZGlhdGlvbl9yb3VuZDogMFxcbi0tLVxcblxcbiMgVmFsaWRhdGlvblxcblBhc3NlZC4nKTtcblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IGZpbGVTdGF0ZSA9IGF3YWl0IF9kZXJpdmVTdGF0ZUltcGwoYmFzZSk7XG5cbiAgICAgIG9wZW5EYXRhYmFzZSgnOm1lbW9yeTonKTtcbiAgICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiAnTTAwMScsIHRpdGxlOiAnQ29tcGxldGUgVGVzdCcsIHN0YXR1czogJ2FjdGl2ZScgfSk7XG4gICAgICBpbnNlcnRTbGljZSh7IGlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdEb25lIFNsaWNlJywgc3RhdHVzOiAnY29tcGxldGUnLCByaXNrOiAnbG93JywgZGVwZW5kczogW10gfSk7XG4gICAgICBpbnNlcnRBc3Nlc3NtZW50KHtcbiAgICAgICAgcGF0aDogJ21pbGVzdG9uZXMvTTAwMS9NMDAxLVZBTElEQVRJT04ubWQnLFxuICAgICAgICBtaWxlc3RvbmVJZDogJ00wMDEnLFxuICAgICAgICBzdGF0dXM6ICdwYXNzJyxcbiAgICAgICAgc2NvcGU6ICdtaWxlc3RvbmUtdmFsaWRhdGlvbicsXG4gICAgICAgIGZ1bGxDb250ZW50OiAndmVyZGljdDogcGFzcycsXG4gICAgICB9KTtcblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IGRiU3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZUZyb21EYihiYXNlKTtcblxuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLnBoYXNlLCAnY29tcGxldGluZy1taWxlc3RvbmUnLCAnY29tcGxldGluZy1kYjogcGhhc2UgaXMgY29tcGxldGluZy1taWxlc3RvbmUnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGJTdGF0ZS5waGFzZSwgZmlsZVN0YXRlLnBoYXNlLCAnY29tcGxldGluZy1kYjogcGhhc2UgbWF0Y2hlcyBmaWxlc3lzdGVtJyk7XG5cbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0IDE2OiBSZXBsYW5uaW5nLXNsaWNlIFx1MjAxNCBSRVBMQU4tVFJJR0dFUiBmaWxlIGV4aXN0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgdGVzdCgnZGVyaXZlLXN0YXRlLWRiOiByZXBsYW5uaW5nLXNsaWNlIHZpYSBEQicsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvTTAwMS1ST0FETUFQLm1kJywgUk9BRE1BUF9DT05URU5UKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvUzAxLVBMQU4ubWQnLCBQTEFOX0NPTlRFTlQpO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMS90YXNrcy8uZ2l0a2VlcCcsICcnKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvdGFza3MvVDAxLVBMQU4ubWQnLCAnIyBUMDEgUGxhbicpO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMS9TMDEtUkVQTEFOLVRSSUdHRVIubWQnLCAnUmVwbGFuIHRyaWdnZXJlZC4nKTtcblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IGZpbGVTdGF0ZSA9IGF3YWl0IF9kZXJpdmVTdGF0ZUltcGwoYmFzZSk7XG5cbiAgICAgIG9wZW5EYXRhYmFzZSgnOm1lbW9yeTonKTtcbiAgICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiAnTTAwMScsIHRpdGxlOiAnVGVzdCBNaWxlc3RvbmUnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuICAgICAgaW5zZXJ0U2xpY2UoeyBpZDogJ1MwMScsIG1pbGVzdG9uZUlkOiAnTTAwMScsIHRpdGxlOiAnRmlyc3QgU2xpY2UnLCBzdGF0dXM6ICdhY3RpdmUnLCByaXNrOiAnbG93JywgZGVwZW5kczogW10gfSk7XG4gICAgICBpbnNlcnRTbGljZSh7IGlkOiAnUzAyJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdTZWNvbmQgU2xpY2UnLCBzdGF0dXM6ICdwZW5kaW5nJywgcmlzazogJ2xvdycsIGRlcGVuZHM6IFsnUzAxJ10gfSk7XG4gICAgICBpbnNlcnRUYXNrKHsgaWQ6ICdUMDEnLCBzbGljZUlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdGaXJzdCBUYXNrJywgc3RhdHVzOiAncGVuZGluZycgfSk7XG4gICAgICBpbnNlcnRUYXNrKHsgaWQ6ICdUMDInLCBzbGljZUlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdEb25lIFRhc2snLCBzdGF0dXM6ICdjb21wbGV0ZScgfSk7XG5cbiAgICAgIC8vIFNlZWQgdGhlIHJlcGxhbl90cmlnZ2VyZWRfYXQgY29sdW1uIFx1MjAxNCBEQiBwYXRoIHVzZXMgY29sdW1uIGluc3RlYWQgb2YgZGlzayBmaWxlXG4gICAgICBjb25zdCB7IF9nZXRBZGFwdGVyIH0gPSBhd2FpdCBpbXBvcnQoJy4uL2dzZC1kYi50cycpO1xuICAgICAgY29uc3QgYWRhcHRlciA9IF9nZXRBZGFwdGVyKCk7XG4gICAgICBhZGFwdGVyIS5wcmVwYXJlKFxuICAgICAgICBcIlVQREFURSBzbGljZXMgU0VUIHJlcGxhbl90cmlnZ2VyZWRfYXQgPSA6dHMgV0hFUkUgbWlsZXN0b25lX2lkID0gOm1pZCBBTkQgaWQgPSA6c2lkXCIsXG4gICAgICApLnJ1bih7IFwiOnRzXCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSwgXCI6bWlkXCI6IFwiTTAwMVwiLCBcIjpzaWRcIjogXCJTMDFcIiB9KTtcblxuXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3QgZGJTdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlRnJvbURiKGJhc2UpO1xuXG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUucGhhc2UsICdyZXBsYW5uaW5nLXNsaWNlJywgJ3JlcGxhbi1kYjogcGhhc2UgaXMgcmVwbGFubmluZy1zbGljZScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLnBoYXNlLCBmaWxlU3RhdGUucGhhc2UsICdyZXBsYW4tZGI6IHBoYXNlIG1hdGNoZXMgZmlsZXN5c3RlbScpO1xuXG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCAxNzogUGVyZm9ybWFuY2UgXHUyMDE0IGRlcml2ZVN0YXRlRnJvbURiIDwgMW1zIG9uIHBvcHVsYXRlZCBEQiBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgdGVzdCgnZGVyaXZlLXN0YXRlLWRiOiBwZXJmb3JtYW5jZSBhc3NlcnRpb24nLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL00wMDEtUk9BRE1BUC5tZCcsIFJPQURNQVBfQ09OVEVOVCk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzAxL1MwMS1QTEFOLm1kJywgUExBTl9DT05URU5UKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvdGFza3MvLmdpdGtlZXAnLCAnJyk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzAxL3Rhc2tzL1QwMS1QTEFOLm1kJywgJyMgVDAxIFBsYW4nKTtcblxuICAgICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuICAgICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdUZXN0IE1pbGVzdG9uZScsIHN0YXR1czogJ2FjdGl2ZScgfSk7XG4gICAgICBpbnNlcnRTbGljZSh7IGlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdGaXJzdCBTbGljZScsIHN0YXR1czogJ2FjdGl2ZScsIHJpc2s6ICdsb3cnLCBkZXBlbmRzOiBbXSB9KTtcbiAgICAgIGluc2VydFNsaWNlKHsgaWQ6ICdTMDInLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ1NlY29uZCBTbGljZScsIHN0YXR1czogJ3BlbmRpbmcnLCByaXNrOiAnbG93JywgZGVwZW5kczogWydTMDEnXSB9KTtcbiAgICAgIGluc2VydFRhc2soeyBpZDogJ1QwMScsIHNsaWNlSWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ0ZpcnN0IFRhc2snLCBzdGF0dXM6ICdwZW5kaW5nJyB9KTtcbiAgICAgIGluc2VydFRhc2soeyBpZDogJ1QwMicsIHNsaWNlSWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ0RvbmUgVGFzaycsIHN0YXR1czogJ2NvbXBsZXRlJyB9KTtcblxuICAgICAgLy8gV2FybSB1cCAoZmlyc3QgY2FsbCBtYXkgaW5jdXIgZmlsZXN5c3RlbSBJTyBmb3IgZmxhZyBmaWxlIGNoZWNrcylcbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBhd2FpdCBkZXJpdmVTdGF0ZUZyb21EYihiYXNlKTtcblxuICAgICAgLy8gVGltZWQgcnVuXG4gICAgICBjb25zdCBzdGFydCA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGF3YWl0IGRlcml2ZVN0YXRlRnJvbURiKGJhc2UpO1xuICAgICAgY29uc3QgZWxhcHNlZCA9IHBlcmZvcm1hbmNlLm5vdygpIC0gc3RhcnQ7XG5cbiAgICAgIGNvbnNvbGUubG9nKGAgIGRlcml2ZVN0YXRlRnJvbURiKCkgdG9vayAke2VsYXBzZWQudG9GaXhlZCgzKX1tc2ApO1xuICAgICAgLy8gVXNlIDI1bXMgdGhyZXNob2xkIFx1MjAxNCBjYXRjaGVzIHJlYWwgcmVncmVzc2lvbnMgd2l0aG91dCBmbGFraW5nIG9uXG4gICAgICAvLyBzbG93ZXIgQ0kgcnVubmVycyAoV2luZG93cyBhZ2VudHMgbWVhc3VyZWQgYXQgfjEybXMgdW5kZXIgbG9hZDtcbiAgICAgIC8vIHRoZSAxMG1zIHRocmVzaG9sZCB3YXMgdG9vIHRpZ2h0IGZvciB0aG9zZSBlbnZpcm9ubWVudHMpLlxuICAgICAgYXNzZXJ0Lm9rKGVsYXBzZWQgPCAyNSwgYHBlcmYtZGI6IGRlcml2ZVN0YXRlRnJvbURiKCkgPDI1bXMgKGdvdCAke2VsYXBzZWQudG9GaXhlZCgzKX1tcylgKTtcblxuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRlc3QgMTg6IE11bHRpLW1pbGVzdG9uZSB3aXRoIGRlcHMgXHUyMDE0IE0wMDEgY29tcGxldGUsIE0wMDIgZGVwZW5kcyBvbiBNMDAxLCBNMDAzIGRlcGVuZHMgb24gTTAwMiBcdTI1MDBcbiAgdGVzdCgnZGVyaXZlLXN0YXRlLWRiOiBtdWx0aS1taWxlc3RvbmUgZGVwcyB2aWEgREInLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IG0xUm9hZG1hcCA9IGAjIE0wMDE6IEZpcnN0XG5cbioqVmlzaW9uOioqIEZpcnN0LlxuXG4jIyBTbGljZXNcblxuLSBbeF0gKipTMDE6IERvbmUqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXG4gID4gQWZ0ZXIgdGhpczogRG9uZS5cbmA7XG4gICAgICBjb25zdCBtMlJvYWRtYXAgPSBgIyBNMDAyOiBTZWNvbmRcblxuKipWaXNpb246KiogU2Vjb25kLlxuXG4jIyBTbGljZXNcblxuLSBbIF0gKipTMDE6IEFjdGl2ZSoqIFxcYHJpc2s6bG93XFxgIFxcYGRlcGVuZHM6W11cXGBcbiAgPiBBZnRlciB0aGlzOiBEb25lLlxuYDtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL00wMDEtUk9BRE1BUC5tZCcsIG0xUm9hZG1hcCk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9NMDAxLVZBTElEQVRJT04ubWQnLCAnLS0tXFxudmVyZGljdDogcGFzc1xcbnJlbWVkaWF0aW9uX3JvdW5kOiAwXFxuLS0tXFxuXFxuUGFzc2VkLicpO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvTTAwMS1TVU1NQVJZLm1kJywgJyMgTTAwMSBTdW1tYXJ5XFxuXFxuRG9uZS4nKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAyL00wMDItUk9BRE1BUC5tZCcsIG0yUm9hZG1hcCk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMi9NMDAyLUNPTlRFWFQubWQnLCAnLS0tXFxuZGVwZW5kc19vbjpcXG4gIC0gTTAwMVxcbi0tLVxcblxcbiMgTTAwMjogU2Vjb25kXFxuXFxuRGVwZW5kcyBvbiBNMDAxLicpO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDMvTTAwMy1DT05URVhULm1kJywgJy0tLVxcbmRlcGVuZHNfb246XFxuICAtIE0wMDJcXG4tLS1cXG5cXG4jIE0wMDM6IFRoaXJkXFxuXFxuRGVwZW5kcyBvbiBNMDAyLicpO1xuXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3QgZmlsZVN0YXRlID0gYXdhaXQgX2Rlcml2ZVN0YXRlSW1wbChiYXNlKTtcblxuICAgICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuICAgICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdGaXJzdCcsIHN0YXR1czogJ2NvbXBsZXRlJywgZGVwZW5kc19vbjogW10gfSk7XG4gICAgICBpbnNlcnRTbGljZSh7IGlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdEb25lJywgc3RhdHVzOiAnY29tcGxldGUnLCByaXNrOiAnbG93JywgZGVwZW5kczogW10gfSk7XG4gICAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogJ00wMDInLCB0aXRsZTogJ1NlY29uZCcsIHN0YXR1czogJ2FjdGl2ZScsIGRlcGVuZHNfb246IFsnTTAwMSddIH0pO1xuICAgICAgaW5zZXJ0U2xpY2UoeyBpZDogJ1MwMScsIG1pbGVzdG9uZUlkOiAnTTAwMicsIHRpdGxlOiAnQWN0aXZlJywgc3RhdHVzOiAncGVuZGluZycsIHJpc2s6ICdsb3cnLCBkZXBlbmRzOiBbXSB9KTtcbiAgICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiAnTTAwMycsIHRpdGxlOiAnVGhpcmQnLCBzdGF0dXM6ICdhY3RpdmUnLCBkZXBlbmRzX29uOiBbJ00wMDInXSB9KTtcblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IGRiU3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZUZyb21EYihiYXNlKTtcblxuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLnJlZ2lzdHJ5Lmxlbmd0aCwgZmlsZVN0YXRlLnJlZ2lzdHJ5Lmxlbmd0aCwgJ211bHRpLWRlcHMtZGI6IHJlZ2lzdHJ5IGxlbmd0aCBtYXRjaGVzJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUuYWN0aXZlTWlsZXN0b25lPy5pZCwgJ00wMDInLCAnbXVsdGktZGVwcy1kYjogYWN0aXZlTWlsZXN0b25lIGlzIE0wMDIgKE0wMDEgY29tcGxldGUsIE0wMDMgZGVwIHVubWV0KScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQsIGZpbGVTdGF0ZS5hY3RpdmVNaWxlc3RvbmU/LmlkLCAnbXVsdGktZGVwcy1kYjogYWN0aXZlTWlsZXN0b25lIG1hdGNoZXMgZmlsZXN5c3RlbScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLnBoYXNlLCBmaWxlU3RhdGUucGhhc2UsICdtdWx0aS1kZXBzLWRiOiBwaGFzZSBtYXRjaGVzIGZpbGVzeXN0ZW0nKTtcblxuICAgICAgLy8gQ2hlY2sgcmVnaXN0cnkgc3RhdHVzZXNcbiAgICAgIGNvbnN0IG0xcmVnID0gZGJTdGF0ZS5yZWdpc3RyeS5maW5kKGUgPT4gZS5pZCA9PT0gJ00wMDEnKTtcbiAgICAgIGNvbnN0IG0ycmVnID0gZGJTdGF0ZS5yZWdpc3RyeS5maW5kKGUgPT4gZS5pZCA9PT0gJ00wMDInKTtcbiAgICAgIGNvbnN0IG0zcmVnID0gZGJTdGF0ZS5yZWdpc3RyeS5maW5kKGUgPT4gZS5pZCA9PT0gJ00wMDMnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwobTFyZWc/LnN0YXR1cywgJ2NvbXBsZXRlJywgJ211bHRpLWRlcHMtZGI6IE0wMDEgaXMgY29tcGxldGUnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwobTJyZWc/LnN0YXR1cywgJ2FjdGl2ZScsICdtdWx0aS1kZXBzLWRiOiBNMDAyIGlzIGFjdGl2ZScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChtM3JlZz8uc3RhdHVzLCAncGVuZGluZycsICdtdWx0aS1kZXBzLWRiOiBNMDAzIGlzIHBlbmRpbmcgKGRlcCBNMDAyIHVubWV0KScpO1xuXG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCAxOTogSzAwMiBcdTIwMTQgYm90aCAnY29tcGxldGUnIGFuZCAnZG9uZScgdHJlYXRlZCBhcyBkb25lIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICB0ZXN0KCdkZXJpdmUtc3RhdGUtZGI6IEswMDIgc3RhdHVzIGhhbmRsaW5nJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9NMDAxLVJPQURNQVAubWQnLCBST0FETUFQX0NPTlRFTlQpO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMS9TMDEtUExBTi5tZCcsIFBMQU5fQ09OVEVOVCk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzAxL3Rhc2tzLy5naXRrZWVwJywgJycpO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMS90YXNrcy9UMDEtUExBTi5tZCcsICcjIFQwMSBQbGFuJyk7XG5cbiAgICAgIG9wZW5EYXRhYmFzZSgnOm1lbW9yeTonKTtcbiAgICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiAnTTAwMScsIHRpdGxlOiAnVGVzdCBNaWxlc3RvbmUnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuICAgICAgaW5zZXJ0U2xpY2UoeyBpZDogJ1MwMScsIG1pbGVzdG9uZUlkOiAnTTAwMScsIHRpdGxlOiAnRmlyc3QgU2xpY2UnLCBzdGF0dXM6ICdhY3RpdmUnLCByaXNrOiAnbG93JywgZGVwZW5kczogW10gfSk7XG4gICAgICBpbnNlcnRTbGljZSh7IGlkOiAnUzAyJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdTZWNvbmQgU2xpY2UnLCBzdGF0dXM6ICdwZW5kaW5nJywgcmlzazogJ2xvdycsIGRlcGVuZHM6IFsnUzAxJ10gfSk7XG4gICAgICAvLyBVc2UgJ2RvbmUnIHN0YXR1cyAodGhlIGFsdGVybmF0aXZlIGZyb20gSzAwMilcbiAgICAgIGluc2VydFRhc2soeyBpZDogJ1QwMScsIHNsaWNlSWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ0ZpcnN0IFRhc2snLCBzdGF0dXM6ICdwZW5kaW5nJyB9KTtcbiAgICAgIGluc2VydFRhc2soeyBpZDogJ1QwMicsIHNsaWNlSWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ0RvbmUgVGFzaycsIHN0YXR1czogJ2RvbmUnIH0pO1xuXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3QgZGJTdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlRnJvbURiKGJhc2UpO1xuXG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUucGhhc2UsICdleGVjdXRpbmcnLCAnazAwMi1kYjogcGhhc2UgaXMgZXhlY3V0aW5nJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUuYWN0aXZlVGFzaz8uaWQsICdUMDEnLCAnazAwMi1kYjogYWN0aXZlVGFzayBpcyBUMDEgKFQwMiBkb25lKScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLnByb2dyZXNzPy50YXNrcz8uZG9uZSwgMSwgJ2swMDItZGI6IHRhc2tzLmRvbmUgY291bnRzIGRvbmUgc3RhdHVzJyk7XG5cbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0IDIwOiBEdWFsLXBhdGggd2lyaW5nIFx1MjAxNCBkZXJpdmVTdGF0ZSgpIHVzZXMgREIgd2hlbiBwb3B1bGF0ZWQgXHUyNTAwXG4gIHRlc3QoJ2Rlcml2ZS1zdGF0ZS1kYjogZHVhbC1wYXRoIHdpcmluZycsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvTTAwMS1ST0FETUFQLm1kJywgUk9BRE1BUF9DT05URU5UKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvUzAxLVBMQU4ubWQnLCBQTEFOX0NPTlRFTlQpO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMS90YXNrcy8uZ2l0a2VlcCcsICcnKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvdGFza3MvVDAxLVBMQU4ubWQnLCAnIyBUMDEgUGxhbicpO1xuXG4gICAgICBvcGVuRGF0YWJhc2UoJzptZW1vcnk6Jyk7XG4gICAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogJ00wMDEnLCB0aXRsZTogJ1Rlc3QgTWlsZXN0b25lJywgc3RhdHVzOiAnYWN0aXZlJyB9KTtcbiAgICAgIGluc2VydFNsaWNlKHsgaWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ0ZpcnN0IFNsaWNlJywgc3RhdHVzOiAnYWN0aXZlJywgcmlzazogJ2xvdycsIGRlcGVuZHM6IFtdIH0pO1xuICAgICAgaW5zZXJ0U2xpY2UoeyBpZDogJ1MwMicsIG1pbGVzdG9uZUlkOiAnTTAwMScsIHRpdGxlOiAnU2Vjb25kIFNsaWNlJywgc3RhdHVzOiAncGVuZGluZycsIHJpc2s6ICdsb3cnLCBkZXBlbmRzOiBbJ1MwMSddIH0pO1xuICAgICAgaW5zZXJ0VGFzayh7IGlkOiAnVDAxJywgc2xpY2VJZDogJ1MwMScsIG1pbGVzdG9uZUlkOiAnTTAwMScsIHRpdGxlOiAnRmlyc3QgVGFzaycsIHN0YXR1czogJ3BlbmRpbmcnIH0pO1xuICAgICAgaW5zZXJ0VGFzayh7IGlkOiAnVDAyJywgc2xpY2VJZDogJ1MwMScsIG1pbGVzdG9uZUlkOiAnTTAwMScsIHRpdGxlOiAnRG9uZSBUYXNrJywgc3RhdHVzOiAnY29tcGxldGUnIH0pO1xuXG4gICAgICAvLyBkZXJpdmVTdGF0ZSgpIHNob3VsZCBhdXRvbWF0aWNhbGx5IHVzZSBEQiBwYXRoIHNpbmNlIG1pbGVzdG9uZXMgdGFibGUgaXMgcG9wdWxhdGVkXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcblxuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5waGFzZSwgJ2V4ZWN1dGluZycsICdkdWFsLXBhdGg6IHBoYXNlIGlzIGV4ZWN1dGluZycpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5hY3RpdmVNaWxlc3RvbmU/LmlkLCAnTTAwMScsICdkdWFsLXBhdGg6IGFjdGl2ZU1pbGVzdG9uZSBpcyBNMDAxJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLmFjdGl2ZVNsaWNlPy5pZCwgJ1MwMScsICdkdWFsLXBhdGg6IGFjdGl2ZVNsaWNlIGlzIFMwMScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5hY3RpdmVUYXNrPy5pZCwgJ1QwMScsICdkdWFsLXBhdGg6IGFjdGl2ZVRhc2sgaXMgVDAxJyk7XG5cbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0IDIxOiBHaG9zdCBtaWxlc3RvbmUgc2tpcHBlZCAobm8gREIgcm93LCBubyB3b3JrdHJlZSkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIHRlc3QoJ2Rlcml2ZS1zdGF0ZS1kYjogZ2hvc3QgbWlsZXN0b25lIHNraXBwZWQgd2hlbiBubyBEQiByb3cgYW5kIG5vIHdvcmt0cmVlJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICAvLyBHaG9zdDogbWlsZXN0b25lIGRpciBleGlzdHMgd2l0aCBvbmx5IE1FVEEuanNvbiwgbm8gY29udGV4dC9yb2FkbWFwL3N1bW1hcnlcbiAgICAgIG1rZGlyU3luYyhqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgJ00wMDEnLCAnTUVUQS5qc29uJyksICd7fScpO1xuICAgICAgLy8gUmVhbCBtaWxlc3RvbmVcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAyL00wMDItQ09OVEVYVC5tZCcsICcjIE0wMDI6IFJlYWxcXG5cXG5SZWFsIG1pbGVzdG9uZS4nKTtcblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IGZpbGVTdGF0ZSA9IGF3YWl0IF9kZXJpdmVTdGF0ZUltcGwoYmFzZSk7XG5cbiAgICAgIG9wZW5EYXRhYmFzZSgnOm1lbW9yeTonKTtcbiAgICAgIC8vIE9ubHkgaW5zZXJ0IE0wMDIgXHUyMDE0IE0wMDEgaGFzIG5vIERCIHJvdyAoc2ltdWxhdGVzIHJvdyBsb3NzIC8gbmV2ZXIgaW5zZXJ0ZWQpXG4gICAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogJ00wMDInLCB0aXRsZTogJ1JlYWwnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3QgZGJTdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlRnJvbURiKGJhc2UpO1xuXG4gICAgICAvLyBHaG9zdCBzaG91bGQgYmUgc2tpcHBlZCBcdTIwMTQgTTAwMiBzaG91bGQgYmUgYWN0aXZlXG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUuYWN0aXZlTWlsZXN0b25lPy5pZCwgJ00wMDInLCAnZ2hvc3QtZGI6IGFjdGl2ZU1pbGVzdG9uZSBpcyBNMDAyIChnaG9zdCBza2lwcGVkKScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQsIGZpbGVTdGF0ZS5hY3RpdmVNaWxlc3RvbmU/LmlkLCAnZ2hvc3QtZGI6IG1hdGNoZXMgZmlsZXN5c3RlbScpO1xuICAgICAgLy8gR2hvc3Qgc2hvdWxkIG5vdCBhcHBlYXIgaW4gcmVnaXN0cnlcbiAgICAgIGFzc2VydC5vayghZGJTdGF0ZS5yZWdpc3RyeS5zb21lKGUgPT4gZS5pZCA9PT0gJ00wMDEnKSwgJ2dob3N0LWRiOiBNMDAxIG5vdCBpbiByZWdpc3RyeScpO1xuXG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCAyMjogTmVlZHMtZGlzY3Vzc2lvbiBcdTIwMTQgREIgc3RhdHVzLCBub3QgQ09OVEVYVC1EUkFGVCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgdGVzdCgnZGVyaXZlLXN0YXRlLWRiOiBuZWVkcy1kaXNjdXNzaW9uIHZpYSBEQiBzdGF0dXMnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL00wMDEtQ09OVEVYVC1EUkFGVC5tZCcsICcjIE0wMDE6IERyYWZ0XFxuXFxuRHJhZnQgY29udGVudC4nKTtcblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IGZpbGVTdGF0ZSA9IGF3YWl0IF9kZXJpdmVTdGF0ZUltcGwoYmFzZSk7XG5cbiAgICAgIG9wZW5EYXRhYmFzZSgnOm1lbW9yeTonKTtcbiAgICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiAnTTAwMScsIHRpdGxlOiAnRHJhZnQnLCBzdGF0dXM6ICduZWVkcy1kaXNjdXNzaW9uJyB9KTtcblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IGRiU3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZUZyb21EYihiYXNlKTtcblxuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLnBoYXNlLCAnbmVlZHMtZGlzY3Vzc2lvbicsICdkaXNjdXNzLWRiOiBwaGFzZSBpcyBuZWVkcy1kaXNjdXNzaW9uJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUucGhhc2UsIGZpbGVTdGF0ZS5waGFzZSwgJ2Rpc2N1c3MtZGI6IHBoYXNlIG1hdGNoZXMgZmlsZXN5c3RlbScpO1xuXG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgUmVncmVzc2lvbjogZGlzay1vbmx5IG1pbGVzdG9uZXMgc3luY2VkIGludG8gREIgKCMyNDE2KSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgdGVzdCgnZGVyaXZlLXN0YXRlLWRiOiBkaXNrLW9ubHkgbWlsZXN0b25lIGF1dG8tc3luY2VkIGludG8gREIgKCMyNDE2KScsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgLy8gTTAwMSBpcyBjb21wbGV0ZSBhbmQgZXhpc3RzIGluIERCLiBNMDAyIGlzIGRpc2stb25seSBcdTIwMTQgbm8gREIgcm93LlxuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvTTAwMS1TVU1NQVJZLm1kJywgJyMgTTAwMSBTdW1tYXJ5XFxuXFxuRG9uZS4nKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAyL00wMDItQ09OVEVYVC5tZCcsICcjIE0wMDI6IFF1ZXVlZFxcblxcblF1ZXVlZCBtaWxlc3RvbmUuJyk7XG5cbiAgICAgIG9wZW5EYXRhYmFzZSgnOm1lbW9yeTonKTtcbiAgICAgIC8vIE9ubHkgaW5zZXJ0IE0wMDEgXHUyMDE0IHNpbXVsYXRlcyB0aGUgc3RhdGUgYWZ0ZXIgbWlncmF0aW9uIGd1YXJkIHJhbiB0aGVuIC9nc2QgcXVldWUgYWRkZWQgTTAwMlxuICAgICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdGaXJzdCcsIHN0YXR1czogJ2NvbXBsZXRlJyB9KTtcblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGVGcm9tRGIoYmFzZSk7XG5cbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucGhhc2UsICdjb21wbGV0ZScsICdkaXNrLXN5bmMtMjQxNjogZGlzay1vbmx5IG1pbGVzdG9uZSBpcyBub3QgaW1wb3J0ZWQnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucmVnaXN0cnkubGVuZ3RoLCAxLCAnZGlzay1zeW5jLTI0MTY6IG9ubHkgREIgbWlsZXN0b25lcyB2aXNpYmxlIGluIHJlZ2lzdHJ5Jyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnJlZ2lzdHJ5WzBdPy5pZCwgJ00wMDEnLCAnZGlzay1zeW5jLTI0MTY6IHJlZ2lzdHJ5WzBdIGlzIE0wMDEnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucmVnaXN0cnlbMF0/LnN0YXR1cywgJ2NvbXBsZXRlJywgJ2Rpc2stc3luYy0yNDE2OiBNMDAxIGlzIGNvbXBsZXRlJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnJlZ2lzdHJ5WzFdLCB1bmRlZmluZWQsICdkaXNrLXN5bmMtMjQxNjogTTAwMiByZW1haW5zIGFic2VudCB3aXRob3V0IGV4cGxpY2l0IGltcG9ydCcpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5hY3RpdmVNaWxlc3RvbmUsIG51bGwsICdkaXNrLXN5bmMtMjQxNjogbm8gYWN0aXZlIG1pbGVzdG9uZSBmcm9tIGRpc2stb25seSByb3cnKTtcblxuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFF1ZXVlZCBtaWxlc3RvbmUgcm93IG5vdCBjbG9iYmVyZWQgYnkgbGF0ZXIgcGxhbiAoIzI0MTYgcm9vdCBjYXVzZSkgXHUyNTAwXHUyNTAwXG4gIHRlc3QoJ2Rlcml2ZS1zdGF0ZS1kYjogcXVldWVkIG1pbGVzdG9uZSByb3cgc3Vydml2ZXMgZ3NkX3BsYW5fbWlsZXN0b25lIElOU0VSVCBPUiBJR05PUkUnLCBhc3luYyAoKSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIG9wZW5EYXRhYmFzZSgnOm1lbW9yeTonKTtcblxuICAgICAgLy8gU2ltdWxhdGVzIGdzZF9taWxlc3RvbmVfZ2VuZXJhdGVfaWQgaW5zZXJ0aW5nIGEgbWluaW1hbCBxdWV1ZWQgcm93XG4gICAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogJ00wMDEnLCBzdGF0dXM6ICdxdWV1ZWQnIH0pO1xuXG4gICAgICBjb25zdCBiZWZvcmUgPSBnZXRBbGxNaWxlc3RvbmVzKCk7XG4gICAgICBhc3NlcnQuZXF1YWwoYmVmb3JlLmxlbmd0aCwgMSwgJ3F1ZXVlZC1yb3c6IG9uZSByb3cgYWZ0ZXIgZ2VuZXJhdGVfaWQnKTtcbiAgICAgIGFzc2VydC5lcXVhbChiZWZvcmVbMF0hLnN0YXR1cywgJ3F1ZXVlZCcsICdxdWV1ZWQtcm93OiBzdGF0dXMgaXMgcXVldWVkJyk7XG5cbiAgICAgIC8vIFNpbXVsYXRlcyBnc2RfcGxhbl9taWxlc3RvbmUgY2FsbGluZyBpbnNlcnRNaWxlc3RvbmUgKElOU0VSVCBPUiBJR05PUkUpXG4gICAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogJ00wMDEnLCB0aXRsZTogJ1BsYW5uZWQgVGl0bGUnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuXG4gICAgICBjb25zdCBhZnRlciA9IGdldEFsbE1pbGVzdG9uZXMoKTtcbiAgICAgIGFzc2VydC5lcXVhbChhZnRlci5sZW5ndGgsIDEsICdxdWV1ZWQtcm93OiBzdGlsbCBvbmUgcm93IGFmdGVyIHBsYW4nKTtcbiAgICAgIC8vIElOU0VSVCBPUiBJR05PUkUga2VlcHMgdGhlIG9yaWdpbmFsIHJvdyBcdTIwMTQgc3RhdHVzIHN0YXlzICdxdWV1ZWQnXG4gICAgICBhc3NlcnQuZXF1YWwoYWZ0ZXJbMF0hLnN0YXR1cywgJ3F1ZXVlZCcsICdxdWV1ZWQtcm93OiBJTlNFUlQgT1IgSUdOT1JFIHByZXNlcnZlcyBvcmlnaW5hbCBzdGF0dXMnKTtcblxuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgUXVldWVkIG1pbGVzdG9uZSB3aXRoIHdvcmt0cmVlIG5vdCBmbGFnZ2VkIGFzIGdob3N0ICgjMjkyMSkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIHRlc3QoJ2Rlcml2ZS1zdGF0ZS1kYjogcXVldWVkIG1pbGVzdG9uZSB3aXRoIHdvcmt0cmVlIG5vdCBmbGFnZ2VkIGFzIGdob3N0ICgjMjkyMSknLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIC8vIE0wMDE6IGNvbXBsZXRlIG1pbGVzdG9uZSB3aXRoIHN1bW1hcnlcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL00wMDEtU1VNTUFSWS5tZCcsICcjIE0wMDEgU3VtbWFyeVxcblxcbkRvbmUuJyk7XG5cbiAgICAgIC8vIE0wMDI6IHF1ZXVlZCBtaWxlc3RvbmUgXHUyMDE0IGRpcmVjdG9yeSArIHNsaWNlcyBkaXIgZXhpc3RzLCBidXQgbm8gY29udGVudCBmaWxlcy5cbiAgICAgIC8vIFRoaXMgaXMgd2hhdCBoYXBwZW5zIHdoZW4gZW5zdXJlTWlsZXN0b25lRGJSb3cgY3JlYXRlcyBNMDAyIGJ1dCB0aGUgREIgcm93XG4gICAgICAvLyBpcyBsb3N0IGR1cmluZyB3b3JrdHJlZSB0ZWFyZG93bi5cbiAgICAgIG1rZGlyU3luYyhqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMicsICdzbGljZXMnKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgICAgIC8vIEEgd29ya3RyZWUgZXhpc3RzIGZvciBNMDAyLCBwcm92aW5nIGl0J3MgYSBsZWdpdGltYXRlIG1pbGVzdG9uZVxuICAgICAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgJy5nc2QnLCAnd29ya3RyZWVzJywgJ00wMDInKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgICAgIC8vIGlzR2hvc3RNaWxlc3RvbmUgc2hvdWxkIE5PVCB0cmVhdCBNMDAyIGFzIGdob3N0IHdoZW4gd29ya3RyZWUgZXhpc3RzXG4gICAgICBhc3NlcnQub2soIWlzR2hvc3RNaWxlc3RvbmUoYmFzZSwgJ00wMDInKSwgJ2dob3N0LXd0OiBNMDAyIHdpdGggd29ya3RyZWUgaXMgTk9UIGEgZ2hvc3QnKTtcblxuICAgICAgLy8gREIgaGFzIE0wMDEgY29tcGxldGUgYnV0IE0wMDIgcm93IHdhcyBsb3N0XG4gICAgICBvcGVuRGF0YWJhc2UoJzptZW1vcnk6Jyk7XG4gICAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogJ00wMDEnLCB0aXRsZTogJ0ZpcnN0Jywgc3RhdHVzOiAnY29tcGxldGUnIH0pO1xuICAgICAgLy8gTm8gTTAwMiByb3cgXHUyMDE0IHNpbXVsYXRlcyBEQiByb3cgbG9zcyBkdXJpbmcgd29ya3RyZWUgdGVhcmRvd25cblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IGRiU3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZUZyb21EYihiYXNlKTtcblxuICAgICAgLy8gTTAwMiBpcyBsZWdpdGltYXRlIGxlZ2FjeSBkaXNrIHN0YXRlIGJ1dCBpcyBub3QgYXV0aG9yaXRhdGl2ZSB3aXRob3V0IGEgREIgcm93LlxuICAgICAgY29uc3QgbTAwMkVudHJ5ID0gZGJTdGF0ZS5yZWdpc3RyeS5maW5kKGUgPT4gZS5pZCA9PT0gJ00wMDInKTtcbiAgICAgIGFzc2VydC5lcXVhbChtMDAyRW50cnksIHVuZGVmaW5lZCwgJ2dob3N0LXd0OiBNMDAyIHNob3VsZCBub3QgYmUgaW1wb3J0ZWQgaW50byByZWdpc3RyeScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLmFjdGl2ZU1pbGVzdG9uZSwgbnVsbCwgJ2dob3N0LXd0OiBubyBhY3RpdmUgbWlsZXN0b25lIGZyb20gZGlzay1vbmx5IHdvcmt0cmVlJyk7XG4gICAgICBhc3NlcnQuZXF1YWwoZGJTdGF0ZS5waGFzZSwgJ2NvbXBsZXRlJywgJ2dob3N0LXd0OiBEQi1vbmx5IE0wMDEgY29tcGxldGlvbiBkcml2ZXMgc3RhdGUnKTtcblxuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFF1ZXVlZCBtaWxlc3RvbmUgd2l0aCBEQiByb3cgbm90IGZsYWdnZWQgYXMgZ2hvc3QgKCMyOTIxKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgdGVzdCgnZGVyaXZlLXN0YXRlLWRiOiBxdWV1ZWQgbWlsZXN0b25lIHdpdGggREIgcm93IG5vdCBmbGFnZ2VkIGFzIGdob3N0ICgjMjkyMSknLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIC8vIE0wMDE6IGNvbXBsZXRlIG1pbGVzdG9uZSB3aXRoIHN1bW1hcnlcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL00wMDEtU1VNTUFSWS5tZCcsICcjIE0wMDEgU3VtbWFyeVxcblxcbkRvbmUuJyk7XG5cbiAgICAgIC8vIE0wMDI6IHF1ZXVlZCBtaWxlc3RvbmUgXHUyMDE0IGRpcmVjdG9yeSBleGlzdHMgd2l0aCBDT05URVhUIGZpbGUgYW5kIERCIHJvd1xuICAgICAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAyJywgJ3NsaWNlcycpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAyL00wMDItQ09OVEVYVC5tZCcsICcjIE0wMDIgQ29udGV4dFxcblxcblBsYW5uZWQgbWlsZXN0b25lLicpO1xuXG4gICAgICAvLyBEQiBoYXMgYm90aCBNMDAxIGNvbXBsZXRlIGFuZCBNMDAyIHF1ZXVlZFxuICAgICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuICAgICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdGaXJzdCcsIHN0YXR1czogJ2NvbXBsZXRlJyB9KTtcbiAgICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiAnTTAwMicsIHRpdGxlOiAnU2Vjb25kJywgc3RhdHVzOiAncXVldWVkJyB9KTtcblxuICAgICAgLy8gaXNHaG9zdE1pbGVzdG9uZSBzaG91bGQgTk9UIHRyZWF0IE0wMDIgYXMgZ2hvc3Qgd2hlbiBEQiByb3cgKyBjb250ZW50IGZpbGVzIGV4aXN0XG4gICAgICBhc3NlcnQub2soIWlzR2hvc3RNaWxlc3RvbmUoYmFzZSwgJ00wMDInKSwgJ2dob3N0LWRicm93OiBNMDAyIHdpdGggREIgcm93IGFuZCBjb250ZW50IGlzIE5PVCBhIGdob3N0Jyk7XG5cbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBkYlN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGVGcm9tRGIoYmFzZSk7XG5cbiAgICAgIC8vIE0wMDIgc2hvdWxkIG5vdCBiZSBza2lwcGVkXG4gICAgICBjb25zdCBtMDAyRW50cnkgPSBkYlN0YXRlLnJlZ2lzdHJ5LmZpbmQoZSA9PiBlLmlkID09PSAnTTAwMicpO1xuICAgICAgYXNzZXJ0Lm9rKG0wMDJFbnRyeSAhPT0gdW5kZWZpbmVkLCAnZ2hvc3QtZGJyb3c6IE0wMDIgc2hvdWxkIGJlIGluIHJlZ2lzdHJ5Jyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUuYWN0aXZlTWlsZXN0b25lPy5pZCwgJ00wMDInLCAnZ2hvc3QtZGJyb3c6IE0wMDIgc2hvdWxkIGJlIGFjdGl2ZScpO1xuICAgICAgYXNzZXJ0Lm5vdEVxdWFsKGRiU3RhdGUucGhhc2UsICdjb21wbGV0ZScsICdnaG9zdC1kYnJvdzogcGhhc2Ugc2hvdWxkIG5vdCBiZSBjb21wbGV0ZScpO1xuXG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxVQUFVLFlBQVk7QUFDL0IsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxXQUFXLFFBQVEscUJBQXFCO0FBQzlELFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFFdkIsU0FBUyxhQUFhLHNCQUFzQixrQkFBa0IsbUJBQW1CLHdCQUF3QjtBQUN6RztBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFHUCxTQUFTLG9CQUE0QjtBQUNuQyxRQUFNLE9BQU8sWUFBWSxLQUFLLE9BQU8sR0FBRyxnQkFBZ0IsQ0FBQztBQUN6RCxZQUFVLEtBQUssTUFBTSxRQUFRLFlBQVksR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQy9ELFNBQU87QUFDVDtBQUVBLFNBQVMsVUFBVSxNQUFjLGNBQXNCLFNBQXVCO0FBQzVFLFFBQU0sT0FBTyxLQUFLLE1BQU0sUUFBUSxZQUFZO0FBQzVDLFlBQVUsS0FBSyxNQUFNLElBQUksR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQy9DLGdCQUFjLE1BQU0sT0FBTztBQUM3QjtBQUVBLFNBQVMsa0JBQWtCLGNBQXNCLFNBQWlCLE1BS3pEO0FBQ1AsaUJBQWU7QUFBQSxJQUNiLE1BQU07QUFBQSxJQUNOLGVBQWUsTUFBTSxpQkFBaUI7QUFBQSxJQUN0QyxjQUFjLE1BQU0sZ0JBQWdCO0FBQUEsSUFDcEMsVUFBVSxNQUFNLFlBQVk7QUFBQSxJQUM1QixTQUFTLE1BQU0sV0FBVztBQUFBLElBQzFCLGNBQWM7QUFBQSxFQUNoQixDQUFDO0FBQ0g7QUFFQSxTQUFTLHFCQUFxQixJQUFZLFFBQXNCO0FBQzlELG9CQUFrQjtBQUFBLElBQ2hCO0FBQUEsSUFDQSxPQUFPO0FBQUEsSUFDUDtBQUFBLElBQ0EsYUFBYSxHQUFHLEVBQUUsSUFBSSxNQUFNO0FBQUEsSUFDNUIsS0FBSztBQUFBLElBQ0wsUUFBUTtBQUFBLElBQ1IsZUFBZTtBQUFBLElBQ2YsbUJBQW1CO0FBQUEsSUFDbkIsWUFBWTtBQUFBLElBQ1osT0FBTztBQUFBLElBQ1AsY0FBYztBQUFBLElBQ2QsZUFBZTtBQUFBLEVBQ2pCLENBQUM7QUFDSDtBQUVBLFNBQVMsUUFBUSxNQUFvQjtBQUNuQyxTQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFDL0M7QUFNQSxNQUFNLGtCQUFrQjtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFheEIsTUFBTSxlQUFlO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBY3JCLE1BQU0sdUJBQXVCO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQW1CN0IsU0FBUyxtQkFBbUIsWUFBWTtBQUd0QyxPQUFLLDhDQUE4QyxZQUFZO0FBQzdELFVBQU0sT0FBTyxrQkFBa0I7QUFDL0IsUUFBSTtBQUVGLGdCQUFVLE1BQU0sbUNBQW1DLGVBQWU7QUFDbEUsZ0JBQVUsTUFBTSwwQ0FBMEMsWUFBWTtBQUN0RSxnQkFBVSxNQUFNLDZDQUE2QyxFQUFFO0FBQy9ELGdCQUFVLE1BQU0sZ0RBQWdELFlBQVk7QUFDNUUsZ0JBQVUsTUFBTSxtQkFBbUIsb0JBQW9CO0FBR3ZELDJCQUFxQjtBQUNyQixZQUFNLFlBQVksTUFBTSxpQkFBaUIsSUFBSTtBQUc3QyxtQkFBYSxVQUFVO0FBQ3ZCLGFBQU8sR0FBRyxjQUFjLEdBQUcsc0NBQXNDO0FBR2pFLHNCQUFnQixFQUFFLElBQUksUUFBUSxPQUFPLGtCQUFrQixRQUFRLFNBQVMsQ0FBQztBQUN6RSxrQkFBWSxFQUFFLElBQUksT0FBTyxhQUFhLFFBQVEsT0FBTyxlQUFlLFFBQVEsVUFBVSxNQUFNLE9BQU8sU0FBUyxDQUFDLEVBQUUsQ0FBQztBQUNoSCxrQkFBWSxFQUFFLElBQUksT0FBTyxhQUFhLFFBQVEsT0FBTyxnQkFBZ0IsUUFBUSxXQUFXLE1BQU0sT0FBTyxTQUFTLENBQUMsS0FBSyxFQUFFLENBQUM7QUFDdkgsaUJBQVcsRUFBRSxJQUFJLE9BQU8sU0FBUyxPQUFPLGFBQWEsUUFBUSxPQUFPLGNBQWMsUUFBUSxVQUFVLENBQUM7QUFDckcsaUJBQVcsRUFBRSxJQUFJLE9BQU8sU0FBUyxPQUFPLGFBQWEsUUFBUSxPQUFPLGFBQWEsUUFBUSxXQUFXLENBQUM7QUFDckcsMkJBQXFCLFFBQVEsUUFBUTtBQUNyQywyQkFBcUIsUUFBUSxRQUFRO0FBQ3JDLDJCQUFxQixRQUFRLFdBQVc7QUFFeEMsd0JBQWtCLG1DQUFtQyxpQkFBaUI7QUFBQSxRQUNwRSxlQUFlO0FBQUEsUUFDZixjQUFjO0FBQUEsTUFDaEIsQ0FBQztBQUNELHdCQUFrQiwwQ0FBMEMsY0FBYztBQUFBLFFBQ3hFLGVBQWU7QUFBQSxRQUNmLGNBQWM7QUFBQSxRQUNkLFVBQVU7QUFBQSxNQUNaLENBQUM7QUFDRCx3QkFBa0IsbUJBQW1CLHNCQUFzQjtBQUFBLFFBQ3pELGVBQWU7QUFBQSxNQUNqQixDQUFDO0FBR0QsMkJBQXFCO0FBQ3JCLFlBQU0sVUFBVSxNQUFNLFlBQVksSUFBSTtBQUd0QyxhQUFPLGdCQUFnQixRQUFRLE9BQU8sVUFBVSxPQUFPLHlCQUF5QjtBQUNoRixhQUFPLGdCQUFnQixRQUFRLGlCQUFpQixJQUFJLFVBQVUsaUJBQWlCLElBQUksc0NBQXNDO0FBQ3pILGFBQU8sZ0JBQWdCLFFBQVEsaUJBQWlCLE9BQU8sVUFBVSxpQkFBaUIsT0FBTyx5Q0FBeUM7QUFDbEksYUFBTyxnQkFBZ0IsUUFBUSxhQUFhLElBQUksVUFBVSxhQUFhLElBQUksa0NBQWtDO0FBQzdHLGFBQU8sZ0JBQWdCLFFBQVEsYUFBYSxPQUFPLFVBQVUsYUFBYSxPQUFPLHFDQUFxQztBQUN0SCxhQUFPLGdCQUFnQixRQUFRLFlBQVksSUFBSSxVQUFVLFlBQVksSUFBSSxpQ0FBaUM7QUFDMUcsYUFBTyxnQkFBZ0IsUUFBUSxZQUFZLE9BQU8sVUFBVSxZQUFZLE9BQU8sb0NBQW9DO0FBQ25ILGFBQU8sZ0JBQWdCLFFBQVEsVUFBVSxVQUFVLFVBQVUsMEJBQTBCO0FBQ3ZGLGFBQU8sZ0JBQWdCLFFBQVEsU0FBUyxRQUFRLFVBQVUsU0FBUyxRQUFRLG1DQUFtQztBQUM5RyxhQUFPLGdCQUFnQixRQUFRLFNBQVMsQ0FBQyxHQUFHLFFBQVEsVUFBVSxTQUFTLENBQUMsR0FBRyxRQUFRLHNDQUFzQztBQUN6SCxhQUFPLGdCQUFnQixRQUFRLGNBQWMsUUFBUSxVQUFVLGNBQWMsUUFBUSx1Q0FBdUM7QUFDNUgsYUFBTyxnQkFBZ0IsUUFBUSxjQUFjLFdBQVcsVUFBVSxjQUFjLFdBQVcsMENBQTBDO0FBQ3JJLGFBQU8sZ0JBQWdCLFFBQVEsY0FBYyxPQUFPLFVBQVUsY0FBYyxPQUFPLHNDQUFzQztBQUN6SCxhQUFPLGdCQUFnQixRQUFRLFVBQVUsWUFBWSxNQUFNLFVBQVUsVUFBVSxZQUFZLE1BQU0sbUNBQW1DO0FBQ3BJLGFBQU8sZ0JBQWdCLFFBQVEsVUFBVSxZQUFZLE9BQU8sVUFBVSxVQUFVLFlBQVksT0FBTyxvQ0FBb0M7QUFDdkksYUFBTyxnQkFBZ0IsUUFBUSxVQUFVLFFBQVEsTUFBTSxVQUFVLFVBQVUsUUFBUSxNQUFNLCtCQUErQjtBQUN4SCxhQUFPLGdCQUFnQixRQUFRLFVBQVUsUUFBUSxPQUFPLFVBQVUsVUFBVSxRQUFRLE9BQU8sZ0NBQWdDO0FBQzNILGFBQU8sZ0JBQWdCLFFBQVEsVUFBVSxPQUFPLE1BQU0sVUFBVSxVQUFVLE9BQU8sTUFBTSw4QkFBOEI7QUFDckgsYUFBTyxnQkFBZ0IsUUFBUSxVQUFVLE9BQU8sT0FBTyxVQUFVLFVBQVUsT0FBTyxPQUFPLCtCQUErQjtBQUV4SCxvQkFBYztBQUFBLElBQ2hCLFVBQUU7QUFDQSxvQkFBYztBQUNkLGNBQVEsSUFBSTtBQUFBLElBQ2Q7QUFBQSxFQUNGLENBQUM7QUFHRCxPQUFLLG9GQUFvRixZQUFZO0FBQ25HLFVBQU0sT0FBTyxrQkFBa0I7QUFDL0IsVUFBTSxPQUFPLFFBQVEsSUFBSTtBQUN6QixRQUFJO0FBQ0YsY0FBUSxJQUFJLHFDQUFxQztBQUNqRCxnQkFBVSxNQUFNLG1DQUFtQyxlQUFlO0FBQ2xFLGdCQUFVLE1BQU0sMENBQTBDLFlBQVk7QUFDdEUsZ0JBQVUsTUFBTSw2Q0FBNkMsRUFBRTtBQUMvRCxnQkFBVSxNQUFNLGdEQUFnRCxZQUFZO0FBRzVFLGFBQU8sR0FBRyxDQUFDLGNBQWMsR0FBRywrQkFBK0I7QUFDM0QsMkJBQXFCO0FBQ3JCLFlBQU0sUUFBUSxNQUFNLFlBQVksSUFBSTtBQUVwQyxhQUFPLGdCQUFnQixNQUFNLE9BQU8sZ0JBQWdCLHdDQUF3QztBQUM1RixhQUFPLGdCQUFnQixNQUFNLGlCQUFpQixNQUFNLHFEQUFxRDtBQUN6RyxhQUFPLGdCQUFnQixNQUFNLGFBQWEsTUFBTSxpREFBaUQ7QUFDakcsYUFBTyxnQkFBZ0IsTUFBTSxZQUFZLE1BQU0sZ0RBQWdEO0FBQy9GLGFBQU87QUFBQSxRQUNMLE1BQU0sU0FBUyxLQUFLLE9BQUssRUFBRSxTQUFTLGdCQUFnQixDQUFDO0FBQUEsUUFDckQ7QUFBQSxNQUNGO0FBQUEsSUFDRixVQUFFO0FBQ0EsVUFBSSxTQUFTLE9BQVcsUUFBTyxRQUFRLElBQUk7QUFBQSxVQUN0QyxTQUFRLElBQUkscUNBQXFDO0FBQ3RELGNBQVEsSUFBSTtBQUFBLElBQ2Q7QUFBQSxFQUNGLENBQUM7QUFFRCxPQUFLLHFFQUFxRSxZQUFZO0FBQ3BGLFVBQU0sT0FBTyxrQkFBa0I7QUFDL0IsVUFBTSxPQUFPLFFBQVEsSUFBSTtBQUN6QixRQUFJO0FBQ0YsZ0JBQVUsTUFBTSxtQ0FBbUMsZUFBZTtBQUNsRSxnQkFBVSxNQUFNLDBDQUEwQyxZQUFZO0FBQ3RFLGdCQUFVLE1BQU0sNkNBQTZDLEVBQUU7QUFDL0QsZ0JBQVUsTUFBTSxnREFBZ0QsWUFBWTtBQUU1RSxjQUFRLElBQUkscUNBQXFDO0FBRWpELGFBQU8sR0FBRyxDQUFDLGNBQWMsR0FBRywrQkFBK0I7QUFDM0QsMkJBQXFCO0FBQ3JCLFlBQU0sUUFBUSxNQUFNLFlBQVksSUFBSTtBQUVwQyxhQUFPLGdCQUFnQixNQUFNLE9BQU8sYUFBYSw4QkFBOEI7QUFDL0UsYUFBTyxnQkFBZ0IsTUFBTSxpQkFBaUIsSUFBSSxRQUFRLG1DQUFtQztBQUM3RixhQUFPLGdCQUFnQixNQUFNLGFBQWEsSUFBSSxPQUFPLDhCQUE4QjtBQUNuRixhQUFPLGdCQUFnQixNQUFNLFlBQVksSUFBSSxPQUFPLDZCQUE2QjtBQUFBLElBQ25GLFVBQUU7QUFDQSxVQUFJLFNBQVMsT0FBVyxRQUFPLFFBQVEsSUFBSTtBQUFBLFVBQ3RDLFNBQVEsSUFBSSxxQ0FBcUM7QUFDdEQsY0FBUSxJQUFJO0FBQUEsSUFDZDtBQUFBLEVBQ0YsQ0FBQztBQUdELE9BQUssaUVBQWlFLFlBQVk7QUFDaEYsVUFBTSxPQUFPLGtCQUFrQjtBQUMvQixRQUFJO0FBQ0YsZ0JBQVUsTUFBTSxtQ0FBbUMsZUFBZTtBQUNsRSxnQkFBVSxNQUFNLDBDQUEwQyxZQUFZO0FBQ3RFLGdCQUFVLE1BQU0sNkNBQTZDLEVBQUU7QUFDL0QsZ0JBQVUsTUFBTSxnREFBZ0QsWUFBWTtBQUc1RSxtQkFBYSxVQUFVO0FBQ3ZCLGFBQU8sR0FBRyxjQUFjLEdBQUcsMkJBQTJCO0FBRXRELDJCQUFxQjtBQUNyQixZQUFNLFFBQVEsTUFBTSxZQUFZLElBQUk7QUFFcEMsYUFBTyxnQkFBZ0IsaUJBQWlCLEVBQUUsUUFBUSxHQUFHLGdEQUFnRDtBQUNyRyxhQUFPLGdCQUFnQixNQUFNLGlCQUFpQixNQUFNLHlDQUF5QztBQUM3RixhQUFPLGdCQUFnQixNQUFNLFVBQVUsQ0FBQyxHQUFHLGtDQUFrQztBQUU3RSxvQkFBYztBQUFBLElBQ2hCLFVBQUU7QUFDQSxvQkFBYztBQUNkLGNBQVEsSUFBSTtBQUFBLElBQ2Q7QUFBQSxFQUNGLENBQUM7QUFHRCxPQUFLLG9FQUFvRSxZQUFZO0FBQ25GLFVBQU0sT0FBTyxrQkFBa0I7QUFDL0IsUUFBSTtBQUVGLGdCQUFVLE1BQU0sbUNBQW1DLGVBQWU7QUFDbEUsZ0JBQVUsTUFBTSwwQ0FBMEMsWUFBWTtBQUN0RSxnQkFBVSxNQUFNLDZDQUE2QyxFQUFFO0FBQy9ELGdCQUFVLE1BQU0sZ0RBQWdELFlBQVk7QUFDNUUsZ0JBQVUsTUFBTSxtQkFBbUIsb0JBQW9CO0FBR3ZELG1CQUFhLFVBQVU7QUFDdkIsc0JBQWdCLEVBQUUsSUFBSSxRQUFRLE9BQU8sa0JBQWtCLFFBQVEsU0FBUyxDQUFDO0FBQ3pFLGtCQUFZLEVBQUUsSUFBSSxPQUFPLGFBQWEsUUFBUSxPQUFPLGVBQWUsUUFBUSxVQUFVLE1BQU0sT0FBTyxTQUFTLENBQUMsRUFBRSxDQUFDO0FBQ2hILGlCQUFXLEVBQUUsSUFBSSxPQUFPLFNBQVMsT0FBTyxhQUFhLFFBQVEsT0FBTyxjQUFjLFFBQVEsVUFBVSxDQUFDO0FBRXJHLHdCQUFrQixtQ0FBbUMsaUJBQWlCO0FBQUEsUUFDcEUsZUFBZTtBQUFBLFFBQ2YsY0FBYztBQUFBLE1BQ2hCLENBQUM7QUFFRCwyQkFBcUI7QUFDckIsWUFBTSxRQUFRLE1BQU0sWUFBWSxJQUFJO0FBR3BDLGFBQU8sZ0JBQWdCLE1BQU0sT0FBTyxhQUFhLGdDQUFnQztBQUNqRixhQUFPLGdCQUFnQixNQUFNLGlCQUFpQixJQUFJLFFBQVEscUNBQXFDO0FBQy9GLGFBQU8sZ0JBQWdCLE1BQU0sYUFBYSxJQUFJLE9BQU8sZ0NBQWdDO0FBQ3JGLGFBQU8sZ0JBQWdCLE1BQU0sWUFBWSxJQUFJLE9BQU8sK0JBQStCO0FBQ25GLGFBQU8sZ0JBQWdCLE1BQU0sY0FBYyxRQUFRLEdBQUcsd0RBQXdEO0FBQzlHLGFBQU8sZ0JBQWdCLE1BQU0sY0FBYyxXQUFXLEdBQUcsMkRBQTJEO0FBQ3BILGFBQU8sZ0JBQWdCLE1BQU0sY0FBYyxPQUFPLEdBQUcsdURBQXVEO0FBRTVHLG9CQUFjO0FBQUEsSUFDaEIsVUFBRTtBQUNBLG9CQUFjO0FBQ2QsY0FBUSxJQUFJO0FBQUEsSUFDZDtBQUFBLEVBQ0YsQ0FBQztBQUVELE9BQUssdUVBQXVFLE9BQU8sTUFBTTtBQUN2RixVQUFNLE9BQU8sa0JBQWtCO0FBQy9CLE1BQUUsTUFBTSxNQUFNO0FBQ1osb0JBQWM7QUFDZCxjQUFRLElBQUk7QUFBQSxJQUNkLENBQUM7QUFFRCxVQUFNLGtCQUFrQjtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQWF4QixjQUFVLE1BQU0sbUNBQW1DLGVBQWU7QUFDbEUsY0FBVSxNQUFNLDBDQUEwQyxlQUFlO0FBQ3pFLGNBQVUsTUFBTSw2Q0FBNkMsRUFBRTtBQUMvRCxjQUFVLE1BQU0sZ0RBQWdELFlBQVk7QUFDNUUsY0FBVSxNQUFNLGdEQUFnRCxZQUFZO0FBRTVFLGlCQUFhLFVBQVU7QUFDdkIsb0JBQWdCLEVBQUUsSUFBSSxRQUFRLE9BQU8sa0JBQWtCLFFBQVEsU0FBUyxDQUFDO0FBQ3pFLGdCQUFZLEVBQUUsSUFBSSxPQUFPLGFBQWEsUUFBUSxPQUFPLGVBQWUsUUFBUSxVQUFVLE1BQU0sT0FBTyxTQUFTLENBQUMsRUFBRSxDQUFDO0FBQ2hILGVBQVcsRUFBRSxJQUFJLE9BQU8sU0FBUyxPQUFPLGFBQWEsUUFBUSxPQUFPLHFCQUFxQixRQUFRLFdBQVcsQ0FBQztBQUU3Ryx5QkFBcUI7QUFDckIsVUFBTSxRQUFRLE1BQU0sWUFBWSxJQUFJO0FBRXBDLFVBQU0sVUFBVSxjQUFjLFFBQVEsS0FBSztBQUMzQyxXQUFPLGdCQUFnQixRQUFRLFFBQVEsR0FBRyx3REFBd0Q7QUFDbEcsV0FBTyxnQkFBZ0IsUUFBUSxLQUFLLENBQUFBLE9BQUtBLEdBQUUsT0FBTyxLQUFLLEdBQUcsUUFBUSxZQUFZLGtEQUFrRDtBQUNoSSxXQUFPLGdCQUFnQixRQUFRLEtBQUssQ0FBQUEsT0FBS0EsR0FBRSxPQUFPLEtBQUssR0FBRyxRQUFXLDZDQUE2QztBQUNsSCxXQUFPLGdCQUFnQixNQUFNLE9BQU8sZUFBZSw4Q0FBOEM7QUFDakcsV0FBTyxnQkFBZ0IsTUFBTSxZQUFZLE1BQU0seURBQXlEO0FBQ3hHLFdBQU8sZ0JBQWdCLE1BQU0sVUFBVSxPQUFPLEVBQUUsTUFBTSxHQUFHLE9BQU8sRUFBRSxHQUFHLDJDQUEyQztBQUFBLEVBQ2xILENBQUM7QUFFRCxPQUFLLHFFQUFxRSxPQUFPLE1BQU07QUFDckYsVUFBTSxPQUFPLGtCQUFrQjtBQUMvQixNQUFFLE1BQU0sTUFBTTtBQUNaLG9CQUFjO0FBQ2QsY0FBUSxJQUFJO0FBQUEsSUFDZCxDQUFDO0FBRUQsY0FBVSxNQUFNLG1DQUFtQyxlQUFlO0FBQ2xFLGNBQVUsTUFBTSwwQ0FBMEMsWUFBWTtBQUN0RSxjQUFVLE1BQU0sbURBQW1ELG9DQUFvQztBQUV2RyxpQkFBYSxVQUFVO0FBQ3ZCLG9CQUFnQixFQUFFLElBQUksUUFBUSxPQUFPLGtCQUFrQixRQUFRLFNBQVMsQ0FBQztBQUN6RSxnQkFBWSxFQUFFLElBQUksT0FBTyxhQUFhLFFBQVEsT0FBTyxlQUFlLFFBQVEsVUFBVSxNQUFNLE9BQU8sU0FBUyxDQUFDLEVBQUUsQ0FBQztBQUNoSCxlQUFXLEVBQUUsSUFBSSxPQUFPLFNBQVMsT0FBTyxhQUFhLFFBQVEsT0FBTyxjQUFjLFFBQVEsVUFBVSxDQUFDO0FBRXJHLHlCQUFxQjtBQUNyQixVQUFNLFFBQVEsTUFBTSxrQkFBa0IsSUFBSTtBQUUxQyxXQUFPLGdCQUFnQixjQUFjLFFBQVEsS0FBSyxFQUFFLEtBQUssQ0FBQUEsT0FBS0EsR0FBRSxPQUFPLEtBQUssR0FBRyxRQUFRLFNBQVM7QUFDaEcsV0FBTyxnQkFBZ0IsTUFBTSxPQUFPLFdBQVc7QUFDL0MsV0FBTyxnQkFBZ0IsTUFBTSxZQUFZLElBQUksS0FBSztBQUFBLEVBQ3BELENBQUM7QUFFRCxPQUFLLG1GQUFtRixPQUFPLE1BQU07QUFDbkcsVUFBTSxPQUFPLGtCQUFrQjtBQUMvQixNQUFFLE1BQU0sTUFBTTtBQUNaLG9CQUFjO0FBQ2QsY0FBUSxJQUFJO0FBQUEsSUFDZCxDQUFDO0FBRUQsY0FBVSxNQUFNLG1DQUFtQztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsQ0FRdEQ7QUFDRyxjQUFVLE1BQU0sc0NBQXNDLDBEQUEwRDtBQUNoSCxjQUFVLE1BQU0sbUNBQW1DLHlCQUF5QjtBQUM1RSxjQUFVLE1BQU0sbUNBQW1DLHdEQUF3RDtBQUMzRyxjQUFVLE1BQU0sbUNBQW1DO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxDQVF0RDtBQUNHLGNBQVUsTUFBTSxtQ0FBbUMsc0RBQXNEO0FBRXpHLGlCQUFhLFVBQVU7QUFFdkIseUJBQXFCO0FBQ3JCLFVBQU0sUUFBUSxNQUFNLFlBQVksSUFBSTtBQUVwQyxVQUFNLGFBQWEsaUJBQWlCO0FBQ3BDLFdBQU8sZ0JBQWdCLFdBQVcsUUFBUSxHQUFHLG1EQUFtRDtBQUNoRyxXQUFPLGdCQUFnQixNQUFNLGlCQUFpQixNQUFNLGdEQUFnRDtBQUNwRyxXQUFPLGdCQUFnQixNQUFNLFVBQVUsQ0FBQyxHQUFHLHVDQUF1QztBQUFBLEVBQ3BGLENBQUM7QUFHRCxPQUFLLHFGQUFxRixZQUFZO0FBQ3BHLFVBQU0sT0FBTyxrQkFBa0I7QUFDL0IsUUFBSTtBQUVGLGdCQUFVLEtBQUssTUFBTSxRQUFRLGNBQWMsTUFBTSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFFdkUsZ0JBQVUsTUFBTSxtQkFBbUIsb0JBQW9CO0FBRXZELDJCQUFxQjtBQUNyQixZQUFNLFFBQVEsTUFBTSxpQkFBaUIsSUFBSTtBQUd6QyxhQUFPLGdCQUFnQixNQUFNLGNBQWMsUUFBUSxHQUFHLHdDQUF3QztBQUM5RixhQUFPLGdCQUFnQixNQUFNLGNBQWMsV0FBVyxHQUFHLDJDQUEyQztBQUNwRyxhQUFPLGdCQUFnQixNQUFNLGNBQWMsT0FBTyxHQUFHLHVDQUF1QztBQUFBLElBQzlGLFVBQUU7QUFDQSxjQUFRLElBQUk7QUFBQSxJQUNkO0FBQUEsRUFDRixDQUFDO0FBR0QsT0FBSyw0Q0FBNEMsWUFBWTtBQUMzRCxVQUFNLE9BQU8sa0JBQWtCO0FBRS9CLFVBQU0sbUJBQW1CO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQVN6QixVQUFNLGlCQUFpQjtBQUFBO0FBQUE7QUFFdkIsVUFBTSxnQkFBZ0I7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBVXRCLFFBQUk7QUFJRixnQkFBVSxLQUFLLE1BQU0sUUFBUSxjQUFjLE1BQU0sR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3ZFLGdCQUFVLEtBQUssTUFBTSxRQUFRLGNBQWMsTUFBTSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDdkUsZ0JBQVUsTUFBTSxtQ0FBbUMsZ0JBQWdCO0FBQ25FLGdCQUFVLE1BQU0sc0NBQXNDO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLFFBQXdFO0FBQzlILGdCQUFVLE1BQU0sbUNBQW1DLGNBQWM7QUFDakUsZ0JBQVUsTUFBTSxtQ0FBbUMsYUFBYTtBQUdoRSxtQkFBYSxVQUFVO0FBSXZCLHNCQUFnQixFQUFFLElBQUksUUFBUSxPQUFPLG1CQUFtQixRQUFRLFdBQVcsQ0FBQztBQUM1RSxzQkFBZ0IsRUFBRSxJQUFJLFFBQVEsT0FBTyxvQkFBb0IsUUFBUSxTQUFTLENBQUM7QUFDM0Usa0JBQVksRUFBRSxJQUFJLE9BQU8sYUFBYSxRQUFRLE9BQU8sUUFBUSxRQUFRLFlBQVksTUFBTSxPQUFPLFNBQVMsQ0FBQyxFQUFFLENBQUM7QUFDM0csa0JBQVksRUFBRSxJQUFJLE9BQU8sYUFBYSxRQUFRLE9BQU8sZUFBZSxRQUFRLFVBQVUsTUFBTSxPQUFPLFNBQVMsQ0FBQyxFQUFFLENBQUM7QUFDaEgsd0JBQWtCLG1DQUFtQyxrQkFBa0I7QUFBQSxRQUNyRSxlQUFlO0FBQUEsUUFDZixjQUFjO0FBQUEsTUFDaEIsQ0FBQztBQUNELHdCQUFrQixtQ0FBbUMsZ0JBQWdCO0FBQUEsUUFDbkUsZUFBZTtBQUFBLFFBQ2YsY0FBYztBQUFBLE1BQ2hCLENBQUM7QUFDRCx3QkFBa0IsbUNBQW1DLGVBQWU7QUFBQSxRQUNsRSxlQUFlO0FBQUEsUUFDZixjQUFjO0FBQUEsTUFDaEIsQ0FBQztBQUVELDJCQUFxQjtBQUNyQixZQUFNLFFBQVEsTUFBTSxZQUFZLElBQUk7QUFFcEMsYUFBTyxnQkFBZ0IsTUFBTSxTQUFTLFFBQVEsR0FBRyxxQ0FBcUM7QUFDdEYsYUFBTyxnQkFBZ0IsTUFBTSxTQUFTLENBQUMsR0FBRyxJQUFJLFFBQVEsa0NBQWtDO0FBQ3hGLGFBQU8sZ0JBQWdCLE1BQU0sU0FBUyxDQUFDLEdBQUcsUUFBUSxZQUFZLCtCQUErQjtBQUM3RixhQUFPLGdCQUFnQixNQUFNLFNBQVMsQ0FBQyxHQUFHLElBQUksUUFBUSxrQ0FBa0M7QUFDeEYsYUFBTyxnQkFBZ0IsTUFBTSxTQUFTLENBQUMsR0FBRyxRQUFRLFVBQVUsNkJBQTZCO0FBQ3pGLGFBQU8sZ0JBQWdCLE1BQU0saUJBQWlCLElBQUksUUFBUSxzQ0FBc0M7QUFDaEcsYUFBTyxnQkFBZ0IsTUFBTSxPQUFPLFlBQVksa0RBQWtEO0FBRWxHLG9CQUFjO0FBQUEsSUFDaEIsVUFBRTtBQUNBLG9CQUFjO0FBQ2QsY0FBUSxJQUFJO0FBQUEsSUFDZDtBQUFBLEVBQ0YsQ0FBQztBQUdELE9BQUssdUNBQXVDLFlBQVk7QUFDdEQsVUFBTSxPQUFPLGtCQUFrQjtBQUMvQixRQUFJO0FBQ0YsZ0JBQVUsTUFBTSxtQ0FBbUMsZUFBZTtBQUNsRSxnQkFBVSxNQUFNLDBDQUEwQyxZQUFZO0FBQ3RFLGdCQUFVLE1BQU0sNkNBQTZDLEVBQUU7QUFDL0QsZ0JBQVUsTUFBTSxnREFBZ0QsWUFBWTtBQUU1RSxtQkFBYSxVQUFVO0FBRXZCLHNCQUFnQixFQUFFLElBQUksUUFBUSxPQUFPLGtCQUFrQixRQUFRLFNBQVMsQ0FBQztBQUN6RSxrQkFBWSxFQUFFLElBQUksT0FBTyxhQUFhLFFBQVEsT0FBTyxlQUFlLFFBQVEsVUFBVSxNQUFNLE9BQU8sU0FBUyxDQUFDLEVBQUUsQ0FBQztBQUNoSCxpQkFBVyxFQUFFLElBQUksT0FBTyxTQUFTLE9BQU8sYUFBYSxRQUFRLE9BQU8sY0FBYyxRQUFRLFVBQVUsQ0FBQztBQUNyRyx3QkFBa0IsbUNBQW1DLGlCQUFpQjtBQUFBLFFBQ3BFLGVBQWU7QUFBQSxRQUNmLGNBQWM7QUFBQSxNQUNoQixDQUFDO0FBQ0Qsd0JBQWtCLDBDQUEwQyxjQUFjO0FBQUEsUUFDeEUsZUFBZTtBQUFBLFFBQ2YsY0FBYztBQUFBLFFBQ2QsVUFBVTtBQUFBLE1BQ1osQ0FBQztBQUVELDJCQUFxQjtBQUNyQixZQUFNLFNBQVMsTUFBTSxZQUFZLElBQUk7QUFDckMsYUFBTyxnQkFBZ0IsT0FBTyxZQUFZLElBQUksT0FBTyxnQ0FBZ0M7QUFHckYsWUFBTSxjQUFjLGFBQWEsUUFBUSxnQkFBZ0IsY0FBYztBQUN2RSx3QkFBa0IsMENBQTBDLGFBQWE7QUFBQSxRQUN2RSxlQUFlO0FBQUEsUUFDZixjQUFjO0FBQUEsUUFDZCxVQUFVO0FBQUEsTUFDWixDQUFDO0FBRUQsZ0JBQVUsTUFBTSwwQ0FBMEMsV0FBVztBQUVyRSx1QkFBaUIsUUFBUSxPQUFPLE9BQU8sVUFBVTtBQUdqRCxZQUFNLFNBQVMsTUFBTSxZQUFZLElBQUk7QUFDckMsYUFBTyxnQkFBZ0IsT0FBTyxZQUFZLElBQUksT0FBTyx3Q0FBd0M7QUFHN0YsMkJBQXFCO0FBQ3JCLFlBQU0sU0FBUyxNQUFNLFlBQVksSUFBSTtBQUNyQyxhQUFPLGdCQUFnQixPQUFPLE9BQU8sZUFBZSxzRUFBc0U7QUFDMUgsYUFBTyxnQkFBZ0IsT0FBTyxZQUFZLE1BQU0sOENBQThDO0FBRTlGLG9CQUFjO0FBQUEsSUFDaEIsVUFBRTtBQUNBLG9CQUFjO0FBQ2QsY0FBUSxJQUFJO0FBQUEsSUFDZDtBQUFBLEVBQ0YsQ0FBQztBQU9ELE9BQUssd0NBQXdDLFlBQVk7QUFDdkQsVUFBTSxPQUFPLGtCQUFrQjtBQUMvQixRQUFJO0FBRUYsZ0JBQVUsTUFBTSxtQ0FBbUMsZ0NBQWdDO0FBR25GLDJCQUFxQjtBQUNyQixZQUFNLFlBQVksTUFBTSxpQkFBaUIsSUFBSTtBQUc3QyxtQkFBYSxVQUFVO0FBQ3ZCLHNCQUFnQixFQUFFLElBQUksUUFBUSxPQUFPLFNBQVMsUUFBUSxTQUFTLENBQUM7QUFFaEUsMkJBQXFCO0FBQ3JCLFlBQU0sVUFBVSxNQUFNLGtCQUFrQixJQUFJO0FBRTVDLGFBQU8sZ0JBQWdCLFFBQVEsT0FBTyxVQUFVLE9BQU8sNEJBQTRCO0FBQ25GLGFBQU8sZ0JBQWdCLFFBQVEsaUJBQWlCLElBQUksVUFBVSxpQkFBaUIsSUFBSSx5Q0FBeUM7QUFDNUgsYUFBTyxnQkFBZ0IsUUFBUSxhQUFhLFVBQVUsYUFBYSxrQ0FBa0M7QUFDckcsYUFBTyxnQkFBZ0IsUUFBUSxZQUFZLFVBQVUsWUFBWSxpQ0FBaUM7QUFDbEcsYUFBTyxnQkFBZ0IsUUFBUSxTQUFTLFFBQVEsVUFBVSxTQUFTLFFBQVEsc0NBQXNDO0FBQ2pILGFBQU8sZ0JBQWdCLFFBQVEsU0FBUyxDQUFDLEdBQUcsUUFBUSxVQUFVLFNBQVMsQ0FBQyxHQUFHLFFBQVEseUNBQXlDO0FBRTVILG9CQUFjO0FBQUEsSUFDaEIsVUFBRTtBQUNBLG9CQUFjO0FBQ2QsY0FBUSxJQUFJO0FBQUEsSUFDZDtBQUFBLEVBQ0YsQ0FBQztBQUdELE9BQUsscUNBQXFDLFlBQVk7QUFDcEQsVUFBTSxPQUFPLGtCQUFrQjtBQUMvQixRQUFJO0FBRUYsZ0JBQVUsTUFBTSxtQ0FBbUMsZUFBZTtBQUNsRSxnQkFBVSxNQUFNLDBDQUEwQyxZQUFZO0FBQ3RFLGdCQUFVLE1BQU0sNkNBQTZDLEVBQUU7QUFDL0QsZ0JBQVUsTUFBTSxnREFBZ0QsWUFBWTtBQUU1RSwyQkFBcUI7QUFDckIsWUFBTSxZQUFZLE1BQU0saUJBQWlCLElBQUk7QUFHN0MsbUJBQWEsVUFBVTtBQUN2QixzQkFBZ0IsRUFBRSxJQUFJLFFBQVEsT0FBTyxrQkFBa0IsUUFBUSxTQUFTLENBQUM7QUFDekUsa0JBQVksRUFBRSxJQUFJLE9BQU8sYUFBYSxRQUFRLE9BQU8sZUFBZSxRQUFRLFVBQVUsTUFBTSxPQUFPLFNBQVMsQ0FBQyxFQUFFLENBQUM7QUFDaEgsa0JBQVksRUFBRSxJQUFJLE9BQU8sYUFBYSxRQUFRLE9BQU8sZ0JBQWdCLFFBQVEsV0FBVyxNQUFNLE9BQU8sU0FBUyxDQUFDLEtBQUssRUFBRSxDQUFDO0FBQ3ZILGlCQUFXLEVBQUUsSUFBSSxPQUFPLFNBQVMsT0FBTyxhQUFhLFFBQVEsT0FBTyxjQUFjLFFBQVEsVUFBVSxDQUFDO0FBQ3JHLGlCQUFXLEVBQUUsSUFBSSxPQUFPLFNBQVMsT0FBTyxhQUFhLFFBQVEsT0FBTyxhQUFhLFFBQVEsV0FBVyxDQUFDO0FBRXJHLDJCQUFxQjtBQUNyQixZQUFNLFVBQVUsTUFBTSxrQkFBa0IsSUFBSTtBQUU1QyxhQUFPLGdCQUFnQixRQUFRLE9BQU8sYUFBYSw2QkFBNkI7QUFDaEYsYUFBTyxnQkFBZ0IsUUFBUSxpQkFBaUIsSUFBSSxRQUFRLGtDQUFrQztBQUM5RixhQUFPLGdCQUFnQixRQUFRLGFBQWEsSUFBSSxPQUFPLDZCQUE2QjtBQUNwRixhQUFPLGdCQUFnQixRQUFRLFlBQVksSUFBSSxPQUFPLDRCQUE0QjtBQUNsRixhQUFPLGdCQUFnQixRQUFRLFVBQVUsT0FBTyxNQUFNLEdBQUcseUJBQXlCO0FBQ2xGLGFBQU8sZ0JBQWdCLFFBQVEsVUFBVSxPQUFPLE9BQU8sR0FBRywwQkFBMEI7QUFDcEYsYUFBTyxnQkFBZ0IsUUFBUSxPQUFPLFVBQVUsT0FBTyxtQ0FBbUM7QUFFMUYsb0JBQWM7QUFBQSxJQUNoQixVQUFFO0FBQ0Esb0JBQWM7QUFDZCxjQUFRLElBQUk7QUFBQSxJQUNkO0FBQUEsRUFDRixDQUFDO0FBR0QsT0FBSyx1Q0FBdUMsWUFBWTtBQUN0RCxVQUFNLE9BQU8sa0JBQWtCO0FBQy9CLFFBQUk7QUFDRixZQUFNLGNBQWM7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFhcEIsZ0JBQVUsTUFBTSxtQ0FBbUMsZUFBZTtBQUNsRSxnQkFBVSxNQUFNLDBDQUEwQyxXQUFXO0FBQ3JFLGdCQUFVLE1BQU0sNkNBQTZDLEVBQUU7QUFDL0QsZ0JBQVUsTUFBTSxnREFBZ0QsWUFBWTtBQUU1RSwyQkFBcUI7QUFDckIsWUFBTSxZQUFZLE1BQU0saUJBQWlCLElBQUk7QUFFN0MsbUJBQWEsVUFBVTtBQUN2QixzQkFBZ0IsRUFBRSxJQUFJLFFBQVEsT0FBTyxrQkFBa0IsUUFBUSxTQUFTLENBQUM7QUFDekUsa0JBQVksRUFBRSxJQUFJLE9BQU8sYUFBYSxRQUFRLE9BQU8sZUFBZSxRQUFRLFVBQVUsTUFBTSxPQUFPLFNBQVMsQ0FBQyxFQUFFLENBQUM7QUFDaEgsa0JBQVksRUFBRSxJQUFJLE9BQU8sYUFBYSxRQUFRLE9BQU8sZ0JBQWdCLFFBQVEsV0FBVyxNQUFNLE9BQU8sU0FBUyxDQUFDLEtBQUssRUFBRSxDQUFDO0FBQ3ZILGlCQUFXLEVBQUUsSUFBSSxPQUFPLFNBQVMsT0FBTyxhQUFhLFFBQVEsT0FBTyxjQUFjLFFBQVEsV0FBVyxDQUFDO0FBQ3RHLGlCQUFXLEVBQUUsSUFBSSxPQUFPLFNBQVMsT0FBTyxhQUFhLFFBQVEsT0FBTyxhQUFhLFFBQVEsV0FBVyxDQUFDO0FBRXJHLDJCQUFxQjtBQUNyQixZQUFNLFVBQVUsTUFBTSxrQkFBa0IsSUFBSTtBQUU1QyxhQUFPLGdCQUFnQixRQUFRLE9BQU8sZUFBZSxvQ0FBb0M7QUFDekYsYUFBTyxnQkFBZ0IsUUFBUSxPQUFPLFVBQVUsT0FBTyx3Q0FBd0M7QUFDL0YsYUFBTyxnQkFBZ0IsUUFBUSxhQUFhLElBQUksT0FBTyxrQ0FBa0M7QUFDekYsYUFBTyxnQkFBZ0IsUUFBUSxZQUFZLE1BQU0sa0NBQWtDO0FBRW5GLG9CQUFjO0FBQUEsSUFDaEIsVUFBRTtBQUNBLG9CQUFjO0FBQ2QsY0FBUSxJQUFJO0FBQUEsSUFDZDtBQUFBLEVBQ0YsQ0FBQztBQUdELE9BQUssd0NBQXdDLFlBQVk7QUFDdkQsVUFBTSxPQUFPLGtCQUFrQjtBQUMvQixRQUFJO0FBQ0YsWUFBTSxtQkFBbUI7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBU3pCLGdCQUFVLE1BQU0sbUNBQW1DLGdCQUFnQjtBQUNuRSxnQkFBVSxNQUFNLHNDQUFzQyx3RUFBd0U7QUFDOUgsZ0JBQVUsTUFBTSxtQ0FBbUMseUJBQXlCO0FBRTVFLDJCQUFxQjtBQUNyQixZQUFNLFlBQVksTUFBTSxpQkFBaUIsSUFBSTtBQUU3QyxtQkFBYSxVQUFVO0FBQ3ZCLHNCQUFnQixFQUFFLElBQUksUUFBUSxPQUFPLGtCQUFrQixRQUFRLFdBQVcsQ0FBQztBQUMzRSxrQkFBWSxFQUFFLElBQUksT0FBTyxhQUFhLFFBQVEsT0FBTyxRQUFRLFFBQVEsWUFBWSxNQUFNLE9BQU8sU0FBUyxDQUFDLEVBQUUsQ0FBQztBQUUzRywyQkFBcUI7QUFDckIsWUFBTSxVQUFVLE1BQU0sa0JBQWtCLElBQUk7QUFFNUMsYUFBTyxnQkFBZ0IsUUFBUSxPQUFPLFlBQVksZ0NBQWdDO0FBQ2xGLGFBQU8sZ0JBQWdCLFFBQVEsT0FBTyxVQUFVLE9BQU8sdUNBQXVDO0FBQzlGLGFBQU8sZ0JBQWdCLFFBQVEsU0FBUyxRQUFRLEdBQUcsbUNBQW1DO0FBQ3RGLGFBQU8sZ0JBQWdCLFFBQVEsU0FBUyxDQUFDLEdBQUcsUUFBUSxZQUFZLCtCQUErQjtBQUUvRixvQkFBYztBQUFBLElBQ2hCLFVBQUU7QUFDQSxvQkFBYztBQUNkLGNBQVEsSUFBSTtBQUFBLElBQ2Q7QUFBQSxFQUNGLENBQUM7QUFHRCxPQUFLLHlDQUF5QyxZQUFZO0FBQ3hELFVBQU0sT0FBTyxrQkFBa0I7QUFDL0IsUUFBSTtBQUVGLFlBQU0saUJBQWlCO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQVl2QixnQkFBVSxNQUFNLG1DQUFtQyxjQUFjO0FBRWpFLDJCQUFxQjtBQUNyQixZQUFNLFlBQVksTUFBTSxpQkFBaUIsSUFBSTtBQUU3QyxtQkFBYSxVQUFVO0FBQ3ZCLHNCQUFnQixFQUFFLElBQUksUUFBUSxPQUFPLGdCQUFnQixRQUFRLFNBQVMsQ0FBQztBQUV2RSxrQkFBWSxFQUFFLElBQUksT0FBTyxhQUFhLFFBQVEsT0FBTyxTQUFTLFFBQVEsV0FBVyxNQUFNLE9BQU8sU0FBUyxDQUFDLEtBQUssRUFBRSxDQUFDO0FBQ2hILGtCQUFZLEVBQUUsSUFBSSxPQUFPLGFBQWEsUUFBUSxPQUFPLFVBQVUsUUFBUSxXQUFXLE1BQU0sT0FBTyxTQUFTLENBQUMsS0FBSyxFQUFFLENBQUM7QUFFakgsMkJBQXFCO0FBQ3JCLFlBQU0sVUFBVSxNQUFNLGtCQUFrQixJQUFJO0FBRTVDLGFBQU8sZ0JBQWdCLFFBQVEsT0FBTyxXQUFXLCtEQUErRDtBQUNoSCxhQUFPLGdCQUFnQixRQUFRLE9BQU8sVUFBVSxPQUFPLHNDQUFzQztBQUM3RixhQUFPLGdCQUFnQixRQUFRLGFBQWEsTUFBTSwyREFBMkQ7QUFDN0csYUFBTyxHQUFHLFFBQVEsU0FBUyxLQUFLLE9BQUssRUFBRSxTQUFTLG1CQUFtQixDQUFDLEdBQUcsZ0RBQWdEO0FBRXZILG9CQUFjO0FBQUEsSUFDaEIsVUFBRTtBQUNBLG9CQUFjO0FBQ2QsY0FBUSxJQUFJO0FBQUEsSUFDZDtBQUFBLEVBQ0YsQ0FBQztBQUdELE9BQUssNENBQTRDLFlBQVk7QUFDM0QsVUFBTSxPQUFPLGtCQUFrQjtBQUMvQixRQUFJO0FBQ0YsZ0JBQVUsTUFBTSxtQ0FBbUMsZUFBZTtBQUNsRSxnQkFBVSxNQUFNLGtDQUFrQyxpQkFBaUI7QUFDbkUsZ0JBQVUsTUFBTSxtQ0FBbUMscUNBQXFDO0FBRXhGLDJCQUFxQjtBQUNyQixZQUFNLFlBQVksTUFBTSxpQkFBaUIsSUFBSTtBQUU3QyxtQkFBYSxVQUFVO0FBQ3ZCLHNCQUFnQixFQUFFLElBQUksUUFBUSxPQUFPLGtCQUFrQixRQUFRLFNBQVMsQ0FBQztBQUN6RSxzQkFBZ0IsRUFBRSxJQUFJLFFBQVEsT0FBTyxxQkFBcUIsUUFBUSxTQUFTLENBQUM7QUFFNUUsMkJBQXFCO0FBQ3JCLFlBQU0sVUFBVSxNQUFNLGtCQUFrQixJQUFJO0FBRTVDLGFBQU8sZ0JBQWdCLFFBQVEsT0FBTyxVQUFVLE9BQU8scUNBQXFDO0FBQzVGLGFBQU8sZ0JBQWdCLFFBQVEsaUJBQWlCLElBQUksUUFBUSxvQ0FBb0M7QUFDaEcsYUFBTyxHQUFHLFFBQVEsU0FBUyxLQUFLLE9BQUssRUFBRSxPQUFPLFVBQVUsRUFBRSxXQUFXLFFBQVEsR0FBRyx1Q0FBdUM7QUFFdkgsb0JBQWM7QUFBQSxJQUNoQixVQUFFO0FBQ0Esb0JBQWM7QUFDZCxjQUFRLElBQUk7QUFBQSxJQUNkO0FBQUEsRUFDRixDQUFDO0FBR0QsT0FBSyxnREFBZ0QsWUFBWTtBQUMvRCxVQUFNLE9BQU8sa0JBQWtCO0FBQy9CLFFBQUk7QUFDRixZQUFNLGNBQWM7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBU3BCLGdCQUFVLE1BQU0sbUNBQW1DLFdBQVc7QUFHOUQsMkJBQXFCO0FBQ3JCLFlBQU0sWUFBWSxNQUFNLGlCQUFpQixJQUFJO0FBRTdDLG1CQUFhLFVBQVU7QUFDdkIsc0JBQWdCLEVBQUUsSUFBSSxRQUFRLE9BQU8saUJBQWlCLFFBQVEsU0FBUyxDQUFDO0FBQ3hFLGtCQUFZLEVBQUUsSUFBSSxPQUFPLGFBQWEsUUFBUSxPQUFPLGNBQWMsUUFBUSxZQUFZLE1BQU0sT0FBTyxTQUFTLENBQUMsRUFBRSxDQUFDO0FBRWpILDJCQUFxQjtBQUNyQixZQUFNLFVBQVUsTUFBTSxrQkFBa0IsSUFBSTtBQUU1QyxhQUFPLGdCQUFnQixRQUFRLE9BQU8sd0JBQXdCLDRDQUE0QztBQUMxRyxhQUFPLGdCQUFnQixRQUFRLE9BQU8sVUFBVSxPQUFPLHVDQUF1QztBQUM5RixhQUFPLGdCQUFnQixRQUFRLGlCQUFpQixJQUFJLFFBQVEsc0NBQXNDO0FBRWxHLG9CQUFjO0FBQUEsSUFDaEIsVUFBRTtBQUNBLG9CQUFjO0FBQ2QsY0FBUSxJQUFJO0FBQUEsSUFDZDtBQUFBLEVBQ0YsQ0FBQztBQUdELE9BQUssbUZBQW1GLFlBQVk7QUFDbEcsVUFBTSxPQUFPLGtCQUFrQjtBQUMvQixRQUFJO0FBQ0YsWUFBTSxjQUFjO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQVNwQixnQkFBVSxNQUFNLG1DQUFtQyxXQUFXO0FBQzlEO0FBQUEsUUFBVTtBQUFBLFFBQU07QUFBQSxRQUNkO0FBQUEsTUFBMEY7QUFFNUYsMkJBQXFCO0FBQ3JCLFlBQU0sWUFBWSxNQUFNLGlCQUFpQixJQUFJO0FBRTdDLG1CQUFhLFVBQVU7QUFDdkIsc0JBQWdCLEVBQUUsSUFBSSxRQUFRLE9BQU8scUJBQXFCLFFBQVEsU0FBUyxDQUFDO0FBQzVFLGtCQUFZLEVBQUUsSUFBSSxPQUFPLGFBQWEsUUFBUSxPQUFPLGNBQWMsUUFBUSxZQUFZLE1BQU0sT0FBTyxTQUFTLENBQUMsRUFBRSxDQUFDO0FBQ2pILHVCQUFpQjtBQUFBLFFBQ2YsTUFBTTtBQUFBLFFBQ04sYUFBYTtBQUFBLFFBQ2IsUUFBUTtBQUFBLFFBQ1IsT0FBTztBQUFBLFFBQ1AsYUFBYTtBQUFBLE1BQ2YsQ0FBQztBQUVELDJCQUFxQjtBQUNyQixZQUFNLFVBQVUsTUFBTSxrQkFBa0IsSUFBSTtBQUU1QyxhQUFPLGdCQUFnQixRQUFRLE9BQU8sV0FBVyx3Q0FBd0M7QUFDekYsYUFBTyxnQkFBZ0IsUUFBUSxPQUFPLFVBQVUsT0FBTyxnREFBZ0Q7QUFDdkcsYUFBTyxnQkFBZ0IsUUFBUSxpQkFBaUIsSUFBSSxRQUFRLCtDQUErQztBQUMzRyxhQUFPO0FBQUEsUUFDTCxRQUFRLFNBQVMsS0FBSyxPQUFLLEVBQUUsU0FBUyxtQkFBbUIsS0FBSyxFQUFFLFNBQVMsTUFBTSxDQUFDO0FBQUEsUUFDaEY7QUFBQSxNQUNGO0FBRUEsb0JBQWM7QUFBQSxJQUNoQixVQUFFO0FBQ0Esb0JBQWM7QUFDZCxjQUFRLElBQUk7QUFBQSxJQUNkO0FBQUEsRUFDRixDQUFDO0FBR0QsT0FBSyxnREFBZ0QsWUFBWTtBQUMvRCxVQUFNLE9BQU8sa0JBQWtCO0FBQy9CLFFBQUk7QUFDRixZQUFNLGNBQWM7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBU3BCLGdCQUFVLE1BQU0sbUNBQW1DLFdBQVc7QUFDOUQsZ0JBQVUsTUFBTSxzQ0FBc0Msd0VBQXdFO0FBRTlILDJCQUFxQjtBQUNyQixZQUFNLFlBQVksTUFBTSxpQkFBaUIsSUFBSTtBQUU3QyxtQkFBYSxVQUFVO0FBQ3ZCLHNCQUFnQixFQUFFLElBQUksUUFBUSxPQUFPLGlCQUFpQixRQUFRLFNBQVMsQ0FBQztBQUN4RSxrQkFBWSxFQUFFLElBQUksT0FBTyxhQUFhLFFBQVEsT0FBTyxjQUFjLFFBQVEsWUFBWSxNQUFNLE9BQU8sU0FBUyxDQUFDLEVBQUUsQ0FBQztBQUNqSCx1QkFBaUI7QUFBQSxRQUNmLE1BQU07QUFBQSxRQUNOLGFBQWE7QUFBQSxRQUNiLFFBQVE7QUFBQSxRQUNSLE9BQU87QUFBQSxRQUNQLGFBQWE7QUFBQSxNQUNmLENBQUM7QUFFRCwyQkFBcUI7QUFDckIsWUFBTSxVQUFVLE1BQU0sa0JBQWtCLElBQUk7QUFFNUMsYUFBTyxnQkFBZ0IsUUFBUSxPQUFPLHdCQUF3Qiw4Q0FBOEM7QUFDNUcsYUFBTyxnQkFBZ0IsUUFBUSxPQUFPLFVBQVUsT0FBTyx5Q0FBeUM7QUFFaEcsb0JBQWM7QUFBQSxJQUNoQixVQUFFO0FBQ0Esb0JBQWM7QUFDZCxjQUFRLElBQUk7QUFBQSxJQUNkO0FBQUEsRUFDRixDQUFDO0FBR0QsT0FBSyw0Q0FBNEMsWUFBWTtBQUMzRCxVQUFNLE9BQU8sa0JBQWtCO0FBQy9CLFFBQUk7QUFDRixnQkFBVSxNQUFNLG1DQUFtQyxlQUFlO0FBQ2xFLGdCQUFVLE1BQU0sMENBQTBDLFlBQVk7QUFDdEUsZ0JBQVUsTUFBTSw2Q0FBNkMsRUFBRTtBQUMvRCxnQkFBVSxNQUFNLGdEQUFnRCxZQUFZO0FBQzVFLGdCQUFVLE1BQU0sb0RBQW9ELG1CQUFtQjtBQUV2RiwyQkFBcUI7QUFDckIsWUFBTSxZQUFZLE1BQU0saUJBQWlCLElBQUk7QUFFN0MsbUJBQWEsVUFBVTtBQUN2QixzQkFBZ0IsRUFBRSxJQUFJLFFBQVEsT0FBTyxrQkFBa0IsUUFBUSxTQUFTLENBQUM7QUFDekUsa0JBQVksRUFBRSxJQUFJLE9BQU8sYUFBYSxRQUFRLE9BQU8sZUFBZSxRQUFRLFVBQVUsTUFBTSxPQUFPLFNBQVMsQ0FBQyxFQUFFLENBQUM7QUFDaEgsa0JBQVksRUFBRSxJQUFJLE9BQU8sYUFBYSxRQUFRLE9BQU8sZ0JBQWdCLFFBQVEsV0FBVyxNQUFNLE9BQU8sU0FBUyxDQUFDLEtBQUssRUFBRSxDQUFDO0FBQ3ZILGlCQUFXLEVBQUUsSUFBSSxPQUFPLFNBQVMsT0FBTyxhQUFhLFFBQVEsT0FBTyxjQUFjLFFBQVEsVUFBVSxDQUFDO0FBQ3JHLGlCQUFXLEVBQUUsSUFBSSxPQUFPLFNBQVMsT0FBTyxhQUFhLFFBQVEsT0FBTyxhQUFhLFFBQVEsV0FBVyxDQUFDO0FBR3JHLFlBQU0sRUFBRSxZQUFZLElBQUksTUFBTSxPQUFPLGNBQWM7QUFDbkQsWUFBTSxVQUFVLFlBQVk7QUFDNUIsY0FBUztBQUFBLFFBQ1A7QUFBQSxNQUNGLEVBQUUsSUFBSSxFQUFFLFFBQU8sb0JBQUksS0FBSyxHQUFFLFlBQVksR0FBRyxRQUFRLFFBQVEsUUFBUSxNQUFNLENBQUM7QUFHeEUsMkJBQXFCO0FBQ3JCLFlBQU0sVUFBVSxNQUFNLGtCQUFrQixJQUFJO0FBRTVDLGFBQU8sZ0JBQWdCLFFBQVEsT0FBTyxvQkFBb0Isc0NBQXNDO0FBQ2hHLGFBQU8sZ0JBQWdCLFFBQVEsT0FBTyxVQUFVLE9BQU8scUNBQXFDO0FBRTVGLG9CQUFjO0FBQUEsSUFDaEIsVUFBRTtBQUNBLG9CQUFjO0FBQ2QsY0FBUSxJQUFJO0FBQUEsSUFDZDtBQUFBLEVBQ0YsQ0FBQztBQUdELE9BQUssMENBQTBDLFlBQVk7QUFDekQsVUFBTSxPQUFPLGtCQUFrQjtBQUMvQixRQUFJO0FBQ0YsZ0JBQVUsTUFBTSxtQ0FBbUMsZUFBZTtBQUNsRSxnQkFBVSxNQUFNLDBDQUEwQyxZQUFZO0FBQ3RFLGdCQUFVLE1BQU0sNkNBQTZDLEVBQUU7QUFDL0QsZ0JBQVUsTUFBTSxnREFBZ0QsWUFBWTtBQUU1RSxtQkFBYSxVQUFVO0FBQ3ZCLHNCQUFnQixFQUFFLElBQUksUUFBUSxPQUFPLGtCQUFrQixRQUFRLFNBQVMsQ0FBQztBQUN6RSxrQkFBWSxFQUFFLElBQUksT0FBTyxhQUFhLFFBQVEsT0FBTyxlQUFlLFFBQVEsVUFBVSxNQUFNLE9BQU8sU0FBUyxDQUFDLEVBQUUsQ0FBQztBQUNoSCxrQkFBWSxFQUFFLElBQUksT0FBTyxhQUFhLFFBQVEsT0FBTyxnQkFBZ0IsUUFBUSxXQUFXLE1BQU0sT0FBTyxTQUFTLENBQUMsS0FBSyxFQUFFLENBQUM7QUFDdkgsaUJBQVcsRUFBRSxJQUFJLE9BQU8sU0FBUyxPQUFPLGFBQWEsUUFBUSxPQUFPLGNBQWMsUUFBUSxVQUFVLENBQUM7QUFDckcsaUJBQVcsRUFBRSxJQUFJLE9BQU8sU0FBUyxPQUFPLGFBQWEsUUFBUSxPQUFPLGFBQWEsUUFBUSxXQUFXLENBQUM7QUFHckcsMkJBQXFCO0FBQ3JCLFlBQU0sa0JBQWtCLElBQUk7QUFHNUIsWUFBTSxRQUFRLFlBQVksSUFBSTtBQUM5QiwyQkFBcUI7QUFDckIsWUFBTSxrQkFBa0IsSUFBSTtBQUM1QixZQUFNLFVBQVUsWUFBWSxJQUFJLElBQUk7QUFFcEMsY0FBUSxJQUFJLDhCQUE4QixRQUFRLFFBQVEsQ0FBQyxDQUFDLElBQUk7QUFJaEUsYUFBTyxHQUFHLFVBQVUsSUFBSSwyQ0FBMkMsUUFBUSxRQUFRLENBQUMsQ0FBQyxLQUFLO0FBRTFGLG9CQUFjO0FBQUEsSUFDaEIsVUFBRTtBQUNBLG9CQUFjO0FBQ2QsY0FBUSxJQUFJO0FBQUEsSUFDZDtBQUFBLEVBQ0YsQ0FBQztBQUdELE9BQUssZ0RBQWdELFlBQVk7QUFDL0QsVUFBTSxPQUFPLGtCQUFrQjtBQUMvQixRQUFJO0FBQ0YsWUFBTSxZQUFZO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQVNsQixZQUFNLFlBQVk7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBU2xCLGdCQUFVLE1BQU0sbUNBQW1DLFNBQVM7QUFDNUQsZ0JBQVUsTUFBTSxzQ0FBc0MsMERBQTBEO0FBQ2hILGdCQUFVLE1BQU0sbUNBQW1DLHlCQUF5QjtBQUM1RSxnQkFBVSxNQUFNLG1DQUFtQyxTQUFTO0FBQzVELGdCQUFVLE1BQU0sbUNBQW1DLHVFQUF1RTtBQUMxSCxnQkFBVSxNQUFNLG1DQUFtQyxzRUFBc0U7QUFFekgsMkJBQXFCO0FBQ3JCLFlBQU0sWUFBWSxNQUFNLGlCQUFpQixJQUFJO0FBRTdDLG1CQUFhLFVBQVU7QUFDdkIsc0JBQWdCLEVBQUUsSUFBSSxRQUFRLE9BQU8sU0FBUyxRQUFRLFlBQVksWUFBWSxDQUFDLEVBQUUsQ0FBQztBQUNsRixrQkFBWSxFQUFFLElBQUksT0FBTyxhQUFhLFFBQVEsT0FBTyxRQUFRLFFBQVEsWUFBWSxNQUFNLE9BQU8sU0FBUyxDQUFDLEVBQUUsQ0FBQztBQUMzRyxzQkFBZ0IsRUFBRSxJQUFJLFFBQVEsT0FBTyxVQUFVLFFBQVEsVUFBVSxZQUFZLENBQUMsTUFBTSxFQUFFLENBQUM7QUFDdkYsa0JBQVksRUFBRSxJQUFJLE9BQU8sYUFBYSxRQUFRLE9BQU8sVUFBVSxRQUFRLFdBQVcsTUFBTSxPQUFPLFNBQVMsQ0FBQyxFQUFFLENBQUM7QUFDNUcsc0JBQWdCLEVBQUUsSUFBSSxRQUFRLE9BQU8sU0FBUyxRQUFRLFVBQVUsWUFBWSxDQUFDLE1BQU0sRUFBRSxDQUFDO0FBRXRGLDJCQUFxQjtBQUNyQixZQUFNLFVBQVUsTUFBTSxrQkFBa0IsSUFBSTtBQUU1QyxhQUFPLGdCQUFnQixRQUFRLFNBQVMsUUFBUSxVQUFVLFNBQVMsUUFBUSx3Q0FBd0M7QUFDbkgsYUFBTyxnQkFBZ0IsUUFBUSxpQkFBaUIsSUFBSSxRQUFRLHdFQUF3RTtBQUNwSSxhQUFPLGdCQUFnQixRQUFRLGlCQUFpQixJQUFJLFVBQVUsaUJBQWlCLElBQUksbURBQW1EO0FBQ3RJLGFBQU8sZ0JBQWdCLFFBQVEsT0FBTyxVQUFVLE9BQU8seUNBQXlDO0FBR2hHLFlBQU0sUUFBUSxRQUFRLFNBQVMsS0FBSyxPQUFLLEVBQUUsT0FBTyxNQUFNO0FBQ3hELFlBQU0sUUFBUSxRQUFRLFNBQVMsS0FBSyxPQUFLLEVBQUUsT0FBTyxNQUFNO0FBQ3hELFlBQU0sUUFBUSxRQUFRLFNBQVMsS0FBSyxPQUFLLEVBQUUsT0FBTyxNQUFNO0FBQ3hELGFBQU8sZ0JBQWdCLE9BQU8sUUFBUSxZQUFZLGlDQUFpQztBQUNuRixhQUFPLGdCQUFnQixPQUFPLFFBQVEsVUFBVSwrQkFBK0I7QUFDL0UsYUFBTyxnQkFBZ0IsT0FBTyxRQUFRLFdBQVcsaURBQWlEO0FBRWxHLG9CQUFjO0FBQUEsSUFDaEIsVUFBRTtBQUNBLG9CQUFjO0FBQ2QsY0FBUSxJQUFJO0FBQUEsSUFDZDtBQUFBLEVBQ0YsQ0FBQztBQUdELE9BQUsseUNBQXlDLFlBQVk7QUFDeEQsVUFBTSxPQUFPLGtCQUFrQjtBQUMvQixRQUFJO0FBQ0YsZ0JBQVUsTUFBTSxtQ0FBbUMsZUFBZTtBQUNsRSxnQkFBVSxNQUFNLDBDQUEwQyxZQUFZO0FBQ3RFLGdCQUFVLE1BQU0sNkNBQTZDLEVBQUU7QUFDL0QsZ0JBQVUsTUFBTSxnREFBZ0QsWUFBWTtBQUU1RSxtQkFBYSxVQUFVO0FBQ3ZCLHNCQUFnQixFQUFFLElBQUksUUFBUSxPQUFPLGtCQUFrQixRQUFRLFNBQVMsQ0FBQztBQUN6RSxrQkFBWSxFQUFFLElBQUksT0FBTyxhQUFhLFFBQVEsT0FBTyxlQUFlLFFBQVEsVUFBVSxNQUFNLE9BQU8sU0FBUyxDQUFDLEVBQUUsQ0FBQztBQUNoSCxrQkFBWSxFQUFFLElBQUksT0FBTyxhQUFhLFFBQVEsT0FBTyxnQkFBZ0IsUUFBUSxXQUFXLE1BQU0sT0FBTyxTQUFTLENBQUMsS0FBSyxFQUFFLENBQUM7QUFFdkgsaUJBQVcsRUFBRSxJQUFJLE9BQU8sU0FBUyxPQUFPLGFBQWEsUUFBUSxPQUFPLGNBQWMsUUFBUSxVQUFVLENBQUM7QUFDckcsaUJBQVcsRUFBRSxJQUFJLE9BQU8sU0FBUyxPQUFPLGFBQWEsUUFBUSxPQUFPLGFBQWEsUUFBUSxPQUFPLENBQUM7QUFFakcsMkJBQXFCO0FBQ3JCLFlBQU0sVUFBVSxNQUFNLGtCQUFrQixJQUFJO0FBRTVDLGFBQU8sZ0JBQWdCLFFBQVEsT0FBTyxhQUFhLDZCQUE2QjtBQUNoRixhQUFPLGdCQUFnQixRQUFRLFlBQVksSUFBSSxPQUFPLHVDQUF1QztBQUM3RixhQUFPLGdCQUFnQixRQUFRLFVBQVUsT0FBTyxNQUFNLEdBQUcsd0NBQXdDO0FBRWpHLG9CQUFjO0FBQUEsSUFDaEIsVUFBRTtBQUNBLG9CQUFjO0FBQ2QsY0FBUSxJQUFJO0FBQUEsSUFDZDtBQUFBLEVBQ0YsQ0FBQztBQUdELE9BQUsscUNBQXFDLFlBQVk7QUFDcEQsVUFBTSxPQUFPLGtCQUFrQjtBQUMvQixRQUFJO0FBQ0YsZ0JBQVUsTUFBTSxtQ0FBbUMsZUFBZTtBQUNsRSxnQkFBVSxNQUFNLDBDQUEwQyxZQUFZO0FBQ3RFLGdCQUFVLE1BQU0sNkNBQTZDLEVBQUU7QUFDL0QsZ0JBQVUsTUFBTSxnREFBZ0QsWUFBWTtBQUU1RSxtQkFBYSxVQUFVO0FBQ3ZCLHNCQUFnQixFQUFFLElBQUksUUFBUSxPQUFPLGtCQUFrQixRQUFRLFNBQVMsQ0FBQztBQUN6RSxrQkFBWSxFQUFFLElBQUksT0FBTyxhQUFhLFFBQVEsT0FBTyxlQUFlLFFBQVEsVUFBVSxNQUFNLE9BQU8sU0FBUyxDQUFDLEVBQUUsQ0FBQztBQUNoSCxrQkFBWSxFQUFFLElBQUksT0FBTyxhQUFhLFFBQVEsT0FBTyxnQkFBZ0IsUUFBUSxXQUFXLE1BQU0sT0FBTyxTQUFTLENBQUMsS0FBSyxFQUFFLENBQUM7QUFDdkgsaUJBQVcsRUFBRSxJQUFJLE9BQU8sU0FBUyxPQUFPLGFBQWEsUUFBUSxPQUFPLGNBQWMsUUFBUSxVQUFVLENBQUM7QUFDckcsaUJBQVcsRUFBRSxJQUFJLE9BQU8sU0FBUyxPQUFPLGFBQWEsUUFBUSxPQUFPLGFBQWEsUUFBUSxXQUFXLENBQUM7QUFHckcsMkJBQXFCO0FBQ3JCLFlBQU0sUUFBUSxNQUFNLFlBQVksSUFBSTtBQUVwQyxhQUFPLGdCQUFnQixNQUFNLE9BQU8sYUFBYSwrQkFBK0I7QUFDaEYsYUFBTyxnQkFBZ0IsTUFBTSxpQkFBaUIsSUFBSSxRQUFRLG9DQUFvQztBQUM5RixhQUFPLGdCQUFnQixNQUFNLGFBQWEsSUFBSSxPQUFPLCtCQUErQjtBQUNwRixhQUFPLGdCQUFnQixNQUFNLFlBQVksSUFBSSxPQUFPLDhCQUE4QjtBQUVsRixvQkFBYztBQUFBLElBQ2hCLFVBQUU7QUFDQSxvQkFBYztBQUNkLGNBQVEsSUFBSTtBQUFBLElBQ2Q7QUFBQSxFQUNGLENBQUM7QUFHRCxPQUFLLDJFQUEyRSxZQUFZO0FBQzFGLFVBQU0sT0FBTyxrQkFBa0I7QUFDL0IsUUFBSTtBQUVGLGdCQUFVLEtBQUssTUFBTSxRQUFRLGNBQWMsTUFBTSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDdkUsb0JBQWMsS0FBSyxNQUFNLFFBQVEsY0FBYyxRQUFRLFdBQVcsR0FBRyxJQUFJO0FBRXpFLGdCQUFVLE1BQU0sbUNBQW1DLGlDQUFpQztBQUVwRiwyQkFBcUI7QUFDckIsWUFBTSxZQUFZLE1BQU0saUJBQWlCLElBQUk7QUFFN0MsbUJBQWEsVUFBVTtBQUV2QixzQkFBZ0IsRUFBRSxJQUFJLFFBQVEsT0FBTyxRQUFRLFFBQVEsU0FBUyxDQUFDO0FBRS9ELDJCQUFxQjtBQUNyQixZQUFNLFVBQVUsTUFBTSxrQkFBa0IsSUFBSTtBQUc1QyxhQUFPLGdCQUFnQixRQUFRLGlCQUFpQixJQUFJLFFBQVEsbURBQW1EO0FBQy9HLGFBQU8sZ0JBQWdCLFFBQVEsaUJBQWlCLElBQUksVUFBVSxpQkFBaUIsSUFBSSw4QkFBOEI7QUFFakgsYUFBTyxHQUFHLENBQUMsUUFBUSxTQUFTLEtBQUssT0FBSyxFQUFFLE9BQU8sTUFBTSxHQUFHLGdDQUFnQztBQUV4RixvQkFBYztBQUFBLElBQ2hCLFVBQUU7QUFDQSxvQkFBYztBQUNkLGNBQVEsSUFBSTtBQUFBLElBQ2Q7QUFBQSxFQUNGLENBQUM7QUFHRCxPQUFLLG1EQUFtRCxZQUFZO0FBQ2xFLFVBQU0sT0FBTyxrQkFBa0I7QUFDL0IsUUFBSTtBQUNGLGdCQUFVLE1BQU0seUNBQXlDLGlDQUFpQztBQUUxRiwyQkFBcUI7QUFDckIsWUFBTSxZQUFZLE1BQU0saUJBQWlCLElBQUk7QUFFN0MsbUJBQWEsVUFBVTtBQUN2QixzQkFBZ0IsRUFBRSxJQUFJLFFBQVEsT0FBTyxTQUFTLFFBQVEsbUJBQW1CLENBQUM7QUFFMUUsMkJBQXFCO0FBQ3JCLFlBQU0sVUFBVSxNQUFNLGtCQUFrQixJQUFJO0FBRTVDLGFBQU8sZ0JBQWdCLFFBQVEsT0FBTyxvQkFBb0IsdUNBQXVDO0FBQ2pHLGFBQU8sZ0JBQWdCLFFBQVEsT0FBTyxVQUFVLE9BQU8sc0NBQXNDO0FBRTdGLG9CQUFjO0FBQUEsSUFDaEIsVUFBRTtBQUNBLG9CQUFjO0FBQ2QsY0FBUSxJQUFJO0FBQUEsSUFDZDtBQUFBLEVBQ0YsQ0FBQztBQUdELE9BQUssb0VBQW9FLFlBQVk7QUFDbkYsVUFBTSxPQUFPLGtCQUFrQjtBQUMvQixRQUFJO0FBRUYsZ0JBQVUsTUFBTSxtQ0FBbUMseUJBQXlCO0FBQzVFLGdCQUFVLE1BQU0sbUNBQW1DLHFDQUFxQztBQUV4RixtQkFBYSxVQUFVO0FBRXZCLHNCQUFnQixFQUFFLElBQUksUUFBUSxPQUFPLFNBQVMsUUFBUSxXQUFXLENBQUM7QUFFbEUsMkJBQXFCO0FBQ3JCLFlBQU0sUUFBUSxNQUFNLGtCQUFrQixJQUFJO0FBRTFDLGFBQU8sZ0JBQWdCLE1BQU0sT0FBTyxZQUFZLHFEQUFxRDtBQUNyRyxhQUFPLGdCQUFnQixNQUFNLFNBQVMsUUFBUSxHQUFHLHdEQUF3RDtBQUN6RyxhQUFPLGdCQUFnQixNQUFNLFNBQVMsQ0FBQyxHQUFHLElBQUksUUFBUSxxQ0FBcUM7QUFDM0YsYUFBTyxnQkFBZ0IsTUFBTSxTQUFTLENBQUMsR0FBRyxRQUFRLFlBQVksa0NBQWtDO0FBQ2hHLGFBQU8sZ0JBQWdCLE1BQU0sU0FBUyxDQUFDLEdBQUcsUUFBVyw2REFBNkQ7QUFDbEgsYUFBTyxnQkFBZ0IsTUFBTSxpQkFBaUIsTUFBTSx3REFBd0Q7QUFFNUcsb0JBQWM7QUFBQSxJQUNoQixVQUFFO0FBQ0Esb0JBQWM7QUFDZCxjQUFRLElBQUk7QUFBQSxJQUNkO0FBQUEsRUFDRixDQUFDO0FBR0QsT0FBSyxzRkFBc0YsWUFBWTtBQUNyRyxRQUFJO0FBQ0YsbUJBQWEsVUFBVTtBQUd2QixzQkFBZ0IsRUFBRSxJQUFJLFFBQVEsUUFBUSxTQUFTLENBQUM7QUFFaEQsWUFBTSxTQUFTLGlCQUFpQjtBQUNoQyxhQUFPLE1BQU0sT0FBTyxRQUFRLEdBQUcsdUNBQXVDO0FBQ3RFLGFBQU8sTUFBTSxPQUFPLENBQUMsRUFBRyxRQUFRLFVBQVUsOEJBQThCO0FBR3hFLHNCQUFnQixFQUFFLElBQUksUUFBUSxPQUFPLGlCQUFpQixRQUFRLFNBQVMsQ0FBQztBQUV4RSxZQUFNLFFBQVEsaUJBQWlCO0FBQy9CLGFBQU8sTUFBTSxNQUFNLFFBQVEsR0FBRyxzQ0FBc0M7QUFFcEUsYUFBTyxNQUFNLE1BQU0sQ0FBQyxFQUFHLFFBQVEsVUFBVSx3REFBd0Q7QUFFakcsb0JBQWM7QUFBQSxJQUNoQixVQUFFO0FBQ0Esb0JBQWM7QUFBQSxJQUNoQjtBQUFBLEVBQ0YsQ0FBQztBQUdELE9BQUssZ0ZBQWdGLFlBQVk7QUFDL0YsVUFBTSxPQUFPLGtCQUFrQjtBQUMvQixRQUFJO0FBRUYsZ0JBQVUsTUFBTSxtQ0FBbUMseUJBQXlCO0FBSzVFLGdCQUFVLEtBQUssTUFBTSxRQUFRLGNBQWMsUUFBUSxRQUFRLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUdqRixnQkFBVSxLQUFLLE1BQU0sUUFBUSxhQUFhLE1BQU0sR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBR3RFLGFBQU8sR0FBRyxDQUFDLGlCQUFpQixNQUFNLE1BQU0sR0FBRyw2Q0FBNkM7QUFHeEYsbUJBQWEsVUFBVTtBQUN2QixzQkFBZ0IsRUFBRSxJQUFJLFFBQVEsT0FBTyxTQUFTLFFBQVEsV0FBVyxDQUFDO0FBR2xFLDJCQUFxQjtBQUNyQixZQUFNLFVBQVUsTUFBTSxrQkFBa0IsSUFBSTtBQUc1QyxZQUFNLFlBQVksUUFBUSxTQUFTLEtBQUssT0FBSyxFQUFFLE9BQU8sTUFBTTtBQUM1RCxhQUFPLE1BQU0sV0FBVyxRQUFXLHFEQUFxRDtBQUN4RixhQUFPLGdCQUFnQixRQUFRLGlCQUFpQixNQUFNLHVEQUF1RDtBQUM3RyxhQUFPLE1BQU0sUUFBUSxPQUFPLFlBQVksZ0RBQWdEO0FBRXhGLG9CQUFjO0FBQUEsSUFDaEIsVUFBRTtBQUNBLG9CQUFjO0FBQ2QsY0FBUSxJQUFJO0FBQUEsSUFDZDtBQUFBLEVBQ0YsQ0FBQztBQUdELE9BQUssOEVBQThFLFlBQVk7QUFDN0YsVUFBTSxPQUFPLGtCQUFrQjtBQUMvQixRQUFJO0FBRUYsZ0JBQVUsTUFBTSxtQ0FBbUMseUJBQXlCO0FBRzVFLGdCQUFVLEtBQUssTUFBTSxRQUFRLGNBQWMsUUFBUSxRQUFRLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNqRixnQkFBVSxNQUFNLG1DQUFtQyxzQ0FBc0M7QUFHekYsbUJBQWEsVUFBVTtBQUN2QixzQkFBZ0IsRUFBRSxJQUFJLFFBQVEsT0FBTyxTQUFTLFFBQVEsV0FBVyxDQUFDO0FBQ2xFLHNCQUFnQixFQUFFLElBQUksUUFBUSxPQUFPLFVBQVUsUUFBUSxTQUFTLENBQUM7QUFHakUsYUFBTyxHQUFHLENBQUMsaUJBQWlCLE1BQU0sTUFBTSxHQUFHLDBEQUEwRDtBQUVyRywyQkFBcUI7QUFDckIsWUFBTSxVQUFVLE1BQU0sa0JBQWtCLElBQUk7QUFHNUMsWUFBTSxZQUFZLFFBQVEsU0FBUyxLQUFLLE9BQUssRUFBRSxPQUFPLE1BQU07QUFDNUQsYUFBTyxHQUFHLGNBQWMsUUFBVyx5Q0FBeUM7QUFDNUUsYUFBTyxnQkFBZ0IsUUFBUSxpQkFBaUIsSUFBSSxRQUFRLG9DQUFvQztBQUNoRyxhQUFPLFNBQVMsUUFBUSxPQUFPLFlBQVksMkNBQTJDO0FBRXRGLG9CQUFjO0FBQUEsSUFDaEIsVUFBRTtBQUNBLG9CQUFjO0FBQ2QsY0FBUSxJQUFJO0FBQUEsSUFDZDtBQUFBLEVBQ0YsQ0FBQztBQUNILENBQUM7IiwKICAibmFtZXMiOiBbInQiXQp9Cg==
