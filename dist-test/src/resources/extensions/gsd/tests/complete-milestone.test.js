import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseUnitId } from "../unit-id.js";
import { openDatabase, closeDatabase, insertMilestone, insertSlice, insertTask } from "../gsd-db.js";
import { clearPathCache } from "../paths.js";
import { clearParseCache } from "../files.js";
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
  const base = mkdtempSync(join(tmpdir(), "gsd-complete-ms-test-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}
function writeRoadmap(base, mid, content) {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-ROADMAP.md`), content);
}
function writeMilestoneSummary(base, mid, content) {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-SUMMARY.md`), content);
}
function writeMilestoneValidation(base, mid, verdict = "pass") {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-VALIDATION.md`), `---
verdict: ${verdict}
remediation_round: 0
---

# Validation
Validated.`);
}
function cleanup(base) {
  rmSync(base, { recursive: true, force: true });
}
describe("complete-milestone", () => {
  test("prompt template exists and loads", () => {
    let result;
    let threw = false;
    try {
      result = loadPromptFromWorktree("complete-milestone", {
        workingDirectory: "/tmp/test-project",
        milestoneId: "M001",
        milestoneTitle: "Test Milestone",
        roadmapPath: ".gsd/milestones/M001/M001-ROADMAP.md",
        inlinedContext: "test context block"
      });
    } catch (err) {
      threw = true;
      result = "";
    }
    assert.ok(!threw, "loadPrompt does not throw for complete-milestone");
    assert.ok(typeof result === "string" && result.length > 0, "loadPrompt returns a non-empty string");
  });
  test("prompt variable substitution", () => {
    const prompt = loadPromptFromWorktree("complete-milestone", {
      workingDirectory: "/tmp/test-project",
      milestoneId: "M001",
      milestoneTitle: "Integration Feature",
      roadmapPath: ".gsd/milestones/M001/M001-ROADMAP.md",
      inlinedContext: "--- inlined slice summaries and context ---"
    });
    assert.ok(prompt.includes("M001"), "prompt contains milestoneId 'M001'");
    assert.ok(prompt.includes("Integration Feature"), "prompt contains milestoneTitle");
    assert.ok(prompt.includes(".gsd/milestones/M001/M001-ROADMAP.md"), "prompt contains roadmapPath");
    assert.ok(prompt.includes("--- inlined slice summaries and context ---"), "prompt contains inlinedContext");
    assert.ok(!prompt.includes("{{milestoneId}}"), "no un-substituted {{milestoneId}}");
    assert.ok(!prompt.includes("{{milestoneTitle}}"), "no un-substituted {{milestoneTitle}}");
    assert.ok(!prompt.includes("{{roadmapPath}}"), "no un-substituted {{roadmapPath}}");
    assert.ok(!prompt.includes("{{inlinedContext}}"), "no un-substituted {{inlinedContext}}");
  });
  test("prompt content integrity", () => {
    const prompt = loadPromptFromWorktree("complete-milestone", {
      workingDirectory: "/tmp/test-project",
      milestoneId: "M002",
      milestoneTitle: "Completion Workflow",
      roadmapPath: ".gsd/milestones/M002/M002-ROADMAP.md",
      inlinedContext: "context"
    });
    assert.ok(prompt.includes("Complete Milestone"), "prompt contains 'Complete Milestone' heading");
    assert.ok(prompt.includes("success criter") || prompt.includes("success criteria"), "prompt mentions success criteria verification");
    assert.ok(prompt.includes("milestone-summary") || prompt.includes("milestoneSummary"), "prompt references milestone summary artifact");
    assert.ok(prompt.includes("Milestone M002 complete"), "prompt contains completion sentinel for M002");
  });
  test("prompt contains verification gate that blocks completion on failure", () => {
    const prompt = loadPromptFromWorktree("complete-milestone", {
      workingDirectory: "/tmp/test-project",
      milestoneId: "M001",
      milestoneTitle: "Gate Test",
      roadmapPath: ".gsd/milestones/M001/M001-ROADMAP.md",
      inlinedContext: "context"
    });
    assert.ok(
      prompt.includes("Verification Gate"),
      "prompt contains 'Verification Gate' section"
    );
    assert.ok(
      prompt.includes("Do NOT call `gsd_complete_milestone`"),
      "failure path explicitly blocks calling the completion tool"
    );
    assert.ok(
      prompt.includes("verification FAILED"),
      "failure path outputs a FAILED sentinel"
    );
    assert.ok(
      prompt.includes("verificationPassed"),
      "prompt references verificationPassed parameter"
    );
  });
  test("prompt does not hard-fail main self-diff as missing implementation (#4699)", () => {
    const prompt = loadPromptFromWorktree("complete-milestone", {
      workingDirectory: "/tmp/test-project",
      milestoneId: "M001",
      milestoneTitle: "Main Retry Test",
      roadmapPath: ".gsd/milestones/M001/M001-ROADMAP.md",
      inlinedContext: "context"
    });
    assert.ok(
      !prompt.includes("git diff --stat HEAD $(git merge-base HEAD main) -- ':!.gsd/'"),
      "prompt must not require the known self-diff command from #4699"
    );
    assert.match(
      prompt,
      /self-diff/i,
      "prompt should explicitly guard retries where HEAD and the integration branch are the same commit"
    );
    assert.match(
      prompt,
      /GSD-(?:Task|Unit)/,
      "prompt should direct main-branch retries toward milestone-scoped GSD commit evidence"
    );
  });
  test("handleCompleteMilestone rejects when verificationPassed is false", async () => {
    const { handleCompleteMilestone } = await import("../tools/complete-milestone.js");
    const base = createFixtureBase();
    try {
      const result = await handleCompleteMilestone({
        milestoneId: "M001",
        title: "Test Milestone",
        oneLiner: "Test",
        narrative: "Test narrative",
        successCriteriaResults: "None met",
        definitionOfDoneResults: "Incomplete",
        requirementOutcomes: "None validated",
        keyDecisions: [],
        keyFiles: [],
        lessonsLearned: [],
        followUps: "",
        deviations: "",
        verificationPassed: false
      }, base);
      assert.ok("error" in result, "returns error when verificationPassed is false");
      assert.ok(
        result.error.includes("verification did not pass"),
        "error message mentions verification did not pass"
      );
    } finally {
      cleanup(base);
    }
  });
  test("handleCompleteMilestone rejects when verificationPassed is omitted", async () => {
    const { handleCompleteMilestone } = await import("../tools/complete-milestone.js");
    const base = createFixtureBase();
    try {
      const params = {
        milestoneId: "M001",
        title: "Test Milestone",
        oneLiner: "Test",
        narrative: "Test narrative",
        successCriteriaResults: "Results",
        definitionOfDoneResults: "Done results",
        requirementOutcomes: "Outcomes",
        keyDecisions: [],
        keyFiles: [],
        lessonsLearned: [],
        followUps: "",
        deviations: ""
        // verificationPassed intentionally omitted
      };
      const result = await handleCompleteMilestone(params, base);
      assert.ok("error" in result, "returns error when verificationPassed is omitted");
      assert.ok(
        result.error.includes("verification did not pass"),
        "error message mentions verification did not pass"
      );
    } finally {
      cleanup(base);
    }
  });
  test("diagnoseExpectedArtifact logic for complete-milestone", async () => {
    const { relMilestoneFile } = await import("../paths.js");
    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M001", `# M001

## Slices
- [x] **S01: Done** \`risk:low\` \`depends:[]\`
  > After this: done
`);
      const unitType = "complete-milestone";
      const unitId = "M001";
      const { milestone: mid } = parseUnitId(unitId);
      const result = `${relMilestoneFile(base, mid, "SUMMARY")} (milestone summary)`;
      assert.ok(typeof result === "string", "diagnose returns a string");
      assert.ok(result.includes("SUMMARY"), "diagnose result mentions SUMMARY");
      assert.ok(result.includes("milestone"), "diagnose result mentions milestone");
      assert.ok(result.includes("M001"), "diagnose result includes the milestone ID");
    } finally {
      cleanup(base);
    }
  });
  test("step 11 specifies write tool for PROJECT.md update (#2946)", () => {
    const prompt = loadPromptFromWorktree("complete-milestone", {
      workingDirectory: "/tmp/test-project",
      milestoneId: "M001",
      milestoneTitle: "Tool Guidance Test",
      roadmapPath: ".gsd/milestones/M001/M001-ROADMAP.md",
      inlinedContext: "context",
      milestoneSummaryPath: ".gsd/milestones/M001/M001-SUMMARY.md",
      skillActivation: ""
    });
    assert.ok(
      /PROJECT\.md.*\bwrite\b/i.test(prompt) || /\bwrite\b.*PROJECT\.md/i.test(prompt),
      "step 11 must name the `write` tool when updating PROJECT.md"
    );
    assert.ok(
      prompt.includes("`.gsd/PROJECT.md`") || prompt.includes('".gsd/PROJECT.md"'),
      "step 11 must reference the PROJECT.md path explicitly"
    );
  });
  test("sanitizeCompleteMilestoneParams normalizes string parameters", async () => {
    const { sanitizeCompleteMilestoneParams } = await import("../bootstrap/sanitize-complete-milestone.js");
    const raw = {
      milestoneId: "  M011 ",
      title: 42,
      // number instead of string
      oneLiner: "  One-liner with spaces  ",
      narrative: "# Big markdown\n\nWith newlines and `backticks`\n\n```ts\ncode();\n```\n",
      successCriteriaResults: null,
      // null instead of string
      definitionOfDoneResults: void 0,
      // undefined instead of string
      requirementOutcomes: 12345,
      // number instead of string
      keyDecisions: "not an array",
      // string instead of array
      keyFiles: null,
      // null instead of array
      lessonsLearned: [" lesson one ", null, "", "  lesson two  "],
      followUps: "  follow up  ",
      deviations: void 0,
      verificationPassed: "true"
      // string instead of boolean
    };
    const sanitized = sanitizeCompleteMilestoneParams(raw);
    assert.strictEqual(sanitized.milestoneId, "M011");
    assert.strictEqual(sanitized.title, "42");
    assert.strictEqual(sanitized.oneLiner, "One-liner with spaces");
    assert.ok(sanitized.narrative.includes("# Big markdown"), "narrative preserves markdown");
    assert.strictEqual(sanitized.successCriteriaResults, "");
    assert.strictEqual(sanitized.definitionOfDoneResults, "");
    assert.strictEqual(sanitized.requirementOutcomes, "12345");
    assert.ok(Array.isArray(sanitized.keyDecisions), "keyDecisions is an array");
    assert.deepStrictEqual(sanitized.keyDecisions, []);
    assert.ok(Array.isArray(sanitized.keyFiles), "keyFiles is an array");
    assert.deepStrictEqual(sanitized.keyFiles, []);
    assert.deepStrictEqual(sanitized.lessonsLearned, ["lesson one", "lesson two"]);
    assert.strictEqual(sanitized.followUps, "follow up");
    assert.strictEqual(sanitized.deviations, "");
    assert.strictEqual(sanitized.verificationPassed, true);
  });
  test("sanitizeCompleteMilestoneParams handles large markdown content", async () => {
    const { sanitizeCompleteMilestoneParams } = await import("../bootstrap/sanitize-complete-milestone.js");
    const largeMd = "# Milestone Summary\n\n" + Array.from(
      { length: 500 },
      (_, i) => `## Section ${i}

- [x] Task ${i} completed with \`code\` and **bold** text
  - Sub-item with special chars: <, >, &, ", '
  - Another sub-item: \`\`\`ts
const x = ${i};
\`\`\`
`
    ).join("\n");
    assert.ok(largeMd.length > 23667, `generated markdown is ${largeMd.length} chars, must exceed 23667`);
    const raw = {
      milestoneId: "M011",
      title: "Content Depth, Narrative & Onboarding",
      oneLiner: "Large milestone with many slices",
      narrative: largeMd,
      successCriteriaResults: largeMd,
      definitionOfDoneResults: largeMd,
      requirementOutcomes: largeMd,
      keyDecisions: ["decision 1", "decision 2"],
      keyFiles: ["file1.ts", "file2.ts"],
      lessonsLearned: ["lesson 1"],
      followUps: "Some follow-ups",
      deviations: "Some deviations",
      verificationPassed: true
    };
    const sanitized = sanitizeCompleteMilestoneParams(raw);
    assert.strictEqual(sanitized.narrative, largeMd.trim());
    assert.strictEqual(sanitized.successCriteriaResults, largeMd.trim());
    assert.strictEqual(sanitized.definitionOfDoneResults, largeMd.trim());
    assert.strictEqual(sanitized.requirementOutcomes, largeMd.trim());
  });
  test("milestoneCompleteExecute uses sanitized params", async () => {
    const { handleCompleteMilestone } = await import("../tools/complete-milestone.js");
    const { sanitizeCompleteMilestoneParams } = await import("../bootstrap/sanitize-complete-milestone.js");
    const base = createFixtureBase();
    try {
      const raw = {
        milestoneId: 42,
        // number — would crash without sanitization
        title: "Test",
        oneLiner: "Test",
        narrative: "Test narrative",
        successCriteriaResults: "Results",
        definitionOfDoneResults: "Done",
        requirementOutcomes: "Outcomes",
        keyDecisions: null,
        // null — would crash .length without sanitization
        keyFiles: "not-array",
        // string — would crash .map without sanitization
        lessonsLearned: void 0,
        // undefined — would crash .map without sanitization
        followUps: "",
        deviations: "",
        verificationPassed: true
      };
      const sanitized = sanitizeCompleteMilestoneParams(raw);
      assert.strictEqual(typeof sanitized.milestoneId, "string", "milestoneId is a string after sanitization");
      assert.ok(Array.isArray(sanitized.keyDecisions), "keyDecisions is array after sanitization");
      assert.ok(Array.isArray(sanitized.keyFiles), "keyFiles is array after sanitization");
      assert.ok(Array.isArray(sanitized.lessonsLearned), "lessonsLearned is array after sanitization");
      assert.strictEqual(typeof sanitized.verificationPassed, "boolean", "verificationPassed is boolean after sanitization");
      try {
        await handleCompleteMilestone(sanitized, base);
      } catch (err) {
        assert.ok(
          err.code === "GSD_STALE_STATE" || err.message?.includes("database"),
          `expected DB error, got: ${err.message}`
        );
      }
    } finally {
      cleanup(base);
    }
  });
  test("handleCompleteMilestone treats already-complete milestone as idempotent re-dispatch (#4598)", async () => {
    const { handleCompleteMilestone } = await import("../tools/complete-milestone.js");
    const base = createFixtureBase();
    const mid = "M001";
    const dbPath = join(base, ".gsd", "gsd.db");
    try {
      openDatabase(dbPath);
      insertMilestone({ id: mid, title: "Test Milestone", status: "complete" });
      insertSlice({ id: "S01", milestoneId: mid, title: "Slice One", status: "complete" });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: mid, title: "Task One", status: "complete" });
      const milestoneDir = join(base, ".gsd", "milestones", mid);
      mkdirSync(milestoneDir, { recursive: true });
      const summaryPath = join(milestoneDir, `${mid}-SUMMARY.md`);
      const originalContent = "original content \u2014 must not be overwritten";
      writeFileSync(summaryPath, originalContent, "utf-8");
      const params = {
        milestoneId: mid,
        title: "Test Milestone",
        oneLiner: "Re-dispatched",
        narrative: "This is a re-dispatch",
        successCriteriaResults: "Met",
        definitionOfDoneResults: "Done",
        requirementOutcomes: "Covered",
        keyDecisions: [],
        keyFiles: [],
        lessonsLearned: [],
        followUps: "",
        deviations: "",
        verificationPassed: true
      };
      const result = await handleCompleteMilestone(params, base);
      assert.ok(!("error" in result), `already-complete re-dispatch should succeed: ${JSON.stringify(result)}`);
      assert.equal(result.alreadyComplete, true);
      const actualContent = readFileSync(summaryPath, "utf-8");
      assert.strictEqual(
        actualContent,
        originalContent,
        "existing SUMMARY.md must not be overwritten on re-dispatch (#4598)"
      );
      const repeatResult = await handleCompleteMilestone(params, base);
      assert.ok(!("error" in repeatResult), "repeated re-dispatch should also succeed");
      assert.strictEqual(repeatResult.alreadyComplete, true, "repeated re-dispatch is identified as already-complete");
      assert.ok(
        repeatResult.summaryPath.endsWith(join(".gsd", "milestones", mid, `${mid}-SUMMARY.md`)),
        "repeated re-dispatch returns the existing summary path"
      );
      assert.strictEqual(
        readFileSync(summaryPath, "utf-8"),
        originalContent,
        "repeated re-dispatch must not overwrite SUMMARY.md"
      );
    } finally {
      try {
        closeDatabase();
      } catch {
      }
      clearPathCache();
      clearParseCache();
      cleanup(base);
    }
  });
  test("deriveState completing-milestone integration", async () => {
    const { deriveState, isMilestoneComplete } = await import("../state.js");
    const { invalidateAllCaches: invalidateAllCachesDynamic } = await import("../cache.js");
    const { parseRoadmap } = await import("../parsers-legacy.js");
    const base = createFixtureBase();
    try {
      writeRoadmap(base, "M001", `# M001: Integration Test

**Vision:** Test completing-milestone flow.

## Slices

- [x] **S01: Slice One** \`risk:low\` \`depends:[]\`
  > After this: done.

- [x] **S02: Slice Two** \`risk:low\` \`depends:[S01]\`
  > After this: done.
`);
      const { loadFile } = await import("../files.js");
      const roadmapPath = join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md");
      const roadmapContent = await loadFile(roadmapPath);
      const roadmap = parseRoadmap(roadmapContent);
      assert.ok(isMilestoneComplete(roadmap), "isMilestoneComplete returns true when all slices are [x]");
      writeMilestoneValidation(base, "M001");
      const state = await deriveState(base);
      assert.strictEqual(state.phase, "completing-milestone", "deriveState returns completing-milestone when all slices done, no summary");
      assert.strictEqual(state.activeMilestone?.id, "M001", "active milestone is M001");
      assert.strictEqual(state.activeSlice, null, "no active slice in completing-milestone");
      writeMilestoneSummary(base, "M001", "# M001 Summary\n\nDone.");
      invalidateAllCachesDynamic();
      const stateAfter = await deriveState(base);
      assert.strictEqual(stateAfter.phase, "complete", "deriveState returns complete after summary exists");
      assert.strictEqual(stateAfter.registry[0]?.status, "complete", "registry shows complete status");
    } finally {
      cleanup(base);
    }
  });
  test("verification-gate step numbers match the actual numbered verification steps", () => {
    const prompt = loadPromptFromWorktree("complete-milestone", {
      workingDirectory: "/tmp/test-project",
      milestoneId: "M001",
      milestoneTitle: "Step Number Drift",
      roadmapPath: ".gsd/milestones/M001/M001-ROADMAP.md",
      inlinedContext: "context",
      milestoneSummaryPath: ".gsd/milestones/M001/M001-SUMMARY.md",
      skillActivation: "{{skillActivation block}}",
      extractLearningsSteps: "{{extract learnings block}}"
    });
    function findStep(needle) {
      const lines = prompt.split("\n");
      for (const line of lines) {
        const m = /^(\d+)\.\s/.exec(line);
        if (m && needle.test(line)) return Number(m[1]);
      }
      throw new Error(`no numbered step matches ${needle}`);
    }
    const codeChange = findStep(/Verify code changes/);
    const successCriteria = findStep(/Verify every \*\*success criterion\*\*/);
    const defOfDone = findStep(/Verify \*\*definition of done\*\*/);
    const completeMilestone = findStep(/Persist completion through `gsd_complete_milestone`/);
    const requirementUpdate = findStep(/gsd_requirement_update/);
    const gateLine = prompt.split("\n").find((l) => l.includes("Verification failure was recorded") || l.includes("verification failure was recorded"));
    assert.ok(gateLine, "verification gate sentence is present");
    assert.ok(
      gateLine.includes(`steps ${codeChange}, ${successCriteria}, or ${defOfDone}`),
      `gate must cite verification steps ${codeChange}, ${successCriteria}, ${defOfDone}; got: ${gateLine}`
    );
    const proceedMatch = /Do NOT proceed with steps (\d+)[–-](\d+)/.exec(gateLine);
    assert.ok(proceedMatch, "gate must include a 'Do NOT proceed with steps X\u2013Y' clause");
    assert.ok(
      Number(proceedMatch[1]) > requirementUpdate - 1 && Number(proceedMatch[2]) >= completeMilestone,
      `'Do NOT proceed' range ${proceedMatch[1]}\u2013${proceedMatch[2]} must cover steps from after the gate through gsd_complete_milestone (${completeMilestone})`
    );
    const importantLine = prompt.split("\n").find((l) => l.includes("Do NOT skip code-change"));
    assert.ok(importantLine, "Important footer is present");
    assert.ok(
      importantLine.includes(`steps ${codeChange}-${defOfDone}`) || importantLine.includes(`steps ${codeChange}\u2013${defOfDone}`),
      `Important footer must cite verification range ${codeChange}-${defOfDone}; got: ${importantLine}`
    );
    const readOrderLine = prompt.split("\n").find((l) => l.includes("On-demand Read ordering"));
    assert.ok(readOrderLine, "On-demand Read ordering line is present");
    assert.ok(
      readOrderLine.includes(`(step ${completeMilestone})`),
      `On-demand Read ordering must cite step ${completeMilestone}; got: ${readOrderLine}`
    );
  });
  test("sanitizeCompleteMilestoneParams preserves actorName and triggerReason", async () => {
    const { sanitizeCompleteMilestoneParams } = await import("../bootstrap/sanitize-complete-milestone.js");
    const sanitized = sanitizeCompleteMilestoneParams({
      milestoneId: "M001",
      title: "T",
      oneLiner: "x",
      narrative: "n",
      verificationPassed: true,
      actorName: "  executor-01  ",
      triggerReason: " milestone validation passed "
    });
    assert.strictEqual(sanitized.actorName, "executor-01");
    assert.strictEqual(sanitized.triggerReason, "milestone validation passed");
  });
  test("sanitizeCompleteMilestoneParams omits blank actorName/triggerReason rather than emitting empty strings", async () => {
    const { sanitizeCompleteMilestoneParams } = await import("../bootstrap/sanitize-complete-milestone.js");
    const sanitized = sanitizeCompleteMilestoneParams({
      milestoneId: "M001",
      title: "T",
      oneLiner: "x",
      narrative: "n",
      verificationPassed: true
      // actorName/triggerReason omitted
    });
    assert.strictEqual(sanitized.actorName, void 0);
    assert.strictEqual(sanitized.triggerReason, void 0);
  });
  test("rendered SUMMARY.md uses empty frontmatter lists for empty key fields", async () => {
    const { handleCompleteMilestone } = await import("../tools/complete-milestone.js");
    const base = createFixtureBase();
    const mid = "M001";
    const dbPath = join(base, ".gsd", "gsd.db");
    try {
      openDatabase(dbPath);
      insertMilestone({ id: mid, title: "Empty Enrichment", status: "active" });
      insertSlice({ id: "S01", milestoneId: mid, title: "Slice", status: "complete" });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: mid, title: "Task", status: "complete" });
      const result = await handleCompleteMilestone({
        milestoneId: mid,
        title: "Empty Enrichment",
        oneLiner: "no enrichment",
        narrative: "did the thing",
        // enrichment fields intentionally empty (post-sanitizer state)
        successCriteriaResults: "",
        definitionOfDoneResults: "",
        requirementOutcomes: "",
        keyDecisions: [],
        keyFiles: [],
        lessonsLearned: [],
        followUps: "",
        deviations: "",
        verificationPassed: true
      }, base);
      assert.ok(!("error" in result), `handler should succeed: ${JSON.stringify(result)}`);
      const summary = readFileSync(result.summaryPath, "utf-8");
      assert.match(summary, /## Success Criteria Results\n\nNot provided\./);
      assert.match(summary, /## Definition of Done Results\n\nNot provided\./);
      assert.match(summary, /## Requirement Outcomes\n\nNot provided\./);
      assert.match(summary, /key_decisions:\s*\[\]/);
      assert.match(summary, /key_files:\s*\[\]/);
      assert.doesNotMatch(summary, /key_(?:decisions|files):\n  - \(none\)/);
      assert.match(summary, /## Deviations\n\nNone\./);
      assert.match(summary, /## Follow-ups\n\nNone\./);
    } finally {
      try {
        closeDatabase();
      } catch {
      }
      clearPathCache();
      clearParseCache();
      cleanup(base);
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jb21wbGV0ZS1taWxlc3RvbmUudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NEMiBjb21wbGV0ZS1taWxlc3RvbmUgdGVzdHNcbmltcG9ydCB7IGRlc2NyaWJlLCB0ZXN0LCBhZnRlckVhY2ggfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBta2RpclN5bmMsIHJlYWRGaWxlU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jLCBleGlzdHNTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4sIGRpcm5hbWUgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gXCJub2RlOnVybFwiO1xuaW1wb3J0IHsgaW52YWxpZGF0ZUFsbENhY2hlcyB9IGZyb20gJy4uL2NhY2hlLnRzJztcbmltcG9ydCB7IHBhcnNlVW5pdElkIH0gZnJvbSBcIi4uL3VuaXQtaWQudHNcIjtcbmltcG9ydCB7IG9wZW5EYXRhYmFzZSwgY2xvc2VEYXRhYmFzZSwgaW5zZXJ0TWlsZXN0b25lLCBpbnNlcnRTbGljZSwgaW5zZXJ0VGFzayB9IGZyb20gXCIuLi9nc2QtZGIudHNcIjtcbmltcG9ydCB7IGNsZWFyUGF0aENhY2hlIH0gZnJvbSBcIi4uL3BhdGhzLnRzXCI7XG5pbXBvcnQgeyBjbGVhclBhcnNlQ2FjaGUgfSBmcm9tIFwiLi4vZmlsZXMudHNcIjtcblxuLy8gbG9hZFByb21wdCByZWFkcyBmcm9tIH4vLmdzZC9hZ2VudC9leHRlbnNpb25zL2dzZC9wcm9tcHRzLyAobWFpbiBjaGVja291dCkuXG4vLyBJbiBhIHdvcmt0cmVlIHRoZSBmaWxlIG1heSBub3QgZXhpc3QgdGhlcmUgeWV0LCBzbyB3ZSByZXNvbHZlIHByb21wdHNcbi8vIHJlbGF0aXZlIHRvIHRoaXMgdGVzdCBmaWxlJ3MgbG9jYXRpb24gKHRoZSB3b3JrdHJlZSBjb3B5KS5cbmNvbnN0IF9fZGlybmFtZSA9IGRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcbmNvbnN0IHdvcmt0cmVlUHJvbXB0c0RpciA9IGpvaW4oX19kaXJuYW1lLCBcIi4uXCIsIFwicHJvbXB0c1wiKTtcblxuLyoqXG4gKiBMb2FkIGEgcHJvbXB0IHRlbXBsYXRlIGZyb20gdGhlIHdvcmt0cmVlIHByb21wdHMgZGlyZWN0b3J5XG4gKiBhbmQgYXBwbHkgdmFyaWFibGUgc3Vic3RpdHV0aW9uIChtaXJyb3JzIGxvYWRQcm9tcHQgbG9naWMpLlxuICovXG5mdW5jdGlvbiBsb2FkUHJvbXB0RnJvbVdvcmt0cmVlKG5hbWU6IHN0cmluZywgdmFyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9KTogc3RyaW5nIHtcbiAgY29uc3QgcGF0aCA9IGpvaW4od29ya3RyZWVQcm9tcHRzRGlyLCBgJHtuYW1lfS5tZGApO1xuICBsZXQgY29udGVudCA9IHJlYWRGaWxlU3luYyhwYXRoLCBcInV0Zi04XCIpO1xuICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyh2YXJzKSkge1xuICAgIGNvbnRlbnQgPSBjb250ZW50LnJlcGxhY2VBbGwoYHt7JHtrZXl9fX1gLCB2YWx1ZSk7XG4gIH1cbiAgcmV0dXJuIGNvbnRlbnQudHJpbSgpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRml4dHVyZSBIZWxwZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBjcmVhdGVGaXh0dXJlQmFzZSgpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtY29tcGxldGUtbXMtdGVzdC1cIikpO1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgcmV0dXJuIGJhc2U7XG59XG5cbmZ1bmN0aW9uIHdyaXRlUm9hZG1hcChiYXNlOiBzdHJpbmcsIG1pZDogc3RyaW5nLCBjb250ZW50OiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgZGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIG1pZCk7XG4gIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBgJHttaWR9LVJPQURNQVAubWRgKSwgY29udGVudCk7XG59XG5cbmZ1bmN0aW9uIHdyaXRlTWlsZXN0b25lU3VtbWFyeShiYXNlOiBzdHJpbmcsIG1pZDogc3RyaW5nLCBjb250ZW50OiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgZGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIG1pZCk7XG4gIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBgJHttaWR9LVNVTU1BUlkubWRgKSwgY29udGVudCk7XG59XG5cbmZ1bmN0aW9uIHdyaXRlTWlsZXN0b25lVmFsaWRhdGlvbihiYXNlOiBzdHJpbmcsIG1pZDogc3RyaW5nLCB2ZXJkaWN0OiBzdHJpbmcgPSBcInBhc3NcIik6IHZvaWQge1xuICBjb25zdCBkaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgbWlkKTtcbiAgbWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIGAke21pZH0tVkFMSURBVElPTi5tZGApLCBgLS0tXFxudmVyZGljdDogJHt2ZXJkaWN0fVxcbnJlbWVkaWF0aW9uX3JvdW5kOiAwXFxuLS0tXFxuXFxuIyBWYWxpZGF0aW9uXFxuVmFsaWRhdGVkLmApO1xufVxuXG5mdW5jdGlvbiBjbGVhbnVwKGJhc2U6IHN0cmluZyk6IHZvaWQge1xuICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xufVxuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIFRlc3RzXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuZGVzY3JpYmUoXCJjb21wbGV0ZS1taWxlc3RvbmVcIiwgKCkgPT4ge1xuXG4gIHRlc3QoXCJwcm9tcHQgdGVtcGxhdGUgZXhpc3RzIGFuZCBsb2Fkc1wiLCAoKSA9PiB7XG4gICAgbGV0IHJlc3VsdDogc3RyaW5nO1xuICAgIGxldCB0aHJldyA9IGZhbHNlO1xuICAgIHRyeSB7XG4gICAgICByZXN1bHQgPSBsb2FkUHJvbXB0RnJvbVdvcmt0cmVlKFwiY29tcGxldGUtbWlsZXN0b25lXCIsIHtcbiAgICAgICAgd29ya2luZ0RpcmVjdG9yeTogXCIvdG1wL3Rlc3QtcHJvamVjdFwiLFxuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICAgIG1pbGVzdG9uZVRpdGxlOiBcIlRlc3QgTWlsZXN0b25lXCIsXG4gICAgICAgIHJvYWRtYXBQYXRoOiBcIi5nc2QvbWlsZXN0b25lcy9NMDAxL00wMDEtUk9BRE1BUC5tZFwiLFxuICAgICAgICBpbmxpbmVkQ29udGV4dDogXCJ0ZXN0IGNvbnRleHQgYmxvY2tcIixcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgdGhyZXcgPSB0cnVlO1xuICAgICAgcmVzdWx0ID0gXCJcIjtcbiAgICB9XG5cbiAgICBhc3NlcnQub2soIXRocmV3LCBcImxvYWRQcm9tcHQgZG9lcyBub3QgdGhyb3cgZm9yIGNvbXBsZXRlLW1pbGVzdG9uZVwiKTtcbiAgICBhc3NlcnQub2sodHlwZW9mIHJlc3VsdCA9PT0gXCJzdHJpbmdcIiAmJiByZXN1bHQubGVuZ3RoID4gMCwgXCJsb2FkUHJvbXB0IHJldHVybnMgYSBub24tZW1wdHkgc3RyaW5nXCIpO1xuICB9KTtcblxuICB0ZXN0KFwicHJvbXB0IHZhcmlhYmxlIHN1YnN0aXR1dGlvblwiLCAoKSA9PiB7XG4gICAgY29uc3QgcHJvbXB0ID0gbG9hZFByb21wdEZyb21Xb3JrdHJlZShcImNvbXBsZXRlLW1pbGVzdG9uZVwiLCB7XG4gICAgICB3b3JraW5nRGlyZWN0b3J5OiBcIi90bXAvdGVzdC1wcm9qZWN0XCIsXG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICBtaWxlc3RvbmVUaXRsZTogXCJJbnRlZ3JhdGlvbiBGZWF0dXJlXCIsXG4gICAgICByb2FkbWFwUGF0aDogXCIuZ3NkL21pbGVzdG9uZXMvTTAwMS9NMDAxLVJPQURNQVAubWRcIixcbiAgICAgIGlubGluZWRDb250ZXh0OiBcIi0tLSBpbmxpbmVkIHNsaWNlIHN1bW1hcmllcyBhbmQgY29udGV4dCAtLS1cIixcbiAgICB9KTtcblxuICAgIGFzc2VydC5vayhwcm9tcHQuaW5jbHVkZXMoXCJNMDAxXCIpLCBcInByb21wdCBjb250YWlucyBtaWxlc3RvbmVJZCAnTTAwMSdcIik7XG4gICAgYXNzZXJ0Lm9rKHByb21wdC5pbmNsdWRlcyhcIkludGVncmF0aW9uIEZlYXR1cmVcIiksIFwicHJvbXB0IGNvbnRhaW5zIG1pbGVzdG9uZVRpdGxlXCIpO1xuICAgIGFzc2VydC5vayhwcm9tcHQuaW5jbHVkZXMoXCIuZ3NkL21pbGVzdG9uZXMvTTAwMS9NMDAxLVJPQURNQVAubWRcIiksIFwicHJvbXB0IGNvbnRhaW5zIHJvYWRtYXBQYXRoXCIpO1xuICAgIGFzc2VydC5vayhwcm9tcHQuaW5jbHVkZXMoXCItLS0gaW5saW5lZCBzbGljZSBzdW1tYXJpZXMgYW5kIGNvbnRleHQgLS0tXCIpLCBcInByb21wdCBjb250YWlucyBpbmxpbmVkQ29udGV4dFwiKTtcbiAgICBhc3NlcnQub2soIXByb21wdC5pbmNsdWRlcyhcInt7bWlsZXN0b25lSWR9fVwiKSwgXCJubyB1bi1zdWJzdGl0dXRlZCB7e21pbGVzdG9uZUlkfX1cIik7XG4gICAgYXNzZXJ0Lm9rKCFwcm9tcHQuaW5jbHVkZXMoXCJ7e21pbGVzdG9uZVRpdGxlfX1cIiksIFwibm8gdW4tc3Vic3RpdHV0ZWQge3ttaWxlc3RvbmVUaXRsZX19XCIpO1xuICAgIGFzc2VydC5vayghcHJvbXB0LmluY2x1ZGVzKFwie3tyb2FkbWFwUGF0aH19XCIpLCBcIm5vIHVuLXN1YnN0aXR1dGVkIHt7cm9hZG1hcFBhdGh9fVwiKTtcbiAgICBhc3NlcnQub2soIXByb21wdC5pbmNsdWRlcyhcInt7aW5saW5lZENvbnRleHR9fVwiKSwgXCJubyB1bi1zdWJzdGl0dXRlZCB7e2lubGluZWRDb250ZXh0fX1cIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJwcm9tcHQgY29udGVudCBpbnRlZ3JpdHlcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHByb21wdCA9IGxvYWRQcm9tcHRGcm9tV29ya3RyZWUoXCJjb21wbGV0ZS1taWxlc3RvbmVcIiwge1xuICAgICAgd29ya2luZ0RpcmVjdG9yeTogXCIvdG1wL3Rlc3QtcHJvamVjdFwiLFxuICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMlwiLFxuICAgICAgbWlsZXN0b25lVGl0bGU6IFwiQ29tcGxldGlvbiBXb3JrZmxvd1wiLFxuICAgICAgcm9hZG1hcFBhdGg6IFwiLmdzZC9taWxlc3RvbmVzL00wMDIvTTAwMi1ST0FETUFQLm1kXCIsXG4gICAgICBpbmxpbmVkQ29udGV4dDogXCJjb250ZXh0XCIsXG4gICAgfSk7XG5cbiAgICBhc3NlcnQub2socHJvbXB0LmluY2x1ZGVzKFwiQ29tcGxldGUgTWlsZXN0b25lXCIpLCBcInByb21wdCBjb250YWlucyAnQ29tcGxldGUgTWlsZXN0b25lJyBoZWFkaW5nXCIpO1xuICAgIGFzc2VydC5vayhwcm9tcHQuaW5jbHVkZXMoXCJzdWNjZXNzIGNyaXRlclwiKSB8fCBwcm9tcHQuaW5jbHVkZXMoXCJzdWNjZXNzIGNyaXRlcmlhXCIpLCBcInByb21wdCBtZW50aW9ucyBzdWNjZXNzIGNyaXRlcmlhIHZlcmlmaWNhdGlvblwiKTtcbiAgICBhc3NlcnQub2socHJvbXB0LmluY2x1ZGVzKFwibWlsZXN0b25lLXN1bW1hcnlcIikgfHwgcHJvbXB0LmluY2x1ZGVzKFwibWlsZXN0b25lU3VtbWFyeVwiKSwgXCJwcm9tcHQgcmVmZXJlbmNlcyBtaWxlc3RvbmUgc3VtbWFyeSBhcnRpZmFjdFwiKTtcbiAgICBhc3NlcnQub2socHJvbXB0LmluY2x1ZGVzKFwiTWlsZXN0b25lIE0wMDIgY29tcGxldGVcIiksIFwicHJvbXB0IGNvbnRhaW5zIGNvbXBsZXRpb24gc2VudGluZWwgZm9yIE0wMDJcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJwcm9tcHQgY29udGFpbnMgdmVyaWZpY2F0aW9uIGdhdGUgdGhhdCBibG9ja3MgY29tcGxldGlvbiBvbiBmYWlsdXJlXCIsICgpID0+IHtcbiAgICBjb25zdCBwcm9tcHQgPSBsb2FkUHJvbXB0RnJvbVdvcmt0cmVlKFwiY29tcGxldGUtbWlsZXN0b25lXCIsIHtcbiAgICAgIHdvcmtpbmdEaXJlY3Rvcnk6IFwiL3RtcC90ZXN0LXByb2plY3RcIixcbiAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICAgIG1pbGVzdG9uZVRpdGxlOiBcIkdhdGUgVGVzdFwiLFxuICAgICAgcm9hZG1hcFBhdGg6IFwiLmdzZC9taWxlc3RvbmVzL00wMDEvTTAwMS1ST0FETUFQLm1kXCIsXG4gICAgICBpbmxpbmVkQ29udGV4dDogXCJjb250ZXh0XCIsXG4gICAgfSk7XG5cbiAgICAvLyBWZXJpZmljYXRpb24gZ2F0ZSBzZWN0aW9uIG11c3QgZXhpc3RcbiAgICBhc3NlcnQub2soXG4gICAgICBwcm9tcHQuaW5jbHVkZXMoXCJWZXJpZmljYXRpb24gR2F0ZVwiKSxcbiAgICAgIFwicHJvbXB0IGNvbnRhaW5zICdWZXJpZmljYXRpb24gR2F0ZScgc2VjdGlvblwiLFxuICAgICk7XG5cbiAgICAvLyBGYWlsdXJlIHBhdGggbXVzdCBibG9jayBnc2RfY29tcGxldGVfbWlsZXN0b25lXG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgcHJvbXB0LmluY2x1ZGVzKFwiRG8gTk9UIGNhbGwgYGdzZF9jb21wbGV0ZV9taWxlc3RvbmVgXCIpLFxuICAgICAgXCJmYWlsdXJlIHBhdGggZXhwbGljaXRseSBibG9ja3MgY2FsbGluZyB0aGUgY29tcGxldGlvbiB0b29sXCIsXG4gICAgKTtcblxuICAgIC8vIEZhaWx1cmUgcGF0aCBtdXN0IGhhdmUgaXRzIG93biBzZW50aW5lbCBkaXN0aW5jdCBmcm9tIHN1Y2Nlc3NcbiAgICBhc3NlcnQub2soXG4gICAgICBwcm9tcHQuaW5jbHVkZXMoXCJ2ZXJpZmljYXRpb24gRkFJTEVEXCIpLFxuICAgICAgXCJmYWlsdXJlIHBhdGggb3V0cHV0cyBhIEZBSUxFRCBzZW50aW5lbFwiLFxuICAgICk7XG5cbiAgICAvLyB2ZXJpZmljYXRpb25QYXNzZWQgcGFyYW1ldGVyIG11c3QgYmUgcmVmZXJlbmNlZFxuICAgIGFzc2VydC5vayhcbiAgICAgIHByb21wdC5pbmNsdWRlcyhcInZlcmlmaWNhdGlvblBhc3NlZFwiKSxcbiAgICAgIFwicHJvbXB0IHJlZmVyZW5jZXMgdmVyaWZpY2F0aW9uUGFzc2VkIHBhcmFtZXRlclwiLFxuICAgICk7XG4gIH0pO1xuXG4gIHRlc3QoXCJwcm9tcHQgZG9lcyBub3QgaGFyZC1mYWlsIG1haW4gc2VsZi1kaWZmIGFzIG1pc3NpbmcgaW1wbGVtZW50YXRpb24gKCM0Njk5KVwiLCAoKSA9PiB7XG4gICAgY29uc3QgcHJvbXB0ID0gbG9hZFByb21wdEZyb21Xb3JrdHJlZShcImNvbXBsZXRlLW1pbGVzdG9uZVwiLCB7XG4gICAgICB3b3JraW5nRGlyZWN0b3J5OiBcIi90bXAvdGVzdC1wcm9qZWN0XCIsXG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICBtaWxlc3RvbmVUaXRsZTogXCJNYWluIFJldHJ5IFRlc3RcIixcbiAgICAgIHJvYWRtYXBQYXRoOiBcIi5nc2QvbWlsZXN0b25lcy9NMDAxL00wMDEtUk9BRE1BUC5tZFwiLFxuICAgICAgaW5saW5lZENvbnRleHQ6IFwiY29udGV4dFwiLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgIXByb21wdC5pbmNsdWRlcyhcImdpdCBkaWZmIC0tc3RhdCBIRUFEICQoZ2l0IG1lcmdlLWJhc2UgSEVBRCBtYWluKSAtLSAnOiEuZ3NkLydcIiksXG4gICAgICBcInByb21wdCBtdXN0IG5vdCByZXF1aXJlIHRoZSBrbm93biBzZWxmLWRpZmYgY29tbWFuZCBmcm9tICM0Njk5XCIsXG4gICAgKTtcbiAgICBhc3NlcnQubWF0Y2goXG4gICAgICBwcm9tcHQsXG4gICAgICAvc2VsZi1kaWZmL2ksXG4gICAgICBcInByb21wdCBzaG91bGQgZXhwbGljaXRseSBndWFyZCByZXRyaWVzIHdoZXJlIEhFQUQgYW5kIHRoZSBpbnRlZ3JhdGlvbiBicmFuY2ggYXJlIHRoZSBzYW1lIGNvbW1pdFwiLFxuICAgICk7XG4gICAgYXNzZXJ0Lm1hdGNoKFxuICAgICAgcHJvbXB0LFxuICAgICAgL0dTRC0oPzpUYXNrfFVuaXQpLyxcbiAgICAgIFwicHJvbXB0IHNob3VsZCBkaXJlY3QgbWFpbi1icmFuY2ggcmV0cmllcyB0b3dhcmQgbWlsZXN0b25lLXNjb3BlZCBHU0QgY29tbWl0IGV2aWRlbmNlXCIsXG4gICAgKTtcbiAgfSk7XG5cbiAgdGVzdChcImhhbmRsZUNvbXBsZXRlTWlsZXN0b25lIHJlamVjdHMgd2hlbiB2ZXJpZmljYXRpb25QYXNzZWQgaXMgZmFsc2VcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHsgaGFuZGxlQ29tcGxldGVNaWxlc3RvbmUgfSA9IGF3YWl0IGltcG9ydChcIi4uL3Rvb2xzL2NvbXBsZXRlLW1pbGVzdG9uZS50c1wiKTtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlQ29tcGxldGVNaWxlc3RvbmUoe1xuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICAgIHRpdGxlOiBcIlRlc3QgTWlsZXN0b25lXCIsXG4gICAgICAgIG9uZUxpbmVyOiBcIlRlc3RcIixcbiAgICAgICAgbmFycmF0aXZlOiBcIlRlc3QgbmFycmF0aXZlXCIsXG4gICAgICAgIHN1Y2Nlc3NDcml0ZXJpYVJlc3VsdHM6IFwiTm9uZSBtZXRcIixcbiAgICAgICAgZGVmaW5pdGlvbk9mRG9uZVJlc3VsdHM6IFwiSW5jb21wbGV0ZVwiLFxuICAgICAgICByZXF1aXJlbWVudE91dGNvbWVzOiBcIk5vbmUgdmFsaWRhdGVkXCIsXG4gICAgICAgIGtleURlY2lzaW9uczogW10sXG4gICAgICAgIGtleUZpbGVzOiBbXSxcbiAgICAgICAgbGVzc29uc0xlYXJuZWQ6IFtdLFxuICAgICAgICBmb2xsb3dVcHM6IFwiXCIsXG4gICAgICAgIGRldmlhdGlvbnM6IFwiXCIsXG4gICAgICAgIHZlcmlmaWNhdGlvblBhc3NlZDogZmFsc2UsXG4gICAgICB9LCBiYXNlKTtcblxuICAgICAgYXNzZXJ0Lm9rKFwiZXJyb3JcIiBpbiByZXN1bHQsIFwicmV0dXJucyBlcnJvciB3aGVuIHZlcmlmaWNhdGlvblBhc3NlZCBpcyBmYWxzZVwiKTtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgKHJlc3VsdCBhcyB7IGVycm9yOiBzdHJpbmcgfSkuZXJyb3IuaW5jbHVkZXMoXCJ2ZXJpZmljYXRpb24gZGlkIG5vdCBwYXNzXCIpLFxuICAgICAgICBcImVycm9yIG1lc3NhZ2UgbWVudGlvbnMgdmVyaWZpY2F0aW9uIGRpZCBub3QgcGFzc1wiLFxuICAgICAgKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJoYW5kbGVDb21wbGV0ZU1pbGVzdG9uZSByZWplY3RzIHdoZW4gdmVyaWZpY2F0aW9uUGFzc2VkIGlzIG9taXR0ZWRcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHsgaGFuZGxlQ29tcGxldGVNaWxlc3RvbmUgfSA9IGF3YWl0IGltcG9ydChcIi4uL3Rvb2xzL2NvbXBsZXRlLW1pbGVzdG9uZS50c1wiKTtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgLy8gU2ltdWxhdGUgb21pdHRlZCB2ZXJpZmljYXRpb25QYXNzZWQgKHVuZGVmaW5lZCBjb2VyY2VkIHZpYSBhbnkpXG4gICAgICBjb25zdCBwYXJhbXM6IGFueSA9IHtcbiAgICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgICB0aXRsZTogXCJUZXN0IE1pbGVzdG9uZVwiLFxuICAgICAgICBvbmVMaW5lcjogXCJUZXN0XCIsXG4gICAgICAgIG5hcnJhdGl2ZTogXCJUZXN0IG5hcnJhdGl2ZVwiLFxuICAgICAgICBzdWNjZXNzQ3JpdGVyaWFSZXN1bHRzOiBcIlJlc3VsdHNcIixcbiAgICAgICAgZGVmaW5pdGlvbk9mRG9uZVJlc3VsdHM6IFwiRG9uZSByZXN1bHRzXCIsXG4gICAgICAgIHJlcXVpcmVtZW50T3V0Y29tZXM6IFwiT3V0Y29tZXNcIixcbiAgICAgICAga2V5RGVjaXNpb25zOiBbXSxcbiAgICAgICAga2V5RmlsZXM6IFtdLFxuICAgICAgICBsZXNzb25zTGVhcm5lZDogW10sXG4gICAgICAgIGZvbGxvd1VwczogXCJcIixcbiAgICAgICAgZGV2aWF0aW9uczogXCJcIixcbiAgICAgICAgLy8gdmVyaWZpY2F0aW9uUGFzc2VkIGludGVudGlvbmFsbHkgb21pdHRlZFxuICAgICAgfTtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZUNvbXBsZXRlTWlsZXN0b25lKHBhcmFtcywgYmFzZSk7XG5cbiAgICAgIGFzc2VydC5vayhcImVycm9yXCIgaW4gcmVzdWx0LCBcInJldHVybnMgZXJyb3Igd2hlbiB2ZXJpZmljYXRpb25QYXNzZWQgaXMgb21pdHRlZFwiKTtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgKHJlc3VsdCBhcyB7IGVycm9yOiBzdHJpbmcgfSkuZXJyb3IuaW5jbHVkZXMoXCJ2ZXJpZmljYXRpb24gZGlkIG5vdCBwYXNzXCIpLFxuICAgICAgICBcImVycm9yIG1lc3NhZ2UgbWVudGlvbnMgdmVyaWZpY2F0aW9uIGRpZCBub3QgcGFzc1wiLFxuICAgICAgKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJkaWFnbm9zZUV4cGVjdGVkQXJ0aWZhY3QgbG9naWMgZm9yIGNvbXBsZXRlLW1pbGVzdG9uZVwiLCBhc3luYyAoKSA9PiB7XG4gICAgLy8gSW1wb3J0IHRoZSBwYXRoIGhlbHBlcnMgdXNlZCBieSBkaWFnbm9zZUV4cGVjdGVkQXJ0aWZhY3RcbiAgICBjb25zdCB7IHJlbE1pbGVzdG9uZUZpbGUgfSA9IGF3YWl0IGltcG9ydChcIi4uL3BhdGhzLnRzXCIpO1xuXG4gICAgLy8gU2ltdWxhdGUgZGlhZ25vc2VFeHBlY3RlZEFydGlmYWN0KFwiY29tcGxldGUtbWlsZXN0b25lXCIsIFwiTTAwMVwiLCBiYXNlKSBsb2dpY1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICB3cml0ZVJvYWRtYXAoYmFzZSwgXCJNMDAxXCIsIGAjIE0wMDFcXG5cXG4jIyBTbGljZXNcXG4tIFt4XSAqKlMwMTogRG9uZSoqIFxcYHJpc2s6bG93XFxgIFxcYGRlcGVuZHM6W11cXGBcXG4gID4gQWZ0ZXIgdGhpczogZG9uZVxcbmApO1xuXG4gICAgICBjb25zdCB1bml0VHlwZSA9IFwiY29tcGxldGUtbWlsZXN0b25lXCI7XG4gICAgICBjb25zdCB1bml0SWQgPSBcIk0wMDFcIjtcbiAgICAgIGNvbnN0IHsgbWlsZXN0b25lOiBtaWQgfSA9IHBhcnNlVW5pdElkKHVuaXRJZCk7XG5cbiAgICAgIC8vIFRoaXMgaXMgdGhlIGV4YWN0IGxvZ2ljIGZyb20gZGlhZ25vc2VFeHBlY3RlZEFydGlmYWN0IGZvciBcImNvbXBsZXRlLW1pbGVzdG9uZVwiXG4gICAgICBjb25zdCByZXN1bHQgPSBgJHtyZWxNaWxlc3RvbmVGaWxlKGJhc2UsIG1pZCwgXCJTVU1NQVJZXCIpfSAobWlsZXN0b25lIHN1bW1hcnkpYDtcblxuICAgICAgYXNzZXJ0Lm9rKHR5cGVvZiByZXN1bHQgPT09IFwic3RyaW5nXCIsIFwiZGlhZ25vc2UgcmV0dXJucyBhIHN0cmluZ1wiKTtcbiAgICAgIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoXCJTVU1NQVJZXCIpLCBcImRpYWdub3NlIHJlc3VsdCBtZW50aW9ucyBTVU1NQVJZXCIpO1xuICAgICAgYXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcyhcIm1pbGVzdG9uZVwiKSwgXCJkaWFnbm9zZSByZXN1bHQgbWVudGlvbnMgbWlsZXN0b25lXCIpO1xuICAgICAgYXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcyhcIk0wMDFcIiksIFwiZGlhZ25vc2UgcmVzdWx0IGluY2x1ZGVzIHRoZSBtaWxlc3RvbmUgSURcIik7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwic3RlcCAxMSBzcGVjaWZpZXMgd3JpdGUgdG9vbCBmb3IgUFJPSkVDVC5tZCB1cGRhdGUgKCMyOTQ2KVwiLCAoKSA9PiB7XG4gICAgY29uc3QgcHJvbXB0ID0gbG9hZFByb21wdEZyb21Xb3JrdHJlZShcImNvbXBsZXRlLW1pbGVzdG9uZVwiLCB7XG4gICAgICB3b3JraW5nRGlyZWN0b3J5OiBcIi90bXAvdGVzdC1wcm9qZWN0XCIsXG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICBtaWxlc3RvbmVUaXRsZTogXCJUb29sIEd1aWRhbmNlIFRlc3RcIixcbiAgICAgIHJvYWRtYXBQYXRoOiBcIi5nc2QvbWlsZXN0b25lcy9NMDAxL00wMDEtUk9BRE1BUC5tZFwiLFxuICAgICAgaW5saW5lZENvbnRleHQ6IFwiY29udGV4dFwiLFxuICAgICAgbWlsZXN0b25lU3VtbWFyeVBhdGg6IFwiLmdzZC9taWxlc3RvbmVzL00wMDEvTTAwMS1TVU1NQVJZLm1kXCIsXG4gICAgICBza2lsbEFjdGl2YXRpb246IFwiXCIsXG4gICAgfSk7XG5cbiAgICAvLyBTdGVwIDExIG11c3QgZXhwbGljaXRseSBuYW1lIHRoZSBgd3JpdGVgIHRvb2wgc28gdGhlIExMTSBkb2Vzbid0XG4gICAgLy8gY29uZnVzZSBpdCB3aXRoIGBlZGl0YCAod2hpY2ggcmVxdWlyZXMgcGF0aCArIG9sZFRleHQgKyBuZXdUZXh0KS5cbiAgICAvLyBTZWU6IGh0dHBzOi8vZ2l0aHViLmNvbS9nc2QtYnVpbGQvZ3NkLTIvaXNzdWVzLzI5NDZcbiAgICBhc3NlcnQub2soXG4gICAgICAvUFJPSkVDVFxcLm1kLipcXGJ3cml0ZVxcYi9pLnRlc3QocHJvbXB0KSB8fCAvXFxid3JpdGVcXGIuKlBST0pFQ1RcXC5tZC9pLnRlc3QocHJvbXB0KSxcbiAgICAgIFwic3RlcCAxMSBtdXN0IG5hbWUgdGhlIGB3cml0ZWAgdG9vbCB3aGVuIHVwZGF0aW5nIFBST0pFQ1QubWRcIixcbiAgICApO1xuXG4gICAgLy8gVGhlIHByb21wdCBtdXN0IE5PVCBsZWF2ZSB0b29sIGNob2ljZSBhbWJpZ3VvdXMgZm9yIFBST0pFQ1QubWRcbiAgICAvLyBWZXJpZnkgaXQgbWVudGlvbnMgdGhlIHJlcXVpcmVkIHBhcmFtZXRlciAoYGNvbnRlbnRgIG9yIGBwYXRoYClcbiAgICBhc3NlcnQub2soXG4gICAgICBwcm9tcHQuaW5jbHVkZXMoXCJgLmdzZC9QUk9KRUNULm1kYFwiKSB8fCBwcm9tcHQuaW5jbHVkZXMoJ1wiLmdzZC9QUk9KRUNULm1kXCInKSxcbiAgICAgIFwic3RlcCAxMSBtdXN0IHJlZmVyZW5jZSB0aGUgUFJPSkVDVC5tZCBwYXRoIGV4cGxpY2l0bHlcIixcbiAgICApO1xuICB9KTtcblxuICB0ZXN0KFwic2FuaXRpemVDb21wbGV0ZU1pbGVzdG9uZVBhcmFtcyBub3JtYWxpemVzIHN0cmluZyBwYXJhbWV0ZXJzXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB7IHNhbml0aXplQ29tcGxldGVNaWxlc3RvbmVQYXJhbXMgfSA9IGF3YWl0IGltcG9ydChcIi4uL2Jvb3RzdHJhcC9zYW5pdGl6ZS1jb21wbGV0ZS1taWxlc3RvbmUudHNcIik7XG5cbiAgICAvLyBTaW11bGF0ZSBwYXJhbXMgYXMgdGhleSBtaWdodCBhcnJpdmUgZnJvbSB0aGUgU0RLIGFmdGVyIHBhcnRpYWwgSlNPTiBwYXJzZTpcbiAgICAvLyAtIG51bWJlcnMgaW5zdGVhZCBvZiBzdHJpbmdzXG4gICAgLy8gLSBudWxsIGluc3RlYWQgb2YgYXJyYXlzXG4gICAgLy8gLSBleHRyYSB3aGl0ZXNwYWNlIGluIHN0cmluZ3NcbiAgICAvLyAtIHVuZGVmaW5lZCBvcHRpb25hbCBmaWVsZHNcbiAgICBjb25zdCByYXc6IGFueSA9IHtcbiAgICAgIG1pbGVzdG9uZUlkOiBcIiAgTTAxMSBcIixcbiAgICAgIHRpdGxlOiA0MiwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBudW1iZXIgaW5zdGVhZCBvZiBzdHJpbmdcbiAgICAgIG9uZUxpbmVyOiBcIiAgT25lLWxpbmVyIHdpdGggc3BhY2VzICBcIixcbiAgICAgIG5hcnJhdGl2ZTogXCIjIEJpZyBtYXJrZG93blxcblxcbldpdGggbmV3bGluZXMgYW5kIGBiYWNrdGlja3NgXFxuXFxuYGBgdHNcXG5jb2RlKCk7XFxuYGBgXFxuXCIsXG4gICAgICBzdWNjZXNzQ3JpdGVyaWFSZXN1bHRzOiBudWxsLCAgICAgICAgICAgIC8vIG51bGwgaW5zdGVhZCBvZiBzdHJpbmdcbiAgICAgIGRlZmluaXRpb25PZkRvbmVSZXN1bHRzOiB1bmRlZmluZWQsICAgICAgLy8gdW5kZWZpbmVkIGluc3RlYWQgb2Ygc3RyaW5nXG4gICAgICByZXF1aXJlbWVudE91dGNvbWVzOiAxMjM0NSwgICAgICAgICAgICAgIC8vIG51bWJlciBpbnN0ZWFkIG9mIHN0cmluZ1xuICAgICAga2V5RGVjaXNpb25zOiBcIm5vdCBhbiBhcnJheVwiLCAgICAgICAgICAgIC8vIHN0cmluZyBpbnN0ZWFkIG9mIGFycmF5XG4gICAgICBrZXlGaWxlczogbnVsbCwgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIG51bGwgaW5zdGVhZCBvZiBhcnJheVxuICAgICAgbGVzc29uc0xlYXJuZWQ6IFtcIiBsZXNzb24gb25lIFwiLCBudWxsLCBcIlwiLCBcIiAgbGVzc29uIHR3byAgXCJdLFxuICAgICAgZm9sbG93VXBzOiBcIiAgZm9sbG93IHVwICBcIixcbiAgICAgIGRldmlhdGlvbnM6IHVuZGVmaW5lZCxcbiAgICAgIHZlcmlmaWNhdGlvblBhc3NlZDogXCJ0cnVlXCIsICAgICAgICAgICAgIC8vIHN0cmluZyBpbnN0ZWFkIG9mIGJvb2xlYW5cbiAgICB9O1xuXG4gICAgY29uc3Qgc2FuaXRpemVkID0gc2FuaXRpemVDb21wbGV0ZU1pbGVzdG9uZVBhcmFtcyhyYXcpO1xuXG4gICAgLy8gU3RyaW5nIGZpZWxkcyBhcmUgdHJpbW1lZCBhbmQgY29lcmNlZFxuICAgIGFzc2VydC5zdHJpY3RFcXVhbChzYW5pdGl6ZWQubWlsZXN0b25lSWQsIFwiTTAxMVwiKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoc2FuaXRpemVkLnRpdGxlLCBcIjQyXCIpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChzYW5pdGl6ZWQub25lTGluZXIsIFwiT25lLWxpbmVyIHdpdGggc3BhY2VzXCIpO1xuICAgIGFzc2VydC5vayhzYW5pdGl6ZWQubmFycmF0aXZlLmluY2x1ZGVzKFwiIyBCaWcgbWFya2Rvd25cIiksIFwibmFycmF0aXZlIHByZXNlcnZlcyBtYXJrZG93blwiKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoc2FuaXRpemVkLnN1Y2Nlc3NDcml0ZXJpYVJlc3VsdHMsIFwiXCIpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChzYW5pdGl6ZWQuZGVmaW5pdGlvbk9mRG9uZVJlc3VsdHMsIFwiXCIpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChzYW5pdGl6ZWQucmVxdWlyZW1lbnRPdXRjb21lcywgXCIxMjM0NVwiKTtcblxuICAgIC8vIEFycmF5IGZpZWxkcyBhcmUgbm9ybWFsaXplZFxuICAgIGFzc2VydC5vayhBcnJheS5pc0FycmF5KHNhbml0aXplZC5rZXlEZWNpc2lvbnMpLCBcImtleURlY2lzaW9ucyBpcyBhbiBhcnJheVwiKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHNhbml0aXplZC5rZXlEZWNpc2lvbnMsIFtdKTtcbiAgICBhc3NlcnQub2soQXJyYXkuaXNBcnJheShzYW5pdGl6ZWQua2V5RmlsZXMpLCBcImtleUZpbGVzIGlzIGFuIGFycmF5XCIpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc2FuaXRpemVkLmtleUZpbGVzLCBbXSk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzYW5pdGl6ZWQubGVzc29uc0xlYXJuZWQsIFtcImxlc3NvbiBvbmVcIiwgXCJsZXNzb24gdHdvXCJdKTtcblxuICAgIC8vIE9wdGlvbmFsIGZpZWxkcyBcdTIwMTQgdG9TdHIoKSByZXR1cm5zIFwiXCIgZm9yIHVuZGVmaW5lZC9udWxsXG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHNhbml0aXplZC5mb2xsb3dVcHMsIFwiZm9sbG93IHVwXCIpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChzYW5pdGl6ZWQuZGV2aWF0aW9ucywgXCJcIik7XG5cbiAgICAvLyBCb29sZWFuIGNvZXJjaW9uXG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHNhbml0aXplZC52ZXJpZmljYXRpb25QYXNzZWQsIHRydWUpO1xuICB9KTtcblxuICB0ZXN0KFwic2FuaXRpemVDb21wbGV0ZU1pbGVzdG9uZVBhcmFtcyBoYW5kbGVzIGxhcmdlIG1hcmtkb3duIGNvbnRlbnRcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHsgc2FuaXRpemVDb21wbGV0ZU1pbGVzdG9uZVBhcmFtcyB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vYm9vdHN0cmFwL3Nhbml0aXplLWNvbXBsZXRlLW1pbGVzdG9uZS50c1wiKTtcblxuICAgIC8vIEdlbmVyYXRlIGEgbGFyZ2UgbWFya2Rvd24gc3RyaW5nICh+MjVrIGNoYXJhY3RlcnMgdG8gZXhjZWVkIHRoZSAyMzY2NyBwb3NpdGlvbiBmcm9tIHRoZSBidWcpXG4gICAgY29uc3QgbGFyZ2VNZCA9IFwiIyBNaWxlc3RvbmUgU3VtbWFyeVxcblxcblwiICtcbiAgICAgIEFycmF5LmZyb20oeyBsZW5ndGg6IDUwMCB9LCAoXywgaSkgPT5cbiAgICAgICAgYCMjIFNlY3Rpb24gJHtpfVxcblxcbmAgK1xuICAgICAgICBgLSBbeF0gVGFzayAke2l9IGNvbXBsZXRlZCB3aXRoIFxcYGNvZGVcXGAgYW5kICoqYm9sZCoqIHRleHRcXG5gICtcbiAgICAgICAgYCAgLSBTdWItaXRlbSB3aXRoIHNwZWNpYWwgY2hhcnM6IDwsID4sICYsIFwiLCAnXFxuYCArXG4gICAgICAgIGAgIC0gQW5vdGhlciBzdWItaXRlbTogXFxgXFxgXFxgdHNcXG5jb25zdCB4ID0gJHtpfTtcXG5cXGBcXGBcXGBcXG5gXG4gICAgICApLmpvaW4oXCJcXG5cIik7XG5cbiAgICBhc3NlcnQub2sobGFyZ2VNZC5sZW5ndGggPiAyMzY2NywgYGdlbmVyYXRlZCBtYXJrZG93biBpcyAke2xhcmdlTWQubGVuZ3RofSBjaGFycywgbXVzdCBleGNlZWQgMjM2NjdgKTtcblxuICAgIGNvbnN0IHJhdzogYW55ID0ge1xuICAgICAgbWlsZXN0b25lSWQ6IFwiTTAxMVwiLFxuICAgICAgdGl0bGU6IFwiQ29udGVudCBEZXB0aCwgTmFycmF0aXZlICYgT25ib2FyZGluZ1wiLFxuICAgICAgb25lTGluZXI6IFwiTGFyZ2UgbWlsZXN0b25lIHdpdGggbWFueSBzbGljZXNcIixcbiAgICAgIG5hcnJhdGl2ZTogbGFyZ2VNZCxcbiAgICAgIHN1Y2Nlc3NDcml0ZXJpYVJlc3VsdHM6IGxhcmdlTWQsXG4gICAgICBkZWZpbml0aW9uT2ZEb25lUmVzdWx0czogbGFyZ2VNZCxcbiAgICAgIHJlcXVpcmVtZW50T3V0Y29tZXM6IGxhcmdlTWQsXG4gICAgICBrZXlEZWNpc2lvbnM6IFtcImRlY2lzaW9uIDFcIiwgXCJkZWNpc2lvbiAyXCJdLFxuICAgICAga2V5RmlsZXM6IFtcImZpbGUxLnRzXCIsIFwiZmlsZTIudHNcIl0sXG4gICAgICBsZXNzb25zTGVhcm5lZDogW1wibGVzc29uIDFcIl0sXG4gICAgICBmb2xsb3dVcHM6IFwiU29tZSBmb2xsb3ctdXBzXCIsXG4gICAgICBkZXZpYXRpb25zOiBcIlNvbWUgZGV2aWF0aW9uc1wiLFxuICAgICAgdmVyaWZpY2F0aW9uUGFzc2VkOiB0cnVlLFxuICAgIH07XG5cbiAgICBjb25zdCBzYW5pdGl6ZWQgPSBzYW5pdGl6ZUNvbXBsZXRlTWlsZXN0b25lUGFyYW1zKHJhdyk7XG5cbiAgICAvLyBMYXJnZSBjb250ZW50IHNob3VsZCBwYXNzIHRocm91Z2ggd2l0aG91dCB0cnVuY2F0aW9uIG9yIGNvcnJ1cHRpb25cbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoc2FuaXRpemVkLm5hcnJhdGl2ZSwgbGFyZ2VNZC50cmltKCkpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChzYW5pdGl6ZWQuc3VjY2Vzc0NyaXRlcmlhUmVzdWx0cywgbGFyZ2VNZC50cmltKCkpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChzYW5pdGl6ZWQuZGVmaW5pdGlvbk9mRG9uZVJlc3VsdHMsIGxhcmdlTWQudHJpbSgpKTtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoc2FuaXRpemVkLnJlcXVpcmVtZW50T3V0Y29tZXMsIGxhcmdlTWQudHJpbSgpKTtcbiAgfSk7XG5cbiAgdGVzdChcIm1pbGVzdG9uZUNvbXBsZXRlRXhlY3V0ZSB1c2VzIHNhbml0aXplZCBwYXJhbXNcIiwgYXN5bmMgKCkgPT4ge1xuICAgIC8vIFRoaXMgdGVzdCB2ZXJpZmllcyB0aGF0IHRoZSBleGVjdXRlIGZ1bmN0aW9uIHNhbml0aXplcyBwYXJhbXMgYmVmb3JlIHBhc3NpbmdcbiAgICAvLyB0byBoYW5kbGVDb21wbGV0ZU1pbGVzdG9uZS4gV2UgdGVzdCBpbmRpcmVjdGx5OiBpZiB3ZSBwYXNzIG51bWVyaWMgbWlsZXN0b25lSWQsXG4gICAgLy8gdGhlIGhhbmRsZXIgc2hvdWxkIHN0aWxsIHJlY2VpdmUgYSBzdHJpbmcgKGFuZCByZXR1cm4gYSBtZWFuaW5nZnVsIGVycm9yLCBub3QgYSBjcmFzaCkuXG4gICAgY29uc3QgeyBoYW5kbGVDb21wbGV0ZU1pbGVzdG9uZSB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vdG9vbHMvY29tcGxldGUtbWlsZXN0b25lLnRzXCIpO1xuICAgIGNvbnN0IHsgc2FuaXRpemVDb21wbGV0ZU1pbGVzdG9uZVBhcmFtcyB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vYm9vdHN0cmFwL3Nhbml0aXplLWNvbXBsZXRlLW1pbGVzdG9uZS50c1wiKTtcbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgLy8gU2ltdWxhdGUgd2hhdCBtaWxlc3RvbmVDb21wbGV0ZUV4ZWN1dGUgc2hvdWxkIGRvOiBzYW5pdGl6ZSB0aGVuIGNhbGwgaGFuZGxlclxuICAgICAgY29uc3QgcmF3OiBhbnkgPSB7XG4gICAgICAgIG1pbGVzdG9uZUlkOiA0MiwgICAgICAgICAgIC8vIG51bWJlciBcdTIwMTQgd291bGQgY3Jhc2ggd2l0aG91dCBzYW5pdGl6YXRpb25cbiAgICAgICAgdGl0bGU6IFwiVGVzdFwiLFxuICAgICAgICBvbmVMaW5lcjogXCJUZXN0XCIsXG4gICAgICAgIG5hcnJhdGl2ZTogXCJUZXN0IG5hcnJhdGl2ZVwiLFxuICAgICAgICBzdWNjZXNzQ3JpdGVyaWFSZXN1bHRzOiBcIlJlc3VsdHNcIixcbiAgICAgICAgZGVmaW5pdGlvbk9mRG9uZVJlc3VsdHM6IFwiRG9uZVwiLFxuICAgICAgICByZXF1aXJlbWVudE91dGNvbWVzOiBcIk91dGNvbWVzXCIsXG4gICAgICAgIGtleURlY2lzaW9uczogbnVsbCwgICAgICAgIC8vIG51bGwgXHUyMDE0IHdvdWxkIGNyYXNoIC5sZW5ndGggd2l0aG91dCBzYW5pdGl6YXRpb25cbiAgICAgICAga2V5RmlsZXM6IFwibm90LWFycmF5XCIsICAgICAvLyBzdHJpbmcgXHUyMDE0IHdvdWxkIGNyYXNoIC5tYXAgd2l0aG91dCBzYW5pdGl6YXRpb25cbiAgICAgICAgbGVzc29uc0xlYXJuZWQ6IHVuZGVmaW5lZCwgLy8gdW5kZWZpbmVkIFx1MjAxNCB3b3VsZCBjcmFzaCAubWFwIHdpdGhvdXQgc2FuaXRpemF0aW9uXG4gICAgICAgIGZvbGxvd1VwczogXCJcIixcbiAgICAgICAgZGV2aWF0aW9uczogXCJcIixcbiAgICAgICAgdmVyaWZpY2F0aW9uUGFzc2VkOiB0cnVlLFxuICAgICAgfTtcblxuICAgICAgY29uc3Qgc2FuaXRpemVkID0gc2FuaXRpemVDb21wbGV0ZU1pbGVzdG9uZVBhcmFtcyhyYXcpO1xuXG4gICAgICAvLyBWZXJpZnkgc2FuaXRpemF0aW9uIGRpZG4ndCBjcmFzaCBhbmQgcHJvZHVjZWQgdmFsaWQgdHlwZWQgcGFyYW1zXG4gICAgICBhc3NlcnQuc3RyaWN0RXF1YWwodHlwZW9mIHNhbml0aXplZC5taWxlc3RvbmVJZCwgXCJzdHJpbmdcIiwgXCJtaWxlc3RvbmVJZCBpcyBhIHN0cmluZyBhZnRlciBzYW5pdGl6YXRpb25cIik7XG4gICAgICBhc3NlcnQub2soQXJyYXkuaXNBcnJheShzYW5pdGl6ZWQua2V5RGVjaXNpb25zKSwgXCJrZXlEZWNpc2lvbnMgaXMgYXJyYXkgYWZ0ZXIgc2FuaXRpemF0aW9uXCIpO1xuICAgICAgYXNzZXJ0Lm9rKEFycmF5LmlzQXJyYXkoc2FuaXRpemVkLmtleUZpbGVzKSwgXCJrZXlGaWxlcyBpcyBhcnJheSBhZnRlciBzYW5pdGl6YXRpb25cIik7XG4gICAgICBhc3NlcnQub2soQXJyYXkuaXNBcnJheShzYW5pdGl6ZWQubGVzc29uc0xlYXJuZWQpLCBcImxlc3NvbnNMZWFybmVkIGlzIGFycmF5IGFmdGVyIHNhbml0aXphdGlvblwiKTtcbiAgICAgIGFzc2VydC5zdHJpY3RFcXVhbCh0eXBlb2Ygc2FuaXRpemVkLnZlcmlmaWNhdGlvblBhc3NlZCwgXCJib29sZWFuXCIsIFwidmVyaWZpY2F0aW9uUGFzc2VkIGlzIGJvb2xlYW4gYWZ0ZXIgc2FuaXRpemF0aW9uXCIpO1xuXG4gICAgICAvLyBDYWxsaW5nIGhhbmRsZUNvbXBsZXRlTWlsZXN0b25lIG1heSB0aHJvdyBHU0RfU1RBTEVfU1RBVEUgKG5vIERCIGluIHRlc3QgZW52KVxuICAgICAgLy8gYnV0IGl0IHNob3VsZCBOT1QgdGhyb3cgVHlwZUVycm9yIGZyb20gdHlwZSBtaXNtYXRjaGVzIFx1MjAxNCB0aGF0J3MgdGhlIGJ1ZyBmaXguXG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCBoYW5kbGVDb21wbGV0ZU1pbGVzdG9uZShzYW5pdGl6ZWQsIGJhc2UpO1xuICAgICAgfSBjYXRjaCAoZXJyOiBhbnkpIHtcbiAgICAgICAgLy8gR1NEX1NUQUxFX1NUQVRFIG9yIFwiTm8gZGF0YWJhc2Ugb3BlblwiIGlzIGFjY2VwdGFibGUgXHUyMDE0IGl0IG1lYW5zIHdlIGdvdCBwYXN0XG4gICAgICAgIC8vIHRoZSB0eXBlLXNlbnNpdGl2ZSBjb2RlIGFuZCBmYWlsZWQgb24gREIgYWNjZXNzLCB3aGljaCBpcyBleHBlY3RlZCBpbiB0ZXN0cy5cbiAgICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICAgIGVyci5jb2RlID09PSBcIkdTRF9TVEFMRV9TVEFURVwiIHx8IGVyci5tZXNzYWdlPy5pbmNsdWRlcyhcImRhdGFiYXNlXCIpLFxuICAgICAgICAgIGBleHBlY3RlZCBEQiBlcnJvciwgZ290OiAke2Vyci5tZXNzYWdlfWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwiaGFuZGxlQ29tcGxldGVNaWxlc3RvbmUgdHJlYXRzIGFscmVhZHktY29tcGxldGUgbWlsZXN0b25lIGFzIGlkZW1wb3RlbnQgcmUtZGlzcGF0Y2ggKCM0NTk4KVwiLCBhc3luYyAoKSA9PiB7XG4gICAgLy8gVGhpcyB0ZXN0IHZlcmlmaWVzIHRoYXQgd2hlbiBTVU1NQVJZLm1kIGFscmVhZHkgZXhpc3RzIChmcm9tIGEgcHJpb3IgY29tcGxldGlvbiksXG4gICAgLy8gcmUtY2FsbGluZyBoYW5kbGVDb21wbGV0ZU1pbGVzdG9uZSBkb2VzIG5vdCBvdmVyd3JpdGUgaXQuXG4gICAgY29uc3QgeyBoYW5kbGVDb21wbGV0ZU1pbGVzdG9uZSB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vdG9vbHMvY29tcGxldGUtbWlsZXN0b25lLnRzXCIpO1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIGNvbnN0IG1pZCA9IFwiTTAwMVwiO1xuICAgIGNvbnN0IGRiUGF0aCA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpO1xuICAgIHRyeSB7XG4gICAgICAvLyBTZXQgdXAgREIgd2l0aCBtaWxlc3RvbmUgYW5kIGEgY29tcGxldGUgc2xpY2UgKyB0YXNrXG4gICAgICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcbiAgICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBtaWQsIHRpdGxlOiBcIlRlc3QgTWlsZXN0b25lXCIsIHN0YXR1czogXCJjb21wbGV0ZVwiIH0pO1xuICAgICAgaW5zZXJ0U2xpY2UoeyBpZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IG1pZCwgdGl0bGU6IFwiU2xpY2UgT25lXCIsIHN0YXR1czogXCJjb21wbGV0ZVwiIH0pO1xuICAgICAgaW5zZXJ0VGFzayh7IGlkOiBcIlQwMVwiLCBzbGljZUlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogbWlkLCB0aXRsZTogXCJUYXNrIE9uZVwiLCBzdGF0dXM6IFwiY29tcGxldGVcIiB9KTtcblxuICAgICAgLy8gUHJlLXdyaXRlIGFuIGV4aXN0aW5nIFNVTU1BUlkubWQgdG8gc2ltdWxhdGUgYSBwcmlvciBjb21wbGV0aW9uXG4gICAgICBjb25zdCBtaWxlc3RvbmVEaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgbWlkKTtcbiAgICAgIG1rZGlyU3luYyhtaWxlc3RvbmVEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgY29uc3Qgc3VtbWFyeVBhdGggPSBqb2luKG1pbGVzdG9uZURpciwgYCR7bWlkfS1TVU1NQVJZLm1kYCk7XG4gICAgICBjb25zdCBvcmlnaW5hbENvbnRlbnQgPSBcIm9yaWdpbmFsIGNvbnRlbnQgXHUyMDE0IG11c3Qgbm90IGJlIG92ZXJ3cml0dGVuXCI7XG4gICAgICB3cml0ZUZpbGVTeW5jKHN1bW1hcnlQYXRoLCBvcmlnaW5hbENvbnRlbnQsIFwidXRmLThcIik7XG5cbiAgICAgIC8vIENhbGwgaGFuZGxlQ29tcGxldGVNaWxlc3RvbmUgXHUyMDE0IHRoaXMgaXMgdGhlIHJlLWRpc3BhdGNoIHNjZW5hcmlvXG4gICAgICBjb25zdCBwYXJhbXMgPSB7XG4gICAgICAgIG1pbGVzdG9uZUlkOiBtaWQsXG4gICAgICAgIHRpdGxlOiBcIlRlc3QgTWlsZXN0b25lXCIsXG4gICAgICAgIG9uZUxpbmVyOiBcIlJlLWRpc3BhdGNoZWRcIixcbiAgICAgICAgbmFycmF0aXZlOiBcIlRoaXMgaXMgYSByZS1kaXNwYXRjaFwiLFxuICAgICAgICBzdWNjZXNzQ3JpdGVyaWFSZXN1bHRzOiBcIk1ldFwiLFxuICAgICAgICBkZWZpbml0aW9uT2ZEb25lUmVzdWx0czogXCJEb25lXCIsXG4gICAgICAgIHJlcXVpcmVtZW50T3V0Y29tZXM6IFwiQ292ZXJlZFwiLFxuICAgICAgICBrZXlEZWNpc2lvbnM6IFtdLFxuICAgICAgICBrZXlGaWxlczogW10sXG4gICAgICAgIGxlc3NvbnNMZWFybmVkOiBbXSxcbiAgICAgICAgZm9sbG93VXBzOiBcIlwiLFxuICAgICAgICBkZXZpYXRpb25zOiBcIlwiLFxuICAgICAgICB2ZXJpZmljYXRpb25QYXNzZWQ6IHRydWUsXG4gICAgICB9O1xuXG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVDb21wbGV0ZU1pbGVzdG9uZShwYXJhbXMsIGJhc2UpO1xuICAgICAgYXNzZXJ0Lm9rKCEoXCJlcnJvclwiIGluIHJlc3VsdCksIGBhbHJlYWR5LWNvbXBsZXRlIHJlLWRpc3BhdGNoIHNob3VsZCBzdWNjZWVkOiAke0pTT04uc3RyaW5naWZ5KHJlc3VsdCl9YCk7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmFscmVhZHlDb21wbGV0ZSwgdHJ1ZSk7XG5cbiAgICAgIGNvbnN0IGFjdHVhbENvbnRlbnQgPSByZWFkRmlsZVN5bmMoc3VtbWFyeVBhdGgsIFwidXRmLThcIik7XG4gICAgICBhc3NlcnQuc3RyaWN0RXF1YWwoXG4gICAgICAgIGFjdHVhbENvbnRlbnQsXG4gICAgICAgIG9yaWdpbmFsQ29udGVudCxcbiAgICAgICAgXCJleGlzdGluZyBTVU1NQVJZLm1kIG11c3Qgbm90IGJlIG92ZXJ3cml0dGVuIG9uIHJlLWRpc3BhdGNoICgjNDU5OClcIixcbiAgICAgICk7XG5cbiAgICAgIC8vIFJlcGVhdGVkIHJlLWRpc3BhdGNoIHNob3VsZCBhbHNvIGJlIGlkZW1wb3RlbnQuXG4gICAgICBjb25zdCByZXBlYXRSZXN1bHQgPSBhd2FpdCBoYW5kbGVDb21wbGV0ZU1pbGVzdG9uZShwYXJhbXMsIGJhc2UpO1xuICAgICAgYXNzZXJ0Lm9rKCEoXCJlcnJvclwiIGluIHJlcGVhdFJlc3VsdCksIFwicmVwZWF0ZWQgcmUtZGlzcGF0Y2ggc2hvdWxkIGFsc28gc3VjY2VlZFwiKTtcbiAgICAgIGFzc2VydC5zdHJpY3RFcXVhbChyZXBlYXRSZXN1bHQuYWxyZWFkeUNvbXBsZXRlLCB0cnVlLCBcInJlcGVhdGVkIHJlLWRpc3BhdGNoIGlzIGlkZW50aWZpZWQgYXMgYWxyZWFkeS1jb21wbGV0ZVwiKTtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgcmVwZWF0UmVzdWx0LnN1bW1hcnlQYXRoLmVuZHNXaXRoKGpvaW4oXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBtaWQsIGAke21pZH0tU1VNTUFSWS5tZGApKSxcbiAgICAgICAgXCJyZXBlYXRlZCByZS1kaXNwYXRjaCByZXR1cm5zIHRoZSBleGlzdGluZyBzdW1tYXJ5IHBhdGhcIixcbiAgICAgICk7XG4gICAgICBhc3NlcnQuc3RyaWN0RXF1YWwoXG4gICAgICAgIHJlYWRGaWxlU3luYyhzdW1tYXJ5UGF0aCwgXCJ1dGYtOFwiKSxcbiAgICAgICAgb3JpZ2luYWxDb250ZW50LFxuICAgICAgICBcInJlcGVhdGVkIHJlLWRpc3BhdGNoIG11c3Qgbm90IG92ZXJ3cml0ZSBTVU1NQVJZLm1kXCIsXG4gICAgICApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICB0cnkgeyBjbG9zZURhdGFiYXNlKCk7IH0gY2F0Y2ggeyAvKiAqLyB9XG4gICAgICBjbGVhclBhdGhDYWNoZSgpO1xuICAgICAgY2xlYXJQYXJzZUNhY2hlKCk7XG4gICAgICBjbGVhbnVwKGJhc2UpO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcImRlcml2ZVN0YXRlIGNvbXBsZXRpbmctbWlsZXN0b25lIGludGVncmF0aW9uXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB7IGRlcml2ZVN0YXRlLCBpc01pbGVzdG9uZUNvbXBsZXRlIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9zdGF0ZS50c1wiKTtcbiAgICBjb25zdCB7IGludmFsaWRhdGVBbGxDYWNoZXM6IGludmFsaWRhdGVBbGxDYWNoZXNEeW5hbWljIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9jYWNoZS50c1wiKTtcbiAgICBjb25zdCB7IHBhcnNlUm9hZG1hcCB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vcGFyc2Vycy1sZWdhY3kudHNcIik7XG5cbiAgICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVSb2FkbWFwKGJhc2UsIFwiTTAwMVwiLCBgIyBNMDAxOiBJbnRlZ3JhdGlvbiBUZXN0XG5cbioqVmlzaW9uOioqIFRlc3QgY29tcGxldGluZy1taWxlc3RvbmUgZmxvdy5cblxuIyMgU2xpY2VzXG5cbi0gW3hdICoqUzAxOiBTbGljZSBPbmUqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXG4gID4gQWZ0ZXIgdGhpczogZG9uZS5cblxuLSBbeF0gKipTMDI6IFNsaWNlIFR3byoqIFxcYHJpc2s6bG93XFxgIFxcYGRlcGVuZHM6W1MwMV1cXGBcbiAgPiBBZnRlciB0aGlzOiBkb25lLlxuYCk7XG5cbiAgICAgIC8vIFZlcmlmeSBpc01pbGVzdG9uZUNvbXBsZXRlIHJldHVybnMgdHJ1ZVxuICAgICAgY29uc3QgeyBsb2FkRmlsZSB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vZmlsZXMudHNcIik7XG4gICAgICBjb25zdCByb2FkbWFwUGF0aCA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJNMDAxLVJPQURNQVAubWRcIik7XG4gICAgICBjb25zdCByb2FkbWFwQ29udGVudCA9IGF3YWl0IGxvYWRGaWxlKHJvYWRtYXBQYXRoKTtcbiAgICAgIGNvbnN0IHJvYWRtYXAgPSBwYXJzZVJvYWRtYXAocm9hZG1hcENvbnRlbnQhKTtcbiAgICAgIGFzc2VydC5vayhpc01pbGVzdG9uZUNvbXBsZXRlKHJvYWRtYXApLCBcImlzTWlsZXN0b25lQ29tcGxldGUgcmV0dXJucyB0cnVlIHdoZW4gYWxsIHNsaWNlcyBhcmUgW3hdXCIpO1xuXG4gICAgICAvLyBWZXJpZnkgZGVyaXZlU3RhdGUgcmV0dXJucyBjb21wbGV0aW5nLW1pbGVzdG9uZSBwaGFzZSAod2l0aCB2YWxpZGF0aW9uIGFscmVhZHkgZG9uZSlcbiAgICAgIHdyaXRlTWlsZXN0b25lVmFsaWRhdGlvbihiYXNlLCBcIk0wMDFcIik7XG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuICAgICAgYXNzZXJ0LnN0cmljdEVxdWFsKHN0YXRlLnBoYXNlLCBcImNvbXBsZXRpbmctbWlsZXN0b25lXCIsIFwiZGVyaXZlU3RhdGUgcmV0dXJucyBjb21wbGV0aW5nLW1pbGVzdG9uZSB3aGVuIGFsbCBzbGljZXMgZG9uZSwgbm8gc3VtbWFyeVwiKTtcbiAgICAgIGFzc2VydC5zdHJpY3RFcXVhbChzdGF0ZS5hY3RpdmVNaWxlc3RvbmU/LmlkLCBcIk0wMDFcIiwgXCJhY3RpdmUgbWlsZXN0b25lIGlzIE0wMDFcIik7XG4gICAgICBhc3NlcnQuc3RyaWN0RXF1YWwoc3RhdGUuYWN0aXZlU2xpY2UsIG51bGwsIFwibm8gYWN0aXZlIHNsaWNlIGluIGNvbXBsZXRpbmctbWlsZXN0b25lXCIpO1xuXG4gICAgICAvLyBOb3cgYWRkIHRoZSBzdW1tYXJ5IGFuZCB2ZXJpZnkgaXQgdHJhbnNpdGlvbnMgdG8gY29tcGxldGVcbiAgICAgIHdyaXRlTWlsZXN0b25lU3VtbWFyeShiYXNlLCBcIk0wMDFcIiwgXCIjIE0wMDEgU3VtbWFyeVxcblxcbkRvbmUuXCIpO1xuICAgICAgaW52YWxpZGF0ZUFsbENhY2hlc0R5bmFtaWMoKTtcbiAgICAgIGNvbnN0IHN0YXRlQWZ0ZXIgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcbiAgICAgIGFzc2VydC5zdHJpY3RFcXVhbChzdGF0ZUFmdGVyLnBoYXNlLCBcImNvbXBsZXRlXCIsIFwiZGVyaXZlU3RhdGUgcmV0dXJucyBjb21wbGV0ZSBhZnRlciBzdW1tYXJ5IGV4aXN0c1wiKTtcbiAgICAgIGFzc2VydC5zdHJpY3RFcXVhbChzdGF0ZUFmdGVyLnJlZ2lzdHJ5WzBdPy5zdGF0dXMsIFwiY29tcGxldGVcIiwgXCJyZWdpc3RyeSBzaG93cyBjb21wbGV0ZSBzdGF0dXNcIik7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoYmFzZSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwidmVyaWZpY2F0aW9uLWdhdGUgc3RlcCBudW1iZXJzIG1hdGNoIHRoZSBhY3R1YWwgbnVtYmVyZWQgdmVyaWZpY2F0aW9uIHN0ZXBzXCIsICgpID0+IHtcbiAgICAvLyBSZWdyZXNzaW9uIGZvciBzdGVwLW51bWJlciBkcmlmdDogc3RlcCAxIChkdXBsaWNhdGUgZ3VhcmQpIHdhcyBpbnNlcnRlZFxuICAgIC8vIGluIGVhNWEyY2MwIGFuZCB0aGUgcmVzdCByZW51bWJlcmVkLCBidXQgdGhlIGdhdGUgdGV4dCB3YXMgbm90IHVwZGF0ZWQuXG4gICAgLy8gUmUtZGVyaXZlIHRoZSB2ZXJpZmljYXRpb24tc3RlcCBpbmRpY2VzIGZyb20gdGhlIHJlbmRlcmVkIHByb21wdCBhbmRcbiAgICAvLyBhc3NlcnQgdGhlIGdhdGUgLyBcIkltcG9ydGFudFwiIGZvb3RlciByZWZlcmVuY2UgdGhlIGNvcnJlY3QgbnVtYmVycy5cbiAgICBjb25zdCBwcm9tcHQgPSBsb2FkUHJvbXB0RnJvbVdvcmt0cmVlKFwiY29tcGxldGUtbWlsZXN0b25lXCIsIHtcbiAgICAgIHdvcmtpbmdEaXJlY3Rvcnk6IFwiL3RtcC90ZXN0LXByb2plY3RcIixcbiAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICAgIG1pbGVzdG9uZVRpdGxlOiBcIlN0ZXAgTnVtYmVyIERyaWZ0XCIsXG4gICAgICByb2FkbWFwUGF0aDogXCIuZ3NkL21pbGVzdG9uZXMvTTAwMS9NMDAxLVJPQURNQVAubWRcIixcbiAgICAgIGlubGluZWRDb250ZXh0OiBcImNvbnRleHRcIixcbiAgICAgIG1pbGVzdG9uZVN1bW1hcnlQYXRoOiBcIi5nc2QvbWlsZXN0b25lcy9NMDAxL00wMDEtU1VNTUFSWS5tZFwiLFxuICAgICAgc2tpbGxBY3RpdmF0aW9uOiBcInt7c2tpbGxBY3RpdmF0aW9uIGJsb2NrfX1cIixcbiAgICAgIGV4dHJhY3RMZWFybmluZ3NTdGVwczogXCJ7e2V4dHJhY3QgbGVhcm5pbmdzIGJsb2NrfX1cIixcbiAgICB9KTtcblxuICAgIGZ1bmN0aW9uIGZpbmRTdGVwKG5lZWRsZTogUmVnRXhwKTogbnVtYmVyIHtcbiAgICAgIGNvbnN0IGxpbmVzID0gcHJvbXB0LnNwbGl0KFwiXFxuXCIpO1xuICAgICAgZm9yIChjb25zdCBsaW5lIG9mIGxpbmVzKSB7XG4gICAgICAgIGNvbnN0IG0gPSAvXihcXGQrKVxcLlxccy8uZXhlYyhsaW5lKTtcbiAgICAgICAgaWYgKG0gJiYgbmVlZGxlLnRlc3QobGluZSkpIHJldHVybiBOdW1iZXIobVsxXSk7XG4gICAgICB9XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYG5vIG51bWJlcmVkIHN0ZXAgbWF0Y2hlcyAke25lZWRsZX1gKTtcbiAgICB9XG5cbiAgICBjb25zdCBjb2RlQ2hhbmdlID0gZmluZFN0ZXAoL1ZlcmlmeSBjb2RlIGNoYW5nZXMvKTtcbiAgICBjb25zdCBzdWNjZXNzQ3JpdGVyaWEgPSBmaW5kU3RlcCgvVmVyaWZ5IGV2ZXJ5IFxcKlxcKnN1Y2Nlc3MgY3JpdGVyaW9uXFwqXFwqLyk7XG4gICAgY29uc3QgZGVmT2ZEb25lID0gZmluZFN0ZXAoL1ZlcmlmeSBcXCpcXCpkZWZpbml0aW9uIG9mIGRvbmVcXCpcXCovKTtcbiAgICBjb25zdCBjb21wbGV0ZU1pbGVzdG9uZSA9IGZpbmRTdGVwKC9QZXJzaXN0IGNvbXBsZXRpb24gdGhyb3VnaCBgZ3NkX2NvbXBsZXRlX21pbGVzdG9uZWAvKTtcbiAgICBjb25zdCByZXF1aXJlbWVudFVwZGF0ZSA9IGZpbmRTdGVwKC9nc2RfcmVxdWlyZW1lbnRfdXBkYXRlLyk7XG5cbiAgICAvLyBHYXRlIGNsYXVzZSByZWZlcmVuY2VzIHRoZSB2ZXJpZmljYXRpb24gc3RlcHMuXG4gICAgY29uc3QgZ2F0ZUxpbmUgPSBwcm9tcHQuc3BsaXQoXCJcXG5cIikuZmluZChsID0+IGwuaW5jbHVkZXMoXCJWZXJpZmljYXRpb24gZmFpbHVyZSB3YXMgcmVjb3JkZWRcIikgfHwgbC5pbmNsdWRlcyhcInZlcmlmaWNhdGlvbiBmYWlsdXJlIHdhcyByZWNvcmRlZFwiKSk7XG4gICAgYXNzZXJ0Lm9rKGdhdGVMaW5lLCBcInZlcmlmaWNhdGlvbiBnYXRlIHNlbnRlbmNlIGlzIHByZXNlbnRcIik7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgZ2F0ZUxpbmUhLmluY2x1ZGVzKGBzdGVwcyAke2NvZGVDaGFuZ2V9LCAke3N1Y2Nlc3NDcml0ZXJpYX0sIG9yICR7ZGVmT2ZEb25lfWApLFxuICAgICAgYGdhdGUgbXVzdCBjaXRlIHZlcmlmaWNhdGlvbiBzdGVwcyAke2NvZGVDaGFuZ2V9LCAke3N1Y2Nlc3NDcml0ZXJpYX0sICR7ZGVmT2ZEb25lfTsgZ290OiAke2dhdGVMaW5lfWAsXG4gICAgKTtcbiAgICAvLyBcIkRvIE5PVCBwcm9jZWVkIHdpdGggc3RlcHMgWC1ZXCIgXHUyMDE0IFkgbXVzdCBiZSBhdCBsZWFzdCB0aGUgZ3NkX2NvbXBsZXRlX21pbGVzdG9uZSBzdGVwLlxuICAgIGNvbnN0IHByb2NlZWRNYXRjaCA9IC9EbyBOT1QgcHJvY2VlZCB3aXRoIHN0ZXBzIChcXGQrKVtcdTIwMTMtXShcXGQrKS8uZXhlYyhnYXRlTGluZSEpO1xuICAgIGFzc2VydC5vayhwcm9jZWVkTWF0Y2gsIFwiZ2F0ZSBtdXN0IGluY2x1ZGUgYSAnRG8gTk9UIHByb2NlZWQgd2l0aCBzdGVwcyBYXHUyMDEzWScgY2xhdXNlXCIpO1xuICAgIGFzc2VydC5vayhcbiAgICAgIE51bWJlcihwcm9jZWVkTWF0Y2ghWzFdKSA+IHJlcXVpcmVtZW50VXBkYXRlIC0gMSAmJiBOdW1iZXIocHJvY2VlZE1hdGNoIVsyXSkgPj0gY29tcGxldGVNaWxlc3RvbmUsXG4gICAgICBgJ0RvIE5PVCBwcm9jZWVkJyByYW5nZSAke3Byb2NlZWRNYXRjaCFbMV19XHUyMDEzJHtwcm9jZWVkTWF0Y2ghWzJdfSBtdXN0IGNvdmVyIHN0ZXBzIGZyb20gYWZ0ZXIgdGhlIGdhdGUgdGhyb3VnaCBnc2RfY29tcGxldGVfbWlsZXN0b25lICgke2NvbXBsZXRlTWlsZXN0b25lfSlgLFxuICAgICk7XG5cbiAgICAvLyBcIkltcG9ydGFudFwiIGZvb3RlciByZWZlcmVuY2VzIHRoZSBzYW1lIHZlcmlmaWNhdGlvbiBzdGVwcy5cbiAgICBjb25zdCBpbXBvcnRhbnRMaW5lID0gcHJvbXB0LnNwbGl0KFwiXFxuXCIpLmZpbmQobCA9PiBsLmluY2x1ZGVzKFwiRG8gTk9UIHNraXAgY29kZS1jaGFuZ2VcIikpO1xuICAgIGFzc2VydC5vayhpbXBvcnRhbnRMaW5lLCBcIkltcG9ydGFudCBmb290ZXIgaXMgcHJlc2VudFwiKTtcbiAgICBhc3NlcnQub2soXG4gICAgICBpbXBvcnRhbnRMaW5lIS5pbmNsdWRlcyhgc3RlcHMgJHtjb2RlQ2hhbmdlfS0ke2RlZk9mRG9uZX1gKSB8fFxuICAgICAgICBpbXBvcnRhbnRMaW5lIS5pbmNsdWRlcyhgc3RlcHMgJHtjb2RlQ2hhbmdlfVx1MjAxMyR7ZGVmT2ZEb25lfWApLFxuICAgICAgYEltcG9ydGFudCBmb290ZXIgbXVzdCBjaXRlIHZlcmlmaWNhdGlvbiByYW5nZSAke2NvZGVDaGFuZ2V9LSR7ZGVmT2ZEb25lfTsgZ290OiAke2ltcG9ydGFudExpbmV9YCxcbiAgICApO1xuXG4gICAgLy8gT24tZGVtYW5kIFJlYWQgb3JkZXJpbmcgbGluZSBjaXRlcyB0aGUgZ3NkX2NvbXBsZXRlX21pbGVzdG9uZSBzdGVwLlxuICAgIGNvbnN0IHJlYWRPcmRlckxpbmUgPSBwcm9tcHQuc3BsaXQoXCJcXG5cIikuZmluZChsID0+IGwuaW5jbHVkZXMoXCJPbi1kZW1hbmQgUmVhZCBvcmRlcmluZ1wiKSk7XG4gICAgYXNzZXJ0Lm9rKHJlYWRPcmRlckxpbmUsIFwiT24tZGVtYW5kIFJlYWQgb3JkZXJpbmcgbGluZSBpcyBwcmVzZW50XCIpO1xuICAgIGFzc2VydC5vayhcbiAgICAgIHJlYWRPcmRlckxpbmUhLmluY2x1ZGVzKGAoc3RlcCAke2NvbXBsZXRlTWlsZXN0b25lfSlgKSxcbiAgICAgIGBPbi1kZW1hbmQgUmVhZCBvcmRlcmluZyBtdXN0IGNpdGUgc3RlcCAke2NvbXBsZXRlTWlsZXN0b25lfTsgZ290OiAke3JlYWRPcmRlckxpbmV9YCxcbiAgICApO1xuICB9KTtcblxuICB0ZXN0KFwic2FuaXRpemVDb21wbGV0ZU1pbGVzdG9uZVBhcmFtcyBwcmVzZXJ2ZXMgYWN0b3JOYW1lIGFuZCB0cmlnZ2VyUmVhc29uXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB7IHNhbml0aXplQ29tcGxldGVNaWxlc3RvbmVQYXJhbXMgfSA9IGF3YWl0IGltcG9ydChcIi4uL2Jvb3RzdHJhcC9zYW5pdGl6ZS1jb21wbGV0ZS1taWxlc3RvbmUudHNcIik7XG5cbiAgICBjb25zdCBzYW5pdGl6ZWQgPSBzYW5pdGl6ZUNvbXBsZXRlTWlsZXN0b25lUGFyYW1zKHtcbiAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICAgIHRpdGxlOiBcIlRcIixcbiAgICAgIG9uZUxpbmVyOiBcInhcIixcbiAgICAgIG5hcnJhdGl2ZTogXCJuXCIsXG4gICAgICB2ZXJpZmljYXRpb25QYXNzZWQ6IHRydWUsXG4gICAgICBhY3Rvck5hbWU6IFwiICBleGVjdXRvci0wMSAgXCIsXG4gICAgICB0cmlnZ2VyUmVhc29uOiBcIiBtaWxlc3RvbmUgdmFsaWRhdGlvbiBwYXNzZWQgXCIsXG4gICAgfSBhcyBhbnkpO1xuXG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHNhbml0aXplZC5hY3Rvck5hbWUsIFwiZXhlY3V0b3ItMDFcIik7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHNhbml0aXplZC50cmlnZ2VyUmVhc29uLCBcIm1pbGVzdG9uZSB2YWxpZGF0aW9uIHBhc3NlZFwiKTtcbiAgfSk7XG5cbiAgdGVzdChcInNhbml0aXplQ29tcGxldGVNaWxlc3RvbmVQYXJhbXMgb21pdHMgYmxhbmsgYWN0b3JOYW1lL3RyaWdnZXJSZWFzb24gcmF0aGVyIHRoYW4gZW1pdHRpbmcgZW1wdHkgc3RyaW5nc1wiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyBzYW5pdGl6ZUNvbXBsZXRlTWlsZXN0b25lUGFyYW1zIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9ib290c3RyYXAvc2FuaXRpemUtY29tcGxldGUtbWlsZXN0b25lLnRzXCIpO1xuXG4gICAgY29uc3Qgc2FuaXRpemVkID0gc2FuaXRpemVDb21wbGV0ZU1pbGVzdG9uZVBhcmFtcyh7XG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICB0aXRsZTogXCJUXCIsXG4gICAgICBvbmVMaW5lcjogXCJ4XCIsXG4gICAgICBuYXJyYXRpdmU6IFwiblwiLFxuICAgICAgdmVyaWZpY2F0aW9uUGFzc2VkOiB0cnVlLFxuICAgICAgLy8gYWN0b3JOYW1lL3RyaWdnZXJSZWFzb24gb21pdHRlZFxuICAgIH0gYXMgYW55KTtcblxuICAgIGFzc2VydC5zdHJpY3RFcXVhbChzYW5pdGl6ZWQuYWN0b3JOYW1lLCB1bmRlZmluZWQpO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChzYW5pdGl6ZWQudHJpZ2dlclJlYXNvbiwgdW5kZWZpbmVkKTtcbiAgfSk7XG5cbiAgdGVzdChcInJlbmRlcmVkIFNVTU1BUlkubWQgdXNlcyBlbXB0eSBmcm9udG1hdHRlciBsaXN0cyBmb3IgZW1wdHkga2V5IGZpZWxkc1wiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyBoYW5kbGVDb21wbGV0ZU1pbGVzdG9uZSB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vdG9vbHMvY29tcGxldGUtbWlsZXN0b25lLnRzXCIpO1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICAgIGNvbnN0IG1pZCA9IFwiTTAwMVwiO1xuICAgIGNvbnN0IGRiUGF0aCA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpO1xuICAgIHRyeSB7XG4gICAgICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcbiAgICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBtaWQsIHRpdGxlOiBcIkVtcHR5IEVucmljaG1lbnRcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuICAgICAgaW5zZXJ0U2xpY2UoeyBpZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IG1pZCwgdGl0bGU6IFwiU2xpY2VcIiwgc3RhdHVzOiBcImNvbXBsZXRlXCIgfSk7XG4gICAgICBpbnNlcnRUYXNrKHsgaWQ6IFwiVDAxXCIsIHNsaWNlSWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBtaWQsIHRpdGxlOiBcIlRhc2tcIiwgc3RhdHVzOiBcImNvbXBsZXRlXCIgfSk7XG5cbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZUNvbXBsZXRlTWlsZXN0b25lKHtcbiAgICAgICAgbWlsZXN0b25lSWQ6IG1pZCxcbiAgICAgICAgdGl0bGU6IFwiRW1wdHkgRW5yaWNobWVudFwiLFxuICAgICAgICBvbmVMaW5lcjogXCJubyBlbnJpY2htZW50XCIsXG4gICAgICAgIG5hcnJhdGl2ZTogXCJkaWQgdGhlIHRoaW5nXCIsXG4gICAgICAgIC8vIGVucmljaG1lbnQgZmllbGRzIGludGVudGlvbmFsbHkgZW1wdHkgKHBvc3Qtc2FuaXRpemVyIHN0YXRlKVxuICAgICAgICBzdWNjZXNzQ3JpdGVyaWFSZXN1bHRzOiBcIlwiLFxuICAgICAgICBkZWZpbml0aW9uT2ZEb25lUmVzdWx0czogXCJcIixcbiAgICAgICAgcmVxdWlyZW1lbnRPdXRjb21lczogXCJcIixcbiAgICAgICAga2V5RGVjaXNpb25zOiBbXSxcbiAgICAgICAga2V5RmlsZXM6IFtdLFxuICAgICAgICBsZXNzb25zTGVhcm5lZDogW10sXG4gICAgICAgIGZvbGxvd1VwczogXCJcIixcbiAgICAgICAgZGV2aWF0aW9uczogXCJcIixcbiAgICAgICAgdmVyaWZpY2F0aW9uUGFzc2VkOiB0cnVlLFxuICAgICAgfSwgYmFzZSk7XG5cbiAgICAgIGFzc2VydC5vayghKFwiZXJyb3JcIiBpbiByZXN1bHQpLCBgaGFuZGxlciBzaG91bGQgc3VjY2VlZDogJHtKU09OLnN0cmluZ2lmeShyZXN1bHQpfWApO1xuICAgICAgY29uc3Qgc3VtbWFyeSA9IHJlYWRGaWxlU3luYygocmVzdWx0IGFzIHsgc3VtbWFyeVBhdGg6IHN0cmluZyB9KS5zdW1tYXJ5UGF0aCwgXCJ1dGYtOFwiKTtcbiAgICAgIGFzc2VydC5tYXRjaChzdW1tYXJ5LCAvIyMgU3VjY2VzcyBDcml0ZXJpYSBSZXN1bHRzXFxuXFxuTm90IHByb3ZpZGVkXFwuLyk7XG4gICAgICBhc3NlcnQubWF0Y2goc3VtbWFyeSwgLyMjIERlZmluaXRpb24gb2YgRG9uZSBSZXN1bHRzXFxuXFxuTm90IHByb3ZpZGVkXFwuLyk7XG4gICAgICBhc3NlcnQubWF0Y2goc3VtbWFyeSwgLyMjIFJlcXVpcmVtZW50IE91dGNvbWVzXFxuXFxuTm90IHByb3ZpZGVkXFwuLyk7XG4gICAgICBhc3NlcnQubWF0Y2goc3VtbWFyeSwgL2tleV9kZWNpc2lvbnM6XFxzKlxcW1xcXS8pO1xuICAgICAgYXNzZXJ0Lm1hdGNoKHN1bW1hcnksIC9rZXlfZmlsZXM6XFxzKlxcW1xcXS8pO1xuICAgICAgYXNzZXJ0LmRvZXNOb3RNYXRjaChzdW1tYXJ5LCAva2V5Xyg/OmRlY2lzaW9uc3xmaWxlcyk6XFxuICAtIFxcKG5vbmVcXCkvKTtcbiAgICAgIGFzc2VydC5tYXRjaChzdW1tYXJ5LCAvIyMgRGV2aWF0aW9uc1xcblxcbk5vbmVcXC4vKTtcbiAgICAgIGFzc2VydC5tYXRjaChzdW1tYXJ5LCAvIyMgRm9sbG93LXVwc1xcblxcbk5vbmVcXC4vKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgdHJ5IHsgY2xvc2VEYXRhYmFzZSgpOyB9IGNhdGNoIHsgLyogKi8gfVxuICAgICAgY2xlYXJQYXRoQ2FjaGUoKTtcbiAgICAgIGNsZWFyUGFyc2VDYWNoZSgpO1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFDQSxTQUFT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
