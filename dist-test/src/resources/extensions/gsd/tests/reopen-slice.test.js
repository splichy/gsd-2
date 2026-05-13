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
  getSlice,
  getSliceTasks
} from "../gsd-db.js";
import { handleReopenSlice } from "../tools/reopen-slice.js";
function makeTmpBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-reopen-slice-"));
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
function seedCompleteSlice() {
  insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Test Slice", status: "complete" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task One", status: "complete" });
  insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Task Two", status: "complete" });
}
test("handleReopenSlice: resets a complete slice to in_progress and all tasks to pending", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    seedCompleteSlice();
    const result = await handleReopenSlice({
      milestoneId: "M001",
      sliceId: "S01",
      reason: "need to redo after requirements change"
    }, base);
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    assert.equal(result.sliceId, "S01");
    assert.equal(result.tasksReset, 2, "should report 2 tasks reset");
    const slice = getSlice("M001", "S01");
    assert.ok(slice, "slice should still exist");
    assert.equal(slice.status, "in_progress", "slice status should be in_progress");
    const tasks = getSliceTasks("M001", "S01");
    assert.equal(tasks.length, 2, "both tasks should still exist");
    assert.ok(tasks.every((t) => t.status === "pending"), "all tasks should be pending");
  } finally {
    cleanup(base);
  }
});
test("handleReopenSlice: works with a single task", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete" });
    const result = await handleReopenSlice({ milestoneId: "M001", sliceId: "S01" }, base);
    assert.ok(!("error" in result));
    assert.equal(result.tasksReset, 1);
  } finally {
    cleanup(base);
  }
});
test("handleReopenSlice: rejects empty sliceId", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    const result = await handleReopenSlice({ milestoneId: "M001", sliceId: "" }, base);
    assert.ok("error" in result);
    assert.match(result.error, /sliceId/);
  } finally {
    cleanup(base);
  }
});
test("handleReopenSlice: rejects non-existent milestone", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    const result = await handleReopenSlice({ milestoneId: "M999", sliceId: "S01" }, base);
    assert.ok("error" in result);
    assert.match(result.error, /milestone not found/);
  } finally {
    cleanup(base);
  }
});
test("handleReopenSlice: rejects slice in a closed milestone", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    insertMilestone({ id: "M001", title: "Done", status: "complete" });
    insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete" });
    const result = await handleReopenSlice({ milestoneId: "M001", sliceId: "S01" }, base);
    assert.ok("error" in result);
    assert.match(result.error, /closed milestone/);
  } finally {
    cleanup(base);
  }
});
test("handleReopenSlice: rejects reopening a slice that is not complete", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    insertMilestone({ id: "M001", title: "Active", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", status: "in_progress" });
    const result = await handleReopenSlice({ milestoneId: "M001", sliceId: "S01" }, base);
    assert.ok("error" in result);
    assert.match(result.error, /not complete/);
  } finally {
    cleanup(base);
  }
});
test("handleReopenSlice: rejects non-existent slice", async () => {
  const base = makeTmpBase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  try {
    insertMilestone({ id: "M001", title: "Active", status: "active" });
    const result = await handleReopenSlice({ milestoneId: "M001", sliceId: "S99" }, base);
    assert.ok("error" in result);
    assert.match(result.error, /slice not found/);
  } finally {
    cleanup(base);
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9yZW9wZW4tc2xpY2UudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NEIFx1MjAxNCByZW9wZW4tc2xpY2UgaGFuZGxlciB0ZXN0c1xuLy8gQ29weXJpZ2h0IChjKSAyMDI2IEplcmVteSBNY1NwYWRkZW4gPGplcmVteUBmbHV4bGFicy5uZXQ+XG5cbmltcG9ydCB0ZXN0IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCBybVN5bmMgfSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdub2RlOnBhdGgnO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSAnbm9kZTpvcyc7XG5cbmltcG9ydCB7XG4gIG9wZW5EYXRhYmFzZSxcbiAgY2xvc2VEYXRhYmFzZSxcbiAgaW5zZXJ0TWlsZXN0b25lLFxuICBpbnNlcnRTbGljZSxcbiAgaW5zZXJ0VGFzayxcbiAgZ2V0U2xpY2UsXG4gIGdldFNsaWNlVGFza3MsXG59IGZyb20gJy4uL2dzZC1kYi50cyc7XG5pbXBvcnQgeyBoYW5kbGVSZW9wZW5TbGljZSB9IGZyb20gJy4uL3Rvb2xzL3Jlb3Blbi1zbGljZS50cyc7XG5cbmZ1bmN0aW9uIG1ha2VUbXBCYXNlKCk6IHN0cmluZyB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCAnZ3NkLXJlb3Blbi1zbGljZS0nKSk7XG4gIG1rZGlyU3luYyhqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScsICdzbGljZXMnLCAnUzAxJywgJ3Rhc2tzJyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICByZXR1cm4gYmFzZTtcbn1cblxuZnVuY3Rpb24gY2xlYW51cChiYXNlOiBzdHJpbmcpOiB2b2lkIHtcbiAgdHJ5IHsgY2xvc2VEYXRhYmFzZSgpOyB9IGNhdGNoIHsgLyogbm9vcCAqLyB9XG4gIHRyeSB7IHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0gY2F0Y2ggeyAvKiBub29wICovIH1cbn1cblxuZnVuY3Rpb24gc2VlZENvbXBsZXRlU2xpY2UoKTogdm9pZCB7XG4gIGluc2VydE1pbGVzdG9uZSh7IGlkOiAnTTAwMScsIHRpdGxlOiAnVGVzdCBNaWxlc3RvbmUnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuICBpbnNlcnRTbGljZSh7IGlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdUZXN0IFNsaWNlJywgc3RhdHVzOiAnY29tcGxldGUnIH0pO1xuICBpbnNlcnRUYXNrKHsgaWQ6ICdUMDEnLCBzbGljZUlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdUYXNrIE9uZScsIHN0YXR1czogJ2NvbXBsZXRlJyB9KTtcbiAgaW5zZXJ0VGFzayh7IGlkOiAnVDAyJywgc2xpY2VJZDogJ1MwMScsIG1pbGVzdG9uZUlkOiAnTTAwMScsIHRpdGxlOiAnVGFzayBUd28nLCBzdGF0dXM6ICdjb21wbGV0ZScgfSk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTdWNjZXNzIHBhdGggXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoJ2hhbmRsZVJlb3BlblNsaWNlOiByZXNldHMgYSBjb21wbGV0ZSBzbGljZSB0byBpbl9wcm9ncmVzcyBhbmQgYWxsIHRhc2tzIHRvIHBlbmRpbmcnLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCAnLmdzZCcsICdnc2QuZGInKSk7XG4gIHRyeSB7XG4gICAgc2VlZENvbXBsZXRlU2xpY2UoKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZVJlb3BlblNsaWNlKHtcbiAgICAgIG1pbGVzdG9uZUlkOiAnTTAwMScsXG4gICAgICBzbGljZUlkOiAnUzAxJyxcbiAgICAgIHJlYXNvbjogJ25lZWQgdG8gcmVkbyBhZnRlciByZXF1aXJlbWVudHMgY2hhbmdlJyxcbiAgICB9LCBiYXNlKTtcblxuICAgIGFzc2VydC5vayghKCdlcnJvcicgaW4gcmVzdWx0KSwgYHVuZXhwZWN0ZWQgZXJyb3I6ICR7J2Vycm9yJyBpbiByZXN1bHQgPyByZXN1bHQuZXJyb3IgOiAnJ31gKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnNsaWNlSWQsICdTMDEnKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnRhc2tzUmVzZXQsIDIsICdzaG91bGQgcmVwb3J0IDIgdGFza3MgcmVzZXQnKTtcblxuICAgIGNvbnN0IHNsaWNlID0gZ2V0U2xpY2UoJ00wMDEnLCAnUzAxJyk7XG4gICAgYXNzZXJ0Lm9rKHNsaWNlLCAnc2xpY2Ugc2hvdWxkIHN0aWxsIGV4aXN0Jyk7XG4gICAgYXNzZXJ0LmVxdWFsKHNsaWNlIS5zdGF0dXMsICdpbl9wcm9ncmVzcycsICdzbGljZSBzdGF0dXMgc2hvdWxkIGJlIGluX3Byb2dyZXNzJyk7XG5cbiAgICBjb25zdCB0YXNrcyA9IGdldFNsaWNlVGFza3MoJ00wMDEnLCAnUzAxJyk7XG4gICAgYXNzZXJ0LmVxdWFsKHRhc2tzLmxlbmd0aCwgMiwgJ2JvdGggdGFza3Mgc2hvdWxkIHN0aWxsIGV4aXN0Jyk7XG4gICAgYXNzZXJ0Lm9rKHRhc2tzLmV2ZXJ5KHQgPT4gdC5zdGF0dXMgPT09ICdwZW5kaW5nJyksICdhbGwgdGFza3Mgc2hvdWxkIGJlIHBlbmRpbmcnKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdCgnaGFuZGxlUmVvcGVuU2xpY2U6IHdvcmtzIHdpdGggYSBzaW5nbGUgdGFzaycsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsICcuZ3NkJywgJ2dzZC5kYicpKTtcbiAgdHJ5IHtcbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogJ00wMDEnLCB0aXRsZTogJ1Rlc3QnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuICAgIGluc2VydFNsaWNlKHsgaWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCBzdGF0dXM6ICdjb21wbGV0ZScgfSk7XG4gICAgaW5zZXJ0VGFzayh7IGlkOiAnVDAxJywgc2xpY2VJZDogJ1MwMScsIG1pbGVzdG9uZUlkOiAnTTAwMScsIHN0YXR1czogJ2NvbXBsZXRlJyB9KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZVJlb3BlblNsaWNlKHsgbWlsZXN0b25lSWQ6ICdNMDAxJywgc2xpY2VJZDogJ1MwMScgfSwgYmFzZSk7XG5cbiAgICBhc3NlcnQub2soISgnZXJyb3InIGluIHJlc3VsdCkpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQudGFza3NSZXNldCwgMSk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBGYWlsdXJlIHBhdGhzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KCdoYW5kbGVSZW9wZW5TbGljZTogcmVqZWN0cyBlbXB0eSBzbGljZUlkJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgJy5nc2QnLCAnZ3NkLmRiJykpO1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZVJlb3BlblNsaWNlKHsgbWlsZXN0b25lSWQ6ICdNMDAxJywgc2xpY2VJZDogJycgfSwgYmFzZSk7XG4gICAgYXNzZXJ0Lm9rKCdlcnJvcicgaW4gcmVzdWx0KTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LmVycm9yLCAvc2xpY2VJZC8pO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KCdoYW5kbGVSZW9wZW5TbGljZTogcmVqZWN0cyBub24tZXhpc3RlbnQgbWlsZXN0b25lJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgJy5nc2QnLCAnZ3NkLmRiJykpO1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZVJlb3BlblNsaWNlKHsgbWlsZXN0b25lSWQ6ICdNOTk5Jywgc2xpY2VJZDogJ1MwMScgfSwgYmFzZSk7XG4gICAgYXNzZXJ0Lm9rKCdlcnJvcicgaW4gcmVzdWx0KTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LmVycm9yLCAvbWlsZXN0b25lIG5vdCBmb3VuZC8pO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KCdoYW5kbGVSZW9wZW5TbGljZTogcmVqZWN0cyBzbGljZSBpbiBhIGNsb3NlZCBtaWxlc3RvbmUnLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCAnLmdzZCcsICdnc2QuZGInKSk7XG4gIHRyeSB7XG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdEb25lJywgc3RhdHVzOiAnY29tcGxldGUnIH0pO1xuICAgIGluc2VydFNsaWNlKHsgaWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCBzdGF0dXM6ICdjb21wbGV0ZScgfSk7XG4gICAgaW5zZXJ0VGFzayh7IGlkOiAnVDAxJywgc2xpY2VJZDogJ1MwMScsIG1pbGVzdG9uZUlkOiAnTTAwMScsIHN0YXR1czogJ2NvbXBsZXRlJyB9KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZVJlb3BlblNsaWNlKHsgbWlsZXN0b25lSWQ6ICdNMDAxJywgc2xpY2VJZDogJ1MwMScgfSwgYmFzZSk7XG4gICAgYXNzZXJ0Lm9rKCdlcnJvcicgaW4gcmVzdWx0KTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LmVycm9yLCAvY2xvc2VkIG1pbGVzdG9uZS8pO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KCdoYW5kbGVSZW9wZW5TbGljZTogcmVqZWN0cyByZW9wZW5pbmcgYSBzbGljZSB0aGF0IGlzIG5vdCBjb21wbGV0ZScsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsICcuZ3NkJywgJ2dzZC5kYicpKTtcbiAgdHJ5IHtcbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogJ00wMDEnLCB0aXRsZTogJ0FjdGl2ZScsIHN0YXR1czogJ2FjdGl2ZScgfSk7XG4gICAgaW5zZXJ0U2xpY2UoeyBpZDogJ1MwMScsIG1pbGVzdG9uZUlkOiAnTTAwMScsIHN0YXR1czogJ2luX3Byb2dyZXNzJyB9KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZVJlb3BlblNsaWNlKHsgbWlsZXN0b25lSWQ6ICdNMDAxJywgc2xpY2VJZDogJ1MwMScgfSwgYmFzZSk7XG4gICAgYXNzZXJ0Lm9rKCdlcnJvcicgaW4gcmVzdWx0KTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LmVycm9yLCAvbm90IGNvbXBsZXRlLyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoJ2hhbmRsZVJlb3BlblNsaWNlOiByZWplY3RzIG5vbi1leGlzdGVudCBzbGljZScsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsICcuZ3NkJywgJ2dzZC5kYicpKTtcbiAgdHJ5IHtcbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogJ00wMDEnLCB0aXRsZTogJ0FjdGl2ZScsIHN0YXR1czogJ2FjdGl2ZScgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVSZW9wZW5TbGljZSh7IG1pbGVzdG9uZUlkOiAnTTAwMScsIHNsaWNlSWQ6ICdTOTknIH0sIGJhc2UpO1xuICAgIGFzc2VydC5vaygnZXJyb3InIGluIHJlc3VsdCk7XG4gICAgYXNzZXJ0Lm1hdGNoKHJlc3VsdC5lcnJvciwgL3NsaWNlIG5vdCBmb3VuZC8pO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBR0Es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
