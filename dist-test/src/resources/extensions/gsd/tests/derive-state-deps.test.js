import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveState } from "../state.js";
function createFixtureBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-deps-test-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}
function writeRoadmap(base, mid, content) {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-ROADMAP.md`), content);
}
function writeMilestoneSummary(base, mid, content) {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-SUMMARY.md`), content);
}
function writeMilestoneValidation(base, mid) {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-VALIDATION.md`), `---
verdict: pass
remediation_round: 0
---

# Validation
Passed.`);
}
function writeContext(base, mid, frontmatter) {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-CONTEXT.md`), `---
${frontmatter}
---
`);
}
function writeContextDraft(base, mid, frontmatter) {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-CONTEXT-DRAFT.md`), `---
${frontmatter}
---

# Draft Context
This is a draft.`);
}
function writeSlicePlan(base, mid, sid, content) {
  const dir = join(base, ".gsd", "milestones", mid, "slices", sid);
  mkdirSync(join(dir, "tasks"), { recursive: true });
  writeFileSync(join(dir, "tasks", "T01-PLAN.md"), "# T01 Plan\n");
  writeFileSync(join(dir, `${sid}-PLAN.md`), content);
}
function cleanup(base) {
  rmSync(base, { recursive: true, force: true });
}
describe("derive-state-deps", async () => {
  test("blocked-deps", async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M001", `# M001: First Milestone

**Vision:** First milestone still in progress.

## Slices

- [ ] **S01: Incomplete Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeSlicePlan(base, "M001", "S01", `# S01: Incomplete Slice

**Goal:** Verify dep-blocked milestone behavior.
**Demo:** Tests pass.

## Tasks

- [ ] **T01: Do work** \`est:15m\`
  First task still in progress.
`);
      writeRoadmap(base, "M002", `# M002: Second Milestone

**Vision:** Second milestone blocked by M001.

## Slices

- [ ] **S01: Blocked Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeContext(base, "M002", "depends_on: [M001]");
      const state = await deriveState(base);
      assert.deepStrictEqual(state.registry[0]?.status, "active", "blocked-deps: M001 is active");
      assert.deepStrictEqual(state.registry[1]?.status, "pending", "blocked-deps: M002 is pending (dep-blocked)");
      assert.deepStrictEqual(state.phase, "executing", "blocked-deps: phase is executing (M001 is active)");
      assert.deepStrictEqual(state.activeMilestone?.id, "M001", "blocked-deps: activeMilestone is M001");
    } finally {
      cleanup(base);
    }
  });
  test("unblocked-deps", async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M001", `# M001: First Milestone

**Vision:** First milestone complete.

## Slices

- [x] **S01: Done** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeMilestoneValidation(base, "M001");
      writeMilestoneSummary(base, "M001", "# M001 Summary\n\nFirst milestone is complete.");
      writeRoadmap(base, "M002", `# M002: Second Milestone

**Vision:** Second milestone now active.

## Slices

- [ ] **S01: Active Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeContext(base, "M002", "depends_on: [M001]");
      const state = await deriveState(base);
      assert.deepStrictEqual(state.registry[0]?.status, "complete", "unblocked-deps: M001 is complete");
      assert.deepStrictEqual(state.registry[1]?.status, "active", "unblocked-deps: M002 is active");
      assert.deepStrictEqual(state.activeMilestone?.id, "M002", "unblocked-deps: activeMilestone is M002");
      assert.ok(state.phase !== "blocked", "unblocked-deps: phase is not blocked");
    } finally {
      cleanup(base);
    }
  });
  test("all-blocked", async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M001", `# M001: First Milestone

**Vision:** Circular dependency.

## Slices

- [ ] **S01: Waiting** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeContext(base, "M001", "depends_on: [M002]");
      writeRoadmap(base, "M002", `# M002: Second Milestone

**Vision:** Also in circular dependency.

## Slices

- [ ] **S01: Also Waiting** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeContext(base, "M002", "depends_on: [M001]");
      const state = await deriveState(base);
      assert.deepStrictEqual(state.phase, "blocked", "all-blocked: phase is blocked");
      assert.ok(state.activeMilestone === null || state.activeMilestone !== null, "all-blocked: state is consistent");
      assert.ok(state.blockers.length > 0, "all-blocked: blockers array is non-empty");
    } finally {
      cleanup(base);
    }
  });
  test("absent-context", async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M001", `# M001: First Milestone

**Vision:** No context file, no deps.

## Slices

- [ ] **S01: Incomplete** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeRoadmap(base, "M002", `# M002: Second Milestone

**Vision:** Also no context file.

## Slices

- [ ] **S01: Pending** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      const state = await deriveState(base);
      assert.deepStrictEqual(state.registry[0]?.status, "active", "absent-context: M001 is active");
      assert.deepStrictEqual(state.registry[1]?.status, "pending", "absent-context: M002 is pending");
      assert.deepStrictEqual(state.activeMilestone?.id, "M001", "absent-context: activeMilestone is M001");
      assert.ok(state.phase !== "blocked", "absent-context: phase is not blocked");
    } finally {
      cleanup(base);
    }
  });
  test("forward-dep", async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M001", `# M001: First Milestone

**Vision:** Depends on M002 which is already complete.

## Slices

- [ ] **S01: Ready** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeContext(base, "M001", "depends_on: [M002]");
      writeRoadmap(base, "M002", `# M002: Second Milestone

**Vision:** Already complete.

## Slices

- [x] **S01: Done** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeMilestoneValidation(base, "M002");
      writeMilestoneSummary(base, "M002", "# M002 Summary\n\nSecond milestone is complete.");
      const state = await deriveState(base);
      assert.deepStrictEqual(state.activeMilestone?.id, "M001", "forward-dep: activeMilestone is M001");
      assert.deepStrictEqual(state.registry[1]?.status, "complete", "forward-dep: M002 is complete");
      assert.ok(state.phase !== "blocked", "forward-dep: phase is not blocked");
    } finally {
      cleanup(base);
    }
  });
  test("empty-deps-list", async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M001", `# M001: First Milestone

**Vision:** First milestone still in progress.

## Slices

- [ ] **S01: Incomplete** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeRoadmap(base, "M002", `# M002: Second Milestone

**Vision:** Empty deps list, no blocking constraint.

## Slices

- [ ] **S01: Waiting for M001** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeContext(base, "M002", "depends_on: []");
      const state = await deriveState(base);
      assert.deepStrictEqual(state.registry[0]?.status, "active", "empty-deps-list: M001 is active");
      assert.deepStrictEqual(state.registry[1]?.status, "pending", "empty-deps-list: M002 is pending (M001 not done yet)");
      assert.ok(state.phase !== "blocked", "empty-deps-list: phase is not blocked");
    } finally {
      cleanup(base);
    }
  });
  test("unique-id-deps: unique milestone IDs with lowercase hex suffix", async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M004-0zjrg0", `# M004-0zjrg0: First Unique Milestone

**Vision:** Complete milestone with unique ID.

## Slices

- [x] **S01: Done** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeMilestoneValidation(base, "M004-0zjrg0");
      writeMilestoneSummary(base, "M004-0zjrg0", "# M004-0zjrg0 Summary\n\nComplete.");
      writeContext(base, "M005-b0m2hl", "depends_on: [M004-0zjrg0]");
      const state = await deriveState(base);
      assert.deepStrictEqual(
        state.registry.find((e) => e.id === "M004-0zjrg0")?.status,
        "complete",
        "unique-id-deps: M004-0zjrg0 is complete"
      );
      assert.deepStrictEqual(
        state.registry.find((e) => e.id === "M005-b0m2hl")?.status,
        "active",
        "unique-id-deps: M005-b0m2hl is active (dep on M004-0zjrg0 met)"
      );
      assert.deepStrictEqual(
        state.activeMilestone?.id,
        "M005-b0m2hl",
        "unique-id-deps: activeMilestone is M005-b0m2hl"
      );
      assert.ok(
        state.phase !== "blocked",
        "unique-id-deps: phase is not blocked"
      );
    } finally {
      cleanup(base);
    }
  });
  test("unique-id-deps-blocked: unique ID dep not yet met", async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M004-0zjrg0", `# M004-0zjrg0: Incomplete Unique Milestone

**Vision:** Still in progress.

## Slices

- [ ] **S01: In Progress** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeSlicePlan(base, "M004-0zjrg0", "S01", `# S01: In Progress

**Goal:** Test dep blocking with unique IDs.

## Tasks

- [ ] **T01: Work** \`est:15m\`
  Still doing work.
`);
      writeContext(base, "M005-b0m2hl", "depends_on: [M004-0zjrg0]");
      const state = await deriveState(base);
      assert.deepStrictEqual(
        state.activeMilestone?.id,
        "M004-0zjrg0",
        "unique-id-deps-blocked: activeMilestone is M004-0zjrg0"
      );
      assert.deepStrictEqual(
        state.registry.find((e) => e.id === "M005-b0m2hl")?.status,
        "pending",
        "unique-id-deps-blocked: M005-b0m2hl is pending (dep not met)"
      );
    } finally {
      cleanup(base);
    }
  });
  test("draft-context-deps: depends_on read from CONTEXT-DRAFT.md", async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M001", `# M001: First Milestone

**Vision:** First milestone still in progress.

## Slices

- [ ] **S01: Incomplete Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeSlicePlan(base, "M001", "S01", `# S01: Incomplete Slice

**Goal:** Test draft dep blocking.
**Demo:** Tests pass.

## Tasks

- [ ] **T01: Do work** \`est:15m\`
  First task still in progress.
`);
      writeRoadmap(base, "M002", `# M002: Second Milestone

**Vision:** Second milestone blocked by M001 via draft context.

## Slices

- [ ] **S01: Blocked Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeContextDraft(base, "M002", "depends_on: [M001]");
      const state = await deriveState(base);
      assert.deepStrictEqual(state.registry[0]?.status, "active", "draft-context-deps: M001 is active");
      assert.deepStrictEqual(state.registry[1]?.status, "pending", "draft-context-deps: M002 is pending (dep-blocked via draft)");
      assert.deepStrictEqual(state.activeMilestone?.id, "M001", "draft-context-deps: activeMilestone is M001");
    } finally {
      cleanup(base);
    }
  });
  test("draft-context-deps-no-roadmap: depends_on from draft without roadmap", async () => {
    const base = createFixtureBase();
    try {
      const m001Dir = join(base, ".gsd", "milestones", "M001");
      mkdirSync(m001Dir, { recursive: true });
      writeContextDraft(base, "M002", "depends_on: [M001]");
      const state = await deriveState(base);
      const m002Entry = state.registry.find((e) => e.id === "M002");
      assert.deepStrictEqual(m002Entry?.status, "pending", "draft-no-roadmap: M002 is pending (dep-blocked via draft)");
    } finally {
      cleanup(base);
    }
  });
  test("parseContextDependsOn: preserves case of unique IDs", async () => {
    const { parseContextDependsOn } = await import("../files.js");
    const deps1 = parseContextDependsOn("---\ndepends_on: [M004-0zjrg0]\n---\n");
    assert.deepStrictEqual(
      deps1[0],
      "M004-0zjrg0",
      "parseContextDependsOn preserves lowercase hex suffix"
    );
    const deps2 = parseContextDependsOn("---\ndepends_on: [M001, M004-abc123]\n---\n");
    assert.deepStrictEqual(deps2[0], "M001", "preserves classic uppercase ID");
    assert.deepStrictEqual(deps2[1], "M004-abc123", "preserves mixed-case unique ID");
    const deps3 = parseContextDependsOn("---\ndepends_on: []\n---\n");
    assert.deepStrictEqual(deps3.length, 0, "empty deps returns empty array");
    const deps4 = parseContextDependsOn(null);
    assert.deepStrictEqual(deps4.length, 0, "null content returns empty array");
  });
  test("draft-only-deps-blocked: CONTEXT-DRAFT.md depends_on blocks promotion", async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M001", `# M001: First Milestone

**Vision:** First milestone still in progress.

## Slices

- [ ] **S01: Incomplete Slice** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeSlicePlan(base, "M001", "S01", `# S01: Incomplete Slice

**Goal:** Test draft dep blocking.
**Demo:** Tests pass.

## Tasks

- [ ] **T01: Do work** \`est:15m\`
  First task still in progress.
`);
      writeContextDraft(base, "M002", "depends_on: [M001]");
      const state = await deriveState(base);
      assert.deepStrictEqual(
        state.activeMilestone?.id,
        "M001",
        "draft-only-deps-blocked: activeMilestone is M001"
      );
      assert.deepStrictEqual(
        state.registry.find((e) => e.id === "M002")?.status,
        "pending",
        "draft-only-deps-blocked: M002 is pending (dep on M001 not met, read from CONTEXT-DRAFT)"
      );
      assert.ok(
        state.phase !== "blocked",
        "draft-only-deps-blocked: phase is not blocked (M001 is active)"
      );
    } finally {
      cleanup(base);
    }
  });
  test("draft-only-deps-unblocked: CONTEXT-DRAFT.md dep met \u2192 milestone activates", async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M001", `# M001: First Milestone

**Vision:** Complete milestone.

## Slices

- [x] **S01: Done** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeMilestoneValidation(base, "M001");
      writeMilestoneSummary(base, "M001", "# M001 Summary\n\nComplete.");
      writeContextDraft(base, "M002", "depends_on: [M001]");
      const state = await deriveState(base);
      assert.deepStrictEqual(
        state.registry.find((e) => e.id === "M001")?.status,
        "complete",
        "draft-only-deps-unblocked: M001 is complete"
      );
      assert.deepStrictEqual(
        state.registry.find((e) => e.id === "M002")?.status,
        "active",
        "draft-only-deps-unblocked: M002 is active (dep on M001 met via CONTEXT-DRAFT)"
      );
      assert.deepStrictEqual(
        state.activeMilestone?.id,
        "M002",
        "draft-only-deps-unblocked: activeMilestone is M002"
      );
    } finally {
      cleanup(base);
    }
  });
  test("draft-only-deps-with-roadmap: has-roadmap path reads CONTEXT-DRAFT deps", async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M001", `# M001: First Milestone

**Vision:** Still in progress.

## Slices

- [ ] **S01: Working** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeSlicePlan(base, "M001", "S01", `# S01: Working

**Goal:** Test.
**Demo:** Tests pass.

## Tasks

- [ ] **T01: Work** \`est:15m\`
  Doing work.
`);
      writeRoadmap(base, "M002", `# M002: Second Milestone

**Vision:** Has roadmap but only draft context with deps.

## Slices

- [ ] **S01: Blocked** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeContextDraft(base, "M002", "depends_on: [M001]");
      const state = await deriveState(base);
      assert.deepStrictEqual(
        state.activeMilestone?.id,
        "M001",
        "draft-only-deps-with-roadmap: activeMilestone is M001"
      );
      assert.deepStrictEqual(
        state.registry.find((e) => e.id === "M002")?.status,
        "pending",
        "draft-only-deps-with-roadmap: M002 is pending (dep read from CONTEXT-DRAFT in has-roadmap path)"
      );
    } finally {
      cleanup(base);
    }
  });
  test("draft-only-no-deps: CONTEXT-DRAFT without depends_on \u2192 no constraint", async () => {
    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M001", `# M001: First Milestone

**Vision:** Complete.

## Slices

- [x] **S01: Done** \`risk:low\` \`depends:[]\`
  > After this: Done.
`);
      writeMilestoneValidation(base, "M001");
      writeMilestoneSummary(base, "M001", "# M001 Summary\n\nComplete.");
      writeContextDraft(base, "M002", "title: Some Draft");
      const state = await deriveState(base);
      assert.deepStrictEqual(
        state.registry.find((e) => e.id === "M002")?.status,
        "active",
        "draft-only-no-deps: M002 is active (no deps constraint in draft)"
      );
    } finally {
      cleanup(base);
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9kZXJpdmUtc3RhdGUtZGVwcy50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBkZXNjcmliZSwgdGVzdCB9IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdub2RlOnBhdGgnO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSAnbm9kZTpvcyc7XG5cbmltcG9ydCB7IGRlcml2ZVN0YXRlIH0gZnJvbSAnLi4vc3RhdGUudHMnO1xuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEZpeHR1cmUgSGVscGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gY3JlYXRlRml4dHVyZUJhc2UoKTogc3RyaW5nIHtcbiAgY29uc3QgYmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksICdnc2QtZGVwcy10ZXN0LScpKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgcmV0dXJuIGJhc2U7XG59XG5cbmZ1bmN0aW9uIHdyaXRlUm9hZG1hcChiYXNlOiBzdHJpbmcsIG1pZDogc3RyaW5nLCBjb250ZW50OiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgZGlyID0gam9pbihiYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgbWlkKTtcbiAgbWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIGAke21pZH0tUk9BRE1BUC5tZGApLCBjb250ZW50KTtcbn1cblxuZnVuY3Rpb24gd3JpdGVNaWxlc3RvbmVTdW1tYXJ5KGJhc2U6IHN0cmluZywgbWlkOiBzdHJpbmcsIGNvbnRlbnQ6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBkaXIgPSBqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCBtaWQpO1xuICBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgYCR7bWlkfS1TVU1NQVJZLm1kYCksIGNvbnRlbnQpO1xufVxuXG5mdW5jdGlvbiB3cml0ZU1pbGVzdG9uZVZhbGlkYXRpb24oYmFzZTogc3RyaW5nLCBtaWQ6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBkaXIgPSBqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCBtaWQpO1xuICBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgYCR7bWlkfS1WQUxJREFUSU9OLm1kYCksIGAtLS1cXG52ZXJkaWN0OiBwYXNzXFxucmVtZWRpYXRpb25fcm91bmQ6IDBcXG4tLS1cXG5cXG4jIFZhbGlkYXRpb25cXG5QYXNzZWQuYCk7XG59XG5cbi8qKlxuICogQ3JlYXRlcyBNMDB4LUNPTlRFWFQubWQgd2l0aCBhIHZhbGlkIFlBTUwgZnJvbnRtYXR0ZXIgYmxvY2suXG4gKiBmcm9udG1hdHRlciBpcyB0aGUgcmF3IFlBTUwgbGluZXMgYmV0d2VlbiB0aGUgLS0tIGRlbGltaXRlcnMuXG4gKi9cbmZ1bmN0aW9uIHdyaXRlQ29udGV4dChiYXNlOiBzdHJpbmcsIG1pZDogc3RyaW5nLCBmcm9udG1hdHRlcjogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGRpciA9IGpvaW4oYmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsIG1pZCk7XG4gIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBgJHttaWR9LUNPTlRFWFQubWRgKSwgYC0tLVxcbiR7ZnJvbnRtYXR0ZXJ9XFxuLS0tXFxuYCk7XG59XG5cbmZ1bmN0aW9uIHdyaXRlQ29udGV4dERyYWZ0KGJhc2U6IHN0cmluZywgbWlkOiBzdHJpbmcsIGZyb250bWF0dGVyOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgZGlyID0gam9pbihiYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgbWlkKTtcbiAgbWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIGAke21pZH0tQ09OVEVYVC1EUkFGVC5tZGApLCBgLS0tXFxuJHtmcm9udG1hdHRlcn1cXG4tLS1cXG5cXG4jIERyYWZ0IENvbnRleHRcXG5UaGlzIGlzIGEgZHJhZnQuYCk7XG59XG5cbmZ1bmN0aW9uIHdyaXRlU2xpY2VQbGFuKGJhc2U6IHN0cmluZywgbWlkOiBzdHJpbmcsIHNpZDogc3RyaW5nLCBjb250ZW50OiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgZGlyID0gam9pbihiYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgbWlkLCAnc2xpY2VzJywgc2lkKTtcbiAgbWtkaXJTeW5jKGpvaW4oZGlyLCAndGFza3MnKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwidGFza3NcIiwgXCJUMDEtUExBTi5tZFwiKSwgXCIjIFQwMSBQbGFuXFxuXCIpO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBgJHtzaWR9LVBMQU4ubWRgKSwgY29udGVudCk7XG59XG5cbmZ1bmN0aW9uIGNsZWFudXAoYmFzZTogc3RyaW5nKTogdm9pZCB7XG4gIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG59XG5cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuLy8gVGVzdCBHcm91cHNcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG5kZXNjcmliZSgnZGVyaXZlLXN0YXRlLWRlcHMnLCBhc3luYyAoKSA9PiB7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRlc3QgR3JvdXAgMTogYmxvY2tlZC1kZXBzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAvLyBNMDAxIGlzIGluY29tcGxldGUgKG5vIFNVTU1BUlkpLCBNMDAyIGRlcGVuZHNfb24gTTAwMSBcdTIxOTIgTTAwMiBpcyBwZW5kaW5nXG4gIHRlc3QoJ2Jsb2NrZWQtZGVwcycsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgLy8gTTAwMTogaW5jb21wbGV0ZSAob25lIHNsaWNlLCBubyBTVU1NQVJZKVxuICAgICAgd3JpdGVSb2FkbWFwKGJhc2UsICdNMDAxJywgYCMgTTAwMTogRmlyc3QgTWlsZXN0b25lXG5cbioqVmlzaW9uOioqIEZpcnN0IG1pbGVzdG9uZSBzdGlsbCBpbiBwcm9ncmVzcy5cblxuIyMgU2xpY2VzXG5cbi0gWyBdICoqUzAxOiBJbmNvbXBsZXRlIFNsaWNlKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbXVxcYFxuICA+IEFmdGVyIHRoaXM6IERvbmUuXG5gKTtcblxuICAgICAgLy8gTTAwMTogYWRkIGEgc2xpY2UgcGxhbiB3aXRoIGFuIGFjdGl2ZSB0YXNrIHNvIHBoYXNlIGlzICdleGVjdXRpbmcnXG4gICAgICB3cml0ZVNsaWNlUGxhbihiYXNlLCAnTTAwMScsICdTMDEnLCBgIyBTMDE6IEluY29tcGxldGUgU2xpY2VcblxuKipHb2FsOioqIFZlcmlmeSBkZXAtYmxvY2tlZCBtaWxlc3RvbmUgYmVoYXZpb3IuXG4qKkRlbW86KiogVGVzdHMgcGFzcy5cblxuIyMgVGFza3NcblxuLSBbIF0gKipUMDE6IERvIHdvcmsqKiBcXGBlc3Q6MTVtXFxgXG4gIEZpcnN0IHRhc2sgc3RpbGwgaW4gcHJvZ3Jlc3MuXG5gKTtcblxuICAgICAgLy8gTTAwMjogZGVwZW5kcyBvbiBNMDAxLCBhbHNvIGluY29tcGxldGVcbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCAnTTAwMicsIGAjIE0wMDI6IFNlY29uZCBNaWxlc3RvbmVcblxuKipWaXNpb246KiogU2Vjb25kIG1pbGVzdG9uZSBibG9ja2VkIGJ5IE0wMDEuXG5cbiMjIFNsaWNlc1xuXG4tIFsgXSAqKlMwMTogQmxvY2tlZCBTbGljZSoqIFxcYHJpc2s6bG93XFxgIFxcYGRlcGVuZHM6W11cXGBcbiAgPiBBZnRlciB0aGlzOiBEb25lLlxuYCk7XG4gICAgICB3cml0ZUNvbnRleHQoYmFzZSwgJ00wMDInLCAnZGVwZW5kc19vbjogW00wMDFdJyk7XG5cbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG5cbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucmVnaXN0cnlbMF0/LnN0YXR1cywgJ2FjdGl2ZScsICdibG9ja2VkLWRlcHM6IE0wMDEgaXMgYWN0aXZlJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnJlZ2lzdHJ5WzFdPy5zdGF0dXMsICdwZW5kaW5nJywgJ2Jsb2NrZWQtZGVwczogTTAwMiBpcyBwZW5kaW5nIChkZXAtYmxvY2tlZCknKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucGhhc2UsICdleGVjdXRpbmcnLCAnYmxvY2tlZC1kZXBzOiBwaGFzZSBpcyBleGVjdXRpbmcgKE0wMDEgaXMgYWN0aXZlKScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5hY3RpdmVNaWxlc3RvbmU/LmlkLCAnTTAwMScsICdibG9ja2VkLWRlcHM6IGFjdGl2ZU1pbGVzdG9uZSBpcyBNMDAxJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCBHcm91cCAyOiB1bmJsb2NrZWQtZGVwcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgLy8gTTAwMSBpcyBjb21wbGV0ZSAoYWxsIHNsaWNlcyBbeF0gKyBTVU1NQVJZKSwgTTAwMiBkZXBlbmRzX29uIE0wMDEgXHUyMTkyIE0wMDIgYmVjb21lcyBhY3RpdmVcbiAgdGVzdCgndW5ibG9ja2VkLWRlcHMnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIC8vIE0wMDE6IGNvbXBsZXRlIChhbGwgc2xpY2VzIGRvbmUgKyBTVU1NQVJZIHByZXNlbnQpXG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgJ00wMDEnLCBgIyBNMDAxOiBGaXJzdCBNaWxlc3RvbmVcblxuKipWaXNpb246KiogRmlyc3QgbWlsZXN0b25lIGNvbXBsZXRlLlxuXG4jIyBTbGljZXNcblxuLSBbeF0gKipTMDE6IERvbmUqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXG4gID4gQWZ0ZXIgdGhpczogRG9uZS5cbmApO1xuICAgICAgd3JpdGVNaWxlc3RvbmVWYWxpZGF0aW9uKGJhc2UsICdNMDAxJyk7XG4gICAgICB3cml0ZU1pbGVzdG9uZVN1bW1hcnkoYmFzZSwgJ00wMDEnLCAnIyBNMDAxIFN1bW1hcnlcXG5cXG5GaXJzdCBtaWxlc3RvbmUgaXMgY29tcGxldGUuJyk7XG5cbiAgICAgIC8vIE0wMDI6IGRlcGVuZHMgb24gTTAwMSwgbm93IHVuYmxvY2tlZFxuICAgICAgd3JpdGVSb2FkbWFwKGJhc2UsICdNMDAyJywgYCMgTTAwMjogU2Vjb25kIE1pbGVzdG9uZVxuXG4qKlZpc2lvbjoqKiBTZWNvbmQgbWlsZXN0b25lIG5vdyBhY3RpdmUuXG5cbiMjIFNsaWNlc1xuXG4tIFsgXSAqKlMwMTogQWN0aXZlIFNsaWNlKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbXVxcYFxuICA+IEFmdGVyIHRoaXM6IERvbmUuXG5gKTtcbiAgICAgIHdyaXRlQ29udGV4dChiYXNlLCAnTTAwMicsICdkZXBlbmRzX29uOiBbTTAwMV0nKTtcblxuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcblxuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5yZWdpc3RyeVswXT8uc3RhdHVzLCAnY29tcGxldGUnLCAndW5ibG9ja2VkLWRlcHM6IE0wMDEgaXMgY29tcGxldGUnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucmVnaXN0cnlbMV0/LnN0YXR1cywgJ2FjdGl2ZScsICd1bmJsb2NrZWQtZGVwczogTTAwMiBpcyBhY3RpdmUnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUuYWN0aXZlTWlsZXN0b25lPy5pZCwgJ00wMDInLCAndW5ibG9ja2VkLWRlcHM6IGFjdGl2ZU1pbGVzdG9uZSBpcyBNMDAyJyk7XG4gICAgICBhc3NlcnQub2soc3RhdGUucGhhc2UgIT09ICdibG9ja2VkJywgJ3VuYmxvY2tlZC1kZXBzOiBwaGFzZSBpcyBub3QgYmxvY2tlZCcpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRlc3QgR3JvdXAgMzogYWxsLWJsb2NrZWQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIC8vIE0wMDEgZGVwZW5kc19vbiBNMDAyLCBNMDAyIGRlcGVuZHNfb24gTTAwMSBcdTIwMTQgY2lyY3VsYXIgZGVwLCBuZWl0aGVyIGNhbiBhY3RpdmF0ZVxuICB0ZXN0KCdhbGwtYmxvY2tlZCcsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgLy8gTTAwMTogZGVwZW5kcyBvbiBNMDAyXG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgJ00wMDEnLCBgIyBNMDAxOiBGaXJzdCBNaWxlc3RvbmVcblxuKipWaXNpb246KiogQ2lyY3VsYXIgZGVwZW5kZW5jeS5cblxuIyMgU2xpY2VzXG5cbi0gWyBdICoqUzAxOiBXYWl0aW5nKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbXVxcYFxuICA+IEFmdGVyIHRoaXM6IERvbmUuXG5gKTtcbiAgICAgIHdyaXRlQ29udGV4dChiYXNlLCAnTTAwMScsICdkZXBlbmRzX29uOiBbTTAwMl0nKTtcblxuICAgICAgLy8gTTAwMjogZGVwZW5kcyBvbiBNMDAxXG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgJ00wMDInLCBgIyBNMDAyOiBTZWNvbmQgTWlsZXN0b25lXG5cbioqVmlzaW9uOioqIEFsc28gaW4gY2lyY3VsYXIgZGVwZW5kZW5jeS5cblxuIyMgU2xpY2VzXG5cbi0gWyBdICoqUzAxOiBBbHNvIFdhaXRpbmcqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXG4gID4gQWZ0ZXIgdGhpczogRG9uZS5cbmApO1xuICAgICAgd3JpdGVDb250ZXh0KGJhc2UsICdNMDAyJywgJ2RlcGVuZHNfb246IFtNMDAxXScpO1xuXG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuXG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnBoYXNlLCAnYmxvY2tlZCcsICdhbGwtYmxvY2tlZDogcGhhc2UgaXMgYmxvY2tlZCcpO1xuICAgICAgYXNzZXJ0Lm9rKHN0YXRlLmFjdGl2ZU1pbGVzdG9uZSA9PT0gbnVsbCB8fCBzdGF0ZS5hY3RpdmVNaWxlc3RvbmUgIT09IG51bGwsICdhbGwtYmxvY2tlZDogc3RhdGUgaXMgY29uc2lzdGVudCcpO1xuICAgICAgYXNzZXJ0Lm9rKHN0YXRlLmJsb2NrZXJzLmxlbmd0aCA+IDAsICdhbGwtYmxvY2tlZDogYmxvY2tlcnMgYXJyYXkgaXMgbm9uLWVtcHR5Jyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCBHcm91cCA0OiBhYnNlbnQtY29udGV4dCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgLy8gTmVpdGhlciBNMDAxIG5vciBNMDAyIGhhcyBhIENPTlRFWFQubWQgXHUyMTkyIG5vIGRlcCBjb25zdHJhaW50cywgbm9ybWFsIHNlcXVlbnRpYWwgYmVoYXZpb3JcbiAgdGVzdCgnYWJzZW50LWNvbnRleHQnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIC8vIE0wMDE6IGluY29tcGxldGUsIG5vIENPTlRFWFQubWRcbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCAnTTAwMScsIGAjIE0wMDE6IEZpcnN0IE1pbGVzdG9uZVxuXG4qKlZpc2lvbjoqKiBObyBjb250ZXh0IGZpbGUsIG5vIGRlcHMuXG5cbiMjIFNsaWNlc1xuXG4tIFsgXSAqKlMwMTogSW5jb21wbGV0ZSoqIFxcYHJpc2s6bG93XFxgIFxcYGRlcGVuZHM6W11cXGBcbiAgPiBBZnRlciB0aGlzOiBEb25lLlxuYCk7XG5cbiAgICAgIC8vIE0wMDI6IGluY29tcGxldGUsIG5vIENPTlRFWFQubWRcbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCAnTTAwMicsIGAjIE0wMDI6IFNlY29uZCBNaWxlc3RvbmVcblxuKipWaXNpb246KiogQWxzbyBubyBjb250ZXh0IGZpbGUuXG5cbiMjIFNsaWNlc1xuXG4tIFsgXSAqKlMwMTogUGVuZGluZyoqIFxcYHJpc2s6bG93XFxgIFxcYGRlcGVuZHM6W11cXGBcbiAgPiBBZnRlciB0aGlzOiBEb25lLlxuYCk7XG5cbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG5cbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucmVnaXN0cnlbMF0/LnN0YXR1cywgJ2FjdGl2ZScsICdhYnNlbnQtY29udGV4dDogTTAwMSBpcyBhY3RpdmUnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucmVnaXN0cnlbMV0/LnN0YXR1cywgJ3BlbmRpbmcnLCAnYWJzZW50LWNvbnRleHQ6IE0wMDIgaXMgcGVuZGluZycpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5hY3RpdmVNaWxlc3RvbmU/LmlkLCAnTTAwMScsICdhYnNlbnQtY29udGV4dDogYWN0aXZlTWlsZXN0b25lIGlzIE0wMDEnKTtcbiAgICAgIGFzc2VydC5vayhzdGF0ZS5waGFzZSAhPT0gJ2Jsb2NrZWQnLCAnYWJzZW50LWNvbnRleHQ6IHBoYXNlIGlzIG5vdCBibG9ja2VkJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCBHcm91cCA1OiBmb3J3YXJkLWRlcCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgLy8gTTAwMSBkZXBlbmRzX29uIE0wMDIsIGJ1dCBNMDAyIGlzIGFscmVhZHkgY29tcGxldGUgXHUyMTkyIE0wMDEgY2FuIGFjdGl2YXRlXG4gIHRlc3QoJ2ZvcndhcmQtZGVwJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICAvLyBNMDAxOiBkZXBlbmRzIG9uIE0wMDIsIGJ1dCBNMDAyIGlzIGNvbXBsZXRlIHNvIE0wMDEgaXMgdW5ibG9ja2VkXG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgJ00wMDEnLCBgIyBNMDAxOiBGaXJzdCBNaWxlc3RvbmVcblxuKipWaXNpb246KiogRGVwZW5kcyBvbiBNMDAyIHdoaWNoIGlzIGFscmVhZHkgY29tcGxldGUuXG5cbiMjIFNsaWNlc1xuXG4tIFsgXSAqKlMwMTogUmVhZHkqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXG4gID4gQWZ0ZXIgdGhpczogRG9uZS5cbmApO1xuICAgICAgd3JpdGVDb250ZXh0KGJhc2UsICdNMDAxJywgJ2RlcGVuZHNfb246IFtNMDAyXScpO1xuXG4gICAgICAvLyBNMDAyOiBjb21wbGV0ZSAoYWxsIHNsaWNlcyBbeF0gKyBTVU1NQVJZKVxuICAgICAgd3JpdGVSb2FkbWFwKGJhc2UsICdNMDAyJywgYCMgTTAwMjogU2Vjb25kIE1pbGVzdG9uZVxuXG4qKlZpc2lvbjoqKiBBbHJlYWR5IGNvbXBsZXRlLlxuXG4jIyBTbGljZXNcblxuLSBbeF0gKipTMDE6IERvbmUqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXG4gID4gQWZ0ZXIgdGhpczogRG9uZS5cbmApO1xuICAgICAgd3JpdGVNaWxlc3RvbmVWYWxpZGF0aW9uKGJhc2UsICdNMDAyJyk7XG4gICAgICB3cml0ZU1pbGVzdG9uZVN1bW1hcnkoYmFzZSwgJ00wMDInLCAnIyBNMDAyIFN1bW1hcnlcXG5cXG5TZWNvbmQgbWlsZXN0b25lIGlzIGNvbXBsZXRlLicpO1xuXG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuXG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQsICdNMDAxJywgJ2ZvcndhcmQtZGVwOiBhY3RpdmVNaWxlc3RvbmUgaXMgTTAwMScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5yZWdpc3RyeVsxXT8uc3RhdHVzLCAnY29tcGxldGUnLCAnZm9yd2FyZC1kZXA6IE0wMDIgaXMgY29tcGxldGUnKTtcbiAgICAgIGFzc2VydC5vayhzdGF0ZS5waGFzZSAhPT0gJ2Jsb2NrZWQnLCAnZm9yd2FyZC1kZXA6IHBoYXNlIGlzIG5vdCBibG9ja2VkJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCBHcm91cCA2OiBlbXB0eS1kZXBzLWxpc3QgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIC8vIE0wMDIgaGFzIGBkZXBlbmRzX29uOiBbXWAgXHUyMDE0IGVtcHR5IGxpc3QgbWVhbnMgbm8gY29uc3RyYWludCwgbm9ybWFsIHNlcXVlbnRpYWwgYmVoYXZpb3JcbiAgdGVzdCgnZW1wdHktZGVwcy1saXN0JywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICAvLyBNMDAxOiBpbmNvbXBsZXRlLCBubyBjb250ZXh0XG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgJ00wMDEnLCBgIyBNMDAxOiBGaXJzdCBNaWxlc3RvbmVcblxuKipWaXNpb246KiogRmlyc3QgbWlsZXN0b25lIHN0aWxsIGluIHByb2dyZXNzLlxuXG4jIyBTbGljZXNcblxuLSBbIF0gKipTMDE6IEluY29tcGxldGUqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXG4gID4gQWZ0ZXIgdGhpczogRG9uZS5cbmApO1xuXG4gICAgICAvLyBNMDAyOiBlbXB0eSBkZXBzIGxpc3QgXHUyMDE0IG5vIGNvbnN0cmFpbnQgZnJvbSBkZXBzLCBidXQgc3RpbGwgc2VxdWVudGlhbCBhZnRlciBNMDAxXG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgJ00wMDInLCBgIyBNMDAyOiBTZWNvbmQgTWlsZXN0b25lXG5cbioqVmlzaW9uOioqIEVtcHR5IGRlcHMgbGlzdCwgbm8gYmxvY2tpbmcgY29uc3RyYWludC5cblxuIyMgU2xpY2VzXG5cbi0gWyBdICoqUzAxOiBXYWl0aW5nIGZvciBNMDAxKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbXVxcYFxuICA+IEFmdGVyIHRoaXM6IERvbmUuXG5gKTtcbiAgICAgIHdyaXRlQ29udGV4dChiYXNlLCAnTTAwMicsICdkZXBlbmRzX29uOiBbXScpO1xuXG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuXG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnJlZ2lzdHJ5WzBdPy5zdGF0dXMsICdhY3RpdmUnLCAnZW1wdHktZGVwcy1saXN0OiBNMDAxIGlzIGFjdGl2ZScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5yZWdpc3RyeVsxXT8uc3RhdHVzLCAncGVuZGluZycsICdlbXB0eS1kZXBzLWxpc3Q6IE0wMDIgaXMgcGVuZGluZyAoTTAwMSBub3QgZG9uZSB5ZXQpJyk7XG4gICAgICBhc3NlcnQub2soc3RhdGUucGhhc2UgIT09ICdibG9ja2VkJywgJ2VtcHR5LWRlcHMtbGlzdDogcGhhc2UgaXMgbm90IGJsb2NrZWQnKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0IEdyb3VwIDc6IHVuaXF1ZS1pZC1kZXBzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAvLyBNMDA0LTB6anJnMCBpcyBjb21wbGV0ZSwgTTAwNS1iMG0yaGwgZGVwZW5kc19vbiBNMDA0LTB6anJnMCBcdTIxOTIgTTAwNSBzaG91bGQgYWN0aXZhdGUuXG4gIC8vIFJlZ3Jlc3Npb246IHBhcnNlQ29udGV4dERlcGVuZHNPbigpIHVzZWQgLnRvVXBwZXJDYXNlKCksIGNvbnZlcnRpbmcgXCJNMDA0LTB6anJnMFwiXG4gIC8vIHRvIFwiTTAwNC0wWkpSRzBcIiwgYnJlYWtpbmcgdGhlIGNhc2Utc2Vuc2l0aXZlIGxvb2t1cCBpbiBjb21wbGV0ZU1pbGVzdG9uZUlkcy5cbiAgdGVzdCgndW5pcXVlLWlkLWRlcHM6IHVuaXF1ZSBtaWxlc3RvbmUgSURzIHdpdGggbG93ZXJjYXNlIGhleCBzdWZmaXgnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIC8vIE0wMDQtMHpqcmcwOiBjb21wbGV0ZSAoYWxsIHNsaWNlcyBkb25lICsgU1VNTUFSWSBwcmVzZW50KVxuICAgICAgd3JpdGVSb2FkbWFwKGJhc2UsICdNMDA0LTB6anJnMCcsIGAjIE0wMDQtMHpqcmcwOiBGaXJzdCBVbmlxdWUgTWlsZXN0b25lXG5cbioqVmlzaW9uOioqIENvbXBsZXRlIG1pbGVzdG9uZSB3aXRoIHVuaXF1ZSBJRC5cblxuIyMgU2xpY2VzXG5cbi0gW3hdICoqUzAxOiBEb25lKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbXVxcYFxuICA+IEFmdGVyIHRoaXM6IERvbmUuXG5gKTtcbiAgICAgIHdyaXRlTWlsZXN0b25lVmFsaWRhdGlvbihiYXNlLCAnTTAwNC0wempyZzAnKTtcbiAgICAgIHdyaXRlTWlsZXN0b25lU3VtbWFyeShiYXNlLCAnTTAwNC0wempyZzAnLCAnIyBNMDA0LTB6anJnMCBTdW1tYXJ5XFxuXFxuQ29tcGxldGUuJyk7XG5cbiAgICAgIC8vIE0wMDUtYjBtMmhsOiBkZXBlbmRzIG9uIE0wMDQtMHpqcmcwIChsb3dlcmNhc2UgaGV4IHN1ZmZpeClcbiAgICAgIHdyaXRlQ29udGV4dChiYXNlLCAnTTAwNS1iMG0yaGwnLCAnZGVwZW5kc19vbjogW00wMDQtMHpqcmcwXScpO1xuXG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuXG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnJlZ2lzdHJ5LmZpbmQoZSA9PiBlLmlkID09PSAnTTAwNC0wempyZzAnKT8uc3RhdHVzLCAnY29tcGxldGUnLFxuICAgICAgICAndW5pcXVlLWlkLWRlcHM6IE0wMDQtMHpqcmcwIGlzIGNvbXBsZXRlJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnJlZ2lzdHJ5LmZpbmQoZSA9PiBlLmlkID09PSAnTTAwNS1iMG0yaGwnKT8uc3RhdHVzLCAnYWN0aXZlJyxcbiAgICAgICAgJ3VuaXF1ZS1pZC1kZXBzOiBNMDA1LWIwbTJobCBpcyBhY3RpdmUgKGRlcCBvbiBNMDA0LTB6anJnMCBtZXQpJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQsICdNMDA1LWIwbTJobCcsXG4gICAgICAgICd1bmlxdWUtaWQtZGVwczogYWN0aXZlTWlsZXN0b25lIGlzIE0wMDUtYjBtMmhsJyk7XG4gICAgICBhc3NlcnQub2soc3RhdGUucGhhc2UgIT09ICdibG9ja2VkJyxcbiAgICAgICAgJ3VuaXF1ZS1pZC1kZXBzOiBwaGFzZSBpcyBub3QgYmxvY2tlZCcpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRlc3QgR3JvdXAgODogdW5pcXVlLWlkLWRlcHMtYmxvY2tlZCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgLy8gTTAwNC0wempyZzAgaXMgTk9UIGNvbXBsZXRlLCBNMDA1LWIwbTJobCBkZXBlbmRzX29uIE0wMDQtMHpqcmcwIFx1MjE5MiBNMDA1IHNob3VsZCBiZSBwZW5kaW5nXG4gIHRlc3QoJ3VuaXF1ZS1pZC1kZXBzLWJsb2NrZWQ6IHVuaXF1ZSBJRCBkZXAgbm90IHlldCBtZXQnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIC8vIE0wMDQtMHpqcmcwOiBpbmNvbXBsZXRlIChzbGljZSBub3QgZG9uZSlcbiAgICAgIHdyaXRlUm9hZG1hcChiYXNlLCAnTTAwNC0wempyZzAnLCBgIyBNMDA0LTB6anJnMDogSW5jb21wbGV0ZSBVbmlxdWUgTWlsZXN0b25lXG5cbioqVmlzaW9uOioqIFN0aWxsIGluIHByb2dyZXNzLlxuXG4jIyBTbGljZXNcblxuLSBbIF0gKipTMDE6IEluIFByb2dyZXNzKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbXVxcYFxuICA+IEFmdGVyIHRoaXM6IERvbmUuXG5gKTtcbiAgICAgIHdyaXRlU2xpY2VQbGFuKGJhc2UsICdNMDA0LTB6anJnMCcsICdTMDEnLCBgIyBTMDE6IEluIFByb2dyZXNzXG5cbioqR29hbDoqKiBUZXN0IGRlcCBibG9ja2luZyB3aXRoIHVuaXF1ZSBJRHMuXG5cbiMjIFRhc2tzXG5cbi0gWyBdICoqVDAxOiBXb3JrKiogXFxgZXN0OjE1bVxcYFxuICBTdGlsbCBkb2luZyB3b3JrLlxuYCk7XG5cbiAgICAgIC8vIE0wMDUtYjBtMmhsOiBkZXBlbmRzIG9uIE0wMDQtMHpqcmcwIChzdGlsbCBpbmNvbXBsZXRlKVxuICAgICAgd3JpdGVDb250ZXh0KGJhc2UsICdNMDA1LWIwbTJobCcsICdkZXBlbmRzX29uOiBbTTAwNC0wempyZzBdJyk7XG5cbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG5cbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUuYWN0aXZlTWlsZXN0b25lPy5pZCwgJ00wMDQtMHpqcmcwJyxcbiAgICAgICAgJ3VuaXF1ZS1pZC1kZXBzLWJsb2NrZWQ6IGFjdGl2ZU1pbGVzdG9uZSBpcyBNMDA0LTB6anJnMCcpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5yZWdpc3RyeS5maW5kKGUgPT4gZS5pZCA9PT0gJ00wMDUtYjBtMmhsJyk/LnN0YXR1cywgJ3BlbmRpbmcnLFxuICAgICAgICAndW5pcXVlLWlkLWRlcHMtYmxvY2tlZDogTTAwNS1iMG0yaGwgaXMgcGVuZGluZyAoZGVwIG5vdCBtZXQpJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCBHcm91cCA5OiBkcmFmdC1jb250ZXh0LWRlcHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIC8vIE0wMDEgaXMgaW5jb21wbGV0ZSwgTTAwMiBoYXMgb25seSBDT05URVhULURSQUZULm1kIChubyBDT05URVhULm1kKSB3aXRoXG4gIC8vIGRlcGVuZHNfb246IFtNMDAxXSBcdTIxOTIgTTAwMiBzaG91bGQgcmVtYWluIHBlbmRpbmcsIG5vdCBiZSBwcm9tb3RlZCB0byBhY3RpdmUuXG4gIHRlc3QoJ2RyYWZ0LWNvbnRleHQtZGVwczogZGVwZW5kc19vbiByZWFkIGZyb20gQ09OVEVYVC1EUkFGVC5tZCcsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgLy8gTTAwMTogaW5jb21wbGV0ZSAob25lIHNsaWNlLCBubyBTVU1NQVJZKVxuICAgICAgd3JpdGVSb2FkbWFwKGJhc2UsICdNMDAxJywgYCMgTTAwMTogRmlyc3QgTWlsZXN0b25lXG5cbioqVmlzaW9uOioqIEZpcnN0IG1pbGVzdG9uZSBzdGlsbCBpbiBwcm9ncmVzcy5cblxuIyMgU2xpY2VzXG5cbi0gWyBdICoqUzAxOiBJbmNvbXBsZXRlIFNsaWNlKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbXVxcYFxuICA+IEFmdGVyIHRoaXM6IERvbmUuXG5gKTtcbiAgICAgIHdyaXRlU2xpY2VQbGFuKGJhc2UsICdNMDAxJywgJ1MwMScsIGAjIFMwMTogSW5jb21wbGV0ZSBTbGljZVxuXG4qKkdvYWw6KiogVGVzdCBkcmFmdCBkZXAgYmxvY2tpbmcuXG4qKkRlbW86KiogVGVzdHMgcGFzcy5cblxuIyMgVGFza3NcblxuLSBbIF0gKipUMDE6IERvIHdvcmsqKiBcXGBlc3Q6MTVtXFxgXG4gIEZpcnN0IHRhc2sgc3RpbGwgaW4gcHJvZ3Jlc3MuXG5gKTtcblxuICAgICAgLy8gTTAwMjogb25seSBDT05URVhULURSQUZULm1kIChubyBDT05URVhULm1kKSwgZGVwZW5kcyBvbiBNMDAxXG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgJ00wMDInLCBgIyBNMDAyOiBTZWNvbmQgTWlsZXN0b25lXG5cbioqVmlzaW9uOioqIFNlY29uZCBtaWxlc3RvbmUgYmxvY2tlZCBieSBNMDAxIHZpYSBkcmFmdCBjb250ZXh0LlxuXG4jIyBTbGljZXNcblxuLSBbIF0gKipTMDE6IEJsb2NrZWQgU2xpY2UqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXG4gID4gQWZ0ZXIgdGhpczogRG9uZS5cbmApO1xuICAgICAgd3JpdGVDb250ZXh0RHJhZnQoYmFzZSwgJ00wMDInLCAnZGVwZW5kc19vbjogW00wMDFdJyk7XG5cbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG5cbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucmVnaXN0cnlbMF0/LnN0YXR1cywgJ2FjdGl2ZScsICdkcmFmdC1jb250ZXh0LWRlcHM6IE0wMDEgaXMgYWN0aXZlJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnJlZ2lzdHJ5WzFdPy5zdGF0dXMsICdwZW5kaW5nJywgJ2RyYWZ0LWNvbnRleHQtZGVwczogTTAwMiBpcyBwZW5kaW5nIChkZXAtYmxvY2tlZCB2aWEgZHJhZnQpJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQsICdNMDAxJywgJ2RyYWZ0LWNvbnRleHQtZGVwczogYWN0aXZlTWlsZXN0b25lIGlzIE0wMDEnKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0IEdyb3VwIDEwOiBkcmFmdC1jb250ZXh0LWRlcHMtbm8tcm9hZG1hcCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgLy8gU2FtZSBhcyBhYm92ZSBidXQgd2l0aG91dCByb2FkbWFwcyBcdTIwMTQgbWlsZXN0b25lcyBkaXNjb3ZlcmVkIGZyb20gZGlyZWN0b3J5IG9ubHkuXG4gIHRlc3QoJ2RyYWZ0LWNvbnRleHQtZGVwcy1uby1yb2FkbWFwOiBkZXBlbmRzX29uIGZyb20gZHJhZnQgd2l0aG91dCByb2FkbWFwJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICAvLyBNMDAxOiBleGlzdHMgYXMgZGlyZWN0b3J5IG9ubHkgKG5vIHJvYWRtYXAsIG5vIHN1bW1hcnkpXG4gICAgICBjb25zdCBtMDAxRGlyID0gam9pbihiYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgJ00wMDEnKTtcbiAgICAgIG1rZGlyU3luYyhtMDAxRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAgICAgLy8gTTAwMjogb25seSBDT05URVhULURSQUZULm1kLCBkZXBlbmRzIG9uIE0wMDFcbiAgICAgIHdyaXRlQ29udGV4dERyYWZ0KGJhc2UsICdNMDAyJywgJ2RlcGVuZHNfb246IFtNMDAxXScpO1xuXG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuXG4gICAgICBjb25zdCBtMDAyRW50cnkgPSBzdGF0ZS5yZWdpc3RyeS5maW5kKGUgPT4gZS5pZCA9PT0gJ00wMDInKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwobTAwMkVudHJ5Py5zdGF0dXMsICdwZW5kaW5nJywgJ2RyYWZ0LW5vLXJvYWRtYXA6IE0wMDIgaXMgcGVuZGluZyAoZGVwLWJsb2NrZWQgdmlhIGRyYWZ0KScpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRlc3QgR3JvdXAgMTE6IHBhcnNlQ29udGV4dERlcGVuZHNPbiBwcmVzZXJ2ZXMgY2FzZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgLy8gRGlyZWN0IHVuaXQgdGVzdDogdmVyaWZ5IHRoZSBwYXJzZWQgZGVwIElEIG1hdGNoZXMgdGhlIGlucHV0IGV4YWN0bHlcbiAgdGVzdCgncGFyc2VDb250ZXh0RGVwZW5kc09uOiBwcmVzZXJ2ZXMgY2FzZSBvZiB1bmlxdWUgSURzJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHsgcGFyc2VDb250ZXh0RGVwZW5kc09uIH0gPSBhd2FpdCBpbXBvcnQoJy4uL2ZpbGVzLnRzJyk7XG5cbiAgICBjb25zdCBkZXBzMSA9IHBhcnNlQ29udGV4dERlcGVuZHNPbignLS0tXFxuZGVwZW5kc19vbjogW00wMDQtMHpqcmcwXVxcbi0tLVxcbicpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZGVwczFbMF0sICdNMDA0LTB6anJnMCcsXG4gICAgICAncGFyc2VDb250ZXh0RGVwZW5kc09uIHByZXNlcnZlcyBsb3dlcmNhc2UgaGV4IHN1ZmZpeCcpO1xuXG4gICAgY29uc3QgZGVwczIgPSBwYXJzZUNvbnRleHREZXBlbmRzT24oJy0tLVxcbmRlcGVuZHNfb246IFtNMDAxLCBNMDA0LWFiYzEyM11cXG4tLS1cXG4nKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRlcHMyWzBdLCAnTTAwMScsICdwcmVzZXJ2ZXMgY2xhc3NpYyB1cHBlcmNhc2UgSUQnKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRlcHMyWzFdLCAnTTAwNC1hYmMxMjMnLCAncHJlc2VydmVzIG1peGVkLWNhc2UgdW5pcXVlIElEJyk7XG5cbiAgICBjb25zdCBkZXBzMyA9IHBhcnNlQ29udGV4dERlcGVuZHNPbignLS0tXFxuZGVwZW5kc19vbjogW11cXG4tLS1cXG4nKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRlcHMzLmxlbmd0aCwgMCwgJ2VtcHR5IGRlcHMgcmV0dXJucyBlbXB0eSBhcnJheScpO1xuXG4gICAgY29uc3QgZGVwczQgPSBwYXJzZUNvbnRleHREZXBlbmRzT24obnVsbCk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkZXBzNC5sZW5ndGgsIDAsICdudWxsIGNvbnRlbnQgcmV0dXJucyBlbXB0eSBhcnJheScpO1xuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCBHcm91cCAxMDogZHJhZnQtb25seS1kZXBzLWJsb2NrZWQgKCMxNzI0KSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgLy8gTTAwMiBoYXMgb25seSBDT05URVhULURSQUZULm1kIChubyBDT05URVhULm1kKSB3aXRoIGRlcGVuZHNfb246IFtNMDAxXS5cbiAgLy8gTTAwMSBpcyBpbmNvbXBsZXRlIFx1MjE5MiBNMDAyIG11c3QgcmVtYWluIHBlbmRpbmcsIG5vdCBnZXQgcHJvbW90ZWQgdG8gYWN0aXZlLlxuICAvLyBSZWdyZXNzaW9uOiBiZWZvcmUgIzE3MjQsIHBhcnNlQ29udGV4dERlcGVuZHNPbiByZWNlaXZlZCBudWxsIGZvciBkcmFmdC1vbmx5XG4gIC8vIG1pbGVzdG9uZXMsIHJldHVybmluZyBbXSwgd2hpY2ggY2F1c2VkIGRlcC1ibG9ja2VkIG1pbGVzdG9uZXMgdG8gYmUgcHJvbW90ZWQuXG4gIHRlc3QoJ2RyYWZ0LW9ubHktZGVwcy1ibG9ja2VkOiBDT05URVhULURSQUZULm1kIGRlcGVuZHNfb24gYmxvY2tzIHByb21vdGlvbicsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgLy8gTTAwMTogaW5jb21wbGV0ZSAob25lIHNsaWNlLCBubyBTVU1NQVJZKVxuICAgICAgd3JpdGVSb2FkbWFwKGJhc2UsICdNMDAxJywgYCMgTTAwMTogRmlyc3QgTWlsZXN0b25lXG5cbioqVmlzaW9uOioqIEZpcnN0IG1pbGVzdG9uZSBzdGlsbCBpbiBwcm9ncmVzcy5cblxuIyMgU2xpY2VzXG5cbi0gWyBdICoqUzAxOiBJbmNvbXBsZXRlIFNsaWNlKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbXVxcYFxuICA+IEFmdGVyIHRoaXM6IERvbmUuXG5gKTtcbiAgICAgIHdyaXRlU2xpY2VQbGFuKGJhc2UsICdNMDAxJywgJ1MwMScsIGAjIFMwMTogSW5jb21wbGV0ZSBTbGljZVxuXG4qKkdvYWw6KiogVGVzdCBkcmFmdCBkZXAgYmxvY2tpbmcuXG4qKkRlbW86KiogVGVzdHMgcGFzcy5cblxuIyMgVGFza3NcblxuLSBbIF0gKipUMDE6IERvIHdvcmsqKiBcXGBlc3Q6MTVtXFxgXG4gIEZpcnN0IHRhc2sgc3RpbGwgaW4gcHJvZ3Jlc3MuXG5gKTtcblxuICAgICAgLy8gTTAwMjogb25seSBDT05URVhULURSQUZULm1kIChubyBDT05URVhULm1kKSwgZGVwZW5kcyBvbiBNMDAxXG4gICAgICB3cml0ZUNvbnRleHREcmFmdChiYXNlLCAnTTAwMicsICdkZXBlbmRzX29uOiBbTTAwMV0nKTtcblxuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcblxuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5hY3RpdmVNaWxlc3RvbmU/LmlkLCAnTTAwMScsXG4gICAgICAgICdkcmFmdC1vbmx5LWRlcHMtYmxvY2tlZDogYWN0aXZlTWlsZXN0b25lIGlzIE0wMDEnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucmVnaXN0cnkuZmluZChlID0+IGUuaWQgPT09ICdNMDAyJyk/LnN0YXR1cywgJ3BlbmRpbmcnLFxuICAgICAgICAnZHJhZnQtb25seS1kZXBzLWJsb2NrZWQ6IE0wMDIgaXMgcGVuZGluZyAoZGVwIG9uIE0wMDEgbm90IG1ldCwgcmVhZCBmcm9tIENPTlRFWFQtRFJBRlQpJyk7XG4gICAgICBhc3NlcnQub2soc3RhdGUucGhhc2UgIT09ICdibG9ja2VkJyxcbiAgICAgICAgJ2RyYWZ0LW9ubHktZGVwcy1ibG9ja2VkOiBwaGFzZSBpcyBub3QgYmxvY2tlZCAoTTAwMSBpcyBhY3RpdmUpJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCBHcm91cCAxMTogZHJhZnQtb25seS1kZXBzLXVuYmxvY2tlZCAoIzE3MjQpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAvLyBNMDAxIGlzIGNvbXBsZXRlLCBNMDAyIGhhcyBvbmx5IENPTlRFWFQtRFJBRlQubWQgd2l0aCBkZXBlbmRzX29uOiBbTTAwMV0uXG4gIC8vIE0wMDIgc2hvdWxkIGJlY29tZSBhY3RpdmUgYmVjYXVzZSBpdHMgZGVwIGlzIHNhdGlzZmllZC5cbiAgdGVzdCgnZHJhZnQtb25seS1kZXBzLXVuYmxvY2tlZDogQ09OVEVYVC1EUkFGVC5tZCBkZXAgbWV0IFx1MjE5MiBtaWxlc3RvbmUgYWN0aXZhdGVzJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICAvLyBNMDAxOiBjb21wbGV0ZVxuICAgICAgd3JpdGVSb2FkbWFwKGJhc2UsICdNMDAxJywgYCMgTTAwMTogRmlyc3QgTWlsZXN0b25lXG5cbioqVmlzaW9uOioqIENvbXBsZXRlIG1pbGVzdG9uZS5cblxuIyMgU2xpY2VzXG5cbi0gW3hdICoqUzAxOiBEb25lKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbXVxcYFxuICA+IEFmdGVyIHRoaXM6IERvbmUuXG5gKTtcbiAgICAgIHdyaXRlTWlsZXN0b25lVmFsaWRhdGlvbihiYXNlLCAnTTAwMScpO1xuICAgICAgd3JpdGVNaWxlc3RvbmVTdW1tYXJ5KGJhc2UsICdNMDAxJywgJyMgTTAwMSBTdW1tYXJ5XFxuXFxuQ29tcGxldGUuJyk7XG5cbiAgICAgIC8vIE0wMDI6IG9ubHkgQ09OVEVYVC1EUkFGVC5tZCwgZGVwZW5kcyBvbiBNMDAxIChub3cgY29tcGxldGUpXG4gICAgICB3cml0ZUNvbnRleHREcmFmdChiYXNlLCAnTTAwMicsICdkZXBlbmRzX29uOiBbTTAwMV0nKTtcblxuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcblxuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5yZWdpc3RyeS5maW5kKGUgPT4gZS5pZCA9PT0gJ00wMDEnKT8uc3RhdHVzLCAnY29tcGxldGUnLFxuICAgICAgICAnZHJhZnQtb25seS1kZXBzLXVuYmxvY2tlZDogTTAwMSBpcyBjb21wbGV0ZScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5yZWdpc3RyeS5maW5kKGUgPT4gZS5pZCA9PT0gJ00wMDInKT8uc3RhdHVzLCAnYWN0aXZlJyxcbiAgICAgICAgJ2RyYWZ0LW9ubHktZGVwcy11bmJsb2NrZWQ6IE0wMDIgaXMgYWN0aXZlIChkZXAgb24gTTAwMSBtZXQgdmlhIENPTlRFWFQtRFJBRlQpJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQsICdNMDAyJyxcbiAgICAgICAgJ2RyYWZ0LW9ubHktZGVwcy11bmJsb2NrZWQ6IGFjdGl2ZU1pbGVzdG9uZSBpcyBNMDAyJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCBHcm91cCAxMjogZHJhZnQtb25seS1kZXBzLXdpdGgtcm9hZG1hcCAoIzE3MjQpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAvLyBNMDAyIGhhcyBhIHJvYWRtYXAgKyBvbmx5IENPTlRFWFQtRFJBRlQubWQgd2l0aCBkZXBlbmRzX29uOiBbTTAwMV0uXG4gIC8vIFRlc3RzIHRoZSBoYXMtcm9hZG1hcCBjb2RlIHBhdGggKHNlY29uZCBvY2N1cnJlbmNlIG9mIHRoZSBmaXgpLlxuICB0ZXN0KCdkcmFmdC1vbmx5LWRlcHMtd2l0aC1yb2FkbWFwOiBoYXMtcm9hZG1hcCBwYXRoIHJlYWRzIENPTlRFWFQtRFJBRlQgZGVwcycsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgLy8gTTAwMTogaW5jb21wbGV0ZVxuICAgICAgd3JpdGVSb2FkbWFwKGJhc2UsICdNMDAxJywgYCMgTTAwMTogRmlyc3QgTWlsZXN0b25lXG5cbioqVmlzaW9uOioqIFN0aWxsIGluIHByb2dyZXNzLlxuXG4jIyBTbGljZXNcblxuLSBbIF0gKipTMDE6IFdvcmtpbmcqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXG4gID4gQWZ0ZXIgdGhpczogRG9uZS5cbmApO1xuICAgICAgd3JpdGVTbGljZVBsYW4oYmFzZSwgJ00wMDEnLCAnUzAxJywgYCMgUzAxOiBXb3JraW5nXG5cbioqR29hbDoqKiBUZXN0LlxuKipEZW1vOioqIFRlc3RzIHBhc3MuXG5cbiMjIFRhc2tzXG5cbi0gWyBdICoqVDAxOiBXb3JrKiogXFxgZXN0OjE1bVxcYFxuICBEb2luZyB3b3JrLlxuYCk7XG5cbiAgICAgIC8vIE0wMDI6IGhhcyBhIHJvYWRtYXAgQU5EIG9ubHkgQ09OVEVYVC1EUkFGVC5tZCB3aXRoIGRlcGVuZHNfb246IFtNMDAxXVxuICAgICAgd3JpdGVSb2FkbWFwKGJhc2UsICdNMDAyJywgYCMgTTAwMjogU2Vjb25kIE1pbGVzdG9uZVxuXG4qKlZpc2lvbjoqKiBIYXMgcm9hZG1hcCBidXQgb25seSBkcmFmdCBjb250ZXh0IHdpdGggZGVwcy5cblxuIyMgU2xpY2VzXG5cbi0gWyBdICoqUzAxOiBCbG9ja2VkKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbXVxcYFxuICA+IEFmdGVyIHRoaXM6IERvbmUuXG5gKTtcbiAgICAgIHdyaXRlQ29udGV4dERyYWZ0KGJhc2UsICdNMDAyJywgJ2RlcGVuZHNfb246IFtNMDAxXScpO1xuXG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuXG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQsICdNMDAxJyxcbiAgICAgICAgJ2RyYWZ0LW9ubHktZGVwcy13aXRoLXJvYWRtYXA6IGFjdGl2ZU1pbGVzdG9uZSBpcyBNMDAxJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnJlZ2lzdHJ5LmZpbmQoZSA9PiBlLmlkID09PSAnTTAwMicpPy5zdGF0dXMsICdwZW5kaW5nJyxcbiAgICAgICAgJ2RyYWZ0LW9ubHktZGVwcy13aXRoLXJvYWRtYXA6IE0wMDIgaXMgcGVuZGluZyAoZGVwIHJlYWQgZnJvbSBDT05URVhULURSQUZUIGluIGhhcy1yb2FkbWFwIHBhdGgpJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCBHcm91cCAxMzogZHJhZnQtb25seS1uby1kZXBzICgjMTcyNCkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIC8vIE0wMDIgaGFzIG9ubHkgQ09OVEVYVC1EUkFGVC5tZCB3aXRoIE5PIGRlcGVuZHNfb24gZmllbGQuXG4gIC8vIFNob3VsZCBiZWhhdmUgc2FtZSBhcyBubyBjb250ZXh0IGZpbGUgXHUyMDE0IG5vcm1hbCBzZXF1ZW50aWFsIGJlaGF2aW9yLlxuICB0ZXN0KCdkcmFmdC1vbmx5LW5vLWRlcHM6IENPTlRFWFQtRFJBRlQgd2l0aG91dCBkZXBlbmRzX29uIFx1MjE5MiBubyBjb25zdHJhaW50JywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICAvLyBNMDAxOiBjb21wbGV0ZVxuICAgICAgd3JpdGVSb2FkbWFwKGJhc2UsICdNMDAxJywgYCMgTTAwMTogRmlyc3QgTWlsZXN0b25lXG5cbioqVmlzaW9uOioqIENvbXBsZXRlLlxuXG4jIyBTbGljZXNcblxuLSBbeF0gKipTMDE6IERvbmUqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXG4gID4gQWZ0ZXIgdGhpczogRG9uZS5cbmApO1xuICAgICAgd3JpdGVNaWxlc3RvbmVWYWxpZGF0aW9uKGJhc2UsICdNMDAxJyk7XG4gICAgICB3cml0ZU1pbGVzdG9uZVN1bW1hcnkoYmFzZSwgJ00wMDEnLCAnIyBNMDAxIFN1bW1hcnlcXG5cXG5Db21wbGV0ZS4nKTtcblxuICAgICAgLy8gTTAwMjogb25seSBDT05URVhULURSQUZULm1kIGJ1dCBubyBkZXBlbmRzX29uIFx1MjAxNCBzaG91bGQgYmVjb21lIGFjdGl2ZSBub3JtYWxseVxuICAgICAgd3JpdGVDb250ZXh0RHJhZnQoYmFzZSwgJ00wMDInLCAndGl0bGU6IFNvbWUgRHJhZnQnKTtcblxuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcblxuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5yZWdpc3RyeS5maW5kKGUgPT4gZS5pZCA9PT0gJ00wMDInKT8uc3RhdHVzLCAnYWN0aXZlJyxcbiAgICAgICAgJ2RyYWZ0LW9ubHktbm8tZGVwczogTTAwMiBpcyBhY3RpdmUgKG5vIGRlcHMgY29uc3RyYWludCBpbiBkcmFmdCknKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxTQUFTLFVBQVUsWUFBWTtBQUMvQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhLFdBQVcsUUFBUSxxQkFBcUI7QUFDOUQsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUV2QixTQUFTLG1CQUFtQjtBQUc1QixTQUFTLG9CQUE0QjtBQUNuQyxRQUFNLE9BQU8sWUFBWSxLQUFLLE9BQU8sR0FBRyxnQkFBZ0IsQ0FBQztBQUN6RCxZQUFVLEtBQUssTUFBTSxRQUFRLFlBQVksR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQy9ELFNBQU87QUFDVDtBQUVBLFNBQVMsYUFBYSxNQUFjLEtBQWEsU0FBdUI7QUFDdEUsUUFBTSxNQUFNLEtBQUssTUFBTSxRQUFRLGNBQWMsR0FBRztBQUNoRCxZQUFVLEtBQUssRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNsQyxnQkFBYyxLQUFLLEtBQUssR0FBRyxHQUFHLGFBQWEsR0FBRyxPQUFPO0FBQ3ZEO0FBRUEsU0FBUyxzQkFBc0IsTUFBYyxLQUFhLFNBQXVCO0FBQy9FLFFBQU0sTUFBTSxLQUFLLE1BQU0sUUFBUSxjQUFjLEdBQUc7QUFDaEQsWUFBVSxLQUFLLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDbEMsZ0JBQWMsS0FBSyxLQUFLLEdBQUcsR0FBRyxhQUFhLEdBQUcsT0FBTztBQUN2RDtBQUVBLFNBQVMseUJBQXlCLE1BQWMsS0FBbUI7QUFDakUsUUFBTSxNQUFNLEtBQUssTUFBTSxRQUFRLGNBQWMsR0FBRztBQUNoRCxZ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TztBQUFBLFFBQWdCLE1BQU0saUJBQWlCO0FBQUEsUUFBSTtBQUFBLFFBQ2hEO0FBQUEsTUFBb0Q7QUFBQSxJQUN4RCxVQUFFO0FBQ0EsY0FBUSxJQUFJO0FBQUEsSUFDZDtBQUFBLEVBQ0YsQ0FBQztBQUtELE9BQUssMkVBQTJFLFlBQVk7QUFDMUYsVUFBTSxPQUFPLGtCQUFrQjtBQUMvQixRQUFJO0FBRUYsbUJBQWEsTUFBTSxRQUFRO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxDQVFoQztBQUNLLHFCQUFlLE1BQU0sUUFBUSxPQUFPO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLENBU3pDO0FBR0ssbUJBQWEsTUFBTSxRQUFRO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxDQVFoQztBQUNLLHdCQUFrQixNQUFNLFFBQVEsb0JBQW9CO0FBRXBELFlBQU0sUUFBUSxNQUFNLFlBQVksSUFBSTtBQUVwQyxhQUFPO0FBQUEsUUFBZ0IsTUFBTSxpQkFBaUI7QUFBQSxRQUFJO0FBQUEsUUFDaEQ7QUFBQSxNQUF1RDtBQUN6RCxhQUFPO0FBQUEsUUFBZ0IsTUFBTSxTQUFTLEtBQUssT0FBSyxFQUFFLE9BQU8sTUFBTSxHQUFHO0FBQUEsUUFBUTtBQUFBLFFBQ3hFO0FBQUEsTUFBaUc7QUFBQSxJQUNyRyxVQUFFO0FBQ0EsY0FBUSxJQUFJO0FBQUEsSUFDZDtBQUFBLEVBQ0YsQ0FBQztBQUtELE9BQUssNkVBQXdFLFlBQVk7QUFDdkYsVUFBTSxPQUFPLGtCQUFrQjtBQUMvQixRQUFJO0FBRUYsbUJBQWEsTUFBTSxRQUFRO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxDQVFoQztBQUNLLCtCQUF5QixNQUFNLE1BQU07QUFDckMsNEJBQXNCLE1BQU0sUUFBUSw2QkFBNkI7QUFHakUsd0JBQWtCLE1BQU0sUUFBUSxtQkFBbUI7QUFFbkQsWUFBTSxRQUFRLE1BQU0sWUFBWSxJQUFJO0FBRXBDLGFBQU87QUFBQSxRQUFnQixNQUFNLFNBQVMsS0FBSyxPQUFLLEVBQUUsT0FBTyxNQUFNLEdBQUc7QUFBQSxRQUFRO0FBQUEsUUFDeEU7QUFBQSxNQUFrRTtBQUFBLElBQ3RFLFVBQUU7QUFDQSxjQUFRLElBQUk7QUFBQSxJQUNkO0FBQUEsRUFDRixDQUFDO0FBQ0gsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
