import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  mergeSliceToMain,
  resquashMilestoneOnMain,
  getCollapseCadence,
  getMilestoneResquash
} from "../slice-cadence.js";
import { MergeConflictError } from "../git-service.js";
import { summarizeWorktreeTelemetry } from "../worktree-telemetry.js";
import { closeDatabase, insertMilestone, insertSlice, openDatabase } from "../gsd-db.js";
function git(args, cwd) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}
function createRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "slice-cad-test-")));
  git(["init"], dir);
  git(["config", "user.email", "test@test.com"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), "# test\n");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
  git(["branch", "-M", "main"], dir);
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  return dir;
}
function enterMilestoneBranch(dir, milestoneId) {
  git(["checkout", "-b", `milestone/${milestoneId}`], dir);
}
function commitFile(dir, file, content, msg) {
  writeFileSync(join(dir, file), content);
  git(["add", "."], dir);
  git(["commit", "-m", msg], dir);
  return git(["rev-parse", "HEAD"], dir);
}
describe("getCollapseCadence / getMilestoneResquash", () => {
  test("defaults to milestone cadence", () => {
    assert.equal(getCollapseCadence(void 0), "milestone");
    assert.equal(getCollapseCadence(null), "milestone");
    assert.equal(getCollapseCadence({}), "milestone");
    assert.equal(getCollapseCadence({ git: {} }), "milestone");
  });
  test("reads slice cadence when set", () => {
    assert.equal(getCollapseCadence({ git: { collapse_cadence: "slice" } }), "slice");
  });
  test("milestone_resquash defaults to true when not set", () => {
    assert.equal(getMilestoneResquash(void 0), true);
    assert.equal(getMilestoneResquash({ git: {} }), true);
    assert.equal(getMilestoneResquash({ git: { milestone_resquash: true } }), true);
  });
  test("milestone_resquash can be disabled explicitly", () => {
    assert.equal(getMilestoneResquash({ git: { milestone_resquash: false } }), false);
  });
});
describe("mergeSliceToMain", () => {
  let dir;
  let originalCwd;
  beforeEach(() => {
    dir = createRepo();
    originalCwd = process.cwd();
  });
  afterEach(() => {
    try {
      process.chdir(originalCwd);
    } catch {
    }
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });
  test("squashes one slice's commits onto main and advances the milestone branch", () => {
    enterMilestoneBranch(dir, "M001");
    commitFile(dir, "feature.txt", "slice 1 work\n", "feat: S01 work");
    process.chdir(dir);
    const result = mergeSliceToMain(dir, "M001", "S01");
    assert.equal(result.skipped, false);
    assert.ok(result.commitSha, "expected a commit SHA");
    assert.equal(result.milestoneBranch, "milestone/M001");
    assert.equal(result.mainBranch, "main");
    const mainLog = git(["log", "main", "--oneline"], dir);
    assert.ok(mainLog.includes("S01 of M001 (slice-cadence)"), `main log: ${mainLog}`);
    assert.equal(readFileSync(join(dir, "feature.txt"), "utf-8"), "slice 1 work\n");
    const mainSha = git(["rev-parse", "main"], dir);
    const milestoneSha = git(["rev-parse", "milestone/M001"], dir);
    assert.equal(milestoneSha, mainSha, "milestone branch must be advanced to main");
    const summary = summarizeWorktreeTelemetry(dir);
    assert.equal(summary.slicesMerged, 1);
    assert.equal(summary.sliceMergeConflicts, 0);
  });
  test("slice-cadence commit messages include milestone and slice names", () => {
    openDatabase(":memory:");
    insertMilestone({ id: "M001", title: "M001: Backend foundation", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "S01: Core API", status: "complete" });
    enterMilestoneBranch(dir, "M001");
    commitFile(dir, "feature.txt", "slice 1 work\n", "feat: S01 work");
    process.chdir(dir);
    mergeSliceToMain(dir, "M001", "S01");
    const subject = git(["log", "-1", "--format=%s", "main"], dir);
    const body = git(["log", "-1", "--format=%B", "main"], dir);
    assert.equal(subject, "feat: Core API - S01 of M001 (slice-cadence)");
    assert.ok(body.includes("Slice: S01 - Core API"));
    assert.ok(body.includes("Milestone: M001 - Backend foundation"));
    assert.ok(body.includes("GSD-Slice: S01"));
    assert.ok(body.includes("GSD-Milestone: M001"));
  });
  test("merges slices to the recorded integration branch", () => {
    git(["checkout", "-b", "develop"], dir);
    mkdirSync(join(dir, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(
      join(dir, ".gsd", "milestones", "M001", "M001-META.json"),
      JSON.stringify({ integrationBranch: "develop" }, null, 2) + "\n"
    );
    enterMilestoneBranch(dir, "M001");
    commitFile(dir, "develop-only.txt", "slice 1 work\n", "feat: S01 work");
    process.chdir(dir);
    const result = mergeSliceToMain(dir, "M001", "S01");
    assert.equal(result.mainBranch, "develop");
    assert.equal(readFileSync(join(dir, "develop-only.txt"), "utf-8"), "slice 1 work\n");
    assert.equal(git(["rev-parse", "develop"], dir), git(["rev-parse", "milestone/M001"], dir));
    assert.notEqual(git(["rev-parse", "develop"], dir), git(["rev-parse", "main"], dir));
  });
  test("advances milestone branch when it is checked out in a worktree", () => {
    commitFile(dir, ".gitignore", ".gsd/worktrees/\n", "chore: ignore worktrees");
    const wtPath = join(dir, ".gsd", "worktrees", "M001");
    mkdirSync(join(dir, ".gsd", "worktrees"), { recursive: true });
    git(["worktree", "add", "-b", "milestone/M001", wtPath, "main"], dir);
    commitFile(wtPath, "worktree-slice.txt", "slice work\n", "feat: S01 worktree");
    process.chdir(wtPath);
    const result = mergeSliceToMain(dir, "M001", "S01");
    assert.equal(result.skipped, false);
    assert.equal(git(["rev-parse", "main"], dir), git(["rev-parse", "milestone/M001"], dir));
    assert.equal(git(["branch", "--show-current"], wtPath), "milestone/M001");
    assert.equal(readFileSync(join(wtPath, "worktree-slice.txt"), "utf-8"), "slice work\n");
  });
  test("handles sequential slice merges cleanly", () => {
    enterMilestoneBranch(dir, "M001");
    commitFile(dir, "a.txt", "slice 1\n", "feat: S01");
    process.chdir(dir);
    mergeSliceToMain(dir, "M001", "S01");
    git(["checkout", "milestone/M001"], dir);
    commitFile(dir, "b.txt", "slice 2\n", "feat: S02");
    const result = mergeSliceToMain(dir, "M001", "S02");
    assert.equal(result.skipped, false);
    const mainLog = git(["log", "main", "--oneline"], dir);
    assert.ok(mainLog.includes("S01 of M001"));
    assert.ok(mainLog.includes("S02 of M001"));
    assert.equal(readFileSync(join(dir, "a.txt"), "utf-8"), "slice 1\n");
    assert.equal(readFileSync(join(dir, "b.txt"), "utf-8"), "slice 2\n");
    const summary = summarizeWorktreeTelemetry(dir);
    assert.equal(summary.slicesMerged, 2);
  });
  test("returns skipped when milestone branch has no commits ahead of main", () => {
    enterMilestoneBranch(dir, "M001");
    process.chdir(dir);
    const result = mergeSliceToMain(dir, "M001", "S01");
    assert.equal(result.skipped, true);
    assert.equal(result.skippedReason, "no-commits-ahead");
    assert.equal(result.commitSha, null);
  });
  test("throws MergeConflictError on a real conflict and leaves no merge artifacts", () => {
    writeFileSync(join(dir, "shared.txt"), "main version\n");
    git(["add", "."], dir);
    git(["commit", "-m", "main-seed"], dir);
    enterMilestoneBranch(dir, "M001");
    commitFile(dir, "shared.txt", "slice version\n", "feat: S01 conflicting");
    git(["checkout", "main"], dir);
    commitFile(dir, "shared.txt", "main evolved\n", "main evolved");
    git(["checkout", "milestone/M001"], dir);
    process.chdir(dir);
    assert.throws(
      () => mergeSliceToMain(dir, "M001", "S01"),
      (err) => err instanceof MergeConflictError
    );
    const gitDir = join(dir, ".git");
    for (const f of ["SQUASH_MSG", "MERGE_MSG", "MERGE_HEAD"]) {
      assert.ok(!existsSync(join(gitDir, f)), `${f} should be cleaned up`);
    }
    const summary = summarizeWorktreeTelemetry(dir);
    assert.equal(summary.sliceMergeConflicts, 1);
  });
  test("restores cwd even when merge fails (dirty working tree)", () => {
    enterMilestoneBranch(dir, "M001");
    commitFile(dir, "feature.txt", "slice 1\n", "feat: S01");
    writeFileSync(join(dir, "dirty.txt"), "uncommitted\n");
    process.chdir(dir);
    const cwdBefore = process.cwd();
    assert.throws(() => mergeSliceToMain(dir, "M001", "S01"));
    assert.equal(process.cwd(), cwdBefore, "cwd must be restored on failure");
  });
});
describe("resquashMilestoneOnMain", () => {
  let dir;
  let originalCwd;
  beforeEach(() => {
    dir = createRepo();
    originalCwd = process.cwd();
  });
  afterEach(() => {
    try {
      process.chdir(originalCwd);
    } catch {
    }
    rmSync(dir, { recursive: true, force: true });
  });
  test("collapses N slice commits on main into one milestone commit", () => {
    const startSha = git(["rev-parse", "main"], dir);
    enterMilestoneBranch(dir, "M001");
    commitFile(dir, "a.txt", "slice 1\n", "feat: S01");
    process.chdir(dir);
    mergeSliceToMain(dir, "M001", "S01");
    git(["checkout", "milestone/M001"], dir);
    commitFile(dir, "b.txt", "slice 2\n", "feat: S02");
    mergeSliceToMain(dir, "M001", "S02");
    const beforeCount = parseInt(git(["rev-list", "--count", `${startSha}..main`], dir), 10);
    assert.equal(beforeCount, 2);
    const result = resquashMilestoneOnMain(dir, "M001", startSha);
    assert.equal(result.resquashed, true);
    assert.ok(result.newSha);
    git(["checkout", "main"], dir);
    const afterCount = parseInt(git(["rev-list", "--count", `${startSha}..main`], dir), 10);
    assert.equal(afterCount, 1, "slice commits collapsed into one milestone commit");
    const msg = git(["log", "-1", "--format=%s", "main"], dir);
    assert.ok(msg.includes("M001") && msg.includes("2 slices"), `commit message should describe the resquash; got: ${msg}`);
    assert.equal(readFileSync(join(dir, "a.txt"), "utf-8"), "slice 1\n");
    assert.equal(readFileSync(join(dir, "b.txt"), "utf-8"), "slice 2\n");
    const summary = summarizeWorktreeTelemetry(dir);
    assert.equal(summary.milestoneResquashes, 1);
  });
  test("no-op when startSha equals HEAD", () => {
    const startSha = git(["rev-parse", "main"], dir);
    process.chdir(dir);
    const result = resquashMilestoneOnMain(dir, "M001", startSha);
    assert.equal(result.resquashed, false);
    assert.equal(result.newSha, null);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9zbGljZS1jYWRlbmNlLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFByb2plY3QvQXBwOiBHU0QtMlxuLy8gRmlsZSBQdXJwb3NlOiBTbGljZS1jYWRlbmNlIG1lcmdlIGFuZCByZXNxdWFzaCB0ZXN0cy5cbi8qKlxuICogVGVzdHMgZm9yIHNsaWNlLWNhZGVuY2UgY29sbGFwc2UgXHUyMDE0ICM0NzY1LlxuICpcbiAqIENvdmVycyBtZXJnZVNsaWNlVG9NYWluIChzcXVhc2ggKyBhZHZhbmNlKSwgcmVzcXVhc2hNaWxlc3RvbmVPbk1haW4sXG4gKiBhbmQgdGhlIHByZWZlcmVuY2UgYWNjZXNzb3JzLlxuICovXG5cbmltcG9ydCB7IGRlc2NyaWJlLCB0ZXN0LCBiZWZvcmVFYWNoLCBhZnRlckVhY2ggfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBta2RpclN5bmMsIHdyaXRlRmlsZVN5bmMsIHJtU3luYywgcmVhbHBhdGhTeW5jLCByZWFkRmlsZVN5bmMsIGV4aXN0c1N5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBleGVjRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5cbmltcG9ydCB7XG4gIG1lcmdlU2xpY2VUb01haW4sXG4gIHJlc3F1YXNoTWlsZXN0b25lT25NYWluLFxuICBnZXRDb2xsYXBzZUNhZGVuY2UsXG4gIGdldE1pbGVzdG9uZVJlc3F1YXNoLFxufSBmcm9tIFwiLi4vc2xpY2UtY2FkZW5jZS50c1wiO1xuaW1wb3J0IHsgTWVyZ2VDb25mbGljdEVycm9yIH0gZnJvbSBcIi4uL2dpdC1zZXJ2aWNlLnRzXCI7XG5pbXBvcnQgeyBzdW1tYXJpemVXb3JrdHJlZVRlbGVtZXRyeSB9IGZyb20gXCIuLi93b3JrdHJlZS10ZWxlbWV0cnkudHNcIjtcbmltcG9ydCB7IGNsb3NlRGF0YWJhc2UsIGluc2VydE1pbGVzdG9uZSwgaW5zZXJ0U2xpY2UsIG9wZW5EYXRhYmFzZSB9IGZyb20gXCIuLi9nc2QtZGIudHNcIjtcblxuZnVuY3Rpb24gZ2l0KGFyZ3M6IHN0cmluZ1tdLCBjd2Q6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBleGVjRmlsZVN5bmMoXCJnaXRcIiwgYXJncywgeyBjd2QsIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwicGlwZVwiXSwgZW5jb2Rpbmc6IFwidXRmLThcIiB9KS50cmltKCk7XG59XG5cbi8qKiBDcmVhdGUgYSB0ZW1wIGdpdCByZXBvIHdpdGggYW4gaW5pdGlhbCBjb21taXQgb24gbWFpbi4gKi9cbmZ1bmN0aW9uIGNyZWF0ZVJlcG8oKTogc3RyaW5nIHtcbiAgY29uc3QgZGlyID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwic2xpY2UtY2FkLXRlc3QtXCIpKSk7XG4gIGdpdChbXCJpbml0XCJdLCBkaXIpO1xuICBnaXQoW1wiY29uZmlnXCIsIFwidXNlci5lbWFpbFwiLCBcInRlc3RAdGVzdC5jb21cIl0sIGRpcik7XG4gIGdpdChbXCJjb25maWdcIiwgXCJ1c2VyLm5hbWVcIiwgXCJUZXN0XCJdLCBkaXIpO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcIlJFQURNRS5tZFwiKSwgXCIjIHRlc3RcXG5cIik7XG4gIGdpdChbXCJhZGRcIiwgXCIuXCJdLCBkaXIpO1xuICBnaXQoW1wiY29tbWl0XCIsIFwiLW1cIiwgXCJpbml0XCJdLCBkaXIpO1xuICBnaXQoW1wiYnJhbmNoXCIsIFwiLU1cIiwgXCJtYWluXCJdLCBkaXIpO1xuICBta2RpclN5bmMoam9pbihkaXIsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHJldHVybiBkaXI7XG59XG5cbmZ1bmN0aW9uIGVudGVyTWlsZXN0b25lQnJhbmNoKGRpcjogc3RyaW5nLCBtaWxlc3RvbmVJZDogc3RyaW5nKTogdm9pZCB7XG4gIGdpdChbXCJjaGVja291dFwiLCBcIi1iXCIsIGBtaWxlc3RvbmUvJHttaWxlc3RvbmVJZH1gXSwgZGlyKTtcbn1cblxuZnVuY3Rpb24gY29tbWl0RmlsZShkaXI6IHN0cmluZywgZmlsZTogc3RyaW5nLCBjb250ZW50OiBzdHJpbmcsIG1zZzogc3RyaW5nKTogc3RyaW5nIHtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgZmlsZSksIGNvbnRlbnQpO1xuICBnaXQoW1wiYWRkXCIsIFwiLlwiXSwgZGlyKTtcbiAgZ2l0KFtcImNvbW1pdFwiLCBcIi1tXCIsIG1zZ10sIGRpcik7XG4gIHJldHVybiBnaXQoW1wicmV2LXBhcnNlXCIsIFwiSEVBRFwiXSwgZGlyKTtcbn1cblxuZGVzY3JpYmUoXCJnZXRDb2xsYXBzZUNhZGVuY2UgLyBnZXRNaWxlc3RvbmVSZXNxdWFzaFwiLCAoKSA9PiB7XG4gIHRlc3QoXCJkZWZhdWx0cyB0byBtaWxlc3RvbmUgY2FkZW5jZVwiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKGdldENvbGxhcHNlQ2FkZW5jZSh1bmRlZmluZWQpLCBcIm1pbGVzdG9uZVwiKTtcbiAgICBhc3NlcnQuZXF1YWwoZ2V0Q29sbGFwc2VDYWRlbmNlKG51bGwpLCBcIm1pbGVzdG9uZVwiKTtcbiAgICBhc3NlcnQuZXF1YWwoZ2V0Q29sbGFwc2VDYWRlbmNlKHt9KSwgXCJtaWxlc3RvbmVcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGdldENvbGxhcHNlQ2FkZW5jZSh7IGdpdDoge30gfSksIFwibWlsZXN0b25lXCIpO1xuICB9KTtcbiAgdGVzdChcInJlYWRzIHNsaWNlIGNhZGVuY2Ugd2hlbiBzZXRcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChnZXRDb2xsYXBzZUNhZGVuY2UoeyBnaXQ6IHsgY29sbGFwc2VfY2FkZW5jZTogXCJzbGljZVwiIH0gfSksIFwic2xpY2VcIik7XG4gIH0pO1xuICB0ZXN0KFwibWlsZXN0b25lX3Jlc3F1YXNoIGRlZmF1bHRzIHRvIHRydWUgd2hlbiBub3Qgc2V0XCIsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoZ2V0TWlsZXN0b25lUmVzcXVhc2godW5kZWZpbmVkKSwgdHJ1ZSk7XG4gICAgYXNzZXJ0LmVxdWFsKGdldE1pbGVzdG9uZVJlc3F1YXNoKHsgZ2l0OiB7fSB9KSwgdHJ1ZSk7XG4gICAgYXNzZXJ0LmVxdWFsKGdldE1pbGVzdG9uZVJlc3F1YXNoKHsgZ2l0OiB7IG1pbGVzdG9uZV9yZXNxdWFzaDogdHJ1ZSB9IH0pLCB0cnVlKTtcbiAgfSk7XG4gIHRlc3QoXCJtaWxlc3RvbmVfcmVzcXVhc2ggY2FuIGJlIGRpc2FibGVkIGV4cGxpY2l0bHlcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChnZXRNaWxlc3RvbmVSZXNxdWFzaCh7IGdpdDogeyBtaWxlc3RvbmVfcmVzcXVhc2g6IGZhbHNlIH0gfSksIGZhbHNlKTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoXCJtZXJnZVNsaWNlVG9NYWluXCIsICgpID0+IHtcbiAgbGV0IGRpcjogc3RyaW5nO1xuICBsZXQgb3JpZ2luYWxDd2Q6IHN0cmluZztcblxuICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICBkaXIgPSBjcmVhdGVSZXBvKCk7XG4gICAgb3JpZ2luYWxDd2QgPSBwcm9jZXNzLmN3ZCgpO1xuICB9KTtcblxuICBhZnRlckVhY2goKCkgPT4ge1xuICAgIHRyeSB7IHByb2Nlc3MuY2hkaXIob3JpZ2luYWxDd2QpOyB9IGNhdGNoIHsgLyogKi8gfVxuICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICBybVN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJzcXVhc2hlcyBvbmUgc2xpY2UncyBjb21taXRzIG9udG8gbWFpbiBhbmQgYWR2YW5jZXMgdGhlIG1pbGVzdG9uZSBicmFuY2hcIiwgKCkgPT4ge1xuICAgIGVudGVyTWlsZXN0b25lQnJhbmNoKGRpciwgXCJNMDAxXCIpO1xuICAgIGNvbW1pdEZpbGUoZGlyLCBcImZlYXR1cmUudHh0XCIsIFwic2xpY2UgMSB3b3JrXFxuXCIsIFwiZmVhdDogUzAxIHdvcmtcIik7XG5cbiAgICBwcm9jZXNzLmNoZGlyKGRpcik7XG4gICAgY29uc3QgcmVzdWx0ID0gbWVyZ2VTbGljZVRvTWFpbihkaXIsIFwiTTAwMVwiLCBcIlMwMVwiKTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc2tpcHBlZCwgZmFsc2UpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuY29tbWl0U2hhLCBcImV4cGVjdGVkIGEgY29tbWl0IFNIQVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm1pbGVzdG9uZUJyYW5jaCwgXCJtaWxlc3RvbmUvTTAwMVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm1haW5CcmFuY2gsIFwibWFpblwiKTtcblxuICAgIGNvbnN0IG1haW5Mb2cgPSBnaXQoW1wibG9nXCIsIFwibWFpblwiLCBcIi0tb25lbGluZVwiXSwgZGlyKTtcbiAgICBhc3NlcnQub2sobWFpbkxvZy5pbmNsdWRlcyhcIlMwMSBvZiBNMDAxIChzbGljZS1jYWRlbmNlKVwiKSwgYG1haW4gbG9nOiAke21haW5Mb2d9YCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlYWRGaWxlU3luYyhqb2luKGRpciwgXCJmZWF0dXJlLnR4dFwiKSwgXCJ1dGYtOFwiKSwgXCJzbGljZSAxIHdvcmtcXG5cIik7XG5cbiAgICBjb25zdCBtYWluU2hhID0gZ2l0KFtcInJldi1wYXJzZVwiLCBcIm1haW5cIl0sIGRpcik7XG4gICAgY29uc3QgbWlsZXN0b25lU2hhID0gZ2l0KFtcInJldi1wYXJzZVwiLCBcIm1pbGVzdG9uZS9NMDAxXCJdLCBkaXIpO1xuICAgIGFzc2VydC5lcXVhbChtaWxlc3RvbmVTaGEsIG1haW5TaGEsIFwibWlsZXN0b25lIGJyYW5jaCBtdXN0IGJlIGFkdmFuY2VkIHRvIG1haW5cIik7XG5cbiAgICBjb25zdCBzdW1tYXJ5ID0gc3VtbWFyaXplV29ya3RyZWVUZWxlbWV0cnkoZGlyKTtcbiAgICBhc3NlcnQuZXF1YWwoc3VtbWFyeS5zbGljZXNNZXJnZWQsIDEpO1xuICAgIGFzc2VydC5lcXVhbChzdW1tYXJ5LnNsaWNlTWVyZ2VDb25mbGljdHMsIDApO1xuICB9KTtcblxuICB0ZXN0KFwic2xpY2UtY2FkZW5jZSBjb21taXQgbWVzc2FnZXMgaW5jbHVkZSBtaWxlc3RvbmUgYW5kIHNsaWNlIG5hbWVzXCIsICgpID0+IHtcbiAgICBvcGVuRGF0YWJhc2UoXCI6bWVtb3J5OlwiKTtcbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIk0wMDE6IEJhY2tlbmQgZm91bmRhdGlvblwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSk7XG4gICAgaW5zZXJ0U2xpY2UoeyBpZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJTMDE6IENvcmUgQVBJXCIsIHN0YXR1czogXCJjb21wbGV0ZVwiIH0pO1xuICAgIGVudGVyTWlsZXN0b25lQnJhbmNoKGRpciwgXCJNMDAxXCIpO1xuICAgIGNvbW1pdEZpbGUoZGlyLCBcImZlYXR1cmUudHh0XCIsIFwic2xpY2UgMSB3b3JrXFxuXCIsIFwiZmVhdDogUzAxIHdvcmtcIik7XG5cbiAgICBwcm9jZXNzLmNoZGlyKGRpcik7XG4gICAgbWVyZ2VTbGljZVRvTWFpbihkaXIsIFwiTTAwMVwiLCBcIlMwMVwiKTtcblxuICAgIGNvbnN0IHN1YmplY3QgPSBnaXQoW1wibG9nXCIsIFwiLTFcIiwgXCItLWZvcm1hdD0lc1wiLCBcIm1haW5cIl0sIGRpcik7XG4gICAgY29uc3QgYm9keSA9IGdpdChbXCJsb2dcIiwgXCItMVwiLCBcIi0tZm9ybWF0PSVCXCIsIFwibWFpblwiXSwgZGlyKTtcbiAgICBhc3NlcnQuZXF1YWwoc3ViamVjdCwgXCJmZWF0OiBDb3JlIEFQSSAtIFMwMSBvZiBNMDAxIChzbGljZS1jYWRlbmNlKVwiKTtcbiAgICBhc3NlcnQub2soYm9keS5pbmNsdWRlcyhcIlNsaWNlOiBTMDEgLSBDb3JlIEFQSVwiKSk7XG4gICAgYXNzZXJ0Lm9rKGJvZHkuaW5jbHVkZXMoXCJNaWxlc3RvbmU6IE0wMDEgLSBCYWNrZW5kIGZvdW5kYXRpb25cIikpO1xuICAgIGFzc2VydC5vayhib2R5LmluY2x1ZGVzKFwiR1NELVNsaWNlOiBTMDFcIikpO1xuICAgIGFzc2VydC5vayhib2R5LmluY2x1ZGVzKFwiR1NELU1pbGVzdG9uZTogTTAwMVwiKSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJtZXJnZXMgc2xpY2VzIHRvIHRoZSByZWNvcmRlZCBpbnRlZ3JhdGlvbiBicmFuY2hcIiwgKCkgPT4ge1xuICAgIGdpdChbXCJjaGVja291dFwiLCBcIi1iXCIsIFwiZGV2ZWxvcFwiXSwgZGlyKTtcbiAgICBta2RpclN5bmMoam9pbihkaXIsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihkaXIsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwiTTAwMS1NRVRBLmpzb25cIiksXG4gICAgICBKU09OLnN0cmluZ2lmeSh7IGludGVncmF0aW9uQnJhbmNoOiBcImRldmVsb3BcIiB9LCBudWxsLCAyKSArIFwiXFxuXCIsXG4gICAgKTtcblxuICAgIGVudGVyTWlsZXN0b25lQnJhbmNoKGRpciwgXCJNMDAxXCIpO1xuICAgIGNvbW1pdEZpbGUoZGlyLCBcImRldmVsb3Atb25seS50eHRcIiwgXCJzbGljZSAxIHdvcmtcXG5cIiwgXCJmZWF0OiBTMDEgd29ya1wiKTtcblxuICAgIHByb2Nlc3MuY2hkaXIoZGlyKTtcbiAgICBjb25zdCByZXN1bHQgPSBtZXJnZVNsaWNlVG9NYWluKGRpciwgXCJNMDAxXCIsIFwiUzAxXCIpO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5tYWluQnJhbmNoLCBcImRldmVsb3BcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlYWRGaWxlU3luYyhqb2luKGRpciwgXCJkZXZlbG9wLW9ubHkudHh0XCIpLCBcInV0Zi04XCIpLCBcInNsaWNlIDEgd29ya1xcblwiKTtcbiAgICBhc3NlcnQuZXF1YWwoZ2l0KFtcInJldi1wYXJzZVwiLCBcImRldmVsb3BcIl0sIGRpciksIGdpdChbXCJyZXYtcGFyc2VcIiwgXCJtaWxlc3RvbmUvTTAwMVwiXSwgZGlyKSk7XG4gICAgYXNzZXJ0Lm5vdEVxdWFsKGdpdChbXCJyZXYtcGFyc2VcIiwgXCJkZXZlbG9wXCJdLCBkaXIpLCBnaXQoW1wicmV2LXBhcnNlXCIsIFwibWFpblwiXSwgZGlyKSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJhZHZhbmNlcyBtaWxlc3RvbmUgYnJhbmNoIHdoZW4gaXQgaXMgY2hlY2tlZCBvdXQgaW4gYSB3b3JrdHJlZVwiLCAoKSA9PiB7XG4gICAgY29tbWl0RmlsZShkaXIsIFwiLmdpdGlnbm9yZVwiLCBcIi5nc2Qvd29ya3RyZWVzL1xcblwiLCBcImNob3JlOiBpZ25vcmUgd29ya3RyZWVzXCIpO1xuICAgIGNvbnN0IHd0UGF0aCA9IGpvaW4oZGlyLCBcIi5nc2RcIiwgXCJ3b3JrdHJlZXNcIiwgXCJNMDAxXCIpO1xuICAgIG1rZGlyU3luYyhqb2luKGRpciwgXCIuZ3NkXCIsIFwid29ya3RyZWVzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBnaXQoW1wid29ya3RyZWVcIiwgXCJhZGRcIiwgXCItYlwiLCBcIm1pbGVzdG9uZS9NMDAxXCIsIHd0UGF0aCwgXCJtYWluXCJdLCBkaXIpO1xuICAgIGNvbW1pdEZpbGUod3RQYXRoLCBcIndvcmt0cmVlLXNsaWNlLnR4dFwiLCBcInNsaWNlIHdvcmtcXG5cIiwgXCJmZWF0OiBTMDEgd29ya3RyZWVcIik7XG5cbiAgICBwcm9jZXNzLmNoZGlyKHd0UGF0aCk7XG4gICAgY29uc3QgcmVzdWx0ID0gbWVyZ2VTbGljZVRvTWFpbihkaXIsIFwiTTAwMVwiLCBcIlMwMVwiKTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc2tpcHBlZCwgZmFsc2UpO1xuICAgIGFzc2VydC5lcXVhbChnaXQoW1wicmV2LXBhcnNlXCIsIFwibWFpblwiXSwgZGlyKSwgZ2l0KFtcInJldi1wYXJzZVwiLCBcIm1pbGVzdG9uZS9NMDAxXCJdLCBkaXIpKTtcbiAgICBhc3NlcnQuZXF1YWwoZ2l0KFtcImJyYW5jaFwiLCBcIi0tc2hvdy1jdXJyZW50XCJdLCB3dFBhdGgpLCBcIm1pbGVzdG9uZS9NMDAxXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZWFkRmlsZVN5bmMoam9pbih3dFBhdGgsIFwid29ya3RyZWUtc2xpY2UudHh0XCIpLCBcInV0Zi04XCIpLCBcInNsaWNlIHdvcmtcXG5cIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJoYW5kbGVzIHNlcXVlbnRpYWwgc2xpY2UgbWVyZ2VzIGNsZWFubHlcIiwgKCkgPT4ge1xuICAgIGVudGVyTWlsZXN0b25lQnJhbmNoKGRpciwgXCJNMDAxXCIpO1xuICAgIGNvbW1pdEZpbGUoZGlyLCBcImEudHh0XCIsIFwic2xpY2UgMVxcblwiLCBcImZlYXQ6IFMwMVwiKTtcblxuICAgIHByb2Nlc3MuY2hkaXIoZGlyKTtcbiAgICBtZXJnZVNsaWNlVG9NYWluKGRpciwgXCJNMDAxXCIsIFwiUzAxXCIpO1xuXG4gICAgZ2l0KFtcImNoZWNrb3V0XCIsIFwibWlsZXN0b25lL00wMDFcIl0sIGRpcik7XG4gICAgY29tbWl0RmlsZShkaXIsIFwiYi50eHRcIiwgXCJzbGljZSAyXFxuXCIsIFwiZmVhdDogUzAyXCIpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gbWVyZ2VTbGljZVRvTWFpbihkaXIsIFwiTTAwMVwiLCBcIlMwMlwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnNraXBwZWQsIGZhbHNlKTtcblxuICAgIGNvbnN0IG1haW5Mb2cgPSBnaXQoW1wibG9nXCIsIFwibWFpblwiLCBcIi0tb25lbGluZVwiXSwgZGlyKTtcbiAgICBhc3NlcnQub2sobWFpbkxvZy5pbmNsdWRlcyhcIlMwMSBvZiBNMDAxXCIpKTtcbiAgICBhc3NlcnQub2sobWFpbkxvZy5pbmNsdWRlcyhcIlMwMiBvZiBNMDAxXCIpKTtcblxuICAgIGFzc2VydC5lcXVhbChyZWFkRmlsZVN5bmMoam9pbihkaXIsIFwiYS50eHRcIiksIFwidXRmLThcIiksIFwic2xpY2UgMVxcblwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVhZEZpbGVTeW5jKGpvaW4oZGlyLCBcImIudHh0XCIpLCBcInV0Zi04XCIpLCBcInNsaWNlIDJcXG5cIik7XG5cbiAgICBjb25zdCBzdW1tYXJ5ID0gc3VtbWFyaXplV29ya3RyZWVUZWxlbWV0cnkoZGlyKTtcbiAgICBhc3NlcnQuZXF1YWwoc3VtbWFyeS5zbGljZXNNZXJnZWQsIDIpO1xuICB9KTtcblxuICB0ZXN0KFwicmV0dXJucyBza2lwcGVkIHdoZW4gbWlsZXN0b25lIGJyYW5jaCBoYXMgbm8gY29tbWl0cyBhaGVhZCBvZiBtYWluXCIsICgpID0+IHtcbiAgICBlbnRlck1pbGVzdG9uZUJyYW5jaChkaXIsIFwiTTAwMVwiKTtcblxuICAgIHByb2Nlc3MuY2hkaXIoZGlyKTtcbiAgICBjb25zdCByZXN1bHQgPSBtZXJnZVNsaWNlVG9NYWluKGRpciwgXCJNMDAxXCIsIFwiUzAxXCIpO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5za2lwcGVkLCB0cnVlKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnNraXBwZWRSZWFzb24sIFwibm8tY29tbWl0cy1haGVhZFwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmNvbW1pdFNoYSwgbnVsbCk7XG4gIH0pO1xuXG4gIHRlc3QoXCJ0aHJvd3MgTWVyZ2VDb25mbGljdEVycm9yIG9uIGEgcmVhbCBjb25mbGljdCBhbmQgbGVhdmVzIG5vIG1lcmdlIGFydGlmYWN0c1wiLCAoKSA9PiB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJzaGFyZWQudHh0XCIpLCBcIm1haW4gdmVyc2lvblxcblwiKTtcbiAgICBnaXQoW1wiYWRkXCIsIFwiLlwiXSwgZGlyKTtcbiAgICBnaXQoW1wiY29tbWl0XCIsIFwiLW1cIiwgXCJtYWluLXNlZWRcIl0sIGRpcik7XG5cbiAgICBlbnRlck1pbGVzdG9uZUJyYW5jaChkaXIsIFwiTTAwMVwiKTtcbiAgICBjb21taXRGaWxlKGRpciwgXCJzaGFyZWQudHh0XCIsIFwic2xpY2UgdmVyc2lvblxcblwiLCBcImZlYXQ6IFMwMSBjb25mbGljdGluZ1wiKTtcblxuICAgIGdpdChbXCJjaGVja291dFwiLCBcIm1haW5cIl0sIGRpcik7XG4gICAgY29tbWl0RmlsZShkaXIsIFwic2hhcmVkLnR4dFwiLCBcIm1haW4gZXZvbHZlZFxcblwiLCBcIm1haW4gZXZvbHZlZFwiKTtcbiAgICBnaXQoW1wiY2hlY2tvdXRcIiwgXCJtaWxlc3RvbmUvTTAwMVwiXSwgZGlyKTtcblxuICAgIHByb2Nlc3MuY2hkaXIoZGlyKTtcbiAgICBhc3NlcnQudGhyb3dzKFxuICAgICAgKCkgPT4gbWVyZ2VTbGljZVRvTWFpbihkaXIsIFwiTTAwMVwiLCBcIlMwMVwiKSxcbiAgICAgIChlcnI6IHVua25vd24pID0+IGVyciBpbnN0YW5jZW9mIE1lcmdlQ29uZmxpY3RFcnJvcixcbiAgICApO1xuXG4gICAgY29uc3QgZ2l0RGlyID0gam9pbihkaXIsIFwiLmdpdFwiKTtcbiAgICBmb3IgKGNvbnN0IGYgb2YgW1wiU1FVQVNIX01TR1wiLCBcIk1FUkdFX01TR1wiLCBcIk1FUkdFX0hFQURcIl0pIHtcbiAgICAgIGFzc2VydC5vayghZXhpc3RzU3luYyhqb2luKGdpdERpciwgZikpLCBgJHtmfSBzaG91bGQgYmUgY2xlYW5lZCB1cGApO1xuICAgIH1cblxuICAgIGNvbnN0IHN1bW1hcnkgPSBzdW1tYXJpemVXb3JrdHJlZVRlbGVtZXRyeShkaXIpO1xuICAgIGFzc2VydC5lcXVhbChzdW1tYXJ5LnNsaWNlTWVyZ2VDb25mbGljdHMsIDEpO1xuICB9KTtcblxuICB0ZXN0KFwicmVzdG9yZXMgY3dkIGV2ZW4gd2hlbiBtZXJnZSBmYWlscyAoZGlydHkgd29ya2luZyB0cmVlKVwiLCAoKSA9PiB7XG4gICAgZW50ZXJNaWxlc3RvbmVCcmFuY2goZGlyLCBcIk0wMDFcIik7XG4gICAgY29tbWl0RmlsZShkaXIsIFwiZmVhdHVyZS50eHRcIiwgXCJzbGljZSAxXFxuXCIsIFwiZmVhdDogUzAxXCIpO1xuICAgIC8vIEludHJvZHVjZSBhbiB1bnRyYWNrZWQgZmlsZSBBRlRFUiB0aGUgc2xpY2UgY29tbWl0IHNvIGl0J3Mgc3RpbGxcbiAgICAvLyBwcmVzZW50IHdoZW4gbWVyZ2VTbGljZVRvTWFpbiBydW5zIGl0cyBzdGF0dXMgY2hlY2suXG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJkaXJ0eS50eHRcIiksIFwidW5jb21taXR0ZWRcXG5cIik7XG5cbiAgICBwcm9jZXNzLmNoZGlyKGRpcik7XG4gICAgY29uc3QgY3dkQmVmb3JlID0gcHJvY2Vzcy5jd2QoKTtcbiAgICBhc3NlcnQudGhyb3dzKCgpID0+IG1lcmdlU2xpY2VUb01haW4oZGlyLCBcIk0wMDFcIiwgXCJTMDFcIikpO1xuICAgIGFzc2VydC5lcXVhbChwcm9jZXNzLmN3ZCgpLCBjd2RCZWZvcmUsIFwiY3dkIG11c3QgYmUgcmVzdG9yZWQgb24gZmFpbHVyZVwiKTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoXCJyZXNxdWFzaE1pbGVzdG9uZU9uTWFpblwiLCAoKSA9PiB7XG4gIGxldCBkaXI6IHN0cmluZztcbiAgbGV0IG9yaWdpbmFsQ3dkOiBzdHJpbmc7XG5cbiAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgZGlyID0gY3JlYXRlUmVwbygpO1xuICAgIG9yaWdpbmFsQ3dkID0gcHJvY2Vzcy5jd2QoKTtcbiAgfSk7XG5cbiAgYWZ0ZXJFYWNoKCgpID0+IHtcbiAgICB0cnkgeyBwcm9jZXNzLmNoZGlyKG9yaWdpbmFsQ3dkKTsgfSBjYXRjaCB7IC8qICovIH1cbiAgICBybVN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJjb2xsYXBzZXMgTiBzbGljZSBjb21taXRzIG9uIG1haW4gaW50byBvbmUgbWlsZXN0b25lIGNvbW1pdFwiLCAoKSA9PiB7XG4gICAgY29uc3Qgc3RhcnRTaGEgPSBnaXQoW1wicmV2LXBhcnNlXCIsIFwibWFpblwiXSwgZGlyKTtcblxuICAgIGVudGVyTWlsZXN0b25lQnJhbmNoKGRpciwgXCJNMDAxXCIpO1xuICAgIGNvbW1pdEZpbGUoZGlyLCBcImEudHh0XCIsIFwic2xpY2UgMVxcblwiLCBcImZlYXQ6IFMwMVwiKTtcbiAgICBwcm9jZXNzLmNoZGlyKGRpcik7XG4gICAgbWVyZ2VTbGljZVRvTWFpbihkaXIsIFwiTTAwMVwiLCBcIlMwMVwiKTtcblxuICAgIGdpdChbXCJjaGVja291dFwiLCBcIm1pbGVzdG9uZS9NMDAxXCJdLCBkaXIpO1xuICAgIGNvbW1pdEZpbGUoZGlyLCBcImIudHh0XCIsIFwic2xpY2UgMlxcblwiLCBcImZlYXQ6IFMwMlwiKTtcbiAgICBtZXJnZVNsaWNlVG9NYWluKGRpciwgXCJNMDAxXCIsIFwiUzAyXCIpO1xuXG4gICAgY29uc3QgYmVmb3JlQ291bnQgPSBwYXJzZUludChnaXQoW1wicmV2LWxpc3RcIiwgXCItLWNvdW50XCIsIGAke3N0YXJ0U2hhfS4ubWFpbmBdLCBkaXIpLCAxMCk7XG4gICAgYXNzZXJ0LmVxdWFsKGJlZm9yZUNvdW50LCAyKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IHJlc3F1YXNoTWlsZXN0b25lT25NYWluKGRpciwgXCJNMDAxXCIsIHN0YXJ0U2hhKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnJlc3F1YXNoZWQsIHRydWUpO1xuICAgIGFzc2VydC5vayhyZXN1bHQubmV3U2hhKTtcblxuICAgIGdpdChbXCJjaGVja291dFwiLCBcIm1haW5cIl0sIGRpcik7XG4gICAgY29uc3QgYWZ0ZXJDb3VudCA9IHBhcnNlSW50KGdpdChbXCJyZXYtbGlzdFwiLCBcIi0tY291bnRcIiwgYCR7c3RhcnRTaGF9Li5tYWluYF0sIGRpciksIDEwKTtcbiAgICBhc3NlcnQuZXF1YWwoYWZ0ZXJDb3VudCwgMSwgXCJzbGljZSBjb21taXRzIGNvbGxhcHNlZCBpbnRvIG9uZSBtaWxlc3RvbmUgY29tbWl0XCIpO1xuXG4gICAgY29uc3QgbXNnID0gZ2l0KFtcImxvZ1wiLCBcIi0xXCIsIFwiLS1mb3JtYXQ9JXNcIiwgXCJtYWluXCJdLCBkaXIpO1xuICAgIGFzc2VydC5vayhtc2cuaW5jbHVkZXMoXCJNMDAxXCIpICYmIG1zZy5pbmNsdWRlcyhcIjIgc2xpY2VzXCIpLCBgY29tbWl0IG1lc3NhZ2Ugc2hvdWxkIGRlc2NyaWJlIHRoZSByZXNxdWFzaDsgZ290OiAke21zZ31gKTtcblxuICAgIGFzc2VydC5lcXVhbChyZWFkRmlsZVN5bmMoam9pbihkaXIsIFwiYS50eHRcIiksIFwidXRmLThcIiksIFwic2xpY2UgMVxcblwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVhZEZpbGVTeW5jKGpvaW4oZGlyLCBcImIudHh0XCIpLCBcInV0Zi04XCIpLCBcInNsaWNlIDJcXG5cIik7XG5cbiAgICBjb25zdCBzdW1tYXJ5ID0gc3VtbWFyaXplV29ya3RyZWVUZWxlbWV0cnkoZGlyKTtcbiAgICBhc3NlcnQuZXF1YWwoc3VtbWFyeS5taWxlc3RvbmVSZXNxdWFzaGVzLCAxKTtcbiAgfSk7XG5cbiAgdGVzdChcIm5vLW9wIHdoZW4gc3RhcnRTaGEgZXF1YWxzIEhFQURcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHN0YXJ0U2hhID0gZ2l0KFtcInJldi1wYXJzZVwiLCBcIm1haW5cIl0sIGRpcik7XG4gICAgcHJvY2Vzcy5jaGRpcihkaXIpO1xuICAgIGNvbnN0IHJlc3VsdCA9IHJlc3F1YXNoTWlsZXN0b25lT25NYWluKGRpciwgXCJNMDAxXCIsIHN0YXJ0U2hhKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnJlc3F1YXNoZWQsIGZhbHNlKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm5ld1NoYSwgbnVsbCk7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFTQSxTQUFTLFVBQVUsTUFBTSxZQUFZLGlCQUFpQjtBQUN0RCxPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhLFdBQVcsZUFBZSxRQUFRLGNBQWMsY0FBYyxrQkFBa0I7QUFDdEcsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUN2QixTQUFTLG9CQUFvQjtBQUU3QjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1AsU0FBUywwQkFBMEI7QUFDbkMsU0FBUyxrQ0FBa0M7QUFDM0MsU0FBUyxlQUFlLGlCQUFpQixhQUFhLG9CQUFvQjtBQUUxRSxTQUFTLElBQUksTUFBZ0IsS0FBcUI7QUFDaEQsU0FBTyxhQUFhLE9BQU8sTUFBTSxFQUFFLEtBQUssT0FBTyxDQUFDLFVBQVUsUUFBUSxNQUFNLEdBQUcsVUFBVSxRQUFRLENBQUMsRUFBRSxLQUFLO0FBQ3ZHO0FBR0EsU0FBUyxhQUFxQjtBQUM1QixRQUFNLE1BQU0sYUFBYSxZQUFZLEtBQUssT0FBTyxHQUFHLGlCQUFpQixDQUFDLENBQUM7QUFDdkUsTUFBSSxDQUFDLE1BQU0sR0FBRyxHQUFHO0FBQ2pCLE1BQUksQ0FBQyxVQUFVLGNBQWMsZUFBZSxHQUFHLEdBQUc7QUFDbEQsTUFBSSxDQUFDLFVBQVUsYUFBYSxNQUFNLEdBQUcsR0FBRztBQUN4QyxnQkFBYyxLQUFLLEtBQUssV0FBVyxHQUFHLFVBQVU7QUFDaEQsTUFBSSxDQUFDLE9BQU8sR0FBRyxHQUFHLEdBQUc7QUFDckIsTUFBSSxDQUFDLFVBQVUsTUFBTSxNQUFNLEdBQUcsR0FBRztBQUNqQyxNQUFJLENBQUMsVUFBVSxNQUFNLE1BQU0sR0FBRyxHQUFHO0FBQ2pDLFlBQVUsS0FBSyxLQUFLLE1BQU0sR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ2hELFNBQU87QUFDVDtB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
