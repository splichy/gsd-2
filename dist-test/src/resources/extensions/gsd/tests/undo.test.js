import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractCommitShas,
  findCommitsForUnit,
  handleUndo,
  handleUndoTask,
  handleResetSlice,
  uncheckTaskInPlan
} from "../undo.js";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  getTask,
  getSlice
} from "../gsd-db.js";
import { invalidateAllCaches } from "../cache.js";
import { existsSync } from "node:fs";
function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}
test("handleUndo without --force only warns and leaves completed units intact", async () => {
  const base = makeTempDir("gsd-undo-confirm");
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    mkdirSync(join(base, ".gsd", "activity"), { recursive: true });
    writeFileSync(
      join(base, ".gsd", "completed-units.json"),
      JSON.stringify(["execute-task/M001/S01/T01"]),
      "utf-8"
    );
    writeFileSync(
      join(base, ".gsd", "activity", "001-execute-task-M001-S01-T01.jsonl"),
      "",
      "utf-8"
    );
    const notifications = [];
    const ctx = {
      ui: {
        notify(message, level) {
          notifications.push({ message, level });
        }
      }
    };
    await handleUndo("", ctx, {}, base);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.level, "warning");
    assert.match(notifications[0]?.message ?? "", /Run \/gsd undo --force to confirm\./);
    assert.deepEqual(
      JSON.parse(readFileSync(join(base, ".gsd", "completed-units.json"), "utf-8")),
      ["execute-task/M001/S01/T01"]
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("uncheckTaskInPlan flips a checked task back to unchecked", () => {
  const base = makeTempDir("gsd-undo-plan");
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(sliceDir, { recursive: true });
    const planFile = join(sliceDir, "S01-PLAN.md");
    writeFileSync(
      planFile,
      [
        "# Slice Plan",
        "",
        "- [x] **T01**: Ship the feature",
        "- [ ] **T02**: Follow-up"
      ].join("\n"),
      "utf-8"
    );
    assert.equal(uncheckTaskInPlan(base, "M001", "S01", "T01"), true);
    assert.match(readFileSync(planFile, "utf-8"), /- \[ \] \*\*T01\*\*: Ship the feature/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("findCommitsForUnit reads the newest matching activity log and dedupes SHAs", () => {
  const base = makeTempDir("gsd-undo-activity");
  try {
    const activityDir = join(base, ".gsd", "activity");
    mkdirSync(activityDir, { recursive: true });
    writeFileSync(
      join(activityDir, "2026-03-14-execute-task-M001-S01-T01.jsonl"),
      `${JSON.stringify({
        message: {
          content: [
            { type: "tool_result", content: "[main abc1234] old commit" }
          ]
        }
      })}
`,
      "utf-8"
    );
    writeFileSync(
      join(activityDir, "2026-03-15-execute-task-M001-S01-T01.jsonl"),
      [
        JSON.stringify({
          message: {
            content: [
              { type: "tool_result", content: "[main deadbee] new commit\n[main cafe123] another commit" },
              { type: "tool_result", content: "[main deadbee] duplicate commit" }
            ]
          }
        }),
        "{not-json}"
      ].join("\n"),
      "utf-8"
    );
    assert.deepEqual(
      findCommitsForUnit(activityDir, "execute-task", "M001/S01/T01"),
      ["deadbee", "cafe123"]
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("extractCommitShas returns unique commit hashes from git output blocks", () => {
  const content = [
    "[main abc1234] first commit",
    "[feature deadbeef] second commit",
    "[main abc1234] duplicate commit"
  ].join("\n");
  assert.deepEqual(extractCommitShas(content), ["abc1234", "deadbeef"]);
});
test("extractCommitShas ignores malformed commit tokens", () => {
  const content = [
    "[main abc1234; touch /tmp/pwned] not a real sha token",
    "[main not-a-sha] ignored",
    "[main 1234567] valid"
  ].join("\n");
  assert.deepEqual(extractCommitShas(content), ["1234567"]);
});
function makeCtx() {
  const notifications = [];
  const ctx = {
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      }
    }
  };
  return { notifications, ctx };
}
function setupTaskFixture(base) {
  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  const tasksDir = join(sliceDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(
    join(sliceDir, "S01-PLAN.md"),
    [
      "# S01: Test Slice",
      "",
      "## Tasks",
      "",
      "- [x] **T01: First task** `est:30m`",
      "- [ ] **T02: Second task** `est:30m`"
    ].join("\n"),
    "utf-8"
  );
  writeFileSync(
    join(tasksDir, "T01-SUMMARY.md"),
    "# T01 Summary\nDone.",
    "utf-8"
  );
  openDatabase(":memory:");
  insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Test Slice", status: "active", risk: "low", depends: [] });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "First task", status: "complete" });
  insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Second task", status: "pending" });
  invalidateAllCaches();
}
test("handleUndoTask without args shows usage", async () => {
  const { notifications, ctx } = makeCtx();
  const base = makeTempDir("gsd-undo-task-usage");
  try {
    await handleUndoTask("", ctx, {}, base);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.level, "warning");
    assert.match(notifications[0]?.message ?? "", /Usage:/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("handleUndoTask without --force shows confirmation", async () => {
  const base = makeTempDir("gsd-undo-task-confirm");
  try {
    setupTaskFixture(base);
    const { notifications, ctx } = makeCtx();
    await handleUndoTask("M001/S01/T01", ctx, {}, base);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.level, "warning");
    assert.match(notifications[0]?.message ?? "", /--force to confirm/);
    const task = getTask("M001", "S01", "T01");
    assert.equal(task?.status, "complete");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
test("handleUndoTask with --force resets task and re-renders plan", async () => {
  const base = makeTempDir("gsd-undo-task-force");
  try {
    setupTaskFixture(base);
    const { notifications, ctx } = makeCtx();
    await handleUndoTask("M001/S01/T01 --force", ctx, {}, base);
    const task = getTask("M001", "S01", "T01");
    assert.equal(task?.status, "pending");
    const summaryPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md");
    assert.equal(existsSync(summaryPath), false);
    const planContent = readFileSync(
      join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"),
      "utf-8"
    );
    assert.match(planContent, /\[ \] \*\*T01:/);
    assert.equal(notifications[0]?.level, "success");
    assert.match(notifications[0]?.message ?? "", /Reset task M001\/S01\/T01/);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
test("handleUndoTask with non-existent task returns error", async () => {
  const base = makeTempDir("gsd-undo-task-notfound");
  try {
    openDatabase(":memory:");
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Test", status: "active", risk: "low", depends: [] });
    const { notifications, ctx } = makeCtx();
    await handleUndoTask("M001/S01/T99 --force", ctx, {}, base);
    assert.equal(notifications[0]?.level, "error");
    assert.match(notifications[0]?.message ?? "", /not found/);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
test("handleUndoTask accepts partial ID (T01) and resolves from state", async () => {
  const base = makeTempDir("gsd-undo-task-partial");
  try {
    setupTaskFixture(base);
    mkdirSync(join(base, ".gsd"), { recursive: true });
    writeFileSync(
      join(base, ".gsd", "STATE.md"),
      [
        "# GSD State",
        "",
        "- Phase: executing",
        "- Active Milestone: M001",
        "- Active Slice: S01",
        "- Active Task: T01"
      ].join("\n"),
      "utf-8"
    );
    const { notifications, ctx } = makeCtx();
    await handleUndoTask("T01 --force", ctx, {}, base);
    const task = getTask("M001", "S01", "T01");
    assert.equal(task?.status, "pending");
    assert.equal(notifications[0]?.level, "success");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
function setupSliceFixture(base) {
  const mDir = join(base, ".gsd", "milestones", "M001");
  const sliceDir = join(mDir, "slices", "S01");
  const tasksDir = join(sliceDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(
    join(mDir, "M001-ROADMAP.md"),
    [
      "# Roadmap",
      "",
      "## Slices",
      "",
      "- [x] **S01: Test Slice** `risk:low` `depends:[]`",
      "- [ ] **S02: Next Slice** `risk:low` `depends:[S01]`"
    ].join("\n"),
    "utf-8"
  );
  writeFileSync(
    join(sliceDir, "S01-PLAN.md"),
    [
      "# S01: Test Slice",
      "",
      "## Tasks",
      "",
      "- [x] **T01: First task** `est:30m`",
      "- [x] **T02: Second task** `est:30m`"
    ].join("\n"),
    "utf-8"
  );
  writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "# T01 Summary\nDone.", "utf-8");
  writeFileSync(join(tasksDir, "T02-SUMMARY.md"), "# T02 Summary\nDone.", "utf-8");
  writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# Slice Summary\nDone.", "utf-8");
  writeFileSync(join(sliceDir, "S01-UAT.md"), "# UAT\nPassed.", "utf-8");
  openDatabase(":memory:");
  insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Test Slice", status: "complete", risk: "low", depends: [] });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Next Slice", status: "pending", risk: "low", depends: ["S01"] });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "First task", status: "complete" });
  insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Second task", status: "complete" });
  invalidateAllCaches();
}
test("handleResetSlice without args shows usage", async () => {
  const { notifications, ctx } = makeCtx();
  const base = makeTempDir("gsd-reset-slice-usage");
  try {
    await handleResetSlice("", ctx, {}, base);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.level, "warning");
    assert.match(notifications[0]?.message ?? "", /Usage:/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("handleResetSlice without --force shows confirmation", async () => {
  const base = makeTempDir("gsd-reset-slice-confirm");
  try {
    setupSliceFixture(base);
    const { notifications, ctx } = makeCtx();
    await handleResetSlice("M001/S01", ctx, {}, base);
    assert.equal(notifications[0]?.level, "warning");
    assert.match(notifications[0]?.message ?? "", /--force to confirm/);
    const slice = getSlice("M001", "S01");
    assert.equal(slice?.status, "complete");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
test("handleResetSlice with --force resets slice and all tasks", async () => {
  const base = makeTempDir("gsd-reset-slice-force");
  try {
    setupSliceFixture(base);
    const { notifications, ctx } = makeCtx();
    await handleResetSlice("M001/S01 --force", ctx, {}, base);
    const slice = getSlice("M001", "S01");
    assert.equal(slice?.status, "active");
    const t1 = getTask("M001", "S01", "T01");
    assert.equal(t1?.status, "pending");
    const t2 = getTask("M001", "S01", "T02");
    assert.equal(t2?.status, "pending");
    const tasksDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    assert.equal(existsSync(join(tasksDir, "T01-SUMMARY.md")), false);
    assert.equal(existsSync(join(tasksDir, "T02-SUMMARY.md")), false);
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    assert.equal(existsSync(join(sliceDir, "S01-SUMMARY.md")), false);
    assert.equal(existsSync(join(sliceDir, "S01-UAT.md")), false);
    const planContent = readFileSync(join(sliceDir, "S01-PLAN.md"), "utf-8");
    assert.match(planContent, /\[ \] \*\*T01:/);
    assert.match(planContent, /\[ \] \*\*T02:/);
    const roadmapContent = readFileSync(
      join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
      "utf-8"
    );
    assert.match(roadmapContent, /\[ \] \*\*S01:/);
    assert.equal(notifications[0]?.level, "success");
    assert.match(notifications[0]?.message ?? "", /Reset slice M001\/S01/);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
test("handleResetSlice with non-existent slice returns error", async () => {
  const base = makeTempDir("gsd-reset-slice-notfound");
  try {
    openDatabase(":memory:");
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    const { notifications, ctx } = makeCtx();
    await handleResetSlice("M001/S99 --force", ctx, {}, base);
    assert.equal(notifications[0]?.level, "error");
    assert.match(notifications[0]?.message ?? "", /not found/);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy91bmRvLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgcmVhZEZpbGVTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbmltcG9ydCB7XG4gIGV4dHJhY3RDb21taXRTaGFzLFxuICBmaW5kQ29tbWl0c0ZvclVuaXQsXG4gIGhhbmRsZVVuZG8sXG4gIGhhbmRsZVVuZG9UYXNrLFxuICBoYW5kbGVSZXNldFNsaWNlLFxuICB1bmNoZWNrVGFza0luUGxhbixcbn0gZnJvbSBcIi4uL3VuZG8udHNcIjtcbmltcG9ydCB7XG4gIG9wZW5EYXRhYmFzZSxcbiAgY2xvc2VEYXRhYmFzZSxcbiAgaW5zZXJ0TWlsZXN0b25lLFxuICBpbnNlcnRTbGljZSxcbiAgaW5zZXJ0VGFzayxcbiAgZ2V0VGFzayxcbiAgZ2V0U2xpY2UsXG59IGZyb20gXCIuLi9nc2QtZGIudHNcIjtcbmltcG9ydCB7IGludmFsaWRhdGVBbGxDYWNoZXMgfSBmcm9tIFwiLi4vY2FjaGUudHNcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuXG5mdW5jdGlvbiBtYWtlVGVtcERpcihwcmVmaXg6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBgJHtwcmVmaXh9LWApKTtcbn1cblxudGVzdChcImhhbmRsZVVuZG8gd2l0aG91dCAtLWZvcmNlIG9ubHkgd2FybnMgYW5kIGxlYXZlcyBjb21wbGV0ZWQgdW5pdHMgaW50YWN0XCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUZW1wRGlyKFwiZ3NkLXVuZG8tY29uZmlybVwiKTtcbiAgdHJ5IHtcbiAgICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcImFjdGl2aXR5XCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihiYXNlLCBcIi5nc2RcIiwgXCJjb21wbGV0ZWQtdW5pdHMuanNvblwiKSxcbiAgICAgIEpTT04uc3RyaW5naWZ5KFtcImV4ZWN1dGUtdGFzay9NMDAxL1MwMS9UMDFcIl0pLFxuICAgICAgXCJ1dGYtOFwiLFxuICAgICk7XG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiYWN0aXZpdHlcIiwgXCIwMDEtZXhlY3V0ZS10YXNrLU0wMDEtUzAxLVQwMS5qc29ubFwiKSxcbiAgICAgIFwiXCIsXG4gICAgICBcInV0Zi04XCIsXG4gICAgKTtcblxuICAgIGNvbnN0IG5vdGlmaWNhdGlvbnM6IEFycmF5PHsgbWVzc2FnZTogc3RyaW5nOyBsZXZlbDogc3RyaW5nIH0+ID0gW107XG4gICAgY29uc3QgY3R4ID0ge1xuICAgICAgdWk6IHtcbiAgICAgICAgbm90aWZ5KG1lc3NhZ2U6IHN0cmluZywgbGV2ZWw6IHN0cmluZykge1xuICAgICAgICAgIG5vdGlmaWNhdGlvbnMucHVzaCh7IG1lc3NhZ2UsIGxldmVsIH0pO1xuICAgICAgICB9LFxuICAgICAgfSxcbiAgICB9O1xuXG4gICAgYXdhaXQgaGFuZGxlVW5kbyhcIlwiLCBjdHggYXMgYW55LCB7fSBhcyBhbnksIGJhc2UpO1xuXG4gICAgYXNzZXJ0LmVxdWFsKG5vdGlmaWNhdGlvbnMubGVuZ3RoLCAxKTtcbiAgICBhc3NlcnQuZXF1YWwobm90aWZpY2F0aW9uc1swXT8ubGV2ZWwsIFwid2FybmluZ1wiKTtcbiAgICBhc3NlcnQubWF0Y2gobm90aWZpY2F0aW9uc1swXT8ubWVzc2FnZSA/PyBcIlwiLCAvUnVuIFxcL2dzZCB1bmRvIC0tZm9yY2UgdG8gY29uZmlybVxcLi8pO1xuICAgIGFzc2VydC5kZWVwRXF1YWwoXG4gICAgICBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcImNvbXBsZXRlZC11bml0cy5qc29uXCIpLCBcInV0Zi04XCIpKSxcbiAgICAgIFtcImV4ZWN1dGUtdGFzay9NMDAxL1MwMS9UMDFcIl0sXG4gICAgKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcInVuY2hlY2tUYXNrSW5QbGFuIGZsaXBzIGEgY2hlY2tlZCB0YXNrIGJhY2sgdG8gdW5jaGVja2VkXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUZW1wRGlyKFwiZ3NkLXVuZG8tcGxhblwiKTtcbiAgdHJ5IHtcbiAgICBjb25zdCBzbGljZURpciA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIik7XG4gICAgbWtkaXJTeW5jKHNsaWNlRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBjb25zdCBwbGFuRmlsZSA9IGpvaW4oc2xpY2VEaXIsIFwiUzAxLVBMQU4ubWRcIik7XG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIHBsYW5GaWxlLFxuICAgICAgW1xuICAgICAgICBcIiMgU2xpY2UgUGxhblwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIi0gW3hdICoqVDAxKio6IFNoaXAgdGhlIGZlYXR1cmVcIixcbiAgICAgICAgXCItIFsgXSAqKlQwMioqOiBGb2xsb3ctdXBcIixcbiAgICAgIF0uam9pbihcIlxcblwiKSxcbiAgICAgIFwidXRmLThcIixcbiAgICApO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHVuY2hlY2tUYXNrSW5QbGFuKGJhc2UsIFwiTTAwMVwiLCBcIlMwMVwiLCBcIlQwMVwiKSwgdHJ1ZSk7XG4gICAgYXNzZXJ0Lm1hdGNoKHJlYWRGaWxlU3luYyhwbGFuRmlsZSwgXCJ1dGYtOFwiKSwgLy0gXFxbIFxcXSBcXCpcXCpUMDFcXCpcXCo6IFNoaXAgdGhlIGZlYXR1cmUvKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcImZpbmRDb21taXRzRm9yVW5pdCByZWFkcyB0aGUgbmV3ZXN0IG1hdGNoaW5nIGFjdGl2aXR5IGxvZyBhbmQgZGVkdXBlcyBTSEFzXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUZW1wRGlyKFwiZ3NkLXVuZG8tYWN0aXZpdHlcIik7XG4gIHRyeSB7XG4gICAgY29uc3QgYWN0aXZpdHlEaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcImFjdGl2aXR5XCIpO1xuICAgIG1rZGlyU3luYyhhY3Rpdml0eURpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihhY3Rpdml0eURpciwgXCIyMDI2LTAzLTE0LWV4ZWN1dGUtdGFzay1NMDAxLVMwMS1UMDEuanNvbmxcIiksXG4gICAgICBgJHtKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIG1lc3NhZ2U6IHtcbiAgICAgICAgICBjb250ZW50OiBbXG4gICAgICAgICAgICB7IHR5cGU6IFwidG9vbF9yZXN1bHRcIiwgY29udGVudDogXCJbbWFpbiBhYmMxMjM0XSBvbGQgY29tbWl0XCIgfSxcbiAgICAgICAgICBdLFxuICAgICAgICB9LFxuICAgICAgfSl9XFxuYCxcbiAgICAgIFwidXRmLThcIixcbiAgICApO1xuXG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4oYWN0aXZpdHlEaXIsIFwiMjAyNi0wMy0xNS1leGVjdXRlLXRhc2stTTAwMS1TMDEtVDAxLmpzb25sXCIpLFxuICAgICAgW1xuICAgICAgICBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgbWVzc2FnZToge1xuICAgICAgICAgICAgY29udGVudDogW1xuICAgICAgICAgICAgICB7IHR5cGU6IFwidG9vbF9yZXN1bHRcIiwgY29udGVudDogXCJbbWFpbiBkZWFkYmVlXSBuZXcgY29tbWl0XFxuW21haW4gY2FmZTEyM10gYW5vdGhlciBjb21taXRcIiB9LFxuICAgICAgICAgICAgICB7IHR5cGU6IFwidG9vbF9yZXN1bHRcIiwgY29udGVudDogXCJbbWFpbiBkZWFkYmVlXSBkdXBsaWNhdGUgY29tbWl0XCIgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSksXG4gICAgICAgIFwie25vdC1qc29ufVwiLFxuICAgICAgXS5qb2luKFwiXFxuXCIpLFxuICAgICAgXCJ1dGYtOFwiLFxuICAgICk7XG5cbiAgICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgICAgZmluZENvbW1pdHNGb3JVbml0KGFjdGl2aXR5RGlyLCBcImV4ZWN1dGUtdGFza1wiLCBcIk0wMDEvUzAxL1QwMVwiKSxcbiAgICAgIFtcImRlYWRiZWVcIiwgXCJjYWZlMTIzXCJdLFxuICAgICk7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJleHRyYWN0Q29tbWl0U2hhcyByZXR1cm5zIHVuaXF1ZSBjb21taXQgaGFzaGVzIGZyb20gZ2l0IG91dHB1dCBibG9ja3NcIiwgKCkgPT4ge1xuICBjb25zdCBjb250ZW50ID0gW1xuICAgIFwiW21haW4gYWJjMTIzNF0gZmlyc3QgY29tbWl0XCIsXG4gICAgXCJbZmVhdHVyZSBkZWFkYmVlZl0gc2Vjb25kIGNvbW1pdFwiLFxuICAgIFwiW21haW4gYWJjMTIzNF0gZHVwbGljYXRlIGNvbW1pdFwiLFxuICBdLmpvaW4oXCJcXG5cIik7XG5cbiAgYXNzZXJ0LmRlZXBFcXVhbChleHRyYWN0Q29tbWl0U2hhcyhjb250ZW50KSwgW1wiYWJjMTIzNFwiLCBcImRlYWRiZWVmXCJdKTtcbn0pO1xuXG50ZXN0KFwiZXh0cmFjdENvbW1pdFNoYXMgaWdub3JlcyBtYWxmb3JtZWQgY29tbWl0IHRva2Vuc1wiLCAoKSA9PiB7XG4gIGNvbnN0IGNvbnRlbnQgPSBbXG4gICAgXCJbbWFpbiBhYmMxMjM0OyB0b3VjaCAvdG1wL3B3bmVkXSBub3QgYSByZWFsIHNoYSB0b2tlblwiLFxuICAgIFwiW21haW4gbm90LWEtc2hhXSBpZ25vcmVkXCIsXG4gICAgXCJbbWFpbiAxMjM0NTY3XSB2YWxpZFwiLFxuICBdLmpvaW4oXCJcXG5cIik7XG5cbiAgYXNzZXJ0LmRlZXBFcXVhbChleHRyYWN0Q29tbWl0U2hhcyhjb250ZW50KSwgW1wiMTIzNDU2N1wiXSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGhhbmRsZVVuZG9UYXNrIHRlc3RzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBtYWtlQ3R4KCk6IHsgbm90aWZpY2F0aW9uczogQXJyYXk8eyBtZXNzYWdlOiBzdHJpbmc7IGxldmVsOiBzdHJpbmcgfT47IGN0eDogYW55IH0ge1xuICBjb25zdCBub3RpZmljYXRpb25zOiBBcnJheTx7IG1lc3NhZ2U6IHN0cmluZzsgbGV2ZWw6IHN0cmluZyB9PiA9IFtdO1xuICBjb25zdCBjdHggPSB7XG4gICAgdWk6IHtcbiAgICAgIG5vdGlmeShtZXNzYWdlOiBzdHJpbmcsIGxldmVsOiBzdHJpbmcpIHtcbiAgICAgICAgbm90aWZpY2F0aW9ucy5wdXNoKHsgbWVzc2FnZSwgbGV2ZWwgfSk7XG4gICAgICB9LFxuICAgIH0sXG4gIH07XG4gIHJldHVybiB7IG5vdGlmaWNhdGlvbnMsIGN0eCB9O1xufVxuXG5mdW5jdGlvbiBzZXR1cFRhc2tGaXh0dXJlKGJhc2U6IHN0cmluZyk6IHZvaWQge1xuICAvLyBDcmVhdGUgbWlsZXN0b25lL3NsaWNlL3Rhc2sgZGlyZWN0b3J5IHN0cnVjdHVyZVxuICBjb25zdCBzbGljZURpciA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIik7XG4gIGNvbnN0IHRhc2tzRGlyID0gam9pbihzbGljZURpciwgXCJ0YXNrc1wiKTtcbiAgbWtkaXJTeW5jKHRhc2tzRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAvLyBXcml0ZSBwbGFuIGZpbGUgd2l0aCBjaGVja2VkIHRhc2tcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKHNsaWNlRGlyLCBcIlMwMS1QTEFOLm1kXCIpLFxuICAgIFtcbiAgICAgIFwiIyBTMDE6IFRlc3QgU2xpY2VcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFRhc2tzXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCItIFt4XSAqKlQwMTogRmlyc3QgdGFzayoqIGBlc3Q6MzBtYFwiLFxuICAgICAgXCItIFsgXSAqKlQwMjogU2Vjb25kIHRhc2sqKiBgZXN0OjMwbWBcIixcbiAgICBdLmpvaW4oXCJcXG5cIiksXG4gICAgXCJ1dGYtOFwiLFxuICApO1xuXG4gIC8vIFdyaXRlIHRhc2sgc3VtbWFyeSBmaWxlXG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbih0YXNrc0RpciwgXCJUMDEtU1VNTUFSWS5tZFwiKSxcbiAgICBcIiMgVDAxIFN1bW1hcnlcXG5Eb25lLlwiLFxuICAgIFwidXRmLThcIixcbiAgKTtcblxuICAvLyBTZXQgdXAgREJcbiAgb3BlbkRhdGFiYXNlKFwiOm1lbW9yeTpcIik7XG4gIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdCBNaWxlc3RvbmVcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuICBpbnNlcnRTbGljZSh7IGlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3QgU2xpY2VcIiwgc3RhdHVzOiBcImFjdGl2ZVwiLCByaXNrOiBcImxvd1wiLCBkZXBlbmRzOiBbXSB9KTtcbiAgaW5zZXJ0VGFzayh7IGlkOiBcIlQwMVwiLCBzbGljZUlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHRpdGxlOiBcIkZpcnN0IHRhc2tcIiwgc3RhdHVzOiBcImNvbXBsZXRlXCIgfSk7XG4gIGluc2VydFRhc2soeyBpZDogXCJUMDJcIiwgc2xpY2VJZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJTZWNvbmQgdGFza1wiLCBzdGF0dXM6IFwicGVuZGluZ1wiIH0pO1xuICBpbnZhbGlkYXRlQWxsQ2FjaGVzKCk7XG59XG5cbnRlc3QoXCJoYW5kbGVVbmRvVGFzayB3aXRob3V0IGFyZ3Mgc2hvd3MgdXNhZ2VcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IG5vdGlmaWNhdGlvbnMsIGN0eCB9ID0gbWFrZUN0eCgpO1xuICBjb25zdCBiYXNlID0gbWFrZVRlbXBEaXIoXCJnc2QtdW5kby10YXNrLXVzYWdlXCIpO1xuICB0cnkge1xuICAgIGF3YWl0IGhhbmRsZVVuZG9UYXNrKFwiXCIsIGN0eCwge30gYXMgYW55LCBiYXNlKTtcbiAgICBhc3NlcnQuZXF1YWwobm90aWZpY2F0aW9ucy5sZW5ndGgsIDEpO1xuICAgIGFzc2VydC5lcXVhbChub3RpZmljYXRpb25zWzBdPy5sZXZlbCwgXCJ3YXJuaW5nXCIpO1xuICAgIGFzc2VydC5tYXRjaChub3RpZmljYXRpb25zWzBdPy5tZXNzYWdlID8/IFwiXCIsIC9Vc2FnZTovKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcImhhbmRsZVVuZG9UYXNrIHdpdGhvdXQgLS1mb3JjZSBzaG93cyBjb25maXJtYXRpb25cIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRlbXBEaXIoXCJnc2QtdW5kby10YXNrLWNvbmZpcm1cIik7XG4gIHRyeSB7XG4gICAgc2V0dXBUYXNrRml4dHVyZShiYXNlKTtcbiAgICBjb25zdCB7IG5vdGlmaWNhdGlvbnMsIGN0eCB9ID0gbWFrZUN0eCgpO1xuICAgIGF3YWl0IGhhbmRsZVVuZG9UYXNrKFwiTTAwMS9TMDEvVDAxXCIsIGN0eCwge30gYXMgYW55LCBiYXNlKTtcbiAgICBhc3NlcnQuZXF1YWwobm90aWZpY2F0aW9ucy5sZW5ndGgsIDEpO1xuICAgIGFzc2VydC5lcXVhbChub3RpZmljYXRpb25zWzBdPy5sZXZlbCwgXCJ3YXJuaW5nXCIpO1xuICAgIGFzc2VydC5tYXRjaChub3RpZmljYXRpb25zWzBdPy5tZXNzYWdlID8/IFwiXCIsIC8tLWZvcmNlIHRvIGNvbmZpcm0vKTtcbiAgICAvLyBWZXJpZnkgc3RhdGUgd2FzIE5PVCBtb2RpZmllZFxuICAgIGNvbnN0IHRhc2sgPSBnZXRUYXNrKFwiTTAwMVwiLCBcIlMwMVwiLCBcIlQwMVwiKTtcbiAgICBhc3NlcnQuZXF1YWwodGFzaz8uc3RhdHVzLCBcImNvbXBsZXRlXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcImhhbmRsZVVuZG9UYXNrIHdpdGggLS1mb3JjZSByZXNldHMgdGFzayBhbmQgcmUtcmVuZGVycyBwbGFuXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUZW1wRGlyKFwiZ3NkLXVuZG8tdGFzay1mb3JjZVwiKTtcbiAgdHJ5IHtcbiAgICBzZXR1cFRhc2tGaXh0dXJlKGJhc2UpO1xuICAgIGNvbnN0IHsgbm90aWZpY2F0aW9ucywgY3R4IH0gPSBtYWtlQ3R4KCk7XG4gICAgYXdhaXQgaGFuZGxlVW5kb1Rhc2soXCJNMDAxL1MwMS9UMDEgLS1mb3JjZVwiLCBjdHgsIHt9IGFzIGFueSwgYmFzZSk7XG5cbiAgICAvLyBEQiBzdGF0dXMgcmVzZXRcbiAgICBjb25zdCB0YXNrID0gZ2V0VGFzayhcIk0wMDFcIiwgXCJTMDFcIiwgXCJUMDFcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHRhc2s/LnN0YXR1cywgXCJwZW5kaW5nXCIpO1xuXG4gICAgLy8gU3VtbWFyeSBmaWxlIGRlbGV0ZWRcbiAgICBjb25zdCBzdW1tYXJ5UGF0aCA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIiwgXCJ0YXNrc1wiLCBcIlQwMS1TVU1NQVJZLm1kXCIpO1xuICAgIGFzc2VydC5lcXVhbChleGlzdHNTeW5jKHN1bW1hcnlQYXRoKSwgZmFsc2UpO1xuXG4gICAgLy8gUGxhbiBjaGVja2JveCB1bmNoZWNrZWRcbiAgICBjb25zdCBwbGFuQ29udGVudCA9IHJlYWRGaWxlU3luYyhcbiAgICAgIGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIiwgXCJTMDEtUExBTi5tZFwiKSxcbiAgICAgIFwidXRmLThcIixcbiAgICApO1xuICAgIGFzc2VydC5tYXRjaChwbGFuQ29udGVudCwgL1xcWyBcXF0gXFwqXFwqVDAxOi8pO1xuXG4gICAgLy8gU3VjY2VzcyBub3RpZmljYXRpb25cbiAgICBhc3NlcnQuZXF1YWwobm90aWZpY2F0aW9uc1swXT8ubGV2ZWwsIFwic3VjY2Vzc1wiKTtcbiAgICBhc3NlcnQubWF0Y2gobm90aWZpY2F0aW9uc1swXT8ubWVzc2FnZSA/PyBcIlwiLCAvUmVzZXQgdGFzayBNMDAxXFwvUzAxXFwvVDAxLyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiaGFuZGxlVW5kb1Rhc2sgd2l0aCBub24tZXhpc3RlbnQgdGFzayByZXR1cm5zIGVycm9yXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUZW1wRGlyKFwiZ3NkLXVuZG8tdGFzay1ub3Rmb3VuZFwiKTtcbiAgdHJ5IHtcbiAgICBvcGVuRGF0YWJhc2UoXCI6bWVtb3J5OlwiKTtcbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuICAgIGluc2VydFNsaWNlKHsgaWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdFwiLCBzdGF0dXM6IFwiYWN0aXZlXCIsIHJpc2s6IFwibG93XCIsIGRlcGVuZHM6IFtdIH0pO1xuXG4gICAgY29uc3QgeyBub3RpZmljYXRpb25zLCBjdHggfSA9IG1ha2VDdHgoKTtcbiAgICBhd2FpdCBoYW5kbGVVbmRvVGFzayhcIk0wMDEvUzAxL1Q5OSAtLWZvcmNlXCIsIGN0eCwge30gYXMgYW55LCBiYXNlKTtcbiAgICBhc3NlcnQuZXF1YWwobm90aWZpY2F0aW9uc1swXT8ubGV2ZWwsIFwiZXJyb3JcIik7XG4gICAgYXNzZXJ0Lm1hdGNoKG5vdGlmaWNhdGlvbnNbMF0/Lm1lc3NhZ2UgPz8gXCJcIiwgL25vdCBmb3VuZC8pO1xuICB9IGZpbmFsbHkge1xuICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcImhhbmRsZVVuZG9UYXNrIGFjY2VwdHMgcGFydGlhbCBJRCAoVDAxKSBhbmQgcmVzb2x2ZXMgZnJvbSBzdGF0ZVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVGVtcERpcihcImdzZC11bmRvLXRhc2stcGFydGlhbFwiKTtcbiAgdHJ5IHtcbiAgICBzZXR1cFRhc2tGaXh0dXJlKGJhc2UpO1xuXG4gICAgLy8gQ3JlYXRlIFNUQVRFLm1kIHNvIGRlcml2ZVN0YXRlIGNhbiByZXNvbHZlIHRoZSBhY3RpdmUgbWlsZXN0b25lL3NsaWNlXG4gICAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihiYXNlLCBcIi5nc2RcIiwgXCJTVEFURS5tZFwiKSxcbiAgICAgIFtcbiAgICAgICAgXCIjIEdTRCBTdGF0ZVwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIi0gUGhhc2U6IGV4ZWN1dGluZ1wiLFxuICAgICAgICBcIi0gQWN0aXZlIE1pbGVzdG9uZTogTTAwMVwiLFxuICAgICAgICBcIi0gQWN0aXZlIFNsaWNlOiBTMDFcIixcbiAgICAgICAgXCItIEFjdGl2ZSBUYXNrOiBUMDFcIixcbiAgICAgIF0uam9pbihcIlxcblwiKSxcbiAgICAgIFwidXRmLThcIixcbiAgICApO1xuXG4gICAgY29uc3QgeyBub3RpZmljYXRpb25zLCBjdHggfSA9IG1ha2VDdHgoKTtcbiAgICBhd2FpdCBoYW5kbGVVbmRvVGFzayhcIlQwMSAtLWZvcmNlXCIsIGN0eCwge30gYXMgYW55LCBiYXNlKTtcblxuICAgIGNvbnN0IHRhc2sgPSBnZXRUYXNrKFwiTTAwMVwiLCBcIlMwMVwiLCBcIlQwMVwiKTtcbiAgICBhc3NlcnQuZXF1YWwodGFzaz8uc3RhdHVzLCBcInBlbmRpbmdcIik7XG4gICAgYXNzZXJ0LmVxdWFsKG5vdGlmaWNhdGlvbnNbMF0/LmxldmVsLCBcInN1Y2Nlc3NcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgaGFuZGxlUmVzZXRTbGljZSB0ZXN0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gc2V0dXBTbGljZUZpeHR1cmUoYmFzZTogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IG1EaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIpO1xuICBjb25zdCBzbGljZURpciA9IGpvaW4obURpciwgXCJzbGljZXNcIiwgXCJTMDFcIik7XG4gIGNvbnN0IHRhc2tzRGlyID0gam9pbihzbGljZURpciwgXCJ0YXNrc1wiKTtcbiAgbWtkaXJTeW5jKHRhc2tzRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAvLyBXcml0ZSByb2FkbWFwIGZpbGVcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKG1EaXIsIFwiTTAwMS1ST0FETUFQLm1kXCIpLFxuICAgIFtcbiAgICAgIFwiIyBSb2FkbWFwXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBTbGljZXNcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIi0gW3hdICoqUzAxOiBUZXN0IFNsaWNlKiogYHJpc2s6bG93YCBgZGVwZW5kczpbXWBcIixcbiAgICAgIFwiLSBbIF0gKipTMDI6IE5leHQgU2xpY2UqKiBgcmlzazpsb3dgIGBkZXBlbmRzOltTMDFdYFwiLFxuICAgIF0uam9pbihcIlxcblwiKSxcbiAgICBcInV0Zi04XCIsXG4gICk7XG5cbiAgLy8gV3JpdGUgcGxhbiBmaWxlXG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihzbGljZURpciwgXCJTMDEtUExBTi5tZFwiKSxcbiAgICBbXG4gICAgICBcIiMgUzAxOiBUZXN0IFNsaWNlXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBUYXNrc1wiLFxuICAgICAgXCJcIixcbiAgICAgIFwiLSBbeF0gKipUMDE6IEZpcnN0IHRhc2sqKiBgZXN0OjMwbWBcIixcbiAgICAgIFwiLSBbeF0gKipUMDI6IFNlY29uZCB0YXNrKiogYGVzdDozMG1gXCIsXG4gICAgXS5qb2luKFwiXFxuXCIpLFxuICAgIFwidXRmLThcIixcbiAgKTtcblxuICAvLyBXcml0ZSB0YXNrIHN1bW1hcmllc1xuICB3cml0ZUZpbGVTeW5jKGpvaW4odGFza3NEaXIsIFwiVDAxLVNVTU1BUlkubWRcIiksIFwiIyBUMDEgU3VtbWFyeVxcbkRvbmUuXCIsIFwidXRmLThcIik7XG4gIHdyaXRlRmlsZVN5bmMoam9pbih0YXNrc0RpciwgXCJUMDItU1VNTUFSWS5tZFwiKSwgXCIjIFQwMiBTdW1tYXJ5XFxuRG9uZS5cIiwgXCJ1dGYtOFwiKTtcblxuICAvLyBXcml0ZSBzbGljZSBzdW1tYXJ5IGFuZCBVQVRcbiAgd3JpdGVGaWxlU3luYyhqb2luKHNsaWNlRGlyLCBcIlMwMS1TVU1NQVJZLm1kXCIpLCBcIiMgU2xpY2UgU3VtbWFyeVxcbkRvbmUuXCIsIFwidXRmLThcIik7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihzbGljZURpciwgXCJTMDEtVUFULm1kXCIpLCBcIiMgVUFUXFxuUGFzc2VkLlwiLCBcInV0Zi04XCIpO1xuXG4gIC8vIFNldCB1cCBEQlxuICBvcGVuRGF0YWJhc2UoXCI6bWVtb3J5OlwiKTtcbiAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0IE1pbGVzdG9uZVwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSk7XG4gIGluc2VydFNsaWNlKHsgaWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdCBTbGljZVwiLCBzdGF0dXM6IFwiY29tcGxldGVcIiwgcmlzazogXCJsb3dcIiwgZGVwZW5kczogW10gfSk7XG4gIGluc2VydFNsaWNlKHsgaWQ6IFwiUzAyXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiTmV4dCBTbGljZVwiLCBzdGF0dXM6IFwicGVuZGluZ1wiLCByaXNrOiBcImxvd1wiLCBkZXBlbmRzOiBbXCJTMDFcIl0gfSk7XG4gIGluc2VydFRhc2soeyBpZDogXCJUMDFcIiwgc2xpY2VJZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJGaXJzdCB0YXNrXCIsIHN0YXR1czogXCJjb21wbGV0ZVwiIH0pO1xuICBpbnNlcnRUYXNrKHsgaWQ6IFwiVDAyXCIsIHNsaWNlSWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiU2Vjb25kIHRhc2tcIiwgc3RhdHVzOiBcImNvbXBsZXRlXCIgfSk7XG4gIGludmFsaWRhdGVBbGxDYWNoZXMoKTtcbn1cblxudGVzdChcImhhbmRsZVJlc2V0U2xpY2Ugd2l0aG91dCBhcmdzIHNob3dzIHVzYWdlXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyBub3RpZmljYXRpb25zLCBjdHggfSA9IG1ha2VDdHgoKTtcbiAgY29uc3QgYmFzZSA9IG1ha2VUZW1wRGlyKFwiZ3NkLXJlc2V0LXNsaWNlLXVzYWdlXCIpO1xuICB0cnkge1xuICAgIGF3YWl0IGhhbmRsZVJlc2V0U2xpY2UoXCJcIiwgY3R4LCB7fSBhcyBhbnksIGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChub3RpZmljYXRpb25zLmxlbmd0aCwgMSk7XG4gICAgYXNzZXJ0LmVxdWFsKG5vdGlmaWNhdGlvbnNbMF0/LmxldmVsLCBcIndhcm5pbmdcIik7XG4gICAgYXNzZXJ0Lm1hdGNoKG5vdGlmaWNhdGlvbnNbMF0/Lm1lc3NhZ2UgPz8gXCJcIiwgL1VzYWdlOi8pO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiaGFuZGxlUmVzZXRTbGljZSB3aXRob3V0IC0tZm9yY2Ugc2hvd3MgY29uZmlybWF0aW9uXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUZW1wRGlyKFwiZ3NkLXJlc2V0LXNsaWNlLWNvbmZpcm1cIik7XG4gIHRyeSB7XG4gICAgc2V0dXBTbGljZUZpeHR1cmUoYmFzZSk7XG4gICAgY29uc3QgeyBub3RpZmljYXRpb25zLCBjdHggfSA9IG1ha2VDdHgoKTtcbiAgICBhd2FpdCBoYW5kbGVSZXNldFNsaWNlKFwiTTAwMS9TMDFcIiwgY3R4LCB7fSBhcyBhbnksIGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChub3RpZmljYXRpb25zWzBdPy5sZXZlbCwgXCJ3YXJuaW5nXCIpO1xuICAgIGFzc2VydC5tYXRjaChub3RpZmljYXRpb25zWzBdPy5tZXNzYWdlID8/IFwiXCIsIC8tLWZvcmNlIHRvIGNvbmZpcm0vKTtcbiAgICAvLyBTdGF0ZSBub3QgbW9kaWZpZWRcbiAgICBjb25zdCBzbGljZSA9IGdldFNsaWNlKFwiTTAwMVwiLCBcIlMwMVwiKTtcbiAgICBhc3NlcnQuZXF1YWwoc2xpY2U/LnN0YXR1cywgXCJjb21wbGV0ZVwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJoYW5kbGVSZXNldFNsaWNlIHdpdGggLS1mb3JjZSByZXNldHMgc2xpY2UgYW5kIGFsbCB0YXNrc1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVGVtcERpcihcImdzZC1yZXNldC1zbGljZS1mb3JjZVwiKTtcbiAgdHJ5IHtcbiAgICBzZXR1cFNsaWNlRml4dHVyZShiYXNlKTtcbiAgICBjb25zdCB7IG5vdGlmaWNhdGlvbnMsIGN0eCB9ID0gbWFrZUN0eCgpO1xuICAgIGF3YWl0IGhhbmRsZVJlc2V0U2xpY2UoXCJNMDAxL1MwMSAtLWZvcmNlXCIsIGN0eCwge30gYXMgYW55LCBiYXNlKTtcblxuICAgIC8vIERCIHN0YXR1cyByZXNldFxuICAgIGNvbnN0IHNsaWNlID0gZ2V0U2xpY2UoXCJNMDAxXCIsIFwiUzAxXCIpO1xuICAgIGFzc2VydC5lcXVhbChzbGljZT8uc3RhdHVzLCBcImFjdGl2ZVwiKTtcbiAgICBjb25zdCB0MSA9IGdldFRhc2soXCJNMDAxXCIsIFwiUzAxXCIsIFwiVDAxXCIpO1xuICAgIGFzc2VydC5lcXVhbCh0MT8uc3RhdHVzLCBcInBlbmRpbmdcIik7XG4gICAgY29uc3QgdDIgPSBnZXRUYXNrKFwiTTAwMVwiLCBcIlMwMVwiLCBcIlQwMlwiKTtcbiAgICBhc3NlcnQuZXF1YWwodDI/LnN0YXR1cywgXCJwZW5kaW5nXCIpO1xuXG4gICAgLy8gVGFzayBzdW1tYXJpZXMgZGVsZXRlZFxuICAgIGNvbnN0IHRhc2tzRGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiLCBcInRhc2tzXCIpO1xuICAgIGFzc2VydC5lcXVhbChleGlzdHNTeW5jKGpvaW4odGFza3NEaXIsIFwiVDAxLVNVTU1BUlkubWRcIikpLCBmYWxzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKGV4aXN0c1N5bmMoam9pbih0YXNrc0RpciwgXCJUMDItU1VNTUFSWS5tZFwiKSksIGZhbHNlKTtcblxuICAgIC8vIFNsaWNlIHN1bW1hcnkgYW5kIFVBVCBkZWxldGVkXG4gICAgY29uc3Qgc2xpY2VEaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIpO1xuICAgIGFzc2VydC5lcXVhbChleGlzdHNTeW5jKGpvaW4oc2xpY2VEaXIsIFwiUzAxLVNVTU1BUlkubWRcIikpLCBmYWxzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKGV4aXN0c1N5bmMoam9pbihzbGljZURpciwgXCJTMDEtVUFULm1kXCIpKSwgZmFsc2UpO1xuXG4gICAgLy8gUGxhbiBjaGVja2JveGVzIHVuY2hlY2tlZFxuICAgIGNvbnN0IHBsYW5Db250ZW50ID0gcmVhZEZpbGVTeW5jKGpvaW4oc2xpY2VEaXIsIFwiUzAxLVBMQU4ubWRcIiksIFwidXRmLThcIik7XG4gICAgYXNzZXJ0Lm1hdGNoKHBsYW5Db250ZW50LCAvXFxbIFxcXSBcXCpcXCpUMDE6Lyk7XG4gICAgYXNzZXJ0Lm1hdGNoKHBsYW5Db250ZW50LCAvXFxbIFxcXSBcXCpcXCpUMDI6Lyk7XG5cbiAgICAvLyBSb2FkbWFwIGNoZWNrYm94IHVuY2hlY2tlZFxuICAgIGNvbnN0IHJvYWRtYXBDb250ZW50ID0gcmVhZEZpbGVTeW5jKFxuICAgICAgam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcIk0wMDEtUk9BRE1BUC5tZFwiKSxcbiAgICAgIFwidXRmLThcIixcbiAgICApO1xuICAgIGFzc2VydC5tYXRjaChyb2FkbWFwQ29udGVudCwgL1xcWyBcXF0gXFwqXFwqUzAxOi8pO1xuXG4gICAgLy8gU3VjY2VzcyBub3RpZmljYXRpb25cbiAgICBhc3NlcnQuZXF1YWwobm90aWZpY2F0aW9uc1swXT8ubGV2ZWwsIFwic3VjY2Vzc1wiKTtcbiAgICBhc3NlcnQubWF0Y2gobm90aWZpY2F0aW9uc1swXT8ubWVzc2FnZSA/PyBcIlwiLCAvUmVzZXQgc2xpY2UgTTAwMVxcL1MwMS8pO1xuICB9IGZpbmFsbHkge1xuICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcImhhbmRsZVJlc2V0U2xpY2Ugd2l0aCBub24tZXhpc3RlbnQgc2xpY2UgcmV0dXJucyBlcnJvclwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVGVtcERpcihcImdzZC1yZXNldC1zbGljZS1ub3Rmb3VuZFwiKTtcbiAgdHJ5IHtcbiAgICBvcGVuRGF0YWJhc2UoXCI6bWVtb3J5OlwiKTtcbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuXG4gICAgY29uc3QgeyBub3RpZmljYXRpb25zLCBjdHggfSA9IG1ha2VDdHgoKTtcbiAgICBhd2FpdCBoYW5kbGVSZXNldFNsaWNlKFwiTTAwMS9TOTkgLS1mb3JjZVwiLCBjdHgsIHt9IGFzIGFueSwgYmFzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKG5vdGlmaWNhdGlvbnNbMF0/LmxldmVsLCBcImVycm9yXCIpO1xuICAgIGFzc2VydC5tYXRjaChub3RpZmljYXRpb25zWzBdPy5tZXNzYWdlID8/IFwiXCIsIC9ub3QgZm91bmQvKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxXQUFXLGNBQWMsUUFBUSxxQkFBcUI7QUFDNUUsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsWUFBWTtBQUVy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QUFVLE9BQU8sT0FBTztBQUNsRixXQUFPLE1BQU0sV0FBVyxLQUFLLFVBQVUsZ0JBQWdCLENBQUMsR0FBRyxLQUFLO0FBQ2hFLFdBQU8sTUFBTSxXQUFXLEtBQUssVUFBVSxnQkFBZ0IsQ0FBQyxHQUFHLEtBQUs7QUFHaEUsVUFBTSxXQUFXLEtBQUssTUFBTSxRQUFRLGNBQWMsUUFBUSxVQUFVLEtBQUs7QUFDekUsV0FBTyxNQUFNLFdBQVcsS0FBSyxVQUFVLGdCQUFnQixDQUFDLEdBQUcsS0FBSztBQUNoRSxXQUFPLE1BQU0sV0FBVyxLQUFLLFVBQVUsWUFBWSxDQUFDLEdBQUcsS0FBSztBQUc1RCxVQUFNLGNBQWMsYUFBYSxLQUFLLFVBQVUsYUFBYSxHQUFHLE9BQU87QUFDdkUsV0FBTyxNQUFNLGFBQWEsZ0JBQWdCO0FBQzFDLFdBQU8sTUFBTSxhQUFhLGdCQUFnQjtBQUcxQyxVQUFNLGlCQUFpQjtBQUFBLE1BQ3JCLEtBQUssTUFBTSxRQUFRLGNBQWMsUUFBUSxpQkFBaUI7QUFBQSxNQUMxRDtBQUFBLElBQ0Y7QUFDQSxXQUFPLE1BQU0sZ0JBQWdCLGdCQUFnQjtBQUc3QyxXQUFPLE1BQU0sY0FBYyxDQUFDLEdBQUcsT0FBTyxTQUFTO0FBQy9DLFdBQU8sTUFBTSxjQUFjLENBQUMsR0FBRyxXQUFXLElBQUksdUJBQXVCO0FBQUEsRUFDdkUsVUFBRTtBQUNBLGtCQUFjO0FBQ2QsV0FBTyxNQUFNLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsRUFDL0M7QUFDRixDQUFDO0FBRUQsS0FBSywwREFBMEQsWUFBWTtBQUN6RSxRQUFNLE9BQU8sWUFBWSwwQkFBMEI7QUFDbkQsTUFBSTtBQUNGLGlCQUFhLFVBQVU7QUFDdkIsb0JBQWdCLEVBQUUsSUFBSSxRQUFRLE9BQU8sUUFBUSxRQUFRLFNBQVMsQ0FBQztBQUUvRCxVQUFNLEVBQUUsZUFBZSxJQUFJLElBQUksUUFBUTtBQUN2QyxVQUFNLGlCQUFpQixvQkFBb0IsS0FBSyxDQUFDLEdBQVUsSUFBSTtBQUMvRCxXQUFPLE1BQU0sY0FBYyxDQUFDLEdBQUcsT0FBTyxPQUFPO0FBQzdDLFdBQU8sTUFBTSxjQUFjLENBQUMsR0FBRyxXQUFXLElBQUksV0FBVztBQUFBLEVBQzNELFVBQUU7QUFDQSxrQkFBYztBQUNkLFdBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQy9DO0FBQ0YsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
