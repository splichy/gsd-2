import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isContextOverflow } from "../overflow.js";
function makeAssistantMessage(overrides = {}) {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "error",
    timestamp: Date.now(),
    ...overrides
  };
}
describe("isContextOverflow", () => {
  test("detects overflow from provider errorMessage", () => {
    const message = makeAssistantMessage({
      errorMessage: "prompt is too long: 213462 tokens > 200000 maximum"
    });
    assert.equal(isContextOverflow(message, 2e5), true);
  });
  test("detects claude-code overflow when text contains the error but errorMessage is generic (#3925)", () => {
    const message = makeAssistantMessage({
      provider: "claude-code",
      api: "anthropic-messages",
      model: "claude-sonnet-4-6",
      errorMessage: "success",
      content: [{ type: "text", text: "Prompt is too long" }]
    });
    assert.equal(isContextOverflow(message, 2e5), true);
  });
  test("does not treat normal non-error text as overflow", () => {
    const message = makeAssistantMessage({
      stopReason: "stop",
      errorMessage: void 0,
      content: [{ type: "text", text: "Prompt is too long" }]
    });
    assert.equal(isContextOverflow(message, 2e5), false);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWkvc3JjL3V0aWxzL3Rlc3RzL292ZXJmbG93LnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IGRlc2NyaWJlLCB0ZXN0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5cbmltcG9ydCB7IGlzQ29udGV4dE92ZXJmbG93IH0gZnJvbSBcIi4uL292ZXJmbG93LmpzXCI7XG5pbXBvcnQgdHlwZSB7IEFzc2lzdGFudE1lc3NhZ2UgfSBmcm9tIFwiLi4vLi4vdHlwZXMuanNcIjtcblxuZnVuY3Rpb24gbWFrZUFzc2lzdGFudE1lc3NhZ2Uob3ZlcnJpZGVzOiBQYXJ0aWFsPEFzc2lzdGFudE1lc3NhZ2U+ID0ge30pOiBBc3Npc3RhbnRNZXNzYWdlIHtcblx0cmV0dXJuIHtcblx0XHRyb2xlOiBcImFzc2lzdGFudFwiLFxuXHRcdGNvbnRlbnQ6IFtdLFxuXHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRwcm92aWRlcjogXCJhbnRocm9waWNcIixcblx0XHRtb2RlbDogXCJjbGF1ZGUtc29ubmV0LTQtNlwiLFxuXHRcdHVzYWdlOiB7XG5cdFx0XHRpbnB1dDogMCxcblx0XHRcdG91dHB1dDogMCxcblx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR0b3RhbFRva2VuczogMCxcblx0XHRcdGNvc3Q6IHsgaW5wdXQ6IDAsIG91dHB1dDogMCwgY2FjaGVSZWFkOiAwLCBjYWNoZVdyaXRlOiAwLCB0b3RhbDogMCB9LFxuXHRcdH0sXG5cdFx0c3RvcFJlYXNvbjogXCJlcnJvclwiLFxuXHRcdHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcblx0XHQuLi5vdmVycmlkZXMsXG5cdH07XG59XG5cbmRlc2NyaWJlKFwiaXNDb250ZXh0T3ZlcmZsb3dcIiwgKCkgPT4ge1xuXHR0ZXN0KFwiZGV0ZWN0cyBvdmVyZmxvdyBmcm9tIHByb3ZpZGVyIGVycm9yTWVzc2FnZVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgbWVzc2FnZSA9IG1ha2VBc3Npc3RhbnRNZXNzYWdlKHtcblx0XHRcdGVycm9yTWVzc2FnZTogXCJwcm9tcHQgaXMgdG9vIGxvbmc6IDIxMzQ2MiB0b2tlbnMgPiAyMDAwMDAgbWF4aW11bVwiLFxuXHRcdH0pO1xuXG5cdFx0YXNzZXJ0LmVxdWFsKGlzQ29udGV4dE92ZXJmbG93KG1lc3NhZ2UsIDIwMDAwMCksIHRydWUpO1xuXHR9KTtcblxuXHR0ZXN0KFwiZGV0ZWN0cyBjbGF1ZGUtY29kZSBvdmVyZmxvdyB3aGVuIHRleHQgY29udGFpbnMgdGhlIGVycm9yIGJ1dCBlcnJvck1lc3NhZ2UgaXMgZ2VuZXJpYyAoIzM5MjUpXCIsICgpID0+IHtcblx0XHRjb25zdCBtZXNzYWdlID0gbWFrZUFzc2lzdGFudE1lc3NhZ2Uoe1xuXHRcdFx0cHJvdmlkZXI6IFwiY2xhdWRlLWNvZGVcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdG1vZGVsOiBcImNsYXVkZS1zb25uZXQtNC02XCIsXG5cdFx0XHRlcnJvck1lc3NhZ2U6IFwic3VjY2Vzc1wiLFxuXHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiUHJvbXB0IGlzIHRvbyBsb25nXCIgfV0sXG5cdFx0fSk7XG5cblx0XHRhc3NlcnQuZXF1YWwoaXNDb250ZXh0T3ZlcmZsb3cobWVzc2FnZSwgMjAwMDAwKSwgdHJ1ZSk7XG5cdH0pO1xuXG5cdHRlc3QoXCJkb2VzIG5vdCB0cmVhdCBub3JtYWwgbm9uLWVycm9yIHRleHQgYXMgb3ZlcmZsb3dcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IG1lc3NhZ2UgPSBtYWtlQXNzaXN0YW50TWVzc2FnZSh7XG5cdFx0XHRzdG9wUmVhc29uOiBcInN0b3BcIixcblx0XHRcdGVycm9yTWVzc2FnZTogdW5kZWZpbmVkLFxuXHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiUHJvbXB0IGlzIHRvbyBsb25nXCIgfV0sXG5cdFx0fSk7XG5cblx0XHRhc3NlcnQuZXF1YWwoaXNDb250ZXh0T3ZlcmZsb3cobWVzc2FnZSwgMjAwMDAwKSwgZmFsc2UpO1xuXHR9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxVQUFVLFlBQVk7QUFDL0IsT0FBTyxZQUFZO0FBRW5CLFNBQVMseUJBQXlCO0FBR2xDLFNBQVMscUJBQXFCLFlBQXVDLENBQUMsR0FBcUI7QUFDMUYsU0FBTztBQUFBLElBQ04sTUFBTTtBQUFBLElBQ04sU0FBUyxDQUFDO0FBQUEsSUFDVixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixPQUFPO0FBQUEsSUFDUCxPQUFPO0FBQUEsTUFDTixPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsTUFDWixhQUFhO0FBQUEsTUFDYixNQUFNLEVBQUUsT0FBTyxHQUFHLFFBQVEsR0FBRyxXQUFXLEdBQUcsWUFBWSxHQUFHLE9BQU8sRUFBRTtBQUFBLElBQ3BFO0FBQUEsSUFDQSxZQUFZO0FBQUEsSUFDWixXQUFXLEtBQUssSUFBSTtBQUFBLElBQ3BCLEdBQUc7QUFBQSxFQUNKO0FBQ0Q7QUFFQSxTQUFTLHFCQUFxQixNQUFNO0FBQ25DLE9BQUssK0NBQStDLE1BQU07QUFDekQsVUFBTSxVQUFVLHFCQUFxQjtBQUFBLE1BQ3BDLGNBQWM7QUFBQSxJQUNmLENBQUM7QUFFRCxXQUFPLE1BQU0sa0JBQWtCLFNBQVMsR0FBTSxHQUFHLElBQUk7QUFBQSxFQUN0RCxDQUFDO0FBRUQsT0FBSyxpR0FBaUcsTUFBTTtBQUMzRyxVQUFNLFVBQVUscUJBQXFCO0FBQUEsTUFDcEMsVUFBVTtBQUFBLE1BQ1YsS0FBSztBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsY0FBYztBQUFBLE1BQ2QsU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFRLE1BQU0scUJBQXFCLENBQUM7QUFBQSxJQUN2RCxDQUFDO0FBRUQsV0FBTyxNQUFNLGtCQUFrQixTQUFTLEdBQU0sR0FBRyxJQUFJO0FBQUEsRUFDdEQsQ0FBQztBQUVELE9BQUssb0RBQW9ELE1BQU07QUFDOUQsVUFBTSxVQUFVLHFCQUFxQjtBQUFBLE1BQ3BDLFlBQVk7QUFBQSxNQUNaLGNBQWM7QUFBQSxNQUNkLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBUSxNQUFNLHFCQUFxQixDQUFDO0FBQUEsSUFDdkQsQ0FBQztBQUVELFdBQU8sTUFBTSxrQkFBa0IsU0FBUyxHQUFNLEdBQUcsS0FBSztBQUFBLEVBQ3ZELENBQUM7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
