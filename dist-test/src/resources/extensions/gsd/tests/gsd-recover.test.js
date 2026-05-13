import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openDatabase,
  closeDatabase,
  transaction,
  getAllMilestones,
  getMilestoneSlices,
  getSliceTasks,
  _getAdapter,
  insertMilestone,
  getMilestone,
  getSlice,
  getTask
} from "../gsd-db.js";
import { migrateHierarchyToDb } from "../md-importer.js";
import { deriveStateFromDb, invalidateStateCache } from "../state.js";
function createFixtureBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-recover-"));
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
const ROADMAP_M001 = `# M001: Recovery Test

**Vision:** Test recovery round-trip.

## Success Criteria

- All recovery tests pass
- State matches after round-trip


## Slices

- [x] **S01: Setup** \`risk:low\` \`depends:[]\`
  > After this: Setup complete.

- [ ] **S02: Core** \`risk:medium\` \`depends:[S01]\`
  > After this: Core done.

## Boundary Map

| From | To | Produces | Consumes |
|------|-----|----------|----------|
| S01 | S02 | setup artifacts | setup artifacts |
`;
const PLAN_S01_COMPLETE = `---
estimated_steps: 2
estimated_files: 1
skills_used: []
---

# S01: Setup

**Goal:** Setup fixtures.
**Demo:** Tasks done.

## Tasks

- [x] **T01: Init** \`est:15m\`
  Initialize things.
  - Files: \`init.ts\`, \`config.ts\`
  - Verify: \`node test-init.ts\`

- [x] **T02: Config** \`est:10m\`
  Configure things.
  - Files: \`settings.ts\`
  - Verify: \`node test-config.ts\`
`;
const PLAN_S02_PARTIAL = `---
estimated_steps: 1
estimated_files: 1
skills_used: []
---

# S02: Core

**Goal:** Build core.
**Demo:** Core works.

## Tasks

- [x] **T01: Build** \`est:30m\`
  Build it.
  - Files: \`core.ts\`
  - Verify: \`node test-build.ts\`

- [ ] **T02: Test** \`est:20m\`
  Test it.
  - Files: \`test-core.ts\`, \`helpers.ts\`
  - Verify: \`npm test\`

- [ ] **T03: Polish** \`est:15m\`
  Polish it.
  - Files: \`polish.ts\`
  - Verify: \`node test-polish.ts\`
`;
const SUMMARY_S01 = `---
id: S01
parent: M001
milestone: M001
---

# S01: Setup \u2014 Summary

Setup is complete.
`;
function clearHierarchyTables() {
  const db = _getAdapter();
  transaction(() => {
    db.exec("DELETE FROM tasks");
    db.exec("DELETE FROM slices");
    db.exec("DELETE FROM milestones");
  });
}
describe("gsd-recover", async () => {
  test("full round-trip (populate, clear, recover, verify)", async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, "milestones/M001/M001-ROADMAP.md", ROADMAP_M001);
      writeFile(base, "milestones/M001/slices/S01/S01-PLAN.md", PLAN_S01_COMPLETE);
      writeFile(base, "milestones/M001/slices/S01/S01-SUMMARY.md", SUMMARY_S01);
      writeFile(base, "milestones/M001/slices/S02/S02-PLAN.md", PLAN_S02_PARTIAL);
      openDatabase(":memory:");
      const counts1 = migrateHierarchyToDb(base);
      assert.deepStrictEqual(counts1.milestones, 1, "round-trip: initial migration - 1 milestone");
      assert.deepStrictEqual(counts1.slices, 2, "round-trip: initial migration - 2 slices");
      assert.ok(counts1.tasks >= 5, "round-trip: initial migration - at least 5 tasks");
      invalidateStateCache();
      const stateBefore = await deriveStateFromDb(base);
      assert.ok(stateBefore.activeMilestone !== null, "round-trip: state before has active milestone");
      const milestonesBefore = getAllMilestones();
      const slicesBefore = getMilestoneSlices("M001");
      const s01TasksBefore = getSliceTasks("M001", "S01");
      const s02TasksBefore = getSliceTasks("M001", "S02");
      clearHierarchyTables();
      const milestonesAfterClear = getAllMilestones();
      assert.deepStrictEqual(milestonesAfterClear.length, 0, "round-trip: milestones cleared");
      const counts2 = migrateHierarchyToDb(base);
      assert.deepStrictEqual(counts2.milestones, counts1.milestones, "round-trip: recovery milestone count matches");
      assert.deepStrictEqual(counts2.slices, counts1.slices, "round-trip: recovery slice count matches");
      assert.deepStrictEqual(counts2.tasks, counts1.tasks, "round-trip: recovery task count matches");
      invalidateStateCache();
      const stateAfter = await deriveStateFromDb(base);
      assert.deepStrictEqual(stateAfter.phase, stateBefore.phase, "round-trip: phase matches");
      assert.deepStrictEqual(
        stateAfter.activeMilestone?.id,
        stateBefore.activeMilestone?.id,
        "round-trip: active milestone ID matches"
      );
      assert.deepStrictEqual(
        stateAfter.activeSlice?.id,
        stateBefore.activeSlice?.id,
        "round-trip: active slice ID matches"
      );
      assert.deepStrictEqual(
        stateAfter.activeTask?.id,
        stateBefore.activeTask?.id,
        "round-trip: active task ID matches"
      );
      const milestonesAfter = getAllMilestones();
      assert.deepStrictEqual(milestonesAfter.length, milestonesBefore.length, "round-trip: milestone row count");
      assert.deepStrictEqual(milestonesAfter[0]?.id, milestonesBefore[0]?.id, "round-trip: milestone ID");
      assert.deepStrictEqual(milestonesAfter[0]?.title, milestonesBefore[0]?.title, "round-trip: milestone title");
      const slicesAfter = getMilestoneSlices("M001");
      assert.deepStrictEqual(slicesAfter.length, slicesBefore.length, "round-trip: slice row count");
      assert.deepStrictEqual(slicesAfter[0]?.id, slicesBefore[0]?.id, "round-trip: S01 ID");
      assert.deepStrictEqual(slicesAfter[0]?.status, slicesBefore[0]?.status, "round-trip: S01 status");
      assert.deepStrictEqual(slicesAfter[1]?.id, slicesBefore[1]?.id, "round-trip: S02 ID");
      const s01TasksAfter = getSliceTasks("M001", "S01");
      assert.deepStrictEqual(s01TasksAfter.length, s01TasksBefore.length, "round-trip: S01 task count");
      const s02TasksAfter = getSliceTasks("M001", "S02");
      assert.deepStrictEqual(s02TasksAfter.length, s02TasksBefore.length, "round-trip: S02 task count");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("v8 planning columns populated", async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, "milestones/M001/M001-ROADMAP.md", ROADMAP_M001);
      writeFile(base, "milestones/M001/slices/S01/S01-PLAN.md", PLAN_S01_COMPLETE);
      writeFile(base, "milestones/M001/slices/S01/S01-SUMMARY.md", SUMMARY_S01);
      writeFile(base, "milestones/M001/slices/S02/S02-PLAN.md", PLAN_S02_PARTIAL);
      openDatabase(":memory:");
      migrateHierarchyToDb(base);
      const milestone = getMilestone("M001");
      assert.ok(milestone !== null, "v8: milestone exists");
      assert.deepStrictEqual(milestone.vision, "Test recovery round-trip.", "v8: milestone vision populated");
      assert.ok(milestone.success_criteria.length >= 2, "v8: milestone success_criteria has entries");
      assert.deepStrictEqual(milestone.success_criteria[0], "All recovery tests pass", "v8: first success criterion");
      assert.ok(milestone.boundary_map_markdown.includes("Boundary Map"), "v8: boundary_map_markdown populated");
      assert.ok(milestone.boundary_map_markdown.includes("S01"), "v8: boundary_map_markdown has S01");
      assert.deepStrictEqual(milestone.key_risks.length, 0, "v8: key_risks left empty (tool-only per D004)");
      assert.deepStrictEqual(milestone.requirement_coverage, "", "v8: requirement_coverage left empty (tool-only per D004)");
      const sliceS01 = getSlice("M001", "S01");
      assert.ok(sliceS01 !== null, "v8: slice S01 exists");
      assert.deepStrictEqual(sliceS01.goal, "Setup fixtures.", "v8: S01 goal populated");
      const sliceS02 = getSlice("M001", "S02");
      assert.ok(sliceS02 !== null, "v8: slice S02 exists");
      assert.deepStrictEqual(sliceS02.goal, "Build core.", "v8: S02 goal populated");
      assert.deepStrictEqual(sliceS01.proof_level, "", "v8: S01 proof_level left empty (tool-only per D004)");
      const taskS01T01 = getTask("M001", "S01", "T01");
      assert.ok(taskS01T01 !== null, "v8: task S01/T01 exists");
      assert.ok(taskS01T01.files.length >= 2, "v8: S01/T01 files populated");
      assert.ok(taskS01T01.files.includes("init.ts"), "v8: S01/T01 files includes init.ts");
      assert.ok(taskS01T01.files.includes("config.ts"), "v8: S01/T01 files includes config.ts");
      assert.deepStrictEqual(taskS01T01.verify, "`node test-init.ts`", "v8: S01/T01 verify populated");
      const taskS02T02 = getTask("M001", "S02", "T02");
      assert.ok(taskS02T02 !== null, "v8: task S02/T02 exists");
      assert.ok(taskS02T02.files.length >= 2, "v8: S02/T02 files populated");
      assert.ok(taskS02T02.files.includes("test-core.ts"), "v8: S02/T02 files includes test-core.ts");
      assert.deepStrictEqual(taskS02T02.verify, "`npm test`", "v8: S02/T02 verify populated");
      const taskS02T03 = getTask("M001", "S02", "T03");
      assert.ok(taskS02T03 !== null, "v8: task S02/T03 exists");
      assert.ok(taskS02T03.files.includes("polish.ts"), "v8: S02/T03 files includes polish.ts");
      assert.deepStrictEqual(taskS02T03.verify, "`node test-polish.ts`", "v8: S02/T03 verify populated");
      const db = _getAdapter();
      const milestoneRow = db.prepare("SELECT vision, success_criteria, boundary_map_markdown FROM milestones WHERE id = 'M001'").get();
      assert.ok(milestoneRow.vision.length > 0, "v8-diag: vision column queryable");
      assert.ok(milestoneRow.boundary_map_markdown.length > 0, "v8-diag: boundary_map_markdown column queryable");
      const sliceRow = db.prepare("SELECT goal FROM slices WHERE milestone_id = 'M001' AND id = 'S01'").get();
      assert.ok(sliceRow.goal.length > 0, "v8-diag: goal column queryable");
      const taskRow = db.prepare("SELECT files, verify FROM tasks WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'").get();
      assert.ok(taskRow.files.length > 2, "v8-diag: files column queryable (JSON array)");
      assert.ok(taskRow.verify.length > 0, "v8-diag: verify column queryable");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("idempotent - double recovery produces same state", async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, "milestones/M001/M001-ROADMAP.md", ROADMAP_M001);
      writeFile(base, "milestones/M001/slices/S01/S01-PLAN.md", PLAN_S01_COMPLETE);
      writeFile(base, "milestones/M001/slices/S01/S01-SUMMARY.md", SUMMARY_S01);
      writeFile(base, "milestones/M001/slices/S02/S02-PLAN.md", PLAN_S02_PARTIAL);
      openDatabase(":memory:");
      migrateHierarchyToDb(base);
      invalidateStateCache();
      const state1 = await deriveStateFromDb(base);
      clearHierarchyTables();
      migrateHierarchyToDb(base);
      invalidateStateCache();
      const state2 = await deriveStateFromDb(base);
      assert.deepStrictEqual(state2.phase, state1.phase, "idempotent: phase matches");
      assert.deepStrictEqual(
        state2.activeMilestone?.id,
        state1.activeMilestone?.id,
        "idempotent: active milestone matches"
      );
      assert.deepStrictEqual(
        state2.activeSlice?.id,
        state1.activeSlice?.id,
        "idempotent: active slice matches"
      );
      assert.deepStrictEqual(
        state2.activeTask?.id,
        state1.activeTask?.id,
        "idempotent: active task matches"
      );
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("preserves decisions/requirements", async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, "milestones/M001/M001-ROADMAP.md", ROADMAP_M001);
      writeFile(base, "milestones/M001/slices/S01/S01-PLAN.md", PLAN_S01_COMPLETE);
      openDatabase(":memory:");
      migrateHierarchyToDb(base);
      const db = _getAdapter();
      db.prepare(
        `INSERT INTO decisions (id, when_context, scope, decision, choice, rationale, revisable)
         VALUES (:id, :when, :scope, :decision, :choice, :rationale, :revisable)`
      ).run({
        ":id": "D001",
        ":when": "T03",
        ":scope": "architecture",
        ":decision": "Use shared WAL",
        ":choice": "Single DB",
        ":rationale": "Simpler",
        ":revisable": "Yes"
      });
      db.prepare(
        `INSERT INTO requirements (id, class, status, description)
         VALUES (:id, :class, :status, :desc)`
      ).run({
        ":id": "R001",
        ":class": "functional",
        ":status": "active",
        ":desc": "Recovery works"
      });
      clearHierarchyTables();
      const decisions = db.prepare("SELECT * FROM decisions").all();
      assert.deepStrictEqual(decisions.length, 1, "preserve: decision survives clear");
      assert.deepStrictEqual(decisions[0].id, "D001", "preserve: decision ID intact");
      const requirements = db.prepare("SELECT * FROM requirements").all();
      assert.deepStrictEqual(requirements.length, 1, "preserve: requirement survives clear");
      assert.deepStrictEqual(requirements[0].id, "R001", "preserve: requirement ID intact");
      migrateHierarchyToDb(base);
      const milestones = getAllMilestones();
      assert.ok(milestones.length > 0, "preserve: milestones recovered after clear");
      const decisionsAfter = db.prepare("SELECT * FROM decisions").all();
      assert.deepStrictEqual(decisionsAfter.length, 1, "preserve: decision still present after recovery");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("empty milestones dir", async () => {
    const base = createFixtureBase();
    try {
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "Ghost", status: "active" });
      clearHierarchyTables();
      const counts = migrateHierarchyToDb(base);
      assert.deepStrictEqual(counts.milestones, 0, "empty: zero milestones recovered");
      assert.deepStrictEqual(counts.slices, 0, "empty: zero slices recovered");
      assert.deepStrictEqual(counts.tasks, 0, "empty: zero tasks recovered");
      const all = getAllMilestones();
      assert.deepStrictEqual(all.length, 0, "empty: no milestones in DB after recovery");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9nc2QtcmVjb3Zlci50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBkZXNjcmliZSwgdGVzdCB9IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG4vLyBnc2QtcmVjb3Zlci50ZXN0LnRzIFx1MjAxNCBUZXN0cyBmb3IgdGhlIGBnc2QgcmVjb3ZlcmAgcmVjb3ZlcnkgbG9naWMuXG4vLyBWZXJpZmllczogcG9wdWxhdGUgREIgXHUyMTkyIGNsZWFyIGhpZXJhcmNoeSBcdTIxOTIgcmVjb3ZlciBmcm9tIG1hcmtkb3duIFx1MjE5MiBzdGF0ZSBtYXRjaGVzLlxuXG5pbXBvcnQgeyBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdub2RlOnBhdGgnO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSAnbm9kZTpvcyc7XG5cbmltcG9ydCB7XG4gIG9wZW5EYXRhYmFzZSxcbiAgY2xvc2VEYXRhYmFzZSxcbiAgdHJhbnNhY3Rpb24sXG4gIGdldEFsbE1pbGVzdG9uZXMsXG4gIGdldE1pbGVzdG9uZVNsaWNlcyxcbiAgZ2V0U2xpY2VUYXNrcyxcbiAgX2dldEFkYXB0ZXIsXG4gIGluc2VydE1pbGVzdG9uZSxcbiAgaW5zZXJ0U2xpY2UsXG4gIGluc2VydFRhc2ssXG4gIGdldE1pbGVzdG9uZSxcbiAgZ2V0U2xpY2UsXG4gIGdldFRhc2ssXG59IGZyb20gJy4uL2dzZC1kYi50cyc7XG5pbXBvcnQgeyBtaWdyYXRlSGllcmFyY2h5VG9EYiB9IGZyb20gJy4uL21kLWltcG9ydGVyLnRzJztcbmltcG9ydCB7IGRlcml2ZVN0YXRlRnJvbURiLCBpbnZhbGlkYXRlU3RhdGVDYWNoZSB9IGZyb20gJy4uL3N0YXRlLnRzJztcbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBGaXh0dXJlIEhlbHBlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIGNyZWF0ZUZpeHR1cmVCYXNlKCk6IHN0cmluZyB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCAnZ3NkLXJlY292ZXItJykpO1xuICBta2RpclN5bmMoam9pbihiYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICByZXR1cm4gYmFzZTtcbn1cblxuZnVuY3Rpb24gd3JpdGVGaWxlKGJhc2U6IHN0cmluZywgcmVsYXRpdmVQYXRoOiBzdHJpbmcsIGNvbnRlbnQ6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBmdWxsID0gam9pbihiYXNlLCAnLmdzZCcsIHJlbGF0aXZlUGF0aCk7XG4gIG1rZGlyU3luYyhqb2luKGZ1bGwsICcuLicpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhmdWxsLCBjb250ZW50KTtcbn1cblxuZnVuY3Rpb24gY2xlYW51cChiYXNlOiBzdHJpbmcpOiB2b2lkIHtcbiAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEZpeHR1cmUgQ29udGVudCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuY29uc3QgUk9BRE1BUF9NMDAxID0gYCMgTTAwMTogUmVjb3ZlcnkgVGVzdFxuXG4qKlZpc2lvbjoqKiBUZXN0IHJlY292ZXJ5IHJvdW5kLXRyaXAuXG5cbiMjIFN1Y2Nlc3MgQ3JpdGVyaWFcblxuLSBBbGwgcmVjb3ZlcnkgdGVzdHMgcGFzc1xuLSBTdGF0ZSBtYXRjaGVzIGFmdGVyIHJvdW5kLXRyaXBcblxuXG4jIyBTbGljZXNcblxuLSBbeF0gKipTMDE6IFNldHVwKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbXVxcYFxuICA+IEFmdGVyIHRoaXM6IFNldHVwIGNvbXBsZXRlLlxuXG4tIFsgXSAqKlMwMjogQ29yZSoqIFxcYHJpc2s6bWVkaXVtXFxgIFxcYGRlcGVuZHM6W1MwMV1cXGBcbiAgPiBBZnRlciB0aGlzOiBDb3JlIGRvbmUuXG5cbiMjIEJvdW5kYXJ5IE1hcFxuXG58IEZyb20gfCBUbyB8IFByb2R1Y2VzIHwgQ29uc3VtZXMgfFxufC0tLS0tLXwtLS0tLXwtLS0tLS0tLS0tfC0tLS0tLS0tLS18XG58IFMwMSB8IFMwMiB8IHNldHVwIGFydGlmYWN0cyB8IHNldHVwIGFydGlmYWN0cyB8XG5gO1xuXG5jb25zdCBQTEFOX1MwMV9DT01QTEVURSA9IGAtLS1cbmVzdGltYXRlZF9zdGVwczogMlxuZXN0aW1hdGVkX2ZpbGVzOiAxXG5za2lsbHNfdXNlZDogW11cbi0tLVxuXG4jIFMwMTogU2V0dXBcblxuKipHb2FsOioqIFNldHVwIGZpeHR1cmVzLlxuKipEZW1vOioqIFRhc2tzIGRvbmUuXG5cbiMjIFRhc2tzXG5cbi0gW3hdICoqVDAxOiBJbml0KiogXFxgZXN0OjE1bVxcYFxuICBJbml0aWFsaXplIHRoaW5ncy5cbiAgLSBGaWxlczogXFxgaW5pdC50c1xcYCwgXFxgY29uZmlnLnRzXFxgXG4gIC0gVmVyaWZ5OiBcXGBub2RlIHRlc3QtaW5pdC50c1xcYFxuXG4tIFt4XSAqKlQwMjogQ29uZmlnKiogXFxgZXN0OjEwbVxcYFxuICBDb25maWd1cmUgdGhpbmdzLlxuICAtIEZpbGVzOiBcXGBzZXR0aW5ncy50c1xcYFxuICAtIFZlcmlmeTogXFxgbm9kZSB0ZXN0LWNvbmZpZy50c1xcYFxuYDtcblxuY29uc3QgUExBTl9TMDJfUEFSVElBTCA9IGAtLS1cbmVzdGltYXRlZF9zdGVwczogMVxuZXN0aW1hdGVkX2ZpbGVzOiAxXG5za2lsbHNfdXNlZDogW11cbi0tLVxuXG4jIFMwMjogQ29yZVxuXG4qKkdvYWw6KiogQnVpbGQgY29yZS5cbioqRGVtbzoqKiBDb3JlIHdvcmtzLlxuXG4jIyBUYXNrc1xuXG4tIFt4XSAqKlQwMTogQnVpbGQqKiBcXGBlc3Q6MzBtXFxgXG4gIEJ1aWxkIGl0LlxuICAtIEZpbGVzOiBcXGBjb3JlLnRzXFxgXG4gIC0gVmVyaWZ5OiBcXGBub2RlIHRlc3QtYnVpbGQudHNcXGBcblxuLSBbIF0gKipUMDI6IFRlc3QqKiBcXGBlc3Q6MjBtXFxgXG4gIFRlc3QgaXQuXG4gIC0gRmlsZXM6IFxcYHRlc3QtY29yZS50c1xcYCwgXFxgaGVscGVycy50c1xcYFxuICAtIFZlcmlmeTogXFxgbnBtIHRlc3RcXGBcblxuLSBbIF0gKipUMDM6IFBvbGlzaCoqIFxcYGVzdDoxNW1cXGBcbiAgUG9saXNoIGl0LlxuICAtIEZpbGVzOiBcXGBwb2xpc2gudHNcXGBcbiAgLSBWZXJpZnk6IFxcYG5vZGUgdGVzdC1wb2xpc2gudHNcXGBcbmA7XG5cbmNvbnN0IFNVTU1BUllfUzAxID0gYC0tLVxuaWQ6IFMwMVxucGFyZW50OiBNMDAxXG5taWxlc3RvbmU6IE0wMDFcbi0tLVxuXG4jIFMwMTogU2V0dXAgXHUyMDE0IFN1bW1hcnlcblxuU2V0dXAgaXMgY29tcGxldGUuXG5gO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUmVjb3ZlcnkgaGVscGVycyAobWlycm9ycyBnc2QgcmVjb3ZlciBoYW5kbGVyIGxvZ2ljKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gY2xlYXJIaWVyYXJjaHlUYWJsZXMoKTogdm9pZCB7XG4gIGNvbnN0IGRiID0gX2dldEFkYXB0ZXIoKSE7XG4gIHRyYW5zYWN0aW9uKCgpID0+IHtcbiAgICBkYi5leGVjKFwiREVMRVRFIEZST00gdGFza3NcIik7XG4gICAgZGIuZXhlYyhcIkRFTEVURSBGUk9NIHNsaWNlc1wiKTtcbiAgICBkYi5leGVjKFwiREVMRVRFIEZST00gbWlsZXN0b25lc1wiKTtcbiAgfSk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoJ2dzZC1yZWNvdmVyJywgYXN5bmMgKCkgPT4ge1xuICB0ZXN0KCdmdWxsIHJvdW5kLXRyaXAgKHBvcHVsYXRlLCBjbGVhciwgcmVjb3ZlciwgdmVyaWZ5KScsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgLy8gU2V0IHVwIG1hcmtkb3duIGZpeHR1cmVzXG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9NMDAxLVJPQURNQVAubWQnLCBST0FETUFQX00wMDEpO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMS9TMDEtUExBTi5tZCcsIFBMQU5fUzAxX0NPTVBMRVRFKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvUzAxLVNVTU1BUlkubWQnLCBTVU1NQVJZX1MwMSk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzAyL1MwMi1QTEFOLm1kJywgUExBTl9TMDJfUEFSVElBTCk7XG5cbiAgICAgIC8vIFN0ZXAgMTogT3BlbiBEQiBhbmQgcG9wdWxhdGUgZnJvbSBtYXJrZG93blxuICAgICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuICAgICAgY29uc3QgY291bnRzMSA9IG1pZ3JhdGVIaWVyYXJjaHlUb0RiKGJhc2UpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChjb3VudHMxLm1pbGVzdG9uZXMsIDEsICdyb3VuZC10cmlwOiBpbml0aWFsIG1pZ3JhdGlvbiAtIDEgbWlsZXN0b25lJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGNvdW50czEuc2xpY2VzLCAyLCAncm91bmQtdHJpcDogaW5pdGlhbCBtaWdyYXRpb24gLSAyIHNsaWNlcycpO1xuICAgICAgYXNzZXJ0Lm9rKGNvdW50czEudGFza3MgPj0gNSwgJ3JvdW5kLXRyaXA6IGluaXRpYWwgbWlncmF0aW9uIC0gYXQgbGVhc3QgNSB0YXNrcycpO1xuXG4gICAgICAvLyBTdGVwIDI6IENhcHR1cmUgc3RhdGUgZnJvbSBEQiBiZWZvcmUgY2xlYXJpbmdcbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBzdGF0ZUJlZm9yZSA9IGF3YWl0IGRlcml2ZVN0YXRlRnJvbURiKGJhc2UpO1xuICAgICAgYXNzZXJ0Lm9rKHN0YXRlQmVmb3JlLmFjdGl2ZU1pbGVzdG9uZSAhPT0gbnVsbCwgJ3JvdW5kLXRyaXA6IHN0YXRlIGJlZm9yZSBoYXMgYWN0aXZlIG1pbGVzdG9uZScpO1xuICAgICAgY29uc3QgbWlsZXN0b25lc0JlZm9yZSA9IGdldEFsbE1pbGVzdG9uZXMoKTtcbiAgICAgIGNvbnN0IHNsaWNlc0JlZm9yZSA9IGdldE1pbGVzdG9uZVNsaWNlcygnTTAwMScpO1xuICAgICAgY29uc3QgczAxVGFza3NCZWZvcmUgPSBnZXRTbGljZVRhc2tzKCdNMDAxJywgJ1MwMScpO1xuICAgICAgY29uc3QgczAyVGFza3NCZWZvcmUgPSBnZXRTbGljZVRhc2tzKCdNMDAxJywgJ1MwMicpO1xuXG4gICAgICAvLyBTdGVwIDM6IENsZWFyIGhpZXJhcmNoeSB0YWJsZXNcbiAgICAgIGNsZWFySGllcmFyY2h5VGFibGVzKCk7XG4gICAgICBjb25zdCBtaWxlc3RvbmVzQWZ0ZXJDbGVhciA9IGdldEFsbE1pbGVzdG9uZXMoKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwobWlsZXN0b25lc0FmdGVyQ2xlYXIubGVuZ3RoLCAwLCAncm91bmQtdHJpcDogbWlsZXN0b25lcyBjbGVhcmVkJyk7XG5cbiAgICAgIC8vIFN0ZXAgNDogUmVjb3ZlciBmcm9tIG1hcmtkb3duXG4gICAgICBjb25zdCBjb3VudHMyID0gbWlncmF0ZUhpZXJhcmNoeVRvRGIoYmFzZSk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGNvdW50czIubWlsZXN0b25lcywgY291bnRzMS5taWxlc3RvbmVzLCAncm91bmQtdHJpcDogcmVjb3ZlcnkgbWlsZXN0b25lIGNvdW50IG1hdGNoZXMnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoY291bnRzMi5zbGljZXMsIGNvdW50czEuc2xpY2VzLCAncm91bmQtdHJpcDogcmVjb3Zlcnkgc2xpY2UgY291bnQgbWF0Y2hlcycpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChjb3VudHMyLnRhc2tzLCBjb3VudHMxLnRhc2tzLCAncm91bmQtdHJpcDogcmVjb3ZlcnkgdGFzayBjb3VudCBtYXRjaGVzJyk7XG5cbiAgICAgIC8vIFN0ZXAgNTogVmVyaWZ5IHN0YXRlIG1hdGNoZXNcbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBzdGF0ZUFmdGVyID0gYXdhaXQgZGVyaXZlU3RhdGVGcm9tRGIoYmFzZSk7XG5cbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGVBZnRlci5waGFzZSwgc3RhdGVCZWZvcmUucGhhc2UsICdyb3VuZC10cmlwOiBwaGFzZSBtYXRjaGVzJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKFxuICAgICAgICBzdGF0ZUFmdGVyLmFjdGl2ZU1pbGVzdG9uZT8uaWQsXG4gICAgICAgIHN0YXRlQmVmb3JlLmFjdGl2ZU1pbGVzdG9uZT8uaWQsXG4gICAgICAgICdyb3VuZC10cmlwOiBhY3RpdmUgbWlsZXN0b25lIElEIG1hdGNoZXMnLFxuICAgICAgKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoXG4gICAgICAgIHN0YXRlQWZ0ZXIuYWN0aXZlU2xpY2U/LmlkLFxuICAgICAgICBzdGF0ZUJlZm9yZS5hY3RpdmVTbGljZT8uaWQsXG4gICAgICAgICdyb3VuZC10cmlwOiBhY3RpdmUgc2xpY2UgSUQgbWF0Y2hlcycsXG4gICAgICApO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChcbiAgICAgICAgc3RhdGVBZnRlci5hY3RpdmVUYXNrPy5pZCxcbiAgICAgICAgc3RhdGVCZWZvcmUuYWN0aXZlVGFzaz8uaWQsXG4gICAgICAgICdyb3VuZC10cmlwOiBhY3RpdmUgdGFzayBJRCBtYXRjaGVzJyxcbiAgICAgICk7XG5cbiAgICAgIC8vIFZlcmlmeSByb3ctbGV2ZWwgZGF0YSBtYXRjaGVzXG4gICAgICBjb25zdCBtaWxlc3RvbmVzQWZ0ZXIgPSBnZXRBbGxNaWxlc3RvbmVzKCk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKG1pbGVzdG9uZXNBZnRlci5sZW5ndGgsIG1pbGVzdG9uZXNCZWZvcmUubGVuZ3RoLCAncm91bmQtdHJpcDogbWlsZXN0b25lIHJvdyBjb3VudCcpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChtaWxlc3RvbmVzQWZ0ZXJbMF0/LmlkLCBtaWxlc3RvbmVzQmVmb3JlWzBdPy5pZCwgJ3JvdW5kLXRyaXA6IG1pbGVzdG9uZSBJRCcpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChtaWxlc3RvbmVzQWZ0ZXJbMF0/LnRpdGxlLCBtaWxlc3RvbmVzQmVmb3JlWzBdPy50aXRsZSwgJ3JvdW5kLXRyaXA6IG1pbGVzdG9uZSB0aXRsZScpO1xuXG4gICAgICBjb25zdCBzbGljZXNBZnRlciA9IGdldE1pbGVzdG9uZVNsaWNlcygnTTAwMScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzbGljZXNBZnRlci5sZW5ndGgsIHNsaWNlc0JlZm9yZS5sZW5ndGgsICdyb3VuZC10cmlwOiBzbGljZSByb3cgY291bnQnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc2xpY2VzQWZ0ZXJbMF0/LmlkLCBzbGljZXNCZWZvcmVbMF0/LmlkLCAncm91bmQtdHJpcDogUzAxIElEJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHNsaWNlc0FmdGVyWzBdPy5zdGF0dXMsIHNsaWNlc0JlZm9yZVswXT8uc3RhdHVzLCAncm91bmQtdHJpcDogUzAxIHN0YXR1cycpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzbGljZXNBZnRlclsxXT8uaWQsIHNsaWNlc0JlZm9yZVsxXT8uaWQsICdyb3VuZC10cmlwOiBTMDIgSUQnKTtcblxuICAgICAgY29uc3QgczAxVGFza3NBZnRlciA9IGdldFNsaWNlVGFza3MoJ00wMDEnLCAnUzAxJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHMwMVRhc2tzQWZ0ZXIubGVuZ3RoLCBzMDFUYXNrc0JlZm9yZS5sZW5ndGgsICdyb3VuZC10cmlwOiBTMDEgdGFzayBjb3VudCcpO1xuXG4gICAgICBjb25zdCBzMDJUYXNrc0FmdGVyID0gZ2V0U2xpY2VUYXNrcygnTTAwMScsICdTMDInKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoczAyVGFza3NBZnRlci5sZW5ndGgsIHMwMlRhc2tzQmVmb3JlLmxlbmd0aCwgJ3JvdW5kLXRyaXA6IFMwMiB0YXNrIGNvdW50Jyk7XG5cbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoJ3Y4IHBsYW5uaW5nIGNvbHVtbnMgcG9wdWxhdGVkJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9NMDAxLVJPQURNQVAubWQnLCBST0FETUFQX00wMDEpO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMS9TMDEtUExBTi5tZCcsIFBMQU5fUzAxX0NPTVBMRVRFKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvUzAxLVNVTU1BUlkubWQnLCBTVU1NQVJZX1MwMSk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzAyL1MwMi1QTEFOLm1kJywgUExBTl9TMDJfUEFSVElBTCk7XG5cbiAgICAgIG9wZW5EYXRhYmFzZSgnOm1lbW9yeTonKTtcbiAgICAgIG1pZ3JhdGVIaWVyYXJjaHlUb0RiKGJhc2UpO1xuXG4gICAgICAvLyBNaWxlc3RvbmUgcGxhbm5pbmcgY29sdW1uc1xuICAgICAgY29uc3QgbWlsZXN0b25lID0gZ2V0TWlsZXN0b25lKCdNMDAxJyk7XG4gICAgICBhc3NlcnQub2sobWlsZXN0b25lICE9PSBudWxsLCAndjg6IG1pbGVzdG9uZSBleGlzdHMnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwobWlsZXN0b25lIS52aXNpb24sICdUZXN0IHJlY292ZXJ5IHJvdW5kLXRyaXAuJywgJ3Y4OiBtaWxlc3RvbmUgdmlzaW9uIHBvcHVsYXRlZCcpO1xuICAgICAgYXNzZXJ0Lm9rKG1pbGVzdG9uZSEuc3VjY2Vzc19jcml0ZXJpYS5sZW5ndGggPj0gMiwgJ3Y4OiBtaWxlc3RvbmUgc3VjY2Vzc19jcml0ZXJpYSBoYXMgZW50cmllcycpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChtaWxlc3RvbmUhLnN1Y2Nlc3NfY3JpdGVyaWFbMF0sICdBbGwgcmVjb3ZlcnkgdGVzdHMgcGFzcycsICd2ODogZmlyc3Qgc3VjY2VzcyBjcml0ZXJpb24nKTtcbiAgICAgIGFzc2VydC5vayhtaWxlc3RvbmUhLmJvdW5kYXJ5X21hcF9tYXJrZG93bi5pbmNsdWRlcygnQm91bmRhcnkgTWFwJyksICd2ODogYm91bmRhcnlfbWFwX21hcmtkb3duIHBvcHVsYXRlZCcpO1xuICAgICAgYXNzZXJ0Lm9rKG1pbGVzdG9uZSEuYm91bmRhcnlfbWFwX21hcmtkb3duLmluY2x1ZGVzKCdTMDEnKSwgJ3Y4OiBib3VuZGFyeV9tYXBfbWFya2Rvd24gaGFzIFMwMScpO1xuXG4gICAgICAvLyBUb29sLW9ubHkgZmllbGRzIGxlZnQgZW1wdHkgcGVyIEQwMDRcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwobWlsZXN0b25lIS5rZXlfcmlza3MubGVuZ3RoLCAwLCAndjg6IGtleV9yaXNrcyBsZWZ0IGVtcHR5ICh0b29sLW9ubHkgcGVyIEQwMDQpJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKG1pbGVzdG9uZSEucmVxdWlyZW1lbnRfY292ZXJhZ2UsICcnLCAndjg6IHJlcXVpcmVtZW50X2NvdmVyYWdlIGxlZnQgZW1wdHkgKHRvb2wtb25seSBwZXIgRDAwNCknKTtcblxuICAgICAgLy8gU2xpY2UgcGxhbm5pbmcgY29sdW1uc1xuICAgICAgY29uc3Qgc2xpY2VTMDEgPSBnZXRTbGljZSgnTTAwMScsICdTMDEnKTtcbiAgICAgIGFzc2VydC5vayhzbGljZVMwMSAhPT0gbnVsbCwgJ3Y4OiBzbGljZSBTMDEgZXhpc3RzJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHNsaWNlUzAxIS5nb2FsLCAnU2V0dXAgZml4dHVyZXMuJywgJ3Y4OiBTMDEgZ29hbCBwb3B1bGF0ZWQnKTtcblxuICAgICAgY29uc3Qgc2xpY2VTMDIgPSBnZXRTbGljZSgnTTAwMScsICdTMDInKTtcbiAgICAgIGFzc2VydC5vayhzbGljZVMwMiAhPT0gbnVsbCwgJ3Y4OiBzbGljZSBTMDIgZXhpc3RzJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHNsaWNlUzAyIS5nb2FsLCAnQnVpbGQgY29yZS4nLCAndjg6IFMwMiBnb2FsIHBvcHVsYXRlZCcpO1xuXG4gICAgICAvLyBTbGljZSB0b29sLW9ubHkgZmllbGRzIGxlZnQgZW1wdHkgcGVyIEQwMDRcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc2xpY2VTMDEhLnByb29mX2xldmVsLCAnJywgJ3Y4OiBTMDEgcHJvb2ZfbGV2ZWwgbGVmdCBlbXB0eSAodG9vbC1vbmx5IHBlciBEMDA0KScpO1xuXG4gICAgICAvLyBUYXNrIHBsYW5uaW5nIGNvbHVtbnMgLSBTMDEvVDAxXG4gICAgICBjb25zdCB0YXNrUzAxVDAxID0gZ2V0VGFzaygnTTAwMScsICdTMDEnLCAnVDAxJyk7XG4gICAgICBhc3NlcnQub2sodGFza1MwMVQwMSAhPT0gbnVsbCwgJ3Y4OiB0YXNrIFMwMS9UMDEgZXhpc3RzJyk7XG4gICAgICBhc3NlcnQub2sodGFza1MwMVQwMSEuZmlsZXMubGVuZ3RoID49IDIsICd2ODogUzAxL1QwMSBmaWxlcyBwb3B1bGF0ZWQnKTtcbiAgICAgIGFzc2VydC5vayh0YXNrUzAxVDAxIS5maWxlcy5pbmNsdWRlcygnaW5pdC50cycpLCAndjg6IFMwMS9UMDEgZmlsZXMgaW5jbHVkZXMgaW5pdC50cycpO1xuICAgICAgYXNzZXJ0Lm9rKHRhc2tTMDFUMDEhLmZpbGVzLmluY2x1ZGVzKCdjb25maWcudHMnKSwgJ3Y4OiBTMDEvVDAxIGZpbGVzIGluY2x1ZGVzIGNvbmZpZy50cycpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbCh0YXNrUzAxVDAxIS52ZXJpZnksICdgbm9kZSB0ZXN0LWluaXQudHNgJywgJ3Y4OiBTMDEvVDAxIHZlcmlmeSBwb3B1bGF0ZWQnKTtcblxuICAgICAgLy8gVGFzayBwbGFubmluZyBjb2x1bW5zIC0gUzAyL1QwMlxuICAgICAgY29uc3QgdGFza1MwMlQwMiA9IGdldFRhc2soJ00wMDEnLCAnUzAyJywgJ1QwMicpO1xuICAgICAgYXNzZXJ0Lm9rKHRhc2tTMDJUMDIgIT09IG51bGwsICd2ODogdGFzayBTMDIvVDAyIGV4aXN0cycpO1xuICAgICAgYXNzZXJ0Lm9rKHRhc2tTMDJUMDIhLmZpbGVzLmxlbmd0aCA+PSAyLCAndjg6IFMwMi9UMDIgZmlsZXMgcG9wdWxhdGVkJyk7XG4gICAgICBhc3NlcnQub2sodGFza1MwMlQwMiEuZmlsZXMuaW5jbHVkZXMoJ3Rlc3QtY29yZS50cycpLCAndjg6IFMwMi9UMDIgZmlsZXMgaW5jbHVkZXMgdGVzdC1jb3JlLnRzJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHRhc2tTMDJUMDIhLnZlcmlmeSwgJ2BucG0gdGVzdGAnLCAndjg6IFMwMi9UMDIgdmVyaWZ5IHBvcHVsYXRlZCcpO1xuXG4gICAgICBjb25zdCB0YXNrUzAyVDAzID0gZ2V0VGFzaygnTTAwMScsICdTMDInLCAnVDAzJyk7XG4gICAgICBhc3NlcnQub2sodGFza1MwMlQwMyAhPT0gbnVsbCwgJ3Y4OiB0YXNrIFMwMi9UMDMgZXhpc3RzJyk7XG4gICAgICBhc3NlcnQub2sodGFza1MwMlQwMyEuZmlsZXMuaW5jbHVkZXMoJ3BvbGlzaC50cycpLCAndjg6IFMwMi9UMDMgZmlsZXMgaW5jbHVkZXMgcG9saXNoLnRzJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHRhc2tTMDJUMDMhLnZlcmlmeSwgJ2Bub2RlIHRlc3QtcG9saXNoLnRzYCcsICd2ODogUzAyL1QwMyB2ZXJpZnkgcG9wdWxhdGVkJyk7XG5cbiAgICAgIC8vIERpYWdub3N0aWM6IHY4IHBsYW5uaW5nIGNvbHVtbnMgcXVlcnlhYmxlIHZpYSBTUUxcbiAgICAgIGNvbnN0IGRiID0gX2dldEFkYXB0ZXIoKSE7XG4gICAgICBjb25zdCBtaWxlc3RvbmVSb3cgPSBkYi5wcmVwYXJlKFwiU0VMRUNUIHZpc2lvbiwgc3VjY2Vzc19jcml0ZXJpYSwgYm91bmRhcnlfbWFwX21hcmtkb3duIEZST00gbWlsZXN0b25lcyBXSEVSRSBpZCA9ICdNMDAxJ1wiKS5nZXQoKSBhcyBhbnk7XG4gICAgICBhc3NlcnQub2sobWlsZXN0b25lUm93LnZpc2lvbi5sZW5ndGggPiAwLCAndjgtZGlhZzogdmlzaW9uIGNvbHVtbiBxdWVyeWFibGUnKTtcbiAgICAgIGFzc2VydC5vayhtaWxlc3RvbmVSb3cuYm91bmRhcnlfbWFwX21hcmtkb3duLmxlbmd0aCA+IDAsICd2OC1kaWFnOiBib3VuZGFyeV9tYXBfbWFya2Rvd24gY29sdW1uIHF1ZXJ5YWJsZScpO1xuXG4gICAgICBjb25zdCBzbGljZVJvdyA9IGRiLnByZXBhcmUoXCJTRUxFQ1QgZ29hbCBGUk9NIHNsaWNlcyBXSEVSRSBtaWxlc3RvbmVfaWQgPSAnTTAwMScgQU5EIGlkID0gJ1MwMSdcIikuZ2V0KCkgYXMgYW55O1xuICAgICAgYXNzZXJ0Lm9rKHNsaWNlUm93LmdvYWwubGVuZ3RoID4gMCwgJ3Y4LWRpYWc6IGdvYWwgY29sdW1uIHF1ZXJ5YWJsZScpO1xuXG4gICAgICBjb25zdCB0YXNrUm93ID0gZGIucHJlcGFyZShcIlNFTEVDVCBmaWxlcywgdmVyaWZ5IEZST00gdGFza3MgV0hFUkUgbWlsZXN0b25lX2lkID0gJ00wMDEnIEFORCBzbGljZV9pZCA9ICdTMDEnIEFORCBpZCA9ICdUMDEnXCIpLmdldCgpIGFzIGFueTtcbiAgICAgIGFzc2VydC5vayh0YXNrUm93LmZpbGVzLmxlbmd0aCA+IDIsICd2OC1kaWFnOiBmaWxlcyBjb2x1bW4gcXVlcnlhYmxlIChKU09OIGFycmF5KScpO1xuICAgICAgYXNzZXJ0Lm9rKHRhc2tSb3cudmVyaWZ5Lmxlbmd0aCA+IDAsICd2OC1kaWFnOiB2ZXJpZnkgY29sdW1uIHF1ZXJ5YWJsZScpO1xuXG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KCdpZGVtcG90ZW50IC0gZG91YmxlIHJlY292ZXJ5IHByb2R1Y2VzIHNhbWUgc3RhdGUnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL00wMDEtUk9BRE1BUC5tZCcsIFJPQURNQVBfTTAwMSk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzAxL1MwMS1QTEFOLm1kJywgUExBTl9TMDFfQ09NUExFVEUpO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMS9TMDEtU1VNTUFSWS5tZCcsIFNVTU1BUllfUzAxKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDIvUzAyLVBMQU4ubWQnLCBQTEFOX1MwMl9QQVJUSUFMKTtcblxuICAgICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuXG4gICAgICAvLyBGaXJzdCByZWNvdmVyeVxuICAgICAgbWlncmF0ZUhpZXJhcmNoeVRvRGIoYmFzZSk7XG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUxID0gYXdhaXQgZGVyaXZlU3RhdGVGcm9tRGIoYmFzZSk7XG5cbiAgICAgIC8vIENsZWFyIGFuZCByZWNvdmVyIGFnYWluXG4gICAgICBjbGVhckhpZXJhcmNoeVRhYmxlcygpO1xuICAgICAgbWlncmF0ZUhpZXJhcmNoeVRvRGIoYmFzZSk7XG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3Qgc3RhdGUyID0gYXdhaXQgZGVyaXZlU3RhdGVGcm9tRGIoYmFzZSk7XG5cbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUyLnBoYXNlLCBzdGF0ZTEucGhhc2UsICdpZGVtcG90ZW50OiBwaGFzZSBtYXRjaGVzJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKFxuICAgICAgICBzdGF0ZTIuYWN0aXZlTWlsZXN0b25lPy5pZCxcbiAgICAgICAgc3RhdGUxLmFjdGl2ZU1pbGVzdG9uZT8uaWQsXG4gICAgICAgICdpZGVtcG90ZW50OiBhY3RpdmUgbWlsZXN0b25lIG1hdGNoZXMnLFxuICAgICAgKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoXG4gICAgICAgIHN0YXRlMi5hY3RpdmVTbGljZT8uaWQsXG4gICAgICAgIHN0YXRlMS5hY3RpdmVTbGljZT8uaWQsXG4gICAgICAgICdpZGVtcG90ZW50OiBhY3RpdmUgc2xpY2UgbWF0Y2hlcycsXG4gICAgICApO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChcbiAgICAgICAgc3RhdGUyLmFjdGl2ZVRhc2s/LmlkLFxuICAgICAgICBzdGF0ZTEuYWN0aXZlVGFzaz8uaWQsXG4gICAgICAgICdpZGVtcG90ZW50OiBhY3RpdmUgdGFzayBtYXRjaGVzJyxcbiAgICAgICk7XG5cbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoJ3ByZXNlcnZlcyBkZWNpc2lvbnMvcmVxdWlyZW1lbnRzJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9NMDAxLVJPQURNQVAubWQnLCBST0FETUFQX00wMDEpO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMS9TMDEtUExBTi5tZCcsIFBMQU5fUzAxX0NPTVBMRVRFKTtcblxuICAgICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuICAgICAgbWlncmF0ZUhpZXJhcmNoeVRvRGIoYmFzZSk7XG5cbiAgICAgIC8vIEluc2VydCBhIGRlY2lzaW9uIGFuZCByZXF1aXJlbWVudCBtYW51YWxseVxuICAgICAgY29uc3QgZGIgPSBfZ2V0QWRhcHRlcigpITtcbiAgICAgIGRiLnByZXBhcmUoXG4gICAgICAgIGBJTlNFUlQgSU5UTyBkZWNpc2lvbnMgKGlkLCB3aGVuX2NvbnRleHQsIHNjb3BlLCBkZWNpc2lvbiwgY2hvaWNlLCByYXRpb25hbGUsIHJldmlzYWJsZSlcbiAgICAgICAgIFZBTFVFUyAoOmlkLCA6d2hlbiwgOnNjb3BlLCA6ZGVjaXNpb24sIDpjaG9pY2UsIDpyYXRpb25hbGUsIDpyZXZpc2FibGUpYCxcbiAgICAgICkucnVuKHtcbiAgICAgICAgJzppZCc6ICdEMDAxJyxcbiAgICAgICAgJzp3aGVuJzogJ1QwMycsXG4gICAgICAgICc6c2NvcGUnOiAnYXJjaGl0ZWN0dXJlJyxcbiAgICAgICAgJzpkZWNpc2lvbic6ICdVc2Ugc2hhcmVkIFdBTCcsXG4gICAgICAgICc6Y2hvaWNlJzogJ1NpbmdsZSBEQicsXG4gICAgICAgICc6cmF0aW9uYWxlJzogJ1NpbXBsZXInLFxuICAgICAgICAnOnJldmlzYWJsZSc6ICdZZXMnLFxuICAgICAgfSk7XG5cbiAgICAgIGRiLnByZXBhcmUoXG4gICAgICAgIGBJTlNFUlQgSU5UTyByZXF1aXJlbWVudHMgKGlkLCBjbGFzcywgc3RhdHVzLCBkZXNjcmlwdGlvbilcbiAgICAgICAgIFZBTFVFUyAoOmlkLCA6Y2xhc3MsIDpzdGF0dXMsIDpkZXNjKWAsXG4gICAgICApLnJ1bih7XG4gICAgICAgICc6aWQnOiAnUjAwMScsXG4gICAgICAgICc6Y2xhc3MnOiAnZnVuY3Rpb25hbCcsXG4gICAgICAgICc6c3RhdHVzJzogJ2FjdGl2ZScsXG4gICAgICAgICc6ZGVzYyc6ICdSZWNvdmVyeSB3b3JrcycsXG4gICAgICB9KTtcblxuICAgICAgLy8gQ2xlYXIgaGllcmFyY2h5IG9ubHlcbiAgICAgIGNsZWFySGllcmFyY2h5VGFibGVzKCk7XG5cbiAgICAgIC8vIFZlcmlmeSBkZWNpc2lvbnMgYW5kIHJlcXVpcmVtZW50cyBzdXJ2aXZlZFxuICAgICAgY29uc3QgZGVjaXNpb25zID0gZGIucHJlcGFyZSgnU0VMRUNUICogRlJPTSBkZWNpc2lvbnMnKS5hbGwoKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGVjaXNpb25zLmxlbmd0aCwgMSwgJ3ByZXNlcnZlOiBkZWNpc2lvbiBzdXJ2aXZlcyBjbGVhcicpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbCgoZGVjaXNpb25zWzBdIGFzIGFueSkuaWQsICdEMDAxJywgJ3ByZXNlcnZlOiBkZWNpc2lvbiBJRCBpbnRhY3QnKTtcblxuICAgICAgY29uc3QgcmVxdWlyZW1lbnRzID0gZGIucHJlcGFyZSgnU0VMRUNUICogRlJPTSByZXF1aXJlbWVudHMnKS5hbGwoKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVxdWlyZW1lbnRzLmxlbmd0aCwgMSwgJ3ByZXNlcnZlOiByZXF1aXJlbWVudCBzdXJ2aXZlcyBjbGVhcicpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbCgocmVxdWlyZW1lbnRzWzBdIGFzIGFueSkuaWQsICdSMDAxJywgJ3ByZXNlcnZlOiByZXF1aXJlbWVudCBJRCBpbnRhY3QnKTtcblxuICAgICAgLy8gUmVjb3ZlciBoaWVyYXJjaHlcbiAgICAgIG1pZ3JhdGVIaWVyYXJjaHlUb0RiKGJhc2UpO1xuICAgICAgY29uc3QgbWlsZXN0b25lcyA9IGdldEFsbE1pbGVzdG9uZXMoKTtcbiAgICAgIGFzc2VydC5vayhtaWxlc3RvbmVzLmxlbmd0aCA+IDAsICdwcmVzZXJ2ZTogbWlsZXN0b25lcyByZWNvdmVyZWQgYWZ0ZXIgY2xlYXInKTtcblxuICAgICAgLy8gVmVyaWZ5IG5vbi1oaWVyYXJjaHkgZGF0YSBzdGlsbCBpbnRhY3QgYWZ0ZXIgcmVjb3ZlcnlcbiAgICAgIGNvbnN0IGRlY2lzaW9uc0FmdGVyID0gZGIucHJlcGFyZSgnU0VMRUNUICogRlJPTSBkZWNpc2lvbnMnKS5hbGwoKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGVjaXNpb25zQWZ0ZXIubGVuZ3RoLCAxLCAncHJlc2VydmU6IGRlY2lzaW9uIHN0aWxsIHByZXNlbnQgYWZ0ZXIgcmVjb3ZlcnknKTtcblxuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdCgnZW1wdHkgbWlsZXN0b25lcyBkaXInLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIC8vIE5vIG1pbGVzdG9uZXMgd3JpdHRlbiAtIGp1c3QgdGhlIGVtcHR5IGRpclxuICAgICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuXG4gICAgICAvLyBQcmUtcG9wdWxhdGUgdG8gc2ltdWxhdGUgZXhpc3Rpbmcgc3RhdGVcbiAgICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiAnTTAwMScsIHRpdGxlOiAnR2hvc3QnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuXG4gICAgICAvLyBDbGVhciBhbmQgcmVjb3ZlciBmcm9tIGVtcHR5XG4gICAgICBjbGVhckhpZXJhcmNoeVRhYmxlcygpO1xuICAgICAgY29uc3QgY291bnRzID0gbWlncmF0ZUhpZXJhcmNoeVRvRGIoYmFzZSk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGNvdW50cy5taWxlc3RvbmVzLCAwLCAnZW1wdHk6IHplcm8gbWlsZXN0b25lcyByZWNvdmVyZWQnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoY291bnRzLnNsaWNlcywgMCwgJ2VtcHR5OiB6ZXJvIHNsaWNlcyByZWNvdmVyZWQnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoY291bnRzLnRhc2tzLCAwLCAnZW1wdHk6IHplcm8gdGFza3MgcmVjb3ZlcmVkJyk7XG5cbiAgICAgIGNvbnN0IGFsbCA9IGdldEFsbE1pbGVzdG9uZXMoKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoYWxsLmxlbmd0aCwgMCwgJ2VtcHR5OiBubyBtaWxlc3RvbmVzIGluIERCIGFmdGVyIHJlY292ZXJ5Jyk7XG5cbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgICAgY2xlYW51cChiYXNlKTtc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
