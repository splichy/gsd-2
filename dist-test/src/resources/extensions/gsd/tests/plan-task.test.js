import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, closeDatabase, insertMilestone, insertSlice, insertTask, getTask } from "../gsd-db.js";
import { handlePlanTask } from "../tools/plan-task.js";
import { parseTaskPlanFile } from "../files.js";
function makeTmpBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-plan-task-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S02", "tasks"), { recursive: true });
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
function seedParent() {
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Planning slice", status: "pending", demo: "Rendered plans exist." });
}
function validParams() {
  return {
    milestoneId: "M001",
    sliceId: "S02",
    taskId: "T02",
    title: "Write task handler",
    description: "Implement the DB-backed task planning handler.",
    estimate: "30m",
    files: ["src/resources/extensions/gsd/tools/plan-task.ts"],
    verify: "node --test src/resources/extensions/gsd/tests/plan-task.test.ts",
    inputs: ["src/resources/extensions/gsd/tools/plan-task.ts"],
    expectedOutput: ["src/resources/extensions/gsd/tests/plan-task.test.ts"],
    observabilityImpact: "Tests exercise validation, render failure, and cache refresh behavior."
  };
}
test("handlePlanTask writes planning state and renders task plan", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedParent();
    const result = await handlePlanTask(validParams(), base);
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    const task = getTask("M001", "S02", "T02");
    assert.ok(task);
    assert.equal(task?.title, "Write task handler");
    assert.equal(task?.description, "Implement the DB-backed task planning handler.");
    assert.equal(task?.estimate, "30m");
    const taskPlanPath = join(base, ".gsd", "milestones", "M001", "slices", "S02", "tasks", "T02-PLAN.md");
    assert.ok(existsSync(taskPlanPath), "task plan should be rendered to disk");
    const taskPlan = parseTaskPlanFile(readFileSync(taskPlanPath, "utf-8"));
    assert.equal(taskPlan.frontmatter.estimated_files, 1);
    assert.deepEqual(taskPlan.frontmatter.skills_used, []);
  } finally {
    cleanup(base);
  }
});
test("handlePlanTask rejects invalid payloads", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedParent();
    const result = await handlePlanTask({ ...validParams(), files: [""] }, base);
    assert.ok("error" in result);
    assert.match(result.error, /validation failed: files must contain only non-empty strings/);
  } finally {
    cleanup(base);
  }
});
test("handlePlanTask explains string IO fields must be arrays", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedParent();
    const result = await handlePlanTask({
      ...validParams(),
      expectedOutput: "src/output.ts"
    }, base);
    assert.ok("error" in result);
    assert.match(result.error, /validation failed: expectedOutput must be an array of strings, not string/);
  } finally {
    cleanup(base);
  }
});
test("handlePlanTask rejects absolute task IO paths outside the active worktree", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedParent();
    const outside = join(tmpdir(), "outside-checkout", "index.html");
    const result = await handlePlanTask({
      ...validParams(),
      inputs: [outside],
      expectedOutput: [outside]
    }, base);
    assert.ok("error" in result);
    assert.match(result.error, /validation failed: inputs contains absolute path outside working directory/);
    assert.equal(getTask("M001", "S02", "T02"), null, "invalid planning IO must not persist the task");
  } finally {
    cleanup(base);
  }
});
test("handlePlanTask rejects missing parent slice", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    const result = await handlePlanTask(validParams(), base);
    assert.ok("error" in result);
    assert.match(result.error, /missing parent slice: M001\/S02/);
  } finally {
    cleanup(base);
  }
});
test("handlePlanTask surfaces render failures without changing parse-visible task plan state", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedParent();
    insertTask({ id: "T02", sliceId: "S02", milestoneId: "M001", title: "Cached task", status: "pending" });
    const taskPlanPath = join(base, ".gsd", "milestones", "M001", "slices", "S02", "tasks", "T02-PLAN.md");
    writeFileSync(taskPlanPath, "---\nestimated_steps: 1\nestimated_files: 1\nskills_used: []\n---\n\n# T02: Cached task\n", "utf-8");
    rmSync(taskPlanPath, { force: true });
    mkdirSync(taskPlanPath, { recursive: true });
    const result = await handlePlanTask(validParams(), base);
    assert.ok("error" in result);
    assert.match(result.error, /render failed:/);
  } finally {
    cleanup(base);
  }
});
test("handlePlanTask reruns idempotently and refreshes parse-visible state", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedParent();
    const taskPlanPath = join(base, ".gsd", "milestones", "M001", "slices", "S02", "tasks", "T02-PLAN.md");
    writeFileSync(taskPlanPath, "---\nestimated_steps: 1\nestimated_files: 1\nskills_used: []\n---\n\n# T02: Cached task\n", "utf-8");
    const first = await handlePlanTask(validParams(), base);
    assert.ok(!("error" in first));
    const second = await handlePlanTask({
      ...validParams(),
      description: "Updated task handler description.",
      estimate: "1h"
    }, base);
    assert.ok(!("error" in second));
    const task = getTask("M001", "S02", "T02");
    assert.equal(task?.description, "Updated task handler description.");
    assert.equal(task?.estimate, "1h");
    const parsed = parseTaskPlanFile(readFileSync(taskPlanPath, "utf-8"));
    assert.equal(parsed.frontmatter.estimated_steps, 1);
    assert.match(readFileSync(taskPlanPath, "utf-8"), /Updated task handler description\./);
  } finally {
    cleanup(base);
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wbGFuLXRhc2sudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHRlc3QgZnJvbSAnbm9kZTp0ZXN0JztcbmltcG9ydCBhc3NlcnQgZnJvbSAnbm9kZTphc3NlcnQvc3RyaWN0JztcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBta2RpclN5bmMsIHJtU3luYywgcmVhZEZpbGVTeW5jLCBleGlzdHNTeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSAnbm9kZTpmcyc7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJztcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gJ25vZGU6b3MnO1xuXG5pbXBvcnQgeyBvcGVuRGF0YWJhc2UsIGNsb3NlRGF0YWJhc2UsIGluc2VydE1pbGVzdG9uZSwgaW5zZXJ0U2xpY2UsIGluc2VydFRhc2ssIGdldFRhc2sgfSBmcm9tICcuLi9nc2QtZGIudHMnO1xuaW1wb3J0IHsgaGFuZGxlUGxhblRhc2sgfSBmcm9tICcuLi90b29scy9wbGFuLXRhc2sudHMnO1xuaW1wb3J0IHsgcGFyc2VUYXNrUGxhbkZpbGUgfSBmcm9tICcuLi9maWxlcy50cyc7XG5cbmZ1bmN0aW9uIG1ha2VUbXBCYXNlKCk6IHN0cmluZyB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCAnZ3NkLXBsYW4tdGFzay0nKSk7XG4gIG1rZGlyU3luYyhqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScsICdzbGljZXMnLCAnUzAyJywgJ3Rhc2tzJyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICByZXR1cm4gYmFzZTtcbn1cblxuZnVuY3Rpb24gY2xlYW51cChiYXNlOiBzdHJpbmcpOiB2b2lkIHtcbiAgdHJ5IHsgY2xvc2VEYXRhYmFzZSgpOyB9IGNhdGNoIHsgLyogbm9vcCAqLyB9XG4gIHRyeSB7IHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0gY2F0Y2ggeyAvKiBub29wICovIH1cbn1cblxuZnVuY3Rpb24gc2VlZFBhcmVudCgpOiB2b2lkIHtcbiAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdNaWxlc3RvbmUnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuICBpbnNlcnRTbGljZSh7IGlkOiAnUzAyJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdQbGFubmluZyBzbGljZScsIHN0YXR1czogJ3BlbmRpbmcnLCBkZW1vOiAnUmVuZGVyZWQgcGxhbnMgZXhpc3QuJyB9KTtcbn1cblxuZnVuY3Rpb24gdmFsaWRQYXJhbXMoKSB7XG4gIHJldHVybiB7XG4gICAgbWlsZXN0b25lSWQ6ICdNMDAxJyxcbiAgICBzbGljZUlkOiAnUzAyJyxcbiAgICB0YXNrSWQ6ICdUMDInLFxuICAgIHRpdGxlOiAnV3JpdGUgdGFzayBoYW5kbGVyJyxcbiAgICBkZXNjcmlwdGlvbjogJ0ltcGxlbWVudCB0aGUgREItYmFja2VkIHRhc2sgcGxhbm5pbmcgaGFuZGxlci4nLFxuICAgIGVzdGltYXRlOiAnMzBtJyxcbiAgICBmaWxlczogWydzcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL3Rvb2xzL3BsYW4tdGFzay50cyddLFxuICAgIHZlcmlmeTogJ25vZGUgLS10ZXN0IHNyYy9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvdGVzdHMvcGxhbi10YXNrLnRlc3QudHMnLFxuICAgIGlucHV0czogWydzcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL3Rvb2xzL3BsYW4tdGFzay50cyddLFxuICAgIGV4cGVjdGVkT3V0cHV0OiBbJ3NyYy9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvdGVzdHMvcGxhbi10YXNrLnRlc3QudHMnXSxcbiAgICBvYnNlcnZhYmlsaXR5SW1wYWN0OiAnVGVzdHMgZXhlcmNpc2UgdmFsaWRhdGlvbiwgcmVuZGVyIGZhaWx1cmUsIGFuZCBjYWNoZSByZWZyZXNoIGJlaGF2aW9yLicsXG4gIH07XG59XG5cbnRlc3QoJ2hhbmRsZVBsYW5UYXNrIHdyaXRlcyBwbGFubmluZyBzdGF0ZSBhbmQgcmVuZGVycyB0YXNrIHBsYW4nLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCAnLmdzZCcsICdnc2QuZGInKSk7XG5cbiAgdHJ5IHtcbiAgICBzZWVkUGFyZW50KCk7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlUGxhblRhc2sodmFsaWRQYXJhbXMoKSwgYmFzZSk7XG4gICAgYXNzZXJ0Lm9rKCEoJ2Vycm9yJyBpbiByZXN1bHQpLCBgdW5leHBlY3RlZCBlcnJvcjogJHsnZXJyb3InIGluIHJlc3VsdCA/IHJlc3VsdC5lcnJvciA6ICcnfWApO1xuXG4gICAgY29uc3QgdGFzayA9IGdldFRhc2soJ00wMDEnLCAnUzAyJywgJ1QwMicpO1xuICAgIGFzc2VydC5vayh0YXNrKTtcbiAgICBhc3NlcnQuZXF1YWwodGFzaz8udGl0bGUsICdXcml0ZSB0YXNrIGhhbmRsZXInKTtcbiAgICBhc3NlcnQuZXF1YWwodGFzaz8uZGVzY3JpcHRpb24sICdJbXBsZW1lbnQgdGhlIERCLWJhY2tlZCB0YXNrIHBsYW5uaW5nIGhhbmRsZXIuJyk7XG4gICAgYXNzZXJ0LmVxdWFsKHRhc2s/LmVzdGltYXRlLCAnMzBtJyk7XG5cbiAgICBjb25zdCB0YXNrUGxhblBhdGggPSBqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScsICdzbGljZXMnLCAnUzAyJywgJ3Rhc2tzJywgJ1QwMi1QTEFOLm1kJyk7XG4gICAgYXNzZXJ0Lm9rKGV4aXN0c1N5bmModGFza1BsYW5QYXRoKSwgJ3Rhc2sgcGxhbiBzaG91bGQgYmUgcmVuZGVyZWQgdG8gZGlzaycpO1xuICAgIGNvbnN0IHRhc2tQbGFuID0gcGFyc2VUYXNrUGxhbkZpbGUocmVhZEZpbGVTeW5jKHRhc2tQbGFuUGF0aCwgJ3V0Zi04JykpO1xuICAgIGFzc2VydC5lcXVhbCh0YXNrUGxhbi5mcm9udG1hdHRlci5lc3RpbWF0ZWRfZmlsZXMsIDEpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwodGFza1BsYW4uZnJvbnRtYXR0ZXIuc2tpbGxzX3VzZWQsIFtdKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdCgnaGFuZGxlUGxhblRhc2sgcmVqZWN0cyBpbnZhbGlkIHBheWxvYWRzJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgJy5nc2QnLCAnZ3NkLmRiJykpO1xuXG4gIHRyeSB7XG4gICAgc2VlZFBhcmVudCgpO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZVBsYW5UYXNrKHsgLi4udmFsaWRQYXJhbXMoKSwgZmlsZXM6IFsnJ10gfSwgYmFzZSk7XG4gICAgYXNzZXJ0Lm9rKCdlcnJvcicgaW4gcmVzdWx0KTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LmVycm9yLCAvdmFsaWRhdGlvbiBmYWlsZWQ6IGZpbGVzIG11c3QgY29udGFpbiBvbmx5IG5vbi1lbXB0eSBzdHJpbmdzLyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoJ2hhbmRsZVBsYW5UYXNrIGV4cGxhaW5zIHN0cmluZyBJTyBmaWVsZHMgbXVzdCBiZSBhcnJheXMnLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCAnLmdzZCcsICdnc2QuZGInKSk7XG5cbiAgdHJ5IHtcbiAgICBzZWVkUGFyZW50KCk7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlUGxhblRhc2soe1xuICAgICAgLi4udmFsaWRQYXJhbXMoKSxcbiAgICAgIGV4cGVjdGVkT3V0cHV0OiAnc3JjL291dHB1dC50cycgYXMgdW5rbm93biBhcyBzdHJpbmdbXSxcbiAgICB9LCBiYXNlKTtcbiAgICBhc3NlcnQub2soJ2Vycm9yJyBpbiByZXN1bHQpO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQuZXJyb3IsIC92YWxpZGF0aW9uIGZhaWxlZDogZXhwZWN0ZWRPdXRwdXQgbXVzdCBiZSBhbiBhcnJheSBvZiBzdHJpbmdzLCBub3Qgc3RyaW5nLyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoJ2hhbmRsZVBsYW5UYXNrIHJlamVjdHMgYWJzb2x1dGUgdGFzayBJTyBwYXRocyBvdXRzaWRlIHRoZSBhY3RpdmUgd29ya3RyZWUnLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCAnLmdzZCcsICdnc2QuZGInKSk7XG5cbiAgdHJ5IHtcbiAgICBzZWVkUGFyZW50KCk7XG4gICAgY29uc3Qgb3V0c2lkZSA9IGpvaW4odG1wZGlyKCksICdvdXRzaWRlLWNoZWNrb3V0JywgJ2luZGV4Lmh0bWwnKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVQbGFuVGFzayh7XG4gICAgICAuLi52YWxpZFBhcmFtcygpLFxuICAgICAgaW5wdXRzOiBbb3V0c2lkZV0sXG4gICAgICBleHBlY3RlZE91dHB1dDogW291dHNpZGVdLFxuICAgIH0sIGJhc2UpO1xuXG4gICAgYXNzZXJ0Lm9rKCdlcnJvcicgaW4gcmVzdWx0KTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LmVycm9yLCAvdmFsaWRhdGlvbiBmYWlsZWQ6IGlucHV0cyBjb250YWlucyBhYnNvbHV0ZSBwYXRoIG91dHNpZGUgd29ya2luZyBkaXJlY3RvcnkvKTtcbiAgICBhc3NlcnQuZXF1YWwoZ2V0VGFzaygnTTAwMScsICdTMDInLCAnVDAyJyksIG51bGwsICdpbnZhbGlkIHBsYW5uaW5nIElPIG11c3Qgbm90IHBlcnNpc3QgdGhlIHRhc2snKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdCgnaGFuZGxlUGxhblRhc2sgcmVqZWN0cyBtaXNzaW5nIHBhcmVudCBzbGljZScsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsICcuZ3NkJywgJ2dzZC5kYicpKTtcblxuICB0cnkge1xuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiAnTTAwMScsIHRpdGxlOiAnTWlsZXN0b25lJywgc3RhdHVzOiAnYWN0aXZlJyB9KTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVQbGFuVGFzayh2YWxpZFBhcmFtcygpLCBiYXNlKTtcbiAgICBhc3NlcnQub2soJ2Vycm9yJyBpbiByZXN1bHQpO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQuZXJyb3IsIC9taXNzaW5nIHBhcmVudCBzbGljZTogTTAwMVxcL1MwMi8pO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KCdoYW5kbGVQbGFuVGFzayBzdXJmYWNlcyByZW5kZXIgZmFpbHVyZXMgd2l0aG91dCBjaGFuZ2luZyBwYXJzZS12aXNpYmxlIHRhc2sgcGxhbiBzdGF0ZScsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsICcuZ3NkJywgJ2dzZC5kYicpKTtcblxuICB0cnkge1xuICAgIHNlZWRQYXJlbnQoKTtcbiAgICBpbnNlcnRUYXNrKHsgaWQ6ICdUMDInLCBzbGljZUlkOiAnUzAyJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdDYWNoZWQgdGFzaycsIHN0YXR1czogJ3BlbmRpbmcnIH0pO1xuICAgIGNvbnN0IHRhc2tQbGFuUGF0aCA9IGpvaW4oYmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJywgJ3NsaWNlcycsICdTMDInLCAndGFza3MnLCAnVDAyLVBMQU4ubWQnKTtcbiAgICB3cml0ZUZpbGVTeW5jKHRhc2tQbGFuUGF0aCwgJy0tLVxcbmVzdGltYXRlZF9zdGVwczogMVxcbmVzdGltYXRlZF9maWxlczogMVxcbnNraWxsc191c2VkOiBbXVxcbi0tLVxcblxcbiMgVDAyOiBDYWNoZWQgdGFza1xcbicsICd1dGYtOCcpO1xuICAgIHJtU3luYyh0YXNrUGxhblBhdGgsIHsgZm9yY2U6IHRydWUgfSk7XG4gICAgbWtkaXJTeW5jKHRhc2tQbGFuUGF0aCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVQbGFuVGFzayh2YWxpZFBhcmFtcygpLCBiYXNlKTtcbiAgICBhc3NlcnQub2soJ2Vycm9yJyBpbiByZXN1bHQpO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQuZXJyb3IsIC9yZW5kZXIgZmFpbGVkOi8pO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KCdoYW5kbGVQbGFuVGFzayByZXJ1bnMgaWRlbXBvdGVudGx5IGFuZCByZWZyZXNoZXMgcGFyc2UtdmlzaWJsZSBzdGF0ZScsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsICcuZ3NkJywgJ2dzZC5kYicpKTtcblxuICB0cnkge1xuICAgIHNlZWRQYXJlbnQoKTtcbiAgICBjb25zdCB0YXNrUGxhblBhdGggPSBqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScsICdzbGljZXMnLCAnUzAyJywgJ3Rhc2tzJywgJ1QwMi1QTEFOLm1kJyk7XG4gICAgd3JpdGVGaWxlU3luYyh0YXNrUGxhblBhdGgsICctLS1cXG5lc3RpbWF0ZWRfc3RlcHM6IDFcXG5lc3RpbWF0ZWRfZmlsZXM6IDFcXG5za2lsbHNfdXNlZDogW11cXG4tLS1cXG5cXG4jIFQwMjogQ2FjaGVkIHRhc2tcXG4nLCAndXRmLTgnKTtcblxuICAgIGNvbnN0IGZpcnN0ID0gYXdhaXQgaGFuZGxlUGxhblRhc2sodmFsaWRQYXJhbXMoKSwgYmFzZSk7XG4gICAgYXNzZXJ0Lm9rKCEoJ2Vycm9yJyBpbiBmaXJzdCkpO1xuXG4gICAgY29uc3Qgc2Vjb25kID0gYXdhaXQgaGFuZGxlUGxhblRhc2soe1xuICAgICAgLi4udmFsaWRQYXJhbXMoKSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnVXBkYXRlZCB0YXNrIGhhbmRsZXIgZGVzY3JpcHRpb24uJyxcbiAgICAgIGVzdGltYXRlOiAnMWgnLFxuICAgIH0sIGJhc2UpO1xuICAgIGFzc2VydC5vayghKCdlcnJvcicgaW4gc2Vjb25kKSk7XG5cbiAgICBjb25zdCB0YXNrID0gZ2V0VGFzaygnTTAwMScsICdTMDInLCAnVDAyJyk7XG4gICAgYXNzZXJ0LmVxdWFsKHRhc2s/LmRlc2NyaXB0aW9uLCAnVXBkYXRlZCB0YXNrIGhhbmRsZXIgZGVzY3JpcHRpb24uJyk7XG4gICAgYXNzZXJ0LmVxdWFsKHRhc2s/LmVzdGltYXRlLCAnMWgnKTtcblxuICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlVGFza1BsYW5GaWxlKHJlYWRGaWxlU3luYyh0YXNrUGxhblBhdGgsICd1dGYtOCcpKTtcbiAgICBhc3NlcnQuZXF1YWwocGFyc2VkLmZyb250bWF0dGVyLmVzdGltYXRlZF9zdGVwcywgMSk7XG4gICAgYXNzZXJ0Lm1hdGNoKHJlYWRGaWxlU3luYyh0YXNrUGxhblBhdGgsICd1dGYtOCcpLCAvVXBkYXRlZCB0YXNrIGhhbmRsZXIgZGVzY3JpcHRpb25cXC4vKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhLFdBQVcsUUFBUSxjQUFjLFlBQVkscUJBQXFCO0FBQ3hG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
