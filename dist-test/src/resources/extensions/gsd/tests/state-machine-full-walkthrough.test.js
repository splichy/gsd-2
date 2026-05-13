import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  deriveState,
  deriveStateFromDb,
  isValidationTerminal,
  isGhostMilestone,
  invalidateStateCache,
  getActiveMilestoneId
} from "../state.js";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  updateTaskStatus,
  getAllMilestones,
  insertGateRow,
  getPendingSliceGateCount
} from "../gsd-db.js";
import { isClosedStatus } from "../status-guards.js";
import { clearPathCache } from "../paths.js";
const tempDirs = [];
function createFixtureBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-walkthrough-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  tempDirs.push(base);
  return base;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
    }
  }
  try {
    closeDatabase();
  } catch {
  }
});
function writeContext(base, mid, content) {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-CONTEXT.md`), content);
}
function writeContextDraft(base, mid, content) {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-CONTEXT-DRAFT.md`), content);
}
function writeRoadmap(base, mid, content) {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-ROADMAP.md`), content);
}
function writePlan(base, mid, sid, content) {
  const dir = join(base, ".gsd", "milestones", mid, "slices", sid);
  const tasksDir = join(dir, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(dir, `${sid}-PLAN.md`), content);
  const taskMatches = content.matchAll(/\*\*(T\d+):/g);
  for (const m of taskMatches) {
    const tid = m[1];
    writeFileSync(join(tasksDir, `${tid}-PLAN.md`), `# ${tid} Plan

Stub.
`);
  }
}
function writeTaskSummary(base, mid, sid, tid) {
  const tasksDir = join(base, ".gsd", "milestones", mid, "slices", sid, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(tasksDir, `${tid}-SUMMARY.md`), [
    `# ${tid} Summary`,
    "",
    "Task completed successfully."
  ].join("\n"));
}
function writeTaskSummaryWithBlocker(base, mid, sid, tid) {
  const tasksDir = join(base, ".gsd", "milestones", mid, "slices", sid, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(tasksDir, `${tid}-SUMMARY.md`), [
    "---",
    "blocker_discovered: true",
    "---",
    "",
    `# ${tid} Summary`,
    "",
    "Blocker found during execution."
  ].join("\n"));
}
function writeSliceSummary(base, mid, sid) {
  const dir = join(base, ".gsd", "milestones", mid, "slices", sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}-SUMMARY.md`), `# ${sid} Summary

Slice done.
`);
}
function writeMilestoneSummary(base, mid) {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-SUMMARY.md`), `# ${mid} Summary

Milestone complete.
`);
}
function writeMilestoneValidation(base, mid, verdict = "pass") {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-VALIDATION.md`), [
    "---",
    `verdict: ${verdict}`,
    "remediation_round: 0",
    "---",
    "",
    "# Validation",
    "Validated."
  ].join("\n"));
}
function writeReplanTrigger(base, mid, sid) {
  const dir = join(base, ".gsd", "milestones", mid, "slices", sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}-REPLAN-TRIGGER.md`), "Triage replan triggered.\n");
}
function writeReplan(base, mid, sid) {
  const dir = join(base, ".gsd", "milestones", mid, "slices", sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}-REPLAN.md`), "# Replan\n\nReplan completed.\n");
}
function writeContinue(base, mid, sid) {
  const dir = join(base, ".gsd", "milestones", mid, "slices", sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}-CONTINUE.md`), [
    "---",
    "milestone: " + mid,
    "slice: " + sid,
    "task: T01",
    "status: interrupted",
    "---",
    "",
    "# Continue",
    "Resume from step 2."
  ].join("\n"));
}
function standardRoadmap() {
  return [
    "# M001: Test Milestone",
    "",
    "**Vision:** Test state machine.",
    "",
    "## Slices",
    "",
    "- [ ] **S01: First Slice** `risk:low` `depends:[]`",
    "  > After this: slice done."
  ].join("\n");
}
function doneSliceRoadmap() {
  return [
    "# M001: Test Milestone",
    "",
    "**Vision:** Test state machine.",
    "",
    "## Slices",
    "",
    "- [x] **S01: Done Slice** `risk:low` `depends:[]`",
    "  > After this: slice done."
  ].join("\n");
}
function standardPlan() {
  return [
    "# S01: First Slice",
    "",
    "**Goal:** Test.",
    "**Demo:** Tests pass.",
    "",
    "## Tasks",
    "",
    "- [ ] **T01: First Task** `est:10m`",
    "  First task description.",
    "",
    "- [ ] **T02: Second Task** `est:10m`",
    "  Second task description."
  ].join("\n");
}
function allDonePlan() {
  return [
    "# S01: First Slice",
    "",
    "**Goal:** Test.",
    "**Demo:** Tests pass.",
    "",
    "## Tasks",
    "",
    "- [x] **T01: First Task** `est:10m`",
    "  First task done.",
    "",
    "- [x] **T02: Second Task** `est:10m`",
    "  Second task done."
  ].join("\n");
}
function partialDonePlan() {
  return [
    "# S01: First Slice",
    "",
    "**Goal:** Test.",
    "**Demo:** Tests pass.",
    "",
    "## Tasks",
    "",
    "- [x] **T01: First Task** `est:10m`",
    "  First task done.",
    "",
    "- [ ] **T02: Second Task** `est:10m`",
    "  Second task pending."
  ].join("\n");
}
describe("state-machine-full-walkthrough", () => {
  describe("Phase 1: pre-planning", () => {
    test("empty milestones dir \u2192 pre-planning", async () => {
      const base = createFixtureBase();
      invalidateStateCache();
      const state = await deriveState(base);
      assert.equal(state.phase, "pre-planning");
      assert.equal(state.activeMilestone, null);
      assert.equal(state.activeSlice, null);
      assert.equal(state.activeTask, null);
      assert.deepStrictEqual(state.registry, []);
    });
    test("milestone with CONTEXT but no ROADMAP \u2192 pre-planning", async () => {
      const base = createFixtureBase();
      writeContext(base, "M001", "# M001: Test\n\nSome context.");
      invalidateStateCache();
      const state = await deriveState(base);
      assert.equal(state.phase, "pre-planning");
      assert.ok(state.activeMilestone !== null, "activeMilestone should be set");
      assert.equal(state.activeMilestone?.id, "M001");
    });
    test("roadmap with zero slices \u2192 pre-planning (not validating-milestone)", async () => {
      const base = createFixtureBase();
      writeContext(base, "M001", "# M001: Test\n\nContext.");
      writeRoadmap(base, "M001", [
        "# M001: Test Milestone",
        "",
        "**Vision:** Test.",
        "",
        "## Slices",
        "",
        "No slices defined yet."
      ].join("\n"));
      invalidateStateCache();
      const state = await deriveState(base);
      assert.equal(state.phase, "pre-planning", "zero slices must NOT trigger validating-milestone (#2667)");
    });
  });
  describe("Phase 2: needs-discussion", () => {
    test("CONTEXT-DRAFT exists, no CONTEXT \u2192 needs-discussion", async () => {
      const base = createFixtureBase();
      writeContextDraft(base, "M001", "# M001: Draft\n\nDraft context.");
      invalidateStateCache();
      const state = await deriveState(base);
      assert.equal(state.phase, "needs-discussion");
      assert.ok(state.activeMilestone !== null);
      assert.equal(state.activeMilestone?.id, "M001");
    });
    test("both CONTEXT-DRAFT and CONTEXT exist \u2192 NOT needs-discussion", async () => {
      const base = createFixtureBase();
      writeContext(base, "M001", "# M001: Real\n\nReal context.");
      writeContextDraft(base, "M001", "# M001: Draft\n\nDraft context.");
      invalidateStateCache();
      const state = await deriveState(base);
      assert.notEqual(state.phase, "needs-discussion", "CONTEXT should win over CONTEXT-DRAFT");
    });
  });
  describe("Phase 3: discussing (auto-mode only)", () => {
    test("discussing is NOT reachable from deriveState", async () => {
      const base = createFixtureBase();
      writeContextDraft(base, "M001", "# M001: Draft\n\nDraft.");
      invalidateStateCache();
      const state = await deriveState(base);
      assert.notEqual(state.phase, "discussing");
    });
  });
  describe("Phase 4: researching (auto-mode only)", () => {
    test("researching is NOT reachable from deriveState", async () => {
      const base = createFixtureBase();
      writeContext(base, "M001", "# M001: Test\n\nContext.");
      writeRoadmap(base, "M001", standardRoadmap());
      invalidateStateCache();
      const state = await deriveState(base);
      assert.notEqual(state.phase, "researching");
    });
  });
  describe("Phase 5: planning", () => {
    test("roadmap with slice, no PLAN file \u2192 planning", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      invalidateStateCache();
      const state = await deriveState(base);
      assert.equal(state.phase, "planning");
      assert.ok(state.activeSlice !== null);
      assert.equal(state.activeSlice?.id, "S01");
    });
    test("PLAN exists but zero tasks \u2192 planning", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      const dir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "S01-PLAN.md"), [
        "# S01: First Slice",
        "",
        "**Goal:** Test.",
        "**Demo:** Tests pass.",
        "",
        "## Tasks",
        "",
        "No tasks defined yet."
      ].join("\n"));
      invalidateStateCache();
      const state = await deriveState(base);
      assert.equal(state.phase, "planning", "plan with zero tasks should remain in planning");
    });
    test("PLAN with tasks but missing T##-PLAN.md files \u2192 planning", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      const dir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
      mkdirSync(join(dir, "tasks"), { recursive: true });
      writeFileSync(join(dir, "S01-PLAN.md"), standardPlan());
      invalidateStateCache();
      const state = await deriveState(base);
      assert.equal(state.phase, "planning", "missing task plan files should stay in planning");
    });
    test("PLAN with all task plan files \u2192 NOT planning", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", standardPlan());
      invalidateStateCache();
      const state = await deriveState(base);
      assert.notEqual(state.phase, "planning", "complete plan should advance past planning");
      assert.equal(state.phase, "executing");
    });
  });
  describe("Phase 6: evaluating-gates", () => {
    test("DB path: pending quality gates \u2192 evaluating-gates", async () => {
      const base = createFixtureBase();
      const dbPath = join(base, ".gsd", "gsd.db");
      openDatabase(dbPath);
      insertMilestone({ id: "M001", title: "M001: Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "S01: Slice", status: "active", depends: [] });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "T01: Task", status: "pending" });
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", standardPlan());
      insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", scope: "slice", status: "pending" });
      const pending = getPendingSliceGateCount("M001", "S01");
      assert.ok(pending > 0, "should have pending gates");
      invalidateStateCache();
      const state = await deriveStateFromDb(base);
      assert.equal(state.phase, "evaluating-gates");
    });
    test("DB path: no pending gates \u2192 NOT evaluating-gates", async () => {
      const base = createFixtureBase();
      const dbPath = join(base, ".gsd", "gsd.db");
      openDatabase(dbPath);
      insertMilestone({ id: "M001", title: "M001: Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "S01: Slice", status: "active", depends: [] });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "T01: Task", status: "pending" });
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", standardPlan());
      const pending = getPendingSliceGateCount("M001", "S01");
      assert.equal(pending, 0, "should have no pending gates");
      invalidateStateCache();
      const state = await deriveStateFromDb(base);
      assert.notEqual(state.phase, "evaluating-gates");
    });
  });
  describe("Phase 7: executing", () => {
    test("active task, no blockers \u2192 executing", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", standardPlan());
      invalidateStateCache();
      const state = await deriveState(base);
      assert.equal(state.phase, "executing");
      assert.ok(state.activeTask !== null);
      assert.equal(state.activeTask?.id, "T01");
    });
    test("active task with CONTINUE.md \u2192 executing with resume message", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", standardPlan());
      writeContinue(base, "M001", "S01");
      invalidateStateCache();
      const state = await deriveState(base);
      assert.equal(state.phase, "executing");
      assert.ok(
        state.nextAction.toLowerCase().includes("resume") || state.nextAction.toLowerCase().includes("continue"),
        "nextAction should mention resume/continue"
      );
    });
    test("one task remaining among completed \u2192 executing (not summarizing)", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", partialDonePlan());
      invalidateStateCache();
      const state = await deriveState(base);
      assert.equal(state.phase, "executing", "should be executing while tasks remain");
      assert.equal(state.activeTask?.id, "T02", "active task should be T02");
      assert.equal(state.progress?.tasks?.done, 1);
      assert.equal(state.progress?.tasks?.total, 2);
    });
  });
  describe("Phase 8: verifying (auto-mode only)", () => {
    test("verifying is NOT reachable from deriveState", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", allDonePlan());
      invalidateStateCache();
      const state = await deriveState(base);
      assert.notEqual(state.phase, "verifying");
    });
  });
  describe("Phase 9: summarizing", () => {
    test("all tasks done, slice not complete \u2192 summarizing", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", allDonePlan());
      invalidateStateCache();
      const state = await deriveState(base);
      assert.equal(state.phase, "summarizing");
      assert.ok(state.activeSlice !== null);
      assert.equal(state.activeSlice?.id, "S01");
      assert.equal(state.activeTask, null, "no active task when all done");
      assert.equal(state.progress?.tasks?.done, 2);
      assert.equal(state.progress?.tasks?.total, 2);
    });
    test("tasks reconciled via SUMMARY on disk \u2192 summarizing", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      const planContent = [
        "# S01: First Slice",
        "",
        "**Goal:** Test.",
        "**Demo:** Tests pass.",
        "",
        "## Tasks",
        "",
        "### T01: First Task",
        "First task.",
        "",
        "### T02: Second Task",
        "Second task."
      ].join("\n");
      const dir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
      const tasksDir = join(dir, "tasks");
      mkdirSync(tasksDir, { recursive: true });
      writeFileSync(join(dir, "S01-PLAN.md"), planContent);
      writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01 Plan\nStub.\n");
      writeFileSync(join(tasksDir, "T02-PLAN.md"), "# T02 Plan\nStub.\n");
      writeTaskSummary(base, "M001", "S01", "T01");
      writeTaskSummary(base, "M001", "S01", "T02");
      invalidateStateCache();
      const state = await deriveState(base);
      assert.equal(state.phase, "summarizing", "SUMMARY reconciliation should advance to summarizing");
    });
  });
  describe("Phase 10: advancing (auto-mode only)", () => {
    test("advancing is NOT reachable from deriveState", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", standardPlan());
      invalidateStateCache();
      const state = await deriveState(base);
      assert.notEqual(state.phase, "advancing");
    });
  });
  describe("Phase 11: validating-milestone", () => {
    test("all slices done, no VALIDATION file \u2192 validating-milestone", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", doneSliceRoadmap());
      invalidateStateCache();
      const state = await deriveState(base);
      assert.equal(state.phase, "validating-milestone");
      assert.ok(state.activeMilestone !== null);
    });
    test("all slices done, VALIDATION with unparseable verdict \u2192 validating-milestone", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", doneSliceRoadmap());
      const dir = join(base, ".gsd", "milestones", "M001");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "M001-VALIDATION.md"), "Just some text with no frontmatter verdict.");
      invalidateStateCache();
      const state = await deriveState(base);
      assert.equal(state.phase, "validating-milestone", "unparseable verdict should stay in validating");
    });
    test("all slices done, terminal verdict \u2192 NOT validating-milestone", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", doneSliceRoadmap());
      writeMilestoneValidation(base, "M001", "pass");
      invalidateStateCache();
      const state = await deriveState(base);
      assert.notEqual(state.phase, "validating-milestone");
    });
  });
  describe("Phase 12: completing-milestone", () => {
    test("all slices done, validation terminal, no SUMMARY \u2192 completing-milestone", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", doneSliceRoadmap());
      writeMilestoneValidation(base, "M001", "pass");
      invalidateStateCache();
      const state = await deriveState(base);
      assert.equal(state.phase, "completing-milestone");
      assert.ok(state.activeMilestone !== null);
    });
    test("all slices done, validation terminal, SUMMARY exists \u2192 NOT completing-milestone", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", doneSliceRoadmap());
      writeMilestoneValidation(base, "M001", "pass");
      writeMilestoneSummary(base, "M001");
      invalidateStateCache();
      const state = await deriveState(base);
      assert.notEqual(state.phase, "completing-milestone", "should be complete, not completing");
      assert.equal(state.phase, "complete");
    });
    test("failure-path milestone SUMMARY is not terminal completion", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", doneSliceRoadmap());
      writeMilestoneValidation(base, "M001", "pass");
      const dir = join(base, ".gsd", "milestones", "M001");
      writeFileSync(join(dir, "M001-SUMMARY.md"), [
        "---",
        "status: failed",
        "---",
        "",
        "# BLOCKER",
        "",
        "auto-mode recovery failed; milestone is not complete."
      ].join("\n"));
      invalidateStateCache();
      const state = await deriveState(base);
      assert.equal(state.phase, "completing-milestone");
      assert.equal(state.registry[0]?.status, "active");
      assert.equal(await getActiveMilestoneId(base), "M001");
    });
  });
  describe("Phase 13: replanning-slice", () => {
    test("filesystem: task with blocker_discovered, no REPLAN.md \u2192 replanning-slice", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", partialDonePlan());
      writeTaskSummaryWithBlocker(base, "M001", "S01", "T01");
      invalidateStateCache();
      const state = await deriveState(base);
      assert.equal(state.phase, "replanning-slice");
      assert.ok(state.blockers.length > 0, "should have blocker details");
    });
    test("filesystem: REPLAN-TRIGGER.md exists, no REPLAN.md \u2192 replanning-slice", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", standardPlan());
      writeReplanTrigger(base, "M001", "S01");
      invalidateStateCache();
      const state = await deriveState(base);
      assert.equal(state.phase, "replanning-slice");
    });
    test("filesystem: REPLAN-TRIGGER + REPLAN.md exists \u2192 NOT replanning-slice (loop guard)", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", standardPlan());
      writeReplanTrigger(base, "M001", "S01");
      writeReplan(base, "M001", "S01");
      invalidateStateCache();
      const state = await deriveState(base);
      assert.notEqual(state.phase, "replanning-slice", "REPLAN.md loop guard should prevent re-entering replanning");
      assert.equal(state.phase, "executing");
    });
  });
  describe("Phase 14: complete", () => {
    test("single milestone with SUMMARY + VALIDATION \u2192 complete", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", doneSliceRoadmap());
      writeMilestoneValidation(base, "M001", "pass");
      writeMilestoneSummary(base, "M001");
      invalidateStateCache();
      const state = await deriveState(base);
      assert.equal(state.phase, "complete");
      assert.equal(state.registry.length, 1);
      assert.equal(state.registry[0]?.status, "complete");
    });
    test("all milestones complete \u2192 complete", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", doneSliceRoadmap());
      writeMilestoneValidation(base, "M001", "pass");
      writeMilestoneSummary(base, "M001");
      writeRoadmap(base, "M002", [
        "# M002: Second Milestone",
        "",
        "**Vision:** Test.",
        "",
        "## Slices",
        "",
        "- [x] **S01: Done** `risk:low` `depends:[]`",
        "  > After this: done."
      ].join("\n"));
      writeMilestoneValidation(base, "M002", "pass");
      writeMilestoneSummary(base, "M002");
      invalidateStateCache();
      const state = await deriveState(base);
      assert.equal(state.phase, "complete");
      assert.equal(state.registry.length, 2);
      assert.ok(state.registry.every((e) => e.status === "complete"), "all registry entries should be complete");
    });
  });
  describe("Phase 15: paused (auto-mode only)", () => {
    test("paused is NOT reachable from deriveState", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", standardPlan());
      invalidateStateCache();
      const state = await deriveState(base);
      assert.notEqual(state.phase, "paused");
    });
  });
  describe("Phase 16: blocked", () => {
    test("milestone with unmet dependency \u2192 blocked", async () => {
      const base = createFixtureBase();
      writeContext(base, "M001", [
        "---",
        "depends_on:",
        "  - M000",
        "---",
        "",
        "# M001: Test",
        "",
        "Context."
      ].join("\n"));
      writeRoadmap(base, "M001", [
        "# M001: Test Milestone",
        "",
        "**Vision:** Test blocked.",
        "",
        "## Slices",
        "",
        "- [ ] **S01: Slice** `risk:low` `depends:[]`",
        "  > After this: done."
      ].join("\n"));
      invalidateStateCache();
      const state = await deriveState(base);
      assert.equal(state.phase, "blocked");
      assert.ok(state.blockers.length > 0, "should have blockers");
    });
    test("no eligible slice (all deps unmet) \u2192 blocked", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", [
        "# M001: Test Milestone",
        "",
        "**Vision:** Test blocked slices.",
        "",
        "## Slices",
        "",
        "- [ ] **S01: First** `risk:low` `depends:[S00]`",
        "  > After this: done."
      ].join("\n"));
      invalidateStateCache();
      const state = await deriveState(base);
      assert.equal(state.phase, "blocked");
      assert.equal(state.activeSlice, null);
      assert.ok(state.blockers.some((b) => b.includes("No slice eligible")));
    });
  });
  describe("DB-authoritative derivation", () => {
    test("DB: task with SUMMARY on disk but DB says pending \u2192 DB remains authoritative", async () => {
      const base = createFixtureBase();
      const dbPath = join(base, ".gsd", "gsd.db");
      openDatabase(dbPath);
      insertMilestone({ id: "M001", title: "M001: Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "S01: Slice", status: "active", depends: [] });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "T01: Task", status: "pending" });
      insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "T02: Task", status: "pending" });
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", standardPlan());
      writeTaskSummary(base, "M001", "S01", "T01");
      writeTaskSummary(base, "M001", "S01", "T02");
      invalidateStateCache();
      const state = await deriveStateFromDb(base);
      assert.equal(state.phase, "executing", "disk SUMMARY projections must not complete DB tasks");
      assert.equal(state.activeTask?.id, "T01", "first pending DB task remains active");
    });
    test("empty DB with disk milestones \u2192 no runtime disk-to-DB sync", async () => {
      const base = createFixtureBase();
      writeContext(base, "M001", "# M001: Test\n\nContext.");
      openDatabase(":memory:");
      const before = getAllMilestones();
      assert.equal(before.length, 0, "DB should start empty");
      invalidateStateCache();
      const state = await deriveState(base);
      const after = getAllMilestones();
      assert.equal(after.length, 0, "DB should remain empty without explicit migration");
      assert.equal(state.activeMilestone, null, "disk milestone is ignored while DB is authoritative");
    });
    test("ghost milestone (empty dir) \u2192 NOT in registry", async () => {
      const base = createFixtureBase();
      mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
      writeContext(base, "M002", "# M002: Real\n\nContext.");
      invalidateStateCache();
      const state = await deriveState(base);
      const m001 = state.registry.find((e) => e.id === "M001");
      assert.equal(m001, void 0, "ghost milestone should not appear in registry");
      const m002 = state.registry.find((e) => e.id === "M002");
      assert.ok(m002 !== void 0, "real milestone should appear in registry");
    });
    test("ghost milestone detection helper", () => {
      const base = createFixtureBase();
      mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
      clearPathCache();
      assert.equal(isGhostMilestone(base, "M001"), true, "empty dir is ghost");
      writeContext(base, "M002", "# M002\n\nContext.");
      clearPathCache();
      assert.equal(isGhostMilestone(base, "M002"), false, "dir with CONTEXT is not ghost");
    });
  });
  describe("Cross-validation: DB vs filesystem", () => {
    test("executing scenario produces same phase on both paths", async () => {
      const base = createFixtureBase();
      const dbPath = join(base, ".gsd", "gsd.db");
      openDatabase(dbPath);
      insertMilestone({ id: "M001", title: "M001: Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "S01: Slice", status: "active", depends: [] });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "T01: First", status: "pending" });
      insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "T02: Second", status: "pending" });
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", standardPlan());
      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);
      closeDatabase();
      invalidateStateCache();
      const fsState = await deriveState(base);
      assert.equal(dbState.phase, "executing", "DB path should produce executing");
      assert.equal(fsState.phase, "executing", "filesystem path should produce executing");
      assert.equal(dbState.activeTask?.id, fsState.activeTask?.id, "active task should match");
    });
    test("summarizing scenario produces same phase on both paths", async () => {
      const base = createFixtureBase();
      const dbPath = join(base, ".gsd", "gsd.db");
      openDatabase(dbPath);
      insertMilestone({ id: "M001", title: "M001: Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "S01: Slice", status: "active", depends: [] });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "T01: First", status: "complete" });
      insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "T02: Second", status: "complete" });
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", allDonePlan());
      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);
      closeDatabase();
      invalidateStateCache();
      const fsState = await deriveState(base);
      assert.equal(dbState.phase, "summarizing", "DB path should produce summarizing");
      assert.equal(fsState.phase, "summarizing", "filesystem path should produce summarizing");
    });
  });
  describe("Edge cases", () => {
    test("isValidationTerminal: terminal verdicts", () => {
      assert.equal(isValidationTerminal("---\nverdict: pass\n---\n"), true, "pass is terminal");
      assert.equal(isValidationTerminal("---\nverdict: fail\n---\n"), true, "fail is terminal");
      assert.equal(isValidationTerminal("---\nverdict: needs-remediation\n---\n"), true, "needs-remediation is terminal");
      assert.equal(isValidationTerminal("---\nverdict: needs-attention\n---\n"), true, "needs-attention is terminal");
    });
    test("isValidationTerminal: non-terminal content", () => {
      assert.equal(isValidationTerminal("No frontmatter at all"), false, "no frontmatter is not terminal");
      assert.equal(isValidationTerminal(""), false, "empty string is not terminal");
      assert.equal(isValidationTerminal("---\n---\n"), false, "empty frontmatter is not terminal");
    });
    test("isClosedStatus boundary", () => {
      assert.equal(isClosedStatus("complete"), true);
      assert.equal(isClosedStatus("done"), true);
      assert.equal(isClosedStatus("pending"), false);
      assert.equal(isClosedStatus("in-progress"), false);
      assert.equal(isClosedStatus("blocked"), false);
      assert.equal(isClosedStatus("active"), false);
      assert.equal(isClosedStatus(""), false);
    });
    test("multiple milestones: M001 complete, M002 active \u2192 M002 is activeMilestone", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", doneSliceRoadmap());
      writeMilestoneValidation(base, "M001", "pass");
      writeMilestoneSummary(base, "M001");
      writeContext(base, "M002", "# M002: Next Milestone\n\nContext for M002.");
      writeRoadmap(base, "M002", [
        "# M002: Next Milestone",
        "",
        "**Vision:** Next phase.",
        "",
        "## Slices",
        "",
        "- [ ] **S01: New Slice** `risk:low` `depends:[]`",
        "  > After this: done."
      ].join("\n"));
      invalidateStateCache();
      const state = await deriveState(base);
      assert.equal(state.activeMilestone?.id, "M002", "active milestone should be M002");
      assert.notEqual(state.phase, "complete", "should not be complete while M002 is active");
      const m001 = state.registry.find((e) => e.id === "M001");
      assert.ok(m001 !== void 0, "M001 should be in registry");
      assert.equal(m001?.status, "complete", "M001 should be complete");
      const m002 = state.registry.find((e) => e.id === "M002");
      assert.ok(m002 !== void 0, "M002 should be in registry");
      assert.equal(m002?.status, "active", "M002 should be active");
    });
  });
  describe("Recovery: DB has slice but no task rows (partial migration)", () => {
    test("DB tasks empty but PLAN on disk has tasks \u2192 stays planning", async () => {
      const base = createFixtureBase();
      const dbPath = join(base, ".gsd", "gsd.db");
      openDatabase(dbPath);
      insertMilestone({ id: "M001", title: "M001: Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "S01: Slice", status: "active", depends: [] });
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", standardPlan());
      invalidateStateCache();
      const state = await deriveStateFromDb(base);
      assert.equal(
        state.phase,
        "planning",
        "PLAN.md projection must not import DB tasks during runtime derivation"
      );
    });
  });
  describe("Failure: partial SUMMARY reconciliation", () => {
    test("only one task has SUMMARY, other still pending \u2192 executing first DB-pending task", async () => {
      const base = createFixtureBase();
      const dbPath = join(base, ".gsd", "gsd.db");
      openDatabase(dbPath);
      insertMilestone({ id: "M001", title: "M001: Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "S01: Slice", status: "active", depends: [] });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "T01: Task", status: "pending" });
      insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "T02: Task", status: "pending" });
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", standardPlan());
      writeTaskSummary(base, "M001", "S01", "T01");
      invalidateStateCache();
      const state = await deriveStateFromDb(base);
      assert.equal(state.phase, "executing");
      assert.equal(state.activeTask?.id, "T01", "disk SUMMARY must not advance past pending DB task");
    });
  });
  describe("Failure: 0-byte files", () => {
    test("0-byte SUMMARY file triggers reconciliation (existsSync-only check)", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", standardPlan());
      const tasksDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
      mkdirSync(tasksDir, { recursive: true });
      writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "");
      invalidateStateCache();
      clearPathCache();
      const state = await deriveState(base);
      assert.equal(
        state.phase,
        "executing",
        "0-byte SUMMARY marks T01 done via reconciliation, T02 becomes active"
      );
      assert.equal(state.activeTask?.id, "T02");
    });
    test("0-byte VALIDATION file \u2192 stays in validating-milestone", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", doneSliceRoadmap());
      const dir = join(base, ".gsd", "milestones", "M001");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "M001-VALIDATION.md"), "");
      invalidateStateCache();
      const state = await deriveState(base);
      assert.equal(
        state.phase,
        "validating-milestone",
        "0-byte VALIDATION should not be treated as terminal"
      );
    });
    test("0-byte PLAN file \u2192 planning phase", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      const dir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "S01-PLAN.md"), "");
      invalidateStateCache();
      const state = await deriveState(base);
      assert.equal(state.phase, "planning", "0-byte PLAN should stay in planning");
    });
  });
  describe("Failure: DB/filesystem divergence", () => {
    test("DB says slice complete, no milestone VALIDATION \u2192 validating-milestone", async () => {
      const base = createFixtureBase();
      const dbPath = join(base, ".gsd", "gsd.db");
      openDatabase(dbPath);
      insertMilestone({ id: "M001", title: "M001: Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "S01: Slice", status: "complete", depends: [] });
      writeRoadmap(base, "M001", doneSliceRoadmap());
      invalidateStateCache();
      const state = await deriveStateFromDb(base);
      assert.equal(
        state.phase,
        "validating-milestone",
        "DB-complete slice should trigger milestone validation"
      );
    });
    test("DB says task complete but SUMMARY missing \u2192 no crash, advances to next", async () => {
      const base = createFixtureBase();
      const dbPath = join(base, ".gsd", "gsd.db");
      openDatabase(dbPath);
      insertMilestone({ id: "M001", title: "M001: Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "S01: Slice", status: "active", depends: [] });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "T01: Task", status: "complete" });
      insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "T02: Task", status: "pending" });
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", standardPlan());
      invalidateStateCache();
      const state = await deriveStateFromDb(base);
      assert.equal(state.phase, "executing");
      assert.equal(state.activeTask?.id, "T02");
    });
    test("milestone in DB but directory missing from disk \u2192 no crash", async () => {
      const base = createFixtureBase();
      const dbPath = join(base, ".gsd", "gsd.db");
      openDatabase(dbPath);
      insertMilestone({ id: "M001", title: "M001: Test", status: "active" });
      invalidateStateCache();
      const state = await deriveStateFromDb(base);
      assert.ok(state.phase !== void 0, "should produce a valid phase");
    });
  });
  describe("Failure: corrupt frontmatter", () => {
    test("VALIDATION with broken frontmatter \u2192 stays in validating", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", doneSliceRoadmap());
      const dir = join(base, ".gsd", "milestones", "M001");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "M001-VALIDATION.md"), [
        "---",
        "this is not: valid: yaml: {{{}}}",
        "---",
        "",
        "Some content."
      ].join("\n"));
      invalidateStateCache();
      const state = await deriveState(base);
      assert.equal(
        state.phase,
        "validating-milestone",
        "corrupt frontmatter should keep milestone in validating phase"
      );
    });
    test("CONTEXT with broken depends_on \u2192 no crash, deps empty", async () => {
      const base = createFixtureBase();
      writeContext(base, "M001", [
        "---",
        "depends_on: {{{invalid}}}",
        "---",
        "",
        "# M001: Test"
      ].join("\n"));
      writeRoadmap(base, "M001", standardRoadmap());
      invalidateStateCache();
      const state = await deriveState(base);
      assert.ok(state.phase !== void 0, "should not crash on corrupt depends_on");
      assert.notEqual(
        state.phase,
        "blocked",
        "corrupt deps should not falsely block milestone"
      );
    });
  });
  describe("Failure: missing task plan files in DB path", () => {
    test("DB has tasks but no T##-PLAN.md files \u2192 executing phase", async () => {
      const base = createFixtureBase();
      const dbPath = join(base, ".gsd", "gsd.db");
      openDatabase(dbPath);
      insertMilestone({ id: "M001", title: "M001: Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "S01: Slice", status: "active", depends: [] });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "T01: Task", status: "pending" });
      writeRoadmap(base, "M001", standardRoadmap());
      const dir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
      mkdirSync(join(dir, "tasks"), { recursive: true });
      writeFileSync(join(dir, "S01-PLAN.md"), standardPlan());
      invalidateStateCache();
      const state = await deriveStateFromDb(base);
      assert.equal(
        state.phase,
        "executing",
        "DB tasks are authoritative even when task plan projections are missing"
      );
    });
  });
  describe("Failure: stale path cache", () => {
    test("file created after cache populated \u2192 must clear path cache", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      invalidateStateCache();
      clearPathCache();
      const state1 = await deriveState(base);
      assert.equal(state1.phase, "planning");
      writePlan(base, "M001", "S01", standardPlan());
      invalidateStateCache();
      clearPathCache();
      const state2 = await deriveState(base);
      assert.equal(
        state2.phase,
        "executing",
        "after cache clear, should see the new PLAN file"
      );
    });
  });
  describe("Failure: blocker detection edge cases", () => {
    test("filesystem: blocker in SUMMARY but task not marked [x] \u2192 still detected", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", partialDonePlan());
      writeTaskSummaryWithBlocker(base, "M001", "S01", "T01");
      invalidateStateCache();
      clearPathCache();
      const state = await deriveState(base);
      assert.equal(
        state.phase,
        "replanning-slice",
        "blocker_discovered in SUMMARY frontmatter should trigger replanning"
      );
    });
  });
  describe("Failure at pre-planning: CONTEXT file half-written", () => {
    test("CONTEXT exists but is garbage \u2192 still enters pre-planning (no roadmap)", async () => {
      const base = createFixtureBase();
      writeContext(base, "M001", "\0\0\0binary garbage\xFF\xFE");
      invalidateStateCache();
      clearPathCache();
      const state = await deriveState(base);
      assert.equal(state.phase, "pre-planning");
      assert.ok(state.activeMilestone !== null);
    });
  });
  describe("Failure at needs-discussion: CONTEXT-DRAFT is empty", () => {
    test("0-byte CONTEXT-DRAFT \u2192 should still trigger needs-discussion", async () => {
      const base = createFixtureBase();
      const dir = join(base, ".gsd", "milestones", "M001");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "M001-CONTEXT-DRAFT.md"), "");
      invalidateStateCache();
      clearPathCache();
      const state = await deriveState(base);
      assert.equal(
        state.phase,
        "needs-discussion",
        "0-byte draft should still trigger discussion phase"
      );
    });
  });
  describe("Failure at planning: ROADMAP exists but is unparseable", () => {
    test("ROADMAP with no slices section \u2192 pre-planning (zero slices)", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", "# M001: Test\n\nJust some text, no ## Slices section.");
      invalidateStateCache();
      clearPathCache();
      const state = await deriveState(base);
      assert.equal(
        state.phase,
        "pre-planning",
        "unparseable roadmap with no slices should fall to pre-planning"
      );
    });
    test("ROADMAP with broken slice syntax \u2192 treats as zero slices", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", [
        "# M001: Test",
        "",
        "**Vision:** Test.",
        "",
        "## Slices",
        "",
        "This is not a valid slice entry at all.",
        "Neither is this."
      ].join("\n"));
      invalidateStateCache();
      clearPathCache();
      const state = await deriveState(base);
      assert.equal(
        state.phase,
        "pre-planning",
        "broken slice syntax should result in zero slices"
      );
    });
  });
  describe("Failure at planning: PLAN file is corrupt", () => {
    test("PLAN exists but tasks section is garbage \u2192 zero tasks \u2192 planning", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      const dir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "S01-PLAN.md"), [
        "# S01: Slice",
        "",
        "## Tasks",
        "",
        "random garbage with no task markers",
        "more garbage"
      ].join("\n"));
      invalidateStateCache();
      clearPathCache();
      const state = await deriveState(base);
      assert.equal(
        state.phase,
        "planning",
        "PLAN with unparseable tasks should stay in planning"
      );
    });
  });
  describe("Failure at executing: task plan file is empty", () => {
    test("T01-PLAN.md exists but is 0-byte \u2192 still enters executing", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      const dir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
      const tasksDir = join(dir, "tasks");
      mkdirSync(tasksDir, { recursive: true });
      writeFileSync(join(dir, "S01-PLAN.md"), standardPlan());
      writeFileSync(join(tasksDir, "T01-PLAN.md"), "");
      writeFileSync(join(tasksDir, "T02-PLAN.md"), "");
      invalidateStateCache();
      clearPathCache();
      const state = await deriveState(base);
      assert.equal(
        state.phase,
        "executing",
        "0-byte task plan files still pass the existence check"
      );
    });
  });
  describe("Failure at executing: DB has task but wrong status string", () => {
    test("task with unexpected status string \u2192 not treated as closed", async () => {
      const base = createFixtureBase();
      const dbPath = join(base, ".gsd", "gsd.db");
      openDatabase(dbPath);
      insertMilestone({ id: "M001", title: "M001: Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "S01: Slice", status: "active", depends: [] });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "T01: Task", status: "pending" });
      updateTaskStatus("M001", "S01", "T01", "finished");
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", standardPlan());
      invalidateStateCache();
      const state = await deriveStateFromDb(base);
      assert.equal(state.phase, "executing");
      assert.equal(
        state.activeTask?.id,
        "T01",
        "non-standard status 'finished' is NOT treated as closed"
      );
    });
  });
  describe("Failure at summarizing: slice SUMMARY write fails (file missing)", () => {
    test("all tasks [x] but no slice SUMMARY \u2192 stays in summarizing", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", allDonePlan());
      invalidateStateCache();
      clearPathCache();
      const state = await deriveState(base);
      assert.equal(state.phase, "summarizing");
      invalidateStateCache();
      const state2 = await deriveState(base);
      assert.equal(state2.phase, "summarizing", "stays in summarizing until SUMMARY written");
    });
  });
  describe("Failure at validating-milestone: VALIDATION write crashes", () => {
    test("all slices done, validation never written \u2192 stuck in validating", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", doneSliceRoadmap());
      invalidateStateCache();
      clearPathCache();
      const state = await deriveState(base);
      assert.equal(state.phase, "validating-milestone");
      invalidateStateCache();
      const state2 = await deriveState(base);
      assert.equal(
        state2.phase,
        "validating-milestone",
        "stays in validating until VALIDATION file appears"
      );
    });
  });
  describe("Failure at completing-milestone: SUMMARY write fails", () => {
    test("validation terminal but SUMMARY never written \u2192 stuck in completing", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", doneSliceRoadmap());
      writeMilestoneValidation(base, "M001", "pass");
      invalidateStateCache();
      clearPathCache();
      const state = await deriveState(base);
      assert.equal(state.phase, "completing-milestone");
      invalidateStateCache();
      const state2 = await deriveState(base);
      assert.equal(
        state2.phase,
        "completing-milestone",
        "stays in completing until SUMMARY written"
      );
    });
  });
  describe("Failure at replanning: REPLAN.md never written (loop risk)", () => {
    test("blocker detected, replan dispatched but REPLAN.md not created \u2192 re-enters replanning", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", standardRoadmap());
      writePlan(base, "M001", "S01", partialDonePlan());
      writeTaskSummaryWithBlocker(base, "M001", "S01", "T01");
      invalidateStateCache();
      clearPathCache();
      const state1 = await deriveState(base);
      assert.equal(state1.phase, "replanning-slice");
      invalidateStateCache();
      const state2 = await deriveState(base);
      assert.equal(
        state2.phase,
        "replanning-slice",
        "without REPLAN.md, state stays in replanning (dispatch will retry)"
      );
    });
  });
  describe("Failure at complete: SUMMARY exists but VALIDATION missing", () => {
    test("milestone SUMMARY without VALIDATION \u2192 still complete (SUMMARY is terminal artifact)", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", doneSliceRoadmap());
      writeMilestoneSummary(base, "M001");
      invalidateStateCache();
      clearPathCache();
      const state = await deriveState(base);
      assert.equal(
        state.phase,
        "complete",
        "SUMMARY alone should mark milestone complete per #864"
      );
    });
  });
  describe("Failure at blocked: dependency milestone partially complete", () => {
    test("M001 has slices done but no SUMMARY \u2192 M002 (depends on M001) is blocked", async () => {
      const base = createFixtureBase();
      writeRoadmap(base, "M001", doneSliceRoadmap());
      writeContext(base, "M002", [
        "---",
        "depends_on:",
        "  - M001",
        "---",
        "",
        "# M002: Dependent"
      ].join("\n"));
      writeRoadmap(base, "M002", [
        "# M002: Dependent",
        "",
        "**Vision:** Test.",
        "",
        "## Slices",
        "",
        "- [ ] **S01: Slice** `risk:low` `depends:[]`",
        "  > After this: done."
      ].join("\n"));
      invalidateStateCache();
      clearPathCache();
      const state = await deriveState(base);
      assert.equal(
        state.activeMilestone?.id,
        "M001",
        "M001 should be active (not complete without SUMMARY)"
      );
      assert.notEqual(
        state.activeMilestone?.id,
        "M002",
        "M002 should not be active while M001 is incomplete"
      );
    });
  });
  describe("Failure: multiple reconciliation in single derivation", () => {
    test("DB has 3 stale tasks, all with SUMMARY on disk \u2192 first DB-pending task remains active", async () => {
      const base = createFixtureBase();
      const dbPath = join(base, ".gsd", "gsd.db");
      openDatabase(dbPath);
      insertMilestone({ id: "M001", title: "M001: Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "S01: Slice", status: "active", depends: [] });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "T01", status: "pending" });
      insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "T02", status: "in-progress" });
      insertTask({ id: "T03", sliceId: "S01", milestoneId: "M001", title: "T03", status: "pending" });
      const threeTaskRoadmap = [
        "# M001: Test",
        "",
        "**Vision:** Test.",
        "",
        "## Slices",
        "",
        "- [ ] **S01: Slice** `risk:low` `depends:[]`",
        "  > After this: done."
      ].join("\n");
      writeRoadmap(base, "M001", threeTaskRoadmap);
      const threeTaskPlan = [
        "# S01: Slice",
        "",
        "**Goal:** Test.",
        "**Demo:** Tests pass.",
        "",
        "## Tasks",
        "",
        "- [ ] **T01: First** `est:10m`",
        "  First.",
        "",
        "- [ ] **T02: Second** `est:10m`",
        "  Second.",
        "",
        "- [ ] **T03: Third** `est:10m`",
        "  Third."
      ].join("\n");
      writePlan(base, "M001", "S01", threeTaskPlan);
      writeTaskSummary(base, "M001", "S01", "T01");
      writeTaskSummary(base, "M001", "S01", "T02");
      writeTaskSummary(base, "M001", "S01", "T03");
      invalidateStateCache();
      const state = await deriveStateFromDb(base);
      assert.equal(
        state.phase,
        "executing",
        "disk SUMMARY projections must not reconcile DB task state"
      );
      assert.equal(state.activeTask?.id, "T01", "first non-closed DB task remains active");
    });
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9zdGF0ZS1tYWNoaW5lLWZ1bGwtd2Fsa3Rocm91Z2gudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NEIFN0YXRlIE1hY2hpbmUgXHUyMDE0IENvbXByZWhlbnNpdmUgUGhhc2UtYnktUGhhc2UgV2Fsa3Rocm91Z2ggVGVzdHNcbi8vIFZlcmlmaWVzIGFsbCAxNiBwaGFzZXMsIHJlY29uY2lsaWF0aW9uLCBlZGdlIGNhc2VzLCBhbmQgY3Jvc3MtdmFsaWRhdGlvbi5cblxuaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QsIGFmdGVyRWFjaCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jLCBleGlzdHNTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuXG5pbXBvcnQge1xuICBkZXJpdmVTdGF0ZSxcbiAgZGVyaXZlU3RhdGVGcm9tRGIsXG4gIGlzVmFsaWRhdGlvblRlcm1pbmFsLFxuICBpc0dob3N0TWlsZXN0b25lLFxuICBpbnZhbGlkYXRlU3RhdGVDYWNoZSxcbiAgZ2V0QWN0aXZlTWlsZXN0b25lSWQsXG59IGZyb20gXCIuLi9zdGF0ZS50c1wiO1xuaW1wb3J0IHtcbiAgb3BlbkRhdGFiYXNlLFxuICBjbG9zZURhdGFiYXNlLFxuICBpbnNlcnRNaWxlc3RvbmUsXG4gIGluc2VydFNsaWNlLFxuICBpbnNlcnRUYXNrLFxuICB1cGRhdGVUYXNrU3RhdHVzLFxuICBnZXRBbGxNaWxlc3RvbmVzLFxuICBpbnNlcnRHYXRlUm93LFxuICBnZXRQZW5kaW5nU2xpY2VHYXRlQ291bnQsXG59IGZyb20gXCIuLi9nc2QtZGIudHNcIjtcbmltcG9ydCB7IGlzQ2xvc2VkU3RhdHVzIH0gZnJvbSBcIi4uL3N0YXR1cy1ndWFyZHMudHNcIjtcbmltcG9ydCB7IGNsZWFyUGF0aENhY2hlIH0gZnJvbSBcIi4uL3BhdGhzLnRzXCI7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBGaXh0dXJlIEhlbHBlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmNvbnN0IHRlbXBEaXJzOiBzdHJpbmdbXSA9IFtdO1xuXG5mdW5jdGlvbiBjcmVhdGVGaXh0dXJlQmFzZSgpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2Qtd2Fsa3Rocm91Z2gtXCIpKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHRlbXBEaXJzLnB1c2goYmFzZSk7XG4gIHJldHVybiBiYXNlO1xufVxuXG5hZnRlckVhY2goKCkgPT4ge1xuICBmb3IgKGNvbnN0IGRpciBvZiB0ZW1wRGlycy5zcGxpY2UoMCkpIHtcbiAgICB0cnkge1xuICAgICAgcm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH0gY2F0Y2ggeyAvKiBiZXN0IGVmZm9ydCAqLyB9XG4gIH1cbiAgdHJ5IHsgY2xvc2VEYXRhYmFzZSgpOyB9IGNhdGNoIHsgLyogbWF5IG5vdCBiZSBvcGVuICovIH1cbn0pO1xuXG5mdW5jdGlvbiB3cml0ZUNvbnRleHQoYmFzZTogc3RyaW5nLCBtaWQ6IHN0cmluZywgY29udGVudDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGRpciA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBtaWQpO1xuICBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgYCR7bWlkfS1DT05URVhULm1kYCksIGNvbnRlbnQpO1xufVxuXG5mdW5jdGlvbiB3cml0ZUNvbnRleHREcmFmdChiYXNlOiBzdHJpbmcsIG1pZDogc3RyaW5nLCBjb250ZW50OiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgZGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIG1pZCk7XG4gIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBgJHttaWR9LUNPTlRFWFQtRFJBRlQubWRgKSwgY29udGVudCk7XG59XG5cbmZ1bmN0aW9uIHdyaXRlUm9hZG1hcChiYXNlOiBzdHJpbmcsIG1pZDogc3RyaW5nLCBjb250ZW50OiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgZGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIG1pZCk7XG4gIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBgJHttaWR9LVJPQURNQVAubWRgKSwgY29udGVudCk7XG59XG5cbmZ1bmN0aW9uIHdyaXRlUGxhbihiYXNlOiBzdHJpbmcsIG1pZDogc3RyaW5nLCBzaWQ6IHN0cmluZywgY29udGVudDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGRpciA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBtaWQsIFwic2xpY2VzXCIsIHNpZCk7XG4gIGNvbnN0IHRhc2tzRGlyID0gam9pbihkaXIsIFwidGFza3NcIik7XG4gIG1rZGlyU3luYyh0YXNrc0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIGAke3NpZH0tUExBTi5tZGApLCBjb250ZW50KTtcbiAgLy8gQ3JlYXRlIHN0dWIgdGFzayBwbGFuIGZpbGVzIHNvIGRlcml2ZVN0YXRlIGRvZXNuJ3QgZmFsbCBiYWNrIHRvIHBsYW5uaW5nXG4gIGNvbnN0IHRhc2tNYXRjaGVzID0gY29udGVudC5tYXRjaEFsbCgvXFwqXFwqKFRcXGQrKTovZyk7XG4gIGZvciAoY29uc3QgbSBvZiB0YXNrTWF0Y2hlcykge1xuICAgIGNvbnN0IHRpZCA9IG1bMV07XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHRhc2tzRGlyLCBgJHt0aWR9LVBMQU4ubWRgKSwgYCMgJHt0aWR9IFBsYW5cXG5cXG5TdHViLlxcbmApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHdyaXRlVGFza1N1bW1hcnkoYmFzZTogc3RyaW5nLCBtaWQ6IHN0cmluZywgc2lkOiBzdHJpbmcsIHRpZDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHRhc2tzRGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIG1pZCwgXCJzbGljZXNcIiwgc2lkLCBcInRhc2tzXCIpO1xuICBta2RpclN5bmModGFza3NEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4odGFza3NEaXIsIGAke3RpZH0tU1VNTUFSWS5tZGApLCBbXG4gICAgYCMgJHt0aWR9IFN1bW1hcnlgLFxuICAgIFwiXCIsXG4gICAgXCJUYXNrIGNvbXBsZXRlZCBzdWNjZXNzZnVsbHkuXCIsXG4gIF0uam9pbihcIlxcblwiKSk7XG59XG5cbmZ1bmN0aW9uIHdyaXRlVGFza1N1bW1hcnlXaXRoQmxvY2tlcihiYXNlOiBzdHJpbmcsIG1pZDogc3RyaW5nLCBzaWQ6IHN0cmluZywgdGlkOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgdGFza3NEaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgbWlkLCBcInNsaWNlc1wiLCBzaWQsIFwidGFza3NcIik7XG4gIG1rZGlyU3luYyh0YXNrc0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbih0YXNrc0RpciwgYCR7dGlkfS1TVU1NQVJZLm1kYCksIFtcbiAgICBcIi0tLVwiLFxuICAgIFwiYmxvY2tlcl9kaXNjb3ZlcmVkOiB0cnVlXCIsXG4gICAgXCItLS1cIixcbiAgICBcIlwiLFxuICAgIGAjICR7dGlkfSBTdW1tYXJ5YCxcbiAgICBcIlwiLFxuICAgIFwiQmxvY2tlciBmb3VuZCBkdXJpbmcgZXhlY3V0aW9uLlwiLFxuICBdLmpvaW4oXCJcXG5cIikpO1xufVxuXG5mdW5jdGlvbiB3cml0ZVNsaWNlU3VtbWFyeShiYXNlOiBzdHJpbmcsIG1pZDogc3RyaW5nLCBzaWQ6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBkaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgbWlkLCBcInNsaWNlc1wiLCBzaWQpO1xuICBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgYCR7c2lkfS1TVU1NQVJZLm1kYCksIGAjICR7c2lkfSBTdW1tYXJ5XFxuXFxuU2xpY2UgZG9uZS5cXG5gKTtcbn1cblxuZnVuY3Rpb24gd3JpdGVNaWxlc3RvbmVTdW1tYXJ5KGJhc2U6IHN0cmluZywgbWlkOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgZGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIG1pZCk7XG4gIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBgJHttaWR9LVNVTU1BUlkubWRgKSwgYCMgJHttaWR9IFN1bW1hcnlcXG5cXG5NaWxlc3RvbmUgY29tcGxldGUuXFxuYCk7XG59XG5cbmZ1bmN0aW9uIHdyaXRlTWlsZXN0b25lVmFsaWRhdGlvbihiYXNlOiBzdHJpbmcsIG1pZDogc3RyaW5nLCB2ZXJkaWN0OiBzdHJpbmcgPSBcInBhc3NcIik6IHZvaWQge1xuICBjb25zdCBkaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgbWlkKTtcbiAgbWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIGAke21pZH0tVkFMSURBVElPTi5tZGApLCBbXG4gICAgXCItLS1cIixcbiAgICBgdmVyZGljdDogJHt2ZXJkaWN0fWAsXG4gICAgXCJyZW1lZGlhdGlvbl9yb3VuZDogMFwiLFxuICAgIFwiLS0tXCIsXG4gICAgXCJcIixcbiAgICBcIiMgVmFsaWRhdGlvblwiLFxuICAgIFwiVmFsaWRhdGVkLlwiLFxuICBdLmpvaW4oXCJcXG5cIikpO1xufVxuXG5mdW5jdGlvbiB3cml0ZVJlcGxhblRyaWdnZXIoYmFzZTogc3RyaW5nLCBtaWQ6IHN0cmluZywgc2lkOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgZGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIG1pZCwgXCJzbGljZXNcIiwgc2lkKTtcbiAgbWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIGAke3NpZH0tUkVQTEFOLVRSSUdHRVIubWRgKSwgXCJUcmlhZ2UgcmVwbGFuIHRyaWdnZXJlZC5cXG5cIik7XG59XG5cbmZ1bmN0aW9uIHdyaXRlUmVwbGFuKGJhc2U6IHN0cmluZywgbWlkOiBzdHJpbmcsIHNpZDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGRpciA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBtaWQsIFwic2xpY2VzXCIsIHNpZCk7XG4gIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBgJHtzaWR9LVJFUExBTi5tZGApLCBcIiMgUmVwbGFuXFxuXFxuUmVwbGFuIGNvbXBsZXRlZC5cXG5cIik7XG59XG5cbmZ1bmN0aW9uIHdyaXRlQ29udGludWUoYmFzZTogc3RyaW5nLCBtaWQ6IHN0cmluZywgc2lkOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgZGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIG1pZCwgXCJzbGljZXNcIiwgc2lkKTtcbiAgbWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIGAke3NpZH0tQ09OVElOVUUubWRgKSwgW1xuICAgIFwiLS0tXCIsXG4gICAgXCJtaWxlc3RvbmU6IFwiICsgbWlkLFxuICAgIFwic2xpY2U6IFwiICsgc2lkLFxuICAgIFwidGFzazogVDAxXCIsXG4gICAgXCJzdGF0dXM6IGludGVycnVwdGVkXCIsXG4gICAgXCItLS1cIixcbiAgICBcIlwiLFxuICAgIFwiIyBDb250aW51ZVwiLFxuICAgIFwiUmVzdW1lIGZyb20gc3RlcCAyLlwiLFxuICBdLmpvaW4oXCJcXG5cIikpO1xufVxuXG4vKiogU3RhbmRhcmQgcm9hZG1hcCB3aXRoIG9uZSBpbmNvbXBsZXRlIHNsaWNlICovXG5mdW5jdGlvbiBzdGFuZGFyZFJvYWRtYXAoKTogc3RyaW5nIHtcbiAgcmV0dXJuIFtcbiAgICBcIiMgTTAwMTogVGVzdCBNaWxlc3RvbmVcIixcbiAgICBcIlwiLFxuICAgIFwiKipWaXNpb246KiogVGVzdCBzdGF0ZSBtYWNoaW5lLlwiLFxuICAgIFwiXCIsXG4gICAgXCIjIyBTbGljZXNcIixcbiAgICBcIlwiLFxuICAgIFwiLSBbIF0gKipTMDE6IEZpcnN0IFNsaWNlKiogYHJpc2s6bG93YCBgZGVwZW5kczpbXWBcIixcbiAgICBcIiAgPiBBZnRlciB0aGlzOiBzbGljZSBkb25lLlwiLFxuICBdLmpvaW4oXCJcXG5cIik7XG59XG5cbi8qKiBSb2FkbWFwIHdpdGggb25lIGRvbmUgc2xpY2UgKi9cbmZ1bmN0aW9uIGRvbmVTbGljZVJvYWRtYXAoKTogc3RyaW5nIHtcbiAgcmV0dXJuIFtcbiAgICBcIiMgTTAwMTogVGVzdCBNaWxlc3RvbmVcIixcbiAgICBcIlwiLFxuICAgIFwiKipWaXNpb246KiogVGVzdCBzdGF0ZSBtYWNoaW5lLlwiLFxuICAgIFwiXCIsXG4gICAgXCIjIyBTbGljZXNcIixcbiAgICBcIlwiLFxuICAgIFwiLSBbeF0gKipTMDE6IERvbmUgU2xpY2UqKiBgcmlzazpsb3dgIGBkZXBlbmRzOltdYFwiLFxuICAgIFwiICA+IEFmdGVyIHRoaXM6IHNsaWNlIGRvbmUuXCIsXG4gIF0uam9pbihcIlxcblwiKTtcbn1cblxuLyoqIFN0YW5kYXJkIHBsYW4gd2l0aCB0d28gaW5jb21wbGV0ZSB0YXNrcyAqL1xuZnVuY3Rpb24gc3RhbmRhcmRQbGFuKCk6IHN0cmluZyB7XG4gIHJldHVybiBbXG4gICAgXCIjIFMwMTogRmlyc3QgU2xpY2VcIixcbiAgICBcIlwiLFxuICAgIFwiKipHb2FsOioqIFRlc3QuXCIsXG4gICAgXCIqKkRlbW86KiogVGVzdHMgcGFzcy5cIixcbiAgICBcIlwiLFxuICAgIFwiIyMgVGFza3NcIixcbiAgICBcIlwiLFxuICAgIFwiLSBbIF0gKipUMDE6IEZpcnN0IFRhc2sqKiBgZXN0OjEwbWBcIixcbiAgICBcIiAgRmlyc3QgdGFzayBkZXNjcmlwdGlvbi5cIixcbiAgICBcIlwiLFxuICAgIFwiLSBbIF0gKipUMDI6IFNlY29uZCBUYXNrKiogYGVzdDoxMG1gXCIsXG4gICAgXCIgIFNlY29uZCB0YXNrIGRlc2NyaXB0aW9uLlwiLFxuICBdLmpvaW4oXCJcXG5cIik7XG59XG5cbi8qKiBQbGFuIHdpdGggYWxsIHRhc2tzIGRvbmUgKi9cbmZ1bmN0aW9uIGFsbERvbmVQbGFuKCk6IHN0cmluZyB7XG4gIHJldHVybiBbXG4gICAgXCIjIFMwMTogRmlyc3QgU2xpY2VcIixcbiAgICBcIlwiLFxuICAgIFwiKipHb2FsOioqIFRlc3QuXCIsXG4gICAgXCIqKkRlbW86KiogVGVzdHMgcGFzcy5cIixcbiAgICBcIlwiLFxuICAgIFwiIyMgVGFza3NcIixcbiAgICBcIlwiLFxuICAgIFwiLSBbeF0gKipUMDE6IEZpcnN0IFRhc2sqKiBgZXN0OjEwbWBcIixcbiAgICBcIiAgRmlyc3QgdGFzayBkb25lLlwiLFxuICAgIFwiXCIsXG4gICAgXCItIFt4XSAqKlQwMjogU2Vjb25kIFRhc2sqKiBgZXN0OjEwbWBcIixcbiAgICBcIiAgU2Vjb25kIHRhc2sgZG9uZS5cIixcbiAgXS5qb2luKFwiXFxuXCIpO1xufVxuXG4vKiogUGxhbiB3aXRoIG9uZSBkb25lLCBvbmUgaW5jb21wbGV0ZSB0YXNrICovXG5mdW5jdGlvbiBwYXJ0aWFsRG9uZVBsYW4oKTogc3RyaW5nIHtcbiAgcmV0dXJuIFtcbiAgICBcIiMgUzAxOiBGaXJzdCBTbGljZVwiLFxuICAgIFwiXCIsXG4gICAgXCIqKkdvYWw6KiogVGVzdC5cIixcbiAgICBcIioqRGVtbzoqKiBUZXN0cyBwYXNzLlwiLFxuICAgIFwiXCIsXG4gICAgXCIjIyBUYXNrc1wiLFxuICAgIFwiXCIsXG4gICAgXCItIFt4XSAqKlQwMTogRmlyc3QgVGFzayoqIGBlc3Q6MTBtYFwiLFxuICAgIFwiICBGaXJzdCB0YXNrIGRvbmUuXCIsXG4gICAgXCJcIixcbiAgICBcIi0gWyBdICoqVDAyOiBTZWNvbmQgVGFzayoqIGBlc3Q6MTBtYFwiLFxuICAgIFwiICBTZWNvbmQgdGFzayBwZW5kaW5nLlwiLFxuICBdLmpvaW4oXCJcXG5cIik7XG59XG5cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuLy8gUEhBU0UgMTogcHJlLXBsYW5uaW5nXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuZGVzY3JpYmUoXCJzdGF0ZS1tYWNoaW5lLWZ1bGwtd2Fsa3Rocm91Z2hcIiwgKCkgPT4ge1xuXG4gIGRlc2NyaWJlKFwiUGhhc2UgMTogcHJlLXBsYW5uaW5nXCIsICgpID0+IHtcbiAgICB0ZXN0KFwiZW1wdHkgbWlsZXN0b25lcyBkaXIgXHUyMTkyIHByZS1wbGFubmluZ1wiLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuXG4gICAgICBhc3NlcnQuZXF1YWwoc3RhdGUucGhhc2UsIFwicHJlLXBsYW5uaW5nXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLmFjdGl2ZU1pbGVzdG9uZSwgbnVsbCk7XG4gICAgICBhc3NlcnQuZXF1YWwoc3RhdGUuYWN0aXZlU2xpY2UsIG51bGwpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLmFjdGl2ZVRhc2ssIG51bGwpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5yZWdpc3RyeSwgW10pO1xuICAgIH0pO1xuXG4gICAgdGVzdChcIm1pbGVzdG9uZSB3aXRoIENPTlRFWFQgYnV0IG5vIFJPQURNQVAgXHUyMTkyIHByZS1wbGFubmluZ1wiLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICAgIHdyaXRlQ29udGV4dChiYXNlLCBcIk0wMDFcIiwgXCIjIE0wMDE6IFRlc3RcXG5cXG5Tb21lIGNvbnRleHQuXCIpO1xuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5waGFzZSwgXCJwcmUtcGxhbm5pbmdcIik7XG4gICAgICBhc3NlcnQub2soc3RhdGUuYWN0aXZlTWlsZXN0b25lICE9PSBudWxsLCBcImFjdGl2ZU1pbGVzdG9uZSBzaG91bGQgYmUgc2V0XCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQsIFwiTTAwMVwiKTtcbiAgICB9KTtcblxuICAgIHRlc3QoXCJyb2FkbWFwIHdpdGggemVybyBzbGljZXMgXHUyMTkyIHByZS1wbGFubmluZyAobm90IHZhbGlkYXRpbmctbWlsZXN0b25lKVwiLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICAgIHdyaXRlQ29udGV4dChiYXNlLCBcIk0wMDFcIiwgXCIjIE0wMDE6IFRlc3RcXG5cXG5Db250ZXh0LlwiKTtcbiAgICAgIC8vIFJvYWRtYXAgZXhpc3RzIGJ1dCBoYXMgbm8gc2xpY2UgZW50cmllc1xuICAgICAgd3JpdGVSb2FkbWFwKGJhc2UsIFwiTTAwMVwiLCBbXG4gICAgICAgIFwiIyBNMDAxOiBUZXN0IE1pbGVzdG9uZVwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIioqVmlzaW9uOioqIFRlc3QuXCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiIyMgU2xpY2VzXCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiTm8gc2xpY2VzIGRlZmluZWQgeWV0LlwiLFxuICAgICAgXS5qb2luKFwiXFxuXCIpKTtcbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuXG4gICAgICBhc3NlcnQuZXF1YWwoc3RhdGUucGhhc2UsIFwicHJlLXBsYW5uaW5nXCIsIFwiemVybyBzbGljZXMgbXVzdCBOT1QgdHJpZ2dlciB2YWxpZGF0aW5nLW1pbGVzdG9uZSAoIzI2NjcpXCIpO1xuICAgIH0pO1xuICB9KTtcblxuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbiAgLy8gUEhBU0UgMjogbmVlZHMtZGlzY3Vzc2lvblxuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuICBkZXNjcmliZShcIlBoYXNlIDI6IG5lZWRzLWRpc2N1c3Npb25cIiwgKCkgPT4ge1xuICAgIHRlc3QoXCJDT05URVhULURSQUZUIGV4aXN0cywgbm8gQ09OVEVYVCBcdTIxOTIgbmVlZHMtZGlzY3Vzc2lvblwiLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICAgIHdyaXRlQ29udGV4dERyYWZ0KGJhc2UsIFwiTTAwMVwiLCBcIiMgTTAwMTogRHJhZnRcXG5cXG5EcmFmdCBjb250ZXh0LlwiKTtcbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuXG4gICAgICBhc3NlcnQuZXF1YWwoc3RhdGUucGhhc2UsIFwibmVlZHMtZGlzY3Vzc2lvblwiKTtcbiAgICAgIGFzc2VydC5vayhzdGF0ZS5hY3RpdmVNaWxlc3RvbmUgIT09IG51bGwpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQsIFwiTTAwMVwiKTtcbiAgICB9KTtcblxuICAgIHRlc3QoXCJib3RoIENPTlRFWFQtRFJBRlQgYW5kIENPTlRFWFQgZXhpc3QgXHUyMTkyIE5PVCBuZWVkcy1kaXNjdXNzaW9uXCIsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgICAgd3JpdGVDb250ZXh0KGJhc2UsIFwiTTAwMVwiLCBcIiMgTTAwMTogUmVhbFxcblxcblJlYWwgY29udGV4dC5cIik7XG4gICAgICB3cml0ZUNvbnRleHREcmFmdChiYXNlLCBcIk0wMDFcIiwgXCIjIE0wMDE6IERyYWZ0XFxuXFxuRHJhZnQgY29udGV4dC5cIik7XG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcblxuICAgICAgYXNzZXJ0Lm5vdEVxdWFsKHN0YXRlLnBoYXNlLCBcIm5lZWRzLWRpc2N1c3Npb25cIiwgXCJDT05URVhUIHNob3VsZCB3aW4gb3ZlciBDT05URVhULURSQUZUXCIpO1xuICAgIH0pO1xuICB9KTtcblxuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbiAgLy8gUEhBU0UgMzogZGlzY3Vzc2luZyAoYXV0by1tb2RlIG9ubHkpXG4gIC8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG4gIGRlc2NyaWJlKFwiUGhhc2UgMzogZGlzY3Vzc2luZyAoYXV0by1tb2RlIG9ubHkpXCIsICgpID0+IHtcbiAgICB0ZXN0KFwiZGlzY3Vzc2luZyBpcyBOT1QgcmVhY2hhYmxlIGZyb20gZGVyaXZlU3RhdGVcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgLy8gZGlzY3Vzc2luZyBpcyBzZXQgb25seSBieSBhdXRvLW1vZGUsIG5ldmVyIGJ5IHN0YXRlIGRlcml2YXRpb24uXG4gICAgICAvLyBWZXJpZnkgdGhhdCBDT05URVhULURSQUZUIFx1MjE5MiBuZWVkcy1kaXNjdXNzaW9uIChub3QgZGlzY3Vzc2luZykuXG4gICAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICAgIHdyaXRlQ29udGV4dERyYWZ0KGJhc2UsIFwiTTAwMVwiLCBcIiMgTTAwMTogRHJhZnRcXG5cXG5EcmFmdC5cIik7XG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcbiAgICAgIGFzc2VydC5ub3RFcXVhbChzdGF0ZS5waGFzZSwgXCJkaXNjdXNzaW5nXCIpO1xuICAgIH0pO1xuICB9KTtcblxuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbiAgLy8gUEhBU0UgNDogcmVzZWFyY2hpbmcgKGF1dG8tbW9kZSBvbmx5KVxuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuICBkZXNjcmliZShcIlBoYXNlIDQ6IHJlc2VhcmNoaW5nIChhdXRvLW1vZGUgb25seSlcIiwgKCkgPT4ge1xuICAgIHRlc3QoXCJyZXNlYXJjaGluZyBpcyBOT1QgcmVhY2hhYmxlIGZyb20gZGVyaXZlU3RhdGVcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgICB3cml0ZUNvbnRleHQoYmFzZSwgXCJNMDAxXCIsIFwiIyBNMDAxOiBUZXN0XFxuXFxuQ29udGV4dC5cIik7XG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgXCJNMDAxXCIsIHN0YW5kYXJkUm9hZG1hcCgpKTtcbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuICAgICAgYXNzZXJ0Lm5vdEVxdWFsKHN0YXRlLnBoYXNlLCBcInJlc2VhcmNoaW5nXCIpO1xuICAgIH0pO1xuICB9KTtcblxuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbiAgLy8gUEhBU0UgNTogcGxhbm5pbmdcbiAgLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbiAgZGVzY3JpYmUoXCJQaGFzZSA1OiBwbGFubmluZ1wiLCAoKSA9PiB7XG4gICAgdGVzdChcInJvYWRtYXAgd2l0aCBzbGljZSwgbm8gUExBTiBmaWxlIFx1MjE5MiBwbGFubmluZ1wiLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCBcIk0wMDFcIiwgc3RhbmRhcmRSb2FkbWFwKCkpO1xuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5waGFzZSwgXCJwbGFubmluZ1wiKTtcbiAgICAgIGFzc2VydC5vayhzdGF0ZS5hY3RpdmVTbGljZSAhPT0gbnVsbCk7XG4gICAgICBhc3NlcnQuZXF1YWwoc3RhdGUuYWN0aXZlU2xpY2U/LmlkLCBcIlMwMVwiKTtcbiAgICB9KTtcblxuICAgIHRlc3QoXCJQTEFOIGV4aXN0cyBidXQgemVybyB0YXNrcyBcdTIxOTIgcGxhbm5pbmdcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgXCJNMDAxXCIsIHN0YW5kYXJkUm9hZG1hcCgpKTtcbiAgICAgIC8vIFBsYW4gZmlsZSB3aXRoIG5vIHRhc2sgZW50cmllc1xuICAgICAgY29uc3QgZGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiKTtcbiAgICAgIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJTMDEtUExBTi5tZFwiKSwgW1xuICAgICAgICBcIiMgUzAxOiBGaXJzdCBTbGljZVwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIioqR29hbDoqKiBUZXN0LlwiLFxuICAgICAgICBcIioqRGVtbzoqKiBUZXN0cyBwYXNzLlwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIiMjIFRhc2tzXCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiTm8gdGFza3MgZGVmaW5lZCB5ZXQuXCIsXG4gICAgICBdLmpvaW4oXCJcXG5cIikpO1xuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5waGFzZSwgXCJwbGFubmluZ1wiLCBcInBsYW4gd2l0aCB6ZXJvIHRhc2tzIHNob3VsZCByZW1haW4gaW4gcGxhbm5pbmdcIik7XG4gICAgfSk7XG5cbiAgICB0ZXN0KFwiUExBTiB3aXRoIHRhc2tzIGJ1dCBtaXNzaW5nIFQjIy1QTEFOLm1kIGZpbGVzIFx1MjE5MiBwbGFubmluZ1wiLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCBcIk0wMDFcIiwgc3RhbmRhcmRSb2FkbWFwKCkpO1xuICAgICAgLy8gV3JpdGUgcGxhbiBmaWxlIFdJVEggdGFza3MgYnV0IFdJVEhPVVQgc3R1YiBUIyMtUExBTi5tZCBmaWxlc1xuICAgICAgY29uc3QgZGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiKTtcbiAgICAgIG1rZGlyU3luYyhqb2luKGRpciwgXCJ0YXNrc1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcIlMwMS1QTEFOLm1kXCIpLCBzdGFuZGFyZFBsYW4oKSk7XG4gICAgICAvLyBJbnRlbnRpb25hbGx5IGRvIE5PVCBjcmVhdGUgVDAxLVBMQU4ubWQgb3IgVDAyLVBMQU4ubWRcbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuXG4gICAgICBhc3NlcnQuZXF1YWwoc3RhdGUucGhhc2UsIFwicGxhbm5pbmdcIiwgXCJtaXNzaW5nIHRhc2sgcGxhbiBmaWxlcyBzaG91bGQgc3RheSBpbiBwbGFubmluZ1wiKTtcbiAgICB9KTtcblxuICAgIHRlc3QoXCJQTEFOIHdpdGggYWxsIHRhc2sgcGxhbiBmaWxlcyBcdTIxOTIgTk9UIHBsYW5uaW5nXCIsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgICAgd3JpdGVSb2FkbWFwKGJhc2UsIFwiTTAwMVwiLCBzdGFuZGFyZFJvYWRtYXAoKSk7XG4gICAgICB3cml0ZVBsYW4oYmFzZSwgXCJNMDAxXCIsIFwiUzAxXCIsIHN0YW5kYXJkUGxhbigpKTtcbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuXG4gICAgICBhc3NlcnQubm90RXF1YWwoc3RhdGUucGhhc2UsIFwicGxhbm5pbmdcIiwgXCJjb21wbGV0ZSBwbGFuIHNob3VsZCBhZHZhbmNlIHBhc3QgcGxhbm5pbmdcIik7XG4gICAgICAvLyBTaG91bGQgYmUgZXhlY3V0aW5nIHNpbmNlIHRoZXJlIGFyZSBpbmNvbXBsZXRlIHRhc2tzXG4gICAgICBhc3NlcnQuZXF1YWwoc3RhdGUucGhhc2UsIFwiZXhlY3V0aW5nXCIpO1xuICAgIH0pO1xuICB9KTtcblxuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbiAgLy8gUEhBU0UgNjogZXZhbHVhdGluZy1nYXRlcyAoREIgcGF0aCBvbmx5KVxuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuICBkZXNjcmliZShcIlBoYXNlIDY6IGV2YWx1YXRpbmctZ2F0ZXNcIiwgKCkgPT4ge1xuICAgIHRlc3QoXCJEQiBwYXRoOiBwZW5kaW5nIHF1YWxpdHkgZ2F0ZXMgXHUyMTkyIGV2YWx1YXRpbmctZ2F0ZXNcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgICBjb25zdCBkYlBhdGggPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcImdzZC5kYlwiKTtcbiAgICAgIG9wZW5EYXRhYmFzZShkYlBhdGgpO1xuXG4gICAgICAvLyBTZXQgdXAgbWlsZXN0b25lICsgc2xpY2UgKyB0YXNrIGluIERCXG4gICAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIk0wMDE6IFRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuICAgICAgaW5zZXJ0U2xpY2UoeyBpZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJTMDE6IFNsaWNlXCIsIHN0YXR1czogXCJhY3RpdmVcIiwgZGVwZW5kczogW10gfSk7XG4gICAgICBpbnNlcnRUYXNrKHsgaWQ6IFwiVDAxXCIsIHNsaWNlSWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVDAxOiBUYXNrXCIsIHN0YXR1czogXCJwZW5kaW5nXCIgfSk7XG5cbiAgICAgIC8vIFdyaXRlIHBsYW4gb24gZGlzayAobmVlZGVkIGZvciBzdGF0ZSBkZXJpdmF0aW9uKVxuICAgICAgd3JpdGVSb2FkbWFwKGJhc2UsIFwiTTAwMVwiLCBzdGFuZGFyZFJvYWRtYXAoKSk7XG4gICAgICB3cml0ZVBsYW4oYmFzZSwgXCJNMDAxXCIsIFwiUzAxXCIsIHN0YW5kYXJkUGxhbigpKTtcblxuICAgICAgLy8gSW5zZXJ0IGEgcGVuZGluZyBxdWFsaXR5IGdhdGVcbiAgICAgIGluc2VydEdhdGVSb3coeyBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHNsaWNlSWQ6IFwiUzAxXCIsIGdhdGVJZDogXCJRM1wiLCBzY29wZTogXCJzbGljZVwiLCBzdGF0dXM6IFwicGVuZGluZ1wiIH0pO1xuXG4gICAgICBjb25zdCBwZW5kaW5nID0gZ2V0UGVuZGluZ1NsaWNlR2F0ZUNvdW50KFwiTTAwMVwiLCBcIlMwMVwiKTtcbiAgICAgIGFzc2VydC5vayhwZW5kaW5nID4gMCwgXCJzaG91bGQgaGF2ZSBwZW5kaW5nIGdhdGVzXCIpO1xuXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZUZyb21EYihiYXNlKTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLnBoYXNlLCBcImV2YWx1YXRpbmctZ2F0ZXNcIik7XG4gICAgfSk7XG5cbiAgICB0ZXN0KFwiREIgcGF0aDogbm8gcGVuZGluZyBnYXRlcyBcdTIxOTIgTk9UIGV2YWx1YXRpbmctZ2F0ZXNcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgICBjb25zdCBkYlBhdGggPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcImdzZC5kYlwiKTtcbiAgICAgIG9wZW5EYXRhYmFzZShkYlBhdGgpO1xuXG4gICAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIk0wMDE6IFRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuICAgICAgaW5zZXJ0U2xpY2UoeyBpZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJTMDE6IFNsaWNlXCIsIHN0YXR1czogXCJhY3RpdmVcIiwgZGVwZW5kczogW10gfSk7XG4gICAgICBpbnNlcnRUYXNrKHsgaWQ6IFwiVDAxXCIsIHNsaWNlSWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVDAxOiBUYXNrXCIsIHN0YXR1czogXCJwZW5kaW5nXCIgfSk7XG5cbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCBcIk0wMDFcIiwgc3RhbmRhcmRSb2FkbWFwKCkpO1xuICAgICAgd3JpdGVQbGFuKGJhc2UsIFwiTTAwMVwiLCBcIlMwMVwiLCBzdGFuZGFyZFBsYW4oKSk7XG5cbiAgICAgIC8vIE5vIGdhdGUgcm93cyBcdTIxOTIgZ2V0UGVuZGluZ1NsaWNlR2F0ZUNvdW50IHJldHVybnMgMFxuICAgICAgY29uc3QgcGVuZGluZyA9IGdldFBlbmRpbmdTbGljZUdhdGVDb3VudChcIk0wMDFcIiwgXCJTMDFcIik7XG4gICAgICBhc3NlcnQuZXF1YWwocGVuZGluZywgMCwgXCJzaG91bGQgaGF2ZSBubyBwZW5kaW5nIGdhdGVzXCIpO1xuXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZUZyb21EYihiYXNlKTtcblxuICAgICAgYXNzZXJ0Lm5vdEVxdWFsKHN0YXRlLnBoYXNlLCBcImV2YWx1YXRpbmctZ2F0ZXNcIik7XG4gICAgfSk7XG4gIH0pO1xuXG4gIC8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuICAvLyBQSEFTRSA3OiBleGVjdXRpbmdcbiAgLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbiAgZGVzY3JpYmUoXCJQaGFzZSA3OiBleGVjdXRpbmdcIiwgKCkgPT4ge1xuICAgIHRlc3QoXCJhY3RpdmUgdGFzaywgbm8gYmxvY2tlcnMgXHUyMTkyIGV4ZWN1dGluZ1wiLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCBcIk0wMDFcIiwgc3RhbmRhcmRSb2FkbWFwKCkpO1xuICAgICAgd3JpdGVQbGFuKGJhc2UsIFwiTTAwMVwiLCBcIlMwMVwiLCBzdGFuZGFyZFBsYW4oKSk7XG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLnBoYXNlLCBcImV4ZWN1dGluZ1wiKTtcbiAgICAgIGFzc2VydC5vayhzdGF0ZS5hY3RpdmVUYXNrICE9PSBudWxsKTtcbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5hY3RpdmVUYXNrPy5pZCwgXCJUMDFcIik7XG4gICAgfSk7XG5cbiAgICB0ZXN0KFwiYWN0aXZlIHRhc2sgd2l0aCBDT05USU5VRS5tZCBcdTIxOTIgZXhlY3V0aW5nIHdpdGggcmVzdW1lIG1lc3NhZ2VcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgXCJNMDAxXCIsIHN0YW5kYXJkUm9hZG1hcCgpKTtcbiAgICAgIHdyaXRlUGxhbihiYXNlLCBcIk0wMDFcIiwgXCJTMDFcIiwgc3RhbmRhcmRQbGFuKCkpO1xuICAgICAgd3JpdGVDb250aW51ZShiYXNlLCBcIk0wMDFcIiwgXCJTMDFcIik7XG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLnBoYXNlLCBcImV4ZWN1dGluZ1wiKTtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgc3RhdGUubmV4dEFjdGlvbi50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKFwicmVzdW1lXCIpIHx8IHN0YXRlLm5leHRBY3Rpb24udG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhcImNvbnRpbnVlXCIpLFxuICAgICAgICBcIm5leHRBY3Rpb24gc2hvdWxkIG1lbnRpb24gcmVzdW1lL2NvbnRpbnVlXCIsXG4gICAgICApO1xuICAgIH0pO1xuXG4gICAgdGVzdChcIm9uZSB0YXNrIHJlbWFpbmluZyBhbW9uZyBjb21wbGV0ZWQgXHUyMTkyIGV4ZWN1dGluZyAobm90IHN1bW1hcml6aW5nKVwiLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCBcIk0wMDFcIiwgc3RhbmRhcmRSb2FkbWFwKCkpO1xuICAgICAgd3JpdGVQbGFuKGJhc2UsIFwiTTAwMVwiLCBcIlMwMVwiLCBwYXJ0aWFsRG9uZVBsYW4oKSk7XG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLnBoYXNlLCBcImV4ZWN1dGluZ1wiLCBcInNob3VsZCBiZSBleGVjdXRpbmcgd2hpbGUgdGFza3MgcmVtYWluXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLmFjdGl2ZVRhc2s/LmlkLCBcIlQwMlwiLCBcImFjdGl2ZSB0YXNrIHNob3VsZCBiZSBUMDJcIik7XG4gICAgICBhc3NlcnQuZXF1YWwoc3RhdGUucHJvZ3Jlc3M/LnRhc2tzPy5kb25lLCAxKTtcbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5wcm9ncmVzcz8udGFza3M/LnRvdGFsLCAyKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4gIC8vIFBIQVNFIDg6IHZlcmlmeWluZyAoYXV0by1tb2RlIG9ubHkpXG4gIC8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG4gIGRlc2NyaWJlKFwiUGhhc2UgODogdmVyaWZ5aW5nIChhdXRvLW1vZGUgb25seSlcIiwgKCkgPT4ge1xuICAgIHRlc3QoXCJ2ZXJpZnlpbmcgaXMgTk9UIHJlYWNoYWJsZSBmcm9tIGRlcml2ZVN0YXRlXCIsIGFzeW5jICgpID0+IHtcbiAgICAgIC8vIHZlcmlmeWluZyBpcyBzZXQgb25seSBieSBhdXRvLW1vZGUgdmVyaWZpY2F0aW9uIGdhdGVzLlxuICAgICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgXCJNMDAxXCIsIHN0YW5kYXJkUm9hZG1hcCgpKTtcbiAgICAgIHdyaXRlUGxhbihiYXNlLCBcIk0wMDFcIiwgXCJTMDFcIiwgYWxsRG9uZVBsYW4oKSk7XG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcbiAgICAgIGFzc2VydC5ub3RFcXVhbChzdGF0ZS5waGFzZSwgXCJ2ZXJpZnlpbmdcIik7XG4gICAgfSk7XG4gIH0pO1xuXG4gIC8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuICAvLyBQSEFTRSA5OiBzdW1tYXJpemluZ1xuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuICBkZXNjcmliZShcIlBoYXNlIDk6IHN1bW1hcml6aW5nXCIsICgpID0+IHtcbiAgICB0ZXN0KFwiYWxsIHRhc2tzIGRvbmUsIHNsaWNlIG5vdCBjb21wbGV0ZSBcdTIxOTIgc3VtbWFyaXppbmdcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgXCJNMDAxXCIsIHN0YW5kYXJkUm9hZG1hcCgpKTtcbiAgICAgIHdyaXRlUGxhbihiYXNlLCBcIk0wMDFcIiwgXCJTMDFcIiwgYWxsRG9uZVBsYW4oKSk7XG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLnBoYXNlLCBcInN1bW1hcml6aW5nXCIpO1xuICAgICAgYXNzZXJ0Lm9rKHN0YXRlLmFjdGl2ZVNsaWNlICE9PSBudWxsKTtcbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5hY3RpdmVTbGljZT8uaWQsIFwiUzAxXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLmFjdGl2ZVRhc2ssIG51bGwsIFwibm8gYWN0aXZlIHRhc2sgd2hlbiBhbGwgZG9uZVwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5wcm9ncmVzcz8udGFza3M/LmRvbmUsIDIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLnByb2dyZXNzPy50YXNrcz8udG90YWwsIDIpO1xuICAgIH0pO1xuXG4gICAgdGVzdChcInRhc2tzIHJlY29uY2lsZWQgdmlhIFNVTU1BUlkgb24gZGlzayBcdTIxOTIgc3VtbWFyaXppbmdcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgXCJNMDAxXCIsIHN0YW5kYXJkUm9hZG1hcCgpKTtcbiAgICAgIC8vIFBsYW4gc2F5cyB0YXNrcyBpbmNvbXBsZXRlIChoZWFkaW5ncywgbm8gY2hlY2tib3hlcykgLi4uXG4gICAgICBjb25zdCBwbGFuQ29udGVudCA9IFtcbiAgICAgICAgXCIjIFMwMTogRmlyc3QgU2xpY2VcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCIqKkdvYWw6KiogVGVzdC5cIixcbiAgICAgICAgXCIqKkRlbW86KiogVGVzdHMgcGFzcy5cIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCIjIyBUYXNrc1wiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIiMjIyBUMDE6IEZpcnN0IFRhc2tcIixcbiAgICAgICAgXCJGaXJzdCB0YXNrLlwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIiMjIyBUMDI6IFNlY29uZCBUYXNrXCIsXG4gICAgICAgIFwiU2Vjb25kIHRhc2suXCIsXG4gICAgICBdLmpvaW4oXCJcXG5cIik7XG4gICAgICBjb25zdCBkaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIpO1xuICAgICAgY29uc3QgdGFza3NEaXIgPSBqb2luKGRpciwgXCJ0YXNrc1wiKTtcbiAgICAgIG1rZGlyU3luYyh0YXNrc0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcIlMwMS1QTEFOLm1kXCIpLCBwbGFuQ29udGVudCk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4odGFza3NEaXIsIFwiVDAxLVBMQU4ubWRcIiksIFwiIyBUMDEgUGxhblxcblN0dWIuXFxuXCIpO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHRhc2tzRGlyLCBcIlQwMi1QTEFOLm1kXCIpLCBcIiMgVDAyIFBsYW5cXG5TdHViLlxcblwiKTtcblxuICAgICAgLy8gLi4uIGJ1dCBTVU1NQVJZIGZpbGVzIGV4aXN0IG9uIGRpc2sgKHJlY29uY2lsaWF0aW9uIHRyaWdnZXIpXG4gICAgICB3cml0ZVRhc2tTdW1tYXJ5KGJhc2UsIFwiTTAwMVwiLCBcIlMwMVwiLCBcIlQwMVwiKTtcbiAgICAgIHdyaXRlVGFza1N1bW1hcnkoYmFzZSwgXCJNMDAxXCIsIFwiUzAxXCIsIFwiVDAyXCIpO1xuXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcblxuICAgICAgLy8gUmVjb25jaWxpYXRpb24gc2hvdWxkIG1hcmsgYm90aCB0YXNrcyBkb25lIFx1MjE5MiBzdW1tYXJpemluZ1xuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLnBoYXNlLCBcInN1bW1hcml6aW5nXCIsIFwiU1VNTUFSWSByZWNvbmNpbGlhdGlvbiBzaG91bGQgYWR2YW5jZSB0byBzdW1tYXJpemluZ1wiKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4gIC8vIFBIQVNFIDEwOiBhZHZhbmNpbmcgKGF1dG8tbW9kZSBvbmx5KVxuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuICBkZXNjcmliZShcIlBoYXNlIDEwOiBhZHZhbmNpbmcgKGF1dG8tbW9kZSBvbmx5KVwiLCAoKSA9PiB7XG4gICAgdGVzdChcImFkdmFuY2luZyBpcyBOT1QgcmVhY2hhYmxlIGZyb20gZGVyaXZlU3RhdGVcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgLy8gYWR2YW5jaW5nIGlzIGFuIGludGVybmFsIGF1dG8tbW9kZSB0cmFuc2l0aW9uIG1hcmtlclxuICAgICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgXCJNMDAxXCIsIHN0YW5kYXJkUm9hZG1hcCgpKTtcbiAgICAgIHdyaXRlUGxhbihiYXNlLCBcIk0wMDFcIiwgXCJTMDFcIiwgc3RhbmRhcmRQbGFuKCkpO1xuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG4gICAgICBhc3NlcnQubm90RXF1YWwoc3RhdGUucGhhc2UsIFwiYWR2YW5jaW5nXCIpO1xuICAgIH0pO1xuICB9KTtcblxuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbiAgLy8gUEhBU0UgMTE6IHZhbGlkYXRpbmctbWlsZXN0b25lXG4gIC8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG4gIGRlc2NyaWJlKFwiUGhhc2UgMTE6IHZhbGlkYXRpbmctbWlsZXN0b25lXCIsICgpID0+IHtcbiAgICB0ZXN0KFwiYWxsIHNsaWNlcyBkb25lLCBubyBWQUxJREFUSU9OIGZpbGUgXHUyMTkyIHZhbGlkYXRpbmctbWlsZXN0b25lXCIsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgICAgd3JpdGVSb2FkbWFwKGJhc2UsIFwiTTAwMVwiLCBkb25lU2xpY2VSb2FkbWFwKCkpO1xuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5waGFzZSwgXCJ2YWxpZGF0aW5nLW1pbGVzdG9uZVwiKTtcbiAgICAgIGFzc2VydC5vayhzdGF0ZS5hY3RpdmVNaWxlc3RvbmUgIT09IG51bGwpO1xuICAgIH0pO1xuXG4gICAgdGVzdChcImFsbCBzbGljZXMgZG9uZSwgVkFMSURBVElPTiB3aXRoIHVucGFyc2VhYmxlIHZlcmRpY3QgXHUyMTkyIHZhbGlkYXRpbmctbWlsZXN0b25lXCIsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgICAgd3JpdGVSb2FkbWFwKGJhc2UsIFwiTTAwMVwiLCBkb25lU2xpY2VSb2FkbWFwKCkpO1xuICAgICAgLy8gV3JpdGUgYSB2YWxpZGF0aW9uIGZpbGUgd2l0aCBubyBwYXJzZWFibGUgdmVyZGljdFxuICAgICAgY29uc3QgZGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiKTtcbiAgICAgIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJNMDAxLVZBTElEQVRJT04ubWRcIiksIFwiSnVzdCBzb21lIHRleHQgd2l0aCBubyBmcm9udG1hdHRlciB2ZXJkaWN0LlwiKTtcbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuXG4gICAgICBhc3NlcnQuZXF1YWwoc3RhdGUucGhhc2UsIFwidmFsaWRhdGluZy1taWxlc3RvbmVcIiwgXCJ1bnBhcnNlYWJsZSB2ZXJkaWN0IHNob3VsZCBzdGF5IGluIHZhbGlkYXRpbmdcIik7XG4gICAgfSk7XG5cbiAgICB0ZXN0KFwiYWxsIHNsaWNlcyBkb25lLCB0ZXJtaW5hbCB2ZXJkaWN0IFx1MjE5MiBOT1QgdmFsaWRhdGluZy1taWxlc3RvbmVcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgXCJNMDAxXCIsIGRvbmVTbGljZVJvYWRtYXAoKSk7XG4gICAgICB3cml0ZU1pbGVzdG9uZVZhbGlkYXRpb24oYmFzZSwgXCJNMDAxXCIsIFwicGFzc1wiKTtcbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuXG4gICAgICBhc3NlcnQubm90RXF1YWwoc3RhdGUucGhhc2UsIFwidmFsaWRhdGluZy1taWxlc3RvbmVcIik7XG4gICAgfSk7XG4gIH0pO1xuXG4gIC8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuICAvLyBQSEFTRSAxMjogY29tcGxldGluZy1taWxlc3RvbmVcbiAgLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbiAgZGVzY3JpYmUoXCJQaGFzZSAxMjogY29tcGxldGluZy1taWxlc3RvbmVcIiwgKCkgPT4ge1xuICAgIHRlc3QoXCJhbGwgc2xpY2VzIGRvbmUsIHZhbGlkYXRpb24gdGVybWluYWwsIG5vIFNVTU1BUlkgXHUyMTkyIGNvbXBsZXRpbmctbWlsZXN0b25lXCIsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgICAgd3JpdGVSb2FkbWFwKGJhc2UsIFwiTTAwMVwiLCBkb25lU2xpY2VSb2FkbWFwKCkpO1xuICAgICAgd3JpdGVNaWxlc3RvbmVWYWxpZGF0aW9uKGJhc2UsIFwiTTAwMVwiLCBcInBhc3NcIik7XG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLnBoYXNlLCBcImNvbXBsZXRpbmctbWlsZXN0b25lXCIpO1xuICAgICAgYXNzZXJ0Lm9rKHN0YXRlLmFjdGl2ZU1pbGVzdG9uZSAhPT0gbnVsbCk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KFwiYWxsIHNsaWNlcyBkb25lLCB2YWxpZGF0aW9uIHRlcm1pbmFsLCBTVU1NQVJZIGV4aXN0cyBcdTIxOTIgTk9UIGNvbXBsZXRpbmctbWlsZXN0b25lXCIsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgICAgd3JpdGVSb2FkbWFwKGJhc2UsIFwiTTAwMVwiLCBkb25lU2xpY2VSb2FkbWFwKCkpO1xuICAgICAgd3JpdGVNaWxlc3RvbmVWYWxpZGF0aW9uKGJhc2UsIFwiTTAwMVwiLCBcInBhc3NcIik7XG4gICAgICB3cml0ZU1pbGVzdG9uZVN1bW1hcnkoYmFzZSwgXCJNMDAxXCIpO1xuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG5cbiAgICAgIGFzc2VydC5ub3RFcXVhbChzdGF0ZS5waGFzZSwgXCJjb21wbGV0aW5nLW1pbGVzdG9uZVwiLCBcInNob3VsZCBiZSBjb21wbGV0ZSwgbm90IGNvbXBsZXRpbmdcIik7XG4gICAgICBhc3NlcnQuZXF1YWwoc3RhdGUucGhhc2UsIFwiY29tcGxldGVcIik7XG4gICAgfSk7XG5cbiAgICB0ZXN0KFwiZmFpbHVyZS1wYXRoIG1pbGVzdG9uZSBTVU1NQVJZIGlzIG5vdCB0ZXJtaW5hbCBjb21wbGV0aW9uXCIsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgICAgd3JpdGVSb2FkbWFwKGJhc2UsIFwiTTAwMVwiLCBkb25lU2xpY2VSb2FkbWFwKCkpO1xuICAgICAgd3JpdGVNaWxlc3RvbmVWYWxpZGF0aW9uKGJhc2UsIFwiTTAwMVwiLCBcInBhc3NcIik7XG4gICAgICBjb25zdCBkaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIpO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJNMDAxLVNVTU1BUlkubWRcIiksIFtcbiAgICAgICAgXCItLS1cIixcbiAgICAgICAgXCJzdGF0dXM6IGZhaWxlZFwiLFxuICAgICAgICBcIi0tLVwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIiMgQkxPQ0tFUlwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcImF1dG8tbW9kZSByZWNvdmVyeSBmYWlsZWQ7IG1pbGVzdG9uZSBpcyBub3QgY29tcGxldGUuXCIsXG4gICAgICBdLmpvaW4oXCJcXG5cIikpO1xuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcblxuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLnBoYXNlLCBcImNvbXBsZXRpbmctbWlsZXN0b25lXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLnJlZ2lzdHJ5WzBdPy5zdGF0dXMsIFwiYWN0aXZlXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGF3YWl0IGdldEFjdGl2ZU1pbGVzdG9uZUlkKGJhc2UpLCBcIk0wMDFcIik7XG4gICAgfSk7XG4gIH0pO1xuXG4gIC8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuICAvLyBQSEFTRSAxMzogcmVwbGFubmluZy1zbGljZVxuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuICBkZXNjcmliZShcIlBoYXNlIDEzOiByZXBsYW5uaW5nLXNsaWNlXCIsICgpID0+IHtcbiAgICB0ZXN0KFwiZmlsZXN5c3RlbTogdGFzayB3aXRoIGJsb2NrZXJfZGlzY292ZXJlZCwgbm8gUkVQTEFOLm1kIFx1MjE5MiByZXBsYW5uaW5nLXNsaWNlXCIsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgICAgd3JpdGVSb2FkbWFwKGJhc2UsIFwiTTAwMVwiLCBzdGFuZGFyZFJvYWRtYXAoKSk7XG4gICAgICAvLyBUMDEgaXMgZG9uZSB3aXRoIGJsb2NrZXIsIFQwMiBpcyBwZW5kaW5nXG4gICAgICB3cml0ZVBsYW4oYmFzZSwgXCJNMDAxXCIsIFwiUzAxXCIsIHBhcnRpYWxEb25lUGxhbigpKTtcbiAgICAgIHdyaXRlVGFza1N1bW1hcnlXaXRoQmxvY2tlcihiYXNlLCBcIk0wMDFcIiwgXCJTMDFcIiwgXCJUMDFcIik7XG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLnBoYXNlLCBcInJlcGxhbm5pbmctc2xpY2VcIik7XG4gICAgICBhc3NlcnQub2soc3RhdGUuYmxvY2tlcnMubGVuZ3RoID4gMCwgXCJzaG91bGQgaGF2ZSBibG9ja2VyIGRldGFpbHNcIik7XG4gICAgfSk7XG5cbiAgICB0ZXN0KFwiZmlsZXN5c3RlbTogUkVQTEFOLVRSSUdHRVIubWQgZXhpc3RzLCBubyBSRVBMQU4ubWQgXHUyMTkyIHJlcGxhbm5pbmctc2xpY2VcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgXCJNMDAxXCIsIHN0YW5kYXJkUm9hZG1hcCgpKTtcbiAgICAgIHdyaXRlUGxhbihiYXNlLCBcIk0wMDFcIiwgXCJTMDFcIiwgc3RhbmRhcmRQbGFuKCkpO1xuICAgICAgd3JpdGVSZXBsYW5UcmlnZ2VyKGJhc2UsIFwiTTAwMVwiLCBcIlMwMVwiKTtcbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuXG4gICAgICBhc3NlcnQuZXF1YWwoc3RhdGUucGhhc2UsIFwicmVwbGFubmluZy1zbGljZVwiKTtcbiAgICB9KTtcblxuICAgIHRlc3QoXCJmaWxlc3lzdGVtOiBSRVBMQU4tVFJJR0dFUiArIFJFUExBTi5tZCBleGlzdHMgXHUyMTkyIE5PVCByZXBsYW5uaW5nLXNsaWNlIChsb29wIGd1YXJkKVwiLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCBcIk0wMDFcIiwgc3RhbmRhcmRSb2FkbWFwKCkpO1xuICAgICAgd3JpdGVQbGFuKGJhc2UsIFwiTTAwMVwiLCBcIlMwMVwiLCBzdGFuZGFyZFBsYW4oKSk7XG4gICAgICB3cml0ZVJlcGxhblRyaWdnZXIoYmFzZSwgXCJNMDAxXCIsIFwiUzAxXCIpO1xuICAgICAgd3JpdGVSZXBsYW4oYmFzZSwgXCJNMDAxXCIsIFwiUzAxXCIpO1xuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG5cbiAgICAgIGFzc2VydC5ub3RFcXVhbChzdGF0ZS5waGFzZSwgXCJyZXBsYW5uaW5nLXNsaWNlXCIsIFwiUkVQTEFOLm1kIGxvb3AgZ3VhcmQgc2hvdWxkIHByZXZlbnQgcmUtZW50ZXJpbmcgcmVwbGFubmluZ1wiKTtcbiAgICAgIC8vIFNob3VsZCBmYWxsIHRocm91Z2ggdG8gZXhlY3V0aW5nXG4gICAgICBhc3NlcnQuZXF1YWwoc3RhdGUucGhhc2UsIFwiZXhlY3V0aW5nXCIpO1xuICAgIH0pO1xuICB9KTtcblxuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbiAgLy8gUEhBU0UgMTQ6IGNvbXBsZXRlXG4gIC8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG4gIGRlc2NyaWJlKFwiUGhhc2UgMTQ6IGNvbXBsZXRlXCIsICgpID0+IHtcbiAgICB0ZXN0KFwic2luZ2xlIG1pbGVzdG9uZSB3aXRoIFNVTU1BUlkgKyBWQUxJREFUSU9OIFx1MjE5MiBjb21wbGV0ZVwiLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCBcIk0wMDFcIiwgZG9uZVNsaWNlUm9hZG1hcCgpKTtcbiAgICAgIHdyaXRlTWlsZXN0b25lVmFsaWRhdGlvbihiYXNlLCBcIk0wMDFcIiwgXCJwYXNzXCIpO1xuICAgICAgd3JpdGVNaWxlc3RvbmVTdW1tYXJ5KGJhc2UsIFwiTTAwMVwiKTtcbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuXG4gICAgICBhc3NlcnQuZXF1YWwoc3RhdGUucGhhc2UsIFwiY29tcGxldGVcIik7XG4gICAgICBhc3NlcnQuZXF1YWwoc3RhdGUucmVnaXN0cnkubGVuZ3RoLCAxKTtcbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5yZWdpc3RyeVswXT8uc3RhdHVzLCBcImNvbXBsZXRlXCIpO1xuICAgIH0pO1xuXG4gICAgdGVzdChcImFsbCBtaWxlc3RvbmVzIGNvbXBsZXRlIFx1MjE5MiBjb21wbGV0ZVwiLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICAgIC8vIE0wMDE6IGNvbXBsZXRlXG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgXCJNMDAxXCIsIGRvbmVTbGljZVJvYWRtYXAoKSk7XG4gICAgICB3cml0ZU1pbGVzdG9uZVZhbGlkYXRpb24oYmFzZSwgXCJNMDAxXCIsIFwicGFzc1wiKTtcbiAgICAgIHdyaXRlTWlsZXN0b25lU3VtbWFyeShiYXNlLCBcIk0wMDFcIik7XG5cbiAgICAgIC8vIE0wMDI6IGFsc28gY29tcGxldGVcbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCBcIk0wMDJcIiwgW1xuICAgICAgICBcIiMgTTAwMjogU2Vjb25kIE1pbGVzdG9uZVwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIioqVmlzaW9uOioqIFRlc3QuXCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiIyMgU2xpY2VzXCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiLSBbeF0gKipTMDE6IERvbmUqKiBgcmlzazpsb3dgIGBkZXBlbmRzOltdYFwiLFxuICAgICAgICBcIiAgPiBBZnRlciB0aGlzOiBkb25lLlwiLFxuICAgICAgXS5qb2luKFwiXFxuXCIpKTtcbiAgICAgIHdyaXRlTWlsZXN0b25lVmFsaWRhdGlvbihiYXNlLCBcIk0wMDJcIiwgXCJwYXNzXCIpO1xuICAgICAgd3JpdGVNaWxlc3RvbmVTdW1tYXJ5KGJhc2UsIFwiTTAwMlwiKTtcblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5waGFzZSwgXCJjb21wbGV0ZVwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5yZWdpc3RyeS5sZW5ndGgsIDIpO1xuICAgICAgYXNzZXJ0Lm9rKHN0YXRlLnJlZ2lzdHJ5LmV2ZXJ5KGUgPT4gZS5zdGF0dXMgPT09IFwiY29tcGxldGVcIiksIFwiYWxsIHJlZ2lzdHJ5IGVudHJpZXMgc2hvdWxkIGJlIGNvbXBsZXRlXCIpO1xuICAgIH0pO1xuICB9KTtcblxuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbiAgLy8gUEhBU0UgMTU6IHBhdXNlZCAoYXV0by1tb2RlIG9ubHkpXG4gIC8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG4gIGRlc2NyaWJlKFwiUGhhc2UgMTU6IHBhdXNlZCAoYXV0by1tb2RlIG9ubHkpXCIsICgpID0+IHtcbiAgICB0ZXN0KFwicGF1c2VkIGlzIE5PVCByZWFjaGFibGUgZnJvbSBkZXJpdmVTdGF0ZVwiLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCBcIk0wMDFcIiwgc3RhbmRhcmRSb2FkbWFwKCkpO1xuICAgICAgd3JpdGVQbGFuKGJhc2UsIFwiTTAwMVwiLCBcIlMwMVwiLCBzdGFuZGFyZFBsYW4oKSk7XG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcbiAgICAgIGFzc2VydC5ub3RFcXVhbChzdGF0ZS5waGFzZSwgXCJwYXVzZWRcIik7XG4gICAgfSk7XG4gIH0pO1xuXG4gIC8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuICAvLyBQSEFTRSAxNjogYmxvY2tlZFxuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuICBkZXNjcmliZShcIlBoYXNlIDE2OiBibG9ja2VkXCIsICgpID0+IHtcbiAgICB0ZXN0KFwibWlsZXN0b25lIHdpdGggdW5tZXQgZGVwZW5kZW5jeSBcdTIxOTIgYmxvY2tlZFwiLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICAgIC8vIE0wMDEgZGVwZW5kcyBvbiBNMDAwIHdoaWNoIGRvZXNuJ3QgZXhpc3QgXHUyMDE0IHVzZXMgWUFNTCBmcm9udG1hdHRlclxuICAgICAgd3JpdGVDb250ZXh0KGJhc2UsIFwiTTAwMVwiLCBbXG4gICAgICAgIFwiLS0tXCIsXG4gICAgICAgIFwiZGVwZW5kc19vbjpcIixcbiAgICAgICAgXCIgIC0gTTAwMFwiLFxuICAgICAgICBcIi0tLVwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIiMgTTAwMTogVGVzdFwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIkNvbnRleHQuXCIsXG4gICAgICBdLmpvaW4oXCJcXG5cIikpO1xuICAgICAgd3JpdGVSb2FkbWFwKGJhc2UsIFwiTTAwMVwiLCBbXG4gICAgICAgIFwiIyBNMDAxOiBUZXN0IE1pbGVzdG9uZVwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIioqVmlzaW9uOioqIFRlc3QgYmxvY2tlZC5cIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCIjIyBTbGljZXNcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCItIFsgXSAqKlMwMTogU2xpY2UqKiBgcmlzazpsb3dgIGBkZXBlbmRzOltdYFwiLFxuICAgICAgICBcIiAgPiBBZnRlciB0aGlzOiBkb25lLlwiLFxuICAgICAgXS5qb2luKFwiXFxuXCIpKTtcbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuXG4gICAgICBhc3NlcnQuZXF1YWwoc3RhdGUucGhhc2UsIFwiYmxvY2tlZFwiKTtcbiAgICAgIGFzc2VydC5vayhzdGF0ZS5ibG9ja2Vycy5sZW5ndGggPiAwLCBcInNob3VsZCBoYXZlIGJsb2NrZXJzXCIpO1xuICAgIH0pO1xuXG4gICAgdGVzdChcIm5vIGVsaWdpYmxlIHNsaWNlIChhbGwgZGVwcyB1bm1ldCkgXHUyMTkyIGJsb2NrZWRcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgICAvLyBTMDEgZGVwZW5kcyBvbiBTMDAgd2hpY2ggZG9lc24ndCBleGlzdC5cbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCBcIk0wMDFcIiwgW1xuICAgICAgICBcIiMgTTAwMTogVGVzdCBNaWxlc3RvbmVcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCIqKlZpc2lvbjoqKiBUZXN0IGJsb2NrZWQgc2xpY2VzLlwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIiMjIFNsaWNlc1wiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIi0gWyBdICoqUzAxOiBGaXJzdCoqIGByaXNrOmxvd2AgYGRlcGVuZHM6W1MwMF1gXCIsXG4gICAgICAgIFwiICA+IEFmdGVyIHRoaXM6IGRvbmUuXCIsXG4gICAgICBdLmpvaW4oXCJcXG5cIikpO1xuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5waGFzZSwgXCJibG9ja2VkXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLmFjdGl2ZVNsaWNlLCBudWxsKTtcbiAgICAgIGFzc2VydC5vayhzdGF0ZS5ibG9ja2Vycy5zb21lKGIgPT4gYi5pbmNsdWRlcyhcIk5vIHNsaWNlIGVsaWdpYmxlXCIpKSk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIC8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuICAvLyBEQi1BVVRIT1JJVEFUSVZFIERFUklWQVRJT05cbiAgLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbiAgZGVzY3JpYmUoXCJEQi1hdXRob3JpdGF0aXZlIGRlcml2YXRpb25cIiwgKCkgPT4ge1xuICAgIHRlc3QoXCJEQjogdGFzayB3aXRoIFNVTU1BUlkgb24gZGlzayBidXQgREIgc2F5cyBwZW5kaW5nIFx1MjE5MiBEQiByZW1haW5zIGF1dGhvcml0YXRpdmVcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgICBjb25zdCBkYlBhdGggPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcImdzZC5kYlwiKTtcbiAgICAgIG9wZW5EYXRhYmFzZShkYlBhdGgpO1xuXG4gICAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIk0wMDE6IFRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuICAgICAgaW5zZXJ0U2xpY2UoeyBpZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJTMDE6IFNsaWNlXCIsIHN0YXR1czogXCJhY3RpdmVcIiwgZGVwZW5kczogW10gfSk7XG4gICAgICBpbnNlcnRUYXNrKHsgaWQ6IFwiVDAxXCIsIHNsaWNlSWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVDAxOiBUYXNrXCIsIHN0YXR1czogXCJwZW5kaW5nXCIgfSk7XG4gICAgICBpbnNlcnRUYXNrKHsgaWQ6IFwiVDAyXCIsIHNsaWNlSWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVDAyOiBUYXNrXCIsIHN0YXR1czogXCJwZW5kaW5nXCIgfSk7XG5cbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCBcIk0wMDFcIiwgc3RhbmRhcmRSb2FkbWFwKCkpO1xuICAgICAgd3JpdGVQbGFuKGJhc2UsIFwiTTAwMVwiLCBcIlMwMVwiLCBzdGFuZGFyZFBsYW4oKSk7XG5cbiAgICAgIC8vIFdyaXRlIFNVTU1BUlkgZmlsZXMgb24gZGlzayBmb3IgYm90aCB0YXNrcy4gVGhlc2UgYXJlIHByb2plY3Rpb25zIGFuZFxuICAgICAgLy8gbXVzdCBub3QgY29tcGxldGUgcGVuZGluZyBEQiB0YXNrcyBkdXJpbmcgcnVudGltZSBkZXJpdmF0aW9uLlxuICAgICAgd3JpdGVUYXNrU3VtbWFyeShiYXNlLCBcIk0wMDFcIiwgXCJTMDFcIiwgXCJUMDFcIik7XG4gICAgICB3cml0ZVRhc2tTdW1tYXJ5KGJhc2UsIFwiTTAwMVwiLCBcIlMwMVwiLCBcIlQwMlwiKTtcblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGVGcm9tRGIoYmFzZSk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5waGFzZSwgXCJleGVjdXRpbmdcIiwgXCJkaXNrIFNVTU1BUlkgcHJvamVjdGlvbnMgbXVzdCBub3QgY29tcGxldGUgREIgdGFza3NcIik7XG4gICAgICBhc3NlcnQuZXF1YWwoc3RhdGUuYWN0aXZlVGFzaz8uaWQsIFwiVDAxXCIsIFwiZmlyc3QgcGVuZGluZyBEQiB0YXNrIHJlbWFpbnMgYWN0aXZlXCIpO1xuICAgIH0pO1xuXG4gICAgdGVzdChcImVtcHR5IERCIHdpdGggZGlzayBtaWxlc3RvbmVzIFx1MjE5MiBubyBydW50aW1lIGRpc2stdG8tREIgc3luY1wiLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICAgIHdyaXRlQ29udGV4dChiYXNlLCBcIk0wMDFcIiwgXCIjIE0wMDE6IFRlc3RcXG5cXG5Db250ZXh0LlwiKTtcblxuICAgICAgLy8gT3BlbiBEQiBcdTIwMTQgbWlsZXN0b25lcyB0YWJsZSBzdGFydHMgZW1wdHlcbiAgICAgIG9wZW5EYXRhYmFzZShcIjptZW1vcnk6XCIpO1xuICAgICAgY29uc3QgYmVmb3JlID0gZ2V0QWxsTWlsZXN0b25lcygpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGJlZm9yZS5sZW5ndGgsIDAsIFwiREIgc2hvdWxkIHN0YXJ0IGVtcHR5XCIpO1xuXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcblxuICAgICAgLy8gUnVudGltZSBkZXJpdmF0aW9uIG11c3Qgbm90IGltcG9ydCBkaXNrIG1pbGVzdG9uZXMgaW50byB0aGUgREIuXG4gICAgICBjb25zdCBhZnRlciA9IGdldEFsbE1pbGVzdG9uZXMoKTtcbiAgICAgIGFzc2VydC5lcXVhbChhZnRlci5sZW5ndGgsIDAsIFwiREIgc2hvdWxkIHJlbWFpbiBlbXB0eSB3aXRob3V0IGV4cGxpY2l0IG1pZ3JhdGlvblwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5hY3RpdmVNaWxlc3RvbmUsIG51bGwsIFwiZGlzayBtaWxlc3RvbmUgaXMgaWdub3JlZCB3aGlsZSBEQiBpcyBhdXRob3JpdGF0aXZlXCIpO1xuICAgIH0pO1xuXG4gICAgdGVzdChcImdob3N0IG1pbGVzdG9uZSAoZW1wdHkgZGlyKSBcdTIxOTIgTk9UIGluIHJlZ2lzdHJ5XCIsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgICAgLy8gQ3JlYXRlIGVtcHR5IG1pbGVzdG9uZSBkaXIgKGdob3N0IFx1MjAxNCBubyBDT05URVhULCBST0FETUFQLCBTVU1NQVJZKVxuICAgICAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgLy8gQ3JlYXRlIGEgcmVhbCBtaWxlc3RvbmUgdG9vXG4gICAgICB3cml0ZUNvbnRleHQoYmFzZSwgXCJNMDAyXCIsIFwiIyBNMDAyOiBSZWFsXFxuXFxuQ29udGV4dC5cIik7XG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcblxuICAgICAgLy8gTTAwMSAoZ2hvc3QpIHNob3VsZCBub3QgYXBwZWFyIGluIHJlZ2lzdHJ5XG4gICAgICBjb25zdCBtMDAxID0gc3RhdGUucmVnaXN0cnkuZmluZChlID0+IGUuaWQgPT09IFwiTTAwMVwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChtMDAxLCB1bmRlZmluZWQsIFwiZ2hvc3QgbWlsZXN0b25lIHNob3VsZCBub3QgYXBwZWFyIGluIHJlZ2lzdHJ5XCIpO1xuICAgICAgLy8gTTAwMiBzaG91bGQgYmUgdGhlcmVcbiAgICAgIGNvbnN0IG0wMDIgPSBzdGF0ZS5yZWdpc3RyeS5maW5kKGUgPT4gZS5pZCA9PT0gXCJNMDAyXCIpO1xuICAgICAgYXNzZXJ0Lm9rKG0wMDIgIT09IHVuZGVmaW5lZCwgXCJyZWFsIG1pbGVzdG9uZSBzaG91bGQgYXBwZWFyIGluIHJlZ2lzdHJ5XCIpO1xuICAgIH0pO1xuXG4gICAgdGVzdChcImdob3N0IG1pbGVzdG9uZSBkZXRlY3Rpb24gaGVscGVyXCIsICgpID0+IHtcbiAgICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgICAgLy8gR2hvc3Q6IGVtcHR5IGRpclxuICAgICAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgY2xlYXJQYXRoQ2FjaGUoKTtcbiAgICAgIGFzc2VydC5lcXVhbChpc0dob3N0TWlsZXN0b25lKGJhc2UsIFwiTTAwMVwiKSwgdHJ1ZSwgXCJlbXB0eSBkaXIgaXMgZ2hvc3RcIik7XG5cbiAgICAgIC8vIE5vdCBnaG9zdDogaGFzIENPTlRFWFRcbiAgICAgIHdyaXRlQ29udGV4dChiYXNlLCBcIk0wMDJcIiwgXCIjIE0wMDJcXG5cXG5Db250ZXh0LlwiKTtcbiAgICAgIGNsZWFyUGF0aENhY2hlKCk7XG4gICAgICBhc3NlcnQuZXF1YWwoaXNHaG9zdE1pbGVzdG9uZShiYXNlLCBcIk0wMDJcIiksIGZhbHNlLCBcImRpciB3aXRoIENPTlRFWFQgaXMgbm90IGdob3N0XCIpO1xuICAgIH0pO1xuICB9KTtcblxuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbiAgLy8gQ1JPU1MtVkFMSURBVElPTlxuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuICBkZXNjcmliZShcIkNyb3NzLXZhbGlkYXRpb246IERCIHZzIGZpbGVzeXN0ZW1cIiwgKCkgPT4ge1xuICAgIHRlc3QoXCJleGVjdXRpbmcgc2NlbmFyaW8gcHJvZHVjZXMgc2FtZSBwaGFzZSBvbiBib3RoIHBhdGhzXCIsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgICAgY29uc3QgZGJQYXRoID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJnc2QuZGJcIik7XG4gICAgICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcblxuICAgICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJNMDAxOiBUZXN0XCIsIHN0YXR1czogXCJhY3RpdmVcIiB9KTtcbiAgICAgIGluc2VydFNsaWNlKHsgaWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiUzAxOiBTbGljZVwiLCBzdGF0dXM6IFwiYWN0aXZlXCIsIGRlcGVuZHM6IFtdIH0pO1xuICAgICAgaW5zZXJ0VGFzayh7IGlkOiBcIlQwMVwiLCBzbGljZUlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHRpdGxlOiBcIlQwMTogRmlyc3RcIiwgc3RhdHVzOiBcInBlbmRpbmdcIiB9KTtcbiAgICAgIGluc2VydFRhc2soeyBpZDogXCJUMDJcIiwgc2xpY2VJZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUMDI6IFNlY29uZFwiLCBzdGF0dXM6IFwicGVuZGluZ1wiIH0pO1xuXG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgXCJNMDAxXCIsIHN0YW5kYXJkUm9hZG1hcCgpKTtcbiAgICAgIHdyaXRlUGxhbihiYXNlLCBcIk0wMDFcIiwgXCJTMDFcIiwgc3RhbmRhcmRQbGFuKCkpO1xuXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3QgZGJTdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlRnJvbURiKGJhc2UpO1xuXG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG5cbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBmc1N0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChkYlN0YXRlLnBoYXNlLCBcImV4ZWN1dGluZ1wiLCBcIkRCIHBhdGggc2hvdWxkIHByb2R1Y2UgZXhlY3V0aW5nXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGZzU3RhdGUucGhhc2UsIFwiZXhlY3V0aW5nXCIsIFwiZmlsZXN5c3RlbSBwYXRoIHNob3VsZCBwcm9kdWNlIGV4ZWN1dGluZ1wiKTtcbiAgICAgIGFzc2VydC5lcXVhbChkYlN0YXRlLmFjdGl2ZVRhc2s/LmlkLCBmc1N0YXRlLmFjdGl2ZVRhc2s/LmlkLCBcImFjdGl2ZSB0YXNrIHNob3VsZCBtYXRjaFwiKTtcbiAgICB9KTtcblxuICAgIHRlc3QoXCJzdW1tYXJpemluZyBzY2VuYXJpbyBwcm9kdWNlcyBzYW1lIHBoYXNlIG9uIGJvdGggcGF0aHNcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgICBjb25zdCBkYlBhdGggPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcImdzZC5kYlwiKTtcbiAgICAgIG9wZW5EYXRhYmFzZShkYlBhdGgpO1xuXG4gICAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIk0wMDE6IFRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuICAgICAgaW5zZXJ0U2xpY2UoeyBpZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJTMDE6IFNsaWNlXCIsIHN0YXR1czogXCJhY3RpdmVcIiwgZGVwZW5kczogW10gfSk7XG4gICAgICBpbnNlcnRUYXNrKHsgaWQ6IFwiVDAxXCIsIHNsaWNlSWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVDAxOiBGaXJzdFwiLCBzdGF0dXM6IFwiY29tcGxldGVcIiB9KTtcbiAgICAgIGluc2VydFRhc2soeyBpZDogXCJUMDJcIiwgc2xpY2VJZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUMDI6IFNlY29uZFwiLCBzdGF0dXM6IFwiY29tcGxldGVcIiB9KTtcblxuICAgICAgd3JpdGVSb2FkbWFwKGJhc2UsIFwiTTAwMVwiLCBzdGFuZGFyZFJvYWRtYXAoKSk7XG4gICAgICB3cml0ZVBsYW4oYmFzZSwgXCJNMDAxXCIsIFwiUzAxXCIsIGFsbERvbmVQbGFuKCkpO1xuXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3QgZGJTdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlRnJvbURiKGJhc2UpO1xuXG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG5cbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBmc1N0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChkYlN0YXRlLnBoYXNlLCBcInN1bW1hcml6aW5nXCIsIFwiREIgcGF0aCBzaG91bGQgcHJvZHVjZSBzdW1tYXJpemluZ1wiKTtcbiAgICAgIGFzc2VydC5lcXVhbChmc1N0YXRlLnBoYXNlLCBcInN1bW1hcml6aW5nXCIsIFwiZmlsZXN5c3RlbSBwYXRoIHNob3VsZCBwcm9kdWNlIHN1bW1hcml6aW5nXCIpO1xuICAgIH0pO1xuICB9KTtcblxuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbiAgLy8gRURHRSBDQVNFU1xuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuICBkZXNjcmliZShcIkVkZ2UgY2FzZXNcIiwgKCkgPT4ge1xuICAgIHRlc3QoXCJpc1ZhbGlkYXRpb25UZXJtaW5hbDogdGVybWluYWwgdmVyZGljdHNcIiwgKCkgPT4ge1xuICAgICAgYXNzZXJ0LmVxdWFsKGlzVmFsaWRhdGlvblRlcm1pbmFsKFwiLS0tXFxudmVyZGljdDogcGFzc1xcbi0tLVxcblwiKSwgdHJ1ZSwgXCJwYXNzIGlzIHRlcm1pbmFsXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGlzVmFsaWRhdGlvblRlcm1pbmFsKFwiLS0tXFxudmVyZGljdDogZmFpbFxcbi0tLVxcblwiKSwgdHJ1ZSwgXCJmYWlsIGlzIHRlcm1pbmFsXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGlzVmFsaWRhdGlvblRlcm1pbmFsKFwiLS0tXFxudmVyZGljdDogbmVlZHMtcmVtZWRpYXRpb25cXG4tLS1cXG5cIiksIHRydWUsIFwibmVlZHMtcmVtZWRpYXRpb24gaXMgdGVybWluYWxcIik7XG4gICAgICBhc3NlcnQuZXF1YWwoaXNWYWxpZGF0aW9uVGVybWluYWwoXCItLS1cXG52ZXJkaWN0OiBuZWVkcy1hdHRlbnRpb25cXG4tLS1cXG5cIiksIHRydWUsIFwibmVlZHMtYXR0ZW50aW9uIGlzIHRlcm1pbmFsXCIpO1xuICAgIH0pO1xuXG4gICAgdGVzdChcImlzVmFsaWRhdGlvblRlcm1pbmFsOiBub24tdGVybWluYWwgY29udGVudFwiLCAoKSA9PiB7XG4gICAgICBhc3NlcnQuZXF1YWwoaXNWYWxpZGF0aW9uVGVybWluYWwoXCJObyBmcm9udG1hdHRlciBhdCBhbGxcIiksIGZhbHNlLCBcIm5vIGZyb250bWF0dGVyIGlzIG5vdCB0ZXJtaW5hbFwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChpc1ZhbGlkYXRpb25UZXJtaW5hbChcIlwiKSwgZmFsc2UsIFwiZW1wdHkgc3RyaW5nIGlzIG5vdCB0ZXJtaW5hbFwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChpc1ZhbGlkYXRpb25UZXJtaW5hbChcIi0tLVxcbi0tLVxcblwiKSwgZmFsc2UsIFwiZW1wdHkgZnJvbnRtYXR0ZXIgaXMgbm90IHRlcm1pbmFsXCIpO1xuICAgIH0pO1xuXG4gICAgdGVzdChcImlzQ2xvc2VkU3RhdHVzIGJvdW5kYXJ5XCIsICgpID0+IHtcbiAgICAgIGFzc2VydC5lcXVhbChpc0Nsb3NlZFN0YXR1cyhcImNvbXBsZXRlXCIpLCB0cnVlKTtcbiAgICAgIGFzc2VydC5lcXVhbChpc0Nsb3NlZFN0YXR1cyhcImRvbmVcIiksIHRydWUpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGlzQ2xvc2VkU3RhdHVzKFwicGVuZGluZ1wiKSwgZmFsc2UpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGlzQ2xvc2VkU3RhdHVzKFwiaW4tcHJvZ3Jlc3NcIiksIGZhbHNlKTtcbiAgICAgIGFzc2VydC5lcXVhbChpc0Nsb3NlZFN0YXR1cyhcImJsb2NrZWRcIiksIGZhbHNlKTtcbiAgICAgIGFzc2VydC5lcXVhbChpc0Nsb3NlZFN0YXR1cyhcImFjdGl2ZVwiKSwgZmFsc2UpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGlzQ2xvc2VkU3RhdHVzKFwiXCIpLCBmYWxzZSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KFwibXVsdGlwbGUgbWlsZXN0b25lczogTTAwMSBjb21wbGV0ZSwgTTAwMiBhY3RpdmUgXHUyMTkyIE0wMDIgaXMgYWN0aXZlTWlsZXN0b25lXCIsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgICAgLy8gTTAwMTogY29tcGxldGVcbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCBcIk0wMDFcIiwgZG9uZVNsaWNlUm9hZG1hcCgpKTtcbiAgICAgIHdyaXRlTWlsZXN0b25lVmFsaWRhdGlvbihiYXNlLCBcIk0wMDFcIiwgXCJwYXNzXCIpO1xuICAgICAgd3JpdGVNaWxlc3RvbmVTdW1tYXJ5KGJhc2UsIFwiTTAwMVwiKTtcblxuICAgICAgLy8gTTAwMjogYWN0aXZlLCBpbiBwbGFubmluZyBwaGFzZVxuICAgICAgd3JpdGVDb250ZXh0KGJhc2UsIFwiTTAwMlwiLCBcIiMgTTAwMjogTmV4dCBNaWxlc3RvbmVcXG5cXG5Db250ZXh0IGZvciBNMDAyLlwiKTtcbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCBcIk0wMDJcIiwgW1xuICAgICAgICBcIiMgTTAwMjogTmV4dCBNaWxlc3RvbmVcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCIqKlZpc2lvbjoqKiBOZXh0IHBoYXNlLlwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIiMjIFNsaWNlc1wiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIi0gWyBdICoqUzAxOiBOZXcgU2xpY2UqKiBgcmlzazpsb3dgIGBkZXBlbmRzOltdYFwiLFxuICAgICAgICBcIiAgPiBBZnRlciB0aGlzOiBkb25lLlwiLFxuICAgICAgXS5qb2luKFwiXFxuXCIpKTtcblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5hY3RpdmVNaWxlc3RvbmU/LmlkLCBcIk0wMDJcIiwgXCJhY3RpdmUgbWlsZXN0b25lIHNob3VsZCBiZSBNMDAyXCIpO1xuICAgICAgYXNzZXJ0Lm5vdEVxdWFsKHN0YXRlLnBoYXNlLCBcImNvbXBsZXRlXCIsIFwic2hvdWxkIG5vdCBiZSBjb21wbGV0ZSB3aGlsZSBNMDAyIGlzIGFjdGl2ZVwiKTtcbiAgICAgIC8vIE0wMDEgaW4gcmVnaXN0cnkgYXMgY29tcGxldGVcbiAgICAgIGNvbnN0IG0wMDEgPSBzdGF0ZS5yZWdpc3RyeS5maW5kKGUgPT4gZS5pZCA9PT0gXCJNMDAxXCIpO1xuICAgICAgYXNzZXJ0Lm9rKG0wMDEgIT09IHVuZGVmaW5lZCwgXCJNMDAxIHNob3VsZCBiZSBpbiByZWdpc3RyeVwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChtMDAxPy5zdGF0dXMsIFwiY29tcGxldGVcIiwgXCJNMDAxIHNob3VsZCBiZSBjb21wbGV0ZVwiKTtcbiAgICAgIC8vIE0wMDIgaW4gcmVnaXN0cnkgYXMgYWN0aXZlXG4gICAgICBjb25zdCBtMDAyID0gc3RhdGUucmVnaXN0cnkuZmluZChlID0+IGUuaWQgPT09IFwiTTAwMlwiKTtcbiAgICAgIGFzc2VydC5vayhtMDAyICE9PSB1bmRlZmluZWQsIFwiTTAwMiBzaG91bGQgYmUgaW4gcmVnaXN0cnlcIik7XG4gICAgICBhc3NlcnQuZXF1YWwobTAwMj8uc3RhdHVzLCBcImFjdGl2ZVwiLCBcIk0wMDIgc2hvdWxkIGJlIGFjdGl2ZVwiKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4gIC8vIEZBSUxVUkUgTU9ERVM6IFdoYXQgaGFwcGVucyB3aGVuIHRoaW5ncyBnbyB3cm9uZ1xuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuICBkZXNjcmliZShcIlJlY292ZXJ5OiBEQiBoYXMgc2xpY2UgYnV0IG5vIHRhc2sgcm93cyAocGFydGlhbCBtaWdyYXRpb24pXCIsICgpID0+IHtcbiAgICB0ZXN0KFwiREIgdGFza3MgZW1wdHkgYnV0IFBMQU4gb24gZGlzayBoYXMgdGFza3MgXHUyMTkyIHN0YXlzIHBsYW5uaW5nXCIsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgICAgY29uc3QgZGJQYXRoID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJnc2QuZGJcIik7XG4gICAgICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcblxuICAgICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJNMDAxOiBUZXN0XCIsIHN0YXR1czogXCJhY3RpdmVcIiB9KTtcbiAgICAgIGluc2VydFNsaWNlKHsgaWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiUzAxOiBTbGljZVwiLCBzdGF0dXM6IFwiYWN0aXZlXCIsIGRlcGVuZHM6IFtdIH0pO1xuICAgICAgLy8gTk8gaW5zZXJ0VGFzaygpIFx1MjAxNCBzaW11bGF0ZXMgcGFydGlhbCBtaWdyYXRpb24gLyBmYWlsZWQgd3JpdGVcblxuICAgICAgd3JpdGVSb2FkbWFwKGJhc2UsIFwiTTAwMVwiLCBzdGFuZGFyZFJvYWRtYXAoKSk7XG4gICAgICB3cml0ZVBsYW4oYmFzZSwgXCJNMDAxXCIsIFwiUzAxXCIsIHN0YW5kYXJkUGxhbigpKTtcblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGVGcm9tRGIoYmFzZSk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5waGFzZSwgXCJwbGFubmluZ1wiLFxuICAgICAgICBcIlBMQU4ubWQgcHJvamVjdGlvbiBtdXN0IG5vdCBpbXBvcnQgREIgdGFza3MgZHVyaW5nIHJ1bnRpbWUgZGVyaXZhdGlvblwiKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoXCJGYWlsdXJlOiBwYXJ0aWFsIFNVTU1BUlkgcmVjb25jaWxpYXRpb25cIiwgKCkgPT4ge1xuICAgIHRlc3QoXCJvbmx5IG9uZSB0YXNrIGhhcyBTVU1NQVJZLCBvdGhlciBzdGlsbCBwZW5kaW5nIFx1MjE5MiBleGVjdXRpbmcgZmlyc3QgREItcGVuZGluZyB0YXNrXCIsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgICAgY29uc3QgZGJQYXRoID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJnc2QuZGJcIik7XG4gICAgICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcblxuICAgICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJNMDAxOiBUZXN0XCIsIHN0YXR1czogXCJhY3RpdmVcIiB9KTtcbiAgICAgIGluc2VydFNsaWNlKHsgaWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiUzAxOiBTbGljZVwiLCBzdGF0dXM6IFwiYWN0aXZlXCIsIGRlcGVuZHM6IFtdIH0pO1xuICAgICAgaW5zZXJ0VGFzayh7IGlkOiBcIlQwMVwiLCBzbGljZUlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHRpdGxlOiBcIlQwMTogVGFza1wiLCBzdGF0dXM6IFwicGVuZGluZ1wiIH0pO1xuICAgICAgaW5zZXJ0VGFzayh7IGlkOiBcIlQwMlwiLCBzbGljZUlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHRpdGxlOiBcIlQwMjogVGFza1wiLCBzdGF0dXM6IFwicGVuZGluZ1wiIH0pO1xuXG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgXCJNMDAxXCIsIHN0YW5kYXJkUm9hZG1hcCgpKTtcbiAgICAgIHdyaXRlUGxhbihiYXNlLCBcIk0wMDFcIiwgXCJTMDFcIiwgc3RhbmRhcmRQbGFuKCkpO1xuICAgICAgLy8gT25seSBUMDEgaGFzIFNVTU1BUlksIFQwMiBkb2VzIG5vdFxuICAgICAgd3JpdGVUYXNrU3VtbWFyeShiYXNlLCBcIk0wMDFcIiwgXCJTMDFcIiwgXCJUMDFcIik7XG5cbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlRnJvbURiKGJhc2UpO1xuXG4gICAgICBhc3NlcnQuZXF1YWwoc3RhdGUucGhhc2UsIFwiZXhlY3V0aW5nXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLmFjdGl2ZVRhc2s/LmlkLCBcIlQwMVwiLCBcImRpc2sgU1VNTUFSWSBtdXN0IG5vdCBhZHZhbmNlIHBhc3QgcGVuZGluZyBEQiB0YXNrXCIpO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZShcIkZhaWx1cmU6IDAtYnl0ZSBmaWxlc1wiLCAoKSA9PiB7XG4gICAgdGVzdChcIjAtYnl0ZSBTVU1NQVJZIGZpbGUgdHJpZ2dlcnMgcmVjb25jaWxpYXRpb24gKGV4aXN0c1N5bmMtb25seSBjaGVjaylcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgXCJNMDAxXCIsIHN0YW5kYXJkUm9hZG1hcCgpKTtcbiAgICAgIHdyaXRlUGxhbihiYXNlLCBcIk0wMDFcIiwgXCJTMDFcIiwgc3RhbmRhcmRQbGFuKCkpO1xuICAgICAgLy8gV3JpdGUgMC1ieXRlIFNVTU1BUlkgXHUyMDE0IGV4aXN0c1N5bmMgcmV0dXJucyB0cnVlIGZvciBlbXB0eSBmaWxlc1xuICAgICAgY29uc3QgdGFza3NEaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIsIFwidGFza3NcIik7XG4gICAgICBta2RpclN5bmModGFza3NEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHRhc2tzRGlyLCBcIlQwMS1TVU1NQVJZLm1kXCIpLCBcIlwiKTtcblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNsZWFyUGF0aENhY2hlKCk7XG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuXG4gICAgICAvLyBUaGUgcmVjb25jaWxlciBjaGVja3MgZXhpc3RzU3luYyhzdW1tYXJ5UGF0aCkgYXQgbGluZSAxMzI4XG4gICAgICAvLyBcdTIwMTQgaXQgZG9lcyBOT1QgcmVhZCBjb250ZW50LiBTbyAwLWJ5dGUgZmlsZSBjb3VudHMgYXMgXCJkb25lXCIuXG4gICAgICAvLyBUaGlzIGlzIGEga25vd24gZ2FwOiBlbXB0eSBTVU1NQVJZIHRyZWF0ZWQgYXMgY29tcGxldGlvbi5cbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5waGFzZSwgXCJleGVjdXRpbmdcIixcbiAgICAgICAgXCIwLWJ5dGUgU1VNTUFSWSBtYXJrcyBUMDEgZG9uZSB2aWEgcmVjb25jaWxpYXRpb24sIFQwMiBiZWNvbWVzIGFjdGl2ZVwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5hY3RpdmVUYXNrPy5pZCwgXCJUMDJcIik7XG4gICAgfSk7XG5cbiAgICB0ZXN0KFwiMC1ieXRlIFZBTElEQVRJT04gZmlsZSBcdTIxOTIgc3RheXMgaW4gdmFsaWRhdGluZy1taWxlc3RvbmVcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgXCJNMDAxXCIsIGRvbmVTbGljZVJvYWRtYXAoKSk7XG4gICAgICBjb25zdCBkaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIpO1xuICAgICAgbWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcIk0wMDEtVkFMSURBVElPTi5tZFwiKSwgXCJcIik7XG5cbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuXG4gICAgICBhc3NlcnQuZXF1YWwoc3RhdGUucGhhc2UsIFwidmFsaWRhdGluZy1taWxlc3RvbmVcIixcbiAgICAgICAgXCIwLWJ5dGUgVkFMSURBVElPTiBzaG91bGQgbm90IGJlIHRyZWF0ZWQgYXMgdGVybWluYWxcIik7XG4gICAgfSk7XG5cbiAgICB0ZXN0KFwiMC1ieXRlIFBMQU4gZmlsZSBcdTIxOTIgcGxhbm5pbmcgcGhhc2VcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgXCJNMDAxXCIsIHN0YW5kYXJkUm9hZG1hcCgpKTtcbiAgICAgIGNvbnN0IGRpciA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIik7XG4gICAgICBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiUzAxLVBMQU4ubWRcIiksIFwiXCIpO1xuXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLnBoYXNlLCBcInBsYW5uaW5nXCIsIFwiMC1ieXRlIFBMQU4gc2hvdWxkIHN0YXkgaW4gcGxhbm5pbmdcIik7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKFwiRmFpbHVyZTogREIvZmlsZXN5c3RlbSBkaXZlcmdlbmNlXCIsICgpID0+IHtcbiAgICB0ZXN0KFwiREIgc2F5cyBzbGljZSBjb21wbGV0ZSwgbm8gbWlsZXN0b25lIFZBTElEQVRJT04gXHUyMTkyIHZhbGlkYXRpbmctbWlsZXN0b25lXCIsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgICAgY29uc3QgZGJQYXRoID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJnc2QuZGJcIik7XG4gICAgICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcblxuICAgICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJNMDAxOiBUZXN0XCIsIHN0YXR1czogXCJhY3RpdmVcIiB9KTtcbiAgICAgIGluc2VydFNsaWNlKHsgaWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiUzAxOiBTbGljZVwiLCBzdGF0dXM6IFwiY29tcGxldGVcIiwgZGVwZW5kczogW10gfSk7XG5cbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCBcIk0wMDFcIiwgZG9uZVNsaWNlUm9hZG1hcCgpKTtcblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGVGcm9tRGIoYmFzZSk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5waGFzZSwgXCJ2YWxpZGF0aW5nLW1pbGVzdG9uZVwiLFxuICAgICAgICBcIkRCLWNvbXBsZXRlIHNsaWNlIHNob3VsZCB0cmlnZ2VyIG1pbGVzdG9uZSB2YWxpZGF0aW9uXCIpO1xuICAgIH0pO1xuXG4gICAgdGVzdChcIkRCIHNheXMgdGFzayBjb21wbGV0ZSBidXQgU1VNTUFSWSBtaXNzaW5nIFx1MjE5MiBubyBjcmFzaCwgYWR2YW5jZXMgdG8gbmV4dFwiLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICAgIGNvbnN0IGRiUGF0aCA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpO1xuICAgICAgb3BlbkRhdGFiYXNlKGRiUGF0aCk7XG5cbiAgICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiTTAwMTogVGVzdFwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSk7XG4gICAgICBpbnNlcnRTbGljZSh7IGlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHRpdGxlOiBcIlMwMTogU2xpY2VcIiwgc3RhdHVzOiBcImFjdGl2ZVwiLCBkZXBlbmRzOiBbXSB9KTtcbiAgICAgIGluc2VydFRhc2soeyBpZDogXCJUMDFcIiwgc2xpY2VJZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUMDE6IFRhc2tcIiwgc3RhdHVzOiBcImNvbXBsZXRlXCIgfSk7XG4gICAgICBpbnNlcnRUYXNrKHsgaWQ6IFwiVDAyXCIsIHNsaWNlSWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVDAyOiBUYXNrXCIsIHN0YXR1czogXCJwZW5kaW5nXCIgfSk7XG5cbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCBcIk0wMDFcIiwgc3RhbmRhcmRSb2FkbWFwKCkpO1xuICAgICAgd3JpdGVQbGFuKGJhc2UsIFwiTTAwMVwiLCBcIlMwMVwiLCBzdGFuZGFyZFBsYW4oKSk7XG5cbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlRnJvbURiKGJhc2UpO1xuXG4gICAgICBhc3NlcnQuZXF1YWwoc3RhdGUucGhhc2UsIFwiZXhlY3V0aW5nXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLmFjdGl2ZVRhc2s/LmlkLCBcIlQwMlwiKTtcbiAgICB9KTtcblxuICAgIHRlc3QoXCJtaWxlc3RvbmUgaW4gREIgYnV0IGRpcmVjdG9yeSBtaXNzaW5nIGZyb20gZGlzayBcdTIxOTIgbm8gY3Jhc2hcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgICBjb25zdCBkYlBhdGggPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcImdzZC5kYlwiKTtcbiAgICAgIG9wZW5EYXRhYmFzZShkYlBhdGgpO1xuXG4gICAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIk0wMDE6IFRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZUZyb21EYihiYXNlKTtcblxuICAgICAgYXNzZXJ0Lm9rKHN0YXRlLnBoYXNlICE9PSB1bmRlZmluZWQsIFwic2hvdWxkIHByb2R1Y2UgYSB2YWxpZCBwaGFzZVwiKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoXCJGYWlsdXJlOiBjb3JydXB0IGZyb250bWF0dGVyXCIsICgpID0+IHtcbiAgICB0ZXN0KFwiVkFMSURBVElPTiB3aXRoIGJyb2tlbiBmcm9udG1hdHRlciBcdTIxOTIgc3RheXMgaW4gdmFsaWRhdGluZ1wiLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCBcIk0wMDFcIiwgZG9uZVNsaWNlUm9hZG1hcCgpKTtcbiAgICAgIGNvbnN0IGRpciA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIik7XG4gICAgICBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiTTAwMS1WQUxJREFUSU9OLm1kXCIpLCBbXG4gICAgICAgIFwiLS0tXCIsXG4gICAgICAgIFwidGhpcyBpcyBub3Q6IHZhbGlkOiB5YW1sOiB7e3t9fX1cIixcbiAgICAgICAgXCItLS1cIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCJTb21lIGNvbnRlbnQuXCIsXG4gICAgICBdLmpvaW4oXCJcXG5cIikpO1xuXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLnBoYXNlLCBcInZhbGlkYXRpbmctbWlsZXN0b25lXCIsXG4gICAgICAgIFwiY29ycnVwdCBmcm9udG1hdHRlciBzaG91bGQga2VlcCBtaWxlc3RvbmUgaW4gdmFsaWRhdGluZyBwaGFzZVwiKTtcbiAgICB9KTtcblxuICAgIHRlc3QoXCJDT05URVhUIHdpdGggYnJva2VuIGRlcGVuZHNfb24gXHUyMTkyIG5vIGNyYXNoLCBkZXBzIGVtcHR5XCIsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgICAgd3JpdGVDb250ZXh0KGJhc2UsIFwiTTAwMVwiLCBbXG4gICAgICAgIFwiLS0tXCIsXG4gICAgICAgIFwiZGVwZW5kc19vbjoge3t7aW52YWxpZH19fVwiLFxuICAgICAgICBcIi0tLVwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIiMgTTAwMTogVGVzdFwiLFxuICAgICAgXS5qb2luKFwiXFxuXCIpKTtcbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCBcIk0wMDFcIiwgc3RhbmRhcmRSb2FkbWFwKCkpO1xuXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcblxuICAgICAgYXNzZXJ0Lm9rKHN0YXRlLnBoYXNlICE9PSB1bmRlZmluZWQsIFwic2hvdWxkIG5vdCBjcmFzaCBvbiBjb3JydXB0IGRlcGVuZHNfb25cIik7XG4gICAgICAvLyBXaXRoIGNvcnJ1cHQgZGVwcywgcGFyc2VDb250ZXh0RGVwZW5kc09uIHJldHVybnMgW10gXHUyMTkyIG5vIGJsb2NraW5nXG4gICAgICBhc3NlcnQubm90RXF1YWwoc3RhdGUucGhhc2UsIFwiYmxvY2tlZFwiLFxuICAgICAgICBcImNvcnJ1cHQgZGVwcyBzaG91bGQgbm90IGZhbHNlbHkgYmxvY2sgbWlsZXN0b25lXCIpO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZShcIkZhaWx1cmU6IG1pc3NpbmcgdGFzayBwbGFuIGZpbGVzIGluIERCIHBhdGhcIiwgKCkgPT4ge1xuICAgIHRlc3QoXCJEQiBoYXMgdGFza3MgYnV0IG5vIFQjIy1QTEFOLm1kIGZpbGVzIFx1MjE5MiBleGVjdXRpbmcgcGhhc2VcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgICBjb25zdCBkYlBhdGggPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcImdzZC5kYlwiKTtcbiAgICAgIG9wZW5EYXRhYmFzZShkYlBhdGgpO1xuXG4gICAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIk0wMDE6IFRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuICAgICAgaW5zZXJ0U2xpY2UoeyBpZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJTMDE6IFNsaWNlXCIsIHN0YXR1czogXCJhY3RpdmVcIiwgZGVwZW5kczogW10gfSk7XG4gICAgICBpbnNlcnRUYXNrKHsgaWQ6IFwiVDAxXCIsIHNsaWNlSWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVDAxOiBUYXNrXCIsIHN0YXR1czogXCJwZW5kaW5nXCIgfSk7XG5cbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCBcIk0wMDFcIiwgc3RhbmRhcmRSb2FkbWFwKCkpO1xuICAgICAgY29uc3QgZGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiKTtcbiAgICAgIG1rZGlyU3luYyhqb2luKGRpciwgXCJ0YXNrc1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcIlMwMS1QTEFOLm1kXCIpLCBzdGFuZGFyZFBsYW4oKSk7XG4gICAgICAvLyBOTyBUMDEtUExBTi5tZFxuXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZUZyb21EYihiYXNlKTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLnBoYXNlLCBcImV4ZWN1dGluZ1wiLFxuICAgICAgICBcIkRCIHRhc2tzIGFyZSBhdXRob3JpdGF0aXZlIGV2ZW4gd2hlbiB0YXNrIHBsYW4gcHJvamVjdGlvbnMgYXJlIG1pc3NpbmdcIik7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKFwiRmFpbHVyZTogc3RhbGUgcGF0aCBjYWNoZVwiLCAoKSA9PiB7XG4gICAgdGVzdChcImZpbGUgY3JlYXRlZCBhZnRlciBjYWNoZSBwb3B1bGF0ZWQgXHUyMTkyIG11c3QgY2xlYXIgcGF0aCBjYWNoZVwiLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCBcIk0wMDFcIiwgc3RhbmRhcmRSb2FkbWFwKCkpO1xuXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY2xlYXJQYXRoQ2FjaGUoKTtcbiAgICAgIGNvbnN0IHN0YXRlMSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlMS5waGFzZSwgXCJwbGFubmluZ1wiKTtcblxuICAgICAgLy8gV3JpdGUgUExBTiBBRlRFUiBmaXJzdCBkZXJpdmF0aW9uIGNhY2hlZCBwYXRoc1xuICAgICAgd3JpdGVQbGFuKGJhc2UsIFwiTTAwMVwiLCBcIlMwMVwiLCBzdGFuZGFyZFBsYW4oKSk7XG5cbiAgICAgIC8vIFdpdGhvdXQgY2xlYXJQYXRoQ2FjaGUsIHN0YWxlIGNhY2hlIG1heSBtaXNzIHRoZSBuZXcgZmlsZVxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNsZWFyUGF0aENhY2hlKCk7XG4gICAgICBjb25zdCBzdGF0ZTIgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlMi5waGFzZSwgXCJleGVjdXRpbmdcIixcbiAgICAgICAgXCJhZnRlciBjYWNoZSBjbGVhciwgc2hvdWxkIHNlZSB0aGUgbmV3IFBMQU4gZmlsZVwiKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoXCJGYWlsdXJlOiBibG9ja2VyIGRldGVjdGlvbiBlZGdlIGNhc2VzXCIsICgpID0+IHtcbiAgICB0ZXN0KFwiZmlsZXN5c3RlbTogYmxvY2tlciBpbiBTVU1NQVJZIGJ1dCB0YXNrIG5vdCBtYXJrZWQgW3hdIFx1MjE5MiBzdGlsbCBkZXRlY3RlZFwiLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCBcIk0wMDFcIiwgc3RhbmRhcmRSb2FkbWFwKCkpO1xuICAgICAgLy8gVDAxIG1hcmtlZCBkb25lIGluIHBsYW4sIFQwMiBwZW5kaW5nXG4gICAgICB3cml0ZVBsYW4oYmFzZSwgXCJNMDAxXCIsIFwiUzAxXCIsIHBhcnRpYWxEb25lUGxhbigpKTtcbiAgICAgIC8vIFQwMSBTVU1NQVJZIGhhcyBibG9ja2VyX2Rpc2NvdmVyZWQgaW4gZnJvbnRtYXR0ZXJcbiAgICAgIHdyaXRlVGFza1N1bW1hcnlXaXRoQmxvY2tlcihiYXNlLCBcIk0wMDFcIiwgXCJTMDFcIiwgXCJUMDFcIik7XG5cbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjbGVhclBhdGhDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLnBoYXNlLCBcInJlcGxhbm5pbmctc2xpY2VcIixcbiAgICAgICAgXCJibG9ja2VyX2Rpc2NvdmVyZWQgaW4gU1VNTUFSWSBmcm9udG1hdHRlciBzaG91bGQgdHJpZ2dlciByZXBsYW5uaW5nXCIpO1xuICAgIH0pO1xuICB9KTtcblxuICAvLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbiAgLy8gRkFJTFVSRSBBVCBFVkVSWSBQSEFTRTogV2hhdCBicmVha3MgbWlkLXRyYW5zaXRpb25cbiAgLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbiAgZGVzY3JpYmUoXCJGYWlsdXJlIGF0IHByZS1wbGFubmluZzogQ09OVEVYVCBmaWxlIGhhbGYtd3JpdHRlblwiLCAoKSA9PiB7XG4gICAgdGVzdChcIkNPTlRFWFQgZXhpc3RzIGJ1dCBpcyBnYXJiYWdlIFx1MjE5MiBzdGlsbCBlbnRlcnMgcHJlLXBsYW5uaW5nIChubyByb2FkbWFwKVwiLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICAgIHdyaXRlQ29udGV4dChiYXNlLCBcIk0wMDFcIiwgXCJcXHgwMFxceDAwXFx4MDBiaW5hcnkgZ2FyYmFnZVxceGZmXFx4ZmVcIik7XG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY2xlYXJQYXRoQ2FjaGUoKTtcbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG5cbiAgICAgIC8vIEZpbGUgZXhpc3RzIHNvIG1pbGVzdG9uZSBpcyBub3QgZ2hvc3QsIGJ1dCBubyByb2FkbWFwIFx1MjE5MiBwcmUtcGxhbm5pbmdcbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5waGFzZSwgXCJwcmUtcGxhbm5pbmdcIik7XG4gICAgICBhc3NlcnQub2soc3RhdGUuYWN0aXZlTWlsZXN0b25lICE9PSBudWxsKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoXCJGYWlsdXJlIGF0IG5lZWRzLWRpc2N1c3Npb246IENPTlRFWFQtRFJBRlQgaXMgZW1wdHlcIiwgKCkgPT4ge1xuICAgIHRlc3QoXCIwLWJ5dGUgQ09OVEVYVC1EUkFGVCBcdTIxOTIgc2hvdWxkIHN0aWxsIHRyaWdnZXIgbmVlZHMtZGlzY3Vzc2lvblwiLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICAgIGNvbnN0IGRpciA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIik7XG4gICAgICBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiTTAwMS1DT05URVhULURSQUZULm1kXCIpLCBcIlwiKTtcbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjbGVhclBhdGhDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcblxuICAgICAgLy8gRmlsZSBleGlzdHMgKGV2ZW4gZW1wdHkpIFx1MjE5MiBub3QgYSBnaG9zdCwgaGFzIGRyYWZ0IFx1MjE5MiBuZWVkcy1kaXNjdXNzaW9uXG4gICAgICBhc3NlcnQuZXF1YWwoc3RhdGUucGhhc2UsIFwibmVlZHMtZGlzY3Vzc2lvblwiLFxuICAgICAgICBcIjAtYnl0ZSBkcmFmdCBzaG91bGQgc3RpbGwgdHJpZ2dlciBkaXNjdXNzaW9uIHBoYXNlXCIpO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZShcIkZhaWx1cmUgYXQgcGxhbm5pbmc6IFJPQURNQVAgZXhpc3RzIGJ1dCBpcyB1bnBhcnNlYWJsZVwiLCAoKSA9PiB7XG4gICAgdGVzdChcIlJPQURNQVAgd2l0aCBubyBzbGljZXMgc2VjdGlvbiBcdTIxOTIgcHJlLXBsYW5uaW5nICh6ZXJvIHNsaWNlcylcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgXCJNMDAxXCIsIFwiIyBNMDAxOiBUZXN0XFxuXFxuSnVzdCBzb21lIHRleHQsIG5vICMjIFNsaWNlcyBzZWN0aW9uLlwiKTtcbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjbGVhclBhdGhDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcblxuICAgICAgLy8gcGFyc2VSb2FkbWFwIGZpbmRzIG5vIHNsaWNlcyBcdTIxOTIgZW1wdHkgYXJyYXkgXHUyMTkyIHByZS1wbGFubmluZ1xuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLnBoYXNlLCBcInByZS1wbGFubmluZ1wiLFxuICAgICAgICBcInVucGFyc2VhYmxlIHJvYWRtYXAgd2l0aCBubyBzbGljZXMgc2hvdWxkIGZhbGwgdG8gcHJlLXBsYW5uaW5nXCIpO1xuICAgIH0pO1xuXG4gICAgdGVzdChcIlJPQURNQVAgd2l0aCBicm9rZW4gc2xpY2Ugc3ludGF4IFx1MjE5MiB0cmVhdHMgYXMgemVybyBzbGljZXNcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgXCJNMDAxXCIsIFtcbiAgICAgICAgXCIjIE0wMDE6IFRlc3RcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCIqKlZpc2lvbjoqKiBUZXN0LlwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIiMjIFNsaWNlc1wiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIlRoaXMgaXMgbm90IGEgdmFsaWQgc2xpY2UgZW50cnkgYXQgYWxsLlwiLFxuICAgICAgICBcIk5laXRoZXIgaXMgdGhpcy5cIixcbiAgICAgIF0uam9pbihcIlxcblwiKSk7XG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY2xlYXJQYXRoQ2FjaGUoKTtcbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG5cbiAgICAgIC8vIE5vIHBhcnNlYWJsZSBzbGljZSBlbnRyaWVzIFx1MjE5MiB6ZXJvIHNsaWNlcyBcdTIxOTIgcHJlLXBsYW5uaW5nXG4gICAgICBhc3NlcnQuZXF1YWwoc3RhdGUucGhhc2UsIFwicHJlLXBsYW5uaW5nXCIsXG4gICAgICAgIFwiYnJva2VuIHNsaWNlIHN5bnRheCBzaG91bGQgcmVzdWx0IGluIHplcm8gc2xpY2VzXCIpO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZShcIkZhaWx1cmUgYXQgcGxhbm5pbmc6IFBMQU4gZmlsZSBpcyBjb3JydXB0XCIsICgpID0+IHtcbiAgICB0ZXN0KFwiUExBTiBleGlzdHMgYnV0IHRhc2tzIHNlY3Rpb24gaXMgZ2FyYmFnZSBcdTIxOTIgemVybyB0YXNrcyBcdTIxOTIgcGxhbm5pbmdcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgXCJNMDAxXCIsIHN0YW5kYXJkUm9hZG1hcCgpKTtcbiAgICAgIGNvbnN0IGRpciA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIik7XG4gICAgICBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiUzAxLVBMQU4ubWRcIiksIFtcbiAgICAgICAgXCIjIFMwMTogU2xpY2VcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCIjIyBUYXNrc1wiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcInJhbmRvbSBnYXJiYWdlIHdpdGggbm8gdGFzayBtYXJrZXJzXCIsXG4gICAgICAgIFwibW9yZSBnYXJiYWdlXCIsXG4gICAgICBdLmpvaW4oXCJcXG5cIikpO1xuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNsZWFyUGF0aENhY2hlKCk7XG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuXG4gICAgICBhc3NlcnQuZXF1YWwoc3RhdGUucGhhc2UsIFwicGxhbm5pbmdcIixcbiAgICAgICAgXCJQTEFOIHdpdGggdW5wYXJzZWFibGUgdGFza3Mgc2hvdWxkIHN0YXkgaW4gcGxhbm5pbmdcIik7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKFwiRmFpbHVyZSBhdCBleGVjdXRpbmc6IHRhc2sgcGxhbiBmaWxlIGlzIGVtcHR5XCIsICgpID0+IHtcbiAgICB0ZXN0KFwiVDAxLVBMQU4ubWQgZXhpc3RzIGJ1dCBpcyAwLWJ5dGUgXHUyMTkyIHN0aWxsIGVudGVycyBleGVjdXRpbmdcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgXCJNMDAxXCIsIHN0YW5kYXJkUm9hZG1hcCgpKTtcbiAgICAgIGNvbnN0IGRpciA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIik7XG4gICAgICBjb25zdCB0YXNrc0RpciA9IGpvaW4oZGlyLCBcInRhc2tzXCIpO1xuICAgICAgbWtkaXJTeW5jKHRhc2tzRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiUzAxLVBMQU4ubWRcIiksIHN0YW5kYXJkUGxhbigpKTtcbiAgICAgIC8vIENyZWF0ZSB0YXNrIHBsYW4gZmlsZXMgYnV0IG1ha2UgdGhlbSAwLWJ5dGVcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbih0YXNrc0RpciwgXCJUMDEtUExBTi5tZFwiKSwgXCJcIik7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4odGFza3NEaXIsIFwiVDAyLVBMQU4ubWRcIiksIFwiXCIpO1xuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNsZWFyUGF0aENhY2hlKCk7XG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuXG4gICAgICAvLyBUYXNrIHBsYW4gZmlsZSBleGlzdGVuY2UgY2hlY2sgYXQgbGluZSA3MTgtNzMwIHVzZXMgcmVhZGRpclN5bmNcbiAgICAgIC8vIHRvIGNvdW50IC5tZCBmaWxlcy4gMC1ieXRlIGZpbGVzIHN0aWxsIGNvdW50LlxuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLnBoYXNlLCBcImV4ZWN1dGluZ1wiLFxuICAgICAgICBcIjAtYnl0ZSB0YXNrIHBsYW4gZmlsZXMgc3RpbGwgcGFzcyB0aGUgZXhpc3RlbmNlIGNoZWNrXCIpO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZShcIkZhaWx1cmUgYXQgZXhlY3V0aW5nOiBEQiBoYXMgdGFzayBidXQgd3Jvbmcgc3RhdHVzIHN0cmluZ1wiLCAoKSA9PiB7XG4gICAgdGVzdChcInRhc2sgd2l0aCB1bmV4cGVjdGVkIHN0YXR1cyBzdHJpbmcgXHUyMTkyIG5vdCB0cmVhdGVkIGFzIGNsb3NlZFwiLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICAgIGNvbnN0IGRiUGF0aCA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpO1xuICAgICAgb3BlbkRhdGFiYXNlKGRiUGF0aCk7XG5cbiAgICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiTTAwMTogVGVzdFwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSk7XG4gICAgICBpbnNlcnRTbGljZSh7IGlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHRpdGxlOiBcIlMwMTogU2xpY2VcIiwgc3RhdHVzOiBcImFjdGl2ZVwiLCBkZXBlbmRzOiBbXSB9KTtcbiAgICAgIGluc2VydFRhc2soeyBpZDogXCJUMDFcIiwgc2xpY2VJZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUMDE6IFRhc2tcIiwgc3RhdHVzOiBcInBlbmRpbmdcIiB9KTtcblxuICAgICAgLy8gU2V0IGEgZ2FyYmFnZSBzdGF0dXMgdGhhdCBpc24ndCBcImNvbXBsZXRlXCIgb3IgXCJkb25lXCJcbiAgICAgIHVwZGF0ZVRhc2tTdGF0dXMoXCJNMDAxXCIsIFwiUzAxXCIsIFwiVDAxXCIsIFwiZmluaXNoZWRcIik7XG5cbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCBcIk0wMDFcIiwgc3RhbmRhcmRSb2FkbWFwKCkpO1xuICAgICAgd3JpdGVQbGFuKGJhc2UsIFwiTTAwMVwiLCBcIlMwMVwiLCBzdGFuZGFyZFBsYW4oKSk7XG5cbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlRnJvbURiKGJhc2UpO1xuXG4gICAgICAvLyBpc0Nsb3NlZFN0YXR1cyhcImZpbmlzaGVkXCIpIFx1MjE5MiBmYWxzZSBcdTIxOTIgdGFzayB0cmVhdGVkIGFzIGFjdGl2ZVxuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLnBoYXNlLCBcImV4ZWN1dGluZ1wiKTtcbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5hY3RpdmVUYXNrPy5pZCwgXCJUMDFcIixcbiAgICAgICAgXCJub24tc3RhbmRhcmQgc3RhdHVzICdmaW5pc2hlZCcgaXMgTk9UIHRyZWF0ZWQgYXMgY2xvc2VkXCIpO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZShcIkZhaWx1cmUgYXQgc3VtbWFyaXppbmc6IHNsaWNlIFNVTU1BUlkgd3JpdGUgZmFpbHMgKGZpbGUgbWlzc2luZylcIiwgKCkgPT4ge1xuICAgIHRlc3QoXCJhbGwgdGFza3MgW3hdIGJ1dCBubyBzbGljZSBTVU1NQVJZIFx1MjE5MiBzdGF5cyBpbiBzdW1tYXJpemluZ1wiLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCBcIk0wMDFcIiwgc3RhbmRhcmRSb2FkbWFwKCkpO1xuICAgICAgd3JpdGVQbGFuKGJhc2UsIFwiTTAwMVwiLCBcIlMwMVwiLCBhbGxEb25lUGxhbigpKTtcbiAgICAgIC8vIEFsbCB0YXNrcyBkb25lIGJ1dCBubyBTMDEtU1VNTUFSWS5tZCB3cml0dGVuXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY2xlYXJQYXRoQ2FjaGUoKTtcbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5waGFzZSwgXCJzdW1tYXJpemluZ1wiKTtcbiAgICAgIC8vIE5leHQgZGVyaXZhdGlvbiBzdGlsbCByZXR1cm5zIHN1bW1hcml6aW5nIFx1MjAxNCBubyBpbmZpbml0ZSBsb29wXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUyID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG4gICAgICBhc3NlcnQuZXF1YWwoc3RhdGUyLnBoYXNlLCBcInN1bW1hcml6aW5nXCIsIFwic3RheXMgaW4gc3VtbWFyaXppbmcgdW50aWwgU1VNTUFSWSB3cml0dGVuXCIpO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZShcIkZhaWx1cmUgYXQgdmFsaWRhdGluZy1taWxlc3RvbmU6IFZBTElEQVRJT04gd3JpdGUgY3Jhc2hlc1wiLCAoKSA9PiB7XG4gICAgdGVzdChcImFsbCBzbGljZXMgZG9uZSwgdmFsaWRhdGlvbiBuZXZlciB3cml0dGVuIFx1MjE5MiBzdHVjayBpbiB2YWxpZGF0aW5nXCIsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgICAgd3JpdGVSb2FkbWFwKGJhc2UsIFwiTTAwMVwiLCBkb25lU2xpY2VSb2FkbWFwKCkpO1xuICAgICAgLy8gTm8gVkFMSURBVElPTiBmaWxlIGF0IGFsbFxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNsZWFyUGF0aENhY2hlKCk7XG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLnBoYXNlLCBcInZhbGlkYXRpbmctbWlsZXN0b25lXCIpO1xuXG4gICAgICAvLyBDYWxsIGFnYWluIFx1MjAxNCBzdGlsbCB2YWxpZGF0aW5nIChpZGVtcG90ZW50LCBub3QgbG9vcGluZylcbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBzdGF0ZTIgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZTIucGhhc2UsIFwidmFsaWRhdGluZy1taWxlc3RvbmVcIixcbiAgICAgICAgXCJzdGF5cyBpbiB2YWxpZGF0aW5nIHVudGlsIFZBTElEQVRJT04gZmlsZSBhcHBlYXJzXCIpO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZShcIkZhaWx1cmUgYXQgY29tcGxldGluZy1taWxlc3RvbmU6IFNVTU1BUlkgd3JpdGUgZmFpbHNcIiwgKCkgPT4ge1xuICAgIHRlc3QoXCJ2YWxpZGF0aW9uIHRlcm1pbmFsIGJ1dCBTVU1NQVJZIG5ldmVyIHdyaXR0ZW4gXHUyMTkyIHN0dWNrIGluIGNvbXBsZXRpbmdcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgXCJNMDAxXCIsIGRvbmVTbGljZVJvYWRtYXAoKSk7XG4gICAgICB3cml0ZU1pbGVzdG9uZVZhbGlkYXRpb24oYmFzZSwgXCJNMDAxXCIsIFwicGFzc1wiKTtcbiAgICAgIC8vIE5vIG1pbGVzdG9uZSBTVU1NQVJZXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY2xlYXJQYXRoQ2FjaGUoKTtcbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG4gICAgICBhc3NlcnQuZXF1YWwoc3RhdGUucGhhc2UsIFwiY29tcGxldGluZy1taWxlc3RvbmVcIik7XG5cbiAgICAgIC8vIFJlcGVhdGVkIGNhbGxzIHN0YXkgaW4gY29tcGxldGluZ1xuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IHN0YXRlMiA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlMi5waGFzZSwgXCJjb21wbGV0aW5nLW1pbGVzdG9uZVwiLFxuICAgICAgICBcInN0YXlzIGluIGNvbXBsZXRpbmcgdW50aWwgU1VNTUFSWSB3cml0dGVuXCIpO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZShcIkZhaWx1cmUgYXQgcmVwbGFubmluZzogUkVQTEFOLm1kIG5ldmVyIHdyaXR0ZW4gKGxvb3AgcmlzaylcIiwgKCkgPT4ge1xuICAgIHRlc3QoXCJibG9ja2VyIGRldGVjdGVkLCByZXBsYW4gZGlzcGF0Y2hlZCBidXQgUkVQTEFOLm1kIG5vdCBjcmVhdGVkIFx1MjE5MiByZS1lbnRlcnMgcmVwbGFubmluZ1wiLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCBcIk0wMDFcIiwgc3RhbmRhcmRSb2FkbWFwKCkpO1xuICAgICAgd3JpdGVQbGFuKGJhc2UsIFwiTTAwMVwiLCBcIlMwMVwiLCBwYXJ0aWFsRG9uZVBsYW4oKSk7XG4gICAgICB3cml0ZVRhc2tTdW1tYXJ5V2l0aEJsb2NrZXIoYmFzZSwgXCJNMDAxXCIsIFwiUzAxXCIsIFwiVDAxXCIpO1xuICAgICAgLy8gTm8gUkVQTEFOLm1kIFx1MjAxNCBzaW11bGF0ZXMgZmFpbGVkIHJlcGxhbiBleGVjdXRpb25cblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNsZWFyUGF0aENhY2hlKCk7XG4gICAgICBjb25zdCBzdGF0ZTEgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZTEucGhhc2UsIFwicmVwbGFubmluZy1zbGljZVwiKTtcblxuICAgICAgLy8gQ2FsbCBhZ2FpbiBcdTIwMTQgc2FtZSByZXN1bHQsIHN0dWNrIGluIHJlcGxhbm5pbmcgdW50aWwgUkVQTEFOLm1kIGFwcGVhcnNcbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBzdGF0ZTIgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZTIucGhhc2UsIFwicmVwbGFubmluZy1zbGljZVwiLFxuICAgICAgICBcIndpdGhvdXQgUkVQTEFOLm1kLCBzdGF0ZSBzdGF5cyBpbiByZXBsYW5uaW5nIChkaXNwYXRjaCB3aWxsIHJldHJ5KVwiKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoXCJGYWlsdXJlIGF0IGNvbXBsZXRlOiBTVU1NQVJZIGV4aXN0cyBidXQgVkFMSURBVElPTiBtaXNzaW5nXCIsICgpID0+IHtcbiAgICB0ZXN0KFwibWlsZXN0b25lIFNVTU1BUlkgd2l0aG91dCBWQUxJREFUSU9OIFx1MjE5MiBzdGlsbCBjb21wbGV0ZSAoU1VNTUFSWSBpcyB0ZXJtaW5hbCBhcnRpZmFjdClcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgXCJNMDAxXCIsIGRvbmVTbGljZVJvYWRtYXAoKSk7XG4gICAgICAvLyBTVU1NQVJZIGV4aXN0cyBidXQgTk8gVkFMSURBVElPTlxuICAgICAgd3JpdGVNaWxlc3RvbmVTdW1tYXJ5KGJhc2UsIFwiTTAwMVwiKTtcbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjbGVhclBhdGhDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcblxuICAgICAgLy8gUGVyICM4NjQ6IFNVTU1BUlkgaXMgdGhlIHRlcm1pbmFsIGFydGlmYWN0LCB2YWxpZGF0aW9uIG9wdGlvbmFsXG4gICAgICBhc3NlcnQuZXF1YWwoc3RhdGUucGhhc2UsIFwiY29tcGxldGVcIixcbiAgICAgICAgXCJTVU1NQVJZIGFsb25lIHNob3VsZCBtYXJrIG1pbGVzdG9uZSBjb21wbGV0ZSBwZXIgIzg2NFwiKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoXCJGYWlsdXJlIGF0IGJsb2NrZWQ6IGRlcGVuZGVuY3kgbWlsZXN0b25lIHBhcnRpYWxseSBjb21wbGV0ZVwiLCAoKSA9PiB7XG4gICAgdGVzdChcIk0wMDEgaGFzIHNsaWNlcyBkb25lIGJ1dCBubyBTVU1NQVJZIFx1MjE5MiBNMDAyIChkZXBlbmRzIG9uIE0wMDEpIGlzIGJsb2NrZWRcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgICAvLyBNMDAxOiBhbGwgc2xpY2VzIGRvbmUgYnV0IG5vIFNVTU1BUlkvVkFMSURBVElPTlxuICAgICAgd3JpdGVSb2FkbWFwKGJhc2UsIFwiTTAwMVwiLCBkb25lU2xpY2VSb2FkbWFwKCkpO1xuICAgICAgLy8gTTAwMSBoYXMgbm8gU1VNTUFSWSBcdTIxOTIgaXQncyBpbiB2YWxpZGF0aW5nL2NvbXBsZXRpbmcsIE5PVCBjb21wbGV0ZVxuXG4gICAgICAvLyBNMDAyOiBkZXBlbmRzIG9uIE0wMDFcbiAgICAgIHdyaXRlQ29udGV4dChiYXNlLCBcIk0wMDJcIiwgW1xuICAgICAgICBcIi0tLVwiLFxuICAgICAgICBcImRlcGVuZHNfb246XCIsXG4gICAgICAgIFwiICAtIE0wMDFcIixcbiAgICAgICAgXCItLS1cIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCIjIE0wMDI6IERlcGVuZGVudFwiLFxuICAgICAgXS5qb2luKFwiXFxuXCIpKTtcbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCBcIk0wMDJcIiwgW1xuICAgICAgICBcIiMgTTAwMjogRGVwZW5kZW50XCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiKipWaXNpb246KiogVGVzdC5cIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCIjIyBTbGljZXNcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCItIFsgXSAqKlMwMTogU2xpY2UqKiBgcmlzazpsb3dgIGBkZXBlbmRzOltdYFwiLFxuICAgICAgICBcIiAgPiBBZnRlciB0aGlzOiBkb25lLlwiLFxuICAgICAgXS5qb2luKFwiXFxuXCIpKTtcblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNsZWFyUGF0aENhY2hlKCk7XG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuXG4gICAgICAvLyBNMDAxIGlzIGFjdGl2ZSAobm90IHlldCBjb21wbGV0ZSksIE0wMDIgc2hvdWxkIHdhaXRcbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5hY3RpdmVNaWxlc3RvbmU/LmlkLCBcIk0wMDFcIixcbiAgICAgICAgXCJNMDAxIHNob3VsZCBiZSBhY3RpdmUgKG5vdCBjb21wbGV0ZSB3aXRob3V0IFNVTU1BUlkpXCIpO1xuICAgICAgYXNzZXJ0Lm5vdEVxdWFsKHN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQsIFwiTTAwMlwiLFxuICAgICAgICBcIk0wMDIgc2hvdWxkIG5vdCBiZSBhY3RpdmUgd2hpbGUgTTAwMSBpcyBpbmNvbXBsZXRlXCIpO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZShcIkZhaWx1cmU6IG11bHRpcGxlIHJlY29uY2lsaWF0aW9uIGluIHNpbmdsZSBkZXJpdmF0aW9uXCIsICgpID0+IHtcbiAgICB0ZXN0KFwiREIgaGFzIDMgc3RhbGUgdGFza3MsIGFsbCB3aXRoIFNVTU1BUlkgb24gZGlzayBcdTIxOTIgZmlyc3QgREItcGVuZGluZyB0YXNrIHJlbWFpbnMgYWN0aXZlXCIsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgICAgY29uc3QgZGJQYXRoID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJnc2QuZGJcIik7XG4gICAgICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcblxuICAgICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJNMDAxOiBUZXN0XCIsIHN0YXR1czogXCJhY3RpdmVcIiB9KTtcbiAgICAgIGluc2VydFNsaWNlKHsgaWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiUzAxOiBTbGljZVwiLCBzdGF0dXM6IFwiYWN0aXZlXCIsIGRlcGVuZHM6IFtdIH0pO1xuICAgICAgaW5zZXJ0VGFzayh7IGlkOiBcIlQwMVwiLCBzbGljZUlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHRpdGxlOiBcIlQwMVwiLCBzdGF0dXM6IFwicGVuZGluZ1wiIH0pO1xuICAgICAgaW5zZXJ0VGFzayh7IGlkOiBcIlQwMlwiLCBzbGljZUlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHRpdGxlOiBcIlQwMlwiLCBzdGF0dXM6IFwiaW4tcHJvZ3Jlc3NcIiB9KTtcbiAgICAgIGluc2VydFRhc2soeyBpZDogXCJUMDNcIiwgc2xpY2VJZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUMDNcIiwgc3RhdHVzOiBcInBlbmRpbmdcIiB9KTtcblxuICAgICAgY29uc3QgdGhyZWVUYXNrUm9hZG1hcCA9IFtcbiAgICAgICAgXCIjIE0wMDE6IFRlc3RcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCIqKlZpc2lvbjoqKiBUZXN0LlwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIiMjIFNsaWNlc1wiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIi0gWyBdICoqUzAxOiBTbGljZSoqIGByaXNrOmxvd2AgYGRlcGVuZHM6W11gXCIsXG4gICAgICAgIFwiICA+IEFmdGVyIHRoaXM6IGRvbmUuXCIsXG4gICAgICBdLmpvaW4oXCJcXG5cIik7XG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgXCJNMDAxXCIsIHRocmVlVGFza1JvYWRtYXApO1xuXG4gICAgICBjb25zdCB0aHJlZVRhc2tQbGFuID0gW1xuICAgICAgICBcIiMgUzAxOiBTbGljZVwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIioqR29hbDoqKiBUZXN0LlwiLFxuICAgICAgICBcIioqRGVtbzoqKiBUZXN0cyBwYXNzLlwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIiMjIFRhc2tzXCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiLSBbIF0gKipUMDE6IEZpcnN0KiogYGVzdDoxMG1gXCIsXG4gICAgICAgIFwiICBGaXJzdC5cIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCItIFsgXSAqKlQwMjogU2Vjb25kKiogYGVzdDoxMG1gXCIsXG4gICAgICAgIFwiICBTZWNvbmQuXCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiLSBbIF0gKipUMDM6IFRoaXJkKiogYGVzdDoxMG1gXCIsXG4gICAgICAgIFwiICBUaGlyZC5cIixcbiAgICAgIF0uam9pbihcIlxcblwiKTtcbiAgICAgIHdyaXRlUGxhbihiYXNlLCBcIk0wMDFcIiwgXCJTMDFcIiwgdGhyZWVUYXNrUGxhbik7XG5cbiAgICAgIC8vIEFsbCAzIHRhc2tzIGhhdmUgU1VNTUFSWSBvbiBkaXNrXG4gICAgICB3cml0ZVRhc2tTdW1tYXJ5KGJhc2UsIFwiTTAwMVwiLCBcIlMwMVwiLCBcIlQwMVwiKTtcbiAgICAgIHdyaXRlVGFza1N1bW1hcnkoYmFzZSwgXCJNMDAxXCIsIFwiUzAxXCIsIFwiVDAyXCIpO1xuICAgICAgd3JpdGVUYXNrU3VtbWFyeShiYXNlLCBcIk0wMDFcIiwgXCJTMDFcIiwgXCJUMDNcIik7XG5cbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlRnJvbURiKGJhc2UpO1xuXG4gICAgICBhc3NlcnQuZXF1YWwoc3RhdGUucGhhc2UsIFwiZXhlY3V0aW5nXCIsXG4gICAgICAgIFwiZGlzayBTVU1NQVJZIHByb2plY3Rpb25zIG11c3Qgbm90IHJlY29uY2lsZSBEQiB0YXNrIHN0YXRlXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHN0YXRlLmFjdGl2ZVRhc2s/LmlkLCBcIlQwMVwiLCBcImZpcnN0IG5vbi1jbG9zZWQgREIgdGFzayByZW1haW5zIGFjdGl2ZVwiKTtcbiAgICB9KTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUdBLFNBQVMsVUFBVSxNQUFNLGlCQUFpQjtBQUMxQyxPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhLFdBQVcsUUFBUSxxQkFBaUM7QUFDMUUsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUV2QjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFDUDtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFDUCxTQUFTLHNCQUFzQjtBQUMvQixTQUFTLHNCQUFzQjtBQUkvQixNQUFNLFdBQXFCLENBQUM7QUFFNUIsU0FBUyxvQkFBNEI7QUFDbkMsUUFBTSxPQUFPLFlBQVksS0FBSyxPQUFPLEdBQUcsa0JBQWtCLENBQUM7QUFDM0QsWUFBVSxLQUFLLE1BQU0sUUFBUSxZQUFZLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUMvRCxXQUFTLEtBQUssSUFBSTtBQUNsQixTQUFPO0FBQ1Q7QUFFQSxVQUFVLE1BQU07QUFDZCxhQUFXLE9BQU8sU0FBUyxPQUFPLENBQUMsR0FBRztBQUNwQyxRQUFJO0FBQ0YsYUFBTyxLQUFLLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDOUMsUUFBUTtBQUFBLElBQW9CO0FBQUEsRUFDOUI7QUFDQSxNQUFJO0FBQUUsa0JBQWM7QUFBQSxFQUFHLFFBQVE7QUFBQSxFQUF3QjtBQUN6RCxDQUFDO0FBRUQsU0FBUyxhQUFhLE1BQWMsS0FBYSxTQUF1QjtBQUN0RSxRQUFNLE1BQU0sS0FBSyxNQUFNLFFBQVEsY0FBYyxHQUFHO0FBQ2hELFlBQVUsS0FBSyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ2xDLGdCQUFjLEtBQUssS0FBSyxHQUFHLEdBQUcsYUFBYSxHQUFHLE9BQU87QUFDdkQ7QUFFQSxTQUFTLGtCQUFrQixNQUFjLEtBQWEsU0FBdUI7QUFDM0UsUUFBTSxNQUFNLEtBQUssTUFBTSxRQUFRLGNBQWMsR0FBRztBQUNoRCxZQUFVLEtBQUssRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNsQyxnQkFBYyxLQUFLLEtBQUssR0FBRyxHQUFHLG1CQUFtQixHQUFHLE9BQU87QUFDN0Q7QUFFQSxTQUFTLGFBQWEsTUFBYyxLQUFhLFNBQXVCO0FBQ3RFLFFBQU0sTUFBTSxLQUFLLE1BQU0sUUFBUSxjQUFjLEdBQUc7QUFDaEQsWUFBVSxLQUFLLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDbEMsZ0JBQWMsS0FBSyxLQUFLLEdBQUcsR0FBRyxhQUFhLEdBQUcsT0FBTztBQUN2RDtBQUVBLFNBQVMsVUFBVSxNQUFjLEtBQWEsS0FBYSxTQUF1QjtBQUNoRixRQUFNLE1BQU0sS0FBSyxNQUFNLFFBQVEsY0FBYyxLQUFLLFVBQVUsR0FBRztBQUMvRCxRQUFNLFdBQVcsS0FBSyxLQUFLLE9BQU87QUFDbEMsWUFBVSxVQUFVLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDdkMsZ0JBQWMsS0FBSyxLQUFLLEdBQUcsR0FBRyxVQUFVLEdBQUcsT0FBTztBQUVsRCxRQUFNLGNBQWMsUUFBUSxTQUFTLGNBQWM7QUFDbkQsYUFBVyxLQUFLLGFBQWE7QUFDM0IsVUFBTSxNQUFNLEVBQUUsQ0FBQztBQUNmLGtCQUFjLEtBQUssVUFBVSxHQUFHLEdBQUcsVUFBVSxHQUFHLEtBQUssR0FBRztBQUFBO0FBQUE7QUFBQSxDQUFrQjtBQUFBLEVBQzVFO0FBQ0Y7QUFFQSxTQUFTLGlCQUFpQixNQUFjLEtBQWEsS0FBYSxLQUFtQjtBQUNuRixRQUFNLFdBQVcsS0FBSyxNQUFNLFFBQVEsY0FBYyxLQUFLLFVBQVUsS0FBSyxPQUFPO0FBQzdFLFlBQVUsVUFBVSxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3ZDLGdCQUFjLEtBQUssVUFBVSxHQUFHLEdBQUcsYUFBYSxHQUFHO0FBQUEsSUFDakQsS0FBSyxHQUFHO0FBQUEsSUFDUjtBQUFBLElBQ0E7QUFBQSxFQUNGLEVBQUUsS0FBSyxJQUFJLENBQUM7QUFDZDtBQUVBLFNBQVMsNEJBQTRCLE1BQWMsS0FBYSxLQUFhLEtBQW1CO0FBQzlGLFFBQU0sV0FBVyxLQUFLLE1BQU0sUUFBUSxjQUFjLEtBQUssVUFBVSxLQUFLLE9BQU87QUFDN0UsWUFBVSxVQUFVLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDdkMsZ0JBQWMsS0FBSyxVQUFVLEdBQUcsR0FBRyxhQUFhLEdBQUc7QUFBQSxJQUNqRDtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0EsS0FBSyxHQUFHO0FBQUEsSUFDUjtBQUFBLElBQ0E7QUFBQSxFQUNGLEVBQUUsS0FBSyxJQUFJLENBQUM7QUFDZDtBQUVBLFNBQVMsa0JBQWtCLE1BQWMsS0FBYSxLQUFtQjtBQUN2RSxRQUFNLE1BQU0sS0FBSyxNQUFNLFFBQVEsY0FBYyxLQUFLLFVBQVUsR0FBRztBQUMvRCxZQUFVLEtBQUssRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNsQyxnQkFBYyxLQUFLLEtBQUssR0FBRyxHQUFHLGFBQWEsR0FBRyxLQUFLLEdBQUc7QUFBQTtBQUFBO0FBQUEsQ0FBMkI7QUFDbkY7QUFFQSxTQUFTLHNCQUFzQixNQUFjLEtBQW1CO0FBQzlELFFBQU0sTUFBTSxLQUFLLE1BQU0sUUFBUSxjQUFjLEdBQUc7QUFDaEQsWUFBVSxLQUFLLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDbEMsZ0JBQWMsS0FBSyxLQUFLLEdBQUcsR0FBRyxhQUFhLEdBQUcsS0FBSyxHQUFHO0FBQUE7QUFBQTtBQUFBLENBQW1DO0FBQzNGO0FBRUEsU0FBUyx5QkFBeUIsTUFBYyxLQUFhLFVBQWtCLFFBQWM7QUFDM0YsUUFBTSxNQUFNLEtBQUssTUFBTSxRQUFRLGNBQWMsR0FBRztBQUNoRCxZQUFVLEtBQUssRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNsQyxnQkFBYyxLQUFLLEtBQUssR0FBRyxHQUFHLGdCQUFnQixHQUFHO0FBQUEsSUFDL0M7QUFBQSxJQUNBLFlBQVksT0FBTztBQUFBLElBQ25CO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLEVBQ0YsRUFBRSxLQUFLLElBQUksQ0FBQztBQUNkO0FBRUEsU0FBUyxtQkFBbUIsTUFBYyxLQUFhLEtBQW1CO0FBQ3hFLFFBQU0sTUFBTSxLQUFLLE1BQU0sUUFBUSxjQUFjLEtBQUssVUFBVSxHQUFHO0FBQy9ELFlBQVUsS0FBSyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ2xDLGdCQUFjLEtBQUssS0FBSyxHQUFHLEdBQUcsb0JBQW9CLEdBQUcsNEJBQTRCO0FBQ25GO0FBRUEsU0FBUyxZQUFZLE1BQWMsS0FBYSxLQUFtQjtBQUNqRSxRQUFNLE1BQU0sS0FBSyxNQUFNLFFBQVEsY0FBYyxLQUFLLFVBQVUsR0FBRztBQUMvRCxZQUFVLEtBQUssRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNsQyxnQkFBYyxLQUFLLEtBQUssR0FBRyxHQUFHLFlBQVksR0FBRyxpQ0FBaUM7QUFDaEY7QUFFQSxTQUFTLGNBQWMsTUFBYyxLQUFhLEtBQW1CO0FBQ25FLFFBQU0sTUFBTSxLQUFLLE1BQU0sUUFBUSxjQUFjLEtBQUssVUFBVSxHQUFHO0FBQy9ELFlBQVUsS0FBSyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ2xDLGdCQUFjLEtBQUssS0FBSyxHQUFHLEdBQUcsY0FBYyxHQUFHO0FBQUEsSUFDN0M7QUFBQSxJQUNBLGdCQUFnQjtBQUFBLElBQ2hCLFlBQVk7QUFBQSxJQUNaO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxFQUNGLEVBQUUsS0FBSyxJQUFJLENBQUM7QUFDZDtBQUdBLFNBQVMsa0JBQTBCO0FBQ2pDLFNBQU87QUFBQSxJQUNMO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLEVBQ0YsRUFBRSxLQUFLLElBQUk7QUFDYjtBQUdBLFNBQVMsbUJBQTJCO0FBQ2xDLFNBQU87QUFBQSxJQUNMO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLEVBQ0YsRUFBRSxLQUFLLElBQUk7QUFDYjtBQUdBLFNBQVMsZUFBdUI7QUFDOUIsU0FBTztBQUFBLElBQ0w7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLEVBQ0YsRUFBRSxLQUFLLElBQUk7QUFDYjtBQUdBLFNBQVMsY0FBc0I7QUFDN0IsU0FBTztBQUFBLElBQ0w7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLEVBQ0YsRUFBRSxLQUFLLElBQUk7QUFDYjtBQUdBLFNBQVMsa0JBQTBCO0FBQ2pDLFNBQU87QUFBQSxJQUNMO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxFQUNGLEVBQUUsS0FBSyxJQUFJO0FBQ2I7QUFNQSxTQUFTLGtDQUFrQyxNQUFNO0FBRS9DLFdBQVMseUJBQXlCLE1BQU07QUFDdEMsU0FBSyw0Q0FBdUMsWUFBWTtBQUN0RCxZQUFNLE9BQU8sa0JBQWtCO0FBQy9CLDJCQUFxQjtBQUNyQixZQUFNLFFBQVEsTUFBTSxZQUFZLElBQUk7QUFFcEMsYUFBTyxNQUFNLE1BQU0sT0FBTyxjQUFjO0FBQ3hDLGFBQU8sTUFBTSxNQUFNLGlCQUFpQixJQUFJO0FBQ3hDLGFBQU8sTUFBTSxNQUFNLGFBQWEsSUFBSTtBQUNwQyxhQUFPLE1BQU0sTUFBTSxZQUFZLElBQUk7QUFDbkMsYUFBTyxnQkFBZ0IsTUFBTSxVQUFVLENBQUMsQ0FBQztBQUFBLElBQzNDLENBQUM7QUFFRCxTQUFLLDZEQUF3RCxZQUFZO0FBQ3ZFLFlBQU0sT0FBTyxrQkFBa0I7QUFDL0IsbUJBQWEsTUFBTSxRQUFRLCtCQUErQjtBQUMxRCwyQkFBcUI7QUFDckIsWUFBTSxRQUFRLE1BQU0sWUFBWSxJQUFJO0FBRXBDLGFBQU8sTUFBTSxNQUFNLE9BQU8sY0FBYztBQUN4QyxhQUFPLEdBQUcsTUFBTSxvQkFBb0IsTUFBTSwrQkFBK0I7QUFDekUsYUFBTyxNQUFNLE1BQU0saUJBQWlCLElBQUksTUFBTTtBQUFBLElBQ2hELENBQUM7QUFFRCxTQUFLLDJFQUFzRSxZQUFZO0FBQ3JGLFlBQU0sT0FBTyxrQkFBa0I7QUFDL0IsbUJBQWEsTUFBTSxRQUFRLDBCQUEwQjtBQUVyRCxtQkFBYSxNQUFNLFFBQVE7QUFBQSxRQUN6QjtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLE1BQ0YsRUFBRSxLQUFLLElBQUksQ0FBQztBQUNaLDJCQUFxQjtBQUNyQixZQUFNLFFBQVEsTUFBTSxZQUFZLElBQUk7QUFFcEMsYUFBTyxNQUFNLE1BQU0sT0FBTyxnQkFBZ0IsMkRBQTJEO0FBQUEsSUFDdkcsQ0FBQztBQUFBLEVBQ0gsQ0FBQztBQU1ELFdBQVMsNkJBQTZCLE1BQU07QUFDMUMsU0FBSyw0REFBdUQsWUFBWTtBQUN0RSxZQUFNLE9BQU8sa0JBQWtCO0FBQy9CLHdCQUFrQixNQUFNLFFBQVEsaUNBQWlDO0FBQ2pFLDJCQUFxQjtBQUNyQixZQUFNLFFBQVEsTUFBTSxZQUFZLElBQUk7QUFFcEMsYUFBTyxNQUFNLE1BQU0sT0FBTyxrQkFBa0I7QUFDNUMsYUFBTyxHQUFHLE1BQU0sb0JBQW9CLElBQUk7QUFDeEMsYUFBTyxNQUFNLE1BQU0saUJBQWlCLElBQUksTUFBTTtBQUFBLElBQ2hELENBQUM7QUFFRCxTQUFLLG9FQUErRCxZQUFZO0FBQzlFLFlBQU0sT0FBTyxrQkFBa0I7QUFDL0IsbUJBQWEsTUFBTSxRQUFRLCtCQUErQjtBQUMxRCx3QkFBa0IsTUFBTSxRQUFRLGlDQUFpQztBQUNqRSwyQkFBcUI7QUFDckIsWUFBTSxRQUFRLE1BQU0sWUFBWSxJQUFJO0FBRXBDLGFBQU8sU0FBUyxNQUFNLE9BQU8sb0JBQW9CLHVDQUF1QztBQUFBLElBQzFGLENBQUM7QUFBQSxFQUNILENBQUM7QUFNRCxXQUFTLHdDQUF3QyxNQUFNO0FBQ3JELFNBQUssZ0RBQWdELFlBQVk7QUFHL0QsWUFBTSxPQUFPLGtCQUFrQjtBQUMvQix3QkFBa0IsTUFBTSxRQUFRLHlCQUF5QjtBQUN6RCwyQkFBcUI7QUFDckIsWUFBTSxRQUFRLE1BQU0sWUFBWSxJQUFJO0FBQ3BDLGFBQU8sU0FBUyxNQUFNLE9BQU8sWUFBWTtBQUFBLElBQzNDLENBQUM7QUFBQSxFQUNILENBQUM7QUFNRCxXQUFTLHlDQUF5QyxNQUFNO0FBQ3RELFNBQUssaURBQWlELFlBQVk7QUFDaEUsWUFBTSxPQUFPLGtCQUFrQjtBQUMvQixtQkFBYSxNQUFNLFFBQVEsMEJBQTBCO0FBQ3JELG1CQUFhLE1BQU0sUUFBUSxnQkFBZ0IsQ0FBQztBQUM1QywyQkFBcUI7QUFDckIsWUFBTSxRQUFRLE1BQU0sWUFBWSxJQUFJO0FBQ3BDLGFBQU8sU0FBUyxNQUFNLE9BQU8sYUFBYTtBQUFBLElBQzVDLENBQUM7QUFBQSxFQUNILENBQUM7QUFNRCxXQUFTLHFCQUFxQixNQUFNO0FBQ2xDLFNBQUssb0RBQStDLFlBQVk7QUFDOUQsWUFBTSxPQUFPLGtCQUFrQjtBQUMvQixtQkFBYSxNQUFNLFFBQVEsZ0JBQWdCLENBQUM7QUFDNUMsMkJBQXFCO0FBQ3JCLFlBQU0sUUFBUSxNQUFNLFlBQVksSUFBSTtBQUVwQyxhQUFPLE1BQU0sTUFBTSxPQUFPLFVBQVU7QUFDcEMsYUFBTyxHQUFHLE1BQU0sZ0JBQWdCLElBQUk7QUFDcEMsYUFBTyxNQUFNLE1BQU0sYUFBYSxJQUFJLEtBQUs7QUFBQSxJQUMzQyxDQUFDO0FBRUQsU0FBSyw4Q0FBeUMsWUFBWTtBQUN4RCxZQUFNLE9BQU8sa0JBQWtCO0FBQy9CLG1CQUFhLE1BQU0sUUFBUSxnQkFBZ0IsQ0FBQztBQUU1QyxZQUFNLE1BQU0sS0FBSyxNQUFNLFFBQVEsY0FBYyxRQUFRLFVBQVUsS0FBSztBQUNwRSxnQkFBVSxLQUFLLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDbEMsb0JBQWMsS0FBSyxLQUFLLGFBQWEsR0FBRztBQUFBLFFBQ3RDO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLE1BQ0YsRUFBRSxLQUFLLElBQUksQ0FBQztBQUNaLDJCQUFxQjtBQUNyQixZQUFNLFFBQVEsTUFBTSxZQUFZLElBQUk7QUFFcEMsYUFBTyxNQUFNLE1BQU0sT0FBTyxZQUFZLGdEQUFnRDtBQUFBLElBQ3hGLENBQUM7QUFFRCxTQUFLLGlFQUE0RCxZQUFZO0FBQzNFLFlBQU0sT0FBTyxrQkFBa0I7QUFDL0IsbUJBQWEsTUFBTSxRQUFRLGdCQUFnQixDQUFDO0FBRTVDLFlBQU0sTUFBTSxLQUFLLE1BQU0sUUFBUSxjQUFjLFFBQVEsVUFBVSxLQUFLO0FBQ3BFLGdCQUFVLEtBQUssS0FBSyxPQUFPLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNqRCxvQkFBYyxLQUFLLEtBQUssYUFBYSxHQUFHLGFBQWEsQ0FBQztBQUV0RCwyQkFBcUI7QUFDckIsWUFBTSxRQUFRLE1BQU0sWUFBWSxJQUFJO0FBRXBDLGFBQU8sTUFBTSxNQUFNLE9BQU8sWUFBWSxpREFBaUQ7QUFBQSxJQUN6RixDQUFDO0FBRUQsU0FBSyxxREFBZ0QsWUFBWTtBQUMvRCxZQUFNLE9BQU8sa0JBQWtCO0FBQy9CLG1CQUFhLE1BQU0sUUFBUSxnQkFBZ0IsQ0FBQztBQUM1QyxnQkFBVSxNQUFNLFFBQVEsT0FBTyxhQUFhLENBQUM7QUFDN0MsMkJBQXFCO0FBQ3JCLFlBQU0sUUFBUSxNQUFNLFlBQVksSUFBSTtBQUVwQyxhQUFPLFNBQVMsTUFBTSxPQUFPLFlBQVksNENBQTRDO0FBRXJGLGFBQU8sTUFBTSxNQUFNLE9BQU8sV0FBVztBQUFBLElBQ3ZDLENBQUM7QUFBQSxFQUNILENBQUM7QUFNRCxXQUFTLDZCQUE2QixNQUFNO0FBQzFDLFNBQUssMERBQXFELFlBQVk7QUFDcEUsWUFBTSxPQUFPLGtCQUFrQjtBQUMvQixZQUFNLFNBQVMsS0FBSyxNQUFNLFFBQVEsUUFBUTtBQUMxQyxtQkFBYSxNQUFNO0FBR25CLHNCQUFnQixFQUFFLElBQUksUUFBUSxPQUFPLGNBQWMsUUFBUSxTQUFTLENBQUM7QUFDckUsa0JBQVksRUFBRSxJQUFJLE9BQU8sYUFBYSxRQUFRLE9BQU8sY0FBYyxRQUFRLFVBQVUsU0FBUyxDQUFDLEVBQUUsQ0FBQztBQUNsRyxpQkFBVyxFQUFFLElBQUksT0FBTyxTQUFTLE9BQU8sYUFBYSxRQUFRLE9BQU8sYUFBYSxRQUFRLFVBQVUsQ0FBQztBQUdwRyxtQkFBYSxNQUFNLFFBQVEsZ0JBQWdCLENBQUM7QUFDNUMsZ0JBQVUsTUFBTSxRQUFRLE9BQU8sYUFBYSxDQUFDO0FBRzdDLG9CQUFjLEVBQUUsYUFBYSxRQUFRLFNBQVMsT0FBTyxRQUFRLE1BQU0sT0FBTyxTQUFTLFFBQVEsVUFBVSxDQUFDO0FBRXRHLFlBQU0sVUFBVSx5QkFBeUIsUUFBUSxLQUFLO0FBQ3RELGFBQU8sR0FBRyxVQUFVLEdBQUcsMkJBQTJCO0FBRWxELDJCQUFxQjtBQUNyQixZQUFNLFFBQVEsTUFBTSxrQkFBa0IsSUFBSTtBQUUxQyxhQUFPLE1BQU0sTUFBTSxPQUFPLGtCQUFrQjtBQUFBLElBQzlDLENBQUM7QUFFRCxTQUFLLHlEQUFvRCxZQUFZO0FBQ25FLFlBQU0sT0FBTyxrQkFBa0I7QUFDL0IsWUFBTSxTQUFTLEtBQUssTUFBTSxRQUFRLFFBQVE7QUFDMUMsbUJBQWEsTUFBTTtBQUVuQixzQkFBZ0IsRUFBRSxJQUFJLFFBQVEsT0FBTyxjQUFjLFFBQVEsU0FBUyxDQUFDO0FBQ3JFLGtCQUFZLEVBQUUsSUFBSSxPQUFPLGFBQWEsUUFBUSxPQUFPLGNBQWMsUUFBUSxVQUFVLFNBQVMsQ0FBQyxFQUFFLENBQUM7QUFDbEcsaUJBQVcsRUFBRSxJQUFJLE9BQU8sU0FBUyxPQUFPLGFBQWEsUUFBUSxPQUFPLGFBQWEsUUFBUSxVQUFVLENBQUM7QUFFcEcsbUJBQWEsTUFBTSxRQUFRLGdCQUFnQixDQUFDO0FBQzVDLGdCQUFVLE1BQU0sUUFBUSxPQUFPLGFBQWEsQ0FBQztBQUc3QyxZQUFNLFVBQVUseUJBQXlCLFFBQVEsS0FBSztBQUN0RCxhQUFPLE1BQU0sU0FBUyxHQUFHLDhCQUE4QjtBQUV2RCwyQkFBcUI7QUFDckIsWUFBTSxRQUFRLE1BQU0sa0JBQWtCLElBQUk7QUFFMUMsYUFBTyxTQUFTLE1BQU0sT0FBTyxrQkFBa0I7QUFBQSxJQUNqRCxDQUFDO0FBQUEsRUFDSCxDQUFDO0FBTUQsV0FBUyxzQkFBc0IsTUFBTTtBQUNuQyxTQUFLLDZDQUF3QyxZQUFZO0FBQ3ZELFlBQU0sT0FBTyxrQkFBa0I7QUFDL0IsbUJBQWEsTUFBTSxRQUFRLGdCQUFnQixDQUFDO0FBQzVDLGdCQUFVLE1BQU0sUUFBUSxPQUFPLGFBQWEsQ0FBQztBQUM3QywyQkFBcUI7QUFDckIsWUFBTSxRQUFRLE1BQU0sWUFBWSxJQUFJO0FBRXBDLGFBQU8sTUFBTSxNQUFNLE9BQU8sV0FBVztBQUNyQyxhQUFPLEdBQUcsTUFBTSxlQUFlLElBQUk7QUFDbkMsYUFBTyxNQUFNLE1BQU0sWUFBWSxJQUFJLEtBQUs7QUFBQSxJQUMxQyxDQUFDO0FBRUQsU0FBSyxxRUFBZ0UsWUFBWTtBQUMvRSxZQUFNLE9BQU8sa0JBQWtCO0FBQy9CLG1CQUFhLE1BQU0sUUFBUSxnQkFBZ0IsQ0FBQztBQUM1QyxnQkFBVSxNQUFNLFFBQVEsT0FBTyxhQUFhLENBQUM7QUFDN0Msb0JBQWMsTUFBTSxRQUFRLEtBQUs7QUFDakMsMkJBQXFCO0FBQ3JCLFlBQU0sUUFBUSxNQUFNLFlBQVksSUFBSTtBQUVwQyxhQUFPLE1BQU0sTUFBTSxPQUFPLFdBQVc7QUFDckMsYUFBTztBQUFBLFFBQ0wsTUFBTSxXQUFXLFlBQVksRUFBRSxTQUFTLFFBQVEsS0FBSyxNQUFNLFdBQVcsWUFBWSxFQUFFLFNBQVMsVUFBVTtBQUFBLFFBQ3ZHO0FBQUEsTUFDRjtBQUFBLElBQ0YsQ0FBQztBQUVELFNBQUsseUVBQW9FLFlBQVk7QUFDbkYsWUFBTSxPQUFPLGtCQUFrQjtBQUMvQixtQkFBYSxNQUFNLFFBQVEsZ0JBQWdCLENBQUM7QUFDNUMsZ0JBQVUsTUFBTSxRQUFRLE9BQU8sZ0JBQWdCLENBQUM7QUFDaEQsMkJBQXFCO0FBQ3JCLFlBQU0sUUFBUSxNQUFNLFlBQVksSUFBSTtBQUVwQyxhQUFPLE1BQU0sTUFBTSxPQUFPLGFBQWEsd0NBQXdDO0FBQy9FLGFBQU8sTUFBTSxNQUFNLFlBQVksSUFBSSxPQUFPLDJCQUEyQjtBQUNyRSxhQUFPLE1BQU0sTUFBTSxVQUFVLE9BQU8sTUFBTSxDQUFDO0FBQzNDLGFBQU8sTUFBTSxNQUFNLFVBQVUsT0FBTyxPQUFPLENBQUM7QUFBQSxJQUM5QyxDQUFDO0FBQUEsRUFDSCxDQUFDO0FBTUQsV0FBUyx1Q0FBdUMsTUFBTTtBQUNwRCxTQUFLLCtDQUErQyxZQUFZO0FBRTlELFlBQU0sT0FBTyxrQkFBa0I7QUFDL0IsbUJBQWEsTUFBTSxRQUFRLGdCQUFnQixDQUFDO0FBQzVDLGdCQUFVLE1BQU0sUUFBUSxPQUFPLFlBQVksQ0FBQztBQUM1QywyQkFBcUI7QUFDckIsWUFBTSxRQUFRLE1BQU0sWUFBWSxJQUFJO0FBQ3BDLGFBQU8sU0FBUyxNQUFNLE9BQU8sV0FBVztBQUFBLElBQzFDLENBQUM7QUFBQSxFQUNILENBQUM7QUFNRCxXQUFTLHdCQUF3QixNQUFNO0FBQ3JDLFNBQUsseURBQW9ELFlBQVk7QUFDbkUsWUFBTSxPQUFPLGtCQUFrQjtBQUMvQixtQkFBYSxNQUFNLFFBQVEsZ0JBQWdCLENBQUM7QUFDNUMsZ0JBQVUsTUFBTSxRQUFRLE9BQU8sWUFBWSxDQUFDO0FBQzVDLDJCQUFxQjtBQUNyQixZQUFNLFFBQVEsTUFBTSxZQUFZLElBQUk7QUFFcEMsYUFBTyxNQUFNLE1BQU0sT0FBTyxhQUFhO0FBQ3ZDLGFBQU8sR0FBRyxNQUFNLGdCQUFnQixJQUFJO0FBQ3BDLGFBQU8sTUFBTSxNQUFNLGFBQWEsSUFBSSxLQUFLO0FBQ3pDLGFBQU8sTUFBTSxNQUFNLFlBQVksTUFBTSw4QkFBOEI7QUFDbkUsYUFBTyxNQUFNLE1BQU0sVUFBVSxPQUFPLE1BQU0sQ0FBQztBQUMzQyxhQUFPLE1BQU0sTUFBTSxVQUFVLE9BQU8sT0FBTyxDQUFDO0FBQUEsSUFDOUMsQ0FBQztBQUVELFNBQUssMkRBQXNELFlBQVk7QUFDckUsWUFBTSxPQUFPLGtCQUFrQjtBQUMvQixtQkFBYSxNQUFNLFFBQVEsZ0JBQWdCLENBQUM7QUFFNUMsWUFBTSxjQUFjO0FBQUEsUUFDbEI7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLE1BQ0YsRUFBRSxLQUFLLElBQUk7QUFDWCxZQUFNLE1BQU0sS0FBSyxNQUFNLFFBQVEsY0FBYyxRQUFRLFVBQVUsS0FBSztBQUNwRSxZQUFNLFdBQVcsS0FBSyxLQUFLLE9BQU87QUFDbEMsZ0JBQVUsVUFBVSxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3ZDLG9CQUFjLEtBQUssS0FBSyxhQUFhLEdBQUcsV0FBVztBQUNuRCxvQkFBYyxLQUFLLFVBQVUsYUFBYSxHQUFHLHFCQUFxQjtBQUNsRSxvQkFBYyxLQUFLLFVBQVUsYUFBYSxHQUFHLHFCQUFxQjtBQUdsRSx1QkFBaUIsTUFBTSxRQUFRLE9BQU8sS0FBSztBQUMzQyx1QkFBaUIsTUFBTSxRQUFRLE9BQU8sS0FBSztBQUUzQywyQkFBcUI7QUFDckIsWUFBTSxRQUFRLE1BQU0sWUFBWSxJQUFJO0FBR3BDLGFBQU8sTUFBTSxNQUFNLE9BQU8sZUFBZSxzREFBc0Q7QUFBQSxJQUNqRyxDQUFDO0FBQUEsRUFDSCxDQUFDO0FBTUQsV0FBUyx3Q0FBd0MsTUFBTTtBQUNyRCxTQUFLLCtDQUErQyxZQUFZO0FBRTlELFlBQU0sT0FBTyxrQkFBa0I7QUFDL0IsbUJBQWEsTUFBTSxRQUFRLGdCQUFnQixDQUFDO0FBQzVDLGdCQUFVLE1BQU0sUUFBUSxPQUFPLGFBQWEsQ0FBQztBQUM3QywyQkFBcUI7QUFDckIsWUFBTSxRQUFRLE1BQU0sWUFBWSxJQUFJO0FBQ3BDLGFBQU8sU0FBUyxNQUFNLE9BQU8sV0FBVztBQUFBLElBQzFDLENBQUM7QUFBQSxFQUNILENBQUM7QUFNRCxXQUFTLGtDQUFrQyxNQUFNO0FBQy9DLFNBQUssbUVBQThELFlBQVk7QUFDN0UsWUFBTSxPQUFPLGtCQUFrQjtBQUMvQixtQkFBYSxNQUFNLFFBQVEsaUJBQWlCLENBQUM7QUFDN0MsMkJBQXFCO0FBQ3JCLFlBQU0sUUFBUSxNQUFNLFlBQVksSUFBSTtBQUVwQyxhQUFPLE1BQU0sTUFBTSxPQUFPLHNCQUFzQjtBQUNoRCxhQUFPLEdBQUcsTUFBTSxvQkFBb0IsSUFBSTtBQUFBLElBQzFDLENBQUM7QUFFRCxTQUFLLG9GQUErRSxZQUFZO0FBQzlGLFlBQU0sT0FBTyxrQkFBa0I7QUFDL0IsbUJBQWEsTUFBTSxRQUFRLGlCQUFpQixDQUFDO0FBRTdDLFlBQU0sTUFBTSxLQUFLLE1BQU0sUUFBUSxjQUFjLE1BQU07QUFDbkQsZ0JBQVUsS0FBSyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ2xDLG9CQUFjLEtBQUssS0FBSyxvQkFBb0IsR0FBRyw2Q0FBNkM7QUFDNUYsMkJBQXFCO0FBQ3JCLFlBQU0sUUFBUSxNQUFNLFlBQVksSUFBSTtBQUVwQyxhQUFPLE1BQU0sTUFBTSxPQUFPLHdCQUF3QiwrQ0FBK0M7QUFBQSxJQUNuRyxDQUFDO0FBRUQsU0FBSyxxRUFBZ0UsWUFBWTtBQUMvRSxZQUFNLE9BQU8sa0JBQWtCO0FBQy9CLG1CQUFhLE1BQU0sUUFBUSxpQkFBaUIsQ0FBQztBQUM3QywrQkFBeUIsTUFBTSxRQUFRLE1BQU07QUFDN0MsMkJBQXFCO0FBQ3JCLFlBQU0sUUFBUSxNQUFNLFlBQVksSUFBSTtBQUVwQyxhQUFPLFNBQVMsTUFBTSxPQUFPLHNCQUFzQjtBQUFBLElBQ3JELENBQUM7QUFBQSxFQUNILENBQUM7QUFNRCxXQUFTLGtDQUFrQyxNQUFNO0FBQy9DLFNBQUssZ0ZBQTJFLFlBQVk7QUFDMUYsWUFBTSxPQUFPLGtCQUFrQjtBQUMvQixtQkFBYSxNQUFNLFFBQVEsaUJBQWlCLENBQUM7QUFDN0MsK0JBQXlCLE1BQU0sUUFBUSxNQUFNO0FBQzdDLDJCQUFxQjtBQUNyQixZQUFNLFFBQVEsTUFBTSxZQUFZLElBQUk7QUFFcEMsYUFBTyxNQUFNLE1BQU0sT0FBTyxzQkFBc0I7QUFDaEQsYUFBTyxHQUFHLE1BQU0sb0JBQW9CLElBQUk7QUFBQSxJQUMxQyxDQUFDO0FBRUQsU0FBSyx3RkFBbUYsWUFBWTtBQUNsRyxZQUFNLE9BQU8sa0JBQWtCO0FBQy9CLG1CQUFhLE1BQU0sUUFBUSxpQkFBaUIsQ0FBQztBQUM3QywrQkFBeUIsTUFBTSxRQUFRLE1BQU07QUFDN0MsNEJBQXNCLE1BQU0sTUFBTTtBQUNsQywyQkFBcUI7QUFDckIsWUFBTSxRQUFRLE1BQU0sWUFBWSxJQUFJO0FBRXBDLGFBQU8sU0FBUyxNQUFNLE9BQU8sd0JBQXdCLG9DQUFvQztBQUN6RixhQUFPLE1BQU0sTUFBTSxPQUFPLFVBQVU7QUFBQSxJQUN0QyxDQUFDO0FBRUQsU0FBSyw2REFBNkQsWUFBWTtBQUM1RSxZQUFNLE9BQU8sa0JBQWtCO0FBQy9CLG1CQUFhLE1BQU0sUUFBUSxpQkFBaUIsQ0FBQztBQUM3QywrQkFBeUIsTUFBTSxRQUFRLE1BQU07QUFDN0MsWUFBTSxNQUFNLEtBQUssTUFBTSxRQUFRLGNBQWMsTUFBTTtBQUNuRCxvQkFBYyxLQUFLLEtBQUssaUJBQWlCLEdBQUc7QUFBQSxRQUMxQztBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLE1BQ0YsRUFBRSxLQUFLLElBQUksQ0FBQztBQUNaLDJCQUFxQjtBQUVyQixZQUFNLFFBQVEsTUFBTSxZQUFZLElBQUk7QUFFcEMsYUFBTyxNQUFNLE1BQU0sT0FBTyxzQkFBc0I7QUFDaEQsYUFBTyxNQUFNLE1BQU0sU0FBUyxDQUFDLEdBQUcsUUFBUSxRQUFRO0FBQ2hELGFBQU8sTUFBTSxNQUFNLHFCQUFxQixJQUFJLEdBQUcsTUFBTTtBQUFBLElBQ3ZELENBQUM7QUFBQSxFQUNILENBQUM7QUFNRCxXQUFTLDhCQUE4QixNQUFNO0FBQzNDLFNBQUssa0ZBQTZFLFlBQVk7QUFDNUYsWUFBTSxPQUFPLGtCQUFrQjtBQUMvQixtQkFBYSxNQUFNLFFBQVEsZ0JBQWdCLENBQUM7QUFFNUMsZ0JBQVUsTUFBTSxRQUFRLE9BQU8sZ0JBQWdCLENBQUM7QUFDaEQsa0NBQTRCLE1BQU0sUUFBUSxPQUFPLEtBQUs7QUFDdEQsMkJBQXFCO0FBQ3JCLFlBQU0sUUFBUSxNQUFNLFlBQVksSUFBSTtBQUVwQyxhQUFPLE1BQU0sTUFBTSxPQUFPLGtCQUFrQjtBQUM1QyxhQUFPLEdBQUcsTUFBTSxTQUFTLFNBQVMsR0FBRyw2QkFBNkI7QUFBQSxJQUNwRSxDQUFDO0FBRUQsU0FBSyw4RUFBeUUsWUFBWTtBQUN4RixZQUFNLE9BQU8sa0JBQWtCO0FBQy9CLG1CQUFhLE1BQU0sUUFBUSxnQkFBZ0IsQ0FBQztBQUM1QyxnQkFBVSxNQUFNLFFBQVEsT0FBTyxhQUFhLENBQUM7QUFDN0MseUJBQW1CLE1BQU0sUUFBUSxLQUFLO0FBQ3RDLDJCQUFxQjtBQUNyQixZQUFNLFFBQVEsTUFBTSxZQUFZLElBQUk7QUFFcEMsYUFBTyxNQUFNLE1BQU0sT0FBTyxrQkFBa0I7QUFBQSxJQUM5QyxDQUFDO0FBRUQsU0FBSywwRkFBcUYsWUFBWTtBQUNwRyxZQUFNLE9BQU8sa0JBQWtCO0FBQy9CLG1CQUFhLE1BQU0sUUFBUSxnQkFBZ0IsQ0FBQztBQUM1QyxnQkFBVSxNQUFNLFFBQVEsT0FBTyxhQUFhLENBQUM7QUFDN0MseUJBQW1CLE1BQU0sUUFBUSxLQUFLO0FBQ3RDLGtCQUFZLE1BQU0sUUFBUSxLQUFLO0FBQy9CLDJCQUFxQjtBQUNyQixZQUFNLFFBQVEsTUFBTSxZQUFZLElBQUk7QUFFcEMsYUFBTyxTQUFTLE1BQU0sT0FBTyxvQkFBb0IsNERBQTREO0FBRTdHLGFBQU8sTUFBTSxNQUFNLE9BQU8sV0FBVztBQUFBLElBQ3ZDLENBQUM7QUFBQSxFQUNILENBQUM7QUFNRCxXQUFTLHNCQUFzQixNQUFNO0FBQ25DLFNBQUssOERBQXlELFlBQVk7QUFDeEUsWUFBTSxPQUFPLGtCQUFrQjtBQUMvQixtQkFBYSxNQUFNLFFBQVEsaUJBQWlCLENBQUM7QUFDN0MsK0JBQXlCLE1BQU0sUUFBUSxNQUFNO0FBQzdDLDRCQUFzQixNQUFNLE1BQU07QUFDbEMsMkJBQXFCO0FBQ3JCLFlBQU0sUUFBUSxNQUFNLFlBQVksSUFBSTtBQUVwQyxhQUFPLE1BQU0sTUFBTSxPQUFPLFVBQVU7QUFDcEMsYUFBTyxNQUFNLE1BQU0sU0FBUyxRQUFRLENBQUM7QUFDckMsYUFBTyxNQUFNLE1BQU0sU0FBUyxDQUFDLEdBQUcsUUFBUSxVQUFVO0FBQUEsSUFDcEQsQ0FBQztBQUVELFNBQUssMkNBQXNDLFlBQVk7QUFDckQsWUFBTSxPQUFPLGtCQUFrQjtBQUUvQixtQkFBYSxNQUFNLFFBQVEsaUJBQWlCLENBQUM7QUFDN0MsK0JBQXlCLE1BQU0sUUFBUSxNQUFNO0FBQzdDLDRCQUFzQixNQUFNLE1BQU07QUFHbEMsbUJBQWEsTUFBTSxRQUFRO0FBQUEsUUFDekI7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsTUFDRixFQUFFLEtBQUssSUFBSSxDQUFDO0FBQ1osK0JBQXlCLE1BQU0sUUFBUSxNQUFNO0FBQzdDLDRCQUFzQixNQUFNLE1BQU07QUFFbEMsMkJBQXFCO0FBQ3JCLFlBQU0sUUFBUSxNQUFNLFlBQVksSUFBSTtBQUVwQyxhQUFPLE1BQU0sTUFBTSxPQUFPLFVBQVU7QUFDcEMsYUFBTyxNQUFNLE1BQU0sU0FBUyxRQUFRLENBQUM7QUFDckMsYUFBTyxHQUFHLE1BQU0sU0FBUyxNQUFNLE9BQUssRUFBRSxXQUFXLFVBQVUsR0FBRyx5Q0FBeUM7QUFBQSxJQUN6RyxDQUFDO0FBQUEsRUFDSCxDQUFDO0FBTUQsV0FBUyxxQ0FBcUMsTUFBTTtBQUNsRCxTQUFLLDRDQUE0QyxZQUFZO0FBQzNELFlBQU0sT0FBTyxrQkFBa0I7QUFDL0IsbUJBQWEsTUFBTSxRQUFRLGdCQUFnQixDQUFDO0FBQzVDLGdCQUFVLE1BQU0sUUFBUSxPQUFPLGFBQWEsQ0FBQztBQUM3QywyQkFBcUI7QUFDckIsWUFBTSxRQUFRLE1BQU0sWUFBWSxJQUFJO0FBQ3BDLGFBQU8sU0FBUyxNQUFNLE9BQU8sUUFBUTtBQUFBLElBQ3ZDLENBQUM7QUFBQSxFQUNILENBQUM7QUFNRCxXQUFTLHFCQUFxQixNQUFNO0FBQ2xDLFNBQUssa0RBQTZDLFlBQVk7QUFDNUQsWUFBTSxPQUFPLGtCQUFrQjtBQUUvQixtQkFBYSxNQUFNLFFBQVE7QUFBQSxRQUN6QjtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxNQUNGLEVBQUUsS0FBSyxJQUFJLENBQUM7QUFDWixtQkFBYSxNQUFNLFFBQVE7QUFBQSxRQUN6QjtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxNQUNGLEVBQUUsS0FBSyxJQUFJLENBQUM7QUFDWiwyQkFBcUI7QUFDckIsWUFBTSxRQUFRLE1BQU0sWUFBWSxJQUFJO0FBRXBDLGFBQU8sTUFBTSxNQUFNLE9BQU8sU0FBUztBQUNuQyxhQUFPLEdBQUcsTUFBTSxTQUFTLFNBQVMsR0FBRyxzQkFBc0I7QUFBQSxJQUM3RCxDQUFDO0FBRUQsU0FBSyxxREFBZ0QsWUFBWTtBQUMvRCxZQUFNLE9BQU8sa0JBQWtCO0FBRS9CLG1CQUFhLE1BQU0sUUFBUTtBQUFBLFFBQ3pCO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLE1BQ0YsRUFBRSxLQUFLLElBQUksQ0FBQztBQUNaLDJCQUFxQjtBQUNyQixZQUFNLFFBQVEsTUFBTSxZQUFZLElBQUk7QUFFcEMsYUFBTyxNQUFNLE1BQU0sT0FBTyxTQUFTO0FBQ25DLGFBQU8sTUFBTSxNQUFNLGFBQWEsSUFBSTtBQUNwQyxhQUFPLEdBQUcsTUFBTSxTQUFTLEtBQUssT0FBSyxFQUFFLFNBQVMsbUJBQW1CLENBQUMsQ0FBQztBQUFBLElBQ3JFLENBQUM7QUFBQSxFQUNILENBQUM7QUFNRCxXQUFTLCtCQUErQixNQUFNO0FBQzVDLFNBQUsscUZBQWdGLFlBQVk7QUFDL0YsWUFBTSxPQUFPLGtCQUFrQjtBQUMvQixZQUFNLFNBQVMsS0FBSyxNQUFNLFFBQVEsUUFBUTtBQUMxQyxtQkFBYSxNQUFNO0FBRW5CLHNCQUFnQixFQUFFLElBQUksUUFBUSxPQUFPLGNBQWMsUUFBUSxTQUFTLENBQUM7QUFDckUsa0JBQVksRUFBRSxJQUFJLE9BQU8sYUFBYSxRQUFRLE9BQU8sY0FBYyxRQUFRLFVBQVUsU0FBUyxDQUFDLEVBQUUsQ0FBQztBQUNsRyxpQkFBVyxFQUFFLElBQUksT0FBTyxTQUFTLE9BQU8sYUFBYSxRQUFRLE9BQU8sYUFBYSxRQUFRLFVBQVUsQ0FBQztBQUNwRyxpQkFBVyxFQUFFLElBQUksT0FBTyxTQUFTLE9BQU8sYUFBYSxRQUFRLE9BQU8sYUFBYSxRQUFRLFVBQVUsQ0FBQztBQUVwRyxtQkFBYSxNQUFNLFFBQVEsZ0JBQWdCLENBQUM7QUFDNUMsZ0JBQVUsTUFBTSxRQUFRLE9BQU8sYUFBYSxDQUFDO0FBSTdDLHVCQUFpQixNQUFNLFFBQVEsT0FBTyxLQUFLO0FBQzNDLHVCQUFpQixNQUFNLFFBQVEsT0FBTyxLQUFLO0FBRTNDLDJCQUFxQjtBQUNyQixZQUFNLFFBQVEsTUFBTSxrQkFBa0IsSUFBSTtBQUUxQyxhQUFPLE1BQU0sTUFBTSxPQUFPLGFBQWEscURBQXFEO0FBQzVGLGFBQU8sTUFBTSxNQUFNLFlBQVksSUFBSSxPQUFPLHNDQUFzQztBQUFBLElBQ2xGLENBQUM7QUFFRCxTQUFLLG1FQUE4RCxZQUFZO0FBQzdFLFlBQU0sT0FBTyxrQkFBa0I7QUFDL0IsbUJBQWEsTUFBTSxRQUFRLDBCQUEwQjtBQUdyRCxtQkFBYSxVQUFVO0FBQ3ZCLFlBQU0sU0FBUyxpQkFBaUI7QUFDaEMsYUFBTyxNQUFNLE9BQU8sUUFBUSxHQUFHLHVCQUF1QjtBQUV0RCwyQkFBcUI7QUFDckIsWUFBTSxRQUFRLE1BQU0sWUFBWSxJQUFJO0FBR3BDLFlBQU0sUUFBUSxpQkFBaUI7QUFDL0IsYUFBTyxNQUFNLE1BQU0sUUFBUSxHQUFHLG1EQUFtRDtBQUNqRixhQUFPLE1BQU0sTUFBTSxpQkFBaUIsTUFBTSxxREFBcUQ7QUFBQSxJQUNqRyxDQUFDO0FBRUQsU0FBSyxzREFBaUQsWUFBWTtBQUNoRSxZQUFNLE9BQU8sa0JBQWtCO0FBRS9CLGdCQUFVLEtBQUssTUFBTSxRQUFRLGNBQWMsTUFBTSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFFdkUsbUJBQWEsTUFBTSxRQUFRLDBCQUEwQjtBQUNyRCwyQkFBcUI7QUFDckIsWUFBTSxRQUFRLE1BQU0sWUFBWSxJQUFJO0FBR3BDLFlBQU0sT0FBTyxNQUFNLFNBQVMsS0FBSyxPQUFLLEVBQUUsT0FBTyxNQUFNO0FBQ3JELGFBQU8sTUFBTSxNQUFNLFFBQVcsK0NBQStDO0FBRTdFLFlBQU0sT0FBTyxNQUFNLFNBQVMsS0FBSyxPQUFLLEVBQUUsT0FBTyxNQUFNO0FBQ3JELGFBQU8sR0FBRyxTQUFTLFFBQVcsMENBQTBDO0FBQUEsSUFDMUUsQ0FBQztBQUVELFNBQUssb0NBQW9DLE1BQU07QUFDN0MsWUFBTSxPQUFPLGtCQUFrQjtBQUUvQixnQkFBVSxLQUFLLE1BQU0sUUFBUSxjQUFjLE1BQU0sR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3ZFLHFCQUFlO0FBQ2YsYUFBTyxNQUFNLGlCQUFpQixNQUFNLE1BQU0sR0FBRyxNQUFNLG9CQUFvQjtBQUd2RSxtQkFBYSxNQUFNLFFBQVEsb0JBQW9CO0FBQy9DLHFCQUFlO0FBQ2YsYUFBTyxNQUFNLGlCQUFpQixNQUFNLE1BQU0sR0FBRyxPQUFPLCtCQUErQjtBQUFBLElBQ3JGLENBQUM7QUFBQSxFQUNILENBQUM7QUFNRCxXQUFTLHNDQUFzQyxNQUFNO0FBQ25ELFNBQUssd0RBQXdELFlBQVk7QUFDdkUsWUFBTSxPQUFPLGtCQUFrQjtBQUMvQixZQUFNLFNBQVMsS0FBSyxNQUFNLFFBQVEsUUFBUTtBQUMxQyxtQkFBYSxNQUFNO0FBRW5CLHNCQUFnQixFQUFFLElBQUksUUFBUSxPQUFPLGNBQWMsUUFBUSxTQUFTLENBQUM7QUFDckUsa0JBQVksRUFBRSxJQUFJLE9BQU8sYUFBYSxRQUFRLE9BQU8sY0FBYyxRQUFRLFVBQVUsU0FBUyxDQUFDLEVBQUUsQ0FBQztBQUNsRyxpQkFBVyxFQUFFLElBQUksT0FBTyxTQUFTLE9BQU8sYUFBYSxRQUFRLE9BQU8sY0FBYyxRQUFRLFVBQVUsQ0FBQztBQUNyRyxpQkFBVyxFQUFFLElBQUksT0FBTyxTQUFTLE9BQU8sYUFBYSxRQUFRLE9BQU8sZUFBZSxRQUFRLFVBQVUsQ0FBQztBQUV0RyxtQkFBYSxNQUFNLFFBQVEsZ0JBQWdCLENBQUM7QUFDNUMsZ0JBQVUsTUFBTSxRQUFRLE9BQU8sYUFBYSxDQUFDO0FBRTdDLDJCQUFxQjtBQUNyQixZQUFNLFVBQVUsTUFBTSxrQkFBa0IsSUFBSTtBQUU1QyxvQkFBYztBQUVkLDJCQUFxQjtBQUNyQixZQUFNLFVBQVUsTUFBTSxZQUFZLElBQUk7QUFFdEMsYUFBTyxNQUFNLFFBQVEsT0FBTyxhQUFhLGtDQUFrQztBQUMzRSxhQUFPLE1BQU0sUUFBUSxPQUFPLGFBQWEsMENBQTBDO0FBQ25GLGFBQU8sTUFBTSxRQUFRLFlBQVksSUFBSSxRQUFRLFlBQVksSUFBSSwwQkFBMEI7QUFBQSxJQUN6RixDQUFDO0FBRUQsU0FBSywwREFBMEQsWUFBWTtBQUN6RSxZQUFNLE9BQU8sa0JBQWtCO0FBQy9CLFlBQU0sU0FBUyxLQUFLLE1BQU0sUUFBUSxRQUFRO0FBQzFDLG1CQUFhLE1BQU07QUFFbkIsc0JBQWdCLEVBQUUsSUFBSSxRQUFRLE9BQU8sY0FBYyxRQUFRLFNBQVMsQ0FBQztBQUNyRSxrQkFBWSxFQUFFLElBQUksT0FBTyxhQUFhLFFBQVEsT0FBTyxjQUFjLFFBQVEsVUFBVSxTQUFTLENBQUMsRUFBRSxDQUFDO0FBQ2xHLGlCQUFXLEVBQUUsSUFBSSxPQUFPLFNBQVMsT0FBTyxhQUFhLFFBQVEsT0FBTyxjQUFjLFFBQVEsV0FBVyxDQUFDO0FBQ3RHLGlCQUFXLEVBQUUsSUFBSSxPQUFPLFNBQVMsT0FBTyxhQUFhLFFBQVEsT0FBTyxlQUFlLFFBQVEsV0FBVyxDQUFDO0FBRXZHLG1CQUFhLE1BQU0sUUFBUSxnQkFBZ0IsQ0FBQztBQUM1QyxnQkFBVSxNQUFNLFFBQVEsT0FBTyxZQUFZLENBQUM7QUFFNUMsMkJBQXFCO0FBQ3JCLFlBQU0sVUFBVSxNQUFNLGtCQUFrQixJQUFJO0FBRTVDLG9CQUFjO0FBRWQsMkJBQXFCO0FBQ3JCLFlBQU0sVUFBVSxNQUFNLFlBQVksSUFBSTtBQUV0QyxhQUFPLE1BQU0sUUFBUSxPQUFPLGVBQWUsb0NBQW9DO0FBQy9FLGFBQU8sTUFBTSxRQUFRLE9BQU8sZUFBZSw0Q0FBNEM7QUFBQSxJQUN6RixDQUFDO0FBQUEsRUFDSCxDQUFDO0FBTUQsV0FBUyxjQUFjLE1BQU07QUFDM0IsU0FBSywyQ0FBMkMsTUFBTTtBQUNwRCxhQUFPLE1BQU0scUJBQXFCLDJCQUEyQixHQUFHLE1BQU0sa0JBQWtCO0FBQ3hGLGFBQU8sTUFBTSxxQkFBcUIsMkJBQTJCLEdBQUcsTUFBTSxrQkFBa0I7QUFDeEYsYUFBTyxNQUFNLHFCQUFxQix3Q0FBd0MsR0FBRyxNQUFNLCtCQUErQjtBQUNsSCxhQUFPLE1BQU0scUJBQXFCLHNDQUFzQyxHQUFHLE1BQU0sNkJBQTZCO0FBQUEsSUFDaEgsQ0FBQztBQUVELFNBQUssOENBQThDLE1BQU07QUFDdkQsYUFBTyxNQUFNLHFCQUFxQix1QkFBdUIsR0FBRyxPQUFPLGdDQUFnQztBQUNuRyxhQUFPLE1BQU0scUJBQXFCLEVBQUUsR0FBRyxPQUFPLDhCQUE4QjtBQUM1RSxhQUFPLE1BQU0scUJBQXFCLFlBQVksR0FBRyxPQUFPLG1DQUFtQztBQUFBLElBQzdGLENBQUM7QUFFRCxTQUFLLDJCQUEyQixNQUFNO0FBQ3BDLGFBQU8sTUFBTSxlQUFlLFVBQVUsR0FBRyxJQUFJO0FBQzdDLGFBQU8sTUFBTSxlQUFlLE1BQU0sR0FBRyxJQUFJO0FBQ3pDLGFBQU8sTUFBTSxlQUFlLFNBQVMsR0FBRyxLQUFLO0FBQzdDLGFBQU8sTUFBTSxlQUFlLGFBQWEsR0FBRyxLQUFLO0FBQ2pELGFBQU8sTUFBTSxlQUFlLFNBQVMsR0FBRyxLQUFLO0FBQzdDLGFBQU8sTUFBTSxlQUFlLFFBQVEsR0FBRyxLQUFLO0FBQzVDLGFBQU8sTUFBTSxlQUFlLEVBQUUsR0FBRyxLQUFLO0FBQUEsSUFDeEMsQ0FBQztBQUVELFNBQUssa0ZBQTZFLFlBQVk7QUFDNUYsWUFBTSxPQUFPLGtCQUFrQjtBQUUvQixtQkFBYSxNQUFNLFFBQVEsaUJBQWlCLENBQUM7QUFDN0MsK0JBQXlCLE1BQU0sUUFBUSxNQUFNO0FBQzdDLDRCQUFzQixNQUFNLE1BQU07QUFHbEMsbUJBQWEsTUFBTSxRQUFRLDZDQUE2QztBQUN4RSxtQkFBYSxNQUFNLFFBQVE7QUFBQSxRQUN6QjtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxNQUNGLEVBQUUsS0FBSyxJQUFJLENBQUM7QUFFWiwyQkFBcUI7QUFDckIsWUFBTSxRQUFRLE1BQU0sWUFBWSxJQUFJO0FBRXBDLGFBQU8sTUFBTSxNQUFNLGlCQUFpQixJQUFJLFFBQVEsaUNBQWlDO0FBQ2pGLGFBQU8sU0FBUyxNQUFNLE9BQU8sWUFBWSw2Q0FBNkM7QUFFdEYsWUFBTSxPQUFPLE1BQU0sU0FBUyxLQUFLLE9BQUssRUFBRSxPQUFPLE1BQU07QUFDckQsYUFBTyxHQUFHLFNBQVMsUUFBVyw0QkFBNEI7QUFDMUQsYUFBTyxNQUFNLE1BQU0sUUFBUSxZQUFZLHlCQUF5QjtBQUVoRSxZQUFNLE9BQU8sTUFBTSxTQUFTLEtBQUssT0FBSyxFQUFFLE9BQU8sTUFBTTtBQUNyRCxhQUFPLEdBQUcsU0FBUyxRQUFXLDRCQUE0QjtBQUMxRCxhQUFPLE1BQU0sTUFBTSxRQUFRLFVBQVUsdUJBQXVCO0FBQUEsSUFDOUQsQ0FBQztBQUFBLEVBQ0gsQ0FBQztBQU1ELFdBQVMsK0RBQStELE1BQU07QUFDNUUsU0FBSyxtRUFBOEQsWUFBWTtBQUM3RSxZQUFNLE9BQU8sa0JBQWtCO0FBQy9CLFlBQU0sU0FBUyxLQUFLLE1BQU0sUUFBUSxRQUFRO0FBQzFDLG1CQUFhLE1BQU07QUFFbkIsc0JBQWdCLEVBQUUsSUFBSSxRQUFRLE9BQU8sY0FBYyxRQUFRLFNBQVMsQ0FBQztBQUNyRSxrQkFBWSxFQUFFLElBQUksT0FBTyxhQUFhLFFBQVEsT0FBTyxjQUFjLFFBQVEsVUFBVSxTQUFTLENBQUMsRUFBRSxDQUFDO0FBR2xHLG1CQUFhLE1BQU0sUUFBUSxnQkFBZ0IsQ0FBQztBQUM1QyxnQkFBVSxNQUFNLFFBQVEsT0FBTyxhQUFhLENBQUM7QUFFN0MsMkJBQXFCO0FBQ3JCLFlBQU0sUUFBUSxNQUFNLGtCQUFrQixJQUFJO0FBRTFDLGFBQU87QUFBQSxRQUFNLE1BQU07QUFBQSxRQUFPO0FBQUEsUUFDeEI7QUFBQSxNQUF1RTtBQUFBLElBQzNFLENBQUM7QUFBQSxFQUNILENBQUM7QUFFRCxXQUFTLDJDQUEyQyxNQUFNO0FBQ3hELFNBQUsseUZBQW9GLFlBQVk7QUFDbkcsWUFBTSxPQUFPLGtCQUFrQjtBQUMvQixZQUFNLFNBQVMsS0FBSyxNQUFNLFFBQVEsUUFBUTtBQUMxQyxtQkFBYSxNQUFNO0FBRW5CLHNCQUFnQixFQUFFLElBQUksUUFBUSxPQUFPLGNBQWMsUUFBUSxTQUFTLENBQUM7QUFDckUsa0JBQVksRUFBRSxJQUFJLE9BQU8sYUFBYSxRQUFRLE9BQU8sY0FBYyxRQUFRLFVBQVUsU0FBUyxDQUFDLEVBQUUsQ0FBQztBQUNsRyxpQkFBVyxFQUFFLElBQUksT0FBTyxTQUFTLE9BQU8sYUFBYSxRQUFRLE9BQU8sYUFBYSxRQUFRLFVBQVUsQ0FBQztBQUNwRyxpQkFBVyxFQUFFLElBQUksT0FBTyxTQUFTLE9BQU8sYUFBYSxRQUFRLE9BQU8sYUFBYSxRQUFRLFVBQVUsQ0FBQztBQUVwRyxtQkFBYSxNQUFNLFFBQVEsZ0JBQWdCLENBQUM7QUFDNUMsZ0JBQVUsTUFBTSxRQUFRLE9BQU8sYUFBYSxDQUFDO0FBRTdDLHVCQUFpQixNQUFNLFFBQVEsT0FBTyxLQUFLO0FBRTNDLDJCQUFxQjtBQUNyQixZQUFNLFFBQVEsTUFBTSxrQkFBa0IsSUFBSTtBQUUxQyxhQUFPLE1BQU0sTUFBTSxPQUFPLFdBQVc7QUFDckMsYUFBTyxNQUFNLE1BQU0sWUFBWSxJQUFJLE9BQU8sb0RBQW9EO0FBQUEsSUFDaEcsQ0FBQztBQUFBLEVBQ0gsQ0FBQztBQUVELFdBQVMseUJBQXlCLE1BQU07QUFDdEMsU0FBSyx1RUFBdUUsWUFBWTtBQUN0RixZQUFNLE9BQU8sa0JBQWtCO0FBQy9CLG1CQUFhLE1BQU0sUUFBUSxnQkFBZ0IsQ0FBQztBQUM1QyxnQkFBVSxNQUFNLFFBQVEsT0FBTyxhQUFhLENBQUM7QUFFN0MsWUFBTSxXQUFXLEtBQUssTUFBTSxRQUFRLGNBQWMsUUFBUSxVQUFVLE9BQU8sT0FBTztBQUNsRixnQkFBVSxVQUFVLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDdkMsb0JBQWMsS0FBSyxVQUFVLGdCQUFnQixHQUFHLEVBQUU7QUFFbEQsMkJBQXFCO0FBQ3JCLHFCQUFlO0FBQ2YsWUFBTSxRQUFRLE1BQU0sWUFBWSxJQUFJO0FBS3BDLGFBQU87QUFBQSxRQUFNLE1BQU07QUFBQSxRQUFPO0FBQUEsUUFDeEI7QUFBQSxNQUFzRTtBQUN4RSxhQUFPLE1BQU0sTUFBTSxZQUFZLElBQUksS0FBSztBQUFBLElBQzFDLENBQUM7QUFFRCxTQUFLLCtEQUEwRCxZQUFZO0FBQ3pFLFlBQU0sT0FBTyxrQkFBa0I7QUFDL0IsbUJBQWEsTUFBTSxRQUFRLGlCQUFpQixDQUFDO0FBQzdDLFlBQU0sTUFBTSxLQUFLLE1BQU0sUUFBUSxjQUFjLE1BQU07QUFDbkQsZ0JBQVUsS0FBSyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ2xDLG9CQUFjLEtBQUssS0FBSyxvQkFBb0IsR0FBRyxFQUFFO0FBRWpELDJCQUFxQjtBQUNyQixZQUFNLFFBQVEsTUFBTSxZQUFZLElBQUk7QUFFcEMsYUFBTztBQUFBLFFBQU0sTUFBTTtBQUFBLFFBQU87QUFBQSxRQUN4QjtBQUFBLE1BQXFEO0FBQUEsSUFDekQsQ0FBQztBQUVELFNBQUssMENBQXFDLFlBQVk7QUFDcEQsWUFBTSxPQUFPLGtCQUFrQjtBQUMvQixtQkFBYSxNQUFNLFFBQVEsZ0JBQWdCLENBQUM7QUFDNUMsWUFBTSxNQUFNLEtBQUssTUFBTSxRQUFRLGNBQWMsUUFBUSxVQUFVLEtBQUs7QUFDcEUsZ0JBQVUsS0FBSyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ2xDLG9CQUFjLEtBQUssS0FBSyxhQUFhLEdBQUcsRUFBRTtBQUUxQywyQkFBcUI7QUFDckIsWUFBTSxRQUFRLE1BQU0sWUFBWSxJQUFJO0FBRXBDLGFBQU8sTUFBTSxNQUFNLE9BQU8sWUFBWSxxQ0FBcUM7QUFBQSxJQUM3RSxDQUFDO0FBQUEsRUFDSCxDQUFDO0FBRUQsV0FBUyxxQ0FBcUMsTUFBTTtBQUNsRCxTQUFLLCtFQUEwRSxZQUFZO0FBQ3pGLFlBQU0sT0FBTyxrQkFBa0I7QUFDL0IsWUFBTSxTQUFTLEtBQUssTUFBTSxRQUFRLFFBQVE7QUFDMUMsbUJBQWEsTUFBTTtBQUVuQixzQkFBZ0IsRUFBRSxJQUFJLFFBQVEsT0FBTyxjQUFjLFFBQVEsU0FBUyxDQUFDO0FBQ3JFLGtCQUFZLEVBQUUsSUFBSSxPQUFPLGFBQWEsUUFBUSxPQUFPLGNBQWMsUUFBUSxZQUFZLFNBQVMsQ0FBQyxFQUFFLENBQUM7QUFFcEcsbUJBQWEsTUFBTSxRQUFRLGlCQUFpQixDQUFDO0FBRTdDLDJCQUFxQjtBQUNyQixZQUFNLFFBQVEsTUFBTSxrQkFBa0IsSUFBSTtBQUUxQyxhQUFPO0FBQUEsUUFBTSxNQUFNO0FBQUEsUUFBTztBQUFBLFFBQ3hCO0FBQUEsTUFBdUQ7QUFBQSxJQUMzRCxDQUFDO0FBRUQsU0FBSywrRUFBMEUsWUFBWTtBQUN6RixZQUFNLE9BQU8sa0JBQWtCO0FBQy9CLFlBQU0sU0FBUyxLQUFLLE1BQU0sUUFBUSxRQUFRO0FBQzFDLG1CQUFhLE1BQU07QUFFbkIsc0JBQWdCLEVBQUUsSUFBSSxRQUFRLE9BQU8sY0FBYyxRQUFRLFNBQVMsQ0FBQztBQUNyRSxrQkFBWSxFQUFFLElBQUksT0FBTyxhQUFhLFFBQVEsT0FBTyxjQUFjLFFBQVEsVUFBVSxTQUFTLENBQUMsRUFBRSxDQUFDO0FBQ2xHLGlCQUFXLEVBQUUsSUFBSSxPQUFPLFNBQVMsT0FBTyxhQUFhLFFBQVEsT0FBTyxhQUFhLFFBQVEsV0FBVyxDQUFDO0FBQ3JHLGlCQUFXLEVBQUUsSUFBSSxPQUFPLFNBQVMsT0FBTyxhQUFhLFFBQVEsT0FBTyxhQUFhLFFBQVEsVUFBVSxDQUFDO0FBRXBHLG1CQUFhLE1BQU0sUUFBUSxnQkFBZ0IsQ0FBQztBQUM1QyxnQkFBVSxNQUFNLFFBQVEsT0FBTyxhQUFhLENBQUM7QUFFN0MsMkJBQXFCO0FBQ3JCLFlBQU0sUUFBUSxNQUFNLGtCQUFrQixJQUFJO0FBRTFDLGFBQU8sTUFBTSxNQUFNLE9BQU8sV0FBVztBQUNyQyxhQUFPLE1BQU0sTUFBTSxZQUFZLElBQUksS0FBSztBQUFBLElBQzFDLENBQUM7QUFFRCxTQUFLLG1FQUE4RCxZQUFZO0FBQzdFLFlBQU0sT0FBTyxrQkFBa0I7QUFDL0IsWUFBTSxTQUFTLEtBQUssTUFBTSxRQUFRLFFBQVE7QUFDMUMsbUJBQWEsTUFBTTtBQUVuQixzQkFBZ0IsRUFBRSxJQUFJLFFBQVEsT0FBTyxjQUFjLFFBQVEsU0FBUyxDQUFDO0FBRXJFLDJCQUFxQjtBQUNyQixZQUFNLFFBQVEsTUFBTSxrQkFBa0IsSUFBSTtBQUUxQyxhQUFPLEdBQUcsTUFBTSxVQUFVLFFBQVcsOEJBQThCO0FBQUEsSUFDckUsQ0FBQztBQUFBLEVBQ0gsQ0FBQztBQUVELFdBQVMsZ0NBQWdDLE1BQU07QUFDN0MsU0FBSyxpRUFBNEQsWUFBWTtBQUMzRSxZQUFNLE9BQU8sa0JBQWtCO0FBQy9CLG1CQUFhLE1BQU0sUUFBUSxpQkFBaUIsQ0FBQztBQUM3QyxZQUFNLE1BQU0sS0FBSyxNQUFNLFFBQVEsY0FBYyxNQUFNO0FBQ25ELGdCQUFVLEtBQUssRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNsQyxvQkFBYyxLQUFLLEtBQUssb0JBQW9CLEdBQUc7QUFBQSxRQUM3QztBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxNQUNGLEVBQUUsS0FBSyxJQUFJLENBQUM7QUFFWiwyQkFBcUI7QUFDckIsWUFBTSxRQUFRLE1BQU0sWUFBWSxJQUFJO0FBRXBDLGFBQU87QUFBQSxRQUFNLE1BQU07QUFBQSxRQUFPO0FBQUEsUUFDeEI7QUFBQSxNQUErRDtBQUFBLElBQ25FLENBQUM7QUFFRCxTQUFLLDhEQUF5RCxZQUFZO0FBQ3hFLFlBQU0sT0FBTyxrQkFBa0I7QUFDL0IsbUJBQWEsTUFBTSxRQUFRO0FBQUEsUUFDekI7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsTUFDRixFQUFFLEtBQUssSUFBSSxDQUFDO0FBQ1osbUJBQWEsTUFBTSxRQUFRLGdCQUFnQixDQUFDO0FBRTVDLDJCQUFxQjtBQUNyQixZQUFNLFFBQVEsTUFBTSxZQUFZLElBQUk7QUFFcEMsYUFBTyxHQUFHLE1BQU0sVUFBVSxRQUFXLHdDQUF3QztBQUU3RSxhQUFPO0FBQUEsUUFBUyxNQUFNO0FBQUEsUUFBTztBQUFBLFFBQzNCO0FBQUEsTUFBaUQ7QUFBQSxJQUNyRCxDQUFDO0FBQUEsRUFDSCxDQUFDO0FBRUQsV0FBUywrQ0FBK0MsTUFBTTtBQUM1RCxTQUFLLGdFQUEyRCxZQUFZO0FBQzFFLFlBQU0sT0FBTyxrQkFBa0I7QUFDL0IsWUFBTSxTQUFTLEtBQUssTUFBTSxRQUFRLFFBQVE7QUFDMUMsbUJBQWEsTUFBTTtBQUVuQixzQkFBZ0IsRUFBRSxJQUFJLFFBQVEsT0FBTyxjQUFjLFFBQVEsU0FBUyxDQUFDO0FBQ3JFLGtCQUFZLEVBQUUsSUFBSSxPQUFPLGFBQWEsUUFBUSxPQUFPLGNBQWMsUUFBUSxVQUFVLFNBQVMsQ0FBQyxFQUFFLENBQUM7QUFDbEcsaUJBQVcsRUFBRSxJQUFJLE9BQU8sU0FBUyxPQUFPLGFBQWEsUUFBUSxPQUFPLGFBQWEsUUFBUSxVQUFVLENBQUM7QUFFcEcsbUJBQWEsTUFBTSxRQUFRLGdCQUFnQixDQUFDO0FBQzVDLFlBQU0sTUFBTSxLQUFLLE1BQU0sUUFBUSxjQUFjLFFBQVEsVUFBVSxLQUFLO0FBQ3BFLGdCQUFVLEtBQUssS0FBSyxPQUFPLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNqRCxvQkFBYyxLQUFLLEtBQUssYUFBYSxHQUFHLGFBQWEsQ0FBQztBQUd0RCwyQkFBcUI7QUFDckIsWUFBTSxRQUFRLE1BQU0sa0JBQWtCLElBQUk7QUFFMUMsYUFBTztBQUFBLFFBQU0sTUFBTTtBQUFBLFFBQU87QUFBQSxRQUN4QjtBQUFBLE1BQXdFO0FBQUEsSUFDNUUsQ0FBQztBQUFBLEVBQ0gsQ0FBQztBQUVELFdBQVMsNkJBQTZCLE1BQU07QUFDMUMsU0FBSyxtRUFBOEQsWUFBWTtBQUM3RSxZQUFNLE9BQU8sa0JBQWtCO0FBQy9CLG1CQUFhLE1BQU0sUUFBUSxnQkFBZ0IsQ0FBQztBQUU1QywyQkFBcUI7QUFDckIscUJBQWU7QUFDZixZQUFNLFNBQVMsTUFBTSxZQUFZLElBQUk7QUFDckMsYUFBTyxNQUFNLE9BQU8sT0FBTyxVQUFVO0FBR3JDLGdCQUFVLE1BQU0sUUFBUSxPQUFPLGFBQWEsQ0FBQztBQUc3QywyQkFBcUI7QUFDckIscUJBQWU7QUFDZixZQUFNLFNBQVMsTUFBTSxZQUFZLElBQUk7QUFFckMsYUFBTztBQUFBLFFBQU0sT0FBTztBQUFBLFFBQU87QUFBQSxRQUN6QjtBQUFBLE1BQWlEO0FBQUEsSUFDckQsQ0FBQztBQUFBLEVBQ0gsQ0FBQztBQUVELFdBQVMseUNBQXlDLE1BQU07QUFDdEQsU0FBSyxnRkFBMkUsWUFBWTtBQUMxRixZQUFNLE9BQU8sa0JBQWtCO0FBQy9CLG1CQUFhLE1BQU0sUUFBUSxnQkFBZ0IsQ0FBQztBQUU1QyxnQkFBVSxNQUFNLFFBQVEsT0FBTyxnQkFBZ0IsQ0FBQztBQUVoRCxrQ0FBNEIsTUFBTSxRQUFRLE9BQU8sS0FBSztBQUV0RCwyQkFBcUI7QUFDckIscUJBQWU7QUFDZixZQUFNLFFBQVEsTUFBTSxZQUFZLElBQUk7QUFFcEMsYUFBTztBQUFBLFFBQU0sTUFBTTtBQUFBLFFBQU87QUFBQSxRQUN4QjtBQUFBLE1BQXFFO0FBQUEsSUFDekUsQ0FBQztBQUFBLEVBQ0gsQ0FBQztBQU1ELFdBQVMsc0RBQXNELE1BQU07QUFDbkUsU0FBSywrRUFBMEUsWUFBWTtBQUN6RixZQUFNLE9BQU8sa0JBQWtCO0FBQy9CLG1CQUFhLE1BQU0sUUFBUSw4QkFBb0M7QUFDL0QsMkJBQXFCO0FBQ3JCLHFCQUFlO0FBQ2YsWUFBTSxRQUFRLE1BQU0sWUFBWSxJQUFJO0FBR3BDLGFBQU8sTUFBTSxNQUFNLE9BQU8sY0FBYztBQUN4QyxhQUFPLEdBQUcsTUFBTSxvQkFBb0IsSUFBSTtBQUFBLElBQzFDLENBQUM7QUFBQSxFQUNILENBQUM7QUFFRCxXQUFTLHVEQUF1RCxNQUFNO0FBQ3BFLFNBQUsscUVBQWdFLFlBQVk7QUFDL0UsWUFBTSxPQUFPLGtCQUFrQjtBQUMvQixZQUFNLE1BQU0sS0FBSyxNQUFNLFFBQVEsY0FBYyxNQUFNO0FBQ25ELGdCQUFVLEtBQUssRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNsQyxvQkFBYyxLQUFLLEtBQUssdUJBQXVCLEdBQUcsRUFBRTtBQUNwRCwyQkFBcUI7QUFDckIscUJBQWU7QUFDZixZQUFNLFFBQVEsTUFBTSxZQUFZLElBQUk7QUFHcEMsYUFBTztBQUFBLFFBQU0sTUFBTTtBQUFBLFFBQU87QUFBQSxRQUN4QjtBQUFBLE1BQW9EO0FBQUEsSUFDeEQsQ0FBQztBQUFBLEVBQ0gsQ0FBQztBQUVELFdBQVMsMERBQTBELE1BQU07QUFDdkUsU0FBSyxvRUFBK0QsWUFBWTtBQUM5RSxZQUFNLE9BQU8sa0JBQWtCO0FBQy9CLG1CQUFhLE1BQU0sUUFBUSx1REFBdUQ7QUFDbEYsMkJBQXFCO0FBQ3JCLHFCQUFlO0FBQ2YsWUFBTSxRQUFRLE1BQU0sWUFBWSxJQUFJO0FBR3BDLGFBQU87QUFBQSxRQUFNLE1BQU07QUFBQSxRQUFPO0FBQUEsUUFDeEI7QUFBQSxNQUFnRTtBQUFBLElBQ3BFLENBQUM7QUFFRCxTQUFLLGlFQUE0RCxZQUFZO0FBQzNFLFlBQU0sT0FBTyxrQkFBa0I7QUFDL0IsbUJBQWEsTUFBTSxRQUFRO0FBQUEsUUFDekI7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsTUFDRixFQUFFLEtBQUssSUFBSSxDQUFDO0FBQ1osMkJBQXFCO0FBQ3JCLHFCQUFlO0FBQ2YsWUFBTSxRQUFRLE1BQU0sWUFBWSxJQUFJO0FBR3BDLGFBQU87QUFBQSxRQUFNLE1BQU07QUFBQSxRQUFPO0FBQUEsUUFDeEI7QUFBQSxNQUFrRDtBQUFBLElBQ3RELENBQUM7QUFBQSxFQUNILENBQUM7QUFFRCxXQUFTLDZDQUE2QyxNQUFNO0FBQzFELFNBQUssOEVBQW9FLFlBQVk7QUFDbkYsWUFBTSxPQUFPLGtCQUFrQjtBQUMvQixtQkFBYSxNQUFNLFFBQVEsZ0JBQWdCLENBQUM7QUFDNUMsWUFBTSxNQUFNLEtBQUssTUFBTSxRQUFRLGNBQWMsUUFBUSxVQUFVLEtBQUs7QUFDcEUsZ0JBQVUsS0FBSyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ2xDLG9CQUFjLEtBQUssS0FBSyxhQUFhLEdBQUc7QUFBQSxRQUN0QztBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsTUFDRixFQUFFLEtBQUssSUFBSSxDQUFDO0FBQ1osMkJBQXFCO0FBQ3JCLHFCQUFlO0FBQ2YsWUFBTSxRQUFRLE1BQU0sWUFBWSxJQUFJO0FBRXBDLGFBQU87QUFBQSxRQUFNLE1BQU07QUFBQSxRQUFPO0FBQUEsUUFDeEI7QUFBQSxNQUFxRDtBQUFBLElBQ3pELENBQUM7QUFBQSxFQUNILENBQUM7QUFFRCxXQUFTLGlEQUFpRCxNQUFNO0FBQzlELFNBQUssa0VBQTZELFlBQVk7QUFDNUUsWUFBTSxPQUFPLGtCQUFrQjtBQUMvQixtQkFBYSxNQUFNLFFBQVEsZ0JBQWdCLENBQUM7QUFDNUMsWUFBTSxNQUFNLEtBQUssTUFBTSxRQUFRLGNBQWMsUUFBUSxVQUFVLEtBQUs7QUFDcEUsWUFBTSxXQUFXLEtBQUssS0FBSyxPQUFPO0FBQ2xDLGdCQUFVLFVBQVUsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUN2QyxvQkFBYyxLQUFLLEtBQUssYUFBYSxHQUFHLGFBQWEsQ0FBQztBQUV0RCxvQkFBYyxLQUFLLFVBQVUsYUFBYSxHQUFHLEVBQUU7QUFDL0Msb0JBQWMsS0FBSyxVQUFVLGFBQWEsR0FBRyxFQUFFO0FBQy9DLDJCQUFxQjtBQUNyQixxQkFBZTtBQUNmLFlBQU0sUUFBUSxNQUFNLFlBQVksSUFBSTtBQUlwQyxhQUFPO0FBQUEsUUFBTSxNQUFNO0FBQUEsUUFBTztBQUFBLFFBQ3hCO0FBQUEsTUFBdUQ7QUFBQSxJQUMzRCxDQUFDO0FBQUEsRUFDSCxDQUFDO0FBRUQsV0FBUyw2REFBNkQsTUFBTTtBQUMxRSxTQUFLLG1FQUE4RCxZQUFZO0FBQzdFLFlBQU0sT0FBTyxrQkFBa0I7QUFDL0IsWUFBTSxTQUFTLEtBQUssTUFBTSxRQUFRLFFBQVE7QUFDMUMsbUJBQWEsTUFBTTtBQUVuQixzQkFBZ0IsRUFBRSxJQUFJLFFBQVEsT0FBTyxjQUFjLFFBQVEsU0FBUyxDQUFDO0FBQ3JFLGtCQUFZLEVBQUUsSUFBSSxPQUFPLGFBQWEsUUFBUSxPQUFPLGNBQWMsUUFBUSxVQUFVLFNBQVMsQ0FBQyxFQUFFLENBQUM7QUFDbEcsaUJBQVcsRUFBRSxJQUFJLE9BQU8sU0FBUyxPQUFPLGFBQWEsUUFBUSxPQUFPLGFBQWEsUUFBUSxVQUFVLENBQUM7QUFHcEcsdUJBQWlCLFFBQVEsT0FBTyxPQUFPLFVBQVU7QUFFakQsbUJBQWEsTUFBTSxRQUFRLGdCQUFnQixDQUFDO0FBQzVDLGdCQUFVLE1BQU0sUUFBUSxPQUFPLGFBQWEsQ0FBQztBQUU3QywyQkFBcUI7QUFDckIsWUFBTSxRQUFRLE1BQU0sa0JBQWtCLElBQUk7QUFHMUMsYUFBTyxNQUFNLE1BQU0sT0FBTyxXQUFXO0FBQ3JDLGFBQU87QUFBQSxRQUFNLE1BQU0sWUFBWTtBQUFBLFFBQUk7QUFBQSxRQUNqQztBQUFBLE1BQXlEO0FBQUEsSUFDN0QsQ0FBQztBQUFBLEVBQ0gsQ0FBQztBQUVELFdBQVMsb0VBQW9FLE1BQU07QUFDakYsU0FBSyxrRUFBNkQsWUFBWTtBQUM1RSxZQUFNLE9BQU8sa0JBQWtCO0FBQy9CLG1CQUFhLE1BQU0sUUFBUSxnQkFBZ0IsQ0FBQztBQUM1QyxnQkFBVSxNQUFNLFFBQVEsT0FBTyxZQUFZLENBQUM7QUFFNUMsMkJBQXFCO0FBQ3JCLHFCQUFlO0FBQ2YsWUFBTSxRQUFRLE1BQU0sWUFBWSxJQUFJO0FBRXBDLGFBQU8sTUFBTSxNQUFNLE9BQU8sYUFBYTtBQUV2QywyQkFBcUI7QUFDckIsWUFBTSxTQUFTLE1BQU0sWUFBWSxJQUFJO0FBQ3JDLGFBQU8sTUFBTSxPQUFPLE9BQU8sZUFBZSw0Q0FBNEM7QUFBQSxJQUN4RixDQUFDO0FBQUEsRUFDSCxDQUFDO0FBRUQsV0FBUyw2REFBNkQsTUFBTTtBQUMxRSxTQUFLLHdFQUFtRSxZQUFZO0FBQ2xGLFlBQU0sT0FBTyxrQkFBa0I7QUFDL0IsbUJBQWEsTUFBTSxRQUFRLGlCQUFpQixDQUFDO0FBRTdDLDJCQUFxQjtBQUNyQixxQkFBZTtBQUNmLFlBQU0sUUFBUSxNQUFNLFlBQVksSUFBSTtBQUNwQyxhQUFPLE1BQU0sTUFBTSxPQUFPLHNCQUFzQjtBQUdoRCwyQkFBcUI7QUFDckIsWUFBTSxTQUFTLE1BQU0sWUFBWSxJQUFJO0FBQ3JDLGFBQU87QUFBQSxRQUFNLE9BQU87QUFBQSxRQUFPO0FBQUEsUUFDekI7QUFBQSxNQUFtRDtBQUFBLElBQ3ZELENBQUM7QUFBQSxFQUNILENBQUM7QUFFRCxXQUFTLHdEQUF3RCxNQUFNO0FBQ3JFLFNBQUssNEVBQXVFLFlBQVk7QUFDdEYsWUFBTSxPQUFPLGtCQUFrQjtBQUMvQixtQkFBYSxNQUFNLFFBQVEsaUJBQWlCLENBQUM7QUFDN0MsK0JBQXlCLE1BQU0sUUFBUSxNQUFNO0FBRTdDLDJCQUFxQjtBQUNyQixxQkFBZTtBQUNmLFlBQU0sUUFBUSxNQUFNLFlBQVksSUFBSTtBQUNwQyxhQUFPLE1BQU0sTUFBTSxPQUFPLHNCQUFzQjtBQUdoRCwyQkFBcUI7QUFDckIsWUFBTSxTQUFTLE1BQU0sWUFBWSxJQUFJO0FBQ3JDLGFBQU87QUFBQSxRQUFNLE9BQU87QUFBQSxRQUFPO0FBQUEsUUFDekI7QUFBQSxNQUEyQztBQUFBLElBQy9DLENBQUM7QUFBQSxFQUNILENBQUM7QUFFRCxXQUFTLDhEQUE4RCxNQUFNO0FBQzNFLFNBQUssNkZBQXdGLFlBQVk7QUFDdkcsWUFBTSxPQUFPLGtCQUFrQjtBQUMvQixtQkFBYSxNQUFNLFFBQVEsZ0JBQWdCLENBQUM7QUFDNUMsZ0JBQVUsTUFBTSxRQUFRLE9BQU8sZ0JBQWdCLENBQUM7QUFDaEQsa0NBQTRCLE1BQU0sUUFBUSxPQUFPLEtBQUs7QUFHdEQsMkJBQXFCO0FBQ3JCLHFCQUFlO0FBQ2YsWUFBTSxTQUFTLE1BQU0sWUFBWSxJQUFJO0FBQ3JDLGFBQU8sTUFBTSxPQUFPLE9BQU8sa0JBQWtCO0FBRzdDLDJCQUFxQjtBQUNyQixZQUFNLFNBQVMsTUFBTSxZQUFZLElBQUk7QUFDckMsYUFBTztBQUFBLFFBQU0sT0FBTztBQUFBLFFBQU87QUFBQSxRQUN6QjtBQUFBLE1BQW9FO0FBQUEsSUFDeEUsQ0FBQztBQUFBLEVBQ0gsQ0FBQztBQUVELFdBQVMsOERBQThELE1BQU07QUFDM0UsU0FBSyw2RkFBd0YsWUFBWTtBQUN2RyxZQUFNLE9BQU8sa0JBQWtCO0FBQy9CLG1CQUFhLE1BQU0sUUFBUSxpQkFBaUIsQ0FBQztBQUU3Qyw0QkFBc0IsTUFBTSxNQUFNO0FBQ2xDLDJCQUFxQjtBQUNyQixxQkFBZTtBQUNmLFlBQU0sUUFBUSxNQUFNLFlBQVksSUFBSTtBQUdwQyxhQUFPO0FBQUEsUUFBTSxNQUFNO0FBQUEsUUFBTztBQUFBLFFBQ3hCO0FBQUEsTUFBdUQ7QUFBQSxJQUMzRCxDQUFDO0FBQUEsRUFDSCxDQUFDO0FBRUQsV0FBUywrREFBK0QsTUFBTTtBQUM1RSxTQUFLLGdGQUEyRSxZQUFZO0FBQzFGLFlBQU0sT0FBTyxrQkFBa0I7QUFFL0IsbUJBQWEsTUFBTSxRQUFRLGlCQUFpQixDQUFDO0FBSTdDLG1CQUFhLE1BQU0sUUFBUTtBQUFBLFFBQ3pCO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxNQUNGLEVBQUUsS0FBSyxJQUFJLENBQUM7QUFDWixtQkFBYSxNQUFNLFFBQVE7QUFBQSxRQUN6QjtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxNQUNGLEVBQUUsS0FBSyxJQUFJLENBQUM7QUFFWiwyQkFBcUI7QUFDckIscUJBQWU7QUFDZixZQUFNLFFBQVEsTUFBTSxZQUFZLElBQUk7QUFHcEMsYUFBTztBQUFBLFFBQU0sTUFBTSxpQkFBaUI7QUFBQSxRQUFJO0FBQUEsUUFDdEM7QUFBQSxNQUFzRDtBQUN4RCxhQUFPO0FBQUEsUUFBUyxNQUFNLGlCQUFpQjtBQUFBLFFBQUk7QUFBQSxRQUN6QztBQUFBLE1BQW9EO0FBQUEsSUFDeEQsQ0FBQztBQUFBLEVBQ0gsQ0FBQztBQUVELFdBQVMseURBQXlELE1BQU07QUFDdEUsU0FBSyw4RkFBeUYsWUFBWTtBQUN4RyxZQUFNLE9BQU8sa0JBQWtCO0FBQy9CLFlBQU0sU0FBUyxLQUFLLE1BQU0sUUFBUSxRQUFRO0FBQzFDLG1CQUFhLE1BQU07QUFFbkIsc0JBQWdCLEVBQUUsSUFBSSxRQUFRLE9BQU8sY0FBYyxRQUFRLFNBQVMsQ0FBQztBQUNyRSxrQkFBWSxFQUFFLElBQUksT0FBTyxhQUFhLFFBQVEsT0FBTyxjQUFjLFFBQVEsVUFBVSxTQUFTLENBQUMsRUFBRSxDQUFDO0FBQ2xHLGlCQUFXLEVBQUUsSUFBSSxPQUFPLFNBQVMsT0FBTyxhQUFhLFFBQVEsT0FBTyxPQUFPLFFBQVEsVUFBVSxDQUFDO0FBQzlGLGlCQUFXLEVBQUUsSUFBSSxPQUFPLFNBQVMsT0FBTyxhQUFhLFFBQVEsT0FBTyxPQUFPLFFBQVEsY0FBYyxDQUFDO0FBQ2xHLGlCQUFXLEVBQUUsSUFBSSxPQUFPLFNBQVMsT0FBTyxhQUFhLFFBQVEsT0FBTyxPQUFPLFFBQVEsVUFBVSxDQUFDO0FBRTlGLFlBQU0sbUJBQW1CO0FBQUEsUUFDdkI7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsTUFDRixFQUFFLEtBQUssSUFBSTtBQUNYLG1CQUFhLE1BQU0sUUFBUSxnQkFBZ0I7QUFFM0MsWUFBTSxnQkFBZ0I7QUFBQSxRQUNwQjtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsTUFDRixFQUFFLEtBQUssSUFBSTtBQUNYLGdCQUFVLE1BQU0sUUFBUSxPQUFPLGFBQWE7QUFHNUMsdUJBQWlCLE1BQU0sUUFBUSxPQUFPLEtBQUs7QUFDM0MsdUJBQWlCLE1BQU0sUUFBUSxPQUFPLEtBQUs7QUFDM0MsdUJBQWlCLE1BQU0sUUFBUSxPQUFPLEtBQUs7QUFFM0MsMkJBQXFCO0FBQ3JCLFlBQU0sUUFBUSxNQUFNLGtCQUFrQixJQUFJO0FBRTFDLGFBQU87QUFBQSxRQUFNLE1BQU07QUFBQSxRQUFPO0FBQUEsUUFDeEI7QUFBQSxNQUEyRDtBQUM3RCxhQUFPLE1BQU0sTUFBTSxZQUFZLElBQUksT0FBTyx5Q0FBeUM7QUFBQSxJQUNyRixDQUFDO0FBQUEsRUFDSCxDQUFDO0FBQ0gsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
