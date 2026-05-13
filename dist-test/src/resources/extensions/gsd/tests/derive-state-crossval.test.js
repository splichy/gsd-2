import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  deriveStateFromDb,
  _deriveStateImpl,
  invalidateStateCache
} from "../state.js";
import {
  openDatabase,
  closeDatabase
} from "../gsd-db.js";
import { migrateFromMarkdown, migrateHierarchyToDb } from "../md-importer.js";
function createFixtureBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-crossval-"));
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
function assertStatesEqual(dbState, fileState, prefix) {
  assert.deepStrictEqual(dbState.phase, fileState.phase, `${prefix}: phase`);
  assert.deepStrictEqual(dbState.activeMilestone?.id ?? null, fileState.activeMilestone?.id ?? null, `${prefix}: activeMilestone.id`);
  assert.deepStrictEqual(dbState.activeMilestone?.title ?? null, fileState.activeMilestone?.title ?? null, `${prefix}: activeMilestone.title`);
  assert.deepStrictEqual(dbState.activeSlice?.id ?? null, fileState.activeSlice?.id ?? null, `${prefix}: activeSlice.id`);
  assert.deepStrictEqual(dbState.activeSlice?.title ?? null, fileState.activeSlice?.title ?? null, `${prefix}: activeSlice.title`);
  assert.deepStrictEqual(dbState.activeTask?.id ?? null, fileState.activeTask?.id ?? null, `${prefix}: activeTask.id`);
  assert.deepStrictEqual(dbState.activeTask?.title ?? null, fileState.activeTask?.title ?? null, `${prefix}: activeTask.title`);
  assert.deepStrictEqual(dbState.blockers.length, fileState.blockers.length, `${prefix}: blockers.length`);
  assert.ok(typeof dbState.nextAction === "string", `${prefix}: nextAction is string`);
  assert.deepStrictEqual(dbState.registry.length, fileState.registry.length, `${prefix}: registry.length`);
  for (let i = 0; i < fileState.registry.length; i++) {
    assert.deepStrictEqual(dbState.registry[i]?.id, fileState.registry[i]?.id, `${prefix}: registry[${i}].id`);
    assert.deepStrictEqual(dbState.registry[i]?.status, fileState.registry[i]?.status, `${prefix}: registry[${i}].status`);
    assert.deepStrictEqual(
      JSON.stringify(dbState.registry[i]?.dependsOn ?? []),
      JSON.stringify(fileState.registry[i]?.dependsOn ?? []),
      `${prefix}: registry[${i}].dependsOn`
    );
  }
  assert.deepStrictEqual(dbState.requirements?.active ?? 0, fileState.requirements?.active ?? 0, `${prefix}: requirements.active`);
  assert.deepStrictEqual(dbState.requirements?.validated ?? 0, fileState.requirements?.validated ?? 0, `${prefix}: requirements.validated`);
  assert.deepStrictEqual(dbState.requirements?.total ?? 0, fileState.requirements?.total ?? 0, `${prefix}: requirements.total`);
  assert.deepStrictEqual(dbState.progress?.milestones?.done, fileState.progress?.milestones?.done, `${prefix}: progress.milestones.done`);
  assert.deepStrictEqual(dbState.progress?.milestones?.total, fileState.progress?.milestones?.total, `${prefix}: progress.milestones.total`);
  assert.deepStrictEqual(dbState.progress?.slices?.done ?? 0, fileState.progress?.slices?.done ?? 0, `${prefix}: progress.slices.done`);
  assert.deepStrictEqual(dbState.progress?.slices?.total ?? 0, fileState.progress?.slices?.total ?? 0, `${prefix}: progress.slices.total`);
  assert.deepStrictEqual(dbState.progress?.tasks?.done ?? 0, fileState.progress?.tasks?.done ?? 0, `${prefix}: progress.tasks.done`);
  assert.deepStrictEqual(dbState.progress?.tasks?.total ?? 0, fileState.progress?.tasks?.total ?? 0, `${prefix}: progress.tasks.total`);
}
describe("derive-state-crossval", async () => {
  test("crossval A: pre-planning", async () => {
    const base = createFixtureBase();
    try {
      writeFile(base, "milestones/M001/M001-CONTEXT.md", "# M001: New Project\n\nWe are exploring scope.");
      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);
      openDatabase(":memory:");
      migrateHierarchyToDb(base);
      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);
      assertStatesEqual(dbState, fileState, "A-preplan");
      assert.deepStrictEqual(dbState.phase, "pre-planning", "A-preplan: phase is pre-planning");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("crossval B: executing", async () => {
    const base = createFixtureBase();
    try {
      const roadmap = `# M001: Test Project

**Vision:** Test executing state.

## Slices

- [x] **S01: Foundation** \`risk:low\` \`depends:[]\`
  > After this: Foundation laid.

- [ ] **S02: Core Logic** \`risk:medium\` \`depends:[S01]\`
  > After this: Core working.
`;
      const planS02 = `---
estimated_steps: 2
estimated_files: 1
skills_used: []
---

# S02: Core Logic

**Goal:** Build core logic.
**Demo:** Tests pass.

## Tasks

- [x] **T01: Setup** \`est:15m\`
  Setup task.

- [ ] **T02: Implement** \`est:30m\`
  Implementation task.
`;
      writeFile(base, "milestones/M001/M001-ROADMAP.md", roadmap);
      writeFile(base, "milestones/M001/slices/S01/S01-SUMMARY.md", "---\nid: S01\nparent: M001\n---\n\n# S01: Foundation\n\nDone.");
      writeFile(base, "milestones/M001/slices/S01/S01-PLAN.md", `# S01: Foundation

**Goal:** Lay foundation.
**Demo:** Done.

## Tasks

- [x] **T01: Init** \`est:10m\`
  Init.
`);
      writeFile(base, "milestones/M001/slices/S02/S02-PLAN.md", planS02);
      writeFile(base, "milestones/M001/slices/S02/tasks/.gitkeep", "");
      writeFile(base, "milestones/M001/slices/S02/tasks/T01-PLAN.md", "# T01 Plan");
      writeFile(base, "milestones/M001/slices/S02/tasks/T01-SUMMARY.md", "---\nid: T01\n---\n\n# T01\n\nDone.");
      writeFile(base, "milestones/M001/slices/S02/tasks/T02-PLAN.md", "# T02 Plan");
      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);
      openDatabase(":memory:");
      migrateHierarchyToDb(base);
      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);
      assertStatesEqual(dbState, fileState, "B-executing");
      assert.deepStrictEqual(dbState.phase, "executing", "B-executing: phase is executing");
      assert.deepStrictEqual(dbState.activeSlice?.id, "S02", "B-executing: activeSlice is S02");
      assert.deepStrictEqual(dbState.activeTask?.id, "T02", "B-executing: activeTask is T02");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("crossval C: summarizing", async () => {
    const base = createFixtureBase();
    try {
      const roadmap = `# M001: Summarize Test

**Vision:** Test summarizing state.

## Slices

- [ ] **S01: Only Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.
`;
      const plan = `---
estimated_steps: 2
estimated_files: 1
skills_used: []
---

# S01: Only Slice

**Goal:** Do everything.
**Demo:** All done.

## Tasks

- [x] **T01: First** \`est:10m\`
  First task.

- [x] **T02: Second** \`est:10m\`
  Second task.
`;
      writeFile(base, "milestones/M001/M001-ROADMAP.md", roadmap);
      writeFile(base, "milestones/M001/slices/S01/S01-PLAN.md", plan);
      writeFile(base, "milestones/M001/slices/S01/tasks/.gitkeep", "");
      writeFile(base, "milestones/M001/slices/S01/tasks/T01-PLAN.md", "# T01 Plan");
      writeFile(base, "milestones/M001/slices/S01/tasks/T02-PLAN.md", "# T02 Plan");
      writeFile(base, "milestones/M001/slices/S01/tasks/T01-SUMMARY.md", "---\nid: T01\nparent: S01\nmilestone: M001\n---\n# T01 Summary\nDone.");
      writeFile(base, "milestones/M001/slices/S01/tasks/T02-SUMMARY.md", "---\nid: T02\nparent: S01\nmilestone: M001\n---\n# T02 Summary\nDone.");
      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);
      openDatabase(":memory:");
      migrateHierarchyToDb(base);
      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);
      assertStatesEqual(dbState, fileState, "C-summarizing");
      assert.deepStrictEqual(dbState.phase, "summarizing", "C-summarizing: phase is summarizing");
      assert.deepStrictEqual(dbState.activeSlice?.id, "S01", "C-summarizing: activeSlice is S01");
      assert.deepStrictEqual(dbState.activeTask, null, "C-summarizing: no activeTask");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("crossval D: multi-milestone", async () => {
    const base = createFixtureBase();
    try {
      const m1Roadmap = `# M001: First Milestone

**Vision:** Already done.

## Slices

- [x] **S01: Done Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.
`;
      const m2Roadmap = `# M002: Second Milestone

**Vision:** Currently active.

## Slices

- [ ] **S01: Active Slice** \`risk:low\` \`depends:[]\`
  > After this: Active work done.
`;
      const m2Plan = `---
estimated_steps: 1
estimated_files: 1
skills_used: []
---

# S01: Active Slice

**Goal:** Do the work.
**Demo:** It works.

## Tasks

- [ ] **T01: Work** \`est:30m\`
  Do the work.
`;
      writeFile(base, "milestones/M001/M001-ROADMAP.md", m1Roadmap);
      writeFile(base, "milestones/M001/M001-VALIDATION.md", "---\nverdict: pass\nremediation_round: 0\n---\n\n# Validation\nPassed.");
      writeFile(base, "milestones/M001/M001-SUMMARY.md", "# M001 Summary\n\nFirst milestone complete.");
      writeFile(base, "milestones/M002/M002-ROADMAP.md", m2Roadmap);
      writeFile(base, "milestones/M002/slices/S01/S01-PLAN.md", m2Plan);
      writeFile(base, "milestones/M002/slices/S01/tasks/.gitkeep", "");
      writeFile(base, "milestones/M002/slices/S01/tasks/T01-PLAN.md", "# T01 Plan");
      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);
      openDatabase(":memory:");
      migrateHierarchyToDb(base);
      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);
      assertStatesEqual(dbState, fileState, "D-multims");
      assert.deepStrictEqual(dbState.activeMilestone?.id, "M002", "D-multims: activeMilestone is M002");
      assert.deepStrictEqual(dbState.registry.length, 2, "D-multims: 2 milestones in registry");
      const m1 = dbState.registry.find((e) => e.id === "M001");
      const m2 = dbState.registry.find((e) => e.id === "M002");
      assert.deepStrictEqual(m1?.status, "complete", "D-multims: M001 complete");
      assert.deepStrictEqual(m2?.status, "active", "D-multims: M002 active");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("crossval E: blocked", async () => {
    const base = createFixtureBase();
    try {
      const roadmap = `# M001: Blocked Test

**Vision:** Test blocked state.

## Slices

- [ ] **S01: First** \`risk:low\` \`depends:[S02]\`
  > After this: First done.

- [ ] **S02: Second** \`risk:low\` \`depends:[S01]\`
  > After this: Second done.
`;
      writeFile(base, "milestones/M001/M001-ROADMAP.md", roadmap);
      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);
      openDatabase(":memory:");
      migrateHierarchyToDb(base);
      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);
      assertStatesEqual(dbState, fileState, "E-blocked");
      assert.deepStrictEqual(dbState.phase, "blocked", "E-blocked: phase is blocked when no slice deps are satisfied");
      assert.deepStrictEqual(dbState.activeSlice, null, "E-blocked: no activeSlice is selected through unmet deps");
      assert.ok(dbState.blockers.some((b) => b.includes("No slice eligible")), "E-blocked: blocker explains no eligible slice");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("crossval F: parked", async () => {
    const base = createFixtureBase();
    try {
      const roadmap = `# M001: Parked Milestone

**Vision:** Parked.

## Slices

- [ ] **S01: Some Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.
`;
      writeFile(base, "milestones/M001/M001-ROADMAP.md", roadmap);
      writeFile(base, "milestones/M001/M001-PARKED.md", "Parked for now.");
      writeFile(base, "milestones/M002/M002-CONTEXT.md", "# M002: Active Milestone\n\nReady to go.");
      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);
      openDatabase(":memory:");
      migrateHierarchyToDb(base);
      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);
      assertStatesEqual(dbState, fileState, "F-parked");
      assert.deepStrictEqual(dbState.activeMilestone?.id, "M002", "F-parked: activeMilestone is M002");
      assert.ok(dbState.registry.some((e) => e.id === "M001" && e.status === "parked"), "F-parked: M001 parked");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
  test("crossval G: auto-migration round-trip", async () => {
    const base = createFixtureBase();
    try {
      const roadmap = `# M001: Migration Test

**Vision:** Test migration fidelity.

## Slices

- [x] **S01: Done Setup** \`risk:low\` \`depends:[]\`
  > After this: Setup done.

- [ ] **S02: Active Work** \`risk:medium\` \`depends:[S01]\`
  > After this: Work done.

- [ ] **S03: Future Work** \`risk:high\` \`depends:[S02]\`
  > After this: All done.
`;
      const planS02 = `---
estimated_steps: 3
estimated_files: 2
skills_used: []
---

# S02: Active Work

**Goal:** Do the work.
**Demo:** Tests pass.

## Tasks

- [x] **T01: First** \`est:10m\`
  First task.

- [ ] **T02: Second** \`est:20m\`
  Second task.

- [ ] **T03: Third** \`est:15m\`
  Third task.
`;
      const requirements = `# Requirements

## Active

### R001 \u2014 Core Feature
- Status: active
- Description: Must have core feature.

## Validated

### R002 \u2014 Setup
- Status: validated
- Description: Setup is validated.

## Deferred

### R003 \u2014 Nice to Have
- Status: deferred
- Description: Maybe later.
`;
      writeFile(base, "milestones/M001/M001-ROADMAP.md", roadmap);
      writeFile(base, "milestones/M001/slices/S01/S01-SUMMARY.md", "---\nid: S01\nparent: M001\n---\n\n# S01: Done Setup\n\nDone.");
      writeFile(base, "milestones/M001/slices/S01/S01-PLAN.md", `# S01: Done Setup

**Goal:** Setup.
**Demo:** Done.

## Tasks

- [x] **T01: Init** \`est:10m\`
  Init.
`);
      writeFile(base, "milestones/M001/slices/S02/S02-PLAN.md", planS02);
      writeFile(base, "milestones/M001/slices/S02/tasks/.gitkeep", "");
      writeFile(base, "milestones/M001/slices/S02/tasks/T01-PLAN.md", "# T01 Plan");
      writeFile(base, "milestones/M001/slices/S02/tasks/T01-SUMMARY.md", "---\nid: T01\n---\n\n# T01\n\nDone.");
      writeFile(base, "milestones/M001/slices/S02/tasks/T02-PLAN.md", "# T02 Plan");
      writeFile(base, "milestones/M001/slices/S02/tasks/T03-PLAN.md", "# T03 Plan");
      writeFile(base, "REQUIREMENTS.md", requirements);
      invalidateStateCache();
      const fileState = await _deriveStateImpl(base);
      openDatabase(":memory:");
      const counts = migrateFromMarkdown(base);
      assert.ok(counts.hierarchy.milestones >= 1, "G-roundtrip: migrated milestones");
      assert.ok(counts.hierarchy.slices >= 2, "G-roundtrip: migrated slices");
      assert.ok(counts.hierarchy.tasks >= 3, "G-roundtrip: migrated tasks");
      assert.equal(counts.requirements, 3, "G-roundtrip: migrated requirements");
      invalidateStateCache();
      const dbState = await deriveStateFromDb(base);
      assertStatesEqual(dbState, fileState, "G-roundtrip");
      assert.deepStrictEqual(dbState.phase, "executing", "G-roundtrip: phase is executing");
      assert.deepStrictEqual(dbState.activeSlice?.id, "S02", "G-roundtrip: activeSlice is S02");
      assert.deepStrictEqual(dbState.activeTask?.id, "T02", "G-roundtrip: activeTask is T02");
      assert.deepStrictEqual(dbState.requirements?.active, 1, "G-roundtrip: requirements.active = 1");
      assert.deepStrictEqual(dbState.requirements?.validated, 1, "G-roundtrip: requirements.validated = 1");
      assert.deepStrictEqual(dbState.requirements?.deferred, 1, "G-roundtrip: requirements.deferred = 1");
      assert.deepStrictEqual(dbState.requirements?.total, 3, "G-roundtrip: requirements.total = 3");
      assert.deepStrictEqual(dbState.progress?.slices?.done, 1, "G-roundtrip: slices.done = 1");
      assert.deepStrictEqual(dbState.progress?.slices?.total, 3, "G-roundtrip: slices.total = 3");
      assert.deepStrictEqual(dbState.progress?.tasks?.done, 1, "G-roundtrip: tasks.done = 1");
      assert.deepStrictEqual(dbState.progress?.tasks?.total, 3, "G-roundtrip: tasks.total = 3");
      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9kZXJpdmUtc3RhdGUtY3Jvc3N2YWwudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QgfSBmcm9tICdub2RlOnRlc3QnO1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnO1xuLy8gZGVyaXZlLXN0YXRlLWNyb3NzdmFsLnRlc3QudHMgXHUyMDE0IENyb3NzLXZhbGlkYXRpb246IGRlcml2ZVN0YXRlRnJvbURiKCkgdnMgX2Rlcml2ZVN0YXRlSW1wbCgpXG4vLyBQcm92ZXMgYm90aCBwYXRocyBwcm9kdWNlIGZpZWxkLWlkZW50aWNhbCBHU0RTdGF0ZSBhY3Jvc3MgNyBmaXh0dXJlIHNjZW5hcmlvcyxcbi8vIHBsdXMgYW4gYXV0by1taWdyYXRpb24gcm91bmQtdHJpcCB0ZXN0LlxuXG5pbXBvcnQgeyBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdub2RlOnBhdGgnO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSAnbm9kZTpvcyc7XG5cbmltcG9ydCB7XG4gIGRlcml2ZVN0YXRlRnJvbURiLFxuICBfZGVyaXZlU3RhdGVJbXBsLFxuICBpbnZhbGlkYXRlU3RhdGVDYWNoZSxcbn0gZnJvbSAnLi4vc3RhdGUudHMnO1xuaW1wb3J0IHtcbiAgb3BlbkRhdGFiYXNlLFxuICBjbG9zZURhdGFiYXNlLFxuICBpbnNlcnRNaWxlc3RvbmUsXG4gIGluc2VydFNsaWNlLFxuICBpbnNlcnRUYXNrLFxufSBmcm9tICcuLi9nc2QtZGIudHMnO1xuaW1wb3J0IHsgbWlncmF0ZUZyb21NYXJrZG93biwgbWlncmF0ZUhpZXJhcmNoeVRvRGIgfSBmcm9tICcuLi9tZC1pbXBvcnRlci50cyc7XG5pbXBvcnQgdHlwZSB7IEdTRFN0YXRlIH0gZnJvbSAnLi4vdHlwZXMudHMnO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRml4dHVyZSBIZWxwZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBjcmVhdGVGaXh0dXJlQmFzZSgpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgJ2dzZC1jcm9zc3ZhbC0nKSk7XG4gIG1rZGlyU3luYyhqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHJldHVybiBiYXNlO1xufVxuXG5mdW5jdGlvbiB3cml0ZUZpbGUoYmFzZTogc3RyaW5nLCByZWxhdGl2ZVBhdGg6IHN0cmluZywgY29udGVudDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGZ1bGwgPSBqb2luKGJhc2UsICcuZ3NkJywgcmVsYXRpdmVQYXRoKTtcbiAgbWtkaXJTeW5jKGpvaW4oZnVsbCwgJy4uJyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGZ1bGwsIGNvbnRlbnQpO1xufVxuXG5mdW5jdGlvbiBjbGVhbnVwKGJhc2U6IHN0cmluZyk6IHZvaWQge1xuICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xufVxuXG4vKipcbiAqIENvbXBhcmUgZXZlcnkgR1NEU3RhdGUgZmllbGQgYmV0d2VlbiBEQiBhbmQgZmlsZXN5c3RlbSBkZXJpdmF0aW9uLlxuICogcHJlZml4IGlkZW50aWZpZXMgdGhlIHNjZW5hcmlvIGluIGFzc2VydGlvbiBtZXNzYWdlcy5cbiAqL1xuZnVuY3Rpb24gYXNzZXJ0U3RhdGVzRXF1YWwoZGJTdGF0ZTogR1NEU3RhdGUsIGZpbGVTdGF0ZTogR1NEU3RhdGUsIHByZWZpeDogc3RyaW5nKTogdm9pZCB7XG4gIC8vIFBoYXNlXG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGJTdGF0ZS5waGFzZSwgZmlsZVN0YXRlLnBoYXNlLCBgJHtwcmVmaXh9OiBwaGFzZWApO1xuXG4gIC8vIEFjdGl2ZSByZWZzXG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGJTdGF0ZS5hY3RpdmVNaWxlc3RvbmU/LmlkID8/IG51bGwsIGZpbGVTdGF0ZS5hY3RpdmVNaWxlc3RvbmU/LmlkID8/IG51bGwsIGAke3ByZWZpeH06IGFjdGl2ZU1pbGVzdG9uZS5pZGApO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUuYWN0aXZlTWlsZXN0b25lPy50aXRsZSA/PyBudWxsLCBmaWxlU3RhdGUuYWN0aXZlTWlsZXN0b25lPy50aXRsZSA/PyBudWxsLCBgJHtwcmVmaXh9OiBhY3RpdmVNaWxlc3RvbmUudGl0bGVgKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLmFjdGl2ZVNsaWNlPy5pZCA/PyBudWxsLCBmaWxlU3RhdGUuYWN0aXZlU2xpY2U/LmlkID8/IG51bGwsIGAke3ByZWZpeH06IGFjdGl2ZVNsaWNlLmlkYCk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGJTdGF0ZS5hY3RpdmVTbGljZT8udGl0bGUgPz8gbnVsbCwgZmlsZVN0YXRlLmFjdGl2ZVNsaWNlPy50aXRsZSA/PyBudWxsLCBgJHtwcmVmaXh9OiBhY3RpdmVTbGljZS50aXRsZWApO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUuYWN0aXZlVGFzaz8uaWQgPz8gbnVsbCwgZmlsZVN0YXRlLmFjdGl2ZVRhc2s/LmlkID8/IG51bGwsIGAke3ByZWZpeH06IGFjdGl2ZVRhc2suaWRgKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLmFjdGl2ZVRhc2s/LnRpdGxlID8/IG51bGwsIGZpbGVTdGF0ZS5hY3RpdmVUYXNrPy50aXRsZSA/PyBudWxsLCBgJHtwcmVmaXh9OiBhY3RpdmVUYXNrLnRpdGxlYCk7XG5cbiAgLy8gQmxvY2tlcnNcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLmJsb2NrZXJzLmxlbmd0aCwgZmlsZVN0YXRlLmJsb2NrZXJzLmxlbmd0aCwgYCR7cHJlZml4fTogYmxvY2tlcnMubGVuZ3RoYCk7XG5cbiAgLy8gTmV4dCBhY3Rpb24gKG1heSBkaWZmZXIgaW4gd29yZGluZyBiZXR3ZWVuIHBhdGhzIFx1MjAxNCBjb21wYXJlIHByZXNlbmNlKVxuICBhc3NlcnQub2sodHlwZW9mIGRiU3RhdGUubmV4dEFjdGlvbiA9PT0gJ3N0cmluZycsIGAke3ByZWZpeH06IG5leHRBY3Rpb24gaXMgc3RyaW5nYCk7XG5cbiAgLy8gUmVnaXN0cnkgXHUyMDE0IGxlbmd0aCBhbmQgZWFjaCBlbnRyeVxuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUucmVnaXN0cnkubGVuZ3RoLCBmaWxlU3RhdGUucmVnaXN0cnkubGVuZ3RoLCBgJHtwcmVmaXh9OiByZWdpc3RyeS5sZW5ndGhgKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBmaWxlU3RhdGUucmVnaXN0cnkubGVuZ3RoOyBpKyspIHtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUucmVnaXN0cnlbaV0/LmlkLCBmaWxlU3RhdGUucmVnaXN0cnlbaV0/LmlkLCBgJHtwcmVmaXh9OiByZWdpc3RyeVske2l9XS5pZGApO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGJTdGF0ZS5yZWdpc3RyeVtpXT8uc3RhdHVzLCBmaWxlU3RhdGUucmVnaXN0cnlbaV0/LnN0YXR1cywgYCR7cHJlZml4fTogcmVnaXN0cnlbJHtpfV0uc3RhdHVzYCk7XG4gICAgLy8gZGVwZW5kc09uIG1heSBvciBtYXkgbm90IGJlIHByZXNlbnRcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKFxuICAgICAgSlNPTi5zdHJpbmdpZnkoZGJTdGF0ZS5yZWdpc3RyeVtpXT8uZGVwZW5kc09uID8/IFtdKSxcbiAgICAgIEpTT04uc3RyaW5naWZ5KGZpbGVTdGF0ZS5yZWdpc3RyeVtpXT8uZGVwZW5kc09uID8/IFtdKSxcbiAgICAgIGAke3ByZWZpeH06IHJlZ2lzdHJ5WyR7aX1dLmRlcGVuZHNPbmAsXG4gICAgKTtcbiAgfVxuXG4gIC8vIFJlcXVpcmVtZW50c1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUucmVxdWlyZW1lbnRzPy5hY3RpdmUgPz8gMCwgZmlsZVN0YXRlLnJlcXVpcmVtZW50cz8uYWN0aXZlID8/IDAsIGAke3ByZWZpeH06IHJlcXVpcmVtZW50cy5hY3RpdmVgKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLnJlcXVpcmVtZW50cz8udmFsaWRhdGVkID8/IDAsIGZpbGVTdGF0ZS5yZXF1aXJlbWVudHM/LnZhbGlkYXRlZCA/PyAwLCBgJHtwcmVmaXh9OiByZXF1aXJlbWVudHMudmFsaWRhdGVkYCk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGJTdGF0ZS5yZXF1aXJlbWVudHM/LnRvdGFsID8/IDAsIGZpbGVTdGF0ZS5yZXF1aXJlbWVudHM/LnRvdGFsID8/IDAsIGAke3ByZWZpeH06IHJlcXVpcmVtZW50cy50b3RhbGApO1xuXG4gIC8vIFByb2dyZXNzXG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGJTdGF0ZS5wcm9ncmVzcz8ubWlsZXN0b25lcz8uZG9uZSwgZmlsZVN0YXRlLnByb2dyZXNzPy5taWxlc3RvbmVzPy5kb25lLCBgJHtwcmVmaXh9OiBwcm9ncmVzcy5taWxlc3RvbmVzLmRvbmVgKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLnByb2dyZXNzPy5taWxlc3RvbmVzPy50b3RhbCwgZmlsZVN0YXRlLnByb2dyZXNzPy5taWxlc3RvbmVzPy50b3RhbCwgYCR7cHJlZml4fTogcHJvZ3Jlc3MubWlsZXN0b25lcy50b3RhbGApO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUucHJvZ3Jlc3M/LnNsaWNlcz8uZG9uZSA/PyAwLCBmaWxlU3RhdGUucHJvZ3Jlc3M/LnNsaWNlcz8uZG9uZSA/PyAwLCBgJHtwcmVmaXh9OiBwcm9ncmVzcy5zbGljZXMuZG9uZWApO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUucHJvZ3Jlc3M/LnNsaWNlcz8udG90YWwgPz8gMCwgZmlsZVN0YXRlLnByb2dyZXNzPy5zbGljZXM/LnRvdGFsID8/IDAsIGAke3ByZWZpeH06IHByb2dyZXNzLnNsaWNlcy50b3RhbGApO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUucHJvZ3Jlc3M/LnRhc2tzPy5kb25lID8/IDAsIGZpbGVTdGF0ZS5wcm9ncmVzcz8udGFza3M/LmRvbmUgPz8gMCwgYCR7cHJlZml4fTogcHJvZ3Jlc3MudGFza3MuZG9uZWApO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUucHJvZ3Jlc3M/LnRhc2tzPy50b3RhbCA/PyAwLCBmaWxlU3RhdGUucHJvZ3Jlc3M/LnRhc2tzPy50b3RhbCA/PyAwLCBgJHtwcmVmaXh9OiBwcm9ncmVzcy50YXNrcy50b3RhbGApO1xufVxuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIFNjZW5hcmlvIGZpeHR1cmVzXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuZGVzY3JpYmUoJ2Rlcml2ZS1zdGF0ZS1jcm9zc3ZhbCcsIGFzeW5jICgpID0+IHtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgU2NlbmFyaW8gQTogUHJlLXBsYW5uaW5nIFx1MjAxNCBtaWxlc3RvbmUgd2l0aCBDT05URVhUIGJ1dCBubyByb2FkbWFwIFx1MjUwMFx1MjUwMFxuICB0ZXN0KCdjcm9zc3ZhbCBBOiBwcmUtcGxhbm5pbmcnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL00wMDEtQ09OVEVYVC5tZCcsICcjIE0wMDE6IE5ldyBQcm9qZWN0XFxuXFxuV2UgYXJlIGV4cGxvcmluZyBzY29wZS4nKTtcblxuICAgICAgLy8gRmlsZXN5c3RlbSBkZXJpdmF0aW9uXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3QgZmlsZVN0YXRlID0gYXdhaXQgX2Rlcml2ZVN0YXRlSW1wbChiYXNlKTtcblxuICAgICAgLy8gREIgZGVyaXZhdGlvbiB2aWEgbWlncmF0aW9uXG4gICAgICBvcGVuRGF0YWJhc2UoJzptZW1vcnk6Jyk7XG4gICAgICBtaWdyYXRlSGllcmFyY2h5VG9EYihiYXNlKTtcblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IGRiU3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZUZyb21EYihiYXNlKTtcblxuICAgICAgYXNzZXJ0U3RhdGVzRXF1YWwoZGJTdGF0ZSwgZmlsZVN0YXRlLCAnQS1wcmVwbGFuJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUucGhhc2UsICdwcmUtcGxhbm5pbmcnLCAnQS1wcmVwbGFuOiBwaGFzZSBpcyBwcmUtcGxhbm5pbmcnKTtcblxuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNjZW5hcmlvIEI6IEV4ZWN1dGluZyBcdTIwMTQgMiBzbGljZXMsIGZpcnN0IGNvbXBsZXRlLCBzZWNvbmQgYWN0aXZlIFx1MjUwMFx1MjUwMFxuICB0ZXN0KCdjcm9zc3ZhbCBCOiBleGVjdXRpbmcnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJvYWRtYXAgPSBgIyBNMDAxOiBUZXN0IFByb2plY3RcblxuKipWaXNpb246KiogVGVzdCBleGVjdXRpbmcgc3RhdGUuXG5cbiMjIFNsaWNlc1xuXG4tIFt4XSAqKlMwMTogRm91bmRhdGlvbioqIFxcYHJpc2s6bG93XFxgIFxcYGRlcGVuZHM6W11cXGBcbiAgPiBBZnRlciB0aGlzOiBGb3VuZGF0aW9uIGxhaWQuXG5cbi0gWyBdICoqUzAyOiBDb3JlIExvZ2ljKiogXFxgcmlzazptZWRpdW1cXGAgXFxgZGVwZW5kczpbUzAxXVxcYFxuICA+IEFmdGVyIHRoaXM6IENvcmUgd29ya2luZy5cbmA7XG4gICAgICBjb25zdCBwbGFuUzAyID0gYC0tLVxuZXN0aW1hdGVkX3N0ZXBzOiAyXG5lc3RpbWF0ZWRfZmlsZXM6IDFcbnNraWxsc191c2VkOiBbXVxuLS0tXG5cbiMgUzAyOiBDb3JlIExvZ2ljXG5cbioqR29hbDoqKiBCdWlsZCBjb3JlIGxvZ2ljLlxuKipEZW1vOioqIFRlc3RzIHBhc3MuXG5cbiMjIFRhc2tzXG5cbi0gW3hdICoqVDAxOiBTZXR1cCoqIFxcYGVzdDoxNW1cXGBcbiAgU2V0dXAgdGFzay5cblxuLSBbIF0gKipUMDI6IEltcGxlbWVudCoqIFxcYGVzdDozMG1cXGBcbiAgSW1wbGVtZW50YXRpb24gdGFzay5cbmA7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9NMDAxLVJPQURNQVAubWQnLCByb2FkbWFwKTtcbiAgICAgIC8vIFMwMSBjb21wbGV0ZSBcdTIwMTQgbmVlZHMgYSBzdW1tYXJ5XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzAxL1MwMS1TVU1NQVJZLm1kJywgJy0tLVxcbmlkOiBTMDFcXG5wYXJlbnQ6IE0wMDFcXG4tLS1cXG5cXG4jIFMwMTogRm91bmRhdGlvblxcblxcbkRvbmUuJyk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzAxL1MwMS1QTEFOLm1kJywgYCMgUzAxOiBGb3VuZGF0aW9uXFxuXFxuKipHb2FsOioqIExheSBmb3VuZGF0aW9uLlxcbioqRGVtbzoqKiBEb25lLlxcblxcbiMjIFRhc2tzXFxuXFxuLSBbeF0gKipUMDE6IEluaXQqKiBcXGBlc3Q6MTBtXFxgXFxuICBJbml0LlxcbmApO1xuICAgICAgLy8gUzAyIGFjdGl2ZSB3aXRoIHBsYW5cbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDIvUzAyLVBMQU4ubWQnLCBwbGFuUzAyKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDIvdGFza3MvLmdpdGtlZXAnLCAnJyk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzAyL3Rhc2tzL1QwMS1QTEFOLm1kJywgJyMgVDAxIFBsYW4nKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDIvdGFza3MvVDAxLVNVTU1BUlkubWQnLCAnLS0tXFxuaWQ6IFQwMVxcbi0tLVxcblxcbiMgVDAxXFxuXFxuRG9uZS4nKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDIvdGFza3MvVDAyLVBMQU4ubWQnLCAnIyBUMDIgUGxhbicpO1xuXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3QgZmlsZVN0YXRlID0gYXdhaXQgX2Rlcml2ZVN0YXRlSW1wbChiYXNlKTtcblxuICAgICAgb3BlbkRhdGFiYXNlKCc6bWVtb3J5OicpO1xuICAgICAgbWlncmF0ZUhpZXJhcmNoeVRvRGIoYmFzZSk7XG5cbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBkYlN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGVGcm9tRGIoYmFzZSk7XG5cbiAgICAgIGFzc2VydFN0YXRlc0VxdWFsKGRiU3RhdGUsIGZpbGVTdGF0ZSwgJ0ItZXhlY3V0aW5nJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUucGhhc2UsICdleGVjdXRpbmcnLCAnQi1leGVjdXRpbmc6IHBoYXNlIGlzIGV4ZWN1dGluZycpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLmFjdGl2ZVNsaWNlPy5pZCwgJ1MwMicsICdCLWV4ZWN1dGluZzogYWN0aXZlU2xpY2UgaXMgUzAyJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUuYWN0aXZlVGFzaz8uaWQsICdUMDInLCAnQi1leGVjdXRpbmc6IGFjdGl2ZVRhc2sgaXMgVDAyJyk7XG5cbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTY2VuYXJpbyBDOiBTdW1tYXJpemluZyBcdTIwMTQgYWxsIHRhc2tzIGRvbmUsIG5vIHNsaWNlIHN1bW1hcnkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIHRlc3QoJ2Nyb3NzdmFsIEM6IHN1bW1hcml6aW5nJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCByb2FkbWFwID0gYCMgTTAwMTogU3VtbWFyaXplIFRlc3RcblxuKipWaXNpb246KiogVGVzdCBzdW1tYXJpemluZyBzdGF0ZS5cblxuIyMgU2xpY2VzXG5cbi0gWyBdICoqUzAxOiBPbmx5IFNsaWNlKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbXVxcYFxuICA+IEFmdGVyIHRoaXM6IERvbmUuXG5gO1xuICAgICAgY29uc3QgcGxhbiA9IGAtLS1cbmVzdGltYXRlZF9zdGVwczogMlxuZXN0aW1hdGVkX2ZpbGVzOiAxXG5za2lsbHNfdXNlZDogW11cbi0tLVxuXG4jIFMwMTogT25seSBTbGljZVxuXG4qKkdvYWw6KiogRG8gZXZlcnl0aGluZy5cbioqRGVtbzoqKiBBbGwgZG9uZS5cblxuIyMgVGFza3NcblxuLSBbeF0gKipUMDE6IEZpcnN0KiogXFxgZXN0OjEwbVxcYFxuICBGaXJzdCB0YXNrLlxuXG4tIFt4XSAqKlQwMjogU2Vjb25kKiogXFxgZXN0OjEwbVxcYFxuICBTZWNvbmQgdGFzay5cbmA7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9NMDAxLVJPQURNQVAubWQnLCByb2FkbWFwKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvUzAxLVBMQU4ubWQnLCBwbGFuKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvdGFza3MvLmdpdGtlZXAnLCAnJyk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzAxL3Rhc2tzL1QwMS1QTEFOLm1kJywgJyMgVDAxIFBsYW4nKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvdGFza3MvVDAyLVBMQU4ubWQnLCAnIyBUMDIgUGxhbicpO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMS90YXNrcy9UMDEtU1VNTUFSWS5tZCcsICctLS1cXG5pZDogVDAxXFxucGFyZW50OiBTMDFcXG5taWxlc3RvbmU6IE0wMDFcXG4tLS1cXG4jIFQwMSBTdW1tYXJ5XFxuRG9uZS4nKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvdGFza3MvVDAyLVNVTU1BUlkubWQnLCAnLS0tXFxuaWQ6IFQwMlxcbnBhcmVudDogUzAxXFxubWlsZXN0b25lOiBNMDAxXFxuLS0tXFxuIyBUMDIgU3VtbWFyeVxcbkRvbmUuJyk7XG4gICAgICAvLyBUYXNrcyBoYXZlIHN1bW1hcmllcywgYnV0IG5vIFMwMS1TVU1NQVJZLm1kIFx1MjAxNCBzaG91bGQgYmUgc3VtbWFyaXppbmdcblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IGZpbGVTdGF0ZSA9IGF3YWl0IF9kZXJpdmVTdGF0ZUltcGwoYmFzZSk7XG5cbiAgICAgIG9wZW5EYXRhYmFzZSgnOm1lbW9yeTonKTtcbiAgICAgIG1pZ3JhdGVIaWVyYXJjaHlUb0RiKGJhc2UpO1xuXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3QgZGJTdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlRnJvbURiKGJhc2UpO1xuXG4gICAgICBhc3NlcnRTdGF0ZXNFcXVhbChkYlN0YXRlLCBmaWxlU3RhdGUsICdDLXN1bW1hcml6aW5nJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUucGhhc2UsICdzdW1tYXJpemluZycsICdDLXN1bW1hcml6aW5nOiBwaGFzZSBpcyBzdW1tYXJpemluZycpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLmFjdGl2ZVNsaWNlPy5pZCwgJ1MwMScsICdDLXN1bW1hcml6aW5nOiBhY3RpdmVTbGljZSBpcyBTMDEnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGJTdGF0ZS5hY3RpdmVUYXNrLCBudWxsLCAnQy1zdW1tYXJpemluZzogbm8gYWN0aXZlVGFzaycpO1xuXG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgU2NlbmFyaW8gRDogTXVsdGktbWlsZXN0b25lIFx1MjAxNCBNMDAxIGNvbXBsZXRlLCBNMDAyIGFjdGl2ZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgdGVzdCgnY3Jvc3N2YWwgRDogbXVsdGktbWlsZXN0b25lJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBtMVJvYWRtYXAgPSBgIyBNMDAxOiBGaXJzdCBNaWxlc3RvbmVcblxuKipWaXNpb246KiogQWxyZWFkeSBkb25lLlxuXG4jIyBTbGljZXNcblxuLSBbeF0gKipTMDE6IERvbmUgU2xpY2UqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXG4gID4gQWZ0ZXIgdGhpczogRG9uZS5cbmA7XG4gICAgICBjb25zdCBtMlJvYWRtYXAgPSBgIyBNMDAyOiBTZWNvbmQgTWlsZXN0b25lXG5cbioqVmlzaW9uOioqIEN1cnJlbnRseSBhY3RpdmUuXG5cbiMjIFNsaWNlc1xuXG4tIFsgXSAqKlMwMTogQWN0aXZlIFNsaWNlKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbXVxcYFxuICA+IEFmdGVyIHRoaXM6IEFjdGl2ZSB3b3JrIGRvbmUuXG5gO1xuICAgICAgY29uc3QgbTJQbGFuID0gYC0tLVxuZXN0aW1hdGVkX3N0ZXBzOiAxXG5lc3RpbWF0ZWRfZmlsZXM6IDFcbnNraWxsc191c2VkOiBbXVxuLS0tXG5cbiMgUzAxOiBBY3RpdmUgU2xpY2VcblxuKipHb2FsOioqIERvIHRoZSB3b3JrLlxuKipEZW1vOioqIEl0IHdvcmtzLlxuXG4jIyBUYXNrc1xuXG4tIFsgXSAqKlQwMTogV29yayoqIFxcYGVzdDozMG1cXGBcbiAgRG8gdGhlIHdvcmsuXG5gO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvTTAwMS1ST0FETUFQLm1kJywgbTFSb2FkbWFwKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL00wMDEtVkFMSURBVElPTi5tZCcsICctLS1cXG52ZXJkaWN0OiBwYXNzXFxucmVtZWRpYXRpb25fcm91bmQ6IDBcXG4tLS1cXG5cXG4jIFZhbGlkYXRpb25cXG5QYXNzZWQuJyk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9NMDAxLVNVTU1BUlkubWQnLCAnIyBNMDAxIFN1bW1hcnlcXG5cXG5GaXJzdCBtaWxlc3RvbmUgY29tcGxldGUuJyk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMi9NMDAyLVJPQURNQVAubWQnLCBtMlJvYWRtYXApO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDIvc2xpY2VzL1MwMS9TMDEtUExBTi5tZCcsIG0yUGxhbik7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMi9zbGljZXMvUzAxL3Rhc2tzLy5naXRrZWVwJywgJycpO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDIvc2xpY2VzL1MwMS90YXNrcy9UMDEtUExBTi5tZCcsICcjIFQwMSBQbGFuJyk7XG5cbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBmaWxlU3RhdGUgPSBhd2FpdCBfZGVyaXZlU3RhdGVJbXBsKGJhc2UpO1xuXG4gICAgICBvcGVuRGF0YWJhc2UoJzptZW1vcnk6Jyk7XG4gICAgICBtaWdyYXRlSGllcmFyY2h5VG9EYihiYXNlKTtcblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IGRiU3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZUZyb21EYihiYXNlKTtcblxuICAgICAgYXNzZXJ0U3RhdGVzRXF1YWwoZGJTdGF0ZSwgZmlsZVN0YXRlLCAnRC1tdWx0aW1zJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUuYWN0aXZlTWlsZXN0b25lPy5pZCwgJ00wMDInLCAnRC1tdWx0aW1zOiBhY3RpdmVNaWxlc3RvbmUgaXMgTTAwMicpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLnJlZ2lzdHJ5Lmxlbmd0aCwgMiwgJ0QtbXVsdGltczogMiBtaWxlc3RvbmVzIGluIHJlZ2lzdHJ5Jyk7XG5cbiAgICAgIGNvbnN0IG0xID0gZGJTdGF0ZS5yZWdpc3RyeS5maW5kKGUgPT4gZS5pZCA9PT0gJ00wMDEnKTtcbiAgICAgIGNvbnN0IG0yID0gZGJTdGF0ZS5yZWdpc3RyeS5maW5kKGUgPT4gZS5pZCA9PT0gJ00wMDInKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwobTE/LnN0YXR1cywgJ2NvbXBsZXRlJywgJ0QtbXVsdGltczogTTAwMSBjb21wbGV0ZScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChtMj8uc3RhdHVzLCAnYWN0aXZlJywgJ0QtbXVsdGltczogTTAwMiBhY3RpdmUnKTtcblxuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNjZW5hcmlvIEU6IEJsb2NrZWQgXHUyMDE0IGNpcmN1bGFyIHNsaWNlIGRlcHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIHRlc3QoJ2Nyb3NzdmFsIEU6IGJsb2NrZWQnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJvYWRtYXAgPSBgIyBNMDAxOiBCbG9ja2VkIFRlc3RcblxuKipWaXNpb246KiogVGVzdCBibG9ja2VkIHN0YXRlLlxuXG4jIyBTbGljZXNcblxuLSBbIF0gKipTMDE6IEZpcnN0KiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbUzAyXVxcYFxuICA+IEFmdGVyIHRoaXM6IEZpcnN0IGRvbmUuXG5cbi0gWyBdICoqUzAyOiBTZWNvbmQqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltTMDFdXFxgXG4gID4gQWZ0ZXIgdGhpczogU2Vjb25kIGRvbmUuXG5gO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvTTAwMS1ST0FETUFQLm1kJywgcm9hZG1hcCk7XG5cbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBmaWxlU3RhdGUgPSBhd2FpdCBfZGVyaXZlU3RhdGVJbXBsKGJhc2UpO1xuXG4gICAgICBvcGVuRGF0YWJhc2UoJzptZW1vcnk6Jyk7XG4gICAgICBtaWdyYXRlSGllcmFyY2h5VG9EYihiYXNlKTtcblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IGRiU3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZUZyb21EYihiYXNlKTtcblxuICAgICAgYXNzZXJ0U3RhdGVzRXF1YWwoZGJTdGF0ZSwgZmlsZVN0YXRlLCAnRS1ibG9ja2VkJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUucGhhc2UsICdibG9ja2VkJywgJ0UtYmxvY2tlZDogcGhhc2UgaXMgYmxvY2tlZCB3aGVuIG5vIHNsaWNlIGRlcHMgYXJlIHNhdGlzZmllZCcpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLmFjdGl2ZVNsaWNlLCBudWxsLCAnRS1ibG9ja2VkOiBubyBhY3RpdmVTbGljZSBpcyBzZWxlY3RlZCB0aHJvdWdoIHVubWV0IGRlcHMnKTtcbiAgICAgIGFzc2VydC5vayhkYlN0YXRlLmJsb2NrZXJzLnNvbWUoYiA9PiBiLmluY2x1ZGVzKCdObyBzbGljZSBlbGlnaWJsZScpKSwgJ0UtYmxvY2tlZDogYmxvY2tlciBleHBsYWlucyBubyBlbGlnaWJsZSBzbGljZScpO1xuXG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgU2NlbmFyaW8gRjogUGFya2VkIFx1MjAxNCBQQVJLRUQgZmlsZSBvbiBtaWxlc3RvbmUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIHRlc3QoJ2Nyb3NzdmFsIEY6IHBhcmtlZCcsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgcm9hZG1hcCA9IGAjIE0wMDE6IFBhcmtlZCBNaWxlc3RvbmVcblxuKipWaXNpb246KiogUGFya2VkLlxuXG4jIyBTbGljZXNcblxuLSBbIF0gKipTMDE6IFNvbWUgU2xpY2UqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXG4gID4gQWZ0ZXIgdGhpczogRG9uZS5cbmA7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9NMDAxLVJPQURNQVAubWQnLCByb2FkbWFwKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL00wMDEtUEFSS0VELm1kJywgJ1BhcmtlZCBmb3Igbm93LicpO1xuICAgICAgLy8gU2Vjb25kIG1pbGVzdG9uZSBwaWNrcyB1cCBhcyBhY3RpdmVcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAyL00wMDItQ09OVEVYVC5tZCcsICcjIE0wMDI6IEFjdGl2ZSBNaWxlc3RvbmVcXG5cXG5SZWFkeSB0byBnby4nKTtcblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IGZpbGVTdGF0ZSA9IGF3YWl0IF9kZXJpdmVTdGF0ZUltcGwoYmFzZSk7XG5cbiAgICAgIG9wZW5EYXRhYmFzZSgnOm1lbW9yeTonKTtcbiAgICAgIG1pZ3JhdGVIaWVyYXJjaHlUb0RiKGJhc2UpO1xuXG4gICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgY29uc3QgZGJTdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlRnJvbURiKGJhc2UpO1xuXG4gICAgICBhc3NlcnRTdGF0ZXNFcXVhbChkYlN0YXRlLCBmaWxlU3RhdGUsICdGLXBhcmtlZCcpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQsICdNMDAyJywgJ0YtcGFya2VkOiBhY3RpdmVNaWxlc3RvbmUgaXMgTTAwMicpO1xuICAgICAgYXNzZXJ0Lm9rKGRiU3RhdGUucmVnaXN0cnkuc29tZShlID0+IGUuaWQgPT09ICdNMDAxJyAmJiBlLnN0YXR1cyA9PT0gJ3BhcmtlZCcpLCAnRi1wYXJrZWQ6IE0wMDEgcGFya2VkJyk7XG5cbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTY2VuYXJpbyBHOiBBdXRvLW1pZ3JhdGlvbiByb3VuZC10cmlwIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAvLyBDcmVhdGUgYSBtYXJrZG93bi1vbmx5IGZpeHR1cmUgKG5vIERCKS4gTWlncmF0ZSB0byBEQi4gQm90aCBwYXRocyBpZGVudGljYWwuXG4gIHRlc3QoJ2Nyb3NzdmFsIEc6IGF1dG8tbWlncmF0aW9uIHJvdW5kLXRyaXAnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJvYWRtYXAgPSBgIyBNMDAxOiBNaWdyYXRpb24gVGVzdFxuXG4qKlZpc2lvbjoqKiBUZXN0IG1pZ3JhdGlvbiBmaWRlbGl0eS5cblxuIyMgU2xpY2VzXG5cbi0gW3hdICoqUzAxOiBEb25lIFNldHVwKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbXVxcYFxuICA+IEFmdGVyIHRoaXM6IFNldHVwIGRvbmUuXG5cbi0gWyBdICoqUzAyOiBBY3RpdmUgV29yayoqIFxcYHJpc2s6bWVkaXVtXFxgIFxcYGRlcGVuZHM6W1MwMV1cXGBcbiAgPiBBZnRlciB0aGlzOiBXb3JrIGRvbmUuXG5cbi0gWyBdICoqUzAzOiBGdXR1cmUgV29yayoqIFxcYHJpc2s6aGlnaFxcYCBcXGBkZXBlbmRzOltTMDJdXFxgXG4gID4gQWZ0ZXIgdGhpczogQWxsIGRvbmUuXG5gO1xuICAgICAgY29uc3QgcGxhblMwMiA9IGAtLS1cbmVzdGltYXRlZF9zdGVwczogM1xuZXN0aW1hdGVkX2ZpbGVzOiAyXG5za2lsbHNfdXNlZDogW11cbi0tLVxuXG4jIFMwMjogQWN0aXZlIFdvcmtcblxuKipHb2FsOioqIERvIHRoZSB3b3JrLlxuKipEZW1vOioqIFRlc3RzIHBhc3MuXG5cbiMjIFRhc2tzXG5cbi0gW3hdICoqVDAxOiBGaXJzdCoqIFxcYGVzdDoxMG1cXGBcbiAgRmlyc3QgdGFzay5cblxuLSBbIF0gKipUMDI6IFNlY29uZCoqIFxcYGVzdDoyMG1cXGBcbiAgU2Vjb25kIHRhc2suXG5cbi0gWyBdICoqVDAzOiBUaGlyZCoqIFxcYGVzdDoxNW1cXGBcbiAgVGhpcmQgdGFzay5cbmA7XG4gICAgICBjb25zdCByZXF1aXJlbWVudHMgPSBgIyBSZXF1aXJlbWVudHNcblxuIyMgQWN0aXZlXG5cbiMjIyBSMDAxIFx1MjAxNCBDb3JlIEZlYXR1cmVcbi0gU3RhdHVzOiBhY3RpdmVcbi0gRGVzY3JpcHRpb246IE11c3QgaGF2ZSBjb3JlIGZlYXR1cmUuXG5cbiMjIFZhbGlkYXRlZFxuXG4jIyMgUjAwMiBcdTIwMTQgU2V0dXBcbi0gU3RhdHVzOiB2YWxpZGF0ZWRcbi0gRGVzY3JpcHRpb246IFNldHVwIGlzIHZhbGlkYXRlZC5cblxuIyMgRGVmZXJyZWRcblxuIyMjIFIwMDMgXHUyMDE0IE5pY2UgdG8gSGF2ZVxuLSBTdGF0dXM6IGRlZmVycmVkXG4tIERlc2NyaXB0aW9uOiBNYXliZSBsYXRlci5cbmA7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9NMDAxLVJPQURNQVAubWQnLCByb2FkbWFwKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvUzAxLVNVTU1BUlkubWQnLCAnLS0tXFxuaWQ6IFMwMVxcbnBhcmVudDogTTAwMVxcbi0tLVxcblxcbiMgUzAxOiBEb25lIFNldHVwXFxuXFxuRG9uZS4nKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvUzAxLVBMQU4ubWQnLCBgIyBTMDE6IERvbmUgU2V0dXBcXG5cXG4qKkdvYWw6KiogU2V0dXAuXFxuKipEZW1vOioqIERvbmUuXFxuXFxuIyMgVGFza3NcXG5cXG4tIFt4XSAqKlQwMTogSW5pdCoqIFxcYGVzdDoxMG1cXGBcXG4gIEluaXQuXFxuYCk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzAyL1MwMi1QTEFOLm1kJywgcGxhblMwMik7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzAyL3Rhc2tzLy5naXRrZWVwJywgJycpO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdtaWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMi90YXNrcy9UMDEtUExBTi5tZCcsICcjIFQwMSBQbGFuJyk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzAyL3Rhc2tzL1QwMS1TVU1NQVJZLm1kJywgJy0tLVxcbmlkOiBUMDFcXG4tLS1cXG5cXG4jIFQwMVxcblxcbkRvbmUuJyk7XG4gICAgICB3cml0ZUZpbGUoYmFzZSwgJ21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzAyL3Rhc2tzL1QwMi1QTEFOLm1kJywgJyMgVDAyIFBsYW4nKTtcbiAgICAgIHdyaXRlRmlsZShiYXNlLCAnbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDIvdGFza3MvVDAzLVBMQU4ubWQnLCAnIyBUMDMgUGxhbicpO1xuICAgICAgd3JpdGVGaWxlKGJhc2UsICdSRVFVSVJFTUVOVFMubWQnLCByZXF1aXJlbWVudHMpO1xuXG4gICAgICAvLyBTdGVwIDE6IEdldCBmaWxlc3lzdGVtLW9ubHkgc3RhdGVcbiAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICBjb25zdCBmaWxlU3RhdGUgPSBhd2FpdCBfZGVyaXZlU3RhdGVJbXBsKGJhc2UpO1xuXG4gICAgICAvLyBTdGVwIDI6IE1pZ3JhdGUgbWFya2Rvd24gdG8gREJcbiAgICAgIG9wZW5EYXRhYmFzZSgnOm1lbW9yeTonKTtcbiAgICAgIGNvbnN0IGNvdW50cyA9IG1pZ3JhdGVGcm9tTWFya2Rvd24oYmFzZSk7XG5cbiAgICAgIC8vIFZlcmlmeSBtaWdyYXRpb24gcG9wdWxhdGVkIGNvcnJlY3RseVxuICAgICAgYXNzZXJ0Lm9rKGNvdW50cy5oaWVyYXJjaHkubWlsZXN0b25lcyA+PSAxLCAnRy1yb3VuZHRyaXA6IG1pZ3JhdGVkIG1pbGVzdG9uZXMnKTtcbiAgICAgIGFzc2VydC5vayhjb3VudHMuaGllcmFyY2h5LnNsaWNlcyA+PSAyLCAnRy1yb3VuZHRyaXA6IG1pZ3JhdGVkIHNsaWNlcycpO1xuICAgICAgYXNzZXJ0Lm9rKGNvdW50cy5oaWVyYXJjaHkudGFza3MgPj0gMywgJ0ctcm91bmR0cmlwOiBtaWdyYXRlZCB0YXNrcycpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGNvdW50cy5yZXF1aXJlbWVudHMsIDMsICdHLXJvdW5kdHJpcDogbWlncmF0ZWQgcmVxdWlyZW1lbnRzJyk7XG5cbiAgICAgIC8vIFN0ZXAgMzogR2V0IERCLWJhY2tlZCBzdGF0ZVxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICAgIGNvbnN0IGRiU3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZUZyb21EYihiYXNlKTtcblxuICAgICAgLy8gU3RlcCA0OiBEZWVwIGNyb3NzLXZhbGlkYXRpb25cbiAgICAgIGFzc2VydFN0YXRlc0VxdWFsKGRiU3RhdGUsIGZpbGVTdGF0ZSwgJ0ctcm91bmR0cmlwJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUucGhhc2UsICdleGVjdXRpbmcnLCAnRy1yb3VuZHRyaXA6IHBoYXNlIGlzIGV4ZWN1dGluZycpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLmFjdGl2ZVNsaWNlPy5pZCwgJ1MwMicsICdHLXJvdW5kdHJpcDogYWN0aXZlU2xpY2UgaXMgUzAyJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUuYWN0aXZlVGFzaz8uaWQsICdUMDInLCAnRy1yb3VuZHRyaXA6IGFjdGl2ZVRhc2sgaXMgVDAyJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUucmVxdWlyZW1lbnRzPy5hY3RpdmUsIDEsICdHLXJvdW5kdHJpcDogcmVxdWlyZW1lbnRzLmFjdGl2ZSA9IDEnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGJTdGF0ZS5yZXF1aXJlbWVudHM/LnZhbGlkYXRlZCwgMSwgJ0ctcm91bmR0cmlwOiByZXF1aXJlbWVudHMudmFsaWRhdGVkID0gMScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLnJlcXVpcmVtZW50cz8uZGVmZXJyZWQsIDEsICdHLXJvdW5kdHJpcDogcmVxdWlyZW1lbnRzLmRlZmVycmVkID0gMScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLnJlcXVpcmVtZW50cz8udG90YWwsIDMsICdHLXJvdW5kdHJpcDogcmVxdWlyZW1lbnRzLnRvdGFsID0gMycpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLnByb2dyZXNzPy5zbGljZXM/LmRvbmUsIDEsICdHLXJvdW5kdHJpcDogc2xpY2VzLmRvbmUgPSAxJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRiU3RhdGUucHJvZ3Jlc3M/LnNsaWNlcz8udG90YWwsIDMsICdHLXJvdW5kdHJpcDogc2xpY2VzLnRvdGFsID0gMycpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLnByb2dyZXNzPy50YXNrcz8uZG9uZSwgMSwgJ0ctcm91bmR0cmlwOiB0YXNrcy5kb25lID0gMScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkYlN0YXRlLnByb2dyZXNzPy50YXNrcz8udG90YWwsIDMsICdHLXJvdW5kdHJpcDogdGFza3MudG90YWwgPSAzJyk7XG5cbiAgICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxTQUFTLFVBQVUsWUFBWTtBQUMvQixPQUFPLFlBQVk7QUFLbkIsU0FBUyxhQUFhLFdBQVcsUUFBUSxxQkFBcUI7QUFDOUQsU0FBUyxZ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
