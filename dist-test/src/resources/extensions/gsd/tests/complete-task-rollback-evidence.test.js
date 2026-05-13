import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { handleCompleteTask } from "../tools/complete-task.js";
import {
  openDatabase,
  closeDatabase,
  _getAdapter,
  insertMilestone,
  insertSlice
} from "../gsd-db.js";
import { clearPathCache } from "../paths.js";
import { clearParseCache } from "../files.js";
function makeTmpBase() {
  const base = join(tmpdir(), `gsd-ct-rollback-${randomUUID()}`);
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  return base;
}
const VALID_PARAMS = {
  milestoneId: "M001",
  sliceId: "S01",
  taskId: "T01",
  oneLiner: "Test task",
  narrative: "Did the thing",
  verification: "Checked it",
  deviations: "None.",
  knownIssues: "None.",
  keyFiles: ["src/foo.ts"],
  keyDecisions: ["Used approach A"],
  blockerDiscovered: false,
  verificationEvidence: [
    { command: "npm test", exitCode: 0, verdict: "\u2705 pass", durationMs: 1e3 },
    { command: "npm run lint", exitCode: 0, verdict: "\u2705 pass", durationMs: 500 }
  ]
};
describe("complete-task projection failures keep DB completion committed", () => {
  let base;
  afterEach(() => {
    clearPathCache();
    clearParseCache();
    try {
      closeDatabase();
    } catch {
    }
    if (base) {
      try {
        rmSync(base, { recursive: true, force: true });
      } catch {
      }
    }
  });
  it("inserts verification_evidence rows on success", async () => {
    base = makeTmpBase();
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001" });
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"),
      "# S01 Plan\n\n## Tasks\n\n- [ ] **T01: Test task**\n"
    );
    const result = await handleCompleteTask(VALID_PARAMS, base);
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    const adapter = _getAdapter();
    const rows = adapter.prepare(
      `SELECT * FROM verification_evidence WHERE task_id = 'T01' AND slice_id = 'S01' AND milestone_id = 'M001'`
    ).all();
    assert.equal(rows.length, 2, "should have 2 evidence rows after success");
  });
  it("keeps task completion and verification_evidence when disk projection write fails", async () => {
    base = makeTmpBase();
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001" });
    const tasksDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    rmSync(tasksDir, { recursive: true, force: true });
    writeFileSync(tasksDir, "not-a-directory");
    const result = await handleCompleteTask(VALID_PARAMS, base);
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    assert.equal(result.stale, true, "result should report stale projection");
    const adapter = _getAdapter();
    const task = adapter.prepare(
      `SELECT status FROM tasks WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'`
    ).get();
    assert.ok(task, "task row should still exist");
    assert.equal(task.status, "complete", "task status should remain complete");
    const evidenceRows = adapter.prepare(
      `SELECT * FROM verification_evidence WHERE task_id = 'T01' AND slice_id = 'S01' AND milestone_id = 'M001'`
    ).all();
    assert.equal(evidenceRows.length, 2, "verification_evidence should remain committed");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jb21wbGV0ZS10YXNrLXJvbGxiYWNrLWV2aWRlbmNlLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IGRlc2NyaWJlLCBpdCwgYWZ0ZXJFYWNoIH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2RpclN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcblxuaW1wb3J0IHsgaGFuZGxlQ29tcGxldGVUYXNrIH0gZnJvbSBcIi4uL3Rvb2xzL2NvbXBsZXRlLXRhc2suanNcIjtcbmltcG9ydCB7XG4gIG9wZW5EYXRhYmFzZSxcbiAgY2xvc2VEYXRhYmFzZSxcbiAgX2dldEFkYXB0ZXIsXG4gIGluc2VydE1pbGVzdG9uZSxcbiAgaW5zZXJ0U2xpY2UsXG59IGZyb20gXCIuLi9nc2QtZGIuanNcIjtcbmltcG9ydCB7IGNsZWFyUGF0aENhY2hlIH0gZnJvbSBcIi4uL3BhdGhzLmpzXCI7XG5pbXBvcnQgeyBjbGVhclBhcnNlQ2FjaGUgfSBmcm9tIFwiLi4vZmlsZXMuanNcIjtcblxuZnVuY3Rpb24gbWFrZVRtcEJhc2UoKTogc3RyaW5nIHtcbiAgY29uc3QgYmFzZSA9IGpvaW4odG1wZGlyKCksIGBnc2QtY3Qtcm9sbGJhY2stJHtyYW5kb21VVUlEKCl9YCk7XG4gIC8vIENyZWF0ZSB0aGUgZnVsbCB0YXNrcyBkaXJlY3Rvcnkgc28gdGhlIHN1Y2Nlc3MgcGF0aCB3b3Jrc1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiLCBcInRhc2tzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgcmV0dXJuIGJhc2U7XG59XG5cbmNvbnN0IFZBTElEX1BBUkFNUyA9IHtcbiAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICBzbGljZUlkOiBcIlMwMVwiLFxuICB0YXNrSWQ6IFwiVDAxXCIsXG4gIG9uZUxpbmVyOiBcIlRlc3QgdGFza1wiLFxuICBuYXJyYXRpdmU6IFwiRGlkIHRoZSB0aGluZ1wiLFxuICB2ZXJpZmljYXRpb246IFwiQ2hlY2tlZCBpdFwiLFxuICBkZXZpYXRpb25zOiBcIk5vbmUuXCIsXG4gIGtub3duSXNzdWVzOiBcIk5vbmUuXCIsXG4gIGtleUZpbGVzOiBbXCJzcmMvZm9vLnRzXCJdLFxuICBrZXlEZWNpc2lvbnM6IFtcIlVzZWQgYXBwcm9hY2ggQVwiXSxcbiAgYmxvY2tlckRpc2NvdmVyZWQ6IGZhbHNlLFxuICB2ZXJpZmljYXRpb25FdmlkZW5jZTogW1xuICAgIHsgY29tbWFuZDogXCJucG0gdGVzdFwiLCBleGl0Q29kZTogMCwgdmVyZGljdDogXCJcdTI3MDUgcGFzc1wiLCBkdXJhdGlvbk1zOiAxMDAwIH0sXG4gICAgeyBjb21tYW5kOiBcIm5wbSBydW4gbGludFwiLCBleGl0Q29kZTogMCwgdmVyZGljdDogXCJcdTI3MDUgcGFzc1wiLCBkdXJhdGlvbk1zOiA1MDAgfSxcbiAgXSxcbn07XG5cbmRlc2NyaWJlKFwiY29tcGxldGUtdGFzayBwcm9qZWN0aW9uIGZhaWx1cmVzIGtlZXAgREIgY29tcGxldGlvbiBjb21taXR0ZWRcIiwgKCkgPT4ge1xuICBsZXQgYmFzZTogc3RyaW5nO1xuXG4gIGFmdGVyRWFjaCgoKSA9PiB7XG4gICAgY2xlYXJQYXRoQ2FjaGUoKTtcbiAgICBjbGVhclBhcnNlQ2FjaGUoKTtcbiAgICB0cnkgeyBjbG9zZURhdGFiYXNlKCk7IH0gY2F0Y2ggeyAvKiAqLyB9XG4gICAgaWYgKGJhc2UpIHtcbiAgICAgIHRyeSB7IHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0gY2F0Y2ggeyAvKiAqLyB9XG4gICAgfVxuICB9KTtcblxuICBpdChcImluc2VydHMgdmVyaWZpY2F0aW9uX2V2aWRlbmNlIHJvd3Mgb24gc3VjY2Vzc1wiLCBhc3luYyAoKSA9PiB7XG4gICAgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gICAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpKTtcbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIgfSk7XG4gICAgaW5zZXJ0U2xpY2UoeyBpZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiIH0pO1xuXG4gICAgLy8gV3JpdGUgYSBtaW5pbWFsIHNsaWNlIHBsYW4gc28gcmVuZGVyUGxhbkNoZWNrYm94ZXMgZG9lc24ndCBlcnJvclxuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIsIFwiUzAxLVBMQU4ubWRcIiksXG4gICAgICBcIiMgUzAxIFBsYW5cXG5cXG4jIyBUYXNrc1xcblxcbi0gWyBdICoqVDAxOiBUZXN0IHRhc2sqKlxcblwiLFxuICAgICk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVDb21wbGV0ZVRhc2soVkFMSURfUEFSQU1TLCBiYXNlKTtcbiAgICBhc3NlcnQub2soIShcImVycm9yXCIgaW4gcmVzdWx0KSwgYHVuZXhwZWN0ZWQgZXJyb3I6ICR7XCJlcnJvclwiIGluIHJlc3VsdCA/IHJlc3VsdC5lcnJvciA6IFwiXCJ9YCk7XG5cbiAgICBjb25zdCBhZGFwdGVyID0gX2dldEFkYXB0ZXIoKSE7XG4gICAgY29uc3Qgcm93cyA9IGFkYXB0ZXIucHJlcGFyZShcbiAgICAgIGBTRUxFQ1QgKiBGUk9NIHZlcmlmaWNhdGlvbl9ldmlkZW5jZSBXSEVSRSB0YXNrX2lkID0gJ1QwMScgQU5EIHNsaWNlX2lkID0gJ1MwMScgQU5EIG1pbGVzdG9uZV9pZCA9ICdNMDAxJ2AsXG4gICAgKS5hbGwoKTtcbiAgICBhc3NlcnQuZXF1YWwocm93cy5sZW5ndGgsIDIsIFwic2hvdWxkIGhhdmUgMiBldmlkZW5jZSByb3dzIGFmdGVyIHN1Y2Nlc3NcIik7XG4gIH0pO1xuXG4gIGl0KFwia2VlcHMgdGFzayBjb21wbGV0aW9uIGFuZCB2ZXJpZmljYXRpb25fZXZpZGVuY2Ugd2hlbiBkaXNrIHByb2plY3Rpb24gd3JpdGUgZmFpbHNcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICAgIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsIFwiLmdzZFwiLCBcImdzZC5kYlwiKSk7XG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiIH0pO1xuICAgIGluc2VydFNsaWNlKHsgaWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiB9KTtcblxuICAgIC8vIFJlcGxhY2UgdGhlIHRhc2tzIGRpcmVjdG9yeSB3aXRoIGEgZmlsZSBzbyBkaXNrIHdyaXRlIGZhaWxzIChjcm9zcy1wbGF0Zm9ybSlcbiAgICBjb25zdCB0YXNrc0RpciA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIiwgXCJ0YXNrc1wiKTtcbiAgICBybVN5bmModGFza3NEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKHRhc2tzRGlyLCBcIm5vdC1hLWRpcmVjdG9yeVwiKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZUNvbXBsZXRlVGFzayhWQUxJRF9QQVJBTVMsIGJhc2UpO1xuICAgIGFzc2VydC5vayghKFwiZXJyb3JcIiBpbiByZXN1bHQpLCBgdW5leHBlY3RlZCBlcnJvcjogJHtcImVycm9yXCIgaW4gcmVzdWx0ID8gcmVzdWx0LmVycm9yIDogXCJcIn1gKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnN0YWxlLCB0cnVlLCBcInJlc3VsdCBzaG91bGQgcmVwb3J0IHN0YWxlIHByb2plY3Rpb25cIik7XG5cbiAgICBjb25zdCBhZGFwdGVyID0gX2dldEFkYXB0ZXIoKSE7XG4gICAgY29uc3QgdGFzayA9IGFkYXB0ZXIucHJlcGFyZShcbiAgICAgIGBTRUxFQ1Qgc3RhdHVzIEZST00gdGFza3MgV0hFUkUgbWlsZXN0b25lX2lkID0gJ00wMDEnIEFORCBzbGljZV9pZCA9ICdTMDEnIEFORCBpZCA9ICdUMDEnYCxcbiAgICApLmdldCgpIGFzIHsgc3RhdHVzOiBzdHJpbmcgfSB8IHVuZGVmaW5lZDtcbiAgICBhc3NlcnQub2sodGFzaywgXCJ0YXNrIHJvdyBzaG91bGQgc3RpbGwgZXhpc3RcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHRhc2shLnN0YXR1cywgXCJjb21wbGV0ZVwiLCBcInRhc2sgc3RhdHVzIHNob3VsZCByZW1haW4gY29tcGxldGVcIik7XG5cbiAgICBjb25zdCBldmlkZW5jZVJvd3MgPSBhZGFwdGVyLnByZXBhcmUoXG4gICAgICBgU0VMRUNUICogRlJPTSB2ZXJpZmljYXRpb25fZXZpZGVuY2UgV0hFUkUgdGFza19pZCA9ICdUMDEnIEFORCBzbGljZV9pZCA9ICdTMDEnIEFORCBtaWxlc3RvbmVfaWQgPSAnTTAwMSdgLFxuICAgICkuYWxsKCk7XG4gICAgYXNzZXJ0LmVxdWFsKGV2aWRlbmNlUm93cy5sZW5ndGgsIDIsIFwidmVyaWZpY2F0aW9uX2V2aWRlbmNlIHNob3VsZCByZW1haW4gY29tbWl0dGVkXCIpO1xuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxVQUFVLElBQUksaUJBQWlCO0FBQ3hDLE9BQU8sWUFBWTtBQUNuQixTQUFTLFdBQVcsUUFBUSxxQkFBcUI7QUFDakQsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUN2QixTQUFTLGtCQUFrQjtBQUUzQixTQUFTLDBCQUEwQjtBQUNuQztBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUNQLFNBQVMsc0JBQXNCO0FBQy9CLFNBQVMsdUJBQXVCO0FBRWhDLFNBQVMsY0FBc0I7QUFDN0IsUUFBTSxPQUFPLEtBQUssT0FBTyxHQUFHLG1CQUFtQixXQUFXLENBQUMsRUFBRTtBQUU3RCxZQUFVLEtBQUssTUFBTSxRQUFRLGNBQWMsUUFBUSxVQUFVLE9BQU8sT0FBTyxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDakcsU0FBTztBQUNUO0FBRUEsTUFBTSxlQUFlO0FBQUEsRUFDbkIsYUFBYTtBQUFBLEVBQ2IsU0FBUztBQUFBLEVBQ1QsUUFBUTtBQUFBLEVBQ1IsVUFBVTtBQUFBLEVBQ1YsV0FBVztBQUFBLEVBQ1gsY0FBYztBQUFBLEVBQ2QsWUFBWTtBQUFBLEVBQ1osYUFBYTtBQUFBLEVBQ2IsVUFBVSxDQUFDLFlBQVk7QUFBQSxFQUN2QixjQUFjLENBQUMsaUJBQWlCO0FBQUEsRUFDaEMsbUJBQW1CO0FBQUEsRUFDbkIsc0JBQXNCO0FBQUEsSUFDcEIsRUFBRSxTQUFTLFlBQVksVUFBVSxHQUFHLFNBQVMsZUFBVSxZQUFZLElBQUs7QUFBQSxJQUN4RSxFQUFFLFNBQVMsZ0JBQWdCLFVBQVUsR0FBRyxTQUFTLGVBQVUsWUFBWSxJQUFJO0FBQUEsRUFDN0U7QUFDRjtBQUVBLFNBQVMsa0VBQWtFLE1BQU07QUFDL0UsTUFBSTtBQUVKLFlBQVUsTUFBTTtBQUNkLG1CQUFlO0FBQ2Ysb0JBQWdCO0FBQ2hCLFFBQUk7QUFBRSxvQkFBYztBQUFBLElBQUcsUUFBUTtBQUFBLElBQVE7QUFDdkMsUUFBSSxNQUFNO0FBQ1IsVUFBSTtBQUFFLGVBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLE1BQUcsUUFBUTtBQUFBLE1BQVE7QUFBQSxJQUN4RTtBQUFBLEVBQ0YsQ0FBQztBQUVELEtBQUcsaURBQWlELFlBQVk7QUFDOUQsV0FBTyxZQUFZO0FBQ25CLGlCQUFhLEtBQUssTUFBTSxRQUFRLFFBQVEsQ0FBQztBQUN6QyxvQkFBZ0IsRUFBRSxJQUFJLE9BQU8sQ0FBQztBQUM5QixnQkFBWSxFQUFFLElBQUksT0FBTyxhQUFhLE9BQU8sQ0FBQztBQUc5QztBQUFBLE1BQ0UsS0FBSyxNQUFNLFFBQVEsY0FBYyxRQUFRLFVBQVUsT0FBTyxhQUFhO0FBQUEsTUFDdkU7QUFBQSxJQUNGO0FBRUEsVUFBTSxTQUFTLE1BQU0sbUJBQW1CLGNBQWMsSUFBSTtBQUMxRCxXQUFPLEdBQUcsRUFBRSxXQUFXLFNBQVMscUJBQXFCLFdBQVcsU0FBUyxPQUFPLFFBQVEsRUFBRSxFQUFFO0FBRTVGLFVBQU0sVUFBVSxZQUFZO0FBQzVCLFVBQU0sT0FBTyxRQUFRO0FBQUEsTUFDbkI7QUFBQSxJQUNGLEVBQUUsSUFBSTtBQUNOLFdBQU8sTUFBTSxLQUFLLFFBQVEsR0FBRywyQ0FBMkM7QUFBQSxFQUMxRSxDQUFDO0FBRUQsS0FBRyxvRkFBb0YsWUFBWTtBQUNqRyxXQUFPLFlBQVk7QUFDbkIsaUJBQWEsS0FBSyxNQUFNLFFBQVEsUUFBUSxDQUFDO0FBQ3pDLG9CQUFnQixFQUFFLElBQUksT0FBTyxDQUFDO0FBQzlCLGdCQUFZLEVBQUUsSUFBSSxPQUFPLGFBQWEsT0FBTyxDQUFDO0FBRzlDLFVBQU0sV0FBVyxLQUFLLE1BQU0sUUFBUSxjQUFjLFFBQVEsVUFBVSxPQUFPLE9BQU87QUFDbEYsV0FBTyxVQUFVLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQ2pELGtCQUFjLFVBQVUsaUJBQWlCO0FBRXpDLFVBQU0sU0FBUyxNQUFNLG1CQUFtQixjQUFjLElBQUk7QUFDMUQsV0FBTyxHQUFHLEVBQUUsV0FBVyxTQUFTLHFCQUFxQixXQUFXLFNBQVMsT0FBTyxRQUFRLEVBQUUsRUFBRTtBQUM1RixXQUFPLE1BQU0sT0FBTyxPQUFPLE1BQU0sdUNBQXVDO0FBRXhFLFVBQU0sVUFBVSxZQUFZO0FBQzVCLFVBQU0sT0FBTyxRQUFRO0FBQUEsTUFDbkI7QUFBQSxJQUNGLEVBQUUsSUFBSTtBQUNOLFdBQU8sR0FBRyxNQUFNLDZCQUE2QjtBQUM3QyxXQUFPLE1BQU0sS0FBTSxRQUFRLFlBQVksb0NBQW9DO0FBRTNFLFVBQU0sZUFBZSxRQUFRO0FBQUEsTUFDM0I7QUFBQSxJQUNGLEVBQUUsSUFBSTtBQUNOLFdBQU8sTUFBTSxhQUFhLFFBQVEsR0FBRywrQ0FBK0M7QUFBQSxFQUN0RixDQUFDO0FBQ0gsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
