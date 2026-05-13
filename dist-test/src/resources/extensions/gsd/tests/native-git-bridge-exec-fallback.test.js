import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  assertWorktreeMaterialized,
  nativeBranchDelete,
  nativeCommit,
  nativeGetCurrentBranch,
  nativeIsRepo,
  nativeResetHard,
  nativeWorktreeAdd
} from "../native-git-bridge.js";
import { GIT_NO_PROMPT_ENV } from "../git-constants.js";
function git(args, cwd) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}
describe("native-git-bridge #4180: fallback runtime behaviour", () => {
  let repo;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "ngb4180-"));
    git(["init"], repo);
    git(["config", "user.email", "test@test.com"], repo);
    git(["config", "user.name", "Test"], repo);
    writeFileSync(join(repo, "file.txt"), "initial\n");
    git(["add", "."], repo);
    git(["commit", "-m", "init"], repo);
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  test("nativeIsRepo returns true for a valid git repository", () => {
    assert.equal(nativeIsRepo(repo), true);
  });
  test("nativeIsRepo returns false for a plain directory", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "ngb4180-notrepo-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    assert.equal(nativeIsRepo(dir), false);
  });
  test("nativeCommit commits staged changes and returns non-null output", () => {
    writeFileSync(join(repo, "file.txt"), "modified\n");
    git(["add", "."], repo);
    const result = nativeCommit(repo, "test: regression commit #4180");
    assert.ok(result !== null, "should return output string for a successful commit");
    const subject = git(["log", "-1", "--format=%s"], repo);
    assert.equal(subject, "test: regression commit #4180");
  });
  test("nativeCommit retries once after transient ENOBUFS from git", (t) => {
    const bin = mkdtempSync(join(tmpdir(), "ngb-enobufs-bin-"));
    t.after(() => rmSync(bin, { recursive: true, force: true }));
    const realGit = execFileSync("git", ["--exec-path"], { encoding: "utf-8" }).trim();
    const attempts = join(bin, "attempts.txt");
    const fakeGit = join(bin, "fake-git.cjs");
    writeFileSync(fakeGit, `
const { appendFileSync, readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const attempts = ${JSON.stringify(attempts)};
const realGit = ${JSON.stringify(join(realGit, process.platform === "win32" ? "git.exe" : "git"))};
appendFileSync(attempts, "1");
if (process.argv[2] === "commit" && readFileSync(attempts, "utf-8").length === 1) {
  console.error("spawnSync git ENOBUFS");
  process.exit(1);
}
const result = spawnSync(realGit, process.argv.slice(2), { stdio: "inherit" });
process.exit(result.status ?? 1);
`, "utf-8");
    if (process.platform === "win32") {
      writeFileSync(join(bin, "git.cmd"), `@echo off\r
node "${fakeGit}" %*\r
`, "utf-8");
    } else {
      const shim = join(bin, "git");
      writeFileSync(shim, `#!/bin/sh
exec node "${fakeGit}" "$@"
`, "utf-8");
      chmodSync(shim, 493);
    }
    writeFileSync(join(repo, "file.txt"), "retry commit\n");
    git(["add", "."], repo);
    const originalPath = process.env.PATH ?? "";
    const gitEnv = GIT_NO_PROMPT_ENV;
    const originalGitEnvPath = gitEnv.PATH;
    try {
      process.env.PATH = `${bin}${delimiter}${originalPath}`;
      gitEnv.PATH = process.env.PATH;
      const result = nativeCommit(repo, "test: retry ENOBUFS commit");
      assert.ok(result !== null, "commit should succeed after retry");
    } finally {
      process.env.PATH = originalPath;
      gitEnv.PATH = originalGitEnvPath;
    }
    assert.equal(readFileSync(attempts, "utf-8").length, 2);
    assert.equal(git(["log", "-1", "--format=%s"], repo), "test: retry ENOBUFS commit");
  });
  test("nativeCommit runs commit hooks", () => {
    const hookPath = join(repo, ".git", "hooks", "commit-msg");
    const marker = join(repo, "hook-ran.txt");
    writeFileSync(hookPath, `#!/bin/sh
printf ran > "${marker}"
`, "utf-8");
    chmodSync(hookPath, 493);
    writeFileSync(join(repo, "file.txt"), "hooked\n");
    git(["add", "."], repo);
    nativeCommit(repo, "test: hook execution");
    assert.equal(readFileSync(marker, "utf-8"), "ran");
  });
  test("nativeCommit returns null when nothing is staged", () => {
    const result = nativeCommit(repo, "test: nothing staged");
    assert.equal(result, null);
  });
  test("nativeCommit respects the allowEmpty option", () => {
    const result = nativeCommit(repo, "test: empty commit #4180", { allowEmpty: true });
    assert.ok(result !== null, "allow-empty commit should return output");
    const subject = git(["log", "-1", "--format=%s"], repo);
    assert.equal(subject, "test: empty commit #4180");
  });
  test("nativeResetHard discards unstaged working tree changes", () => {
    writeFileSync(join(repo, "file.txt"), "dirty content\n");
    const statusBefore = git(["status", "--short"], repo);
    assert.ok(statusBefore.length > 0, "repo should be dirty before reset");
    nativeResetHard(repo);
    const content = readFileSync(join(repo, "file.txt"), "utf-8");
    assert.equal(content, "initial\n", "file should be restored to HEAD content after hard reset");
  });
  test("nativeBranchDelete throws when git cannot delete the branch", () => {
    assert.throws(
      () => nativeBranchDelete(repo, "does-not-exist"),
      /git branch -D does-not-exist failed[\s\S]*does-not-exist/
    );
  });
  test("nativeGetCurrentBranch preserves git stderr in fallback errors", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "ngb-stderr-notrepo-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    assert.throws(
      () => nativeGetCurrentBranch(dir),
      /git branch --show-current failed[\s\S]*(not a git repository|not a git repo|fatal:)/
    );
  });
  test("assertWorktreeMaterialized rejects directories without a .git file", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "ngb-worktree-missing-git-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    assert.throws(
      () => assertWorktreeMaterialized(dir),
      /missing \.git file/
    );
  });
  test("nativeWorktreeAdd materializes a valid .git marker", (t) => {
    const wtPath = join(repo, ".gsd", "worktrees", "M001");
    t.after(() => {
      try {
        git(["worktree", "remove", "--force", wtPath], repo);
      } catch {
      }
    });
    nativeWorktreeAdd(repo, wtPath, "milestone/M001", true, "HEAD");
    assert.equal(
      existsSync(join(wtPath, ".git")),
      true,
      "created worktree must have the .git file required by later health checks"
    );
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9uYXRpdmUtZ2l0LWJyaWRnZS1leGVjLWZhbGxiYWNrLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIG5hdGl2ZS1naXQtYnJpZGdlLWV4ZWMtZmFsbGJhY2sudGVzdC50cyBcdTIwMTQgcmVncmVzc2lvbiBmb3IgIzQxODBcbi8vXG4vLyBuYXRpdmVDb21taXQsIG5hdGl2ZUlzUmVwbywgYW5kIG5hdGl2ZVJlc2V0SGFyZCB1c2VkIGV4ZWNTeW5jKCkgKHN0cmluZ1xuLy8gY29tbWFuZCkgaW4gdGhlaXIgZmFsbGJhY2sgcGF0aHMuIE9uIFdpbmRvd3MsIGV4ZWNTeW5jIHNwYXducyBjbWQuZXhlIHdoaWNoXG4vLyBjYW5ub3QgcmVzb2x2ZSBnaXQgd2hlbiBHaXQgZm9yIFdpbmRvd3MgaXMgaW5zdGFsbGVkIHZpYSBNU1lTMi9iYXNoIGJ1dCBub3Rcbi8vIGluIGNtZC5leGUncyBQQVRILiBBbGwgb3RoZXIgZmFsbGJhY2sgcGF0aHMgaW4gdGhpcyBmaWxlIHVzZSBleGVjRmlsZVN5bmMoKVxuLy8gd2hpY2ggaW52b2tlcyB0aGUgYmluYXJ5IGRpcmVjdGx5IFx1MjAxNCB0aGVzZSB0aHJlZSBtdXN0IGRvIHRoZSBzYW1lLlxuLy9cbi8vIFN0YXRpYy1hbmFseXNpcyB0ZXN0cyBmYWlsIGJlZm9yZSB0aGUgZml4IChzb3VyY2Ugc3RpbGwgaGFzIGV4ZWNTeW5jIGNhbGxzKVxuLy8gYW5kIHBhc3MgYWZ0ZXIgKHJlcGxhY2VkIHdpdGggZXhlY0ZpbGVTeW5jKS4gSW50ZWdyYXRpb24gdGVzdHMgdmVyaWZ5IHRoZVxuLy8gZmFsbGJhY2sgZnVuY3Rpb25zIGJlaGF2ZSBjb3JyZWN0bHkgb24gYWxsIHBsYXRmb3Jtcy5cblxuaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QsIGJlZm9yZUVhY2gsIGFmdGVyRWFjaCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgY2htb2RTeW5jLCBleGlzdHNTeW5jLCBta2R0ZW1wU3luYywgd3JpdGVGaWxlU3luYywgcmVhZEZpbGVTeW5jLCBybVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgZGVsaW1pdGVyLCBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGV4ZWNGaWxlU3luYyB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7XG4gIGFzc2VydFdvcmt0cmVlTWF0ZXJpYWxpemVkLFxuICBuYXRpdmVCcmFuY2hEZWxldGUsXG4gIG5hdGl2ZUNvbW1pdCxcbiAgbmF0aXZlR2V0Q3VycmVudEJyYW5jaCxcbiAgbmF0aXZlSXNSZXBvLFxuICBuYXRpdmVSZXNldEhhcmQsXG4gIG5hdGl2ZVdvcmt0cmVlQWRkLFxufSBmcm9tIFwiLi4vbmF0aXZlLWdpdC1icmlkZ2UuanNcIjtcbmltcG9ydCB7IEdJVF9OT19QUk9NUFRfRU5WIH0gZnJvbSBcIi4uL2dpdC1jb25zdGFudHMuanNcIjtcblxuLy8gTm90ZTogcHJpb3Igc3RhdGljLWFuYWx5c2lzIHRlc3RzIHRoYXQgc2Nhbm5lZCBuYXRpdmUtZ2l0LWJyaWRnZS50cyBmb3Jcbi8vIHRoZSByYXcgc2hlbGwtc3Bhd24gcGF0dGVybiB3ZXJlIHJlbW92ZWQgdW5kZXIgIzQ4MjcgXHUyMDE0IHRoZSBpbnRlZ3JhdGlvblxuLy8gdGVzdHMgYmVsb3cgYWxyZWFkeSBleGVyY2lzZSB0aGUgZmFsbGJhY2sgcGF0aCBlbmQtdG8tZW5kIHdpdGggdGhlIG5hdGl2ZVxuLy8gbW9kdWxlIGRpc2FibGVkIChHU0RfRU5BQkxFX05BVElWRV9HU0RfR0lUIHVuc2V0KS4gQW55IGNtZC5leGUgUEFUSFxuLy8gcmVncmVzc2lvbiBvbiBXaW5kb3dzIHN1cmZhY2VzIHRocm91Z2ggYSByZWFsIGZhbGxiYWNrIGZhaWx1cmUsIG5vdCBhXG4vLyBncmVwIG1pc3MgaW4gc291cmNlIHRleHQuXG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBJbnRlZ3JhdGlvbiB0ZXN0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbi8vIFZlcmlmeSBjb3JyZWN0IHJ1bnRpbWUgYmVoYXZpb3VyIHRocm91Z2ggdGhlIGZhbGxiYWNrIHBhdGggKG5hdGl2ZSBtb2R1bGVcbi8vIGlzIGRpc2FibGVkIGJ5IGRlZmF1bHQgaW4gdGVzdHMgXHUyMDE0IEdTRF9FTkFCTEVfTkFUSVZFX0dTRF9HSVQgaXMgbm90IHNldCkuXG5cbmZ1bmN0aW9uIGdpdChhcmdzOiBzdHJpbmdbXSwgY3dkOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIGFyZ3MsIHsgY3dkLCBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0sIGVuY29kaW5nOiBcInV0Zi04XCIgfSkudHJpbSgpO1xufVxuXG5kZXNjcmliZShcIm5hdGl2ZS1naXQtYnJpZGdlICM0MTgwOiBmYWxsYmFjayBydW50aW1lIGJlaGF2aW91clwiLCAoKSA9PiB7XG4gIGxldCByZXBvOiBzdHJpbmc7XG5cbiAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgcmVwbyA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwibmdiNDE4MC1cIikpO1xuICAgIGdpdChbXCJpbml0XCJdLCByZXBvKTtcbiAgICBnaXQoW1wiY29uZmlnXCIsIFwidXNlci5lbWFpbFwiLCBcInRlc3RAdGVzdC5jb21cIl0sIHJlcG8pO1xuICAgIGdpdChbXCJjb25maWdcIiwgXCJ1c2VyLm5hbWVcIiwgXCJUZXN0XCJdLCByZXBvKTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocmVwbywgXCJmaWxlLnR4dFwiKSwgXCJpbml0aWFsXFxuXCIpO1xuICAgIGdpdChbXCJhZGRcIiwgXCIuXCJdLCByZXBvKTtcbiAgICBnaXQoW1wiY29tbWl0XCIsIFwiLW1cIiwgXCJpbml0XCJdLCByZXBvKTtcbiAgfSk7XG5cbiAgYWZ0ZXJFYWNoKCgpID0+IHtcbiAgICBybVN5bmMocmVwbywgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcblxuICB0ZXN0KFwibmF0aXZlSXNSZXBvIHJldHVybnMgdHJ1ZSBmb3IgYSB2YWxpZCBnaXQgcmVwb3NpdG9yeVwiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKG5hdGl2ZUlzUmVwbyhyZXBvKSwgdHJ1ZSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJuYXRpdmVJc1JlcG8gcmV0dXJucyBmYWxzZSBmb3IgYSBwbGFpbiBkaXJlY3RvcnlcIiwgKHQpID0+IHtcbiAgICBjb25zdCBkaXIgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcIm5nYjQxODAtbm90cmVwby1cIikpO1xuICAgIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcbiAgICBhc3NlcnQuZXF1YWwobmF0aXZlSXNSZXBvKGRpciksIGZhbHNlKTtcbiAgfSk7XG5cbiAgdGVzdChcIm5hdGl2ZUNvbW1pdCBjb21taXRzIHN0YWdlZCBjaGFuZ2VzIGFuZCByZXR1cm5zIG5vbi1udWxsIG91dHB1dFwiLCAoKSA9PiB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHJlcG8sIFwiZmlsZS50eHRcIiksIFwibW9kaWZpZWRcXG5cIik7XG4gICAgZ2l0KFtcImFkZFwiLCBcIi5cIl0sIHJlcG8pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gbmF0aXZlQ29tbWl0KHJlcG8sIFwidGVzdDogcmVncmVzc2lvbiBjb21taXQgIzQxODBcIik7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdCAhPT0gbnVsbCwgXCJzaG91bGQgcmV0dXJuIG91dHB1dCBzdHJpbmcgZm9yIGEgc3VjY2Vzc2Z1bCBjb21taXRcIik7XG5cbiAgICBjb25zdCBzdWJqZWN0ID0gZ2l0KFtcImxvZ1wiLCBcIi0xXCIsIFwiLS1mb3JtYXQ9JXNcIl0sIHJlcG8pO1xuICAgIGFzc2VydC5lcXVhbChzdWJqZWN0LCBcInRlc3Q6IHJlZ3Jlc3Npb24gY29tbWl0ICM0MTgwXCIpO1xuICB9KTtcblxuICB0ZXN0KFwibmF0aXZlQ29tbWl0IHJldHJpZXMgb25jZSBhZnRlciB0cmFuc2llbnQgRU5PQlVGUyBmcm9tIGdpdFwiLCAodCkgPT4ge1xuICAgIGNvbnN0IGJpbiA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwibmdiLWVub2J1ZnMtYmluLVwiKSk7XG4gICAgdC5hZnRlcigoKSA9PiBybVN5bmMoYmluLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuXG4gICAgY29uc3QgcmVhbEdpdCA9IGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCItLWV4ZWMtcGF0aFwiXSwgeyBlbmNvZGluZzogXCJ1dGYtOFwiIH0pLnRyaW0oKTtcbiAgICBjb25zdCBhdHRlbXB0cyA9IGpvaW4oYmluLCBcImF0dGVtcHRzLnR4dFwiKTtcbiAgICBjb25zdCBmYWtlR2l0ID0gam9pbihiaW4sIFwiZmFrZS1naXQuY2pzXCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoZmFrZUdpdCwgYFxuY29uc3QgeyBhcHBlbmRGaWxlU3luYywgcmVhZEZpbGVTeW5jIH0gPSByZXF1aXJlKFwibm9kZTpmc1wiKTtcbmNvbnN0IHsgc3Bhd25TeW5jIH0gPSByZXF1aXJlKFwibm9kZTpjaGlsZF9wcm9jZXNzXCIpO1xuY29uc3QgYXR0ZW1wdHMgPSAke0pTT04uc3RyaW5naWZ5KGF0dGVtcHRzKX07XG5jb25zdCByZWFsR2l0ID0gJHtKU09OLnN0cmluZ2lmeShqb2luKHJlYWxHaXQsIHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIiA/IFwiZ2l0LmV4ZVwiIDogXCJnaXRcIikpfTtcbmFwcGVuZEZpbGVTeW5jKGF0dGVtcHRzLCBcIjFcIik7XG5pZiAocHJvY2Vzcy5hcmd2WzJdID09PSBcImNvbW1pdFwiICYmIHJlYWRGaWxlU3luYyhhdHRlbXB0cywgXCJ1dGYtOFwiKS5sZW5ndGggPT09IDEpIHtcbiAgY29uc29sZS5lcnJvcihcInNwYXduU3luYyBnaXQgRU5PQlVGU1wiKTtcbiAgcHJvY2Vzcy5leGl0KDEpO1xufVxuY29uc3QgcmVzdWx0ID0gc3Bhd25TeW5jKHJlYWxHaXQsIHByb2Nlc3MuYXJndi5zbGljZSgyKSwgeyBzdGRpbzogXCJpbmhlcml0XCIgfSk7XG5wcm9jZXNzLmV4aXQocmVzdWx0LnN0YXR1cyA/PyAxKTtcbmAsIFwidXRmLThcIik7XG5cbiAgICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiKSB7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4oYmluLCBcImdpdC5jbWRcIiksIGBAZWNobyBvZmZcXHJcXG5ub2RlIFwiJHtmYWtlR2l0fVwiICUqXFxyXFxuYCwgXCJ1dGYtOFwiKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3Qgc2hpbSA9IGpvaW4oYmluLCBcImdpdFwiKTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoc2hpbSwgYCMhL2Jpbi9zaFxcbmV4ZWMgbm9kZSBcIiR7ZmFrZUdpdH1cIiBcIiRAXCJcXG5gLCBcInV0Zi04XCIpO1xuICAgICAgY2htb2RTeW5jKHNoaW0sIDBvNzU1KTtcbiAgICB9XG5cbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocmVwbywgXCJmaWxlLnR4dFwiKSwgXCJyZXRyeSBjb21taXRcXG5cIik7XG4gICAgZ2l0KFtcImFkZFwiLCBcIi5cIl0sIHJlcG8pO1xuXG4gICAgY29uc3Qgb3JpZ2luYWxQYXRoID0gcHJvY2Vzcy5lbnYuUEFUSCA/PyBcIlwiO1xuICAgIGNvbnN0IGdpdEVudiA9IEdJVF9OT19QUk9NUFRfRU5WIGFzIE5vZGVKUy5Qcm9jZXNzRW52O1xuICAgIGNvbnN0IG9yaWdpbmFsR2l0RW52UGF0aCA9IGdpdEVudi5QQVRIO1xuICAgIHRyeSB7XG4gICAgICBwcm9jZXNzLmVudi5QQVRIID0gYCR7YmlufSR7ZGVsaW1pdGVyfSR7b3JpZ2luYWxQYXRofWA7XG4gICAgICBnaXRFbnYuUEFUSCA9IHByb2Nlc3MuZW52LlBBVEg7XG4gICAgICBjb25zdCByZXN1bHQgPSBuYXRpdmVDb21taXQocmVwbywgXCJ0ZXN0OiByZXRyeSBFTk9CVUZTIGNvbW1pdFwiKTtcbiAgICAgIGFzc2VydC5vayhyZXN1bHQgIT09IG51bGwsIFwiY29tbWl0IHNob3VsZCBzdWNjZWVkIGFmdGVyIHJldHJ5XCIpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBwcm9jZXNzLmVudi5QQVRIID0gb3JpZ2luYWxQYXRoO1xuICAgICAgZ2l0RW52LlBBVEggPSBvcmlnaW5hbEdpdEVudlBhdGg7XG4gICAgfVxuXG4gICAgYXNzZXJ0LmVxdWFsKHJlYWRGaWxlU3luYyhhdHRlbXB0cywgXCJ1dGYtOFwiKS5sZW5ndGgsIDIpO1xuICAgIGFzc2VydC5lcXVhbChnaXQoW1wibG9nXCIsIFwiLTFcIiwgXCItLWZvcm1hdD0lc1wiXSwgcmVwbyksIFwidGVzdDogcmV0cnkgRU5PQlVGUyBjb21taXRcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJuYXRpdmVDb21taXQgcnVucyBjb21taXQgaG9va3NcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGhvb2tQYXRoID0gam9pbihyZXBvLCBcIi5naXRcIiwgXCJob29rc1wiLCBcImNvbW1pdC1tc2dcIik7XG4gICAgY29uc3QgbWFya2VyID0gam9pbihyZXBvLCBcImhvb2stcmFuLnR4dFwiKTtcbiAgICB3cml0ZUZpbGVTeW5jKGhvb2tQYXRoLCBgIyEvYmluL3NoXFxucHJpbnRmIHJhbiA+IFwiJHttYXJrZXJ9XCJcXG5gLCBcInV0Zi04XCIpO1xuICAgIGNobW9kU3luYyhob29rUGF0aCwgMG83NTUpO1xuXG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHJlcG8sIFwiZmlsZS50eHRcIiksIFwiaG9va2VkXFxuXCIpO1xuICAgIGdpdChbXCJhZGRcIiwgXCIuXCJdLCByZXBvKTtcbiAgICBuYXRpdmVDb21taXQocmVwbywgXCJ0ZXN0OiBob29rIGV4ZWN1dGlvblwiKTtcblxuICAgIGFzc2VydC5lcXVhbChyZWFkRmlsZVN5bmMobWFya2VyLCBcInV0Zi04XCIpLCBcInJhblwiKTtcbiAgfSk7XG5cbiAgdGVzdChcIm5hdGl2ZUNvbW1pdCByZXR1cm5zIG51bGwgd2hlbiBub3RoaW5nIGlzIHN0YWdlZFwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gbmF0aXZlQ29tbWl0KHJlcG8sIFwidGVzdDogbm90aGluZyBzdGFnZWRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgbnVsbCk7XG4gIH0pO1xuXG4gIHRlc3QoXCJuYXRpdmVDb21taXQgcmVzcGVjdHMgdGhlIGFsbG93RW1wdHkgb3B0aW9uXCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBuYXRpdmVDb21taXQocmVwbywgXCJ0ZXN0OiBlbXB0eSBjb21taXQgIzQxODBcIiwgeyBhbGxvd0VtcHR5OiB0cnVlIH0pO1xuICAgIGFzc2VydC5vayhyZXN1bHQgIT09IG51bGwsIFwiYWxsb3ctZW1wdHkgY29tbWl0IHNob3VsZCByZXR1cm4gb3V0cHV0XCIpO1xuXG4gICAgY29uc3Qgc3ViamVjdCA9IGdpdChbXCJsb2dcIiwgXCItMVwiLCBcIi0tZm9ybWF0PSVzXCJdLCByZXBvKTtcbiAgICBhc3NlcnQuZXF1YWwoc3ViamVjdCwgXCJ0ZXN0OiBlbXB0eSBjb21taXQgIzQxODBcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJuYXRpdmVSZXNldEhhcmQgZGlzY2FyZHMgdW5zdGFnZWQgd29ya2luZyB0cmVlIGNoYW5nZXNcIiwgKCkgPT4ge1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihyZXBvLCBcImZpbGUudHh0XCIpLCBcImRpcnR5IGNvbnRlbnRcXG5cIik7XG5cbiAgICBjb25zdCBzdGF0dXNCZWZvcmUgPSBnaXQoW1wic3RhdHVzXCIsIFwiLS1zaG9ydFwiXSwgcmVwbyk7XG4gICAgYXNzZXJ0Lm9rKHN0YXR1c0JlZm9yZS5sZW5ndGggPiAwLCBcInJlcG8gc2hvdWxkIGJlIGRpcnR5IGJlZm9yZSByZXNldFwiKTtcblxuICAgIG5hdGl2ZVJlc2V0SGFyZChyZXBvKTtcblxuICAgIGNvbnN0IGNvbnRlbnQgPSByZWFkRmlsZVN5bmMoam9pbihyZXBvLCBcImZpbGUudHh0XCIpLCBcInV0Zi04XCIpO1xuICAgIGFzc2VydC5lcXVhbChjb250ZW50LCBcImluaXRpYWxcXG5cIiwgXCJmaWxlIHNob3VsZCBiZSByZXN0b3JlZCB0byBIRUFEIGNvbnRlbnQgYWZ0ZXIgaGFyZCByZXNldFwiKTtcbiAgfSk7XG5cbiAgdGVzdChcIm5hdGl2ZUJyYW5jaERlbGV0ZSB0aHJvd3Mgd2hlbiBnaXQgY2Fubm90IGRlbGV0ZSB0aGUgYnJhbmNoXCIsICgpID0+IHtcbiAgICBhc3NlcnQudGhyb3dzKFxuICAgICAgKCkgPT4gbmF0aXZlQnJhbmNoRGVsZXRlKHJlcG8sIFwiZG9lcy1ub3QtZXhpc3RcIiksXG4gICAgICAvZ2l0IGJyYW5jaCAtRCBkb2VzLW5vdC1leGlzdCBmYWlsZWRbXFxzXFxTXSpkb2VzLW5vdC1leGlzdC8sXG4gICAgKTtcbiAgfSk7XG5cbiAgdGVzdChcIm5hdGl2ZUdldEN1cnJlbnRCcmFuY2ggcHJlc2VydmVzIGdpdCBzdGRlcnIgaW4gZmFsbGJhY2sgZXJyb3JzXCIsICh0KSA9PiB7XG4gICAgY29uc3QgZGlyID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJuZ2Itc3RkZXJyLW5vdHJlcG8tXCIpKTtcbiAgICB0LmFmdGVyKCgpID0+IHJtU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG5cbiAgICBhc3NlcnQudGhyb3dzKFxuICAgICAgKCkgPT4gbmF0aXZlR2V0Q3VycmVudEJyYW5jaChkaXIpLFxuICAgICAgL2dpdCBicmFuY2ggLS1zaG93LWN1cnJlbnQgZmFpbGVkW1xcc1xcU10qKG5vdCBhIGdpdCByZXBvc2l0b3J5fG5vdCBhIGdpdCByZXBvfGZhdGFsOikvLFxuICAgICk7XG4gIH0pO1xuXG4gIHRlc3QoXCJhc3NlcnRXb3JrdHJlZU1hdGVyaWFsaXplZCByZWplY3RzIGRpcmVjdG9yaWVzIHdpdGhvdXQgYSAuZ2l0IGZpbGVcIiwgKHQpID0+IHtcbiAgICBjb25zdCBkaXIgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcIm5nYi13b3JrdHJlZS1taXNzaW5nLWdpdC1cIikpO1xuICAgIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcblxuICAgIGFzc2VydC50aHJvd3MoXG4gICAgICAoKSA9PiBhc3NlcnRXb3JrdHJlZU1hdGVyaWFsaXplZChkaXIpLFxuICAgICAgL21pc3NpbmcgXFwuZ2l0IGZpbGUvLFxuICAgICk7XG4gIH0pO1xuXG4gIHRlc3QoXCJuYXRpdmVXb3JrdHJlZUFkZCBtYXRlcmlhbGl6ZXMgYSB2YWxpZCAuZ2l0IG1hcmtlclwiLCAodCkgPT4ge1xuICAgIGNvbnN0IHd0UGF0aCA9IGpvaW4ocmVwbywgXCIuZ3NkXCIsIFwid29ya3RyZWVzXCIsIFwiTTAwMVwiKTtcbiAgICB0LmFmdGVyKCgpID0+IHtcbiAgICAgIHRyeSB7IGdpdChbXCJ3b3JrdHJlZVwiLCBcInJlbW92ZVwiLCBcIi0tZm9yY2VcIiwgd3RQYXRoXSwgcmVwbyk7IH0gY2F0Y2ggeyAvKiBub29wICovIH1cbiAgICB9KTtcblxuICAgIG5hdGl2ZVdvcmt0cmVlQWRkKHJlcG8sIHd0UGF0aCwgXCJtaWxlc3RvbmUvTTAwMVwiLCB0cnVlLCBcIkhFQURcIik7XG5cbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICBleGlzdHNTeW5jKGpvaW4od3RQYXRoLCBcIi5naXRcIikpLFxuICAgICAgdHJ1ZSxcbiAgICAgIFwiY3JlYXRlZCB3b3JrdHJlZSBtdXN0IGhhdmUgdGhlIC5naXQgZmlsZSByZXF1aXJlZCBieSBsYXRlciBoZWFsdGggY2hlY2tzXCIsXG4gICAgKTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQVlBLFNBQVMsVUFBVSxNQUFNLFlBQVksaUJBQWlCO0FBQ3RELE9BQU8sWUFBWTtBQUNuQixTQUFTLFdBQVcsWUFBWSxhQUFhLGVBQWUsY0FBYyxjQUFjO0FBQ3hGLFNBQVMsV0FBVyxZQUFZO0FBQ2hDLFNBQVMsY0FBYztBQUN2QixTQUFTLG9CQUFvQjtBQUM3QjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1AsU0FBUyx5QkFBeUI7QUFhbEMsU0FBUyxJQUFJLE1BQWdCLEtBQXFCO0FBQ2hELFNBQU8sYUFBYSxPQUFPLE1BQU0sRUFBRSxLQUFLLE9BQU8sQ0FBQyxVQUFVLFFBQVEsTUFBTSxHQUFHLFVBQVUsUUFBUSxDQUFDLEVBQUUsS0FBSztBQUN2RztBQUVBLFNBQVMsdURBQXVELE1BQU07QUFDcEUsTUFBSTtBQUVKLGFBQVcsTUFBTTtBQUNmLFdBQU8sWUFBWSxLQUFLLE9BQU8sR0FBRyxVQUFVLENBQUM7QUFDN0MsUUFBSSxDQUFDLE1BQU0sR0FBRyxJQUFJO0FBQ2xCLFFBQUksQ0FBQyxVQUFVLGNBQWMsZUFBZSxHQUFHLElBQUk7QUFDbkQsUUFBSSxDQUFDLFVBQVUsYUFBYSxNQUFNLEdBQUcsSUFBSTtBQUN6QyxrQkFBYyxLQUFLLE1BQU0sVUFBVSxHQUFHLFdBQVc7QUFDakQsUUFBSSxDQUFDLE9BQU8sR0FBRyxHQUFHLElBQUk7QUFDdEIsUUFBSSxDQUFDLFVBQVUsTUFBTSxNQUFNLEdBQUcsSUFBSTtBQUFBLEVBQ3BDLENBQUM7QUFFRCxZQUFVLE1BQU07QUFDZCxXQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUMvQyxDQUFDO0FBRUQsT0FBSyx3REFBd0QsTUFBTTtBQUNqRSxXQUFPLE1BQU0sYUFBYSxJQUFJLEdBQUcsSUFBSTtBQUFBLEVBQ3ZDLENBQUM7QUFFRCxPQUFLLG9EQUFvRCxDQUFDLE1BQU07QUFDOUQsVUFBTSxNQUFNLFlBQVksS0FBSyxPQUFPLEdBQUcsa0JBQWtCLENBQUM7QUFDMUQsTUFBRSxNQUFNLE1BQU0sT0FBTyxLQUFLLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDLENBQUM7QUFDM0QsV0FBTyxNQUFNLGFBQWEsR0FBRyxHQUFHLEtBQUs7QUFBQSxFQUN2QyxDQUFDO0FBRUQsT0FBSyxtRUFBbUUsTUFBTTtBQUM1RSxrQkFBYyxLQUFLLE1BQU0sVUFBVSxHQUFHLFlBQVk7QUFDbEQsUUFBSSxDQUFDLE9BQU8sR0FBRyxHQUFHLElBQUk7QUFFdEIsVUFBTSxTQUFTLGFBQWEsTUFBTSwrQkFBK0I7QUFDakUsV0FBTyxHQUFHLFdBQVcsTUFBTSxxREFBcUQ7QUFFaEYsVUFBTSxVQUFVLElBQUksQ0FBQyxPQUFPLE1BQU0sYUFBYSxHQUFHLElBQUk7QUFDdEQsV0FBTyxNQUFNLFNBQVMsK0JBQStCO0FBQUEsRUFDdkQsQ0FBQztBQUVELE9BQUssOERBQThELENBQUMsTUFBTTtBQUN4RSxVQUFNLE1BQU0sWUFBWSxLQUFLLE9BQU8sR0FBRyxrQkFBa0IsQ0FBQztBQUMxRCxNQUFFLE1BQU0sTUFBTSxPQUFPLEtBQUssRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUMsQ0FBQztBQUUzRCxVQUFNLFVBQVUsYUFBYSxPQUFPLENBQUMsYUFBYSxHQUFHLEVBQUUsVUFBVSxRQUFRLENBQUMsRUFBRSxLQUFLO0FBQ2pGLFVBQU0sV0FBVyxLQUFLLEtBQUssY0FBYztBQUN6QyxVQUFNLFVBQVUsS0FBSyxLQUFLLGNBQWM7QUFDeEMsa0JBQWMsU0FBUztBQUFBO0FBQUE7QUFBQSxtQkFHUixLQUFLLFVBQVUsUUFBUSxDQUFDO0FBQUEsa0JBQ3pCLEtBQUssVUFBVSxLQUFLLFNBQVMsUUFBUSxhQUFhLFVBQVUsWUFBWSxLQUFLLENBQUMsQ0FBQztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsR0FROUYsT0FBTztBQUVOLFFBQUksUUFBUSxhQUFhLFNBQVM7QUFDaEMsb0JBQWMsS0FBSyxLQUFLLFNBQVMsR0FBRztBQUFBLFFBQXNCLE9BQU87QUFBQSxHQUFZLE9BQU87QUFBQSxJQUN0RixPQUFPO0FBQ0wsWUFBTSxPQUFPLEtBQUssS0FBSyxLQUFLO0FBQzVCLG9CQUFjLE1BQU07QUFBQSxhQUF5QixPQUFPO0FBQUEsR0FBWSxPQUFPO0FBQ3ZFLGdCQUFVLE1BQU0sR0FBSztBQUFBLElBQ3ZCO0FBRUEsa0JBQWMsS0FBSyxNQUFNLFVBQVUsR0FBRyxnQkFBZ0I7QUFDdEQsUUFBSSxDQUFDLE9BQU8sR0FBRyxHQUFHLElBQUk7QUFFdEIsVUFBTSxlQUFlLFFBQVEsSUFBSSxRQUFRO0FBQ3pDLFVBQU0sU0FBUztBQUNmLFVBQU0scUJBQXFCLE9BQU87QUFDbEMsUUFBSTtBQUNGLGNBQVEsSUFBSSxPQUFPLEdBQUcsR0FBRyxHQUFHLFNBQVMsR0FBRyxZQUFZO0FBQ3BELGFBQU8sT0FBTyxRQUFRLElBQUk7QUFDMUIsWUFBTSxTQUFTLGFBQWEsTUFBTSw0QkFBNEI7QUFDOUQsYUFBTyxHQUFHLFdBQVcsTUFBTSxtQ0FBbUM7QUFBQSxJQUNoRSxVQUFFO0FBQ0EsY0FBUSxJQUFJLE9BQU87QUFDbkIsYUFBTyxPQUFPO0FBQUEsSUFDaEI7QUFFQSxXQUFPLE1BQU0sYUFBYSxVQUFVLE9BQU8sRUFBRSxRQUFRLENBQUM7QUFDdEQsV0FBTyxNQUFNLElBQUksQ0FBQyxPQUFPLE1BQU0sYUFBYSxHQUFHLElBQUksR0FBRyw0QkFBNEI7QUFBQSxFQUNwRixDQUFDO0FBRUQsT0FBSyxrQ0FBa0MsTUFBTTtBQUMzQyxVQUFNLFdBQVcsS0FBSyxNQUFNLFFBQVEsU0FBUyxZQUFZO0FBQ3pELFVBQU0sU0FBUyxLQUFLLE1BQU0sY0FBYztBQUN4QyxrQkFBYyxVQUFVO0FBQUEsZ0JBQTRCLE1BQU07QUFBQSxHQUFPLE9BQU87QUFDeEUsY0FBVSxVQUFVLEdBQUs7QUFFekIsa0JBQWMsS0FBSyxNQUFNLFVBQVUsR0FBRyxVQUFVO0FBQ2hELFFBQUksQ0FBQyxPQUFPLEdBQUcsR0FBRyxJQUFJO0FBQ3RCLGlCQUFhLE1BQU0sc0JBQXNCO0FBRXpDLFdBQU8sTUFBTSxhQUFhLFFBQVEsT0FBTyxHQUFHLEtBQUs7QUFBQSxFQUNuRCxDQUFDO0FBRUQsT0FBSyxvREFBb0QsTUFBTTtBQUM3RCxVQUFNLFNBQVMsYUFBYSxNQUFNLHNCQUFzQjtBQUN4RCxXQUFPLE1BQU0sUUFBUSxJQUFJO0FBQUEsRUFDM0IsQ0FBQztBQUVELE9BQUssK0NBQStDLE1BQU07QUFDeEQsVUFBTSxTQUFTLGFBQWEsTUFBTSw0QkFBNEIsRUFBRSxZQUFZLEtBQUssQ0FBQztBQUNsRixXQUFPLEdBQUcsV0FBVyxNQUFNLHlDQUF5QztBQUVwRSxVQUFNLFVBQVUsSUFBSSxDQUFDLE9BQU8sTUFBTSxhQUFhLEdBQUcsSUFBSTtBQUN0RCxXQUFPLE1BQU0sU0FBUywwQkFBMEI7QUFBQSxFQUNsRCxDQUFDO0FBRUQsT0FBSywwREFBMEQsTUFBTTtBQUNuRSxrQkFBYyxLQUFLLE1BQU0sVUFBVSxHQUFHLGlCQUFpQjtBQUV2RCxVQUFNLGVBQWUsSUFBSSxDQUFDLFVBQVUsU0FBUyxHQUFHLElBQUk7QUFDcEQsV0FBTyxHQUFHLGFBQWEsU0FBUyxHQUFHLG1DQUFtQztBQUV0RSxvQkFBZ0IsSUFBSTtBQUVwQixVQUFNLFVBQVUsYUFBYSxLQUFLLE1BQU0sVUFBVSxHQUFHLE9BQU87QUFDNUQsV0FBTyxNQUFNLFNBQVMsYUFBYSwwREFBMEQ7QUFBQSxFQUMvRixDQUFDO0FBRUQsT0FBSywrREFBK0QsTUFBTTtBQUN4RSxXQUFPO0FBQUEsTUFDTCxNQUFNLG1CQUFtQixNQUFNLGdCQUFnQjtBQUFBLE1BQy9DO0FBQUEsSUFDRjtBQUFBLEVBQ0YsQ0FBQztBQUVELE9BQUssa0VBQWtFLENBQUMsTUFBTTtBQUM1RSxVQUFNLE1BQU0sWUFBWSxLQUFLLE9BQU8sR0FBRyxxQkFBcUIsQ0FBQztBQUM3RCxNQUFFLE1BQU0sTUFBTSxPQUFPLEtBQUssRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUMsQ0FBQztBQUUzRCxXQUFPO0FBQUEsTUFDTCxNQUFNLHVCQUF1QixHQUFHO0FBQUEsTUFDaEM7QUFBQSxJQUNGO0FBQUEsRUFDRixDQUFDO0FBRUQsT0FBSyxzRUFBc0UsQ0FBQyxNQUFNO0FBQ2hGLFVBQU0sTUFBTSxZQUFZLEtBQUssT0FBTyxHQUFHLDJCQUEyQixDQUFDO0FBQ25FLE1BQUUsTUFBTSxNQUFNLE9BQU8sS0FBSyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQyxDQUFDO0FBRTNELFdBQU87QUFBQSxNQUNMLE1BQU0sMkJBQTJCLEdBQUc7QUFBQSxNQUNwQztBQUFBLElBQ0Y7QUFBQSxFQUNGLENBQUM7QUFFRCxPQUFLLHNEQUFzRCxDQUFDLE1BQU07QUFDaEUsVUFBTSxTQUFTLEtBQUssTUFBTSxRQUFRLGFBQWEsTUFBTTtBQUNyRCxNQUFFLE1BQU0sTUFBTTtBQUNaLFVBQUk7QUFBRSxZQUFJLENBQUMsWUFBWSxVQUFVLFdBQVcsTUFBTSxHQUFHLElBQUk7QUFBQSxNQUFHLFFBQVE7QUFBQSxNQUFhO0FBQUEsSUFDbkYsQ0FBQztBQUVELHNCQUFrQixNQUFNLFFBQVEsa0JBQWtCLE1BQU0sTUFBTTtBQUU5RCxXQUFPO0FBQUEsTUFDTCxXQUFXLEtBQUssUUFBUSxNQUFNLENBQUM7QUFBQSxNQUMvQjtBQUFBLE1BQ0E7QUFBQSxJQUNGO0FBQUEsRUFDRixDQUFDO0FBQ0gsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
