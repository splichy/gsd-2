import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { generateSummary, estimateTokens, chunkMessages, isDegenerateSummary, CompactionProducedNoSummaryError } from "./compaction.js";
import { estimateSerializedTokens } from "./utils.js";
function makeUserMessage(tokenCount) {
  const text = "x".repeat(tokenCount * 4);
  return { role: "user", content: text };
}
function makeToolResultMessage(rawTokenCount) {
  const text = "y".repeat(rawTokenCount * 4);
  return {
    role: "toolResult",
    toolCallId: `call_${rawTokenCount}`,
    content: [{ type: "text", text }]
  };
}
function makeBranchSummaryMessage(approxTokens) {
  const summary = "z".repeat(approxTokens * 4);
  return {
    role: "branchSummary",
    summary,
    fromId: "test",
    timestamp: 0
  };
}
function makeModel(contextWindow) {
  return {
    id: "test-model",
    name: "Test Model",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 4096
  };
}
function makeFakeResponse(text) {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn"
  };
}
describe("chunkMessages", () => {
  it("returns a single chunk when messages fit in budget", () => {
    const messages = [
      makeUserMessage(1e3),
      makeUserMessage(1e3)
    ];
    const chunks = chunkMessages(messages, 1e5);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].length, 2);
  });
  it("splits messages into multiple chunks when they exceed budget", () => {
    const messages = [
      makeBranchSummaryMessage(5e4),
      makeBranchSummaryMessage(5e4),
      makeBranchSummaryMessage(5e4)
    ];
    const chunks = chunkMessages(messages, 8e4);
    assert.ok(chunks.length > 1, `Expected multiple chunks, got ${chunks.length}`);
    const totalMessages = chunks.reduce((sum, c) => sum + c.length, 0);
    assert.equal(totalMessages, 3);
  });
  it("puts a single oversized message in its own chunk", () => {
    const messages = [makeBranchSummaryMessage(2e5)];
    const chunks = chunkMessages(messages, 8e4);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].length, 1);
  });
  it("preserves message order across chunks", () => {
    const messages = [
      makeBranchSummaryMessage(3e4),
      makeBranchSummaryMessage(3e4),
      makeBranchSummaryMessage(3e4),
      makeBranchSummaryMessage(3e4)
    ];
    const chunks = chunkMessages(messages, 5e4);
    const flat = chunks.flat();
    assert.equal(flat.length, 4);
    for (let i = 0; i < flat.length; i++) {
      assert.strictEqual(flat[i], messages[i], `Message ${i} should be in order`);
    }
  });
  it("(#4665) does not over-split when tool results dominate \u2014 they serialize to ~500 tokens", () => {
    const messages = Array.from(
      { length: 10 },
      () => makeToolResultMessage(1e5)
    );
    const chunks = chunkMessages(messages, 5e4);
    assert.equal(
      chunks.length,
      1,
      "ten 100K-token tool results should coalesce into one chunk (cap=2000 chars \u2192 ~500 tokens each)"
    );
    assert.equal(chunks[0].length, 10);
  });
  it("(#4665) estimateSerializedTokens caps toolResult at TOOL_RESULT_MAX_CHARS/4", () => {
    const huge = makeToolResultMessage(1e5);
    const serialized = estimateSerializedTokens(huge);
    const raw = estimateTokens(huge);
    assert.ok(raw > 5e4, `raw estimator should report the real size, got ${raw}`);
    assert.ok(
      serialized < 1e3,
      `serialized estimator should cap at ~500 tokens, got ${serialized}`
    );
  });
  it("(#4665) estimateSerializedTokens also caps large user content and assistant thinking", () => {
    const hugeUser = makeUserMessage(5e4);
    assert.ok(
      estimateSerializedTokens(hugeUser) < 1e3,
      "user content > cap must be truncated in the estimator"
    );
    const hugeAssistant = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "t".repeat(1e5) },
        { type: "text", text: "r".repeat(1e5) }
      ]
    };
    assert.ok(
      estimateSerializedTokens(hugeAssistant) < 2e3,
      "assistant thinking + text must each cap; total under 2x TOOL_RESULT_MAX_CHARS/4"
    );
  });
});
describe("generateSummary \u2014 chunked fallback (#2932)", () => {
  it("calls _completeFn multiple times when messages exceed model context window", async () => {
    const messages = [
      makeBranchSummaryMessage(8e4),
      makeBranchSummaryMessage(8e4),
      makeBranchSummaryMessage(8e4)
    ];
    const model = makeModel(2e5);
    const reserveTokens = 16384;
    let totalTokens = 0;
    for (const m of messages) totalTokens += estimateSerializedTokens(m);
    assert.ok(
      totalTokens > model.contextWindow,
      `Test setup: ${totalTokens} tokens should exceed ${model.contextWindow} context window`
    );
    const calls = [];
    const mockComplete = mock.fn(async (_model, context, _options) => {
      const userMsg = context.messages?.[0];
      const text = typeof userMsg?.content === "string" ? userMsg.content : userMsg?.content?.[0]?.text ?? "";
      if (text.includes("<previous-summary>")) {
        calls.push("update");
      } else {
        calls.push("initial");
      }
      return makeFakeResponse(
        "## Goal\nDetailed summary of this chunk describing the work completed, files touched, and decisions made. At least 100 characters so the degenerate guard does not trip."
      );
    });
    const summary = await generateSummary(
      messages,
      model,
      reserveTokens,
      void 0,
      // apiKey
      void 0,
      // signal
      void 0,
      // customInstructions
      void 0,
      // previousSummary
      mockComplete
      // _completeFn override for testing
    );
    assert.ok(
      mockComplete.mock.callCount() > 1,
      `Expected multiple calls for chunked summarization, got ${mockComplete.mock.callCount()}`
    );
    assert.equal(calls[0], "initial", "First chunk should use initial summarization prompt");
    for (let i = 1; i < calls.length; i++) {
      assert.equal(calls[i], "update", `Chunk ${i + 1} should use update summarization prompt`);
    }
    assert.ok(summary.length > 0, "Summary should not be empty");
  });
  it("uses single-pass when messages fit within model context window", async () => {
    const messages = [
      makeUserMessage(1e4),
      makeUserMessage(1e4)
    ];
    const model = makeModel(2e5);
    const reserveTokens = 16384;
    let totalTokens = 0;
    for (const m of messages) totalTokens += estimateTokens(m);
    assert.ok(
      totalTokens < model.contextWindow,
      `Test setup: ${totalTokens} tokens should fit in ${model.contextWindow} context window`
    );
    const mockComplete = mock.fn(async () => makeFakeResponse("Single pass summary"));
    await generateSummary(messages, model, reserveTokens, void 0, void 0, void 0, void 0, mockComplete);
    assert.equal(
      mockComplete.mock.callCount(),
      1,
      "Should use single-pass summarization when messages fit in context window"
    );
  });
  it("passes previousSummary through chunked summarization", async () => {
    const messages = [
      makeBranchSummaryMessage(8e4),
      makeBranchSummaryMessage(8e4),
      makeBranchSummaryMessage(8e4)
    ];
    const model = makeModel(2e5);
    const reserveTokens = 16384;
    const previousSummary = "Previous session summary content \u2014 intentionally verbose enough to clear the degenerate-summary threshold so this test exercises the actual propagation path.";
    const prompts = [];
    const mockComplete = mock.fn(async (_model, context) => {
      const userMsg = context.messages?.[0];
      const text = typeof userMsg?.content === "string" ? userMsg.content : userMsg?.content?.[0]?.text ?? "";
      prompts.push(text);
      return makeFakeResponse(
        "Chunk summary with sufficient length to clear the #4665 degenerate-output guard threshold of 100 characters \u2014 this must be longer."
      );
    });
    await generateSummary(
      messages,
      model,
      reserveTokens,
      void 0,
      void 0,
      void 0,
      previousSummary,
      mockComplete
    );
    assert.ok(
      prompts[0].includes(previousSummary),
      "First chunk should incorporate the previousSummary"
    );
  });
});
describe("(#4665) degenerate summary guard", () => {
  it("isDegenerateSummary detects the known failure patterns", () => {
    assert.equal(isDegenerateSummary(void 0), false);
    assert.equal(isDegenerateSummary(""), true, "empty string is degenerate");
    assert.equal(isDegenerateSummary("too short"), true, "short output is degenerate");
    assert.equal(
      isDegenerateSummary("The user asked me to summarize an empty conversation"),
      true,
      "known failure phrase 'empty conversation' is degenerate"
    );
    assert.equal(
      isDegenerateSummary("No conversation to summarize"),
      true,
      "'no conversation to summarize' is degenerate"
    );
    assert.equal(
      isDegenerateSummary(
        "## Goal\nRefactor the compaction pipeline.\n## Done\n- Updated utils.ts\n- Added tests for #4665 regression path"
      ),
      false,
      "a real multi-section summary over 100 chars is not degenerate"
    );
  });
  it("does not propagate a degenerate first-chunk summary forward (no 'preserve nothing' chain)", async () => {
    const messages = [
      makeBranchSummaryMessage(8e4),
      makeBranchSummaryMessage(8e4),
      makeBranchSummaryMessage(8e4)
    ];
    const model = makeModel(2e5);
    const reserveTokens = 16384;
    let callIndex = 0;
    const responses = [
      "The user asked me to summarize an empty conversation.",
      "## Done\n- Refactored the serializer to head+tail truncation.\n- Updated chunker to use post-serialization token estimate.",
      "## Done\n- Added regression tests for #4665 including this propagation guard.\n- Verified isDegenerateSummary handles known failure patterns."
    ];
    const seenPrompts = [];
    const mockComplete = mock.fn(async (_model, context) => {
      const userMsg = context.messages?.[0];
      const text = typeof userMsg?.content === "string" ? userMsg.content : userMsg?.content?.[0]?.text ?? "";
      seenPrompts.push(text);
      const response = responses[Math.min(callIndex, responses.length - 1)];
      callIndex++;
      return makeFakeResponse(response);
    });
    const summary = await generateSummary(
      messages,
      model,
      reserveTokens,
      void 0,
      void 0,
      void 0,
      void 0,
      mockComplete
    );
    assert.ok(
      !isDegenerateSummary(summary),
      `final summary should not be degenerate. got: ${JSON.stringify(summary)}`
    );
    assert.ok(
      summary.includes("Refactored") || summary.includes("regression tests"),
      "final summary should carry real information from chunks 1 or 2"
    );
  });
  it("retries the first chunk once with the initial prompt if the first pass is degenerate", async () => {
    const messages = [
      makeBranchSummaryMessage(8e4),
      makeBranchSummaryMessage(8e4)
    ];
    const model = makeModel(1e5);
    const reserveTokens = 16384;
    const responses = [
      "",
      // first attempt: empty string → degenerate
      "## Goal\nReal summary produced on the retry pass after the initial pass came back empty \u2014 this should land as the running summary.",
      "## Done\n- Added retry-on-degenerate-first-chunk behavior to the iterative summarizer so empty outputs don't poison the chain."
    ];
    let callIndex = 0;
    const mockComplete = mock.fn(async () => {
      const response = responses[Math.min(callIndex, responses.length - 1)];
      callIndex++;
      return makeFakeResponse(response);
    });
    const summary = await generateSummary(
      messages,
      model,
      reserveTokens,
      void 0,
      void 0,
      void 0,
      void 0,
      mockComplete
    );
    assert.ok(
      !isDegenerateSummary(summary),
      "final summary must not be degenerate after the retry took effect"
    );
    assert.ok(
      mockComplete.mock.callCount() >= 3,
      `expected at least 3 calls (first attempt, retry, second chunk), got ${mockComplete.mock.callCount()}`
    );
  });
  it("(R1) retries a degenerate NON-FIRST chunk before silently dropping it", async () => {
    const messages = [
      makeBranchSummaryMessage(8e4),
      makeBranchSummaryMessage(8e4)
    ];
    const model = makeModel(1e5);
    const reserveTokens = 16384;
    const CHUNK0_SUMMARY = "## Done\n- Chunk 0 real summary with enough length to clear the degenerate threshold of 100 characters \u2014 easily.";
    const CHUNK1_RETRY_SUMMARY = "## Done\n- Chunk 1 recovered on retry \u2014 its content must appear in the final summary or the R1 fix regressed for non-first chunks.";
    let callIndex = 0;
    const responses = [
      CHUNK0_SUMMARY,
      // chunk 0
      "empty conversation",
      // chunk 1 first try → degenerate
      CHUNK1_RETRY_SUMMARY
      // chunk 1 retry → real
    ];
    const mockComplete = mock.fn(async () => {
      const r = responses[Math.min(callIndex, responses.length - 1)];
      callIndex++;
      return makeFakeResponse(r);
    });
    const summary = await generateSummary(
      messages,
      model,
      reserveTokens,
      void 0,
      void 0,
      void 0,
      void 0,
      mockComplete
    );
    assert.equal(
      mockComplete.mock.callCount(),
      3,
      "expected 3 calls: chunk 0 + chunk 1 initial + chunk 1 retry"
    );
    assert.ok(
      summary.includes("recovered on retry"),
      `final summary must include chunk 1's retry content (R1: non-first chunks must also retry), got: ${JSON.stringify(summary)}`
    );
  });
  it("(R6) throws CompactionProducedNoSummaryError when every chunk is degenerate AND no previousSummary", async () => {
    const messages = [
      makeBranchSummaryMessage(8e4),
      makeBranchSummaryMessage(8e4)
    ];
    const model = makeModel(1e5);
    const reserveTokens = 16384;
    const mockComplete = mock.fn(async () => makeFakeResponse("empty conversation"));
    await assert.rejects(
      () => generateSummary(
        messages,
        model,
        reserveTokens,
        void 0,
        void 0,
        void 0,
        void 0,
        // no previousSummary
        mockComplete
      ),
      (err) => err instanceof CompactionProducedNoSummaryError,
      "expected CompactionProducedNoSummaryError when all chunks degenerate and no previousSummary"
    );
  });
  it("(R6) falls back to previousSummary when every chunk is degenerate", async () => {
    const messages = [
      makeBranchSummaryMessage(8e4),
      makeBranchSummaryMessage(8e4)
    ];
    const model = makeModel(1e5);
    const reserveTokens = 16384;
    const previousSummary = "Previously-computed summary from the last compaction \u2014 deliberately long enough to clear the degenerate-output threshold.";
    const mockComplete = mock.fn(async () => makeFakeResponse("empty conversation"));
    const result = await generateSummary(
      messages,
      model,
      reserveTokens,
      void 0,
      void 0,
      void 0,
      previousSummary,
      mockComplete
    );
    assert.equal(
      result,
      previousSummary,
      "when all chunks degenerate, must fall back to previousSummary rather than return empty string"
    );
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL2NvbXBhY3Rpb24vY29tcGFjdGlvbi50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFRlc3RzIGZvciBjaHVua2VkIGNvbXBhY3Rpb24gZmFsbGJhY2sgd2hlbiBtZXNzYWdlcyBleGNlZWQgbW9kZWwgY29udGV4dCB3aW5kb3cuXG4gKiBSZWdyZXNzaW9uIHRlc3QgZm9yICMyOTMyLlxuICovXG5cbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgZGVzY3JpYmUsIGl0LCBtb2NrIH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuXG5pbXBvcnQgdHlwZSB7IEFnZW50TWVzc2FnZSB9IGZyb20gXCJAZ3NkL3BpLWFnZW50LWNvcmVcIjtcbmltcG9ydCB0eXBlIHsgTW9kZWwsIEFzc2lzdGFudE1lc3NhZ2UgfSBmcm9tIFwiQGdzZC9waS1haVwiO1xuXG5pbXBvcnQgeyBnZW5lcmF0ZVN1bW1hcnksIGVzdGltYXRlVG9rZW5zLCBjaHVua01lc3NhZ2VzLCBpc0RlZ2VuZXJhdGVTdW1tYXJ5LCBDb21wYWN0aW9uUHJvZHVjZWROb1N1bW1hcnlFcnJvciB9IGZyb20gXCIuL2NvbXBhY3Rpb24uanNcIjtcbmltcG9ydCB7IGVzdGltYXRlU2VyaWFsaXplZFRva2VucyB9IGZyb20gXCIuL3V0aWxzLmpzXCI7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gSGVscGVyc1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKiBDcmVhdGUgYSB1c2VyIG1lc3NhZ2Ugd2l0aCBhcHByb3hpbWF0ZWx5IGB0b2tlbkNvdW50YCB0b2tlbnMgKGNoYXJzID0gdG9rZW5zICogNCkuICovXG5mdW5jdGlvbiBtYWtlVXNlck1lc3NhZ2UodG9rZW5Db3VudDogbnVtYmVyKTogQWdlbnRNZXNzYWdlIHtcblx0Y29uc3QgdGV4dCA9IFwieFwiLnJlcGVhdCh0b2tlbkNvdW50ICogNCk7XG5cdHJldHVybiB7IHJvbGU6IFwidXNlclwiLCBjb250ZW50OiB0ZXh0IH0gYXMgdW5rbm93biBhcyBBZ2VudE1lc3NhZ2U7XG59XG5cbi8qKlxuICogQ3JlYXRlIGEgdG9vbC1yZXN1bHQgbWVzc2FnZSBvZiBhcHByb3hpbWF0ZWx5IGByYXdUb2tlbkNvdW50YCB1bmNhcHBlZCB0b2tlbnMuXG4gKiBQb3N0LXRydW5jYXRpb24sIHRoaXMgZXN0aW1hdGVzIHRvIH41MDAgdG9rZW5zIChUT09MX1JFU1VMVF9NQVhfQ0hBUlMgLyA0KS5cbiAqXG4gKiBVc2VkIHRvIGV4ZXJjaXNlIHRoZSAjNDY2NSByZWdyZXNzaW9uOiBiZWZvcmUgdGhlIGZpeCwgY2h1bmtNZXNzYWdlcyB1c2VkXG4gKiBlc3RpbWF0ZVRva2VucyAocHJlLXRydW5jYXRpb24pLCBzbyBhIDEwMEstdG9rZW4gdG9vbCByZXN1bHQgZm9yY2VkIGl0cyBvd25cbiAqIGNodW5rIGV2ZW4gdGhvdWdoIGl0IHNlcmlhbGl6ZWQgdG8gfjUwMCB0b2tlbnMuIEFmdGVyIHRoZSBmaXgsIG1hbnkgdG9vbFxuICogcmVzdWx0cyBjb2FsZXNjZSBpbnRvIGEgc2luZ2xlIGNodW5rLlxuICovXG5mdW5jdGlvbiBtYWtlVG9vbFJlc3VsdE1lc3NhZ2UocmF3VG9rZW5Db3VudDogbnVtYmVyKTogQWdlbnRNZXNzYWdlIHtcblx0Y29uc3QgdGV4dCA9IFwieVwiLnJlcGVhdChyYXdUb2tlbkNvdW50ICogNCk7XG5cdHJldHVybiB7XG5cdFx0cm9sZTogXCJ0b29sUmVzdWx0XCIsXG5cdFx0dG9vbENhbGxJZDogYGNhbGxfJHtyYXdUb2tlbkNvdW50fWAsXG5cdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQgfV0sXG5cdH0gYXMgdW5rbm93biBhcyBBZ2VudE1lc3NhZ2U7XG59XG5cbi8qKlxuICogQ3JlYXRlIGEgYnJhbmNoLXN1bW1hcnkgbWVzc2FnZSB3aXRoIGEgc3BlY2lmaWMgc3VtbWFyeSBsZW5ndGguIFN1bW1hcnlcbiAqIG1lc3NhZ2VzIGFyZSBpbnRlbnRpb25hbGx5IE5PVCB0cnVuY2F0ZWQgYnkgdGhlIHNlcmlhbGl6ZXIgKHRoZXkncmUgYWxyZWFkeVxuICogY29uY2lzZSksIHNvIHRoaXMgaXMgdGhlIHJpZ2h0IHRvb2wgdG8gZm9yY2UgY2h1bmtpbmcgcG9zdC1maXguXG4gKi9cbmZ1bmN0aW9uIG1ha2VCcmFuY2hTdW1tYXJ5TWVzc2FnZShhcHByb3hUb2tlbnM6IG51bWJlcik6IEFnZW50TWVzc2FnZSB7XG5cdGNvbnN0IHN1bW1hcnkgPSBcInpcIi5yZXBlYXQoYXBwcm94VG9rZW5zICogNCk7XG5cdHJldHVybiB7XG5cdFx0cm9sZTogXCJicmFuY2hTdW1tYXJ5XCIsXG5cdFx0c3VtbWFyeSxcblx0XHRmcm9tSWQ6IFwidGVzdFwiLFxuXHRcdHRpbWVzdGFtcDogMCxcblx0fSBhcyB1bmtub3duIGFzIEFnZW50TWVzc2FnZTtcbn1cblxuLyoqIENyZWF0ZSBhIG1vY2sgbW9kZWwgd2l0aCBhIGdpdmVuIGNvbnRleHQgd2luZG93LiAqL1xuZnVuY3Rpb24gbWFrZU1vZGVsKGNvbnRleHRXaW5kb3c6IG51bWJlcik6IE1vZGVsPGFueT4ge1xuXHRyZXR1cm4ge1xuXHRcdGlkOiBcInRlc3QtbW9kZWxcIixcblx0XHRuYW1lOiBcIlRlc3QgTW9kZWxcIixcblx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0cHJvdmlkZXI6IFwiYW50aHJvcGljXCIsXG5cdFx0YmFzZVVybDogXCJodHRwczovL2FwaS50ZXN0XCIsXG5cdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRjb3N0OiB7IGlucHV0OiAwLCBvdXRwdXQ6IDAsIGNhY2hlUmVhZDogMCwgY2FjaGVXcml0ZTogMCB9LFxuXHRcdGNvbnRleHRXaW5kb3csXG5cdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHR9IGFzIE1vZGVsPGFueT47XG59XG5cbmZ1bmN0aW9uIG1ha2VGYWtlUmVzcG9uc2UodGV4dDogc3RyaW5nKTogQXNzaXN0YW50TWVzc2FnZSB7XG5cdHJldHVybiB7XG5cdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQgfV0sXG5cdFx0c3RvcFJlYXNvbjogXCJlbmRfdHVyblwiLFxuXHR9IGFzIHVua25vd24gYXMgQXNzaXN0YW50TWVzc2FnZTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBjaHVua01lc3NhZ2VzIHRlc3RzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZGVzY3JpYmUoXCJjaHVua01lc3NhZ2VzXCIsICgpID0+IHtcblx0aXQoXCJyZXR1cm5zIGEgc2luZ2xlIGNodW5rIHdoZW4gbWVzc2FnZXMgZml0IGluIGJ1ZGdldFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgbWVzc2FnZXM6IEFnZW50TWVzc2FnZVtdID0gW1xuXHRcdFx0bWFrZVVzZXJNZXNzYWdlKDFfMDAwKSxcblx0XHRcdG1ha2VVc2VyTWVzc2FnZSgxXzAwMCksXG5cdFx0XTtcblx0XHRjb25zdCBjaHVua3MgPSBjaHVua01lc3NhZ2VzKG1lc3NhZ2VzLCAxMDBfMDAwKTtcblx0XHRhc3NlcnQuZXF1YWwoY2h1bmtzLmxlbmd0aCwgMSk7XG5cdFx0YXNzZXJ0LmVxdWFsKGNodW5rc1swXS5sZW5ndGgsIDIpO1xuXHR9KTtcblxuXHRpdChcInNwbGl0cyBtZXNzYWdlcyBpbnRvIG11bHRpcGxlIGNodW5rcyB3aGVuIHRoZXkgZXhjZWVkIGJ1ZGdldFwiLCAoKSA9PiB7XG5cdFx0Ly8gVXNlIGJyYW5jaFN1bW1hcnkgbWVzc2FnZXMgXHUyMDE0IHRoZXkgYXJlbid0IGNhcHBlZCBieSB0aGUgc2VyaWFsaXplciwgc29cblx0XHQvLyB0aGVpciBwb3N0LXNlcmlhbGl6YXRpb24gc2l6ZSBtYXRjaGVzIHRoZWlyIHJhdyBzaXplLiBFYWNoIDUway10b2tlblxuXHRcdC8vIHN1bW1hcnkgbXVzdCBnZXQgaXRzIG93biBjaHVuayB1bmRlciBhbiA4MGsgYnVkZ2V0LlxuXHRcdGNvbnN0IG1lc3NhZ2VzOiBBZ2VudE1lc3NhZ2VbXSA9IFtcblx0XHRcdG1ha2VCcmFuY2hTdW1tYXJ5TWVzc2FnZSg1MF8wMDApLFxuXHRcdFx0bWFrZUJyYW5jaFN1bW1hcnlNZXNzYWdlKDUwXzAwMCksXG5cdFx0XHRtYWtlQnJhbmNoU3VtbWFyeU1lc3NhZ2UoNTBfMDAwKSxcblx0XHRdO1xuXHRcdGNvbnN0IGNodW5rcyA9IGNodW5rTWVzc2FnZXMobWVzc2FnZXMsIDgwXzAwMCk7XG5cdFx0YXNzZXJ0Lm9rKGNodW5rcy5sZW5ndGggPiAxLCBgRXhwZWN0ZWQgbXVsdGlwbGUgY2h1bmtzLCBnb3QgJHtjaHVua3MubGVuZ3RofWApO1xuXHRcdGNvbnN0IHRvdGFsTWVzc2FnZXMgPSBjaHVua3MucmVkdWNlKChzdW0sIGMpID0+IHN1bSArIGMubGVuZ3RoLCAwKTtcblx0XHRhc3NlcnQuZXF1YWwodG90YWxNZXNzYWdlcywgMyk7XG5cdH0pO1xuXG5cdGl0KFwicHV0cyBhIHNpbmdsZSBvdmVyc2l6ZWQgbWVzc2FnZSBpbiBpdHMgb3duIGNodW5rXCIsICgpID0+IHtcblx0XHQvLyBVc2UgYnJhbmNoU3VtbWFyeSBcdTIwMTQgbm90IHRydW5jYXRlZCBieSB0aGUgc2VyaWFsaXplciBcdTIwMTQgdG8gZm9yY2UgdGhlXG5cdFx0Ly8gb3ZlcnNpemVkLXNpbmdsZS1tZXNzYWdlIHBhdGguIEEgdXNlciBtZXNzYWdlIHdpdGggdGhlIHNhbWUgcmF3IHNpemVcblx0XHQvLyB3b3VsZCBjYXAgdG8gfjUwMCB0b2tlbnMgYW5kIGZpdCBpbiBhbnkgcmVhc29uYWJsZSBidWRnZXQuXG5cdFx0Y29uc3QgbWVzc2FnZXM6IEFnZW50TWVzc2FnZVtdID0gW21ha2VCcmFuY2hTdW1tYXJ5TWVzc2FnZSgyMDBfMDAwKV07XG5cdFx0Y29uc3QgY2h1bmtzID0gY2h1bmtNZXNzYWdlcyhtZXNzYWdlcywgODBfMDAwKTtcblx0XHRhc3NlcnQuZXF1YWwoY2h1bmtzLmxlbmd0aCwgMSk7XG5cdFx0YXNzZXJ0LmVxdWFsKGNodW5rc1swXS5sZW5ndGgsIDEpO1xuXHR9KTtcblxuXHRpdChcInByZXNlcnZlcyBtZXNzYWdlIG9yZGVyIGFjcm9zcyBjaHVua3NcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IG1lc3NhZ2VzOiBBZ2VudE1lc3NhZ2VbXSA9IFtcblx0XHRcdG1ha2VCcmFuY2hTdW1tYXJ5TWVzc2FnZSgzMF8wMDApLFxuXHRcdFx0bWFrZUJyYW5jaFN1bW1hcnlNZXNzYWdlKDMwXzAwMCksXG5cdFx0XHRtYWtlQnJhbmNoU3VtbWFyeU1lc3NhZ2UoMzBfMDAwKSxcblx0XHRcdG1ha2VCcmFuY2hTdW1tYXJ5TWVzc2FnZSgzMF8wMDApLFxuXHRcdF07XG5cdFx0Y29uc3QgY2h1bmtzID0gY2h1bmtNZXNzYWdlcyhtZXNzYWdlcywgNTBfMDAwKTtcblx0XHRjb25zdCBmbGF0ID0gY2h1bmtzLmZsYXQoKTtcblx0XHRhc3NlcnQuZXF1YWwoZmxhdC5sZW5ndGgsIDQpO1xuXHRcdGZvciAobGV0IGkgPSAwOyBpIDwgZmxhdC5sZW5ndGg7IGkrKykge1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKGZsYXRbaV0sIG1lc3NhZ2VzW2ldLCBgTWVzc2FnZSAke2l9IHNob3VsZCBiZSBpbiBvcmRlcmApO1xuXHRcdH1cblx0fSk7XG5cblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdC8vICM0NjY1IHJlZ3Jlc3Npb246IHRva2VuIGVzdGltYXRpb24gbXVzdCByZWZsZWN0IHNlcmlhbGl6ZXIgdHJ1bmNhdGlvblxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuXHRpdChcIigjNDY2NSkgZG9lcyBub3Qgb3Zlci1zcGxpdCB3aGVuIHRvb2wgcmVzdWx0cyBkb21pbmF0ZSBcdTIwMTQgdGhleSBzZXJpYWxpemUgdG8gfjUwMCB0b2tlbnNcIiwgKCkgPT4ge1xuXHRcdC8vIFRlbiAxMDBLLXRva2VuIHRvb2wgcmVzdWx0cy4gVW5kZXIgdGhlIG9sZCBwcmUtdHJ1bmNhdGlvbiBlc3RpbWF0b3Jcblx0XHQvLyB0aGlzIHdvdWxkIGVzdGltYXRlIHRvIH4xTSB0b2tlbnMgYW5kIGZvcmNlIDEwKyB0aW55IGNodW5rcy4gVW5kZXJcblx0XHQvLyB0aGUgbmV3IGVzdGltYXRvciBlYWNoIGNhcHMgdG8gfjUwMCB0b2tlbnMgKFRPT0xfUkVTVUxUX01BWF9DSEFSUy80KSxcblx0XHQvLyBzbyAxMCBvZiB0aGVtIHRvdGFsIH41SyB0b2tlbnMgYW5kIGZpdCBpbiBhIHNpbmdsZSBnZW5lcm91cyBidWRnZXQuXG5cdFx0Y29uc3QgbWVzc2FnZXM6IEFnZW50TWVzc2FnZVtdID0gQXJyYXkuZnJvbSh7IGxlbmd0aDogMTAgfSwgKCkgPT5cblx0XHRcdG1ha2VUb29sUmVzdWx0TWVzc2FnZSgxMDBfMDAwKSxcblx0XHQpO1xuXHRcdGNvbnN0IGNodW5rcyA9IGNodW5rTWVzc2FnZXMobWVzc2FnZXMsIDUwXzAwMCk7XG5cdFx0YXNzZXJ0LmVxdWFsKFxuXHRcdFx0Y2h1bmtzLmxlbmd0aCxcblx0XHRcdDEsXG5cdFx0XHRcInRlbiAxMDBLLXRva2VuIHRvb2wgcmVzdWx0cyBzaG91bGQgY29hbGVzY2UgaW50byBvbmUgY2h1bmsgKGNhcD0yMDAwIGNoYXJzIFx1MjE5MiB+NTAwIHRva2VucyBlYWNoKVwiLFxuXHRcdCk7XG5cdFx0YXNzZXJ0LmVxdWFsKGNodW5rc1swXS5sZW5ndGgsIDEwKTtcblx0fSk7XG5cblx0aXQoXCIoIzQ2NjUpIGVzdGltYXRlU2VyaWFsaXplZFRva2VucyBjYXBzIHRvb2xSZXN1bHQgYXQgVE9PTF9SRVNVTFRfTUFYX0NIQVJTLzRcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGh1Z2UgPSBtYWtlVG9vbFJlc3VsdE1lc3NhZ2UoMTAwXzAwMCk7XG5cdFx0Y29uc3Qgc2VyaWFsaXplZCA9IGVzdGltYXRlU2VyaWFsaXplZFRva2VucyhodWdlKTtcblx0XHRjb25zdCByYXcgPSBlc3RpbWF0ZVRva2VucyhodWdlKTtcblx0XHRhc3NlcnQub2socmF3ID4gNTBfMDAwLCBgcmF3IGVzdGltYXRvciBzaG91bGQgcmVwb3J0IHRoZSByZWFsIHNpemUsIGdvdCAke3Jhd31gKTtcblx0XHRhc3NlcnQub2soXG5cdFx0XHRzZXJpYWxpemVkIDwgMV8wMDAsXG5cdFx0XHRgc2VyaWFsaXplZCBlc3RpbWF0b3Igc2hvdWxkIGNhcCBhdCB+NTAwIHRva2VucywgZ290ICR7c2VyaWFsaXplZH1gLFxuXHRcdCk7XG5cdH0pO1xuXG5cdGl0KFwiKCM0NjY1KSBlc3RpbWF0ZVNlcmlhbGl6ZWRUb2tlbnMgYWxzbyBjYXBzIGxhcmdlIHVzZXIgY29udGVudCBhbmQgYXNzaXN0YW50IHRoaW5raW5nXCIsICgpID0+IHtcblx0XHRjb25zdCBodWdlVXNlciA9IG1ha2VVc2VyTWVzc2FnZSg1MF8wMDApO1xuXHRcdGFzc2VydC5vayhcblx0XHRcdGVzdGltYXRlU2VyaWFsaXplZFRva2VucyhodWdlVXNlcikgPCAxXzAwMCxcblx0XHRcdFwidXNlciBjb250ZW50ID4gY2FwIG11c3QgYmUgdHJ1bmNhdGVkIGluIHRoZSBlc3RpbWF0b3JcIixcblx0XHQpO1xuXG5cdFx0Ly8gQXNzaXN0YW50IHdpdGggYSBodWdlIHRoaW5raW5nIGJsb2NrICsgaHVnZSB0ZXh0IGJsb2NrXG5cdFx0Y29uc3QgaHVnZUFzc2lzdGFudDogQWdlbnRNZXNzYWdlID0ge1xuXHRcdFx0cm9sZTogXCJhc3Npc3RhbnRcIixcblx0XHRcdGNvbnRlbnQ6IFtcblx0XHRcdFx0eyB0eXBlOiBcInRoaW5raW5nXCIsIHRoaW5raW5nOiBcInRcIi5yZXBlYXQoMTAwXzAwMCkgfSxcblx0XHRcdFx0eyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJyXCIucmVwZWF0KDEwMF8wMDApIH0sXG5cdFx0XHRdLFxuXHRcdH0gYXMgdW5rbm93biBhcyBBZ2VudE1lc3NhZ2U7XG5cdFx0YXNzZXJ0Lm9rKFxuXHRcdFx0ZXN0aW1hdGVTZXJpYWxpemVkVG9rZW5zKGh1Z2VBc3Npc3RhbnQpIDwgMl8wMDAsXG5cdFx0XHRcImFzc2lzdGFudCB0aGlua2luZyArIHRleHQgbXVzdCBlYWNoIGNhcDsgdG90YWwgdW5kZXIgMnggVE9PTF9SRVNVTFRfTUFYX0NIQVJTLzRcIixcblx0XHQpO1xuXHR9KTtcbn0pO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIGdlbmVyYXRlU3VtbWFyeSBjaHVua2VkIGZhbGxiYWNrIHRlc3RzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZGVzY3JpYmUoXCJnZW5lcmF0ZVN1bW1hcnkgXHUyMDE0IGNodW5rZWQgZmFsbGJhY2sgKCMyOTMyKVwiLCAoKSA9PiB7XG5cdGl0KFwiY2FsbHMgX2NvbXBsZXRlRm4gbXVsdGlwbGUgdGltZXMgd2hlbiBtZXNzYWdlcyBleGNlZWQgbW9kZWwgY29udGV4dCB3aW5kb3dcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdC8vIFVzZSBicmFuY2hTdW1tYXJ5IG1lc3NhZ2VzIFx1MjAxNCBub3QgY2FwcGVkIGJ5IHRoZSBzZXJpYWxpemVyIFx1MjAxNCBzbyB0aGVcblx0XHQvLyBjaHVua2VyJ3MgcG9zdC10cnVuY2F0aW9uIHZpZXcgbWF0Y2hlcyB0aGUgcmF3IHZpZXcuIDMgXHUwMEQ3IDgwayBzdW1tYXJpZXNcblx0XHQvLyB0b3RhbGxpbmcgMjQwayB0b2tlbnMgbXVzdCBleGNlZWQgYSAyMDBrIGNvbnRleHQgd2luZG93LlxuXHRcdGNvbnN0IG1lc3NhZ2VzOiBBZ2VudE1lc3NhZ2VbXSA9IFtcblx0XHRcdG1ha2VCcmFuY2hTdW1tYXJ5TWVzc2FnZSg4MF8wMDApLFxuXHRcdFx0bWFrZUJyYW5jaFN1bW1hcnlNZXNzYWdlKDgwXzAwMCksXG5cdFx0XHRtYWtlQnJhbmNoU3VtbWFyeU1lc3NhZ2UoODBfMDAwKSxcblx0XHRdO1xuXHRcdGNvbnN0IG1vZGVsID0gbWFrZU1vZGVsKDIwMF8wMDApO1xuXHRcdGNvbnN0IHJlc2VydmVUb2tlbnMgPSAxNl8zODQ7XG5cblx0XHQvLyBWZXJpZnkgb3VyIHRlc3Qgc2V0dXA6IG1lc3NhZ2VzIHJlYWxseSBkbyBleGNlZWQgdGhlIG1vZGVsIHdpbmRvdy5cblx0XHQvLyBVc2UgZXN0aW1hdGVTZXJpYWxpemVkVG9rZW5zIGJlY2F1c2UgdGhhdCdzIHdoYXQgZ2VuZXJhdGVTdW1tYXJ5IHVzZXNcblx0XHQvLyBmb3IgaXRzIFwiZG9lcyB0aGlzIGZpdD9cIiBkZWNpc2lvbiBwb3N0LSM0NjY1LlxuXHRcdGxldCB0b3RhbFRva2VucyA9IDA7XG5cdFx0Zm9yIChjb25zdCBtIG9mIG1lc3NhZ2VzKSB0b3RhbFRva2VucyArPSBlc3RpbWF0ZVNlcmlhbGl6ZWRUb2tlbnMobSk7XG5cdFx0YXNzZXJ0Lm9rKFxuXHRcdFx0dG90YWxUb2tlbnMgPiBtb2RlbC5jb250ZXh0V2luZG93LFxuXHRcdFx0YFRlc3Qgc2V0dXA6ICR7dG90YWxUb2tlbnN9IHRva2VucyBzaG91bGQgZXhjZWVkICR7bW9kZWwuY29udGV4dFdpbmRvd30gY29udGV4dCB3aW5kb3dgLFxuXHRcdCk7XG5cblx0XHQvLyBUcmFjayBjYWxsc1xuXHRcdGNvbnN0IGNhbGxzOiBzdHJpbmdbXSA9IFtdO1xuXHRcdGNvbnN0IG1vY2tDb21wbGV0ZSA9IG1vY2suZm4oYXN5bmMgKF9tb2RlbDogYW55LCBjb250ZXh0OiBhbnksIF9vcHRpb25zOiBhbnkpID0+IHtcblx0XHRcdGNvbnN0IHVzZXJNc2cgPSBjb250ZXh0Lm1lc3NhZ2VzPy5bMF07XG5cdFx0XHRjb25zdCB0ZXh0ID1cblx0XHRcdFx0dHlwZW9mIHVzZXJNc2c/LmNvbnRlbnQgPT09IFwic3RyaW5nXCJcblx0XHRcdFx0XHQ/IHVzZXJNc2cuY29udGVudFxuXHRcdFx0XHRcdDogdXNlck1zZz8uY29udGVudD8uWzBdPy50ZXh0ID8/IFwiXCI7XG5cblx0XHRcdGlmICh0ZXh0LmluY2x1ZGVzKFwiPHByZXZpb3VzLXN1bW1hcnk+XCIpKSB7XG5cdFx0XHRcdGNhbGxzLnB1c2goXCJ1cGRhdGVcIik7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRjYWxscy5wdXNoKFwiaW5pdGlhbFwiKTtcblx0XHRcdH1cblx0XHRcdC8vIFJldHVybiBhIG5vbi1kZWdlbmVyYXRlIHN1bW1hcnkgKD4xMDAgY2hhcnMpLiBTaG9ydCByZXNwb25zZXMgbGlrZVxuXHRcdFx0Ly8gXCJTdW1tYXJ5IG9mIGNodW5rXCIgd291bGQgdHJpcCB0aGUgIzQ2NjUgZGVnZW5lcmF0ZS1vdXRwdXQgZ3VhcmQsXG5cdFx0XHQvLyB3aGljaCBpcyBleGFjdGx5IHdoYXQgd2UgZG9uJ3Qgd2FudCB0byB0ZXN0IGhlcmUuXG5cdFx0XHRyZXR1cm4gbWFrZUZha2VSZXNwb25zZShcblx0XHRcdFx0XCIjIyBHb2FsXFxuRGV0YWlsZWQgc3VtbWFyeSBvZiB0aGlzIGNodW5rIGRlc2NyaWJpbmcgdGhlIHdvcmsgY29tcGxldGVkLCBmaWxlcyB0b3VjaGVkLCBhbmQgZGVjaXNpb25zIG1hZGUuIEF0IGxlYXN0IDEwMCBjaGFyYWN0ZXJzIHNvIHRoZSBkZWdlbmVyYXRlIGd1YXJkIGRvZXMgbm90IHRyaXAuXCIsXG5cdFx0XHQpO1xuXHRcdH0pO1xuXG5cdFx0Y29uc3Qgc3VtbWFyeSA9IGF3YWl0IGdlbmVyYXRlU3VtbWFyeShcblx0XHRcdG1lc3NhZ2VzLFxuXHRcdFx0bW9kZWwsXG5cdFx0XHRyZXNlcnZlVG9rZW5zLFxuXHRcdFx0dW5kZWZpbmVkLCAvLyBhcGlLZXlcblx0XHRcdHVuZGVmaW5lZCwgLy8gc2lnbmFsXG5cdFx0XHR1bmRlZmluZWQsIC8vIGN1c3RvbUluc3RydWN0aW9uc1xuXHRcdFx0dW5kZWZpbmVkLCAvLyBwcmV2aW91c1N1bW1hcnlcblx0XHRcdG1vY2tDb21wbGV0ZSwgLy8gX2NvbXBsZXRlRm4gb3ZlcnJpZGUgZm9yIHRlc3Rpbmdcblx0XHQpO1xuXG5cdFx0Ly8gQXNzZXJ0OiBzaG91bGQgaGF2ZSBjYWxsZWQgY29tcGxldGVTaW1wbGUgbW9yZSB0aGFuIG9uY2UgKGNodW5rZWQpXG5cdFx0YXNzZXJ0Lm9rKFxuXHRcdFx0bW9ja0NvbXBsZXRlLm1vY2suY2FsbENvdW50KCkgPiAxLFxuXHRcdFx0YEV4cGVjdGVkIG11bHRpcGxlIGNhbGxzIGZvciBjaHVua2VkIHN1bW1hcml6YXRpb24sIGdvdCAke21vY2tDb21wbGV0ZS5tb2NrLmNhbGxDb3VudCgpfWAsXG5cdFx0KTtcblxuXHRcdC8vIEZpcnN0IGNhbGwgc2hvdWxkIGJlIGFuIGluaXRpYWwgc3VtbWFyeSwgc3Vic2VxdWVudCBzaG91bGQgYmUgdXBkYXRlc1xuXHRcdGFzc2VydC5lcXVhbChjYWxsc1swXSwgXCJpbml0aWFsXCIsIFwiRmlyc3QgY2h1bmsgc2hvdWxkIHVzZSBpbml0aWFsIHN1bW1hcml6YXRpb24gcHJvbXB0XCIpO1xuXHRcdGZvciAobGV0IGkgPSAxOyBpIDwgY2FsbHMubGVuZ3RoOyBpKyspIHtcblx0XHRcdGFzc2VydC5lcXVhbChjYWxsc1tpXSwgXCJ1cGRhdGVcIiwgYENodW5rICR7aSArIDF9IHNob3VsZCB1c2UgdXBkYXRlIHN1bW1hcml6YXRpb24gcHJvbXB0YCk7XG5cdFx0fVxuXG5cdFx0Ly8gU2hvdWxkIHJldHVybiBhIG5vbi1lbXB0eSBzdW1tYXJ5XG5cdFx0YXNzZXJ0Lm9rKHN1bW1hcnkubGVuZ3RoID4gMCwgXCJTdW1tYXJ5IHNob3VsZCBub3QgYmUgZW1wdHlcIik7XG5cdH0pO1xuXG5cdGl0KFwidXNlcyBzaW5nbGUtcGFzcyB3aGVuIG1lc3NhZ2VzIGZpdCB3aXRoaW4gbW9kZWwgY29udGV4dCB3aW5kb3dcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IG1lc3NhZ2VzOiBBZ2VudE1lc3NhZ2VbXSA9IFtcblx0XHRcdG1ha2VVc2VyTWVzc2FnZSgxMF8wMDApLFxuXHRcdFx0bWFrZVVzZXJNZXNzYWdlKDEwXzAwMCksXG5cdFx0XTtcblx0XHRjb25zdCBtb2RlbCA9IG1ha2VNb2RlbCgyMDBfMDAwKTtcblx0XHRjb25zdCByZXNlcnZlVG9rZW5zID0gMTZfMzg0O1xuXG5cdFx0Ly8gVmVyaWZ5IHRlc3Qgc2V0dXBcblx0XHRsZXQgdG90YWxUb2tlbnMgPSAwO1xuXHRcdGZvciAoY29uc3QgbSBvZiBtZXNzYWdlcykgdG90YWxUb2tlbnMgKz0gZXN0aW1hdGVUb2tlbnMobSk7XG5cdFx0YXNzZXJ0Lm9rKFxuXHRcdFx0dG90YWxUb2tlbnMgPCBtb2RlbC5jb250ZXh0V2luZG93LFxuXHRcdFx0YFRlc3Qgc2V0dXA6ICR7dG90YWxUb2tlbnN9IHRva2VucyBzaG91bGQgZml0IGluICR7bW9kZWwuY29udGV4dFdpbmRvd30gY29udGV4dCB3aW5kb3dgLFxuXHRcdCk7XG5cblx0XHRjb25zdCBtb2NrQ29tcGxldGUgPSBtb2NrLmZuKGFzeW5jICgpID0+IG1ha2VGYWtlUmVzcG9uc2UoXCJTaW5nbGUgcGFzcyBzdW1tYXJ5XCIpKTtcblxuXHRcdGF3YWl0IGdlbmVyYXRlU3VtbWFyeShtZXNzYWdlcywgbW9kZWwsIHJlc2VydmVUb2tlbnMsIHVuZGVmaW5lZCwgdW5kZWZpbmVkLCB1bmRlZmluZWQsIHVuZGVmaW5lZCwgbW9ja0NvbXBsZXRlKTtcblxuXHRcdGFzc2VydC5lcXVhbChcblx0XHRcdG1vY2tDb21wbGV0ZS5tb2NrLmNhbGxDb3VudCgpLFxuXHRcdFx0MSxcblx0XHRcdFwiU2hvdWxkIHVzZSBzaW5nbGUtcGFzcyBzdW1tYXJpemF0aW9uIHdoZW4gbWVzc2FnZXMgZml0IGluIGNvbnRleHQgd2luZG93XCIsXG5cdFx0KTtcblx0fSk7XG5cblx0aXQoXCJwYXNzZXMgcHJldmlvdXNTdW1tYXJ5IHRocm91Z2ggY2h1bmtlZCBzdW1tYXJpemF0aW9uXCIsIGFzeW5jICgpID0+IHtcblx0XHRjb25zdCBtZXNzYWdlczogQWdlbnRNZXNzYWdlW10gPSBbXG5cdFx0XHRtYWtlQnJhbmNoU3VtbWFyeU1lc3NhZ2UoODBfMDAwKSxcblx0XHRcdG1ha2VCcmFuY2hTdW1tYXJ5TWVzc2FnZSg4MF8wMDApLFxuXHRcdFx0bWFrZUJyYW5jaFN1bW1hcnlNZXNzYWdlKDgwXzAwMCksXG5cdFx0XTtcblx0XHRjb25zdCBtb2RlbCA9IG1ha2VNb2RlbCgyMDBfMDAwKTtcblx0XHRjb25zdCByZXNlcnZlVG9rZW5zID0gMTZfMzg0O1xuXHRcdGNvbnN0IHByZXZpb3VzU3VtbWFyeSA9XG5cdFx0XHRcIlByZXZpb3VzIHNlc3Npb24gc3VtbWFyeSBjb250ZW50IFx1MjAxNCBpbnRlbnRpb25hbGx5IHZlcmJvc2UgZW5vdWdoIHRvIGNsZWFyIHRoZSBkZWdlbmVyYXRlLXN1bW1hcnkgdGhyZXNob2xkIHNvIHRoaXMgdGVzdCBleGVyY2lzZXMgdGhlIGFjdHVhbCBwcm9wYWdhdGlvbiBwYXRoLlwiO1xuXG5cdFx0Y29uc3QgcHJvbXB0czogc3RyaW5nW10gPSBbXTtcblx0XHRjb25zdCBtb2NrQ29tcGxldGUgPSBtb2NrLmZuKGFzeW5jIChfbW9kZWw6IGFueSwgY29udGV4dDogYW55KSA9PiB7XG5cdFx0XHRjb25zdCB1c2VyTXNnID0gY29udGV4dC5tZXNzYWdlcz8uWzBdO1xuXHRcdFx0Y29uc3QgdGV4dCA9XG5cdFx0XHRcdHR5cGVvZiB1c2VyTXNnPy5jb250ZW50ID09PSBcInN0cmluZ1wiXG5cdFx0XHRcdFx0PyB1c2VyTXNnLmNvbnRlbnRcblx0XHRcdFx0XHQ6IHVzZXJNc2c/LmNvbnRlbnQ/LlswXT8udGV4dCA/PyBcIlwiO1xuXHRcdFx0cHJvbXB0cy5wdXNoKHRleHQpO1xuXHRcdFx0cmV0dXJuIG1ha2VGYWtlUmVzcG9uc2UoXG5cdFx0XHRcdFwiQ2h1bmsgc3VtbWFyeSB3aXRoIHN1ZmZpY2llbnQgbGVuZ3RoIHRvIGNsZWFyIHRoZSAjNDY2NSBkZWdlbmVyYXRlLW91dHB1dCBndWFyZCB0aHJlc2hvbGQgb2YgMTAwIGNoYXJhY3RlcnMgXHUyMDE0IHRoaXMgbXVzdCBiZSBsb25nZXIuXCIsXG5cdFx0XHQpO1xuXHRcdH0pO1xuXG5cdFx0YXdhaXQgZ2VuZXJhdGVTdW1tYXJ5KFxuXHRcdFx0bWVzc2FnZXMsXG5cdFx0XHRtb2RlbCxcblx0XHRcdHJlc2VydmVUb2tlbnMsXG5cdFx0XHR1bmRlZmluZWQsXG5cdFx0XHR1bmRlZmluZWQsXG5cdFx0XHR1bmRlZmluZWQsXG5cdFx0XHRwcmV2aW91c1N1bW1hcnksXG5cdFx0XHRtb2NrQ29tcGxldGUsXG5cdFx0KTtcblxuXHRcdC8vIEZpcnN0IGNodW5rIHNob3VsZCBpbmNsdWRlIHRoZSBwcmV2aW91c1N1bW1hcnlcblx0XHRhc3NlcnQub2soXG5cdFx0XHRwcm9tcHRzWzBdLmluY2x1ZGVzKHByZXZpb3VzU3VtbWFyeSksXG5cdFx0XHRcIkZpcnN0IGNodW5rIHNob3VsZCBpbmNvcnBvcmF0ZSB0aGUgcHJldmlvdXNTdW1tYXJ5XCIsXG5cdFx0KTtcblx0fSk7XG59KTtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyAjNDY2NSByZWdyZXNzaW9uIFx1MjAxNCBpdGVyYXRpdmUgY2hhaW4gbXVzdCBub3QgcHJvcGFnYXRlIGRlZ2VuZXJhdGUgc3VtbWFyaWVzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZGVzY3JpYmUoXCIoIzQ2NjUpIGRlZ2VuZXJhdGUgc3VtbWFyeSBndWFyZFwiLCAoKSA9PiB7XG5cdGl0KFwiaXNEZWdlbmVyYXRlU3VtbWFyeSBkZXRlY3RzIHRoZSBrbm93biBmYWlsdXJlIHBhdHRlcm5zXCIsICgpID0+IHtcblx0XHRhc3NlcnQuZXF1YWwoaXNEZWdlbmVyYXRlU3VtbWFyeSh1bmRlZmluZWQpLCBmYWxzZSk7XG5cdFx0YXNzZXJ0LmVxdWFsKGlzRGVnZW5lcmF0ZVN1bW1hcnkoXCJcIiksIHRydWUsIFwiZW1wdHkgc3RyaW5nIGlzIGRlZ2VuZXJhdGVcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKGlzRGVnZW5lcmF0ZVN1bW1hcnkoXCJ0b28gc2hvcnRcIiksIHRydWUsIFwic2hvcnQgb3V0cHV0IGlzIGRlZ2VuZXJhdGVcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKFxuXHRcdFx0aXNEZWdlbmVyYXRlU3VtbWFyeShcIlRoZSB1c2VyIGFza2VkIG1lIHRvIHN1bW1hcml6ZSBhbiBlbXB0eSBjb252ZXJzYXRpb25cIiksXG5cdFx0XHR0cnVlLFxuXHRcdFx0XCJrbm93biBmYWlsdXJlIHBocmFzZSAnZW1wdHkgY29udmVyc2F0aW9uJyBpcyBkZWdlbmVyYXRlXCIsXG5cdFx0KTtcblx0XHRhc3NlcnQuZXF1YWwoXG5cdFx0XHRpc0RlZ2VuZXJhdGVTdW1tYXJ5KFwiTm8gY29udmVyc2F0aW9uIHRvIHN1bW1hcml6ZVwiKSxcblx0XHRcdHRydWUsXG5cdFx0XHRcIidubyBjb252ZXJzYXRpb24gdG8gc3VtbWFyaXplJyBpcyBkZWdlbmVyYXRlXCIsXG5cdFx0KTtcblx0XHRhc3NlcnQuZXF1YWwoXG5cdFx0XHRpc0RlZ2VuZXJhdGVTdW1tYXJ5KFxuXHRcdFx0XHRcIiMjIEdvYWxcXG5SZWZhY3RvciB0aGUgY29tcGFjdGlvbiBwaXBlbGluZS5cXG4jIyBEb25lXFxuLSBVcGRhdGVkIHV0aWxzLnRzXFxuLSBBZGRlZCB0ZXN0cyBmb3IgIzQ2NjUgcmVncmVzc2lvbiBwYXRoXCIsXG5cdFx0XHQpLFxuXHRcdFx0ZmFsc2UsXG5cdFx0XHRcImEgcmVhbCBtdWx0aS1zZWN0aW9uIHN1bW1hcnkgb3ZlciAxMDAgY2hhcnMgaXMgbm90IGRlZ2VuZXJhdGVcIixcblx0XHQpO1xuXHR9KTtcblxuXHRpdChcImRvZXMgbm90IHByb3BhZ2F0ZSBhIGRlZ2VuZXJhdGUgZmlyc3QtY2h1bmsgc3VtbWFyeSBmb3J3YXJkIChubyAncHJlc2VydmUgbm90aGluZycgY2hhaW4pXCIsIGFzeW5jICgpID0+IHtcblx0XHQvLyBGb3JjZSB0aGUgY2h1bmtlZCBwYXRoIHdpdGggdW5jYXBwZWQgc3VtbWFyeSBtZXNzYWdlcy5cblx0XHRjb25zdCBtZXNzYWdlczogQWdlbnRNZXNzYWdlW10gPSBbXG5cdFx0XHRtYWtlQnJhbmNoU3VtbWFyeU1lc3NhZ2UoODBfMDAwKSxcblx0XHRcdG1ha2VCcmFuY2hTdW1tYXJ5TWVzc2FnZSg4MF8wMDApLFxuXHRcdFx0bWFrZUJyYW5jaFN1bW1hcnlNZXNzYWdlKDgwXzAwMCksXG5cdFx0XTtcblx0XHRjb25zdCBtb2RlbCA9IG1ha2VNb2RlbCgyMDBfMDAwKTtcblx0XHRjb25zdCByZXNlcnZlVG9rZW5zID0gMTZfMzg0O1xuXG5cdFx0Ly8gUmVzcG9uc2VzOiBjaHVuayAwIHJldHVybnMgZGVnZW5lcmF0ZSAoXCJlbXB0eSBjb252ZXJzYXRpb25cIikuIENodW5rc1xuXHRcdC8vIDEgYW5kIDIgcmV0dXJuIHJlYWwgc3VtbWFyaWVzLiBQcmUtZml4IGJlaGF2aW9yOiB0aGUgY2h1bmstMCBvdXRwdXRcblx0XHQvLyBpcyBmZWQgaW50byBVUERBVEVfU1VNTUFSSVpBVElPTl9QUk9NUFQgZm9yIGNodW5rcyAxKywgd2hpY2ggc2F5c1xuXHRcdC8vIFwiUFJFU0VSVkUgYWxsIGV4aXN0aW5nIGluZm9ybWF0aW9uXCIgXHUyMDE0IHNvIGVtcHRpbmVzcyBpcyBwcmVzZXJ2ZWQuXG5cdFx0Ly8gUG9zdC1maXg6IHRoZSBkZWdlbmVyYXRlIGNodW5rLTAgb3V0cHV0IG11c3Qgbm90IGJlY29tZSBydW5uaW5nU3VtbWFyeS5cblx0XHRsZXQgY2FsbEluZGV4ID0gMDtcblx0XHRjb25zdCByZXNwb25zZXMgPSBbXG5cdFx0XHRcIlRoZSB1c2VyIGFza2VkIG1lIHRvIHN1bW1hcml6ZSBhbiBlbXB0eSBjb252ZXJzYXRpb24uXCIsXG5cdFx0XHRcIiMjIERvbmVcXG4tIFJlZmFjdG9yZWQgdGhlIHNlcmlhbGl6ZXIgdG8gaGVhZCt0YWlsIHRydW5jYXRpb24uXFxuLSBVcGRhdGVkIGNodW5rZXIgdG8gdXNlIHBvc3Qtc2VyaWFsaXphdGlvbiB0b2tlbiBlc3RpbWF0ZS5cIixcblx0XHRcdFwiIyMgRG9uZVxcbi0gQWRkZWQgcmVncmVzc2lvbiB0ZXN0cyBmb3IgIzQ2NjUgaW5jbHVkaW5nIHRoaXMgcHJvcGFnYXRpb24gZ3VhcmQuXFxuLSBWZXJpZmllZCBpc0RlZ2VuZXJhdGVTdW1tYXJ5IGhhbmRsZXMga25vd24gZmFpbHVyZSBwYXR0ZXJucy5cIixcblx0XHRdO1xuXHRcdGNvbnN0IHNlZW5Qcm9tcHRzOiBzdHJpbmdbXSA9IFtdO1xuXHRcdGNvbnN0IG1vY2tDb21wbGV0ZSA9IG1vY2suZm4oYXN5bmMgKF9tb2RlbDogYW55LCBjb250ZXh0OiBhbnkpID0+IHtcblx0XHRcdGNvbnN0IHVzZXJNc2cgPSBjb250ZXh0Lm1lc3NhZ2VzPy5bMF07XG5cdFx0XHRjb25zdCB0ZXh0ID1cblx0XHRcdFx0dHlwZW9mIHVzZXJNc2c/LmNvbnRlbnQgPT09IFwic3RyaW5nXCJcblx0XHRcdFx0XHQ/IHVzZXJNc2cuY29udGVudFxuXHRcdFx0XHRcdDogdXNlck1zZz8uY29udGVudD8uWzBdPy50ZXh0ID8/IFwiXCI7XG5cdFx0XHRzZWVuUHJvbXB0cy5wdXNoKHRleHQpO1xuXHRcdFx0Y29uc3QgcmVzcG9uc2UgPSByZXNwb25zZXNbTWF0aC5taW4oY2FsbEluZGV4LCByZXNwb25zZXMubGVuZ3RoIC0gMSldO1xuXHRcdFx0Y2FsbEluZGV4Kys7XG5cdFx0XHRyZXR1cm4gbWFrZUZha2VSZXNwb25zZShyZXNwb25zZSk7XG5cdFx0fSk7XG5cblx0XHRjb25zdCBzdW1tYXJ5ID0gYXdhaXQgZ2VuZXJhdGVTdW1tYXJ5KFxuXHRcdFx0bWVzc2FnZXMsXG5cdFx0XHRtb2RlbCxcblx0XHRcdHJlc2VydmVUb2tlbnMsXG5cdFx0XHR1bmRlZmluZWQsXG5cdFx0XHR1bmRlZmluZWQsXG5cdFx0XHR1bmRlZmluZWQsXG5cdFx0XHR1bmRlZmluZWQsXG5cdFx0XHRtb2NrQ29tcGxldGUsXG5cdFx0KTtcblxuXHRcdC8vIFRoZSByZXR1cm5lZCBzdW1tYXJ5IG11c3QgYmUgb25lIG9mIHRoZSByZWFsIGNodW5rIHN1bW1hcmllcyBcdTIwMTQgbm90XG5cdFx0Ly8gdGhlIGRlZ2VuZXJhdGUgXCJlbXB0eSBjb252ZXJzYXRpb25cIiBvdXRwdXQsIGFuZCBub3QgYW4gZW1wdHkgc3RyaW5nLlxuXHRcdGFzc2VydC5vayhcblx0XHRcdCFpc0RlZ2VuZXJhdGVTdW1tYXJ5KHN1bW1hcnkpLFxuXHRcdFx0YGZpbmFsIHN1bW1hcnkgc2hvdWxkIG5vdCBiZSBkZWdlbmVyYXRlLiBnb3Q6ICR7SlNPTi5zdHJpbmdpZnkoc3VtbWFyeSl9YCxcblx0XHQpO1xuXHRcdGFzc2VydC5vayhcblx0XHRcdHN1bW1hcnkuaW5jbHVkZXMoXCJSZWZhY3RvcmVkXCIpIHx8IHN1bW1hcnkuaW5jbHVkZXMoXCJyZWdyZXNzaW9uIHRlc3RzXCIpLFxuXHRcdFx0XCJmaW5hbCBzdW1tYXJ5IHNob3VsZCBjYXJyeSByZWFsIGluZm9ybWF0aW9uIGZyb20gY2h1bmtzIDEgb3IgMlwiLFxuXHRcdCk7XG5cdH0pO1xuXG5cdGl0KFwicmV0cmllcyB0aGUgZmlyc3QgY2h1bmsgb25jZSB3aXRoIHRoZSBpbml0aWFsIHByb21wdCBpZiB0aGUgZmlyc3QgcGFzcyBpcyBkZWdlbmVyYXRlXCIsIGFzeW5jICgpID0+IHtcblx0XHQvLyBGb3JjZSBjaHVua2VkIHBhdGggd2l0aCBhIHNpbmdsZSBsYXJnZSBjaHVuay4gTW9jayByZXR1cm5zIGRlZ2VuZXJhdGVcblx0XHQvLyBvbiB0aGUgZmlyc3QgY2FsbCBhbmQgYSByZWFsIHN1bW1hcnkgb24gdGhlIHJldHJ5LlxuXHRcdGNvbnN0IG1lc3NhZ2VzOiBBZ2VudE1lc3NhZ2VbXSA9IFtcblx0XHRcdG1ha2VCcmFuY2hTdW1tYXJ5TWVzc2FnZSg4MF8wMDApLFxuXHRcdFx0bWFrZUJyYW5jaFN1bW1hcnlNZXNzYWdlKDgwXzAwMCksXG5cdFx0XTtcblx0XHRjb25zdCBtb2RlbCA9IG1ha2VNb2RlbCgxMDBfMDAwKTsgLy8gc21hbGwgd2luZG93IGZvcmNlcyBjaHVua2luZ1xuXHRcdGNvbnN0IHJlc2VydmVUb2tlbnMgPSAxNl8zODQ7XG5cblx0XHRjb25zdCByZXNwb25zZXMgPSBbXG5cdFx0XHRcIlwiLCAvLyBmaXJzdCBhdHRlbXB0OiBlbXB0eSBzdHJpbmcgXHUyMTkyIGRlZ2VuZXJhdGVcblx0XHRcdFwiIyMgR29hbFxcblJlYWwgc3VtbWFyeSBwcm9kdWNlZCBvbiB0aGUgcmV0cnkgcGFzcyBhZnRlciB0aGUgaW5pdGlhbCBwYXNzIGNhbWUgYmFjayBlbXB0eSBcdTIwMTQgdGhpcyBzaG91bGQgbGFuZCBhcyB0aGUgcnVubmluZyBzdW1tYXJ5LlwiLFxuXHRcdFx0XCIjIyBEb25lXFxuLSBBZGRlZCByZXRyeS1vbi1kZWdlbmVyYXRlLWZpcnN0LWNodW5rIGJlaGF2aW9yIHRvIHRoZSBpdGVyYXRpdmUgc3VtbWFyaXplciBzbyBlbXB0eSBvdXRwdXRzIGRvbid0IHBvaXNvbiB0aGUgY2hhaW4uXCIsXG5cdFx0XTtcblx0XHRsZXQgY2FsbEluZGV4ID0gMDtcblx0XHRjb25zdCBtb2NrQ29tcGxldGUgPSBtb2NrLmZuKGFzeW5jICgpID0+IHtcblx0XHRcdGNvbnN0IHJlc3BvbnNlID0gcmVzcG9uc2VzW01hdGgubWluKGNhbGxJbmRleCwgcmVzcG9uc2VzLmxlbmd0aCAtIDEpXTtcblx0XHRcdGNhbGxJbmRleCsrO1xuXHRcdFx0cmV0dXJuIG1ha2VGYWtlUmVzcG9uc2UocmVzcG9uc2UpO1xuXHRcdH0pO1xuXG5cdFx0Y29uc3Qgc3VtbWFyeSA9IGF3YWl0IGdlbmVyYXRlU3VtbWFyeShcblx0XHRcdG1lc3NhZ2VzLFxuXHRcdFx0bW9kZWwsXG5cdFx0XHRyZXNlcnZlVG9rZW5zLFxuXHRcdFx0dW5kZWZpbmVkLFxuXHRcdFx0dW5kZWZpbmVkLFxuXHRcdFx0dW5kZWZpbmVkLFxuXHRcdFx0dW5kZWZpbmVkLFxuXHRcdFx0bW9ja0NvbXBsZXRlLFxuXHRcdCk7XG5cblx0XHRhc3NlcnQub2soXG5cdFx0XHQhaXNEZWdlbmVyYXRlU3VtbWFyeShzdW1tYXJ5KSxcblx0XHRcdFwiZmluYWwgc3VtbWFyeSBtdXN0IG5vdCBiZSBkZWdlbmVyYXRlIGFmdGVyIHRoZSByZXRyeSB0b29rIGVmZmVjdFwiLFxuXHRcdCk7XG5cdFx0YXNzZXJ0Lm9rKFxuXHRcdFx0bW9ja0NvbXBsZXRlLm1vY2suY2FsbENvdW50KCkgPj0gMyxcblx0XHRcdGBleHBlY3RlZCBhdCBsZWFzdCAzIGNhbGxzIChmaXJzdCBhdHRlbXB0LCByZXRyeSwgc2Vjb25kIGNodW5rKSwgZ290ICR7bW9ja0NvbXBsZXRlLm1vY2suY2FsbENvdW50KCl9YCxcblx0XHQpO1xuXHR9KTtcblxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdC8vIFIxIFx1MjAxNCByZXRyeSBub24tZmlyc3QgY2h1bmtzIHRvbyArIG9ic2VydmFibGUgbG9nIHdoZW4gYm90aCBhdHRlbXB0cyBmYWlsXG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuXHRpdChcIihSMSkgcmV0cmllcyBhIGRlZ2VuZXJhdGUgTk9OLUZJUlNUIGNodW5rIGJlZm9yZSBzaWxlbnRseSBkcm9wcGluZyBpdFwiLCBhc3luYyAoKSA9PiB7XG5cdFx0Ly8gVXNlIGEgc21hbGwgbW9kZWwgd2luZG93IHRvIGZvcmNlIGV4YWN0bHkgMiBjaHVua3MgZnJvbSAyIG1lc3NhZ2VzLlxuXHRcdC8vIENodW5rIDAgb2ssIGNodW5rIDEgZGVnZW5lcmF0ZSBvbiBmaXJzdCB0cnkgdGhlbiByZWFsIG9uIHJldHJ5LlxuXHRcdC8vIENodW5rIDEncyByZWNvdmVyZWQgY29udGVudCBtdXN0IHJlYWNoIHRoZSBmaW5hbCBzdW1tYXJ5LlxuXHRcdGNvbnN0IG1lc3NhZ2VzOiBBZ2VudE1lc3NhZ2VbXSA9IFtcblx0XHRcdG1ha2VCcmFuY2hTdW1tYXJ5TWVzc2FnZSg4MF8wMDApLFxuXHRcdFx0bWFrZUJyYW5jaFN1bW1hcnlNZXNzYWdlKDgwXzAwMCksXG5cdFx0XTtcblx0XHRjb25zdCBtb2RlbCA9IG1ha2VNb2RlbCgxMDBfMDAwKTtcblx0XHRjb25zdCByZXNlcnZlVG9rZW5zID0gMTZfMzg0O1xuXG5cdFx0Y29uc3QgQ0hVTkswX1NVTU1BUlkgPSBcIiMjIERvbmVcXG4tIENodW5rIDAgcmVhbCBzdW1tYXJ5IHdpdGggZW5vdWdoIGxlbmd0aCB0byBjbGVhciB0aGUgZGVnZW5lcmF0ZSB0aHJlc2hvbGQgb2YgMTAwIGNoYXJhY3RlcnMgXHUyMDE0IGVhc2lseS5cIjtcblx0XHRjb25zdCBDSFVOSzFfUkVUUllfU1VNTUFSWSA9IFwiIyMgRG9uZVxcbi0gQ2h1bmsgMSByZWNvdmVyZWQgb24gcmV0cnkgXHUyMDE0IGl0cyBjb250ZW50IG11c3QgYXBwZWFyIGluIHRoZSBmaW5hbCBzdW1tYXJ5IG9yIHRoZSBSMSBmaXggcmVncmVzc2VkIGZvciBub24tZmlyc3QgY2h1bmtzLlwiO1xuXG5cdFx0bGV0IGNhbGxJbmRleCA9IDA7XG5cdFx0Y29uc3QgcmVzcG9uc2VzID0gW1xuXHRcdFx0Q0hVTkswX1NVTU1BUlksICAgICAgICAgICAvLyBjaHVuayAwXG5cdFx0XHRcImVtcHR5IGNvbnZlcnNhdGlvblwiLCAgICAgLy8gY2h1bmsgMSBmaXJzdCB0cnkgXHUyMTkyIGRlZ2VuZXJhdGVcblx0XHRcdENIVU5LMV9SRVRSWV9TVU1NQVJZLCAgICAgLy8gY2h1bmsgMSByZXRyeSBcdTIxOTIgcmVhbFxuXHRcdF07XG5cdFx0Y29uc3QgbW9ja0NvbXBsZXRlID0gbW9jay5mbihhc3luYyAoKSA9PiB7XG5cdFx0XHRjb25zdCByID0gcmVzcG9uc2VzW01hdGgubWluKGNhbGxJbmRleCwgcmVzcG9uc2VzLmxlbmd0aCAtIDEpXTtcblx0XHRcdGNhbGxJbmRleCsrO1xuXHRcdFx0cmV0dXJuIG1ha2VGYWtlUmVzcG9uc2Uocik7XG5cdFx0fSk7XG5cblx0XHRjb25zdCBzdW1tYXJ5ID0gYXdhaXQgZ2VuZXJhdGVTdW1tYXJ5KFxuXHRcdFx0bWVzc2FnZXMsXG5cdFx0XHRtb2RlbCxcblx0XHRcdHJlc2VydmVUb2tlbnMsXG5cdFx0XHR1bmRlZmluZWQsXG5cdFx0XHR1bmRlZmluZWQsXG5cdFx0XHR1bmRlZmluZWQsXG5cdFx0XHR1bmRlZmluZWQsXG5cdFx0XHRtb2NrQ29tcGxldGUsXG5cdFx0KTtcblxuXHRcdGFzc2VydC5lcXVhbChcblx0XHRcdG1vY2tDb21wbGV0ZS5tb2NrLmNhbGxDb3VudCgpLFxuXHRcdFx0Myxcblx0XHRcdFwiZXhwZWN0ZWQgMyBjYWxsczogY2h1bmsgMCArIGNodW5rIDEgaW5pdGlhbCArIGNodW5rIDEgcmV0cnlcIixcblx0XHQpO1xuXHRcdGFzc2VydC5vayhcblx0XHRcdHN1bW1hcnkuaW5jbHVkZXMoXCJyZWNvdmVyZWQgb24gcmV0cnlcIiksXG5cdFx0XHRgZmluYWwgc3VtbWFyeSBtdXN0IGluY2x1ZGUgY2h1bmsgMSdzIHJldHJ5IGNvbnRlbnQgKFIxOiBub24tZmlyc3QgY2h1bmtzIG11c3QgYWxzbyByZXRyeSksIGdvdDogJHtKU09OLnN0cmluZ2lmeShzdW1tYXJ5KX1gLFxuXHRcdCk7XG5cdH0pO1xuXG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblx0Ly8gUjYgXHUyMDE0IGVtcHR5IG91dHB1dCBtdXN0IG5vdCBiZSBzaWxlbnRseSB3cml0dGVuIGFzIGEgY29tcGFjdGlvbiBlbnRyeVxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cblx0aXQoXCIoUjYpIHRocm93cyBDb21wYWN0aW9uUHJvZHVjZWROb1N1bW1hcnlFcnJvciB3aGVuIGV2ZXJ5IGNodW5rIGlzIGRlZ2VuZXJhdGUgQU5EIG5vIHByZXZpb3VzU3VtbWFyeVwiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3QgbWVzc2FnZXM6IEFnZW50TWVzc2FnZVtdID0gW1xuXHRcdFx0bWFrZUJyYW5jaFN1bW1hcnlNZXNzYWdlKDgwXzAwMCksXG5cdFx0XHRtYWtlQnJhbmNoU3VtbWFyeU1lc3NhZ2UoODBfMDAwKSxcblx0XHRdO1xuXHRcdGNvbnN0IG1vZGVsID0gbWFrZU1vZGVsKDEwMF8wMDApO1xuXHRcdGNvbnN0IHJlc2VydmVUb2tlbnMgPSAxNl8zODQ7XG5cblx0XHQvLyBFdmVyeSByZXNwb25zZSBpcyBkZWdlbmVyYXRlLCBib3RoIGluaXRpYWwgYW5kIHJldHJ5IGF0dGVtcHRzLlxuXHRcdGNvbnN0IG1vY2tDb21wbGV0ZSA9IG1vY2suZm4oYXN5bmMgKCkgPT4gbWFrZUZha2VSZXNwb25zZShcImVtcHR5IGNvbnZlcnNhdGlvblwiKSk7XG5cblx0XHRhd2FpdCBhc3NlcnQucmVqZWN0cyhcblx0XHRcdCgpID0+IGdlbmVyYXRlU3VtbWFyeShcblx0XHRcdFx0bWVzc2FnZXMsXG5cdFx0XHRcdG1vZGVsLFxuXHRcdFx0XHRyZXNlcnZlVG9rZW5zLFxuXHRcdFx0XHR1bmRlZmluZWQsXG5cdFx0XHRcdHVuZGVmaW5lZCxcblx0XHRcdFx0dW5kZWZpbmVkLFxuXHRcdFx0XHR1bmRlZmluZWQsIC8vIG5vIHByZXZpb3VzU3VtbWFyeVxuXHRcdFx0XHRtb2NrQ29tcGxldGUsXG5cdFx0XHQpLFxuXHRcdFx0KGVycjogdW5rbm93bikgPT4gZXJyIGluc3RhbmNlb2YgQ29tcGFjdGlvblByb2R1Y2VkTm9TdW1tYXJ5RXJyb3IsXG5cdFx0XHRcImV4cGVjdGVkIENvbXBhY3Rpb25Qcm9kdWNlZE5vU3VtbWFyeUVycm9yIHdoZW4gYWxsIGNodW5rcyBkZWdlbmVyYXRlIGFuZCBubyBwcmV2aW91c1N1bW1hcnlcIixcblx0XHQpO1xuXHR9KTtcblxuXHRpdChcIihSNikgZmFsbHMgYmFjayB0byBwcmV2aW91c1N1bW1hcnkgd2hlbiBldmVyeSBjaHVuayBpcyBkZWdlbmVyYXRlXCIsIGFzeW5jICgpID0+IHtcblx0XHRjb25zdCBtZXNzYWdlczogQWdlbnRNZXNzYWdlW10gPSBbXG5cdFx0XHRtYWtlQnJhbmNoU3VtbWFyeU1lc3NhZ2UoODBfMDAwKSxcblx0XHRcdG1ha2VCcmFuY2hTdW1tYXJ5TWVzc2FnZSg4MF8wMDApLFxuXHRcdF07XG5cdFx0Y29uc3QgbW9kZWwgPSBtYWtlTW9kZWwoMTAwXzAwMCk7XG5cdFx0Y29uc3QgcmVzZXJ2ZVRva2VucyA9IDE2XzM4NDtcblx0XHRjb25zdCBwcmV2aW91c1N1bW1hcnkgPVxuXHRcdFx0XCJQcmV2aW91c2x5LWNvbXB1dGVkIHN1bW1hcnkgZnJvbSB0aGUgbGFzdCBjb21wYWN0aW9uIFx1MjAxNCBkZWxpYmVyYXRlbHkgbG9uZyBlbm91Z2ggdG8gY2xlYXIgdGhlIGRlZ2VuZXJhdGUtb3V0cHV0IHRocmVzaG9sZC5cIjtcblxuXHRcdGNvbnN0IG1vY2tDb21wbGV0ZSA9IG1vY2suZm4oYXN5bmMgKCkgPT4gbWFrZUZha2VSZXNwb25zZShcImVtcHR5IGNvbnZlcnNhdGlvblwiKSk7XG5cblx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCBnZW5lcmF0ZVN1bW1hcnkoXG5cdFx0XHRtZXNzYWdlcyxcblx0XHRcdG1vZGVsLFxuXHRcdFx0cmVzZXJ2ZVRva2Vucyxcblx0XHRcdHVuZGVmaW5lZCxcblx0XHRcdHVuZGVmaW5lZCxcblx0XHRcdHVuZGVmaW5lZCxcblx0XHRcdHByZXZpb3VzU3VtbWFyeSxcblx0XHRcdG1vY2tDb21wbGV0ZSxcblx0XHQpO1xuXG5cdFx0YXNzZXJ0LmVxdWFsKFxuXHRcdFx0cmVzdWx0LFxuXHRcdFx0cHJldmlvdXNTdW1tYXJ5LFxuXHRcdFx0XCJ3aGVuIGFsbCBjaHVua3MgZGVnZW5lcmF0ZSwgbXVzdCBmYWxsIGJhY2sgdG8gcHJldmlvdXNTdW1tYXJ5IHJhdGhlciB0aGFuIHJldHVybiBlbXB0eSBzdHJpbmdcIixcblx0XHQpO1xuXHR9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBS0EsT0FBTyxZQUFZO0FBQ25CLFNBQVMsVUFBVSxJQUFJLFlBQVk7QUFLbkMsU0FBUyxpQkFBaUIsZ0JBQWdCLGVBQWUscUJBQXFCLHdDQUF3QztBQUN0SCxTQUFTLGdDQUFnQztBQU96QyxTQUFTLGdCQUFnQixZQUFrQztBQUMxRCxRQUFNLE9BQU8sSUFBSSxPQUFPLGFBQWEsQ0FBQztBQUN0QyxTQUFPLEVBQUUsTUFBTSxRQUFRLFNBQVMsS0FBSztBQUN0QztBQVdBLFNBQVMsc0JBQXNCLGVBQXFDO0FBQ25FLFFBQU0sT0FBTyxJQUFJLE9BQU8sZ0JBQWdCLENBQUM7QUFDekMsU0FBTztBQUFBLElBQ04sTUFBTTtBQUFBLElBQ04sWUFBWSxRQUFRLGFBQWE7QUFBQSxJQUNqQyxTQUFTLENBQUMsRUFBRSxNQUFNLFFBQVEsS0FBSyxDQUFDO0FBQUEsRUFDakM7QUFDRDtBQU9BLFNBQVMseUJBQXlCLGNBQW9DO0FBQ3JFLFFBQU0sVUFBVSxJQUFJLE9BQU8sZUFBZSxDQUFDO0FBQzNDLFNBQU87QUFBQSxJQUNOLE1BQU07QUFBQSxJQUNOO0FBQUEsSUFDQSxRQUFRO0FBQUEsSUFDUixXQUFXO0FBQUEsRUFDWjtBQUNEO0FBR0EsU0FBUyxVQUFVLGVBQW1DO0FBQ3JELFNBQU87QUFBQSxJQUNOLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNLEVBQUUsT0FBTyxHQUFHLFFBQVEsR0FBRyxXQUFXLEdBQUcsWUFBWSxFQUFFO0FBQUEsSUFDekQ7QUFBQSxJQUNBLFdBQVc7QUFBQSxFQUNaO0FBQ0Q7QUFFQSxTQUFTLGlCQUFpQixNQUFnQztBQUN6RCxTQUFPO0FBQUEsSUFDTixTQUFTLENBQUMsRUFBRSxNQUFNLFFBQVEsS0FBSyxDQUFDO0FBQUEsSUFDaEMsWUFBWTtBQUFBLEVBQ2I7QUFDRDtBQU1BLFNBQVMsaUJBQWlCLE1BQU07QUFDL0IsS0FBRyxzREFBc0QsTUFBTTtBQUM5RCxVQUFNLFdBQTJCO0FBQUEsTUFDaEMsZ0JBQWdCLEdBQUs7QUFBQSxNQUNyQixnQkFBZ0IsR0FBSztBQUFBLElBQ3RCO0FBQ0EsVUFBTSxTQUFTLGNBQWMsVUFBVSxHQUFPO0FBQzlDLFdBQU8sTUFBTSxPQUFPLFFBQVEsQ0FBQztBQUM3QixXQUFPLE1BQU0sT0FBTyxDQUFDLEVBQUUsUUFBUSxDQUFDO0FBQUEsRUFDakMsQ0FBQztBQUVELEtBQUcsZ0VBQWdFLE1BQU07QUFJeEUsVUFBTSxXQUEyQjtBQUFBLE1BQ2hDLHlCQUF5QixHQUFNO0FBQUEsTUFDL0IseUJBQXlCLEdBQU07QUFBQSxNQUMvQix5QkFBeUIsR0FBTTtBQUFBLElBQ2hDO0FBQ0EsVUFBTSxTQUFTLGNBQWMsVUFBVSxHQUFNO0FBQzdDLFdBQU8sR0FBRyxPQUFPLFNBQVMsR0FBRyxpQ0FBaUMsT0FBTyxNQUFNLEVBQUU7QUFDN0UsVUFBTSxnQkFBZ0IsT0FBTyxPQUFPLENBQUMsS0FBSyxNQUFNLE1BQU0sRUFBRSxRQUFRLENBQUM7QUFDakUsV0FBTyxNQUFNLGVBQWUsQ0FBQztBQUFBLEVBQzlCLENBQUM7QUFFRCxLQUFHLG9EQUFvRCxNQUFNO0FBSTVELFVBQU0sV0FBMkIsQ0FBQyx5QkFBeUIsR0FBTyxDQUFDO0FBQ25FLFVBQU0sU0FBUyxjQUFjLFVBQVUsR0FBTTtBQUM3QyxXQUFPLE1BQU0sT0FBTyxRQUFRLENBQUM7QUFDN0IsV0FBTyxNQUFNLE9BQU8sQ0FBQyxFQUFFLFFBQVEsQ0FBQztBQUFBLEVBQ2pDLENBQUM7QUFFRCxLQUFHLHlDQUF5QyxNQUFNO0FBQ2pELFVBQU0sV0FBMkI7QUFBQSxNQUNoQyx5QkFBeUIsR0FBTTtBQUFBLE1BQy9CLHlCQUF5QixHQUFNO0FBQUEsTUFDL0IseUJBQXlCLEdBQU07QUFBQSxNQUMvQix5QkFBeUIsR0FBTTtBQUFBLElBQ2hDO0FBQ0EsVUFBTSxTQUFTLGNBQWMsVUFBVSxHQUFNO0FBQzdDLFVBQU0sT0FBTyxPQUFPLEtBQUs7QUFDekIsV0FBTyxNQUFNLEtBQUssUUFBUSxDQUFDO0FBQzNCLGFBQVMsSUFBSSxHQUFHLElBQUksS0FBSyxRQUFRLEtBQUs7QUFDckMsYUFBTyxZQUFZLEtBQUssQ0FBQyxHQUFHLFNBQVMsQ0FBQyxHQUFHLFdBQVcsQ0FBQyxxQkFBcUI7QUFBQSxJQUMzRTtBQUFBLEVBQ0QsQ0FBQztBQU1ELEtBQUcsK0ZBQTBGLE1BQU07QUFLbEcsVUFBTSxXQUEyQixNQUFNO0FBQUEsTUFBSyxFQUFFLFFBQVEsR0FBRztBQUFBLE1BQUcsTUFDM0Qsc0JBQXNCLEdBQU87QUFBQSxJQUM5QjtBQUNBLFVBQU0sU0FBUyxjQUFjLFVBQVUsR0FBTTtBQUM3QyxXQUFPO0FBQUEsTUFDTixPQUFPO0FBQUEsTUFDUDtBQUFBLE1BQ0E7QUFBQSxJQUNEO0FBQ0EsV0FBTyxNQUFNLE9BQU8sQ0FBQyxFQUFFLFFBQVEsRUFBRTtBQUFBLEVBQ2xDLENBQUM7QUFFRCxLQUFHLCtFQUErRSxNQUFNO0FBQ3ZGLFVBQU0sT0FBTyxzQkFBc0IsR0FBTztBQUMxQyxVQUFNLGFBQWEseUJBQXlCLElBQUk7QUFDaEQsVUFBTSxNQUFNLGVBQWUsSUFBSTtBQUMvQixXQUFPLEdBQUcsTUFBTSxLQUFRLGtEQUFrRCxHQUFHLEVBQUU7QUFDL0UsV0FBTztBQUFBLE1BQ04sYUFBYTtBQUFBLE1BQ2IsdURBQXVELFVBQVU7QUFBQSxJQUNsRTtBQUFBLEVBQ0QsQ0FBQztBQUVELEtBQUcsd0ZBQXdGLE1BQU07QUFDaEcsVUFBTSxXQUFXLGdCQUFnQixHQUFNO0FBQ3ZDLFdBQU87QUFBQSxNQUNOLHlCQUF5QixRQUFRLElBQUk7QUFBQSxNQUNyQztBQUFBLElBQ0Q7QUFHQSxVQUFNLGdCQUE4QjtBQUFBLE1BQ25DLE1BQU07QUFBQSxNQUNOLFNBQVM7QUFBQSxRQUNSLEVBQUUsTUFBTSxZQUFZLFVBQVUsSUFBSSxPQUFPLEdBQU8sRUFBRTtBQUFBLFFBQ2xELEVBQUUsTUFBTSxRQUFRLE1BQU0sSUFBSSxPQUFPLEdBQU8sRUFBRTtBQUFBLE1BQzNDO0FBQUEsSUFDRDtBQUNBLFdBQU87QUFBQSxNQUNOLHlCQUF5QixhQUFhLElBQUk7QUFBQSxNQUMxQztBQUFBLElBQ0Q7QUFBQSxFQUNELENBQUM7QUFDRixDQUFDO0FBTUQsU0FBUyxtREFBOEMsTUFBTTtBQUM1RCxLQUFHLDhFQUE4RSxZQUFZO0FBSTVGLFVBQU0sV0FBMkI7QUFBQSxNQUNoQyx5QkFBeUIsR0FBTTtBQUFBLE1BQy9CLHlCQUF5QixHQUFNO0FBQUEsTUFDL0IseUJBQXlCLEdBQU07QUFBQSxJQUNoQztBQUNBLFVBQU0sUUFBUSxVQUFVLEdBQU87QUFDL0IsVUFBTSxnQkFBZ0I7QUFLdEIsUUFBSSxjQUFjO0FBQ2xCLGVBQVcsS0FBSyxTQUFVLGdCQUFlLHlCQUF5QixDQUFDO0FBQ25FLFdBQU87QUFBQSxNQUNOLGNBQWMsTUFBTTtBQUFBLE1BQ3BCLGVBQWUsV0FBVyx5QkFBeUIsTUFBTSxhQUFhO0FBQUEsSUFDdkU7QUFHQSxVQUFNLFFBQWtCLENBQUM7QUFDekIsVUFBTSxlQUFlLEtBQUssR0FBRyxPQUFPLFFBQWEsU0FBYyxhQUFrQjtBQUNoRixZQUFNLFVBQVUsUUFBUSxXQUFXLENBQUM7QUFDcEMsWUFBTSxPQUNMLE9BQU8sU0FBUyxZQUFZLFdBQ3pCLFFBQVEsVUFDUixTQUFTLFVBQVUsQ0FBQyxHQUFHLFFBQVE7QUFFbkMsVUFBSSxLQUFLLFNBQVMsb0JBQW9CLEdBQUc7QUFDeEMsY0FBTSxLQUFLLFFBQVE7QUFBQSxNQUNwQixPQUFPO0FBQ04sY0FBTSxLQUFLLFNBQVM7QUFBQSxNQUNyQjtBQUlBLGFBQU87QUFBQSxRQUNOO0FBQUEsTUFDRDtBQUFBLElBQ0QsQ0FBQztBQUVELFVBQU0sVUFBVSxNQUFNO0FBQUEsTUFDckI7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQTtBQUFBLE1BQ0E7QUFBQTtBQUFBLE1BQ0E7QUFBQTtBQUFBLE1BQ0E7QUFBQTtBQUFBLE1BQ0E7QUFBQTtBQUFBLElBQ0Q7QUFHQSxXQUFPO0FBQUEsTUFDTixhQUFhLEtBQUssVUFBVSxJQUFJO0FBQUEsTUFDaEMsMERBQTBELGFBQWEsS0FBSyxVQUFVLENBQUM7QUFBQSxJQUN4RjtBQUdBLFdBQU8sTUFBTSxNQUFNLENBQUMsR0FBRyxXQUFXLHFEQUFxRDtBQUN2RixhQUFTLElBQUksR0FBRyxJQUFJLE1BQU0sUUFBUSxLQUFLO0FBQ3RDLGFBQU8sTUFBTSxNQUFNLENBQUMsR0FBRyxVQUFVLFNBQVMsSUFBSSxDQUFDLHlDQUF5QztBQUFBLElBQ3pGO0FBR0EsV0FBTyxHQUFHLFFBQVEsU0FBUyxHQUFHLDZCQUE2QjtBQUFBLEVBQzVELENBQUM7QUFFRCxLQUFHLGtFQUFrRSxZQUFZO0FBQ2hGLFVBQU0sV0FBMkI7QUFBQSxNQUNoQyxnQkFBZ0IsR0FBTTtBQUFBLE1BQ3RCLGdCQUFnQixHQUFNO0FBQUEsSUFDdkI7QUFDQSxVQUFNLFFBQVEsVUFBVSxHQUFPO0FBQy9CLFVBQU0sZ0JBQWdCO0FBR3RCLFFBQUksY0FBYztBQUNsQixlQUFXLEtBQUssU0FBVSxnQkFBZSxlQUFlLENBQUM7QUFDekQsV0FBTztBQUFBLE1BQ04sY0FBYyxNQUFNO0FBQUEsTUFDcEIsZUFBZSxXQUFXLHlCQUF5QixNQUFNLGFBQWE7QUFBQSxJQUN2RTtBQUVBLFVBQU0sZUFBZSxLQUFLLEdBQUcsWUFBWSxpQkFBaUIscUJBQXFCLENBQUM7QUFFaEYsVUFBTSxnQkFBZ0IsVUFBVSxPQUFPLGVBQWUsUUFBVyxRQUFXLFFBQVcsUUFBVyxZQUFZO0FBRTlHLFdBQU87QUFBQSxNQUNOLGFBQWEsS0FBSyxVQUFVO0FBQUEsTUFDNUI7QUFBQSxNQUNBO0FBQUEsSUFDRDtBQUFBLEVBQ0QsQ0FBQztBQUVELEtBQUcsd0RBQXdELFlBQVk7QUFDdEUsVUFBTSxXQUEyQjtBQUFBLE1BQ2hDLHlCQUF5QixHQUFNO0FBQUEsTUFDL0IseUJBQXlCLEdBQU07QUFBQSxNQUMvQix5QkFBeUIsR0FBTTtBQUFBLElBQ2hDO0FBQ0EsVUFBTSxRQUFRLFVBQVUsR0FBTztBQUMvQixVQUFNLGdCQUFnQjtBQUN0QixVQUFNLGtCQUNMO0FBRUQsVUFBTSxVQUFvQixDQUFDO0FBQzNCLFVBQU0sZUFBZSxLQUFLLEdBQUcsT0FBTyxRQUFhLFlBQWlCO0FBQ2pFLFlBQU0sVUFBVSxRQUFRLFdBQVcsQ0FBQztBQUNwQyxZQUFNLE9BQ0wsT0FBTyxTQUFTLFlBQVksV0FDekIsUUFBUSxVQUNSLFNBQVMsVUFBVSxDQUFDLEdBQUcsUUFBUTtBQUNuQyxjQUFRLEtBQUssSUFBSTtBQUNqQixhQUFPO0FBQUEsUUFDTjtBQUFBLE1BQ0Q7QUFBQSxJQUNELENBQUM7QUFFRCxVQUFNO0FBQUEsTUFDTDtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxJQUNEO0FBR0EsV0FBTztBQUFBLE1BQ04sUUFBUSxDQUFDLEVBQUUsU0FBUyxlQUFlO0FBQUEsTUFDbkM7QUFBQSxJQUNEO0FBQUEsRUFDRCxDQUFDO0FBQ0YsQ0FBQztBQU1ELFNBQVMsb0NBQW9DLE1BQU07QUFDbEQsS0FBRywwREFBMEQsTUFBTTtBQUNsRSxXQUFPLE1BQU0sb0JBQW9CLE1BQVMsR0FBRyxLQUFLO0FBQ2xELFdBQU8sTUFBTSxvQkFBb0IsRUFBRSxHQUFHLE1BQU0sNEJBQTRCO0FBQ3hFLFdBQU8sTUFBTSxvQkFBb0IsV0FBVyxHQUFHLE1BQU0sNEJBQTRCO0FBQ2pGLFdBQU87QUFBQSxNQUNOLG9CQUFvQixzREFBc0Q7QUFBQSxNQUMxRTtBQUFBLE1BQ0E7QUFBQSxJQUNEO0FBQ0EsV0FBTztBQUFBLE1BQ04sb0JBQW9CLDhCQUE4QjtBQUFBLE1BQ2xEO0FBQUEsTUFDQTtBQUFBLElBQ0Q7QUFDQSxXQUFPO0FBQUEsTUFDTjtBQUFBLFFBQ0M7QUFBQSxNQUNEO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxJQUNEO0FBQUEsRUFDRCxDQUFDO0FBRUQsS0FBRyw2RkFBNkYsWUFBWTtBQUUzRyxVQUFNLFdBQTJCO0FBQUEsTUFDaEMseUJBQXlCLEdBQU07QUFBQSxNQUMvQix5QkFBeUIsR0FBTTtBQUFBLE1BQy9CLHlCQUF5QixHQUFNO0FBQUEsSUFDaEM7QUFDQSxVQUFNLFFBQVEsVUFBVSxHQUFPO0FBQy9CLFVBQU0sZ0JBQWdCO0FBT3RCLFFBQUksWUFBWTtBQUNoQixVQUFNLFlBQVk7QUFBQSxNQUNqQjtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRDtBQUNBLFVBQU0sY0FBd0IsQ0FBQztBQUMvQixVQUFNLGVBQWUsS0FBSyxHQUFHLE9BQU8sUUFBYSxZQUFpQjtBQUNqRSxZQUFNLFVBQVUsUUFBUSxXQUFXLENBQUM7QUFDcEMsWUFBTSxPQUNMLE9BQU8sU0FBUyxZQUFZLFdBQ3pCLFFBQVEsVUFDUixTQUFTLFVBQVUsQ0FBQyxHQUFHLFFBQVE7QUFDbkMsa0JBQVksS0FBSyxJQUFJO0FBQ3JCLFlBQU0sV0FBVyxVQUFVLEtBQUssSUFBSSxXQUFXLFVBQVUsU0FBUyxDQUFDLENBQUM7QUFDcEU7QUFDQSxhQUFPLGlCQUFpQixRQUFRO0FBQUEsSUFDakMsQ0FBQztBQUVELFVBQU0sVUFBVSxNQUFNO0FBQUEsTUFDckI7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRDtBQUlBLFdBQU87QUFBQSxNQUNOLENBQUMsb0JBQW9CLE9BQU87QUFBQSxNQUM1QixnREFBZ0QsS0FBSyxVQUFVLE9BQU8sQ0FBQztBQUFBLElBQ3hFO0FBQ0EsV0FBTztBQUFBLE1BQ04sUUFBUSxTQUFTLFlBQVksS0FBSyxRQUFRLFNBQVMsa0JBQWtCO0FBQUEsTUFDckU7QUFBQSxJQUNEO0FBQUEsRUFDRCxDQUFDO0FBRUQsS0FBRyx3RkFBd0YsWUFBWTtBQUd0RyxVQUFNLFdBQTJCO0FBQUEsTUFDaEMseUJBQXlCLEdBQU07QUFBQSxNQUMvQix5QkFBeUIsR0FBTTtBQUFBLElBQ2hDO0FBQ0EsVUFBTSxRQUFRLFVBQVUsR0FBTztBQUMvQixVQUFNLGdCQUFnQjtBQUV0QixVQUFNLFlBQVk7QUFBQSxNQUNqQjtBQUFBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxJQUNEO0FBQ0EsUUFBSSxZQUFZO0FBQ2hCLFVBQU0sZUFBZSxLQUFLLEdBQUcsWUFBWTtBQUN4QyxZQUFNLFdBQVcsVUFBVSxLQUFLLElBQUksV0FBVyxVQUFVLFNBQVMsQ0FBQyxDQUFDO0FBQ3BFO0FBQ0EsYUFBTyxpQkFBaUIsUUFBUTtBQUFBLElBQ2pDLENBQUM7QUFFRCxVQUFNLFVBQVUsTUFBTTtBQUFBLE1BQ3JCO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLElBQ0Q7QUFFQSxXQUFPO0FBQUEsTUFDTixDQUFDLG9CQUFvQixPQUFPO0FBQUEsTUFDNUI7QUFBQSxJQUNEO0FBQ0EsV0FBTztBQUFBLE1BQ04sYUFBYSxLQUFLLFVBQVUsS0FBSztBQUFBLE1BQ2pDLHVFQUF1RSxhQUFhLEtBQUssVUFBVSxDQUFDO0FBQUEsSUFDckc7QUFBQSxFQUNELENBQUM7QUFNRCxLQUFHLHlFQUF5RSxZQUFZO0FBSXZGLFVBQU0sV0FBMkI7QUFBQSxNQUNoQyx5QkFBeUIsR0FBTTtBQUFBLE1BQy9CLHlCQUF5QixHQUFNO0FBQUEsSUFDaEM7QUFDQSxVQUFNLFFBQVEsVUFBVSxHQUFPO0FBQy9CLFVBQU0sZ0JBQWdCO0FBRXRCLFVBQU0saUJBQWlCO0FBQ3ZCLFVBQU0sdUJBQXVCO0FBRTdCLFFBQUksWUFBWTtBQUNoQixVQUFNLFlBQVk7QUFBQSxNQUNqQjtBQUFBO0FBQUEsTUFDQTtBQUFBO0FBQUEsTUFDQTtBQUFBO0FBQUEsSUFDRDtBQUNBLFVBQU0sZUFBZSxLQUFLLEdBQUcsWUFBWTtBQUN4QyxZQUFNLElBQUksVUFBVSxLQUFLLElBQUksV0FBVyxVQUFVLFNBQVMsQ0FBQyxDQUFDO0FBQzdEO0FBQ0EsYUFBTyxpQkFBaUIsQ0FBQztBQUFBLElBQzFCLENBQUM7QUFFRCxVQUFNLFVBQVUsTUFBTTtBQUFBLE1BQ3JCO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLElBQ0Q7QUFFQSxXQUFPO0FBQUEsTUFDTixhQUFhLEtBQUssVUFBVTtBQUFBLE1BQzVCO0FBQUEsTUFDQTtBQUFBLElBQ0Q7QUFDQSxXQUFPO0FBQUEsTUFDTixRQUFRLFNBQVMsb0JBQW9CO0FBQUEsTUFDckMsbUdBQW1HLEtBQUssVUFBVSxPQUFPLENBQUM7QUFBQSxJQUMzSDtBQUFBLEVBQ0QsQ0FBQztBQU1ELEtBQUcsc0dBQXNHLFlBQVk7QUFDcEgsVUFBTSxXQUEyQjtBQUFBLE1BQ2hDLHlCQUF5QixHQUFNO0FBQUEsTUFDL0IseUJBQXlCLEdBQU07QUFBQSxJQUNoQztBQUNBLFVBQU0sUUFBUSxVQUFVLEdBQU87QUFDL0IsVUFBTSxnQkFBZ0I7QUFHdEIsVUFBTSxlQUFlLEtBQUssR0FBRyxZQUFZLGlCQUFpQixvQkFBb0IsQ0FBQztBQUUvRSxVQUFNLE9BQU87QUFBQSxNQUNaLE1BQU07QUFBQSxRQUNMO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUE7QUFBQSxRQUNBO0FBQUEsTUFDRDtBQUFBLE1BQ0EsQ0FBQyxRQUFpQixlQUFlO0FBQUEsTUFDakM7QUFBQSxJQUNEO0FBQUEsRUFDRCxDQUFDO0FBRUQsS0FBRyxxRUFBcUUsWUFBWTtBQUNuRixVQUFNLFdBQTJCO0FBQUEsTUFDaEMseUJBQXlCLEdBQU07QUFBQSxNQUMvQix5QkFBeUIsR0FBTTtBQUFBLElBQ2hDO0FBQ0EsVUFBTSxRQUFRLFVBQVUsR0FBTztBQUMvQixVQUFNLGdCQUFnQjtBQUN0QixVQUFNLGtCQUNMO0FBRUQsVUFBTSxlQUFlLEtBQUssR0FBRyxZQUFZLGlCQUFpQixvQkFBb0IsQ0FBQztBQUUvRSxVQUFNLFNBQVMsTUFBTTtBQUFBLE1BQ3BCO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLElBQ0Q7QUFFQSxXQUFPO0FBQUEsTUFDTjtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRDtBQUFBLEVBQ0QsQ0FBQztBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
