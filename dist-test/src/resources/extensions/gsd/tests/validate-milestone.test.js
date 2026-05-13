import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { deriveState, invalidateStateCache, isValidationTerminal } from "../state.js";
import { resolveExpectedArtifactPath, diagnoseExpectedArtifact } from "../auto-artifact-paths.js";
import { verifyExpectedArtifact, buildLoopRemediationSteps } from "../auto-recovery.js";
import { resolveDispatch } from "../auto-dispatch.js";
import { buildCompleteMilestonePrompt, buildValidateMilestonePrompt } from "../auto-prompts.js";
import { clearPathCache } from "../paths.js";
import { clearParseCache } from "../files.js";
import { closeDatabase, insertMilestone, insertSlice, openDatabase, getMilestone } from "../gsd-db.js";
function makeTmpBase() {
  const base = join(tmpdir(), `gsd-val-test-${randomUUID()}`);
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}
function cleanup(base) {
  invalidateStateCache();
  clearPathCache();
  clearParseCache();
  closeDatabase();
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
  }
}
function openTestDb(base) {
  const dbPath = join(base, ".gsd", "gsd.db");
  assert.equal(openDatabase(dbPath), true, "test DB should open");
}
function writeRoadmap(base, mid, content) {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-ROADMAP.md`), content);
}
function writeContext(base, mid, content = "# M001 Context\n\nValidated context.") {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-CONTEXT.md`), content);
}
function writeMilestoneSummary(base, mid, content) {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-SUMMARY.md`), content);
}
function writeValidation(base, mid, content) {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-VALIDATION.md`), content);
}
function writeSlicePlan(base, mid, sid, content) {
  const dir = join(base, ".gsd", "milestones", mid, "slices", sid);
  mkdirSync(join(dir, "tasks"), { recursive: true });
  writeFileSync(join(dir, `${sid}-PLAN.md`), content);
}
function writeSliceSummary(base, mid, sid, content) {
  const dir = join(base, ".gsd", "milestones", mid, "slices", sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}-SUMMARY.md`), content);
}
function writeSliceAssessment(base, mid, sid, content) {
  const dir = join(base, ".gsd", "milestones", mid, "slices", sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}-ASSESSMENT.md`), content);
}
const ALL_DONE_ROADMAP = `# M001: Test Milestone

## Vision
Test

## Success Criteria
- It works

## Slices

- [x] **S01: First slice** \`risk:low\` \`depends:[]\`
  > After this: it works

## Boundary Map

| From | To | Produces | Consumes |
|------|-----|----------|----------|
| S01  | terminal | output | nothing |
`;
const CONTEXT_FILE = `---
id: M001
title: Test Milestone
---

# Context
Test context.
`;
test("isValidationTerminal returns true for verdict: pass", () => {
  const content = "---\nverdict: pass\nremediation_round: 0\n---\n\n# Validation";
  assert.equal(isValidationTerminal(content), true);
});
test("isValidationTerminal returns true for verdict: needs-attention", () => {
  const content = "---\nverdict: needs-attention\nremediation_round: 0\n---\n\n# Validation";
  assert.equal(isValidationTerminal(content), true);
});
test("isValidationTerminal returns true for verdict: needs-remediation (#832)", () => {
  const content = "---\nverdict: needs-remediation\nremediation_round: 0\n---\n\n# Validation";
  assert.equal(isValidationTerminal(content), true);
});
test("isValidationTerminal returns true for verdict: passed (#1429)", () => {
  const content = "---\nverdict: passed\nremediation_round: 0\n---\n\n# Validation";
  assert.equal(isValidationTerminal(content), true);
});
test("isValidationTerminal returns true for verdict: fail (#2769)", () => {
  const content = "---\nverdict: fail\nremediation_round: 1\n---\n\n# Validation";
  assert.equal(isValidationTerminal(content), true);
});
test("isValidationTerminal returns true for any arbitrary verdict string (#2769)", () => {
  const content = "---\nverdict: custom-verdict\nremediation_round: 0\n---\n\n# Validation";
  assert.equal(isValidationTerminal(content), true);
});
test("isValidationTerminal returns false for missing frontmatter", () => {
  const content = "# Validation\nNo frontmatter here.";
  assert.equal(isValidationTerminal(content), false);
});
test("isValidationTerminal returns false for missing verdict field", () => {
  const content = "---\nremediation_round: 0\n---\n\n# Validation";
  assert.equal(isValidationTerminal(content), false);
});
test("deriveState returns validating-milestone when all slices done and no VALIDATION file", async () => {
  const base = makeTmpBase();
  try {
    writeRoadmap(base, "M001", ALL_DONE_ROADMAP);
    const dir = join(base, ".gsd", "milestones", "M001");
    writeFileSync(join(dir, "M001-CONTEXT.md"), CONTEXT_FILE);
    const state = await deriveState(base);
    assert.equal(state.phase, "validating-milestone");
    assert.equal(state.activeMilestone?.id, "M001");
    assert.equal(state.activeSlice, null);
  } finally {
    cleanup(base);
  }
});
test("deriveState returns completing-milestone when VALIDATION exists with terminal verdict", async () => {
  const base = makeTmpBase();
  try {
    writeRoadmap(base, "M001", ALL_DONE_ROADMAP);
    writeValidation(base, "M001", "---\nverdict: pass\nremediation_round: 0\n---\n\n# Validation\nAll good.");
    const state = await deriveState(base);
    assert.equal(state.phase, "completing-milestone");
    assert.equal(state.activeMilestone?.id, "M001");
  } finally {
    cleanup(base);
  }
});
test("deriveState returns blocked when needs-remediation has no incomplete slices (#4506)", async () => {
  const base = makeTmpBase();
  try {
    writeRoadmap(base, "M001", ALL_DONE_ROADMAP);
    writeValidation(base, "M001", "---\nverdict: needs-remediation\nremediation_round: 0\n---\n\n# Validation\nNeeds fixes.");
    const state = await deriveState(base);
    assert.equal(state.phase, "blocked");
    assert.equal(state.activeMilestone?.id, "M001");
    assert.ok(
      state.blockers.some((b) => b.includes("needs-remediation") && b.includes("M001")),
      "blocker message should mention milestone and verdict"
    );
  } finally {
    cleanup(base);
  }
});
test("deriveState returns complete when both VALIDATION and SUMMARY exist", async () => {
  const base = makeTmpBase();
  try {
    writeRoadmap(base, "M001", ALL_DONE_ROADMAP);
    writeValidation(base, "M001", "---\nverdict: pass\nremediation_round: 0\n---\n\n# Validation\nPassed.");
    writeMilestoneSummary(base, "M001", "# Summary\nDone.");
    const state = await deriveState(base);
    assert.equal(state.phase, "complete");
  } finally {
    cleanup(base);
  }
});
test("buildValidateMilestonePrompt inlines ASSESSMENT evidence instead of UAT spec", async () => {
  const base = makeTmpBase();
  try {
    writeRoadmap(base, "M001", ALL_DONE_ROADMAP);
    const dir = join(base, ".gsd", "milestones", "M001");
    writeFileSync(join(dir, "M001-CONTEXT.md"), CONTEXT_FILE);
    writeSliceSummary(base, "M001", "S01", "# S01 Summary\nDelivered.");
    writeFileSync(join(dir, "slices", "S01", "S01-UAT.md"), "# UAT Spec\nDo the thing.\n");
    writeSliceAssessment(base, "M001", "S01", "---\nverdict: PASS\n---\n# Assessment\nEvidence captured.");
    const prompt = await buildValidateMilestonePrompt("M001", "Test Milestone", base);
    assert.match(prompt, /S01 Assessment/i, "prompt should inline assessment evidence");
    assert.match(prompt, /verdict: PASS/i, "prompt should include the assessment verdict");
    assert.doesNotMatch(prompt, /UAT Spec/i, "prompt should not inline the raw UAT spec as evidence");
  } finally {
    cleanup(base);
  }
});
test("buildCompleteMilestonePrompt skips skipped slices from DB-backed summary inlining", async () => {
  const base = makeTmpBase();
  try {
    writeRoadmap(base, "M001", `# M001: Test Milestone

## Vision
Test

## Success Criteria
- It works

## Slices

- [x] **S01: First slice** \`risk:low\` \`depends:[]\`
  > Done
- [ ] **S02: Skipped slice** \`risk:low\` \`depends:[]\`
  > Intentionally skipped

## Boundary Map

| From | To | Produces | Consumes |
|------|-----|----------|----------|
| S01  | terminal | output | nothing |
`);
    openTestDb(base);
    insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "First slice", status: "complete", depends: [] });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Skipped slice", status: "skipped", depends: [] });
    writeSliceSummary(base, "M001", "S01", "# S01 Summary\nDelivered.");
    const prompt = await buildCompleteMilestonePrompt("M001", "Test Milestone", base);
    assert.match(prompt, /S01 Summary/i, "prompt should inline non-skipped slice summaries");
    assert.doesNotMatch(prompt, /### S02 Summary/i, "prompt should not inline skipped slice summaries");
    assert.doesNotMatch(prompt, /not found — file does not exist yet/i, "prompt should not emit skipped-slice missing-file placeholders");
    assert.doesNotMatch(prompt, /S02-SUMMARY\.md/, "skipped slice must not appear in on-demand path list (#4780)");
  } finally {
    cleanup(base);
  }
});
test("buildValidateMilestonePrompt skips skipped slices from DB-backed summary inlining", async () => {
  const base = makeTmpBase();
  try {
    writeRoadmap(base, "M001", `# M001: Test Milestone

## Vision
Test

## Success Criteria
- It works

## Slices

- [x] **S01: First slice** \`risk:low\` \`depends:[]\`
  > Done
- [ ] **S02: Skipped slice** \`risk:low\` \`depends:[]\`
  > Intentionally skipped

## Boundary Map

| From | To | Produces | Consumes |
|------|-----|----------|----------|
| S01  | terminal | output | nothing |
`);
    openTestDb(base);
    insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "First slice", status: "complete", depends: [] });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Skipped slice", status: "skipped", depends: [] });
    writeSliceSummary(base, "M001", "S01", "# S01 Summary\nDelivered.");
    writeSliceAssessment(base, "M001", "S01", "---\nverdict: PASS\n---\n# Assessment\nEvidence captured.");
    const prompt = await buildValidateMilestonePrompt("M001", "Test Milestone", base);
    assert.match(prompt, /S01 Summary/i, "prompt should inline non-skipped slice summaries");
    assert.doesNotMatch(prompt, /### S02 Summary/i, "prompt should not inline skipped slice summaries");
    assert.doesNotMatch(prompt, /not found — file does not exist yet/i, "prompt should not emit skipped-slice missing-file placeholders");
  } finally {
    cleanup(base);
  }
});
test("dispatch rule matches validating-milestone phase", async () => {
  const state = {
    activeMilestone: { id: "M001", title: "Test" },
    activeSlice: null,
    activeTask: null,
    phase: "validating-milestone",
    recentDecisions: [],
    blockers: [],
    nextAction: "Validate milestone M001.",
    registry: [{ id: "M001", title: "Test", status: "active" }],
    progress: { milestones: { done: 0, total: 1 } }
  };
  const base = makeTmpBase();
  try {
    writeContext(base, "M001");
    writeRoadmap(base, "M001", ALL_DONE_ROADMAP);
    writeSliceSummary(base, "M001", "S01", "# S01 Summary\nDone.");
    const ctx = {
      basePath: base,
      mid: "M001",
      midTitle: "Test",
      state,
      prefs: void 0
    };
    const result = await resolveDispatch(ctx);
    assert.equal(result.action, "dispatch");
    if (result.action === "dispatch") {
      assert.equal(result.unitType, "validate-milestone");
      assert.equal(result.unitId, "M001");
    }
  } finally {
    cleanup(base);
  }
});
test("dispatch rule skips when skip_milestone_validation preference is set", async () => {
  const state = {
    activeMilestone: { id: "M001", title: "Test" },
    activeSlice: null,
    activeTask: null,
    phase: "validating-milestone",
    recentDecisions: [],
    blockers: [],
    nextAction: "Validate milestone M001.",
    registry: [{ id: "M001", title: "Test", status: "active" }],
    progress: { milestones: { done: 0, total: 1 } }
  };
  const base = makeTmpBase();
  try {
    writeContext(base, "M001");
    writeRoadmap(base, "M001", ALL_DONE_ROADMAP);
    writeSliceSummary(base, "M001", "S01", "# S01 Summary\nDone.");
    const ctx = {
      basePath: base,
      mid: "M001",
      midTitle: "Test",
      state,
      prefs: { phases: { skip_milestone_validation: true } }
    };
    const result = await resolveDispatch(ctx);
    assert.equal(result.action, "skip");
    const validationPath = join(base, ".gsd", "milestones", "M001", "M001-VALIDATION.md");
    assert.ok(existsSync(validationPath), "VALIDATION file should be written on skip");
  } finally {
    cleanup(base);
  }
});
test("skip write immediately advances deriveState out of validating-milestone", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice 1", status: "complete" });
    writeContext(base, "M001");
    writeRoadmap(base, "M001", ALL_DONE_ROADMAP);
    writeSliceSummary(base, "M001", "S01", "# S01 Summary\nDone.");
    invalidateStateCache();
    clearPathCache();
    clearParseCache();
    const before = await deriveState(base);
    assert.equal(before.phase, "validating-milestone", "precondition: missing VALIDATION keeps phase in validation");
    const ctx = {
      basePath: base,
      mid: "M001",
      midTitle: "Test",
      state: before,
      prefs: { phases: { skip_milestone_validation: true } }
    };
    const result = await resolveDispatch(ctx);
    assert.equal(result.action, "skip");
    const after = await deriveState(base);
    assert.equal(
      after.phase,
      "completing-milestone",
      "post-skip deriveState should see the new VALIDATION file without manual cache invalidation"
    );
  } finally {
    cleanup(base);
  }
});
test("dispatch rule ignores failure-path SUMMARY projection when DB milestone is not complete (#4658 superseded)", async () => {
  const state = {
    activeMilestone: { id: "M001", title: "Test" },
    activeSlice: null,
    activeTask: null,
    phase: "completing-milestone",
    recentDecisions: [],
    blockers: [],
    nextAction: "Complete milestone M001.",
    registry: [{ id: "M001", title: "Test", status: "active" }],
    progress: { milestones: { done: 0, total: 1 } }
  };
  const base = makeTmpBase();
  try {
    openTestDb(base);
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    writeContext(base, "M001");
    writeMilestoneSummary(base, "M001", "# Milestone Summary\nverification FAILED \u2014 not complete.");
    const ctx = {
      basePath: base,
      mid: "M001",
      midTitle: "Test",
      state,
      prefs: void 0
    };
    const result = await resolveDispatch(ctx);
    assert.equal(result.action, "dispatch");
    assert.equal(getMilestone("M001")?.status, "active");
  } finally {
    cleanup(base);
  }
});
test("dispatch rule does not reconcile DB from successful stale SUMMARY projection (#4658 superseded)", async () => {
  const state = {
    activeMilestone: { id: "M001", title: "Test" },
    activeSlice: null,
    activeTask: null,
    phase: "completing-milestone",
    recentDecisions: [],
    blockers: [],
    nextAction: "Complete milestone M001.",
    registry: [{ id: "M001", title: "Test", status: "active" }],
    progress: { milestones: { done: 0, total: 1 } }
  };
  const base = makeTmpBase();
  try {
    openTestDb(base);
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    writeContext(base, "M001");
    writeMilestoneSummary(
      base,
      "M001",
      [
        "---",
        "id: M001",
        "status: complete",
        "---",
        "",
        "# M001: Test",
        "",
        "**Complete.**"
      ].join("\n")
    );
    const ctx = {
      basePath: base,
      mid: "M001",
      midTitle: "Test",
      state,
      prefs: void 0
    };
    const result = await resolveDispatch(ctx);
    assert.equal(result.action, "dispatch");
    const milestone = getMilestone("M001");
    assert.equal(milestone?.status, "active");
  } finally {
    cleanup(base);
  }
});
test("dispatch rule ignores ambiguous stale SUMMARY projection (#4658 superseded)", async () => {
  const state = {
    activeMilestone: { id: "M001", title: "Test" },
    activeSlice: null,
    activeTask: null,
    phase: "completing-milestone",
    recentDecisions: [],
    blockers: [],
    nextAction: "Complete milestone M001.",
    registry: [{ id: "M001", title: "Test", status: "active" }],
    progress: { milestones: { done: 0, total: 1 } }
  };
  const base = makeTmpBase();
  try {
    openTestDb(base);
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    writeContext(base, "M001");
    writeMilestoneSummary(base, "M001", "# M001 Summary\nSome notes without completion metadata.");
    const ctx = {
      basePath: base,
      mid: "M001",
      midTitle: "Test",
      state,
      prefs: void 0
    };
    const result = await resolveDispatch(ctx);
    assert.equal(result.action, "dispatch");
    assert.equal(getMilestone("M001")?.status, "active");
  } finally {
    cleanup(base);
  }
});
test("resolveExpectedArtifactPath returns VALIDATION path for validate-milestone", () => {
  const base = makeTmpBase();
  try {
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    const result = resolveExpectedArtifactPath("validate-milestone", "M001", base);
    assert.ok(result);
    assert.ok(result.includes("VALIDATION"));
  } finally {
    cleanup(base);
  }
});
test("verifyExpectedArtifact passes when VALIDATION.md exists", () => {
  const base = makeTmpBase();
  try {
    writeValidation(base, "M001", "---\nverdict: pass\n---\n# Val");
    clearPathCache();
    clearParseCache();
    const result = verifyExpectedArtifact("validate-milestone", "M001", base);
    assert.equal(result, true);
  } finally {
    cleanup(base);
  }
});
test("verifyExpectedArtifact fails when VALIDATION.md is missing", () => {
  const base = makeTmpBase();
  try {
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    clearPathCache();
    clearParseCache();
    const result = verifyExpectedArtifact("validate-milestone", "M001", base);
    assert.equal(result, false);
  } finally {
    cleanup(base);
  }
});
test("verifyExpectedArtifact rejects VALIDATION with missing frontmatter", () => {
  const base = makeTmpBase();
  try {
    writeValidation(base, "M001", "# Validation\nNo frontmatter here.");
    clearPathCache();
    clearParseCache();
    const result = verifyExpectedArtifact("validate-milestone", "M001", base);
    assert.equal(result, false, "VALIDATION without frontmatter should fail verification");
  } finally {
    cleanup(base);
  }
});
test("verifyExpectedArtifact rejects VALIDATION with missing verdict field", () => {
  const base = makeTmpBase();
  try {
    writeValidation(base, "M001", "---\nremediation_round: 0\n---\n\n# Validation");
    clearPathCache();
    clearParseCache();
    const result = verifyExpectedArtifact("validate-milestone", "M001", base);
    assert.equal(result, false, "VALIDATION without verdict field should fail verification");
  } finally {
    cleanup(base);
  }
});
test("verifyExpectedArtifact accepts VALIDATION with any extracted verdict", () => {
  const base = makeTmpBase();
  try {
    writeValidation(base, "M001", "---\nverdict: unknown-value\nremediation_round: 0\n---\n\n# Validation");
    clearPathCache();
    clearParseCache();
    const result = verifyExpectedArtifact("validate-milestone", "M001", base);
    assert.equal(result, true, "VALIDATION with any extracted verdict should pass verification");
  } finally {
    cleanup(base);
  }
});
test("verifyExpectedArtifact passes VALIDATION with needs-attention verdict", () => {
  const base = makeTmpBase();
  try {
    writeValidation(base, "M001", "---\nverdict: needs-attention\nremediation_round: 0\n---\n\n# Validation\nNeeds attention.");
    clearPathCache();
    clearParseCache();
    const result = verifyExpectedArtifact("validate-milestone", "M001", base);
    assert.equal(result, true, "VALIDATION with needs-attention verdict should pass verification");
  } finally {
    cleanup(base);
  }
});
test("diagnoseExpectedArtifact returns validation path for validate-milestone", () => {
  const base = makeTmpBase();
  try {
    const result = diagnoseExpectedArtifact("validate-milestone", "M001", base);
    assert.ok(result);
    assert.ok(result.includes("VALIDATION"));
    assert.ok(result.includes("milestone validation report"));
  } finally {
    cleanup(base);
  }
});
test("buildLoopRemediationSteps returns steps for validate-milestone", () => {
  const base = makeTmpBase();
  try {
    const result = buildLoopRemediationSteps("validate-milestone", "M001", base);
    assert.ok(result);
    assert.ok(result.includes("VALIDATION"));
    assert.ok(result.includes("verdict: pass"));
    assert.ok(result.includes("gsd recover"));
  } finally {
    cleanup(base);
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy92YWxpZGF0ZS1taWxlc3RvbmUudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2RpclN5bmMsIHdyaXRlRmlsZVN5bmMsIGV4aXN0c1N5bmMsIHJtU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcblxuaW1wb3J0IHsgZGVyaXZlU3RhdGUsIGludmFsaWRhdGVTdGF0ZUNhY2hlLCBpc1ZhbGlkYXRpb25UZXJtaW5hbCB9IGZyb20gXCIuLi9zdGF0ZS50c1wiO1xuaW1wb3J0IHsgcmVzb2x2ZUV4cGVjdGVkQXJ0aWZhY3RQYXRoLCBkaWFnbm9zZUV4cGVjdGVkQXJ0aWZhY3QgfSBmcm9tIFwiLi4vYXV0by1hcnRpZmFjdC1wYXRocy50c1wiO1xuaW1wb3J0IHsgdmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdCwgYnVpbGRMb29wUmVtZWRpYXRpb25TdGVwcyB9IGZyb20gXCIuLi9hdXRvLXJlY292ZXJ5LnRzXCI7XG5pbXBvcnQgeyByZXNvbHZlRGlzcGF0Y2gsIHR5cGUgRGlzcGF0Y2hDb250ZXh0IH0gZnJvbSBcIi4uL2F1dG8tZGlzcGF0Y2gudHNcIjtcbmltcG9ydCB7IGJ1aWxkQ29tcGxldGVNaWxlc3RvbmVQcm9tcHQsIGJ1aWxkVmFsaWRhdGVNaWxlc3RvbmVQcm9tcHQgfSBmcm9tIFwiLi4vYXV0by1wcm9tcHRzLnRzXCI7XG5pbXBvcnQgdHlwZSB7IEdTRFN0YXRlIH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5pbXBvcnQgeyBjbGVhclBhdGhDYWNoZSB9IGZyb20gXCIuLi9wYXRocy50c1wiO1xuaW1wb3J0IHsgY2xlYXJQYXJzZUNhY2hlIH0gZnJvbSBcIi4uL2ZpbGVzLnRzXCI7XG5pbXBvcnQgeyBjbG9zZURhdGFiYXNlLCBpbnNlcnRNaWxlc3RvbmUsIGluc2VydFNsaWNlLCBvcGVuRGF0YWJhc2UsIGdldE1pbGVzdG9uZSB9IGZyb20gXCIuLi9nc2QtZGIudHNcIjtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEhlbHBlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIG1ha2VUbXBCYXNlKCk6IHN0cmluZyB7XG4gIGNvbnN0IGJhc2UgPSBqb2luKHRtcGRpcigpLCBgZ3NkLXZhbC10ZXN0LSR7cmFuZG9tVVVJRCgpfWApO1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgcmV0dXJuIGJhc2U7XG59XG5cbmZ1bmN0aW9uIGNsZWFudXAoYmFzZTogc3RyaW5nKTogdm9pZCB7XG4gIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gIGNsZWFyUGF0aENhY2hlKCk7XG4gIGNsZWFyUGFyc2VDYWNoZSgpO1xuICBjbG9zZURhdGFiYXNlKCk7XG4gIHRyeSB7IHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0gY2F0Y2ggeyAvKiAqLyB9XG59XG5cbmZ1bmN0aW9uIG9wZW5UZXN0RGIoYmFzZTogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGRiUGF0aCA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpO1xuICBhc3NlcnQuZXF1YWwob3BlbkRhdGFiYXNlKGRiUGF0aCksIHRydWUsIFwidGVzdCBEQiBzaG91bGQgb3BlblwiKTtcbn1cblxuZnVuY3Rpb24gd3JpdGVSb2FkbWFwKGJhc2U6IHN0cmluZywgbWlkOiBzdHJpbmcsIGNvbnRlbnQ6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBkaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgbWlkKTtcbiAgbWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIGAke21pZH0tUk9BRE1BUC5tZGApLCBjb250ZW50KTtcbn1cblxuZnVuY3Rpb24gd3JpdGVDb250ZXh0KGJhc2U6IHN0cmluZywgbWlkOiBzdHJpbmcsIGNvbnRlbnQgPSBcIiMgTTAwMSBDb250ZXh0XFxuXFxuVmFsaWRhdGVkIGNvbnRleHQuXCIpOiB2b2lkIHtcbiAgY29uc3QgZGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIG1pZCk7XG4gIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBgJHttaWR9LUNPTlRFWFQubWRgKSwgY29udGVudCk7XG59XG5cbmZ1bmN0aW9uIHdyaXRlTWlsZXN0b25lU3VtbWFyeShiYXNlOiBzdHJpbmcsIG1pZDogc3RyaW5nLCBjb250ZW50OiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgZGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIG1pZCk7XG4gIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBgJHttaWR9LVNVTU1BUlkubWRgKSwgY29udGVudCk7XG59XG5cbmZ1bmN0aW9uIHdyaXRlVmFsaWRhdGlvbihiYXNlOiBzdHJpbmcsIG1pZDogc3RyaW5nLCBjb250ZW50OiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgZGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIG1pZCk7XG4gIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBgJHttaWR9LVZBTElEQVRJT04ubWRgKSwgY29udGVudCk7XG59XG5cbmZ1bmN0aW9uIHdyaXRlU2xpY2VQbGFuKGJhc2U6IHN0cmluZywgbWlkOiBzdHJpbmcsIHNpZDogc3RyaW5nLCBjb250ZW50OiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgZGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIG1pZCwgXCJzbGljZXNcIiwgc2lkKTtcbiAgbWtkaXJTeW5jKGpvaW4oZGlyLCBcInRhc2tzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgYCR7c2lkfS1QTEFOLm1kYCksIGNvbnRlbnQpO1xufVxuXG5mdW5jdGlvbiB3cml0ZVNsaWNlU3VtbWFyeShiYXNlOiBzdHJpbmcsIG1pZDogc3RyaW5nLCBzaWQ6IHN0cmluZywgY29udGVudDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGRpciA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBtaWQsIFwic2xpY2VzXCIsIHNpZCk7XG4gIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBgJHtzaWR9LVNVTU1BUlkubWRgKSwgY29udGVudCk7XG59XG5cbmZ1bmN0aW9uIHdyaXRlU2xpY2VBc3Nlc3NtZW50KGJhc2U6IHN0cmluZywgbWlkOiBzdHJpbmcsIHNpZDogc3RyaW5nLCBjb250ZW50OiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgZGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIG1pZCwgXCJzbGljZXNcIiwgc2lkKTtcbiAgbWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIGAke3NpZH0tQVNTRVNTTUVOVC5tZGApLCBjb250ZW50KTtcbn1cblxuY29uc3QgQUxMX0RPTkVfUk9BRE1BUCA9IGAjIE0wMDE6IFRlc3QgTWlsZXN0b25lXG5cbiMjIFZpc2lvblxuVGVzdFxuXG4jIyBTdWNjZXNzIENyaXRlcmlhXG4tIEl0IHdvcmtzXG5cbiMjIFNsaWNlc1xuXG4tIFt4XSAqKlMwMTogRmlyc3Qgc2xpY2UqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXG4gID4gQWZ0ZXIgdGhpczogaXQgd29ya3NcblxuIyMgQm91bmRhcnkgTWFwXG5cbnwgRnJvbSB8IFRvIHwgUHJvZHVjZXMgfCBDb25zdW1lcyB8XG58LS0tLS0tfC0tLS0tfC0tLS0tLS0tLS18LS0tLS0tLS0tLXxcbnwgUzAxICB8IHRlcm1pbmFsIHwgb3V0cHV0IHwgbm90aGluZyB8XG5gO1xuXG5jb25zdCBDT05URVhUX0ZJTEUgPSBgLS0tXG5pZDogTTAwMVxudGl0bGU6IFRlc3QgTWlsZXN0b25lXG4tLS1cblxuIyBDb250ZXh0XG5UZXN0IGNvbnRleHQuXG5gO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgaXNWYWxpZGF0aW9uVGVybWluYWwgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJpc1ZhbGlkYXRpb25UZXJtaW5hbCByZXR1cm5zIHRydWUgZm9yIHZlcmRpY3Q6IHBhc3NcIiwgKCkgPT4ge1xuICBjb25zdCBjb250ZW50ID0gXCItLS1cXG52ZXJkaWN0OiBwYXNzXFxucmVtZWRpYXRpb25fcm91bmQ6IDBcXG4tLS1cXG5cXG4jIFZhbGlkYXRpb25cIjtcbiAgYXNzZXJ0LmVxdWFsKGlzVmFsaWRhdGlvblRlcm1pbmFsKGNvbnRlbnQpLCB0cnVlKTtcbn0pO1xuXG50ZXN0KFwiaXNWYWxpZGF0aW9uVGVybWluYWwgcmV0dXJucyB0cnVlIGZvciB2ZXJkaWN0OiBuZWVkcy1hdHRlbnRpb25cIiwgKCkgPT4ge1xuICBjb25zdCBjb250ZW50ID0gXCItLS1cXG52ZXJkaWN0OiBuZWVkcy1hdHRlbnRpb25cXG5yZW1lZGlhdGlvbl9yb3VuZDogMFxcbi0tLVxcblxcbiMgVmFsaWRhdGlvblwiO1xuICBhc3NlcnQuZXF1YWwoaXNWYWxpZGF0aW9uVGVybWluYWwoY29udGVudCksIHRydWUpO1xufSk7XG5cbnRlc3QoXCJpc1ZhbGlkYXRpb25UZXJtaW5hbCByZXR1cm5zIHRydWUgZm9yIHZlcmRpY3Q6IG5lZWRzLXJlbWVkaWF0aW9uICgjODMyKVwiLCAoKSA9PiB7XG4gIC8vIG5lZWRzLXJlbWVkaWF0aW9uIGlzIHRyZWF0ZWQgYXMgdGVybWluYWwgdG8gcHJldmVudCBpbmZpbml0ZSBsb29wc1xuICAvLyB3aGVuIG5vIHJlbWVkaWF0aW9uIHNsaWNlcyBleGlzdCBpbiB0aGUgcm9hZG1hcC5cbiAgY29uc3QgY29udGVudCA9IFwiLS0tXFxudmVyZGljdDogbmVlZHMtcmVtZWRpYXRpb25cXG5yZW1lZGlhdGlvbl9yb3VuZDogMFxcbi0tLVxcblxcbiMgVmFsaWRhdGlvblwiO1xuICBhc3NlcnQuZXF1YWwoaXNWYWxpZGF0aW9uVGVybWluYWwoY29udGVudCksIHRydWUpO1xufSk7XG5cbnRlc3QoXCJpc1ZhbGlkYXRpb25UZXJtaW5hbCByZXR1cm5zIHRydWUgZm9yIHZlcmRpY3Q6IHBhc3NlZCAoIzE0MjkpXCIsICgpID0+IHtcbiAgY29uc3QgY29udGVudCA9IFwiLS0tXFxudmVyZGljdDogcGFzc2VkXFxucmVtZWRpYXRpb25fcm91bmQ6IDBcXG4tLS1cXG5cXG4jIFZhbGlkYXRpb25cIjtcbiAgYXNzZXJ0LmVxdWFsKGlzVmFsaWRhdGlvblRlcm1pbmFsKGNvbnRlbnQpLCB0cnVlKTtcbn0pO1xuXG50ZXN0KFwiaXNWYWxpZGF0aW9uVGVybWluYWwgcmV0dXJucyB0cnVlIGZvciB2ZXJkaWN0OiBmYWlsICgjMjc2OSlcIiwgKCkgPT4ge1xuICBjb25zdCBjb250ZW50ID0gXCItLS1cXG52ZXJkaWN0OiBmYWlsXFxucmVtZWRpYXRpb25fcm91bmQ6IDFcXG4tLS1cXG5cXG4jIFZhbGlkYXRpb25cIjtcbiAgYXNzZXJ0LmVxdWFsKGlzVmFsaWRhdGlvblRlcm1pbmFsKGNvbnRlbnQpLCB0cnVlKTtcbn0pO1xuXG50ZXN0KFwiaXNWYWxpZGF0aW9uVGVybWluYWwgcmV0dXJucyB0cnVlIGZvciBhbnkgYXJiaXRyYXJ5IHZlcmRpY3Qgc3RyaW5nICgjMjc2OSlcIiwgKCkgPT4ge1xuICBjb25zdCBjb250ZW50ID0gXCItLS1cXG52ZXJkaWN0OiBjdXN0b20tdmVyZGljdFxcbnJlbWVkaWF0aW9uX3JvdW5kOiAwXFxuLS0tXFxuXFxuIyBWYWxpZGF0aW9uXCI7XG4gIGFzc2VydC5lcXVhbChpc1ZhbGlkYXRpb25UZXJtaW5hbChjb250ZW50KSwgdHJ1ZSk7XG59KTtcblxudGVzdChcImlzVmFsaWRhdGlvblRlcm1pbmFsIHJldHVybnMgZmFsc2UgZm9yIG1pc3NpbmcgZnJvbnRtYXR0ZXJcIiwgKCkgPT4ge1xuICBjb25zdCBjb250ZW50ID0gXCIjIFZhbGlkYXRpb25cXG5ObyBmcm9udG1hdHRlciBoZXJlLlwiO1xuICBhc3NlcnQuZXF1YWwoaXNWYWxpZGF0aW9uVGVybWluYWwoY29udGVudCksIGZhbHNlKTtcbn0pO1xuXG50ZXN0KFwiaXNWYWxpZGF0aW9uVGVybWluYWwgcmV0dXJucyBmYWxzZSBmb3IgbWlzc2luZyB2ZXJkaWN0IGZpZWxkXCIsICgpID0+IHtcbiAgY29uc3QgY29udGVudCA9IFwiLS0tXFxucmVtZWRpYXRpb25fcm91bmQ6IDBcXG4tLS1cXG5cXG4jIFZhbGlkYXRpb25cIjtcbiAgYXNzZXJ0LmVxdWFsKGlzVmFsaWRhdGlvblRlcm1pbmFsKGNvbnRlbnQpLCBmYWxzZSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGRlcml2ZVN0YXRlOiB2YWxpZGF0aW5nLW1pbGVzdG9uZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcImRlcml2ZVN0YXRlIHJldHVybnMgdmFsaWRhdGluZy1taWxlc3RvbmUgd2hlbiBhbGwgc2xpY2VzIGRvbmUgYW5kIG5vIFZBTElEQVRJT04gZmlsZVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIHdyaXRlUm9hZG1hcChiYXNlLCBcIk0wMDFcIiwgQUxMX0RPTkVfUk9BRE1BUCk7XG4gICAgLy8gV3JpdGUgQ09OVEVYVCBzbyBtaWxlc3RvbmUgaGFzIGEgdGl0bGVcbiAgICBjb25zdCBkaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiTTAwMS1DT05URVhULm1kXCIpLCBDT05URVhUX0ZJTEUpO1xuXG4gICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcbiAgICBhc3NlcnQuZXF1YWwoc3RhdGUucGhhc2UsIFwidmFsaWRhdGluZy1taWxlc3RvbmVcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQsIFwiTTAwMVwiKTtcbiAgICBhc3NlcnQuZXF1YWwoc3RhdGUuYWN0aXZlU2xpY2UsIG51bGwpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZGVyaXZlU3RhdGUgcmV0dXJucyBjb21wbGV0aW5nLW1pbGVzdG9uZSB3aGVuIFZBTElEQVRJT04gZXhpc3RzIHdpdGggdGVybWluYWwgdmVyZGljdFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIHdyaXRlUm9hZG1hcChiYXNlLCBcIk0wMDFcIiwgQUxMX0RPTkVfUk9BRE1BUCk7XG4gICAgd3JpdGVWYWxpZGF0aW9uKGJhc2UsIFwiTTAwMVwiLCBcIi0tLVxcbnZlcmRpY3Q6IHBhc3NcXG5yZW1lZGlhdGlvbl9yb3VuZDogMFxcbi0tLVxcblxcbiMgVmFsaWRhdGlvblxcbkFsbCBnb29kLlwiKTtcblxuICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHN0YXRlLnBoYXNlLCBcImNvbXBsZXRpbmctbWlsZXN0b25lXCIpO1xuICAgIGFzc2VydC5lcXVhbChzdGF0ZS5hY3RpdmVNaWxlc3RvbmU/LmlkLCBcIk0wMDFcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJkZXJpdmVTdGF0ZSByZXR1cm5zIGJsb2NrZWQgd2hlbiBuZWVkcy1yZW1lZGlhdGlvbiBoYXMgbm8gaW5jb21wbGV0ZSBzbGljZXMgKCM0NTA2KVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIHdyaXRlUm9hZG1hcChiYXNlLCBcIk0wMDFcIiwgQUxMX0RPTkVfUk9BRE1BUCk7XG4gICAgd3JpdGVWYWxpZGF0aW9uKGJhc2UsIFwiTTAwMVwiLCBcIi0tLVxcbnZlcmRpY3Q6IG5lZWRzLXJlbWVkaWF0aW9uXFxucmVtZWRpYXRpb25fcm91bmQ6IDBcXG4tLS1cXG5cXG4jIFZhbGlkYXRpb25cXG5OZWVkcyBmaXhlcy5cIik7XG5cbiAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuICAgIC8vIEFsbCBzbGljZXMgZG9uZSArIG5lZWRzLXJlbWVkaWF0aW9uIFx1MjE5MiBibG9ja2VkIChwcmV2ZW50cyBpbmZpbml0ZVxuICAgIC8vIHZhbGlkYXRlLW1pbGVzdG9uZSBkaXNwYXRjaCBsb29wKS4gUHJldmlvdXNseSByZXR1cm5lZFxuICAgIC8vIHZhbGlkYXRpbmctbWlsZXN0b25lLCB3aGljaCBjYXVzZWQgIzQ1MDYuXG4gICAgYXNzZXJ0LmVxdWFsKHN0YXRlLnBoYXNlLCBcImJsb2NrZWRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQsIFwiTTAwMVwiKTtcbiAgICBhc3NlcnQub2soXG4gICAgICBzdGF0ZS5ibG9ja2Vycy5zb21lKGIgPT4gYi5pbmNsdWRlcyhcIm5lZWRzLXJlbWVkaWF0aW9uXCIpICYmIGIuaW5jbHVkZXMoXCJNMDAxXCIpKSxcbiAgICAgIFwiYmxvY2tlciBtZXNzYWdlIHNob3VsZCBtZW50aW9uIG1pbGVzdG9uZSBhbmQgdmVyZGljdFwiLFxuICAgICk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJkZXJpdmVTdGF0ZSByZXR1cm5zIGNvbXBsZXRlIHdoZW4gYm90aCBWQUxJREFUSU9OIGFuZCBTVU1NQVJZIGV4aXN0XCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgd3JpdGVSb2FkbWFwKGJhc2UsIFwiTTAwMVwiLCBBTExfRE9ORV9ST0FETUFQKTtcbiAgICB3cml0ZVZhbGlkYXRpb24oYmFzZSwgXCJNMDAxXCIsIFwiLS0tXFxudmVyZGljdDogcGFzc1xcbnJlbWVkaWF0aW9uX3JvdW5kOiAwXFxuLS0tXFxuXFxuIyBWYWxpZGF0aW9uXFxuUGFzc2VkLlwiKTtcbiAgICB3cml0ZU1pbGVzdG9uZVN1bW1hcnkoYmFzZSwgXCJNMDAxXCIsIFwiIyBTdW1tYXJ5XFxuRG9uZS5cIik7XG5cbiAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChzdGF0ZS5waGFzZSwgXCJjb21wbGV0ZVwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcImJ1aWxkVmFsaWRhdGVNaWxlc3RvbmVQcm9tcHQgaW5saW5lcyBBU1NFU1NNRU5UIGV2aWRlbmNlIGluc3RlYWQgb2YgVUFUIHNwZWNcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICB3cml0ZVJvYWRtYXAoYmFzZSwgXCJNMDAxXCIsIEFMTF9ET05FX1JPQURNQVApO1xuICAgIGNvbnN0IGRpciA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIik7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJNMDAxLUNPTlRFWFQubWRcIiksIENPTlRFWFRfRklMRSk7XG4gICAgd3JpdGVTbGljZVN1bW1hcnkoYmFzZSwgXCJNMDAxXCIsIFwiUzAxXCIsIFwiIyBTMDEgU3VtbWFyeVxcbkRlbGl2ZXJlZC5cIik7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJzbGljZXNcIiwgXCJTMDFcIiwgXCJTMDEtVUFULm1kXCIpLCBcIiMgVUFUIFNwZWNcXG5EbyB0aGUgdGhpbmcuXFxuXCIpO1xuICAgIHdyaXRlU2xpY2VBc3Nlc3NtZW50KGJhc2UsIFwiTTAwMVwiLCBcIlMwMVwiLCBcIi0tLVxcbnZlcmRpY3Q6IFBBU1NcXG4tLS1cXG4jIEFzc2Vzc21lbnRcXG5FdmlkZW5jZSBjYXB0dXJlZC5cIik7XG5cbiAgICBjb25zdCBwcm9tcHQgPSBhd2FpdCBidWlsZFZhbGlkYXRlTWlsZXN0b25lUHJvbXB0KFwiTTAwMVwiLCBcIlRlc3QgTWlsZXN0b25lXCIsIGJhc2UpO1xuICAgIGFzc2VydC5tYXRjaChwcm9tcHQsIC9TMDEgQXNzZXNzbWVudC9pLCBcInByb21wdCBzaG91bGQgaW5saW5lIGFzc2Vzc21lbnQgZXZpZGVuY2VcIik7XG4gICAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL3ZlcmRpY3Q6IFBBU1MvaSwgXCJwcm9tcHQgc2hvdWxkIGluY2x1ZGUgdGhlIGFzc2Vzc21lbnQgdmVyZGljdFwiKTtcbiAgICBhc3NlcnQuZG9lc05vdE1hdGNoKHByb21wdCwgL1VBVCBTcGVjL2ksIFwicHJvbXB0IHNob3VsZCBub3QgaW5saW5lIHRoZSByYXcgVUFUIHNwZWMgYXMgZXZpZGVuY2VcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJidWlsZENvbXBsZXRlTWlsZXN0b25lUHJvbXB0IHNraXBzIHNraXBwZWQgc2xpY2VzIGZyb20gREItYmFja2VkIHN1bW1hcnkgaW5saW5pbmdcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICB3cml0ZVJvYWRtYXAoYmFzZSwgXCJNMDAxXCIsIGAjIE0wMDE6IFRlc3QgTWlsZXN0b25lXG5cbiMjIFZpc2lvblxuVGVzdFxuXG4jIyBTdWNjZXNzIENyaXRlcmlhXG4tIEl0IHdvcmtzXG5cbiMjIFNsaWNlc1xuXG4tIFt4XSAqKlMwMTogRmlyc3Qgc2xpY2UqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXG4gID4gRG9uZVxuLSBbIF0gKipTMDI6IFNraXBwZWQgc2xpY2UqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXG4gID4gSW50ZW50aW9uYWxseSBza2lwcGVkXG5cbiMjIEJvdW5kYXJ5IE1hcFxuXG58IEZyb20gfCBUbyB8IFByb2R1Y2VzIHwgQ29uc3VtZXMgfFxufC0tLS0tLXwtLS0tLXwtLS0tLS0tLS0tfC0tLS0tLS0tLS18XG58IFMwMSAgfCB0ZXJtaW5hbCB8IG91dHB1dCB8IG5vdGhpbmcgfFxuYCk7XG4gICAgb3BlblRlc3REYihiYXNlKTtcbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3QgTWlsZXN0b25lXCIsIHN0YXR1czogXCJhY3RpdmVcIiB9KTtcbiAgICBpbnNlcnRTbGljZSh7IGlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHRpdGxlOiBcIkZpcnN0IHNsaWNlXCIsIHN0YXR1czogXCJjb21wbGV0ZVwiLCBkZXBlbmRzOiBbXSB9KTtcbiAgICBpbnNlcnRTbGljZSh7IGlkOiBcIlMwMlwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHRpdGxlOiBcIlNraXBwZWQgc2xpY2VcIiwgc3RhdHVzOiBcInNraXBwZWRcIiwgZGVwZW5kczogW10gfSk7XG4gICAgd3JpdGVTbGljZVN1bW1hcnkoYmFzZSwgXCJNMDAxXCIsIFwiUzAxXCIsIFwiIyBTMDEgU3VtbWFyeVxcbkRlbGl2ZXJlZC5cIik7XG5cbiAgICBjb25zdCBwcm9tcHQgPSBhd2FpdCBidWlsZENvbXBsZXRlTWlsZXN0b25lUHJvbXB0KFwiTTAwMVwiLCBcIlRlc3QgTWlsZXN0b25lXCIsIGJhc2UpO1xuICAgIGFzc2VydC5tYXRjaChwcm9tcHQsIC9TMDEgU3VtbWFyeS9pLCBcInByb21wdCBzaG91bGQgaW5saW5lIG5vbi1za2lwcGVkIHNsaWNlIHN1bW1hcmllc1wiKTtcbiAgICBhc3NlcnQuZG9lc05vdE1hdGNoKHByb21wdCwgLyMjIyBTMDIgU3VtbWFyeS9pLCBcInByb21wdCBzaG91bGQgbm90IGlubGluZSBza2lwcGVkIHNsaWNlIHN1bW1hcmllc1wiKTtcbiAgICBhc3NlcnQuZG9lc05vdE1hdGNoKHByb21wdCwgL25vdCBmb3VuZCBcdTIwMTQgZmlsZSBkb2VzIG5vdCBleGlzdCB5ZXQvaSwgXCJwcm9tcHQgc2hvdWxkIG5vdCBlbWl0IHNraXBwZWQtc2xpY2UgbWlzc2luZy1maWxlIHBsYWNlaG9sZGVyc1wiKTtcbiAgICBhc3NlcnQuZG9lc05vdE1hdGNoKHByb21wdCwgL1MwMi1TVU1NQVJZXFwubWQvLCBcInNraXBwZWQgc2xpY2UgbXVzdCBub3QgYXBwZWFyIGluIG9uLWRlbWFuZCBwYXRoIGxpc3QgKCM0NzgwKVwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcImJ1aWxkVmFsaWRhdGVNaWxlc3RvbmVQcm9tcHQgc2tpcHMgc2tpcHBlZCBzbGljZXMgZnJvbSBEQi1iYWNrZWQgc3VtbWFyeSBpbmxpbmluZ1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIHdyaXRlUm9hZG1hcChiYXNlLCBcIk0wMDFcIiwgYCMgTTAwMTogVGVzdCBNaWxlc3RvbmVcblxuIyMgVmlzaW9uXG5UZXN0XG5cbiMjIFN1Y2Nlc3MgQ3JpdGVyaWFcbi0gSXQgd29ya3NcblxuIyMgU2xpY2VzXG5cbi0gW3hdICoqUzAxOiBGaXJzdCBzbGljZSoqIFxcYHJpc2s6bG93XFxgIFxcYGRlcGVuZHM6W11cXGBcbiAgPiBEb25lXG4tIFsgXSAqKlMwMjogU2tpcHBlZCBzbGljZSoqIFxcYHJpc2s6bG93XFxgIFxcYGRlcGVuZHM6W11cXGBcbiAgPiBJbnRlbnRpb25hbGx5IHNraXBwZWRcblxuIyMgQm91bmRhcnkgTWFwXG5cbnwgRnJvbSB8IFRvIHwgUHJvZHVjZXMgfCBDb25zdW1lcyB8XG58LS0tLS0tfC0tLS0tfC0tLS0tLS0tLS18LS0tLS0tLS0tLXxcbnwgUzAxICB8IHRlcm1pbmFsIHwgb3V0cHV0IHwgbm90aGluZyB8XG5gKTtcbiAgICBvcGVuVGVzdERiKGJhc2UpO1xuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdCBNaWxlc3RvbmVcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuICAgIGluc2VydFNsaWNlKHsgaWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiRmlyc3Qgc2xpY2VcIiwgc3RhdHVzOiBcImNvbXBsZXRlXCIsIGRlcGVuZHM6IFtdIH0pO1xuICAgIGluc2VydFNsaWNlKHsgaWQ6IFwiUzAyXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiU2tpcHBlZCBzbGljZVwiLCBzdGF0dXM6IFwic2tpcHBlZFwiLCBkZXBlbmRzOiBbXSB9KTtcbiAgICB3cml0ZVNsaWNlU3VtbWFyeShiYXNlLCBcIk0wMDFcIiwgXCJTMDFcIiwgXCIjIFMwMSBTdW1tYXJ5XFxuRGVsaXZlcmVkLlwiKTtcbiAgICB3cml0ZVNsaWNlQXNzZXNzbWVudChiYXNlLCBcIk0wMDFcIiwgXCJTMDFcIiwgXCItLS1cXG52ZXJkaWN0OiBQQVNTXFxuLS0tXFxuIyBBc3Nlc3NtZW50XFxuRXZpZGVuY2UgY2FwdHVyZWQuXCIpO1xuXG4gICAgY29uc3QgcHJvbXB0ID0gYXdhaXQgYnVpbGRWYWxpZGF0ZU1pbGVzdG9uZVByb21wdChcIk0wMDFcIiwgXCJUZXN0IE1pbGVzdG9uZVwiLCBiYXNlKTtcbiAgICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvUzAxIFN1bW1hcnkvaSwgXCJwcm9tcHQgc2hvdWxkIGlubGluZSBub24tc2tpcHBlZCBzbGljZSBzdW1tYXJpZXNcIik7XG4gICAgYXNzZXJ0LmRvZXNOb3RNYXRjaChwcm9tcHQsIC8jIyMgUzAyIFN1bW1hcnkvaSwgXCJwcm9tcHQgc2hvdWxkIG5vdCBpbmxpbmUgc2tpcHBlZCBzbGljZSBzdW1tYXJpZXNcIik7XG4gICAgYXNzZXJ0LmRvZXNOb3RNYXRjaChwcm9tcHQsIC9ub3QgZm91bmQgXHUyMDE0IGZpbGUgZG9lcyBub3QgZXhpc3QgeWV0L2ksIFwicHJvbXB0IHNob3VsZCBub3QgZW1pdCBza2lwcGVkLXNsaWNlIG1pc3NpbmctZmlsZSBwbGFjZWhvbGRlcnNcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBEaXNwYXRjaCBydWxlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiZGlzcGF0Y2ggcnVsZSBtYXRjaGVzIHZhbGlkYXRpbmctbWlsZXN0b25lIHBoYXNlXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3Qgc3RhdGU6IEdTRFN0YXRlID0ge1xuICAgIGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiB9LFxuICAgIGFjdGl2ZVNsaWNlOiBudWxsLFxuICAgIGFjdGl2ZVRhc2s6IG51bGwsXG4gICAgcGhhc2U6IFwidmFsaWRhdGluZy1taWxlc3RvbmVcIixcbiAgICByZWNlbnREZWNpc2lvbnM6IFtdLFxuICAgIGJsb2NrZXJzOiBbXSxcbiAgICBuZXh0QWN0aW9uOiBcIlZhbGlkYXRlIG1pbGVzdG9uZSBNMDAxLlwiLFxuICAgIHJlZ2lzdHJ5OiBbeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH1dLFxuICAgIHByb2dyZXNzOiB7IG1pbGVzdG9uZXM6IHsgZG9uZTogMCwgdG90YWw6IDEgfSB9LFxuICB9O1xuXG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIC8vIFNldCB1cCBtaW5pbWFsIG1pbGVzdG9uZSBzdHJ1Y3R1cmUgZm9yIHRoZSBwcm9tcHQgYnVpbGRlclxuICAgIHdyaXRlQ29udGV4dChiYXNlLCBcIk0wMDFcIik7XG4gICAgd3JpdGVSb2FkbWFwKGJhc2UsIFwiTTAwMVwiLCBBTExfRE9ORV9ST0FETUFQKTtcbiAgICB3cml0ZVNsaWNlU3VtbWFyeShiYXNlLCBcIk0wMDFcIiwgXCJTMDFcIiwgXCIjIFMwMSBTdW1tYXJ5XFxuRG9uZS5cIik7IC8vIEd1YXJkIHJlcXVpcmVzIHNsaWNlIHN1bW1hcmllcyAoIzEzNjgpXG5cbiAgICBjb25zdCBjdHg6IERpc3BhdGNoQ29udGV4dCA9IHtcbiAgICAgIGJhc2VQYXRoOiBiYXNlLFxuICAgICAgbWlkOiBcIk0wMDFcIixcbiAgICAgIG1pZFRpdGxlOiBcIlRlc3RcIixcbiAgICAgIHN0YXRlLFxuICAgICAgcHJlZnM6IHVuZGVmaW5lZCxcbiAgICB9O1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlc29sdmVEaXNwYXRjaChjdHgpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuYWN0aW9uLCBcImRpc3BhdGNoXCIpO1xuICAgIGlmIChyZXN1bHQuYWN0aW9uID09PSBcImRpc3BhdGNoXCIpIHtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHQudW5pdFR5cGUsIFwidmFsaWRhdGUtbWlsZXN0b25lXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC51bml0SWQsIFwiTTAwMVwiKTtcbiAgICB9XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJkaXNwYXRjaCBydWxlIHNraXBzIHdoZW4gc2tpcF9taWxlc3RvbmVfdmFsaWRhdGlvbiBwcmVmZXJlbmNlIGlzIHNldFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHN0YXRlOiBHU0RTdGF0ZSA9IHtcbiAgICBhY3RpdmVNaWxlc3RvbmU6IHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIgfSxcbiAgICBhY3RpdmVTbGljZTogbnVsbCxcbiAgICBhY3RpdmVUYXNrOiBudWxsLFxuICAgIHBoYXNlOiBcInZhbGlkYXRpbmctbWlsZXN0b25lXCIsXG4gICAgcmVjZW50RGVjaXNpb25zOiBbXSxcbiAgICBibG9ja2VyczogW10sXG4gICAgbmV4dEFjdGlvbjogXCJWYWxpZGF0ZSBtaWxlc3RvbmUgTTAwMS5cIixcbiAgICByZWdpc3RyeTogW3sgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIsIHN0YXR1czogXCJhY3RpdmVcIiB9XSxcbiAgICBwcm9ncmVzczogeyBtaWxlc3RvbmVzOiB7IGRvbmU6IDAsIHRvdGFsOiAxIH0gfSxcbiAgfTtcblxuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICB3cml0ZUNvbnRleHQoYmFzZSwgXCJNMDAxXCIpO1xuICAgIHdyaXRlUm9hZG1hcChiYXNlLCBcIk0wMDFcIiwgQUxMX0RPTkVfUk9BRE1BUCk7XG4gICAgd3JpdGVTbGljZVN1bW1hcnkoYmFzZSwgXCJNMDAxXCIsIFwiUzAxXCIsIFwiIyBTMDEgU3VtbWFyeVxcbkRvbmUuXCIpOyAvLyBHdWFyZCByZXF1aXJlcyBzbGljZSBzdW1tYXJpZXMgKCMxMzY4KVxuXG4gICAgY29uc3QgY3R4OiBEaXNwYXRjaENvbnRleHQgPSB7XG4gICAgICBiYXNlUGF0aDogYmFzZSxcbiAgICAgIG1pZDogXCJNMDAxXCIsXG4gICAgICBtaWRUaXRsZTogXCJUZXN0XCIsXG4gICAgICBzdGF0ZSxcbiAgICAgIHByZWZzOiB7IHBoYXNlczogeyBza2lwX21pbGVzdG9uZV92YWxpZGF0aW9uOiB0cnVlIH0gfSxcbiAgICB9O1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlc29sdmVEaXNwYXRjaChjdHgpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuYWN0aW9uLCBcInNraXBcIik7XG5cbiAgICAvLyBWZXJpZnkgdGhlIFZBTElEQVRJT04gZmlsZSB3YXMgd3JpdHRlblxuICAgIGNvbnN0IHZhbGlkYXRpb25QYXRoID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcIk0wMDEtVkFMSURBVElPTi5tZFwiKTtcbiAgICBhc3NlcnQub2soZXhpc3RzU3luYyh2YWxpZGF0aW9uUGF0aCksIFwiVkFMSURBVElPTiBmaWxlIHNob3VsZCBiZSB3cml0dGVuIG9uIHNraXBcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJza2lwIHdyaXRlIGltbWVkaWF0ZWx5IGFkdmFuY2VzIGRlcml2ZVN0YXRlIG91dCBvZiB2YWxpZGF0aW5nLW1pbGVzdG9uZVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIG9wZW5UZXN0RGIoYmFzZSk7XG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIsIHN0YXR1czogXCJhY3RpdmVcIiB9IGFzIGFueSk7XG4gICAgaW5zZXJ0U2xpY2UoeyBpZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJTbGljZSAxXCIsIHN0YXR1czogXCJjb21wbGV0ZVwiIH0gYXMgYW55KTtcblxuICAgIHdyaXRlQ29udGV4dChiYXNlLCBcIk0wMDFcIik7XG4gICAgd3JpdGVSb2FkbWFwKGJhc2UsIFwiTTAwMVwiLCBBTExfRE9ORV9ST0FETUFQKTtcbiAgICB3cml0ZVNsaWNlU3VtbWFyeShiYXNlLCBcIk0wMDFcIiwgXCJTMDFcIiwgXCIjIFMwMSBTdW1tYXJ5XFxuRG9uZS5cIik7XG5cbiAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgIGNsZWFyUGF0aENhY2hlKCk7XG4gICAgY2xlYXJQYXJzZUNhY2hlKCk7XG5cbiAgICBjb25zdCBiZWZvcmUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcbiAgICBhc3NlcnQuZXF1YWwoYmVmb3JlLnBoYXNlLCBcInZhbGlkYXRpbmctbWlsZXN0b25lXCIsIFwicHJlY29uZGl0aW9uOiBtaXNzaW5nIFZBTElEQVRJT04ga2VlcHMgcGhhc2UgaW4gdmFsaWRhdGlvblwiKTtcblxuICAgIGNvbnN0IGN0eDogRGlzcGF0Y2hDb250ZXh0ID0ge1xuICAgICAgYmFzZVBhdGg6IGJhc2UsXG4gICAgICBtaWQ6IFwiTTAwMVwiLFxuICAgICAgbWlkVGl0bGU6IFwiVGVzdFwiLFxuICAgICAgc3RhdGU6IGJlZm9yZSxcbiAgICAgIHByZWZzOiB7IHBoYXNlczogeyBza2lwX21pbGVzdG9uZV92YWxpZGF0aW9uOiB0cnVlIH0gfSxcbiAgICB9O1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlc29sdmVEaXNwYXRjaChjdHgpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuYWN0aW9uLCBcInNraXBcIik7XG5cbiAgICBjb25zdCBhZnRlciA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIGFmdGVyLnBoYXNlLFxuICAgICAgXCJjb21wbGV0aW5nLW1pbGVzdG9uZVwiLFxuICAgICAgXCJwb3N0LXNraXAgZGVyaXZlU3RhdGUgc2hvdWxkIHNlZSB0aGUgbmV3IFZBTElEQVRJT04gZmlsZSB3aXRob3V0IG1hbnVhbCBjYWNoZSBpbnZhbGlkYXRpb25cIixcbiAgICApO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZGlzcGF0Y2ggcnVsZSBpZ25vcmVzIGZhaWx1cmUtcGF0aCBTVU1NQVJZIHByb2plY3Rpb24gd2hlbiBEQiBtaWxlc3RvbmUgaXMgbm90IGNvbXBsZXRlICgjNDY1OCBzdXBlcnNlZGVkKVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHN0YXRlOiBHU0RTdGF0ZSA9IHtcbiAgICBhY3RpdmVNaWxlc3RvbmU6IHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIgfSxcbiAgICBhY3RpdmVTbGljZTogbnVsbCxcbiAgICBhY3RpdmVUYXNrOiBudWxsLFxuICAgIHBoYXNlOiBcImNvbXBsZXRpbmctbWlsZXN0b25lXCIsXG4gICAgcmVjZW50RGVjaXNpb25zOiBbXSxcbiAgICBibG9ja2VyczogW10sXG4gICAgbmV4dEFjdGlvbjogXCJDb21wbGV0ZSBtaWxlc3RvbmUgTTAwMS5cIixcbiAgICByZWdpc3RyeTogW3sgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIsIHN0YXR1czogXCJhY3RpdmVcIiB9XSxcbiAgICBwcm9ncmVzczogeyBtaWxlc3RvbmVzOiB7IGRvbmU6IDAsIHRvdGFsOiAxIH0gfSxcbiAgfTtcblxuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBvcGVuVGVzdERiKGJhc2UpO1xuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdFwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSk7XG4gICAgd3JpdGVDb250ZXh0KGJhc2UsIFwiTTAwMVwiKTtcbiAgICB3cml0ZU1pbGVzdG9uZVN1bW1hcnkoYmFzZSwgXCJNMDAxXCIsIFwiIyBNaWxlc3RvbmUgU3VtbWFyeVxcbnZlcmlmaWNhdGlvbiBGQUlMRUQgXHUyMDE0IG5vdCBjb21wbGV0ZS5cIik7XG5cbiAgICBjb25zdCBjdHg6IERpc3BhdGNoQ29udGV4dCA9IHtcbiAgICAgIGJhc2VQYXRoOiBiYXNlLFxuICAgICAgbWlkOiBcIk0wMDFcIixcbiAgICAgIG1pZFRpdGxlOiBcIlRlc3RcIixcbiAgICAgIHN0YXRlLFxuICAgICAgcHJlZnM6IHVuZGVmaW5lZCxcbiAgICB9O1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlc29sdmVEaXNwYXRjaChjdHgpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuYWN0aW9uLCBcImRpc3BhdGNoXCIpO1xuICAgIGFzc2VydC5lcXVhbChnZXRNaWxlc3RvbmUoXCJNMDAxXCIpPy5zdGF0dXMsIFwiYWN0aXZlXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZGlzcGF0Y2ggcnVsZSBkb2VzIG5vdCByZWNvbmNpbGUgREIgZnJvbSBzdWNjZXNzZnVsIHN0YWxlIFNVTU1BUlkgcHJvamVjdGlvbiAoIzQ2NTggc3VwZXJzZWRlZClcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBzdGF0ZTogR1NEU3RhdGUgPSB7XG4gICAgYWN0aXZlTWlsZXN0b25lOiB7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdFwiIH0sXG4gICAgYWN0aXZlU2xpY2U6IG51bGwsXG4gICAgYWN0aXZlVGFzazogbnVsbCxcbiAgICBwaGFzZTogXCJjb21wbGV0aW5nLW1pbGVzdG9uZVwiLFxuICAgIHJlY2VudERlY2lzaW9uczogW10sXG4gICAgYmxvY2tlcnM6IFtdLFxuICAgIG5leHRBY3Rpb246IFwiQ29tcGxldGUgbWlsZXN0b25lIE0wMDEuXCIsXG4gICAgcmVnaXN0cnk6IFt7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdFwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfV0sXG4gICAgcHJvZ3Jlc3M6IHsgbWlsZXN0b25lczogeyBkb25lOiAwLCB0b3RhbDogMSB9IH0sXG4gIH07XG5cbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgb3BlblRlc3REYihiYXNlKTtcbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuICAgIHdyaXRlQ29udGV4dChiYXNlLCBcIk0wMDFcIik7XG4gICAgd3JpdGVNaWxlc3RvbmVTdW1tYXJ5KFxuICAgICAgYmFzZSxcbiAgICAgIFwiTTAwMVwiLFxuICAgICAgW1xuICAgICAgICBcIi0tLVwiLFxuICAgICAgICBcImlkOiBNMDAxXCIsXG4gICAgICAgIFwic3RhdHVzOiBjb21wbGV0ZVwiLFxuICAgICAgICBcIi0tLVwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIiMgTTAwMTogVGVzdFwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIioqQ29tcGxldGUuKipcIixcbiAgICAgIF0uam9pbihcIlxcblwiKSxcbiAgICApO1xuXG4gICAgY29uc3QgY3R4OiBEaXNwYXRjaENvbnRleHQgPSB7XG4gICAgICBiYXNlUGF0aDogYmFzZSxcbiAgICAgIG1pZDogXCJNMDAxXCIsXG4gICAgICBtaWRUaXRsZTogXCJUZXN0XCIsXG4gICAgICBzdGF0ZSxcbiAgICAgIHByZWZzOiB1bmRlZmluZWQsXG4gICAgfTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXNvbHZlRGlzcGF0Y2goY3R4KTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmFjdGlvbiwgXCJkaXNwYXRjaFwiKTtcbiAgICBjb25zdCBtaWxlc3RvbmUgPSBnZXRNaWxlc3RvbmUoXCJNMDAxXCIpO1xuICAgIGFzc2VydC5lcXVhbChtaWxlc3RvbmU/LnN0YXR1cywgXCJhY3RpdmVcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJkaXNwYXRjaCBydWxlIGlnbm9yZXMgYW1iaWd1b3VzIHN0YWxlIFNVTU1BUlkgcHJvamVjdGlvbiAoIzQ2NTggc3VwZXJzZWRlZClcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBzdGF0ZTogR1NEU3RhdGUgPSB7XG4gICAgYWN0aXZlTWlsZXN0b25lOiB7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdFwiIH0sXG4gICAgYWN0aXZlU2xpY2U6IG51bGwsXG4gICAgYWN0aXZlVGFzazogbnVsbCxcbiAgICBwaGFzZTogXCJjb21wbGV0aW5nLW1pbGVzdG9uZVwiLFxuICAgIHJlY2VudERlY2lzaW9uczogW10sXG4gICAgYmxvY2tlcnM6IFtdLFxuICAgIG5leHRBY3Rpb246IFwiQ29tcGxldGUgbWlsZXN0b25lIE0wMDEuXCIsXG4gICAgcmVnaXN0cnk6IFt7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdFwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfV0sXG4gICAgcHJvZ3Jlc3M6IHsgbWlsZXN0b25lczogeyBkb25lOiAwLCB0b3RhbDogMSB9IH0sXG4gIH07XG5cbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgb3BlblRlc3REYihiYXNlKTtcbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuICAgIHdyaXRlQ29udGV4dChiYXNlLCBcIk0wMDFcIik7XG4gICAgd3JpdGVNaWxlc3RvbmVTdW1tYXJ5KGJhc2UsIFwiTTAwMVwiLCBcIiMgTTAwMSBTdW1tYXJ5XFxuU29tZSBub3RlcyB3aXRob3V0IGNvbXBsZXRpb24gbWV0YWRhdGEuXCIpO1xuXG4gICAgY29uc3QgY3R4OiBEaXNwYXRjaENvbnRleHQgPSB7XG4gICAgICBiYXNlUGF0aDogYmFzZSxcbiAgICAgIG1pZDogXCJNMDAxXCIsXG4gICAgICBtaWRUaXRsZTogXCJUZXN0XCIsXG4gICAgICBzdGF0ZSxcbiAgICAgIHByZWZzOiB1bmRlZmluZWQsXG4gICAgfTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXNvbHZlRGlzcGF0Y2goY3R4KTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmFjdGlvbiwgXCJkaXNwYXRjaFwiKTtcbiAgICBhc3NlcnQuZXF1YWwoZ2V0TWlsZXN0b25lKFwiTTAwMVwiKT8uc3RhdHVzLCBcImFjdGl2ZVwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEFydGlmYWN0IHJlc29sdXRpb24gJiB2ZXJpZmljYXRpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJyZXNvbHZlRXhwZWN0ZWRBcnRpZmFjdFBhdGggcmV0dXJucyBWQUxJREFUSU9OIHBhdGggZm9yIHZhbGlkYXRlLW1pbGVzdG9uZVwiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBjb25zdCByZXN1bHQgPSByZXNvbHZlRXhwZWN0ZWRBcnRpZmFjdFBhdGgoXCJ2YWxpZGF0ZS1taWxlc3RvbmVcIiwgXCJNMDAxXCIsIGJhc2UpO1xuICAgIGFzc2VydC5vayhyZXN1bHQpO1xuICAgIGFzc2VydC5vayhyZXN1bHQhLmluY2x1ZGVzKFwiVkFMSURBVElPTlwiKSk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJ2ZXJpZnlFeHBlY3RlZEFydGlmYWN0IHBhc3NlcyB3aGVuIFZBTElEQVRJT04ubWQgZXhpc3RzXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgd3JpdGVWYWxpZGF0aW9uKGJhc2UsIFwiTTAwMVwiLCBcIi0tLVxcbnZlcmRpY3Q6IHBhc3NcXG4tLS1cXG4jIFZhbFwiKTtcbiAgICBjbGVhclBhdGhDYWNoZSgpO1xuICAgIGNsZWFyUGFyc2VDYWNoZSgpO1xuICAgIGNvbnN0IHJlc3VsdCA9IHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QoXCJ2YWxpZGF0ZS1taWxlc3RvbmVcIiwgXCJNMDAxXCIsIGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIHRydWUpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwidmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdCBmYWlscyB3aGVuIFZBTElEQVRJT04ubWQgaXMgbWlzc2luZ1wiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBjbGVhclBhdGhDYWNoZSgpO1xuICAgIGNsZWFyUGFyc2VDYWNoZSgpO1xuICAgIGNvbnN0IHJlc3VsdCA9IHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QoXCJ2YWxpZGF0ZS1taWxlc3RvbmVcIiwgXCJNMDAxXCIsIGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIGZhbHNlKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcInZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QgcmVqZWN0cyBWQUxJREFUSU9OIHdpdGggbWlzc2luZyBmcm9udG1hdHRlclwiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIC8vIEEgVkFMSURBVElPTiBmaWxlIHdpdGhvdXQgZnJvbnRtYXR0ZXIgc2hvdWxkIGJlIHRyZWF0ZWQgYXMgaW5jb21wbGV0ZSBcdTIwMTRcbiAgICAvLyBtYXRjaGluZyB3aGF0IGRlcml2ZVN0YXRlIGV4cGVjdHMuIFdpdGhvdXQgdGhpcywgdGhlIGFydGlmYWN0IGNoZWNrIHBhc3Nlc1xuICAgIC8vIGJ1dCBkZXJpdmVTdGF0ZSBzdGlsbCByZXR1cm5zIHZhbGlkYXRpbmctbWlsZXN0b25lLCBjYXVzaW5nIHRoZSBoYXJkIHNraXAgbG9vcC5cbiAgICB3cml0ZVZhbGlkYXRpb24oYmFzZSwgXCJNMDAxXCIsIFwiIyBWYWxpZGF0aW9uXFxuTm8gZnJvbnRtYXR0ZXIgaGVyZS5cIik7XG4gICAgY2xlYXJQYXRoQ2FjaGUoKTtcbiAgICBjbGVhclBhcnNlQ2FjaGUoKTtcbiAgICBjb25zdCByZXN1bHQgPSB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0KFwidmFsaWRhdGUtbWlsZXN0b25lXCIsIFwiTTAwMVwiLCBiYXNlKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCBmYWxzZSwgXCJWQUxJREFUSU9OIHdpdGhvdXQgZnJvbnRtYXR0ZXIgc2hvdWxkIGZhaWwgdmVyaWZpY2F0aW9uXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwidmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdCByZWplY3RzIFZBTElEQVRJT04gd2l0aCBtaXNzaW5nIHZlcmRpY3QgZmllbGRcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICB3cml0ZVZhbGlkYXRpb24oYmFzZSwgXCJNMDAxXCIsIFwiLS0tXFxucmVtZWRpYXRpb25fcm91bmQ6IDBcXG4tLS1cXG5cXG4jIFZhbGlkYXRpb25cIik7XG4gICAgY2xlYXJQYXRoQ2FjaGUoKTtcbiAgICBjbGVhclBhcnNlQ2FjaGUoKTtcbiAgICBjb25zdCByZXN1bHQgPSB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0KFwidmFsaWRhdGUtbWlsZXN0b25lXCIsIFwiTTAwMVwiLCBiYXNlKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCBmYWxzZSwgXCJWQUxJREFUSU9OIHdpdGhvdXQgdmVyZGljdCBmaWVsZCBzaG91bGQgZmFpbCB2ZXJpZmljYXRpb25cIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJ2ZXJpZnlFeHBlY3RlZEFydGlmYWN0IGFjY2VwdHMgVkFMSURBVElPTiB3aXRoIGFueSBleHRyYWN0ZWQgdmVyZGljdFwiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIHdyaXRlVmFsaWRhdGlvbihiYXNlLCBcIk0wMDFcIiwgXCItLS1cXG52ZXJkaWN0OiB1bmtub3duLXZhbHVlXFxucmVtZWRpYXRpb25fcm91bmQ6IDBcXG4tLS1cXG5cXG4jIFZhbGlkYXRpb25cIik7XG4gICAgY2xlYXJQYXRoQ2FjaGUoKTtcbiAgICBjbGVhclBhcnNlQ2FjaGUoKTtcbiAgICBjb25zdCByZXN1bHQgPSB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0KFwidmFsaWRhdGUtbWlsZXN0b25lXCIsIFwiTTAwMVwiLCBiYXNlKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCB0cnVlLCBcIlZBTElEQVRJT04gd2l0aCBhbnkgZXh0cmFjdGVkIHZlcmRpY3Qgc2hvdWxkIHBhc3MgdmVyaWZpY2F0aW9uXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwidmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdCBwYXNzZXMgVkFMSURBVElPTiB3aXRoIG5lZWRzLWF0dGVudGlvbiB2ZXJkaWN0XCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgd3JpdGVWYWxpZGF0aW9uKGJhc2UsIFwiTTAwMVwiLCBcIi0tLVxcbnZlcmRpY3Q6IG5lZWRzLWF0dGVudGlvblxcbnJlbWVkaWF0aW9uX3JvdW5kOiAwXFxuLS0tXFxuXFxuIyBWYWxpZGF0aW9uXFxuTmVlZHMgYXR0ZW50aW9uLlwiKTtcbiAgICBjbGVhclBhdGhDYWNoZSgpO1xuICAgIGNsZWFyUGFyc2VDYWNoZSgpO1xuICAgIGNvbnN0IHJlc3VsdCA9IHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QoXCJ2YWxpZGF0ZS1taWxlc3RvbmVcIiwgXCJNMDAxXCIsIGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIHRydWUsIFwiVkFMSURBVElPTiB3aXRoIG5lZWRzLWF0dGVudGlvbiB2ZXJkaWN0IHNob3VsZCBwYXNzIHZlcmlmaWNhdGlvblwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGRpYWdub3NlRXhwZWN0ZWRBcnRpZmFjdCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcImRpYWdub3NlRXhwZWN0ZWRBcnRpZmFjdCByZXR1cm5zIHZhbGlkYXRpb24gcGF0aCBmb3IgdmFsaWRhdGUtbWlsZXN0b25lXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gZGlhZ25vc2VFeHBlY3RlZEFydGlmYWN0KFwidmFsaWRhdGUtbWlsZXN0b25lXCIsIFwiTTAwMVwiLCBiYXNlKTtcbiAgICBhc3NlcnQub2socmVzdWx0KTtcbiAgICBhc3NlcnQub2socmVzdWx0IS5pbmNsdWRlcyhcIlZBTElEQVRJT05cIikpO1xuICAgIGFzc2VydC5vayhyZXN1bHQhLmluY2x1ZGVzKFwibWlsZXN0b25lIHZhbGlkYXRpb24gcmVwb3J0XCIpKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGJ1aWxkTG9vcFJlbWVkaWF0aW9uU3RlcHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJidWlsZExvb3BSZW1lZGlhdGlvblN0ZXBzIHJldHVybnMgc3RlcHMgZm9yIHZhbGlkYXRlLW1pbGVzdG9uZVwiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IGJ1aWxkTG9vcFJlbWVkaWF0aW9uU3RlcHMoXCJ2YWxpZGF0ZS1taWxlc3RvbmVcIiwgXCJNMDAxXCIsIGJhc2UpO1xuICAgIGFzc2VydC5vayhyZXN1bHQpO1xuICAgIGFzc2VydC5vayhyZXN1bHQhLmluY2x1ZGVzKFwiVkFMSURBVElPTlwiKSk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdCEuaW5jbHVkZXMoXCJ2ZXJkaWN0OiBwYXNzXCIpKTtcbiAgICBhc3NlcnQub2socmVzdWx0IS5pbmNsdWRlcyhcImdzZCByZWNvdmVyXCIpKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxXQUFXLGVBQWUsWUFBWSxjQUFjO0FBQzdELFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFDdkIsU0FBUyxrQkFBa0I7QUFFM0IsU0FBUyxhQUFhLHNCQUFzQiw0QkFBNEI7QUFDeEUsU0FBUyw2QkFBNkIsZ0NBQWdDO0FBQ3RFLFNBQVMsd0JBQXdCLGlDQUFpQztBQUNsRSxTQUFTLHVCQUE2QztBQUN0RCxTQUFTLDhCQUE4QixvQ0FBb0M7QUFFM0UsU0FBUyxzQkFBc0I7QUFDL0IsU0FBUyx1QkFBdUI7QUFDaEMsU0FBUyxlQUFlLGlCQUFpQixhQUFhLGNBQWMsb0JBQW9CO0FBSXhGLFNBQVMsY0FBc0I7QUFDN0IsUUFBTSxPQUFPLEtBQUssT0FBTyxHQUFHLGdCQUFnQixXQUFXLENBQUMsRUFBRTtBQUMxRCxZQUFVLEtBQUssTUFBTSxRQUFRLFlBQVksR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQy9ELFNBQU87QUFDVDtBQUVBLFNBQVMsUUFBUSxNQUFvQjtBQUNuQyx1QkFBcUI7QUFDckIsaUJBQWU7QUFDZixrQkFBZ0I7QUFDaEIsZ0JBQWM7QUFDZCxNQUFJO0FBQUUsV0FBTyxNQUFNLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsRUFBRyxRQUFRO0FBQUEsRUFBUTtBQUN4RTtBQUVBLFNBQVMsV0FBVyxNQUFvQjtBQUN0QyxRQUFNLFNBQVMsS0FBSyxNQUFNLFFBQVEsUUFBUTtBQUMxQyxTQUFPLE1BQU0sYUFBYSxNQUFNLEdBQUcsTUFBTSxxQkFBcUI7QUFDaEU7QUFFQSxTQUFTLGFBQWEsTUFBYyxLQUFhLFNBQXVCO0FBQ3RFLFFBQU0sTUFBTSxLQUFL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
