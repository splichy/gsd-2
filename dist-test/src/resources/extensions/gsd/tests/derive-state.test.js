import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveState, isGhostMilestone } from "../state.js";
process.env.GSD_ALLOW_MARKDOWN_DERIVE_FALLBACK = "1";
function createFixtureBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-state-test-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
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
    const planPath = join(tasksDir, `${tid}-PLAN.md`);
    writeFileSync(planPath, `# ${tid} Plan

Task plan stub for testing.
`);
  }
}
function writeContinue(base, mid, sid, content) {
  const dir = join(base, ".gsd", "milestones", mid, "slices", sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}-CONTINUE.md`), content);
}
function writeMilestoneSummary(base, mid, content) {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-SUMMARY.md`), content);
}
function writeMilestoneValidation(base, mid, verdict = "pass") {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-VALIDATION.md`), `---
verdict: ${verdict}
remediation_round: 0
---

# Validation
Validated.`);
}
function writeRequirements(base, content) {
  writeFileSync(join(base, ".gsd", "REQUIREMENTS.md"), content);
}
function cleanup(base) {
  rmSync(base, { recursive: true, force: true });
}
describe("derive-state", async () => {
  test("empty milestones dir \u2192 pre-planning", async () => {
    const base = createFixtureBase();
    try {
      const state = await deriveState(base);
      assert.deepStrictEqual(state.phase, "pre-planning", "phase is pre-planning");
      assert.deepStrictEqual(state.activeMilestone, null, "activeMilestone is null");
      assert.deepStrictEqual(state.activeSlice, null, "activeSlice is null");
      assert.deepStrictEqual(state.activeTask, null, "activeTask is null");
      assert.deepStrictEqual(state.registry, [], "registry is empty");
      assert.deepStrictEqual(state.progress?.milestones?.done, 0, "milestones done = 0");
      assert.deepStrictEqual(state.progress?.milestones?.total, 0, "milestones total = 0");
    } finally {
      cleanup(base);
    }
  });
  test("milestone dir exists but no roadmap \u2192 pre-planning", async () => {
    const base = createFixtureBase();
    try {
      mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
      writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-CONTEXT.md"), "# First Milestone\n\nContext for M001.");
      const state = await deriveState(base);
      assert.deepStrictEqual(state.phase, "pre-planning", "phase is pre-planning");
      assert.ok(state.activeMilestone !== null, "activeMilestone is not null");
      assert.deepStrictEqual(state.activeMilestone?.id, "M001", "activeMilestone id is M001");
      assert.deepStrictEqual(state.activeSlice, null, "activeSlice is null");
      assert.deepStrictEqual(state.activeTask, null, "activeTask is null");
      assert.deepStrictEqual(state.registry.length, 1, "registry has 1 entry");
      assert.deepStrictEqual(state.registry[0]?.status, "active", "registry entry status is active");
    } finally {
      cleanup(base);
    }
  });
  test("roadmap with incomplete slice, no plan \u2192 planning", async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M001", `# M001: Test Milestone

**Vision:** Test planning phase.

## Slices

- [ ] **S01: Test Slice** \`risk:low\` \`depends:[]\`
  > After this: Slice is done.
`);
      const state = await deriveState(base);
      assert.deepStrictEqual(state.phase, "planning", "phase is planning");
      assert.ok(state.activeSlice !== null, "activeSlice is not null");
      assert.deepStrictEqual(state.activeSlice?.id, "S01", "activeSlice id is S01");
      assert.deepStrictEqual(state.activeTask, null, "activeTask is null");
      assert.deepStrictEqual(state.progress?.slices?.done, 0, "slices done = 0");
      assert.deepStrictEqual(state.progress?.slices?.total, 1, "slices total = 1");
    } finally {
      cleanup(base);
    }
  });
  test("roadmap + plan with incomplete tasks \u2192 executing", async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M001", `# M001: Test Milestone

**Vision:** Test executing phase.

## Slices

- [ ] **S01: Test Slice** \`risk:low\` \`depends:[]\`
  > After this: Slice is done.
`);
      writePlan(base, "M001", "S01", `# S01: Test Slice

**Goal:** Test executing.
**Demo:** Tests pass.

## Tasks

- [ ] **T01: First** \`est:10m\`
  First task description.

- [ ] **T02: Second** \`est:10m\`
  Second task description.
`);
      const state = await deriveState(base);
      assert.deepStrictEqual(state.phase, "executing", "phase is executing");
      assert.ok(state.activeTask !== null, "activeTask is not null");
      assert.deepStrictEqual(state.activeTask?.id, "T01", "activeTask id is T01");
      assert.deepStrictEqual(state.progress?.tasks?.done, 0, "tasks done = 0");
      assert.deepStrictEqual(state.progress?.tasks?.total, 2, "tasks total = 2");
    } finally {
      cleanup(base);
    }
  });
  test("executing + continue file \u2192 resume message", async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M001", `# M001: Test Milestone

**Vision:** Test interrupted resume.

## Slices

- [ ] **S01: Test Slice** \`risk:low\` \`depends:[]\`
  > After this: Slice is done.
`);
      writePlan(base, "M001", "S01", `# S01: Test Slice

**Goal:** Test interrupted.
**Demo:** Tests pass.

## Tasks

- [ ] **T01: First Task** \`est:10m\`
  First task description.
`);
      writeContinue(base, "M001", "S01", `---
milestone: M001
slice: S01
task: T01
step: 2
totalSteps: 5
status: interrupted
savedAt: 2026-03-10T10:00:00Z
---

# Continue: T01

## Completed Work
Steps 1 done.

## Remaining Work
Steps 2-5.

## Next Action
Continue from step 2.
`);
      const state = await deriveState(base);
      assert.deepStrictEqual(state.phase, "executing", "interrupted: phase is executing");
      assert.ok(state.activeTask !== null, "interrupted: activeTask is not null");
      assert.deepStrictEqual(state.activeTask?.id, "T01", "interrupted: activeTask id is T01");
      assert.ok(
        state.nextAction.includes("Resume") || state.nextAction.includes("resume") || state.nextAction.includes("continue.md"),
        "interrupted: nextAction mentions Resume/resume/continue.md"
      );
    } finally {
      cleanup(base);
    }
  });
  test("all tasks done, slice not [x] \u2192 summarizing", async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M001", `# M001: Test Milestone

**Vision:** Test summarizing phase.

## Slices

- [ ] **S01: Test Slice** \`risk:low\` \`depends:[]\`
  > After this: Slice is done.
`);
      writePlan(base, "M001", "S01", `# S01: Test Slice

**Goal:** Test summarizing.
**Demo:** Tests pass.

## Tasks

- [x] **T01: First Done** \`est:10m\`
  Already completed.

- [x] **T02: Second Done** \`est:10m\`
  Also completed.
`);
      const state = await deriveState(base);
      assert.deepStrictEqual(state.phase, "summarizing", "summarizing: phase is summarizing");
      assert.ok(state.activeSlice !== null, "summarizing: activeSlice is not null");
      assert.deepStrictEqual(state.activeSlice?.id, "S01", "summarizing: activeSlice id is S01");
      assert.deepStrictEqual(state.activeTask, null, "summarizing: activeTask is null");
      assert.ok(
        state.nextAction.toLowerCase().includes("summary") || state.nextAction.toLowerCase().includes("complete"),
        "summarizing: nextAction mentions summary or complete"
      );
      assert.deepStrictEqual(state.progress?.tasks?.done, 2, "summarizing: tasks done = 2");
      assert.deepStrictEqual(state.progress?.tasks?.total, 2, "summarizing: tasks total = 2");
    } finally {
      cleanup(base);
    }
  });
  test("all milestones complete \u2192 complete", async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M001", `# M001: Test Milestone

**Vision:** Test complete phase.

## Slices

- [x] **S01: Done Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeMilestoneValidation(base, "M001");
      writeMilestoneSummary(base, "M001", `# M001 Summary

Milestone complete.`);
      const state = await deriveState(base);
      assert.deepStrictEqual(state.phase, "complete", "complete: phase is complete");
      assert.deepStrictEqual(state.activeSlice, null, "complete: activeSlice is null");
      assert.deepStrictEqual(state.activeTask, null, "complete: activeTask is null");
      assert.ok(
        state.nextAction.toLowerCase().includes("complete"),
        "complete: nextAction mentions complete"
      );
      assert.deepStrictEqual(state.registry.length, 1, "complete: registry has 1 entry");
      assert.deepStrictEqual(state.registry[0]?.status, "complete", "complete: registry[0] status is complete");
    } finally {
      cleanup(base);
    }
  });
  test("complete with active requirements \u2192 surfaces unmapped reqs", async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M001", `# M001: Test Milestone

**Vision:** Test complete phase with unmapped requirements.

## Slices

- [x] **S01: Done Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeMilestoneValidation(base, "M001");
      writeMilestoneSummary(base, "M001", `# M001 Summary

Milestone complete.`);
      writeRequirements(base, `# Requirements

## Active

### REQ01 \u2014 First active requirement
- Status: active

### REQ02 \u2014 Second active requirement
- Status: active

## Validated

### REQ03 \u2014 Validated requirement
- Status: validated
`);
      const state = await deriveState(base);
      assert.deepStrictEqual(state.phase, "complete", "complete-with-reqs: phase is complete");
      assert.ok(
        state.nextAction.includes("2 active requirements"),
        "complete-with-reqs: nextAction mentions 2 active requirements"
      );
      assert.ok(
        state.nextAction.includes("REQUIREMENTS.md"),
        "complete-with-reqs: nextAction mentions REQUIREMENTS.md"
      );
    } finally {
      cleanup(base);
    }
  });
  test("complete with no active requirements \u2192 standard message", async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M001", `# M001: Test Milestone

**Vision:** Test complete phase with all requirements validated.

## Slices

- [x] **S01: Done Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeMilestoneValidation(base, "M001");
      writeMilestoneSummary(base, "M001", `# M001 Summary

Milestone complete.`);
      writeRequirements(base, `# Requirements

## Validated

### REQ01 \u2014 Validated requirement
- Status: validated
`);
      const state = await deriveState(base);
      assert.deepStrictEqual(state.phase, "complete", "complete-no-active-reqs: phase is complete");
      assert.deepStrictEqual(state.nextAction, "All milestones complete.", "complete-no-active-reqs: standard completion message");
    } finally {
      cleanup(base);
    }
  });
  test("blocked dependencies", async () => {
    const base1 = createFixtureBase();
    try {
      writeRoadmap(base1, "M001", `# M001: Test Milestone

**Vision:** Test blocked deps.

## Slices

- [ ] **S01: First** \`risk:low\` \`depends:[]\`
  > After this: S01 done.

- [ ] **S02: Second** \`risk:low\` \`depends:[S01]\`
  > After this: S02 done.
`);
      writePlan(base1, "M001", "S01", `# S01: First

**Goal:** First slice.
**Demo:** Tests pass.

## Tasks

- [ ] **T01: Incomplete** \`est:10m\`
  Still working.
`);
      const state1 = await deriveState(base1);
      assert.deepStrictEqual(state1.phase, "executing", "blocked-A: phase is executing (S01 active)");
      assert.deepStrictEqual(state1.activeSlice?.id, "S01", "blocked-A: activeSlice is S01");
    } finally {
      cleanup(base1);
    }
    const base2 = createFixtureBase();
    try {
      writeRoadmap(base2, "M001", `# M001: Test Milestone

**Vision:** Test truly blocked.

## Slices

- [ ] **S01: Blocked** \`risk:low\` \`depends:[S99]\`
  > After this: Done.
`);
      const state2 = await deriveState(base2);
      assert.deepStrictEqual(state2.phase, "blocked", "blocked-B: phase is blocked when dependency is unsatisfied");
      assert.deepStrictEqual(state2.activeSlice, null, "blocked-B: no activeSlice selected through unmet deps");
      assert.ok(state2.blockers.some((b) => b.includes("No slice eligible")), "blocked-B: blocker explains no eligible slice");
    } finally {
      cleanup(base2);
    }
  });
  test("multi-milestone registry", async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M001", `# M001: First Milestone

**Vision:** Already done.

## Slices

- [x] **S01: Done** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeMilestoneValidation(base, "M001");
      writeMilestoneSummary(base, "M001", `# M001 Summary

First milestone complete.`);
      writeRoadmap(base, "M002", `# M002: Second Milestone

**Vision:** Currently active.

## Slices

- [ ] **S01: In Progress** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      mkdirSync(join(base, ".gsd", "milestones", "M003"), { recursive: true });
      writeFileSync(join(base, ".gsd", "milestones", "M003", "M003-CONTEXT.md"), "# Third Milestone\n\nContext for M003.");
      const state = await deriveState(base);
      assert.deepStrictEqual(state.registry.length, 3, "multi-ms: registry has 3 entries");
      assert.deepStrictEqual(state.registry[0]?.id, "M001", "multi-ms: registry[0] is M001");
      assert.deepStrictEqual(state.registry[0]?.status, "complete", "multi-ms: M001 is complete");
      assert.deepStrictEqual(state.registry[1]?.id, "M002", "multi-ms: registry[1] is M002");
      assert.deepStrictEqual(state.registry[1]?.status, "active", "multi-ms: M002 is active");
      assert.deepStrictEqual(state.registry[2]?.id, "M003", "multi-ms: registry[2] is M003");
      assert.deepStrictEqual(state.registry[2]?.status, "pending", "multi-ms: M003 is pending");
      assert.deepStrictEqual(state.activeMilestone?.id, "M002", "multi-ms: activeMilestone is M002");
      assert.deepStrictEqual(state.progress?.milestones?.done, 1, "multi-ms: milestones done = 1");
      assert.deepStrictEqual(state.progress?.milestones?.total, 3, "multi-ms: milestones total = 3");
    } finally {
      cleanup(base);
    }
  });
  test("requirements integration", async () => {
    const base = createFixtureBase();
    try {
      writeRequirements(base, `# Requirements

## Active

### R001 \u2014 First Active Requirement
- Status: active
- Description: Something active.

### R002 \u2014 Second Active Requirement
- Status: active
- Description: Another active one.

## Validated

### R003 \u2014 Validated Requirement
- Status: validated
- Description: Already validated.

## Deferred

### R004 \u2014 Deferred Requirement
- Status: deferred
- Description: Pushed back.

### R005 \u2014 Another Deferred
- Status: deferred
- Description: Also deferred.

## Out of Scope

### R006 \u2014 Out of Scope Requirement
- Status: out-of-scope
- Description: Not doing this.
`);
      const state = await deriveState(base);
      assert.ok(state.requirements !== void 0, "requirements: requirements object exists");
      assert.deepStrictEqual(state.requirements?.active, 2, "requirements: active = 2");
      assert.deepStrictEqual(state.requirements?.validated, 1, "requirements: validated = 1");
      assert.deepStrictEqual(state.requirements?.deferred, 2, "requirements: deferred = 2");
      assert.deepStrictEqual(state.requirements?.outOfScope, 1, "requirements: outOfScope = 1");
      assert.deepStrictEqual(state.requirements?.total, 6, "requirements: total = 6 (sum of all)");
    } finally {
      cleanup(base);
    }
  });
  test("all slices [x], no summary \u2192 completing-milestone", async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M001", `# M001: Test Milestone

**Vision:** Test completing-milestone phase.

## Slices

- [x] **S01: First Done** \`risk:low\` \`depends:[]\`
  > After this: S01 complete.

- [x] **S02: Second Done** \`risk:low\` \`depends:[S01]\`
  > After this: S02 complete.
`);
      writeMilestoneValidation(base, "M001");
      const state = await deriveState(base);
      assert.deepStrictEqual(state.phase, "completing-milestone", "completing-ms: phase is completing-milestone");
      assert.ok(state.activeMilestone !== null, "completing-ms: activeMilestone is not null");
      assert.deepStrictEqual(state.activeMilestone?.id, "M001", "completing-ms: activeMilestone id is M001");
      assert.deepStrictEqual(state.activeSlice, null, "completing-ms: activeSlice is null");
      assert.deepStrictEqual(state.activeTask, null, "completing-ms: activeTask is null");
      assert.deepStrictEqual(state.registry.length, 1, "completing-ms: registry has 1 entry");
      assert.deepStrictEqual(state.registry[0]?.status, "active", "completing-ms: registry[0] status is active (not complete)");
      assert.deepStrictEqual(state.progress?.slices?.done, 2, "completing-ms: slices done = 2");
      assert.deepStrictEqual(state.progress?.slices?.total, 2, "completing-ms: slices total = 2");
      assert.ok(
        state.nextAction.toLowerCase().includes("summary") || state.nextAction.toLowerCase().includes("complete"),
        "completing-ms: nextAction mentions summary or complete"
      );
    } finally {
      cleanup(base);
    }
  });
  test("all slices [x], summary exists \u2192 complete", async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M001", `# M001: Test Milestone

**Vision:** Test that summary presence means complete.

## Slices

- [x] **S01: Done** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeMilestoneValidation(base, "M001");
      writeMilestoneSummary(base, "M001", `# M001 Summary

Milestone is complete.`);
      const state = await deriveState(base);
      assert.deepStrictEqual(state.phase, "complete", "summary-exists: phase is complete");
      assert.deepStrictEqual(state.registry.length, 1, "summary-exists: registry has 1 entry");
      assert.deepStrictEqual(state.registry[0]?.status, "complete", "summary-exists: registry[0] status is complete");
      assert.deepStrictEqual(state.activeSlice, null, "summary-exists: activeSlice is null");
      assert.deepStrictEqual(state.activeTask, null, "summary-exists: activeTask is null");
    } finally {
      cleanup(base);
    }
  });
  test("multi-milestone completing-milestone", async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M001", `# M001: First Milestone

**Vision:** Already complete with summary.

## Slices

- [x] **S01: Done** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeMilestoneValidation(base, "M001");
      writeMilestoneSummary(base, "M001", `# M001 Summary

First milestone complete.`);
      writeRoadmap(base, "M002", `# M002: Second Milestone

**Vision:** All slices done but no summary.

## Slices

- [x] **S01: Done** \`risk:low\` \`depends:[]\`
  > After this: Done.

- [x] **S02: Also Done** \`risk:low\` \`depends:[S01]\`
  > After this: Done.
`);
      writeMilestoneValidation(base, "M002");
      writeRoadmap(base, "M003", `# M003: Third Milestone

**Vision:** Not yet started.

## Slices

- [ ] **S01: Not Started** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      const state = await deriveState(base);
      assert.deepStrictEqual(state.phase, "completing-milestone", "multi-completing: phase is completing-milestone");
      assert.deepStrictEqual(state.activeMilestone?.id, "M002", "multi-completing: activeMilestone is M002");
      assert.deepStrictEqual(state.activeSlice, null, "multi-completing: activeSlice is null");
      assert.deepStrictEqual(state.activeTask, null, "multi-completing: activeTask is null");
      assert.deepStrictEqual(state.registry.length, 3, "multi-completing: registry has 3 entries");
      assert.deepStrictEqual(state.registry[0]?.id, "M001", "multi-completing: registry[0] is M001");
      assert.deepStrictEqual(state.registry[0]?.status, "complete", "multi-completing: M001 is complete");
      assert.deepStrictEqual(state.registry[1]?.id, "M002", "multi-completing: registry[1] is M002");
      assert.deepStrictEqual(state.registry[1]?.status, "active", "multi-completing: M002 is active (completing-milestone)");
      assert.deepStrictEqual(state.registry[2]?.id, "M003", "multi-completing: registry[2] is M003");
      assert.deepStrictEqual(state.registry[2]?.status, "pending", "multi-completing: M003 is pending");
      assert.deepStrictEqual(state.progress?.milestones?.done, 1, "multi-completing: milestones done = 1");
      assert.deepStrictEqual(state.progress?.milestones?.total, 3, "multi-completing: milestones total = 3");
      assert.deepStrictEqual(state.progress?.slices?.done, 2, "multi-completing: slices done = 2");
      assert.deepStrictEqual(state.progress?.slices?.total, 2, "multi-completing: slices total = 2");
    } finally {
      cleanup(base);
    }
  });
  {
    const base = createFixtureBase();
    try {
      const m1dir = join(base, ".gsd", "milestones", "M001");
      mkdirSync(m1dir, { recursive: true });
      writeFileSync(join(m1dir, "M001-SUMMARY.md"), "---\nid: M001\n---\n# Bootstrap\nDone.");
      const m2dir = join(base, ".gsd", "milestones", "M002");
      mkdirSync(m2dir, { recursive: true });
      writeFileSync(join(m2dir, "M002-SUMMARY.md"), "---\nid: M002\n---\n# Core Features\nDone.");
      writeRoadmap(base, "M003", "# M003: Polish\n## Slices\n- [ ] **S01: Cleanup**");
      const state = await deriveState(base);
      assert.deepStrictEqual(state.phase, "planning", "summary-no-roadmap: phase is planning (active is M003)");
      assert.deepStrictEqual(state.activeMilestone?.id, "M003", "summary-no-roadmap: active milestone is M003");
      assert.deepStrictEqual(state.activeMilestone?.title, "Polish", "summary-no-roadmap: active title is Polish");
      assert.deepStrictEqual(state.registry.length, 3, "summary-no-roadmap: registry has 3 entries");
      assert.deepStrictEqual(state.registry[0]?.status, "complete", "summary-no-roadmap: M001 is complete");
      assert.deepStrictEqual(state.registry[0]?.title, "Bootstrap", "summary-no-roadmap: M001 title from summary");
      assert.deepStrictEqual(state.registry[1]?.status, "complete", "summary-no-roadmap: M002 is complete");
      assert.deepStrictEqual(state.registry[1]?.title, "Core Features", "summary-no-roadmap: M002 title from summary");
      assert.deepStrictEqual(state.registry[2]?.status, "active", "summary-no-roadmap: M003 is active");
      assert.deepStrictEqual(state.progress?.milestones?.done, 2, "summary-no-roadmap: milestones done = 2");
      assert.deepStrictEqual(state.progress?.milestones?.total, 3, "summary-no-roadmap: milestones total = 3");
    } finally {
      cleanup(base);
    }
  }
  {
    const base = createFixtureBase();
    try {
      const m1dir = join(base, ".gsd", "milestones", "M001");
      mkdirSync(m1dir, { recursive: true });
      writeFileSync(join(m1dir, "M001-SUMMARY.md"), "---\ntitle: Done\n---\nAll done.");
      const state = await deriveState(base);
      assert.deepStrictEqual(state.phase, "complete", "all-summary-only: phase is complete");
      assert.deepStrictEqual(state.registry[0]?.status, "complete", "all-summary-only: M001 is complete");
    } finally {
      cleanup(base);
    }
  }
  test("empty plan \u2192 planning (not summarizing)", async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M001", `---
id: M001
title: "Test"
---
# M001: Test
## Vision
Test
## Success Criteria
- Done
## Slices
- [ ] **S01: Empty slice** \`risk:low\` \`depends:[]\`
  > Test
## Boundary Map
_None_
`);
      writePlan(base, "M001", "S01", `---
slice: S01
---
# S01 Plan
## Tasks
`);
      const state = await deriveState(base);
      assert.deepStrictEqual(state.phase, "planning", "empty plan stays in planning");
      assert.deepStrictEqual(state.activeSlice?.id, "S01", "active slice is S01");
      assert.deepStrictEqual(state.activeTask, null, "no active task");
    } finally {
      cleanup(base);
    }
  });
  test("completed milestone with summary but no validation is not active (#864)", async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M001", `# M001: First Milestone

**Vision:** Done.

## Slices

- [x] **S01: Done slice** \`risk:low\` \`depends:[]\`
  > Completed.
`);
      writeMilestoneSummary(base, "M001", "---\nid: M001\n---\n\n# M001: First Milestone\n\n**Completed.**");
      writeRoadmap(base, "M003", `# M003: Active Milestone

**Vision:** Do stuff.

## Slices

- [ ] **S01: Work slice** \`risk:low\` \`depends:[]\`
  > Needs work.
`);
      const state = await deriveState(base);
      assert.deepStrictEqual(state.activeMilestone?.id, "M003", "active milestone is M003, not completed M001");
      const m001Entry = state.registry.find((e) => e.id === "M001");
      assert.deepStrictEqual(m001Entry?.status, "complete", "M001 is marked complete despite no validation");
    } finally {
      cleanup(base);
    }
  });
  test("completed milestone with summary and validation is complete", async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M001", `# M001: First Milestone

**Vision:** Done.

## Slices

- [x] **S01: Done slice** \`risk:low\` \`depends:[]\`
  > Completed.
`);
      writeMilestoneSummary(base, "M001", "---\nid: M001\n---\n\n# M001: First Milestone\n\n**Completed.**");
      writeMilestoneValidation(base, "M001", "pass");
      writeRoadmap(base, "M003", `# M003: Active Milestone

**Vision:** Do stuff.

## Slices

- [ ] **S01: Work slice** \`risk:low\` \`depends:[]\`
  > Needs work.
`);
      const state = await deriveState(base);
      assert.deepStrictEqual(state.activeMilestone?.id, "M003", "active milestone is M003");
      const m001Entry = state.registry.find((e) => e.id === "M001");
      assert.deepStrictEqual(m001Entry?.status, "complete", "M001 with both summary and validation is complete");
    } finally {
      cleanup(base);
    }
  });
  test("all slices done, no summary, no validation \u2192 validating-milestone", async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M001", `# M001: First Milestone

**Vision:** Validate me.

## Slices

- [x] **S01: Done slice** \`risk:low\` \`depends:[]\`
  > Completed.
`);
      const state = await deriveState(base);
      assert.deepStrictEqual(state.activeMilestone?.id, "M001", "M001 is active for validation");
    } finally {
      cleanup(base);
    }
  });
  test("all slices done, validation pass, no summary \u2192 completing-milestone", async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M001", `# M001: First Milestone

**Vision:** Complete me.

## Slices

- [x] **S01: Done slice** \`risk:low\` \`depends:[]\`
  > Completed.
`);
      writeMilestoneValidation(base, "M001", "pass");
      const state = await deriveState(base);
      assert.deepStrictEqual(state.activeMilestone?.id, "M001", "M001 is active for completion");
    } finally {
      cleanup(base);
    }
  });
  test("unchecked roadmap slices + summary \u2192 complete (summary is terminal)", async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M001", `# M001: First Milestone

**Vision:** Already done.

## Slices

- [ ] **S01: Unchecked slice** \`risk:low\` \`depends:[]\`
  > Work was done but checkbox never ticked.
- [ ] **S02: Another unchecked** \`risk:low\` \`depends:[]\`
  > Same.
`);
      writeMilestoneSummary(base, "M001", "---\nid: M001\n---\n\n# M001: First Milestone\n\n**Completed despite unchecked roadmap.**");
      writeRoadmap(base, "M002", `# M002: Active Milestone

**Vision:** Do stuff.

## Slices

- [ ] **S01: Work slice** \`risk:low\` \`depends:[]\`
  > Needs work.
`);
      const state = await deriveState(base);
      const m001Entry = state.registry.find((e) => e.id === "M001");
      assert.deepStrictEqual(m001Entry?.status, "complete", "M001 with unchecked roadmap + summary is complete");
      assert.deepStrictEqual(state.activeMilestone?.id, "M002", "active milestone is M002, not M001");
    } finally {
      cleanup(base);
    }
  });
  test("unchecked roadmap + summary satisfies dependency", async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M001", `# M001: Foundation

**Vision:** Done.

## Slices

- [ ] **S01: Setup** \`risk:low\` \`depends:[]\`
  > Done.
`);
      writeMilestoneSummary(base, "M001", "---\nid: M001\n---\n\n# M001: Foundation\n\n**Done.**");
      writeRoadmap(base, "M002", `# M002: Dependent

**Vision:** Depends on M001.

## Slices

- [ ] **S01: Work** \`risk:low\` \`depends:[]\`
  > Work.
`);
      const contextDir = join(base, ".gsd", "milestones", "M002");
      mkdirSync(contextDir, { recursive: true });
      writeFileSync(join(contextDir, "M002-CONTEXT.md"), "---\ndepends_on:\n  - M001\n---\n\n# M002 Context\n\nDepends on M001.");
      const state = await deriveState(base);
      assert.deepStrictEqual(state.activeMilestone?.id, "M002", "M002 is active \u2014 M001 dependency satisfied via summary");
      const m002Entry = state.registry.find((e) => e.id === "M002");
      assert.deepStrictEqual(m002Entry?.status, "active", "M002 status is active, not pending");
    } finally {
      cleanup(base);
    }
  });
  test("ghost milestone (only META.json) is skipped", async () => {
    const base = createFixtureBase();
    try {
      const ghostDir = join(base, ".gsd", "milestones", "M001");
      mkdirSync(ghostDir, { recursive: true });
      writeFileSync(join(ghostDir, "META.json"), JSON.stringify({ id: "M001" }));
      assert.ok(isGhostMilestone(base, "M001"), "M001 is a ghost milestone");
      const state = await deriveState(base);
      assert.deepStrictEqual(state.phase, "pre-planning", "ghost-only: phase is pre-planning");
      assert.deepStrictEqual(state.activeMilestone, null, "ghost-only: no active milestone");
      assert.deepStrictEqual(state.registry.length, 0, "ghost-only: registry is empty");
    } finally {
      cleanup(base);
    }
  });
  test("ghost milestone skipped alongside real milestones", async () => {
    const base = createFixtureBase();
    try {
      const ghostDir = join(base, ".gsd", "milestones", "M001");
      mkdirSync(ghostDir, { recursive: true });
      writeFileSync(join(ghostDir, "META.json"), JSON.stringify({ id: "M001" }));
      const realDir = join(base, ".gsd", "milestones", "M002");
      mkdirSync(realDir, { recursive: true });
      writeFileSync(join(realDir, "M002-CONTEXT.md"), "# Real Milestone\n\nThis has content.");
      const state = await deriveState(base);
      assert.deepStrictEqual(state.activeMilestone?.id, "M002", "ghost+real: active milestone is M002");
      const m001Entry = state.registry.find((e) => e.id === "M001");
      assert.deepStrictEqual(m001Entry, void 0, "ghost+real: M001 not in registry");
      assert.deepStrictEqual(state.registry.length, 1, "ghost+real: registry has 1 entry");
      assert.deepStrictEqual(state.registry[0]?.status, "active", "ghost+real: M002 is active");
    } finally {
      cleanup(base);
    }
  });
  test("queued milestone with worktree not flagged as ghost (#2921)", async () => {
    const base = createFixtureBase();
    try {
      const milestoneDir = join(base, ".gsd", "milestones", "M002");
      mkdirSync(join(milestoneDir, "slices"), { recursive: true });
      const worktreeDir = join(base, ".gsd", "worktrees", "M002");
      mkdirSync(worktreeDir, { recursive: true });
      assert.ok(!isGhostMilestone(base, "M002"), "M002 with worktree should NOT be a ghost");
      writeMilestoneSummary(base, "M001", "# M001 Summary\n\nDone.");
      const state = await deriveState(base);
      const m002Entry = state.registry.find((e) => e.id === "M002");
      assert.ok(m002Entry !== void 0, "M002 should be in registry when worktree exists");
      assert.deepStrictEqual(state.activeMilestone?.id, "M002", "M002 should be active milestone");
    } finally {
      cleanup(base);
    }
  });
  test("zero-slice roadmap \u2192 pre-planning, not blocked (#1785)", async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M001", `# M001: Stub Milestone

**Vision:** Placeholder.

## Slices

_No slices defined yet._
`);
      const state = await deriveState(base);
      assert.deepStrictEqual(state.phase, "pre-planning", "phase is pre-planning when roadmap has zero slices");
      assert.ok(state.activeMilestone !== null, "activeMilestone is set");
      assert.deepStrictEqual(state.activeMilestone?.id, "M001", "activeMilestone is M001");
      assert.deepStrictEqual(state.activeSlice, null, "activeSlice is null");
      assert.deepStrictEqual(state.activeTask, null, "activeTask is null");
      assert.deepStrictEqual(state.blockers.length, 0, "no blockers reported");
      assert.ok(state.nextAction.includes("M001"), "nextAction references M001");
    } finally {
      cleanup(base);
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9kZXJpdmUtc3RhdGUudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QgfSBmcm9tICdub2RlOnRlc3QnO1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSAnbm9kZTpmcyc7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJztcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gJ25vZGU6b3MnO1xuXG5pbXBvcnQgeyBkZXJpdmVTdGF0ZSwgaXNTbGljZUNvbXBsZXRlLCBpc01pbGVzdG9uZUNvbXBsZXRlLCBpc0dob3N0TWlsZXN0b25lIH0gZnJvbSAnLi4vc3RhdGUudHMnO1xuXG4vLyBUaGlzIHN1aXRlIGV4ZXJjaXNlcyB0aGUgZXhwbGljaXQgbGVnYWN5IG1hcmtkb3duIGRlcml2YXRpb24gcGF0aC5cbnByb2Nlc3MuZW52LkdTRF9BTExPV19NQVJLRE9XTl9ERVJJVkVfRkFMTEJBQ0sgPSAnMSc7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBGaXh0dXJlIEhlbHBlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIGNyZWF0ZUZpeHR1cmVCYXNlKCk6IHN0cmluZyB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCAnZ3NkLXN0YXRlLXRlc3QtJykpO1xuICBta2RpclN5bmMoam9pbihiYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICByZXR1cm4gYmFzZTtcbn1cblxuZnVuY3Rpb24gd3JpdGVSb2FkbWFwKGJhc2U6IHN0cmluZywgbWlkOiBzdHJpbmcsIGNvbnRlbnQ6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBkaXIgPSBqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCBtaWQpO1xuICBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgYCR7bWlkfS1ST0FETUFQLm1kYCksIGNvbnRlbnQpO1xufVxuXG5mdW5jdGlvbiB3cml0ZVBsYW4oYmFzZTogc3RyaW5nLCBtaWQ6IHN0cmluZywgc2lkOiBzdHJpbmcsIGNvbnRlbnQ6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBkaXIgPSBqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCBtaWQsICdzbGljZXMnLCBzaWQpO1xuICBjb25zdCB0YXNrc0RpciA9IGpvaW4oZGlyLCAndGFza3MnKTtcbiAgbWtkaXJTeW5jKHRhc2tzRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgYCR7c2lkfS1QTEFOLm1kYCksIGNvbnRlbnQpO1xuICAvLyBDcmVhdGUgc3R1YiB0YXNrIHBsYW4gZmlsZXMgZm9yIGFueSB0YXNrcyBpbiB0aGUgcGxhbiBjb250ZW50ICgjOTA5KVxuICAvLyBzbyBkZXJpdmVTdGF0ZSBkb2Vzbid0IGZhbGwgYmFjayB0byBwbGFubmluZyBwaGFzZS5cbiAgY29uc3QgdGFza01hdGNoZXMgPSBjb250ZW50Lm1hdGNoQWxsKC9cXCpcXCooVFxcZCspOi9nKTtcbiAgZm9yIChjb25zdCBtIG9mIHRhc2tNYXRjaGVzKSB7XG4gICAgY29uc3QgdGlkID0gbVsxXTtcbiAgICBjb25zdCBwbGFuUGF0aCA9IGpvaW4odGFza3NEaXIsIGAke3RpZH0tUExBTi5tZGApO1xuICAgIHdyaXRlRmlsZVN5bmMocGxhblBhdGgsIGAjICR7dGlkfSBQbGFuXFxuXFxuVGFzayBwbGFuIHN0dWIgZm9yIHRlc3RpbmcuXFxuYCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gd3JpdGVDb250aW51ZShiYXNlOiBzdHJpbmcsIG1pZDogc3RyaW5nLCBzaWQ6IHN0cmluZywgY29udGVudDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGRpciA9IGpvaW4oYmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsIG1pZCwgJ3NsaWNlcycsIHNpZCk7XG4gIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBgJHtzaWR9LUNPTlRJTlVFLm1kYCksIGNvbnRlbnQpO1xufVxuXG5mdW5jdGlvbiB3cml0ZU1pbGVzdG9uZVN1bW1hcnkoYmFzZTogc3RyaW5nLCBtaWQ6IHN0cmluZywgY29udGVudDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGRpciA9IGpvaW4oYmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsIG1pZCk7XG4gIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBgJHttaWR9LVNVTU1BUlkubWRgKSwgY29udGVudCk7XG59XG5cbmZ1bmN0aW9uIHdyaXRlTWlsZXN0b25lVmFsaWRhdGlvbihiYXNlOiBzdHJpbmcsIG1pZDogc3RyaW5nLCB2ZXJkaWN0OiBzdHJpbmcgPSAncGFzcycpOiB2b2lkIHtcbiAgY29uc3QgZGlyID0gam9pbihiYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgbWlkKTtcbiAgbWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIGAke21pZH0tVkFMSURBVElPTi5tZGApLCBgLS0tXFxudmVyZGljdDogJHt2ZXJkaWN0fVxcbnJlbWVkaWF0aW9uX3JvdW5kOiAwXFxuLS0tXFxuXFxuIyBWYWxpZGF0aW9uXFxuVmFsaWRhdGVkLmApO1xufVxuXG5mdW5jdGlvbiB3cml0ZVJlcXVpcmVtZW50cyhiYXNlOiBzdHJpbmcsIGNvbnRlbnQ6IHN0cmluZyk6IHZvaWQge1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgJy5nc2QnLCAnUkVRVUlSRU1FTlRTLm1kJyksIGNvbnRlbnQpO1xufVxuXG5mdW5jdGlvbiBjbGVhbnVwKGJhc2U6IHN0cmluZyk6IHZvaWQge1xuICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xufVxuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIFRlc3QgR3JvdXBzXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuZGVzY3JpYmUoJ2Rlcml2ZS1zdGF0ZScsIGFzeW5jICgpID0+IHtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCAxOiBlbXB0eSBtaWxlc3RvbmVzIGRpciBcdTIxOTIgcHJlLXBsYW5uaW5nIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICB0ZXN0KCdlbXB0eSBtaWxlc3RvbmVzIGRpciBcdTIxOTIgcHJlLXBsYW5uaW5nJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuXG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnBoYXNlLCAncHJlLXBsYW5uaW5nJywgJ3BoYXNlIGlzIHByZS1wbGFubmluZycpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5hY3RpdmVNaWxlc3RvbmUsIG51bGwsICdhY3RpdmVNaWxlc3RvbmUgaXMgbnVsbCcpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5hY3RpdmVTbGljZSwgbnVsbCwgJ2FjdGl2ZVNsaWNlIGlzIG51bGwnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUuYWN0aXZlVGFzaywgbnVsbCwgJ2FjdGl2ZVRhc2sgaXMgbnVsbCcpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5yZWdpc3RyeSwgW10sICdyZWdpc3RyeSBpcyBlbXB0eScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5wcm9ncmVzcz8ubWlsZXN0b25lcz8uZG9uZSwgMCwgJ21pbGVzdG9uZXMgZG9uZSA9IDAnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucHJvZ3Jlc3M/Lm1pbGVzdG9uZXM/LnRvdGFsLCAwLCAnbWlsZXN0b25lcyB0b3RhbCA9IDAnKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0IDI6IG1pbGVzdG9uZSBkaXIgZXhpc3RzIGJ1dCBubyByb2FkbWFwIFx1MjE5MiBwcmUtcGxhbm5pbmcgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIHRlc3QoJ21pbGVzdG9uZSBkaXIgZXhpc3RzIGJ1dCBubyByb2FkbWFwIFx1MjE5MiBwcmUtcGxhbm5pbmcnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIC8vIENyZWF0ZSBNMDAxIGRpcmVjdG9yeSB3aXRoIENPTlRFWFQgYnV0IG5vIHJvYWRtYXAgZmlsZVxuICAgICAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScsICdNMDAxLUNPTlRFWFQubWQnKSwgJyMgRmlyc3QgTWlsZXN0b25lXFxuXFxuQ29udGV4dCBmb3IgTTAwMS4nKTtcblxuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcblxuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5waGFzZSwgJ3ByZS1wbGFubmluZycsICdwaGFzZSBpcyBwcmUtcGxhbm5pbmcnKTtcbiAgICAgIGFzc2VydC5vayhzdGF0ZS5hY3RpdmVNaWxlc3RvbmUgIT09IG51bGwsICdhY3RpdmVNaWxlc3RvbmUgaXMgbm90IG51bGwnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUuYWN0aXZlTWlsZXN0b25lPy5pZCwgJ00wMDEnLCAnYWN0aXZlTWlsZXN0b25lIGlkIGlzIE0wMDEnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUuYWN0aXZlU2xpY2UsIG51bGwsICdhY3RpdmVTbGljZSBpcyBudWxsJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLmFjdGl2ZVRhc2ssIG51bGwsICdhY3RpdmVUYXNrIGlzIG51bGwnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucmVnaXN0cnkubGVuZ3RoLCAxLCAncmVnaXN0cnkgaGFzIDEgZW50cnknKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucmVnaXN0cnlbMF0/LnN0YXR1cywgJ2FjdGl2ZScsICdyZWdpc3RyeSBlbnRyeSBzdGF0dXMgaXMgYWN0aXZlJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCAzOiByb2FkbWFwIHdpdGggaW5jb21wbGV0ZSBzbGljZSwgbm8gcGxhbiBcdTIxOTIgcGxhbm5pbmcgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIHRlc3QoJ3JvYWRtYXAgd2l0aCBpbmNvbXBsZXRlIHNsaWNlLCBubyBwbGFuIFx1MjE5MiBwbGFubmluZycsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVSb2FkbWFwKGJhc2UsICdNMDAxJywgYCMgTTAwMTogVGVzdCBNaWxlc3RvbmVcblxuKipWaXNpb246KiogVGVzdCBwbGFubmluZyBwaGFzZS5cblxuIyMgU2xpY2VzXG5cbi0gWyBdICoqUzAxOiBUZXN0IFNsaWNlKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbXVxcYFxuICA+IEFmdGVyIHRoaXM6IFNsaWNlIGlzIGRvbmUuXG5gKTtcblxuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcblxuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5waGFzZSwgJ3BsYW5uaW5nJywgJ3BoYXNlIGlzIHBsYW5uaW5nJyk7XG4gICAgICBhc3NlcnQub2soc3RhdGUuYWN0aXZlU2xpY2UgIT09IG51bGwsICdhY3RpdmVTbGljZSBpcyBub3QgbnVsbCcpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5hY3RpdmVTbGljZT8uaWQsICdTMDEnLCAnYWN0aXZlU2xpY2UgaWQgaXMgUzAxJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLmFjdGl2ZVRhc2ssIG51bGwsICdhY3RpdmVUYXNrIGlzIG51bGwnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucHJvZ3Jlc3M/LnNsaWNlcz8uZG9uZSwgMCwgJ3NsaWNlcyBkb25lID0gMCcpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5wcm9ncmVzcz8uc2xpY2VzPy50b3RhbCwgMSwgJ3NsaWNlcyB0b3RhbCA9IDEnKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0IDQ6IHJvYWRtYXAgKyBwbGFuIHdpdGggaW5jb21wbGV0ZSB0YXNrcyBcdTIxOTIgZXhlY3V0aW5nIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICB0ZXN0KCdyb2FkbWFwICsgcGxhbiB3aXRoIGluY29tcGxldGUgdGFza3MgXHUyMTkyIGV4ZWN1dGluZycsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVSb2FkbWFwKGJhc2UsICdNMDAxJywgYCMgTTAwMTogVGVzdCBNaWxlc3RvbmVcblxuKipWaXNpb246KiogVGVzdCBleGVjdXRpbmcgcGhhc2UuXG5cbiMjIFNsaWNlc1xuXG4tIFsgXSAqKlMwMTogVGVzdCBTbGljZSoqIFxcYHJpc2s6bG93XFxgIFxcYGRlcGVuZHM6W11cXGBcbiAgPiBBZnRlciB0aGlzOiBTbGljZSBpcyBkb25lLlxuYCk7XG5cbiAgICAgIHdyaXRlUGxhbihiYXNlLCAnTTAwMScsICdTMDEnLCBgIyBTMDE6IFRlc3QgU2xpY2VcblxuKipHb2FsOioqIFRlc3QgZXhlY3V0aW5nLlxuKipEZW1vOioqIFRlc3RzIHBhc3MuXG5cbiMjIFRhc2tzXG5cbi0gWyBdICoqVDAxOiBGaXJzdCoqIFxcYGVzdDoxMG1cXGBcbiAgRmlyc3QgdGFzayBkZXNjcmlwdGlvbi5cblxuLSBbIF0gKipUMDI6IFNlY29uZCoqIFxcYGVzdDoxMG1cXGBcbiAgU2Vjb25kIHRhc2sgZGVzY3JpcHRpb24uXG5gKTtcblxuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcblxuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5waGFzZSwgJ2V4ZWN1dGluZycsICdwaGFzZSBpcyBleGVjdXRpbmcnKTtcbiAgICAgIGFzc2VydC5vayhzdGF0ZS5hY3RpdmVUYXNrICE9PSBudWxsLCAnYWN0aXZlVGFzayBpcyBub3QgbnVsbCcpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5hY3RpdmVUYXNrPy5pZCwgJ1QwMScsICdhY3RpdmVUYXNrIGlkIGlzIFQwMScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5wcm9ncmVzcz8udGFza3M/LmRvbmUsIDAsICd0YXNrcyBkb25lID0gMCcpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5wcm9ncmVzcz8udGFza3M/LnRvdGFsLCAyLCAndGFza3MgdG90YWwgPSAyJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCA1OiBleGVjdXRpbmcgKyBjb250aW51ZSBmaWxlIFx1MjE5MiByZXN1bWUgbWVzc2FnZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgdGVzdCgnZXhlY3V0aW5nICsgY29udGludWUgZmlsZSBcdTIxOTIgcmVzdW1lIG1lc3NhZ2UnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCAnTTAwMScsIGAjIE0wMDE6IFRlc3QgTWlsZXN0b25lXG5cbioqVmlzaW9uOioqIFRlc3QgaW50ZXJydXB0ZWQgcmVzdW1lLlxuXG4jIyBTbGljZXNcblxuLSBbIF0gKipTMDE6IFRlc3QgU2xpY2UqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXG4gID4gQWZ0ZXIgdGhpczogU2xpY2UgaXMgZG9uZS5cbmApO1xuXG4gICAgICB3cml0ZVBsYW4oYmFzZSwgJ00wMDEnLCAnUzAxJywgYCMgUzAxOiBUZXN0IFNsaWNlXG5cbioqR29hbDoqKiBUZXN0IGludGVycnVwdGVkLlxuKipEZW1vOioqIFRlc3RzIHBhc3MuXG5cbiMjIFRhc2tzXG5cbi0gWyBdICoqVDAxOiBGaXJzdCBUYXNrKiogXFxgZXN0OjEwbVxcYFxuICBGaXJzdCB0YXNrIGRlc2NyaXB0aW9uLlxuYCk7XG5cbiAgICAgIHdyaXRlQ29udGludWUoYmFzZSwgJ00wMDEnLCAnUzAxJywgYC0tLVxubWlsZXN0b25lOiBNMDAxXG5zbGljZTogUzAxXG50YXNrOiBUMDFcbnN0ZXA6IDJcbnRvdGFsU3RlcHM6IDVcbnN0YXR1czogaW50ZXJydXB0ZWRcbnNhdmVkQXQ6IDIwMjYtMDMtMTBUMTA6MDA6MDBaXG4tLS1cblxuIyBDb250aW51ZTogVDAxXG5cbiMjIENvbXBsZXRlZCBXb3JrXG5TdGVwcyAxIGRvbmUuXG5cbiMjIFJlbWFpbmluZyBXb3JrXG5TdGVwcyAyLTUuXG5cbiMjIE5leHQgQWN0aW9uXG5Db250aW51ZSBmcm9tIHN0ZXAgMi5cbmApO1xuXG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuXG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnBoYXNlLCAnZXhlY3V0aW5nJywgJ2ludGVycnVwdGVkOiBwaGFzZSBpcyBleGVjdXRpbmcnKTtcbiAgICAgIGFzc2VydC5vayhzdGF0ZS5hY3RpdmVUYXNrICE9PSBudWxsLCAnaW50ZXJydXB0ZWQ6IGFjdGl2ZVRhc2sgaXMgbm90IG51bGwnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUuYWN0aXZlVGFzaz8uaWQsICdUMDEnLCAnaW50ZXJydXB0ZWQ6IGFjdGl2ZVRhc2sgaWQgaXMgVDAxJyk7XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgIHN0YXRlLm5leHRBY3Rpb24uaW5jbHVkZXMoJ1Jlc3VtZScpIHx8IHN0YXRlLm5leHRBY3Rpb24uaW5jbHVkZXMoJ3Jlc3VtZScpIHx8IHN0YXRlLm5leHRBY3Rpb24uaW5jbHVkZXMoJ2NvbnRpbnVlLm1kJyksXG4gICAgICAgICdpbnRlcnJ1cHRlZDogbmV4dEFjdGlvbiBtZW50aW9ucyBSZXN1bWUvcmVzdW1lL2NvbnRpbnVlLm1kJ1xuICAgICAgKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0IDY6IGFsbCB0YXNrcyBkb25lLCBzbGljZSBub3QgW3hdIFx1MjE5MiBzdW1tYXJpemluZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgdGVzdCgnYWxsIHRhc2tzIGRvbmUsIHNsaWNlIG5vdCBbeF0gXHUyMTkyIHN1bW1hcml6aW5nJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgJ00wMDEnLCBgIyBNMDAxOiBUZXN0IE1pbGVzdG9uZVxuXG4qKlZpc2lvbjoqKiBUZXN0IHN1bW1hcml6aW5nIHBoYXNlLlxuXG4jIyBTbGljZXNcblxuLSBbIF0gKipTMDE6IFRlc3QgU2xpY2UqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXG4gID4gQWZ0ZXIgdGhpczogU2xpY2UgaXMgZG9uZS5cbmApO1xuXG4gICAgICB3cml0ZVBsYW4oYmFzZSwgJ00wMDEnLCAnUzAxJywgYCMgUzAxOiBUZXN0IFNsaWNlXG5cbioqR29hbDoqKiBUZXN0IHN1bW1hcml6aW5nLlxuKipEZW1vOioqIFRlc3RzIHBhc3MuXG5cbiMjIFRhc2tzXG5cbi0gW3hdICoqVDAxOiBGaXJzdCBEb25lKiogXFxgZXN0OjEwbVxcYFxuICBBbHJlYWR5IGNvbXBsZXRlZC5cblxuLSBbeF0gKipUMDI6IFNlY29uZCBEb25lKiogXFxgZXN0OjEwbVxcYFxuICBBbHNvIGNvbXBsZXRlZC5cbmApO1xuXG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuXG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnBoYXNlLCAnc3VtbWFyaXppbmcnLCAnc3VtbWFyaXppbmc6IHBoYXNlIGlzIHN1bW1hcml6aW5nJyk7XG4gICAgICBhc3NlcnQub2soc3RhdGUuYWN0aXZlU2xpY2UgIT09IG51bGwsICdzdW1tYXJpemluZzogYWN0aXZlU2xpY2UgaXMgbm90IG51bGwnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUuYWN0aXZlU2xpY2U/LmlkLCAnUzAxJywgJ3N1bW1hcml6aW5nOiBhY3RpdmVTbGljZSBpZCBpcyBTMDEnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUuYWN0aXZlVGFzaywgbnVsbCwgJ3N1bW1hcml6aW5nOiBhY3RpdmVUYXNrIGlzIG51bGwnKTtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgc3RhdGUubmV4dEFjdGlvbi50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKCdzdW1tYXJ5JykgfHwgc3RhdGUubmV4dEFjdGlvbi50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKCdjb21wbGV0ZScpLFxuICAgICAgICAnc3VtbWFyaXppbmc6IG5leHRBY3Rpb24gbWVudGlvbnMgc3VtbWFyeSBvciBjb21wbGV0ZSdcbiAgICAgICk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnByb2dyZXNzPy50YXNrcz8uZG9uZSwgMiwgJ3N1bW1hcml6aW5nOiB0YXNrcyBkb25lID0gMicpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5wcm9ncmVzcz8udGFza3M/LnRvdGFsLCAyLCAnc3VtbWFyaXppbmc6IHRhc2tzIHRvdGFsID0gMicpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRlc3QgNzogYWxsIG1pbGVzdG9uZXMgY29tcGxldGUgXHUyMTkyIGNvbXBsZXRlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICB0ZXN0KCdhbGwgbWlsZXN0b25lcyBjb21wbGV0ZSBcdTIxOTIgY29tcGxldGUnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCAnTTAwMScsIGAjIE0wMDE6IFRlc3QgTWlsZXN0b25lXG5cbioqVmlzaW9uOioqIFRlc3QgY29tcGxldGUgcGhhc2UuXG5cbiMjIFNsaWNlc1xuXG4tIFt4XSAqKlMwMTogRG9uZSBTbGljZSoqIFxcYHJpc2s6bG93XFxgIFxcYGRlcGVuZHM6W11cXGBcbiAgPiBBZnRlciB0aGlzOiBEb25lLlxuYCk7XG5cbiAgICAgIHdyaXRlTWlsZXN0b25lVmFsaWRhdGlvbihiYXNlLCAnTTAwMScpO1xuICAgICAgd3JpdGVNaWxlc3RvbmVTdW1tYXJ5KGJhc2UsICdNMDAxJywgYCMgTTAwMSBTdW1tYXJ5XFxuXFxuTWlsZXN0b25lIGNvbXBsZXRlLmApO1xuXG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuXG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnBoYXNlLCAnY29tcGxldGUnLCAnY29tcGxldGU6IHBoYXNlIGlzIGNvbXBsZXRlJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLmFjdGl2ZVNsaWNlLCBudWxsLCAnY29tcGxldGU6IGFjdGl2ZVNsaWNlIGlzIG51bGwnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUuYWN0aXZlVGFzaywgbnVsbCwgJ2NvbXBsZXRlOiBhY3RpdmVUYXNrIGlzIG51bGwnKTtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgc3RhdGUubmV4dEFjdGlvbi50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKCdjb21wbGV0ZScpLFxuICAgICAgICAnY29tcGxldGU6IG5leHRBY3Rpb24gbWVudGlvbnMgY29tcGxldGUnXG4gICAgICApO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5yZWdpc3RyeS5sZW5ndGgsIDEsICdjb21wbGV0ZTogcmVnaXN0cnkgaGFzIDEgZW50cnknKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucmVnaXN0cnlbMF0/LnN0YXR1cywgJ2NvbXBsZXRlJywgJ2NvbXBsZXRlOiByZWdpc3RyeVswXSBzdGF0dXMgaXMgY29tcGxldGUnKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0IDdiOiBjb21wbGV0ZSB3aXRoIGFjdGl2ZSByZXF1aXJlbWVudHMgXHUyMTkyIHN1cmZhY2VzIHVubWFwcGVkIHJlcXMgXHUyNTAwXHUyNTAwXG4gIHRlc3QoJ2NvbXBsZXRlIHdpdGggYWN0aXZlIHJlcXVpcmVtZW50cyBcdTIxOTIgc3VyZmFjZXMgdW5tYXBwZWQgcmVxcycsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVSb2FkbWFwKGJhc2UsICdNMDAxJywgYCMgTTAwMTogVGVzdCBNaWxlc3RvbmVcblxuKipWaXNpb246KiogVGVzdCBjb21wbGV0ZSBwaGFzZSB3aXRoIHVubWFwcGVkIHJlcXVpcmVtZW50cy5cblxuIyMgU2xpY2VzXG5cbi0gW3hdICoqUzAxOiBEb25lIFNsaWNlKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbXVxcYFxuICA+IEFmdGVyIHRoaXM6IERvbmUuXG5gKTtcblxuICAgICAgd3JpdGVNaWxlc3RvbmVWYWxpZGF0aW9uKGJhc2UsICdNMDAxJyk7XG4gICAgICB3cml0ZU1pbGVzdG9uZVN1bW1hcnkoYmFzZSwgJ00wMDEnLCBgIyBNMDAxIFN1bW1hcnlcXG5cXG5NaWxlc3RvbmUgY29tcGxldGUuYCk7XG4gICAgICB3cml0ZVJlcXVpcmVtZW50cyhiYXNlLCBgIyBSZXF1aXJlbWVudHNcblxuIyMgQWN0aXZlXG5cbiMjIyBSRVEwMSBcdTIwMTQgRmlyc3QgYWN0aXZlIHJlcXVpcmVtZW50XG4tIFN0YXR1czogYWN0aXZlXG5cbiMjIyBSRVEwMiBcdTIwMTQgU2Vjb25kIGFjdGl2ZSByZXF1aXJlbWVudFxuLSBTdGF0dXM6IGFjdGl2ZVxuXG4jIyBWYWxpZGF0ZWRcblxuIyMjIFJFUTAzIFx1MjAxNCBWYWxpZGF0ZWQgcmVxdWlyZW1lbnRcbi0gU3RhdHVzOiB2YWxpZGF0ZWRcbmApO1xuXG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuXG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnBoYXNlLCAnY29tcGxldGUnLCAnY29tcGxldGUtd2l0aC1yZXFzOiBwaGFzZSBpcyBjb21wbGV0ZScpO1xuICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICBzdGF0ZS5uZXh0QWN0aW9uLmluY2x1ZGVzKCcyIGFjdGl2ZSByZXF1aXJlbWVudHMnKSxcbiAgICAgICAgJ2NvbXBsZXRlLXdpdGgtcmVxczogbmV4dEFjdGlvbiBtZW50aW9ucyAyIGFjdGl2ZSByZXF1aXJlbWVudHMnXG4gICAgICApO1xuICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICBzdGF0ZS5uZXh0QWN0aW9uLmluY2x1ZGVzKCdSRVFVSVJFTUVOVFMubWQnKSxcbiAgICAgICAgJ2NvbXBsZXRlLXdpdGgtcmVxczogbmV4dEFjdGlvbiBtZW50aW9ucyBSRVFVSVJFTUVOVFMubWQnXG4gICAgICApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRlc3QgN2M6IGNvbXBsZXRlIHdpdGggbm8gYWN0aXZlIHJlcXVpcmVtZW50cyBcdTIxOTIgc3RhbmRhcmQgbWVzc2FnZSBcdTI1MDBcdTI1MDBcbiAgdGVzdCgnY29tcGxldGUgd2l0aCBubyBhY3RpdmUgcmVxdWlyZW1lbnRzIFx1MjE5MiBzdGFuZGFyZCBtZXNzYWdlJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgJ00wMDEnLCBgIyBNMDAxOiBUZXN0IE1pbGVzdG9uZVxuXG4qKlZpc2lvbjoqKiBUZXN0IGNvbXBsZXRlIHBoYXNlIHdpdGggYWxsIHJlcXVpcmVtZW50cyB2YWxpZGF0ZWQuXG5cbiMjIFNsaWNlc1xuXG4tIFt4XSAqKlMwMTogRG9uZSBTbGljZSoqIFxcYHJpc2s6bG93XFxgIFxcYGRlcGVuZHM6W11cXGBcbiAgPiBBZnRlciB0aGlzOiBEb25lLlxuYCk7XG5cbiAgICAgIHdyaXRlTWlsZXN0b25lVmFsaWRhdGlvbihiYXNlLCAnTTAwMScpO1xuICAgICAgd3JpdGVNaWxlc3RvbmVTdW1tYXJ5KGJhc2UsICdNMDAxJywgYCMgTTAwMSBTdW1tYXJ5XFxuXFxuTWlsZXN0b25lIGNvbXBsZXRlLmApO1xuICAgICAgd3JpdGVSZXF1aXJlbWVudHMoYmFzZSwgYCMgUmVxdWlyZW1lbnRzXG5cbiMjIFZhbGlkYXRlZFxuXG4jIyMgUkVRMDEgXHUyMDE0IFZhbGlkYXRlZCByZXF1aXJlbWVudFxuLSBTdGF0dXM6IHZhbGlkYXRlZFxuYCk7XG5cbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG5cbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucGhhc2UsICdjb21wbGV0ZScsICdjb21wbGV0ZS1uby1hY3RpdmUtcmVxczogcGhhc2UgaXMgY29tcGxldGUnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUubmV4dEFjdGlvbiwgJ0FsbCBtaWxlc3RvbmVzIGNvbXBsZXRlLicsICdjb21wbGV0ZS1uby1hY3RpdmUtcmVxczogc3RhbmRhcmQgY29tcGxldGlvbiBtZXNzYWdlJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCA4OiBibG9ja2VkIGRlcGVuZGVuY2llcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgdGVzdCgnYmxvY2tlZCBkZXBlbmRlbmNpZXMnLCBhc3luYyAoKSA9PiB7XG4gICAgLy8gQ2FzZSBBOiBTMDEgYWN0aXZlIChkZXBzIHNhdGlzZmllZCksIFMwMiBibG9ja2VkIG9uIFMwMVxuICAgIGNvbnN0IGJhc2UxID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVSb2FkbWFwKGJhc2UxLCAnTTAwMScsIGAjIE0wMDE6IFRlc3QgTWlsZXN0b25lXG5cbioqVmlzaW9uOioqIFRlc3QgYmxvY2tlZCBkZXBzLlxuXG4jIyBTbGljZXNcblxuLSBbIF0gKipTMDE6IEZpcnN0KiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbXVxcYFxuICA+IEFmdGVyIHRoaXM6IFMwMSBkb25lLlxuXG4tIFsgXSAqKlMwMjogU2Vjb25kKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbUzAxXVxcYFxuICA+IEFmdGVyIHRoaXM6IFMwMiBkb25lLlxuYCk7XG5cbiAgICAgIC8vIFMwMSBoYXMgYSBwbGFuIHdpdGggaW5jb21wbGV0ZSB0YXNrIFx1MjAxNCBpdCdzIHRoZSBhY3RpdmUgc2xpY2VcbiAgICAgIHdyaXRlUGxhbihiYXNlMSwgJ00wMDEnLCAnUzAxJywgYCMgUzAxOiBGaXJzdFxuXG4qKkdvYWw6KiogRmlyc3Qgc2xpY2UuXG4qKkRlbW86KiogVGVzdHMgcGFzcy5cblxuIyMgVGFza3NcblxuLSBbIF0gKipUMDE6IEluY29tcGxldGUqKiBcXGBlc3Q6MTBtXFxgXG4gIFN0aWxsIHdvcmtpbmcuXG5gKTtcblxuICAgICAgY29uc3Qgc3RhdGUxID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZTEpO1xuXG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlMS5waGFzZSwgJ2V4ZWN1dGluZycsICdibG9ja2VkLUE6IHBoYXNlIGlzIGV4ZWN1dGluZyAoUzAxIGFjdGl2ZSknKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUxLmFjdGl2ZVNsaWNlPy5pZCwgJ1MwMScsICdibG9ja2VkLUE6IGFjdGl2ZVNsaWNlIGlzIFMwMScpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UxKTtcbiAgICB9XG5cbiAgICAvLyBDYXNlIEI6IFMwMSBkZXBlbmRzIG9uIG5vbmV4aXN0ZW50IFM5OSAtPiBubyBzbGljZSBpcyBlbGlnaWJsZVxuICAgIGNvbnN0IGJhc2UyID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVSb2FkbWFwKGJhc2UyLCAnTTAwMScsIGAjIE0wMDE6IFRlc3QgTWlsZXN0b25lXG5cbioqVmlzaW9uOioqIFRlc3QgdHJ1bHkgYmxvY2tlZC5cblxuIyMgU2xpY2VzXG5cbi0gWyBdICoqUzAxOiBCbG9ja2VkKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbUzk5XVxcYFxuICA+IEFmdGVyIHRoaXM6IERvbmUuXG5gKTtcblxuICAgICAgY29uc3Qgc3RhdGUyID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZTIpO1xuXG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlMi5waGFzZSwgJ2Jsb2NrZWQnLCAnYmxvY2tlZC1COiBwaGFzZSBpcyBibG9ja2VkIHdoZW4gZGVwZW5kZW5jeSBpcyB1bnNhdGlzZmllZCcpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZTIuYWN0aXZlU2xpY2UsIG51bGwsICdibG9ja2VkLUI6IG5vIGFjdGl2ZVNsaWNlIHNlbGVjdGVkIHRocm91Z2ggdW5tZXQgZGVwcycpO1xuICAgICAgYXNzZXJ0Lm9rKHN0YXRlMi5ibG9ja2Vycy5zb21lKGIgPT4gYi5pbmNsdWRlcygnTm8gc2xpY2UgZWxpZ2libGUnKSksICdibG9ja2VkLUI6IGJsb2NrZXIgZXhwbGFpbnMgbm8gZWxpZ2libGUgc2xpY2UnKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlMik7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCA5OiBtdWx0aS1taWxlc3RvbmUgcmVnaXN0cnkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIHRlc3QoJ211bHRpLW1pbGVzdG9uZSByZWdpc3RyeScsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgLy8gTTAwMTogY29tcGxldGUgKGFsbCBzbGljZXMgZG9uZSlcbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCAnTTAwMScsIGAjIE0wMDE6IEZpcnN0IE1pbGVzdG9uZVxuXG4qKlZpc2lvbjoqKiBBbHJlYWR5IGRvbmUuXG5cbiMjIFNsaWNlc1xuXG4tIFt4XSAqKlMwMTogRG9uZSoqIFxcYHJpc2s6bG93XFxgIFxcYGRlcGVuZHM6W11cXGBcbiAgPiBBZnRlciB0aGlzOiBEb25lLlxuYCk7XG5cbiAgICAgIHdyaXRlTWlsZXN0b25lVmFsaWRhdGlvbihiYXNlLCAnTTAwMScpO1xuICAgICAgd3JpdGVNaWxlc3RvbmVTdW1tYXJ5KGJhc2UsICdNMDAxJywgYCMgTTAwMSBTdW1tYXJ5XFxuXFxuRmlyc3QgbWlsZXN0b25lIGNvbXBsZXRlLmApO1xuXG4gICAgICAvLyBNMDAyOiBhY3RpdmUgKGhhcyBpbmNvbXBsZXRlIHNsaWNlcylcbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCAnTTAwMicsIGAjIE0wMDI6IFNlY29uZCBNaWxlc3RvbmVcblxuKipWaXNpb246KiogQ3VycmVudGx5IGFjdGl2ZS5cblxuIyMgU2xpY2VzXG5cbi0gWyBdICoqUzAxOiBJbiBQcm9ncmVzcyoqIFxcYHJpc2s6bG93XFxgIFxcYGRlcGVuZHM6W11cXGBcbiAgPiBBZnRlciB0aGlzOiBEb25lLlxuYCk7XG5cbiAgICAgIC8vIE0wMDM6IGRpciB3aXRoIENPTlRFWFQgYnV0IG5vIHJvYWRtYXAgXHUyMTkyIHBlbmRpbmcgc2luY2UgTTAwMiBpcyBhbHJlYWR5IGFjdGl2ZVxuICAgICAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAzJyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMycsICdNMDAzLUNPTlRFWFQubWQnKSwgJyMgVGhpcmQgTWlsZXN0b25lXFxuXFxuQ29udGV4dCBmb3IgTTAwMy4nKTtcblxuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcblxuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5yZWdpc3RyeS5sZW5ndGgsIDMsICdtdWx0aS1tczogcmVnaXN0cnkgaGFzIDMgZW50cmllcycpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5yZWdpc3RyeVswXT8uaWQsICdNMDAxJywgJ211bHRpLW1zOiByZWdpc3RyeVswXSBpcyBNMDAxJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnJlZ2lzdHJ5WzBdPy5zdGF0dXMsICdjb21wbGV0ZScsICdtdWx0aS1tczogTTAwMSBpcyBjb21wbGV0ZScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5yZWdpc3RyeVsxXT8uaWQsICdNMDAyJywgJ211bHRpLW1zOiByZWdpc3RyeVsxXSBpcyBNMDAyJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnJlZ2lzdHJ5WzFdPy5zdGF0dXMsICdhY3RpdmUnLCAnbXVsdGktbXM6IE0wMDIgaXMgYWN0aXZlJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnJlZ2lzdHJ5WzJdPy5pZCwgJ00wMDMnLCAnbXVsdGktbXM6IHJlZ2lzdHJ5WzJdIGlzIE0wMDMnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucmVnaXN0cnlbMl0/LnN0YXR1cywgJ3BlbmRpbmcnLCAnbXVsdGktbXM6IE0wMDMgaXMgcGVuZGluZycpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5hY3RpdmVNaWxlc3RvbmU/LmlkLCAnTTAwMicsICdtdWx0aS1tczogYWN0aXZlTWlsZXN0b25lIGlzIE0wMDInKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucHJvZ3Jlc3M/Lm1pbGVzdG9uZXM/LmRvbmUsIDEsICdtdWx0aS1tczogbWlsZXN0b25lcyBkb25lID0gMScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5wcm9ncmVzcz8ubWlsZXN0b25lcz8udG90YWwsIDMsICdtdWx0aS1tczogbWlsZXN0b25lcyB0b3RhbCA9IDMnKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0IDEwOiByZXF1aXJlbWVudHMgaW50ZWdyYXRpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIHRlc3QoJ3JlcXVpcmVtZW50cyBpbnRlZ3JhdGlvbicsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVSZXF1aXJlbWVudHMoYmFzZSwgYCMgUmVxdWlyZW1lbnRzXG5cbiMjIEFjdGl2ZVxuXG4jIyMgUjAwMSBcdTIwMTQgRmlyc3QgQWN0aXZlIFJlcXVpcmVtZW50XG4tIFN0YXR1czogYWN0aXZlXG4tIERlc2NyaXB0aW9uOiBTb21ldGhpbmcgYWN0aXZlLlxuXG4jIyMgUjAwMiBcdTIwMTQgU2Vjb25kIEFjdGl2ZSBSZXF1aXJlbWVudFxuLSBTdGF0dXM6IGFjdGl2ZVxuLSBEZXNjcmlwdGlvbjogQW5vdGhlciBhY3RpdmUgb25lLlxuXG4jIyBWYWxpZGF0ZWRcblxuIyMjIFIwMDMgXHUyMDE0IFZhbGlkYXRlZCBSZXF1aXJlbWVudFxuLSBTdGF0dXM6IHZhbGlkYXRlZFxuLSBEZXNjcmlwdGlvbjogQWxyZWFkeSB2YWxpZGF0ZWQuXG5cbiMjIERlZmVycmVkXG5cbiMjIyBSMDA0IFx1MjAxNCBEZWZlcnJlZCBSZXF1aXJlbWVudFxuLSBTdGF0dXM6IGRlZmVycmVkXG4tIERlc2NyaXB0aW9uOiBQdXNoZWQgYmFjay5cblxuIyMjIFIwMDUgXHUyMDE0IEFub3RoZXIgRGVmZXJyZWRcbi0gU3RhdHVzOiBkZWZlcnJlZFxuLSBEZXNjcmlwdGlvbjogQWxzbyBkZWZlcnJlZC5cblxuIyMgT3V0IG9mIFNjb3BlXG5cbiMjIyBSMDA2IFx1MjAxNCBPdXQgb2YgU2NvcGUgUmVxdWlyZW1lbnRcbi0gU3RhdHVzOiBvdXQtb2Ytc2NvcGVcbi0gRGVzY3JpcHRpb246IE5vdCBkb2luZyB0aGlzLlxuYCk7XG5cbiAgICAgIC8vIE5lZWQgYXQgbGVhc3QgYW4gZW1wdHkgbWlsZXN0b25lcyBkaXIgZm9yIGRlcml2ZVN0YXRlXG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuXG4gICAgICBhc3NlcnQub2soc3RhdGUucmVxdWlyZW1lbnRzICE9PSB1bmRlZmluZWQsICdyZXF1aXJlbWVudHM6IHJlcXVpcmVtZW50cyBvYmplY3QgZXhpc3RzJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnJlcXVpcmVtZW50cz8uYWN0aXZlLCAyLCAncmVxdWlyZW1lbnRzOiBhY3RpdmUgPSAyJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnJlcXVpcmVtZW50cz8udmFsaWRhdGVkLCAxLCAncmVxdWlyZW1lbnRzOiB2YWxpZGF0ZWQgPSAxJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnJlcXVpcmVtZW50cz8uZGVmZXJyZWQsIDIsICdyZXF1aXJlbWVudHM6IGRlZmVycmVkID0gMicpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5yZXF1aXJlbWVudHM/Lm91dE9mU2NvcGUsIDEsICdyZXF1aXJlbWVudHM6IG91dE9mU2NvcGUgPSAxJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnJlcXVpcmVtZW50cz8udG90YWwsIDYsICdyZXF1aXJlbWVudHM6IHRvdGFsID0gNiAoc3VtIG9mIGFsbCknKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0IDExOiBhbGwgc2xpY2VzIFt4XSwgbm8gc3VtbWFyeSBcdTIxOTIgY29tcGxldGluZy1taWxlc3RvbmUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIHRlc3QoJ2FsbCBzbGljZXMgW3hdLCBubyBzdW1tYXJ5IFx1MjE5MiBjb21wbGV0aW5nLW1pbGVzdG9uZScsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVSb2FkbWFwKGJhc2UsICdNMDAxJywgYCMgTTAwMTogVGVzdCBNaWxlc3RvbmVcblxuKipWaXNpb246KiogVGVzdCBjb21wbGV0aW5nLW1pbGVzdG9uZSBwaGFzZS5cblxuIyMgU2xpY2VzXG5cbi0gW3hdICoqUzAxOiBGaXJzdCBEb25lKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbXVxcYFxuICA+IEFmdGVyIHRoaXM6IFMwMSBjb21wbGV0ZS5cblxuLSBbeF0gKipTMDI6IFNlY29uZCBEb25lKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbUzAxXVxcYFxuICA+IEFmdGVyIHRoaXM6IFMwMiBjb21wbGV0ZS5cbmApO1xuXG4gICAgICB3cml0ZU1pbGVzdG9uZVZhbGlkYXRpb24oYmFzZSwgJ00wMDEnKTtcblxuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcblxuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5waGFzZSwgJ2NvbXBsZXRpbmctbWlsZXN0b25lJywgJ2NvbXBsZXRpbmctbXM6IHBoYXNlIGlzIGNvbXBsZXRpbmctbWlsZXN0b25lJyk7XG4gICAgICBhc3NlcnQub2soc3RhdGUuYWN0aXZlTWlsZXN0b25lICE9PSBudWxsLCAnY29tcGxldGluZy1tczogYWN0aXZlTWlsZXN0b25lIGlzIG5vdCBudWxsJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQsICdNMDAxJywgJ2NvbXBsZXRpbmctbXM6IGFjdGl2ZU1pbGVzdG9uZSBpZCBpcyBNMDAxJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLmFjdGl2ZVNsaWNlLCBudWxsLCAnY29tcGxldGluZy1tczogYWN0aXZlU2xpY2UgaXMgbnVsbCcpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5hY3RpdmVUYXNrLCBudWxsLCAnY29tcGxldGluZy1tczogYWN0aXZlVGFzayBpcyBudWxsJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnJlZ2lzdHJ5Lmxlbmd0aCwgMSwgJ2NvbXBsZXRpbmctbXM6IHJlZ2lzdHJ5IGhhcyAxIGVudHJ5Jyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnJlZ2lzdHJ5WzBdPy5zdGF0dXMsICdhY3RpdmUnLCAnY29tcGxldGluZy1tczogcmVnaXN0cnlbMF0gc3RhdHVzIGlzIGFjdGl2ZSAobm90IGNvbXBsZXRlKScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5wcm9ncmVzcz8uc2xpY2VzPy5kb25lLCAyLCAnY29tcGxldGluZy1tczogc2xpY2VzIGRvbmUgPSAyJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnByb2dyZXNzPy5zbGljZXM/LnRvdGFsLCAyLCAnY29tcGxldGluZy1tczogc2xpY2VzIHRvdGFsID0gMicpO1xuICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICBzdGF0ZS5uZXh0QWN0aW9uLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoJ3N1bW1hcnknKSB8fCBzdGF0ZS5uZXh0QWN0aW9uLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoJ2NvbXBsZXRlJyksXG4gICAgICAgICdjb21wbGV0aW5nLW1zOiBuZXh0QWN0aW9uIG1lbnRpb25zIHN1bW1hcnkgb3IgY29tcGxldGUnXG4gICAgICApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRlc3QgMTI6IGFsbCBzbGljZXMgW3hdLCBzdW1tYXJ5IGV4aXN0cyBcdTIxOTIgY29tcGxldGUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIHRlc3QoJ2FsbCBzbGljZXMgW3hdLCBzdW1tYXJ5IGV4aXN0cyBcdTIxOTIgY29tcGxldGUnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCAnTTAwMScsIGAjIE0wMDE6IFRlc3QgTWlsZXN0b25lXG5cbioqVmlzaW9uOioqIFRlc3QgdGhhdCBzdW1tYXJ5IHByZXNlbmNlIG1lYW5zIGNvbXBsZXRlLlxuXG4jIyBTbGljZXNcblxuLSBbeF0gKipTMDE6IERvbmUqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXG4gID4gQWZ0ZXIgdGhpczogRG9uZS5cbmApO1xuXG4gICAgICB3cml0ZU1pbGVzdG9uZVZhbGlkYXRpb24oYmFzZSwgJ00wMDEnKTtcbiAgICAgIHdyaXRlTWlsZXN0b25lU3VtbWFyeShiYXNlLCAnTTAwMScsIGAjIE0wMDEgU3VtbWFyeVxcblxcbk1pbGVzdG9uZSBpcyBjb21wbGV0ZS5gKTtcblxuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcblxuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5waGFzZSwgJ2NvbXBsZXRlJywgJ3N1bW1hcnktZXhpc3RzOiBwaGFzZSBpcyBjb21wbGV0ZScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5yZWdpc3RyeS5sZW5ndGgsIDEsICdzdW1tYXJ5LWV4aXN0czogcmVnaXN0cnkgaGFzIDEgZW50cnknKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucmVnaXN0cnlbMF0/LnN0YXR1cywgJ2NvbXBsZXRlJywgJ3N1bW1hcnktZXhpc3RzOiByZWdpc3RyeVswXSBzdGF0dXMgaXMgY29tcGxldGUnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUuYWN0aXZlU2xpY2UsIG51bGwsICdzdW1tYXJ5LWV4aXN0czogYWN0aXZlU2xpY2UgaXMgbnVsbCcpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5hY3RpdmVUYXNrLCBudWxsLCAnc3VtbWFyeS1leGlzdHM6IGFjdGl2ZVRhc2sgaXMgbnVsbCcpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRlc3QgMTM6IG11bHRpLW1pbGVzdG9uZSBjb21wbGV0aW5nLW1pbGVzdG9uZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgdGVzdCgnbXVsdGktbWlsZXN0b25lIGNvbXBsZXRpbmctbWlsZXN0b25lJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICAvLyBNMDAxOiBhbGwgc2xpY2VzIGRvbmUgKyBzdW1tYXJ5IGV4aXN0cyBcdTIxOTIgY29tcGxldGVcbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCAnTTAwMScsIGAjIE0wMDE6IEZpcnN0IE1pbGVzdG9uZVxuXG4qKlZpc2lvbjoqKiBBbHJlYWR5IGNvbXBsZXRlIHdpdGggc3VtbWFyeS5cblxuIyMgU2xpY2VzXG5cbi0gW3hdICoqUzAxOiBEb25lKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbXVxcYFxuICA+IEFmdGVyIHRoaXM6IERvbmUuXG5gKTtcbiAgICAgIHdyaXRlTWlsZXN0b25lVmFsaWRhdGlvbihiYXNlLCAnTTAwMScpO1xuICAgICAgd3JpdGVNaWxlc3RvbmVTdW1tYXJ5KGJhc2UsICdNMDAxJywgYCMgTTAwMSBTdW1tYXJ5XFxuXFxuRmlyc3QgbWlsZXN0b25lIGNvbXBsZXRlLmApO1xuXG4gICAgICAvLyBNMDAyOiBhbGwgc2xpY2VzIGRvbmUsIG5vIHN1bW1hcnkgXHUyMTkyIGNvbXBsZXRpbmctbWlsZXN0b25lXG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgJ00wMDInLCBgIyBNMDAyOiBTZWNvbmQgTWlsZXN0b25lXG5cbioqVmlzaW9uOioqIEFsbCBzbGljZXMgZG9uZSBidXQgbm8gc3VtbWFyeS5cblxuIyMgU2xpY2VzXG5cbi0gW3hdICoqUzAxOiBEb25lKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbXVxcYFxuICA+IEFmdGVyIHRoaXM6IERvbmUuXG5cbi0gW3hdICoqUzAyOiBBbHNvIERvbmUqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltTMDFdXFxgXG4gID4gQWZ0ZXIgdGhpczogRG9uZS5cbmApO1xuXG4gICAgICB3cml0ZU1pbGVzdG9uZVZhbGlkYXRpb24oYmFzZSwgJ00wMDInKTtcblxuICAgICAgLy8gTTAwMzogaGFzIGluY29tcGxldGUgc2xpY2VzIFx1MjE5MiBwZW5kaW5nIChNMDAyIGlzIGFjdGl2ZSlcbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCAnTTAwMycsIGAjIE0wMDM6IFRoaXJkIE1pbGVzdG9uZVxuXG4qKlZpc2lvbjoqKiBOb3QgeWV0IHN0YXJ0ZWQuXG5cbiMjIFNsaWNlc1xuXG4tIFsgXSAqKlMwMTogTm90IFN0YXJ0ZWQqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXG4gID4gQWZ0ZXIgdGhpczogRG9uZS5cbmApO1xuXG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuXG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnBoYXNlLCAnY29tcGxldGluZy1taWxlc3RvbmUnLCAnbXVsdGktY29tcGxldGluZzogcGhhc2UgaXMgY29tcGxldGluZy1taWxlc3RvbmUnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUuYWN0aXZlTWlsZXN0b25lPy5pZCwgJ00wMDInLCAnbXVsdGktY29tcGxldGluZzogYWN0aXZlTWlsZXN0b25lIGlzIE0wMDInKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUuYWN0aXZlU2xpY2UsIG51bGwsICdtdWx0aS1jb21wbGV0aW5nOiBhY3RpdmVTbGljZSBpcyBudWxsJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLmFjdGl2ZVRhc2ssIG51bGwsICdtdWx0aS1jb21wbGV0aW5nOiBhY3RpdmVUYXNrIGlzIG51bGwnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucmVnaXN0cnkubGVuZ3RoLCAzLCAnbXVsdGktY29tcGxldGluZzogcmVnaXN0cnkgaGFzIDMgZW50cmllcycpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5yZWdpc3RyeVswXT8uaWQsICdNMDAxJywgJ211bHRpLWNvbXBsZXRpbmc6IHJlZ2lzdHJ5WzBdIGlzIE0wMDEnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucmVnaXN0cnlbMF0/LnN0YXR1cywgJ2NvbXBsZXRlJywgJ211bHRpLWNvbXBsZXRpbmc6IE0wMDEgaXMgY29tcGxldGUnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucmVnaXN0cnlbMV0/LmlkLCAnTTAwMicsICdtdWx0aS1jb21wbGV0aW5nOiByZWdpc3RyeVsxXSBpcyBNMDAyJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnJlZ2lzdHJ5WzFdPy5zdGF0dXMsICdhY3RpdmUnLCAnbXVsdGktY29tcGxldGluZzogTTAwMiBpcyBhY3RpdmUgKGNvbXBsZXRpbmctbWlsZXN0b25lKScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5yZWdpc3RyeVsyXT8uaWQsICdNMDAzJywgJ211bHRpLWNvbXBsZXRpbmc6IHJlZ2lzdHJ5WzJdIGlzIE0wMDMnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucmVnaXN0cnlbMl0/LnN0YXR1cywgJ3BlbmRpbmcnLCAnbXVsdGktY29tcGxldGluZzogTTAwMyBpcyBwZW5kaW5nJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnByb2dyZXNzPy5taWxlc3RvbmVzPy5kb25lLCAxLCAnbXVsdGktY29tcGxldGluZzogbWlsZXN0b25lcyBkb25lID0gMScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5wcm9ncmVzcz8ubWlsZXN0b25lcz8udG90YWwsIDMsICdtdWx0aS1jb21wbGV0aW5nOiBtaWxlc3RvbmVzIHRvdGFsID0gMycpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5wcm9ncmVzcz8uc2xpY2VzPy5kb25lLCAyLCAnbXVsdGktY29tcGxldGluZzogc2xpY2VzIGRvbmUgPSAyJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnByb2dyZXNzPy5zbGljZXM/LnRvdGFsLCAyLCAnbXVsdGktY29tcGxldGluZzogc2xpY2VzIHRvdGFsID0gMicpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gXHUyNTUwXHUyNTUwXHUyNTUwIE1pbGVzdG9uZSB3aXRoIHN1bW1hcnkgYnV0IG5vIHJvYWRtYXAgXHUyMTkyIGNvbXBsZXRlIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuICB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIC8vIE0wMDEsIE0wMDI6IGNvbXBsZXRlZCBtaWxlc3RvbmVzIHdpdGggc3VtbWFyaWVzIGJ1dCBubyByb2FkbWFwc1xuICAgICAgY29uc3QgbTFkaXIgPSBqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScpO1xuICAgICAgbWtkaXJTeW5jKG0xZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihtMWRpciwgJ00wMDEtU1VNTUFSWS5tZCcpLCAnLS0tXFxuaWQ6IE0wMDFcXG4tLS1cXG4jIEJvb3RzdHJhcFxcbkRvbmUuJyk7XG5cbiAgICAgIGNvbnN0IG0yZGlyID0gam9pbihiYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgJ00wMDInKTtcbiAgICAgIG1rZGlyU3luYyhtMmRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4obTJkaXIsICdNMDAyLVNVTU1BUlkubWQnKSwgJy0tLVxcbmlkOiBNMDAyXFxuLS0tXFxuIyBDb3JlIEZlYXR1cmVzXFxuRG9uZS4nKTtcblxuICAgICAgLy8gTTAwMzogYWN0aXZlIG1pbGVzdG9uZSB3aXRoIGEgcm9hZG1hcFxuICAgICAgd3JpdGVSb2FkbWFwKGJhc2UsICdNMDAzJywgJyMgTTAwMzogUG9saXNoXFxuIyMgU2xpY2VzXFxuLSBbIF0gKipTMDE6IENsZWFudXAqKicpO1xuXG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuXG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnBoYXNlLCAncGxhbm5pbmcnLCAnc3VtbWFyeS1uby1yb2FkbWFwOiBwaGFzZSBpcyBwbGFubmluZyAoYWN0aXZlIGlzIE0wMDMpJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQsICdNMDAzJywgJ3N1bW1hcnktbm8tcm9hZG1hcDogYWN0aXZlIG1pbGVzdG9uZSBpcyBNMDAzJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8udGl0bGUsICdQb2xpc2gnLCAnc3VtbWFyeS1uby1yb2FkbWFwOiBhY3RpdmUgdGl0bGUgaXMgUG9saXNoJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnJlZ2lzdHJ5Lmxlbmd0aCwgMywgJ3N1bW1hcnktbm8tcm9hZG1hcDogcmVnaXN0cnkgaGFzIDMgZW50cmllcycpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5yZWdpc3RyeVswXT8uc3RhdHVzLCAnY29tcGxldGUnLCAnc3VtbWFyeS1uby1yb2FkbWFwOiBNMDAxIGlzIGNvbXBsZXRlJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnJlZ2lzdHJ5WzBdPy50aXRsZSwgJ0Jvb3RzdHJhcCcsICdzdW1tYXJ5LW5vLXJvYWRtYXA6IE0wMDEgdGl0bGUgZnJvbSBzdW1tYXJ5Jyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnJlZ2lzdHJ5WzFdPy5zdGF0dXMsICdjb21wbGV0ZScsICdzdW1tYXJ5LW5vLXJvYWRtYXA6IE0wMDIgaXMgY29tcGxldGUnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucmVnaXN0cnlbMV0/LnRpdGxlLCAnQ29yZSBGZWF0dXJlcycsICdzdW1tYXJ5LW5vLXJvYWRtYXA6IE0wMDIgdGl0bGUgZnJvbSBzdW1tYXJ5Jyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnJlZ2lzdHJ5WzJdPy5zdGF0dXMsICdhY3RpdmUnLCAnc3VtbWFyeS1uby1yb2FkbWFwOiBNMDAzIGlzIGFjdGl2ZScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5wcm9ncmVzcz8ubWlsZXN0b25lcz8uZG9uZSwgMiwgJ3N1bW1hcnktbm8tcm9hZG1hcDogbWlsZXN0b25lcyBkb25lID0gMicpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5wcm9ncmVzcz8ubWlsZXN0b25lcz8udG90YWwsIDMsICdzdW1tYXJ5LW5vLXJvYWRtYXA6IG1pbGVzdG9uZXMgdG90YWwgPSAzJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9XG5cbiAgLy8gXHUyNTUwXHUyNTUwXHUyNTUwIEFsbCBtaWxlc3RvbmVzIGhhdmUgc3VtbWFyeSBidXQgbm8gcm9hZG1hcCBcdTIxOTIgY29tcGxldGUgXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4gIHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgbTFkaXIgPSBqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScpO1xuICAgICAgbWtkaXJTeW5jKG0xZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihtMWRpciwgJ00wMDEtU1VNTUFSWS5tZCcpLCAnLS0tXFxudGl0bGU6IERvbmVcXG4tLS1cXG5BbGwgZG9uZS4nKTtcblxuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucGhhc2UsICdjb21wbGV0ZScsICdhbGwtc3VtbWFyeS1vbmx5OiBwaGFzZSBpcyBjb21wbGV0ZScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5yZWdpc3RyeVswXT8uc3RhdHVzLCAnY29tcGxldGUnLCAnYWxsLXN1bW1hcnktb25seTogTTAwMSBpcyBjb21wbGV0ZScpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBFbXB0eSBwbGFuICh6ZXJvIHRhc2tzKSBzdGF5cyBpbiBwbGFubmluZywgbm90IHN1bW1hcml6aW5nICgjNDU0KSBcdTI1MDBcdTI1MDBcbiAgdGVzdCgnZW1wdHkgcGxhbiBcdTIxOTIgcGxhbm5pbmcgKG5vdCBzdW1tYXJpemluZyknLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCAnTTAwMScsIGAtLS1cbmlkOiBNMDAxXG50aXRsZTogXCJUZXN0XCJcbi0tLVxuIyBNMDAxOiBUZXN0XG4jIyBWaXNpb25cblRlc3RcbiMjIFN1Y2Nlc3MgQ3JpdGVyaWFcbi0gRG9uZVxuIyMgU2xpY2VzXG4tIFsgXSAqKlMwMTogRW1wdHkgc2xpY2UqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXG4gID4gVGVzdFxuIyMgQm91bmRhcnkgTWFwXG5fTm9uZV9cbmApO1xuICAgICAgd3JpdGVQbGFuKGJhc2UsICdNMDAxJywgJ1MwMScsIGAtLS1cbnNsaWNlOiBTMDFcbi0tLVxuIyBTMDEgUGxhblxuIyMgVGFza3NcbmApO1xuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucGhhc2UsICdwbGFubmluZycsICdlbXB0eSBwbGFuIHN0YXlzIGluIHBsYW5uaW5nJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLmFjdGl2ZVNsaWNlPy5pZCwgJ1MwMScsICdhY3RpdmUgc2xpY2UgaXMgUzAxJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLmFjdGl2ZVRhc2ssIG51bGwsICdubyBhY3RpdmUgdGFzaycpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRlc3Q6IGNvbXBsZXRlZCBNMDAxIChzdW1tYXJ5LCBubyB2YWxpZGF0aW9uKSBza2lwcGVkIGZvciBhY3RpdmUgTTAwMyAoIzg2NCkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIHRlc3QoJ2NvbXBsZXRlZCBtaWxlc3RvbmUgd2l0aCBzdW1tYXJ5IGJ1dCBubyB2YWxpZGF0aW9uIGlzIG5vdCBhY3RpdmUgKCM4NjQpJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICAvLyBNMDAxOiBhbGwgc2xpY2VzIGRvbmUsIGhhcyBzdW1tYXJ5LCBubyB2YWxpZGF0aW9uXG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgJ00wMDEnLCBgIyBNMDAxOiBGaXJzdCBNaWxlc3RvbmVcXG5cXG4qKlZpc2lvbjoqKiBEb25lLlxcblxcbiMjIFNsaWNlc1xcblxcbi0gW3hdICoqUzAxOiBEb25lIHNsaWNlKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbXVxcYFxcbiAgPiBDb21wbGV0ZWQuXFxuYCk7XG4gICAgICB3cml0ZU1pbGVzdG9uZVN1bW1hcnkoYmFzZSwgJ00wMDEnLCAnLS0tXFxuaWQ6IE0wMDFcXG4tLS1cXG5cXG4jIE0wMDE6IEZpcnN0IE1pbGVzdG9uZVxcblxcbioqQ29tcGxldGVkLioqJyk7XG4gICAgICAvLyBNMDAzOiBpbmNvbXBsZXRlLCBzaG91bGQgYmUgYWN0aXZlXG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgJ00wMDMnLCBgIyBNMDAzOiBBY3RpdmUgTWlsZXN0b25lXFxuXFxuKipWaXNpb246KiogRG8gc3R1ZmYuXFxuXFxuIyMgU2xpY2VzXFxuXFxuLSBbIF0gKipTMDE6IFdvcmsgc2xpY2UqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXFxuICA+IE5lZWRzIHdvcmsuXFxuYCk7XG5cbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQsICdNMDAzJywgJ2FjdGl2ZSBtaWxlc3RvbmUgaXMgTTAwMywgbm90IGNvbXBsZXRlZCBNMDAxJyk7XG4gICAgICBjb25zdCBtMDAxRW50cnkgPSBzdGF0ZS5yZWdpc3RyeS5maW5kKGUgPT4gZS5pZCA9PT0gJ00wMDEnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwobTAwMUVudHJ5Py5zdGF0dXMsICdjb21wbGV0ZScsICdNMDAxIGlzIG1hcmtlZCBjb21wbGV0ZSBkZXNwaXRlIG5vIHZhbGlkYXRpb24nKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0OiBjb21wbGV0ZWQgTTAwMSB3aXRoIHN1bW1hcnkgQU5EIHZhbGlkYXRpb24gaXMgY29tcGxldGUgKCM4NjQpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICB0ZXN0KCdjb21wbGV0ZWQgbWlsZXN0b25lIHdpdGggc3VtbWFyeSBhbmQgdmFsaWRhdGlvbiBpcyBjb21wbGV0ZScsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVSb2FkbWFwKGJhc2UsICdNMDAxJywgYCMgTTAwMTogRmlyc3QgTWlsZXN0b25lXFxuXFxuKipWaXNpb246KiogRG9uZS5cXG5cXG4jIyBTbGljZXNcXG5cXG4tIFt4XSAqKlMwMTogRG9uZSBzbGljZSoqIFxcYHJpc2s6bG93XFxgIFxcYGRlcGVuZHM6W11cXGBcXG4gID4gQ29tcGxldGVkLlxcbmApO1xuICAgICAgd3JpdGVNaWxlc3RvbmVTdW1tYXJ5KGJhc2UsICdNMDAxJywgJy0tLVxcbmlkOiBNMDAxXFxuLS0tXFxuXFxuIyBNMDAxOiBGaXJzdCBNaWxlc3RvbmVcXG5cXG4qKkNvbXBsZXRlZC4qKicpO1xuICAgICAgd3JpdGVNaWxlc3RvbmVWYWxpZGF0aW9uKGJhc2UsICdNMDAxJywgJ3Bhc3MnKTtcbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCAnTTAwMycsIGAjIE0wMDM6IEFjdGl2ZSBNaWxlc3RvbmVcXG5cXG4qKlZpc2lvbjoqKiBEbyBzdHVmZi5cXG5cXG4jIyBTbGljZXNcXG5cXG4tIFsgXSAqKlMwMTogV29yayBzbGljZSoqIFxcYHJpc2s6bG93XFxgIFxcYGRlcGVuZHM6W11cXGBcXG4gID4gTmVlZHMgd29yay5cXG5gKTtcblxuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUuYWN0aXZlTWlsZXN0b25lPy5pZCwgJ00wMDMnLCAnYWN0aXZlIG1pbGVzdG9uZSBpcyBNMDAzJyk7XG4gICAgICBjb25zdCBtMDAxRW50cnkgPSBzdGF0ZS5yZWdpc3RyeS5maW5kKGUgPT4gZS5pZCA9PT0gJ00wMDEnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwobTAwMUVudHJ5Py5zdGF0dXMsICdjb21wbGV0ZScsICdNMDAxIHdpdGggYm90aCBzdW1tYXJ5IGFuZCB2YWxpZGF0aW9uIGlzIGNvbXBsZXRlJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdDogYWxsIHNsaWNlcyBkb25lLCBubyBzdW1tYXJ5LCBubyB2YWxpZGF0aW9uIFx1MjE5MiBuZWVkcyB2YWxpZGF0aW9uICgjODY0KSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgdGVzdCgnYWxsIHNsaWNlcyBkb25lLCBubyBzdW1tYXJ5LCBubyB2YWxpZGF0aW9uIFx1MjE5MiB2YWxpZGF0aW5nLW1pbGVzdG9uZScsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVSb2FkbWFwKGJhc2UsICdNMDAxJywgYCMgTTAwMTogRmlyc3QgTWlsZXN0b25lXFxuXFxuKipWaXNpb246KiogVmFsaWRhdGUgbWUuXFxuXFxuIyMgU2xpY2VzXFxuXFxuLSBbeF0gKipTMDE6IERvbmUgc2xpY2UqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXFxuICA+IENvbXBsZXRlZC5cXG5gKTtcbiAgICAgIC8vIE5vIHN1bW1hcnksIG5vIHZhbGlkYXRpb24gXHUyMDE0IHRoaXMgc2hvdWxkIGJlIGFjdGl2ZSBmb3IgdmFsaWRhdGlvblxuXG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5hY3RpdmVNaWxlc3RvbmU/LmlkLCAnTTAwMScsICdNMDAxIGlzIGFjdGl2ZSBmb3IgdmFsaWRhdGlvbicpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRlc3Q6IGFsbCBzbGljZXMgZG9uZSwgdmFsaWRhdGlvbiBwYXNzLCBubyBzdW1tYXJ5IFx1MjE5MiBuZWVkcyBjb21wbGV0aW9uICgjODY0KSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgdGVzdCgnYWxsIHNsaWNlcyBkb25lLCB2YWxpZGF0aW9uIHBhc3MsIG5vIHN1bW1hcnkgXHUyMTkyIGNvbXBsZXRpbmctbWlsZXN0b25lJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgJ00wMDEnLCBgIyBNMDAxOiBGaXJzdCBNaWxlc3RvbmVcXG5cXG4qKlZpc2lvbjoqKiBDb21wbGV0ZSBtZS5cXG5cXG4jIyBTbGljZXNcXG5cXG4tIFt4XSAqKlMwMTogRG9uZSBzbGljZSoqIFxcYHJpc2s6bG93XFxgIFxcYGRlcGVuZHM6W11cXGBcXG4gID4gQ29tcGxldGVkLlxcbmApO1xuICAgICAgd3JpdGVNaWxlc3RvbmVWYWxpZGF0aW9uKGJhc2UsICdNMDAxJywgJ3Bhc3MnKTtcbiAgICAgIC8vIE5vIHN1bW1hcnkgXHUyMDE0IHZhbGlkYXRlZCBidXQgbm90IHlldCBjb21wbGV0ZWRcblxuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUuYWN0aXZlTWlsZXN0b25lPy5pZCwgJ00wMDEnLCAnTTAwMSBpcyBhY3RpdmUgZm9yIGNvbXBsZXRpb24nKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0OiB1bmNoZWNrZWQgcm9hZG1hcCBzbGljZXMgKyBzdW1tYXJ5IFx1MjE5MiBjb21wbGV0ZSAoc3VtbWFyeSBpcyB0ZXJtaW5hbCkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIHRlc3QoJ3VuY2hlY2tlZCByb2FkbWFwIHNsaWNlcyArIHN1bW1hcnkgXHUyMTkyIGNvbXBsZXRlIChzdW1tYXJ5IGlzIHRlcm1pbmFsKScsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgLy8gTTAwMTogcm9hZG1hcCBoYXMgdW5jaGVja2VkIHNsaWNlcyBidXQgYSBzdW1tYXJ5IGV4aXN0cyBcdTIwMTQgc2hvdWxkIGJlIGNvbXBsZXRlXG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgJ00wMDEnLCBgIyBNMDAxOiBGaXJzdCBNaWxlc3RvbmVcXG5cXG4qKlZpc2lvbjoqKiBBbHJlYWR5IGRvbmUuXFxuXFxuIyMgU2xpY2VzXFxuXFxuLSBbIF0gKipTMDE6IFVuY2hlY2tlZCBzbGljZSoqIFxcYHJpc2s6bG93XFxgIFxcYGRlcGVuZHM6W11cXGBcXG4gID4gV29yayB3YXMgZG9uZSBidXQgY2hlY2tib3ggbmV2ZXIgdGlja2VkLlxcbi0gWyBdICoqUzAyOiBBbm90aGVyIHVuY2hlY2tlZCoqIFxcYHJpc2s6bG93XFxgIFxcYGRlcGVuZHM6W11cXGBcXG4gID4gU2FtZS5cXG5gKTtcbiAgICAgIHdyaXRlTWlsZXN0b25lU3VtbWFyeShiYXNlLCAnTTAwMScsICctLS1cXG5pZDogTTAwMVxcbi0tLVxcblxcbiMgTTAwMTogRmlyc3QgTWlsZXN0b25lXFxuXFxuKipDb21wbGV0ZWQgZGVzcGl0ZSB1bmNoZWNrZWQgcm9hZG1hcC4qKicpO1xuICAgICAgLy8gTTAwMjogZ2VudWluZWx5IGluY29tcGxldGUgXHUyMDE0IHNob3VsZCBiZSB0aGUgYWN0aXZlIG1pbGVzdG9uZVxuICAgICAgd3JpdGVSb2FkbWFwKGJhc2UsICdNMDAyJywgYCMgTTAwMjogQWN0aXZlIE1pbGVzdG9uZVxcblxcbioqVmlzaW9uOioqIERvIHN0dWZmLlxcblxcbiMjIFNsaWNlc1xcblxcbi0gWyBdICoqUzAxOiBXb3JrIHNsaWNlKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbXVxcYFxcbiAgPiBOZWVkcyB3b3JrLlxcbmApO1xuXG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuICAgICAgY29uc3QgbTAwMUVudHJ5ID0gc3RhdGUucmVnaXN0cnkuZmluZChlID0+IGUuaWQgPT09ICdNMDAxJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKG0wMDFFbnRyeT8uc3RhdHVzLCAnY29tcGxldGUnLCAnTTAwMSB3aXRoIHVuY2hlY2tlZCByb2FkbWFwICsgc3VtbWFyeSBpcyBjb21wbGV0ZScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5hY3RpdmVNaWxlc3RvbmU/LmlkLCAnTTAwMicsICdhY3RpdmUgbWlsZXN0b25lIGlzIE0wMDIsIG5vdCBNMDAxJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdDogdW5jaGVja2VkIHJvYWRtYXAgKyBzdW1tYXJ5IGNvdW50cyB0b3dhcmQgY29tcGxldGVNaWxlc3RvbmVJZHMgKGRlcHMpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICB0ZXN0KCd1bmNoZWNrZWQgcm9hZG1hcCArIHN1bW1hcnkgc2F0aXNmaWVzIGRlcGVuZGVuY3knLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIC8vIE0wMDE6IHVuY2hlY2tlZCByb2FkbWFwICsgc3VtbWFyeSBcdTIxOTIgY29tcGxldGVcbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCAnTTAwMScsIGAjIE0wMDE6IEZvdW5kYXRpb25cXG5cXG4qKlZpc2lvbjoqKiBEb25lLlxcblxcbiMjIFNsaWNlc1xcblxcbi0gWyBdICoqUzAxOiBTZXR1cCoqIFxcYHJpc2s6bG93XFxgIFxcYGRlcGVuZHM6W11cXGBcXG4gID4gRG9uZS5cXG5gKTtcbiAgICAgIHdyaXRlTWlsZXN0b25lU3VtbWFyeShiYXNlLCAnTTAwMScsICctLS1cXG5pZDogTTAwMVxcbi0tLVxcblxcbiMgTTAwMTogRm91bmRhdGlvblxcblxcbioqRG9uZS4qKicpO1xuICAgICAgLy8gTTAwMjogZGVwZW5kcyBvbiBNMDAxIFx1MjAxNCBzaG91bGQgYmUgYWN0aXZlIHNpbmNlIE0wMDEgaXMgY29tcGxldGVcbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCAnTTAwMicsIGAjIE0wMDI6IERlcGVuZGVudFxcblxcbioqVmlzaW9uOioqIERlcGVuZHMgb24gTTAwMS5cXG5cXG4jIyBTbGljZXNcXG5cXG4tIFsgXSAqKlMwMTogV29yayoqIFxcYHJpc2s6bG93XFxgIFxcYGRlcGVuZHM6W11cXGBcXG4gID4gV29yay5cXG5gKTtcbiAgICAgIGNvbnN0IGNvbnRleHREaXIgPSBqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMicpO1xuICAgICAgbWtkaXJTeW5jKGNvbnRleHREaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKGNvbnRleHREaXIsICdNMDAyLUNPTlRFWFQubWQnKSwgJy0tLVxcbmRlcGVuZHNfb246XFxuICAtIE0wMDFcXG4tLS1cXG5cXG4jIE0wMDIgQ29udGV4dFxcblxcbkRlcGVuZHMgb24gTTAwMS4nKTtcblxuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUuYWN0aXZlTWlsZXN0b25lPy5pZCwgJ00wMDInLCAnTTAwMiBpcyBhY3RpdmUgXHUyMDE0IE0wMDEgZGVwZW5kZW5jeSBzYXRpc2ZpZWQgdmlhIHN1bW1hcnknKTtcbiAgICAgIGNvbnN0IG0wMDJFbnRyeSA9IHN0YXRlLnJlZ2lzdHJ5LmZpbmQoZSA9PiBlLmlkID09PSAnTTAwMicpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChtMDAyRW50cnk/LnN0YXR1cywgJ2FjdGl2ZScsICdNMDAyIHN0YXR1cyBpcyBhY3RpdmUsIG5vdCBwZW5kaW5nJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdDogZ2hvc3QgbWlsZXN0b25lIChvbmx5IE1FVEEuanNvbikgaXMgc2tpcHBlZCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgdGVzdCgnZ2hvc3QgbWlsZXN0b25lIChvbmx5IE1FVEEuanNvbikgaXMgc2tpcHBlZCcsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgLy8gQ3JlYXRlIGEgZ2hvc3QgbWlsZXN0b25lIGRpcmVjdG9yeSB3aXRoIG9ubHkgTUVUQS5qc29uXG4gICAgICBjb25zdCBnaG9zdERpciA9IGpvaW4oYmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJyk7XG4gICAgICBta2RpclN5bmMoZ2hvc3REaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKGdob3N0RGlyLCAnTUVUQS5qc29uJyksIEpTT04uc3RyaW5naWZ5KHsgaWQ6ICdNMDAxJyB9KSk7XG5cbiAgICAgIC8vIGlzR2hvc3RNaWxlc3RvbmUgc2hvdWxkIGRldGVjdCBpdFxuICAgICAgYXNzZXJ0Lm9rKGlzR2hvc3RNaWxlc3RvbmUoYmFzZSwgJ00wMDEnKSwgJ00wMDEgaXMgYSBnaG9zdCBtaWxlc3RvbmUnKTtcblxuICAgICAgLy8gZGVyaXZlU3RhdGUgc2hvdWxkIHRyZWF0IHRoaXMgYXMgcHJlLXBsYW5uaW5nIChubyByZWFsIG1pbGVzdG9uZXMpXG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5waGFzZSwgJ3ByZS1wbGFubmluZycsICdnaG9zdC1vbmx5OiBwaGFzZSBpcyBwcmUtcGxhbm5pbmcnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUuYWN0aXZlTWlsZXN0b25lLCBudWxsLCAnZ2hvc3Qtb25seTogbm8gYWN0aXZlIG1pbGVzdG9uZScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5yZWdpc3RyeS5sZW5ndGgsIDAsICdnaG9zdC1vbmx5OiByZWdpc3RyeSBpcyBlbXB0eScpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRlc3Q6IGdob3N0IG1pbGVzdG9uZSBza2lwcGVkIHdoZW4gcmVhbCBtaWxlc3RvbmVzIGV4aXN0IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICB0ZXN0KCdnaG9zdCBtaWxlc3RvbmUgc2tpcHBlZCBhbG9uZ3NpZGUgcmVhbCBtaWxlc3RvbmVzJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICAvLyBNMDAxOiBnaG9zdCAob25seSBNRVRBLmpzb24pXG4gICAgICBjb25zdCBnaG9zdERpciA9IGpvaW4oYmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJyk7XG4gICAgICBta2RpclN5bmMoZ2hvc3REaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKGdob3N0RGlyLCAnTUVUQS5qc29uJyksIEpTT04uc3RyaW5naWZ5KHsgaWQ6ICdNMDAxJyB9KSk7XG5cbiAgICAgIC8vIE0wMDI6IHJlYWwgbWlsZXN0b25lIHdpdGggYSBDT05URVhUIGZpbGVcbiAgICAgIGNvbnN0IHJlYWxEaXIgPSBqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMicpO1xuICAgICAgbWtkaXJTeW5jKHJlYWxEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHJlYWxEaXIsICdNMDAyLUNPTlRFWFQubWQnKSwgJyMgUmVhbCBNaWxlc3RvbmVcXG5cXG5UaGlzIGhhcyBjb250ZW50LicpO1xuXG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5hY3RpdmVNaWxlc3RvbmU/LmlkLCAnTTAwMicsICdnaG9zdCtyZWFsOiBhY3RpdmUgbWlsZXN0b25lIGlzIE0wMDInKTtcbiAgICAgIC8vIEdob3N0IE0wMDEgc2hvdWxkIG5vdCBhcHBlYXIgaW4gdGhlIHJlZ2lzdHJ5XG4gICAgICBjb25zdCBtMDAxRW50cnkgPSBzdGF0ZS5yZWdpc3RyeS5maW5kKGUgPT4gZS5pZCA9PT0gJ00wMDEnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwobTAwMUVudHJ5LCB1bmRlZmluZWQsICdnaG9zdCtyZWFsOiBNMDAxIG5vdCBpbiByZWdpc3RyeScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5yZWdpc3RyeS5sZW5ndGgsIDEsICdnaG9zdCtyZWFsOiByZWdpc3RyeSBoYXMgMSBlbnRyeScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5yZWdpc3RyeVswXT8uc3RhdHVzLCAnYWN0aXZlJywgJ2dob3N0K3JlYWw6IE0wMDIgaXMgYWN0aXZlJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdDogcXVldWVkIG1pbGVzdG9uZSB3aXRoIHdvcmt0cmVlIG5vdCBmbGFnZ2VkIGFzIGdob3N0ICgjMjkyMSkgXHUyNTAwXHUyNTAwXG4gIHRlc3QoJ3F1ZXVlZCBtaWxlc3RvbmUgd2l0aCB3b3JrdHJlZSBub3QgZmxhZ2dlZCBhcyBnaG9zdCAoIzI5MjEpJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICAvLyBDcmVhdGUgYSBtaWxlc3RvbmUgZGlyZWN0b3J5IHdpdGggb25seSBhbiBlbXB0eSBzbGljZXMgc3ViZGlyIFx1MjAxNCBubyBjb250ZW50IGZpbGVzLlxuICAgICAgLy8gVGhpcyB3b3VsZCBub3JtYWxseSBiZSBhIGdob3N0LCBidXQgaXQgaGFzIGEgd29ya3RyZWUgZGlyZWN0b3J5LlxuICAgICAgY29uc3QgbWlsZXN0b25lRGlyID0gam9pbihiYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgJ00wMDInKTtcbiAgICAgIG1rZGlyU3luYyhqb2luKG1pbGVzdG9uZURpciwgJ3NsaWNlcycpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAgICAgLy8gQ3JlYXRlIGEgd29ya3RyZWUgZGlyZWN0b3J5IGZvciBNMDAyLCBzaW11bGF0aW5nIGFuIGFjdGl2ZSB3b3JrdHJlZVxuICAgICAgY29uc3Qgd29ya3RyZWVEaXIgPSBqb2luKGJhc2UsICcuZ3NkJywgJ3dvcmt0cmVlcycsICdNMDAyJyk7XG4gICAgICBta2RpclN5bmMod29ya3RyZWVEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gICAgICAvLyBpc0dob3N0TWlsZXN0b25lIHNob3VsZCByZXR1cm4gZmFsc2UgYmVjYXVzZSB0aGUgd29ya3RyZWUgZXhpc3RzXG4gICAgICBhc3NlcnQub2soIWlzR2hvc3RNaWxlc3RvbmUoYmFzZSwgJ00wMDInKSwgJ00wMDIgd2l0aCB3b3JrdHJlZSBzaG91bGQgTk9UIGJlIGEgZ2hvc3QnKTtcblxuICAgICAgLy8gQWxzbyBjcmVhdGUgYSBjb21wbGV0ZWQgTTAwMSBzbyBkZXJpdmVTdGF0ZSBoYXMgc29tZXRoaW5nIGJlZm9yZSBNMDAyXG4gICAgICB3cml0ZU1pbGVzdG9uZVN1bW1hcnkoYmFzZSwgJ00wMDEnLCAnIyBNMDAxIFN1bW1hcnlcXG5cXG5Eb25lLicpO1xuXG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuICAgICAgLy8gTTAwMiBzaG91bGQgYXBwZWFyIGluIHRoZSByZWdpc3RyeSAobm90IGZpbHRlcmVkIGFzIGdob3N0KVxuICAgICAgY29uc3QgbTAwMkVudHJ5ID0gc3RhdGUucmVnaXN0cnkuZmluZChlID0+IGUuaWQgPT09ICdNMDAyJyk7XG4gICAgICBhc3NlcnQub2sobTAwMkVudHJ5ICE9PSB1bmRlZmluZWQsICdNMDAyIHNob3VsZCBiZSBpbiByZWdpc3RyeSB3aGVuIHdvcmt0cmVlIGV4aXN0cycpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5hY3RpdmVNaWxlc3RvbmU/LmlkLCAnTTAwMicsICdNMDAyIHNob3VsZCBiZSBhY3RpdmUgbWlsZXN0b25lJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdDogemVyby1zbGljZSByb2FkbWFwIFx1MjE5MiBwcmUtcGxhbm5pbmcsIG5vdCBibG9ja2VkICgjMTc4NSkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIHRlc3QoJ3plcm8tc2xpY2Ugcm9hZG1hcCBcdTIxOTIgcHJlLXBsYW5uaW5nLCBub3QgYmxvY2tlZCAoIzE3ODUpJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICAvLyBXcml0ZSBhIHN0dWIgcm9hZG1hcCB3aXRoIHplcm8gc2xpY2VzIChwbGFjZWhvbGRlciB0ZXh0LCBubyBzbGljZSBkZWZpbml0aW9ucylcbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCAnTTAwMScsIGAjIE0wMDE6IFN0dWIgTWlsZXN0b25lXFxuXFxuKipWaXNpb246KiogUGxhY2Vob2xkZXIuXFxuXFxuIyMgU2xpY2VzXFxuXFxuX05vIHNsaWNlcyBkZWZpbmVkIHlldC5fXFxuYCk7XG5cbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG5cbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucGhhc2UsICdwcmUtcGxhbm5pbmcnLCAncGhhc2UgaXMgcHJlLXBsYW5uaW5nIHdoZW4gcm9hZG1hcCBoYXMgemVybyBzbGljZXMnKTtcbiAgICAgIGFzc2VydC5vayhzdGF0ZS5hY3RpdmVNaWxlc3RvbmUgIT09IG51bGwsICdhY3RpdmVNaWxlc3RvbmUgaXMgc2V0Jyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQsICdNMDAxJywgJ2FjdGl2ZU1pbGVzdG9uZSBpcyBNMDAxJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLmFjdGl2ZVNsaWNlLCBudWxsLCAnYWN0aXZlU2xpY2UgaXMgbnVsbCcpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5hY3RpdmVUYXNrLCBudWxsLCAnYWN0aXZlVGFzayBpcyBudWxsJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLmJsb2NrZXJzLmxlbmd0aCwgMCwgJ25vIGJsb2NrZXJzIHJlcG9ydGVkJyk7XG4gICAgICBhc3NlcnQub2soc3RhdGUubmV4dEFjdGlvbi5pbmNsdWRlcygnTTAwMScpLCAnbmV4dEFjdGlvbiByZWZlcmVuY2VzIE0wMDEnKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxTQUFTLFVBQVUsWUFBWTtBQUMvQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhLFdBQVcsUUFBUSxxQkFBcUI7QUFDOUQsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUV2QixTQUFTLGFBQW1ELHdCQUF3QjtBQUdwRixRQUFRLElBQUkscUNBQXFDO0FBSWpELFNBQVMsb0JBQTRCO0FBQ25DLFFBQU0sT0FBTyxZQUFZLEtBQUssT0FBTyxHQUFHLGlCQUFpQixDQUFDO0FBQzFELFlBQVUsS0FBSyxNQUFNLFFBQVEsWUFBWSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDL0QsU0FBTztBQUNUO0FBRUEsU0FBUyxhQUFhLE1BQWMsS0FBYSxTQUF1QjtBQUN0RSxRQUFNLE1BQU0sS0FBSyxNQUFNLFFBQVEsY0FBYyxHQUFHO0FBQ2hELFlBQVUsS0FBSyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ2xDLGdCQUFjLEtBQUssS0FBSyxHQUFHLEdBQUcsYUFBYSxHQUFHLE9BQU87QUFDdkQ7QUFFQSxTQUFTLFVBQVUsTUFBYyxLQUFhLEtBQWEsU0FBdUI7QUFDaEYsUUFBTSxNQUFNLEtBQUssTUFBTSxRQUFRLGNBQWMsS0FBSyxVQUFVLEdBQUc7QUFDL0QsUUFBTSxXQUFXLEtBQUssS0FBSyxPQUFPO0FBQ2xDLFlBQVUsVUFBVSxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3ZDLGdCQUFjLEtBQUssS0FBSyxHQUFHLEdBQUcsVUFBVSxHQUFHLE9BQU87QUFHbEQsUUFBTSxjQUFjLFFBQVEsU0FBUyxjQUFjO0FBQ25ELGFBQVcsS0FBSyxhQUFhO0FBQzNCLFVBQU0sTUFBTSxFQUFFLENBQUM7QUFDZixVQUFNLFdBQVcs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
