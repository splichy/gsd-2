import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  getMilestoneSlices
} from "../gsd-db.js";
import { renderRoadmapContent } from "../workflow-projections.js";
function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), "gsd-2945-"));
  return join(dir, "test.db");
}
function cleanupDb(dbPath) {
  closeDatabase();
  try {
    const dir = join(dbPath, "..");
    rmSync(dir, { recursive: true, force: true });
  } catch {
  }
}
function createTempProject() {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-2945-project-"));
  mkdirSync(join(basePath, ".gsd", "milestones", "M001"), { recursive: true });
  return { basePath };
}
function makeMilestoneRow(overrides = {}) {
  return {
    id: "M001",
    title: "Test Milestone",
    vision: "Build a test milestone",
    status: "active",
    depends_on: [],
    created_at: (/* @__PURE__ */ new Date()).toISOString(),
    completed_at: null,
    success_criteria: ["SC1", "SC2"],
    key_risks: [],
    proof_strategy: [],
    verification_contract: "",
    verification_integration: "",
    verification_operational: "",
    verification_uat: "",
    definition_of_done: [],
    requirement_coverage: "",
    boundary_map_markdown: "",
    sequence: 0,
    ...overrides
  };
}
function makeSliceRow(id, overrides = {}) {
  return {
    id,
    milestone_id: "M001",
    title: `Slice ${id}`,
    goal: `Goal for ${id}`,
    demo: `Demo for ${id}`,
    risk: "medium",
    status: "pending",
    sequence: parseInt(id.replace("S", ""), 10) || 0,
    depends: [],
    created_at: (/* @__PURE__ */ new Date()).toISOString(),
    completed_at: null,
    full_summary_md: "",
    full_uat_md: "",
    success_criteria: "",
    proof_level: "",
    integration_closure: "",
    observability_impact: "",
    replan_triggered_at: null,
    is_sketch: 0,
    sketch_scope: "",
    ...overrides
  };
}
describe("#2945 Bug 1: ROADMAP table cell corruption by UAT content", () => {
  test("renderRoadmapContent does NOT inject full_uat_md into table rows when demo is empty", () => {
    const milestone = makeMilestoneRow();
    const longUatContent = `### Preconditions
- Database initialized
- Service running

### Steps
1. Open the application
2. Navigate to settings
3. Enable dark mode

### Expected
- Theme changes to dark
- All components update`;
    const slices = [
      makeSliceRow("S01", {
        status: "complete",
        demo: "",
        // empty demo
        full_uat_md: longUatContent
        // full UAT content in DB
      }),
      makeSliceRow("S02", {
        status: "pending",
        demo: "Advanced stuff works"
      })
    ];
    const content = renderRoadmapContent(milestone, slices);
    assert.ok(
      !content.includes("Preconditions"),
      "roadmap table row must not contain UAT preconditions"
    );
    assert.ok(
      !content.includes("Navigate to settings"),
      "roadmap table row must not contain UAT steps"
    );
    const lines = content.split("\n");
    const s01Row = lines.find((l) => l.includes("| S01 |"));
    assert.ok(s01Row, "S01 should appear as a table row");
    assert.ok(
      s01Row.length < 200,
      `S01 row should be under 200 chars, got ${s01Row.length}: ${s01Row.slice(0, 100)}...`
    );
    assert.ok(content.includes("| S02 |"), "S02 must still be visible in roadmap table");
  });
  test("renderRoadmapContent uses 'TBD' fallback when demo is empty, not full_uat_md", () => {
    const milestone = makeMilestoneRow();
    const slices = [
      makeSliceRow("S01", { demo: "", full_uat_md: "Long UAT content here" })
    ];
    const content = renderRoadmapContent(milestone, slices);
    assert.ok(
      content.includes("TBD"),
      "empty demo should fallback to 'TBD', not full_uat_md"
    );
    assert.ok(
      !content.includes("Long UAT content here"),
      "full_uat_md should never appear in roadmap table"
    );
  });
  test("renderRoadmapContent preserves demo field when present", () => {
    const milestone = makeMilestoneRow();
    const slices = [
      makeSliceRow("S01", { demo: "Basic functionality works", full_uat_md: "Full UAT" })
    ];
    const content = renderRoadmapContent(milestone, slices);
    assert.ok(
      content.includes("Basic functionality works"),
      "demo field should be used when present"
    );
    assert.ok(
      !content.includes("Full UAT"),
      "full_uat_md should not be used when demo is present"
    );
  });
});
describe("#2945 Bug 2: workflow-reconcile bypasses task validation for complete_slice", () => {
  let dbPath;
  beforeEach(() => {
    dbPath = tempDbPath();
    openDatabase(dbPath);
  });
  afterEach(() => {
    cleanupDb(dbPath);
  });
  test("replaySliceComplete must not mark slice done when tasks are pending", async () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001" });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete", title: "Done task" });
    insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", status: "pending", title: "Pending task" });
    const { replaySliceComplete } = await import("../workflow-reconcile.js");
    replaySliceComplete("M001", "S01", (/* @__PURE__ */ new Date()).toISOString());
    const slices = getMilestoneSlices("M001");
    const s01 = slices.find((s) => s.id === "S01");
    assert.ok(s01, "S01 should exist");
    assert.notStrictEqual(
      s01.status,
      "done",
      "replaySliceComplete must not mark slice as done when tasks are pending"
    );
    assert.notStrictEqual(
      s01.status,
      "complete",
      "replaySliceComplete must not mark slice as complete when tasks are pending"
    );
  });
  test("replaySliceComplete marks slice done when all tasks are complete", async () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001" });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete", title: "Done task" });
    insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", status: "done", title: "Also done" });
    const { replaySliceComplete } = await import("../workflow-reconcile.js");
    replaySliceComplete("M001", "S01", (/* @__PURE__ */ new Date()).toISOString());
    const slices = getMilestoneSlices("M001");
    const s01 = slices.find((s) => s.id === "S01");
    assert.ok(s01, "S01 should exist");
    assert.strictEqual(
      s01.status,
      "done",
      "replaySliceComplete should mark slice as done when all tasks are complete"
    );
  });
});
describe("#2945 Bug 3: mergeAndExit must teardown worktree after successful merge", () => {
  test("_mergeWorktreeMode tears down worktree directory after successful merge", async () => {
    const tmpBase = realpathSync(mkdtempSync(join(tmpdir(), "gsd-2945-bug3-")));
    const prevCwd = process.cwd();
    try {
      const git = (args) => {
        execFileSync("git", args, { cwd: tmpBase, stdio: "pipe" });
      };
      git(["init", "-b", "main"]);
      git(["config", "user.email", "test@test.com"]);
      git(["config", "user.name", "Test"]);
      writeFileSync(join(tmpBase, "README.md"), "# test\n");
      writeFileSync(join(tmpBase, ".gitignore"), ".gsd/worktrees/\n");
      mkdirSync(join(tmpBase, ".gsd"), { recursive: true });
      writeFileSync(
        join(tmpBase, ".gsd", "preferences.md"),
        "## Git\n- isolation: worktree\n"
      );
      git(["add", "."]);
      git(["commit", "-m", "init"]);
      git(["checkout", "-b", "milestone/M001"]);
      git(["checkout", "main"]);
      const wt = join(tmpBase, ".gsd", "worktrees", "M001");
      git(["worktree", "add", wt, "milestone/M001"]);
      mkdirSync(join(tmpBase, ".gsd", "milestones", "M001"), { recursive: true });
      writeFileSync(
        join(tmpBase, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
        "# M001\n- [x] S01: Slice one\n"
      );
      const { WorktreeStateProjection } = await import("../worktree-state-projection.js");
      const session = {
        basePath: wt,
        originalBasePath: tmpBase,
        isolationDegraded: false,
        gitService: {},
        milestoneStartShas: /* @__PURE__ */ new Map()
      };
      const deps = {
        mergeMilestoneToMain: () => ({ pushed: false, codeFilesChanged: true }),
        worktreeProjection: new WorktreeStateProjection(),
        gitServiceFactory: () => ({})
      };
      const { WorktreeLifecycle } = await import("../worktree-lifecycle.js");
      const lifecycle = new WorktreeLifecycle(session, deps);
      const ctx = { notify: () => {
      } };
      lifecycle.exitMilestone("M001", { merge: true }, ctx);
      assert.ok(
        !existsSync(wt),
        `teardownAutoWorktree must be called after successful merge \u2014 worktree directory at ${wt} should be removed`
      );
    } finally {
      try {
        process.chdir(prevCwd);
      } catch {
      }
      try {
        rmSync(tmpBase, { recursive: true, force: true });
      } catch {
      }
    }
  });
});
describe("#2945 Bug 4: validate-milestone must persist quality_gates records", () => {
  let dbPath;
  let basePath;
  beforeEach(() => {
    dbPath = tempDbPath();
    openDatabase(dbPath);
    const proj = createTempProject();
    basePath = proj.basePath;
  });
  afterEach(() => {
    cleanupDb(dbPath);
    try {
      rmSync(basePath, { recursive: true, force: true });
    } catch {
    }
  });
  test("handleValidateMilestone persists quality_gates records in DB", async () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001" });
    const { handleValidateMilestone } = await import("../tools/validate-milestone.js");
    const result = await handleValidateMilestone({
      milestoneId: "M001",
      verdict: "pass",
      remediationRound: 0,
      successCriteriaChecklist: "- [x] SC1 met\n- [x] SC2 met",
      sliceDeliveryAudit: "All slices delivered",
      crossSliceIntegration: "Integration verified",
      requirementCoverage: "100% coverage",
      verdictRationale: "All checks pass"
    }, basePath);
    assert.ok(!("error" in result), `handler should succeed, got: ${JSON.stringify(result)}`);
    const adapter = (await import("../gsd-db.js"))._getAdapter();
    const gates = adapter.prepare(
      "SELECT * FROM quality_gates WHERE milestone_id = 'M001'"
    ).all();
    assert.ok(
      gates.length > 0,
      `validate-milestone must persist quality_gates records in DB, found ${gates.length}`
    );
  });
  test("handleValidateMilestone records verdict correctly in quality_gates", async () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001" });
    const { handleValidateMilestone } = await import("../tools/validate-milestone.js");
    await handleValidateMilestone({
      milestoneId: "M001",
      verdict: "needs-remediation",
      remediationRound: 1,
      successCriteriaChecklist: "- [ ] SC1 not met",
      sliceDeliveryAudit: "S01 incomplete",
      crossSliceIntegration: "Not tested",
      requirementCoverage: "50% coverage",
      verdictRationale: "Needs work",
      remediationPlan: "Fix S01"
    }, basePath);
    const adapter = (await import("../gsd-db.js"))._getAdapter();
    const gates = adapter.prepare(
      "SELECT * FROM quality_gates WHERE milestone_id = 'M001'"
    ).all();
    assert.ok(gates.length > 0, "quality_gates records must exist");
    const withVerdict = gates.filter((g) => g["verdict"] && g["verdict"] !== "");
    assert.ok(
      withVerdict.length > 0,
      "at least one quality_gate should have a recorded verdict"
    );
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9zdGF0ZS1jb3JydXB0aW9uLTI5NDUudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBSZWdyZXNzaW9uIHRlc3RzIGZvciBpc3N1ZSAjMjk0NTogU3RhdGUgY29ycnVwdGlvbiBpbiBtaWxlc3RvbmUvc2xpY2UgY29tcGxldGlvbiB3b3JrZmxvdy5cbiAqXG4gKiBDb3ZlcnMgYWxsIDQgc3ViLWJ1Z3M6XG4gKiAgIEJ1ZyAxOiBST0FETUFQIGNvcnJ1cHRlZCBieSBpbmxpbmUgVUFUIGNvbnRlbnQgaW4gdGFibGUgcm93c1xuICogICBCdWcgMjogY29tcGxldGUtbWlsZXN0b25lIGV2ZW50IHJlcGxheSBieXBhc3NlcyB0YXNrIHZhbGlkYXRpb25cbiAqICAgQnVnIDM6IFdvcmt0cmVlIGRpcmVjdG9yeSBub3QgY2xlYW5lZCB1cCBhZnRlciBtZXJnZUFuZEV4aXRcbiAqICAgQnVnIDQ6IFF1YWxpdHkgZ2F0ZSByZWNvcmRzIG5vdCB3cml0dGVuIGJ5IHZhbGlkYXRlLW1pbGVzdG9uZVxuICovXG5cbmltcG9ydCB7IGRlc2NyaWJlLCB0ZXN0LCBiZWZvcmVFYWNoLCBhZnRlckVhY2ggfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBta2RpclN5bmMsIHJlYWRGaWxlU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jLCBleGlzdHNTeW5jLCByZWFscGF0aFN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBleGVjRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQge1xuICBvcGVuRGF0YWJhc2UsXG4gIGNsb3NlRGF0YWJhc2UsXG4gIGluc2VydE1pbGVzdG9uZSxcbiAgaW5zZXJ0U2xpY2UsXG4gIGluc2VydFRhc2ssXG4gIGdldE1pbGVzdG9uZVNsaWNlcyxcbiAgZ2V0U2xpY2VUYXNrcyxcbiAgZ2V0R2F0ZVJlc3VsdHMsXG59IGZyb20gXCIuLi9nc2QtZGIudHNcIjtcbmltcG9ydCB7IHJlbmRlclJvYWRtYXBDb250ZW50IH0gZnJvbSBcIi4uL3dvcmtmbG93LXByb2plY3Rpb25zLnRzXCI7XG5pbXBvcnQgdHlwZSB7IE1pbGVzdG9uZVJvdywgU2xpY2VSb3cgfSBmcm9tIFwiLi4vZ3NkLWRiLnRzXCI7XG5pbXBvcnQgdHlwZSB7IEF1dG9TZXNzaW9uIH0gZnJvbSBcIi4uL2F1dG8vc2Vzc2lvbi50c1wiO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRml4dHVyZSBoZWxwZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiB0ZW1wRGJQYXRoKCk6IHN0cmluZyB7XG4gIGNvbnN0IGRpciA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLTI5NDUtXCIpKTtcbiAgcmV0dXJuIGpvaW4oZGlyLCBcInRlc3QuZGJcIik7XG59XG5cbmZ1bmN0aW9uIGNsZWFudXBEYihkYlBhdGg6IHN0cmluZyk6IHZvaWQge1xuICBjbG9zZURhdGFiYXNlKCk7XG4gIHRyeSB7XG4gICAgY29uc3QgZGlyID0gam9pbihkYlBhdGgsIFwiLi5cIik7XG4gICAgcm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9IGNhdGNoIHtcbiAgICAvLyBiZXN0IGVmZm9ydFxuICB9XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZVRlbXBQcm9qZWN0KCk6IHsgYmFzZVBhdGg6IHN0cmluZyB9IHtcbiAgY29uc3QgYmFzZVBhdGggPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC0yOTQ1LXByb2plY3QtXCIpKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZVBhdGgsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgcmV0dXJuIHsgYmFzZVBhdGggfTtcbn1cblxuZnVuY3Rpb24gbWFrZU1pbGVzdG9uZVJvdyhvdmVycmlkZXM6IFBhcnRpYWw8TWlsZXN0b25lUm93PiA9IHt9KTogTWlsZXN0b25lUm93IHtcbiAgcmV0dXJuIHtcbiAgICBpZDogXCJNMDAxXCIsXG4gICAgdGl0bGU6IFwiVGVzdCBNaWxlc3RvbmVcIixcbiAgICB2aXNpb246IFwiQnVpbGQgYSB0ZXN0IG1pbGVzdG9uZVwiLFxuICAgIHN0YXR1czogXCJhY3RpdmVcIixcbiAgICBkZXBlbmRzX29uOiBbXSxcbiAgICBjcmVhdGVkX2F0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgY29tcGxldGVkX2F0OiBudWxsLFxuICAgIHN1Y2Nlc3NfY3JpdGVyaWE6IFtcIlNDMVwiLCBcIlNDMlwiXSxcbiAgICBrZXlfcmlza3M6IFtdLFxuICAgIHByb29mX3N0cmF0ZWd5OiBbXSxcbiAgICB2ZXJpZmljYXRpb25fY29udHJhY3Q6IFwiXCIsXG4gICAgdmVyaWZpY2F0aW9uX2ludGVncmF0aW9uOiBcIlwiLFxuICAgIHZlcmlmaWNhdGlvbl9vcGVyYXRpb25hbDogXCJcIixcbiAgICB2ZXJpZmljYXRpb25fdWF0OiBcIlwiLFxuICAgIGRlZmluaXRpb25fb2ZfZG9uZTogW10sXG4gICAgcmVxdWlyZW1lbnRfY292ZXJhZ2U6IFwiXCIsXG4gICAgYm91bmRhcnlfbWFwX21hcmtkb3duOiBcIlwiLFxuICAgIHNlcXVlbmNlOiAwLFxuICAgIC4uLm92ZXJyaWRlcyxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbWFrZVNsaWNlUm93KGlkOiBzdHJpbmcsIG92ZXJyaWRlczogUGFydGlhbDxTbGljZVJvdz4gPSB7fSk6IFNsaWNlUm93IHtcbiAgcmV0dXJuIHtcbiAgICBpZCxcbiAgICBtaWxlc3RvbmVfaWQ6IFwiTTAwMVwiLFxuICAgIHRpdGxlOiBgU2xpY2UgJHtpZH1gLFxuICAgIGdvYWw6IGBHb2FsIGZvciAke2lkfWAsXG4gICAgZGVtbzogYERlbW8gZm9yICR7aWR9YCxcbiAgICByaXNrOiBcIm1lZGl1bVwiLFxuICAgIHN0YXR1czogXCJwZW5kaW5nXCIsXG4gICAgc2VxdWVuY2U6IHBhcnNlSW50KGlkLnJlcGxhY2UoXCJTXCIsIFwiXCIpLCAxMCkgfHwgMCxcbiAgICBkZXBlbmRzOiBbXSxcbiAgICBjcmVhdGVkX2F0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgY29tcGxldGVkX2F0OiBudWxsLFxuICAgIGZ1bGxfc3VtbWFyeV9tZDogXCJcIixcbiAgICBmdWxsX3VhdF9tZDogXCJcIixcbiAgICBzdWNjZXNzX2NyaXRlcmlhOiBcIlwiLFxuICAgIHByb29mX2xldmVsOiBcIlwiLFxuICAgIGludGVncmF0aW9uX2Nsb3N1cmU6IFwiXCIsXG4gICAgb2JzZXJ2YWJpbGl0eV9pbXBhY3Q6IFwiXCIsXG4gICAgcmVwbGFuX3RyaWdnZXJlZF9hdDogbnVsbCxcbiAgICBpc19za2V0Y2g6IDAsXG4gICAgc2tldGNoX3Njb3BlOiBcIlwiLFxuICAgIC4uLm92ZXJyaWRlcyxcbiAgfTtcbn1cblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBCdWcgMTogUk9BRE1BUCBjb3JydXB0ZWQgYnkgaW5saW5lIFVBVCBjb250ZW50XG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuZGVzY3JpYmUoXCIjMjk0NSBCdWcgMTogUk9BRE1BUCB0YWJsZSBjZWxsIGNvcnJ1cHRpb24gYnkgVUFUIGNvbnRlbnRcIiwgKCkgPT4ge1xuXG4gIHRlc3QoXCJyZW5kZXJSb2FkbWFwQ29udGVudCBkb2VzIE5PVCBpbmplY3QgZnVsbF91YXRfbWQgaW50byB0YWJsZSByb3dzIHdoZW4gZGVtbyBpcyBlbXB0eVwiLCAoKSA9PiB7XG4gICAgY29uc3QgbWlsZXN0b25lID0gbWFrZU1pbGVzdG9uZVJvdygpO1xuXG4gICAgY29uc3QgbG9uZ1VhdENvbnRlbnQgPSBgIyMjIFByZWNvbmRpdGlvbnNcbi0gRGF0YWJhc2UgaW5pdGlhbGl6ZWRcbi0gU2VydmljZSBydW5uaW5nXG5cbiMjIyBTdGVwc1xuMS4gT3BlbiB0aGUgYXBwbGljYXRpb25cbjIuIE5hdmlnYXRlIHRvIHNldHRpbmdzXG4zLiBFbmFibGUgZGFyayBtb2RlXG5cbiMjIyBFeHBlY3RlZFxuLSBUaGVtZSBjaGFuZ2VzIHRvIGRhcmtcbi0gQWxsIGNvbXBvbmVudHMgdXBkYXRlYDtcblxuICAgIGNvbnN0IHNsaWNlczogU2xpY2VSb3dbXSA9IFtcbiAgICAgIG1ha2VTbGljZVJvdyhcIlMwMVwiLCB7XG4gICAgICAgIHN0YXR1czogXCJjb21wbGV0ZVwiLFxuICAgICAgICBkZW1vOiBcIlwiLCAgICAgICAgICAgICAgICAgICAgIC8vIGVtcHR5IGRlbW9cbiAgICAgICAgZnVsbF91YXRfbWQ6IGxvbmdVYXRDb250ZW50LCAgLy8gZnVsbCBVQVQgY29udGVudCBpbiBEQlxuICAgICAgfSksXG4gICAgICBtYWtlU2xpY2VSb3coXCJTMDJcIiwge1xuICAgICAgICBzdGF0dXM6IFwicGVuZGluZ1wiLFxuICAgICAgICBkZW1vOiBcIkFkdmFuY2VkIHN0dWZmIHdvcmtzXCIsXG4gICAgICB9KSxcbiAgICBdO1xuXG4gICAgY29uc3QgY29udGVudCA9IHJlbmRlclJvYWRtYXBDb250ZW50KG1pbGVzdG9uZSwgc2xpY2VzKTtcblxuICAgIC8vIFRoZSByb2FkbWFwIHRhYmxlIHJvdyBmb3IgUzAxIHNob3VsZCBOT1QgY29udGFpbiBVQVQgY29udGVudFxuICAgIGFzc2VydC5vayhcbiAgICAgICFjb250ZW50LmluY2x1ZGVzKFwiUHJlY29uZGl0aW9uc1wiKSxcbiAgICAgIFwicm9hZG1hcCB0YWJsZSByb3cgbXVzdCBub3QgY29udGFpbiBVQVQgcHJlY29uZGl0aW9uc1wiLFxuICAgICk7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgIWNvbnRlbnQuaW5jbHVkZXMoXCJOYXZpZ2F0ZSB0byBzZXR0aW5nc1wiKSxcbiAgICAgIFwicm9hZG1hcCB0YWJsZSByb3cgbXVzdCBub3QgY29udGFpbiBVQVQgc3RlcHNcIixcbiAgICApO1xuXG4gICAgLy8gRWFjaCB0YWJsZSByb3cgc2hvdWxkIGJlIGEgcmVhc29uYWJsZSBsZW5ndGggKHVuZGVyIDIwMCBjaGFycylcbiAgICBjb25zdCBsaW5lcyA9IGNvbnRlbnQuc3BsaXQoXCJcXG5cIik7XG4gICAgY29uc3QgczAxUm93ID0gbGluZXMuZmluZChsID0+IGwuaW5jbHVkZXMoXCJ8IFMwMSB8XCIpKTtcbiAgICBhc3NlcnQub2soczAxUm93LCBcIlMwMSBzaG91bGQgYXBwZWFyIGFzIGEgdGFibGUgcm93XCIpO1xuICAgIGFzc2VydC5vayhcbiAgICAgIHMwMVJvdyEubGVuZ3RoIDwgMjAwLFxuICAgICAgYFMwMSByb3cgc2hvdWxkIGJlIHVuZGVyIDIwMCBjaGFycywgZ290ICR7czAxUm93IS5sZW5ndGh9OiAke3MwMVJvdyEuc2xpY2UoMCwgMTAwKX0uLi5gLFxuICAgICk7XG5cbiAgICAvLyBTMDIgc2hvdWxkIHN0aWxsIGJlIHZpc2libGVcbiAgICBhc3NlcnQub2soY29udGVudC5pbmNsdWRlcyhcInwgUzAyIHxcIiksIFwiUzAyIG11c3Qgc3RpbGwgYmUgdmlzaWJsZSBpbiByb2FkbWFwIHRhYmxlXCIpO1xuICB9KTtcblxuICB0ZXN0KFwicmVuZGVyUm9hZG1hcENvbnRlbnQgdXNlcyAnVEJEJyBmYWxsYmFjayB3aGVuIGRlbW8gaXMgZW1wdHksIG5vdCBmdWxsX3VhdF9tZFwiLCAoKSA9PiB7XG4gICAgY29uc3QgbWlsZXN0b25lID0gbWFrZU1pbGVzdG9uZVJvdygpO1xuICAgIGNvbnN0IHNsaWNlczogU2xpY2VSb3dbXSA9IFtcbiAgICAgIG1ha2VTbGljZVJvdyhcIlMwMVwiLCB7IGRlbW86IFwiXCIsIGZ1bGxfdWF0X21kOiBcIkxvbmcgVUFUIGNvbnRlbnQgaGVyZVwiIH0pLFxuICAgIF07XG5cbiAgICBjb25zdCBjb250ZW50ID0gcmVuZGVyUm9hZG1hcENvbnRlbnQobWlsZXN0b25lLCBzbGljZXMpO1xuICAgIGFzc2VydC5vayhcbiAgICAgIGNvbnRlbnQuaW5jbHVkZXMoXCJUQkRcIiksXG4gICAgICBcImVtcHR5IGRlbW8gc2hvdWxkIGZhbGxiYWNrIHRvICdUQkQnLCBub3QgZnVsbF91YXRfbWRcIixcbiAgICApO1xuICAgIGFzc2VydC5vayhcbiAgICAgICFjb250ZW50LmluY2x1ZGVzKFwiTG9uZyBVQVQgY29udGVudCBoZXJlXCIpLFxuICAgICAgXCJmdWxsX3VhdF9tZCBzaG91bGQgbmV2ZXIgYXBwZWFyIGluIHJvYWRtYXAgdGFibGVcIixcbiAgICApO1xuICB9KTtcblxuICB0ZXN0KFwicmVuZGVyUm9hZG1hcENvbnRlbnQgcHJlc2VydmVzIGRlbW8gZmllbGQgd2hlbiBwcmVzZW50XCIsICgpID0+IHtcbiAgICBjb25zdCBtaWxlc3RvbmUgPSBtYWtlTWlsZXN0b25lUm93KCk7XG4gICAgY29uc3Qgc2xpY2VzOiBTbGljZVJvd1tdID0gW1xuICAgICAgbWFrZVNsaWNlUm93KFwiUzAxXCIsIHsgZGVtbzogXCJCYXNpYyBmdW5jdGlvbmFsaXR5IHdvcmtzXCIsIGZ1bGxfdWF0X21kOiBcIkZ1bGwgVUFUXCIgfSksXG4gICAgXTtcblxuICAgIGNvbnN0IGNvbnRlbnQgPSByZW5kZXJSb2FkbWFwQ29udGVudChtaWxlc3RvbmUsIHNsaWNlcyk7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgY29udGVudC5pbmNsdWRlcyhcIkJhc2ljIGZ1bmN0aW9uYWxpdHkgd29ya3NcIiksXG4gICAgICBcImRlbW8gZmllbGQgc2hvdWxkIGJlIHVzZWQgd2hlbiBwcmVzZW50XCIsXG4gICAgKTtcbiAgICBhc3NlcnQub2soXG4gICAgICAhY29udGVudC5pbmNsdWRlcyhcIkZ1bGwgVUFUXCIpLFxuICAgICAgXCJmdWxsX3VhdF9tZCBzaG91bGQgbm90IGJlIHVzZWQgd2hlbiBkZW1vIGlzIHByZXNlbnRcIixcbiAgICApO1xuICB9KTtcbn0pO1xuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIEJ1ZyAyOiBjb21wbGV0ZS1taWxlc3RvbmUgZXZlbnQgcmVwbGF5IGJ5cGFzc2VzIHRhc2sgdmFsaWRhdGlvblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbmRlc2NyaWJlKFwiIzI5NDUgQnVnIDI6IHdvcmtmbG93LXJlY29uY2lsZSBieXBhc3NlcyB0YXNrIHZhbGlkYXRpb24gZm9yIGNvbXBsZXRlX3NsaWNlXCIsICgpID0+IHtcbiAgbGV0IGRiUGF0aDogc3RyaW5nO1xuXG4gIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgIGRiUGF0aCA9IHRlbXBEYlBhdGgoKTtcbiAgICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcbiAgfSk7XG5cbiAgYWZ0ZXJFYWNoKCgpID0+IHtcbiAgICBjbGVhbnVwRGIoZGJQYXRoKTtcbiAgfSk7XG5cbiAgdGVzdChcInJlcGxheVNsaWNlQ29tcGxldGUgbXVzdCBub3QgbWFyayBzbGljZSBkb25lIHdoZW4gdGFza3MgYXJlIHBlbmRpbmdcIiwgYXN5bmMgKCkgPT4ge1xuICAgIC8vIFNldCB1cDogTTAwMSB3aXRoIFMwMSB0aGF0IGhhcyAyIHRhc2tzLCBvbmUgcGVuZGluZ1xuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiB9KTtcbiAgICBpbnNlcnRTbGljZSh7IGlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIgfSk7XG4gICAgaW5zZXJ0VGFzayh7IGlkOiBcIlQwMVwiLCBzbGljZUlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHN0YXR1czogXCJjb21wbGV0ZVwiLCB0aXRsZTogXCJEb25lIHRhc2tcIiB9KTtcbiAgICBpbnNlcnRUYXNrKHsgaWQ6IFwiVDAyXCIsIHNsaWNlSWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgc3RhdHVzOiBcInBlbmRpbmdcIiwgdGl0bGU6IFwiUGVuZGluZyB0YXNrXCIgfSk7XG5cbiAgICAvLyBJbXBvcnQgYW5kIGNhbGwgcmVwbGF5U2xpY2VDb21wbGV0ZSBkaXJlY3RseVxuICAgIGNvbnN0IHsgcmVwbGF5U2xpY2VDb21wbGV0ZSB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vd29ya2Zsb3ctcmVjb25jaWxlLnRzXCIpO1xuICAgIHJlcGxheVNsaWNlQ29tcGxldGUoXCJNMDAxXCIsIFwiUzAxXCIsIG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSk7XG5cbiAgICAvLyBUaGUgc2xpY2Ugc2hvdWxkIE5PVCBiZSBtYXJrZWQgZG9uZSBiZWNhdXNlIFQwMiBpcyBzdGlsbCBwZW5kaW5nXG4gICAgY29uc3Qgc2xpY2VzID0gZ2V0TWlsZXN0b25lU2xpY2VzKFwiTTAwMVwiKTtcbiAgICBjb25zdCBzMDEgPSBzbGljZXMuZmluZChzID0+IHMuaWQgPT09IFwiUzAxXCIpO1xuICAgIGFzc2VydC5vayhzMDEsIFwiUzAxIHNob3VsZCBleGlzdFwiKTtcbiAgICBhc3NlcnQubm90U3RyaWN0RXF1YWwoXG4gICAgICBzMDEhLnN0YXR1cyxcbiAgICAgIFwiZG9uZVwiLFxuICAgICAgXCJyZXBsYXlTbGljZUNvbXBsZXRlIG11c3Qgbm90IG1hcmsgc2xpY2UgYXMgZG9uZSB3aGVuIHRhc2tzIGFyZSBwZW5kaW5nXCIsXG4gICAgKTtcbiAgICBhc3NlcnQubm90U3RyaWN0RXF1YWwoXG4gICAgICBzMDEhLnN0YXR1cyxcbiAgICAgIFwiY29tcGxldGVcIixcbiAgICAgIFwicmVwbGF5U2xpY2VDb21wbGV0ZSBtdXN0IG5vdCBtYXJrIHNsaWNlIGFzIGNvbXBsZXRlIHdoZW4gdGFza3MgYXJlIHBlbmRpbmdcIixcbiAgICApO1xuICB9KTtcblxuICB0ZXN0KFwicmVwbGF5U2xpY2VDb21wbGV0ZSBtYXJrcyBzbGljZSBkb25lIHdoZW4gYWxsIHRhc2tzIGFyZSBjb21wbGV0ZVwiLCBhc3luYyAoKSA9PiB7XG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiIH0pO1xuICAgIGluc2VydFNsaWNlKHsgaWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiB9KTtcbiAgICBpbnNlcnRUYXNrKHsgaWQ6IFwiVDAxXCIsIHNsaWNlSWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgc3RhdHVzOiBcImNvbXBsZXRlXCIsIHRpdGxlOiBcIkRvbmUgdGFza1wiIH0pO1xuICAgIGluc2VydFRhc2soeyBpZDogXCJUMDJcIiwgc2xpY2VJZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCBzdGF0dXM6IFwiZG9uZVwiLCB0aXRsZTogXCJBbHNvIGRvbmVcIiB9KTtcblxuICAgIGNvbnN0IHsgcmVwbGF5U2xpY2VDb21wbGV0ZSB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vd29ya2Zsb3ctcmVjb25jaWxlLnRzXCIpO1xuICAgIHJlcGxheVNsaWNlQ29tcGxldGUoXCJNMDAxXCIsIFwiUzAxXCIsIG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSk7XG5cbiAgICBjb25zdCBzbGljZXMgPSBnZXRNaWxlc3RvbmVTbGljZXMoXCJNMDAxXCIpO1xuICAgIGNvbnN0IHMwMSA9IHNsaWNlcy5maW5kKHMgPT4gcy5pZCA9PT0gXCJTMDFcIik7XG4gICAgYXNzZXJ0Lm9rKHMwMSwgXCJTMDEgc2hvdWxkIGV4aXN0XCIpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChcbiAgICAgIHMwMSEuc3RhdHVzLFxuICAgICAgXCJkb25lXCIsXG4gICAgICBcInJlcGxheVNsaWNlQ29tcGxldGUgc2hvdWxkIG1hcmsgc2xpY2UgYXMgZG9uZSB3aGVuIGFsbCB0YXNrcyBhcmUgY29tcGxldGVcIixcbiAgICApO1xuICB9KTtcbn0pO1xuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIEJ1ZyAzOiBXb3JrdHJlZSBkaXJlY3Rvcnkgbm90IGNsZWFuZWQgdXAgYWZ0ZXIgbWVyZ2VBbmRFeGl0XG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuZGVzY3JpYmUoXCIjMjk0NSBCdWcgMzogbWVyZ2VBbmRFeGl0IG11c3QgdGVhcmRvd24gd29ya3RyZWUgYWZ0ZXIgc3VjY2Vzc2Z1bCBtZXJnZVwiLCAoKSA9PiB7XG5cbiAgdGVzdChcIl9tZXJnZVdvcmt0cmVlTW9kZSB0ZWFycyBkb3duIHdvcmt0cmVlIGRpcmVjdG9yeSBhZnRlciBzdWNjZXNzZnVsIG1lcmdlXCIsIGFzeW5jICgpID0+IHtcbiAgICAvLyBBRFItMDE2IHBoYXNlIDIgLyBDMiAoIzU2MjUpOiB0aGUgd29ya3RyZWUtbWFuYWdlciBwcmltaXRpdmVzXG4gICAgLy8gaW5jbHVkaW5nIGB0ZWFyZG93bkF1dG9Xb3JrdHJlZWAgYXJlIGlubGluZWQgaW50byBMaWZlY3ljbGUsIHNvXG4gICAgLy8gdGhpcyB0ZXN0IGNhbiBubyBsb25nZXIgYXNzZXJ0IHZpYSBhIGRlcHMgbW9jay4gUmV3cml0dGVuIHRvIHVzZVxuICAgIC8vIGEgcmVhbCBnaXQgZml4dHVyZSBhbmQgdmVyaWZ5IHRoZSB3b3JrdHJlZSBkaXJlY3RvcnkgaXMgcmVtb3ZlZFxuICAgIC8vIGZyb20gZGlzayBhZnRlciB0aGUgbWVyZ2UuXG4gICAgY29uc3QgdG1wQmFzZSA9IHJlYWxwYXRoU3luYyhta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC0yOTQ1LWJ1ZzMtXCIpKSk7XG4gICAgLy8gQURSLTAxNiBwaGFzZSAzICgjNTY5Myk6IExpZmVjeWNsZS5yZXN0b3JlVG9Qcm9qZWN0Um9vdCBub3cgY2hkaXJzIHRvXG4gICAgLy8gcy5vcmlnaW5hbEJhc2VQYXRoLiBTYXZlIGN3ZCBiZWZvcmUgdGhlIHRlc3Qgc28gd2UgY2FuIHJlc3RvcmUgaXRcbiAgICAvLyBiZWZvcmUgcm1TeW5jIHJlbW92ZXMgdG1wQmFzZSBcdTIwMTQgb3RoZXJ3aXNlIHRoZSBuZXh0IHRlc3QgaW4gdGhpcyBmaWxlXG4gICAgLy8gaW5oZXJpdHMgYSBkZWxldGVkIGN3ZCBhbmQgcHJvY2Vzcy5jd2QoKSB0aHJvd3MgRU5PRU5UICh1dl9jd2QpLlxuICAgIGNvbnN0IHByZXZDd2QgPSBwcm9jZXNzLmN3ZCgpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBnaXQgPSAoYXJnczogc3RyaW5nW10pOiB2b2lkID0+IHtcbiAgICAgICAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIGFyZ3MsIHsgY3dkOiB0bXBCYXNlLCBzdGRpbzogXCJwaXBlXCIgfSk7XG4gICAgICB9O1xuICAgICAgZ2l0KFtcImluaXRcIiwgXCItYlwiLCBcIm1haW5cIl0pO1xuICAgICAgZ2l0KFtcImNvbmZpZ1wiLCBcInVzZXIuZW1haWxcIiwgXCJ0ZXN0QHRlc3QuY29tXCJdKTtcbiAgICAgIGdpdChbXCJjb25maWdcIiwgXCJ1c2VyLm5hbWVcIiwgXCJUZXN0XCJdKTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbih0bXBCYXNlLCBcIlJFQURNRS5tZFwiKSwgXCIjIHRlc3RcXG5cIik7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4odG1wQmFzZSwgXCIuZ2l0aWdub3JlXCIpLCBcIi5nc2Qvd29ya3RyZWVzL1xcblwiKTtcbiAgICAgIG1rZGlyU3luYyhqb2luKHRtcEJhc2UsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgICBqb2luKHRtcEJhc2UsIFwiLmdzZFwiLCBcInByZWZlcmVuY2VzLm1kXCIpLFxuICAgICAgICBcIiMjIEdpdFxcbi0gaXNvbGF0aW9uOiB3b3JrdHJlZVxcblwiLFxuICAgICAgKTtcbiAgICAgIGdpdChbXCJhZGRcIiwgXCIuXCJdKTtcbiAgICAgIGdpdChbXCJjb21taXRcIiwgXCItbVwiLCBcImluaXRcIl0pO1xuICAgICAgZ2l0KFtcImNoZWNrb3V0XCIsIFwiLWJcIiwgXCJtaWxlc3RvbmUvTTAwMVwiXSk7XG4gICAgICBnaXQoW1wiY2hlY2tvdXRcIiwgXCJtYWluXCJdKTtcbiAgICAgIGNvbnN0IHd0ID0gam9pbih0bXBCYXNlLCBcIi5nc2RcIiwgXCJ3b3JrdHJlZXNcIiwgXCJNMDAxXCIpO1xuICAgICAgZ2l0KFtcIndvcmt0cmVlXCIsIFwiYWRkXCIsIHd0LCBcIm1pbGVzdG9uZS9NMDAxXCJdKTtcbiAgICAgIG1rZGlyU3luYyhqb2luKHRtcEJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICAgIGpvaW4odG1wQmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJNMDAxLVJPQURNQVAubWRcIiksXG4gICAgICAgIFwiIyBNMDAxXFxuLSBbeF0gUzAxOiBTbGljZSBvbmVcXG5cIixcbiAgICAgICk7XG5cbiAgICAgIGNvbnN0IHsgV29ya3RyZWVTdGF0ZVByb2plY3Rpb24gfSA9IGF3YWl0IGltcG9ydChcIi4uL3dvcmt0cmVlLXN0YXRlLXByb2plY3Rpb24udHNcIik7XG4gICAgICBjb25zdCBzZXNzaW9uID0ge1xuICAgICAgICBiYXNlUGF0aDogd3QsXG4gICAgICAgIG9yaWdpbmFsQmFzZVBhdGg6IHRtcEJhc2UsXG4gICAgICAgIGlzb2xhdGlvbkRlZ3JhZGVkOiBmYWxzZSxcbiAgICAgICAgZ2l0U2VydmljZToge30gYXMgdW5rbm93bixcbiAgICAgICAgbWlsZXN0b25lU3RhcnRTaGFzOiBuZXcgTWFwKCksXG4gICAgICB9IGFzIHVua25vd24gYXMgQXV0b1Nlc3Npb247XG5cbiAgICAgIGNvbnN0IGRlcHMgPSB7XG4gICAgICAgIG1lcmdlTWlsZXN0b25lVG9NYWluOiAoKSA9PiAoeyBwdXNoZWQ6IGZhbHNlLCBjb2RlRmlsZXNDaGFuZ2VkOiB0cnVlIH0pLFxuICAgICAgICB3b3JrdHJlZVByb2plY3Rpb246IG5ldyBXb3JrdHJlZVN0YXRlUHJvamVjdGlvbigpLFxuICAgICAgICBnaXRTZXJ2aWNlRmFjdG9yeTogKCkgPT4gKHt9KSBhcyB1bmtub3duIGFzIFJldHVyblR5cGU8XG4gICAgICAgICAgaW1wb3J0KFwiLi4vd29ya3RyZWUtbGlmZWN5Y2xlLmpzXCIpLldvcmt0cmVlTGlmZWN5Y2xlRGVwc1tcImdpdFNlcnZpY2VGYWN0b3J5XCJdXG4gICAgICAgID4sXG4gICAgICB9O1xuXG4gICAgICBjb25zdCB7IFdvcmt0cmVlTGlmZWN5Y2xlIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi93b3JrdHJlZS1saWZlY3ljbGUudHNcIik7XG4gICAgICBjb25zdCBsaWZlY3ljbGUgPSBuZXcgV29ya3RyZWVMaWZlY3ljbGUoc2Vzc2lvbiwgZGVwcyBhcyBuZXZlcik7XG5cbiAgICAgIGNvbnN0IGN0eCA9IHsgbm90aWZ5OiAoKSA9PiB7fSB9O1xuICAgICAgbGlmZWN5Y2xlLmV4aXRNaWxlc3RvbmUoXCJNMDAxXCIsIHsgbWVyZ2U6IHRydWUgfSwgY3R4KTtcblxuICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICAhZXhpc3RzU3luYyh3dCksXG4gICAgICAgIGB0ZWFyZG93bkF1dG9Xb3JrdHJlZSBtdXN0IGJlIGNhbGxlZCBhZnRlciBzdWNjZXNzZnVsIG1lcmdlIFx1MjAxNCB3b3JrdHJlZSBkaXJlY3RvcnkgYXQgJHt3dH0gc2hvdWxkIGJlIHJlbW92ZWRgLFxuICAgICAgKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgdHJ5IHsgcHJvY2Vzcy5jaGRpcihwcmV2Q3dkKTsgfSBjYXRjaCB7IC8qIG5vb3AgKi8gfVxuICAgICAgdHJ5IHsgcm1TeW5jKHRtcEJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTsgfSBjYXRjaCB7IC8qIG5vb3AgKi8gfVxuICAgIH1cbiAgfSk7XG59KTtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBCdWcgNDogUXVhbGl0eSBnYXRlIHJlY29yZHMgbm90IHdyaXR0ZW4gYnkgdmFsaWRhdGUtbWlsZXN0b25lXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuZGVzY3JpYmUoXCIjMjk0NSBCdWcgNDogdmFsaWRhdGUtbWlsZXN0b25lIG11c3QgcGVyc2lzdCBxdWFsaXR5X2dhdGVzIHJlY29yZHNcIiwgKCkgPT4ge1xuICBsZXQgZGJQYXRoOiBzdHJpbmc7XG4gIGxldCBiYXNlUGF0aDogc3RyaW5nO1xuXG4gIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgIGRiUGF0aCA9IHRlbXBEYlBhdGgoKTtcbiAgICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcbiAgICBjb25zdCBwcm9qID0gY3JlYXRlVGVtcFByb2plY3QoKTtcbiAgICBiYXNlUGF0aCA9IHByb2ouYmFzZVBhdGg7XG4gIH0pO1xuXG4gIGFmdGVyRWFjaCgoKSA9PiB7XG4gICAgY2xlYW51cERiKGRiUGF0aCk7XG4gICAgdHJ5IHsgcm1TeW5jKGJhc2VQYXRoLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0gY2F0Y2gge31cbiAgfSk7XG5cbiAgdGVzdChcImhhbmRsZVZhbGlkYXRlTWlsZXN0b25lIHBlcnNpc3RzIHF1YWxpdHlfZ2F0ZXMgcmVjb3JkcyBpbiBEQlwiLCBhc3luYyAoKSA9PiB7XG4gICAgLy8gU2V0IHVwIG1pbGVzdG9uZSB3aXRoIHNsaWNlc1xuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiB9KTtcbiAgICBpbnNlcnRTbGljZSh7IGlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIgfSk7XG5cbiAgICBjb25zdCB7IGhhbmRsZVZhbGlkYXRlTWlsZXN0b25lIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi90b29scy92YWxpZGF0ZS1taWxlc3RvbmUudHNcIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVWYWxpZGF0ZU1pbGVzdG9uZSh7XG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICB2ZXJkaWN0OiBcInBhc3NcIixcbiAgICAgIHJlbWVkaWF0aW9uUm91bmQ6IDAsXG4gICAgICBzdWNjZXNzQ3JpdGVyaWFDaGVja2xpc3Q6IFwiLSBbeF0gU0MxIG1ldFxcbi0gW3hdIFNDMiBtZXRcIixcbiAgICAgIHNsaWNlRGVsaXZlcnlBdWRpdDogXCJBbGwgc2xpY2VzIGRlbGl2ZXJlZFwiLFxuICAgICAgY3Jvc3NTbGljZUludGVncmF0aW9uOiBcIkludGVncmF0aW9uIHZlcmlmaWVkXCIsXG4gICAgICByZXF1aXJlbWVudENvdmVyYWdlOiBcIjEwMCUgY292ZXJhZ2VcIixcbiAgICAgIHZlcmRpY3RSYXRpb25hbGU6IFwiQWxsIGNoZWNrcyBwYXNzXCIsXG4gICAgfSwgYmFzZVBhdGgpO1xuXG4gICAgYXNzZXJ0Lm9rKCEoXCJlcnJvclwiIGluIHJlc3VsdCksIGBoYW5kbGVyIHNob3VsZCBzdWNjZWVkLCBnb3Q6ICR7SlNPTi5zdHJpbmdpZnkocmVzdWx0KX1gKTtcblxuICAgIC8vIFF1YWxpdHkgZ2F0ZSByZWNvcmRzIHNob3VsZCBleGlzdCBpbiBEQiBmb3IgdGhpcyBtaWxlc3RvbmVcbiAgICAvLyBVc2UgYSB3aWxkY2FyZCBzbGljZV9pZCBzaW5jZSBtaWxlc3RvbmUtbGV2ZWwgZ2F0ZXMgdXNlIGEgc2VudGluZWxcbiAgICBjb25zdCBhZGFwdGVyID0gKGF3YWl0IGltcG9ydChcIi4uL2dzZC1kYi50c1wiKSkuX2dldEFkYXB0ZXIoKSE7XG4gICAgY29uc3QgZ2F0ZXMgPSBhZGFwdGVyLnByZXBhcmUoXG4gICAgICBcIlNFTEVDVCAqIEZST00gcXVhbGl0eV9nYXRlcyBXSEVSRSBtaWxlc3RvbmVfaWQgPSAnTTAwMSdcIlxuICAgICkuYWxsKCk7XG5cbiAgICBhc3NlcnQub2soXG4gICAgICBnYXRlcy5sZW5ndGggPiAwLFxuICAgICAgYHZhbGlkYXRlLW1pbGVzdG9uZSBtdXN0IHBlcnNpc3QgcXVhbGl0eV9nYXRlcyByZWNvcmRzIGluIERCLCBmb3VuZCAke2dhdGVzLmxlbmd0aH1gLFxuICAgICk7XG4gIH0pO1xuXG4gIHRlc3QoXCJoYW5kbGVWYWxpZGF0ZU1pbGVzdG9uZSByZWNvcmRzIHZlcmRpY3QgY29ycmVjdGx5IGluIHF1YWxpdHlfZ2F0ZXNcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiB9KTtcbiAgICBpbnNlcnRTbGljZSh7IGlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIgfSk7XG5cbiAgICBjb25zdCB7IGhhbmRsZVZhbGlkYXRlTWlsZXN0b25lIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi90b29scy92YWxpZGF0ZS1taWxlc3RvbmUudHNcIik7XG5cbiAgICBhd2FpdCBoYW5kbGVWYWxpZGF0ZU1pbGVzdG9uZSh7XG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICB2ZXJkaWN0OiBcIm5lZWRzLXJlbWVkaWF0aW9uXCIsXG4gICAgICByZW1lZGlhdGlvblJvdW5kOiAxLFxuICAgICAgc3VjY2Vzc0NyaXRlcmlhQ2hlY2tsaXN0OiBcIi0gWyBdIFNDMSBub3QgbWV0XCIsXG4gICAgICBzbGljZURlbGl2ZXJ5QXVkaXQ6IFwiUzAxIGluY29tcGxldGVcIixcbiAgICAgIGNyb3NzU2xpY2VJbnRlZ3JhdGlvbjogXCJOb3QgdGVzdGVkXCIsXG4gICAgICByZXF1aXJlbWVudENvdmVyYWdlOiBcIjUwJSBjb3ZlcmFnZVwiLFxuICAgICAgdmVyZGljdFJhdGlvbmFsZTogXCJOZWVkcyB3b3JrXCIsXG4gICAgICByZW1lZGlhdGlvblBsYW46IFwiRml4IFMwMVwiLFxuICAgIH0sIGJhc2VQYXRoKTtcblxuICAgIGNvbnN0IGFkYXB0ZXIgPSAoYXdhaXQgaW1wb3J0KFwiLi4vZ3NkLWRiLnRzXCIpKS5fZ2V0QWRhcHRlcigpITtcbiAgICBjb25zdCBnYXRlcyA9IGFkYXB0ZXIucHJlcGFyZShcbiAgICAgIFwiU0VMRUNUICogRlJPTSBxdWFsaXR5X2dhdGVzIFdIRVJFIG1pbGVzdG9uZV9pZCA9ICdNMDAxJ1wiXG4gICAgKS5hbGwoKTtcblxuICAgIGFzc2VydC5vayhnYXRlcy5sZW5ndGggPiAwLCBcInF1YWxpdHlfZ2F0ZXMgcmVjb3JkcyBtdXN0IGV4aXN0XCIpO1xuXG4gICAgLy8gQXQgbGVhc3Qgb25lIGdhdGUgc2hvdWxkIGhhdmUgYSBub24tZW1wdHkgdmVyZGljdFxuICAgIGNvbnN0IHdpdGhWZXJkaWN0ID0gZ2F0ZXMuZmlsdGVyKChnOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4gZ1tcInZlcmRpY3RcIl0gJiYgZ1tcInZlcmRpY3RcIl0gIT09IFwiXCIpO1xuICAgIGFzc2VydC5vayhcbiAgICAgIHdpdGhWZXJkaWN0Lmxlbmd0aCA+IDAsXG4gICAgICBcImF0IGxlYXN0IG9uZSBxdWFsaXR5X2dhdGUgc2hvdWxkIGhhdmUgYSByZWNvcmRlZCB2ZXJkaWN0XCIsXG4gICAgKTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQVVBLFNBQVMsVUFBVSxNQUFNLFlBQVksaUJBQWlCO0FBQ3RELE9BQU8sWUFBWTtBQUNuQixTQUFTLGFBQWEsV0FBeUIsUUFBUSxlQUFlLFlBQVksb0JBQW9CO0FBQ3RHLFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFDdkIsU0FBUyxvQkFBb0I7QUFDN0I7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUdLO0FBQ1AsU0FBUyw0QkFBNEI7QUFNckMsU0FBUyxhQUFxQjtBQUM1QixRQUFN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
