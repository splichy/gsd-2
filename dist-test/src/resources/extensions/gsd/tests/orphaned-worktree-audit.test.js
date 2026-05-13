import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { auditOrphanedMilestoneBranches } from "../auto-start.js";
import { openDatabase, closeDatabase, insertMilestone } from "../gsd-db.js";
function run(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}
function createRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "orphan-audit-test-")));
  run("git init", dir);
  run("git config user.email test@test.com", dir);
  run("git config user.name Test", dir);
  writeFileSync(join(dir, "README.md"), "# test\n");
  run("git add .", dir);
  run("git commit -m init", dir);
  run("git branch -M main", dir);
  mkdirSync(join(dir, ".gsd", "milestones", "M001"), { recursive: true });
  return dir;
}
describe("auditOrphanedMilestoneBranches", () => {
  let dir;
  beforeEach(() => {
    dir = createRepo();
    openDatabase(join(dir, ".gsd", "gsd.db"));
  });
  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });
  test("no milestone branches \u2192 no-op", () => {
    const result = auditOrphanedMilestoneBranches(dir, "worktree");
    assert.deepStrictEqual(result.recovered, []);
    assert.deepStrictEqual(result.warnings, []);
  });
  test("skips in none isolation mode", () => {
    run("git branch milestone/M001", dir);
    insertMilestone({ id: "M001", title: "Test", status: "complete" });
    const result = auditOrphanedMilestoneBranches(dir, "none");
    assert.deepStrictEqual(result.recovered, []);
    assert.deepStrictEqual(result.warnings, []);
    const branches = run("git branch --list milestone/M001", dir);
    assert.ok(branches.includes("milestone/M001"), "branch should be preserved in none mode");
  });
  test("deletes merged branch for completed milestone", () => {
    run("git branch milestone/M001", dir);
    insertMilestone({ id: "M001", title: "Test", status: "complete" });
    const result = auditOrphanedMilestoneBranches(dir, "worktree");
    assert.ok(result.recovered.length > 0, "should have recovered actions");
    assert.ok(
      result.recovered.some((r) => r.includes("Deleted merged branch milestone/M001")),
      "should report branch deletion"
    );
    assert.deepStrictEqual(result.warnings, []);
    const branches = run("git branch --list milestone/M001", dir);
    assert.deepStrictEqual(branches, "", "branch should be deleted");
  });
  test("warns about unmerged branch for completed milestone", () => {
    run("git checkout -b milestone/M001", dir);
    writeFileSync(join(dir, "feature.txt"), "new feature\n");
    run("git add feature.txt", dir);
    run('git commit -m "add feature on milestone branch"', dir);
    run("git checkout main", dir);
    insertMilestone({ id: "M001", title: "Test", status: "complete" });
    const result = auditOrphanedMilestoneBranches(dir, "worktree");
    assert.deepStrictEqual(result.recovered, [], "should not delete unmerged branch");
    assert.ok(result.warnings.length > 0, "should have warnings");
    assert.ok(
      result.warnings.some((w) => w.includes("NOT merged")),
      "should warn about unmerged branch"
    );
    assert.ok(
      result.warnings.some((w) => w.includes("/gsd doctor fix")),
      `warning should suggest the real remediation command; got: ${JSON.stringify(result.warnings)}`
    );
    assert.ok(
      result.warnings.every((w) => !w.includes("/gsd health --fix")),
      `warning must not suggest the removed health --fix command; got: ${JSON.stringify(result.warnings)}`
    );
    const branches = run("git branch --list milestone/M001", dir);
    assert.ok(branches.includes("milestone/M001"), "unmerged branch must be preserved");
  });
  test("skips active milestone branch with no commits ahead of main (nothing to recover)", () => {
    run("git branch milestone/M001", dir);
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    const result = auditOrphanedMilestoneBranches(dir, "worktree");
    assert.deepStrictEqual(result.recovered, []);
    assert.deepStrictEqual(result.warnings, []);
    const branches = run("git branch --list milestone/M001", dir);
    assert.ok(branches.includes("milestone/M001"), "active milestone branch should be preserved");
  });
  test("#4762 \u2014 warns about in-progress milestone with unmerged commits ahead of main", () => {
    run("git checkout -b milestone/M001", dir);
    writeFileSync(join(dir, "feature.txt"), "in-progress work\n");
    run("git add feature.txt", dir);
    run('git commit -m "in-progress work on M001"', dir);
    run("git checkout main", dir);
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    const result = auditOrphanedMilestoneBranches(dir, "worktree");
    assert.deepStrictEqual(result.recovered, [], "must not delete a branch with live in-progress work");
    assert.ok(result.warnings.length > 0, "should warn about in-progress orphan");
    assert.ok(
      result.warnings.some((w) => w.includes("milestone/M001") && w.includes("in-progress")),
      `warning should mention milestone/M001 and in-progress state; got: ${JSON.stringify(result.warnings)}`
    );
    const branches = run("git branch --list milestone/M001", dir);
    assert.ok(branches.includes("milestone/M001"), "in-progress branch must be preserved");
  });
  test("#4762 \u2014 also surfaces worktree directory for in-progress orphan when present", () => {
    run("git checkout -b milestone/M001", dir);
    writeFileSync(join(dir, "feature.txt"), "in-progress work\n");
    run("git add feature.txt", dir);
    run('git commit -m "in-progress work on M001"', dir);
    run("git checkout main", dir);
    const wtDir = join(dir, ".gsd", "worktrees", "M001");
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(join(wtDir, ".git"), `gitdir: ${join(dir, ".git", "worktrees", "M001")}
`);
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    const result = auditOrphanedMilestoneBranches(dir, "worktree");
    assert.deepStrictEqual(result.recovered, [], "must not touch worktree or branch with live work");
    assert.ok(existsSync(wtDir), "worktree directory must be preserved");
    assert.ok(
      result.warnings.some((w) => w.includes(".gsd/worktrees/M001") || w.includes("worktree")),
      `warning should reference the worktree location; got: ${JSON.stringify(result.warnings)}`
    );
  });
  test("cleans up orphaned worktree directory for merged milestone", () => {
    run("git branch milestone/M001", dir);
    insertMilestone({ id: "M001", title: "Test", status: "complete" });
    const wtDir = join(dir, ".gsd", "worktrees", "M001");
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(join(wtDir, "leftover.txt"), "orphaned file\n");
    const result = auditOrphanedMilestoneBranches(dir, "worktree");
    assert.ok(result.recovered.length > 0, "should have recovered actions");
    assert.ok(
      result.recovered.some((r) => r.includes("worktree directory")),
      "should report worktree cleanup"
    );
    assert.ok(!existsSync(wtDir), "orphaned worktree directory should be removed");
  });
  test("handles multiple milestones with mixed states", () => {
    run("git branch milestone/M001", dir);
    insertMilestone({ id: "M001", title: "First", status: "complete" });
    run("git branch milestone/M002", dir);
    insertMilestone({ id: "M002", title: "Second", status: "active" });
    const result = auditOrphanedMilestoneBranches(dir, "worktree");
    assert.ok(
      result.recovered.some((r) => r.includes("M001")),
      "should clean up completed M001"
    );
    const branches = run("git branch --list milestone/M002", dir);
    assert.ok(branches.includes("milestone/M002"), "active M002 branch should be preserved");
  });
  test("works in branch isolation mode", () => {
    run("git branch milestone/M001", dir);
    insertMilestone({ id: "M001", title: "Test", status: "complete" });
    const result = auditOrphanedMilestoneBranches(dir, "branch");
    assert.ok(result.recovered.length > 0, "should work in branch mode too");
    assert.ok(
      result.recovered.some((r) => r.includes("Deleted merged branch")),
      "should delete branch in branch mode"
    );
  });
  test("milestone in DB, no branch, no worktree dir \u2192 no-op", () => {
    insertMilestone({ id: "M001", title: "Test", status: "complete" });
    const result = auditOrphanedMilestoneBranches(dir, "worktree");
    assert.deepStrictEqual(result.recovered, []);
    assert.deepStrictEqual(result.warnings, []);
  });
  test("#5879 \u2014 cleans orphaned worktree dir for complete milestone whose branch was already deleted", () => {
    insertMilestone({ id: "M001", title: "Test", status: "complete" });
    const wtDir = join(dir, ".gsd", "worktrees", "M001");
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(join(wtDir, "leftover.txt"), "stranded from a prior session\n");
    const branches = run("git branch --list milestone/M001", dir);
    assert.equal(branches, "", "test fixture: branch should not exist");
    const result = auditOrphanedMilestoneBranches(dir, "worktree");
    assert.ok(
      result.recovered.some((r) => r.includes("M001") && r.includes("branch already deleted")),
      `should report branch-less orphan cleanup; got: ${JSON.stringify(result.recovered)}`
    );
    assert.ok(!existsSync(wtDir), "branch-less orphan worktree dir should be removed");
  });
  test("#5879 \u2014 branch list failure still cleans complete orphan only after branch absence is verified", () => {
    insertMilestone({ id: "M001", title: "Test", status: "complete" });
    const wtDir = join(dir, ".gsd", "worktrees", "M001");
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(join(wtDir, "leftover.txt"), "stranded from a prior session\n");
    const result = auditOrphanedMilestoneBranches(dir, "worktree", {
      branchList: () => {
        throw new Error("branch list failed");
      },
      branchExists: (_basePath, branch) => {
        assert.equal(branch, "milestone/M001");
        return false;
      }
    });
    assert.ok(
      result.recovered.some((r) => r.includes("M001") && r.includes("branch already deleted")),
      `should report verified branch-less orphan cleanup; got: ${JSON.stringify(result.recovered)}`
    );
    assert.ok(!existsSync(wtDir), "verified branch-less orphan worktree dir should be removed");
  });
  test("#5879 \u2014 branch list failure preserves complete worktree when branch still exists", () => {
    insertMilestone({ id: "M001", title: "Test", status: "complete" });
    const wtDir = join(dir, ".gsd", "worktrees", "M001");
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(join(wtDir, "live-work.txt"), "do not delete\n");
    const result = auditOrphanedMilestoneBranches(dir, "worktree", {
      branchList: () => {
        throw new Error("branch list failed");
      },
      branchExists: (_basePath, branch) => {
        assert.equal(branch, "milestone/M001");
        return true;
      }
    });
    assert.deepStrictEqual(result.recovered, []);
    assert.ok(existsSync(wtDir), "worktree dir must be preserved when branch existence is verified");
  });
  test("#5879 \u2014 skips branch-less orphan for milestone that is not complete", () => {
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    const wtDir = join(dir, ".gsd", "worktrees", "M001");
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(join(wtDir, "live-work.txt"), "do not delete\n");
    const result = auditOrphanedMilestoneBranches(dir, "worktree");
    assert.deepStrictEqual(result.recovered, []);
    assert.ok(existsSync(wtDir), "active milestone worktree dir must be preserved");
  });
  test("#5879 \u2014 branch list failure does not delete worktree for milestone that is not complete", () => {
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    const wtDir = join(dir, ".gsd", "worktrees", "M001");
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(join(wtDir, "live-work.txt"), "do not delete\n");
    const result = auditOrphanedMilestoneBranches(dir, "worktree", {
      branchList: () => {
        throw new Error("branch list failed");
      },
      branchExists: () => {
        throw new Error("branchExists should not be called for active milestones");
      }
    });
    assert.deepStrictEqual(result.recovered, []);
    assert.ok(existsSync(wtDir), "active milestone worktree dir must be preserved");
  });
  test("#5879 \u2014 skips branch-less orphan in 'none' isolation mode", () => {
    insertMilestone({ id: "M001", title: "Test", status: "complete" });
    const wtDir = join(dir, ".gsd", "worktrees", "M001");
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(join(wtDir, "leftover.txt"), "stranded\n");
    const result = auditOrphanedMilestoneBranches(dir, "none");
    assert.deepStrictEqual(result.recovered, []);
    assert.ok(existsSync(wtDir), "'none' mode must not touch worktree dirs");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9vcnBoYW5lZC13b3JrdHJlZS1hdWRpdC50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBHU0QyIFx1MjAxNCBUZXN0cyBmb3IgYXVkaXRPcnBoYW5lZE1pbGVzdG9uZUJyYW5jaGVzIGJvb3RzdHJhcCBhdWRpdFxuaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QsIGJlZm9yZUVhY2gsIGFmdGVyRWFjaCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgd3JpdGVGaWxlU3luYywgcm1TeW5jLCBleGlzdHNTeW5jLCByZWFscGF0aFN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBleGVjU3luYyB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcblxuaW1wb3J0IHsgYXVkaXRPcnBoYW5lZE1pbGVzdG9uZUJyYW5jaGVzIH0gZnJvbSBcIi4uL2F1dG8tc3RhcnQudHNcIjtcbmltcG9ydCB7IG9wZW5EYXRhYmFzZSwgY2xvc2VEYXRhYmFzZSwgaW5zZXJ0TWlsZXN0b25lLCB1cGRhdGVNaWxlc3RvbmVTdGF0dXMgfSBmcm9tIFwiLi4vZ3NkLWRiLnRzXCI7XG5cbmZ1bmN0aW9uIHJ1bihjbWQ6IHN0cmluZywgY3dkOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gZXhlY1N5bmMoY21kLCB7IGN3ZCwgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdLCBlbmNvZGluZzogXCJ1dGYtOFwiIH0pLnRyaW0oKTtcbn1cblxuLyoqIENyZWF0ZSBhIHRlbXAgZ2l0IHJlcG8gd2l0aCAuZ3NkIHN0cnVjdHVyZSBhbmQgREIuICovXG5mdW5jdGlvbiBjcmVhdGVSZXBvKCk6IHN0cmluZyB7XG4gIGNvbnN0IGRpciA9IHJlYWxwYXRoU3luYyhta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcIm9ycGhhbi1hdWRpdC10ZXN0LVwiKSkpO1xuICBydW4oXCJnaXQgaW5pdFwiLCBkaXIpO1xuICBydW4oXCJnaXQgY29uZmlnIHVzZXIuZW1haWwgdGVzdEB0ZXN0LmNvbVwiLCBkaXIpO1xuICBydW4oXCJnaXQgY29uZmlnIHVzZXIubmFtZSBUZXN0XCIsIGRpcik7XG5cbiAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJSRUFETUUubWRcIiksIFwiIyB0ZXN0XFxuXCIpO1xuICBydW4oXCJnaXQgYWRkIC5cIiwgZGlyKTtcbiAgcnVuKFwiZ2l0IGNvbW1pdCAtbSBpbml0XCIsIGRpcik7XG4gIHJ1bihcImdpdCBicmFuY2ggLU0gbWFpblwiLCBkaXIpO1xuXG4gIC8vIENyZWF0ZSAuZ3NkIHN0cnVjdHVyZSBvbiBkaXNrIChub3QgdHJhY2tlZCBpbiBnaXQpXG4gIG1rZGlyU3luYyhqb2luKGRpciwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gIHJldHVybiBkaXI7XG59XG5cbmRlc2NyaWJlKFwiYXVkaXRPcnBoYW5lZE1pbGVzdG9uZUJyYW5jaGVzXCIsICgpID0+IHtcbiAgbGV0IGRpcjogc3RyaW5nO1xuXG4gIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgIGRpciA9IGNyZWF0ZVJlcG8oKTtcbiAgICBvcGVuRGF0YWJhc2Uoam9pbihkaXIsIFwiLmdzZFwiLCBcImdzZC5kYlwiKSk7XG4gIH0pO1xuXG4gIGFmdGVyRWFjaCgoKSA9PiB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIHJtU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfSk7XG5cbiAgdGVzdChcIm5vIG1pbGVzdG9uZSBicmFuY2hlcyBcdTIxOTIgbm8tb3BcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF1ZGl0T3JwaGFuZWRNaWxlc3RvbmVCcmFuY2hlcyhkaXIsIFwid29ya3RyZWVcIik7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQucmVjb3ZlcmVkLCBbXSk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQud2FybmluZ3MsIFtdKTtcbiAgfSk7XG5cbiAgdGVzdChcInNraXBzIGluIG5vbmUgaXNvbGF0aW9uIG1vZGVcIiwgKCkgPT4ge1xuICAgIC8vIENyZWF0ZSBhIG1pbGVzdG9uZSBicmFuY2ggdGhhdCB3b3VsZCBvdGhlcndpc2UgYmUgZGV0ZWN0ZWRcbiAgICBydW4oXCJnaXQgYnJhbmNoIG1pbGVzdG9uZS9NMDAxXCIsIGRpcik7XG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIsIHN0YXR1czogXCJjb21wbGV0ZVwiIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXVkaXRPcnBoYW5lZE1pbGVzdG9uZUJyYW5jaGVzKGRpciwgXCJub25lXCIpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0LnJlY292ZXJlZCwgW10pO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0Lndhcm5pbmdzLCBbXSk7XG5cbiAgICAvLyBCcmFuY2ggc2hvdWxkIHN0aWxsIGV4aXN0XG4gICAgY29uc3QgYnJhbmNoZXMgPSBydW4oXCJnaXQgYnJhbmNoIC0tbGlzdCBtaWxlc3RvbmUvTTAwMVwiLCBkaXIpO1xuICAgIGFzc2VydC5vayhicmFuY2hlcy5pbmNsdWRlcyhcIm1pbGVzdG9uZS9NMDAxXCIpLCBcImJyYW5jaCBzaG91bGQgYmUgcHJlc2VydmVkIGluIG5vbmUgbW9kZVwiKTtcbiAgfSk7XG5cbiAgdGVzdChcImRlbGV0ZXMgbWVyZ2VkIGJyYW5jaCBmb3IgY29tcGxldGVkIG1pbGVzdG9uZVwiLCAoKSA9PiB7XG4gICAgLy8gQ3JlYXRlIG1pbGVzdG9uZSBicmFuY2ggZnJvbSBtYWluIChzbyBpdCdzIGFscmVhZHkgbWVyZ2VkKVxuICAgIHJ1bihcImdpdCBicmFuY2ggbWlsZXN0b25lL00wMDFcIiwgZGlyKTtcbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImNvbXBsZXRlXCIgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhdWRpdE9ycGhhbmVkTWlsZXN0b25lQnJhbmNoZXMoZGlyLCBcIndvcmt0cmVlXCIpO1xuXG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5yZWNvdmVyZWQubGVuZ3RoID4gMCwgXCJzaG91bGQgaGF2ZSByZWNvdmVyZWQgYWN0aW9uc1wiKTtcbiAgICBhc3NlcnQub2soXG4gICAgICByZXN1bHQucmVjb3ZlcmVkLnNvbWUociA9PiByLmluY2x1ZGVzKFwiRGVsZXRlZCBtZXJnZWQgYnJhbmNoIG1pbGVzdG9uZS9NMDAxXCIpKSxcbiAgICAgIFwic2hvdWxkIHJlcG9ydCBicmFuY2ggZGVsZXRpb25cIixcbiAgICApO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0Lndhcm5pbmdzLCBbXSk7XG5cbiAgICAvLyBCcmFuY2ggc2hvdWxkIGJlIGdvbmVcbiAgICBjb25zdCBicmFuY2hlcyA9IHJ1bihcImdpdCBicmFuY2ggLS1saXN0IG1pbGVzdG9uZS9NMDAxXCIsIGRpcik7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChicmFuY2hlcywgXCJcIiwgXCJicmFuY2ggc2hvdWxkIGJlIGRlbGV0ZWRcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJ3YXJucyBhYm91dCB1bm1lcmdlZCBicmFuY2ggZm9yIGNvbXBsZXRlZCBtaWxlc3RvbmVcIiwgKCkgPT4ge1xuICAgIC8vIENyZWF0ZSBtaWxlc3RvbmUgYnJhbmNoIHdpdGggZGl2ZXJnZW50IGNvbW1pdHMgKG5vdCBtZXJnZWQgaW50byBtYWluKVxuICAgIHJ1bihcImdpdCBjaGVja291dCAtYiBtaWxlc3RvbmUvTTAwMVwiLCBkaXIpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiZmVhdHVyZS50eHRcIiksIFwibmV3IGZlYXR1cmVcXG5cIik7XG4gICAgcnVuKFwiZ2l0IGFkZCBmZWF0dXJlLnR4dFwiLCBkaXIpO1xuICAgIHJ1bihcImdpdCBjb21taXQgLW0gXFxcImFkZCBmZWF0dXJlIG9uIG1pbGVzdG9uZSBicmFuY2hcXFwiXCIsIGRpcik7XG4gICAgcnVuKFwiZ2l0IGNoZWNrb3V0IG1haW5cIiwgZGlyKTtcblxuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdFwiLCBzdGF0dXM6IFwiY29tcGxldGVcIiB9KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF1ZGl0T3JwaGFuZWRNaWxlc3RvbmVCcmFuY2hlcyhkaXIsIFwid29ya3RyZWVcIik7XG5cbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5yZWNvdmVyZWQsIFtdLCBcInNob3VsZCBub3QgZGVsZXRlIHVubWVyZ2VkIGJyYW5jaFwiKTtcbiAgICBhc3NlcnQub2socmVzdWx0Lndhcm5pbmdzLmxlbmd0aCA+IDAsIFwic2hvdWxkIGhhdmUgd2FybmluZ3NcIik7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgcmVzdWx0Lndhcm5pbmdzLnNvbWUodyA9PiB3LmluY2x1ZGVzKFwiTk9UIG1lcmdlZFwiKSksXG4gICAgICBcInNob3VsZCB3YXJuIGFib3V0IHVubWVyZ2VkIGJyYW5jaFwiLFxuICAgICk7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgcmVzdWx0Lndhcm5pbmdzLnNvbWUodyA9PiB3LmluY2x1ZGVzKFwiL2dzZCBkb2N0b3IgZml4XCIpKSxcbiAgICAgIGB3YXJuaW5nIHNob3VsZCBzdWdnZXN0IHRoZSByZWFsIHJlbWVkaWF0aW9uIGNvbW1hbmQ7IGdvdDogJHtKU09OLnN0cmluZ2lmeShyZXN1bHQud2FybmluZ3MpfWAsXG4gICAgKTtcbiAgICBhc3NlcnQub2soXG4gICAgICByZXN1bHQud2FybmluZ3MuZXZlcnkodyA9PiAhdy5pbmNsdWRlcyhcIi9nc2QgaGVhbHRoIC0tZml4XCIpKSxcbiAgICAgIGB3YXJuaW5nIG11c3Qgbm90IHN1Z2dlc3QgdGhlIHJlbW92ZWQgaGVhbHRoIC0tZml4IGNvbW1hbmQ7IGdvdDogJHtKU09OLnN0cmluZ2lmeShyZXN1bHQud2FybmluZ3MpfWAsXG4gICAgKTtcblxuICAgIC8vIEJyYW5jaCBzaG91bGQgc3RpbGwgZXhpc3QgKGRhdGEgc2FmZXR5KVxuICAgIGNvbnN0IGJyYW5jaGVzID0gcnVuKFwiZ2l0IGJyYW5jaCAtLWxpc3QgbWlsZXN0b25lL00wMDFcIiwgZGlyKTtcbiAgICBhc3NlcnQub2soYnJhbmNoZXMuaW5jbHVkZXMoXCJtaWxlc3RvbmUvTTAwMVwiKSwgXCJ1bm1lcmdlZCBicmFuY2ggbXVzdCBiZSBwcmVzZXJ2ZWRcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJza2lwcyBhY3RpdmUgbWlsZXN0b25lIGJyYW5jaCB3aXRoIG5vIGNvbW1pdHMgYWhlYWQgb2YgbWFpbiAobm90aGluZyB0byByZWNvdmVyKVwiLCAoKSA9PiB7XG4gICAgLy8gQnJhbmNoIGNyZWF0ZWQgZnJvbSBtYWluIHdpdGggemVybyBkaXZlcmdlbmNlIFx1MjAxNCBubyBsaXZlIHdvcmssIG5vdGhpbmcgdG8gd2FybiBhYm91dC5cbiAgICBydW4oXCJnaXQgYnJhbmNoIG1pbGVzdG9uZS9NMDAxXCIsIGRpcik7XG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIsIHN0YXR1czogXCJhY3RpdmVcIiB9KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF1ZGl0T3JwaGFuZWRNaWxlc3RvbmVCcmFuY2hlcyhkaXIsIFwid29ya3RyZWVcIik7XG5cbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5yZWNvdmVyZWQsIFtdKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC53YXJuaW5ncywgW10pO1xuXG4gICAgLy8gQnJhbmNoIHNob3VsZCBzdGlsbCBleGlzdCAoZGF0YSBzYWZldHkgXHUyMDE0IHVzZXIgbWF5IGludGVuZCB0byB1c2UgaXQpXG4gICAgY29uc3QgYnJhbmNoZXMgPSBydW4oXCJnaXQgYnJhbmNoIC0tbGlzdCBtaWxlc3RvbmUvTTAwMVwiLCBkaXIpO1xuICAgIGFzc2VydC5vayhicmFuY2hlcy5pbmNsdWRlcyhcIm1pbGVzdG9uZS9NMDAxXCIpLCBcImFjdGl2ZSBtaWxlc3RvbmUgYnJhbmNoIHNob3VsZCBiZSBwcmVzZXJ2ZWRcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCIjNDc2MiBcdTIwMTQgd2FybnMgYWJvdXQgaW4tcHJvZ3Jlc3MgbWlsZXN0b25lIHdpdGggdW5tZXJnZWQgY29tbWl0cyBhaGVhZCBvZiBtYWluXCIsICgpID0+IHtcbiAgICAvLyBTaW11bGF0ZXMgdGhlIHByaW1hcnkgIzQ3NjEgc2NlbmFyaW86IGF1dG8tbW9kZSB3YXMgaW50ZXJydXB0ZWQgbWlkLW1pbGVzdG9uZS5cbiAgICAvLyBEQiBzdGF0dXMgPSBhY3RpdmUvaW5fcHJvZ3Jlc3MsIGJyYW5jaCBoYXMgcmVhbCB3b3JrLCBtYWluIGlzIGJlaGluZC5cbiAgICBydW4oXCJnaXQgY2hlY2tvdXQgLWIgbWlsZXN0b25lL00wMDFcIiwgZGlyKTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcImZlYXR1cmUudHh0XCIpLCBcImluLXByb2dyZXNzIHdvcmtcXG5cIik7XG4gICAgcnVuKFwiZ2l0IGFkZCBmZWF0dXJlLnR4dFwiLCBkaXIpO1xuICAgIHJ1bihcImdpdCBjb21taXQgLW0gXFxcImluLXByb2dyZXNzIHdvcmsgb24gTTAwMVxcXCJcIiwgZGlyKTtcbiAgICBydW4oXCJnaXQgY2hlY2tvdXQgbWFpblwiLCBkaXIpO1xuXG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIsIHN0YXR1czogXCJhY3RpdmVcIiB9KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF1ZGl0T3JwaGFuZWRNaWxlc3RvbmVCcmFuY2hlcyhkaXIsIFwid29ya3RyZWVcIik7XG5cbiAgICAvLyBNdXN0IE5PVCByZWNvdmVyL2RlbGV0ZSAoZGF0YSBzYWZldHkgXHUyMDE0IHdvcmsgaXMgbGl2ZSlcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5yZWNvdmVyZWQsIFtdLCBcIm11c3Qgbm90IGRlbGV0ZSBhIGJyYW5jaCB3aXRoIGxpdmUgaW4tcHJvZ3Jlc3Mgd29ya1wiKTtcblxuICAgIC8vIE11c3Qgc3VyZmFjZSBhIHdhcm5pbmcgc28gdGhlIHVzZXIga25vd3MgdGhlIHdvcmt0cmVlIGhvbGRzIHVuY29sbGFwc2VkIHdvcmtcbiAgICBhc3NlcnQub2socmVzdWx0Lndhcm5pbmdzLmxlbmd0aCA+IDAsIFwic2hvdWxkIHdhcm4gYWJvdXQgaW4tcHJvZ3Jlc3Mgb3JwaGFuXCIpO1xuICAgIGFzc2VydC5vayhcbiAgICAgIHJlc3VsdC53YXJuaW5ncy5zb21lKHcgPT4gdy5pbmNsdWRlcyhcIm1pbGVzdG9uZS9NMDAxXCIpICYmIHcuaW5jbHVkZXMoXCJpbi1wcm9ncmVzc1wiKSksXG4gICAgICBgd2FybmluZyBzaG91bGQgbWVudGlvbiBtaWxlc3RvbmUvTTAwMSBhbmQgaW4tcHJvZ3Jlc3Mgc3RhdGU7IGdvdDogJHtKU09OLnN0cmluZ2lmeShyZXN1bHQud2FybmluZ3MpfWAsXG4gICAgKTtcblxuICAgIC8vIEJyYW5jaCBtdXN0IHN0aWxsIGV4aXN0XG4gICAgY29uc3QgYnJhbmNoZXMgPSBydW4oXCJnaXQgYnJhbmNoIC0tbGlzdCBtaWxlc3RvbmUvTTAwMVwiLCBkaXIpO1xuICAgIGFzc2VydC5vayhicmFuY2hlcy5pbmNsdWRlcyhcIm1pbGVzdG9uZS9NMDAxXCIpLCBcImluLXByb2dyZXNzIGJyYW5jaCBtdXN0IGJlIHByZXNlcnZlZFwiKTtcbiAgfSk7XG5cbiAgdGVzdChcIiM0NzYyIFx1MjAxNCBhbHNvIHN1cmZhY2VzIHdvcmt0cmVlIGRpcmVjdG9yeSBmb3IgaW4tcHJvZ3Jlc3Mgb3JwaGFuIHdoZW4gcHJlc2VudFwiLCAoKSA9PiB7XG4gICAgLy8gSW4tcHJvZ3Jlc3MgKyB1bm1lcmdlZCArIHBoeXNpY2FsIHdvcmt0cmVlIGRpcmVjdG9yeSBcdTIwMTQgdGhlIGZ1bGwgcHJpbWFyeSBzY2VuYXJpby5cbiAgICBydW4oXCJnaXQgY2hlY2tvdXQgLWIgbWlsZXN0b25lL00wMDFcIiwgZGlyKTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcImZlYXR1cmUudHh0XCIpLCBcImluLXByb2dyZXNzIHdvcmtcXG5cIik7XG4gICAgcnVuKFwiZ2l0IGFkZCBmZWF0dXJlLnR4dFwiLCBkaXIpO1xuICAgIHJ1bihcImdpdCBjb21taXQgLW0gXFxcImluLXByb2dyZXNzIHdvcmsgb24gTTAwMVxcXCJcIiwgZGlyKTtcbiAgICBydW4oXCJnaXQgY2hlY2tvdXQgbWFpblwiLCBkaXIpO1xuXG4gICAgLy8gU2ltdWxhdGUgYSBsZWZ0b3ZlciB3b3JrdHJlZSBkaXJlY3RvcnlcbiAgICBjb25zdCB3dERpciA9IGpvaW4oZGlyLCBcIi5nc2RcIiwgXCJ3b3JrdHJlZXNcIiwgXCJNMDAxXCIpO1xuICAgIG1rZGlyU3luYyh3dERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHd0RGlyLCBcIi5naXRcIiksIGBnaXRkaXI6ICR7am9pbihkaXIsIFwiLmdpdFwiLCBcIndvcmt0cmVlc1wiLCBcIk0wMDFcIil9XFxuYCk7XG5cbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXVkaXRPcnBoYW5lZE1pbGVzdG9uZUJyYW5jaGVzKGRpciwgXCJ3b3JrdHJlZVwiKTtcblxuICAgIC8vIE11c3QgcHJlc2VydmUgZXZlcnl0aGluZyBmb3IgZGF0YSBzYWZldHlcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5yZWNvdmVyZWQsIFtdLCBcIm11c3Qgbm90IHRvdWNoIHdvcmt0cmVlIG9yIGJyYW5jaCB3aXRoIGxpdmUgd29ya1wiKTtcbiAgICBhc3NlcnQub2soZXhpc3RzU3luYyh3dERpciksIFwid29ya3RyZWUgZGlyZWN0b3J5IG11c3QgYmUgcHJlc2VydmVkXCIpO1xuXG4gICAgLy8gV2FybmluZyBzaG91bGQgbWVudGlvbiB0aGUgd29ya3RyZWUgcGF0aCBzbyB0aGUgdXNlciBjYW4gZmluZCB0aGUgd29ya1xuICAgIGFzc2VydC5vayhcbiAgICAgIHJlc3VsdC53YXJuaW5ncy5zb21lKHcgPT4gdy5pbmNsdWRlcyhcIi5nc2Qvd29ya3RyZWVzL00wMDFcIikgfHwgdy5pbmNsdWRlcyhcIndvcmt0cmVlXCIpKSxcbiAgICAgIGB3YXJuaW5nIHNob3VsZCByZWZlcmVuY2UgdGhlIHdvcmt0cmVlIGxvY2F0aW9uOyBnb3Q6ICR7SlNPTi5zdHJpbmdpZnkocmVzdWx0Lndhcm5pbmdzKX1gLFxuICAgICk7XG4gIH0pO1xuXG4gIHRlc3QoXCJjbGVhbnMgdXAgb3JwaGFuZWQgd29ya3RyZWUgZGlyZWN0b3J5IGZvciBtZXJnZWQgbWlsZXN0b25lXCIsICgpID0+IHtcbiAgICAvLyBDcmVhdGUgbWlsZXN0b25lIGJyYW5jaCAobWVyZ2VkIFx1MjAxNCBzYW1lIGFzIG1haW4pXG4gICAgcnVuKFwiZ2l0IGJyYW5jaCBtaWxlc3RvbmUvTTAwMVwiLCBkaXIpO1xuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdFwiLCBzdGF0dXM6IFwiY29tcGxldGVcIiB9KTtcblxuICAgIC8vIENyZWF0ZSBvcnBoYW5lZCB3b3JrdHJlZSBkaXJlY3RvcnlcbiAgICBjb25zdCB3dERpciA9IGpvaW4oZGlyLCBcIi5nc2RcIiwgXCJ3b3JrdHJlZXNcIiwgXCJNMDAxXCIpO1xuICAgIG1rZGlyU3luYyh3dERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHd0RGlyLCBcImxlZnRvdmVyLnR4dFwiKSwgXCJvcnBoYW5lZCBmaWxlXFxuXCIpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXVkaXRPcnBoYW5lZE1pbGVzdG9uZUJyYW5jaGVzKGRpciwgXCJ3b3JrdHJlZVwiKTtcblxuICAgIGFzc2VydC5vayhyZXN1bHQucmVjb3ZlcmVkLmxlbmd0aCA+IDAsIFwic2hvdWxkIGhhdmUgcmVjb3ZlcmVkIGFjdGlvbnNcIik7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgcmVzdWx0LnJlY292ZXJlZC5zb21lKHIgPT4gci5pbmNsdWRlcyhcIndvcmt0cmVlIGRpcmVjdG9yeVwiKSksXG4gICAgICBcInNob3VsZCByZXBvcnQgd29ya3RyZWUgY2xlYW51cFwiLFxuICAgICk7XG5cbiAgICAvLyBXb3JrdHJlZSBkaXJlY3Rvcnkgc2hvdWxkIGJlIGNsZWFuZWQgdXBcbiAgICBhc3NlcnQub2soIWV4aXN0c1N5bmMod3REaXIpLCBcIm9ycGhhbmVkIHdvcmt0cmVlIGRpcmVjdG9yeSBzaG91bGQgYmUgcmVtb3ZlZFwiKTtcbiAgfSk7XG5cbiAgdGVzdChcImhhbmRsZXMgbXVsdGlwbGUgbWlsZXN0b25lcyB3aXRoIG1peGVkIHN0YXRlc1wiLCAoKSA9PiB7XG4gICAgLy8gTTAwMTogY29tcGxldGUsIGJyYW5jaCBtZXJnZWQgXHUyMTkyIHNob3VsZCBjbGVhbiB1cFxuICAgIHJ1bihcImdpdCBicmFuY2ggbWlsZXN0b25lL00wMDFcIiwgZGlyKTtcbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIkZpcnN0XCIsIHN0YXR1czogXCJjb21wbGV0ZVwiIH0pO1xuXG4gICAgLy8gTTAwMjogYWN0aXZlLCBicmFuY2ggZXhpc3RzIFx1MjE5MiBzaG91bGQgc2tpcFxuICAgIHJ1bihcImdpdCBicmFuY2ggbWlsZXN0b25lL00wMDJcIiwgZGlyKTtcbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAyXCIsIHRpdGxlOiBcIlNlY29uZFwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhdWRpdE9ycGhhbmVkTWlsZXN0b25lQnJhbmNoZXMoZGlyLCBcIndvcmt0cmVlXCIpO1xuXG4gICAgLy8gTTAwMSBzaG91bGQgYmUgY2xlYW5lZCB1cFxuICAgIGFzc2VydC5vayhcbiAgICAgIHJlc3VsdC5yZWNvdmVyZWQuc29tZShyID0+IHIuaW5jbHVkZXMoXCJNMDAxXCIpKSxcbiAgICAgIFwic2hvdWxkIGNsZWFuIHVwIGNvbXBsZXRlZCBNMDAxXCIsXG4gICAgKTtcblxuICAgIC8vIE0wMDIgc2hvdWxkIG5vdCBiZSB0b3VjaGVkXG4gICAgY29uc3QgYnJhbmNoZXMgPSBydW4oXCJnaXQgYnJhbmNoIC0tbGlzdCBtaWxlc3RvbmUvTTAwMlwiLCBkaXIpO1xuICAgIGFzc2VydC5vayhicmFuY2hlcy5pbmNsdWRlcyhcIm1pbGVzdG9uZS9NMDAyXCIpLCBcImFjdGl2ZSBNMDAyIGJyYW5jaCBzaG91bGQgYmUgcHJlc2VydmVkXCIpO1xuICB9KTtcblxuICB0ZXN0KFwid29ya3MgaW4gYnJhbmNoIGlzb2xhdGlvbiBtb2RlXCIsICgpID0+IHtcbiAgICBydW4oXCJnaXQgYnJhbmNoIG1pbGVzdG9uZS9NMDAxXCIsIGRpcik7XG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIsIHN0YXR1czogXCJjb21wbGV0ZVwiIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXVkaXRPcnBoYW5lZE1pbGVzdG9uZUJyYW5jaGVzKGRpciwgXCJicmFuY2hcIik7XG5cbiAgICBhc3NlcnQub2socmVzdWx0LnJlY292ZXJlZC5sZW5ndGggPiAwLCBcInNob3VsZCB3b3JrIGluIGJyYW5jaCBtb2RlIHRvb1wiKTtcbiAgICBhc3NlcnQub2soXG4gICAgICByZXN1bHQucmVjb3ZlcmVkLnNvbWUociA9PiByLmluY2x1ZGVzKFwiRGVsZXRlZCBtZXJnZWQgYnJhbmNoXCIpKSxcbiAgICAgIFwic2hvdWxkIGRlbGV0ZSBicmFuY2ggaW4gYnJhbmNoIG1vZGVcIixcbiAgICApO1xuICB9KTtcblxuICB0ZXN0KFwibWlsZXN0b25lIGluIERCLCBubyBicmFuY2gsIG5vIHdvcmt0cmVlIGRpciBcdTIxOTIgbm8tb3BcIiwgKCkgPT4ge1xuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdFwiLCBzdGF0dXM6IFwiY29tcGxldGVcIiB9KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF1ZGl0T3JwaGFuZWRNaWxlc3RvbmVCcmFuY2hlcyhkaXIsIFwid29ya3RyZWVcIik7XG5cbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5yZWNvdmVyZWQsIFtdKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC53YXJuaW5ncywgW10pO1xuICB9KTtcblxuICB0ZXN0KFwiIzU4NzkgXHUyMDE0IGNsZWFucyBvcnBoYW5lZCB3b3JrdHJlZSBkaXIgZm9yIGNvbXBsZXRlIG1pbGVzdG9uZSB3aG9zZSBicmFuY2ggd2FzIGFscmVhZHkgZGVsZXRlZFwiLCAoKSA9PiB7XG4gICAgLy8gUmVwcm9kdWNlcyB0aGUgcG9zdGZsaWdodC1zdGFzaC1yZXN0b3JlLWZhaWxlZCBzY2VuYXJpbzpcbiAgICAvLyAxLiBBbiBlYXJsaWVyIGF1ZGl0IGRlbGV0ZWQgbWlsZXN0b25lL00wMDEgKG1lcmdlZCArIGNvbXBsZXRlKS5cbiAgICAvLyAyLiBUaGUgd29ya3RyZWUgZGlyIGNsZWFudXAgZmFpbGVkIHNpbGVudGx5IChsb2dXYXJuaW5nIG9ubHkpLlxuICAgIC8vIDMuIE9uIHRoZSBuZXh0IHN0YXJ0dXAgdGhlIGJyYW5jaCBpcyBnb25lLCBzbyB0aGUgZXhpc3RpbmcgYnJhbmNoLWtleWVkXG4gICAgLy8gICAgbG9vcCBpcyBpbnZpc2libGUgdG8gdGhlIG9ycGhhbiBkaXIuIFdpdGhvdXQgdGhlIHNlY29uZCBwYXNzLCB0aGVcbiAgICAvLyAgICBkaXJlY3RvcnkgbGl2ZXMgZm9yZXZlci5cbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImNvbXBsZXRlXCIgfSk7XG5cbiAgICBjb25zdCB3dERpciA9IGpvaW4oZGlyLCBcIi5nc2RcIiwgXCJ3b3JrdHJlZXNcIiwgXCJNMDAxXCIpO1xuICAgIG1rZGlyU3luYyh3dERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHd0RGlyLCBcImxlZnRvdmVyLnR4dFwiKSwgXCJzdHJhbmRlZCBmcm9tIGEgcHJpb3Igc2Vzc2lvblxcblwiKTtcblxuICAgIC8vIE5vIG1pbGVzdG9uZS9NMDAxIGJyYW5jaCBcdTIwMTQgYWxyZWFkeSBkZWxldGVkIG9uIGEgcHJldmlvdXMgcnVuLlxuICAgIGNvbnN0IGJyYW5jaGVzID0gcnVuKFwiZ2l0IGJyYW5jaCAtLWxpc3QgbWlsZXN0b25lL00wMDFcIiwgZGlyKTtcbiAgICBhc3NlcnQuZXF1YWwoYnJhbmNoZXMsIFwiXCIsIFwidGVzdCBmaXh0dXJlOiBicmFuY2ggc2hvdWxkIG5vdCBleGlzdFwiKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF1ZGl0T3JwaGFuZWRNaWxlc3RvbmVCcmFuY2hlcyhkaXIsIFwid29ya3RyZWVcIik7XG5cbiAgICBhc3NlcnQub2soXG4gICAgICByZXN1bHQucmVjb3ZlcmVkLnNvbWUoKHIpID0+IHIuaW5jbHVkZXMoXCJNMDAxXCIpICYmIHIuaW5jbHVkZXMoXCJicmFuY2ggYWxyZWFkeSBkZWxldGVkXCIpKSxcbiAgICAgIGBzaG91bGQgcmVwb3J0IGJyYW5jaC1sZXNzIG9ycGhhbiBjbGVhbnVwOyBnb3Q6ICR7SlNPTi5zdHJpbmdpZnkocmVzdWx0LnJlY292ZXJlZCl9YCxcbiAgICApO1xuICAgIGFzc2VydC5vayghZXhpc3RzU3luYyh3dERpciksIFwiYnJhbmNoLWxlc3Mgb3JwaGFuIHdvcmt0cmVlIGRpciBzaG91bGQgYmUgcmVtb3ZlZFwiKTtcbiAgfSk7XG5cbiAgdGVzdChcIiM1ODc5IFx1MjAxNCBicmFuY2ggbGlzdCBmYWlsdXJlIHN0aWxsIGNsZWFucyBjb21wbGV0ZSBvcnBoYW4gb25seSBhZnRlciBicmFuY2ggYWJzZW5jZSBpcyB2ZXJpZmllZFwiLCAoKSA9PiB7XG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIsIHN0YXR1czogXCJjb21wbGV0ZVwiIH0pO1xuXG4gICAgY29uc3Qgd3REaXIgPSBqb2luKGRpciwgXCIuZ3NkXCIsIFwid29ya3RyZWVzXCIsIFwiTTAwMVwiKTtcbiAgICBta2RpclN5bmMod3REaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbih3dERpciwgXCJsZWZ0b3Zlci50eHRcIiksIFwic3RyYW5kZWQgZnJvbSBhIHByaW9yIHNlc3Npb25cXG5cIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhdWRpdE9ycGhhbmVkTWlsZXN0b25lQnJhbmNoZXMoZGlyLCBcIndvcmt0cmVlXCIsIHtcbiAgICAgIGJyYW5jaExpc3Q6ICgpID0+IHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiYnJhbmNoIGxpc3QgZmFpbGVkXCIpO1xuICAgICAgfSxcbiAgICAgIGJyYW5jaEV4aXN0czogKF9iYXNlUGF0aCwgYnJhbmNoKSA9PiB7XG4gICAgICAgIGFzc2VydC5lcXVhbChicmFuY2gsIFwibWlsZXN0b25lL00wMDFcIik7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBhc3NlcnQub2soXG4gICAgICByZXN1bHQucmVjb3ZlcmVkLnNvbWUoKHIpID0+IHIuaW5jbHVkZXMoXCJNMDAxXCIpICYmIHIuaW5jbHVkZXMoXCJicmFuY2ggYWxyZWFkeSBkZWxldGVkXCIpKSxcbiAgICAgIGBzaG91bGQgcmVwb3J0IHZlcmlmaWVkIGJyYW5jaC1sZXNzIG9ycGhhbiBjbGVhbnVwOyBnb3Q6ICR7SlNPTi5zdHJpbmdpZnkocmVzdWx0LnJlY292ZXJlZCl9YCxcbiAgICApO1xuICAgIGFzc2VydC5vayghZXhpc3RzU3luYyh3dERpciksIFwidmVyaWZpZWQgYnJhbmNoLWxlc3Mgb3JwaGFuIHdvcmt0cmVlIGRpciBzaG91bGQgYmUgcmVtb3ZlZFwiKTtcbiAgfSk7XG5cbiAgdGVzdChcIiM1ODc5IFx1MjAxNCBicmFuY2ggbGlzdCBmYWlsdXJlIHByZXNlcnZlcyBjb21wbGV0ZSB3b3JrdHJlZSB3aGVuIGJyYW5jaCBzdGlsbCBleGlzdHNcIiwgKCkgPT4ge1xuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdFwiLCBzdGF0dXM6IFwiY29tcGxldGVcIiB9KTtcblxuICAgIGNvbnN0IHd0RGlyID0gam9pbihkaXIsIFwiLmdzZFwiLCBcIndvcmt0cmVlc1wiLCBcIk0wMDFcIik7XG4gICAgbWtkaXJTeW5jKHd0RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4od3REaXIsIFwibGl2ZS13b3JrLnR4dFwiKSwgXCJkbyBub3QgZGVsZXRlXFxuXCIpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXVkaXRPcnBoYW5lZE1pbGVzdG9uZUJyYW5jaGVzKGRpciwgXCJ3b3JrdHJlZVwiLCB7XG4gICAgICBicmFuY2hMaXN0OiAoKSA9PiB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcImJyYW5jaCBsaXN0IGZhaWxlZFwiKTtcbiAgICAgIH0sXG4gICAgICBicmFuY2hFeGlzdHM6IChfYmFzZVBhdGgsIGJyYW5jaCkgPT4ge1xuICAgICAgICBhc3NlcnQuZXF1YWwoYnJhbmNoLCBcIm1pbGVzdG9uZS9NMDAxXCIpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5yZWNvdmVyZWQsIFtdKTtcbiAgICBhc3NlcnQub2soZXhpc3RzU3luYyh3dERpciksIFwid29ya3RyZWUgZGlyIG11c3QgYmUgcHJlc2VydmVkIHdoZW4gYnJhbmNoIGV4aXN0ZW5jZSBpcyB2ZXJpZmllZFwiKTtcbiAgfSk7XG5cbiAgdGVzdChcIiM1ODc5IFx1MjAxNCBza2lwcyBicmFuY2gtbGVzcyBvcnBoYW4gZm9yIG1pbGVzdG9uZSB0aGF0IGlzIG5vdCBjb21wbGV0ZVwiLCAoKSA9PiB7XG4gICAgLy8gRGVmZW5zaXZlOiBvbmx5IGBjb21wbGV0ZWAgbWlsZXN0b25lcyBnZXQgdGhlIGJyYW5jaC1sZXNzIGNsZWFudXAuIEFuXG4gICAgLy8gYGFjdGl2ZWAgbWlsZXN0b25lIHdpdGggbm8gYnJhbmNoIGJ1dCBhIHdvcmt0cmVlIGRpciBpcyBhIGRpZmZlcmVudFxuICAgIC8vIHN0YXRlIChwcm9iYWJseSBtaWQtcmVjb3ZlcnkpIGFuZCBzaG91bGQgbm90IGJlIHNpbGVudGx5IHdpcGVkLlxuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdFwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSk7XG5cbiAgICBjb25zdCB3dERpciA9IGpvaW4oZGlyLCBcIi5nc2RcIiwgXCJ3b3JrdHJlZXNcIiwgXCJNMDAxXCIpO1xuICAgIG1rZGlyU3luYyh3dERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHd0RGlyLCBcImxpdmUtd29yay50eHRcIiksIFwiZG8gbm90IGRlbGV0ZVxcblwiKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF1ZGl0T3JwaGFuZWRNaWxlc3RvbmVCcmFuY2hlcyhkaXIsIFwid29ya3RyZWVcIik7XG5cbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5yZWNvdmVyZWQsIFtdKTtcbiAgICBhc3NlcnQub2soZXhpc3RzU3luYyh3dERpciksIFwiYWN0aXZlIG1pbGVzdG9uZSB3b3JrdHJlZSBkaXIgbXVzdCBiZSBwcmVzZXJ2ZWRcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCIjNTg3OSBcdTIwMTQgYnJhbmNoIGxpc3QgZmFpbHVyZSBkb2VzIG5vdCBkZWxldGUgd29ya3RyZWUgZm9yIG1pbGVzdG9uZSB0aGF0IGlzIG5vdCBjb21wbGV0ZVwiLCAoKSA9PiB7XG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIsIHN0YXR1czogXCJhY3RpdmVcIiB9KTtcblxuICAgIGNvbnN0IHd0RGlyID0gam9pbihkaXIsIFwiLmdzZFwiLCBcIndvcmt0cmVlc1wiLCBcIk0wMDFcIik7XG4gICAgbWtkaXJTeW5jKHd0RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4od3REaXIsIFwibGl2ZS13b3JrLnR4dFwiKSwgXCJkbyBub3QgZGVsZXRlXFxuXCIpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXVkaXRPcnBoYW5lZE1pbGVzdG9uZUJyYW5jaGVzKGRpciwgXCJ3b3JrdHJlZVwiLCB7XG4gICAgICBicmFuY2hMaXN0OiAoKSA9PiB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcImJyYW5jaCBsaXN0IGZhaWxlZFwiKTtcbiAgICAgIH0sXG4gICAgICBicmFuY2hFeGlzdHM6ICgpID0+IHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiYnJhbmNoRXhpc3RzIHNob3VsZCBub3QgYmUgY2FsbGVkIGZvciBhY3RpdmUgbWlsZXN0b25lc1wiKTtcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5yZWNvdmVyZWQsIFtdKTtcbiAgICBhc3NlcnQub2soZXhpc3RzU3luYyh3dERpciksIFwiYWN0aXZlIG1pbGVzdG9uZSB3b3JrdHJlZSBkaXIgbXVzdCBiZSBwcmVzZXJ2ZWRcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCIjNTg3OSBcdTIwMTQgc2tpcHMgYnJhbmNoLWxlc3Mgb3JwaGFuIGluICdub25lJyBpc29sYXRpb24gbW9kZVwiLCAoKSA9PiB7XG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIsIHN0YXR1czogXCJjb21wbGV0ZVwiIH0pO1xuXG4gICAgY29uc3Qgd3REaXIgPSBqb2luKGRpciwgXCIuZ3NkXCIsIFwid29ya3RyZWVzXCIsIFwiTTAwMVwiKTtcbiAgICBta2RpclN5bmMod3REaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbih3dERpciwgXCJsZWZ0b3Zlci50eHRcIiksIFwic3RyYW5kZWRcXG5cIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhdWRpdE9ycGhhbmVkTWlsZXN0b25lQnJhbmNoZXMoZGlyLCBcIm5vbmVcIik7XG5cbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5yZWNvdmVyZWQsIFtdKTtcbiAgICBhc3NlcnQub2soZXhpc3RzU3luYyh3dERpciksIFwiJ25vbmUnIG1vZGUgbXVzdCBub3QgdG91Y2ggd29ya3RyZWUgZGlyc1wiKTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUNBLFNBQVMsVUFBVSxNQUFNLFlBQVksaUJBQWlCO0FBQ3RELE9BQU8sWUFBWTtBQUNuQixTQUFTLGFBQWEsV0FBVyxlQUFlLFFBQVEsWUFBWSxvQkFBb0I7QUFDeEYsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUN2QixTQUFTLGdCQUFnQjtBQUV6QixTQUFTLHNDQUFzQztBQUMvQyxTQUFTLGNBQWMsZUFBZSx1QkFBOEM7QUFFcEYsU0FBUyxJQUFJLEtBQWEsS0FBcUI7QUFDN0MsU0FBTyxTQUFTLEtBQUssRUFBRSxLQUFLLE9BQU8sQ0FBQyxVQUFVLFFBQVEsTUFBTSxHQUFHLFVBQVUsUUFBUSxDQUFDLEVBQUUsS0FBSztBQUMzRjtBQUdBLFNBQVMsYUFBcUI7QUFD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
