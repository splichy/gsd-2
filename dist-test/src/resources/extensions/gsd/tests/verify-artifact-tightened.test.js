import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyExpectedArtifact } from "../auto-recovery.js";
import { closeDatabase, insertMilestone, insertSlice, insertTask, isDbAvailable, openDatabase } from "../gsd-db.js";
function scaffoldProject(t) {
  const base = mkdtempSync(join(tmpdir(), "gsd-verify-artifact-"));
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  mkdirSync(join(sliceDir, "tasks"), { recursive: true });
  writeFileSync(join(sliceDir, "tasks", "T01-SUMMARY.md"), "# T01 summary\n");
  return { base, planPath: join(sliceDir, "S01-PLAN.md") };
}
test("#3607: execute-task legacy branch \u2014 checked checkbox [x] passes verification", (t) => {
  closeDatabase();
  assert.equal(isDbAvailable(), false, "DB must be closed to hit legacy branch");
  const { base, planPath } = scaffoldProject(t);
  writeFileSync(
    planPath,
    [
      "# S01 plan",
      "",
      "- [x] **T01: Implement feature**",
      ""
    ].join("\n")
  );
  assert.equal(
    verifyExpectedArtifact("execute-task", "M001/S01/T01", base),
    true,
    "checked checkbox [x] is accepted as completion evidence"
  );
});
test("#3607: execute-task legacy branch \u2014 checked checkbox [X] (uppercase) also passes", (t) => {
  closeDatabase();
  const { base, planPath } = scaffoldProject(t);
  writeFileSync(
    planPath,
    [
      "# S01 plan",
      "",
      "- [X] **T01: Implement feature**"
    ].join("\n")
  );
  assert.equal(
    verifyExpectedArtifact("execute-task", "M001/S01/T01", base),
    true,
    "uppercase [X] checkbox is accepted"
  );
});
test("#3607: execute-task legacy branch \u2014 unchecked checkbox [ ] is rejected", (t) => {
  closeDatabase();
  const { base, planPath } = scaffoldProject(t);
  writeFileSync(
    planPath,
    [
      "# S01 plan",
      "",
      "- [ ] **T01: Implement feature**"
    ].join("\n")
  );
  assert.equal(
    verifyExpectedArtifact("execute-task", "M001/S01/T01", base),
    false,
    "unchecked checkbox [ ] must not pass verification (#3607)"
  );
});
test("#3607: execute-task legacy branch \u2014 bare heading ### T01 is no longer sufficient", (t) => {
  closeDatabase();
  const { base, planPath } = scaffoldProject(t);
  writeFileSync(
    planPath,
    [
      "# S01 plan",
      "",
      "### T01 -- Implement feature",
      "",
      "Some description here, but no checkbox."
    ].join("\n")
  );
  assert.equal(
    verifyExpectedArtifact("execute-task", "M001/S01/T01", base),
    false,
    "heading alone must not pass verification after #3607 fix"
  );
});
test("#3607: execute-task legacy branch \u2014 missing plan file returns false", (t) => {
  closeDatabase();
  const { base } = scaffoldProject(t);
  assert.equal(
    verifyExpectedArtifact("execute-task", "M001/S01/T01", base),
    false,
    "missing plan file must cause verification to return false"
  );
});
test("#3607: execute-task legacy branch \u2014 wrong task id in checkbox does not match", (t) => {
  closeDatabase();
  const { base, planPath } = scaffoldProject(t);
  writeFileSync(
    planPath,
    [
      "# S01 plan",
      "",
      "- [x] **T02: Some other task**"
    ].join("\n")
  );
  assert.equal(
    verifyExpectedArtifact("execute-task", "M001/S01/T01", base),
    false,
    "checkbox for a different task id must not count as T01 completion"
  );
});
test("execute-task DB lag branch \u2014 pending DB status can verify from checked plan plus summary", (t) => {
  closeDatabase();
  const { base, planPath } = scaffoldProject(t);
  openDatabase(join(base, ".gsd", "gsd.db"));
  assert.equal(isDbAvailable(), true, "DB must be open to hit the DB-lag branch");
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Implement feature", status: "pending" });
  writeFileSync(
    planPath,
    [
      "# S01 plan",
      "",
      "- [x] **T01: Implement feature**"
    ].join("\n")
  );
  assert.equal(
    verifyExpectedArtifact("execute-task", "M001/S01/T01", base),
    true,
    "checked plan entry plus summary should verify while DB reconcile catches up"
  );
});
test("execute-task DB lag branch \u2014 summary without checked plan still fails", (t) => {
  closeDatabase();
  const { base, planPath } = scaffoldProject(t);
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Implement feature", status: "pending" });
  writeFileSync(
    planPath,
    [
      "# S01 plan",
      "",
      "- [ ] **T01: Implement feature**"
    ].join("\n")
  );
  assert.equal(
    verifyExpectedArtifact("execute-task", "M001/S01/T01", base),
    false,
    "pending DB status plus summary is insufficient without a checked task checkbox"
  );
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy92ZXJpZnktYXJ0aWZhY3QtdGlnaHRlbmVkLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogUmVncmVzc2lvbiB0ZXN0IGZvciAjMzYwNyBcdTIwMTQgdGlnaHRlbiB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0IGxlZ2FjeSBicmFuY2guXG4gKlxuICogVGhlIGxlZ2FjeSAocHJlLW1pZ3JhdGlvbikgZmFsbGJhY2sgaW4gdmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdCBwcmV2aW91c2x5XG4gKiBhY2NlcHRlZCBlaXRoZXIgYSBoZWFkaW5nIG1hdGNoICgjIyMgVDAxIC0tKSBvciBhIGNoZWNrZWQgY2hlY2tib3ggYXMgcHJvb2ZcbiAqIHRoYXQgZ3NkX2NvbXBsZXRlX3Rhc2sgcmFuLiBBIGhlYWRpbmcgYWxvbmUgZG9lcyBub3QgcHJvdmUgY29tcGxldGlvbiBcdTIwMTRcbiAqIGl0IGNvdWxkIHJlc3VsdCBmcm9tIGEgcm9ndWUgd3JpdGUuXG4gKlxuICogVGhlc2UgdGVzdHMgZXhlcmNpc2UgdmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdCBkaXJlY3RseSBmb3IgZXhlY3V0ZS10YXNrIHVuaXRzXG4gKiB3aGVuIHRoZSBEQiBpcyB1bmF2YWlsYWJsZSAobGVnYWN5IGJyYW5jaCkuIE9ubHkgYSBjaGVja2VkIGNoZWNrYm94IGluIHRoZVxuICogc2xpY2UgcGxhbiBjb3VudHMgYXMgZXZpZGVuY2Ugb2YgY29tcGxldGlvbjsgYSBiYXJlIGhlYWRpbmcgb3IgYW4gdW5jaGVja2VkXG4gKiBjaGVja2JveCBtdXN0IG5vdCBwYXNzLlxuICovXG5cbmltcG9ydCB7IHRlc3QgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBta2RpclN5bmMsIHdyaXRlRmlsZVN5bmMsIHJtU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcblxuaW1wb3J0IHsgdmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdCB9IGZyb20gXCIuLi9hdXRvLXJlY292ZXJ5LnRzXCI7XG5pbXBvcnQgeyBjbG9zZURhdGFiYXNlLCBpbnNlcnRNaWxlc3RvbmUsIGluc2VydFNsaWNlLCBpbnNlcnRUYXNrLCBpc0RiQXZhaWxhYmxlLCBvcGVuRGF0YWJhc2UgfSBmcm9tIFwiLi4vZ3NkLWRiLnRzXCI7XG5cbi8qKiBTY2FmZm9sZCAuZ3NkL21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzAxLyB3aXRoIHRhc2tzLyBhbmQgYSBUMDEtU1VNTUFSWS5tZC4gKi9cbmZ1bmN0aW9uIHNjYWZmb2xkUHJvamVjdCh0OiB7IGFmdGVyOiAoZm46ICgpID0+IHZvaWQpID0+IHZvaWQgfSk6IHtcbiAgYmFzZTogc3RyaW5nO1xuICBwbGFuUGF0aDogc3RyaW5nO1xufSB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC12ZXJpZnktYXJ0aWZhY3QtXCIpKTtcbiAgdC5hZnRlcigoKSA9PiB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH0pO1xuXG4gIGNvbnN0IHNsaWNlRGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiKTtcbiAgbWtkaXJTeW5jKGpvaW4oc2xpY2VEaXIsIFwidGFza3NcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAvLyBTdW1tYXJ5IGZpbGUgbXVzdCBleGlzdCBzbyB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0IHJlYWNoZXMgdGhlIGxlZ2FjeSBicmFuY2hcbiAgd3JpdGVGaWxlU3luYyhqb2luKHNsaWNlRGlyLCBcInRhc2tzXCIsIFwiVDAxLVNVTU1BUlkubWRcIiksIFwiIyBUMDEgc3VtbWFyeVxcblwiKTtcbiAgcmV0dXJuIHsgYmFzZSwgcGxhblBhdGg6IGpvaW4oc2xpY2VEaXIsIFwiUzAxLVBMQU4ubWRcIikgfTtcbn1cblxudGVzdChcIiMzNjA3OiBleGVjdXRlLXRhc2sgbGVnYWN5IGJyYW5jaCBcdTIwMTQgY2hlY2tlZCBjaGVja2JveCBbeF0gcGFzc2VzIHZlcmlmaWNhdGlvblwiLCAodCkgPT4ge1xuICBjbG9zZURhdGFiYXNlKCk7XG4gIGFzc2VydC5lcXVhbChpc0RiQXZhaWxhYmxlKCksIGZhbHNlLCBcIkRCIG11c3QgYmUgY2xvc2VkIHRvIGhpdCBsZWdhY3kgYnJhbmNoXCIpO1xuXG4gIGNvbnN0IHsgYmFzZSwgcGxhblBhdGggfSA9IHNjYWZmb2xkUHJvamVjdCh0KTtcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBwbGFuUGF0aCxcbiAgICBbXG4gICAgICBcIiMgUzAxIHBsYW5cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIi0gW3hdICoqVDAxOiBJbXBsZW1lbnQgZmVhdHVyZSoqXCIsXG4gICAgICBcIlwiLFxuICAgIF0uam9pbihcIlxcblwiKSxcbiAgKTtcblxuICBhc3NlcnQuZXF1YWwoXG4gICAgdmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdChcImV4ZWN1dGUtdGFza1wiLCBcIk0wMDEvUzAxL1QwMVwiLCBiYXNlKSxcbiAgICB0cnVlLFxuICAgIFwiY2hlY2tlZCBjaGVja2JveCBbeF0gaXMgYWNjZXB0ZWQgYXMgY29tcGxldGlvbiBldmlkZW5jZVwiLFxuICApO1xufSk7XG5cbnRlc3QoXCIjMzYwNzogZXhlY3V0ZS10YXNrIGxlZ2FjeSBicmFuY2ggXHUyMDE0IGNoZWNrZWQgY2hlY2tib3ggW1hdICh1cHBlcmNhc2UpIGFsc28gcGFzc2VzXCIsICh0KSA9PiB7XG4gIGNsb3NlRGF0YWJhc2UoKTtcbiAgY29uc3QgeyBiYXNlLCBwbGFuUGF0aCB9ID0gc2NhZmZvbGRQcm9qZWN0KHQpO1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIHBsYW5QYXRoLFxuICAgIFtcbiAgICAgIFwiIyBTMDEgcGxhblwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiLSBbWF0gKipUMDE6IEltcGxlbWVudCBmZWF0dXJlKipcIixcbiAgICBdLmpvaW4oXCJcXG5cIiksXG4gICk7XG5cbiAgYXNzZXJ0LmVxdWFsKFxuICAgIHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QoXCJleGVjdXRlLXRhc2tcIiwgXCJNMDAxL1MwMS9UMDFcIiwgYmFzZSksXG4gICAgdHJ1ZSxcbiAgICBcInVwcGVyY2FzZSBbWF0gY2hlY2tib3ggaXMgYWNjZXB0ZWRcIixcbiAgKTtcbn0pO1xuXG50ZXN0KFwiIzM2MDc6IGV4ZWN1dGUtdGFzayBsZWdhY3kgYnJhbmNoIFx1MjAxNCB1bmNoZWNrZWQgY2hlY2tib3ggWyBdIGlzIHJlamVjdGVkXCIsICh0KSA9PiB7XG4gIGNsb3NlRGF0YWJhc2UoKTtcbiAgY29uc3QgeyBiYXNlLCBwbGFuUGF0aCB9ID0gc2NhZmZvbGRQcm9qZWN0KHQpO1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIHBsYW5QYXRoLFxuICAgIFtcbiAgICAgIFwiIyBTMDEgcGxhblwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiLSBbIF0gKipUMDE6IEltcGxlbWVudCBmZWF0dXJlKipcIixcbiAgICBdLmpvaW4oXCJcXG5cIiksXG4gICk7XG5cbiAgYXNzZXJ0LmVxdWFsKFxuICAgIHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QoXCJleGVjdXRlLXRhc2tcIiwgXCJNMDAxL1MwMS9UMDFcIiwgYmFzZSksXG4gICAgZmFsc2UsXG4gICAgXCJ1bmNoZWNrZWQgY2hlY2tib3ggWyBdIG11c3Qgbm90IHBhc3MgdmVyaWZpY2F0aW9uICgjMzYwNylcIixcbiAgKTtcbn0pO1xuXG50ZXN0KFwiIzM2MDc6IGV4ZWN1dGUtdGFzayBsZWdhY3kgYnJhbmNoIFx1MjAxNCBiYXJlIGhlYWRpbmcgIyMjIFQwMSBpcyBubyBsb25nZXIgc3VmZmljaWVudFwiLCAodCkgPT4ge1xuICBjbG9zZURhdGFiYXNlKCk7XG4gIGNvbnN0IHsgYmFzZSwgcGxhblBhdGggfSA9IHNjYWZmb2xkUHJvamVjdCh0KTtcbiAgLy8gT2xkIGJ1Z2d5IGJlaGF2aW91ciB3b3VsZCBwYXNzIG9uIGEgaGVhZGluZyBhbG9uZS4gVGhpcyBtdXN0IG5vdyBmYWlsLlxuICB3cml0ZUZpbGVTeW5jKFxuICAgIHBsYW5QYXRoLFxuICAgIFtcbiAgICAgIFwiIyBTMDEgcGxhblwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMjIFQwMSAtLSBJbXBsZW1lbnQgZmVhdHVyZVwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiU29tZSBkZXNjcmlwdGlvbiBoZXJlLCBidXQgbm8gY2hlY2tib3guXCIsXG4gICAgXS5qb2luKFwiXFxuXCIpLFxuICApO1xuXG4gIGFzc2VydC5lcXVhbChcbiAgICB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0KFwiZXhlY3V0ZS10YXNrXCIsIFwiTTAwMS9TMDEvVDAxXCIsIGJhc2UpLFxuICAgIGZhbHNlLFxuICAgIFwiaGVhZGluZyBhbG9uZSBtdXN0IG5vdCBwYXNzIHZlcmlmaWNhdGlvbiBhZnRlciAjMzYwNyBmaXhcIixcbiAgKTtcbn0pO1xuXG50ZXN0KFwiIzM2MDc6IGV4ZWN1dGUtdGFzayBsZWdhY3kgYnJhbmNoIFx1MjAxNCBtaXNzaW5nIHBsYW4gZmlsZSByZXR1cm5zIGZhbHNlXCIsICh0KSA9PiB7XG4gIGNsb3NlRGF0YWJhc2UoKTtcbiAgY29uc3QgeyBiYXNlIH0gPSBzY2FmZm9sZFByb2plY3QodCk7XG4gIC8vIERvIG5vdCBjcmVhdGUgUzAxLVBMQU4ubWQgYXQgYWxsLlxuXG4gIGFzc2VydC5lcXVhbChcbiAgICB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0KFwiZXhlY3V0ZS10YXNrXCIsIFwiTTAwMS9TMDEvVDAxXCIsIGJhc2UpLFxuICAgIGZhbHNlLFxuICAgIFwibWlzc2luZyBwbGFuIGZpbGUgbXVzdCBjYXVzZSB2ZXJpZmljYXRpb24gdG8gcmV0dXJuIGZhbHNlXCIsXG4gICk7XG59KTtcblxudGVzdChcIiMzNjA3OiBleGVjdXRlLXRhc2sgbGVnYWN5IGJyYW5jaCBcdTIwMTQgd3JvbmcgdGFzayBpZCBpbiBjaGVja2JveCBkb2VzIG5vdCBtYXRjaFwiLCAodCkgPT4ge1xuICBjbG9zZURhdGFiYXNlKCk7XG4gIGNvbnN0IHsgYmFzZSwgcGxhblBhdGggfSA9IHNjYWZmb2xkUHJvamVjdCh0KTtcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBwbGFuUGF0aCxcbiAgICBbXG4gICAgICBcIiMgUzAxIHBsYW5cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIi0gW3hdICoqVDAyOiBTb21lIG90aGVyIHRhc2sqKlwiLFxuICAgIF0uam9pbihcIlxcblwiKSxcbiAgKTtcblxuICBhc3NlcnQuZXF1YWwoXG4gICAgdmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdChcImV4ZWN1dGUtdGFza1wiLCBcIk0wMDEvUzAxL1QwMVwiLCBiYXNlKSxcbiAgICBmYWxzZSxcbiAgICBcImNoZWNrYm94IGZvciBhIGRpZmZlcmVudCB0YXNrIGlkIG11c3Qgbm90IGNvdW50IGFzIFQwMSBjb21wbGV0aW9uXCIsXG4gICk7XG59KTtcblxudGVzdChcImV4ZWN1dGUtdGFzayBEQiBsYWcgYnJhbmNoIFx1MjAxNCBwZW5kaW5nIERCIHN0YXR1cyBjYW4gdmVyaWZ5IGZyb20gY2hlY2tlZCBwbGFuIHBsdXMgc3VtbWFyeVwiLCAodCkgPT4ge1xuICBjbG9zZURhdGFiYXNlKCk7XG4gIGNvbnN0IHsgYmFzZSwgcGxhblBhdGggfSA9IHNjYWZmb2xkUHJvamVjdCh0KTtcbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpKTtcbiAgYXNzZXJ0LmVxdWFsKGlzRGJBdmFpbGFibGUoKSwgdHJ1ZSwgXCJEQiBtdXN0IGJlIG9wZW4gdG8gaGl0IHRoZSBEQi1sYWcgYnJhbmNoXCIpO1xuXG4gIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiTWlsZXN0b25lXCIsIHN0YXR1czogXCJhY3RpdmVcIiB9KTtcbiAgaW5zZXJ0U2xpY2UoeyBpZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJTbGljZVwiLCBzdGF0dXM6IFwicGVuZGluZ1wiIH0pO1xuICBpbnNlcnRUYXNrKHsgaWQ6IFwiVDAxXCIsIHNsaWNlSWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiSW1wbGVtZW50IGZlYXR1cmVcIiwgc3RhdHVzOiBcInBlbmRpbmdcIiB9KTtcblxuICB3cml0ZUZpbGVTeW5jKFxuICAgIHBsYW5QYXRoLFxuICAgIFtcbiAgICAgIFwiIyBTMDEgcGxhblwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiLSBbeF0gKipUMDE6IEltcGxlbWVudCBmZWF0dXJlKipcIixcbiAgICBdLmpvaW4oXCJcXG5cIiksXG4gICk7XG5cbiAgYXNzZXJ0LmVxdWFsKFxuICAgIHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QoXCJleGVjdXRlLXRhc2tcIiwgXCJNMDAxL1MwMS9UMDFcIiwgYmFzZSksXG4gICAgdHJ1ZSxcbiAgICBcImNoZWNrZWQgcGxhbiBlbnRyeSBwbHVzIHN1bW1hcnkgc2hvdWxkIHZlcmlmeSB3aGlsZSBEQiByZWNvbmNpbGUgY2F0Y2hlcyB1cFwiLFxuICApO1xufSk7XG5cbnRlc3QoXCJleGVjdXRlLXRhc2sgREIgbGFnIGJyYW5jaCBcdTIwMTQgc3VtbWFyeSB3aXRob3V0IGNoZWNrZWQgcGxhbiBzdGlsbCBmYWlsc1wiLCAodCkgPT4ge1xuICBjbG9zZURhdGFiYXNlKCk7XG4gIGNvbnN0IHsgYmFzZSwgcGxhblBhdGggfSA9IHNjYWZmb2xkUHJvamVjdCh0KTtcbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpKTtcblxuICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIk1pbGVzdG9uZVwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSk7XG4gIGluc2VydFNsaWNlKHsgaWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiU2xpY2VcIiwgc3RhdHVzOiBcInBlbmRpbmdcIiB9KTtcbiAgaW5zZXJ0VGFzayh7IGlkOiBcIlQwMVwiLCBzbGljZUlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHRpdGxlOiBcIkltcGxlbWVudCBmZWF0dXJlXCIsIHN0YXR1czogXCJwZW5kaW5nXCIgfSk7XG5cbiAgd3JpdGVGaWxlU3luYyhcbiAgICBwbGFuUGF0aCxcbiAgICBbXG4gICAgICBcIiMgUzAxIHBsYW5cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIi0gWyBdICoqVDAxOiBJbXBsZW1lbnQgZmVhdHVyZSoqXCIsXG4gICAgXS5qb2luKFwiXFxuXCIpLFxuICApO1xuXG4gIGFzc2VydC5lcXVhbChcbiAgICB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0KFwiZXhlY3V0ZS10YXNrXCIsIFwiTTAwMS9TMDEvVDAxXCIsIGJhc2UpLFxuICAgIGZhbHNlLFxuICAgIFwicGVuZGluZyBEQiBzdGF0dXMgcGx1cyBzdW1tYXJ5IGlzIGluc3VmZmljaWVudCB3aXRob3V0IGEgY2hlY2tlZCB0YXNrIGNoZWNrYm94XCIsXG4gICk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQWNBLFNBQVMsWUFBWTtBQUNyQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhLFdBQVcsZUFBZSxjQUFjO0FBQzlELFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFFdkIsU0FBUyw4QkFBOEI7QUFDdkMsU0FBUyxlQUFlLGlCQUFpQixhQUFhLFlBQVksZUFBZSxvQkFBb0I7QUFHckcsU0FBUyxnQkFBZ0IsR0FHdkI7QUFDQSxRQUFNLE9BQU8sWUFBWSxLQUFLLE9BQU8sR0FBRyxzQkFBc0IsQ0FBQztBQUMvRCxJQUFFLE1BQU0sTUFBTTtBQUNa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
