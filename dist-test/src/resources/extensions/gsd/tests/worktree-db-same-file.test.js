import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openDatabase,
  closeDatabase,
  reconcileWorktreeDb,
  insertDecision
} from "../gsd-db.js";
import {
  _shouldReconcileWorktreeDb
} from "../auto-worktree.js";
import { isInfrastructureError } from "../auto/infra-errors.js";
describe("#2823: reconcileWorktreeDb same-file guard", () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gsd-2823-"));
  });
  afterEach(() => {
    closeDatabase();
    rmSync(tmpDir, { recursive: true, force: true });
  });
  test("returns zero result when both paths resolve to the same file", () => {
    const mainGsd = join(tmpDir, "main", ".gsd");
    mkdirSync(mainGsd, { recursive: true });
    const mainDbPath = join(mainGsd, "gsd.db");
    openDatabase(mainDbPath);
    insertDecision({
      id: "D001",
      when_context: "2026-01-01",
      scope: "M001",
      decision: "Test decision",
      choice: "Test choice",
      rationale: "Test rationale",
      revisable: "yes",
      made_by: "agent",
      superseded_by: null
    });
    const wtGsd = join(tmpDir, "worktree", ".gsd");
    mkdirSync(join(tmpDir, "worktree"), { recursive: true });
    symlinkSync(mainGsd, wtGsd, "junction");
    const worktreeDbPath = join(wtGsd, "gsd.db");
    assert.ok(existsSync(mainDbPath), "main DB exists");
    assert.ok(existsSync(worktreeDbPath), "worktree DB path exists via symlink");
    const result = reconcileWorktreeDb(mainDbPath, worktreeDbPath);
    assert.equal(result.decisions, 0, "no decisions reconciled");
    assert.equal(result.requirements, 0, "no requirements reconciled");
    assert.equal(result.artifacts, 0, "no artifacts reconciled");
    assert.equal(result.conflicts.length, 0, "no conflicts");
  });
  test("returns zero result when both paths are identical strings", () => {
    const mainGsd = join(tmpDir, "project", ".gsd");
    mkdirSync(mainGsd, { recursive: true });
    const dbPath = join(mainGsd, "gsd.db");
    openDatabase(dbPath);
    insertDecision({
      id: "D001",
      when_context: "2026-01-01",
      scope: "M001",
      decision: "Test",
      choice: "Test",
      rationale: "Test",
      revisable: "yes",
      made_by: "agent",
      superseded_by: null
    });
    const result = reconcileWorktreeDb(dbPath, dbPath);
    assert.equal(result.decisions, 0);
    assert.equal(result.conflicts.length, 0);
  });
  test("still reconciles when paths are genuinely different files", () => {
    const mainGsd = join(tmpDir, "main", ".gsd");
    mkdirSync(mainGsd, { recursive: true });
    const mainDbPath = join(mainGsd, "gsd.db");
    openDatabase(mainDbPath);
    insertDecision({
      id: "D001",
      when_context: "2026-01-01",
      scope: "M001",
      decision: "Main decision",
      choice: "Main choice",
      rationale: "Main rationale",
      revisable: "yes",
      made_by: "agent",
      superseded_by: null
    });
    closeDatabase();
    const wtGsd = join(tmpDir, "worktree", ".gsd");
    mkdirSync(wtGsd, { recursive: true });
    const worktreeDbPath = join(wtGsd, "gsd.db");
    openDatabase(worktreeDbPath);
    insertDecision({
      id: "D002",
      when_context: "2026-01-01",
      scope: "M001",
      decision: "WT decision",
      choice: "WT choice",
      rationale: "WT rationale",
      revisable: "yes",
      made_by: "agent",
      superseded_by: null
    });
    closeDatabase();
    openDatabase(mainDbPath);
    const result = reconcileWorktreeDb(mainDbPath, worktreeDbPath);
    assert.ok(result.decisions > 0, "should reconcile decisions from a different DB");
  });
});
test("merge-time DB reconciliation requires an existing distinct worktree DB", () => {
  assert.equal(
    _shouldReconcileWorktreeDb("worktree.db", "main.db", () => true, () => false),
    true
  );
  assert.equal(
    _shouldReconcileWorktreeDb("worktree.db", "main.db", () => false, () => false),
    false
  );
  assert.equal(
    _shouldReconcileWorktreeDb("worktree.db", "main.db", () => true, () => true),
    false
  );
});
describe("#2823: malformed DB classified as infrastructure error", () => {
  test("database disk image is malformed is detected as infra error", () => {
    const code = isInfrastructureError(new Error("database disk image is malformed"));
    assert.equal(code, "SQLITE_CORRUPT");
  });
  test("other SQLite errors are not falsely classified", () => {
    const code = isInfrastructureError(new Error("SQLITE_BUSY: database is locked"));
    assert.equal(code, null);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy93b3JrdHJlZS1kYi1zYW1lLWZpbGUudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NELTIgXHUyMDE0IFdvcmt0cmVlIERCIHNhbWUtZmlsZSByZWNvbmNpbGlhdGlvbiByZWdyZXNzaW9uIHRlc3RzLlxuXG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCwgYmVmb3JlRWFjaCwgYWZ0ZXJFYWNoIH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQge1xuICBleGlzdHNTeW5jLFxuICBta2RpclN5bmMsXG4gIG1rZHRlbXBTeW5jLFxuICBybVN5bmMsXG4gIHN5bWxpbmtTeW5jLFxufSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5cbmltcG9ydCB7XG4gIG9wZW5EYXRhYmFzZSxcbiAgY2xvc2VEYXRhYmFzZSxcbiAgcmVjb25jaWxlV29ya3RyZWVEYixcbiAgaW5zZXJ0RGVjaXNpb24sXG59IGZyb20gXCIuLi9nc2QtZGIudHNcIjtcbmltcG9ydCB7XG4gIF9zaG91bGRSZWNvbmNpbGVXb3JrdHJlZURiLFxufSBmcm9tIFwiLi4vYXV0by13b3JrdHJlZS50c1wiO1xuaW1wb3J0IHsgaXNJbmZyYXN0cnVjdHVyZUVycm9yIH0gZnJvbSBcIi4uL2F1dG8vaW5mcmEtZXJyb3JzLnRzXCI7XG5cbmRlc2NyaWJlKFwiIzI4MjM6IHJlY29uY2lsZVdvcmt0cmVlRGIgc2FtZS1maWxlIGd1YXJkXCIsICgpID0+IHtcbiAgbGV0IHRtcERpcjogc3RyaW5nO1xuXG4gIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgIHRtcERpciA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLTI4MjMtXCIpKTtcbiAgfSk7XG5cbiAgYWZ0ZXJFYWNoKCgpID0+IHtcbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgcm1TeW5jKHRtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcblxuICB0ZXN0KFwicmV0dXJucyB6ZXJvIHJlc3VsdCB3aGVuIGJvdGggcGF0aHMgcmVzb2x2ZSB0byB0aGUgc2FtZSBmaWxlXCIsICgpID0+IHtcbiAgICBjb25zdCBtYWluR3NkID0gam9pbih0bXBEaXIsIFwibWFpblwiLCBcIi5nc2RcIik7XG4gICAgbWtkaXJTeW5jKG1haW5Hc2QsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIGNvbnN0IG1haW5EYlBhdGggPSBqb2luKG1haW5Hc2QsIFwiZ3NkLmRiXCIpO1xuXG4gICAgb3BlbkRhdGFiYXNlKG1haW5EYlBhdGgpO1xuICAgIGluc2VydERlY2lzaW9uKHtcbiAgICAgIGlkOiBcIkQwMDFcIixcbiAgICAgIHdoZW5fY29udGV4dDogXCIyMDI2LTAxLTAxXCIsXG4gICAgICBzY29wZTogXCJNMDAxXCIsXG4gICAgICBkZWNpc2lvbjogXCJUZXN0IGRlY2lzaW9uXCIsXG4gICAgICBjaG9pY2U6IFwiVGVzdCBjaG9pY2VcIixcbiAgICAgIHJhdGlvbmFsZTogXCJUZXN0IHJhdGlvbmFsZVwiLFxuICAgICAgcmV2aXNhYmxlOiBcInllc1wiLFxuICAgICAgbWFkZV9ieTogXCJhZ2VudFwiLFxuICAgICAgc3VwZXJzZWRlZF9ieTogbnVsbCxcbiAgICB9KTtcblxuICAgIGNvbnN0IHd0R3NkID0gam9pbih0bXBEaXIsIFwid29ya3RyZWVcIiwgXCIuZ3NkXCIpO1xuICAgIG1rZGlyU3luYyhqb2luKHRtcERpciwgXCJ3b3JrdHJlZVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgc3ltbGlua1N5bmMobWFpbkdzZCwgd3RHc2QsIFwianVuY3Rpb25cIik7XG4gICAgY29uc3Qgd29ya3RyZWVEYlBhdGggPSBqb2luKHd0R3NkLCBcImdzZC5kYlwiKTtcblxuICAgIGFzc2VydC5vayhleGlzdHNTeW5jKG1haW5EYlBhdGgpLCBcIm1haW4gREIgZXhpc3RzXCIpO1xuICAgIGFzc2VydC5vayhleGlzdHNTeW5jKHdvcmt0cmVlRGJQYXRoKSwgXCJ3b3JrdHJlZSBEQiBwYXRoIGV4aXN0cyB2aWEgc3ltbGlua1wiKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IHJlY29uY2lsZVdvcmt0cmVlRGIobWFpbkRiUGF0aCwgd29ya3RyZWVEYlBhdGgpO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5kZWNpc2lvbnMsIDAsIFwibm8gZGVjaXNpb25zIHJlY29uY2lsZWRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5yZXF1aXJlbWVudHMsIDAsIFwibm8gcmVxdWlyZW1lbnRzIHJlY29uY2lsZWRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5hcnRpZmFjdHMsIDAsIFwibm8gYXJ0aWZhY3RzIHJlY29uY2lsZWRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5jb25mbGljdHMubGVuZ3RoLCAwLCBcIm5vIGNvbmZsaWN0c1wiKTtcbiAgfSk7XG5cbiAgdGVzdChcInJldHVybnMgemVybyByZXN1bHQgd2hlbiBib3RoIHBhdGhzIGFyZSBpZGVudGljYWwgc3RyaW5nc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgbWFpbkdzZCA9IGpvaW4odG1wRGlyLCBcInByb2plY3RcIiwgXCIuZ3NkXCIpO1xuICAgIG1rZGlyU3luYyhtYWluR3NkLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBjb25zdCBkYlBhdGggPSBqb2luKG1haW5Hc2QsIFwiZ3NkLmRiXCIpO1xuXG4gICAgb3BlbkRhdGFiYXNlKGRiUGF0aCk7XG4gICAgaW5zZXJ0RGVjaXNpb24oe1xuICAgICAgaWQ6IFwiRDAwMVwiLFxuICAgICAgd2hlbl9jb250ZXh0OiBcIjIwMjYtMDEtMDFcIixcbiAgICAgIHNjb3BlOiBcIk0wMDFcIixcbiAgICAgIGRlY2lzaW9uOiBcIlRlc3RcIixcbiAgICAgIGNob2ljZTogXCJUZXN0XCIsXG4gICAgICByYXRpb25hbGU6IFwiVGVzdFwiLFxuICAgICAgcmV2aXNhYmxlOiBcInllc1wiLFxuICAgICAgbWFkZV9ieTogXCJhZ2VudFwiLFxuICAgICAgc3VwZXJzZWRlZF9ieTogbnVsbCxcbiAgICB9KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IHJlY29uY2lsZVdvcmt0cmVlRGIoZGJQYXRoLCBkYlBhdGgpO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5kZWNpc2lvbnMsIDApO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuY29uZmxpY3RzLmxlbmd0aCwgMCk7XG4gIH0pO1xuXG4gIHRlc3QoXCJzdGlsbCByZWNvbmNpbGVzIHdoZW4gcGF0aHMgYXJlIGdlbnVpbmVseSBkaWZmZXJlbnQgZmlsZXNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IG1haW5Hc2QgPSBqb2luKHRtcERpciwgXCJtYWluXCIsIFwiLmdzZFwiKTtcbiAgICBta2RpclN5bmMobWFpbkdzZCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgY29uc3QgbWFpbkRiUGF0aCA9IGpvaW4obWFpbkdzZCwgXCJnc2QuZGJcIik7XG5cbiAgICBvcGVuRGF0YWJhc2UobWFpbkRiUGF0aCk7XG4gICAgaW5zZXJ0RGVjaXNpb24oe1xuICAgICAgaWQ6IFwiRDAwMVwiLFxuICAgICAgd2hlbl9jb250ZXh0OiBcIjIwMjYtMDEtMDFcIixcbiAgICAgIHNjb3BlOiBcIk0wMDFcIixcbiAgICAgIGRlY2lzaW9uOiBcIk1haW4gZGVjaXNpb25cIixcbiAgICAgIGNob2ljZTogXCJNYWluIGNob2ljZVwiLFxuICAgICAgcmF0aW9uYWxlOiBcIk1haW4gcmF0aW9uYWxlXCIsXG4gICAgICByZXZpc2FibGU6IFwieWVzXCIsXG4gICAgICBtYWRlX2J5OiBcImFnZW50XCIsXG4gICAgICBzdXBlcnNlZGVkX2J5OiBudWxsLFxuICAgIH0pO1xuICAgIGNsb3NlRGF0YWJhc2UoKTtcblxuICAgIGNvbnN0IHd0R3NkID0gam9pbih0bXBEaXIsIFwid29ya3RyZWVcIiwgXCIuZ3NkXCIpO1xuICAgIG1rZGlyU3luYyh3dEdzZCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgY29uc3Qgd29ya3RyZWVEYlBhdGggPSBqb2luKHd0R3NkLCBcImdzZC5kYlwiKTtcblxuICAgIG9wZW5EYXRhYmFzZSh3b3JrdHJlZURiUGF0aCk7XG4gICAgaW5zZXJ0RGVjaXNpb24oe1xuICAgICAgaWQ6IFwiRDAwMlwiLFxuICAgICAgd2hlbl9jb250ZXh0OiBcIjIwMjYtMDEtMDFcIixcbiAgICAgIHNjb3BlOiBcIk0wMDFcIixcbiAgICAgIGRlY2lzaW9uOiBcIldUIGRlY2lzaW9uXCIsXG4gICAgICBjaG9pY2U6IFwiV1QgY2hvaWNlXCIsXG4gICAgICByYXRpb25hbGU6IFwiV1QgcmF0aW9uYWxlXCIsXG4gICAgICByZXZpc2FibGU6IFwieWVzXCIsXG4gICAgICBtYWRlX2J5OiBcImFnZW50XCIsXG4gICAgICBzdXBlcnNlZGVkX2J5OiBudWxsLFxuICAgIH0pO1xuICAgIGNsb3NlRGF0YWJhc2UoKTtcblxuICAgIG9wZW5EYXRhYmFzZShtYWluRGJQYXRoKTtcbiAgICBjb25zdCByZXN1bHQgPSByZWNvbmNpbGVXb3JrdHJlZURiKG1haW5EYlBhdGgsIHdvcmt0cmVlRGJQYXRoKTtcblxuICAgIGFzc2VydC5vayhyZXN1bHQuZGVjaXNpb25zID4gMCwgXCJzaG91bGQgcmVjb25jaWxlIGRlY2lzaW9ucyBmcm9tIGEgZGlmZmVyZW50IERCXCIpO1xuICB9KTtcbn0pO1xuXG50ZXN0KFwibWVyZ2UtdGltZSBEQiByZWNvbmNpbGlhdGlvbiByZXF1aXJlcyBhbiBleGlzdGluZyBkaXN0aW5jdCB3b3JrdHJlZSBEQlwiLCAoKSA9PiB7XG4gIGFzc2VydC5lcXVhbChcbiAgICBfc2hvdWxkUmVjb25jaWxlV29ya3RyZWVEYihcIndvcmt0cmVlLmRiXCIsIFwibWFpbi5kYlwiLCAoKSA9PiB0cnVlLCAoKSA9PiBmYWxzZSksXG4gICAgdHJ1ZSxcbiAgKTtcbiAgYXNzZXJ0LmVxdWFsKFxuICAgIF9zaG91bGRSZWNvbmNpbGVXb3JrdHJlZURiKFwid29ya3RyZWUuZGJcIiwgXCJtYWluLmRiXCIsICgpID0+IGZhbHNlLCAoKSA9PiBmYWxzZSksXG4gICAgZmFsc2UsXG4gICk7XG4gIGFzc2VydC5lcXVhbChcbiAgICBfc2hvdWxkUmVjb25jaWxlV29ya3RyZWVEYihcIndvcmt0cmVlLmRiXCIsIFwibWFpbi5kYlwiLCAoKSA9PiB0cnVlLCAoKSA9PiB0cnVlKSxcbiAgICBmYWxzZSxcbiAgKTtcbn0pO1xuXG5kZXNjcmliZShcIiMyODIzOiBtYWxmb3JtZWQgREIgY2xhc3NpZmllZCBhcyBpbmZyYXN0cnVjdHVyZSBlcnJvclwiLCAoKSA9PiB7XG4gIHRlc3QoXCJkYXRhYmFzZSBkaXNrIGltYWdlIGlzIG1hbGZvcm1lZCBpcyBkZXRlY3RlZCBhcyBpbmZyYSBlcnJvclwiLCAoKSA9PiB7XG4gICAgY29uc3QgY29kZSA9IGlzSW5mcmFzdHJ1Y3R1cmVFcnJvcihuZXcgRXJyb3IoXCJkYXRhYmFzZSBkaXNrIGltYWdlIGlzIG1hbGZvcm1lZFwiKSk7XG4gICAgYXNzZXJ0LmVxdWFsKGNvZGUsIFwiU1FMSVRFX0NPUlJVUFRcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJvdGhlciBTUUxpdGUgZXJyb3JzIGFyZSBub3QgZmFsc2VseSBjbGFzc2lmaWVkXCIsICgpID0+IHtcbiAgICBjb25zdCBjb2RlID0gaXNJbmZyYXN0cnVjdHVyZUVycm9yKG5ldyBFcnJvcihcIlNRTElURV9CVVNZOiBkYXRhYmFzZSBpcyBsb2NrZWRcIikpO1xuICAgIGFzc2VydC5lcXVhbChjb2RlLCBudWxsKTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUVBLFNBQVMsVUFBVSxNQUFNLFlBQVksaUJBQWlCO0FBQ3RELE9BQU8sWUFBWTtBQUNuQjtBQUFBLEVBQ0U7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
