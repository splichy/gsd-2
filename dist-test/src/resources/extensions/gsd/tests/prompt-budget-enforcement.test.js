import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildExecuteTaskPrompt, buildPlanSlicePrompt, inlineDependencySummaries } from "../auto-prompts.js";
import { computeBudgets, truncateAtSectionBoundary } from "../context-budget.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
function createFixtureBase() {
  return mkdtempSync(join(tmpdir(), "gsd-prompt-budget-test-"));
}
function cleanup(base) {
  rmSync(base, { recursive: true, force: true });
}
function setupDependencyFixture(base, mid, sid, deps, summaries) {
  const msDir = join(base, ".gsd", "milestones", mid);
  mkdirSync(msDir, { recursive: true });
  const depStr = deps.join(", ");
  const sliceLines = [
    `- [x] **${deps[0]}: Done dep** \`risk:low\` \`depends:[]\``,
    `- [ ] **${sid}: Current slice** \`risk:medium\` \`depends:[${depStr}]\``
  ];
  for (let i = 1; i < deps.length; i++) {
    sliceLines.unshift(`- [x] **${deps[i]}: Another dep** \`risk:low\` \`depends:[]\``);
  }
  const roadmapContent = [
    "# Roadmap",
    "",
    "## Slices",
    "",
    ...sliceLines
  ].join("\n");
  writeFileSync(join(msDir, `${mid}-ROADMAP.md`), roadmapContent);
  for (const [depId, content] of Object.entries(summaries)) {
    const sliceDir = join(msDir, "slices", depId);
    mkdirSync(sliceDir, { recursive: true });
    writeFileSync(join(sliceDir, `${depId}-SUMMARY.md`), content);
  }
  const targetSliceDir = join(msDir, "slices", sid);
  mkdirSync(targetSliceDir, { recursive: true });
}
describe("prompt-budget: inlineDependencySummaries truncation", () => {
  let base;
  beforeEach(() => {
    base = createFixtureBase();
  });
  afterEach(() => {
    cleanup(base);
  });
  it("passes through all content when budget is larger than total", async () => {
    const summaryContent = "### Results\n\nEverything works.\n\n### Forward Intelligence\n\nWatch out for X.";
    setupDependencyFixture(base, "M001", "S02", ["S01"], {
      S01: summaryContent
    });
    const result = await inlineDependencySummaries("M001", "S02", base, 1e5);
    assert.ok(result.includes("Everything works."), "should include full summary content");
    assert.ok(result.includes("Watch out for X."), "should include forward intelligence");
    assert.ok(!result.includes("[...truncated"), "should not have truncation marker");
  });
  it("truncates at section boundaries when budget is small", async () => {
    const sections = [];
    for (let i = 0; i < 10; i++) {
      sections.push(`### Section ${i}

${"Lorem ipsum dolor sit amet. ".repeat(50)}`);
    }
    const largeSummary = sections.join("\n\n");
    setupDependencyFixture(base, "M001", "S02", ["S01"], {
      S01: largeSummary
    });
    const result = await inlineDependencySummaries("M001", "S02", base, 500);
    assert.ok(result.includes("[...truncated"), "should have truncation marker when over budget");
    assert.ok(result.length <= 600, `result should be near budget limit, got ${result.length}`);
  });
  it("returns content unchanged when no budget is provided (backward compat)", async () => {
    const sections = [];
    for (let i = 0; i < 5; i++) {
      sections.push(`### Section ${i}

${"Content block. ".repeat(30)}`);
    }
    const largeSummary = sections.join("\n\n");
    setupDependencyFixture(base, "M001", "S02", ["S01"], {
      S01: largeSummary
    });
    const result = await inlineDependencySummaries("M001", "S02", base);
    assert.ok(!result.includes("[...truncated"), "should not truncate without budget");
    assert.ok(result.includes("Section 4"), "should include all sections");
  });
  it("handles multiple dependency summaries with truncation", async () => {
    const summary1 = "### S01 Results\n\nFirst dep done.\n\n### S01 Notes\n\nSome notes.";
    const summary2 = "### S02 Results\n\nSecond dep done.\n\n### S02 Notes\n\nMore notes.";
    setupDependencyFixture(base, "M001", "S03", ["S01", "S02"], {
      S01: summary1,
      S02: summary2
    });
    const fullResult = await inlineDependencySummaries("M001", "S03", base, 1e5);
    assert.ok(fullResult.includes("First dep done."), "should have S01 content");
    assert.ok(fullResult.includes("Second dep done."), "should have S02 content");
    const truncResult = await inlineDependencySummaries("M001", "S03", base, 200);
    assert.ok(truncResult.includes("[...truncated"), "should truncate when budget is small");
  });
  it("returns no-dependencies marker when slice has no deps", async () => {
    const msDir = join(base, ".gsd", "milestones", "M001");
    mkdirSync(msDir, { recursive: true });
    const roadmap = "# Roadmap\n\n## Slices\n\n- [ ] **S01: Solo** `risk:low` `depends:[]`\n";
    writeFileSync(join(msDir, "M001-ROADMAP.md"), roadmap);
    const result = await inlineDependencySummaries("M001", "S01", base, 1e3);
    assert.equal(result, "- (no dependencies)");
  });
  it("caps 12 cumulative dep summaries at the 32K summaryBudgetChars (#4435)", async () => {
    const depIds = Array.from({ length: 12 }, (_, i) => `S${String(i + 1).padStart(2, "0")}`);
    const section = (label) => `### ${label}

${"Lorem ipsum dolor sit amet. ".repeat(200)}`;
    const perSummary = [section("Results"), section("Key Decisions"), section("Forward Intelligence")].join("\n\n");
    const summaries = {};
    for (const id of depIds) summaries[id] = perSummary;
    setupDependencyFixture(base, "M001", "S13", depIds, summaries);
    const budget32K = computeBudgets(32e3).summaryBudgetChars;
    const result = await inlineDependencySummaries("M001", "S13", base, budget32K);
    assert.ok(result.length <= budget32K + 200, `result must fit within 32K summary budget, got ${result.length}`);
    assert.ok(result.includes("[...truncated"), "must emit the truncation marker when over budget");
    const unbounded = await inlineDependencySummaries("M001", "S13", base);
    assert.ok(unbounded.length > budget32K * 5, "unbounded call should blow past the 32K budget (regression baseline)");
  });
});
describe("prompt-budget: plan-slice template", () => {
  it("rendered plan-slice prompt includes executor context constraints", async () => {
    const base = createFixtureBase();
    try {
      setupDependencyFixture(base, "M001", "S01", ["S00"], { S00: "### Results\n\nDone." });
      const prompt = await buildPlanSlicePrompt("M001", "Milestone", "S01", "Current slice", base, "minimal", {
        sessionContextWindow: 128e3
      });
      assert.match(prompt, /Executor Context Constraints/);
      assert.match(prompt, /128K token/);
    } finally {
      cleanup(base);
    }
  });
});
describe("prompt-budget: executor constraints formatting", () => {
  it("128K window produces different constraints than 1M window", () => {
    const budget128K = computeBudgets(128e3);
    const budget1M = computeBudgets(1e6);
    assert.notEqual(
      budget128K.taskCountRange.max,
      budget1M.taskCountRange.max,
      "128K and 1M should have different max task counts"
    );
    assert.ok(
      budget1M.inlineContextBudgetChars > budget128K.inlineContextBudgetChars,
      "1M should have larger inline context budget than 128K"
    );
    const format = (b, windowTokens) => {
      const { min, max } = b.taskCountRange;
      const execWindowK = Math.round(windowTokens / 1e3);
      const perTaskBudgetK = Math.round(b.inlineContextBudgetChars / 1e3);
      return [
        `## Executor Context Constraints`,
        ``,
        `The agent that executes each task has a **${execWindowK}K token** context window.`,
        `- Recommended task count for this slice: **${min}\u2013${max} tasks**`,
        `- Each task gets ~${perTaskBudgetK}K chars of inline context (plans, code, decisions)`,
        `- Keep individual tasks completable within a single context window \u2014 if a task needs more context than fits, split it`
      ].join("\n");
    };
    const constraints128K = format(budget128K, 128e3);
    const constraints1M = format(budget1M, 1e6);
    assert.ok(constraints128K.includes("128K token"), "128K constraints should reference 128K");
    assert.ok(constraints1M.includes("1000K token"), "1M constraints should reference 1000K");
    assert.ok(constraints128K.includes("2\u20135 tasks"), "128K should recommend 2\u20135 tasks");
    assert.ok(constraints1M.includes("2\u20138 tasks"), "1M should recommend 2\u20138 tasks");
    assert.notEqual(constraints128K, constraints1M, "constraint blocks should differ");
  });
  it("undefined context window falls back to 200K defaults", () => {
    const budgetDefault = computeBudgets(0);
    const budget200K = computeBudgets(2e5);
    assert.equal(budgetDefault.summaryBudgetChars, budget200K.summaryBudgetChars);
    assert.equal(budgetDefault.inlineContextBudgetChars, budget200K.inlineContextBudgetChars);
    assert.equal(budgetDefault.taskCountRange.max, budget200K.taskCountRange.max);
  });
});
describe("prompt-budget: different context windows produce different outputs", () => {
  it("small window truncates content that large window preserves", () => {
    const sections = [];
    for (let i = 0; i < 20; i++) {
      sections.push(`### Section ${i}: Important Context

${"Detailed content for this section. ".repeat(100)}`);
    }
    const largeContent = `## Inlined Context

${sections.join("\n\n---\n\n")}`;
    const budget128K = computeBudgets(128e3);
    const r128K = truncateAtSectionBoundary(largeContent, budget128K.inlineContextBudgetChars);
    const budget1M = computeBudgets(1e6);
    const r1M = truncateAtSectionBoundary(largeContent, budget1M.inlineContextBudgetChars);
    assert.ok(
      r128K.content.length <= budget128K.inlineContextBudgetChars + 100,
      // +100 for truncation marker
      "128K result should respect budget"
    );
    assert.ok(
      r1M.content.length <= budget1M.inlineContextBudgetChars + 100,
      "1M result should respect budget"
    );
    const smallContent = "### One Section\n\nSmall content.";
    const small128K = truncateAtSectionBoundary(smallContent, budget128K.inlineContextBudgetChars);
    const small1M = truncateAtSectionBoundary(smallContent, budget1M.inlineContextBudgetChars);
    assert.equal(small128K.content, smallContent, "small content unchanged for 128K");
    assert.equal(small128K.droppedSections, 0);
    assert.equal(small1M.content, smallContent, "small content unchanged for 1M");
    assert.equal(small1M.droppedSections, 0);
  });
  it("128K budget truncates very large content while 1M preserves it", () => {
    const sections = [];
    for (let i = 0; i < 100; i++) {
      sections.push(`### Section ${i}

${"X".repeat(3e3)}`);
    }
    const content = sections.join("\n\n");
    const budget128K = computeBudgets(128e3);
    const result128K = truncateAtSectionBoundary(content, budget128K.inlineContextBudgetChars);
    const budget1M = computeBudgets(1e6);
    const result1M = truncateAtSectionBoundary(content, budget1M.inlineContextBudgetChars);
    assert.ok(result128K.content.includes("[...truncated"), "128K should truncate ~310K content");
    assert.ok(result128K.droppedSections > 0, "128K should report dropped sections");
    assert.ok(!result1M.content.includes("[...truncated"), "1M should preserve ~310K content");
    assert.equal(result1M.droppedSections, 0);
    assert.ok(result128K.content.length < result1M.content.length, "128K result should be shorter than 1M result");
  });
});
describe("prompt-budget: execute-task template", () => {
  it("rendered execute-task prompt includes verification budget", async () => {
    const base = createFixtureBase();
    try {
      const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
      const taskDir = join(sliceDir, "tasks");
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# Roadmap\n");
      writeFileSync(join(sliceDir, "S01-PLAN.md"), "# Slice Plan\n");
      writeFileSync(join(taskDir, "T01-PLAN.md"), "# Task Plan\n");
      const prompt = await buildExecuteTaskPrompt("M001", "S01", "Slice", "T01", "Task", base, {
        level: "minimal",
        sessionContextWindow: 128e3
      });
      assert.match(prompt, /verification/i);
      assert.match(prompt, /~51K chars/);
    } finally {
      cleanup(base);
    }
  });
  it("verificationBudget format varies with context window size", () => {
    const budget128K = computeBudgets(128e3);
    const budget1M = computeBudgets(1e6);
    const format128K = `~${Math.round(budget128K.verificationBudgetChars / 1e3)}K chars`;
    const format1M = `~${Math.round(budget1M.verificationBudgetChars / 1e3)}K chars`;
    assert.notEqual(format128K, format1M, "128K and 1M should produce different verification budget strings");
    assert.ok(format128K.includes("~51K"), `128K should produce ~51K, got ${format128K}`);
    assert.ok(format1M.includes("~400K"), `1M should produce ~400K, got ${format1M}`);
  });
});
describe("prompt-budget: complete-slice builder truncation pattern", () => {
  it("truncateAtSectionBoundary truncates assembled inlinedContext for complete-slice pattern", () => {
    const inlined = [];
    inlined.push("### Milestone Roadmap\n\nRoadmap content here.");
    inlined.push("### Slice Plan\n\nSlice plan content here.");
    for (let i = 0; i < 50; i++) {
      inlined.push(`### Task Summary: T${String(i).padStart(2, "0")}
Source: \`tasks/T${String(i).padStart(2, "0")}-SUMMARY.md\`

${"Task result details. ".repeat(200)}`);
    }
    const assembledContent = `## Inlined Context (preloaded \u2014 do not re-read these files)

${inlined.join("\n\n---\n\n")}`;
    const budget128K = computeBudgets(128e3);
    const result128K = truncateAtSectionBoundary(assembledContent, budget128K.inlineContextBudgetChars);
    assert.ok(result128K.content.includes("[...truncated"), "128K should truncate many task summaries");
    assert.ok(result128K.content.includes("### Milestone Roadmap"), "should preserve early sections");
    assert.ok(result128K.droppedSections > 0, "128K should report dropped sections");
    const budget1M = computeBudgets(1e6);
    const result1M = truncateAtSectionBoundary(assembledContent, budget1M.inlineContextBudgetChars);
    assert.ok(!result1M.content.includes("[...truncated"), "1M should preserve all task summaries");
    assert.equal(result1M.droppedSections, 0);
  });
  it("small content passes through unchanged at any context window size", () => {
    const smallContent = "## Inlined Context\n\n### Roadmap\n\nSmall roadmap.\n\n---\n\n### Plan\n\nSmall plan.";
    const budget128K = computeBudgets(128e3);
    const result128K = truncateAtSectionBoundary(smallContent, budget128K.inlineContextBudgetChars);
    assert.equal(result128K.content, smallContent, "small content unchanged for 128K");
    assert.equal(result128K.droppedSections, 0);
    const budget1M = computeBudgets(1e6);
    const result1M = truncateAtSectionBoundary(smallContent, budget1M.inlineContextBudgetChars);
    assert.equal(result1M.content, smallContent, "small content unchanged for 1M");
    assert.equal(result1M.droppedSections, 0);
  });
});
describe("prompt-budget: complete-milestone builder truncation pattern", () => {
  it("truncateAtSectionBoundary truncates assembled inlinedContext for complete-milestone pattern", () => {
    const inlined = [];
    inlined.push("### Milestone Roadmap\n\nRoadmap content here.");
    for (let i = 0; i < 30; i++) {
      inlined.push(`### S${String(i).padStart(2, "0")} Summary

${"Slice summary with detailed results and forward intelligence. ".repeat(200)}`);
    }
    inlined.push("### Requirements\n\nProject requirements.");
    inlined.push("### Decisions\n\nProject decisions.");
    const assembledContent = `## Inlined Context (preloaded \u2014 do not re-read these files)

${inlined.join("\n\n---\n\n")}`;
    const budget128K = computeBudgets(128e3);
    const result128K = truncateAtSectionBoundary(assembledContent, budget128K.inlineContextBudgetChars);
    assert.ok(result128K.content.includes("[...truncated"), "128K should truncate many slice summaries");
    assert.ok(result128K.droppedSections > 0);
    const budget1M = computeBudgets(1e6);
    const result1M = truncateAtSectionBoundary(assembledContent, budget1M.inlineContextBudgetChars);
    assert.ok(!result1M.content.includes("[...truncated"), "1M should preserve all slice summaries");
    assert.equal(result1M.droppedSections, 0);
  });
  it("different context windows produce different truncation for milestone completion", () => {
    const inlined = [];
    inlined.push("### Roadmap\n\nRoadmap.");
    for (let i = 0; i < 15; i++) {
      inlined.push(`### S${i} Summary

${"X".repeat(15e3)}`);
    }
    const content = `## Inlined Context

${inlined.join("\n\n---\n\n")}`;
    const budget128K = computeBudgets(128e3);
    const budget200K = computeBudgets(2e5);
    const budget1M = computeBudgets(1e6);
    const result128K = truncateAtSectionBoundary(content, budget128K.inlineContextBudgetChars);
    const result200K = truncateAtSectionBoundary(content, budget200K.inlineContextBudgetChars);
    const result1M = truncateAtSectionBoundary(content, budget1M.inlineContextBudgetChars);
    assert.ok(result128K.content.includes("[...truncated"), "128K should truncate ~225K content");
    assert.ok(result128K.droppedSections > 0);
    assert.ok(!result200K.content.includes("[...truncated"), "200K should preserve ~225K content");
    assert.equal(result200K.droppedSections, 0);
    assert.ok(!result1M.content.includes("[...truncated"), "1M should preserve ~225K content");
    assert.equal(result1M.droppedSections, 0);
    assert.ok(result128K.content.length < result200K.content.length, "128K result should be shorter than 200K");
  });
});
describe("prompt-budget: execute-task builder truncation pattern", () => {
  it("truncateAtSectionBoundary truncates assembled carry-forward + task plan + slice excerpt", () => {
    const carryForward = "## Carry-Forward Context\n" + Array.from(
      { length: 20 },
      (_, i) => `- \`tasks/T${String(i).padStart(2, "0")}-SUMMARY.md\` \u2014 ${"Summary details. ".repeat(100)}`
    ).join("\n");
    const taskPlan = "## Inlined Task Plan\n\n" + Array.from(
      { length: 10 },
      (_, i) => `### Step ${i}

${"Implementation step details. ".repeat(200)}`
    ).join("\n\n");
    const sliceExcerpt = "## Slice Plan Excerpt\n\n" + "Slice goal and verification details. ".repeat(100);
    const assembled = [carryForward, taskPlan, sliceExcerpt].join("\n\n---\n\n");
    const budget128K = computeBudgets(128e3);
    const result = truncateAtSectionBoundary(assembled, budget128K.inlineContextBudgetChars);
    assert.ok(
      result.content.length <= budget128K.inlineContextBudgetChars + 100,
      `result should respect 128K budget, got ${result.content.length} chars vs budget ${budget128K.inlineContextBudgetChars}`
    );
    if (assembled.length > budget128K.inlineContextBudgetChars) {
      assert.ok(result.content.includes("[...truncated"), "should truncate when content exceeds 128K budget");
      assert.ok(result.droppedSections > 0, "should report dropped sections");
    }
  });
});
describe("prompt-budget: modelRegistry + sessionContextWindow behavior", () => {
  it("buildPlanSlicePrompt output changes when sessionContextWindow changes", async () => {
    const base = createFixtureBase();
    try {
      setupDependencyFixture(base, "M001", "S01", ["S00"], { S00: "### Results\n\nDone." });
      const small = await buildPlanSlicePrompt("M001", "Milestone", "S01", "Current slice", base, "minimal", {
        sessionContextWindow: 128e3
      });
      const large = await buildPlanSlicePrompt("M001", "Milestone", "S01", "Current slice", base, "minimal", {
        sessionContextWindow: 1e6
      });
      assert.match(small, /128K token/);
      assert.match(large, /1000K token/);
      assert.notEqual(small, large);
    } finally {
      cleanup(base);
    }
  });
  it("buildExecuteTaskPrompt output changes when sessionContextWindow changes", async () => {
    const base = createFixtureBase();
    try {
      const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
      const taskDir = join(sliceDir, "tasks");
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# Roadmap\n");
      writeFileSync(join(sliceDir, "S01-PLAN.md"), "# Slice Plan\n");
      writeFileSync(join(taskDir, "T01-PLAN.md"), "# Task Plan\n");
      const small = await buildExecuteTaskPrompt("M001", "S01", "Slice", "T01", "Task", base, {
        level: "minimal",
        sessionContextWindow: 128e3
      });
      const large = await buildExecuteTaskPrompt("M001", "S01", "Slice", "T01", "Task", base, {
        level: "minimal",
        sessionContextWindow: 1e6
      });
      assert.match(small, /~51K chars/);
      assert.match(large, /~400K chars/);
      assert.notEqual(small, large);
    } finally {
      cleanup(base);
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wcm9tcHQtYnVkZ2V0LWVuZm9yY2VtZW50LnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogUHJvbXB0IGJ1ZGdldCBlbmZvcmNlbWVudCB0ZXN0cyBcdTIwMTQgdmVyaWZpZXMgdGhhdCBidWRnZXQtYXdhcmUgcHJvbXB0IGJ1aWxkZXJzXG4gKiB0cnVuY2F0ZSBjb250ZW50IGF0IHNlY3Rpb24gYm91bmRhcmllcywgdGhhdCBwbGFuLXNsaWNlIGluY2x1ZGVzIGV4ZWN1dG9yXG4gKiBjb250ZXh0IGNvbnN0cmFpbnRzLCBhbmQgdGhhdCBwcm9tcHQgYnVpbGRlcnMgdGhyZWFkIHRoZSByZWFsIGV4ZWN1dG9yXG4gKiBjb250ZXh0IHdpbmRvdyB0aHJvdWdoIHRvIHRoZSBidWRnZXQgZW5naW5lIChpc3N1ZSAjNDE0MikuXG4gKi9cblxuaW1wb3J0IHsgZGVzY3JpYmUsIGl0LCBiZWZvcmVFYWNoLCBhZnRlckVhY2ggfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBta2RpclN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luLCBkaXJuYW1lIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcblxuaW1wb3J0IHsgYnVpbGRFeGVjdXRlVGFza1Byb21wdCwgYnVpbGRQbGFuU2xpY2VQcm9tcHQsIGlubGluZURlcGVuZGVuY3lTdW1tYXJpZXMgfSBmcm9tIFwiLi4vYXV0by1wcm9tcHRzLmpzXCI7XG5pbXBvcnQgeyBjb21wdXRlQnVkZ2V0cywgdHJ1bmNhdGVBdFNlY3Rpb25Cb3VuZGFyeSB9IGZyb20gXCIuLi9jb250ZXh0LWJ1ZGdldC5qc1wiO1xuXG5jb25zdCBfX2Rpcm5hbWUgPSBkaXJuYW1lKGZpbGVVUkxUb1BhdGgoaW1wb3J0Lm1ldGEudXJsKSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBGaXh0dXJlIGhlbHBlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIGNyZWF0ZUZpeHR1cmVCYXNlKCk6IHN0cmluZyB7XG4gIHJldHVybiBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1wcm9tcHQtYnVkZ2V0LXRlc3QtXCIpKTtcbn1cblxuZnVuY3Rpb24gY2xlYW51cChiYXNlOiBzdHJpbmcpOiB2b2lkIHtcbiAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbn1cblxuLyoqXG4gKiBTZXQgdXAgYSBtaW5pbWFsIG1pbGVzdG9uZSB3aXRoIGEgcm9hZG1hcCBkZWNsYXJpbmcgc2xpY2UgZGVwZW5kZW5jaWVzIGFuZFxuICogZGVwZW5kZW5jeSBzbGljZSBzdW1tYXJpZXMgb24gZGlzay5cbiAqL1xuZnVuY3Rpb24gc2V0dXBEZXBlbmRlbmN5Rml4dHVyZShcbiAgYmFzZTogc3RyaW5nLFxuICBtaWQ6IHN0cmluZyxcbiAgc2lkOiBzdHJpbmcsXG4gIGRlcHM6IHN0cmluZ1tdLFxuICBzdW1tYXJpZXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXG4pOiB2b2lkIHtcbiAgY29uc3QgbXNEaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgbWlkKTtcbiAgbWtkaXJTeW5jKG1zRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAvLyBCdWlsZCByb2FkbWFwIGNvbnRlbnQgXHUyMDE0IHNpZCBkZXBlbmRzIG9uIGRlcHNcbiAgY29uc3QgZGVwU3RyID0gZGVwcy5qb2luKFwiLCBcIik7XG4gIGNvbnN0IHNsaWNlTGluZXMgPSBbXG4gICAgYC0gW3hdICoqJHtkZXBzWzBdfTogRG9uZSBkZXAqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgYCxcbiAgICBgLSBbIF0gKioke3NpZH06IEN1cnJlbnQgc2xpY2UqKiBcXGByaXNrOm1lZGl1bVxcYCBcXGBkZXBlbmRzOlske2RlcFN0cn1dXFxgYCxcbiAgXTtcbiAgLy8gQWRkIGFueSBleHRyYSBkZXBzIGFzIGNvbXBsZXRlZCBzbGljZXNcbiAgZm9yIChsZXQgaSA9IDE7IGkgPCBkZXBzLmxlbmd0aDsgaSsrKSB7XG4gICAgc2xpY2VMaW5lcy51bnNoaWZ0KGAtIFt4XSAqKiR7ZGVwc1tpXX06IEFub3RoZXIgZGVwKiogXFxgcmlzazpsb3dcXGAgXFxgZGVwZW5kczpbXVxcYGApO1xuICB9XG4gIGNvbnN0IHJvYWRtYXBDb250ZW50ID0gW1xuICAgIFwiIyBSb2FkbWFwXCIsXG4gICAgXCJcIixcbiAgICBcIiMjIFNsaWNlc1wiLFxuICAgIFwiXCIsXG4gICAgLi4uc2xpY2VMaW5lcyxcbiAgXS5qb2luKFwiXFxuXCIpO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4obXNEaXIsIGAke21pZH0tUk9BRE1BUC5tZGApLCByb2FkbWFwQ29udGVudCk7XG5cbiAgLy8gV3JpdGUgZGVwZW5kZW5jeSBzbGljZSBzdW1tYXJpZXNcbiAgZm9yIChjb25zdCBbZGVwSWQsIGNvbnRlbnRdIG9mIE9iamVjdC5lbnRyaWVzKHN1bW1hcmllcykpIHtcbiAgICBjb25zdCBzbGljZURpciA9IGpvaW4obXNEaXIsIFwic2xpY2VzXCIsIGRlcElkKTtcbiAgICBta2RpclN5bmMoc2xpY2VEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihzbGljZURpciwgYCR7ZGVwSWR9LVNVTU1BUlkubWRgKSwgY29udGVudCk7XG4gIH1cblxuICAvLyBFbnN1cmUgdGFyZ2V0IHNsaWNlIGRpciBleGlzdHNcbiAgY29uc3QgdGFyZ2V0U2xpY2VEaXIgPSBqb2luKG1zRGlyLCBcInNsaWNlc1wiLCBzaWQpO1xuICBta2RpclN5bmModGFyZ2V0U2xpY2VEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgaW5saW5lRGVwZW5kZW5jeVN1bW1hcmllcyB0cnVuY2F0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcInByb21wdC1idWRnZXQ6IGlubGluZURlcGVuZGVuY3lTdW1tYXJpZXMgdHJ1bmNhdGlvblwiLCAoKSA9PiB7XG4gIGxldCBiYXNlOiBzdHJpbmc7XG5cbiAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gIH0pO1xuXG4gIGFmdGVyRWFjaCgoKSA9PiB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfSk7XG5cbiAgaXQoXCJwYXNzZXMgdGhyb3VnaCBhbGwgY29udGVudCB3aGVuIGJ1ZGdldCBpcyBsYXJnZXIgdGhhbiB0b3RhbFwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3Qgc3VtbWFyeUNvbnRlbnQgPSBcIiMjIyBSZXN1bHRzXFxuXFxuRXZlcnl0aGluZyB3b3Jrcy5cXG5cXG4jIyMgRm9yd2FyZCBJbnRlbGxpZ2VuY2VcXG5cXG5XYXRjaCBvdXQgZm9yIFguXCI7XG4gICAgc2V0dXBEZXBlbmRlbmN5Rml4dHVyZShiYXNlLCBcIk0wMDFcIiwgXCJTMDJcIiwgW1wiUzAxXCJdLCB7XG4gICAgICBTMDE6IHN1bW1hcnlDb250ZW50LFxuICAgIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaW5saW5lRGVwZW5kZW5jeVN1bW1hcmllcyhcIk0wMDFcIiwgXCJTMDJcIiwgYmFzZSwgMTAwXzAwMCk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcyhcIkV2ZXJ5dGhpbmcgd29ya3MuXCIpLCBcInNob3VsZCBpbmNsdWRlIGZ1bGwgc3VtbWFyeSBjb250ZW50XCIpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoXCJXYXRjaCBvdXQgZm9yIFguXCIpLCBcInNob3VsZCBpbmNsdWRlIGZvcndhcmQgaW50ZWxsaWdlbmNlXCIpO1xuICAgIGFzc2VydC5vayghcmVzdWx0LmluY2x1ZGVzKFwiWy4uLnRydW5jYXRlZFwiKSwgXCJzaG91bGQgbm90IGhhdmUgdHJ1bmNhdGlvbiBtYXJrZXJcIik7XG4gIH0pO1xuXG4gIGl0KFwidHJ1bmNhdGVzIGF0IHNlY3Rpb24gYm91bmRhcmllcyB3aGVuIGJ1ZGdldCBpcyBzbWFsbFwiLCBhc3luYyAoKSA9PiB7XG4gICAgLy8gQ3JlYXRlIGEgbGFyZ2Ugc3VtbWFyeSB3aXRoIG11bHRpcGxlIHNlY3Rpb25zXG4gICAgY29uc3Qgc2VjdGlvbnMgPSBbXTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IDEwOyBpKyspIHtcbiAgICAgIHNlY3Rpb25zLnB1c2goYCMjIyBTZWN0aW9uICR7aX1cXG5cXG4ke1wiTG9yZW0gaXBzdW0gZG9sb3Igc2l0IGFtZXQuIFwiLnJlcGVhdCg1MCl9YCk7XG4gICAgfVxuICAgIGNvbnN0IGxhcmdlU3VtbWFyeSA9IHNlY3Rpb25zLmpvaW4oXCJcXG5cXG5cIik7XG5cbiAgICBzZXR1cERlcGVuZGVuY3lGaXh0dXJlKGJhc2UsIFwiTTAwMVwiLCBcIlMwMlwiLCBbXCJTMDFcIl0sIHtcbiAgICAgIFMwMTogbGFyZ2VTdW1tYXJ5LFxuICAgIH0pO1xuXG4gICAgLy8gVXNlIGEgYnVkZ2V0IHNtYWxsZXIgdGhhbiB0b3RhbCBjb250ZW50XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaW5saW5lRGVwZW5kZW5jeVN1bW1hcmllcyhcIk0wMDFcIiwgXCJTMDJcIiwgYmFzZSwgNTAwKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKFwiWy4uLnRydW5jYXRlZFwiKSwgXCJzaG91bGQgaGF2ZSB0cnVuY2F0aW9uIG1hcmtlciB3aGVuIG92ZXIgYnVkZ2V0XCIpO1xuICAgIGFzc2VydC5vayhyZXN1bHQubGVuZ3RoIDw9IDYwMCwgYHJlc3VsdCBzaG91bGQgYmUgbmVhciBidWRnZXQgbGltaXQsIGdvdCAke3Jlc3VsdC5sZW5ndGh9YCk7XG4gIH0pO1xuXG4gIGl0KFwicmV0dXJucyBjb250ZW50IHVuY2hhbmdlZCB3aGVuIG5vIGJ1ZGdldCBpcyBwcm92aWRlZCAoYmFja3dhcmQgY29tcGF0KVwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3Qgc2VjdGlvbnMgPSBbXTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IDU7IGkrKykge1xuICAgICAgc2VjdGlvbnMucHVzaChgIyMjIFNlY3Rpb24gJHtpfVxcblxcbiR7XCJDb250ZW50IGJsb2NrLiBcIi5yZXBlYXQoMzApfWApO1xuICAgIH1cbiAgICBjb25zdCBsYXJnZVN1bW1hcnkgPSBzZWN0aW9ucy5qb2luKFwiXFxuXFxuXCIpO1xuXG4gICAgc2V0dXBEZXBlbmRlbmN5Rml4dHVyZShiYXNlLCBcIk0wMDFcIiwgXCJTMDJcIiwgW1wiUzAxXCJdLCB7XG4gICAgICBTMDE6IGxhcmdlU3VtbWFyeSxcbiAgICB9KTtcblxuICAgIC8vIE5vIGJ1ZGdldCBwYXJhbWV0ZXIgXHUyMDE0IGJhY2t3YXJkLWNvbXBhdGlibGUgYmVoYXZpb3JcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBpbmxpbmVEZXBlbmRlbmN5U3VtbWFyaWVzKFwiTTAwMVwiLCBcIlMwMlwiLCBiYXNlKTtcbiAgICBhc3NlcnQub2soIXJlc3VsdC5pbmNsdWRlcyhcIlsuLi50cnVuY2F0ZWRcIiksIFwic2hvdWxkIG5vdCB0cnVuY2F0ZSB3aXRob3V0IGJ1ZGdldFwiKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKFwiU2VjdGlvbiA0XCIpLCBcInNob3VsZCBpbmNsdWRlIGFsbCBzZWN0aW9uc1wiKTtcbiAgfSk7XG5cbiAgaXQoXCJoYW5kbGVzIG11bHRpcGxlIGRlcGVuZGVuY3kgc3VtbWFyaWVzIHdpdGggdHJ1bmNhdGlvblwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3Qgc3VtbWFyeTEgPSBcIiMjIyBTMDEgUmVzdWx0c1xcblxcbkZpcnN0IGRlcCBkb25lLlxcblxcbiMjIyBTMDEgTm90ZXNcXG5cXG5Tb21lIG5vdGVzLlwiO1xuICAgIGNvbnN0IHN1bW1hcnkyID0gXCIjIyMgUzAyIFJlc3VsdHNcXG5cXG5TZWNvbmQgZGVwIGRvbmUuXFxuXFxuIyMjIFMwMiBOb3Rlc1xcblxcbk1vcmUgbm90ZXMuXCI7XG4gICAgc2V0dXBEZXBlbmRlbmN5Rml4dHVyZShiYXNlLCBcIk0wMDFcIiwgXCJTMDNcIiwgW1wiUzAxXCIsIFwiUzAyXCJdLCB7XG4gICAgICBTMDE6IHN1bW1hcnkxLFxuICAgICAgUzAyOiBzdW1tYXJ5MixcbiAgICB9KTtcblxuICAgIC8vIEJ1ZGdldCBsYXJnZSBlbm91Z2ggZm9yIGFsbCBjb250ZW50XG4gICAgY29uc3QgZnVsbFJlc3VsdCA9IGF3YWl0IGlubGluZURlcGVuZGVuY3lTdW1tYXJpZXMoXCJNMDAxXCIsIFwiUzAzXCIsIGJhc2UsIDEwMF8wMDApO1xuICAgIGFzc2VydC5vayhmdWxsUmVzdWx0LmluY2x1ZGVzKFwiRmlyc3QgZGVwIGRvbmUuXCIpLCBcInNob3VsZCBoYXZlIFMwMSBjb250ZW50XCIpO1xuICAgIGFzc2VydC5vayhmdWxsUmVzdWx0LmluY2x1ZGVzKFwiU2Vjb25kIGRlcCBkb25lLlwiKSwgXCJzaG91bGQgaGF2ZSBTMDIgY29udGVudFwiKTtcblxuICAgIC8vIEJ1ZGdldCB0b28gc21hbGwgZm9yIGFsbFxuICAgIGNvbnN0IHRydW5jUmVzdWx0ID0gYXdhaXQgaW5saW5lRGVwZW5kZW5jeVN1bW1hcmllcyhcIk0wMDFcIiwgXCJTMDNcIiwgYmFzZSwgMjAwKTtcbiAgICBhc3NlcnQub2sodHJ1bmNSZXN1bHQuaW5jbHVkZXMoXCJbLi4udHJ1bmNhdGVkXCIpLCBcInNob3VsZCB0cnVuY2F0ZSB3aGVuIGJ1ZGdldCBpcyBzbWFsbFwiKTtcbiAgfSk7XG5cbiAgaXQoXCJyZXR1cm5zIG5vLWRlcGVuZGVuY2llcyBtYXJrZXIgd2hlbiBzbGljZSBoYXMgbm8gZGVwc1wiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgbXNEaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIpO1xuICAgIG1rZGlyU3luYyhtc0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgY29uc3Qgcm9hZG1hcCA9IFwiIyBSb2FkbWFwXFxuXFxuIyMgU2xpY2VzXFxuXFxuLSBbIF0gKipTMDE6IFNvbG8qKiBgcmlzazpsb3dgIGBkZXBlbmRzOltdYFxcblwiO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihtc0RpciwgXCJNMDAxLVJPQURNQVAubWRcIiksIHJvYWRtYXApO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaW5saW5lRGVwZW5kZW5jeVN1bW1hcmllcyhcIk0wMDFcIiwgXCJTMDFcIiwgYmFzZSwgMTAwMCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgXCItIChubyBkZXBlbmRlbmNpZXMpXCIpO1xuICB9KTtcblxuICAvLyBSZWdyZXNzaW9uIGZvciBpc3N1ZSAjNDQzNTogYSBzbGljZSB3aXRoIDEyIGRlY2xhcmVkIGRlcGVuZGVuY2llcyBvbiBhXG4gIC8vIHNtYWxsLXdpbmRvdyAoMzJLKSBtb2RlbCBzaG91bGQgbm90IGluamVjdCB0aGUgZnVsbCBjb25jYXRlbmF0ZWQgNTUtNzBLXG4gIC8vIGNoYXJzIG9mIGRlcCBzdW1tYXJpZXMuIEV4ZXJjaXNlcyB0aGUgYnVkZ2V0IHRoZSBidWlsZGVycyBub3cgcGFzcyBpblxuICAvLyAoY29tcHV0ZUJ1ZGdldHMoMzIwMDApLnN1bW1hcnlCdWRnZXRDaGFycyBcdTIyNDggMTlfMjAwIGNoYXJzKS5cbiAgaXQoXCJjYXBzIDEyIGN1bXVsYXRpdmUgZGVwIHN1bW1hcmllcyBhdCB0aGUgMzJLIHN1bW1hcnlCdWRnZXRDaGFycyAoIzQ0MzUpXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBkZXBJZHMgPSBBcnJheS5mcm9tKHsgbGVuZ3RoOiAxMiB9LCAoXywgaSkgPT4gYFMke1N0cmluZyhpICsgMSkucGFkU3RhcnQoMiwgXCIwXCIpfWApO1xuICAgIGNvbnN0IHNlY3Rpb24gPSAobGFiZWw6IHN0cmluZykgPT4gYCMjIyAke2xhYmVsfVxcblxcbiR7XCJMb3JlbSBpcHN1bSBkb2xvciBzaXQgYW1ldC4gXCIucmVwZWF0KDIwMCl9YDtcbiAgICBjb25zdCBwZXJTdW1tYXJ5ID0gW3NlY3Rpb24oXCJSZXN1bHRzXCIpLCBzZWN0aW9uKFwiS2V5IERlY2lzaW9uc1wiKSwgc2VjdGlvbihcIkZvcndhcmQgSW50ZWxsaWdlbmNlXCIpXS5qb2luKFwiXFxuXFxuXCIpO1xuICAgIGNvbnN0IHN1bW1hcmllczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICAgIGZvciAoY29uc3QgaWQgb2YgZGVwSWRzKSBzdW1tYXJpZXNbaWRdID0gcGVyU3VtbWFyeTtcblxuICAgIHNldHVwRGVwZW5kZW5jeUZpeHR1cmUoYmFzZSwgXCJNMDAxXCIsIFwiUzEzXCIsIGRlcElkcywgc3VtbWFyaWVzKTtcblxuICAgIGNvbnN0IGJ1ZGdldDMySyA9IGNvbXB1dGVCdWRnZXRzKDMyXzAwMCkuc3VtbWFyeUJ1ZGdldENoYXJzO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGlubGluZURlcGVuZGVuY3lTdW1tYXJpZXMoXCJNMDAxXCIsIFwiUzEzXCIsIGJhc2UsIGJ1ZGdldDMySyk7XG5cbiAgICAvLyBUaGUgdG90YWwgcmF3IGNvbnRlbnQgd291bGQgYmUgMTIgXHUwMEQ3IH4xN0sgY2hhcnMgXHUyMjQ4IDIwMEsgY2hhcnMuIEJ1ZGdldCBhdFxuICAgIC8vIDMySyBpcyB+MTkuMksgY2hhcnMuIFRoZSByZXN1bHQgbXVzdCBiZSBib3VuZGVkIGFuZCB0aGUgb3ZlcmZsb3cgbWFya2VyXG4gICAgLy8gbXVzdCBiZSBwcmVzZW50LlxuICAgIGFzc2VydC5vayhyZXN1bHQubGVuZ3RoIDw9IGJ1ZGdldDMySyArIDIwMCwgYHJlc3VsdCBtdXN0IGZpdCB3aXRoaW4gMzJLIHN1bW1hcnkgYnVkZ2V0LCBnb3QgJHtyZXN1bHQubGVuZ3RofWApO1xuICAgIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoXCJbLi4udHJ1bmNhdGVkXCIpLCBcIm11c3QgZW1pdCB0aGUgdHJ1bmNhdGlvbiBtYXJrZXIgd2hlbiBvdmVyIGJ1ZGdldFwiKTtcblxuICAgIC8vIFVuYm91bmRlZCBjYWxsIHJldHVybnMgdGhlIGZ1bGwgfjIwMEsgXHUyMDE0IGNvbmZpcm1zIHRoaXMgaXMgdGhlIHJlZ3Jlc3Npb24gc3VyZmFjZS5cbiAgICBjb25zdCB1bmJvdW5kZWQgPSBhd2FpdCBpbmxpbmVEZXBlbmRlbmN5U3VtbWFyaWVzKFwiTTAwMVwiLCBcIlMxM1wiLCBiYXNlKTtcbiAgICBhc3NlcnQub2sodW5ib3VuZGVkLmxlbmd0aCA+IGJ1ZGdldDMySyAqIDUsIFwidW5ib3VuZGVkIGNhbGwgc2hvdWxkIGJsb3cgcGFzdCB0aGUgMzJLIGJ1ZGdldCAocmVncmVzc2lvbiBiYXNlbGluZSlcIik7XG4gIH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBwbGFuLXNsaWNlIHRlbXBsYXRlIGluY2x1ZGVzIGV4ZWN1dG9yIGNvbnN0cmFpbnRzIHBsYWNlaG9sZGVyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcInByb21wdC1idWRnZXQ6IHBsYW4tc2xpY2UgdGVtcGxhdGVcIiwgKCkgPT4ge1xuICBpdChcInJlbmRlcmVkIHBsYW4tc2xpY2UgcHJvbXB0IGluY2x1ZGVzIGV4ZWN1dG9yIGNvbnRleHQgY29uc3RyYWludHNcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBzZXR1cERlcGVuZGVuY3lGaXh0dXJlKGJhc2UsIFwiTTAwMVwiLCBcIlMwMVwiLCBbXCJTMDBcIl0sIHsgUzAwOiBcIiMjIyBSZXN1bHRzXFxuXFxuRG9uZS5cIiB9KTtcbiAgICAgIGNvbnN0IHByb21wdCA9IGF3YWl0IGJ1aWxkUGxhblNsaWNlUHJvbXB0KFwiTTAwMVwiLCBcIk1pbGVzdG9uZVwiLCBcIlMwMVwiLCBcIkN1cnJlbnQgc2xpY2VcIiwgYmFzZSwgXCJtaW5pbWFsXCIsIHtcbiAgICAgICAgc2Vzc2lvbkNvbnRleHRXaW5kb3c6IDEyOF8wMDAsXG4gICAgICB9KTtcbiAgICAgIGFzc2VydC5tYXRjaChwcm9tcHQsIC9FeGVjdXRvciBDb250ZXh0IENvbnN0cmFpbnRzLyk7XG4gICAgICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvMTI4SyB0b2tlbi8pO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEV4ZWN1dG9yIGNvbnN0cmFpbnRzIGZvcm1hdHRpbmcgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwicHJvbXB0LWJ1ZGdldDogZXhlY3V0b3IgY29uc3RyYWludHMgZm9ybWF0dGluZ1wiLCAoKSA9PiB7XG4gIGl0KFwiMTI4SyB3aW5kb3cgcHJvZHVjZXMgZGlmZmVyZW50IGNvbnN0cmFpbnRzIHRoYW4gMU0gd2luZG93XCIsICgpID0+IHtcbiAgICBjb25zdCBidWRnZXQxMjhLID0gY29tcHV0ZUJ1ZGdldHMoMTI4XzAwMCk7XG4gICAgY29uc3QgYnVkZ2V0MU0gPSBjb21wdXRlQnVkZ2V0cygxXzAwMF8wMDApO1xuXG4gICAgLy8gVGFzayBjb3VudCByYW5nZXMgc2hvdWxkIGRpZmZlclxuICAgIGFzc2VydC5ub3RFcXVhbChcbiAgICAgIGJ1ZGdldDEyOEsudGFza0NvdW50UmFuZ2UubWF4LFxuICAgICAgYnVkZ2V0MU0udGFza0NvdW50UmFuZ2UubWF4LFxuICAgICAgXCIxMjhLIGFuZCAxTSBzaG91bGQgaGF2ZSBkaWZmZXJlbnQgbWF4IHRhc2sgY291bnRzXCIsXG4gICAgKTtcblxuICAgIC8vIElubGluZSBjb250ZXh0IGJ1ZGdldHMgc2hvdWxkIGRpZmZlclxuICAgIGFzc2VydC5vayhcbiAgICAgIGJ1ZGdldDFNLmlubGluZUNvbnRleHRCdWRnZXRDaGFycyA+IGJ1ZGdldDEyOEsuaW5saW5lQ29udGV4dEJ1ZGdldENoYXJzLFxuICAgICAgXCIxTSBzaG91bGQgaGF2ZSBsYXJnZXIgaW5saW5lIGNvbnRleHQgYnVkZ2V0IHRoYW4gMTI4S1wiLFxuICAgICk7XG5cbiAgICAvLyBGb3JtYXQgY29uc3RyYWludCBibG9ja3MgYW5kIHZlcmlmeSB0aGV5IGRpZmZlclxuICAgIGNvbnN0IGZvcm1hdCA9IChiOiBSZXR1cm5UeXBlPHR5cGVvZiBjb21wdXRlQnVkZ2V0cz4sIHdpbmRvd1Rva2VuczogbnVtYmVyKSA9PiB7XG4gICAgICBjb25zdCB7IG1pbiwgbWF4IH0gPSBiLnRhc2tDb3VudFJhbmdlO1xuICAgICAgY29uc3QgZXhlY1dpbmRvd0sgPSBNYXRoLnJvdW5kKHdpbmRvd1Rva2VucyAvIDEwMDApO1xuICAgICAgY29uc3QgcGVyVGFza0J1ZGdldEsgPSBNYXRoLnJvdW5kKGIuaW5saW5lQ29udGV4dEJ1ZGdldENoYXJzIC8gMTAwMCk7XG4gICAgICByZXR1cm4gW1xuICAgICAgICBgIyMgRXhlY3V0b3IgQ29udGV4dCBDb25zdHJhaW50c2AsXG4gICAgICAgIGBgLFxuICAgICAgICBgVGhlIGFnZW50IHRoYXQgZXhlY3V0ZXMgZWFjaCB0YXNrIGhhcyBhICoqJHtleGVjV2luZG93S31LIHRva2VuKiogY29udGV4dCB3aW5kb3cuYCxcbiAgICAgICAgYC0gUmVjb21tZW5kZWQgdGFzayBjb3VudCBmb3IgdGhpcyBzbGljZTogKioke21pbn1cdTIwMTMke21heH0gdGFza3MqKmAsXG4gICAgICAgIGAtIEVhY2ggdGFzayBnZXRzIH4ke3BlclRhc2tCdWRnZXRLfUsgY2hhcnMgb2YgaW5saW5lIGNvbnRleHQgKHBsYW5zLCBjb2RlLCBkZWNpc2lvbnMpYCxcbiAgICAgICAgYC0gS2VlcCBpbmRpdmlkdWFsIHRhc2tzIGNvbXBsZXRhYmxlIHdpdGhpbiBhIHNpbmdsZSBjb250ZXh0IHdpbmRvdyBcdTIwMTQgaWYgYSB0YXNrIG5lZWRzIG1vcmUgY29udGV4dCB0aGFuIGZpdHMsIHNwbGl0IGl0YCxcbiAgICAgIF0uam9pbihcIlxcblwiKTtcbiAgICB9O1xuXG4gICAgY29uc3QgY29uc3RyYWludHMxMjhLID0gZm9ybWF0KGJ1ZGdldDEyOEssIDEyOF8wMDApO1xuICAgIGNvbnN0IGNvbnN0cmFpbnRzMU0gPSBmb3JtYXQoYnVkZ2V0MU0sIDFfMDAwXzAwMCk7XG5cbiAgICBhc3NlcnQub2soY29uc3RyYWludHMxMjhLLmluY2x1ZGVzKFwiMTI4SyB0b2tlblwiKSwgXCIxMjhLIGNvbnN0cmFpbnRzIHNob3VsZCByZWZlcmVuY2UgMTI4S1wiKTtcbiAgICBhc3NlcnQub2soY29uc3RyYWludHMxTS5pbmNsdWRlcyhcIjEwMDBLIHRva2VuXCIpLCBcIjFNIGNvbnN0cmFpbnRzIHNob3VsZCByZWZlcmVuY2UgMTAwMEtcIik7XG4gICAgYXNzZXJ0Lm9rKGNvbnN0cmFpbnRzMTI4Sy5pbmNsdWRlcyhcIjJcdTIwMTM1IHRhc2tzXCIpLCBcIjEyOEsgc2hvdWxkIHJlY29tbWVuZCAyXHUyMDEzNSB0YXNrc1wiKTtcbiAgICBhc3NlcnQub2soY29uc3RyYWludHMxTS5pbmNsdWRlcyhcIjJcdTIwMTM4IHRhc2tzXCIpLCBcIjFNIHNob3VsZCByZWNvbW1lbmQgMlx1MjAxMzggdGFza3NcIik7XG4gICAgYXNzZXJ0Lm5vdEVxdWFsKGNvbnN0cmFpbnRzMTI4SywgY29uc3RyYWludHMxTSwgXCJjb25zdHJhaW50IGJsb2NrcyBzaG91bGQgZGlmZmVyXCIpO1xuICB9KTtcblxuICBpdChcInVuZGVmaW5lZCBjb250ZXh0IHdpbmRvdyBmYWxscyBiYWNrIHRvIDIwMEsgZGVmYXVsdHNcIiwgKCkgPT4ge1xuICAgIC8vIGNvbXB1dGVCdWRnZXRzKDApIGRlZmF1bHRzIHRvIDIwMEsgKEQwMDIpXG4gICAgY29uc3QgYnVkZ2V0RGVmYXVsdCA9IGNvbXB1dGVCdWRnZXRzKDApO1xuICAgIGNvbnN0IGJ1ZGdldDIwMEsgPSBjb21wdXRlQnVkZ2V0cygyMDBfMDAwKTtcblxuICAgIGFzc2VydC5lcXVhbChidWRnZXREZWZhdWx0LnN1bW1hcnlCdWRnZXRDaGFycywgYnVkZ2V0MjAwSy5zdW1tYXJ5QnVkZ2V0Q2hhcnMpO1xuICAgIGFzc2VydC5lcXVhbChidWRnZXREZWZhdWx0LmlubGluZUNvbnRleHRCdWRnZXRDaGFycywgYnVkZ2V0MjAwSy5pbmxpbmVDb250ZXh0QnVkZ2V0Q2hhcnMpO1xuICAgIGFzc2VydC5lcXVhbChidWRnZXREZWZhdWx0LnRhc2tDb3VudFJhbmdlLm1heCwgYnVkZ2V0MjAwSy50YXNrQ291bnRSYW5nZS5tYXgpO1xuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQnVkZ2V0LWNvbnN0cmFpbmVkIG91dHB1dCB2YXJpZXMgd2l0aCBjb250ZXh0IHdpbmRvdyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJwcm9tcHQtYnVkZ2V0OiBkaWZmZXJlbnQgY29udGV4dCB3aW5kb3dzIHByb2R1Y2UgZGlmZmVyZW50IG91dHB1dHNcIiwgKCkgPT4ge1xuICBpdChcInNtYWxsIHdpbmRvdyB0cnVuY2F0ZXMgY29udGVudCB0aGF0IGxhcmdlIHdpbmRvdyBwcmVzZXJ2ZXNcIiwgKCkgPT4ge1xuICAgIC8vIFNpbXVsYXRlIGFzc2VtYmxlZCBpbmxpbmVkQ29udGV4dCB3aXRoIG11bHRpcGxlIHNlY3Rpb25zXG4gICAgY29uc3Qgc2VjdGlvbnMgPSBbXTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IDIwOyBpKyspIHtcbiAgICAgIHNlY3Rpb25zLnB1c2goYCMjIyBTZWN0aW9uICR7aX06IEltcG9ydGFudCBDb250ZXh0XFxuXFxuJHtcIkRldGFpbGVkIGNvbnRlbnQgZm9yIHRoaXMgc2VjdGlvbi4gXCIucmVwZWF0KDEwMCl9YCk7XG4gICAgfVxuICAgIGNvbnN0IGxhcmdlQ29udGVudCA9IGAjIyBJbmxpbmVkIENvbnRleHRcXG5cXG4ke3NlY3Rpb25zLmpvaW4oXCJcXG5cXG4tLS1cXG5cXG5cIil9YDtcblxuICAgIC8vIDEyOEsgY29udGV4dCB3aW5kb3cgYnVkZ2V0XG4gICAgY29uc3QgYnVkZ2V0MTI4SyA9IGNvbXB1dGVCdWRnZXRzKDEyOF8wMDApO1xuICAgIGNvbnN0IHIxMjhLID0gdHJ1bmNhdGVBdFNlY3Rpb25Cb3VuZGFyeShsYXJnZUNvbnRlbnQsIGJ1ZGdldDEyOEsuaW5saW5lQ29udGV4dEJ1ZGdldENoYXJzKTtcblxuICAgIC8vIDFNIGNvbnRleHQgd2luZG93IGJ1ZGdldFxuICAgIGNvbnN0IGJ1ZGdldDFNID0gY29tcHV0ZUJ1ZGdldHMoMV8wMDBfMDAwKTtcbiAgICBjb25zdCByMU0gPSB0cnVuY2F0ZUF0U2VjdGlvbkJvdW5kYXJ5KGxhcmdlQ29udGVudCwgYnVkZ2V0MU0uaW5saW5lQ29udGV4dEJ1ZGdldENoYXJzKTtcblxuICAgIC8vIFRoZSBsYXJnZSBjb250ZW50ICh+NzBLIGNoYXJzKSBzaG91bGQgZml0IGluIDFNIGJ1ZGdldCAofjEuNk0gY2hhcnMpIGJ1dFxuICAgIC8vIGlmIHdlIG1ha2UgY29udGVudCBiaWdnZXIsIHRoZSAxMjhLIGJ1ZGdldCAofjIwNEsgY2hhcnMpIHdvdWxkIHRydW5jYXRlXG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgcjEyOEsuY29udGVudC5sZW5ndGggPD0gYnVkZ2V0MTI4Sy5pbmxpbmVDb250ZXh0QnVkZ2V0Q2hhcnMgKyAxMDAsIC8vICsxMDAgZm9yIHRydW5jYXRpb24gbWFya2VyXG4gICAgICBcIjEyOEsgcmVzdWx0IHNob3VsZCByZXNwZWN0IGJ1ZGdldFwiLFxuICAgICk7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgcjFNLmNvbnRlbnQubGVuZ3RoIDw9IGJ1ZGdldDFNLmlubGluZUNvbnRleHRCdWRnZXRDaGFycyArIDEwMCxcbiAgICAgIFwiMU0gcmVzdWx0IHNob3VsZCByZXNwZWN0IGJ1ZGdldFwiLFxuICAgICk7XG5cbiAgICAvLyBXaXRoIGNvbnRlbnQgc21hbGxlciB0aGFuIGJvdGggYnVkZ2V0cywgYm90aCBzaG91bGQgcGFzcyB0aHJvdWdoIHVuY2hhbmdlZFxuICAgIGNvbnN0IHNtYWxsQ29udGVudCA9IFwiIyMjIE9uZSBTZWN0aW9uXFxuXFxuU21hbGwgY29udGVudC5cIjtcbiAgICBjb25zdCBzbWFsbDEyOEsgPSB0cnVuY2F0ZUF0U2VjdGlvbkJvdW5kYXJ5KHNtYWxsQ29udGVudCwgYnVkZ2V0MTI4Sy5pbmxpbmVDb250ZXh0QnVkZ2V0Q2hhcnMpO1xuICAgIGNvbnN0IHNtYWxsMU0gPSB0cnVuY2F0ZUF0U2VjdGlvbkJvdW5kYXJ5KHNtYWxsQ29udGVudCwgYnVkZ2V0MU0uaW5saW5lQ29udGV4dEJ1ZGdldENoYXJzKTtcbiAgICBhc3NlcnQuZXF1YWwoc21hbGwxMjhLLmNvbnRlbnQsIHNtYWxsQ29udGVudCwgXCJzbWFsbCBjb250ZW50IHVuY2hhbmdlZCBmb3IgMTI4S1wiKTtcbiAgICBhc3NlcnQuZXF1YWwoc21hbGwxMjhLLmRyb3BwZWRTZWN0aW9ucywgMCk7XG4gICAgYXNzZXJ0LmVxdWFsKHNtYWxsMU0uY29udGVudCwgc21hbGxDb250ZW50LCBcInNtYWxsIGNvbnRlbnQgdW5jaGFuZ2VkIGZvciAxTVwiKTtcbiAgICBhc3NlcnQuZXF1YWwoc21hbGwxTS5kcm9wcGVkU2VjdGlvbnMsIDApO1xuICB9KTtcblxuICBpdChcIjEyOEsgYnVkZ2V0IHRydW5jYXRlcyB2ZXJ5IGxhcmdlIGNvbnRlbnQgd2hpbGUgMU0gcHJlc2VydmVzIGl0XCIsICgpID0+IHtcbiAgICAvLyBDcmVhdGUgY29udGVudCB0aGF0IGV4Y2VlZHMgMTI4SyBidWRnZXQgKH4yMDRLIGNoYXJzKSBidXQgZml0cyBpbiAxTSAofjEuNk0gY2hhcnMpXG4gICAgY29uc3Qgc2VjdGlvbnMgPSBbXTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IDEwMDsgaSsrKSB7XG4gICAgICBzZWN0aW9ucy5wdXNoKGAjIyMgU2VjdGlvbiAke2l9XFxuXFxuJHtcIlhcIi5yZXBlYXQoMzAwMCl9YCk7XG4gICAgfVxuICAgIGNvbnN0IGNvbnRlbnQgPSBzZWN0aW9ucy5qb2luKFwiXFxuXFxuXCIpO1xuICAgIC8vIH4zMTBLIGNoYXJzIHRvdGFsXG5cbiAgICBjb25zdCBidWRnZXQxMjhLID0gY29tcHV0ZUJ1ZGdldHMoMTI4XzAwMCk7XG4gICAgY29uc3QgcmVzdWx0MTI4SyA9IHRydW5jYXRlQXRTZWN0aW9uQm91bmRhcnkoY29udGVudCwgYnVkZ2V0MTI4Sy5pbmxpbmVDb250ZXh0QnVkZ2V0Q2hhcnMpO1xuXG4gICAgY29uc3QgYnVkZ2V0MU0gPSBjb21wdXRlQnVkZ2V0cygxXzAwMF8wMDApO1xuICAgIGNvbnN0IHJlc3VsdDFNID0gdHJ1bmNhdGVBdFNlY3Rpb25Cb3VuZGFyeShjb250ZW50LCBidWRnZXQxTS5pbmxpbmVDb250ZXh0QnVkZ2V0Q2hhcnMpO1xuXG4gICAgYXNzZXJ0Lm9rKHJlc3VsdDEyOEsuY29udGVudC5pbmNsdWRlcyhcIlsuLi50cnVuY2F0ZWRcIiksIFwiMTI4SyBzaG91bGQgdHJ1bmNhdGUgfjMxMEsgY29udGVudFwiKTtcbiAgICBhc3NlcnQub2socmVzdWx0MTI4Sy5kcm9wcGVkU2VjdGlvbnMgPiAwLCBcIjEyOEsgc2hvdWxkIHJlcG9ydCBkcm9wcGVkIHNlY3Rpb25zXCIpO1xuICAgIGFzc2VydC5vayghcmVzdWx0MU0uY29udGVudC5pbmNsdWRlcyhcIlsuLi50cnVuY2F0ZWRcIiksIFwiMU0gc2hvdWxkIHByZXNlcnZlIH4zMTBLIGNvbnRlbnRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdDFNLmRyb3BwZWRTZWN0aW9ucywgMCk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdDEyOEsuY29udGVudC5sZW5ndGggPCByZXN1bHQxTS5jb250ZW50Lmxlbmd0aCwgXCIxMjhLIHJlc3VsdCBzaG91bGQgYmUgc2hvcnRlciB0aGFuIDFNIHJlc3VsdFwiKTtcbiAgfSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGV4ZWN1dGUtdGFzayB0ZW1wbGF0ZSBpbmNsdWRlcyB2ZXJpZmljYXRpb25CdWRnZXQgcGxhY2Vob2xkZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwicHJvbXB0LWJ1ZGdldDogZXhlY3V0ZS10YXNrIHRlbXBsYXRlXCIsICgpID0+IHtcbiAgaXQoXCJyZW5kZXJlZCBleGVjdXRlLXRhc2sgcHJvbXB0IGluY2x1ZGVzIHZlcmlmaWNhdGlvbiBidWRnZXRcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzbGljZURpciA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIik7XG4gICAgICBjb25zdCB0YXNrRGlyID0gam9pbihzbGljZURpciwgXCJ0YXNrc1wiKTtcbiAgICAgIG1rZGlyU3luYyh0YXNrRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcIk0wMDEtUk9BRE1BUC5tZFwiKSwgXCIjIFJvYWRtYXBcXG5cIik7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4oc2xpY2VEaXIsIFwiUzAxLVBMQU4ubWRcIiksIFwiIyBTbGljZSBQbGFuXFxuXCIpO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHRhc2tEaXIsIFwiVDAxLVBMQU4ubWRcIiksIFwiIyBUYXNrIFBsYW5cXG5cIik7XG5cbiAgICAgIGNvbnN0IHByb21wdCA9IGF3YWl0IGJ1aWxkRXhlY3V0ZVRhc2tQcm9tcHQoXCJNMDAxXCIsIFwiUzAxXCIsIFwiU2xpY2VcIiwgXCJUMDFcIiwgXCJUYXNrXCIsIGJhc2UsIHtcbiAgICAgICAgbGV2ZWw6IFwibWluaW1hbFwiLFxuICAgICAgICBzZXNzaW9uQ29udGV4dFdpbmRvdzogMTI4XzAwMCxcbiAgICAgIH0pO1xuICAgICAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL3ZlcmlmaWNhdGlvbi9pKTtcbiAgICAgIGFzc2VydC5tYXRjaChwcm9tcHQsIC9+NTFLIGNoYXJzLyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICBpdChcInZlcmlmaWNhdGlvbkJ1ZGdldCBmb3JtYXQgdmFyaWVzIHdpdGggY29udGV4dCB3aW5kb3cgc2l6ZVwiLCAoKSA9PiB7XG4gICAgY29uc3QgYnVkZ2V0MTI4SyA9IGNvbXB1dGVCdWRnZXRzKDEyOF8wMDApO1xuICAgIGNvbnN0IGJ1ZGdldDFNID0gY29tcHV0ZUJ1ZGdldHMoMV8wMDBfMDAwKTtcblxuICAgIGNvbnN0IGZvcm1hdDEyOEsgPSBgfiR7TWF0aC5yb3VuZChidWRnZXQxMjhLLnZlcmlmaWNhdGlvbkJ1ZGdldENoYXJzIC8gMTAwMCl9SyBjaGFyc2A7XG4gICAgY29uc3QgZm9ybWF0MU0gPSBgfiR7TWF0aC5yb3VuZChidWRnZXQxTS52ZXJpZmljYXRpb25CdWRnZXRDaGFycyAvIDEwMDApfUsgY2hhcnNgO1xuXG4gICAgYXNzZXJ0Lm5vdEVxdWFsKGZvcm1hdDEyOEssIGZvcm1hdDFNLCBcIjEyOEsgYW5kIDFNIHNob3VsZCBwcm9kdWNlIGRpZmZlcmVudCB2ZXJpZmljYXRpb24gYnVkZ2V0IHN0cmluZ3NcIik7XG4gICAgYXNzZXJ0Lm9rKGZvcm1hdDEyOEsuaW5jbHVkZXMoXCJ+NTFLXCIpLCBgMTI4SyBzaG91bGQgcHJvZHVjZSB+NTFLLCBnb3QgJHtmb3JtYXQxMjhLfWApO1xuICAgIGFzc2VydC5vayhmb3JtYXQxTS5pbmNsdWRlcyhcIn40MDBLXCIpLCBgMU0gc2hvdWxkIHByb2R1Y2UgfjQwMEssIGdvdCAke2Zvcm1hdDFNfWApO1xuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgYnVpbGRDb21wbGV0ZVNsaWNlUHJvbXB0IGJ1ZGdldCBlbmZvcmNlbWVudCAoc2ltdWxhdGVkKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJwcm9tcHQtYnVkZ2V0OiBjb21wbGV0ZS1zbGljZSBidWlsZGVyIHRydW5jYXRpb24gcGF0dGVyblwiLCAoKSA9PiB7XG4gIGl0KFwidHJ1bmNhdGVBdFNlY3Rpb25Cb3VuZGFyeSB0cnVuY2F0ZXMgYXNzZW1ibGVkIGlubGluZWRDb250ZXh0IGZvciBjb21wbGV0ZS1zbGljZSBwYXR0ZXJuXCIsICgpID0+IHtcbiAgICAvLyBTaW11bGF0ZSBidWlsZENvbXBsZXRlU2xpY2VQcm9tcHQ6IHJvYWRtYXAgKyBzbGljZSBwbGFuICsgdGFzayBzdW1tYXJpZXNcbiAgICBjb25zdCBpbmxpbmVkOiBzdHJpbmdbXSA9IFtdO1xuICAgIGlubGluZWQucHVzaChcIiMjIyBNaWxlc3RvbmUgUm9hZG1hcFxcblxcblJvYWRtYXAgY29udGVudCBoZXJlLlwiKTtcbiAgICBpbmxpbmVkLnB1c2goXCIjIyMgU2xpY2UgUGxhblxcblxcblNsaWNlIHBsYW4gY29udGVudCBoZXJlLlwiKTtcbiAgICAvLyBBZGQgbWFueSB0YXNrIHN1bW1hcmllcyB0aGF0IHB1c2ggcGFzdCBidWRnZXRcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IDUwOyBpKyspIHtcbiAgICAgIGlubGluZWQucHVzaChgIyMjIFRhc2sgU3VtbWFyeTogVCR7U3RyaW5nKGkpLnBhZFN0YXJ0KDIsIFwiMFwiKX1cXG5Tb3VyY2U6IFxcYHRhc2tzL1Qke1N0cmluZyhpKS5wYWRTdGFydCgyLCBcIjBcIil9LVNVTU1BUlkubWRcXGBcXG5cXG4ke1wiVGFzayByZXN1bHQgZGV0YWlscy4gXCIucmVwZWF0KDIwMCl9YCk7XG4gICAgfVxuXG4gICAgY29uc3QgYXNzZW1ibGVkQ29udGVudCA9IGAjIyBJbmxpbmVkIENvbnRleHQgKHByZWxvYWRlZCBcdTIwMTQgZG8gbm90IHJlLXJlYWQgdGhlc2UgZmlsZXMpXFxuXFxuJHtpbmxpbmVkLmpvaW4oXCJcXG5cXG4tLS1cXG5cXG5cIil9YDtcblxuICAgIC8vIFNtYWxsIGNvbnRleHQgd2luZG93ICgxMjhLKSBzaG91bGQgdHJ1bmNhdGVcbiAgICBjb25zdCBidWRnZXQxMjhLID0gY29tcHV0ZUJ1ZGdldHMoMTI4XzAwMCk7XG4gICAgY29uc3QgcmVzdWx0MTI4SyA9IHRydW5jYXRlQXRTZWN0aW9uQm91bmRhcnkoYXNzZW1ibGVkQ29udGVudCwgYnVkZ2V0MTI4Sy5pbmxpbmVDb250ZXh0QnVkZ2V0Q2hhcnMpO1xuICAgIGFzc2VydC5vayhyZXN1bHQxMjhLLmNvbnRlbnQuaW5jbHVkZXMoXCJbLi4udHJ1bmNhdGVkXCIpLCBcIjEyOEsgc2hvdWxkIHRydW5jYXRlIG1hbnkgdGFzayBzdW1tYXJpZXNcIik7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdDEyOEsuY29udGVudC5pbmNsdWRlcyhcIiMjIyBNaWxlc3RvbmUgUm9hZG1hcFwiKSwgXCJzaG91bGQgcHJlc2VydmUgZWFybHkgc2VjdGlvbnNcIik7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdDEyOEsuZHJvcHBlZFNlY3Rpb25zID4gMCwgXCIxMjhLIHNob3VsZCByZXBvcnQgZHJvcHBlZCBzZWN0aW9uc1wiKTtcblxuICAgIC8vIExhcmdlIGNvbnRleHQgd2luZG93ICgxTSkgc2hvdWxkIHByZXNlcnZlIGFsbFxuICAgIGNvbnN0IGJ1ZGdldDFNID0gY29tcHV0ZUJ1ZGdldHMoMV8wMDBfMDAwKTtcbiAgICBjb25zdCByZXN1bHQxTSA9IHRydW5jYXRlQXRTZWN0aW9uQm91bmRhcnkoYXNzZW1ibGVkQ29udGVudCwgYnVkZ2V0MU0uaW5saW5lQ29udGV4dEJ1ZGdldENoYXJzKTtcbiAgICBhc3NlcnQub2soIXJlc3VsdDFNLmNvbnRlbnQuaW5jbHVkZXMoXCJbLi4udHJ1bmNhdGVkXCIpLCBcIjFNIHNob3VsZCBwcmVzZXJ2ZSBhbGwgdGFzayBzdW1tYXJpZXNcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdDFNLmRyb3BwZWRTZWN0aW9ucywgMCk7XG4gIH0pO1xuXG4gIGl0KFwic21hbGwgY29udGVudCBwYXNzZXMgdGhyb3VnaCB1bmNoYW5nZWQgYXQgYW55IGNvbnRleHQgd2luZG93IHNpemVcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHNtYWxsQ29udGVudCA9IFwiIyMgSW5saW5lZCBDb250ZXh0XFxuXFxuIyMjIFJvYWRtYXBcXG5cXG5TbWFsbCByb2FkbWFwLlxcblxcbi0tLVxcblxcbiMjIyBQbGFuXFxuXFxuU21hbGwgcGxhbi5cIjtcblxuICAgIGNvbnN0IGJ1ZGdldDEyOEsgPSBjb21wdXRlQnVkZ2V0cygxMjhfMDAwKTtcbiAgICBjb25zdCByZXN1bHQxMjhLID0gdHJ1bmNhdGVBdFNlY3Rpb25Cb3VuZGFyeShzbWFsbENvbnRlbnQsIGJ1ZGdldDEyOEsuaW5saW5lQ29udGV4dEJ1ZGdldENoYXJzKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0MTI4Sy5jb250ZW50LCBzbWFsbENvbnRlbnQsIFwic21hbGwgY29udGVudCB1bmNoYW5nZWQgZm9yIDEyOEtcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdDEyOEsuZHJvcHBlZFNlY3Rpb25zLCAwKTtcblxuICAgIGNvbnN0IGJ1ZGdldDFNID0gY29tcHV0ZUJ1ZGdldHMoMV8wMDBfMDAwKTtcbiAgICBjb25zdCByZXN1bHQxTSA9IHRydW5jYXRlQXRTZWN0aW9uQm91bmRhcnkoc21hbGxDb250ZW50LCBidWRnZXQxTS5pbmxpbmVDb250ZXh0QnVkZ2V0Q2hhcnMpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQxTS5jb250ZW50LCBzbWFsbENvbnRlbnQsIFwic21hbGwgY29udGVudCB1bmNoYW5nZWQgZm9yIDFNXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQxTS5kcm9wcGVkU2VjdGlvbnMsIDApO1xuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgYnVpbGRDb21wbGV0ZU1pbGVzdG9uZVByb21wdCBidWRnZXQgZW5mb3JjZW1lbnQgKHNpbXVsYXRlZCkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwicHJvbXB0LWJ1ZGdldDogY29tcGxldGUtbWlsZXN0b25lIGJ1aWxkZXIgdHJ1bmNhdGlvbiBwYXR0ZXJuXCIsICgpID0+IHtcbiAgaXQoXCJ0cnVuY2F0ZUF0U2VjdGlvbkJvdW5kYXJ5IHRydW5jYXRlcyBhc3NlbWJsZWQgaW5saW5lZENvbnRleHQgZm9yIGNvbXBsZXRlLW1pbGVzdG9uZSBwYXR0ZXJuXCIsICgpID0+IHtcbiAgICAvLyBTaW11bGF0ZSBidWlsZENvbXBsZXRlTWlsZXN0b25lUHJvbXB0OiByb2FkbWFwICsgc2xpY2Ugc3VtbWFyaWVzICsgcm9vdCBmaWxlc1xuICAgIGNvbnN0IGlubGluZWQ6IHN0cmluZ1tdID0gW107XG4gICAgaW5saW5lZC5wdXNoKFwiIyMjIE1pbGVzdG9uZSBSb2FkbWFwXFxuXFxuUm9hZG1hcCBjb250ZW50IGhlcmUuXCIpO1xuICAgIC8vIEFkZCBtYW55IHNsaWNlIHN1bW1hcmllcyB0aGF0IHB1c2ggcGFzdCBidWRnZXRcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IDMwOyBpKyspIHtcbiAgICAgIGlubGluZWQucHVzaChgIyMjIFMke1N0cmluZyhpKS5wYWRTdGFydCgyLCBcIjBcIil9IFN1bW1hcnlcXG5cXG4ke1wiU2xpY2Ugc3VtbWFyeSB3aXRoIGRldGFpbGVkIHJlc3VsdHMgYW5kIGZvcndhcmQgaW50ZWxsaWdlbmNlLiBcIi5yZXBlYXQoMjAwKX1gKTtcbiAgICB9XG4gICAgaW5saW5lZC5wdXNoKFwiIyMjIFJlcXVpcmVtZW50c1xcblxcblByb2plY3QgcmVxdWlyZW1lbnRzLlwiKTtcbiAgICBpbmxpbmVkLnB1c2goXCIjIyMgRGVjaXNpb25zXFxuXFxuUHJvamVjdCBkZWNpc2lvbnMuXCIpO1xuXG4gICAgY29uc3QgYXNzZW1ibGVkQ29udGVudCA9IGAjIyBJbmxpbmVkIENvbnRleHQgKHByZWxvYWRlZCBcdTIwMTQgZG8gbm90IHJlLXJlYWQgdGhlc2UgZmlsZXMpXFxuXFxuJHtpbmxpbmVkLmpvaW4oXCJcXG5cXG4tLS1cXG5cXG5cIil9YDtcblxuICAgIC8vIFNtYWxsIGNvbnRleHQgd2luZG93ICgxMjhLKSBzaG91bGQgdHJ1bmNhdGVcbiAgICBjb25zdCBidWRnZXQxMjhLID0gY29tcHV0ZUJ1ZGdldHMoMTI4XzAwMCk7XG4gICAgY29uc3QgcmVzdWx0MTI4SyA9IHRydW5jYXRlQXRTZWN0aW9uQm91bmRhcnkoYXNzZW1ibGVkQ29udGVudCwgYnVkZ2V0MTI4Sy5pbmxpbmVDb250ZXh0QnVkZ2V0Q2hhcnMpO1xuICAgIGFzc2VydC5vayhyZXN1bHQxMjhLLmNvbnRlbnQuaW5jbHVkZXMoXCJbLi4udHJ1bmNhdGVkXCIpLCBcIjEyOEsgc2hvdWxkIHRydW5jYXRlIG1hbnkgc2xpY2Ugc3VtbWFyaWVzXCIpO1xuICAgIGFzc2VydC5vayhyZXN1bHQxMjhLLmRyb3BwZWRTZWN0aW9ucyA+IDApO1xuXG4gICAgLy8gTGFyZ2UgY29udGV4dCB3aW5kb3cgKDFNKSBzaG91bGQgcHJlc2VydmUgYWxsXG4gICAgY29uc3QgYnVkZ2V0MU0gPSBjb21wdXRlQnVkZ2V0cygxXzAwMF8wMDApO1xuICAgIGNvbnN0IHJlc3VsdDFNID0gdHJ1bmNhdGVBdFNlY3Rpb25Cb3VuZGFyeShhc3NlbWJsZWRDb250ZW50LCBidWRnZXQxTS5pbmxpbmVDb250ZXh0QnVkZ2V0Q2hhcnMpO1xuICAgIGFzc2VydC5vayghcmVzdWx0MU0uY29udGVudC5pbmNsdWRlcyhcIlsuLi50cnVuY2F0ZWRcIiksIFwiMU0gc2hvdWxkIHByZXNlcnZlIGFsbCBzbGljZSBzdW1tYXJpZXNcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdDFNLmRyb3BwZWRTZWN0aW9ucywgMCk7XG4gIH0pO1xuXG4gIGl0KFwiZGlmZmVyZW50IGNvbnRleHQgd2luZG93cyBwcm9kdWNlIGRpZmZlcmVudCB0cnVuY2F0aW9uIGZvciBtaWxlc3RvbmUgY29tcGxldGlvblwiLCAoKSA9PiB7XG4gICAgLy8gQ3JlYXRlIGNvbnRlbnQgdGhhdCBleGNlZWRzIDEyOEsgYnVkZ2V0IGJ1dCBub3QgMjAwSyBidWRnZXRcbiAgICBjb25zdCBpbmxpbmVkOiBzdHJpbmdbXSA9IFtdO1xuICAgIGlubGluZWQucHVzaChcIiMjIyBSb2FkbWFwXFxuXFxuUm9hZG1hcC5cIik7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCAxNTsgaSsrKSB7XG4gICAgICBpbmxpbmVkLnB1c2goYCMjIyBTJHtpfSBTdW1tYXJ5XFxuXFxuJHtcIlhcIi5yZXBlYXQoMTUwMDApfWApO1xuICAgIH1cbiAgICBjb25zdCBjb250ZW50ID0gYCMjIElubGluZWQgQ29udGV4dFxcblxcbiR7aW5saW5lZC5qb2luKFwiXFxuXFxuLS0tXFxuXFxuXCIpfWA7XG4gICAgLy8gfjIyNUsgY2hhcnMgdG90YWxcblxuICAgIGNvbnN0IGJ1ZGdldDEyOEsgPSBjb21wdXRlQnVkZ2V0cygxMjhfMDAwKTtcbiAgICBjb25zdCBidWRnZXQyMDBLID0gY29tcHV0ZUJ1ZGdldHMoMjAwXzAwMCk7XG4gICAgY29uc3QgYnVkZ2V0MU0gPSBjb21wdXRlQnVkZ2V0cygxXzAwMF8wMDApO1xuXG4gICAgY29uc3QgcmVzdWx0MTI4SyA9IHRydW5jYXRlQXRTZWN0aW9uQm91bmRhcnkoY29udGVudCwgYnVkZ2V0MTI4Sy5pbmxpbmVDb250ZXh0QnVkZ2V0Q2hhcnMpO1xuICAgIGNvbnN0IHJlc3VsdDIwMEsgPSB0cnVuY2F0ZUF0U2VjdGlvbkJvdW5kYXJ5KGNvbnRlbnQsIGJ1ZGdldDIwMEsuaW5saW5lQ29udGV4dEJ1ZGdldENoYXJzKTtcbiAgICBjb25zdCByZXN1bHQxTSA9IHRydW5jYXRlQXRTZWN0aW9uQm91bmRhcnkoY29udGVudCwgYnVkZ2V0MU0uaW5saW5lQ29udGV4dEJ1ZGdldENoYXJzKTtcblxuICAgIC8vIDEyOEsgKGJ1ZGdldCB+MjA0Sykgc2hvdWxkIHRydW5jYXRlIH4yMjVLIGNvbnRlbnRcbiAgICBhc3NlcnQub2socmVzdWx0MTI4Sy5jb250ZW50LmluY2x1ZGVzKFwiWy4uLnRydW5jYXRlZFwiKSwgXCIxMjhLIHNob3VsZCB0cnVuY2F0ZSB+MjI1SyBjb250ZW50XCIpO1xuICAgIGFzc2VydC5vayhyZXN1bHQxMjhLLmRyb3BwZWRTZWN0aW9ucyA+IDApO1xuICAgIC8vIDIwMEsgKGJ1ZGdldCB+MzIwSykgc2hvdWxkIG5vdCB0cnVuY2F0ZSB+MjI1SyBjb250ZW50XG4gICAgYXNzZXJ0Lm9rKCFyZXN1bHQyMDBLLmNvbnRlbnQuaW5jbHVkZXMoXCJbLi4udHJ1bmNhdGVkXCIpLCBcIjIwMEsgc2hvdWxkIHByZXNlcnZlIH4yMjVLIGNvbnRlbnRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdDIwMEsuZHJvcHBlZFNlY3Rpb25zLCAwKTtcbiAgICAvLyAxTSBzaG91bGQgbm90IHRydW5jYXRlXG4gICAgYXNzZXJ0Lm9rKCFyZXN1bHQxTS5jb250ZW50LmluY2x1ZGVzKFwiWy4uLnRydW5jYXRlZFwiKSwgXCIxTSBzaG91bGQgcHJlc2VydmUgfjIyNUsgY29udGVudFwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0MU0uZHJvcHBlZFNlY3Rpb25zLCAwKTtcbiAgICAvLyAxMjhLIHJlc3VsdCBzaG91bGQgYmUgc2hvcnRlclxuICAgIGFzc2VydC5vayhyZXN1bHQxMjhLLmNvbnRlbnQubGVuZ3RoIDwgcmVzdWx0MjAwSy5jb250ZW50Lmxlbmd0aCwgXCIxMjhLIHJlc3VsdCBzaG91bGQgYmUgc2hvcnRlciB0aGFuIDIwMEtcIik7XG4gIH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBidWlsZEV4ZWN1dGVUYXNrUHJvbXB0IGJ1ZGdldCBlbmZvcmNlbWVudCAoc2ltdWxhdGVkKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJwcm9tcHQtYnVkZ2V0OiBleGVjdXRlLXRhc2sgYnVpbGRlciB0cnVuY2F0aW9uIHBhdHRlcm5cIiwgKCkgPT4ge1xuICBpdChcInRydW5jYXRlQXRTZWN0aW9uQm91bmRhcnkgdHJ1bmNhdGVzIGFzc2VtYmxlZCBjYXJyeS1mb3J3YXJkICsgdGFzayBwbGFuICsgc2xpY2UgZXhjZXJwdFwiLCAoKSA9PiB7XG4gICAgLy8gU2ltdWxhdGUgdGhlIGFzc2VtYmxlZCBjb250ZW50IGZyb20gYnVpbGRFeGVjdXRlVGFza1Byb21wdFxuICAgIGNvbnN0IGNhcnJ5Rm9yd2FyZCA9IFwiIyMgQ2FycnktRm9yd2FyZCBDb250ZXh0XFxuXCIgKyBBcnJheS5mcm9tKHsgbGVuZ3RoOiAyMCB9LCAoXywgaSkgPT5cbiAgICAgIGAtIFxcYHRhc2tzL1Qke1N0cmluZyhpKS5wYWRTdGFydCgyLCBcIjBcIil9LVNVTU1BUlkubWRcXGAgXHUyMDE0ICR7XCJTdW1tYXJ5IGRldGFpbHMuIFwiLnJlcGVhdCgxMDApfWBcbiAgICApLmpvaW4oXCJcXG5cIik7XG5cbiAgICBjb25zdCB0YXNrUGxhbiA9IFwiIyMgSW5saW5lZCBUYXNrIFBsYW5cXG5cXG5cIiArIEFycmF5LmZyb20oeyBsZW5ndGg6IDEwIH0sIChfLCBpKSA9PlxuICAgICAgYCMjIyBTdGVwICR7aX1cXG5cXG4ke1wiSW1wbGVtZW50YXRpb24gc3RlcCBkZXRhaWxzLiBcIi5yZXBlYXQoMjAwKX1gXG4gICAgKS5qb2luKFwiXFxuXFxuXCIpO1xuXG4gICAgY29uc3Qgc2xpY2VFeGNlcnB0ID0gXCIjIyBTbGljZSBQbGFuIEV4Y2VycHRcXG5cXG5cIiArIFwiU2xpY2UgZ29hbCBhbmQgdmVyaWZpY2F0aW9uIGRldGFpbHMuIFwiLnJlcGVhdCgxMDApO1xuXG4gICAgY29uc3QgYXNzZW1ibGVkID0gW2NhcnJ5Rm9yd2FyZCwgdGFza1BsYW4sIHNsaWNlRXhjZXJwdF0uam9pbihcIlxcblxcbi0tLVxcblxcblwiKTtcblxuICAgIC8vIFNtYWxsIGNvbnRleHQgd2luZG93IHNob3VsZCB0cnVuY2F0ZVxuICAgIGNvbnN0IGJ1ZGdldDEyOEsgPSBjb21wdXRlQnVkZ2V0cygxMjhfMDAwKTtcbiAgICBjb25zdCByZXN1bHQgPSB0cnVuY2F0ZUF0U2VjdGlvbkJvdW5kYXJ5KGFzc2VtYmxlZCwgYnVkZ2V0MTI4Sy5pbmxpbmVDb250ZXh0QnVkZ2V0Q2hhcnMpO1xuXG4gICAgLy8gQ29udGVudCBzaG91bGQgcmVzcGVjdCBidWRnZXRcbiAgICBhc3NlcnQub2soXG4gICAgICByZXN1bHQuY29udGVudC5sZW5ndGggPD0gYnVkZ2V0MTI4Sy5pbmxpbmVDb250ZXh0QnVkZ2V0Q2hhcnMgKyAxMDAsXG4gICAgICBgcmVzdWx0IHNob3VsZCByZXNwZWN0IDEyOEsgYnVkZ2V0LCBnb3QgJHtyZXN1bHQuY29udGVudC5sZW5ndGh9IGNoYXJzIHZzIGJ1ZGdldCAke2J1ZGdldDEyOEsuaW5saW5lQ29udGV4dEJ1ZGdldENoYXJzfWAsXG4gICAgKTtcblxuICAgIC8vIExhcmdlIGNvbnRlbnQgc2hvdWxkIGJlIHRydW5jYXRlZFxuICAgIGlmIChhc3NlbWJsZWQubGVuZ3RoID4gYnVkZ2V0MTI4Sy5pbmxpbmVDb250ZXh0QnVkZ2V0Q2hhcnMpIHtcbiAgICAgIGFzc2VydC5vayhyZXN1bHQuY29udGVudC5pbmNsdWRlcyhcIlsuLi50cnVuY2F0ZWRcIiksIFwic2hvdWxkIHRydW5jYXRlIHdoZW4gY29udGVudCBleGNlZWRzIDEyOEsgYnVkZ2V0XCIpO1xuICAgICAgYXNzZXJ0Lm9rKHJlc3VsdC5kcm9wcGVkU2VjdGlvbnMgPiAwLCBcInNob3VsZCByZXBvcnQgZHJvcHBlZCBzZWN0aW9uc1wiKTtcbiAgICB9XG4gIH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBSZWdyZXNzaW9uOiBwcm9tcHQgYnVpbGRlcnMgbXVzdCB0aHJlYWQgbW9kZWxSZWdpc3RyeSArIHNlc3Npb25Db250ZXh0V2luZG93IChpc3N1ZSAjNDE0MikgXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwicHJvbXB0LWJ1ZGdldDogbW9kZWxSZWdpc3RyeSArIHNlc3Npb25Db250ZXh0V2luZG93IGJlaGF2aW9yXCIsICgpID0+IHtcbiAgaXQoXCJidWlsZFBsYW5TbGljZVByb21wdCBvdXRwdXQgY2hhbmdlcyB3aGVuIHNlc3Npb25Db250ZXh0V2luZG93IGNoYW5nZXNcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBzZXR1cERlcGVuZGVuY3lGaXh0dXJlKGJhc2UsIFwiTTAwMVwiLCBcIlMwMVwiLCBbXCJTMDBcIl0sIHsgUzAwOiBcIiMjIyBSZXN1bHRzXFxuXFxuRG9uZS5cIiB9KTtcbiAgICAgIGNvbnN0IHNtYWxsID0gYXdhaXQgYnVpbGRQbGFuU2xpY2VQcm9tcHQoXCJNMDAxXCIsIFwiTWlsZXN0b25lXCIsIFwiUzAxXCIsIFwiQ3VycmVudCBzbGljZVwiLCBiYXNlLCBcIm1pbmltYWxcIiwge1xuICAgICAgICBzZXNzaW9uQ29udGV4dFdpbmRvdzogMTI4XzAwMCxcbiAgICAgIH0pO1xuICAgICAgY29uc3QgbGFyZ2UgPSBhd2FpdCBidWlsZFBsYW5TbGljZVByb21wdChcIk0wMDFcIiwgXCJNaWxlc3RvbmVcIiwgXCJTMDFcIiwgXCJDdXJyZW50IHNsaWNlXCIsIGJhc2UsIFwibWluaW1hbFwiLCB7XG4gICAgICAgIHNlc3Npb25Db250ZXh0V2luZG93OiAxXzAwMF8wMDAsXG4gICAgICB9KTtcblxuICAgICAgYXNzZXJ0Lm1hdGNoKHNtYWxsLCAvMTI4SyB0b2tlbi8pO1xuICAgICAgYXNzZXJ0Lm1hdGNoKGxhcmdlLCAvMTAwMEsgdG9rZW4vKTtcbiAgICAgIGFzc2VydC5ub3RFcXVhbChzbWFsbCwgbGFyZ2UpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgaXQoXCJidWlsZEV4ZWN1dGVUYXNrUHJvbXB0IG91dHB1dCBjaGFuZ2VzIHdoZW4gc2Vzc2lvbkNvbnRleHRXaW5kb3cgY2hhbmdlc1wiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHNsaWNlRGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiKTtcbiAgICAgIGNvbnN0IHRhc2tEaXIgPSBqb2luKHNsaWNlRGlyLCBcInRhc2tzXCIpO1xuICAgICAgbWtkaXJTeW5jKHRhc2tEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwiTTAwMS1ST0FETUFQLm1kXCIpLCBcIiMgUm9hZG1hcFxcblwiKTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihzbGljZURpciwgXCJTMDEtUExBTi5tZFwiKSwgXCIjIFNsaWNlIFBsYW5cXG5cIik7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4odGFza0RpciwgXCJUMDEtUExBTi5tZFwiKSwgXCIjIFRhc2sgUGxhblxcblwiKTtcblxuICAgICAgY29uc3Qgc21hbGwgPSBhd2FpdCBidWlsZEV4ZWN1dGVUYXNrUHJvbXB0KFwiTTAwMVwiLCBcIlMwMVwiLCBcIlNsaWNlXCIsIFwiVDAxXCIsIFwiVGFza1wiLCBiYXNlLCB7XG4gICAgICAgIGxldmVsOiBcIm1pbmltYWxcIixcbiAgICAgICAgc2Vzc2lvbkNvbnRleHRXaW5kb3c6IDEyOF8wMDAsXG4gICAgICB9KTtcbiAgICAgIGNvbnN0IGxhcmdlID0gYXdhaXQgYnVpbGRFeGVjdXRlVGFza1Byb21wdChcIk0wMDFcIiwgXCJTMDFcIiwgXCJTbGljZVwiLCBcIlQwMVwiLCBcIlRhc2tcIiwgYmFzZSwge1xuICAgICAgICBsZXZlbDogXCJtaW5pbWFsXCIsXG4gICAgICAgIHNlc3Npb25Db250ZXh0V2luZG93OiAxXzAwMF8wMDAsXG4gICAgICB9KTtcblxuICAgICAgYXNzZXJ0Lm1hdGNoKHNtYWxsLCAvfjUxSyBjaGFycy8pO1xuICAgICAgYXNzZXJ0Lm1hdGNoKGxhcmdlLCAvfjQwMEsgY2hhcnMvKTtcbiAgICAgIGFzc2VydC5ub3RFcXVhbChzbWFsbCwgbGFyZ2UpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQU9BLFNBQVMsVUFBVSxJQUFJLFlBQVksaUJBQWlCO0FBQ3BELE9BQU8sWUFBWTtBQUNuQixTQUFTLGFBQWEsV0FBVyxRQUFRLHFCQUFxQjtBQUM5RCxTQUFTLE1BQU0sZUFBZTtBQUM5QixTQUFTLGNBQWM7QUFDdkIsU0FBUyxxQkFBcUI7QUFFOUIsU0FBUyx3QkFBd0Isc0JBQXNCLGlDQUFpQztBQUN4RixTQUFTLGdCQUFnQixpQ0FBaUM7QUFFMUQsTUFBTSxZQUFZLFFBQVEsY0FBYyxZQUFZLEdBQUcsQ0FBQztBQUl4RCxTQUFTLG9CQUE0QjtBQUNuQyxTQUFPLFlBQVksS0FBSyxPQUFPLEdBQUcseUJBQXlCLENBQUM7QUFDOUQ7QUFFQSxTQUFTLFFBQVEsTUFBb0I7QUFDbkMsU0FBTyxNQUFNLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQy9DO0FBTUEsU0FBUyx1QkFDUCxNQUNBLEtBQ0EsS0FDQSxNQUNBLFdBQ007QUFDTixRQUFNLFFBQVEsS0FBSyxNQUFNLFFBQVEsY0FBYyxHQUFHO0FBQ2xELFlBQVUsT0FBTyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBR3BDLFFBQU0sU0FBUyxLQUFLLEtBQUssSUFBSTtBQUM3QixRQUFNLGFBQWE7QUFBQSxJQUNq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
