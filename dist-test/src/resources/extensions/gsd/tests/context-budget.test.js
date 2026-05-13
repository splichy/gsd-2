import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  computeBudgets,
  truncateAtSectionBoundary,
  resolveExecutorContextWindow,
  _resetEmpiricalCacheForTest
} from "../context-budget.js";
beforeEach(() => {
  _resetEmpiricalCacheForTest();
});
function makeRegistry(models) {
  return { getAll: () => models };
}
function makeModel(id, provider, contextWindow) {
  return { id, provider, contextWindow };
}
describe("context-budget: computeBudgets", () => {
  it("returns proportional allocations for 128K context window", () => {
    const b = computeBudgets(128e3);
    assert.equal(b.summaryBudgetChars, Math.floor(512e3 * 0.15));
    assert.equal(b.inlineContextBudgetChars, Math.floor(512e3 * 0.4));
    assert.equal(b.verificationBudgetChars, Math.floor(512e3 * 0.1));
    assert.equal(b.continueThresholdPercent, 70);
    assert.equal(b.taskCountRange.min, 2);
    assert.equal(b.taskCountRange.max, 5);
  });
  it("returns proportional allocations for 200K context window", () => {
    const b = computeBudgets(2e5);
    assert.equal(b.summaryBudgetChars, Math.floor(8e5 * 0.15));
    assert.equal(b.inlineContextBudgetChars, Math.floor(8e5 * 0.4));
    assert.equal(b.verificationBudgetChars, Math.floor(8e5 * 0.1));
    assert.equal(b.taskCountRange.min, 2);
    assert.equal(b.taskCountRange.max, 6);
  });
  it("returns proportional allocations for 1M context window", () => {
    const b = computeBudgets(1e6);
    assert.equal(b.summaryBudgetChars, Math.floor(4e6 * 0.15));
    assert.equal(b.inlineContextBudgetChars, Math.floor(4e6 * 0.4));
    assert.equal(b.verificationBudgetChars, Math.floor(4e6 * 0.1));
    assert.equal(b.taskCountRange.min, 2);
    assert.equal(b.taskCountRange.max, 8);
  });
  it("scales proportionally \u2014 1M > 200K > 128K for all budget fields", () => {
    const b128 = computeBudgets(128e3);
    const b200 = computeBudgets(2e5);
    const b1M = computeBudgets(1e6);
    assert.ok(b1M.summaryBudgetChars > b200.summaryBudgetChars);
    assert.ok(b200.summaryBudgetChars > b128.summaryBudgetChars);
    assert.ok(b1M.inlineContextBudgetChars > b200.inlineContextBudgetChars);
    assert.ok(b200.inlineContextBudgetChars > b128.inlineContextBudgetChars);
    assert.ok(b1M.verificationBudgetChars > b200.verificationBudgetChars);
    assert.ok(b200.verificationBudgetChars > b128.verificationBudgetChars);
    assert.ok(b1M.taskCountRange.max >= b200.taskCountRange.max);
    assert.ok(b200.taskCountRange.max >= b128.taskCountRange.max);
  });
  it("enforces task count floor (min \u2265 2) at all sizes", () => {
    for (const size of [128e3, 2e5, 1e6, 5e4]) {
      const b = computeBudgets(size);
      assert.ok(b.taskCountRange.min >= 2, `min should be \u2265 2 at ${size}, got ${b.taskCountRange.min}`);
    }
  });
  it("task count ceiling exists and is bounded", () => {
    const b = computeBudgets(1e7);
    assert.ok(b.taskCountRange.max <= 8, `max should be capped, got ${b.taskCountRange.max}`);
    assert.ok(b.taskCountRange.max >= b.taskCountRange.min);
  });
  it("handles zero input gracefully \u2014 defaults to 200K", () => {
    const b = computeBudgets(0);
    const b200 = computeBudgets(2e5);
    assert.deepStrictEqual(b, b200);
  });
  it("handles negative input gracefully \u2014 defaults to 200K", () => {
    const b = computeBudgets(-100);
    const b200 = computeBudgets(2e5);
    assert.deepStrictEqual(b, b200);
  });
});
describe("context-budget: truncateAtSectionBoundary", () => {
  it("returns content unchanged when under budget", () => {
    const content = "### Section 1\nSome text.\n\n### Section 2\nMore text.";
    const result = truncateAtSectionBoundary(content, 1e4);
    assert.equal(result.content, content);
    assert.equal(result.droppedSections, 0);
  });
  it("returns empty string unchanged", () => {
    const result = truncateAtSectionBoundary("", 100);
    assert.equal(result.content, "");
    assert.equal(result.droppedSections, 0);
  });
  it("truncates at section boundary with ### markers", () => {
    const content = [
      "### Section A\nContent A is here.\n",
      "### Section B\nContent B is here.\n",
      "### Section C\nContent C is here.\n"
    ].join("");
    const sectionALen = "### Section A\nContent A is here.\n".length;
    const result = truncateAtSectionBoundary(content, sectionALen + 5);
    assert.ok(result.content.includes("### Section A"), "should keep section A");
    assert.ok(result.content.includes("Content A"), "should keep section A content");
    assert.ok(!result.content.includes("### Section C"), "should drop section C");
    assert.ok(result.content.includes("[...truncated"), "should include truncation indicator");
    assert.ok(result.content.includes("truncated 2 sections"), `should show 2 truncated, got: ${result.content}`);
    assert.equal(result.droppedSections, 2);
  });
  it("truncates at --- divider boundaries", () => {
    const content = "Intro text.\n\n---\n\nMiddle section.\n\n---\n\nFinal section.";
    const result = truncateAtSectionBoundary(content, 20);
    assert.ok(result.content.includes("Intro text"), "should keep intro");
    assert.ok(result.content.includes("[...truncated"), "should include truncation indicator");
    assert.ok(result.droppedSections > 0, "should report dropped sections");
  });
  it("handles content with no section markers \u2014 keeps as much as fits", () => {
    const content = "A".repeat(200);
    const result = truncateAtSectionBoundary(content, 50);
    assert.ok(result.content.length < 200, "should be shorter than original");
    assert.ok(result.content.includes("[...truncated 1 sections]"), "should indicate truncation");
    assert.ok(result.content.startsWith("AAAA"), "should keep content from the start");
    assert.equal(result.droppedSections, 1);
  });
  it("handles content at exact boundary \u2014 returns unchanged", () => {
    const content = "### Section 1\nText here.";
    const result = truncateAtSectionBoundary(content, content.length);
    assert.equal(result.content, content);
    assert.equal(result.droppedSections, 0);
  });
  it("always keeps at least the first section even if it exceeds budget", () => {
    const content = "### Long Section\n" + "X".repeat(500) + "\n\n### Short\nY";
    const result = truncateAtSectionBoundary(content, 10);
    assert.ok(result.content.includes("### Long Section"), "should keep first section");
    assert.ok(result.content.includes("[...truncated 1 sections]"), "should indicate remaining sections dropped");
    assert.equal(result.droppedSections, 1);
  });
});
describe("context-budget: resolveExecutorContextWindow", () => {
  it("returns configured executor model's contextWindow when found", () => {
    const registry = makeRegistry([
      makeModel("claude-opus-4-6", "anthropic", 2e5),
      makeModel("claude-sonnet-4-20250514", "anthropic", 2e5),
      makeModel("gpt-4o", "openai", 128e3)
    ]);
    const prefs = {
      models: { execution: "gpt-4o" }
    };
    const result = resolveExecutorContextWindow(registry, prefs);
    assert.equal(result, 128e3);
  });
  it("uses conservative effective context for configured claude-code models", () => {
    const registry = makeRegistry([
      makeModel("claude-sonnet-4-6", "claude-code", 1e6)
    ]);
    const prefs = {
      models: { execution: "claude-code/claude-sonnet-4-6" }
    };
    const result = resolveExecutorContextWindow(registry, prefs);
    assert.equal(result, 2e5);
  });
  it("supports provider/model format in preferences", () => {
    const registry = makeRegistry([
      makeModel("gpt-4o", "openai", 128e3),
      makeModel("gpt-4o", "azure", 64e3)
    ]);
    const prefs = {
      models: { execution: "azure/gpt-4o" }
    };
    const result = resolveExecutorContextWindow(registry, prefs);
    assert.equal(result, 64e3);
  });
  it("supports object format preferences with model + fallbacks", () => {
    const registry = makeRegistry([
      makeModel("claude-opus-4-6", "anthropic", 2e5)
    ]);
    const prefs = {
      models: { execution: { model: "claude-opus-4-6", fallbacks: ["gpt-4o"] } }
    };
    const result = resolveExecutorContextWindow(registry, prefs);
    assert.equal(result, 2e5);
  });
  it("falls back to sessionContextWindow when executor model not found", () => {
    const registry = makeRegistry([
      makeModel("claude-opus-4-6", "anthropic", 2e5)
    ]);
    const prefs = {
      models: { execution: "nonexistent-model" }
    };
    const result = resolveExecutorContextWindow(registry, prefs, 3e5);
    assert.equal(result, 3e5);
  });
  it("falls back to sessionContextWindow when no execution preference set", () => {
    const registry = makeRegistry([
      makeModel("claude-opus-4-6", "anthropic", 2e5)
    ]);
    const prefs = { models: {} };
    const result = resolveExecutorContextWindow(registry, prefs, 128e3);
    assert.equal(result, 128e3);
  });
  it("uses conservative effective context for claude-code session window fallback", () => {
    const registry = makeRegistry([]);
    const prefs = { models: {} };
    const result = resolveExecutorContextWindow(registry, prefs, 1e6, "claude-code");
    assert.equal(result, 2e5);
  });
  it("does not cap large non-claude-code session windows", () => {
    const registry = makeRegistry([]);
    const prefs = { models: {} };
    const result = resolveExecutorContextWindow(registry, prefs, 1e6, "openai");
    assert.equal(result, 1e6);
  });
  it("falls back to 200K when no session and no executor model", () => {
    const registry = makeRegistry([]);
    const prefs = { models: { execution: "missing" } };
    const result = resolveExecutorContextWindow(registry, prefs);
    assert.equal(result, 2e5);
  });
  it("falls back to 200K with undefined preferences", () => {
    const result = resolveExecutorContextWindow(void 0, void 0);
    assert.equal(result, 2e5);
  });
  it("falls back to 200K with undefined registry", () => {
    const prefs = { models: { execution: "claude-opus-4-6" } };
    const result = resolveExecutorContextWindow(void 0, prefs);
    assert.equal(result, 2e5);
  });
  it("ignores models with contextWindow \u2264 0", () => {
    const registry = makeRegistry([
      makeModel("broken-model", "test", 0)
    ]);
    const prefs = { models: { execution: "broken-model" } };
    const result = resolveExecutorContextWindow(registry, prefs, 128e3);
    assert.equal(result, 128e3);
  });
  it("ignores sessionContextWindow \u2264 0", () => {
    const registry = makeRegistry([]);
    const prefs = {};
    const result = resolveExecutorContextWindow(registry, prefs, -1);
    assert.equal(result, 2e5);
  });
});
describe("context-budget: computeBudgets with provider", () => {
  it("anthropic budgets differ from default budgets for same window", () => {
    const defaultBudgets = computeBudgets(2e5);
    const anthropicBudgets = computeBudgets(2e5, "anthropic");
    assert.ok(
      anthropicBudgets.summaryBudgetChars < defaultBudgets.summaryBudgetChars,
      `anthropic summary (${anthropicBudgets.summaryBudgetChars}) should be less than default (${defaultBudgets.summaryBudgetChars})`
    );
    assert.ok(
      anthropicBudgets.inlineContextBudgetChars < defaultBudgets.inlineContextBudgetChars,
      `anthropic inline (${anthropicBudgets.inlineContextBudgetChars}) should be less than default (${defaultBudgets.inlineContextBudgetChars})`
    );
  });
  it("openai provider matches default budgets (both use 4.0 chars/token)", () => {
    const defaultBudgets = computeBudgets(128e3);
    const openaiBudgets = computeBudgets(128e3, "openai");
    assert.deepStrictEqual(openaiBudgets, defaultBudgets);
  });
  it("anthropic budgets are proportional to 3.5 chars/token", () => {
    const b = computeBudgets(2e5, "anthropic");
    assert.equal(b.summaryBudgetChars, Math.floor(7e5 * 0.15));
    assert.equal(b.inlineContextBudgetChars, Math.floor(7e5 * 0.4));
    assert.equal(b.verificationBudgetChars, Math.floor(7e5 * 0.1));
  });
  it("bedrock budgets match anthropic (both use 3.5 chars/token)", () => {
    const anthropicBudgets = computeBudgets(2e5, "anthropic");
    const bedrockBudgets = computeBudgets(2e5, "bedrock");
    assert.deepStrictEqual(bedrockBudgets, anthropicBudgets);
  });
  it("default behavior unchanged when no provider is passed", () => {
    const b = computeBudgets(128e3);
    assert.equal(b.summaryBudgetChars, Math.floor(512e3 * 0.15));
    assert.equal(b.inlineContextBudgetChars, Math.floor(512e3 * 0.4));
    assert.equal(b.verificationBudgetChars, Math.floor(512e3 * 0.1));
    assert.equal(b.continueThresholdPercent, 70);
    assert.equal(b.taskCountRange.min, 2);
    assert.equal(b.taskCountRange.max, 5);
  });
  it("task count range is unaffected by provider", () => {
    const defaultBudgets = computeBudgets(2e5);
    const anthropicBudgets = computeBudgets(2e5, "anthropic");
    assert.deepStrictEqual(anthropicBudgets.taskCountRange, defaultBudgets.taskCountRange);
    assert.equal(anthropicBudgets.continueThresholdPercent, defaultBudgets.continueThresholdPercent);
  });
  it("handles zero input with provider \u2014 defaults to 200K", () => {
    const b = computeBudgets(0, "anthropic");
    const b200 = computeBudgets(2e5, "anthropic");
    assert.deepStrictEqual(b, b200);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jb250ZXh0LWJ1ZGdldC50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFVuaXQgdGVzdHMgZm9yIGNvbnRleHQtYnVkZ2V0LnRzIFx1MjAxNCB0aGUgYnVkZ2V0IGVuZ2luZS5cbiAqIFRlc3RzIHB1cmUgZnVuY3Rpb25zIHdpdGggZGVwZW5kZW5jeS1pbmplY3RlZCBmYWtlcy5cbiAqIE5vIEkvTywgbm8gZXh0ZW5zaW9uIGNvbnRleHQsIG5vIGdsb2JhbCBzdGF0ZS5cbiAqL1xuXG5pbXBvcnQgeyBkZXNjcmliZSwgaXQsIGJlZm9yZUVhY2ggfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcblxuaW1wb3J0IHtcbiAgdHlwZSBCdWRnZXRBbGxvY2F0aW9uLFxuICB0eXBlIE1pbmltYWxNb2RlbCxcbiAgdHlwZSBNaW5pbWFsTW9kZWxSZWdpc3RyeSxcbiAgdHlwZSBNaW5pbWFsUHJlZmVyZW5jZXMsXG4gIHR5cGUgVHJ1bmNhdGlvblJlc3VsdCxcbiAgY29tcHV0ZUJ1ZGdldHMsXG4gIHRydW5jYXRlQXRTZWN0aW9uQm91bmRhcnksXG4gIHJlc29sdmVFeGVjdXRvckNvbnRleHRXaW5kb3csXG4gIF9yZXNldEVtcGlyaWNhbENhY2hlRm9yVGVzdCxcbn0gZnJvbSBcIi4uL2NvbnRleHQtYnVkZ2V0LmpzXCI7XG5cbi8vIFJlc2V0IHRoZSBwZXItcHJvdmlkZXIgZW1waXJpY2FsIGNoYXJzLXBlci10b2tlbiBjYWNoZSBiZWZvcmUgZWFjaCB0ZXN0LlxuLy8gVGhlIGhhcmRjb2RlZCBjaGFyLXJhdGlvIGFzc2VydGlvbnMgYmVsb3cgYXNzdW1lIHRoZSBzdGF0aWMgZmFsbGJhY2sgcGF0aFxuLy8gKDMuNSAvIDQuMCBjaGFycy90b2tlbikgaXMgdXNlZC4gV2l0aG91dCB0aGlzIGd1YXJkLCBhIHByaW9yIHRlc3QgdGhhdFxuLy8gd2FybXMgdGlrdG9rZW4gd291bGQgcG9wdWxhdGUgdGhlIGNhY2hlIGFuZCBzaWxlbnRseSBicmVhayB0aGVzZSB0ZXN0cy5cbmJlZm9yZUVhY2goKCkgPT4ge1xuICBfcmVzZXRFbXBpcmljYWxDYWNoZUZvclRlc3QoKTtcbn0pO1xuXG5pbXBvcnQgdHlwZSB7IFRva2VuUHJvdmlkZXIgfSBmcm9tIFwiLi4vdG9rZW4tY291bnRlci5qc1wiO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCBoZWxwZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBtYWtlUmVnaXN0cnkobW9kZWxzOiBNaW5pbWFsTW9kZWxbXSk6IE1pbmltYWxNb2RlbFJlZ2lzdHJ5IHtcbiAgcmV0dXJuIHsgZ2V0QWxsOiAoKSA9PiBtb2RlbHMgfTtcbn1cblxuZnVuY3Rpb24gbWFrZU1vZGVsKGlkOiBzdHJpbmcsIHByb3ZpZGVyOiBzdHJpbmcsIGNvbnRleHRXaW5kb3c6IG51bWJlcik6IE1pbmltYWxNb2RlbCB7XG4gIHJldHVybiB7IGlkLCBwcm92aWRlciwgY29udGV4dFdpbmRvdyB9O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgY29tcHV0ZUJ1ZGdldHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiY29udGV4dC1idWRnZXQ6IGNvbXB1dGVCdWRnZXRzXCIsICgpID0+IHtcbiAgaXQoXCJyZXR1cm5zIHByb3BvcnRpb25hbCBhbGxvY2F0aW9ucyBmb3IgMTI4SyBjb250ZXh0IHdpbmRvd1wiLCAoKSA9PiB7XG4gICAgY29uc3QgYiA9IGNvbXB1dGVCdWRnZXRzKDEyOF8wMDApO1xuICAgIC8vIDEyOEsgdG9rZW5zIFx1MDBENyA0IGNoYXJzL3Rva2VuID0gNTEySyBjaGFycyB0b3RhbFxuICAgIGFzc2VydC5lcXVhbChiLnN1bW1hcnlCdWRnZXRDaGFycywgTWF0aC5mbG9vcig1MTJfMDAwICogMC4xNSkpO1xuICAgIGFzc2VydC5lcXVhbChiLmlubGluZUNvbnRleHRCdWRnZXRDaGFycywgTWF0aC5mbG9vcig1MTJfMDAwICogMC40MCkpO1xuICAgIGFzc2VydC5lcXVhbChiLnZlcmlmaWNhdGlvbkJ1ZGdldENoYXJzLCBNYXRoLmZsb29yKDUxMl8wMDAgKiAwLjEwKSk7XG4gICAgYXNzZXJ0LmVxdWFsKGIuY29udGludWVUaHJlc2hvbGRQZXJjZW50LCA3MCk7XG4gICAgYXNzZXJ0LmVxdWFsKGIudGFza0NvdW50UmFuZ2UubWluLCAyKTtcbiAgICBhc3NlcnQuZXF1YWwoYi50YXNrQ291bnRSYW5nZS5tYXgsIDUpO1xuICB9KTtcblxuICBpdChcInJldHVybnMgcHJvcG9ydGlvbmFsIGFsbG9jYXRpb25zIGZvciAyMDBLIGNvbnRleHQgd2luZG93XCIsICgpID0+IHtcbiAgICBjb25zdCBiID0gY29tcHV0ZUJ1ZGdldHMoMjAwXzAwMCk7XG4gICAgLy8gMjAwSyB0b2tlbnMgXHUwMEQ3IDQgPSA4MDBLIGNoYXJzXG4gICAgYXNzZXJ0LmVxdWFsKGIuc3VtbWFyeUJ1ZGdldENoYXJzLCBNYXRoLmZsb29yKDgwMF8wMDAgKiAwLjE1KSk7XG4gICAgYXNzZXJ0LmVxdWFsKGIuaW5saW5lQ29udGV4dEJ1ZGdldENoYXJzLCBNYXRoLmZsb29yKDgwMF8wMDAgKiAwLjQwKSk7XG4gICAgYXNzZXJ0LmVxdWFsKGIudmVyaWZpY2F0aW9uQnVkZ2V0Q2hhcnMsIE1hdGguZmxvb3IoODAwXzAwMCAqIDAuMTApKTtcbiAgICBhc3NlcnQuZXF1YWwoYi50YXNrQ291bnRSYW5nZS5taW4sIDIpO1xuICAgIGFzc2VydC5lcXVhbChiLnRhc2tDb3VudFJhbmdlLm1heCwgNik7XG4gIH0pO1xuXG4gIGl0KFwicmV0dXJucyBwcm9wb3J0aW9uYWwgYWxsb2NhdGlvbnMgZm9yIDFNIGNvbnRleHQgd2luZG93XCIsICgpID0+IHtcbiAgICBjb25zdCBiID0gY29tcHV0ZUJ1ZGdldHMoMV8wMDBfMDAwKTtcbiAgICAvLyAxTSB0b2tlbnMgXHUwMEQ3IDQgPSA0TSBjaGFyc1xuICAgIGFzc2VydC5lcXVhbChiLnN1bW1hcnlCdWRnZXRDaGFycywgTWF0aC5mbG9vcig0XzAwMF8wMDAgKiAwLjE1KSk7XG4gICAgYXNzZXJ0LmVxdWFsKGIuaW5saW5lQ29udGV4dEJ1ZGdldENoYXJzLCBNYXRoLmZsb29yKDRfMDAwXzAwMCAqIDAuNDApKTtcbiAgICBhc3NlcnQuZXF1YWwoYi52ZXJpZmljYXRpb25CdWRnZXRDaGFycywgTWF0aC5mbG9vcig0XzAwMF8wMDAgKiAwLjEwKSk7XG4gICAgYXNzZXJ0LmVxdWFsKGIudGFza0NvdW50UmFuZ2UubWluLCAyKTtcbiAgICBhc3NlcnQuZXF1YWwoYi50YXNrQ291bnRSYW5nZS5tYXgsIDgpO1xuICB9KTtcblxuICBpdChcInNjYWxlcyBwcm9wb3J0aW9uYWxseSBcdTIwMTQgMU0gPiAyMDBLID4gMTI4SyBmb3IgYWxsIGJ1ZGdldCBmaWVsZHNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGIxMjggPSBjb21wdXRlQnVkZ2V0cygxMjhfMDAwKTtcbiAgICBjb25zdCBiMjAwID0gY29tcHV0ZUJ1ZGdldHMoMjAwXzAwMCk7XG4gICAgY29uc3QgYjFNID0gY29tcHV0ZUJ1ZGdldHMoMV8wMDBfMDAwKTtcblxuICAgIGFzc2VydC5vayhiMU0uc3VtbWFyeUJ1ZGdldENoYXJzID4gYjIwMC5zdW1tYXJ5QnVkZ2V0Q2hhcnMpO1xuICAgIGFzc2VydC5vayhiMjAwLnN1bW1hcnlCdWRnZXRDaGFycyA+IGIxMjguc3VtbWFyeUJ1ZGdldENoYXJzKTtcblxuICAgIGFzc2VydC5vayhiMU0uaW5saW5lQ29udGV4dEJ1ZGdldENoYXJzID4gYjIwMC5pbmxpbmVDb250ZXh0QnVkZ2V0Q2hhcnMpO1xuICAgIGFzc2VydC5vayhiMjAwLmlubGluZUNvbnRleHRCdWRnZXRDaGFycyA+IGIxMjguaW5saW5lQ29udGV4dEJ1ZGdldENoYXJzKTtcblxuICAgIGFzc2VydC5vayhiMU0udmVyaWZpY2F0aW9uQnVkZ2V0Q2hhcnMgPiBiMjAwLnZlcmlmaWNhdGlvbkJ1ZGdldENoYXJzKTtcbiAgICBhc3NlcnQub2soYjIwMC52ZXJpZmljYXRpb25CdWRnZXRDaGFycyA+IGIxMjgudmVyaWZpY2F0aW9uQnVkZ2V0Q2hhcnMpO1xuXG4gICAgYXNzZXJ0Lm9rKGIxTS50YXNrQ291bnRSYW5nZS5tYXggPj0gYjIwMC50YXNrQ291bnRSYW5nZS5tYXgpO1xuICAgIGFzc2VydC5vayhiMjAwLnRhc2tDb3VudFJhbmdlLm1heCA+PSBiMTI4LnRhc2tDb3VudFJhbmdlLm1heCk7XG4gIH0pO1xuXG4gIGl0KFwiZW5mb3JjZXMgdGFzayBjb3VudCBmbG9vciAobWluIFx1MjI2NSAyKSBhdCBhbGwgc2l6ZXNcIiwgKCkgPT4ge1xuICAgIGZvciAoY29uc3Qgc2l6ZSBvZiBbMTI4XzAwMCwgMjAwXzAwMCwgMV8wMDBfMDAwLCA1MF8wMDBdKSB7XG4gICAgICBjb25zdCBiID0gY29tcHV0ZUJ1ZGdldHMoc2l6ZSk7XG4gICAgICBhc3NlcnQub2soYi50YXNrQ291bnRSYW5nZS5taW4gPj0gMiwgYG1pbiBzaG91bGQgYmUgXHUyMjY1IDIgYXQgJHtzaXplfSwgZ290ICR7Yi50YXNrQ291bnRSYW5nZS5taW59YCk7XG4gICAgfVxuICB9KTtcblxuICBpdChcInRhc2sgY291bnQgY2VpbGluZyBleGlzdHMgYW5kIGlzIGJvdW5kZWRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGIgPSBjb21wdXRlQnVkZ2V0cygxMF8wMDBfMDAwKTsgLy8gdmVyeSBsYXJnZSB3aW5kb3dcbiAgICBhc3NlcnQub2soYi50YXNrQ291bnRSYW5nZS5tYXggPD0gOCwgYG1heCBzaG91bGQgYmUgY2FwcGVkLCBnb3QgJHtiLnRhc2tDb3VudFJhbmdlLm1heH1gKTtcbiAgICBhc3NlcnQub2soYi50YXNrQ291bnRSYW5nZS5tYXggPj0gYi50YXNrQ291bnRSYW5nZS5taW4pO1xuICB9KTtcblxuICBpdChcImhhbmRsZXMgemVybyBpbnB1dCBncmFjZWZ1bGx5IFx1MjAxNCBkZWZhdWx0cyB0byAyMDBLXCIsICgpID0+IHtcbiAgICBjb25zdCBiID0gY29tcHV0ZUJ1ZGdldHMoMCk7XG4gICAgY29uc3QgYjIwMCA9IGNvbXB1dGVCdWRnZXRzKDIwMF8wMDApO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoYiwgYjIwMCk7XG4gIH0pO1xuXG4gIGl0KFwiaGFuZGxlcyBuZWdhdGl2ZSBpbnB1dCBncmFjZWZ1bGx5IFx1MjAxNCBkZWZhdWx0cyB0byAyMDBLXCIsICgpID0+IHtcbiAgICBjb25zdCBiID0gY29tcHV0ZUJ1ZGdldHMoLTEwMCk7XG4gICAgY29uc3QgYjIwMCA9IGNvbXB1dGVCdWRnZXRzKDIwMF8wMDApO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoYiwgYjIwMCk7XG4gIH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCB0cnVuY2F0ZUF0U2VjdGlvbkJvdW5kYXJ5IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcImNvbnRleHQtYnVkZ2V0OiB0cnVuY2F0ZUF0U2VjdGlvbkJvdW5kYXJ5XCIsICgpID0+IHtcbiAgaXQoXCJyZXR1cm5zIGNvbnRlbnQgdW5jaGFuZ2VkIHdoZW4gdW5kZXIgYnVkZ2V0XCIsICgpID0+IHtcbiAgICBjb25zdCBjb250ZW50ID0gXCIjIyMgU2VjdGlvbiAxXFxuU29tZSB0ZXh0LlxcblxcbiMjIyBTZWN0aW9uIDJcXG5Nb3JlIHRleHQuXCI7XG4gICAgY29uc3QgcmVzdWx0ID0gdHJ1bmNhdGVBdFNlY3Rpb25Cb3VuZGFyeShjb250ZW50LCAxMF8wMDApO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuY29udGVudCwgY29udGVudCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5kcm9wcGVkU2VjdGlvbnMsIDApO1xuICB9KTtcblxuICBpdChcInJldHVybnMgZW1wdHkgc3RyaW5nIHVuY2hhbmdlZFwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gdHJ1bmNhdGVBdFNlY3Rpb25Cb3VuZGFyeShcIlwiLCAxMDApO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuY29udGVudCwgXCJcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5kcm9wcGVkU2VjdGlvbnMsIDApO1xuICB9KTtcblxuICBpdChcInRydW5jYXRlcyBhdCBzZWN0aW9uIGJvdW5kYXJ5IHdpdGggIyMjIG1hcmtlcnNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGNvbnRlbnQgPSBbXG4gICAgICBcIiMjIyBTZWN0aW9uIEFcXG5Db250ZW50IEEgaXMgaGVyZS5cXG5cIixcbiAgICAgIFwiIyMjIFNlY3Rpb24gQlxcbkNvbnRlbnQgQiBpcyBoZXJlLlxcblwiLFxuICAgICAgXCIjIyMgU2VjdGlvbiBDXFxuQ29udGVudCBDIGlzIGhlcmUuXFxuXCIsXG4gICAgXS5qb2luKFwiXCIpO1xuXG4gICAgLy8gQnVkZ2V0IGVub3VnaCBmb3Igc2VjdGlvbiBBIG9ubHlcbiAgICBjb25zdCBzZWN0aW9uQUxlbiA9IFwiIyMjIFNlY3Rpb24gQVxcbkNvbnRlbnQgQSBpcyBoZXJlLlxcblwiLmxlbmd0aDtcbiAgICBjb25zdCByZXN1bHQgPSB0cnVuY2F0ZUF0U2VjdGlvbkJvdW5kYXJ5KGNvbnRlbnQsIHNlY3Rpb25BTGVuICsgNSk7XG5cbiAgICBhc3NlcnQub2socmVzdWx0LmNvbnRlbnQuaW5jbHVkZXMoXCIjIyMgU2VjdGlvbiBBXCIpLCBcInNob3VsZCBrZWVwIHNlY3Rpb24gQVwiKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmNvbnRlbnQuaW5jbHVkZXMoXCJDb250ZW50IEFcIiksIFwic2hvdWxkIGtlZXAgc2VjdGlvbiBBIGNvbnRlbnRcIik7XG4gICAgYXNzZXJ0Lm9rKCFyZXN1bHQuY29udGVudC5pbmNsdWRlcyhcIiMjIyBTZWN0aW9uIENcIiksIFwic2hvdWxkIGRyb3Agc2VjdGlvbiBDXCIpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuY29udGVudC5pbmNsdWRlcyhcIlsuLi50cnVuY2F0ZWRcIiksIFwic2hvdWxkIGluY2x1ZGUgdHJ1bmNhdGlvbiBpbmRpY2F0b3JcIik7XG4gICAgLy8gVmVyaWZ5IHRydW5jYXRpb24gY291bnRcbiAgICBhc3NlcnQub2socmVzdWx0LmNvbnRlbnQuaW5jbHVkZXMoXCJ0cnVuY2F0ZWQgMiBzZWN0aW9uc1wiKSwgYHNob3VsZCBzaG93IDIgdHJ1bmNhdGVkLCBnb3Q6ICR7cmVzdWx0LmNvbnRlbnR9YCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5kcm9wcGVkU2VjdGlvbnMsIDIpO1xuICB9KTtcblxuICBpdChcInRydW5jYXRlcyBhdCAtLS0gZGl2aWRlciBib3VuZGFyaWVzXCIsICgpID0+IHtcbiAgICBjb25zdCBjb250ZW50ID0gXCJJbnRybyB0ZXh0Llxcblxcbi0tLVxcblxcbk1pZGRsZSBzZWN0aW9uLlxcblxcbi0tLVxcblxcbkZpbmFsIHNlY3Rpb24uXCI7XG4gICAgLy8gQnVkZ2V0IGVub3VnaCBmb3IgaW50cm8gb25seVxuICAgIGNvbnN0IHJlc3VsdCA9IHRydW5jYXRlQXRTZWN0aW9uQm91bmRhcnkoY29udGVudCwgMjApO1xuXG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5jb250ZW50LmluY2x1ZGVzKFwiSW50cm8gdGV4dFwiKSwgXCJzaG91bGQga2VlcCBpbnRyb1wiKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmNvbnRlbnQuaW5jbHVkZXMoXCJbLi4udHJ1bmNhdGVkXCIpLCBcInNob3VsZCBpbmNsdWRlIHRydW5jYXRpb24gaW5kaWNhdG9yXCIpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuZHJvcHBlZFNlY3Rpb25zID4gMCwgXCJzaG91bGQgcmVwb3J0IGRyb3BwZWQgc2VjdGlvbnNcIik7XG4gIH0pO1xuXG4gIGl0KFwiaGFuZGxlcyBjb250ZW50IHdpdGggbm8gc2VjdGlvbiBtYXJrZXJzIFx1MjAxNCBrZWVwcyBhcyBtdWNoIGFzIGZpdHNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGNvbnRlbnQgPSBcIkFcIi5yZXBlYXQoMjAwKTtcbiAgICBjb25zdCByZXN1bHQgPSB0cnVuY2F0ZUF0U2VjdGlvbkJvdW5kYXJ5KGNvbnRlbnQsIDUwKTtcblxuICAgIGFzc2VydC5vayhyZXN1bHQuY29udGVudC5sZW5ndGggPCAyMDAsIFwic2hvdWxkIGJlIHNob3J0ZXIgdGhhbiBvcmlnaW5hbFwiKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmNvbnRlbnQuaW5jbHVkZXMoXCJbLi4udHJ1bmNhdGVkIDEgc2VjdGlvbnNdXCIpLCBcInNob3VsZCBpbmRpY2F0ZSB0cnVuY2F0aW9uXCIpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuY29udGVudC5zdGFydHNXaXRoKFwiQUFBQVwiKSwgXCJzaG91bGQga2VlcCBjb250ZW50IGZyb20gdGhlIHN0YXJ0XCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuZHJvcHBlZFNlY3Rpb25zLCAxKTtcbiAgfSk7XG5cbiAgaXQoXCJoYW5kbGVzIGNvbnRlbnQgYXQgZXhhY3QgYm91bmRhcnkgXHUyMDE0IHJldHVybnMgdW5jaGFuZ2VkXCIsICgpID0+IHtcbiAgICBjb25zdCBjb250ZW50ID0gXCIjIyMgU2VjdGlvbiAxXFxuVGV4dCBoZXJlLlwiO1xuICAgIGNvbnN0IHJlc3VsdCA9IHRydW5jYXRlQXRTZWN0aW9uQm91bmRhcnkoY29udGVudCwgY29udGVudC5sZW5ndGgpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuY29udGVudCwgY29udGVudCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5kcm9wcGVkU2VjdGlvbnMsIDApO1xuICB9KTtcblxuICBpdChcImFsd2F5cyBrZWVwcyBhdCBsZWFzdCB0aGUgZmlyc3Qgc2VjdGlvbiBldmVuIGlmIGl0IGV4Y2VlZHMgYnVkZ2V0XCIsICgpID0+IHtcbiAgICBjb25zdCBjb250ZW50ID0gXCIjIyMgTG9uZyBTZWN0aW9uXFxuXCIgKyBcIlhcIi5yZXBlYXQoNTAwKSArIFwiXFxuXFxuIyMjIFNob3J0XFxuWVwiO1xuICAgIGNvbnN0IHJlc3VsdCA9IHRydW5jYXRlQXRTZWN0aW9uQm91bmRhcnkoY29udGVudCwgMTApO1xuXG4gICAgLy8gRmlyc3Qgc2VjdGlvbiBzaG91bGQgYmUgcHJlc2VudCBldmVuIHRob3VnaCBpdCBleGNlZWRzIGJ1ZGdldFxuICAgIGFzc2VydC5vayhyZXN1bHQuY29udGVudC5pbmNsdWRlcyhcIiMjIyBMb25nIFNlY3Rpb25cIiksIFwic2hvdWxkIGtlZXAgZmlyc3Qgc2VjdGlvblwiKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmNvbnRlbnQuaW5jbHVkZXMoXCJbLi4udHJ1bmNhdGVkIDEgc2VjdGlvbnNdXCIpLCBcInNob3VsZCBpbmRpY2F0ZSByZW1haW5pbmcgc2VjdGlvbnMgZHJvcHBlZFwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmRyb3BwZWRTZWN0aW9ucywgMSk7XG4gIH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCByZXNvbHZlRXhlY3V0b3JDb250ZXh0V2luZG93IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcImNvbnRleHQtYnVkZ2V0OiByZXNvbHZlRXhlY3V0b3JDb250ZXh0V2luZG93XCIsICgpID0+IHtcbiAgaXQoXCJyZXR1cm5zIGNvbmZpZ3VyZWQgZXhlY3V0b3IgbW9kZWwncyBjb250ZXh0V2luZG93IHdoZW4gZm91bmRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlZ2lzdHJ5ID0gbWFrZVJlZ2lzdHJ5KFtcbiAgICAgIG1ha2VNb2RlbChcImNsYXVkZS1vcHVzLTQtNlwiLCBcImFudGhyb3BpY1wiLCAyMDBfMDAwKSxcbiAgICAgIG1ha2VNb2RlbChcImNsYXVkZS1zb25uZXQtNC0yMDI1MDUxNFwiLCBcImFudGhyb3BpY1wiLCAyMDBfMDAwKSxcbiAgICAgIG1ha2VNb2RlbChcImdwdC00b1wiLCBcIm9wZW5haVwiLCAxMjhfMDAwKSxcbiAgICBdKTtcbiAgICBjb25zdCBwcmVmczogTWluaW1hbFByZWZlcmVuY2VzID0ge1xuICAgICAgbW9kZWxzOiB7IGV4ZWN1dGlvbjogXCJncHQtNG9cIiB9LFxuICAgIH07XG5cbiAgICBjb25zdCByZXN1bHQgPSByZXNvbHZlRXhlY3V0b3JDb250ZXh0V2luZG93KHJlZ2lzdHJ5LCBwcmVmcyk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgMTI4XzAwMCk7XG4gIH0pO1xuXG4gIGl0KFwidXNlcyBjb25zZXJ2YXRpdmUgZWZmZWN0aXZlIGNvbnRleHQgZm9yIGNvbmZpZ3VyZWQgY2xhdWRlLWNvZGUgbW9kZWxzXCIsICgpID0+IHtcbiAgICBjb25zdCByZWdpc3RyeSA9IG1ha2VSZWdpc3RyeShbXG4gICAgICBtYWtlTW9kZWwoXCJjbGF1ZGUtc29ubmV0LTQtNlwiLCBcImNsYXVkZS1jb2RlXCIsIDFfMDAwXzAwMCksXG4gICAgXSk7XG4gICAgY29uc3QgcHJlZnM6IE1pbmltYWxQcmVmZXJlbmNlcyA9IHtcbiAgICAgIG1vZGVsczogeyBleGVjdXRpb246IFwiY2xhdWRlLWNvZGUvY2xhdWRlLXNvbm5ldC00LTZcIiB9LFxuICAgIH07XG5cbiAgICBjb25zdCByZXN1bHQgPSByZXNvbHZlRXhlY3V0b3JDb250ZXh0V2luZG93KHJlZ2lzdHJ5LCBwcmVmcyk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgMjAwXzAwMCk7XG4gIH0pO1xuXG4gIGl0KFwic3VwcG9ydHMgcHJvdmlkZXIvbW9kZWwgZm9ybWF0IGluIHByZWZlcmVuY2VzXCIsICgpID0+IHtcbiAgICBjb25zdCByZWdpc3RyeSA9IG1ha2VSZWdpc3RyeShbXG4gICAgICBtYWtlTW9kZWwoXCJncHQtNG9cIiwgXCJvcGVuYWlcIiwgMTI4XzAwMCksXG4gICAgICBtYWtlTW9kZWwoXCJncHQtNG9cIiwgXCJhenVyZVwiLCA2NF8wMDApLFxuICAgIF0pO1xuICAgIGNvbnN0IHByZWZzOiBNaW5pbWFsUHJlZmVyZW5jZXMgPSB7XG4gICAgICBtb2RlbHM6IHsgZXhlY3V0aW9uOiBcImF6dXJlL2dwdC00b1wiIH0sXG4gICAgfTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVFeGVjdXRvckNvbnRleHRXaW5kb3cocmVnaXN0cnksIHByZWZzKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCA2NF8wMDApO1xuICB9KTtcblxuICBpdChcInN1cHBvcnRzIG9iamVjdCBmb3JtYXQgcHJlZmVyZW5jZXMgd2l0aCBtb2RlbCArIGZhbGxiYWNrc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVnaXN0cnkgPSBtYWtlUmVnaXN0cnkoW1xuICAgICAgbWFrZU1vZGVsKFwiY2xhdWRlLW9wdXMtNC02XCIsIFwiYW50aHJvcGljXCIsIDIwMF8wMDApLFxuICAgIF0pO1xuICAgIGNvbnN0IHByZWZzOiBNaW5pbWFsUHJlZmVyZW5jZXMgPSB7XG4gICAgICBtb2RlbHM6IHsgZXhlY3V0aW9uOiB7IG1vZGVsOiBcImNsYXVkZS1vcHVzLTQtNlwiLCBmYWxsYmFja3M6IFtcImdwdC00b1wiXSB9IH0sXG4gICAgfTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVFeGVjdXRvckNvbnRleHRXaW5kb3cocmVnaXN0cnksIHByZWZzKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCAyMDBfMDAwKTtcbiAgfSk7XG5cbiAgaXQoXCJmYWxscyBiYWNrIHRvIHNlc3Npb25Db250ZXh0V2luZG93IHdoZW4gZXhlY3V0b3IgbW9kZWwgbm90IGZvdW5kXCIsICgpID0+IHtcbiAgICBjb25zdCByZWdpc3RyeSA9IG1ha2VSZWdpc3RyeShbXG4gICAgICBtYWtlTW9kZWwoXCJjbGF1ZGUtb3B1cy00LTZcIiwgXCJhbnRocm9waWNcIiwgMjAwXzAwMCksXG4gICAgXSk7XG4gICAgY29uc3QgcHJlZnM6IE1pbmltYWxQcmVmZXJlbmNlcyA9IHtcbiAgICAgIG1vZGVsczogeyBleGVjdXRpb246IFwibm9uZXhpc3RlbnQtbW9kZWxcIiB9LFxuICAgIH07XG5cbiAgICBjb25zdCByZXN1bHQgPSByZXNvbHZlRXhlY3V0b3JDb250ZXh0V2luZG93KHJlZ2lzdHJ5LCBwcmVmcywgMzAwXzAwMCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgMzAwXzAwMCk7XG4gIH0pO1xuXG4gIGl0KFwiZmFsbHMgYmFjayB0byBzZXNzaW9uQ29udGV4dFdpbmRvdyB3aGVuIG5vIGV4ZWN1dGlvbiBwcmVmZXJlbmNlIHNldFwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVnaXN0cnkgPSBtYWtlUmVnaXN0cnkoW1xuICAgICAgbWFrZU1vZGVsKFwiY2xhdWRlLW9wdXMtNC02XCIsIFwiYW50aHJvcGljXCIsIDIwMF8wMDApLFxuICAgIF0pO1xuICAgIGNvbnN0IHByZWZzOiBNaW5pbWFsUHJlZmVyZW5jZXMgPSB7IG1vZGVsczoge30gfTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVFeGVjdXRvckNvbnRleHRXaW5kb3cocmVnaXN0cnksIHByZWZzLCAxMjhfMDAwKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCAxMjhfMDAwKTtcbiAgfSk7XG5cbiAgaXQoXCJ1c2VzIGNvbnNlcnZhdGl2ZSBlZmZlY3RpdmUgY29udGV4dCBmb3IgY2xhdWRlLWNvZGUgc2Vzc2lvbiB3aW5kb3cgZmFsbGJhY2tcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlZ2lzdHJ5ID0gbWFrZVJlZ2lzdHJ5KFtdKTtcbiAgICBjb25zdCBwcmVmczogTWluaW1hbFByZWZlcmVuY2VzID0geyBtb2RlbHM6IHt9IH07XG5cbiAgICBjb25zdCByZXN1bHQgPSByZXNvbHZlRXhlY3V0b3JDb250ZXh0V2luZG93KHJlZ2lzdHJ5LCBwcmVmcywgMV8wMDBfMDAwLCBcImNsYXVkZS1jb2RlXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIDIwMF8wMDApO1xuICB9KTtcblxuICBpdChcImRvZXMgbm90IGNhcCBsYXJnZSBub24tY2xhdWRlLWNvZGUgc2Vzc2lvbiB3aW5kb3dzXCIsICgpID0+IHtcbiAgICBjb25zdCByZWdpc3RyeSA9IG1ha2VSZWdpc3RyeShbXSk7XG4gICAgY29uc3QgcHJlZnM6IE1pbmltYWxQcmVmZXJlbmNlcyA9IHsgbW9kZWxzOiB7fSB9O1xuXG4gICAgY29uc3QgcmVzdWx0ID0gcmVzb2x2ZUV4ZWN1dG9yQ29udGV4dFdpbmRvdyhyZWdpc3RyeSwgcHJlZnMsIDFfMDAwXzAwMCwgXCJvcGVuYWlcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgMV8wMDBfMDAwKTtcbiAgfSk7XG5cbiAgaXQoXCJmYWxscyBiYWNrIHRvIDIwMEsgd2hlbiBubyBzZXNzaW9uIGFuZCBubyBleGVjdXRvciBtb2RlbFwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVnaXN0cnkgPSBtYWtlUmVnaXN0cnkoW10pO1xuICAgIGNvbnN0IHByZWZzOiBNaW5pbWFsUHJlZmVyZW5jZXMgPSB7IG1vZGVsczogeyBleGVjdXRpb246IFwibWlzc2luZ1wiIH0gfTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVFeGVjdXRvckNvbnRleHRXaW5kb3cocmVnaXN0cnksIHByZWZzKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCAyMDBfMDAwKTtcbiAgfSk7XG5cbiAgaXQoXCJmYWxscyBiYWNrIHRvIDIwMEsgd2l0aCB1bmRlZmluZWQgcHJlZmVyZW5jZXNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVFeGVjdXRvckNvbnRleHRXaW5kb3codW5kZWZpbmVkLCB1bmRlZmluZWQpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIDIwMF8wMDApO1xuICB9KTtcblxuICBpdChcImZhbGxzIGJhY2sgdG8gMjAwSyB3aXRoIHVuZGVmaW5lZCByZWdpc3RyeVwiLCAoKSA9PiB7XG4gICAgY29uc3QgcHJlZnM6IE1pbmltYWxQcmVmZXJlbmNlcyA9IHsgbW9kZWxzOiB7IGV4ZWN1dGlvbjogXCJjbGF1ZGUtb3B1cy00LTZcIiB9IH07XG4gICAgY29uc3QgcmVzdWx0ID0gcmVzb2x2ZUV4ZWN1dG9yQ29udGV4dFdpbmRvdyh1bmRlZmluZWQsIHByZWZzKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCAyMDBfMDAwKTtcbiAgfSk7XG5cbiAgaXQoXCJpZ25vcmVzIG1vZGVscyB3aXRoIGNvbnRleHRXaW5kb3cgXHUyMjY0IDBcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlZ2lzdHJ5ID0gbWFrZVJlZ2lzdHJ5KFtcbiAgICAgIG1ha2VNb2RlbChcImJyb2tlbi1tb2RlbFwiLCBcInRlc3RcIiwgMCksXG4gICAgXSk7XG4gICAgY29uc3QgcHJlZnM6IE1pbmltYWxQcmVmZXJlbmNlcyA9IHsgbW9kZWxzOiB7IGV4ZWN1dGlvbjogXCJicm9rZW4tbW9kZWxcIiB9IH07XG5cbiAgICBjb25zdCByZXN1bHQgPSByZXNvbHZlRXhlY3V0b3JDb250ZXh0V2luZG93KHJlZ2lzdHJ5LCBwcmVmcywgMTI4XzAwMCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgMTI4XzAwMCk7IC8vIGZhbGxzIHRocm91Z2ggdG8gc2Vzc2lvblxuICB9KTtcblxuICBpdChcImlnbm9yZXMgc2Vzc2lvbkNvbnRleHRXaW5kb3cgXHUyMjY0IDBcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlZ2lzdHJ5ID0gbWFrZVJlZ2lzdHJ5KFtdKTtcbiAgICBjb25zdCBwcmVmczogTWluaW1hbFByZWZlcmVuY2VzID0ge307XG5cbiAgICBjb25zdCByZXN1bHQgPSByZXNvbHZlRXhlY3V0b3JDb250ZXh0V2luZG93KHJlZ2lzdHJ5LCBwcmVmcywgLTEpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIDIwMF8wMDApOyAvLyBmYWxscyB0aHJvdWdoIHRvIGRlZmF1bHRcbiAgfSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGNvbXB1dGVCdWRnZXRzIHdpdGggcHJvdmlkZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiY29udGV4dC1idWRnZXQ6IGNvbXB1dGVCdWRnZXRzIHdpdGggcHJvdmlkZXJcIiwgKCkgPT4ge1xuICBpdChcImFudGhyb3BpYyBidWRnZXRzIGRpZmZlciBmcm9tIGRlZmF1bHQgYnVkZ2V0cyBmb3Igc2FtZSB3aW5kb3dcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGRlZmF1bHRCdWRnZXRzID0gY29tcHV0ZUJ1ZGdldHMoMjAwXzAwMCk7XG4gICAgY29uc3QgYW50aHJvcGljQnVkZ2V0cyA9IGNvbXB1dGVCdWRnZXRzKDIwMF8wMDAsIFwiYW50aHJvcGljXCIpO1xuXG4gICAgLy8gYW50aHJvcGljIHVzZXMgMy41IGNoYXJzL3Rva2VuIHZzIGRlZmF1bHQgNC4wXG4gICAgLy8gc28gYW50aHJvcGljIHRvdGFsQ2hhcnMgPSAyMDBLICogMy41ID0gNzAwSyB2cyBkZWZhdWx0IDIwMEsgKiA0ID0gODAwS1xuICAgIGFzc2VydC5vayhcbiAgICAgIGFudGhyb3BpY0J1ZGdldHMuc3VtbWFyeUJ1ZGdldENoYXJzIDwgZGVmYXVsdEJ1ZGdldHMuc3VtbWFyeUJ1ZGdldENoYXJzLFxuICAgICAgYGFudGhyb3BpYyBzdW1tYXJ5ICgke2FudGhyb3BpY0J1ZGdldHMuc3VtbWFyeUJ1ZGdldENoYXJzfSkgc2hvdWxkIGJlIGxlc3MgdGhhbiBkZWZhdWx0ICgke2RlZmF1bHRCdWRnZXRzLnN1bW1hcnlCdWRnZXRDaGFyc30pYCxcbiAgICApO1xuICAgIGFzc2VydC5vayhcbiAgICAgIGFudGhyb3BpY0J1ZGdldHMuaW5saW5lQ29udGV4dEJ1ZGdldENoYXJzIDwgZGVmYXVsdEJ1ZGdldHMuaW5saW5lQ29udGV4dEJ1ZGdldENoYXJzLFxuICAgICAgYGFudGhyb3BpYyBpbmxpbmUgKCR7YW50aHJvcGljQnVkZ2V0cy5pbmxpbmVDb250ZXh0QnVkZ2V0Q2hhcnN9KSBzaG91bGQgYmUgbGVzcyB0aGFuIGRlZmF1bHQgKCR7ZGVmYXVsdEJ1ZGdldHMuaW5saW5lQ29udGV4dEJ1ZGdldENoYXJzfSlgLFxuICAgICk7XG4gIH0pO1xuXG4gIGl0KFwib3BlbmFpIHByb3ZpZGVyIG1hdGNoZXMgZGVmYXVsdCBidWRnZXRzIChib3RoIHVzZSA0LjAgY2hhcnMvdG9rZW4pXCIsICgpID0+IHtcbiAgICBjb25zdCBkZWZhdWx0QnVkZ2V0cyA9IGNvbXB1dGVCdWRnZXRzKDEyOF8wMDApO1xuICAgIGNvbnN0IG9wZW5haUJ1ZGdldHMgPSBjb21wdXRlQnVkZ2V0cygxMjhfMDAwLCBcIm9wZW5haVwiKTtcblxuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwob3BlbmFpQnVkZ2V0cywgZGVmYXVsdEJ1ZGdldHMpO1xuICB9KTtcblxuICBpdChcImFudGhyb3BpYyBidWRnZXRzIGFyZSBwcm9wb3J0aW9uYWwgdG8gMy41IGNoYXJzL3Rva2VuXCIsICgpID0+IHtcbiAgICBjb25zdCBiID0gY29tcHV0ZUJ1ZGdldHMoMjAwXzAwMCwgXCJhbnRocm9waWNcIik7XG4gICAgLy8gMjAwSyB0b2tlbnMgKiAzLjUgY2hhcnMvdG9rZW4gPSA3MDBLIGNoYXJzIHRvdGFsXG4gICAgYXNzZXJ0LmVxdWFsKGIuc3VtbWFyeUJ1ZGdldENoYXJzLCBNYXRoLmZsb29yKDcwMF8wMDAgKiAwLjE1KSk7XG4gICAgYXNzZXJ0LmVxdWFsKGIuaW5saW5lQ29udGV4dEJ1ZGdldENoYXJzLCBNYXRoLmZsb29yKDcwMF8wMDAgKiAwLjQwKSk7XG4gICAgYXNzZXJ0LmVxdWFsKGIudmVyaWZpY2F0aW9uQnVkZ2V0Q2hhcnMsIE1hdGguZmxvb3IoNzAwXzAwMCAqIDAuMTApKTtcbiAgfSk7XG5cbiAgaXQoXCJiZWRyb2NrIGJ1ZGdldHMgbWF0Y2ggYW50aHJvcGljIChib3RoIHVzZSAzLjUgY2hhcnMvdG9rZW4pXCIsICgpID0+IHtcbiAgICBjb25zdCBhbnRocm9waWNCdWRnZXRzID0gY29tcHV0ZUJ1ZGdldHMoMjAwXzAwMCwgXCJhbnRocm9waWNcIik7XG4gICAgY29uc3QgYmVkcm9ja0J1ZGdldHMgPSBjb21wdXRlQnVkZ2V0cygyMDBfMDAwLCBcImJlZHJvY2tcIik7XG5cbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGJlZHJvY2tCdWRnZXRzLCBhbnRocm9waWNCdWRnZXRzKTtcbiAgfSk7XG5cbiAgaXQoXCJkZWZhdWx0IGJlaGF2aW9yIHVuY2hhbmdlZCB3aGVuIG5vIHByb3ZpZGVyIGlzIHBhc3NlZFwiLCAoKSA9PiB7XG4gICAgY29uc3QgYiA9IGNvbXB1dGVCdWRnZXRzKDEyOF8wMDApO1xuICAgIC8vIDEyOEsgKiA0ID0gNTEyS1xuICAgIGFzc2VydC5lcXVhbChiLnN1bW1hcnlCdWRnZXRDaGFycywgTWF0aC5mbG9vcig1MTJfMDAwICogMC4xNSkpO1xuICAgIGFzc2VydC5lcXVhbChiLmlubGluZUNvbnRleHRCdWRnZXRDaGFycywgTWF0aC5mbG9vcig1MTJfMDAwICogMC40MCkpO1xuICAgIGFzc2VydC5lcXVhbChiLnZlcmlmaWNhdGlvbkJ1ZGdldENoYXJzLCBNYXRoLmZsb29yKDUxMl8wMDAgKiAwLjEwKSk7XG4gICAgYXNzZXJ0LmVxdWFsKGIuY29udGludWVUaHJlc2hvbGRQZXJjZW50LCA3MCk7XG4gICAgYXNzZXJ0LmVxdWFsKGIudGFza0NvdW50UmFuZ2UubWluLCAyKTtcbiAgICBhc3NlcnQuZXF1YWwoYi50YXNrQ291bnRSYW5nZS5tYXgsIDUpO1xuICB9KTtcblxuICBpdChcInRhc2sgY291bnQgcmFuZ2UgaXMgdW5hZmZlY3RlZCBieSBwcm92aWRlclwiLCAoKSA9PiB7XG4gICAgY29uc3QgZGVmYXVsdEJ1ZGdldHMgPSBjb21wdXRlQnVkZ2V0cygyMDBfMDAwKTtcbiAgICBjb25zdCBhbnRocm9waWNCdWRnZXRzID0gY29tcHV0ZUJ1ZGdldHMoMjAwXzAwMCwgXCJhbnRocm9waWNcIik7XG5cbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGFudGhyb3BpY0J1ZGdldHMudGFza0NvdW50UmFuZ2UsIGRlZmF1bHRCdWRnZXRzLnRhc2tDb3VudFJhbmdlKTtcbiAgICBhc3NlcnQuZXF1YWwoYW50aHJvcGljQnVkZ2V0cy5jb250aW51ZVRocmVzaG9sZFBlcmNlbnQsIGRlZmF1bHRCdWRnZXRzLmNvbnRpbnVlVGhyZXNob2xkUGVyY2VudCk7XG4gIH0pO1xuXG4gIGl0KFwiaGFuZGxlcyB6ZXJvIGlucHV0IHdpdGggcHJvdmlkZXIgXHUyMDE0IGRlZmF1bHRzIHRvIDIwMEtcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGIgPSBjb21wdXRlQnVkZ2V0cygwLCBcImFudGhyb3BpY1wiKTtcbiAgICBjb25zdCBiMjAwID0gY29tcHV0ZUJ1ZGdldHMoMjAwXzAwMCwgXCJhbnRocm9waWNcIik7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChiLCBiMjAwKTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQU1BLFNBQVMsVUFBVSxJQUFJLGtCQUFrQjtBQUN6QyxPQUFPLFlBQVk7QUFFbkI7QUFBQSxFQU1FO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQU1QLFdBQVcsTUFBTTtBQUNmLDhCQUE0QjtBQUM5QixDQUFDO0FBTUQsU0FBUyxhQUFhLFFBQThDO0FBQ2xFLFNBQU8sRUFBRSxRQUFRLE1BQU0sT0FBTztBQUNoQztBQUVBLFNBQVMsVUFBVSxJQUFZLFVBQWtCLGVBQXFDO0FBQ3BGLFNBQU8sRUFBRSxJQUFJLFVBQVUsY0FBYztBQUN2QztBQUlBLFNBQVMsa0NBQWtDLE1BQU07QUFDL0MsS0FBRyw0REFBNEQsTUFBTTtBQUNuRSxVQUFNLElBQUksZUFBZSxLQUFPO0FBRWhDLFdBQU8sTUFBTSxFQUFFLG9CQUFvQixLQUFLLE1BQU0sUUFBVSxJQUFJLENBQUM7QUFDN0QsV0FBTyxNQUFNLEVBQUUsMEJBQTBCLEtBQUssTUFBTSxRQUFVLEdBQUksQ0FBQztBQUNuRSxXQUFPLE1BQU0sRUFBRSx5QkFBeUIsS0FBSyxNQUFNLFFBQVUsR0FBSSxDQUFDO0FBQ2xFLFdBQU8sTUFBTSxFQUFFLDBCQUEwQixFQUFFO0FBQzNDLFdBQU8sTUFBTSxFQUFFLGVBQWUsS0FBSyxDQUFDO0FBQ3BDLFdBQU8sTUFBTSxFQUFFLGVBQWUsS0FBSyxDQUFDO0FBQUEsRUFDdEMsQ0FBQztBQUVELEtBQUcsNERBQTRELE1BQU07QUFDbkUsVUFBTSxJQUFJLGVBQWUsR0FBTztBQUVoQyxXQUFPLE1BQU0sRUFBRSxvQkFBb0IsS0FBSyxNQUFNLE1BQVUsSUFBSSxDQUFDO0FBQzdELFdBQU8sTUFBTSxFQUFFLDBCQUEwQixLQUFLLE1BQU0sTUFBVSxHQUFJLENBQUM7QUFDbkUsV0FBTyxNQUFNLEVBQUUseUJBQXlCLEtBQUssTUFBTSxNQUFVLEdBQUksQ0FBQztBQUNsRSxXQUFPLE1BQU0sRUFBRSxlQUFlLEtBQUssQ0FBQztBQUNwQyxXQUFPLE1BQU0sRUFBRSxlQUFlLEtBQUssQ0FBQztBQUFBLEVBQ3RDLENBQUM7QUFFRCxLQUFHLDBEQUEwRCxNQUFNO0FBQ2pFLFVBQU0sSUFBSSxlQUFlLEdBQVM7QUFFbEMsV0FBTyxNQUFNLEVBQUUsb0JBQW9CLEtBQUssTUFBTSxNQUFZLElBQUksQ0FBQztBQUMvRCxXQUFPLE1BQU0sRUFBRSwwQkFBMEIsS0FBSyxNQUFNLE1BQVksR0FBSSxDQUFDO0FBQ3JFLFdBQU8sTUFBTSxFQUFFLHlCQUF5QixLQUFLLE1BQU0sTUFBWSxHQUFJLENBQUM7QUFDcEUsV0FBTyxNQUFNLEVBQUUsZUFBZSxLQUFLLENBQUM7QUFDcEMsV0FBTyxNQUFNLEVBQUUsZUFBZSxLQUFLLENBQUM7QUFBQSxFQUN0QyxDQUFDO0FBRUQsS0FBRyx1RUFBa0UsTUFBTTtBQUN6RSxVQUFNLE9BQU8sZUFBZSxLQUFPO0FBQ25DLFVBQU0sT0FBTyxlQUFlLEdBQU87QUFDbkMsVUFBTSxNQUFNLGVBQWUsR0FBUztBQUVwQyxXQUFPLEdBQUcsSUFBSSxxQkFBcUIsS0FBSyxrQkFBa0I7QUFDMUQsV0FBTyxHQUFHLEtBQUsscUJBQXFCLEtBQUssa0JBQWtCO0FBRTNELFdBQU8sR0FBRyxJQUFJLDJCQUEyQixLQUFLLHdCQUF3QjtBQUN0RSxXQUFPLEdBQUcsS0FBSywyQkFBMkIsS0FBSyx3QkFBd0I7QUFFdkUsV0FBTyxHQUFHLElBQUksMEJBQTBCLEtBQUssdUJBQXVCO0FBQ3BFLFdBQU8sR0FBRyxLQUFLLDBCQUEwQixLQUFLLHVCQUF1QjtBQUVyRSxXQUFPLEdBQUcsSUFBSSxlQUFlLE9BQU8sS0FBSyxlQUFlLEdBQUc7QUFDM0QsV0FBTyxHQUFHLEtBQUssZUFBZSxPQUFPLEtBQUssZUFBZSxHQUFHO0FBQUEsRUFDOUQsQ0FBQztBQUVELEtBQUcseURBQW9ELE1BQU07QUFDM0QsZUFBVyxRQUFRLENBQUMsT0FBUyxLQUFTLEtBQVcsR0FBTSxHQUFHO0FBQ3hELFlBQU0sSUFBSSxlQUFlLElBQUk7QUFDN0IsYUFBTyxHQUFHLEVBQUUsZUFBZSxPQUFPLEdBQUcsNkJBQXdCLElBQUksU0FBUyxFQUFFLGVBQWUsR0FBRyxFQUFFO0FBQUEsSUFDbEc7QUFBQSxFQUNGLENBQUM7QUFFRCxLQUFHLDRDQUE0QyxNQUFNO0FBQ25ELFVBQU0sSUFBSSxlQUFlLEdBQVU7QUFDbkMsV0FBTyxHQUFHLEVBQUUsZUFBZSxPQUFPLEdBQUcsNkJBQTZCLEVBQUUsZUFBZSxHQUFHLEVBQUU7QUFDeEYsV0FBTyxHQUFHLEVBQUUsZUFBZSxPQUFPLEVBQUUsZUFBZSxHQUFHO0FBQUEsRUFDeEQsQ0FBQztBQUVELEtBQUcseURBQW9ELE1BQU07QUFDM0QsVUFBTSxJQUFJLGVBQWUsQ0FBQztBQUMxQixVQUFNLE9BQU8sZUFBZSxHQUFPO0FBQ25DLFdBQU8sZ0JBQWdCLEdBQUcsSUFBSTtBQUFBLEVBQ2hDLENBQUM7QUFFRCxLQUFHLDZEQUF3RCxNQUFNO0FBQy9ELFVBQU0sSUFBSSxlQUFlLElBQUk7QUFDN0IsVUFBTSxPQUFPLGVBQWUsR0FBTztBQUNuQyxXQUFPLGdCQUFnQixHQUFHLElBQUk7QUFBQSxFQUNoQyxDQUFDO0FBQ0gsQ0FBQztBQUlELFNBQVMsNkNBQTZDLE1BQU07QUFDMUQsS0FBRywrQ0FBK0MsTUFBTTtBQUN0RCxVQUFNLFVBQVU7QUFDaEIsVUFBTSxTQUFTLDBCQUEwQixTQUFTLEdBQU07QUFDeEQsV0FBTyxNQUFNLE9BQU8sU0FBUyxPQUFPO0FBQ3BDLFdBQU8sTUFBTSxPQUFPLGlCQUFpQixDQUFDO0FBQUEsRUFDeEMsQ0FBQztBQUVELEtBQUcsa0NBQWtDLE1BQU07QUFDekMsVUFBTSxTQUFTLDBCQUEwQixJQUFJLEdBQUc7QUFDaEQsV0FBTyxNQUFNLE9BQU8sU0FBUyxFQUFFO0FBQy9CLFdBQU8sTUFBTSxPQUFPLGlCQUFpQixDQUFDO0FBQUEsRUFDeEMsQ0FBQztBQUVELEtBQUcsa0RBQWtELE1BQU07QUFDekQsVUFBTSxVQUFVO0FBQUEsTUFDZDtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRixFQUFFLEtBQUssRUFBRTtBQUdULFVBQU0sY0FBYyxzQ0FBc0M7QUFDMUQsVUFBTSxTQUFTLDBCQUEwQixTQUFTLGNBQWMsQ0FBQztBQUVqRSxXQUFPLEdBQUcsT0FBTyxRQUFRLFNBQVMsZUFBZSxHQUFHLHVCQUF1QjtBQUMzRSxXQUFPLEdBQUcsT0FBTyxRQUFRLFNBQVMsV0FBVyxHQUFHLCtCQUErQjtBQUMvRSxXQUFPLEdBQUcsQ0FBQyxPQUFPLFFBQVEsU0FBUyxlQUFlLEdBQUcsdUJBQXVCO0FBQzVFLFdBQU8sR0FBRyxPQUFPLFFBQVEsU0FBUyxlQUFlLEdBQUcscUNBQXFDO0FBRXpGLFdBQU8sR0FBRyxPQUFPLFFBQVEsU0FBUyxzQkFBc0IsR0FBRyxpQ0FBaUMsT0FBTyxPQUFPLEVBQUU7QUFDNUcsV0FBTyxNQUFNLE9BQU8saUJBQWlCLENBQUM7QUFBQSxFQUN4QyxDQUFDO0FBRUQsS0FBRyx1Q0FBdUMsTUFBTTtBQUM5QyxVQUFNLFVBQVU7QUFFaEIsVUFBTSxTQUFTLDBCQUEwQixTQUFTLEVBQUU7QUFFcEQsV0FBTyxHQUFHLE9BQU8sUUFBUSxTQUFTLFlBQVksR0FBRyxtQkFBbUI7QUFDcEUsV0FBTyxHQUFHLE9BQU8sUUFBUSxTQUFTLGVBQWUsR0FBRyxxQ0FBcUM7QUFDekYsV0FBTyxHQUFHLE9BQU8sa0JBQWtCLEdBQUcsZ0NBQWdDO0FBQUEsRUFDeEUsQ0FBQztBQUVELEtBQUcsd0VBQW1FLE1BQU07QUFDMUUsVUFBTSxVQUFVLElBQUksT0FBTyxHQUFHO0FBQzlCLFVBQU0sU0FBUywwQkFBMEIsU0FBUyxFQUFFO0FBRXBELFdBQU8sR0FBRyxPQUFPLFFBQVEsU0FBUyxLQUFLLGlDQUFpQztBQUN4RSxXQUFPLEdBQUcsT0FBTyxRQUFRLFNBQVMsMkJBQTJCLEdBQUcsNEJBQTRCO0FBQzVGLFdBQU8sR0FBRyxPQUFPLFFBQVEsV0FBVyxNQUFNLEdBQUcsb0NBQW9DO0FBQ2pGLFdBQU8sTUFBTSxPQUFPLGlCQUFpQixDQUFDO0FBQUEsRUFDeEMsQ0FBQztBQUVELEtBQUcsOERBQXlELE1BQU07QUFDaEUsVUFBTSxVQUFVO0FBQ2hCLFVBQU0sU0FBUywwQkFBMEIsU0FBUyxRQUFRLE1BQU07QUFDaEUsV0FBTyxNQUFNLE9BQU8sU0FBUyxPQUFPO0FBQ3BDLFdBQU8sTUFBTSxPQUFPLGlCQUFpQixDQUFDO0FBQUEsRUFDeEMsQ0FBQztBQUVELEtBQUcscUVBQXFFLE1BQU07QUFDNUUsVUFBTSxVQUFVLHVCQUF1QixJQUFJLE9BQU8sR0FBRyxJQUFJO0FBQ3pELFVBQU0sU0FBUywwQkFBMEIsU0FBUyxFQUFFO0FBR3BELFdBQU8sR0FBRyxPQUFPLFFBQVEsU0FBUyxrQkFBa0IsR0FBRywyQkFBMkI7QUFDbEYsV0FBTyxHQUFHLE9BQU8sUUFBUSxTQUFTLDJCQUEyQixHQUFHLDRDQUE0QztBQUM1RyxXQUFPLE1BQU0sT0FBTyxpQkFBaUIsQ0FBQztBQUFBLEVBQ3hDLENBQUM7QUFDSCxDQUFDO0FBSUQsU0FBUyxnREFBZ0QsTUFBTTtBQUM3RCxLQUFHLGdFQUFnRSxNQUFNO0FBQ3ZFLFVBQU0sV0FBVyxhQUFhO0FBQUEsTUFDNUIsVUFBVSxtQkFBbUIsYUFBYSxHQUFPO0FBQUEsTUFDakQsVUFBVSw0QkFBNEIsYUFBYSxHQUFPO0FBQUEsTUFDMUQsVUFBVSxVQUFVLFVBQVUsS0FBTztBQUFBLElBQ3ZDLENBQUM7QUFDRCxVQUFNLFFBQTRCO0FBQUEsTUFDaEMsUUFBUSxFQUFFLFdBQVcsU0FBUztBQUFBLElBQ2hDO0FBRUEsVUFBTSxTQUFTLDZCQUE2QixVQUFVLEtBQUs7QUFDM0QsV0FBTyxNQUFNLFFBQVEsS0FBTztBQUFBLEVBQzlCLENBQUM7QUFFRCxLQUFHLHlFQUF5RSxNQUFNO0FBQ2hGLFVBQU0sV0FBVyxhQUFhO0FBQUEsTUFDNUIsVUFBVSxxQkFBcUIsZUFBZSxHQUFTO0FBQUEsSUFDekQsQ0FBQztBQUNELFVBQU0sUUFBNEI7QUFBQSxNQUNoQyxRQUFRLEVBQUUsV0FBVyxnQ0FBZ0M7QUFBQSxJQUN2RDtBQUVBLFVBQU0sU0FBUyw2QkFBNkIsVUFBVSxLQUFLO0FBQzNELFdBQU8sTUFBTSxRQUFRLEdBQU87QUFBQSxFQUM5QixDQUFDO0FBRUQsS0FBRyxpREFBaUQsTUFBTTtBQUN4RCxVQUFNLFdBQVcsYUFBYTtBQUFBLE1BQzVCLFVBQVUsVUFBVSxVQUFVLEtBQU87QUFBQSxNQUNyQyxVQUFVLFVBQVUsU0FBUyxJQUFNO0FBQUEsSUFDckMsQ0FBQztBQUNELFVBQU0sUUFBNEI7QUFBQSxNQUNoQyxRQUFRLEVBQUUsV0FBVyxlQUFlO0FBQUEsSUFDdEM7QUFFQSxVQUFNLFNBQVMsNkJBQTZCLFVBQVUsS0FBSztBQUMzRCxXQUFPLE1BQU0sUUFBUSxJQUFNO0FBQUEsRUFDN0IsQ0FBQztBQUVELEtBQUcsNkRBQTZELE1BQU07QUFDcEUsVUFBTSxXQUFXLGFBQWE7QUFBQSxNQUM1QixVQUFVLG1CQUFtQixhQUFhLEdBQU87QUFBQSxJQUNuRCxDQUFDO0FBQ0QsVUFBTSxRQUE0QjtBQUFBLE1BQ2hDLFFBQVEsRUFBRSxXQUFXLEVBQUUsT0FBTyxtQkFBbUIsV0FBVyxDQUFDLFFBQVEsRUFBRSxFQUFFO0FBQUEsSUFDM0U7QUFFQSxVQUFNLFNBQVMsNkJBQTZCLFVBQVUsS0FBSztBQUMzRCxXQUFPLE1BQU0sUUFBUSxHQUFPO0FBQUEsRUFDOUIsQ0FBQztBQUVELEtBQUcsb0VBQW9FLE1BQU07QUFDM0UsVUFBTSxXQUFXLGFBQWE7QUFBQSxNQUM1QixVQUFVLG1CQUFtQixhQUFhLEdBQU87QUFBQSxJQUNuRCxDQUFDO0FBQ0QsVUFBTSxRQUE0QjtBQUFBLE1BQ2hDLFFBQVEsRUFBRSxXQUFXLG9CQUFvQjtBQUFBLElBQzNDO0FBRUEsVUFBTSxTQUFTLDZCQUE2QixVQUFVLE9BQU8sR0FBTztBQUNwRSxXQUFPLE1BQU0sUUFBUSxHQUFPO0FBQUEsRUFDOUIsQ0FBQztBQUVELEtBQUcsdUVBQXVFLE1BQU07QUFDOUUsVUFBTSxXQUFXLGFBQWE7QUFBQSxNQUM1QixVQUFVLG1CQUFtQixhQUFhLEdBQU87QUFBQSxJQUNuRCxDQUFDO0FBQ0QsVUFBTSxRQUE0QixFQUFFLFFBQVEsQ0FBQyxFQUFFO0FBRS9DLFVBQU0sU0FBUyw2QkFBNkIsVUFBVSxPQUFPLEtBQU87QUFDcEUsV0FBTyxNQUFNLFFBQVEsS0FBTztBQUFBLEVBQzlCLENBQUM7QUFFRCxLQUFHLCtFQUErRSxNQUFNO0FBQ3RGLFVBQU0sV0FBVyxhQUFhLENBQUMsQ0FBQztBQUNoQyxVQUFNLFFBQTRCLEVBQUUsUUFBUSxDQUFDLEVBQUU7QUFFL0MsVUFBTSxTQUFTLDZCQUE2QixVQUFVLE9BQU8sS0FBVyxhQUFhO0FBQ3JGLFdBQU8sTUFBTSxRQUFRLEdBQU87QUFBQSxFQUM5QixDQUFDO0FBRUQsS0FBRyxzREFBc0QsTUFBTTtBQUM3RCxVQUFNLFdBQVcsYUFBYSxDQUFDLENBQUM7QUFDaEMsVUFBTSxRQUE0QixFQUFFLFFBQVEsQ0FBQyxFQUFFO0FBRS9DLFVBQU0sU0FBUyw2QkFBNkIsVUFBVSxPQUFPLEtBQVcsUUFBUTtBQUNoRixXQUFPLE1BQU0sUUFBUSxHQUFTO0FBQUEsRUFDaEMsQ0FBQztBQUVELEtBQUcsNERBQTRELE1BQU07QUFDbkUsVUFBTSxXQUFXLGFBQWEsQ0FBQyxDQUFDO0FBQ2hDLFVBQU0sUUFBNEIsRUFBRSxRQUFRLEVBQUUsV0FBVyxVQUFVLEVBQUU7QUFFckUsVUFBTSxTQUFTLDZCQUE2QixVQUFVLEtBQUs7QUFDM0QsV0FBTyxNQUFNLFFBQVEsR0FBTztBQUFBLEVBQzlCLENBQUM7QUFFRCxLQUFHLGlEQUFpRCxNQUFNO0FBQ3hELFVBQU0sU0FBUyw2QkFBNkIsUUFBVyxNQUFTO0FBQ2hFLFdBQU8sTUFBTSxRQUFRLEdBQU87QUFBQSxFQUM5QixDQUFDO0FBRUQsS0FBRyw4Q0FBOEMsTUFBTTtBQUNyRCxVQUFNLFFBQTRCLEVBQUUsUUFBUSxFQUFFLFdBQVcsa0JBQWtCLEVBQUU7QUFDN0UsVUFBTSxTQUFTLDZCQUE2QixRQUFXLEtBQUs7QUFDNUQsV0FBTyxNQUFNLFFBQVEsR0FBTztBQUFBLEVBQzlCLENBQUM7QUFFRCxLQUFHLDhDQUF5QyxNQUFNO0FBQ2hELFVBQU0sV0FBVyxhQUFhO0FBQUEsTUFDNUIsVUFBVSxnQkFBZ0IsUUFBUSxDQUFDO0FBQUEsSUFDckMsQ0FBQztBQUNELFVBQU0sUUFBNEIsRUFBRSxRQUFRLEVBQUUsV0FBVyxlQUFlLEVBQUU7QUFFMUUsVUFBTSxTQUFTLDZCQUE2QixVQUFVLE9BQU8sS0FBTztBQUNwRSxXQUFPLE1BQU0sUUFBUSxLQUFPO0FBQUEsRUFDOUIsQ0FBQztBQUVELEtBQUcseUNBQW9DLE1BQU07QUFDM0MsVUFBTSxXQUFXLGFBQWEsQ0FBQyxDQUFDO0FBQ2hDLFVBQU0sUUFBNEIsQ0FBQztBQUVuQyxVQUFNLFNBQVMsNkJBQTZCLFVBQVUsT0FBTyxFQUFFO0FBQy9ELFdBQU8sTUFBTSxRQUFRLEdBQU87QUFBQSxFQUM5QixDQUFDO0FBQ0gsQ0FBQztBQUlELFNBQVMsZ0RBQWdELE1BQU07QUFDN0QsS0FBRyxpRUFBaUUsTUFBTTtBQUN4RSxVQUFNLGlCQUFpQixlQUFlLEdBQU87QUFDN0MsVUFBTSxtQkFBbUIsZUFBZSxLQUFTLFdBQVc7QUFJNUQsV0FBTztBQUFBLE1BQ0wsaUJBQWlCLHFCQUFxQixlQUFlO0FBQUEsTUFDckQsc0JBQXNCLGlCQUFpQixrQkFBa0Isa0NBQWtDLGVBQWUsa0JBQWtCO0FBQUEsSUFDOUg7QUFDQSxXQUFPO0FBQUEsTUFDTCxpQkFBaUIsMkJBQTJCLGVBQWU7QUFBQSxNQUMzRCxxQkFBcUIsaUJBQWlCLHdCQUF3QixrQ0FBa0MsZUFBZSx3QkFBd0I7QUFBQSxJQUN6STtBQUFBLEVBQ0YsQ0FBQztBQUVELEtBQUcsc0VBQXNFLE1BQU07QUFDN0UsVUFBTSxpQkFBaUIsZUFBZSxLQUFPO0FBQzdDLFVBQU0sZ0JBQWdCLGVBQWUsT0FBUyxRQUFRO0FBRXRELFdBQU8sZ0JBQWdCLGVBQWUsY0FBYztBQUFBLEVBQ3RELENBQUM7QUFFRCxLQUFHLHlEQUF5RCxNQUFNO0FBQ2hFLFVBQU0sSUFBSSxlQUFlLEtBQVMsV0FBVztBQUU3QyxXQUFPLE1BQU0sRUFBRSxvQkFBb0IsS0FBSyxNQUFNLE1BQVUsSUFBSSxDQUFDO0FBQzdELFdBQU8sTUFBTSxFQUFFLDBCQUEwQixLQUFLLE1BQU0sTUFBVSxHQUFJLENBQUM7QUFDbkUsV0FBTyxNQUFNLEVBQUUseUJBQXlCLEtBQUssTUFBTSxNQUFVLEdBQUksQ0FBQztBQUFBLEVBQ3BFLENBQUM7QUFFRCxLQUFHLDhEQUE4RCxNQUFNO0FBQ3JFLFVBQU0sbUJBQW1CLGVBQWUsS0FBUyxXQUFXO0FBQzVELFVBQU0saUJBQWlCLGVBQWUsS0FBUyxTQUFTO0FBRXhELFdBQU8sZ0JBQWdCLGdCQUFnQixnQkFBZ0I7QUFBQSxFQUN6RCxDQUFDO0FBRUQsS0FBRyx5REFBeUQsTUFBTTtBQUNoRSxVQUFNLElBQUksZUFBZSxLQUFPO0FBRWhDLFdBQU8sTUFBTSxFQUFFLG9CQUFvQixLQUFLLE1BQU0sUUFBVSxJQUFJLENBQUM7QUFDN0QsV0FBTyxNQUFNLEVBQUUsMEJBQTBCLEtBQUssTUFBTSxRQUFVLEdBQUksQ0FBQztBQUNuRSxXQUFPLE1BQU0sRUFBRSx5QkFBeUIsS0FBSyxNQUFNLFFBQVUsR0FBSSxDQUFDO0FBQ2xFLFdBQU8sTUFBTSxFQUFFLDBCQUEwQixFQUFFO0FBQzNDLFdBQU8sTUFBTSxFQUFFLGVBQWUsS0FBSyxDQUFDO0FBQ3BDLFdBQU8sTUFBTSxFQUFFLGVBQWUsS0FBSyxDQUFDO0FBQUEsRUFDdEMsQ0FBQztBQUVELEtBQUcsOENBQThDLE1BQU07QUFDckQsVUFBTSxpQkFBaUIsZUFBZSxHQUFPO0FBQzdDLFVBQU0sbUJBQW1CLGVBQWUsS0FBUyxXQUFXO0FBRTVELFdBQU8sZ0JBQWdCLGlCQUFpQixnQkFBZ0IsZUFBZSxjQUFjO0FBQ3JGLFdBQU8sTUFBTSxpQkFBaUIsMEJBQTBCLGVBQWUsd0JBQXdCO0FBQUEsRUFDakcsQ0FBQztBQUVELEtBQUcsNERBQXVELE1BQU07QUFDOUQsVUFBTSxJQUFJLGVBQWUsR0FBRyxXQUFXO0FBQ3ZDLFVBQU0sT0FBTyxlQUFlLEtBQVMsV0FBVztBQUNoRCxXQUFPLGdCQUFnQixHQUFHLElBQUk7QUFBQSxFQUNoQyxDQUFDO0FBQ0gsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
