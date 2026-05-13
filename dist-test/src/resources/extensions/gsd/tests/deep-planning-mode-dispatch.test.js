import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  DISPATCH_RULES,
  getDeepStageGate,
  hasPendingDeepStage,
  resolveDispatch,
  setResearchProjectPromptBuilderForTest
} from "../auto-dispatch.js";
const WORKFLOW_PREFS_RULE_NAME = "deep: pre-planning (no workflow prefs) \u2192 workflow-preferences";
const PROJECT_RULE_NAME = "deep: pre-planning (no PROJECT) \u2192 discuss-project";
const REQUIREMENTS_RULE_NAME = "deep: pre-planning (no REQUIREMENTS) \u2192 discuss-requirements";
const RESEARCH_DECISION_RULE_NAME = "deep: pre-planning (no research decision) \u2192 research-decision";
const RESEARCH_PROJECT_RULE_NAME = "deep: pre-planning (research approved, files missing) \u2192 research-project";
const VALID_PROJECT_MD = [
  "# Project",
  "",
  "## What This Is",
  "",
  "A test project.",
  "",
  "## Core Value",
  "",
  "Reliable dispatch behavior.",
  "",
  "## Current State",
  "",
  "Tests are exercising deep planning.",
  "",
  "## Architecture / Key Patterns",
  "",
  "Markdown artifacts drive stage gates.",
  "",
  "## Capability Contract",
  "",
  "See `.gsd/REQUIREMENTS.md`.",
  "",
  "## Milestone Sequence",
  "",
  "- [ ] M001: Test \u2014 exercise deep planning dispatch",
  ""
].join("\n");
const VALID_REQUIREMENTS_MD = [
  "# Requirements",
  "",
  "## Active",
  "",
  "### R001 \u2014 Dispatch valid artifacts",
  "- Class: core-capability",
  "- Status: active",
  "- Description: Valid artifacts allow deep-mode dispatch to advance.",
  "- Why it matters: Stage gates must not stall valid projects.",
  "- Source: test",
  "- Primary owning slice: M001/S01",
  "- Supporting slices: none",
  "- Validation: unmapped",
  "- Notes:",
  "",
  "## Validated",
  "",
  "## Deferred",
  "",
  "## Out of Scope",
  "",
  "## Traceability",
  "",
  "| ID | Class | Status | Primary owner | Supporting | Proof |",
  "|---|---|---|---|---|---|",
  "| R001 | core-capability | active | M001/S01 | none | unmapped |",
  "",
  "## Coverage Summary",
  "",
  "- Active requirements: 1",
  ""
].join("\n");
const TINY_TODO_PROJECT_MD = [
  "# Personal Todo App",
  "",
  "## What This Is",
  "",
  "A personal todo app - static HTML/CSS/JS, no backend, no accounts. Single file, runs in the browser locally or from a file.",
  "",
  "## Core Value",
  "",
  "Fast task capture with minimal friction.",
  "",
  "## Current State",
  "",
  "Greenfield browser-based app. Tasks persist in localStorage.",
  "",
  "## Architecture / Key Patterns",
  "",
  "Pure HTML/CSS/JS, client-only, no build step, no server.",
  "",
  "## Capability Contract",
  "",
  "See `.gsd/REQUIREMENTS.md`.",
  "",
  "## Milestone Sequence",
  "",
  "- [ ] M001: Todo App \u2014 build one-page local task capture",
  ""
].join("\n");
const TINY_TODO_REQUIREMENTS_MD = [
  "# Requirements",
  "",
  "## Active",
  "",
  "### R001 \u2014 Fast task capture",
  "- Class: primary-user-loop",
  "- Status: active",
  "- Description: User can add a task quickly from the browser.",
  "- Why it matters: This is the core loop.",
  "- Source: user",
  "- Primary owning slice: M001/none yet",
  "- Supporting slices: none",
  "- Validation: Add a task from the page.",
  "- Notes: single file",
  "",
  "### R002 \u2014 Task completion with done section",
  "- Class: primary-user-loop",
  "- Status: active",
  "- Description: User can mark a task done and see it in a done section.",
  "- Why it matters: Completion is part of the todo loop.",
  "- Source: user",
  "- Primary owning slice: M001/none yet",
  "- Supporting slices: none",
  "- Validation: Mark a task done from the page.",
  "- Notes: static html",
  "",
  "### R003 \u2014 Optional due date on tasks",
  "- Class: core-capability",
  "- Status: active",
  "- Description: User can add an optional due date to a task.",
  "- Why it matters: It adds useful context without priority systems.",
  "- Source: user",
  "- Primary owning slice: M001/none yet",
  "- Supporting slices: none",
  "- Validation: Add a task with a due date.",
  "- Notes: browser-based",
  "",
  "### R004 \u2014 Static HTML/CSS/JS, no backend",
  "- Class: constraint",
  "- Status: active",
  "- Description: The app is static HTML/CSS/JS with no backend, no server, and no build step.",
  "- Why it matters: The project must stay tiny and local.",
  "- Source: user",
  "- Primary owning slice: M001/none yet",
  "- Supporting slices: none",
  "- Validation: Open the file directly in a browser.",
  "- Notes: client-only",
  "",
  "### R005 \u2014 Tasks persist across page reloads",
  "- Class: continuity",
  "- Status: active",
  "- Description: Tasks persist in localStorage across reloads.",
  "- Why it matters: The app remains useful after the tab closes.",
  "- Source: user",
  "- Primary owning slice: M001/none yet",
  "- Supporting slices: none",
  "- Validation: Reload the page and see saved tasks.",
  "- Notes: localStorage",
  "",
  "## Validated",
  "",
  "## Deferred",
  "",
  "## Out of Scope",
  "",
  "### R006 \u2014 No sync or accounts",
  "- Class: anti-feature",
  "- Status: out-of-scope",
  "- Description: The app does not support sync, accounts, or cloud storage.",
  "- Why it matters: Keeps the project local and simple.",
  "- Source: user",
  "- Primary owning slice: none",
  "- Supporting slices: none",
  "- Validation: No account or sync flow exists.",
  "- Notes: no accounts",
  "",
  "## Traceability",
  "",
  "| ID | Class | Status | Primary owner | Supporting | Proof |",
  "|---|---|---|---|---|---|",
  "| R001 | primary-user-loop | active | M001/none yet | none | unmapped |",
  "| R002 | primary-user-loop | active | M001/none yet | none | unmapped |",
  "| R003 | core-capability | active | M001/none yet | none | unmapped |",
  "| R004 | constraint | active | M001/none yet | none | unmapped |",
  "| R005 | continuity | active | M001/none yet | none | unmapped |",
  "| R006 | anti-feature | out-of-scope | none | none | excluded |",
  "",
  "## Coverage Summary",
  "",
  "- Active requirements: 5",
  ""
].join("\n");
function makeIsolatedBase() {
  const base = join(tmpdir(), `gsd-deep-planning-${randomUUID()}`);
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  return base;
}
function makeIsolatedBaseWithCleanup(t) {
  const base = makeIsolatedBase();
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  return base;
}
function writeValidProject(base) {
  writeFileSync(join(base, ".gsd", "PROJECT.md"), VALID_PROJECT_MD);
}
function writeValidRequirements(base) {
  writeFileSync(join(base, ".gsd", "REQUIREMENTS.md"), VALID_REQUIREMENTS_MD);
}
function writeTinyTodoProject(base) {
  writeFileSync(join(base, ".gsd", "PROJECT.md"), TINY_TODO_PROJECT_MD);
  writeFileSync(join(base, ".gsd", "REQUIREMENTS.md"), TINY_TODO_REQUIREMENTS_MD);
}
function writeCapturedDeepPrefs(base) {
  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    "---\nplanning_depth: deep\nworkflow_prefs_captured: true\n---\n"
  );
}
function writeSkippedProjectResearchDecision(base) {
  mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
  writeFileSync(join(base, ".gsd", "runtime", "research-decision.json"), JSON.stringify({ decision: "skip" }));
}
function makeCtx(basePath, prefs, phase = "pre-planning") {
  const state = {
    phase,
    activeMilestone: { id: "M001", title: "Test" },
    activeSlice: null,
    activeTask: null,
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: [{ id: "M001", title: "Test", status: "active" }]
  };
  return {
    basePath,
    mid: "M001",
    midTitle: "Test",
    state,
    prefs,
    structuredQuestionsAvailable: "false"
  };
}
function rule(name) {
  const r = DISPATCH_RULES.find((x) => x.name === name);
  assert.ok(r, `dispatch rule "${name}" must exist`);
  return r;
}
test("Deep mode: workflow-preferences does NOT dispatch in light mode", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  const result = await rule(WORKFLOW_PREFS_RULE_NAME).match(makeCtx(base, void 0));
  assert.strictEqual(result, null);
});
test("Deep mode: workflow-preferences captures defaults in-process when PREFERENCES.md missing", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  const prefs = { planning_depth: "deep" };
  const result = await rule(WORKFLOW_PREFS_RULE_NAME).match(makeCtx(base, prefs));
  assert.strictEqual(result, null, "workflow prefs are written deterministically, not dispatched to an agent");
  const content = readFileSync(join(base, ".gsd", "PREFERENCES.md"), "utf-8");
  assert.match(content, /^workflow_prefs_captured:\s*true\s*$/m);
  assert.match(content, /^commit_policy:\s*per-task\s*$/m);
  assert.ok(existsSync(join(base, ".gsd", "runtime", "research-decision.json")));
});
test("Deep mode: workflow-preferences self-heals PREFERENCES.md when capture marker is missing", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "---\nplanning_depth: deep\n---\n");
  const prefs = { planning_depth: "deep" };
  const result = await rule(WORKFLOW_PREFS_RULE_NAME).match(makeCtx(base, prefs));
  assert.strictEqual(result, null);
  const content = readFileSync(join(base, ".gsd", "PREFERENCES.md"), "utf-8");
  assert.match(content, /^workflow_prefs_captured:\s*true\s*$/m);
  assert.match(content, /^branch_model:\s*single\s*$/m);
});
test("Deep mode: workflow-preferences self-heals malformed frontmatter", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "---\nthis is not valid yaml: [\n---\n");
  const prefs = { planning_depth: "deep" };
  const result = await rule(WORKFLOW_PREFS_RULE_NAME).match(makeCtx(base, prefs));
  assert.strictEqual(result, null);
  const content = readFileSync(join(base, ".gsd", "PREFERENCES.md"), "utf-8");
  assert.match(content, /^workflow_prefs_captured:\s*true\s*$/m);
  assert.ok(content.includes("this is not valid yaml"), "malformed original content is preserved as body");
});
test("Deep mode: workflow-preferences does NOT dispatch when PREFERENCES.md has workflow_prefs_captured: true", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    "---\nplanning_depth: deep\nworkflow_prefs_captured: true\ncommit_policy: per-task\n---\n"
  );
  const prefs = { planning_depth: "deep" };
  const result = await rule(WORKFLOW_PREFS_RULE_NAME).match(makeCtx(base, prefs));
  assert.strictEqual(result, null);
});
test("Deep mode: discuss-project does NOT dispatch when planning_depth is undefined (default light)", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  const result = await rule(PROJECT_RULE_NAME).match(makeCtx(base, void 0));
  assert.strictEqual(result, null, "light mode (default) must not fire deep-mode rule");
});
test("Deep mode: discuss-project does NOT dispatch when planning_depth is 'light'", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  const prefs = { planning_depth: "light" };
  const result = await rule(PROJECT_RULE_NAME).match(makeCtx(base, prefs));
  assert.strictEqual(result, null, "explicit light mode must not fire deep-mode rule");
});
test("Deep mode: discuss-project DOES dispatch when planning_depth is 'deep' and PROJECT.md missing", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  const prefs = { planning_depth: "deep" };
  const result = await rule(PROJECT_RULE_NAME).match(makeCtx(base, prefs));
  assert.ok(result && result.action === "dispatch", "deep mode + missing PROJECT.md must dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "discuss-project");
    assert.strictEqual(result.unitId, "PROJECT");
    assert.ok(result.prompt.length > 0, "prompt must be non-empty");
  }
});
test("Deep mode: discuss-project does NOT dispatch when PROJECT.md already exists and is valid", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  writeValidProject(base);
  const prefs = { planning_depth: "deep" };
  const result = await rule(PROJECT_RULE_NAME).match(makeCtx(base, prefs));
  assert.strictEqual(result, null, "valid PROJECT.md must fall through to next rule");
});
test("Deep mode: discuss-project DOES dispatch when PROJECT.md exists but is invalid", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  writeFileSync(join(base, ".gsd", "PROJECT.md"), "# Project\n");
  const prefs = { planning_depth: "deep" };
  const result = await rule(PROJECT_RULE_NAME).match(makeCtx(base, prefs));
  assert.ok(result && result.action === "dispatch", "invalid PROJECT.md must re-fire discuss-project");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "discuss-project");
    assert.strictEqual(result.unitId, "PROJECT");
  }
});
test("Deep mode: discuss-project does NOT dispatch in non-pre-planning phases", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  const prefs = { planning_depth: "deep" };
  const result = await rule(PROJECT_RULE_NAME).match(makeCtx(base, prefs, "executing"));
  assert.strictEqual(result, null, "execution phases must not fire project-level discussion");
});
test("Deep mode: discuss-project DOES dispatch in needs-discussion phase", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  const prefs = { planning_depth: "deep" };
  const result = await rule(PROJECT_RULE_NAME).match(makeCtx(base, prefs, "needs-discussion"));
  assert.ok(result && result.action === "dispatch", "needs-discussion is a valid entry phase");
});
test("Deep mode: discuss-requirements does NOT dispatch in light mode", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  const result = await rule(REQUIREMENTS_RULE_NAME).match(makeCtx(base, void 0));
  assert.strictEqual(result, null, "light mode must not fire deep-mode requirements rule");
});
test("Deep mode: discuss-requirements does NOT dispatch when PROJECT.md missing (project rule must run first)", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  const prefs = { planning_depth: "deep" };
  const result = await rule(REQUIREMENTS_RULE_NAME).match(makeCtx(base, prefs));
  assert.strictEqual(result, null, "PROJECT.md missing \u2014 earlier rule handles");
});
test("Deep mode: discuss-requirements DOES dispatch when PROJECT.md exists and REQUIREMENTS.md missing", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  writeValidProject(base);
  const prefs = { planning_depth: "deep" };
  const result = await rule(REQUIREMENTS_RULE_NAME).match(makeCtx(base, prefs));
  assert.ok(result && result.action === "dispatch", "deep mode + PROJECT.md present + REQUIREMENTS.md missing must dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "discuss-requirements");
    assert.strictEqual(result.unitId, "REQUIREMENTS");
  }
});
test("Deep mode: discuss-requirements does NOT dispatch when REQUIREMENTS.md already exists and is valid", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  writeCapturedDeepPrefs(base);
  writeValidProject(base);
  writeValidRequirements(base);
  const prefs = { planning_depth: "deep" };
  const result = await rule(REQUIREMENTS_RULE_NAME).match(makeCtx(base, prefs));
  assert.strictEqual(result, null, "valid REQUIREMENTS.md must fall through");
});
test("Deep mode: discuss-requirements DOES dispatch when REQUIREMENTS.md exists but is invalid", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  writeValidProject(base);
  writeFileSync(join(base, ".gsd", "REQUIREMENTS.md"), "# Requirements\n");
  const prefs = { planning_depth: "deep" };
  const result = await rule(REQUIREMENTS_RULE_NAME).match(makeCtx(base, prefs));
  assert.ok(result && result.action === "dispatch", "invalid REQUIREMENTS.md must re-fire discuss-requirements");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "discuss-requirements");
    assert.strictEqual(result.unitId, "REQUIREMENTS");
  }
});
test("Deep mode: research-decision does NOT dispatch in light mode", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  writeValidProject(base);
  writeValidRequirements(base);
  const result = await rule(RESEARCH_DECISION_RULE_NAME).match(makeCtx(base, void 0));
  assert.strictEqual(result, null);
});
test("Deep mode: research-decision does NOT dispatch when REQUIREMENTS.md missing", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  writeValidProject(base);
  const prefs = { planning_depth: "deep" };
  const result = await rule(RESEARCH_DECISION_RULE_NAME).match(makeCtx(base, prefs));
  assert.strictEqual(result, null, "REQUIREMENTS.md must exist before research decision is asked");
});
test("Deep mode: research-decision does NOT dispatch when marker is missing because default is skip", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  writeCapturedDeepPrefs(base);
  writeValidProject(base);
  writeValidRequirements(base);
  const prefs = { planning_depth: "deep" };
  const result = await rule(RESEARCH_DECISION_RULE_NAME).match(makeCtx(base, prefs));
  assert.strictEqual(result, null);
  const decision = JSON.parse(readFileSync(join(base, ".gsd", "runtime", "research-decision.json"), "utf-8"));
  assert.equal(decision.decision, "skip");
  assert.equal(decision.source, "workflow-preferences");
  assert.equal(decision.reason, "missing-default-repair");
});
test("Deep mode: research-decision does NOT dispatch when decision marker exists", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  writeValidProject(base);
  writeValidRequirements(base);
  mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
  writeFileSync(join(base, ".gsd", "runtime", "research-decision.json"), JSON.stringify({ decision: "skip" }));
  const prefs = { planning_depth: "deep" };
  const result = await rule(RESEARCH_DECISION_RULE_NAME).match(makeCtx(base, prefs));
  assert.strictEqual(result, null, "decision already recorded \u2014 fall through");
});
function setupReadyForResearchProject(base) {
  writeCapturedDeepPrefs(base);
  writeValidProject(base);
  writeValidRequirements(base);
  mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "runtime", "research-decision.json"),
    JSON.stringify({ decision: "research", source: "research-decision", decided_at: "2026-04-27T00:00:00Z" })
  );
}
test("Deep mode: research-project does NOT dispatch in light mode", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  setupReadyForResearchProject(base);
  const result = await rule(RESEARCH_PROJECT_RULE_NAME).match(makeCtx(base, void 0));
  assert.strictEqual(result, null);
});
test("Deep mode: research-project does NOT dispatch when decision marker missing", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  writeValidProject(base);
  writeValidRequirements(base);
  const prefs = { planning_depth: "deep" };
  const result = await rule(RESEARCH_PROJECT_RULE_NAME).match(makeCtx(base, prefs));
  assert.strictEqual(result, null);
});
test("Deep mode: research-project does NOT dispatch when user chose 'skip'", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  writeValidProject(base);
  writeValidRequirements(base);
  mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
  writeFileSync(join(base, ".gsd", "runtime", "research-decision.json"), JSON.stringify({ decision: "skip" }));
  const prefs = { planning_depth: "deep" };
  const result = await rule(RESEARCH_PROJECT_RULE_NAME).match(makeCtx(base, prefs));
  assert.strictEqual(result, null, "skip decision must short-circuit research-project");
});
test("Deep mode: research-project DOES dispatch when decision is 'research' and research files missing", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  setupReadyForResearchProject(base);
  const prefs = { planning_depth: "deep" };
  const result = await rule(RESEARCH_PROJECT_RULE_NAME).match(makeCtx(base, prefs));
  assert.ok(result && result.action === "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "research-project");
    assert.strictEqual(result.unitId, "RESEARCH-PROJECT");
  }
  assert.ok(
    existsSync(join(base, ".gsd", "runtime", "research-project-inflight")),
    "dispatch must create the in-flight marker before returning"
  );
});
test("Deep mode: research-project normalizes legacy workflow-defaulted research to skip", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  writeCapturedDeepPrefs(base);
  writeTinyTodoProject(base);
  mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "runtime", "research-decision.json"),
    JSON.stringify({
      decision: "research",
      decided_at: "2026-04-27T00:00:00Z",
      source: "workflow-preferences"
    })
  );
  const prefs = { planning_depth: "deep" };
  const result = await rule(RESEARCH_PROJECT_RULE_NAME).match(makeCtx(base, prefs));
  assert.strictEqual(result, null, "tiny project should fall through after rewriting decision to skip");
  assert.equal(
    existsSync(join(base, ".gsd", "runtime", "research-project-inflight")),
    false,
    "fast path must not claim the research-project in-flight marker"
  );
  const decision = JSON.parse(readFileSync(join(base, ".gsd", "runtime", "research-decision.json"), "utf-8"));
  assert.equal(decision.decision, "skip");
  assert.equal(decision.source, "workflow-preferences");
  assert.equal(decision.previous_source, "workflow-preferences");
  assert.equal(decision.reason, "legacy-workflow-research-default");
  assert.equal(getDeepStageGate(prefs, base).status, "complete");
});
test("Deep mode gate ignores stale blockers for legacy workflow-defaulted research", (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  writeCapturedDeepPrefs(base);
  writeTinyTodoProject(base);
  mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "runtime", "research-decision.json"),
    JSON.stringify({
      decision: "research",
      decided_at: "2026-04-27T00:00:00Z",
      source: "workflow-preferences"
    })
  );
  mkdirSync(join(base, ".gsd", "research"), { recursive: true });
  for (const name of ["STACK", "FEATURES", "ARCHITECTURE", "PITFALLS"]) {
    writeFileSync(join(base, ".gsd", "research", `${name}-BLOCKER.md`), "# blocked\n");
  }
  const prefs = { planning_depth: "deep" };
  const gate = getDeepStageGate(prefs, base);
  assert.deepEqual(
    { status: gate.status, stage: gate.stage },
    { status: "complete", stage: null },
    "workflow-defaulted tiny apps should not get trapped by stale research blockers"
  );
  assert.equal(hasPendingDeepStage(prefs, base), false);
  const decision = JSON.parse(readFileSync(join(base, ".gsd", "runtime", "research-decision.json"), "utf-8"));
  assert.equal(decision.decision, "skip");
  assert.equal(decision.source, "workflow-preferences");
  assert.equal(decision.previous_source, "workflow-preferences");
});
test("Deep mode: research-project honors explicit research decisions for tiny static apps", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  writeCapturedDeepPrefs(base);
  writeTinyTodoProject(base);
  mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "runtime", "research-decision.json"),
    JSON.stringify({ decision: "research", source: "research-decision", decided_at: "2026-04-27T00:00:00Z" })
  );
  const prefs = { planning_depth: "deep" };
  const result = await rule(RESEARCH_PROJECT_RULE_NAME).match(makeCtx(base, prefs));
  assert.ok(result && result.action === "dispatch", "explicit user-sourced research should still run");
  assert.equal(existsSync(join(base, ".gsd", "runtime", "research-project-inflight")), true);
});
test("Deep mode: research-project does not dispatch non-trivial workflow-defaulted research", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  writeCapturedDeepPrefs(base);
  writeValidProject(base);
  writeValidRequirements(base);
  mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "runtime", "research-decision.json"),
    JSON.stringify({
      decision: "research",
      decided_at: "2026-04-27T00:00:00Z",
      source: "workflow-preferences"
    })
  );
  const prefs = { planning_depth: "deep" };
  const result = await rule(RESEARCH_PROJECT_RULE_NAME).match(makeCtx(base, prefs));
  assert.equal(result, null);
  assert.equal(existsSync(join(base, ".gsd", "runtime", "research-project-inflight")), false);
  const decision = JSON.parse(readFileSync(join(base, ".gsd", "runtime", "research-decision.json"), "utf-8"));
  assert.equal(decision.decision, "skip");
  assert.equal(decision.reason, "legacy-workflow-research-default");
});
test("Deep mode: research-project clears in-flight marker when prompt assembly fails", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  const restorePromptBuilder = setResearchProjectPromptBuilderForTest(async () => {
    throw new Error("prompt assembly failed");
  });
  t.after(restorePromptBuilder);
  setupReadyForResearchProject(base);
  const prefs = { planning_depth: "deep" };
  const markerPath = join(base, ".gsd", "runtime", "research-project-inflight");
  await assert.rejects(
    () => rule(RESEARCH_PROJECT_RULE_NAME).match(makeCtx(base, prefs)),
    /prompt assembly failed/
  );
  assert.strictEqual(existsSync(markerPath), false, "failed prompt assembly must not strand the in-flight marker");
});
test("Deep mode: research-project stops while in-flight marker exists", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  setupReadyForResearchProject(base);
  writeFileSync(join(base, ".gsd", "runtime", "research-project-inflight"), "{}\n");
  const prefs = { planning_depth: "deep" };
  const result = await rule(RESEARCH_PROJECT_RULE_NAME).match(makeCtx(base, prefs));
  assert.ok(result !== null, "in-flight marker must produce a result");
  assert.strictEqual(result?.action, "stop", "in-flight marker must block dispatch with a stop action");
  assert.strictEqual(result.level, "info", "in-flight stop must use info level");
  if (result?.action === "stop") {
    assert.match(result.reason, /research-project-inflight/);
  }
});
test("Deep mode: research-project does NOT dispatch when all 4 research files exist", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  setupReadyForResearchProject(base);
  mkdirSync(join(base, ".gsd", "research"), { recursive: true });
  for (const name of ["STACK.md", "FEATURES.md", "ARCHITECTURE.md", "PITFALLS.md"]) {
    writeFileSync(join(base, ".gsd", "research", name), "# done\n");
  }
  const prefs = { planning_depth: "deep" };
  const result = await rule(RESEARCH_PROJECT_RULE_NAME).match(makeCtx(base, prefs));
  assert.strictEqual(result, null, "all research files present \u2014 fall through");
});
test("Deep mode: research-project treats a dimension BLOCKER as terminal", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  setupReadyForResearchProject(base);
  mkdirSync(join(base, ".gsd", "research"), { recursive: true });
  for (const name of ["STACK.md", "FEATURES.md", "ARCHITECTURE.md"]) {
    writeFileSync(join(base, ".gsd", "research", name), "# done\n");
  }
  writeFileSync(join(base, ".gsd", "research", "PITFALLS-BLOCKER.md"), "# blocker\n");
  const prefs = { planning_depth: "deep" };
  const result = await rule(RESEARCH_PROJECT_RULE_NAME).match(makeCtx(base, prefs));
  assert.strictEqual(result, null, "dimension blocker files must satisfy project research");
});
test("Deep mode: research-project stops when every dimension is only a BLOCKER", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  setupReadyForResearchProject(base);
  mkdirSync(join(base, ".gsd", "research"), { recursive: true });
  for (const name of ["STACK", "FEATURES", "ARCHITECTURE", "PITFALLS"]) {
    writeFileSync(join(base, ".gsd", "research", `${name}-BLOCKER.md`), "# blocked\n");
  }
  const prefs = { planning_depth: "deep" };
  const result = await rule(RESEARCH_PROJECT_RULE_NAME).match(makeCtx(base, prefs));
  assert.equal(result?.action, "stop");
  assert.match(result?.action === "stop" ? result.reason : "", /only dimension blocker files/);
});
test("Deep mode: research-project stops on global PROJECT-RESEARCH-BLOCKER", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  setupReadyForResearchProject(base);
  mkdirSync(join(base, ".gsd", "research"), { recursive: true });
  writeFileSync(join(base, ".gsd", "research", "PROJECT-RESEARCH-BLOCKER.md"), "# blocked\n");
  const prefs = { planning_depth: "deep" };
  const result = await rule(RESEARCH_PROJECT_RULE_NAME).match(makeCtx(base, prefs));
  assert.equal(result?.action, "stop");
  assert.match(result?.action === "stop" ? result.reason : "", /PROJECT-RESEARCH-BLOCKER/);
});
test("Deep mode: research-project DOES dispatch when only 3 of 4 research files exist", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  setupReadyForResearchProject(base);
  mkdirSync(join(base, ".gsd", "research"), { recursive: true });
  for (const name of ["STACK.md", "FEATURES.md", "ARCHITECTURE.md"]) {
    writeFileSync(join(base, ".gsd", "research", name), "# done\n");
  }
  const prefs = { planning_depth: "deep" };
  const result = await rule(RESEARCH_PROJECT_RULE_NAME).match(makeCtx(base, prefs));
  assert.ok(result && result.action === "dispatch", "any missing dimension must trigger re-run");
});
test("Deep mode: queued milestone without CONTEXT.md routes to milestone research after project setup", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  writeCapturedDeepPrefs(base);
  writeValidProject(base);
  writeValidRequirements(base);
  writeSkippedProjectResearchDecision(base);
  const prefs = { planning_depth: "deep" };
  const result = await resolveDispatch(makeCtx(base, prefs));
  assert.equal(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.equal(result.unitType, "research-milestone");
    assert.equal(result.unitId, "M001");
  }
});
test("Deep mode: queued milestone without CONTEXT.md can route directly to milestone planning", async (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  writeCapturedDeepPrefs(base);
  writeValidProject(base);
  writeValidRequirements(base);
  writeSkippedProjectResearchDecision(base);
  const prefs = { planning_depth: "deep", phases: { skip_research: true } };
  const result = await resolveDispatch(makeCtx(base, prefs));
  assert.equal(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.equal(result.unitType, "plan-milestone");
    assert.equal(result.unitId, "M001");
  }
});
test("Deep mode gate reports the earliest missing section", (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  const prefs = { planning_depth: "deep" };
  mkdirSync(join(base, ".gsd", "research"), { recursive: true });
  for (const name of ["STACK.md", "FEATURES.md", "ARCHITECTURE.md", "PITFALLS.md"]) {
    writeFileSync(join(base, ".gsd", "research", name), "# done\n");
  }
  const gate = getDeepStageGate(prefs, base);
  assert.deepEqual(
    { status: gate.status, stage: gate.stage },
    { status: "pending", stage: "workflow-preferences" },
    "later artifacts must not let the workflow skip the first pending deep section"
  );
  assert.equal(hasPendingDeepStage(prefs, base), true);
});
test("Deep mode gate blocks blocker-only project research", (t) => {
  const base = makeIsolatedBaseWithCleanup(t);
  const prefs = { planning_depth: "deep" };
  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    "---\nplanning_depth: deep\nworkflow_prefs_captured: true\n---\n"
  );
  setupReadyForResearchProject(base);
  mkdirSync(join(base, ".gsd", "research"), { recursive: true });
  for (const name of ["STACK", "FEATURES", "ARCHITECTURE", "PITFALLS"]) {
    writeFileSync(join(base, ".gsd", "research", `${name}-BLOCKER.md`), "# blocked\n");
  }
  const gate = getDeepStageGate(prefs, base);
  assert.deepEqual(
    { status: gate.status, stage: gate.stage },
    { status: "blocked", stage: "project-research" }
  );
  assert.equal(hasPendingDeepStage(prefs, base), true);
});
test("Deep mode gate passes only after verified project research or explicit skip", (t) => {
  const researchBase = makeIsolatedBaseWithCleanup(t);
  const prefs = { planning_depth: "deep" };
  writeFileSync(
    join(researchBase, ".gsd", "PREFERENCES.md"),
    "---\nplanning_depth: deep\nworkflow_prefs_captured: true\n---\n"
  );
  setupReadyForResearchProject(researchBase);
  mkdirSync(join(researchBase, ".gsd", "research"), { recursive: true });
  for (const name of ["STACK.md", "FEATURES.md", "ARCHITECTURE.md", "PITFALLS.md"]) {
    writeFileSync(join(researchBase, ".gsd", "research", name), "# done\n");
  }
  assert.equal(getDeepStageGate(prefs, researchBase).status, "complete");
  const skipBase = makeIsolatedBaseWithCleanup(t);
  writeFileSync(
    join(skipBase, ".gsd", "PREFERENCES.md"),
    "---\nplanning_depth: deep\nworkflow_prefs_captured: true\n---\n"
  );
  writeValidProject(skipBase);
  writeValidRequirements(skipBase);
  mkdirSync(join(skipBase, ".gsd", "runtime"), { recursive: true });
  writeFileSync(join(skipBase, ".gsd", "runtime", "research-decision.json"), JSON.stringify({ decision: "skip" }));
  assert.equal(getDeepStageGate(prefs, skipBase).status, "complete");
});
test("Deep mode: deep-mode rules registered in correct order", () => {
  const workflowIdx = DISPATCH_RULES.findIndex((r) => r.name === WORKFLOW_PREFS_RULE_NAME);
  const projectIdx = DISPATCH_RULES.findIndex((r) => r.name === PROJECT_RULE_NAME);
  const requirementsIdx = DISPATCH_RULES.findIndex((r) => r.name === REQUIREMENTS_RULE_NAME);
  const researchDecisionIdx = DISPATCH_RULES.findIndex((r) => r.name === RESEARCH_DECISION_RULE_NAME);
  const researchProjectIdx = DISPATCH_RULES.findIndex((r) => r.name === RESEARCH_PROJECT_RULE_NAME);
  const milestoneIdx = DISPATCH_RULES.findIndex((r) => r.name === "pre-planning (no context) \u2192 discuss-milestone");
  assert.ok(workflowIdx >= 0, "workflow-preferences rule must be registered");
  assert.ok(projectIdx >= 0, "project rule must be registered");
  assert.ok(requirementsIdx >= 0, "requirements rule must be registered");
  assert.ok(researchDecisionIdx >= 0, "research-decision rule must be registered");
  assert.ok(researchProjectIdx >= 0, "research-project rule must be registered");
  assert.ok(milestoneIdx >= 0, "milestone rule must be registered");
  assert.ok(workflowIdx < projectIdx, "workflow-prefs must fire before discuss-project");
  assert.ok(projectIdx < requirementsIdx, "discuss-project must fire before discuss-requirements");
  assert.ok(requirementsIdx < researchDecisionIdx, "discuss-requirements must fire before research-decision");
  assert.ok(researchDecisionIdx < researchProjectIdx, "research-decision must fire before research-project (gate before action)");
  assert.ok(researchProjectIdx < milestoneIdx, "research-project must fire before discuss-milestone");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9kZWVwLXBsYW5uaW5nLW1vZGUtZGlzcGF0Y2gudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NELTIgXHUyMDE0IERlZXAgcGxhbm5pbmcgbW9kZSBkaXNwYXRjaCBiZWhhdmlvciBjb250cmFjdC5cbi8vIFZlcmlmaWVzIHRoZSBuZXcgZGVlcC1tb2RlIGRpc3BhdGNoIHJ1bGVzIGd1YXJkIGNvcnJlY3RseSBvbiBwcmVmcy5wbGFubmluZ19kZXB0aFxuLy8gYW5kIG9uIGFydGlmYWN0IHByZXNlbmNlLCBhbmQgdGhhdCBsaWdodCBtb2RlIGJlaGF2aW9yIGlzIHVuYWZmZWN0ZWQuXG5cbmltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCB0eXBlIHsgVGVzdENvbnRleHQgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMsIG1rZGlyU3luYywgcmVhZEZpbGVTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSBcIm5vZGU6Y3J5cHRvXCI7XG5cbmltcG9ydCB7XG4gIERJU1BBVENIX1JVTEVTLFxuICBnZXREZWVwU3RhZ2VHYXRlLFxuICBoYXNQZW5kaW5nRGVlcFN0YWdlLFxuICByZXNvbHZlRGlzcGF0Y2gsXG4gIHNldFJlc2VhcmNoUHJvamVjdFByb21wdEJ1aWxkZXJGb3JUZXN0LFxuICB0eXBlIERpc3BhdGNoQ29udGV4dCxcbn0gZnJvbSBcIi4uL2F1dG8tZGlzcGF0Y2gudHNcIjtcbmltcG9ydCB0eXBlIHsgR1NEU3RhdGUgfSBmcm9tIFwiLi4vdHlwZXMudHNcIjtcbmltcG9ydCB0eXBlIHsgR1NEUHJlZmVyZW5jZXMgfSBmcm9tIFwiLi4vcHJlZmVyZW5jZXMudHNcIjtcblxuY29uc3QgV09SS0ZMT1dfUFJFRlNfUlVMRV9OQU1FID0gXCJkZWVwOiBwcmUtcGxhbm5pbmcgKG5vIHdvcmtmbG93IHByZWZzKSBcdTIxOTIgd29ya2Zsb3ctcHJlZmVyZW5jZXNcIjtcbmNvbnN0IFBST0pFQ1RfUlVMRV9OQU1FID0gXCJkZWVwOiBwcmUtcGxhbm5pbmcgKG5vIFBST0pFQ1QpIFx1MjE5MiBkaXNjdXNzLXByb2plY3RcIjtcbmNvbnN0IFJFUVVJUkVNRU5UU19SVUxFX05BTUUgPSBcImRlZXA6IHByZS1wbGFubmluZyAobm8gUkVRVUlSRU1FTlRTKSBcdTIxOTIgZGlzY3Vzcy1yZXF1aXJlbWVudHNcIjtcbmNvbnN0IFJFU0VBUkNIX0RFQ0lTSU9OX1JVTEVfTkFNRSA9IFwiZGVlcDogcHJlLXBsYW5uaW5nIChubyByZXNlYXJjaCBkZWNpc2lvbikgXHUyMTkyIHJlc2VhcmNoLWRlY2lzaW9uXCI7XG5jb25zdCBSRVNFQVJDSF9QUk9KRUNUX1JVTEVfTkFNRSA9IFwiZGVlcDogcHJlLXBsYW5uaW5nIChyZXNlYXJjaCBhcHByb3ZlZCwgZmlsZXMgbWlzc2luZykgXHUyMTkyIHJlc2VhcmNoLXByb2plY3RcIjtcblxuY29uc3QgVkFMSURfUFJPSkVDVF9NRCA9IFtcbiAgXCIjIFByb2plY3RcIixcbiAgXCJcIixcbiAgXCIjIyBXaGF0IFRoaXMgSXNcIixcbiAgXCJcIixcbiAgXCJBIHRlc3QgcHJvamVjdC5cIixcbiAgXCJcIixcbiAgXCIjIyBDb3JlIFZhbHVlXCIsXG4gIFwiXCIsXG4gIFwiUmVsaWFibGUgZGlzcGF0Y2ggYmVoYXZpb3IuXCIsXG4gIFwiXCIsXG4gIFwiIyMgQ3VycmVudCBTdGF0ZVwiLFxuICBcIlwiLFxuICBcIlRlc3RzIGFyZSBleGVyY2lzaW5nIGRlZXAgcGxhbm5pbmcuXCIsXG4gIFwiXCIsXG4gIFwiIyMgQXJjaGl0ZWN0dXJlIC8gS2V5IFBhdHRlcm5zXCIsXG4gIFwiXCIsXG4gIFwiTWFya2Rvd24gYXJ0aWZhY3RzIGRyaXZlIHN0YWdlIGdhdGVzLlwiLFxuICBcIlwiLFxuICBcIiMjIENhcGFiaWxpdHkgQ29udHJhY3RcIixcbiAgXCJcIixcbiAgXCJTZWUgYC5nc2QvUkVRVUlSRU1FTlRTLm1kYC5cIixcbiAgXCJcIixcbiAgXCIjIyBNaWxlc3RvbmUgU2VxdWVuY2VcIixcbiAgXCJcIixcbiAgXCItIFsgXSBNMDAxOiBUZXN0IFx1MjAxNCBleGVyY2lzZSBkZWVwIHBsYW5uaW5nIGRpc3BhdGNoXCIsXG4gIFwiXCIsXG5dLmpvaW4oXCJcXG5cIik7XG5cbmNvbnN0IFZBTElEX1JFUVVJUkVNRU5UU19NRCA9IFtcbiAgXCIjIFJlcXVpcmVtZW50c1wiLFxuICBcIlwiLFxuICBcIiMjIEFjdGl2ZVwiLFxuICBcIlwiLFxuICBcIiMjIyBSMDAxIFx1MjAxNCBEaXNwYXRjaCB2YWxpZCBhcnRpZmFjdHNcIixcbiAgXCItIENsYXNzOiBjb3JlLWNhcGFiaWxpdHlcIixcbiAgXCItIFN0YXR1czogYWN0aXZlXCIsXG4gIFwiLSBEZXNjcmlwdGlvbjogVmFsaWQgYXJ0aWZhY3RzIGFsbG93IGRlZXAtbW9kZSBkaXNwYXRjaCB0byBhZHZhbmNlLlwiLFxuICBcIi0gV2h5IGl0IG1hdHRlcnM6IFN0YWdlIGdhdGVzIG11c3Qgbm90IHN0YWxsIHZhbGlkIHByb2plY3RzLlwiLFxuICBcIi0gU291cmNlOiB0ZXN0XCIsXG4gIFwiLSBQcmltYXJ5IG93bmluZyBzbGljZTogTTAwMS9TMDFcIixcbiAgXCItIFN1cHBvcnRpbmcgc2xpY2VzOiBub25lXCIsXG4gIFwiLSBWYWxpZGF0aW9uOiB1bm1hcHBlZFwiLFxuICBcIi0gTm90ZXM6XCIsXG4gIFwiXCIsXG4gIFwiIyMgVmFsaWRhdGVkXCIsXG4gIFwiXCIsXG4gIFwiIyMgRGVmZXJyZWRcIixcbiAgXCJcIixcbiAgXCIjIyBPdXQgb2YgU2NvcGVcIixcbiAgXCJcIixcbiAgXCIjIyBUcmFjZWFiaWxpdHlcIixcbiAgXCJcIixcbiAgXCJ8IElEIHwgQ2xhc3MgfCBTdGF0dXMgfCBQcmltYXJ5IG93bmVyIHwgU3VwcG9ydGluZyB8IFByb29mIHxcIixcbiAgXCJ8LS0tfC0tLXwtLS18LS0tfC0tLXwtLS18XCIsXG4gIFwifCBSMDAxIHwgY29yZS1jYXBhYmlsaXR5IHwgYWN0aXZlIHwgTTAwMS9TMDEgfCBub25lIHwgdW5tYXBwZWQgfFwiLFxuICBcIlwiLFxuICBcIiMjIENvdmVyYWdlIFN1bW1hcnlcIixcbiAgXCJcIixcbiAgXCItIEFjdGl2ZSByZXF1aXJlbWVudHM6IDFcIixcbiAgXCJcIixcbl0uam9pbihcIlxcblwiKTtcblxuY29uc3QgVElOWV9UT0RPX1BST0pFQ1RfTUQgPSBbXG4gIFwiIyBQZXJzb25hbCBUb2RvIEFwcFwiLFxuICBcIlwiLFxuICBcIiMjIFdoYXQgVGhpcyBJc1wiLFxuICBcIlwiLFxuICBcIkEgcGVyc29uYWwgdG9kbyBhcHAgLSBzdGF0aWMgSFRNTC9DU1MvSlMsIG5vIGJhY2tlbmQsIG5vIGFjY291bnRzLiBTaW5nbGUgZmlsZSwgcnVucyBpbiB0aGUgYnJvd3NlciBsb2NhbGx5IG9yIGZyb20gYSBmaWxlLlwiLFxuICBcIlwiLFxuICBcIiMjIENvcmUgVmFsdWVcIixcbiAgXCJcIixcbiAgXCJGYXN0IHRhc2sgY2FwdHVyZSB3aXRoIG1pbmltYWwgZnJpY3Rpb24uXCIsXG4gIFwiXCIsXG4gIFwiIyMgQ3VycmVudCBTdGF0ZVwiLFxuICBcIlwiLFxuICBcIkdyZWVuZmllbGQgYnJvd3Nlci1iYXNlZCBhcHAuIFRhc2tzIHBlcnNpc3QgaW4gbG9jYWxTdG9yYWdlLlwiLFxuICBcIlwiLFxuICBcIiMjIEFyY2hpdGVjdHVyZSAvIEtleSBQYXR0ZXJuc1wiLFxuICBcIlwiLFxuICBcIlB1cmUgSFRNTC9DU1MvSlMsIGNsaWVudC1vbmx5LCBubyBidWlsZCBzdGVwLCBubyBzZXJ2ZXIuXCIsXG4gIFwiXCIsXG4gIFwiIyMgQ2FwYWJpbGl0eSBDb250cmFjdFwiLFxuICBcIlwiLFxuICBcIlNlZSBgLmdzZC9SRVFVSVJFTUVOVFMubWRgLlwiLFxuICBcIlwiLFxuICBcIiMjIE1pbGVzdG9uZSBTZXF1ZW5jZVwiLFxuICBcIlwiLFxuICBcIi0gWyBdIE0wMDE6IFRvZG8gQXBwIFx1MjAxNCBidWlsZCBvbmUtcGFnZSBsb2NhbCB0YXNrIGNhcHR1cmVcIixcbiAgXCJcIixcbl0uam9pbihcIlxcblwiKTtcblxuY29uc3QgVElOWV9UT0RPX1JFUVVJUkVNRU5UU19NRCA9IFtcbiAgXCIjIFJlcXVpcmVtZW50c1wiLFxuICBcIlwiLFxuICBcIiMjIEFjdGl2ZVwiLFxuICBcIlwiLFxuICBcIiMjIyBSMDAxIFx1MjAxNCBGYXN0IHRhc2sgY2FwdHVyZVwiLFxuICBcIi0gQ2xhc3M6IHByaW1hcnktdXNlci1sb29wXCIsXG4gIFwiLSBTdGF0dXM6IGFjdGl2ZVwiLFxuICBcIi0gRGVzY3JpcHRpb246IFVzZXIgY2FuIGFkZCBhIHRhc2sgcXVpY2tseSBmcm9tIHRoZSBicm93c2VyLlwiLFxuICBcIi0gV2h5IGl0IG1hdHRlcnM6IFRoaXMgaXMgdGhlIGNvcmUgbG9vcC5cIixcbiAgXCItIFNvdXJjZTogdXNlclwiLFxuICBcIi0gUHJpbWFyeSBvd25pbmcgc2xpY2U6IE0wMDEvbm9uZSB5ZXRcIixcbiAgXCItIFN1cHBvcnRpbmcgc2xpY2VzOiBub25lXCIsXG4gIFwiLSBWYWxpZGF0aW9uOiBBZGQgYSB0YXNrIGZyb20gdGhlIHBhZ2UuXCIsXG4gIFwiLSBOb3Rlczogc2luZ2xlIGZpbGVcIixcbiAgXCJcIixcbiAgXCIjIyMgUjAwMiBcdTIwMTQgVGFzayBjb21wbGV0aW9uIHdpdGggZG9uZSBzZWN0aW9uXCIsXG4gIFwiLSBDbGFzczogcHJpbWFyeS11c2VyLWxvb3BcIixcbiAgXCItIFN0YXR1czogYWN0aXZlXCIsXG4gIFwiLSBEZXNjcmlwdGlvbjogVXNlciBjYW4gbWFyayBhIHRhc2sgZG9uZSBhbmQgc2VlIGl0IGluIGEgZG9uZSBzZWN0aW9uLlwiLFxuICBcIi0gV2h5IGl0IG1hdHRlcnM6IENvbXBsZXRpb24gaXMgcGFydCBvZiB0aGUgdG9kbyBsb29wLlwiLFxuICBcIi0gU291cmNlOiB1c2VyXCIsXG4gIFwiLSBQcmltYXJ5IG93bmluZyBzbGljZTogTTAwMS9ub25lIHlldFwiLFxuICBcIi0gU3VwcG9ydGluZyBzbGljZXM6IG5vbmVcIixcbiAgXCItIFZhbGlkYXRpb246IE1hcmsgYSB0YXNrIGRvbmUgZnJvbSB0aGUgcGFnZS5cIixcbiAgXCItIE5vdGVzOiBzdGF0aWMgaHRtbFwiLFxuICBcIlwiLFxuICBcIiMjIyBSMDAzIFx1MjAxNCBPcHRpb25hbCBkdWUgZGF0ZSBvbiB0YXNrc1wiLFxuICBcIi0gQ2xhc3M6IGNvcmUtY2FwYWJpbGl0eVwiLFxuICBcIi0gU3RhdHVzOiBhY3RpdmVcIixcbiAgXCItIERlc2NyaXB0aW9uOiBVc2VyIGNhbiBhZGQgYW4gb3B0aW9uYWwgZHVlIGRhdGUgdG8gYSB0YXNrLlwiLFxuICBcIi0gV2h5IGl0IG1hdHRlcnM6IEl0IGFkZHMgdXNlZnVsIGNvbnRleHQgd2l0aG91dCBwcmlvcml0eSBzeXN0ZW1zLlwiLFxuICBcIi0gU291cmNlOiB1c2VyXCIsXG4gIFwiLSBQcmltYXJ5IG93bmluZyBzbGljZTogTTAwMS9ub25lIHlldFwiLFxuICBcIi0gU3VwcG9ydGluZyBzbGljZXM6IG5vbmVcIixcbiAgXCItIFZhbGlkYXRpb246IEFkZCBhIHRhc2sgd2l0aCBhIGR1ZSBkYXRlLlwiLFxuICBcIi0gTm90ZXM6IGJyb3dzZXItYmFzZWRcIixcbiAgXCJcIixcbiAgXCIjIyMgUjAwNCBcdTIwMTQgU3RhdGljIEhUTUwvQ1NTL0pTLCBubyBiYWNrZW5kXCIsXG4gIFwiLSBDbGFzczogY29uc3RyYWludFwiLFxuICBcIi0gU3RhdHVzOiBhY3RpdmVcIixcbiAgXCItIERlc2NyaXB0aW9uOiBUaGUgYXBwIGlzIHN0YXRpYyBIVE1ML0NTUy9KUyB3aXRoIG5vIGJhY2tlbmQsIG5vIHNlcnZlciwgYW5kIG5vIGJ1aWxkIHN0ZXAuXCIsXG4gIFwiLSBXaHkgaXQgbWF0dGVyczogVGhlIHByb2plY3QgbXVzdCBzdGF5IHRpbnkgYW5kIGxvY2FsLlwiLFxuICBcIi0gU291cmNlOiB1c2VyXCIsXG4gIFwiLSBQcmltYXJ5IG93bmluZyBzbGljZTogTTAwMS9ub25lIHlldFwiLFxuICBcIi0gU3VwcG9ydGluZyBzbGljZXM6IG5vbmVcIixcbiAgXCItIFZhbGlkYXRpb246IE9wZW4gdGhlIGZpbGUgZGlyZWN0bHkgaW4gYSBicm93c2VyLlwiLFxuICBcIi0gTm90ZXM6IGNsaWVudC1vbmx5XCIsXG4gIFwiXCIsXG4gIFwiIyMjIFIwMDUgXHUyMDE0IFRhc2tzIHBlcnNpc3QgYWNyb3NzIHBhZ2UgcmVsb2Fkc1wiLFxuICBcIi0gQ2xhc3M6IGNvbnRpbnVpdHlcIixcbiAgXCItIFN0YXR1czogYWN0aXZlXCIsXG4gIFwiLSBEZXNjcmlwdGlvbjogVGFza3MgcGVyc2lzdCBpbiBsb2NhbFN0b3JhZ2UgYWNyb3NzIHJlbG9hZHMuXCIsXG4gIFwiLSBXaHkgaXQgbWF0dGVyczogVGhlIGFwcCByZW1haW5zIHVzZWZ1bCBhZnRlciB0aGUgdGFiIGNsb3Nlcy5cIixcbiAgXCItIFNvdXJjZTogdXNlclwiLFxuICBcIi0gUHJpbWFyeSBvd25pbmcgc2xpY2U6IE0wMDEvbm9uZSB5ZXRcIixcbiAgXCItIFN1cHBvcnRpbmcgc2xpY2VzOiBub25lXCIsXG4gIFwiLSBWYWxpZGF0aW9uOiBSZWxvYWQgdGhlIHBhZ2UgYW5kIHNlZSBzYXZlZCB0YXNrcy5cIixcbiAgXCItIE5vdGVzOiBsb2NhbFN0b3JhZ2VcIixcbiAgXCJcIixcbiAgXCIjIyBWYWxpZGF0ZWRcIixcbiAgXCJcIixcbiAgXCIjIyBEZWZlcnJlZFwiLFxuICBcIlwiLFxuICBcIiMjIE91dCBvZiBTY29wZVwiLFxuICBcIlwiLFxuICBcIiMjIyBSMDA2IFx1MjAxNCBObyBzeW5jIG9yIGFjY291bnRzXCIsXG4gIFwiLSBDbGFzczogYW50aS1mZWF0dXJlXCIsXG4gIFwiLSBTdGF0dXM6IG91dC1vZi1zY29wZVwiLFxuICBcIi0gRGVzY3JpcHRpb246IFRoZSBhcHAgZG9lcyBub3Qgc3VwcG9ydCBzeW5jLCBhY2NvdW50cywgb3IgY2xvdWQgc3RvcmFnZS5cIixcbiAgXCItIFdoeSBpdCBtYXR0ZXJzOiBLZWVwcyB0aGUgcHJvamVjdCBsb2NhbCBhbmQgc2ltcGxlLlwiLFxuICBcIi0gU291cmNlOiB1c2VyXCIsXG4gIFwiLSBQcmltYXJ5IG93bmluZyBzbGljZTogbm9uZVwiLFxuICBcIi0gU3VwcG9ydGluZyBzbGljZXM6IG5vbmVcIixcbiAgXCItIFZhbGlkYXRpb246IE5vIGFjY291bnQgb3Igc3luYyBmbG93IGV4aXN0cy5cIixcbiAgXCItIE5vdGVzOiBubyBhY2NvdW50c1wiLFxuICBcIlwiLFxuICBcIiMjIFRyYWNlYWJpbGl0eVwiLFxuICBcIlwiLFxuICBcInwgSUQgfCBDbGFzcyB8IFN0YXR1cyB8IFByaW1hcnkgb3duZXIgfCBTdXBwb3J0aW5nIHwgUHJvb2YgfFwiLFxuICBcInwtLS18LS0tfC0tLXwtLS18LS0tfC0tLXxcIixcbiAgXCJ8IFIwMDEgfCBwcmltYXJ5LXVzZXItbG9vcCB8IGFjdGl2ZSB8IE0wMDEvbm9uZSB5ZXQgfCBub25lIHwgdW5tYXBwZWQgfFwiLFxuICBcInwgUjAwMiB8IHByaW1hcnktdXNlci1sb29wIHwgYWN0aXZlIHwgTTAwMS9ub25lIHlldCB8IG5vbmUgfCB1bm1hcHBlZCB8XCIsXG4gIFwifCBSMDAzIHwgY29yZS1jYXBhYmlsaXR5IHwgYWN0aXZlIHwgTTAwMS9ub25lIHlldCB8IG5vbmUgfCB1bm1hcHBlZCB8XCIsXG4gIFwifCBSMDA0IHwgY29uc3RyYWludCB8IGFjdGl2ZSB8IE0wMDEvbm9uZSB5ZXQgfCBub25lIHwgdW5tYXBwZWQgfFwiLFxuICBcInwgUjAwNSB8IGNvbnRpbnVpdHkgfCBhY3RpdmUgfCBNMDAxL25vbmUgeWV0IHwgbm9uZSB8IHVubWFwcGVkIHxcIixcbiAgXCJ8IFIwMDYgfCBhbnRpLWZlYXR1cmUgfCBvdXQtb2Ytc2NvcGUgfCBub25lIHwgbm9uZSB8IGV4Y2x1ZGVkIHxcIixcbiAgXCJcIixcbiAgXCIjIyBDb3ZlcmFnZSBTdW1tYXJ5XCIsXG4gIFwiXCIsXG4gIFwiLSBBY3RpdmUgcmVxdWlyZW1lbnRzOiA1XCIsXG4gIFwiXCIsXG5dLmpvaW4oXCJcXG5cIik7XG5cbmZ1bmN0aW9uIG1ha2VJc29sYXRlZEJhc2UoKTogc3RyaW5nIHtcbiAgY29uc3QgYmFzZSA9IGpvaW4odG1wZGlyKCksIGBnc2QtZGVlcC1wbGFubmluZy0ke3JhbmRvbVVVSUQoKX1gKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICByZXR1cm4gYmFzZTtcbn1cblxuZnVuY3Rpb24gbWFrZUlzb2xhdGVkQmFzZVdpdGhDbGVhbnVwKHQ6IFRlc3RDb250ZXh0KTogc3RyaW5nIHtcbiAgY29uc3QgYmFzZSA9IG1ha2VJc29sYXRlZEJhc2UoKTtcbiAgdC5hZnRlcigoKSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfSBjYXRjaCB7fVxuICB9KTtcbiAgcmV0dXJuIGJhc2U7XG59XG5cbmZ1bmN0aW9uIHdyaXRlVmFsaWRQcm9qZWN0KGJhc2U6IHN0cmluZyk6IHZvaWQge1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiUFJPSkVDVC5tZFwiKSwgVkFMSURfUFJPSkVDVF9NRCk7XG59XG5cbmZ1bmN0aW9uIHdyaXRlVmFsaWRSZXF1aXJlbWVudHMoYmFzZTogc3RyaW5nKTogdm9pZCB7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJSRVFVSVJFTUVOVFMubWRcIiksIFZBTElEX1JFUVVJUkVNRU5UU19NRCk7XG59XG5cbmZ1bmN0aW9uIHdyaXRlVGlueVRvZG9Qcm9qZWN0KGJhc2U6IHN0cmluZyk6IHZvaWQge1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiUFJPSkVDVC5tZFwiKSwgVElOWV9UT0RPX1BST0pFQ1RfTUQpO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiUkVRVUlSRU1FTlRTLm1kXCIpLCBUSU5ZX1RPRE9fUkVRVUlSRU1FTlRTX01EKTtcbn1cblxuZnVuY3Rpb24gd3JpdGVDYXB0dXJlZERlZXBQcmVmcyhiYXNlOiBzdHJpbmcpOiB2b2lkIHtcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIlBSRUZFUkVOQ0VTLm1kXCIpLFxuICAgIFwiLS0tXFxucGxhbm5pbmdfZGVwdGg6IGRlZXBcXG53b3JrZmxvd19wcmVmc19jYXB0dXJlZDogdHJ1ZVxcbi0tLVxcblwiLFxuICApO1xufVxuXG5mdW5jdGlvbiB3cml0ZVNraXBwZWRQcm9qZWN0UmVzZWFyY2hEZWNpc2lvbihiYXNlOiBzdHJpbmcpOiB2b2lkIHtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwicnVudGltZVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJydW50aW1lXCIsIFwicmVzZWFyY2gtZGVjaXNpb24uanNvblwiKSwgSlNPTi5zdHJpbmdpZnkoeyBkZWNpc2lvbjogXCJza2lwXCIgfSkpO1xufVxuXG5mdW5jdGlvbiBtYWtlQ3R4KFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICBwcmVmczogR1NEUHJlZmVyZW5jZXMgfCB1bmRlZmluZWQsXG4gIHBoYXNlOiBHU0RTdGF0ZVtcInBoYXNlXCJdID0gXCJwcmUtcGxhbm5pbmdcIixcbik6IERpc3BhdGNoQ29udGV4dCB7XG4gIGNvbnN0IHN0YXRlOiBHU0RTdGF0ZSA9IHtcbiAgICBwaGFzZSxcbiAgICBhY3RpdmVNaWxlc3RvbmU6IHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIgfSxcbiAgICBhY3RpdmVTbGljZTogbnVsbCxcbiAgICBhY3RpdmVUYXNrOiBudWxsLFxuICAgIHJlY2VudERlY2lzaW9uczogW10sXG4gICAgYmxvY2tlcnM6IFtdLFxuICAgIG5leHRBY3Rpb246IFwiXCIsXG4gICAgcmVnaXN0cnk6IFt7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdFwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfV0sXG4gIH07XG4gIHJldHVybiB7XG4gICAgYmFzZVBhdGgsXG4gICAgbWlkOiBcIk0wMDFcIixcbiAgICBtaWRUaXRsZTogXCJUZXN0XCIsXG4gICAgc3RhdGUsXG4gICAgcHJlZnMsXG4gICAgc3RydWN0dXJlZFF1ZXN0aW9uc0F2YWlsYWJsZTogXCJmYWxzZVwiLFxuICB9O1xufVxuXG5mdW5jdGlvbiBydWxlKG5hbWU6IHN0cmluZykge1xuICBjb25zdCByID0gRElTUEFUQ0hfUlVMRVMuZmluZCh4ID0+IHgubmFtZSA9PT0gbmFtZSk7XG4gIGFzc2VydC5vayhyLCBgZGlzcGF0Y2ggcnVsZSBcIiR7bmFtZX1cIiBtdXN0IGV4aXN0YCk7XG4gIHJldHVybiByITtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHdvcmtmbG93LXByZWZlcmVuY2VzIHJ1bGUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJEZWVwIG1vZGU6IHdvcmtmbG93LXByZWZlcmVuY2VzIGRvZXMgTk9UIGRpc3BhdGNoIGluIGxpZ2h0IG1vZGVcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VJc29sYXRlZEJhc2VXaXRoQ2xlYW51cCh0KTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBydWxlKFdPUktGTE9XX1BSRUZTX1JVTEVfTkFNRSkubWF0Y2gobWFrZUN0eChiYXNlLCB1bmRlZmluZWQpKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdCwgbnVsbCk7XG59KTtcblxudGVzdChcIkRlZXAgbW9kZTogd29ya2Zsb3ctcHJlZmVyZW5jZXMgY2FwdHVyZXMgZGVmYXVsdHMgaW4tcHJvY2VzcyB3aGVuIFBSRUZFUkVOQ0VTLm1kIG1pc3NpbmdcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VJc29sYXRlZEJhc2VXaXRoQ2xlYW51cCh0KTtcblxuICBjb25zdCBwcmVmcyA9IHsgcGxhbm5pbmdfZGVwdGg6IFwiZGVlcFwiIH0gYXMgR1NEUHJlZmVyZW5jZXM7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bGUoV09SS0ZMT1dfUFJFRlNfUlVMRV9OQU1FKS5tYXRjaChtYWtlQ3R4KGJhc2UsIHByZWZzKSk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQsIG51bGwsIFwid29ya2Zsb3cgcHJlZnMgYXJlIHdyaXR0ZW4gZGV0ZXJtaW5pc3RpY2FsbHksIG5vdCBkaXNwYXRjaGVkIHRvIGFuIGFnZW50XCIpO1xuICBjb25zdCBjb250ZW50ID0gcmVhZEZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiUFJFRkVSRU5DRVMubWRcIiksIFwidXRmLThcIik7XG4gIGFzc2VydC5tYXRjaChjb250ZW50LCAvXndvcmtmbG93X3ByZWZzX2NhcHR1cmVkOlxccyp0cnVlXFxzKiQvbSk7XG4gIGFzc2VydC5tYXRjaChjb250ZW50LCAvXmNvbW1pdF9wb2xpY3k6XFxzKnBlci10YXNrXFxzKiQvbSk7XG4gIGFzc2VydC5vayhleGlzdHNTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwicnVudGltZVwiLCBcInJlc2VhcmNoLWRlY2lzaW9uLmpzb25cIikpKTtcbn0pO1xuXG50ZXN0KFwiRGVlcCBtb2RlOiB3b3JrZmxvdy1wcmVmZXJlbmNlcyBzZWxmLWhlYWxzIFBSRUZFUkVOQ0VTLm1kIHdoZW4gY2FwdHVyZSBtYXJrZXIgaXMgbWlzc2luZ1wiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUlzb2xhdGVkQmFzZVdpdGhDbGVhbnVwKHQpO1xuXG4gIC8vIFBhcnRpYWwgUFJFRkVSRU5DRVMubWQgKGUuZy4gb25seSBwbGFubmluZ19kZXB0aCBzZXQpIG11c3Qgbm90IGZhbHNlbHlcbiAgLy8gc3VwcHJlc3MgdGhlIGRlZmF1bHRzIHdyaXRlIFx1MjAxNCB0aGUgZXhwbGljaXQgY2FwdHVyZWQgbWFya2VyIGlzIHJlcXVpcmVkLlxuICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiUFJFRkVSRU5DRVMubWRcIiksIFwiLS0tXFxucGxhbm5pbmdfZGVwdGg6IGRlZXBcXG4tLS1cXG5cIik7XG4gIGNvbnN0IHByZWZzID0geyBwbGFubmluZ19kZXB0aDogXCJkZWVwXCIgfSBhcyBHU0RQcmVmZXJlbmNlcztcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVsZShXT1JLRkxPV19QUkVGU19SVUxFX05BTUUpLm1hdGNoKG1ha2VDdHgoYmFzZSwgcHJlZnMpKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdCwgbnVsbCk7XG4gIGNvbnN0IGNvbnRlbnQgPSByZWFkRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJQUkVGRVJFTkNFUy5tZFwiKSwgXCJ1dGYtOFwiKTtcbiAgYXNzZXJ0Lm1hdGNoKGNvbnRlbnQsIC9ed29ya2Zsb3dfcHJlZnNfY2FwdHVyZWQ6XFxzKnRydWVcXHMqJC9tKTtcbiAgYXNzZXJ0Lm1hdGNoKGNvbnRlbnQsIC9eYnJhbmNoX21vZGVsOlxccypzaW5nbGVcXHMqJC9tKTtcbn0pO1xuXG50ZXN0KFwiRGVlcCBtb2RlOiB3b3JrZmxvdy1wcmVmZXJlbmNlcyBzZWxmLWhlYWxzIG1hbGZvcm1lZCBmcm9udG1hdHRlclwiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUlzb2xhdGVkQmFzZVdpdGhDbGVhbnVwKHQpO1xuXG4gIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJQUkVGRVJFTkNFUy5tZFwiKSwgXCItLS1cXG50aGlzIGlzIG5vdCB2YWxpZCB5YW1sOiBbXFxuLS0tXFxuXCIpO1xuICBjb25zdCBwcmVmcyA9IHsgcGxhbm5pbmdfZGVwdGg6IFwiZGVlcFwiIH0gYXMgR1NEUHJlZmVyZW5jZXM7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bGUoV09SS0ZMT1dfUFJFRlNfUlVMRV9OQU1FKS5tYXRjaChtYWtlQ3R4KGJhc2UsIHByZWZzKSk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQsIG51bGwpO1xuICBjb25zdCBjb250ZW50ID0gcmVhZEZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiUFJFRkVSRU5DRVMubWRcIiksIFwidXRmLThcIik7XG4gIGFzc2VydC5tYXRjaChjb250ZW50LCAvXndvcmtmbG93X3ByZWZzX2NhcHR1cmVkOlxccyp0cnVlXFxzKiQvbSk7XG4gIGFzc2VydC5vayhjb250ZW50LmluY2x1ZGVzKFwidGhpcyBpcyBub3QgdmFsaWQgeWFtbFwiKSwgXCJtYWxmb3JtZWQgb3JpZ2luYWwgY29udGVudCBpcyBwcmVzZXJ2ZWQgYXMgYm9keVwiKTtcbn0pO1xuXG50ZXN0KFwiRGVlcCBtb2RlOiB3b3JrZmxvdy1wcmVmZXJlbmNlcyBkb2VzIE5PVCBkaXNwYXRjaCB3aGVuIFBSRUZFUkVOQ0VTLm1kIGhhcyB3b3JrZmxvd19wcmVmc19jYXB0dXJlZDogdHJ1ZVwiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUlzb2xhdGVkQmFzZVdpdGhDbGVhbnVwKHQpO1xuXG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihiYXNlLCBcIi5nc2RcIiwgXCJQUkVGRVJFTkNFUy5tZFwiKSxcbiAgICBcIi0tLVxcbnBsYW5uaW5nX2RlcHRoOiBkZWVwXFxud29ya2Zsb3dfcHJlZnNfY2FwdHVyZWQ6IHRydWVcXG5jb21taXRfcG9saWN5OiBwZXItdGFza1xcbi0tLVxcblwiLFxuICApO1xuICBjb25zdCBwcmVmcyA9IHsgcGxhbm5pbmdfZGVwdGg6IFwiZGVlcFwiIH0gYXMgR1NEUHJlZmVyZW5jZXM7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bGUoV09SS0ZMT1dfUFJFRlNfUlVMRV9OQU1FKS5tYXRjaChtYWtlQ3R4KGJhc2UsIHByZWZzKSk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQsIG51bGwpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBkaXNjdXNzLXByb2plY3QgcnVsZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcIkRlZXAgbW9kZTogZGlzY3Vzcy1wcm9qZWN0IGRvZXMgTk9UIGRpc3BhdGNoIHdoZW4gcGxhbm5pbmdfZGVwdGggaXMgdW5kZWZpbmVkIChkZWZhdWx0IGxpZ2h0KVwiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUlzb2xhdGVkQmFzZVdpdGhDbGVhbnVwKHQpO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bGUoUFJPSkVDVF9SVUxFX05BTUUpLm1hdGNoKG1ha2VDdHgoYmFzZSwgdW5kZWZpbmVkKSk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQsIG51bGwsIFwibGlnaHQgbW9kZSAoZGVmYXVsdCkgbXVzdCBub3QgZmlyZSBkZWVwLW1vZGUgcnVsZVwiKTtcbn0pO1xuXG50ZXN0KFwiRGVlcCBtb2RlOiBkaXNjdXNzLXByb2plY3QgZG9lcyBOT1QgZGlzcGF0Y2ggd2hlbiBwbGFubmluZ19kZXB0aCBpcyAnbGlnaHQnXCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlSXNvbGF0ZWRCYXNlV2l0aENsZWFudXAodCk7XG5cbiAgY29uc3QgcHJlZnMgPSB7IHBsYW5uaW5nX2RlcHRoOiBcImxpZ2h0XCIgfSBhcyBHU0RQcmVmZXJlbmNlcztcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVsZShQUk9KRUNUX1JVTEVfTkFNRSkubWF0Y2gobWFrZUN0eChiYXNlLCBwcmVmcykpO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LCBudWxsLCBcImV4cGxpY2l0IGxpZ2h0IG1vZGUgbXVzdCBub3QgZmlyZSBkZWVwLW1vZGUgcnVsZVwiKTtcbn0pO1xuXG50ZXN0KFwiRGVlcCBtb2RlOiBkaXNjdXNzLXByb2plY3QgRE9FUyBkaXNwYXRjaCB3aGVuIHBsYW5uaW5nX2RlcHRoIGlzICdkZWVwJyBhbmQgUFJPSkVDVC5tZCBtaXNzaW5nXCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlSXNvbGF0ZWRCYXNlV2l0aENsZWFudXAodCk7XG5cbiAgY29uc3QgcHJlZnMgPSB7IHBsYW5uaW5nX2RlcHRoOiBcImRlZXBcIiB9IGFzIEdTRFByZWZlcmVuY2VzO1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBydWxlKFBST0pFQ1RfUlVMRV9OQU1FKS5tYXRjaChtYWtlQ3R4KGJhc2UsIHByZWZzKSk7XG4gIGFzc2VydC5vayhyZXN1bHQgJiYgcmVzdWx0LmFjdGlvbiA9PT0gXCJkaXNwYXRjaFwiLCBcImRlZXAgbW9kZSArIG1pc3NpbmcgUFJPSkVDVC5tZCBtdXN0IGRpc3BhdGNoXCIpO1xuICBpZiAocmVzdWx0LmFjdGlvbiA9PT0gXCJkaXNwYXRjaFwiKSB7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC51bml0VHlwZSwgXCJkaXNjdXNzLXByb2plY3RcIik7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC51bml0SWQsIFwiUFJPSkVDVFwiKTtcbiAgICBhc3NlcnQub2socmVzdWx0LnByb21wdC5sZW5ndGggPiAwLCBcInByb21wdCBtdXN0IGJlIG5vbi1lbXB0eVwiKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJEZWVwIG1vZGU6IGRpc2N1c3MtcHJvamVjdCBkb2VzIE5PVCBkaXNwYXRjaCB3aGVuIFBST0pFQ1QubWQgYWxyZWFkeSBleGlzdHMgYW5kIGlzIHZhbGlkXCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlSXNvbGF0ZWRCYXNlV2l0aENsZWFudXAodCk7XG5cbiAgd3JpdGVWYWxpZFByb2plY3QoYmFzZSk7XG4gIGNvbnN0IHByZWZzID0geyBwbGFubmluZ19kZXB0aDogXCJkZWVwXCIgfSBhcyBHU0RQcmVmZXJlbmNlcztcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVsZShQUk9KRUNUX1JVTEVfTkFNRSkubWF0Y2gobWFrZUN0eChiYXNlLCBwcmVmcykpO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LCBudWxsLCBcInZhbGlkIFBST0pFQ1QubWQgbXVzdCBmYWxsIHRocm91Z2ggdG8gbmV4dCBydWxlXCIpO1xufSk7XG5cbnRlc3QoXCJEZWVwIG1vZGU6IGRpc2N1c3MtcHJvamVjdCBET0VTIGRpc3BhdGNoIHdoZW4gUFJPSkVDVC5tZCBleGlzdHMgYnV0IGlzIGludmFsaWRcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VJc29sYXRlZEJhc2VXaXRoQ2xlYW51cCh0KTtcblxuICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiUFJPSkVDVC5tZFwiKSwgXCIjIFByb2plY3RcXG5cIik7XG4gIGNvbnN0IHByZWZzID0geyBwbGFubmluZ19kZXB0aDogXCJkZWVwXCIgfSBhcyBHU0RQcmVmZXJlbmNlcztcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVsZShQUk9KRUNUX1JVTEVfTkFNRSkubWF0Y2gobWFrZUN0eChiYXNlLCBwcmVmcykpO1xuICBhc3NlcnQub2socmVzdWx0ICYmIHJlc3VsdC5hY3Rpb24gPT09IFwiZGlzcGF0Y2hcIiwgXCJpbnZhbGlkIFBST0pFQ1QubWQgbXVzdCByZS1maXJlIGRpc2N1c3MtcHJvamVjdFwiKTtcbiAgaWYgKHJlc3VsdC5hY3Rpb24gPT09IFwiZGlzcGF0Y2hcIikge1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQudW5pdFR5cGUsIFwiZGlzY3Vzcy1wcm9qZWN0XCIpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQudW5pdElkLCBcIlBST0pFQ1RcIik7XG4gIH1cbn0pO1xuXG50ZXN0KFwiRGVlcCBtb2RlOiBkaXNjdXNzLXByb2plY3QgZG9lcyBOT1QgZGlzcGF0Y2ggaW4gbm9uLXByZS1wbGFubmluZyBwaGFzZXNcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VJc29sYXRlZEJhc2VXaXRoQ2xlYW51cCh0KTtcblxuICBjb25zdCBwcmVmcyA9IHsgcGxhbm5pbmdfZGVwdGg6IFwiZGVlcFwiIH0gYXMgR1NEUHJlZmVyZW5jZXM7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bGUoUFJPSkVDVF9SVUxFX05BTUUpLm1hdGNoKG1ha2VDdHgoYmFzZSwgcHJlZnMsIFwiZXhlY3V0aW5nXCIpKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdCwgbnVsbCwgXCJleGVjdXRpb24gcGhhc2VzIG11c3Qgbm90IGZpcmUgcHJvamVjdC1sZXZlbCBkaXNjdXNzaW9uXCIpO1xufSk7XG5cbnRlc3QoXCJEZWVwIG1vZGU6IGRpc2N1c3MtcHJvamVjdCBET0VTIGRpc3BhdGNoIGluIG5lZWRzLWRpc2N1c3Npb24gcGhhc2VcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VJc29sYXRlZEJhc2VXaXRoQ2xlYW51cCh0KTtcblxuICBjb25zdCBwcmVmcyA9IHsgcGxhbm5pbmdfZGVwdGg6IFwiZGVlcFwiIH0gYXMgR1NEUHJlZmVyZW5jZXM7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bGUoUFJPSkVDVF9SVUxFX05BTUUpLm1hdGNoKG1ha2VDdHgoYmFzZSwgcHJlZnMsIFwibmVlZHMtZGlzY3Vzc2lvblwiKSk7XG4gIGFzc2VydC5vayhyZXN1bHQgJiYgcmVzdWx0LmFjdGlvbiA9PT0gXCJkaXNwYXRjaFwiLCBcIm5lZWRzLWRpc2N1c3Npb24gaXMgYSB2YWxpZCBlbnRyeSBwaGFzZVwiKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgZGlzY3Vzcy1yZXF1aXJlbWVudHMgcnVsZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcIkRlZXAgbW9kZTogZGlzY3Vzcy1yZXF1aXJlbWVudHMgZG9lcyBOT1QgZGlzcGF0Y2ggaW4gbGlnaHQgbW9kZVwiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUlzb2xhdGVkQmFzZVdpdGhDbGVhbnVwKHQpO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bGUoUkVRVUlSRU1FTlRTX1JVTEVfTkFNRSkubWF0Y2gobWFrZUN0eChiYXNlLCB1bmRlZmluZWQpKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdCwgbnVsbCwgXCJsaWdodCBtb2RlIG11c3Qgbm90IGZpcmUgZGVlcC1tb2RlIHJlcXVpcmVtZW50cyBydWxlXCIpO1xufSk7XG5cbnRlc3QoXCJEZWVwIG1vZGU6IGRpc2N1c3MtcmVxdWlyZW1lbnRzIGRvZXMgTk9UIGRpc3BhdGNoIHdoZW4gUFJPSkVDVC5tZCBtaXNzaW5nIChwcm9qZWN0IHJ1bGUgbXVzdCBydW4gZmlyc3QpXCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlSXNvbGF0ZWRCYXNlV2l0aENsZWFudXAodCk7XG5cbiAgY29uc3QgcHJlZnMgPSB7IHBsYW5uaW5nX2RlcHRoOiBcImRlZXBcIiB9IGFzIEdTRFByZWZlcmVuY2VzO1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBydWxlKFJFUVVJUkVNRU5UU19SVUxFX05BTUUpLm1hdGNoKG1ha2VDdHgoYmFzZSwgcHJlZnMpKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdCwgbnVsbCwgXCJQUk9KRUNULm1kIG1pc3NpbmcgXHUyMDE0IGVhcmxpZXIgcnVsZSBoYW5kbGVzXCIpO1xufSk7XG5cbnRlc3QoXCJEZWVwIG1vZGU6IGRpc2N1c3MtcmVxdWlyZW1lbnRzIERPRVMgZGlzcGF0Y2ggd2hlbiBQUk9KRUNULm1kIGV4aXN0cyBhbmQgUkVRVUlSRU1FTlRTLm1kIG1pc3NpbmdcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VJc29sYXRlZEJhc2VXaXRoQ2xlYW51cCh0KTtcblxuICB3cml0ZVZhbGlkUHJvamVjdChiYXNlKTtcbiAgY29uc3QgcHJlZnMgPSB7IHBsYW5uaW5nX2RlcHRoOiBcImRlZXBcIiB9IGFzIEdTRFByZWZlcmVuY2VzO1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBydWxlKFJFUVVJUkVNRU5UU19SVUxFX05BTUUpLm1hdGNoKG1ha2VDdHgoYmFzZSwgcHJlZnMpKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdCAmJiByZXN1bHQuYWN0aW9uID09PSBcImRpc3BhdGNoXCIsIFwiZGVlcCBtb2RlICsgUFJPSkVDVC5tZCBwcmVzZW50ICsgUkVRVUlSRU1FTlRTLm1kIG1pc3NpbmcgbXVzdCBkaXNwYXRjaFwiKTtcbiAgaWYgKHJlc3VsdC5hY3Rpb24gPT09IFwiZGlzcGF0Y2hcIikge1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQudW5pdFR5cGUsIFwiZGlzY3Vzcy1yZXF1aXJlbWVudHNcIik7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC51bml0SWQsIFwiUkVRVUlSRU1FTlRTXCIpO1xuICB9XG59KTtcblxudGVzdChcIkRlZXAgbW9kZTogZGlzY3Vzcy1yZXF1aXJlbWVudHMgZG9lcyBOT1QgZGlzcGF0Y2ggd2hlbiBSRVFVSVJFTUVOVFMubWQgYWxyZWFkeSBleGlzdHMgYW5kIGlzIHZhbGlkXCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlSXNvbGF0ZWRCYXNlV2l0aENsZWFudXAodCk7XG5cbiAgd3JpdGVDYXB0dXJlZERlZXBQcmVmcyhiYXNlKTtcbiAgd3JpdGVWYWxpZFByb2plY3QoYmFzZSk7XG4gIHdyaXRlVmFsaWRSZXF1aXJlbWVudHMoYmFzZSk7XG4gIGNvbnN0IHByZWZzID0geyBwbGFubmluZ19kZXB0aDogXCJkZWVwXCIgfSBhcyBHU0RQcmVmZXJlbmNlcztcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVsZShSRVFVSVJFTUVOVFNfUlVMRV9OQU1FKS5tYXRjaChtYWtlQ3R4KGJhc2UsIHByZWZzKSk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQsIG51bGwsIFwidmFsaWQgUkVRVUlSRU1FTlRTLm1kIG11c3QgZmFsbCB0aHJvdWdoXCIpO1xufSk7XG5cbnRlc3QoXCJEZWVwIG1vZGU6IGRpc2N1c3MtcmVxdWlyZW1lbnRzIERPRVMgZGlzcGF0Y2ggd2hlbiBSRVFVSVJFTUVOVFMubWQgZXhpc3RzIGJ1dCBpcyBpbnZhbGlkXCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlSXNvbGF0ZWRCYXNlV2l0aENsZWFudXAodCk7XG5cbiAgd3JpdGVWYWxpZFByb2plY3QoYmFzZSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJSRVFVSVJFTUVOVFMubWRcIiksIFwiIyBSZXF1aXJlbWVudHNcXG5cIik7XG4gIGNvbnN0IHByZWZzID0geyBwbGFubmluZ19kZXB0aDogXCJkZWVwXCIgfSBhcyBHU0RQcmVmZXJlbmNlcztcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVsZShSRVFVSVJFTUVOVFNfUlVMRV9OQU1FKS5tYXRjaChtYWtlQ3R4KGJhc2UsIHByZWZzKSk7XG4gIGFzc2VydC5vayhyZXN1bHQgJiYgcmVzdWx0LmFjdGlvbiA9PT0gXCJkaXNwYXRjaFwiLCBcImludmFsaWQgUkVRVUlSRU1FTlRTLm1kIG11c3QgcmUtZmlyZSBkaXNjdXNzLXJlcXVpcmVtZW50c1wiKTtcbiAgaWYgKHJlc3VsdC5hY3Rpb24gPT09IFwiZGlzcGF0Y2hcIikge1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQudW5pdFR5cGUsIFwiZGlzY3Vzcy1yZXF1aXJlbWVudHNcIik7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC51bml0SWQsIFwiUkVRVUlSRU1FTlRTXCIpO1xuICB9XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHJlc2VhcmNoLWRlY2lzaW9uIHJ1bGUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJEZWVwIG1vZGU6IHJlc2VhcmNoLWRlY2lzaW9uIGRvZXMgTk9UIGRpc3BhdGNoIGluIGxpZ2h0IG1vZGVcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VJc29sYXRlZEJhc2VXaXRoQ2xlYW51cCh0KTtcblxuICB3cml0ZVZhbGlkUHJvamVjdChiYXNlKTtcbiAgd3JpdGVWYWxpZFJlcXVpcmVtZW50cyhiYXNlKTtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVsZShSRVNFQVJDSF9ERUNJU0lPTl9SVUxFX05BTUUpLm1hdGNoKG1ha2VDdHgoYmFzZSwgdW5kZWZpbmVkKSk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQsIG51bGwpO1xufSk7XG5cbnRlc3QoXCJEZWVwIG1vZGU6IHJlc2VhcmNoLWRlY2lzaW9uIGRvZXMgTk9UIGRpc3BhdGNoIHdoZW4gUkVRVUlSRU1FTlRTLm1kIG1pc3NpbmdcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VJc29sYXRlZEJhc2VXaXRoQ2xlYW51cCh0KTtcblxuICB3cml0ZVZhbGlkUHJvamVjdChiYXNlKTtcbiAgLy8gTm8gUkVRVUlSRU1FTlRTLm1kXG4gIGNvbnN0IHByZWZzID0geyBwbGFubmluZ19kZXB0aDogXCJkZWVwXCIgfSBhcyBHU0RQcmVmZXJlbmNlcztcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVsZShSRVNFQVJDSF9ERUNJU0lPTl9SVUxFX05BTUUpLm1hdGNoKG1ha2VDdHgoYmFzZSwgcHJlZnMpKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdCwgbnVsbCwgXCJSRVFVSVJFTUVOVFMubWQgbXVzdCBleGlzdCBiZWZvcmUgcmVzZWFyY2ggZGVjaXNpb24gaXMgYXNrZWRcIik7XG59KTtcblxudGVzdChcIkRlZXAgbW9kZTogcmVzZWFyY2gtZGVjaXNpb24gZG9lcyBOT1QgZGlzcGF0Y2ggd2hlbiBtYXJrZXIgaXMgbWlzc2luZyBiZWNhdXNlIGRlZmF1bHQgaXMgc2tpcFwiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUlzb2xhdGVkQmFzZVdpdGhDbGVhbnVwKHQpO1xuXG4gIHdyaXRlQ2FwdHVyZWREZWVwUHJlZnMoYmFzZSk7XG4gIHdyaXRlVmFsaWRQcm9qZWN0KGJhc2UpO1xuICB3cml0ZVZhbGlkUmVxdWlyZW1lbnRzKGJhc2UpO1xuICBjb25zdCBwcmVmcyA9IHsgcGxhbm5pbmdfZGVwdGg6IFwiZGVlcFwiIH0gYXMgR1NEUHJlZmVyZW5jZXM7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bGUoUkVTRUFSQ0hfREVDSVNJT05fUlVMRV9OQU1FKS5tYXRjaChtYWtlQ3R4KGJhc2UsIHByZWZzKSk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQsIG51bGwpO1xuICBjb25zdCBkZWNpc2lvbiA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwicnVudGltZVwiLCBcInJlc2VhcmNoLWRlY2lzaW9uLmpzb25cIiksIFwidXRmLThcIikpO1xuICBhc3NlcnQuZXF1YWwoZGVjaXNpb24uZGVjaXNpb24sIFwic2tpcFwiKTtcbiAgYXNzZXJ0LmVxdWFsKGRlY2lzaW9uLnNvdXJjZSwgXCJ3b3JrZmxvdy1wcmVmZXJlbmNlc1wiKTtcbiAgYXNzZXJ0LmVxdWFsKGRlY2lzaW9uLnJlYXNvbiwgXCJtaXNzaW5nLWRlZmF1bHQtcmVwYWlyXCIpO1xufSk7XG5cbnRlc3QoXCJEZWVwIG1vZGU6IHJlc2VhcmNoLWRlY2lzaW9uIGRvZXMgTk9UIGRpc3BhdGNoIHdoZW4gZGVjaXNpb24gbWFya2VyIGV4aXN0c1wiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUlzb2xhdGVkQmFzZVdpdGhDbGVhbnVwKHQpO1xuXG4gIHdyaXRlVmFsaWRQcm9qZWN0KGJhc2UpO1xuICB3cml0ZVZhbGlkUmVxdWlyZW1lbnRzKGJhc2UpO1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJydW50aW1lXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcInJ1bnRpbWVcIiwgXCJyZXNlYXJjaC1kZWNpc2lvbi5qc29uXCIpLCBKU09OLnN0cmluZ2lmeSh7IGRlY2lzaW9uOiBcInNraXBcIiB9KSk7XG4gIGNvbnN0IHByZWZzID0geyBwbGFubmluZ19kZXB0aDogXCJkZWVwXCIgfSBhcyBHU0RQcmVmZXJlbmNlcztcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVsZShSRVNFQVJDSF9ERUNJU0lPTl9SVUxFX05BTUUpLm1hdGNoKG1ha2VDdHgoYmFzZSwgcHJlZnMpKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdCwgbnVsbCwgXCJkZWNpc2lvbiBhbHJlYWR5IHJlY29yZGVkIFx1MjAxNCBmYWxsIHRocm91Z2hcIik7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHJlc2VhcmNoLXByb2plY3QgcnVsZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gc2V0dXBSZWFkeUZvclJlc2VhcmNoUHJvamVjdChiYXNlOiBzdHJpbmcpOiB2b2lkIHtcbiAgd3JpdGVDYXB0dXJlZERlZXBQcmVmcyhiYXNlKTtcbiAgd3JpdGVWYWxpZFByb2plY3QoYmFzZSk7XG4gIHdyaXRlVmFsaWRSZXF1aXJlbWVudHMoYmFzZSk7XG4gIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcInJ1bnRpbWVcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwicnVudGltZVwiLCBcInJlc2VhcmNoLWRlY2lzaW9uLmpzb25cIiksXG4gICAgSlNPTi5zdHJpbmdpZnkoeyBkZWNpc2lvbjogXCJyZXNlYXJjaFwiLCBzb3VyY2U6IFwicmVzZWFyY2gtZGVjaXNpb25cIiwgZGVjaWRlZF9hdDogXCIyMDI2LTA0LTI3VDAwOjAwOjAwWlwiIH0pLFxuICApO1xufVxuXG50ZXN0KFwiRGVlcCBtb2RlOiByZXNlYXJjaC1wcm9qZWN0IGRvZXMgTk9UIGRpc3BhdGNoIGluIGxpZ2h0IG1vZGVcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VJc29sYXRlZEJhc2VXaXRoQ2xlYW51cCh0KTtcblxuICBzZXR1cFJlYWR5Rm9yUmVzZWFyY2hQcm9qZWN0KGJhc2UpO1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBydWxlKFJFU0VBUkNIX1BST0pFQ1RfUlVMRV9OQU1FKS5tYXRjaChtYWtlQ3R4KGJhc2UsIHVuZGVmaW5lZCkpO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LCBudWxsKTtcbn0pO1xuXG50ZXN0KFwiRGVlcCBtb2RlOiByZXNlYXJjaC1wcm9qZWN0IGRvZXMgTk9UIGRpc3BhdGNoIHdoZW4gZGVjaXNpb24gbWFya2VyIG1pc3NpbmdcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VJc29sYXRlZEJhc2VXaXRoQ2xlYW51cCh0KTtcblxuICB3cml0ZVZhbGlkUHJvamVjdChiYXNlKTtcbiAgd3JpdGVWYWxpZFJlcXVpcmVtZW50cyhiYXNlKTtcbiAgLy8gTm8gZGVjaXNpb24gbWFya2VyXG4gIGNvbnN0IHByZWZzID0geyBwbGFubmluZ19kZXB0aDogXCJkZWVwXCIgfSBhcyBHU0RQcmVmZXJlbmNlcztcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVsZShSRVNFQVJDSF9QUk9KRUNUX1JVTEVfTkFNRSkubWF0Y2gobWFrZUN0eChiYXNlLCBwcmVmcykpO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LCBudWxsKTtcbn0pO1xuXG50ZXN0KFwiRGVlcCBtb2RlOiByZXNlYXJjaC1wcm9qZWN0IGRvZXMgTk9UIGRpc3BhdGNoIHdoZW4gdXNlciBjaG9zZSAnc2tpcCdcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VJc29sYXRlZEJhc2VXaXRoQ2xlYW51cCh0KTtcblxuICB3cml0ZVZhbGlkUHJvamVjdChiYXNlKTtcbiAgd3JpdGVWYWxpZFJlcXVpcmVtZW50cyhiYXNlKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwicnVudGltZVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJydW50aW1lXCIsIFwicmVzZWFyY2gtZGVjaXNpb24uanNvblwiKSwgSlNPTi5zdHJpbmdpZnkoeyBkZWNpc2lvbjogXCJza2lwXCIgfSkpO1xuICBjb25zdCBwcmVmcyA9IHsgcGxhbm5pbmdfZGVwdGg6IFwiZGVlcFwiIH0gYXMgR1NEUHJlZmVyZW5jZXM7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bGUoUkVTRUFSQ0hfUFJPSkVDVF9SVUxFX05BTUUpLm1hdGNoKG1ha2VDdHgoYmFzZSwgcHJlZnMpKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdCwgbnVsbCwgXCJza2lwIGRlY2lzaW9uIG11c3Qgc2hvcnQtY2lyY3VpdCByZXNlYXJjaC1wcm9qZWN0XCIpO1xufSk7XG5cbnRlc3QoXCJEZWVwIG1vZGU6IHJlc2VhcmNoLXByb2plY3QgRE9FUyBkaXNwYXRjaCB3aGVuIGRlY2lzaW9uIGlzICdyZXNlYXJjaCcgYW5kIHJlc2VhcmNoIGZpbGVzIG1pc3NpbmdcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VJc29sYXRlZEJhc2VXaXRoQ2xlYW51cCh0KTtcblxuICBzZXR1cFJlYWR5Rm9yUmVzZWFyY2hQcm9qZWN0KGJhc2UpO1xuICBjb25zdCBwcmVmcyA9IHsgcGxhbm5pbmdfZGVwdGg6IFwiZGVlcFwiIH0gYXMgR1NEUHJlZmVyZW5jZXM7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bGUoUkVTRUFSQ0hfUFJPSkVDVF9SVUxFX05BTUUpLm1hdGNoKG1ha2VDdHgoYmFzZSwgcHJlZnMpKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdCAmJiByZXN1bHQuYWN0aW9uID09PSBcImRpc3BhdGNoXCIpO1xuICBpZiAocmVzdWx0LmFjdGlvbiA9PT0gXCJkaXNwYXRjaFwiKSB7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC51bml0VHlwZSwgXCJyZXNlYXJjaC1wcm9qZWN0XCIpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQudW5pdElkLCBcIlJFU0VBUkNILVBST0pFQ1RcIik7XG4gIH1cbiAgYXNzZXJ0Lm9rKFxuICAgIGV4aXN0c1N5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJydW50aW1lXCIsIFwicmVzZWFyY2gtcHJvamVjdC1pbmZsaWdodFwiKSksXG4gICAgXCJkaXNwYXRjaCBtdXN0IGNyZWF0ZSB0aGUgaW4tZmxpZ2h0IG1hcmtlciBiZWZvcmUgcmV0dXJuaW5nXCIsXG4gICk7XG59KTtcblxudGVzdChcIkRlZXAgbW9kZTogcmVzZWFyY2gtcHJvamVjdCBub3JtYWxpemVzIGxlZ2FjeSB3b3JrZmxvdy1kZWZhdWx0ZWQgcmVzZWFyY2ggdG8gc2tpcFwiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUlzb2xhdGVkQmFzZVdpdGhDbGVhbnVwKHQpO1xuXG4gIHdyaXRlQ2FwdHVyZWREZWVwUHJlZnMoYmFzZSk7XG4gIHdyaXRlVGlueVRvZG9Qcm9qZWN0KGJhc2UpO1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJydW50aW1lXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKGJhc2UsIFwiLmdzZFwiLCBcInJ1bnRpbWVcIiwgXCJyZXNlYXJjaC1kZWNpc2lvbi5qc29uXCIpLFxuICAgIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgIGRlY2lzaW9uOiBcInJlc2VhcmNoXCIsXG4gICAgICBkZWNpZGVkX2F0OiBcIjIwMjYtMDQtMjdUMDA6MDA6MDBaXCIsXG4gICAgICBzb3VyY2U6IFwid29ya2Zsb3ctcHJlZmVyZW5jZXNcIixcbiAgICB9KSxcbiAgKTtcblxuICBjb25zdCBwcmVmcyA9IHsgcGxhbm5pbmdfZGVwdGg6IFwiZGVlcFwiIH0gYXMgR1NEUHJlZmVyZW5jZXM7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bGUoUkVTRUFSQ0hfUFJPSkVDVF9SVUxFX05BTUUpLm1hdGNoKG1ha2VDdHgoYmFzZSwgcHJlZnMpKTtcblxuICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LCBudWxsLCBcInRpbnkgcHJvamVjdCBzaG91bGQgZmFsbCB0aHJvdWdoIGFmdGVyIHJld3JpdGluZyBkZWNpc2lvbiB0byBza2lwXCIpO1xuICBhc3NlcnQuZXF1YWwoXG4gICAgZXhpc3RzU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcInJ1bnRpbWVcIiwgXCJyZXNlYXJjaC1wcm9qZWN0LWluZmxpZ2h0XCIpKSxcbiAgICBmYWxzZSxcbiAgICBcImZhc3QgcGF0aCBtdXN0IG5vdCBjbGFpbSB0aGUgcmVzZWFyY2gtcHJvamVjdCBpbi1mbGlnaHQgbWFya2VyXCIsXG4gICk7XG5cbiAgY29uc3QgZGVjaXNpb24gPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcInJ1bnRpbWVcIiwgXCJyZXNlYXJjaC1kZWNpc2lvbi5qc29uXCIpLCBcInV0Zi04XCIpKTtcbiAgYXNzZXJ0LmVxdWFsKGRlY2lzaW9uLmRlY2lzaW9uLCBcInNraXBcIik7XG4gIGFzc2VydC5lcXVhbChkZWNpc2lvbi5zb3VyY2UsIFwid29ya2Zsb3ctcHJlZmVyZW5jZXNcIik7XG4gIGFzc2VydC5lcXVhbChkZWNpc2lvbi5wcmV2aW91c19zb3VyY2UsIFwid29ya2Zsb3ctcHJlZmVyZW5jZXNcIik7XG4gIGFzc2VydC5lcXVhbChkZWNpc2lvbi5yZWFzb24sIFwibGVnYWN5LXdvcmtmbG93LXJlc2VhcmNoLWRlZmF1bHRcIik7XG4gIGFzc2VydC5lcXVhbChnZXREZWVwU3RhZ2VHYXRlKHByZWZzLCBiYXNlKS5zdGF0dXMsIFwiY29tcGxldGVcIik7XG59KTtcblxudGVzdChcIkRlZXAgbW9kZSBnYXRlIGlnbm9yZXMgc3RhbGUgYmxvY2tlcnMgZm9yIGxlZ2FjeSB3b3JrZmxvdy1kZWZhdWx0ZWQgcmVzZWFyY2hcIiwgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VJc29sYXRlZEJhc2VXaXRoQ2xlYW51cCh0KTtcblxuICB3cml0ZUNhcHR1cmVkRGVlcFByZWZzKGJhc2UpO1xuICB3cml0ZVRpbnlUb2RvUHJvamVjdChiYXNlKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwicnVudGltZVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihiYXNlLCBcIi5nc2RcIiwgXCJydW50aW1lXCIsIFwicmVzZWFyY2gtZGVjaXNpb24uanNvblwiKSxcbiAgICBKU09OLnN0cmluZ2lmeSh7XG4gICAgICBkZWNpc2lvbjogXCJyZXNlYXJjaFwiLFxuICAgICAgZGVjaWRlZF9hdDogXCIyMDI2LTA0LTI3VDAwOjAwOjAwWlwiLFxuICAgICAgc291cmNlOiBcIndvcmtmbG93LXByZWZlcmVuY2VzXCIsXG4gICAgfSksXG4gICk7XG4gIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcInJlc2VhcmNoXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIFtcIlNUQUNLXCIsIFwiRkVBVFVSRVNcIiwgXCJBUkNISVRFQ1RVUkVcIiwgXCJQSVRGQUxMU1wiXSkge1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJyZXNlYXJjaFwiLCBgJHtuYW1lfS1CTE9DS0VSLm1kYCksIFwiIyBibG9ja2VkXFxuXCIpO1xuICB9XG5cbiAgY29uc3QgcHJlZnMgPSB7IHBsYW5uaW5nX2RlcHRoOiBcImRlZXBcIiB9IGFzIEdTRFByZWZlcmVuY2VzO1xuICBjb25zdCBnYXRlID0gZ2V0RGVlcFN0YWdlR2F0ZShwcmVmcywgYmFzZSk7XG5cbiAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICB7IHN0YXR1czogZ2F0ZS5zdGF0dXMsIHN0YWdlOiBnYXRlLnN0YWdlIH0sXG4gICAgeyBzdGF0dXM6IFwiY29tcGxldGVcIiwgc3RhZ2U6IG51bGwgfSxcbiAgICBcIndvcmtmbG93LWRlZmF1bHRlZCB0aW55IGFwcHMgc2hvdWxkIG5vdCBnZXQgdHJhcHBlZCBieSBzdGFsZSByZXNlYXJjaCBibG9ja2Vyc1wiLFxuICApO1xuICBhc3NlcnQuZXF1YWwoaGFzUGVuZGluZ0RlZXBTdGFnZShwcmVmcywgYmFzZSksIGZhbHNlKTtcbiAgY29uc3QgZGVjaXNpb24gPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcInJ1bnRpbWVcIiwgXCJyZXNlYXJjaC1kZWNpc2lvbi5qc29uXCIpLCBcInV0Zi04XCIpKTtcbiAgYXNzZXJ0LmVxdWFsKGRlY2lzaW9uLmRlY2lzaW9uLCBcInNraXBcIik7XG4gIGFzc2VydC5lcXVhbChkZWNpc2lvbi5zb3VyY2UsIFwid29ya2Zsb3ctcHJlZmVyZW5jZXNcIik7XG4gIGFzc2VydC5lcXVhbChkZWNpc2lvbi5wcmV2aW91c19zb3VyY2UsIFwid29ya2Zsb3ctcHJlZmVyZW5jZXNcIik7XG59KTtcblxudGVzdChcIkRlZXAgbW9kZTogcmVzZWFyY2gtcHJvamVjdCBob25vcnMgZXhwbGljaXQgcmVzZWFyY2ggZGVjaXNpb25zIGZvciB0aW55IHN0YXRpYyBhcHBzXCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlSXNvbGF0ZWRCYXNlV2l0aENsZWFudXAodCk7XG5cbiAgd3JpdGVDYXB0dXJlZERlZXBQcmVmcyhiYXNlKTtcbiAgd3JpdGVUaW55VG9kb1Byb2plY3QoYmFzZSk7XG4gIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcInJ1bnRpbWVcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwicnVudGltZVwiLCBcInJlc2VhcmNoLWRlY2lzaW9uLmpzb25cIiksXG4gICAgSlNPTi5zdHJpbmdpZnkoeyBkZWNpc2lvbjogXCJyZXNlYXJjaFwiLCBzb3VyY2U6IFwicmVzZWFyY2gtZGVjaXNpb25cIiwgZGVjaWRlZF9hdDogXCIyMDI2LTA0LTI3VDAwOjAwOjAwWlwiIH0pLFxuICApO1xuXG4gIGNvbnN0IHByZWZzID0geyBwbGFubmluZ19kZXB0aDogXCJkZWVwXCIgfSBhcyBHU0RQcmVmZXJlbmNlcztcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVsZShSRVNFQVJDSF9QUk9KRUNUX1JVTEVfTkFNRSkubWF0Y2gobWFrZUN0eChiYXNlLCBwcmVmcykpO1xuXG4gIGFzc2VydC5vayhyZXN1bHQgJiYgcmVzdWx0LmFjdGlvbiA9PT0gXCJkaXNwYXRjaFwiLCBcImV4cGxpY2l0IHVzZXItc291cmNlZCByZXNlYXJjaCBzaG91bGQgc3RpbGwgcnVuXCIpO1xuICBhc3NlcnQuZXF1YWwoZXhpc3RzU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcInJ1bnRpbWVcIiwgXCJyZXNlYXJjaC1wcm9qZWN0LWluZmxpZ2h0XCIpKSwgdHJ1ZSk7XG59KTtcblxudGVzdChcIkRlZXAgbW9kZTogcmVzZWFyY2gtcHJvamVjdCBkb2VzIG5vdCBkaXNwYXRjaCBub24tdHJpdmlhbCB3b3JrZmxvdy1kZWZhdWx0ZWQgcmVzZWFyY2hcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VJc29sYXRlZEJhc2VXaXRoQ2xlYW51cCh0KTtcblxuICB3cml0ZUNhcHR1cmVkRGVlcFByZWZzKGJhc2UpO1xuICB3cml0ZVZhbGlkUHJvamVjdChiYXNlKTtcbiAgd3JpdGVWYWxpZFJlcXVpcmVtZW50cyhiYXNlKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwicnVudGltZVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihiYXNlLCBcIi5nc2RcIiwgXCJydW50aW1lXCIsIFwicmVzZWFyY2gtZGVjaXNpb24uanNvblwiKSxcbiAgICBKU09OLnN0cmluZ2lmeSh7XG4gICAgICBkZWNpc2lvbjogXCJyZXNlYXJjaFwiLFxuICAgICAgZGVjaWRlZF9hdDogXCIyMDI2LTA0LTI3VDAwOjAwOjAwWlwiLFxuICAgICAgc291cmNlOiBcIndvcmtmbG93LXByZWZlcmVuY2VzXCIsXG4gICAgfSksXG4gICk7XG5cbiAgY29uc3QgcHJlZnMgPSB7IHBsYW5uaW5nX2RlcHRoOiBcImRlZXBcIiB9IGFzIEdTRFByZWZlcmVuY2VzO1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBydWxlKFJFU0VBUkNIX1BST0pFQ1RfUlVMRV9OQU1FKS5tYXRjaChtYWtlQ3R4KGJhc2UsIHByZWZzKSk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgbnVsbCk7XG4gIGFzc2VydC5lcXVhbChleGlzdHNTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwicnVudGltZVwiLCBcInJlc2VhcmNoLXByb2plY3QtaW5mbGlnaHRcIikpLCBmYWxzZSk7XG4gIGNvbnN0IGRlY2lzaW9uID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJydW50aW1lXCIsIFwicmVzZWFyY2gtZGVjaXNpb24uanNvblwiKSwgXCJ1dGYtOFwiKSk7XG4gIGFzc2VydC5lcXVhbChkZWNpc2lvbi5kZWNpc2lvbiwgXCJza2lwXCIpO1xuICBhc3NlcnQuZXF1YWwoZGVjaXNpb24ucmVhc29uLCBcImxlZ2FjeS13b3JrZmxvdy1yZXNlYXJjaC1kZWZhdWx0XCIpO1xufSk7XG5cbnRlc3QoXCJEZWVwIG1vZGU6IHJlc2VhcmNoLXByb2plY3QgY2xlYXJzIGluLWZsaWdodCBtYXJrZXIgd2hlbiBwcm9tcHQgYXNzZW1ibHkgZmFpbHNcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VJc29sYXRlZEJhc2VXaXRoQ2xlYW51cCh0KTtcblxuICBjb25zdCByZXN0b3JlUHJvbXB0QnVpbGRlciA9IHNldFJlc2VhcmNoUHJvamVjdFByb21wdEJ1aWxkZXJGb3JUZXN0KGFzeW5jICgpID0+IHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJwcm9tcHQgYXNzZW1ibHkgZmFpbGVkXCIpO1xuICB9KTtcbiAgdC5hZnRlcihyZXN0b3JlUHJvbXB0QnVpbGRlcik7XG5cbiAgc2V0dXBSZWFkeUZvclJlc2VhcmNoUHJvamVjdChiYXNlKTtcbiAgY29uc3QgcHJlZnMgPSB7IHBsYW5uaW5nX2RlcHRoOiBcImRlZXBcIiB9IGFzIEdTRFByZWZlcmVuY2VzO1xuICBjb25zdCBtYXJrZXJQYXRoID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJydW50aW1lXCIsIFwicmVzZWFyY2gtcHJvamVjdC1pbmZsaWdodFwiKTtcblxuICBhd2FpdCBhc3NlcnQucmVqZWN0cyhcbiAgICAoKSA9PiBydWxlKFJFU0VBUkNIX1BST0pFQ1RfUlVMRV9OQU1FKS5tYXRjaChtYWtlQ3R4KGJhc2UsIHByZWZzKSksXG4gICAgL3Byb21wdCBhc3NlbWJseSBmYWlsZWQvLFxuICApO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwoZXhpc3RzU3luYyhtYXJrZXJQYXRoKSwgZmFsc2UsIFwiZmFpbGVkIHByb21wdCBhc3NlbWJseSBtdXN0IG5vdCBzdHJhbmQgdGhlIGluLWZsaWdodCBtYXJrZXJcIik7XG59KTtcblxudGVzdChcIkRlZXAgbW9kZTogcmVzZWFyY2gtcHJvamVjdCBzdG9wcyB3aGlsZSBpbi1mbGlnaHQgbWFya2VyIGV4aXN0c1wiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUlzb2xhdGVkQmFzZVdpdGhDbGVhbnVwKHQpO1xuXG4gIHNldHVwUmVhZHlGb3JSZXNlYXJjaFByb2plY3QoYmFzZSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJydW50aW1lXCIsIFwicmVzZWFyY2gtcHJvamVjdC1pbmZsaWdodFwiKSwgXCJ7fVxcblwiKTtcbiAgY29uc3QgcHJlZnMgPSB7IHBsYW5uaW5nX2RlcHRoOiBcImRlZXBcIiB9IGFzIEdTRFByZWZlcmVuY2VzO1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBydWxlKFJFU0VBUkNIX1BST0pFQ1RfUlVMRV9OQU1FKS5tYXRjaChtYWtlQ3R4KGJhc2UsIHByZWZzKSk7XG4gIGFzc2VydC5vayhyZXN1bHQgIT09IG51bGwsIFwiaW4tZmxpZ2h0IG1hcmtlciBtdXN0IHByb2R1Y2UgYSByZXN1bHRcIik7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQ/LmFjdGlvbiwgXCJzdG9wXCIsIFwiaW4tZmxpZ2h0IG1hcmtlciBtdXN0IGJsb2NrIGRpc3BhdGNoIHdpdGggYSBzdG9wIGFjdGlvblwiKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKChyZXN1bHQgYXMgeyBhY3Rpb246IHN0cmluZzsgbGV2ZWw6IHN0cmluZyB9KS5sZXZlbCwgXCJpbmZvXCIsIFwiaW4tZmxpZ2h0IHN0b3AgbXVzdCB1c2UgaW5mbyBsZXZlbFwiKTtcbiAgaWYgKHJlc3VsdD8uYWN0aW9uID09PSBcInN0b3BcIikge1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQucmVhc29uLCAvcmVzZWFyY2gtcHJvamVjdC1pbmZsaWdodC8pO1xuICB9XG59KTtcblxudGVzdChcIkRlZXAgbW9kZTogcmVzZWFyY2gtcHJvamVjdCBkb2VzIE5PVCBkaXNwYXRjaCB3aGVuIGFsbCA0IHJlc2VhcmNoIGZpbGVzIGV4aXN0XCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlSXNvbGF0ZWRCYXNlV2l0aENsZWFudXAodCk7XG5cbiAgc2V0dXBSZWFkeUZvclJlc2VhcmNoUHJvamVjdChiYXNlKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwicmVzZWFyY2hcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBmb3IgKGNvbnN0IG5hbWUgb2YgW1wiU1RBQ0subWRcIiwgXCJGRUFUVVJFUy5tZFwiLCBcIkFSQ0hJVEVDVFVSRS5tZFwiLCBcIlBJVEZBTExTLm1kXCJdKSB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcInJlc2VhcmNoXCIsIG5hbWUpLCBcIiMgZG9uZVxcblwiKTtcbiAgfVxuICBjb25zdCBwcmVmcyA9IHsgcGxhbm5pbmdfZGVwdGg6IFwiZGVlcFwiIH0gYXMgR1NEUHJlZmVyZW5jZXM7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bGUoUkVTRUFSQ0hfUFJPSkVDVF9SVUxFX05BTUUpLm1hdGNoKG1ha2VDdHgoYmFzZSwgcHJlZnMpKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdCwgbnVsbCwgXCJhbGwgcmVzZWFyY2ggZmlsZXMgcHJlc2VudCBcdTIwMTQgZmFsbCB0aHJvdWdoXCIpO1xufSk7XG5cbnRlc3QoXCJEZWVwIG1vZGU6IHJlc2VhcmNoLXByb2plY3QgdHJlYXRzIGEgZGltZW5zaW9uIEJMT0NLRVIgYXMgdGVybWluYWxcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VJc29sYXRlZEJhc2VXaXRoQ2xlYW51cCh0KTtcblxuICBzZXR1cFJlYWR5Rm9yUmVzZWFyY2hQcm9qZWN0KGJhc2UpO1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJyZXNlYXJjaFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGZvciAoY29uc3QgbmFtZSBvZiBbXCJTVEFDSy5tZFwiLCBcIkZFQVRVUkVTLm1kXCIsIFwiQVJDSElURUNUVVJFLm1kXCJdKSB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcInJlc2VhcmNoXCIsIG5hbWUpLCBcIiMgZG9uZVxcblwiKTtcbiAgfVxuICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwicmVzZWFyY2hcIiwgXCJQSVRGQUxMUy1CTE9DS0VSLm1kXCIpLCBcIiMgYmxvY2tlclxcblwiKTtcblxuICBjb25zdCBwcmVmcyA9IHsgcGxhbm5pbmdfZGVwdGg6IFwiZGVlcFwiIH0gYXMgR1NEUHJlZmVyZW5jZXM7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bGUoUkVTRUFSQ0hfUFJPSkVDVF9SVUxFX05BTUUpLm1hdGNoKG1ha2VDdHgoYmFzZSwgcHJlZnMpKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdCwgbnVsbCwgXCJkaW1lbnNpb24gYmxvY2tlciBmaWxlcyBtdXN0IHNhdGlzZnkgcHJvamVjdCByZXNlYXJjaFwiKTtcbn0pO1xuXG50ZXN0KFwiRGVlcCBtb2RlOiByZXNlYXJjaC1wcm9qZWN0IHN0b3BzIHdoZW4gZXZlcnkgZGltZW5zaW9uIGlzIG9ubHkgYSBCTE9DS0VSXCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlSXNvbGF0ZWRCYXNlV2l0aENsZWFudXAodCk7XG5cbiAgc2V0dXBSZWFkeUZvclJlc2VhcmNoUHJvamVjdChiYXNlKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwicmVzZWFyY2hcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBmb3IgKGNvbnN0IG5hbWUgb2YgW1wiU1RBQ0tcIiwgXCJGRUFUVVJFU1wiLCBcIkFSQ0hJVEVDVFVSRVwiLCBcIlBJVEZBTExTXCJdKSB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcInJlc2VhcmNoXCIsIGAke25hbWV9LUJMT0NLRVIubWRgKSwgXCIjIGJsb2NrZWRcXG5cIik7XG4gIH1cblxuICBjb25zdCBwcmVmcyA9IHsgcGxhbm5pbmdfZGVwdGg6IFwiZGVlcFwiIH0gYXMgR1NEUHJlZmVyZW5jZXM7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bGUoUkVTRUFSQ0hfUFJPSkVDVF9SVUxFX05BTUUpLm1hdGNoKG1ha2VDdHgoYmFzZSwgcHJlZnMpKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdD8uYWN0aW9uLCBcInN0b3BcIik7XG4gIGFzc2VydC5tYXRjaChyZXN1bHQ/LmFjdGlvbiA9PT0gXCJzdG9wXCIgPyByZXN1bHQucmVhc29uIDogXCJcIiwgL29ubHkgZGltZW5zaW9uIGJsb2NrZXIgZmlsZXMvKTtcbn0pO1xuXG50ZXN0KFwiRGVlcCBtb2RlOiByZXNlYXJjaC1wcm9qZWN0IHN0b3BzIG9uIGdsb2JhbCBQUk9KRUNULVJFU0VBUkNILUJMT0NLRVJcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VJc29sYXRlZEJhc2VXaXRoQ2xlYW51cCh0KTtcblxuICBzZXR1cFJlYWR5Rm9yUmVzZWFyY2hQcm9qZWN0KGJhc2UpO1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJyZXNlYXJjaFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJyZXNlYXJjaFwiLCBcIlBST0pFQ1QtUkVTRUFSQ0gtQkxPQ0tFUi5tZFwiKSwgXCIjIGJsb2NrZWRcXG5cIik7XG5cbiAgY29uc3QgcHJlZnMgPSB7IHBsYW5uaW5nX2RlcHRoOiBcImRlZXBcIiB9IGFzIEdTRFByZWZlcmVuY2VzO1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBydWxlKFJFU0VBUkNIX1BST0pFQ1RfUlVMRV9OQU1FKS5tYXRjaChtYWtlQ3R4KGJhc2UsIHByZWZzKSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQ/LmFjdGlvbiwgXCJzdG9wXCIpO1xuICBhc3NlcnQubWF0Y2gocmVzdWx0Py5hY3Rpb24gPT09IFwic3RvcFwiID8gcmVzdWx0LnJlYXNvbiA6IFwiXCIsIC9QUk9KRUNULVJFU0VBUkNILUJMT0NLRVIvKTtcbn0pO1xuXG50ZXN0KFwiRGVlcCBtb2RlOiByZXNlYXJjaC1wcm9qZWN0IERPRVMgZGlzcGF0Y2ggd2hlbiBvbmx5IDMgb2YgNCByZXNlYXJjaCBmaWxlcyBleGlzdFwiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUlzb2xhdGVkQmFzZVdpdGhDbGVhbnVwKHQpO1xuXG4gIHNldHVwUmVhZHlGb3JSZXNlYXJjaFByb2plY3QoYmFzZSk7XG4gIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcInJlc2VhcmNoXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIFtcIlNUQUNLLm1kXCIsIFwiRkVBVFVSRVMubWRcIiwgXCJBUkNISVRFQ1RVUkUubWRcIl0pIHtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwicmVzZWFyY2hcIiwgbmFtZSksIFwiIyBkb25lXFxuXCIpO1xuICB9XG4gIC8vIFBJVEZBTExTLm1kIG1pc3NpbmdcbiAgY29uc3QgcHJlZnMgPSB7IHBsYW5uaW5nX2RlcHRoOiBcImRlZXBcIiB9IGFzIEdTRFByZWZlcmVuY2VzO1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBydWxlKFJFU0VBUkNIX1BST0pFQ1RfUlVMRV9OQU1FKS5tYXRjaChtYWtlQ3R4KGJhc2UsIHByZWZzKSk7XG4gIGFzc2VydC5vayhyZXN1bHQgJiYgcmVzdWx0LmFjdGlvbiA9PT0gXCJkaXNwYXRjaFwiLCBcImFueSBtaXNzaW5nIGRpbWVuc2lvbiBtdXN0IHRyaWdnZXIgcmUtcnVuXCIpO1xufSk7XG5cbnRlc3QoXCJEZWVwIG1vZGU6IHF1ZXVlZCBtaWxlc3RvbmUgd2l0aG91dCBDT05URVhULm1kIHJvdXRlcyB0byBtaWxlc3RvbmUgcmVzZWFyY2ggYWZ0ZXIgcHJvamVjdCBzZXR1cFwiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUlzb2xhdGVkQmFzZVdpdGhDbGVhbnVwKHQpO1xuXG4gIHdyaXRlQ2FwdHVyZWREZWVwUHJlZnMoYmFzZSk7XG4gIHdyaXRlVmFsaWRQcm9qZWN0KGJhc2UpO1xuICB3cml0ZVZhbGlkUmVxdWlyZW1lbnRzKGJhc2UpO1xuICB3cml0ZVNraXBwZWRQcm9qZWN0UmVzZWFyY2hEZWNpc2lvbihiYXNlKTtcblxuICBjb25zdCBwcmVmcyA9IHsgcGxhbm5pbmdfZGVwdGg6IFwiZGVlcFwiIH0gYXMgR1NEUHJlZmVyZW5jZXM7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlc29sdmVEaXNwYXRjaChtYWtlQ3R4KGJhc2UsIHByZWZzKSk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5hY3Rpb24sIFwiZGlzcGF0Y2hcIik7XG4gIGlmIChyZXN1bHQuYWN0aW9uID09PSBcImRpc3BhdGNoXCIpIHtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnVuaXRUeXBlLCBcInJlc2VhcmNoLW1pbGVzdG9uZVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnVuaXRJZCwgXCJNMDAxXCIpO1xuICB9XG59KTtcblxudGVzdChcIkRlZXAgbW9kZTogcXVldWVkIG1pbGVzdG9uZSB3aXRob3V0IENPTlRFWFQubWQgY2FuIHJvdXRlIGRpcmVjdGx5IHRvIG1pbGVzdG9uZSBwbGFubmluZ1wiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUlzb2xhdGVkQmFzZVdpdGhDbGVhbnVwKHQpO1xuXG4gIHdyaXRlQ2FwdHVyZWREZWVwUHJlZnMoYmFzZSk7XG4gIHdyaXRlVmFsaWRQcm9qZWN0KGJhc2UpO1xuICB3cml0ZVZhbGlkUmVxdWlyZW1lbnRzKGJhc2UpO1xuICB3cml0ZVNraXBwZWRQcm9qZWN0UmVzZWFyY2hEZWNpc2lvbihiYXNlKTtcblxuICBjb25zdCBwcmVmcyA9IHsgcGxhbm5pbmdfZGVwdGg6IFwiZGVlcFwiLCBwaGFzZXM6IHsgc2tpcF9yZXNlYXJjaDogdHJ1ZSB9IH0gYXMgR1NEUHJlZmVyZW5jZXM7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlc29sdmVEaXNwYXRjaChtYWtlQ3R4KGJhc2UsIHByZWZzKSk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5hY3Rpb24sIFwiZGlzcGF0Y2hcIik7XG4gIGlmIChyZXN1bHQuYWN0aW9uID09PSBcImRpc3BhdGNoXCIpIHtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnVuaXRUeXBlLCBcInBsYW4tbWlsZXN0b25lXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQudW5pdElkLCBcIk0wMDFcIik7XG4gIH1cbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgY2VudHJhbGl6ZWQgZGVlcC1zdGFnZSBnYXRlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiRGVlcCBtb2RlIGdhdGUgcmVwb3J0cyB0aGUgZWFybGllc3QgbWlzc2luZyBzZWN0aW9uXCIsICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlSXNvbGF0ZWRCYXNlV2l0aENsZWFudXAodCk7XG4gIGNvbnN0IHByZWZzID0geyBwbGFubmluZ19kZXB0aDogXCJkZWVwXCIgfSBhcyBHU0RQcmVmZXJlbmNlcztcblxuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJyZXNlYXJjaFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGZvciAoY29uc3QgbmFtZSBvZiBbXCJTVEFDSy5tZFwiLCBcIkZFQVRVUkVTLm1kXCIsIFwiQVJDSElURUNUVVJFLm1kXCIsIFwiUElURkFMTFMubWRcIl0pIHtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwicmVzZWFyY2hcIiwgbmFtZSksIFwiIyBkb25lXFxuXCIpO1xuICB9XG5cbiAgY29uc3QgZ2F0ZSA9IGdldERlZXBTdGFnZUdhdGUocHJlZnMsIGJhc2UpO1xuICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgIHsgc3RhdHVzOiBnYXRlLnN0YXR1cywgc3RhZ2U6IGdhdGUuc3RhZ2UgfSxcbiAgICB7IHN0YXR1czogXCJwZW5kaW5nXCIsIHN0YWdlOiBcIndvcmtmbG93LXByZWZlcmVuY2VzXCIgfSxcbiAgICBcImxhdGVyIGFydGlmYWN0cyBtdXN0IG5vdCBsZXQgdGhlIHdvcmtmbG93IHNraXAgdGhlIGZpcnN0IHBlbmRpbmcgZGVlcCBzZWN0aW9uXCIsXG4gICk7XG4gIGFzc2VydC5lcXVhbChoYXNQZW5kaW5nRGVlcFN0YWdlKHByZWZzLCBiYXNlKSwgdHJ1ZSk7XG59KTtcblxudGVzdChcIkRlZXAgbW9kZSBnYXRlIGJsb2NrcyBibG9ja2VyLW9ubHkgcHJvamVjdCByZXNlYXJjaFwiLCAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUlzb2xhdGVkQmFzZVdpdGhDbGVhbnVwKHQpO1xuICBjb25zdCBwcmVmcyA9IHsgcGxhbm5pbmdfZGVwdGg6IFwiZGVlcFwiIH0gYXMgR1NEUHJlZmVyZW5jZXM7XG5cbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIlBSRUZFUkVOQ0VTLm1kXCIpLFxuICAgIFwiLS0tXFxucGxhbm5pbmdfZGVwdGg6IGRlZXBcXG53b3JrZmxvd19wcmVmc19jYXB0dXJlZDogdHJ1ZVxcbi0tLVxcblwiLFxuICApO1xuICBzZXR1cFJlYWR5Rm9yUmVzZWFyY2hQcm9qZWN0KGJhc2UpO1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJyZXNlYXJjaFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGZvciAoY29uc3QgbmFtZSBvZiBbXCJTVEFDS1wiLCBcIkZFQVRVUkVTXCIsIFwiQVJDSElURUNUVVJFXCIsIFwiUElURkFMTFNcIl0pIHtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwicmVzZWFyY2hcIiwgYCR7bmFtZX0tQkxPQ0tFUi5tZGApLCBcIiMgYmxvY2tlZFxcblwiKTtcbiAgfVxuXG4gIGNvbnN0IGdhdGUgPSBnZXREZWVwU3RhZ2VHYXRlKHByZWZzLCBiYXNlKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICB7IHN0YXR1czogZ2F0ZS5zdGF0dXMsIHN0YWdlOiBnYXRlLnN0YWdlIH0sXG4gICAgeyBzdGF0dXM6IFwiYmxvY2tlZFwiLCBzdGFnZTogXCJwcm9qZWN0LXJlc2VhcmNoXCIgfSxcbiAgKTtcbiAgYXNzZXJ0LmVxdWFsKGhhc1BlbmRpbmdEZWVwU3RhZ2UocHJlZnMsIGJhc2UpLCB0cnVlKTtcbn0pO1xuXG50ZXN0KFwiRGVlcCBtb2RlIGdhdGUgcGFzc2VzIG9ubHkgYWZ0ZXIgdmVyaWZpZWQgcHJvamVjdCByZXNlYXJjaCBvciBleHBsaWNpdCBza2lwXCIsICh0KSA9PiB7XG4gIGNvbnN0IHJlc2VhcmNoQmFzZSA9IG1ha2VJc29sYXRlZEJhc2VXaXRoQ2xlYW51cCh0KTtcbiAgY29uc3QgcHJlZnMgPSB7IHBsYW5uaW5nX2RlcHRoOiBcImRlZXBcIiB9IGFzIEdTRFByZWZlcmVuY2VzO1xuXG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihyZXNlYXJjaEJhc2UsIFwiLmdzZFwiLCBcIlBSRUZFUkVOQ0VTLm1kXCIpLFxuICAgIFwiLS0tXFxucGxhbm5pbmdfZGVwdGg6IGRlZXBcXG53b3JrZmxvd19wcmVmc19jYXB0dXJlZDogdHJ1ZVxcbi0tLVxcblwiLFxuICApO1xuICBzZXR1cFJlYWR5Rm9yUmVzZWFyY2hQcm9qZWN0KHJlc2VhcmNoQmFzZSk7XG4gIG1rZGlyU3luYyhqb2luKHJlc2VhcmNoQmFzZSwgXCIuZ3NkXCIsIFwicmVzZWFyY2hcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBmb3IgKGNvbnN0IG5hbWUgb2YgW1wiU1RBQ0subWRcIiwgXCJGRUFUVVJFUy5tZFwiLCBcIkFSQ0hJVEVDVFVSRS5tZFwiLCBcIlBJVEZBTExTLm1kXCJdKSB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHJlc2VhcmNoQmFzZSwgXCIuZ3NkXCIsIFwicmVzZWFyY2hcIiwgbmFtZSksIFwiIyBkb25lXFxuXCIpO1xuICB9XG4gIGFzc2VydC5lcXVhbChnZXREZWVwU3RhZ2VHYXRlKHByZWZzLCByZXNlYXJjaEJhc2UpLnN0YXR1cywgXCJjb21wbGV0ZVwiKTtcblxuICBjb25zdCBza2lwQmFzZSA9IG1ha2VJc29sYXRlZEJhc2VXaXRoQ2xlYW51cCh0KTtcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKHNraXBCYXNlLCBcIi5nc2RcIiwgXCJQUkVGRVJFTkNFUy5tZFwiKSxcbiAgICBcIi0tLVxcbnBsYW5uaW5nX2RlcHRoOiBkZWVwXFxud29ya2Zsb3dfcHJlZnNfY2FwdHVyZWQ6IHRydWVcXG4tLS1cXG5cIixcbiAgKTtcbiAgd3JpdGVWYWxpZFByb2plY3Qoc2tpcEJhc2UpO1xuICB3cml0ZVZhbGlkUmVxdWlyZW1lbnRzKHNraXBCYXNlKTtcbiAgbWtkaXJTeW5jKGpvaW4oc2tpcEJhc2UsIFwiLmdzZFwiLCBcInJ1bnRpbWVcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oc2tpcEJhc2UsIFwiLmdzZFwiLCBcInJ1bnRpbWVcIiwgXCJyZXNlYXJjaC1kZWNpc2lvbi5qc29uXCIpLCBKU09OLnN0cmluZ2lmeSh7IGRlY2lzaW9uOiBcInNraXBcIiB9KSk7XG5cbiAgYXNzZXJ0LmVxdWFsKGdldERlZXBTdGFnZUdhdGUocHJlZnMsIHNraXBCYXNlKS5zdGF0dXMsIFwiY29tcGxldGVcIik7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIG9yZGVyaW5nIGludmFyaWFudCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcIkRlZXAgbW9kZTogZGVlcC1tb2RlIHJ1bGVzIHJlZ2lzdGVyZWQgaW4gY29ycmVjdCBvcmRlclwiLCAoKSA9PiB7XG4gIGNvbnN0IHdvcmtmbG93SWR4ID0gRElTUEFUQ0hfUlVMRVMuZmluZEluZGV4KHIgPT4gci5uYW1lID09PSBXT1JLRkxPV19QUkVGU19SVUxFX05BTUUpO1xuICBjb25zdCBwcm9qZWN0SWR4ID0gRElTUEFUQ0hfUlVMRVMuZmluZEluZGV4KHIgPT4gci5uYW1lID09PSBQUk9KRUNUX1JVTEVfTkFNRSk7XG4gIGNvbnN0IHJlcXVpcmVtZW50c0lkeCA9IERJU1BBVENIX1JVTEVTLmZpbmRJbmRleChyID0+IHIubmFtZSA9PT0gUkVRVUlSRU1FTlRTX1JVTEVfTkFNRSk7XG4gIGNvbnN0IHJlc2VhcmNoRGVjaXNpb25JZHggPSBESVNQQVRDSF9SVUxFUy5maW5kSW5kZXgociA9PiByLm5hbWUgPT09IFJFU0VBUkNIX0RFQ0lTSU9OX1JVTEVfTkFNRSk7XG4gIGNvbnN0IHJlc2VhcmNoUHJvamVjdElkeCA9IERJU1BBVENIX1JVTEVTLmZpbmRJbmRleChyID0+IHIubmFtZSA9PT0gUkVTRUFSQ0hfUFJPSkVDVF9SVUxFX05BTUUpO1xuICBjb25zdCBtaWxlc3RvbmVJZHggPSBESVNQQVRDSF9SVUxFUy5maW5kSW5kZXgociA9PiByLm5hbWUgPT09IFwicHJlLXBsYW5uaW5nIChubyBjb250ZXh0KSBcdTIxOTIgZGlzY3Vzcy1taWxlc3RvbmVcIik7XG5cbiAgYXNzZXJ0Lm9rKHdvcmtmbG93SWR4ID49IDAsIFwid29ya2Zsb3ctcHJlZmVyZW5jZXMgcnVsZSBtdXN0IGJlIHJlZ2lzdGVyZWRcIik7XG4gIGFzc2VydC5vayhwcm9qZWN0SWR4ID49IDAsIFwicHJvamVjdCBydWxlIG11c3QgYmUgcmVnaXN0ZXJlZFwiKTtcbiAgYXNzZXJ0Lm9rKHJlcXVpcmVtZW50c0lkeCA+PSAwLCBcInJlcXVpcmVtZW50cyBydWxlIG11c3QgYmUgcmVnaXN0ZXJlZFwiKTtcbiAgYXNzZXJ0Lm9rKHJlc2VhcmNoRGVjaXNpb25JZHggPj0gMCwgXCJyZXNlYXJjaC1kZWNpc2lvbiBydWxlIG11c3QgYmUgcmVnaXN0ZXJlZFwiKTtcbiAgYXNzZXJ0Lm9rKHJlc2VhcmNoUHJvamVjdElkeCA+PSAwLCBcInJlc2VhcmNoLXByb2plY3QgcnVsZSBtdXN0IGJlIHJlZ2lzdGVyZWRcIik7XG4gIGFzc2VydC5vayhtaWxlc3RvbmVJZHggPj0gMCwgXCJtaWxlc3RvbmUgcnVsZSBtdXN0IGJlIHJlZ2lzdGVyZWRcIik7XG5cbiAgLy8gT3JkZXI6IHdvcmtmbG93LXByZWZzIFx1MjE5MiBkaXNjdXNzLXByb2plY3QgXHUyMTkyIGRpc2N1c3MtcmVxdWlyZW1lbnRzIFx1MjE5MiByZXNlYXJjaC1kZWNpc2lvbiBcdTIxOTIgcmVzZWFyY2gtcHJvamVjdCBcdTIxOTIgZGlzY3Vzcy1taWxlc3RvbmVcbiAgYXNzZXJ0Lm9rKHdvcmtmbG93SWR4IDwgcHJvamVjdElkeCwgXCJ3b3JrZmxvdy1wcmVmcyBtdXN0IGZpcmUgYmVmb3JlIGRpc2N1c3MtcHJvamVjdFwiKTtcbiAgYXNzZXJ0Lm9rKHByb2plY3RJZHggPCByZXF1aXJlbWVudHNJZHgsIFwiZGlzY3Vzcy1wcm9qZWN0IG11c3QgZmlyZSBiZWZvcmUgZGlzY3Vzcy1yZXF1aXJlbWVudHNcIik7XG4gIGFzc2VydC5vayhyZXF1aXJlbWVudHNJZHggPCByZXNlYXJjaERlY2lzaW9uSWR4LCBcImRpc2N1c3MtcmVxdWlyZW1lbnRzIG11c3QgZmlyZSBiZWZvcmUgcmVzZWFyY2gtZGVjaXNpb25cIik7XG4gIGFzc2VydC5vayhyZXNlYXJjaERlY2lzaW9uSWR4IDwgcmVzZWFyY2hQcm9qZWN0SWR4LCBcInJlc2VhcmNoLWRlY2lzaW9uIG11c3QgZmlyZSBiZWZvcmUgcmVzZWFyY2gtcHJvamVjdCAoZ2F0ZSBiZWZvcmUgYWN0aW9uKVwiKTtcbiAgYXNzZXJ0Lm9rKHJlc2VhcmNoUHJvamVjdElkeCA8IG1pbGVzdG9uZUlkeCwgXCJyZXNlYXJjaC1wcm9qZWN0IG11c3QgZmlyZSBiZWZvcmUgZGlzY3Vzcy1taWxlc3RvbmVcIik7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUlBLE9BQU8sVUFBVTtBQUVqQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxZQUFZLFdBQVcsY0FBYyxRQUFRLHFCQUFxQjtBQUMzRSxTQUFTLGNBQWM7QUFDdkIsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsa0JBQWtCO0FBRTNCO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUVLO0FBSVAsTUFBTSwyQkFBMkI7QUFDakMsTUFBTSxvQkFBb0I7QUFDMUIsTUFBTSx5QkFBeUI7QUFDL0IsTUFBTSw4QkFBOEI7QUFDcEMsTUFBTSw2QkFBNkI7QUFFbkMsTUFBTSxtQkFBbUI7QUFBQSxFQUN2QjtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFDRixFQUFFLEtBQUssSUFBSTtBQUVYLE1BQU0sd0JBQXdCO0FBQUEsRUFDNUI7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFDRixFQUFFLEtBQUssSUFBSTtBQUVYLE1BQU0sdUJBQXVCO0FBQUEsRUFDM0I7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQ0YsRUFBRSxLQUFLLElBQUk7QUFFWCxNQUFNLDRCQUE0QjtBQUFBLEVBQ2hDO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQ0YsRUFBRSxLQUFLLElB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
