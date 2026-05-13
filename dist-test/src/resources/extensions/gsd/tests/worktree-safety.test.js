import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createWorktreeSafetyModule } from "../worktree-safety.js";
import { createWorktree, worktreePath } from "../worktree-manager.js";
function runGit(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8"
  }).trim();
}
function makeBaseRepo() {
  const base = mkdtempSync(join(tmpdir(), "gsd-wt-safety-repo-"));
  runGit(["init", "-b", "main"], base);
  runGit(["config", "user.name", "Test User"], base);
  runGit(["config", "user.email", "test@example.com"], base);
  writeFileSync(join(base, "README.md"), "# Test Project\n", "utf-8");
  runGit(["add", "."], base);
  runGit(["commit", "-m", "chore: init"], base);
  return base;
}
describe("Worktree Safety module", () => {
  let root;
  let projectRoot;
  let unitRoot;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gsd-worktree-safety-"));
    projectRoot = join(root, "project");
    unitRoot = join(projectRoot, ".gsd", "worktrees", "M001");
    mkdirSync(unitRoot, { recursive: true });
    writeFileSync(join(unitRoot, ".git"), "gitdir: ../../../.git/worktrees/M001\n", "utf-8");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });
  test("allows planning-only Units without requiring a source worktree", () => {
    const safety = createWorktreeSafetyModule();
    const result = safety.validateUnitRoot({
      unitType: "plan-milestone",
      unitId: "M001",
      writeScope: "planning-only",
      projectRoot,
      unitRoot: projectRoot,
      milestoneId: "M001"
    });
    assert.equal(result.ok, true);
    assert.equal(result.kind, "not-required");
  });
  test("accepts a source-writing Unit with a registered worktree and expected branch", () => {
    const safety = createWorktreeSafetyModule({
      existsSync: () => true,
      lstatSync: () => ({ isFile: () => true }),
      listRegisteredWorktrees: () => [{ path: unitRoot, branch: "milestone/M001" }],
      getCurrentBranch: () => "milestone/M001"
    });
    const result = safety.validateUnitRoot({
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      writeScope: "source-writing",
      projectRoot,
      unitRoot,
      milestoneId: "M001",
      expectedBranch: "milestone/M001"
    });
    assert.equal(result.ok, true);
    assert.equal(result.kind, "safe");
    assert.equal(result.milestoneId, "M001");
    assert.equal(result.branch, "milestone/M001");
  });
  test("rejects a source-writing Unit when the worktree root is missing", () => {
    const safety = createWorktreeSafetyModule({
      existsSync: (path) => path !== unitRoot,
      lstatSync: () => ({ isFile: () => true })
    });
    const result = safety.validateUnitRoot({
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      writeScope: "source-writing",
      projectRoot,
      unitRoot,
      milestoneId: "M001"
    });
    assert.equal(result.ok, false);
    assert.equal(result.kind, "worktree-missing");
    assert.match(result.remediation, /Create or recover/);
  });
  test("rejects a source-writing Unit outside the expected milestone worktree root", () => {
    const safety = createWorktreeSafetyModule({
      existsSync: () => true,
      lstatSync: () => ({ isFile: () => true })
    });
    const outsideRoot = join(projectRoot, "src");
    const result = safety.validateUnitRoot({
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      writeScope: "source-writing",
      projectRoot,
      unitRoot: outsideRoot,
      milestoneId: "M001"
    });
    assert.equal(result.ok, false);
    assert.equal(result.kind, "invalid-root");
    assert.equal(result.details?.unitRoot, outsideRoot);
    assert.equal(result.details?.expectedRoot, unitRoot);
  });
  test("rejects a standalone repository masquerading as a worktree", () => {
    unlinkSync(join(unitRoot, ".git"));
    mkdirSync(join(unitRoot, ".git"), { recursive: true });
    const safety = createWorktreeSafetyModule();
    const result = safety.validateUnitRoot({
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      writeScope: "source-writing",
      projectRoot,
      unitRoot,
      milestoneId: "M001"
    });
    assert.equal(result.ok, false);
    assert.equal(result.kind, "worktree-git-marker-not-file");
  });
  test("converts .git marker stat failures into typed failures", () => {
    const safety = createWorktreeSafetyModule({
      existsSync: () => true,
      lstatSync: () => {
        throw new Error("marker disappeared");
      }
    });
    const result = safety.validateUnitRoot({
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      writeScope: "source-writing",
      projectRoot,
      unitRoot,
      milestoneId: "M001"
    });
    assert.equal(result.ok, false);
    assert.equal(result.kind, "worktree-git-probe-failed");
    assert.equal(result.details?.error, "marker disappeared");
  });
  test("rejects an unregistered worktree path", () => {
    const safety = createWorktreeSafetyModule({
      existsSync: () => true,
      lstatSync: () => ({ isFile: () => true }),
      listRegisteredWorktrees: () => []
    });
    const result = safety.validateUnitRoot({
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      writeScope: "source-writing",
      projectRoot,
      unitRoot,
      milestoneId: "M001"
    });
    assert.equal(result.ok, false);
    assert.equal(result.kind, "worktree-unregistered");
  });
  test("converts registered worktree list failures into typed failures", () => {
    const safety = createWorktreeSafetyModule({
      existsSync: () => true,
      lstatSync: () => ({ isFile: () => true }),
      listRegisteredWorktrees: () => {
        throw new Error("worktree list unreadable");
      }
    });
    const result = safety.validateUnitRoot({
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      writeScope: "source-writing",
      projectRoot,
      unitRoot,
      milestoneId: "M001"
    });
    assert.equal(result.ok, false);
    assert.equal(result.kind, "worktree-git-probe-failed");
    assert.equal(result.details?.error, "worktree list unreadable");
  });
  test("rejects a branch mismatch with a typed failure", () => {
    const safety = createWorktreeSafetyModule({
      existsSync: () => true,
      lstatSync: () => ({ isFile: () => true }),
      listRegisteredWorktrees: () => [{ path: unitRoot, branch: "milestone/M001" }],
      getCurrentBranch: () => "feature/unexpected"
    });
    const result = safety.validateUnitRoot({
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      writeScope: "source-writing",
      projectRoot,
      unitRoot,
      milestoneId: "M001",
      expectedBranch: "milestone/M001"
    });
    assert.equal(result.ok, false);
    assert.equal(result.kind, "branch-mismatch");
    assert.equal(result.details?.branch, "feature/unexpected");
  });
  test("converts branch resolution failures into typed failures", () => {
    const safety = createWorktreeSafetyModule({
      existsSync: () => true,
      lstatSync: () => ({ isFile: () => true }),
      listRegisteredWorktrees: () => [{ path: unitRoot, branch: "milestone/M001" }],
      getCurrentBranch: () => {
        throw new Error("branch unreadable");
      }
    });
    const result = safety.validateUnitRoot({
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      writeScope: "source-writing",
      projectRoot,
      unitRoot,
      milestoneId: "M001",
      expectedBranch: "milestone/M001"
    });
    assert.equal(result.ok, false);
    assert.equal(result.kind, "worktree-git-probe-failed");
    assert.equal(result.details?.expectedBranch, "milestone/M001");
    assert.equal(result.details?.error, "branch unreadable");
  });
  test("fails closed when branch verification lacks a branch probe", () => {
    const safety = createWorktreeSafetyModule({
      existsSync: () => true,
      lstatSync: () => ({ isFile: () => true }),
      listRegisteredWorktrees: () => [{ path: unitRoot, branch: "milestone/M001" }]
    });
    const result = safety.validateUnitRoot({
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      writeScope: "source-writing",
      projectRoot,
      unitRoot,
      milestoneId: "M001",
      expectedBranch: "milestone/M001"
    });
    assert.equal(result.ok, false);
    assert.equal(result.kind, "worktree-git-probe-failed");
    assert.equal(result.details?.error, "getCurrentBranch dep not provided");
  });
  test("rejects an empty worktree when the project root has content", () => {
    const safety = createWorktreeSafetyModule({
      existsSync: () => true,
      lstatSync: () => ({ isFile: () => true }),
      listRegisteredWorktrees: () => [{ path: unitRoot, branch: "milestone/M001" }]
    });
    const result = safety.validateUnitRoot({
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      writeScope: "source-writing",
      projectRoot,
      unitRoot,
      milestoneId: "M001",
      emptyWorktreeWithProjectContent: true
    });
    assert.equal(result.ok, false);
    assert.equal(result.kind, "empty-worktree-with-project-content");
  });
  test("default adapter proves registered worktree and current branch", (t) => {
    const base = makeBaseRepo();
    t.after(() => rmSync(base, { recursive: true, force: true }));
    createWorktree(base, "M001", { branch: "milestone/M001" });
    const safety = createWorktreeSafetyModule();
    const result = safety.validateUnitRoot({
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      writeScope: "source-writing",
      projectRoot: base,
      unitRoot: worktreePath(base, "M001"),
      milestoneId: "M001",
      expectedBranch: "milestone/M001"
    });
    assert.equal(result.ok, true);
    assert.equal(result.kind, "safe");
    assert.equal(result.branch, "milestone/M001");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy93b3JrdHJlZS1zYWZldHkudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IFVuaXQgdGVzdHMgZm9yIHRoZSBXb3JrdHJlZSBTYWZldHkgbW9kdWxlIGNvbnRyYWN0LlxuXG5pbXBvcnQgeyBhZnRlckVhY2gsIGJlZm9yZUVhY2gsIGRlc2NyaWJlLCB0ZXN0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIHVubGlua1N5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBleGVjRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5cbmltcG9ydCB7IGNyZWF0ZVdvcmt0cmVlU2FmZXR5TW9kdWxlIH0gZnJvbSBcIi4uL3dvcmt0cmVlLXNhZmV0eS50c1wiO1xuaW1wb3J0IHsgY3JlYXRlV29ya3RyZWUsIHdvcmt0cmVlUGF0aCB9IGZyb20gXCIuLi93b3JrdHJlZS1tYW5hZ2VyLnRzXCI7XG5cbmZ1bmN0aW9uIHJ1bkdpdChhcmdzOiBzdHJpbmdbXSwgY3dkOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIGFyZ3MsIHtcbiAgICBjd2QsXG4gICAgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdLFxuICAgIGVuY29kaW5nOiBcInV0Zi04XCIsXG4gIH0pLnRyaW0oKTtcbn1cblxuZnVuY3Rpb24gbWFrZUJhc2VSZXBvKCk6IHN0cmluZyB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC13dC1zYWZldHktcmVwby1cIikpO1xuICBydW5HaXQoW1wiaW5pdFwiLCBcIi1iXCIsIFwibWFpblwiXSwgYmFzZSk7XG4gIHJ1bkdpdChbXCJjb25maWdcIiwgXCJ1c2VyLm5hbWVcIiwgXCJUZXN0IFVzZXJcIl0sIGJhc2UpO1xuICBydW5HaXQoW1wiY29uZmlnXCIsIFwidXNlci5lbWFpbFwiLCBcInRlc3RAZXhhbXBsZS5jb21cIl0sIGJhc2UpO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCJSRUFETUUubWRcIiksIFwiIyBUZXN0IFByb2plY3RcXG5cIiwgXCJ1dGYtOFwiKTtcbiAgcnVuR2l0KFtcImFkZFwiLCBcIi5cIl0sIGJhc2UpO1xuICBydW5HaXQoW1wiY29tbWl0XCIsIFwiLW1cIiwgXCJjaG9yZTogaW5pdFwiXSwgYmFzZSk7XG4gIHJldHVybiBiYXNlO1xufVxuXG5kZXNjcmliZShcIldvcmt0cmVlIFNhZmV0eSBtb2R1bGVcIiwgKCkgPT4ge1xuICBsZXQgcm9vdDogc3RyaW5nO1xuICBsZXQgcHJvamVjdFJvb3Q6IHN0cmluZztcbiAgbGV0IHVuaXRSb290OiBzdHJpbmc7XG5cbiAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgcm9vdCA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXdvcmt0cmVlLXNhZmV0eS1cIikpO1xuICAgIHByb2plY3RSb290ID0gam9pbihyb290LCBcInByb2plY3RcIik7XG4gICAgdW5pdFJvb3QgPSBqb2luKHByb2plY3RSb290LCBcIi5nc2RcIiwgXCJ3b3JrdHJlZXNcIiwgXCJNMDAxXCIpO1xuICAgIG1rZGlyU3luYyh1bml0Um9vdCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHVuaXRSb290LCBcIi5naXRcIiksIFwiZ2l0ZGlyOiAuLi8uLi8uLi8uZ2l0L3dvcmt0cmVlcy9NMDAxXFxuXCIsIFwidXRmLThcIik7XG4gIH0pO1xuXG4gIGFmdGVyRWFjaCgoKSA9PiB7XG4gICAgcm1TeW5jKHJvb3QsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfSk7XG5cbiAgdGVzdChcImFsbG93cyBwbGFubmluZy1vbmx5IFVuaXRzIHdpdGhvdXQgcmVxdWlyaW5nIGEgc291cmNlIHdvcmt0cmVlXCIsICgpID0+IHtcbiAgICBjb25zdCBzYWZldHkgPSBjcmVhdGVXb3JrdHJlZVNhZmV0eU1vZHVsZSgpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gc2FmZXR5LnZhbGlkYXRlVW5pdFJvb3Qoe1xuICAgICAgdW5pdFR5cGU6IFwicGxhbi1taWxlc3RvbmVcIixcbiAgICAgIHVuaXRJZDogXCJNMDAxXCIsXG4gICAgICB3cml0ZVNjb3BlOiBcInBsYW5uaW5nLW9ubHlcIixcbiAgICAgIHByb2plY3RSb290LFxuICAgICAgdW5pdFJvb3Q6IHByb2plY3RSb290LFxuICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5vaywgdHJ1ZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5raW5kLCBcIm5vdC1yZXF1aXJlZFwiKTtcbiAgfSk7XG5cbiAgdGVzdChcImFjY2VwdHMgYSBzb3VyY2Utd3JpdGluZyBVbml0IHdpdGggYSByZWdpc3RlcmVkIHdvcmt0cmVlIGFuZCBleHBlY3RlZCBicmFuY2hcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHNhZmV0eSA9IGNyZWF0ZVdvcmt0cmVlU2FmZXR5TW9kdWxlKHtcbiAgICAgIGV4aXN0c1N5bmM6ICgpID0+IHRydWUsXG4gICAgICBsc3RhdFN5bmM6ICgpID0+ICh7IGlzRmlsZTogKCkgPT4gdHJ1ZSB9KSxcbiAgICAgIGxpc3RSZWdpc3RlcmVkV29ya3RyZWVzOiAoKSA9PiBbeyBwYXRoOiB1bml0Um9vdCwgYnJhbmNoOiBcIm1pbGVzdG9uZS9NMDAxXCIgfV0sXG4gICAgICBnZXRDdXJyZW50QnJhbmNoOiAoKSA9PiBcIm1pbGVzdG9uZS9NMDAxXCIsXG4gICAgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBzYWZldHkudmFsaWRhdGVVbml0Um9vdCh7XG4gICAgICB1bml0VHlwZTogXCJleGVjdXRlLXRhc2tcIixcbiAgICAgIHVuaXRJZDogXCJNMDAxL1MwMS9UMDFcIixcbiAgICAgIHdyaXRlU2NvcGU6IFwic291cmNlLXdyaXRpbmdcIixcbiAgICAgIHByb2plY3RSb290LFxuICAgICAgdW5pdFJvb3QsXG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICBleHBlY3RlZEJyYW5jaDogXCJtaWxlc3RvbmUvTTAwMVwiLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5vaywgdHJ1ZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5raW5kLCBcInNhZmVcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5taWxlc3RvbmVJZCwgXCJNMDAxXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuYnJhbmNoLCBcIm1pbGVzdG9uZS9NMDAxXCIpO1xuICB9KTtcblxuICB0ZXN0KFwicmVqZWN0cyBhIHNvdXJjZS13cml0aW5nIFVuaXQgd2hlbiB0aGUgd29ya3RyZWUgcm9vdCBpcyBtaXNzaW5nXCIsICgpID0+IHtcbiAgICBjb25zdCBzYWZldHkgPSBjcmVhdGVXb3JrdHJlZVNhZmV0eU1vZHVsZSh7XG4gICAgICBleGlzdHNTeW5jOiAocGF0aCkgPT4gcGF0aCAhPT0gdW5pdFJvb3QsXG4gICAgICBsc3RhdFN5bmM6ICgpID0+ICh7IGlzRmlsZTogKCkgPT4gdHJ1ZSB9KSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IHNhZmV0eS52YWxpZGF0ZVVuaXRSb290KHtcbiAgICAgIHVuaXRUeXBlOiBcImV4ZWN1dGUtdGFza1wiLFxuICAgICAgdW5pdElkOiBcIk0wMDEvUzAxL1QwMVwiLFxuICAgICAgd3JpdGVTY29wZTogXCJzb3VyY2Utd3JpdGluZ1wiLFxuICAgICAgcHJvamVjdFJvb3QsXG4gICAgICB1bml0Um9vdCxcbiAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICB9KTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQub2ssIGZhbHNlKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmtpbmQsIFwid29ya3RyZWUtbWlzc2luZ1wiKTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LnJlbWVkaWF0aW9uLCAvQ3JlYXRlIG9yIHJlY292ZXIvKTtcbiAgfSk7XG5cbiAgdGVzdChcInJlamVjdHMgYSBzb3VyY2Utd3JpdGluZyBVbml0IG91dHNpZGUgdGhlIGV4cGVjdGVkIG1pbGVzdG9uZSB3b3JrdHJlZSByb290XCIsICgpID0+IHtcbiAgICBjb25zdCBzYWZldHkgPSBjcmVhdGVXb3JrdHJlZVNhZmV0eU1vZHVsZSh7XG4gICAgICBleGlzdHNTeW5jOiAoKSA9PiB0cnVlLFxuICAgICAgbHN0YXRTeW5jOiAoKSA9PiAoeyBpc0ZpbGU6ICgpID0+IHRydWUgfSksXG4gICAgfSk7XG5cbiAgICBjb25zdCBvdXRzaWRlUm9vdCA9IGpvaW4ocHJvamVjdFJvb3QsIFwic3JjXCIpO1xuICAgIGNvbnN0IHJlc3VsdCA9IHNhZmV0eS52YWxpZGF0ZVVuaXRSb290KHtcbiAgICAgIHVuaXRUeXBlOiBcImV4ZWN1dGUtdGFza1wiLFxuICAgICAgdW5pdElkOiBcIk0wMDEvUzAxL1QwMVwiLFxuICAgICAgd3JpdGVTY29wZTogXCJzb3VyY2Utd3JpdGluZ1wiLFxuICAgICAgcHJvamVjdFJvb3QsXG4gICAgICB1bml0Um9vdDogb3V0c2lkZVJvb3QsXG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgfSk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm9rLCBmYWxzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5raW5kLCBcImludmFsaWQtcm9vdFwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmRldGFpbHM/LnVuaXRSb290LCBvdXRzaWRlUm9vdCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5kZXRhaWxzPy5leHBlY3RlZFJvb3QsIHVuaXRSb290KTtcbiAgfSk7XG5cbiAgdGVzdChcInJlamVjdHMgYSBzdGFuZGFsb25lIHJlcG9zaXRvcnkgbWFzcXVlcmFkaW5nIGFzIGEgd29ya3RyZWVcIiwgKCkgPT4ge1xuICAgIHVubGlua1N5bmMoam9pbih1bml0Um9vdCwgXCIuZ2l0XCIpKTtcbiAgICBta2RpclN5bmMoam9pbih1bml0Um9vdCwgXCIuZ2l0XCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBjb25zdCBzYWZldHkgPSBjcmVhdGVXb3JrdHJlZVNhZmV0eU1vZHVsZSgpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gc2FmZXR5LnZhbGlkYXRlVW5pdFJvb3Qoe1xuICAgICAgdW5pdFR5cGU6IFwiZXhlY3V0ZS10YXNrXCIsXG4gICAgICB1bml0SWQ6IFwiTTAwMS9TMDEvVDAxXCIsXG4gICAgICB3cml0ZVNjb3BlOiBcInNvdXJjZS13cml0aW5nXCIsXG4gICAgICBwcm9qZWN0Um9vdCxcbiAgICAgIHVuaXRSb290LFxuICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5vaywgZmFsc2UpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQua2luZCwgXCJ3b3JrdHJlZS1naXQtbWFya2VyLW5vdC1maWxlXCIpO1xuICB9KTtcblxuICB0ZXN0KFwiY29udmVydHMgLmdpdCBtYXJrZXIgc3RhdCBmYWlsdXJlcyBpbnRvIHR5cGVkIGZhaWx1cmVzXCIsICgpID0+IHtcbiAgICBjb25zdCBzYWZldHkgPSBjcmVhdGVXb3JrdHJlZVNhZmV0eU1vZHVsZSh7XG4gICAgICBleGlzdHNTeW5jOiAoKSA9PiB0cnVlLFxuICAgICAgbHN0YXRTeW5jOiAoKSA9PiB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIm1hcmtlciBkaXNhcHBlYXJlZFwiKTtcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBzYWZldHkudmFsaWRhdGVVbml0Um9vdCh7XG4gICAgICB1bml0VHlwZTogXCJleGVjdXRlLXRhc2tcIixcbiAgICAgIHVuaXRJZDogXCJNMDAxL1MwMS9UMDFcIixcbiAgICAgIHdyaXRlU2NvcGU6IFwic291cmNlLXdyaXRpbmdcIixcbiAgICAgIHByb2plY3RSb290LFxuICAgICAgdW5pdFJvb3QsXG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgfSk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm9rLCBmYWxzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5raW5kLCBcIndvcmt0cmVlLWdpdC1wcm9iZS1mYWlsZWRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5kZXRhaWxzPy5lcnJvciwgXCJtYXJrZXIgZGlzYXBwZWFyZWRcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJyZWplY3RzIGFuIHVucmVnaXN0ZXJlZCB3b3JrdHJlZSBwYXRoXCIsICgpID0+IHtcbiAgICBjb25zdCBzYWZldHkgPSBjcmVhdGVXb3JrdHJlZVNhZmV0eU1vZHVsZSh7XG4gICAgICBleGlzdHNTeW5jOiAoKSA9PiB0cnVlLFxuICAgICAgbHN0YXRTeW5jOiAoKSA9PiAoeyBpc0ZpbGU6ICgpID0+IHRydWUgfSksXG4gICAgICBsaXN0UmVnaXN0ZXJlZFdvcmt0cmVlczogKCkgPT4gW10sXG4gICAgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBzYWZldHkudmFsaWRhdGVVbml0Um9vdCh7XG4gICAgICB1bml0VHlwZTogXCJleGVjdXRlLXRhc2tcIixcbiAgICAgIHVuaXRJZDogXCJNMDAxL1MwMS9UMDFcIixcbiAgICAgIHdyaXRlU2NvcGU6IFwic291cmNlLXdyaXRpbmdcIixcbiAgICAgIHByb2plY3RSb290LFxuICAgICAgdW5pdFJvb3QsXG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgfSk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm9rLCBmYWxzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5raW5kLCBcIndvcmt0cmVlLXVucmVnaXN0ZXJlZFwiKTtcbiAgfSk7XG5cbiAgdGVzdChcImNvbnZlcnRzIHJlZ2lzdGVyZWQgd29ya3RyZWUgbGlzdCBmYWlsdXJlcyBpbnRvIHR5cGVkIGZhaWx1cmVzXCIsICgpID0+IHtcbiAgICBjb25zdCBzYWZldHkgPSBjcmVhdGVXb3JrdHJlZVNhZmV0eU1vZHVsZSh7XG4gICAgICBleGlzdHNTeW5jOiAoKSA9PiB0cnVlLFxuICAgICAgbHN0YXRTeW5jOiAoKSA9PiAoeyBpc0ZpbGU6ICgpID0+IHRydWUgfSksXG4gICAgICBsaXN0UmVnaXN0ZXJlZFdvcmt0cmVlczogKCkgPT4ge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJ3b3JrdHJlZSBsaXN0IHVucmVhZGFibGVcIik7XG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gc2FmZXR5LnZhbGlkYXRlVW5pdFJvb3Qoe1xuICAgICAgdW5pdFR5cGU6IFwiZXhlY3V0ZS10YXNrXCIsXG4gICAgICB1bml0SWQ6IFwiTTAwMS9TMDEvVDAxXCIsXG4gICAgICB3cml0ZVNjb3BlOiBcInNvdXJjZS13cml0aW5nXCIsXG4gICAgICBwcm9qZWN0Um9vdCxcbiAgICAgIHVuaXRSb290LFxuICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5vaywgZmFsc2UpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQua2luZCwgXCJ3b3JrdHJlZS1naXQtcHJvYmUtZmFpbGVkXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuZGV0YWlscz8uZXJyb3IsIFwid29ya3RyZWUgbGlzdCB1bnJlYWRhYmxlXCIpO1xuICB9KTtcblxuICB0ZXN0KFwicmVqZWN0cyBhIGJyYW5jaCBtaXNtYXRjaCB3aXRoIGEgdHlwZWQgZmFpbHVyZVwiLCAoKSA9PiB7XG4gICAgY29uc3Qgc2FmZXR5ID0gY3JlYXRlV29ya3RyZWVTYWZldHlNb2R1bGUoe1xuICAgICAgZXhpc3RzU3luYzogKCkgPT4gdHJ1ZSxcbiAgICAgIGxzdGF0U3luYzogKCkgPT4gKHsgaXNGaWxlOiAoKSA9PiB0cnVlIH0pLFxuICAgICAgbGlzdFJlZ2lzdGVyZWRXb3JrdHJlZXM6ICgpID0+IFt7IHBhdGg6IHVuaXRSb290LCBicmFuY2g6IFwibWlsZXN0b25lL00wMDFcIiB9XSxcbiAgICAgIGdldEN1cnJlbnRCcmFuY2g6ICgpID0+IFwiZmVhdHVyZS91bmV4cGVjdGVkXCIsXG4gICAgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBzYWZldHkudmFsaWRhdGVVbml0Um9vdCh7XG4gICAgICB1bml0VHlwZTogXCJleGVjdXRlLXRhc2tcIixcbiAgICAgIHVuaXRJZDogXCJNMDAxL1MwMS9UMDFcIixcbiAgICAgIHdyaXRlU2NvcGU6IFwic291cmNlLXdyaXRpbmdcIixcbiAgICAgIHByb2plY3RSb290LFxuICAgICAgdW5pdFJvb3QsXG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICBleHBlY3RlZEJyYW5jaDogXCJtaWxlc3RvbmUvTTAwMVwiLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5vaywgZmFsc2UpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQua2luZCwgXCJicmFuY2gtbWlzbWF0Y2hcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5kZXRhaWxzPy5icmFuY2gsIFwiZmVhdHVyZS91bmV4cGVjdGVkXCIpO1xuICB9KTtcblxuICB0ZXN0KFwiY29udmVydHMgYnJhbmNoIHJlc29sdXRpb24gZmFpbHVyZXMgaW50byB0eXBlZCBmYWlsdXJlc1wiLCAoKSA9PiB7XG4gICAgY29uc3Qgc2FmZXR5ID0gY3JlYXRlV29ya3RyZWVTYWZldHlNb2R1bGUoe1xuICAgICAgZXhpc3RzU3luYzogKCkgPT4gdHJ1ZSxcbiAgICAgIGxzdGF0U3luYzogKCkgPT4gKHsgaXNGaWxlOiAoKSA9PiB0cnVlIH0pLFxuICAgICAgbGlzdFJlZ2lzdGVyZWRXb3JrdHJlZXM6ICgpID0+IFt7IHBhdGg6IHVuaXRSb290LCBicmFuY2g6IFwibWlsZXN0b25lL00wMDFcIiB9XSxcbiAgICAgIGdldEN1cnJlbnRCcmFuY2g6ICgpID0+IHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiYnJhbmNoIHVucmVhZGFibGVcIik7XG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gc2FmZXR5LnZhbGlkYXRlVW5pdFJvb3Qoe1xuICAgICAgdW5pdFR5cGU6IFwiZXhlY3V0ZS10YXNrXCIsXG4gICAgICB1bml0SWQ6IFwiTTAwMS9TMDEvVDAxXCIsXG4gICAgICB3cml0ZVNjb3BlOiBcInNvdXJjZS13cml0aW5nXCIsXG4gICAgICBwcm9qZWN0Um9vdCxcbiAgICAgIHVuaXRSb290LFxuICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgZXhwZWN0ZWRCcmFuY2g6IFwibWlsZXN0b25lL00wMDFcIixcbiAgICB9KTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQub2ssIGZhbHNlKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmtpbmQsIFwid29ya3RyZWUtZ2l0LXByb2JlLWZhaWxlZFwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmRldGFpbHM/LmV4cGVjdGVkQnJhbmNoLCBcIm1pbGVzdG9uZS9NMDAxXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuZGV0YWlscz8uZXJyb3IsIFwiYnJhbmNoIHVucmVhZGFibGVcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJmYWlscyBjbG9zZWQgd2hlbiBicmFuY2ggdmVyaWZpY2F0aW9uIGxhY2tzIGEgYnJhbmNoIHByb2JlXCIsICgpID0+IHtcbiAgICBjb25zdCBzYWZldHkgPSBjcmVhdGVXb3JrdHJlZVNhZmV0eU1vZHVsZSh7XG4gICAgICBleGlzdHNTeW5jOiAoKSA9PiB0cnVlLFxuICAgICAgbHN0YXRTeW5jOiAoKSA9PiAoeyBpc0ZpbGU6ICgpID0+IHRydWUgfSksXG4gICAgICBsaXN0UmVnaXN0ZXJlZFdvcmt0cmVlczogKCkgPT4gW3sgcGF0aDogdW5pdFJvb3QsIGJyYW5jaDogXCJtaWxlc3RvbmUvTTAwMVwiIH1dLFxuICAgIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gc2FmZXR5LnZhbGlkYXRlVW5pdFJvb3Qoe1xuICAgICAgdW5pdFR5cGU6IFwiZXhlY3V0ZS10YXNrXCIsXG4gICAgICB1bml0SWQ6IFwiTTAwMS9TMDEvVDAxXCIsXG4gICAgICB3cml0ZVNjb3BlOiBcInNvdXJjZS13cml0aW5nXCIsXG4gICAgICBwcm9qZWN0Um9vdCxcbiAgICAgIHVuaXRSb290LFxuICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgZXhwZWN0ZWRCcmFuY2g6IFwibWlsZXN0b25lL00wMDFcIixcbiAgICB9KTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQub2ssIGZhbHNlKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmtpbmQsIFwid29ya3RyZWUtZ2l0LXByb2JlLWZhaWxlZFwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmRldGFpbHM/LmVycm9yLCBcImdldEN1cnJlbnRCcmFuY2ggZGVwIG5vdCBwcm92aWRlZFwiKTtcbiAgfSk7XG5cbiAgdGVzdChcInJlamVjdHMgYW4gZW1wdHkgd29ya3RyZWUgd2hlbiB0aGUgcHJvamVjdCByb290IGhhcyBjb250ZW50XCIsICgpID0+IHtcbiAgICBjb25zdCBzYWZldHkgPSBjcmVhdGVXb3JrdHJlZVNhZmV0eU1vZHVsZSh7XG4gICAgICBleGlzdHNTeW5jOiAoKSA9PiB0cnVlLFxuICAgICAgbHN0YXRTeW5jOiAoKSA9PiAoeyBpc0ZpbGU6ICgpID0+IHRydWUgfSksXG4gICAgICBsaXN0UmVnaXN0ZXJlZFdvcmt0cmVlczogKCkgPT4gW3sgcGF0aDogdW5pdFJvb3QsIGJyYW5jaDogXCJtaWxlc3RvbmUvTTAwMVwiIH1dLFxuICAgIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gc2FmZXR5LnZhbGlkYXRlVW5pdFJvb3Qoe1xuICAgICAgdW5pdFR5cGU6IFwiZXhlY3V0ZS10YXNrXCIsXG4gICAgICB1bml0SWQ6IFwiTTAwMS9TMDEvVDAxXCIsXG4gICAgICB3cml0ZVNjb3BlOiBcInNvdXJjZS13cml0aW5nXCIsXG4gICAgICBwcm9qZWN0Um9vdCxcbiAgICAgIHVuaXRSb290LFxuICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgZW1wdHlXb3JrdHJlZVdpdGhQcm9qZWN0Q29udGVudDogdHJ1ZSxcbiAgICB9KTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQub2ssIGZhbHNlKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmtpbmQsIFwiZW1wdHktd29ya3RyZWUtd2l0aC1wcm9qZWN0LWNvbnRlbnRcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJkZWZhdWx0IGFkYXB0ZXIgcHJvdmVzIHJlZ2lzdGVyZWQgd29ya3RyZWUgYW5kIGN1cnJlbnQgYnJhbmNoXCIsICh0KSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1ha2VCYXNlUmVwbygpO1xuICAgIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG4gICAgY3JlYXRlV29ya3RyZWUoYmFzZSwgXCJNMDAxXCIsIHsgYnJhbmNoOiBcIm1pbGVzdG9uZS9NMDAxXCIgfSk7XG5cbiAgICBjb25zdCBzYWZldHkgPSBjcmVhdGVXb3JrdHJlZVNhZmV0eU1vZHVsZSgpO1xuICAgIGNvbnN0IHJlc3VsdCA9IHNhZmV0eS52YWxpZGF0ZVVuaXRSb290KHtcbiAgICAgIHVuaXRUeXBlOiBcImV4ZWN1dGUtdGFza1wiLFxuICAgICAgdW5pdElkOiBcIk0wMDEvUzAxL1QwMVwiLFxuICAgICAgd3JpdGVTY29wZTogXCJzb3VyY2Utd3JpdGluZ1wiLFxuICAgICAgcHJvamVjdFJvb3Q6IGJhc2UsXG4gICAgICB1bml0Um9vdDogd29ya3RyZWVQYXRoKGJhc2UsIFwiTTAwMVwiKSxcbiAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICAgIGV4cGVjdGVkQnJhbmNoOiBcIm1pbGVzdG9uZS9NMDAxXCIsXG4gICAgfSk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm9rLCB0cnVlKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmtpbmQsIFwic2FmZVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmJyYW5jaCwgXCJtaWxlc3RvbmUvTTAwMVwiKTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUdBLFNBQVMsV0FBVyxZQUFZLFVBQVUsWUFBWTtBQUN0RCxPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhLFdBQVcsUUFBUSxZQUFZLHFCQUFxQjtBQUMxRSxTQUFTLGNBQWM7QUFDdkIsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsb0JBQW9CO0FBRTdCLFNBQVMsa0NBQWtDO0FBQzNDLFNBQVMsZ0JBQWdCLG9CQUFvQjtBQUU3QyxTQUFTLE9BQU8sTUFBZ0IsS0FBcUI7QUFDbkQsU0FBTyxhQUFhLE9BQU8sTUFBTTtBQUFBLElBQy9CO0FBQUEsSUFDQSxPQUFPLENBQUMsVUFBVSxRQUFRLE1BQU07QUFBQSxJQUNoQyxVQUFVO0FBQUEsRUFDWixDQUFDLEVBQUUsS0FBSztBQUNWO0FBRUEsU0FBUyxlQUF1QjtBQUM5QixRQUFNLE9BQU8sWUFBWSxLQUFLLE9BQU8sR0FBRyxxQkFBcUIsQ0FBQztBQUM5RCxTQUFPLENBQUMsUUFBUSxNQUFNLE1BQU0sR0FBRyxJQUFJO0FBQ25DLFNBQU8sQ0FBQyxVQUFVLGFBQWEsV0FBVyxHQUFHLElBQUk7QUFDakQsU0FBTyxDQUFDLFVBQVUsY0FBYyxrQkFBa0IsR0FBRyxJQUFJO0FBQ3pELGdCQUFjLEtBQUssTUFBTSxX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
