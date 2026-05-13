import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
function initGitRepoIn(base, isolation) {
  const git = (args) => {
    execFileSync("git", args, { cwd: base, stdio: "pipe" });
  };
  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@test.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(join(base, "README.md"), "# test\n");
  writeFileSync(join(base, ".gitignore"), ".gsd/worktrees/\n");
  mkdirSync(join(base, ".gsd"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "preferences.md"),
    `## Git
- isolation: ${isolation}
`
  );
  git(["add", "."]);
  git(["commit", "-m", "init"]);
}
import {
  WorktreeLifecycle,
  resetRecentWorktreeMergeFailuresForTest
} from "../worktree-lifecycle.js";
import { WorktreeStateProjection } from "../worktree-state-projection.js";
import { MergeConflictError } from "../git-service.js";
import { AutoSession } from "../auto/session.js";
function makeSession(overrides) {
  const s = new AutoSession();
  s.basePath = overrides?.basePath ?? "/project";
  s.originalBasePath = overrides?.originalBasePath ?? "/project";
  return s;
}
function makeDeps(overrides) {
  const deps = {
    mergeMilestoneToMain: () => ({ pushed: false, codeFilesChanged: true }),
    worktreeProjection: new WorktreeStateProjection(),
    // ADR-016 phase 2 / C4 (#5627): GitServiceImpl constructor → factory.
    gitServiceFactory: () => ({}),
    ...overrides
  };
  return deps;
}
function makeNotifyCtx() {
  return {
    notify: () => {
    }
  };
}
function readJournalEntries(basePath) {
  const journalDir = join(basePath, ".gsd", "journal");
  try {
    const files = readdirSync(journalDir).filter((f) => f.endsWith(".jsonl")).sort();
    const entries = [];
    for (const file of files) {
      const raw = readFileSync(join(journalDir, file), "utf-8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        entries.push(JSON.parse(line));
      }
    }
    return entries;
  } catch {
    return [];
  }
}
function setupMergeWorktree(basePath, milestoneId) {
  initGitRepoIn(basePath, "worktree");
  execFileSync("git", ["checkout", "-b", `milestone/${milestoneId}`], { cwd: basePath, stdio: "pipe" });
  execFileSync("git", ["checkout", "main"], { cwd: basePath, stdio: "pipe" });
  const wt = join(basePath, ".gsd", "worktrees", milestoneId);
  execFileSync("git", ["worktree", "add", wt, `milestone/${milestoneId}`], { cwd: basePath, stdio: "pipe" });
  mkdirSync(join(basePath, ".gsd", "milestones", milestoneId), { recursive: true });
  writeFileSync(
    join(basePath, ".gsd", "milestones", milestoneId, `${milestoneId}-ROADMAP.md`),
    `# ${milestoneId}
- [x] S01: Slice one
`
  );
  return wt;
}
describe("worktree journal events", () => {
  let tmp;
  const originalCwd = process.cwd();
  beforeEach(() => {
    resetRecentWorktreeMergeFailuresForTest();
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "wt-journal-")));
  });
  afterEach(() => {
    try {
      process.chdir(originalCwd);
    } catch {
    }
    rmSync(tmp, { recursive: true, force: true });
  });
  test("enterMilestone emits worktree-enter on success (new worktree)", () => {
    initGitRepoIn(tmp, "worktree");
    const s = makeSession({ basePath: tmp, originalBasePath: tmp });
    const result = new WorktreeLifecycle(s, makeDeps()).enterMilestone(
      "M001",
      makeNotifyCtx()
    );
    assert.equal(
      result.ok,
      true,
      `enterMilestone failed: ${JSON.stringify(result)}`
    );
    const entries = readJournalEntries(tmp);
    const enter = entries.find((e) => e.eventType === "worktree-enter");
    assert.ok(enter, "worktree-enter event should be emitted");
    assert.equal(enter.data?.milestoneId, "M001");
    assert.equal(enter.data?.created, true);
    assert.ok(enter.data?.wtPath);
  });
  test("enterMilestone emits worktree-enter with created=false for existing worktree", () => {
    initGitRepoIn(tmp, "worktree");
    execFileSync("git", ["checkout", "-b", "milestone/M001"], { cwd: tmp, stdio: "pipe" });
    execFileSync("git", ["checkout", "main"], { cwd: tmp, stdio: "pipe" });
    execFileSync(
      "git",
      ["worktree", "add", join(tmp, ".gsd", "worktrees", "M001"), "milestone/M001"],
      { cwd: tmp, stdio: "pipe" }
    );
    const s = makeSession({ basePath: tmp, originalBasePath: tmp });
    new WorktreeLifecycle(s, makeDeps()).enterMilestone("M001", makeNotifyCtx());
    const entries = readJournalEntries(tmp);
    const enter = entries.find((e) => e.eventType === "worktree-enter");
    assert.ok(enter, "worktree-enter event should be emitted");
    assert.equal(enter.data?.created, false);
  });
  test("enterMilestone emits worktree-skip when isolation disabled", () => {
    initGitRepoIn(tmp, "none");
    const s = makeSession({ basePath: tmp, originalBasePath: tmp });
    new WorktreeLifecycle(s, makeDeps()).enterMilestone("M001", makeNotifyCtx());
    const entries = readJournalEntries(tmp);
    const skip = entries.find((e) => e.eventType === "worktree-skip");
    assert.ok(skip, "worktree-skip event should be emitted");
    assert.equal(skip.data?.milestoneId, "M001");
    assert.equal(skip.data?.reason, "isolation-disabled");
  });
  test("enterMilestone emits worktree-create-failed on error", () => {
    initGitRepoIn(tmp, "worktree");
    rmSync(join(tmp, ".git"), { recursive: true, force: true });
    const s = makeSession({ basePath: tmp, originalBasePath: tmp });
    new WorktreeLifecycle(s, makeDeps()).enterMilestone("M001", makeNotifyCtx());
    const entries = readJournalEntries(tmp);
    const failed = entries.find((e) => e.eventType === "worktree-create-failed");
    assert.ok(failed, "worktree-create-failed event should be emitted");
    assert.equal(failed.data?.milestoneId, "M001");
    assert.ok(failed.data?.error, "error message should be present");
    assert.equal(failed.data?.fallback, "project-root");
  });
  test("mergeAndExit emits worktree-merge-start", () => {
    initGitRepoIn(tmp, "worktree");
    execFileSync("git", ["checkout", "-b", "milestone/M001"], { cwd: tmp, stdio: "pipe" });
    execFileSync("git", ["checkout", "main"], { cwd: tmp, stdio: "pipe" });
    const wt = join(tmp, ".gsd", "worktrees", "M001");
    execFileSync("git", ["worktree", "add", wt, "milestone/M001"], { cwd: tmp, stdio: "pipe" });
    const s = makeSession({ basePath: wt, originalBasePath: tmp });
    const deps = makeDeps();
    process.chdir(wt);
    new WorktreeLifecycle(s, deps).exitMilestone(
      "M001",
      { merge: true },
      makeNotifyCtx()
    );
    const entries = readJournalEntries(tmp);
    const start = entries.find((e) => e.eventType === "worktree-merge-start");
    assert.ok(start, "worktree-merge-start event should be emitted");
    assert.equal(start.data?.milestoneId, "M001");
    assert.equal(start.data?.mode, "worktree");
  });
  test("exitMilestone propagates codeFilesChanged from merge result", () => {
    initGitRepoIn(tmp, "worktree");
    execFileSync("git", ["checkout", "-b", "milestone/M001"], { cwd: tmp, stdio: "pipe" });
    execFileSync("git", ["checkout", "main"], { cwd: tmp, stdio: "pipe" });
    const wt = join(tmp, ".gsd", "worktrees", "M001");
    execFileSync("git", ["worktree", "add", wt, "milestone/M001"], { cwd: tmp, stdio: "pipe" });
    mkdirSync(join(tmp, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(
      join(tmp, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
      "# M001\n- [x] S01: Slice one\n"
    );
    const s = makeSession({ basePath: wt, originalBasePath: tmp });
    const deps = makeDeps({
      mergeMilestoneToMain: () => ({ pushed: false, codeFilesChanged: true })
    });
    process.chdir(wt);
    const result = new WorktreeLifecycle(s, deps).exitMilestone(
      "M001",
      { merge: true },
      makeNotifyCtx()
    );
    assert.deepEqual(result, {
      ok: true,
      merged: true,
      codeFilesChanged: true
    });
  });
  test("mergeAndExit emits worktree-merge-failed on error", () => {
    const wt = setupMergeWorktree(tmp, "M001");
    const s = makeSession({ basePath: wt, originalBasePath: tmp });
    const deps = makeDeps({
      mergeMilestoneToMain: () => {
        throw new Error("conflict in main");
      }
    });
    const result = new WorktreeLifecycle(s, deps).exitMilestone(
      "M001",
      { merge: true },
      makeNotifyCtx()
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "teardown-failed");
      assert.match(
        result.cause instanceof Error ? result.cause.message : String(result.cause),
        /conflict in main/
      );
    }
    new WorktreeLifecycle(s, deps).exitMilestone(
      "M001",
      { merge: true },
      makeNotifyCtx()
    );
    const entries = readJournalEntries(tmp);
    const failures = entries.filter((e) => e.eventType === "worktree-merge-failed");
    const failed = failures[0];
    assert.ok(failed, "worktree-merge-failed event should be emitted");
    assert.equal(failed.data?.milestoneId, "M001");
    assert.equal(failed.data?.error, "conflict in main");
    assert.equal(failures.length, 1, "duplicate merge failures are journaled once");
  });
  test("merge failure dedupe uses stable conflict category and expires", (t) => {
    let now = 1e6;
    t.mock.method(Date, "now", () => now);
    const wt = setupMergeWorktree(tmp, "M001");
    const s = makeSession({ basePath: wt, originalBasePath: tmp });
    let attempt = 0;
    const deps = makeDeps({
      mergeMilestoneToMain: () => {
        attempt += 1;
        throw new MergeConflictError(
          attempt === 1 ? ["src/a.ts"] : ["src/b.ts", "src/c.ts"],
          "squash",
          "milestone/M001",
          "main"
        );
      }
    });
    const lifecycle = new WorktreeLifecycle(s, deps);
    lifecycle.exitMilestone("M001", { merge: true }, makeNotifyCtx());
    lifecycle.exitMilestone("M001", { merge: true }, makeNotifyCtx());
    let failures = readJournalEntries(tmp).filter((e) => e.eventType === "worktree-merge-failed");
    assert.equal(failures.length, 1, "variable conflict filenames should not bypass dedupe");
    assert.match(
      String(failures[0].data?.error),
      /src\/a\.ts/,
      "journal payload keeps the original error message"
    );
    now += 60001;
    lifecycle.exitMilestone("M001", { merge: true }, makeNotifyCtx());
    failures = readJournalEntries(tmp).filter((e) => e.eventType === "worktree-merge-failed");
    assert.equal(failures.length, 2, "same merge failure is journaled again after dedupe expiry");
  });
  test("journal entries have valid flowId, seq, and ts fields", () => {
    const s = makeSession({ basePath: tmp, originalBasePath: tmp });
    const deps = makeDeps({ shouldUseWorktreeIsolation: () => false });
    new WorktreeLifecycle(s, deps).enterMilestone("M001", makeNotifyCtx());
    const entries = readJournalEntries(tmp);
    assert.ok(entries.length > 0, "at least one entry should exist");
    const entry = entries[0];
    assert.ok(entry.flowId, "flowId should be set");
    assert.ok(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(entry.flowId),
      "flowId should be a valid UUID"
    );
    assert.equal(entry.seq, 0);
    assert.ok(entry.ts, "ts should be set");
    assert.ok(!isNaN(Date.parse(entry.ts)), "ts should be a valid ISO date");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy93b3JrdHJlZS1qb3VybmFsLWV2ZW50cy50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBkZXNjcmliZSwgdGVzdCwgYmVmb3JlRWFjaCwgYWZ0ZXJFYWNoIH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2RpclN5bmMsIG1rZHRlbXBTeW5jLCBybVN5bmMsIHJlYWRGaWxlU3luYywgcmVhZGRpclN5bmMsIHJlYWxwYXRoU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGV4ZWNGaWxlU3luYyB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcblxuLyoqXG4gKiBJbml0aWFsaXplIHRoZSB0ZW1wIGRpciBhcyBhIHJlYWwgZ2l0IHJlcG8gd2l0aCBhIGAuZ3NkL3ByZWZlcmVuY2VzLm1kYFxuICogZGVjbGFyaW5nIHRoZSByZXF1ZXN0ZWQgaXNvbGF0aW9uIG1vZGUuIFJlcXVpcmVkIGFmdGVyIEFEUi0wMTYgcGhhc2UgMiAvXG4gKiBDMStDMitDMyBpbmxpbmVkIHRoZSB3b3JrdHJlZS1tYW5hZ2VyICsgY2FjaGUgKyBwcmVmZXJlbmNlcyBwcmltaXRpdmVzIFx1MjAxNFxuICogdGVzdHMgY2FuIG5vIGxvbmdlciBzdHViIHRoZW0gdmlhIGRlcHMuXG4gKi9cbmZ1bmN0aW9uIGluaXRHaXRSZXBvSW4oYmFzZTogc3RyaW5nLCBpc29sYXRpb246IFwid29ya3RyZWVcIiB8IFwiYnJhbmNoXCIgfCBcIm5vbmVcIik6IHZvaWQge1xuICBjb25zdCBnaXQgPSAoYXJnczogc3RyaW5nW10pOiB2b2lkID0+IHtcbiAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgYXJncywgeyBjd2Q6IGJhc2UsIHN0ZGlvOiBcInBpcGVcIiB9KTtcbiAgfTtcbiAgZ2l0KFtcImluaXRcIiwgXCItYlwiLCBcIm1haW5cIl0pO1xuICBnaXQoW1wiY29uZmlnXCIsIFwidXNlci5lbWFpbFwiLCBcInRlc3RAdGVzdC5jb21cIl0pO1xuICBnaXQoW1wiY29uZmlnXCIsIFwidXNlci5uYW1lXCIsIFwiVGVzdFwiXSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIlJFQURNRS5tZFwiKSwgXCIjIHRlc3RcXG5cIik7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5naXRpZ25vcmVcIiksIFwiLmdzZC93b3JrdHJlZXMvXFxuXCIpO1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwicHJlZmVyZW5jZXMubWRcIiksXG4gICAgYCMjIEdpdFxcbi0gaXNvbGF0aW9uOiAke2lzb2xhdGlvbn1cXG5gLFxuICApO1xuICBnaXQoW1wiYWRkXCIsIFwiLlwiXSk7XG4gIGdpdChbXCJjb21taXRcIiwgXCItbVwiLCBcImluaXRcIl0pO1xufVxuaW1wb3J0IHtcbiAgV29ya3RyZWVMaWZlY3ljbGUsXG4gIHJlc2V0UmVjZW50V29ya3RyZWVNZXJnZUZhaWx1cmVzRm9yVGVzdCxcbiAgdHlwZSBXb3JrdHJlZUxpZmVjeWNsZURlcHMsXG4gIHR5cGUgTm90aWZ5Q3R4LFxufSBmcm9tIFwiLi4vd29ya3RyZWUtbGlmZWN5Y2xlLmpzXCI7XG5pbXBvcnQgeyBXb3JrdHJlZVN0YXRlUHJvamVjdGlvbiB9IGZyb20gXCIuLi93b3JrdHJlZS1zdGF0ZS1wcm9qZWN0aW9uLmpzXCI7XG5pbXBvcnQgeyB0eXBlIFRhc2tDb21taXRDb250ZXh0IH0gZnJvbSBcIi4uL3dvcmt0cmVlLmpzXCI7XG5pbXBvcnQgeyBNZXJnZUNvbmZsaWN0RXJyb3IgfSBmcm9tIFwiLi4vZ2l0LXNlcnZpY2UuanNcIjtcblxuLy8gQURSLTAxNiBwaGFzZSAyIC8gQy10cmFjayByZXRpcmVkIGFsbCB3b3JrdHJlZS1tYW5hZ2VyICsgY2FjaGUgKyBwcmVmc1xuLy8gZmllbGRzIGZyb20gYFdvcmt0cmVlTGlmZWN5Y2xlRGVwc2AuIFRlc3RzIHN0aWxsIHBhc3MgdGhlbSBhcyBvdmVycmlkZXNcbi8vIHZpYSB0aGUgc3RydWN0dXJhbC10eXBpbmcgZXNjYXBlIGhhdGNoIFx1MjAxNCBsaXN0ZWQgaGVyZSBhcyBvcHRpb25hbCBzb1xuLy8gZml4dHVyZXMgY2FuIHN0dWIgb3Igb21pdCB0aGVtLlxudHlwZSBMZWdhY3lUZXN0RGVwcyA9IFdvcmt0cmVlTGlmZWN5Y2xlRGVwcyAmIHtcbiAgZW50ZXJBdXRvV29ya3RyZWU/OiAoYmFzZVBhdGg6IHN0cmluZywgbWlsZXN0b25lSWQ6IHN0cmluZykgPT4gc3RyaW5nO1xuICBjcmVhdGVBdXRvV29ya3RyZWU/OiAoYmFzZVBhdGg6IHN0cmluZywgbWlsZXN0b25lSWQ6IHN0cmluZykgPT4gc3RyaW5nO1xuICBlbnRlckJyYW5jaE1vZGVGb3JNaWxlc3RvbmU/OiAoYmFzZVBhdGg6IHN0cmluZywgbWlsZXN0b25lSWQ6IHN0cmluZykgPT4gdm9pZDtcbiAgZ2V0QXV0b1dvcmt0cmVlUGF0aD86IChiYXNlUGF0aDogc3RyaW5nLCBtaWxlc3RvbmVJZDogc3RyaW5nKSA9PiBzdHJpbmcgfCBudWxsO1xuICBpc0luQXV0b1dvcmt0cmVlPzogKGJhc2VQYXRoOiBzdHJpbmcpID0+IGJvb2xlYW47XG4gIGF1dG9Xb3JrdHJlZUJyYW5jaD86IChtaWxlc3RvbmVJZDogc3RyaW5nKSA9PiBzdHJpbmc7XG4gIHRlYXJkb3duQXV0b1dvcmt0cmVlPzogKFxuICAgIGJhc2VQYXRoOiBzdHJpbmcsXG4gICAgbWlsZXN0b25lSWQ6IHN0cmluZyxcbiAgICBvcHRzPzogeyBwcmVzZXJ2ZUJyYW5jaD86IGJvb2xlYW4gfSxcbiAgKSA9PiB2b2lkO1xuICBzaG91bGRVc2VXb3JrdHJlZUlzb2xhdGlvbj86ICgpID0+IGJvb2xlYW47XG4gIHN5bmNXb3JrdHJlZVN0YXRlQmFjaz86IChcbiAgICBtYWluQmFzZVBhdGg6IHN0cmluZyxcbiAgICB3b3JrdHJlZVBhdGg6IHN0cmluZyxcbiAgICBtaWxlc3RvbmVJZDogc3RyaW5nLFxuICApID0+IHsgc3luY2VkOiBzdHJpbmdbXSB9O1xuICBjYXB0dXJlSW50ZWdyYXRpb25CcmFuY2g/OiAoYmFzZVBhdGg6IHN0cmluZywgbWlkOiBzdHJpbmcgfCB1bmRlZmluZWQpID0+IHZvaWQ7XG4gIGF1dG9Db21taXRDdXJyZW50QnJhbmNoPzogKFxuICAgIGJhc2VQYXRoOiBzdHJpbmcsXG4gICAgdW5pdFR5cGU6IHN0cmluZyxcbiAgICB1bml0SWQ6IHN0cmluZyxcbiAgICB0YXNrQ29udGV4dD86IFRhc2tDb21taXRDb250ZXh0LFxuICApID0+IHN0cmluZyB8IG51bGw7XG4gIGdldEN1cnJlbnRCcmFuY2g/OiAoYmFzZVBhdGg6IHN0cmluZykgPT4gc3RyaW5nO1xuICBjaGVja291dEJyYW5jaD86IChiYXNlUGF0aDogc3RyaW5nLCBicmFuY2g6IHN0cmluZykgPT4gdm9pZDtcbiAgcmVhZEZpbGVTeW5jPzogKHBhdGg6IHN0cmluZywgZW5jb2Rpbmc6IEJ1ZmZlckVuY29kaW5nKSA9PiBzdHJpbmc7XG4gIGdldElzb2xhdGlvbk1vZGU/OiAoYmFzZVBhdGg/OiBzdHJpbmcpID0+IFwid29ya3RyZWVcIiB8IFwiYnJhbmNoXCIgfCBcIm5vbmVcIjtcbiAgcmVzb2x2ZU1pbGVzdG9uZUZpbGU/OiAoXG4gICAgYmFzZVBhdGg6IHN0cmluZyxcbiAgICBtaWxlc3RvbmVJZDogc3RyaW5nLFxuICAgIGZpbGVUeXBlOiBzdHJpbmcsXG4gICkgPT4gc3RyaW5nIHwgbnVsbDtcbiAgR2l0U2VydmljZUltcGw/OiBuZXcgKGJhc2VQYXRoOiBzdHJpbmcsIGdpdENvbmZpZzogdW5rbm93bikgPT4gdW5rbm93bjtcbiAgbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzPzogKCkgPT5cbiAgICB8IHsgcHJlZmVyZW5jZXM/OiB7IGdpdD86IFJlY29yZDxzdHJpbmcsIHVua25vd24+IH0gfVxuICAgIHwgbnVsbFxuICAgIHwgdW5kZWZpbmVkO1xuICBpbnZhbGlkYXRlQWxsQ2FjaGVzPzogKCkgPT4gdm9pZDtcbn07XG5pbXBvcnQgeyBBdXRvU2Vzc2lvbiB9IGZyb20gXCIuLi9hdXRvL3Nlc3Npb24uanNcIjtcbmltcG9ydCB0eXBlIHsgSm91cm5hbEVudHJ5IH0gZnJvbSBcIi4uL2pvdXJuYWwuanNcIjtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEhlbHBlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIG1ha2VTZXNzaW9uKFxuICBvdmVycmlkZXM/OiBQYXJ0aWFsPHsgYmFzZVBhdGg6IHN0cmluZzsgb3JpZ2luYWxCYXNlUGF0aDogc3RyaW5nIH0+LFxuKTogQXV0b1Nlc3Npb24ge1xuICBjb25zdCBzID0gbmV3IEF1dG9TZXNzaW9uKCk7XG4gIHMuYmFzZVBhdGggPSBvdmVycmlkZXM/LmJhc2VQYXRoID8/IFwiL3Byb2plY3RcIjtcbiAgcy5vcmlnaW5hbEJhc2VQYXRoID0gb3ZlcnJpZGVzPy5vcmlnaW5hbEJhc2VQYXRoID8/IFwiL3Byb2plY3RcIjtcbiAgcmV0dXJuIHM7XG59XG5cbmZ1bmN0aW9uIG1ha2VEZXBzKFxuICBvdmVycmlkZXM/OiBQYXJ0aWFsPExlZ2FjeVRlc3REZXBzPixcbik6IExlZ2FjeVRlc3REZXBzIHtcbiAgLy8gQURSLTAxNiBwaGFzZSAyIC8gQy10cmFjayByZXRpcmVkIHRoZSB3b3JrdHJlZS1tYW5hZ2VyICsgY2FjaGUgKyBwcmVmc1xuICAvLyBwcmltaXRpdmVzIGZyb20gYFdvcmt0cmVlTGlmZWN5Y2xlRGVwc2AuIFRlc3RzIGluIHRoaXMgZmlsZSBkcml2ZVxuICAvLyBMaWZlY3ljbGUgYWdhaW5zdCByZWFsIGdpdCBmaXh0dXJlcyAoaW5pdEdpdFJlcG9JbikgXHUyMDE0IGRvIE5PVCBzdHViIHRoZVxuICAvLyBDLXRyYWNrIHByaW1pdGl2ZXMgaGVyZSwgb3IgdGhlIG92ZXJyaWRlIHBhdHRlcm4gd2lsbCBwcmUtZW1wdCB0aGVcbiAgLy8gcmVhbCBgZ2V0QXV0b1dvcmt0cmVlUGF0aGAgLyBgY3JlYXRlQXV0b1dvcmt0cmVlYCAvIGV0Yy4gYW5kIHRoZVxuICAvLyBzdWNjZXNzL2V4aXN0aW5nL2ZhaWx1cmUgYnJhbmNoZXMgd29uJ3QgZmlyZSBhcyBleHBlY3RlZC5cbiAgY29uc3QgZGVwczogTGVnYWN5VGVzdERlcHMgPSB7XG4gICAgbWVyZ2VNaWxlc3RvbmVUb01haW46ICgpID0+ICh7IHB1c2hlZDogZmFsc2UsIGNvZGVGaWxlc0NoYW5nZWQ6IHRydWUgfSksXG4gICAgd29ya3RyZWVQcm9qZWN0aW9uOiBuZXcgV29ya3RyZWVTdGF0ZVByb2plY3Rpb24oKSxcbiAgICAvLyBBRFItMDE2IHBoYXNlIDIgLyBDNCAoIzU2MjcpOiBHaXRTZXJ2aWNlSW1wbCBjb25zdHJ1Y3RvciBcdTIxOTIgZmFjdG9yeS5cbiAgICBnaXRTZXJ2aWNlRmFjdG9yeTogKCkgPT4gKHt9KSBhcyB1bmtub3duIGFzIFJldHVyblR5cGU8XG4gICAgICBXb3JrdHJlZUxpZmVjeWNsZURlcHNbXCJnaXRTZXJ2aWNlRmFjdG9yeVwiXVxuICAgID4sXG4gICAgLi4ub3ZlcnJpZGVzLFxuICB9O1xuICByZXR1cm4gZGVwcztcbn1cblxuZnVuY3Rpb24gbWFrZU5vdGlmeUN0eCgpOiBOb3RpZnlDdHgge1xuICByZXR1cm4ge1xuICAgIG5vdGlmeTogKCkgPT4ge30sXG4gIH07XG59XG5cbi8qKiBSZWFkIGFsbCBqb3VybmFsIGVudHJpZXMgZnJvbSBhIHRlbXAgLmdzZC9qb3VybmFsIGRpcmVjdG9yeS4gKi9cbmZ1bmN0aW9uIHJlYWRKb3VybmFsRW50cmllcyhiYXNlUGF0aDogc3RyaW5nKTogSm91cm5hbEVudHJ5W10ge1xuICBjb25zdCBqb3VybmFsRGlyID0gam9pbihiYXNlUGF0aCwgXCIuZ3NkXCIsIFwiam91cm5hbFwiKTtcbiAgdHJ5IHtcbiAgICBjb25zdCBmaWxlcyA9IHJlYWRkaXJTeW5jKGpvdXJuYWxEaXIpLmZpbHRlcihmID0+IGYuZW5kc1dpdGgoXCIuanNvbmxcIikpLnNvcnQoKTtcbiAgICBjb25zdCBlbnRyaWVzOiBKb3VybmFsRW50cnlbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgZmlsZSBvZiBmaWxlcykge1xuICAgICAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKGpvaW4oam91cm5hbERpciwgZmlsZSksIFwidXRmLThcIik7XG4gICAgICBmb3IgKGNvbnN0IGxpbmUgb2YgcmF3LnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgICAgIGlmICghbGluZS50cmltKCkpIGNvbnRpbnVlO1xuICAgICAgICBlbnRyaWVzLnB1c2goSlNPTi5wYXJzZShsaW5lKSBhcyBKb3VybmFsRW50cnkpO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gZW50cmllcztcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG59XG5cbmZ1bmN0aW9uIHNldHVwTWVyZ2VXb3JrdHJlZShiYXNlUGF0aDogc3RyaW5nLCBtaWxlc3RvbmVJZDogc3RyaW5nKTogc3RyaW5nIHtcbiAgaW5pdEdpdFJlcG9JbihiYXNlUGF0aCwgXCJ3b3JrdHJlZVwiKTtcbiAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcImNoZWNrb3V0XCIsIFwiLWJcIiwgYG1pbGVzdG9uZS8ke21pbGVzdG9uZUlkfWBdLCB7IGN3ZDogYmFzZVBhdGgsIHN0ZGlvOiBcInBpcGVcIiB9KTtcbiAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcImNoZWNrb3V0XCIsIFwibWFpblwiXSwgeyBjd2Q6IGJhc2VQYXRoLCBzdGRpbzogXCJwaXBlXCIgfSk7XG4gIGNvbnN0IHd0ID0gam9pbihiYXNlUGF0aCwgXCIuZ3NkXCIsIFwid29ya3RyZWVzXCIsIG1pbGVzdG9uZUlkKTtcbiAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcIndvcmt0cmVlXCIsIFwiYWRkXCIsIHd0LCBgbWlsZXN0b25lLyR7bWlsZXN0b25lSWR9YF0sIHsgY3dkOiBiYXNlUGF0aCwgc3RkaW86IFwicGlwZVwiIH0pO1xuICBta2RpclN5bmMoam9pbihiYXNlUGF0aCwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBtaWxlc3RvbmVJZCksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4oYmFzZVBhdGgsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgbWlsZXN0b25lSWQsIGAke21pbGVzdG9uZUlkfS1ST0FETUFQLm1kYCksXG4gICAgYCMgJHttaWxlc3RvbmVJZH1cXG4tIFt4XSBTMDE6IFNsaWNlIG9uZVxcbmAsXG4gICk7XG4gIHJldHVybiB3dDtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRlc3RzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcIndvcmt0cmVlIGpvdXJuYWwgZXZlbnRzXCIsICgpID0+IHtcbiAgbGV0IHRtcDogc3RyaW5nO1xuICBjb25zdCBvcmlnaW5hbEN3ZCA9IHByb2Nlc3MuY3dkKCk7XG5cbiAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgcmVzZXRSZWNlbnRXb3JrdHJlZU1lcmdlRmFpbHVyZXNGb3JUZXN0KCk7XG4gICAgLy8gcmVhbHBhdGhTeW5jIHRvIG1hdGNoIHdoYXQgYGF1dG8td29ya3RyZWUudHNgIHJldHVybnMgZnJvbVxuICAgIC8vIGByZXNvbHZlV29ya3RyZWVQcm9qZWN0Um9vdGAgKG1hY09TIHJlc29sdmVzIGAvdmFyYCBcdTIxOTIgYC9wcml2YXRlL3ZhcmApLlxuICAgIHRtcCA9IHJlYWxwYXRoU3luYyhta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcInd0LWpvdXJuYWwtXCIpKSk7XG4gIH0pO1xuICBhZnRlckVhY2goKCkgPT4ge1xuICAgIC8vIFJlc3RvcmUgY3dkIGJlZm9yZSBjbGVhbnVwIFx1MjAxNCBvbiBXaW5kb3dzLCBybVN5bmMgZmFpbHMgd2l0aCBFUEVSTVxuICAgIC8vIGlmIHRoZSBwcm9jZXNzIGN3ZCBpcyBpbnNpZGUgdGhlIGRpcmVjdG9yeSBiZWluZyBkZWxldGVkLlxuICAgIHRyeSB7IHByb2Nlc3MuY2hkaXIob3JpZ2luYWxDd2QpOyB9IGNhdGNoIHsgLyogYmVzdC1lZmZvcnQgKi8gfVxuICAgIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfSk7XG5cbiAgdGVzdChcImVudGVyTWlsZXN0b25lIGVtaXRzIHdvcmt0cmVlLWVudGVyIG9uIHN1Y2Nlc3MgKG5ldyB3b3JrdHJlZSlcIiwgKCkgPT4ge1xuICAgIGluaXRHaXRSZXBvSW4odG1wLCBcIndvcmt0cmVlXCIpO1xuICAgIGNvbnN0IHMgPSBtYWtlU2Vzc2lvbih7IGJhc2VQYXRoOiB0bXAsIG9yaWdpbmFsQmFzZVBhdGg6IHRtcCB9KTtcbiAgICBjb25zdCByZXN1bHQgPSBuZXcgV29ya3RyZWVMaWZlY3ljbGUocywgbWFrZURlcHMoKSkuZW50ZXJNaWxlc3RvbmUoXG4gICAgICBcIk0wMDFcIixcbiAgICAgIG1ha2VOb3RpZnlDdHgoKSxcbiAgICApO1xuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIHJlc3VsdC5vayxcbiAgICAgIHRydWUsXG4gICAgICBgZW50ZXJNaWxlc3RvbmUgZmFpbGVkOiAke0pTT04uc3RyaW5naWZ5KHJlc3VsdCl9YCxcbiAgICApO1xuXG4gICAgY29uc3QgZW50cmllcyA9IHJlYWRKb3VybmFsRW50cmllcyh0bXApO1xuICAgIGNvbnN0IGVudGVyID0gZW50cmllcy5maW5kKGUgPT4gZS5ldmVudFR5cGUgPT09IFwid29ya3RyZWUtZW50ZXJcIik7XG4gICAgYXNzZXJ0Lm9rKGVudGVyLCBcIndvcmt0cmVlLWVudGVyIGV2ZW50IHNob3VsZCBiZSBlbWl0dGVkXCIpO1xuICAgIGFzc2VydC5lcXVhbChlbnRlciEuZGF0YT8ubWlsZXN0b25lSWQsIFwiTTAwMVwiKTtcbiAgICBhc3NlcnQuZXF1YWwoZW50ZXIhLmRhdGE/LmNyZWF0ZWQsIHRydWUpO1xuICAgIGFzc2VydC5vayhlbnRlciEuZGF0YT8ud3RQYXRoKTtcbiAgfSk7XG5cbiAgdGVzdChcImVudGVyTWlsZXN0b25lIGVtaXRzIHdvcmt0cmVlLWVudGVyIHdpdGggY3JlYXRlZD1mYWxzZSBmb3IgZXhpc3Rpbmcgd29ya3RyZWVcIiwgKCkgPT4ge1xuICAgIC8vIFByZS1jcmVhdGUgdGhlIHdvcmt0cmVlIG9uIGRpc2sgc28gdGhlIHNlY29uZCBlbnRlciBnb2VzIHRocm91Z2ggdGhlXG4gICAgLy8gZXhpc3Rpbmctd29ya3RyZWUgYnJhbmNoIGluIGBfZW50ZXJNaWxlc3RvbmVDb3JlYC5cbiAgICBpbml0R2l0UmVwb0luKHRtcCwgXCJ3b3JrdHJlZVwiKTtcbiAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiY2hlY2tvdXRcIiwgXCItYlwiLCBcIm1pbGVzdG9uZS9NMDAxXCJdLCB7IGN3ZDogdG1wLCBzdGRpbzogXCJwaXBlXCIgfSk7XG4gICAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcImNoZWNrb3V0XCIsIFwibWFpblwiXSwgeyBjd2Q6IHRtcCwgc3RkaW86IFwicGlwZVwiIH0pO1xuICAgIGV4ZWNGaWxlU3luYyhcbiAgICAgIFwiZ2l0XCIsXG4gICAgICBbXCJ3b3JrdHJlZVwiLCBcImFkZFwiLCBqb2luKHRtcCwgXCIuZ3NkXCIsIFwid29ya3RyZWVzXCIsIFwiTTAwMVwiKSwgXCJtaWxlc3RvbmUvTTAwMVwiXSxcbiAgICAgIHsgY3dkOiB0bXAsIHN0ZGlvOiBcInBpcGVcIiB9LFxuICAgICk7XG5cbiAgICBjb25zdCBzID0gbWFrZVNlc3Npb24oeyBiYXNlUGF0aDogdG1wLCBvcmlnaW5hbEJhc2VQYXRoOiB0bXAgfSk7XG4gICAgbmV3IFdvcmt0cmVlTGlmZWN5Y2xlKHMsIG1ha2VEZXBzKCkpLmVudGVyTWlsZXN0b25lKFwiTTAwMVwiLCBtYWtlTm90aWZ5Q3R4KCkpO1xuXG4gICAgY29uc3QgZW50cmllcyA9IHJlYWRKb3VybmFsRW50cmllcyh0bXApO1xuICAgIGNvbnN0IGVudGVyID0gZW50cmllcy5maW5kKGUgPT4gZS5ldmVudFR5cGUgPT09IFwid29ya3RyZWUtZW50ZXJcIik7XG4gICAgYXNzZXJ0Lm9rKGVudGVyLCBcIndvcmt0cmVlLWVudGVyIGV2ZW50IHNob3VsZCBiZSBlbWl0dGVkXCIpO1xuICAgIGFzc2VydC5lcXVhbChlbnRlciEuZGF0YT8uY3JlYXRlZCwgZmFsc2UpO1xuICB9KTtcblxuICB0ZXN0KFwiZW50ZXJNaWxlc3RvbmUgZW1pdHMgd29ya3RyZWUtc2tpcCB3aGVuIGlzb2xhdGlvbiBkaXNhYmxlZFwiLCAoKSA9PiB7XG4gICAgaW5pdEdpdFJlcG9Jbih0bXAsIFwibm9uZVwiKTtcbiAgICBjb25zdCBzID0gbWFrZVNlc3Npb24oeyBiYXNlUGF0aDogdG1wLCBvcmlnaW5hbEJhc2VQYXRoOiB0bXAgfSk7XG4gICAgbmV3IFdvcmt0cmVlTGlmZWN5Y2xlKHMsIG1ha2VEZXBzKCkpLmVudGVyTWlsZXN0b25lKFwiTTAwMVwiLCBtYWtlTm90aWZ5Q3R4KCkpO1xuXG4gICAgY29uc3QgZW50cmllcyA9IHJlYWRKb3VybmFsRW50cmllcyh0bXApO1xuICAgIGNvbnN0IHNraXAgPSBlbnRyaWVzLmZpbmQoZSA9PiBlLmV2ZW50VHlwZSA9PT0gXCJ3b3JrdHJlZS1za2lwXCIpO1xuICAgIGFzc2VydC5vayhza2lwLCBcIndvcmt0cmVlLXNraXAgZXZlbnQgc2hvdWxkIGJlIGVtaXR0ZWRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHNraXAhLmRhdGE/Lm1pbGVzdG9uZUlkLCBcIk0wMDFcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHNraXAhLmRhdGE/LnJlYXNvbiwgXCJpc29sYXRpb24tZGlzYWJsZWRcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJlbnRlck1pbGVzdG9uZSBlbWl0cyB3b3JrdHJlZS1jcmVhdGUtZmFpbGVkIG9uIGVycm9yXCIsICgpID0+IHtcbiAgICAvLyBSZWFsIGZpeHR1cmUgd2l0aCBpc29sYXRpb246d29ya3RyZWUsIHRoZW4gZGVsZXRlIC5naXQgdG8gZm9yY2UgdGhlXG4gICAgLy8gcmVhbCBjcmVhdGVBdXRvV29ya3RyZWUgdG8gdGhyb3cuXG4gICAgaW5pdEdpdFJlcG9Jbih0bXAsIFwid29ya3RyZWVcIik7XG4gICAgcm1TeW5jKGpvaW4odG1wLCBcIi5naXRcIiksIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICBjb25zdCBzID0gbWFrZVNlc3Npb24oeyBiYXNlUGF0aDogdG1wLCBvcmlnaW5hbEJhc2VQYXRoOiB0bXAgfSk7XG4gICAgbmV3IFdvcmt0cmVlTGlmZWN5Y2xlKHMsIG1ha2VEZXBzKCkpLmVudGVyTWlsZXN0b25lKFwiTTAwMVwiLCBtYWtlTm90aWZ5Q3R4KCkpO1xuXG4gICAgY29uc3QgZW50cmllcyA9IHJlYWRKb3VybmFsRW50cmllcyh0bXApO1xuICAgIGNvbnN0IGZhaWxlZCA9IGVudHJpZXMuZmluZChlID0+IGUuZXZlbnRUeXBlID09PSBcIndvcmt0cmVlLWNyZWF0ZS1mYWlsZWRcIik7XG4gICAgYXNzZXJ0Lm9rKGZhaWxlZCwgXCJ3b3JrdHJlZS1jcmVhdGUtZmFpbGVkIGV2ZW50IHNob3VsZCBiZSBlbWl0dGVkXCIpO1xuICAgIGFzc2VydC5lcXVhbChmYWlsZWQhLmRhdGE/Lm1pbGVzdG9uZUlkLCBcIk0wMDFcIik7XG4gICAgYXNzZXJ0Lm9rKGZhaWxlZCEuZGF0YT8uZXJyb3IsIFwiZXJyb3IgbWVzc2FnZSBzaG91bGQgYmUgcHJlc2VudFwiKTtcbiAgICBhc3NlcnQuZXF1YWwoZmFpbGVkIS5kYXRhPy5mYWxsYmFjaywgXCJwcm9qZWN0LXJvb3RcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJtZXJnZUFuZEV4aXQgZW1pdHMgd29ya3RyZWUtbWVyZ2Utc3RhcnRcIiwgKCkgPT4ge1xuICAgIGluaXRHaXRSZXBvSW4odG1wLCBcIndvcmt0cmVlXCIpO1xuICAgIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJjaGVja291dFwiLCBcIi1iXCIsIFwibWlsZXN0b25lL00wMDFcIl0sIHsgY3dkOiB0bXAsIHN0ZGlvOiBcInBpcGVcIiB9KTtcbiAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiY2hlY2tvdXRcIiwgXCJtYWluXCJdLCB7IGN3ZDogdG1wLCBzdGRpbzogXCJwaXBlXCIgfSk7XG4gICAgY29uc3Qgd3QgPSBqb2luKHRtcCwgXCIuZ3NkXCIsIFwid29ya3RyZWVzXCIsIFwiTTAwMVwiKTtcbiAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wid29ya3RyZWVcIiwgXCJhZGRcIiwgd3QsIFwibWlsZXN0b25lL00wMDFcIl0sIHsgY3dkOiB0bXAsIHN0ZGlvOiBcInBpcGVcIiB9KTtcblxuICAgIGNvbnN0IHMgPSBtYWtlU2Vzc2lvbih7IGJhc2VQYXRoOiB3dCwgb3JpZ2luYWxCYXNlUGF0aDogdG1wIH0pO1xuICAgIGNvbnN0IGRlcHMgPSBtYWtlRGVwcygpO1xuICAgIHByb2Nlc3MuY2hkaXIod3QpO1xuICAgIG5ldyBXb3JrdHJlZUxpZmVjeWNsZShzLCBkZXBzKS5leGl0TWlsZXN0b25lKFxuICAgICAgXCJNMDAxXCIsXG4gICAgICB7IG1lcmdlOiB0cnVlIH0sXG4gICAgICBtYWtlTm90aWZ5Q3R4KCksXG4gICAgKTtcblxuICAgIGNvbnN0IGVudHJpZXMgPSByZWFkSm91cm5hbEVudHJpZXModG1wKTtcbiAgICBjb25zdCBzdGFydCA9IGVudHJpZXMuZmluZChlID0+IGUuZXZlbnRUeXBlID09PSBcIndvcmt0cmVlLW1lcmdlLXN0YXJ0XCIpO1xuICAgIGFzc2VydC5vayhzdGFydCwgXCJ3b3JrdHJlZS1tZXJnZS1zdGFydCBldmVudCBzaG91bGQgYmUgZW1pdHRlZFwiKTtcbiAgICBhc3NlcnQuZXF1YWwoc3RhcnQhLmRhdGE/Lm1pbGVzdG9uZUlkLCBcIk0wMDFcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHN0YXJ0IS5kYXRhPy5tb2RlLCBcIndvcmt0cmVlXCIpO1xuICB9KTtcblxuICB0ZXN0KFwiZXhpdE1pbGVzdG9uZSBwcm9wYWdhdGVzIGNvZGVGaWxlc0NoYW5nZWQgZnJvbSBtZXJnZSByZXN1bHRcIiwgKCkgPT4ge1xuICAgIGluaXRHaXRSZXBvSW4odG1wLCBcIndvcmt0cmVlXCIpO1xuICAgIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJjaGVja291dFwiLCBcIi1iXCIsIFwibWlsZXN0b25lL00wMDFcIl0sIHsgY3dkOiB0bXAsIHN0ZGlvOiBcInBpcGVcIiB9KTtcbiAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiY2hlY2tvdXRcIiwgXCJtYWluXCJdLCB7IGN3ZDogdG1wLCBzdGRpbzogXCJwaXBlXCIgfSk7XG4gICAgY29uc3Qgd3QgPSBqb2luKHRtcCwgXCIuZ3NkXCIsIFwid29ya3RyZWVzXCIsIFwiTTAwMVwiKTtcbiAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wid29ya3RyZWVcIiwgXCJhZGRcIiwgd3QsIFwibWlsZXN0b25lL00wMDFcIl0sIHsgY3dkOiB0bXAsIHN0ZGlvOiBcInBpcGVcIiB9KTtcbiAgICBta2RpclN5bmMoam9pbih0bXAsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbih0bXAsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwiTTAwMS1ST0FETUFQLm1kXCIpLFxuICAgICAgXCIjIE0wMDFcXG4tIFt4XSBTMDE6IFNsaWNlIG9uZVxcblwiLFxuICAgICk7XG5cbiAgICBjb25zdCBzID0gbWFrZVNlc3Npb24oeyBiYXNlUGF0aDogd3QsIG9yaWdpbmFsQmFzZVBhdGg6IHRtcCB9KTtcbiAgICBjb25zdCBkZXBzID0gbWFrZURlcHMoe1xuICAgICAgbWVyZ2VNaWxlc3RvbmVUb01haW46ICgpID0+ICh7IHB1c2hlZDogZmFsc2UsIGNvZGVGaWxlc0NoYW5nZWQ6IHRydWUgfSksXG4gICAgfSk7XG4gICAgcHJvY2Vzcy5jaGRpcih3dCk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBuZXcgV29ya3RyZWVMaWZlY3ljbGUocywgZGVwcykuZXhpdE1pbGVzdG9uZShcbiAgICAgIFwiTTAwMVwiLFxuICAgICAgeyBtZXJnZTogdHJ1ZSB9LFxuICAgICAgbWFrZU5vdGlmeUN0eCgpLFxuICAgICk7XG5cbiAgICBhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdCwge1xuICAgICAgb2s6IHRydWUsXG4gICAgICBtZXJnZWQ6IHRydWUsXG4gICAgICBjb2RlRmlsZXNDaGFuZ2VkOiB0cnVlLFxuICAgIH0pO1xuICB9KTtcblxuICB0ZXN0KFwibWVyZ2VBbmRFeGl0IGVtaXRzIHdvcmt0cmVlLW1lcmdlLWZhaWxlZCBvbiBlcnJvclwiLCAoKSA9PiB7XG4gICAgY29uc3Qgd3QgPSBzZXR1cE1lcmdlV29ya3RyZWUodG1wLCBcIk0wMDFcIik7XG4gICAgY29uc3QgcyA9IG1ha2VTZXNzaW9uKHsgYmFzZVBhdGg6IHd0LCBvcmlnaW5hbEJhc2VQYXRoOiB0bXAgfSk7XG4gICAgY29uc3QgZGVwcyA9IG1ha2VEZXBzKHtcbiAgICAgIG1lcmdlTWlsZXN0b25lVG9NYWluOiAoKSA9PiB7IHRocm93IG5ldyBFcnJvcihcImNvbmZsaWN0IGluIG1haW5cIik7IH0sXG4gICAgfSk7XG4gICAgLy8gU2luY2UgIzQzODAsIG1lcmdlQW5kRXhpdCByZS10aHJvd3MgYWxsIGVycm9ycyBhZnRlciBlbWl0dGluZyB0aGUgam91cm5hbFxuICAgIC8vIGV2ZW50IGFuZCByZXN0b3Jpbmcgc3RhdGUuIExpZmVjeWNsZSBub3cgd3JhcHMgdGhhdCB0aHJvdyBpbiBhIHR5cGVkXG4gICAgLy8gRXhpdFJlc3VsdCBcdTIwMTQgZmFpbHVyZSBzdXJmYWNlcyBhcyBvazpmYWxzZSAvIGNhdXNlLlxuICAgIGNvbnN0IHJlc3VsdCA9IG5ldyBXb3JrdHJlZUxpZmVjeWNsZShzLCBkZXBzKS5leGl0TWlsZXN0b25lKFxuICAgICAgXCJNMDAxXCIsXG4gICAgICB7IG1lcmdlOiB0cnVlIH0sXG4gICAgICBtYWtlTm90aWZ5Q3R4KCksXG4gICAgKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm9rLCBmYWxzZSk7XG4gICAgaWYgKCFyZXN1bHQub2spIHtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHQucmVhc29uLCBcInRlYXJkb3duLWZhaWxlZFwiKTtcbiAgICAgIGFzc2VydC5tYXRjaChcbiAgICAgICAgcmVzdWx0LmNhdXNlIGluc3RhbmNlb2YgRXJyb3JcbiAgICAgICAgICA/IHJlc3VsdC5jYXVzZS5tZXNzYWdlXG4gICAgICAgICAgOiBTdHJpbmcocmVzdWx0LmNhdXNlKSxcbiAgICAgICAgL2NvbmZsaWN0IGluIG1haW4vLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBuZXcgV29ya3RyZWVMaWZlY3ljbGUocywgZGVwcykuZXhpdE1pbGVzdG9uZShcbiAgICAgIFwiTTAwMVwiLFxuICAgICAgeyBtZXJnZTogdHJ1ZSB9LFxuICAgICAgbWFrZU5vdGlmeUN0eCgpLFxuICAgICk7XG5cbiAgICBjb25zdCBlbnRyaWVzID0gcmVhZEpvdXJuYWxFbnRyaWVzKHRtcCk7XG4gICAgY29uc3QgZmFpbHVyZXMgPSBlbnRyaWVzLmZpbHRlcihlID0+IGUuZXZlbnRUeXBlID09PSBcIndvcmt0cmVlLW1lcmdlLWZhaWxlZFwiKTtcbiAgICBjb25zdCBmYWlsZWQgPSBmYWlsdXJlc1swXTtcbiAgICBhc3NlcnQub2soZmFpbGVkLCBcIndvcmt0cmVlLW1lcmdlLWZhaWxlZCBldmVudCBzaG91bGQgYmUgZW1pdHRlZFwiKTtcbiAgICBhc3NlcnQuZXF1YWwoZmFpbGVkIS5kYXRhPy5taWxlc3RvbmVJZCwgXCJNMDAxXCIpO1xuICAgIGFzc2VydC5lcXVhbChmYWlsZWQhLmRhdGE/LmVycm9yLCBcImNvbmZsaWN0IGluIG1haW5cIik7XG4gICAgYXNzZXJ0LmVxdWFsKGZhaWx1cmVzLmxlbmd0aCwgMSwgXCJkdXBsaWNhdGUgbWVyZ2UgZmFpbHVyZXMgYXJlIGpvdXJuYWxlZCBvbmNlXCIpO1xuICB9KTtcblxuICB0ZXN0KFwibWVyZ2UgZmFpbHVyZSBkZWR1cGUgdXNlcyBzdGFibGUgY29uZmxpY3QgY2F0ZWdvcnkgYW5kIGV4cGlyZXNcIiwgKHQpID0+IHtcbiAgICBsZXQgbm93ID0gMV8wMDBfMDAwO1xuICAgIHQubW9jay5tZXRob2QoRGF0ZSwgXCJub3dcIiwgKCkgPT4gbm93KTtcbiAgICBjb25zdCB3dCA9IHNldHVwTWVyZ2VXb3JrdHJlZSh0bXAsIFwiTTAwMVwiKTtcbiAgICBjb25zdCBzID0gbWFrZVNlc3Npb24oeyBiYXNlUGF0aDogd3QsIG9yaWdpbmFsQmFzZVBhdGg6IHRtcCB9KTtcbiAgICBsZXQgYXR0ZW1wdCA9IDA7XG4gICAgY29uc3QgZGVwcyA9IG1ha2VEZXBzKHtcbiAgICAgIG1lcmdlTWlsZXN0b25lVG9NYWluOiAoKSA9PiB7XG4gICAgICAgIGF0dGVtcHQgKz0gMTtcbiAgICAgICAgdGhyb3cgbmV3IE1lcmdlQ29uZmxpY3RFcnJvcihcbiAgICAgICAgICBhdHRlbXB0ID09PSAxID8gW1wic3JjL2EudHNcIl0gOiBbXCJzcmMvYi50c1wiLCBcInNyYy9jLnRzXCJdLFxuICAgICAgICAgIFwic3F1YXNoXCIsXG4gICAgICAgICAgXCJtaWxlc3RvbmUvTTAwMVwiLFxuICAgICAgICAgIFwibWFpblwiLFxuICAgICAgICApO1xuICAgICAgfSxcbiAgICB9KTtcbiAgICBjb25zdCBsaWZlY3ljbGUgPSBuZXcgV29ya3RyZWVMaWZlY3ljbGUocywgZGVwcyk7XG5cbiAgICBsaWZlY3ljbGUuZXhpdE1pbGVzdG9uZShcIk0wMDFcIiwgeyBtZXJnZTogdHJ1ZSB9LCBtYWtlTm90aWZ5Q3R4KCkpO1xuICAgIGxpZmVjeWNsZS5leGl0TWlsZXN0b25lKFwiTTAwMVwiLCB7IG1lcmdlOiB0cnVlIH0sIG1ha2VOb3RpZnlDdHgoKSk7XG5cbiAgICBsZXQgZmFpbHVyZXMgPSByZWFkSm91cm5hbEVudHJpZXModG1wKS5maWx0ZXIoZSA9PiBlLmV2ZW50VHlwZSA9PT0gXCJ3b3JrdHJlZS1tZXJnZS1mYWlsZWRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGZhaWx1cmVzLmxlbmd0aCwgMSwgXCJ2YXJpYWJsZSBjb25mbGljdCBmaWxlbmFtZXMgc2hvdWxkIG5vdCBieXBhc3MgZGVkdXBlXCIpO1xuICAgIGFzc2VydC5tYXRjaChcbiAgICAgIFN0cmluZyhmYWlsdXJlc1swXSEuZGF0YT8uZXJyb3IpLFxuICAgICAgL3NyY1xcL2FcXC50cy8sXG4gICAgICBcImpvdXJuYWwgcGF5bG9hZCBrZWVwcyB0aGUgb3JpZ2luYWwgZXJyb3IgbWVzc2FnZVwiLFxuICAgICk7XG5cbiAgICBub3cgKz0gNjBfMDAxO1xuICAgIGxpZmVjeWNsZS5leGl0TWlsZXN0b25lKFwiTTAwMVwiLCB7IG1lcmdlOiB0cnVlIH0sIG1ha2VOb3RpZnlDdHgoKSk7XG5cbiAgICBmYWlsdXJlcyA9IHJlYWRKb3VybmFsRW50cmllcyh0bXApLmZpbHRlcihlID0+IGUuZXZlbnRUeXBlID09PSBcIndvcmt0cmVlLW1lcmdlLWZhaWxlZFwiKTtcbiAgICBhc3NlcnQuZXF1YWwoZmFpbHVyZXMubGVuZ3RoLCAyLCBcInNhbWUgbWVyZ2UgZmFpbHVyZSBpcyBqb3VybmFsZWQgYWdhaW4gYWZ0ZXIgZGVkdXBlIGV4cGlyeVwiKTtcbiAgfSk7XG5cbiAgdGVzdChcImpvdXJuYWwgZW50cmllcyBoYXZlIHZhbGlkIGZsb3dJZCwgc2VxLCBhbmQgdHMgZmllbGRzXCIsICgpID0+IHtcbiAgICBjb25zdCBzID0gbWFrZVNlc3Npb24oeyBiYXNlUGF0aDogdG1wLCBvcmlnaW5hbEJhc2VQYXRoOiB0bXAgfSk7XG4gICAgY29uc3QgZGVwcyA9IG1ha2VEZXBzKHsgc2hvdWxkVXNlV29ya3RyZWVJc29sYXRpb246ICgpID0+IGZhbHNlIH0pO1xuICAgIG5ldyBXb3JrdHJlZUxpZmVjeWNsZShzLCBkZXBzKS5lbnRlck1pbGVzdG9uZShcIk0wMDFcIiwgbWFrZU5vdGlmeUN0eCgpKTtcblxuICAgIGNvbnN0IGVudHJpZXMgPSByZWFkSm91cm5hbEVudHJpZXModG1wKTtcbiAgICBhc3NlcnQub2soZW50cmllcy5sZW5ndGggPiAwLCBcImF0IGxlYXN0IG9uZSBlbnRyeSBzaG91bGQgZXhpc3RcIik7XG4gICAgY29uc3QgZW50cnkgPSBlbnRyaWVzWzBdO1xuICAgIGFzc2VydC5vayhlbnRyeS5mbG93SWQsIFwiZmxvd0lkIHNob3VsZCBiZSBzZXRcIik7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgL15bMC05YS1mXXs4fS1bMC05YS1mXXs0fS1bMC05YS1mXXs0fS1bMC05YS1mXXs0fS1bMC05YS1mXXsxMn0kLy50ZXN0KGVudHJ5LmZsb3dJZCksXG4gICAgICBcImZsb3dJZCBzaG91bGQgYmUgYSB2YWxpZCBVVUlEXCIsXG4gICAgKTtcbiAgICBhc3NlcnQuZXF1YWwoZW50cnkuc2VxLCAwKTtcbiAgICBhc3NlcnQub2soZW50cnkudHMsIFwidHMgc2hvdWxkIGJlIHNldFwiKTtcbiAgICBhc3NlcnQub2soIWlzTmFOKERhdGUucGFyc2UoZW50cnkudHMpKSwgXCJ0cyBzaG91bGQgYmUgYSB2YWxpZCBJU08gZGF0ZVwiKTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsVUFBVSxNQUFNLFlBQVksaUJBQWlCO0FBQ3RELE9BQU8sWUFBWTtBQUNuQixTQUFTLFdBQVcsYUFBYSxRQUFRLGNBQWMsYUFBYSxjQUFjLHFCQUFxQjtBQUN2RyxTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsb0JBQW9CO0FBUTdCLFNBQVMsY0FBYyxNQUFjLFdBQWlEO0FBQ3BGLFFBQU0sTUFBTSxDQUFDLFNBQXlCO0FBQ3BDLGlCQUFhLE9BQU8sTUFBTSxFQUFFLEtBQUssTUFBTSxPQUFPLE9BQU8sQ0FBQztBQUFBLEVBQ3hEO0FBQ0EsTUFBSSxDQUFDLFFBQVEsTUFBTSxNQUFNLENBQUM7QUFDMUIsTUFBSSxDQUFDLFVBQVUsY0FBYyxlQUFlLENBQUM7QUFDN0MsTUFBSSxDQUFDLFVBQVUsYUFBYSxNQUFNLENBQUM7QUFDbkMsZ0JBQWMsS0FBSyxNQUFNLFdBQVcsR0FBRyxVQUFVO0FBQ2pELGdCQUFjLEtBQUssTUFBTSxZQUFZLEdBQUcsbUJBQW1CO0FB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
