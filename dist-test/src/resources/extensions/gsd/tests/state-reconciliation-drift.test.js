import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  getMilestone,
  getSlice,
  getSliceTasks,
  setSliceSummaryMd,
  updateSliceStatus,
  updateTaskStatus
} from "../gsd-db.js";
import { clearParseCache } from "../files.js";
import { clearPathCache } from "../paths.js";
import { detectStaleRenders } from "../markdown-renderer.js";
import { invalidateStateCache } from "../state.js";
import {
  reconcileBeforeDispatch,
  reconcileBeforeSpawn,
  ReconciliationFailedError
} from "../state-reconciliation.js";
import { classifyFailure } from "../recovery-classification.js";
function makeState(overrides = {}) {
  return {
    activeMilestone: { id: "M001", title: "Milestone" },
    activeSlice: null,
    activeTask: null,
    phase: "planning",
    recentDecisions: [],
    blockers: [],
    nextAction: "Plan milestone",
    registry: [],
    requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
    progress: { milestones: { done: 0, total: 1 } },
    ...overrides
  };
}
function makeFixtureBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr017-drift-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S02"), { recursive: true });
  return base;
}
function cleanup(base) {
  try {
    closeDatabase();
  } catch {
  }
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
  }
}
test("ADR-017 (#5700): sketch-flag drift detected and repaired end-to-end", async (t) => {
  const base = makeFixtureBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({
    id: "S02",
    milestoneId: "M001",
    title: "Feature",
    status: "pending",
    risk: "medium",
    depends: [],
    demo: "S02 demo.",
    sequence: 1,
    isSketch: true,
    sketchScope: "limited"
  });
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", "S02", "S02-PLAN.md"),
    "# S02 Plan\n"
  );
  assert.equal(getSlice("M001", "S02")?.is_sketch, 1, "pre: flagged as sketch");
  const state = makeState({ activeMilestone: { id: "M001", title: "Test" } });
  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {
    },
    deriveState: async () => state
  });
  assert.equal(result.ok, true);
  assert.equal(getSlice("M001", "S02")?.is_sketch, 0, "post: flag cleared");
  assert.equal(result.repaired.length, 1);
  assert.equal(result.repaired[0]?.kind, "stale-sketch-flag");
  if (result.repaired[0]?.kind === "stale-sketch-flag") {
    assert.equal(result.repaired[0].mid, "M001");
    assert.equal(result.repaired[0].sid, "S02");
  }
});
test("ADR-017 (#5700): repair failure throws ReconciliationFailedError with shape", async () => {
  const seenDrift = { kind: "stale-sketch-flag", mid: "M001", sid: "S02" };
  const handler = {
    kind: "stale-sketch-flag",
    detect: () => [seenDrift],
    repair: () => {
      throw new Error("simulated repair failure");
    }
  };
  await assert.rejects(
    () => reconcileBeforeDispatch("/project", {
      invalidateStateCache: () => {
      },
      deriveState: async () => makeState(),
      registry: [handler]
    }),
    (err) => {
      assert.ok(err instanceof ReconciliationFailedError, "must be ReconciliationFailedError");
      assert.equal(err.failures.length, 1);
      assert.equal(err.failures[0]?.drift.kind, "stale-sketch-flag");
      assert.ok(err.failures[0]?.cause instanceof Error);
      assert.equal((err.failures[0]?.cause).message, "simulated repair failure");
      assert.equal(err.pass, 0);
      assert.equal(err.persistentDrift.length, 0);
      return true;
    }
  );
});
test("ADR-017 (#5700): detector failure throws ReconciliationFailedError with shape", async () => {
  const handler = {
    kind: "stale-sketch-flag",
    detect: () => {
      throw new Error("simulated detect failure");
    },
    repair: () => {
    }
  };
  await assert.rejects(
    () => reconcileBeforeDispatch("/project", {
      invalidateStateCache: () => {
      },
      deriveState: async () => makeState(),
      registry: [handler]
    }),
    (err) => {
      assert.ok(err instanceof ReconciliationFailedError, "must be ReconciliationFailedError");
      assert.equal(err.failures.length, 1);
      assert.equal(err.failures[0]?.drift.kind, "stale-sketch-flag");
      assert.ok(err.failures[0]?.cause instanceof Error);
      assert.equal((err.failures[0]?.cause).message, "simulated detect failure");
      assert.equal(err.pass, 0);
      assert.equal(err.detectionFailures.length, 0);
      assert.equal(err.persistentDrift.length, 0);
      return true;
    }
  );
});
test("ADR-017 (#5700): persistent drift after cap=2 throws ReconciliationFailedError", async () => {
  const persistent = { kind: "stale-sketch-flag", mid: "M001", sid: "S02" };
  const handler = {
    kind: "stale-sketch-flag",
    detect: () => [persistent],
    repair: () => {
    }
  };
  await assert.rejects(
    () => reconcileBeforeDispatch("/project", {
      invalidateStateCache: () => {
      },
      deriveState: async () => makeState(),
      registry: [handler]
    }),
    (err) => {
      assert.ok(err instanceof ReconciliationFailedError);
      assert.equal(err.failures.length, 0);
      assert.equal(err.persistentDrift.length, 1);
      assert.equal(err.persistentDrift[0]?.kind, "stale-sketch-flag");
      return true;
    }
  );
});
test("ADR-017 (#5700): classifyFailure recognizes ReconciliationFailedError", () => {
  const err = new ReconciliationFailedError({
    failures: [
      {
        drift: { kind: "stale-sketch-flag", mid: "M001", sid: "S02" },
        cause: new Error("boom")
      }
    ],
    pass: 0
  });
  const result = classifyFailure({ error: err });
  assert.equal(result.failureKind, "reconciliation-drift");
  assert.equal(result.action, "escalate");
  assert.equal(result.exitReason, "reconciliation-drift");
  assert.match(result.remediation, /persistent or repair-failed drift kinds/);
});
function makeGitBase() {
  const base = join(tmpdir(), `gsd-adr017-merge-${randomUUID()}`);
  mkdirSync(base, { recursive: true });
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: base, stdio: "ignore" });
  writeFileSync(join(base, ".gitkeep"), "");
  execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: base, stdio: "ignore" });
  return base;
}
function rmTreeQuiet(base) {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
  }
}
test("ADR-017 (#5701): merge-state drift detected and repaired end-to-end", async (t) => {
  const base = makeGitBase();
  t.after(() => rmTreeQuiet(base));
  execFileSync("git", ["checkout", "-b", "feature"], { cwd: base, stdio: "ignore" });
  writeFileSync(join(base, "feature.txt"), "feature content");
  execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "add feature"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["checkout", "main"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["merge", "--no-ff", "--no-commit", "feature"], { cwd: base, stdio: "ignore" });
  assert.ok(existsSync(join(base, ".git", "MERGE_HEAD")), "pre: MERGE_HEAD exists");
  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {
    },
    deriveState: async () => makeState()
  });
  assert.equal(result.ok, true);
  assert.equal(
    existsSync(join(base, ".git", "MERGE_HEAD")),
    false,
    "post: MERGE_HEAD cleared after reconciliation"
  );
  const mergeRepaired = result.repaired.find((d) => d.kind === "unmerged-merge-state");
  assert.ok(mergeRepaired, "repaired list should include the merge-state drift record");
  if (mergeRepaired?.kind === "unmerged-merge-state") {
    assert.equal(mergeRepaired.basePath, base);
  }
});
test("ADR-017 (#5701): merge-state drift is detected in linked worktrees", async (t) => {
  const base = makeGitBase();
  const worktree = join(tmpdir(), `gsd-adr017-worktree-${randomUUID()}`);
  t.after(() => {
    rmTreeQuiet(worktree);
    rmTreeQuiet(base);
  });
  execFileSync("git", ["checkout", "-b", "feature"], { cwd: base, stdio: "ignore" });
  writeFileSync(join(base, "feature.txt"), "feature content");
  execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "add feature"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["checkout", "main"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["worktree", "add", "-b", "wt-main", worktree, "main"], {
    cwd: base,
    stdio: "ignore"
  });
  execFileSync("git", ["merge", "--no-ff", "--no-commit", "feature"], {
    cwd: worktree,
    stdio: "ignore"
  });
  const mergeHeadPath = execFileSync("git", ["rev-parse", "--git-path", "MERGE_HEAD"], {
    cwd: worktree,
    encoding: "utf-8"
  }).trim();
  assert.ok(existsSync(mergeHeadPath), "pre: MERGE_HEAD exists in resolved worktree gitdir");
  assert.equal(existsSync(join(worktree, ".git", "MERGE_HEAD")), false);
  const result = await reconcileBeforeDispatch(worktree, {
    invalidateStateCache: () => {
    },
    deriveState: async () => makeState()
  });
  assert.equal(result.ok, true);
  assert.equal(existsSync(mergeHeadPath), false, "post: MERGE_HEAD cleared after reconciliation");
  assert.ok(
    result.repaired.some((d) => d.kind === "unmerged-merge-state"),
    "repaired list should include the worktree merge-state drift record"
  );
});
test("ADR-017 (#5701): no merge state \u2192 detector returns no drift", async (t) => {
  const base = makeGitBase();
  t.after(() => rmTreeQuiet(base));
  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {
    },
    deriveState: async () => makeState()
  });
  assert.equal(result.ok, true);
  assert.equal(
    result.repaired.some((d) => d.kind === "unmerged-merge-state"),
    false,
    "no merge drift should be reported when the repo is clean"
  );
});
function clearRendererCaches() {
  clearParseCache();
  clearPathCache();
  invalidateStateCache();
}
function makeStalePlanContent(sliceId, tasks) {
  const lines = [];
  lines.push(`# ${sliceId}: Test Slice`);
  lines.push("");
  lines.push("**Goal:** Test slice goal");
  lines.push("**Demo:** Test demo");
  lines.push("");
  lines.push("## Must-Haves");
  lines.push("");
  lines.push("- Everything works");
  lines.push("");
  lines.push("## Tasks");
  lines.push("");
  for (const t of tasks) {
    const checkbox = t.done ? "[x]" : "[ ]";
    lines.push(`- ${checkbox} **${t.id}: ${t.title}** \`est:1h\``);
  }
  lines.push("");
  return lines.join("\n");
}
function makeStaleRoadmapContent(slices) {
  const lines = [];
  lines.push("# M001 Roadmap");
  lines.push("");
  lines.push("**Vision:** Test milestone");
  lines.push("");
  lines.push("## Slices");
  lines.push("");
  for (const s of slices) {
    const checkbox = s.done ? "[x]" : "[ ]";
    lines.push(`- ${checkbox} **${s.id}: ${s.title}** \`risk:medium\` \`depends:[]\``);
  }
  lines.push("");
  return lines.join("\n");
}
test("ADR-017 (#5702): stale-render drift detected and repaired end-to-end", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr017-render-"));
  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  mkdirSync(join(sliceDir, "tasks"), { recursive: true });
  t.after(() => {
    try {
      closeDatabase();
    } catch {
    }
    rmTreeQuiet(base);
  });
  openDatabase(join(base, ".gsd", "gsd.db"));
  clearRendererCaches();
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "First task", status: "done" });
  insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Second task", status: "done" });
  const planPath = join(sliceDir, "S01-PLAN.md");
  writeFileSync(planPath, makeStalePlanContent("S01", [
    { id: "T01", title: "First task", done: false },
    { id: "T02", title: "Second task", done: false }
  ]));
  clearRendererCaches();
  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {
    },
    deriveState: async () => makeState()
  });
  assert.equal(result.ok, true);
  const renderRepaired = result.repaired.find((d) => d.kind === "stale-render");
  assert.ok(renderRepaired, "repaired list should include the stale-render drift");
  const repairedContent = readFileSync(planPath, "utf-8");
  assert.match(repairedContent, /\[x\][^\n]*T01:/, "T01 checkbox should be checked after repair");
  assert.match(repairedContent, /\[x\][^\n]*T02:/, "T02 checkbox should be checked after repair");
});
test("ADR-017 (#5702): stale-render detector reason strings match repair contract", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr017-render-reasons-"));
  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  mkdirSync(join(sliceDir, "tasks"), { recursive: true });
  t.after(() => {
    try {
      closeDatabase();
    } catch {
    }
    rmTreeQuiet(base);
  });
  openDatabase(join(base, ".gsd", "gsd.db"));
  clearRendererCaches();
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "complete" });
  insertTask({
    id: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    title: "First task",
    status: "done",
    fullSummaryMd: "# T01 Summary\n"
  });
  setSliceSummaryMd("M001", "S01", "# S01 Summary\n", "# S01 UAT\n");
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
    makeStaleRoadmapContent([{ id: "S01", title: "Slice", done: false }])
  );
  writeFileSync(
    join(sliceDir, "S01-PLAN.md"),
    makeStalePlanContent("S01", [{ id: "T01", title: "First task", done: false }])
  );
  clearRendererCaches();
  const reasons = detectStaleRenders(base).map((entry) => entry.reason).sort();
  assert.deepEqual(reasons, [
    "S01 is closed in DB but unchecked in roadmap",
    "S01 is complete with UAT in DB but UAT.md missing on disk",
    "S01 is complete with summary in DB but SUMMARY.md missing on disk",
    "T01 is complete with summary in DB but SUMMARY.md missing on disk",
    "T01 is done in DB but unchecked in plan"
  ].sort());
});
const DEAD_PID = 999999999;
function writeFakeSessionLock(base, pid) {
  const gsdDir = join(base, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  const lockFile = join(gsdDir, "auto.lock");
  writeFileSync(
    lockFile,
    JSON.stringify({
      pid,
      startedAt: (/* @__PURE__ */ new Date()).toISOString(),
      unitType: "starting",
      unitId: "bootstrap"
    })
  );
  mkdirSync(`${gsdDir}.lock`, { recursive: true });
  return lockFile;
}
test("ADR-017 (#5703): stale-worker drift detected and orphaned lock cleared", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr017-worker-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const lockFile = writeFakeSessionLock(base, DEAD_PID);
  assert.ok(existsSync(lockFile), "pre: lock file written");
  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {
    },
    deriveState: async () => makeState()
  });
  assert.equal(result.ok, true);
  assert.equal(existsSync(lockFile), false, "post: orphaned lock file removed");
  const workerRepaired = result.repaired.find((d) => d.kind === "stale-worker");
  assert.ok(workerRepaired, "repaired list should include the stale-worker drift");
  if (workerRepaired?.kind === "stale-worker") {
    assert.equal(workerRepaired.pid, DEAD_PID);
  }
});
test("ADR-017 (#5703): live worker lock is not cleared", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr017-worker-live-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const ALIVE_PID = 1;
  const lockFile = writeFakeSessionLock(base, ALIVE_PID);
  assert.ok(existsSync(lockFile), "pre: lock file written");
  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {
    },
    deriveState: async () => makeState()
  });
  assert.equal(result.ok, true);
  assert.equal(
    existsSync(lockFile),
    true,
    "live lock must NOT be cleared (would steal the lock from a running session)"
  );
  assert.equal(
    result.repaired.some((d) => d.kind === "stale-worker"),
    false,
    "no stale-worker drift should be reported when the lock owner is alive"
  );
});
test("ADR-017 (#5704): unregistered-milestone drift detected and DB row inserted", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr017-projmd-"));
  const milestoneDir = join(base, ".gsd", "milestones", "M042");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(
    join(milestoneDir, "M042-ROADMAP.md"),
    [
      "# M042: Test Milestone",
      "",
      "**Vision:** Verify unregistered-milestone drift",
      "",
      "## Slices",
      "",
      "- [ ] **S01: Foundation** `risk:medium` `depends:[]`",
      ""
    ].join("\n")
  );
  t.after(() => {
    try {
      closeDatabase();
    } catch {
    }
    rmSync(base, { recursive: true, force: true });
  });
  openDatabase(join(base, ".gsd", "gsd.db"));
  assert.equal(getMilestone("M042"), null, "pre: DB has no row for M042");
  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {
    },
    deriveState: async () => makeState()
  });
  assert.equal(result.ok, true);
  assert.ok(getMilestone("M042"), "post: DB row inserted for M042");
  const milestoneRepaired = result.repaired.find(
    (d) => d.kind === "unregistered-milestone"
  );
  assert.ok(milestoneRepaired, "repaired list should include the unregistered-milestone drift");
  if (milestoneRepaired?.kind === "unregistered-milestone") {
    assert.equal(milestoneRepaired.milestoneId, "M042");
  }
});
test("ADR-017 (#5704): registered milestone (DB row present) \u2192 no drift", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr017-projmd-clean-"));
  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(
    join(milestoneDir, "M001-ROADMAP.md"),
    [
      "# M001: Test",
      "",
      "**Vision:** Already-registered milestone",
      "",
      "## Slices",
      "",
      "- [ ] **S01: Slice** `risk:low` `depends:[]`",
      ""
    ].join("\n")
  );
  t.after(() => {
    try {
      closeDatabase();
    } catch {
    }
    rmSync(base, { recursive: true, force: true });
  });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {
    },
    deriveState: async () => makeState()
  });
  assert.equal(result.ok, true);
  assert.equal(
    result.repaired.some((d) => d.kind === "unregistered-milestone"),
    false,
    "no drift should be reported when the milestone is already in the DB"
  );
});
test("ADR-017 (#5705): roadmap-divergence drift detected and DB depends synced", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr017-roadmap-"));
  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(
    join(milestoneDir, "M001-ROADMAP.md"),
    [
      "# M001: Test",
      "",
      "**Vision:** Verify roadmap-divergence drift",
      "",
      "## Slices",
      "",
      "- [ ] **S01: Foundation** `risk:medium` `depends:[]`",
      "- [ ] **S02: Feature** `risk:medium` `depends:[S01]`",
      ""
    ].join("\n")
  );
  t.after(() => {
    try {
      closeDatabase();
    } catch {
    }
    rmSync(base, { recursive: true, force: true });
  });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Foundation", status: "pending", risk: "medium", depends: [], demo: "", sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Feature", status: "pending", risk: "medium", depends: [], demo: "", sequence: 2 });
  assert.deepEqual(getSlice("M001", "S02")?.depends, [], "pre: DB has S02.depends = []");
  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {
    },
    deriveState: async () => makeState()
  });
  assert.equal(result.ok, true);
  assert.deepEqual(getSlice("M001", "S02")?.depends, ["S01"], "post: DB depends matches ROADMAP.md");
  const roadmapRepaired = result.repaired.find((d) => d.kind === "roadmap-divergence");
  assert.ok(roadmapRepaired, "repaired list should include the roadmap-divergence drift");
  if (roadmapRepaired?.kind === "roadmap-divergence") {
    assert.equal(roadmapRepaired.milestoneId, "M001");
  }
});
test("ADR-017 (#5705): ROADMAP declares slice missing from DB \u2192 slice inserted and drift reported", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr017-roadmap-newslice-"));
  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(
    join(milestoneDir, "M001-ROADMAP.md"),
    [
      "# M001: Test",
      "",
      "**Vision:** Verify new-slice insertion via roadmap-divergence repair",
      "",
      "## Slices",
      "",
      "- [ ] **S01: Foundation** `risk:medium` `depends:[]`",
      "- [ ] **S02: Feature** `risk:medium` `depends:[S01]`",
      ""
    ].join("\n")
  );
  t.after(() => {
    try {
      closeDatabase();
    } catch {
    }
    rmSync(base, { recursive: true, force: true });
  });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Foundation", status: "pending", risk: "medium", depends: [], demo: "", sequence: 1 });
  assert.equal(getSlice("M001", "S02"), null, "pre: S02 has no DB row");
  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {
    },
    deriveState: async () => makeState()
  });
  assert.equal(result.ok, true);
  const s02 = getSlice("M001", "S02");
  assert.ok(s02, "post: S02 inserted into DB after repair");
  assert.equal(s02?.sequence, 2, "post: S02 sequence matches ROADMAP order");
  assert.deepEqual(s02?.depends, ["S01"], "post: S02 depends matches ROADMAP");
  const roadmapRepaired = result.repaired.find((d) => d.kind === "roadmap-divergence");
  assert.ok(roadmapRepaired, "repaired list should include the roadmap-divergence drift");
  if (roadmapRepaired?.kind === "roadmap-divergence") {
    assert.equal(roadmapRepaired.milestoneId, "M001");
  }
});
test("ADR-017 (#5705): in-sync ROADMAP and DB \u2192 no roadmap-divergence drift", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr017-roadmap-clean-"));
  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(
    join(milestoneDir, "M001-ROADMAP.md"),
    [
      "# M001: Test",
      "",
      "**Vision:** Already in sync",
      "",
      "## Slices",
      "",
      "- [ ] **S01: Foundation** `risk:low` `depends:[]`",
      ""
    ].join("\n")
  );
  t.after(() => {
    try {
      closeDatabase();
    } catch {
    }
    rmSync(base, { recursive: true, force: true });
  });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Foundation", status: "pending", risk: "low", depends: [], demo: "", sequence: 1 });
  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {
    },
    deriveState: async () => makeState()
  });
  assert.equal(result.ok, true);
  assert.equal(
    result.repaired.some((d) => d.kind === "roadmap-divergence"),
    false,
    "no roadmap-divergence drift should be reported when DB matches markdown"
  );
});
test("ADR-017 (#5706): task with SUMMARY but null completed_at \u2192 backfilled", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr017-completion-task-"));
  const tasksDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  t.after(() => {
    try {
      closeDatabase();
    } catch {
    }
    rmSync(base, { recursive: true, force: true });
  });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending", risk: "low", depends: [], demo: "", sequence: 1 });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "pending" });
  updateTaskStatus("M001", "S01", "T01", "complete", void 0);
  const summaryPath = join(tasksDir, "T01-SUMMARY.md");
  writeFileSync(summaryPath, "# T01 Summary\n");
  const summaryMtimeMs = statSync(summaryPath).mtime.getTime();
  const taskBefore = getSliceTasks("M001", "S01").find((t2) => t2.id === "T01");
  assert.equal(taskBefore?.status, "complete");
  assert.equal(taskBefore?.completed_at, null, "pre: completed_at is null");
  const result = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {
    },
    deriveState: async () => makeState({ activeMilestone: { id: "M001", title: "Test" } })
  });
  assert.equal(result.ok, true);
  const taskAfter = getSliceTasks("M001", "S01").find((t2) => t2.id === "T01");
  assert.ok(taskAfter?.completed_at, "post: completed_at populated");
  const completedAtMs = Date.parse(taskAfter?.completed_at ?? "");
  assert.ok(Number.isFinite(completedAtMs), "post: completed_at is parseable ISO string");
  assert.equal(completedAtMs, summaryMtimeMs, "post: completed_at derived from SUMMARY mtime");
  const drift = result.repaired.find((d) => d.kind === "missing-completion-timestamp");
  assert.ok(drift, "drift recorded");
  if (drift?.kind === "missing-completion-timestamp") {
    assert.equal(drift.entity, "task");
    assert.deepEqual(drift.ids, ["M001/S01/T01"]);
  }
});
test("ADR-017 (#5706): repair is idempotent \u2014 re-running preserves the timestamp", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr017-completion-idempotent-"));
  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  mkdirSync(sliceDir, { recursive: true });
  t.after(() => {
    try {
      closeDatabase();
    } catch {
    }
    rmSync(base, { recursive: true, force: true });
  });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending", risk: "low", depends: [], demo: "", sequence: 1 });
  updateSliceStatus("M001", "S01", "complete", void 0);
  const summaryPath = join(sliceDir, "S01-SUMMARY.md");
  writeFileSync(summaryPath, "# S01 Summary\n");
  const summaryMtimeMs = statSync(summaryPath).mtime.getTime();
  const firstResult = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {
    },
    deriveState: async () => makeState({ activeMilestone: { id: "M001", title: "Test" } })
  });
  assert.equal(firstResult.ok, true);
  const tsAfterFirst = getSlice("M001", "S01")?.completed_at;
  assert.ok(tsAfterFirst, "first pass: completed_at populated");
  const completedAtMs = Date.parse(tsAfterFirst ?? "");
  assert.ok(Number.isFinite(completedAtMs), "first pass: completed_at is parseable ISO string");
  assert.equal(completedAtMs, summaryMtimeMs, "first pass: completed_at derived from SUMMARY mtime");
  const secondResult = await reconcileBeforeDispatch(base, {
    invalidateStateCache: () => {
    },
    deriveState: async () => makeState({ activeMilestone: { id: "M001", title: "Test" } })
  });
  assert.equal(secondResult.ok, true);
  assert.equal(
    secondResult.repaired.some((d) => d.kind === "missing-completion-timestamp"),
    false,
    "second pass: no drift detected after first repair"
  );
  assert.equal(getSlice("M001", "S01")?.completed_at, tsAfterFirst, "timestamp unchanged");
});
test("ADR-017 (#5707): reconcileBeforeSpawn returns ok=true on clean reconciliation", async () => {
  const result = await reconcileBeforeSpawn("/project", {
    invalidateStateCache: () => {
    },
    deriveState: async () => makeState(),
    registry: []
  });
  assert.equal(result.ok, true);
});
test("ADR-017 (#5707): reconcileBeforeSpawn surfaces blockers as ok=false", async () => {
  const result = await reconcileBeforeSpawn("/project", {
    invalidateStateCache: () => {
    },
    deriveState: async () => makeState({ phase: "blocked", blockers: ["lock missing"] }),
    registry: []
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /lock missing/);
  }
});
test("ADR-017 (#5707): reconcileBeforeSpawn catches ReconciliationFailedError \u2192 ok=false", async () => {
  const persistent = { kind: "stale-sketch-flag", mid: "M001", sid: "S02" };
  const handler = {
    kind: "stale-sketch-flag",
    detect: () => [persistent],
    repair: () => {
    }
  };
  const result = await reconcileBeforeSpawn("/project", {
    invalidateStateCache: () => {
    },
    deriveState: async () => makeState(),
    registry: [handler]
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /stale-sketch-flag/);
  }
});
test("ADR-017 (#5707): reconcileBeforeSpawn reports repaired drift in ok=true reason", async () => {
  let detectCalls = 0;
  const handler = {
    kind: "stale-sketch-flag",
    detect: () => {
      detectCalls++;
      return detectCalls === 1 ? [{ kind: "stale-sketch-flag", mid: "M001", sid: "S02" }] : [];
    },
    repair: () => {
    }
  };
  const result = await reconcileBeforeSpawn("/project", {
    invalidateStateCache: () => {
    },
    deriveState: async () => makeState(),
    registry: [handler]
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.reason ?? "", /stale-sketch-flag/);
  }
});
test("ADR-017 (#5700): cascading drift triggers second pass within cap", async () => {
  const detectedSequence = [
    [{ kind: "stale-sketch-flag", mid: "M001", sid: "S02" }],
    [{ kind: "stale-sketch-flag", mid: "M001", sid: "S03" }],
    []
  ];
  let detectCallIdx = 0;
  const repaired = [];
  const handler = {
    kind: "stale-sketch-flag",
    detect: () => detectedSequence[detectCallIdx++] ?? [],
    repair: (record) => {
      repaired.push(record);
    }
  };
  const result = await reconcileBeforeDispatch("/project", {
    invalidateStateCache: () => {
    },
    deriveState: async () => makeState(),
    registry: [handler]
  });
  assert.equal(result.ok, true);
  assert.equal(result.repaired.length, 2, "both passes' repairs collected");
  assert.equal(repaired.length, 2);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9zdGF0ZS1yZWNvbmNpbGlhdGlvbi1kcmlmdC50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBQcm9qZWN0L0FwcDogR1NELTJcbi8vIEZpbGUgUHVycG9zZTogQURSLTAxNyBjb250cmFjdCB0ZXN0cyBmb3IgZHJpZnQtZHJpdmVuIFN0YXRlIFJlY29uY2lsaWF0aW9uLlxuLy8gQ292ZXJzIHNrZXRjaC1mbGFnICgjNTcwMCksIG1lcmdlLXN0YXRlICgjNTcwMSksIHN0YWxlLXJlbmRlciAoIzU3MDIpLFxuLy8gc3RhbGUtd29ya2VyICgjNTcwMyksIHVucmVnaXN0ZXJlZC1taWxlc3RvbmUgKCM1NzA0KSwgcm9hZG1hcC1kaXZlcmdlbmNlXG4vLyAoIzU3MDUpLCBhbmQgbWlzc2luZy1jb21wbGV0aW9uLXRpbWVzdGFtcCAoIzU3MDYpIGRyaWZ0IGVuZC10by1lbmQsIHBsdXNcbi8vIHRoZSByZXBhaXItdGhyb3cgYW5kIHBlcnNpc3RlbnQtZHJpZnQgZXJyb3IgcGF0aHMgYW5kIFJlY292ZXJ5XG4vLyBDbGFzc2lmaWNhdGlvbiBtYXBwaW5nIGZvciBSZWNvbmNpbGlhdGlvbkZhaWxlZEVycm9yLlxuXG5pbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IGV4ZWNGaWxlU3luYyB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMsIG1rZHRlbXBTeW5jLCBta2RpclN5bmMsIHJlYWRGaWxlU3luYywgcm1TeW5jLCBzdGF0U3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcblxuaW1wb3J0IHtcbiAgb3BlbkRhdGFiYXNlLFxuICBjbG9zZURhdGFiYXNlLFxuICBpbnNlcnRNaWxlc3RvbmUsXG4gIGluc2VydFNsaWNlLFxuICBpbnNlcnRUYXNrLFxuICBnZXRNaWxlc3RvbmUsXG4gIGdldFNsaWNlLFxuICBnZXRTbGljZVRhc2tzLFxuICBzZXRTbGljZVN1bW1hcnlNZCxcbiAgdXBkYXRlU2xpY2VTdGF0dXMsXG4gIHVwZGF0ZVRhc2tTdGF0dXMsXG59IGZyb20gXCIuLi9nc2QtZGIudHNcIjtcbmltcG9ydCB7IGNsZWFyUGFyc2VDYWNoZSB9IGZyb20gXCIuLi9maWxlcy50c1wiO1xuaW1wb3J0IHsgY2xlYXJQYXRoQ2FjaGUgfSBmcm9tIFwiLi4vcGF0aHMudHNcIjtcbmltcG9ydCB7IGRldGVjdFN0YWxlUmVuZGVycyB9IGZyb20gXCIuLi9tYXJrZG93bi1yZW5kZXJlci50c1wiO1xuaW1wb3J0IHsgaW52YWxpZGF0ZVN0YXRlQ2FjaGUgfSBmcm9tIFwiLi4vc3RhdGUudHNcIjtcbmltcG9ydCB7XG4gIHJlY29uY2lsZUJlZm9yZURpc3BhdGNoLFxuICByZWNvbmNpbGVCZWZvcmVTcGF3bixcbiAgUmVjb25jaWxpYXRpb25GYWlsZWRFcnJvcixcbiAgdHlwZSBEcmlmdEhhbmRsZXIsXG4gIHR5cGUgRHJpZnRSZWNvcmQsXG59IGZyb20gXCIuLi9zdGF0ZS1yZWNvbmNpbGlhdGlvbi50c1wiO1xuaW1wb3J0IHsgY2xhc3NpZnlGYWlsdXJlIH0gZnJvbSBcIi4uL3JlY292ZXJ5LWNsYXNzaWZpY2F0aW9uLnRzXCI7XG5pbXBvcnQgdHlwZSB7IEdTRFN0YXRlIH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5cbmZ1bmN0aW9uIG1ha2VTdGF0ZShvdmVycmlkZXM6IFBhcnRpYWw8R1NEU3RhdGU+ID0ge30pOiBHU0RTdGF0ZSB7XG4gIHJldHVybiB7XG4gICAgYWN0aXZlTWlsZXN0b25lOiB7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiTWlsZXN0b25lXCIgfSxcbiAgICBhY3RpdmVTbGljZTogbnVsbCxcbiAgICBhY3RpdmVUYXNrOiBudWxsLFxuICAgIHBoYXNlOiBcInBsYW5uaW5nXCIsXG4gICAgcmVjZW50RGVjaXNpb25zOiBbXSxcbiAgICBibG9ja2VyczogW10sXG4gICAgbmV4dEFjdGlvbjogXCJQbGFuIG1pbGVzdG9uZVwiLFxuICAgIHJlZ2lzdHJ5OiBbXSxcbiAgICByZXF1aXJlbWVudHM6IHsgYWN0aXZlOiAwLCB2YWxpZGF0ZWQ6IDAsIGRlZmVycmVkOiAwLCBvdXRPZlNjb3BlOiAwLCBibG9ja2VkOiAwLCB0b3RhbDogMCB9LFxuICAgIHByb2dyZXNzOiB7IG1pbGVzdG9uZXM6IHsgZG9uZTogMCwgdG90YWw6IDEgfSB9LFxuICAgIC4uLm92ZXJyaWRlcyxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbWFrZUZpeHR1cmVCYXNlKCk6IHN0cmluZyB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1hZHIwMTctZHJpZnQtXCIpKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDJcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICByZXR1cm4gYmFzZTtcbn1cblxuZnVuY3Rpb24gY2xlYW51cChiYXNlOiBzdHJpbmcpOiB2b2lkIHtcbiAgdHJ5IHtcbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gIH0gY2F0Y2gge1xuICAgIC8qIG5vb3AgKi9cbiAgfVxuICB0cnkge1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH0gY2F0Y2gge1xuICAgIC8qIG5vb3AgKi9cbiAgfVxufVxuXG50ZXN0KFwiQURSLTAxNyAoIzU3MDApOiBza2V0Y2gtZmxhZyBkcmlmdCBkZXRlY3RlZCBhbmQgcmVwYWlyZWQgZW5kLXRvLWVuZFwiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUZpeHR1cmVCYXNlKCk7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChiYXNlKSk7XG5cbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpKTtcbiAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIsIHN0YXR1czogXCJhY3RpdmVcIiB9KTtcbiAgaW5zZXJ0U2xpY2Uoe1xuICAgIGlkOiBcIlMwMlwiLFxuICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICB0aXRsZTogXCJGZWF0dXJlXCIsXG4gICAgc3RhdHVzOiBcInBlbmRpbmdcIixcbiAgICByaXNrOiBcIm1lZGl1bVwiLFxuICAgIGRlcGVuZHM6IFtdLFxuICAgIGRlbW86IFwiUzAyIGRlbW8uXCIsXG4gICAgc2VxdWVuY2U6IDEsXG4gICAgaXNTa2V0Y2g6IHRydWUsXG4gICAgc2tldGNoU2NvcGU6IFwibGltaXRlZFwiLFxuICB9KTtcblxuICAvLyBTaW11bGF0ZSB0aGUgcG9zdC1jcmFzaCBzY2VuYXJpbzogUExBTi5tZCBleGlzdHMgb24gZGlzayBidXQgdGhlXG4gIC8vIGlzX3NrZXRjaCBmbGFnIGlzIHN0aWxsIDEuXG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMlwiLCBcIlMwMi1QTEFOLm1kXCIpLFxuICAgIFwiIyBTMDIgUGxhblxcblwiLFxuICApO1xuICBhc3NlcnQuZXF1YWwoZ2V0U2xpY2UoXCJNMDAxXCIsIFwiUzAyXCIpPy5pc19za2V0Y2gsIDEsIFwicHJlOiBmbGFnZ2VkIGFzIHNrZXRjaFwiKTtcblxuICBjb25zdCBzdGF0ZSA9IG1ha2VTdGF0ZSh7IGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiB9IH0pO1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCByZWNvbmNpbGVCZWZvcmVEaXNwYXRjaChiYXNlLCB7XG4gICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGU6ICgpID0+IHt9LFxuICAgIGRlcml2ZVN0YXRlOiBhc3luYyAoKSA9PiBzdGF0ZSxcbiAgfSk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5vaywgdHJ1ZSk7XG4gIGFzc2VydC5lcXVhbChnZXRTbGljZShcIk0wMDFcIiwgXCJTMDJcIik/LmlzX3NrZXRjaCwgMCwgXCJwb3N0OiBmbGFnIGNsZWFyZWRcIik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQucmVwYWlyZWQubGVuZ3RoLCAxKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5yZXBhaXJlZFswXT8ua2luZCwgXCJzdGFsZS1za2V0Y2gtZmxhZ1wiKTtcbiAgaWYgKHJlc3VsdC5yZXBhaXJlZFswXT8ua2luZCA9PT0gXCJzdGFsZS1za2V0Y2gtZmxhZ1wiKSB7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5yZXBhaXJlZFswXS5taWQsIFwiTTAwMVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnJlcGFpcmVkWzBdLnNpZCwgXCJTMDJcIik7XG4gIH1cbn0pO1xuXG50ZXN0KFwiQURSLTAxNyAoIzU3MDApOiByZXBhaXIgZmFpbHVyZSB0aHJvd3MgUmVjb25jaWxpYXRpb25GYWlsZWRFcnJvciB3aXRoIHNoYXBlXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3Qgc2VlbkRyaWZ0OiBEcmlmdFJlY29yZCA9IHsga2luZDogXCJzdGFsZS1za2V0Y2gtZmxhZ1wiLCBtaWQ6IFwiTTAwMVwiLCBzaWQ6IFwiUzAyXCIgfTtcbiAgY29uc3QgaGFuZGxlcjogRHJpZnRIYW5kbGVyID0ge1xuICAgIGtpbmQ6IFwic3RhbGUtc2tldGNoLWZsYWdcIixcbiAgICBkZXRlY3Q6ICgpID0+IFtzZWVuRHJpZnRdLFxuICAgIHJlcGFpcjogKCkgPT4ge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwic2ltdWxhdGVkIHJlcGFpciBmYWlsdXJlXCIpO1xuICAgIH0sXG4gIH07XG5cbiAgYXdhaXQgYXNzZXJ0LnJlamVjdHMoXG4gICAgKCkgPT5cbiAgICAgIHJlY29uY2lsZUJlZm9yZURpc3BhdGNoKFwiL3Byb2plY3RcIiwge1xuICAgICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZTogKCkgPT4ge30sXG4gICAgICAgIGRlcml2ZVN0YXRlOiBhc3luYyAoKSA9PiBtYWtlU3RhdGUoKSxcbiAgICAgICAgcmVnaXN0cnk6IFtoYW5kbGVyXSxcbiAgICAgIH0pLFxuICAgIChlcnI6IHVua25vd24pID0+IHtcbiAgICAgIGFzc2VydC5vayhlcnIgaW5zdGFuY2VvZiBSZWNvbmNpbGlhdGlvbkZhaWxlZEVycm9yLCBcIm11c3QgYmUgUmVjb25jaWxpYXRpb25GYWlsZWRFcnJvclwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChlcnIuZmFpbHVyZXMubGVuZ3RoLCAxKTtcbiAgICAgIGFzc2VydC5lcXVhbChlcnIuZmFpbHVyZXNbMF0/LmRyaWZ0LmtpbmQsIFwic3RhbGUtc2tldGNoLWZsYWdcIik7XG4gICAgICBhc3NlcnQub2soZXJyLmZhaWx1cmVzWzBdPy5jYXVzZSBpbnN0YW5jZW9mIEVycm9yKTtcbiAgICAgIGFzc2VydC5lcXVhbCgoZXJyLmZhaWx1cmVzWzBdPy5jYXVzZSBhcyBFcnJvcikubWVzc2FnZSwgXCJzaW11bGF0ZWQgcmVwYWlyIGZhaWx1cmVcIik7XG4gICAgICBhc3NlcnQuZXF1YWwoZXJyLnBhc3MsIDApO1xuICAgICAgYXNzZXJ0LmVxdWFsKGVyci5wZXJzaXN0ZW50RHJpZnQubGVuZ3RoLCAwKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0sXG4gICk7XG59KTtcblxudGVzdChcIkFEUi0wMTcgKCM1NzAwKTogZGV0ZWN0b3IgZmFpbHVyZSB0aHJvd3MgUmVjb25jaWxpYXRpb25GYWlsZWRFcnJvciB3aXRoIHNoYXBlXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgaGFuZGxlcjogRHJpZnRIYW5kbGVyID0ge1xuICAgIGtpbmQ6IFwic3RhbGUtc2tldGNoLWZsYWdcIixcbiAgICBkZXRlY3Q6ICgpID0+IHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcInNpbXVsYXRlZCBkZXRlY3QgZmFpbHVyZVwiKTtcbiAgICB9LFxuICAgIHJlcGFpcjogKCkgPT4ge1xuICAgICAgLyogZGV0ZWN0IGZhaWxzIGJlZm9yZSByZXBhaXIgKi9cbiAgICB9LFxuICB9O1xuXG4gIGF3YWl0IGFzc2VydC5yZWplY3RzKFxuICAgICgpID0+XG4gICAgICByZWNvbmNpbGVCZWZvcmVEaXNwYXRjaChcIi9wcm9qZWN0XCIsIHtcbiAgICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGU6ICgpID0+IHt9LFxuICAgICAgICBkZXJpdmVTdGF0ZTogYXN5bmMgKCkgPT4gbWFrZVN0YXRlKCksXG4gICAgICAgIHJlZ2lzdHJ5OiBbaGFuZGxlcl0sXG4gICAgICB9KSxcbiAgICAoZXJyOiB1bmtub3duKSA9PiB7XG4gICAgICBhc3NlcnQub2soZXJyIGluc3RhbmNlb2YgUmVjb25jaWxpYXRpb25GYWlsZWRFcnJvciwgXCJtdXN0IGJlIFJlY29uY2lsaWF0aW9uRmFpbGVkRXJyb3JcIik7XG4gICAgICBhc3NlcnQuZXF1YWwoZXJyLmZhaWx1cmVzLmxlbmd0aCwgMSk7XG4gICAgICBhc3NlcnQuZXF1YWwoZXJyLmZhaWx1cmVzWzBdPy5kcmlmdC5raW5kLCBcInN0YWxlLXNrZXRjaC1mbGFnXCIpO1xuICAgICAgYXNzZXJ0Lm9rKGVyci5mYWlsdXJlc1swXT8uY2F1c2UgaW5zdGFuY2VvZiBFcnJvcik7XG4gICAgICBhc3NlcnQuZXF1YWwoKGVyci5mYWlsdXJlc1swXT8uY2F1c2UgYXMgRXJyb3IpLm1lc3NhZ2UsIFwic2ltdWxhdGVkIGRldGVjdCBmYWlsdXJlXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGVyci5wYXNzLCAwKTtcbiAgICAgIGFzc2VydC5lcXVhbChlcnIuZGV0ZWN0aW9uRmFpbHVyZXMubGVuZ3RoLCAwKTtcbiAgICAgIGFzc2VydC5lcXVhbChlcnIucGVyc2lzdGVudERyaWZ0Lmxlbmd0aCwgMCk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9LFxuICApO1xufSk7XG5cbnRlc3QoXCJBRFItMDE3ICgjNTcwMCk6IHBlcnNpc3RlbnQgZHJpZnQgYWZ0ZXIgY2FwPTIgdGhyb3dzIFJlY29uY2lsaWF0aW9uRmFpbGVkRXJyb3JcIiwgYXN5bmMgKCkgPT4ge1xuICAvLyBEZXRlY3QgYWx3YXlzIHJldHVybnMgb25lIGRyaWZ0OyByZXBhaXIgaXMgYSBuby1vcCAoZHJpZnQgbmV2ZXIgZ29lcyBhd2F5KS5cbiAgY29uc3QgcGVyc2lzdGVudDogRHJpZnRSZWNvcmQgPSB7IGtpbmQ6IFwic3RhbGUtc2tldGNoLWZsYWdcIiwgbWlkOiBcIk0wMDFcIiwgc2lkOiBcIlMwMlwiIH07XG4gIGNvbnN0IGhhbmRsZXI6IERyaWZ0SGFuZGxlciA9IHtcbiAgICBraW5kOiBcInN0YWxlLXNrZXRjaC1mbGFnXCIsXG4gICAgZGV0ZWN0OiAoKSA9PiBbcGVyc2lzdGVudF0sXG4gICAgcmVwYWlyOiAoKSA9PiB7XG4gICAgICAvKiBuby1vcDogZHJpZnQgY2Fubm90IGJlIGNsZWFyZWQgKi9cbiAgICB9LFxuICB9O1xuXG4gIGF3YWl0IGFzc2VydC5yZWplY3RzKFxuICAgICgpID0+XG4gICAgICByZWNvbmNpbGVCZWZvcmVEaXNwYXRjaChcIi9wcm9qZWN0XCIsIHtcbiAgICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGU6ICgpID0+IHt9LFxuICAgICAgICBkZXJpdmVTdGF0ZTogYXN5bmMgKCkgPT4gbWFrZVN0YXRlKCksXG4gICAgICAgIHJlZ2lzdHJ5OiBbaGFuZGxlcl0sXG4gICAgICB9KSxcbiAgICAoZXJyOiB1bmtub3duKSA9PiB7XG4gICAgICBhc3NlcnQub2soZXJyIGluc3RhbmNlb2YgUmVjb25jaWxpYXRpb25GYWlsZWRFcnJvcik7XG4gICAgICBhc3NlcnQuZXF1YWwoZXJyLmZhaWx1cmVzLmxlbmd0aCwgMCk7XG4gICAgICBhc3NlcnQuZXF1YWwoZXJyLnBlcnNpc3RlbnREcmlmdC5sZW5ndGgsIDEpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGVyci5wZXJzaXN0ZW50RHJpZnRbMF0/LmtpbmQsIFwic3RhbGUtc2tldGNoLWZsYWdcIik7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9LFxuICApO1xufSk7XG5cbnRlc3QoXCJBRFItMDE3ICgjNTcwMCk6IGNsYXNzaWZ5RmFpbHVyZSByZWNvZ25pemVzIFJlY29uY2lsaWF0aW9uRmFpbGVkRXJyb3JcIiwgKCkgPT4ge1xuICBjb25zdCBlcnIgPSBuZXcgUmVjb25jaWxpYXRpb25GYWlsZWRFcnJvcih7XG4gICAgZmFpbHVyZXM6IFtcbiAgICAgIHtcbiAgICAgICAgZHJpZnQ6IHsga2luZDogXCJzdGFsZS1za2V0Y2gtZmxhZ1wiLCBtaWQ6IFwiTTAwMVwiLCBzaWQ6IFwiUzAyXCIgfSxcbiAgICAgICAgY2F1c2U6IG5ldyBFcnJvcihcImJvb21cIiksXG4gICAgICB9LFxuICAgIF0sXG4gICAgcGFzczogMCxcbiAgfSk7XG5cbiAgY29uc3QgcmVzdWx0ID0gY2xhc3NpZnlGYWlsdXJlKHsgZXJyb3I6IGVyciB9KTtcblxuICBhc3NlcnQuZXF1YWwocmVzdWx0LmZhaWx1cmVLaW5kLCBcInJlY29uY2lsaWF0aW9uLWRyaWZ0XCIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LmFjdGlvbiwgXCJlc2NhbGF0ZVwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5leGl0UmVhc29uLCBcInJlY29uY2lsaWF0aW9uLWRyaWZ0XCIpO1xuICBhc3NlcnQubWF0Y2gocmVzdWx0LnJlbWVkaWF0aW9uLCAvcGVyc2lzdGVudCBvciByZXBhaXItZmFpbGVkIGRyaWZ0IGtpbmRzLyk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwICM1NzAxOiBtZXJnZS1zdGF0ZSBkcmlmdCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gbWFrZUdpdEJhc2UoKTogc3RyaW5nIHtcbiAgY29uc3QgYmFzZSA9IGpvaW4odG1wZGlyKCksIGBnc2QtYWRyMDE3LW1lcmdlLSR7cmFuZG9tVVVJRCgpfWApO1xuICBta2RpclN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJpbml0XCIsIFwiLS1pbml0aWFsLWJyYW5jaD1tYWluXCJdLCB7IGN3ZDogYmFzZSwgc3RkaW86IFwiaWdub3JlXCIgfSk7XG4gIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJjb25maWdcIiwgXCJ1c2VyLmVtYWlsXCIsIFwidGVzdEB0ZXN0LmNvbVwiXSwgeyBjd2Q6IGJhc2UsIHN0ZGlvOiBcImlnbm9yZVwiIH0pO1xuICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiY29uZmlnXCIsIFwidXNlci5uYW1lXCIsIFwiVGVzdFwiXSwgeyBjd2Q6IGJhc2UsIHN0ZGlvOiBcImlnbm9yZVwiIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ2l0a2VlcFwiKSwgXCJcIik7XG4gIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJhZGRcIiwgXCIuXCJdLCB7IGN3ZDogYmFzZSwgc3RkaW86IFwiaWdub3JlXCIgfSk7XG4gIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJjb21taXRcIiwgXCItbVwiLCBcImluaXRpYWxcIl0sIHsgY3dkOiBiYXNlLCBzdGRpbzogXCJpZ25vcmVcIiB9KTtcbiAgcmV0dXJuIGJhc2U7XG59XG5cbmZ1bmN0aW9uIHJtVHJlZVF1aWV0KGJhc2U6IHN0cmluZyk6IHZvaWQge1xuICB0cnkge1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH0gY2F0Y2gge1xuICAgIC8qIG5vb3AgKi9cbiAgfVxufVxuXG50ZXN0KFwiQURSLTAxNyAoIzU3MDEpOiBtZXJnZS1zdGF0ZSBkcmlmdCBkZXRlY3RlZCBhbmQgcmVwYWlyZWQgZW5kLXRvLWVuZFwiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUdpdEJhc2UoKTtcbiAgdC5hZnRlcigoKSA9PiBybVRyZWVRdWlldChiYXNlKSk7XG5cbiAgLy8gQnVpbGQgYSBjbGVhbiBmYXN0LWZvcndhcmQtcmVzb2x2YWJsZSBtZXJnZTogZmVhdHVyZSBicmFuY2ggd2l0aCBvbmUgZmlsZSxcbiAgLy8gdGhlbiBzdGFydCBtZXJnZSAtLW5vLWNvbW1pdCBvbiBtYWluIHNvIE1FUkdFX0hFQUQgZXhpc3RzIHdpdGggbm8gY29uZmxpY3RzLlxuICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiY2hlY2tvdXRcIiwgXCItYlwiLCBcImZlYXR1cmVcIl0sIHsgY3dkOiBiYXNlLCBzdGRpbzogXCJpZ25vcmVcIiB9KTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwiZmVhdHVyZS50eHRcIiksIFwiZmVhdHVyZSBjb250ZW50XCIpO1xuICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiYWRkXCIsIFwiLlwiXSwgeyBjd2Q6IGJhc2UsIHN0ZGlvOiBcImlnbm9yZVwiIH0pO1xuICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiY29tbWl0XCIsIFwiLW1cIiwgXCJhZGQgZmVhdHVyZVwiXSwgeyBjd2Q6IGJhc2UsIHN0ZGlvOiBcImlnbm9yZVwiIH0pO1xuICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiY2hlY2tvdXRcIiwgXCJtYWluXCJdLCB7IGN3ZDogYmFzZSwgc3RkaW86IFwiaWdub3JlXCIgfSk7XG4gIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJtZXJnZVwiLCBcIi0tbm8tZmZcIiwgXCItLW5vLWNvbW1pdFwiLCBcImZlYXR1cmVcIl0sIHsgY3dkOiBiYXNlLCBzdGRpbzogXCJpZ25vcmVcIiB9KTtcblxuICBhc3NlcnQub2soZXhpc3RzU3luYyhqb2luKGJhc2UsIFwiLmdpdFwiLCBcIk1FUkdFX0hFQURcIikpLCBcInByZTogTUVSR0VfSEVBRCBleGlzdHNcIik7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVjb25jaWxlQmVmb3JlRGlzcGF0Y2goYmFzZSwge1xuICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlOiAoKSA9PiB7fSxcbiAgICBkZXJpdmVTdGF0ZTogYXN5bmMgKCkgPT4gbWFrZVN0YXRlKCksXG4gIH0pO1xuXG4gIGFzc2VydC5lcXVhbChyZXN1bHQub2ssIHRydWUpO1xuICBhc3NlcnQuZXF1YWwoXG4gICAgZXhpc3RzU3luYyhqb2luKGJhc2UsIFwiLmdpdFwiLCBcIk1FUkdFX0hFQURcIikpLFxuICAgIGZhbHNlLFxuICAgIFwicG9zdDogTUVSR0VfSEVBRCBjbGVhcmVkIGFmdGVyIHJlY29uY2lsaWF0aW9uXCIsXG4gICk7XG4gIGNvbnN0IG1lcmdlUmVwYWlyZWQgPSByZXN1bHQucmVwYWlyZWQuZmluZCgoZCkgPT4gZC5raW5kID09PSBcInVubWVyZ2VkLW1lcmdlLXN0YXRlXCIpO1xuICBhc3NlcnQub2sobWVyZ2VSZXBhaXJlZCwgXCJyZXBhaXJlZCBsaXN0IHNob3VsZCBpbmNsdWRlIHRoZSBtZXJnZS1zdGF0ZSBkcmlmdCByZWNvcmRcIik7XG4gIGlmIChtZXJnZVJlcGFpcmVkPy5raW5kID09PSBcInVubWVyZ2VkLW1lcmdlLXN0YXRlXCIpIHtcbiAgICBhc3NlcnQuZXF1YWwobWVyZ2VSZXBhaXJlZC5iYXNlUGF0aCwgYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiQURSLTAxNyAoIzU3MDEpOiBtZXJnZS1zdGF0ZSBkcmlmdCBpcyBkZXRlY3RlZCBpbiBsaW5rZWQgd29ya3RyZWVzXCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlR2l0QmFzZSgpO1xuICBjb25zdCB3b3JrdHJlZSA9IGpvaW4odG1wZGlyKCksIGBnc2QtYWRyMDE3LXdvcmt0cmVlLSR7cmFuZG9tVVVJRCgpfWApO1xuICB0LmFmdGVyKCgpID0+IHtcbiAgICBybVRyZWVRdWlldCh3b3JrdHJlZSk7XG4gICAgcm1UcmVlUXVpZXQoYmFzZSk7XG4gIH0pO1xuXG4gIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJjaGVja291dFwiLCBcIi1iXCIsIFwiZmVhdHVyZVwiXSwgeyBjd2Q6IGJhc2UsIHN0ZGlvOiBcImlnbm9yZVwiIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCJmZWF0dXJlLnR4dFwiKSwgXCJmZWF0dXJlIGNvbnRlbnRcIik7XG4gIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJhZGRcIiwgXCIuXCJdLCB7IGN3ZDogYmFzZSwgc3RkaW86IFwiaWdub3JlXCIgfSk7XG4gIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJjb21taXRcIiwgXCItbVwiLCBcImFkZCBmZWF0dXJlXCJdLCB7IGN3ZDogYmFzZSwgc3RkaW86IFwiaWdub3JlXCIgfSk7XG4gIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJjaGVja291dFwiLCBcIm1haW5cIl0sIHsgY3dkOiBiYXNlLCBzdGRpbzogXCJpZ25vcmVcIiB9KTtcbiAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcIndvcmt0cmVlXCIsIFwiYWRkXCIsIFwiLWJcIiwgXCJ3dC1tYWluXCIsIHdvcmt0cmVlLCBcIm1haW5cIl0sIHtcbiAgICBjd2Q6IGJhc2UsXG4gICAgc3RkaW86IFwiaWdub3JlXCIsXG4gIH0pO1xuICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wibWVyZ2VcIiwgXCItLW5vLWZmXCIsIFwiLS1uby1jb21taXRcIiwgXCJmZWF0dXJlXCJdLCB7XG4gICAgY3dkOiB3b3JrdHJlZSxcbiAgICBzdGRpbzogXCJpZ25vcmVcIixcbiAgfSk7XG5cbiAgY29uc3QgbWVyZ2VIZWFkUGF0aCA9IGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJyZXYtcGFyc2VcIiwgXCItLWdpdC1wYXRoXCIsIFwiTUVSR0VfSEVBRFwiXSwge1xuICAgIGN3ZDogd29ya3RyZWUsXG4gICAgZW5jb2Rpbmc6IFwidXRmLThcIixcbiAgfSkudHJpbSgpO1xuICBhc3NlcnQub2soZXhpc3RzU3luYyhtZXJnZUhlYWRQYXRoKSwgXCJwcmU6IE1FUkdFX0hFQUQgZXhpc3RzIGluIHJlc29sdmVkIHdvcmt0cmVlIGdpdGRpclwiKTtcbiAgYXNzZXJ0LmVxdWFsKGV4aXN0c1N5bmMoam9pbih3b3JrdHJlZSwgXCIuZ2l0XCIsIFwiTUVSR0VfSEVBRFwiKSksIGZhbHNlKTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCByZWNvbmNpbGVCZWZvcmVEaXNwYXRjaCh3b3JrdHJlZSwge1xuICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlOiAoKSA9PiB7fSxcbiAgICBkZXJpdmVTdGF0ZTogYXN5bmMgKCkgPT4gbWFrZVN0YXRlKCksXG4gIH0pO1xuXG4gIGFzc2VydC5lcXVhbChyZXN1bHQub2ssIHRydWUpO1xuICBhc3NlcnQuZXF1YWwoZXhpc3RzU3luYyhtZXJnZUhlYWRQYXRoKSwgZmFsc2UsIFwicG9zdDogTUVSR0VfSEVBRCBjbGVhcmVkIGFmdGVyIHJlY29uY2lsaWF0aW9uXCIpO1xuICBhc3NlcnQub2soXG4gICAgcmVzdWx0LnJlcGFpcmVkLnNvbWUoKGQpID0+IGQua2luZCA9PT0gXCJ1bm1lcmdlZC1tZXJnZS1zdGF0ZVwiKSxcbiAgICBcInJlcGFpcmVkIGxpc3Qgc2hvdWxkIGluY2x1ZGUgdGhlIHdvcmt0cmVlIG1lcmdlLXN0YXRlIGRyaWZ0IHJlY29yZFwiLFxuICApO1xufSk7XG5cbnRlc3QoXCJBRFItMDE3ICgjNTcwMSk6IG5vIG1lcmdlIHN0YXRlIFx1MjE5MiBkZXRlY3RvciByZXR1cm5zIG5vIGRyaWZ0XCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlR2l0QmFzZSgpO1xuICB0LmFmdGVyKCgpID0+IHJtVHJlZVF1aWV0KGJhc2UpKTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCByZWNvbmNpbGVCZWZvcmVEaXNwYXRjaChiYXNlLCB7XG4gICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGU6ICgpID0+IHt9LFxuICAgIGRlcml2ZVN0YXRlOiBhc3luYyAoKSA9PiBtYWtlU3RhdGUoKSxcbiAgfSk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5vaywgdHJ1ZSk7XG4gIGFzc2VydC5lcXVhbChcbiAgICByZXN1bHQucmVwYWlyZWQuc29tZSgoZCkgPT4gZC5raW5kID09PSBcInVubWVyZ2VkLW1lcmdlLXN0YXRlXCIpLFxuICAgIGZhbHNlLFxuICAgIFwibm8gbWVyZ2UgZHJpZnQgc2hvdWxkIGJlIHJlcG9ydGVkIHdoZW4gdGhlIHJlcG8gaXMgY2xlYW5cIixcbiAgKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgIzU3MDI6IHN0YWxlLXJlbmRlciBkcmlmdCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gY2xlYXJSZW5kZXJlckNhY2hlcygpOiB2b2lkIHtcbiAgY2xlYXJQYXJzZUNhY2hlKCk7XG4gIGNsZWFyUGF0aENhY2hlKCk7XG4gIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG59XG5cbmZ1bmN0aW9uIG1ha2VTdGFsZVBsYW5Db250ZW50KHNsaWNlSWQ6IHN0cmluZywgdGFza3M6IEFycmF5PHsgaWQ6IHN0cmluZzsgdGl0bGU6IHN0cmluZzsgZG9uZTogYm9vbGVhbiB9Pik6IHN0cmluZyB7XG4gIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBsaW5lcy5wdXNoKGAjICR7c2xpY2VJZH06IFRlc3QgU2xpY2VgKTtcbiAgbGluZXMucHVzaChcIlwiKTtcbiAgbGluZXMucHVzaChcIioqR29hbDoqKiBUZXN0IHNsaWNlIGdvYWxcIik7XG4gIGxpbmVzLnB1c2goXCIqKkRlbW86KiogVGVzdCBkZW1vXCIpO1xuICBsaW5lcy5wdXNoKFwiXCIpO1xuICBsaW5lcy5wdXNoKFwiIyMgTXVzdC1IYXZlc1wiKTtcbiAgbGluZXMucHVzaChcIlwiKTtcbiAgbGluZXMucHVzaChcIi0gRXZlcnl0aGluZyB3b3Jrc1wiKTtcbiAgbGluZXMucHVzaChcIlwiKTtcbiAgbGluZXMucHVzaChcIiMjIFRhc2tzXCIpO1xuICBsaW5lcy5wdXNoKFwiXCIpO1xuICBmb3IgKGNvbnN0IHQgb2YgdGFza3MpIHtcbiAgICBjb25zdCBjaGVja2JveCA9IHQuZG9uZSA/IFwiW3hdXCIgOiBcIlsgXVwiO1xuICAgIGxpbmVzLnB1c2goYC0gJHtjaGVja2JveH0gKioke3QuaWR9OiAke3QudGl0bGV9KiogXFxgZXN0OjFoXFxgYCk7XG4gIH1cbiAgbGluZXMucHVzaChcIlwiKTtcbiAgcmV0dXJuIGxpbmVzLmpvaW4oXCJcXG5cIik7XG59XG5cbmZ1bmN0aW9uIG1ha2VTdGFsZVJvYWRtYXBDb250ZW50KHNsaWNlczogQXJyYXk8eyBpZDogc3RyaW5nOyB0aXRsZTogc3RyaW5nOyBkb25lOiBib29sZWFuIH0+KTogc3RyaW5nIHtcbiAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG4gIGxpbmVzLnB1c2goXCIjIE0wMDEgUm9hZG1hcFwiKTtcbiAgbGluZXMucHVzaChcIlwiKTtcbiAgbGluZXMucHVzaChcIioqVmlzaW9uOioqIFRlc3QgbWlsZXN0b25lXCIpO1xuICBsaW5lcy5wdXNoKFwiXCIpO1xuICBsaW5lcy5wdXNoKFwiIyMgU2xpY2VzXCIpO1xuICBsaW5lcy5wdXNoKFwiXCIpO1xuICBmb3IgKGNvbnN0IHMgb2Ygc2xpY2VzKSB7XG4gICAgY29uc3QgY2hlY2tib3ggPSBzLmRvbmUgPyBcIlt4XVwiIDogXCJbIF1cIjtcbiAgICBsaW5lcy5wdXNoKGAtICR7Y2hlY2tib3h9ICoqJHtzLmlkfTogJHtzLnRpdGxlfSoqIFxcYHJpc2s6bWVkaXVtXFxgIFxcYGRlcGVuZHM6W11cXGBgKTtcbiAgfVxuICBsaW5lcy5wdXNoKFwiXCIpO1xuICByZXR1cm4gbGluZXMuam9pbihcIlxcblwiKTtcbn1cblxudGVzdChcIkFEUi0wMTcgKCM1NzAyKTogc3RhbGUtcmVuZGVyIGRyaWZ0IGRldGVjdGVkIGFuZCByZXBhaXJlZCBlbmQtdG8tZW5kXCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1hZHIwMTctcmVuZGVyLVwiKSk7XG4gIGNvbnN0IHNsaWNlRGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiKTtcbiAgbWtkaXJTeW5jKGpvaW4oc2xpY2VEaXIsIFwidGFza3NcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB0LmFmdGVyKCgpID0+IHtcbiAgICB0cnkgeyBjbG9zZURhdGFiYXNlKCk7IH0gY2F0Y2ggeyAvKiBub29wICovIH1cbiAgICBybVRyZWVRdWlldChiYXNlKTtcbiAgfSk7XG5cbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpKTtcbiAgY2xlYXJSZW5kZXJlckNhY2hlcygpO1xuICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuICBpbnNlcnRTbGljZSh7IGlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHRpdGxlOiBcIlNsaWNlXCIsIHN0YXR1czogXCJwZW5kaW5nXCIgfSk7XG4gIGluc2VydFRhc2soeyBpZDogXCJUMDFcIiwgc2xpY2VJZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJGaXJzdCB0YXNrXCIsIHN0YXR1czogXCJkb25lXCIgfSk7XG4gIGluc2VydFRhc2soeyBpZDogXCJUMDJcIiwgc2xpY2VJZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJTZWNvbmQgdGFza1wiLCBzdGF0dXM6IFwiZG9uZVwiIH0pO1xuXG4gIC8vIFBsYW4gd2l0aCBib3RoIHRhc2tzIHVuY2hlY2tlZCBcdTIwMTQgREIgc2F5cyBkb25lLCBmaWxlIGRpc2FncmVlcy5cbiAgY29uc3QgcGxhblBhdGggPSBqb2luKHNsaWNlRGlyLCBcIlMwMS1QTEFOLm1kXCIpO1xuICB3cml0ZUZpbGVTeW5jKHBsYW5QYXRoLCBtYWtlU3RhbGVQbGFuQ29udGVudChcIlMwMVwiLCBbXG4gICAgeyBpZDogXCJUMDFcIiwgdGl0bGU6IFwiRmlyc3QgdGFza1wiLCBkb25lOiBmYWxzZSB9LFxuICAgIHsgaWQ6IFwiVDAyXCIsIHRpdGxlOiBcIlNlY29uZCB0YXNrXCIsIGRvbmU6IGZhbHNlIH0sXG4gIF0pKTtcbiAgY2xlYXJSZW5kZXJlckNhY2hlcygpO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlY29uY2lsZUJlZm9yZURpc3BhdGNoKGJhc2UsIHtcbiAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZTogKCkgPT4ge30sXG4gICAgZGVyaXZlU3RhdGU6IGFzeW5jICgpID0+IG1ha2VTdGF0ZSgpLFxuICB9KTtcblxuICBhc3NlcnQuZXF1YWwocmVzdWx0Lm9rLCB0cnVlKTtcbiAgY29uc3QgcmVuZGVyUmVwYWlyZWQgPSByZXN1bHQucmVwYWlyZWQuZmluZCgoZCkgPT4gZC5raW5kID09PSBcInN0YWxlLXJlbmRlclwiKTtcbiAgYXNzZXJ0Lm9rKHJlbmRlclJlcGFpcmVkLCBcInJlcGFpcmVkIGxpc3Qgc2hvdWxkIGluY2x1ZGUgdGhlIHN0YWxlLXJlbmRlciBkcmlmdFwiKTtcblxuICBjb25zdCByZXBhaXJlZENvbnRlbnQgPSByZWFkRmlsZVN5bmMocGxhblBhdGgsIFwidXRmLThcIik7XG4gIGFzc2VydC5tYXRjaChyZXBhaXJlZENvbnRlbnQsIC9cXFt4XFxdW15cXG5dKlQwMTovLCBcIlQwMSBjaGVja2JveCBzaG91bGQgYmUgY2hlY2tlZCBhZnRlciByZXBhaXJcIik7XG4gIGFzc2VydC5tYXRjaChyZXBhaXJlZENvbnRlbnQsIC9cXFt4XFxdW15cXG5dKlQwMjovLCBcIlQwMiBjaGVja2JveCBzaG91bGQgYmUgY2hlY2tlZCBhZnRlciByZXBhaXJcIik7XG59KTtcblxudGVzdChcIkFEUi0wMTcgKCM1NzAyKTogc3RhbGUtcmVuZGVyIGRldGVjdG9yIHJlYXNvbiBzdHJpbmdzIG1hdGNoIHJlcGFpciBjb250cmFjdFwiLCAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtYWRyMDE3LXJlbmRlci1yZWFzb25zLVwiKSk7XG4gIGNvbnN0IHNsaWNlRGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiKTtcbiAgbWtkaXJTeW5jKGpvaW4oc2xpY2VEaXIsIFwidGFza3NcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB0LmFmdGVyKCgpID0+IHtcbiAgICB0cnkgeyBjbG9zZURhdGFiYXNlKCk7IH0gY2F0Y2ggeyAvKiBub29wICovIH1cbiAgICBybVRyZWVRdWlldChiYXNlKTtcbiAgfSk7XG5cbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpKTtcbiAgY2xlYXJSZW5kZXJlckNhY2hlcygpO1xuICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuICBpbnNlcnRTbGljZSh7IGlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHRpdGxlOiBcIlNsaWNlXCIsIHN0YXR1czogXCJjb21wbGV0ZVwiIH0pO1xuICBpbnNlcnRUYXNrKHtcbiAgICBpZDogXCJUMDFcIixcbiAgICBzbGljZUlkOiBcIlMwMVwiLFxuICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICB0aXRsZTogXCJGaXJzdCB0YXNrXCIsXG4gICAgc3RhdHVzOiBcImRvbmVcIixcbiAgICBmdWxsU3VtbWFyeU1kOiBcIiMgVDAxIFN1bW1hcnlcXG5cIixcbiAgfSk7XG4gIHNldFNsaWNlU3VtbWFyeU1kKFwiTTAwMVwiLCBcIlMwMVwiLCBcIiMgUzAxIFN1bW1hcnlcXG5cIiwgXCIjIFMwMSBVQVRcXG5cIik7XG5cbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwiTTAwMS1ST0FETUFQLm1kXCIpLFxuICAgIG1ha2VTdGFsZVJvYWRtYXBDb250ZW50KFt7IGlkOiBcIlMwMVwiLCB0aXRsZTogXCJTbGljZVwiLCBkb25lOiBmYWxzZSB9XSksXG4gICk7XG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihzbGljZURpciwgXCJTMDEtUExBTi5tZFwiKSxcbiAgICBtYWtlU3RhbGVQbGFuQ29udGVudChcIlMwMVwiLCBbeyBpZDogXCJUMDFcIiwgdGl0bGU6IFwiRmlyc3QgdGFza1wiLCBkb25lOiBmYWxzZSB9XSksXG4gICk7XG4gIGNsZWFyUmVuZGVyZXJDYWNoZXMoKTtcblxuICBjb25zdCByZWFzb25zID0gZGV0ZWN0U3RhbGVSZW5kZXJzKGJhc2UpLm1hcCgoZW50cnkpID0+IGVudHJ5LnJlYXNvbikuc29ydCgpO1xuXG4gIGFzc2VydC5kZWVwRXF1YWwocmVhc29ucywgW1xuICAgIFwiUzAxIGlzIGNsb3NlZCBpbiBEQiBidXQgdW5jaGVja2VkIGluIHJvYWRtYXBcIixcbiAgICBcIlMwMSBpcyBjb21wbGV0ZSB3aXRoIFVBVCBpbiBEQiBidXQgVUFULm1kIG1pc3Npbmcgb24gZGlza1wiLFxuICAgIFwiUzAxIGlzIGNvbXBsZXRlIHdpdGggc3VtbWFyeSBpbiBEQiBidXQgU1VNTUFSWS5tZCBtaXNzaW5nIG9uIGRpc2tcIixcbiAgICBcIlQwMSBpcyBjb21wbGV0ZSB3aXRoIHN1bW1hcnkgaW4gREIgYnV0IFNVTU1BUlkubWQgbWlzc2luZyBvbiBkaXNrXCIsXG4gICAgXCJUMDEgaXMgZG9uZSBpbiBEQiBidXQgdW5jaGVja2VkIGluIHBsYW5cIixcbiAgXS5zb3J0KCkpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCAjNTcwMzogc3RhbGUtd29ya2VyIGRyaWZ0IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5jb25zdCBERUFEX1BJRCA9IDk5OV85OTlfOTk5OyAvLyBmYXIgYWJvdmUgYW55IHJlYWxpc3RpYyBzeXN0ZW0gUElEOyBwcm9jZXNzLmtpbGwocGlkLCAwKSBcdTIxOTIgRVNSQ0hcblxuZnVuY3Rpb24gd3JpdGVGYWtlU2Vzc2lvbkxvY2soYmFzZTogc3RyaW5nLCBwaWQ6IG51bWJlcik6IHN0cmluZyB7XG4gIGNvbnN0IGdzZERpciA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIpO1xuICBta2RpclN5bmMoZ3NkRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgY29uc3QgbG9ja0ZpbGUgPSBqb2luKGdzZERpciwgXCJhdXRvLmxvY2tcIik7XG4gIC8vIE1pcnJvciBTZXNzaW9uTG9ja0RhdGEgbWluaW11bSBzaGFwZVxuICB3cml0ZUZpbGVTeW5jKFxuICAgIGxvY2tGaWxlLFxuICAgIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgIHBpZCxcbiAgICAgIHN0YXJ0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgdW5pdFR5cGU6IFwic3RhcnRpbmdcIixcbiAgICAgIHVuaXRJZDogXCJib290c3RyYXBcIixcbiAgICB9KSxcbiAgKTtcbiAgLy8gQWxzbyBjcmVhdGUgdGhlIHByb3Blci1sb2NrZmlsZSBkaXJlY3RvcnkgYXJ0aWZhY3QgYXQgPGdzZERpcj4ubG9ja1xuICBta2RpclN5bmMoYCR7Z3NkRGlyfS5sb2NrYCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHJldHVybiBsb2NrRmlsZTtcbn1cblxudGVzdChcIkFEUi0wMTcgKCM1NzAzKTogc3RhbGUtd29ya2VyIGRyaWZ0IGRldGVjdGVkIGFuZCBvcnBoYW5lZCBsb2NrIGNsZWFyZWRcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLWFkcjAxNy13b3JrZXItXCIpKTtcbiAgdC5hZnRlcigoKSA9PiBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcblxuICBjb25zdCBsb2NrRmlsZSA9IHdyaXRlRmFrZVNlc3Npb25Mb2NrKGJhc2UsIERFQURfUElEKTtcbiAgYXNzZXJ0Lm9rKGV4aXN0c1N5bmMobG9ja0ZpbGUpLCBcInByZTogbG9jayBmaWxlIHdyaXR0ZW5cIik7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVjb25jaWxlQmVmb3JlRGlzcGF0Y2goYmFzZSwge1xuICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlOiAoKSA9PiB7fSxcbiAgICBkZXJpdmVTdGF0ZTogYXN5bmMgKCkgPT4gbWFrZVN0YXRlKCksXG4gIH0pO1xuXG4gIGFzc2VydC5lcXVhbChyZXN1bHQub2ssIHRydWUpO1xuICBhc3NlcnQuZXF1YWwoZXhpc3RzU3luYyhsb2NrRmlsZSksIGZhbHNlLCBcInBvc3Q6IG9ycGhhbmVkIGxvY2sgZmlsZSByZW1vdmVkXCIpO1xuICBjb25zdCB3b3JrZXJSZXBhaXJlZCA9IHJlc3VsdC5yZXBhaXJlZC5maW5kKChkKSA9PiBkLmtpbmQgPT09IFwic3RhbGUtd29ya2VyXCIpO1xuICBhc3NlcnQub2sod29ya2VyUmVwYWlyZWQsIFwicmVwYWlyZWQgbGlzdCBzaG91bGQgaW5jbHVkZSB0aGUgc3RhbGUtd29ya2VyIGRyaWZ0XCIpO1xuICBpZiAod29ya2VyUmVwYWlyZWQ/LmtpbmQgPT09IFwic3RhbGUtd29ya2VyXCIpIHtcbiAgICBhc3NlcnQuZXF1YWwod29ya2VyUmVwYWlyZWQucGlkLCBERUFEX1BJRCk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiQURSLTAxNyAoIzU3MDMpOiBsaXZlIHdvcmtlciBsb2NrIGlzIG5vdCBjbGVhcmVkXCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1hZHIwMTctd29ya2VyLWxpdmUtXCIpKTtcbiAgdC5hZnRlcigoKSA9PiBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcblxuICAvLyBQSUQgMSAoaW5pdC9sYXVuY2hkKTogcHJvY2Vzcy5raWxsKDEsIDApIHJldHVybnMgRVBFUk0gYXMgbm9uLXJvb3QsIHdoaWNoXG4gIC8vIGlzUGlkQWxpdmUgY29ycmVjdGx5IHRyZWF0cyBhcyBhbGl2ZS4gcHJvY2Vzcy5waWQgd291bGQgYmUgcmVqZWN0ZWQgYnkgdGhlXG4gIC8vIHNlbGYtUElEIGd1YXJkIGluIGlzUGlkQWxpdmUgKHRyZWF0ZWQgYXMgbm90IGFsaXZlKS5cbiAgY29uc3QgQUxJVkVfUElEID0gMTtcbiAgY29uc3QgbG9ja0ZpbGUgPSB3cml0ZUZha2VTZXNzaW9uTG9jayhiYXNlLCBBTElWRV9QSUQpO1xuICBhc3NlcnQub2soZXhpc3RzU3luYyhsb2NrRmlsZSksIFwicHJlOiBsb2NrIGZpbGUgd3JpdHRlblwiKTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCByZWNvbmNpbGVCZWZvcmVEaXNwYXRjaChiYXNlLCB7XG4gICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGU6ICgpID0+IHt9LFxuICAgIGRlcml2ZVN0YXRlOiBhc3luYyAoKSA9PiBtYWtlU3RhdGUoKSxcbiAgfSk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5vaywgdHJ1ZSk7XG4gIGFzc2VydC5lcXVhbChcbiAgICBleGlzdHNTeW5jKGxvY2tGaWxlKSxcbiAgICB0cnVlLFxuICAgIFwibGl2ZSBsb2NrIG11c3QgTk9UIGJlIGNsZWFyZWQgKHdvdWxkIHN0ZWFsIHRoZSBsb2NrIGZyb20gYSBydW5uaW5nIHNlc3Npb24pXCIsXG4gICk7XG4gIGFzc2VydC5lcXVhbChcbiAgICByZXN1bHQucmVwYWlyZWQuc29tZSgoZCkgPT4gZC5raW5kID09PSBcInN0YWxlLXdvcmtlclwiKSxcbiAgICBmYWxzZSxcbiAgICBcIm5vIHN0YWxlLXdvcmtlciBkcmlmdCBzaG91bGQgYmUgcmVwb3J0ZWQgd2hlbiB0aGUgbG9jayBvd25lciBpcyBhbGl2ZVwiLFxuICApO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCAjNTcwNDogdW5yZWdpc3RlcmVkLW1pbGVzdG9uZSBkcmlmdCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcIkFEUi0wMTcgKCM1NzA0KTogdW5yZWdpc3RlcmVkLW1pbGVzdG9uZSBkcmlmdCBkZXRlY3RlZCBhbmQgREIgcm93IGluc2VydGVkXCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1hZHIwMTctcHJvam1kLVwiKSk7XG4gIGNvbnN0IG1pbGVzdG9uZURpciA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wNDJcIik7XG4gIG1rZGlyU3luYyhtaWxlc3RvbmVEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAvLyBSb2FkbWFwIHdpdGggb25lIHNsaWNlIFx1MjAxNCBtZWFuaW5nZnVsIGNvbnRlbnQsIHdpbGwgYmUgcGlja2VkIHVwIGJ5IGltcG9ydGVyXG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihtaWxlc3RvbmVEaXIsIFwiTTA0Mi1ST0FETUFQLm1kXCIpLFxuICAgIFtcbiAgICAgIFwiIyBNMDQyOiBUZXN0IE1pbGVzdG9uZVwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiKipWaXNpb246KiogVmVyaWZ5IHVucmVnaXN0ZXJlZC1taWxlc3RvbmUgZHJpZnRcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFNsaWNlc1wiLFxuICAgICAgXCJcIixcbiAgICAgIFwiLSBbIF0gKipTMDE6IEZvdW5kYXRpb24qKiBgcmlzazptZWRpdW1gIGBkZXBlbmRzOltdYFwiLFxuICAgICAgXCJcIixcbiAgICBdLmpvaW4oXCJcXG5cIiksXG4gICk7XG4gIHQuYWZ0ZXIoKCkgPT4ge1xuICAgIHRyeSB7IGNsb3NlRGF0YWJhc2UoKTsgfSBjYXRjaCB7IC8qIG5vb3AgKi8gfVxuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH0pO1xuXG4gIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsIFwiLmdzZFwiLCBcImdzZC5kYlwiKSk7XG4gIC8vIFByZS1jb25kaXRpb246IGZpbGVzeXN0ZW0gaGFzIHRoZSBtaWxlc3RvbmUsIERCIGRvZXMgTk9ULlxuICBhc3NlcnQuZXF1YWwoZ2V0TWlsZXN0b25lKFwiTTA0MlwiKSwgbnVsbCwgXCJwcmU6IERCIGhhcyBubyByb3cgZm9yIE0wNDJcIik7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVjb25jaWxlQmVmb3JlRGlzcGF0Y2goYmFzZSwge1xuICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlOiAoKSA9PiB7fSxcbiAgICBkZXJpdmVTdGF0ZTogYXN5bmMgKCkgPT4gbWFrZVN0YXRlKCksXG4gIH0pO1xuXG4gIGFzc2VydC5lcXVhbChyZXN1bHQub2ssIHRydWUpO1xuICBhc3NlcnQub2soZ2V0TWlsZXN0b25lKFwiTTA0MlwiKSwgXCJwb3N0OiBEQiByb3cgaW5zZXJ0ZWQgZm9yIE0wNDJcIik7XG4gIGNvbnN0IG1pbGVzdG9uZVJlcGFpcmVkID0gcmVzdWx0LnJlcGFpcmVkLmZpbmQoXG4gICAgKGQpID0+IGQua2luZCA9PT0gXCJ1bnJlZ2lzdGVyZWQtbWlsZXN0b25lXCIsXG4gICk7XG4gIGFzc2VydC5vayhtaWxlc3RvbmVSZXBhaXJlZCwgXCJyZXBhaXJlZCBsaXN0IHNob3VsZCBpbmNsdWRlIHRoZSB1bnJlZ2lzdGVyZWQtbWlsZXN0b25lIGRyaWZ0XCIpO1xuICBpZiAobWlsZXN0b25lUmVwYWlyZWQ/LmtpbmQgPT09IFwidW5yZWdpc3RlcmVkLW1pbGVzdG9uZVwiKSB7XG4gICAgYXNzZXJ0LmVxdWFsKG1pbGVzdG9uZVJlcGFpcmVkLm1pbGVzdG9uZUlkLCBcIk0wNDJcIik7XG4gIH1cbn0pO1xuXG50ZXN0KFwiQURSLTAxNyAoIzU3MDQpOiByZWdpc3RlcmVkIG1pbGVzdG9uZSAoREIgcm93IHByZXNlbnQpIFx1MjE5MiBubyBkcmlmdFwiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtYWRyMDE3LXByb2ptZC1jbGVhbi1cIikpO1xuICBjb25zdCBtaWxlc3RvbmVEaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIpO1xuICBta2RpclN5bmMobWlsZXN0b25lRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKG1pbGVzdG9uZURpciwgXCJNMDAxLVJPQURNQVAubWRcIiksXG4gICAgW1xuICAgICAgXCIjIE0wMDE6IFRlc3RcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIioqVmlzaW9uOioqIEFscmVhZHktcmVnaXN0ZXJlZCBtaWxlc3RvbmVcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFNsaWNlc1wiLFxuICAgICAgXCJcIixcbiAgICAgIFwiLSBbIF0gKipTMDE6IFNsaWNlKiogYHJpc2s6bG93YCBgZGVwZW5kczpbXWBcIixcbiAgICAgIFwiXCIsXG4gICAgXS5qb2luKFwiXFxuXCIpLFxuICApO1xuICB0LmFmdGVyKCgpID0+IHtcbiAgICB0cnkgeyBjbG9zZURhdGFiYXNlKCk7IH0gY2F0Y2ggeyAvKiBub29wICovIH1cbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcblxuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJnc2QuZGJcIikpO1xuICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlY29uY2lsZUJlZm9yZURpc3BhdGNoKGJhc2UsIHtcbiAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZTogKCkgPT4ge30sXG4gICAgZGVyaXZlU3RhdGU6IGFzeW5jICgpID0+IG1ha2VTdGF0ZSgpLFxuICB9KTtcblxuICBhc3NlcnQuZXF1YWwocmVzdWx0Lm9rLCB0cnVlKTtcbiAgYXNzZXJ0LmVxdWFsKFxuICAgIHJlc3VsdC5yZXBhaXJlZC5zb21lKChkKSA9PiBkLmtpbmQgPT09IFwidW5yZWdpc3RlcmVkLW1pbGVzdG9uZVwiKSxcbiAgICBmYWxzZSxcbiAgICBcIm5vIGRyaWZ0IHNob3VsZCBiZSByZXBvcnRlZCB3aGVuIHRoZSBtaWxlc3RvbmUgaXMgYWxyZWFkeSBpbiB0aGUgREJcIixcbiAgKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgIzU3MDU6IHJvYWRtYXAtZGl2ZXJnZW5jZSBkcmlmdCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcIkFEUi0wMTcgKCM1NzA1KTogcm9hZG1hcC1kaXZlcmdlbmNlIGRyaWZ0IGRldGVjdGVkIGFuZCBEQiBkZXBlbmRzIHN5bmNlZFwiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtYWRyMDE3LXJvYWRtYXAtXCIpKTtcbiAgY29uc3QgbWlsZXN0b25lRGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiKTtcbiAgbWtkaXJTeW5jKG1pbGVzdG9uZURpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIC8vIFJPQURNQVAubWQgZGVjbGFyZXMgUzAyIGRlcGVuZHMgb24gW1MwMV1cbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKG1pbGVzdG9uZURpciwgXCJNMDAxLVJPQURNQVAubWRcIiksXG4gICAgW1xuICAgICAgXCIjIE0wMDE6IFRlc3RcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIioqVmlzaW9uOioqIFZlcmlmeSByb2FkbWFwLWRpdmVyZ2VuY2UgZHJpZnRcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFNsaWNlc1wiLFxuICAgICAgXCJcIixcbiAgICAgIFwiLSBbIF0gKipTMDE6IEZvdW5kYXRpb24qKiBgcmlzazptZWRpdW1gIGBkZXBlbmRzOltdYFwiLFxuICAgICAgXCItIFsgXSAqKlMwMjogRmVhdHVyZSoqIGByaXNrOm1lZGl1bWAgYGRlcGVuZHM6W1MwMV1gXCIsXG4gICAgICBcIlwiLFxuICAgIF0uam9pbihcIlxcblwiKSxcbiAgKTtcbiAgdC5hZnRlcigoKSA9PiB7XG4gICAgdHJ5IHsgY2xvc2VEYXRhYmFzZSgpOyB9IGNhdGNoIHsgLyogbm9vcCAqLyB9XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfSk7XG5cbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpKTtcbiAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIsIHN0YXR1czogXCJhY3RpdmVcIiB9KTtcbiAgLy8gU2VlZCBEQiB3aXRoIFMwMiBkZXBlbmRpbmcgb24gW10gIFx1MjAxNCBkaXZlcmdlcyBmcm9tIFJPQURNQVAubWRcbiAgaW5zZXJ0U2xpY2UoeyBpZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJGb3VuZGF0aW9uXCIsIHN0YXR1czogXCJwZW5kaW5nXCIsIHJpc2s6IFwibWVkaXVtXCIsIGRlcGVuZHM6IFtdLCBkZW1vOiBcIlwiLCBzZXF1ZW5jZTogMSB9KTtcbiAgaW5zZXJ0U2xpY2UoeyBpZDogXCJTMDJcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJGZWF0dXJlXCIsIHN0YXR1czogXCJwZW5kaW5nXCIsIHJpc2s6IFwibWVkaXVtXCIsIGRlcGVuZHM6IFtdLCBkZW1vOiBcIlwiLCBzZXF1ZW5jZTogMiB9KTtcblxuICBhc3NlcnQuZGVlcEVxdWFsKGdldFNsaWNlKFwiTTAwMVwiLCBcIlMwMlwiKT8uZGVwZW5kcywgW10sIFwicHJlOiBEQiBoYXMgUzAyLmRlcGVuZHMgPSBbXVwiKTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCByZWNvbmNpbGVCZWZvcmVEaXNwYXRjaChiYXNlLCB7XG4gICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGU6ICgpID0+IHt9LFxuICAgIGRlcml2ZVN0YXRlOiBhc3luYyAoKSA9PiBtYWtlU3RhdGUoKSxcbiAgfSk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5vaywgdHJ1ZSk7XG4gIGFzc2VydC5kZWVwRXF1YWwoZ2V0U2xpY2UoXCJNMDAxXCIsIFwiUzAyXCIpPy5kZXBlbmRzLCBbXCJTMDFcIl0sIFwicG9zdDogREIgZGVwZW5kcyBtYXRjaGVzIFJPQURNQVAubWRcIik7XG4gIGNvbnN0IHJvYWRtYXBSZXBhaXJlZCA9IHJlc3VsdC5yZXBhaXJlZC5maW5kKChkKSA9PiBkLmtpbmQgPT09IFwicm9hZG1hcC1kaXZlcmdlbmNlXCIpO1xuICBhc3NlcnQub2socm9hZG1hcFJlcGFpcmVkLCBcInJlcGFpcmVkIGxpc3Qgc2hvdWxkIGluY2x1ZGUgdGhlIHJvYWRtYXAtZGl2ZXJnZW5jZSBkcmlmdFwiKTtcbiAgaWYgKHJvYWRtYXBSZXBhaXJlZD8ua2luZCA9PT0gXCJyb2FkbWFwLWRpdmVyZ2VuY2VcIikge1xuICAgIGFzc2VydC5lcXVhbChyb2FkbWFwUmVwYWlyZWQubWlsZXN0b25lSWQsIFwiTTAwMVwiKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJBRFItMDE3ICgjNTcwNSk6IFJPQURNQVAgZGVjbGFyZXMgc2xpY2UgbWlzc2luZyBmcm9tIERCIFx1MjE5MiBzbGljZSBpbnNlcnRlZCBhbmQgZHJpZnQgcmVwb3J0ZWRcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLWFkcjAxNy1yb2FkbWFwLW5ld3NsaWNlLVwiKSk7XG4gIGNvbnN0IG1pbGVzdG9uZURpciA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIik7XG4gIG1rZGlyU3luYyhtaWxlc3RvbmVEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAvLyBST0FETUFQLm1kIGRlY2xhcmVzIFMwMSBhbmQgUzAyOyBEQiB3aWxsIG9ubHkgaGF2ZSBTMDEuXG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihtaWxlc3RvbmVEaXIsIFwiTTAwMS1ST0FETUFQLm1kXCIpLFxuICAgIFtcbiAgICAgIFwiIyBNMDAxOiBUZXN0XCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIqKlZpc2lvbjoqKiBWZXJpZnkgbmV3LXNsaWNlIGluc2VydGlvbiB2aWEgcm9hZG1hcC1kaXZlcmdlbmNlIHJlcGFpclwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMgU2xpY2VzXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCItIFsgXSAqKlMwMTogRm91bmRhdGlvbioqIGByaXNrOm1lZGl1bWAgYGRlcGVuZHM6W11gXCIsXG4gICAgICBcIi0gWyBdICoqUzAyOiBGZWF0dXJlKiogYHJpc2s6bWVkaXVtYCBgZGVwZW5kczpbUzAxXWBcIixcbiAgICAgIFwiXCIsXG4gICAgXS5qb2luKFwiXFxuXCIpLFxuICApO1xuICB0LmFmdGVyKCgpID0+IHtcbiAgICB0cnkgeyBjbG9zZURhdGFiYXNlKCk7IH0gY2F0Y2ggeyAvKiBub29wICovIH1cbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcblxuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJnc2QuZGJcIikpO1xuICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuICAvLyBPbmx5IGluc2VydCBTMDEgXHUyMDE0IFMwMiBpcyBpbnRlbnRpb25hbGx5IGFic2VudCBmcm9tIHRoZSBEQi5cbiAgaW5zZXJ0U2xpY2UoeyBpZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJGb3VuZGF0aW9uXCIsIHN0YXR1czogXCJwZW5kaW5nXCIsIHJpc2s6IFwibWVkaXVtXCIsIGRlcGVuZHM6IFtdLCBkZW1vOiBcIlwiLCBzZXF1ZW5jZTogMSB9KTtcblxuICBhc3NlcnQuZXF1YWwoZ2V0U2xpY2UoXCJNMDAxXCIsIFwiUzAyXCIpLCBudWxsLCBcInByZTogUzAyIGhhcyBubyBEQiByb3dcIik7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVjb25jaWxlQmVmb3JlRGlzcGF0Y2goYmFzZSwge1xuICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlOiAoKSA9PiB7fSxcbiAgICBkZXJpdmVTdGF0ZTogYXN5bmMgKCkgPT4gbWFrZVN0YXRlKCksXG4gIH0pO1xuXG4gIGFzc2VydC5lcXVhbChyZXN1bHQub2ssIHRydWUpO1xuICBjb25zdCBzMDIgPSBnZXRTbGljZShcIk0wMDFcIiwgXCJTMDJcIik7XG4gIGFzc2VydC5vayhzMDIsIFwicG9zdDogUzAyIGluc2VydGVkIGludG8gREIgYWZ0ZXIgcmVwYWlyXCIpO1xuICBhc3NlcnQuZXF1YWwoczAyPy5zZXF1ZW5jZSwgMiwgXCJwb3N0OiBTMDIgc2VxdWVuY2UgbWF0Y2hlcyBST0FETUFQIG9yZGVyXCIpO1xuICBhc3NlcnQuZGVlcEVxdWFsKHMwMj8uZGVwZW5kcywgW1wiUzAxXCJdLCBcInBvc3Q6IFMwMiBkZXBlbmRzIG1hdGNoZXMgUk9BRE1BUFwiKTtcbiAgY29uc3Qgcm9hZG1hcFJlcGFpcmVkID0gcmVzdWx0LnJlcGFpcmVkLmZpbmQoKGQpID0+IGQua2luZCA9PT0gXCJyb2FkbWFwLWRpdmVyZ2VuY2VcIik7XG4gIGFzc2VydC5vayhyb2FkbWFwUmVwYWlyZWQsIFwicmVwYWlyZWQgbGlzdCBzaG91bGQgaW5jbHVkZSB0aGUgcm9hZG1hcC1kaXZlcmdlbmNlIGRyaWZ0XCIpO1xuICBpZiAocm9hZG1hcFJlcGFpcmVkPy5raW5kID09PSBcInJvYWRtYXAtZGl2ZXJnZW5jZVwiKSB7XG4gICAgYXNzZXJ0LmVxdWFsKHJvYWRtYXBSZXBhaXJlZC5taWxlc3RvbmVJZCwgXCJNMDAxXCIpO1xuICB9XG59KTtcblxudGVzdChcIkFEUi0wMTcgKCM1NzA1KTogaW4tc3luYyBST0FETUFQIGFuZCBEQiBcdTIxOTIgbm8gcm9hZG1hcC1kaXZlcmdlbmNlIGRyaWZ0XCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1hZHIwMTctcm9hZG1hcC1jbGVhbi1cIikpO1xuICBjb25zdCBtaWxlc3RvbmVEaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIpO1xuICBta2RpclN5bmMobWlsZXN0b25lRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKG1pbGVzdG9uZURpciwgXCJNMDAxLVJPQURNQVAubWRcIiksXG4gICAgW1xuICAgICAgXCIjIE0wMDE6IFRlc3RcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIioqVmlzaW9uOioqIEFscmVhZHkgaW4gc3luY1wiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMgU2xpY2VzXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCItIFsgXSAqKlMwMTogRm91bmRhdGlvbioqIGByaXNrOmxvd2AgYGRlcGVuZHM6W11gXCIsXG4gICAgICBcIlwiLFxuICAgIF0uam9pbihcIlxcblwiKSxcbiAgKTtcbiAgdC5hZnRlcigoKSA9PiB7XG4gICAgdHJ5IHsgY2xvc2VEYXRhYmFzZSgpOyB9IGNhdGNoIHsgLyogbm9vcCAqLyB9XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfSk7XG5cbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpKTtcbiAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIsIHN0YXR1czogXCJhY3RpdmVcIiB9KTtcbiAgaW5zZXJ0U2xpY2UoeyBpZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJGb3VuZGF0aW9uXCIsIHN0YXR1czogXCJwZW5kaW5nXCIsIHJpc2s6IFwibG93XCIsIGRlcGVuZHM6IFtdLCBkZW1vOiBcIlwiLCBzZXF1ZW5jZTogMSB9KTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCByZWNvbmNpbGVCZWZvcmVEaXNwYXRjaChiYXNlLCB7XG4gICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGU6ICgpID0+IHt9LFxuICAgIGRlcml2ZVN0YXRlOiBhc3luYyAoKSA9PiBtYWtlU3RhdGUoKSxcbiAgfSk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5vaywgdHJ1ZSk7XG4gIGFzc2VydC5lcXVhbChcbiAgICByZXN1bHQucmVwYWlyZWQuc29tZSgoZCkgPT4gZC5raW5kID09PSBcInJvYWRtYXAtZGl2ZXJnZW5jZVwiKSxcbiAgICBmYWxzZSxcbiAgICBcIm5vIHJvYWRtYXAtZGl2ZXJnZW5jZSBkcmlmdCBzaG91bGQgYmUgcmVwb3J0ZWQgd2hlbiBEQiBtYXRjaGVzIG1hcmtkb3duXCIsXG4gICk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwICM1NzA2OiBtaXNzaW5nLWNvbXBsZXRpb24tdGltZXN0YW1wIGRyaWZ0IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiQURSLTAxNyAoIzU3MDYpOiB0YXNrIHdpdGggU1VNTUFSWSBidXQgbnVsbCBjb21wbGV0ZWRfYXQgXHUyMTkyIGJhY2tmaWxsZWRcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLWFkcjAxNy1jb21wbGV0aW9uLXRhc2stXCIpKTtcbiAgY29uc3QgdGFza3NEaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIsIFwidGFza3NcIik7XG4gIG1rZGlyU3luYyh0YXNrc0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHQuYWZ0ZXIoKCkgPT4ge1xuICAgIHRyeSB7IGNsb3NlRGF0YWJhc2UoKTsgfSBjYXRjaCB7IC8qIG5vb3AgKi8gfVxuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH0pO1xuXG4gIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsIFwiLmdzZFwiLCBcImdzZC5kYlwiKSk7XG4gIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdFwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSk7XG4gIGluc2VydFNsaWNlKHsgaWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiU2xpY2VcIiwgc3RhdHVzOiBcInBlbmRpbmdcIiwgcmlzazogXCJsb3dcIiwgZGVwZW5kczogW10sIGRlbW86IFwiXCIsIHNlcXVlbmNlOiAxIH0pO1xuICBpbnNlcnRUYXNrKHsgaWQ6IFwiVDAxXCIsIHNsaWNlSWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGFza1wiLCBzdGF0dXM6IFwicGVuZGluZ1wiIH0pO1xuXG4gIC8vIE1vdmUgVDAxIHRvIGNvbXBsZXRlIFdJVEhPVVQgc2V0dGluZyBjb21wbGV0ZWRfYXQgKHNpbXVsYXRpbmcgZHJpZnQgYWZ0ZXJcbiAgLy8gYW4gZXh0ZXJuYWwgcmVjb3ZlcnkgcGF0aCBvciBhIHBhcnRpYWwgc3RhdGUgbWlncmF0aW9uKS5cbiAgdXBkYXRlVGFza1N0YXR1cyhcIk0wMDFcIiwgXCJTMDFcIiwgXCJUMDFcIiwgXCJjb21wbGV0ZVwiLCB1bmRlZmluZWQpO1xuICAvLyBTVU1NQVJZLm1kIGF0dGVzdHMgdG8gY29tcGxldGlvbiBvbiBkaXNrLlxuICBjb25zdCBzdW1tYXJ5UGF0aCA9IGpvaW4odGFza3NEaXIsIFwiVDAxLVNVTU1BUlkubWRcIik7XG4gIHdyaXRlRmlsZVN5bmMoc3VtbWFyeVBhdGgsIFwiIyBUMDEgU3VtbWFyeVxcblwiKTtcbiAgY29uc3Qgc3VtbWFyeU10aW1lTXMgPSBzdGF0U3luYyhzdW1tYXJ5UGF0aCkubXRpbWUuZ2V0VGltZSgpO1xuXG4gIGNvbnN0IHRhc2tCZWZvcmUgPSBnZXRTbGljZVRhc2tzKFwiTTAwMVwiLCBcIlMwMVwiKS5maW5kKCh0KSA9PiB0LmlkID09PSBcIlQwMVwiKTtcbiAgYXNzZXJ0LmVxdWFsKHRhc2tCZWZvcmU/LnN0YXR1cywgXCJjb21wbGV0ZVwiKTtcbiAgYXNzZXJ0LmVxdWFsKHRhc2tCZWZvcmU/LmNvbXBsZXRlZF9hdCwgbnVsbCwgXCJwcmU6IGNvbXBsZXRlZF9hdCBpcyBudWxsXCIpO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlY29uY2lsZUJlZm9yZURpc3BhdGNoKGJhc2UsIHtcbiAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZTogKCkgPT4ge30sXG4gICAgZGVyaXZlU3RhdGU6IGFzeW5jICgpID0+IG1ha2VTdGF0ZSh7IGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiB9IH0pLFxuICB9KTtcblxuICBhc3NlcnQuZXF1YWwocmVzdWx0Lm9rLCB0cnVlKTtcbiAgY29uc3QgdGFza0FmdGVyID0gZ2V0U2xpY2VUYXNrcyhcIk0wMDFcIiwgXCJTMDFcIikuZmluZCgodCkgPT4gdC5pZCA9PT0gXCJUMDFcIik7XG4gIGFzc2VydC5vayh0YXNrQWZ0ZXI/LmNvbXBsZXRlZF9hdCwgXCJwb3N0OiBjb21wbGV0ZWRfYXQgcG9wdWxhdGVkXCIpO1xuICBjb25zdCBjb21wbGV0ZWRBdE1zID0gRGF0ZS5wYXJzZSh0YXNrQWZ0ZXI/LmNvbXBsZXRlZF9hdCA/PyBcIlwiKTtcbiAgYXNzZXJ0Lm9rKE51bWJlci5pc0Zpbml0ZShjb21wbGV0ZWRBdE1zKSwgXCJwb3N0OiBjb21wbGV0ZWRfYXQgaXMgcGFyc2VhYmxlIElTTyBzdHJpbmdcIik7XG4gIGFzc2VydC5lcXVhbChjb21wbGV0ZWRBdE1zLCBzdW1tYXJ5TXRpbWVNcywgXCJwb3N0OiBjb21wbGV0ZWRfYXQgZGVyaXZlZCBmcm9tIFNVTU1BUlkgbXRpbWVcIik7XG4gIGNvbnN0IGRyaWZ0ID0gcmVzdWx0LnJlcGFpcmVkLmZpbmQoKGQpID0+IGQua2luZCA9PT0gXCJtaXNzaW5nLWNvbXBsZXRpb24tdGltZXN0YW1wXCIpO1xuICBhc3NlcnQub2soZHJpZnQsIFwiZHJpZnQgcmVjb3JkZWRcIik7XG4gIGlmIChkcmlmdD8ua2luZCA9PT0gXCJtaXNzaW5nLWNvbXBsZXRpb24tdGltZXN0YW1wXCIpIHtcbiAgICBhc3NlcnQuZXF1YWwoZHJpZnQuZW50aXR5LCBcInRhc2tcIik7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChkcmlmdC5pZHMsIFtcIk0wMDEvUzAxL1QwMVwiXSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiQURSLTAxNyAoIzU3MDYpOiByZXBhaXIgaXMgaWRlbXBvdGVudCBcdTIwMTQgcmUtcnVubmluZyBwcmVzZXJ2ZXMgdGhlIHRpbWVzdGFtcFwiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtYWRyMDE3LWNvbXBsZXRpb24taWRlbXBvdGVudC1cIikpO1xuICBjb25zdCBzbGljZURpciA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIik7XG4gIG1rZGlyU3luYyhzbGljZURpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHQuYWZ0ZXIoKCkgPT4ge1xuICAgIHRyeSB7IGNsb3NlRGF0YWJhc2UoKTsgfSBjYXRjaCB7IC8qIG5vb3AgKi8gfVxuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH0pO1xuXG4gIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsIFwiLmdzZFwiLCBcImdzZC5kYlwiKSk7XG4gIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdFwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSk7XG4gIGluc2VydFNsaWNlKHsgaWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiU2xpY2VcIiwgc3RhdHVzOiBcInBlbmRpbmdcIiwgcmlzazogXCJsb3dcIiwgZGVwZW5kczogW10sIGRlbW86IFwiXCIsIHNlcXVlbmNlOiAxIH0pO1xuICB1cGRhdGVTbGljZVN0YXR1cyhcIk0wMDFcIiwgXCJTMDFcIiwgXCJjb21wbGV0ZVwiLCB1bmRlZmluZWQpO1xuICBjb25zdCBzdW1tYXJ5UGF0aCA9IGpvaW4oc2xpY2VEaXIsIFwiUzAxLVNVTU1BUlkubWRcIik7XG4gIHdyaXRlRmlsZVN5bmMoc3VtbWFyeVBhdGgsIFwiIyBTMDEgU3VtbWFyeVxcblwiKTtcbiAgY29uc3Qgc3VtbWFyeU10aW1lTXMgPSBzdGF0U3luYyhzdW1tYXJ5UGF0aCkubXRpbWUuZ2V0VGltZSgpO1xuXG4gIGNvbnN0IGZpcnN0UmVzdWx0ID0gYXdhaXQgcmVjb25jaWxlQmVmb3JlRGlzcGF0Y2goYmFzZSwge1xuICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlOiAoKSA9PiB7fSxcbiAgICBkZXJpdmVTdGF0ZTogYXN5bmMgKCkgPT4gbWFrZVN0YXRlKHsgYWN0aXZlTWlsZXN0b25lOiB7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdFwiIH0gfSksXG4gIH0pO1xuICBhc3NlcnQuZXF1YWwoZmlyc3RSZXN1bHQub2ssIHRydWUpO1xuICBjb25zdCB0c0FmdGVyRmlyc3QgPSBnZXRTbGljZShcIk0wMDFcIiwgXCJTMDFcIik/LmNvbXBsZXRlZF9hdDtcbiAgYXNzZXJ0Lm9rKHRzQWZ0ZXJGaXJzdCwgXCJmaXJzdCBwYXNzOiBjb21wbGV0ZWRfYXQgcG9wdWxhdGVkXCIpO1xuICBjb25zdCBjb21wbGV0ZWRBdE1zID0gRGF0ZS5wYXJzZSh0c0FmdGVyRmlyc3QgPz8gXCJcIik7XG4gIGFzc2VydC5vayhOdW1iZXIuaXNGaW5pdGUoY29tcGxldGVkQXRNcyksIFwiZmlyc3QgcGFzczogY29tcGxldGVkX2F0IGlzIHBhcnNlYWJsZSBJU08gc3RyaW5nXCIpO1xuICBhc3NlcnQuZXF1YWwoY29tcGxldGVkQXRNcywgc3VtbWFyeU10aW1lTXMsIFwiZmlyc3QgcGFzczogY29tcGxldGVkX2F0IGRlcml2ZWQgZnJvbSBTVU1NQVJZIG10aW1lXCIpO1xuXG4gIC8vIFNlY29uZCBwYXNzIFx1MjAxNCBkcmlmdCBpcyBhbHJlYWR5IGNsZWFyZWQsIG5vIHJlY29yZCBzaG91bGQgYXBwZWFyLCBhbmRcbiAgLy8gdGhlIGV4aXN0aW5nIHRpbWVzdGFtcCBpcyB1bnRvdWNoZWQuXG4gIGNvbnN0IHNlY29uZFJlc3VsdCA9IGF3YWl0IHJlY29uY2lsZUJlZm9yZURpc3BhdGNoKGJhc2UsIHtcbiAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZTogKCkgPT4ge30sXG4gICAgZGVyaXZlU3RhdGU6IGFzeW5jICgpID0+IG1ha2VTdGF0ZSh7IGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiB9IH0pLFxuICB9KTtcbiAgYXNzZXJ0LmVxdWFsKHNlY29uZFJlc3VsdC5vaywgdHJ1ZSk7XG4gIGFzc2VydC5lcXVhbChcbiAgICBzZWNvbmRSZXN1bHQucmVwYWlyZWQuc29tZSgoZCkgPT4gZC5raW5kID09PSBcIm1pc3NpbmctY29tcGxldGlvbi10aW1lc3RhbXBcIiksXG4gICAgZmFsc2UsXG4gICAgXCJzZWNvbmQgcGFzczogbm8gZHJpZnQgZGV0ZWN0ZWQgYWZ0ZXIgZmlyc3QgcmVwYWlyXCIsXG4gICk7XG4gIGFzc2VydC5lcXVhbChnZXRTbGljZShcIk0wMDFcIiwgXCJTMDFcIik/LmNvbXBsZXRlZF9hdCwgdHNBZnRlckZpcnN0LCBcInRpbWVzdGFtcCB1bmNoYW5nZWRcIik7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwICM1NzA3OiBjYWxsZXIgY2xvc3VyZSAocmVjb25jaWxlQmVmb3JlU3Bhd24pIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiQURSLTAxNyAoIzU3MDcpOiByZWNvbmNpbGVCZWZvcmVTcGF3biByZXR1cm5zIG9rPXRydWUgb24gY2xlYW4gcmVjb25jaWxpYXRpb25cIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCByZWNvbmNpbGVCZWZvcmVTcGF3bihcIi9wcm9qZWN0XCIsIHtcbiAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZTogKCkgPT4ge30sXG4gICAgZGVyaXZlU3RhdGU6IGFzeW5jICgpID0+IG1ha2VTdGF0ZSgpLFxuICAgIHJlZ2lzdHJ5OiBbXSxcbiAgfSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQub2ssIHRydWUpO1xufSk7XG5cbnRlc3QoXCJBRFItMDE3ICgjNTcwNyk6IHJlY29uY2lsZUJlZm9yZVNwYXduIHN1cmZhY2VzIGJsb2NrZXJzIGFzIG9rPWZhbHNlXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVjb25jaWxlQmVmb3JlU3Bhd24oXCIvcHJvamVjdFwiLCB7XG4gICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGU6ICgpID0+IHt9LFxuICAgIGRlcml2ZVN0YXRlOiBhc3luYyAoKSA9PiBtYWtlU3RhdGUoeyBwaGFzZTogXCJibG9ja2VkXCIsIGJsb2NrZXJzOiBbXCJsb2NrIG1pc3NpbmdcIl0gfSksXG4gICAgcmVnaXN0cnk6IFtdLFxuICB9KTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5vaywgZmFsc2UpO1xuICBpZiAoIXJlc3VsdC5vaykge1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQucmVhc29uLCAvbG9jayBtaXNzaW5nLyk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiQURSLTAxNyAoIzU3MDcpOiByZWNvbmNpbGVCZWZvcmVTcGF3biBjYXRjaGVzIFJlY29uY2lsaWF0aW9uRmFpbGVkRXJyb3IgXHUyMTkyIG9rPWZhbHNlXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgcGVyc2lzdGVudDogRHJpZnRSZWNvcmQgPSB7IGtpbmQ6IFwic3RhbGUtc2tldGNoLWZsYWdcIiwgbWlkOiBcIk0wMDFcIiwgc2lkOiBcIlMwMlwiIH07XG4gIGNvbnN0IGhhbmRsZXI6IERyaWZ0SGFuZGxlciA9IHtcbiAgICBraW5kOiBcInN0YWxlLXNrZXRjaC1mbGFnXCIsXG4gICAgZGV0ZWN0OiAoKSA9PiBbcGVyc2lzdGVudF0sXG4gICAgcmVwYWlyOiAoKSA9PiB7IC8qIG5vLW9wOiBkcmlmdCBjYW5ub3QgYmUgY2xlYXJlZCwgcGVyc2lzdHMgcGFzdCBjYXA9MiAqLyB9LFxuICB9O1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlY29uY2lsZUJlZm9yZVNwYXduKFwiL3Byb2plY3RcIiwge1xuICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlOiAoKSA9PiB7fSxcbiAgICBkZXJpdmVTdGF0ZTogYXN5bmMgKCkgPT4gbWFrZVN0YXRlKCksXG4gICAgcmVnaXN0cnk6IFtoYW5kbGVyXSxcbiAgfSk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5vaywgZmFsc2UpO1xuICBpZiAoIXJlc3VsdC5vaykge1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQucmVhc29uLCAvc3RhbGUtc2tldGNoLWZsYWcvKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJBRFItMDE3ICgjNTcwNyk6IHJlY29uY2lsZUJlZm9yZVNwYXduIHJlcG9ydHMgcmVwYWlyZWQgZHJpZnQgaW4gb2s9dHJ1ZSByZWFzb25cIiwgYXN5bmMgKCkgPT4ge1xuICBsZXQgZGV0ZWN0Q2FsbHMgPSAwO1xuICBjb25zdCBoYW5kbGVyOiBEcmlmdEhhbmRsZXIgPSB7XG4gICAga2luZDogXCJzdGFsZS1za2V0Y2gtZmxhZ1wiLFxuICAgIGRldGVjdDogKCkgPT4ge1xuICAgICAgZGV0ZWN0Q2FsbHMrKztcbiAgICAgIHJldHVybiBkZXRlY3RDYWxscyA9PT0gMVxuICAgICAgICA/IFt7IGtpbmQ6IFwic3RhbGUtc2tldGNoLWZsYWdcIiwgbWlkOiBcIk0wMDFcIiwgc2lkOiBcIlMwMlwiIH1dXG4gICAgICAgIDogW107XG4gICAgfSxcbiAgICByZXBhaXI6ICgpID0+IHsgLyogcmVwYWlyIFwic3VjY2VlZHNcIiBcdTIwMTQgc2Vjb25kIGRldGVjdCByZXR1cm5zIGVtcHR5ICovIH0sXG4gIH07XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVjb25jaWxlQmVmb3JlU3Bhd24oXCIvcHJvamVjdFwiLCB7XG4gICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGU6ICgpID0+IHt9LFxuICAgIGRlcml2ZVN0YXRlOiBhc3luYyAoKSA9PiBtYWtlU3RhdGUoKSxcbiAgICByZWdpc3RyeTogW2hhbmRsZXJdLFxuICB9KTtcblxuICBhc3NlcnQuZXF1YWwocmVzdWx0Lm9rLCB0cnVlKTtcbiAgaWYgKHJlc3VsdC5vaykge1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQucmVhc29uID8/IFwiXCIsIC9zdGFsZS1za2V0Y2gtZmxhZy8pO1xuICB9XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIExpZmVjeWNsZSBhbmQgY2xhc3NpZmljYXRpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJBRFItMDE3ICgjNTcwMCk6IGNhc2NhZGluZyBkcmlmdCB0cmlnZ2VycyBzZWNvbmQgcGFzcyB3aXRoaW4gY2FwXCIsIGFzeW5jICgpID0+IHtcbiAgLy8gRmlyc3QgcGFzcyBkZXRlY3RzIGRyaWZ0IEE7IHJlcGFpciBcImZpeGVzXCIgaXQuIFNlY29uZCBwYXNzIGRldGVjdHMgZHJpZnQgQlxuICAvLyAoY2FzY2FkaW5nKTsgcmVwYWlyIGZpeGVzIGl0LiBUaGlyZCBjYWxsIHdvdWxkIHNlZSBubyBkcmlmdC4gQ2FwPTIgbWVhbnNcbiAgLy8gd2UgaGF2ZSBleGFjdGx5IHR3byByZXBhaXIgcGFzc2VzIGF2YWlsYWJsZS5cbiAgY29uc3QgZGV0ZWN0ZWRTZXF1ZW5jZTogRHJpZnRSZWNvcmRbXVtdID0gW1xuICAgIFt7IGtpbmQ6IFwic3RhbGUtc2tldGNoLWZsYWdcIiwgbWlkOiBcIk0wMDFcIiwgc2lkOiBcIlMwMlwiIH1dLFxuICAgIFt7IGtpbmQ6IFwic3RhbGUtc2tldGNoLWZsYWdcIiwgbWlkOiBcIk0wMDFcIiwgc2lkOiBcIlMwM1wiIH1dLFxuICAgIFtdLFxuICBdO1xuICBsZXQgZGV0ZWN0Q2FsbElkeCA9IDA7XG4gIGNvbnN0IHJlcGFpcmVkOiBEcmlmdFJlY29yZFtdID0gW107XG5cbiAgY29uc3QgaGFuZGxlcjogRHJpZnRIYW5kbGVyID0ge1xuICAgIGtpbmQ6IFwic3RhbGUtc2tldGNoLWZsYWdcIixcbiAgICBkZXRlY3Q6ICgpID0+IGRldGVjdGVkU2VxdWVuY2VbZGV0ZWN0Q2FsbElkeCsrXSA/PyBbXSxcbiAgICByZXBhaXI6IChyZWNvcmQpID0+IHtcbiAgICAgIHJlcGFpcmVkLnB1c2gocmVjb3JkKTtcbiAgICB9LFxuICB9O1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlY29uY2lsZUJlZm9yZURpc3BhdGNoKFwiL3Byb2plY3RcIiwge1xuICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlOiAoKSA9PiB7fSxcbiAgICBkZXJpdmVTdGF0ZTogYXN5bmMgKCkgPT4gbWFrZVN0YXRlKCksXG4gICAgcmVnaXN0cnk6IFtoYW5kbGVyXSxcbiAgfSk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5vaywgdHJ1ZSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQucmVwYWlyZWQubGVuZ3RoLCAyLCBcImJvdGggcGFzc2VzJyByZXBhaXJzIGNvbGxlY3RlZFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlcGFpcmVkLmxlbmd0aCwgMik7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQVFBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxvQkFBb0I7QUFDN0IsU0FBUyxZQUFZLGFBQWEsV0FBVyxjQUFjLFFBQVEsVUFBVSxxQkFBcUI7QUFDbEcsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUN2QixTQUFTLGtCQUFrQjtBQUUzQjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUNQ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
