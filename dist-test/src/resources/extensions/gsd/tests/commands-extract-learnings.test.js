import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
import {
  parseExtractLearningsArgs,
  buildLearningsOutputPath,
  resolvePhaseArtifacts,
  buildExtractLearningsPrompt,
  buildExtractionStepsBlock,
  buildFrontmatter,
  extractProjectName
} from "../commands-extract-learnings.js";
describe("parseExtractLearningsArgs", () => {
  it("parses a milestone ID", () => {
    const result = parseExtractLearningsArgs("M001");
    assert.deepEqual(result, { milestoneId: "M001" });
  });
  it("returns null milestoneId for empty string", () => {
    const result = parseExtractLearningsArgs("");
    assert.deepEqual(result, { milestoneId: null });
  });
  it("returns null milestoneId for whitespace-only string", () => {
    const result = parseExtractLearningsArgs("  ");
    assert.deepEqual(result, { milestoneId: null });
  });
  it("trims whitespace from milestone ID", () => {
    const result = parseExtractLearningsArgs("  M002  ");
    assert.deepEqual(result, { milestoneId: "M002" });
  });
});
describe("buildLearningsOutputPath", () => {
  it("builds the correct output path", () => {
    const result = buildLearningsOutputPath("/base/.gsd/milestones/M001", "M001");
    assert.equal(result, "/base/.gsd/milestones/M001/M001-LEARNINGS.md");
  });
  it("builds path for different milestone ID", () => {
    const result = buildLearningsOutputPath("/project/.gsd/milestones/M005", "M005");
    assert.equal(result, "/project/.gsd/milestones/M005/M005-LEARNINGS.md");
  });
});
describe("resolvePhaseArtifacts", () => {
  let tmpBase;
  beforeEach(() => {
    tmpBase = join(tmpdir(), `gsd-learnings-test-${randomUUID()}`);
    mkdirSync(tmpBase, { recursive: true });
  });
  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });
  it("finds required ROADMAP and SUMMARY when both present", () => {
    writeFileSync(join(tmpBase, "M001-ROADMAP.md"), "# M001 Roadmap content", "utf-8");
    writeFileSync(join(tmpBase, "M001-SUMMARY.md"), "# M001 Summary content", "utf-8");
    const result = resolvePhaseArtifacts(tmpBase, "M001");
    assert.equal(result.roadmap, join(tmpBase, "M001-ROADMAP.md"));
    assert.equal(result.summary, join(tmpBase, "M001-SUMMARY.md"));
    assert.deepEqual(result.missingRequired, []);
  });
  it("reports missing ROADMAP as missingRequired (regression for #4429)", () => {
    writeFileSync(join(tmpBase, "M001-SUMMARY.md"), "# Summary", "utf-8");
    const result = resolvePhaseArtifacts(tmpBase, "M001");
    assert.ok(result.missingRequired.includes("M001-ROADMAP.md"));
    assert.equal(result.roadmap, null);
  });
  it("does NOT require M001-PLAN.md (regression for #4429 \u2014 milestones use ROADMAP)", () => {
    writeFileSync(join(tmpBase, "M001-ROADMAP.md"), "# Roadmap", "utf-8");
    writeFileSync(join(tmpBase, "M001-SUMMARY.md"), "# Summary", "utf-8");
    const result = resolvePhaseArtifacts(tmpBase, "M001");
    assert.ok(
      !result.missingRequired.includes("M001-PLAN.md"),
      "PLAN.md must not be demanded at milestone scope"
    );
    assert.deepEqual(result.missingRequired, []);
  });
  it("reports missing SUMMARY as missingRequired", () => {
    writeFileSync(join(tmpBase, "M001-ROADMAP.md"), "# Roadmap", "utf-8");
    const result = resolvePhaseArtifacts(tmpBase, "M001");
    assert.ok(result.missingRequired.includes("M001-SUMMARY.md"));
    assert.equal(result.summary, null);
  });
  it("reports both required files missing when neither present", () => {
    const result = resolvePhaseArtifacts(tmpBase, "M001");
    assert.equal(result.missingRequired.length, 2);
    assert.ok(result.missingRequired.includes("M001-ROADMAP.md"));
    assert.ok(result.missingRequired.includes("M001-SUMMARY.md"));
  });
  it("finds optional VERIFICATION when present", () => {
    writeFileSync(join(tmpBase, "M001-ROADMAP.md"), "# Roadmap", "utf-8");
    writeFileSync(join(tmpBase, "M001-SUMMARY.md"), "# Summary", "utf-8");
    writeFileSync(join(tmpBase, "M001-VERIFICATION.md"), "# Verification", "utf-8");
    const result = resolvePhaseArtifacts(tmpBase, "M001");
    assert.equal(result.verification, join(tmpBase, "M001-VERIFICATION.md"));
  });
  it("returns null for optional VERIFICATION when absent", () => {
    writeFileSync(join(tmpBase, "M001-ROADMAP.md"), "# Roadmap", "utf-8");
    writeFileSync(join(tmpBase, "M001-SUMMARY.md"), "# Summary", "utf-8");
    const result = resolvePhaseArtifacts(tmpBase, "M001");
    assert.equal(result.verification, null);
  });
  it("finds optional UAT when present", () => {
    writeFileSync(join(tmpBase, "M001-ROADMAP.md"), "# Roadmap", "utf-8");
    writeFileSync(join(tmpBase, "M001-SUMMARY.md"), "# Summary", "utf-8");
    writeFileSync(join(tmpBase, "M001-UAT.md"), "# UAT", "utf-8");
    const result = resolvePhaseArtifacts(tmpBase, "M001");
    assert.equal(result.uat, join(tmpBase, "M001-UAT.md"));
  });
  it("returns null for optional UAT when absent, no error", () => {
    writeFileSync(join(tmpBase, "M001-ROADMAP.md"), "# Roadmap", "utf-8");
    writeFileSync(join(tmpBase, "M001-SUMMARY.md"), "# Summary", "utf-8");
    const result = resolvePhaseArtifacts(tmpBase, "M001");
    assert.equal(result.uat, null);
    assert.deepEqual(result.missingRequired, []);
  });
});
describe("buildExtractLearningsPrompt", () => {
  it("includes milestoneId and outputPath", () => {
    const result = buildExtractLearningsPrompt({
      milestoneId: "M001",
      milestoneName: "Test Milestone",
      outputPath: "/project/.gsd/milestones/M001/M001-LEARNINGS.md",
      relativeOutputPath: ".gsd/milestones/M001/M001-LEARNINGS.md",
      roadmapContent: "# Roadmap content",
      summaryContent: "# Summary content",
      verificationContent: null,
      uatContent: null,
      missingArtifacts: [],
      projectName: "MyProject"
    });
    assert.ok(result.includes("M001"));
    assert.ok(result.includes("/project/.gsd/milestones/M001/M001-LEARNINGS.md"));
  });
  it("includes all 4 learning categories", () => {
    const result = buildExtractLearningsPrompt({
      milestoneId: "M001",
      milestoneName: "Test Milestone",
      outputPath: "/out/M001-LEARNINGS.md",
      relativeOutputPath: ".gsd/milestones/M001/M001-LEARNINGS.md",
      roadmapContent: "# Roadmap",
      summaryContent: "# Summary",
      verificationContent: null,
      uatContent: null,
      missingArtifacts: [],
      projectName: "MyProject"
    });
    assert.ok(result.includes("Decisions"));
    assert.ok(result.includes("Lessons"));
    assert.ok(result.includes("Patterns"));
    assert.ok(result.includes("Surprises"));
  });
  it("includes roadmap and summary content", () => {
    const result = buildExtractLearningsPrompt({
      milestoneId: "M001",
      milestoneName: "Test Milestone",
      outputPath: "/out/M001-LEARNINGS.md",
      relativeOutputPath: ".gsd/milestones/M001/M001-LEARNINGS.md",
      roadmapContent: "ROADMAP_CONTENT_UNIQUE_123",
      summaryContent: "SUMMARY_CONTENT_UNIQUE_456",
      verificationContent: null,
      uatContent: null,
      missingArtifacts: [],
      projectName: "MyProject"
    });
    assert.ok(result.includes("ROADMAP_CONTENT_UNIQUE_123"));
    assert.ok(result.includes("SUMMARY_CONTENT_UNIQUE_456"));
  });
  it("includes optional artifacts when present", () => {
    const result = buildExtractLearningsPrompt({
      milestoneId: "M001",
      milestoneName: "Test Milestone",
      outputPath: "/out/M001-LEARNINGS.md",
      relativeOutputPath: ".gsd/milestones/M001/M001-LEARNINGS.md",
      roadmapContent: "# Roadmap",
      summaryContent: "# Summary",
      verificationContent: "VERIFICATION_UNIQUE_789",
      uatContent: "UAT_UNIQUE_012",
      missingArtifacts: [],
      projectName: "MyProject"
    });
    assert.ok(result.includes("VERIFICATION_UNIQUE_789"));
    assert.ok(result.includes("UAT_UNIQUE_012"));
  });
  it("lists missing artifacts when present", () => {
    const result = buildExtractLearningsPrompt({
      milestoneId: "M001",
      milestoneName: "Test Milestone",
      outputPath: "/out/M001-LEARNINGS.md",
      relativeOutputPath: ".gsd/milestones/M001/M001-LEARNINGS.md",
      roadmapContent: "# Roadmap",
      summaryContent: "# Summary",
      verificationContent: null,
      uatContent: null,
      missingArtifacts: ["M001-VERIFICATION.md"],
      projectName: "MyProject"
    });
    assert.ok(result.includes("M001-VERIFICATION.md"));
  });
  it("references capture_thought as the memory-store mirror write (Option A' dual-write)", () => {
    const result = buildExtractLearningsPrompt({
      milestoneId: "M001",
      milestoneName: "Test Milestone",
      outputPath: "/out/M001-LEARNINGS.md",
      relativeOutputPath: ".gsd/milestones/M001/M001-LEARNINGS.md",
      roadmapContent: "# Roadmap",
      summaryContent: "# Summary",
      verificationContent: null,
      uatContent: null,
      missingArtifacts: [],
      projectName: "MyProject"
    });
    assert.ok(
      result.includes("capture_thought"),
      "prompt must instruct the LLM to mirror durable insights into the memory store via capture_thought"
    );
  });
  it("does NOT reference phantom gsd_graph tool (regression for #4429)", () => {
    const result = buildExtractLearningsPrompt({
      milestoneId: "M001",
      milestoneName: "Test Milestone",
      outputPath: "/out/M001-LEARNINGS.md",
      relativeOutputPath: ".gsd/milestones/M001/M001-LEARNINGS.md",
      roadmapContent: "# Roadmap",
      summaryContent: "# Summary",
      verificationContent: null,
      uatContent: null,
      missingArtifacts: [],
      projectName: "MyProject"
    });
    assert.ok(
      !result.includes("gsd_graph"),
      "prompt must not advertise the non-existent gsd_graph tool"
    );
  });
  it("source-attribution example references ROADMAP.md, not PLAN.md (regression for #4429)", () => {
    const result = buildExtractLearningsPrompt({
      milestoneId: "M001",
      milestoneName: "Test Milestone",
      outputPath: "/out/M001-LEARNINGS.md",
      relativeOutputPath: ".gsd/milestones/M001/M001-LEARNINGS.md",
      roadmapContent: "# Roadmap",
      summaryContent: "# Summary",
      verificationContent: null,
      uatContent: null,
      missingArtifacts: [],
      projectName: "MyProject"
    });
    assert.ok(result.includes("M001-ROADMAP.md/Architecture Decisions"));
    assert.ok(!result.includes("M001-PLAN.md/Architecture Decisions"));
  });
});
describe("buildFrontmatter", () => {
  it("starts with --- and ends with ---", () => {
    const result = buildFrontmatter({
      milestoneId: "M001",
      milestoneName: "Test Milestone",
      projectName: "MyProject",
      generatedAt: "2026-04-15T10:00:00Z",
      counts: { decisions: 0, lessons: 0, patterns: 0, surprises: 0 },
      missingArtifacts: []
    });
    assert.ok(result.startsWith("---\n"));
    assert.ok(result.endsWith("---"));
  });
  it("includes required fields", () => {
    const result = buildFrontmatter({
      milestoneId: "M001",
      milestoneName: "Test Milestone",
      projectName: "MyProject",
      generatedAt: "2026-04-15T10:00:00Z",
      counts: { decisions: 3, lessons: 2, patterns: 1, surprises: 0 },
      missingArtifacts: []
    });
    assert.ok(result.includes("phase:"));
    assert.ok(result.includes("phase_name:"));
    assert.ok(result.includes("project:"));
    assert.ok(result.includes("generated:"));
    assert.ok(result.includes("counts:"));
    assert.ok(result.includes("missing_artifacts:"));
  });
  it("includes milestoneId as phase value", () => {
    const result = buildFrontmatter({
      milestoneId: "M001",
      milestoneName: "Auth System",
      projectName: "MyApp",
      generatedAt: "2026-04-15T10:00:00Z",
      counts: { decisions: 0, lessons: 0, patterns: 0, surprises: 0 },
      missingArtifacts: []
    });
    assert.ok(result.includes("M001"));
    assert.ok(result.includes("Auth System"));
    assert.ok(result.includes("MyApp"));
    assert.ok(result.includes("2026-04-15T10:00:00Z"));
  });
  it("includes missing artifacts list", () => {
    const result = buildFrontmatter({
      milestoneId: "M001",
      milestoneName: "Test",
      projectName: "Proj",
      generatedAt: "2026-04-15T10:00:00Z",
      counts: { decisions: 0, lessons: 0, patterns: 0, surprises: 0 },
      missingArtifacts: ["M001-VERIFICATION.md", "M001-UAT.md"]
    });
    assert.ok(result.includes("M001-VERIFICATION.md"));
    assert.ok(result.includes("M001-UAT.md"));
  });
});
describe("extractProjectName", () => {
  let tmpBase;
  beforeEach(() => {
    tmpBase = join(tmpdir(), `gsd-projname-test-${randomUUID()}`);
    mkdirSync(join(tmpBase, ".gsd"), { recursive: true });
  });
  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });
  it("reads name from PROJECT.md frontmatter", () => {
    writeFileSync(
      join(tmpBase, ".gsd", "PROJECT.md"),
      "---\nname: My Cool Project\nversion: 1\n---\n# Project\n",
      "utf-8"
    );
    const result = extractProjectName(tmpBase);
    assert.equal(result, "My Cool Project");
  });
  it("falls back to directory name when PROJECT.md absent", () => {
    const result = extractProjectName(tmpBase);
    assert.equal(result, tmpBase.split("/").at(-1));
  });
  it("falls back to directory name when PROJECT.md has no name field", () => {
    writeFileSync(
      join(tmpBase, ".gsd", "PROJECT.md"),
      "---\nversion: 1\n---\n# Project\n",
      "utf-8"
    );
    const result = extractProjectName(tmpBase);
    assert.equal(result, tmpBase.split("/").at(-1));
  });
});
describe("buildExtractionStepsBlock", () => {
  const ctx = {
    milestoneId: "M042",
    outputPath: "/project/.gsd/milestones/M042/M042-LEARNINGS.md",
    relativeOutputPath: ".gsd/milestones/M042/M042-LEARNINGS.md"
  };
  it("declares itself as the structured extraction procedure", () => {
    const block = buildExtractionStepsBlock(ctx);
    assert.ok(block.includes("Structured Learnings Extraction"));
  });
  it("instructs the LLM to write LEARNINGS.md at the given relative path", () => {
    const block = buildExtractionStepsBlock(ctx);
    assert.ok(block.includes(ctx.relativeOutputPath));
    assert.ok(block.includes("YAML frontmatter"));
  });
  it("covers all four extraction categories", () => {
    const block = buildExtractionStepsBlock(ctx);
    assert.ok(block.includes("Decisions"));
    assert.ok(block.includes("Lessons"));
    assert.ok(block.includes("Patterns"));
    assert.ok(block.includes("Surprises"));
  });
  it("requires a Source attribution for every item", () => {
    const block = buildExtractionStepsBlock(ctx);
    assert.ok(block.includes("Source:"));
    assert.ok(block.includes("M042-ROADMAP.md"));
  });
  it("keeps Surprises milestone-local (not persisted to memory store, no MCP call)", () => {
    const block = buildExtractionStepsBlock(ctx);
    assert.ok(block.includes("Surprises stay only in LEARNINGS.md"));
  });
  it("enforces a deduplication rule across all persistence steps", () => {
    const block = buildExtractionStepsBlock(ctx);
    assert.ok(/deduplication/i.test(block) || /dedup/i.test(block));
    assert.ok(/semantically equivalent/i.test(block));
    assert.ok(/skip/i.test(block));
  });
  it("limits duplicate checks to one milestone-scoped memory query", () => {
    const block = buildExtractionStepsBlock(ctx);
    const memoryQueryMatches = block.match(/memory_query/g) ?? [];
    assert.equal(memoryQueryMatches.length, 1);
    assert.ok(block.includes("Do not re-read milestone artefacts or repeat memory queries category-by-category"));
    assert.ok(!block.includes("Before each `capture_thought` call, optionally call `memory_query`"));
  });
  it("instructs capture_thought as the sole persistence path for Patterns, Lessons, and Decisions (ADR-013 step 6 cutover)", () => {
    const block = buildExtractionStepsBlock(ctx);
    const captureThoughtMatches = block.match(/capture_thought/g) ?? [];
    assert.ok(
      captureThoughtMatches.length >= 3,
      `expected at least 3 capture_thought references (Patterns + Lessons + Decisions); got ${captureThoughtMatches.length}`
    );
    assert.ok(/category:\s*"pattern"/.test(block), 'Patterns must use category: "pattern"');
    assert.ok(/category:\s*"gotcha"/.test(block), 'Lessons must reference category: "gotcha"');
    assert.ok(/category:\s*"architecture"/.test(block), 'Decisions must use category: "architecture"');
    assert.ok(block.includes(`scope: "${ctx.milestoneId}"`), "capture_thought calls must scope to the milestone ID");
  });
  it("removes the legacy KNOWLEDGE.md table append step (ADR-013 step 6 cutover)", () => {
    const block = buildExtractionStepsBlock(ctx);
    assert.ok(!block.includes("| # | Scope | Rule | Why | Added |"), "Rules table scaffolding must be removed");
    assert.ok(!block.includes("| # | Pattern | Where | Notes |"), "Patterns table scaffolding must be removed");
    assert.ok(!block.includes("| # | What Happened | Root Cause | Fix | Scope |"), "Lessons table scaffolding must be removed");
    assert.ok(!/\| P<NNN>/.test(block), "Pattern row template must be removed");
    assert.ok(!/\| L<NNN>/.test(block), "Lesson row template must be removed");
    assert.ok(!block.includes(".gsd/KNOWLEDGE.md"), "extraction flow must not reference KNOWLEDGE.md as a write target");
  });
  it("removes the gsd_save_decision call (ADR-013 step 6 cutover)", () => {
    const block = buildExtractionStepsBlock(ctx);
    assert.ok(!block.includes("gsd_save_decision"), "gsd_save_decision must no longer appear in extraction steps");
  });
  it("requires structuredFields payload on architecture-category memories (ADR-013 lossless projection)", () => {
    const block = buildExtractionStepsBlock(ctx);
    assert.ok(/structuredFields/.test(block), "Decisions persistence step must instruct structuredFields use");
    assert.ok(
      /scope/i.test(block) && /decision/i.test(block) && /choice/i.test(block) && /rationale/i.test(block),
      "structuredFields must enumerate the preserved decision fields"
    );
  });
  it("does NOT reference the non-existent gsd_graph tool (#4429 regression)", () => {
    const block = buildExtractionStepsBlock(ctx);
    assert.ok(!block.includes("gsd_graph"));
  });
  it("substitutes the milestone ID into every placeholder callout", () => {
    const block = buildExtractionStepsBlock({
      milestoneId: "M999",
      outputPath: "/p/.gsd/milestones/M999/M999-LEARNINGS.md",
      relativeOutputPath: ".gsd/milestones/M999/M999-LEARNINGS.md"
    });
    assert.ok(!block.includes("M042"));
    assert.ok(block.includes("M999"));
  });
});
describe("buildExtractLearningsPrompt composes the steps block", () => {
  it("embeds the exact buildExtractionStepsBlock output for the same context", () => {
    const shared = {
      milestoneId: "M007",
      outputPath: "/p/.gsd/milestones/M007/M007-LEARNINGS.md",
      relativeOutputPath: ".gsd/milestones/M007/M007-LEARNINGS.md"
    };
    const expected = buildExtractionStepsBlock(shared);
    const prompt = buildExtractLearningsPrompt({
      ...shared,
      milestoneName: "Composition",
      roadmapContent: "# Roadmap body",
      summaryContent: "# Summary body",
      verificationContent: null,
      uatContent: null,
      missingArtifacts: [],
      projectName: "TestProj"
    });
    assert.ok(prompt.includes(expected));
  });
  it("no longer contains the orphan-file disclaimer from the previous revision", () => {
    const prompt = buildExtractLearningsPrompt({
      milestoneId: "M001",
      milestoneName: "Test",
      outputPath: "/out/M001-LEARNINGS.md",
      relativeOutputPath: ".gsd/milestones/M001/M001-LEARNINGS.md",
      roadmapContent: "# Roadmap",
      summaryContent: "# Summary",
      verificationContent: null,
      uatContent: null,
      missingArtifacts: [],
      projectName: "P"
    });
    assert.ok(!prompt.includes("no automated pipeline currently consumes it"));
  });
});
describe("complete-milestone loadPrompt round-trip (#4429)", () => {
  it("substitutes {{extractLearningsSteps}} end-to-end via prompt-loader", async () => {
    const { loadPrompt } = await import("../prompt-loader.js");
    const stepsBlock = buildExtractionStepsBlock({
      milestoneId: "M123",
      outputPath: "/p/.gsd/milestones/M123/M123-LEARNINGS.md",
      relativeOutputPath: ".gsd/milestones/M123/M123-LEARNINGS.md"
    });
    const rendered = loadPrompt("complete-milestone", {
      workingDirectory: "/p",
      milestoneId: "M123",
      milestoneTitle: "Test Milestone",
      roadmapPath: ".gsd/milestones/M123/M123-ROADMAP.md",
      inlinedContext: "(inlined context stub)",
      milestoneSummaryPath: "/p/.gsd/milestones/M123/M123-SUMMARY.md",
      extractLearningsSteps: stepsBlock
    });
    assert.ok(!rendered.includes("{{extractLearningsSteps}}"));
    assert.ok(rendered.includes("Structured Learnings Extraction"));
    assert.ok(rendered.includes("capture_thought"));
    assert.ok(rendered.includes("M123"));
  });
});
describe("complete-milestone.md template wiring (#4429)", () => {
  const promptPath = join(
    __dirname,
    "..",
    "prompts",
    "complete-milestone.md"
  );
  it("declares the {{extractLearningsSteps}} placeholder", () => {
    const content = readFileSync(promptPath, "utf-8");
    assert.ok(content.includes("{{extractLearningsSteps}}"));
  });
  it("no longer contains the deprecated ad-hoc KNOWLEDGE.md step", () => {
    const content = readFileSync(promptPath, "utf-8");
    assert.ok(
      !content.includes("Review all slice summaries for cross-cutting lessons, patterns, or gotchas"),
      "the pre-#4429 one-sentence step 12 must be removed"
    );
  });
  it("keeps the milestone-completion commit instruction after the placeholder", () => {
    const content = readFileSync(promptPath, "utf-8");
    const placeholderIdx = content.indexOf("{{extractLearningsSteps}}");
    const commitIdx = content.indexOf("Do not commit manually");
    assert.ok(placeholderIdx > 0);
    assert.ok(commitIdx > placeholderIdx, "commit instruction must come after extraction block");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jb21tYW5kcy1leHRyYWN0LWxlYXJuaW5ncy50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBHU0QyIGNvbW1hbmRzLWV4dHJhY3QtbGVhcm5pbmdzIHRlc3RzXG5pbXBvcnQgeyBkZXNjcmliZSwgaXQsIGJlZm9yZUVhY2gsIGFmdGVyRWFjaCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkaXJTeW5jLCB3cml0ZUZpbGVTeW5jLCBybVN5bmMsIHJlYWRGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luLCBkaXJuYW1lIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcblxuY29uc3QgX19kaXJuYW1lID0gZGlybmFtZShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuXG5pbXBvcnQge1xuICBwYXJzZUV4dHJhY3RMZWFybmluZ3NBcmdzLFxuICBidWlsZExlYXJuaW5nc091dHB1dFBhdGgsXG4gIHJlc29sdmVQaGFzZUFydGlmYWN0cyxcbiAgYnVpbGRFeHRyYWN0TGVhcm5pbmdzUHJvbXB0LFxuICBidWlsZEV4dHJhY3Rpb25TdGVwc0Jsb2NrLFxuICBidWlsZEZyb250bWF0dGVyLFxuICBleHRyYWN0UHJvamVjdE5hbWUsXG59IGZyb20gXCIuLi9jb21tYW5kcy1leHRyYWN0LWxlYXJuaW5ncy5qc1wiO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgcGFyc2VFeHRyYWN0TGVhcm5pbmdzQXJncyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJwYXJzZUV4dHJhY3RMZWFybmluZ3NBcmdzXCIsICgpID0+IHtcbiAgaXQoXCJwYXJzZXMgYSBtaWxlc3RvbmUgSURcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IHBhcnNlRXh0cmFjdExlYXJuaW5nc0FyZ3MoXCJNMDAxXCIpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwocmVzdWx0LCB7IG1pbGVzdG9uZUlkOiBcIk0wMDFcIiB9KTtcbiAgfSk7XG5cbiAgaXQoXCJyZXR1cm5zIG51bGwgbWlsZXN0b25lSWQgZm9yIGVtcHR5IHN0cmluZ1wiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gcGFyc2VFeHRyYWN0TGVhcm5pbmdzQXJncyhcIlwiKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdCwgeyBtaWxlc3RvbmVJZDogbnVsbCB9KTtcbiAgfSk7XG5cbiAgaXQoXCJyZXR1cm5zIG51bGwgbWlsZXN0b25lSWQgZm9yIHdoaXRlc3BhY2Utb25seSBzdHJpbmdcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IHBhcnNlRXh0cmFjdExlYXJuaW5nc0FyZ3MoXCIgIFwiKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdCwgeyBtaWxlc3RvbmVJZDogbnVsbCB9KTtcbiAgfSk7XG5cbiAgaXQoXCJ0cmltcyB3aGl0ZXNwYWNlIGZyb20gbWlsZXN0b25lIElEXCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBwYXJzZUV4dHJhY3RMZWFybmluZ3NBcmdzKFwiICBNMDAyICBcIik7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQsIHsgbWlsZXN0b25lSWQ6IFwiTTAwMlwiIH0pO1xuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgYnVpbGRMZWFybmluZ3NPdXRwdXRQYXRoIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcImJ1aWxkTGVhcm5pbmdzT3V0cHV0UGF0aFwiLCAoKSA9PiB7XG4gIGl0KFwiYnVpbGRzIHRoZSBjb3JyZWN0IG91dHB1dCBwYXRoXCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBidWlsZExlYXJuaW5nc091dHB1dFBhdGgoXCIvYmFzZS8uZ3NkL21pbGVzdG9uZXMvTTAwMVwiLCBcIk0wMDFcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgXCIvYmFzZS8uZ3NkL21pbGVzdG9uZXMvTTAwMS9NMDAxLUxFQVJOSU5HUy5tZFwiKTtcbiAgfSk7XG5cbiAgaXQoXCJidWlsZHMgcGF0aCBmb3IgZGlmZmVyZW50IG1pbGVzdG9uZSBJRFwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gYnVpbGRMZWFybmluZ3NPdXRwdXRQYXRoKFwiL3Byb2plY3QvLmdzZC9taWxlc3RvbmVzL00wMDVcIiwgXCJNMDA1XCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIFwiL3Byb2plY3QvLmdzZC9taWxlc3RvbmVzL00wMDUvTTAwNS1MRUFSTklOR1MubWRcIik7XG4gIH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCByZXNvbHZlUGhhc2VBcnRpZmFjdHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwicmVzb2x2ZVBoYXNlQXJ0aWZhY3RzXCIsICgpID0+IHtcbiAgbGV0IHRtcEJhc2U6IHN0cmluZztcblxuICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICB0bXBCYXNlID0gam9pbih0bXBkaXIoKSwgYGdzZC1sZWFybmluZ3MtdGVzdC0ke3JhbmRvbVVVSUQoKX1gKTtcbiAgICBta2RpclN5bmModG1wQmFzZSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIH0pO1xuXG4gIGFmdGVyRWFjaCgoKSA9PiB7XG4gICAgcm1TeW5jKHRtcEJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfSk7XG5cbiAgaXQoXCJmaW5kcyByZXF1aXJlZCBST0FETUFQIGFuZCBTVU1NQVJZIHdoZW4gYm90aCBwcmVzZW50XCIsICgpID0+IHtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4odG1wQmFzZSwgXCJNMDAxLVJPQURNQVAubWRcIiksIFwiIyBNMDAxIFJvYWRtYXAgY29udGVudFwiLCBcInV0Zi04XCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbih0bXBCYXNlLCBcIk0wMDEtU1VNTUFSWS5tZFwiKSwgXCIjIE0wMDEgU3VtbWFyeSBjb250ZW50XCIsIFwidXRmLThcIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSByZXNvbHZlUGhhc2VBcnRpZmFjdHModG1wQmFzZSwgXCJNMDAxXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQucm9hZG1hcCwgam9pbih0bXBCYXNlLCBcIk0wMDEtUk9BRE1BUC5tZFwiKSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zdW1tYXJ5LCBqb2luKHRtcEJhc2UsIFwiTTAwMS1TVU1NQVJZLm1kXCIpKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdC5taXNzaW5nUmVxdWlyZWQsIFtdKTtcbiAgfSk7XG5cbiAgaXQoXCJyZXBvcnRzIG1pc3NpbmcgUk9BRE1BUCBhcyBtaXNzaW5nUmVxdWlyZWQgKHJlZ3Jlc3Npb24gZm9yICM0NDI5KVwiLCAoKSA9PiB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHRtcEJhc2UsIFwiTTAwMS1TVU1NQVJZLm1kXCIpLCBcIiMgU3VtbWFyeVwiLCBcInV0Zi04XCIpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gcmVzb2x2ZVBoYXNlQXJ0aWZhY3RzKHRtcEJhc2UsIFwiTTAwMVwiKTtcbiAgICBhc3NlcnQub2socmVzdWx0Lm1pc3NpbmdSZXF1aXJlZC5pbmNsdWRlcyhcIk0wMDEtUk9BRE1BUC5tZFwiKSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5yb2FkbWFwLCBudWxsKTtcbiAgfSk7XG5cbiAgaXQoXCJkb2VzIE5PVCByZXF1aXJlIE0wMDEtUExBTi5tZCAocmVncmVzc2lvbiBmb3IgIzQ0MjkgXHUyMDE0IG1pbGVzdG9uZXMgdXNlIFJPQURNQVApXCIsICgpID0+IHtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4odG1wQmFzZSwgXCJNMDAxLVJPQURNQVAubWRcIiksIFwiIyBSb2FkbWFwXCIsIFwidXRmLThcIik7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHRtcEJhc2UsIFwiTTAwMS1TVU1NQVJZLm1kXCIpLCBcIiMgU3VtbWFyeVwiLCBcInV0Zi04XCIpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gcmVzb2x2ZVBoYXNlQXJ0aWZhY3RzKHRtcEJhc2UsIFwiTTAwMVwiKTtcbiAgICBhc3NlcnQub2soXG4gICAgICAhcmVzdWx0Lm1pc3NpbmdSZXF1aXJlZC5pbmNsdWRlcyhcIk0wMDEtUExBTi5tZFwiKSxcbiAgICAgIFwiUExBTi5tZCBtdXN0IG5vdCBiZSBkZW1hbmRlZCBhdCBtaWxlc3RvbmUgc2NvcGVcIixcbiAgICApO1xuICAgIGFzc2VydC5kZWVwRXF1YWwocmVzdWx0Lm1pc3NpbmdSZXF1aXJlZCwgW10pO1xuICB9KTtcblxuICBpdChcInJlcG9ydHMgbWlzc2luZyBTVU1NQVJZIGFzIG1pc3NpbmdSZXF1aXJlZFwiLCAoKSA9PiB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHRtcEJhc2UsIFwiTTAwMS1ST0FETUFQLm1kXCIpLCBcIiMgUm9hZG1hcFwiLCBcInV0Zi04XCIpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gcmVzb2x2ZVBoYXNlQXJ0aWZhY3RzKHRtcEJhc2UsIFwiTTAwMVwiKTtcbiAgICBhc3NlcnQub2socmVzdWx0Lm1pc3NpbmdSZXF1aXJlZC5pbmNsdWRlcyhcIk0wMDEtU1VNTUFSWS5tZFwiKSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zdW1tYXJ5LCBudWxsKTtcbiAgfSk7XG5cbiAgaXQoXCJyZXBvcnRzIGJvdGggcmVxdWlyZWQgZmlsZXMgbWlzc2luZyB3aGVuIG5laXRoZXIgcHJlc2VudFwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gcmVzb2x2ZVBoYXNlQXJ0aWZhY3RzKHRtcEJhc2UsIFwiTTAwMVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm1pc3NpbmdSZXF1aXJlZC5sZW5ndGgsIDIpO1xuICAgIGFzc2VydC5vayhyZXN1bHQubWlzc2luZ1JlcXVpcmVkLmluY2x1ZGVzKFwiTTAwMS1ST0FETUFQLm1kXCIpKTtcbiAgICBhc3NlcnQub2socmVzdWx0Lm1pc3NpbmdSZXF1aXJlZC5pbmNsdWRlcyhcIk0wMDEtU1VNTUFSWS5tZFwiKSk7XG4gIH0pO1xuXG4gIGl0KFwiZmluZHMgb3B0aW9uYWwgVkVSSUZJQ0FUSU9OIHdoZW4gcHJlc2VudFwiLCAoKSA9PiB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHRtcEJhc2UsIFwiTTAwMS1ST0FETUFQLm1kXCIpLCBcIiMgUm9hZG1hcFwiLCBcInV0Zi04XCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbih0bXBCYXNlLCBcIk0wMDEtU1VNTUFSWS5tZFwiKSwgXCIjIFN1bW1hcnlcIiwgXCJ1dGYtOFwiKTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4odG1wQmFzZSwgXCJNMDAxLVZFUklGSUNBVElPTi5tZFwiKSwgXCIjIFZlcmlmaWNhdGlvblwiLCBcInV0Zi04XCIpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gcmVzb2x2ZVBoYXNlQXJ0aWZhY3RzKHRtcEJhc2UsIFwiTTAwMVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnZlcmlmaWNhdGlvbiwgam9pbih0bXBCYXNlLCBcIk0wMDEtVkVSSUZJQ0FUSU9OLm1kXCIpKTtcbiAgfSk7XG5cbiAgaXQoXCJyZXR1cm5zIG51bGwgZm9yIG9wdGlvbmFsIFZFUklGSUNBVElPTiB3aGVuIGFic2VudFwiLCAoKSA9PiB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHRtcEJhc2UsIFwiTTAwMS1ST0FETUFQLm1kXCIpLCBcIiMgUm9hZG1hcFwiLCBcInV0Zi04XCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbih0bXBCYXNlLCBcIk0wMDEtU1VNTUFSWS5tZFwiKSwgXCIjIFN1bW1hcnlcIiwgXCJ1dGYtOFwiKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVQaGFzZUFydGlmYWN0cyh0bXBCYXNlLCBcIk0wMDFcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC52ZXJpZmljYXRpb24sIG51bGwpO1xuICB9KTtcblxuICBpdChcImZpbmRzIG9wdGlvbmFsIFVBVCB3aGVuIHByZXNlbnRcIiwgKCkgPT4ge1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbih0bXBCYXNlLCBcIk0wMDEtUk9BRE1BUC5tZFwiKSwgXCIjIFJvYWRtYXBcIiwgXCJ1dGYtOFwiKTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4odG1wQmFzZSwgXCJNMDAxLVNVTU1BUlkubWRcIiksIFwiIyBTdW1tYXJ5XCIsIFwidXRmLThcIik7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHRtcEJhc2UsIFwiTTAwMS1VQVQubWRcIiksIFwiIyBVQVRcIiwgXCJ1dGYtOFwiKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVQaGFzZUFydGlmYWN0cyh0bXBCYXNlLCBcIk0wMDFcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC51YXQsIGpvaW4odG1wQmFzZSwgXCJNMDAxLVVBVC5tZFwiKSk7XG4gIH0pO1xuXG4gIGl0KFwicmV0dXJucyBudWxsIGZvciBvcHRpb25hbCBVQVQgd2hlbiBhYnNlbnQsIG5vIGVycm9yXCIsICgpID0+IHtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4odG1wQmFzZSwgXCJNMDAxLVJPQURNQVAubWRcIiksIFwiIyBSb2FkbWFwXCIsIFwidXRmLThcIik7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHRtcEJhc2UsIFwiTTAwMS1TVU1NQVJZLm1kXCIpLCBcIiMgU3VtbWFyeVwiLCBcInV0Zi04XCIpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gcmVzb2x2ZVBoYXNlQXJ0aWZhY3RzKHRtcEJhc2UsIFwiTTAwMVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnVhdCwgbnVsbCk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQubWlzc2luZ1JlcXVpcmVkLCBbXSk7XG4gIH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBidWlsZEV4dHJhY3RMZWFybmluZ3NQcm9tcHQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiYnVpbGRFeHRyYWN0TGVhcm5pbmdzUHJvbXB0XCIsICgpID0+IHtcbiAgaXQoXCJpbmNsdWRlcyBtaWxlc3RvbmVJZCBhbmQgb3V0cHV0UGF0aFwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gYnVpbGRFeHRyYWN0TGVhcm5pbmdzUHJvbXB0KHtcbiAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICAgIG1pbGVzdG9uZU5hbWU6IFwiVGVzdCBNaWxlc3RvbmVcIixcbiAgICAgIG91dHB1dFBhdGg6IFwiL3Byb2plY3QvLmdzZC9taWxlc3RvbmVzL00wMDEvTTAwMS1MRUFSTklOR1MubWRcIixcbiAgICAgIHJlbGF0aXZlT3V0cHV0UGF0aDogXCIuZ3NkL21pbGVzdG9uZXMvTTAwMS9NMDAxLUxFQVJOSU5HUy5tZFwiLFxuICAgICAgcm9hZG1hcENvbnRlbnQ6IFwiIyBSb2FkbWFwIGNvbnRlbnRcIixcbiAgICAgIHN1bW1hcnlDb250ZW50OiBcIiMgU3VtbWFyeSBjb250ZW50XCIsXG4gICAgICB2ZXJpZmljYXRpb25Db250ZW50OiBudWxsLFxuICAgICAgdWF0Q29udGVudDogbnVsbCxcbiAgICAgIG1pc3NpbmdBcnRpZmFjdHM6IFtdLFxuICAgICAgcHJvamVjdE5hbWU6IFwiTXlQcm9qZWN0XCIsXG4gICAgfSk7XG5cbiAgICBhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKFwiTTAwMVwiKSk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcyhcIi9wcm9qZWN0Ly5nc2QvbWlsZXN0b25lcy9NMDAxL00wMDEtTEVBUk5JTkdTLm1kXCIpKTtcbiAgfSk7XG5cbiAgaXQoXCJpbmNsdWRlcyBhbGwgNCBsZWFybmluZyBjYXRlZ29yaWVzXCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBidWlsZEV4dHJhY3RMZWFybmluZ3NQcm9tcHQoe1xuICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgbWlsZXN0b25lTmFtZTogXCJUZXN0IE1pbGVzdG9uZVwiLFxuICAgICAgb3V0cHV0UGF0aDogXCIvb3V0L00wMDEtTEVBUk5JTkdTLm1kXCIsXG4gICAgICByZWxhdGl2ZU91dHB1dFBhdGg6IFwiLmdzZC9taWxlc3RvbmVzL00wMDEvTTAwMS1MRUFSTklOR1MubWRcIixcbiAgICAgIHJvYWRtYXBDb250ZW50OiBcIiMgUm9hZG1hcFwiLFxuICAgICAgc3VtbWFyeUNvbnRlbnQ6IFwiIyBTdW1tYXJ5XCIsXG4gICAgICB2ZXJpZmljYXRpb25Db250ZW50OiBudWxsLFxuICAgICAgdWF0Q29udGVudDogbnVsbCxcbiAgICAgIG1pc3NpbmdBcnRpZmFjdHM6IFtdLFxuICAgICAgcHJvamVjdE5hbWU6IFwiTXlQcm9qZWN0XCIsXG4gICAgfSk7XG5cbiAgICBhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKFwiRGVjaXNpb25zXCIpKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKFwiTGVzc29uc1wiKSk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcyhcIlBhdHRlcm5zXCIpKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKFwiU3VycHJpc2VzXCIpKTtcbiAgfSk7XG5cbiAgaXQoXCJpbmNsdWRlcyByb2FkbWFwIGFuZCBzdW1tYXJ5IGNvbnRlbnRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGJ1aWxkRXh0cmFjdExlYXJuaW5nc1Byb21wdCh7XG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICBtaWxlc3RvbmVOYW1lOiBcIlRlc3QgTWlsZXN0b25lXCIsXG4gICAgICBvdXRwdXRQYXRoOiBcIi9vdXQvTTAwMS1MRUFSTklOR1MubWRcIixcbiAgICAgIHJlbGF0aXZlT3V0cHV0UGF0aDogXCIuZ3NkL21pbGVzdG9uZXMvTTAwMS9NMDAxLUxFQVJOSU5HUy5tZFwiLFxuICAgICAgcm9hZG1hcENvbnRlbnQ6IFwiUk9BRE1BUF9DT05URU5UX1VOSVFVRV8xMjNcIixcbiAgICAgIHN1bW1hcnlDb250ZW50OiBcIlNVTU1BUllfQ09OVEVOVF9VTklRVUVfNDU2XCIsXG4gICAgICB2ZXJpZmljYXRpb25Db250ZW50OiBudWxsLFxuICAgICAgdWF0Q29udGVudDogbnVsbCxcbiAgICAgIG1pc3NpbmdBcnRpZmFjdHM6IFtdLFxuICAgICAgcHJvamVjdE5hbWU6IFwiTXlQcm9qZWN0XCIsXG4gICAgfSk7XG5cbiAgICBhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKFwiUk9BRE1BUF9DT05URU5UX1VOSVFVRV8xMjNcIikpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoXCJTVU1NQVJZX0NPTlRFTlRfVU5JUVVFXzQ1NlwiKSk7XG4gIH0pO1xuXG4gIGl0KFwiaW5jbHVkZXMgb3B0aW9uYWwgYXJ0aWZhY3RzIHdoZW4gcHJlc2VudFwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gYnVpbGRFeHRyYWN0TGVhcm5pbmdzUHJvbXB0KHtcbiAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICAgIG1pbGVzdG9uZU5hbWU6IFwiVGVzdCBNaWxlc3RvbmVcIixcbiAgICAgIG91dHB1dFBhdGg6IFwiL291dC9NMDAxLUxFQVJOSU5HUy5tZFwiLFxuICAgICAgcmVsYXRpdmVPdXRwdXRQYXRoOiBcIi5nc2QvbWlsZXN0b25lcy9NMDAxL00wMDEtTEVBUk5JTkdTLm1kXCIsXG4gICAgICByb2FkbWFwQ29udGVudDogXCIjIFJvYWRtYXBcIixcbiAgICAgIHN1bW1hcnlDb250ZW50OiBcIiMgU3VtbWFyeVwiLFxuICAgICAgdmVyaWZpY2F0aW9uQ29udGVudDogXCJWRVJJRklDQVRJT05fVU5JUVVFXzc4OVwiLFxuICAgICAgdWF0Q29udGVudDogXCJVQVRfVU5JUVVFXzAxMlwiLFxuICAgICAgbWlzc2luZ0FydGlmYWN0czogW10sXG4gICAgICBwcm9qZWN0TmFtZTogXCJNeVByb2plY3RcIixcbiAgICB9KTtcblxuICAgIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoXCJWRVJJRklDQVRJT05fVU5JUVVFXzc4OVwiKSk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcyhcIlVBVF9VTklRVUVfMDEyXCIpKTtcbiAgfSk7XG5cbiAgaXQoXCJsaXN0cyBtaXNzaW5nIGFydGlmYWN0cyB3aGVuIHByZXNlbnRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGJ1aWxkRXh0cmFjdExlYXJuaW5nc1Byb21wdCh7XG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICBtaWxlc3RvbmVOYW1lOiBcIlRlc3QgTWlsZXN0b25lXCIsXG4gICAgICBvdXRwdXRQYXRoOiBcIi9vdXQvTTAwMS1MRUFSTklOR1MubWRcIixcbiAgICAgIHJlbGF0aXZlT3V0cHV0UGF0aDogXCIuZ3NkL21pbGVzdG9uZXMvTTAwMS9NMDAxLUxFQVJOSU5HUy5tZFwiLFxuICAgICAgcm9hZG1hcENvbnRlbnQ6IFwiIyBSb2FkbWFwXCIsXG4gICAgICBzdW1tYXJ5Q29udGVudDogXCIjIFN1bW1hcnlcIixcbiAgICAgIHZlcmlmaWNhdGlvbkNvbnRlbnQ6IG51bGwsXG4gICAgICB1YXRDb250ZW50OiBudWxsLFxuICAgICAgbWlzc2luZ0FydGlmYWN0czogW1wiTTAwMS1WRVJJRklDQVRJT04ubWRcIl0sXG4gICAgICBwcm9qZWN0TmFtZTogXCJNeVByb2plY3RcIixcbiAgICB9KTtcblxuICAgIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoXCJNMDAxLVZFUklGSUNBVElPTi5tZFwiKSk7XG4gIH0pO1xuXG4gIGl0KFwicmVmZXJlbmNlcyBjYXB0dXJlX3Rob3VnaHQgYXMgdGhlIG1lbW9yeS1zdG9yZSBtaXJyb3Igd3JpdGUgKE9wdGlvbiBBJyBkdWFsLXdyaXRlKVwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gYnVpbGRFeHRyYWN0TGVhcm5pbmdzUHJvbXB0KHtcbiAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICAgIG1pbGVzdG9uZU5hbWU6IFwiVGVzdCBNaWxlc3RvbmVcIixcbiAgICAgIG91dHB1dFBhdGg6IFwiL291dC9NMDAxLUxFQVJOSU5HUy5tZFwiLFxuICAgICAgcmVsYXRpdmVPdXRwdXRQYXRoOiBcIi5nc2QvbWlsZXN0b25lcy9NMDAxL00wMDEtTEVBUk5JTkdTLm1kXCIsXG4gICAgICByb2FkbWFwQ29udGVudDogXCIjIFJvYWRtYXBcIixcbiAgICAgIHN1bW1hcnlDb250ZW50OiBcIiMgU3VtbWFyeVwiLFxuICAgICAgdmVyaWZpY2F0aW9uQ29udGVudDogbnVsbCxcbiAgICAgIHVhdENvbnRlbnQ6IG51bGwsXG4gICAgICBtaXNzaW5nQXJ0aWZhY3RzOiBbXSxcbiAgICAgIHByb2plY3ROYW1lOiBcIk15UHJvamVjdFwiLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgcmVzdWx0LmluY2x1ZGVzKFwiY2FwdHVyZV90aG91Z2h0XCIpLFxuICAgICAgXCJwcm9tcHQgbXVzdCBpbnN0cnVjdCB0aGUgTExNIHRvIG1pcnJvciBkdXJhYmxlIGluc2lnaHRzIGludG8gdGhlIG1lbW9yeSBzdG9yZSB2aWEgY2FwdHVyZV90aG91Z2h0XCIsXG4gICAgKTtcbiAgfSk7XG5cbiAgaXQoXCJkb2VzIE5PVCByZWZlcmVuY2UgcGhhbnRvbSBnc2RfZ3JhcGggdG9vbCAocmVncmVzc2lvbiBmb3IgIzQ0MjkpXCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBidWlsZEV4dHJhY3RMZWFybmluZ3NQcm9tcHQoe1xuICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgbWlsZXN0b25lTmFtZTogXCJUZXN0IE1pbGVzdG9uZVwiLFxuICAgICAgb3V0cHV0UGF0aDogXCIvb3V0L00wMDEtTEVBUk5JTkdTLm1kXCIsXG4gICAgICByZWxhdGl2ZU91dHB1dFBhdGg6IFwiLmdzZC9taWxlc3RvbmVzL00wMDEvTTAwMS1MRUFSTklOR1MubWRcIixcbiAgICAgIHJvYWRtYXBDb250ZW50OiBcIiMgUm9hZG1hcFwiLFxuICAgICAgc3VtbWFyeUNvbnRlbnQ6IFwiIyBTdW1tYXJ5XCIsXG4gICAgICB2ZXJpZmljYXRpb25Db250ZW50OiBudWxsLFxuICAgICAgdWF0Q29udGVudDogbnVsbCxcbiAgICAgIG1pc3NpbmdBcnRpZmFjdHM6IFtdLFxuICAgICAgcHJvamVjdE5hbWU6IFwiTXlQcm9qZWN0XCIsXG4gICAgfSk7XG5cbiAgICBhc3NlcnQub2soXG4gICAgICAhcmVzdWx0LmluY2x1ZGVzKFwiZ3NkX2dyYXBoXCIpLFxuICAgICAgXCJwcm9tcHQgbXVzdCBub3QgYWR2ZXJ0aXNlIHRoZSBub24tZXhpc3RlbnQgZ3NkX2dyYXBoIHRvb2xcIixcbiAgICApO1xuICB9KTtcblxuICBpdChcInNvdXJjZS1hdHRyaWJ1dGlvbiBleGFtcGxlIHJlZmVyZW5jZXMgUk9BRE1BUC5tZCwgbm90IFBMQU4ubWQgKHJlZ3Jlc3Npb24gZm9yICM0NDI5KVwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gYnVpbGRFeHRyYWN0TGVhcm5pbmdzUHJvbXB0KHtcbiAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICAgIG1pbGVzdG9uZU5hbWU6IFwiVGVzdCBNaWxlc3RvbmVcIixcbiAgICAgIG91dHB1dFBhdGg6IFwiL291dC9NMDAxLUxFQVJOSU5HUy5tZFwiLFxuICAgICAgcmVsYXRpdmVPdXRwdXRQYXRoOiBcIi5nc2QvbWlsZXN0b25lcy9NMDAxL00wMDEtTEVBUk5JTkdTLm1kXCIsXG4gICAgICByb2FkbWFwQ29udGVudDogXCIjIFJvYWRtYXBcIixcbiAgICAgIHN1bW1hcnlDb250ZW50OiBcIiMgU3VtbWFyeVwiLFxuICAgICAgdmVyaWZpY2F0aW9uQ29udGVudDogbnVsbCxcbiAgICAgIHVhdENvbnRlbnQ6IG51bGwsXG4gICAgICBtaXNzaW5nQXJ0aWZhY3RzOiBbXSxcbiAgICAgIHByb2plY3ROYW1lOiBcIk15UHJvamVjdFwiLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcyhcIk0wMDEtUk9BRE1BUC5tZC9BcmNoaXRlY3R1cmUgRGVjaXNpb25zXCIpKTtcbiAgICBhc3NlcnQub2soIXJlc3VsdC5pbmNsdWRlcyhcIk0wMDEtUExBTi5tZC9BcmNoaXRlY3R1cmUgRGVjaXNpb25zXCIpKTtcbiAgfSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGJ1aWxkRnJvbnRtYXR0ZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiYnVpbGRGcm9udG1hdHRlclwiLCAoKSA9PiB7XG4gIGl0KFwic3RhcnRzIHdpdGggLS0tIGFuZCBlbmRzIHdpdGggLS0tXCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBidWlsZEZyb250bWF0dGVyKHtcbiAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICAgIG1pbGVzdG9uZU5hbWU6IFwiVGVzdCBNaWxlc3RvbmVcIixcbiAgICAgIHByb2plY3ROYW1lOiBcIk15UHJvamVjdFwiLFxuICAgICAgZ2VuZXJhdGVkQXQ6IFwiMjAyNi0wNC0xNVQxMDowMDowMFpcIixcbiAgICAgIGNvdW50czogeyBkZWNpc2lvbnM6IDAsIGxlc3NvbnM6IDAsIHBhdHRlcm5zOiAwLCBzdXJwcmlzZXM6IDAgfSxcbiAgICAgIG1pc3NpbmdBcnRpZmFjdHM6IFtdLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5zdGFydHNXaXRoKFwiLS0tXFxuXCIpKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmVuZHNXaXRoKFwiLS0tXCIpKTtcbiAgfSk7XG5cbiAgaXQoXCJpbmNsdWRlcyByZXF1aXJlZCBmaWVsZHNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGJ1aWxkRnJvbnRtYXR0ZXIoe1xuICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgbWlsZXN0b25lTmFtZTogXCJUZXN0IE1pbGVzdG9uZVwiLFxuICAgICAgcHJvamVjdE5hbWU6IFwiTXlQcm9qZWN0XCIsXG4gICAgICBnZW5lcmF0ZWRBdDogXCIyMDI2LTA0LTE1VDEwOjAwOjAwWlwiLFxuICAgICAgY291bnRzOiB7IGRlY2lzaW9uczogMywgbGVzc29uczogMiwgcGF0dGVybnM6IDEsIHN1cnByaXNlczogMCB9LFxuICAgICAgbWlzc2luZ0FydGlmYWN0czogW10sXG4gICAgfSk7XG5cbiAgICBhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKFwicGhhc2U6XCIpKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKFwicGhhc2VfbmFtZTpcIikpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoXCJwcm9qZWN0OlwiKSk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcyhcImdlbmVyYXRlZDpcIikpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoXCJjb3VudHM6XCIpKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKFwibWlzc2luZ19hcnRpZmFjdHM6XCIpKTtcbiAgfSk7XG5cbiAgaXQoXCJpbmNsdWRlcyBtaWxlc3RvbmVJZCBhcyBwaGFzZSB2YWx1ZVwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gYnVpbGRGcm9udG1hdHRlcih7XG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICBtaWxlc3RvbmVOYW1lOiBcIkF1dGggU3lzdGVtXCIsXG4gICAgICBwcm9qZWN0TmFtZTogXCJNeUFwcFwiLFxuICAgICAgZ2VuZXJhdGVkQXQ6IFwiMjAyNi0wNC0xNVQxMDowMDowMFpcIixcbiAgICAgIGNvdW50czogeyBkZWNpc2lvbnM6IDAsIGxlc3NvbnM6IDAsIHBhdHRlcm5zOiAwLCBzdXJwcmlzZXM6IDAgfSxcbiAgICAgIG1pc3NpbmdBcnRpZmFjdHM6IFtdLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcyhcIk0wMDFcIikpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoXCJBdXRoIFN5c3RlbVwiKSk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcyhcIk15QXBwXCIpKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKFwiMjAyNi0wNC0xNVQxMDowMDowMFpcIikpO1xuICB9KTtcblxuICBpdChcImluY2x1ZGVzIG1pc3NpbmcgYXJ0aWZhY3RzIGxpc3RcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGJ1aWxkRnJvbnRtYXR0ZXIoe1xuICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgbWlsZXN0b25lTmFtZTogXCJUZXN0XCIsXG4gICAgICBwcm9qZWN0TmFtZTogXCJQcm9qXCIsXG4gICAgICBnZW5lcmF0ZWRBdDogXCIyMDI2LTA0LTE1VDEwOjAwOjAwWlwiLFxuICAgICAgY291bnRzOiB7IGRlY2lzaW9uczogMCwgbGVzc29uczogMCwgcGF0dGVybnM6IDAsIHN1cnByaXNlczogMCB9LFxuICAgICAgbWlzc2luZ0FydGlmYWN0czogW1wiTTAwMS1WRVJJRklDQVRJT04ubWRcIiwgXCJNMDAxLVVBVC5tZFwiXSxcbiAgICB9KTtcblxuICAgIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoXCJNMDAxLVZFUklGSUNBVElPTi5tZFwiKSk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcyhcIk0wMDEtVUFULm1kXCIpKTtcbiAgfSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGV4dHJhY3RQcm9qZWN0TmFtZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJleHRyYWN0UHJvamVjdE5hbWVcIiwgKCkgPT4ge1xuICBsZXQgdG1wQmFzZTogc3RyaW5nO1xuXG4gIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgIHRtcEJhc2UgPSBqb2luKHRtcGRpcigpLCBgZ3NkLXByb2puYW1lLXRlc3QtJHtyYW5kb21VVUlEKCl9YCk7XG4gICAgbWtkaXJTeW5jKGpvaW4odG1wQmFzZSwgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgfSk7XG5cbiAgYWZ0ZXJFYWNoKCgpID0+IHtcbiAgICBybVN5bmModG1wQmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcblxuICBpdChcInJlYWRzIG5hbWUgZnJvbSBQUk9KRUNULm1kIGZyb250bWF0dGVyXCIsICgpID0+IHtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbih0bXBCYXNlLCBcIi5nc2RcIiwgXCJQUk9KRUNULm1kXCIpLFxuICAgICAgXCItLS1cXG5uYW1lOiBNeSBDb29sIFByb2plY3RcXG52ZXJzaW9uOiAxXFxuLS0tXFxuIyBQcm9qZWN0XFxuXCIsXG4gICAgICBcInV0Zi04XCIsXG4gICAgKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGV4dHJhY3RQcm9qZWN0TmFtZSh0bXBCYXNlKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCBcIk15IENvb2wgUHJvamVjdFwiKTtcbiAgfSk7XG5cbiAgaXQoXCJmYWxscyBiYWNrIHRvIGRpcmVjdG9yeSBuYW1lIHdoZW4gUFJPSkVDVC5tZCBhYnNlbnRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGV4dHJhY3RQcm9qZWN0TmFtZSh0bXBCYXNlKTtcbiAgICAvLyBTaG91bGQgcmV0dXJuIHRoZSBsYXN0IHBhdGggc2VnbWVudCBvZiB0bXBCYXNlXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgdG1wQmFzZS5zcGxpdChcIi9cIikuYXQoLTEpKTtcbiAgfSk7XG5cbiAgaXQoXCJmYWxscyBiYWNrIHRvIGRpcmVjdG9yeSBuYW1lIHdoZW4gUFJPSkVDVC5tZCBoYXMgbm8gbmFtZSBmaWVsZFwiLCAoKSA9PiB7XG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4odG1wQmFzZSwgXCIuZ3NkXCIsIFwiUFJPSkVDVC5tZFwiKSxcbiAgICAgIFwiLS0tXFxudmVyc2lvbjogMVxcbi0tLVxcbiMgUHJvamVjdFxcblwiLFxuICAgICAgXCJ1dGYtOFwiLFxuICAgICk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBleHRyYWN0UHJvamVjdE5hbWUodG1wQmFzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgdG1wQmFzZS5zcGxpdChcIi9cIikuYXQoLTEpKTtcbiAgfSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGJ1aWxkRXh0cmFjdGlvblN0ZXBzQmxvY2sgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4vL1xuLy8gVGhlIHN0ZXBzIGJsb2NrIGlzIHRoZSBzaW5nbGUgc291cmNlIG9mIHRydXRoIGZvciBob3cgbGVhcm5pbmdzIGFyZSByb3V0ZWRcbi8vIGludG8gS05PV0xFREdFLm1kIGFuZCB0aGUgREVDSVNJT05TIERCLiBCb3RoIHRoZSBtYW51YWwgL2dzZCBleHRyYWN0LWxlYXJuaW5nc1xuLy8gcGF0aCBhbmQgdGhlIGF1dG8gY29tcGxldGUtbWlsZXN0b25lIHBhdGggcmVuZGVyIGl0IHZlcmJhdGltLCBzbyBldmVyeVxuLy8gc3RydWN0dXJhbCBhc3NlcnRpb24gYmVsb3cgcHJvdGVjdHMgYm90aCBwYXRocyBhdCBvbmNlLlxuXG5kZXNjcmliZShcImJ1aWxkRXh0cmFjdGlvblN0ZXBzQmxvY2tcIiwgKCkgPT4ge1xuICBjb25zdCBjdHggPSB7XG4gICAgbWlsZXN0b25lSWQ6IFwiTTA0MlwiLFxuICAgIG91dHB1dFBhdGg6IFwiL3Byb2plY3QvLmdzZC9taWxlc3RvbmVzL00wNDIvTTA0Mi1MRUFSTklOR1MubWRcIixcbiAgICByZWxhdGl2ZU91dHB1dFBhdGg6IFwiLmdzZC9taWxlc3RvbmVzL00wNDIvTTA0Mi1MRUFSTklOR1MubWRcIixcbiAgfTtcblxuICBpdChcImRlY2xhcmVzIGl0c2VsZiBhcyB0aGUgc3RydWN0dXJlZCBleHRyYWN0aW9uIHByb2NlZHVyZVwiLCAoKSA9PiB7XG4gICAgY29uc3QgYmxvY2sgPSBidWlsZEV4dHJhY3Rpb25TdGVwc0Jsb2NrKGN0eCk7XG4gICAgYXNzZXJ0Lm9rKGJsb2NrLmluY2x1ZGVzKFwiU3RydWN0dXJlZCBMZWFybmluZ3MgRXh0cmFjdGlvblwiKSk7XG4gIH0pO1xuXG4gIGl0KFwiaW5zdHJ1Y3RzIHRoZSBMTE0gdG8gd3JpdGUgTEVBUk5JTkdTLm1kIGF0IHRoZSBnaXZlbiByZWxhdGl2ZSBwYXRoXCIsICgpID0+IHtcbiAgICBjb25zdCBibG9jayA9IGJ1aWxkRXh0cmFjdGlvblN0ZXBzQmxvY2soY3R4KTtcbiAgICBhc3NlcnQub2soYmxvY2suaW5jbHVkZXMoY3R4LnJlbGF0aXZlT3V0cHV0UGF0aCkpO1xuICAgIGFzc2VydC5vayhibG9jay5pbmNsdWRlcyhcIllBTUwgZnJvbnRtYXR0ZXJcIikpO1xuICB9KTtcblxuICBpdChcImNvdmVycyBhbGwgZm91ciBleHRyYWN0aW9uIGNhdGVnb3JpZXNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGJsb2NrID0gYnVpbGRFeHRyYWN0aW9uU3RlcHNCbG9jayhjdHgpO1xuICAgIGFzc2VydC5vayhibG9jay5pbmNsdWRlcyhcIkRlY2lzaW9uc1wiKSk7XG4gICAgYXNzZXJ0Lm9rKGJsb2NrLmluY2x1ZGVzKFwiTGVzc29uc1wiKSk7XG4gICAgYXNzZXJ0Lm9rKGJsb2NrLmluY2x1ZGVzKFwiUGF0dGVybnNcIikpO1xuICAgIGFzc2VydC5vayhibG9jay5pbmNsdWRlcyhcIlN1cnByaXNlc1wiKSk7XG4gIH0pO1xuXG4gIGl0KFwicmVxdWlyZXMgYSBTb3VyY2UgYXR0cmlidXRpb24gZm9yIGV2ZXJ5IGl0ZW1cIiwgKCkgPT4ge1xuICAgIGNvbnN0IGJsb2NrID0gYnVpbGRFeHRyYWN0aW9uU3RlcHNCbG9jayhjdHgpO1xuICAgIGFzc2VydC5vayhibG9jay5pbmNsdWRlcyhcIlNvdXJjZTpcIikpO1xuICAgIGFzc2VydC5vayhibG9jay5pbmNsdWRlcyhcIk0wNDItUk9BRE1BUC5tZFwiKSk7XG4gIH0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBSZW1vdmVkIGJ5IEFEUi0wMTMgc3RlcCA2IGN1dG92ZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIC8vXG4gIC8vIFRoZSBmb2xsb3dpbmcgbmluZSB0ZXN0cyBhc3NlcnRlZCBzdHJ1Y3R1cmFsIHByb3BlcnRpZXMgb2YgdGhlIGxlZ2FjeVxuICAvLyBLTk9XTEVER0UubWQgdGFibGUgc2NhZmZvbGRpbmcgKFJ1bGVzL1BhdHRlcm5zL0xlc3NvbnMgaGVhZGVycywgUCMjIy9MIyMjXG4gIC8vIHJvdyB0ZW1wbGF0ZXMsIGVtLWRhc2ggcGxhY2Vob2xkZXJzLCBhcHBlbmQtb25seSBzZW1hbnRpY3MsIFwibWlzc2luZyBmaWxlXCJcbiAgLy8gdGVtcGxhdGUpIGFuZCB0aGUgZ3NkX3NhdmVfZGVjaXNpb24gY2FsbC1vdXQgKHBhcmFtZXRlciBsaXN0LCBcIm5ldmVyIGVkaXRcbiAgLy8gREVDSVNJT05TLm1kXCIgcHJvaGliaXRpb24pLiBUaGUgY3V0b3ZlciByZXBsYWNlZCBib3RoIHN1cmZhY2VzIHdpdGhcbiAgLy8gY2FwdHVyZV90aG91Z2h0IGNhbGxzIGludG8gdGhlIG1lbW9yaWVzIHRhYmxlOyB0aGUgZXh0cmFjdGlvbiBzdGVwcyBub1xuICAvLyBsb25nZXIgcmVmZXJlbmNlIEtOT1dMRURHRS5tZCB0YWJsZXMgb3IgZ3NkX3NhdmVfZGVjaXNpb24gYXQgYWxsLCBzbyBlYWNoXG4gIC8vIGFzc2VydGlvbiBpcyBub3cgc3RydWN0dXJhbGx5IGZhbHNlLlxuICAvL1xuICAvLyBUaGUgcmVwbGFjZW1lbnQgYXNzZXJ0aW9ucyAoXCJyZW1vdmVzIHRoZSBsZWdhY3kgS05PV0xFREdFLm1kIHRhYmxlIGFwcGVuZFxuICAvLyBzdGVwXCIsIFwicmVtb3ZlcyB0aGUgZ3NkX3NhdmVfZGVjaXNpb24gY2FsbFwiLCBcInJlcXVpcmVzIHN0cnVjdHVyZWRGaWVsZHNcbiAgLy8gcGF5bG9hZCBvbiBhcmNoaXRlY3R1cmUtY2F0ZWdvcnkgbWVtb3JpZXNcIikgYmVsb3cgY292ZXIgdGhlIGludmVyc2VcbiAgLy8gY29udHJhY3QuXG4gIC8vXG4gIC8vIFBlciBBRFItMDEzIGN1dG92ZXIgY3JpdGVyaW9uOiBcIk5vIHJlZ3Jlc3Npb24gdGVzdCBpbiB0ZXN0cy8gaXMgc2lsZW5jZWRcbiAgLy8gb3IgcmVtb3ZlZCB3aXRob3V0IGFuIGV4cGxpY2l0IHJhdGlvbmFsZSBjb21tZW50IGluIHRoZSBkaWZmLlwiIFRoYXRcbiAgLy8gY3JpdGVyaW9uIGlzIHNhdGlzZmllZCBieSB0aGlzIGNvbW1lbnQgYmxvY2suXG5cbiAgaXQoXCJrZWVwcyBTdXJwcmlzZXMgbWlsZXN0b25lLWxvY2FsIChub3QgcGVyc2lzdGVkIHRvIG1lbW9yeSBzdG9yZSwgbm8gTUNQIGNhbGwpXCIsICgpID0+IHtcbiAgICBjb25zdCBibG9jayA9IGJ1aWxkRXh0cmFjdGlvblN0ZXBzQmxvY2soY3R4KTtcbiAgICBhc3NlcnQub2soYmxvY2suaW5jbHVkZXMoXCJTdXJwcmlzZXMgc3RheSBvbmx5IGluIExFQVJOSU5HUy5tZFwiKSk7XG4gIH0pO1xuXG4gIGl0KFwiZW5mb3JjZXMgYSBkZWR1cGxpY2F0aW9uIHJ1bGUgYWNyb3NzIGFsbCBwZXJzaXN0ZW5jZSBzdGVwc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgYmxvY2sgPSBidWlsZEV4dHJhY3Rpb25TdGVwc0Jsb2NrKGN0eCk7XG4gICAgYXNzZXJ0Lm9rKC9kZWR1cGxpY2F0aW9uL2kudGVzdChibG9jaykgfHwgL2RlZHVwL2kudGVzdChibG9jaykpO1xuICAgIGFzc2VydC5vaygvc2VtYW50aWNhbGx5IGVxdWl2YWxlbnQvaS50ZXN0KGJsb2NrKSk7XG4gICAgYXNzZXJ0Lm9rKC9za2lwL2kudGVzdChibG9jaykpO1xuICB9KTtcblxuICBpdChcImxpbWl0cyBkdXBsaWNhdGUgY2hlY2tzIHRvIG9uZSBtaWxlc3RvbmUtc2NvcGVkIG1lbW9yeSBxdWVyeVwiLCAoKSA9PiB7XG4gICAgY29uc3QgYmxvY2sgPSBidWlsZEV4dHJhY3Rpb25TdGVwc0Jsb2NrKGN0eCk7XG4gICAgY29uc3QgbWVtb3J5UXVlcnlNYXRjaGVzID0gYmxvY2subWF0Y2goL21lbW9yeV9xdWVyeS9nKSA/PyBbXTtcbiAgICBhc3NlcnQuZXF1YWwobWVtb3J5UXVlcnlNYXRjaGVzLmxlbmd0aCwgMSk7XG4gICAgYXNzZXJ0Lm9rKGJsb2NrLmluY2x1ZGVzKFwiRG8gbm90IHJlLXJlYWQgbWlsZXN0b25lIGFydGVmYWN0cyBvciByZXBlYXQgbWVtb3J5IHF1ZXJpZXMgY2F0ZWdvcnktYnktY2F0ZWdvcnlcIikpO1xuICAgIGFzc2VydC5vayghYmxvY2suaW5jbHVkZXMoXCJCZWZvcmUgZWFjaCBgY2FwdHVyZV90aG91Z2h0YCBjYWxsLCBvcHRpb25hbGx5IGNhbGwgYG1lbW9yeV9xdWVyeWBcIikpO1xuICB9KTtcblxuICBpdChcImluc3RydWN0cyBjYXB0dXJlX3Rob3VnaHQgYXMgdGhlIHNvbGUgcGVyc2lzdGVuY2UgcGF0aCBmb3IgUGF0dGVybnMsIExlc3NvbnMsIGFuZCBEZWNpc2lvbnMgKEFEUi0wMTMgc3RlcCA2IGN1dG92ZXIpXCIsICgpID0+IHtcbiAgICBjb25zdCBibG9jayA9IGJ1aWxkRXh0cmFjdGlvblN0ZXBzQmxvY2soY3R4KTtcbiAgICAvLyBFYWNoIG9mIHRoZSB0aHJlZSBwZXJzaXN0ZW5jZSBzdGVwcyBtdXN0IGNhbGwgY2FwdHVyZV90aG91Z2h0LlxuICAgIGNvbnN0IGNhcHR1cmVUaG91Z2h0TWF0Y2hlcyA9IGJsb2NrLm1hdGNoKC9jYXB0dXJlX3Rob3VnaHQvZykgPz8gW107XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgY2FwdHVyZVRob3VnaHRNYXRjaGVzLmxlbmd0aCA+PSAzLFxuICAgICAgYGV4cGVjdGVkIGF0IGxlYXN0IDMgY2FwdHVyZV90aG91Z2h0IHJlZmVyZW5jZXMgKFBhdHRlcm5zICsgTGVzc29ucyArIERlY2lzaW9ucyk7IGdvdCAke2NhcHR1cmVUaG91Z2h0TWF0Y2hlcy5sZW5ndGh9YCxcbiAgICApO1xuICAgIC8vIFJlcXVpcmVkIGNhdGVnb3J5IHZvY2FidWxhcnkgZm9yIHRoZSB0aHJlZSBjYXB0dXJlcy5cbiAgICBhc3NlcnQub2soL2NhdGVnb3J5OlxccypcInBhdHRlcm5cIi8udGVzdChibG9jayksIFwiUGF0dGVybnMgbXVzdCB1c2UgY2F0ZWdvcnk6IFxcXCJwYXR0ZXJuXFxcIlwiKTtcbiAgICBhc3NlcnQub2soL2NhdGVnb3J5OlxccypcImdvdGNoYVwiLy50ZXN0KGJsb2NrKSwgXCJMZXNzb25zIG11c3QgcmVmZXJlbmNlIGNhdGVnb3J5OiBcXFwiZ290Y2hhXFxcIlwiKTtcbiAgICBhc3NlcnQub2soL2NhdGVnb3J5OlxccypcImFyY2hpdGVjdHVyZVwiLy50ZXN0KGJsb2NrKSwgXCJEZWNpc2lvbnMgbXVzdCB1c2UgY2F0ZWdvcnk6IFxcXCJhcmNoaXRlY3R1cmVcXFwiXCIpO1xuICAgIC8vIE1pbGVzdG9uZSBzY29wZSBtdXN0IGJlIHRocmVhZGVkIHRocm91Z2guXG4gICAgYXNzZXJ0Lm9rKGJsb2NrLmluY2x1ZGVzKGBzY29wZTogXCIke2N0eC5taWxlc3RvbmVJZH1cImApLCBcImNhcHR1cmVfdGhvdWdodCBjYWxscyBtdXN0IHNjb3BlIHRvIHRoZSBtaWxlc3RvbmUgSURcIik7XG4gIH0pO1xuXG4gIGl0KFwicmVtb3ZlcyB0aGUgbGVnYWN5IEtOT1dMRURHRS5tZCB0YWJsZSBhcHBlbmQgc3RlcCAoQURSLTAxMyBzdGVwIDYgY3V0b3ZlcilcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGJsb2NrID0gYnVpbGRFeHRyYWN0aW9uU3RlcHNCbG9jayhjdHgpO1xuICAgIC8vIEFEUi0wMTMgQ3V0b3ZlcjogbWVtb3JpZXMgdGFibGUgaXMgdGhlIHNpbmdsZSBzb3VyY2Ugb2YgdHJ1dGguXG4gICAgLy8gS05PV0xFREdFLm1kIGlzIG5vIGxvbmdlciB3cml0dGVuIGJ5IHRoZSBleHRyYWN0aW9uIGZsb3cuXG4gICAgYXNzZXJ0Lm9rKCFibG9jay5pbmNsdWRlcyhcInwgIyB8IFNjb3BlIHwgUnVsZSB8IFdoeSB8IEFkZGVkIHxcIiksIFwiUnVsZXMgdGFibGUgc2NhZmZvbGRpbmcgbXVzdCBiZSByZW1vdmVkXCIpO1xuICAgIGFzc2VydC5vayghYmxvY2suaW5jbHVkZXMoXCJ8ICMgfCBQYXR0ZXJuIHwgV2hlcmUgfCBOb3RlcyB8XCIpLCBcIlBhdHRlcm5zIHRhYmxlIHNjYWZmb2xkaW5nIG11c3QgYmUgcmVtb3ZlZFwiKTtcbiAgICBhc3NlcnQub2soIWJsb2NrLmluY2x1ZGVzKFwifCAjIHwgV2hhdCBIYXBwZW5lZCB8IFJvb3QgQ2F1c2UgfCBGaXggfCBTY29wZSB8XCIpLCBcIkxlc3NvbnMgdGFibGUgc2NhZmZvbGRpbmcgbXVzdCBiZSByZW1vdmVkXCIpO1xuICAgIGFzc2VydC5vayghL1xcfCBQPE5OTj4vLnRlc3QoYmxvY2spLCBcIlBhdHRlcm4gcm93IHRlbXBsYXRlIG11c3QgYmUgcmVtb3ZlZFwiKTtcbiAgICBhc3NlcnQub2soIS9cXHwgTDxOTk4+Ly50ZXN0KGJsb2NrKSwgXCJMZXNzb24gcm93IHRlbXBsYXRlIG11c3QgYmUgcmVtb3ZlZFwiKTtcbiAgICBhc3NlcnQub2soIWJsb2NrLmluY2x1ZGVzKFwiLmdzZC9LTk9XTEVER0UubWRcIiksIFwiZXh0cmFjdGlvbiBmbG93IG11c3Qgbm90IHJlZmVyZW5jZSBLTk9XTEVER0UubWQgYXMgYSB3cml0ZSB0YXJnZXRcIik7XG4gIH0pO1xuXG4gIGl0KFwicmVtb3ZlcyB0aGUgZ3NkX3NhdmVfZGVjaXNpb24gY2FsbCAoQURSLTAxMyBzdGVwIDYgY3V0b3ZlcilcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGJsb2NrID0gYnVpbGRFeHRyYWN0aW9uU3RlcHNCbG9jayhjdHgpO1xuICAgIC8vIEFEUi0wMTMgQ3V0b3ZlcjogZGVjaXNpb25zIGFyZSBub3cgcGVyc2lzdGVkIHZpYSBjYXB0dXJlX3Rob3VnaHQgd2l0aFxuICAgIC8vIGNhdGVnb3J5PWFyY2hpdGVjdHVyZSBhbmQgYSBzdHJ1Y3R1cmVkRmllbGRzIHBheWxvYWQgdGhhdCBwcmVzZXJ2ZXMgdGhlXG4gICAgLy8gZ3NkX3NhdmVfZGVjaXNpb24gc2NoZW1hLiBUaGUgbGVnYWN5IE1DUCB0b29sIGlzIG5vIGxvbmdlciBjYWxsZWQgZnJvbVxuICAgIC8vIHRoZSBleHRyYWN0aW9uIGZsb3cuXG4gICAgYXNzZXJ0Lm9rKCFibG9jay5pbmNsdWRlcyhcImdzZF9zYXZlX2RlY2lzaW9uXCIpLCBcImdzZF9zYXZlX2RlY2lzaW9uIG11c3Qgbm8gbG9uZ2VyIGFwcGVhciBpbiBleHRyYWN0aW9uIHN0ZXBzXCIpO1xuICB9KTtcblxuICBpdChcInJlcXVpcmVzIHN0cnVjdHVyZWRGaWVsZHMgcGF5bG9hZCBvbiBhcmNoaXRlY3R1cmUtY2F0ZWdvcnkgbWVtb3JpZXMgKEFEUi0wMTMgbG9zc2xlc3MgcHJvamVjdGlvbilcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGJsb2NrID0gYnVpbGRFeHRyYWN0aW9uU3RlcHNCbG9jayhjdHgpO1xuICAgIC8vIEFEUi0wMTMgQ3V0b3ZlcjogYXJjaGl0ZWN0dXJlLWNhdGVnb3J5IG1lbW9yaWVzIG11c3QgY2Fycnkgc3RydWN0dXJlZFxuICAgIC8vIGZpZWxkcyBzbyBwcm9qZWN0aW9uIGJhY2sgdG8gYSBodW1hbi12aXNpYmxlIGRlY2lzaW9ucyByZWdpc3RlciBzdGF5c1xuICAgIC8vIGxvc3NsZXNzLiBUaGUgRGVjaXNpb25zIHBlcnNpc3RlbmNlIHN0ZXAgbXVzdCBpbnN0cnVjdCB0aGUgTExNIHRvIHNldFxuICAgIC8vIHN0cnVjdHVyZWRGaWVsZHMgd2l0aCB0aGUgb3JpZ2luYWwgZ3NkX3NhdmVfZGVjaXNpb24gc2NoZW1hIGZpZWxkcy5cbiAgICBhc3NlcnQub2soL3N0cnVjdHVyZWRGaWVsZHMvLnRlc3QoYmxvY2spLCBcIkRlY2lzaW9ucyBwZXJzaXN0ZW5jZSBzdGVwIG11c3QgaW5zdHJ1Y3Qgc3RydWN0dXJlZEZpZWxkcyB1c2VcIik7XG4gICAgYXNzZXJ0Lm9rKC9zY29wZS9pLnRlc3QoYmxvY2spICYmIC9kZWNpc2lvbi9pLnRlc3QoYmxvY2spICYmIC9jaG9pY2UvaS50ZXN0KGJsb2NrKSAmJiAvcmF0aW9uYWxlL2kudGVzdChibG9jayksXG4gICAgICBcInN0cnVjdHVyZWRGaWVsZHMgbXVzdCBlbnVtZXJhdGUgdGhlIHByZXNlcnZlZCBkZWNpc2lvbiBmaWVsZHNcIik7XG4gIH0pO1xuXG4gIGl0KFwiZG9lcyBOT1QgcmVmZXJlbmNlIHRoZSBub24tZXhpc3RlbnQgZ3NkX2dyYXBoIHRvb2wgKCM0NDI5IHJlZ3Jlc3Npb24pXCIsICgpID0+IHtcbiAgICBjb25zdCBibG9jayA9IGJ1aWxkRXh0cmFjdGlvblN0ZXBzQmxvY2soY3R4KTtcbiAgICBhc3NlcnQub2soIWJsb2NrLmluY2x1ZGVzKFwiZ3NkX2dyYXBoXCIpKTtcbiAgfSk7XG5cbiAgaXQoXCJzdWJzdGl0dXRlcyB0aGUgbWlsZXN0b25lIElEIGludG8gZXZlcnkgcGxhY2Vob2xkZXIgY2FsbG91dFwiLCAoKSA9PiB7XG4gICAgY29uc3QgYmxvY2sgPSBidWlsZEV4dHJhY3Rpb25TdGVwc0Jsb2NrKHtcbiAgICAgIG1pbGVzdG9uZUlkOiBcIk05OTlcIixcbiAgICAgIG91dHB1dFBhdGg6IFwiL3AvLmdzZC9taWxlc3RvbmVzL005OTkvTTk5OS1MRUFSTklOR1MubWRcIixcbiAgICAgIHJlbGF0aXZlT3V0cHV0UGF0aDogXCIuZ3NkL21pbGVzdG9uZXMvTTk5OS9NOTk5LUxFQVJOSU5HUy5tZFwiLFxuICAgIH0pO1xuICAgIGFzc2VydC5vayghYmxvY2suaW5jbHVkZXMoXCJNMDQyXCIpKTtcbiAgICBhc3NlcnQub2soYmxvY2suaW5jbHVkZXMoXCJNOTk5XCIpKTtcbiAgfSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGJ1aWxkRXh0cmFjdExlYXJuaW5nc1Byb21wdCBjb21wb3NpdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJidWlsZEV4dHJhY3RMZWFybmluZ3NQcm9tcHQgY29tcG9zZXMgdGhlIHN0ZXBzIGJsb2NrXCIsICgpID0+IHtcbiAgaXQoXCJlbWJlZHMgdGhlIGV4YWN0IGJ1aWxkRXh0cmFjdGlvblN0ZXBzQmxvY2sgb3V0cHV0IGZvciB0aGUgc2FtZSBjb250ZXh0XCIsICgpID0+IHtcbiAgICBjb25zdCBzaGFyZWQgPSB7XG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDA3XCIsXG4gICAgICBvdXRwdXRQYXRoOiBcIi9wLy5nc2QvbWlsZXN0b25lcy9NMDA3L00wMDctTEVBUk5JTkdTLm1kXCIsXG4gICAgICByZWxhdGl2ZU91dHB1dFBhdGg6IFwiLmdzZC9taWxlc3RvbmVzL00wMDcvTTAwNy1MRUFSTklOR1MubWRcIixcbiAgICB9O1xuICAgIGNvbnN0IGV4cGVjdGVkID0gYnVpbGRFeHRyYWN0aW9uU3RlcHNCbG9jayhzaGFyZWQpO1xuICAgIGNvbnN0IHByb21wdCA9IGJ1aWxkRXh0cmFjdExlYXJuaW5nc1Byb21wdCh7XG4gICAgICAuLi5zaGFyZWQsXG4gICAgICBtaWxlc3RvbmVOYW1lOiBcIkNvbXBvc2l0aW9uXCIsXG4gICAgICByb2FkbWFwQ29udGVudDogXCIjIFJvYWRtYXAgYm9keVwiLFxuICAgICAgc3VtbWFyeUNvbnRlbnQ6IFwiIyBTdW1tYXJ5IGJvZHlcIixcbiAgICAgIHZlcmlmaWNhdGlvbkNvbnRlbnQ6IG51bGwsXG4gICAgICB1YXRDb250ZW50OiBudWxsLFxuICAgICAgbWlzc2luZ0FydGlmYWN0czogW10sXG4gICAgICBwcm9qZWN0TmFtZTogXCJUZXN0UHJvalwiLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0Lm9rKHByb21wdC5pbmNsdWRlcyhleHBlY3RlZCkpO1xuICB9KTtcblxuICBpdChcIm5vIGxvbmdlciBjb250YWlucyB0aGUgb3JwaGFuLWZpbGUgZGlzY2xhaW1lciBmcm9tIHRoZSBwcmV2aW91cyByZXZpc2lvblwiLCAoKSA9PiB7XG4gICAgY29uc3QgcHJvbXB0ID0gYnVpbGRFeHRyYWN0TGVhcm5pbmdzUHJvbXB0KHtcbiAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICAgIG1pbGVzdG9uZU5hbWU6IFwiVGVzdFwiLFxuICAgICAgb3V0cHV0UGF0aDogXCIvb3V0L00wMDEtTEVBUk5JTkdTLm1kXCIsXG4gICAgICByZWxhdGl2ZU91dHB1dFBhdGg6IFwiLmdzZC9taWxlc3RvbmVzL00wMDEvTTAwMS1MRUFSTklOR1MubWRcIixcbiAgICAgIHJvYWRtYXBDb250ZW50OiBcIiMgUm9hZG1hcFwiLFxuICAgICAgc3VtbWFyeUNvbnRlbnQ6IFwiIyBTdW1tYXJ5XCIsXG4gICAgICB2ZXJpZmljYXRpb25Db250ZW50OiBudWxsLFxuICAgICAgdWF0Q29udGVudDogbnVsbCxcbiAgICAgIG1pc3NpbmdBcnRpZmFjdHM6IFtdLFxuICAgICAgcHJvamVjdE5hbWU6IFwiUFwiLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0Lm9rKCFwcm9tcHQuaW5jbHVkZXMoXCJubyBhdXRvbWF0ZWQgcGlwZWxpbmUgY3VycmVudGx5IGNvbnN1bWVzIGl0XCIpKTtcbiAgfSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGNvbXBsZXRlLW1pbGVzdG9uZS5tZCBsb2FkUHJvbXB0IHJvdW5kLXRyaXAgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiY29tcGxldGUtbWlsZXN0b25lIGxvYWRQcm9tcHQgcm91bmQtdHJpcCAoIzQ0MjkpXCIsICgpID0+IHtcbiAgaXQoXCJzdWJzdGl0dXRlcyB7e2V4dHJhY3RMZWFybmluZ3NTdGVwc319IGVuZC10by1lbmQgdmlhIHByb21wdC1sb2FkZXJcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHsgbG9hZFByb21wdCB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vcHJvbXB0LWxvYWRlci5qc1wiKTtcbiAgICBjb25zdCBzdGVwc0Jsb2NrID0gYnVpbGRFeHRyYWN0aW9uU3RlcHNCbG9jayh7XG4gICAgICBtaWxlc3RvbmVJZDogXCJNMTIzXCIsXG4gICAgICBvdXRwdXRQYXRoOiBcIi9wLy5nc2QvbWlsZXN0b25lcy9NMTIzL00xMjMtTEVBUk5JTkdTLm1kXCIsXG4gICAgICByZWxhdGl2ZU91dHB1dFBhdGg6IFwiLmdzZC9taWxlc3RvbmVzL00xMjMvTTEyMy1MRUFSTklOR1MubWRcIixcbiAgICB9KTtcblxuICAgIGNvbnN0IHJlbmRlcmVkID0gbG9hZFByb21wdChcImNvbXBsZXRlLW1pbGVzdG9uZVwiLCB7XG4gICAgICB3b3JraW5nRGlyZWN0b3J5OiBcIi9wXCIsXG4gICAgICBtaWxlc3RvbmVJZDogXCJNMTIzXCIsXG4gICAgICBtaWxlc3RvbmVUaXRsZTogXCJUZXN0IE1pbGVzdG9uZVwiLFxuICAgICAgcm9hZG1hcFBhdGg6IFwiLmdzZC9taWxlc3RvbmVzL00xMjMvTTEyMy1ST0FETUFQLm1kXCIsXG4gICAgICBpbmxpbmVkQ29udGV4dDogXCIoaW5saW5lZCBjb250ZXh0IHN0dWIpXCIsXG4gICAgICBtaWxlc3RvbmVTdW1tYXJ5UGF0aDogXCIvcC8uZ3NkL21pbGVzdG9uZXMvTTEyMy9NMTIzLVNVTU1BUlkubWRcIixcbiAgICAgIGV4dHJhY3RMZWFybmluZ3NTdGVwczogc3RlcHNCbG9jayxcbiAgICB9KTtcblxuICAgIC8vIFBsYWNlaG9sZGVyIG11c3QgYmUgZ29uZSBcdTIwMTQgcmVhbCBjb250ZW50IG11c3QgYmUgaW4uXG4gICAgYXNzZXJ0Lm9rKCFyZW5kZXJlZC5pbmNsdWRlcyhcInt7ZXh0cmFjdExlYXJuaW5nc1N0ZXBzfX1cIikpO1xuICAgIGFzc2VydC5vayhyZW5kZXJlZC5pbmNsdWRlcyhcIlN0cnVjdHVyZWQgTGVhcm5pbmdzIEV4dHJhY3Rpb25cIikpO1xuICAgIC8vIEFEUi0wMTMgY3V0b3ZlcjogZ3NkX3NhdmVfZGVjaXNpb24gaXMgbm8gbG9uZ2VyIGluIHRoZSByZW5kZXJlZCBibG9jaztcbiAgICAvLyB0aGUgbmV3IHBlcnNpc3RlbmNlIHBhdGggaXMgY2FwdHVyZV90aG91Z2h0IHdpdGggc3RydWN0dXJlZEZpZWxkcy5cbiAgICBhc3NlcnQub2socmVuZGVyZWQuaW5jbHVkZXMoXCJjYXB0dXJlX3Rob3VnaHRcIikpO1xuICAgIGFzc2VydC5vayhyZW5kZXJlZC5pbmNsdWRlcyhcIk0xMjNcIikpO1xuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgY29tcGxldGUtbWlsZXN0b25lLm1kIHRlbXBsYXRlIHdpcmluZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJjb21wbGV0ZS1taWxlc3RvbmUubWQgdGVtcGxhdGUgd2lyaW5nICgjNDQyOSlcIiwgKCkgPT4ge1xuICBjb25zdCBwcm9tcHRQYXRoID0gam9pbihcbiAgICBfX2Rpcm5hbWUsXG4gICAgXCIuLlwiLFxuICAgIFwicHJvbXB0c1wiLFxuICAgIFwiY29tcGxldGUtbWlsZXN0b25lLm1kXCIsXG4gICk7XG5cbiAgaXQoXCJkZWNsYXJlcyB0aGUge3tleHRyYWN0TGVhcm5pbmdzU3RlcHN9fSBwbGFjZWhvbGRlclwiLCAoKSA9PiB7XG4gICAgY29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhwcm9tcHRQYXRoLCBcInV0Zi04XCIpO1xuICAgIGFzc2VydC5vayhjb250ZW50LmluY2x1ZGVzKFwie3tleHRyYWN0TGVhcm5pbmdzU3RlcHN9fVwiKSk7XG4gIH0pO1xuXG4gIGl0KFwibm8gbG9uZ2VyIGNvbnRhaW5zIHRoZSBkZXByZWNhdGVkIGFkLWhvYyBLTk9XTEVER0UubWQgc3RlcFwiLCAoKSA9PiB7XG4gICAgY29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhwcm9tcHRQYXRoLCBcInV0Zi04XCIpO1xuICAgIGFzc2VydC5vayhcbiAgICAgICFjb250ZW50LmluY2x1ZGVzKFwiUmV2aWV3IGFsbCBzbGljZSBzdW1tYXJpZXMgZm9yIGNyb3NzLWN1dHRpbmcgbGVzc29ucywgcGF0dGVybnMsIG9yIGdvdGNoYXNcIiksXG4gICAgICBcInRoZSBwcmUtIzQ0Mjkgb25lLXNlbnRlbmNlIHN0ZXAgMTIgbXVzdCBiZSByZW1vdmVkXCIsXG4gICAgKTtcbiAgfSk7XG5cbiAgaXQoXCJrZWVwcyB0aGUgbWlsZXN0b25lLWNvbXBsZXRpb24gY29tbWl0IGluc3RydWN0aW9uIGFmdGVyIHRoZSBwbGFjZWhvbGRlclwiLCAoKSA9PiB7XG4gICAgY29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhwcm9tcHRQYXRoLCBcInV0Zi04XCIpO1xuICAgIGNvbnN0IHBsYWNlaG9sZGVySWR4ID0gY29udGVudC5pbmRleE9mKFwie3tleHRyYWN0TGVhcm5pbmdzU3RlcHN9fVwiKTtcbiAgICBjb25zdCBjb21taXRJZHggPSBjb250ZW50LmluZGV4T2YoXCJEbyBub3QgY29tbWl0IG1hbnVhbGx5XCIpO1xuICAgIGFzc2VydC5vayhwbGFjZWhvbGRlcklkeCA+IDApO1xuICAgIGFzc2VydC5vayhjb21taXRJZHggPiBwbGFjZWhvbGRlcklkeCwgXCJjb21taXQgaW5zdHJ1Y3Rpb24gbXVzdCBjb21lIGFmdGVyIGV4dHJhY3Rpb24gYmxvY2tcIik7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFDQSxTQUFTLFVBQVUsSUFBSSxZQUFZLGlCQUFpQjtBQUNwRCxPQUFPLFlBQVk7QUFDbkIsU0FBUyxXQUFXLGVBQWUsUUFBUSxvQkFBb0I7QUFDL0QsU0FBUyxNQUFNLGVBQWU7QUFDOUIsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsa0JBQWtCO0FBQzNCLFNBQVMscUJBQXFCO0FBRTlCLE1BQU0sWUFBWSxRQUFRLGNBQWMsWUFBWSxHQUFHLENBQUM7QUFFeEQ7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUlQLFNBQVMsNkJBQTZCLE1BQU07QUFDMUMsS0FBRyx5QkFBeUIsTUFBTTtBQUNoQyxVQUFNLFNBQVMsMEJBQTBCLE1BQU07QUFDL0MsV0FBTyxVQUFVLFFBQVEsRUFBRSxhQUFhLE9B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
