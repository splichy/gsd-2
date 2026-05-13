import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseSummary } from "../files.js";
import { deriveState } from "../state.js";
process.env.GSD_ALLOW_MARKDOWN_DERIVE_FALLBACK = "1";
const __dirname = dirname(fileURLToPath(import.meta.url));
const worktreePromptsDir = join(__dirname, "..", "prompts");
function loadPromptFromWorktree(name, vars = {}) {
  const path = join(worktreePromptsDir, `${name}.md`);
  let content = readFileSync(path, "utf-8");
  for (const [key, value] of Object.entries(vars)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  return content.trim();
}
function createFixtureBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-replan-test-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}
function writeRoadmap(base, mid, content) {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-ROADMAP.md`), content);
}
function writePlan(base, mid, sid, content) {
  const dir = join(base, ".gsd", "milestones", mid, "slices", sid);
  mkdirSync(join(dir, "tasks"), { recursive: true });
  writeFileSync(join(dir, "tasks", "T01-PLAN.md"), "# T01 Plan\n");
  writeFileSync(join(dir, `${sid}-PLAN.md`), content);
}
function writeTaskSummary(base, mid, sid, tid, content) {
  const dir = join(base, ".gsd", "milestones", mid, "slices", sid, "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${tid}-SUMMARY.md`), content);
}
function writeReplanFile(base, mid, sid, content) {
  const dir = join(base, ".gsd", "milestones", mid, "slices", sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}-REPLAN.md`), content);
}
function writeReplanTrigger(base, mid, sid, content) {
  const dir = join(base, ".gsd", "milestones", mid, "slices", sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}-REPLAN-TRIGGER.md`), content);
}
const ROADMAP_ONE_SLICE = `# M001: Test Milestone

**Vision:** Test vision.

## Slices

- [ ] **S01: Test Slice** \`risk:low\` \`depends:[]\`
  > After this: stuff works
`;
function makePlanT01DoneT02Pending() {
  return `# S01: Test Slice

**Goal:** Do things.
**Demo:** It works.

## Tasks

- [x] **T01: First task** \`est:15m\`
  First task description.

- [ ] **T02: Second task** \`est:15m\`
  Second task description.
`;
}
function makePlanT01T02DoneT03Pending() {
  return `# S01: Test Slice

**Goal:** Do things.
**Demo:** It works.

## Tasks

- [x] **T01: First task** \`est:15m\`
  First task description.

- [x] **T02: Second task** \`est:15m\`
  Second task description.

- [ ] **T03: Third task** \`est:15m\`
  Third task description.
`;
}
function makeTaskSummary(tid, blockerDiscovered) {
  return `---
id: ${tid}
parent: S01
milestone: M001
provides: []
key_files: []
key_decisions: []
patterns_established: []
observability_surfaces: []
duration: 15min
verification_result: passed
completed_at: 2025-03-10T12:00:00Z
blocker_discovered: ${blockerDiscovered}
---

# ${tid}: Test Task

**Did something.**

## What Happened

Work was done.
`;
}
console.log("\n=== parseSummary: blocker_discovered true (string) ===");
{
  const content = `---
id: T01
parent: S03
milestone: M002
blocker_discovered: true
completed_at: 2025-03-10T12:00:00Z
---

# T01: Test Task

**One-liner.**

## What Happened

Found a blocker.
`;
  const s = parseSummary(content);
  assert.deepStrictEqual(s.frontmatter.blocker_discovered, true, "blocker_discovered: true (string) extracts as true");
}
console.log("\n=== parseSummary: blocker_discovered false (string) ===");
{
  const content = `---
id: T02
parent: S03
milestone: M002
blocker_discovered: false
completed_at: 2025-03-10T12:00:00Z
---

# T02: Normal Task

**One-liner.**

## What Happened

No blocker.
`;
  const s = parseSummary(content);
  assert.deepStrictEqual(s.frontmatter.blocker_discovered, false, "blocker_discovered: false extracts as false");
}
console.log("\n=== parseSummary: blocker_discovered missing (defaults to false) ===");
{
  const content = `---
id: T03
parent: S03
milestone: M002
completed_at: 2025-03-10T12:00:00Z
---

# T03: No Blocker Field

**One-liner.**

## What Happened

No blocker field at all.
`;
  const s = parseSummary(content);
  assert.deepStrictEqual(s.frontmatter.blocker_discovered, false, "blocker_discovered missing defaults to false");
}
console.log("\n=== parseSummary: blocker_discovered true (boolean from YAML) ===");
{
  const content = `---
id: T04
parent: S03
milestone: M002
blocker_discovered: true
completed_at: 2025-03-10T12:00:00Z
---

# T04: Boolean True

**One-liner.**

## What Happened

Blocker as boolean.
`;
  const s = parseSummary(content);
  assert.deepStrictEqual(s.frontmatter.blocker_discovered, true, "blocker_discovered: true (YAML boolean) extracts as true");
}
console.log("\n=== parseSummary: blocker_discovered with full frontmatter ===");
{
  const content = `---
id: T05
parent: S03
milestone: M002
provides:
  - something
requires: []
affects: []
key_files:
  - files.ts
key_decisions: []
patterns_established: []
drill_down_paths: []
observability_surfaces: []
duration: 15min
verification_result: passed
completed_at: 2025-03-10T12:00:00Z
blocker_discovered: true
---

# T05: Full Frontmatter With Blocker

**Found an architectural mismatch.**

## What Happened

The API doesn't support what we assumed.

## Deviations

Major deviation from plan.

## Files Created/Modified

- \`files.ts\` \u2014 attempted changes
`;
  const s = parseSummary(content);
  assert.deepStrictEqual(s.frontmatter.blocker_discovered, true, "blocker_discovered true with full frontmatter");
  assert.deepStrictEqual(s.frontmatter.id, "T05", "other fields still parse correctly alongside blocker_discovered");
  assert.deepStrictEqual(s.frontmatter.duration, "15min", "duration still parsed");
  assert.deepStrictEqual(s.frontmatter.provides[0], "something", "provides still parsed");
}
console.log("\n=== deriveState: blocker found, no REPLAN \u2192 replanning-slice ===");
{
  const base = createFixtureBase();
  writeRoadmap(base, "M001", ROADMAP_ONE_SLICE);
  writePlan(base, "M001", "S01", makePlanT01DoneT02Pending());
  writeTaskSummary(base, "M001", "S01", "T01", makeTaskSummary("T01", true));
  const state = await deriveState(base);
  assert.deepStrictEqual(state.phase, "replanning-slice", "phase is replanning-slice when blocker found and no REPLAN.md");
  assert.ok(state.nextAction.includes("T01"), "nextAction mentions blocker task T01");
  assert.ok(state.nextAction.includes("blocker_discovered"), "nextAction mentions blocker_discovered");
  assert.deepStrictEqual(state.activeTask?.id, "T02", "activeTask is still T02 (the next incomplete task)");
  assert.ok(state.blockers.length > 0, "blockers array is non-empty");
  rmSync(base, { recursive: true, force: true });
}
console.log("\n=== deriveState: blocker found + REPLAN exists \u2192 executing (loop protection) ===");
{
  const base = createFixtureBase();
  writeRoadmap(base, "M001", ROADMAP_ONE_SLICE);
  writePlan(base, "M001", "S01", makePlanT01DoneT02Pending());
  writeTaskSummary(base, "M001", "S01", "T01", makeTaskSummary("T01", true));
  writeReplanFile(base, "M001", "S01", "# Replan\n\nAlready replanned.");
  const state = await deriveState(base);
  assert.deepStrictEqual(state.phase, "executing", "phase is executing when REPLAN.md exists (loop protection)");
  assert.deepStrictEqual(state.activeTask?.id, "T02", "activeTask is T02");
  rmSync(base, { recursive: true, force: true });
}
console.log("\n=== deriveState: no blocker in completed tasks \u2192 executing ===");
{
  const base = createFixtureBase();
  writeRoadmap(base, "M001", ROADMAP_ONE_SLICE);
  writePlan(base, "M001", "S01", makePlanT01DoneT02Pending());
  writeTaskSummary(base, "M001", "S01", "T01", makeTaskSummary("T01", false));
  const state = await deriveState(base);
  assert.deepStrictEqual(state.phase, "executing", "phase is executing when no blocker found");
  assert.deepStrictEqual(state.activeTask?.id, "T02", "activeTask is T02");
  rmSync(base, { recursive: true, force: true });
}
console.log("\n=== deriveState: multiple completed tasks, one blocker \u2192 replanning-slice ===");
{
  const base = createFixtureBase();
  writeRoadmap(base, "M001", ROADMAP_ONE_SLICE);
  writePlan(base, "M001", "S01", makePlanT01T02DoneT03Pending());
  writeTaskSummary(base, "M001", "S01", "T01", makeTaskSummary("T01", false));
  writeTaskSummary(base, "M001", "S01", "T02", makeTaskSummary("T02", true));
  const state = await deriveState(base);
  assert.deepStrictEqual(state.phase, "replanning-slice", "phase is replanning-slice when T02 has blocker");
  assert.ok(state.nextAction.includes("T02"), "nextAction mentions blocker task T02");
  assert.deepStrictEqual(state.activeTask?.id, "T03", "activeTask is T03 (next incomplete)");
  rmSync(base, { recursive: true, force: true });
}
console.log("\n=== deriveState: completed task with no summary file \u2192 executing ===");
{
  const base = createFixtureBase();
  writeRoadmap(base, "M001", ROADMAP_ONE_SLICE);
  writePlan(base, "M001", "S01", makePlanT01DoneT02Pending());
  const state = await deriveState(base);
  assert.deepStrictEqual(state.phase, "executing", "phase is executing when completed task has no summary");
  rmSync(base, { recursive: true, force: true });
}
console.log("\n=== prompt: replan-slice template loads and substitutes variables ===");
{
  const prompt = loadPromptFromWorktree("replan-slice", {
    workingDirectory: "/tmp/test-project",
    milestoneId: "M001",
    sliceId: "S01",
    sliceTitle: "Test Slice",
    slicePath: ".gsd/milestones/M001/slices/S01",
    planPath: ".gsd/milestones/M001/slices/S01/S01-PLAN.md",
    inlinedContext: "## Inlined Context\n\nTest context here."
  });
  assert.ok(prompt.includes("M001"), "prompt contains milestoneId");
  assert.ok(prompt.includes("S01"), "prompt contains sliceId");
  assert.ok(prompt.includes("Test Slice"), "prompt contains sliceTitle");
  assert.ok(prompt.includes(".gsd/milestones/M001/slices/S01/S01-PLAN.md"), "prompt contains planPath");
  assert.ok(prompt.includes("Test context here"), "prompt contains inlined context");
}
console.log("\n=== prompt: replan-slice contains preserve-completed-tasks instruction ===");
{
  const prompt = loadPromptFromWorktree("replan-slice", {
    workingDirectory: "/tmp/test-project",
    milestoneId: "M001",
    sliceId: "S01",
    sliceTitle: "Test Slice",
    slicePath: ".gsd/milestones/M001/slices/S01",
    planPath: ".gsd/milestones/M001/slices/S01/S01-PLAN.md",
    blockerTaskId: "T01",
    replanPath: ".gsd/milestones/M001/slices/S01/S01-REPLAN.md",
    inlinedContext: ""
  });
  assert.ok(prompt.includes("Do NOT renumber or remove completed tasks"), "prompt contains preserve-completed-tasks instruction");
  assert.ok(prompt.includes("[x]"), "prompt mentions [x] checkmarks");
  assert.ok(prompt.includes("REPLAN"), "prompt references replan output path");
  assert.ok(prompt.includes("blocker_discovered"), "prompt mentions blocker_discovered");
}
console.log("\n=== dispatch: diagnoseExpectedArtifact returns REPLAN.md path ===");
{
  const base = createFixtureBase();
  writeRoadmap(base, "M001", ROADMAP_ONE_SLICE);
  writePlan(base, "M001", "S01", makePlanT01DoneT02Pending());
  writeTaskSummary(base, "M001", "S01", "T01", makeTaskSummary("T01", true));
  const state = await deriveState(base);
  assert.deepStrictEqual(state.phase, "replanning-slice", "dispatch: state routes to replanning-slice when blocker found");
  assert.ok(state.activeSlice?.id === "S01", "dispatch: activeSlice is S01");
  rmSync(base, { recursive: true, force: true });
}
console.log("\n=== display: replan-slice prompt template has correct unit header ===");
{
  const prompt = loadPromptFromWorktree("replan-slice", {
    workingDirectory: "/tmp/test-project",
    milestoneId: "M001",
    sliceId: "S01",
    sliceTitle: "Test Slice",
    slicePath: ".gsd/milestones/M001/slices/S01",
    planPath: ".gsd/milestones/M001/slices/S01/S01-PLAN.md",
    blockerTaskId: "T01",
    inlinedContext: ""
  });
  assert.ok(prompt.includes("UNIT: Replan Slice"), "prompt has Replan Slice unit header");
  assert.ok(prompt.includes("Slice S01 replanned"), "prompt has completion message");
}
import { runGSDDoctor } from "../doctor.js";
console.log("\n=== doctor: blocker + no REPLAN.md \u2192 blocker_discovered_no_replan issue ===");
{
  const base = createFixtureBase();
  writeRoadmap(base, "M001", ROADMAP_ONE_SLICE);
  writePlan(base, "M001", "S01", makePlanT01DoneT02Pending());
  writeTaskSummary(base, "M001", "S01", "T01", makeTaskSummary("T01", true));
  const report = await runGSDDoctor(base, { fix: false, scope: "M001/S01" });
  const blockerIssues = report.issues.filter((i) => i.code === "blocker_discovered_no_replan");
  assert.ok(blockerIssues.length > 0, "doctor emits blocker_discovered_no_replan when blocker + no REPLAN");
  assert.ok(blockerIssues[0]?.message.includes("T01"), "issue message mentions the blocker task T01");
  assert.deepStrictEqual(blockerIssues[0]?.severity, "warning", "blocker_discovered_no_replan is warning severity");
  assert.deepStrictEqual(blockerIssues[0]?.scope, "slice", "blocker_discovered_no_replan has slice scope");
  rmSync(base, { recursive: true, force: true });
}
console.log("\n=== doctor: blocker + REPLAN.md exists \u2192 no blocker_discovered_no_replan issue ===");
{
  const base = createFixtureBase();
  writeRoadmap(base, "M001", ROADMAP_ONE_SLICE);
  writePlan(base, "M001", "S01", makePlanT01DoneT02Pending());
  writeTaskSummary(base, "M001", "S01", "T01", makeTaskSummary("T01", true));
  writeReplanFile(base, "M001", "S01", "# Replan\n\nAlready replanned.");
  const report = await runGSDDoctor(base, { fix: false, scope: "M001/S01" });
  const blockerIssues = report.issues.filter((i) => i.code === "blocker_discovered_no_replan");
  assert.deepStrictEqual(blockerIssues.length, 0, "no blocker_discovered_no_replan when REPLAN.md exists");
  rmSync(base, { recursive: true, force: true });
}
console.log("\n=== doctor: no blocker \u2192 no blocker_discovered_no_replan issue ===");
{
  const base = createFixtureBase();
  writeRoadmap(base, "M001", ROADMAP_ONE_SLICE);
  writePlan(base, "M001", "S01", makePlanT01DoneT02Pending());
  writeTaskSummary(base, "M001", "S01", "T01", makeTaskSummary("T01", false));
  const report = await runGSDDoctor(base, { fix: false, scope: "M001/S01" });
  const blockerIssues = report.issues.filter((i) => i.code === "blocker_discovered_no_replan");
  assert.deepStrictEqual(blockerIssues.length, 0, "no blocker_discovered_no_replan when no blocker");
  rmSync(base, { recursive: true, force: true });
}
import { resolveExpectedArtifactPath } from "../auto-artifact-paths.js";
import { verifyExpectedArtifact } from "../auto-recovery.js";
describe("replan-slice", () => {
  test("artifact: resolveExpectedArtifactPath returns REPLAN.md path for replan-slice", () => {
    const base = createFixtureBase();
    writeRoadmap(base, "M001", ROADMAP_ONE_SLICE);
    writePlan(base, "M001", "S01", makePlanT01DoneT02Pending());
    const path = resolveExpectedArtifactPath("replan-slice", "M001/S01", base);
    assert.ok(path !== null, "resolveExpectedArtifactPath returns non-null for replan-slice");
    assert.ok(path.endsWith("S01-REPLAN.md"), "path ends with S01-REPLAN.md");
    rmSync(base, { recursive: true, force: true });
  });
  test("artifact: verifyExpectedArtifact fails when REPLAN.md missing (#858)", () => {
    const base = createFixtureBase();
    writeRoadmap(base, "M001", ROADMAP_ONE_SLICE);
    writePlan(base, "M001", "S01", makePlanT01DoneT02Pending());
    const result = verifyExpectedArtifact("replan-slice", "M001/S01", base);
    assert.deepStrictEqual(result, false, "verifyExpectedArtifact returns false when REPLAN.md is missing");
    rmSync(base, { recursive: true, force: true });
  });
  test("artifact: verifyExpectedArtifact passes when REPLAN.md exists (#858)", () => {
    const base = createFixtureBase();
    writeRoadmap(base, "M001", ROADMAP_ONE_SLICE);
    writePlan(base, "M001", "S01", makePlanT01DoneT02Pending());
    writeReplanFile(base, "M001", "S01", "# Replan\n\nBlocker addressed.");
    const result = verifyExpectedArtifact("replan-slice", "M001/S01", base);
    assert.deepStrictEqual(result, true, "verifyExpectedArtifact returns true when REPLAN.md exists");
    rmSync(base, { recursive: true, force: true });
  });
  test("deriveState: REPLAN-TRIGGER.md exists, no REPLAN \u2192 replanning-slice (#1701)", async () => {
    const base = createFixtureBase();
    writeRoadmap(base, "M001", ROADMAP_ONE_SLICE);
    writePlan(base, "M001", "S01", makePlanT01DoneT02Pending());
    writeTaskSummary(base, "M001", "S01", "T01", makeTaskSummary("T01", false));
    writeReplanTrigger(base, "M001", "S01", "# Replan Trigger\n\n**Source:** Capture C001\n");
    const state = await deriveState(base);
    assert.deepStrictEqual(state.phase, "replanning-slice", "phase is replanning-slice when REPLAN-TRIGGER.md exists");
    assert.ok(state.blockers.length > 0, "blockers array is non-empty for triage replan trigger");
    assert.ok(state.nextAction.includes("Triage replan"), "nextAction mentions triage replan");
    assert.deepStrictEqual(state.activeSlice?.id, "S01", "activeSlice is S01");
    assert.deepStrictEqual(state.activeTask?.id, "T02", "activeTask is T02 (next incomplete task)");
    rmSync(base, { recursive: true, force: true });
  });
  test("deriveState: REPLAN-TRIGGER.md + REPLAN.md \u2192 executing (loop protection, #1701)", async () => {
    const base = createFixtureBase();
    writeRoadmap(base, "M001", ROADMAP_ONE_SLICE);
    writePlan(base, "M001", "S01", makePlanT01DoneT02Pending());
    writeTaskSummary(base, "M001", "S01", "T01", makeTaskSummary("T01", false));
    writeReplanTrigger(base, "M001", "S01", "# Replan Trigger\n\n**Source:** Capture C001\n");
    writeReplanFile(base, "M001", "S01", "# Replan\n\nAlready replanned.");
    const state = await deriveState(base);
    assert.deepStrictEqual(state.phase, "executing", "phase is executing when REPLAN.md exists (loop protection)");
    assert.deepStrictEqual(state.activeTask?.id, "T02", "activeTask is T02");
    rmSync(base, { recursive: true, force: true });
  });
  test("deriveState: no REPLAN-TRIGGER.md, no blocker \u2192 executing (#1701)", async () => {
    const base = createFixtureBase();
    writeRoadmap(base, "M001", ROADMAP_ONE_SLICE);
    writePlan(base, "M001", "S01", makePlanT01DoneT02Pending());
    writeTaskSummary(base, "M001", "S01", "T01", makeTaskSummary("T01", false));
    const state = await deriveState(base);
    assert.deepStrictEqual(state.phase, "executing", "phase is executing when no trigger and no blocker");
    rmSync(base, { recursive: true, force: true });
  });
  test("deriveState: blocker_discovered takes priority over REPLAN-TRIGGER.md (#1701)", async () => {
    const base = createFixtureBase();
    writeRoadmap(base, "M001", ROADMAP_ONE_SLICE);
    writePlan(base, "M001", "S01", makePlanT01DoneT02Pending());
    writeTaskSummary(base, "M001", "S01", "T01", makeTaskSummary("T01", true));
    writeReplanTrigger(base, "M001", "S01", "# Replan Trigger\n\n**Source:** Capture C001\n");
    const state = await deriveState(base);
    assert.deepStrictEqual(state.phase, "replanning-slice", "phase is replanning-slice");
    assert.ok(state.nextAction.includes("T01"), "nextAction mentions blocker task T01 (blocker path, not trigger path)");
    rmSync(base, { recursive: true, force: true });
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9yZXBsYW4tc2xpY2UudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QgfSBmcm9tICdub2RlOnRlc3QnO1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgcmVhZEZpbGVTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7IGpvaW4sIGRpcm5hbWUgfSBmcm9tICdub2RlOnBhdGgnO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSAnbm9kZTpvcyc7XG5pbXBvcnQgeyBmaWxlVVJMVG9QYXRoIH0gZnJvbSAnbm9kZTp1cmwnO1xuXG5pbXBvcnQgeyBwYXJzZVN1bW1hcnkgfSBmcm9tICcuLi9maWxlcy50cyc7XG5pbXBvcnQgeyBkZXJpdmVTdGF0ZSB9IGZyb20gJy4uL3N0YXRlLnRzJztcblxuLy8gVGhpcyBzdWl0ZSBleGVyY2lzZXMgdGhlIGV4cGxpY2l0IGxlZ2FjeSBtYXJrZG93biBkZXJpdmF0aW9uIHBhdGguXG5wcm9jZXNzLmVudi5HU0RfQUxMT1dfTUFSS0RPV05fREVSSVZFX0ZBTExCQUNLID0gJzEnO1xuXG5jb25zdCBfX2Rpcm5hbWUgPSBkaXJuYW1lKGZpbGVVUkxUb1BhdGgoaW1wb3J0Lm1ldGEudXJsKSk7XG5jb25zdCB3b3JrdHJlZVByb21wdHNEaXIgPSBqb2luKF9fZGlybmFtZSwgJy4uJywgJ3Byb21wdHMnKTtcblxuLyoqXG4gKiBMb2FkIGEgcHJvbXB0IHRlbXBsYXRlIGZyb20gdGhlIHdvcmt0cmVlIHByb21wdHMgZGlyZWN0b3J5XG4gKiBhbmQgYXBwbHkgdmFyaWFibGUgc3Vic3RpdHV0aW9uIChtaXJyb3JzIGxvYWRQcm9tcHQgbG9naWMpLlxuICovXG5mdW5jdGlvbiBsb2FkUHJvbXB0RnJvbVdvcmt0cmVlKG5hbWU6IHN0cmluZywgdmFyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9KTogc3RyaW5nIHtcbiAgY29uc3QgcGF0aCA9IGpvaW4od29ya3RyZWVQcm9tcHRzRGlyLCBgJHtuYW1lfS5tZGApO1xuICBsZXQgY29udGVudCA9IHJlYWRGaWxlU3luYyhwYXRoLCAndXRmLTgnKTtcbiAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXModmFycykpIHtcbiAgICBjb250ZW50ID0gY29udGVudC5yZXBsYWNlQWxsKGB7eyR7a2V5fX19YCwgdmFsdWUpO1xuICB9XG4gIHJldHVybiBjb250ZW50LnRyaW0oKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEZpeHR1cmUgSGVscGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gY3JlYXRlRml4dHVyZUJhc2UoKTogc3RyaW5nIHtcbiAgY29uc3QgYmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksICdnc2QtcmVwbGFuLXRlc3QtJykpO1xuICBta2RpclN5bmMoam9pbihiYXNlLCAnLmdzZCcsICdtaWxlc3RvbmVzJyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICByZXR1cm4gYmFzZTtcbn1cblxuZnVuY3Rpb24gd3JpdGVSb2FkbWFwKGJhc2U6IHN0cmluZywgbWlkOiBzdHJpbmcsIGNvbnRlbnQ6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBkaXIgPSBqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCBtaWQpO1xuICBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgYCR7bWlkfS1ST0FETUFQLm1kYCksIGNvbnRlbnQpO1xufVxuXG5mdW5jdGlvbiB3cml0ZVBsYW4oYmFzZTogc3RyaW5nLCBtaWQ6IHN0cmluZywgc2lkOiBzdHJpbmcsIGNvbnRlbnQ6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBkaXIgPSBqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCBtaWQsICdzbGljZXMnLCBzaWQpO1xuICBta2RpclN5bmMoam9pbihkaXIsICd0YXNrcycpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJ0YXNrc1wiLCBcIlQwMS1QTEFOLm1kXCIpLCBcIiMgVDAxIFBsYW5cXG5cIik7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIGAke3NpZH0tUExBTi5tZGApLCBjb250ZW50KTtcbn1cblxuZnVuY3Rpb24gd3JpdGVUYXNrU3VtbWFyeShiYXNlOiBzdHJpbmcsIG1pZDogc3RyaW5nLCBzaWQ6IHN0cmluZywgdGlkOiBzdHJpbmcsIGNvbnRlbnQ6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBkaXIgPSBqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCBtaWQsICdzbGljZXMnLCBzaWQsICd0YXNrcycpO1xuICBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgYCR7dGlkfS1TVU1NQVJZLm1kYCksIGNvbnRlbnQpO1xufVxuXG5mdW5jdGlvbiB3cml0ZVJlcGxhbkZpbGUoYmFzZTogc3RyaW5nLCBtaWQ6IHN0cmluZywgc2lkOiBzdHJpbmcsIGNvbnRlbnQ6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBkaXIgPSBqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCBtaWQsICdzbGljZXMnLCBzaWQpO1xuICBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgYCR7c2lkfS1SRVBMQU4ubWRgKSwgY29udGVudCk7XG59XG5cbmZ1bmN0aW9uIHdyaXRlUmVwbGFuVHJpZ2dlcihiYXNlOiBzdHJpbmcsIG1pZDogc3RyaW5nLCBzaWQ6IHN0cmluZywgY29udGVudDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGRpciA9IGpvaW4oYmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsIG1pZCwgJ3NsaWNlcycsIHNpZCk7XG4gIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBgJHtzaWR9LVJFUExBTi1UUklHR0VSLm1kYCksIGNvbnRlbnQpO1xufVxuXG4vKiogU3RhbmRhcmQgcm9hZG1hcCB3aXRoIG9uZSBzbGljZSBoYXZpbmcgbm8gZGVwZW5kZW5jaWVzICovXG5jb25zdCBST0FETUFQX09ORV9TTElDRSA9IGAjIE0wMDE6IFRlc3QgTWlsZXN0b25lXG5cbioqVmlzaW9uOioqIFRlc3QgdmlzaW9uLlxuXG4jIyBTbGljZXNcblxuLSBbIF0gKipTMDE6IFRlc3QgU2xpY2UqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXG4gID4gQWZ0ZXIgdGhpczogc3R1ZmYgd29ya3NcbmA7XG5cbi8qKiBQbGFuIHdpdGggVDAxIGRvbmUsIFQwMiBub3QgZG9uZSAqL1xuZnVuY3Rpb24gbWFrZVBsYW5UMDFEb25lVDAyUGVuZGluZygpOiBzdHJpbmcge1xuICByZXR1cm4gYCMgUzAxOiBUZXN0IFNsaWNlXG5cbioqR29hbDoqKiBEbyB0aGluZ3MuXG4qKkRlbW86KiogSXQgd29ya3MuXG5cbiMjIFRhc2tzXG5cbi0gW3hdICoqVDAxOiBGaXJzdCB0YXNrKiogXFxgZXN0OjE1bVxcYFxuICBGaXJzdCB0YXNrIGRlc2NyaXB0aW9uLlxuXG4tIFsgXSAqKlQwMjogU2Vjb25kIHRhc2sqKiBcXGBlc3Q6MTVtXFxgXG4gIFNlY29uZCB0YXNrIGRlc2NyaXB0aW9uLlxuYDtcbn1cblxuLyoqIFBsYW4gd2l0aCBUMDEgYW5kIFQwMiBkb25lLCBUMDMgbm90IGRvbmUgKi9cbmZ1bmN0aW9uIG1ha2VQbGFuVDAxVDAyRG9uZVQwM1BlbmRpbmcoKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAjIFMwMTogVGVzdCBTbGljZVxuXG4qKkdvYWw6KiogRG8gdGhpbmdzLlxuKipEZW1vOioqIEl0IHdvcmtzLlxuXG4jIyBUYXNrc1xuXG4tIFt4XSAqKlQwMTogRmlyc3QgdGFzayoqIFxcYGVzdDoxNW1cXGBcbiAgRmlyc3QgdGFzayBkZXNjcmlwdGlvbi5cblxuLSBbeF0gKipUMDI6IFNlY29uZCB0YXNrKiogXFxgZXN0OjE1bVxcYFxuICBTZWNvbmQgdGFzayBkZXNjcmlwdGlvbi5cblxuLSBbIF0gKipUMDM6IFRoaXJkIHRhc2sqKiBcXGBlc3Q6MTVtXFxgXG4gIFRoaXJkIHRhc2sgZGVzY3JpcHRpb24uXG5gO1xufVxuXG4vKiogTWluaW1hbCB0YXNrIHN1bW1hcnkgd2l0aCBibG9ja2VyX2Rpc2NvdmVyZWQgZmxhZyAqL1xuZnVuY3Rpb24gbWFrZVRhc2tTdW1tYXJ5KHRpZDogc3RyaW5nLCBibG9ja2VyRGlzY292ZXJlZDogYm9vbGVhbik6IHN0cmluZyB7XG4gIHJldHVybiBgLS0tXG5pZDogJHt0aWR9XG5wYXJlbnQ6IFMwMVxubWlsZXN0b25lOiBNMDAxXG5wcm92aWRlczogW11cbmtleV9maWxlczogW11cbmtleV9kZWNpc2lvbnM6IFtdXG5wYXR0ZXJuc19lc3RhYmxpc2hlZDogW11cbm9ic2VydmFiaWxpdHlfc3VyZmFjZXM6IFtdXG5kdXJhdGlvbjogMTVtaW5cbnZlcmlmaWNhdGlvbl9yZXN1bHQ6IHBhc3NlZFxuY29tcGxldGVkX2F0OiAyMDI1LTAzLTEwVDEyOjAwOjAwWlxuYmxvY2tlcl9kaXNjb3ZlcmVkOiAke2Jsb2NrZXJEaXNjb3ZlcmVkfVxuLS0tXG5cbiMgJHt0aWR9OiBUZXN0IFRhc2tcblxuKipEaWQgc29tZXRoaW5nLioqXG5cbiMjIFdoYXQgSGFwcGVuZWRcblxuV29yayB3YXMgZG9uZS5cbmA7XG59XG5cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuLy8gUGFyc2VyIEV4dHJhY3Rpb246IGJsb2NrZXJfZGlzY292ZXJlZFxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbmNvbnNvbGUubG9nKCdcXG49PT0gcGFyc2VTdW1tYXJ5OiBibG9ja2VyX2Rpc2NvdmVyZWQgdHJ1ZSAoc3RyaW5nKSA9PT0nKTtcbntcbiAgY29uc3QgY29udGVudCA9IGAtLS1cbmlkOiBUMDFcbnBhcmVudDogUzAzXG5taWxlc3RvbmU6IE0wMDJcbmJsb2NrZXJfZGlzY292ZXJlZDogdHJ1ZVxuY29tcGxldGVkX2F0OiAyMDI1LTAzLTEwVDEyOjAwOjAwWlxuLS0tXG5cbiMgVDAxOiBUZXN0IFRhc2tcblxuKipPbmUtbGluZXIuKipcblxuIyMgV2hhdCBIYXBwZW5lZFxuXG5Gb3VuZCBhIGJsb2NrZXIuXG5gO1xuXG4gIGNvbnN0IHMgPSBwYXJzZVN1bW1hcnkoY29udGVudCk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocy5mcm9udG1hdHRlci5ibG9ja2VyX2Rpc2NvdmVyZWQsIHRydWUsICdibG9ja2VyX2Rpc2NvdmVyZWQ6IHRydWUgKHN0cmluZykgZXh0cmFjdHMgYXMgdHJ1ZScpO1xufVxuXG5jb25zb2xlLmxvZygnXFxuPT09IHBhcnNlU3VtbWFyeTogYmxvY2tlcl9kaXNjb3ZlcmVkIGZhbHNlIChzdHJpbmcpID09PScpO1xue1xuICBjb25zdCBjb250ZW50ID0gYC0tLVxuaWQ6IFQwMlxucGFyZW50OiBTMDNcbm1pbGVzdG9uZTogTTAwMlxuYmxvY2tlcl9kaXNjb3ZlcmVkOiBmYWxzZVxuY29tcGxldGVkX2F0OiAyMDI1LTAzLTEwVDEyOjAwOjAwWlxuLS0tXG5cbiMgVDAyOiBOb3JtYWwgVGFza1xuXG4qKk9uZS1saW5lci4qKlxuXG4jIyBXaGF0IEhhcHBlbmVkXG5cbk5vIGJsb2NrZXIuXG5gO1xuXG4gIGNvbnN0IHMgPSBwYXJzZVN1bW1hcnkoY29udGVudCk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocy5mcm9udG1hdHRlci5ibG9ja2VyX2Rpc2NvdmVyZWQsIGZhbHNlLCAnYmxvY2tlcl9kaXNjb3ZlcmVkOiBmYWxzZSBleHRyYWN0cyBhcyBmYWxzZScpO1xufVxuXG5jb25zb2xlLmxvZygnXFxuPT09IHBhcnNlU3VtbWFyeTogYmxvY2tlcl9kaXNjb3ZlcmVkIG1pc3NpbmcgKGRlZmF1bHRzIHRvIGZhbHNlKSA9PT0nKTtcbntcbiAgY29uc3QgY29udGVudCA9IGAtLS1cbmlkOiBUMDNcbnBhcmVudDogUzAzXG5taWxlc3RvbmU6IE0wMDJcbmNvbXBsZXRlZF9hdDogMjAyNS0wMy0xMFQxMjowMDowMFpcbi0tLVxuXG4jIFQwMzogTm8gQmxvY2tlciBGaWVsZFxuXG4qKk9uZS1saW5lci4qKlxuXG4jIyBXaGF0IEhhcHBlbmVkXG5cbk5vIGJsb2NrZXIgZmllbGQgYXQgYWxsLlxuYDtcblxuICBjb25zdCBzID0gcGFyc2VTdW1tYXJ5KGNvbnRlbnQpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHMuZnJvbnRtYXR0ZXIuYmxvY2tlcl9kaXNjb3ZlcmVkLCBmYWxzZSwgJ2Jsb2NrZXJfZGlzY292ZXJlZCBtaXNzaW5nIGRlZmF1bHRzIHRvIGZhbHNlJyk7XG59XG5cbmNvbnNvbGUubG9nKCdcXG49PT0gcGFyc2VTdW1tYXJ5OiBibG9ja2VyX2Rpc2NvdmVyZWQgdHJ1ZSAoYm9vbGVhbiBmcm9tIFlBTUwpID09PScpO1xue1xuICAvLyBZQU1MIHBhcnNlcnMgbWF5IGRlbGl2ZXIgYHRydWVgIGFzIGEgYm9vbGVhbiByYXRoZXIgdGhhbiB0aGUgc3RyaW5nIFwidHJ1ZVwiXG4gIC8vIFdlIHRlc3QgdGhpcyB2aWEgYSBzdW1tYXJ5IHRoYXQgaGFzIGJsb2NrZXJfZGlzY292ZXJlZDogdHJ1ZSB3aXRoIG5vIHF1b3Rlc1xuICAvLyBUaGUgWUFNTCBwYXJzZXIgaW4gcGFyc2VGcm9udG1hdHRlck1hcCBtYXkgcmV0dXJuIGJvb2xlYW4gdHJ1ZSBkaXJlY3RseVxuICBjb25zdCBjb250ZW50ID0gYC0tLVxuaWQ6IFQwNFxucGFyZW50OiBTMDNcbm1pbGVzdG9uZTogTTAwMlxuYmxvY2tlcl9kaXNjb3ZlcmVkOiB0cnVlXG5jb21wbGV0ZWRfYXQ6IDIwMjUtMDMtMTBUMTI6MDA6MDBaXG4tLS1cblxuIyBUMDQ6IEJvb2xlYW4gVHJ1ZVxuXG4qKk9uZS1saW5lci4qKlxuXG4jIyBXaGF0IEhhcHBlbmVkXG5cbkJsb2NrZXIgYXMgYm9vbGVhbi5cbmA7XG5cbiAgY29uc3QgcyA9IHBhcnNlU3VtbWFyeShjb250ZW50KTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzLmZyb250bWF0dGVyLmJsb2NrZXJfZGlzY292ZXJlZCwgdHJ1ZSwgJ2Jsb2NrZXJfZGlzY292ZXJlZDogdHJ1ZSAoWUFNTCBib29sZWFuKSBleHRyYWN0cyBhcyB0cnVlJyk7XG59XG5cbmNvbnNvbGUubG9nKCdcXG49PT0gcGFyc2VTdW1tYXJ5OiBibG9ja2VyX2Rpc2NvdmVyZWQgd2l0aCBmdWxsIGZyb250bWF0dGVyID09PScpO1xue1xuICBjb25zdCBjb250ZW50ID0gYC0tLVxuaWQ6IFQwNVxucGFyZW50OiBTMDNcbm1pbGVzdG9uZTogTTAwMlxucHJvdmlkZXM6XG4gIC0gc29tZXRoaW5nXG5yZXF1aXJlczogW11cbmFmZmVjdHM6IFtdXG5rZXlfZmlsZXM6XG4gIC0gZmlsZXMudHNcbmtleV9kZWNpc2lvbnM6IFtdXG5wYXR0ZXJuc19lc3RhYmxpc2hlZDogW11cbmRyaWxsX2Rvd25fcGF0aHM6IFtdXG5vYnNlcnZhYmlsaXR5X3N1cmZhY2VzOiBbXVxuZHVyYXRpb246IDE1bWluXG52ZXJpZmljYXRpb25fcmVzdWx0OiBwYXNzZWRcbmNvbXBsZXRlZF9hdDogMjAyNS0wMy0xMFQxMjowMDowMFpcbmJsb2NrZXJfZGlzY292ZXJlZDogdHJ1ZVxuLS0tXG5cbiMgVDA1OiBGdWxsIEZyb250bWF0dGVyIFdpdGggQmxvY2tlclxuXG4qKkZvdW5kIGFuIGFyY2hpdGVjdHVyYWwgbWlzbWF0Y2guKipcblxuIyMgV2hhdCBIYXBwZW5lZFxuXG5UaGUgQVBJIGRvZXNuJ3Qgc3VwcG9ydCB3aGF0IHdlIGFzc3VtZWQuXG5cbiMjIERldmlhdGlvbnNcblxuTWFqb3IgZGV2aWF0aW9uIGZyb20gcGxhbi5cblxuIyMgRmlsZXMgQ3JlYXRlZC9Nb2RpZmllZFxuXG4tIFxcYGZpbGVzLnRzXFxgIFx1MjAxNCBhdHRlbXB0ZWQgY2hhbmdlc1xuYDtcblxuICBjb25zdCBzID0gcGFyc2VTdW1tYXJ5KGNvbnRlbnQpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHMuZnJvbnRtYXR0ZXIuYmxvY2tlcl9kaXNjb3ZlcmVkLCB0cnVlLCAnYmxvY2tlcl9kaXNjb3ZlcmVkIHRydWUgd2l0aCBmdWxsIGZyb250bWF0dGVyJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocy5mcm9udG1hdHRlci5pZCwgJ1QwNScsICdvdGhlciBmaWVsZHMgc3RpbGwgcGFyc2UgY29ycmVjdGx5IGFsb25nc2lkZSBibG9ja2VyX2Rpc2NvdmVyZWQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzLmZyb250bWF0dGVyLmR1cmF0aW9uLCAnMTVtaW4nLCAnZHVyYXRpb24gc3RpbGwgcGFyc2VkJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocy5mcm9udG1hdHRlci5wcm92aWRlc1swXSwgJ3NvbWV0aGluZycsICdwcm92aWRlcyBzdGlsbCBwYXJzZWQnKTtcbn1cblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBTdGF0ZSBEZXRlY3Rpb246IHJlcGxhbm5pbmctc2xpY2UgcGhhc2Vcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG4vLyAoYSkgYmxvY2tlciBmb3VuZCArIG5vIFJFUExBTi5tZCBcdTIxOTIgcmVwbGFubmluZy1zbGljZVxuY29uc29sZS5sb2coJ1xcbj09PSBkZXJpdmVTdGF0ZTogYmxvY2tlciBmb3VuZCwgbm8gUkVQTEFOIFx1MjE5MiByZXBsYW5uaW5nLXNsaWNlID09PScpO1xue1xuICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgd3JpdGVSb2FkbWFwKGJhc2UsICdNMDAxJywgUk9BRE1BUF9PTkVfU0xJQ0UpO1xuICB3cml0ZVBsYW4oYmFzZSwgJ00wMDEnLCAnUzAxJywgbWFrZVBsYW5UMDFEb25lVDAyUGVuZGluZygpKTtcbiAgd3JpdGVUYXNrU3VtbWFyeShiYXNlLCAnTTAwMScsICdTMDEnLCAnVDAxJywgbWFrZVRhc2tTdW1tYXJ5KCdUMDEnLCB0cnVlKSk7XG5cbiAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5waGFzZSwgJ3JlcGxhbm5pbmctc2xpY2UnLCAncGhhc2UgaXMgcmVwbGFubmluZy1zbGljZSB3aGVuIGJsb2NrZXIgZm91bmQgYW5kIG5vIFJFUExBTi5tZCcpO1xuICBhc3NlcnQub2soc3RhdGUubmV4dEFjdGlvbi5pbmNsdWRlcygnVDAxJyksICduZXh0QWN0aW9uIG1lbnRpb25zIGJsb2NrZXIgdGFzayBUMDEnKTtcbiAgYXNzZXJ0Lm9rKHN0YXRlLm5leHRBY3Rpb24uaW5jbHVkZXMoJ2Jsb2NrZXJfZGlzY292ZXJlZCcpLCAnbmV4dEFjdGlvbiBtZW50aW9ucyBibG9ja2VyX2Rpc2NvdmVyZWQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5hY3RpdmVUYXNrPy5pZCwgJ1QwMicsICdhY3RpdmVUYXNrIGlzIHN0aWxsIFQwMiAodGhlIG5leHQgaW5jb21wbGV0ZSB0YXNrKScpO1xuICBhc3NlcnQub2soc3RhdGUuYmxvY2tlcnMubGVuZ3RoID4gMCwgJ2Jsb2NrZXJzIGFycmF5IGlzIG5vbi1lbXB0eScpO1xuICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xufVxuXG4vLyAoYikgYmxvY2tlciBmb3VuZCArIFJFUExBTi5tZCBleGlzdHMgXHUyMTkyIGV4ZWN1dGluZyAobG9vcCBwcm90ZWN0aW9uKVxuY29uc29sZS5sb2coJ1xcbj09PSBkZXJpdmVTdGF0ZTogYmxvY2tlciBmb3VuZCArIFJFUExBTiBleGlzdHMgXHUyMTkyIGV4ZWN1dGluZyAobG9vcCBwcm90ZWN0aW9uKSA9PT0nKTtcbntcbiAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gIHdyaXRlUm9hZG1hcChiYXNlLCAnTTAwMScsIFJPQURNQVBfT05FX1NMSUNFKTtcbiAgd3JpdGVQbGFuKGJhc2UsICdNMDAxJywgJ1MwMScsIG1ha2VQbGFuVDAxRG9uZVQwMlBlbmRpbmcoKSk7XG4gIHdyaXRlVGFza1N1bW1hcnkoYmFzZSwgJ00wMDEnLCAnUzAxJywgJ1QwMScsIG1ha2VUYXNrU3VtbWFyeSgnVDAxJywgdHJ1ZSkpO1xuICB3cml0ZVJlcGxhbkZpbGUoYmFzZSwgJ00wMDEnLCAnUzAxJywgJyMgUmVwbGFuXFxuXFxuQWxyZWFkeSByZXBsYW5uZWQuJyk7XG5cbiAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5waGFzZSwgJ2V4ZWN1dGluZycsICdwaGFzZSBpcyBleGVjdXRpbmcgd2hlbiBSRVBMQU4ubWQgZXhpc3RzIChsb29wIHByb3RlY3Rpb24pJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUuYWN0aXZlVGFzaz8uaWQsICdUMDInLCAnYWN0aXZlVGFzayBpcyBUMDInKTtcbiAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbn1cblxuLy8gKGMpIG5vIGJsb2NrZXIgXHUyMTkyIGV4ZWN1dGluZ1xuY29uc29sZS5sb2coJ1xcbj09PSBkZXJpdmVTdGF0ZTogbm8gYmxvY2tlciBpbiBjb21wbGV0ZWQgdGFza3MgXHUyMTkyIGV4ZWN1dGluZyA9PT0nKTtcbntcbiAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gIHdyaXRlUm9hZG1hcChiYXNlLCAnTTAwMScsIFJPQURNQVBfT05FX1NMSUNFKTtcbiAgd3JpdGVQbGFuKGJhc2UsICdNMDAxJywgJ1MwMScsIG1ha2VQbGFuVDAxRG9uZVQwMlBlbmRpbmcoKSk7XG4gIHdyaXRlVGFza1N1bW1hcnkoYmFzZSwgJ00wMDEnLCAnUzAxJywgJ1QwMScsIG1ha2VUYXNrU3VtbWFyeSgnVDAxJywgZmFsc2UpKTtcblxuICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnBoYXNlLCAnZXhlY3V0aW5nJywgJ3BoYXNlIGlzIGV4ZWN1dGluZyB3aGVuIG5vIGJsb2NrZXIgZm91bmQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5hY3RpdmVUYXNrPy5pZCwgJ1QwMicsICdhY3RpdmVUYXNrIGlzIFQwMicpO1xuICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xufVxuXG4vLyAoZCkgbXVsdGlwbGUgY29tcGxldGVkIHRhc2tzLCBvbmUgd2l0aCBibG9ja2VyIFx1MjE5MiByZXBsYW5uaW5nLXNsaWNlXG5jb25zb2xlLmxvZygnXFxuPT09IGRlcml2ZVN0YXRlOiBtdWx0aXBsZSBjb21wbGV0ZWQgdGFza3MsIG9uZSBibG9ja2VyIFx1MjE5MiByZXBsYW5uaW5nLXNsaWNlID09PScpO1xue1xuICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgd3JpdGVSb2FkbWFwKGJhc2UsICdNMDAxJywgUk9BRE1BUF9PTkVfU0xJQ0UpO1xuICB3cml0ZVBsYW4oYmFzZSwgJ00wMDEnLCAnUzAxJywgbWFrZVBsYW5UMDFUMDJEb25lVDAzUGVuZGluZygpKTtcbiAgd3JpdGVUYXNrU3VtbWFyeShiYXNlLCAnTTAwMScsICdTMDEnLCAnVDAxJywgbWFrZVRhc2tTdW1tYXJ5KCdUMDEnLCBmYWxzZSkpO1xuICB3cml0ZVRhc2tTdW1tYXJ5KGJhc2UsICdNMDAxJywgJ1MwMScsICdUMDInLCBtYWtlVGFza1N1bW1hcnkoJ1QwMicsIHRydWUpKTtcblxuICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnBoYXNlLCAncmVwbGFubmluZy1zbGljZScsICdwaGFzZSBpcyByZXBsYW5uaW5nLXNsaWNlIHdoZW4gVDAyIGhhcyBibG9ja2VyJyk7XG4gIGFzc2VydC5vayhzdGF0ZS5uZXh0QWN0aW9uLmluY2x1ZGVzKCdUMDInKSwgJ25leHRBY3Rpb24gbWVudGlvbnMgYmxvY2tlciB0YXNrIFQwMicpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLmFjdGl2ZVRhc2s/LmlkLCAnVDAzJywgJ2FjdGl2ZVRhc2sgaXMgVDAzIChuZXh0IGluY29tcGxldGUpJyk7XG4gIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG59XG5cbi8vIChlKSBjb21wbGV0ZWQgdGFzayB3aXRoIG5vIHN1bW1hcnkgZmlsZSBcdTIxOTIgZXhlY3V0aW5nIChncmFjZWZ1bGx5IHNraXBwZWQpXG5jb25zb2xlLmxvZygnXFxuPT09IGRlcml2ZVN0YXRlOiBjb21wbGV0ZWQgdGFzayB3aXRoIG5vIHN1bW1hcnkgZmlsZSBcdTIxOTIgZXhlY3V0aW5nID09PScpO1xue1xuICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgd3JpdGVSb2FkbWFwKGJhc2UsICdNMDAxJywgUk9BRE1BUF9PTkVfU0xJQ0UpO1xuICB3cml0ZVBsYW4oYmFzZSwgJ00wMDEnLCAnUzAxJywgbWFrZVBsYW5UMDFEb25lVDAyUGVuZGluZygpKTtcbiAgLy8gTm8gc3VtbWFyeSBmaWxlIHdyaXR0ZW4gZm9yIFQwMVxuXG4gIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucGhhc2UsICdleGVjdXRpbmcnLCAncGhhc2UgaXMgZXhlY3V0aW5nIHdoZW4gY29tcGxldGVkIHRhc2sgaGFzIG5vIHN1bW1hcnknKTtcbiAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbn1cblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBQcm9tcHQ6IHJlcGxhbi1zbGljZSB0ZW1wbGF0ZSBsb2FkaW5nIGFuZCBzdWJzdGl0dXRpb25cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG5jb25zb2xlLmxvZygnXFxuPT09IHByb21wdDogcmVwbGFuLXNsaWNlIHRlbXBsYXRlIGxvYWRzIGFuZCBzdWJzdGl0dXRlcyB2YXJpYWJsZXMgPT09Jyk7XG57XG4gIGNvbnN0IHByb21wdCA9IGxvYWRQcm9tcHRGcm9tV29ya3RyZWUoJ3JlcGxhbi1zbGljZScsIHtcbiAgICB3b3JraW5nRGlyZWN0b3J5OiAnL3RtcC90ZXN0LXByb2plY3QnLFxuICAgIG1pbGVzdG9uZUlkOiAnTTAwMScsXG4gICAgc2xpY2VJZDogJ1MwMScsXG4gICAgc2xpY2VUaXRsZTogJ1Rlc3QgU2xpY2UnLFxuICAgIHNsaWNlUGF0aDogJy5nc2QvbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEnLFxuICAgIHBsYW5QYXRoOiAnLmdzZC9taWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMS9TMDEtUExBTi5tZCcsXG4gICAgaW5saW5lZENvbnRleHQ6ICcjIyBJbmxpbmVkIENvbnRleHRcXG5cXG5UZXN0IGNvbnRleHQgaGVyZS4nLFxuICB9KTtcblxuICBhc3NlcnQub2socHJvbXB0LmluY2x1ZGVzKCdNMDAxJyksICdwcm9tcHQgY29udGFpbnMgbWlsZXN0b25lSWQnKTtcbiAgYXNzZXJ0Lm9rKHByb21wdC5pbmNsdWRlcygnUzAxJyksICdwcm9tcHQgY29udGFpbnMgc2xpY2VJZCcpO1xuICBhc3NlcnQub2socHJvbXB0LmluY2x1ZGVzKCdUZXN0IFNsaWNlJyksICdwcm9tcHQgY29udGFpbnMgc2xpY2VUaXRsZScpO1xuICBhc3NlcnQub2socHJvbXB0LmluY2x1ZGVzKCcuZ3NkL21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzAxL1MwMS1QTEFOLm1kJyksICdwcm9tcHQgY29udGFpbnMgcGxhblBhdGgnKTtcbiAgYXNzZXJ0Lm9rKHByb21wdC5pbmNsdWRlcygnVGVzdCBjb250ZXh0IGhlcmUnKSwgJ3Byb21wdCBjb250YWlucyBpbmxpbmVkIGNvbnRleHQnKTtcbn1cblxuY29uc29sZS5sb2coJ1xcbj09PSBwcm9tcHQ6IHJlcGxhbi1zbGljZSBjb250YWlucyBwcmVzZXJ2ZS1jb21wbGV0ZWQtdGFza3MgaW5zdHJ1Y3Rpb24gPT09Jyk7XG57XG4gIGNvbnN0IHByb21wdCA9IGxvYWRQcm9tcHRGcm9tV29ya3RyZWUoJ3JlcGxhbi1zbGljZScsIHtcbiAgICB3b3JraW5nRGlyZWN0b3J5OiAnL3RtcC90ZXN0LXByb2plY3QnLFxuICAgIG1pbGVzdG9uZUlkOiAnTTAwMScsXG4gICAgc2xpY2VJZDogJ1MwMScsXG4gICAgc2xpY2VUaXRsZTogJ1Rlc3QgU2xpY2UnLFxuICAgIHNsaWNlUGF0aDogJy5nc2QvbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEnLFxuICAgIHBsYW5QYXRoOiAnLmdzZC9taWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMS9TMDEtUExBTi5tZCcsXG4gICAgYmxvY2tlclRhc2tJZDogJ1QwMScsXG4gICAgcmVwbGFuUGF0aDogJy5nc2QvbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvUzAxLVJFUExBTi5tZCcsXG4gICAgaW5saW5lZENvbnRleHQ6ICcnLFxuICB9KTtcblxuICBhc3NlcnQub2socHJvbXB0LmluY2x1ZGVzKCdEbyBOT1QgcmVudW1iZXIgb3IgcmVtb3ZlIGNvbXBsZXRlZCB0YXNrcycpLCAncHJvbXB0IGNvbnRhaW5zIHByZXNlcnZlLWNvbXBsZXRlZC10YXNrcyBpbnN0cnVjdGlvbicpO1xuICBhc3NlcnQub2socHJvbXB0LmluY2x1ZGVzKCdbeF0nKSwgJ3Byb21wdCBtZW50aW9ucyBbeF0gY2hlY2ttYXJrcycpO1xuICBhc3NlcnQub2socHJvbXB0LmluY2x1ZGVzKCdSRVBMQU4nKSwgJ3Byb21wdCByZWZlcmVuY2VzIHJlcGxhbiBvdXRwdXQgcGF0aCcpO1xuICBhc3NlcnQub2socHJvbXB0LmluY2x1ZGVzKCdibG9ja2VyX2Rpc2NvdmVyZWQnKSwgJ3Byb21wdCBtZW50aW9ucyBibG9ja2VyX2Rpc2NvdmVyZWQnKTtcbn1cblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBEaXNwYXRjaDogZGlhZ25vc2VFeHBlY3RlZEFydGlmYWN0IGZvciByZXBsYW4tc2xpY2Vcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG5jb25zb2xlLmxvZygnXFxuPT09IGRpc3BhdGNoOiBkaWFnbm9zZUV4cGVjdGVkQXJ0aWZhY3QgcmV0dXJucyBSRVBMQU4ubWQgcGF0aCA9PT0nKTtcbntcbiAgLy8gV2UgY2FuJ3QgaW1wb3J0IGRpYWdub3NlRXhwZWN0ZWRBcnRpZmFjdCBkaXJlY3RseSAoaXQncyBub3QgZXhwb3J0ZWQpLFxuICAvLyBidXQgd2UgY2FuIHZlcmlmeSB0aGUgcHJvbXB0IHRlbXBsYXRlIGhhcyB0aGUgcmlnaHQgc3RydWN0dXJlIGFuZFxuICAvLyB0aGUgc3RhdGUgbWFjaGluZSByb3V0ZXMgY29ycmVjdGx5LiBUaGUgZGlhZ25vc2UgZnVuY3Rpb24gaXMgaW50ZWdyYXRpb24tdGVzdGVkXG4gIC8vIHZpYSB0aGUgZGlzcGF0Y2ggY2hhaW4uIFdlIHZlcmlmeSBpbmRpcmVjdGx5IHZpYSBzdGF0ZSBwaGFzZSBkZXRlY3Rpb24uXG5cbiAgLy8gVmVyaWZ5IHN0YXRlIGNvcnJlY3RseSByb3V0ZXMgdG8gcmVwbGFubmluZy1zbGljZSBwaGFzZVxuICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgd3JpdGVSb2FkbWFwKGJhc2UsICdNMDAxJywgUk9BRE1BUF9PTkVfU0xJQ0UpO1xuICB3cml0ZVBsYW4oYmFzZSwgJ00wMDEnLCAnUzAxJywgbWFrZVBsYW5UMDFEb25lVDAyUGVuZGluZygpKTtcbiAgd3JpdGVUYXNrU3VtbWFyeShiYXNlLCAnTTAwMScsICdTMDEnLCAnVDAxJywgbWFrZVRhc2tTdW1tYXJ5KCdUMDEnLCB0cnVlKSk7XG5cbiAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5waGFzZSwgJ3JlcGxhbm5pbmctc2xpY2UnLCAnZGlzcGF0Y2g6IHN0YXRlIHJvdXRlcyB0byByZXBsYW5uaW5nLXNsaWNlIHdoZW4gYmxvY2tlciBmb3VuZCcpO1xuICBhc3NlcnQub2soc3RhdGUuYWN0aXZlU2xpY2U/LmlkID09PSAnUzAxJywgJ2Rpc3BhdGNoOiBhY3RpdmVTbGljZSBpcyBTMDEnKTtcbiAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbn1cblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBEaXNwbGF5IEZ1bmN0aW9uczogdW5pdFZlcmIsIHVuaXRQaGFzZUxhYmVsLCBwZWVrTmV4dCBlbnRyaWVzXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuY29uc29sZS5sb2coJ1xcbj09PSBkaXNwbGF5OiByZXBsYW4tc2xpY2UgcHJvbXB0IHRlbXBsYXRlIGhhcyBjb3JyZWN0IHVuaXQgaGVhZGVyID09PScpO1xue1xuICBjb25zdCBwcm9tcHQgPSBsb2FkUHJvbXB0RnJvbVdvcmt0cmVlKCdyZXBsYW4tc2xpY2UnLCB7XG4gICAgd29ya2luZ0RpcmVjdG9yeTogJy90bXAvdGVzdC1wcm9qZWN0JyxcbiAgICBtaWxlc3RvbmVJZDogJ00wMDEnLFxuICAgIHNsaWNlSWQ6ICdTMDEnLFxuICAgIHNsaWNlVGl0bGU6ICdUZXN0IFNsaWNlJyxcbiAgICBzbGljZVBhdGg6ICcuZ3NkL21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzAxJyxcbiAgICBwbGFuUGF0aDogJy5nc2QvbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvUzAxLVBMQU4ubWQnLFxuICAgIGJsb2NrZXJUYXNrSWQ6ICdUMDEnLFxuICAgIGlubGluZWRDb250ZXh0OiAnJyxcbiAgfSk7XG5cbiAgYXNzZXJ0Lm9rKHByb21wdC5pbmNsdWRlcygnVU5JVDogUmVwbGFuIFNsaWNlJyksICdwcm9tcHQgaGFzIFJlcGxhbiBTbGljZSB1bml0IGhlYWRlcicpO1xuICBhc3NlcnQub2socHJvbXB0LmluY2x1ZGVzKCdTbGljZSBTMDEgcmVwbGFubmVkJyksICdwcm9tcHQgaGFzIGNvbXBsZXRpb24gbWVzc2FnZScpO1xufVxuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIERvY3RvcjogYmxvY2tlcl9kaXNjb3ZlcmVkX25vX3JlcGxhbiBkaWFnbm9zdGljc1xuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbmltcG9ydCB7IHJ1bkdTRERvY3RvciB9IGZyb20gJy4uL2RvY3Rvci50cyc7XG4vLyAoYSkgYmxvY2tlciArIG5vIFJFUExBTi5tZCBcdTIxOTIgaXNzdWUgZW1pdHRlZFxuY29uc29sZS5sb2coJ1xcbj09PSBkb2N0b3I6IGJsb2NrZXIgKyBubyBSRVBMQU4ubWQgXHUyMTkyIGJsb2NrZXJfZGlzY292ZXJlZF9ub19yZXBsYW4gaXNzdWUgPT09Jyk7XG57XG4gIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICB3cml0ZVJvYWRtYXAoYmFzZSwgJ00wMDEnLCBST0FETUFQX09ORV9TTElDRSk7XG4gIHdyaXRlUGxhbihiYXNlLCAnTTAwMScsICdTMDEnLCBtYWtlUGxhblQwMURvbmVUMDJQZW5kaW5nKCkpO1xuICB3cml0ZVRhc2tTdW1tYXJ5KGJhc2UsICdNMDAxJywgJ1MwMScsICdUMDEnLCBtYWtlVGFza1N1bW1hcnkoJ1QwMScsIHRydWUpKTtcblxuICBjb25zdCByZXBvcnQgPSBhd2FpdCBydW5HU0REb2N0b3IoYmFzZSwgeyBmaXg6IGZhbHNlLCBzY29wZTogJ00wMDEvUzAxJyB9KTtcbiAgY29uc3QgYmxvY2tlcklzc3VlcyA9IHJlcG9ydC5pc3N1ZXMuZmlsdGVyKGkgPT4gaS5jb2RlID09PSAnYmxvY2tlcl9kaXNjb3ZlcmVkX25vX3JlcGxhbicpO1xuICBhc3NlcnQub2soYmxvY2tlcklzc3Vlcy5sZW5ndGggPiAwLCAnZG9jdG9yIGVtaXRzIGJsb2NrZXJfZGlzY292ZXJlZF9ub19yZXBsYW4gd2hlbiBibG9ja2VyICsgbm8gUkVQTEFOJyk7XG4gIGFzc2VydC5vayhibG9ja2VySXNzdWVzWzBdPy5tZXNzYWdlLmluY2x1ZGVzKCdUMDEnKSwgJ2lzc3VlIG1lc3NhZ2UgbWVudGlvbnMgdGhlIGJsb2NrZXIgdGFzayBUMDEnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChibG9ja2VySXNzdWVzWzBdPy5zZXZlcml0eSwgJ3dhcm5pbmcnLCAnYmxvY2tlcl9kaXNjb3ZlcmVkX25vX3JlcGxhbiBpcyB3YXJuaW5nIHNldmVyaXR5Jyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoYmxvY2tlcklzc3Vlc1swXT8uc2NvcGUsICdzbGljZScsICdibG9ja2VyX2Rpc2NvdmVyZWRfbm9fcmVwbGFuIGhhcyBzbGljZSBzY29wZScpO1xuICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xufVxuXG4vLyAoYikgYmxvY2tlciArIFJFUExBTi5tZCBleGlzdHMgXHUyMTkyIG5vIGlzc3VlXG5jb25zb2xlLmxvZygnXFxuPT09IGRvY3RvcjogYmxvY2tlciArIFJFUExBTi5tZCBleGlzdHMgXHUyMTkyIG5vIGJsb2NrZXJfZGlzY292ZXJlZF9ub19yZXBsYW4gaXNzdWUgPT09Jyk7XG57XG4gIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICB3cml0ZVJvYWRtYXAoYmFzZSwgJ00wMDEnLCBST0FETUFQX09ORV9TTElDRSk7XG4gIHdyaXRlUGxhbihiYXNlLCAnTTAwMScsICdTMDEnLCBtYWtlUGxhblQwMURvbmVUMDJQZW5kaW5nKCkpO1xuICB3cml0ZVRhc2tTdW1tYXJ5KGJhc2UsICdNMDAxJywgJ1MwMScsICdUMDEnLCBtYWtlVGFza1N1bW1hcnkoJ1QwMScsIHRydWUpKTtcbiAgd3JpdGVSZXBsYW5GaWxlKGJhc2UsICdNMDAxJywgJ1MwMScsICcjIFJlcGxhblxcblxcbkFscmVhZHkgcmVwbGFubmVkLicpO1xuXG4gIGNvbnN0IHJlcG9ydCA9IGF3YWl0IHJ1bkdTRERvY3RvcihiYXNlLCB7IGZpeDogZmFsc2UsIHNjb3BlOiAnTTAwMS9TMDEnIH0pO1xuICBjb25zdCBibG9ja2VySXNzdWVzID0gcmVwb3J0Lmlzc3Vlcy5maWx0ZXIoaSA9PiBpLmNvZGUgPT09ICdibG9ja2VyX2Rpc2NvdmVyZWRfbm9fcmVwbGFuJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoYmxvY2tlcklzc3Vlcy5sZW5ndGgsIDAsICdubyBibG9ja2VyX2Rpc2NvdmVyZWRfbm9fcmVwbGFuIHdoZW4gUkVQTEFOLm1kIGV4aXN0cycpO1xuICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xufVxuXG4vLyAoYykgbm8gYmxvY2tlciBcdTIxOTIgbm8gaXNzdWVcbmNvbnNvbGUubG9nKCdcXG49PT0gZG9jdG9yOiBubyBibG9ja2VyIFx1MjE5MiBubyBibG9ja2VyX2Rpc2NvdmVyZWRfbm9fcmVwbGFuIGlzc3VlID09PScpO1xue1xuICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgd3JpdGVSb2FkbWFwKGJhc2UsICdNMDAxJywgUk9BRE1BUF9PTkVfU0xJQ0UpO1xuICB3cml0ZVBsYW4oYmFzZSwgJ00wMDEnLCAnUzAxJywgbWFrZVBsYW5UMDFEb25lVDAyUGVuZGluZygpKTtcbiAgd3JpdGVUYXNrU3VtbWFyeShiYXNlLCAnTTAwMScsICdTMDEnLCAnVDAxJywgbWFrZVRhc2tTdW1tYXJ5KCdUMDEnLCBmYWxzZSkpO1xuXG4gIGNvbnN0IHJlcG9ydCA9IGF3YWl0IHJ1bkdTRERvY3RvcihiYXNlLCB7IGZpeDogZmFsc2UsIHNjb3BlOiAnTTAwMS9TMDEnIH0pO1xuICBjb25zdCBibG9ja2VySXNzdWVzID0gcmVwb3J0Lmlzc3Vlcy5maWx0ZXIoaSA9PiBpLmNvZGUgPT09ICdibG9ja2VyX2Rpc2NvdmVyZWRfbm9fcmVwbGFuJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoYmxvY2tlcklzc3Vlcy5sZW5ndGgsIDAsICdubyBibG9ja2VyX2Rpc2NvdmVyZWRfbm9fcmVwbGFuIHdoZW4gbm8gYmxvY2tlcicpO1xuICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xufVxuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIEFydGlmYWN0IFJlc29sdXRpb246IHJlc29sdmVFeHBlY3RlZEFydGlmYWN0UGF0aCBmb3IgcmVwbGFuLXNsaWNlICgjODU4KVxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbmltcG9ydCB7IHJlc29sdmVFeHBlY3RlZEFydGlmYWN0UGF0aCB9IGZyb20gJy4uL2F1dG8tYXJ0aWZhY3QtcGF0aHMudHMnO1xuaW1wb3J0IHsgdmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdCB9IGZyb20gJy4uL2F1dG8tcmVjb3ZlcnkudHMnO1xuXG5cbmRlc2NyaWJlKCdyZXBsYW4tc2xpY2UnLCAoKSA9PiB7XG50ZXN0KCdhcnRpZmFjdDogcmVzb2x2ZUV4cGVjdGVkQXJ0aWZhY3RQYXRoIHJldHVybnMgUkVQTEFOLm1kIHBhdGggZm9yIHJlcGxhbi1zbGljZScsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gIHdyaXRlUm9hZG1hcChiYXNlLCAnTTAwMScsIFJPQURNQVBfT05FX1NMSUNFKTtcbiAgd3JpdGVQbGFuKGJhc2UsICdNMDAxJywgJ1MwMScsIG1ha2VQbGFuVDAxRG9uZVQwMlBlbmRpbmcoKSk7XG5cbiAgY29uc3QgcGF0aCA9IHJlc29sdmVFeHBlY3RlZEFydGlmYWN0UGF0aCgncmVwbGFuLXNsaWNlJywgJ00wMDEvUzAxJywgYmFzZSk7XG4gIGFzc2VydC5vayhwYXRoICE9PSBudWxsLCAncmVzb2x2ZUV4cGVjdGVkQXJ0aWZhY3RQYXRoIHJldHVybnMgbm9uLW51bGwgZm9yIHJlcGxhbi1zbGljZScpO1xuICBhc3NlcnQub2socGF0aCEuZW5kc1dpdGgoJ1MwMS1SRVBMQU4ubWQnKSwgJ3BhdGggZW5kcyB3aXRoIFMwMS1SRVBMQU4ubWQnKTtcbiAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbn0pO1xuXG50ZXN0KCdhcnRpZmFjdDogdmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdCBmYWlscyB3aGVuIFJFUExBTi5tZCBtaXNzaW5nICgjODU4KScsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gIHdyaXRlUm9hZG1hcChiYXNlLCAnTTAwMScsIFJPQURNQVBfT05FX1NMSUNFKTtcbiAgd3JpdGVQbGFuKGJhc2UsICdNMDAxJywgJ1MwMScsIG1ha2VQbGFuVDAxRG9uZVQwMlBlbmRpbmcoKSk7XG5cbiAgY29uc3QgcmVzdWx0ID0gdmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdCgncmVwbGFuLXNsaWNlJywgJ00wMDEvUzAxJywgYmFzZSk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0LCBmYWxzZSwgJ3ZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QgcmV0dXJucyBmYWxzZSB3aGVuIFJFUExBTi5tZCBpcyBtaXNzaW5nJyk7XG4gIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG59KTtcblxudGVzdCgnYXJ0aWZhY3Q6IHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QgcGFzc2VzIHdoZW4gUkVQTEFOLm1kIGV4aXN0cyAoIzg1OCknLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICB3cml0ZVJvYWRtYXAoYmFzZSwgJ00wMDEnLCBST0FETUFQX09ORV9TTElDRSk7XG4gIHdyaXRlUGxhbihiYXNlLCAnTTAwMScsICdTMDEnLCBtYWtlUGxhblQwMURvbmVUMDJQZW5kaW5nKCkpO1xuICB3cml0ZVJlcGxhbkZpbGUoYmFzZSwgJ00wMDEnLCAnUzAxJywgJyMgUmVwbGFuXFxuXFxuQmxvY2tlciBhZGRyZXNzZWQuJyk7XG5cbiAgY29uc3QgcmVzdWx0ID0gdmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdCgncmVwbGFuLXNsaWNlJywgJ00wMDEvUzAxJywgYmFzZSk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0LCB0cnVlLCAndmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdCByZXR1cm5zIHRydWUgd2hlbiBSRVBMQU4ubWQgZXhpc3RzJyk7XG4gIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG59KTtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBSRVBMQU4tVFJJR0dFUi5tZCBkZXRlY3Rpb24gKHRyaWFnZS1pbml0aWF0ZWQgcmVwbGFuLCAjMTcwMSlcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuLy8gKGEpIFJFUExBTi1UUklHR0VSLm1kIGV4aXN0cyArIG5vIFJFUExBTi5tZCBcdTIxOTIgcmVwbGFubmluZy1zbGljZVxudGVzdCgnZGVyaXZlU3RhdGU6IFJFUExBTi1UUklHR0VSLm1kIGV4aXN0cywgbm8gUkVQTEFOIFx1MjE5MiByZXBsYW5uaW5nLXNsaWNlICgjMTcwMSknLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICB3cml0ZVJvYWRtYXAoYmFzZSwgJ00wMDEnLCBST0FETUFQX09ORV9TTElDRSk7XG4gIHdyaXRlUGxhbihiYXNlLCAnTTAwMScsICdTMDEnLCBtYWtlUGxhblQwMURvbmVUMDJQZW5kaW5nKCkpO1xuICAvLyBObyBibG9ja2VyIGluIHRhc2sgc3VtbWFyeSBcdTIwMTQgdGhlIHRyaWdnZXIgY29tZXMgZnJvbSB0cmlhZ2UsIG5vdCBibG9ja2VyX2Rpc2NvdmVyZWRcbiAgd3JpdGVUYXNrU3VtbWFyeShiYXNlLCAnTTAwMScsICdTMDEnLCAnVDAxJywgbWFrZVRhc2tTdW1tYXJ5KCdUMDEnLCBmYWxzZSkpO1xuICB3cml0ZVJlcGxhblRyaWdnZXIoYmFzZSwgJ00wMDEnLCAnUzAxJywgJyMgUmVwbGFuIFRyaWdnZXJcXG5cXG4qKlNvdXJjZToqKiBDYXB0dXJlIEMwMDFcXG4nKTtcblxuICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnBoYXNlLCAncmVwbGFubmluZy1zbGljZScsICdwaGFzZSBpcyByZXBsYW5uaW5nLXNsaWNlIHdoZW4gUkVQTEFOLVRSSUdHRVIubWQgZXhpc3RzJyk7XG4gIGFzc2VydC5vayhzdGF0ZS5ibG9ja2Vycy5sZW5ndGggPiAwLCAnYmxvY2tlcnMgYXJyYXkgaXMgbm9uLWVtcHR5IGZvciB0cmlhZ2UgcmVwbGFuIHRyaWdnZXInKTtcbiAgYXNzZXJ0Lm9rKHN0YXRlLm5leHRBY3Rpb24uaW5jbHVkZXMoJ1RyaWFnZSByZXBsYW4nKSwgJ25leHRBY3Rpb24gbWVudGlvbnMgdHJpYWdlIHJlcGxhbicpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLmFjdGl2ZVNsaWNlPy5pZCwgJ1MwMScsICdhY3RpdmVTbGljZSBpcyBTMDEnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzdGF0ZS5hY3RpdmVUYXNrPy5pZCwgJ1QwMicsICdhY3RpdmVUYXNrIGlzIFQwMiAobmV4dCBpbmNvbXBsZXRlIHRhc2spJyk7XG4gIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG59KTtcblxuLy8gKGIpIFJFUExBTi1UUklHR0VSLm1kICsgUkVQTEFOLm1kIGJvdGggZXhpc3QgXHUyMTkyIGV4ZWN1dGluZyAobG9vcCBwcm90ZWN0aW9uKVxudGVzdCgnZGVyaXZlU3RhdGU6IFJFUExBTi1UUklHR0VSLm1kICsgUkVQTEFOLm1kIFx1MjE5MiBleGVjdXRpbmcgKGxvb3AgcHJvdGVjdGlvbiwgIzE3MDEpJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgd3JpdGVSb2FkbWFwKGJhc2UsICdNMDAxJywgUk9BRE1BUF9PTkVfU0xJQ0UpO1xuICB3cml0ZVBsYW4oYmFzZSwgJ00wMDEnLCAnUzAxJywgbWFrZVBsYW5UMDFEb25lVDAyUGVuZGluZygpKTtcbiAgd3JpdGVUYXNrU3VtbWFyeShiYXNlLCAnTTAwMScsICdTMDEnLCAnVDAxJywgbWFrZVRhc2tTdW1tYXJ5KCdUMDEnLCBmYWxzZSkpO1xuICB3cml0ZVJlcGxhblRyaWdnZXIoYmFzZSwgJ00wMDEnLCAnUzAxJywgJyMgUmVwbGFuIFRyaWdnZXJcXG5cXG4qKlNvdXJjZToqKiBDYXB0dXJlIEMwMDFcXG4nKTtcbiAgd3JpdGVSZXBsYW5GaWxlKGJhc2UsICdNMDAxJywgJ1MwMScsICcjIFJlcGxhblxcblxcbkFscmVhZHkgcmVwbGFubmVkLicpO1xuXG4gIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucGhhc2UsICdleGVjdXRpbmcnLCAncGhhc2UgaXMgZXhlY3V0aW5nIHdoZW4gUkVQTEFOLm1kIGV4aXN0cyAobG9vcCBwcm90ZWN0aW9uKScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLmFjdGl2ZVRhc2s/LmlkLCAnVDAyJywgJ2FjdGl2ZVRhc2sgaXMgVDAyJyk7XG4gIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG59KTtcblxuLy8gKGMpIE5vIFJFUExBTi1UUklHR0VSLm1kLCBubyBibG9ja2VyIFx1MjE5MiBleGVjdXRpbmcgKG5vIGZhbHNlIHBvc2l0aXZlKVxudGVzdCgnZGVyaXZlU3RhdGU6IG5vIFJFUExBTi1UUklHR0VSLm1kLCBubyBibG9ja2VyIFx1MjE5MiBleGVjdXRpbmcgKCMxNzAxKScsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gIHdyaXRlUm9hZG1hcChiYXNlLCAnTTAwMScsIFJPQURNQVBfT05FX1NMSUNFKTtcbiAgd3JpdGVQbGFuKGJhc2UsICdNMDAxJywgJ1MwMScsIG1ha2VQbGFuVDAxRG9uZVQwMlBlbmRpbmcoKSk7XG4gIHdyaXRlVGFza1N1bW1hcnkoYmFzZSwgJ00wMDEnLCAnUzAxJywgJ1QwMScsIG1ha2VUYXNrU3VtbWFyeSgnVDAxJywgZmFsc2UpKTtcblxuICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHN0YXRlLnBoYXNlLCAnZXhlY3V0aW5nJywgJ3BoYXNlIGlzIGV4ZWN1dGluZyB3aGVuIG5vIHRyaWdnZXIgYW5kIG5vIGJsb2NrZXInKTtcbiAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbn0pO1xuXG4vLyAoZCkgYmxvY2tlcl9kaXNjb3ZlcmVkIHRha2VzIHByaW9yaXR5IG92ZXIgUkVQTEFOLVRSSUdHRVIubWRcbnRlc3QoJ2Rlcml2ZVN0YXRlOiBibG9ja2VyX2Rpc2NvdmVyZWQgdGFrZXMgcHJpb3JpdHkgb3ZlciBSRVBMQU4tVFJJR0dFUi5tZCAoIzE3MDEpJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgd3JpdGVSb2FkbWFwKGJhc2UsICdNMDAxJywgUk9BRE1BUF9PTkVfU0xJQ0UpO1xuICB3cml0ZVBsYW4oYmFzZSwgJ00wMDEnLCAnUzAxJywgbWFrZVBsYW5UMDFEb25lVDAyUGVuZGluZygpKTtcbiAgd3JpdGVUYXNrU3VtbWFyeShiYXNlLCAnTTAwMScsICdTMDEnLCAnVDAxJywgbWFrZVRhc2tTdW1tYXJ5KCdUMDEnLCB0cnVlKSk7XG4gIHdyaXRlUmVwbGFuVHJpZ2dlcihiYXNlLCAnTTAwMScsICdTMDEnLCAnIyBSZXBsYW4gVHJpZ2dlclxcblxcbioqU291cmNlOioqIENhcHR1cmUgQzAwMVxcbicpO1xuXG4gIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc3RhdGUucGhhc2UsICdyZXBsYW5uaW5nLXNsaWNlJywgJ3BoYXNlIGlzIHJlcGxhbm5pbmctc2xpY2UnKTtcbiAgLy8gYmxvY2tlcl9kaXNjb3ZlcmVkIHBhdGggc2hvdWxkIGZpcmUgZmlyc3QgKGJsb2NrZXJUYXNrSWQgaXMgc2V0LCBzbyBSRVBMQU4tVFJJR0dFUiBjaGVjayBpcyBza2lwcGVkKVxuICBhc3NlcnQub2soc3RhdGUubmV4dEFjdGlvbi5pbmNsdWRlcygnVDAxJyksICduZXh0QWN0aW9uIG1lbnRpb25zIGJsb2NrZXIgdGFzayBUMDEgKGJsb2NrZXIgcGF0aCwgbm90IHRyaWdnZXIgcGF0aCknKTtcbiAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbn0pO1xuXG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsVUFBVSxZQUFZO0FBQy9CLE9BQU8sWUFBWTtBQUNuQixTQUFTLGFBQWEsV0FBVyxjQUFjLFFBQVEscUJBQXFCO0FBQzVFLFNBQVMsTUFBTSxlQUFlO0FBQzlCLFNBQVMsY0FBYztBQUN2QixTQUFTLHFCQUFxQjtBQUU5QixTQUFTLG9CQUFvQjtBQUM3QixTQUFTLG1CQUFtQjtBQUc1QixRQUFRLElBQUkscUNBQXFDO0FBRWpELE1BQU0sWUFBWSxRQUFRLGNBQWMsWUFBWSxHQUFHLENBQUM7QUFDeEQsTUFBTSxxQkFBcUIsS0FBSyxXQUFXLE1BQU0sU0FBUztBQU0xRCxTQUFTLHVCQUF1QixNQUFjLE9BQStCLENBQUMsR0FBVztBQUN2RixRQUFNLE9BQU8sS0FBSyxvQkFBb0IsR0FBRyxJQUFJLEtBQUs7QUFDbEQsTUFBSSxVQUFVLGFBQWEsTUFBTSxPQUFPO0FBQ3hDLGFBQVcsQ0FBQyxLQUFLLEtBQUssS0FBSyxPQUFPLFFBQVEsSUFBSSxHQUFHO0FBQy9DLGNBQVUsUUFBUSxXQUFXLEtBQUssR0FBRyxNQUFNLEtBQUs7QUFBQSxFQUNsRDtBQUNBLFNBQU8sUUFBUSxLQUFLO0FBQ3RCO0FBSUEsU0FB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
