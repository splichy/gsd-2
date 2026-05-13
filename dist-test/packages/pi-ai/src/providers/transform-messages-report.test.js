import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { transformMessages, createEmptyReport, hasTransformations } from "./transform-messages.js";
function makeModel(overrides = {}) {
  return {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 2e5,
    maxTokens: 8192,
    ...overrides
  };
}
function makeAssistantMsg(overrides = {}) {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides
  };
}
describe("createEmptyReport", () => {
  test("creates report with zero counters", () => {
    const report = createEmptyReport("anthropic-messages", "openai-responses");
    assert.equal(report.fromApi, "anthropic-messages");
    assert.equal(report.toApi, "openai-responses");
    assert.equal(report.thinkingBlocksDropped, 0);
    assert.equal(report.thinkingBlocksDowngraded, 0);
    assert.equal(report.toolCallIdsRemapped, 0);
    assert.equal(report.syntheticToolResultsInserted, 0);
    assert.equal(report.thoughtSignaturesDropped, 0);
  });
});
describe("hasTransformations", () => {
  test("returns false for empty report", () => {
    const report = createEmptyReport("a", "b");
    assert.equal(hasTransformations(report), false);
  });
  test("returns true when any counter is non-zero", () => {
    const report = createEmptyReport("a", "b");
    report.thinkingBlocksDropped = 1;
    assert.equal(hasTransformations(report), true);
  });
});
describe("transformMessages with report tracking", () => {
  test("tracks thinking blocks dropped for redacted cross-model", () => {
    const model = makeModel({ id: "gpt-5", api: "openai-responses", provider: "openai" });
    const messages = [
      makeAssistantMsg({
        content: [
          { type: "thinking", thinking: "", redacted: true },
          { type: "text", text: "Hello" }
        ]
      })
    ];
    const report = createEmptyReport("anthropic-messages", "openai-responses");
    transformMessages(messages, model, void 0, report);
    assert.equal(report.thinkingBlocksDropped, 1);
  });
  test("tracks thinking blocks downgraded to plain text", () => {
    const model = makeModel({ id: "gpt-5", api: "openai-responses", provider: "openai" });
    const messages = [
      makeAssistantMsg({
        content: [
          { type: "thinking", thinking: "Let me think about this..." },
          { type: "text", text: "Here is my answer" }
        ]
      })
    ];
    const report = createEmptyReport("anthropic-messages", "openai-responses");
    transformMessages(messages, model, void 0, report);
    assert.equal(report.thinkingBlocksDowngraded, 1);
  });
  test("tracks tool call IDs remapped", () => {
    const model = makeModel({ id: "claude-sonnet-4-6", api: "anthropic-messages", provider: "anthropic" });
    const toolCall = {
      type: "toolCall",
      id: "original-long-id-that-needs-normalization|with-special-chars",
      name: "bash",
      arguments: { command: "ls" }
    };
    const messages = [
      makeAssistantMsg({
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5",
        content: [toolCall]
      })
    ];
    const normalizer = (id) => id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
    const report = createEmptyReport("openai-responses", "anthropic-messages");
    transformMessages(messages, model, normalizer, report);
    assert.equal(report.toolCallIdsRemapped, 1);
  });
  test("tracks thought signatures dropped", () => {
    const model = makeModel({ id: "claude-sonnet-4-6", api: "anthropic-messages", provider: "anthropic" });
    const toolCall = {
      type: "toolCall",
      id: "tc_001",
      name: "bash",
      arguments: { command: "ls" },
      thoughtSignature: "some-opaque-signature"
    };
    const messages = [
      makeAssistantMsg({
        provider: "google",
        api: "google-generative-ai",
        model: "gemini-2.5-pro",
        content: [toolCall]
      })
    ];
    const report = createEmptyReport("google-generative-ai", "anthropic-messages");
    transformMessages(messages, model, void 0, report);
    assert.equal(report.thoughtSignaturesDropped, 1);
  });
  test("tracks synthetic tool results inserted", () => {
    const model = makeModel();
    const toolCall = {
      type: "toolCall",
      id: "tc_orphan",
      name: "bash",
      arguments: { command: "ls" }
    };
    const messages = [
      makeAssistantMsg({ content: [toolCall, { type: "text", text: "Using bash" }] }),
      makeAssistantMsg({ content: [{ type: "text", text: "Next message" }] })
    ];
    const report = createEmptyReport("anthropic-messages", "anthropic-messages");
    transformMessages(messages, model, void 0, report);
    assert.equal(report.syntheticToolResultsInserted, 1);
  });
  test("does not count transformations for same-model messages", () => {
    const model = makeModel();
    const messages = [
      makeAssistantMsg({
        content: [
          { type: "thinking", thinking: "Let me think..." },
          { type: "text", text: "Answer" }
        ]
      })
    ];
    const report = createEmptyReport("anthropic-messages", "anthropic-messages");
    transformMessages(messages, model, void 0, report);
    assert.equal(report.thinkingBlocksDowngraded, 0);
    assert.equal(report.thinkingBlocksDropped, 0);
  });
  test("works without report parameter (backward compatible)", () => {
    const model = makeModel();
    const messages = [
      makeAssistantMsg({ content: [{ type: "text", text: "Hello" }] })
    ];
    const result = transformMessages(messages, model);
    assert.ok(Array.isArray(result));
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWkvc3JjL3Byb3ZpZGVycy90cmFuc2Zvcm0tbWVzc2FnZXMtcmVwb3J0LnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRC0yIFx1MjAxNCBQcm92aWRlclN3aXRjaFJlcG9ydCBUZXN0cyAoQURSLTAwNSBQaGFzZSAzKVxuaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcblxuaW1wb3J0IHsgdHJhbnNmb3JtTWVzc2FnZXMsIGNyZWF0ZUVtcHR5UmVwb3J0LCBoYXNUcmFuc2Zvcm1hdGlvbnMgfSBmcm9tIFwiLi90cmFuc2Zvcm0tbWVzc2FnZXMuanNcIjtcbmltcG9ydCB0eXBlIHsgUHJvdmlkZXJTd2l0Y2hSZXBvcnQgfSBmcm9tIFwiLi90cmFuc2Zvcm0tbWVzc2FnZXMuanNcIjtcbmltcG9ydCB0eXBlIHsgTWVzc2FnZSwgTW9kZWwsIEFzc2lzdGFudE1lc3NhZ2UsIFRvb2xDYWxsIH0gZnJvbSBcIi4uL3R5cGVzLmpzXCI7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBIZWxwZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBtYWtlTW9kZWwob3ZlcnJpZGVzOiBQYXJ0aWFsPE1vZGVsPGFueT4+ID0ge30pOiBNb2RlbDxhbnk+IHtcbiAgcmV0dXJuIHtcbiAgICBpZDogXCJjbGF1ZGUtc29ubmV0LTQtNlwiLFxuICAgIG5hbWU6IFwiQ2xhdWRlIFNvbm5ldCA0LjZcIixcbiAgICBhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG4gICAgcHJvdmlkZXI6IFwiYW50aHJvcGljXCIsXG4gICAgYmFzZVVybDogXCJcIixcbiAgICByZWFzb25pbmc6IGZhbHNlLFxuICAgIGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG4gICAgY29zdDogeyBpbnB1dDogMCwgb3V0cHV0OiAwLCBjYWNoZVJlYWQ6IDAsIGNhY2hlV3JpdGU6IDAgfSxcbiAgICBjb250ZXh0V2luZG93OiAyMDAwMDAsXG4gICAgbWF4VG9rZW5zOiA4MTkyLFxuICAgIC4uLm92ZXJyaWRlcyxcbiAgfSBhcyBNb2RlbDxhbnk+O1xufVxuXG5mdW5jdGlvbiBtYWtlQXNzaXN0YW50TXNnKG92ZXJyaWRlczogUGFydGlhbDxBc3Npc3RhbnRNZXNzYWdlPiA9IHt9KTogQXNzaXN0YW50TWVzc2FnZSB7XG4gIHJldHVybiB7XG4gICAgcm9sZTogXCJhc3Npc3RhbnRcIixcbiAgICBjb250ZW50OiBbXSxcbiAgICBhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG4gICAgcHJvdmlkZXI6IFwiYW50aHJvcGljXCIsXG4gICAgbW9kZWw6IFwiY2xhdWRlLXNvbm5ldC00LTZcIixcbiAgICB1c2FnZTogeyBpbnB1dDogMCwgb3V0cHV0OiAwLCBjYWNoZVJlYWQ6IDAsIGNhY2hlV3JpdGU6IDAsIHRvdGFsVG9rZW5zOiAwLCBjb3N0OiB7IGlucHV0OiAwLCBvdXRwdXQ6IDAsIGNhY2hlUmVhZDogMCwgY2FjaGVXcml0ZTogMCwgdG90YWw6IDAgfSB9LFxuICAgIHN0b3BSZWFzb246IFwic3RvcFwiLFxuICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcbiAgICAuLi5vdmVycmlkZXMsXG4gIH07XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBjcmVhdGVFbXB0eVJlcG9ydCAvIGhhc1RyYW5zZm9ybWF0aW9ucyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJjcmVhdGVFbXB0eVJlcG9ydFwiLCAoKSA9PiB7XG4gIHRlc3QoXCJjcmVhdGVzIHJlcG9ydCB3aXRoIHplcm8gY291bnRlcnNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlcG9ydCA9IGNyZWF0ZUVtcHR5UmVwb3J0KFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsIFwib3BlbmFpLXJlc3BvbnNlc1wiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVwb3J0LmZyb21BcGksIFwiYW50aHJvcGljLW1lc3NhZ2VzXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXBvcnQudG9BcGksIFwib3BlbmFpLXJlc3BvbnNlc1wiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVwb3J0LnRoaW5raW5nQmxvY2tzRHJvcHBlZCwgMCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlcG9ydC50aGlua2luZ0Jsb2Nrc0Rvd25ncmFkZWQsIDApO1xuICAgIGFzc2VydC5lcXVhbChyZXBvcnQudG9vbENhbGxJZHNSZW1hcHBlZCwgMCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlcG9ydC5zeW50aGV0aWNUb29sUmVzdWx0c0luc2VydGVkLCAwKTtcbiAgICBhc3NlcnQuZXF1YWwocmVwb3J0LnRob3VnaHRTaWduYXR1cmVzRHJvcHBlZCwgMCk7XG4gIH0pO1xufSk7XG5cbmRlc2NyaWJlKFwiaGFzVHJhbnNmb3JtYXRpb25zXCIsICgpID0+IHtcbiAgdGVzdChcInJldHVybnMgZmFsc2UgZm9yIGVtcHR5IHJlcG9ydFwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVwb3J0ID0gY3JlYXRlRW1wdHlSZXBvcnQoXCJhXCIsIFwiYlwiKTtcbiAgICBhc3NlcnQuZXF1YWwoaGFzVHJhbnNmb3JtYXRpb25zKHJlcG9ydCksIGZhbHNlKTtcbiAgfSk7XG5cbiAgdGVzdChcInJldHVybnMgdHJ1ZSB3aGVuIGFueSBjb3VudGVyIGlzIG5vbi16ZXJvXCIsICgpID0+IHtcbiAgICBjb25zdCByZXBvcnQgPSBjcmVhdGVFbXB0eVJlcG9ydChcImFcIiwgXCJiXCIpO1xuICAgIHJlcG9ydC50aGlua2luZ0Jsb2Nrc0Ryb3BwZWQgPSAxO1xuICAgIGFzc2VydC5lcXVhbChoYXNUcmFuc2Zvcm1hdGlvbnMocmVwb3J0KSwgdHJ1ZSk7XG4gIH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBSZXBvcnQgVHJhY2tpbmcgaW4gdHJhbnNmb3JtTWVzc2FnZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwidHJhbnNmb3JtTWVzc2FnZXMgd2l0aCByZXBvcnQgdHJhY2tpbmdcIiwgKCkgPT4ge1xuICB0ZXN0KFwidHJhY2tzIHRoaW5raW5nIGJsb2NrcyBkcm9wcGVkIGZvciByZWRhY3RlZCBjcm9zcy1tb2RlbFwiLCAoKSA9PiB7XG4gICAgY29uc3QgbW9kZWwgPSBtYWtlTW9kZWwoeyBpZDogXCJncHQtNVwiLCBhcGk6IFwib3BlbmFpLXJlc3BvbnNlc1wiLCBwcm92aWRlcjogXCJvcGVuYWlcIiB9KTtcbiAgICBjb25zdCBtZXNzYWdlczogTWVzc2FnZVtdID0gW1xuICAgICAgbWFrZUFzc2lzdGFudE1zZyh7XG4gICAgICAgIGNvbnRlbnQ6IFtcbiAgICAgICAgICB7IHR5cGU6IFwidGhpbmtpbmdcIiwgdGhpbmtpbmc6IFwiXCIsIHJlZGFjdGVkOiB0cnVlIH0sXG4gICAgICAgICAgeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJIZWxsb1wiIH0sXG4gICAgICAgIF0sXG4gICAgICB9KSxcbiAgICBdO1xuICAgIGNvbnN0IHJlcG9ydCA9IGNyZWF0ZUVtcHR5UmVwb3J0KFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsIFwib3BlbmFpLXJlc3BvbnNlc1wiKTtcbiAgICB0cmFuc2Zvcm1NZXNzYWdlcyhtZXNzYWdlcywgbW9kZWwsIHVuZGVmaW5lZCwgcmVwb3J0KTtcbiAgICBhc3NlcnQuZXF1YWwocmVwb3J0LnRoaW5raW5nQmxvY2tzRHJvcHBlZCwgMSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJ0cmFja3MgdGhpbmtpbmcgYmxvY2tzIGRvd25ncmFkZWQgdG8gcGxhaW4gdGV4dFwiLCAoKSA9PiB7XG4gICAgY29uc3QgbW9kZWwgPSBtYWtlTW9kZWwoeyBpZDogXCJncHQtNVwiLCBhcGk6IFwib3BlbmFpLXJlc3BvbnNlc1wiLCBwcm92aWRlcjogXCJvcGVuYWlcIiB9KTtcbiAgICBjb25zdCBtZXNzYWdlczogTWVzc2FnZVtdID0gW1xuICAgICAgbWFrZUFzc2lzdGFudE1zZyh7XG4gICAgICAgIGNvbnRlbnQ6IFtcbiAgICAgICAgICB7IHR5cGU6IFwidGhpbmtpbmdcIiwgdGhpbmtpbmc6IFwiTGV0IG1lIHRoaW5rIGFib3V0IHRoaXMuLi5cIiB9LFxuICAgICAgICAgIHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiSGVyZSBpcyBteSBhbnN3ZXJcIiB9LFxuICAgICAgICBdLFxuICAgICAgfSksXG4gICAgXTtcbiAgICBjb25zdCByZXBvcnQgPSBjcmVhdGVFbXB0eVJlcG9ydChcImFudGhyb3BpYy1tZXNzYWdlc1wiLCBcIm9wZW5haS1yZXNwb25zZXNcIik7XG4gICAgdHJhbnNmb3JtTWVzc2FnZXMobWVzc2FnZXMsIG1vZGVsLCB1bmRlZmluZWQsIHJlcG9ydCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlcG9ydC50aGlua2luZ0Jsb2Nrc0Rvd25ncmFkZWQsIDEpO1xuICB9KTtcblxuICB0ZXN0KFwidHJhY2tzIHRvb2wgY2FsbCBJRHMgcmVtYXBwZWRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IG1vZGVsID0gbWFrZU1vZGVsKHsgaWQ6IFwiY2xhdWRlLXNvbm5ldC00LTZcIiwgYXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLCBwcm92aWRlcjogXCJhbnRocm9waWNcIiB9KTtcbiAgICBjb25zdCB0b29sQ2FsbDogVG9vbENhbGwgPSB7XG4gICAgICB0eXBlOiBcInRvb2xDYWxsXCIsXG4gICAgICBpZDogXCJvcmlnaW5hbC1sb25nLWlkLXRoYXQtbmVlZHMtbm9ybWFsaXphdGlvbnx3aXRoLXNwZWNpYWwtY2hhcnNcIixcbiAgICAgIG5hbWU6IFwiYmFzaFwiLFxuICAgICAgYXJndW1lbnRzOiB7IGNvbW1hbmQ6IFwibHNcIiB9LFxuICAgIH07XG4gICAgY29uc3QgbWVzc2FnZXM6IE1lc3NhZ2VbXSA9IFtcbiAgICAgIG1ha2VBc3Npc3RhbnRNc2coe1xuICAgICAgICBwcm92aWRlcjogXCJvcGVuYWlcIixcbiAgICAgICAgYXBpOiBcIm9wZW5haS1yZXNwb25zZXNcIixcbiAgICAgICAgbW9kZWw6IFwiZ3B0LTVcIixcbiAgICAgICAgY29udGVudDogW3Rvb2xDYWxsXSxcbiAgICAgIH0pLFxuICAgIF07XG4gICAgY29uc3Qgbm9ybWFsaXplciA9IChpZDogc3RyaW5nKSA9PiBpZC5yZXBsYWNlKC9bXmEtekEtWjAtOV8tXS9nLCBcIl9cIikuc2xpY2UoMCwgNjQpO1xuICAgIGNvbnN0IHJlcG9ydCA9IGNyZWF0ZUVtcHR5UmVwb3J0KFwib3BlbmFpLXJlc3BvbnNlc1wiLCBcImFudGhyb3BpYy1tZXNzYWdlc1wiKTtcbiAgICB0cmFuc2Zvcm1NZXNzYWdlcyhtZXNzYWdlcywgbW9kZWwsIG5vcm1hbGl6ZXIsIHJlcG9ydCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlcG9ydC50b29sQ2FsbElkc1JlbWFwcGVkLCAxKTtcbiAgfSk7XG5cbiAgdGVzdChcInRyYWNrcyB0aG91Z2h0IHNpZ25hdHVyZXMgZHJvcHBlZFwiLCAoKSA9PiB7XG4gICAgY29uc3QgbW9kZWwgPSBtYWtlTW9kZWwoeyBpZDogXCJjbGF1ZGUtc29ubmV0LTQtNlwiLCBhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsIHByb3ZpZGVyOiBcImFudGhyb3BpY1wiIH0pO1xuICAgIGNvbnN0IHRvb2xDYWxsOiBUb29sQ2FsbCA9IHtcbiAgICAgIHR5cGU6IFwidG9vbENhbGxcIixcbiAgICAgIGlkOiBcInRjXzAwMVwiLFxuICAgICAgbmFtZTogXCJiYXNoXCIsXG4gICAgICBhcmd1bWVudHM6IHsgY29tbWFuZDogXCJsc1wiIH0sXG4gICAgICB0aG91Z2h0U2lnbmF0dXJlOiBcInNvbWUtb3BhcXVlLXNpZ25hdHVyZVwiLFxuICAgIH07XG4gICAgY29uc3QgbWVzc2FnZXM6IE1lc3NhZ2VbXSA9IFtcbiAgICAgIG1ha2VBc3Npc3RhbnRNc2coe1xuICAgICAgICBwcm92aWRlcjogXCJnb29nbGVcIixcbiAgICAgICAgYXBpOiBcImdvb2dsZS1nZW5lcmF0aXZlLWFpXCIsXG4gICAgICAgIG1vZGVsOiBcImdlbWluaS0yLjUtcHJvXCIsXG4gICAgICAgIGNvbnRlbnQ6IFt0b29sQ2FsbF0sXG4gICAgICB9KSxcbiAgICBdO1xuICAgIGNvbnN0IHJlcG9ydCA9IGNyZWF0ZUVtcHR5UmVwb3J0KFwiZ29vZ2xlLWdlbmVyYXRpdmUtYWlcIiwgXCJhbnRocm9waWMtbWVzc2FnZXNcIik7XG4gICAgdHJhbnNmb3JtTWVzc2FnZXMobWVzc2FnZXMsIG1vZGVsLCB1bmRlZmluZWQsIHJlcG9ydCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlcG9ydC50aG91Z2h0U2lnbmF0dXJlc0Ryb3BwZWQsIDEpO1xuICB9KTtcblxuICB0ZXN0KFwidHJhY2tzIHN5bnRoZXRpYyB0b29sIHJlc3VsdHMgaW5zZXJ0ZWRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IG1vZGVsID0gbWFrZU1vZGVsKCk7XG4gICAgY29uc3QgdG9vbENhbGw6IFRvb2xDYWxsID0ge1xuICAgICAgdHlwZTogXCJ0b29sQ2FsbFwiLFxuICAgICAgaWQ6IFwidGNfb3JwaGFuXCIsXG4gICAgICBuYW1lOiBcImJhc2hcIixcbiAgICAgIGFyZ3VtZW50czogeyBjb21tYW5kOiBcImxzXCIgfSxcbiAgICB9O1xuICAgIC8vIEFzc2lzdGFudCBtZXNzYWdlIHdpdGggdG9vbCBjYWxsIGZvbGxvd2VkIGJ5IGFub3RoZXIgYXNzaXN0YW50IChubyB0b29sIHJlc3VsdClcbiAgICBjb25zdCBtZXNzYWdlczogTWVzc2FnZVtdID0gW1xuICAgICAgbWFrZUFzc2lzdGFudE1zZyh7IGNvbnRlbnQ6IFt0b29sQ2FsbCwgeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJVc2luZyBiYXNoXCIgfV0gfSksXG4gICAgICBtYWtlQXNzaXN0YW50TXNnKHsgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiTmV4dCBtZXNzYWdlXCIgfV0gfSksXG4gICAgXTtcbiAgICBjb25zdCByZXBvcnQgPSBjcmVhdGVFbXB0eVJlcG9ydChcImFudGhyb3BpYy1tZXNzYWdlc1wiLCBcImFudGhyb3BpYy1tZXNzYWdlc1wiKTtcbiAgICB0cmFuc2Zvcm1NZXNzYWdlcyhtZXNzYWdlcywgbW9kZWwsIHVuZGVmaW5lZCwgcmVwb3J0KTtcbiAgICBhc3NlcnQuZXF1YWwocmVwb3J0LnN5bnRoZXRpY1Rvb2xSZXN1bHRzSW5zZXJ0ZWQsIDEpO1xuICB9KTtcblxuICB0ZXN0KFwiZG9lcyBub3QgY291bnQgdHJhbnNmb3JtYXRpb25zIGZvciBzYW1lLW1vZGVsIG1lc3NhZ2VzXCIsICgpID0+IHtcbiAgICBjb25zdCBtb2RlbCA9IG1ha2VNb2RlbCgpO1xuICAgIGNvbnN0IG1lc3NhZ2VzOiBNZXNzYWdlW10gPSBbXG4gICAgICBtYWtlQXNzaXN0YW50TXNnKHtcbiAgICAgICAgY29udGVudDogW1xuICAgICAgICAgIHsgdHlwZTogXCJ0aGlua2luZ1wiLCB0aGlua2luZzogXCJMZXQgbWUgdGhpbmsuLi5cIiB9LFxuICAgICAgICAgIHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiQW5zd2VyXCIgfSxcbiAgICAgICAgXSxcbiAgICAgIH0pLFxuICAgIF07XG4gICAgY29uc3QgcmVwb3J0ID0gY3JlYXRlRW1wdHlSZXBvcnQoXCJhbnRocm9waWMtbWVzc2FnZXNcIiwgXCJhbnRocm9waWMtbWVzc2FnZXNcIik7XG4gICAgdHJhbnNmb3JtTWVzc2FnZXMobWVzc2FnZXMsIG1vZGVsLCB1bmRlZmluZWQsIHJlcG9ydCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlcG9ydC50aGlua2luZ0Jsb2Nrc0Rvd25ncmFkZWQsIDApO1xuICAgIGFzc2VydC5lcXVhbChyZXBvcnQudGhpbmtpbmdCbG9ja3NEcm9wcGVkLCAwKTtcbiAgfSk7XG5cbiAgdGVzdChcIndvcmtzIHdpdGhvdXQgcmVwb3J0IHBhcmFtZXRlciAoYmFja3dhcmQgY29tcGF0aWJsZSlcIiwgKCkgPT4ge1xuICAgIGNvbnN0IG1vZGVsID0gbWFrZU1vZGVsKCk7XG4gICAgY29uc3QgbWVzc2FnZXM6IE1lc3NhZ2VbXSA9IFtcbiAgICAgIG1ha2VBc3Npc3RhbnRNc2coeyBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJIZWxsb1wiIH1dIH0pLFxuICAgIF07XG4gICAgLy8gU2hvdWxkIG5vdCB0aHJvd1xuICAgIGNvbnN0IHJlc3VsdCA9IHRyYW5zZm9ybU1lc3NhZ2VzKG1lc3NhZ2VzLCBtb2RlbCk7XG4gICAgYXNzZXJ0Lm9rKEFycmF5LmlzQXJyYXkocmVzdWx0KSk7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFDQSxTQUFTLFVBQVUsWUFBWTtBQUMvQixPQUFPLFlBQVk7QUFFbkIsU0FBUyxtQkFBbUIsbUJBQW1CLDBCQUEwQjtBQU16RSxTQUFTLFVBQVUsWUFBaUMsQ0FBQyxHQUFlO0FBQ2xFLFNBQU87QUFBQSxJQUNMLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNLEVBQUUsT0FBTyxHQUFHLFFBQVEsR0FBRyxXQUFXLEdBQUcsWUFBWSxFQUFFO0FBQUEsSUFDekQsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLElBQ1gsR0FBRztBQUFBLEVBQ0w7QUFDRjtBQUVBLFNBQVMsaUJBQWlCLFlBQXVDLENBQUMsR0FBcUI7QUFDckYsU0FBTztBQUFBLElBQ0wsTUFBTTtBQUFBLElBQ04sU0FBUyxDQUFDO0FBQUEsSUFDVixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixPQUFPO0FBQUEsSUFDUCxPQUFPLEVBQUUsT0FBTyxHQUFHLFFBQVEsR0FBRyxXQUFXLEdBQUcsWUFBWSxHQUFHLGFBQWEsR0FBRyxNQUFNLEVBQUUsT0FBTyxHQUFHLFFBQVEsR0FBRyxXQUFXLEdBQUcsWUFBWSxHQUFHLE9BQU8sRUFBRSxFQUFFO0FBQUEsSUFDaEosWUFBWTtBQUFBLElBQ1osV0FBVyxLQUFLLElBQUk7QUFBQSxJQUNwQixHQUFHO0FBQUEsRUFDTDtBQUNGO0FBSUEsU0FBUyxxQkFBcUIsTUFBTTtBQUNsQyxPQUFLLHFDQUFxQyxNQUFNO0FBQzlDLFVBQU0sU0FBUyxrQkFBa0Isc0JBQXNCLGtCQUFrQjtBQUN6RSxXQUFPLE1BQU0sT0FBTyxTQUFTLG9CQUFvQjtBQUNqRCxXQUFPLE1BQU0sT0FBTyxPQUFPLGtCQUFr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
