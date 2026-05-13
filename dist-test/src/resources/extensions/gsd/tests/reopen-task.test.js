import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  getTask
} from "../gsd-db.js";
import { handleReopenTask } from "../tools/reopen-task.js";
function makeTmpBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-reopen-task-"));
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
function seedCompleteTask() {
  insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Test Slice", status: "in_progress" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task One", status: "complete" });
  insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Task Two", status: "pending" });
}
test("handleReopenTask: resets a complete task to pending", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedCompleteTask();
    const result = await handleReopenTask({
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      reason: "verification failed after merge"
    }, base);
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    assert.equal(result.taskId, "T01");
    const task = getTask("M001", "S01", "T01");
    assert.ok(task, "task should still exist");
    assert.equal(task.status, "pending", "task status should be reset to pending");
  } finally {
    cleanup(base);
  }
});
test("handleReopenTask: does not affect other tasks in the slice", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedCompleteTask();
    await handleReopenTask({ milestoneId: "M001", sliceId: "S01", taskId: "T01" }, base);
    const t02 = getTask("M001", "S01", "T02");
    assert.ok(t02, "T02 should still exist");
    assert.equal(t02.status, "pending", "T02 status should be unchanged");
  } finally {
    cleanup(base);
  }
});
test("handleReopenTask: rejects empty taskId", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    const result = await handleReopenTask({ milestoneId: "M001", sliceId: "S01", taskId: "" }, base);
    assert.ok("error" in result);
    assert.match(result.error, /taskId/);
  } finally {
    cleanup(base);
  }
});
test("handleReopenTask: rejects non-existent milestone", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    const result = await handleReopenTask({ milestoneId: "M999", sliceId: "S01", taskId: "T01" }, base);
    assert.ok("error" in result);
    assert.match(result.error, /milestone not found/);
  } finally {
    cleanup(base);
  }
});
test("handleReopenTask: rejects task in a closed milestone", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    insertMilestone({ id: "M001", title: "Done", status: "complete" });
    insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete" });
    const result = await handleReopenTask({ milestoneId: "M001", sliceId: "S01", taskId: "T01" }, base);
    assert.ok("error" in result);
    assert.match(result.error, /closed milestone/);
  } finally {
    cleanup(base);
  }
});
test("handleReopenTask: rejects task inside a closed slice", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    insertMilestone({ id: "M001", title: "Active", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete" });
    const result = await handleReopenTask({ milestoneId: "M001", sliceId: "S01", taskId: "T01" }, base);
    assert.ok("error" in result);
    assert.match(result.error, /closed slice/);
  } finally {
    cleanup(base);
  }
});
test("handleReopenTask: rejects reopening a task that is not complete", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedCompleteTask();
    const result = await handleReopenTask({ milestoneId: "M001", sliceId: "S01", taskId: "T02" }, base);
    assert.ok("error" in result);
    assert.match(result.error, /not complete/);
  } finally {
    cleanup(base);
  }
});
test("handleReopenTask: rejects non-existent task", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    insertMilestone({ id: "M001", title: "Active", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", status: "in_progress" });
    const result = await handleReopenTask({ milestoneId: "M001", sliceId: "S01", taskId: "T99" }, base);
    assert.ok("error" in result);
    assert.match(result.error, /task not found/);
  } finally {
    cleanup(base);
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9yZW9wZW4tdGFzay50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBHU0QgXHUyMDE0IHJlb3Blbi10YXNrIGhhbmRsZXIgdGVzdHNcbi8vIENvcHlyaWdodCAoYykgMjAyNiBKZXJlbXkgTWNTcGFkZGVuIDxqZXJlbXlAZmx1eGxhYnMubmV0PlxuXG5pbXBvcnQgdGVzdCBmcm9tICdub2RlOnRlc3QnO1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgcm1TeW5jIH0gZnJvbSAnbm9kZTpmcyc7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJztcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gJ25vZGU6b3MnO1xuXG5pbXBvcnQge1xuICBvcGVuRGF0YWJhc2UsXG4gIGNsb3NlRGF0YWJhc2UsXG4gIGluc2VydE1pbGVzdG9uZSxcbiAgaW5zZXJ0U2xpY2UsXG4gIGluc2VydFRhc2ssXG4gIGdldFRhc2ssXG59IGZyb20gJy4uL2dzZC1kYi50cyc7XG5pbXBvcnQgeyBoYW5kbGVSZW9wZW5UYXNrIH0gZnJvbSAnLi4vdG9vbHMvcmVvcGVuLXRhc2sudHMnO1xuXG5mdW5jdGlvbiBtYWtlVG1wQmFzZSgpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgJ2dzZC1yZW9wZW4tdGFzay0nKSk7XG4gIG1rZGlyU3luYyhqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScsICdzbGljZXMnLCAnUzAxJywgJ3Rhc2tzJyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICByZXR1cm4gYmFzZTtcbn1cblxuZnVuY3Rpb24gY2xlYW51cChiYXNlOiBzdHJpbmcpOiB2b2lkIHtcbiAgdHJ5IHsgY2xvc2VEYXRhYmFzZSgpOyB9IGNhdGNoIHsgLyogbm9vcCAqLyB9XG4gIHRyeSB7IHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0gY2F0Y2ggeyAvKiBub29wICovIH1cbn1cblxuZnVuY3Rpb24gc2VlZENvbXBsZXRlVGFzaygpOiB2b2lkIHtcbiAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdUZXN0IE1pbGVzdG9uZScsIHN0YXR1czogJ2FjdGl2ZScgfSk7XG4gIGluc2VydFNsaWNlKHsgaWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ1Rlc3QgU2xpY2UnLCBzdGF0dXM6ICdpbl9wcm9ncmVzcycgfSk7XG4gIGluc2VydFRhc2soeyBpZDogJ1QwMScsIHNsaWNlSWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ1Rhc2sgT25lJywgc3RhdHVzOiAnY29tcGxldGUnIH0pO1xuICBpbnNlcnRUYXNrKHsgaWQ6ICdUMDInLCBzbGljZUlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdUYXNrIFR3bycsIHN0YXR1czogJ3BlbmRpbmcnIH0pO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU3VjY2VzcyBwYXRoIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KCdoYW5kbGVSZW9wZW5UYXNrOiByZXNldHMgYSBjb21wbGV0ZSB0YXNrIHRvIHBlbmRpbmcnLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCAnLmdzZCcsICdnc2QuZGInKSk7XG4gIHRyeSB7XG4gICAgc2VlZENvbXBsZXRlVGFzaygpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlUmVvcGVuVGFzayh7XG4gICAgICBtaWxlc3RvbmVJZDogJ00wMDEnLFxuICAgICAgc2xpY2VJZDogJ1MwMScsXG4gICAgICB0YXNrSWQ6ICdUMDEnLFxuICAgICAgcmVhc29uOiAndmVyaWZpY2F0aW9uIGZhaWxlZCBhZnRlciBtZXJnZScsXG4gICAgfSwgYmFzZSk7XG5cbiAgICBhc3NlcnQub2soISgnZXJyb3InIGluIHJlc3VsdCksIGB1bmV4cGVjdGVkIGVycm9yOiAkeydlcnJvcicgaW4gcmVzdWx0ID8gcmVzdWx0LmVycm9yIDogJyd9YCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC50YXNrSWQsICdUMDEnKTtcblxuICAgIGNvbnN0IHRhc2sgPSBnZXRUYXNrKCdNMDAxJywgJ1MwMScsICdUMDEnKTtcbiAgICBhc3NlcnQub2sodGFzaywgJ3Rhc2sgc2hvdWxkIHN0aWxsIGV4aXN0Jyk7XG4gICAgYXNzZXJ0LmVxdWFsKHRhc2shLnN0YXR1cywgJ3BlbmRpbmcnLCAndGFzayBzdGF0dXMgc2hvdWxkIGJlIHJlc2V0IHRvIHBlbmRpbmcnKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdCgnaGFuZGxlUmVvcGVuVGFzazogZG9lcyBub3QgYWZmZWN0IG90aGVyIHRhc2tzIGluIHRoZSBzbGljZScsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsICcuZ3NkJywgJ2dzZC5kYicpKTtcbiAgdHJ5IHtcbiAgICBzZWVkQ29tcGxldGVUYXNrKCk7XG5cbiAgICBhd2FpdCBoYW5kbGVSZW9wZW5UYXNrKHsgbWlsZXN0b25lSWQ6ICdNMDAxJywgc2xpY2VJZDogJ1MwMScsIHRhc2tJZDogJ1QwMScgfSwgYmFzZSk7XG5cbiAgICBjb25zdCB0MDIgPSBnZXRUYXNrKCdNMDAxJywgJ1MwMScsICdUMDInKTtcbiAgICBhc3NlcnQub2sodDAyLCAnVDAyIHNob3VsZCBzdGlsbCBleGlzdCcpO1xuICAgIGFzc2VydC5lcXVhbCh0MDIhLnN0YXR1cywgJ3BlbmRpbmcnLCAnVDAyIHN0YXR1cyBzaG91bGQgYmUgdW5jaGFuZ2VkJyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBGYWlsdXJlIHBhdGhzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KCdoYW5kbGVSZW9wZW5UYXNrOiByZWplY3RzIGVtcHR5IHRhc2tJZCcsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsICcuZ3NkJywgJ2dzZC5kYicpKTtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVSZW9wZW5UYXNrKHsgbWlsZXN0b25lSWQ6ICdNMDAxJywgc2xpY2VJZDogJ1MwMScsIHRhc2tJZDogJycgfSwgYmFzZSk7XG4gICAgYXNzZXJ0Lm9rKCdlcnJvcicgaW4gcmVzdWx0KTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LmVycm9yLCAvdGFza0lkLyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoJ2hhbmRsZVJlb3BlblRhc2s6IHJlamVjdHMgbm9uLWV4aXN0ZW50IG1pbGVzdG9uZScsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsICcuZ3NkJywgJ2dzZC5kYicpKTtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVSZW9wZW5UYXNrKHsgbWlsZXN0b25lSWQ6ICdNOTk5Jywgc2xpY2VJZDogJ1MwMScsIHRhc2tJZDogJ1QwMScgfSwgYmFzZSk7XG4gICAgYXNzZXJ0Lm9rKCdlcnJvcicgaW4gcmVzdWx0KTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LmVycm9yLCAvbWlsZXN0b25lIG5vdCBmb3VuZC8pO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KCdoYW5kbGVSZW9wZW5UYXNrOiByZWplY3RzIHRhc2sgaW4gYSBjbG9zZWQgbWlsZXN0b25lJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgJy5nc2QnLCAnZ3NkLmRiJykpO1xuICB0cnkge1xuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiAnTTAwMScsIHRpdGxlOiAnRG9uZScsIHN0YXR1czogJ2NvbXBsZXRlJyB9KTtcbiAgICBpbnNlcnRTbGljZSh7IGlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgc3RhdHVzOiAnY29tcGxldGUnIH0pO1xuICAgIGluc2VydFRhc2soeyBpZDogJ1QwMScsIHNsaWNlSWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCBzdGF0dXM6ICdjb21wbGV0ZScgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVSZW9wZW5UYXNrKHsgbWlsZXN0b25lSWQ6ICdNMDAxJywgc2xpY2VJZDogJ1MwMScsIHRhc2tJZDogJ1QwMScgfSwgYmFzZSk7XG4gICAgYXNzZXJ0Lm9rKCdlcnJvcicgaW4gcmVzdWx0KTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LmVycm9yLCAvY2xvc2VkIG1pbGVzdG9uZS8pO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KCdoYW5kbGVSZW9wZW5UYXNrOiByZWplY3RzIHRhc2sgaW5zaWRlIGEgY2xvc2VkIHNsaWNlJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgJy5nc2QnLCAnZ3NkLmRiJykpO1xuICB0cnkge1xuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiAnTTAwMScsIHRpdGxlOiAnQWN0aXZlJywgc3RhdHVzOiAnYWN0aXZlJyB9KTtcbiAgICBpbnNlcnRTbGljZSh7IGlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgc3RhdHVzOiAnY29tcGxldGUnIH0pO1xuICAgIGluc2VydFRhc2soeyBpZDogJ1QwMScsIHNsaWNlSWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCBzdGF0dXM6ICdjb21wbGV0ZScgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVSZW9wZW5UYXNrKHsgbWlsZXN0b25lSWQ6ICdNMDAxJywgc2xpY2VJZDogJ1MwMScsIHRhc2tJZDogJ1QwMScgfSwgYmFzZSk7XG4gICAgYXNzZXJ0Lm9rKCdlcnJvcicgaW4gcmVzdWx0KTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LmVycm9yLCAvY2xvc2VkIHNsaWNlLyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoJ2hhbmRsZVJlb3BlblRhc2s6IHJlamVjdHMgcmVvcGVuaW5nIGEgdGFzayB0aGF0IGlzIG5vdCBjb21wbGV0ZScsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsICcuZ3NkJywgJ2dzZC5kYicpKTtcbiAgdHJ5IHtcbiAgICBzZWVkQ29tcGxldGVUYXNrKCk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVSZW9wZW5UYXNrKHsgbWlsZXN0b25lSWQ6ICdNMDAxJywgc2xpY2VJZDogJ1MwMScsIHRhc2tJZDogJ1QwMicgfSwgYmFzZSk7XG4gICAgYXNzZXJ0Lm9rKCdlcnJvcicgaW4gcmVzdWx0KTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LmVycm9yLCAvbm90IGNvbXBsZXRlLyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoJ2hhbmRsZVJlb3BlblRhc2s6IHJlamVjdHMgbm9uLWV4aXN0ZW50IHRhc2snLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCAnLmdzZCcsICdnc2QuZGInKSk7XG4gIHRyeSB7XG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdBY3RpdmUnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuICAgIGluc2VydFNsaWNlKHsgaWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCBzdGF0dXM6ICdpbl9wcm9ncmVzcycgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVSZW9wZW5UYXNrKHsgbWlsZXN0b25lSWQ6ICdNMDAxJywgc2xpY2VJZDogJ1MwMScsIHRhc2tJZDogJ1Q5OScgfSwgYmFzZSk7XG4gICAgYXNzZXJ0Lm9rKCdlcnJvcicgaW4gcmVzdWx0KTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LmVycm9yLCAvdGFzayBub3QgZm91bmQvKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUdBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhLFdBQVcsY0FBYztBQUMvQyxTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBRXZCO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUNQLFNBQVMsd0JBQXdCO0FBRWpDLFNBQVMsY0FBc0I7QUFDN0IsUUFBTSxPQUFPLFlBQVksS0FBSyxPQUFPLEdBQUcsa0JBQWtCLENBQUM7QUFDM0QsWUFBVSxLQUFLLE1BQU0sUUFBUSxjQUFjLFFBQVEsVUFBVSxPQUFPLE9BQU8sR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ2pHLFNBQU87QUFDVDtBQUVBLFNBQVMsUUFBUSxNQUFvQjtBQUNuQyxNQUFJO0FBQUUsa0JBQWM7QUFBQSxFQUFHLFFBQVE7QUFBQSxFQUFhO0FBQzVDLE1BQUk7QUFBRSxXQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUFHLFFBQVE7QUFBQSxFQUFhO0FBQzdFO0FBRUEsU0FBUyxtQkFBeUI7QUFDaEMsa0JBQWdCLEVBQUUsSUFBSSxRQUFRLE9BQU8sa0JBQWtCLFFBQVEsU0FBUyxDQUFDO0FBQ3pFLGNBQVksRUFBRSxJQUFJLE9BQU8sYUFBYSxRQUFRLE9BQU8sY0FBYyxRQUFRLGNBQWMsQ0FBQztBQUMxRixhQUFXLEVBQUUsSUFBSSxPQUFPLFNBQVMsT0FBTyxhQUFhLFFBQVEsT0FBTyxZ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
