import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parkMilestone, unparkMilestone } from "../milestone-actions.js";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  getMilestone
} from "../gsd-db.js";
function createBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-park-db-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "M001-CONTEXT.md"),
    "# M001\n\nContext."
  );
  return base;
}
test("parkMilestone updates DB status to 'parked' (#2694)", () => {
  const base = createBase();
  try {
    openDatabase(":memory:");
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    assert.equal(getMilestone("M001").status, "active", "starts active");
    parkMilestone(base, "M001", "deprioritized");
    assert.equal(getMilestone("M001").status, "parked", "DB status should be parked");
    closeDatabase();
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
test("parkMilestone ignores blocked SUMMARY.md when DB milestone is active (#5828)", () => {
  const base = createBase();
  try {
    openDatabase(":memory:");
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md"),
      [
        "---",
        "status: closeout_blocked",
        "---",
        "",
        "# M001 Summary",
        "",
        "Completion was not persisted."
      ].join("\n"),
      "utf-8"
    );
    const parked = parkMilestone(base, "M001", "test");
    assert.ok(parked, "active DB row should allow parking despite a blocked SUMMARY.md");
    assert.ok(
      existsSync(join(base, ".gsd", "milestones", "M001", "M001-PARKED.md")),
      "PARKED.md should be written"
    );
    assert.equal(getMilestone("M001").status, "parked", "DB status should be parked");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
test("parkMilestone refuses DB-complete milestones (#5828)", () => {
  const base = createBase();
  try {
    openDatabase(":memory:");
    insertMilestone({ id: "M001", title: "Test", status: "complete" });
    const parked = parkMilestone(base, "M001", "test");
    assert.equal(parked, false, "complete DB row should not be parkable");
    assert.equal(
      existsSync(join(base, ".gsd", "milestones", "M001", "M001-PARKED.md")),
      false,
      "PARKED.md should not be written"
    );
    assert.equal(getMilestone("M001").status, "complete", "DB status should remain complete");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
test("unparkMilestone updates DB status to 'active' (#2694)", () => {
  const base = createBase();
  try {
    openDatabase(":memory:");
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    parkMilestone(base, "M001", "deprioritized");
    assert.equal(getMilestone("M001").status, "parked");
    unparkMilestone(base, "M001");
    assert.equal(getMilestone("M001").status, "active", "DB status should be active after unpark");
    closeDatabase();
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
test("unparkMilestone repairs parked DB state when PARKED.md is missing (#3707)", () => {
  const base = createBase();
  try {
    openDatabase(":memory:");
    insertMilestone({ id: "M001", title: "Test", status: "parked" });
    const unparked = unparkMilestone(base, "M001");
    assert.ok(unparked, "unparkMilestone should recover DB-only parked state");
    assert.equal(getMilestone("M001").status, "active", "DB status should be repaired to active");
    closeDatabase();
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
test("park/unpark are safe when DB is not available (#2694 guard)", () => {
  const base = createBase();
  try {
    const parked = parkMilestone(base, "M001", "test");
    assert.ok(parked, "parkMilestone succeeds without DB");
    const unparked = unparkMilestone(base, "M001");
    assert.ok(unparked, "unparkMilestone succeeds without DB");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wYXJrLWRiLXN5bmMudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBSZWdyZXNzaW9uIHRlc3QgZm9yICMyNjk0OiBwYXJrTWlsZXN0b25lIGFuZCB1bnBhcmtNaWxlc3RvbmUgbXVzdFxuICogdXBkYXRlIHRoZSBEQiBtaWxlc3RvbmUgc3RhdHVzIGFsb25nc2lkZSB0aGUgZmlsZXN5c3RlbSBtYXJrZXIuXG4gKlxuICogV2l0aG91dCB0aGlzLCBkZXJpdmVTdGF0ZUZyb21EYiBza2lwcyB1bnBhcmtlZCBtaWxlc3RvbmVzIGJlY2F1c2VcbiAqIHRoZSBEQiBzdGlsbCBoYXMgc3RhdHVzPSdwYXJrZWQnLCBjYXVzaW5nIFwiQWxsIG1pbGVzdG9uZXMgY29tcGxldGVcIi5cbiAqL1xuaW1wb3J0IHsgdGVzdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgZXhpc3RzU3luYywgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgd3JpdGVGaWxlU3luYywgcm1TeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuXG5pbXBvcnQgeyBwYXJrTWlsZXN0b25lLCB1bnBhcmtNaWxlc3RvbmUgfSBmcm9tIFwiLi4vbWlsZXN0b25lLWFjdGlvbnMudHNcIjtcbmltcG9ydCB7XG4gIG9wZW5EYXRhYmFzZSxcbiAgY2xvc2VEYXRhYmFzZSxcbiAgaW5zZXJ0TWlsZXN0b25lLFxuICBnZXRNaWxlc3RvbmUsXG59IGZyb20gXCIuLi9nc2QtZGIudHNcIjtcblxuZnVuY3Rpb24gY3JlYXRlQmFzZSgpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtcGFyay1kYi1cIikpO1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcIk0wMDEtQ09OVEVYVC5tZFwiKSxcbiAgICBcIiMgTTAwMVxcblxcbkNvbnRleHQuXCIsXG4gICk7XG4gIHJldHVybiBiYXNlO1xufVxuXG50ZXN0KFwicGFya01pbGVzdG9uZSB1cGRhdGVzIERCIHN0YXR1cyB0byAncGFya2VkJyAoIzI2OTQpXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IGNyZWF0ZUJhc2UoKTtcbiAgdHJ5IHtcbiAgICBvcGVuRGF0YWJhc2UoXCI6bWVtb3J5OlwiKTtcbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKGdldE1pbGVzdG9uZShcIk0wMDFcIikhLnN0YXR1cywgXCJhY3RpdmVcIiwgXCJzdGFydHMgYWN0aXZlXCIpO1xuXG4gICAgcGFya01pbGVzdG9uZShiYXNlLCBcIk0wMDFcIiwgXCJkZXByaW9yaXRpemVkXCIpO1xuXG4gICAgYXNzZXJ0LmVxdWFsKGdldE1pbGVzdG9uZShcIk0wMDFcIikhLnN0YXR1cywgXCJwYXJrZWRcIiwgXCJEQiBzdGF0dXMgc2hvdWxkIGJlIHBhcmtlZFwiKTtcblxuICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJwYXJrTWlsZXN0b25lIGlnbm9yZXMgYmxvY2tlZCBTVU1NQVJZLm1kIHdoZW4gREIgbWlsZXN0b25lIGlzIGFjdGl2ZSAoIzU4MjgpXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IGNyZWF0ZUJhc2UoKTtcbiAgdHJ5IHtcbiAgICBvcGVuRGF0YWJhc2UoXCI6bWVtb3J5OlwiKTtcbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwiTTAwMS1TVU1NQVJZLm1kXCIpLFxuICAgICAgW1xuICAgICAgICBcIi0tLVwiLFxuICAgICAgICBcInN0YXR1czogY2xvc2VvdXRfYmxvY2tlZFwiLFxuICAgICAgICBcIi0tLVwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIiMgTTAwMSBTdW1tYXJ5XCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiQ29tcGxldGlvbiB3YXMgbm90IHBlcnNpc3RlZC5cIixcbiAgICAgIF0uam9pbihcIlxcblwiKSxcbiAgICAgIFwidXRmLThcIixcbiAgICApO1xuXG4gICAgY29uc3QgcGFya2VkID0gcGFya01pbGVzdG9uZShiYXNlLCBcIk0wMDFcIiwgXCJ0ZXN0XCIpO1xuXG4gICAgYXNzZXJ0Lm9rKHBhcmtlZCwgXCJhY3RpdmUgREIgcm93IHNob3VsZCBhbGxvdyBwYXJraW5nIGRlc3BpdGUgYSBibG9ja2VkIFNVTU1BUlkubWRcIik7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgZXhpc3RzU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwiTTAwMS1QQVJLRUQubWRcIikpLFxuICAgICAgXCJQQVJLRUQubWQgc2hvdWxkIGJlIHdyaXR0ZW5cIixcbiAgICApO1xuICAgIGFzc2VydC5lcXVhbChnZXRNaWxlc3RvbmUoXCJNMDAxXCIpIS5zdGF0dXMsIFwicGFya2VkXCIsIFwiREIgc3RhdHVzIHNob3VsZCBiZSBwYXJrZWRcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwicGFya01pbGVzdG9uZSByZWZ1c2VzIERCLWNvbXBsZXRlIG1pbGVzdG9uZXMgKCM1ODI4KVwiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBjcmVhdGVCYXNlKCk7XG4gIHRyeSB7XG4gICAgb3BlbkRhdGFiYXNlKFwiOm1lbW9yeTpcIik7XG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIsIHN0YXR1czogXCJjb21wbGV0ZVwiIH0pO1xuXG4gICAgY29uc3QgcGFya2VkID0gcGFya01pbGVzdG9uZShiYXNlLCBcIk0wMDFcIiwgXCJ0ZXN0XCIpO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHBhcmtlZCwgZmFsc2UsIFwiY29tcGxldGUgREIgcm93IHNob3VsZCBub3QgYmUgcGFya2FibGVcIik7XG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgZXhpc3RzU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwiTTAwMS1QQVJLRUQubWRcIikpLFxuICAgICAgZmFsc2UsXG4gICAgICBcIlBBUktFRC5tZCBzaG91bGQgbm90IGJlIHdyaXR0ZW5cIixcbiAgICApO1xuICAgIGFzc2VydC5lcXVhbChnZXRNaWxlc3RvbmUoXCJNMDAxXCIpIS5zdGF0dXMsIFwiY29tcGxldGVcIiwgXCJEQiBzdGF0dXMgc2hvdWxkIHJlbWFpbiBjb21wbGV0ZVwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJ1bnBhcmtNaWxlc3RvbmUgdXBkYXRlcyBEQiBzdGF0dXMgdG8gJ2FjdGl2ZScgKCMyNjk0KVwiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBjcmVhdGVCYXNlKCk7XG4gIHRyeSB7XG4gICAgb3BlbkRhdGFiYXNlKFwiOm1lbW9yeTpcIik7XG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIsIHN0YXR1czogXCJhY3RpdmVcIiB9KTtcblxuICAgIC8vIFBhcmsgZmlyc3RcbiAgICBwYXJrTWlsZXN0b25lKGJhc2UsIFwiTTAwMVwiLCBcImRlcHJpb3JpdGl6ZWRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGdldE1pbGVzdG9uZShcIk0wMDFcIikhLnN0YXR1cywgXCJwYXJrZWRcIik7XG5cbiAgICAvLyBVbnBhcmtcbiAgICB1bnBhcmtNaWxlc3RvbmUoYmFzZSwgXCJNMDAxXCIpO1xuICAgIGFzc2VydC5lcXVhbChnZXRNaWxlc3RvbmUoXCJNMDAxXCIpIS5zdGF0dXMsIFwiYWN0aXZlXCIsIFwiREIgc3RhdHVzIHNob3VsZCBiZSBhY3RpdmUgYWZ0ZXIgdW5wYXJrXCIpO1xuXG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcInVucGFya01pbGVzdG9uZSByZXBhaXJzIHBhcmtlZCBEQiBzdGF0ZSB3aGVuIFBBUktFRC5tZCBpcyBtaXNzaW5nICgjMzcwNylcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gY3JlYXRlQmFzZSgpO1xuICB0cnkge1xuICAgIG9wZW5EYXRhYmFzZShcIjptZW1vcnk6XCIpO1xuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdFwiLCBzdGF0dXM6IFwicGFya2VkXCIgfSk7XG5cbiAgICBjb25zdCB1bnBhcmtlZCA9IHVucGFya01pbGVzdG9uZShiYXNlLCBcIk0wMDFcIik7XG5cbiAgICBhc3NlcnQub2sodW5wYXJrZWQsIFwidW5wYXJrTWlsZXN0b25lIHNob3VsZCByZWNvdmVyIERCLW9ubHkgcGFya2VkIHN0YXRlXCIpO1xuICAgIGFzc2VydC5lcXVhbChnZXRNaWxlc3RvbmUoXCJNMDAxXCIpIS5zdGF0dXMsIFwiYWN0aXZlXCIsIFwiREIgc3RhdHVzIHNob3VsZCBiZSByZXBhaXJlZCB0byBhY3RpdmVcIik7XG5cbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwicGFyay91bnBhcmsgYXJlIHNhZmUgd2hlbiBEQiBpcyBub3QgYXZhaWxhYmxlICgjMjY5NCBndWFyZClcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gY3JlYXRlQmFzZSgpO1xuICB0cnkge1xuICAgIC8vIE5vIG9wZW5EYXRhYmFzZSBcdTIwMTQgREIgbm90IGF2YWlsYWJsZVxuICAgIC8vIHBhcmsvdW5wYXJrIHNob3VsZCBzdGlsbCB3b3JrIChmaWxlc3lzdGVtLW9ubHksIG5vIHRocm93KVxuICAgIGNvbnN0IHBhcmtlZCA9IHBhcmtNaWxlc3RvbmUoYmFzZSwgXCJNMDAxXCIsIFwidGVzdFwiKTtcbiAgICBhc3NlcnQub2socGFya2VkLCBcInBhcmtNaWxlc3RvbmUgc3VjY2VlZHMgd2l0aG91dCBEQlwiKTtcblxuICAgIGNvbnN0IHVucGFya2VkID0gdW5wYXJrTWlsZXN0b25lKGJhc2UsIFwiTTAwMVwiKTtcbiAgICBhc3NlcnQub2sodW5wYXJrZWQsIFwidW5wYXJrTWlsZXN0b25lIHN1Y2NlZWRzIHdpdGhvdXQgREJcIik7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBm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
