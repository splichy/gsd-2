import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  EvalReviewArgError,
  MAX_CONTEXT_BYTES,
  SLICE_ID_PATTERN,
  buildEvalReviewContext,
  buildEvalReviewPrompt,
  detectEvalReviewState,
  evalReviewWritePath,
  findEvalReviewFile,
  parseEvalReviewArgs,
  planEvalReviewAction
} from "../commands-eval-review.js";
import { GSD_COMMAND_DESCRIPTION, TOP_LEVEL_SUBCOMMANDS } from "../commands/catalog.js";
import { _clearGsdRootCache } from "../paths.js";
describe("parseEvalReviewArgs", () => {
  it("parses a bare slice ID", () => {
    const result = parseEvalReviewArgs("S07");
    assert.equal(result.sliceId, "S07");
    assert.equal(result.force, false);
    assert.equal(result.show, false);
  });
  it("recognizes --force", () => {
    const result = parseEvalReviewArgs("S07 --force");
    assert.equal(result.force, true);
  });
  it("recognizes --show", () => {
    const result = parseEvalReviewArgs("S07 --show");
    assert.equal(result.show, true);
  });
  it("treats flag order as irrelevant", () => {
    const result = parseEvalReviewArgs("--force S07 --show");
    assert.equal(result.sliceId, "S07");
    assert.equal(result.force, true);
    assert.equal(result.show, true);
  });
  it("collapses multiple whitespace separators", () => {
    const result = parseEvalReviewArgs("   S07    --force  ");
    assert.equal(result.sliceId, "S07");
    assert.equal(result.force, true);
  });
  it("throws when the slice ID is missing entirely", () => {
    assert.throws(() => parseEvalReviewArgs(""), EvalReviewArgError);
    assert.throws(() => parseEvalReviewArgs("   "), EvalReviewArgError);
    assert.throws(() => parseEvalReviewArgs("--force"), EvalReviewArgError);
  });
  it("throws on an unknown --* token (regression: --force-wipe must not be silently stripped)", () => {
    assert.throws(() => parseEvalReviewArgs("S07 --force-wipe"), EvalReviewArgError);
  });
  it("throws on multiple slice IDs", () => {
    assert.throws(() => parseEvalReviewArgs("S07 S08"), EvalReviewArgError);
  });
  it("rejects path-traversal in the slice ID (regression: path-traversal blocker)", () => {
    assert.throws(() => parseEvalReviewArgs("../../etc/passwd"), EvalReviewArgError);
    assert.throws(() => parseEvalReviewArgs("S01/../../"), EvalReviewArgError);
    assert.throws(() => parseEvalReviewArgs("S01/.."), EvalReviewArgError);
  });
  it("rejects backslash separators in the slice ID", () => {
    assert.throws(() => parseEvalReviewArgs("S01\\..\\..\\etc"), EvalReviewArgError);
  });
  it("rejects null bytes in the slice ID", () => {
    assert.throws(() => parseEvalReviewArgs("S01\0"), EvalReviewArgError);
  });
  it("rejects unicode look-alikes (Cyrillic \u0405)", () => {
    assert.throws(() => parseEvalReviewArgs("\u040501"), EvalReviewArgError);
  });
  it("rejects lowercase 's' prefix", () => {
    assert.throws(() => parseEvalReviewArgs("s01"), EvalReviewArgError);
  });
  it("rejects ID without trailing digits", () => {
    assert.throws(() => parseEvalReviewArgs("S"), EvalReviewArgError);
    assert.throws(() => parseEvalReviewArgs("Sabc"), EvalReviewArgError);
  });
  it("accepts multi-digit slice IDs", () => {
    assert.equal(parseEvalReviewArgs("S100").sliceId, "S100");
  });
});
describe("SLICE_ID_PATTERN", () => {
  it("matches the canonical /^S\\d+$/ shape used elsewhere in the gsd extension", () => {
    assert.ok(SLICE_ID_PATTERN.test("S01"));
    assert.ok(SLICE_ID_PATTERN.test("S99"));
    assert.ok(!SLICE_ID_PATTERN.test("s01"));
    assert.ok(!SLICE_ID_PATTERN.test("S"));
    assert.ok(!SLICE_ID_PATTERN.test("S01a"));
    assert.ok(!SLICE_ID_PATTERN.test("../S01"));
  });
});
describe("detectEvalReviewState", () => {
  let basePath;
  beforeEach(() => {
    basePath = join(tmpdir(), `gsd-eval-review-test-${randomUUID()}`);
    mkdirSync(basePath, { recursive: true });
  });
  afterEach(() => {
    _clearGsdRootCache();
    rmSync(basePath, { recursive: true, force: true });
  });
  function setupSliceLayout(sliceFiles) {
    const sliceDir = join(basePath, ".gsd", "milestones", "M001", "slices", "S07");
    mkdirSync(sliceDir, { recursive: true });
    for (const [filename, content] of Object.entries(sliceFiles)) {
      writeFileSync(join(sliceDir, filename), content, "utf-8");
    }
  }
  it("returns no-slice-dir when the slice directory is missing (regression: no-slice-dir vs no-summary must be distinct states)", () => {
    mkdirSync(join(basePath, ".gsd", "milestones", "M001", "slices"), { recursive: true });
    const result = detectEvalReviewState(
      { sliceId: "S07", force: false, show: false },
      basePath,
      "M001"
    );
    assert.equal(result.kind, "no-slice-dir");
    if (result.kind === "no-slice-dir") {
      assert.equal(result.sliceId, "S07");
      assert.ok(result.expectedDir.includes("S07"));
    }
  });
  it("returns no-summary when the slice directory exists but SUMMARY.md is missing", () => {
    setupSliceLayout({});
    const result = detectEvalReviewState(
      { sliceId: "S07", force: false, show: false },
      basePath,
      "M001"
    );
    assert.equal(result.kind, "no-summary");
  });
  it("returns no-summary with specPath populated when only AI-SPEC.md is present", () => {
    setupSliceLayout({ "S07-AI-SPEC.md": "# spec" });
    const result = detectEvalReviewState(
      { sliceId: "S07", force: false, show: false },
      basePath,
      "M001"
    );
    assert.equal(result.kind, "no-summary");
    if (result.kind === "no-summary") {
      assert.ok(result.specPath?.endsWith("S07-AI-SPEC.md"));
    }
  });
  it("returns ready when SUMMARY.md is present, with specPath null when AI-SPEC.md is absent", () => {
    setupSliceLayout({ "S07-SUMMARY.md": "# summary" });
    const result = detectEvalReviewState(
      { sliceId: "S07", force: false, show: false },
      basePath,
      "M001"
    );
    assert.equal(result.kind, "ready");
    if (result.kind === "ready") {
      assert.ok(result.summaryPath.endsWith("S07-SUMMARY.md"));
      assert.equal(result.specPath, null);
    }
  });
  it("returns ready with both paths populated when both files exist", () => {
    setupSliceLayout({
      "S07-SUMMARY.md": "# summary",
      "S07-AI-SPEC.md": "# spec"
    });
    const result = detectEvalReviewState(
      { sliceId: "S07", force: false, show: false },
      basePath,
      "M001"
    );
    assert.equal(result.kind, "ready");
    if (result.kind === "ready") {
      assert.ok(result.summaryPath.endsWith("S07-SUMMARY.md"));
      assert.ok(result.specPath?.endsWith("S07-AI-SPEC.md"));
    }
  });
});
describe("buildEvalReviewContext", () => {
  let basePath;
  let sliceDir;
  beforeEach(() => {
    basePath = join(tmpdir(), `gsd-eval-ctx-test-${randomUUID()}`);
    sliceDir = join(basePath, ".gsd", "milestones", "M001", "slices", "S07");
    mkdirSync(sliceDir, { recursive: true });
    process.chdir(basePath);
  });
  afterEach(() => {
    _clearGsdRootCache();
    process.chdir(tmpdir());
    rmSync(basePath, { recursive: true, force: true });
  });
  function fakeReady(opts = {}) {
    const summaryPath = join(sliceDir, "S07-SUMMARY.md");
    writeFileSync(summaryPath, "S".repeat(opts.summaryBytes ?? 512), "utf-8");
    let specPath = null;
    if (opts.specBytes != null) {
      specPath = join(sliceDir, "S07-AI-SPEC.md");
      writeFileSync(specPath, "P".repeat(opts.specBytes), "utf-8");
    }
    return {
      kind: "ready",
      sliceId: "S07",
      sliceDir,
      summaryPath,
      specPath
    };
  }
  it("inlines SUMMARY without truncation when under the cap", async () => {
    const state = fakeReady({ summaryBytes: 1024 });
    const ctx = await buildEvalReviewContext(state, "M001", () => /* @__PURE__ */ new Date("2026-04-28T14:00:00Z"));
    assert.equal(ctx.truncated, false);
    assert.equal(ctx.summary.length, 1024);
    assert.equal(ctx.spec, null);
    assert.equal(ctx.generatedAt, "2026-04-28T14:00:00Z");
  });
  it("truncates SUMMARY when it alone exceeds the cap (regression: prompt-size cap)", async () => {
    const state = fakeReady({ summaryBytes: MAX_CONTEXT_BYTES + 4096 });
    const ctx = await buildEvalReviewContext(state, "M001");
    assert.equal(ctx.truncated, true);
    assert.ok(ctx.summary.includes("[truncated:"));
    assert.equal(ctx.spec, null, "no budget for spec when summary alone exceeds cap");
  });
  it("inlines both SUMMARY and SPEC when their combined bytes fit", async () => {
    const state = fakeReady({ summaryBytes: 1024, specBytes: 2048 });
    const ctx = await buildEvalReviewContext(state, "M001");
    assert.equal(ctx.truncated, false);
    assert.equal(ctx.summary.length, 1024);
    assert.equal(ctx.spec?.length, 2048);
  });
  it("truncates SPEC to the residual budget when SUMMARY is large", async () => {
    const summaryBytes = MAX_CONTEXT_BYTES - 1024;
    const specBytes = 8 * 1024;
    const state = fakeReady({ summaryBytes, specBytes });
    const ctx = await buildEvalReviewContext(state, "M001");
    assert.equal(ctx.truncated, true);
    assert.ok(ctx.spec?.includes("[truncated:"));
  });
  it("returns spec=null when no AI-SPEC.md exists (best-practices audit mode)", async () => {
    const state = fakeReady({ summaryBytes: 256 });
    const ctx = await buildEvalReviewContext(state, "M001");
    assert.equal(ctx.spec, null);
  });
  it("emits a spec-elision marker when SUMMARY consumed the entire byte budget", async () => {
    const state = fakeReady({ summaryBytes: MAX_CONTEXT_BYTES, specBytes: 1024 });
    const ctx = await buildEvalReviewContext(state, "M001");
    assert.equal(ctx.truncated, true);
    assert.ok(ctx.spec?.includes("[truncated:"));
    assert.ok(ctx.spec?.toLowerCase().includes("ai-spec"));
  });
  it("degrades to a marker (not a throw) when AI-SPEC.md read fails \u2014 spec is optional", async () => {
    const state = fakeReady({ summaryBytes: 512, specBytes: 256 });
    rmSync(state.specPath);
    const ctx = await buildEvalReviewContext(state, "M001");
    assert.equal(ctx.truncated, true);
    assert.ok(ctx.spec?.includes("[truncated:"));
    assert.ok(ctx.spec?.toLowerCase().includes("failed to read"));
  });
  it("does not emit a U+FFFD replacement character when the cap falls mid multi-byte UTF-8 sequence", async () => {
    const path = join(sliceDir, "S07-SUMMARY.md");
    const filler = "x".repeat(MAX_CONTEXT_BYTES - 1);
    const fourByteCodepoint = "\u{1F600}";
    writeFileSync(path, filler + fourByteCodepoint, "utf-8");
    const state = {
      kind: "ready",
      sliceId: "S07",
      sliceDir,
      summaryPath: path,
      specPath: null
    };
    const ctx = await buildEvalReviewContext(state, "M001");
    assert.equal(ctx.truncated, true);
    assert.ok(!ctx.summary.includes("\uFFFD"), "must not contain replacement char at the truncation boundary");
  });
  it("keeps total summary+spec byte length within MAX_CONTEXT_BYTES under truncation", async () => {
    const summaryPath = join(sliceDir, "S07-SUMMARY.md");
    const specPath = join(sliceDir, "S07-AI-SPEC.md");
    writeFileSync(summaryPath, "S".repeat(MAX_CONTEXT_BYTES * 2), "utf-8");
    writeFileSync(specPath, "P".repeat(MAX_CONTEXT_BYTES * 2), "utf-8");
    const state = {
      kind: "ready",
      sliceId: "S07",
      sliceDir,
      summaryPath,
      specPath
    };
    const ctx = await buildEvalReviewContext(state, "M001");
    const summaryBytes = Buffer.byteLength(ctx.summary, "utf-8");
    const specBytes = ctx.spec ? Buffer.byteLength(ctx.spec, "utf-8") : 0;
    assert.ok(
      summaryBytes + specBytes <= MAX_CONTEXT_BYTES,
      `total ${summaryBytes + specBytes} must not exceed cap ${MAX_CONTEXT_BYTES}`
    );
    assert.ok(ctx.summary.includes("[truncated:"));
  });
  it("keeps single-file truncation within maxBytes (regression: marker bytes count toward cap)", async () => {
    const summaryPath = join(sliceDir, "S07-SUMMARY.md");
    writeFileSync(summaryPath, "S".repeat(MAX_CONTEXT_BYTES * 2), "utf-8");
    const state = {
      kind: "ready",
      sliceId: "S07",
      sliceDir,
      summaryPath,
      specPath: null
    };
    const ctx = await buildEvalReviewContext(state, "M001");
    assert.equal(ctx.truncated, true);
    const totalBytes = Buffer.byteLength(ctx.summary, "utf-8");
    assert.ok(totalBytes <= MAX_CONTEXT_BYTES, `${totalBytes} > ${MAX_CONTEXT_BYTES}`);
    assert.ok(ctx.summary.includes("[truncated:"));
  });
  it("populates outputPath using the canonical slice file naming", async () => {
    const state = fakeReady({ summaryBytes: 64 });
    const ctx = await buildEvalReviewContext(state, "M001");
    assert.ok(ctx.outputPath.endsWith("S07-EVAL-REVIEW.md"));
  });
  it("emits the short fallback marker when AI-SPEC read fails with a verbose error", async () => {
    const state = fakeReady({ summaryBytes: MAX_CONTEXT_BYTES - 80, specBytes: 256 });
    rmSync(state.specPath);
    const ctx = await buildEvalReviewContext(state, "M001");
    assert.equal(ctx.truncated, true);
    assert.ok(ctx.spec, "spec must surface as a marker, not null");
    assert.ok(ctx.spec.includes("[truncated:"));
    assert.ok(Buffer.byteLength(ctx.summary, "utf-8") + Buffer.byteLength(ctx.spec, "utf-8") <= MAX_CONTEXT_BYTES);
  });
  it("does not load the full file into memory beyond the cap (regression: streaming readCapped)", async () => {
    const summaryPath = join(sliceDir, "S07-SUMMARY.md");
    const giant = MAX_CONTEXT_BYTES * 8;
    writeFileSync(summaryPath, "S".repeat(giant), "utf-8");
    const state = {
      kind: "ready",
      sliceId: "S07",
      sliceDir,
      summaryPath,
      specPath: null
    };
    const ctx = await buildEvalReviewContext(state, "M001");
    assert.equal(ctx.truncated, true);
    assert.ok(Buffer.byteLength(ctx.summary, "utf-8") <= MAX_CONTEXT_BYTES);
    assert.ok(ctx.summary.includes("bytes elided to fit eval-review context cap"));
  });
  it("does not pre-reserve spec budget when no AI-SPEC.md exists", async () => {
    const summaryBytes = MAX_CONTEXT_BYTES - 64;
    const state = fakeReady({ summaryBytes });
    const ctx = await buildEvalReviewContext(state, "M001");
    assert.equal(ctx.truncated, false, "summary must fit without truncation when no spec is reserved");
    assert.equal(Buffer.byteLength(ctx.summary, "utf-8"), summaryBytes);
    assert.equal(ctx.spec, null);
  });
  it("includes a small AI-SPEC even when remaining is below MIN_USEFUL_SPEC_BYTES", async () => {
    const summaryBytes = MAX_CONTEXT_BYTES - 200;
    const specBytes = 100;
    const state = fakeReady({ summaryBytes, specBytes });
    const ctx = await buildEvalReviewContext(state, "M001");
    assert.ok(ctx.spec, "spec must be inlined when it actually fits");
    assert.equal(Buffer.byteLength(ctx.spec, "utf-8"), specBytes);
    assert.ok(!ctx.spec.includes("[truncated:"), "small spec must not be replaced by a marker");
  });
});
describe("evalReviewWritePath", () => {
  it("computes the canonical write path purely from inputs", () => {
    const sliceDir = join("/repo", ".gsd", "milestones", "M001", "slices", "S07");
    const expected = join(sliceDir, "S07-EVAL-REVIEW.md");
    assert.equal(evalReviewWritePath(sliceDir, "S07"), expected);
  });
  it("does not touch the filesystem", () => {
    const sliceDir = join("/nonexistent", "path", "abc");
    const result = evalReviewWritePath(sliceDir, "S99");
    assert.ok(result.endsWith("S99-EVAL-REVIEW.md"));
  });
});
describe("findEvalReviewFile", () => {
  let basePath;
  beforeEach(() => {
    basePath = join(tmpdir(), `gsd-find-eval-${randomUUID()}`);
    mkdirSync(join(basePath, ".gsd", "milestones", "M001", "slices", "S07"), { recursive: true });
  });
  afterEach(() => {
    _clearGsdRootCache();
    rmSync(basePath, { recursive: true, force: true });
  });
  it("returns null when EVAL-REVIEW.md is absent", () => {
    assert.equal(findEvalReviewFile(basePath, "M001", "S07"), null);
  });
  it("returns the absolute path when EVAL-REVIEW.md is present", () => {
    const target = join(basePath, ".gsd", "milestones", "M001", "slices", "S07", "S07-EVAL-REVIEW.md");
    writeFileSync(target, "---\nschema: eval-review/v1\n---\n", "utf-8");
    const found = findEvalReviewFile(basePath, "M001", "S07");
    assert.equal(found, realpathSync(target));
  });
});
describe("planEvalReviewAction", () => {
  function args(overrides = {}) {
    return { sliceId: "S07", force: false, show: false, ...overrides };
  }
  const noSliceDir = { kind: "no-slice-dir", sliceId: "S07", expectedDir: "/tmp/x" };
  const noSummary = { kind: "no-summary", sliceId: "S07", sliceDir: "/tmp/x", specPath: null };
  const ready = { kind: "ready", sliceId: "S07", sliceDir: "/tmp/x", summaryPath: "/tmp/x/SUMMARY.md", specPath: null };
  it("returns no-slice-dir before checking show or anything else", () => {
    assert.equal(planEvalReviewAction(args({ show: true }), noSliceDir, "/tmp/r.md").kind, "no-slice-dir");
    assert.equal(planEvalReviewAction(args({ force: true }), noSliceDir, null).kind, "no-slice-dir");
  });
  it("returns show with the existing path when --show is set, even if SUMMARY is missing (regression: --show must bypass no-summary)", () => {
    const action = planEvalReviewAction(args({ show: true }), noSummary, "/tmp/r.md");
    assert.equal(action.kind, "show");
    if (action.kind === "show") assert.equal(action.path, "/tmp/r.md");
  });
  it("returns show with null path when --show is set and no EVAL-REVIEW.md exists", () => {
    const action = planEvalReviewAction(args({ show: true }), noSummary, null);
    assert.equal(action.kind, "show");
    if (action.kind === "show") assert.equal(action.path, null);
  });
  it("returns no-summary when SUMMARY missing and --show is NOT set", () => {
    assert.equal(planEvalReviewAction(args(), noSummary, null).kind, "no-summary");
    assert.equal(planEvalReviewAction(args({ force: true }), noSummary, "/tmp/r.md").kind, "no-summary");
  });
  it("returns exists-no-force when EVAL-REVIEW.md is present and --force is NOT set", () => {
    const action = planEvalReviewAction(args(), ready, "/tmp/r.md");
    assert.equal(action.kind, "exists-no-force");
    if (action.kind === "exists-no-force") assert.equal(action.path, "/tmp/r.md");
  });
  it("returns dispatch when ready, no existing file", () => {
    assert.equal(planEvalReviewAction(args(), ready, null).kind, "dispatch");
  });
  it("returns dispatch when ready and --force overrides existing file", () => {
    assert.equal(planEvalReviewAction(args({ force: true }), ready, "/tmp/r.md").kind, "dispatch");
  });
});
describe("catalog registration", () => {
  it("includes eval-review in TOP_LEVEL_SUBCOMMANDS", () => {
    const entry = TOP_LEVEL_SUBCOMMANDS.find((c) => c.cmd === "eval-review");
    assert.ok(entry, "eval-review must be present in TOP_LEVEL_SUBCOMMANDS");
    assert.ok((entry?.desc ?? "").length > 0, "eval-review entry must have a non-empty description");
  });
  it("appends eval-review to the GSD_COMMAND_DESCRIPTION pipe-separated list", () => {
    assert.ok(
      GSD_COMMAND_DESCRIPTION.includes("|eval-review"),
      "GSD_COMMAND_DESCRIPTION must include the eval-review token (pipe-prefixed)"
    );
  });
});
describe("buildEvalReviewPrompt", () => {
  function ctxFixture(overrides = {}) {
    return {
      milestoneId: "M001",
      sliceId: "S07",
      summary: "The slice did stuff.",
      summaryPath: "/abs/.gsd/milestones/M001/slices/S07/S07-SUMMARY.md",
      spec: "Required: log every LLM call.",
      specPath: "/abs/.gsd/milestones/M001/slices/S07/S07-AI-SPEC.md",
      outputPath: "/abs/.gsd/milestones/M001/slices/S07/S07-EVAL-REVIEW.md",
      relativeOutputPath: ".gsd/milestones/M001/slices/S07/S07-EVAL-REVIEW.md",
      truncated: false,
      generatedAt: "2026-04-28T14:00:00Z",
      ...overrides
    };
  }
  it("includes the explicit anti-Goodhart rule (string presence is not evidence \u2014 anti-Goodhart guard)", () => {
    const prompt = buildEvalReviewPrompt(ctxFixture());
    assert.ok(prompt.includes("Anti-Goodhart"), "prompt must reference the anti-Goodhart rule by name");
    assert.ok(
      prompt.includes("string or file\npresence") || prompt.includes("string presence") || prompt.toLowerCase().includes("not evidence"),
      "prompt must explicitly state that string/token presence is not evidence"
    );
    assert.ok(prompt.includes("grep langfuse"), "prompt must show the canonical Goodhart counter-example");
  });
  it("requires evidence on every gap (frontmatter contract)", () => {
    const prompt = buildEvalReviewPrompt(ctxFixture());
    assert.ok(prompt.includes("evidence"), "prompt must require an evidence field");
    assert.ok(prompt.includes("REQUIRED"), "prompt must mark evidence as required");
  });
  it("inlines the YAML schema with the expected version literal", () => {
    const prompt = buildEvalReviewPrompt(ctxFixture());
    assert.ok(prompt.includes("schema: eval-review/v1"));
    assert.ok(prompt.includes("PRODUCTION_READY"));
    assert.ok(prompt.includes("NOT_IMPLEMENTED"));
  });
  it("instructs the agent to write to the canonical output path", () => {
    const prompt = buildEvalReviewPrompt(ctxFixture());
    assert.ok(prompt.includes("/abs/.gsd/milestones/M001/slices/S07/S07-EVAL-REVIEW.md"));
  });
  it("surfaces the truncation marker into the prompt body when inputs were truncated", () => {
    const prompt = buildEvalReviewPrompt(ctxFixture({ truncated: true }));
    assert.ok(prompt.includes("truncated"));
  });
  it("documents the 60/40 weighting alongside the rubric and explains the split", () => {
    const prompt = buildEvalReviewPrompt(ctxFixture());
    assert.ok(prompt.includes("0.6"));
    assert.ok(prompt.includes("0.4"));
    assert.ok(prompt.toLowerCase().includes("compound"));
    assert.ok(prompt.includes("Alternatives considered"));
  });
  it("falls back to a best-practices note when AI-SPEC.md is absent", () => {
    const prompt = buildEvalReviewPrompt(ctxFixture({ spec: null, specPath: null }));
    assert.ok(prompt.toLowerCase().includes("not present"));
  });
  it("renders an empty AI-SPEC.md as data, not as 'not present'", () => {
    const prompt = buildEvalReviewPrompt(ctxFixture({ spec: "" }));
    assert.ok(!prompt.toLowerCase().includes("not present"), "empty spec must not collapse into 'not present'");
    assert.ok(prompt.includes("### AI-SPEC.md"));
  });
  it("treats slice artefacts as untrusted data with explicit injection-defense banner", () => {
    const prompt = buildEvalReviewPrompt(ctxFixture());
    assert.ok(prompt.includes("untrusted data"), "prompt must label artefacts as untrusted");
    assert.ok(prompt.toLowerCase().includes("ignore any instructions"), "prompt must instruct the model to ignore directives in artefacts");
    assert.ok(prompt.includes("~~~~markdown"), "artefact bodies must be wrapped in a fenced data block");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jb21tYW5kcy1ldmFsLXJldmlldy50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFVuaXQgdGVzdHMgZm9yIGAvZ3NkIGV2YWwtcmV2aWV3YCAoY29tbWFuZHMtZXZhbC1yZXZpZXcudHMpLlxuICpcbiAqIEVhY2ggcHJpb3IgcmV2aWV3IGZpbmRpbmcgaXMgcGFpcmVkIHdpdGggYSByZWdyZXNzaW9uIHRlc3QgdGhhdCBhc3NlcnRzXG4gKiB0aGUgZG9jdW1lbnRlZCBmaXggYmVoYXZpb3IuIFRlc3RzIGFyZSBvcmdhbml6ZWQgb25lIGBkZXNjcmliZWAgcGVyXG4gKiBleHBvcnRlZCBmdW5jdGlvbiwgd2l0aCB0aGUgcmVncmVzc2lvbi10ZXN0IGNhc2VzIG1hcmtlZCBpbiB0aGVpciBgaXRgXG4gKiBkZXNjcmlwdGlvbnMuXG4gKi9cblxuaW1wb3J0IHsgZGVzY3JpYmUsIGl0LCBiZWZvcmVFYWNoLCBhZnRlckVhY2ggfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZGlyU3luYywgcmVhbHBhdGhTeW5jLCB3cml0ZUZpbGVTeW5jLCBybVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSBcIm5vZGU6Y3J5cHRvXCI7XG5cbmltcG9ydCB7XG4gIEV2YWxSZXZpZXdBcmdFcnJvcixcbiAgTUFYX0NPTlRFWFRfQllURVMsXG4gIFNMSUNFX0lEX1BBVFRFUk4sXG4gIGJ1aWxkRXZhbFJldmlld0NvbnRleHQsXG4gIGJ1aWxkRXZhbFJldmlld1Byb21wdCxcbiAgZGV0ZWN0RXZhbFJldmlld1N0YXRlLFxuICBldmFsUmV2aWV3V3JpdGVQYXRoLFxuICBmaW5kRXZhbFJldmlld0ZpbGUsXG4gIHBhcnNlRXZhbFJldmlld0FyZ3MsXG4gIHBsYW5FdmFsUmV2aWV3QWN0aW9uLFxuICB0eXBlIEV2YWxSZXZpZXdBcmdzLFxuICB0eXBlIEV2YWxSZXZpZXdTdGF0ZSxcbn0gZnJvbSBcIi4uL2NvbW1hbmRzLWV2YWwtcmV2aWV3LmpzXCI7XG5pbXBvcnQgeyBHU0RfQ09NTUFORF9ERVNDUklQVElPTiwgVE9QX0xFVkVMX1NVQkNPTU1BTkRTIH0gZnJvbSBcIi4uL2NvbW1hbmRzL2NhdGFsb2cuanNcIjtcbmltcG9ydCB7IF9jbGVhckdzZFJvb3RDYWNoZSB9IGZyb20gXCIuLi9wYXRocy5qc1wiO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgcGFyc2VFdmFsUmV2aWV3QXJncyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJwYXJzZUV2YWxSZXZpZXdBcmdzXCIsICgpID0+IHtcbiAgaXQoXCJwYXJzZXMgYSBiYXJlIHNsaWNlIElEXCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBwYXJzZUV2YWxSZXZpZXdBcmdzKFwiUzA3XCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc2xpY2VJZCwgXCJTMDdcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5mb3JjZSwgZmFsc2UpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc2hvdywgZmFsc2UpO1xuICB9KTtcblxuICBpdChcInJlY29nbml6ZXMgLS1mb3JjZVwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gcGFyc2VFdmFsUmV2aWV3QXJncyhcIlMwNyAtLWZvcmNlXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuZm9yY2UsIHRydWUpO1xuICB9KTtcblxuICBpdChcInJlY29nbml6ZXMgLS1zaG93XCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBwYXJzZUV2YWxSZXZpZXdBcmdzKFwiUzA3IC0tc2hvd1wiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnNob3csIHRydWUpO1xuICB9KTtcblxuICBpdChcInRyZWF0cyBmbGFnIG9yZGVyIGFzIGlycmVsZXZhbnRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IHBhcnNlRXZhbFJldmlld0FyZ3MoXCItLWZvcmNlIFMwNyAtLXNob3dcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zbGljZUlkLCBcIlMwN1wiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmZvcmNlLCB0cnVlKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnNob3csIHRydWUpO1xuICB9KTtcblxuICBpdChcImNvbGxhcHNlcyBtdWx0aXBsZSB3aGl0ZXNwYWNlIHNlcGFyYXRvcnNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IHBhcnNlRXZhbFJldmlld0FyZ3MoXCIgICBTMDcgICAgLS1mb3JjZSAgXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc2xpY2VJZCwgXCJTMDdcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5mb3JjZSwgdHJ1ZSk7XG4gIH0pO1xuXG4gIGl0KFwidGhyb3dzIHdoZW4gdGhlIHNsaWNlIElEIGlzIG1pc3NpbmcgZW50aXJlbHlcIiwgKCkgPT4ge1xuICAgIGFzc2VydC50aHJvd3MoKCkgPT4gcGFyc2VFdmFsUmV2aWV3QXJncyhcIlwiKSwgRXZhbFJldmlld0FyZ0Vycm9yKTtcbiAgICBhc3NlcnQudGhyb3dzKCgpID0+IHBhcnNlRXZhbFJldmlld0FyZ3MoXCIgICBcIiksIEV2YWxSZXZpZXdBcmdFcnJvcik7XG4gICAgYXNzZXJ0LnRocm93cygoKSA9PiBwYXJzZUV2YWxSZXZpZXdBcmdzKFwiLS1mb3JjZVwiKSwgRXZhbFJldmlld0FyZ0Vycm9yKTtcbiAgfSk7XG5cbiAgaXQoXCJ0aHJvd3Mgb24gYW4gdW5rbm93biAtLSogdG9rZW4gKHJlZ3Jlc3Npb246IC0tZm9yY2Utd2lwZSBtdXN0IG5vdCBiZSBzaWxlbnRseSBzdHJpcHBlZClcIiwgKCkgPT4ge1xuICAgIGFzc2VydC50aHJvd3MoKCkgPT4gcGFyc2VFdmFsUmV2aWV3QXJncyhcIlMwNyAtLWZvcmNlLXdpcGVcIiksIEV2YWxSZXZpZXdBcmdFcnJvcik7XG4gIH0pO1xuXG4gIGl0KFwidGhyb3dzIG9uIG11bHRpcGxlIHNsaWNlIElEc1wiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LnRocm93cygoKSA9PiBwYXJzZUV2YWxSZXZpZXdBcmdzKFwiUzA3IFMwOFwiKSwgRXZhbFJldmlld0FyZ0Vycm9yKTtcbiAgfSk7XG5cbiAgaXQoXCJyZWplY3RzIHBhdGgtdHJhdmVyc2FsIGluIHRoZSBzbGljZSBJRCAocmVncmVzc2lvbjogcGF0aC10cmF2ZXJzYWwgYmxvY2tlcilcIiwgKCkgPT4ge1xuICAgIGFzc2VydC50aHJvd3MoKCkgPT4gcGFyc2VFdmFsUmV2aWV3QXJncyhcIi4uLy4uL2V0Yy9wYXNzd2RcIiksIEV2YWxSZXZpZXdBcmdFcnJvcik7XG4gICAgYXNzZXJ0LnRocm93cygoKSA9PiBwYXJzZUV2YWxSZXZpZXdBcmdzKFwiUzAxLy4uLy4uL1wiKSwgRXZhbFJldmlld0FyZ0Vycm9yKTtcbiAgICBhc3NlcnQudGhyb3dzKCgpID0+IHBhcnNlRXZhbFJldmlld0FyZ3MoXCJTMDEvLi5cIiksIEV2YWxSZXZpZXdBcmdFcnJvcik7XG4gIH0pO1xuXG4gIGl0KFwicmVqZWN0cyBiYWNrc2xhc2ggc2VwYXJhdG9ycyBpbiB0aGUgc2xpY2UgSURcIiwgKCkgPT4ge1xuICAgIGFzc2VydC50aHJvd3MoKCkgPT4gcGFyc2VFdmFsUmV2aWV3QXJncyhcIlMwMVxcXFwuLlxcXFwuLlxcXFxldGNcIiksIEV2YWxSZXZpZXdBcmdFcnJvcik7XG4gIH0pO1xuXG4gIGl0KFwicmVqZWN0cyBudWxsIGJ5dGVzIGluIHRoZSBzbGljZSBJRFwiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LnRocm93cygoKSA9PiBwYXJzZUV2YWxSZXZpZXdBcmdzKFwiUzAxXFwwXCIpLCBFdmFsUmV2aWV3QXJnRXJyb3IpO1xuICB9KTtcblxuICBpdChcInJlamVjdHMgdW5pY29kZSBsb29rLWFsaWtlcyAoQ3lyaWxsaWMgXHUwNDA1KVwiLCAoKSA9PiB7XG4gICAgLy8gVSswNDA1IChDeXJpbGxpYyBjYXBpdGFsIFMpIFx1MjI2MCBVKzAwNTMgKExhdGluIGNhcGl0YWwgUylcbiAgICBhc3NlcnQudGhyb3dzKCgpID0+IHBhcnNlRXZhbFJldmlld0FyZ3MoXCJcdTA0MDVcIiArIFwiMDFcIiksIEV2YWxSZXZpZXdBcmdFcnJvcik7XG4gIH0pO1xuXG4gIGl0KFwicmVqZWN0cyBsb3dlcmNhc2UgJ3MnIHByZWZpeFwiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LnRocm93cygoKSA9PiBwYXJzZUV2YWxSZXZpZXdBcmdzKFwiczAxXCIpLCBFdmFsUmV2aWV3QXJnRXJyb3IpO1xuICB9KTtcblxuICBpdChcInJlamVjdHMgSUQgd2l0aG91dCB0cmFpbGluZyBkaWdpdHNcIiwgKCkgPT4ge1xuICAgIGFzc2VydC50aHJvd3MoKCkgPT4gcGFyc2VFdmFsUmV2aWV3QXJncyhcIlNcIiksIEV2YWxSZXZpZXdBcmdFcnJvcik7XG4gICAgYXNzZXJ0LnRocm93cygoKSA9PiBwYXJzZUV2YWxSZXZpZXdBcmdzKFwiU2FiY1wiKSwgRXZhbFJldmlld0FyZ0Vycm9yKTtcbiAgfSk7XG5cbiAgaXQoXCJhY2NlcHRzIG11bHRpLWRpZ2l0IHNsaWNlIElEc1wiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKHBhcnNlRXZhbFJldmlld0FyZ3MoXCJTMTAwXCIpLnNsaWNlSWQsIFwiUzEwMFwiKTtcbiAgfSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNMSUNFX0lEX1BBVFRFUk4gZXhwb3J0IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcIlNMSUNFX0lEX1BBVFRFUk5cIiwgKCkgPT4ge1xuICBpdChcIm1hdGNoZXMgdGhlIGNhbm9uaWNhbCAvXlNcXFxcZCskLyBzaGFwZSB1c2VkIGVsc2V3aGVyZSBpbiB0aGUgZ3NkIGV4dGVuc2lvblwiLCAoKSA9PiB7XG4gICAgYXNzZXJ0Lm9rKFNMSUNFX0lEX1BBVFRFUk4udGVzdChcIlMwMVwiKSk7XG4gICAgYXNzZXJ0Lm9rKFNMSUNFX0lEX1BBVFRFUk4udGVzdChcIlM5OVwiKSk7XG4gICAgYXNzZXJ0Lm9rKCFTTElDRV9JRF9QQVRURVJOLnRlc3QoXCJzMDFcIikpO1xuICAgIGFzc2VydC5vayghU0xJQ0VfSURfUEFUVEVSTi50ZXN0KFwiU1wiKSk7XG4gICAgYXNzZXJ0Lm9rKCFTTElDRV9JRF9QQVRURVJOLnRlc3QoXCJTMDFhXCIpKTtcbiAgICBhc3NlcnQub2soIVNMSUNFX0lEX1BBVFRFUk4udGVzdChcIi4uL1MwMVwiKSk7XG4gIH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBkZXRlY3RFdmFsUmV2aWV3U3RhdGUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiZGV0ZWN0RXZhbFJldmlld1N0YXRlXCIsICgpID0+IHtcbiAgbGV0IGJhc2VQYXRoOiBzdHJpbmc7XG5cbiAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgYmFzZVBhdGggPSBqb2luKHRtcGRpcigpLCBgZ3NkLWV2YWwtcmV2aWV3LXRlc3QtJHtyYW5kb21VVUlEKCl9YCk7XG4gICAgbWtkaXJTeW5jKGJhc2VQYXRoLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgfSk7XG5cbiAgYWZ0ZXJFYWNoKCgpID0+IHtcbiAgICBfY2xlYXJHc2RSb290Q2FjaGUoKTtcbiAgICBybVN5bmMoYmFzZVBhdGgsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfSk7XG5cbiAgZnVuY3Rpb24gc2V0dXBTbGljZUxheW91dChzbGljZUZpbGVzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+KTogdm9pZCB7XG4gICAgY29uc3Qgc2xpY2VEaXIgPSBqb2luKGJhc2VQYXRoLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwN1wiKTtcbiAgICBta2RpclN5bmMoc2xpY2VEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIGZvciAoY29uc3QgW2ZpbGVuYW1lLCBjb250ZW50XSBvZiBPYmplY3QuZW50cmllcyhzbGljZUZpbGVzKSkge1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHNsaWNlRGlyLCBmaWxlbmFtZSksIGNvbnRlbnQsIFwidXRmLThcIik7XG4gICAgfVxuICB9XG5cbiAgaXQoXCJyZXR1cm5zIG5vLXNsaWNlLWRpciB3aGVuIHRoZSBzbGljZSBkaXJlY3RvcnkgaXMgbWlzc2luZyAocmVncmVzc2lvbjogbm8tc2xpY2UtZGlyIHZzIG5vLXN1bW1hcnkgbXVzdCBiZSBkaXN0aW5jdCBzdGF0ZXMpXCIsICgpID0+IHtcbiAgICBta2RpclN5bmMoam9pbihiYXNlUGF0aCwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIGNvbnN0IHJlc3VsdCA9IGRldGVjdEV2YWxSZXZpZXdTdGF0ZShcbiAgICAgIHsgc2xpY2VJZDogXCJTMDdcIiwgZm9yY2U6IGZhbHNlLCBzaG93OiBmYWxzZSB9LFxuICAgICAgYmFzZVBhdGgsXG4gICAgICBcIk0wMDFcIixcbiAgICApO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQua2luZCwgXCJuby1zbGljZS1kaXJcIik7XG4gICAgaWYgKHJlc3VsdC5raW5kID09PSBcIm5vLXNsaWNlLWRpclwiKSB7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnNsaWNlSWQsIFwiUzA3XCIpO1xuICAgICAgYXNzZXJ0Lm9rKHJlc3VsdC5leHBlY3RlZERpci5pbmNsdWRlcyhcIlMwN1wiKSk7XG4gICAgfVxuICB9KTtcblxuICBpdChcInJldHVybnMgbm8tc3VtbWFyeSB3aGVuIHRoZSBzbGljZSBkaXJlY3RvcnkgZXhpc3RzIGJ1dCBTVU1NQVJZLm1kIGlzIG1pc3NpbmdcIiwgKCkgPT4ge1xuICAgIHNldHVwU2xpY2VMYXlvdXQoe30pO1xuICAgIGNvbnN0IHJlc3VsdCA9IGRldGVjdEV2YWxSZXZpZXdTdGF0ZShcbiAgICAgIHsgc2xpY2VJZDogXCJTMDdcIiwgZm9yY2U6IGZhbHNlLCBzaG93OiBmYWxzZSB9LFxuICAgICAgYmFzZVBhdGgsXG4gICAgICBcIk0wMDFcIixcbiAgICApO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQua2luZCwgXCJuby1zdW1tYXJ5XCIpO1xuICB9KTtcblxuICBpdChcInJldHVybnMgbm8tc3VtbWFyeSB3aXRoIHNwZWNQYXRoIHBvcHVsYXRlZCB3aGVuIG9ubHkgQUktU1BFQy5tZCBpcyBwcmVzZW50XCIsICgpID0+IHtcbiAgICBzZXR1cFNsaWNlTGF5b3V0KHsgXCJTMDctQUktU1BFQy5tZFwiOiBcIiMgc3BlY1wiIH0pO1xuICAgIGNvbnN0IHJlc3VsdCA9IGRldGVjdEV2YWxSZXZpZXdTdGF0ZShcbiAgICAgIHsgc2xpY2VJZDogXCJTMDdcIiwgZm9yY2U6IGZhbHNlLCBzaG93OiBmYWxzZSB9LFxuICAgICAgYmFzZVBhdGgsXG4gICAgICBcIk0wMDFcIixcbiAgICApO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQua2luZCwgXCJuby1zdW1tYXJ5XCIpO1xuICAgIGlmIChyZXN1bHQua2luZCA9PT0gXCJuby1zdW1tYXJ5XCIpIHtcbiAgICAgIGFzc2VydC5vayhyZXN1bHQuc3BlY1BhdGg/LmVuZHNXaXRoKFwiUzA3LUFJLVNQRUMubWRcIikpO1xuICAgIH1cbiAgfSk7XG5cbiAgaXQoXCJyZXR1cm5zIHJlYWR5IHdoZW4gU1VNTUFSWS5tZCBpcyBwcmVzZW50LCB3aXRoIHNwZWNQYXRoIG51bGwgd2hlbiBBSS1TUEVDLm1kIGlzIGFic2VudFwiLCAoKSA9PiB7XG4gICAgc2V0dXBTbGljZUxheW91dCh7IFwiUzA3LVNVTU1BUlkubWRcIjogXCIjIHN1bW1hcnlcIiB9KTtcbiAgICBjb25zdCByZXN1bHQgPSBkZXRlY3RFdmFsUmV2aWV3U3RhdGUoXG4gICAgICB7IHNsaWNlSWQ6IFwiUzA3XCIsIGZvcmNlOiBmYWxzZSwgc2hvdzogZmFsc2UgfSxcbiAgICAgIGJhc2VQYXRoLFxuICAgICAgXCJNMDAxXCIsXG4gICAgKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmtpbmQsIFwicmVhZHlcIik7XG4gICAgaWYgKHJlc3VsdC5raW5kID09PSBcInJlYWR5XCIpIHtcbiAgICAgIGFzc2VydC5vayhyZXN1bHQuc3VtbWFyeVBhdGguZW5kc1dpdGgoXCJTMDctU1VNTUFSWS5tZFwiKSk7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnNwZWNQYXRoLCBudWxsKTtcbiAgICB9XG4gIH0pO1xuXG4gIGl0KFwicmV0dXJucyByZWFkeSB3aXRoIGJvdGggcGF0aHMgcG9wdWxhdGVkIHdoZW4gYm90aCBmaWxlcyBleGlzdFwiLCAoKSA9PiB7XG4gICAgc2V0dXBTbGljZUxheW91dCh7XG4gICAgICBcIlMwNy1TVU1NQVJZLm1kXCI6IFwiIyBzdW1tYXJ5XCIsXG4gICAgICBcIlMwNy1BSS1TUEVDLm1kXCI6IFwiIyBzcGVjXCIsXG4gICAgfSk7XG4gICAgY29uc3QgcmVzdWx0ID0gZGV0ZWN0RXZhbFJldmlld1N0YXRlKFxuICAgICAgeyBzbGljZUlkOiBcIlMwN1wiLCBmb3JjZTogZmFsc2UsIHNob3c6IGZhbHNlIH0sXG4gICAgICBiYXNlUGF0aCxcbiAgICAgIFwiTTAwMVwiLFxuICAgICk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5raW5kLCBcInJlYWR5XCIpO1xuICAgIGlmIChyZXN1bHQua2luZCA9PT0gXCJyZWFkeVwiKSB7XG4gICAgICBhc3NlcnQub2socmVzdWx0LnN1bW1hcnlQYXRoLmVuZHNXaXRoKFwiUzA3LVNVTU1BUlkubWRcIikpO1xuICAgICAgYXNzZXJ0Lm9rKHJlc3VsdC5zcGVjUGF0aD8uZW5kc1dpdGgoXCJTMDctQUktU1BFQy5tZFwiKSk7XG4gICAgfVxuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgYnVpbGRFdmFsUmV2aWV3Q29udGV4dCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJidWlsZEV2YWxSZXZpZXdDb250ZXh0XCIsICgpID0+IHtcbiAgbGV0IGJhc2VQYXRoOiBzdHJpbmc7XG4gIGxldCBzbGljZURpcjogc3RyaW5nO1xuXG4gIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgIGJhc2VQYXRoID0gam9pbih0bXBkaXIoKSwgYGdzZC1ldmFsLWN0eC10ZXN0LSR7cmFuZG9tVVVJRCgpfWApO1xuICAgIHNsaWNlRGlyID0gam9pbihiYXNlUGF0aCwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDdcIik7XG4gICAgbWtkaXJTeW5jKHNsaWNlRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBwcm9jZXNzLmNoZGlyKGJhc2VQYXRoKTtcbiAgfSk7XG5cbiAgYWZ0ZXJFYWNoKCgpID0+IHtcbiAgICBfY2xlYXJHc2RSb290Q2FjaGUoKTtcbiAgICBwcm9jZXNzLmNoZGlyKHRtcGRpcigpKTtcbiAgICBybVN5bmMoYmFzZVBhdGgsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfSk7XG5cbiAgZnVuY3Rpb24gZmFrZVJlYWR5KG9wdHM6IHtcbiAgICBzdW1tYXJ5Qnl0ZXM/OiBudW1iZXI7XG4gICAgc3BlY0J5dGVzPzogbnVtYmVyIHwgbnVsbDtcbiAgfSA9IHt9KTogRXh0cmFjdDxFdmFsUmV2aWV3U3RhdGUsIHsga2luZDogXCJyZWFkeVwiIH0+IHtcbiAgICBjb25zdCBzdW1tYXJ5UGF0aCA9IGpvaW4oc2xpY2VEaXIsIFwiUzA3LVNVTU1BUlkubWRcIik7XG4gICAgd3JpdGVGaWxlU3luYyhzdW1tYXJ5UGF0aCwgXCJTXCIucmVwZWF0KG9wdHMuc3VtbWFyeUJ5dGVzID8/IDUxMiksIFwidXRmLThcIik7XG5cbiAgICBsZXQgc3BlY1BhdGg6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgIGlmIChvcHRzLnNwZWNCeXRlcyAhPSBudWxsKSB7XG4gICAgICBzcGVjUGF0aCA9IGpvaW4oc2xpY2VEaXIsIFwiUzA3LUFJLVNQRUMubWRcIik7XG4gICAgICB3cml0ZUZpbGVTeW5jKHNwZWNQYXRoLCBcIlBcIi5yZXBlYXQob3B0cy5zcGVjQnl0ZXMpLCBcInV0Zi04XCIpO1xuICAgIH1cblxuICAgIHJldHVybiB7XG4gICAgICBraW5kOiBcInJlYWR5XCIsXG4gICAgICBzbGljZUlkOiBcIlMwN1wiLFxuICAgICAgc2xpY2VEaXIsXG4gICAgICBzdW1tYXJ5UGF0aCxcbiAgICAgIHNwZWNQYXRoLFxuICAgIH07XG4gIH1cblxuICBpdChcImlubGluZXMgU1VNTUFSWSB3aXRob3V0IHRydW5jYXRpb24gd2hlbiB1bmRlciB0aGUgY2FwXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBzdGF0ZSA9IGZha2VSZWFkeSh7IHN1bW1hcnlCeXRlczogMTAyNCB9KTtcbiAgICBjb25zdCBjdHggPSBhd2FpdCBidWlsZEV2YWxSZXZpZXdDb250ZXh0KHN0YXRlLCBcIk0wMDFcIiwgKCkgPT4gbmV3IERhdGUoXCIyMDI2LTA0LTI4VDE0OjAwOjAwWlwiKSk7XG4gICAgYXNzZXJ0LmVxdWFsKGN0eC50cnVuY2F0ZWQsIGZhbHNlKTtcbiAgICBhc3NlcnQuZXF1YWwoY3R4LnN1bW1hcnkubGVuZ3RoLCAxMDI0KTtcbiAgICBhc3NlcnQuZXF1YWwoY3R4LnNwZWMsIG51bGwpO1xuICAgIGFzc2VydC5lcXVhbChjdHguZ2VuZXJhdGVkQXQsIFwiMjAyNi0wNC0yOFQxNDowMDowMFpcIik7XG4gIH0pO1xuXG4gIGl0KFwidHJ1bmNhdGVzIFNVTU1BUlkgd2hlbiBpdCBhbG9uZSBleGNlZWRzIHRoZSBjYXAgKHJlZ3Jlc3Npb246IHByb21wdC1zaXplIGNhcClcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHN0YXRlID0gZmFrZVJlYWR5KHsgc3VtbWFyeUJ5dGVzOiBNQVhfQ09OVEVYVF9CWVRFUyArIDQwOTYgfSk7XG4gICAgY29uc3QgY3R4ID0gYXdhaXQgYnVpbGRFdmFsUmV2aWV3Q29udGV4dChzdGF0ZSwgXCJNMDAxXCIpO1xuICAgIGFzc2VydC5lcXVhbChjdHgudHJ1bmNhdGVkLCB0cnVlKTtcbiAgICBhc3NlcnQub2soY3R4LnN1bW1hcnkuaW5jbHVkZXMoXCJbdHJ1bmNhdGVkOlwiKSk7XG4gICAgYXNzZXJ0LmVxdWFsKGN0eC5zcGVjLCBudWxsLCBcIm5vIGJ1ZGdldCBmb3Igc3BlYyB3aGVuIHN1bW1hcnkgYWxvbmUgZXhjZWVkcyBjYXBcIik7XG4gIH0pO1xuXG4gIGl0KFwiaW5saW5lcyBib3RoIFNVTU1BUlkgYW5kIFNQRUMgd2hlbiB0aGVpciBjb21iaW5lZCBieXRlcyBmaXRcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHN0YXRlID0gZmFrZVJlYWR5KHsgc3VtbWFyeUJ5dGVzOiAxMDI0LCBzcGVjQnl0ZXM6IDIwNDggfSk7XG4gICAgY29uc3QgY3R4ID0gYXdhaXQgYnVpbGRFdmFsUmV2aWV3Q29udGV4dChzdGF0ZSwgXCJNMDAxXCIpO1xuICAgIGFzc2VydC5lcXVhbChjdHgudHJ1bmNhdGVkLCBmYWxzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKGN0eC5zdW1tYXJ5Lmxlbmd0aCwgMTAyNCk7XG4gICAgYXNzZXJ0LmVxdWFsKGN0eC5zcGVjPy5sZW5ndGgsIDIwNDgpO1xuICB9KTtcblxuICBpdChcInRydW5jYXRlcyBTUEVDIHRvIHRoZSByZXNpZHVhbCBidWRnZXQgd2hlbiBTVU1NQVJZIGlzIGxhcmdlXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBzdW1tYXJ5Qnl0ZXMgPSBNQVhfQ09OVEVYVF9CWVRFUyAtIDEwMjQ7XG4gICAgY29uc3Qgc3BlY0J5dGVzID0gOCAqIDEwMjQ7XG4gICAgY29uc3Qgc3RhdGUgPSBmYWtlUmVhZHkoeyBzdW1tYXJ5Qnl0ZXMsIHNwZWNCeXRlcyB9KTtcbiAgICBjb25zdCBjdHggPSBhd2FpdCBidWlsZEV2YWxSZXZpZXdDb250ZXh0KHN0YXRlLCBcIk0wMDFcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGN0eC50cnVuY2F0ZWQsIHRydWUpO1xuICAgIGFzc2VydC5vayhjdHguc3BlYz8uaW5jbHVkZXMoXCJbdHJ1bmNhdGVkOlwiKSk7XG4gIH0pO1xuXG4gIGl0KFwicmV0dXJucyBzcGVjPW51bGwgd2hlbiBubyBBSS1TUEVDLm1kIGV4aXN0cyAoYmVzdC1wcmFjdGljZXMgYXVkaXQgbW9kZSlcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHN0YXRlID0gZmFrZVJlYWR5KHsgc3VtbWFyeUJ5dGVzOiAyNTYgfSk7XG4gICAgY29uc3QgY3R4ID0gYXdhaXQgYnVpbGRFdmFsUmV2aWV3Q29udGV4dChzdGF0ZSwgXCJNMDAxXCIpO1xuICAgIGFzc2VydC5lcXVhbChjdHguc3BlYywgbnVsbCk7XG4gIH0pO1xuXG4gIGl0KFwiZW1pdHMgYSBzcGVjLWVsaXNpb24gbWFya2VyIHdoZW4gU1VNTUFSWSBjb25zdW1lZCB0aGUgZW50aXJlIGJ5dGUgYnVkZ2V0XCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBzdGF0ZSA9IGZha2VSZWFkeSh7IHN1bW1hcnlCeXRlczogTUFYX0NPTlRFWFRfQllURVMsIHNwZWNCeXRlczogMTAyNCB9KTtcbiAgICBjb25zdCBjdHggPSBhd2FpdCBidWlsZEV2YWxSZXZpZXdDb250ZXh0KHN0YXRlLCBcIk0wMDFcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGN0eC50cnVuY2F0ZWQsIHRydWUpO1xuICAgIGFzc2VydC5vayhjdHguc3BlYz8uaW5jbHVkZXMoXCJbdHJ1bmNhdGVkOlwiKSk7XG4gICAgYXNzZXJ0Lm9rKGN0eC5zcGVjPy50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKFwiYWktc3BlY1wiKSk7XG4gIH0pO1xuXG4gIGl0KFwiZGVncmFkZXMgdG8gYSBtYXJrZXIgKG5vdCBhIHRocm93KSB3aGVuIEFJLVNQRUMubWQgcmVhZCBmYWlscyBcdTIwMTQgc3BlYyBpcyBvcHRpb25hbFwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3Qgc3RhdGUgPSBmYWtlUmVhZHkoeyBzdW1tYXJ5Qnl0ZXM6IDUxMiwgc3BlY0J5dGVzOiAyNTYgfSk7XG4gICAgcm1TeW5jKHN0YXRlLnNwZWNQYXRoISk7XG4gICAgY29uc3QgY3R4ID0gYXdhaXQgYnVpbGRFdmFsUmV2aWV3Q29udGV4dChzdGF0ZSwgXCJNMDAxXCIpO1xuICAgIGFzc2VydC5lcXVhbChjdHgudHJ1bmNhdGVkLCB0cnVlKTtcbiAgICBhc3NlcnQub2soY3R4LnNwZWM/LmluY2x1ZGVzKFwiW3RydW5jYXRlZDpcIikpO1xuICAgIGFzc2VydC5vayhjdHguc3BlYz8udG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhcImZhaWxlZCB0byByZWFkXCIpKTtcbiAgfSk7XG5cbiAgaXQoXCJkb2VzIG5vdCBlbWl0IGEgVStGRkZEIHJlcGxhY2VtZW50IGNoYXJhY3RlciB3aGVuIHRoZSBjYXAgZmFsbHMgbWlkIG11bHRpLWJ5dGUgVVRGLTggc2VxdWVuY2VcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHBhdGggPSBqb2luKHNsaWNlRGlyLCBcIlMwNy1TVU1NQVJZLm1kXCIpO1xuICAgIGNvbnN0IGZpbGxlciA9IFwieFwiLnJlcGVhdChNQVhfQ09OVEVYVF9CWVRFUyAtIDEpO1xuICAgIGNvbnN0IGZvdXJCeXRlQ29kZXBvaW50ID0gXCJcXHV7MUY2MDB9XCI7XG4gICAgd3JpdGVGaWxlU3luYyhwYXRoLCBmaWxsZXIgKyBmb3VyQnl0ZUNvZGVwb2ludCwgXCJ1dGYtOFwiKTtcbiAgICBjb25zdCBzdGF0ZTogRXh0cmFjdDxFdmFsUmV2aWV3U3RhdGUsIHsga2luZDogXCJyZWFkeVwiIH0+ID0ge1xuICAgICAga2luZDogXCJyZWFkeVwiLFxuICAgICAgc2xpY2VJZDogXCJTMDdcIixcbiAgICAgIHNsaWNlRGlyLFxuICAgICAgc3VtbWFyeVBhdGg6IHBhdGgsXG4gICAgICBzcGVjUGF0aDogbnVsbCxcbiAgICB9O1xuICAgIGNvbnN0IGN0eCA9IGF3YWl0IGJ1aWxkRXZhbFJldmlld0NvbnRleHQoc3RhdGUsIFwiTTAwMVwiKTtcbiAgICBhc3NlcnQuZXF1YWwoY3R4LnRydW5jYXRlZCwgdHJ1ZSk7XG4gICAgYXNzZXJ0Lm9rKCFjdHguc3VtbWFyeS5pbmNsdWRlcyhcIlxcdXtGRkZEfVwiKSwgXCJtdXN0IG5vdCBjb250YWluIHJlcGxhY2VtZW50IGNoYXIgYXQgdGhlIHRydW5jYXRpb24gYm91bmRhcnlcIik7XG4gIH0pO1xuXG4gIGl0KFwia2VlcHMgdG90YWwgc3VtbWFyeStzcGVjIGJ5dGUgbGVuZ3RoIHdpdGhpbiBNQVhfQ09OVEVYVF9CWVRFUyB1bmRlciB0cnVuY2F0aW9uXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBzdW1tYXJ5UGF0aCA9IGpvaW4oc2xpY2VEaXIsIFwiUzA3LVNVTU1BUlkubWRcIik7XG4gICAgY29uc3Qgc3BlY1BhdGggPSBqb2luKHNsaWNlRGlyLCBcIlMwNy1BSS1TUEVDLm1kXCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoc3VtbWFyeVBhdGgsIFwiU1wiLnJlcGVhdChNQVhfQ09OVEVYVF9CWVRFUyAqIDIpLCBcInV0Zi04XCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoc3BlY1BhdGgsIFwiUFwiLnJlcGVhdChNQVhfQ09OVEVYVF9CWVRFUyAqIDIpLCBcInV0Zi04XCIpO1xuICAgIGNvbnN0IHN0YXRlOiBFeHRyYWN0PEV2YWxSZXZpZXdTdGF0ZSwgeyBraW5kOiBcInJlYWR5XCIgfT4gPSB7XG4gICAgICBraW5kOiBcInJlYWR5XCIsXG4gICAgICBzbGljZUlkOiBcIlMwN1wiLFxuICAgICAgc2xpY2VEaXIsXG4gICAgICBzdW1tYXJ5UGF0aCxcbiAgICAgIHNwZWNQYXRoLFxuICAgIH07XG4gICAgY29uc3QgY3R4ID0gYXdhaXQgYnVpbGRFdmFsUmV2aWV3Q29udGV4dChzdGF0ZSwgXCJNMDAxXCIpO1xuICAgIGNvbnN0IHN1bW1hcnlCeXRlcyA9IEJ1ZmZlci5ieXRlTGVuZ3RoKGN0eC5zdW1tYXJ5LCBcInV0Zi04XCIpO1xuICAgIGNvbnN0IHNwZWNCeXRlcyA9IGN0eC5zcGVjID8gQnVmZmVyLmJ5dGVMZW5ndGgoY3R4LnNwZWMsIFwidXRmLThcIikgOiAwO1xuICAgIGFzc2VydC5vayhcbiAgICAgIHN1bW1hcnlCeXRlcyArIHNwZWNCeXRlcyA8PSBNQVhfQ09OVEVYVF9CWVRFUyxcbiAgICAgIGB0b3RhbCAke3N1bW1hcnlCeXRlcyArIHNwZWNCeXRlc30gbXVzdCBub3QgZXhjZWVkIGNhcCAke01BWF9DT05URVhUX0JZVEVTfWAsXG4gICAgKTtcbiAgICBhc3NlcnQub2soY3R4LnN1bW1hcnkuaW5jbHVkZXMoXCJbdHJ1bmNhdGVkOlwiKSk7XG4gIH0pO1xuXG4gIGl0KFwia2VlcHMgc2luZ2xlLWZpbGUgdHJ1bmNhdGlvbiB3aXRoaW4gbWF4Qnl0ZXMgKHJlZ3Jlc3Npb246IG1hcmtlciBieXRlcyBjb3VudCB0b3dhcmQgY2FwKVwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3Qgc3VtbWFyeVBhdGggPSBqb2luKHNsaWNlRGlyLCBcIlMwNy1TVU1NQVJZLm1kXCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoc3VtbWFyeVBhdGgsIFwiU1wiLnJlcGVhdChNQVhfQ09OVEVYVF9CWVRFUyAqIDIpLCBcInV0Zi04XCIpO1xuICAgIGNvbnN0IHN0YXRlOiBFeHRyYWN0PEV2YWxSZXZpZXdTdGF0ZSwgeyBraW5kOiBcInJlYWR5XCIgfT4gPSB7XG4gICAgICBraW5kOiBcInJlYWR5XCIsXG4gICAgICBzbGljZUlkOiBcIlMwN1wiLFxuICAgICAgc2xpY2VEaXIsXG4gICAgICBzdW1tYXJ5UGF0aCxcbiAgICAgIHNwZWNQYXRoOiBudWxsLFxuICAgIH07XG4gICAgY29uc3QgY3R4ID0gYXdhaXQgYnVpbGRFdmFsUmV2aWV3Q29udGV4dChzdGF0ZSwgXCJNMDAxXCIpO1xuICAgIGFzc2VydC5lcXVhbChjdHgudHJ1bmNhdGVkLCB0cnVlKTtcbiAgICBjb25zdCB0b3RhbEJ5dGVzID0gQnVmZmVyLmJ5dGVMZW5ndGgoY3R4LnN1bW1hcnksIFwidXRmLThcIik7XG4gICAgYXNzZXJ0Lm9rKHRvdGFsQnl0ZXMgPD0gTUFYX0NPTlRFWFRfQllURVMsIGAke3RvdGFsQnl0ZXN9ID4gJHtNQVhfQ09OVEVYVF9CWVRFU31gKTtcbiAgICBhc3NlcnQub2soY3R4LnN1bW1hcnkuaW5jbHVkZXMoXCJbdHJ1bmNhdGVkOlwiKSk7XG4gIH0pO1xuXG4gIGl0KFwicG9wdWxhdGVzIG91dHB1dFBhdGggdXNpbmcgdGhlIGNhbm9uaWNhbCBzbGljZSBmaWxlIG5hbWluZ1wiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3Qgc3RhdGUgPSBmYWtlUmVhZHkoeyBzdW1tYXJ5Qnl0ZXM6IDY0IH0pO1xuICAgIGNvbnN0IGN0eCA9IGF3YWl0IGJ1aWxkRXZhbFJldmlld0NvbnRleHQoc3RhdGUsIFwiTTAwMVwiKTtcbiAgICBhc3NlcnQub2soY3R4Lm91dHB1dFBhdGguZW5kc1dpdGgoXCJTMDctRVZBTC1SRVZJRVcubWRcIikpO1xuICB9KTtcblxuICBpdChcImVtaXRzIHRoZSBzaG9ydCBmYWxsYmFjayBtYXJrZXIgd2hlbiBBSS1TUEVDIHJlYWQgZmFpbHMgd2l0aCBhIHZlcmJvc2UgZXJyb3JcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHN0YXRlID0gZmFrZVJlYWR5KHsgc3VtbWFyeUJ5dGVzOiBNQVhfQ09OVEVYVF9CWVRFUyAtIDgwLCBzcGVjQnl0ZXM6IDI1NiB9KTtcbiAgICBybVN5bmMoc3RhdGUuc3BlY1BhdGghKTtcbiAgICBjb25zdCBjdHggPSBhd2FpdCBidWlsZEV2YWxSZXZpZXdDb250ZXh0KHN0YXRlLCBcIk0wMDFcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGN0eC50cnVuY2F0ZWQsIHRydWUpO1xuICAgIGFzc2VydC5vayhjdHguc3BlYywgXCJzcGVjIG11c3Qgc3VyZmFjZSBhcyBhIG1hcmtlciwgbm90IG51bGxcIik7XG4gICAgYXNzZXJ0Lm9rKGN0eC5zcGVjIS5pbmNsdWRlcyhcIlt0cnVuY2F0ZWQ6XCIpKTtcbiAgICBhc3NlcnQub2soQnVmZmVyLmJ5dGVMZW5ndGgoY3R4LnN1bW1hcnksIFwidXRmLThcIikgKyBCdWZmZXIuYnl0ZUxlbmd0aChjdHguc3BlYyEsIFwidXRmLThcIikgPD0gTUFYX0NPTlRFWFRfQllURVMpO1xuICB9KTtcblxuICBpdChcImRvZXMgbm90IGxvYWQgdGhlIGZ1bGwgZmlsZSBpbnRvIG1lbW9yeSBiZXlvbmQgdGhlIGNhcCAocmVncmVzc2lvbjogc3RyZWFtaW5nIHJlYWRDYXBwZWQpXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBzdW1tYXJ5UGF0aCA9IGpvaW4oc2xpY2VEaXIsIFwiUzA3LVNVTU1BUlkubWRcIik7XG4gICAgY29uc3QgZ2lhbnQgPSBNQVhfQ09OVEVYVF9CWVRFUyAqIDg7XG4gICAgd3JpdGVGaWxlU3luYyhzdW1tYXJ5UGF0aCwgXCJTXCIucmVwZWF0KGdpYW50KSwgXCJ1dGYtOFwiKTtcbiAgICBjb25zdCBzdGF0ZTogRXh0cmFjdDxFdmFsUmV2aWV3U3RhdGUsIHsga2luZDogXCJyZWFkeVwiIH0+ID0ge1xuICAgICAga2luZDogXCJyZWFkeVwiLFxuICAgICAgc2xpY2VJZDogXCJTMDdcIixcbiAgICAgIHNsaWNlRGlyLFxuICAgICAgc3VtbWFyeVBhdGgsXG4gICAgICBzcGVjUGF0aDogbnVsbCxcbiAgICB9O1xuICAgIGNvbnN0IGN0eCA9IGF3YWl0IGJ1aWxkRXZhbFJldmlld0NvbnRleHQoc3RhdGUsIFwiTTAwMVwiKTtcbiAgICBhc3NlcnQuZXF1YWwoY3R4LnRydW5jYXRlZCwgdHJ1ZSk7XG4gICAgYXNzZXJ0Lm9rKEJ1ZmZlci5ieXRlTGVuZ3RoKGN0eC5zdW1tYXJ5LCBcInV0Zi04XCIpIDw9IE1BWF9DT05URVhUX0JZVEVTKTtcbiAgICBhc3NlcnQub2soY3R4LnN1bW1hcnkuaW5jbHVkZXMoXCJieXRlcyBlbGlkZWQgdG8gZml0IGV2YWwtcmV2aWV3IGNvbnRleHQgY2FwXCIpKTtcbiAgfSk7XG5cbiAgaXQoXCJkb2VzIG5vdCBwcmUtcmVzZXJ2ZSBzcGVjIGJ1ZGdldCB3aGVuIG5vIEFJLVNQRUMubWQgZXhpc3RzXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBzdW1tYXJ5Qnl0ZXMgPSBNQVhfQ09OVEVYVF9CWVRFUyAtIDY0O1xuICAgIGNvbnN0IHN0YXRlID0gZmFrZVJlYWR5KHsgc3VtbWFyeUJ5dGVzIH0pO1xuICAgIGNvbnN0IGN0eCA9IGF3YWl0IGJ1aWxkRXZhbFJldmlld0NvbnRleHQoc3RhdGUsIFwiTTAwMVwiKTtcbiAgICBhc3NlcnQuZXF1YWwoY3R4LnRydW5jYXRlZCwgZmFsc2UsIFwic3VtbWFyeSBtdXN0IGZpdCB3aXRob3V0IHRydW5jYXRpb24gd2hlbiBubyBzcGVjIGlzIHJlc2VydmVkXCIpO1xuICAgIGFzc2VydC5lcXVhbChCdWZmZXIuYnl0ZUxlbmd0aChjdHguc3VtbWFyeSwgXCJ1dGYtOFwiKSwgc3VtbWFyeUJ5dGVzKTtcbiAgICBhc3NlcnQuZXF1YWwoY3R4LnNwZWMsIG51bGwpO1xuICB9KTtcblxuICBpdChcImluY2x1ZGVzIGEgc21hbGwgQUktU1BFQyBldmVuIHdoZW4gcmVtYWluaW5nIGlzIGJlbG93IE1JTl9VU0VGVUxfU1BFQ19CWVRFU1wiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3Qgc3VtbWFyeUJ5dGVzID0gTUFYX0NPTlRFWFRfQllURVMgLSAyMDA7XG4gICAgY29uc3Qgc3BlY0J5dGVzID0gMTAwO1xuICAgIGNvbnN0IHN0YXRlID0gZmFrZVJlYWR5KHsgc3VtbWFyeUJ5dGVzLCBzcGVjQnl0ZXMgfSk7XG4gICAgY29uc3QgY3R4ID0gYXdhaXQgYnVpbGRFdmFsUmV2aWV3Q29udGV4dChzdGF0ZSwgXCJNMDAxXCIpO1xuICAgIGFzc2VydC5vayhjdHguc3BlYywgXCJzcGVjIG11c3QgYmUgaW5saW5lZCB3aGVuIGl0IGFjdHVhbGx5IGZpdHNcIik7XG4gICAgYXNzZXJ0LmVxdWFsKEJ1ZmZlci5ieXRlTGVuZ3RoKGN0eC5zcGVjISwgXCJ1dGYtOFwiKSwgc3BlY0J5dGVzKTtcbiAgICBhc3NlcnQub2soIWN0eC5zcGVjIS5pbmNsdWRlcyhcIlt0cnVuY2F0ZWQ6XCIpLCBcInNtYWxsIHNwZWMgbXVzdCBub3QgYmUgcmVwbGFjZWQgYnkgYSBtYXJrZXJcIik7XG4gIH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBldmFsUmV2aWV3V3JpdGVQYXRoIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcImV2YWxSZXZpZXdXcml0ZVBhdGhcIiwgKCkgPT4ge1xuICBpdChcImNvbXB1dGVzIHRoZSBjYW5vbmljYWwgd3JpdGUgcGF0aCBwdXJlbHkgZnJvbSBpbnB1dHNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHNsaWNlRGlyID0gam9pbihcIi9yZXBvXCIsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzA3XCIpO1xuICAgIGNvbnN0IGV4cGVjdGVkID0gam9pbihzbGljZURpciwgXCJTMDctRVZBTC1SRVZJRVcubWRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGV2YWxSZXZpZXdXcml0ZVBhdGgoc2xpY2VEaXIsIFwiUzA3XCIpLCBleHBlY3RlZCk7XG4gIH0pO1xuXG4gIGl0KFwiZG9lcyBub3QgdG91Y2ggdGhlIGZpbGVzeXN0ZW1cIiwgKCkgPT4ge1xuICAgIGNvbnN0IHNsaWNlRGlyID0gam9pbihcIi9ub25leGlzdGVudFwiLCBcInBhdGhcIiwgXCJhYmNcIik7XG4gICAgY29uc3QgcmVzdWx0ID0gZXZhbFJldmlld1dyaXRlUGF0aChzbGljZURpciwgXCJTOTlcIik7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5lbmRzV2l0aChcIlM5OS1FVkFMLVJFVklFVy5tZFwiKSk7XG4gIH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBmaW5kRXZhbFJldmlld0ZpbGUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiZmluZEV2YWxSZXZpZXdGaWxlXCIsICgpID0+IHtcbiAgbGV0IGJhc2VQYXRoOiBzdHJpbmc7XG5cbiAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgYmFzZVBhdGggPSBqb2luKHRtcGRpcigpLCBgZ3NkLWZpbmQtZXZhbC0ke3JhbmRvbVVVSUQoKX1gKTtcbiAgICBta2RpclN5bmMoam9pbihiYXNlUGF0aCwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDdcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB9KTtcblxuICBhZnRlckVhY2goKCkgPT4ge1xuICAgIF9jbGVhckdzZFJvb3RDYWNoZSgpO1xuICAgIHJtU3luYyhiYXNlUGF0aCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcblxuICBpdChcInJldHVybnMgbnVsbCB3aGVuIEVWQUwtUkVWSUVXLm1kIGlzIGFic2VudFwiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKGZpbmRFdmFsUmV2aWV3RmlsZShiYXNlUGF0aCwgXCJNMDAxXCIsIFwiUzA3XCIpLCBudWxsKTtcbiAgfSk7XG5cbiAgaXQoXCJyZXR1cm5zIHRoZSBhYnNvbHV0ZSBwYXRoIHdoZW4gRVZBTC1SRVZJRVcubWQgaXMgcHJlc2VudFwiLCAoKSA9PiB7XG4gICAgY29uc3QgdGFyZ2V0ID0gam9pbihiYXNlUGF0aCwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDdcIiwgXCJTMDctRVZBTC1SRVZJRVcubWRcIik7XG4gICAgd3JpdGVGaWxlU3luYyh0YXJnZXQsIFwiLS0tXFxuc2NoZW1hOiBldmFsLXJldmlldy92MVxcbi0tLVxcblwiLCBcInV0Zi04XCIpO1xuICAgIGNvbnN0IGZvdW5kID0gZmluZEV2YWxSZXZpZXdGaWxlKGJhc2VQYXRoLCBcIk0wMDFcIiwgXCJTMDdcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGZvdW5kLCByZWFscGF0aFN5bmModGFyZ2V0KSk7XG4gIH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBwbGFuRXZhbFJldmlld0FjdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJwbGFuRXZhbFJldmlld0FjdGlvblwiLCAoKSA9PiB7XG4gIGZ1bmN0aW9uIGFyZ3Mob3ZlcnJpZGVzOiBQYXJ0aWFsPEV2YWxSZXZpZXdBcmdzPiA9IHt9KTogRXZhbFJldmlld0FyZ3Mge1xuICAgIHJldHVybiB7IHNsaWNlSWQ6IFwiUzA3XCIsIGZvcmNlOiBmYWxzZSwgc2hvdzogZmFsc2UsIC4uLm92ZXJyaWRlcyB9O1xuICB9XG4gIGNvbnN0IG5vU2xpY2VEaXI6IEV2YWxSZXZpZXdTdGF0ZSA9IHsga2luZDogXCJuby1zbGljZS1kaXJcIiwgc2xpY2VJZDogXCJTMDdcIiwgZXhwZWN0ZWREaXI6IFwiL3RtcC94XCIgfTtcbiAgY29uc3Qgbm9TdW1tYXJ5OiBFdmFsUmV2aWV3U3RhdGUgPSB7IGtpbmQ6IFwibm8tc3VtbWFyeVwiLCBzbGljZUlkOiBcIlMwN1wiLCBzbGljZURpcjogXCIvdG1wL3hcIiwgc3BlY1BhdGg6IG51bGwgfTtcbiAgY29uc3QgcmVhZHk6IEV2YWxSZXZpZXdTdGF0ZSA9IHsga2luZDogXCJyZWFkeVwiLCBzbGljZUlkOiBcIlMwN1wiLCBzbGljZURpcjogXCIvdG1wL3hcIiwgc3VtbWFyeVBhdGg6IFwiL3RtcC94L1NVTU1BUlkubWRcIiwgc3BlY1BhdGg6IG51bGwgfTtcblxuICBpdChcInJldHVybnMgbm8tc2xpY2UtZGlyIGJlZm9yZSBjaGVja2luZyBzaG93IG9yIGFueXRoaW5nIGVsc2VcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChwbGFuRXZhbFJldmlld0FjdGlvbihhcmdzKHsgc2hvdzogdHJ1ZSB9KSwgbm9TbGljZURpciwgXCIvdG1wL3IubWRcIikua2luZCwgXCJuby1zbGljZS1kaXJcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHBsYW5FdmFsUmV2aWV3QWN0aW9uKGFyZ3MoeyBmb3JjZTogdHJ1ZSB9KSwgbm9TbGljZURpciwgbnVsbCkua2luZCwgXCJuby1zbGljZS1kaXJcIik7XG4gIH0pO1xuXG4gIGl0KFwicmV0dXJucyBzaG93IHdpdGggdGhlIGV4aXN0aW5nIHBhdGggd2hlbiAtLXNob3cgaXMgc2V0LCBldmVuIGlmIFNVTU1BUlkgaXMgbWlzc2luZyAocmVncmVzc2lvbjogLS1zaG93IG11c3QgYnlwYXNzIG5vLXN1bW1hcnkpXCIsICgpID0+IHtcbiAgICBjb25zdCBhY3Rpb24gPSBwbGFuRXZhbFJldmlld0FjdGlvbihhcmdzKHsgc2hvdzogdHJ1ZSB9KSwgbm9TdW1tYXJ5LCBcIi90bXAvci5tZFwiKTtcbiAgICBhc3NlcnQuZXF1YWwoYWN0aW9uLmtpbmQsIFwic2hvd1wiKTtcbiAgICBpZiAoYWN0aW9uLmtpbmQgPT09IFwic2hvd1wiKSBhc3NlcnQuZXF1YWwoYWN0aW9uLnBhdGgsIFwiL3RtcC9yLm1kXCIpO1xuICB9KTtcblxuICBpdChcInJldHVybnMgc2hvdyB3aXRoIG51bGwgcGF0aCB3aGVuIC0tc2hvdyBpcyBzZXQgYW5kIG5vIEVWQUwtUkVWSUVXLm1kIGV4aXN0c1wiLCAoKSA9PiB7XG4gICAgY29uc3QgYWN0aW9uID0gcGxhbkV2YWxSZXZpZXdBY3Rpb24oYXJncyh7IHNob3c6IHRydWUgfSksIG5vU3VtbWFyeSwgbnVsbCk7XG4gICAgYXNzZXJ0LmVxdWFsKGFjdGlvbi5raW5kLCBcInNob3dcIik7XG4gICAgaWYgKGFjdGlvbi5raW5kID09PSBcInNob3dcIikgYXNzZXJ0LmVxdWFsKGFjdGlvbi5wYXRoLCBudWxsKTtcbiAgfSk7XG5cbiAgaXQoXCJyZXR1cm5zIG5vLXN1bW1hcnkgd2hlbiBTVU1NQVJZIG1pc3NpbmcgYW5kIC0tc2hvdyBpcyBOT1Qgc2V0XCIsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwocGxhbkV2YWxSZXZpZXdBY3Rpb24oYXJncygpLCBub1N1bW1hcnksIG51bGwpLmtpbmQsIFwibm8tc3VtbWFyeVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocGxhbkV2YWxSZXZpZXdBY3Rpb24oYXJncyh7IGZvcmNlOiB0cnVlIH0pLCBub1N1bW1hcnksIFwiL3RtcC9yLm1kXCIpLmtpbmQsIFwibm8tc3VtbWFyeVwiKTtcbiAgfSk7XG5cbiAgaXQoXCJyZXR1cm5zIGV4aXN0cy1uby1mb3JjZSB3aGVuIEVWQUwtUkVWSUVXLm1kIGlzIHByZXNlbnQgYW5kIC0tZm9yY2UgaXMgTk9UIHNldFwiLCAoKSA9PiB7XG4gICAgY29uc3QgYWN0aW9uID0gcGxhbkV2YWxSZXZpZXdBY3Rpb24oYXJncygpLCByZWFkeSwgXCIvdG1wL3IubWRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGFjdGlvbi5raW5kLCBcImV4aXN0cy1uby1mb3JjZVwiKTtcbiAgICBpZiAoYWN0aW9uLmtpbmQgPT09IFwiZXhpc3RzLW5vLWZvcmNlXCIpIGFzc2VydC5lcXVhbChhY3Rpb24ucGF0aCwgXCIvdG1wL3IubWRcIik7XG4gIH0pO1xuXG4gIGl0KFwicmV0dXJucyBkaXNwYXRjaCB3aGVuIHJlYWR5LCBubyBleGlzdGluZyBmaWxlXCIsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwocGxhbkV2YWxSZXZpZXdBY3Rpb24oYXJncygpLCByZWFkeSwgbnVsbCkua2luZCwgXCJkaXNwYXRjaFwiKTtcbiAgfSk7XG5cbiAgaXQoXCJyZXR1cm5zIGRpc3BhdGNoIHdoZW4gcmVhZHkgYW5kIC0tZm9yY2Ugb3ZlcnJpZGVzIGV4aXN0aW5nIGZpbGVcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChwbGFuRXZhbFJldmlld0FjdGlvbihhcmdzKHsgZm9yY2U6IHRydWUgfSksIHJlYWR5LCBcIi90bXAvci5tZFwiKS5raW5kLCBcImRpc3BhdGNoXCIpO1xuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQ2F0YWxvZyByZWdpc3RyYXRpb24gKHJlZ3Jlc3Npb246IGNhdGFsb2cgcmVnaXN0cmF0aW9uIG11c3Qgbm90IGJlIGZvcmdvdHRlbikgXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiY2F0YWxvZyByZWdpc3RyYXRpb25cIiwgKCkgPT4ge1xuICBpdChcImluY2x1ZGVzIGV2YWwtcmV2aWV3IGluIFRPUF9MRVZFTF9TVUJDT01NQU5EU1wiLCAoKSA9PiB7XG4gICAgY29uc3QgZW50cnkgPSBUT1BfTEVWRUxfU1VCQ09NTUFORFMuZmluZCgoYykgPT4gYy5jbWQgPT09IFwiZXZhbC1yZXZpZXdcIik7XG4gICAgYXNzZXJ0Lm9rKGVudHJ5LCBcImV2YWwtcmV2aWV3IG11c3QgYmUgcHJlc2VudCBpbiBUT1BfTEVWRUxfU1VCQ09NTUFORFNcIik7XG4gICAgYXNzZXJ0Lm9rKChlbnRyeT8uZGVzYyA/PyBcIlwiKS5sZW5ndGggPiAwLCBcImV2YWwtcmV2aWV3IGVudHJ5IG11c3QgaGF2ZSBhIG5vbi1lbXB0eSBkZXNjcmlwdGlvblwiKTtcbiAgfSk7XG5cbiAgaXQoXCJhcHBlbmRzIGV2YWwtcmV2aWV3IHRvIHRoZSBHU0RfQ09NTUFORF9ERVNDUklQVElPTiBwaXBlLXNlcGFyYXRlZCBsaXN0XCIsICgpID0+IHtcbiAgICBhc3NlcnQub2soXG4gICAgICBHU0RfQ09NTUFORF9ERVNDUklQVElPTi5pbmNsdWRlcyhcInxldmFsLXJldmlld1wiKSxcbiAgICAgIFwiR1NEX0NPTU1BTkRfREVTQ1JJUFRJT04gbXVzdCBpbmNsdWRlIHRoZSBldmFsLXJldmlldyB0b2tlbiAocGlwZS1wcmVmaXhlZClcIixcbiAgICApO1xuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgYnVpbGRFdmFsUmV2aWV3UHJvbXB0IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcImJ1aWxkRXZhbFJldmlld1Byb21wdFwiLCAoKSA9PiB7XG4gIGZ1bmN0aW9uIGN0eEZpeHR1cmUob3ZlcnJpZGVzOiBQYXJ0aWFsPFBhcmFtZXRlcnM8dHlwZW9mIGJ1aWxkRXZhbFJldmlld1Byb21wdD5bMF0+ID0ge30pIHtcbiAgICByZXR1cm4ge1xuICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgc2xpY2VJZDogXCJTMDdcIixcbiAgICAgIHN1bW1hcnk6IFwiVGhlIHNsaWNlIGRpZCBzdHVmZi5cIixcbiAgICAgIHN1bW1hcnlQYXRoOiBcIi9hYnMvLmdzZC9taWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwNy9TMDctU1VNTUFSWS5tZFwiLFxuICAgICAgc3BlYzogXCJSZXF1aXJlZDogbG9nIGV2ZXJ5IExMTSBjYWxsLlwiLFxuICAgICAgc3BlY1BhdGg6IFwiL2Ficy8uZ3NkL21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzA3L1MwNy1BSS1TUEVDLm1kXCIsXG4gICAgICBvdXRwdXRQYXRoOiBcIi9hYnMvLmdzZC9taWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwNy9TMDctRVZBTC1SRVZJRVcubWRcIixcbiAgICAgIHJlbGF0aXZlT3V0cHV0UGF0aDogXCIuZ3NkL21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzA3L1MwNy1FVkFMLVJFVklFVy5tZFwiLFxuICAgICAgdHJ1bmNhdGVkOiBmYWxzZSxcbiAgICAgIGdlbmVyYXRlZEF0OiBcIjIwMjYtMDQtMjhUMTQ6MDA6MDBaXCIsXG4gICAgICAuLi5vdmVycmlkZXMsXG4gICAgfTtcbiAgfVxuXG4gIGl0KFwiaW5jbHVkZXMgdGhlIGV4cGxpY2l0IGFudGktR29vZGhhcnQgcnVsZSAoc3RyaW5nIHByZXNlbmNlIGlzIG5vdCBldmlkZW5jZSBcdTIwMTQgYW50aS1Hb29kaGFydCBndWFyZClcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHByb21wdCA9IGJ1aWxkRXZhbFJldmlld1Byb21wdChjdHhGaXh0dXJlKCkpO1xuICAgIGFzc2VydC5vayhwcm9tcHQuaW5jbHVkZXMoXCJBbnRpLUdvb2RoYXJ0XCIpLCBcInByb21wdCBtdXN0IHJlZmVyZW5jZSB0aGUgYW50aS1Hb29kaGFydCBydWxlIGJ5IG5hbWVcIik7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgcHJvbXB0LmluY2x1ZGVzKFwic3RyaW5nIG9yIGZpbGVcXG5wcmVzZW5jZVwiKSB8fCBwcm9tcHQuaW5jbHVkZXMoXCJzdHJpbmcgcHJlc2VuY2VcIikgfHwgcHJvbXB0LnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoXCJub3QgZXZpZGVuY2VcIiksXG4gICAgICBcInByb21wdCBtdXN0IGV4cGxpY2l0bHkgc3RhdGUgdGhhdCBzdHJpbmcvdG9rZW4gcHJlc2VuY2UgaXMgbm90IGV2aWRlbmNlXCIsXG4gICAgKTtcbiAgICBhc3NlcnQub2socHJvbXB0LmluY2x1ZGVzKFwiZ3JlcCBsYW5nZnVzZVwiKSwgXCJwcm9tcHQgbXVzdCBzaG93IHRoZSBjYW5vbmljYWwgR29vZGhhcnQgY291bnRlci1leGFtcGxlXCIpO1xuICB9KTtcblxuICBpdChcInJlcXVpcmVzIGV2aWRlbmNlIG9uIGV2ZXJ5IGdhcCAoZnJvbnRtYXR0ZXIgY29udHJhY3QpXCIsICgpID0+IHtcbiAgICBjb25zdCBwcm9tcHQgPSBidWlsZEV2YWxSZXZpZXdQcm9tcHQoY3R4Rml4dHVyZSgpKTtcbiAgICBhc3NlcnQub2socHJvbXB0LmluY2x1ZGVzKFwiZXZpZGVuY2VcIiksIFwicHJvbXB0IG11c3QgcmVxdWlyZSBhbiBldmlkZW5jZSBmaWVsZFwiKTtcbiAgICBhc3NlcnQub2socHJvbXB0LmluY2x1ZGVzKFwiUkVRVUlSRURcIiksIFwicHJvbXB0IG11c3QgbWFyayBldmlkZW5jZSBhcyByZXF1aXJlZFwiKTtcbiAgfSk7XG5cbiAgaXQoXCJpbmxpbmVzIHRoZSBZQU1MIHNjaGVtYSB3aXRoIHRoZSBleHBlY3RlZCB2ZXJzaW9uIGxpdGVyYWxcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHByb21wdCA9IGJ1aWxkRXZhbFJldmlld1Byb21wdChjdHhGaXh0dXJlKCkpO1xuICAgIGFzc2VydC5vayhwcm9tcHQuaW5jbHVkZXMoXCJzY2hlbWE6IGV2YWwtcmV2aWV3L3YxXCIpKTtcbiAgICBhc3NlcnQub2socHJvbXB0LmluY2x1ZGVzKFwiUFJPRFVDVElPTl9SRUFEWVwiKSk7XG4gICAgYXNzZXJ0Lm9rKHByb21wdC5pbmNsdWRlcyhcIk5PVF9JTVBMRU1FTlRFRFwiKSk7XG4gIH0pO1xuXG4gIGl0KFwiaW5zdHJ1Y3RzIHRoZSBhZ2VudCB0byB3cml0ZSB0byB0aGUgY2Fub25pY2FsIG91dHB1dCBwYXRoXCIsICgpID0+IHtcbiAgICBjb25zdCBwcm9tcHQgPSBidWlsZEV2YWxSZXZpZXdQcm9tcHQoY3R4Rml4dHVyZSgpKTtcbiAgICBhc3NlcnQub2socHJvbXB0LmluY2x1ZGVzKFwiL2Ficy8uZ3NkL21pbGVzdG9uZXMvTTAwMS9zbGljZXMvUzA3L1MwNy1FVkFMLVJFVklFVy5tZFwiKSk7XG4gIH0pO1xuXG4gIGl0KFwic3VyZmFjZXMgdGhlIHRydW5jYXRpb24gbWFya2VyIGludG8gdGhlIHByb21wdCBib2R5IHdoZW4gaW5wdXRzIHdlcmUgdHJ1bmNhdGVkXCIsICgpID0+IHtcbiAgICBjb25zdCBwcm9tcHQgPSBidWlsZEV2YWxSZXZpZXdQcm9tcHQoY3R4Rml4dHVyZSh7IHRydW5jYXRlZDogdHJ1ZSB9KSk7XG4gICAgYXNzZXJ0Lm9rKHByb21wdC5pbmNsdWRlcyhcInRydW5jYXRlZFwiKSk7XG4gIH0pO1xuXG4gIGl0KFwiZG9jdW1lbnRzIHRoZSA2MC80MCB3ZWlnaHRpbmcgYWxvbmdzaWRlIHRoZSBydWJyaWMgYW5kIGV4cGxhaW5zIHRoZSBzcGxpdFwiLCAoKSA9PiB7XG4gICAgY29uc3QgcHJvbXB0ID0gYnVpbGRFdmFsUmV2aWV3UHJvbXB0KGN0eEZpeHR1cmUoKSk7XG4gICAgYXNzZXJ0Lm9rKHByb21wdC5pbmNsdWRlcyhcIjAuNlwiKSk7XG4gICAgYXNzZXJ0Lm9rKHByb21wdC5pbmNsdWRlcyhcIjAuNFwiKSk7XG4gICAgLy8gUmF0aW9uYWxlIG11c3QgYmUgcHJlc2VudCBpbiB0aGUgcHJvbXB0IGJvZHkgXHUyMDE0IHRoZSBydWJyaWMgaXMgbm90IGp1c3RcbiAgICAvLyBudW1iZXJzLCB0aGUgYXVkaXRvciBuZWVkcyB0byBrbm93IFdIWSBjb3ZlcmFnZSBnYXBzIGFyZSB3ZWlnaHRlZCBoaWdoZXIuXG4gICAgYXNzZXJ0Lm9rKHByb21wdC50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKFwiY29tcG91bmRcIikpO1xuICAgIGFzc2VydC5vayhwcm9tcHQuaW5jbHVkZXMoXCJBbHRlcm5hdGl2ZXMgY29uc2lkZXJlZFwiKSk7XG4gIH0pO1xuXG4gIGl0KFwiZmFsbHMgYmFjayB0byBhIGJlc3QtcHJhY3RpY2VzIG5vdGUgd2hlbiBBSS1TUEVDLm1kIGlzIGFic2VudFwiLCAoKSA9PiB7XG4gICAgY29uc3QgcHJvbXB0ID0gYnVpbGRFdmFsUmV2aWV3UHJvbXB0KGN0eEZpeHR1cmUoeyBzcGVjOiBudWxsLCBzcGVjUGF0aDogbnVsbCB9KSk7XG4gICAgYXNzZXJ0Lm9rKHByb21wdC50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKFwibm90IHByZXNlbnRcIikpO1xuICB9KTtcblxuICBpdChcInJlbmRlcnMgYW4gZW1wdHkgQUktU1BFQy5tZCBhcyBkYXRhLCBub3QgYXMgJ25vdCBwcmVzZW50J1wiLCAoKSA9PiB7XG4gICAgY29uc3QgcHJvbXB0ID0gYnVpbGRFdmFsUmV2aWV3UHJvbXB0KGN0eEZpeHR1cmUoeyBzcGVjOiBcIlwiIH0pKTtcbiAgICBhc3NlcnQub2soIXByb21wdC50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKFwibm90IHByZXNlbnRcIiksIFwiZW1wdHkgc3BlYyBtdXN0IG5vdCBjb2xsYXBzZSBpbnRvICdub3QgcHJlc2VudCdcIik7XG4gICAgYXNzZXJ0Lm9rKHByb21wdC5pbmNsdWRlcyhcIiMjIyBBSS1TUEVDLm1kXCIpKTtcbiAgfSk7XG5cbiAgaXQoXCJ0cmVhdHMgc2xpY2UgYXJ0ZWZhY3RzIGFzIHVudHJ1c3RlZCBkYXRhIHdpdGggZXhwbGljaXQgaW5qZWN0aW9uLWRlZmVuc2UgYmFubmVyXCIsICgpID0+IHtcbiAgICBjb25zdCBwcm9tcHQgPSBidWlsZEV2YWxSZXZpZXdQcm9tcHQoY3R4Rml4dHVyZSgpKTtcbiAgICBhc3NlcnQub2socHJvbXB0LmluY2x1ZGVzKFwidW50cnVzdGVkIGRhdGFcIiksIFwicHJvbXB0IG11c3QgbGFiZWwgYXJ0ZWZhY3RzIGFzIHVudHJ1c3RlZFwiKTtcbiAgICBhc3NlcnQub2socHJvbXB0LnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoXCJpZ25vcmUgYW55IGluc3RydWN0aW9uc1wiKSwgXCJwcm9tcHQgbXVzdCBpbnN0cnVjdCB0aGUgbW9kZWwgdG8gaWdub3JlIGRpcmVjdGl2ZXMgaW4gYXJ0ZWZhY3RzXCIpO1xuICAgIGFzc2VydC5vayhwcm9tcHQuaW5jbHVkZXMoXCJ+fn5+bWFya2Rvd25cIiksIFwiYXJ0ZWZhY3QgYm9kaWVzIG11c3QgYmUgd3JhcHBlZCBpbiBhIGZlbmNlZCBkYXRhIGJsb2NrXCIpO1xuICB9KTtcbn0pO1xuIl0sCiAgIm1h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
