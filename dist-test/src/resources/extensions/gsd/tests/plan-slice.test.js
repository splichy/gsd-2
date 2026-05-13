import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, closeDatabase, insertMilestone, insertSlice, getSlice, getSliceTasks, getTask, getGateResults, updateTaskStatus } from "../gsd-db.js";
import { handlePlanSlice } from "../tools/plan-slice.js";
import { parsePlan } from "../parsers-legacy.js";
import { parseTaskPlanFile } from "../files.js";
import { deriveState, invalidateStateCache } from "../state.js";
function makeTmpBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-plan-slice-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S02", "tasks"), { recursive: true });
  mkdirSync(join(base, "src", "resources", "extensions", "gsd", "tools"), { recursive: true });
  writeFileSync(join(base, "src", "resources", "extensions", "gsd", "tools", "plan-milestone.ts"), "// fixture\n", "utf-8");
  writeFileSync(join(base, "src", "resources", "extensions", "gsd", "tools", "plan-task.ts"), "// fixture\n", "utf-8");
  writeFileSync(join(base, "stale-input.py"), "# fixture\n", "utf-8");
  return base;
}
function cleanup(base) {
  try {
    closeDatabase();
  } catch {
  }
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
  }
}
function seedParentSlice() {
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Planning slice", status: "pending", demo: "Rendered plans exist." });
}
function validParams() {
  return {
    milestoneId: "M001",
    sliceId: "S02",
    goal: "Persist slice planning through the DB.",
    successCriteria: "- Slice plan renders from DB\n- Task plan files are regenerated",
    proofLevel: "integration",
    integrationClosure: "Planning handlers now write DB rows and render plan artifacts.",
    observabilityImpact: "- Validation failures return structured errors\n- Cache invalidation is proven by parse-visible state updates",
    tasks: [
      {
        taskId: "T01",
        title: "Write slice handler",
        description: "Implement the slice planning handler.",
        estimate: "45m",
        files: ["src/resources/extensions/gsd/tools/plan-slice.ts"],
        verify: "node --test src/resources/extensions/gsd/tests/plan-slice.test.ts",
        inputs: ["src/resources/extensions/gsd/tools/plan-milestone.ts"],
        expectedOutput: ["src/resources/extensions/gsd/tools/plan-slice.ts"],
        observabilityImpact: "Tests exercise cache invalidation and render failure paths."
      },
      {
        taskId: "T02",
        title: "Write task handler",
        description: "Implement the task planning handler.",
        estimate: "30m",
        files: ["src/resources/extensions/gsd/tools/plan-task.ts"],
        verify: "node --test src/resources/extensions/gsd/tests/plan-task.test.ts",
        inputs: ["src/resources/extensions/gsd/tools/plan-task.ts"],
        expectedOutput: ["src/resources/extensions/gsd/tests/plan-task.test.ts"],
        observabilityImpact: "Task-plan renders remain parse-compatible."
      }
    ]
  };
}
test("handlePlanSlice writes slice/task planning state and renders plan artifacts", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedParentSlice();
    const result = await handlePlanSlice(validParams(), base);
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    const slice = getSlice("M001", "S02");
    assert.ok(slice);
    assert.equal(slice?.goal, "Persist slice planning through the DB.");
    assert.equal(slice?.proof_level, "integration");
    const tasks = getSliceTasks("M001", "S02");
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0]?.title, "Write slice handler");
    assert.equal(tasks[0]?.description, "Implement the slice planning handler.");
    assert.equal(tasks[1]?.estimate, "30m");
    const planPath = join(base, ".gsd", "milestones", "M001", "slices", "S02", "S02-PLAN.md");
    assert.ok(existsSync(planPath), "slice plan should be rendered to disk");
    const parsedPlan = parsePlan(readFileSync(planPath, "utf-8"));
    assert.equal(parsedPlan.goal, "Persist slice planning through the DB.");
    assert.equal(parsedPlan.tasks.length, 2);
    assert.equal(parsedPlan.tasks[0]?.id, "T01");
    const taskPlanPath = join(base, ".gsd", "milestones", "M001", "slices", "S02", "tasks", "T01-PLAN.md");
    assert.ok(existsSync(taskPlanPath), "task plan should be rendered to disk");
    const taskPlan = parseTaskPlanFile(readFileSync(taskPlanPath, "utf-8"));
    assert.deepEqual(taskPlan.frontmatter.skills_used, []);
  } finally {
    cleanup(base);
  }
});
test("handlePlanSlice advances DB-derived state out of planning immediately", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedParentSlice();
    invalidateStateCache();
    const before = await deriveState(base);
    assert.equal(before.phase, "planning");
    assert.equal(before.progress?.tasks?.total, 0);
    const result = await handlePlanSlice(validParams(), base);
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    invalidateStateCache();
    const after = await deriveState(base);
    assert.notEqual(after.phase, "planning");
    assert.equal(after.progress?.tasks?.total, 2);
  } finally {
    cleanup(base);
  }
});
test("handlePlanSlice clears sketch flag so DB-derived state leaves refining", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Planning slice", status: "pending", demo: "Rendered plans exist.", isSketch: true });
    invalidateStateCache();
    const before = await deriveState(base);
    assert.equal(before.phase, "refining");
    const result = await handlePlanSlice(validParams(), base);
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    assert.equal(getSlice("M001", "S02")?.is_sketch, 0, "planned slice must no longer be treated as a sketch");
    invalidateStateCache();
    const after = await deriveState(base);
    assert.notEqual(after.phase, "refining");
    assert.equal(after.progress?.tasks?.total, 2);
  } finally {
    cleanup(base);
  }
});
test("handlePlanSlice leaves omitted enrichment fields empty instead of rendering placeholders", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedParentSlice();
    const { successCriteria, proofLevel, integrationClosure, observabilityImpact, ...params } = validParams();
    void successCriteria;
    void proofLevel;
    void integrationClosure;
    void observabilityImpact;
    const result = await handlePlanSlice(params, base);
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    const slice = getSlice("M001", "S02");
    assert.ok(slice);
    assert.equal(slice?.success_criteria, "");
    assert.equal(slice?.proof_level, "");
    assert.equal(slice?.integration_closure, "");
    assert.equal(slice?.observability_impact, "");
    const planPath = join(base, ".gsd", "milestones", "M001", "slices", "S02", "S02-PLAN.md");
    const content = readFileSync(planPath, "utf-8");
    assert.doesNotMatch(content, /Not provided/i);
    assert.doesNotMatch(content, /^## Proof Level$/m);
    assert.doesNotMatch(content, /^## Integration Closure$/m);
    assert.match(content, /- Complete the planned slice outcomes\./);
  } finally {
    cleanup(base);
  }
});
test("handlePlanSlice rejects invalid payloads", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedParentSlice();
    const result = await handlePlanSlice({ ...validParams(), tasks: [] }, base);
    assert.ok("error" in result);
    assert.match(result.error, /validation failed: tasks must be a non-empty array/);
  } finally {
    cleanup(base);
  }
});
test("handlePlanSlice explains string task IO fields must be arrays", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedParentSlice();
    const result = await handlePlanSlice({
      ...validParams(),
      tasks: [
        {
          ...validParams().tasks[0],
          inputs: "src/index.ts"
        }
      ]
    }, base);
    assert.ok("error" in result);
    assert.match(result.error, /validation failed: tasks\[0\]\.inputs must be an array of strings, not string/);
  } finally {
    cleanup(base);
  }
});
test("handlePlanSlice rejects absolute task IO paths outside the active worktree", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedParentSlice();
    const outside = join(tmpdir(), "outside-checkout", "index.html");
    const result = await handlePlanSlice({
      ...validParams(),
      tasks: [
        {
          ...validParams().tasks[0],
          inputs: [outside],
          expectedOutput: [outside]
        }
      ]
    }, base);
    assert.ok("error" in result);
    assert.match(result.error, /validation failed: tasks\[0\]\.inputs contains absolute path outside working directory/);
    assert.equal(getSliceTasks("M001", "S02").length, 0, "invalid planning IO must not persist tasks");
  } finally {
    cleanup(base);
  }
});
test("handlePlanSlice rejects missing task input paths before persisting tasks", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedParentSlice();
    const result = await handlePlanSlice({
      ...validParams(),
      tasks: [
        {
          ...validParams().tasks[0],
          inputs: ["fixtures/missing-source.json"]
        }
      ]
    }, base);
    assert.ok("error" in result);
    assert.match(result.error, /pre-execution validation failed:/);
    assert.match(result.error, /fixtures\/missing-source\.json/);
    assert.equal(getSliceTasks("M001", "S02").length, 0, "invalid planning IO must not persist tasks");
  } finally {
    cleanup(base);
  }
});
test("handlePlanSlice rejects task input paths created by later tasks before persisting tasks", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedParentSlice();
    const params = validParams();
    const result = await handlePlanSlice({
      ...params,
      tasks: [
        {
          ...params.tasks[0],
          inputs: ["generated/report.json"],
          expectedOutput: ["generated/summary.json"]
        },
        {
          ...params.tasks[1],
          inputs: [],
          expectedOutput: ["generated/report.json"]
        }
      ]
    }, base);
    assert.ok("error" in result);
    assert.match(result.error, /pre-execution validation failed:/);
    assert.match(result.error, /sequence violation/);
    assert.equal(getSliceTasks("M001", "S02").length, 0, "invalid task ordering must not persist tasks");
  } finally {
    cleanup(base);
  }
});
test("handlePlanSlice accepts absolute task IO paths inside the active worktree", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedParentSlice();
    const inside = join(base, "index.html");
    const result = await handlePlanSlice({
      ...validParams(),
      tasks: [
        {
          ...validParams().tasks[0],
          inputs: [inside],
          expectedOutput: [inside]
        }
      ]
    }, base);
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
  } finally {
    cleanup(base);
  }
});
test("handlePlanSlice rejects missing parent slice", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    const result = await handlePlanSlice(validParams(), base);
    assert.ok("error" in result);
    assert.match(result.error, /missing parent slice: M001\/S02/);
  } finally {
    cleanup(base);
  }
});
test("handlePlanSlice surfaces render failures without changing parse-visible task-plan state for the failing task", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedParentSlice();
    const failingTaskPlanPath = join(base, ".gsd", "milestones", "M001", "slices", "S02", "tasks", "T01-PLAN.md");
    writeFileSync(failingTaskPlanPath, "---\nestimated_steps: 1\nestimated_files: 1\nskills_used: []\n---\n\n# T01: Cached task\n", "utf-8");
    rmSync(failingTaskPlanPath, { force: true });
    mkdirSync(failingTaskPlanPath, { recursive: true });
    const result = await handlePlanSlice(validParams(), base);
    assert.ok("error" in result);
    assert.match(result.error, /render failed:/);
    assert.ok(existsSync(failingTaskPlanPath), "failing task plan path should remain the blocking directory");
    assert.equal(getTask("M001", "S02", "T01")?.description, "Implement the slice planning handler.");
  } finally {
    cleanup(base);
  }
});
test("handlePlanSlice reactivates a deferred parent slice to pending", async (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Planning slice", status: "deferred", demo: "Rendered plans exist." });
  const result = await handlePlanSlice(validParams(), base);
  assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
  const slice = getSlice("M001", "S02");
  assert.ok(slice);
  assert.equal(slice?.status, "pending", "deferred slice must be reactivated to pending so auto-mode can dispatch it");
  assert.equal(slice?.goal, "Persist slice planning through the DB.");
});
test("handlePlanSlice reruns idempotently and refreshes parse-visible state", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedParentSlice();
    writeFileSync(join(base, ".gsd", "milestones", "M001", "slices", "S02", "S02-PLAN.md"), "# S02: Cached\n\n**Goal:** old value\n\n## Tasks\n\n- [ ] **T01: Cached task**\n", "utf-8");
    const first = await handlePlanSlice(validParams(), base);
    assert.ok(!("error" in first));
    const second = await handlePlanSlice({
      ...validParams(),
      goal: "Updated goal from rerun.",
      tasks: [
        { ...validParams().tasks[0], description: "Updated slice handler description." },
        validParams().tasks[1]
      ]
    }, base);
    assert.ok(!("error" in second));
    const parsedAfter = parsePlan(readFileSync(join(base, ".gsd", "milestones", "M001", "slices", "S02", "S02-PLAN.md"), "utf-8"));
    assert.equal(parsedAfter.goal, "Updated goal from rerun.");
    const task = getTask("M001", "S02", "T01");
    assert.equal(task?.description, "Updated slice handler description.");
  } finally {
    cleanup(base);
  }
});
test("handlePlanSlice removes omitted pending tasks when replanning a smaller task set", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedParentSlice();
    const fourTaskPlan = {
      ...validParams(),
      tasks: [
        ...validParams().tasks,
        { ...validParams().tasks[0], taskId: "T03", title: "Third task" },
        { ...validParams().tasks[0], taskId: "T04", title: "Stale task", inputs: ["stale-input.py"] }
      ]
    };
    const first = await handlePlanSlice(fourTaskPlan, base);
    assert.ok(!("error" in first), `unexpected error: ${"error" in first ? first.error : ""}`);
    const staleTaskPlanPath = join(base, ".gsd", "milestones", "M001", "slices", "S02", "tasks", "T04-PLAN.md");
    assert.ok(existsSync(staleTaskPlanPath), "initial plan should render T04");
    const second = await handlePlanSlice({
      ...validParams(),
      tasks: fourTaskPlan.tasks.filter((task) => task.taskId !== "T04")
    }, base);
    assert.ok(!("error" in second), `unexpected error: ${"error" in second ? second.error : ""}`);
    assert.deepEqual(getSliceTasks("M001", "S02").map((task) => task.id), ["T01", "T02", "T03"]);
    assert.equal(getGateResults("M001", "S02", "task").some((gate) => gate.task_id === "T04"), false);
    assert.equal(existsSync(staleTaskPlanPath), false, "omitted task plan artifact should be removed");
  } finally {
    cleanup(base);
  }
});
test("handlePlanSlice rejects omitted completed tasks without changing slice or task state", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedParentSlice();
    const fourTaskPlan = {
      ...validParams(),
      tasks: [
        ...validParams().tasks,
        { ...validParams().tasks[0], taskId: "T03", title: "Third task" },
        { ...validParams().tasks[0], taskId: "T04", title: "Stale task", inputs: ["stale-input.py"] }
      ]
    };
    const first = await handlePlanSlice(fourTaskPlan, base);
    assert.ok(!("error" in first), `unexpected error: ${"error" in first ? first.error : ""}`);
    const staleTaskPlanPath = join(base, ".gsd", "milestones", "M001", "slices", "S02", "tasks", "T04-PLAN.md");
    assert.ok(existsSync(staleTaskPlanPath), "initial plan should render T04");
    updateTaskStatus("M001", "S02", "T04", "complete", "2026-05-12T00:00:00.000Z");
    const tasksBefore = getSliceTasks("M001", "S02");
    const gatesBefore = getGateResults("M001", "S02", "task");
    const second = await handlePlanSlice({
      ...validParams(),
      goal: "Rejected replan should not persist.",
      tasks: fourTaskPlan.tasks.filter((task) => task.taskId !== "T04")
    }, base);
    assert.deepEqual(second, { error: "cannot remove completed task T04" });
    assert.equal(getSlice("M001", "S02")?.goal, "Persist slice planning through the DB.");
    assert.deepEqual(getSliceTasks("M001", "S02"), tasksBefore);
    assert.deepEqual(getGateResults("M001", "S02", "task"), gatesBefore);
    assert.ok(existsSync(staleTaskPlanPath), "completed task plan artifact should remain after rejected replan");
  } finally {
    cleanup(base);
  }
});
test("regression: validateTasks surfaces clean per-field errors for non-array IO inputs", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedParentSlice();
    for (const field of ["files", "inputs", "expectedOutput"]) {
      const result = await handlePlanSlice({
        ...validParams(),
        tasks: [{
          ...validParams().tasks[0],
          [field]: "not-an-array"
        }]
      }, base);
      assert.ok("error" in result, `${field}: expected validation error, got success`);
      assert.match(
        result.error,
        new RegExp(`tasks\\[0\\]\\.${field} must be an array`),
        `${field}: expected per-field validation message, got: ${result.error}`
      );
      assert.doesNotMatch(
        result.error,
        /is not defined/,
        `${field}: validation surfaced ReferenceError \u2014 likely a missing import in plan-slice.ts`
      );
      assert.equal(getSliceTasks("M001", "S02").length, 0, `${field}: invalid input must not persist`);
    }
  } finally {
    cleanup(base);
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wbGFuLXNsaWNlLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRCBFeHRlbnNpb24gXHUyMDE0IFBsYW4tc2xpY2UgdG9vbCBpbnRlZ3JhdGlvbiB0ZXN0cy5cblxuaW1wb3J0IHRlc3QgZnJvbSAnbm9kZTp0ZXN0JztcbmltcG9ydCBhc3NlcnQgZnJvbSAnbm9kZTphc3NlcnQvc3RyaWN0JztcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBta2RpclN5bmMsIHJtU3luYywgcmVhZEZpbGVTeW5jLCBleGlzdHNTeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSAnbm9kZTpmcyc7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJztcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gJ25vZGU6b3MnO1xuXG5pbXBvcnQgeyBvcGVuRGF0YWJhc2UsIGNsb3NlRGF0YWJhc2UsIGluc2VydE1pbGVzdG9uZSwgaW5zZXJ0U2xpY2UsIGdldFNsaWNlLCBnZXRTbGljZVRhc2tzLCBnZXRUYXNrLCBnZXRHYXRlUmVzdWx0cywgdXBkYXRlVGFza1N0YXR1cyB9IGZyb20gJy4uL2dzZC1kYi50cyc7XG5pbXBvcnQgeyBoYW5kbGVQbGFuU2xpY2UgfSBmcm9tICcuLi90b29scy9wbGFuLXNsaWNlLnRzJztcbmltcG9ydCB7IHBhcnNlUGxhbiB9IGZyb20gJy4uL3BhcnNlcnMtbGVnYWN5LnRzJztcbmltcG9ydCB7IHBhcnNlVGFza1BsYW5GaWxlIH0gZnJvbSAnLi4vZmlsZXMudHMnO1xuaW1wb3J0IHsgZGVyaXZlU3RhdGUsIGludmFsaWRhdGVTdGF0ZUNhY2hlIH0gZnJvbSAnLi4vc3RhdGUudHMnO1xuXG5mdW5jdGlvbiBtYWtlVG1wQmFzZSgpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgJ2dzZC1wbGFuLXNsaWNlLScpKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJywgJ3NsaWNlcycsICdTMDInLCAndGFza3MnKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIG1rZGlyU3luYyhqb2luKGJhc2UsICdzcmMnLCAncmVzb3VyY2VzJywgJ2V4dGVuc2lvbnMnLCAnZ3NkJywgJ3Rvb2xzJyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgJ3NyYycsICdyZXNvdXJjZXMnLCAnZXh0ZW5zaW9ucycsICdnc2QnLCAndG9vbHMnLCAncGxhbi1taWxlc3RvbmUudHMnKSwgJy8vIGZpeHR1cmVcXG4nLCAndXRmLTgnKTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsICdzcmMnLCAncmVzb3VyY2VzJywgJ2V4dGVuc2lvbnMnLCAnZ3NkJywgJ3Rvb2xzJywgJ3BsYW4tdGFzay50cycpLCAnLy8gZml4dHVyZVxcbicsICd1dGYtOCcpO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgJ3N0YWxlLWlucHV0LnB5JyksICcjIGZpeHR1cmVcXG4nLCAndXRmLTgnKTtcbiAgcmV0dXJuIGJhc2U7XG59XG5cbmZ1bmN0aW9uIGNsZWFudXAoYmFzZTogc3RyaW5nKTogdm9pZCB7XG4gIHRyeSB7IGNsb3NlRGF0YWJhc2UoKTsgfSBjYXRjaCB7IC8qIG5vb3AgKi8gfVxuICB0cnkgeyBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pOyB9IGNhdGNoIHsgLyogbm9vcCAqLyB9XG59XG5cbmZ1bmN0aW9uIHNlZWRQYXJlbnRTbGljZSgpOiB2b2lkIHtcbiAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdNaWxlc3RvbmUnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuICBpbnNlcnRTbGljZSh7IGlkOiAnUzAyJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdQbGFubmluZyBzbGljZScsIHN0YXR1czogJ3BlbmRpbmcnLCBkZW1vOiAnUmVuZGVyZWQgcGxhbnMgZXhpc3QuJyB9KTtcbn1cblxuZnVuY3Rpb24gdmFsaWRQYXJhbXMoKSB7XG4gIHJldHVybiB7XG4gICAgbWlsZXN0b25lSWQ6ICdNMDAxJyxcbiAgICBzbGljZUlkOiAnUzAyJyxcbiAgICBnb2FsOiAnUGVyc2lzdCBzbGljZSBwbGFubmluZyB0aHJvdWdoIHRoZSBEQi4nLFxuICAgIHN1Y2Nlc3NDcml0ZXJpYTogJy0gU2xpY2UgcGxhbiByZW5kZXJzIGZyb20gREJcXG4tIFRhc2sgcGxhbiBmaWxlcyBhcmUgcmVnZW5lcmF0ZWQnLFxuICAgIHByb29mTGV2ZWw6ICdpbnRlZ3JhdGlvbicsXG4gICAgaW50ZWdyYXRpb25DbG9zdXJlOiAnUGxhbm5pbmcgaGFuZGxlcnMgbm93IHdyaXRlIERCIHJvd3MgYW5kIHJlbmRlciBwbGFuIGFydGlmYWN0cy4nLFxuICAgIG9ic2VydmFiaWxpdHlJbXBhY3Q6ICctIFZhbGlkYXRpb24gZmFpbHVyZXMgcmV0dXJuIHN0cnVjdHVyZWQgZXJyb3JzXFxuLSBDYWNoZSBpbnZhbGlkYXRpb24gaXMgcHJvdmVuIGJ5IHBhcnNlLXZpc2libGUgc3RhdGUgdXBkYXRlcycsXG4gICAgdGFza3M6IFtcbiAgICAgIHtcbiAgICAgICAgdGFza0lkOiAnVDAxJyxcbiAgICAgICAgdGl0bGU6ICdXcml0ZSBzbGljZSBoYW5kbGVyJyxcbiAgICAgICAgZGVzY3JpcHRpb246ICdJbXBsZW1lbnQgdGhlIHNsaWNlIHBsYW5uaW5nIGhhbmRsZXIuJyxcbiAgICAgICAgZXN0aW1hdGU6ICc0NW0nLFxuICAgICAgICBmaWxlczogWydzcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL3Rvb2xzL3BsYW4tc2xpY2UudHMnXSxcbiAgICAgICAgdmVyaWZ5OiAnbm9kZSAtLXRlc3Qgc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wbGFuLXNsaWNlLnRlc3QudHMnLFxuICAgICAgICBpbnB1dHM6IFsnc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90b29scy9wbGFuLW1pbGVzdG9uZS50cyddLFxuICAgICAgICBleHBlY3RlZE91dHB1dDogWydzcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL3Rvb2xzL3BsYW4tc2xpY2UudHMnXSxcbiAgICAgICAgb2JzZXJ2YWJpbGl0eUltcGFjdDogJ1Rlc3RzIGV4ZXJjaXNlIGNhY2hlIGludmFsaWRhdGlvbiBhbmQgcmVuZGVyIGZhaWx1cmUgcGF0aHMuJyxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIHRhc2tJZDogJ1QwMicsXG4gICAgICAgIHRpdGxlOiAnV3JpdGUgdGFzayBoYW5kbGVyJyxcbiAgICAgICAgZGVzY3JpcHRpb246ICdJbXBsZW1lbnQgdGhlIHRhc2sgcGxhbm5pbmcgaGFuZGxlci4nLFxuICAgICAgICBlc3RpbWF0ZTogJzMwbScsXG4gICAgICAgIGZpbGVzOiBbJ3NyYy9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvdG9vbHMvcGxhbi10YXNrLnRzJ10sXG4gICAgICAgIHZlcmlmeTogJ25vZGUgLS10ZXN0IHNyYy9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvdGVzdHMvcGxhbi10YXNrLnRlc3QudHMnLFxuICAgICAgICBpbnB1dHM6IFsnc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90b29scy9wbGFuLXRhc2sudHMnXSxcbiAgICAgICAgZXhwZWN0ZWRPdXRwdXQ6IFsnc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wbGFuLXRhc2sudGVzdC50cyddLFxuICAgICAgICBvYnNlcnZhYmlsaXR5SW1wYWN0OiAnVGFzay1wbGFuIHJlbmRlcnMgcmVtYWluIHBhcnNlLWNvbXBhdGlibGUuJyxcbiAgICAgIH0sXG4gICAgXSxcbiAgfTtcbn1cblxudGVzdCgnaGFuZGxlUGxhblNsaWNlIHdyaXRlcyBzbGljZS90YXNrIHBsYW5uaW5nIHN0YXRlIGFuZCByZW5kZXJzIHBsYW4gYXJ0aWZhY3RzJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgJy5nc2QnLCAnZ3NkLmRiJykpO1xuXG4gIHRyeSB7XG4gICAgc2VlZFBhcmVudFNsaWNlKCk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVQbGFuU2xpY2UodmFsaWRQYXJhbXMoKSwgYmFzZSk7XG4gICAgYXNzZXJ0Lm9rKCEoJ2Vycm9yJyBpbiByZXN1bHQpLCBgdW5leHBlY3RlZCBlcnJvcjogJHsnZXJyb3InIGluIHJlc3VsdCA/IHJlc3VsdC5lcnJvciA6ICcnfWApO1xuXG4gICAgY29uc3Qgc2xpY2UgPSBnZXRTbGljZSgnTTAwMScsICdTMDInKTtcbiAgICBhc3NlcnQub2soc2xpY2UpO1xuICAgIGFzc2VydC5lcXVhbChzbGljZT8uZ29hbCwgJ1BlcnNpc3Qgc2xpY2UgcGxhbm5pbmcgdGhyb3VnaCB0aGUgREIuJyk7XG4gICAgYXNzZXJ0LmVxdWFsKHNsaWNlPy5wcm9vZl9sZXZlbCwgJ2ludGVncmF0aW9uJyk7XG5cbiAgICBjb25zdCB0YXNrcyA9IGdldFNsaWNlVGFza3MoJ00wMDEnLCAnUzAyJyk7XG4gICAgYXNzZXJ0LmVxdWFsKHRhc2tzLmxlbmd0aCwgMik7XG4gICAgYXNzZXJ0LmVxdWFsKHRhc2tzWzBdPy50aXRsZSwgJ1dyaXRlIHNsaWNlIGhhbmRsZXInKTtcbiAgICBhc3NlcnQuZXF1YWwodGFza3NbMF0/LmRlc2NyaXB0aW9uLCAnSW1wbGVtZW50IHRoZSBzbGljZSBwbGFubmluZyBoYW5kbGVyLicpO1xuICAgIGFzc2VydC5lcXVhbCh0YXNrc1sxXT8uZXN0aW1hdGUsICczMG0nKTtcblxuICAgIGNvbnN0IHBsYW5QYXRoID0gam9pbihiYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgJ00wMDEnLCAnc2xpY2VzJywgJ1MwMicsICdTMDItUExBTi5tZCcpO1xuICAgIGFzc2VydC5vayhleGlzdHNTeW5jKHBsYW5QYXRoKSwgJ3NsaWNlIHBsYW4gc2hvdWxkIGJlIHJlbmRlcmVkIHRvIGRpc2snKTtcbiAgICBjb25zdCBwYXJzZWRQbGFuID0gcGFyc2VQbGFuKHJlYWRGaWxlU3luYyhwbGFuUGF0aCwgJ3V0Zi04JykpO1xuICAgIGFzc2VydC5lcXVhbChwYXJzZWRQbGFuLmdvYWwsICdQZXJzaXN0IHNsaWNlIHBsYW5uaW5nIHRocm91Z2ggdGhlIERCLicpO1xuICAgIGFzc2VydC5lcXVhbChwYXJzZWRQbGFuLnRhc2tzLmxlbmd0aCwgMik7XG4gICAgYXNzZXJ0LmVxdWFsKHBhcnNlZFBsYW4udGFza3NbMF0/LmlkLCAnVDAxJyk7XG5cbiAgICBjb25zdCB0YXNrUGxhblBhdGggPSBqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScsICdzbGljZXMnLCAnUzAyJywgJ3Rhc2tzJywgJ1QwMS1QTEFOLm1kJyk7XG4gICAgYXNzZXJ0Lm9rKGV4aXN0c1N5bmModGFza1BsYW5QYXRoKSwgJ3Rhc2sgcGxhbiBzaG91bGQgYmUgcmVuZGVyZWQgdG8gZGlzaycpO1xuICAgIGNvbnN0IHRhc2tQbGFuID0gcGFyc2VUYXNrUGxhbkZpbGUocmVhZEZpbGVTeW5jKHRhc2tQbGFuUGF0aCwgJ3V0Zi04JykpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwodGFza1BsYW4uZnJvbnRtYXR0ZXIuc2tpbGxzX3VzZWQsIFtdKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdCgnaGFuZGxlUGxhblNsaWNlIGFkdmFuY2VzIERCLWRlcml2ZWQgc3RhdGUgb3V0IG9mIHBsYW5uaW5nIGltbWVkaWF0ZWx5JywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgJy5nc2QnLCAnZ3NkLmRiJykpO1xuXG4gIHRyeSB7XG4gICAgc2VlZFBhcmVudFNsaWNlKCk7XG5cbiAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgIGNvbnN0IGJlZm9yZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChiZWZvcmUucGhhc2UsICdwbGFubmluZycpO1xuICAgIGFzc2VydC5lcXVhbChiZWZvcmUucHJvZ3Jlc3M/LnRhc2tzPy50b3RhbCwgMCk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVQbGFuU2xpY2UodmFsaWRQYXJhbXMoKSwgYmFzZSk7XG4gICAgYXNzZXJ0Lm9rKCEoJ2Vycm9yJyBpbiByZXN1bHQpLCBgdW5leHBlY3RlZCBlcnJvcjogJHsnZXJyb3InIGluIHJlc3VsdCA/IHJlc3VsdC5lcnJvciA6ICcnfWApO1xuXG4gICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICBjb25zdCBhZnRlciA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuICAgIGFzc2VydC5ub3RFcXVhbChhZnRlci5waGFzZSwgJ3BsYW5uaW5nJyk7XG4gICAgYXNzZXJ0LmVxdWFsKGFmdGVyLnByb2dyZXNzPy50YXNrcz8udG90YWwsIDIpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KCdoYW5kbGVQbGFuU2xpY2UgY2xlYXJzIHNrZXRjaCBmbGFnIHNvIERCLWRlcml2ZWQgc3RhdGUgbGVhdmVzIHJlZmluaW5nJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgJy5nc2QnLCAnZ3NkLmRiJykpO1xuXG4gIHRyeSB7XG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdNaWxlc3RvbmUnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuICAgIGluc2VydFNsaWNlKHsgaWQ6ICdTMDInLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ1BsYW5uaW5nIHNsaWNlJywgc3RhdHVzOiAncGVuZGluZycsIGRlbW86ICdSZW5kZXJlZCBwbGFucyBleGlzdC4nLCBpc1NrZXRjaDogdHJ1ZSB9KTtcblxuICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgY29uc3QgYmVmb3JlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKGJlZm9yZS5waGFzZSwgJ3JlZmluaW5nJyk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVQbGFuU2xpY2UodmFsaWRQYXJhbXMoKSwgYmFzZSk7XG4gICAgYXNzZXJ0Lm9rKCEoJ2Vycm9yJyBpbiByZXN1bHQpLCBgdW5leHBlY3RlZCBlcnJvcjogJHsnZXJyb3InIGluIHJlc3VsdCA/IHJlc3VsdC5lcnJvciA6ICcnfWApO1xuICAgIGFzc2VydC5lcXVhbChnZXRTbGljZSgnTTAwMScsICdTMDInKT8uaXNfc2tldGNoLCAwLCAncGxhbm5lZCBzbGljZSBtdXN0IG5vIGxvbmdlciBiZSB0cmVhdGVkIGFzIGEgc2tldGNoJyk7XG5cbiAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgIGNvbnN0IGFmdGVyID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG4gICAgYXNzZXJ0Lm5vdEVxdWFsKGFmdGVyLnBoYXNlLCAncmVmaW5pbmcnKTtcbiAgICBhc3NlcnQuZXF1YWwoYWZ0ZXIucHJvZ3Jlc3M/LnRhc2tzPy50b3RhbCwgMik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoJ2hhbmRsZVBsYW5TbGljZSBsZWF2ZXMgb21pdHRlZCBlbnJpY2htZW50IGZpZWxkcyBlbXB0eSBpbnN0ZWFkIG9mIHJlbmRlcmluZyBwbGFjZWhvbGRlcnMnLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCAnLmdzZCcsICdnc2QuZGInKSk7XG5cbiAgdHJ5IHtcbiAgICBzZWVkUGFyZW50U2xpY2UoKTtcbiAgICBjb25zdCB7IHN1Y2Nlc3NDcml0ZXJpYSwgcHJvb2ZMZXZlbCwgaW50ZWdyYXRpb25DbG9zdXJlLCBvYnNlcnZhYmlsaXR5SW1wYWN0LCAuLi5wYXJhbXMgfSA9IHZhbGlkUGFyYW1zKCk7XG4gICAgdm9pZCBzdWNjZXNzQ3JpdGVyaWE7XG4gICAgdm9pZCBwcm9vZkxldmVsO1xuICAgIHZvaWQgaW50ZWdyYXRpb25DbG9zdXJlO1xuICAgIHZvaWQgb2JzZXJ2YWJpbGl0eUltcGFjdDtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZVBsYW5TbGljZShwYXJhbXMsIGJhc2UpO1xuICAgIGFzc2VydC5vayghKCdlcnJvcicgaW4gcmVzdWx0KSwgYHVuZXhwZWN0ZWQgZXJyb3I6ICR7J2Vycm9yJyBpbiByZXN1bHQgPyByZXN1bHQuZXJyb3IgOiAnJ31gKTtcblxuICAgIGNvbnN0IHNsaWNlID0gZ2V0U2xpY2UoJ00wMDEnLCAnUzAyJyk7XG4gICAgYXNzZXJ0Lm9rKHNsaWNlKTtcbiAgICBhc3NlcnQuZXF1YWwoc2xpY2U/LnN1Y2Nlc3NfY3JpdGVyaWEsICcnKTtcbiAgICBhc3NlcnQuZXF1YWwoc2xpY2U/LnByb29mX2xldmVsLCAnJyk7XG4gICAgYXNzZXJ0LmVxdWFsKHNsaWNlPy5pbnRlZ3JhdGlvbl9jbG9zdXJlLCAnJyk7XG4gICAgYXNzZXJ0LmVxdWFsKHNsaWNlPy5vYnNlcnZhYmlsaXR5X2ltcGFjdCwgJycpO1xuXG4gICAgY29uc3QgcGxhblBhdGggPSBqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScsICdzbGljZXMnLCAnUzAyJywgJ1MwMi1QTEFOLm1kJyk7XG4gICAgY29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhwbGFuUGF0aCwgJ3V0Zi04Jyk7XG4gICAgYXNzZXJ0LmRvZXNOb3RNYXRjaChjb250ZW50LCAvTm90IHByb3ZpZGVkL2kpO1xuICAgIGFzc2VydC5kb2VzTm90TWF0Y2goY29udGVudCwgL14jIyBQcm9vZiBMZXZlbCQvbSk7XG4gICAgYXNzZXJ0LmRvZXNOb3RNYXRjaChjb250ZW50LCAvXiMjIEludGVncmF0aW9uIENsb3N1cmUkL20pO1xuICAgIGFzc2VydC5tYXRjaChjb250ZW50LCAvLSBDb21wbGV0ZSB0aGUgcGxhbm5lZCBzbGljZSBvdXRjb21lc1xcLi8pO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KCdoYW5kbGVQbGFuU2xpY2UgcmVqZWN0cyBpbnZhbGlkIHBheWxvYWRzJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgJy5nc2QnLCAnZ3NkLmRiJykpO1xuXG4gIHRyeSB7XG4gICAgc2VlZFBhcmVudFNsaWNlKCk7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlUGxhblNsaWNlKHsgLi4udmFsaWRQYXJhbXMoKSwgdGFza3M6IFtdIH0sIGJhc2UpO1xuICAgIGFzc2VydC5vaygnZXJyb3InIGluIHJlc3VsdCk7XG4gICAgYXNzZXJ0Lm1hdGNoKHJlc3VsdC5lcnJvciwgL3ZhbGlkYXRpb24gZmFpbGVkOiB0YXNrcyBtdXN0IGJlIGEgbm9uLWVtcHR5IGFycmF5Lyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoJ2hhbmRsZVBsYW5TbGljZSBleHBsYWlucyBzdHJpbmcgdGFzayBJTyBmaWVsZHMgbXVzdCBiZSBhcnJheXMnLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCAnLmdzZCcsICdnc2QuZGInKSk7XG5cbiAgdHJ5IHtcbiAgICBzZWVkUGFyZW50U2xpY2UoKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVQbGFuU2xpY2Uoe1xuICAgICAgLi4udmFsaWRQYXJhbXMoKSxcbiAgICAgIHRhc2tzOiBbXG4gICAgICAgIHtcbiAgICAgICAgICAuLi52YWxpZFBhcmFtcygpLnRhc2tzWzBdLFxuICAgICAgICAgIGlucHV0czogJ3NyYy9pbmRleC50cycgYXMgdW5rbm93biBhcyBzdHJpbmdbXSxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgfSwgYmFzZSk7XG4gICAgYXNzZXJ0Lm9rKCdlcnJvcicgaW4gcmVzdWx0KTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LmVycm9yLCAvdmFsaWRhdGlvbiBmYWlsZWQ6IHRhc2tzXFxbMFxcXVxcLmlucHV0cyBtdXN0IGJlIGFuIGFycmF5IG9mIHN0cmluZ3MsIG5vdCBzdHJpbmcvKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdCgnaGFuZGxlUGxhblNsaWNlIHJlamVjdHMgYWJzb2x1dGUgdGFzayBJTyBwYXRocyBvdXRzaWRlIHRoZSBhY3RpdmUgd29ya3RyZWUnLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCAnLmdzZCcsICdnc2QuZGInKSk7XG5cbiAgdHJ5IHtcbiAgICBzZWVkUGFyZW50U2xpY2UoKTtcbiAgICBjb25zdCBvdXRzaWRlID0gam9pbih0bXBkaXIoKSwgJ291dHNpZGUtY2hlY2tvdXQnLCAnaW5kZXguaHRtbCcpO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZVBsYW5TbGljZSh7XG4gICAgICAuLi52YWxpZFBhcmFtcygpLFxuICAgICAgdGFza3M6IFtcbiAgICAgICAge1xuICAgICAgICAgIC4uLnZhbGlkUGFyYW1zKCkudGFza3NbMF0sXG4gICAgICAgICAgaW5wdXRzOiBbb3V0c2lkZV0sXG4gICAgICAgICAgZXhwZWN0ZWRPdXRwdXQ6IFtvdXRzaWRlXSxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgfSwgYmFzZSk7XG5cbiAgICBhc3NlcnQub2soJ2Vycm9yJyBpbiByZXN1bHQpO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQuZXJyb3IsIC92YWxpZGF0aW9uIGZhaWxlZDogdGFza3NcXFswXFxdXFwuaW5wdXRzIGNvbnRhaW5zIGFic29sdXRlIHBhdGggb3V0c2lkZSB3b3JraW5nIGRpcmVjdG9yeS8pO1xuICAgIGFzc2VydC5lcXVhbChnZXRTbGljZVRhc2tzKCdNMDAxJywgJ1MwMicpLmxlbmd0aCwgMCwgJ2ludmFsaWQgcGxhbm5pbmcgSU8gbXVzdCBub3QgcGVyc2lzdCB0YXNrcycpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KCdoYW5kbGVQbGFuU2xpY2UgcmVqZWN0cyBtaXNzaW5nIHRhc2sgaW5wdXQgcGF0aHMgYmVmb3JlIHBlcnNpc3RpbmcgdGFza3MnLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCAnLmdzZCcsICdnc2QuZGInKSk7XG5cbiAgdHJ5IHtcbiAgICBzZWVkUGFyZW50U2xpY2UoKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVQbGFuU2xpY2Uoe1xuICAgICAgLi4udmFsaWRQYXJhbXMoKSxcbiAgICAgIHRhc2tzOiBbXG4gICAgICAgIHtcbiAgICAgICAgICAuLi52YWxpZFBhcmFtcygpLnRhc2tzWzBdLFxuICAgICAgICAgIGlucHV0czogWydmaXh0dXJlcy9taXNzaW5nLXNvdXJjZS5qc29uJ10sXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgIH0sIGJhc2UpO1xuXG4gICAgYXNzZXJ0Lm9rKCdlcnJvcicgaW4gcmVzdWx0KTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LmVycm9yLCAvcHJlLWV4ZWN1dGlvbiB2YWxpZGF0aW9uIGZhaWxlZDovKTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LmVycm9yLCAvZml4dHVyZXNcXC9taXNzaW5nLXNvdXJjZVxcLmpzb24vKTtcbiAgICBhc3NlcnQuZXF1YWwoZ2V0U2xpY2VUYXNrcygnTTAwMScsICdTMDInKS5sZW5ndGgsIDAsICdpbnZhbGlkIHBsYW5uaW5nIElPIG11c3Qgbm90IHBlcnNpc3QgdGFza3MnKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdCgnaGFuZGxlUGxhblNsaWNlIHJlamVjdHMgdGFzayBpbnB1dCBwYXRocyBjcmVhdGVkIGJ5IGxhdGVyIHRhc2tzIGJlZm9yZSBwZXJzaXN0aW5nIHRhc2tzJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgJy5nc2QnLCAnZ3NkLmRiJykpO1xuXG4gIHRyeSB7XG4gICAgc2VlZFBhcmVudFNsaWNlKCk7XG4gICAgY29uc3QgcGFyYW1zID0gdmFsaWRQYXJhbXMoKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVQbGFuU2xpY2Uoe1xuICAgICAgLi4ucGFyYW1zLFxuICAgICAgdGFza3M6IFtcbiAgICAgICAge1xuICAgICAgICAgIC4uLnBhcmFtcy50YXNrc1swXSxcbiAgICAgICAgICBpbnB1dHM6IFsnZ2VuZXJhdGVkL3JlcG9ydC5qc29uJ10sXG4gICAgICAgICAgZXhwZWN0ZWRPdXRwdXQ6IFsnZ2VuZXJhdGVkL3N1bW1hcnkuanNvbiddLFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgLi4ucGFyYW1zLnRhc2tzWzFdLFxuICAgICAgICAgIGlucHV0czogW10sXG4gICAgICAgICAgZXhwZWN0ZWRPdXRwdXQ6IFsnZ2VuZXJhdGVkL3JlcG9ydC5qc29uJ10sXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgIH0sIGJhc2UpO1xuXG4gICAgYXNzZXJ0Lm9rKCdlcnJvcicgaW4gcmVzdWx0KTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LmVycm9yLCAvcHJlLWV4ZWN1dGlvbiB2YWxpZGF0aW9uIGZhaWxlZDovKTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LmVycm9yLCAvc2VxdWVuY2UgdmlvbGF0aW9uLyk7XG4gICAgYXNzZXJ0LmVxdWFsKGdldFNsaWNlVGFza3MoJ00wMDEnLCAnUzAyJykubGVuZ3RoLCAwLCAnaW52YWxpZCB0YXNrIG9yZGVyaW5nIG11c3Qgbm90IHBlcnNpc3QgdGFza3MnKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdCgnaGFuZGxlUGxhblNsaWNlIGFjY2VwdHMgYWJzb2x1dGUgdGFzayBJTyBwYXRocyBpbnNpZGUgdGhlIGFjdGl2ZSB3b3JrdHJlZScsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsICcuZ3NkJywgJ2dzZC5kYicpKTtcblxuICB0cnkge1xuICAgIHNlZWRQYXJlbnRTbGljZSgpO1xuICAgIGNvbnN0IGluc2lkZSA9IGpvaW4oYmFzZSwgJ2luZGV4Lmh0bWwnKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVQbGFuU2xpY2Uoe1xuICAgICAgLi4udmFsaWRQYXJhbXMoKSxcbiAgICAgIHRhc2tzOiBbXG4gICAgICAgIHtcbiAgICAgICAgICAuLi52YWxpZFBhcmFtcygpLnRhc2tzWzBdLFxuICAgICAgICAgIGlucHV0czogW2luc2lkZV0sXG4gICAgICAgICAgZXhwZWN0ZWRPdXRwdXQ6IFtpbnNpZGVdLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9LCBiYXNlKTtcblxuICAgIGFzc2VydC5vayghKCdlcnJvcicgaW4gcmVzdWx0KSwgYHVuZXhwZWN0ZWQgZXJyb3I6ICR7J2Vycm9yJyBpbiByZXN1bHQgPyByZXN1bHQuZXJyb3IgOiAnJ31gKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdCgnaGFuZGxlUGxhblNsaWNlIHJlamVjdHMgbWlzc2luZyBwYXJlbnQgc2xpY2UnLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCAnLmdzZCcsICdnc2QuZGInKSk7XG5cbiAgdHJ5IHtcbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogJ00wMDEnLCB0aXRsZTogJ01pbGVzdG9uZScsIHN0YXR1czogJ2FjdGl2ZScgfSk7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlUGxhblNsaWNlKHZhbGlkUGFyYW1zKCksIGJhc2UpO1xuICAgIGFzc2VydC5vaygnZXJyb3InIGluIHJlc3VsdCk7XG4gICAgYXNzZXJ0Lm1hdGNoKHJlc3VsdC5lcnJvciwgL21pc3NpbmcgcGFyZW50IHNsaWNlOiBNMDAxXFwvUzAyLyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoJ2hhbmRsZVBsYW5TbGljZSBzdXJmYWNlcyByZW5kZXIgZmFpbHVyZXMgd2l0aG91dCBjaGFuZ2luZyBwYXJzZS12aXNpYmxlIHRhc2stcGxhbiBzdGF0ZSBmb3IgdGhlIGZhaWxpbmcgdGFzaycsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsICcuZ3NkJywgJ2dzZC5kYicpKTtcblxuICB0cnkge1xuICAgIHNlZWRQYXJlbnRTbGljZSgpO1xuICAgIGNvbnN0IGZhaWxpbmdUYXNrUGxhblBhdGggPSBqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScsICdzbGljZXMnLCAnUzAyJywgJ3Rhc2tzJywgJ1QwMS1QTEFOLm1kJyk7XG4gICAgd3JpdGVGaWxlU3luYyhmYWlsaW5nVGFza1BsYW5QYXRoLCAnLS0tXFxuZXN0aW1hdGVkX3N0ZXBzOiAxXFxuZXN0aW1hdGVkX2ZpbGVzOiAxXFxuc2tpbGxzX3VzZWQ6IFtdXFxuLS0tXFxuXFxuIyBUMDE6IENhY2hlZCB0YXNrXFxuJywgJ3V0Zi04Jyk7XG4gICAgcm1TeW5jKGZhaWxpbmdUYXNrUGxhblBhdGgsIHsgZm9yY2U6IHRydWUgfSk7XG4gICAgbWtkaXJTeW5jKGZhaWxpbmdUYXNrUGxhblBhdGgsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlUGxhblNsaWNlKHZhbGlkUGFyYW1zKCksIGJhc2UpO1xuICAgIGFzc2VydC5vaygnZXJyb3InIGluIHJlc3VsdCk7XG4gICAgYXNzZXJ0Lm1hdGNoKHJlc3VsdC5lcnJvciwgL3JlbmRlciBmYWlsZWQ6Lyk7XG5cbiAgICBhc3NlcnQub2soZXhpc3RzU3luYyhmYWlsaW5nVGFza1BsYW5QYXRoKSwgJ2ZhaWxpbmcgdGFzayBwbGFuIHBhdGggc2hvdWxkIHJlbWFpbiB0aGUgYmxvY2tpbmcgZGlyZWN0b3J5Jyk7XG4gICAgYXNzZXJ0LmVxdWFsKGdldFRhc2soJ00wMDEnLCAnUzAyJywgJ1QwMScpPy5kZXNjcmlwdGlvbiwgJ0ltcGxlbWVudCB0aGUgc2xpY2UgcGxhbm5pbmcgaGFuZGxlci4nKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdCgnaGFuZGxlUGxhblNsaWNlIHJlYWN0aXZhdGVzIGEgZGVmZXJyZWQgcGFyZW50IHNsaWNlIHRvIHBlbmRpbmcnLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdC5hZnRlcigoKSA9PiBjbGVhbnVwKGJhc2UpKTtcbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgJy5nc2QnLCAnZ3NkLmRiJykpO1xuXG4gIGluc2VydE1pbGVzdG9uZSh7IGlkOiAnTTAwMScsIHRpdGxlOiAnTWlsZXN0b25lJywgc3RhdHVzOiAnYWN0aXZlJyB9KTtcbiAgaW5zZXJ0U2xpY2UoeyBpZDogJ1MwMicsIG1pbGVzdG9uZUlkOiAnTTAwMScsIHRpdGxlOiAnUGxhbm5pbmcgc2xpY2UnLCBzdGF0dXM6ICdkZWZlcnJlZCcsIGRlbW86ICdSZW5kZXJlZCBwbGFucyBleGlzdC4nIH0pO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZVBsYW5TbGljZSh2YWxpZFBhcmFtcygpLCBiYXNlKTtcbiAgYXNzZXJ0Lm9rKCEoJ2Vycm9yJyBpbiByZXN1bHQpLCBgdW5leHBlY3RlZCBlcnJvcjogJHsnZXJyb3InIGluIHJlc3VsdCA/IHJlc3VsdC5lcnJvciA6ICcnfWApO1xuXG4gIGNvbnN0IHNsaWNlID0gZ2V0U2xpY2UoJ00wMDEnLCAnUzAyJyk7XG4gIGFzc2VydC5vayhzbGljZSk7XG4gIGFzc2VydC5lcXVhbChzbGljZT8uc3RhdHVzLCAncGVuZGluZycsICdkZWZlcnJlZCBzbGljZSBtdXN0IGJlIHJlYWN0aXZhdGVkIHRvIHBlbmRpbmcgc28gYXV0by1tb2RlIGNhbiBkaXNwYXRjaCBpdCcpO1xuICBhc3NlcnQuZXF1YWwoc2xpY2U/LmdvYWwsICdQZXJzaXN0IHNsaWNlIHBsYW5uaW5nIHRocm91Z2ggdGhlIERCLicpO1xufSk7XG5cbnRlc3QoJ2hhbmRsZVBsYW5TbGljZSByZXJ1bnMgaWRlbXBvdGVudGx5IGFuZCByZWZyZXNoZXMgcGFyc2UtdmlzaWJsZSBzdGF0ZScsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsICcuZ3NkJywgJ2dzZC5kYicpKTtcblxuICB0cnkge1xuICAgIHNlZWRQYXJlbnRTbGljZSgpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgJ00wMDEnLCAnc2xpY2VzJywgJ1MwMicsICdTMDItUExBTi5tZCcpLCAnIyBTMDI6IENhY2hlZFxcblxcbioqR29hbDoqKiBvbGQgdmFsdWVcXG5cXG4jIyBUYXNrc1xcblxcbi0gWyBdICoqVDAxOiBDYWNoZWQgdGFzayoqXFxuJywgJ3V0Zi04Jyk7XG5cbiAgICBjb25zdCBmaXJzdCA9IGF3YWl0IGhhbmRsZVBsYW5TbGljZSh2YWxpZFBhcmFtcygpLCBiYXNlKTtcbiAgICBhc3NlcnQub2soISgnZXJyb3InIGluIGZpcnN0KSk7XG5cbiAgICBjb25zdCBzZWNvbmQgPSBhd2FpdCBoYW5kbGVQbGFuU2xpY2Uoe1xuICAgICAgLi4udmFsaWRQYXJhbXMoKSxcbiAgICAgIGdvYWw6ICdVcGRhdGVkIGdvYWwgZnJvbSByZXJ1bi4nLFxuICAgICAgdGFza3M6IFtcbiAgICAgICAgeyAuLi52YWxpZFBhcmFtcygpLnRhc2tzWzBdLCBkZXNjcmlwdGlvbjogJ1VwZGF0ZWQgc2xpY2UgaGFuZGxlciBkZXNjcmlwdGlvbi4nIH0sXG4gICAgICAgIHZhbGlkUGFyYW1zKCkudGFza3NbMV0sXG4gICAgICBdLFxuICAgIH0sIGJhc2UpO1xuICAgIGFzc2VydC5vayghKCdlcnJvcicgaW4gc2Vjb25kKSk7XG5cbiAgICBjb25zdCBwYXJzZWRBZnRlciA9IHBhcnNlUGxhbihyZWFkRmlsZVN5bmMoam9pbihiYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgJ00wMDEnLCAnc2xpY2VzJywgJ1MwMicsICdTMDItUExBTi5tZCcpLCAndXRmLTgnKSk7XG4gICAgYXNzZXJ0LmVxdWFsKHBhcnNlZEFmdGVyLmdvYWwsICdVcGRhdGVkIGdvYWwgZnJvbSByZXJ1bi4nKTtcbiAgICBjb25zdCB0YXNrID0gZ2V0VGFzaygnTTAwMScsICdTMDInLCAnVDAxJyk7XG4gICAgYXNzZXJ0LmVxdWFsKHRhc2s/LmRlc2NyaXB0aW9uLCAnVXBkYXRlZCBzbGljZSBoYW5kbGVyIGRlc2NyaXB0aW9uLicpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KCdoYW5kbGVQbGFuU2xpY2UgcmVtb3ZlcyBvbWl0dGVkIHBlbmRpbmcgdGFza3Mgd2hlbiByZXBsYW5uaW5nIGEgc21hbGxlciB0YXNrIHNldCcsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsICcuZ3NkJywgJ2dzZC5kYicpKTtcblxuICB0cnkge1xuICAgIHNlZWRQYXJlbnRTbGljZSgpO1xuICAgIGNvbnN0IGZvdXJUYXNrUGxhbiA9IHtcbiAgICAgIC4uLnZhbGlkUGFyYW1zKCksXG4gICAgICB0YXNrczogW1xuICAgICAgICAuLi52YWxpZFBhcmFtcygpLnRhc2tzLFxuICAgICAgICB7IC4uLnZhbGlkUGFyYW1zKCkudGFza3NbMF0sIHRhc2tJZDogJ1QwMycsIHRpdGxlOiAnVGhpcmQgdGFzaycgfSxcbiAgICAgICAgeyAuLi52YWxpZFBhcmFtcygpLnRhc2tzWzBdLCB0YXNrSWQ6ICdUMDQnLCB0aXRsZTogJ1N0YWxlIHRhc2snLCBpbnB1dHM6IFsnc3RhbGUtaW5wdXQucHknXSB9LFxuICAgICAgXSxcbiAgICB9O1xuXG4gICAgY29uc3QgZmlyc3QgPSBhd2FpdCBoYW5kbGVQbGFuU2xpY2UoZm91clRhc2tQbGFuLCBiYXNlKTtcbiAgICBhc3NlcnQub2soISgnZXJyb3InIGluIGZpcnN0KSwgYHVuZXhwZWN0ZWQgZXJyb3I6ICR7J2Vycm9yJyBpbiBmaXJzdCA/IGZpcnN0LmVycm9yIDogJyd9YCk7XG4gICAgY29uc3Qgc3RhbGVUYXNrUGxhblBhdGggPSBqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScsICdzbGljZXMnLCAnUzAyJywgJ3Rhc2tzJywgJ1QwNC1QTEFOLm1kJyk7XG4gICAgYXNzZXJ0Lm9rKGV4aXN0c1N5bmMoc3RhbGVUYXNrUGxhblBhdGgpLCAnaW5pdGlhbCBwbGFuIHNob3VsZCByZW5kZXIgVDA0Jyk7XG5cbiAgICBjb25zdCBzZWNvbmQgPSBhd2FpdCBoYW5kbGVQbGFuU2xpY2Uoe1xuICAgICAgLi4udmFsaWRQYXJhbXMoKSxcbiAgICAgIHRhc2tzOiBmb3VyVGFza1BsYW4udGFza3MuZmlsdGVyKCh0YXNrKSA9PiB0YXNrLnRhc2tJZCAhPT0gJ1QwNCcpLFxuICAgIH0sIGJhc2UpO1xuICAgIGFzc2VydC5vayghKCdlcnJvcicgaW4gc2Vjb25kKSwgYHVuZXhwZWN0ZWQgZXJyb3I6ICR7J2Vycm9yJyBpbiBzZWNvbmQgPyBzZWNvbmQuZXJyb3IgOiAnJ31gKTtcblxuICAgIGFzc2VydC5kZWVwRXF1YWwoZ2V0U2xpY2VUYXNrcygnTTAwMScsICdTMDInKS5tYXAoKHRhc2spID0+IHRhc2suaWQpLCBbJ1QwMScsICdUMDInLCAnVDAzJ10pO1xuICAgIGFzc2VydC5lcXVhbChnZXRHYXRlUmVzdWx0cygnTTAwMScsICdTMDInLCAndGFzaycpLnNvbWUoKGdhdGUpID0+IGdhdGUudGFza19pZCA9PT0gJ1QwNCcpLCBmYWxzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKGV4aXN0c1N5bmMoc3RhbGVUYXNrUGxhblBhdGgpLCBmYWxzZSwgJ29taXR0ZWQgdGFzayBwbGFuIGFydGlmYWN0IHNob3VsZCBiZSByZW1vdmVkJyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoJ2hhbmRsZVBsYW5TbGljZSByZWplY3RzIG9taXR0ZWQgY29tcGxldGVkIHRhc2tzIHdpdGhvdXQgY2hhbmdpbmcgc2xpY2Ugb3IgdGFzayBzdGF0ZScsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsICcuZ3NkJywgJ2dzZC5kYicpKTtcblxuICB0cnkge1xuICAgIHNlZWRQYXJlbnRTbGljZSgpO1xuICAgIGNvbnN0IGZvdXJUYXNrUGxhbiA9IHtcbiAgICAgIC4uLnZhbGlkUGFyYW1zKCksXG4gICAgICB0YXNrczogW1xuICAgICAgICAuLi52YWxpZFBhcmFtcygpLnRhc2tzLFxuICAgICAgICB7IC4uLnZhbGlkUGFyYW1zKCkudGFza3NbMF0sIHRhc2tJZDogJ1QwMycsIHRpdGxlOiAnVGhpcmQgdGFzaycgfSxcbiAgICAgICAgeyAuLi52YWxpZFBhcmFtcygpLnRhc2tzWzBdLCB0YXNrSWQ6ICdUMDQnLCB0aXRsZTogJ1N0YWxlIHRhc2snLCBpbnB1dHM6IFsnc3RhbGUtaW5wdXQucHknXSB9LFxuICAgICAgXSxcbiAgICB9O1xuXG4gICAgY29uc3QgZmlyc3QgPSBhd2FpdCBoYW5kbGVQbGFuU2xpY2UoZm91clRhc2tQbGFuLCBiYXNlKTtcbiAgICBhc3NlcnQub2soISgnZXJyb3InIGluIGZpcnN0KSwgYHVuZXhwZWN0ZWQgZXJyb3I6ICR7J2Vycm9yJyBpbiBmaXJzdCA/IGZpcnN0LmVycm9yIDogJyd9YCk7XG4gICAgY29uc3Qgc3RhbGVUYXNrUGxhblBhdGggPSBqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScsICdzbGljZXMnLCAnUzAyJywgJ3Rhc2tzJywgJ1QwNC1QTEFOLm1kJyk7XG4gICAgYXNzZXJ0Lm9rKGV4aXN0c1N5bmMoc3RhbGVUYXNrUGxhblBhdGgpLCAnaW5pdGlhbCBwbGFuIHNob3VsZCByZW5kZXIgVDA0Jyk7XG5cbiAgICB1cGRhdGVUYXNrU3RhdHVzKCdNMDAxJywgJ1MwMicsICdUMDQnLCAnY29tcGxldGUnLCAnMjAyNi0wNS0xMlQwMDowMDowMC4wMDBaJyk7XG4gICAgY29uc3QgdGFza3NCZWZvcmUgPSBnZXRTbGljZVRhc2tzKCdNMDAxJywgJ1MwMicpO1xuICAgIGNvbnN0IGdhdGVzQmVmb3JlID0gZ2V0R2F0ZVJlc3VsdHMoJ00wMDEnLCAnUzAyJywgJ3Rhc2snKTtcblxuICAgIGNvbnN0IHNlY29uZCA9IGF3YWl0IGhhbmRsZVBsYW5TbGljZSh7XG4gICAgICAuLi52YWxpZFBhcmFtcygpLFxuICAgICAgZ29hbDogJ1JlamVjdGVkIHJlcGxhbiBzaG91bGQgbm90IHBlcnNpc3QuJyxcbiAgICAgIHRhc2tzOiBmb3VyVGFza1BsYW4udGFza3MuZmlsdGVyKCh0YXNrKSA9PiB0YXNrLnRhc2tJZCAhPT0gJ1QwNCcpLFxuICAgIH0sIGJhc2UpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwoc2Vjb25kLCB7IGVycm9yOiAnY2Fubm90IHJlbW92ZSBjb21wbGV0ZWQgdGFzayBUMDQnIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKGdldFNsaWNlKCdNMDAxJywgJ1MwMicpPy5nb2FsLCAnUGVyc2lzdCBzbGljZSBwbGFubmluZyB0aHJvdWdoIHRoZSBEQi4nKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKGdldFNsaWNlVGFza3MoJ00wMDEnLCAnUzAyJyksIHRhc2tzQmVmb3JlKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKGdldEdhdGVSZXN1bHRzKCdNMDAxJywgJ1MwMicsICd0YXNrJyksIGdhdGVzQmVmb3JlKTtcbiAgICBhc3NlcnQub2soZXhpc3RzU3luYyhzdGFsZVRhc2tQbGFuUGF0aCksICdjb21wbGV0ZWQgdGFzayBwbGFuIGFydGlmYWN0IHNob3VsZCByZW1haW4gYWZ0ZXIgcmVqZWN0ZWQgcmVwbGFuJyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoJ3JlZ3Jlc3Npb246IHZhbGlkYXRlVGFza3Mgc3VyZmFjZXMgY2xlYW4gcGVyLWZpZWxkIGVycm9ycyBmb3Igbm9uLWFycmF5IElPIGlucHV0cycsIGFzeW5jICgpID0+IHtcbiAgLy8gUmVncmVzc2lvbiBmb3IgdGhlIGJ1ZyBmaXhlZCBpbiBQUiAjNTg3MjogYW4gZWFybGllciByZWZhY3RvciBvbiBtYWluXG4gIC8vICgwYjBlMWE5MDEpIHJlLWFkZGVkIHZhbGlkYXRlU3RyaW5nQXJyYXkoKSBjYWxscyBpbnNpZGUgdmFsaWRhdGVUYXNrc1xuICAvLyB3aXRob3V0IHJlLWFkZGluZyBpdHMgaW1wb3J0LiBUaGUgY2F0Y2ggYXJvdW5kIHZhbGlkYXRlUGFyYW1zIHN3YWxsb3dlZFxuICAvLyB0aGUgUmVmZXJlbmNlRXJyb3IgaW50byBhIGdlbmVyaWMgXCJ2YWxpZGF0aW9uIGZhaWxlZDogdmFsaWRhdGVTdHJpbmdBcnJheVxuICAvLyBpcyBub3QgZGVmaW5lZFwiIG1lc3NhZ2UsIHNvIHNpbGVudCBydW50aW1lIGJyZWFrYWdlIHdhcyBwb3NzaWJsZS5cbiAgLy9cbiAgLy8gRXhlcmNpc2UgZXZlcnkgdmFsaWRhdGVTdHJpbmdBcnJheSBjYWxsIHNpdGUgKGZpbGVzLCBpbnB1dHMsIGV4cGVjdGVkT3V0cHV0KVxuICAvLyBzbyBhIGZ1dHVyZSBtaXNzaW5nLWltcG9ydCB3b3VsZCBzdXJmYWNlIGFzIGEgcGVyLWZpZWxkIGFzc2VydGlvbiBmYWlsdXJlXG4gIC8vIGhlcmUsIG5vdCBhIGRlZXAgUmVmZXJlbmNlRXJyb3IgdGhhdCdzIGVhc3kgdG8gbWlzLWRpYWdub3NlLlxuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgJy5nc2QnLCAnZ3NkLmRiJykpO1xuXG4gIHRyeSB7XG4gICAgc2VlZFBhcmVudFNsaWNlKCk7XG5cbiAgICBmb3IgKGNvbnN0IGZpZWxkIG9mIFsnZmlsZXMnLCAnaW5wdXRzJywgJ2V4cGVjdGVkT3V0cHV0J10gYXMgY29uc3QpIHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZVBsYW5TbGljZSh7XG4gICAgICAgIC4uLnZhbGlkUGFyYW1zKCksXG4gICAgICAgIHRhc2tzOiBbe1xuICAgICAgICAgIC4uLnZhbGlkUGFyYW1zKCkudGFza3NbMF0sXG4gICAgICAgICAgW2ZpZWxkXTogJ25vdC1hbi1hcnJheScgYXMgdW5rbm93biBhcyBzdHJpbmdbXSxcbiAgICAgICAgfV0sXG4gICAgICB9LCBiYXNlKTtcbiAgICAgIGFzc2VydC5vaygnZXJyb3InIGluIHJlc3VsdCwgYCR7ZmllbGR9OiBleHBlY3RlZCB2YWxpZGF0aW9uIGVycm9yLCBnb3Qgc3VjY2Vzc2ApO1xuICAgICAgYXNzZXJ0Lm1hdGNoKFxuICAgICAgICByZXN1bHQuZXJyb3IsXG4gICAgICAgIG5ldyBSZWdFeHAoYHRhc2tzXFxcXFswXFxcXF1cXFxcLiR7ZmllbGR9IG11c3QgYmUgYW4gYXJyYXlgKSxcbiAgICAgICAgYCR7ZmllbGR9OiBleHBlY3RlZCBwZXItZmllbGQgdmFsaWRhdGlvbiBtZXNzYWdlLCBnb3Q6ICR7cmVzdWx0LmVycm9yfWAsXG4gICAgICApO1xuICAgICAgYXNzZXJ0LmRvZXNOb3RNYXRjaChcbiAgICAgICAgcmVzdWx0LmVycm9yLFxuICAgICAgICAvaXMgbm90IGRlZmluZWQvLFxuICAgICAgICBgJHtmaWVsZH06IHZhbGlkYXRpb24gc3VyZmFjZWQgUmVmZXJlbmNlRXJyb3IgXHUyMDE0IGxpa2VseSBhIG1pc3NpbmcgaW1wb3J0IGluIHBsYW4tc2xpY2UudHNgLFxuICAgICAgKTtcbiAgICAgIGFzc2VydC5lcXVhbChnZXRTbGljZVRhc2tzKCdNMDAxJywgJ1MwMicpLmxlbmd0aCwgMCwgYCR7ZmllbGR9OiBpbnZhbGlkIGlucHV0IG11c3Qgbm90IHBlcnNpc3RgKTtcbiAgICB9XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFFQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxXQUFXLFFBQVEsY0FBYyxZQUFZLHFCQUFxQjtBQUN4RixTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBRXZCLFNBQVMsY0FBYyxlQUFlLGlCQUFpQixhQUFhLFVBQVUsZUFBZSxTQUFTLGdCQUFnQix3QkFBd0I7QUFDOUksU0FBUyx1QkFBdUI7QUFDaEMsU0FBUyxpQkFBaUI7QUFDMUIsU0FBUyx5QkFBeUI7QUFDbEMsU0FBUyxhQUFhLDRCQUE0QjtBQUVsRCxTQUFTLGNBQXNCO0FBQzdCLFFBQU0sT0FBTyxZQUFZLEtBQUssT0FBTyxHQUFHLGlCQUFpQixDQUFDO0FBQzFELFlBQVUsS0FBSyxNQUFNLFFBQVEsY0FBYyxRQUFRLFVBQVUsT0FBTyxPQUFPLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNqRyxZQUFVLEtBQUssTUFBTSxPQUFPLGFBQWEsY0FBYyxPQUFPLE9BQU8sR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQzNGLGdCQUFjLEtBQUssTUFBTSxPQUFPLGFBQWEsY0FBYyxPQUFP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
