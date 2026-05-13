import { createTestContext } from "./test-helpers.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  openDatabase,
  closeDatabase,
  _getAdapter,
  insertMilestone,
  insertSlice,
  insertTask,
  updateTaskStatus,
  getTask,
  getSliceTasks,
  insertVerificationEvidence,
  SCHEMA_VERSION
} from "../gsd-db.js";
import { handleCompleteTask } from "../tools/complete-task.js";
const { assertEq, assertTrue, assertMatch, report } = createTestContext();
function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-complete-task-"));
  return path.join(dir, "test.db");
}
function cleanup(dbPath) {
  closeDatabase();
  try {
    const dir = path.dirname(dbPath);
    for (const f of fs.readdirSync(dir)) {
      fs.unlinkSync(path.join(dir, f));
    }
    fs.rmdirSync(dir);
  } catch {
  }
}
function cleanupDir(dirPath) {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
  }
}
function createTempProject() {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-handler-"));
  const tasksDir = path.join(basePath, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  const planPath = path.join(basePath, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md");
  fs.writeFileSync(planPath, `# S01: Test Slice

## Tasks

- [ ] **T01: Test task** \`est:30m\`
  - Do: Implement the thing
  - Verify: Run tests

- [ ] **T02: Second task** \`est:1h\`
  - Do: Implement more
  - Verify: Run more tests
`);
  return { basePath, planPath };
}
function makeValidParams() {
  return {
    taskId: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    oneLiner: "Added test functionality",
    narrative: "Implemented the test feature with full coverage.",
    verification: "Ran npm run test:unit \u2014 all tests pass.",
    deviations: "None.",
    knownIssues: "None.",
    keyFiles: ["src/test.ts", "src/test.test.ts"],
    keyDecisions: ["D001"],
    blockerDiscovered: false,
    verificationEvidence: [
      {
        command: "npm run test:unit",
        exitCode: 0,
        verdict: "\u2705 pass",
        durationMs: 5e3
      }
    ]
  };
}
console.log("\n=== complete-task: fresh DB migrates to current schema version ===");
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);
  const adapter = _getAdapter();
  const versionRow = adapter.prepare("SELECT MAX(version) as v FROM schema_version").get();
  assertEq(versionRow?.["v"], SCHEMA_VERSION, "fresh DB should be migrated to current SCHEMA_VERSION");
  const tables = adapter.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all();
  const tableNames = tables.map((t) => t["name"]);
  assertTrue(tableNames.includes("milestones"), "milestones table should exist");
  assertTrue(tableNames.includes("slices"), "slices table should exist");
  assertTrue(tableNames.includes("tasks"), "tasks table should exist");
  assertTrue(tableNames.includes("verification_evidence"), "verification_evidence table should exist");
  cleanup(dbPath);
}
console.log("\n=== complete-task: accessor CRUD ===");
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);
  insertMilestone({ id: "M001", title: "Test Milestone" });
  const adapter = _getAdapter();
  const mRow = adapter.prepare("SELECT * FROM milestones WHERE id = 'M001'").get();
  assertEq(mRow?.["id"], "M001", "milestone id should be M001");
  assertEq(mRow?.["title"], "Test Milestone", "milestone title should match");
  insertSlice({ id: "S01", milestoneId: "M001", title: "Test Slice", risk: "high" });
  const sRow = adapter.prepare("SELECT * FROM slices WHERE id = 'S01' AND milestone_id = 'M001'").get();
  assertEq(sRow?.["id"], "S01", "slice id should be S01");
  assertEq(sRow?.["risk"], "high", "slice risk should be high");
  insertTask({
    id: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    title: "Test Task",
    status: "complete",
    oneLiner: "Did the thing",
    narrative: "Full story here.",
    verificationResult: "passed",
    duration: "30m",
    blockerDiscovered: false,
    deviations: "None",
    knownIssues: "None",
    keyFiles: ["file1.ts", "file2.ts"],
    keyDecisions: ["D001"],
    fullSummaryMd: "# Summary"
  });
  const task = getTask("M001", "S01", "T01");
  assertTrue(task !== null, "task should not be null");
  assertEq(task.id, "T01", "task id");
  assertEq(task.slice_id, "S01", "task slice_id");
  assertEq(task.milestone_id, "M001", "task milestone_id");
  assertEq(task.title, "Test Task", "task title");
  assertEq(task.status, "complete", "task status");
  assertEq(task.one_liner, "Did the thing", "task one_liner");
  assertEq(task.narrative, "Full story here.", "task narrative");
  assertEq(task.verification_result, "passed", "task verification_result");
  assertEq(task.blocker_discovered, false, "task blocker_discovered");
  assertEq(task.key_files, ["file1.ts", "file2.ts"], "task key_files JSON round-trip");
  assertEq(task.key_decisions, ["D001"], "task key_decisions JSON round-trip");
  assertEq(task.full_summary_md, "# Summary", "task full_summary_md");
  const noTask = getTask("M001", "S01", "T99");
  assertEq(noTask, null, "non-existent task should return null");
  insertVerificationEvidence({
    taskId: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    command: "npm test",
    exitCode: 0,
    verdict: "\u2705 pass",
    durationMs: 3e3
  });
  const evRows = adapter.prepare(
    "SELECT * FROM verification_evidence WHERE task_id = 'T01' AND slice_id = 'S01' AND milestone_id = 'M001'"
  ).all();
  assertEq(evRows.length, 1, "should have 1 verification evidence row");
  assertEq(evRows[0]["command"], "npm test", "evidence command");
  assertEq(evRows[0]["exit_code"], 0, "evidence exit_code");
  assertEq(evRows[0]["verdict"], "\u2705 pass", "evidence verdict");
  assertEq(evRows[0]["duration_ms"], 3e3, "evidence duration_ms");
  const sliceTasks = getSliceTasks("M001", "S01");
  assertEq(sliceTasks.length, 1, "getSliceTasks should return 1 task");
  assertEq(sliceTasks[0].id, "T01", "getSliceTasks first task id");
  updateTaskStatus("M001", "S01", "T01", "failed", (/* @__PURE__ */ new Date()).toISOString());
  const updatedTask = getTask("M001", "S01", "T01");
  assertEq(updatedTask.status, "failed", "task status should be updated to failed");
  assertTrue(updatedTask.completed_at !== null, "completed_at should be set after status update");
  cleanup(dbPath);
}
console.log("\n=== complete-task: accessor stale-state error ===");
{
  closeDatabase();
  let threw = false;
  try {
    insertMilestone({ id: "M001" });
  } catch (err) {
    threw = true;
    assertTrue(
      err.code === "GSD_STALE_STATE" || err.message.includes("No database open"),
      "should throw GSD_STALE_STATE when no DB open"
    );
  }
  assertTrue(threw, "insertMilestone should throw when no DB open");
  threw = false;
  try {
    insertSlice({ id: "S01", milestoneId: "M001" });
  } catch (err) {
    threw = true;
    assertTrue(
      err.code === "GSD_STALE_STATE" || err.message.includes("No database open"),
      "insertSlice should throw GSD_STALE_STATE"
    );
  }
  assertTrue(threw, "insertSlice should throw when no DB open");
  threw = false;
  try {
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001" });
  } catch (err) {
    threw = true;
    assertTrue(
      err.code === "GSD_STALE_STATE" || err.message.includes("No database open"),
      "insertTask should throw GSD_STALE_STATE"
    );
  }
  assertTrue(threw, "insertTask should throw when no DB open");
  threw = false;
  try {
    insertVerificationEvidence({
      taskId: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      command: "test",
      exitCode: 0,
      verdict: "pass",
      durationMs: 0
    });
  } catch (err) {
    threw = true;
    assertTrue(
      err.code === "GSD_STALE_STATE" || err.message.includes("No database open"),
      "insertVerificationEvidence should throw GSD_STALE_STATE"
    );
  }
  assertTrue(threw, "insertVerificationEvidence should throw when no DB open");
}
console.log("\n=== complete-task: handler happy path ===");
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);
  const { basePath, planPath } = createTempProject();
  insertMilestone({ id: "M001", title: "Test Milestone" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Test Slice" });
  insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", status: "pending", title: "Second task" });
  const params = makeValidParams();
  const result = await handleCompleteTask(params, basePath);
  assertTrue(!("error" in result), "handler should succeed without error");
  if (!("error" in result)) {
    assertEq(result.taskId, "T01", "result taskId");
    assertEq(result.sliceId, "S01", "result sliceId");
    assertEq(result.milestoneId, "M001", "result milestoneId");
    assertTrue(result.summaryPath.endsWith("T01-SUMMARY.md"), "summaryPath should end with T01-SUMMARY.md");
    const task = getTask("M001", "S01", "T01");
    assertTrue(task !== null, "task should exist in DB after handler");
    assertEq(task.status, "complete", "task status should be complete");
    assertEq(task.one_liner, "Added test functionality", "task one_liner in DB");
    assertEq(task.key_files, ["src/test.ts", "src/test.test.ts"], "task key_files in DB");
    const adapter = _getAdapter();
    const evRows = adapter.prepare(
      "SELECT * FROM verification_evidence WHERE task_id = 'T01' AND milestone_id = 'M001'"
    ).all();
    assertEq(evRows.length, 1, "should have 1 verification evidence row after handler");
    assertEq(evRows[0]["command"], "npm run test:unit", "evidence command from handler");
    assertTrue(fs.existsSync(result.summaryPath), "summary file should exist on disk");
    const summaryContent = fs.readFileSync(result.summaryPath, "utf-8");
    assertMatch(summaryContent, /^---\n/, "summary should start with YAML frontmatter");
    assertMatch(summaryContent, /id: T01/, "summary should contain id: T01");
    assertMatch(summaryContent, /parent: S01/, "summary should contain parent: S01");
    assertMatch(summaryContent, /milestone: M001/, "summary should contain milestone: M001");
    assertMatch(summaryContent, /blocker_discovered: false/, "summary should contain blocker_discovered");
    assertMatch(summaryContent, /# T01:/, "summary should have H1 with task ID");
    assertMatch(summaryContent, /\*\*Added test functionality\*\*/, "summary should have one-liner in bold");
    assertMatch(summaryContent, /## What Happened/, "summary should have What Happened section");
    assertMatch(summaryContent, /## Verification Evidence/, "summary should have Verification Evidence section");
    assertMatch(summaryContent, /npm run test:unit/, "summary evidence should contain command");
    const planContent = fs.readFileSync(planPath, "utf-8");
    assertMatch(planContent, /\[x\]\s+\*\*T01:/, "T01 should be checked in plan");
    assertMatch(planContent, /\[ \]\s+\*\*T02:/, "T02 should still be unchecked in plan");
    const taskAfter = getTask("M001", "S01", "T01");
    assertTrue(taskAfter.full_summary_md.length > 0, "full_summary_md should be non-empty in DB");
    assertMatch(taskAfter.full_summary_md, /id: T01/, "full_summary_md should contain frontmatter");
  }
  cleanupDir(basePath);
  cleanup(dbPath);
}
console.log("\n=== complete-task: handler validation errors ===");
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);
  const params = makeValidParams();
  const r1 = await handleCompleteTask({ ...params, taskId: "" }, "/tmp/fake");
  assertTrue("error" in r1, "should return error for empty taskId");
  if ("error" in r1) {
    assertMatch(r1.error, /taskId/, "error should mention taskId");
  }
  const r2 = await handleCompleteTask({ ...params, milestoneId: "" }, "/tmp/fake");
  assertTrue("error" in r2, "should return error for empty milestoneId");
  if ("error" in r2) {
    assertMatch(r2.error, /milestoneId/, "error should mention milestoneId");
  }
  const r3 = await handleCompleteTask({ ...params, sliceId: "" }, "/tmp/fake");
  assertTrue("error" in r3, "should return error for empty sliceId");
  if ("error" in r3) {
    assertMatch(r3.error, /sliceId/, "error should mention sliceId");
  }
  cleanup(dbPath);
}
console.log("\n=== complete-task: handler idempotency ===");
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);
  const { basePath, planPath } = createTempProject();
  insertMilestone({ id: "M001", title: "Test Milestone" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Test Slice" });
  const params = makeValidParams();
  const r1 = await handleCompleteTask(params, basePath);
  assertTrue(!("error" in r1), "first call should succeed");
  const tasks = getSliceTasks("M001", "S01");
  assertEq(tasks.length, 1, "should only have the completed DB task after first call");
  assertEq(tasks.filter((t) => t.id === "T01").length, 1, "should have exactly one T01 row after first call");
  const r2 = await handleCompleteTask(params, basePath);
  assertTrue("error" in r2, "second call should return error (task already complete)");
  if ("error" in r2) {
    assertMatch(r2.error, /already complete/, "error should mention already complete");
  }
  const tasksAfter = getSliceTasks("M001", "S01");
  assertEq(tasksAfter.length, 1, "should still only have T01 after rejected second call");
  assertEq(tasksAfter.filter((t) => t.id === "T01").length, 1, "should still have exactly one T01 row");
  cleanupDir(basePath);
  cleanup(dbPath);
}
console.log("\n=== complete-task: handler with missing plan file ===");
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-no-plan-"));
  const tasksDir = path.join(basePath, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  insertMilestone({ id: "M001", title: "Test Milestone" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Test Slice" });
  const params = makeValidParams();
  const result = await handleCompleteTask(params, basePath);
  assertTrue(!("error" in result), "handler should succeed without plan file");
  if (!("error" in result)) {
    assertTrue(fs.existsSync(result.summaryPath), "summary should be written even without plan file");
    const planPath = path.join(basePath, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md");
    assertTrue(fs.existsSync(planPath), "missing plan projection should be regenerated from DB");
    assertTrue(fs.readFileSync(planPath, "utf-8").includes("[x] **T01:"), "regenerated plan should reflect DB task completion");
  }
  cleanupDir(basePath);
  cleanup(dbPath);
}
console.log("\n=== complete-task: minimal params (no keyFiles, keyDecisions, verificationEvidence, blockerDiscovered) ===");
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);
  const { basePath, planPath } = createTempProject();
  insertMilestone({ id: "M001", title: "Test Milestone" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Test Slice" });
  const minimalParams = {
    taskId: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    oneLiner: "Basic task",
    narrative: "Did the work.",
    verification: "Looks good."
    // keyFiles, keyDecisions, verificationEvidence, blockerDiscovered intentionally omitted
  };
  const result = await handleCompleteTask(minimalParams, basePath);
  assertTrue(!("error" in result), "handler should not crash with minimal params (no optional fields)");
  if (!("error" in result)) {
    assertTrue(fs.existsSync(result.summaryPath), "summary file should be written with minimal params");
    const summaryContent = fs.readFileSync(result.summaryPath, "utf-8");
    assertMatch(summaryContent, /blocker_discovered:\s*false/, "blocker_discovered should default to false");
    assertMatch(summaryContent, /key_files:\s*\[\]/, "key_files should render as an empty frontmatter list");
    assertMatch(summaryContent, /key_decisions:\s*\[\]/, "key_decisions should render as an empty frontmatter list");
    assertTrue(!summaryContent.includes("  - (none)"), "empty frontmatter lists should not render (none) as a list item");
  }
  cleanupDir(basePath);
  cleanup(dbPath);
}
report();
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jb21wbGV0ZS10YXNrLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IGNyZWF0ZVRlc3RDb250ZXh0IH0gZnJvbSAnLi90ZXN0LWhlbHBlcnMudHMnO1xuaW1wb3J0ICogYXMgZnMgZnJvbSAnbm9kZTpmcyc7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gJ25vZGU6cGF0aCc7XG5pbXBvcnQgKiBhcyBvcyBmcm9tICdub2RlOm9zJztcbmltcG9ydCB7XG4gIG9wZW5EYXRhYmFzZSxcbiAgY2xvc2VEYXRhYmFzZSxcbiAgdHJhbnNhY3Rpb24sXG4gIF9nZXRBZGFwdGVyLFxuICBpbnNlcnRNaWxlc3RvbmUsXG4gIGluc2VydFNsaWNlLFxuICBpbnNlcnRUYXNrLFxuICB1cGRhdGVUYXNrU3RhdHVzLFxuICBnZXRUYXNrLFxuICBnZXRTbGljZVRhc2tzLFxuICBpbnNlcnRWZXJpZmljYXRpb25FdmlkZW5jZSxcbiAgU0NIRU1BX1ZFUlNJT04sXG59IGZyb20gJy4uL2dzZC1kYi50cyc7XG5pbXBvcnQgeyBoYW5kbGVDb21wbGV0ZVRhc2sgfSBmcm9tICcuLi90b29scy9jb21wbGV0ZS10YXNrLnRzJztcblxuY29uc3QgeyBhc3NlcnRFcSwgYXNzZXJ0VHJ1ZSwgYXNzZXJ0TWF0Y2gsIHJlcG9ydCB9ID0gY3JlYXRlVGVzdENvbnRleHQoKTtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBIZWxwZXJzXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuZnVuY3Rpb24gdGVtcERiUGF0aCgpOiBzdHJpbmcge1xuICBjb25zdCBkaXIgPSBmcy5ta2R0ZW1wU3luYyhwYXRoLmpvaW4ob3MudG1wZGlyKCksICdnc2QtY29tcGxldGUtdGFzay0nKSk7XG4gIHJldHVybiBwYXRoLmpvaW4oZGlyLCAndGVzdC5kYicpO1xufVxuXG5mdW5jdGlvbiBjbGVhbnVwKGRiUGF0aDogc3RyaW5nKTogdm9pZCB7XG4gIGNsb3NlRGF0YWJhc2UoKTtcbiAgdHJ5IHtcbiAgICBjb25zdCBkaXIgPSBwYXRoLmRpcm5hbWUoZGJQYXRoKTtcbiAgICBmb3IgKGNvbnN0IGYgb2YgZnMucmVhZGRpclN5bmMoZGlyKSkge1xuICAgICAgZnMudW5saW5rU3luYyhwYXRoLmpvaW4oZGlyLCBmKSk7XG4gICAgfVxuICAgIGZzLnJtZGlyU3luYyhkaXIpO1xuICB9IGNhdGNoIHtcbiAgICAvLyBiZXN0IGVmZm9ydFxuICB9XG59XG5cbmZ1bmN0aW9uIGNsZWFudXBEaXIoZGlyUGF0aDogc3RyaW5nKTogdm9pZCB7XG4gIHRyeSB7XG4gICAgZnMucm1TeW5jKGRpclBhdGgsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gYmVzdCBlZmZvcnRcbiAgfVxufVxuXG4vKipcbiAqIENyZWF0ZSBhIHRlbXAgcHJvamVjdCBkaXJlY3Rvcnkgd2l0aCAuZ3NkIHN0cnVjdHVyZSBmb3IgaGFuZGxlciB0ZXN0cy5cbiAqL1xuZnVuY3Rpb24gY3JlYXRlVGVtcFByb2plY3QoKTogeyBiYXNlUGF0aDogc3RyaW5nOyBwbGFuUGF0aDogc3RyaW5nIH0ge1xuICBjb25zdCBiYXNlUGF0aCA9IGZzLm1rZHRlbXBTeW5jKHBhdGguam9pbihvcy50bXBkaXIoKSwgJ2dzZC1oYW5kbGVyLScpKTtcbiAgY29uc3QgdGFza3NEaXIgPSBwYXRoLmpvaW4oYmFzZVBhdGgsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScsICdzbGljZXMnLCAnUzAxJywgJ3Rhc2tzJyk7XG4gIGZzLm1rZGlyU3luYyh0YXNrc0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgY29uc3QgcGxhblBhdGggPSBwYXRoLmpvaW4oYmFzZVBhdGgsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScsICdzbGljZXMnLCAnUzAxJywgJ1MwMS1QTEFOLm1kJyk7XG4gIGZzLndyaXRlRmlsZVN5bmMocGxhblBhdGgsIGAjIFMwMTogVGVzdCBTbGljZVxuXG4jIyBUYXNrc1xuXG4tIFsgXSAqKlQwMTogVGVzdCB0YXNrKiogXFxgZXN0OjMwbVxcYFxuICAtIERvOiBJbXBsZW1lbnQgdGhlIHRoaW5nXG4gIC0gVmVyaWZ5OiBSdW4gdGVzdHNcblxuLSBbIF0gKipUMDI6IFNlY29uZCB0YXNrKiogXFxgZXN0OjFoXFxgXG4gIC0gRG86IEltcGxlbWVudCBtb3JlXG4gIC0gVmVyaWZ5OiBSdW4gbW9yZSB0ZXN0c1xuYCk7XG5cbiAgcmV0dXJuIHsgYmFzZVBhdGgsIHBsYW5QYXRoIH07XG59XG5cbmZ1bmN0aW9uIG1ha2VWYWxpZFBhcmFtcygpIHtcbiAgcmV0dXJuIHtcbiAgICB0YXNrSWQ6ICdUMDEnLFxuICAgIHNsaWNlSWQ6ICdTMDEnLFxuICAgIG1pbGVzdG9uZUlkOiAnTTAwMScsXG4gICAgb25lTGluZXI6ICdBZGRlZCB0ZXN0IGZ1bmN0aW9uYWxpdHknLFxuICAgIG5hcnJhdGl2ZTogJ0ltcGxlbWVudGVkIHRoZSB0ZXN0IGZlYXR1cmUgd2l0aCBmdWxsIGNvdmVyYWdlLicsXG4gICAgdmVyaWZpY2F0aW9uOiAnUmFuIG5wbSBydW4gdGVzdDp1bml0IFx1MjAxNCBhbGwgdGVzdHMgcGFzcy4nLFxuICAgIGRldmlhdGlvbnM6ICdOb25lLicsXG4gICAga25vd25Jc3N1ZXM6ICdOb25lLicsXG4gICAga2V5RmlsZXM6IFsnc3JjL3Rlc3QudHMnLCAnc3JjL3Rlc3QudGVzdC50cyddLFxuICAgIGtleURlY2lzaW9uczogWydEMDAxJ10sXG4gICAgYmxvY2tlckRpc2NvdmVyZWQ6IGZhbHNlLFxuICAgIHZlcmlmaWNhdGlvbkV2aWRlbmNlOiBbXG4gICAgICB7XG4gICAgICAgIGNvbW1hbmQ6ICducG0gcnVuIHRlc3Q6dW5pdCcsXG4gICAgICAgIGV4aXRDb2RlOiAwLFxuICAgICAgICB2ZXJkaWN0OiAnXHUyNzA1IHBhc3MnLFxuICAgICAgICBkdXJhdGlvbk1zOiA1MDAwLFxuICAgICAgfSxcbiAgICBdLFxuICB9O1xufVxuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIGNvbXBsZXRlLXRhc2s6IEZyZXNoIERCIGlzIG1pZ3JhdGVkIHRvIHRoZSBjdXJyZW50IHNjaGVtYSB2ZXJzaW9uXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuY29uc29sZS5sb2coJ1xcbj09PSBjb21wbGV0ZS10YXNrOiBmcmVzaCBEQiBtaWdyYXRlcyB0byBjdXJyZW50IHNjaGVtYSB2ZXJzaW9uID09PScpO1xue1xuICBjb25zdCBkYlBhdGggPSB0ZW1wRGJQYXRoKCk7XG4gIG9wZW5EYXRhYmFzZShkYlBhdGgpO1xuXG4gIGNvbnN0IGFkYXB0ZXIgPSBfZ2V0QWRhcHRlcigpITtcblxuICAvLyBWZXJpZnkgc2NoZW1hIHZlcnNpb24gbWF0Y2hlcyB0aGUgY3VycmVudCBzb3VyY2Utb2YtdHJ1dGggY29uc3RhbnQuXG4gIC8vIEFzc2VydGluZyBhZ2FpbnN0IFNDSEVNQV9WRVJTSU9OIChub3QgYSBoYXJkY29kZWQgbnVtYmVyKSBrZWVwcyB0aGlzXG4gIC8vIGdyZWVuIGFjcm9zcyBtaWdyYXRpb24gYnVtcHMgd2hpbGUgc3RpbGwgY2F0Y2hpbmcgYVxuICAvLyBcImZyZXNoLURCLXdhcy1ub3QtbWlncmF0ZWRcIiByZWdyZXNzaW9uLlxuICBjb25zdCB2ZXJzaW9uUm93ID0gYWRhcHRlci5wcmVwYXJlKCdTRUxFQ1QgTUFYKHZlcnNpb24pIGFzIHYgRlJPTSBzY2hlbWFfdmVyc2lvbicpLmdldCgpO1xuICBhc3NlcnRFcSh2ZXJzaW9uUm93Py5bJ3YnXSwgU0NIRU1BX1ZFUlNJT04sICdmcmVzaCBEQiBzaG91bGQgYmUgbWlncmF0ZWQgdG8gY3VycmVudCBTQ0hFTUFfVkVSU0lPTicpO1xuXG4gIC8vIFZlcmlmeSBhbGwgNCBuZXcgdGFibGVzIGV4aXN0XG4gIGNvbnN0IHRhYmxlcyA9IGFkYXB0ZXIucHJlcGFyZShcbiAgICBcIlNFTEVDVCBuYW1lIEZST00gc3FsaXRlX21hc3RlciBXSEVSRSB0eXBlPSd0YWJsZScgT1JERVIgQlkgbmFtZVwiXG4gICkuYWxsKCk7XG4gIGNvbnN0IHRhYmxlTmFtZXMgPSB0YWJsZXMubWFwKHQgPT4gdFsnbmFtZSddIGFzIHN0cmluZyk7XG4gIGFzc2VydFRydWUodGFibGVOYW1lcy5pbmNsdWRlcygnbWlsZXN0b25lcycpLCAnbWlsZXN0b25lcyB0YWJsZSBzaG91bGQgZXhpc3QnKTtcbiAgYXNzZXJ0VHJ1ZSh0YWJsZU5hbWVzLmluY2x1ZGVzKCdzbGljZXMnKSwgJ3NsaWNlcyB0YWJsZSBzaG91bGQgZXhpc3QnKTtcbiAgYXNzZXJ0VHJ1ZSh0YWJsZU5hbWVzLmluY2x1ZGVzKCd0YXNrcycpLCAndGFza3MgdGFibGUgc2hvdWxkIGV4aXN0Jyk7XG4gIGFzc2VydFRydWUodGFibGVOYW1lcy5pbmNsdWRlcygndmVyaWZpY2F0aW9uX2V2aWRlbmNlJyksICd2ZXJpZmljYXRpb25fZXZpZGVuY2UgdGFibGUgc2hvdWxkIGV4aXN0Jyk7XG5cbiAgY2xlYW51cChkYlBhdGgpO1xufVxuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIGNvbXBsZXRlLXRhc2s6IEFjY2Vzc29yIENSVURcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG5jb25zb2xlLmxvZygnXFxuPT09IGNvbXBsZXRlLXRhc2s6IGFjY2Vzc29yIENSVUQgPT09Jyk7XG57XG4gIGNvbnN0IGRiUGF0aCA9IHRlbXBEYlBhdGgoKTtcbiAgb3BlbkRhdGFiYXNlKGRiUGF0aCk7XG5cbiAgLy8gSW5zZXJ0IG1pbGVzdG9uZVxuICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogJ00wMDEnLCB0aXRsZTogJ1Rlc3QgTWlsZXN0b25lJyB9KTtcbiAgY29uc3QgYWRhcHRlciA9IF9nZXRBZGFwdGVyKCkhO1xuICBjb25zdCBtUm93ID0gYWRhcHRlci5wcmVwYXJlKFwiU0VMRUNUICogRlJPTSBtaWxlc3RvbmVzIFdIRVJFIGlkID0gJ00wMDEnXCIpLmdldCgpO1xuICBhc3NlcnRFcShtUm93Py5bJ2lkJ10sICdNMDAxJywgJ21pbGVzdG9uZSBpZCBzaG91bGQgYmUgTTAwMScpO1xuICBhc3NlcnRFcShtUm93Py5bJ3RpdGxlJ10sICdUZXN0IE1pbGVzdG9uZScsICdtaWxlc3RvbmUgdGl0bGUgc2hvdWxkIG1hdGNoJyk7XG5cbiAgLy8gSW5zZXJ0IHNsaWNlXG4gIGluc2VydFNsaWNlKHsgaWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ1Rlc3QgU2xpY2UnLCByaXNrOiAnaGlnaCcgfSk7XG4gIGNvbnN0IHNSb3cgPSBhZGFwdGVyLnByZXBhcmUoXCJTRUxFQ1QgKiBGUk9NIHNsaWNlcyBXSEVSRSBpZCA9ICdTMDEnIEFORCBtaWxlc3RvbmVfaWQgPSAnTTAwMSdcIikuZ2V0KCk7XG4gIGFzc2VydEVxKHNSb3c/LlsnaWQnXSwgJ1MwMScsICdzbGljZSBpZCBzaG91bGQgYmUgUzAxJyk7XG4gIGFzc2VydEVxKHNSb3c/LlsncmlzayddLCAnaGlnaCcsICdzbGljZSByaXNrIHNob3VsZCBiZSBoaWdoJyk7XG5cbiAgLy8gSW5zZXJ0IHRhc2sgd2l0aCBhbGwgZmllbGRzXG4gIGluc2VydFRhc2soe1xuICAgIGlkOiAnVDAxJyxcbiAgICBzbGljZUlkOiAnUzAxJyxcbiAgICBtaWxlc3RvbmVJZDogJ00wMDEnLFxuICAgIHRpdGxlOiAnVGVzdCBUYXNrJyxcbiAgICBzdGF0dXM6ICdjb21wbGV0ZScsXG4gICAgb25lTGluZXI6ICdEaWQgdGhlIHRoaW5nJyxcbiAgICBuYXJyYXRpdmU6ICdGdWxsIHN0b3J5IGhlcmUuJyxcbiAgICB2ZXJpZmljYXRpb25SZXN1bHQ6ICdwYXNzZWQnLFxuICAgIGR1cmF0aW9uOiAnMzBtJyxcbiAgICBibG9ja2VyRGlzY292ZXJlZDogZmFsc2UsXG4gICAgZGV2aWF0aW9uczogJ05vbmUnLFxuICAgIGtub3duSXNzdWVzOiAnTm9uZScsXG4gICAga2V5RmlsZXM6IFsnZmlsZTEudHMnLCAnZmlsZTIudHMnXSxcbiAgICBrZXlEZWNpc2lvbnM6IFsnRDAwMSddLFxuICAgIGZ1bGxTdW1tYXJ5TWQ6ICcjIFN1bW1hcnknLFxuICB9KTtcblxuICAvLyBnZXRUYXNrIHZlcmlmaWVzIGFsbCBmaWVsZHNcbiAgY29uc3QgdGFzayA9IGdldFRhc2soJ00wMDEnLCAnUzAxJywgJ1QwMScpO1xuICBhc3NlcnRUcnVlKHRhc2sgIT09IG51bGwsICd0YXNrIHNob3VsZCBub3QgYmUgbnVsbCcpO1xuICBhc3NlcnRFcSh0YXNrIS5pZCwgJ1QwMScsICd0YXNrIGlkJyk7XG4gIGFzc2VydEVxKHRhc2shLnNsaWNlX2lkLCAnUzAxJywgJ3Rhc2sgc2xpY2VfaWQnKTtcbiAgYXNzZXJ0RXEodGFzayEubWlsZXN0b25lX2lkLCAnTTAwMScsICd0YXNrIG1pbGVzdG9uZV9pZCcpO1xuICBhc3NlcnRFcSh0YXNrIS50aXRsZSwgJ1Rlc3QgVGFzaycsICd0YXNrIHRpdGxlJyk7XG4gIGFzc2VydEVxKHRhc2shLnN0YXR1cywgJ2NvbXBsZXRlJywgJ3Rhc2sgc3RhdHVzJyk7XG4gIGFzc2VydEVxKHRhc2shLm9uZV9saW5lciwgJ0RpZCB0aGUgdGhpbmcnLCAndGFzayBvbmVfbGluZXInKTtcbiAgYXNzZXJ0RXEodGFzayEubmFycmF0aXZlLCAnRnVsbCBzdG9yeSBoZXJlLicsICd0YXNrIG5hcnJhdGl2ZScpO1xuICBhc3NlcnRFcSh0YXNrIS52ZXJpZmljYXRpb25fcmVzdWx0LCAncGFzc2VkJywgJ3Rhc2sgdmVyaWZpY2F0aW9uX3Jlc3VsdCcpO1xuICBhc3NlcnRFcSh0YXNrIS5ibG9ja2VyX2Rpc2NvdmVyZWQsIGZhbHNlLCAndGFzayBibG9ja2VyX2Rpc2NvdmVyZWQnKTtcbiAgYXNzZXJ0RXEodGFzayEua2V5X2ZpbGVzLCBbJ2ZpbGUxLnRzJywgJ2ZpbGUyLnRzJ10sICd0YXNrIGtleV9maWxlcyBKU09OIHJvdW5kLXRyaXAnKTtcbiAgYXNzZXJ0RXEodGFzayEua2V5X2RlY2lzaW9ucywgWydEMDAxJ10sICd0YXNrIGtleV9kZWNpc2lvbnMgSlNPTiByb3VuZC10cmlwJyk7XG4gIGFzc2VydEVxKHRhc2shLmZ1bGxfc3VtbWFyeV9tZCwgJyMgU3VtbWFyeScsICd0YXNrIGZ1bGxfc3VtbWFyeV9tZCcpO1xuXG4gIC8vIGdldFRhc2sgcmV0dXJucyBudWxsIGZvciBub24tZXhpc3RlbnRcbiAgY29uc3Qgbm9UYXNrID0gZ2V0VGFzaygnTTAwMScsICdTMDEnLCAnVDk5Jyk7XG4gIGFzc2VydEVxKG5vVGFzaywgbnVsbCwgJ25vbi1leGlzdGVudCB0YXNrIHNob3VsZCByZXR1cm4gbnVsbCcpO1xuXG4gIC8vIEluc2VydCB2ZXJpZmljYXRpb24gZXZpZGVuY2VcbiAgaW5zZXJ0VmVyaWZpY2F0aW9uRXZpZGVuY2Uoe1xuICAgIHRhc2tJZDogJ1QwMScsXG4gICAgc2xpY2VJZDogJ1MwMScsXG4gICAgbWlsZXN0b25lSWQ6ICdNMDAxJyxcbiAgICBjb21tYW5kOiAnbnBtIHRlc3QnLFxuICAgIGV4aXRDb2RlOiAwLFxuICAgIHZlcmRpY3Q6ICdcdTI3MDUgcGFzcycsXG4gICAgZHVyYXRpb25NczogMzAwMCxcbiAgfSk7XG4gIGNvbnN0IGV2Um93cyA9IGFkYXB0ZXIucHJlcGFyZShcbiAgICBcIlNFTEVDVCAqIEZST00gdmVyaWZpY2F0aW9uX2V2aWRlbmNlIFdIRVJFIHRhc2tfaWQgPSAnVDAxJyBBTkQgc2xpY2VfaWQgPSAnUzAxJyBBTkQgbWlsZXN0b25lX2lkID0gJ00wMDEnXCJcbiAgKS5hbGwoKTtcbiAgYXNzZXJ0RXEoZXZSb3dzLmxlbmd0aCwgMSwgJ3Nob3VsZCBoYXZlIDEgdmVyaWZpY2F0aW9uIGV2aWRlbmNlIHJvdycpO1xuICBhc3NlcnRFcShldlJvd3NbMF1bJ2NvbW1hbmQnXSwgJ25wbSB0ZXN0JywgJ2V2aWRlbmNlIGNvbW1hbmQnKTtcbiAgYXNzZXJ0RXEoZXZSb3dzWzBdWydleGl0X2NvZGUnXSwgMCwgJ2V2aWRlbmNlIGV4aXRfY29kZScpO1xuICBhc3NlcnRFcShldlJvd3NbMF1bJ3ZlcmRpY3QnXSwgJ1x1MjcwNSBwYXNzJywgJ2V2aWRlbmNlIHZlcmRpY3QnKTtcbiAgYXNzZXJ0RXEoZXZSb3dzWzBdWydkdXJhdGlvbl9tcyddLCAzMDAwLCAnZXZpZGVuY2UgZHVyYXRpb25fbXMnKTtcblxuICAvLyBnZXRTbGljZVRhc2tzIHJldHVybnMgYXJyYXlcbiAgY29uc3Qgc2xpY2VUYXNrcyA9IGdldFNsaWNlVGFza3MoJ00wMDEnLCAnUzAxJyk7XG4gIGFzc2VydEVxKHNsaWNlVGFza3MubGVuZ3RoLCAxLCAnZ2V0U2xpY2VUYXNrcyBzaG91bGQgcmV0dXJuIDEgdGFzaycpO1xuICBhc3NlcnRFcShzbGljZVRhc2tzWzBdLmlkLCAnVDAxJywgJ2dldFNsaWNlVGFza3MgZmlyc3QgdGFzayBpZCcpO1xuXG4gIC8vIHVwZGF0ZVRhc2tTdGF0dXMgY2hhbmdlcyBzdGF0dXNcbiAgdXBkYXRlVGFza1N0YXR1cygnTTAwMScsICdTMDEnLCAnVDAxJywgJ2ZhaWxlZCcsIG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSk7XG4gIGNvbnN0IHVwZGF0ZWRUYXNrID0gZ2V0VGFzaygnTTAwMScsICdTMDEnLCAnVDAxJyk7XG4gIGFzc2VydEVxKHVwZGF0ZWRUYXNrIS5zdGF0dXMsICdmYWlsZWQnLCAndGFzayBzdGF0dXMgc2hvdWxkIGJlIHVwZGF0ZWQgdG8gZmFpbGVkJyk7XG4gIGFzc2VydFRydWUodXBkYXRlZFRhc2shLmNvbXBsZXRlZF9hdCAhPT0gbnVsbCwgJ2NvbXBsZXRlZF9hdCBzaG91bGQgYmUgc2V0IGFmdGVyIHN0YXR1cyB1cGRhdGUnKTtcblxuICBjbGVhbnVwKGRiUGF0aCk7XG59XG5cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuLy8gY29tcGxldGUtdGFzazogQWNjZXNzb3Igc3RhbGUtc3RhdGUgZXJyb3Jcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG5jb25zb2xlLmxvZygnXFxuPT09IGNvbXBsZXRlLXRhc2s6IGFjY2Vzc29yIHN0YWxlLXN0YXRlIGVycm9yID09PScpO1xue1xuICAvLyBObyBEQiBvcGVuIFx1MjAxNCBhY2Nlc3NvcnMgc2hvdWxkIHRocm93IEdTRF9TVEFMRV9TVEFURVxuICBjbG9zZURhdGFiYXNlKCk7XG4gIGxldCB0aHJldyA9IGZhbHNlO1xuICB0cnkge1xuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiAnTTAwMScgfSk7XG4gIH0gY2F0Y2ggKGVycjogYW55KSB7XG4gICAgdGhyZXcgPSB0cnVlO1xuICAgIGFzc2VydFRydWUoZXJyLmNvZGUgPT09ICdHU0RfU1RBTEVfU1RBVEUnIHx8IGVyci5tZXNzYWdlLmluY2x1ZGVzKCdObyBkYXRhYmFzZSBvcGVuJyksXG4gICAgICAnc2hvdWxkIHRocm93IEdTRF9TVEFMRV9TVEFURSB3aGVuIG5vIERCIG9wZW4nKTtcbiAgfVxuICBhc3NlcnRUcnVlKHRocmV3LCAnaW5zZXJ0TWlsZXN0b25lIHNob3VsZCB0aHJvdyB3aGVuIG5vIERCIG9wZW4nKTtcblxuICB0aHJldyA9IGZhbHNlO1xuICB0cnkge1xuICAgIGluc2VydFNsaWNlKHsgaWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnIH0pO1xuICB9IGNhdGNoIChlcnI6IGFueSkge1xuICAgIHRocmV3ID0gdHJ1ZTtcbiAgICBhc3NlcnRUcnVlKGVyci5jb2RlID09PSAnR1NEX1NUQUxFX1NUQVRFJyB8fCBlcnIubWVzc2FnZS5pbmNsdWRlcygnTm8gZGF0YWJhc2Ugb3BlbicpLFxuICAgICAgJ2luc2VydFNsaWNlIHNob3VsZCB0aHJvdyBHU0RfU1RBTEVfU1RBVEUnKTtcbiAgfVxuICBhc3NlcnRUcnVlKHRocmV3LCAnaW5zZXJ0U2xpY2Ugc2hvdWxkIHRocm93IHdoZW4gbm8gREIgb3BlbicpO1xuXG4gIHRocmV3ID0gZmFsc2U7XG4gIHRyeSB7XG4gICAgaW5zZXJ0VGFzayh7IGlkOiAnVDAxJywgc2xpY2VJZDogJ1MwMScsIG1pbGVzdG9uZUlkOiAnTTAwMScgfSk7XG4gIH0gY2F0Y2ggKGVycjogYW55KSB7XG4gICAgdGhyZXcgPSB0cnVlO1xuICAgIGFzc2VydFRydWUoZXJyLmNvZGUgPT09ICdHU0RfU1RBTEVfU1RBVEUnIHx8IGVyci5tZXNzYWdlLmluY2x1ZGVzKCdObyBkYXRhYmFzZSBvcGVuJyksXG4gICAgICAnaW5zZXJ0VGFzayBzaG91bGQgdGhyb3cgR1NEX1NUQUxFX1NUQVRFJyk7XG4gIH1cbiAgYXNzZXJ0VHJ1ZSh0aHJldywgJ2luc2VydFRhc2sgc2hvdWxkIHRocm93IHdoZW4gbm8gREIgb3BlbicpO1xuXG4gIHRocmV3ID0gZmFsc2U7XG4gIHRyeSB7XG4gICAgaW5zZXJ0VmVyaWZpY2F0aW9uRXZpZGVuY2Uoe1xuICAgICAgdGFza0lkOiAnVDAxJywgc2xpY2VJZDogJ1MwMScsIG1pbGVzdG9uZUlkOiAnTTAwMScsXG4gICAgICBjb21tYW5kOiAndGVzdCcsIGV4aXRDb2RlOiAwLCB2ZXJkaWN0OiAncGFzcycsIGR1cmF0aW9uTXM6IDAsXG4gICAgfSk7XG4gIH0gY2F0Y2ggKGVycjogYW55KSB7XG4gICAgdGhyZXcgPSB0cnVlO1xuICAgIGFzc2VydFRydWUoZXJyLmNvZGUgPT09ICdHU0RfU1RBTEVfU1RBVEUnIHx8IGVyci5tZXNzYWdlLmluY2x1ZGVzKCdObyBkYXRhYmFzZSBvcGVuJyksXG4gICAgICAnaW5zZXJ0VmVyaWZpY2F0aW9uRXZpZGVuY2Ugc2hvdWxkIHRocm93IEdTRF9TVEFMRV9TVEFURScpO1xuICB9XG4gIGFzc2VydFRydWUodGhyZXcsICdpbnNlcnRWZXJpZmljYXRpb25FdmlkZW5jZSBzaG91bGQgdGhyb3cgd2hlbiBubyBEQiBvcGVuJyk7XG59XG5cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuLy8gY29tcGxldGUtdGFzazogSGFuZGxlciBoYXBweSBwYXRoXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuY29uc29sZS5sb2coJ1xcbj09PSBjb21wbGV0ZS10YXNrOiBoYW5kbGVyIGhhcHB5IHBhdGggPT09Jyk7XG57XG4gIGNvbnN0IGRiUGF0aCA9IHRlbXBEYlBhdGgoKTtcbiAgb3BlbkRhdGFiYXNlKGRiUGF0aCk7XG5cbiAgY29uc3QgeyBiYXNlUGF0aCwgcGxhblBhdGggfSA9IGNyZWF0ZVRlbXBQcm9qZWN0KCk7XG5cbiAgLy8gU2VlZCBtaWxlc3RvbmUgKyBzbGljZSArIGJvdGggdGFza3Mgc28gcHJvamVjdGlvbiByZW5kZXJzIFQwMSAoW3hdKSBhbmQgVDAyIChbIF0pXG4gIGluc2VydE1pbGVzdG9uZSh7IGlkOiAnTTAwMScsIHRpdGxlOiAnVGVzdCBNaWxlc3RvbmUnIH0pO1xuICBpbnNlcnRTbGljZSh7IGlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdUZXN0IFNsaWNlJyB9KTtcbiAgaW5zZXJ0VGFzayh7IGlkOiAnVDAyJywgc2xpY2VJZDogJ1MwMScsIG1pbGVzdG9uZUlkOiAnTTAwMScsIHN0YXR1czogJ3BlbmRpbmcnLCB0aXRsZTogJ1NlY29uZCB0YXNrJyB9KTtcblxuICBjb25zdCBwYXJhbXMgPSBtYWtlVmFsaWRQYXJhbXMoKTtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlQ29tcGxldGVUYXNrKHBhcmFtcywgYmFzZVBhdGgpO1xuXG4gIGFzc2VydFRydWUoISgnZXJyb3InIGluIHJlc3VsdCksICdoYW5kbGVyIHNob3VsZCBzdWNjZWVkIHdpdGhvdXQgZXJyb3InKTtcbiAgaWYgKCEoJ2Vycm9yJyBpbiByZXN1bHQpKSB7XG4gICAgYXNzZXJ0RXEocmVzdWx0LnRhc2tJZCwgJ1QwMScsICdyZXN1bHQgdGFza0lkJyk7XG4gICAgYXNzZXJ0RXEocmVzdWx0LnNsaWNlSWQsICdTMDEnLCAncmVzdWx0IHNsaWNlSWQnKTtcbiAgICBhc3NlcnRFcShyZXN1bHQubWlsZXN0b25lSWQsICdNMDAxJywgJ3Jlc3VsdCBtaWxlc3RvbmVJZCcpO1xuICAgIGFzc2VydFRydWUocmVzdWx0LnN1bW1hcnlQYXRoLmVuZHNXaXRoKCdUMDEtU1VNTUFSWS5tZCcpLCAnc3VtbWFyeVBhdGggc2hvdWxkIGVuZCB3aXRoIFQwMS1TVU1NQVJZLm1kJyk7XG5cbiAgICAvLyAoYSkgVmVyaWZ5IHRhc2sgcm93IGluIERCIHdpdGggc3RhdHVzICdjb21wbGV0ZSdcbiAgICBjb25zdCB0YXNrID0gZ2V0VGFzaygnTTAwMScsICdTMDEnLCAnVDAxJyk7XG4gICAgYXNzZXJ0VHJ1ZSh0YXNrICE9PSBudWxsLCAndGFzayBzaG91bGQgZXhpc3QgaW4gREIgYWZ0ZXIgaGFuZGxlcicpO1xuICAgIGFzc2VydEVxKHRhc2shLnN0YXR1cywgJ2NvbXBsZXRlJywgJ3Rhc2sgc3RhdHVzIHNob3VsZCBiZSBjb21wbGV0ZScpO1xuICAgIGFzc2VydEVxKHRhc2shLm9uZV9saW5lciwgJ0FkZGVkIHRlc3QgZnVuY3Rpb25hbGl0eScsICd0YXNrIG9uZV9saW5lciBpbiBEQicpO1xuICAgIGFzc2VydEVxKHRhc2shLmtleV9maWxlcywgWydzcmMvdGVzdC50cycsICdzcmMvdGVzdC50ZXN0LnRzJ10sICd0YXNrIGtleV9maWxlcyBpbiBEQicpO1xuXG4gICAgLy8gKGIpIFZlcmlmeSB2ZXJpZmljYXRpb25fZXZpZGVuY2Ugcm93cyBpbiBEQlxuICAgIGNvbnN0IGFkYXB0ZXIgPSBfZ2V0QWRhcHRlcigpITtcbiAgICBjb25zdCBldlJvd3MgPSBhZGFwdGVyLnByZXBhcmUoXG4gICAgICBcIlNFTEVDVCAqIEZST00gdmVyaWZpY2F0aW9uX2V2aWRlbmNlIFdIRVJFIHRhc2tfaWQgPSAnVDAxJyBBTkQgbWlsZXN0b25lX2lkID0gJ00wMDEnXCJcbiAgICApLmFsbCgpO1xuICAgIGFzc2VydEVxKGV2Um93cy5sZW5ndGgsIDEsICdzaG91bGQgaGF2ZSAxIHZlcmlmaWNhdGlvbiBldmlkZW5jZSByb3cgYWZ0ZXIgaGFuZGxlcicpO1xuICAgIGFzc2VydEVxKGV2Um93c1swXVsnY29tbWFuZCddLCAnbnBtIHJ1biB0ZXN0OnVuaXQnLCAnZXZpZGVuY2UgY29tbWFuZCBmcm9tIGhhbmRsZXInKTtcblxuICAgIC8vIChjKSBWZXJpZnkgVDAxLVNVTU1BUlkubWQgZmlsZSBvbiBkaXNrIHdpdGggY29ycmVjdCBZQU1MIGZyb250bWF0dGVyXG4gICAgYXNzZXJ0VHJ1ZShmcy5leGlzdHNTeW5jKHJlc3VsdC5zdW1tYXJ5UGF0aCksICdzdW1tYXJ5IGZpbGUgc2hvdWxkIGV4aXN0IG9uIGRpc2snKTtcbiAgICBjb25zdCBzdW1tYXJ5Q29udGVudCA9IGZzLnJlYWRGaWxlU3luYyhyZXN1bHQuc3VtbWFyeVBhdGgsICd1dGYtOCcpO1xuICAgIGFzc2VydE1hdGNoKHN1bW1hcnlDb250ZW50LCAvXi0tLVxcbi8sICdzdW1tYXJ5IHNob3VsZCBzdGFydCB3aXRoIFlBTUwgZnJvbnRtYXR0ZXInKTtcbiAgICBhc3NlcnRNYXRjaChzdW1tYXJ5Q29udGVudCwgL2lkOiBUMDEvLCAnc3VtbWFyeSBzaG91bGQgY29udGFpbiBpZDogVDAxJyk7XG4gICAgYXNzZXJ0TWF0Y2goc3VtbWFyeUNvbnRlbnQsIC9wYXJlbnQ6IFMwMS8sICdzdW1tYXJ5IHNob3VsZCBjb250YWluIHBhcmVudDogUzAxJyk7XG4gICAgYXNzZXJ0TWF0Y2goc3VtbWFyeUNvbnRlbnQsIC9taWxlc3RvbmU6IE0wMDEvLCAnc3VtbWFyeSBzaG91bGQgY29udGFpbiBtaWxlc3RvbmU6IE0wMDEnKTtcbiAgICBhc3NlcnRNYXRjaChzdW1tYXJ5Q29udGVudCwgL2Jsb2NrZXJfZGlzY292ZXJlZDogZmFsc2UvLCAnc3VtbWFyeSBzaG91bGQgY29udGFpbiBibG9ja2VyX2Rpc2NvdmVyZWQnKTtcbiAgICBhc3NlcnRNYXRjaChzdW1tYXJ5Q29udGVudCwgLyMgVDAxOi8sICdzdW1tYXJ5IHNob3VsZCBoYXZlIEgxIHdpdGggdGFzayBJRCcpO1xuICAgIGFzc2VydE1hdGNoKHN1bW1hcnlDb250ZW50LCAvXFwqXFwqQWRkZWQgdGVzdCBmdW5jdGlvbmFsaXR5XFwqXFwqLywgJ3N1bW1hcnkgc2hvdWxkIGhhdmUgb25lLWxpbmVyIGluIGJvbGQnKTtcbiAgICBhc3NlcnRNYXRjaChzdW1tYXJ5Q29udGVudCwgLyMjIFdoYXQgSGFwcGVuZWQvLCAnc3VtbWFyeSBzaG91bGQgaGF2ZSBXaGF0IEhhcHBlbmVkIHNlY3Rpb24nKTtcbiAgICBhc3NlcnRNYXRjaChzdW1tYXJ5Q29udGVudCwgLyMjIFZlcmlmaWNhdGlvbiBFdmlkZW5jZS8sICdzdW1tYXJ5IHNob3VsZCBoYXZlIFZlcmlmaWNhdGlvbiBFdmlkZW5jZSBzZWN0aW9uJyk7XG4gICAgYXNzZXJ0TWF0Y2goc3VtbWFyeUNvbnRlbnQsIC9ucG0gcnVuIHRlc3Q6dW5pdC8sICdzdW1tYXJ5IGV2aWRlbmNlIHNob3VsZCBjb250YWluIGNvbW1hbmQnKTtcblxuICAgIC8vIChkKSBWZXJpZnkgcGxhbiBjaGVja2JveCBjaGFuZ2VkIHRvIFt4XVxuICAgIGNvbnN0IHBsYW5Db250ZW50ID0gZnMucmVhZEZpbGVTeW5jKHBsYW5QYXRoLCAndXRmLTgnKTtcbiAgICBhc3NlcnRNYXRjaChwbGFuQ29udGVudCwgL1xcW3hcXF1cXHMrXFwqXFwqVDAxOi8sICdUMDEgc2hvdWxkIGJlIGNoZWNrZWQgaW4gcGxhbicpO1xuICAgIC8vIFQwMiBzaG91bGQgc3RpbGwgYmUgdW5jaGVja2VkXG4gICAgYXNzZXJ0TWF0Y2gocGxhbkNvbnRlbnQsIC9cXFsgXFxdXFxzK1xcKlxcKlQwMjovLCAnVDAyIHNob3VsZCBzdGlsbCBiZSB1bmNoZWNrZWQgaW4gcGxhbicpO1xuXG4gICAgLy8gKGUpIFZlcmlmeSBmdWxsX3N1bW1hcnlfbWQgc3RvcmVkIGluIERCIGZvciBEMDA0IHJlY292ZXJ5XG4gICAgY29uc3QgdGFza0FmdGVyID0gZ2V0VGFzaygnTTAwMScsICdTMDEnLCAnVDAxJyk7XG4gICAgYXNzZXJ0VHJ1ZSh0YXNrQWZ0ZXIhLmZ1bGxfc3VtbWFyeV9tZC5sZW5ndGggPiAwLCAnZnVsbF9zdW1tYXJ5X21kIHNob3VsZCBiZSBub24tZW1wdHkgaW4gREInKTtcbiAgICBhc3NlcnRNYXRjaCh0YXNrQWZ0ZXIhLmZ1bGxfc3VtbWFyeV9tZCwgL2lkOiBUMDEvLCAnZnVsbF9zdW1tYXJ5X21kIHNob3VsZCBjb250YWluIGZyb250bWF0dGVyJyk7XG4gIH1cblxuICBjbGVhbnVwRGlyKGJhc2VQYXRoKTtcbiAgY2xlYW51cChkYlBhdGgpO1xufVxuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIGNvbXBsZXRlLXRhc2s6IEhhbmRsZXIgdmFsaWRhdGlvbiBlcnJvcnNcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG5jb25zb2xlLmxvZygnXFxuPT09IGNvbXBsZXRlLXRhc2s6IGhhbmRsZXIgdmFsaWRhdGlvbiBlcnJvcnMgPT09Jyk7XG57XG4gIGNvbnN0IGRiUGF0aCA9IHRlbXBEYlBhdGgoKTtcbiAgb3BlbkRhdGFiYXNlKGRiUGF0aCk7XG5cbiAgY29uc3QgcGFyYW1zID0gbWFrZVZhbGlkUGFyYW1zKCk7XG5cbiAgLy8gRW1wdHkgdGFza0lkXG4gIGNvbnN0IHIxID0gYXdhaXQgaGFuZGxlQ29tcGxldGVUYXNrKHsgLi4ucGFyYW1zLCB0YXNrSWQ6ICcnIH0sICcvdG1wL2Zha2UnKTtcbiAgYXNzZXJ0VHJ1ZSgnZXJyb3InIGluIHIxLCAnc2hvdWxkIHJldHVybiBlcnJvciBmb3IgZW1wdHkgdGFza0lkJyk7XG4gIGlmICgnZXJyb3InIGluIHIxKSB7XG4gICAgYXNzZXJ0TWF0Y2gocjEuZXJyb3IsIC90YXNrSWQvLCAnZXJyb3Igc2hvdWxkIG1lbnRpb24gdGFza0lkJyk7XG4gIH1cblxuICAvLyBFbXB0eSBtaWxlc3RvbmVJZFxuICBjb25zdCByMiA9IGF3YWl0IGhhbmRsZUNvbXBsZXRlVGFzayh7IC4uLnBhcmFtcywgbWlsZXN0b25lSWQ6ICcnIH0sICcvdG1wL2Zha2UnKTtcbiAgYXNzZXJ0VHJ1ZSgnZXJyb3InIGluIHIyLCAnc2hvdWxkIHJldHVybiBlcnJvciBmb3IgZW1wdHkgbWlsZXN0b25lSWQnKTtcbiAgaWYgKCdlcnJvcicgaW4gcjIpIHtcbiAgICBhc3NlcnRNYXRjaChyMi5lcnJvciwgL21pbGVzdG9uZUlkLywgJ2Vycm9yIHNob3VsZCBtZW50aW9uIG1pbGVzdG9uZUlkJyk7XG4gIH1cblxuICAvLyBFbXB0eSBzbGljZUlkXG4gIGNvbnN0IHIzID0gYXdhaXQgaGFuZGxlQ29tcGxldGVUYXNrKHsgLi4ucGFyYW1zLCBzbGljZUlkOiAnJyB9LCAnL3RtcC9mYWtlJyk7XG4gIGFzc2VydFRydWUoJ2Vycm9yJyBpbiByMywgJ3Nob3VsZCByZXR1cm4gZXJyb3IgZm9yIGVtcHR5IHNsaWNlSWQnKTtcbiAgaWYgKCdlcnJvcicgaW4gcjMpIHtcbiAgICBhc3NlcnRNYXRjaChyMy5lcnJvciwgL3NsaWNlSWQvLCAnZXJyb3Igc2hvdWxkIG1lbnRpb24gc2xpY2VJZCcpO1xuICB9XG5cbiAgY2xlYW51cChkYlBhdGgpO1xufVxuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIGNvbXBsZXRlLXRhc2s6IEhhbmRsZXIgaWRlbXBvdGVuY3lcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG5jb25zb2xlLmxvZygnXFxuPT09IGNvbXBsZXRlLXRhc2s6IGhhbmRsZXIgaWRlbXBvdGVuY3kgPT09Jyk7XG57XG4gIGNvbnN0IGRiUGF0aCA9IHRlbXBEYlBhdGgoKTtcbiAgb3BlbkRhdGFiYXNlKGRiUGF0aCk7XG5cbiAgY29uc3QgeyBiYXNlUGF0aCwgcGxhblBhdGggfSA9IGNyZWF0ZVRlbXBQcm9qZWN0KCk7XG5cbiAgLy8gU2VlZCBtaWxlc3RvbmUgKyBzbGljZSBzbyBzdGF0ZSBtYWNoaW5lIGd1YXJkcyBwYXNzXG4gIGluc2VydE1pbGVzdG9uZSh7IGlkOiAnTTAwMScsIHRpdGxlOiAnVGVzdCBNaWxlc3RvbmUnIH0pO1xuICBpbnNlcnRTbGljZSh7IGlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgdGl0bGU6ICdUZXN0IFNsaWNlJyB9KTtcblxuICBjb25zdCBwYXJhbXMgPSBtYWtlVmFsaWRQYXJhbXMoKTtcblxuICAvLyBGaXJzdCBjYWxsIHNob3VsZCBzdWNjZWVkXG4gIGNvbnN0IHIxID0gYXdhaXQgaGFuZGxlQ29tcGxldGVUYXNrKHBhcmFtcywgYmFzZVBhdGgpO1xuICBhc3NlcnRUcnVlKCEoJ2Vycm9yJyBpbiByMSksICdmaXJzdCBjYWxsIHNob3VsZCBzdWNjZWVkJyk7XG5cbiAgLy8gVmVyaWZ5IGNvbXBsZXRlLXRhc2sgZGlkIG5vdCBkdXBsaWNhdGUgVDAxLiBTMDEtUExBTi5tZCBpcyBhIHByb2plY3Rpb24sXG4gIC8vIHNvIHRoZSByZW1haW5pbmcgcGxhbiB0YXNrIGlzIG5vdCBpbXBvcnRlZCBpbXBsaWNpdGx5LlxuICBjb25zdCB0YXNrcyA9IGdldFNsaWNlVGFza3MoJ00wMDEnLCAnUzAxJyk7XG4gIGFzc2VydEVxKHRhc2tzLmxlbmd0aCwgMSwgJ3Nob3VsZCBvbmx5IGhhdmUgdGhlIGNvbXBsZXRlZCBEQiB0YXNrIGFmdGVyIGZpcnN0IGNhbGwnKTtcbiAgYXNzZXJ0RXEodGFza3MuZmlsdGVyKHQgPT4gdC5pZCA9PT0gJ1QwMScpLmxlbmd0aCwgMSwgJ3Nob3VsZCBoYXZlIGV4YWN0bHkgb25lIFQwMSByb3cgYWZ0ZXIgZmlyc3QgY2FsbCcpO1xuXG4gIC8vIFNlY29uZCBjYWxsIHdpdGggc2FtZSBwYXJhbXMgXHUyMDE0IHN0YXRlIG1hY2hpbmUgZ3VhcmQgcmVqZWN0cyAodGFzayBpcyBhbHJlYWR5IGNvbXBsZXRlKVxuICBjb25zdCByMiA9IGF3YWl0IGhhbmRsZUNvbXBsZXRlVGFzayhwYXJhbXMsIGJhc2VQYXRoKTtcbiAgYXNzZXJ0VHJ1ZSgnZXJyb3InIGluIHIyLCAnc2Vjb25kIGNhbGwgc2hvdWxkIHJldHVybiBlcnJvciAodGFzayBhbHJlYWR5IGNvbXBsZXRlKScpO1xuICBpZiAoJ2Vycm9yJyBpbiByMikge1xuICAgIGFzc2VydE1hdGNoKHIyLmVycm9yLCAvYWxyZWFkeSBjb21wbGV0ZS8sICdlcnJvciBzaG91bGQgbWVudGlvbiBhbHJlYWR5IGNvbXBsZXRlJyk7XG4gIH1cblxuICAvLyBTdGlsbCBubyBkdXBsaWNhdGUgcm93cyBmcm9tIHRoZSByZWplY3RlZCBzZWNvbmQgY2FsbC5cbiAgY29uc3QgdGFza3NBZnRlciA9IGdldFNsaWNlVGFza3MoJ00wMDEnLCAnUzAxJyk7XG4gIGFzc2VydEVxKHRhc2tzQWZ0ZXIubGVuZ3RoLCAxLCAnc2hvdWxkIHN0aWxsIG9ubHkgaGF2ZSBUMDEgYWZ0ZXIgcmVqZWN0ZWQgc2Vjb25kIGNhbGwnKTtcbiAgYXNzZXJ0RXEodGFza3NBZnRlci5maWx0ZXIodCA9PiB0LmlkID09PSAnVDAxJykubGVuZ3RoLCAxLCAnc2hvdWxkIHN0aWxsIGhhdmUgZXhhY3RseSBvbmUgVDAxIHJvdycpO1xuXG4gIGNsZWFudXBEaXIoYmFzZVBhdGgpO1xuICBjbGVhbnVwKGRiUGF0aCk7XG59XG5cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuLy8gY29tcGxldGUtdGFzazogSGFuZGxlciB3aXRoIG1pc3NpbmcgcGxhbiBmaWxlIChncmFjZWZ1bClcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG5jb25zb2xlLmxvZygnXFxuPT09IGNvbXBsZXRlLXRhc2s6IGhhbmRsZXIgd2l0aCBtaXNzaW5nIHBsYW4gZmlsZSA9PT0nKTtcbntcbiAgY29uc3QgZGJQYXRoID0gdGVtcERiUGF0aCgpO1xuICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcblxuICAvLyBDcmVhdGUgYSB0ZW1wIGRpciBXSVRIT1VUIGEgcGxhbiBmaWxlXG4gIGNvbnN0IGJhc2VQYXRoID0gZnMubWtkdGVtcFN5bmMocGF0aC5qb2luKG9zLnRtcGRpcigpLCAnZ3NkLW5vLXBsYW4tJykpO1xuICBjb25zdCB0YXNrc0RpciA9IHBhdGguam9pbihiYXNlUGF0aCwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJywgJ3NsaWNlcycsICdTMDEnLCAndGFza3MnKTtcbiAgZnMubWtkaXJTeW5jKHRhc2tzRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAvLyBTZWVkIG1pbGVzdG9uZSArIHNsaWNlIHNvIHN0YXRlIG1hY2hpbmUgZ3VhcmRzIHBhc3NcbiAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdUZXN0IE1pbGVzdG9uZScgfSk7XG4gIGluc2VydFNsaWNlKHsgaWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ1Rlc3QgU2xpY2UnIH0pO1xuXG4gIGNvbnN0IHBhcmFtcyA9IG1ha2VWYWxpZFBhcmFtcygpO1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVDb21wbGV0ZVRhc2socGFyYW1zLCBiYXNlUGF0aCk7XG5cbiAgLy8gU2hvdWxkIHN1Y2NlZWQgYW5kIHJlZ2VuZXJhdGUgdGhlIG1pc3NpbmcgcGxhbiBwcm9qZWN0aW9uIGZyb20gREIuXG4gIGFzc2VydFRydWUoISgnZXJyb3InIGluIHJlc3VsdCksICdoYW5kbGVyIHNob3VsZCBzdWNjZWVkIHdpdGhvdXQgcGxhbiBmaWxlJyk7XG4gIGlmICghKCdlcnJvcicgaW4gcmVzdWx0KSkge1xuICAgIGFzc2VydFRydWUoZnMuZXhpc3RzU3luYyhyZXN1bHQuc3VtbWFyeVBhdGgpLCAnc3VtbWFyeSBzaG91bGQgYmUgd3JpdHRlbiBldmVuIHdpdGhvdXQgcGxhbiBmaWxlJyk7XG4gICAgY29uc3QgcGxhblBhdGggPSBwYXRoLmpvaW4oYmFzZVBhdGgsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScsICdzbGljZXMnLCAnUzAxJywgJ1MwMS1QTEFOLm1kJyk7XG4gICAgYXNzZXJ0VHJ1ZShmcy5leGlzdHNTeW5jKHBsYW5QYXRoKSwgJ21pc3NpbmcgcGxhbiBwcm9qZWN0aW9uIHNob3VsZCBiZSByZWdlbmVyYXRlZCBmcm9tIERCJyk7XG4gICAgYXNzZXJ0VHJ1ZShmcy5yZWFkRmlsZVN5bmMocGxhblBhdGgsICd1dGYtOCcpLmluY2x1ZGVzKCdbeF0gKipUMDE6JyksICdyZWdlbmVyYXRlZCBwbGFuIHNob3VsZCByZWZsZWN0IERCIHRhc2sgY29tcGxldGlvbicpO1xuICB9XG5cbiAgY2xlYW51cERpcihiYXNlUGF0aCk7XG4gIGNsZWFudXAoZGJQYXRoKTtcbn1cblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBjb21wbGV0ZS10YXNrOiBtaW5pbWFsIHBhcmFtcyBcdTIwMTQgbm8gb3B0aW9uYWwgZmllbGRzICgjMjc3MSByZWdyZXNzaW9uKVxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbmNvbnNvbGUubG9nKCdcXG49PT0gY29tcGxldGUtdGFzazogbWluaW1hbCBwYXJhbXMgKG5vIGtleUZpbGVzLCBrZXlEZWNpc2lvbnMsIHZlcmlmaWNhdGlvbkV2aWRlbmNlLCBibG9ja2VyRGlzY292ZXJlZCkgPT09Jyk7XG57XG4gIGNvbnN0IGRiUGF0aCA9IHRlbXBEYlBhdGgoKTtcbiAgb3BlbkRhdGFiYXNlKGRiUGF0aCk7XG5cbiAgY29uc3QgeyBiYXNlUGF0aCwgcGxhblBhdGggfSA9IGNyZWF0ZVRlbXBQcm9qZWN0KCk7XG5cbiAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdUZXN0IE1pbGVzdG9uZScgfSk7XG4gIGluc2VydFNsaWNlKHsgaWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ1Rlc3QgU2xpY2UnIH0pO1xuXG4gIC8vIE1pbmltYWwgcGFyYW1zIFx1MjAxNCBvbmx5IHJlcXVpcmVkIGZpZWxkcywgYWxsIG9wdGlvbmFsIGVucmljaG1lbnQgZmllbGRzIG9taXR0ZWRcbiAgY29uc3QgbWluaW1hbFBhcmFtcyA9IHtcbiAgICB0YXNrSWQ6ICdUMDEnLFxuICAgIHNsaWNlSWQ6ICdTMDEnLFxuICAgIG1pbGVzdG9uZUlkOiAnTTAwMScsXG4gICAgb25lTGluZXI6ICdCYXNpYyB0YXNrJyxcbiAgICBuYXJyYXRpdmU6ICdEaWQgdGhlIHdvcmsuJyxcbiAgICB2ZXJpZmljYXRpb246ICdMb29rcyBnb29kLicsXG4gICAgLy8ga2V5RmlsZXMsIGtleURlY2lzaW9ucywgdmVyaWZpY2F0aW9uRXZpZGVuY2UsIGJsb2NrZXJEaXNjb3ZlcmVkIGludGVudGlvbmFsbHkgb21pdHRlZFxuICB9O1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZUNvbXBsZXRlVGFzayhtaW5pbWFsUGFyYW1zIGFzIGFueSwgYmFzZVBhdGgpO1xuXG4gIGFzc2VydFRydWUoISgnZXJyb3InIGluIHJlc3VsdCksICdoYW5kbGVyIHNob3VsZCBub3QgY3Jhc2ggd2l0aCBtaW5pbWFsIHBhcmFtcyAobm8gb3B0aW9uYWwgZmllbGRzKScpO1xuICBpZiAoISgnZXJyb3InIGluIHJlc3VsdCkpIHtcbiAgICBhc3NlcnRUcnVlKGZzLmV4aXN0c1N5bmMocmVzdWx0LnN1bW1hcnlQYXRoKSwgJ3N1bW1hcnkgZmlsZSBzaG91bGQgYmUgd3JpdHRlbiB3aXRoIG1pbmltYWwgcGFyYW1zJyk7XG4gICAgY29uc3Qgc3VtbWFyeUNvbnRlbnQgPSBmcy5yZWFkRmlsZVN5bmMocmVzdWx0LnN1bW1hcnlQYXRoLCAndXRmLTgnKTtcbiAgICBhc3NlcnRNYXRjaChzdW1tYXJ5Q29udGVudCwgL2Jsb2NrZXJfZGlzY292ZXJlZDpcXHMqZmFsc2UvLCAnYmxvY2tlcl9kaXNjb3ZlcmVkIHNob3VsZCBkZWZhdWx0IHRvIGZhbHNlJyk7XG4gICAgYXNzZXJ0TWF0Y2goc3VtbWFyeUNvbnRlbnQsIC9rZXlfZmlsZXM6XFxzKlxcW1xcXS8sICdrZXlfZmlsZXMgc2hvdWxkIHJlbmRlciBhcyBhbiBlbXB0eSBmcm9udG1hdHRlciBsaXN0Jyk7XG4gICAgYXNzZXJ0TWF0Y2goc3VtbWFyeUNvbnRlbnQsIC9rZXlfZGVjaXNpb25zOlxccypcXFtcXF0vLCAna2V5X2RlY2lzaW9ucyBzaG91bGQgcmVuZGVyIGFzIGFuIGVtcHR5IGZyb250bWF0dGVyIGxpc3QnKTtcbiAgICBhc3NlcnRUcnVlKCFzdW1tYXJ5Q29udGVudC5pbmNsdWRlcygnICAtIChub25lKScpLCAnZW1wdHkgZnJvbnRtYXR0ZXIgbGlzdHMgc2hvdWxkIG5vdCByZW5kZXIgKG5vbmUpIGFzIGEgbGlzdCBpdGVtJyk7XG4gIH1cblxuICBjbGVhbnVwRGlyKGJhc2VQYXRoKTtcbiAgY2xlYW51cChkYlBhdGgpO1xufVxuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxucmVwb3J0KCk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxTQUFTLHlCQUF5QjtBQUNsQyxZQUFZLFFBQVE7QUFDcEIsWUFBWSxVQUFVO0FBQ3RCLFlBQVksUUFBUTtBQUNwQjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFFQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUNQLFNBQVMsMEJBQTBCO0FBRW5DLE1BQU0sRUFBRSxVQUFVLFlBQVksYUFBYSxPQUFPLElBQUksa0JBQWtCO0FBTXhFLFNBQVMsYUFBcUI7QUFDNUIsUUFBTSxNQUFNLEdBQUcsWUFBWSxLQUFLLEtBQUssR0FBRyxPQUFPLEdBQUcsb0JBQW9CLENBQUM7QUFDdkUsU0FBTyxLQUFLLEtBQUssS0FBSyxTQUFTO0FBQ2pDO0FBRUEsU0FBUyxRQUFRLFFBQXNCO0FBQ3JDLGdCQUFjO0FBQ2QsTUFBSTtBQUNGLFVBQU0sTUFBTSxLQUFLLFFBQVEsTUFBTTtBQUMvQixlQUFXLEtBQUssR0FBRyxZQUFZLEdBQUcsR0FBRztBQUNuQyxTQUFHLFdBQVcsS0FBSyxLQUFLLEtBQUssQ0FBQyxDQUFDO0FBQUEsSUFDakM7QUFDQSxPQUFHLFVBQVUsR0FBRztBQUFBLEVBQ2xCLFFBQVE7QUFBQSxFQUVSO0FBQ0Y7QUFFQSxTQUFTLFdBQVcsU0FBdUI7QUFDekMsTUFBSTtBQUNGLE9BQUcsT0FBTyxTQUFTLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsRUFDckQsUUFBUTtBQUFBLEVBRVI7QUFDRjtBQUtBLFNBQVMsb0JBQTREO0FBQ25FLFFBQU0sV0FBVyxHQUFHLFlBQVksS0FBSyxLQUFLLEdBQUcsT0FBTyxHQUFHLGNBQWMsQ0FBQztBQUN0RSxR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
