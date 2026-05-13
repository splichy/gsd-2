import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  clearUnitRuntimeRecord,
  formatExecuteTaskRecoveryStatus,
  inspectExecuteTaskDurability,
  isInFlightRuntimePhase,
  readUnitRuntimeRecord,
  writeUnitRuntimeRecord
} from "../unit-runtime.js";
import { closeDatabase, insertMilestone, insertSlice, insertTask, openDatabase } from "../gsd-db.js";
import { clearPathCache } from "../paths.js";
import assert from "node:assert/strict";
const base = mkdtempSync(join(tmpdir(), "gsd-unit-runtime-test-"));
const tasksDir = join(base, ".gsd", "milestones", "M100", "slices", "S02", "tasks");
mkdirSync(tasksDir, { recursive: true });
writeFileSync(join(base, ".gsd", "STATE.md"), "## Next Action\nExecute T09 for S02: do the thing\n", "utf-8");
writeFileSync(
  join(base, ".gsd", "milestones", "M100", "slices", "S02", "S02-PLAN.md"),
  "# S02: Test Slice\n\n## Tasks\n\n- [ ] **T09: Do the thing** `est:10m`\n  Description.\n",
  "utf-8"
);
console.log("\n=== in-flight runtime phases ===");
{
  assert.equal(isInFlightRuntimePhase("crashed"), true, "crashed records remain recoverable");
  assert.equal(isInFlightRuntimePhase("finalized"), false, "finalized records are terminal");
}
console.log("\n=== runtime record write/read/update ===");
{
  const first = writeUnitRuntimeRecord(base, "execute-task", "M100/S02/T09", 1e3, { phase: "dispatched" });
  assert.deepStrictEqual(first.phase, "dispatched", "initial phase");
  const second = writeUnitRuntimeRecord(base, "execute-task", "M100/S02/T09", 1e3, { phase: "wrapup-warning-sent", wrapupWarningSent: true });
  assert.deepStrictEqual(second.wrapupWarningSent, true, "warning persisted");
  const loaded = readUnitRuntimeRecord(base, "execute-task", "M100/S02/T09");
  assert.ok(loaded !== null, "record readable");
  assert.deepStrictEqual(loaded.phase, "wrapup-warning-sent", "updated phase readable");
}
console.log("\n=== execute-task durability inspection ===");
{
  let status = await inspectExecuteTaskDurability(base, "M100/S02/T09");
  assert.ok(status !== null, "status exists");
  assert.deepStrictEqual(status.summaryExists, false, "summary initially missing");
  assert.deepStrictEqual(status.taskChecked, false, "task initially unchecked");
  assert.deepStrictEqual(status.nextActionAdvanced, false, "next action initially stale");
  assert.ok(/summary missing/i.test(formatExecuteTaskRecoveryStatus(status)), "diagnostic mentions summary");
  writeFileSync(join(tasksDir, "T09-SUMMARY.md"), "# done\n", "utf-8");
  writeFileSync(
    join(base, ".gsd", "milestones", "M100", "slices", "S02", "S02-PLAN.md"),
    "# S02: Test Slice\n\n## Tasks\n\n- [x] **T09: Do the thing** `est:10m`\n  Description.\n",
    "utf-8"
  );
  writeFileSync(join(base, ".gsd", "STATE.md"), "## Next Action\nExecute T10 for S02: next thing\n", "utf-8");
  clearPathCache();
  status = await inspectExecuteTaskDurability(base, "M100/S02/T09");
  assert.deepStrictEqual(status.summaryExists, true, "summary found after write");
  assert.deepStrictEqual(status.taskChecked, true, "task checked after update");
  assert.deepStrictEqual(status.nextActionAdvanced, true, "next action advanced after update");
  assert.deepStrictEqual(formatExecuteTaskRecoveryStatus(status), "all durable task artifacts present", "clean diagnostic when complete");
}
console.log("\n=== runtime record cleanup ===");
{
  clearUnitRuntimeRecord(base, "execute-task", "M100/S02/T09");
  const loaded = readUnitRuntimeRecord(base, "execute-task", "M100/S02/T09");
  assert.deepStrictEqual(loaded, null, "record removed");
}
console.log("\n=== execute-task durability trusts closed DB task status ===");
{
  const dbBase = mkdtempSync(join(tmpdir(), "gsd-unit-runtime-db-test-"));
  mkdirSync(join(dbBase, ".gsd", "milestones", "M300", "slices", "S01", "tasks"), { recursive: true });
  try {
    openDatabase(join(dbBase, ".gsd", "gsd.db"));
    insertMilestone({ id: "M300", title: "DB Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M300", title: "DB Slice", status: "in_progress" });
    insertTask({ id: "T01", milestoneId: "M300", sliceId: "S01", title: "DB Task", status: "complete" });
    writeFileSync(
      join(dbBase, ".gsd", "milestones", "M300", "slices", "S01", "S01-PLAN.md"),
      "# S01\n\n## Tasks\n\n- [ ] **T01: DB Task** `est:10m`\n",
      "utf-8"
    );
    writeFileSync(join(dbBase, ".gsd", "STATE.md"), "## Next Action\nExecute T01 for S01: DB task\n", "utf-8");
    const status = await inspectExecuteTaskDurability(dbBase, "M300/S01/T01");
    assert.ok(status !== null, "db-complete: status exists");
    assert.equal(status.dbComplete, true, "db-complete: closed DB status is captured");
    assert.equal(status.summaryExists, false, "db-complete: summary can still be missing");
    assert.equal(status.taskChecked, false, "db-complete: checkbox can still be unchecked");
    assert.equal(status.nextActionAdvanced, false, "db-complete: next action can still point at task");
    assert.equal(formatExecuteTaskRecoveryStatus(status), "DB task status is closed");
  } finally {
    closeDatabase();
    rmSync(dbBase, { recursive: true, force: true });
  }
}
console.log("\n=== hook unit type sanitization (slash in unitType) ===");
{
  const hookRecord = writeUnitRuntimeRecord(base, "hook/code-review", "M100/S02/T10", 2e3, { phase: "dispatched" });
  assert.deepStrictEqual(hookRecord.unitType, "hook/code-review", "unitType preserved in record");
  assert.deepStrictEqual(hookRecord.unitId, "M100/S02/T10", "unitId preserved in record");
  const loaded = readUnitRuntimeRecord(base, "hook/code-review", "M100/S02/T10");
  assert.ok(loaded !== null, "hook record readable");
  assert.deepStrictEqual(loaded.phase, "dispatched", "hook phase correct");
  const unitsDir = join(base, ".gsd", "runtime", "units");
  const files = readdirSync(unitsDir);
  const hookFile = files.find((f) => f.includes("hook-code-review"));
  assert.ok(hookFile !== void 0, "hook file exists with sanitized name");
  assert.ok(!files.some((f) => f === "hook"), "no 'hook' subdirectory created");
  clearUnitRuntimeRecord(base, "hook/code-review", "M100/S02/T10");
  const cleared = readUnitRuntimeRecord(base, "hook/code-review", "M100/S02/T10");
  assert.deepStrictEqual(cleared, null, "hook record removed");
}
const mhBase = mkdtempSync(join(tmpdir(), "gsd-unit-runtime-mh-test-"));
console.log("\n=== must-haves: all mentioned in summary ===");
{
  const tasksDir2 = join(mhBase, ".gsd", "milestones", "M200", "slices", "S01", "tasks");
  mkdirSync(tasksDir2, { recursive: true });
  writeFileSync(
    join(mhBase, ".gsd", "milestones", "M200", "slices", "S01", "S01-PLAN.md"),
    "# S01: Test\n\n## Tasks\n\n- [x] **T01: Build parser** `est:10m`\n  Build the parser.\n",
    "utf-8"
  );
  writeFileSync(
    join(tasksDir2, "T01-PLAN.md"),
    "# T01: Build parser\n\n## Must-Haves\n\n- [ ] `parseWidget` function is exported\n- [ ] `formatWidget` handles edge cases\n- [ ] All existing tests pass\n\n## Steps\n\n1. Do stuff\n",
    "utf-8"
  );
  writeFileSync(
    join(tasksDir2, "T01-SUMMARY.md"),
    "# T01: Build parser\n\nAdded parseWidget function and formatWidget with edge case handling. All existing tests pass without regression.\n",
    "utf-8"
  );
  writeFileSync(join(mhBase, ".gsd", "STATE.md"), "## Next Action\nExecute T02 for S01: next thing\n", "utf-8");
  const status = await inspectExecuteTaskDurability(mhBase, "M200/S01/T01");
  assert.ok(status !== null, "mh-all: status exists");
  assert.deepStrictEqual(status.mustHaveCount, 3, "mh-all: mustHaveCount is 3");
  assert.deepStrictEqual(status.mustHavesMentionedInSummary, 3, "mh-all: all 3 must-haves mentioned");
  assert.deepStrictEqual(status.summaryExists, true, "mh-all: summary exists");
  assert.deepStrictEqual(status.taskChecked, true, "mh-all: task checked");
  const diag = formatExecuteTaskRecoveryStatus(status);
  assert.deepStrictEqual(diag, "all durable task artifacts present", "mh-all: diagnostic is clean when all must-haves met");
}
console.log("\n=== must-haves: partially mentioned in summary ===");
{
  const tasksDir3 = join(mhBase, ".gsd", "milestones", "M200", "slices", "S02", "tasks");
  mkdirSync(tasksDir3, { recursive: true });
  writeFileSync(
    join(mhBase, ".gsd", "milestones", "M200", "slices", "S02", "S02-PLAN.md"),
    "# S02: Test\n\n## Tasks\n\n- [x] **T01: Build thing** `est:10m`\n  Build.\n",
    "utf-8"
  );
  writeFileSync(
    join(tasksDir3, "T01-PLAN.md"),
    "# T01: Build thing\n\n## Must-Haves\n\n- [ ] `computeScore` function is exported\n- [ ] `validateInput` rejects invalid data\n- [ ] `renderOutput` handles empty arrays\n\n## Steps\n\n1. Do stuff\n",
    "utf-8"
  );
  writeFileSync(
    join(tasksDir3, "T01-SUMMARY.md"),
    "# T01: Build thing\n\nAdded computeScore function with full test coverage.\n",
    "utf-8"
  );
  writeFileSync(join(mhBase, ".gsd", "STATE.md"), "## Next Action\nExecute T02 for S02: next thing\n", "utf-8");
  clearPathCache();
  const status = await inspectExecuteTaskDurability(mhBase, "M200/S02/T01");
  assert.ok(status !== null, "mh-partial: status exists");
  assert.deepStrictEqual(status.mustHaveCount, 3, "mh-partial: mustHaveCount is 3");
  assert.deepStrictEqual(status.mustHavesMentionedInSummary, 1, "mh-partial: only 1 must-have mentioned");
  const diag = formatExecuteTaskRecoveryStatus(status);
  assert.ok(diag.includes("must-have gap"), "mh-partial: diagnostic includes 'must-have gap'");
  assert.ok(diag.includes("1 of 3"), "mh-partial: diagnostic includes '1 of 3'");
}
console.log("\n=== must-haves: no task plan file ===");
{
  const tasksDir4 = join(mhBase, ".gsd", "milestones", "M200", "slices", "S03", "tasks");
  mkdirSync(tasksDir4, { recursive: true });
  writeFileSync(
    join(mhBase, ".gsd", "milestones", "M200", "slices", "S03", "S03-PLAN.md"),
    "# S03: Test\n\n## Tasks\n\n- [x] **T01: Quick fix** `est:5m`\n  Fix.\n",
    "utf-8"
  );
  writeFileSync(
    join(tasksDir4, "T01-SUMMARY.md"),
    "# T01: Quick fix\n\nFixed the thing.\n",
    "utf-8"
  );
  writeFileSync(join(mhBase, ".gsd", "STATE.md"), "## Next Action\nExecute T02 for S03: next thing\n", "utf-8");
  clearPathCache();
  const status = await inspectExecuteTaskDurability(mhBase, "M200/S03/T01");
  assert.ok(status !== null, "mh-noplan: status exists");
  assert.deepStrictEqual(status.mustHaveCount, 0, "mh-noplan: mustHaveCount is 0 when no task plan");
  assert.deepStrictEqual(status.mustHavesMentionedInSummary, 0, "mh-noplan: mustHavesMentionedInSummary is 0");
}
console.log("\n=== must-haves: present but no summary file ===");
{
  const tasksDir5 = join(mhBase, ".gsd", "milestones", "M200", "slices", "S04", "tasks");
  mkdirSync(tasksDir5, { recursive: true });
  writeFileSync(
    join(mhBase, ".gsd", "milestones", "M200", "slices", "S04", "S04-PLAN.md"),
    "# S04: Test\n\n## Tasks\n\n- [ ] **T01: Build parser** `est:10m`\n  Build.\n",
    "utf-8"
  );
  writeFileSync(
    join(tasksDir5, "T01-PLAN.md"),
    "# T01: Build parser\n\n## Must-Haves\n\n- [ ] `parseData` function exported\n- [ ] Error handling covers edge cases\n\n## Steps\n\n1. Do stuff\n",
    "utf-8"
  );
  writeFileSync(join(mhBase, ".gsd", "STATE.md"), "## Next Action\nExecute T01 for S04: build parser\n", "utf-8");
  clearPathCache();
  const status = await inspectExecuteTaskDurability(mhBase, "M200/S04/T01");
  assert.ok(status !== null, "mh-nosummary: status exists");
  assert.deepStrictEqual(status.mustHaveCount, 2, "mh-nosummary: mustHaveCount is 2");
  assert.deepStrictEqual(status.mustHavesMentionedInSummary, 0, "mh-nosummary: mustHavesMentionedInSummary is 0 with no summary");
  assert.deepStrictEqual(status.summaryExists, false, "mh-nosummary: summary doesn't exist");
}
console.log("\n=== must-haves: substring matching (no backtick tokens) ===");
{
  const tasksDir6 = join(mhBase, ".gsd", "milestones", "M200", "slices", "S05", "tasks");
  mkdirSync(tasksDir6, { recursive: true });
  writeFileSync(
    join(mhBase, ".gsd", "milestones", "M200", "slices", "S05", "S05-PLAN.md"),
    "# S05: Test\n\n## Tasks\n\n- [x] **T01: Add diagnostics** `est:10m`\n  Add.\n",
    "utf-8"
  );
  writeFileSync(
    join(tasksDir6, "T01-PLAN.md"),
    "# T01: Add diagnostics\n\n## Must-Haves\n\n- [ ] Heuristic matching prioritizes backtick-enclosed code tokens\n- [ ] Recovery diagnostic string shows gap count\n- [ ] All assertions pass\n\n## Steps\n\n1. Do stuff\n",
    "utf-8"
  );
  writeFileSync(
    join(tasksDir6, "T01-SUMMARY.md"),
    "# T01: Add diagnostics\n\nImplemented heuristic matching for must-have items. Recovery diagnostic string now includes gap counts.\n",
    "utf-8"
  );
  writeFileSync(join(mhBase, ".gsd", "STATE.md"), "## Next Action\nExecute T02 for S05: next thing\n", "utf-8");
  clearPathCache();
  const status = await inspectExecuteTaskDurability(mhBase, "M200/S05/T01");
  assert.ok(status !== null, "mh-substr: status exists");
  assert.deepStrictEqual(status.mustHaveCount, 3, "mh-substr: mustHaveCount is 3");
  assert.deepStrictEqual(status.mustHavesMentionedInSummary, 2, "mh-substr: 2 of 3 matched via substring");
  const diag = formatExecuteTaskRecoveryStatus(status);
  assert.ok(diag.includes("must-have gap"), "mh-substr: diagnostic includes gap info");
  assert.ok(diag.includes("2 of 3"), "mh-substr: diagnostic includes '2 of 3'");
}
console.log("\n=== per-record lock: stale .lock is reclaimed, list ignores .lock files ===");
{
  const { utimesSync, existsSync: lockExists } = await import("node:fs");
  const { listUnitRuntimeRecords } = await import("../unit-runtime.js");
  const lockBase = mkdtempSync(join(tmpdir(), "gsd-runtime-lock-test-"));
  try {
    const unitsDir = join(lockBase, ".gsd", "runtime", "units");
    mkdirSync(unitsDir, { recursive: true });
    const recordPath = join(unitsDir, "execute-task-M001-S01-T01.json");
    const lockPath = recordPath + ".lock";
    writeFileSync(lockPath, "");
    const staleTime = new Date(Date.now() - 6e4);
    utimesSync(lockPath, staleTime, staleTime);
    const written = writeUnitRuntimeRecord(lockBase, "execute-task", "M001/S01/T01", 1e3, { phase: "dispatched" });
    assert.deepStrictEqual(written.phase, "dispatched", "stale-lock path should not block writers");
    const readBack = readUnitRuntimeRecord(lockBase, "execute-task", "M001/S01/T01");
    assert.ok(readBack !== null, "record persisted after stealing stale lock");
    assert.equal(lockExists(lockPath), false, "lock file released after write completes");
  } finally {
    rmSync(lockBase, { recursive: true, force: true });
  }
  const listBase = mkdtempSync(join(tmpdir(), "gsd-runtime-list-test-"));
  try {
    writeUnitRuntimeRecord(listBase, "execute-task", "M002/S01/T01", 1e3, { phase: "dispatched" });
    const unitsDir = join(listBase, ".gsd", "runtime", "units");
    writeFileSync(join(unitsDir, "execute-task-M002-S01-T01.json.lock"), "");
    const records = listUnitRuntimeRecords(listBase);
    assert.equal(records.length, 1, "listUnitRuntimeRecords filters .lock files (only the .json record)");
    assert.equal(records[0].unitId, "M002/S01/T01");
  } finally {
    rmSync(listBase, { recursive: true, force: true });
  }
}
rmSync(mhBase, { recursive: true, force: true });
rmSync(base, { recursive: true, force: true });
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy91bml0LXJ1bnRpbWUudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgcmVhZGRpclN5bmMsIHJlYWRGaWxlU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHtcbiAgY2xlYXJVbml0UnVudGltZVJlY29yZCxcbiAgZm9ybWF0RXhlY3V0ZVRhc2tSZWNvdmVyeVN0YXR1cyxcbiAgaW5zcGVjdEV4ZWN1dGVUYXNrRHVyYWJpbGl0eSxcbiAgaXNJbkZsaWdodFJ1bnRpbWVQaGFzZSxcbiAgcmVhZFVuaXRSdW50aW1lUmVjb3JkLFxuICB3cml0ZVVuaXRSdW50aW1lUmVjb3JkLFxufSBmcm9tIFwiLi4vdW5pdC1ydW50aW1lLnRzXCI7XG5pbXBvcnQgeyBjbG9zZURhdGFiYXNlLCBpbnNlcnRNaWxlc3RvbmUsIGluc2VydFNsaWNlLCBpbnNlcnRUYXNrLCBvcGVuRGF0YWJhc2UgfSBmcm9tIFwiLi4vZ3NkLWRiLnRzXCI7XG5pbXBvcnQgeyBjbGVhclBhdGhDYWNoZSB9IGZyb20gJy4uL3BhdGhzLnRzJztcbmltcG9ydCB7IHRlc3QgfSBmcm9tICdub2RlOnRlc3QnO1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnO1xuXG5jb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtdW5pdC1ydW50aW1lLXRlc3QtXCIpKTtcbmNvbnN0IHRhc2tzRGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTEwMFwiLCBcInNsaWNlc1wiLCBcIlMwMlwiLCBcInRhc2tzXCIpO1xubWtkaXJTeW5jKHRhc2tzRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbndyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJTVEFURS5tZFwiKSwgXCIjIyBOZXh0IEFjdGlvblxcbkV4ZWN1dGUgVDA5IGZvciBTMDI6IGRvIHRoZSB0aGluZ1xcblwiLCBcInV0Zi04XCIpO1xud3JpdGVGaWxlU3luYyhcbiAgam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTEwMFwiLCBcInNsaWNlc1wiLCBcIlMwMlwiLCBcIlMwMi1QTEFOLm1kXCIpLFxuICBcIiMgUzAyOiBUZXN0IFNsaWNlXFxuXFxuIyMgVGFza3NcXG5cXG4tIFsgXSAqKlQwOTogRG8gdGhlIHRoaW5nKiogYGVzdDoxMG1gXFxuICBEZXNjcmlwdGlvbi5cXG5cIixcbiAgXCJ1dGYtOFwiLFxuKTtcblxuY29uc29sZS5sb2coXCJcXG49PT0gaW4tZmxpZ2h0IHJ1bnRpbWUgcGhhc2VzID09PVwiKTtcbntcbiAgYXNzZXJ0LmVxdWFsKGlzSW5GbGlnaHRSdW50aW1lUGhhc2UoXCJjcmFzaGVkXCIpLCB0cnVlLCBcImNyYXNoZWQgcmVjb3JkcyByZW1haW4gcmVjb3ZlcmFibGVcIik7XG4gIGFzc2VydC5lcXVhbChpc0luRmxpZ2h0UnVudGltZVBoYXNlKFwiZmluYWxpemVkXCIpLCBmYWxzZSwgXCJmaW5hbGl6ZWQgcmVjb3JkcyBhcmUgdGVybWluYWxcIik7XG59XG5cbmNvbnNvbGUubG9nKFwiXFxuPT09IHJ1bnRpbWUgcmVjb3JkIHdyaXRlL3JlYWQvdXBkYXRlID09PVwiKTtcbntcbiAgY29uc3QgZmlyc3QgPSB3cml0ZVVuaXRSdW50aW1lUmVjb3JkKGJhc2UsIFwiZXhlY3V0ZS10YXNrXCIsIFwiTTEwMC9TMDIvVDA5XCIsIDEwMDAsIHsgcGhhc2U6IFwiZGlzcGF0Y2hlZFwiIH0pO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGZpcnN0LnBoYXNlLCBcImRpc3BhdGNoZWRcIiwgXCJpbml0aWFsIHBoYXNlXCIpO1xuICBjb25zdCBzZWNvbmQgPSB3cml0ZVVuaXRSdW50aW1lUmVjb3JkKGJhc2UsIFwiZXhlY3V0ZS10YXNrXCIsIFwiTTEwMC9TMDIvVDA5XCIsIDEwMDAsIHsgcGhhc2U6IFwid3JhcHVwLXdhcm5pbmctc2VudFwiLCB3cmFwdXBXYXJuaW5nU2VudDogdHJ1ZSB9KTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzZWNvbmQud3JhcHVwV2FybmluZ1NlbnQsIHRydWUsIFwid2FybmluZyBwZXJzaXN0ZWRcIik7XG4gIGNvbnN0IGxvYWRlZCA9IHJlYWRVbml0UnVudGltZVJlY29yZChiYXNlLCBcImV4ZWN1dGUtdGFza1wiLCBcIk0xMDAvUzAyL1QwOVwiKTtcbiAgYXNzZXJ0Lm9rKGxvYWRlZCAhPT0gbnVsbCwgXCJyZWNvcmQgcmVhZGFibGVcIik7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwobG9hZGVkIS5waGFzZSwgXCJ3cmFwdXAtd2FybmluZy1zZW50XCIsIFwidXBkYXRlZCBwaGFzZSByZWFkYWJsZVwiKTtcbn1cblxuY29uc29sZS5sb2coXCJcXG49PT0gZXhlY3V0ZS10YXNrIGR1cmFiaWxpdHkgaW5zcGVjdGlvbiA9PT1cIik7XG57XG4gIGxldCBzdGF0dXMgPSBhd2FpdCBpbnNwZWN0RXhlY3V0ZVRhc2tEdXJhYmlsaXR5KGJhc2UsIFwiTTEwMC9TMDIvVDA5XCIpO1xuICBhc3NlcnQub2soc3RhdHVzICE9PSBudWxsLCBcInN0YXR1cyBleGlzdHNcIik7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdHVzIS5zdW1tYXJ5RXhpc3RzLCBmYWxzZSwgXCJzdW1tYXJ5IGluaXRpYWxseSBtaXNzaW5nXCIpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXR1cyEudGFza0NoZWNrZWQsIGZhbHNlLCBcInRhc2sgaW5pdGlhbGx5IHVuY2hlY2tlZFwiKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0dXMhLm5leHRBY3Rpb25BZHZhbmNlZCwgZmFsc2UsIFwibmV4dCBhY3Rpb24gaW5pdGlhbGx5IHN0YWxlXCIpO1xuICBhc3NlcnQub2soL3N1bW1hcnkgbWlzc2luZy9pLnRlc3QoZm9ybWF0RXhlY3V0ZVRhc2tSZWNvdmVyeVN0YXR1cyhzdGF0dXMhKSksIFwiZGlhZ25vc3RpYyBtZW50aW9ucyBzdW1tYXJ5XCIpO1xuXG4gIHdyaXRlRmlsZVN5bmMoam9pbih0YXNrc0RpciwgXCJUMDktU1VNTUFSWS5tZFwiKSwgXCIjIGRvbmVcXG5cIiwgXCJ1dGYtOFwiKTtcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMTAwXCIsIFwic2xpY2VzXCIsIFwiUzAyXCIsIFwiUzAyLVBMQU4ubWRcIiksXG4gICAgXCIjIFMwMjogVGVzdCBTbGljZVxcblxcbiMjIFRhc2tzXFxuXFxuLSBbeF0gKipUMDk6IERvIHRoZSB0aGluZyoqIGBlc3Q6MTBtYFxcbiAgRGVzY3JpcHRpb24uXFxuXCIsXG4gICAgXCJ1dGYtOFwiLFxuICApO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiU1RBVEUubWRcIiksIFwiIyMgTmV4dCBBY3Rpb25cXG5FeGVjdXRlIFQxMCBmb3IgUzAyOiBuZXh0IHRoaW5nXFxuXCIsIFwidXRmLThcIik7XG4gIGNsZWFyUGF0aENhY2hlKCk7XG5cbiAgc3RhdHVzID0gYXdhaXQgaW5zcGVjdEV4ZWN1dGVUYXNrRHVyYWJpbGl0eShiYXNlLCBcIk0xMDAvUzAyL1QwOVwiKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0dXMhLnN1bW1hcnlFeGlzdHMsIHRydWUsIFwic3VtbWFyeSBmb3VuZCBhZnRlciB3cml0ZVwiKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0dXMhLnRhc2tDaGVja2VkLCB0cnVlLCBcInRhc2sgY2hlY2tlZCBhZnRlciB1cGRhdGVcIik7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdHVzIS5uZXh0QWN0aW9uQWR2YW5jZWQsIHRydWUsIFwibmV4dCBhY3Rpb24gYWR2YW5jZWQgYWZ0ZXIgdXBkYXRlXCIpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGZvcm1hdEV4ZWN1dGVUYXNrUmVjb3ZlcnlTdGF0dXMoc3RhdHVzISksIFwiYWxsIGR1cmFibGUgdGFzayBhcnRpZmFjdHMgcHJlc2VudFwiLCBcImNsZWFuIGRpYWdub3N0aWMgd2hlbiBjb21wbGV0ZVwiKTtcbn1cblxuY29uc29sZS5sb2coXCJcXG49PT0gcnVudGltZSByZWNvcmQgY2xlYW51cCA9PT1cIik7XG57XG4gIGNsZWFyVW5pdFJ1bnRpbWVSZWNvcmQoYmFzZSwgXCJleGVjdXRlLXRhc2tcIiwgXCJNMTAwL1MwMi9UMDlcIik7XG4gIGNvbnN0IGxvYWRlZCA9IHJlYWRVbml0UnVudGltZVJlY29yZChiYXNlLCBcImV4ZWN1dGUtdGFza1wiLCBcIk0xMDAvUzAyL1QwOVwiKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChsb2FkZWQsIG51bGwsIFwicmVjb3JkIHJlbW92ZWRcIik7XG59XG5cbmNvbnNvbGUubG9nKFwiXFxuPT09IGV4ZWN1dGUtdGFzayBkdXJhYmlsaXR5IHRydXN0cyBjbG9zZWQgREIgdGFzayBzdGF0dXMgPT09XCIpO1xue1xuICBjb25zdCBkYkJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC11bml0LXJ1bnRpbWUtZGItdGVzdC1cIikpO1xuICBta2RpclN5bmMoam9pbihkYkJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMzAwXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIsIFwidGFza3NcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB0cnkge1xuICAgIG9wZW5EYXRhYmFzZShqb2luKGRiQmFzZSwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpKTtcbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMzAwXCIsIHRpdGxlOiBcIkRCIE1pbGVzdG9uZVwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSk7XG4gICAgaW5zZXJ0U2xpY2UoeyBpZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTMwMFwiLCB0aXRsZTogXCJEQiBTbGljZVwiLCBzdGF0dXM6IFwiaW5fcHJvZ3Jlc3NcIiB9KTtcbiAgICBpbnNlcnRUYXNrKHsgaWQ6IFwiVDAxXCIsIG1pbGVzdG9uZUlkOiBcIk0zMDBcIiwgc2xpY2VJZDogXCJTMDFcIiwgdGl0bGU6IFwiREIgVGFza1wiLCBzdGF0dXM6IFwiY29tcGxldGVcIiB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihkYkJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMzAwXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIsIFwiUzAxLVBMQU4ubWRcIiksXG4gICAgICBcIiMgUzAxXFxuXFxuIyMgVGFza3NcXG5cXG4tIFsgXSAqKlQwMTogREIgVGFzayoqIGBlc3Q6MTBtYFxcblwiLFxuICAgICAgXCJ1dGYtOFwiLFxuICAgICk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGRiQmFzZSwgXCIuZ3NkXCIsIFwiU1RBVEUubWRcIiksIFwiIyMgTmV4dCBBY3Rpb25cXG5FeGVjdXRlIFQwMSBmb3IgUzAxOiBEQiB0YXNrXFxuXCIsIFwidXRmLThcIik7XG5cbiAgICBjb25zdCBzdGF0dXMgPSBhd2FpdCBpbnNwZWN0RXhlY3V0ZVRhc2tEdXJhYmlsaXR5KGRiQmFzZSwgXCJNMzAwL1MwMS9UMDFcIik7XG4gICAgYXNzZXJ0Lm9rKHN0YXR1cyAhPT0gbnVsbCwgXCJkYi1jb21wbGV0ZTogc3RhdHVzIGV4aXN0c1wiKTtcbiAgICBhc3NlcnQuZXF1YWwoc3RhdHVzIS5kYkNvbXBsZXRlLCB0cnVlLCBcImRiLWNvbXBsZXRlOiBjbG9zZWQgREIgc3RhdHVzIGlzIGNhcHR1cmVkXCIpO1xuICAgIGFzc2VydC5lcXVhbChzdGF0dXMhLnN1bW1hcnlFeGlzdHMsIGZhbHNlLCBcImRiLWNvbXBsZXRlOiBzdW1tYXJ5IGNhbiBzdGlsbCBiZSBtaXNzaW5nXCIpO1xuICAgIGFzc2VydC5lcXVhbChzdGF0dXMhLnRhc2tDaGVja2VkLCBmYWxzZSwgXCJkYi1jb21wbGV0ZTogY2hlY2tib3ggY2FuIHN0aWxsIGJlIHVuY2hlY2tlZFwiKTtcbiAgICBhc3NlcnQuZXF1YWwoc3RhdHVzIS5uZXh0QWN0aW9uQWR2YW5jZWQsIGZhbHNlLCBcImRiLWNvbXBsZXRlOiBuZXh0IGFjdGlvbiBjYW4gc3RpbGwgcG9pbnQgYXQgdGFza1wiKTtcbiAgICBhc3NlcnQuZXF1YWwoZm9ybWF0RXhlY3V0ZVRhc2tSZWNvdmVyeVN0YXR1cyhzdGF0dXMhKSwgXCJEQiB0YXNrIHN0YXR1cyBpcyBjbG9zZWRcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIHJtU3luYyhkYkJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufVxuXG5jb25zb2xlLmxvZyhcIlxcbj09PSBob29rIHVuaXQgdHlwZSBzYW5pdGl6YXRpb24gKHNsYXNoIGluIHVuaXRUeXBlKSA9PT1cIik7XG57XG4gIC8vIEhvb2sgdW5pdHMgaGF2ZSB1bml0VHlwZSBsaWtlIFwiaG9vay9jb2RlLXJldmlld1wiIHdpdGggYSBzbGFzaFxuICAvLyBUaGlzIHNob3VsZCBOT1QgY3JlYXRlIGEgc3ViZGlyZWN0b3J5IC0gdGhlIHNsYXNoIG11c3QgYmUgc2FuaXRpemVkXG4gIGNvbnN0IGhvb2tSZWNvcmQgPSB3cml0ZVVuaXRSdW50aW1lUmVjb3JkKGJhc2UsIFwiaG9vay9jb2RlLXJldmlld1wiLCBcIk0xMDAvUzAyL1QxMFwiLCAyMDAwLCB7IHBoYXNlOiBcImRpc3BhdGNoZWRcIiB9KTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChob29rUmVjb3JkLnVuaXRUeXBlLCBcImhvb2svY29kZS1yZXZpZXdcIiwgXCJ1bml0VHlwZSBwcmVzZXJ2ZWQgaW4gcmVjb3JkXCIpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGhvb2tSZWNvcmQudW5pdElkLCBcIk0xMDAvUzAyL1QxMFwiLCBcInVuaXRJZCBwcmVzZXJ2ZWQgaW4gcmVjb3JkXCIpO1xuICBcbiAgY29uc3QgbG9hZGVkID0gcmVhZFVuaXRSdW50aW1lUmVjb3JkKGJhc2UsIFwiaG9vay9jb2RlLXJldmlld1wiLCBcIk0xMDAvUzAyL1QxMFwiKTtcbiAgYXNzZXJ0Lm9rKGxvYWRlZCAhPT0gbnVsbCwgXCJob29rIHJlY29yZCByZWFkYWJsZVwiKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChsb2FkZWQhLnBoYXNlLCBcImRpc3BhdGNoZWRcIiwgXCJob29rIHBoYXNlIGNvcnJlY3RcIik7XG4gIFxuICAvLyBWZXJpZnkgdGhlIGZpbGUgaXMgaW4gdGhlIHVuaXRzIGRpciwgbm90IGluIGEgc3ViZGlyZWN0b3J5XG4gIGNvbnN0IHVuaXRzRGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJydW50aW1lXCIsIFwidW5pdHNcIik7XG4gIGNvbnN0IGZpbGVzID0gcmVhZGRpclN5bmModW5pdHNEaXIpO1xuICBjb25zdCBob29rRmlsZSA9IGZpbGVzLmZpbmQoKGY6IHN0cmluZykgPT4gZi5pbmNsdWRlcyhcImhvb2stY29kZS1yZXZpZXdcIikpO1xuICBhc3NlcnQub2soaG9va0ZpbGUgIT09IHVuZGVmaW5lZCwgXCJob29rIGZpbGUgZXhpc3RzIHdpdGggc2FuaXRpemVkIG5hbWVcIik7XG4gIGFzc2VydC5vayghZmlsZXMuc29tZSgoZjogc3RyaW5nKSA9PiBmID09PSBcImhvb2tcIiksIFwibm8gJ2hvb2snIHN1YmRpcmVjdG9yeSBjcmVhdGVkXCIpO1xuICBcbiAgY2xlYXJVbml0UnVudGltZVJlY29yZChiYXNlLCBcImhvb2svY29kZS1yZXZpZXdcIiwgXCJNMTAwL1MwMi9UMTBcIik7XG4gIGNvbnN0IGNsZWFyZWQgPSByZWFkVW5pdFJ1bnRpbWVSZWNvcmQoYmFzZSwgXCJob29rL2NvZGUtcmV2aWV3XCIsIFwiTTEwMC9TMDIvVDEwXCIpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGNsZWFyZWQsIG51bGwsIFwiaG9vayByZWNvcmQgcmVtb3ZlZFwiKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIE11c3QtaGF2ZSBkdXJhYmlsaXR5IGludGVncmF0aW9uIHRlc3RzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vLyBDcmVhdGUgYSBzZXBhcmF0ZSB0ZW1wIGJhc2UgZm9yIG11c3QtaGF2ZSB0ZXN0cyB0byBhdm9pZCBpbnRlcmZlcmVuY2VcbmNvbnN0IG1oQmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXVuaXQtcnVudGltZS1taC10ZXN0LVwiKSk7XG5cbmNvbnNvbGUubG9nKFwiXFxuPT09IG11c3QtaGF2ZXM6IGFsbCBtZW50aW9uZWQgaW4gc3VtbWFyeSA9PT1cIik7XG57XG4gIGNvbnN0IHRhc2tzRGlyMiA9IGpvaW4obWhCYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTIwMFwiLCBcInNsaWNlc1wiLCBcIlMwMVwiLCBcInRhc2tzXCIpO1xuICBta2RpclN5bmModGFza3NEaXIyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAvLyBTbGljZSBwbGFuIHdpdGggVDAxIGNoZWNrZWRcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKG1oQmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0yMDBcIiwgXCJzbGljZXNcIiwgXCJTMDFcIiwgXCJTMDEtUExBTi5tZFwiKSxcbiAgICBcIiMgUzAxOiBUZXN0XFxuXFxuIyMgVGFza3NcXG5cXG4tIFt4XSAqKlQwMTogQnVpbGQgcGFyc2VyKiogYGVzdDoxMG1gXFxuICBCdWlsZCB0aGUgcGFyc2VyLlxcblwiLFxuICAgIFwidXRmLThcIixcbiAgKTtcbiAgLy8gVGFzayBwbGFuIHdpdGggbXVzdC1oYXZlcyBjb250YWluaW5nIGJhY2t0aWNrIGNvZGUgdG9rZW5zXG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbih0YXNrc0RpcjIsIFwiVDAxLVBMQU4ubWRcIiksXG4gICAgXCIjIFQwMTogQnVpbGQgcGFyc2VyXFxuXFxuIyMgTXVzdC1IYXZlc1xcblxcbi0gWyBdIGBwYXJzZVdpZGdldGAgZnVuY3Rpb24gaXMgZXhwb3J0ZWRcXG4tIFsgXSBgZm9ybWF0V2lkZ2V0YCBoYW5kbGVzIGVkZ2UgY2FzZXNcXG4tIFsgXSBBbGwgZXhpc3RpbmcgdGVzdHMgcGFzc1xcblxcbiMjIFN0ZXBzXFxuXFxuMS4gRG8gc3R1ZmZcXG5cIixcbiAgICBcInV0Zi04XCIsXG4gICk7XG4gIC8vIFN1bW1hcnkgdGhhdCBtZW50aW9ucyBhbGwgbXVzdC1oYXZlc1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4odGFza3NEaXIyLCBcIlQwMS1TVU1NQVJZLm1kXCIpLFxuICAgIFwiIyBUMDE6IEJ1aWxkIHBhcnNlclxcblxcbkFkZGVkIHBhcnNlV2lkZ2V0IGZ1bmN0aW9uIGFuZCBmb3JtYXRXaWRnZXQgd2l0aCBlZGdlIGNhc2UgaGFuZGxpbmcuIEFsbCBleGlzdGluZyB0ZXN0cyBwYXNzIHdpdGhvdXQgcmVncmVzc2lvbi5cXG5cIixcbiAgICBcInV0Zi04XCIsXG4gICk7XG4gIC8vIFNUQVRFLm1kIHdpdGggbmV4dCBhY3Rpb24gYWR2YW5jZWQgcGFzdCBUMDFcbiAgd3JpdGVGaWxlU3luYyhqb2luKG1oQmFzZSwgXCIuZ3NkXCIsIFwiU1RBVEUubWRcIiksIFwiIyMgTmV4dCBBY3Rpb25cXG5FeGVjdXRlIFQwMiBmb3IgUzAxOiBuZXh0IHRoaW5nXFxuXCIsIFwidXRmLThcIik7XG5cbiAgY29uc3Qgc3RhdHVzID0gYXdhaXQgaW5zcGVjdEV4ZWN1dGVUYXNrRHVyYWJpbGl0eShtaEJhc2UsIFwiTTIwMC9TMDEvVDAxXCIpO1xuICBhc3NlcnQub2soc3RhdHVzICE9PSBudWxsLCBcIm1oLWFsbDogc3RhdHVzIGV4aXN0c1wiKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0dXMhLm11c3RIYXZlQ291bnQsIDMsIFwibWgtYWxsOiBtdXN0SGF2ZUNvdW50IGlzIDNcIik7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdHVzIS5tdXN0SGF2ZXNNZW50aW9uZWRJblN1bW1hcnksIDMsIFwibWgtYWxsOiBhbGwgMyBtdXN0LWhhdmVzIG1lbnRpb25lZFwiKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0dXMhLnN1bW1hcnlFeGlzdHMsIHRydWUsIFwibWgtYWxsOiBzdW1tYXJ5IGV4aXN0c1wiKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0dXMhLnRhc2tDaGVja2VkLCB0cnVlLCBcIm1oLWFsbDogdGFzayBjaGVja2VkXCIpO1xuICBjb25zdCBkaWFnID0gZm9ybWF0RXhlY3V0ZVRhc2tSZWNvdmVyeVN0YXR1cyhzdGF0dXMhKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkaWFnLCBcImFsbCBkdXJhYmxlIHRhc2sgYXJ0aWZhY3RzIHByZXNlbnRcIiwgXCJtaC1hbGw6IGRpYWdub3N0aWMgaXMgY2xlYW4gd2hlbiBhbGwgbXVzdC1oYXZlcyBtZXRcIik7XG59XG5cbmNvbnNvbGUubG9nKFwiXFxuPT09IG11c3QtaGF2ZXM6IHBhcnRpYWxseSBtZW50aW9uZWQgaW4gc3VtbWFyeSA9PT1cIik7XG57XG4gIGNvbnN0IHRhc2tzRGlyMyA9IGpvaW4obWhCYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTIwMFwiLCBcInNsaWNlc1wiLCBcIlMwMlwiLCBcInRhc2tzXCIpO1xuICBta2RpclN5bmModGFza3NEaXIzLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4obWhCYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTIwMFwiLCBcInNsaWNlc1wiLCBcIlMwMlwiLCBcIlMwMi1QTEFOLm1kXCIpLFxuICAgIFwiIyBTMDI6IFRlc3RcXG5cXG4jIyBUYXNrc1xcblxcbi0gW3hdICoqVDAxOiBCdWlsZCB0aGluZyoqIGBlc3Q6MTBtYFxcbiAgQnVpbGQuXFxuXCIsXG4gICAgXCJ1dGYtOFwiLFxuICApO1xuICAvLyBUYXNrIHBsYW4gd2l0aCAzIG11c3QtaGF2ZXMsIHN1bW1hcnkgd2lsbCBvbmx5IG1lbnRpb24gMVxuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4odGFza3NEaXIzLCBcIlQwMS1QTEFOLm1kXCIpLFxuICAgIFwiIyBUMDE6IEJ1aWxkIHRoaW5nXFxuXFxuIyMgTXVzdC1IYXZlc1xcblxcbi0gWyBdIGBjb21wdXRlU2NvcmVgIGZ1bmN0aW9uIGlzIGV4cG9ydGVkXFxuLSBbIF0gYHZhbGlkYXRlSW5wdXRgIHJlamVjdHMgaW52YWxpZCBkYXRhXFxuLSBbIF0gYHJlbmRlck91dHB1dGAgaGFuZGxlcyBlbXB0eSBhcnJheXNcXG5cXG4jIyBTdGVwc1xcblxcbjEuIERvIHN0dWZmXFxuXCIsXG4gICAgXCJ1dGYtOFwiLFxuICApO1xuICAvLyBTdW1tYXJ5IG9ubHkgbWVudGlvbnMgY29tcHV0ZVNjb3JlXG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbih0YXNrc0RpcjMsIFwiVDAxLVNVTU1BUlkubWRcIiksXG4gICAgXCIjIFQwMTogQnVpbGQgdGhpbmdcXG5cXG5BZGRlZCBjb21wdXRlU2NvcmUgZnVuY3Rpb24gd2l0aCBmdWxsIHRlc3QgY292ZXJhZ2UuXFxuXCIsXG4gICAgXCJ1dGYtOFwiLFxuICApO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4obWhCYXNlLCBcIi5nc2RcIiwgXCJTVEFURS5tZFwiKSwgXCIjIyBOZXh0IEFjdGlvblxcbkV4ZWN1dGUgVDAyIGZvciBTMDI6IG5leHQgdGhpbmdcXG5cIiwgXCJ1dGYtOFwiKTtcblxuICBjbGVhclBhdGhDYWNoZSgpO1xuICBjb25zdCBzdGF0dXMgPSBhd2FpdCBpbnNwZWN0RXhlY3V0ZVRhc2tEdXJhYmlsaXR5KG1oQmFzZSwgXCJNMjAwL1MwMi9UMDFcIik7XG4gIGFzc2VydC5vayhzdGF0dXMgIT09IG51bGwsIFwibWgtcGFydGlhbDogc3RhdHVzIGV4aXN0c1wiKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0dXMhLm11c3RIYXZlQ291bnQsIDMsIFwibWgtcGFydGlhbDogbXVzdEhhdmVDb3VudCBpcyAzXCIpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXR1cyEubXVzdEhhdmVzTWVudGlvbmVkSW5TdW1tYXJ5LCAxLCBcIm1oLXBhcnRpYWw6IG9ubHkgMSBtdXN0LWhhdmUgbWVudGlvbmVkXCIpO1xuICBjb25zdCBkaWFnID0gZm9ybWF0RXhlY3V0ZVRhc2tSZWNvdmVyeVN0YXR1cyhzdGF0dXMhKTtcbiAgYXNzZXJ0Lm9rKGRpYWcuaW5jbHVkZXMoXCJtdXN0LWhhdmUgZ2FwXCIpLCBcIm1oLXBhcnRpYWw6IGRpYWdub3N0aWMgaW5jbHVkZXMgJ211c3QtaGF2ZSBnYXAnXCIpO1xuICBhc3NlcnQub2soZGlhZy5pbmNsdWRlcyhcIjEgb2YgM1wiKSwgXCJtaC1wYXJ0aWFsOiBkaWFnbm9zdGljIGluY2x1ZGVzICcxIG9mIDMnXCIpO1xufVxuXG5jb25zb2xlLmxvZyhcIlxcbj09PSBtdXN0LWhhdmVzOiBubyB0YXNrIHBsYW4gZmlsZSA9PT1cIik7XG57XG4gIGNvbnN0IHRhc2tzRGlyNCA9IGpvaW4obWhCYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTIwMFwiLCBcInNsaWNlc1wiLCBcIlMwM1wiLCBcInRhc2tzXCIpO1xuICBta2RpclN5bmModGFza3NEaXI0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4obWhCYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTIwMFwiLCBcInNsaWNlc1wiLCBcIlMwM1wiLCBcIlMwMy1QTEFOLm1kXCIpLFxuICAgIFwiIyBTMDM6IFRlc3RcXG5cXG4jIyBUYXNrc1xcblxcbi0gW3hdICoqVDAxOiBRdWljayBmaXgqKiBgZXN0OjVtYFxcbiAgRml4LlxcblwiLFxuICAgIFwidXRmLThcIixcbiAgKTtcbiAgLy8gTm8gVDAxLVBMQU4ubWQgXHUyMDE0IG9ubHkgc3VtbWFyeVxuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4odGFza3NEaXI0LCBcIlQwMS1TVU1NQVJZLm1kXCIpLFxuICAgIFwiIyBUMDE6IFF1aWNrIGZpeFxcblxcbkZpeGVkIHRoZSB0aGluZy5cXG5cIixcbiAgICBcInV0Zi04XCIsXG4gICk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihtaEJhc2UsIFwiLmdzZFwiLCBcIlNUQVRFLm1kXCIpLCBcIiMjIE5leHQgQWN0aW9uXFxuRXhlY3V0ZSBUMDIgZm9yIFMwMzogbmV4dCB0aGluZ1xcblwiLCBcInV0Zi04XCIpO1xuXG4gIGNsZWFyUGF0aENhY2hlKCk7XG4gIGNvbnN0IHN0YXR1cyA9IGF3YWl0IGluc3BlY3RFeGVjdXRlVGFza0R1cmFiaWxpdHkobWhCYXNlLCBcIk0yMDAvUzAzL1QwMVwiKTtcbiAgYXNzZXJ0Lm9rKHN0YXR1cyAhPT0gbnVsbCwgXCJtaC1ub3BsYW46IHN0YXR1cyBleGlzdHNcIik7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdHVzIS5tdXN0SGF2ZUNvdW50LCAwLCBcIm1oLW5vcGxhbjogbXVzdEhhdmVDb3VudCBpcyAwIHdoZW4gbm8gdGFzayBwbGFuXCIpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXR1cyEubXVzdEhhdmVzTWVudGlvbmVkSW5TdW1tYXJ5LCAwLCBcIm1oLW5vcGxhbjogbXVzdEhhdmVzTWVudGlvbmVkSW5TdW1tYXJ5IGlzIDBcIik7XG59XG5cbmNvbnNvbGUubG9nKFwiXFxuPT09IG11c3QtaGF2ZXM6IHByZXNlbnQgYnV0IG5vIHN1bW1hcnkgZmlsZSA9PT1cIik7XG57XG4gIGNvbnN0IHRhc2tzRGlyNSA9IGpvaW4obWhCYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTIwMFwiLCBcInNsaWNlc1wiLCBcIlMwNFwiLCBcInRhc2tzXCIpO1xuICBta2RpclN5bmModGFza3NEaXI1LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4obWhCYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTIwMFwiLCBcInNsaWNlc1wiLCBcIlMwNFwiLCBcIlMwNC1QTEFOLm1kXCIpLFxuICAgIFwiIyBTMDQ6IFRlc3RcXG5cXG4jIyBUYXNrc1xcblxcbi0gWyBdICoqVDAxOiBCdWlsZCBwYXJzZXIqKiBgZXN0OjEwbWBcXG4gIEJ1aWxkLlxcblwiLFxuICAgIFwidXRmLThcIixcbiAgKTtcbiAgLy8gVGFzayBwbGFuIHdpdGggbXVzdC1oYXZlcyBidXQgTk8gc3VtbWFyeSBmaWxlXG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbih0YXNrc0RpcjUsIFwiVDAxLVBMQU4ubWRcIiksXG4gICAgXCIjIFQwMTogQnVpbGQgcGFyc2VyXFxuXFxuIyMgTXVzdC1IYXZlc1xcblxcbi0gWyBdIGBwYXJzZURhdGFgIGZ1bmN0aW9uIGV4cG9ydGVkXFxuLSBbIF0gRXJyb3IgaGFuZGxpbmcgY292ZXJzIGVkZ2UgY2FzZXNcXG5cXG4jIyBTdGVwc1xcblxcbjEuIERvIHN0dWZmXFxuXCIsXG4gICAgXCJ1dGYtOFwiLFxuICApO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4obWhCYXNlLCBcIi5nc2RcIiwgXCJTVEFURS5tZFwiKSwgXCIjIyBOZXh0IEFjdGlvblxcbkV4ZWN1dGUgVDAxIGZvciBTMDQ6IGJ1aWxkIHBhcnNlclxcblwiLCBcInV0Zi04XCIpO1xuXG4gIGNsZWFyUGF0aENhY2hlKCk7XG4gIGNvbnN0IHN0YXR1cyA9IGF3YWl0IGluc3BlY3RFeGVjdXRlVGFza0R1cmFiaWxpdHkobWhCYXNlLCBcIk0yMDAvUzA0L1QwMVwiKTtcbiAgYXNzZXJ0Lm9rKHN0YXR1cyAhPT0gbnVsbCwgXCJtaC1ub3N1bW1hcnk6IHN0YXR1cyBleGlzdHNcIik7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdHVzIS5tdXN0SGF2ZUNvdW50LCAyLCBcIm1oLW5vc3VtbWFyeTogbXVzdEhhdmVDb3VudCBpcyAyXCIpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXR1cyEubXVzdEhhdmVzTWVudGlvbmVkSW5TdW1tYXJ5LCAwLCBcIm1oLW5vc3VtbWFyeTogbXVzdEhhdmVzTWVudGlvbmVkSW5TdW1tYXJ5IGlzIDAgd2l0aCBubyBzdW1tYXJ5XCIpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXR1cyEuc3VtbWFyeUV4aXN0cywgZmFsc2UsIFwibWgtbm9zdW1tYXJ5OiBzdW1tYXJ5IGRvZXNuJ3QgZXhpc3RcIik7XG59XG5cbmNvbnNvbGUubG9nKFwiXFxuPT09IG11c3QtaGF2ZXM6IHN1YnN0cmluZyBtYXRjaGluZyAobm8gYmFja3RpY2sgdG9rZW5zKSA9PT1cIik7XG57XG4gIGNvbnN0IHRhc2tzRGlyNiA9IGpvaW4obWhCYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTIwMFwiLCBcInNsaWNlc1wiLCBcIlMwNVwiLCBcInRhc2tzXCIpO1xuICBta2RpclN5bmModGFza3NEaXI2LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4obWhCYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTIwMFwiLCBcInNsaWNlc1wiLCBcIlMwNVwiLCBcIlMwNS1QTEFOLm1kXCIpLFxuICAgIFwiIyBTMDU6IFRlc3RcXG5cXG4jIyBUYXNrc1xcblxcbi0gW3hdICoqVDAxOiBBZGQgZGlhZ25vc3RpY3MqKiBgZXN0OjEwbWBcXG4gIEFkZC5cXG5cIixcbiAgICBcInV0Zi04XCIsXG4gICk7XG4gIC8vIE11c3QtaGF2ZXMgd2l0aCBubyBiYWNrdGljayB0b2tlbnMgXHUyMDE0IGZhbGxzIGJhY2sgdG8gc3Vic3RyaW5nIG1hdGNoaW5nXG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbih0YXNrc0RpcjYsIFwiVDAxLVBMQU4ubWRcIiksXG4gICAgXCIjIFQwMTogQWRkIGRpYWdub3N0aWNzXFxuXFxuIyMgTXVzdC1IYXZlc1xcblxcbi0gWyBdIEhldXJpc3RpYyBtYXRjaGluZyBwcmlvcml0aXplcyBiYWNrdGljay1lbmNsb3NlZCBjb2RlIHRva2Vuc1xcbi0gWyBdIFJlY292ZXJ5IGRpYWdub3N0aWMgc3RyaW5nIHNob3dzIGdhcCBjb3VudFxcbi0gWyBdIEFsbCBhc3NlcnRpb25zIHBhc3NcXG5cXG4jIyBTdGVwc1xcblxcbjEuIERvIHN0dWZmXFxuXCIsXG4gICAgXCJ1dGYtOFwiLFxuICApO1xuICAvLyBTdW1tYXJ5IG1lbnRpb25zIFwiaGV1cmlzdGljXCIgYW5kIFwiZGlhZ25vc3RpY1wiIGJ1dCBub3QgXCJhc3NlcnRpb25zXCJcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKHRhc2tzRGlyNiwgXCJUMDEtU1VNTUFSWS5tZFwiKSxcbiAgICBcIiMgVDAxOiBBZGQgZGlhZ25vc3RpY3NcXG5cXG5JbXBsZW1lbnRlZCBoZXVyaXN0aWMgbWF0Y2hpbmcgZm9yIG11c3QtaGF2ZSBpdGVtcy4gUmVjb3ZlcnkgZGlhZ25vc3RpYyBzdHJpbmcgbm93IGluY2x1ZGVzIGdhcCBjb3VudHMuXFxuXCIsXG4gICAgXCJ1dGYtOFwiLFxuICApO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4obWhCYXNlLCBcIi5nc2RcIiwgXCJTVEFURS5tZFwiKSwgXCIjIyBOZXh0IEFjdGlvblxcbkV4ZWN1dGUgVDAyIGZvciBTMDU6IG5leHQgdGhpbmdcXG5cIiwgXCJ1dGYtOFwiKTtcblxuICBjbGVhclBhdGhDYWNoZSgpO1xuICBjb25zdCBzdGF0dXMgPSBhd2FpdCBpbnNwZWN0RXhlY3V0ZVRhc2tEdXJhYmlsaXR5KG1oQmFzZSwgXCJNMjAwL1MwNS9UMDFcIik7XG4gIGFzc2VydC5vayhzdGF0dXMgIT09IG51bGwsIFwibWgtc3Vic3RyOiBzdGF0dXMgZXhpc3RzXCIpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXR1cyEubXVzdEhhdmVDb3VudCwgMywgXCJtaC1zdWJzdHI6IG11c3RIYXZlQ291bnQgaXMgM1wiKTtcbiAgLy8gXCJoZXVyaXN0aWNcIiBhcHBlYXJzIGluIHN1bW1hcnkgZm9yIGl0ZW0gMSwgXCJkaWFnbm9zdGljXCIgZm9yIGl0ZW0gMiwgXG4gIC8vIFwiYXNzZXJ0aW9uc1wiIGFwcGVhcnMgaW4gc3VtbWFyeT8gTm8gXHUyMDE0IGxldCdzIGNoZWNrXG4gIC8vIEl0ZW0gMzogXCJBbGwgYXNzZXJ0aW9ucyBwYXNzXCIgXHUyMDE0IHdvcmRzOiBcImFzc2VydGlvbnNcIiwgXCJwYXNzXCIgKDw0IGNoYXJzIGV4Y2x1ZGVkKVxuICAvLyBzdW1tYXJ5IGRvZXNuJ3QgY29udGFpbiBcImFzc2VydGlvbnNcIiBcdTIxOTIgbm90IG1hdGNoZWRcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0dXMhLm11c3RIYXZlc01lbnRpb25lZEluU3VtbWFyeSwgMiwgXCJtaC1zdWJzdHI6IDIgb2YgMyBtYXRjaGVkIHZpYSBzdWJzdHJpbmdcIik7XG4gIGNvbnN0IGRpYWcgPSBmb3JtYXRFeGVjdXRlVGFza1JlY292ZXJ5U3RhdHVzKHN0YXR1cyEpO1xuICBhc3NlcnQub2soZGlhZy5pbmNsdWRlcyhcIm11c3QtaGF2ZSBnYXBcIiksIFwibWgtc3Vic3RyOiBkaWFnbm9zdGljIGluY2x1ZGVzIGdhcCBpbmZvXCIpO1xuICBhc3NlcnQub2soZGlhZy5pbmNsdWRlcyhcIjIgb2YgM1wiKSwgXCJtaC1zdWJzdHI6IGRpYWdub3N0aWMgaW5jbHVkZXMgJzIgb2YgMydcIik7XG59XG5cbmNvbnNvbGUubG9nKFwiXFxuPT09IHBlci1yZWNvcmQgbG9jazogc3RhbGUgLmxvY2sgaXMgcmVjbGFpbWVkLCBsaXN0IGlnbm9yZXMgLmxvY2sgZmlsZXMgPT09XCIpO1xue1xuICBjb25zdCB7IHV0aW1lc1N5bmMsIGV4aXN0c1N5bmM6IGxvY2tFeGlzdHMgfSA9IGF3YWl0IGltcG9ydChcIm5vZGU6ZnNcIik7XG4gIGNvbnN0IHsgbGlzdFVuaXRSdW50aW1lUmVjb3JkcyB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vdW5pdC1ydW50aW1lLnRzXCIpO1xuXG4gIC8vICgxKSBTdGFsZSAubG9jayBzaG91bGQgbm90IGJsb2NrIGEgbmV3IHdyaXRlci5cbiAgY29uc3QgbG9ja0Jhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1ydW50aW1lLWxvY2stdGVzdC1cIikpO1xuICB0cnkge1xuICAgIGNvbnN0IHVuaXRzRGlyID0gam9pbihsb2NrQmFzZSwgXCIuZ3NkXCIsIFwicnVudGltZVwiLCBcInVuaXRzXCIpO1xuICAgIG1rZGlyU3luYyh1bml0c0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgY29uc3QgcmVjb3JkUGF0aCA9IGpvaW4odW5pdHNEaXIsIFwiZXhlY3V0ZS10YXNrLU0wMDEtUzAxLVQwMS5qc29uXCIpO1xuICAgIGNvbnN0IGxvY2tQYXRoID0gcmVjb3JkUGF0aCArIFwiLmxvY2tcIjtcbiAgICB3cml0ZUZpbGVTeW5jKGxvY2tQYXRoLCBcIlwiKTtcbiAgICBjb25zdCBzdGFsZVRpbWUgPSBuZXcgRGF0ZShEYXRlLm5vdygpIC0gNjBfMDAwKTtcbiAgICB1dGltZXNTeW5jKGxvY2tQYXRoLCBzdGFsZVRpbWUsIHN0YWxlVGltZSk7XG5cbiAgICBjb25zdCB3cml0dGVuID0gd3JpdGVVbml0UnVudGltZVJlY29yZChsb2NrQmFzZSwgXCJleGVjdXRlLXRhc2tcIiwgXCJNMDAxL1MwMS9UMDFcIiwgMTAwMCwgeyBwaGFzZTogXCJkaXNwYXRjaGVkXCIgfSk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbCh3cml0dGVuLnBoYXNlLCBcImRpc3BhdGNoZWRcIiwgXCJzdGFsZS1sb2NrIHBhdGggc2hvdWxkIG5vdCBibG9jayB3cml0ZXJzXCIpO1xuXG4gICAgY29uc3QgcmVhZEJhY2sgPSByZWFkVW5pdFJ1bnRpbWVSZWNvcmQobG9ja0Jhc2UsIFwiZXhlY3V0ZS10YXNrXCIsIFwiTTAwMS9TMDEvVDAxXCIpO1xuICAgIGFzc2VydC5vayhyZWFkQmFjayAhPT0gbnVsbCwgXCJyZWNvcmQgcGVyc2lzdGVkIGFmdGVyIHN0ZWFsaW5nIHN0YWxlIGxvY2tcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGxvY2tFeGlzdHMobG9ja1BhdGgpLCBmYWxzZSwgXCJsb2NrIGZpbGUgcmVsZWFzZWQgYWZ0ZXIgd3JpdGUgY29tcGxldGVzXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhsb2NrQmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG5cbiAgLy8gKDIpIE9ycGhhbmVkIC5sb2NrIGZpbGVzIG11c3Qgbm90IGJlIHJldHVybmVkIGJ5IGxpc3RVbml0UnVudGltZVJlY29yZHMuXG4gIGNvbnN0IGxpc3RCYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtcnVudGltZS1saXN0LXRlc3QtXCIpKTtcbiAgdHJ5IHtcbiAgICB3cml0ZVVuaXRSdW50aW1lUmVjb3JkKGxpc3RCYXNlLCBcImV4ZWN1dGUtdGFza1wiLCBcIk0wMDIvUzAxL1QwMVwiLCAxMDAwLCB7IHBoYXNlOiBcImRpc3BhdGNoZWRcIiB9KTtcbiAgICBjb25zdCB1bml0c0RpciA9IGpvaW4obGlzdEJhc2UsIFwiLmdzZFwiLCBcInJ1bnRpbWVcIiwgXCJ1bml0c1wiKTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4odW5pdHNEaXIsIFwiZXhlY3V0ZS10YXNrLU0wMDItUzAxLVQwMS5qc29uLmxvY2tcIiksIFwiXCIpO1xuXG4gICAgY29uc3QgcmVjb3JkcyA9IGxpc3RVbml0UnVudGltZVJlY29yZHMobGlzdEJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChyZWNvcmRzLmxlbmd0aCwgMSwgXCJsaXN0VW5pdFJ1bnRpbWVSZWNvcmRzIGZpbHRlcnMgLmxvY2sgZmlsZXMgKG9ubHkgdGhlIC5qc29uIHJlY29yZClcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlY29yZHNbMF0udW5pdElkLCBcIk0wMDIvUzAxL1QwMVwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmMobGlzdEJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufVxuXG5ybVN5bmMobWhCYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG5ybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxhQUFhLFdBQVcsYUFBMkIsUUFBUSxxQkFBcUI7QUFDekYsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUN2QjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFDUCxTQUFTLGVBQWUsaUJBQWlCLGFBQWEsWUFBWSxvQkFBb0I7QUFDdEYsU0FBUyxzQkFBc0I7QUFFL0IsT0FBTyxZQUFZO0FBRW5CLE1BQU0sT0FBTyxZQUFZLEtBQUssT0FBTyxHQUFHLHdCQUF3QixDQUFDO0FBQ2pFLE1BQU0sV0FBVyxLQUFLLE1BQU0sUUFBUSxjQUFjLFFBQVEsVUFBVSxPQUFPLE9BQU87QUFDbEYsVUFBVSxVQUFVLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDdkMsY0FBYyxLQUFLLE1BQU0sUUFBUSxVQUFVLEdBQUcsdURBQXVELE9BQU87QUFDNUc7QUFBQSxFQUNFLEtBQUssTUFBTSxRQUFRLGNBQWMsUUFBUSxVQUFVLE9BQU8sYUFBYTtBQUFBLEVBQ3ZFO0FBQUEsRUFDQTtBQUNGO0FBRUEsUUFBUSxJQUFJLG9DQUFvQztBQUNoRDtBQUNFLFNBQU8sTUFBTSx1QkFBdUIsU0FBUyxHQUFHLE1BQU0sb0NBQW9DO0FBQzFGLFNBQU8s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
