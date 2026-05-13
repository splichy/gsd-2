import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { deriveState, invalidateStateCache, getActiveMilestoneId } from "../state.js";
import { clearPathCache } from "../paths.js";
import { parkMilestone, unparkMilestone, discardMilestone, isParked, getParkedReason } from "../milestone-actions.js";
import {
  closeDatabase,
  getMilestone,
  getMilestoneSlices,
  getSliceTasks,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase
} from "../gsd-db.js";
import { createWorktree } from "../worktree-manager.js";
process.env.GSD_ALLOW_MARKDOWN_DERIVE_FALLBACK = "1";
function createFixtureBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-park-test-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}
function createMilestone(base, mid, opts) {
  const mDir = join(base, ".gsd", "milestones", mid);
  mkdirSync(mDir, { recursive: true });
  if (opts?.dependsOn) {
    writeFileSync(join(mDir, `${mid}-CONTEXT.md`), [
      "---",
      `depends_on: [${opts.dependsOn.join(", ")}]`,
      "---",
      "",
      `# ${mid} Context`
    ].join("\n"), "utf-8");
  }
  if (opts?.withRoadmap) {
    writeFileSync(join(mDir, `${mid}-ROADMAP.md`), [
      `# ${mid}: Test Milestone`,
      "",
      "## Vision",
      "Test milestone for park/unpark testing.",
      "",
      "## Success Criteria",
      "- [ ] Tests pass",
      "",
      "## Slices",
      `- [${opts?.withSummary ? "x" : " "}] **S01: Setup** \`risk:low\` \`depends:[]\``,
      "  - After this: Basic setup complete."
    ].join("\n"), "utf-8");
  }
  if (opts?.withSummary) {
    writeFileSync(join(mDir, `${mid}-SUMMARY.md`), [
      "---",
      `id: ${mid}`,
      "---",
      "",
      `# ${mid} \u2014 Complete`
    ].join("\n"), "utf-8");
  }
}
function cleanup(base) {
  try {
    closeDatabase();
  } catch {
  }
  rmSync(base, { recursive: true, force: true });
}
function run(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}
function initGitRepo(base) {
  writeFileSync(join(base, "README.md"), "# test\n", "utf-8");
  writeFileSync(join(base, ".gsd", "STATE.md"), "# State\n", "utf-8");
  run("git init", base);
  run("git config user.email test@test.com", base);
  run("git config user.name Test", base);
  run("git add .", base);
  run('git commit -m "init"', base);
  run("git branch -M main", base);
}
function clearCaches() {
  clearPathCache();
  invalidateStateCache();
}
describe("park-milestone", () => {
  test("parkMilestone creates PARKED.md", () => {
    const base = createFixtureBase();
    try {
      createMilestone(base, "M001", { withRoadmap: true });
      clearCaches();
      const success = parkMilestone(base, "M001", "Priority shift");
      assert.ok(success, "parkMilestone returns true");
      assert.ok(isParked(base, "M001"), "isParked returns true after parking");
      const reason = getParkedReason(base, "M001");
      assert.deepStrictEqual(reason, "Priority shift", "reason matches");
    } finally {
      cleanup(base);
    }
  });
  test("parkMilestone fails if already parked", () => {
    const base = createFixtureBase();
    try {
      createMilestone(base, "M001", { withRoadmap: true });
      clearCaches();
      parkMilestone(base, "M001", "First park");
      const secondPark = parkMilestone(base, "M001", "Second park");
      assert.ok(!secondPark, "second parkMilestone returns false");
      assert.deepStrictEqual(getParkedReason(base, "M001"), "First park", "reason unchanged from first park");
    } finally {
      cleanup(base);
    }
  });
  test("unparkMilestone removes PARKED.md", () => {
    const base = createFixtureBase();
    try {
      createMilestone(base, "M001", { withRoadmap: true });
      clearCaches();
      parkMilestone(base, "M001", "Test reason");
      assert.ok(isParked(base, "M001"), "milestone is parked");
      const success = unparkMilestone(base, "M001");
      assert.ok(success, "unparkMilestone returns true");
      assert.ok(!isParked(base, "M001"), "isParked returns false after unpark");
    } finally {
      cleanup(base);
    }
  });
  test("unparkMilestone fails if not parked", () => {
    const base = createFixtureBase();
    try {
      createMilestone(base, "M001", { withRoadmap: true });
      clearCaches();
      const result = unparkMilestone(base, "M001");
      assert.ok(!result, "unparkMilestone returns false when not parked");
    } finally {
      cleanup(base);
    }
  });
  test("deriveState returns parked status", async () => {
    const base = createFixtureBase();
    try {
      createMilestone(base, "M001", { withRoadmap: true });
      clearCaches();
      parkMilestone(base, "M001", "Test reason");
      const state = await deriveState(base);
      const entry = state.registry.find((e) => e.id === "M001");
      assert.ok(!!entry, "M001 in registry");
      assert.deepStrictEqual(entry?.status, "parked", "status is parked");
    } finally {
      cleanup(base);
    }
  });
  test("deriveState skips parked milestone", async () => {
    const base = createFixtureBase();
    try {
      createMilestone(base, "M001", { withRoadmap: true });
      createMilestone(base, "M002", { withRoadmap: true });
      clearCaches();
      const stateBefore = await deriveState(base);
      assert.deepStrictEqual(stateBefore.activeMilestone?.id, "M001", "before park: M001 is active");
      parkMilestone(base, "M001", "Testing");
      const stateAfter = await deriveState(base);
      assert.deepStrictEqual(stateAfter.activeMilestone?.id, "M002", "after park: M002 is active");
      const m001 = stateAfter.registry.find((e) => e.id === "M001");
      assert.deepStrictEqual(m001?.status, "parked", "M001 has parked status");
      const m002 = stateAfter.registry.find((e) => e.id === "M002");
      assert.deepStrictEqual(m002?.status, "active", "M002 has active status");
    } finally {
      cleanup(base);
    }
  });
  test("getActiveMilestoneId skips parked", async () => {
    const base = createFixtureBase();
    try {
      createMilestone(base, "M001", { withRoadmap: true });
      createMilestone(base, "M002", { withRoadmap: true });
      clearCaches();
      parkMilestone(base, "M001", "Testing");
      const activeId = await getActiveMilestoneId(base);
      assert.deepStrictEqual(activeId, "M002", "getActiveMilestoneId returns M002");
    } finally {
      cleanup(base);
    }
  });
  test("Parked milestone does not satisfy depends_on", async () => {
    const base = createFixtureBase();
    try {
      createMilestone(base, "M001", { withRoadmap: true });
      createMilestone(base, "M002", { withRoadmap: true, dependsOn: ["M001"] });
      clearCaches();
      parkMilestone(base, "M001", "Testing");
      const state = await deriveState(base);
      const m002 = state.registry.find((e) => e.id === "M002");
      assert.deepStrictEqual(m002?.status, "pending", "M002 stays pending when M001 is parked");
      assert.deepStrictEqual(state.activeMilestone, null, "no active milestone");
    } finally {
      cleanup(base);
    }
  });
  test("Park then unpark restores status", async () => {
    const base = createFixtureBase();
    try {
      createMilestone(base, "M001", { withRoadmap: true });
      createMilestone(base, "M002", { withRoadmap: true });
      clearCaches();
      parkMilestone(base, "M001", "Testing");
      const stateParked = await deriveState(base);
      assert.deepStrictEqual(stateParked.activeMilestone?.id, "M002", "while parked: M002 is active");
      unparkMilestone(base, "M001");
      const stateUnparked = await deriveState(base);
      assert.deepStrictEqual(stateUnparked.activeMilestone?.id, "M001", "after unpark: M001 is active again");
      assert.deepStrictEqual(stateUnparked.registry.find((e) => e.id === "M001")?.status, "active", "M001 is active status");
    } finally {
      cleanup(base);
    }
  });
  test("discardMilestone removes directory", async () => {
    const base = createFixtureBase();
    try {
      createMilestone(base, "M001", { withRoadmap: true });
      clearCaches();
      const mDir = join(base, ".gsd", "milestones", "M001");
      assert.ok(existsSync(mDir), "milestone dir exists before discard");
      const success = discardMilestone(base, "M001");
      assert.ok(success, "discardMilestone returns true");
      assert.ok(!existsSync(mDir), "milestone dir removed after discard");
      const state = await deriveState(base);
      assert.ok(!state.registry.some((e) => e.id === "M001"), "M001 not in registry after discard");
    } finally {
      cleanup(base);
    }
  });
  test("discardMilestone updates queue order", () => {
    const base = createFixtureBase();
    try {
      createMilestone(base, "M001", { withRoadmap: true });
      createMilestone(base, "M002", { withRoadmap: true });
      clearCaches();
      const queuePath = join(base, ".gsd", "QUEUE-ORDER.json");
      writeFileSync(queuePath, JSON.stringify({ order: ["M001", "M002"], updatedAt: (/* @__PURE__ */ new Date()).toISOString() }), "utf-8");
      discardMilestone(base, "M001");
      const queueContent = JSON.parse(readFileSync(queuePath, "utf-8"));
      assert.ok(!queueContent.order.includes("M001"), "M001 removed from queue order");
      assert.ok(queueContent.order.includes("M002"), "M002 still in queue order");
    } finally {
      cleanup(base);
    }
  });
  test("discardMilestone removes DB rows, worktree, and milestone branch", () => {
    const base = createFixtureBase();
    try {
      createMilestone(base, "M001", { withRoadmap: true });
      initGitRepo(base);
      clearCaches();
      assert.ok(openDatabase(join(base, ".gsd", "gsd.db")), "database opens");
      insertMilestone({ id: "M001", title: "Discard me", status: "active" });
      insertSlice({ milestoneId: "M001", id: "S01", title: "Only slice", status: "pending" });
      insertTask({ milestoneId: "M001", sliceId: "S01", id: "T01", title: "Only task", status: "pending" });
      const wt = createWorktree(base, "M001", { branch: "milestone/M001" });
      assert.ok(existsSync(wt.path), "worktree exists before discard");
      assert.ok(run("git branch", base).includes("milestone/M001"), "milestone branch exists before discard");
      assert.ok(getMilestone("M001"), "milestone exists in DB before discard");
      assert.equal(getMilestoneSlices("M001").length, 1, "slice exists in DB before discard");
      assert.equal(getSliceTasks("M001", "S01").length, 1, "task exists in DB before discard");
      const success = discardMilestone(base, "M001");
      assert.ok(success, "discardMilestone returns true");
      assert.equal(getMilestone("M001"), null, "milestone row removed from DB");
      assert.equal(getMilestoneSlices("M001").length, 0, "slice rows removed from DB");
      assert.equal(getSliceTasks("M001", "S01").length, 0, "task rows removed from DB");
      assert.ok(!existsSync(wt.path), "worktree removed after discard");
      assert.ok(!run("git branch", base).includes("milestone/M001"), "milestone branch removed after discard");
    } finally {
      cleanup(base);
    }
  });
  test("All milestones parked \u2192 no active", async () => {
    const base = createFixtureBase();
    try {
      createMilestone(base, "M001", { withRoadmap: true });
      clearCaches();
      parkMilestone(base, "M001", "Testing");
      const state = await deriveState(base);
      assert.deepStrictEqual(state.activeMilestone, null, "no active milestone when all parked");
      assert.deepStrictEqual(state.phase, "pre-planning", "phase is pre-planning");
      assert.ok(state.registry.length === 1, "registry still has 1 entry");
      assert.deepStrictEqual(state.registry[0]?.status, "parked", "entry is parked");
    } finally {
      cleanup(base);
    }
  });
  test("Park milestone without roadmap", async () => {
    const base = createFixtureBase();
    try {
      createMilestone(base, "M001");
      createMilestone(base, "M002", { withRoadmap: true });
      clearCaches();
      parkMilestone(base, "M001", "Not ready yet");
      const state = await deriveState(base);
      assert.deepStrictEqual(state.activeMilestone?.id, "M002", "M002 is active when M001 (no roadmap) is parked");
      assert.deepStrictEqual(state.registry.find((e) => e.id === "M001")?.status, "parked", "M001 is parked");
    } finally {
      cleanup(base);
    }
  });
  test("Progress counts with parked", async () => {
    const base = createFixtureBase();
    try {
      createMilestone(base, "M001", { withRoadmap: true, withSummary: true });
      createMilestone(base, "M002", { withRoadmap: true });
      createMilestone(base, "M003", { withRoadmap: true });
      clearCaches();
      parkMilestone(base, "M002", "Parked");
      const state = await deriveState(base);
      assert.deepStrictEqual(state.progress?.milestones.done, 1, "1 complete milestone");
      assert.deepStrictEqual(state.progress?.milestones.total, 3, "3 total milestones (including parked)");
      assert.deepStrictEqual(state.activeMilestone?.id, "M003", "M003 is active");
    } finally {
      cleanup(base);
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wYXJrLW1pbGVzdG9uZS50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBkZXNjcmliZSwgdGVzdCB9IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMsIGV4aXN0c1N5bmMsIHJlYWRGaWxlU3luYyB9IGZyb20gJ25vZGU6ZnMnO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gJ25vZGU6cGF0aCc7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tICdub2RlOm9zJztcbmltcG9ydCB7IGV4ZWNTeW5jIH0gZnJvbSAnbm9kZTpjaGlsZF9wcm9jZXNzJztcblxuaW1wb3J0IHsgZGVyaXZlU3RhdGUsIGludmFsaWRhdGVTdGF0ZUNhY2hlLCBnZXRBY3RpdmVNaWxlc3RvbmVJZCB9IGZyb20gJy4uL3N0YXRlLnRzJztcbmltcG9ydCB7IGNsZWFyUGF0aENhY2hlIH0gZnJvbSAnLi4vcGF0aHMudHMnO1xuaW1wb3J0IHsgcGFya01pbGVzdG9uZSwgdW5wYXJrTWlsZXN0b25lLCBkaXNjYXJkTWlsZXN0b25lLCBpc1BhcmtlZCwgZ2V0UGFya2VkUmVhc29uIH0gZnJvbSAnLi4vbWlsZXN0b25lLWFjdGlvbnMudHMnO1xuaW1wb3J0IHtcbiAgY2xvc2VEYXRhYmFzZSxcbiAgZ2V0TWlsZXN0b25lLFxuICBnZXRNaWxlc3RvbmVTbGljZXMsXG4gIGdldFNsaWNlVGFza3MsXG4gIGluc2VydE1pbGVzdG9uZSxcbiAgaW5zZXJ0U2xpY2UsXG4gIGluc2VydFRhc2ssXG4gIG9wZW5EYXRhYmFzZSxcbn0gZnJvbSBcIi4uL2dzZC1kYi50c1wiO1xuaW1wb3J0IHsgY3JlYXRlV29ya3RyZWUgfSBmcm9tIFwiLi4vd29ya3RyZWUtbWFuYWdlci50c1wiO1xuXG4vLyBUaGlzIHN1aXRlIGV4ZXJjaXNlcyB0aGUgZXhwbGljaXQgbGVnYWN5IG1hcmtkb3duIGRlcml2YXRpb24gcGF0aC5cbnByb2Nlc3MuZW52LkdTRF9BTExPV19NQVJLRE9XTl9ERVJJVkVfRkFMTEJBQ0sgPSAnMSc7XG5cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEZpeHR1cmUgSGVscGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gY3JlYXRlRml4dHVyZUJhc2UoKTogc3RyaW5nIHtcbiAgY29uc3QgYmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksICdnc2QtcGFyay10ZXN0LScpKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgcmV0dXJuIGJhc2U7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZU1pbGVzdG9uZShiYXNlOiBzdHJpbmcsIG1pZDogc3RyaW5nLCBvcHRzPzogeyB3aXRoUm9hZG1hcD86IGJvb2xlYW47IHdpdGhTdW1tYXJ5PzogYm9vbGVhbjsgZGVwZW5kc09uPzogc3RyaW5nW10gfSk6IHZvaWQge1xuICBjb25zdCBtRGlyID0gam9pbihiYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgbWlkKTtcbiAgbWtkaXJTeW5jKG1EaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gIGlmIChvcHRzPy5kZXBlbmRzT24pIHtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4obURpciwgYCR7bWlkfS1DT05URVhULm1kYCksIFtcbiAgICAgICctLS0nLFxuICAgICAgYGRlcGVuZHNfb246IFske29wdHMuZGVwZW5kc09uLmpvaW4oJywgJyl9XWAsXG4gICAgICAnLS0tJyxcbiAgICAgICcnLFxuICAgICAgYCMgJHttaWR9IENvbnRleHRgLFxuICAgIF0uam9pbignXFxuJyksICd1dGYtOCcpO1xuICB9XG5cbiAgaWYgKG9wdHM/LndpdGhSb2FkbWFwKSB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKG1EaXIsIGAke21pZH0tUk9BRE1BUC5tZGApLCBbXG4gICAgICBgIyAke21pZH06IFRlc3QgTWlsZXN0b25lYCxcbiAgICAgICcnLFxuICAgICAgJyMjIFZpc2lvbicsXG4gICAgICAnVGVzdCBtaWxlc3RvbmUgZm9yIHBhcmsvdW5wYXJrIHRlc3RpbmcuJyxcbiAgICAgICcnLFxuICAgICAgJyMjIFN1Y2Nlc3MgQ3JpdGVyaWEnLFxuICAgICAgJy0gWyBdIFRlc3RzIHBhc3MnLFxuICAgICAgJycsXG4gICAgICAnIyMgU2xpY2VzJyxcbiAgICAgIGAtIFske29wdHM/LndpdGhTdW1tYXJ5ID8gJ3gnIDogJyAnfV0gKipTMDE6IFNldHVwKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbXVxcYGAsXG4gICAgICAnICAtIEFmdGVyIHRoaXM6IEJhc2ljIHNldHVwIGNvbXBsZXRlLicsXG4gICAgXS5qb2luKCdcXG4nKSwgJ3V0Zi04Jyk7XG4gIH1cblxuICBpZiAob3B0cz8ud2l0aFN1bW1hcnkpIHtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4obURpciwgYCR7bWlkfS1TVU1NQVJZLm1kYCksIFtcbiAgICAgICctLS0nLFxuICAgICAgYGlkOiAke21pZH1gLFxuICAgICAgJy0tLScsXG4gICAgICAnJyxcbiAgICAgIGAjICR7bWlkfSBcdTIwMTQgQ29tcGxldGVgLFxuICAgIF0uam9pbignXFxuJyksICd1dGYtOCcpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGNsZWFudXAoYmFzZTogc3RyaW5nKTogdm9pZCB7XG4gIHRyeSB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICB9IGNhdGNoIHtcbiAgICAvLyBpZ25vcmVcbiAgfVxuICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xufVxuXG5mdW5jdGlvbiBydW4oY21kOiBzdHJpbmcsIGN3ZDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGV4ZWNTeW5jKGNtZCwgeyBjd2QsIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwicGlwZVwiXSwgZW5jb2Rpbmc6IFwidXRmLThcIiB9KS50cmltKCk7XG59XG5cbmZ1bmN0aW9uIGluaXRHaXRSZXBvKGJhc2U6IHN0cmluZyk6IHZvaWQge1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCJSRUFETUUubWRcIiksIFwiIyB0ZXN0XFxuXCIsIFwidXRmLThcIik7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJTVEFURS5tZFwiKSwgXCIjIFN0YXRlXFxuXCIsIFwidXRmLThcIik7XG4gIHJ1bihcImdpdCBpbml0XCIsIGJhc2UpO1xuICBydW4oXCJnaXQgY29uZmlnIHVzZXIuZW1haWwgdGVzdEB0ZXN0LmNvbVwiLCBiYXNlKTtcbiAgcnVuKFwiZ2l0IGNvbmZpZyB1c2VyLm5hbWUgVGVzdFwiLCBiYXNlKTtcbiAgcnVuKFwiZ2l0IGFkZCAuXCIsIGJhc2UpO1xuICBydW4oJ2dpdCBjb21taXQgLW0gXCJpbml0XCInLCBiYXNlKTtcbiAgcnVuKFwiZ2l0IGJyYW5jaCAtTSBtYWluXCIsIGJhc2UpO1xufVxuXG5mdW5jdGlvbiBjbGVhckNhY2hlcygpOiB2b2lkIHtcbiAgY2xlYXJQYXRoQ2FjaGUoKTtcbiAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbn1cblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBUZXN0c1xuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRlc3QgMTogcGFya01pbGVzdG9uZSBjcmVhdGVzIFBBUktFRC5tZCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoJ3BhcmstbWlsZXN0b25lJywgKCkgPT4ge1xudGVzdCgncGFya01pbGVzdG9uZSBjcmVhdGVzIFBBUktFRC5tZCcsICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgY3JlYXRlTWlsZXN0b25lKGJhc2UsICdNMDAxJywgeyB3aXRoUm9hZG1hcDogdHJ1ZSB9KTtcbiAgICAgIGNsZWFyQ2FjaGVzKCk7XG5cbiAgICAgIGNvbnN0IHN1Y2Nlc3MgPSBwYXJrTWlsZXN0b25lKGJhc2UsICdNMDAxJywgJ1ByaW9yaXR5IHNoaWZ0Jyk7XG4gICAgICBhc3NlcnQub2soc3VjY2VzcywgJ3BhcmtNaWxlc3RvbmUgcmV0dXJucyB0cnVlJyk7XG4gICAgICBhc3NlcnQub2soaXNQYXJrZWQoYmFzZSwgJ00wMDEnKSwgJ2lzUGFya2VkIHJldHVybnMgdHJ1ZSBhZnRlciBwYXJraW5nJyk7XG5cbiAgICAgIGNvbnN0IHJlYXNvbiA9IGdldFBhcmtlZFJlYXNvbihiYXNlLCAnTTAwMScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZWFzb24sICdQcmlvcml0eSBzaGlmdCcsICdyZWFzb24gbWF0Y2hlcycpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbn0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0IDI6IHBhcmtNaWxlc3RvbmUgaXMgaWRlbXBvdGVudCBcdTIwMTQgZmFpbHMgaWYgYWxyZWFkeSBwYXJrZWQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG50ZXN0KCdwYXJrTWlsZXN0b25lIGZhaWxzIGlmIGFscmVhZHkgcGFya2VkJywgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBjcmVhdGVNaWxlc3RvbmUoYmFzZSwgJ00wMDEnLCB7IHdpdGhSb2FkbWFwOiB0cnVlIH0pO1xuICAgICAgY2xlYXJDYWNoZXMoKTtcblxuICAgICAgcGFya01pbGVzdG9uZShiYXNlLCAnTTAwMScsICdGaXJzdCBwYXJrJyk7XG4gICAgICBjb25zdCBzZWNvbmRQYXJrID0gcGFya01pbGVzdG9uZShiYXNlLCAnTTAwMScsICdTZWNvbmQgcGFyaycpO1xuICAgICAgYXNzZXJ0Lm9rKCFzZWNvbmRQYXJrLCAnc2Vjb25kIHBhcmtNaWxlc3RvbmUgcmV0dXJucyBmYWxzZScpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChnZXRQYXJrZWRSZWFzb24oYmFzZSwgJ00wMDEnKSwgJ0ZpcnN0IHBhcmsnLCAncmVhc29uIHVuY2hhbmdlZCBmcm9tIGZpcnN0IHBhcmsnKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG59KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCAzOiB1bnBhcmtNaWxlc3RvbmUgcmVtb3ZlcyBQQVJLRUQubWQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG50ZXN0KCd1bnBhcmtNaWxlc3RvbmUgcmVtb3ZlcyBQQVJLRUQubWQnLCAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNyZWF0ZU1pbGVzdG9uZShiYXNlLCAnTTAwMScsIHsgd2l0aFJvYWRtYXA6IHRydWUgfSk7XG4gICAgICBjbGVhckNhY2hlcygpO1xuXG4gICAgICBwYXJrTWlsZXN0b25lKGJhc2UsICdNMDAxJywgJ1Rlc3QgcmVhc29uJyk7XG4gICAgICBhc3NlcnQub2soaXNQYXJrZWQoYmFzZSwgJ00wMDEnKSwgJ21pbGVzdG9uZSBpcyBwYXJrZWQnKTtcblxuICAgICAgY29uc3Qgc3VjY2VzcyA9IHVucGFya01pbGVzdG9uZShiYXNlLCAnTTAwMScpO1xuICAgICAgYXNzZXJ0Lm9rKHN1Y2Nlc3MsICd1bnBhcmtNaWxlc3RvbmUgcmV0dXJucyB0cnVlJyk7XG4gICAgICBhc3NlcnQub2soIWlzUGFya2VkKGJhc2UsICdNMDAxJyksICdpc1BhcmtlZCByZXR1cm5zIGZhbHNlIGFmdGVyIHVucGFyaycpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbn0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0IDQ6IHVucGFya01pbGVzdG9uZSBmYWlscyBpZiBub3QgcGFya2VkIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxudGVzdCgndW5wYXJrTWlsZXN0b25lIGZhaWxzIGlmIG5vdCBwYXJrZWQnLCAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNyZWF0ZU1pbGVzdG9uZShiYXNlLCAnTTAwMScsIHsgd2l0aFJvYWRtYXA6IHRydWUgfSk7XG4gICAgICBjbGVhckNhY2hlcygpO1xuXG4gICAgICBjb25zdCByZXN1bHQgPSB1bnBhcmtNaWxlc3RvbmUoYmFzZSwgJ00wMDEnKTtcbiAgICAgIGFzc2VydC5vayghcmVzdWx0LCAndW5wYXJrTWlsZXN0b25lIHJldHVybnMgZmFsc2Ugd2hlbiBub3QgcGFya2VkJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxufSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRlc3QgNTogZGVyaXZlU3RhdGUgcmV0dXJucyAncGFya2VkJyBzdGF0dXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG50ZXN0KCdkZXJpdmVTdGF0ZSByZXR1cm5zIHBhcmtlZCBzdGF0dXMnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNyZWF0ZU1pbGVzdG9uZShiYXNlLCAnTTAwMScsIHsgd2l0aFJvYWRtYXA6IHRydWUgfSk7XG4gICAgICBjbGVhckNhY2hlcygpO1xuXG4gICAgICBwYXJrTWlsZXN0b25lKGJhc2UsICdNMDAxJywgJ1Rlc3QgcmVhc29uJyk7XG5cbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG4gICAgICBjb25zdCBlbnRyeSA9IHN0YXRlLnJlZ2lzdHJ5LmZpbmQoZSA9PiBlLmlkID09PSAnTTAwMScpO1xuICAgICAgYXNzZXJ0Lm9rKCEhZW50cnksICdNMDAxIGluIHJlZ2lzdHJ5Jyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGVudHJ5Py5zdGF0dXMsICdwYXJrZWQnLCAnc3RhdHVzIGlzIHBhcmtlZCcpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbn0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0IDY6IGRlcml2ZVN0YXRlIHNraXBzIHBhcmtlZCBtaWxlc3RvbmUgZm9yIGFjdGl2ZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbnRlc3QoJ2Rlcml2ZVN0YXRlIHNraXBzIHBhcmtlZCBtaWxlc3RvbmUnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNyZWF0ZU1pbGVzdG9uZShiYXNlLCAnTTAwMScsIHsgd2l0aFJvYWRtYXA6IHRydWUgfSk7XG4gICAgICBjcmVhdGVNaWxlc3RvbmUoYmFzZSwgJ00wMDInLCB7IHdpdGhSb2FkbWFwOiB0cnVlIH0pO1xuICAgICAgY2xlYXJDYWNoZXMoKTtcblxuICAgICAgLy8gQmVmb3JlIHBhcms6IE0wMDEgaXMgYWN0aXZlXG4gICAgICBjb25zdCBzdGF0ZUJlZm9yZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZUJlZm9yZS5hY3RpdmVNaWxlc3RvbmU/LmlkLCAnTTAwMScsICdiZWZvcmUgcGFyazogTTAwMSBpcyBhY3RpdmUnKTtcblxuICAgICAgcGFya01pbGVzdG9uZShiYXNlLCAnTTAwMScsICdUZXN0aW5nJyk7XG5cbiAgICAgIC8vIEFmdGVyIHBhcms6IE0wMDIgYmVjb21lcyBhY3RpdmVcbiAgICAgIGNvbnN0IHN0YXRlQWZ0ZXIgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGVBZnRlci5hY3RpdmVNaWxlc3RvbmU/LmlkLCAnTTAwMicsICdhZnRlciBwYXJrOiBNMDAyIGlzIGFjdGl2ZScpO1xuXG4gICAgICAvLyBNMDAxIHN0aWxsIGluIHJlZ2lzdHJ5IGFzIHBhcmtlZFxuICAgICAgY29uc3QgbTAwMSA9IHN0YXRlQWZ0ZXIucmVnaXN0cnkuZmluZChlID0+IGUuaWQgPT09ICdNMDAxJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKG0wMDE/LnN0YXR1cywgJ3BhcmtlZCcsICdNMDAxIGhhcyBwYXJrZWQgc3RhdHVzJyk7XG5cbiAgICAgIC8vIE0wMDIgaXMgYWN0aXZlXG4gICAgICBjb25zdCBtMDAyID0gc3RhdGVBZnRlci5yZWdpc3RyeS5maW5kKGUgPT4gZS5pZCA9PT0gJ00wMDInKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwobTAwMj8uc3RhdHVzLCAnYWN0aXZlJywgJ00wMDIgaGFzIGFjdGl2ZSBzdGF0dXMnKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG59KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCA3OiBnZXRBY3RpdmVNaWxlc3RvbmVJZCBza2lwcyBwYXJrZWQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG50ZXN0KCdnZXRBY3RpdmVNaWxlc3RvbmVJZCBza2lwcyBwYXJrZWQnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNyZWF0ZU1pbGVzdG9uZShiYXNlLCAnTTAwMScsIHsgd2l0aFJvYWRtYXA6IHRydWUgfSk7XG4gICAgICBjcmVhdGVNaWxlc3RvbmUoYmFzZSwgJ00wMDInLCB7IHdpdGhSb2FkbWFwOiB0cnVlIH0pO1xuICAgICAgY2xlYXJDYWNoZXMoKTtcblxuICAgICAgcGFya01pbGVzdG9uZShiYXNlLCAnTTAwMScsICdUZXN0aW5nJyk7XG5cbiAgICAgIGNvbnN0IGFjdGl2ZUlkID0gYXdhaXQgZ2V0QWN0aXZlTWlsZXN0b25lSWQoYmFzZSk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGFjdGl2ZUlkLCAnTTAwMicsICdnZXRBY3RpdmVNaWxlc3RvbmVJZCByZXR1cm5zIE0wMDInKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG59KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCA4OiBQYXJrZWQgbWlsZXN0b25lIGRvZXMgTk9UIHNhdGlzZnkgZGVwZW5kc19vbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbnRlc3QoJ1BhcmtlZCBtaWxlc3RvbmUgZG9lcyBub3Qgc2F0aXNmeSBkZXBlbmRzX29uJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBjcmVhdGVNaWxlc3RvbmUoYmFzZSwgJ00wMDEnLCB7IHdpdGhSb2FkbWFwOiB0cnVlIH0pO1xuICAgICAgY3JlYXRlTWlsZXN0b25lKGJhc2UsICdNMDAyJywgeyB3aXRoUm9hZG1hcDogdHJ1ZSwgZGVwZW5kc09uOiBbJ00wMDEnXSB9KTtcbiAgICAgIGNsZWFyQ2FjaGVzKCk7XG5cbiAgICAgIHBhcmtNaWxlc3RvbmUoYmFzZSwgJ00wMDEnLCAnVGVzdGluZycpO1xuXG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuICAgICAgLy8gTTAwMSBpcyBwYXJrZWQsIE0wMDIgZGVwZW5kcyBvbiBNMDAxIFx1MjE5MiBNMDAyIHNob3VsZCBiZSBwZW5kaW5nLCBub3QgYWN0aXZlXG4gICAgICBjb25zdCBtMDAyID0gc3RhdGUucmVnaXN0cnkuZmluZChlID0+IGUuaWQgPT09ICdNMDAyJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKG0wMDI/LnN0YXR1cywgJ3BlbmRpbmcnLCAnTTAwMiBzdGF5cyBwZW5kaW5nIHdoZW4gTTAwMSBpcyBwYXJrZWQnKTtcblxuICAgICAgLy8gTm8gYWN0aXZlIG1pbGVzdG9uZSAoYm90aCBhcmUgYmxvY2tlZC9wYXJrZWQpXG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLmFjdGl2ZU1pbGVzdG9uZSwgbnVsbCwgJ25vIGFjdGl2ZSBtaWxlc3RvbmUnKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG59KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCA5OiBQYXJrIHRoZW4gdW5wYXJrIHJlc3RvcmVzIGNvcnJlY3Qgc3RhdHVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxudGVzdCgnUGFyayB0aGVuIHVucGFyayByZXN0b3JlcyBzdGF0dXMnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNyZWF0ZU1pbGVzdG9uZShiYXNlLCAnTTAwMScsIHsgd2l0aFJvYWRtYXA6IHRydWUgfSk7XG4gICAgICBjcmVhdGVNaWxlc3RvbmUoYmFzZSwgJ00wMDInLCB7IHdpdGhSb2FkbWFwOiB0cnVlIH0pO1xuICAgICAgY2xlYXJDYWNoZXMoKTtcblxuICAgICAgLy8gUGFyayBNMDAxXG4gICAgICBwYXJrTWlsZXN0b25lKGJhc2UsICdNMDAxJywgJ1Rlc3RpbmcnKTtcbiAgICAgIGNvbnN0IHN0YXRlUGFya2VkID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlUGFya2VkLmFjdGl2ZU1pbGVzdG9uZT8uaWQsICdNMDAyJywgJ3doaWxlIHBhcmtlZDogTTAwMiBpcyBhY3RpdmUnKTtcblxuICAgICAgLy8gVW5wYXJrIE0wMDEgXHUyMDE0IE0wMDEgc2hvdWxkIGJlY29tZSBhY3RpdmUgYWdhaW4gKGl0J3MgZmlyc3QgaW4gcXVldWUpXG4gICAgICB1bnBhcmtNaWxlc3RvbmUoYmFzZSwgJ00wMDEnKTtcbiAgICAgIGNvbnN0IHN0YXRlVW5wYXJrZWQgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGVVbnBhcmtlZC5hY3RpdmVNaWxlc3RvbmU/LmlkLCAnTTAwMScsICdhZnRlciB1bnBhcms6IE0wMDEgaXMgYWN0aXZlIGFnYWluJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlVW5wYXJrZWQucmVnaXN0cnkuZmluZChlID0+IGUuaWQgPT09ICdNMDAxJyk/LnN0YXR1cywgJ2FjdGl2ZScsICdNMDAxIGlzIGFjdGl2ZSBzdGF0dXMnKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG59KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCAxMDogZGlzY2FyZE1pbGVzdG9uZSByZW1vdmVzIGRpcmVjdG9yeSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbnRlc3QoJ2Rpc2NhcmRNaWxlc3RvbmUgcmVtb3ZlcyBkaXJlY3RvcnknLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNyZWF0ZU1pbGVzdG9uZShiYXNlLCAnTTAwMScsIHsgd2l0aFJvYWRtYXA6IHRydWUgfSk7XG4gICAgICBjbGVhckNhY2hlcygpO1xuXG4gICAgICBjb25zdCBtRGlyID0gam9pbihiYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJywgJ00wMDEnKTtcbiAgICAgIGFzc2VydC5vayhleGlzdHNTeW5jKG1EaXIpLCAnbWlsZXN0b25lIGRpciBleGlzdHMgYmVmb3JlIGRpc2NhcmQnKTtcblxuICAgICAgY29uc3Qgc3VjY2VzcyA9IGRpc2NhcmRNaWxlc3RvbmUoYmFzZSwgJ00wMDEnKTtcbiAgICAgIGFzc2VydC5vayhzdWNjZXNzLCAnZGlzY2FyZE1pbGVzdG9uZSByZXR1cm5zIHRydWUnKTtcbiAgICAgIGFzc2VydC5vayghZXhpc3RzU3luYyhtRGlyKSwgJ21pbGVzdG9uZSBkaXIgcmVtb3ZlZCBhZnRlciBkaXNjYXJkJyk7XG5cbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG4gICAgICBhc3NlcnQub2soIXN0YXRlLnJlZ2lzdHJ5LnNvbWUoZSA9PiBlLmlkID09PSAnTTAwMScpLCAnTTAwMSBub3QgaW4gcmVnaXN0cnkgYWZ0ZXIgZGlzY2FyZCcpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbn0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0IDExOiBkaXNjYXJkTWlsZXN0b25lIHVwZGF0ZXMgcXVldWUgb3JkZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG50ZXN0KCdkaXNjYXJkTWlsZXN0b25lIHVwZGF0ZXMgcXVldWUgb3JkZXInLCAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNyZWF0ZU1pbGVzdG9uZShiYXNlLCAnTTAwMScsIHsgd2l0aFJvYWRtYXA6IHRydWUgfSk7XG4gICAgICBjcmVhdGVNaWxlc3RvbmUoYmFzZSwgJ00wMDInLCB7IHdpdGhSb2FkbWFwOiB0cnVlIH0pO1xuICAgICAgY2xlYXJDYWNoZXMoKTtcblxuICAgICAgLy8gV3JpdGUgYSBxdWV1ZSBvcmRlciB0aGF0IGluY2x1ZGVzIE0wMDFcbiAgICAgIGNvbnN0IHF1ZXVlUGF0aCA9IGpvaW4oYmFzZSwgJy5nc2QnLCAnUVVFVUUtT1JERVIuanNvbicpO1xuICAgICAgd3JpdGVGaWxlU3luYyhxdWV1ZVBhdGgsIEpTT04uc3RyaW5naWZ5KHsgb3JkZXI6IFsnTTAwMScsICdNMDAyJ10sIHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpIH0pLCAndXRmLTgnKTtcblxuICAgICAgZGlzY2FyZE1pbGVzdG9uZShiYXNlLCAnTTAwMScpO1xuXG4gICAgICAvLyBRdWV1ZSBvcmRlciBzaG91bGQgbm8gbG9uZ2VyIGluY2x1ZGUgTTAwMVxuICAgICAgY29uc3QgcXVldWVDb250ZW50ID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocXVldWVQYXRoLCAndXRmLTgnKSk7XG4gICAgICBhc3NlcnQub2soIXF1ZXVlQ29udGVudC5vcmRlci5pbmNsdWRlcygnTTAwMScpLCAnTTAwMSByZW1vdmVkIGZyb20gcXVldWUgb3JkZXInKTtcbiAgICAgIGFzc2VydC5vayhxdWV1ZUNvbnRlbnQub3JkZXIuaW5jbHVkZXMoJ00wMDInKSwgJ00wMDIgc3RpbGwgaW4gcXVldWUgb3JkZXInKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG59KTtcblxudGVzdCgnZGlzY2FyZE1pbGVzdG9uZSByZW1vdmVzIERCIHJvd3MsIHdvcmt0cmVlLCBhbmQgbWlsZXN0b25lIGJyYW5jaCcsICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgY3JlYXRlTWlsZXN0b25lKGJhc2UsICdNMDAxJywgeyB3aXRoUm9hZG1hcDogdHJ1ZSB9KTtcbiAgICAgIGluaXRHaXRSZXBvKGJhc2UpO1xuICAgICAgY2xlYXJDYWNoZXMoKTtcblxuICAgICAgYXNzZXJ0Lm9rKG9wZW5EYXRhYmFzZShqb2luKGJhc2UsICcuZ3NkJywgJ2dzZC5kYicpKSwgJ2RhdGFiYXNlIG9wZW5zJyk7XG4gICAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogJ00wMDEnLCB0aXRsZTogJ0Rpc2NhcmQgbWUnLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuICAgICAgaW5zZXJ0U2xpY2UoeyBtaWxlc3RvbmVJZDogJ00wMDEnLCBpZDogJ1MwMScsIHRpdGxlOiAnT25seSBzbGljZScsIHN0YXR1czogJ3BlbmRpbmcnIH0pO1xuICAgICAgaW5zZXJ0VGFzayh7IG1pbGVzdG9uZUlkOiAnTTAwMScsIHNsaWNlSWQ6ICdTMDEnLCBpZDogJ1QwMScsIHRpdGxlOiAnT25seSB0YXNrJywgc3RhdHVzOiAncGVuZGluZycgfSk7XG5cbiAgICAgIGNvbnN0IHd0ID0gY3JlYXRlV29ya3RyZWUoYmFzZSwgJ00wMDEnLCB7IGJyYW5jaDogJ21pbGVzdG9uZS9NMDAxJyB9KTtcbiAgICAgIGFzc2VydC5vayhleGlzdHNTeW5jKHd0LnBhdGgpLCAnd29ya3RyZWUgZXhpc3RzIGJlZm9yZSBkaXNjYXJkJyk7XG4gICAgICBhc3NlcnQub2socnVuKCdnaXQgYnJhbmNoJywgYmFzZSkuaW5jbHVkZXMoJ21pbGVzdG9uZS9NMDAxJyksICdtaWxlc3RvbmUgYnJhbmNoIGV4aXN0cyBiZWZvcmUgZGlzY2FyZCcpO1xuICAgICAgYXNzZXJ0Lm9rKGdldE1pbGVzdG9uZSgnTTAwMScpLCAnbWlsZXN0b25lIGV4aXN0cyBpbiBEQiBiZWZvcmUgZGlzY2FyZCcpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGdldE1pbGVzdG9uZVNsaWNlcygnTTAwMScpLmxlbmd0aCwgMSwgJ3NsaWNlIGV4aXN0cyBpbiBEQiBiZWZvcmUgZGlzY2FyZCcpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGdldFNsaWNlVGFza3MoJ00wMDEnLCAnUzAxJykubGVuZ3RoLCAxLCAndGFzayBleGlzdHMgaW4gREIgYmVmb3JlIGRpc2NhcmQnKTtcblxuICAgICAgY29uc3Qgc3VjY2VzcyA9IGRpc2NhcmRNaWxlc3RvbmUoYmFzZSwgJ00wMDEnKTtcbiAgICAgIGFzc2VydC5vayhzdWNjZXNzLCAnZGlzY2FyZE1pbGVzdG9uZSByZXR1cm5zIHRydWUnKTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKGdldE1pbGVzdG9uZSgnTTAwMScpLCBudWxsLCAnbWlsZXN0b25lIHJvdyByZW1vdmVkIGZyb20gREInKTtcbiAgICAgIGFzc2VydC5lcXVhbChnZXRNaWxlc3RvbmVTbGljZXMoJ00wMDEnKS5sZW5ndGgsIDAsICdzbGljZSByb3dzIHJlbW92ZWQgZnJvbSBEQicpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGdldFNsaWNlVGFza3MoJ00wMDEnLCAnUzAxJykubGVuZ3RoLCAwLCAndGFzayByb3dzIHJlbW92ZWQgZnJvbSBEQicpO1xuICAgICAgYXNzZXJ0Lm9rKCFleGlzdHNTeW5jKHd0LnBhdGgpLCAnd29ya3RyZWUgcmVtb3ZlZCBhZnRlciBkaXNjYXJkJyk7XG4gICAgICBhc3NlcnQub2soIXJ1bignZ2l0IGJyYW5jaCcsIGJhc2UpLmluY2x1ZGVzKCdtaWxlc3RvbmUvTTAwMScpLCAnbWlsZXN0b25lIGJyYW5jaCByZW1vdmVkIGFmdGVyIGRpc2NhcmQnKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG59KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCAxMjogQWxsIG1pbGVzdG9uZXMgcGFya2VkIFx1MjE5MiBubyBhY3RpdmUgbWlsZXN0b25lIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxudGVzdCgnQWxsIG1pbGVzdG9uZXMgcGFya2VkIFx1MjE5MiBubyBhY3RpdmUnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNyZWF0ZU1pbGVzdG9uZShiYXNlLCAnTTAwMScsIHsgd2l0aFJvYWRtYXA6IHRydWUgfSk7XG4gICAgICBjbGVhckNhY2hlcygpO1xuXG4gICAgICBwYXJrTWlsZXN0b25lKGJhc2UsICdNMDAxJywgJ1Rlc3RpbmcnKTtcblxuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUuYWN0aXZlTWlsZXN0b25lLCBudWxsLCAnbm8gYWN0aXZlIG1pbGVzdG9uZSB3aGVuIGFsbCBwYXJrZWQnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucGhhc2UsICdwcmUtcGxhbm5pbmcnLCAncGhhc2UgaXMgcHJlLXBsYW5uaW5nJyk7XG4gICAgICBhc3NlcnQub2soc3RhdGUucmVnaXN0cnkubGVuZ3RoID09PSAxLCAncmVnaXN0cnkgc3RpbGwgaGFzIDEgZW50cnknKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucmVnaXN0cnlbMF0/LnN0YXR1cywgJ3BhcmtlZCcsICdlbnRyeSBpcyBwYXJrZWQnKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG59KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCAxMzogUGFya2VkIG1pbGVzdG9uZSB3aXRob3V0IHJvYWRtYXAgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG50ZXN0KCdQYXJrIG1pbGVzdG9uZSB3aXRob3V0IHJvYWRtYXAnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNyZWF0ZU1pbGVzdG9uZShiYXNlLCAnTTAwMScpOyAvLyBObyByb2FkbWFwXG4gICAgICBjcmVhdGVNaWxlc3RvbmUoYmFzZSwgJ00wMDInLCB7IHdpdGhSb2FkbWFwOiB0cnVlIH0pO1xuICAgICAgY2xlYXJDYWNoZXMoKTtcblxuICAgICAgcGFya01pbGVzdG9uZShiYXNlLCAnTTAwMScsICdOb3QgcmVhZHkgeWV0Jyk7XG5cbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQsICdNMDAyJywgJ00wMDIgaXMgYWN0aXZlIHdoZW4gTTAwMSAobm8gcm9hZG1hcCkgaXMgcGFya2VkJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnJlZ2lzdHJ5LmZpbmQoZSA9PiBlLmlkID09PSAnTTAwMScpPy5zdGF0dXMsICdwYXJrZWQnLCAnTTAwMSBpcyBwYXJrZWQnKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG59KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCAxNDogUHJvZ3Jlc3MgY291bnRzIHdpdGggcGFya2VkIG1pbGVzdG9uZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbnRlc3QoJ1Byb2dyZXNzIGNvdW50cyB3aXRoIHBhcmtlZCcsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgY3JlYXRlTWlsZXN0b25lKGJhc2UsICdNMDAxJywgeyB3aXRoUm9hZG1hcDogdHJ1ZSwgd2l0aFN1bW1hcnk6IHRydWUgfSk7IC8vIGNvbXBsZXRlXG4gICAgICBjcmVhdGVNaWxlc3RvbmUoYmFzZSwgJ00wMDInLCB7IHdpdGhSb2FkbWFwOiB0cnVlIH0pOyAvLyB3aWxsIHBhcmtcbiAgICAgIGNyZWF0ZU1pbGVzdG9uZShiYXNlLCAnTTAwMycsIHsgd2l0aFJvYWRtYXA6IHRydWUgfSk7IC8vIHdpbGwgYmUgYWN0aXZlXG4gICAgICBjbGVhckNhY2hlcygpO1xuXG4gICAgICBwYXJrTWlsZXN0b25lKGJhc2UsICdNMDAyJywgJ1BhcmtlZCcpO1xuXG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5wcm9ncmVzcz8ubWlsZXN0b25lcy5kb25lLCAxLCAnMSBjb21wbGV0ZSBtaWxlc3RvbmUnKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucHJvZ3Jlc3M/Lm1pbGVzdG9uZXMudG90YWwsIDMsICczIHRvdGFsIG1pbGVzdG9uZXMgKGluY2x1ZGluZyBwYXJrZWQpJyk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQsICdNMDAzJywgJ00wMDMgaXMgYWN0aXZlJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxufSk7XG5cbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxVQUFVLFlBQVk7QUFDL0IsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxXQUFXLFFBQVEsZUFBZSxZQUFZLG9CQUFvQjtBQUN4RixTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsZ0JBQWdCO0FBRXpCLFNBQVMsYUFBYSxzQkFBc0IsNEJBQTRCO0FBQ3hFLFNBQVMsc0JBQXNCO0FBQy9CLFNBQVMsZUFBZSxpQkFBaUIsa0JBQWtCLFVBQVUsdUJBQXVCO0FB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
