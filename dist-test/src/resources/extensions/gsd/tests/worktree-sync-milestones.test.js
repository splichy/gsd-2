import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { syncProjectRootToWorktree } from "../auto-worktree.js";
import { syncGsdStateToWorktree, syncWorktreeStateBack } from "../auto-worktree.js";
import { describe } from "node:test";
import assert from "node:assert/strict";
function createBase(name) {
  const base = mkdtempSync(join(tmpdir(), `gsd-wt-sync-${name}-`));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}
function cleanup(base) {
  rmSync(base, { recursive: true, force: true });
}
describe("worktree-sync-milestones", async () => {
  console.log("\n=== 1. milestone directory synced from main to worktree ===");
  {
    const mainBase = createBase("main");
    const wtBase = createBase("wt");
    try {
      const m001Dir = join(mainBase, ".gsd", "milestones", "M001");
      mkdirSync(m001Dir, { recursive: true });
      writeFileSync(join(m001Dir, "M001-CONTEXT.md"), "# M001\nContext.");
      writeFileSync(join(m001Dir, "M001-ROADMAP.md"), "# Roadmap");
      assert.ok(!existsSync(join(wtBase, ".gsd", "milestones", "M001")), "M001 missing before sync");
      syncProjectRootToWorktree(mainBase, wtBase, "M001");
      assert.ok(existsSync(join(wtBase, ".gsd", "milestones", "M001")), "#1311: M001 synced to worktree");
      assert.ok(existsSync(join(wtBase, ".gsd", "milestones", "M001", "M001-CONTEXT.md")), "M001 CONTEXT synced");
      assert.ok(existsSync(join(wtBase, ".gsd", "milestones", "M001", "M001-ROADMAP.md")), "M001 ROADMAP synced");
    } finally {
      cleanup(mainBase);
      cleanup(wtBase);
    }
  }
  console.log("\n=== 2. missing slices within milestone are synced ===");
  {
    const mainBase = createBase("main");
    const wtBase = createBase("wt");
    try {
      const m001Dir = join(mainBase, ".gsd", "milestones", "M001");
      mkdirSync(join(m001Dir, "slices", "S01"), { recursive: true });
      mkdirSync(join(m001Dir, "slices", "S02"), { recursive: true });
      writeFileSync(join(m001Dir, "M001-ROADMAP.md"), "# Roadmap");
      writeFileSync(join(m001Dir, "slices", "S01", "S01-PLAN.md"), "# S01 Plan");
      writeFileSync(join(m001Dir, "slices", "S02", "S02-PLAN.md"), "# S02 Plan");
      const wtM001Dir = join(wtBase, ".gsd", "milestones", "M001");
      mkdirSync(join(wtM001Dir, "slices", "S01"), { recursive: true });
      writeFileSync(join(wtM001Dir, "slices", "S01", "S01-PLAN.md"), "# S01 Plan");
      syncProjectRootToWorktree(mainBase, wtBase, "M001");
      assert.ok(existsSync(join(wtBase, ".gsd", "milestones", "M001", "slices", "S02")), "#1311: S02 synced");
      assert.ok(existsSync(join(wtBase, ".gsd", "milestones", "M001", "slices", "S02", "S02-PLAN.md")), "S02 PLAN synced");
    } finally {
      cleanup(mainBase);
      cleanup(wtBase);
    }
  }
  console.log("\n=== 3. empty gsd.db deleted in worktree after sync ===");
  {
    const mainBase = createBase("main");
    const wtBase = createBase("wt");
    try {
      const m001Dir = join(mainBase, ".gsd", "milestones", "M001");
      mkdirSync(m001Dir, { recursive: true });
      writeFileSync(join(m001Dir, "M001-ROADMAP.md"), "# Roadmap");
      writeFileSync(join(wtBase, ".gsd", "gsd.db"), "");
      assert.ok(existsSync(join(wtBase, ".gsd", "gsd.db")), "gsd.db exists before sync");
      syncProjectRootToWorktree(mainBase, wtBase, "M001");
      assert.ok(!existsSync(join(wtBase, ".gsd", "gsd.db")), "#853: empty gsd.db deleted after sync");
    } finally {
      cleanup(mainBase);
      cleanup(wtBase);
    }
  }
  console.log("\n=== 3b. non-empty gsd.db preserved in worktree after sync (#2815) ===");
  {
    const mainBase = createBase("main");
    const wtBase = createBase("wt");
    try {
      const m001Dir = join(mainBase, ".gsd", "milestones", "M001");
      mkdirSync(m001Dir, { recursive: true });
      writeFileSync(join(m001Dir, "M001-ROADMAP.md"), "# Roadmap");
      writeFileSync(join(wtBase, ".gsd", "gsd.db"), "migrated-db-content");
      assert.ok(existsSync(join(wtBase, ".gsd", "gsd.db")), "gsd.db exists before sync");
      syncProjectRootToWorktree(mainBase, wtBase, "M001");
      assert.ok(existsSync(join(wtBase, ".gsd", "gsd.db")), "#2815: non-empty gsd.db preserved after sync");
    } finally {
      cleanup(mainBase);
      cleanup(wtBase);
    }
  }
  console.log("\n=== 4. no-op when paths are equal ===");
  {
    const base = createBase("same");
    try {
      syncProjectRootToWorktree(base, base, "M001");
      assert.ok(true, "no crash when paths are equal");
    } finally {
      cleanup(base);
    }
  }
  console.log("\n=== 5. no-op when milestoneId is null ===");
  {
    const mainBase = createBase("main");
    const wtBase = createBase("wt");
    try {
      syncProjectRootToWorktree(mainBase, wtBase, null);
      assert.ok(true, "no crash when milestoneId is null");
    } finally {
      cleanup(mainBase);
      cleanup(wtBase);
    }
  }
  console.log("\n=== 6. non-existent directories \u2192 no-op ===");
  {
    syncProjectRootToWorktree("/tmp/does-not-exist-main", "/tmp/does-not-exist-wt", "M001");
    assert.ok(true, "no crash on missing directories");
  }
  console.log("\n=== 7. milestones/ directory created in worktree when missing ===");
  {
    const mainBase = createBase("main");
    const wtBase = mkdtempSync(join(tmpdir(), "gsd-wt-sync-wt-"));
    try {
      mkdirSync(join(wtBase, ".gsd"), { recursive: true });
      const m001Dir = join(mainBase, ".gsd", "milestones", "M001");
      mkdirSync(m001Dir, { recursive: true });
      writeFileSync(join(m001Dir, "M001-CONTEXT.md"), "# M001 Context");
      writeFileSync(join(m001Dir, "M001-ROADMAP.md"), "# M001 Roadmap");
      assert.ok(!existsSync(join(wtBase, ".gsd", "milestones")), "milestones/ missing before sync");
      const result = syncGsdStateToWorktree(mainBase, wtBase);
      assert.ok(existsSync(join(wtBase, ".gsd", "milestones")), "milestones/ created in worktree");
      assert.ok(existsSync(join(wtBase, ".gsd", "milestones", "M001")), "M001 synced to worktree");
      assert.ok(existsSync(join(wtBase, ".gsd", "milestones", "M001", "M001-CONTEXT.md")), "M001 CONTEXT synced");
      assert.ok(existsSync(join(wtBase, ".gsd", "milestones", "M001", "M001-ROADMAP.md")), "M001 ROADMAP synced");
      assert.ok(result.synced.length > 0, "sync reported files");
    } finally {
      cleanup(mainBase);
      rmSync(wtBase, { recursive: true, force: true });
    }
  }
  console.log("\n=== 8. syncWorktreeStateBack leaves task projections in worktree ===");
  {
    const mainBase = mkdtempSync(join(tmpdir(), "gsd-wt-back-main-"));
    const wtBase = mkdtempSync(join(tmpdir(), "gsd-wt-back-wt-"));
    try {
      const wtSliceDir = join(wtBase, ".gsd", "milestones", "M002", "slices", "S01");
      const wtTasksDir = join(wtSliceDir, "tasks");
      mkdirSync(wtTasksDir, { recursive: true });
      writeFileSync(join(wtSliceDir, "S01-SUMMARY.md"), "# S01 Summary");
      writeFileSync(join(wtTasksDir, "T01-SUMMARY.md"), "# T01 Summary");
      writeFileSync(join(wtTasksDir, "T02-SUMMARY.md"), "# T02 Summary");
      mkdirSync(join(mainBase, ".gsd", "milestones", "M002"), { recursive: true });
      const { synced } = syncWorktreeStateBack(mainBase, wtBase, "M001");
      const mainSliceDir = join(mainBase, ".gsd", "milestones", "M002", "slices", "S01");
      const mainTasksDir = join(mainSliceDir, "tasks");
      assert.ok(
        !existsSync(join(mainSliceDir, "S01-SUMMARY.md")),
        "slice SUMMARY projection is not copied to project root"
      );
      assert.ok(
        !existsSync(join(mainTasksDir, "T01-SUMMARY.md")),
        "task T01-SUMMARY projection is not copied to project root"
      );
      assert.ok(
        !existsSync(join(mainTasksDir, "T02-SUMMARY.md")),
        "task T02-SUMMARY projection is not copied to project root"
      );
      assert.ok(
        !synced.some((p) => p.includes("tasks/T01-SUMMARY.md")),
        "task summary does not appear in synced list"
      );
    } finally {
      rmSync(mainBase, { recursive: true, force: true });
      rmSync(wtBase, { recursive: true, force: true });
    }
  }
  console.log("\n=== 9. syncWorktreeStateBack leaves root-level state projections authoritative ===");
  {
    const mainBase = mkdtempSync(join(tmpdir(), "gsd-wt-back-root-main-"));
    const wtBase = mkdtempSync(join(tmpdir(), "gsd-wt-back-root-wt-"));
    try {
      mkdirSync(join(mainBase, ".gsd", "milestones", "M001"), { recursive: true });
      mkdirSync(join(wtBase, ".gsd", "milestones", "M001"), { recursive: true });
      writeFileSync(join(mainBase, ".gsd", "REQUIREMENTS.md"), "# Requirements\n## R001");
      writeFileSync(join(mainBase, ".gsd", "PROJECT.md"), "# Project\n## Milestone: M001");
      writeFileSync(join(wtBase, ".gsd", "REQUIREMENTS.md"), "# Requirements\n## R001\n## R002 \u2014 New req");
      writeFileSync(join(wtBase, ".gsd", "PROJECT.md"), "# Project\n## Milestone: M001\n## Milestone: M002");
      writeFileSync(join(wtBase, ".gsd", "KNOWLEDGE.md"), "# Knowledge\nLearned something.");
      const { synced } = syncWorktreeStateBack(mainBase, wtBase, "M001");
      const reqContent = readFileSync(join(mainBase, ".gsd", "REQUIREMENTS.md"), "utf-8");
      assert.ok(
        !reqContent.includes("R002"),
        "REQUIREMENTS.md ignores worktree projection content"
      );
      const projContent = readFileSync(join(mainBase, ".gsd", "PROJECT.md"), "utf-8");
      assert.ok(
        !projContent.includes("M002"),
        "PROJECT.md ignores worktree projection content"
      );
      assert.ok(
        !existsSync(join(mainBase, ".gsd", "KNOWLEDGE.md")),
        "KNOWLEDGE.md is not copied back from worktree"
      );
      assert.ok(
        !synced.includes("REQUIREMENTS.md"),
        "REQUIREMENTS.md does not appear in synced list"
      );
      assert.ok(
        !synced.includes("PROJECT.md"),
        "PROJECT.md does not appear in synced list"
      );
    } finally {
      rmSync(mainBase, { recursive: true, force: true });
      rmSync(wtBase, { recursive: true, force: true });
    }
  }
  console.log("\n=== 10. syncWorktreeStateBack does not copy milestone dirs ===");
  {
    const mainBase = mkdtempSync(join(tmpdir(), "gsd-wt-back-all-main-"));
    const wtBase = mkdtempSync(join(tmpdir(), "gsd-wt-back-all-wt-"));
    try {
      mkdirSync(join(mainBase, ".gsd", "milestones"), { recursive: true });
      mkdirSync(join(wtBase, ".gsd", "milestones"), { recursive: true });
      const wtM001Dir = join(wtBase, ".gsd", "milestones", "M001");
      mkdirSync(wtM001Dir, { recursive: true });
      writeFileSync(join(wtM001Dir, "M001-SUMMARY.md"), "# M001 Summary");
      const wtM002Dir = join(wtBase, ".gsd", "milestones", "M002-abc123");
      mkdirSync(wtM002Dir, { recursive: true });
      writeFileSync(join(wtM002Dir, "M002-abc123-CONTEXT.md"), "# M002 Context");
      writeFileSync(join(wtM002Dir, "M002-abc123-ROADMAP.md"), "# M002 Roadmap");
      assert.ok(
        !existsSync(join(mainBase, ".gsd", "milestones", "M001")),
        "M001 missing in main before sync"
      );
      assert.ok(
        !existsSync(join(mainBase, ".gsd", "milestones", "M002-abc123")),
        "M002 missing in main before sync"
      );
      const { synced } = syncWorktreeStateBack(mainBase, wtBase, "M001");
      assert.ok(
        !existsSync(join(mainBase, ".gsd", "milestones", "M001", "M001-SUMMARY.md")),
        "M001 SUMMARY NOT synced (current milestone skipped to prevent merge conflicts)"
      );
      assert.ok(
        !existsSync(join(mainBase, ".gsd", "milestones", "M002-abc123", "M002-abc123-CONTEXT.md")),
        "M002 CONTEXT projection is not copied to main"
      );
      assert.ok(
        !existsSync(join(mainBase, ".gsd", "milestones", "M002-abc123", "M002-abc123-ROADMAP.md")),
        "M002 ROADMAP projection is not copied to main"
      );
      assert.ok(
        !synced.some((p) => p.includes("M002-abc123")),
        "M002 does not appear in synced list"
      );
    } finally {
      rmSync(mainBase, { recursive: true, force: true });
      rmSync(wtBase, { recursive: true, force: true });
    }
  }
  console.log("\n=== 11. complete-milestone worktree projections do not overwrite project root ===");
  {
    const mainBase = mkdtempSync(join(tmpdir(), "gsd-wt-transition-main-"));
    const wtBase = mkdtempSync(join(tmpdir(), "gsd-wt-transition-wt-"));
    try {
      mkdirSync(join(mainBase, ".gsd", "milestones"), { recursive: true });
      mkdirSync(join(wtBase, ".gsd", "milestones"), { recursive: true });
      const mainM006 = join(mainBase, ".gsd", "milestones", "M006-589wvh");
      mkdirSync(mainM006, { recursive: true });
      writeFileSync(join(mainM006, "M006-589wvh-CONTEXT.md"), "# M006 Context");
      writeFileSync(join(mainBase, ".gsd", "REQUIREMENTS.md"), "# Requirements\n## R001 through R089");
      writeFileSync(join(mainBase, ".gsd", "PROJECT.md"), "# Project\nMilestones: M001-M006");
      const wtM006 = join(wtBase, ".gsd", "milestones", "M006-589wvh");
      mkdirSync(join(wtM006, "slices", "S01"), { recursive: true });
      writeFileSync(join(wtM006, "M006-589wvh-CONTEXT.md"), "# M006 Context");
      writeFileSync(join(wtM006, "M006-589wvh-SUMMARY.md"), "# M006 Complete");
      writeFileSync(join(wtM006, "M006-589wvh-VALIDATION.md"), "# Validated");
      writeFileSync(join(wtM006, "slices", "S01", "S01-SUMMARY.md"), "# S01 done");
      const wtM007 = join(wtBase, ".gsd", "milestones", "M007-wortc8");
      mkdirSync(wtM007, { recursive: true });
      writeFileSync(join(wtM007, "M007-wortc8-CONTEXT.md"), "# M007 Enterprise Security");
      writeFileSync(join(wtM007, "M007-wortc8-ROADMAP.md"), "# M007 Roadmap\n10 phases");
      writeFileSync(join(wtBase, ".gsd", "REQUIREMENTS.md"), "# Requirements\n## R001-R089\n## R090 \u2014 SCIM\n## R091 \u2014 WebAuthn");
      writeFileSync(join(wtBase, ".gsd", "PROJECT.md"), "# Project\nMilestones: M001-M007");
      const { synced } = syncWorktreeStateBack(mainBase, wtBase, "M006-589wvh");
      assert.ok(
        !existsSync(join(mainBase, ".gsd", "milestones", "M006-589wvh", "M006-589wvh-SUMMARY.md")),
        "M006 SUMMARY NOT synced (current milestone skipped)"
      );
      assert.ok(
        !existsSync(join(mainBase, ".gsd", "milestones", "M007-wortc8", "M007-wortc8-CONTEXT.md")),
        "M007 CONTEXT projection is not copied to main"
      );
      assert.ok(
        !existsSync(join(mainBase, ".gsd", "milestones", "M007-wortc8", "M007-wortc8-ROADMAP.md")),
        "M007 ROADMAP projection is not copied to main"
      );
      const reqContent = readFileSync(join(mainBase, ".gsd", "REQUIREMENTS.md"), "utf-8");
      assert.ok(
        !reqContent.includes("R090"),
        "REQUIREMENTS.md ignores worktree projection updates"
      );
      const projContent = readFileSync(join(mainBase, ".gsd", "PROJECT.md"), "utf-8");
      assert.ok(
        !projContent.includes("M007"),
        "PROJECT.md ignores worktree projection updates"
      );
    } finally {
      rmSync(mainBase, { recursive: true, force: true });
      rmSync(wtBase, { recursive: true, force: true });
    }
  }
  console.log("\n=== 12. root files not in worktree are not created in main ===");
  {
    const mainBase = mkdtempSync(join(tmpdir(), "gsd-wt-back-noroot-main-"));
    const wtBase = mkdtempSync(join(tmpdir(), "gsd-wt-back-noroot-wt-"));
    try {
      mkdirSync(join(mainBase, ".gsd", "milestones", "M001"), { recursive: true });
      mkdirSync(join(wtBase, ".gsd", "milestones", "M001"), { recursive: true });
      writeFileSync(join(mainBase, ".gsd", "REQUIREMENTS.md"), "# Original");
      const { synced } = syncWorktreeStateBack(mainBase, wtBase, "M001");
      const content = readFileSync(join(mainBase, ".gsd", "REQUIREMENTS.md"), "utf-8");
      assert.ok(
        content === "# Original",
        "REQUIREMENTS.md unchanged when worktree has no copy"
      );
      assert.ok(
        !synced.includes("REQUIREMENTS.md"),
        "REQUIREMENTS.md not in synced list"
      );
    } finally {
      rmSync(mainBase, { recursive: true, force: true });
      rmSync(wtBase, { recursive: true, force: true });
    }
  }
  console.log("\n=== 13. QUEUE.md skipped; completed-units.json diagnostic synced ===");
  {
    const mainBase = mkdtempSync(join(tmpdir(), "gsd-wt-back-queue-main-"));
    const wtBase = mkdtempSync(join(tmpdir(), "gsd-wt-back-queue-wt-"));
    try {
      mkdirSync(join(mainBase, ".gsd", "milestones", "M001"), { recursive: true });
      mkdirSync(join(wtBase, ".gsd", "milestones", "M001"), { recursive: true });
      writeFileSync(join(wtBase, ".gsd", "QUEUE.md"), "# Queue\n- M002 next");
      writeFileSync(
        join(wtBase, ".gsd", "completed-units.json"),
        JSON.stringify({ units: [{ id: "M001-S01-T01", completed: true }] })
      );
      assert.ok(
        !existsSync(join(mainBase, ".gsd", "QUEUE.md")),
        "QUEUE.md missing in main before sync"
      );
      assert.ok(
        !existsSync(join(mainBase, ".gsd", "completed-units.json")),
        "completed-units.json missing in main before sync"
      );
      const { synced } = syncWorktreeStateBack(mainBase, wtBase, "M001");
      assert.ok(
        !existsSync(join(mainBase, ".gsd", "QUEUE.md")),
        "QUEUE.md is not synced from worktree to main"
      );
      assert.ok(
        !synced.includes("QUEUE.md"),
        "QUEUE.md does not appear in synced list"
      );
      assert.ok(
        existsSync(join(mainBase, ".gsd", "completed-units.json")),
        "#1787: completed-units.json synced from worktree to main"
      );
      const cuContent = readFileSync(join(mainBase, ".gsd", "completed-units.json"), "utf-8");
      assert.ok(
        cuContent.includes("M001-S01-T01"),
        "#1787: completed-units.json has correct content"
      );
      assert.ok(
        synced.includes("completed-units.json"),
        "#1787: completed-units.json appears in synced list"
      );
    } finally {
      rmSync(mainBase, { recursive: true, force: true });
      rmSync(wtBase, { recursive: true, force: true });
    }
  }
  console.log("\n=== 14. syncGsdStateToWorktree syncs non-standard milestone dir names (#1547) ===");
  {
    const mainBase = createBase("main");
    const wtBase = createBase("wt");
    try {
      const customDir = join(mainBase, ".gsd", "milestones", "sprint-alpha");
      mkdirSync(customDir, { recursive: true });
      writeFileSync(join(customDir, "CONTEXT.md"), "# Sprint Alpha Context");
      const suffixDir = join(mainBase, ".gsd", "milestones", "M001-abc123");
      mkdirSync(suffixDir, { recursive: true });
      writeFileSync(join(suffixDir, "M001-abc123-CONTEXT.md"), "# M001 Context");
      assert.ok(!existsSync(join(wtBase, ".gsd", "milestones", "sprint-alpha")), "sprint-alpha missing before sync");
      assert.ok(!existsSync(join(wtBase, ".gsd", "milestones", "M001-abc123")), "M001-abc123 missing before sync");
      const result = syncGsdStateToWorktree(mainBase, wtBase);
      assert.ok(
        existsSync(join(wtBase, ".gsd", "milestones", "sprint-alpha", "CONTEXT.md")),
        '#1547: non-standard milestone dir "sprint-alpha" synced to worktree'
      );
      assert.ok(
        existsSync(join(wtBase, ".gsd", "milestones", "M001-abc123", "M001-abc123-CONTEXT.md")),
        '#1547: suffixed milestone dir "M001-abc123" synced to worktree'
      );
      assert.ok(result.synced.length > 0, "sync reported files");
    } finally {
      cleanup(mainBase);
      cleanup(wtBase);
    }
  }
  console.log("\n=== 15. syncWorktreeStateBack skips non-standard milestone dir names ===");
  {
    const mainBase = mkdtempSync(join(tmpdir(), "gsd-wt-back-custom-main-"));
    const wtBase = mkdtempSync(join(tmpdir(), "gsd-wt-back-custom-wt-"));
    try {
      mkdirSync(join(mainBase, ".gsd", "milestones"), { recursive: true });
      mkdirSync(join(wtBase, ".gsd", "milestones"), { recursive: true });
      const wtCustomDir = join(wtBase, ".gsd", "milestones", "sprint-beta");
      mkdirSync(wtCustomDir, { recursive: true });
      writeFileSync(join(wtCustomDir, "SUMMARY.md"), "# Sprint Beta Summary");
      assert.ok(
        !existsSync(join(mainBase, ".gsd", "milestones", "sprint-beta")),
        "sprint-beta missing in main before sync"
      );
      const { synced } = syncWorktreeStateBack(mainBase, wtBase, "M001");
      assert.ok(
        !existsSync(join(mainBase, ".gsd", "milestones", "sprint-beta", "SUMMARY.md")),
        "non-standard milestone projection is not copied back to main"
      );
      assert.ok(
        !synced.some((p) => p.includes("sprint-beta")),
        "sprint-beta does not appear in synced list"
      );
    } finally {
      rmSync(mainBase, { recursive: true, force: true });
      rmSync(wtBase, { recursive: true, force: true });
    }
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy93b3JrdHJlZS1zeW5jLW1pbGVzdG9uZXMudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiB3b3JrdHJlZS1zeW5jLW1pbGVzdG9uZXMudGVzdC50cyBcdTIwMTQgUmVncmVzc2lvbiB0ZXN0cyBmb3IgIzEzMTEgYW5kICMxNjc4LlxuICpcbiAqIFZlcmlmaWVzIHRoYXQgc3luY1Byb2plY3RSb290VG9Xb3JrdHJlZSBjb3BpZXMgbWlsZXN0b25lIGFydGlmYWN0c1xuICogZnJvbSB0aGUgbWFpbiByZXBvJ3MgLmdzZC8gaW50byB0aGUgd29ya3RyZWUncyAuZ3NkLyBmb3IgdGhlXG4gKiBzcGVjaWZpZWQgbWlsZXN0b25lLCBhbmQgZGVsZXRlcyBnc2QuZGIgc28gaXQgcmVidWlsZHMgZnJvbSBmcmVzaCBzdGF0ZS5cbiAqXG4gKiBBbHNvIHZlcmlmaWVzIHRoYXQgc3luY1dvcmt0cmVlU3RhdGVCYWNrIGRvZXMgbm90IGltcG9ydCB3b3JrdHJlZSBtYXJrZG93blxuICogcHJvamVjdGlvbnMgYmFjayBpbnRvIHRoZSBwcm9qZWN0IHJvb3QuXG4gKlxuICogQ292ZXJzOlxuICogICAtIE1pbGVzdG9uZSBkaXJlY3Rvcnkgc3luY2VkIGZyb20gbWFpbiB0byB3b3JrdHJlZVxuICogICAtIE1pc3Npbmcgc2xpY2VzIHdpdGhpbiBhIG1pbGVzdG9uZSBhcmUgc3luY2VkXG4gKiAgIC0gZ3NkLmRiIGRlbGV0ZWQgaW4gd29ya3RyZWUgYWZ0ZXIgc3luY1xuICogICAtIE5vLW9wIHdoZW4gcGF0aHMgYXJlIGVxdWFsXG4gKiAgIC0gTm8tb3Agd2hlbiBtaWxlc3RvbmVJZCBpcyBudWxsXG4gKiAgIC0gTm9uLWV4aXN0ZW50IGRpcmVjdG9yaWVzIGhhbmRsZWQgZ3JhY2VmdWxseVxuICogICAtIHN5bmNXb3JrdHJlZVN0YXRlQmFjayBza2lwcyBtaWxlc3RvbmUgbWFya2Rvd24gcHJvamVjdGlvbnNcbiAqICAgLSBzeW5jV29ya3RyZWVTdGF0ZUJhY2sgZG9lcyBub3QgaW1wb3J0IHJvb3QtbGV2ZWwgLmdzZC8gc3RhdGUgcHJvamVjdGlvbnNcbiAqICAgLSBzeW5jV29ya3RyZWVTdGF0ZUJhY2sgZG9lcyBub3QgY29weSB3b3JrdHJlZSBtaWxlc3RvbmUgcHJvamVjdGlvbnMgYmFja1xuICogICAtIHN5bmNXb3JrdHJlZVN0YXRlQmFjayBsZWF2ZXMgbmV4dC1taWxlc3RvbmUgcHJvamVjdGlvbnMgREIvcHJvamVjdC1yb290IGF1dGhvcml0YXRpdmVcbiAqICAgLSBzeW5jR3NkU3RhdGVUb1dvcmt0cmVlIHN5bmNzIG5vbi1zdGFuZGFyZCBtaWxlc3RvbmUgZGlyIG5hbWVzICgjMTU0NylcbiAqICAgLSBzeW5jV29ya3RyZWVTdGF0ZUJhY2sgc2tpcHMgbm9uLXN0YW5kYXJkIG1pbGVzdG9uZSBwcm9qZWN0aW9uIGRpciBuYW1lc1xuICovXG5cbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBta2RpclN5bmMsIHdyaXRlRmlsZVN5bmMsIHJtU3luYywgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jIH0gZnJvbSAnbm9kZTpmcyc7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJztcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gJ25vZGU6b3MnO1xuXG5pbXBvcnQgeyBzeW5jUHJvamVjdFJvb3RUb1dvcmt0cmVlIH0gZnJvbSAnLi4vYXV0by13b3JrdHJlZS50cyc7XG5pbXBvcnQgeyBzeW5jR3NkU3RhdGVUb1dvcmt0cmVlLCBzeW5jV29ya3RyZWVTdGF0ZUJhY2sgfSBmcm9tICcuLi9hdXRvLXdvcmt0cmVlLnRzJztcbmltcG9ydCB7IGRlc2NyaWJlLCB0ZXN0IH0gZnJvbSAnbm9kZTp0ZXN0JztcbmltcG9ydCBhc3NlcnQgZnJvbSAnbm9kZTphc3NlcnQvc3RyaWN0JztcblxuXG5mdW5jdGlvbiBjcmVhdGVCYXNlKG5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBgZ3NkLXd0LXN5bmMtJHtuYW1lfS1gKSk7XG4gIG1rZGlyU3luYyhqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHJldHVybiBiYXNlO1xufVxuXG5mdW5jdGlvbiBjbGVhbnVwKGJhc2U6IHN0cmluZyk6IHZvaWQge1xuICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xufVxuXG5kZXNjcmliZSgnd29ya3RyZWUtc3luYy1taWxlc3RvbmVzJywgYXN5bmMgKCkgPT4ge1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCAxLiBNaWxlc3RvbmUgZGlyZWN0b3J5IHN5bmNlZCBmcm9tIG1haW4gdG8gd29ya3RyZWUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGNvbnNvbGUubG9nKCdcXG49PT0gMS4gbWlsZXN0b25lIGRpcmVjdG9yeSBzeW5jZWQgZnJvbSBtYWluIHRvIHdvcmt0cmVlID09PScpO1xuICB7XG4gICAgY29uc3QgbWFpbkJhc2UgPSBjcmVhdGVCYXNlKCdtYWluJyk7XG4gICAgY29uc3Qgd3RCYXNlID0gY3JlYXRlQmFzZSgnd3QnKTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCBtMDAxRGlyID0gam9pbihtYWluQmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJyk7XG4gICAgICBta2RpclN5bmMobTAwMURpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4obTAwMURpciwgJ00wMDEtQ09OVEVYVC5tZCcpLCAnIyBNMDAxXFxuQ29udGV4dC4nKTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihtMDAxRGlyLCAnTTAwMS1ST0FETUFQLm1kJyksICcjIFJvYWRtYXAnKTtcblxuICAgICAgLy8gV29ya3RyZWUgaGFzIG5vIE0wMDFcbiAgICAgIGFzc2VydC5vayghZXhpc3RzU3luYyhqb2luKHd0QmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJykpLCAnTTAwMSBtaXNzaW5nIGJlZm9yZSBzeW5jJyk7XG5cbiAgICAgIHN5bmNQcm9qZWN0Um9vdFRvV29ya3RyZWUobWFpbkJhc2UsIHd0QmFzZSwgJ00wMDEnKTtcblxuICAgICAgYXNzZXJ0Lm9rKGV4aXN0c1N5bmMoam9pbih3dEJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScpKSwgJyMxMzExOiBNMDAxIHN5bmNlZCB0byB3b3JrdHJlZScpO1xuICAgICAgYXNzZXJ0Lm9rKGV4aXN0c1N5bmMoam9pbih3dEJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScsICdNMDAxLUNPTlRFWFQubWQnKSksICdNMDAxIENPTlRFWFQgc3luY2VkJyk7XG4gICAgICBhc3NlcnQub2soZXhpc3RzU3luYyhqb2luKHd0QmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJywgJ00wMDEtUk9BRE1BUC5tZCcpKSwgJ00wMDEgUk9BRE1BUCBzeW5jZWQnKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChtYWluQmFzZSk7XG4gICAgICBjbGVhbnVwKHd0QmFzZSk7XG4gICAgfVxuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIDIuIE1pc3Npbmcgc2xpY2VzIHN5bmNlZCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgY29uc29sZS5sb2coJ1xcbj09PSAyLiBtaXNzaW5nIHNsaWNlcyB3aXRoaW4gbWlsZXN0b25lIGFyZSBzeW5jZWQgPT09Jyk7XG4gIHtcbiAgICBjb25zdCBtYWluQmFzZSA9IGNyZWF0ZUJhc2UoJ21haW4nKTtcbiAgICBjb25zdCB3dEJhc2UgPSBjcmVhdGVCYXNlKCd3dCcpO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IG0wMDFEaXIgPSBqb2luKG1haW5CYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgJ00wMDEnKTtcbiAgICAgIG1rZGlyU3luYyhqb2luKG0wMDFEaXIsICdzbGljZXMnLCAnUzAxJyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgbWtkaXJTeW5jKGpvaW4obTAwMURpciwgJ3NsaWNlcycsICdTMDInKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4obTAwMURpciwgJ00wMDEtUk9BRE1BUC5tZCcpLCAnIyBSb2FkbWFwJyk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4obTAwMURpciwgJ3NsaWNlcycsICdTMDEnLCAnUzAxLVBMQU4ubWQnKSwgJyMgUzAxIFBsYW4nKTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihtMDAxRGlyLCAnc2xpY2VzJywgJ1MwMicsICdTMDItUExBTi5tZCcpLCAnIyBTMDIgUGxhbicpO1xuXG4gICAgICAvLyBXb3JrdHJlZSBvbmx5IGhhcyBTMDFcbiAgICAgIGNvbnN0IHd0TTAwMURpciA9IGpvaW4od3RCYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgJ00wMDEnKTtcbiAgICAgIG1rZGlyU3luYyhqb2luKHd0TTAwMURpciwgJ3NsaWNlcycsICdTMDEnKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4od3RNMDAxRGlyLCAnc2xpY2VzJywgJ1MwMScsICdTMDEtUExBTi5tZCcpLCAnIyBTMDEgUGxhbicpO1xuXG4gICAgICBzeW5jUHJvamVjdFJvb3RUb1dvcmt0cmVlKG1haW5CYXNlLCB3dEJhc2UsICdNMDAxJyk7XG5cbiAgICAgIGFzc2VydC5vayhleGlzdHNTeW5jKGpvaW4od3RCYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgJ00wMDEnLCAnc2xpY2VzJywgJ1MwMicpKSwgJyMxMzExOiBTMDIgc3luY2VkJyk7XG4gICAgICBhc3NlcnQub2soZXhpc3RzU3luYyhqb2luKHd0QmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJywgJ3NsaWNlcycsICdTMDInLCAnUzAyLVBMQU4ubWQnKSksICdTMDIgUExBTiBzeW5jZWQnKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChtYWluQmFzZSk7XG4gICAgICBjbGVhbnVwKHd0QmFzZSk7XG4gICAgfVxuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIDMuIGVtcHR5IGdzZC5kYiBkZWxldGVkIGluIHdvcmt0cmVlIGFmdGVyIHN5bmMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGNvbnNvbGUubG9nKCdcXG49PT0gMy4gZW1wdHkgZ3NkLmRiIGRlbGV0ZWQgaW4gd29ya3RyZWUgYWZ0ZXIgc3luYyA9PT0nKTtcbiAge1xuICAgIGNvbnN0IG1haW5CYXNlID0gY3JlYXRlQmFzZSgnbWFpbicpO1xuICAgIGNvbnN0IHd0QmFzZSA9IGNyZWF0ZUJhc2UoJ3d0Jyk7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgbTAwMURpciA9IGpvaW4obWFpbkJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScpO1xuICAgICAgbWtkaXJTeW5jKG0wMDFEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKG0wMDFEaXIsICdNMDAxLVJPQURNQVAubWQnKSwgJyMgUm9hZG1hcCcpO1xuXG4gICAgICAvLyBXb3JrdHJlZSBoYXMgYW4gZW1wdHkgKDAtYnl0ZSkgZ3NkLmRiIFx1MjAxNCBzdGFsZS9jb3JydXB0XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4od3RCYXNlLCAnLmdzZCcsICdnc2QuZGInKSwgJycpO1xuICAgICAgYXNzZXJ0Lm9rKGV4aXN0c1N5bmMoam9pbih3dEJhc2UsICcuZ3NkJywgJ2dzZC5kYicpKSwgJ2dzZC5kYiBleGlzdHMgYmVmb3JlIHN5bmMnKTtcblxuICAgICAgc3luY1Byb2plY3RSb290VG9Xb3JrdHJlZShtYWluQmFzZSwgd3RCYXNlLCAnTTAwMScpO1xuXG4gICAgICBhc3NlcnQub2soIWV4aXN0c1N5bmMoam9pbih3dEJhc2UsICcuZ3NkJywgJ2dzZC5kYicpKSwgJyM4NTM6IGVtcHR5IGdzZC5kYiBkZWxldGVkIGFmdGVyIHN5bmMnKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChtYWluQmFzZSk7XG4gICAgICBjbGVhbnVwKHd0QmFzZSk7XG4gICAgfVxuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIDNiLiBub24tZW1wdHkgZ3NkLmRiIHByZXNlcnZlZCBpbiB3b3JrdHJlZSBhZnRlciBzeW5jICgjMjgxNSkgXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGNvbnNvbGUubG9nKCdcXG49PT0gM2IuIG5vbi1lbXB0eSBnc2QuZGIgcHJlc2VydmVkIGluIHdvcmt0cmVlIGFmdGVyIHN5bmMgKCMyODE1KSA9PT0nKTtcbiAge1xuICAgIGNvbnN0IG1haW5CYXNlID0gY3JlYXRlQmFzZSgnbWFpbicpO1xuICAgIGNvbnN0IHd0QmFzZSA9IGNyZWF0ZUJhc2UoJ3d0Jyk7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgbTAwMURpciA9IGpvaW4obWFpbkJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScpO1xuICAgICAgbWtkaXJTeW5jKG0wMDFEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKG0wMDFEaXIsICdNMDAxLVJPQURNQVAubWQnKSwgJyMgUm9hZG1hcCcpO1xuXG4gICAgICAvLyBXb3JrdHJlZSBoYXMgYSBwb3B1bGF0ZWQgZ3NkLmRiIChlLmcuIGZyb20gZ3NkLW1pZ3JhdGUgb24gcmVzcGF3bilcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbih3dEJhc2UsICcuZ3NkJywgJ2dzZC5kYicpLCAnbWlncmF0ZWQtZGItY29udGVudCcpO1xuICAgICAgYXNzZXJ0Lm9rKGV4aXN0c1N5bmMoam9pbih3dEJhc2UsICcuZ3NkJywgJ2dzZC5kYicpKSwgJ2dzZC5kYiBleGlzdHMgYmVmb3JlIHN5bmMnKTtcblxuICAgICAgc3luY1Byb2plY3RSb290VG9Xb3JrdHJlZShtYWluQmFzZSwgd3RCYXNlLCAnTTAwMScpO1xuXG4gICAgICBhc3NlcnQub2soZXhpc3RzU3luYyhqb2luKHd0QmFzZSwgJy5nc2QnLCAnZ3NkLmRiJykpLCAnIzI4MTU6IG5vbi1lbXB0eSBnc2QuZGIgcHJlc2VydmVkIGFmdGVyIHN5bmMnKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChtYWluQmFzZSk7XG4gICAgICBjbGVhbnVwKHd0QmFzZSk7XG4gICAgfVxuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIDQuIE5vLW9wIHdoZW4gcGF0aHMgYXJlIGVxdWFsIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBjb25zb2xlLmxvZygnXFxuPT09IDQuIG5vLW9wIHdoZW4gcGF0aHMgYXJlIGVxdWFsID09PScpO1xuICB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUJhc2UoJ3NhbWUnKTtcbiAgICB0cnkge1xuICAgICAgLy8gU2hvdWxkIG5vdCB0aHJvd1xuICAgICAgc3luY1Byb2plY3RSb290VG9Xb3JrdHJlZShiYXNlLCBiYXNlLCAnTTAwMScpO1xuICAgICAgYXNzZXJ0Lm9rKHRydWUsICdubyBjcmFzaCB3aGVuIHBhdGhzIGFyZSBlcXVhbCcpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCA1LiBOby1vcCB3aGVuIG1pbGVzdG9uZUlkIGlzIG51bGwgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGNvbnNvbGUubG9nKCdcXG49PT0gNS4gbm8tb3Agd2hlbiBtaWxlc3RvbmVJZCBpcyBudWxsID09PScpO1xuICB7XG4gICAgY29uc3QgbWFpbkJhc2UgPSBjcmVhdGVCYXNlKCdtYWluJyk7XG4gICAgY29uc3Qgd3RCYXNlID0gY3JlYXRlQmFzZSgnd3QnKTtcbiAgICB0cnkge1xuICAgICAgc3luY1Byb2plY3RSb290VG9Xb3JrdHJlZShtYWluQmFzZSwgd3RCYXNlLCBudWxsKTtcbiAgICAgIGFzc2VydC5vayh0cnVlLCAnbm8gY3Jhc2ggd2hlbiBtaWxlc3RvbmVJZCBpcyBudWxsJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAobWFpbkJhc2UpO1xuICAgICAgY2xlYW51cCh3dEJhc2UpO1xuICAgIH1cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCA2LiBOb24tZXhpc3RlbnQgZGlyZWN0b3JpZXMgaGFuZGxlZCBncmFjZWZ1bGx5IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBjb25zb2xlLmxvZygnXFxuPT09IDYuIG5vbi1leGlzdGVudCBkaXJlY3RvcmllcyBcdTIxOTIgbm8tb3AgPT09Jyk7XG4gIHtcbiAgICBzeW5jUHJvamVjdFJvb3RUb1dvcmt0cmVlKCcvdG1wL2RvZXMtbm90LWV4aXN0LW1haW4nLCAnL3RtcC9kb2VzLW5vdC1leGlzdC13dCcsICdNMDAxJyk7XG4gICAgYXNzZXJ0Lm9rKHRydWUsICdubyBjcmFzaCBvbiBtaXNzaW5nIGRpcmVjdG9yaWVzJyk7XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgNy4gbWlsZXN0b25lcy8gZGlyZWN0b3J5IGNyZWF0ZWQgaW4gd29ya3RyZWUgd2hlbiBtaXNzaW5nIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBjb25zb2xlLmxvZygnXFxuPT09IDcuIG1pbGVzdG9uZXMvIGRpcmVjdG9yeSBjcmVhdGVkIGluIHdvcmt0cmVlIHdoZW4gbWlzc2luZyA9PT0nKTtcbiAge1xuICAgIGNvbnN0IG1haW5CYXNlID0gY3JlYXRlQmFzZSgnbWFpbicpO1xuICAgIGNvbnN0IHd0QmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksICdnc2Qtd3Qtc3luYy13dC0nKSk7XG5cbiAgICB0cnkge1xuICAgICAgLy8gV29ya3RyZWUgaGFzIC5nc2QvIGJ1dCBOTyBtaWxlc3RvbmVzLyBzdWJkaXJlY3RvcnlcbiAgICAgIG1rZGlyU3luYyhqb2luKHd0QmFzZSwgJy5nc2QnKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgICAgIC8vIE1haW4gcmVwbyBoYXMgTTAwMVxuICAgICAgY29uc3QgbTAwMURpciA9IGpvaW4obWFpbkJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScpO1xuICAgICAgbWtkaXJTeW5jKG0wMDFEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKG0wMDFEaXIsICdNMDAxLUNPTlRFWFQubWQnKSwgJyMgTTAwMSBDb250ZXh0Jyk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4obTAwMURpciwgJ00wMDEtUk9BRE1BUC5tZCcpLCAnIyBNMDAxIFJvYWRtYXAnKTtcblxuICAgICAgYXNzZXJ0Lm9rKCFleGlzdHNTeW5jKGpvaW4od3RCYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJykpLCAnbWlsZXN0b25lcy8gbWlzc2luZyBiZWZvcmUgc3luYycpO1xuXG4gICAgICBjb25zdCByZXN1bHQgPSBzeW5jR3NkU3RhdGVUb1dvcmt0cmVlKG1haW5CYXNlLCB3dEJhc2UpO1xuXG4gICAgICBhc3NlcnQub2soZXhpc3RzU3luYyhqb2luKHd0QmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycpKSwgJ21pbGVzdG9uZXMvIGNyZWF0ZWQgaW4gd29ya3RyZWUnKTtcbiAgICAgIGFzc2VydC5vayhleGlzdHNTeW5jKGpvaW4od3RCYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgJ00wMDEnKSksICdNMDAxIHN5bmNlZCB0byB3b3JrdHJlZScpO1xuICAgICAgYXNzZXJ0Lm9rKGV4aXN0c1N5bmMoam9pbih3dEJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScsICdNMDAxLUNPTlRFWFQubWQnKSksICdNMDAxIENPTlRFWFQgc3luY2VkJyk7XG4gICAgICBhc3NlcnQub2soZXhpc3RzU3luYyhqb2luKHd0QmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJywgJ00wMDEtUk9BRE1BUC5tZCcpKSwgJ00wMDEgUk9BRE1BUCBzeW5jZWQnKTtcbiAgICAgIGFzc2VydC5vayhyZXN1bHQuc3luY2VkLmxlbmd0aCA+IDAsICdzeW5jIHJlcG9ydGVkIGZpbGVzJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAobWFpbkJhc2UpO1xuICAgICAgcm1TeW5jKHd0QmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCA4LiBzeW5jV29ya3RyZWVTdGF0ZUJhY2sgZG9lcyBub3QgY29weSB0YXNrIHByb2plY3Rpb25zIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBjb25zb2xlLmxvZygnXFxuPT09IDguIHN5bmNXb3JrdHJlZVN0YXRlQmFjayBsZWF2ZXMgdGFzayBwcm9qZWN0aW9ucyBpbiB3b3JrdHJlZSA9PT0nKTtcbiAge1xuICAgIGNvbnN0IG1haW5CYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgJ2dzZC13dC1iYWNrLW1haW4tJykpO1xuICAgIGNvbnN0IHd0QmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksICdnc2Qtd3QtYmFjay13dC0nKSk7XG5cbiAgICB0cnkge1xuICAgICAgLy8gQnVpbGQgd29ya3RyZWUgbWlsZXN0b25lIHN0cnVjdHVyZSB3aXRoIHNsaWNlLWxldmVsIGFuZCB0YXNrLWxldmVsIGZpbGVzXG4gICAgICAvLyBVc2UgTTAwMiBhcyB0aGUgbWlsZXN0b25lIHRvIHN5bmMsIE0wMDEgYXMgdGhlIFwiY3VycmVudFwiIGJlaW5nIG1lcmdlZCAoc2tpcHBlZClcbiAgICAgIGNvbnN0IHd0U2xpY2VEaXIgPSBqb2luKHd0QmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAyJywgJ3NsaWNlcycsICdTMDEnKTtcbiAgICAgIGNvbnN0IHd0VGFza3NEaXIgPSBqb2luKHd0U2xpY2VEaXIsICd0YXNrcycpO1xuICAgICAgbWtkaXJTeW5jKHd0VGFza3NEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHd0U2xpY2VEaXIsICdTMDEtU1VNTUFSWS5tZCcpLCAnIyBTMDEgU3VtbWFyeScpO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHd0VGFza3NEaXIsICdUMDEtU1VNTUFSWS5tZCcpLCAnIyBUMDEgU3VtbWFyeScpO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHd0VGFza3NEaXIsICdUMDItU1VNTUFSWS5tZCcpLCAnIyBUMDIgU3VtbWFyeScpO1xuXG4gICAgICAvLyBNYWluIHByb2plY3Qgcm9vdCBzdGFydHMgd2l0aCBvbmx5IHRoZSBtaWxlc3RvbmUgZGlyZWN0b3J5IChubyBzbGljZXMgeWV0KVxuICAgICAgbWtkaXJTeW5jKGpvaW4obWFpbkJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMicpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAgICAgY29uc3QgeyBzeW5jZWQgfSA9IHN5bmNXb3JrdHJlZVN0YXRlQmFjayhtYWluQmFzZSwgd3RCYXNlLCAnTTAwMScpO1xuXG4gICAgICBjb25zdCBtYWluU2xpY2VEaXIgPSBqb2luKG1haW5CYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgJ00wMDInLCAnc2xpY2VzJywgJ1MwMScpO1xuICAgICAgY29uc3QgbWFpblRhc2tzRGlyID0gam9pbihtYWluU2xpY2VEaXIsICd0YXNrcycpO1xuXG4gICAgICBhc3NlcnQub2soXG4gICAgICAgICFleGlzdHNTeW5jKGpvaW4obWFpblNsaWNlRGlyLCAnUzAxLVNVTU1BUlkubWQnKSksXG4gICAgICAgICdzbGljZSBTVU1NQVJZIHByb2plY3Rpb24gaXMgbm90IGNvcGllZCB0byBwcm9qZWN0IHJvb3QnLFxuICAgICAgKTtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgIWV4aXN0c1N5bmMoam9pbihtYWluVGFza3NEaXIsICdUMDEtU1VNTUFSWS5tZCcpKSxcbiAgICAgICAgJ3Rhc2sgVDAxLVNVTU1BUlkgcHJvamVjdGlvbiBpcyBub3QgY29waWVkIHRvIHByb2plY3Qgcm9vdCcsXG4gICAgICApO1xuICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICAhZXhpc3RzU3luYyhqb2luKG1haW5UYXNrc0RpciwgJ1QwMi1TVU1NQVJZLm1kJykpLFxuICAgICAgICAndGFzayBUMDItU1VNTUFSWSBwcm9qZWN0aW9uIGlzIG5vdCBjb3BpZWQgdG8gcHJvamVjdCByb290JyxcbiAgICAgICk7XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgICFzeW5jZWQuc29tZSgocCkgPT4gcC5pbmNsdWRlcygndGFza3MvVDAxLVNVTU1BUlkubWQnKSksXG4gICAgICAgICd0YXNrIHN1bW1hcnkgZG9lcyBub3QgYXBwZWFyIGluIHN5bmNlZCBsaXN0JyxcbiAgICAgICk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyhtYWluQmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgICAgcm1TeW5jKHd0QmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCA5LiBzeW5jV29ya3RyZWVTdGF0ZUJhY2sgZG9lcyBub3QgaW1wb3J0IHJvb3QtbGV2ZWwgc3RhdGUgcHJvamVjdGlvbnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGNvbnNvbGUubG9nKCdcXG49PT0gOS4gc3luY1dvcmt0cmVlU3RhdGVCYWNrIGxlYXZlcyByb290LWxldmVsIHN0YXRlIHByb2plY3Rpb25zIGF1dGhvcml0YXRpdmUgPT09Jyk7XG4gIHtcbiAgICBjb25zdCBtYWluQmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksICdnc2Qtd3QtYmFjay1yb290LW1haW4tJykpO1xuICAgIGNvbnN0IHd0QmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksICdnc2Qtd3QtYmFjay1yb290LXd0LScpKTtcblxuICAgIHRyeSB7XG4gICAgICBta2RpclN5bmMoam9pbihtYWluQmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgbWtkaXJTeW5jKGpvaW4od3RCYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgJ00wMDEnKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgICAgIC8vIE1haW4gaGFzIG9yaWdpbmFsIFJFUVVJUkVNRU5UUyBhbmQgUFJPSkVDVFxuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKG1haW5CYXNlLCAnLmdzZCcsICdSRVFVSVJFTUVOVFMubWQnKSwgJyMgUmVxdWlyZW1lbnRzXFxuIyMgUjAwMScpO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKG1haW5CYXNlLCAnLmdzZCcsICdQUk9KRUNULm1kJyksICcjIFByb2plY3RcXG4jIyBNaWxlc3RvbmU6IE0wMDEnKTtcblxuICAgICAgLy8gV29ya3RyZWUgaGFzIHVwZGF0ZWQgdmVyc2lvbnMgKGNvbXBsZXRlLW1pbGVzdG9uZSBhZGRlZCBNMDAyIHJlZnMpXG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4od3RCYXNlLCAnLmdzZCcsICdSRVFVSVJFTUVOVFMubWQnKSwgJyMgUmVxdWlyZW1lbnRzXFxuIyMgUjAwMVxcbiMjIFIwMDIgXHUyMDE0IE5ldyByZXEnKTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbih3dEJhc2UsICcuZ3NkJywgJ1BST0pFQ1QubWQnKSwgJyMgUHJvamVjdFxcbiMjIE1pbGVzdG9uZTogTTAwMVxcbiMjIE1pbGVzdG9uZTogTTAwMicpO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHd0QmFzZSwgJy5nc2QnLCAnS05PV0xFREdFLm1kJyksICcjIEtub3dsZWRnZVxcbkxlYXJuZWQgc29tZXRoaW5nLicpO1xuXG4gICAgICBjb25zdCB7IHN5bmNlZCB9ID0gc3luY1dvcmt0cmVlU3RhdGVCYWNrKG1haW5CYXNlLCB3dEJhc2UsICdNMDAxJyk7XG5cbiAgICAgIC8vIFJvb3QtbGV2ZWwgc3RhdGUgcHJvamVjdGlvbnMgbXVzdCBub3QgYmUgb3ZlcndyaXR0ZW4gd2l0aCB3b3JrdHJlZSB2ZXJzaW9ucy5cbiAgICAgIGNvbnN0IHJlcUNvbnRlbnQgPSByZWFkRmlsZVN5bmMoam9pbihtYWluQmFzZSwgJy5nc2QnLCAnUkVRVUlSRU1FTlRTLm1kJyksICd1dGYtOCcpO1xuICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICAhcmVxQ29udGVudC5pbmNsdWRlcygnUjAwMicpLFxuICAgICAgICAnUkVRVUlSRU1FTlRTLm1kIGlnbm9yZXMgd29ya3RyZWUgcHJvamVjdGlvbiBjb250ZW50JyxcbiAgICAgICk7XG5cbiAgICAgIGNvbnN0IHByb2pDb250ZW50ID0gcmVhZEZpbGVTeW5jKGpvaW4obWFpbkJhc2UsICcuZ3NkJywgJ1BST0pFQ1QubWQnKSwgJ3V0Zi04Jyk7XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgICFwcm9qQ29udGVudC5pbmNsdWRlcygnTTAwMicpLFxuICAgICAgICAnUFJPSkVDVC5tZCBpZ25vcmVzIHdvcmt0cmVlIHByb2plY3Rpb24gY29udGVudCcsXG4gICAgICApO1xuXG4gICAgICBhc3NlcnQub2soXG4gICAgICAgICFleGlzdHNTeW5jKGpvaW4obWFpbkJhc2UsICcuZ3NkJywgJ0tOT1dMRURHRS5tZCcpKSxcbiAgICAgICAgJ0tOT1dMRURHRS5tZCBpcyBub3QgY29waWVkIGJhY2sgZnJvbSB3b3JrdHJlZScsXG4gICAgICApO1xuXG4gICAgICBhc3NlcnQub2soXG4gICAgICAgICFzeW5jZWQuaW5jbHVkZXMoJ1JFUVVJUkVNRU5UUy5tZCcpLFxuICAgICAgICAnUkVRVUlSRU1FTlRTLm1kIGRvZXMgbm90IGFwcGVhciBpbiBzeW5jZWQgbGlzdCcsXG4gICAgICApO1xuICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICAhc3luY2VkLmluY2x1ZGVzKCdQUk9KRUNULm1kJyksXG4gICAgICAgICdQUk9KRUNULm1kIGRvZXMgbm90IGFwcGVhciBpbiBzeW5jZWQgbGlzdCcsXG4gICAgICApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmMobWFpbkJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICAgIHJtU3luYyh3dEJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgMTAuIHN5bmNXb3JrdHJlZVN0YXRlQmFjayBkb2VzIG5vdCBjb3B5IG1pbGVzdG9uZSBkaXJlY3RvcmllcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgY29uc29sZS5sb2coJ1xcbj09PSAxMC4gc3luY1dvcmt0cmVlU3RhdGVCYWNrIGRvZXMgbm90IGNvcHkgbWlsZXN0b25lIGRpcnMgPT09Jyk7XG4gIHtcbiAgICBjb25zdCBtYWluQmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksICdnc2Qtd3QtYmFjay1hbGwtbWFpbi0nKSk7XG4gICAgY29uc3Qgd3RCYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgJ2dzZC13dC1iYWNrLWFsbC13dC0nKSk7XG5cbiAgICB0cnkge1xuICAgICAgbWtkaXJTeW5jKGpvaW4obWFpbkJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICBta2RpclN5bmMoam9pbih3dEJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgICAgIC8vIFdvcmt0cmVlIGhhcyBNMDAxIChjdXJyZW50KSBBTkQgTTAwMiAobmV4dCwgY3JlYXRlZCBieSBjb21wbGV0ZS1taWxlc3RvbmUpXG4gICAgICBjb25zdCB3dE0wMDFEaXIgPSBqb2luKHd0QmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJyk7XG4gICAgICBta2RpclN5bmMod3RNMDAxRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbih3dE0wMDFEaXIsICdNMDAxLVNVTU1BUlkubWQnKSwgJyMgTTAwMSBTdW1tYXJ5Jyk7XG5cbiAgICAgIGNvbnN0IHd0TTAwMkRpciA9IGpvaW4od3RCYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgJ00wMDItYWJjMTIzJyk7XG4gICAgICBta2RpclN5bmMod3RNMDAyRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbih3dE0wMDJEaXIsICdNMDAyLWFiYzEyMy1DT05URVhULm1kJyksICcjIE0wMDIgQ29udGV4dCcpO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHd0TTAwMkRpciwgJ00wMDItYWJjMTIzLVJPQURNQVAubWQnKSwgJyMgTTAwMiBSb2FkbWFwJyk7XG5cbiAgICAgIC8vIE1haW4gaGFzIG5laXRoZXJcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgIWV4aXN0c1N5bmMoam9pbihtYWluQmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJykpLFxuICAgICAgICAnTTAwMSBtaXNzaW5nIGluIG1haW4gYmVmb3JlIHN5bmMnLFxuICAgICAgKTtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgIWV4aXN0c1N5bmMoam9pbihtYWluQmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAyLWFiYzEyMycpKSxcbiAgICAgICAgJ00wMDIgbWlzc2luZyBpbiBtYWluIGJlZm9yZSBzeW5jJyxcbiAgICAgICk7XG5cbiAgICAgIC8vIFN5bmMgd2l0aCBtaWxlc3RvbmVJZCA9IE0wMDEgKHRoZSBjdXJyZW50IG1pbGVzdG9uZSBiZWluZyBtZXJnZWQgXHUyMDE0IHNraXBwZWQpXG4gICAgICBjb25zdCB7IHN5bmNlZCB9ID0gc3luY1dvcmt0cmVlU3RhdGVCYWNrKG1haW5CYXNlLCB3dEJhc2UsICdNMDAxJyk7XG5cbiAgICAgIC8vIE0wMDEgc2hvdWxkIGJlIFNLSVBQRUQgKGN1cnJlbnQgbWlsZXN0b25lIGJlaW5nIG1lcmdlZCBcdTIwMTQgIzM2NDEpXG4gICAgICBhc3NlcnQub2soXG4gICAgICAgICFleGlzdHNTeW5jKGpvaW4obWFpbkJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScsICdNMDAxLVNVTU1BUlkubWQnKSksXG4gICAgICAgICdNMDAxIFNVTU1BUlkgTk9UIHN5bmNlZCAoY3VycmVudCBtaWxlc3RvbmUgc2tpcHBlZCB0byBwcmV2ZW50IG1lcmdlIGNvbmZsaWN0cyknLFxuICAgICAgKTtcblxuICAgICAgLy8gTTAwMiBzaG91bGQgbm90IGJlIHN5bmNlZCBlaXRoZXI7IHdvcmt0cmVlIHByb2plY3Rpb25zIGFyZSBub3QgYXV0aG9yaXRhdGl2ZS5cbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgIWV4aXN0c1N5bmMoam9pbihtYWluQmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAyLWFiYzEyMycsICdNMDAyLWFiYzEyMy1DT05URVhULm1kJykpLFxuICAgICAgICAnTTAwMiBDT05URVhUIHByb2plY3Rpb24gaXMgbm90IGNvcGllZCB0byBtYWluJyxcbiAgICAgICk7XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgICFleGlzdHNTeW5jKGpvaW4obWFpbkJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMi1hYmMxMjMnLCAnTTAwMi1hYmMxMjMtUk9BRE1BUC5tZCcpKSxcbiAgICAgICAgJ00wMDIgUk9BRE1BUCBwcm9qZWN0aW9uIGlzIG5vdCBjb3BpZWQgdG8gbWFpbicsXG4gICAgICApO1xuXG4gICAgICBhc3NlcnQub2soXG4gICAgICAgICFzeW5jZWQuc29tZSgocCkgPT4gcC5pbmNsdWRlcygnTTAwMi1hYmMxMjMnKSksXG4gICAgICAgICdNMDAyIGRvZXMgbm90IGFwcGVhciBpbiBzeW5jZWQgbGlzdCcsXG4gICAgICApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmMobWFpbkJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICAgIHJtU3luYyh3dEJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgMTEuIEZ1bGwgTTAwNlx1MjE5Mk0wMDcgdHJhbnNpdGlvbiBzY2VuYXJpbyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgY29uc29sZS5sb2coJ1xcbj09PSAxMS4gY29tcGxldGUtbWlsZXN0b25lIHdvcmt0cmVlIHByb2plY3Rpb25zIGRvIG5vdCBvdmVyd3JpdGUgcHJvamVjdCByb290ID09PScpO1xuICB7XG4gICAgY29uc3QgbWFpbkJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCAnZ3NkLXd0LXRyYW5zaXRpb24tbWFpbi0nKSk7XG4gICAgY29uc3Qgd3RCYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgJ2dzZC13dC10cmFuc2l0aW9uLXd0LScpKTtcblxuICAgIHRyeSB7XG4gICAgICBta2RpclN5bmMoam9pbihtYWluQmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIG1rZGlyU3luYyhqb2luKHd0QmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAgICAgLy8gTWFpbiBzdGFydHMgd2l0aCBNMDA2IGNvbnRleHQgKyBleGlzdGluZyBSRVFVSVJFTUVOVFNcbiAgICAgIGNvbnN0IG1haW5NMDA2ID0gam9pbihtYWluQmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDA2LTU4OXd2aCcpO1xuICAgICAgbWtkaXJTeW5jKG1haW5NMDA2LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihtYWluTTAwNiwgJ00wMDYtNTg5d3ZoLUNPTlRFWFQubWQnKSwgJyMgTTAwNiBDb250ZXh0Jyk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4obWFpbkJhc2UsICcuZ3NkJywgJ1JFUVVJUkVNRU5UUy5tZCcpLCAnIyBSZXF1aXJlbWVudHNcXG4jIyBSMDAxIHRocm91Z2ggUjA4OScpO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKG1haW5CYXNlLCAnLmdzZCcsICdQUk9KRUNULm1kJyksICcjIFByb2plY3RcXG5NaWxlc3RvbmVzOiBNMDAxLU0wMDYnKTtcblxuICAgICAgLy8gV29ya3RyZWUgKE0wMDYgZXhlY3V0aW9uIGNvbnRleHQpIGhhczpcbiAgICAgIC8vIC0gTTAwNiBTVU1NQVJZICsgVkFMSURBVElPTiAoY3JlYXRlZCBieSBjb21wbGV0ZS1taWxlc3RvbmUpXG4gICAgICAvLyAtIE0wMDcgc2V0dXAgKGNyZWF0ZWQgYnkgY29tcGxldGUtbWlsZXN0b25lIGZvciBuZXh0IG1pbGVzdG9uZSlcbiAgICAgIC8vIC0gVXBkYXRlZCBSRVFVSVJFTUVOVFMgd2l0aCBSMDkwLVIwOTRcbiAgICAgIC8vIC0gVXBkYXRlZCBQUk9KRUNUIHdpdGggTTAwN1xuICAgICAgY29uc3Qgd3RNMDA2ID0gam9pbih3dEJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwNi01ODl3dmgnKTtcbiAgICAgIG1rZGlyU3luYyhqb2luKHd0TTAwNiwgJ3NsaWNlcycsICdTMDEnKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4od3RNMDA2LCAnTTAwNi01ODl3dmgtQ09OVEVYVC5tZCcpLCAnIyBNMDA2IENvbnRleHQnKTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbih3dE0wMDYsICdNMDA2LTU4OXd2aC1TVU1NQVJZLm1kJyksICcjIE0wMDYgQ29tcGxldGUnKTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbih3dE0wMDYsICdNMDA2LTU4OXd2aC1WQUxJREFUSU9OLm1kJyksICcjIFZhbGlkYXRlZCcpO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHd0TTAwNiwgJ3NsaWNlcycsICdTMDEnLCAnUzAxLVNVTU1BUlkubWQnKSwgJyMgUzAxIGRvbmUnKTtcblxuICAgICAgY29uc3Qgd3RNMDA3ID0gam9pbih3dEJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwNy13b3J0YzgnKTtcbiAgICAgIG1rZGlyU3luYyh3dE0wMDcsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHd0TTAwNywgJ00wMDctd29ydGM4LUNPTlRFWFQubWQnKSwgJyMgTTAwNyBFbnRlcnByaXNlIFNlY3VyaXR5Jyk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4od3RNMDA3LCAnTTAwNy13b3J0YzgtUk9BRE1BUC5tZCcpLCAnIyBNMDA3IFJvYWRtYXBcXG4xMCBwaGFzZXMnKTtcblxuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHd0QmFzZSwgJy5nc2QnLCAnUkVRVUlSRU1FTlRTLm1kJyksICcjIFJlcXVpcmVtZW50c1xcbiMjIFIwMDEtUjA4OVxcbiMjIFIwOTAgXHUyMDE0IFNDSU1cXG4jIyBSMDkxIFx1MjAxNCBXZWJBdXRobicpO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHd0QmFzZSwgJy5nc2QnLCAnUFJPSkVDVC5tZCcpLCAnIyBQcm9qZWN0XFxuTWlsZXN0b25lczogTTAwMS1NMDA3Jyk7XG5cbiAgICAgIC8vIFN5bmMgd2l0aCBtaWxlc3RvbmVJZCA9IE0wMDYgKHRoZSBjb21wbGV0aW5nIG1pbGVzdG9uZSBcdTIwMTQgc2tpcHBlZCBieSBzeW5jKVxuICAgICAgY29uc3QgeyBzeW5jZWQgfSA9IHN5bmNXb3JrdHJlZVN0YXRlQmFjayhtYWluQmFzZSwgd3RCYXNlLCAnTTAwNi01ODl3dmgnKTtcblxuICAgICAgLy8gTTAwNiBpcyB0aGUgY3VycmVudCBtaWxlc3RvbmUgYmVpbmcgbWVyZ2VkIFx1MjAxNCBpdCBzaG91bGQgYmUgU0tJUFBFRCAoIzM2NDEpXG4gICAgICAvLyBJdHMgZmlsZXMgYXJlIGFscmVhZHkgaW4gdGhlIG1pbGVzdG9uZSBicmFuY2ggYW5kIHdvdWxkIGNvbmZsaWN0IHdpdGggc3F1YXNoIG1lcmdlLlxuICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICAhZXhpc3RzU3luYyhqb2luKG1haW5CYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgJ00wMDYtNTg5d3ZoJywgJ00wMDYtNTg5d3ZoLVNVTU1BUlkubWQnKSksXG4gICAgICAgICdNMDA2IFNVTU1BUlkgTk9UIHN5bmNlZCAoY3VycmVudCBtaWxlc3RvbmUgc2tpcHBlZCknLFxuICAgICAgKTtcblxuICAgICAgLy8gVmVyaWZ5IE0wMDcgd29ya3RyZWUgcHJvamVjdGlvbnMgYXJlIG5vdCBjb3BpZWQgYmFjay5cbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgIWV4aXN0c1N5bmMoam9pbihtYWluQmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDA3LXdvcnRjOCcsICdNMDA3LXdvcnRjOC1DT05URVhULm1kJykpLFxuICAgICAgICAnTTAwNyBDT05URVhUIHByb2plY3Rpb24gaXMgbm90IGNvcGllZCB0byBtYWluJyxcbiAgICAgICk7XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgICFleGlzdHNTeW5jKGpvaW4obWFpbkJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwNy13b3J0YzgnLCAnTTAwNy13b3J0YzgtUk9BRE1BUC5tZCcpKSxcbiAgICAgICAgJ00wMDcgUk9BRE1BUCBwcm9qZWN0aW9uIGlzIG5vdCBjb3BpZWQgdG8gbWFpbicsXG4gICAgICApO1xuXG4gICAgICAvLyBWZXJpZnkgcm9vdC1sZXZlbCBwcm9qZWN0aW9ucyByZW1haW4gcHJvamVjdC1yb290IGF1dGhvcml0YXRpdmUuXG4gICAgICBjb25zdCByZXFDb250ZW50ID0gcmVhZEZpbGVTeW5jKGpvaW4obWFpbkJhc2UsICcuZ3NkJywgJ1JFUVVJUkVNRU5UUy5tZCcpLCAndXRmLTgnKTtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgIXJlcUNvbnRlbnQuaW5jbHVkZXMoJ1IwOTAnKSxcbiAgICAgICAgJ1JFUVVJUkVNRU5UUy5tZCBpZ25vcmVzIHdvcmt0cmVlIHByb2plY3Rpb24gdXBkYXRlcycsXG4gICAgICApO1xuXG4gICAgICBjb25zdCBwcm9qQ29udGVudCA9IHJlYWRGaWxlU3luYyhqb2luKG1haW5CYXNlLCAnLmdzZCcsICdQUk9KRUNULm1kJyksICd1dGYtOCcpO1xuICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICAhcHJvakNvbnRlbnQuaW5jbHVkZXMoJ00wMDcnKSxcbiAgICAgICAgJ1BST0pFQ1QubWQgaWdub3JlcyB3b3JrdHJlZSBwcm9qZWN0aW9uIHVwZGF0ZXMnLFxuICAgICAgKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKG1haW5CYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgICBybVN5bmMod3RCYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIDEyLiBzeW5jV29ya3RyZWVTdGF0ZUJhY2sgbm8tb3AgZm9yIHJvb3QgZmlsZXMgdGhhdCBkb24ndCBleGlzdCBcdTI1MDBcdTI1MDBcbiAgY29uc29sZS5sb2coJ1xcbj09PSAxMi4gcm9vdCBmaWxlcyBub3QgaW4gd29ya3RyZWUgYXJlIG5vdCBjcmVhdGVkIGluIG1haW4gPT09Jyk7XG4gIHtcbiAgICBjb25zdCBtYWluQmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksICdnc2Qtd3QtYmFjay1ub3Jvb3QtbWFpbi0nKSk7XG4gICAgY29uc3Qgd3RCYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgJ2dzZC13dC1iYWNrLW5vcm9vdC13dC0nKSk7XG5cbiAgICB0cnkge1xuICAgICAgbWtkaXJTeW5jKGpvaW4obWFpbkJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIG1rZGlyU3luYyhqb2luKHd0QmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gICAgICAvLyBNYWluIGhhcyBSRVFVSVJFTUVOVFMsIHdvcmt0cmVlIGRvZXMgbm90XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4obWFpbkJhc2UsICcuZ3NkJywgJ1JFUVVJUkVNRU5UUy5tZCcpLCAnIyBPcmlnaW5hbCcpO1xuXG4gICAgICBjb25zdCB7IHN5bmNlZCB9ID0gc3luY1dvcmt0cmVlU3RhdGVCYWNrKG1haW5CYXNlLCB3dEJhc2UsICdNMDAxJyk7XG5cbiAgICAgIC8vIE1haW4ncyBSRVFVSVJFTUVOVFMgc2hvdWxkIGJlIHVudG91Y2hlZCAod29ya3RyZWUgaGFkIG5vdGhpbmcgdG8gc3luYylcbiAgICAgIGNvbnN0IGNvbnRlbnQgPSByZWFkRmlsZVN5bmMoam9pbihtYWluQmFzZSwgJy5nc2QnLCAnUkVRVUlSRU1FTlRTLm1kJyksICd1dGYtOCcpO1xuICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICBjb250ZW50ID09PSAnIyBPcmlnaW5hbCcsXG4gICAgICAgICdSRVFVSVJFTUVOVFMubWQgdW5jaGFuZ2VkIHdoZW4gd29ya3RyZWUgaGFzIG5vIGNvcHknLFxuICAgICAgKTtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgIXN5bmNlZC5pbmNsdWRlcygnUkVRVUlSRU1FTlRTLm1kJyksXG4gICAgICAgICdSRVFVSVJFTUVOVFMubWQgbm90IGluIHN5bmNlZCBsaXN0JyxcbiAgICAgICk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyhtYWluQmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgICAgcm1TeW5jKHd0QmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCAxMy4gc3luY1dvcmt0cmVlU3RhdGVCYWNrIHNraXBzIFFVRVVFLm1kIGJ1dCBwcmVzZXJ2ZXMgY29tcGxldGVkLXVuaXRzIGRpYWdub3N0aWNzIFx1MjUwMFx1MjUwMFxuICBjb25zb2xlLmxvZygnXFxuPT09IDEzLiBRVUVVRS5tZCBza2lwcGVkOyBjb21wbGV0ZWQtdW5pdHMuanNvbiBkaWFnbm9zdGljIHN5bmNlZCA9PT0nKTtcbiAge1xuICAgIGNvbnN0IG1haW5CYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgJ2dzZC13dC1iYWNrLXF1ZXVlLW1haW4tJykpO1xuICAgIGNvbnN0IHd0QmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksICdnc2Qtd3QtYmFjay1xdWV1ZS13dC0nKSk7XG5cbiAgICB0cnkge1xuICAgICAgbWtkaXJTeW5jKGpvaW4obWFpbkJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIG1rZGlyU3luYyhqb2luKHd0QmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gICAgICAvLyBXb3JrdHJlZSBoYXMgUVVFVUUubWQgcHJvamVjdGlvbiBhbmQgY29tcGxldGVkLXVuaXRzLmpzb24gZGlhZ25vc3RpYy5cbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbih3dEJhc2UsICcuZ3NkJywgJ1FVRVVFLm1kJyksICcjIFF1ZXVlXFxuLSBNMDAyIG5leHQnKTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICAgIGpvaW4od3RCYXNlLCAnLmdzZCcsICdjb21wbGV0ZWQtdW5pdHMuanNvbicpLFxuICAgICAgICBKU09OLnN0cmluZ2lmeSh7IHVuaXRzOiBbeyBpZDogJ00wMDEtUzAxLVQwMScsIGNvbXBsZXRlZDogdHJ1ZSB9XSB9KSxcbiAgICAgICk7XG5cbiAgICAgIC8vIE1haW4gaGFzIG5laXRoZXJcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgIWV4aXN0c1N5bmMoam9pbihtYWluQmFzZSwgJy5nc2QnLCAnUVVFVUUubWQnKSksXG4gICAgICAgICdRVUVVRS5tZCBtaXNzaW5nIGluIG1haW4gYmVmb3JlIHN5bmMnLFxuICAgICAgKTtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgIWV4aXN0c1N5bmMoam9pbihtYWluQmFzZSwgJy5nc2QnLCAnY29tcGxldGVkLXVuaXRzLmpzb24nKSksXG4gICAgICAgICdjb21wbGV0ZWQtdW5pdHMuanNvbiBtaXNzaW5nIGluIG1haW4gYmVmb3JlIHN5bmMnLFxuICAgICAgKTtcblxuICAgICAgY29uc3QgeyBzeW5jZWQgfSA9IHN5bmNXb3JrdHJlZVN0YXRlQmFjayhtYWluQmFzZSwgd3RCYXNlLCAnTTAwMScpO1xuXG4gICAgICAvLyBRVUVVRS5tZCBpcyBzdGF0ZS9wcm9qZWN0aW9uIGNvbnRlbnQgYW5kIHNob3VsZCBub3QgYmUgY29waWVkIGJhY2suXG4gICAgICBhc3NlcnQub2soXG4gICAgICAgICFleGlzdHNTeW5jKGpvaW4obWFpbkJhc2UsICcuZ3NkJywgJ1FVRVVFLm1kJykpLFxuICAgICAgICAnUVVFVUUubWQgaXMgbm90IHN5bmNlZCBmcm9tIHdvcmt0cmVlIHRvIG1haW4nLFxuICAgICAgKTtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgIXN5bmNlZC5pbmNsdWRlcygnUVVFVUUubWQnKSxcbiAgICAgICAgJ1FVRVVFLm1kIGRvZXMgbm90IGFwcGVhciBpbiBzeW5jZWQgbGlzdCcsXG4gICAgICApO1xuXG4gICAgICAvLyBjb21wbGV0ZWQtdW5pdHMuanNvbiBpcyBkaWFnbm9zdGljIGFuZCBtYXkgYmUgY29waWVkIGZvciBvcGVyYXRvciB2aXNpYmlsaXR5LlxuICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICBleGlzdHNTeW5jKGpvaW4obWFpbkJhc2UsICcuZ3NkJywgJ2NvbXBsZXRlZC11bml0cy5qc29uJykpLFxuICAgICAgICAnIzE3ODc6IGNvbXBsZXRlZC11bml0cy5qc29uIHN5bmNlZCBmcm9tIHdvcmt0cmVlIHRvIG1haW4nLFxuICAgICAgKTtcbiAgICAgIGNvbnN0IGN1Q29udGVudCA9IHJlYWRGaWxlU3luYyhqb2luKG1haW5CYXNlLCAnLmdzZCcsICdjb21wbGV0ZWQtdW5pdHMuanNvbicpLCAndXRmLTgnKTtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgY3VDb250ZW50LmluY2x1ZGVzKCdNMDAxLVMwMS1UMDEnKSxcbiAgICAgICAgJyMxNzg3OiBjb21wbGV0ZWQtdW5pdHMuanNvbiBoYXMgY29ycmVjdCBjb250ZW50JyxcbiAgICAgICk7XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgIHN5bmNlZC5pbmNsdWRlcygnY29tcGxldGVkLXVuaXRzLmpzb24nKSxcbiAgICAgICAgJyMxNzg3OiBjb21wbGV0ZWQtdW5pdHMuanNvbiBhcHBlYXJzIGluIHN5bmNlZCBsaXN0JyxcbiAgICAgICk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyhtYWluQmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgICAgcm1TeW5jKHd0QmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCAxNC4gc3luY0dzZFN0YXRlVG9Xb3JrdHJlZSBzeW5jcyBub24tc3RhbmRhcmQgbWlsZXN0b25lIGRpciBuYW1lcyAoIzE1NDcpIFx1MjUwMFx1MjUwMFxuICBjb25zb2xlLmxvZygnXFxuPT09IDE0LiBzeW5jR3NkU3RhdGVUb1dvcmt0cmVlIHN5bmNzIG5vbi1zdGFuZGFyZCBtaWxlc3RvbmUgZGlyIG5hbWVzICgjMTU0NykgPT09Jyk7XG4gIHtcbiAgICBjb25zdCBtYWluQmFzZSA9IGNyZWF0ZUJhc2UoJ21haW4nKTtcbiAgICBjb25zdCB3dEJhc2UgPSBjcmVhdGVCYXNlKCd3dCcpO1xuXG4gICAgdHJ5IHtcbiAgICAgIC8vIE1haW4gaGFzIG1pbGVzdG9uZSBkaXJzIHdpdGggbm9uLXN0YW5kYXJkIG5hbWVzXG4gICAgICBjb25zdCBjdXN0b21EaXIgPSBqb2luKG1haW5CYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgJ3NwcmludC1hbHBoYScpO1xuICAgICAgbWtkaXJTeW5jKGN1c3RvbURpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4oY3VzdG9tRGlyLCAnQ09OVEVYVC5tZCcpLCAnIyBTcHJpbnQgQWxwaGEgQ29udGV4dCcpO1xuXG4gICAgICBjb25zdCBzdWZmaXhEaXIgPSBqb2luKG1haW5CYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgJ00wMDEtYWJjMTIzJyk7XG4gICAgICBta2RpclN5bmMoc3VmZml4RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihzdWZmaXhEaXIsICdNMDAxLWFiYzEyMy1DT05URVhULm1kJyksICcjIE0wMDEgQ29udGV4dCcpO1xuXG4gICAgICBhc3NlcnQub2soIWV4aXN0c1N5bmMoam9pbih3dEJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnc3ByaW50LWFscGhhJykpLCAnc3ByaW50LWFscGhhIG1pc3NpbmcgYmVmb3JlIHN5bmMnKTtcbiAgICAgIGFzc2VydC5vayghZXhpc3RzU3luYyhqb2luKHd0QmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxLWFiYzEyMycpKSwgJ00wMDEtYWJjMTIzIG1pc3NpbmcgYmVmb3JlIHN5bmMnKTtcblxuICAgICAgY29uc3QgcmVzdWx0ID0gc3luY0dzZFN0YXRlVG9Xb3JrdHJlZShtYWluQmFzZSwgd3RCYXNlKTtcblxuICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICBleGlzdHNTeW5jKGpvaW4od3RCYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgJ3NwcmludC1hbHBoYScsICdDT05URVhULm1kJykpLFxuICAgICAgICAnIzE1NDc6IG5vbi1zdGFuZGFyZCBtaWxlc3RvbmUgZGlyIFwic3ByaW50LWFscGhhXCIgc3luY2VkIHRvIHdvcmt0cmVlJyxcbiAgICAgICk7XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgIGV4aXN0c1N5bmMoam9pbih3dEJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMS1hYmMxMjMnLCAnTTAwMS1hYmMxMjMtQ09OVEVYVC5tZCcpKSxcbiAgICAgICAgJyMxNTQ3OiBzdWZmaXhlZCBtaWxlc3RvbmUgZGlyIFwiTTAwMS1hYmMxMjNcIiBzeW5jZWQgdG8gd29ya3RyZWUnLFxuICAgICAgKTtcbiAgICAgIGFzc2VydC5vayhyZXN1bHQuc3luY2VkLmxlbmd0aCA+IDAsICdzeW5jIHJlcG9ydGVkIGZpbGVzJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAobWFpbkJhc2UpO1xuICAgICAgY2xlYW51cCh3dEJhc2UpO1xuICAgIH1cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCAxNS4gc3luY1dvcmt0cmVlU3RhdGVCYWNrIHNraXBzIG5vbi1zdGFuZGFyZCBtaWxlc3RvbmUgZGlyIG5hbWVzIFx1MjUwMFx1MjUwMFxuICBjb25zb2xlLmxvZygnXFxuPT09IDE1LiBzeW5jV29ya3RyZWVTdGF0ZUJhY2sgc2tpcHMgbm9uLXN0YW5kYXJkIG1pbGVzdG9uZSBkaXIgbmFtZXMgPT09Jyk7XG4gIHtcbiAgICBjb25zdCBtYWluQmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksICdnc2Qtd3QtYmFjay1jdXN0b20tbWFpbi0nKSk7XG4gICAgY29uc3Qgd3RCYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgJ2dzZC13dC1iYWNrLWN1c3RvbS13dC0nKSk7XG5cbiAgICB0cnkge1xuICAgICAgbWtkaXJTeW5jKGpvaW4obWFpbkJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICBta2RpclN5bmMoam9pbih3dEJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgICAgIC8vIFdvcmt0cmVlIGhhcyBhIG5vbi1zdGFuZGFyZCBtaWxlc3RvbmUgZGlyXG4gICAgICBjb25zdCB3dEN1c3RvbURpciA9IGpvaW4od3RCYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgJ3NwcmludC1iZXRhJyk7XG4gICAgICBta2RpclN5bmMod3RDdXN0b21EaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHd0Q3VzdG9tRGlyLCAnU1VNTUFSWS5tZCcpLCAnIyBTcHJpbnQgQmV0YSBTdW1tYXJ5Jyk7XG5cbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgIWV4aXN0c1N5bmMoam9pbihtYWluQmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdzcHJpbnQtYmV0YScpKSxcbiAgICAgICAgJ3NwcmludC1iZXRhIG1pc3NpbmcgaW4gbWFpbiBiZWZvcmUgc3luYycsXG4gICAgICApO1xuXG4gICAgICBjb25zdCB7IHN5bmNlZCB9ID0gc3luY1dvcmt0cmVlU3RhdGVCYWNrKG1haW5CYXNlLCB3dEJhc2UsICdNMDAxJyk7XG5cbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgIWV4aXN0c1N5bmMoam9pbihtYWluQmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdzcHJpbnQtYmV0YScsICdTVU1NQVJZLm1kJykpLFxuICAgICAgICAnbm9uLXN0YW5kYXJkIG1pbGVzdG9uZSBwcm9qZWN0aW9uIGlzIG5vdCBjb3BpZWQgYmFjayB0byBtYWluJyxcbiAgICAgICk7XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgICFzeW5jZWQuc29tZSgocCkgPT4gcC5pbmNsdWRlcygnc3ByaW50LWJldGEnKSksXG4gICAgICAgICdzcHJpbnQtYmV0YSBkb2VzIG5vdCBhcHBlYXIgaW4gc3luY2VkIGxpc3QnLFxuICAgICAgKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKG1haW5CYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgICBybVN5bmMod3RCYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQXlCQSxTQUFTLGFBQWEsV0FBVyxlQUFlLFFBQVEsWUFBWSxvQkFBb0I7QUFDeEYsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUV2QixTQUFTLGlDQUFpQztBQUMxQyxTQUFTLHdCQUF3Qiw2QkFBNkI7QUFDOUQsU0FBUyxnQkFBc0I7QUFDL0IsT0FBTyxZQUFZO0FBR25CLFNBQVMsV0FBVyxNQUFzQjtBQUN4QyxRQUFNLE9BQU8sWUFBWSxLQUFLLE9BQU8sR0FBRyxlQUFlLElBQUksR0FBRyxDQUFDO0FBQy9ELFlBQVUsS0FBSyxNQUFNLFFBQVEsWUFBWSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDL0QsU0FBTztBQUNUO0FBRUEsU0FBUyxRQUFRLE1BQW9CO0FBQ25DLFNBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUMvQztBQUVBLFNBQVMsNEJBQTRCLFlBQVk7QUFHL0MsVUFBUSxJQUFJLCtEQUErRDtBQUMzRTtBQUNFLFVBQU0sV0FBVyxXQUFXLE1BQU07QUFDbEMsVUFBTSxTQUFTLFdBQVcsSUFBSTtBQUU5QixRQUFJO0FBQ0YsWUFBTSxVQUFVLEtBQUssVUFBVSxRQUFRLGNBQWMsTUFBTTtBQUMzRCxnQkFBVSxTQUFTLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDdEMsb0JBQWMsS0FB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
