import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { handleValidateMilestone } from "../tools/validate-milestone.js";
import { openDatabase, closeDatabase, _getAdapter, insertMilestone, insertSlice } from "../gsd-db.js";
import { clearPathCache } from "../paths.js";
import { clearParseCache } from "../files.js";
function makeTmpBase() {
  const base = join(tmpdir(), `gsd-val-handler-${randomUUID()}`);
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  return base;
}
const VALID_PARAMS = {
  milestoneId: "M001",
  verdict: "pass",
  remediationRound: 0,
  successCriteriaChecklist: "- [x] All pass",
  sliceDeliveryAudit: "| S01 | delivered |",
  crossSliceIntegration: "No issues",
  requirementCoverage: "All covered",
  verificationClasses: "- Contract: covered\n- Integration: covered\n- Operational: gap noted",
  verdictRationale: "Everything checks out"
};
describe("handleValidateMilestone write ordering (#2725)", () => {
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
  it("writes DB row and disk file on success", async () => {
    base = makeTmpBase();
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001" });
    const result = await handleValidateMilestone(VALID_PARAMS, base);
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    const adapter = _getAdapter();
    const row = adapter.prepare(
      `SELECT status, scope FROM assessments WHERE milestone_id = 'M001' AND scope = 'milestone-validation'`
    ).get();
    assert.ok(row, "assessment row should exist in DB");
    assert.equal(row.status, "pass");
    const filePath = join(base, ".gsd", "milestones", "M001", "M001-VALIDATION.md");
    assert.ok(existsSync(filePath), "VALIDATION.md should exist on disk");
    const validationMd = readFileSync(filePath, "utf-8");
    assert.match(validationMd, /## Verification Class Compliance/);
    assert.match(validationMd, /- Contract: covered/);
    assert.match(validationMd, /## Verdict Rationale/);
  });
  it("omits verification class section when no verification classes are supplied", async () => {
    base = makeTmpBase();
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001" });
    const result = await handleValidateMilestone(
      { ...VALID_PARAMS, verificationClasses: void 0 },
      base
    );
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    const filePath = join(base, ".gsd", "milestones", "M001", "M001-VALIDATION.md");
    const validationMd = readFileSync(filePath, "utf-8");
    assert.doesNotMatch(validationMd, /## Verification Class Compliance/);
  });
  it("keeps DB row and reports stale projection when disk write fails", async () => {
    base = makeTmpBase();
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001" });
    const milestoneDir = join(base, ".gsd", "milestones", "M001");
    rmSync(milestoneDir, { recursive: true, force: true });
    writeFileSync(milestoneDir, "not-a-directory");
    const result = await handleValidateMilestone(VALID_PARAMS, base);
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    assert.equal(result.stale, true, "result should report stale projection");
    const adapter = _getAdapter();
    const row = adapter.prepare(
      `SELECT status FROM assessments WHERE milestone_id = 'M001' AND scope = 'milestone-validation'`
    ).get();
    assert.ok(row, "assessment row should remain committed");
    assert.equal(row.status, "pass");
  });
  it("persists milestone validation gate_runs rows when UOK gates are enabled", async () => {
    base = makeTmpBase();
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001" });
    const result = await handleValidateMilestone(VALID_PARAMS, base, {
      uokGatesEnabled: true,
      traceId: "trace-val-1",
      turnId: "turn-val-1"
    });
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
    const adapter = _getAdapter();
    const row = adapter.prepare(
      `SELECT gate_id, outcome, failure_class, trace_id, turn_id
       FROM gate_runs
       WHERE gate_id = 'milestone-validation-gates'
       ORDER BY id DESC
       LIMIT 1`
    ).get();
    assert.ok(row, "milestone validation gate row should be persisted");
    assert.equal(row?.gate_id, "milestone-validation-gates");
    assert.equal(row?.outcome, "pass");
    assert.equal(row?.failure_class, "none");
    assert.equal(row?.trace_id, "trace-val-1");
    assert.equal(row?.turn_id, "turn-val-1");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy92YWxpZGF0ZS1taWxlc3RvbmUtd3JpdGUtb3JkZXIudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgZGVzY3JpYmUsIGl0LCBhZnRlckVhY2ggfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZGlyU3luYywgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSBcIm5vZGU6Y3J5cHRvXCI7XG5cbmltcG9ydCB7IGhhbmRsZVZhbGlkYXRlTWlsZXN0b25lIH0gZnJvbSBcIi4uL3Rvb2xzL3ZhbGlkYXRlLW1pbGVzdG9uZS5qc1wiO1xuaW1wb3J0IHsgb3BlbkRhdGFiYXNlLCBjbG9zZURhdGFiYXNlLCBfZ2V0QWRhcHRlciwgaW5zZXJ0TWlsZXN0b25lLCBpbnNlcnRTbGljZSB9IGZyb20gXCIuLi9nc2QtZGIuanNcIjtcbmltcG9ydCB7IGNsZWFyUGF0aENhY2hlIH0gZnJvbSBcIi4uL3BhdGhzLmpzXCI7XG5pbXBvcnQgeyBjbGVhclBhcnNlQ2FjaGUgfSBmcm9tIFwiLi4vZmlsZXMuanNcIjtcblxuZnVuY3Rpb24gbWFrZVRtcEJhc2UoKTogc3RyaW5nIHtcbiAgY29uc3QgYmFzZSA9IGpvaW4odG1wZGlyKCksIGBnc2QtdmFsLWhhbmRsZXItJHtyYW5kb21VVUlEKCl9YCk7XG4gIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgcmV0dXJuIGJhc2U7XG59XG5cbmNvbnN0IFZBTElEX1BBUkFNUyA9IHtcbiAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICB2ZXJkaWN0OiBcInBhc3NcIiBhcyBjb25zdCxcbiAgcmVtZWRpYXRpb25Sb3VuZDogMCxcbiAgc3VjY2Vzc0NyaXRlcmlhQ2hlY2tsaXN0OiBcIi0gW3hdIEFsbCBwYXNzXCIsXG4gIHNsaWNlRGVsaXZlcnlBdWRpdDogXCJ8IFMwMSB8IGRlbGl2ZXJlZCB8XCIsXG4gIGNyb3NzU2xpY2VJbnRlZ3JhdGlvbjogXCJObyBpc3N1ZXNcIixcbiAgcmVxdWlyZW1lbnRDb3ZlcmFnZTogXCJBbGwgY292ZXJlZFwiLFxuICB2ZXJpZmljYXRpb25DbGFzc2VzOiBcIi0gQ29udHJhY3Q6IGNvdmVyZWRcXG4tIEludGVncmF0aW9uOiBjb3ZlcmVkXFxuLSBPcGVyYXRpb25hbDogZ2FwIG5vdGVkXCIsXG4gIHZlcmRpY3RSYXRpb25hbGU6IFwiRXZlcnl0aGluZyBjaGVja3Mgb3V0XCIsXG59O1xuXG5kZXNjcmliZShcImhhbmRsZVZhbGlkYXRlTWlsZXN0b25lIHdyaXRlIG9yZGVyaW5nICgjMjcyNSlcIiwgKCkgPT4ge1xuICBsZXQgYmFzZTogc3RyaW5nO1xuXG4gIGFmdGVyRWFjaCgoKSA9PiB7XG4gICAgY2xlYXJQYXRoQ2FjaGUoKTtcbiAgICBjbGVhclBhcnNlQ2FjaGUoKTtcbiAgICB0cnkgeyBjbG9zZURhdGFiYXNlKCk7IH0gY2F0Y2ggeyAvKiAqLyB9XG4gICAgaWYgKGJhc2UpIHtcbiAgICAgIHRyeSB7IHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0gY2F0Y2ggeyAvKiAqLyB9XG4gICAgfVxuICB9KTtcblxuICBpdChcIndyaXRlcyBEQiByb3cgYW5kIGRpc2sgZmlsZSBvbiBzdWNjZXNzXCIsIGFzeW5jICgpID0+IHtcbiAgICBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgICBjb25zdCBkYlBhdGggPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcImdzZC5kYlwiKTtcbiAgICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIgfSk7XG4gICAgaW5zZXJ0U2xpY2UoeyBpZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlVmFsaWRhdGVNaWxlc3RvbmUoVkFMSURfUEFSQU1TLCBiYXNlKTtcbiAgICBhc3NlcnQub2soIShcImVycm9yXCIgaW4gcmVzdWx0KSwgYHVuZXhwZWN0ZWQgZXJyb3I6ICR7XCJlcnJvclwiIGluIHJlc3VsdCA/IHJlc3VsdC5lcnJvciA6IFwiXCJ9YCk7XG5cbiAgICAvLyBEQiByb3cgZXhpc3RzXG4gICAgY29uc3QgYWRhcHRlciA9IF9nZXRBZGFwdGVyKCkhO1xuICAgIGNvbnN0IHJvdyA9IGFkYXB0ZXIucHJlcGFyZShcbiAgICAgIGBTRUxFQ1Qgc3RhdHVzLCBzY29wZSBGUk9NIGFzc2Vzc21lbnRzIFdIRVJFIG1pbGVzdG9uZV9pZCA9ICdNMDAxJyBBTkQgc2NvcGUgPSAnbWlsZXN0b25lLXZhbGlkYXRpb24nYCxcbiAgICApLmdldCgpIGFzIHsgc3RhdHVzOiBzdHJpbmc7IHNjb3BlOiBzdHJpbmcgfSB8IHVuZGVmaW5lZDtcbiAgICBhc3NlcnQub2socm93LCBcImFzc2Vzc21lbnQgcm93IHNob3VsZCBleGlzdCBpbiBEQlwiKTtcbiAgICBhc3NlcnQuZXF1YWwocm93IS5zdGF0dXMsIFwicGFzc1wiKTtcblxuICAgIC8vIERpc2sgZmlsZSBleGlzdHNcbiAgICBjb25zdCBmaWxlUGF0aCA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJNMDAxLVZBTElEQVRJT04ubWRcIik7XG4gICAgYXNzZXJ0Lm9rKGV4aXN0c1N5bmMoZmlsZVBhdGgpLCBcIlZBTElEQVRJT04ubWQgc2hvdWxkIGV4aXN0IG9uIGRpc2tcIik7XG4gICAgY29uc3QgdmFsaWRhdGlvbk1kID0gcmVhZEZpbGVTeW5jKGZpbGVQYXRoLCBcInV0Zi04XCIpO1xuICAgIGFzc2VydC5tYXRjaCh2YWxpZGF0aW9uTWQsIC8jIyBWZXJpZmljYXRpb24gQ2xhc3MgQ29tcGxpYW5jZS8pO1xuICAgIGFzc2VydC5tYXRjaCh2YWxpZGF0aW9uTWQsIC8tIENvbnRyYWN0OiBjb3ZlcmVkLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKHZhbGlkYXRpb25NZCwgLyMjIFZlcmRpY3QgUmF0aW9uYWxlLyk7XG4gIH0pO1xuXG4gIGl0KFwib21pdHMgdmVyaWZpY2F0aW9uIGNsYXNzIHNlY3Rpb24gd2hlbiBubyB2ZXJpZmljYXRpb24gY2xhc3NlcyBhcmUgc3VwcGxpZWRcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICAgIGNvbnN0IGRiUGF0aCA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpO1xuICAgIG9wZW5EYXRhYmFzZShkYlBhdGgpO1xuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiB9KTtcbiAgICBpbnNlcnRTbGljZSh7IGlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVWYWxpZGF0ZU1pbGVzdG9uZShcbiAgICAgIHsgLi4uVkFMSURfUEFSQU1TLCB2ZXJpZmljYXRpb25DbGFzc2VzOiB1bmRlZmluZWQgfSxcbiAgICAgIGJhc2UsXG4gICAgKTtcbiAgICBhc3NlcnQub2soIShcImVycm9yXCIgaW4gcmVzdWx0KSwgYHVuZXhwZWN0ZWQgZXJyb3I6ICR7XCJlcnJvclwiIGluIHJlc3VsdCA/IHJlc3VsdC5lcnJvciA6IFwiXCJ9YCk7XG5cbiAgICBjb25zdCBmaWxlUGF0aCA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJNMDAxLVZBTElEQVRJT04ubWRcIik7XG4gICAgY29uc3QgdmFsaWRhdGlvbk1kID0gcmVhZEZpbGVTeW5jKGZpbGVQYXRoLCBcInV0Zi04XCIpO1xuICAgIGFzc2VydC5kb2VzTm90TWF0Y2godmFsaWRhdGlvbk1kLCAvIyMgVmVyaWZpY2F0aW9uIENsYXNzIENvbXBsaWFuY2UvKTtcbiAgfSk7XG5cbiAgaXQoXCJrZWVwcyBEQiByb3cgYW5kIHJlcG9ydHMgc3RhbGUgcHJvamVjdGlvbiB3aGVuIGRpc2sgd3JpdGUgZmFpbHNcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICAgIGNvbnN0IGRiUGF0aCA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpO1xuICAgIG9wZW5EYXRhYmFzZShkYlBhdGgpO1xuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiB9KTtcbiAgICBpbnNlcnRTbGljZSh7IGlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIgfSk7XG5cbiAgICAvLyBGb3JjZSBkaXNrIHdyaXRlIGZhaWx1cmUgYnkgcmVwbGFjaW5nIHRoZSBtaWxlc3RvbmUgZGlyZWN0b3J5IHdpdGggYVxuICAgIC8vIHJlZ3VsYXIgZmlsZS4gc2F2ZUZpbGUoKSB3aWxsIGZhaWwgYmVjYXVzZSBpdCBjYW5ub3Qgd3JpdGUgaW5zaWRlIGFcbiAgICAvLyBub24tZGlyZWN0b3J5LiBUaGlzIHdvcmtzIGNyb3NzLXBsYXRmb3JtIChjaG1vZCBpcyBpZ25vcmVkIG9uIFdpbmRvd3MpLlxuICAgIGNvbnN0IG1pbGVzdG9uZURpciA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIik7XG4gICAgcm1TeW5jKG1pbGVzdG9uZURpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMobWlsZXN0b25lRGlyLCBcIm5vdC1hLWRpcmVjdG9yeVwiKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZVZhbGlkYXRlTWlsZXN0b25lKFZBTElEX1BBUkFNUywgYmFzZSk7XG5cbiAgICBhc3NlcnQub2soIShcImVycm9yXCIgaW4gcmVzdWx0KSwgYHVuZXhwZWN0ZWQgZXJyb3I6ICR7XCJlcnJvclwiIGluIHJlc3VsdCA/IHJlc3VsdC5lcnJvciA6IFwiXCJ9YCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zdGFsZSwgdHJ1ZSwgXCJyZXN1bHQgc2hvdWxkIHJlcG9ydCBzdGFsZSBwcm9qZWN0aW9uXCIpO1xuXG4gICAgY29uc3QgYWRhcHRlciA9IF9nZXRBZGFwdGVyKCkhO1xuICAgIGNvbnN0IHJvdyA9IGFkYXB0ZXIucHJlcGFyZShcbiAgICAgIGBTRUxFQ1Qgc3RhdHVzIEZST00gYXNzZXNzbWVudHMgV0hFUkUgbWlsZXN0b25lX2lkID0gJ00wMDEnIEFORCBzY29wZSA9ICdtaWxlc3RvbmUtdmFsaWRhdGlvbidgLFxuICAgICkuZ2V0KCkgYXMgeyBzdGF0dXM6IHN0cmluZyB9IHwgdW5kZWZpbmVkO1xuICAgIGFzc2VydC5vayhyb3csIFwiYXNzZXNzbWVudCByb3cgc2hvdWxkIHJlbWFpbiBjb21taXR0ZWRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJvdyEuc3RhdHVzLCBcInBhc3NcIik7XG4gIH0pO1xuXG4gIGl0KFwicGVyc2lzdHMgbWlsZXN0b25lIHZhbGlkYXRpb24gZ2F0ZV9ydW5zIHJvd3Mgd2hlbiBVT0sgZ2F0ZXMgYXJlIGVuYWJsZWRcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICAgIGNvbnN0IGRiUGF0aCA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpO1xuICAgIG9wZW5EYXRhYmFzZShkYlBhdGgpO1xuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiB9KTtcbiAgICBpbnNlcnRTbGljZSh7IGlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVWYWxpZGF0ZU1pbGVzdG9uZShWQUxJRF9QQVJBTVMsIGJhc2UsIHtcbiAgICAgIHVva0dhdGVzRW5hYmxlZDogdHJ1ZSxcbiAgICAgIHRyYWNlSWQ6IFwidHJhY2UtdmFsLTFcIixcbiAgICAgIHR1cm5JZDogXCJ0dXJuLXZhbC0xXCIsXG4gICAgfSk7XG4gICAgYXNzZXJ0Lm9rKCEoXCJlcnJvclwiIGluIHJlc3VsdCksIGB1bmV4cGVjdGVkIGVycm9yOiAke1wiZXJyb3JcIiBpbiByZXN1bHQgPyByZXN1bHQuZXJyb3IgOiBcIlwifWApO1xuXG4gICAgY29uc3QgYWRhcHRlciA9IF9nZXRBZGFwdGVyKCkhO1xuICAgIGNvbnN0IHJvdyA9IGFkYXB0ZXIucHJlcGFyZShcbiAgICAgIGBTRUxFQ1QgZ2F0ZV9pZCwgb3V0Y29tZSwgZmFpbHVyZV9jbGFzcywgdHJhY2VfaWQsIHR1cm5faWRcbiAgICAgICBGUk9NIGdhdGVfcnVuc1xuICAgICAgIFdIRVJFIGdhdGVfaWQgPSAnbWlsZXN0b25lLXZhbGlkYXRpb24tZ2F0ZXMnXG4gICAgICAgT1JERVIgQlkgaWQgREVTQ1xuICAgICAgIExJTUlUIDFgLFxuICAgICkuZ2V0KCkgYXNcbiAgICAgIHwge1xuICAgICAgICAgIGdhdGVfaWQ6IHN0cmluZztcbiAgICAgICAgICBvdXRjb21lOiBzdHJpbmc7XG4gICAgICAgICAgZmFpbHVyZV9jbGFzczogc3RyaW5nO1xuICAgICAgICAgIHRyYWNlX2lkOiBzdHJpbmc7XG4gICAgICAgICAgdHVybl9pZDogc3RyaW5nO1xuICAgICAgICB9XG4gICAgICB8IHVuZGVmaW5lZDtcblxuICAgIGFzc2VydC5vayhyb3csIFwibWlsZXN0b25lIHZhbGlkYXRpb24gZ2F0ZSByb3cgc2hvdWxkIGJlIHBlcnNpc3RlZFwiKTtcbiAgICBhc3NlcnQuZXF1YWwocm93Py5nYXRlX2lkLCBcIm1pbGVzdG9uZS12YWxpZGF0aW9uLWdhdGVzXCIpO1xuICAgIGFzc2VydC5lcXVhbChyb3c/Lm91dGNvbWUsIFwicGFzc1wiKTtcbiAgICBhc3NlcnQuZXF1YWwocm93Py5mYWlsdXJlX2NsYXNzLCBcIm5vbmVcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJvdz8udHJhY2VfaWQsIFwidHJhY2UtdmFsLTFcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJvdz8udHVybl9pZCwgXCJ0dXJuLXZhbC0xXCIpO1xuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxVQUFVLElBQUksaUJBQWlCO0FBQ3hDLE9BQU8sWUFBWTtBQUNuQixTQUFTLFdBQVcsWUFBWSxjQUFjLFFBQVEscUJBQXFCO0FBQzNFLFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFDdkIsU0FBUyxrQkFBa0I7QUFFM0IsU0FBUywrQkFBK0I7QUFDeEMsU0FBUyxjQUFjLGVBQWUsYUFBYSxpQkFBaUIsbUJBQW1CO0FBQ3ZGLFNBQVMsc0JBQXNCO0FBQy9CLFNBQVMsdUJBQXVCO0FBRWhDLFNBQVMsY0FBc0I7QUFDN0IsUUFBTSxPQUFPLEtBQUssT0FBTyxHQUFHLG1CQUFtQixXQUFXLENBQUMsRUFBRTtBQUM3RCxZQUFVLEtBQUssTUFBTSxRQUFRLGNBQWMsTUFBTSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDdkUsU0FBTztBQUNUO0FBRUEsTUFBTSxlQUFlO0FBQUEsRUFDbkIsYUFBYTtBQUFBLEVBQ2IsU0FBUztBQUFBLEVBQ1Qsa0JBQWtCO0FBQUEsRUFDbEIsMEJBQTBCO0FBQUEsRUFDMUIsb0JBQW9CO0FBQUEsRUFDcEIsdUJBQXVCO0FBQUEsRUFDdkIscUJBQXFCO0FBQUEsRUFDckIscUJBQXFCO0FBQUEsRUFDckIsa0JBQWtCO0FBQ3BCO0FBRUEsU0FBUyxrREFBa0QsTUFBTTtBQUMvRCxNQUFJO0FBRUosWUFBVSxNQUFNO0FBQ2QsbUJBQWU7QUFDZixvQkFBZ0I7QUFDaEIsUUFBSTtBQUFFLG9CQUFjO0FBQUEsSUFBRyxRQUFRO0FBQUEsSUFBUTtBQUN2QyxRQUFJLE1BQU07QUFDUixVQUFJO0FB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
