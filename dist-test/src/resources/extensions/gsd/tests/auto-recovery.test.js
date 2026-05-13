import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { verifyExpectedArtifact, hasImplementationArtifacts, resolveExpectedArtifactPath, diagnoseExpectedArtifact, diagnoseWorktreeIntegrityFailure, buildLoopRemediationSteps, writeBlockerPlaceholder, refreshRecoveryDbForArtifact } from "../auto-recovery.js";
import { resolveMilestoneFile } from "../paths.js";
import { openDatabase, closeDatabase, insertMilestone, insertSlice, insertGateRow, insertTask, getMilestoneCommitAttributionShas } from "../gsd-db.js";
import { clearParseCache } from "../files.js";
import { parseRoadmap } from "../parsers-legacy.js";
import { invalidateAllCaches } from "../cache.js";
import { deriveState, invalidateStateCache } from "../state.js";
import { writeIntegrationBranch } from "../git-service.js";
const tmpDirs = [];
function makeTmpBase() {
  const base = join(tmpdir(), `gsd-test-${randomUUID()}`);
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  return base;
}
function cleanup(base) {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
  }
}
function makeTmpProject() {
  const dir = mkdtempSync(join(tmpdir(), "auto-recovery-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  openDatabase(join(dir, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
  insertSlice({
    milestoneId: "M001",
    id: "S01",
    title: "Test Slice",
    status: "pending",
    risk: "low",
    depends: []
  });
  insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", scope: "slice" });
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  closeDatabase();
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
    }
  }
  tmpDirs.length = 0;
});
test("resolveExpectedArtifactPath returns correct path for execute-task", () => {
  const base = makeTmpBase();
  try {
    const result = resolveExpectedArtifactPath("execute-task", "M001/S01/T01", base);
    assert.ok(result);
    assert.ok(result.includes("tasks"));
    assert.ok(result.includes("SUMMARY"));
  } finally {
    cleanup(base);
  }
});
test("resolveExpectedArtifactPath returns correct path for complete-slice", () => {
  const base = makeTmpBase();
  try {
    const result = resolveExpectedArtifactPath("complete-slice", "M001/S01", base);
    assert.ok(result);
    assert.ok(result.includes("SUMMARY"));
  } finally {
    cleanup(base);
  }
});
test("resolveExpectedArtifactPath returns correct path for plan-slice", () => {
  const base = makeTmpBase();
  try {
    const result = resolveExpectedArtifactPath("plan-slice", "M001/S01", base);
    assert.ok(result);
    assert.ok(result.includes("PLAN"));
  } finally {
    cleanup(base);
  }
});
test("plan-slice artifact resolution handles lowercase unit IDs against uppercase paths", () => {
  const base = makeTmpBase();
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    const tasksDir = join(sliceDir, "tasks");
    writeFileSync(join(sliceDir, "S01-PLAN.md"), [
      "# S01: Test Slice",
      "",
      "## Tasks",
      "",
      "- [ ] **T01: Implement feature** `est:1h`"
    ].join("\n"));
    writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01 Plan");
    const artifactPath = resolveExpectedArtifactPath("plan-slice", "m001/s01", base);
    assert.ok(
      artifactPath?.endsWith(".gsd/milestones/M001/slices/S01/S01-PLAN.md"),
      "lowercase unit IDs should resolve to the existing uppercase artifact path"
    );
    const diagnostic = diagnoseExpectedArtifact("plan-slice", "m001/s01", base);
    assert.ok(
      diagnostic?.includes(".gsd/milestones/M001/slices/S01/S01-PLAN.md"),
      "diagnostic should report the existing uppercase artifact path"
    );
    assert.ok(
      diagnostic?.includes("task plans"),
      "diagnostic should mention task plans because slice plan alone is insufficient"
    );
    assert.equal(
      verifyExpectedArtifact("plan-slice", "m001/s01", base),
      true,
      "verification should pass when the uppercase slice plan and task plans exist"
    );
  } finally {
    cleanup(base);
  }
});
test("resolveExpectedArtifactPath returns null for unknown type", () => {
  const base = makeTmpBase();
  try {
    const result = resolveExpectedArtifactPath("unknown-type", "M001", base);
    assert.equal(result, null);
  } finally {
    cleanup(base);
  }
});
test("diagnoseWorktreeIntegrityFailure reports missing GSD worktree paths only", () => {
  const missingWorktreePath = join(tmpdir(), `gsd-test-${randomUUID()}`, ".gsd", "worktrees", "M001-S01");
  assert.equal(
    diagnoseWorktreeIntegrityFailure(join(tmpdir(), `gsd-test-${randomUUID()}`)),
    null,
    "non-GSD paths should keep falling through to artifact recovery"
  );
  assert.equal(
    diagnoseWorktreeIntegrityFailure(missingWorktreePath),
    `Worktree integrity failure: ${missingWorktreePath} does not exist. Repair or recreate the worktree before retrying.`,
    "missing GSD worktree paths should fail terminally before artifact retry"
  );
});
test("resolveExpectedArtifactPath returns correct path for all milestone-level types", () => {
  const base = makeTmpBase();
  try {
    const planResult = resolveExpectedArtifactPath("plan-milestone", "M001", base);
    assert.ok(planResult);
    assert.ok(planResult.includes("ROADMAP"));
    const completeResult = resolveExpectedArtifactPath("complete-milestone", "M001", base);
    assert.ok(completeResult);
    assert.ok(completeResult.includes("SUMMARY"));
  } finally {
    cleanup(base);
  }
});
test("resolveExpectedArtifactPath returns correct path for all slice-level types", () => {
  const base = makeTmpBase();
  try {
    const researchResult = resolveExpectedArtifactPath("research-slice", "M001/S01", base);
    assert.ok(researchResult);
    assert.ok(researchResult.includes("RESEARCH"));
    const assessResult = resolveExpectedArtifactPath("reassess-roadmap", "M001/S01", base);
    assert.ok(assessResult);
    assert.ok(assessResult.includes("ASSESSMENT"));
    const uatResult = resolveExpectedArtifactPath("run-uat", "M001/S01", base);
    assert.ok(uatResult);
    assert.ok(uatResult.includes("ASSESSMENT"));
  } finally {
    cleanup(base);
  }
});
test("refreshRecoveryDbForArtifact treats missing execute-task DB rows as fatal mismatches", () => {
  makeTmpProject();
  const result = refreshRecoveryDbForArtifact("execute-task", "M001/S01/T01");
  assert.deepEqual(result, {
    ok: false,
    fatal: true,
    reason: "execute-task-artifact-db-missing",
    message: "Stuck recovery found execute-task M001/S01/T01 artifacts, but no matching DB task row exists after refresh."
  });
});
test("diagnoseExpectedArtifact returns description for known types", () => {
  const base = makeTmpBase();
  try {
    const research = diagnoseExpectedArtifact("research-milestone", "M001", base);
    assert.ok(research);
    assert.ok(research.includes("research"));
    const plan = diagnoseExpectedArtifact("plan-slice", "M001/S01", base);
    assert.ok(plan);
    assert.ok(plan.includes("plan"));
    const task = diagnoseExpectedArtifact("execute-task", "M001/S01/T01", base);
    assert.ok(task);
    assert.ok(task.includes("T01"));
  } finally {
    cleanup(base);
  }
});
test("diagnoseExpectedArtifact returns null for unknown type", () => {
  const base = makeTmpBase();
  try {
    assert.equal(diagnoseExpectedArtifact("unknown", "M001", base), null);
  } finally {
    cleanup(base);
  }
});
test("buildLoopRemediationSteps returns steps for execute-task", () => {
  const base = makeTmpBase();
  try {
    const steps = buildLoopRemediationSteps("execute-task", "M001/S01/T01", base);
    assert.ok(steps);
    assert.ok(steps.includes("T01"));
    assert.ok(steps.includes("gsd undo-task"));
  } finally {
    cleanup(base);
  }
});
test("buildLoopRemediationSteps returns steps for plan-slice", () => {
  const base = makeTmpBase();
  try {
    const steps = buildLoopRemediationSteps("plan-slice", "M001/S01", base);
    assert.ok(steps);
    assert.ok(steps.includes("PLAN"));
    assert.ok(steps.includes("gsd recover"));
  } finally {
    cleanup(base);
  }
});
test("buildLoopRemediationSteps returns steps for complete-slice", () => {
  const base = makeTmpBase();
  try {
    const steps = buildLoopRemediationSteps("complete-slice", "M001/S01", base);
    assert.ok(steps);
    assert.ok(steps.includes("S01"));
    assert.ok(steps.includes("gsd reset-slice"));
  } finally {
    cleanup(base);
  }
});
test("buildLoopRemediationSteps returns null for unknown type", () => {
  const base = makeTmpBase();
  try {
    assert.equal(buildLoopRemediationSteps("unknown", "M001", base), null);
  } finally {
    cleanup(base);
  }
});
test("verifyExpectedArtifact detects roadmap [x] change despite parse cache", () => {
  const base = makeTmpBase();
  try {
    const padding = "A".repeat(200);
    const roadmapBefore = [
      `# M001: Test Milestone ${padding}`,
      "",
      "## Slices",
      "",
      "- [ ] **S01: First slice** `risk:low`",
      "",
      `## Footer ${padding}`
    ].join("\n");
    const roadmapAfter = roadmapBefore.replace("- [ ] **S01:", "- [x] **S01:");
    assert.equal(roadmapBefore.length, roadmapAfter.length);
    const before = parseRoadmap(roadmapBefore);
    const sliceBefore = before.slices.find((s) => s.id === "S01");
    assert.ok(sliceBefore);
    assert.equal(sliceBefore.done, false);
    const roadmapPath = join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md");
    writeFileSync(roadmapPath, roadmapAfter);
    const summaryPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md");
    writeFileSync(summaryPath, "# Summary\nDone.");
    const uatPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-UAT.md");
    writeFileSync(uatPath, "# UAT\nPassed.");
    const verified = verifyExpectedArtifact("complete-slice", "M001/S01", base);
    assert.equal(verified, true, "verifyExpectedArtifact should return true when roadmap has [x]");
  } finally {
    clearParseCache();
    cleanup(base);
  }
});
test("verifyExpectedArtifact rejects plan-slice with empty scaffold", () => {
  const base = makeTmpBase();
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(sliceDir, { recursive: true });
    writeFileSync(join(sliceDir, "S01-PLAN.md"), "# S01: Test Slice\n\n## Tasks\n\n");
    assert.strictEqual(
      verifyExpectedArtifact("plan-slice", "M001/S01", base),
      false,
      "Empty scaffold should not be treated as completed artifact"
    );
  } finally {
    cleanup(base);
  }
});
test("verifyExpectedArtifact accepts plan-slice with actual tasks", () => {
  const base = makeTmpBase();
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    const tasksDir = join(sliceDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(sliceDir, "S01-PLAN.md"), [
      "# S01: Test Slice",
      "",
      "## Tasks",
      "",
      "- [ ] **T01: Implement feature** `est:2h`",
      "- [ ] **T02: Write tests** `est:1h`"
    ].join("\n"));
    writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01 Plan");
    writeFileSync(join(tasksDir, "T02-PLAN.md"), "# T02 Plan");
    assert.strictEqual(
      verifyExpectedArtifact("plan-slice", "M001/S01", base),
      true,
      "Plan with task entries should be treated as completed artifact"
    );
  } finally {
    cleanup(base);
  }
});
test("verifyExpectedArtifact accepts plan-slice with completed tasks", () => {
  const base = makeTmpBase();
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    const tasksDir = join(sliceDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(sliceDir, "S01-PLAN.md"), [
      "# S01: Test Slice",
      "",
      "## Tasks",
      "",
      "- [x] **T01: Implement feature** `est:2h`",
      "- [ ] **T02: Write tests** `est:1h`"
    ].join("\n"));
    writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01 Plan");
    writeFileSync(join(tasksDir, "T02-PLAN.md"), "# T02 Plan");
    assert.strictEqual(
      verifyExpectedArtifact("plan-slice", "M001/S01", base),
      true,
      "Plan with completed task entries should be treated as completed artifact"
    );
  } finally {
    cleanup(base);
  }
});
test("verifyExpectedArtifact treats complete-slice as satisfied when summary, UAT, and roadmap checkbox exist", () => {
  const base = makeTmpBase();
  try {
    const milestoneDir = join(base, ".gsd", "milestones", "M001");
    const sliceDir = join(milestoneDir, "slices", "S01");
    mkdirSync(sliceDir, { recursive: true });
    writeFileSync(join(milestoneDir, "M001-ROADMAP.md"), [
      "# M001: Test Milestone",
      "",
      "## Slices",
      "",
      "- [x] **S01: First slice** `risk:low`",
      "",
      "## Boundary Map",
      "",
      "- S01 \u2192 terminal",
      "  - Produces: done",
      "  - Consumes: nothing"
    ].join("\n"));
    writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# Summary\nDone.\n");
    writeFileSync(join(sliceDir, "S01-UAT.md"), "# UAT\nPassed.\n");
    assert.equal(
      verifyExpectedArtifact("complete-slice", "M001/S01", base),
      true,
      "complete-slice should verify when expected artifact and state mutation are already satisfied"
    );
  } finally {
    cleanup(base);
  }
});
test("verifyExpectedArtifact rejects complete-slice when roadmap checkbox is still unchecked", () => {
  const base = makeTmpBase();
  try {
    const milestoneDir = join(base, ".gsd", "milestones", "M001");
    const sliceDir = join(milestoneDir, "slices", "S01");
    mkdirSync(sliceDir, { recursive: true });
    writeFileSync(join(milestoneDir, "M001-ROADMAP.md"), [
      "# M001: Test Milestone",
      "",
      "## Slices",
      "",
      "- [ ] **S01: First slice** `risk:low`",
      "",
      "## Boundary Map",
      "",
      "- S01 \u2192 terminal",
      "  - Produces: done",
      "  - Consumes: nothing"
    ].join("\n"));
    writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# Summary\nDone.\n");
    writeFileSync(join(sliceDir, "S01-UAT.md"), "# UAT\nPassed.\n");
    assert.equal(
      verifyExpectedArtifact("complete-slice", "M001/S01", base),
      false,
      "complete-slice should remain unsatisfied when roadmap state still requires the unit to run"
    );
  } finally {
    cleanup(base);
  }
});
test("verifyExpectedArtifact plan-slice passes when all task plan files exist", () => {
  const base = makeTmpBase();
  try {
    const tasksDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    const planPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md");
    const planContent = [
      "# S01: Test Slice",
      "",
      "## Tasks",
      "",
      "- [ ] **T01: First task** `est:1h`",
      "- [ ] **T02: Second task** `est:2h`"
    ].join("\n");
    writeFileSync(planPath, planContent);
    writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01 Plan\n\nDo the thing.");
    writeFileSync(join(tasksDir, "T02-PLAN.md"), "# T02 Plan\n\nDo the other thing.");
    const result = verifyExpectedArtifact("plan-slice", "M001/S01", base);
    assert.equal(result, true, "should pass when all task plan files exist");
  } finally {
    cleanup(base);
  }
});
test("verifyExpectedArtifact plan-slice fails when a task plan file is missing (#739)", () => {
  const base = makeTmpBase();
  try {
    const tasksDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    const planPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md");
    const planContent = [
      "# S01: Test Slice",
      "",
      "## Tasks",
      "",
      "- [ ] **T01: First task** `est:1h`",
      "- [ ] **T02: Second task** `est:2h`"
    ].join("\n");
    writeFileSync(planPath, planContent);
    writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01 Plan\n\nDo the thing.");
    const result = verifyExpectedArtifact("plan-slice", "M001/S01", base);
    assert.equal(result, false, "should fail when T02-PLAN.md is missing");
  } finally {
    cleanup(base);
  }
});
test("verifyExpectedArtifact plan-slice fails for plan with no tasks (#699)", () => {
  const base = makeTmpBase();
  try {
    const planPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md");
    const planContent = [
      "# S01: Test Slice",
      "",
      "## Goal",
      "",
      "Just some documentation updates, no tasks."
    ].join("\n");
    writeFileSync(planPath, planContent);
    const result = verifyExpectedArtifact("plan-slice", "M001/S01", base);
    assert.equal(result, false, "should fail when plan has no task entries (empty scaffold, #699)");
  } finally {
    cleanup(base);
  }
});
test("verifyExpectedArtifact accepts plan-slice with heading-style tasks (### T01 --)", () => {
  const base = makeTmpBase();
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    const tasksDir = join(sliceDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(sliceDir, "S01-PLAN.md"), [
      "# S01: Test Slice",
      "",
      "## Tasks",
      "",
      "### T01 -- Implement feature",
      "",
      "Feature description.",
      "",
      "### T02 -- Write tests",
      "",
      "Test description."
    ].join("\n"));
    writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01 Plan");
    writeFileSync(join(tasksDir, "T02-PLAN.md"), "# T02 Plan");
    assert.strictEqual(
      verifyExpectedArtifact("plan-slice", "M001/S01", base),
      true,
      "Heading-style plan with task entries should be treated as completed artifact"
    );
  } finally {
    cleanup(base);
  }
});
test("verifyExpectedArtifact accepts plan-slice with colon-style heading tasks (### T01:)", () => {
  const base = makeTmpBase();
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    const tasksDir = join(sliceDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(sliceDir, "S01-PLAN.md"), [
      "# S01: Test Slice",
      "",
      "## Tasks",
      "",
      "### T01: Implement feature",
      "",
      "Feature description."
    ].join("\n"));
    writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01 Plan");
    assert.strictEqual(
      verifyExpectedArtifact("plan-slice", "M001/S01", base),
      true,
      "Colon heading-style plan should be treated as completed artifact"
    );
  } finally {
    cleanup(base);
  }
});
test("verifyExpectedArtifact execute-task requires checked checkbox or DB status for heading-style plan entry (#1691, #3607)", () => {
  const base = makeTmpBase();
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    const tasksDir = join(sliceDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(sliceDir, "S01-PLAN.md"), [
      "# S01: Test Slice",
      "",
      "## Tasks",
      "",
      "### T01 -- Implement feature",
      "",
      "Feature description."
    ].join("\n"));
    writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "# T01 Summary\n\nDone.");
    assert.strictEqual(
      verifyExpectedArtifact("execute-task", "M001/S01/T01", base),
      false,
      "execute-task requires DB status or checked checkbox, not just heading + summary (#3607)"
    );
  } finally {
    cleanup(base);
  }
});
test("#793: invalidateAllCaches clears all caches so deriveState sees fresh disk state", async () => {
  const base = makeTmpBase();
  try {
    const mid = "M001";
    const sid = "S01";
    const planDir = join(base, ".gsd", "milestones", mid, "slices", sid);
    const tasksDir = join(planDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    mkdirSync(join(base, ".gsd", "milestones", mid), { recursive: true });
    writeFileSync(
      join(base, ".gsd", "milestones", mid, `${mid}-ROADMAP.md`),
      `# M001: Test Milestone

**Vision:** test.

## Slices

- [ ] **${sid}: Slice One** \`risk:low\` \`depends:[]\`
  > After this: done.
`
    );
    const planUnchecked = `# ${sid}: Slice One

**Goal:** test.

## Tasks

- [ ] **T01: Task One** \`est:10m\`
- [ ] **T02: Task Two** \`est:10m\`
`;
    writeFileSync(join(planDir, `${sid}-PLAN.md`), planUnchecked);
    writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01: Task One\n\n**Goal:** t\n\n## Steps\n- step\n\n## Verification\n- v\n");
    writeFileSync(join(tasksDir, "T02-PLAN.md"), "# T02: Task Two\n\n**Goal:** t\n\n## Steps\n- step\n\n## Verification\n- v\n");
    const state1 = await deriveState(base);
    assert.equal(state1.activeTask?.id, "T01", "initial: T01 is active");
    const planChecked = `# ${sid}: Slice One

**Goal:** test.

## Tasks

- [x] **T01: Task One** \`est:10m\`
- [ ] **T02: Task Two** \`est:10m\`
`;
    writeFileSync(join(planDir, `${sid}-PLAN.md`), planChecked);
    writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "---\nid: T01\n---\n# Summary\n");
    invalidateStateCache();
    invalidateAllCaches();
    const state2 = await deriveState(base);
    assert.notEqual(state2.activeTask?.id, "T01", "#793: T01 not re-dispatched after full invalidation");
    clearParseCache();
    assert.ok(true, "clearParseCache after invalidateAllCaches is safe");
  } finally {
    cleanup(base);
  }
});
import { execFileSync } from "node:child_process";
function makeGitBase() {
  const base = join(tmpdir(), `gsd-test-git-${randomUUID()}`);
  mkdirSync(base, { recursive: true });
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: base, stdio: "ignore" });
  writeFileSync(join(base, ".gitkeep"), "");
  execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: base, stdio: "ignore" });
  return base;
}
test("hasImplementationArtifacts returns false when only .gsd/ files committed (#1703)", () => {
  const base = makeGitBase();
  try {
    execFileSync("git", ["checkout", "-b", "feat/test-milestone"], { cwd: base, stdio: "ignore" });
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# Roadmap");
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md"), "# Summary");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "chore: add plan files"], { cwd: base, stdio: "ignore" });
    const result = hasImplementationArtifacts(base);
    assert.equal(result, "absent", "should return absent when only .gsd/ files were committed");
  } finally {
    cleanup(base);
  }
});
test("hasImplementationArtifacts returns true when implementation files committed (#1703)", () => {
  const base = makeGitBase();
  try {
    execFileSync("git", ["checkout", "-b", "feat/test-impl"], { cwd: base, stdio: "ignore" });
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# Roadmap");
    mkdirSync(join(base, "src"), { recursive: true });
    writeFileSync(join(base, "src", "feature.ts"), "export function feature() {}");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat: add feature"], { cwd: base, stdio: "ignore" });
    const result = hasImplementationArtifacts(base);
    assert.equal(result, "present", "should return present when implementation files are present");
  } finally {
    cleanup(base);
  }
});
test("hasImplementationArtifacts finds milestone implementation commits after retry resumes on main (#4699)", () => {
  const base = makeGitBase();
  try {
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# Roadmap");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "chore: auto-commit after plan-milestone\n\nGSD-Unit: M001"], { cwd: base, stdio: "ignore" });
    mkdirSync(join(base, "src"), { recursive: true });
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
    writeFileSync(join(base, "src", "feature.ts"), "export function feature() {}");
    writeFileSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md"), "# Summary");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat: add milestone feature\n\nGSD-Task: S01/T01"], { cwd: base, stdio: "ignore" });
    const result = hasImplementationArtifacts(base, "M001");
    assert.equal(result, "present", "main self-diff retry should find production execute-task commits");
  } finally {
    cleanup(base);
  }
});
test("hasImplementationArtifacts rejects milestone-scoped main history with only .gsd commits (#4699)", () => {
  const base = makeGitBase();
  try {
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# Roadmap");
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md"), "# Summary");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "chore: auto-commit after complete-milestone\n\nGSD-Unit: M001"], { cwd: base, stdio: "ignore" });
    const result = hasImplementationArtifacts(base, "M001");
    assert.equal(result, "absent", "milestone-scoped fallback must not treat .gsd-only commits as implementation");
  } finally {
    cleanup(base);
  }
});
test("hasImplementationArtifacts finds integration implementation-only commits when milestone branch diff is .gsd-only", () => {
  const base = makeGitBase();
  try {
    mkdirSync(join(base, "src"), { recursive: true });
    writeFileSync(join(base, "src", "feature.ts"), "export function feature() {}\n");
    execFileSync("git", ["add", "src/feature.ts"], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat: add milestone feature\n\nGSD-Task: S01/T01"], { cwd: base, stdio: "ignore" });
    mkdirSync(join(base, ".gsd"), { recursive: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone One", status: "active" });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      title: "Slice One",
      status: "complete",
      risk: "low",
      depends: []
    });
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Task One",
      status: "complete"
    });
    execFileSync("git", ["checkout", "-b", "milestone/M001"], { cwd: base, stdio: "ignore" });
    writeIntegrationBranch(base, "M001", "main");
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md"), "# Milestone Summary\nDone.");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "chore: auto-commit after complete-milestone\n\nGSD-Unit: M001"], { cwd: base, stdio: "ignore" });
    const result = hasImplementationArtifacts(base, "M001");
    assert.equal(
      result,
      "present",
      ".gsd-only milestone closeout diffs should still honor implementation commits already on the integration branch"
    );
  } finally {
    cleanup(base);
  }
});
test("hasImplementationArtifacts backfills untagged main implementation commits from completed task file hints", () => {
  const base = makeGitBase();
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone One", status: "active" });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      title: "Slice One",
      status: "complete",
      risk: "low",
      depends: []
    });
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Task One",
      status: "complete",
      keyFiles: ["index.html", "style.css", "app.js"],
      planning: { files: ["index.html", "style.css", "app.js"] }
    });
    writeFileSync(join(base, "index.html"), "<main></main>\n");
    writeFileSync(join(base, "style.css"), "main { display: block; }\n");
    writeFileSync(join(base, "app.js"), "document.body.dataset.ready = 'true';\n");
    execFileSync("git", ["add", "index.html", "style.css", "app.js"], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat: add to-do app with CRUD and localStorage persistence"], { cwd: base, stdio: "ignore" });
    const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: base, encoding: "utf-8" }).trim();
    const result = hasImplementationArtifacts(base, "M001");
    assert.equal(
      result,
      "present",
      "completed task file hints should repair prior untagged implementation commits on main"
    );
    assert.deepEqual(getMilestoneCommitAttributionShas("M001"), [commitSha]);
  } finally {
    cleanup(base);
  }
});
test("hasImplementationArtifacts does not backfill untagged commits before milestone creation", () => {
  const base = makeGitBase();
  try {
    writeFileSync(join(base, "app.js"), "document.body.dataset.ready = 'old';\n");
    execFileSync("git", ["add", "app.js"], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat: old app work"], {
      cwd: base,
      stdio: "ignore",
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z"
      }
    });
    mkdirSync(join(base, ".gsd"), { recursive: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone One", status: "active" });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      title: "Slice One",
      status: "complete",
      risk: "low",
      depends: []
    });
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Task One",
      status: "complete",
      keyFiles: ["app.js"],
      planning: { files: ["app.js"] }
    });
    const result = hasImplementationArtifacts(base, "M001");
    assert.equal(result, "absent", "pre-milestone commits must not be attributed to the milestone");
    assert.deepEqual(getMilestoneCommitAttributionShas("M001"), []);
  } finally {
    cleanup(base);
  }
});
test("hasImplementationArtifacts does not backfill unrelated untagged implementation commits", () => {
  const base = makeGitBase();
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone One", status: "active" });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      title: "Slice One",
      status: "complete",
      risk: "low",
      depends: []
    });
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Task One",
      status: "complete",
      keyFiles: ["src/expected.ts"],
      planning: { files: ["src/expected.ts"] }
    });
    mkdirSync(join(base, "src"), { recursive: true });
    writeFileSync(join(base, "src", "unrelated.ts"), "export const unrelated = true;\n");
    execFileSync("git", ["add", "src/unrelated.ts"], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat: unrelated work"], { cwd: base, stdio: "ignore" });
    const result = hasImplementationArtifacts(base, "M001");
    assert.equal(result, "absent", "backfill must require overlap with completed task file hints");
    assert.deepEqual(getMilestoneCommitAttributionShas("M001"), []);
  } finally {
    cleanup(base);
  }
});
test("hasImplementationArtifacts treats empty non-integration branch diff as absent (#4699)", () => {
  const base = makeGitBase();
  try {
    execFileSync("git", ["checkout", "-b", "feat/empty-milestone"], { cwd: base, stdio: "ignore" });
    const result = hasImplementationArtifacts(base, "M001");
    assert.equal(result, "absent", "empty milestone branch diffs should not use main retry fallback");
  } finally {
    cleanup(base);
  }
});
test("hasImplementationArtifacts uses milestone path history instead of rolling depth (#4699)", () => {
  const base = makeGitBase();
  try {
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
    mkdirSync(join(base, "src"), { recursive: true });
    writeFileSync(join(base, "src", "feature.ts"), "export function feature() {}");
    writeFileSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md"), "# Summary");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat: old milestone implementation\n\nGSD-Task: S01/T01"], { cwd: base, stdio: "ignore" });
    mkdirSync(join(base, "docs"), { recursive: true });
    for (let i = 0; i < 205; i++) {
      writeFileSync(join(base, "docs", `note-${i}.md`), `# Note ${i}
`);
      execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", `docs: filler ${i}`], { cwd: base, stdio: "ignore" });
    }
    const result = hasImplementationArtifacts(base, "M001");
    assert.equal(result, "present", "milestone evidence should not age out after 200 unrelated commits");
  } finally {
    cleanup(base);
  }
});
test("hasImplementationArtifacts finds implementation commits when .gsd/ is gitignored (#5033)", () => {
  const base = makeGitBase();
  try {
    writeFileSync(join(base, ".git", "info", "exclude"), ".gsd/\n");
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md"),
      "# Summary"
    );
    mkdirSync(join(base, "benchmarks", "M001"), { recursive: true });
    writeFileSync(join(base, "benchmarks", "M001", "manifest.yaml"), "cases: []\n");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync(
      "git",
      ["commit", "-m", "feat: materialize M001 evidence\n\nGSD-Task: S01/T01"],
      { cwd: base, stdio: "ignore" }
    );
    const result = hasImplementationArtifacts(base, "M001");
    assert.equal(
      result,
      "present",
      "milestone-tagged commit binding must work when .gsd/ is gitignored"
    );
  } finally {
    cleanup(base);
  }
});
test("hasImplementationArtifacts binds GSD-Task trailer to milestone via DB state when .gsd/ is gitignored", () => {
  const base = makeGitBase();
  try {
    writeFileSync(join(base, ".git", "info", "exclude"), ".gsd/\n");
    mkdirSync(join(base, ".gsd"), { recursive: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone One", status: "active" });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      title: "Slice One",
      status: "complete",
      risk: "low",
      depends: []
    });
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Task One",
      status: "complete"
    });
    mkdirSync(join(base, "src"), { recursive: true });
    writeFileSync(join(base, "src", "feature.ts"), "export function feature() {}\n");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync(
      "git",
      ["commit", "-m", "feat: add feature\n\nGSD-Task: S01/T01"],
      { cwd: base, stdio: "ignore" }
    );
    const result = hasImplementationArtifacts(base, "M001");
    assert.equal(
      result,
      "present",
      "DB task ownership should bind S01/T01 implementation commits to M001 without explicit M001 text"
    );
  } finally {
    cleanup(base);
  }
});
test("hasImplementationArtifacts does not bind GSD-Task trailer without milestone ownership evidence", () => {
  const base = makeGitBase();
  try {
    writeFileSync(join(base, ".git", "info", "exclude"), ".gsd/\n");
    mkdirSync(join(base, "src"), { recursive: true });
    writeFileSync(join(base, "src", "feature.ts"), "export function feature() {}\n");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync(
      "git",
      ["commit", "-m", "feat: add feature\n\nGSD-Task: S01/T01"],
      { cwd: base, stdio: "ignore" }
    );
    const result = hasImplementationArtifacts(base, "M001");
    assert.equal(
      result,
      "absent",
      "S01/T01 shape alone must not bind an implementation commit to M001"
    );
  } finally {
    cleanup(base);
  }
});
test("hasImplementationArtifacts ignores malformed milestone IDs in commit-message fallback", () => {
  const base = makeGitBase();
  try {
    writeFileSync(join(base, ".git", "info", "exclude"), ".gsd/\n");
    mkdirSync(join(base, "src"), { recursive: true });
    writeFileSync(join(base, "src", "feature.ts"), "export function feature() {}\n");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync(
      "git",
      ["commit", "-m", "feat: materialize M001(foo evidence\n\nGSD-Task: S01/T01"],
      { cwd: base, stdio: "ignore" }
    );
    const result = hasImplementationArtifacts(base, "M001(");
    assert.equal(
      result,
      "absent",
      "malformed milestone IDs must not bind implementation commits through message scanning"
    );
  } finally {
    cleanup(base);
  }
});
test("hasImplementationArtifacts returns true on non-git directory (fail-open)", () => {
  const base = join(tmpdir(), `gsd-test-nogit-${randomUUID()}`);
  mkdirSync(base, { recursive: true });
  try {
    const result = hasImplementationArtifacts(base);
    assert.equal(result, "unknown", "should return unknown (fail-open) in non-git directory");
  } finally {
    cleanup(base);
  }
});
test("verifyExpectedArtifact complete-milestone fails with only .gsd/ files (#1703)", () => {
  const base = makeGitBase();
  try {
    execFileSync("git", ["checkout", "-b", "feat/ms-only-gsd"], { cwd: base, stdio: "ignore" });
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md"), "# Milestone Summary\nDone.");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "chore: milestone plan files"], { cwd: base, stdio: "ignore" });
    const result = verifyExpectedArtifact("complete-milestone", "M001", base);
    assert.equal(result, false, "complete-milestone should fail verification when only .gsd/ files present");
  } finally {
    cleanup(base);
  }
});
test("verifyExpectedArtifact complete-milestone passes with impl files (#1703)", () => {
  const base = makeGitBase();
  try {
    execFileSync("git", ["checkout", "-b", "feat/ms-with-impl"], { cwd: base, stdio: "ignore" });
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md"), "# Milestone Summary\nDone.");
    mkdirSync(join(base, "src"), { recursive: true });
    writeFileSync(join(base, "src", "app.ts"), "console.log('hello');");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat: implementation"], { cwd: base, stdio: "ignore" });
    const result = verifyExpectedArtifact("complete-milestone", "M001", base);
    assert.equal(result, true, "complete-milestone should pass verification with implementation files");
  } finally {
    cleanup(base);
  }
});
test("verifyExpectedArtifact complete-milestone passes on main retry with milestone implementation commits (#4699)", () => {
  const base = makeGitBase();
  try {
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md"), "# Milestone Summary\nDone.");
    mkdirSync(join(base, "src"), { recursive: true });
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
    writeFileSync(join(base, "src", "app.ts"), "console.log('hello');");
    writeFileSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md"), "# Summary");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat: implementation already on main\n\nGSD-Task: S01/T01"], { cwd: base, stdio: "ignore" });
    const result = verifyExpectedArtifact("complete-milestone", "M001", base);
    assert.equal(result, true, "complete-milestone should not fail solely because HEAD vs main is a self-diff");
  } finally {
    cleanup(base);
  }
});
test("verifyExpectedArtifact complete-milestone fails when DB milestone is not complete (#4658)", () => {
  const base = makeGitBase();
  try {
    execFileSync("git", ["checkout", "-b", "feat/ms-db-active"], { cwd: base, stdio: "ignore" });
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md"), "# Milestone Summary\nverification FAILED \u2014 not complete.");
    mkdirSync(join(base, "src"), { recursive: true });
    writeFileSync(join(base, "src", "app.ts"), "console.log('hello');");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat: implementation with failed summary"], { cwd: base, stdio: "ignore" });
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone One", status: "active" });
    const result = verifyExpectedArtifact("complete-milestone", "M001", base);
    assert.equal(result, false, "complete-milestone must fail when DB status is not complete");
  } finally {
    cleanup(base);
  }
});
test("verifyExpectedArtifact complete-milestone passes when DB milestone is complete (#4658)", () => {
  const base = makeGitBase();
  try {
    execFileSync("git", ["checkout", "-b", "feat/ms-db-complete"], { cwd: base, stdio: "ignore" });
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md"), "# Milestone Summary\nDone.");
    mkdirSync(join(base, "src"), { recursive: true });
    writeFileSync(join(base, "src", "app.ts"), "console.log('hello');");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat: implementation complete"], { cwd: base, stdio: "ignore" });
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone One", status: "complete" });
    const result = verifyExpectedArtifact("complete-milestone", "M001", base);
    assert.equal(result, true, "complete-milestone should pass when DB status is complete");
  } finally {
    cleanup(base);
  }
});
test("verifyExpectedArtifact complete-milestone tolerates transient DB lag when SUMMARY is canonical success (#4658)", () => {
  const base = makeGitBase();
  try {
    execFileSync("git", ["checkout", "-b", "feat/ms-db-lag-success"], { cwd: base, stdio: "ignore" });
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md"),
      [
        "---",
        "id: M001",
        "status: complete",
        "---",
        "",
        "# M001: Success"
      ].join("\n")
    );
    mkdirSync(join(base, "src"), { recursive: true });
    writeFileSync(join(base, "src", "app.ts"), "console.log('hello');");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat: implementation with stale db"], { cwd: base, stdio: "ignore" });
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone One", status: "active" });
    const result = verifyExpectedArtifact("complete-milestone", "M001", base);
    assert.equal(result, true, "canonical success SUMMARY should pass verification during transient DB lag");
  } finally {
    cleanup(base);
  }
});
test("verifyExpectedArtifact checks pending gate-evaluate artifacts without ESM require failures", () => {
  const base = makeTmpProject();
  const verified = verifyExpectedArtifact("gate-evaluate", "M001/S01/gates+Q3", base);
  assert.equal(verified, false, "pending gates should keep gate-evaluate unverified");
});
test("#4414: writeBlockerPlaceholder invalidates path cache so dispatch guard sees file", () => {
  const base = makeTmpBase();
  try {
    invalidateAllCaches();
    assert.equal(
      resolveMilestoneFile(base, "M001", "RESEARCH"),
      null,
      "no RESEARCH file yet"
    );
    const result = writeBlockerPlaceholder(
      "research-milestone",
      "M001",
      base,
      "verification retries exhausted"
    );
    assert.ok(result, "placeholder path returned");
    const postResolve = resolveMilestoneFile(base, "M001", "RESEARCH");
    assert.ok(
      postResolve,
      "resolveMilestoneFile finds the placeholder post-write (cache invalidated)"
    );
  } finally {
    cleanup(base);
  }
});
test("#4414: parallel-research sentinel path does not collide with RESEARCH suffix", () => {
  const base = makeTmpBase();
  try {
    const sentinel = resolveExpectedArtifactPath(
      "research-slice",
      "M001/parallel-research",
      base
    );
    assert.ok(sentinel, "sentinel path resolves for parallel-research");
    writeFileSync(sentinel, "# blocker\n", "utf-8");
    const milestoneResearch = resolveMilestoneFile(base, "M001", "RESEARCH");
    assert.equal(
      milestoneResearch,
      null,
      "sentinel must not be mistaken for M001-RESEARCH.md via legacy pattern match"
    );
  } finally {
    cleanup(base);
  }
});
test("#4068: verifyExpectedArtifact parallel-research treats PARALLEL-BLOCKER as terminal completion", () => {
  const base = makeTmpBase();
  try {
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
      [
        "# M001: Timeout Test",
        "",
        "## Slices",
        "",
        "- [ ] **S01: Alpha** `risk:low` `depends:[]`",
        "- [ ] **S02: Beta** `risk:low` `depends:[]`",
        ""
      ].join("\n"),
      "utf-8"
    );
    clearParseCache();
    invalidateAllCaches();
    const blockerPath = resolveExpectedArtifactPath("research-slice", "M001/parallel-research", base);
    assert.ok(blockerPath, "PARALLEL-BLOCKER path must resolve for parallel-research unit");
    writeFileSync(blockerPath, "# BLOCKER \u2014 timeout recovery\n\n**Reason**: hard timeout.\n", "utf-8");
    clearParseCache();
    invalidateAllCaches();
    assert.equal(
      verifyExpectedArtifact("research-slice", "M001/parallel-research", base),
      true,
      "#4068: PARALLEL-BLOCKER on disk must satisfy verifyExpectedArtifact so the loop does not re-dispatch"
    );
  } finally {
    cleanup(base);
  }
});
test("#4414: verifyExpectedArtifact parallel-research succeeds when all research-ready slices have RESEARCH", () => {
  const base = makeTmpBase();
  try {
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S02", "tasks"), { recursive: true });
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S03", "tasks"), { recursive: true });
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
      [
        "# M001: Regression",
        "",
        "## Slices",
        "",
        "- [ ] **S01: Alpha** `risk:low` `depends:[]`",
        "- [ ] **S02: Beta** `risk:low` `depends:[]`",
        "- [ ] **S03: Gamma** `risk:low` `depends:[]`",
        ""
      ].join("\n"),
      "utf-8"
    );
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-RESEARCH.md"),
      "# research",
      "utf-8"
    );
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "slices", "S02", "S02-RESEARCH.md"),
      "# research",
      "utf-8"
    );
    clearParseCache();
    invalidateAllCaches();
    assert.equal(
      verifyExpectedArtifact("research-slice", "M001/parallel-research", base),
      false,
      "missing S03 RESEARCH \u2192 verification fails"
    );
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "slices", "S03", "S03-RESEARCH.md"),
      "# research",
      "utf-8"
    );
    clearParseCache();
    invalidateAllCaches();
    assert.equal(
      verifyExpectedArtifact("research-slice", "M001/parallel-research", base),
      true,
      "all slices have RESEARCH \u2192 verification passes"
    );
  } finally {
    cleanup(base);
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9hdXRvLXJlY292ZXJ5LnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0ZXN0LCB7IGFmdGVyRWFjaCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jLCBleGlzdHNTeW5jLCByZWFkRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSBcIm5vZGU6Y3J5cHRvXCI7XG5cbmltcG9ydCB7IHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QsIGhhc0ltcGxlbWVudGF0aW9uQXJ0aWZhY3RzLCByZXNvbHZlRXhwZWN0ZWRBcnRpZmFjdFBhdGgsIGRpYWdub3NlRXhwZWN0ZWRBcnRpZmFjdCwgZGlhZ25vc2VXb3JrdHJlZUludGVncml0eUZhaWx1cmUsIGJ1aWxkTG9vcFJlbWVkaWF0aW9uU3RlcHMsIHdyaXRlQmxvY2tlclBsYWNlaG9sZGVyLCByZWZyZXNoUmVjb3ZlcnlEYkZvckFydGlmYWN0IH0gZnJvbSBcIi4uL2F1dG8tcmVjb3ZlcnkudHNcIjtcbmltcG9ydCB7IHJlc29sdmVNaWxlc3RvbmVGaWxlIH0gZnJvbSBcIi4uL3BhdGhzLnRzXCI7XG5pbXBvcnQgeyBvcGVuRGF0YWJhc2UsIGNsb3NlRGF0YWJhc2UsIGluc2VydE1pbGVzdG9uZSwgaW5zZXJ0U2xpY2UsIGluc2VydEdhdGVSb3csIGluc2VydFRhc2ssIGdldE1pbGVzdG9uZUNvbW1pdEF0dHJpYnV0aW9uU2hhcyB9IGZyb20gXCIuLi9nc2QtZGIudHNcIjtcbmltcG9ydCB7IGNsZWFyUGFyc2VDYWNoZSB9IGZyb20gXCIuLi9maWxlcy50c1wiO1xuaW1wb3J0IHsgcGFyc2VSb2FkbWFwIH0gZnJvbSBcIi4uL3BhcnNlcnMtbGVnYWN5LnRzXCI7XG5pbXBvcnQgeyBpbnZhbGlkYXRlQWxsQ2FjaGVzIH0gZnJvbSBcIi4uL2NhY2hlLnRzXCI7XG5pbXBvcnQgeyBkZXJpdmVTdGF0ZSwgaW52YWxpZGF0ZVN0YXRlQ2FjaGUgfSBmcm9tIFwiLi4vc3RhdGUudHNcIjtcbmltcG9ydCB7IHdyaXRlSW50ZWdyYXRpb25CcmFuY2ggfSBmcm9tIFwiLi4vZ2l0LXNlcnZpY2UudHNcIjtcblxuY29uc3QgdG1wRGlyczogc3RyaW5nW10gPSBbXTtcblxuZnVuY3Rpb24gbWFrZVRtcEJhc2UoKTogc3RyaW5nIHtcbiAgY29uc3QgYmFzZSA9IGpvaW4odG1wZGlyKCksIGBnc2QtdGVzdC0ke3JhbmRvbVVVSUQoKX1gKTtcbiAgLy8gQ3JlYXRlIC5nc2QvbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvdGFza3MvIHN0cnVjdHVyZVxuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiLCBcInRhc2tzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgcmV0dXJuIGJhc2U7XG59XG5cbmZ1bmN0aW9uIGNsZWFudXAoYmFzZTogc3RyaW5nKTogdm9pZCB7XG4gIHRyeSB7IHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0gY2F0Y2ggeyAvKiAqLyB9XG59XG5cbmZ1bmN0aW9uIG1ha2VUbXBQcm9qZWN0KCk6IHN0cmluZyB7XG4gIGNvbnN0IGRpciA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiYXV0by1yZWNvdmVyeS1cIikpO1xuICBta2RpclN5bmMoam9pbihkaXIsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIG9wZW5EYXRhYmFzZShqb2luKGRpciwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpKTtcbiAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0IE1pbGVzdG9uZVwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSk7XG4gIGluc2VydFNsaWNlKHtcbiAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgaWQ6IFwiUzAxXCIsXG4gICAgdGl0bGU6IFwiVGVzdCBTbGljZVwiLFxuICAgIHN0YXR1czogXCJwZW5kaW5nXCIsXG4gICAgcmlzazogXCJsb3dcIixcbiAgICBkZXBlbmRzOiBbXSxcbiAgfSk7XG4gIGluc2VydEdhdGVSb3coeyBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHNsaWNlSWQ6IFwiUzAxXCIsIGdhdGVJZDogXCJRM1wiLCBzY29wZTogXCJzbGljZVwiIH0pO1xuICB0bXBEaXJzLnB1c2goZGlyKTtcbiAgcmV0dXJuIGRpcjtcbn1cblxuYWZ0ZXJFYWNoKCgpID0+IHtcbiAgY2xvc2VEYXRhYmFzZSgpO1xuICBmb3IgKGNvbnN0IGRpciBvZiB0bXBEaXJzKSB7XG4gICAgdHJ5IHtcbiAgICAgIHJtU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIEJlc3QtZWZmb3J0IGNsZWFudXAgb25seS5cbiAgICB9XG4gIH1cbiAgdG1wRGlycy5sZW5ndGggPSAwO1xufSk7XG5cbnRlc3QoXCJyZXNvbHZlRXhwZWN0ZWRBcnRpZmFjdFBhdGggcmV0dXJucyBjb3JyZWN0IHBhdGggZm9yIGV4ZWN1dGUtdGFza1wiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVFeHBlY3RlZEFydGlmYWN0UGF0aChcImV4ZWN1dGUtdGFza1wiLCBcIk0wMDEvUzAxL1QwMVwiLCBiYXNlKTtcbiAgICBhc3NlcnQub2socmVzdWx0KTtcbiAgICBhc3NlcnQub2socmVzdWx0IS5pbmNsdWRlcyhcInRhc2tzXCIpKTtcbiAgICBhc3NlcnQub2socmVzdWx0IS5pbmNsdWRlcyhcIlNVTU1BUllcIikpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwicmVzb2x2ZUV4cGVjdGVkQXJ0aWZhY3RQYXRoIHJldHVybnMgY29ycmVjdCBwYXRoIGZvciBjb21wbGV0ZS1zbGljZVwiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVFeHBlY3RlZEFydGlmYWN0UGF0aChcImNvbXBsZXRlLXNsaWNlXCIsIFwiTTAwMS9TMDFcIiwgYmFzZSk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdCk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdCEuaW5jbHVkZXMoXCJTVU1NQVJZXCIpKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcInJlc29sdmVFeHBlY3RlZEFydGlmYWN0UGF0aCByZXR1cm5zIGNvcnJlY3QgcGF0aCBmb3IgcGxhbi1zbGljZVwiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVFeHBlY3RlZEFydGlmYWN0UGF0aChcInBsYW4tc2xpY2VcIiwgXCJNMDAxL1MwMVwiLCBiYXNlKTtcbiAgICBhc3NlcnQub2socmVzdWx0KTtcbiAgICBhc3NlcnQub2socmVzdWx0IS5pbmNsdWRlcyhcIlBMQU5cIikpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwicGxhbi1zbGljZSBhcnRpZmFjdCByZXNvbHV0aW9uIGhhbmRsZXMgbG93ZXJjYXNlIHVuaXQgSURzIGFnYWluc3QgdXBwZXJjYXNlIHBhdGhzXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgY29uc3Qgc2xpY2VEaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIpO1xuICAgIGNvbnN0IHRhc2tzRGlyID0gam9pbihzbGljZURpciwgXCJ0YXNrc1wiKTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oc2xpY2VEaXIsIFwiUzAxLVBMQU4ubWRcIiksIFtcbiAgICAgIFwiIyBTMDE6IFRlc3QgU2xpY2VcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFRhc2tzXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCItIFsgXSAqKlQwMTogSW1wbGVtZW50IGZlYXR1cmUqKiBgZXN0OjFoYFwiLFxuICAgIF0uam9pbihcIlxcblwiKSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHRhc2tzRGlyLCBcIlQwMS1QTEFOLm1kXCIpLCBcIiMgVDAxIFBsYW5cIik7XG5cbiAgICBjb25zdCBhcnRpZmFjdFBhdGggPSByZXNvbHZlRXhwZWN0ZWRBcnRpZmFjdFBhdGgoXCJwbGFuLXNsaWNlXCIsIFwibTAwMS9zMDFcIiwgYmFzZSk7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgYXJ0aWZhY3RQYXRoPy5lbmRzV2l0aChcIi5nc2QvbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvUzAxLVBMQU4ubWRcIiksXG4gICAgICBcImxvd2VyY2FzZSB1bml0IElEcyBzaG91bGQgcmVzb2x2ZSB0byB0aGUgZXhpc3RpbmcgdXBwZXJjYXNlIGFydGlmYWN0IHBhdGhcIixcbiAgICApO1xuXG4gICAgY29uc3QgZGlhZ25vc3RpYyA9IGRpYWdub3NlRXhwZWN0ZWRBcnRpZmFjdChcInBsYW4tc2xpY2VcIiwgXCJtMDAxL3MwMVwiLCBiYXNlKTtcbiAgICBhc3NlcnQub2soXG4gICAgICBkaWFnbm9zdGljPy5pbmNsdWRlcyhcIi5nc2QvbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvUzAxLVBMQU4ubWRcIiksXG4gICAgICBcImRpYWdub3N0aWMgc2hvdWxkIHJlcG9ydCB0aGUgZXhpc3RpbmcgdXBwZXJjYXNlIGFydGlmYWN0IHBhdGhcIixcbiAgICApO1xuICAgIGFzc2VydC5vayhcbiAgICAgIGRpYWdub3N0aWM/LmluY2x1ZGVzKFwidGFzayBwbGFuc1wiKSxcbiAgICAgIFwiZGlhZ25vc3RpYyBzaG91bGQgbWVudGlvbiB0YXNrIHBsYW5zIGJlY2F1c2Ugc2xpY2UgcGxhbiBhbG9uZSBpcyBpbnN1ZmZpY2llbnRcIixcbiAgICApO1xuXG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgdmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdChcInBsYW4tc2xpY2VcIiwgXCJtMDAxL3MwMVwiLCBiYXNlKSxcbiAgICAgIHRydWUsXG4gICAgICBcInZlcmlmaWNhdGlvbiBzaG91bGQgcGFzcyB3aGVuIHRoZSB1cHBlcmNhc2Ugc2xpY2UgcGxhbiBhbmQgdGFzayBwbGFucyBleGlzdFwiLFxuICAgICk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJyZXNvbHZlRXhwZWN0ZWRBcnRpZmFjdFBhdGggcmV0dXJucyBudWxsIGZvciB1bmtub3duIHR5cGVcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXN1bHQgPSByZXNvbHZlRXhwZWN0ZWRBcnRpZmFjdFBhdGgoXCJ1bmtub3duLXR5cGVcIiwgXCJNMDAxXCIsIGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIG51bGwpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZGlhZ25vc2VXb3JrdHJlZUludGVncml0eUZhaWx1cmUgcmVwb3J0cyBtaXNzaW5nIEdTRCB3b3JrdHJlZSBwYXRocyBvbmx5XCIsICgpID0+IHtcbiAgY29uc3QgbWlzc2luZ1dvcmt0cmVlUGF0aCA9IGpvaW4odG1wZGlyKCksIGBnc2QtdGVzdC0ke3JhbmRvbVVVSUQoKX1gLCBcIi5nc2RcIiwgXCJ3b3JrdHJlZXNcIiwgXCJNMDAxLVMwMVwiKTtcbiAgYXNzZXJ0LmVxdWFsKFxuICAgIGRpYWdub3NlV29ya3RyZWVJbnRlZ3JpdHlGYWlsdXJlKGpvaW4odG1wZGlyKCksIGBnc2QtdGVzdC0ke3JhbmRvbVVVSUQoKX1gKSksXG4gICAgbnVsbCxcbiAgICBcIm5vbi1HU0QgcGF0aHMgc2hvdWxkIGtlZXAgZmFsbGluZyB0aHJvdWdoIHRvIGFydGlmYWN0IHJlY292ZXJ5XCIsXG4gICk7XG4gIGFzc2VydC5lcXVhbChcbiAgICBkaWFnbm9zZVdvcmt0cmVlSW50ZWdyaXR5RmFpbHVyZShtaXNzaW5nV29ya3RyZWVQYXRoKSxcbiAgICBgV29ya3RyZWUgaW50ZWdyaXR5IGZhaWx1cmU6ICR7bWlzc2luZ1dvcmt0cmVlUGF0aH0gZG9lcyBub3QgZXhpc3QuIFJlcGFpciBvciByZWNyZWF0ZSB0aGUgd29ya3RyZWUgYmVmb3JlIHJldHJ5aW5nLmAsXG4gICAgXCJtaXNzaW5nIEdTRCB3b3JrdHJlZSBwYXRocyBzaG91bGQgZmFpbCB0ZXJtaW5hbGx5IGJlZm9yZSBhcnRpZmFjdCByZXRyeVwiLFxuICApO1xufSk7XG5cbnRlc3QoXCJyZXNvbHZlRXhwZWN0ZWRBcnRpZmFjdFBhdGggcmV0dXJucyBjb3JyZWN0IHBhdGggZm9yIGFsbCBtaWxlc3RvbmUtbGV2ZWwgdHlwZXNcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBjb25zdCBwbGFuUmVzdWx0ID0gcmVzb2x2ZUV4cGVjdGVkQXJ0aWZhY3RQYXRoKFwicGxhbi1taWxlc3RvbmVcIiwgXCJNMDAxXCIsIGJhc2UpO1xuICAgIGFzc2VydC5vayhwbGFuUmVzdWx0KTtcbiAgICBhc3NlcnQub2socGxhblJlc3VsdCEuaW5jbHVkZXMoXCJST0FETUFQXCIpKTtcblxuICAgIGNvbnN0IGNvbXBsZXRlUmVzdWx0ID0gcmVzb2x2ZUV4cGVjdGVkQXJ0aWZhY3RQYXRoKFwiY29tcGxldGUtbWlsZXN0b25lXCIsIFwiTTAwMVwiLCBiYXNlKTtcbiAgICBhc3NlcnQub2soY29tcGxldGVSZXN1bHQpO1xuICAgIGFzc2VydC5vayhjb21wbGV0ZVJlc3VsdCEuaW5jbHVkZXMoXCJTVU1NQVJZXCIpKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcInJlc29sdmVFeHBlY3RlZEFydGlmYWN0UGF0aCByZXR1cm5zIGNvcnJlY3QgcGF0aCBmb3IgYWxsIHNsaWNlLWxldmVsIHR5cGVzXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzZWFyY2hSZXN1bHQgPSByZXNvbHZlRXhwZWN0ZWRBcnRpZmFjdFBhdGgoXCJyZXNlYXJjaC1zbGljZVwiLCBcIk0wMDEvUzAxXCIsIGJhc2UpO1xuICAgIGFzc2VydC5vayhyZXNlYXJjaFJlc3VsdCk7XG4gICAgYXNzZXJ0Lm9rKHJlc2VhcmNoUmVzdWx0IS5pbmNsdWRlcyhcIlJFU0VBUkNIXCIpKTtcblxuICAgIGNvbnN0IGFzc2Vzc1Jlc3VsdCA9IHJlc29sdmVFeHBlY3RlZEFydGlmYWN0UGF0aChcInJlYXNzZXNzLXJvYWRtYXBcIiwgXCJNMDAxL1MwMVwiLCBiYXNlKTtcbiAgICBhc3NlcnQub2soYXNzZXNzUmVzdWx0KTtcbiAgICBhc3NlcnQub2soYXNzZXNzUmVzdWx0IS5pbmNsdWRlcyhcIkFTU0VTU01FTlRcIikpO1xuXG4gICAgY29uc3QgdWF0UmVzdWx0ID0gcmVzb2x2ZUV4cGVjdGVkQXJ0aWZhY3RQYXRoKFwicnVuLXVhdFwiLCBcIk0wMDEvUzAxXCIsIGJhc2UpO1xuICAgIGFzc2VydC5vayh1YXRSZXN1bHQpO1xuICAgIGFzc2VydC5vayh1YXRSZXN1bHQhLmluY2x1ZGVzKFwiQVNTRVNTTUVOVFwiKSk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJyZWZyZXNoUmVjb3ZlcnlEYkZvckFydGlmYWN0IHRyZWF0cyBtaXNzaW5nIGV4ZWN1dGUtdGFzayBEQiByb3dzIGFzIGZhdGFsIG1pc21hdGNoZXNcIiwgKCkgPT4ge1xuICBtYWtlVG1wUHJvamVjdCgpO1xuXG4gIGNvbnN0IHJlc3VsdCA9IHJlZnJlc2hSZWNvdmVyeURiRm9yQXJ0aWZhY3QoXCJleGVjdXRlLXRhc2tcIiwgXCJNMDAxL1MwMS9UMDFcIik7XG5cbiAgYXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQsIHtcbiAgICBvazogZmFsc2UsXG4gICAgZmF0YWw6IHRydWUsXG4gICAgcmVhc29uOiBcImV4ZWN1dGUtdGFzay1hcnRpZmFjdC1kYi1taXNzaW5nXCIsXG4gICAgbWVzc2FnZTogXCJTdHVjayByZWNvdmVyeSBmb3VuZCBleGVjdXRlLXRhc2sgTTAwMS9TMDEvVDAxIGFydGlmYWN0cywgYnV0IG5vIG1hdGNoaW5nIERCIHRhc2sgcm93IGV4aXN0cyBhZnRlciByZWZyZXNoLlwiLFxuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgZGlhZ25vc2VFeHBlY3RlZEFydGlmYWN0IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiZGlhZ25vc2VFeHBlY3RlZEFydGlmYWN0IHJldHVybnMgZGVzY3JpcHRpb24gZm9yIGtub3duIHR5cGVzXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzZWFyY2ggPSBkaWFnbm9zZUV4cGVjdGVkQXJ0aWZhY3QoXCJyZXNlYXJjaC1taWxlc3RvbmVcIiwgXCJNMDAxXCIsIGJhc2UpO1xuICAgIGFzc2VydC5vayhyZXNlYXJjaCk7XG4gICAgYXNzZXJ0Lm9rKHJlc2VhcmNoIS5pbmNsdWRlcyhcInJlc2VhcmNoXCIpKTtcblxuICAgIGNvbnN0IHBsYW4gPSBkaWFnbm9zZUV4cGVjdGVkQXJ0aWZhY3QoXCJwbGFuLXNsaWNlXCIsIFwiTTAwMS9TMDFcIiwgYmFzZSk7XG4gICAgYXNzZXJ0Lm9rKHBsYW4pO1xuICAgIGFzc2VydC5vayhwbGFuIS5pbmNsdWRlcyhcInBsYW5cIikpO1xuXG4gICAgY29uc3QgdGFzayA9IGRpYWdub3NlRXhwZWN0ZWRBcnRpZmFjdChcImV4ZWN1dGUtdGFza1wiLCBcIk0wMDEvUzAxL1QwMVwiLCBiYXNlKTtcbiAgICBhc3NlcnQub2sodGFzayk7XG4gICAgYXNzZXJ0Lm9rKHRhc2shLmluY2x1ZGVzKFwiVDAxXCIpKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcImRpYWdub3NlRXhwZWN0ZWRBcnRpZmFjdCByZXR1cm5zIG51bGwgZm9yIHVua25vd24gdHlwZVwiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIGFzc2VydC5lcXVhbChkaWFnbm9zZUV4cGVjdGVkQXJ0aWZhY3QoXCJ1bmtub3duXCIsIFwiTTAwMVwiLCBiYXNlKSwgbnVsbCk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBidWlsZExvb3BSZW1lZGlhdGlvblN0ZXBzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiYnVpbGRMb29wUmVtZWRpYXRpb25TdGVwcyByZXR1cm5zIHN0ZXBzIGZvciBleGVjdXRlLXRhc2tcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBjb25zdCBzdGVwcyA9IGJ1aWxkTG9vcFJlbWVkaWF0aW9uU3RlcHMoXCJleGVjdXRlLXRhc2tcIiwgXCJNMDAxL1MwMS9UMDFcIiwgYmFzZSk7XG4gICAgYXNzZXJ0Lm9rKHN0ZXBzKTtcbiAgICBhc3NlcnQub2soc3RlcHMhLmluY2x1ZGVzKFwiVDAxXCIpKTtcbiAgICBhc3NlcnQub2soc3RlcHMhLmluY2x1ZGVzKFwiZ3NkIHVuZG8tdGFza1wiKSk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJidWlsZExvb3BSZW1lZGlhdGlvblN0ZXBzIHJldHVybnMgc3RlcHMgZm9yIHBsYW4tc2xpY2VcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBjb25zdCBzdGVwcyA9IGJ1aWxkTG9vcFJlbWVkaWF0aW9uU3RlcHMoXCJwbGFuLXNsaWNlXCIsIFwiTTAwMS9TMDFcIiwgYmFzZSk7XG4gICAgYXNzZXJ0Lm9rKHN0ZXBzKTtcbiAgICBhc3NlcnQub2soc3RlcHMhLmluY2x1ZGVzKFwiUExBTlwiKSk7XG4gICAgYXNzZXJ0Lm9rKHN0ZXBzIS5pbmNsdWRlcyhcImdzZCByZWNvdmVyXCIpKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcImJ1aWxkTG9vcFJlbWVkaWF0aW9uU3RlcHMgcmV0dXJucyBzdGVwcyBmb3IgY29tcGxldGUtc2xpY2VcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBjb25zdCBzdGVwcyA9IGJ1aWxkTG9vcFJlbWVkaWF0aW9uU3RlcHMoXCJjb21wbGV0ZS1zbGljZVwiLCBcIk0wMDEvUzAxXCIsIGJhc2UpO1xuICAgIGFzc2VydC5vayhzdGVwcyk7XG4gICAgYXNzZXJ0Lm9rKHN0ZXBzIS5pbmNsdWRlcyhcIlMwMVwiKSk7XG4gICAgYXNzZXJ0Lm9rKHN0ZXBzIS5pbmNsdWRlcyhcImdzZCByZXNldC1zbGljZVwiKSk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJidWlsZExvb3BSZW1lZGlhdGlvblN0ZXBzIHJldHVybnMgbnVsbCBmb3IgdW5rbm93biB0eXBlXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgYXNzZXJ0LmVxdWFsKGJ1aWxkTG9vcFJlbWVkaWF0aW9uU3RlcHMoXCJ1bmtub3duXCIsIFwiTTAwMVwiLCBiYXNlKSwgbnVsbCk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0OiBwYXJzZSBjYWNoZSBjb2xsaXNpb24gcmVncmVzc2lvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcInZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QgZGV0ZWN0cyByb2FkbWFwIFt4XSBjaGFuZ2UgZGVzcGl0ZSBwYXJzZSBjYWNoZVwiLCAoKSA9PiB7XG4gIC8vIFJlZ3Jlc3Npb24gdGVzdDogY2FjaGVLZXkgY29sbGlzaW9uIHdoZW4gWyBdIFx1MjE5MiBbeF0gZG9lc24ndCBjaGFuZ2VcbiAgLy8gZmlsZSBsZW5ndGggb3IgZmlyc3QvbGFzdCAxMDAgY2hhcnMuIFdpdGhvdXQgdGhlIGZpeCwgcGFyc2VSb2FkbWFwXG4gIC8vIHJldHVybnMgc3RhbGUgY2FjaGVkIGRhdGEgd2l0aCBkb25lPWZhbHNlIGV2ZW4gdGhvdWdoIHRoZSBmaWxlIGhhcyBbeF0uXG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIC8vIEJ1aWxkIGEgcm9hZG1hcCBsb25nIGVub3VnaCB0aGF0IHRoZSBbeF0gY2hhbmdlIGlzIG91dHNpZGUgdGhlIGZpcnN0L2xhc3QgMTAwIGNoYXJzXG4gICAgY29uc3QgcGFkZGluZyA9IFwiQVwiLnJlcGVhdCgyMDApO1xuICAgIGNvbnN0IHJvYWRtYXBCZWZvcmUgPSBbXG4gICAgICBgIyBNMDAxOiBUZXN0IE1pbGVzdG9uZSAke3BhZGRpbmd9YCxcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFNsaWNlc1wiLFxuICAgICAgXCJcIixcbiAgICAgIFwiLSBbIF0gKipTMDE6IEZpcnN0IHNsaWNlKiogYHJpc2s6bG93YFwiLFxuICAgICAgXCJcIixcbiAgICAgIGAjIyBGb290ZXIgJHtwYWRkaW5nfWAsXG4gICAgXS5qb2luKFwiXFxuXCIpO1xuICAgIGNvbnN0IHJvYWRtYXBBZnRlciA9IHJvYWRtYXBCZWZvcmUucmVwbGFjZShcIi0gWyBdICoqUzAxOlwiLCBcIi0gW3hdICoqUzAxOlwiKTtcblxuICAgIC8vIFZlcmlmeSBsZW5ndGhzIGFyZSBpZGVudGljYWwgKHRoZSBrZXkgY29sbGlzaW9uIGNvbmRpdGlvbilcbiAgICBhc3NlcnQuZXF1YWwocm9hZG1hcEJlZm9yZS5sZW5ndGgsIHJvYWRtYXBBZnRlci5sZW5ndGgpO1xuXG4gICAgLy8gUG9wdWxhdGUgcGFyc2UgY2FjaGUgd2l0aCB0aGUgcHJlLWVkaXQgcm9hZG1hcFxuICAgIGNvbnN0IGJlZm9yZSA9IHBhcnNlUm9hZG1hcChyb2FkbWFwQmVmb3JlKTtcbiAgICBjb25zdCBzbGljZUJlZm9yZSA9IGJlZm9yZS5zbGljZXMuZmluZChzID0+IHMuaWQgPT09IFwiUzAxXCIpO1xuICAgIGFzc2VydC5vayhzbGljZUJlZm9yZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHNsaWNlQmVmb3JlIS5kb25lLCBmYWxzZSk7XG5cbiAgICAvLyBOb3cgd3JpdGUgdGhlIHBvc3QtZWRpdCByb2FkbWFwIHRvIGRpc2sgYW5kIGNyZWF0ZSByZXF1aXJlZCBhcnRpZmFjdHNcbiAgICBjb25zdCByb2FkbWFwUGF0aCA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJNMDAxLVJPQURNQVAubWRcIik7XG4gICAgd3JpdGVGaWxlU3luYyhyb2FkbWFwUGF0aCwgcm9hZG1hcEFmdGVyKTtcbiAgICBjb25zdCBzdW1tYXJ5UGF0aCA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIiwgXCJTMDEtU1VNTUFSWS5tZFwiKTtcbiAgICB3cml0ZUZpbGVTeW5jKHN1bW1hcnlQYXRoLCBcIiMgU3VtbWFyeVxcbkRvbmUuXCIpO1xuICAgIGNvbnN0IHVhdFBhdGggPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIsIFwiUzAxLVVBVC5tZFwiKTtcbiAgICB3cml0ZUZpbGVTeW5jKHVhdFBhdGgsIFwiIyBVQVRcXG5QYXNzZWQuXCIpO1xuXG4gICAgLy8gdmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdCBzaG91bGQgc2VlIHRoZSBbeF0gZGVzcGl0ZSB0aGUgcGFyc2UgY2FjaGVcbiAgICAvLyBoYXZpbmcgdGhlIFsgXSB2ZXJzaW9uLiBUaGUgZml4IGNsZWFycyB0aGUgcGFyc2UgY2FjaGUgaW5zaWRlIHZlcmlmeS5cbiAgICBjb25zdCB2ZXJpZmllZCA9IHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QoXCJjb21wbGV0ZS1zbGljZVwiLCBcIk0wMDEvUzAxXCIsIGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbCh2ZXJpZmllZCwgdHJ1ZSwgXCJ2ZXJpZnlFeHBlY3RlZEFydGlmYWN0IHNob3VsZCByZXR1cm4gdHJ1ZSB3aGVuIHJvYWRtYXAgaGFzIFt4XVwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhclBhcnNlQ2FjaGUoKTtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3Q6IHBsYW4tc2xpY2UgZW1wdHkgc2NhZmZvbGQgcmVncmVzc2lvbiAoIzY5OSkgXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJ2ZXJpZnlFeHBlY3RlZEFydGlmYWN0IHJlamVjdHMgcGxhbi1zbGljZSB3aXRoIGVtcHR5IHNjYWZmb2xkXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgY29uc3Qgc2xpY2VEaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIpO1xuICAgIG1rZGlyU3luYyhzbGljZURpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHNsaWNlRGlyLCBcIlMwMS1QTEFOLm1kXCIpLCBcIiMgUzAxOiBUZXN0IFNsaWNlXFxuXFxuIyMgVGFza3NcXG5cXG5cIik7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKFxuICAgICAgdmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdChcInBsYW4tc2xpY2VcIiwgXCJNMDAxL1MwMVwiLCBiYXNlKSxcbiAgICAgIGZhbHNlLFxuICAgICAgXCJFbXB0eSBzY2FmZm9sZCBzaG91bGQgbm90IGJlIHRyZWF0ZWQgYXMgY29tcGxldGVkIGFydGlmYWN0XCIsXG4gICAgKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcInZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QgYWNjZXB0cyBwbGFuLXNsaWNlIHdpdGggYWN0dWFsIHRhc2tzXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgY29uc3Qgc2xpY2VEaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIpO1xuICAgIGNvbnN0IHRhc2tzRGlyID0gam9pbihzbGljZURpciwgXCJ0YXNrc1wiKTtcbiAgICBta2RpclN5bmModGFza3NEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihzbGljZURpciwgXCJTMDEtUExBTi5tZFwiKSwgW1xuICAgICAgXCIjIFMwMTogVGVzdCBTbGljZVwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMgVGFza3NcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIi0gWyBdICoqVDAxOiBJbXBsZW1lbnQgZmVhdHVyZSoqIGBlc3Q6MmhgXCIsXG4gICAgICBcIi0gWyBdICoqVDAyOiBXcml0ZSB0ZXN0cyoqIGBlc3Q6MWhgXCIsXG4gICAgXS5qb2luKFwiXFxuXCIpKTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4odGFza3NEaXIsIFwiVDAxLVBMQU4ubWRcIiksIFwiIyBUMDEgUGxhblwiKTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4odGFza3NEaXIsIFwiVDAyLVBMQU4ubWRcIiksIFwiIyBUMDIgUGxhblwiKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoXG4gICAgICB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0KFwicGxhbi1zbGljZVwiLCBcIk0wMDEvUzAxXCIsIGJhc2UpLFxuICAgICAgdHJ1ZSxcbiAgICAgIFwiUGxhbiB3aXRoIHRhc2sgZW50cmllcyBzaG91bGQgYmUgdHJlYXRlZCBhcyBjb21wbGV0ZWQgYXJ0aWZhY3RcIixcbiAgICApO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwidmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdCBhY2NlcHRzIHBsYW4tc2xpY2Ugd2l0aCBjb21wbGV0ZWQgdGFza3NcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBjb25zdCBzbGljZURpciA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIik7XG4gICAgY29uc3QgdGFza3NEaXIgPSBqb2luKHNsaWNlRGlyLCBcInRhc2tzXCIpO1xuICAgIG1rZGlyU3luYyh0YXNrc0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHNsaWNlRGlyLCBcIlMwMS1QTEFOLm1kXCIpLCBbXG4gICAgICBcIiMgUzAxOiBUZXN0IFNsaWNlXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBUYXNrc1wiLFxuICAgICAgXCJcIixcbiAgICAgIFwiLSBbeF0gKipUMDE6IEltcGxlbWVudCBmZWF0dXJlKiogYGVzdDoyaGBcIixcbiAgICAgIFwiLSBbIF0gKipUMDI6IFdyaXRlIHRlc3RzKiogYGVzdDoxaGBcIixcbiAgICBdLmpvaW4oXCJcXG5cIikpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbih0YXNrc0RpciwgXCJUMDEtUExBTi5tZFwiKSwgXCIjIFQwMSBQbGFuXCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbih0YXNrc0RpciwgXCJUMDItUExBTi5tZFwiKSwgXCIjIFQwMiBQbGFuXCIpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChcbiAgICAgIHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QoXCJwbGFuLXNsaWNlXCIsIFwiTTAwMS9TMDFcIiwgYmFzZSksXG4gICAgICB0cnVlLFxuICAgICAgXCJQbGFuIHdpdGggY29tcGxldGVkIHRhc2sgZW50cmllcyBzaG91bGQgYmUgdHJlYXRlZCBhcyBjb21wbGV0ZWQgYXJ0aWZhY3RcIixcbiAgICApO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwidmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdCB0cmVhdHMgY29tcGxldGUtc2xpY2UgYXMgc2F0aXNmaWVkIHdoZW4gc3VtbWFyeSwgVUFULCBhbmQgcm9hZG1hcCBjaGVja2JveCBleGlzdFwiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIGNvbnN0IG1pbGVzdG9uZURpciA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIik7XG4gICAgY29uc3Qgc2xpY2VEaXIgPSBqb2luKG1pbGVzdG9uZURpciwgXCJzbGljZXNcIiwgXCJTMDFcIik7XG4gICAgbWtkaXJTeW5jKHNsaWNlRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4obWlsZXN0b25lRGlyLCBcIk0wMDEtUk9BRE1BUC5tZFwiKSwgW1xuICAgICAgXCIjIE0wMDE6IFRlc3QgTWlsZXN0b25lXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBTbGljZXNcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIi0gW3hdICoqUzAxOiBGaXJzdCBzbGljZSoqIGByaXNrOmxvd2BcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIEJvdW5kYXJ5IE1hcFwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiLSBTMDEgXHUyMTkyIHRlcm1pbmFsXCIsXG4gICAgICBcIiAgLSBQcm9kdWNlczogZG9uZVwiLFxuICAgICAgXCIgIC0gQ29uc3VtZXM6IG5vdGhpbmdcIixcbiAgICBdLmpvaW4oXCJcXG5cIikpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihzbGljZURpciwgXCJTMDEtU1VNTUFSWS5tZFwiKSwgXCIjIFN1bW1hcnlcXG5Eb25lLlxcblwiKTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oc2xpY2VEaXIsIFwiUzAxLVVBVC5tZFwiKSwgXCIjIFVBVFxcblBhc3NlZC5cXG5cIik7XG5cbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0KFwiY29tcGxldGUtc2xpY2VcIiwgXCJNMDAxL1MwMVwiLCBiYXNlKSxcbiAgICAgIHRydWUsXG4gICAgICBcImNvbXBsZXRlLXNsaWNlIHNob3VsZCB2ZXJpZnkgd2hlbiBleHBlY3RlZCBhcnRpZmFjdCBhbmQgc3RhdGUgbXV0YXRpb24gYXJlIGFscmVhZHkgc2F0aXNmaWVkXCIsXG4gICAgKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcInZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QgcmVqZWN0cyBjb21wbGV0ZS1zbGljZSB3aGVuIHJvYWRtYXAgY2hlY2tib3ggaXMgc3RpbGwgdW5jaGVja2VkXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgY29uc3QgbWlsZXN0b25lRGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiKTtcbiAgICBjb25zdCBzbGljZURpciA9IGpvaW4obWlsZXN0b25lRGlyLCBcInNsaWNlc1wiLCBcIlMwMVwiKTtcbiAgICBta2RpclN5bmMoc2xpY2VEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihtaWxlc3RvbmVEaXIsIFwiTTAwMS1ST0FETUFQLm1kXCIpLCBbXG4gICAgICBcIiMgTTAwMTogVGVzdCBNaWxlc3RvbmVcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFNsaWNlc1wiLFxuICAgICAgXCJcIixcbiAgICAgIFwiLSBbIF0gKipTMDE6IEZpcnN0IHNsaWNlKiogYHJpc2s6bG93YFwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMgQm91bmRhcnkgTWFwXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCItIFMwMSBcdTIxOTIgdGVybWluYWxcIixcbiAgICAgIFwiICAtIFByb2R1Y2VzOiBkb25lXCIsXG4gICAgICBcIiAgLSBDb25zdW1lczogbm90aGluZ1wiLFxuICAgIF0uam9pbihcIlxcblwiKSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHNsaWNlRGlyLCBcIlMwMS1TVU1NQVJZLm1kXCIpLCBcIiMgU3VtbWFyeVxcbkRvbmUuXFxuXCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihzbGljZURpciwgXCJTMDEtVUFULm1kXCIpLCBcIiMgVUFUXFxuUGFzc2VkLlxcblwiKTtcblxuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QoXCJjb21wbGV0ZS1zbGljZVwiLCBcIk0wMDEvUzAxXCIsIGJhc2UpLFxuICAgICAgZmFsc2UsXG4gICAgICBcImNvbXBsZXRlLXNsaWNlIHNob3VsZCByZW1haW4gdW5zYXRpc2ZpZWQgd2hlbiByb2FkbWFwIHN0YXRlIHN0aWxsIHJlcXVpcmVzIHRoZSB1bml0IHRvIHJ1blwiLFxuICAgICk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3Q6IHBsYW4tc2xpY2UgdGFzayBwbGFuIGNoZWNrICgjNzM5KSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcInZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QgcGxhbi1zbGljZSBwYXNzZXMgd2hlbiBhbGwgdGFzayBwbGFuIGZpbGVzIGV4aXN0XCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgY29uc3QgdGFza3NEaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIsIFwidGFza3NcIik7XG4gICAgY29uc3QgcGxhblBhdGggPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIsIFwiUzAxLVBMQU4ubWRcIik7XG4gICAgY29uc3QgcGxhbkNvbnRlbnQgPSBbXG4gICAgICBcIiMgUzAxOiBUZXN0IFNsaWNlXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBUYXNrc1wiLFxuICAgICAgXCJcIixcbiAgICAgIFwiLSBbIF0gKipUMDE6IEZpcnN0IHRhc2sqKiBgZXN0OjFoYFwiLFxuICAgICAgXCItIFsgXSAqKlQwMjogU2Vjb25kIHRhc2sqKiBgZXN0OjJoYFwiLFxuICAgIF0uam9pbihcIlxcblwiKTtcbiAgICB3cml0ZUZpbGVTeW5jKHBsYW5QYXRoLCBwbGFuQ29udGVudCk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHRhc2tzRGlyLCBcIlQwMS1QTEFOLm1kXCIpLCBcIiMgVDAxIFBsYW5cXG5cXG5EbyB0aGUgdGhpbmcuXCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbih0YXNrc0RpciwgXCJUMDItUExBTi5tZFwiKSwgXCIjIFQwMiBQbGFuXFxuXFxuRG8gdGhlIG90aGVyIHRoaW5nLlwiKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QoXCJwbGFuLXNsaWNlXCIsIFwiTTAwMS9TMDFcIiwgYmFzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgdHJ1ZSwgXCJzaG91bGQgcGFzcyB3aGVuIGFsbCB0YXNrIHBsYW4gZmlsZXMgZXhpc3RcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJ2ZXJpZnlFeHBlY3RlZEFydGlmYWN0IHBsYW4tc2xpY2UgZmFpbHMgd2hlbiBhIHRhc2sgcGxhbiBmaWxlIGlzIG1pc3NpbmcgKCM3MzkpXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgY29uc3QgdGFza3NEaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIsIFwidGFza3NcIik7XG4gICAgY29uc3QgcGxhblBhdGggPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIsIFwiUzAxLVBMQU4ubWRcIik7XG4gICAgY29uc3QgcGxhbkNvbnRlbnQgPSBbXG4gICAgICBcIiMgUzAxOiBUZXN0IFNsaWNlXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBUYXNrc1wiLFxuICAgICAgXCJcIixcbiAgICAgIFwiLSBbIF0gKipUMDE6IEZpcnN0IHRhc2sqKiBgZXN0OjFoYFwiLFxuICAgICAgXCItIFsgXSAqKlQwMjogU2Vjb25kIHRhc2sqKiBgZXN0OjJoYFwiLFxuICAgIF0uam9pbihcIlxcblwiKTtcbiAgICB3cml0ZUZpbGVTeW5jKHBsYW5QYXRoLCBwbGFuQ29udGVudCk7XG4gICAgLy8gT25seSB3cml0ZSBUMDEtUExBTi5tZCBcdTIwMTQgVDAyIGlzIG1pc3NpbmdcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4odGFza3NEaXIsIFwiVDAxLVBMQU4ubWRcIiksIFwiIyBUMDEgUGxhblxcblxcbkRvIHRoZSB0aGluZy5cIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0KFwicGxhbi1zbGljZVwiLCBcIk0wMDEvUzAxXCIsIGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIGZhbHNlLCBcInNob3VsZCBmYWlsIHdoZW4gVDAyLVBMQU4ubWQgaXMgbWlzc2luZ1wiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcInZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QgcGxhbi1zbGljZSBmYWlscyBmb3IgcGxhbiB3aXRoIG5vIHRhc2tzICgjNjk5KVwiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIGNvbnN0IHBsYW5QYXRoID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiLCBcIlMwMS1QTEFOLm1kXCIpO1xuICAgIGNvbnN0IHBsYW5Db250ZW50ID0gW1xuICAgICAgXCIjIFMwMTogVGVzdCBTbGljZVwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMgR29hbFwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiSnVzdCBzb21lIGRvY3VtZW50YXRpb24gdXBkYXRlcywgbm8gdGFza3MuXCIsXG4gICAgXS5qb2luKFwiXFxuXCIpO1xuICAgIHdyaXRlRmlsZVN5bmMocGxhblBhdGgsIHBsYW5Db250ZW50KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QoXCJwbGFuLXNsaWNlXCIsIFwiTTAwMS9TMDFcIiwgYmFzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgZmFsc2UsIFwic2hvdWxkIGZhaWwgd2hlbiBwbGFuIGhhcyBubyB0YXNrIGVudHJpZXMgKGVtcHR5IHNjYWZmb2xkLCAjNjk5KVwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3Q6IGhlYWRpbmctc3R5bGUgcGxhbiB0YXNrcyAoIzE2OTEpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwidmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdCBhY2NlcHRzIHBsYW4tc2xpY2Ugd2l0aCBoZWFkaW5nLXN0eWxlIHRhc2tzICgjIyMgVDAxIC0tKVwiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIGNvbnN0IHNsaWNlRGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiKTtcbiAgICBjb25zdCB0YXNrc0RpciA9IGpvaW4oc2xpY2VEaXIsIFwidGFza3NcIik7XG4gICAgbWtkaXJTeW5jKHRhc2tzRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oc2xpY2VEaXIsIFwiUzAxLVBMQU4ubWRcIiksIFtcbiAgICAgIFwiIyBTMDE6IFRlc3QgU2xpY2VcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFRhc2tzXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyMgVDAxIC0tIEltcGxlbWVudCBmZWF0dXJlXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCJGZWF0dXJlIGRlc2NyaXB0aW9uLlwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMjIFQwMiAtLSBXcml0ZSB0ZXN0c1wiLFxuICAgICAgXCJcIixcbiAgICAgIFwiVGVzdCBkZXNjcmlwdGlvbi5cIixcbiAgICBdLmpvaW4oXCJcXG5cIikpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbih0YXNrc0RpciwgXCJUMDEtUExBTi5tZFwiKSwgXCIjIFQwMSBQbGFuXCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbih0YXNrc0RpciwgXCJUMDItUExBTi5tZFwiKSwgXCIjIFQwMiBQbGFuXCIpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChcbiAgICAgIHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QoXCJwbGFuLXNsaWNlXCIsIFwiTTAwMS9TMDFcIiwgYmFzZSksXG4gICAgICB0cnVlLFxuICAgICAgXCJIZWFkaW5nLXN0eWxlIHBsYW4gd2l0aCB0YXNrIGVudHJpZXMgc2hvdWxkIGJlIHRyZWF0ZWQgYXMgY29tcGxldGVkIGFydGlmYWN0XCIsXG4gICAgKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcInZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QgYWNjZXB0cyBwbGFuLXNsaWNlIHdpdGggY29sb24tc3R5bGUgaGVhZGluZyB0YXNrcyAoIyMjIFQwMTopXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgY29uc3Qgc2xpY2VEaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIpO1xuICAgIGNvbnN0IHRhc2tzRGlyID0gam9pbihzbGljZURpciwgXCJ0YXNrc1wiKTtcbiAgICBta2RpclN5bmModGFza3NEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihzbGljZURpciwgXCJTMDEtUExBTi5tZFwiKSwgW1xuICAgICAgXCIjIFMwMTogVGVzdCBTbGljZVwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMgVGFza3NcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIyBUMDE6IEltcGxlbWVudCBmZWF0dXJlXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCJGZWF0dXJlIGRlc2NyaXB0aW9uLlwiLFxuICAgIF0uam9pbihcIlxcblwiKSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHRhc2tzRGlyLCBcIlQwMS1QTEFOLm1kXCIpLCBcIiMgVDAxIFBsYW5cIik7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKFxuICAgICAgdmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdChcInBsYW4tc2xpY2VcIiwgXCJNMDAxL1MwMVwiLCBiYXNlKSxcbiAgICAgIHRydWUsXG4gICAgICBcIkNvbG9uIGhlYWRpbmctc3R5bGUgcGxhbiBzaG91bGQgYmUgdHJlYXRlZCBhcyBjb21wbGV0ZWQgYXJ0aWZhY3RcIixcbiAgICApO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwidmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdCBleGVjdXRlLXRhc2sgcmVxdWlyZXMgY2hlY2tlZCBjaGVja2JveCBvciBEQiBzdGF0dXMgZm9yIGhlYWRpbmctc3R5bGUgcGxhbiBlbnRyeSAoIzE2OTEsICMzNjA3KVwiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIGNvbnN0IHNsaWNlRGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiKTtcbiAgICBjb25zdCB0YXNrc0RpciA9IGpvaW4oc2xpY2VEaXIsIFwidGFza3NcIik7XG4gICAgbWtkaXJTeW5jKHRhc2tzRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oc2xpY2VEaXIsIFwiUzAxLVBMQU4ubWRcIiksIFtcbiAgICAgIFwiIyBTMDE6IFRlc3QgU2xpY2VcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFRhc2tzXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyMgVDAxIC0tIEltcGxlbWVudCBmZWF0dXJlXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCJGZWF0dXJlIGRlc2NyaXB0aW9uLlwiLFxuICAgIF0uam9pbihcIlxcblwiKSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHRhc2tzRGlyLCBcIlQwMS1TVU1NQVJZLm1kXCIpLCBcIiMgVDAxIFN1bW1hcnlcXG5cXG5Eb25lLlwiKTtcbiAgICAvLyBXaXRob3V0IERCIG9yIGNoZWNrZWQgY2hlY2tib3gsIGhlYWRpbmctc3R5bGUgcGxhbnMgY2Fubm90IHZlcmlmeVxuICAgIC8vIGV4ZWN1dGUtdGFzayBjb21wbGV0aW9uIChzdW1tYXJ5IGZpbGUgYWxvbmUgaXMgaW5zdWZmaWNpZW50LCAjMzYwNylcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoXG4gICAgICB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0KFwiZXhlY3V0ZS10YXNrXCIsIFwiTTAwMS9TMDEvVDAxXCIsIGJhc2UpLFxuICAgICAgZmFsc2UsXG4gICAgICBcImV4ZWN1dGUtdGFzayByZXF1aXJlcyBEQiBzdGF0dXMgb3IgY2hlY2tlZCBjaGVja2JveCwgbm90IGp1c3QgaGVhZGluZyArIHN1bW1hcnkgKCMzNjA3KVwiLFxuICAgICk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCAjNzkzOiBpbnZhbGlkYXRlQWxsQ2FjaGVzIHVuYmxvY2tzIHNraXAtbG9vcCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbi8vIFdoZW4gdGhlIHNraXAtbG9vcCBicmVha2VyIGZpcmVzLCBpdCBtdXN0IGNhbGwgaW52YWxpZGF0ZUFsbENhY2hlcygpIChub3Rcbi8vIGp1c3QgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKSkgdG8gY2xlYXIgcGF0aC9wYXJzZSBjYWNoZXMgdGhhdCBkZXJpdmVTdGF0ZVxuLy8gZGVwZW5kcyBvbi4gV2l0aG91dCB0aGlzLCBldmVuIGFmdGVyIGNhY2hlIGludmFsaWRhdGlvbiwgZGVyaXZlU3RhdGUgcmVhZHNcbi8vIHN0YWxlIGRpcmVjdG9yeSBsaXN0aW5ncyBhbmQgcmV0dXJucyB0aGUgc2FtZSB1bml0LCBsb29waW5nIGZvcmV2ZXIuXG50ZXN0KFwiIzc5MzogaW52YWxpZGF0ZUFsbENhY2hlcyBjbGVhcnMgYWxsIGNhY2hlcyBzbyBkZXJpdmVTdGF0ZSBzZWVzIGZyZXNoIGRpc2sgc3RhdGVcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBjb25zdCBtaWQgPSBcIk0wMDFcIjtcbiAgICBjb25zdCBzaWQgPSBcIlMwMVwiO1xuICAgIGNvbnN0IHBsYW5EaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgbWlkLCBcInNsaWNlc1wiLCBzaWQpO1xuICAgIGNvbnN0IHRhc2tzRGlyID0gam9pbihwbGFuRGlyLCBcInRhc2tzXCIpO1xuICAgIG1rZGlyU3luYyh0YXNrc0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBtaWQpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgbWlkLCBgJHttaWR9LVJPQURNQVAubWRgKSxcbiAgICAgIGAjIE0wMDE6IFRlc3QgTWlsZXN0b25lXFxuXFxuKipWaXNpb246KiogdGVzdC5cXG5cXG4jIyBTbGljZXNcXG5cXG4tIFsgXSAqKiR7c2lkfTogU2xpY2UgT25lKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbXVxcYFxcbiAgPiBBZnRlciB0aGlzOiBkb25lLlxcbmAsXG4gICAgKTtcbiAgICBjb25zdCBwbGFuVW5jaGVja2VkID0gYCMgJHtzaWR9OiBTbGljZSBPbmVcXG5cXG4qKkdvYWw6KiogdGVzdC5cXG5cXG4jIyBUYXNrc1xcblxcbi0gWyBdICoqVDAxOiBUYXNrIE9uZSoqIFxcYGVzdDoxMG1cXGBcXG4tIFsgXSAqKlQwMjogVGFzayBUd28qKiBcXGBlc3Q6MTBtXFxgXFxuYDtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocGxhbkRpciwgYCR7c2lkfS1QTEFOLm1kYCksIHBsYW5VbmNoZWNrZWQpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbih0YXNrc0RpciwgXCJUMDEtUExBTi5tZFwiKSwgXCIjIFQwMTogVGFzayBPbmVcXG5cXG4qKkdvYWw6KiogdFxcblxcbiMjIFN0ZXBzXFxuLSBzdGVwXFxuXFxuIyMgVmVyaWZpY2F0aW9uXFxuLSB2XFxuXCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbih0YXNrc0RpciwgXCJUMDItUExBTi5tZFwiKSwgXCIjIFQwMjogVGFzayBUd29cXG5cXG4qKkdvYWw6KiogdFxcblxcbiMjIFN0ZXBzXFxuLSBzdGVwXFxuXFxuIyMgVmVyaWZpY2F0aW9uXFxuLSB2XFxuXCIpO1xuXG4gICAgLy8gV2FybSBhbGwgY2FjaGVzXG4gICAgY29uc3Qgc3RhdGUxID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHN0YXRlMS5hY3RpdmVUYXNrPy5pZCwgXCJUMDFcIiwgXCJpbml0aWFsOiBUMDEgaXMgYWN0aXZlXCIpO1xuXG4gICAgLy8gU2ltdWxhdGUgdGFzayBjb21wbGV0aW9uIG9uIGRpc2sgKHdoYXQgdGhlIExMTSBkb2VzKVxuICAgIGNvbnN0IHBsYW5DaGVja2VkID0gYCMgJHtzaWR9OiBTbGljZSBPbmVcXG5cXG4qKkdvYWw6KiogdGVzdC5cXG5cXG4jIyBUYXNrc1xcblxcbi0gW3hdICoqVDAxOiBUYXNrIE9uZSoqIFxcYGVzdDoxMG1cXGBcXG4tIFsgXSAqKlQwMjogVGFzayBUd28qKiBcXGBlc3Q6MTBtXFxgXFxuYDtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocGxhbkRpciwgYCR7c2lkfS1QTEFOLm1kYCksIHBsYW5DaGVja2VkKTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4odGFza3NEaXIsIFwiVDAxLVNVTU1BUlkubWRcIiksIFwiLS0tXFxuaWQ6IFQwMVxcbi0tLVxcbiMgU3VtbWFyeVxcblwiKTtcblxuICAgIC8vIGludmFsaWRhdGVTdGF0ZUNhY2hlIGFsb25lOiBfc3RhdGVDYWNoZSBjbGVhcmVkIGJ1dCBwYXRoL3BhcnNlIGNhY2hlcyB3YXJtXG4gICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcblxuICAgIC8vIGludmFsaWRhdGVBbGxDYWNoZXM6IGFsbCBjYWNoZXMgY2xlYXJlZCBcdTIwMTQgZGVyaXZlU3RhdGUgbXVzdCByZS1yZWFkIGRpc2tcbiAgICBpbnZhbGlkYXRlQWxsQ2FjaGVzKCk7XG4gICAgY29uc3Qgc3RhdGUyID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG5cbiAgICAvLyBBZnRlciBmdWxsIGludmFsaWRhdGlvbiwgVDAxIHNob3VsZCBiZSBjb21wbGV0ZSBhbmQgVDAyIHNob3VsZCBiZSBuZXh0XG4gICAgYXNzZXJ0Lm5vdEVxdWFsKHN0YXRlMi5hY3RpdmVUYXNrPy5pZCwgXCJUMDFcIiwgXCIjNzkzOiBUMDEgbm90IHJlLWRpc3BhdGNoZWQgYWZ0ZXIgZnVsbCBpbnZhbGlkYXRpb25cIik7XG5cbiAgICAvLyBWZXJpZnkgdGhlIGNhY2hlcyBhcmUgdHJ1bHkgY2xlYXJlZCBieSBjYWxsaW5nIGNsZWFyUGFyc2VDYWNoZSBhbmQgY2xlYXJQYXRoQ2FjaGVcbiAgICAvLyBkbyBub3QgdGhyb3cgKHRoZXkgc2hvdWxkIGJlIG5vLW9wcyBhZnRlciBpbnZhbGlkYXRlQWxsQ2FjaGVzIGFscmVhZHkgY2xlYXJlZCB0aGVtKVxuICAgIGNsZWFyUGFyc2VDYWNoZSgpOyAvLyBuby1vcCwgYnV0IHNob3VsZCBub3QgdGhyb3dcbiAgICBhc3NlcnQub2sodHJ1ZSwgXCJjbGVhclBhcnNlQ2FjaGUgYWZ0ZXIgaW52YWxpZGF0ZUFsbENhY2hlcyBpcyBzYWZlXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgaGFzSW1wbGVtZW50YXRpb25BcnRpZmFjdHMgKCMxNzAzKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuaW1wb3J0IHsgZXhlY0ZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuXG5mdW5jdGlvbiBtYWtlR2l0QmFzZSgpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gam9pbih0bXBkaXIoKSwgYGdzZC10ZXN0LWdpdC0ke3JhbmRvbVVVSUQoKX1gKTtcbiAgbWtkaXJTeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiaW5pdFwiLCBcIi0taW5pdGlhbC1icmFuY2g9bWFpblwiXSwgeyBjd2Q6IGJhc2UsIHN0ZGlvOiBcImlnbm9yZVwiIH0pO1xuICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiY29uZmlnXCIsIFwidXNlci5lbWFpbFwiLCBcInRlc3RAdGVzdC5jb21cIl0sIHsgY3dkOiBiYXNlLCBzdGRpbzogXCJpZ25vcmVcIiB9KTtcbiAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcImNvbmZpZ1wiLCBcInVzZXIubmFtZVwiLCBcIlRlc3RcIl0sIHsgY3dkOiBiYXNlLCBzdGRpbzogXCJpZ25vcmVcIiB9KTtcbiAgLy8gQ3JlYXRlIGluaXRpYWwgY29tbWl0IHNvIEhFQUQgZXhpc3RzXG4gIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5naXRrZWVwXCIpLCBcIlwiKTtcbiAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcImFkZFwiLCBcIi5cIl0sIHsgY3dkOiBiYXNlLCBzdGRpbzogXCJpZ25vcmVcIiB9KTtcbiAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcImNvbW1pdFwiLCBcIi1tXCIsIFwiaW5pdGlhbFwiXSwgeyBjd2Q6IGJhc2UsIHN0ZGlvOiBcImlnbm9yZVwiIH0pO1xuICByZXR1cm4gYmFzZTtcbn1cblxudGVzdChcImhhc0ltcGxlbWVudGF0aW9uQXJ0aWZhY3RzIHJldHVybnMgZmFsc2Ugd2hlbiBvbmx5IC5nc2QvIGZpbGVzIGNvbW1pdHRlZCAoIzE3MDMpXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VHaXRCYXNlKCk7XG4gIHRyeSB7XG4gICAgLy8gQ3JlYXRlIGEgZmVhdHVyZSBicmFuY2ggYW5kIGNvbW1pdCBvbmx5IC5nc2QvIGZpbGVzXG4gICAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcImNoZWNrb3V0XCIsIFwiLWJcIiwgXCJmZWF0L3Rlc3QtbWlsZXN0b25lXCJdLCB7IGN3ZDogYmFzZSwgc3RkaW86IFwiaWdub3JlXCIgfSk7XG4gICAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcIk0wMDEtUk9BRE1BUC5tZFwiKSwgXCIjIFJvYWRtYXBcIik7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwiTTAwMS1TVU1NQVJZLm1kXCIpLCBcIiMgU3VtbWFyeVwiKTtcbiAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiYWRkXCIsIFwiLlwiXSwgeyBjd2Q6IGJhc2UsIHN0ZGlvOiBcImlnbm9yZVwiIH0pO1xuICAgIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJjb21taXRcIiwgXCItbVwiLCBcImNob3JlOiBhZGQgcGxhbiBmaWxlc1wiXSwgeyBjd2Q6IGJhc2UsIHN0ZGlvOiBcImlnbm9yZVwiIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gaGFzSW1wbGVtZW50YXRpb25BcnRpZmFjdHMoYmFzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgXCJhYnNlbnRcIiwgXCJzaG91bGQgcmV0dXJuIGFic2VudCB3aGVuIG9ubHkgLmdzZC8gZmlsZXMgd2VyZSBjb21taXR0ZWRcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJoYXNJbXBsZW1lbnRhdGlvbkFydGlmYWN0cyByZXR1cm5zIHRydWUgd2hlbiBpbXBsZW1lbnRhdGlvbiBmaWxlcyBjb21taXR0ZWQgKCMxNzAzKVwiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlR2l0QmFzZSgpO1xuICB0cnkge1xuICAgIC8vIENyZWF0ZSBhIGZlYXR1cmUgYnJhbmNoIHdpdGggYm90aCAuZ3NkLyBhbmQgaW1wbGVtZW50YXRpb24gZmlsZXNcbiAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiY2hlY2tvdXRcIiwgXCItYlwiLCBcImZlYXQvdGVzdC1pbXBsXCJdLCB7IGN3ZDogYmFzZSwgc3RkaW86IFwiaWdub3JlXCIgfSk7XG4gICAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcIk0wMDEtUk9BRE1BUC5tZFwiKSwgXCIjIFJvYWRtYXBcIik7XG4gICAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCJzcmNcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcInNyY1wiLCBcImZlYXR1cmUudHNcIiksIFwiZXhwb3J0IGZ1bmN0aW9uIGZlYXR1cmUoKSB7fVwiKTtcbiAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiYWRkXCIsIFwiLlwiXSwgeyBjd2Q6IGJhc2UsIHN0ZGlvOiBcImlnbm9yZVwiIH0pO1xuICAgIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJjb21taXRcIiwgXCItbVwiLCBcImZlYXQ6IGFkZCBmZWF0dXJlXCJdLCB7IGN3ZDogYmFzZSwgc3RkaW86IFwiaWdub3JlXCIgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBoYXNJbXBsZW1lbnRhdGlvbkFydGlmYWN0cyhiYXNlKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCBcInByZXNlbnRcIiwgXCJzaG91bGQgcmV0dXJuIHByZXNlbnQgd2hlbiBpbXBsZW1lbnRhdGlvbiBmaWxlcyBhcmUgcHJlc2VudFwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcImhhc0ltcGxlbWVudGF0aW9uQXJ0aWZhY3RzIGZpbmRzIG1pbGVzdG9uZSBpbXBsZW1lbnRhdGlvbiBjb21taXRzIGFmdGVyIHJldHJ5IHJlc3VtZXMgb24gbWFpbiAoIzQ2OTkpXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VHaXRCYXNlKCk7XG4gIHRyeSB7XG4gICAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcIk0wMDEtUk9BRE1BUC5tZFwiKSwgXCIjIFJvYWRtYXBcIik7XG4gICAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcImFkZFwiLCBcIi5cIl0sIHsgY3dkOiBiYXNlLCBzdGRpbzogXCJpZ25vcmVcIiB9KTtcbiAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiY29tbWl0XCIsIFwiLW1cIiwgXCJjaG9yZTogYXV0by1jb21taXQgYWZ0ZXIgcGxhbi1taWxlc3RvbmVcXG5cXG5HU0QtVW5pdDogTTAwMVwiXSwgeyBjd2Q6IGJhc2UsIHN0ZGlvOiBcImlnbm9yZVwiIH0pO1xuXG4gICAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCJzcmNcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIsIFwidGFza3NcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcInNyY1wiLCBcImZlYXR1cmUudHNcIiksIFwiZXhwb3J0IGZ1bmN0aW9uIGZlYXR1cmUoKSB7fVwiKTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIiwgXCJ0YXNrc1wiLCBcIlQwMS1TVU1NQVJZLm1kXCIpLCBcIiMgU3VtbWFyeVwiKTtcbiAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiYWRkXCIsIFwiLlwiXSwgeyBjd2Q6IGJhc2UsIHN0ZGlvOiBcImlnbm9yZVwiIH0pO1xuICAgIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJjb21taXRcIiwgXCItbVwiLCBcImZlYXQ6IGFkZCBtaWxlc3RvbmUgZmVhdHVyZVxcblxcbkdTRC1UYXNrOiBTMDEvVDAxXCJdLCB7IGN3ZDogYmFzZSwgc3RkaW86IFwiaWdub3JlXCIgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBoYXNJbXBsZW1lbnRhdGlvbkFydGlmYWN0cyhiYXNlLCBcIk0wMDFcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgXCJwcmVzZW50XCIsIFwibWFpbiBzZWxmLWRpZmYgcmV0cnkgc2hvdWxkIGZpbmQgcHJvZHVjdGlvbiBleGVjdXRlLXRhc2sgY29tbWl0c1wiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcImhhc0ltcGxlbWVudGF0aW9uQXJ0aWZhY3RzIHJlamVjdHMgbWlsZXN0b25lLXNjb3BlZCBtYWluIGhpc3Rvcnkgd2l0aCBvbmx5IC5nc2QgY29tbWl0cyAoIzQ2OTkpXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VHaXRCYXNlKCk7XG4gIHRyeSB7XG4gICAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcIk0wMDEtUk9BRE1BUC5tZFwiKSwgXCIjIFJvYWRtYXBcIik7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwiTTAwMS1TVU1NQVJZLm1kXCIpLCBcIiMgU3VtbWFyeVwiKTtcbiAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiYWRkXCIsIFwiLlwiXSwgeyBjd2Q6IGJhc2UsIHN0ZGlvOiBcImlnbm9yZVwiIH0pO1xuICAgIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJjb21taXRcIiwgXCItbVwiLCBcImNob3JlOiBhdXRvLWNvbW1pdCBhZnRlciBjb21wbGV0ZS1taWxlc3RvbmVcXG5cXG5HU0QtVW5pdDogTTAwMVwiXSwgeyBjd2Q6IGJhc2UsIHN0ZGlvOiBcImlnbm9yZVwiIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gaGFzSW1wbGVtZW50YXRpb25BcnRpZmFjdHMoYmFzZSwgXCJNMDAxXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIFwiYWJzZW50XCIsIFwibWlsZXN0b25lLXNjb3BlZCBmYWxsYmFjayBtdXN0IG5vdCB0cmVhdCAuZ3NkLW9ubHkgY29tbWl0cyBhcyBpbXBsZW1lbnRhdGlvblwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcImhhc0ltcGxlbWVudGF0aW9uQXJ0aWZhY3RzIGZpbmRzIGludGVncmF0aW9uIGltcGxlbWVudGF0aW9uLW9ubHkgY29tbWl0cyB3aGVuIG1pbGVzdG9uZSBicmFuY2ggZGlmZiBpcyAuZ3NkLW9ubHlcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUdpdEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBta2RpclN5bmMoam9pbihiYXNlLCBcInNyY1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwic3JjXCIsIFwiZmVhdHVyZS50c1wiKSwgXCJleHBvcnQgZnVuY3Rpb24gZmVhdHVyZSgpIHt9XFxuXCIpO1xuICAgIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJhZGRcIiwgXCJzcmMvZmVhdHVyZS50c1wiXSwgeyBjd2Q6IGJhc2UsIHN0ZGlvOiBcImlnbm9yZVwiIH0pO1xuICAgIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJjb21taXRcIiwgXCItbVwiLCBcImZlYXQ6IGFkZCBtaWxlc3RvbmUgZmVhdHVyZVxcblxcbkdTRC1UYXNrOiBTMDEvVDAxXCJdLCB7IGN3ZDogYmFzZSwgc3RkaW86IFwiaWdub3JlXCIgfSk7XG5cbiAgICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsIFwiLmdzZFwiLCBcImdzZC5kYlwiKSk7XG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJNaWxlc3RvbmUgT25lXCIsIHN0YXR1czogXCJhY3RpdmVcIiB9KTtcbiAgICBpbnNlcnRTbGljZSh7XG4gICAgICBpZDogXCJTMDFcIixcbiAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICAgIHRpdGxlOiBcIlNsaWNlIE9uZVwiLFxuICAgICAgc3RhdHVzOiBcImNvbXBsZXRlXCIsXG4gICAgICByaXNrOiBcImxvd1wiLFxuICAgICAgZGVwZW5kczogW10sXG4gICAgfSk7XG4gICAgaW5zZXJ0VGFzayh7XG4gICAgICBpZDogXCJUMDFcIixcbiAgICAgIHNsaWNlSWQ6IFwiUzAxXCIsXG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICB0aXRsZTogXCJUYXNrIE9uZVwiLFxuICAgICAgc3RhdHVzOiBcImNvbXBsZXRlXCIsXG4gICAgfSk7XG5cbiAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiY2hlY2tvdXRcIiwgXCItYlwiLCBcIm1pbGVzdG9uZS9NMDAxXCJdLCB7IGN3ZDogYmFzZSwgc3RkaW86IFwiaWdub3JlXCIgfSk7XG4gICAgd3JpdGVJbnRlZ3JhdGlvbkJyYW5jaChiYXNlLCBcIk0wMDFcIiwgXCJtYWluXCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcIk0wMDEtU1VNTUFSWS5tZFwiKSwgXCIjIE1pbGVzdG9uZSBTdW1tYXJ5XFxuRG9uZS5cIik7XG4gICAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcImFkZFwiLCBcIi5cIl0sIHsgY3dkOiBiYXNlLCBzdGRpbzogXCJpZ25vcmVcIiB9KTtcbiAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiY29tbWl0XCIsIFwiLW1cIiwgXCJjaG9yZTogYXV0by1jb21taXQgYWZ0ZXIgY29tcGxldGUtbWlsZXN0b25lXFxuXFxuR1NELVVuaXQ6IE0wMDFcIl0sIHsgY3dkOiBiYXNlLCBzdGRpbzogXCJpZ25vcmVcIiB9KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGhhc0ltcGxlbWVudGF0aW9uQXJ0aWZhY3RzKGJhc2UsIFwiTTAwMVwiKTtcbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICByZXN1bHQsXG4gICAgICBcInByZXNlbnRcIixcbiAgICAgIFwiLmdzZC1vbmx5IG1pbGVzdG9uZSBjbG9zZW91dCBkaWZmcyBzaG91bGQgc3RpbGwgaG9ub3IgaW1wbGVtZW50YXRpb24gY29tbWl0cyBhbHJlYWR5IG9uIHRoZSBpbnRlZ3JhdGlvbiBicmFuY2hcIixcbiAgICApO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiaGFzSW1wbGVtZW50YXRpb25BcnRpZmFjdHMgYmFja2ZpbGxzIHVudGFnZ2VkIG1haW4gaW1wbGVtZW50YXRpb24gY29tbWl0cyBmcm9tIGNvbXBsZXRlZCB0YXNrIGZpbGUgaGludHNcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUdpdEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsIFwiLmdzZFwiLCBcImdzZC5kYlwiKSk7XG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJNaWxlc3RvbmUgT25lXCIsIHN0YXR1czogXCJhY3RpdmVcIiB9KTtcbiAgICBpbnNlcnRTbGljZSh7XG4gICAgICBpZDogXCJTMDFcIixcbiAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICAgIHRpdGxlOiBcIlNsaWNlIE9uZVwiLFxuICAgICAgc3RhdHVzOiBcImNvbXBsZXRlXCIsXG4gICAgICByaXNrOiBcImxvd1wiLFxuICAgICAgZGVwZW5kczogW10sXG4gICAgfSk7XG4gICAgaW5zZXJ0VGFzayh7XG4gICAgICBpZDogXCJUMDFcIixcbiAgICAgIHNsaWNlSWQ6IFwiUzAxXCIsXG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICB0aXRsZTogXCJUYXNrIE9uZVwiLFxuICAgICAgc3RhdHVzOiBcImNvbXBsZXRlXCIsXG4gICAgICBrZXlGaWxlczogW1wiaW5kZXguaHRtbFwiLCBcInN0eWxlLmNzc1wiLCBcImFwcC5qc1wiXSxcbiAgICAgIHBsYW5uaW5nOiB7IGZpbGVzOiBbXCJpbmRleC5odG1sXCIsIFwic3R5bGUuY3NzXCIsIFwiYXBwLmpzXCJdIH0sXG4gICAgfSk7XG5cbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCJpbmRleC5odG1sXCIpLCBcIjxtYWluPjwvbWFpbj5cXG5cIik7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwic3R5bGUuY3NzXCIpLCBcIm1haW4geyBkaXNwbGF5OiBibG9jazsgfVxcblwiKTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCJhcHAuanNcIiksIFwiZG9jdW1lbnQuYm9keS5kYXRhc2V0LnJlYWR5ID0gJ3RydWUnO1xcblwiKTtcbiAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiYWRkXCIsIFwiaW5kZXguaHRtbFwiLCBcInN0eWxlLmNzc1wiLCBcImFwcC5qc1wiXSwgeyBjd2Q6IGJhc2UsIHN0ZGlvOiBcImlnbm9yZVwiIH0pO1xuICAgIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJjb21taXRcIiwgXCItbVwiLCBcImZlYXQ6IGFkZCB0by1kbyBhcHAgd2l0aCBDUlVEIGFuZCBsb2NhbFN0b3JhZ2UgcGVyc2lzdGVuY2VcIl0sIHsgY3dkOiBiYXNlLCBzdGRpbzogXCJpZ25vcmVcIiB9KTtcbiAgICBjb25zdCBjb21taXRTaGEgPSBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wicmV2LXBhcnNlXCIsIFwiSEVBRFwiXSwgeyBjd2Q6IGJhc2UsIGVuY29kaW5nOiBcInV0Zi04XCIgfSkudHJpbSgpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gaGFzSW1wbGVtZW50YXRpb25BcnRpZmFjdHMoYmFzZSwgXCJNMDAxXCIpO1xuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIHJlc3VsdCxcbiAgICAgIFwicHJlc2VudFwiLFxuICAgICAgXCJjb21wbGV0ZWQgdGFzayBmaWxlIGhpbnRzIHNob3VsZCByZXBhaXIgcHJpb3IgdW50YWdnZWQgaW1wbGVtZW50YXRpb24gY29tbWl0cyBvbiBtYWluXCIsXG4gICAgKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKGdldE1pbGVzdG9uZUNvbW1pdEF0dHJpYnV0aW9uU2hhcyhcIk0wMDFcIiksIFtjb21taXRTaGFdKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcImhhc0ltcGxlbWVudGF0aW9uQXJ0aWZhY3RzIGRvZXMgbm90IGJhY2tmaWxsIHVudGFnZ2VkIGNvbW1pdHMgYmVmb3JlIG1pbGVzdG9uZSBjcmVhdGlvblwiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlR2l0QmFzZSgpO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcImFwcC5qc1wiKSwgXCJkb2N1bWVudC5ib2R5LmRhdGFzZXQucmVhZHkgPSAnb2xkJztcXG5cIik7XG4gICAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcImFkZFwiLCBcImFwcC5qc1wiXSwgeyBjd2Q6IGJhc2UsIHN0ZGlvOiBcImlnbm9yZVwiIH0pO1xuICAgIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJjb21taXRcIiwgXCItbVwiLCBcImZlYXQ6IG9sZCBhcHAgd29ya1wiXSwge1xuICAgICAgY3dkOiBiYXNlLFxuICAgICAgc3RkaW86IFwiaWdub3JlXCIsXG4gICAgICBlbnY6IHtcbiAgICAgICAgLi4ucHJvY2Vzcy5lbnYsXG4gICAgICAgIEdJVF9BVVRIT1JfREFURTogXCIyMDIwLTAxLTAxVDAwOjAwOjAwWlwiLFxuICAgICAgICBHSVRfQ09NTUlUVEVSX0RBVEU6IFwiMjAyMC0wMS0wMVQwMDowMDowMFpcIixcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsIFwiLmdzZFwiLCBcImdzZC5kYlwiKSk7XG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJNaWxlc3RvbmUgT25lXCIsIHN0YXR1czogXCJhY3RpdmVcIiB9KTtcbiAgICBpbnNlcnRTbGljZSh7XG4gICAgICBpZDogXCJTMDFcIixcbiAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICAgIHRpdGxlOiBcIlNsaWNlIE9uZVwiLFxuICAgICAgc3RhdHVzOiBcImNvbXBsZXRlXCIsXG4gICAgICByaXNrOiBcImxvd1wiLFxuICAgICAgZGVwZW5kczogW10sXG4gICAgfSk7XG4gICAgaW5zZXJ0VGFzayh7XG4gICAgICBpZDogXCJUMDFcIixcbiAgICAgIHNsaWNlSWQ6IFwiUzAxXCIsXG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICB0aXRsZTogXCJUYXNrIE9uZVwiLFxuICAgICAgc3RhdHVzOiBcImNvbXBsZXRlXCIsXG4gICAgICBrZXlGaWxlczogW1wiYXBwLmpzXCJdLFxuICAgICAgcGxhbm5pbmc6IHsgZmlsZXM6IFtcImFwcC5qc1wiXSB9LFxuICAgIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gaGFzSW1wbGVtZW50YXRpb25BcnRpZmFjdHMoYmFzZSwgXCJNMDAxXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIFwiYWJzZW50XCIsIFwicHJlLW1pbGVzdG9uZSBjb21taXRzIG11c3Qgbm90IGJlIGF0dHJpYnV0ZWQgdG8gdGhlIG1pbGVzdG9uZVwiKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKGdldE1pbGVzdG9uZUNvbW1pdEF0dHJpYnV0aW9uU2hhcyhcIk0wMDFcIiksIFtdKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcImhhc0ltcGxlbWVudGF0aW9uQXJ0aWZhY3RzIGRvZXMgbm90IGJhY2tmaWxsIHVucmVsYXRlZCB1bnRhZ2dlZCBpbXBsZW1lbnRhdGlvbiBjb21taXRzXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VHaXRCYXNlKCk7XG4gIHRyeSB7XG4gICAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJnc2QuZGJcIikpO1xuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiTWlsZXN0b25lIE9uZVwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSk7XG4gICAgaW5zZXJ0U2xpY2Uoe1xuICAgICAgaWQ6IFwiUzAxXCIsXG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICB0aXRsZTogXCJTbGljZSBPbmVcIixcbiAgICAgIHN0YXR1czogXCJjb21wbGV0ZVwiLFxuICAgICAgcmlzazogXCJsb3dcIixcbiAgICAgIGRlcGVuZHM6IFtdLFxuICAgIH0pO1xuICAgIGluc2VydFRhc2soe1xuICAgICAgaWQ6IFwiVDAxXCIsXG4gICAgICBzbGljZUlkOiBcIlMwMVwiLFxuICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgdGl0bGU6IFwiVGFzayBPbmVcIixcbiAgICAgIHN0YXR1czogXCJjb21wbGV0ZVwiLFxuICAgICAga2V5RmlsZXM6IFtcInNyYy9leHBlY3RlZC50c1wiXSxcbiAgICAgIHBsYW5uaW5nOiB7IGZpbGVzOiBbXCJzcmMvZXhwZWN0ZWQudHNcIl0gfSxcbiAgICB9KTtcblxuICAgIG1rZGlyU3luYyhqb2luKGJhc2UsIFwic3JjXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCJzcmNcIiwgXCJ1bnJlbGF0ZWQudHNcIiksIFwiZXhwb3J0IGNvbnN0IHVucmVsYXRlZCA9IHRydWU7XFxuXCIpO1xuICAgIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJhZGRcIiwgXCJzcmMvdW5yZWxhdGVkLnRzXCJdLCB7IGN3ZDogYmFzZSwgc3RkaW86IFwiaWdub3JlXCIgfSk7XG4gICAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcImNvbW1pdFwiLCBcIi1tXCIsIFwiZmVhdDogdW5yZWxhdGVkIHdvcmtcIl0sIHsgY3dkOiBiYXNlLCBzdGRpbzogXCJpZ25vcmVcIiB9KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGhhc0ltcGxlbWVudGF0aW9uQXJ0aWZhY3RzKGJhc2UsIFwiTTAwMVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCBcImFic2VudFwiLCBcImJhY2tmaWxsIG11c3QgcmVxdWlyZSBvdmVybGFwIHdpdGggY29tcGxldGVkIHRhc2sgZmlsZSBoaW50c1wiKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKGdldE1pbGVzdG9uZUNvbW1pdEF0dHJpYnV0aW9uU2hhcyhcIk0wMDFcIiksIFtdKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcImhhc0ltcGxlbWVudGF0aW9uQXJ0aWZhY3RzIHRyZWF0cyBlbXB0eSBub24taW50ZWdyYXRpb24gYnJhbmNoIGRpZmYgYXMgYWJzZW50ICgjNDY5OSlcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUdpdEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiY2hlY2tvdXRcIiwgXCItYlwiLCBcImZlYXQvZW1wdHktbWlsZXN0b25lXCJdLCB7IGN3ZDogYmFzZSwgc3RkaW86IFwiaWdub3JlXCIgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBoYXNJbXBsZW1lbnRhdGlvbkFydGlmYWN0cyhiYXNlLCBcIk0wMDFcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgXCJhYnNlbnRcIiwgXCJlbXB0eSBtaWxlc3RvbmUgYnJhbmNoIGRpZmZzIHNob3VsZCBub3QgdXNlIG1haW4gcmV0cnkgZmFsbGJhY2tcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJoYXNJbXBsZW1lbnRhdGlvbkFydGlmYWN0cyB1c2VzIG1pbGVzdG9uZSBwYXRoIGhpc3RvcnkgaW5zdGVhZCBvZiByb2xsaW5nIGRlcHRoICgjNDY5OSlcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUdpdEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiLCBcInRhc2tzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBta2RpclN5bmMoam9pbihiYXNlLCBcInNyY1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwic3JjXCIsIFwiZmVhdHVyZS50c1wiKSwgXCJleHBvcnQgZnVuY3Rpb24gZmVhdHVyZSgpIHt9XCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiLCBcInRhc2tzXCIsIFwiVDAxLVNVTU1BUlkubWRcIiksIFwiIyBTdW1tYXJ5XCIpO1xuICAgIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJhZGRcIiwgXCIuXCJdLCB7IGN3ZDogYmFzZSwgc3RkaW86IFwiaWdub3JlXCIgfSk7XG4gICAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcImNvbW1pdFwiLCBcIi1tXCIsIFwiZmVhdDogb2xkIG1pbGVzdG9uZSBpbXBsZW1lbnRhdGlvblxcblxcbkdTRC1UYXNrOiBTMDEvVDAxXCJdLCB7IGN3ZDogYmFzZSwgc3RkaW86IFwiaWdub3JlXCIgfSk7XG5cbiAgICBta2RpclN5bmMoam9pbihiYXNlLCBcImRvY3NcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgMjA1OyBpKyspIHtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcImRvY3NcIiwgYG5vdGUtJHtpfS5tZGApLCBgIyBOb3RlICR7aX1cXG5gKTtcbiAgICAgIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJhZGRcIiwgXCIuXCJdLCB7IGN3ZDogYmFzZSwgc3RkaW86IFwiaWdub3JlXCIgfSk7XG4gICAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiY29tbWl0XCIsIFwiLW1cIiwgYGRvY3M6IGZpbGxlciAke2l9YF0sIHsgY3dkOiBiYXNlLCBzdGRpbzogXCJpZ25vcmVcIiB9KTtcbiAgICB9XG5cbiAgICBjb25zdCByZXN1bHQgPSBoYXNJbXBsZW1lbnRhdGlvbkFydGlmYWN0cyhiYXNlLCBcIk0wMDFcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgXCJwcmVzZW50XCIsIFwibWlsZXN0b25lIGV2aWRlbmNlIHNob3VsZCBub3QgYWdlIG91dCBhZnRlciAyMDAgdW5yZWxhdGVkIGNvbW1pdHNcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJoYXNJbXBsZW1lbnRhdGlvbkFydGlmYWN0cyBmaW5kcyBpbXBsZW1lbnRhdGlvbiBjb21taXRzIHdoZW4gLmdzZC8gaXMgZ2l0aWdub3JlZCAoIzUwMzMpXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VHaXRCYXNlKCk7XG4gIHRyeSB7XG4gICAgLy8gU2ltdWxhdGUgZXh0ZXJuYWwvdW50cmFja2VkIC5nc2QvIHZpYSAuZ2l0L2luZm8vZXhjbHVkZSBcdTIwMTQgbWlsZXN0b25lXG4gICAgLy8gcGxhbm5pbmcgYXJ0aWZhY3RzIG5ldmVyIGVudGVyIGdpdCwgYnV0IHJlYWwgaW1wbGVtZW50YXRpb24gZmlsZXMgZG8uXG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdpdFwiLCBcImluZm9cIiwgXCJleGNsdWRlXCIpLCBcIi5nc2QvXFxuXCIpO1xuICAgIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIsIFwidGFza3NcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIsIFwidGFza3NcIiwgXCJUMDEtU1VNTUFSWS5tZFwiKSxcbiAgICAgIFwiIyBTdW1tYXJ5XCIsXG4gICAgKTtcblxuICAgIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiYmVuY2htYXJrc1wiLCBcIk0wMDFcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcImJlbmNobWFya3NcIiwgXCJNMDAxXCIsIFwibWFuaWZlc3QueWFtbFwiKSwgXCJjYXNlczogW11cXG5cIik7XG5cbiAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiYWRkXCIsIFwiLlwiXSwgeyBjd2Q6IGJhc2UsIHN0ZGlvOiBcImlnbm9yZVwiIH0pO1xuICAgIGV4ZWNGaWxlU3luYyhcbiAgICAgIFwiZ2l0XCIsXG4gICAgICBbXCJjb21taXRcIiwgXCItbVwiLCBcImZlYXQ6IG1hdGVyaWFsaXplIE0wMDEgZXZpZGVuY2VcXG5cXG5HU0QtVGFzazogUzAxL1QwMVwiXSxcbiAgICAgIHsgY3dkOiBiYXNlLCBzdGRpbzogXCJpZ25vcmVcIiB9LFxuICAgICk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBoYXNJbXBsZW1lbnRhdGlvbkFydGlmYWN0cyhiYXNlLCBcIk0wMDFcIik7XG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgcmVzdWx0LFxuICAgICAgXCJwcmVzZW50XCIsXG4gICAgICBcIm1pbGVzdG9uZS10YWdnZWQgY29tbWl0IGJpbmRpbmcgbXVzdCB3b3JrIHdoZW4gLmdzZC8gaXMgZ2l0aWdub3JlZFwiLFxuICAgICk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJoYXNJbXBsZW1lbnRhdGlvbkFydGlmYWN0cyBiaW5kcyBHU0QtVGFzayB0cmFpbGVyIHRvIG1pbGVzdG9uZSB2aWEgREIgc3RhdGUgd2hlbiAuZ3NkLyBpcyBnaXRpZ25vcmVkXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VHaXRCYXNlKCk7XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdpdFwiLCBcImluZm9cIiwgXCJleGNsdWRlXCIpLCBcIi5nc2QvXFxuXCIpO1xuICAgIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpKTtcbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIk1pbGVzdG9uZSBPbmVcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuICAgIGluc2VydFNsaWNlKHtcbiAgICAgIGlkOiBcIlMwMVwiLFxuICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgdGl0bGU6IFwiU2xpY2UgT25lXCIsXG4gICAgICBzdGF0dXM6IFwiY29tcGxldGVcIixcbiAgICAgIHJpc2s6IFwibG93XCIsXG4gICAgICBkZXBlbmRzOiBbXSxcbiAgICB9KTtcbiAgICBpbnNlcnRUYXNrKHtcbiAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgc2xpY2VJZDogXCJTMDFcIixcbiAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICAgIHRpdGxlOiBcIlRhc2sgT25lXCIsXG4gICAgICBzdGF0dXM6IFwiY29tcGxldGVcIixcbiAgICB9KTtcblxuICAgIG1rZGlyU3luYyhqb2luKGJhc2UsIFwic3JjXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCJzcmNcIiwgXCJmZWF0dXJlLnRzXCIpLCBcImV4cG9ydCBmdW5jdGlvbiBmZWF0dXJlKCkge31cXG5cIik7XG4gICAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcImFkZFwiLCBcIi5cIl0sIHsgY3dkOiBiYXNlLCBzdGRpbzogXCJpZ25vcmVcIiB9KTtcbiAgICBleGVjRmlsZVN5bmMoXG4gICAgICBcImdpdFwiLFxuICAgICAgW1wiY29tbWl0XCIsIFwiLW1cIiwgXCJmZWF0OiBhZGQgZmVhdHVyZVxcblxcbkdTRC1UYXNrOiBTMDEvVDAxXCJdLFxuICAgICAgeyBjd2Q6IGJhc2UsIHN0ZGlvOiBcImlnbm9yZVwiIH0sXG4gICAgKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGhhc0ltcGxlbWVudGF0aW9uQXJ0aWZhY3RzKGJhc2UsIFwiTTAwMVwiKTtcbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICByZXN1bHQsXG4gICAgICBcInByZXNlbnRcIixcbiAgICAgIFwiREIgdGFzayBvd25lcnNoaXAgc2hvdWxkIGJpbmQgUzAxL1QwMSBpbXBsZW1lbnRhdGlvbiBjb21taXRzIHRvIE0wMDEgd2l0aG91dCBleHBsaWNpdCBNMDAxIHRleHRcIixcbiAgICApO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiaGFzSW1wbGVtZW50YXRpb25BcnRpZmFjdHMgZG9lcyBub3QgYmluZCBHU0QtVGFzayB0cmFpbGVyIHdpdGhvdXQgbWlsZXN0b25lIG93bmVyc2hpcCBldmlkZW5jZVwiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlR2l0QmFzZSgpO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5naXRcIiwgXCJpbmZvXCIsIFwiZXhjbHVkZVwiKSwgXCIuZ3NkL1xcblwiKTtcbiAgICBta2RpclN5bmMoam9pbihiYXNlLCBcInNyY1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwic3JjXCIsIFwiZmVhdHVyZS50c1wiKSwgXCJleHBvcnQgZnVuY3Rpb24gZmVhdHVyZSgpIHt9XFxuXCIpO1xuICAgIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJhZGRcIiwgXCIuXCJdLCB7IGN3ZDogYmFzZSwgc3RkaW86IFwiaWdub3JlXCIgfSk7XG4gICAgZXhlY0ZpbGVTeW5jKFxuICAgICAgXCJnaXRcIixcbiAgICAgIFtcImNvbW1pdFwiLCBcIi1tXCIsIFwiZmVhdDogYWRkIGZlYXR1cmVcXG5cXG5HU0QtVGFzazogUzAxL1QwMVwiXSxcbiAgICAgIHsgY3dkOiBiYXNlLCBzdGRpbzogXCJpZ25vcmVcIiB9LFxuICAgICk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBoYXNJbXBsZW1lbnRhdGlvbkFydGlmYWN0cyhiYXNlLCBcIk0wMDFcIik7XG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgcmVzdWx0LFxuICAgICAgXCJhYnNlbnRcIixcbiAgICAgIFwiUzAxL1QwMSBzaGFwZSBhbG9uZSBtdXN0IG5vdCBiaW5kIGFuIGltcGxlbWVudGF0aW9uIGNvbW1pdCB0byBNMDAxXCIsXG4gICAgKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcImhhc0ltcGxlbWVudGF0aW9uQXJ0aWZhY3RzIGlnbm9yZXMgbWFsZm9ybWVkIG1pbGVzdG9uZSBJRHMgaW4gY29tbWl0LW1lc3NhZ2UgZmFsbGJhY2tcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUdpdEJhc2UoKTtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ2l0XCIsIFwiaW5mb1wiLCBcImV4Y2x1ZGVcIiksIFwiLmdzZC9cXG5cIik7XG4gICAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCJzcmNcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcInNyY1wiLCBcImZlYXR1cmUudHNcIiksIFwiZXhwb3J0IGZ1bmN0aW9uIGZlYXR1cmUoKSB7fVxcblwiKTtcblxuICAgIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJhZGRcIiwgXCIuXCJdLCB7IGN3ZDogYmFzZSwgc3RkaW86IFwiaWdub3JlXCIgfSk7XG4gICAgZXhlY0ZpbGVTeW5jKFxuICAgICAgXCJnaXRcIixcbiAgICAgIFtcImNvbW1pdFwiLCBcIi1tXCIsIFwiZmVhdDogbWF0ZXJpYWxpemUgTTAwMShmb28gZXZpZGVuY2VcXG5cXG5HU0QtVGFzazogUzAxL1QwMVwiXSxcbiAgICAgIHsgY3dkOiBiYXNlLCBzdGRpbzogXCJpZ25vcmVcIiB9LFxuICAgICk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBoYXNJbXBsZW1lbnRhdGlvbkFydGlmYWN0cyhiYXNlLCBcIk0wMDEoXCIpO1xuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIHJlc3VsdCxcbiAgICAgIFwiYWJzZW50XCIsXG4gICAgICBcIm1hbGZvcm1lZCBtaWxlc3RvbmUgSURzIG11c3Qgbm90IGJpbmQgaW1wbGVtZW50YXRpb24gY29tbWl0cyB0aHJvdWdoIG1lc3NhZ2Ugc2Nhbm5pbmdcIixcbiAgICApO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiaGFzSW1wbGVtZW50YXRpb25BcnRpZmFjdHMgcmV0dXJucyB0cnVlIG9uIG5vbi1naXQgZGlyZWN0b3J5IChmYWlsLW9wZW4pXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IGpvaW4odG1wZGlyKCksIGBnc2QtdGVzdC1ub2dpdC0ke3JhbmRvbVVVSUQoKX1gKTtcbiAgbWtkaXJTeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IGhhc0ltcGxlbWVudGF0aW9uQXJ0aWZhY3RzKGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIFwidW5rbm93blwiLCBcInNob3VsZCByZXR1cm4gdW5rbm93biAoZmFpbC1vcGVuKSBpbiBub24tZ2l0IGRpcmVjdG9yeVwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3Q6IGNvbXBsZXRlLW1pbGVzdG9uZSByZXF1aXJlcyBpbXBsIGFydGlmYWN0cyAoIzE3MDMpIFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwidmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdCBjb21wbGV0ZS1taWxlc3RvbmUgZmFpbHMgd2l0aCBvbmx5IC5nc2QvIGZpbGVzICgjMTcwMylcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUdpdEJhc2UoKTtcbiAgdHJ5IHtcbiAgICAvLyBDcmVhdGUgZmVhdHVyZSBicmFuY2ggd2l0aCBvbmx5IC5nc2QvIGZpbGVzXG4gICAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcImNoZWNrb3V0XCIsIFwiLWJcIiwgXCJmZWF0L21zLW9ubHktZ3NkXCJdLCB7IGN3ZDogYmFzZSwgc3RkaW86IFwiaWdub3JlXCIgfSk7XG4gICAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcIk0wMDEtU1VNTUFSWS5tZFwiKSwgXCIjIE1pbGVzdG9uZSBTdW1tYXJ5XFxuRG9uZS5cIik7XG4gICAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcImFkZFwiLCBcIi5cIl0sIHsgY3dkOiBiYXNlLCBzdGRpbzogXCJpZ25vcmVcIiB9KTtcbiAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiY29tbWl0XCIsIFwiLW1cIiwgXCJjaG9yZTogbWlsZXN0b25lIHBsYW4gZmlsZXNcIl0sIHsgY3dkOiBiYXNlLCBzdGRpbzogXCJpZ25vcmVcIiB9KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QoXCJjb21wbGV0ZS1taWxlc3RvbmVcIiwgXCJNMDAxXCIsIGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIGZhbHNlLCBcImNvbXBsZXRlLW1pbGVzdG9uZSBzaG91bGQgZmFpbCB2ZXJpZmljYXRpb24gd2hlbiBvbmx5IC5nc2QvIGZpbGVzIHByZXNlbnRcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJ2ZXJpZnlFeHBlY3RlZEFydGlmYWN0IGNvbXBsZXRlLW1pbGVzdG9uZSBwYXNzZXMgd2l0aCBpbXBsIGZpbGVzICgjMTcwMylcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUdpdEJhc2UoKTtcbiAgdHJ5IHtcbiAgICAvLyBDcmVhdGUgZmVhdHVyZSBicmFuY2ggd2l0aCBpbXBsZW1lbnRhdGlvbiBmaWxlcyBBTkQgbWlsZXN0b25lIHN1bW1hcnlcbiAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiY2hlY2tvdXRcIiwgXCItYlwiLCBcImZlYXQvbXMtd2l0aC1pbXBsXCJdLCB7IGN3ZDogYmFzZSwgc3RkaW86IFwiaWdub3JlXCIgfSk7XG4gICAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcIk0wMDEtU1VNTUFSWS5tZFwiKSwgXCIjIE1pbGVzdG9uZSBTdW1tYXJ5XFxuRG9uZS5cIik7XG4gICAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCJzcmNcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcInNyY1wiLCBcImFwcC50c1wiKSwgXCJjb25zb2xlLmxvZygnaGVsbG8nKTtcIik7XG4gICAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcImFkZFwiLCBcIi5cIl0sIHsgY3dkOiBiYXNlLCBzdGRpbzogXCJpZ25vcmVcIiB9KTtcbiAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiY29tbWl0XCIsIFwiLW1cIiwgXCJmZWF0OiBpbXBsZW1lbnRhdGlvblwiXSwgeyBjd2Q6IGJhc2UsIHN0ZGlvOiBcImlnbm9yZVwiIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gdmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdChcImNvbXBsZXRlLW1pbGVzdG9uZVwiLCBcIk0wMDFcIiwgYmFzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgdHJ1ZSwgXCJjb21wbGV0ZS1taWxlc3RvbmUgc2hvdWxkIHBhc3MgdmVyaWZpY2F0aW9uIHdpdGggaW1wbGVtZW50YXRpb24gZmlsZXNcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJ2ZXJpZnlFeHBlY3RlZEFydGlmYWN0IGNvbXBsZXRlLW1pbGVzdG9uZSBwYXNzZXMgb24gbWFpbiByZXRyeSB3aXRoIG1pbGVzdG9uZSBpbXBsZW1lbnRhdGlvbiBjb21taXRzICgjNDY5OSlcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUdpdEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwiTTAwMS1TVU1NQVJZLm1kXCIpLCBcIiMgTWlsZXN0b25lIFN1bW1hcnlcXG5Eb25lLlwiKTtcbiAgICBta2RpclN5bmMoam9pbihiYXNlLCBcInNyY1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIiwgXCJ0YXNrc1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwic3JjXCIsIFwiYXBwLnRzXCIpLCBcImNvbnNvbGUubG9nKCdoZWxsbycpO1wiKTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIiwgXCJ0YXNrc1wiLCBcIlQwMS1TVU1NQVJZLm1kXCIpLCBcIiMgU3VtbWFyeVwiKTtcbiAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiYWRkXCIsIFwiLlwiXSwgeyBjd2Q6IGJhc2UsIHN0ZGlvOiBcImlnbm9yZVwiIH0pO1xuICAgIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJjb21taXRcIiwgXCItbVwiLCBcImZlYXQ6IGltcGxlbWVudGF0aW9uIGFscmVhZHkgb24gbWFpblxcblxcbkdTRC1UYXNrOiBTMDEvVDAxXCJdLCB7IGN3ZDogYmFzZSwgc3RkaW86IFwiaWdub3JlXCIgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0KFwiY29tcGxldGUtbWlsZXN0b25lXCIsIFwiTTAwMVwiLCBiYXNlKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCB0cnVlLCBcImNvbXBsZXRlLW1pbGVzdG9uZSBzaG91bGQgbm90IGZhaWwgc29sZWx5IGJlY2F1c2UgSEVBRCB2cyBtYWluIGlzIGEgc2VsZi1kaWZmXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwidmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdCBjb21wbGV0ZS1taWxlc3RvbmUgZmFpbHMgd2hlbiBEQiBtaWxlc3RvbmUgaXMgbm90IGNvbXBsZXRlICgjNDY1OClcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUdpdEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiY2hlY2tvdXRcIiwgXCItYlwiLCBcImZlYXQvbXMtZGItYWN0aXZlXCJdLCB7IGN3ZDogYmFzZSwgc3RkaW86IFwiaWdub3JlXCIgfSk7XG4gICAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcIk0wMDEtU1VNTUFSWS5tZFwiKSwgXCIjIE1pbGVzdG9uZSBTdW1tYXJ5XFxudmVyaWZpY2F0aW9uIEZBSUxFRCBcdTIwMTQgbm90IGNvbXBsZXRlLlwiKTtcbiAgICBta2RpclN5bmMoam9pbihiYXNlLCBcInNyY1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwic3JjXCIsIFwiYXBwLnRzXCIpLCBcImNvbnNvbGUubG9nKCdoZWxsbycpO1wiKTtcbiAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiYWRkXCIsIFwiLlwiXSwgeyBjd2Q6IGJhc2UsIHN0ZGlvOiBcImlnbm9yZVwiIH0pO1xuICAgIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJjb21taXRcIiwgXCItbVwiLCBcImZlYXQ6IGltcGxlbWVudGF0aW9uIHdpdGggZmFpbGVkIHN1bW1hcnlcIl0sIHsgY3dkOiBiYXNlLCBzdGRpbzogXCJpZ25vcmVcIiB9KTtcblxuICAgIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsIFwiLmdzZFwiLCBcImdzZC5kYlwiKSk7XG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJNaWxlc3RvbmUgT25lXCIsIHN0YXR1czogXCJhY3RpdmVcIiB9KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QoXCJjb21wbGV0ZS1taWxlc3RvbmVcIiwgXCJNMDAxXCIsIGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIGZhbHNlLCBcImNvbXBsZXRlLW1pbGVzdG9uZSBtdXN0IGZhaWwgd2hlbiBEQiBzdGF0dXMgaXMgbm90IGNvbXBsZXRlXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwidmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdCBjb21wbGV0ZS1taWxlc3RvbmUgcGFzc2VzIHdoZW4gREIgbWlsZXN0b25lIGlzIGNvbXBsZXRlICgjNDY1OClcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUdpdEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiY2hlY2tvdXRcIiwgXCItYlwiLCBcImZlYXQvbXMtZGItY29tcGxldGVcIl0sIHsgY3dkOiBiYXNlLCBzdGRpbzogXCJpZ25vcmVcIiB9KTtcbiAgICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwiTTAwMS1TVU1NQVJZLm1kXCIpLCBcIiMgTWlsZXN0b25lIFN1bW1hcnlcXG5Eb25lLlwiKTtcbiAgICBta2RpclN5bmMoam9pbihiYXNlLCBcInNyY1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwic3JjXCIsIFwiYXBwLnRzXCIpLCBcImNvbnNvbGUubG9nKCdoZWxsbycpO1wiKTtcbiAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiYWRkXCIsIFwiLlwiXSwgeyBjd2Q6IGJhc2UsIHN0ZGlvOiBcImlnbm9yZVwiIH0pO1xuICAgIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJjb21taXRcIiwgXCItbVwiLCBcImZlYXQ6IGltcGxlbWVudGF0aW9uIGNvbXBsZXRlXCJdLCB7IGN3ZDogYmFzZSwgc3RkaW86IFwiaWdub3JlXCIgfSk7XG5cbiAgICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJnc2QuZGJcIikpO1xuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiTWlsZXN0b25lIE9uZVwiLCBzdGF0dXM6IFwiY29tcGxldGVcIiB9KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QoXCJjb21wbGV0ZS1taWxlc3RvbmVcIiwgXCJNMDAxXCIsIGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIHRydWUsIFwiY29tcGxldGUtbWlsZXN0b25lIHNob3VsZCBwYXNzIHdoZW4gREIgc3RhdHVzIGlzIGNvbXBsZXRlXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwidmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdCBjb21wbGV0ZS1taWxlc3RvbmUgdG9sZXJhdGVzIHRyYW5zaWVudCBEQiBsYWcgd2hlbiBTVU1NQVJZIGlzIGNhbm9uaWNhbCBzdWNjZXNzICgjNDY1OClcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUdpdEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiY2hlY2tvdXRcIiwgXCItYlwiLCBcImZlYXQvbXMtZGItbGFnLXN1Y2Nlc3NcIl0sIHsgY3dkOiBiYXNlLCBzdGRpbzogXCJpZ25vcmVcIiB9KTtcbiAgICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJNMDAxLVNVTU1BUlkubWRcIiksXG4gICAgICBbXG4gICAgICAgIFwiLS0tXCIsXG4gICAgICAgIFwiaWQ6IE0wMDFcIixcbiAgICAgICAgXCJzdGF0dXM6IGNvbXBsZXRlXCIsXG4gICAgICAgIFwiLS0tXCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiIyBNMDAxOiBTdWNjZXNzXCIsXG4gICAgICBdLmpvaW4oXCJcXG5cIiksXG4gICAgKTtcbiAgICBta2RpclN5bmMoam9pbihiYXNlLCBcInNyY1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwic3JjXCIsIFwiYXBwLnRzXCIpLCBcImNvbnNvbGUubG9nKCdoZWxsbycpO1wiKTtcbiAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiYWRkXCIsIFwiLlwiXSwgeyBjd2Q6IGJhc2UsIHN0ZGlvOiBcImlnbm9yZVwiIH0pO1xuICAgIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJjb21taXRcIiwgXCItbVwiLCBcImZlYXQ6IGltcGxlbWVudGF0aW9uIHdpdGggc3RhbGUgZGJcIl0sIHsgY3dkOiBiYXNlLCBzdGRpbzogXCJpZ25vcmVcIiB9KTtcblxuICAgIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsIFwiLmdzZFwiLCBcImdzZC5kYlwiKSk7XG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJNaWxlc3RvbmUgT25lXCIsIHN0YXR1czogXCJhY3RpdmVcIiB9KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QoXCJjb21wbGV0ZS1taWxlc3RvbmVcIiwgXCJNMDAxXCIsIGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIHRydWUsIFwiY2Fub25pY2FsIHN1Y2Nlc3MgU1VNTUFSWSBzaG91bGQgcGFzcyB2ZXJpZmljYXRpb24gZHVyaW5nIHRyYW5zaWVudCBEQiBsYWdcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJ2ZXJpZnlFeHBlY3RlZEFydGlmYWN0IGNoZWNrcyBwZW5kaW5nIGdhdGUtZXZhbHVhdGUgYXJ0aWZhY3RzIHdpdGhvdXQgRVNNIHJlcXVpcmUgZmFpbHVyZXNcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcFByb2plY3QoKTtcblxuICBjb25zdCB2ZXJpZmllZCA9IHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QoXCJnYXRlLWV2YWx1YXRlXCIsIFwiTTAwMS9TMDEvZ2F0ZXMrUTNcIiwgYmFzZSk7XG5cbiAgYXNzZXJ0LmVxdWFsKHZlcmlmaWVkLCBmYWxzZSwgXCJwZW5kaW5nIGdhdGVzIHNob3VsZCBrZWVwIGdhdGUtZXZhbHVhdGUgdW52ZXJpZmllZFwiKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgIzQ0MTQgcmVncmVzc2lvbnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCIjNDQxNDogd3JpdGVCbG9ja2VyUGxhY2Vob2xkZXIgaW52YWxpZGF0ZXMgcGF0aCBjYWNoZSBzbyBkaXNwYXRjaCBndWFyZCBzZWVzIGZpbGVcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICAvLyBQcmltZSB0aGUgcmVhZGRpciBjYWNoZSBieSByZXNvbHZpbmcgYSBESUZGRVJFTlQgZmlsZSBmaXJzdCBcdTIwMTQgdGhpc1xuICAgIC8vIG1pcnJvcnMgdGhlIHN0dWNrLWxvb3AgY29uZGl0aW9uIHdoZXJlIHRoZSBkaXNwYXRjaCBndWFyZCBjYWNoZWQgYW5cbiAgICAvLyBlbXB0eSBkaXJlY3RvcnkgbGlzdGluZyBiZWZvcmUgdGhlIHBsYWNlaG9sZGVyIHdhcyB3cml0dGVuLlxuICAgIGludmFsaWRhdGVBbGxDYWNoZXMoKTtcbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICByZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlLCBcIk0wMDFcIiwgXCJSRVNFQVJDSFwiKSxcbiAgICAgIG51bGwsXG4gICAgICBcIm5vIFJFU0VBUkNIIGZpbGUgeWV0XCIsXG4gICAgKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IHdyaXRlQmxvY2tlclBsYWNlaG9sZGVyKFxuICAgICAgXCJyZXNlYXJjaC1taWxlc3RvbmVcIixcbiAgICAgIFwiTTAwMVwiLFxuICAgICAgYmFzZSxcbiAgICAgIFwidmVyaWZpY2F0aW9uIHJldHJpZXMgZXhoYXVzdGVkXCIsXG4gICAgKTtcbiAgICBhc3NlcnQub2socmVzdWx0LCBcInBsYWNlaG9sZGVyIHBhdGggcmV0dXJuZWRcIik7XG5cbiAgICAvLyBBZnRlciB3cml0ZUJsb2NrZXJQbGFjZWhvbGRlciwgdGhlIGRpc3BhdGNoIGd1YXJkIG11c3Qgc2VlIHRoZSBuZXcgZmlsZVxuICAgIC8vIGltbWVkaWF0ZWx5IFx1MjAxNCBvdGhlcndpc2UgdGhlIHJ1bGUgcmUtZmlyZXMgKCM0NDE0LCA3XHUwMEQ3IHJlLWRpc3BhdGNoKS5cbiAgICBjb25zdCBwb3N0UmVzb2x2ZSA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2UsIFwiTTAwMVwiLCBcIlJFU0VBUkNIXCIpO1xuICAgIGFzc2VydC5vayhcbiAgICAgIHBvc3RSZXNvbHZlLFxuICAgICAgXCJyZXNvbHZlTWlsZXN0b25lRmlsZSBmaW5kcyB0aGUgcGxhY2Vob2xkZXIgcG9zdC13cml0ZSAoY2FjaGUgaW52YWxpZGF0ZWQpXCIsXG4gICAgKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcIiM0NDE0OiBwYXJhbGxlbC1yZXNlYXJjaCBzZW50aW5lbCBwYXRoIGRvZXMgbm90IGNvbGxpZGUgd2l0aCBSRVNFQVJDSCBzdWZmaXhcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICAvLyBXcml0ZSBvbmx5IHRoZSBwYXJhbGxlbC1yZXNlYXJjaCBibG9ja2VyIChzZW50aW5lbCkuXG4gICAgY29uc3Qgc2VudGluZWwgPSByZXNvbHZlRXhwZWN0ZWRBcnRpZmFjdFBhdGgoXG4gICAgICBcInJlc2VhcmNoLXNsaWNlXCIsXG4gICAgICBcIk0wMDEvcGFyYWxsZWwtcmVzZWFyY2hcIixcbiAgICAgIGJhc2UsXG4gICAgKTtcbiAgICBhc3NlcnQub2soc2VudGluZWwsIFwic2VudGluZWwgcGF0aCByZXNvbHZlcyBmb3IgcGFyYWxsZWwtcmVzZWFyY2hcIik7XG4gICAgd3JpdGVGaWxlU3luYyhzZW50aW5lbCEsIFwiIyBibG9ja2VyXFxuXCIsIFwidXRmLThcIik7XG5cbiAgICAvLyBDcml0aWNhbDogdGhlIHNlbnRpbmVsIGZpbGVuYW1lIG11c3QgTk9UIGJlIG1hdGNoZWQgYnkgdGhlIGxlZ2FjeSByZWdleFxuICAgIC8vIHVzZWQgd2hlbiBjYWxsZXJzIGxvb2sgdXAgbWlsZXN0b25lLWxldmVsIFJFU0VBUkNILiBPdGhlcndpc2UgdGhlXG4gICAgLy8gZGlzcGF0Y2ggZ3VhcmQgZm9yIHJlc2VhcmNoLW1pbGVzdG9uZSB3b3VsZCBzaG9ydC1jaXJjdWl0IGZhbHNlbHkuXG4gICAgY29uc3QgbWlsZXN0b25lUmVzZWFyY2ggPSByZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlLCBcIk0wMDFcIiwgXCJSRVNFQVJDSFwiKTtcbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICBtaWxlc3RvbmVSZXNlYXJjaCxcbiAgICAgIG51bGwsXG4gICAgICBcInNlbnRpbmVsIG11c3Qgbm90IGJlIG1pc3Rha2VuIGZvciBNMDAxLVJFU0VBUkNILm1kIHZpYSBsZWdhY3kgcGF0dGVybiBtYXRjaFwiLFxuICAgICk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCIjNDA2ODogdmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdCBwYXJhbGxlbC1yZXNlYXJjaCB0cmVhdHMgUEFSQUxMRUwtQkxPQ0tFUiBhcyB0ZXJtaW5hbCBjb21wbGV0aW9uXCIsICgpID0+IHtcbiAgLy8gUmVncmVzc2lvbjogd2hlbiBhIHBhcmFsbGVsLXJlc2VhcmNoIHVuaXQgdGltZXMgb3V0IGFuZCB0aGUgdGltZW91dC1yZWNvdmVyeVxuICAvLyBtYWNoaW5lcnkgd3JpdGVzIGEgUEFSQUxMRUwtQkxPQ0tFUiBwbGFjZWhvbGRlciwgdmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdCBtdXN0XG4gIC8vIHJldHVybiB0cnVlIHNvIHRoZSBkaXNwYXRjaCBsb29wIGNhbiBhZHZhbmNlLiAgUHJldmlvdXNseSBpdCBvbmx5IHJldHVybmVkXG4gIC8vIHRydWUgd2hlbiBldmVyeSBzbGljZSBoYWQgYSBSRVNFQVJDSCBmaWxlIFx1MjAxNCBtZWFuaW5nIGEgdGltZW91dCBhbHdheXMgbGVmdFxuICAvLyB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0IHJldHVybmluZyBmYWxzZSwgdGhlIHVuaXQgd2FzIG5ldmVyIGNsZWFyZWQgZnJvbVxuICAvLyB1bml0RGlzcGF0Y2hDb3VudCwgYW5kIHRoZSBkaXNwYXRjaCBydWxlIHJlLWZpcmVkIG9uIHRoZSBuZXh0IGl0ZXJhdGlvblxuICAvLyAoaW5maW5pdGUgbG9vcCwgaXNzdWUgIzQwNjggLyAjNDM1NSkuXG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIC8vIFdyaXRlIGEgbWluaW1hbCByb2FkbWFwXG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJNMDAxLVJPQURNQVAubWRcIiksXG4gICAgICBbXG4gICAgICAgIFwiIyBNMDAxOiBUaW1lb3V0IFRlc3RcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCIjIyBTbGljZXNcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCItIFsgXSAqKlMwMTogQWxwaGEqKiBgcmlzazpsb3dgIGBkZXBlbmRzOltdYFwiLFxuICAgICAgICBcIi0gWyBdICoqUzAyOiBCZXRhKiogYHJpc2s6bG93YCBgZGVwZW5kczpbXWBcIixcbiAgICAgICAgXCJcIixcbiAgICAgIF0uam9pbihcIlxcblwiKSxcbiAgICAgIFwidXRmLThcIixcbiAgICApO1xuXG4gICAgLy8gTm8gUkVTRUFSQ0ggZmlsZXMgd3JpdHRlbiBcdTIwMTQgc3ViYWdlbnRzIHRpbWVkIG91dFxuICAgIGNsZWFyUGFyc2VDYWNoZSgpO1xuICAgIGludmFsaWRhdGVBbGxDYWNoZXMoKTtcblxuICAgIC8vIFNpbXVsYXRlIHRpbWVvdXQtcmVjb3Zlcnkgd3JpdGluZyB0aGUgUEFSQUxMRUwtQkxPQ0tFUiBwbGFjZWhvbGRlclxuICAgIGNvbnN0IGJsb2NrZXJQYXRoID0gcmVzb2x2ZUV4cGVjdGVkQXJ0aWZhY3RQYXRoKFwicmVzZWFyY2gtc2xpY2VcIiwgXCJNMDAxL3BhcmFsbGVsLXJlc2VhcmNoXCIsIGJhc2UpO1xuICAgIGFzc2VydC5vayhibG9ja2VyUGF0aCwgXCJQQVJBTExFTC1CTE9DS0VSIHBhdGggbXVzdCByZXNvbHZlIGZvciBwYXJhbGxlbC1yZXNlYXJjaCB1bml0XCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoYmxvY2tlclBhdGghLCBcIiMgQkxPQ0tFUiBcdTIwMTQgdGltZW91dCByZWNvdmVyeVxcblxcbioqUmVhc29uKio6IGhhcmQgdGltZW91dC5cXG5cIiwgXCJ1dGYtOFwiKTtcblxuICAgIGNsZWFyUGFyc2VDYWNoZSgpO1xuICAgIGludmFsaWRhdGVBbGxDYWNoZXMoKTtcblxuICAgIC8vIEFmdGVyIGJsb2NrZXIgaXMgd3JpdHRlbiwgdmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdCBtdXN0IHJldHVybiB0cnVlXG4gICAgLy8gc28gdGhlIGRpc3BhdGNoIGxvb3AgdHJlYXRzIHRoaXMgdW5pdCBhcyBjb21wbGV0ZSBhbmQgbW92ZXMgb24uXG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgdmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdChcInJlc2VhcmNoLXNsaWNlXCIsIFwiTTAwMS9wYXJhbGxlbC1yZXNlYXJjaFwiLCBiYXNlKSxcbiAgICAgIHRydWUsXG4gICAgICBcIiM0MDY4OiBQQVJBTExFTC1CTE9DS0VSIG9uIGRpc2sgbXVzdCBzYXRpc2Z5IHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3Qgc28gdGhlIGxvb3AgZG9lcyBub3QgcmUtZGlzcGF0Y2hcIixcbiAgICApO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiIzQ0MTQ6IHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QgcGFyYWxsZWwtcmVzZWFyY2ggc3VjY2VlZHMgd2hlbiBhbGwgcmVzZWFyY2gtcmVhZHkgc2xpY2VzIGhhdmUgUkVTRUFSQ0hcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMlwiLCBcInRhc2tzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwM1wiLCBcInRhc2tzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAgIC8vIE1pbmltYWwgcm9hZG1hcCB3aXRoIHRocmVlIHNsaWNlc1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwiTTAwMS1ST0FETUFQLm1kXCIpLFxuICAgICAgW1xuICAgICAgICBcIiMgTTAwMTogUmVncmVzc2lvblwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIiMjIFNsaWNlc1wiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIi0gWyBdICoqUzAxOiBBbHBoYSoqIGByaXNrOmxvd2AgYGRlcGVuZHM6W11gXCIsXG4gICAgICAgIFwiLSBbIF0gKipTMDI6IEJldGEqKiBgcmlzazpsb3dgIGBkZXBlbmRzOltdYFwiLFxuICAgICAgICBcIi0gWyBdICoqUzAzOiBHYW1tYSoqIGByaXNrOmxvd2AgYGRlcGVuZHM6W11gXCIsXG4gICAgICAgIFwiXCIsXG4gICAgICBdLmpvaW4oXCJcXG5cIiksXG4gICAgICBcInV0Zi04XCIsXG4gICAgKTtcblxuICAgIC8vIE9ubHkgMiBvZiAzIGhhdmUgUkVTRUFSQ0ggXHUyMDE0IHNob3VsZCBmYWlsIHZlcmlmaWNhdGlvblxuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIsIFwiUzAxLVJFU0VBUkNILm1kXCIpLFxuICAgICAgXCIjIHJlc2VhcmNoXCIsXG4gICAgICBcInV0Zi04XCIsXG4gICAgKTtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMlwiLCBcIlMwMi1SRVNFQVJDSC5tZFwiKSxcbiAgICAgIFwiIyByZXNlYXJjaFwiLFxuICAgICAgXCJ1dGYtOFwiLFxuICAgICk7XG5cbiAgICBjbGVhclBhcnNlQ2FjaGUoKTtcbiAgICBpbnZhbGlkYXRlQWxsQ2FjaGVzKCk7XG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgdmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdChcInJlc2VhcmNoLXNsaWNlXCIsIFwiTTAwMS9wYXJhbGxlbC1yZXNlYXJjaFwiLCBiYXNlKSxcbiAgICAgIGZhbHNlLFxuICAgICAgXCJtaXNzaW5nIFMwMyBSRVNFQVJDSCBcdTIxOTIgdmVyaWZpY2F0aW9uIGZhaWxzXCIsXG4gICAgKTtcblxuICAgIC8vIEFsbCB0aHJlZSBSRVNFQVJDSCBwcmVzZW50IFx1MjE5MiB2ZXJpZmljYXRpb24gcGFzc2VzXG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDNcIiwgXCJTMDMtUkVTRUFSQ0gubWRcIiksXG4gICAgICBcIiMgcmVzZWFyY2hcIixcbiAgICAgIFwidXRmLThcIixcbiAgICApO1xuICAgIGNsZWFyUGFyc2VDYWNoZSgpO1xuICAgIGludmFsaWRhdGVBbGxDYWNoZXMoKTtcbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0KFwicmVzZWFyY2gtc2xpY2VcIiwgXCJNMDAxL3BhcmFsbGVsLXJlc2VhcmNoXCIsIGJhc2UpLFxuICAgICAgdHJ1ZSxcbiAgICAgIFwiYWxsIHNsaWNlcyBoYXZlIFJFU0VBUkNIIFx1MjE5MiB2ZXJpZmljYXRpb24gcGFzc2VzXCIsXG4gICAgKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLE9BQU8sUUFBUSxpQkFBaUI7QUFDaEMsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxXQUFXLFFBQVEscUJBQStDO0FBQ3hGLFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFDdkIsU0FBUyxrQkFBa0I7QUFFM0IsU0FBUyx3QkFBd0IsNEJBQTRCLDZCQUE2QiwwQkFBMEIsa0NBQWtDLDJCQUEyQix5QkFBeUIsb0NBQW9DO0FBQzlPLFNBQVMsNEJBQTRCO0FBQ3JDLFNBQVMsY0FBYyxlQUFlLGlCQUFpQixhQUFhLGVBQWUsWUFBWSx5Q0FBeUM7QUFDeEksU0FBUyx1QkFBdUI7QUFDaEMsU0FBUyxvQkFBb0I7QUFDN0IsU0FBUywyQkFBMkI7QUFDcEMsU0FBUyxhQUFhLDRCQUE0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
