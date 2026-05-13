import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  getAutoWorktreeOriginalBase,
  getActiveAutoWorktreeContext,
  _resetAutoWorktreeOriginalBaseForTests,
  createAutoWorktree,
  enterAutoWorktree,
  mergeMilestoneToMain,
  teardownAutoWorktree
} from "../auto-worktree.js";
function git(subArgs, cwd) {
  execFileSync("git", subArgs, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}
function createTempRepo(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "awreg-test-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(["init"], dir);
  git(["config", "user.email", "test@test.com"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), "# test\n");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
  git(["branch", "-M", "main"], dir);
  return dir;
}
describe("auto-worktree workspace registry", () => {
  const savedCwd = process.cwd();
  beforeEach(() => {
    _resetAutoWorktreeOriginalBaseForTests();
    process.chdir(savedCwd);
  });
  test("getAutoWorktreeOriginalBase() is null at baseline", () => {
    assert.strictEqual(getAutoWorktreeOriginalBase(), null);
  });
  test("getActiveAutoWorktreeContext() is null at baseline", () => {
    assert.strictEqual(getActiveAutoWorktreeContext(), null);
  });
  test("_resetAutoWorktreeOriginalBaseForTests() clears the registry \u2014 idempotent", () => {
    _resetAutoWorktreeOriginalBaseForTests();
    assert.strictEqual(getAutoWorktreeOriginalBase(), null);
    _resetAutoWorktreeOriginalBaseForTests();
    assert.strictEqual(getAutoWorktreeOriginalBase(), null);
  });
  test("behavioral equivalence: createAutoWorktree populates registry; teardown clears it", (t) => {
    const tempDir = createTempRepo(t);
    const msDir = join(tempDir, ".gsd", "milestones", "M001");
    mkdirSync(msDir, { recursive: true });
    writeFileSync(join(msDir, "CONTEXT.md"), "# M001 Context\n");
    git(["add", "."], tempDir);
    git(["commit", "-m", "add milestone"], tempDir);
    assert.strictEqual(
      getAutoWorktreeOriginalBase(),
      null,
      "originalBase is null before entering worktree"
    );
    createAutoWorktree(tempDir, "M001");
    assert.strictEqual(
      getAutoWorktreeOriginalBase(),
      tempDir,
      "getAutoWorktreeOriginalBase() returns projectRoot after createAutoWorktree"
    );
    const ctx = getActiveAutoWorktreeContext();
    assert.ok(ctx !== null, "context is non-null inside worktree");
    assert.strictEqual(ctx.originalBase, tempDir, "context.originalBase matches tempDir");
    assert.strictEqual(ctx.worktreeName, "M001", "context.worktreeName is M001");
    assert.strictEqual(ctx.branch, "milestone/M001", "context.branch is milestone/M001");
    teardownAutoWorktree(tempDir, "M001");
    assert.strictEqual(
      getAutoWorktreeOriginalBase(),
      null,
      "getAutoWorktreeOriginalBase() is null after teardown"
    );
    assert.strictEqual(
      getActiveAutoWorktreeContext(),
      null,
      "getActiveAutoWorktreeContext() is null after teardown"
    );
    try {
      process.chdir(savedCwd);
    } catch {
    }
  });
  test("behavioral equivalence: enterAutoWorktree also populates registry", (t) => {
    const tempDir = createTempRepo(t);
    const msDir = join(tempDir, ".gsd", "milestones", "M002");
    mkdirSync(msDir, { recursive: true });
    writeFileSync(join(msDir, "CONTEXT.md"), "# M002 Context\n");
    git(["add", "."], tempDir);
    git(["commit", "-m", "add milestone"], tempDir);
    createAutoWorktree(tempDir, "M002");
    _resetAutoWorktreeOriginalBaseForTests();
    process.chdir(tempDir);
    assert.strictEqual(
      getAutoWorktreeOriginalBase(),
      null,
      "registry is empty after manual reset"
    );
    enterAutoWorktree(tempDir, "M002");
    assert.strictEqual(
      getAutoWorktreeOriginalBase(),
      tempDir,
      "getAutoWorktreeOriginalBase() returns projectRoot after enterAutoWorktree"
    );
    const ctx = getActiveAutoWorktreeContext();
    assert.ok(ctx !== null, "context is non-null after re-entry");
    assert.strictEqual(ctx.originalBase, tempDir);
    assert.strictEqual(ctx.worktreeName, "M002");
    assert.strictEqual(ctx.branch, "milestone/M002");
    teardownAutoWorktree(tempDir, "M002");
    try {
      process.chdir(savedCwd);
    } catch {
    }
  });
  test("single-occupancy: entering a new workspace replaces the previous one", (t) => {
    const dir1 = createTempRepo(t);
    const dir2 = createTempRepo(t);
    const ms1Dir = join(dir1, ".gsd", "milestones", "M010");
    mkdirSync(ms1Dir, { recursive: true });
    writeFileSync(join(ms1Dir, "CONTEXT.md"), "# M010\n");
    git(["add", "."], dir1);
    git(["commit", "-m", "add milestone"], dir1);
    const ms2Dir = join(dir2, ".gsd", "milestones", "M020");
    mkdirSync(ms2Dir, { recursive: true });
    writeFileSync(join(ms2Dir, "CONTEXT.md"), "# M020\n");
    git(["add", "."], dir2);
    git(["commit", "-m", "add milestone"], dir2);
    createAutoWorktree(dir1, "M010");
    assert.strictEqual(
      getAutoWorktreeOriginalBase(),
      dir1,
      "registry holds dir1 after entering M010"
    );
    teardownAutoWorktree(dir1, "M010");
    assert.strictEqual(getAutoWorktreeOriginalBase(), null, "registry cleared after M010 teardown");
    createAutoWorktree(dir2, "M020");
    assert.strictEqual(
      getAutoWorktreeOriginalBase(),
      dir2,
      "registry holds dir2 after entering M020 (single-occupancy preserved)"
    );
    assert.notStrictEqual(
      getAutoWorktreeOriginalBase(),
      dir1,
      "dir1 is no longer in the registry"
    );
    teardownAutoWorktree(dir2, "M020");
    try {
      process.chdir(savedCwd);
    } catch {
    }
  });
  test("mergeMilestoneToMain cleans up when milestone branch was already regular-merged", (t) => {
    const tempDir = createTempRepo(t);
    const msDir = join(tempDir, ".gsd", "milestones", "M003");
    mkdirSync(msDir, { recursive: true });
    writeFileSync(join(msDir, "CONTEXT.md"), "# M003 Context\n");
    git(["add", "."], tempDir);
    git(["commit", "-m", "add milestone"], tempDir);
    createAutoWorktree(tempDir, "M003");
    const wtDir = join(tempDir, ".gsd", "worktrees", "M003");
    writeFileSync(join(wtDir, "feature.txt"), "implemented\n");
    git(["add", "feature.txt"], wtDir);
    git(["commit", "-m", "feat: implement M003"], wtDir);
    process.chdir(tempDir);
    git(["merge", "--no-ff", "milestone/M003", "-m", "merge M003"], tempDir);
    process.chdir(wtDir);
    const result = mergeMilestoneToMain(tempDir, "M003", "# M003\n- [x] **S01: Done**\n");
    assert.equal(result.codeFilesChanged, true);
    assert.equal(result.pushed, false);
    assert.equal(result.prCreated, false);
    assert.equal(existsSync(wtDir), false, "worktree directory is removed");
    assert.throws(
      () => git(["rev-parse", "--verify", "milestone/M003"], tempDir),
      /Command failed/,
      "already-merged milestone branch is deleted"
    );
    try {
      process.chdir(savedCwd);
    } catch {
    }
  });
  test("mergeMilestoneToMain cleans up already-merged milestone after main advances", (t) => {
    const tempDir = createTempRepo(t);
    const msDir = join(tempDir, ".gsd", "milestones", "M004");
    mkdirSync(msDir, { recursive: true });
    writeFileSync(join(msDir, "CONTEXT.md"), "# M004 Context\n");
    git(["add", "."], tempDir);
    git(["commit", "-m", "add milestone"], tempDir);
    createAutoWorktree(tempDir, "M004");
    const wtDir = join(tempDir, ".gsd", "worktrees", "M004");
    writeFileSync(join(wtDir, "feature.txt"), "implemented\n");
    git(["add", "feature.txt"], wtDir);
    git(["commit", "-m", "feat: implement M004"], wtDir);
    process.chdir(tempDir);
    git(["merge", "--no-ff", "milestone/M004", "-m", "merge M004"], tempDir);
    writeFileSync(join(tempDir, "hotfix.txt"), "later main work\n");
    git(["add", "hotfix.txt"], tempDir);
    git(["commit", "-m", "fix: advance main"], tempDir);
    process.chdir(wtDir);
    const result = mergeMilestoneToMain(tempDir, "M004", "# M004\n- [x] **S01: Done**\n");
    assert.equal(result.codeFilesChanged, true);
    assert.equal(result.pushed, false);
    assert.equal(result.prCreated, false);
    assert.equal(existsSync(wtDir), false, "worktree directory is removed");
    assert.throws(
      () => git(["rev-parse", "--verify", "milestone/M004"], tempDir),
      /Command failed/,
      "already-merged milestone branch is deleted"
    );
    try {
      process.chdir(savedCwd);
    } catch {
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9hdXRvLXdvcmt0cmVlLXJlZ2lzdHJ5LnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRC0yICsgVW5pdCB0ZXN0cyBmb3IgdGhlIHdvcmtzcGFjZSByZWdpc3RyeSB0aGF0IHJlcGxhY2VkIHRoZSBvcmlnaW5hbEJhc2Ugc2luZ2xldG9uXG5cbmltcG9ydCB7IGRlc2NyaWJlLCB0ZXN0LCBiZWZvcmVFYWNoIH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCB3cml0ZUZpbGVTeW5jLCBybVN5bmMsIHJlYWxwYXRoU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGV4ZWNGaWxlU3luYyB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcblxuaW1wb3J0IHtcbiAgZ2V0QXV0b1dvcmt0cmVlT3JpZ2luYWxCYXNlLFxuICBnZXRBY3RpdmVBdXRvV29ya3RyZWVDb250ZXh0LFxuICBfcmVzZXRBdXRvV29ya3RyZWVPcmlnaW5hbEJhc2VGb3JUZXN0cyxcbiAgY3JlYXRlQXV0b1dvcmt0cmVlLFxuICBlbnRlckF1dG9Xb3JrdHJlZSxcbiAgbWVyZ2VNaWxlc3RvbmVUb01haW4sXG4gIHRlYXJkb3duQXV0b1dvcmt0cmVlLFxufSBmcm9tIFwiLi4vYXV0by13b3JrdHJlZS50c1wiO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgSGVscGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLy8gU2FmZTogYWxsIGlucHV0cyBiZWxvdyBhcmUgaGFyZGNvZGVkIHRlc3Qgc3RyaW5ncywgbm90IHVzZXIgaW5wdXQuXG5mdW5jdGlvbiBnaXQoc3ViQXJnczogc3RyaW5nW10sIGN3ZDogc3RyaW5nKTogdm9pZCB7XG4gIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBzdWJBcmdzLCB7IGN3ZCwgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdIH0pO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVUZW1wUmVwbyh0OiB7IGFmdGVyOiAoZm46ICgpID0+IHZvaWQpID0+IHZvaWQgfSk6IHN0cmluZyB7XG4gIGNvbnN0IGRpciA9IHJlYWxwYXRoU3luYyhta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImF3cmVnLXRlc3QtXCIpKSk7XG4gIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcbiAgZ2l0KFtcImluaXRcIl0sIGRpcik7XG4gIGdpdChbXCJjb25maWdcIiwgXCJ1c2VyLmVtYWlsXCIsIFwidGVzdEB0ZXN0LmNvbVwiXSwgZGlyKTtcbiAgZ2l0KFtcImNvbmZpZ1wiLCBcInVzZXIubmFtZVwiLCBcIlRlc3RcIl0sIGRpcik7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiUkVBRE1FLm1kXCIpLCBcIiMgdGVzdFxcblwiKTtcbiAgbWtkaXJTeW5jKGpvaW4oZGlyLCBcIi5nc2RcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBnaXQoW1wiYWRkXCIsIFwiLlwiXSwgZGlyKTtcbiAgZ2l0KFtcImNvbW1pdFwiLCBcIi1tXCIsIFwiaW5pdFwiXSwgZGlyKTtcbiAgZ2l0KFtcImJyYW5jaFwiLCBcIi1NXCIsIFwibWFpblwiXSwgZGlyKTtcbiAgcmV0dXJuIGRpcjtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRlc3RzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcImF1dG8td29ya3RyZWUgd29ya3NwYWNlIHJlZ2lzdHJ5XCIsICgpID0+IHtcbiAgY29uc3Qgc2F2ZWRDd2QgPSBwcm9jZXNzLmN3ZCgpO1xuXG4gIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgIF9yZXNldEF1dG9Xb3JrdHJlZU9yaWdpbmFsQmFzZUZvclRlc3RzKCk7XG4gICAgcHJvY2Vzcy5jaGRpcihzYXZlZEN3ZCk7XG4gIH0pO1xuXG4gIHRlc3QoXCJnZXRBdXRvV29ya3RyZWVPcmlnaW5hbEJhc2UoKSBpcyBudWxsIGF0IGJhc2VsaW5lXCIsICgpID0+IHtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoZ2V0QXV0b1dvcmt0cmVlT3JpZ2luYWxCYXNlKCksIG51bGwpO1xuICB9KTtcblxuICB0ZXN0KFwiZ2V0QWN0aXZlQXV0b1dvcmt0cmVlQ29udGV4dCgpIGlzIG51bGwgYXQgYmFzZWxpbmVcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChnZXRBY3RpdmVBdXRvV29ya3RyZWVDb250ZXh0KCksIG51bGwpO1xuICB9KTtcblxuICB0ZXN0KFwiX3Jlc2V0QXV0b1dvcmt0cmVlT3JpZ2luYWxCYXNlRm9yVGVzdHMoKSBjbGVhcnMgdGhlIHJlZ2lzdHJ5IFx1MjAxNCBpZGVtcG90ZW50XCIsICgpID0+IHtcbiAgICBfcmVzZXRBdXRvV29ya3RyZWVPcmlnaW5hbEJhc2VGb3JUZXN0cygpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChnZXRBdXRvV29ya3RyZWVPcmlnaW5hbEJhc2UoKSwgbnVsbCk7XG4gICAgX3Jlc2V0QXV0b1dvcmt0cmVlT3JpZ2luYWxCYXNlRm9yVGVzdHMoKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoZ2V0QXV0b1dvcmt0cmVlT3JpZ2luYWxCYXNlKCksIG51bGwpO1xuICB9KTtcblxuICB0ZXN0KFwiYmVoYXZpb3JhbCBlcXVpdmFsZW5jZTogY3JlYXRlQXV0b1dvcmt0cmVlIHBvcHVsYXRlcyByZWdpc3RyeTsgdGVhcmRvd24gY2xlYXJzIGl0XCIsICh0KSA9PiB7XG4gICAgY29uc3QgdGVtcERpciA9IGNyZWF0ZVRlbXBSZXBvKHQpO1xuICAgIGNvbnN0IG1zRGlyID0gam9pbih0ZW1wRGlyLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiKTtcbiAgICBta2RpclN5bmMobXNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihtc0RpciwgXCJDT05URVhULm1kXCIpLCBcIiMgTTAwMSBDb250ZXh0XFxuXCIpO1xuICAgIGdpdChbXCJhZGRcIiwgXCIuXCJdLCB0ZW1wRGlyKTtcbiAgICBnaXQoW1wiY29tbWl0XCIsIFwiLW1cIiwgXCJhZGQgbWlsZXN0b25lXCJdLCB0ZW1wRGlyKTtcblxuICAgIC8vIEJlZm9yZSBlbnRlcmluZzogcmVnaXN0cnkgbXVzdCBiZSBlbXB0eVxuICAgIGFzc2VydC5zdHJpY3RFcXVhbChnZXRBdXRvV29ya3RyZWVPcmlnaW5hbEJhc2UoKSwgbnVsbCxcbiAgICAgIFwib3JpZ2luYWxCYXNlIGlzIG51bGwgYmVmb3JlIGVudGVyaW5nIHdvcmt0cmVlXCIpO1xuXG4gICAgY3JlYXRlQXV0b1dvcmt0cmVlKHRlbXBEaXIsIFwiTTAwMVwiKTtcblxuICAgIC8vIEFmdGVyIGVudGVyOiBnZXRBdXRvV29ya3RyZWVPcmlnaW5hbEJhc2UgbXVzdCBlcXVhbCB0ZW1wRGlyXG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKFxuICAgICAgZ2V0QXV0b1dvcmt0cmVlT3JpZ2luYWxCYXNlKCksXG4gICAgICB0ZW1wRGlyLFxuICAgICAgXCJnZXRBdXRvV29ya3RyZWVPcmlnaW5hbEJhc2UoKSByZXR1cm5zIHByb2plY3RSb290IGFmdGVyIGNyZWF0ZUF1dG9Xb3JrdHJlZVwiLFxuICAgICk7XG5cbiAgICAvLyBnZXRBY3RpdmVBdXRvV29ya3RyZWVDb250ZXh0IG11c3QgcmV0dXJuIHRoZSBjb3JyZWN0IHNoYXBlXG4gICAgY29uc3QgY3R4ID0gZ2V0QWN0aXZlQXV0b1dvcmt0cmVlQ29udGV4dCgpO1xuICAgIGFzc2VydC5vayhjdHggIT09IG51bGwsIFwiY29udGV4dCBpcyBub24tbnVsbCBpbnNpZGUgd29ya3RyZWVcIik7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKGN0eC5vcmlnaW5hbEJhc2UsIHRlbXBEaXIsIFwiY29udGV4dC5vcmlnaW5hbEJhc2UgbWF0Y2hlcyB0ZW1wRGlyXCIpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChjdHgud29ya3RyZWVOYW1lLCBcIk0wMDFcIiwgXCJjb250ZXh0Lndvcmt0cmVlTmFtZSBpcyBNMDAxXCIpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChjdHguYnJhbmNoLCBcIm1pbGVzdG9uZS9NMDAxXCIsIFwiY29udGV4dC5icmFuY2ggaXMgbWlsZXN0b25lL00wMDFcIik7XG5cbiAgICAvLyBUZWFyZG93bjogcmVnaXN0cnkgbXVzdCBiZSBjbGVhcmVkXG4gICAgdGVhcmRvd25BdXRvV29ya3RyZWUodGVtcERpciwgXCJNMDAxXCIpO1xuXG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKGdldEF1dG9Xb3JrdHJlZU9yaWdpbmFsQmFzZSgpLCBudWxsLFxuICAgICAgXCJnZXRBdXRvV29ya3RyZWVPcmlnaW5hbEJhc2UoKSBpcyBudWxsIGFmdGVyIHRlYXJkb3duXCIpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChnZXRBY3RpdmVBdXRvV29ya3RyZWVDb250ZXh0KCksIG51bGwsXG4gICAgICBcImdldEFjdGl2ZUF1dG9Xb3JrdHJlZUNvbnRleHQoKSBpcyBudWxsIGFmdGVyIHRlYXJkb3duXCIpO1xuXG4gICAgdHJ5IHsgcHJvY2Vzcy5jaGRpcihzYXZlZEN3ZCk7IH0gY2F0Y2ggeyAvKiBpZ25vcmUgKi8gfVxuICB9KTtcblxuICB0ZXN0KFwiYmVoYXZpb3JhbCBlcXVpdmFsZW5jZTogZW50ZXJBdXRvV29ya3RyZWUgYWxzbyBwb3B1bGF0ZXMgcmVnaXN0cnlcIiwgKHQpID0+IHtcbiAgICBjb25zdCB0ZW1wRGlyID0gY3JlYXRlVGVtcFJlcG8odCk7XG4gICAgY29uc3QgbXNEaXIgPSBqb2luKHRlbXBEaXIsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAyXCIpO1xuICAgIG1rZGlyU3luYyhtc0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKG1zRGlyLCBcIkNPTlRFWFQubWRcIiksIFwiIyBNMDAyIENvbnRleHRcXG5cIik7XG4gICAgZ2l0KFtcImFkZFwiLCBcIi5cIl0sIHRlbXBEaXIpO1xuICAgIGdpdChbXCJjb21taXRcIiwgXCItbVwiLCBcImFkZCBtaWxlc3RvbmVcIl0sIHRlbXBEaXIpO1xuXG4gICAgY3JlYXRlQXV0b1dvcmt0cmVlKHRlbXBEaXIsIFwiTTAwMlwiKTtcblxuICAgIC8vIFNpbXVsYXRlIGxlYXZpbmcgdGhlIHdvcmt0cmVlIChjcmFzaC9wYXVzZSlcbiAgICBfcmVzZXRBdXRvV29ya3RyZWVPcmlnaW5hbEJhc2VGb3JUZXN0cygpO1xuICAgIHByb2Nlc3MuY2hkaXIodGVtcERpcik7XG5cbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoZ2V0QXV0b1dvcmt0cmVlT3JpZ2luYWxCYXNlKCksIG51bGwsXG4gICAgICBcInJlZ2lzdHJ5IGlzIGVtcHR5IGFmdGVyIG1hbnVhbCByZXNldFwiKTtcblxuICAgIC8vIFJlLWVudGVyIHZpYSBlbnRlckF1dG9Xb3JrdHJlZVxuICAgIGVudGVyQXV0b1dvcmt0cmVlKHRlbXBEaXIsIFwiTTAwMlwiKTtcblxuICAgIGFzc2VydC5zdHJpY3RFcXVhbChcbiAgICAgIGdldEF1dG9Xb3JrdHJlZU9yaWdpbmFsQmFzZSgpLFxuICAgICAgdGVtcERpcixcbiAgICAgIFwiZ2V0QXV0b1dvcmt0cmVlT3JpZ2luYWxCYXNlKCkgcmV0dXJucyBwcm9qZWN0Um9vdCBhZnRlciBlbnRlckF1dG9Xb3JrdHJlZVwiLFxuICAgICk7XG4gICAgY29uc3QgY3R4ID0gZ2V0QWN0aXZlQXV0b1dvcmt0cmVlQ29udGV4dCgpO1xuICAgIGFzc2VydC5vayhjdHggIT09IG51bGwsIFwiY29udGV4dCBpcyBub24tbnVsbCBhZnRlciByZS1lbnRyeVwiKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoY3R4Lm9yaWdpbmFsQmFzZSwgdGVtcERpcik7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKGN0eC53b3JrdHJlZU5hbWUsIFwiTTAwMlwiKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoY3R4LmJyYW5jaCwgXCJtaWxlc3RvbmUvTTAwMlwiKTtcblxuICAgIHRlYXJkb3duQXV0b1dvcmt0cmVlKHRlbXBEaXIsIFwiTTAwMlwiKTtcbiAgICB0cnkgeyBwcm9jZXNzLmNoZGlyKHNhdmVkQ3dkKTsgfSBjYXRjaCB7IC8qIGlnbm9yZSAqLyB9XG4gIH0pO1xuXG4gIHRlc3QoXCJzaW5nbGUtb2NjdXBhbmN5OiBlbnRlcmluZyBhIG5ldyB3b3Jrc3BhY2UgcmVwbGFjZXMgdGhlIHByZXZpb3VzIG9uZVwiLCAodCkgPT4ge1xuICAgIGNvbnN0IGRpcjEgPSBjcmVhdGVUZW1wUmVwbyh0KTtcbiAgICBjb25zdCBkaXIyID0gY3JlYXRlVGVtcFJlcG8odCk7XG5cbiAgICAvLyBTZXQgdXAgbWlsZXN0b25lIGluIGRpcjFcbiAgICBjb25zdCBtczFEaXIgPSBqb2luKGRpcjEsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDEwXCIpO1xuICAgIG1rZGlyU3luYyhtczFEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihtczFEaXIsIFwiQ09OVEVYVC5tZFwiKSwgXCIjIE0wMTBcXG5cIik7XG4gICAgZ2l0KFtcImFkZFwiLCBcIi5cIl0sIGRpcjEpO1xuICAgIGdpdChbXCJjb21taXRcIiwgXCItbVwiLCBcImFkZCBtaWxlc3RvbmVcIl0sIGRpcjEpO1xuXG4gICAgLy8gU2V0IHVwIG1pbGVzdG9uZSBpbiBkaXIyXG4gICAgY29uc3QgbXMyRGlyID0gam9pbihkaXIyLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAyMFwiKTtcbiAgICBta2RpclN5bmMobXMyRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4obXMyRGlyLCBcIkNPTlRFWFQubWRcIiksIFwiIyBNMDIwXFxuXCIpO1xuICAgIGdpdChbXCJhZGRcIiwgXCIuXCJdLCBkaXIyKTtcbiAgICBnaXQoW1wiY29tbWl0XCIsIFwiLW1cIiwgXCJhZGQgbWlsZXN0b25lXCJdLCBkaXIyKTtcblxuICAgIC8vIEVudGVyIGRpcjEvTTAxMFxuICAgIGNyZWF0ZUF1dG9Xb3JrdHJlZShkaXIxLCBcIk0wMTBcIik7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKGdldEF1dG9Xb3JrdHJlZU9yaWdpbmFsQmFzZSgpLCBkaXIxLFxuICAgICAgXCJyZWdpc3RyeSBob2xkcyBkaXIxIGFmdGVyIGVudGVyaW5nIE0wMTBcIik7XG5cbiAgICAvLyBUZWFyIGRvd24gZGlyMSBjbGVhbmx5XG4gICAgdGVhcmRvd25BdXRvV29ya3RyZWUoZGlyMSwgXCJNMDEwXCIpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChnZXRBdXRvV29ya3RyZWVPcmlnaW5hbEJhc2UoKSwgbnVsbCwgXCJyZWdpc3RyeSBjbGVhcmVkIGFmdGVyIE0wMTAgdGVhcmRvd25cIik7XG5cbiAgICAvLyBFbnRlciBkaXIyL00wMjAgXHUyMDE0IHJlZ2lzdHJ5IHNob3VsZCBub3cgaG9sZCBkaXIyIG9ubHlcbiAgICBjcmVhdGVBdXRvV29ya3RyZWUoZGlyMiwgXCJNMDIwXCIpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChnZXRBdXRvV29ya3RyZWVPcmlnaW5hbEJhc2UoKSwgZGlyMixcbiAgICAgIFwicmVnaXN0cnkgaG9sZHMgZGlyMiBhZnRlciBlbnRlcmluZyBNMDIwIChzaW5nbGUtb2NjdXBhbmN5IHByZXNlcnZlZClcIik7XG4gICAgYXNzZXJ0Lm5vdFN0cmljdEVxdWFsKGdldEF1dG9Xb3JrdHJlZU9yaWdpbmFsQmFzZSgpLCBkaXIxLFxuICAgICAgXCJkaXIxIGlzIG5vIGxvbmdlciBpbiB0aGUgcmVnaXN0cnlcIik7XG5cbiAgICB0ZWFyZG93bkF1dG9Xb3JrdHJlZShkaXIyLCBcIk0wMjBcIik7XG4gICAgdHJ5IHsgcHJvY2Vzcy5jaGRpcihzYXZlZEN3ZCk7IH0gY2F0Y2ggeyAvKiBpZ25vcmUgKi8gfVxuICB9KTtcblxuICB0ZXN0KFwibWVyZ2VNaWxlc3RvbmVUb01haW4gY2xlYW5zIHVwIHdoZW4gbWlsZXN0b25lIGJyYW5jaCB3YXMgYWxyZWFkeSByZWd1bGFyLW1lcmdlZFwiLCAodCkgPT4ge1xuICAgIGNvbnN0IHRlbXBEaXIgPSBjcmVhdGVUZW1wUmVwbyh0KTtcbiAgICBjb25zdCBtc0RpciA9IGpvaW4odGVtcERpciwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDNcIik7XG4gICAgbWtkaXJTeW5jKG1zRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4obXNEaXIsIFwiQ09OVEVYVC5tZFwiKSwgXCIjIE0wMDMgQ29udGV4dFxcblwiKTtcbiAgICBnaXQoW1wiYWRkXCIsIFwiLlwiXSwgdGVtcERpcik7XG4gICAgZ2l0KFtcImNvbW1pdFwiLCBcIi1tXCIsIFwiYWRkIG1pbGVzdG9uZVwiXSwgdGVtcERpcik7XG5cbiAgICBjcmVhdGVBdXRvV29ya3RyZWUodGVtcERpciwgXCJNMDAzXCIpO1xuICAgIGNvbnN0IHd0RGlyID0gam9pbih0ZW1wRGlyLCBcIi5nc2RcIiwgXCJ3b3JrdHJlZXNcIiwgXCJNMDAzXCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbih3dERpciwgXCJmZWF0dXJlLnR4dFwiKSwgXCJpbXBsZW1lbnRlZFxcblwiKTtcbiAgICBnaXQoW1wiYWRkXCIsIFwiZmVhdHVyZS50eHRcIl0sIHd0RGlyKTtcbiAgICBnaXQoW1wiY29tbWl0XCIsIFwiLW1cIiwgXCJmZWF0OiBpbXBsZW1lbnQgTTAwM1wiXSwgd3REaXIpO1xuXG4gICAgcHJvY2Vzcy5jaGRpcih0ZW1wRGlyKTtcbiAgICBnaXQoW1wibWVyZ2VcIiwgXCItLW5vLWZmXCIsIFwibWlsZXN0b25lL00wMDNcIiwgXCItbVwiLCBcIm1lcmdlIE0wMDNcIl0sIHRlbXBEaXIpO1xuXG4gICAgcHJvY2Vzcy5jaGRpcih3dERpcik7XG4gICAgY29uc3QgcmVzdWx0ID0gbWVyZ2VNaWxlc3RvbmVUb01haW4odGVtcERpciwgXCJNMDAzXCIsIFwiIyBNMDAzXFxuLSBbeF0gKipTMDE6IERvbmUqKlxcblwiKTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuY29kZUZpbGVzQ2hhbmdlZCwgdHJ1ZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5wdXNoZWQsIGZhbHNlKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnByQ3JlYXRlZCwgZmFsc2UpO1xuICAgIGFzc2VydC5lcXVhbChleGlzdHNTeW5jKHd0RGlyKSwgZmFsc2UsIFwid29ya3RyZWUgZGlyZWN0b3J5IGlzIHJlbW92ZWRcIik7XG4gICAgYXNzZXJ0LnRocm93cyhcbiAgICAgICgpID0+IGdpdChbXCJyZXYtcGFyc2VcIiwgXCItLXZlcmlmeVwiLCBcIm1pbGVzdG9uZS9NMDAzXCJdLCB0ZW1wRGlyKSxcbiAgICAgIC9Db21tYW5kIGZhaWxlZC8sXG4gICAgICBcImFscmVhZHktbWVyZ2VkIG1pbGVzdG9uZSBicmFuY2ggaXMgZGVsZXRlZFwiLFxuICAgICk7XG4gICAgdHJ5IHsgcHJvY2Vzcy5jaGRpcihzYXZlZEN3ZCk7IH0gY2F0Y2ggeyAvKiBpZ25vcmUgKi8gfVxuICB9KTtcblxuICB0ZXN0KFwibWVyZ2VNaWxlc3RvbmVUb01haW4gY2xlYW5zIHVwIGFscmVhZHktbWVyZ2VkIG1pbGVzdG9uZSBhZnRlciBtYWluIGFkdmFuY2VzXCIsICh0KSA9PiB7XG4gICAgY29uc3QgdGVtcERpciA9IGNyZWF0ZVRlbXBSZXBvKHQpO1xuICAgIGNvbnN0IG1zRGlyID0gam9pbih0ZW1wRGlyLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwNFwiKTtcbiAgICBta2RpclN5bmMobXNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihtc0RpciwgXCJDT05URVhULm1kXCIpLCBcIiMgTTAwNCBDb250ZXh0XFxuXCIpO1xuICAgIGdpdChbXCJhZGRcIiwgXCIuXCJdLCB0ZW1wRGlyKTtcbiAgICBnaXQoW1wiY29tbWl0XCIsIFwiLW1cIiwgXCJhZGQgbWlsZXN0b25lXCJdLCB0ZW1wRGlyKTtcblxuICAgIGNyZWF0ZUF1dG9Xb3JrdHJlZSh0ZW1wRGlyLCBcIk0wMDRcIik7XG4gICAgY29uc3Qgd3REaXIgPSBqb2luKHRlbXBEaXIsIFwiLmdzZFwiLCBcIndvcmt0cmVlc1wiLCBcIk0wMDRcIik7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHd0RGlyLCBcImZlYXR1cmUudHh0XCIpLCBcImltcGxlbWVudGVkXFxuXCIpO1xuICAgIGdpdChbXCJhZGRcIiwgXCJmZWF0dXJlLnR4dFwiXSwgd3REaXIpO1xuICAgIGdpdChbXCJjb21taXRcIiwgXCItbVwiLCBcImZlYXQ6IGltcGxlbWVudCBNMDA0XCJdLCB3dERpcik7XG5cbiAgICBwcm9jZXNzLmNoZGlyKHRlbXBEaXIpO1xuICAgIGdpdChbXCJtZXJnZVwiLCBcIi0tbm8tZmZcIiwgXCJtaWxlc3RvbmUvTTAwNFwiLCBcIi1tXCIsIFwibWVyZ2UgTTAwNFwiXSwgdGVtcERpcik7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHRlbXBEaXIsIFwiaG90Zml4LnR4dFwiKSwgXCJsYXRlciBtYWluIHdvcmtcXG5cIik7XG4gICAgZ2l0KFtcImFkZFwiLCBcImhvdGZpeC50eHRcIl0sIHRlbXBEaXIpO1xuICAgIGdpdChbXCJjb21taXRcIiwgXCItbVwiLCBcImZpeDogYWR2YW5jZSBtYWluXCJdLCB0ZW1wRGlyKTtcblxuICAgIHByb2Nlc3MuY2hkaXIod3REaXIpO1xuICAgIGNvbnN0IHJlc3VsdCA9IG1lcmdlTWlsZXN0b25lVG9NYWluKHRlbXBEaXIsIFwiTTAwNFwiLCBcIiMgTTAwNFxcbi0gW3hdICoqUzAxOiBEb25lKipcXG5cIik7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmNvZGVGaWxlc0NoYW5nZWQsIHRydWUpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQucHVzaGVkLCBmYWxzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5wckNyZWF0ZWQsIGZhbHNlKTtcbiAgICBhc3NlcnQuZXF1YWwoZXhpc3RzU3luYyh3dERpciksIGZhbHNlLCBcIndvcmt0cmVlIGRpcmVjdG9yeSBpcyByZW1vdmVkXCIpO1xuICAgIGFzc2VydC50aHJvd3MoXG4gICAgICAoKSA9PiBnaXQoW1wicmV2LXBhcnNlXCIsIFwiLS12ZXJpZnlcIiwgXCJtaWxlc3RvbmUvTTAwNFwiXSwgdGVtcERpciksXG4gICAgICAvQ29tbWFuZCBmYWlsZWQvLFxuICAgICAgXCJhbHJlYWR5LW1lcmdlZCBtaWxlc3RvbmUgYnJhbmNoIGlzIGRlbGV0ZWRcIixcbiAgICApO1xuICAgIHRyeSB7IHByb2Nlc3MuY2hkaXIoc2F2ZWRDd2QpOyB9IGNhdGNoIHsgLyogaWdub3JlICovIH1cbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUVBLFNBQVMsVUFBVSxNQUFNLGtCQUFrQjtBQUMzQyxPQUFPLFlBQVk7QUFDbkIsU0FBUyxZQUFZLGFBQWEsV0FBVyxlQUFlLFFBQVEsb0JBQW9CO0FBQ3hGLFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFDdkIsU0FBUyxvQkFBb0I7QUFFN0I7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUtQLFNBQVMsSUFBSSxTQUFtQixLQUFtQjtBQUNqRCxlQUFhLE9BQU8sU0FBUyxFQUFFLEtBQUssT0FBTyxDQUFDLFVBQVUsUUFBUSxNQUFNLEVBQUUsQ0FBQztBQUN6RTtBQUVBLFNBQVMsZUFBZSxHQUFnRDtBQUN0RSxRQUFNLE1BQU0sYUFBYSxZQUFZLEtBQUssT0FBTyxHQUFHLGFBQWEsQ0FBQyxDQUFDO0FBQ25FLElBQUUsTUFBTSxNQUFNLE9BQU8sS0FBSyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQyxDQUFDO0FBQzNELE1BQUksQ0FBQyxNQUFNLEdBQUcsR0FBRztBQUNqQixNQUFJLENBQUMsVUFBVSxjQUFjLGVBQWUsR0FBRyxHQUFHO0FBQ2xELE1BQUksQ0FBQyxVQUFVLGFB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
