import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createCheckpoint, rollbackToCheckpoint, cleanupCheckpoint } from "../safety/git-checkpoint.js";
function git(args, cwd) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}
function createTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "ckpt-test-"));
  git(["init"], dir);
  git(["config", "user.email", "test@test.com"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "file.txt"), "initial\n");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
  git(["branch", "-M", "main"], dir);
  return dir;
}
describe("git-checkpoint rollback", () => {
  it("skips checkpoint creation in a git repo without commits", (t) => {
    const repo = mkdtempSync(join(tmpdir(), "ckpt-unborn-"));
    t.after(() => rmSync(repo, { recursive: true, force: true }));
    git(["init"], repo);
    const sha = createCheckpoint(repo, "unit-unborn");
    assert.equal(sha, null, "unborn repos do not have a checkpointable HEAD");
  });
  it("rolls back to checkpoint on checked-out branch", (t) => {
    const repo = createTempRepo();
    t.after(() => rmSync(repo, { recursive: true, force: true }));
    const sha = createCheckpoint(repo, "unit-1");
    assert.ok(sha, "checkpoint should return a SHA");
    writeFileSync(join(repo, "file.txt"), "modified\n");
    git(["add", "."], repo);
    git(["commit", "-m", "second"], repo);
    const headBefore = git(["rev-parse", "HEAD"], repo);
    assert.notEqual(headBefore, sha, "HEAD should have advanced");
    const result = rollbackToCheckpoint(repo, "unit-1", sha);
    assert.equal(result, true, "rollback should succeed");
    const headAfter = git(["rev-parse", "HEAD"], repo);
    assert.equal(headAfter, sha, "HEAD should match checkpoint SHA after rollback");
  });
  it("returns false on detached HEAD", (t) => {
    const repo = createTempRepo();
    t.after(() => rmSync(repo, { recursive: true, force: true }));
    const sha = git(["rev-parse", "HEAD"], repo);
    git(["checkout", "--detach", sha], repo);
    const result = rollbackToCheckpoint(repo, "unit-2", sha);
    assert.equal(result, false, "rollback should fail on detached HEAD");
  });
  it("cleans up checkpoint ref after rollback", (t) => {
    const repo = createTempRepo();
    t.after(() => rmSync(repo, { recursive: true, force: true }));
    const sha = createCheckpoint(repo, "unit-3");
    assert.ok(sha);
    const refBefore = git(["for-each-ref", "refs/gsd/checkpoints/unit-3", "--format=%(objectname)"], repo);
    assert.equal(refBefore, sha);
    rollbackToCheckpoint(repo, "unit-3", sha);
    const refAfter = git(["for-each-ref", "refs/gsd/checkpoints/unit-3", "--format=%(objectname)"], repo);
    assert.equal(refAfter, "", "checkpoint ref should be removed after rollback");
  });
  it("cleanupCheckpoint removes the ref without error", (t) => {
    const repo = createTempRepo();
    t.after(() => rmSync(repo, { recursive: true, force: true }));
    const sha = createCheckpoint(repo, "unit-4");
    assert.ok(sha);
    cleanupCheckpoint(repo, "unit-4");
    const ref = git(["for-each-ref", "refs/gsd/checkpoints/unit-4", "--format=%(objectname)"], repo);
    assert.equal(ref, "", "ref should be gone");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9naXQtY2hlY2twb2ludC50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBHU0QyIFx1MjAxNCBSZWdyZXNzaW9uIHRlc3RzIGZvciBnaXQtY2hlY2twb2ludCByb2xsYmFjayAoIzM1NzYpXG4vLyBDb3B5cmlnaHQgKGMpIDIwMjYgSmVyZW15IE1jU3BhZGRlbiA8amVyZW15QGZsdXhsYWJzLm5ldD5cblxuaW1wb3J0IHsgZGVzY3JpYmUsIGl0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgd3JpdGVGaWxlU3luYywgcm1TeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgZXhlY0ZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHsgY3JlYXRlQ2hlY2twb2ludCwgcm9sbGJhY2tUb0NoZWNrcG9pbnQsIGNsZWFudXBDaGVja3BvaW50IH0gZnJvbSBcIi4uL3NhZmV0eS9naXQtY2hlY2twb2ludC5qc1wiO1xuXG5mdW5jdGlvbiBnaXQoYXJnczogc3RyaW5nW10sIGN3ZDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBhcmdzLCB7IGN3ZCwgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdLCBlbmNvZGluZzogXCJ1dGYtOFwiIH0pLnRyaW0oKTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlVGVtcFJlcG8oKTogc3RyaW5nIHtcbiAgY29uc3QgZGlyID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJja3B0LXRlc3QtXCIpKTtcbiAgZ2l0KFtcImluaXRcIl0sIGRpcik7XG4gIGdpdChbXCJjb25maWdcIiwgXCJ1c2VyLmVtYWlsXCIsIFwidGVzdEB0ZXN0LmNvbVwiXSwgZGlyKTtcbiAgZ2l0KFtcImNvbmZpZ1wiLCBcInVzZXIubmFtZVwiLCBcIlRlc3RcIl0sIGRpcik7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiZmlsZS50eHRcIiksIFwiaW5pdGlhbFxcblwiKTtcbiAgZ2l0KFtcImFkZFwiLCBcIi5cIl0sIGRpcik7XG4gIGdpdChbXCJjb21taXRcIiwgXCItbVwiLCBcImluaXRcIl0sIGRpcik7XG4gIGdpdChbXCJicmFuY2hcIiwgXCItTVwiLCBcIm1haW5cIl0sIGRpcik7XG4gIHJldHVybiBkaXI7XG59XG5cbmRlc2NyaWJlKFwiZ2l0LWNoZWNrcG9pbnQgcm9sbGJhY2tcIiwgKCkgPT4ge1xuICBpdChcInNraXBzIGNoZWNrcG9pbnQgY3JlYXRpb24gaW4gYSBnaXQgcmVwbyB3aXRob3V0IGNvbW1pdHNcIiwgKHQpID0+IHtcbiAgICBjb25zdCByZXBvID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJja3B0LXVuYm9ybi1cIikpO1xuICAgIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKHJlcG8sIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG4gICAgZ2l0KFtcImluaXRcIl0sIHJlcG8pO1xuXG4gICAgY29uc3Qgc2hhID0gY3JlYXRlQ2hlY2twb2ludChyZXBvLCBcInVuaXQtdW5ib3JuXCIpO1xuICAgIGFzc2VydC5lcXVhbChzaGEsIG51bGwsIFwidW5ib3JuIHJlcG9zIGRvIG5vdCBoYXZlIGEgY2hlY2twb2ludGFibGUgSEVBRFwiKTtcbiAgfSk7XG5cbiAgaXQoXCJyb2xscyBiYWNrIHRvIGNoZWNrcG9pbnQgb24gY2hlY2tlZC1vdXQgYnJhbmNoXCIsICh0KSA9PiB7XG4gICAgY29uc3QgcmVwbyA9IGNyZWF0ZVRlbXBSZXBvKCk7XG4gICAgdC5hZnRlcigoKSA9PiBybVN5bmMocmVwbywgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcblxuICAgIC8vIENyZWF0ZSBjaGVja3BvaW50IGF0IGluaXRpYWwgY29tbWl0XG4gICAgY29uc3Qgc2hhID0gY3JlYXRlQ2hlY2twb2ludChyZXBvLCBcInVuaXQtMVwiKTtcbiAgICBhc3NlcnQub2soc2hhLCBcImNoZWNrcG9pbnQgc2hvdWxkIHJldHVybiBhIFNIQVwiKTtcblxuICAgIC8vIE1ha2UgYSBzZWNvbmQgY29tbWl0XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHJlcG8sIFwiZmlsZS50eHRcIiksIFwibW9kaWZpZWRcXG5cIik7XG4gICAgZ2l0KFtcImFkZFwiLCBcIi5cIl0sIHJlcG8pO1xuICAgIGdpdChbXCJjb21taXRcIiwgXCItbVwiLCBcInNlY29uZFwiXSwgcmVwbyk7XG5cbiAgICBjb25zdCBoZWFkQmVmb3JlID0gZ2l0KFtcInJldi1wYXJzZVwiLCBcIkhFQURcIl0sIHJlcG8pO1xuICAgIGFzc2VydC5ub3RFcXVhbChoZWFkQmVmb3JlLCBzaGEsIFwiSEVBRCBzaG91bGQgaGF2ZSBhZHZhbmNlZFwiKTtcblxuICAgIC8vIFJvbGxiYWNrIFx1MjAxNCB0aGlzIG11c3Qgd29yayBvbiB0aGUgY2hlY2tlZC1vdXQgYnJhbmNoXG4gICAgY29uc3QgcmVzdWx0ID0gcm9sbGJhY2tUb0NoZWNrcG9pbnQocmVwbywgXCJ1bml0LTFcIiwgc2hhKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCB0cnVlLCBcInJvbGxiYWNrIHNob3VsZCBzdWNjZWVkXCIpO1xuXG4gICAgY29uc3QgaGVhZEFmdGVyID0gZ2l0KFtcInJldi1wYXJzZVwiLCBcIkhFQURcIl0sIHJlcG8pO1xuICAgIGFzc2VydC5lcXVhbChoZWFkQWZ0ZXIsIHNoYSwgXCJIRUFEIHNob3VsZCBtYXRjaCBjaGVja3BvaW50IFNIQSBhZnRlciByb2xsYmFja1wiKTtcbiAgfSk7XG5cbiAgaXQoXCJyZXR1cm5zIGZhbHNlIG9uIGRldGFjaGVkIEhFQURcIiwgKHQpID0+IHtcbiAgICBjb25zdCByZXBvID0gY3JlYXRlVGVtcFJlcG8oKTtcbiAgICB0LmFmdGVyKCgpID0+IHJtU3luYyhyZXBvLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuXG4gICAgY29uc3Qgc2hhID0gZ2l0KFtcInJldi1wYXJzZVwiLCBcIkhFQURcIl0sIHJlcG8pO1xuICAgIGdpdChbXCJjaGVja291dFwiLCBcIi0tZGV0YWNoXCIsIHNoYV0sIHJlcG8pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gcm9sbGJhY2tUb0NoZWNrcG9pbnQocmVwbywgXCJ1bml0LTJcIiwgc2hhKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCBmYWxzZSwgXCJyb2xsYmFjayBzaG91bGQgZmFpbCBvbiBkZXRhY2hlZCBIRUFEXCIpO1xuICB9KTtcblxuICBpdChcImNsZWFucyB1cCBjaGVja3BvaW50IHJlZiBhZnRlciByb2xsYmFja1wiLCAodCkgPT4ge1xuICAgIGNvbnN0IHJlcG8gPSBjcmVhdGVUZW1wUmVwbygpO1xuICAgIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKHJlcG8sIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG5cbiAgICBjb25zdCBzaGEgPSBjcmVhdGVDaGVja3BvaW50KHJlcG8sIFwidW5pdC0zXCIpO1xuICAgIGFzc2VydC5vayhzaGEpO1xuXG4gICAgLy8gUmVmIHNob3VsZCBleGlzdFxuICAgIGNvbnN0IHJlZkJlZm9yZSA9IGdpdChbXCJmb3ItZWFjaC1yZWZcIiwgXCJyZWZzL2dzZC9jaGVja3BvaW50cy91bml0LTNcIiwgXCItLWZvcm1hdD0lKG9iamVjdG5hbWUpXCJdLCByZXBvKTtcbiAgICBhc3NlcnQuZXF1YWwocmVmQmVmb3JlLCBzaGEpO1xuXG4gICAgcm9sbGJhY2tUb0NoZWNrcG9pbnQocmVwbywgXCJ1bml0LTNcIiwgc2hhKTtcblxuICAgIC8vIFJlZiBzaG91bGQgYmUgY2xlYW5lZCB1cFxuICAgIGNvbnN0IHJlZkFmdGVyID0gZ2l0KFtcImZvci1lYWNoLXJlZlwiLCBcInJlZnMvZ3NkL2NoZWNrcG9pbnRzL3VuaXQtM1wiLCBcIi0tZm9ybWF0PSUob2JqZWN0bmFtZSlcIl0sIHJlcG8pO1xuICAgIGFzc2VydC5lcXVhbChyZWZBZnRlciwgXCJcIiwgXCJjaGVja3BvaW50IHJlZiBzaG91bGQgYmUgcmVtb3ZlZCBhZnRlciByb2xsYmFja1wiKTtcbiAgfSk7XG5cbiAgaXQoXCJjbGVhbnVwQ2hlY2twb2ludCByZW1vdmVzIHRoZSByZWYgd2l0aG91dCBlcnJvclwiLCAodCkgPT4ge1xuICAgIGNvbnN0IHJlcG8gPSBjcmVhdGVUZW1wUmVwbygpO1xuICAgIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKHJlcG8sIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG5cbiAgICBjb25zdCBzaGEgPSBjcmVhdGVDaGVja3BvaW50KHJlcG8sIFwidW5pdC00XCIpO1xuICAgIGFzc2VydC5vayhzaGEpO1xuXG4gICAgY2xlYW51cENoZWNrcG9pbnQocmVwbywgXCJ1bml0LTRcIik7XG5cbiAgICBjb25zdCByZWYgPSBnaXQoW1wiZm9yLWVhY2gtcmVmXCIsIFwicmVmcy9nc2QvY2hlY2twb2ludHMvdW5pdC00XCIsIFwiLS1mb3JtYXQ9JShvYmplY3RuYW1lKVwiXSwgcmVwbyk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlZiwgXCJcIiwgXCJyZWYgc2hvdWxkIGJlIGdvbmVcIik7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFHQSxTQUFTLFVBQVUsVUFBVTtBQUM3QixPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhLGVBQWUsY0FBYztBQUNuRCxTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsb0JBQW9CO0FBQzdCLFNBQVMsa0JBQWtCLHNCQUFzQix5QkFBeUI7QUFFMUUsU0FBUyxJQUFJLE1BQWdCLEtBQXFCO0FBQ2hELFNBQU8s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
