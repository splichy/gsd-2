import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  lstatSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { createAutoWorktree, mergeMilestoneToMain } from "../auto-worktree.js";
import { _resetServiceCache } from "../worktree.js";
import { _clearGsdRootCache } from "../paths.js";
let originalHome;
let fakeHome;
const testCwd = process.cwd();
test.before(() => {
  originalHome = process.env.HOME;
  fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "gsd-fake-home-")));
  process.env.HOME = fakeHome;
  _clearGsdRootCache();
  _resetServiceCache();
});
test.after(() => {
  process.env.HOME = originalHome;
  _clearGsdRootCache();
  _resetServiceCache();
  rmSync(fakeHome, { recursive: true, force: true });
});
function cleanupTempPaths(...paths) {
  try {
    process.chdir(testCwd);
  } catch {
  }
  for (const p of paths) {
    rmSync(p, { recursive: true, force: true });
  }
}
function run(cmd, cwd) {
  return execSync(cmd, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8"
  }).trim();
}
function createTempRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wt-ctx-stash-test-")));
  run("git init", dir);
  run("git config user.email test@test.com", dir);
  run("git config user.name Test", dir);
  writeFileSync(join(dir, "README.md"), "# test\n");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  writeFileSync(join(dir, ".gsd", "STATE.md"), "version: 1\n");
  run("git add -f .gsd/STATE.md", dir);
  run("git add .", dir);
  run("git commit -m init", dir);
  run("git branch -M main", dir);
  return dir;
}
function createTempRepoWithSymlinkedGsd() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "wt-symlink-stash-test-")));
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "wt-symlink-state-")));
  run("git init", repo);
  run("git config user.email test@test.com", repo);
  run("git config user.name Test", repo);
  writeFileSync(join(repo, "README.md"), "# test\n");
  symlinkSync(stateDir, join(repo, ".gsd"));
  run("git add README.md", repo);
  run("git commit -m init", repo);
  run("git branch -M main", repo);
  return { repo, stateDir };
}
function makeRoadmap(milestoneId, title, slices) {
  const sliceLines = slices.map((s) => `- [x] **${s.id}: ${s.title}**`).join("\n");
  return `# ${milestoneId}: ${title}

## Slices
${sliceLines}
`;
}
test("#2505: git stash --include-untracked sweeps queued CONTEXT files (demonstrates the bug)", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wt-stash-bug-demo-")));
  try {
    run("git init", dir);
    run("git config user.email test@test.com", dir);
    run("git config user.name Test", dir);
    writeFileSync(join(dir, "README.md"), "# test\n");
    mkdirSync(join(dir, ".gsd"), { recursive: true });
    writeFileSync(join(dir, ".gsd", "STATE.md"), "version: 1\n");
    run("git add -f .gsd/STATE.md", dir);
    run("git add .", dir);
    run("git commit -m init", dir);
    const m013Dir = join(dir, ".gsd", "milestones", "M013");
    mkdirSync(m013Dir, { recursive: true });
    writeFileSync(
      join(m013Dir, "M013-CONTEXT.md"),
      "# M013: Login Page Redesign\n"
    );
    writeFileSync(join(dir, "README.md"), "# test\n\nDirty.\n");
    const status = run("git status --porcelain", dir);
    assert.ok(status.includes("?? .gsd/milestones/"), "precondition: M013 dir is untracked");
    run('git stash push --include-untracked -m "test stash"', dir);
    assert.ok(
      !existsSync(join(m013Dir, "M013-CONTEXT.md")),
      "BUG CONFIRMED: --include-untracked swept CONTEXT file into stash"
    );
    run("git stash pop", dir);
    mkdirSync(m013Dir, { recursive: true });
    writeFileSync(
      join(m013Dir, "M013-CONTEXT.md"),
      "# M013: Login Page Redesign\n"
    );
    writeFileSync(join(dir, "README.md"), "# test\n\nDirty again.\n");
    run('git stash push -m "test stash no untracked"', dir);
    assert.ok(
      existsSync(join(m013Dir, "M013-CONTEXT.md")),
      "FIX CONFIRMED: without --include-untracked, CONTEXT file stays on disk"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("#2505: mergeMilestoneToMain preserves queued CONTEXT files (not swept into stash)", () => {
  const repo = createTempRepo();
  try {
    const wtPath = createAutoWorktree(repo, "M015");
    const normalizedPath = wtPath.replaceAll("\\", "/");
    const worktreeName = normalizedPath.split("/").pop() || "M015";
    const sliceBranch = `slice/${worktreeName}/S01`;
    run(`git checkout -b "${sliceBranch}"`, wtPath);
    writeFileSync(join(wtPath, "app.ts"), "export const app = true;\n");
    run("git add .", wtPath);
    run('git commit -m "add app feature"', wtPath);
    run("git checkout milestone/M015", wtPath);
    run(`git merge --no-ff "${sliceBranch}" -m "merge S01"`, wtPath);
    const m013Dir = join(repo, ".gsd", "milestones", "M013");
    const m014Dir = join(repo, ".gsd", "milestones", "M014");
    mkdirSync(m013Dir, { recursive: true });
    mkdirSync(m014Dir, { recursive: true });
    writeFileSync(
      join(m013Dir, "M013-CONTEXT.md"),
      "# M013: Login Page Redesign\n\nQueued milestone context.\n"
    );
    writeFileSync(
      join(m014Dir, "M014-CONTEXT.md"),
      "# M014: Dashboard Redesign\n\nQueued milestone context.\n"
    );
    writeFileSync(join(repo, "README.md"), "# test\n\nDirty change.\n");
    const statusBefore = run("git status --porcelain", repo);
    assert.ok(
      statusBefore.includes("?? .gsd/milestones/"),
      "M013 directory is untracked before merge (precondition)"
    );
    const roadmap = makeRoadmap("M015", "App Feature", [
      { id: "S01", title: "Feature" }
    ]);
    const result = mergeMilestoneToMain(repo, "M015", roadmap);
    assert.ok(
      result.commitMessage.includes("GSD-Milestone: M015"),
      "merge should succeed"
    );
    assert.ok(
      existsSync(join(m013Dir, "M013-CONTEXT.md")),
      "M013-CONTEXT.md must survive the merge (not swept into stash)"
    );
    assert.ok(
      existsSync(join(m014Dir, "M014-CONTEXT.md")),
      "M014-CONTEXT.md must survive the merge (not swept into stash)"
    );
    assert.ok(
      readFileSync(join(m013Dir, "M013-CONTEXT.md"), "utf-8").includes("Login Page Redesign"),
      "M013 context content preserved"
    );
    assert.ok(
      readFileSync(join(m014Dir, "M014-CONTEXT.md"), "utf-8").includes("Dashboard Redesign"),
      "M014 context content preserved"
    );
    assert.ok(existsSync(join(repo, "app.ts")), "milestone code merged to main");
    let stashList;
    try {
      stashList = run("git stash list", repo);
    } catch {
      stashList = "";
    }
    if (stashList) {
      try {
        const stashDiff = run("git diff stash@{0}^3 --name-only 2>/dev/null || true", repo);
        assert.ok(
          !stashDiff.includes("M013-CONTEXT"),
          "stash must not contain queued milestone M013 files"
        );
        assert.ok(
          !stashDiff.includes("M014-CONTEXT"),
          "stash must not contain queued milestone M014 files"
        );
      } catch {
      }
    }
  } finally {
    cleanupTempPaths(repo);
  }
});
test("#2505: pre-merge stash handles symlinked .gsd without traversing it", () => {
  const { repo, stateDir } = createTempRepoWithSymlinkedGsd();
  try {
    const wtPath = createAutoWorktree(repo, "M016");
    const normalizedPath = wtPath.replaceAll("\\", "/");
    const worktreeName = normalizedPath.split("/").pop() || "M016";
    const sliceBranch = `slice/${worktreeName}/S01`;
    run(`git checkout -b "${sliceBranch}"`, wtPath);
    writeFileSync(join(wtPath, "app.ts"), "export const app = true;\n");
    run("git add app.ts", wtPath);
    run('git commit -m "add app feature"', wtPath);
    run("git checkout milestone/M016", wtPath);
    run(`git merge --no-ff "${sliceBranch}" -m "merge S01"`, wtPath);
    const queuedDir = join(stateDir, "milestones", "M017");
    mkdirSync(queuedDir, { recursive: true });
    writeFileSync(join(queuedDir, "M017-CONTEXT.md"), "# M017: Queued\n");
    writeFileSync(join(repo, "README.md"), "# test\n\nDirty change.\n");
    writeFileSync(join(repo, "local-note.txt"), "local scratch\n");
    const result = mergeMilestoneToMain(repo, "M016", makeRoadmap("M016", "App Feature", [
      { id: "S01", title: "Feature" }
    ]));
    assert.ok(result.commitMessage.includes("GSD-Milestone: M016"), "merge should succeed");
    assert.ok(existsSync(join(repo, "app.ts")), "milestone code merged to main");
    assert.equal(lstatSync(join(repo, ".gsd")).isSymbolicLink(), true, ".gsd symlink remains in place");
    assert.ok(existsSync(join(queuedDir, "M017-CONTEXT.md")), "queued context remains in external state");
    assert.equal(readFileSync(join(repo, "README.md"), "utf-8").replace(/\r\n/g, "\n"), "# test\n\nDirty change.\n");
    assert.equal(readFileSync(join(repo, "local-note.txt"), "utf-8"), "local scratch\n");
  } finally {
    cleanupTempPaths(repo, stateDir);
  }
});
test("#2505: back-to-back merges preserve queued CONTEXT files", () => {
  const repo = createTempRepo();
  try {
    const wt1 = createAutoWorktree(repo, "M015");
    const wt1Name = wt1.replaceAll("\\", "/").split("/").pop() || "M015";
    const slice1 = `slice/${wt1Name}/S01`;
    run(`git checkout -b "${slice1}"`, wt1);
    writeFileSync(join(wt1, "feature1.ts"), "export const f1 = true;\n");
    run("git add .", wt1);
    run('git commit -m "feature 1"', wt1);
    run("git checkout milestone/M015", wt1);
    run(`git merge --no-ff "${slice1}" -m "merge S01"`, wt1);
    const m013Dir = join(repo, ".gsd", "milestones", "M013");
    mkdirSync(m013Dir, { recursive: true });
    writeFileSync(
      join(m013Dir, "M013-CONTEXT.md"),
      "# M013: Login Page Redesign\n\nQueued milestone context.\n"
    );
    writeFileSync(join(repo, "README.md"), "# test\n\nDirty for M015.\n");
    mergeMilestoneToMain(repo, "M015", makeRoadmap("M015", "Feature 1", [
      { id: "S01", title: "Feature 1" }
    ]));
    assert.ok(
      existsSync(join(m013Dir, "M013-CONTEXT.md")),
      "M013-CONTEXT.md survives first merge"
    );
    const wt2 = createAutoWorktree(repo, "M016");
    const wt2Name = wt2.replaceAll("\\", "/").split("/").pop() || "M016";
    const slice2 = `slice/${wt2Name}/S01`;
    run(`git checkout -b "${slice2}"`, wt2);
    writeFileSync(join(wt2, "feature2.ts"), "export const f2 = true;\n");
    run("git add .", wt2);
    run('git commit -m "feature 2"', wt2);
    run("git checkout milestone/M016", wt2);
    run(`git merge --no-ff "${slice2}" -m "merge S01"`, wt2);
    writeFileSync(join(repo, "README.md"), "# test\n\nDirty for M016.\n");
    mergeMilestoneToMain(repo, "M016", makeRoadmap("M016", "Feature 2", [
      { id: "S01", title: "Feature 2" }
    ]));
    assert.ok(
      existsSync(join(m013Dir, "M013-CONTEXT.md")),
      "M013-CONTEXT.md must survive two consecutive milestone merges"
    );
    assert.ok(
      readFileSync(join(m013Dir, "M013-CONTEXT.md"), "utf-8").includes("Login Page Redesign"),
      "M013 context content preserved after back-to-back merges"
    );
  } finally {
    cleanupTempPaths(repo);
  }
});
test("#4573: gitignored .gsd symlink does not break pre-merge stash", () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "wt-4573-ignored-symlink-")));
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "wt-4573-state-")));
  try {
    run("git init", repo);
    run("git config user.email test@test.com", repo);
    run("git config user.name Test", repo);
    writeFileSync(join(repo, "README.md"), "# test\n");
    writeFileSync(join(repo, ".gitignore"), ".gsd\n.gsd-id\n");
    symlinkSync(stateDir, join(repo, ".gsd"));
    run("git add README.md .gitignore", repo);
    run("git commit -m init", repo);
    run("git branch -M main", repo);
    const wtPath = createAutoWorktree(repo, "M001");
    const worktreeName = wtPath.replaceAll("\\", "/").split("/").pop() || "M001";
    const sliceBranch = `slice/${worktreeName}/S01`;
    run(`git checkout -b "${sliceBranch}"`, wtPath);
    writeFileSync(join(wtPath, "app.ts"), "export const app = true;\n");
    run("git add app.ts", wtPath);
    run('git commit -m "add feature"', wtPath);
    run("git checkout milestone/M001", wtPath);
    run(`git merge --no-ff "${sliceBranch}" -m "merge S01"`, wtPath);
    writeFileSync(join(repo, "README.md"), "# test\n\nDirty.\n");
    const result = mergeMilestoneToMain(
      repo,
      "M001",
      makeRoadmap("M001", "Feature", [{ id: "S01", title: "Feature" }])
    );
    assert.ok(
      result.commitMessage.includes("GSD-Milestone: M001"),
      "merge must succeed despite gitignored .gsd symlink"
    );
    assert.ok(existsSync(join(repo, "app.ts")), "milestone code merged to main");
    assert.equal(
      lstatSync(join(repo, ".gsd")).isSymbolicLink(),
      true,
      ".gsd symlink remains in place"
    );
  } finally {
    cleanupTempPaths(repo, stateDir);
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9zdGFzaC1xdWV1ZWQtY29udGV4dC1maWxlcy50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIHN0YXNoLXF1ZXVlZC1jb250ZXh0LWZpbGVzLnRlc3QudHMgXHUyMDE0IFJlZ3Jlc3Npb24gdGVzdCBmb3IgIzI1MDUuXG4gKlxuICogV2hlbiBtZXJnZU1pbGVzdG9uZVRvTWFpbiBydW5zIGBnaXQgc3Rhc2ggcHVzaCAtLWluY2x1ZGUtdW50cmFja2VkYCxcbiAqIHVudHJhY2tlZCBgLmdzZC9taWxlc3RvbmVzL008cXVldWVkPi9gIGRpcmVjdG9yaWVzIGNyZWF0ZWQgYnkgYC9nc2QgcXVldWVgXG4gKiBhcmUgc3dlcHQgaW50byB0aGUgc3Rhc2guIElmIHN0YXNoIHBvcCBmYWlscyAoY29uZmxpY3Qgb24gdHJhY2tlZCBmaWxlcyksXG4gKiB0aGUgcXVldWVkIG1pbGVzdG9uZSBDT05URVhUIGZpbGVzIGFyZSBwZXJtYW5lbnRseSBsb3N0LlxuICpcbiAqIFRoZSBmaXg6IGRyb3AgYC0taW5jbHVkZS11bnRyYWNrZWRgIGZyb20gdGhlIHN0YXNoIHB1c2gsIHNpbmNlIHRoZSBzdGFzaFxuICogb25seSBuZWVkcyB0byBoYW5kbGUgdHJhY2tlZCBkaXJ0eSBmaWxlcy4gVW50cmFja2VkIGAuZ3NkL2AgZmlsZXMgYXJlXG4gKiBhbHJlYWR5IGhhbmRsZWQgc2VwYXJhdGVseSBieSBjbGVhclByb2plY3RSb290U3RhdGVGaWxlcy5cbiAqL1xuXG5pbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7XG4gIG1rZHRlbXBTeW5jLFxuICBta2RpclN5bmMsXG4gIHdyaXRlRmlsZVN5bmMsXG4gIHJtU3luYyxcbiAgZXhpc3RzU3luYyxcbiAgcmVhZEZpbGVTeW5jLFxuICByZWFscGF0aFN5bmMsXG4gIHN5bWxpbmtTeW5jLFxuICBsc3RhdFN5bmMsXG59IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGV4ZWNTeW5jIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuXG5pbXBvcnQgeyBjcmVhdGVBdXRvV29ya3RyZWUsIG1lcmdlTWlsZXN0b25lVG9NYWluIH0gZnJvbSBcIi4uL2F1dG8td29ya3RyZWUudHNcIjtcbmltcG9ydCB7IF9yZXNldFNlcnZpY2VDYWNoZSB9IGZyb20gXCIuLi93b3JrdHJlZS50c1wiO1xuaW1wb3J0IHsgX2NsZWFyR3NkUm9vdENhY2hlIH0gZnJvbSBcIi4uL3BhdGhzLnRzXCI7XG5cbi8vIElzb2xhdGUgZnJvbSB1c2VyJ3MgZ2xvYmFsIHByZWZlcmVuY2VzICh3aGljaCBtYXkgaGF2ZSBnaXQubWFpbl9icmFuY2ggc2V0KVxubGV0IG9yaWdpbmFsSG9tZTogc3RyaW5nIHwgdW5kZWZpbmVkO1xubGV0IGZha2VIb21lOiBzdHJpbmc7XG5jb25zdCB0ZXN0Q3dkID0gcHJvY2Vzcy5jd2QoKTtcblxudGVzdC5iZWZvcmUoKCkgPT4ge1xuICBvcmlnaW5hbEhvbWUgPSBwcm9jZXNzLmVudi5IT01FO1xuICBmYWtlSG9tZSA9IHJlYWxwYXRoU3luYyhta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1mYWtlLWhvbWUtXCIpKSk7XG4gIHByb2Nlc3MuZW52LkhPTUUgPSBmYWtlSG9tZTtcbiAgX2NsZWFyR3NkUm9vdENhY2hlKCk7XG4gIF9yZXNldFNlcnZpY2VDYWNoZSgpO1xufSk7XG5cbnRlc3QuYWZ0ZXIoKCkgPT4ge1xuICBwcm9jZXNzLmVudi5IT01FID0gb3JpZ2luYWxIb21lO1xuICBfY2xlYXJHc2RSb290Q2FjaGUoKTtcbiAgX3Jlc2V0U2VydmljZUNhY2hlKCk7XG4gIHJtU3luYyhmYWtlSG9tZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xufSk7XG5cbmZ1bmN0aW9uIGNsZWFudXBUZW1wUGF0aHMoLi4ucGF0aHM6IHN0cmluZ1tdKTogdm9pZCB7XG4gIHRyeSB7IHByb2Nlc3MuY2hkaXIodGVzdEN3ZCk7IH0gY2F0Y2ggeyAvKiBiZXN0LWVmZm9ydCAqLyB9XG4gIGZvciAoY29uc3QgcCBvZiBwYXRocykge1xuICAgIHJtU3luYyhwLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gcnVuKGNtZDogc3RyaW5nLCBjd2Q6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBleGVjU3luYyhjbWQsIHtcbiAgICBjd2QsXG4gICAgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdLFxuICAgIGVuY29kaW5nOiBcInV0Zi04XCIsXG4gIH0pLnRyaW0oKTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlVGVtcFJlcG8oKTogc3RyaW5nIHtcbiAgY29uc3QgZGlyID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwid3QtY3R4LXN0YXNoLXRlc3QtXCIpKSk7XG4gIHJ1bihcImdpdCBpbml0XCIsIGRpcik7XG4gIHJ1bihcImdpdCBjb25maWcgdXNlci5lbWFpbCB0ZXN0QHRlc3QuY29tXCIsIGRpcik7XG4gIHJ1bihcImdpdCBjb25maWcgdXNlci5uYW1lIFRlc3RcIiwgZGlyKTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJSRUFETUUubWRcIiksIFwiIyB0ZXN0XFxuXCIpO1xuICBta2RpclN5bmMoam9pbihkaXIsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiLmdzZFwiLCBcIlNUQVRFLm1kXCIpLCBcInZlcnNpb246IDFcXG5cIik7XG4gIC8vIEluIHByb2plY3RzIHdpdGggdHJhY2tlZCAuZ3NkLyBmaWxlcyAoaGFzR2l0VHJhY2tlZEdzZEZpbGVzPXRydWUpLFxuICAvLyAuZ3NkIGlzIE5PVCBhZGRlZCB0byAuZ2l0aWdub3JlLiBUaGlzIG1lYW5zIHVudHJhY2tlZCBmaWxlcyB1bmRlclxuICAvLyAuZ3NkLyBhcmUgdmlzaWJsZSB0byAtLWluY2x1ZGUtdW50cmFja2VkIGFuZCBnZXQgc3dlcHQgaW50byB0aGVcbiAgLy8gc3Rhc2gsIGRlc3Ryb3lpbmcgcXVldWVkIG1pbGVzdG9uZSBDT05URVhUIGZpbGVzICgjMjUwNSkuXG4gIHJ1bihcImdpdCBhZGQgLWYgLmdzZC9TVEFURS5tZFwiLCBkaXIpO1xuICBydW4oXCJnaXQgYWRkIC5cIiwgZGlyKTtcbiAgcnVuKFwiZ2l0IGNvbW1pdCAtbSBpbml0XCIsIGRpcik7XG4gIHJ1bihcImdpdCBicmFuY2ggLU0gbWFpblwiLCBkaXIpO1xuICByZXR1cm4gZGlyO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVUZW1wUmVwb1dpdGhTeW1saW5rZWRHc2QoKTogeyByZXBvOiBzdHJpbmc7IHN0YXRlRGlyOiBzdHJpbmcgfSB7XG4gIGNvbnN0IHJlcG8gPSByZWFscGF0aFN5bmMobWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJ3dC1zeW1saW5rLXN0YXNoLXRlc3QtXCIpKSk7XG4gIGNvbnN0IHN0YXRlRGlyID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwid3Qtc3ltbGluay1zdGF0ZS1cIikpKTtcbiAgcnVuKFwiZ2l0IGluaXRcIiwgcmVwbyk7XG4gIHJ1bihcImdpdCBjb25maWcgdXNlci5lbWFpbCB0ZXN0QHRlc3QuY29tXCIsIHJlcG8pO1xuICBydW4oXCJnaXQgY29uZmlnIHVzZXIubmFtZSBUZXN0XCIsIHJlcG8pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4ocmVwbywgXCJSRUFETUUubWRcIiksIFwiIyB0ZXN0XFxuXCIpO1xuICBzeW1saW5rU3luYyhzdGF0ZURpciwgam9pbihyZXBvLCBcIi5nc2RcIikpO1xuICBydW4oXCJnaXQgYWRkIFJFQURNRS5tZFwiLCByZXBvKTtcbiAgcnVuKFwiZ2l0IGNvbW1pdCAtbSBpbml0XCIsIHJlcG8pO1xuICBydW4oXCJnaXQgYnJhbmNoIC1NIG1haW5cIiwgcmVwbyk7XG4gIHJldHVybiB7IHJlcG8sIHN0YXRlRGlyIH07XG59XG5cbmZ1bmN0aW9uIG1ha2VSb2FkbWFwKFxuICBtaWxlc3RvbmVJZDogc3RyaW5nLFxuICB0aXRsZTogc3RyaW5nLFxuICBzbGljZXM6IEFycmF5PHsgaWQ6IHN0cmluZzsgdGl0bGU6IHN0cmluZyB9Pixcbik6IHN0cmluZyB7XG4gIGNvbnN0IHNsaWNlTGluZXMgPSBzbGljZXNcbiAgICAubWFwKChzKSA9PiBgLSBbeF0gKioke3MuaWR9OiAke3MudGl0bGV9KipgKVxuICAgIC5qb2luKFwiXFxuXCIpO1xuICByZXR1cm4gYCMgJHttaWxlc3RvbmVJZH06ICR7dGl0bGV9XFxuXFxuIyMgU2xpY2VzXFxuJHtzbGljZUxpbmVzfVxcbmA7XG59XG5cbi8qKlxuICogU3RhbmRhbG9uZSB0ZXN0IHByb3ZpbmcgdGhhdCAtLWluY2x1ZGUtdW50cmFja2VkIHN3ZWVwcyBxdWV1ZWRcbiAqIG1pbGVzdG9uZSBDT05URVhUIGZpbGVzIGludG8gdGhlIGdpdCBzdGFzaC4gVGhpcyBpcyBhIGRpcmVjdFxuICogZ2l0LWxldmVsIHRlc3QsIG5vdCBnb2luZyB0aHJvdWdoIG1lcmdlTWlsZXN0b25lVG9NYWluLlxuICovXG50ZXN0KFwiIzI1MDU6IGdpdCBzdGFzaCAtLWluY2x1ZGUtdW50cmFja2VkIHN3ZWVwcyBxdWV1ZWQgQ09OVEVYVCBmaWxlcyAoZGVtb25zdHJhdGVzIHRoZSBidWcpXCIsICgpID0+IHtcbiAgY29uc3QgZGlyID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwid3Qtc3Rhc2gtYnVnLWRlbW8tXCIpKSk7XG4gIHRyeSB7XG4gICAgcnVuKFwiZ2l0IGluaXRcIiwgZGlyKTtcbiAgICBydW4oXCJnaXQgY29uZmlnIHVzZXIuZW1haWwgdGVzdEB0ZXN0LmNvbVwiLCBkaXIpO1xuICAgIHJ1bihcImdpdCBjb25maWcgdXNlci5uYW1lIFRlc3RcIiwgZGlyKTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcIlJFQURNRS5tZFwiKSwgXCIjIHRlc3RcXG5cIik7XG4gICAgbWtkaXJTeW5jKGpvaW4oZGlyLCBcIi5nc2RcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiLmdzZFwiLCBcIlNUQVRFLm1kXCIpLCBcInZlcnNpb246IDFcXG5cIik7XG4gICAgcnVuKFwiZ2l0IGFkZCAtZiAuZ3NkL1NUQVRFLm1kXCIsIGRpcik7XG4gICAgcnVuKFwiZ2l0IGFkZCAuXCIsIGRpcik7XG4gICAgcnVuKFwiZ2l0IGNvbW1pdCAtbSBpbml0XCIsIGRpcik7XG5cbiAgICAvLyBDcmVhdGUgcXVldWVkIG1pbGVzdG9uZSBDT05URVhUIGZpbGVzICh1bnRyYWNrZWQsIG5vdCBnaXRpZ25vcmVkKVxuICAgIGNvbnN0IG0wMTNEaXIgPSBqb2luKGRpciwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMTNcIik7XG4gICAgbWtkaXJTeW5jKG0wMTNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKG0wMTNEaXIsIFwiTTAxMy1DT05URVhULm1kXCIpLFxuICAgICAgXCIjIE0wMTM6IExvZ2luIFBhZ2UgUmVkZXNpZ25cXG5cIixcbiAgICApO1xuXG4gICAgLy8gRGlydHkgYSB0cmFja2VkIGZpbGVcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcIlJFQURNRS5tZFwiKSwgXCIjIHRlc3RcXG5cXG5EaXJ0eS5cXG5cIik7XG5cbiAgICAvLyBWZXJpZnkgdGhlIENPTlRFWFQgZmlsZSBpcyB1bnRyYWNrZWRcbiAgICBjb25zdCBzdGF0dXMgPSBydW4oXCJnaXQgc3RhdHVzIC0tcG9yY2VsYWluXCIsIGRpcik7XG4gICAgYXNzZXJ0Lm9rKHN0YXR1cy5pbmNsdWRlcyhcIj8/IC5nc2QvbWlsZXN0b25lcy9cIiksIFwicHJlY29uZGl0aW9uOiBNMDEzIGRpciBpcyB1bnRyYWNrZWRcIik7XG5cbiAgICAvLyBTdGFzaCBXSVRIIC0taW5jbHVkZS11bnRyYWNrZWQgKHRoZSBidWcpXG4gICAgcnVuKCdnaXQgc3Rhc2ggcHVzaCAtLWluY2x1ZGUtdW50cmFja2VkIC1tIFwidGVzdCBzdGFzaFwiJywgZGlyKTtcblxuICAgIC8vIEJVRzogdGhlIHF1ZXVlZCBDT05URVhUIGZpbGUgd2FzIHN3ZXB0IGludG8gdGhlIHN0YXNoXG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgIWV4aXN0c1N5bmMoam9pbihtMDEzRGlyLCBcIk0wMTMtQ09OVEVYVC5tZFwiKSksXG4gICAgICBcIkJVRyBDT05GSVJNRUQ6IC0taW5jbHVkZS11bnRyYWNrZWQgc3dlcHQgQ09OVEVYVCBmaWxlIGludG8gc3Rhc2hcIixcbiAgICApO1xuXG4gICAgLy8gU3Rhc2ggV0lUSE9VVCAtLWluY2x1ZGUtdW50cmFja2VkICh0aGUgZml4KVxuICAgIHJ1bihcImdpdCBzdGFzaCBwb3BcIiwgZGlyKTtcblxuICAgIC8vIFJlY3JlYXRlIHRoZSBzY2VuYXJpb1xuICAgIG1rZGlyU3luYyhtMDEzRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihtMDEzRGlyLCBcIk0wMTMtQ09OVEVYVC5tZFwiKSxcbiAgICAgIFwiIyBNMDEzOiBMb2dpbiBQYWdlIFJlZGVzaWduXFxuXCIsXG4gICAgKTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcIlJFQURNRS5tZFwiKSwgXCIjIHRlc3RcXG5cXG5EaXJ0eSBhZ2Fpbi5cXG5cIik7XG5cbiAgICAvLyBTdGFzaCBXSVRIT1VUIC0taW5jbHVkZS11bnRyYWNrZWQgKHRoZSBmaXgpXG4gICAgcnVuKCdnaXQgc3Rhc2ggcHVzaCAtbSBcInRlc3Qgc3Rhc2ggbm8gdW50cmFja2VkXCInLCBkaXIpO1xuXG4gICAgLy8gRklYOiB0aGUgcXVldWVkIENPTlRFWFQgZmlsZSBzdGF5cyBvbiBkaXNrXG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgZXhpc3RzU3luYyhqb2luKG0wMTNEaXIsIFwiTTAxMy1DT05URVhULm1kXCIpKSxcbiAgICAgIFwiRklYIENPTkZJUk1FRDogd2l0aG91dCAtLWluY2x1ZGUtdW50cmFja2VkLCBDT05URVhUIGZpbGUgc3RheXMgb24gZGlza1wiLFxuICAgICk7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcIiMyNTA1OiBtZXJnZU1pbGVzdG9uZVRvTWFpbiBwcmVzZXJ2ZXMgcXVldWVkIENPTlRFWFQgZmlsZXMgKG5vdCBzd2VwdCBpbnRvIHN0YXNoKVwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlcG8gPSBjcmVhdGVUZW1wUmVwbygpO1xuICB0cnkge1xuICAgIGNvbnN0IHd0UGF0aCA9IGNyZWF0ZUF1dG9Xb3JrdHJlZShyZXBvLCBcIk0wMTVcIik7XG4gICAgY29uc3Qgbm9ybWFsaXplZFBhdGggPSB3dFBhdGgucmVwbGFjZUFsbChcIlxcXFxcIiwgXCIvXCIpO1xuICAgIGNvbnN0IHdvcmt0cmVlTmFtZSA9IG5vcm1hbGl6ZWRQYXRoLnNwbGl0KFwiL1wiKS5wb3AoKSB8fCBcIk0wMTVcIjtcbiAgICBjb25zdCBzbGljZUJyYW5jaCA9IGBzbGljZS8ke3dvcmt0cmVlTmFtZX0vUzAxYDtcbiAgICBydW4oYGdpdCBjaGVja291dCAtYiBcIiR7c2xpY2VCcmFuY2h9XCJgLCB3dFBhdGgpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbih3dFBhdGgsIFwiYXBwLnRzXCIpLCBcImV4cG9ydCBjb25zdCBhcHAgPSB0cnVlO1xcblwiKTtcbiAgICBydW4oXCJnaXQgYWRkIC5cIiwgd3RQYXRoKTtcbiAgICBydW4oJ2dpdCBjb21taXQgLW0gXCJhZGQgYXBwIGZlYXR1cmVcIicsIHd0UGF0aCk7XG4gICAgcnVuKFwiZ2l0IGNoZWNrb3V0IG1pbGVzdG9uZS9NMDE1XCIsIHd0UGF0aCk7XG4gICAgcnVuKGBnaXQgbWVyZ2UgLS1uby1mZiBcIiR7c2xpY2VCcmFuY2h9XCIgLW0gXCJtZXJnZSBTMDFcImAsIHd0UGF0aCk7XG5cbiAgICAvLyBTaW11bGF0ZSBgL2dzZCBxdWV1ZWAgY3JlYXRpbmcgcXVldWVkIG1pbGVzdG9uZSBDT05URVhUIGZpbGVzIGF0IHRoZVxuICAgIC8vIHByb2plY3Qgcm9vdC4gVGhlc2UgYXJlIHVudHJhY2tlZCwgYW5kIGluIHJlcG9zIHdpdGggdHJhY2tlZCAuZ3NkL1xuICAgIC8vIGZpbGVzIHRoZXkgYXJlIE5PVCBnaXRpZ25vcmVkLlxuICAgIGNvbnN0IG0wMTNEaXIgPSBqb2luKHJlcG8sIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDEzXCIpO1xuICAgIGNvbnN0IG0wMTREaXIgPSBqb2luKHJlcG8sIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDE0XCIpO1xuICAgIG1rZGlyU3luYyhtMDEzRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBta2RpclN5bmMobTAxNERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4obTAxM0RpciwgXCJNMDEzLUNPTlRFWFQubWRcIiksXG4gICAgICBcIiMgTTAxMzogTG9naW4gUGFnZSBSZWRlc2lnblxcblxcblF1ZXVlZCBtaWxlc3RvbmUgY29udGV4dC5cXG5cIixcbiAgICApO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKG0wMTREaXIsIFwiTTAxNC1DT05URVhULm1kXCIpLFxuICAgICAgXCIjIE0wMTQ6IERhc2hib2FyZCBSZWRlc2lnblxcblxcblF1ZXVlZCBtaWxlc3RvbmUgY29udGV4dC5cXG5cIixcbiAgICApO1xuXG4gICAgLy8gRGlydHkgYSB0cmFja2VkIGZpbGUgdG8gdHJpZ2dlciB0aGUgcHJlLW1lcmdlIHN0YXNoXG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHJlcG8sIFwiUkVBRE1FLm1kXCIpLCBcIiMgdGVzdFxcblxcbkRpcnR5IGNoYW5nZS5cXG5cIik7XG5cbiAgICAvLyBWZXJpZnkgTTAxMyBpcyB1bnRyYWNrZWQgKHByZWNvbmRpdGlvbilcbiAgICBjb25zdCBzdGF0dXNCZWZvcmUgPSBydW4oXCJnaXQgc3RhdHVzIC0tcG9yY2VsYWluXCIsIHJlcG8pO1xuICAgIGFzc2VydC5vayhcbiAgICAgIHN0YXR1c0JlZm9yZS5pbmNsdWRlcyhcIj8/IC5nc2QvbWlsZXN0b25lcy9cIiksXG4gICAgICBcIk0wMTMgZGlyZWN0b3J5IGlzIHVudHJhY2tlZCBiZWZvcmUgbWVyZ2UgKHByZWNvbmRpdGlvbilcIixcbiAgICApO1xuXG4gICAgY29uc3Qgcm9hZG1hcCA9IG1ha2VSb2FkbWFwKFwiTTAxNVwiLCBcIkFwcCBGZWF0dXJlXCIsIFtcbiAgICAgIHsgaWQ6IFwiUzAxXCIsIHRpdGxlOiBcIkZlYXR1cmVcIiB9LFxuICAgIF0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gbWVyZ2VNaWxlc3RvbmVUb01haW4ocmVwbywgXCJNMDE1XCIsIHJvYWRtYXApO1xuICAgIGFzc2VydC5vayhcbiAgICAgIHJlc3VsdC5jb21taXRNZXNzYWdlLmluY2x1ZGVzKFwiR1NELU1pbGVzdG9uZTogTTAxNVwiKSxcbiAgICAgIFwibWVyZ2Ugc2hvdWxkIHN1Y2NlZWRcIixcbiAgICApO1xuXG4gICAgLy8gQ1JJVElDQUw6IFF1ZXVlZCBtaWxlc3RvbmUgQ09OVEVYVCBmaWxlcyBtdXN0IHN0aWxsIGV4aXN0IG9uIGRpc2suXG4gICAgLy8gV2l0aCAtLWluY2x1ZGUtdW50cmFja2VkLCB0aGVzZSBmaWxlcyBnZXQgc3dlcHQgaW50byB0aGUgc3Rhc2hcbiAgICAvLyBkdXJpbmcgdGhlIG1lcmdlIGFuZCBhcmUgb25seSByZXN0b3JlZCBpZiBzdGFzaCBwb3Agc3VjY2VlZHMuXG4gICAgLy8gV2l0aG91dCAtLWluY2x1ZGUtdW50cmFja2VkLCB0aGV5IGFyZSBuZXZlciB0b3VjaGVkLlxuICAgIGFzc2VydC5vayhcbiAgICAgIGV4aXN0c1N5bmMoam9pbihtMDEzRGlyLCBcIk0wMTMtQ09OVEVYVC5tZFwiKSksXG4gICAgICBcIk0wMTMtQ09OVEVYVC5tZCBtdXN0IHN1cnZpdmUgdGhlIG1lcmdlIChub3Qgc3dlcHQgaW50byBzdGFzaClcIixcbiAgICApO1xuICAgIGFzc2VydC5vayhcbiAgICAgIGV4aXN0c1N5bmMoam9pbihtMDE0RGlyLCBcIk0wMTQtQ09OVEVYVC5tZFwiKSksXG4gICAgICBcIk0wMTQtQ09OVEVYVC5tZCBtdXN0IHN1cnZpdmUgdGhlIG1lcmdlIChub3Qgc3dlcHQgaW50byBzdGFzaClcIixcbiAgICApO1xuICAgIGFzc2VydC5vayhcbiAgICAgIHJlYWRGaWxlU3luYyhqb2luKG0wMTNEaXIsIFwiTTAxMy1DT05URVhULm1kXCIpLCBcInV0Zi04XCIpLmluY2x1ZGVzKFwiTG9naW4gUGFnZSBSZWRlc2lnblwiKSxcbiAgICAgIFwiTTAxMyBjb250ZXh0IGNvbnRlbnQgcHJlc2VydmVkXCIsXG4gICAgKTtcbiAgICBhc3NlcnQub2soXG4gICAgICByZWFkRmlsZVN5bmMoam9pbihtMDE0RGlyLCBcIk0wMTQtQ09OVEVYVC5tZFwiKSwgXCJ1dGYtOFwiKS5pbmNsdWRlcyhcIkRhc2hib2FyZCBSZWRlc2lnblwiKSxcbiAgICAgIFwiTTAxNCBjb250ZXh0IGNvbnRlbnQgcHJlc2VydmVkXCIsXG4gICAgKTtcblxuICAgIC8vIFZlcmlmeSBtaWxlc3RvbmUgY29kZSBtZXJnZWQgY29ycmVjdGx5XG4gICAgYXNzZXJ0Lm9rKGV4aXN0c1N5bmMoam9pbihyZXBvLCBcImFwcC50c1wiKSksIFwibWlsZXN0b25lIGNvZGUgbWVyZ2VkIHRvIG1haW5cIik7XG5cbiAgICAvLyBWZXJpZnkgbm8gc3Rhc2ggZW50cnkgcmVtYWlucyB0aGF0IGNvdWxkIGNvbnRhaW4gcXVldWVkIGZpbGVzLlxuICAgIC8vIElmIC0taW5jbHVkZS11bnRyYWNrZWQgaXMgcmVtb3ZlZCwgdGhlIHN0YXNoIChpZiBuZWVkZWQpIHNob3VsZFxuICAgIC8vIHBvcCBjbGVhbmx5IHNpbmNlIGl0IG9ubHkgY29udGFpbnMgdHJhY2tlZCBmaWxlcy5cbiAgICBsZXQgc3Rhc2hMaXN0OiBzdHJpbmc7XG4gICAgdHJ5IHtcbiAgICAgIHN0YXNoTGlzdCA9IHJ1bihcImdpdCBzdGFzaCBsaXN0XCIsIHJlcG8pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgc3Rhc2hMaXN0ID0gXCJcIjtcbiAgICB9XG4gICAgLy8gQSBsZWZ0b3ZlciBzdGFzaCBhZnRlciBtZXJnZSBpcyBhY2NlcHRhYmxlIChwb3AgY29uZmxpY3Qgb24gdHJhY2tlZFxuICAgIC8vIGZpbGVzKSwgYnV0IGl0IG11c3QgTk9UIGNvbnRhaW4gcXVldWVkIG1pbGVzdG9uZSBmaWxlcy5cbiAgICBpZiAoc3Rhc2hMaXN0KSB7XG4gICAgICAvLyBWZXJpZnkgdGhlIHN0YXNoIGRvZXMgbm90IGNvbnRhaW4gcXVldWVkIG1pbGVzdG9uZSBlbnRyaWVzXG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBzdGFzaERpZmYgPSBydW4oXCJnaXQgZGlmZiBzdGFzaEB7MH1eMyAtLW5hbWUtb25seSAyPi9kZXYvbnVsbCB8fCB0cnVlXCIsIHJlcG8pO1xuICAgICAgICBhc3NlcnQub2soXG4gICAgICAgICAgIXN0YXNoRGlmZi5pbmNsdWRlcyhcIk0wMTMtQ09OVEVYVFwiKSxcbiAgICAgICAgICBcInN0YXNoIG11c3Qgbm90IGNvbnRhaW4gcXVldWVkIG1pbGVzdG9uZSBNMDEzIGZpbGVzXCIsXG4gICAgICAgICk7XG4gICAgICAgIGFzc2VydC5vayhcbiAgICAgICAgICAhc3Rhc2hEaWZmLmluY2x1ZGVzKFwiTTAxNC1DT05URVhUXCIpLFxuICAgICAgICAgIFwic3Rhc2ggbXVzdCBub3QgY29udGFpbiBxdWV1ZWQgbWlsZXN0b25lIE0wMTQgZmlsZXNcIixcbiAgICAgICAgKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvLyBObyB1bnRyYWNrZWQgdHJlZSBpbiBzdGFzaCBcdTIwMTQgdGhhdCdzIHRoZSBleHBlY3RlZCBvdXRjb21lIHdpdGggdGhlIGZpeFxuICAgICAgfVxuICAgIH1cbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwVGVtcFBhdGhzKHJlcG8pO1xuICB9XG59KTtcblxudGVzdChcIiMyNTA1OiBwcmUtbWVyZ2Ugc3Rhc2ggaGFuZGxlcyBzeW1saW5rZWQgLmdzZCB3aXRob3V0IHRyYXZlcnNpbmcgaXRcIiwgKCkgPT4ge1xuICBjb25zdCB7IHJlcG8sIHN0YXRlRGlyIH0gPSBjcmVhdGVUZW1wUmVwb1dpdGhTeW1saW5rZWRHc2QoKTtcbiAgdHJ5IHtcbiAgICBjb25zdCB3dFBhdGggPSBjcmVhdGVBdXRvV29ya3RyZWUocmVwbywgXCJNMDE2XCIpO1xuICAgIGNvbnN0IG5vcm1hbGl6ZWRQYXRoID0gd3RQYXRoLnJlcGxhY2VBbGwoXCJcXFxcXCIsIFwiL1wiKTtcbiAgICBjb25zdCB3b3JrdHJlZU5hbWUgPSBub3JtYWxpemVkUGF0aC5zcGxpdChcIi9cIikucG9wKCkgfHwgXCJNMDE2XCI7XG4gICAgY29uc3Qgc2xpY2VCcmFuY2ggPSBgc2xpY2UvJHt3b3JrdHJlZU5hbWV9L1MwMWA7XG4gICAgcnVuKGBnaXQgY2hlY2tvdXQgLWIgXCIke3NsaWNlQnJhbmNofVwiYCwgd3RQYXRoKTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4od3RQYXRoLCBcImFwcC50c1wiKSwgXCJleHBvcnQgY29uc3QgYXBwID0gdHJ1ZTtcXG5cIik7XG4gICAgcnVuKFwiZ2l0IGFkZCBhcHAudHNcIiwgd3RQYXRoKTtcbiAgICBydW4oJ2dpdCBjb21taXQgLW0gXCJhZGQgYXBwIGZlYXR1cmVcIicsIHd0UGF0aCk7XG4gICAgcnVuKFwiZ2l0IGNoZWNrb3V0IG1pbGVzdG9uZS9NMDE2XCIsIHd0UGF0aCk7XG4gICAgcnVuKGBnaXQgbWVyZ2UgLS1uby1mZiBcIiR7c2xpY2VCcmFuY2h9XCIgLW0gXCJtZXJnZSBTMDFcImAsIHd0UGF0aCk7XG5cbiAgICBjb25zdCBxdWV1ZWREaXIgPSBqb2luKHN0YXRlRGlyLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDE3XCIpO1xuICAgIG1rZGlyU3luYyhxdWV1ZWREaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihxdWV1ZWREaXIsIFwiTTAxNy1DT05URVhULm1kXCIpLCBcIiMgTTAxNzogUXVldWVkXFxuXCIpO1xuXG4gICAgLy8gVHJpZ2dlciB0aGUgcHJlLW1lcmdlIHN0YXNoIHdpdGggYm90aCB0cmFja2VkIGFuZCB1bnRyYWNrZWQgcHJvamVjdCBmaWxlcy5cbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocmVwbywgXCJSRUFETUUubWRcIiksIFwiIyB0ZXN0XFxuXFxuRGlydHkgY2hhbmdlLlxcblwiKTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocmVwbywgXCJsb2NhbC1ub3RlLnR4dFwiKSwgXCJsb2NhbCBzY3JhdGNoXFxuXCIpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gbWVyZ2VNaWxlc3RvbmVUb01haW4ocmVwbywgXCJNMDE2XCIsIG1ha2VSb2FkbWFwKFwiTTAxNlwiLCBcIkFwcCBGZWF0dXJlXCIsIFtcbiAgICAgIHsgaWQ6IFwiUzAxXCIsIHRpdGxlOiBcIkZlYXR1cmVcIiB9LFxuICAgIF0pKTtcblxuICAgIGFzc2VydC5vayhyZXN1bHQuY29tbWl0TWVzc2FnZS5pbmNsdWRlcyhcIkdTRC1NaWxlc3RvbmU6IE0wMTZcIiksIFwibWVyZ2Ugc2hvdWxkIHN1Y2NlZWRcIik7XG4gICAgYXNzZXJ0Lm9rKGV4aXN0c1N5bmMoam9pbihyZXBvLCBcImFwcC50c1wiKSksIFwibWlsZXN0b25lIGNvZGUgbWVyZ2VkIHRvIG1haW5cIik7XG4gICAgYXNzZXJ0LmVxdWFsKGxzdGF0U3luYyhqb2luKHJlcG8sIFwiLmdzZFwiKSkuaXNTeW1ib2xpY0xpbmsoKSwgdHJ1ZSwgXCIuZ3NkIHN5bWxpbmsgcmVtYWlucyBpbiBwbGFjZVwiKTtcbiAgICBhc3NlcnQub2soZXhpc3RzU3luYyhqb2luKHF1ZXVlZERpciwgXCJNMDE3LUNPTlRFWFQubWRcIikpLCBcInF1ZXVlZCBjb250ZXh0IHJlbWFpbnMgaW4gZXh0ZXJuYWwgc3RhdGVcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlYWRGaWxlU3luYyhqb2luKHJlcG8sIFwiUkVBRE1FLm1kXCIpLCBcInV0Zi04XCIpLnJlcGxhY2UoL1xcclxcbi9nLCBcIlxcblwiKSwgXCIjIHRlc3RcXG5cXG5EaXJ0eSBjaGFuZ2UuXFxuXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZWFkRmlsZVN5bmMoam9pbihyZXBvLCBcImxvY2FsLW5vdGUudHh0XCIpLCBcInV0Zi04XCIpLCBcImxvY2FsIHNjcmF0Y2hcXG5cIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cFRlbXBQYXRocyhyZXBvLCBzdGF0ZURpcik7XG4gIH1cbn0pO1xuXG50ZXN0KFwiIzI1MDU6IGJhY2stdG8tYmFjayBtZXJnZXMgcHJlc2VydmUgcXVldWVkIENPTlRFWFQgZmlsZXNcIiwgKCkgPT4ge1xuICBjb25zdCByZXBvID0gY3JlYXRlVGVtcFJlcG8oKTtcbiAgdHJ5IHtcbiAgICAvLyBcdTI1MDBcdTI1MDAgRmlyc3QgbWlsZXN0b25lOiBNMDE1IFx1MjUwMFx1MjUwMFxuICAgIGNvbnN0IHd0MSA9IGNyZWF0ZUF1dG9Xb3JrdHJlZShyZXBvLCBcIk0wMTVcIik7XG4gICAgY29uc3Qgd3QxTmFtZSA9IHd0MS5yZXBsYWNlQWxsKFwiXFxcXFwiLCBcIi9cIikuc3BsaXQoXCIvXCIpLnBvcCgpIHx8IFwiTTAxNVwiO1xuICAgIGNvbnN0IHNsaWNlMSA9IGBzbGljZS8ke3d0MU5hbWV9L1MwMWA7XG4gICAgcnVuKGBnaXQgY2hlY2tvdXQgLWIgXCIke3NsaWNlMX1cImAsIHd0MSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHd0MSwgXCJmZWF0dXJlMS50c1wiKSwgXCJleHBvcnQgY29uc3QgZjEgPSB0cnVlO1xcblwiKTtcbiAgICBydW4oXCJnaXQgYWRkIC5cIiwgd3QxKTtcbiAgICBydW4oJ2dpdCBjb21taXQgLW0gXCJmZWF0dXJlIDFcIicsIHd0MSk7XG4gICAgcnVuKFwiZ2l0IGNoZWNrb3V0IG1pbGVzdG9uZS9NMDE1XCIsIHd0MSk7XG4gICAgcnVuKGBnaXQgbWVyZ2UgLS1uby1mZiBcIiR7c2xpY2UxfVwiIC1tIFwibWVyZ2UgUzAxXCJgLCB3dDEpO1xuXG4gICAgLy8gQ3JlYXRlIHF1ZXVlZCBtaWxlc3RvbmUgQ09OVEVYVCBmaWxlXG4gICAgY29uc3QgbTAxM0RpciA9IGpvaW4ocmVwbywgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMTNcIik7XG4gICAgbWtkaXJTeW5jKG0wMTNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKG0wMTNEaXIsIFwiTTAxMy1DT05URVhULm1kXCIpLFxuICAgICAgXCIjIE0wMTM6IExvZ2luIFBhZ2UgUmVkZXNpZ25cXG5cXG5RdWV1ZWQgbWlsZXN0b25lIGNvbnRleHQuXFxuXCIsXG4gICAgKTtcblxuICAgIC8vIERpcnR5IHRyYWNrZWQgZmlsZSB0byB0cmlnZ2VyIHN0YXNoXG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHJlcG8sIFwiUkVBRE1FLm1kXCIpLCBcIiMgdGVzdFxcblxcbkRpcnR5IGZvciBNMDE1LlxcblwiKTtcblxuICAgIG1lcmdlTWlsZXN0b25lVG9NYWluKHJlcG8sIFwiTTAxNVwiLCBtYWtlUm9hZG1hcChcIk0wMTVcIiwgXCJGZWF0dXJlIDFcIiwgW1xuICAgICAgeyBpZDogXCJTMDFcIiwgdGl0bGU6IFwiRmVhdHVyZSAxXCIgfSxcbiAgICBdKSk7XG5cbiAgICBhc3NlcnQub2soXG4gICAgICBleGlzdHNTeW5jKGpvaW4obTAxM0RpciwgXCJNMDEzLUNPTlRFWFQubWRcIikpLFxuICAgICAgXCJNMDEzLUNPTlRFWFQubWQgc3Vydml2ZXMgZmlyc3QgbWVyZ2VcIixcbiAgICApO1xuXG4gICAgLy8gXHUyNTAwXHUyNTAwIFNlY29uZCBtaWxlc3RvbmU6IE0wMTYgXHUyNTAwXHUyNTAwXG4gICAgY29uc3Qgd3QyID0gY3JlYXRlQXV0b1dvcmt0cmVlKHJlcG8sIFwiTTAxNlwiKTtcbiAgICBjb25zdCB3dDJOYW1lID0gd3QyLnJlcGxhY2VBbGwoXCJcXFxcXCIsIFwiL1wiKS5zcGxpdChcIi9cIikucG9wKCkgfHwgXCJNMDE2XCI7XG4gICAgY29uc3Qgc2xpY2UyID0gYHNsaWNlLyR7d3QyTmFtZX0vUzAxYDtcbiAgICBydW4oYGdpdCBjaGVja291dCAtYiBcIiR7c2xpY2UyfVwiYCwgd3QyKTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4od3QyLCBcImZlYXR1cmUyLnRzXCIpLCBcImV4cG9ydCBjb25zdCBmMiA9IHRydWU7XFxuXCIpO1xuICAgIHJ1bihcImdpdCBhZGQgLlwiLCB3dDIpO1xuICAgIHJ1bignZ2l0IGNvbW1pdCAtbSBcImZlYXR1cmUgMlwiJywgd3QyKTtcbiAgICBydW4oXCJnaXQgY2hlY2tvdXQgbWlsZXN0b25lL00wMTZcIiwgd3QyKTtcbiAgICBydW4oYGdpdCBtZXJnZSAtLW5vLWZmIFwiJHtzbGljZTJ9XCIgLW0gXCJtZXJnZSBTMDFcImAsIHd0Mik7XG5cbiAgICAvLyBEaXJ0eSB0cmFja2VkIGZpbGUgYWdhaW5cbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocmVwbywgXCJSRUFETUUubWRcIiksIFwiIyB0ZXN0XFxuXFxuRGlydHkgZm9yIE0wMTYuXFxuXCIpO1xuXG4gICAgbWVyZ2VNaWxlc3RvbmVUb01haW4ocmVwbywgXCJNMDE2XCIsIG1ha2VSb2FkbWFwKFwiTTAxNlwiLCBcIkZlYXR1cmUgMlwiLCBbXG4gICAgICB7IGlkOiBcIlMwMVwiLCB0aXRsZTogXCJGZWF0dXJlIDJcIiB9LFxuICAgIF0pKTtcblxuICAgIC8vIEFmdGVyIHR3byBjb25zZWN1dGl2ZSBtZXJnZXMsIHF1ZXVlZCBNMDEzIENPTlRFWFQgbXVzdCBzdGlsbCBleGlzdFxuICAgIGFzc2VydC5vayhcbiAgICAgIGV4aXN0c1N5bmMoam9pbihtMDEzRGlyLCBcIk0wMTMtQ09OVEVYVC5tZFwiKSksXG4gICAgICBcIk0wMTMtQ09OVEVYVC5tZCBtdXN0IHN1cnZpdmUgdHdvIGNvbnNlY3V0aXZlIG1pbGVzdG9uZSBtZXJnZXNcIixcbiAgICApO1xuICAgIGFzc2VydC5vayhcbiAgICAgIHJlYWRGaWxlU3luYyhqb2luKG0wMTNEaXIsIFwiTTAxMy1DT05URVhULm1kXCIpLCBcInV0Zi04XCIpLmluY2x1ZGVzKFwiTG9naW4gUGFnZSBSZWRlc2lnblwiKSxcbiAgICAgIFwiTTAxMyBjb250ZXh0IGNvbnRlbnQgcHJlc2VydmVkIGFmdGVyIGJhY2stdG8tYmFjayBtZXJnZXNcIixcbiAgICApO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXBUZW1wUGF0aHMocmVwbyk7XG4gIH1cbn0pO1xuXG4vLyAjNDU3MzogV2hlbiBgLmdzZGAgaXMgYSBnaXRpZ25vcmVkIHN5bWxpbmsgKEFEUi0wMDIgbGF5b3V0KSBhbmQgdGhlIHByb2plY3Rcbi8vIGAuZ2l0aWdub3JlYCBjb250YWlucyBgLmdzZGAsIGBnaXQgc3Rhc2ggcHVzaCAtLWluY2x1ZGUtdW50cmFja2VkIC0tIDxwYXRoc3BlYz5gXG4vLyBmYXRhbHMgd2l0aCBcIlRoZSBmb2xsb3dpbmcgcGF0aHMgYXJlIGlnbm9yZWQgYnkgb25lIG9mIHlvdXIgLmdpdGlnbm9yZSBmaWxlc1wiLlxuLy8gVGhlIHByaW9yIHRlc3RzIHVzZWQgYSBzeW1saW5rZWQgYC5nc2RgIGJ1dCBubyBgLmdpdGlnbm9yZWAsIHNvIHRoaXMgZmFpbHVyZVxuLy8gbW9kZSB3YXMgaW52aXNpYmxlIHRvIENJLiBGaXh0dXJlIG11c3QgaW5jbHVkZSBCT1RIIHRoZSBzeW1saW5rIEFORCB0aGVcbi8vIGlnbm9yZSBydWxlIHRvIHJlcHJvZHVjZSB0aGUgYnVnIG9uIHByZS1maXggY29kZS5cbnRlc3QoXCIjNDU3MzogZ2l0aWdub3JlZCAuZ3NkIHN5bWxpbmsgZG9lcyBub3QgYnJlYWsgcHJlLW1lcmdlIHN0YXNoXCIsICgpID0+IHtcbiAgY29uc3QgcmVwbyA9IHJlYWxwYXRoU3luYyhta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcInd0LTQ1NzMtaWdub3JlZC1zeW1saW5rLVwiKSkpO1xuICBjb25zdCBzdGF0ZURpciA9IHJlYWxwYXRoU3luYyhta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcInd0LTQ1NzMtc3RhdGUtXCIpKSk7XG4gIHRyeSB7XG4gICAgcnVuKFwiZ2l0IGluaXRcIiwgcmVwbyk7XG4gICAgcnVuKFwiZ2l0IGNvbmZpZyB1c2VyLmVtYWlsIHRlc3RAdGVzdC5jb21cIiwgcmVwbyk7XG4gICAgcnVuKFwiZ2l0IGNvbmZpZyB1c2VyLm5hbWUgVGVzdFwiLCByZXBvKTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocmVwbywgXCJSRUFETUUubWRcIiksIFwiIyB0ZXN0XFxuXCIpO1xuICAgIC8vIE1hdGNoZXMgd2hhdCBCQVNFTElORV9QQVRURVJOUyBpbiBnaXRpZ25vcmUudHMgd3JpdGVzIGZvciByZWFsIHByb2plY3RzLlxuICAgIHdyaXRlRmlsZVN5bmMoam9pbihyZXBvLCBcIi5naXRpZ25vcmVcIiksIFwiLmdzZFxcbi5nc2QtaWRcXG5cIik7XG4gICAgc3ltbGlua1N5bmMoc3RhdGVEaXIsIGpvaW4ocmVwbywgXCIuZ3NkXCIpKTtcbiAgICBydW4oXCJnaXQgYWRkIFJFQURNRS5tZCAuZ2l0aWdub3JlXCIsIHJlcG8pO1xuICAgIHJ1bihcImdpdCBjb21taXQgLW0gaW5pdFwiLCByZXBvKTtcbiAgICBydW4oXCJnaXQgYnJhbmNoIC1NIG1haW5cIiwgcmVwbyk7XG5cbiAgICBjb25zdCB3dFBhdGggPSBjcmVhdGVBdXRvV29ya3RyZWUocmVwbywgXCJNMDAxXCIpO1xuICAgIGNvbnN0IHdvcmt0cmVlTmFtZSA9IHd0UGF0aC5yZXBsYWNlQWxsKFwiXFxcXFwiLCBcIi9cIikuc3BsaXQoXCIvXCIpLnBvcCgpIHx8IFwiTTAwMVwiO1xuICAgIGNvbnN0IHNsaWNlQnJhbmNoID0gYHNsaWNlLyR7d29ya3RyZWVOYW1lfS9TMDFgO1xuICAgIHJ1bihgZ2l0IGNoZWNrb3V0IC1iIFwiJHtzbGljZUJyYW5jaH1cImAsIHd0UGF0aCk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHd0UGF0aCwgXCJhcHAudHNcIiksIFwiZXhwb3J0IGNvbnN0IGFwcCA9IHRydWU7XFxuXCIpO1xuICAgIHJ1bihcImdpdCBhZGQgYXBwLnRzXCIsIHd0UGF0aCk7XG4gICAgcnVuKCdnaXQgY29tbWl0IC1tIFwiYWRkIGZlYXR1cmVcIicsIHd0UGF0aCk7XG4gICAgcnVuKFwiZ2l0IGNoZWNrb3V0IG1pbGVzdG9uZS9NMDAxXCIsIHd0UGF0aCk7XG4gICAgcnVuKGBnaXQgbWVyZ2UgLS1uby1mZiBcIiR7c2xpY2VCcmFuY2h9XCIgLW0gXCJtZXJnZSBTMDFcImAsIHd0UGF0aCk7XG5cbiAgICAvLyBEaXJ0eSBhIHRyYWNrZWQgZmlsZSBzbyB0aGUgcHJlLW1lcmdlIHN0YXNoIGJyYW5jaCBhY3R1YWxseSBydW5zLlxuICAgIHdyaXRlRmlsZVN5bmMoam9pbihyZXBvLCBcIlJFQURNRS5tZFwiKSwgXCIjIHRlc3RcXG5cXG5EaXJ0eS5cXG5cIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSBtZXJnZU1pbGVzdG9uZVRvTWFpbihcbiAgICAgIHJlcG8sXG4gICAgICBcIk0wMDFcIixcbiAgICAgIG1ha2VSb2FkbWFwKFwiTTAwMVwiLCBcIkZlYXR1cmVcIiwgW3sgaWQ6IFwiUzAxXCIsIHRpdGxlOiBcIkZlYXR1cmVcIiB9XSksXG4gICAgKTtcblxuICAgIGFzc2VydC5vayhcbiAgICAgIHJlc3VsdC5jb21taXRNZXNzYWdlLmluY2x1ZGVzKFwiR1NELU1pbGVzdG9uZTogTTAwMVwiKSxcbiAgICAgIFwibWVyZ2UgbXVzdCBzdWNjZWVkIGRlc3BpdGUgZ2l0aWdub3JlZCAuZ3NkIHN5bWxpbmtcIixcbiAgICApO1xuICAgIGFzc2VydC5vayhleGlzdHNTeW5jKGpvaW4ocmVwbywgXCJhcHAudHNcIikpLCBcIm1pbGVzdG9uZSBjb2RlIG1lcmdlZCB0byBtYWluXCIpO1xuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIGxzdGF0U3luYyhqb2luKHJlcG8sIFwiLmdzZFwiKSkuaXNTeW1ib2xpY0xpbmsoKSxcbiAgICAgIHRydWUsXG4gICAgICBcIi5nc2Qgc3ltbGluayByZW1haW5zIGluIHBsYWNlXCIsXG4gICAgKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwVGVtcFBhdGhzKHJlcG8sIHN0YXRlRGlyKTtcbiAgfVxufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFhQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUNQLFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFDdkIsU0FBUyxnQkFBZ0I7QUFFekIsU0FBUyxvQkFBb0IsNEJBQTRCO0FBQ3pELFNBQVMsMEJBQTBCO0FBQ25DLFNBQVMsMEJBQTBCO0FBR25DLElBQUk7QUFDSixJQUFJO0FBQ0osTUFBTSxVQUFVLFFBQVEsSUFBSTtBQUU1QixLQUFLLE9BQU8sTUFBTTtBQUNoQixpQkFBZSxRQUFRLElBQUk7QUFDM0IsYUFBVyxhQUFhLFlBQVksS0FBSyxPQUFPLEdBQUcsZ0JBQWdCLENBQUMsQ0FBQztBQUNyRSxVQUFRLElBQUksT0FBTztBQUNuQixxQkFBbUI7QUFDbkIscUJBQW1CO0FBQ3JCLENBQUM7QUFFRCxLQUFLLE1BQU0sTUFBTTtBQUNmLFVBQVEsSUFBSSxPQUFPO0FBQ25CLHFCQUFtQjtBQUNuQixxQkFBbUI7QUFDbkIsU0FBTyxVQUFVLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQ25ELENB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
