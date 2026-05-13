import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GSD_ROOT_FILES, resolveGsdRootFile } from "../paths.js";
import { inlineGsdRootFile, inlineKnowledgeBudgeted } from "../auto-prompts.js";
import { appendKnowledge } from "../files.js";
import { loadKnowledgeBlock } from "../bootstrap/system-context.js";
test("knowledge: KNOWLEDGE key exists in GSD_ROOT_FILES", () => {
  assert.ok("KNOWLEDGE" in GSD_ROOT_FILES, "GSD_ROOT_FILES should have KNOWLEDGE key");
  assert.strictEqual(GSD_ROOT_FILES.KNOWLEDGE, "KNOWLEDGE.md");
});
test("knowledge: resolveGsdRootFile returns canonical path when KNOWLEDGE.md exists", () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "gsd-knowledge-")));
  const gsdDir = join(tmp, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  writeFileSync(join(gsdDir, "KNOWLEDGE.md"), "# Project Knowledge\n");
  const resolved = resolveGsdRootFile(tmp, "KNOWLEDGE");
  assert.strictEqual(resolved, join(gsdDir, "KNOWLEDGE.md"));
  rmSync(tmp, { recursive: true, force: true });
});
test("knowledge: resolveGsdRootFile resolves when legacy knowledge.md exists", () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "gsd-knowledge-")));
  const gsdDir = join(tmp, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  writeFileSync(join(gsdDir, "knowledge.md"), "# Project Knowledge\n");
  const resolved = resolveGsdRootFile(tmp, "KNOWLEDGE");
  const canonical = join(gsdDir, "KNOWLEDGE.md");
  const legacy = join(gsdDir, "knowledge.md");
  assert.ok(
    resolved === canonical || resolved === legacy,
    `resolved path should be canonical or legacy, got: ${resolved}`
  );
  rmSync(tmp, { recursive: true, force: true });
});
test("knowledge: resolveGsdRootFile returns canonical path when file does not exist", () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "gsd-knowledge-")));
  const gsdDir = join(tmp, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  const resolved = resolveGsdRootFile(tmp, "KNOWLEDGE");
  assert.strictEqual(resolved, join(gsdDir, "KNOWLEDGE.md"));
  rmSync(tmp, { recursive: true, force: true });
});
test("knowledge: inlineGsdRootFile returns content when KNOWLEDGE.md exists", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-knowledge-"));
  const gsdDir = join(tmp, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  writeFileSync(join(gsdDir, "KNOWLEDGE.md"), "# Project Knowledge\n\n## Rules\n\nK001: Use real DB");
  const result = await inlineGsdRootFile(tmp, "knowledge.md", "Project Knowledge");
  assert.ok(result !== null, "should return content");
  assert.ok(result.includes("Project Knowledge"), "should include label");
  assert.ok(result.includes("K001"), "should include knowledge content");
  rmSync(tmp, { recursive: true, force: true });
});
test("knowledge: inlineGsdRootFile returns null when KNOWLEDGE.md does not exist", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-knowledge-"));
  const gsdDir = join(tmp, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  const result = await inlineGsdRootFile(tmp, "knowledge.md", "Project Knowledge");
  assert.strictEqual(result, null, "should return null when file does not exist");
  rmSync(tmp, { recursive: true, force: true });
});
test("knowledge: appendKnowledge creates KNOWLEDGE.md with rule when file does not exist", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-knowledge-"));
  const gsdDir = join(tmp, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  await appendKnowledge(tmp, "rule", "Use real DB for integration tests", "M001/S01");
  const content = readFileSync(join(gsdDir, "KNOWLEDGE.md"), "utf-8");
  assert.ok(content.includes("# Project Knowledge"), "should have header");
  assert.ok(content.includes("K001"), "should have K001 id");
  assert.ok(content.includes("Use real DB for integration tests"), "should have rule text");
  assert.ok(content.includes("M001/S01"), "should have scope");
  rmSync(tmp, { recursive: true, force: true });
});
test("knowledge: appendKnowledge appends to existing KNOWLEDGE.md with auto-incrementing ID", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-knowledge-"));
  const gsdDir = join(tmp, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  await appendKnowledge(tmp, "rule", "First rule", "M001");
  await appendKnowledge(tmp, "rule", "Second rule", "M001/S02");
  const content = readFileSync(join(gsdDir, "KNOWLEDGE.md"), "utf-8");
  assert.ok(content.includes("K001"), "should have K001");
  assert.ok(content.includes("K002"), "should have K002");
  assert.ok(content.includes("First rule"), "should have first rule");
  assert.ok(content.includes("Second rule"), "should have second rule");
  rmSync(tmp, { recursive: true, force: true });
});
test("knowledge: appendKnowledge handles pattern type", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-knowledge-"));
  const gsdDir = join(tmp, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  await appendKnowledge(tmp, "pattern", "Middleware chain for auth", "M001");
  const content = readFileSync(join(gsdDir, "KNOWLEDGE.md"), "utf-8");
  assert.ok(content.includes("P001"), "should have P001 id");
  assert.ok(content.includes("Middleware chain for auth"), "should have pattern text");
  rmSync(tmp, { recursive: true, force: true });
});
test("knowledge: appendKnowledge handles lesson type", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-knowledge-"));
  const gsdDir = join(tmp, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  await appendKnowledge(tmp, "lesson", "API timeout on large payloads", "M002");
  const content = readFileSync(join(gsdDir, "KNOWLEDGE.md"), "utf-8");
  assert.ok(content.includes("L001"), "should have L001 id");
  assert.ok(content.includes("API timeout on large payloads"), "should have lesson text");
  rmSync(tmp, { recursive: true, force: true });
});
test("loadKnowledgeBlock: returns empty block when neither file exists", () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "gsd-kb-")));
  const gsdHome = join(tmp, "home");
  const cwd = join(tmp, "project");
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  mkdirSync(join(gsdHome, "agent"), { recursive: true });
  const result = loadKnowledgeBlock(gsdHome, cwd);
  assert.strictEqual(result.block, "");
  assert.strictEqual(result.globalSizeKb, 0);
  rmSync(tmp, { recursive: true, force: true });
});
test("loadKnowledgeBlock: uses project knowledge alone when no global file", () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "gsd-kb-")));
  const gsdHome = join(tmp, "home");
  const cwd = join(tmp, "project");
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  mkdirSync(join(gsdHome, "agent"), { recursive: true });
  writeFileSync(join(cwd, ".gsd", "KNOWLEDGE.md"), "K001: Use real DB");
  const result = loadKnowledgeBlock(gsdHome, cwd);
  assert.ok(result.block.includes("[KNOWLEDGE \u2014 Rules from KNOWLEDGE.md"));
  assert.ok(result.block.includes("## Project Knowledge"));
  assert.ok(result.block.includes("K001: Use real DB"));
  assert.ok(!result.block.includes("## Global Knowledge"));
  assert.strictEqual(result.globalSizeKb, 0);
  rmSync(tmp, { recursive: true, force: true });
});
test("loadKnowledgeBlock: uses global knowledge alone when no project file", () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "gsd-kb-")));
  const gsdHome = join(tmp, "home");
  const cwd = join(tmp, "project");
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  mkdirSync(join(gsdHome, "agent"), { recursive: true });
  writeFileSync(join(gsdHome, "agent", "KNOWLEDGE.md"), "G001: Respond in English");
  const result = loadKnowledgeBlock(gsdHome, cwd);
  assert.ok(result.block.includes("[KNOWLEDGE \u2014 Rules from KNOWLEDGE.md"));
  assert.ok(result.block.includes("## Global Knowledge"));
  assert.ok(result.block.includes("G001: Respond in English"));
  assert.ok(!result.block.includes("## Project Knowledge"));
  assert.ok(result.globalSizeKb > 0);
  rmSync(tmp, { recursive: true, force: true });
});
test("loadKnowledgeBlock: merges global before project when both exist", () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "gsd-kb-")));
  const gsdHome = join(tmp, "home");
  const cwd = join(tmp, "project");
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  mkdirSync(join(gsdHome, "agent"), { recursive: true });
  writeFileSync(join(gsdHome, "agent", "KNOWLEDGE.md"), "G001: Global rule");
  writeFileSync(join(cwd, ".gsd", "KNOWLEDGE.md"), "K001: Project rule");
  const result = loadKnowledgeBlock(gsdHome, cwd);
  assert.ok(result.block.includes("## Global Knowledge"));
  assert.ok(result.block.includes("## Project Knowledge"));
  assert.ok(result.block.includes("G001: Global rule"));
  assert.ok(result.block.includes("K001: Project rule"));
  assert.ok(result.block.indexOf("## Global Knowledge") < result.block.indexOf("## Project Knowledge"));
  rmSync(tmp, { recursive: true, force: true });
});
test("loadKnowledgeBlock: strips patterns and lessons from project knowledge", () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "gsd-kb-strip-")));
  const gsdHome = join(tmp, "home");
  const cwd = join(tmp, "project");
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  mkdirSync(join(gsdHome, "agent"), { recursive: true });
  writeFileSync(
    join(cwd, ".gsd", "KNOWLEDGE.md"),
    [
      "# Project Knowledge",
      "",
      "Intro note that should stay with manual rules.",
      "",
      "## Rules",
      "",
      "| ID | Rule | Notes |",
      "|---|---|---|",
      "| K001 | Use real DB | - |",
      "",
      "## Patterns",
      "",
      "| ID | Pattern | Where | Notes |",
      "|---|---|---|---|",
      "| P001 | Prefer async | server | - |",
      "",
      "## Lessons Learned",
      "",
      "| ID | What Happened | Root Cause | Fix | Scope |",
      "|---|---|---|---|---|",
      "| L001 | Missed cache | N/A | Add TTL | project |"
    ].join("\n")
  );
  const result = loadKnowledgeBlock(gsdHome, cwd);
  assert.ok(result.block.includes("[KNOWLEDGE \u2014 Rules from KNOWLEDGE.md"));
  assert.ok(result.block.includes("Intro note that should stay with manual rules."));
  assert.ok(result.block.includes("K001"), "rules entry should be present");
  assert.ok(!result.block.includes("P001"), "patterns should be stripped and injected via memories");
  assert.ok(!result.block.includes("L001"), "lessons should be stripped and injected via memories");
  assert.ok(!result.block.includes("## Patterns"), "Patterns heading should not appear");
  assert.ok(!result.block.includes("## Lessons Learned"), "Lessons heading should not appear");
  rmSync(tmp, { recursive: true, force: true });
});
test("loadKnowledgeBlock: reports globalSizeKb above 4KB threshold", () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "gsd-kb-")));
  const gsdHome = join(tmp, "home");
  const cwd = join(tmp, "project");
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  mkdirSync(join(gsdHome, "agent"), { recursive: true });
  writeFileSync(join(gsdHome, "agent", "KNOWLEDGE.md"), "x".repeat(5e3));
  const result = loadKnowledgeBlock(gsdHome, cwd);
  assert.ok(result.globalSizeKb > 4, `expected > 4KB, got ${result.globalSizeKb}`);
  rmSync(tmp, { recursive: true, force: true });
});
test("loadKnowledgeBlock: caps repeated system prompt knowledge by default with source path", () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "gsd-kb-")));
  const gsdHome = join(tmp, "home");
  const cwd = join(tmp, "project");
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  mkdirSync(join(gsdHome, "agent"), { recursive: true });
  writeFileSync(join(cwd, ".gsd", "KNOWLEDGE.md"), `K001: ${"large project knowledge ".repeat(1200)}`);
  const original = process.env.PI_GSD_KNOWLEDGE_MAX_CHARS;
  delete process.env.PI_GSD_KNOWLEDGE_MAX_CHARS;
  try {
    const result = loadKnowledgeBlock(gsdHome, cwd);
    assert.ok(result.block.includes("Source: `"));
    assert.ok(result.block.length <= 12500, `knowledge block ${result.block.length} should stay near default cap`);
    assert.ok(result.block.includes("[Knowledge Truncated]"));
  } finally {
    if (original === void 0) delete process.env.PI_GSD_KNOWLEDGE_MAX_CHARS;
    else process.env.PI_GSD_KNOWLEDGE_MAX_CHARS = original;
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("inlineKnowledgeBudgeted: returns scoped H3 entries for single-H2 file", async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "gsd-knowledge-")));
  const gsdDir = join(tmp, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  const content = `# Project Knowledge

## Patterns

### Database: prepared statements
Always use prepared statements with SQLite.

### API: versioned paths
Use /v1/resource style versioning.

### Testing: node:test
Prefer node:test over external frameworks.
`;
  writeFileSync(join(gsdDir, "KNOWLEDGE.md"), content);
  const result = await inlineKnowledgeBudgeted(tmp, ["database"]);
  assert.ok(result !== null, "should return content");
  assert.ok(result.includes("Database: prepared statements"), "includes matching H3");
  assert.ok(!result.includes("API: versioned paths"), "excludes non-matching H3");
  rmSync(tmp, { recursive: true, force: true });
});
test("inlineKnowledgeBudgeted: caps payload below budget for large files", async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "gsd-knowledge-")));
  const gsdDir = join(tmp, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  const entries = Array.from(
    { length: 500 },
    (_, i) => `### Entry ${i}: shared topic
${"filler text ".repeat(30)}
`
  ).join("\n");
  const content = `# Project Knowledge

## Patterns

${entries}`;
  writeFileSync(join(gsdDir, "KNOWLEDGE.md"), content);
  const BUDGET_CHARS = 3e4;
  const result = await inlineKnowledgeBudgeted(tmp, ["shared"], { maxChars: BUDGET_CHARS });
  assert.ok(result !== null, "should return content");
  assert.ok(
    result.length <= BUDGET_CHARS + 500,
    `payload ${result.length} chars should be <= budget ${BUDGET_CHARS} (+overhead)`
  );
  assert.ok(
    result.length < content.length / 4,
    `payload should be much smaller than full content (${content.length} chars)`
  );
  assert.match(
    result,
    /\[\.\.\.truncated \d+ chars; rerun with narrower scope if needed\]/,
    "should include truncation note when budget is exceeded"
  );
  rmSync(tmp, { recursive: true, force: true });
});
test("inlineKnowledgeBudgeted: default budget keeps auto prompt knowledge compact", async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "gsd-knowledge-")));
  const gsdDir = join(tmp, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  const entries = Array.from(
    { length: 300 },
    (_, i) => `### Entry ${i}: shared topic
${"default budget filler ".repeat(25)}
`
  ).join("\n");
  writeFileSync(join(gsdDir, "KNOWLEDGE.md"), `# Project Knowledge

## Patterns

${entries}`);
  const result = await inlineKnowledgeBudgeted(tmp, ["shared"]);
  assert.ok(result !== null, "should return content");
  assert.ok(
    result.length <= 12500,
    `default payload ${result.length} chars should stay near the 12k budget`
  );
  assert.match(
    result,
    /\[\.\.\.truncated \d+ chars; rerun with narrower scope if needed\]/,
    "should include truncation note when default budget is exceeded"
  );
  rmSync(tmp, { recursive: true, force: true });
});
test("inlineKnowledgeBudgeted: returns null when no KNOWLEDGE.md exists", async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "gsd-knowledge-")));
  const gsdDir = join(tmp, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  const result = await inlineKnowledgeBudgeted(tmp, ["database"]);
  assert.strictEqual(result, null);
  rmSync(tmp, { recursive: true, force: true });
});
test("inlineKnowledgeBudgeted: returns null when no entries match", async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "gsd-knowledge-")));
  const gsdDir = join(tmp, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  writeFileSync(
    join(gsdDir, "KNOWLEDGE.md"),
    "# Project Knowledge\n\n## Patterns\n\n### Database\nuse it\n"
  );
  const result = await inlineKnowledgeBudgeted(tmp, ["nonexistent"]);
  assert.strictEqual(result, null);
  rmSync(tmp, { recursive: true, force: true });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9rbm93bGVkZ2UudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBVbml0IHRlc3RzIGZvciBLTk9XTEVER0UubWQgaW50ZWdyYXRpb24uXG4gKlxuICogVGVzdHM6XG4gKiAtIEtOT1dMRURHRSBpcyByZWdpc3RlcmVkIGluIEdTRF9ST09UX0ZJTEVTXG4gKiAtIHJlc29sdmVHc2RSb290RmlsZSByZXNvbHZlcyBLTk9XTEVER0UgcGF0aHMgY29ycmVjdGx5XG4gKiAtIGlubGluZUdzZFJvb3RGaWxlIHdvcmtzIHdpdGggdGhlIEtOT1dMRURHRSBrZXlcbiAqIC0gYmVmb3JlX2FnZW50X3N0YXJ0IGhvb2sgaW5jbHVkZXMvb21pdHMga25vd2xlZGdlIGJsb2NrIGFwcHJvcHJpYXRlbHlcbiAqIC0gbG9hZEtub3dsZWRnZUJsb2NrIG1lcmdlcyBnbG9iYWwgYW5kIHByb2plY3Qga25vd2xlZGdlIGNvcnJlY3RseVxuICovXG5cbmltcG9ydCB0ZXN0IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCB3cml0ZUZpbGVTeW5jLCByZWFkRmlsZVN5bmMsIHJtU3luYywgcmVhbHBhdGhTeW5jIH0gZnJvbSAnbm9kZTpmcyc7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJztcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gJ25vZGU6b3MnO1xuaW1wb3J0IHsgR1NEX1JPT1RfRklMRVMsIHJlc29sdmVHc2RSb290RmlsZSB9IGZyb20gJy4uL3BhdGhzLnRzJztcbmltcG9ydCB7IGlubGluZUdzZFJvb3RGaWxlLCBpbmxpbmVLbm93bGVkZ2VCdWRnZXRlZCB9IGZyb20gJy4uL2F1dG8tcHJvbXB0cy50cyc7XG5pbXBvcnQgeyBhcHBlbmRLbm93bGVkZ2UgfSBmcm9tICcuLi9maWxlcy50cyc7XG5pbXBvcnQgeyBsb2FkS25vd2xlZGdlQmxvY2sgfSBmcm9tICcuLi9ib290c3RyYXAvc3lzdGVtLWNvbnRleHQudHMnO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgS05PV0xFREdFIGlzIHJlZ2lzdGVyZWQgaW4gR1NEX1JPT1RfRklMRVMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoJ2tub3dsZWRnZTogS05PV0xFREdFIGtleSBleGlzdHMgaW4gR1NEX1JPT1RfRklMRVMnLCAoKSA9PiB7XG4gIGFzc2VydC5vaygnS05PV0xFREdFJyBpbiBHU0RfUk9PVF9GSUxFUywgJ0dTRF9ST09UX0ZJTEVTIHNob3VsZCBoYXZlIEtOT1dMRURHRSBrZXknKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKEdTRF9ST09UX0ZJTEVTLktOT1dMRURHRSwgJ0tOT1dMRURHRS5tZCcpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCByZXNvbHZlR3NkUm9vdEZpbGUgcmVzb2x2ZXMgS05PV0xFREdFLm1kIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KCdrbm93bGVkZ2U6IHJlc29sdmVHc2RSb290RmlsZSByZXR1cm5zIGNhbm9uaWNhbCBwYXRoIHdoZW4gS05PV0xFREdFLm1kIGV4aXN0cycsICgpID0+IHtcbiAgY29uc3QgdG1wID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksICdnc2Qta25vd2xlZGdlLScpKSk7XG4gIGNvbnN0IGdzZERpciA9IGpvaW4odG1wLCAnLmdzZCcpO1xuICBta2RpclN5bmMoZ3NkRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGdzZERpciwgJ0tOT1dMRURHRS5tZCcpLCAnIyBQcm9qZWN0IEtub3dsZWRnZVxcbicpO1xuXG4gIGNvbnN0IHJlc29sdmVkID0gcmVzb2x2ZUdzZFJvb3RGaWxlKHRtcCwgJ0tOT1dMRURHRScpO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzb2x2ZWQsIGpvaW4oZ3NkRGlyLCAnS05PV0xFREdFLm1kJykpO1xuXG4gIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbn0pO1xuXG50ZXN0KCdrbm93bGVkZ2U6IHJlc29sdmVHc2RSb290RmlsZSByZXNvbHZlcyB3aGVuIGxlZ2FjeSBrbm93bGVkZ2UubWQgZXhpc3RzJywgKCkgPT4ge1xuICBjb25zdCB0bXAgPSByZWFscGF0aFN5bmMobWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgJ2dzZC1rbm93bGVkZ2UtJykpKTtcbiAgY29uc3QgZ3NkRGlyID0gam9pbih0bXAsICcuZ3NkJyk7XG4gIG1rZGlyU3luYyhnc2REaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oZ3NkRGlyLCAna25vd2xlZGdlLm1kJyksICcjIFByb2plY3QgS25vd2xlZGdlXFxuJyk7XG5cbiAgY29uc3QgcmVzb2x2ZWQgPSByZXNvbHZlR3NkUm9vdEZpbGUodG1wLCAnS05PV0xFREdFJyk7XG4gIC8vIE9uIGNhc2UtaW5zZW5zaXRpdmUgZmlsZXN5c3RlbXMgKG1hY09TKSwgY2Fub25pY2FsIHBhdGggbWF0Y2hlcztcbiAgLy8gb24gY2FzZS1zZW5zaXRpdmUgKExpbnV4KSwgbGVnYWN5IHBhdGggbWF0Y2hlcy4gRWl0aGVyIGlzIHZhbGlkLlxuICBjb25zdCBjYW5vbmljYWwgPSBqb2luKGdzZERpciwgJ0tOT1dMRURHRS5tZCcpO1xuICBjb25zdCBsZWdhY3kgPSBqb2luKGdzZERpciwgJ2tub3dsZWRnZS5tZCcpO1xuICBhc3NlcnQub2soXG4gICAgcmVzb2x2ZWQgPT09IGNhbm9uaWNhbCB8fCByZXNvbHZlZCA9PT0gbGVnYWN5LFxuICAgIGByZXNvbHZlZCBwYXRoIHNob3VsZCBiZSBjYW5vbmljYWwgb3IgbGVnYWN5LCBnb3Q6ICR7cmVzb2x2ZWR9YCxcbiAgKTtcblxuICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG59KTtcblxudGVzdCgna25vd2xlZGdlOiByZXNvbHZlR3NkUm9vdEZpbGUgcmV0dXJucyBjYW5vbmljYWwgcGF0aCB3aGVuIGZpbGUgZG9lcyBub3QgZXhpc3QnLCAoKSA9PiB7XG4gIGNvbnN0IHRtcCA9IHJlYWxwYXRoU3luYyhta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCAnZ3NkLWtub3dsZWRnZS0nKSkpO1xuICBjb25zdCBnc2REaXIgPSBqb2luKHRtcCwgJy5nc2QnKTtcbiAgbWtkaXJTeW5jKGdzZERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgY29uc3QgcmVzb2x2ZWQgPSByZXNvbHZlR3NkUm9vdEZpbGUodG1wLCAnS05PV0xFREdFJyk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXNvbHZlZCwgam9pbihnc2REaXIsICdLTk9XTEVER0UubWQnKSk7XG5cbiAgcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBpbmxpbmVHc2RSb290RmlsZSB3b3JrcyB3aXRoIGtub3dsZWRnZS5tZCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdCgna25vd2xlZGdlOiBpbmxpbmVHc2RSb290RmlsZSByZXR1cm5zIGNvbnRlbnQgd2hlbiBLTk9XTEVER0UubWQgZXhpc3RzJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB0bXAgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCAnZ3NkLWtub3dsZWRnZS0nKSk7XG4gIGNvbnN0IGdzZERpciA9IGpvaW4odG1wLCAnLmdzZCcpO1xuICBta2RpclN5bmMoZ3NkRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGdzZERpciwgJ0tOT1dMRURHRS5tZCcpLCAnIyBQcm9qZWN0IEtub3dsZWRnZVxcblxcbiMjIFJ1bGVzXFxuXFxuSzAwMTogVXNlIHJlYWwgREInKTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBpbmxpbmVHc2RSb290RmlsZSh0bXAsICdrbm93bGVkZ2UubWQnLCAnUHJvamVjdCBLbm93bGVkZ2UnKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdCAhPT0gbnVsbCwgJ3Nob3VsZCByZXR1cm4gY29udGVudCcpO1xuICBhc3NlcnQub2socmVzdWx0IS5pbmNsdWRlcygnUHJvamVjdCBLbm93bGVkZ2UnKSwgJ3Nob3VsZCBpbmNsdWRlIGxhYmVsJyk7XG4gIGFzc2VydC5vayhyZXN1bHQhLmluY2x1ZGVzKCdLMDAxJyksICdzaG91bGQgaW5jbHVkZSBrbm93bGVkZ2UgY29udGVudCcpO1xuXG4gIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbn0pO1xuXG50ZXN0KCdrbm93bGVkZ2U6IGlubGluZUdzZFJvb3RGaWxlIHJldHVybnMgbnVsbCB3aGVuIEtOT1dMRURHRS5tZCBkb2VzIG5vdCBleGlzdCcsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgdG1wID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgJ2dzZC1rbm93bGVkZ2UtJykpO1xuICBjb25zdCBnc2REaXIgPSBqb2luKHRtcCwgJy5nc2QnKTtcbiAgbWtkaXJTeW5jKGdzZERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaW5saW5lR3NkUm9vdEZpbGUodG1wLCAna25vd2xlZGdlLm1kJywgJ1Byb2plY3QgS25vd2xlZGdlJyk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQsIG51bGwsICdzaG91bGQgcmV0dXJuIG51bGwgd2hlbiBmaWxlIGRvZXMgbm90IGV4aXN0Jyk7XG5cbiAgcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBhcHBlbmRLbm93bGVkZ2UgY3JlYXRlcyBmaWxlIGFuZCBhcHBlbmRzIGVudHJpZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoJ2tub3dsZWRnZTogYXBwZW5kS25vd2xlZGdlIGNyZWF0ZXMgS05PV0xFREdFLm1kIHdpdGggcnVsZSB3aGVuIGZpbGUgZG9lcyBub3QgZXhpc3QnLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHRtcCA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksICdnc2Qta25vd2xlZGdlLScpKTtcbiAgY29uc3QgZ3NkRGlyID0gam9pbih0bXAsICcuZ3NkJyk7XG4gIG1rZGlyU3luYyhnc2REaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gIGF3YWl0IGFwcGVuZEtub3dsZWRnZSh0bXAsICdydWxlJywgJ1VzZSByZWFsIERCIGZvciBpbnRlZ3JhdGlvbiB0ZXN0cycsICdNMDAxL1MwMScpO1xuXG4gIGNvbnN0IGNvbnRlbnQgPSByZWFkRmlsZVN5bmMoam9pbihnc2REaXIsICdLTk9XTEVER0UubWQnKSwgJ3V0Zi04Jyk7XG4gIGFzc2VydC5vayhjb250ZW50LmluY2x1ZGVzKCcjIFByb2plY3QgS25vd2xlZGdlJyksICdzaG91bGQgaGF2ZSBoZWFkZXInKTtcbiAgYXNzZXJ0Lm9rKGNvbnRlbnQuaW5jbHVkZXMoJ0swMDEnKSwgJ3Nob3VsZCBoYXZlIEswMDEgaWQnKTtcbiAgYXNzZXJ0Lm9rKGNvbnRlbnQuaW5jbHVkZXMoJ1VzZSByZWFsIERCIGZvciBpbnRlZ3JhdGlvbiB0ZXN0cycpLCAnc2hvdWxkIGhhdmUgcnVsZSB0ZXh0Jyk7XG4gIGFzc2VydC5vayhjb250ZW50LmluY2x1ZGVzKCdNMDAxL1MwMScpLCAnc2hvdWxkIGhhdmUgc2NvcGUnKTtcblxuICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG59KTtcblxudGVzdCgna25vd2xlZGdlOiBhcHBlbmRLbm93bGVkZ2UgYXBwZW5kcyB0byBleGlzdGluZyBLTk9XTEVER0UubWQgd2l0aCBhdXRvLWluY3JlbWVudGluZyBJRCcsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgdG1wID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgJ2dzZC1rbm93bGVkZ2UtJykpO1xuICBjb25zdCBnc2REaXIgPSBqb2luKHRtcCwgJy5nc2QnKTtcbiAgbWtkaXJTeW5jKGdzZERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgLy8gQ3JlYXRlIGluaXRpYWwgZmlsZSB3aXRoIG9uZSBydWxlXG4gIGF3YWl0IGFwcGVuZEtub3dsZWRnZSh0bXAsICdydWxlJywgJ0ZpcnN0IHJ1bGUnLCAnTTAwMScpO1xuICAvLyBBZGQgc2Vjb25kIHJ1bGVcbiAgYXdhaXQgYXBwZW5kS25vd2xlZGdlKHRtcCwgJ3J1bGUnLCAnU2Vjb25kIHJ1bGUnLCAnTTAwMS9TMDInKTtcblxuICBjb25zdCBjb250ZW50ID0gcmVhZEZpbGVTeW5jKGpvaW4oZ3NkRGlyLCAnS05PV0xFREdFLm1kJyksICd1dGYtOCcpO1xuICBhc3NlcnQub2soY29udGVudC5pbmNsdWRlcygnSzAwMScpLCAnc2hvdWxkIGhhdmUgSzAwMScpO1xuICBhc3NlcnQub2soY29udGVudC5pbmNsdWRlcygnSzAwMicpLCAnc2hvdWxkIGhhdmUgSzAwMicpO1xuICBhc3NlcnQub2soY29udGVudC5pbmNsdWRlcygnRmlyc3QgcnVsZScpLCAnc2hvdWxkIGhhdmUgZmlyc3QgcnVsZScpO1xuICBhc3NlcnQub2soY29udGVudC5pbmNsdWRlcygnU2Vjb25kIHJ1bGUnKSwgJ3Nob3VsZCBoYXZlIHNlY29uZCBydWxlJyk7XG5cbiAgcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xufSk7XG5cbnRlc3QoJ2tub3dsZWRnZTogYXBwZW5kS25vd2xlZGdlIGhhbmRsZXMgcGF0dGVybiB0eXBlJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB0bXAgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCAnZ3NkLWtub3dsZWRnZS0nKSk7XG4gIGNvbnN0IGdzZERpciA9IGpvaW4odG1wLCAnLmdzZCcpO1xuICBta2RpclN5bmMoZ3NkRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICBhd2FpdCBhcHBlbmRLbm93bGVkZ2UodG1wLCAncGF0dGVybicsICdNaWRkbGV3YXJlIGNoYWluIGZvciBhdXRoJywgJ00wMDEnKTtcblxuICBjb25zdCBjb250ZW50ID0gcmVhZEZpbGVTeW5jKGpvaW4oZ3NkRGlyLCAnS05PV0xFREdFLm1kJyksICd1dGYtOCcpO1xuICBhc3NlcnQub2soY29udGVudC5pbmNsdWRlcygnUDAwMScpLCAnc2hvdWxkIGhhdmUgUDAwMSBpZCcpO1xuICBhc3NlcnQub2soY29udGVudC5pbmNsdWRlcygnTWlkZGxld2FyZSBjaGFpbiBmb3IgYXV0aCcpLCAnc2hvdWxkIGhhdmUgcGF0dGVybiB0ZXh0Jyk7XG5cbiAgcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xufSk7XG5cbnRlc3QoJ2tub3dsZWRnZTogYXBwZW5kS25vd2xlZGdlIGhhbmRsZXMgbGVzc29uIHR5cGUnLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHRtcCA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksICdnc2Qta25vd2xlZGdlLScpKTtcbiAgY29uc3QgZ3NkRGlyID0gam9pbih0bXAsICcuZ3NkJyk7XG4gIG1rZGlyU3luYyhnc2REaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gIGF3YWl0IGFwcGVuZEtub3dsZWRnZSh0bXAsICdsZXNzb24nLCAnQVBJIHRpbWVvdXQgb24gbGFyZ2UgcGF5bG9hZHMnLCAnTTAwMicpO1xuXG4gIGNvbnN0IGNvbnRlbnQgPSByZWFkRmlsZVN5bmMoam9pbihnc2REaXIsICdLTk9XTEVER0UubWQnKSwgJ3V0Zi04Jyk7XG4gIGFzc2VydC5vayhjb250ZW50LmluY2x1ZGVzKCdMMDAxJyksICdzaG91bGQgaGF2ZSBMMDAxIGlkJyk7XG4gIGFzc2VydC5vayhjb250ZW50LmluY2x1ZGVzKCdBUEkgdGltZW91dCBvbiBsYXJnZSBwYXlsb2FkcycpLCAnc2hvdWxkIGhhdmUgbGVzc29uIHRleHQnKTtcblxuICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGxvYWRLbm93bGVkZ2VCbG9jayBcdTIwMTQgZ2xvYmFsICsgcHJvamVjdCBtZXJnZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdCgnbG9hZEtub3dsZWRnZUJsb2NrOiByZXR1cm5zIGVtcHR5IGJsb2NrIHdoZW4gbmVpdGhlciBmaWxlIGV4aXN0cycsICgpID0+IHtcbiAgY29uc3QgdG1wID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksICdnc2Qta2ItJykpKTtcbiAgY29uc3QgZ3NkSG9tZSA9IGpvaW4odG1wLCAnaG9tZScpO1xuICBjb25zdCBjd2QgPSBqb2luKHRtcCwgJ3Byb2plY3QnKTtcbiAgbWtkaXJTeW5jKGpvaW4oY3dkLCAnLmdzZCcpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgbWtkaXJTeW5jKGpvaW4oZ3NkSG9tZSwgJ2FnZW50JyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGxvYWRLbm93bGVkZ2VCbG9jayhnc2RIb21lLCBjd2QpO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LmJsb2NrLCAnJyk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuZ2xvYmFsU2l6ZUtiLCAwKTtcblxuICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG59KTtcblxudGVzdCgnbG9hZEtub3dsZWRnZUJsb2NrOiB1c2VzIHByb2plY3Qga25vd2xlZGdlIGFsb25lIHdoZW4gbm8gZ2xvYmFsIGZpbGUnLCAoKSA9PiB7XG4gIGNvbnN0IHRtcCA9IHJlYWxwYXRoU3luYyhta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCAnZ3NkLWtiLScpKSk7XG4gIGNvbnN0IGdzZEhvbWUgPSBqb2luKHRtcCwgJ2hvbWUnKTtcbiAgY29uc3QgY3dkID0gam9pbih0bXAsICdwcm9qZWN0Jyk7XG4gIG1rZGlyU3luYyhqb2luKGN3ZCwgJy5nc2QnKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIG1rZGlyU3luYyhqb2luKGdzZEhvbWUsICdhZ2VudCcpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGN3ZCwgJy5nc2QnLCAnS05PV0xFREdFLm1kJyksICdLMDAxOiBVc2UgcmVhbCBEQicpO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGxvYWRLbm93bGVkZ2VCbG9jayhnc2RIb21lLCBjd2QpO1xuICBhc3NlcnQub2socmVzdWx0LmJsb2NrLmluY2x1ZGVzKCdbS05PV0xFREdFIFx1MjAxNCBSdWxlcyBmcm9tIEtOT1dMRURHRS5tZCcpKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdC5ibG9jay5pbmNsdWRlcygnIyMgUHJvamVjdCBLbm93bGVkZ2UnKSk7XG4gIGFzc2VydC5vayhyZXN1bHQuYmxvY2suaW5jbHVkZXMoJ0swMDE6IFVzZSByZWFsIERCJykpO1xuICBhc3NlcnQub2soIXJlc3VsdC5ibG9jay5pbmNsdWRlcygnIyMgR2xvYmFsIEtub3dsZWRnZScpKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5nbG9iYWxTaXplS2IsIDApO1xuXG4gIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbn0pO1xuXG50ZXN0KCdsb2FkS25vd2xlZGdlQmxvY2s6IHVzZXMgZ2xvYmFsIGtub3dsZWRnZSBhbG9uZSB3aGVuIG5vIHByb2plY3QgZmlsZScsICgpID0+IHtcbiAgY29uc3QgdG1wID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksICdnc2Qta2ItJykpKTtcbiAgY29uc3QgZ3NkSG9tZSA9IGpvaW4odG1wLCAnaG9tZScpO1xuICBjb25zdCBjd2QgPSBqb2luKHRtcCwgJ3Byb2plY3QnKTtcbiAgbWtkaXJTeW5jKGpvaW4oY3dkLCAnLmdzZCcpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgbWtkaXJTeW5jKGpvaW4oZ3NkSG9tZSwgJ2FnZW50JyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oZ3NkSG9tZSwgJ2FnZW50JywgJ0tOT1dMRURHRS5tZCcpLCAnRzAwMTogUmVzcG9uZCBpbiBFbmdsaXNoJyk7XG5cbiAgY29uc3QgcmVzdWx0ID0gbG9hZEtub3dsZWRnZUJsb2NrKGdzZEhvbWUsIGN3ZCk7XG4gIGFzc2VydC5vayhyZXN1bHQuYmxvY2suaW5jbHVkZXMoJ1tLTk9XTEVER0UgXHUyMDE0IFJ1bGVzIGZyb20gS05PV0xFREdFLm1kJykpO1xuICBhc3NlcnQub2socmVzdWx0LmJsb2NrLmluY2x1ZGVzKCcjIyBHbG9iYWwgS25vd2xlZGdlJykpO1xuICBhc3NlcnQub2socmVzdWx0LmJsb2NrLmluY2x1ZGVzKCdHMDAxOiBSZXNwb25kIGluIEVuZ2xpc2gnKSk7XG4gIGFzc2VydC5vayghcmVzdWx0LmJsb2NrLmluY2x1ZGVzKCcjIyBQcm9qZWN0IEtub3dsZWRnZScpKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdC5nbG9iYWxTaXplS2IgPiAwKTtcblxuICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG59KTtcblxudGVzdCgnbG9hZEtub3dsZWRnZUJsb2NrOiBtZXJnZXMgZ2xvYmFsIGJlZm9yZSBwcm9qZWN0IHdoZW4gYm90aCBleGlzdCcsICgpID0+IHtcbiAgY29uc3QgdG1wID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksICdnc2Qta2ItJykpKTtcbiAgY29uc3QgZ3NkSG9tZSA9IGpvaW4odG1wLCAnaG9tZScpO1xuICBjb25zdCBjd2QgPSBqb2luKHRtcCwgJ3Byb2plY3QnKTtcbiAgbWtkaXJTeW5jKGpvaW4oY3dkLCAnLmdzZCcpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgbWtkaXJTeW5jKGpvaW4oZ3NkSG9tZSwgJ2FnZW50JyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oZ3NkSG9tZSwgJ2FnZW50JywgJ0tOT1dMRURHRS5tZCcpLCAnRzAwMTogR2xvYmFsIHJ1bGUnKTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGN3ZCwgJy5nc2QnLCAnS05PV0xFREdFLm1kJyksICdLMDAxOiBQcm9qZWN0IHJ1bGUnKTtcblxuICBjb25zdCByZXN1bHQgPSBsb2FkS25vd2xlZGdlQmxvY2soZ3NkSG9tZSwgY3dkKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdC5ibG9jay5pbmNsdWRlcygnIyMgR2xvYmFsIEtub3dsZWRnZScpKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdC5ibG9jay5pbmNsdWRlcygnIyMgUHJvamVjdCBLbm93bGVkZ2UnKSk7XG4gIGFzc2VydC5vayhyZXN1bHQuYmxvY2suaW5jbHVkZXMoJ0cwMDE6IEdsb2JhbCBydWxlJykpO1xuICBhc3NlcnQub2socmVzdWx0LmJsb2NrLmluY2x1ZGVzKCdLMDAxOiBQcm9qZWN0IHJ1bGUnKSk7XG4gIC8vIEdsb2JhbCBzZWN0aW9uIGFwcGVhcnMgYmVmb3JlIHByb2plY3Qgc2VjdGlvblxuICBhc3NlcnQub2socmVzdWx0LmJsb2NrLmluZGV4T2YoJyMjIEdsb2JhbCBLbm93bGVkZ2UnKSA8IHJlc3VsdC5ibG9jay5pbmRleE9mKCcjIyBQcm9qZWN0IEtub3dsZWRnZScpKTtcblxuICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG59KTtcblxudGVzdCgnbG9hZEtub3dsZWRnZUJsb2NrOiBzdHJpcHMgcGF0dGVybnMgYW5kIGxlc3NvbnMgZnJvbSBwcm9qZWN0IGtub3dsZWRnZScsICgpID0+IHtcbiAgY29uc3QgdG1wID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksICdnc2Qta2Itc3RyaXAtJykpKTtcbiAgY29uc3QgZ3NkSG9tZSA9IGpvaW4odG1wLCAnaG9tZScpO1xuICBjb25zdCBjd2QgPSBqb2luKHRtcCwgJ3Byb2plY3QnKTtcbiAgbWtkaXJTeW5jKGpvaW4oY3dkLCAnLmdzZCcpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgbWtkaXJTeW5jKGpvaW4oZ3NkSG9tZSwgJ2FnZW50JyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4oY3dkLCAnLmdzZCcsICdLTk9XTEVER0UubWQnKSxcbiAgICBbXG4gICAgICAnIyBQcm9qZWN0IEtub3dsZWRnZScsXG4gICAgICAnJyxcbiAgICAgICdJbnRybyBub3RlIHRoYXQgc2hvdWxkIHN0YXkgd2l0aCBtYW51YWwgcnVsZXMuJyxcbiAgICAgICcnLFxuICAgICAgJyMjIFJ1bGVzJyxcbiAgICAgICcnLFxuICAgICAgJ3wgSUQgfCBSdWxlIHwgTm90ZXMgfCcsXG4gICAgICAnfC0tLXwtLS18LS0tfCcsXG4gICAgICAnfCBLMDAxIHwgVXNlIHJlYWwgREIgfCAtIHwnLFxuICAgICAgJycsXG4gICAgICAnIyMgUGF0dGVybnMnLFxuICAgICAgJycsXG4gICAgICAnfCBJRCB8IFBhdHRlcm4gfCBXaGVyZSB8IE5vdGVzIHwnLFxuICAgICAgJ3wtLS18LS0tfC0tLXwtLS18JyxcbiAgICAgICd8IFAwMDEgfCBQcmVmZXIgYXN5bmMgfCBzZXJ2ZXIgfCAtIHwnLFxuICAgICAgJycsXG4gICAgICAnIyMgTGVzc29ucyBMZWFybmVkJyxcbiAgICAgICcnLFxuICAgICAgJ3wgSUQgfCBXaGF0IEhhcHBlbmVkIHwgUm9vdCBDYXVzZSB8IEZpeCB8IFNjb3BlIHwnLFxuICAgICAgJ3wtLS18LS0tfC0tLXwtLS18LS0tfCcsXG4gICAgICAnfCBMMDAxIHwgTWlzc2VkIGNhY2hlIHwgTi9BIHwgQWRkIFRUTCB8IHByb2plY3QgfCcsXG4gICAgXS5qb2luKCdcXG4nKSxcbiAgKTtcblxuICBjb25zdCByZXN1bHQgPSBsb2FkS25vd2xlZGdlQmxvY2soZ3NkSG9tZSwgY3dkKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdC5ibG9jay5pbmNsdWRlcygnW0tOT1dMRURHRSBcdTIwMTQgUnVsZXMgZnJvbSBLTk9XTEVER0UubWQnKSk7XG4gIGFzc2VydC5vayhyZXN1bHQuYmxvY2suaW5jbHVkZXMoJ0ludHJvIG5vdGUgdGhhdCBzaG91bGQgc3RheSB3aXRoIG1hbnVhbCBydWxlcy4nKSk7XG4gIGFzc2VydC5vayhyZXN1bHQuYmxvY2suaW5jbHVkZXMoJ0swMDEnKSwgJ3J1bGVzIGVudHJ5IHNob3VsZCBiZSBwcmVzZW50Jyk7XG4gIGFzc2VydC5vayghcmVzdWx0LmJsb2NrLmluY2x1ZGVzKCdQMDAxJyksICdwYXR0ZXJucyBzaG91bGQgYmUgc3RyaXBwZWQgYW5kIGluamVjdGVkIHZpYSBtZW1vcmllcycpO1xuICBhc3NlcnQub2soIXJlc3VsdC5ibG9jay5pbmNsdWRlcygnTDAwMScpLCAnbGVzc29ucyBzaG91bGQgYmUgc3RyaXBwZWQgYW5kIGluamVjdGVkIHZpYSBtZW1vcmllcycpO1xuICBhc3NlcnQub2soIXJlc3VsdC5ibG9jay5pbmNsdWRlcygnIyMgUGF0dGVybnMnKSwgJ1BhdHRlcm5zIGhlYWRpbmcgc2hvdWxkIG5vdCBhcHBlYXInKTtcbiAgYXNzZXJ0Lm9rKCFyZXN1bHQuYmxvY2suaW5jbHVkZXMoJyMjIExlc3NvbnMgTGVhcm5lZCcpLCAnTGVzc29ucyBoZWFkaW5nIHNob3VsZCBub3QgYXBwZWFyJyk7XG5cbiAgcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xufSk7XG5cbnRlc3QoJ2xvYWRLbm93bGVkZ2VCbG9jazogcmVwb3J0cyBnbG9iYWxTaXplS2IgYWJvdmUgNEtCIHRocmVzaG9sZCcsICgpID0+IHtcbiAgY29uc3QgdG1wID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksICdnc2Qta2ItJykpKTtcbiAgY29uc3QgZ3NkSG9tZSA9IGpvaW4odG1wLCAnaG9tZScpO1xuICBjb25zdCBjd2QgPSBqb2luKHRtcCwgJ3Byb2plY3QnKTtcbiAgbWtkaXJTeW5jKGpvaW4oY3dkLCAnLmdzZCcpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgbWtkaXJTeW5jKGpvaW4oZ3NkSG9tZSwgJ2FnZW50JyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAvLyBXcml0ZSA+IDRLQiBvZiBjb250ZW50XG4gIHdyaXRlRmlsZVN5bmMoam9pbihnc2RIb21lLCAnYWdlbnQnLCAnS05PV0xFREdFLm1kJyksICd4Jy5yZXBlYXQoNTAwMCkpO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGxvYWRLbm93bGVkZ2VCbG9jayhnc2RIb21lLCBjd2QpO1xuICBhc3NlcnQub2socmVzdWx0Lmdsb2JhbFNpemVLYiA+IDQsIGBleHBlY3RlZCA+IDRLQiwgZ290ICR7cmVzdWx0Lmdsb2JhbFNpemVLYn1gKTtcblxuICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG59KTtcblxudGVzdCgnbG9hZEtub3dsZWRnZUJsb2NrOiBjYXBzIHJlcGVhdGVkIHN5c3RlbSBwcm9tcHQga25vd2xlZGdlIGJ5IGRlZmF1bHQgd2l0aCBzb3VyY2UgcGF0aCcsICgpID0+IHtcbiAgY29uc3QgdG1wID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksICdnc2Qta2ItJykpKTtcbiAgY29uc3QgZ3NkSG9tZSA9IGpvaW4odG1wLCAnaG9tZScpO1xuICBjb25zdCBjd2QgPSBqb2luKHRtcCwgJ3Byb2plY3QnKTtcbiAgbWtkaXJTeW5jKGpvaW4oY3dkLCAnLmdzZCcpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgbWtkaXJTeW5jKGpvaW4oZ3NkSG9tZSwgJ2FnZW50JyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oY3dkLCAnLmdzZCcsICdLTk9XTEVER0UubWQnKSwgYEswMDE6ICR7J2xhcmdlIHByb2plY3Qga25vd2xlZGdlICcucmVwZWF0KDEyMDApfWApO1xuXG4gIGNvbnN0IG9yaWdpbmFsID0gcHJvY2Vzcy5lbnYuUElfR1NEX0tOT1dMRURHRV9NQVhfQ0hBUlM7XG4gIGRlbGV0ZSBwcm9jZXNzLmVudi5QSV9HU0RfS05PV0xFREdFX01BWF9DSEFSUztcbiAgdHJ5IHtcbiAgICBjb25zdCByZXN1bHQgPSBsb2FkS25vd2xlZGdlQmxvY2soZ3NkSG9tZSwgY3dkKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmJsb2NrLmluY2x1ZGVzKCdTb3VyY2U6IGAnKSk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5ibG9jay5sZW5ndGggPD0gMTJfNTAwLCBga25vd2xlZGdlIGJsb2NrICR7cmVzdWx0LmJsb2NrLmxlbmd0aH0gc2hvdWxkIHN0YXkgbmVhciBkZWZhdWx0IGNhcGApO1xuICAgIGFzc2VydC5vayhyZXN1bHQuYmxvY2suaW5jbHVkZXMoJ1tLbm93bGVkZ2UgVHJ1bmNhdGVkXScpKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBpZiAob3JpZ2luYWwgPT09IHVuZGVmaW5lZCkgZGVsZXRlIHByb2Nlc3MuZW52LlBJX0dTRF9LTk9XTEVER0VfTUFYX0NIQVJTO1xuICAgIGVsc2UgcHJvY2Vzcy5lbnYuUElfR1NEX0tOT1dMRURHRV9NQVhfQ0hBUlMgPSBvcmlnaW5hbDtcbiAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgaW5saW5lS25vd2xlZGdlQnVkZ2V0ZWQgXHUyMDE0IGlzc3VlICM0NzE5IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuLy8gTWlsZXN0b25lLXBoYXNlIHByb21wdHMgbXVzdCBub3QgaW5qZWN0IHRoZSBmdWxsIEtOT1dMRURHRS5tZC4gVGhlIGJ1ZGdldGVkXG4vLyBoZWxwZXIgc2NvcGVzIGJ5IG1pbGVzdG9uZS1sZXZlbCBrZXl3b3JkcyBhbmQgY2FwcyB0aGUgaW5qZWN0ZWQgc2l6ZS5cblxudGVzdCgnaW5saW5lS25vd2xlZGdlQnVkZ2V0ZWQ6IHJldHVybnMgc2NvcGVkIEgzIGVudHJpZXMgZm9yIHNpbmdsZS1IMiBmaWxlJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB0bXAgPSByZWFscGF0aFN5bmMobWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgJ2dzZC1rbm93bGVkZ2UtJykpKTtcbiAgY29uc3QgZ3NkRGlyID0gam9pbih0bXAsICcuZ3NkJyk7XG4gIG1rZGlyU3luYyhnc2REaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gIGNvbnN0IGNvbnRlbnQgPSBgIyBQcm9qZWN0IEtub3dsZWRnZVxuXG4jIyBQYXR0ZXJuc1xuXG4jIyMgRGF0YWJhc2U6IHByZXBhcmVkIHN0YXRlbWVudHNcbkFsd2F5cyB1c2UgcHJlcGFyZWQgc3RhdGVtZW50cyB3aXRoIFNRTGl0ZS5cblxuIyMjIEFQSTogdmVyc2lvbmVkIHBhdGhzXG5Vc2UgL3YxL3Jlc291cmNlIHN0eWxlIHZlcnNpb25pbmcuXG5cbiMjIyBUZXN0aW5nOiBub2RlOnRlc3RcblByZWZlciBub2RlOnRlc3Qgb3ZlciBleHRlcm5hbCBmcmFtZXdvcmtzLlxuYDtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGdzZERpciwgJ0tOT1dMRURHRS5tZCcpLCBjb250ZW50KTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBpbmxpbmVLbm93bGVkZ2VCdWRnZXRlZCh0bXAsIFsnZGF0YWJhc2UnXSk7XG4gIGFzc2VydC5vayhyZXN1bHQgIT09IG51bGwsICdzaG91bGQgcmV0dXJuIGNvbnRlbnQnKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdCEuaW5jbHVkZXMoJ0RhdGFiYXNlOiBwcmVwYXJlZCBzdGF0ZW1lbnRzJyksICdpbmNsdWRlcyBtYXRjaGluZyBIMycpO1xuICBhc3NlcnQub2soIXJlc3VsdCEuaW5jbHVkZXMoJ0FQSTogdmVyc2lvbmVkIHBhdGhzJyksICdleGNsdWRlcyBub24tbWF0Y2hpbmcgSDMnKTtcblxuICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG59KTtcblxudGVzdCgnaW5saW5lS25vd2xlZGdlQnVkZ2V0ZWQ6IGNhcHMgcGF5bG9hZCBiZWxvdyBidWRnZXQgZm9yIGxhcmdlIGZpbGVzJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB0bXAgPSByZWFscGF0aFN5bmMobWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgJ2dzZC1rbm93bGVkZ2UtJykpKTtcbiAgY29uc3QgZ3NkRGlyID0gam9pbih0bXAsICcuZ3NkJyk7XG4gIG1rZGlyU3luYyhnc2REaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gIC8vIEJ1aWxkIGEgMjAwS0IgS05PV0xFREdFIHdpdGggNTAwIEgzIGVudHJpZXMgYWxsIG1hdGNoaW5nICdzaGFyZWQnXG4gIGNvbnN0IGVudHJpZXMgPSBBcnJheS5mcm9tKHsgbGVuZ3RoOiA1MDAgfSwgKF8sIGkpID0+XG4gICAgYCMjIyBFbnRyeSAke2l9OiBzaGFyZWQgdG9waWNcXG4keydmaWxsZXIgdGV4dCAnLnJlcGVhdCgzMCl9XFxuYCxcbiAgKS5qb2luKCdcXG4nKTtcbiAgY29uc3QgY29udGVudCA9IGAjIFByb2plY3QgS25vd2xlZGdlXFxuXFxuIyMgUGF0dGVybnNcXG5cXG4ke2VudHJpZXN9YDtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGdzZERpciwgJ0tOT1dMRURHRS5tZCcpLCBjb250ZW50KTtcblxuICBjb25zdCBCVURHRVRfQ0hBUlMgPSAzMF8wMDA7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGlubGluZUtub3dsZWRnZUJ1ZGdldGVkKHRtcCwgWydzaGFyZWQnXSwgeyBtYXhDaGFyczogQlVER0VUX0NIQVJTIH0pO1xuICBhc3NlcnQub2socmVzdWx0ICE9PSBudWxsLCAnc2hvdWxkIHJldHVybiBjb250ZW50Jyk7XG4gIC8vIEFsbG93IHNvbWUgb3ZlcmhlYWQgZm9yIGhlYWRlciBmb3JtYXR0aW5nLCBidXQgbXVzdCBzdGF5IGNsb3NlIHRvIGJ1ZGdldFxuICBhc3NlcnQub2soXG4gICAgcmVzdWx0IS5sZW5ndGggPD0gQlVER0VUX0NIQVJTICsgNTAwLFxuICAgIGBwYXlsb2FkICR7cmVzdWx0IS5sZW5ndGh9IGNoYXJzIHNob3VsZCBiZSA8PSBidWRnZXQgJHtCVURHRVRfQ0hBUlN9ICgrb3ZlcmhlYWQpYCxcbiAgKTtcbiAgLy8gRmFyIHNtYWxsZXIgdGhhbiB0aGUgcmF3IGZpbGVcbiAgYXNzZXJ0Lm9rKFxuICAgIHJlc3VsdCEubGVuZ3RoIDwgY29udGVudC5sZW5ndGggLyA0LFxuICAgIGBwYXlsb2FkIHNob3VsZCBiZSBtdWNoIHNtYWxsZXIgdGhhbiBmdWxsIGNvbnRlbnQgKCR7Y29udGVudC5sZW5ndGh9IGNoYXJzKWAsXG4gICk7XG4gIGFzc2VydC5tYXRjaChcbiAgICByZXN1bHQhLFxuICAgIC9cXFtcXC5cXC5cXC50cnVuY2F0ZWQgXFxkKyBjaGFyczsgcmVydW4gd2l0aCBuYXJyb3dlciBzY29wZSBpZiBuZWVkZWRcXF0vLFxuICAgICdzaG91bGQgaW5jbHVkZSB0cnVuY2F0aW9uIG5vdGUgd2hlbiBidWRnZXQgaXMgZXhjZWVkZWQnLFxuICApO1xuXG4gIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbn0pO1xuXG50ZXN0KCdpbmxpbmVLbm93bGVkZ2VCdWRnZXRlZDogZGVmYXVsdCBidWRnZXQga2VlcHMgYXV0byBwcm9tcHQga25vd2xlZGdlIGNvbXBhY3QnLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHRtcCA9IHJlYWxwYXRoU3luYyhta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCAnZ3NkLWtub3dsZWRnZS0nKSkpO1xuICBjb25zdCBnc2REaXIgPSBqb2luKHRtcCwgJy5nc2QnKTtcbiAgbWtkaXJTeW5jKGdzZERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgY29uc3QgZW50cmllcyA9IEFycmF5LmZyb20oeyBsZW5ndGg6IDMwMCB9LCAoXywgaSkgPT5cbiAgICBgIyMjIEVudHJ5ICR7aX06IHNoYXJlZCB0b3BpY1xcbiR7J2RlZmF1bHQgYnVkZ2V0IGZpbGxlciAnLnJlcGVhdCgyNSl9XFxuYCxcbiAgKS5qb2luKCdcXG4nKTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGdzZERpciwgJ0tOT1dMRURHRS5tZCcpLCBgIyBQcm9qZWN0IEtub3dsZWRnZVxcblxcbiMjIFBhdHRlcm5zXFxuXFxuJHtlbnRyaWVzfWApO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGlubGluZUtub3dsZWRnZUJ1ZGdldGVkKHRtcCwgWydzaGFyZWQnXSk7XG4gIGFzc2VydC5vayhyZXN1bHQgIT09IG51bGwsICdzaG91bGQgcmV0dXJuIGNvbnRlbnQnKTtcbiAgYXNzZXJ0Lm9rKFxuICAgIHJlc3VsdCEubGVuZ3RoIDw9IDEyXzUwMCxcbiAgICBgZGVmYXVsdCBwYXlsb2FkICR7cmVzdWx0IS5sZW5ndGh9IGNoYXJzIHNob3VsZCBzdGF5IG5lYXIgdGhlIDEyayBidWRnZXRgLFxuICApO1xuICBhc3NlcnQubWF0Y2goXG4gICAgcmVzdWx0ISxcbiAgICAvXFxbXFwuXFwuXFwudHJ1bmNhdGVkIFxcZCsgY2hhcnM7IHJlcnVuIHdpdGggbmFycm93ZXIgc2NvcGUgaWYgbmVlZGVkXFxdLyxcbiAgICAnc2hvdWxkIGluY2x1ZGUgdHJ1bmNhdGlvbiBub3RlIHdoZW4gZGVmYXVsdCBidWRnZXQgaXMgZXhjZWVkZWQnLFxuICApO1xuXG4gIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbn0pO1xuXG50ZXN0KCdpbmxpbmVLbm93bGVkZ2VCdWRnZXRlZDogcmV0dXJucyBudWxsIHdoZW4gbm8gS05PV0xFREdFLm1kIGV4aXN0cycsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgdG1wID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksICdnc2Qta25vd2xlZGdlLScpKSk7XG4gIGNvbnN0IGdzZERpciA9IGpvaW4odG1wLCAnLmdzZCcpO1xuICBta2RpclN5bmMoZ3NkRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBpbmxpbmVLbm93bGVkZ2VCdWRnZXRlZCh0bXAsIFsnZGF0YWJhc2UnXSk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQsIG51bGwpO1xuXG4gIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbn0pO1xuXG50ZXN0KCdpbmxpbmVLbm93bGVkZ2VCdWRnZXRlZDogcmV0dXJucyBudWxsIHdoZW4gbm8gZW50cmllcyBtYXRjaCcsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgdG1wID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksICdnc2Qta25vd2xlZGdlLScpKSk7XG4gIGNvbnN0IGdzZERpciA9IGpvaW4odG1wLCAnLmdzZCcpO1xuICBta2RpclN5bmMoZ3NkRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKGdzZERpciwgJ0tOT1dMRURHRS5tZCcpLFxuICAgICcjIFByb2plY3QgS25vd2xlZGdlXFxuXFxuIyMgUGF0dGVybnNcXG5cXG4jIyMgRGF0YWJhc2VcXG51c2UgaXRcXG4nLFxuICApO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGlubGluZUtub3dsZWRnZUJ1ZGdldGVkKHRtcCwgWydub25leGlzdGVudCddKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdCwgbnVsbCk7XG5cbiAgcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFXQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxXQUFXLGVBQWUsY0FBYyxRQUFRLG9CQUFvQjtBQUMxRixTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsZ0JB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
