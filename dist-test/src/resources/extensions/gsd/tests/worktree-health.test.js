import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { getWorktreeHealth, formatWorktreeStatusLine } from "../worktree-health.js";
import { listWorktrees } from "../worktree-manager.js";
import { describe } from "node:test";
import assert from "node:assert/strict";
function run(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}
function createBaseRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wt-health-test-")));
  run("git init", dir);
  run("git config user.email test@test.com", dir);
  run("git config user.name Test", dir);
  writeFileSync(join(dir, "README.md"), "# test\n");
  run("git add .", dir);
  run("git commit -m init", dir);
  run("git branch -M main", dir);
  return dir;
}
describe("worktree-health", async () => {
  if (process.platform === "win32") {
    console.log("(all worktree-health tests skipped on Windows)");
    return;
  }
  const cleanups = [];
  try {
    console.log("\n=== worktree health: merged worktree ===");
    {
      const dir = createBaseRepo();
      cleanups.push(dir);
      mkdirSync(join(dir, ".gsd", "worktrees"), { recursive: true });
      run("git worktree add -b worktree/done-feature .gsd/worktrees/done-feature", dir);
      const wtPath = join(dir, ".gsd", "worktrees", "done-feature");
      writeFileSync(join(wtPath, "done.txt"), "done\n");
      run("git add -A", wtPath);
      run('git -c user.email=test@test.com -c user.name=Test commit -m "done"', wtPath);
      run("git merge worktree/done-feature --no-edit", dir);
      const worktrees = listWorktrees(dir);
      const wt = worktrees.find((w) => w.name === "done-feature");
      assert.ok(!!wt, "worktree found");
      const health = getWorktreeHealth(dir, wt);
      assert.ok(health.mergedIntoMain, "branch detected as merged");
      assert.ok(!health.dirty, "not dirty");
      assert.ok(health.safeToRemove, "safe to remove");
      const line = formatWorktreeStatusLine(health);
      assert.ok(line.includes("merged"), "status line mentions merged");
      assert.ok(line.includes("safe to remove"), "status line mentions safe to remove");
    }
    console.log("\n=== worktree health: dirty unmerged worktree ===");
    {
      const dir = createBaseRepo();
      cleanups.push(dir);
      mkdirSync(join(dir, ".gsd", "worktrees"), { recursive: true });
      run("git worktree add -b worktree/dirty-wip .gsd/worktrees/dirty-wip", dir);
      const wtPath = join(dir, ".gsd", "worktrees", "dirty-wip");
      writeFileSync(join(wtPath, "committed.txt"), "committed\n");
      run("git add -A", wtPath);
      run('git -c user.email=test@test.com -c user.name=Test commit -m "diverge"', wtPath);
      writeFileSync(join(wtPath, "uncommitted.txt"), "wip\n");
      const worktrees = listWorktrees(dir);
      const wt = worktrees.find((w) => w.name === "dirty-wip");
      assert.ok(!!wt, "worktree found");
      const health = getWorktreeHealth(dir, wt);
      assert.ok(!health.mergedIntoMain, "not merged");
      assert.ok(health.dirty, "dirty detected");
      assert.ok(health.dirtyFileCount > 0, "dirty file count > 0");
      assert.ok(!health.safeToRemove, "not safe to remove");
    }
    console.log("\n=== worktree health: unpushed commits ===");
    {
      const dir = createBaseRepo();
      cleanups.push(dir);
      mkdirSync(join(dir, ".gsd", "worktrees"), { recursive: true });
      run("git worktree add -b worktree/unpushed .gsd/worktrees/unpushed", dir);
      const wtPath = join(dir, ".gsd", "worktrees", "unpushed");
      writeFileSync(join(wtPath, "feature.txt"), "feature\n");
      run("git add -A", wtPath);
      run('git -c user.email=test@test.com -c user.name=Test commit -m "feature"', wtPath);
      const worktrees = listWorktrees(dir);
      const wt = worktrees.find((w) => w.name === "unpushed");
      assert.ok(!!wt, "worktree found");
      const health = getWorktreeHealth(dir, wt);
      assert.ok(!health.mergedIntoMain, "not merged");
      assert.ok(health.unpushedCommits > 0, "unpushed commits detected");
      assert.ok(!health.safeToRemove, "not safe to remove");
    }
    console.log("\n=== worktree health: stale detection ===");
    {
      const dir = createBaseRepo();
      cleanups.push(dir);
      mkdirSync(join(dir, ".gsd", "worktrees"), { recursive: true });
      run("git worktree add -b worktree/stale-test .gsd/worktrees/stale-test", dir);
      const wtPath = join(dir, ".gsd", "worktrees", "stale-test");
      writeFileSync(join(wtPath, "stale.txt"), "stale\n");
      run("git add -A", wtPath);
      run('git -c user.email=test@test.com -c user.name=Test commit -m "stale work"', wtPath);
      const worktrees = listWorktrees(dir);
      const wt = worktrees.find((w) => w.name === "stale-test");
      assert.ok(!!wt, "worktree found");
      const health = getWorktreeHealth(dir, wt, 0);
      assert.ok(health.stale, "stale with 0-day threshold");
      assert.ok(health.lastCommitAgeDays >= 0, "last commit age is non-negative");
      const healthNotStale = getWorktreeHealth(dir, wt, 9999);
      assert.ok(!healthNotStale.stale, "not stale with high threshold");
    }
    console.log("\n=== worktree health: format clean active worktree ===");
    {
      const dir = createBaseRepo();
      cleanups.push(dir);
      mkdirSync(join(dir, ".gsd", "worktrees"), { recursive: true });
      run("git worktree add -b worktree/clean-active .gsd/worktrees/clean-active", dir);
      const wtPath = join(dir, ".gsd", "worktrees", "clean-active");
      writeFileSync(join(wtPath, "active.txt"), "active\n");
      run("git add -A", wtPath);
      run('git -c user.email=test@test.com -c user.name=Test commit -m "active work"', wtPath);
      const worktrees = listWorktrees(dir);
      const wt = worktrees.find((w) => w.name === "clean-active");
      assert.ok(!!wt, "worktree found");
      const health = getWorktreeHealth(dir, wt, 9999);
      const line = formatWorktreeStatusLine(health);
      assert.ok(line.includes("last commit"), "shows last commit age for active worktree");
    }
  } finally {
    for (const dir of cleanups) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
      }
    }
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy93b3JrdHJlZS1oZWFsdGgudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiB3b3JrdHJlZS1oZWFsdGgudGVzdC50cyBcdTIwMTQgVW5pdCB0ZXN0cyBmb3Igd29ya3RyZWUgaGVhbHRoIHN0YXR1cyBjb21wdXRhdGlvbi5cbiAqXG4gKiBDcmVhdGVzIHJlYWwgdGVtcCBnaXQgcmVwb3Mgd2l0aCBHU0Qgd29ya3RyZWVzIGluIHZhcmlvdXMgc3RhdGVzIGFuZCB2ZXJpZmllc1xuICogdGhhdCBnZXRXb3JrdHJlZUhlYWx0aCBhbmQgZm9ybWF0V29ya3RyZWVTdGF0dXNMaW5lIHJldHVybiBjb3JyZWN0IHJlc3VsdHMuXG4gKi9cblxuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgd3JpdGVGaWxlU3luYywgcm1TeW5jLCBleGlzdHNTeW5jLCByZWFscGF0aFN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBleGVjU3luYyB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcblxuaW1wb3J0IHsgZ2V0V29ya3RyZWVIZWFsdGgsIGZvcm1hdFdvcmt0cmVlU3RhdHVzTGluZSB9IGZyb20gXCIuLi93b3JrdHJlZS1oZWFsdGgudHNcIjtcbmltcG9ydCB7IGxpc3RXb3JrdHJlZXMgfSBmcm9tIFwiLi4vd29ya3RyZWUtbWFuYWdlci50c1wiO1xuaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QgfSBmcm9tICdub2RlOnRlc3QnO1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnO1xuXG5cbmZ1bmN0aW9uIHJ1bihjbWQ6IHN0cmluZywgY3dkOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gZXhlY1N5bmMoY21kLCB7IGN3ZCwgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdLCBlbmNvZGluZzogXCJ1dGYtOFwiIH0pLnRyaW0oKTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlQmFzZVJlcG8oKTogc3RyaW5nIHtcbiAgY29uc3QgZGlyID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwid3QtaGVhbHRoLXRlc3QtXCIpKSk7XG4gIHJ1bihcImdpdCBpbml0XCIsIGRpcik7XG4gIHJ1bihcImdpdCBjb25maWcgdXNlci5lbWFpbCB0ZXN0QHRlc3QuY29tXCIsIGRpcik7XG4gIHJ1bihcImdpdCBjb25maWcgdXNlci5uYW1lIFRlc3RcIiwgZGlyKTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJSRUFETUUubWRcIiksIFwiIyB0ZXN0XFxuXCIpO1xuICBydW4oXCJnaXQgYWRkIC5cIiwgZGlyKTtcbiAgcnVuKFwiZ2l0IGNvbW1pdCAtbSBpbml0XCIsIGRpcik7XG4gIHJ1bihcImdpdCBicmFuY2ggLU0gbWFpblwiLCBkaXIpO1xuICByZXR1cm4gZGlyO1xufVxuXG5kZXNjcmliZSgnd29ya3RyZWUtaGVhbHRoJywgYXN5bmMgKCkgPT4ge1xuICAvLyBTa2lwIGFsbCB0ZXN0cyBvbiBXaW5kb3dzIFx1MjAxNCBnaXQgd29ya3RyZWUgcGF0aCByZXNvbHV0aW9uIGlzc3Vlc1xuICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiKSB7XG4gICAgY29uc29sZS5sb2coXCIoYWxsIHdvcmt0cmVlLWhlYWx0aCB0ZXN0cyBza2lwcGVkIG9uIFdpbmRvd3MpXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IGNsZWFudXBzOiBzdHJpbmdbXSA9IFtdO1xuXG4gIHRyeSB7XG4gICAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRlc3Q6IG1lcmdlZCB3b3JrdHJlZSBpcyBkZXRlY3RlZCBhcyBtZXJnZWQgKyBzYWZlIHRvIHJlbW92ZSBcdTI1MDBcdTI1MDBcbiAgICBjb25zb2xlLmxvZyhcIlxcbj09PSB3b3JrdHJlZSBoZWFsdGg6IG1lcmdlZCB3b3JrdHJlZSA9PT1cIik7XG4gICAge1xuICAgICAgY29uc3QgZGlyID0gY3JlYXRlQmFzZVJlcG8oKTtcbiAgICAgIGNsZWFudXBzLnB1c2goZGlyKTtcblxuICAgICAgbWtkaXJTeW5jKGpvaW4oZGlyLCBcIi5nc2RcIiwgXCJ3b3JrdHJlZXNcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgcnVuKFwiZ2l0IHdvcmt0cmVlIGFkZCAtYiB3b3JrdHJlZS9kb25lLWZlYXR1cmUgLmdzZC93b3JrdHJlZXMvZG9uZS1mZWF0dXJlXCIsIGRpcik7XG4gICAgICBjb25zdCB3dFBhdGggPSBqb2luKGRpciwgXCIuZ3NkXCIsIFwid29ya3RyZWVzXCIsIFwiZG9uZS1mZWF0dXJlXCIpO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHd0UGF0aCwgXCJkb25lLnR4dFwiKSwgXCJkb25lXFxuXCIpO1xuICAgICAgcnVuKFwiZ2l0IGFkZCAtQVwiLCB3dFBhdGgpO1xuICAgICAgcnVuKFwiZ2l0IC1jIHVzZXIuZW1haWw9dGVzdEB0ZXN0LmNvbSAtYyB1c2VyLm5hbWU9VGVzdCBjb21taXQgLW0gXFxcImRvbmVcXFwiXCIsIHd0UGF0aCk7XG4gICAgICBydW4oXCJnaXQgbWVyZ2Ugd29ya3RyZWUvZG9uZS1mZWF0dXJlIC0tbm8tZWRpdFwiLCBkaXIpO1xuXG4gICAgICBjb25zdCB3b3JrdHJlZXMgPSBsaXN0V29ya3RyZWVzKGRpcik7XG4gICAgICBjb25zdCB3dCA9IHdvcmt0cmVlcy5maW5kKHcgPT4gdy5uYW1lID09PSBcImRvbmUtZmVhdHVyZVwiKTtcbiAgICAgIGFzc2VydC5vayghIXd0LCBcIndvcmt0cmVlIGZvdW5kXCIpO1xuXG4gICAgICBjb25zdCBoZWFsdGggPSBnZXRXb3JrdHJlZUhlYWx0aChkaXIsIHd0ISk7XG4gICAgICBhc3NlcnQub2soaGVhbHRoLm1lcmdlZEludG9NYWluLCBcImJyYW5jaCBkZXRlY3RlZCBhcyBtZXJnZWRcIik7XG4gICAgICBhc3NlcnQub2soIWhlYWx0aC5kaXJ0eSwgXCJub3QgZGlydHlcIik7XG4gICAgICBhc3NlcnQub2soaGVhbHRoLnNhZmVUb1JlbW92ZSwgXCJzYWZlIHRvIHJlbW92ZVwiKTtcblxuICAgICAgY29uc3QgbGluZSA9IGZvcm1hdFdvcmt0cmVlU3RhdHVzTGluZShoZWFsdGgpO1xuICAgICAgYXNzZXJ0Lm9rKGxpbmUuaW5jbHVkZXMoXCJtZXJnZWRcIiksIFwic3RhdHVzIGxpbmUgbWVudGlvbnMgbWVyZ2VkXCIpO1xuICAgICAgYXNzZXJ0Lm9rKGxpbmUuaW5jbHVkZXMoXCJzYWZlIHRvIHJlbW92ZVwiKSwgXCJzdGF0dXMgbGluZSBtZW50aW9ucyBzYWZlIHRvIHJlbW92ZVwiKTtcbiAgICB9XG5cbiAgICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdDogdW5tZXJnZWQgd29ya3RyZWUgd2l0aCBkaXJ0eSBmaWxlcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICBjb25zb2xlLmxvZyhcIlxcbj09PSB3b3JrdHJlZSBoZWFsdGg6IGRpcnR5IHVubWVyZ2VkIHdvcmt0cmVlID09PVwiKTtcbiAgICB7XG4gICAgICBjb25zdCBkaXIgPSBjcmVhdGVCYXNlUmVwbygpO1xuICAgICAgY2xlYW51cHMucHVzaChkaXIpO1xuXG4gICAgICBta2RpclN5bmMoam9pbihkaXIsIFwiLmdzZFwiLCBcIndvcmt0cmVlc1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICBydW4oXCJnaXQgd29ya3RyZWUgYWRkIC1iIHdvcmt0cmVlL2RpcnR5LXdpcCAuZ3NkL3dvcmt0cmVlcy9kaXJ0eS13aXBcIiwgZGlyKTtcbiAgICAgIGNvbnN0IHd0UGF0aCA9IGpvaW4oZGlyLCBcIi5nc2RcIiwgXCJ3b3JrdHJlZXNcIiwgXCJkaXJ0eS13aXBcIik7XG4gICAgICAvLyBNYWtlIGEgY29tbWl0IHNvIHRoZSBicmFuY2ggZGl2ZXJnZXMgZnJvbSBtYWluLCB0aGVuIGxlYXZlIGRpcnR5IHN0YXRlXG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4od3RQYXRoLCBcImNvbW1pdHRlZC50eHRcIiksIFwiY29tbWl0dGVkXFxuXCIpO1xuICAgICAgcnVuKFwiZ2l0IGFkZCAtQVwiLCB3dFBhdGgpO1xuICAgICAgcnVuKFwiZ2l0IC1jIHVzZXIuZW1haWw9dGVzdEB0ZXN0LmNvbSAtYyB1c2VyLm5hbWU9VGVzdCBjb21taXQgLW0gXFxcImRpdmVyZ2VcXFwiXCIsIHd0UGF0aCk7XG4gICAgICAvLyBOb3cgbGVhdmUgYW4gdW5jb21taXR0ZWQgZmlsZVxuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHd0UGF0aCwgXCJ1bmNvbW1pdHRlZC50eHRcIiksIFwid2lwXFxuXCIpO1xuXG4gICAgICBjb25zdCB3b3JrdHJlZXMgPSBsaXN0V29ya3RyZWVzKGRpcik7XG4gICAgICBjb25zdCB3dCA9IHdvcmt0cmVlcy5maW5kKHcgPT4gdy5uYW1lID09PSBcImRpcnR5LXdpcFwiKTtcbiAgICAgIGFzc2VydC5vayghIXd0LCBcIndvcmt0cmVlIGZvdW5kXCIpO1xuXG4gICAgICBjb25zdCBoZWFsdGggPSBnZXRXb3JrdHJlZUhlYWx0aChkaXIsIHd0ISk7XG4gICAgICBhc3NlcnQub2soIWhlYWx0aC5tZXJnZWRJbnRvTWFpbiwgXCJub3QgbWVyZ2VkXCIpO1xuICAgICAgYXNzZXJ0Lm9rKGhlYWx0aC5kaXJ0eSwgXCJkaXJ0eSBkZXRlY3RlZFwiKTtcbiAgICAgIGFzc2VydC5vayhoZWFsdGguZGlydHlGaWxlQ291bnQgPiAwLCBcImRpcnR5IGZpbGUgY291bnQgPiAwXCIpO1xuICAgICAgYXNzZXJ0Lm9rKCFoZWFsdGguc2FmZVRvUmVtb3ZlLCBcIm5vdCBzYWZlIHRvIHJlbW92ZVwiKTtcbiAgICB9XG5cbiAgICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdDogdW5tZXJnZWQgd29ya3RyZWUgd2l0aCB1bnB1c2hlZCBjb21taXRzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgIGNvbnNvbGUubG9nKFwiXFxuPT09IHdvcmt0cmVlIGhlYWx0aDogdW5wdXNoZWQgY29tbWl0cyA9PT1cIik7XG4gICAge1xuICAgICAgY29uc3QgZGlyID0gY3JlYXRlQmFzZVJlcG8oKTtcbiAgICAgIGNsZWFudXBzLnB1c2goZGlyKTtcblxuICAgICAgbWtkaXJTeW5jKGpvaW4oZGlyLCBcIi5nc2RcIiwgXCJ3b3JrdHJlZXNcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgcnVuKFwiZ2l0IHdvcmt0cmVlIGFkZCAtYiB3b3JrdHJlZS91bnB1c2hlZCAuZ3NkL3dvcmt0cmVlcy91bnB1c2hlZFwiLCBkaXIpO1xuICAgICAgY29uc3Qgd3RQYXRoID0gam9pbihkaXIsIFwiLmdzZFwiLCBcIndvcmt0cmVlc1wiLCBcInVucHVzaGVkXCIpO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHd0UGF0aCwgXCJmZWF0dXJlLnR4dFwiKSwgXCJmZWF0dXJlXFxuXCIpO1xuICAgICAgcnVuKFwiZ2l0IGFkZCAtQVwiLCB3dFBhdGgpO1xuICAgICAgcnVuKFwiZ2l0IC1jIHVzZXIuZW1haWw9dGVzdEB0ZXN0LmNvbSAtYyB1c2VyLm5hbWU9VGVzdCBjb21taXQgLW0gXFxcImZlYXR1cmVcXFwiXCIsIHd0UGF0aCk7XG5cbiAgICAgIGNvbnN0IHdvcmt0cmVlcyA9IGxpc3RXb3JrdHJlZXMoZGlyKTtcbiAgICAgIGNvbnN0IHd0ID0gd29ya3RyZWVzLmZpbmQodyA9PiB3Lm5hbWUgPT09IFwidW5wdXNoZWRcIik7XG4gICAgICBhc3NlcnQub2soISF3dCwgXCJ3b3JrdHJlZSBmb3VuZFwiKTtcblxuICAgICAgY29uc3QgaGVhbHRoID0gZ2V0V29ya3RyZWVIZWFsdGgoZGlyLCB3dCEpO1xuICAgICAgYXNzZXJ0Lm9rKCFoZWFsdGgubWVyZ2VkSW50b01haW4sIFwibm90IG1lcmdlZFwiKTtcbiAgICAgIGFzc2VydC5vayhoZWFsdGgudW5wdXNoZWRDb21taXRzID4gMCwgXCJ1bnB1c2hlZCBjb21taXRzIGRldGVjdGVkXCIpO1xuICAgICAgYXNzZXJ0Lm9rKCFoZWFsdGguc2FmZVRvUmVtb3ZlLCBcIm5vdCBzYWZlIHRvIHJlbW92ZVwiKTtcbiAgICB9XG5cbiAgICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdDogc3RhbGUgZGV0ZWN0aW9uIHdpdGggc2hvcnQgdGhyZXNob2xkIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgIGNvbnNvbGUubG9nKFwiXFxuPT09IHdvcmt0cmVlIGhlYWx0aDogc3RhbGUgZGV0ZWN0aW9uID09PVwiKTtcbiAgICB7XG4gICAgICBjb25zdCBkaXIgPSBjcmVhdGVCYXNlUmVwbygpO1xuICAgICAgY2xlYW51cHMucHVzaChkaXIpO1xuXG4gICAgICBta2RpclN5bmMoam9pbihkaXIsIFwiLmdzZFwiLCBcIndvcmt0cmVlc1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICBydW4oXCJnaXQgd29ya3RyZWUgYWRkIC1iIHdvcmt0cmVlL3N0YWxlLXRlc3QgLmdzZC93b3JrdHJlZXMvc3RhbGUtdGVzdFwiLCBkaXIpO1xuICAgICAgLy8gRGl2ZXJnZSBmcm9tIG1haW4gc28gdGhlIGJyYW5jaCBpcyBub3QgXCJtZXJnZWRcIlxuICAgICAgY29uc3Qgd3RQYXRoID0gam9pbihkaXIsIFwiLmdzZFwiLCBcIndvcmt0cmVlc1wiLCBcInN0YWxlLXRlc3RcIik7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4od3RQYXRoLCBcInN0YWxlLnR4dFwiKSwgXCJzdGFsZVxcblwiKTtcbiAgICAgIHJ1bihcImdpdCBhZGQgLUFcIiwgd3RQYXRoKTtcbiAgICAgIHJ1bihcImdpdCAtYyB1c2VyLmVtYWlsPXRlc3RAdGVzdC5jb20gLWMgdXNlci5uYW1lPVRlc3QgY29tbWl0IC1tIFxcXCJzdGFsZSB3b3JrXFxcIlwiLCB3dFBhdGgpO1xuXG4gICAgICBjb25zdCB3b3JrdHJlZXMgPSBsaXN0V29ya3RyZWVzKGRpcik7XG4gICAgICBjb25zdCB3dCA9IHdvcmt0cmVlcy5maW5kKHcgPT4gdy5uYW1lID09PSBcInN0YWxlLXRlc3RcIik7XG4gICAgICBhc3NlcnQub2soISF3dCwgXCJ3b3JrdHJlZSBmb3VuZFwiKTtcblxuICAgICAgLy8gV2l0aCBzdGFsZURheXM9MCwgYW55IHdvcmt0cmVlIHNob3VsZCBiZSBzdGFsZSAoY29tbWl0IHdhcyBqdXN0IG5vdywgYnV0IHRocmVzaG9sZCBpcyAwKVxuICAgICAgLy8gQWN0dWFsbHksIGEganVzdC1jcmVhdGVkIHdvcmt0cmVlIGhhcyBsYXN0Q29tbWl0QWdlRGF5cyB+MCB3aGljaCBpcyA+PSAwXG4gICAgICBjb25zdCBoZWFsdGggPSBnZXRXb3JrdHJlZUhlYWx0aChkaXIsIHd0ISwgMCk7XG4gICAgICBhc3NlcnQub2soaGVhbHRoLnN0YWxlLCBcInN0YWxlIHdpdGggMC1kYXkgdGhyZXNob2xkXCIpO1xuICAgICAgYXNzZXJ0Lm9rKGhlYWx0aC5sYXN0Q29tbWl0QWdlRGF5cyA+PSAwLCBcImxhc3QgY29tbWl0IGFnZSBpcyBub24tbmVnYXRpdmVcIik7XG5cbiAgICAgIC8vIFdpdGggc3RhbGVEYXlzPTk5OTksIHNob3VsZCBOT1QgYmUgc3RhbGVcbiAgICAgIGNvbnN0IGhlYWx0aE5vdFN0YWxlID0gZ2V0V29ya3RyZWVIZWFsdGgoZGlyLCB3dCEsIDk5OTkpO1xuICAgICAgYXNzZXJ0Lm9rKCFoZWFsdGhOb3RTdGFsZS5zdGFsZSwgXCJub3Qgc3RhbGUgd2l0aCBoaWdoIHRocmVzaG9sZFwiKTtcbiAgICB9XG5cbiAgICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdDogZm9ybWF0V29ya3RyZWVTdGF0dXNMaW5lIGZvciBjbGVhbiBhY3RpdmUgd29ya3RyZWUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgY29uc29sZS5sb2coXCJcXG49PT0gd29ya3RyZWUgaGVhbHRoOiBmb3JtYXQgY2xlYW4gYWN0aXZlIHdvcmt0cmVlID09PVwiKTtcbiAgICB7XG4gICAgICBjb25zdCBkaXIgPSBjcmVhdGVCYXNlUmVwbygpO1xuICAgICAgY2xlYW51cHMucHVzaChkaXIpO1xuXG4gICAgICBta2RpclN5bmMoam9pbihkaXIsIFwiLmdzZFwiLCBcIndvcmt0cmVlc1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICBydW4oXCJnaXQgd29ya3RyZWUgYWRkIC1iIHdvcmt0cmVlL2NsZWFuLWFjdGl2ZSAuZ3NkL3dvcmt0cmVlcy9jbGVhbi1hY3RpdmVcIiwgZGlyKTtcbiAgICAgIC8vIERpdmVyZ2UgZnJvbSBtYWluIHNvIGl0J3Mgbm90IFwibWVyZ2VkXCJcbiAgICAgIGNvbnN0IHd0UGF0aCA9IGpvaW4oZGlyLCBcIi5nc2RcIiwgXCJ3b3JrdHJlZXNcIiwgXCJjbGVhbi1hY3RpdmVcIik7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4od3RQYXRoLCBcImFjdGl2ZS50eHRcIiksIFwiYWN0aXZlXFxuXCIpO1xuICAgICAgcnVuKFwiZ2l0IGFkZCAtQVwiLCB3dFBhdGgpO1xuICAgICAgcnVuKFwiZ2l0IC1jIHVzZXIuZW1haWw9dGVzdEB0ZXN0LmNvbSAtYyB1c2VyLm5hbWU9VGVzdCBjb21taXQgLW0gXFxcImFjdGl2ZSB3b3JrXFxcIlwiLCB3dFBhdGgpO1xuXG4gICAgICBjb25zdCB3b3JrdHJlZXMgPSBsaXN0V29ya3RyZWVzKGRpcik7XG4gICAgICBjb25zdCB3dCA9IHdvcmt0cmVlcy5maW5kKHcgPT4gdy5uYW1lID09PSBcImNsZWFuLWFjdGl2ZVwiKTtcbiAgICAgIGFzc2VydC5vayghIXd0LCBcIndvcmt0cmVlIGZvdW5kXCIpO1xuXG4gICAgICBjb25zdCBoZWFsdGggPSBnZXRXb3JrdHJlZUhlYWx0aChkaXIsIHd0ISwgOTk5OSk7IC8vIGhpZ2ggdGhyZXNob2xkIHNvIG5vdCBzdGFsZVxuICAgICAgY29uc3QgbGluZSA9IGZvcm1hdFdvcmt0cmVlU3RhdHVzTGluZShoZWFsdGgpO1xuICAgICAgLy8gU2hvdWxkIHNob3cgbGFzdCBjb21taXQgYWdlIHNpbmNlIGl0J3Mgbm90IG1lcmdlZCBhbmQgbm90IHN0YWxlXG4gICAgICBhc3NlcnQub2sobGluZS5pbmNsdWRlcyhcImxhc3QgY29tbWl0XCIpLCBcInNob3dzIGxhc3QgY29tbWl0IGFnZSBmb3IgYWN0aXZlIHdvcmt0cmVlXCIpO1xuICAgIH1cblxuICB9IGZpbmFsbHkge1xuICAgIGZvciAoY29uc3QgZGlyIG9mIGNsZWFudXBzKSB7XG4gICAgICB0cnkgeyBybVN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0gY2F0Y2ggeyAvKiBpZ25vcmUgKi8gfVxuICAgIH1cbiAgfVxufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFPQSxTQUFTLGFBQWEsV0FBVyxlQUFlLFFBQW9CLG9CQUFvQjtBQUN4RixTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsZ0JBQWdCO0FBRXpCLFNBQVMsbUJBQW1CLGdDQUFnQztBQUM1RCxTQUFTLHFCQUFxQjtBQUM5QixTQUFTLGdCQUFzQjtBQUMvQixPQUFPLFlBQVk7QUFHbkIsU0FBUyxJQUFJLEtBQWEsS0FBcUI7QUFDN0MsU0FBTyxTQUFTLEtBQUssRUFBRSxLQUFLLE9BQU8sQ0FBQyxVQUFVLFFBQVEsTUFBTSxHQUFHLFVBQVUsUUFB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
