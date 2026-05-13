import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  upsertTaskPlanning,
  getTask,
  getReplanHistory
} from "../gsd-db.js";
import { handleReplanSlice } from "../tools/replan-slice.js";
import { parsePlan } from "../parsers-legacy.js";
function makeTmpBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-replan-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
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
function seedSliceWithTasks(opts) {
  insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Test Slice", status: "active", demo: "Demo." });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task One", status: opts?.t01Status ?? "complete" });
  upsertTaskPlanning("M001", "S01", "T01", {
    description: "First task description.",
    estimate: "30m",
    files: ["src/a.ts"],
    verify: "node --test a.test.ts",
    inputs: ["src/a.ts"],
    expectedOutput: ["src/a.ts"]
  });
  insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Task Two", status: opts?.t02Status ?? "pending" });
  upsertTaskPlanning("M001", "S01", "T02", {
    description: "Second task description.",
    estimate: "45m",
    files: ["src/b.ts"],
    verify: "node --test b.test.ts",
    inputs: ["src/b.ts"],
    expectedOutput: ["src/b.ts"]
  });
  if (opts?.t03Status !== void 0 || !opts) {
    insertTask({ id: "T03", sliceId: "S01", milestoneId: "M001", title: "Task Three", status: opts?.t03Status ?? "pending" });
    upsertTaskPlanning("M001", "S01", "T03", {
      description: "Third task description.",
      estimate: "20m",
      files: ["src/c.ts"],
      verify: "node --test c.test.ts",
      inputs: ["src/c.ts"],
      expectedOutput: ["src/c.ts"]
    });
  }
}
function validReplanParams() {
  return {
    milestoneId: "M001",
    sliceId: "S01",
    blockerTaskId: "T01",
    blockerDescription: "T01 discovered a blocker in the API.",
    whatChanged: "Updated T02 to use new API, removed T03, added T04.",
    updatedTasks: [
      {
        taskId: "T02",
        title: "Updated Task Two",
        description: "Revised description for T02.",
        estimate: "1h",
        files: ["src/b-v2.ts"],
        verify: "node --test b-v2.test.ts",
        inputs: ["src/b.ts"],
        expectedOutput: ["src/b-v2.ts"]
      }
    ],
    removedTaskIds: ["T03"]
  };
}
test("handleReplanSlice rejects invalid payloads (missing milestoneId)", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedSliceWithTasks();
    const result = await handleReplanSlice({ ...validReplanParams(), milestoneId: "" }, base);
    assert.ok("error" in result);
    assert.match(result.error, /validation failed/);
    assert.match(result.error, /milestoneId/);
  } finally {
    cleanup(base);
  }
});
test("handleReplanSlice rejects structural violation: updating a completed task", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedSliceWithTasks({ t01Status: "complete", t02Status: "pending" });
    const result = await handleReplanSlice({
      ...validReplanParams(),
      updatedTasks: [
        {
          taskId: "T01",
          title: "Trying to update completed T01",
          description: "Should be rejected.",
          estimate: "1h",
          files: [],
          verify: "",
          inputs: [],
          expectedOutput: []
        }
      ],
      removedTaskIds: []
    }, base);
    assert.ok("error" in result);
    assert.match(result.error, /completed task/);
    assert.match(result.error, /T01/);
  } finally {
    cleanup(base);
  }
});
test("handleReplanSlice rejects structural violation: removing a completed task", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedSliceWithTasks({ t01Status: "complete", t02Status: "pending" });
    const result = await handleReplanSlice({
      ...validReplanParams(),
      updatedTasks: [],
      removedTaskIds: ["T01"]
    }, base);
    assert.ok("error" in result);
    assert.match(result.error, /completed task/);
    assert.match(result.error, /T01/);
  } finally {
    cleanup(base);
  }
});
test("handleReplanSlice succeeds when modifying only incomplete tasks", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedSliceWithTasks({ t01Status: "complete", t02Status: "pending", t03Status: "pending" });
    const params = {
      ...validReplanParams(),
      updatedTasks: [
        {
          taskId: "T02",
          title: "Updated Task Two",
          description: "Revised description for T02.",
          estimate: "1h",
          files: ["src/b-v2.ts"],
          verify: "node --test b-v2.test.ts",
          inputs: ["src/b.ts"],
          expectedOutput: ["src/b-v2.ts"]
        },
        {
          taskId: "T04",
          title: "New Task Four",
          description: "Brand new task added during replan.",
          estimate: "30m",
          files: ["src/d.ts"],
          verify: "node --test d.test.ts",
          inputs: [],
          expectedOutput: ["src/d.ts"]
        }
      ],
      removedTaskIds: ["T03"]
    };
    const result = await handleReplanSlice(params, base);
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    const history = getReplanHistory("M001", "S01");
    assert.ok(history.length > 0, "replan_history should have at least one entry");
    assert.equal(history[0]["milestone_id"], "M001");
    assert.equal(history[0]["slice_id"], "S01");
    assert.equal(history[0]["task_id"], "T01");
    const t02 = getTask("M001", "S01", "T02");
    assert.ok(t02, "T02 should still exist");
    assert.equal(t02?.title, "Updated Task Two");
    assert.equal(t02?.description, "Revised description for T02.");
    const t03 = getTask("M001", "S01", "T03");
    assert.equal(t03, null, "T03 should have been deleted");
    const t04 = getTask("M001", "S01", "T04");
    assert.ok(t04, "T04 should exist as a new task");
    assert.equal(t04?.title, "New Task Four");
    assert.equal(t04?.status, "pending");
    const t01 = getTask("M001", "S01", "T01");
    assert.ok(t01, "T01 should still exist");
    assert.equal(t01?.status, "complete");
    const planPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md");
    assert.ok(existsSync(planPath), "PLAN.md should be rendered to disk");
    const replanPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-REPLAN.md");
    assert.ok(existsSync(replanPath), "REPLAN.md should be rendered to disk");
    const replanContent = readFileSync(replanPath, "utf-8");
    assert.ok(replanContent.includes("Blocker Description"), "REPLAN.md should contain blocker section");
    assert.ok(replanContent.includes("T01"), "REPLAN.md should reference blocker task");
  } finally {
    cleanup(base);
  }
});
test("handleReplanSlice cache invalidation: re-parsing PLAN.md reflects mutations", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedSliceWithTasks({ t01Status: "complete", t02Status: "pending", t03Status: "pending" });
    const params = {
      ...validReplanParams(),
      updatedTasks: [
        {
          taskId: "T02",
          title: "Cache-Test Updated T02",
          description: "This title should appear in re-parsed plan.",
          estimate: "1h",
          files: ["src/b.ts"],
          verify: "test",
          inputs: [],
          expectedOutput: []
        }
      ],
      removedTaskIds: ["T03"]
    };
    const result = await handleReplanSlice(params, base);
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    const planPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md");
    const content = readFileSync(planPath, "utf-8");
    const parsed = parsePlan(content);
    const t01Task = parsed.tasks.find((t) => t.id === "T01");
    assert.ok(t01Task, "completed T01 should remain in parsed plan");
    const t02Task = parsed.tasks.find((t) => t.id === "T02");
    assert.ok(t02Task, "T02 should be in parsed plan");
    assert.ok(t02Task?.title?.includes("Cache-Test Updated T02"), "T02 title should be updated");
    const t03Task = parsed.tasks.find((t) => t.id === "T03");
    assert.equal(t03Task, void 0, "T03 should not appear in parsed plan after removal");
  } finally {
    cleanup(base);
  }
});
test("handleReplanSlice is idempotent: calling twice with same params succeeds", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedSliceWithTasks({ t01Status: "complete", t02Status: "pending", t03Status: "pending" });
    const params = {
      ...validReplanParams(),
      updatedTasks: [
        {
          taskId: "T02",
          title: "Idempotent Update",
          description: "Same update applied twice.",
          estimate: "1h",
          files: ["src/b.ts"],
          verify: "test",
          inputs: [],
          expectedOutput: []
        }
      ],
      removedTaskIds: ["T03"]
    };
    const first = await handleReplanSlice(params, base);
    assert.ok(!("error" in first), `first call error: ${"error" in first ? first.error : ""}`);
    const second = await handleReplanSlice(params, base);
    assert.ok(!("error" in second), `second call error: ${"error" in second ? second.error : ""}`);
    const history = getReplanHistory("M001", "S01");
    assert.ok(history.length >= 2, "replan_history should have at least 2 entries after idempotent rerun");
  } finally {
    cleanup(base);
  }
});
test("handleReplanSlice returns missing parent slice error", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    const result = await handleReplanSlice(validReplanParams(), base);
    assert.ok("error" in result);
    assert.match(result.error, /missing parent slice/);
  } finally {
    cleanup(base);
  }
});
test('handleReplanSlice rejects task with status "done" (alias for complete)', async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedSliceWithTasks({ t01Status: "done", t02Status: "pending" });
    const result = await handleReplanSlice({
      ...validReplanParams(),
      updatedTasks: [
        {
          taskId: "T01",
          title: "Trying to update done T01",
          description: "Should be rejected.",
          estimate: "1h",
          files: [],
          verify: "",
          inputs: [],
          expectedOutput: []
        }
      ],
      removedTaskIds: []
    }, base);
    assert.ok("error" in result);
    assert.match(result.error, /completed task/);
    assert.match(result.error, /T01/);
  } finally {
    cleanup(base);
  }
});
test("handleReplanSlice returns structured error payloads with actionable messages", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedSliceWithTasks({ t01Status: "complete", t02Status: "complete", t03Status: "pending" });
    const modifyResult = await handleReplanSlice({
      ...validReplanParams(),
      updatedTasks: [{ taskId: "T01", title: "x", description: "", estimate: "", files: [], verify: "", inputs: [], expectedOutput: [] }],
      removedTaskIds: []
    }, base);
    assert.ok("error" in modifyResult);
    assert.ok(typeof modifyResult.error === "string", "error should be a string");
    assert.ok(modifyResult.error.includes("T01"), "error should name the specific task ID");
    const removeResult = await handleReplanSlice({
      ...validReplanParams(),
      updatedTasks: [],
      removedTaskIds: ["T02"]
    }, base);
    assert.ok("error" in removeResult);
    assert.ok(removeResult.error.includes("T02"), "error should name the specific task ID T02");
  } finally {
    cleanup(base);
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9yZXBsYW4taGFuZGxlci50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCBmcm9tICdub2RlOnRlc3QnO1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgcm1TeW5jLCByZWFkRmlsZVN5bmMsIGV4aXN0c1N5bmMgfSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdub2RlOnBhdGgnO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSAnbm9kZTpvcyc7XG5cbmltcG9ydCB7XG4gIG9wZW5EYXRhYmFzZSxcbiAgY2xvc2VEYXRhYmFzZSxcbiAgaW5zZXJ0TWlsZXN0b25lLFxuICBpbnNlcnRTbGljZSxcbiAgaW5zZXJ0VGFzayxcbiAgdXBzZXJ0VGFza1BsYW5uaW5nLFxuICBnZXRTbGljZVRhc2tzLFxuICBnZXRUYXNrLFxuICBnZXRSZXBsYW5IaXN0b3J5LFxuICBfZ2V0QWRhcHRlcixcbn0gZnJvbSAnLi4vZ3NkLWRiLnRzJztcbmltcG9ydCB7IGhhbmRsZVJlcGxhblNsaWNlIH0gZnJvbSAnLi4vdG9vbHMvcmVwbGFuLXNsaWNlLnRzJztcbmltcG9ydCB7IHBhcnNlUGxhbiB9IGZyb20gJy4uL3BhcnNlcnMtbGVnYWN5LnRzJztcblxuZnVuY3Rpb24gbWFrZVRtcEJhc2UoKTogc3RyaW5nIHtcbiAgY29uc3QgYmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksICdnc2QtcmVwbGFuLScpKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJywgJ3NsaWNlcycsICdTMDEnLCAndGFza3MnKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHJldHVybiBiYXNlO1xufVxuXG5mdW5jdGlvbiBjbGVhbnVwKGJhc2U6IHN0cmluZyk6IHZvaWQge1xuICB0cnkgeyBjbG9zZURhdGFiYXNlKCk7IH0gY2F0Y2ggeyAvKiBub29wICovIH1cbiAgdHJ5IHsgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTsgfSBjYXRjaCB7IC8qIG5vb3AgKi8gfVxufVxuXG5mdW5jdGlvbiBzZWVkU2xpY2VXaXRoVGFza3Mob3B0cz86IHtcbiAgdDAxU3RhdHVzPzogc3RyaW5nO1xuICB0MDJTdGF0dXM/OiBzdHJpbmc7XG4gIHQwM1N0YXR1cz86IHN0cmluZztcbn0pOiB2b2lkIHtcbiAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdUZXN0IE1pbGVzdG9uZScsIHN0YXR1czogJ2FjdGl2ZScgfSk7XG4gIGluc2VydFNsaWNlKHsgaWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ1Rlc3QgU2xpY2UnLCBzdGF0dXM6ICdhY3RpdmUnLCBkZW1vOiAnRGVtby4nIH0pO1xuXG4gIGluc2VydFRhc2soeyBpZDogJ1QwMScsIHNsaWNlSWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ1Rhc2sgT25lJywgc3RhdHVzOiBvcHRzPy50MDFTdGF0dXMgPz8gJ2NvbXBsZXRlJyB9KTtcbiAgdXBzZXJ0VGFza1BsYW5uaW5nKCdNMDAxJywgJ1MwMScsICdUMDEnLCB7XG4gICAgZGVzY3JpcHRpb246ICdGaXJzdCB0YXNrIGRlc2NyaXB0aW9uLicsXG4gICAgZXN0aW1hdGU6ICczMG0nLFxuICAgIGZpbGVzOiBbJ3NyYy9hLnRzJ10sXG4gICAgdmVyaWZ5OiAnbm9kZSAtLXRlc3QgYS50ZXN0LnRzJyxcbiAgICBpbnB1dHM6IFsnc3JjL2EudHMnXSxcbiAgICBleHBlY3RlZE91dHB1dDogWydzcmMvYS50cyddLFxuICB9KTtcblxuICBpbnNlcnRUYXNrKHsgaWQ6ICdUMDInLCBzbGljZUlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdUYXNrIFR3bycsIHN0YXR1czogb3B0cz8udDAyU3RhdHVzID8/ICdwZW5kaW5nJyB9KTtcbiAgdXBzZXJ0VGFza1BsYW5uaW5nKCdNMDAxJywgJ1MwMScsICdUMDInLCB7XG4gICAgZGVzY3JpcHRpb246ICdTZWNvbmQgdGFzayBkZXNjcmlwdGlvbi4nLFxuICAgIGVzdGltYXRlOiAnNDVtJyxcbiAgICBmaWxlczogWydzcmMvYi50cyddLFxuICAgIHZlcmlmeTogJ25vZGUgLS10ZXN0IGIudGVzdC50cycsXG4gICAgaW5wdXRzOiBbJ3NyYy9iLnRzJ10sXG4gICAgZXhwZWN0ZWRPdXRwdXQ6IFsnc3JjL2IudHMnXSxcbiAgfSk7XG5cbiAgaWYgKG9wdHM/LnQwM1N0YXR1cyAhPT0gdW5kZWZpbmVkIHx8ICFvcHRzKSB7XG4gICAgaW5zZXJ0VGFzayh7IGlkOiAnVDAzJywgc2xpY2VJZDogJ1MwMScsIG1pbGVzdG9uZUlkOiAnTTAwMScsIHRpdGxlOiAnVGFzayBUaHJlZScsIHN0YXR1czogb3B0cz8udDAzU3RhdHVzID8/ICdwZW5kaW5nJyB9KTtcbiAgICB1cHNlcnRUYXNrUGxhbm5pbmcoJ00wMDEnLCAnUzAxJywgJ1QwMycsIHtcbiAgICAgIGRlc2NyaXB0aW9uOiAnVGhpcmQgdGFzayBkZXNjcmlwdGlvbi4nLFxuICAgICAgZXN0aW1hdGU6ICcyMG0nLFxuICAgICAgZmlsZXM6IFsnc3JjL2MudHMnXSxcbiAgICAgIHZlcmlmeTogJ25vZGUgLS10ZXN0IGMudGVzdC50cycsXG4gICAgICBpbnB1dHM6IFsnc3JjL2MudHMnXSxcbiAgICAgIGV4cGVjdGVkT3V0cHV0OiBbJ3NyYy9jLnRzJ10sXG4gICAgfSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRSZXBsYW5QYXJhbXMoKSB7XG4gIHJldHVybiB7XG4gICAgbWlsZXN0b25lSWQ6ICdNMDAxJyxcbiAgICBzbGljZUlkOiAnUzAxJyxcbiAgICBibG9ja2VyVGFza0lkOiAnVDAxJyxcbiAgICBibG9ja2VyRGVzY3JpcHRpb246ICdUMDEgZGlzY292ZXJlZCBhIGJsb2NrZXIgaW4gdGhlIEFQSS4nLFxuICAgIHdoYXRDaGFuZ2VkOiAnVXBkYXRlZCBUMDIgdG8gdXNlIG5ldyBBUEksIHJlbW92ZWQgVDAzLCBhZGRlZCBUMDQuJyxcbiAgICB1cGRhdGVkVGFza3M6IFtcbiAgICAgIHtcbiAgICAgICAgdGFza0lkOiAnVDAyJyxcbiAgICAgICAgdGl0bGU6ICdVcGRhdGVkIFRhc2sgVHdvJyxcbiAgICAgICAgZGVzY3JpcHRpb246ICdSZXZpc2VkIGRlc2NyaXB0aW9uIGZvciBUMDIuJyxcbiAgICAgICAgZXN0aW1hdGU6ICcxaCcsXG4gICAgICAgIGZpbGVzOiBbJ3NyYy9iLXYyLnRzJ10sXG4gICAgICAgIHZlcmlmeTogJ25vZGUgLS10ZXN0IGItdjIudGVzdC50cycsXG4gICAgICAgIGlucHV0czogWydzcmMvYi50cyddLFxuICAgICAgICBleHBlY3RlZE91dHB1dDogWydzcmMvYi12Mi50cyddLFxuICAgICAgfSxcbiAgICBdLFxuICAgIHJlbW92ZWRUYXNrSWRzOiBbJ1QwMyddLFxuICB9O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoJ2hhbmRsZVJlcGxhblNsaWNlIHJlamVjdHMgaW52YWxpZCBwYXlsb2FkcyAobWlzc2luZyBtaWxlc3RvbmVJZCknLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCAnLmdzZCcsICdnc2QuZGInKSk7XG5cbiAgdHJ5IHtcbiAgICBzZWVkU2xpY2VXaXRoVGFza3MoKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVSZXBsYW5TbGljZSh7IC4uLnZhbGlkUmVwbGFuUGFyYW1zKCksIG1pbGVzdG9uZUlkOiAnJyB9LCBiYXNlKTtcbiAgICBhc3NlcnQub2soJ2Vycm9yJyBpbiByZXN1bHQpO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQuZXJyb3IsIC92YWxpZGF0aW9uIGZhaWxlZC8pO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQuZXJyb3IsIC9taWxlc3RvbmVJZC8pO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KCdoYW5kbGVSZXBsYW5TbGljZSByZWplY3RzIHN0cnVjdHVyYWwgdmlvbGF0aW9uOiB1cGRhdGluZyBhIGNvbXBsZXRlZCB0YXNrJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgJy5nc2QnLCAnZ3NkLmRiJykpO1xuXG4gIHRyeSB7XG4gICAgc2VlZFNsaWNlV2l0aFRhc2tzKHsgdDAxU3RhdHVzOiAnY29tcGxldGUnLCB0MDJTdGF0dXM6ICdwZW5kaW5nJyB9KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZVJlcGxhblNsaWNlKHtcbiAgICAgIC4uLnZhbGlkUmVwbGFuUGFyYW1zKCksXG4gICAgICB1cGRhdGVkVGFza3M6IFtcbiAgICAgICAge1xuICAgICAgICAgIHRhc2tJZDogJ1QwMScsXG4gICAgICAgICAgdGl0bGU6ICdUcnlpbmcgdG8gdXBkYXRlIGNvbXBsZXRlZCBUMDEnLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiAnU2hvdWxkIGJlIHJlamVjdGVkLicsXG4gICAgICAgICAgZXN0aW1hdGU6ICcxaCcsXG4gICAgICAgICAgZmlsZXM6IFtdLFxuICAgICAgICAgIHZlcmlmeTogJycsXG4gICAgICAgICAgaW5wdXRzOiBbXSxcbiAgICAgICAgICBleHBlY3RlZE91dHB1dDogW10sXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgICAgcmVtb3ZlZFRhc2tJZHM6IFtdLFxuICAgIH0sIGJhc2UpO1xuXG4gICAgYXNzZXJ0Lm9rKCdlcnJvcicgaW4gcmVzdWx0KTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LmVycm9yLCAvY29tcGxldGVkIHRhc2svKTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LmVycm9yLCAvVDAxLyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoJ2hhbmRsZVJlcGxhblNsaWNlIHJlamVjdHMgc3RydWN0dXJhbCB2aW9sYXRpb246IHJlbW92aW5nIGEgY29tcGxldGVkIHRhc2snLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCAnLmdzZCcsICdnc2QuZGInKSk7XG5cbiAgdHJ5IHtcbiAgICBzZWVkU2xpY2VXaXRoVGFza3MoeyB0MDFTdGF0dXM6ICdjb21wbGV0ZScsIHQwMlN0YXR1czogJ3BlbmRpbmcnIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlUmVwbGFuU2xpY2Uoe1xuICAgICAgLi4udmFsaWRSZXBsYW5QYXJhbXMoKSxcbiAgICAgIHVwZGF0ZWRUYXNrczogW10sXG4gICAgICByZW1vdmVkVGFza0lkczogWydUMDEnXSxcbiAgICB9LCBiYXNlKTtcblxuICAgIGFzc2VydC5vaygnZXJyb3InIGluIHJlc3VsdCk7XG4gICAgYXNzZXJ0Lm1hdGNoKHJlc3VsdC5lcnJvciwgL2NvbXBsZXRlZCB0YXNrLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKHJlc3VsdC5lcnJvciwgL1QwMS8pO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KCdoYW5kbGVSZXBsYW5TbGljZSBzdWNjZWVkcyB3aGVuIG1vZGlmeWluZyBvbmx5IGluY29tcGxldGUgdGFza3MnLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCAnLmdzZCcsICdnc2QuZGInKSk7XG5cbiAgdHJ5IHtcbiAgICBzZWVkU2xpY2VXaXRoVGFza3MoeyB0MDFTdGF0dXM6ICdjb21wbGV0ZScsIHQwMlN0YXR1czogJ3BlbmRpbmcnLCB0MDNTdGF0dXM6ICdwZW5kaW5nJyB9KTtcblxuICAgIGNvbnN0IHBhcmFtcyA9IHtcbiAgICAgIC4uLnZhbGlkUmVwbGFuUGFyYW1zKCksXG4gICAgICB1cGRhdGVkVGFza3M6IFtcbiAgICAgICAge1xuICAgICAgICAgIHRhc2tJZDogJ1QwMicsXG4gICAgICAgICAgdGl0bGU6ICdVcGRhdGVkIFRhc2sgVHdvJyxcbiAgICAgICAgICBkZXNjcmlwdGlvbjogJ1JldmlzZWQgZGVzY3JpcHRpb24gZm9yIFQwMi4nLFxuICAgICAgICAgIGVzdGltYXRlOiAnMWgnLFxuICAgICAgICAgIGZpbGVzOiBbJ3NyYy9iLXYyLnRzJ10sXG4gICAgICAgICAgdmVyaWZ5OiAnbm9kZSAtLXRlc3QgYi12Mi50ZXN0LnRzJyxcbiAgICAgICAgICBpbnB1dHM6IFsnc3JjL2IudHMnXSxcbiAgICAgICAgICBleHBlY3RlZE91dHB1dDogWydzcmMvYi12Mi50cyddLFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgdGFza0lkOiAnVDA0JyxcbiAgICAgICAgICB0aXRsZTogJ05ldyBUYXNrIEZvdXInLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiAnQnJhbmQgbmV3IHRhc2sgYWRkZWQgZHVyaW5nIHJlcGxhbi4nLFxuICAgICAgICAgIGVzdGltYXRlOiAnMzBtJyxcbiAgICAgICAgICBmaWxlczogWydzcmMvZC50cyddLFxuICAgICAgICAgIHZlcmlmeTogJ25vZGUgLS10ZXN0IGQudGVzdC50cycsXG4gICAgICAgICAgaW5wdXRzOiBbXSxcbiAgICAgICAgICBleHBlY3RlZE91dHB1dDogWydzcmMvZC50cyddLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICAgIHJlbW92ZWRUYXNrSWRzOiBbJ1QwMyddLFxuICAgIH07XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVSZXBsYW5TbGljZShwYXJhbXMsIGJhc2UpO1xuICAgIGFzc2VydC5vayghKCdlcnJvcicgaW4gcmVzdWx0KSwgYHVuZXhwZWN0ZWQgZXJyb3I6ICR7J2Vycm9yJyBpbiByZXN1bHQgPyByZXN1bHQuZXJyb3IgOiAnJ31gKTtcblxuICAgIC8vIFZlcmlmeSByZXBsYW5faGlzdG9yeSByb3cgZXhpc3RzXG4gICAgY29uc3QgaGlzdG9yeSA9IGdldFJlcGxhbkhpc3RvcnkoJ00wMDEnLCAnUzAxJyk7XG4gICAgYXNzZXJ0Lm9rKGhpc3RvcnkubGVuZ3RoID4gMCwgJ3JlcGxhbl9oaXN0b3J5IHNob3VsZCBoYXZlIGF0IGxlYXN0IG9uZSBlbnRyeScpO1xuICAgIGFzc2VydC5lcXVhbChoaXN0b3J5WzBdWydtaWxlc3RvbmVfaWQnXSwgJ00wMDEnKTtcbiAgICBhc3NlcnQuZXF1YWwoaGlzdG9yeVswXVsnc2xpY2VfaWQnXSwgJ1MwMScpO1xuICAgIGFzc2VydC5lcXVhbChoaXN0b3J5WzBdWyd0YXNrX2lkJ10sICdUMDEnKTtcblxuICAgIC8vIFZlcmlmeSBUMDIgd2FzIHVwZGF0ZWRcbiAgICBjb25zdCB0MDIgPSBnZXRUYXNrKCdNMDAxJywgJ1MwMScsICdUMDInKTtcbiAgICBhc3NlcnQub2sodDAyLCAnVDAyIHNob3VsZCBzdGlsbCBleGlzdCcpO1xuICAgIGFzc2VydC5lcXVhbCh0MDI/LnRpdGxlLCAnVXBkYXRlZCBUYXNrIFR3bycpO1xuICAgIGFzc2VydC5lcXVhbCh0MDI/LmRlc2NyaXB0aW9uLCAnUmV2aXNlZCBkZXNjcmlwdGlvbiBmb3IgVDAyLicpO1xuXG4gICAgLy8gVmVyaWZ5IFQwMyB3YXMgZGVsZXRlZFxuICAgIGNvbnN0IHQwMyA9IGdldFRhc2soJ00wMDEnLCAnUzAxJywgJ1QwMycpO1xuICAgIGFzc2VydC5lcXVhbCh0MDMsIG51bGwsICdUMDMgc2hvdWxkIGhhdmUgYmVlbiBkZWxldGVkJyk7XG5cbiAgICAvLyBWZXJpZnkgVDA0IHdhcyBpbnNlcnRlZFxuICAgIGNvbnN0IHQwNCA9IGdldFRhc2soJ00wMDEnLCAnUzAxJywgJ1QwNCcpO1xuICAgIGFzc2VydC5vayh0MDQsICdUMDQgc2hvdWxkIGV4aXN0IGFzIGEgbmV3IHRhc2snKTtcbiAgICBhc3NlcnQuZXF1YWwodDA0Py50aXRsZSwgJ05ldyBUYXNrIEZvdXInKTtcbiAgICBhc3NlcnQuZXF1YWwodDA0Py5zdGF0dXMsICdwZW5kaW5nJyk7XG5cbiAgICAvLyBWZXJpZnkgVDAxIChjb21wbGV0ZWQpIHdhcyBOT1QgdG91Y2hlZFxuICAgIGNvbnN0IHQwMSA9IGdldFRhc2soJ00wMDEnLCAnUzAxJywgJ1QwMScpO1xuICAgIGFzc2VydC5vayh0MDEsICdUMDEgc2hvdWxkIHN0aWxsIGV4aXN0Jyk7XG4gICAgYXNzZXJ0LmVxdWFsKHQwMT8uc3RhdHVzLCAnY29tcGxldGUnKTtcblxuICAgIC8vIFZlcmlmeSByZW5kZXJlZCBQTEFOLm1kIGV4aXN0cyBvbiBkaXNrXG4gICAgY29uc3QgcGxhblBhdGggPSBqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScsICdzbGljZXMnLCAnUzAxJywgJ1MwMS1QTEFOLm1kJyk7XG4gICAgYXNzZXJ0Lm9rKGV4aXN0c1N5bmMocGxhblBhdGgpLCAnUExBTi5tZCBzaG91bGQgYmUgcmVuZGVyZWQgdG8gZGlzaycpO1xuXG4gICAgLy8gVmVyaWZ5IFJFUExBTi5tZCBleGlzdHMgb24gZGlza1xuICAgIGNvbnN0IHJlcGxhblBhdGggPSBqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScsICdzbGljZXMnLCAnUzAxJywgJ1MwMS1SRVBMQU4ubWQnKTtcbiAgICBhc3NlcnQub2soZXhpc3RzU3luYyhyZXBsYW5QYXRoKSwgJ1JFUExBTi5tZCBzaG91bGQgYmUgcmVuZGVyZWQgdG8gZGlzaycpO1xuICAgIGNvbnN0IHJlcGxhbkNvbnRlbnQgPSByZWFkRmlsZVN5bmMocmVwbGFuUGF0aCwgJ3V0Zi04Jyk7XG4gICAgYXNzZXJ0Lm9rKHJlcGxhbkNvbnRlbnQuaW5jbHVkZXMoJ0Jsb2NrZXIgRGVzY3JpcHRpb24nKSwgJ1JFUExBTi5tZCBzaG91bGQgY29udGFpbiBibG9ja2VyIHNlY3Rpb24nKTtcbiAgICBhc3NlcnQub2socmVwbGFuQ29udGVudC5pbmNsdWRlcygnVDAxJyksICdSRVBMQU4ubWQgc2hvdWxkIHJlZmVyZW5jZSBibG9ja2VyIHRhc2snKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdCgnaGFuZGxlUmVwbGFuU2xpY2UgY2FjaGUgaW52YWxpZGF0aW9uOiByZS1wYXJzaW5nIFBMQU4ubWQgcmVmbGVjdHMgbXV0YXRpb25zJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgJy5nc2QnLCAnZ3NkLmRiJykpO1xuXG4gIHRyeSB7XG4gICAgc2VlZFNsaWNlV2l0aFRhc2tzKHsgdDAxU3RhdHVzOiAnY29tcGxldGUnLCB0MDJTdGF0dXM6ICdwZW5kaW5nJywgdDAzU3RhdHVzOiAncGVuZGluZycgfSk7XG5cbiAgICBjb25zdCBwYXJhbXMgPSB7XG4gICAgICAuLi52YWxpZFJlcGxhblBhcmFtcygpLFxuICAgICAgdXBkYXRlZFRhc2tzOiBbXG4gICAgICAgIHtcbiAgICAgICAgICB0YXNrSWQ6ICdUMDInLFxuICAgICAgICAgIHRpdGxlOiAnQ2FjaGUtVGVzdCBVcGRhdGVkIFQwMicsXG4gICAgICAgICAgZGVzY3JpcHRpb246ICdUaGlzIHRpdGxlIHNob3VsZCBhcHBlYXIgaW4gcmUtcGFyc2VkIHBsYW4uJyxcbiAgICAgICAgICBlc3RpbWF0ZTogJzFoJyxcbiAgICAgICAgICBmaWxlczogWydzcmMvYi50cyddLFxuICAgICAgICAgIHZlcmlmeTogJ3Rlc3QnLFxuICAgICAgICAgIGlucHV0czogW10sXG4gICAgICAgICAgZXhwZWN0ZWRPdXRwdXQ6IFtdLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICAgIHJlbW92ZWRUYXNrSWRzOiBbJ1QwMyddLFxuICAgIH07XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVSZXBsYW5TbGljZShwYXJhbXMsIGJhc2UpO1xuICAgIGFzc2VydC5vayghKCdlcnJvcicgaW4gcmVzdWx0KSwgYHVuZXhwZWN0ZWQgZXJyb3I6ICR7J2Vycm9yJyBpbiByZXN1bHQgPyByZXN1bHQuZXJyb3IgOiAnJ31gKTtcblxuICAgIC8vIFJlLXBhcnNlIFBMQU4ubWQgZnJvbSBkaXNrIHRvIHZlcmlmeSBjYWNoZSBpbnZhbGlkYXRpb24gd29ya2VkXG4gICAgY29uc3QgcGxhblBhdGggPSBqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScsICdzbGljZXMnLCAnUzAxJywgJ1MwMS1QTEFOLm1kJyk7XG4gICAgY29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhwbGFuUGF0aCwgJ3V0Zi04Jyk7XG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VQbGFuKGNvbnRlbnQpO1xuXG4gICAgLy8gVDAxIHNob3VsZCBzdGlsbCBiZSBwcmVzZW50IChjb21wbGV0ZWQsIHVudG91Y2hlZClcbiAgICBjb25zdCB0MDFUYXNrID0gcGFyc2VkLnRhc2tzLmZpbmQodCA9PiB0LmlkID09PSAnVDAxJyk7XG4gICAgYXNzZXJ0Lm9rKHQwMVRhc2ssICdjb21wbGV0ZWQgVDAxIHNob3VsZCByZW1haW4gaW4gcGFyc2VkIHBsYW4nKTtcblxuICAgIC8vIFQwMiBzaG91bGQgc2hvdyB1cGRhdGVkIHRpdGxlXG4gICAgY29uc3QgdDAyVGFzayA9IHBhcnNlZC50YXNrcy5maW5kKHQgPT4gdC5pZCA9PT0gJ1QwMicpO1xuICAgIGFzc2VydC5vayh0MDJUYXNrLCAnVDAyIHNob3VsZCBiZSBpbiBwYXJzZWQgcGxhbicpO1xuICAgIGFzc2VydC5vayh0MDJUYXNrPy50aXRsZT8uaW5jbHVkZXMoJ0NhY2hlLVRlc3QgVXBkYXRlZCBUMDInKSwgJ1QwMiB0aXRsZSBzaG91bGQgYmUgdXBkYXRlZCcpO1xuXG4gICAgLy8gVDAzIHNob3VsZCBiZSBnb25lXG4gICAgY29uc3QgdDAzVGFzayA9IHBhcnNlZC50YXNrcy5maW5kKHQgPT4gdC5pZCA9PT0gJ1QwMycpO1xuICAgIGFzc2VydC5lcXVhbCh0MDNUYXNrLCB1bmRlZmluZWQsICdUMDMgc2hvdWxkIG5vdCBhcHBlYXIgaW4gcGFyc2VkIHBsYW4gYWZ0ZXIgcmVtb3ZhbCcpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KCdoYW5kbGVSZXBsYW5TbGljZSBpcyBpZGVtcG90ZW50OiBjYWxsaW5nIHR3aWNlIHdpdGggc2FtZSBwYXJhbXMgc3VjY2VlZHMnLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCAnLmdzZCcsICdnc2QuZGInKSk7XG5cbiAgdHJ5IHtcbiAgICBzZWVkU2xpY2VXaXRoVGFza3MoeyB0MDFTdGF0dXM6ICdjb21wbGV0ZScsIHQwMlN0YXR1czogJ3BlbmRpbmcnLCB0MDNTdGF0dXM6ICdwZW5kaW5nJyB9KTtcblxuICAgIGNvbnN0IHBhcmFtcyA9IHtcbiAgICAgIC4uLnZhbGlkUmVwbGFuUGFyYW1zKCksXG4gICAgICB1cGRhdGVkVGFza3M6IFtcbiAgICAgICAge1xuICAgICAgICAgIHRhc2tJZDogJ1QwMicsXG4gICAgICAgICAgdGl0bGU6ICdJZGVtcG90ZW50IFVwZGF0ZScsXG4gICAgICAgICAgZGVzY3JpcHRpb246ICdTYW1lIHVwZGF0ZSBhcHBsaWVkIHR3aWNlLicsXG4gICAgICAgICAgZXN0aW1hdGU6ICcxaCcsXG4gICAgICAgICAgZmlsZXM6IFsnc3JjL2IudHMnXSxcbiAgICAgICAgICB2ZXJpZnk6ICd0ZXN0JyxcbiAgICAgICAgICBpbnB1dHM6IFtdLFxuICAgICAgICAgIGV4cGVjdGVkT3V0cHV0OiBbXSxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgICByZW1vdmVkVGFza0lkczogWydUMDMnXSxcbiAgICB9O1xuXG4gICAgY29uc3QgZmlyc3QgPSBhd2FpdCBoYW5kbGVSZXBsYW5TbGljZShwYXJhbXMsIGJhc2UpO1xuICAgIGFzc2VydC5vayghKCdlcnJvcicgaW4gZmlyc3QpLCBgZmlyc3QgY2FsbCBlcnJvcjogJHsnZXJyb3InIGluIGZpcnN0ID8gZmlyc3QuZXJyb3IgOiAnJ31gKTtcblxuICAgIGNvbnN0IHNlY29uZCA9IGF3YWl0IGhhbmRsZVJlcGxhblNsaWNlKHBhcmFtcywgYmFzZSk7XG4gICAgYXNzZXJ0Lm9rKCEoJ2Vycm9yJyBpbiBzZWNvbmQpLCBgc2Vjb25kIGNhbGwgZXJyb3I6ICR7J2Vycm9yJyBpbiBzZWNvbmQgPyBzZWNvbmQuZXJyb3IgOiAnJ31gKTtcblxuICAgIC8vIEJvdGggc2hvdWxkIHN1Y2NlZWQgYW5kIHJlcGxhbl9oaXN0b3J5IHNob3VsZCBoYXZlIDIgZW50cmllc1xuICAgIGNvbnN0IGhpc3RvcnkgPSBnZXRSZXBsYW5IaXN0b3J5KCdNMDAxJywgJ1MwMScpO1xuICAgIGFzc2VydC5vayhoaXN0b3J5Lmxlbmd0aCA+PSAyLCAncmVwbGFuX2hpc3Rvcnkgc2hvdWxkIGhhdmUgYXQgbGVhc3QgMiBlbnRyaWVzIGFmdGVyIGlkZW1wb3RlbnQgcmVydW4nKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdCgnaGFuZGxlUmVwbGFuU2xpY2UgcmV0dXJucyBtaXNzaW5nIHBhcmVudCBzbGljZSBlcnJvcicsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsICcuZ3NkJywgJ2dzZC5kYicpKTtcblxuICB0cnkge1xuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiAnTTAwMScsIHRpdGxlOiAnTWlsZXN0b25lJywgc3RhdHVzOiAnYWN0aXZlJyB9KTtcbiAgICAvLyBObyBzbGljZSBpbnNlcnRlZFxuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlUmVwbGFuU2xpY2UodmFsaWRSZXBsYW5QYXJhbXMoKSwgYmFzZSk7XG4gICAgYXNzZXJ0Lm9rKCdlcnJvcicgaW4gcmVzdWx0KTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LmVycm9yLCAvbWlzc2luZyBwYXJlbnQgc2xpY2UvKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdCgnaGFuZGxlUmVwbGFuU2xpY2UgcmVqZWN0cyB0YXNrIHdpdGggc3RhdHVzIFwiZG9uZVwiIChhbGlhcyBmb3IgY29tcGxldGUpJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgJy5nc2QnLCAnZ3NkLmRiJykpO1xuXG4gIHRyeSB7XG4gICAgc2VlZFNsaWNlV2l0aFRhc2tzKHsgdDAxU3RhdHVzOiAnZG9uZScsIHQwMlN0YXR1czogJ3BlbmRpbmcnIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlUmVwbGFuU2xpY2Uoe1xuICAgICAgLi4udmFsaWRSZXBsYW5QYXJhbXMoKSxcbiAgICAgIHVwZGF0ZWRUYXNrczogW1xuICAgICAgICB7XG4gICAgICAgICAgdGFza0lkOiAnVDAxJyxcbiAgICAgICAgICB0aXRsZTogJ1RyeWluZyB0byB1cGRhdGUgZG9uZSBUMDEnLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiAnU2hvdWxkIGJlIHJlamVjdGVkLicsXG4gICAgICAgICAgZXN0aW1hdGU6ICcxaCcsXG4gICAgICAgICAgZmlsZXM6IFtdLFxuICAgICAgICAgIHZlcmlmeTogJycsXG4gICAgICAgICAgaW5wdXRzOiBbXSxcbiAgICAgICAgICBleHBlY3RlZE91dHB1dDogW10sXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgICAgcmVtb3ZlZFRhc2tJZHM6IFtdLFxuICAgIH0sIGJhc2UpO1xuXG4gICAgYXNzZXJ0Lm9rKCdlcnJvcicgaW4gcmVzdWx0KTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LmVycm9yLCAvY29tcGxldGVkIHRhc2svKTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LmVycm9yLCAvVDAxLyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoJ2hhbmRsZVJlcGxhblNsaWNlIHJldHVybnMgc3RydWN0dXJlZCBlcnJvciBwYXlsb2FkcyB3aXRoIGFjdGlvbmFibGUgbWVzc2FnZXMnLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCAnLmdzZCcsICdnc2QuZGInKSk7XG5cbiAgdHJ5IHtcbiAgICBzZWVkU2xpY2VXaXRoVGFza3MoeyB0MDFTdGF0dXM6ICdjb21wbGV0ZScsIHQwMlN0YXR1czogJ2NvbXBsZXRlJywgdDAzU3RhdHVzOiAncGVuZGluZycgfSk7XG5cbiAgICAvLyBUcnkgdG8gbW9kaWZ5IFQwMSAoY29tcGxldGVkKVxuICAgIGNvbnN0IG1vZGlmeVJlc3VsdCA9IGF3YWl0IGhhbmRsZVJlcGxhblNsaWNlKHtcbiAgICAgIC4uLnZhbGlkUmVwbGFuUGFyYW1zKCksXG4gICAgICB1cGRhdGVkVGFza3M6IFt7IHRhc2tJZDogJ1QwMScsIHRpdGxlOiAneCcsIGRlc2NyaXB0aW9uOiAnJywgZXN0aW1hdGU6ICcnLCBmaWxlczogW10sIHZlcmlmeTogJycsIGlucHV0czogW10sIGV4cGVjdGVkT3V0cHV0OiBbXSB9XSxcbiAgICAgIHJlbW92ZWRUYXNrSWRzOiBbXSxcbiAgICB9LCBiYXNlKTtcbiAgICBhc3NlcnQub2soJ2Vycm9yJyBpbiBtb2RpZnlSZXN1bHQpO1xuICAgIGFzc2VydC5vayh0eXBlb2YgbW9kaWZ5UmVzdWx0LmVycm9yID09PSAnc3RyaW5nJywgJ2Vycm9yIHNob3VsZCBiZSBhIHN0cmluZycpO1xuICAgIGFzc2VydC5vayhtb2RpZnlSZXN1bHQuZXJyb3IuaW5jbHVkZXMoJ1QwMScpLCAnZXJyb3Igc2hvdWxkIG5hbWUgdGhlIHNwZWNpZmljIHRhc2sgSUQnKTtcblxuICAgIC8vIFRyeSB0byByZW1vdmUgVDAyIChjb21wbGV0ZWQpXG4gICAgY29uc3QgcmVtb3ZlUmVzdWx0ID0gYXdhaXQgaGFuZGxlUmVwbGFuU2xpY2Uoe1xuICAgICAgLi4udmFsaWRSZXBsYW5QYXJhbXMoKSxcbiAgICAgIHVwZGF0ZWRUYXNrczogW10sXG4gICAgICByZW1vdmVkVGFza0lkczogWydUMDInXSxcbiAgICB9LCBiYXNlKTtcbiAgICBhc3NlcnQub2soJ2Vycm9yJyBpbiByZW1vdmVSZXN1bHQpO1xuICAgIGFzc2VydC5vayhyZW1vdmVSZXN1bHQuZXJyb3IuaW5jbHVkZXMoJ1QwMicpLCAnZXJyb3Igc2hvdWxkIG5hbWUgdGhlIHNwZWNpZmljIHRhc2sgSUQgVDAyJyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxXQUFXLFFBQVEsY0FBYyxrQkFBa0I7QUFDekUsU0FBUyxZQUFZ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
