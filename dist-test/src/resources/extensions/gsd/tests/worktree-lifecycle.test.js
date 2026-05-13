import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  WorktreeLifecycle,
  resolvePausedResumeBasePath
} from "../worktree-lifecycle.js";
import { WorktreeStateProjection } from "../worktree-state-projection.js";
import { AutoSession } from "../auto/session.js";
import { openDatabase, closeDatabase, insertMilestone } from "../gsd-db.js";
import { registerAutoWorker } from "../db/auto-workers.js";
import { claimMilestoneLease } from "../db/milestone-leases.js";
function makeSession(overrides) {
  const s = new AutoSession();
  s.basePath = overrides?.basePath ?? "/project";
  s.originalBasePath = overrides?.originalBasePath ?? "/project";
  Object.assign(s, overrides);
  return s;
}
function makeDeps(overrides) {
  const calls = [];
  const deps = {
    calls,
    gitServiceFactory: (basePath) => {
      calls.push({ fn: "gitServiceFactory", args: [basePath] });
      return { basePath };
    },
    worktreeProjection: new WorktreeStateProjection(),
    // Legacy stubs — Lifecycle no longer reads these post-C2; preserved as
    // no-ops so existing test fixtures keep type-checking.
    isInAutoWorktree: () => false,
    autoCommitCurrentBranch: (basePath, unitType, unitId, taskContext) => {
      calls.push({ fn: "autoCommitCurrentBranch", args: [basePath, unitType, unitId, taskContext] });
      return null;
    },
    autoWorktreeBranch: (mid) => `milestone/${mid}`,
    teardownAutoWorktree: () => {
    },
    mergeMilestoneToMain: () => ({ pushed: false, codeFilesChanged: true }),
    ...overrides
  };
  return deps;
}
function makeGitRepoBase(opts) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-lifecycle-git-")));
  const git = (args) => {
    execFileSync("git", args, { cwd: base, stdio: "pipe" });
  };
  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@test.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(join(base, "README.md"), "# test\n");
  writeFileSync(join(base, ".gitignore"), ".gsd/worktrees/\n");
  mkdirSync(join(base, ".gsd"), { recursive: true });
  if (opts?.isolation && opts.isolation !== "none") {
    writeFileSync(
      join(base, ".gsd", "preferences.md"),
      `## Git
- isolation: ${opts.isolation}
`
    );
  }
  git(["add", "."]);
  git(["commit", "-m", "init"]);
  return base;
}
function cleanupRepoBase(base, previousCwd) {
  try {
    closeDatabase();
  } catch {
  }
  try {
    if (previousCwd) process.chdir(previousCwd);
  } catch {
  }
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
  }
}
function makeCtx() {
  const messages = [];
  return {
    messages,
    notify: (msg, level) => {
      messages.push({ msg, level });
    }
  };
}
function makeDbBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-lifecycle-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}
function cleanupDbBase(base) {
  try {
    closeDatabase();
  } catch {
  }
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
  }
}
test("enterMilestone returns ok:true mode:worktree on successful create", (t) => {
  const previousCwd = process.cwd();
  const base = makeGitRepoBase({ isolation: "worktree" });
  t.after(() => cleanupRepoBase(base, previousCwd));
  const s = makeSession({ basePath: base, originalBasePath: base });
  const deps = makeDeps();
  const ctx = makeCtx();
  const lifecycle = new WorktreeLifecycle(s, deps);
  const result = lifecycle.enterMilestone("M001", ctx);
  assert.equal(result.ok, true, `expected ok:true, got: ${JSON.stringify(result)}`);
  if (result.ok) {
    assert.equal(result.mode, "worktree");
    assert.ok(
      result.path.endsWith("/.gsd/worktrees/M001"),
      `expected path to end with /.gsd/worktrees/M001, got ${result.path}`
    );
  }
  assert.ok(
    s.basePath.endsWith("/.gsd/worktrees/M001"),
    `expected s.basePath to end with /.gsd/worktrees/M001, got ${s.basePath}`
  );
});
test("enterMilestone returns ok:true mode:branch on successful branch fallback", (t) => {
  const previousCwd = process.cwd();
  const base = makeGitRepoBase({ isolation: "branch" });
  t.after(() => cleanupRepoBase(base, previousCwd));
  const s = makeSession({ basePath: base, originalBasePath: base });
  const deps = makeDeps({ getIsolationMode: () => "branch" });
  const ctx = makeCtx();
  const lifecycle = new WorktreeLifecycle(s, deps);
  const result = lifecycle.enterMilestone("M001", ctx);
  assert.equal(result.ok, true, `expected ok:true, got: ${JSON.stringify(result)}`);
  if (result.ok) {
    assert.equal(result.mode, "branch");
    assert.equal(result.path, base);
  }
  assert.equal(s.basePath, base);
});
test("enterMilestone returns ok:true mode:none when isolation disabled", () => {
  const s = makeSession();
  const deps = makeDeps({ getIsolationMode: () => "none" });
  const ctx = makeCtx();
  const lifecycle = new WorktreeLifecycle(s, deps);
  const result = lifecycle.enterMilestone("M001", ctx);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.mode, "none");
    assert.equal(result.path, "/project");
  }
  assert.equal(s.basePath, "/project");
});
test("enterMilestone returns ok:false reason:isolation-degraded when session degraded", () => {
  const s = makeSession({ isolationDegraded: true });
  const deps = makeDeps();
  const ctx = makeCtx();
  const lifecycle = new WorktreeLifecycle(s, deps);
  const result = lifecycle.enterMilestone("M001", ctx);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "isolation-degraded");
  }
  assert.equal(s.basePath, "/project");
  assert.equal(s.milestoneLeaseToken, null);
  assert.equal(deps.calls.filter((c) => c.fn === "getIsolationMode").length, 0);
});
test("enterMilestone returns ok:false reason:creation-failed and degrades session on worktree throw", (t) => {
  const previousCwd = process.cwd();
  const base = makeGitRepoBase({ isolation: "worktree" });
  t.after(() => cleanupRepoBase(base, previousCwd));
  rmSync(join(base, ".git"), { recursive: true, force: true });
  const s = makeSession({ basePath: base, originalBasePath: base });
  const deps = makeDeps();
  const ctx = makeCtx();
  const lifecycle = new WorktreeLifecycle(s, deps);
  const result = lifecycle.enterMilestone("M001", ctx);
  assert.equal(result.ok, false, `expected ok:false, got: ${JSON.stringify(result)}`);
  if (!result.ok) {
    assert.equal(result.reason, "creation-failed");
    assert.ok(result.cause instanceof Error);
  }
  assert.equal(s.isolationDegraded, true);
  assert.equal(s.basePath, base);
});
test("enterMilestone returns ok:false reason:creation-failed when branch mode throws", (t) => {
  const previousCwd = process.cwd();
  const base = makeGitRepoBase({ isolation: "branch" });
  t.after(() => cleanupRepoBase(base, previousCwd));
  rmSync(join(base, ".git"), { recursive: true, force: true });
  const s = makeSession({ basePath: base, originalBasePath: base });
  const deps = makeDeps({ getIsolationMode: () => "branch" });
  const ctx = makeCtx();
  const lifecycle = new WorktreeLifecycle(s, deps);
  const result = lifecycle.enterMilestone("M001", ctx);
  assert.equal(result.ok, false, `expected ok:false, got: ${JSON.stringify(result)}`);
  if (!result.ok) {
    assert.equal(result.reason, "creation-failed");
  }
  assert.equal(s.isolationDegraded, true);
});
test("enterMilestone enters existing worktree when path resolves", (t) => {
  const previousCwd = process.cwd();
  const base = makeGitRepoBase({ isolation: "worktree" });
  t.after(() => cleanupRepoBase(base, previousCwd));
  const wt = join(base, ".gsd", "worktrees", "M001");
  execFileSync("git", ["checkout", "-b", "milestone/M001"], {
    cwd: base,
    stdio: "pipe"
  });
  execFileSync("git", ["checkout", "main"], { cwd: base, stdio: "pipe" });
  execFileSync(
    "git",
    ["worktree", "add", wt, "milestone/M001"],
    { cwd: base, stdio: "pipe" }
  );
  const s = makeSession({ basePath: base, originalBasePath: base });
  const deps = makeDeps();
  const ctx = makeCtx();
  const lifecycle = new WorktreeLifecycle(s, deps);
  const result = lifecycle.enterMilestone("M001", ctx);
  assert.equal(result.ok, true, `expected ok:true, got: ${JSON.stringify(result)}`);
  if (result.ok) {
    assert.equal(result.mode, "worktree");
    assert.ok(
      result.path.endsWith("/.gsd/worktrees/M001"),
      `expected path to end with /.gsd/worktrees/M001, got ${result.path}`
    );
  }
});
test("enterMilestone returns ok:false reason:lease-conflict when another worker holds the lease", (t) => {
  const base = makeDbBase();
  t.after(() => cleanupDbBase(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  const holder = registerAutoWorker({ projectRootRealpath: base });
  const contender = registerAutoWorker({ projectRootRealpath: base });
  const claim = claimMilestoneLease(holder, "M001");
  assert.equal(claim.ok, true);
  const s = makeSession({ basePath: base, originalBasePath: base, workerId: contender });
  const deps = makeDeps();
  const ctx = makeCtx();
  const lifecycle = new WorktreeLifecycle(s, deps);
  const result = lifecycle.enterMilestone("M001", ctx);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "lease-conflict");
  }
  assert.equal(s.isolationDegraded, false);
  assert.equal(s.basePath, base);
  assert.equal(s.milestoneLeaseToken, null);
  assert.equal(deps.calls.filter((c) => c.fn === "getIsolationMode").length, 0);
  assert.equal(ctx.messages.length, 1);
  assert.equal(ctx.messages[0]?.level, "error");
});
test("enterMilestone is idempotent when already in the milestone worktree", (t) => {
  const previousCwd = process.cwd();
  const base = makeGitRepoBase({ isolation: "worktree" });
  t.after(() => cleanupRepoBase(base, previousCwd));
  const wt = join(base, ".gsd", "worktrees", "M001");
  const s = makeSession({
    basePath: wt,
    originalBasePath: base,
    currentMilestoneId: "M001"
  });
  const deps = makeDeps();
  const ctx = makeCtx();
  const lifecycle = new WorktreeLifecycle(s, deps);
  const result = lifecycle.enterMilestone("M001", ctx);
  assert.equal(result.ok, true, `expected ok:true, got: ${JSON.stringify(result)}`);
  if (result.ok) {
    assert.equal(result.mode, "worktree");
    assert.equal(result.path, wt);
  }
  assert.equal(s.basePath, wt);
});
test("enterMilestone returns ok:false reason:invalid-milestone-id on path traversal", () => {
  const s = makeSession();
  const deps = makeDeps();
  const ctx = makeCtx();
  const lifecycle = new WorktreeLifecycle(s, deps);
  const traversal = lifecycle.enterMilestone("../escape", ctx);
  const separator = lifecycle.enterMilestone("a/b", ctx);
  assert.equal(traversal.ok, false);
  if (!traversal.ok) {
    assert.equal(traversal.reason, "invalid-milestone-id");
  }
  assert.equal(separator.ok, false);
  if (!separator.ok) {
    assert.equal(separator.reason, "invalid-milestone-id");
  }
});
test("isInMilestone returns true when session matches milestone id", () => {
  const s = makeSession();
  s.currentMilestoneId = "M001";
  const lifecycle = new WorktreeLifecycle(s, makeDeps());
  assert.equal(lifecycle.isInMilestone("M001"), true);
  assert.equal(lifecycle.isInMilestone("M002"), false);
});
test("isInMilestone returns false when session has no active milestone", () => {
  const s = makeSession();
  s.currentMilestoneId = null;
  const lifecycle = new WorktreeLifecycle(s, makeDeps());
  assert.equal(lifecycle.isInMilestone("M001"), false);
});
test("getCurrentMilestoneIfAny returns the active milestone id or null", () => {
  const s = makeSession();
  s.currentMilestoneId = "M042";
  const lifecycle = new WorktreeLifecycle(s, makeDeps());
  assert.equal(lifecycle.getCurrentMilestoneIfAny(), "M042");
  s.currentMilestoneId = null;
  assert.equal(lifecycle.getCurrentMilestoneIfAny(), null);
});
test("degradeToBranchMode sets isolationDegraded and runs branch-mode setup", (t) => {
  const previousCwd = process.cwd();
  const base = makeGitRepoBase({ isolation: "branch" });
  t.after(() => cleanupRepoBase(base, previousCwd));
  const s = makeSession({ basePath: base, originalBasePath: base });
  const deps = makeDeps();
  const ctx = makeCtx();
  const lifecycle = new WorktreeLifecycle(s, deps);
  lifecycle.degradeToBranchMode("M001", ctx);
  assert.equal(s.isolationDegraded, true);
});
test("degradeToBranchMode is no-op when isolationDegraded is already true", () => {
  const s = makeSession();
  s.isolationDegraded = true;
  const deps = makeDeps();
  const ctx = makeCtx();
  const lifecycle = new WorktreeLifecycle(s, deps);
  lifecycle.degradeToBranchMode("M001", ctx);
  assert.equal(s.isolationDegraded, true);
  assert.equal(ctx.messages.length, 0);
});
test("degradeToBranchMode marks degraded and notifies on branch-mode failure", () => {
  const s = makeSession();
  const deps = makeDeps({});
  const ctx = makeCtx();
  const lifecycle = new WorktreeLifecycle(s, deps);
  lifecycle.degradeToBranchMode("M001", ctx);
  assert.equal(s.isolationDegraded, true);
  assert.ok(
    ctx.messages.some(
      (m) => m.level === "warning" && m.msg.includes("Branch isolation setup")
    )
  );
});
test("restoreToProjectRoot restores basePath to originalBasePath and rebuilds git service", () => {
  const s = makeSession();
  s.originalBasePath = "/project";
  s.basePath = "/project/.gsd/worktrees/M001";
  const deps = makeDeps();
  const lifecycle = new WorktreeLifecycle(s, deps);
  lifecycle.restoreToProjectRoot();
  assert.equal(s.basePath, "/project");
  assert.equal(
    deps.calls.filter((c) => c.fn === "gitServiceFactory").length,
    1
  );
});
test("restoreToProjectRoot rebuilds git service via gitServiceFactory at the restored base path", () => {
  const s = makeSession();
  s.originalBasePath = "/project";
  s.basePath = "/project/.gsd/worktrees/M001";
  const deps = makeDeps();
  const lifecycle = new WorktreeLifecycle(s, deps);
  lifecycle.restoreToProjectRoot();
  assert.deepEqual(
    deps.calls.find((c) => c.fn === "gitServiceFactory")?.args,
    ["/project"]
  );
});
test("restoreToProjectRoot is no-op when originalBasePath is empty", () => {
  const s = makeSession();
  s.originalBasePath = "";
  s.basePath = "/some/path";
  const deps = makeDeps();
  const lifecycle = new WorktreeLifecycle(s, deps);
  lifecycle.restoreToProjectRoot();
  assert.equal(s.basePath, "/some/path");
  assert.equal(deps.calls.filter((c) => c.fn === "gitServiceFactory").length, 0);
});
test("restoreToProjectRoot completes session-state restore even when chdir fails (ADR-016 phase 3, #5693)", () => {
  const s = makeSession();
  s.originalBasePath = "/this/path/should/not/exist/in/any/test/env";
  s.basePath = "/project/.gsd/worktrees/M001";
  const deps = makeDeps();
  const lifecycle = new WorktreeLifecycle(s, deps);
  const cwdBefore = process.cwd();
  lifecycle.restoreToProjectRoot();
  assert.equal(s.basePath, "/this/path/should/not/exist/in/any/test/env");
  assert.equal(
    deps.calls.filter((c) => c.fn === "gitServiceFactory").length,
    1
  );
  assert.equal(process.cwd(), cwdBefore);
});
test("adoptSessionRoot sets basePath and seeds originalBasePath on a fresh session", () => {
  const s = makeSession();
  s.basePath = "";
  s.originalBasePath = "";
  const lifecycle = new WorktreeLifecycle(s, makeDeps());
  lifecycle.adoptSessionRoot("/project");
  assert.equal(s.basePath, "/project");
  assert.equal(s.originalBasePath, "/project");
});
test("adoptSessionRoot preserves a pre-existing originalBasePath when no override is passed", () => {
  const s = makeSession();
  s.basePath = "";
  s.originalBasePath = "/persisted/project-root";
  const lifecycle = new WorktreeLifecycle(s, makeDeps());
  lifecycle.adoptSessionRoot("/project");
  assert.equal(s.basePath, "/project");
  assert.equal(s.originalBasePath, "/persisted/project-root");
});
test("adoptSessionRoot honors an explicit originalBase override", () => {
  const s = makeSession();
  s.basePath = "";
  s.originalBasePath = "/old-root";
  const lifecycle = new WorktreeLifecycle(s, makeDeps());
  lifecycle.adoptSessionRoot("/project", "/explicit-original");
  assert.equal(s.basePath, "/project");
  assert.equal(s.originalBasePath, "/explicit-original");
});
test("adoptSessionRoot does not chdir, rebuild git service, or invalidate caches", () => {
  const s = makeSession();
  s.basePath = "";
  s.originalBasePath = "";
  const deps = makeDeps();
  const lifecycle = new WorktreeLifecycle(s, deps);
  lifecycle.adoptSessionRoot("/project");
  assert.equal(deps.calls.filter((c) => c.fn === "gitServiceFactory").length, 0);
  assert.equal(deps.calls.filter((c) => c.fn === "invalidateAllCaches").length, 0);
});
test("resumeFromPausedSession adopts the persisted worktree path when it exists", (t) => {
  const wtDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-resume-test-")));
  t.after(() => {
    try {
      rmSync(wtDir, { recursive: true, force: true });
    } catch {
    }
  });
  const s = makeSession();
  s.basePath = "/some/old/path";
  const lifecycle = new WorktreeLifecycle(s, makeDeps());
  assert.equal(
    resolvePausedResumeBasePath("/project", "/persisted/worktree/M001", () => true),
    "/persisted/worktree/M001"
  );
  lifecycle.resumeFromPausedSession("/project", wtDir);
  assert.equal(s.basePath, wtDir);
});
test("resumeFromPausedSession falls back to base when persisted worktree is null", () => {
  const s = makeSession();
  s.basePath = "/old";
  const lifecycle = new WorktreeLifecycle(s, makeDeps());
  lifecycle.resumeFromPausedSession("/project", null);
  assert.equal(s.basePath, "/project");
});
test("resumeFromPausedSession falls back to base when persisted worktree does not exist", () => {
  const s = makeSession();
  s.basePath = "/old";
  const lifecycle = new WorktreeLifecycle(s, makeDeps());
  lifecycle.resumeFromPausedSession(
    "/project",
    "/this/path/does/not/exist/abc/xyz"
  );
  assert.equal(s.basePath, "/project");
});
test("resumeFromPausedSession does not chdir, rebuild git service, or invalidate caches", () => {
  const s = makeSession();
  const deps = makeDeps();
  const lifecycle = new WorktreeLifecycle(s, deps);
  lifecycle.resumeFromPausedSession("/project", null);
  assert.equal(deps.calls.filter((c) => c.fn === "gitServiceFactory").length, 0);
  assert.equal(deps.calls.filter((c) => c.fn === "invalidateAllCaches").length, 0);
});
test("adoptOrphanWorktree swaps to worktree path and reverts to base on !merged", (t) => {
  const previousCwd = process.cwd();
  const base = makeGitRepoBase({ isolation: "worktree" });
  t.after(() => cleanupRepoBase(base, previousCwd));
  const wt = join(base, ".gsd", "worktrees", "M001");
  execFileSync("git", ["checkout", "-b", "milestone/M001"], { cwd: base, stdio: "pipe" });
  execFileSync("git", ["checkout", "main"], { cwd: base, stdio: "pipe" });
  execFileSync("git", ["worktree", "add", wt, "milestone/M001"], { cwd: base, stdio: "pipe" });
  const s = makeSession();
  s.basePath = "/old";
  s.originalBasePath = "/old";
  s.active = true;
  const lifecycle = new WorktreeLifecycle(s, makeDeps());
  let basePathInsideCallback = "";
  const result = lifecycle.adoptOrphanWorktree("M001", base, () => {
    basePathInsideCallback = s.basePath;
    return { merged: false, reason: "synthetic" };
  });
  assert.equal(basePathInsideCallback, wt);
  assert.equal(s.basePath, base);
  assert.equal(s.originalBasePath, base);
  assert.equal(result.merged, false);
});
test("adoptOrphanWorktree holds the swap on merged && active", (t) => {
  const previousCwd = process.cwd();
  const base = makeGitRepoBase({ isolation: "worktree" });
  t.after(() => cleanupRepoBase(base, previousCwd));
  const wt = join(base, ".gsd", "worktrees", "M001");
  execFileSync("git", ["checkout", "-b", "milestone/M001"], { cwd: base, stdio: "pipe" });
  execFileSync("git", ["checkout", "main"], { cwd: base, stdio: "pipe" });
  execFileSync("git", ["worktree", "add", wt, "milestone/M001"], { cwd: base, stdio: "pipe" });
  const s = makeSession();
  s.basePath = "/old";
  s.originalBasePath = "/old";
  s.active = true;
  const lifecycle = new WorktreeLifecycle(s, makeDeps());
  lifecycle.adoptOrphanWorktree("M001", base, () => ({
    merged: true
  }));
  assert.equal(s.basePath, wt);
  assert.equal(s.originalBasePath, base);
});
test("adoptOrphanWorktree restores prior paths on merged && !active", (t) => {
  const previousCwd = process.cwd();
  const base = makeGitRepoBase({ isolation: "worktree" });
  t.after(() => cleanupRepoBase(base, previousCwd));
  const wt = join(base, ".gsd", "worktrees", "M001");
  execFileSync("git", ["checkout", "-b", "milestone/M001"], { cwd: base, stdio: "pipe" });
  execFileSync("git", ["checkout", "main"], { cwd: base, stdio: "pipe" });
  execFileSync("git", ["worktree", "add", wt, "milestone/M001"], { cwd: base, stdio: "pipe" });
  const s = makeSession();
  s.basePath = "/prior";
  s.originalBasePath = "/prior-original";
  s.active = false;
  const lifecycle = new WorktreeLifecycle(s, makeDeps());
  lifecycle.adoptOrphanWorktree("M001", base, () => ({
    merged: true
  }));
  assert.equal(s.basePath, "/prior");
  assert.equal(s.originalBasePath, "/prior-original");
});
test("adoptOrphanWorktree falls back to base when getAutoWorktreePath returns null", (t) => {
  const previousCwd = process.cwd();
  const base = makeGitRepoBase({ isolation: "worktree" });
  t.after(() => cleanupRepoBase(base, previousCwd));
  const s = makeSession();
  s.basePath = "/old";
  s.active = true;
  const lifecycle = new WorktreeLifecycle(s, makeDeps());
  let basePathInsideCallback = "";
  lifecycle.adoptOrphanWorktree("M001", base, () => {
    basePathInsideCallback = s.basePath;
    return { merged: true };
  });
  assert.equal(basePathInsideCallback, base);
});
test("adoptOrphanWorktree restores prior paths and cwd when the callback throws", () => {
  const originalCwd = process.cwd();
  const base = mkdtempSync(join(tmpdir(), "gsd-orphan-rollback-base-"));
  const worktree = mkdtempSync(join(tmpdir(), "gsd-orphan-rollback-wt-"));
  const s = makeSession({
    basePath: "/prior",
    originalBasePath: originalCwd,
    active: true
  });
  const deps = makeDeps({
    getAutoWorktreePath: () => worktree
  });
  const lifecycle = new WorktreeLifecycle(s, deps);
  const thrown = new Error("synthetic callback failure");
  try {
    assert.throws(
      () => lifecycle.adoptOrphanWorktree("M001", base, () => {
        assert.equal(s.basePath, worktree);
        assert.equal(s.originalBasePath, base);
        throw thrown;
      }),
      thrown
    );
    assert.equal(s.basePath, "/prior");
    assert.equal(s.originalBasePath, originalCwd);
    assert.equal(process.cwd(), originalCwd);
  } finally {
    process.chdir(originalCwd);
    rmSync(base, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});
test("adoptOrphanWorktree rejects traversal-style milestone ids before path resolution", () => {
  const s = makeSession({
    basePath: "/prior",
    originalBasePath: "/prior-original",
    active: true
  });
  const deps = makeDeps({
    getAutoWorktreePath: () => {
      throw new Error("getAutoWorktreePath should not be called");
    }
  });
  const lifecycle = new WorktreeLifecycle(s, deps);
  assert.throws(
    () => lifecycle.adoptOrphanWorktree("../M001", "/project", () => ({
      merged: true
    })),
    /Invalid milestoneId: \.\.\/M001/
  );
  assert.equal(s.basePath, "/prior");
  assert.equal(s.originalBasePath, "/prior-original");
  assert.equal(
    deps.calls.filter((c) => c.fn === "getAutoWorktreePath").length,
    0
  );
});
test("adoptOrphanWorktree forwards the callback's return value", (t) => {
  const previousCwd = process.cwd();
  const base = makeGitRepoBase({ isolation: "worktree" });
  t.after(() => cleanupRepoBase(base, previousCwd));
  const s = makeSession();
  s.active = true;
  const lifecycle = new WorktreeLifecycle(s, makeDeps());
  const result = lifecycle.adoptOrphanWorktree("M001", base, () => ({
    merged: true,
    customField: "preserved"
  }));
  assert.equal(result.merged, true);
  assert.equal(result.customField, "preserved");
});
test("adoptOrphanWorktree leaves session unchanged when getAutoWorktreePath throws", () => {
  const s = makeSession();
  s.basePath = "/prior";
  s.originalBasePath = "/prior-original";
  s.active = true;
  const lifecycle = new WorktreeLifecycle(
    s,
    makeDeps({
      getAutoWorktreePath: () => {
        throw new Error("git state unavailable");
      }
    })
  );
  assert.throws(
    () => lifecycle.adoptOrphanWorktree("M001", "/project", () => ({
      merged: true
    })),
    /git state unavailable/
  );
  assert.equal(s.basePath, "/prior");
  assert.equal(s.originalBasePath, "/prior-original");
});
test("adoptOrphanWorktree restores prior paths when callback throws", () => {
  const s = makeSession();
  s.basePath = "/prior";
  s.originalBasePath = "/prior-original";
  s.active = true;
  const lifecycle = new WorktreeLifecycle(
    s,
    makeDeps({
      getAutoWorktreePath: () => "/project/.gsd/worktrees/M001"
    })
  );
  assert.throws(
    () => lifecycle.adoptOrphanWorktree("M001", "/project", () => {
      assert.equal(s.basePath, "/project/.gsd/worktrees/M001");
      assert.equal(s.originalBasePath, "/project");
      throw new Error("merge exploded");
    }),
    /merge exploded/
  );
  assert.equal(s.basePath, "/prior");
  assert.equal(s.originalBasePath, "/prior-original");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy93b3JrdHJlZS1saWZlY3ljbGUudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IFdvcmt0cmVlIExpZmVjeWNsZSBNb2R1bGUgXHUyMDE0IHR5cGVkLXJlc3VsdCBjb250cmFjdCB0ZXN0cyBmb3IgZW50ZXJNaWxlc3RvbmUgKEFEUi0wMTYpLlxuaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMsIHJlYWxwYXRoU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGV4ZWNGaWxlU3luYyB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7XG4gIFdvcmt0cmVlTGlmZWN5Y2xlLFxuICByZXNvbHZlUGF1c2VkUmVzdW1lQmFzZVBhdGgsXG4gIHR5cGUgV29ya3RyZWVMaWZlY3ljbGVEZXBzLFxuICB0eXBlIFdvcmt0cmVlTGlmZWN5Y2xlVGVzdE92ZXJyaWRlcyxcbiAgdHlwZSBOb3RpZnlDdHgsXG59IGZyb20gXCIuLi93b3JrdHJlZS1saWZlY3ljbGUuanNcIjtcbmltcG9ydCB7IFdvcmt0cmVlU3RhdGVQcm9qZWN0aW9uIH0gZnJvbSBcIi4uL3dvcmt0cmVlLXN0YXRlLXByb2plY3Rpb24uanNcIjtcbmltcG9ydCB7IEF1dG9TZXNzaW9uIH0gZnJvbSBcIi4uL2F1dG8vc2Vzc2lvbi5qc1wiO1xuaW1wb3J0IHsgb3BlbkRhdGFiYXNlLCBjbG9zZURhdGFiYXNlLCBpbnNlcnRNaWxlc3RvbmUgfSBmcm9tIFwiLi4vZ3NkLWRiLmpzXCI7XG5pbXBvcnQgeyByZWdpc3RlckF1dG9Xb3JrZXIgfSBmcm9tIFwiLi4vZGIvYXV0by13b3JrZXJzLmpzXCI7XG5pbXBvcnQgeyBjbGFpbU1pbGVzdG9uZUxlYXNlIH0gZnJvbSBcIi4uL2RiL21pbGVzdG9uZS1sZWFzZXMuanNcIjtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEhlbHBlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmludGVyZmFjZSBDYWxsTG9nIHtcbiAgZm46IHN0cmluZztcbiAgYXJnczogdW5rbm93bltdO1xufVxuXG4vLyBUaGUgQzEtQzQtaW5saW5lZCBwcmltaXRpdmUgb3ZlcnJpZGVzIGNvbWUgZnJvbVxuLy8gYFdvcmt0cmVlTGlmZWN5Y2xlVGVzdE92ZXJyaWRlc2AsIHRoZSB0ZXN0IHNlYW0gZXhwb3J0ZWQgYnkgdGhlIE1vZHVsZS5cbi8vIExpZmVjeWNsZSByZWFkcyB0aGVzZSB0aHJvdWdoIGBwcmltaXRpdmVPdmVycmlkZXMoKWAgd2hlbiBwcmVzZW50IGFuZFxuLy8gZmFsbHMgYmFjayB0byBkaXJlY3QgaW1wb3J0cyBvdGhlcndpc2UuXG50eXBlIExlZ2FjeVRlc3REZXBzID0gV29ya3RyZWVMaWZlY3ljbGVEZXBzICYgV29ya3RyZWVMaWZlY3ljbGVUZXN0T3ZlcnJpZGVzO1xuXG5mdW5jdGlvbiBtYWtlU2Vzc2lvbihvdmVycmlkZXM/OiBQYXJ0aWFsPEF1dG9TZXNzaW9uPik6IEF1dG9TZXNzaW9uIHtcbiAgY29uc3QgcyA9IG5ldyBBdXRvU2Vzc2lvbigpO1xuICBzLmJhc2VQYXRoID0gb3ZlcnJpZGVzPy5iYXNlUGF0aCA/PyBcIi9wcm9qZWN0XCI7XG4gIHMub3JpZ2luYWxCYXNlUGF0aCA9IG92ZXJyaWRlcz8ub3JpZ2luYWxCYXNlUGF0aCA/PyBcIi9wcm9qZWN0XCI7XG4gIE9iamVjdC5hc3NpZ24ocywgb3ZlcnJpZGVzKTtcbiAgcmV0dXJuIHM7XG59XG5cbmZ1bmN0aW9uIG1ha2VEZXBzKFxuICBvdmVycmlkZXM/OiBQYXJ0aWFsPExlZ2FjeVRlc3REZXBzPixcbik6IExlZ2FjeVRlc3REZXBzICYgeyBjYWxsczogQ2FsbExvZ1tdIH0ge1xuICBjb25zdCBjYWxsczogQ2FsbExvZ1tdID0gW107XG4gIC8vIEFEUi0wMTYgcGhhc2UgMiAvIEMtdHJhY2sgY2xvc2Utb3V0OiBXb3JrdHJlZUxpZmVjeWNsZURlcHMgaXMgbm93IGFcbiAgLy8gMy1maWVsZCBiYWcgKGdpdFNlcnZpY2VGYWN0b3J5LCB3b3JrdHJlZVByb2plY3Rpb24sIG1lcmdlTWlsZXN0b25lVG9NYWluKS5cbiAgLy8gVGVzdHMgc3RpbGwgcGFzcyBsZWdhY3kgb3ZlcnJpZGUgaG9va3MgdmlhIGBMZWdhY3lUZXN0RGVwc2AgXHUyMDE0IExpZmVjeWNsZVxuICAvLyBpZ25vcmVzIHRoZSBleHRyYXMgc3RydWN0dXJhbGx5IGFuZCByZWFkcyB0aGVtIHRocm91Z2ggdGhlIEMxLWhlYWxpbmdcbiAgLy8gcHJpbWl0aXZlLW92ZXJyaWRlIHBhdHRlcm4gd2hlbiBzdHVicyBhcmUgbmVlZGVkLlxuICBjb25zdCBkZXBzOiBMZWdhY3lUZXN0RGVwcyAmIHsgY2FsbHM6IENhbGxMb2dbXSB9ID0ge1xuICAgIGNhbGxzLFxuICAgIGdpdFNlcnZpY2VGYWN0b3J5OiAoYmFzZVBhdGg6IHN0cmluZykgPT4ge1xuICAgICAgY2FsbHMucHVzaCh7IGZuOiBcImdpdFNlcnZpY2VGYWN0b3J5XCIsIGFyZ3M6IFtiYXNlUGF0aF0gfSk7XG4gICAgICByZXR1cm4geyBiYXNlUGF0aCB9IGFzIHVua25vd24gYXMgUmV0dXJuVHlwZTxcbiAgICAgICAgV29ya3RyZWVMaWZlY3ljbGVEZXBzW1wiZ2l0U2VydmljZUZhY3RvcnlcIl1cbiAgICAgID47XG4gICAgfSxcbiAgICB3b3JrdHJlZVByb2plY3Rpb246IG5ldyBXb3JrdHJlZVN0YXRlUHJvamVjdGlvbigpLFxuICAgIC8vIExlZ2FjeSBzdHVicyBcdTIwMTQgTGlmZWN5Y2xlIG5vIGxvbmdlciByZWFkcyB0aGVzZSBwb3N0LUMyOyBwcmVzZXJ2ZWQgYXNcbiAgICAvLyBuby1vcHMgc28gZXhpc3RpbmcgdGVzdCBmaXh0dXJlcyBrZWVwIHR5cGUtY2hlY2tpbmcuXG4gICAgaXNJbkF1dG9Xb3JrdHJlZTogKCkgPT4gZmFsc2UsXG4gICAgYXV0b0NvbW1pdEN1cnJlbnRCcmFuY2g6IChcbiAgICAgIGJhc2VQYXRoOiBzdHJpbmcsXG4gICAgICB1bml0VHlwZTogc3RyaW5nLFxuICAgICAgdW5pdElkOiBzdHJpbmcsXG4gICAgICB0YXNrQ29udGV4dD86IHVua25vd24sXG4gICAgKSA9PiB7XG4gICAgICBjYWxscy5wdXNoKHsgZm46IFwiYXV0b0NvbW1pdEN1cnJlbnRCcmFuY2hcIiwgYXJnczogW2Jhc2VQYXRoLCB1bml0VHlwZSwgdW5pdElkLCB0YXNrQ29udGV4dF0gfSk7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9LFxuICAgIGF1dG9Xb3JrdHJlZUJyYW5jaDogKG1pZDogc3RyaW5nKSA9PiBgbWlsZXN0b25lLyR7bWlkfWAsXG4gICAgdGVhcmRvd25BdXRvV29ya3RyZWU6ICgpID0+IHt9LFxuICAgIG1lcmdlTWlsZXN0b25lVG9NYWluOiAoKSA9PiAoeyBwdXNoZWQ6IGZhbHNlLCBjb2RlRmlsZXNDaGFuZ2VkOiB0cnVlIH0pLFxuICAgIC4uLm92ZXJyaWRlcyxcbiAgfTtcbiAgcmV0dXJuIGRlcHM7XG59XG5cbi8qKlxuICogQ3JlYXRlIGEgcmVhbCB0ZW1wb3JhcnkgZ2l0IHJlcG8gZm9yIHRlc3RzIHRoYXQgZXhlcmNpc2UgdGhlIGlubGluZWRcbiAqIHdvcmt0cmVlLW1hbmFnZXIgcHJpbWl0aXZlcyAocG9zdC1DMikuIFJldHVybnMgdGhlIHJlYWxwYXRoIG9mIHRoZSBuZXdcbiAqIHJlcG8uIFRlc3RzIHRoYXQgcHJldmlvdXNseSByZWxpZWQgb24gYGRlcHMuY3JlYXRlQXV0b1dvcmt0cmVlYCxcbiAqIGBkZXBzLmVudGVyQXV0b1dvcmt0cmVlYCwgZXRjLiBub3cgZHJpdmUgTGlmZWN5Y2xlIHRocm91Z2ggdGhlc2VcbiAqIGZpeHR1cmVzLlxuICovXG5mdW5jdGlvbiBtYWtlR2l0UmVwb0Jhc2Uob3B0cz86IHtcbiAgaXNvbGF0aW9uPzogXCJ3b3JrdHJlZVwiIHwgXCJicmFuY2hcIiB8IFwibm9uZVwiO1xufSk6IHN0cmluZyB7XG4gIGNvbnN0IGJhc2UgPSByZWFscGF0aFN5bmMobWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtbGlmZWN5Y2xlLWdpdC1cIikpKTtcbiAgY29uc3QgZ2l0ID0gKGFyZ3M6IHN0cmluZ1tdKTogdm9pZCA9PiB7XG4gICAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIGFyZ3MsIHsgY3dkOiBiYXNlLCBzdGRpbzogXCJwaXBlXCIgfSk7XG4gIH07XG4gIGdpdChbXCJpbml0XCIsIFwiLWJcIiwgXCJtYWluXCJdKTtcbiAgZ2l0KFtcImNvbmZpZ1wiLCBcInVzZXIuZW1haWxcIiwgXCJ0ZXN0QHRlc3QuY29tXCJdKTtcbiAgZ2l0KFtcImNvbmZpZ1wiLCBcInVzZXIubmFtZVwiLCBcIlRlc3RcIl0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCJSRUFETUUubWRcIiksIFwiIyB0ZXN0XFxuXCIpO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ2l0aWdub3JlXCIpLCBcIi5nc2Qvd29ya3RyZWVzL1xcblwiKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgaWYgKG9wdHM/Lmlzb2xhdGlvbiAmJiBvcHRzLmlzb2xhdGlvbiAhPT0gXCJub25lXCIpIHtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihiYXNlLCBcIi5nc2RcIiwgXCJwcmVmZXJlbmNlcy5tZFwiKSxcbiAgICAgIGAjIyBHaXRcXG4tIGlzb2xhdGlvbjogJHtvcHRzLmlzb2xhdGlvbn1cXG5gLFxuICAgICk7XG4gIH1cbiAgZ2l0KFtcImFkZFwiLCBcIi5cIl0pO1xuICBnaXQoW1wiY29tbWl0XCIsIFwiLW1cIiwgXCJpbml0XCJdKTtcbiAgcmV0dXJuIGJhc2U7XG59XG5cbmZ1bmN0aW9uIGNsZWFudXBSZXBvQmFzZShiYXNlOiBzdHJpbmcsIHByZXZpb3VzQ3dkPzogc3RyaW5nKTogdm9pZCB7XG4gIHRyeSB7IGNsb3NlRGF0YWJhc2UoKTsgfSBjYXRjaCB7IC8qIG5vb3AgKi8gfVxuICB0cnkgeyBpZiAocHJldmlvdXNDd2QpIHByb2Nlc3MuY2hkaXIocHJldmlvdXNDd2QpOyB9IGNhdGNoIHsgLyogbm9vcCAqLyB9XG4gIHRyeSB7IHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0gY2F0Y2ggeyAvKiBub29wICovIH1cbn1cblxuZnVuY3Rpb24gbWFrZUN0eCgpOiBOb3RpZnlDdHggJiB7XG4gIG1lc3NhZ2VzOiBBcnJheTx7IG1zZzogc3RyaW5nOyBsZXZlbD86IHN0cmluZyB9Pjtcbn0ge1xuICBjb25zdCBtZXNzYWdlczogQXJyYXk8eyBtc2c6IHN0cmluZzsgbGV2ZWw/OiBzdHJpbmcgfT4gPSBbXTtcbiAgcmV0dXJuIHtcbiAgICBtZXNzYWdlcyxcbiAgICBub3RpZnk6IChtc2csIGxldmVsKSA9PiB7XG4gICAgICBtZXNzYWdlcy5wdXNoKHsgbXNnLCBsZXZlbCB9KTtcbiAgICB9LFxuICB9O1xufVxuXG5mdW5jdGlvbiBtYWtlRGJCYXNlKCk6IHN0cmluZyB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1saWZlY3ljbGUtXCIpKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgcmV0dXJuIGJhc2U7XG59XG5cbmZ1bmN0aW9uIGNsZWFudXBEYkJhc2UoYmFzZTogc3RyaW5nKTogdm9pZCB7XG4gIHRyeSB7IGNsb3NlRGF0YWJhc2UoKTsgfSBjYXRjaCB7IC8qIG5vb3AgKi8gfVxuICB0cnkgeyBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pOyB9IGNhdGNoIHsgLyogbm9vcCAqLyB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBlbnRlck1pbGVzdG9uZSBcdTIwMTQgdHlwZWQtcmVzdWx0IGNvbnRyYWN0IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiZW50ZXJNaWxlc3RvbmUgcmV0dXJucyBvazp0cnVlIG1vZGU6d29ya3RyZWUgb24gc3VjY2Vzc2Z1bCBjcmVhdGVcIiwgKHQpID0+IHtcbiAgLy8gQURSLTAxNiBwaGFzZSAyIC8gQzIgKCM1NjI1KTogdGhlIHdvcmt0cmVlLW1hbmFnZXIgcHJpbWl0aXZlcyBhcmVcbiAgLy8gaW5saW5lZCwgc28gdGhlIHN1Y2Nlc3MgcGF0aCBuZWVkcyBhIHJlYWwgZ2l0IHJlcG8uIFRoZSB0ZXN0IGV4ZXJjaXNlc1xuICAvLyBMaWZlY3ljbGUuZW50ZXJNaWxlc3RvbmUgZW5kLXRvLWVuZCBhZ2FpbnN0IGBjcmVhdGVBdXRvV29ya3RyZWVgJ3NcbiAgLy8gcmVhbCBpbXBsZW1lbnRhdGlvbiBpbiBgYXV0by13b3JrdHJlZS50c2AuXG4gIGNvbnN0IHByZXZpb3VzQ3dkID0gcHJvY2Vzcy5jd2QoKTtcbiAgY29uc3QgYmFzZSA9IG1ha2VHaXRSZXBvQmFzZSh7IGlzb2xhdGlvbjogXCJ3b3JrdHJlZVwiIH0pO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXBSZXBvQmFzZShiYXNlLCBwcmV2aW91c0N3ZCkpO1xuXG4gIGNvbnN0IHMgPSBtYWtlU2Vzc2lvbih7IGJhc2VQYXRoOiBiYXNlLCBvcmlnaW5hbEJhc2VQYXRoOiBiYXNlIH0pO1xuICBjb25zdCBkZXBzID0gbWFrZURlcHMoKTtcbiAgY29uc3QgY3R4ID0gbWFrZUN0eCgpO1xuICBjb25zdCBsaWZlY3ljbGUgPSBuZXcgV29ya3RyZWVMaWZlY3ljbGUocywgZGVwcyk7XG5cbiAgY29uc3QgcmVzdWx0ID0gbGlmZWN5Y2xlLmVudGVyTWlsZXN0b25lKFwiTTAwMVwiLCBjdHgpO1xuXG4gIGFzc2VydC5lcXVhbChyZXN1bHQub2ssIHRydWUsIGBleHBlY3RlZCBvazp0cnVlLCBnb3Q6ICR7SlNPTi5zdHJpbmdpZnkocmVzdWx0KX1gKTtcbiAgaWYgKHJlc3VsdC5vaykge1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQubW9kZSwgXCJ3b3JrdHJlZVwiKTtcbiAgICBhc3NlcnQub2soXG4gICAgICByZXN1bHQucGF0aC5lbmRzV2l0aChcIi8uZ3NkL3dvcmt0cmVlcy9NMDAxXCIpLFxuICAgICAgYGV4cGVjdGVkIHBhdGggdG8gZW5kIHdpdGggLy5nc2Qvd29ya3RyZWVzL00wMDEsIGdvdCAke3Jlc3VsdC5wYXRofWAsXG4gICAgKTtcbiAgfVxuICBhc3NlcnQub2soXG4gICAgcy5iYXNlUGF0aC5lbmRzV2l0aChcIi8uZ3NkL3dvcmt0cmVlcy9NMDAxXCIpLFxuICAgIGBleHBlY3RlZCBzLmJhc2VQYXRoIHRvIGVuZCB3aXRoIC8uZ3NkL3dvcmt0cmVlcy9NMDAxLCBnb3QgJHtzLmJhc2VQYXRofWAsXG4gICk7XG4gIC8vIEFmdGVyIEMzICgjNTYyNikgYGludmFsaWRhdGVBbGxDYWNoZXNgIGlzIGlubGluZWQ7IGFzc2VydGlvbiBhZ2FpbnN0XG4gIC8vIGBkZXBzLmNhbGxzYCBmb3IgY2FjaGUgaW52YWxpZGF0aW9uIGlzIG5vIGxvbmdlciBwb3NzaWJsZS5cbn0pO1xuXG50ZXN0KFwiZW50ZXJNaWxlc3RvbmUgcmV0dXJucyBvazp0cnVlIG1vZGU6YnJhbmNoIG9uIHN1Y2Nlc3NmdWwgYnJhbmNoIGZhbGxiYWNrXCIsICh0KSA9PiB7XG4gIC8vIFJlYWwgZml4dHVyZSB3aXRoIGlzb2xhdGlvbjpicmFuY2ggXHUyMDE0IGBlbnRlckJyYW5jaE1vZGVGb3JNaWxlc3RvbmVgJ3NcbiAgLy8gcmVhbCBpbXBsZW1lbnRhdGlvbiBydW5zIGFnYWluc3QgdGhlIHRlbXAgcmVwby5cbiAgY29uc3QgcHJldmlvdXNDd2QgPSBwcm9jZXNzLmN3ZCgpO1xuICBjb25zdCBiYXNlID0gbWFrZUdpdFJlcG9CYXNlKHsgaXNvbGF0aW9uOiBcImJyYW5jaFwiIH0pO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXBSZXBvQmFzZShiYXNlLCBwcmV2aW91c0N3ZCkpO1xuXG4gIGNvbnN0IHMgPSBtYWtlU2Vzc2lvbih7IGJhc2VQYXRoOiBiYXNlLCBvcmlnaW5hbEJhc2VQYXRoOiBiYXNlIH0pO1xuICBjb25zdCBkZXBzID0gbWFrZURlcHMoeyBnZXRJc29sYXRpb25Nb2RlOiAoKSA9PiBcImJyYW5jaFwiIH0pO1xuICBjb25zdCBjdHggPSBtYWtlQ3R4KCk7XG4gIGNvbnN0IGxpZmVjeWNsZSA9IG5ldyBXb3JrdHJlZUxpZmVjeWNsZShzLCBkZXBzKTtcblxuICBjb25zdCByZXN1bHQgPSBsaWZlY3ljbGUuZW50ZXJNaWxlc3RvbmUoXCJNMDAxXCIsIGN0eCk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5vaywgdHJ1ZSwgYGV4cGVjdGVkIG9rOnRydWUsIGdvdDogJHtKU09OLnN0cmluZ2lmeShyZXN1bHQpfWApO1xuICBpZiAocmVzdWx0Lm9rKSB7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5tb2RlLCBcImJyYW5jaFwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnBhdGgsIGJhc2UpO1xuICB9XG4gIC8vIEJyYW5jaCBtb2RlIGRvZXMgbm90IG11dGF0ZSBzLmJhc2VQYXRoXG4gIGFzc2VydC5lcXVhbChzLmJhc2VQYXRoLCBiYXNlKTtcbn0pO1xuXG50ZXN0KFwiZW50ZXJNaWxlc3RvbmUgcmV0dXJucyBvazp0cnVlIG1vZGU6bm9uZSB3aGVuIGlzb2xhdGlvbiBkaXNhYmxlZFwiLCAoKSA9PiB7XG4gIGNvbnN0IHMgPSBtYWtlU2Vzc2lvbigpO1xuICBjb25zdCBkZXBzID0gbWFrZURlcHMoeyBnZXRJc29sYXRpb25Nb2RlOiAoKSA9PiBcIm5vbmVcIiB9KTtcbiAgY29uc3QgY3R4ID0gbWFrZUN0eCgpO1xuICBjb25zdCBsaWZlY3ljbGUgPSBuZXcgV29ya3RyZWVMaWZlY3ljbGUocywgZGVwcyk7XG5cbiAgY29uc3QgcmVzdWx0ID0gbGlmZWN5Y2xlLmVudGVyTWlsZXN0b25lKFwiTTAwMVwiLCBjdHgpO1xuXG4gIGFzc2VydC5lcXVhbChyZXN1bHQub2ssIHRydWUpO1xuICBpZiAocmVzdWx0Lm9rKSB7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5tb2RlLCBcIm5vbmVcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5wYXRoLCBcIi9wcm9qZWN0XCIpO1xuICB9XG4gIGFzc2VydC5lcXVhbChzLmJhc2VQYXRoLCBcIi9wcm9qZWN0XCIpO1xufSk7XG5cbnRlc3QoXCJlbnRlck1pbGVzdG9uZSByZXR1cm5zIG9rOmZhbHNlIHJlYXNvbjppc29sYXRpb24tZGVncmFkZWQgd2hlbiBzZXNzaW9uIGRlZ3JhZGVkXCIsICgpID0+IHtcbiAgY29uc3QgcyA9IG1ha2VTZXNzaW9uKHsgaXNvbGF0aW9uRGVncmFkZWQ6IHRydWUgfSk7XG4gIGNvbnN0IGRlcHMgPSBtYWtlRGVwcygpO1xuICBjb25zdCBjdHggPSBtYWtlQ3R4KCk7XG4gIGNvbnN0IGxpZmVjeWNsZSA9IG5ldyBXb3JrdHJlZUxpZmVjeWNsZShzLCBkZXBzKTtcblxuICBjb25zdCByZXN1bHQgPSBsaWZlY3ljbGUuZW50ZXJNaWxlc3RvbmUoXCJNMDAxXCIsIGN0eCk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5vaywgZmFsc2UpO1xuICBpZiAoIXJlc3VsdC5vaykge1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQucmVhc29uLCBcImlzb2xhdGlvbi1kZWdyYWRlZFwiKTtcbiAgfVxuICBhc3NlcnQuZXF1YWwocy5iYXNlUGF0aCwgXCIvcHJvamVjdFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHMubWlsZXN0b25lTGVhc2VUb2tlbiwgbnVsbCk7XG4gIGFzc2VydC5lcXVhbChkZXBzLmNhbGxzLmZpbHRlcigoYykgPT4gYy5mbiA9PT0gXCJnZXRJc29sYXRpb25Nb2RlXCIpLmxlbmd0aCwgMCk7XG59KTtcblxudGVzdChcImVudGVyTWlsZXN0b25lIHJldHVybnMgb2s6ZmFsc2UgcmVhc29uOmNyZWF0aW9uLWZhaWxlZCBhbmQgZGVncmFkZXMgc2Vzc2lvbiBvbiB3b3JrdHJlZSB0aHJvd1wiLCAodCkgPT4ge1xuICAvLyBBZnRlciBDMiB0aGUgd29ya3RyZWUtbWFuYWdlciBwcmltaXRpdmVzIGFyZSBpbmxpbmVkLiBVc2UgYSByZWFsXG4gIC8vIGZpeHR1cmUgYW5kIGJyZWFrIHRoZSByZXBvIGJ5IGRlbGV0aW5nIGAuZ2l0YCBzbyBhbnkgZ2l0IG9wIHRocm93cy5cbiAgY29uc3QgcHJldmlvdXNDd2QgPSBwcm9jZXNzLmN3ZCgpO1xuICBjb25zdCBiYXNlID0gbWFrZUdpdFJlcG9CYXNlKHsgaXNvbGF0aW9uOiBcIndvcmt0cmVlXCIgfSk7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cFJlcG9CYXNlKGJhc2UsIHByZXZpb3VzQ3dkKSk7XG4gIHJtU3luYyhqb2luKGJhc2UsIFwiLmdpdFwiKSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuXG4gIGNvbnN0IHMgPSBtYWtlU2Vzc2lvbih7IGJhc2VQYXRoOiBiYXNlLCBvcmlnaW5hbEJhc2VQYXRoOiBiYXNlIH0pO1xuICBjb25zdCBkZXBzID0gbWFrZURlcHMoKTtcbiAgY29uc3QgY3R4ID0gbWFrZUN0eCgpO1xuICBjb25zdCBsaWZlY3ljbGUgPSBuZXcgV29ya3RyZWVMaWZlY3ljbGUocywgZGVwcyk7XG5cbiAgY29uc3QgcmVzdWx0ID0gbGlmZWN5Y2xlLmVudGVyTWlsZXN0b25lKFwiTTAwMVwiLCBjdHgpO1xuXG4gIGFzc2VydC5lcXVhbChyZXN1bHQub2ssIGZhbHNlLCBgZXhwZWN0ZWQgb2s6ZmFsc2UsIGdvdDogJHtKU09OLnN0cmluZ2lmeShyZXN1bHQpfWApO1xuICBpZiAoIXJlc3VsdC5vaykge1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQucmVhc29uLCBcImNyZWF0aW9uLWZhaWxlZFwiKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmNhdXNlIGluc3RhbmNlb2YgRXJyb3IpO1xuICB9XG4gIGFzc2VydC5lcXVhbChzLmlzb2xhdGlvbkRlZ3JhZGVkLCB0cnVlKTtcbiAgLy8gcy5iYXNlUGF0aCB1bmNoYW5nZWQgb24gZmFpbHVyZVxuICBhc3NlcnQuZXF1YWwocy5iYXNlUGF0aCwgYmFzZSk7XG59KTtcblxudGVzdChcImVudGVyTWlsZXN0b25lIHJldHVybnMgb2s6ZmFsc2UgcmVhc29uOmNyZWF0aW9uLWZhaWxlZCB3aGVuIGJyYW5jaCBtb2RlIHRocm93c1wiLCAodCkgPT4ge1xuICAvLyBCcmFuY2gtbW9kZSBmYWlsdXJlIHNjZW5hcmlvOiByZWFsIGZpeHR1cmUgd2l0aCBpc29sYXRpb246YnJhbmNoLCBidXRcbiAgLy8gZGVsZXRlIHRoZSBgLmdpdGAgZGlyZWN0b3J5IHNvIGFueSBicmFuY2ggb3BlcmF0aW9uIHRocm93cy5cbiAgY29uc3QgcHJldmlvdXNDd2QgPSBwcm9jZXNzLmN3ZCgpO1xuICBjb25zdCBiYXNlID0gbWFrZUdpdFJlcG9CYXNlKHsgaXNvbGF0aW9uOiBcImJyYW5jaFwiIH0pO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXBSZXBvQmFzZShiYXNlLCBwcmV2aW91c0N3ZCkpO1xuICBybVN5bmMoam9pbihiYXNlLCBcIi5naXRcIiksIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcblxuICBjb25zdCBzID0gbWFrZVNlc3Npb24oeyBiYXNlUGF0aDogYmFzZSwgb3JpZ2luYWxCYXNlUGF0aDogYmFzZSB9KTtcbiAgY29uc3QgZGVwcyA9IG1ha2VEZXBzKHsgZ2V0SXNvbGF0aW9uTW9kZTogKCkgPT4gXCJicmFuY2hcIiB9KTtcbiAgY29uc3QgY3R4ID0gbWFrZUN0eCgpO1xuICBjb25zdCBsaWZlY3ljbGUgPSBuZXcgV29ya3RyZWVMaWZlY3ljbGUocywgZGVwcyk7XG5cbiAgY29uc3QgcmVzdWx0ID0gbGlmZWN5Y2xlLmVudGVyTWlsZXN0b25lKFwiTTAwMVwiLCBjdHgpO1xuXG4gIGFzc2VydC5lcXVhbChyZXN1bHQub2ssIGZhbHNlLCBgZXhwZWN0ZWQgb2s6ZmFsc2UsIGdvdDogJHtKU09OLnN0cmluZ2lmeShyZXN1bHQpfWApO1xuICBpZiAoIXJlc3VsdC5vaykge1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQucmVhc29uLCBcImNyZWF0aW9uLWZhaWxlZFwiKTtcbiAgfVxuICBhc3NlcnQuZXF1YWwocy5pc29sYXRpb25EZWdyYWRlZCwgdHJ1ZSk7XG59KTtcblxudGVzdChcImVudGVyTWlsZXN0b25lIGVudGVycyBleGlzdGluZyB3b3JrdHJlZSB3aGVuIHBhdGggcmVzb2x2ZXNcIiwgKHQpID0+IHtcbiAgLy8gQWZ0ZXIgQzIsIGBnZXRBdXRvV29ya3RyZWVQYXRoYCBydW5zIGFnYWluc3QgcmVhbCBnaXQuIFRvIGV4ZXJjaXNlIHRoZVxuICAvLyBcImV4aXN0aW5nIHdvcmt0cmVlXCIgYnJhbmNoIHdlIHByZS1jcmVhdGUgdGhlIHdvcmt0cmVlIG9uIGRpc2sgc29cbiAgLy8gZ2l0J3Mgd29ya3RyZWUgbGlzdCBpbmNsdWRlcyBpdC5cbiAgY29uc3QgcHJldmlvdXNDd2QgPSBwcm9jZXNzLmN3ZCgpO1xuICBjb25zdCBiYXNlID0gbWFrZUdpdFJlcG9CYXNlKHsgaXNvbGF0aW9uOiBcIndvcmt0cmVlXCIgfSk7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cFJlcG9CYXNlKGJhc2UsIHByZXZpb3VzQ3dkKSk7XG4gIGNvbnN0IHd0ID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJ3b3JrdHJlZXNcIiwgXCJNMDAxXCIpO1xuICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiY2hlY2tvdXRcIiwgXCItYlwiLCBcIm1pbGVzdG9uZS9NMDAxXCJdLCB7XG4gICAgY3dkOiBiYXNlLFxuICAgIHN0ZGlvOiBcInBpcGVcIixcbiAgfSk7XG4gIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJjaGVja291dFwiLCBcIm1haW5cIl0sIHsgY3dkOiBiYXNlLCBzdGRpbzogXCJwaXBlXCIgfSk7XG4gIGV4ZWNGaWxlU3luYyhcbiAgICBcImdpdFwiLFxuICAgIFtcIndvcmt0cmVlXCIsIFwiYWRkXCIsIHd0LCBcIm1pbGVzdG9uZS9NMDAxXCJdLFxuICAgIHsgY3dkOiBiYXNlLCBzdGRpbzogXCJwaXBlXCIgfSxcbiAgKTtcblxuICBjb25zdCBzID0gbWFrZVNlc3Npb24oeyBiYXNlUGF0aDogYmFzZSwgb3JpZ2luYWxCYXNlUGF0aDogYmFzZSB9KTtcbiAgY29uc3QgZGVwcyA9IG1ha2VEZXBzKCk7XG4gIGNvbnN0IGN0eCA9IG1ha2VDdHgoKTtcbiAgY29uc3QgbGlmZWN5Y2xlID0gbmV3IFdvcmt0cmVlTGlmZWN5Y2xlKHMsIGRlcHMpO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGxpZmVjeWNsZS5lbnRlck1pbGVzdG9uZShcIk0wMDFcIiwgY3R4KTtcblxuICBhc3NlcnQuZXF1YWwocmVzdWx0Lm9rLCB0cnVlLCBgZXhwZWN0ZWQgb2s6dHJ1ZSwgZ290OiAke0pTT04uc3RyaW5naWZ5KHJlc3VsdCl9YCk7XG4gIGlmIChyZXN1bHQub2spIHtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm1vZGUsIFwid29ya3RyZWVcIik7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgcmVzdWx0LnBhdGguZW5kc1dpdGgoXCIvLmdzZC93b3JrdHJlZXMvTTAwMVwiKSxcbiAgICAgIGBleHBlY3RlZCBwYXRoIHRvIGVuZCB3aXRoIC8uZ3NkL3dvcmt0cmVlcy9NMDAxLCBnb3QgJHtyZXN1bHQucGF0aH1gLFxuICAgICk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZW50ZXJNaWxlc3RvbmUgcmV0dXJucyBvazpmYWxzZSByZWFzb246bGVhc2UtY29uZmxpY3Qgd2hlbiBhbm90aGVyIHdvcmtlciBob2xkcyB0aGUgbGVhc2VcIiwgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VEYkJhc2UoKTtcbiAgdC5hZnRlcigoKSA9PiBjbGVhbnVwRGJCYXNlKGJhc2UpKTtcbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpKTtcbiAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIsIHN0YXR1czogXCJhY3RpdmVcIiB9KTtcbiAgY29uc3QgaG9sZGVyID0gcmVnaXN0ZXJBdXRvV29ya2VyKHsgcHJvamVjdFJvb3RSZWFscGF0aDogYmFzZSB9KTtcbiAgY29uc3QgY29udGVuZGVyID0gcmVnaXN0ZXJBdXRvV29ya2VyKHsgcHJvamVjdFJvb3RSZWFscGF0aDogYmFzZSB9KTtcbiAgY29uc3QgY2xhaW0gPSBjbGFpbU1pbGVzdG9uZUxlYXNlKGhvbGRlciwgXCJNMDAxXCIpO1xuICBhc3NlcnQuZXF1YWwoY2xhaW0ub2ssIHRydWUpO1xuXG4gIGNvbnN0IHMgPSBtYWtlU2Vzc2lvbih7IGJhc2VQYXRoOiBiYXNlLCBvcmlnaW5hbEJhc2VQYXRoOiBiYXNlLCB3b3JrZXJJZDogY29udGVuZGVyIH0pO1xuICBjb25zdCBkZXBzID0gbWFrZURlcHMoKTtcbiAgY29uc3QgY3R4ID0gbWFrZUN0eCgpO1xuICBjb25zdCBsaWZlY3ljbGUgPSBuZXcgV29ya3RyZWVMaWZlY3ljbGUocywgZGVwcyk7XG5cbiAgY29uc3QgcmVzdWx0ID0gbGlmZWN5Y2xlLmVudGVyTWlsZXN0b25lKFwiTTAwMVwiLCBjdHgpO1xuXG4gIGFzc2VydC5lcXVhbChyZXN1bHQub2ssIGZhbHNlKTtcbiAgaWYgKCFyZXN1bHQub2spIHtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnJlYXNvbiwgXCJsZWFzZS1jb25mbGljdFwiKTtcbiAgfVxuICBhc3NlcnQuZXF1YWwocy5pc29sYXRpb25EZWdyYWRlZCwgZmFsc2UpO1xuICBhc3NlcnQuZXF1YWwocy5iYXNlUGF0aCwgYmFzZSk7XG4gIGFzc2VydC5lcXVhbChzLm1pbGVzdG9uZUxlYXNlVG9rZW4sIG51bGwpO1xuICBhc3NlcnQuZXF1YWwoZGVwcy5jYWxscy5maWx0ZXIoKGMpID0+IGMuZm4gPT09IFwiZ2V0SXNvbGF0aW9uTW9kZVwiKS5sZW5ndGgsIDApO1xuICBhc3NlcnQuZXF1YWwoY3R4Lm1lc3NhZ2VzLmxlbmd0aCwgMSk7XG4gIGFzc2VydC5lcXVhbChjdHgubWVzc2FnZXNbMF0/LmxldmVsLCBcImVycm9yXCIpO1xufSk7XG5cbnRlc3QoXCJlbnRlck1pbGVzdG9uZSBpcyBpZGVtcG90ZW50IHdoZW4gYWxyZWFkeSBpbiB0aGUgbWlsZXN0b25lIHdvcmt0cmVlXCIsICh0KSA9PiB7XG4gIC8vIFJlYWwtZml4dHVyZSB2YXJpYW50IGFmdGVyIEMyL0MzLiBUaGUgc2Vzc2lvbiBpcyBhbHJlYWR5IHBvaW50aW5nIGF0XG4gIC8vIHRoZSB3b3JrdHJlZSBwYXRoIHdpdGggY3VycmVudE1pbGVzdG9uZUlkIHNldCwgc28gdGhlIGlkZW1wb3RlbmN5XG4gIC8vIGVhcmx5LXJldHVybiBpbnNpZGUgYF9lbnRlck1pbGVzdG9uZUNvcmVgIGZpcmVzIHdpdGhvdXQgaW52b2tpbmcgdGhlXG4gIC8vIGlubGluZWQgd29ya3RyZWUgcHJpbWl0aXZlcy5cbiAgY29uc3QgcHJldmlvdXNDd2QgPSBwcm9jZXNzLmN3ZCgpO1xuICBjb25zdCBiYXNlID0gbWFrZUdpdFJlcG9CYXNlKHsgaXNvbGF0aW9uOiBcIndvcmt0cmVlXCIgfSk7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cFJlcG9CYXNlKGJhc2UsIHByZXZpb3VzQ3dkKSk7XG4gIGNvbnN0IHd0ID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJ3b3JrdHJlZXNcIiwgXCJNMDAxXCIpO1xuXG4gIGNvbnN0IHMgPSBtYWtlU2Vzc2lvbih7XG4gICAgYmFzZVBhdGg6IHd0LFxuICAgIG9yaWdpbmFsQmFzZVBhdGg6IGJhc2UsXG4gICAgY3VycmVudE1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgfSk7XG4gIGNvbnN0IGRlcHMgPSBtYWtlRGVwcygpO1xuICBjb25zdCBjdHggPSBtYWtlQ3R4KCk7XG4gIGNvbnN0IGxpZmVjeWNsZSA9IG5ldyBXb3JrdHJlZUxpZmVjeWNsZShzLCBkZXBzKTtcblxuICBjb25zdCByZXN1bHQgPSBsaWZlY3ljbGUuZW50ZXJNaWxlc3RvbmUoXCJNMDAxXCIsIGN0eCk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5vaywgdHJ1ZSwgYGV4cGVjdGVkIG9rOnRydWUsIGdvdDogJHtKU09OLnN0cmluZ2lmeShyZXN1bHQpfWApO1xuICBpZiAocmVzdWx0Lm9rKSB7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5tb2RlLCBcIndvcmt0cmVlXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQucGF0aCwgd3QpO1xuICB9XG4gIGFzc2VydC5lcXVhbChzLmJhc2VQYXRoLCB3dCk7XG59KTtcblxudGVzdChcImVudGVyTWlsZXN0b25lIHJldHVybnMgb2s6ZmFsc2UgcmVhc29uOmludmFsaWQtbWlsZXN0b25lLWlkIG9uIHBhdGggdHJhdmVyc2FsXCIsICgpID0+IHtcbiAgY29uc3QgcyA9IG1ha2VTZXNzaW9uKCk7XG4gIGNvbnN0IGRlcHMgPSBtYWtlRGVwcygpO1xuICBjb25zdCBjdHggPSBtYWtlQ3R4KCk7XG4gIGNvbnN0IGxpZmVjeWNsZSA9IG5ldyBXb3JrdHJlZUxpZmVjeWNsZShzLCBkZXBzKTtcblxuICBjb25zdCB0cmF2ZXJzYWwgPSBsaWZlY3ljbGUuZW50ZXJNaWxlc3RvbmUoXCIuLi9lc2NhcGVcIiwgY3R4KTtcbiAgY29uc3Qgc2VwYXJhdG9yID0gbGlmZWN5Y2xlLmVudGVyTWlsZXN0b25lKFwiYS9iXCIsIGN0eCk7XG5cbiAgYXNzZXJ0LmVxdWFsKHRyYXZlcnNhbC5vaywgZmFsc2UpO1xuICBpZiAoIXRyYXZlcnNhbC5vaykge1xuICAgIGFzc2VydC5lcXVhbCh0cmF2ZXJzYWwucmVhc29uLCBcImludmFsaWQtbWlsZXN0b25lLWlkXCIpO1xuICB9XG4gIGFzc2VydC5lcXVhbChzZXBhcmF0b3Iub2ssIGZhbHNlKTtcbiAgaWYgKCFzZXBhcmF0b3Iub2spIHtcbiAgICBhc3NlcnQuZXF1YWwoc2VwYXJhdG9yLnJlYXNvbiwgXCJpbnZhbGlkLW1pbGVzdG9uZS1pZFwiKTtcbiAgfVxufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBleGl0TWlsZXN0b25lIFx1MjAxNCB0eXBlZC1yZXN1bHQgY29udHJhY3QgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4vL1xuLy8gVGhlIGRlbGVnYXRpb24tc2hhcGUgdGVzdHMgdGhhdCBsaXZlZCBoZXJlIHdlcmUgcmV0aXJlZCBpbiBzbGljZSA3IC8gc3RlcFxuLy8gRCBvZiBBRFItMDE2OiBMaWZlY3ljbGUgbm8gbG9uZ2VyIHRha2VzIGEgYHJlc29sdmVyRmFjdG9yeWAuIFRoZSBtZXJnZVxuLy8gYmVoYXZpb3VyIHRoZXkgY292ZXJlZCBub3cgcnVucyBpbnNpZGUgTGlmZWN5Y2xlIGRpcmVjdGx5IGFuZCBpcyBleGVyY2lzZWRcbi8vIGVuZC10by1lbmQgYnkgdGhlIG1lcmdlLW1vZGUgdGVzdHMgaW4gd29ya3RyZWUtcmVzb2x2ZXIudGVzdC50cyAod2hpY2hcbi8vIGRyaXZlIExpZmVjeWNsZSB0aHJvdWdoIFJlc29sdmVyIGRlbGVnYXRpb24gdW50aWwgc3RlcCBFIHJldGlyZXMgdGhlXG4vLyBSZXNvbHZlciBjbGFzcyBlbnRpcmVseSkuIFdoZW4gdGhhdCByZXRpcmVtZW50IGxhbmRzLCB0aG9zZSB0ZXN0cyBtb3ZlXG4vLyBoZXJlIHZlcmJhdGltLlxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUXVlcmllcyAoaXNzdWUgIzU1ODcpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiaXNJbk1pbGVzdG9uZSByZXR1cm5zIHRydWUgd2hlbiBzZXNzaW9uIG1hdGNoZXMgbWlsZXN0b25lIGlkXCIsICgpID0+IHtcbiAgY29uc3QgcyA9IG1ha2VTZXNzaW9uKCk7XG4gIHMuY3VycmVudE1pbGVzdG9uZUlkID0gXCJNMDAxXCI7XG4gIGNvbnN0IGxpZmVjeWNsZSA9IG5ldyBXb3JrdHJlZUxpZmVjeWNsZShzLCBtYWtlRGVwcygpKTtcblxuICBhc3NlcnQuZXF1YWwobGlmZWN5Y2xlLmlzSW5NaWxlc3RvbmUoXCJNMDAxXCIpLCB0cnVlKTtcbiAgYXNzZXJ0LmVxdWFsKGxpZmVjeWNsZS5pc0luTWlsZXN0b25lKFwiTTAwMlwiKSwgZmFsc2UpO1xufSk7XG5cbnRlc3QoXCJpc0luTWlsZXN0b25lIHJldHVybnMgZmFsc2Ugd2hlbiBzZXNzaW9uIGhhcyBubyBhY3RpdmUgbWlsZXN0b25lXCIsICgpID0+IHtcbiAgY29uc3QgcyA9IG1ha2VTZXNzaW9uKCk7XG4gIHMuY3VycmVudE1pbGVzdG9uZUlkID0gbnVsbDtcbiAgY29uc3QgbGlmZWN5Y2xlID0gbmV3IFdvcmt0cmVlTGlmZWN5Y2xlKHMsIG1ha2VEZXBzKCkpO1xuXG4gIGFzc2VydC5lcXVhbChsaWZlY3ljbGUuaXNJbk1pbGVzdG9uZShcIk0wMDFcIiksIGZhbHNlKTtcbn0pO1xuXG50ZXN0KFwiZ2V0Q3VycmVudE1pbGVzdG9uZUlmQW55IHJldHVybnMgdGhlIGFjdGl2ZSBtaWxlc3RvbmUgaWQgb3IgbnVsbFwiLCAoKSA9PiB7XG4gIGNvbnN0IHMgPSBtYWtlU2Vzc2lvbigpO1xuICBzLmN1cnJlbnRNaWxlc3RvbmVJZCA9IFwiTTA0MlwiO1xuICBjb25zdCBsaWZlY3ljbGUgPSBuZXcgV29ya3RyZWVMaWZlY3ljbGUocywgbWFrZURlcHMoKSk7XG5cbiAgYXNzZXJ0LmVxdWFsKGxpZmVjeWNsZS5nZXRDdXJyZW50TWlsZXN0b25lSWZBbnkoKSwgXCJNMDQyXCIpO1xuXG4gIHMuY3VycmVudE1pbGVzdG9uZUlkID0gbnVsbDtcbiAgYXNzZXJ0LmVxdWFsKGxpZmVjeWNsZS5nZXRDdXJyZW50TWlsZXN0b25lSWZBbnkoKSwgbnVsbCk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGRlZ3JhZGVUb0JyYW5jaE1vZGUgKGlzc3VlICM1NTg3KSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcImRlZ3JhZGVUb0JyYW5jaE1vZGUgc2V0cyBpc29sYXRpb25EZWdyYWRlZCBhbmQgcnVucyBicmFuY2gtbW9kZSBzZXR1cFwiLCAodCkgPT4ge1xuICAvLyBBZnRlciBDMiwgYGVudGVyQnJhbmNoTW9kZUZvck1pbGVzdG9uZWAgcnVucyBhZ2FpbnN0IHJlYWwgZ2l0LiBVc2UgYVxuICAvLyByZWFsIGZpeHR1cmUgc28gdGhlIGJyYW5jaCBjaGVja291dCBzdWNjZWVkcyBhbmQgd2UgY2FuIG9ic2VydmUgdGhlXG4gIC8vIHNlc3Npb24ncyBpc29sYXRpb25EZWdyYWRlZCBmbGFnIGZsaXAuXG4gIGNvbnN0IHByZXZpb3VzQ3dkID0gcHJvY2Vzcy5jd2QoKTtcbiAgY29uc3QgYmFzZSA9IG1ha2VHaXRSZXBvQmFzZSh7IGlzb2xhdGlvbjogXCJicmFuY2hcIiB9KTtcbiAgdC5hZnRlcigoKSA9PiBjbGVhbnVwUmVwb0Jhc2UoYmFzZSwgcHJldmlvdXNDd2QpKTtcblxuICBjb25zdCBzID0gbWFrZVNlc3Npb24oeyBiYXNlUGF0aDogYmFzZSwgb3JpZ2luYWxCYXNlUGF0aDogYmFzZSB9KTtcbiAgY29uc3QgZGVwcyA9IG1ha2VEZXBzKCk7XG4gIGNvbnN0IGN0eCA9IG1ha2VDdHgoKTtcbiAgY29uc3QgbGlmZWN5Y2xlID0gbmV3IFdvcmt0cmVlTGlmZWN5Y2xlKHMsIGRlcHMpO1xuXG4gIGxpZmVjeWNsZS5kZWdyYWRlVG9CcmFuY2hNb2RlKFwiTTAwMVwiLCBjdHgpO1xuXG4gIGFzc2VydC5lcXVhbChzLmlzb2xhdGlvbkRlZ3JhZGVkLCB0cnVlKTtcbiAgLy8gQWZ0ZXIgQzMgKCM1NjI2KSBgaW52YWxpZGF0ZUFsbENhY2hlc2AgaXMgaW5saW5lZC5cbn0pO1xuXG50ZXN0KFwiZGVncmFkZVRvQnJhbmNoTW9kZSBpcyBuby1vcCB3aGVuIGlzb2xhdGlvbkRlZ3JhZGVkIGlzIGFscmVhZHkgdHJ1ZVwiLCAoKSA9PiB7XG4gIGNvbnN0IHMgPSBtYWtlU2Vzc2lvbigpO1xuICBzLmlzb2xhdGlvbkRlZ3JhZGVkID0gdHJ1ZTtcbiAgY29uc3QgZGVwcyA9IG1ha2VEZXBzKCk7XG4gIGNvbnN0IGN0eCA9IG1ha2VDdHgoKTtcbiAgY29uc3QgbGlmZWN5Y2xlID0gbmV3IFdvcmt0cmVlTGlmZWN5Y2xlKHMsIGRlcHMpO1xuXG4gIGxpZmVjeWNsZS5kZWdyYWRlVG9CcmFuY2hNb2RlKFwiTTAwMVwiLCBjdHgpO1xuXG4gIC8vIFByZS1jaGVjayByZXR1cm5zIGVhcmx5IGJlZm9yZSBhbnkgc2lkZSBlZmZlY3QuIEFmdGVyIEMzIHRoZVxuICAvLyBgaW52YWxpZGF0ZUFsbENhY2hlc2AgbW9jayBpcyBnb25lOyB3ZSBhc3NlcnQgdGhlIG9ic2VydmFibGVcbiAgLy8gY29udHJhY3Q6IGBzLmlzb2xhdGlvbkRlZ3JhZGVkYCBzdGF5cyB0cnVlIGFuZCBubyBub3RpZnkgbWVzc2FnZVxuICAvLyBpcyBlbWl0dGVkLlxuICBhc3NlcnQuZXF1YWwocy5pc29sYXRpb25EZWdyYWRlZCwgdHJ1ZSk7XG4gIGFzc2VydC5lcXVhbChjdHgubWVzc2FnZXMubGVuZ3RoLCAwKTtcbn0pO1xuXG50ZXN0KFwiZGVncmFkZVRvQnJhbmNoTW9kZSBtYXJrcyBkZWdyYWRlZCBhbmQgbm90aWZpZXMgb24gYnJhbmNoLW1vZGUgZmFpbHVyZVwiLCAoKSA9PiB7XG4gIC8vIFN5bnRoZXRpYyAvcHJvamVjdCBjYXVzZXMgdGhlIHJlYWwgYGVudGVyQnJhbmNoTW9kZUZvck1pbGVzdG9uZWAgdG9cbiAgLy8gdGhyb3cgXHUyMDE0IHNhbWUgc2hhcGUgYXMgdGhlIG9yaWdpbmFsIG1vY2stdGhyb3dzIHRlc3QgYnV0IGV4ZXJjaXNlcyB0aGVcbiAgLy8gcHJvZHVjdGlvbiBlcnJvciBwYXRoIGFnYWluc3QgdGhlIGlubGluZWQgaGVscGVyLlxuICBjb25zdCBzID0gbWFrZVNlc3Npb24oKTtcbiAgY29uc3QgZGVwcyA9IG1ha2VEZXBzKHt9KTtcbiAgY29uc3QgY3R4ID0gbWFrZUN0eCgpO1xuICBjb25zdCBsaWZlY3ljbGUgPSBuZXcgV29ya3RyZWVMaWZlY3ljbGUocywgZGVwcyk7XG5cbiAgbGlmZWN5Y2xlLmRlZ3JhZGVUb0JyYW5jaE1vZGUoXCJNMDAxXCIsIGN0eCk7XG5cbiAgYXNzZXJ0LmVxdWFsKHMuaXNvbGF0aW9uRGVncmFkZWQsIHRydWUpO1xuICBhc3NlcnQub2soXG4gICAgY3R4Lm1lc3NhZ2VzLnNvbWUoXG4gICAgICAobSkgPT4gbS5sZXZlbCA9PT0gXCJ3YXJuaW5nXCIgJiYgbS5tc2cuaW5jbHVkZXMoXCJCcmFuY2ggaXNvbGF0aW9uIHNldHVwXCIpLFxuICAgICksXG4gICk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHJlc3RvcmVUb1Byb2plY3RSb290IChpc3N1ZSAjNTU4NykgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJyZXN0b3JlVG9Qcm9qZWN0Um9vdCByZXN0b3JlcyBiYXNlUGF0aCB0byBvcmlnaW5hbEJhc2VQYXRoIGFuZCByZWJ1aWxkcyBnaXQgc2VydmljZVwiLCAoKSA9PiB7XG4gIGNvbnN0IHMgPSBtYWtlU2Vzc2lvbigpO1xuICBzLm9yaWdpbmFsQmFzZVBhdGggPSBcIi9wcm9qZWN0XCI7XG4gIHMuYmFzZVBhdGggPSBcIi9wcm9qZWN0Ly5nc2Qvd29ya3RyZWVzL00wMDFcIjtcbiAgY29uc3QgZGVwcyA9IG1ha2VEZXBzKCk7XG4gIGNvbnN0IGxpZmVjeWNsZSA9IG5ldyBXb3JrdHJlZUxpZmVjeWNsZShzLCBkZXBzKTtcblxuICBsaWZlY3ljbGUucmVzdG9yZVRvUHJvamVjdFJvb3QoKTtcblxuICBhc3NlcnQuZXF1YWwocy5iYXNlUGF0aCwgXCIvcHJvamVjdFwiKTtcbiAgLy8gQWZ0ZXIgQzQgKCM1NjI3KSB0aGUgcmVidWlsZCBnb2VzIHRocm91Z2ggYGdpdFNlcnZpY2VGYWN0b3J5YFxuICAvLyBpbnN0ZWFkIG9mIGBuZXcgR2l0U2VydmljZUltcGwoLi4uKWAuIGBpbnZhbGlkYXRlQWxsQ2FjaGVzYCBpc1xuICAvLyBpbmxpbmVkIHBvc3QtQzMgYW5kIG5vIGxvbmdlciByb3V0ZXMgdGhyb3VnaCBkZXBzLlxuICBhc3NlcnQuZXF1YWwoXG4gICAgZGVwcy5jYWxscy5maWx0ZXIoKGMpID0+IGMuZm4gPT09IFwiZ2l0U2VydmljZUZhY3RvcnlcIikubGVuZ3RoLFxuICAgIDEsXG4gICk7XG59KTtcblxudGVzdChcInJlc3RvcmVUb1Byb2plY3RSb290IHJlYnVpbGRzIGdpdCBzZXJ2aWNlIHZpYSBnaXRTZXJ2aWNlRmFjdG9yeSBhdCB0aGUgcmVzdG9yZWQgYmFzZSBwYXRoXCIsICgpID0+IHtcbiAgLy8gQURSLTAxNiBwaGFzZSAyIC8gQzQgKCM1NjI3KTogdGhlIGdpdENvbmZpZyBsb2FkICsgR2l0U2VydmljZUltcGxcbiAgLy8gY29uc3RydWN0aW9uIG5vdyBsaXZlIGJlaGluZCB0aGUgYGdpdFNlcnZpY2VGYWN0b3J5YCBzZWFtLiBMaWZlY3ljbGVcbiAgLy8gaXMgbm8gbG9uZ2VyIHJlc3BvbnNpYmxlIGZvciBlaXRoZXI7IHRoZSB0ZXN0IGFzc2VydHMgb25seSB0aGF0IHRoZVxuICAvLyBmYWN0b3J5IGlzIGludm9rZWQgd2l0aCB0aGUgcmVzdG9yZWQgYmFzZVBhdGguXG4gIGNvbnN0IHMgPSBtYWtlU2Vzc2lvbigpO1xuICBzLm9yaWdpbmFsQmFzZVBhdGggPSBcIi9wcm9qZWN0XCI7XG4gIHMuYmFzZVBhdGggPSBcIi9wcm9qZWN0Ly5nc2Qvd29ya3RyZWVzL00wMDFcIjtcbiAgY29uc3QgZGVwcyA9IG1ha2VEZXBzKCk7XG4gIGNvbnN0IGxpZmVjeWNsZSA9IG5ldyBXb3JrdHJlZUxpZmVjeWNsZShzLCBkZXBzKTtcblxuICBsaWZlY3ljbGUucmVzdG9yZVRvUHJvamVjdFJvb3QoKTtcblxuICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgIGRlcHMuY2FsbHMuZmluZCgoYykgPT4gYy5mbiA9PT0gXCJnaXRTZXJ2aWNlRmFjdG9yeVwiKT8uYXJncyxcbiAgICBbXCIvcHJvamVjdFwiXSxcbiAgKTtcbn0pO1xuXG50ZXN0KFwicmVzdG9yZVRvUHJvamVjdFJvb3QgaXMgbm8tb3Agd2hlbiBvcmlnaW5hbEJhc2VQYXRoIGlzIGVtcHR5XCIsICgpID0+IHtcbiAgY29uc3QgcyA9IG1ha2VTZXNzaW9uKCk7XG4gIHMub3JpZ2luYWxCYXNlUGF0aCA9IFwiXCI7XG4gIHMuYmFzZVBhdGggPSBcIi9zb21lL3BhdGhcIjtcbiAgY29uc3QgZGVwcyA9IG1ha2VEZXBzKCk7XG4gIGNvbnN0IGxpZmVjeWNsZSA9IG5ldyBXb3JrdHJlZUxpZmVjeWNsZShzLCBkZXBzKTtcblxuICBsaWZlY3ljbGUucmVzdG9yZVRvUHJvamVjdFJvb3QoKTtcblxuICBhc3NlcnQuZXF1YWwocy5iYXNlUGF0aCwgXCIvc29tZS9wYXRoXCIpOyAvLyB1bmNoYW5nZWRcbiAgYXNzZXJ0LmVxdWFsKGRlcHMuY2FsbHMuZmlsdGVyKChjKSA9PiBjLmZuID09PSBcImdpdFNlcnZpY2VGYWN0b3J5XCIpLmxlbmd0aCwgMCk7XG59KTtcblxudGVzdChcInJlc3RvcmVUb1Byb2plY3RSb290IGNvbXBsZXRlcyBzZXNzaW9uLXN0YXRlIHJlc3RvcmUgZXZlbiB3aGVuIGNoZGlyIGZhaWxzIChBRFItMDE2IHBoYXNlIDMsICM1NjkzKVwiLCAoKSA9PiB7XG4gIC8vIFRoZSB2ZXJiIGF0dGVtcHRzIHByb2Nlc3MuY2hkaXIgdG8gcy5iYXNlUGF0aCBhZnRlciByZXN0b3JpbmcgaXQuIFRoZVxuICAvLyBjaGRpciBpcyBiZXN0LWVmZm9ydDsgZmFpbHVyZSBtdXN0IG5vdCBhYm9ydCB0aGUgc2Vzc2lvbi1zdGF0ZSByZXN0b3JlLlxuICAvLyBXZSBleGVyY2lzZSB0aGF0IGNvbnRyYWN0IGJ5IHBvaW50aW5nIG9yaWdpbmFsQmFzZVBhdGggYXQgYSBwYXRoIHRoYXRcbiAgLy8gY2Fubm90IGJlIGNoZGlyJ2QgaW50by5cbiAgY29uc3QgcyA9IG1ha2VTZXNzaW9uKCk7XG4gIHMub3JpZ2luYWxCYXNlUGF0aCA9IFwiL3RoaXMvcGF0aC9zaG91bGQvbm90L2V4aXN0L2luL2FueS90ZXN0L2VudlwiO1xuICBzLmJhc2VQYXRoID0gXCIvcHJvamVjdC8uZ3NkL3dvcmt0cmVlcy9NMDAxXCI7XG4gIGNvbnN0IGRlcHMgPSBtYWtlRGVwcygpO1xuICBjb25zdCBsaWZlY3ljbGUgPSBuZXcgV29ya3RyZWVMaWZlY3ljbGUocywgZGVwcyk7XG5cbiAgLy8gQ2FwdHVyZSBjd2Qgc28gd2UgY2FuIGNvbmZpcm0gd2UgZGlkIE5PVCBzdWNjZXNzZnVsbHkgY2hkaXIuXG4gIGNvbnN0IGN3ZEJlZm9yZSA9IHByb2Nlc3MuY3dkKCk7XG4gIGxpZmVjeWNsZS5yZXN0b3JlVG9Qcm9qZWN0Um9vdCgpO1xuXG4gIC8vIFNlc3Npb24tc3RhdGUgcmVzdG9yZSBoYXBwZW5lZCBkZXNwaXRlIGNoZGlyIGZhaWx1cmUuXG4gIGFzc2VydC5lcXVhbChzLmJhc2VQYXRoLCBcIi90aGlzL3BhdGgvc2hvdWxkL25vdC9leGlzdC9pbi9hbnkvdGVzdC9lbnZcIik7XG4gIGFzc2VydC5lcXVhbChcbiAgICBkZXBzLmNhbGxzLmZpbHRlcigoYykgPT4gYy5mbiA9PT0gXCJnaXRTZXJ2aWNlRmFjdG9yeVwiKS5sZW5ndGgsXG4gICAgMSxcbiAgKTtcbiAgLy8gY3dkIGlzIHVuY2hhbmdlZCBiZWNhdXNlIGNoZGlyIHRocmV3IGFuZCB3YXMgc3dhbGxvd2VkLlxuICBhc3NlcnQuZXF1YWwocHJvY2Vzcy5jd2QoKSwgY3dkQmVmb3JlKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgYWRvcHRTZXNzaW9uUm9vdCAoQURSLTAxNiBwaGFzZSAyIC8gQjIsIGlzc3VlICM1NjIwKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcImFkb3B0U2Vzc2lvblJvb3Qgc2V0cyBiYXNlUGF0aCBhbmQgc2VlZHMgb3JpZ2luYWxCYXNlUGF0aCBvbiBhIGZyZXNoIHNlc3Npb25cIiwgKCkgPT4ge1xuICBjb25zdCBzID0gbWFrZVNlc3Npb24oKTtcbiAgcy5iYXNlUGF0aCA9IFwiXCI7XG4gIHMub3JpZ2luYWxCYXNlUGF0aCA9IFwiXCI7XG4gIGNvbnN0IGxpZmVjeWNsZSA9IG5ldyBXb3JrdHJlZUxpZmVjeWNsZShzLCBtYWtlRGVwcygpKTtcblxuICBsaWZlY3ljbGUuYWRvcHRTZXNzaW9uUm9vdChcIi9wcm9qZWN0XCIpO1xuXG4gIGFzc2VydC5lcXVhbChzLmJhc2VQYXRoLCBcIi9wcm9qZWN0XCIpO1xuICBhc3NlcnQuZXF1YWwocy5vcmlnaW5hbEJhc2VQYXRoLCBcIi9wcm9qZWN0XCIpO1xufSk7XG5cbnRlc3QoXCJhZG9wdFNlc3Npb25Sb290IHByZXNlcnZlcyBhIHByZS1leGlzdGluZyBvcmlnaW5hbEJhc2VQYXRoIHdoZW4gbm8gb3ZlcnJpZGUgaXMgcGFzc2VkXCIsICgpID0+IHtcbiAgLy8gUmVzdW1lLWZyb20tcGF1c2VkIHBhdGggKGF1dG8udHM6MjE0OCBhZnRlciBtZXRhLXJlc3RvcmUgYXQgMjAwMy8yMDU1KTpcbiAgLy8gcy5vcmlnaW5hbEJhc2VQYXRoIHdhcyBhbHJlYWR5IHJlc3RvcmVkIGZyb20gcGF1c2VkIG1ldGFkYXRhOyB0aGUgdmVyYlxuICAvLyBtdXN0IE5PVCBvdmVyd3JpdGUgdGhhdCB2YWx1ZS5cbiAgY29uc3QgcyA9IG1ha2VTZXNzaW9uKCk7XG4gIHMuYmFzZVBhdGggPSBcIlwiO1xuICBzLm9yaWdpbmFsQmFzZVBhdGggPSBcIi9wZXJzaXN0ZWQvcHJvamVjdC1yb290XCI7XG4gIGNvbnN0IGxpZmVjeWNsZSA9IG5ldyBXb3JrdHJlZUxpZmVjeWNsZShzLCBtYWtlRGVwcygpKTtcblxuICBsaWZlY3ljbGUuYWRvcHRTZXNzaW9uUm9vdChcIi9wcm9qZWN0XCIpO1xuXG4gIGFzc2VydC5lcXVhbChzLmJhc2VQYXRoLCBcIi9wcm9qZWN0XCIpO1xuICBhc3NlcnQuZXF1YWwocy5vcmlnaW5hbEJhc2VQYXRoLCBcIi9wZXJzaXN0ZWQvcHJvamVjdC1yb290XCIpO1xufSk7XG5cbnRlc3QoXCJhZG9wdFNlc3Npb25Sb290IGhvbm9ycyBhbiBleHBsaWNpdCBvcmlnaW5hbEJhc2Ugb3ZlcnJpZGVcIiwgKCkgPT4ge1xuICBjb25zdCBzID0gbWFrZVNlc3Npb24oKTtcbiAgcy5iYXNlUGF0aCA9IFwiXCI7XG4gIHMub3JpZ2luYWxCYXNlUGF0aCA9IFwiL29sZC1yb290XCI7XG4gIGNvbnN0IGxpZmVjeWNsZSA9IG5ldyBXb3JrdHJlZUxpZmVjeWNsZShzLCBtYWtlRGVwcygpKTtcblxuICBsaWZlY3ljbGUuYWRvcHRTZXNzaW9uUm9vdChcIi9wcm9qZWN0XCIsIFwiL2V4cGxpY2l0LW9yaWdpbmFsXCIpO1xuXG4gIGFzc2VydC5lcXVhbChzLmJhc2VQYXRoLCBcIi9wcm9qZWN0XCIpO1xuICBhc3NlcnQuZXF1YWwocy5vcmlnaW5hbEJhc2VQYXRoLCBcIi9leHBsaWNpdC1vcmlnaW5hbFwiKTtcbn0pO1xuXG50ZXN0KFwiYWRvcHRTZXNzaW9uUm9vdCBkb2VzIG5vdCBjaGRpciwgcmVidWlsZCBnaXQgc2VydmljZSwgb3IgaW52YWxpZGF0ZSBjYWNoZXNcIiwgKCkgPT4ge1xuICAvLyBUaGUgdmVyYiBpcyBhIHB1cmUgc2Vzc2lvbi1zdGF0ZSBtdXRhdGlvbi4gU2lkZSBlZmZlY3RzIChjaGRpciwgZ2l0XG4gIC8vIHNlcnZpY2UgcmVidWlsZCwgY2FjaGUgaW52YWxpZGF0aW9uKSBiZWxvbmcgdG8gb3RoZXIgTGlmZWN5Y2xlIHZlcmJzXG4gIC8vIChgZW50ZXJNaWxlc3RvbmVgLCBgcmVzdG9yZVRvUHJvamVjdFJvb3RgKS5cbiAgY29uc3QgcyA9IG1ha2VTZXNzaW9uKCk7XG4gIHMuYmFzZVBhdGggPSBcIlwiO1xuICBzLm9yaWdpbmFsQmFzZVBhdGggPSBcIlwiO1xuICBjb25zdCBkZXBzID0gbWFrZURlcHMoKTtcbiAgY29uc3QgbGlmZWN5Y2xlID0gbmV3IFdvcmt0cmVlTGlmZWN5Y2xlKHMsIGRlcHMpO1xuXG4gIGxpZmVjeWNsZS5hZG9wdFNlc3Npb25Sb290KFwiL3Byb2plY3RcIik7XG5cbiAgYXNzZXJ0LmVxdWFsKGRlcHMuY2FsbHMuZmlsdGVyKChjKSA9PiBjLmZuID09PSBcImdpdFNlcnZpY2VGYWN0b3J5XCIpLmxlbmd0aCwgMCk7XG4gIGFzc2VydC5lcXVhbChkZXBzLmNhbGxzLmZpbHRlcigoYykgPT4gYy5mbiA9PT0gXCJpbnZhbGlkYXRlQWxsQ2FjaGVzXCIpLmxlbmd0aCwgMCk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHJlc3VtZUZyb21QYXVzZWRTZXNzaW9uIChBRFItMDE2IHBoYXNlIDIgLyBCMywgaXNzdWUgIzU2MjEpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwicmVzdW1lRnJvbVBhdXNlZFNlc3Npb24gYWRvcHRzIHRoZSBwZXJzaXN0ZWQgd29ya3RyZWUgcGF0aCB3aGVuIGl0IGV4aXN0c1wiLCAodCkgPT4ge1xuICAvLyBVc2UgYSByZWFsIHRlbXAgZGlyZWN0b3J5IHNvIHRoZSBleGlzdHNTeW5jIGNoZWNrIGluc2lkZSB0aGUgdmVyYlxuICAvLyBzdWNjZWVkcy4gRWFybGllciBgcHJvY2Vzcy5jd2QoKWAgcmFuIGludG8gRU5PRU5UIGFmdGVyIHNpYmxpbmcgdGVzdHNcbiAgLy8gZGVsZXRlZCB0aGVpciBiYXNlUGF0aHMgYW5kIGxlZnQgY3dkIGRhbmdsaW5nLlxuICBjb25zdCB3dERpciA9IHJlYWxwYXRoU3luYyhta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1yZXN1bWUtdGVzdC1cIikpKTtcbiAgdC5hZnRlcigoKSA9PiB7IHRyeSB7IHJtU3luYyh3dERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pOyB9IGNhdGNoIHsgLyogKi8gfSB9KTtcblxuICBjb25zdCBzID0gbWFrZVNlc3Npb24oKTtcbiAgcy5iYXNlUGF0aCA9IFwiL3NvbWUvb2xkL3BhdGhcIjtcbiAgY29uc3QgbGlmZWN5Y2xlID0gbmV3IFdvcmt0cmVlTGlmZWN5Y2xlKHMsIG1ha2VEZXBzKCkpO1xuXG4gIC8vIFZlcmlmeSB0aGUgcHVyZSBoZWxwZXIncyBjb250cmFjdCBmaXJzdCAoZm9sZGVkIGluIGZyb20gdGhlIGxlZ2FjeVxuICAvLyBfcmVzb2x2ZVBhdXNlZFJlc3VtZUJhc2VQYXRoRm9yVGVzdClcbiAgYXNzZXJ0LmVxdWFsKFxuICAgIHJlc29sdmVQYXVzZWRSZXN1bWVCYXNlUGF0aChcIi9wcm9qZWN0XCIsIFwiL3BlcnNpc3RlZC93b3JrdHJlZS9NMDAxXCIsICgpID0+IHRydWUpLFxuICAgIFwiL3BlcnNpc3RlZC93b3JrdHJlZS9NMDAxXCIsXG4gICk7XG5cbiAgLy8gRXhlcmNpc2UgdGhlIHZlcmIgd2l0aCBhIHJlYWwgcGF0aCB0aGF0IGV4aXN0cy5cbiAgbGlmZWN5Y2xlLnJlc3VtZUZyb21QYXVzZWRTZXNzaW9uKFwiL3Byb2plY3RcIiwgd3REaXIpO1xuICBhc3NlcnQuZXF1YWwocy5iYXNlUGF0aCwgd3REaXIpO1xufSk7XG5cbnRlc3QoXCJyZXN1bWVGcm9tUGF1c2VkU2Vzc2lvbiBmYWxscyBiYWNrIHRvIGJhc2Ugd2hlbiBwZXJzaXN0ZWQgd29ya3RyZWUgaXMgbnVsbFwiLCAoKSA9PiB7XG4gIGNvbnN0IHMgPSBtYWtlU2Vzc2lvbigpO1xuICBzLmJhc2VQYXRoID0gXCIvb2xkXCI7XG4gIGNvbnN0IGxpZmVjeWNsZSA9IG5ldyBXb3JrdHJlZUxpZmVjeWNsZShzLCBtYWtlRGVwcygpKTtcblxuICBsaWZlY3ljbGUucmVzdW1lRnJvbVBhdXNlZFNlc3Npb24oXCIvcHJvamVjdFwiLCBudWxsKTtcbiAgYXNzZXJ0LmVxdWFsKHMuYmFzZVBhdGgsIFwiL3Byb2plY3RcIik7XG59KTtcblxudGVzdChcInJlc3VtZUZyb21QYXVzZWRTZXNzaW9uIGZhbGxzIGJhY2sgdG8gYmFzZSB3aGVuIHBlcnNpc3RlZCB3b3JrdHJlZSBkb2VzIG5vdCBleGlzdFwiLCAoKSA9PiB7XG4gIGNvbnN0IHMgPSBtYWtlU2Vzc2lvbigpO1xuICBzLmJhc2VQYXRoID0gXCIvb2xkXCI7XG4gIGNvbnN0IGxpZmVjeWNsZSA9IG5ldyBXb3JrdHJlZUxpZmVjeWNsZShzLCBtYWtlRGVwcygpKTtcblxuICBsaWZlY3ljbGUucmVzdW1lRnJvbVBhdXNlZFNlc3Npb24oXG4gICAgXCIvcHJvamVjdFwiLFxuICAgIFwiL3RoaXMvcGF0aC9kb2VzL25vdC9leGlzdC9hYmMveHl6XCIsXG4gICk7XG4gIGFzc2VydC5lcXVhbChzLmJhc2VQYXRoLCBcIi9wcm9qZWN0XCIpO1xufSk7XG5cbnRlc3QoXCJyZXN1bWVGcm9tUGF1c2VkU2Vzc2lvbiBkb2VzIG5vdCBjaGRpciwgcmVidWlsZCBnaXQgc2VydmljZSwgb3IgaW52YWxpZGF0ZSBjYWNoZXNcIiwgKCkgPT4ge1xuICBjb25zdCBzID0gbWFrZVNlc3Npb24oKTtcbiAgY29uc3QgZGVwcyA9IG1ha2VEZXBzKCk7XG4gIGNvbnN0IGxpZmVjeWNsZSA9IG5ldyBXb3JrdHJlZUxpZmVjeWNsZShzLCBkZXBzKTtcblxuICBsaWZlY3ljbGUucmVzdW1lRnJvbVBhdXNlZFNlc3Npb24oXCIvcHJvamVjdFwiLCBudWxsKTtcblxuICBhc3NlcnQuZXF1YWwoZGVwcy5jYWxscy5maWx0ZXIoKGMpID0+IGMuZm4gPT09IFwiZ2l0U2VydmljZUZhY3RvcnlcIikubGVuZ3RoLCAwKTtcbiAgYXNzZXJ0LmVxdWFsKGRlcHMuY2FsbHMuZmlsdGVyKChjKSA9PiBjLmZuID09PSBcImludmFsaWRhdGVBbGxDYWNoZXNcIikubGVuZ3RoLCAwKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgYWRvcHRPcnBoYW5Xb3JrdHJlZSAoQURSLTAxNiBwaGFzZSAyIC8gQjQsIGlzc3VlICM1NjIyKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLy8gQWZ0ZXIgQzIgKCM1NjI1KSB0aGUgYGdldEF1dG9Xb3JrdHJlZVBhdGhgIHByaW1pdGl2ZSBpcyBpbmxpbmVkLCBzbyB0aGVzZVxuLy8gdGVzdHMgdXNlIGEgcmVhbC1naXQgZml4dHVyZSB3aXRoIGEgcHJlLWNyZWF0ZWQgd29ya3RyZWUgdG8gZXhlcmNpc2UgdGhlXG4vLyBzd2FwLXJ1bi1yZXZlcnQgcHJvdG9jb2wuIFRoZSBcImZhbGwgYmFjayB3aGVuIGdldEF1dG9Xb3JrdHJlZVBhdGggcmV0dXJuc1xuLy8gbnVsbFwiIHRlc3QgdXNlcyBhIGZpeHR1cmUgV0lUSE9VVCBhIHdvcmt0cmVlIHNvIHRoZSByZWFsIGNhbGwgcmV0dXJucyBudWxsLlxuXG50ZXN0KFwiYWRvcHRPcnBoYW5Xb3JrdHJlZSBzd2FwcyB0byB3b3JrdHJlZSBwYXRoIGFuZCByZXZlcnRzIHRvIGJhc2Ugb24gIW1lcmdlZFwiLCAodCkgPT4ge1xuICBjb25zdCBwcmV2aW91c0N3ZCA9IHByb2Nlc3MuY3dkKCk7XG4gIGNvbnN0IGJhc2UgPSBtYWtlR2l0UmVwb0Jhc2UoeyBpc29sYXRpb246IFwid29ya3RyZWVcIiB9KTtcbiAgdC5hZnRlcigoKSA9PiBjbGVhbnVwUmVwb0Jhc2UoYmFzZSwgcHJldmlvdXNDd2QpKTtcbiAgY29uc3Qgd3QgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIndvcmt0cmVlc1wiLCBcIk0wMDFcIik7XG4gIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJjaGVja291dFwiLCBcIi1iXCIsIFwibWlsZXN0b25lL00wMDFcIl0sIHsgY3dkOiBiYXNlLCBzdGRpbzogXCJwaXBlXCIgfSk7XG4gIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJjaGVja291dFwiLCBcIm1haW5cIl0sIHsgY3dkOiBiYXNlLCBzdGRpbzogXCJwaXBlXCIgfSk7XG4gIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJ3b3JrdHJlZVwiLCBcImFkZFwiLCB3dCwgXCJtaWxlc3RvbmUvTTAwMVwiXSwgeyBjd2Q6IGJhc2UsIHN0ZGlvOiBcInBpcGVcIiB9KTtcblxuICBjb25zdCBzID0gbWFrZVNlc3Npb24oKTtcbiAgcy5iYXNlUGF0aCA9IFwiL29sZFwiO1xuICBzLm9yaWdpbmFsQmFzZVBhdGggPSBcIi9vbGRcIjtcbiAgcy5hY3RpdmUgPSB0cnVlO1xuICBjb25zdCBsaWZlY3ljbGUgPSBuZXcgV29ya3RyZWVMaWZlY3ljbGUocywgbWFrZURlcHMoKSk7XG5cbiAgbGV0IGJhc2VQYXRoSW5zaWRlQ2FsbGJhY2sgPSBcIlwiO1xuICBjb25zdCByZXN1bHQgPSBsaWZlY3ljbGUuYWRvcHRPcnBoYW5Xb3JrdHJlZShcIk0wMDFcIiwgYmFzZSwgKCkgPT4ge1xuICAgIGJhc2VQYXRoSW5zaWRlQ2FsbGJhY2sgPSBzLmJhc2VQYXRoO1xuICAgIHJldHVybiB7IG1lcmdlZDogZmFsc2UgYXMgY29uc3QsIHJlYXNvbjogXCJzeW50aGV0aWNcIiB9O1xuICB9KTtcblxuICBhc3NlcnQuZXF1YWwoYmFzZVBhdGhJbnNpZGVDYWxsYmFjaywgd3QpO1xuICBhc3NlcnQuZXF1YWwocy5iYXNlUGF0aCwgYmFzZSk7XG4gIGFzc2VydC5lcXVhbChzLm9yaWdpbmFsQmFzZVBhdGgsIGJhc2UpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0Lm1lcmdlZCwgZmFsc2UpO1xufSk7XG5cbnRlc3QoXCJhZG9wdE9ycGhhbldvcmt0cmVlIGhvbGRzIHRoZSBzd2FwIG9uIG1lcmdlZCAmJiBhY3RpdmVcIiwgKHQpID0+IHtcbiAgY29uc3QgcHJldmlvdXNDd2QgPSBwcm9jZXNzLmN3ZCgpO1xuICBjb25zdCBiYXNlID0gbWFrZUdpdFJlcG9CYXNlKHsgaXNvbGF0aW9uOiBcIndvcmt0cmVlXCIgfSk7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cFJlcG9CYXNlKGJhc2UsIHByZXZpb3VzQ3dkKSk7XG4gIGNvbnN0IHd0ID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJ3b3JrdHJlZXNcIiwgXCJNMDAxXCIpO1xuICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiY2hlY2tvdXRcIiwgXCItYlwiLCBcIm1pbGVzdG9uZS9NMDAxXCJdLCB7IGN3ZDogYmFzZSwgc3RkaW86IFwicGlwZVwiIH0pO1xuICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiY2hlY2tvdXRcIiwgXCJtYWluXCJdLCB7IGN3ZDogYmFzZSwgc3RkaW86IFwicGlwZVwiIH0pO1xuICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wid29ya3RyZWVcIiwgXCJhZGRcIiwgd3QsIFwibWlsZXN0b25lL00wMDFcIl0sIHsgY3dkOiBiYXNlLCBzdGRpbzogXCJwaXBlXCIgfSk7XG5cbiAgY29uc3QgcyA9IG1ha2VTZXNzaW9uKCk7XG4gIHMuYmFzZVBhdGggPSBcIi9vbGRcIjtcbiAgcy5vcmlnaW5hbEJhc2VQYXRoID0gXCIvb2xkXCI7XG4gIHMuYWN0aXZlID0gdHJ1ZTtcbiAgY29uc3QgbGlmZWN5Y2xlID0gbmV3IFdvcmt0cmVlTGlmZWN5Y2xlKHMsIG1ha2VEZXBzKCkpO1xuXG4gIGxpZmVjeWNsZS5hZG9wdE9ycGhhbldvcmt0cmVlKFwiTTAwMVwiLCBiYXNlLCAoKSA9PiAoe1xuICAgIG1lcmdlZDogdHJ1ZSBhcyBjb25zdCxcbiAgfSkpO1xuXG4gIGFzc2VydC5lcXVhbChzLmJhc2VQYXRoLCB3dCk7XG4gIGFzc2VydC5lcXVhbChzLm9yaWdpbmFsQmFzZVBhdGgsIGJhc2UpO1xufSk7XG5cbnRlc3QoXCJhZG9wdE9ycGhhbldvcmt0cmVlIHJlc3RvcmVzIHByaW9yIHBhdGhzIG9uIG1lcmdlZCAmJiAhYWN0aXZlXCIsICh0KSA9PiB7XG4gIGNvbnN0IHByZXZpb3VzQ3dkID0gcHJvY2Vzcy5jd2QoKTtcbiAgY29uc3QgYmFzZSA9IG1ha2VHaXRSZXBvQmFzZSh7IGlzb2xhdGlvbjogXCJ3b3JrdHJlZVwiIH0pO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXBSZXBvQmFzZShiYXNlLCBwcmV2aW91c0N3ZCkpO1xuICBjb25zdCB3dCA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwid29ya3RyZWVzXCIsIFwiTTAwMVwiKTtcbiAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcImNoZWNrb3V0XCIsIFwiLWJcIiwgXCJtaWxlc3RvbmUvTTAwMVwiXSwgeyBjd2Q6IGJhc2UsIHN0ZGlvOiBcInBpcGVcIiB9KTtcbiAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcImNoZWNrb3V0XCIsIFwibWFpblwiXSwgeyBjd2Q6IGJhc2UsIHN0ZGlvOiBcInBpcGVcIiB9KTtcbiAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcIndvcmt0cmVlXCIsIFwiYWRkXCIsIHd0LCBcIm1pbGVzdG9uZS9NMDAxXCJdLCB7IGN3ZDogYmFzZSwgc3RkaW86IFwicGlwZVwiIH0pO1xuXG4gIGNvbnN0IHMgPSBtYWtlU2Vzc2lvbigpO1xuICBzLmJhc2VQYXRoID0gXCIvcHJpb3JcIjtcbiAgcy5vcmlnaW5hbEJhc2VQYXRoID0gXCIvcHJpb3Itb3JpZ2luYWxcIjtcbiAgcy5hY3RpdmUgPSBmYWxzZTtcbiAgY29uc3QgbGlmZWN5Y2xlID0gbmV3IFdvcmt0cmVlTGlmZWN5Y2xlKHMsIG1ha2VEZXBzKCkpO1xuXG4gIGxpZmVjeWNsZS5hZG9wdE9ycGhhbldvcmt0cmVlKFwiTTAwMVwiLCBiYXNlLCAoKSA9PiAoe1xuICAgIG1lcmdlZDogdHJ1ZSBhcyBjb25zdCxcbiAgfSkpO1xuXG4gIGFzc2VydC5lcXVhbChzLmJhc2VQYXRoLCBcIi9wcmlvclwiKTtcbiAgYXNzZXJ0LmVxdWFsKHMub3JpZ2luYWxCYXNlUGF0aCwgXCIvcHJpb3Itb3JpZ2luYWxcIik7XG59KTtcblxudGVzdChcImFkb3B0T3JwaGFuV29ya3RyZWUgZmFsbHMgYmFjayB0byBiYXNlIHdoZW4gZ2V0QXV0b1dvcmt0cmVlUGF0aCByZXR1cm5zIG51bGxcIiwgKHQpID0+IHtcbiAgLy8gUmVhbCBmaXh0dXJlIHdpdGggaXNvbGF0aW9uOndvcmt0cmVlIGJ1dCBOTyB3b3JrdHJlZSBwcmUtY3JlYXRlZCBcdTIwMTQgdGhlXG4gIC8vIHJlYWwgYGdldEF1dG9Xb3JrdHJlZVBhdGhgIHJldHVybnMgbnVsbCBzbyB0aGUgdmVyYiBmYWxscyBiYWNrIHRvIGJhc2UuXG4gIGNvbnN0IHByZXZpb3VzQ3dkID0gcHJvY2Vzcy5jd2QoKTtcbiAgY29uc3QgYmFzZSA9IG1ha2VHaXRSZXBvQmFzZSh7IGlzb2xhdGlvbjogXCJ3b3JrdHJlZVwiIH0pO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXBSZXBvQmFzZShiYXNlLCBwcmV2aW91c0N3ZCkpO1xuXG4gIGNvbnN0IHMgPSBtYWtlU2Vzc2lvbigpO1xuICBzLmJhc2VQYXRoID0gXCIvb2xkXCI7XG4gIHMuYWN0aXZlID0gdHJ1ZTtcbiAgY29uc3QgbGlmZWN5Y2xlID0gbmV3IFdvcmt0cmVlTGlmZWN5Y2xlKHMsIG1ha2VEZXBzKCkpO1xuXG4gIGxldCBiYXNlUGF0aEluc2lkZUNhbGxiYWNrID0gXCJcIjtcbiAgbGlmZWN5Y2xlLmFkb3B0T3JwaGFuV29ya3RyZWUoXCJNMDAxXCIsIGJhc2UsICgpID0+IHtcbiAgICBiYXNlUGF0aEluc2lkZUNhbGxiYWNrID0gcy5iYXNlUGF0aDtcbiAgICByZXR1cm4geyBtZXJnZWQ6IHRydWUgYXMgY29uc3QgfTtcbiAgfSk7XG5cbiAgYXNzZXJ0LmVxdWFsKGJhc2VQYXRoSW5zaWRlQ2FsbGJhY2ssIGJhc2UpO1xufSk7XG5cbnRlc3QoXCJhZG9wdE9ycGhhbldvcmt0cmVlIHJlc3RvcmVzIHByaW9yIHBhdGhzIGFuZCBjd2Qgd2hlbiB0aGUgY2FsbGJhY2sgdGhyb3dzXCIsICgpID0+IHtcbiAgY29uc3Qgb3JpZ2luYWxDd2QgPSBwcm9jZXNzLmN3ZCgpO1xuICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2Qtb3JwaGFuLXJvbGxiYWNrLWJhc2UtXCIpKTtcbiAgY29uc3Qgd29ya3RyZWUgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1vcnBoYW4tcm9sbGJhY2std3QtXCIpKTtcbiAgY29uc3QgcyA9IG1ha2VTZXNzaW9uKHtcbiAgICBiYXNlUGF0aDogXCIvcHJpb3JcIixcbiAgICBvcmlnaW5hbEJhc2VQYXRoOiBvcmlnaW5hbEN3ZCxcbiAgICBhY3RpdmU6IHRydWUsXG4gIH0pO1xuICBjb25zdCBkZXBzID0gbWFrZURlcHMoe1xuICAgIGdldEF1dG9Xb3JrdHJlZVBhdGg6ICgpID0+IHdvcmt0cmVlLFxuICB9KTtcbiAgY29uc3QgbGlmZWN5Y2xlID0gbmV3IFdvcmt0cmVlTGlmZWN5Y2xlKHMsIGRlcHMpO1xuICBjb25zdCB0aHJvd24gPSBuZXcgRXJyb3IoXCJzeW50aGV0aWMgY2FsbGJhY2sgZmFpbHVyZVwiKTtcblxuICB0cnkge1xuICAgIGFzc2VydC50aHJvd3MoXG4gICAgICAoKSA9PlxuICAgICAgICBsaWZlY3ljbGUuYWRvcHRPcnBoYW5Xb3JrdHJlZTx7IG1lcmdlZDogYm9vbGVhbiB9PihcIk0wMDFcIiwgYmFzZSwgKCkgPT4ge1xuICAgICAgICAgIGFzc2VydC5lcXVhbChzLmJhc2VQYXRoLCB3b3JrdHJlZSk7XG4gICAgICAgICAgYXNzZXJ0LmVxdWFsKHMub3JpZ2luYWxCYXNlUGF0aCwgYmFzZSk7XG4gICAgICAgICAgdGhyb3cgdGhyb3duO1xuICAgICAgICB9KSxcbiAgICAgIHRocm93bixcbiAgICApO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHMuYmFzZVBhdGgsIFwiL3ByaW9yXCIpO1xuICAgIGFzc2VydC5lcXVhbChzLm9yaWdpbmFsQmFzZVBhdGgsIG9yaWdpbmFsQ3dkKTtcbiAgICBhc3NlcnQuZXF1YWwocHJvY2Vzcy5jd2QoKSwgb3JpZ2luYWxDd2QpO1xuICB9IGZpbmFsbHkge1xuICAgIHByb2Nlc3MuY2hkaXIob3JpZ2luYWxDd2QpO1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgcm1TeW5jKHdvcmt0cmVlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiYWRvcHRPcnBoYW5Xb3JrdHJlZSByZWplY3RzIHRyYXZlcnNhbC1zdHlsZSBtaWxlc3RvbmUgaWRzIGJlZm9yZSBwYXRoIHJlc29sdXRpb25cIiwgKCkgPT4ge1xuICBjb25zdCBzID0gbWFrZVNlc3Npb24oe1xuICAgIGJhc2VQYXRoOiBcIi9wcmlvclwiLFxuICAgIG9yaWdpbmFsQmFzZVBhdGg6IFwiL3ByaW9yLW9yaWdpbmFsXCIsXG4gICAgYWN0aXZlOiB0cnVlLFxuICB9KTtcbiAgY29uc3QgZGVwcyA9IG1ha2VEZXBzKHtcbiAgICBnZXRBdXRvV29ya3RyZWVQYXRoOiAoKSA9PiB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJnZXRBdXRvV29ya3RyZWVQYXRoIHNob3VsZCBub3QgYmUgY2FsbGVkXCIpO1xuICAgIH0sXG4gIH0pO1xuICBjb25zdCBsaWZlY3ljbGUgPSBuZXcgV29ya3RyZWVMaWZlY3ljbGUocywgZGVwcyk7XG5cbiAgYXNzZXJ0LnRocm93cyhcbiAgICAoKSA9PlxuICAgICAgbGlmZWN5Y2xlLmFkb3B0T3JwaGFuV29ya3RyZWUoXCIuLi9NMDAxXCIsIFwiL3Byb2plY3RcIiwgKCkgPT4gKHtcbiAgICAgICAgbWVyZ2VkOiB0cnVlIGFzIGNvbnN0LFxuICAgICAgfSkpLFxuICAgIC9JbnZhbGlkIG1pbGVzdG9uZUlkOiBcXC5cXC5cXC9NMDAxLyxcbiAgKTtcblxuICBhc3NlcnQuZXF1YWwocy5iYXNlUGF0aCwgXCIvcHJpb3JcIik7XG4gIGFzc2VydC5lcXVhbChzLm9yaWdpbmFsQmFzZVBhdGgsIFwiL3ByaW9yLW9yaWdpbmFsXCIpO1xuICBhc3NlcnQuZXF1YWwoXG4gICAgZGVwcy5jYWxscy5maWx0ZXIoKGMpID0+IGMuZm4gPT09IFwiZ2V0QXV0b1dvcmt0cmVlUGF0aFwiKS5sZW5ndGgsXG4gICAgMCxcbiAgKTtcbn0pO1xuXG50ZXN0KFwiYWRvcHRPcnBoYW5Xb3JrdHJlZSBmb3J3YXJkcyB0aGUgY2FsbGJhY2sncyByZXR1cm4gdmFsdWVcIiwgKHQpID0+IHtcbiAgY29uc3QgcHJldmlvdXNDd2QgPSBwcm9jZXNzLmN3ZCgpO1xuICBjb25zdCBiYXNlID0gbWFrZUdpdFJlcG9CYXNlKHsgaXNvbGF0aW9uOiBcIndvcmt0cmVlXCIgfSk7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cFJlcG9CYXNlKGJhc2UsIHByZXZpb3VzQ3dkKSk7XG5cblxuICBjb25zdCBzID0gbWFrZVNlc3Npb24oKTtcbiAgcy5hY3RpdmUgPSB0cnVlO1xuICBjb25zdCBsaWZlY3ljbGUgPSBuZXcgV29ya3RyZWVMaWZlY3ljbGUocywgbWFrZURlcHMoKSk7XG5cbiAgY29uc3QgcmVzdWx0ID0gbGlmZWN5Y2xlLmFkb3B0T3JwaGFuV29ya3RyZWUoXCJNMDAxXCIsIGJhc2UsICgpID0+ICh7XG4gICAgbWVyZ2VkOiB0cnVlIGFzIGNvbnN0LFxuICAgIGN1c3RvbUZpZWxkOiBcInByZXNlcnZlZFwiLFxuICB9KSk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5tZXJnZWQsIHRydWUpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LmN1c3RvbUZpZWxkLCBcInByZXNlcnZlZFwiKTtcbn0pO1xuXG50ZXN0KFwiYWRvcHRPcnBoYW5Xb3JrdHJlZSBsZWF2ZXMgc2Vzc2lvbiB1bmNoYW5nZWQgd2hlbiBnZXRBdXRvV29ya3RyZWVQYXRoIHRocm93c1wiLCAoKSA9PiB7XG4gIGNvbnN0IHMgPSBtYWtlU2Vzc2lvbigpO1xuICBzLmJhc2VQYXRoID0gXCIvcHJpb3JcIjtcbiAgcy5vcmlnaW5hbEJhc2VQYXRoID0gXCIvcHJpb3Itb3JpZ2luYWxcIjtcbiAgcy5hY3RpdmUgPSB0cnVlO1xuICBjb25zdCBsaWZlY3ljbGUgPSBuZXcgV29ya3RyZWVMaWZlY3ljbGUoXG4gICAgcyxcbiAgICBtYWtlRGVwcyh7XG4gICAgICBnZXRBdXRvV29ya3RyZWVQYXRoOiAoKSA9PiB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcImdpdCBzdGF0ZSB1bmF2YWlsYWJsZVwiKTtcbiAgICAgIH0sXG4gICAgfSksXG4gICk7XG5cbiAgYXNzZXJ0LnRocm93cyhcbiAgICAoKSA9PlxuICAgICAgbGlmZWN5Y2xlLmFkb3B0T3JwaGFuV29ya3RyZWUoXCJNMDAxXCIsIFwiL3Byb2plY3RcIiwgKCkgPT4gKHtcbiAgICAgICAgbWVyZ2VkOiB0cnVlIGFzIGNvbnN0LFxuICAgICAgfSkpLFxuICAgIC9naXQgc3RhdGUgdW5hdmFpbGFibGUvLFxuICApO1xuICBhc3NlcnQuZXF1YWwocy5iYXNlUGF0aCwgXCIvcHJpb3JcIik7XG4gIGFzc2VydC5lcXVhbChzLm9yaWdpbmFsQmFzZVBhdGgsIFwiL3ByaW9yLW9yaWdpbmFsXCIpO1xufSk7XG5cbnRlc3QoXCJhZG9wdE9ycGhhbldvcmt0cmVlIHJlc3RvcmVzIHByaW9yIHBhdGhzIHdoZW4gY2FsbGJhY2sgdGhyb3dzXCIsICgpID0+IHtcbiAgY29uc3QgcyA9IG1ha2VTZXNzaW9uKCk7XG4gIHMuYmFzZVBhdGggPSBcIi9wcmlvclwiO1xuICBzLm9yaWdpbmFsQmFzZVBhdGggPSBcIi9wcmlvci1vcmlnaW5hbFwiO1xuICBzLmFjdGl2ZSA9IHRydWU7XG4gIGNvbnN0IGxpZmVjeWNsZSA9IG5ldyBXb3JrdHJlZUxpZmVjeWNsZShcbiAgICBzLFxuICAgIG1ha2VEZXBzKHtcbiAgICAgIGdldEF1dG9Xb3JrdHJlZVBhdGg6ICgpID0+IFwiL3Byb2plY3QvLmdzZC93b3JrdHJlZXMvTTAwMVwiLFxuICAgIH0pLFxuICApO1xuXG4gIGFzc2VydC50aHJvd3MoXG4gICAgKCkgPT5cbiAgICAgIGxpZmVjeWNsZS5hZG9wdE9ycGhhbldvcmt0cmVlKFwiTTAwMVwiLCBcIi9wcm9qZWN0XCIsICgpID0+IHtcbiAgICAgICAgYXNzZXJ0LmVxdWFsKHMuYmFzZVBhdGgsIFwiL3Byb2plY3QvLmdzZC93b3JrdHJlZXMvTTAwMVwiKTtcbiAgICAgICAgYXNzZXJ0LmVxdWFsKHMub3JpZ2luYWxCYXNlUGF0aCwgXCIvcHJvamVjdFwiKTtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwibWVyZ2UgZXhwbG9kZWRcIik7XG4gICAgICB9KSxcbiAgICAvbWVyZ2UgZXhwbG9kZWQvLFxuICApO1xuICBhc3NlcnQuZXF1YWwocy5iYXNlUGF0aCwgXCIvcHJpb3JcIik7XG4gIGFzc2VydC5lcXVhbChzLm9yaWdpbmFsQmFzZVBhdGgsIFwiL3ByaW9yLW9yaWdpbmFsXCIpO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFFQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxXQUFXLFFBQVEsZUFBZSxvQkFBb0I7QUFDNUUsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsWUFBWTtBQUNyQixTQUFTLG9CQUFvQjtBQUM3QjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FB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
