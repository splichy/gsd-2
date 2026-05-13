import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { buildAnthropicClientOptions } from "./anthropic.js";
import { convertMessages } from "./anthropic-shared.js";
function anthropicModel(overrides = {}) {
  return {
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 2e5,
    maxTokens: 8192,
    ...overrides
  };
}
describe("MiniMax fine-grained-tool-streaming exclusion (#4538)", () => {
  test("minimax is excluded from fine-grained-tool-streaming-2025-05-14 beta", () => {
    const options = buildAnthropicClientOptions(anthropicModel({ provider: "minimax" }), "api-key", false);
    assert.equal(
      options.defaultHeaders["anthropic-beta"],
      void 0,
      "minimax must suppress fine-grained-tool-streaming"
    );
  });
  test("minimax-cn is excluded from fine-grained-tool-streaming-2025-05-14 beta", () => {
    const options = buildAnthropicClientOptions(anthropicModel({ provider: "minimax-cn" }), "api-key", false);
    assert.equal(
      options.defaultHeaders["anthropic-beta"],
      void 0,
      "minimax-cn must suppress fine-grained-tool-streaming"
    );
  });
  test("standard Anthropic-compatible providers keep fine-grained-tool-streaming enabled", () => {
    const options = buildAnthropicClientOptions(anthropicModel(), "api-key", false);
    assert.equal(options.defaultHeaders["anthropic-beta"], "fine-grained-tool-streaming-2025-05-14");
  });
});
describe("empty tool name guard in convertMessages (#4538)", () => {
  const minimaxModel = {
    id: "MiniMax-M2",
    api: "anthropic-messages",
    provider: "minimax",
    baseUrl: "https://api.minimax.io/anthropic",
    reasoning: true,
    input: ["text"],
    name: "MiniMax-M2",
    cost: { input: 0.3, output: 1.2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 196608,
    maxTokens: 128e3
  };
  test("tool_use blocks with empty name are dropped from converted messages", () => {
    const assistantMsg = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "toolu_01",
          name: "",
          // empty — the bug: fine-grained streaming left name as ""
          arguments: { path: "/foo" }
        }
      ],
      api: "anthropic-messages",
      provider: "minimax",
      model: "MiniMax-M2",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: Date.now()
    };
    const messages = [assistantMsg];
    const result = convertMessages(messages, minimaxModel, false, void 0);
    for (const param of result) {
      if (param.role === "assistant" && Array.isArray(param.content)) {
        for (const block of param.content) {
          if (block.type === "tool_use") {
            assert.ok(
              block.name && block.name.length > 0,
              `tool_use block must never have an empty name; got: "${block.name}"`
            );
          }
        }
      }
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWkvc3JjL3Byb3ZpZGVycy9taW5pbWF4LXRvb2wtbmFtZS50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFJlZ3Jlc3Npb24gdGVzdHMgZm9yIE1pbmlNYXggZXJyb3IgMjAxMyBcImZ1bmN0aW9uIG5hbWUgb3IgcGFyYW1ldGVycyBpcyBlbXB0eVwiICgjNDUzOCkuXG4gKlxuICogUm9vdCBjYXVzZTogdGhlIGBmaW5lLWdyYWluZWQtdG9vbC1zdHJlYW1pbmctMjAyNS0wNS0xNGAgYmV0YSBoZWFkZXIgaXMgc2VudCB0b1xuICogTWluaU1heC4gTWluaU1heCdzIEFudGhyb3BpYy1jb21wYXRpYmxlIEFQSSBpbXBsZW1lbnRzIHRoaXMgYmV0YSBieSBzdHJlYW1pbmcgdGhlXG4gKiB0b29sIG5hbWUgYXMgYSBkZWx0YSAoZW1wdHkgc3RyaW5nIGluIGBjb250ZW50X2Jsb2NrX3N0YXJ0YCkuIFRoZSBlbXB0eSBuYW1lIGdldHNcbiAqIHN0b3JlZCBpbiBjb252ZXJzYXRpb24gaGlzdG9yeSBhbmQgc2VudCBiYWNrIG9uIHRoZSBuZXh0IHJlcXVlc3QsIGNhdXNpbmcgTWluaU1heFxuICogdG8gcmV0dXJuIGVycm9yIDIwMTMuXG4gKlxuICogRml4OiBleGNsdWRlIE1pbmlNYXggKGFuZCBtaW5pbWF4LWNuKSBmcm9tIHRoZSBmaW5lLWdyYWluZWQtdG9vbC1zdHJlYW1pbmcgYmV0YSxcbiAqIHNhbWUgYXMgYWxpYmFiYS1jb2RpbmctcGxhbi4gQWxzbyBndWFyZCBhZ2FpbnN0IHN0b3JpbmcgZW1wdHkgdG9vbCBuYW1lcy5cbiAqL1xuaW1wb3J0IHRlc3QsIHsgZGVzY3JpYmUgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IGJ1aWxkQW50aHJvcGljQ2xpZW50T3B0aW9ucyB9IGZyb20gXCIuL2FudGhyb3BpYy5qc1wiO1xuaW1wb3J0IHsgY29udmVydE1lc3NhZ2VzIH0gZnJvbSBcIi4vYW50aHJvcGljLXNoYXJlZC5qc1wiO1xuaW1wb3J0IHR5cGUgeyBNb2RlbCB9IGZyb20gXCIuLi90eXBlcy5qc1wiO1xuaW1wb3J0IHR5cGUgeyBBc3Npc3RhbnRNZXNzYWdlIH0gZnJvbSBcIi4uL3R5cGVzLmpzXCI7XG5cbmZ1bmN0aW9uIGFudGhyb3BpY01vZGVsKG92ZXJyaWRlczogUGFydGlhbDxNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPj4gPSB7fSk6IE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+IHtcblx0cmV0dXJuIHtcblx0XHRpZDogXCJjbGF1ZGUtc29ubmV0LTRcIixcblx0XHRuYW1lOiBcIkNsYXVkZSBTb25uZXQgNFwiLFxuXHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRwcm92aWRlcjogXCJhbnRocm9waWNcIixcblx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYXBpLmFudGhyb3BpYy5jb21cIixcblx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0Y29zdDogeyBpbnB1dDogMCwgb3V0cHV0OiAwLCBjYWNoZVJlYWQ6IDAsIGNhY2hlV3JpdGU6IDAgfSxcblx0XHRjb250ZXh0V2luZG93OiAyMDAwMDAsXG5cdFx0bWF4VG9rZW5zOiA4MTkyLFxuXHRcdC4uLm92ZXJyaWRlcyxcblx0fTtcbn1cblxuZGVzY3JpYmUoXCJNaW5pTWF4IGZpbmUtZ3JhaW5lZC10b29sLXN0cmVhbWluZyBleGNsdXNpb24gKCM0NTM4KVwiLCAoKSA9PiB7XG5cdHRlc3QoXCJtaW5pbWF4IGlzIGV4Y2x1ZGVkIGZyb20gZmluZS1ncmFpbmVkLXRvb2wtc3RyZWFtaW5nLTIwMjUtMDUtMTQgYmV0YVwiLCAoKSA9PiB7XG5cdFx0Y29uc3Qgb3B0aW9ucyA9IGJ1aWxkQW50aHJvcGljQ2xpZW50T3B0aW9ucyhhbnRocm9waWNNb2RlbCh7IHByb3ZpZGVyOiBcIm1pbmltYXhcIiB9KSwgXCJhcGkta2V5XCIsIGZhbHNlKTtcblxuXHRcdGFzc2VydC5lcXVhbChcblx0XHRcdG9wdGlvbnMuZGVmYXVsdEhlYWRlcnNbXCJhbnRocm9waWMtYmV0YVwiXSxcblx0XHRcdHVuZGVmaW5lZCxcblx0XHRcdFwibWluaW1heCBtdXN0IHN1cHByZXNzIGZpbmUtZ3JhaW5lZC10b29sLXN0cmVhbWluZ1wiLFxuXHRcdCk7XG5cdH0pO1xuXG5cdHRlc3QoXCJtaW5pbWF4LWNuIGlzIGV4Y2x1ZGVkIGZyb20gZmluZS1ncmFpbmVkLXRvb2wtc3RyZWFtaW5nLTIwMjUtMDUtMTQgYmV0YVwiLCAoKSA9PiB7XG5cdFx0Y29uc3Qgb3B0aW9ucyA9IGJ1aWxkQW50aHJvcGljQ2xpZW50T3B0aW9ucyhhbnRocm9waWNNb2RlbCh7IHByb3ZpZGVyOiBcIm1pbmltYXgtY25cIiB9KSwgXCJhcGkta2V5XCIsIGZhbHNlKTtcblxuXHRcdGFzc2VydC5lcXVhbChcblx0XHRcdG9wdGlvbnMuZGVmYXVsdEhlYWRlcnNbXCJhbnRocm9waWMtYmV0YVwiXSxcblx0XHRcdHVuZGVmaW5lZCxcblx0XHRcdFwibWluaW1heC1jbiBtdXN0IHN1cHByZXNzIGZpbmUtZ3JhaW5lZC10b29sLXN0cmVhbWluZ1wiLFxuXHRcdCk7XG5cdH0pO1xuXG5cdHRlc3QoXCJzdGFuZGFyZCBBbnRocm9waWMtY29tcGF0aWJsZSBwcm92aWRlcnMga2VlcCBmaW5lLWdyYWluZWQtdG9vbC1zdHJlYW1pbmcgZW5hYmxlZFwiLCAoKSA9PiB7XG5cdFx0Y29uc3Qgb3B0aW9ucyA9IGJ1aWxkQW50aHJvcGljQ2xpZW50T3B0aW9ucyhhbnRocm9waWNNb2RlbCgpLCBcImFwaS1rZXlcIiwgZmFsc2UpO1xuXG5cdFx0YXNzZXJ0LmVxdWFsKG9wdGlvbnMuZGVmYXVsdEhlYWRlcnNbXCJhbnRocm9waWMtYmV0YVwiXSwgXCJmaW5lLWdyYWluZWQtdG9vbC1zdHJlYW1pbmctMjAyNS0wNS0xNFwiKTtcblx0fSk7XG59KTtcblxuZGVzY3JpYmUoXCJlbXB0eSB0b29sIG5hbWUgZ3VhcmQgaW4gY29udmVydE1lc3NhZ2VzICgjNDUzOClcIiwgKCkgPT4ge1xuXHQvLyBXaGVuIGZpbmUtZ3JhaW5lZC10b29sLXN0cmVhbWluZyBjYXVzZXMgYSB0b29sIG5hbWUgdG8gYXJyaXZlIGFzIGVtcHR5IGluXG5cdC8vIGNvbnRlbnRfYmxvY2tfc3RhcnQsIHdlIG11c3Qgbm90IHN0b3JlICcnIGluIGNvbnZlcnNhdGlvbiBoaXN0b3J5LlxuXHQvLyBjb252ZXJ0TWVzc2FnZXMgbXVzdCBza2lwIHRvb2xfdXNlIGJsb2NrcyB3aXRoIGVtcHR5L21pc3NpbmcgbmFtZXMuXG5cdGNvbnN0IG1pbmltYXhNb2RlbCA9IHtcblx0XHRpZDogXCJNaW5pTWF4LU0yXCIsXG5cdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiIGFzIGNvbnN0LFxuXHRcdHByb3ZpZGVyOiBcIm1pbmltYXhcIiBhcyBjb25zdCxcblx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYXBpLm1pbmltYXguaW8vYW50aHJvcGljXCIsXG5cdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdGlucHV0OiBbXCJ0ZXh0XCJdIGFzIFtcInRleHRcIl0sXG5cdFx0bmFtZTogXCJNaW5pTWF4LU0yXCIsXG5cdFx0Y29zdDogeyBpbnB1dDogMC4zLCBvdXRwdXQ6IDEuMiwgY2FjaGVSZWFkOiAwLCBjYWNoZVdyaXRlOiAwIH0sXG5cdFx0Y29udGV4dFdpbmRvdzogMTk2NjA4LFxuXHRcdG1heFRva2VuczogMTI4MDAwLFxuXHR9O1xuXG5cdHRlc3QoXCJ0b29sX3VzZSBibG9ja3Mgd2l0aCBlbXB0eSBuYW1lIGFyZSBkcm9wcGVkIGZyb20gY29udmVydGVkIG1lc3NhZ2VzXCIsICgpID0+IHtcblx0XHRjb25zdCBhc3Npc3RhbnRNc2c6IEFzc2lzdGFudE1lc3NhZ2UgPSB7XG5cdFx0XHRyb2xlOiBcImFzc2lzdGFudFwiLFxuXHRcdFx0Y29udGVudDogW1xuXHRcdFx0XHR7XG5cdFx0XHRcdFx0dHlwZTogXCJ0b29sQ2FsbFwiLFxuXHRcdFx0XHRcdGlkOiBcInRvb2x1XzAxXCIsXG5cdFx0XHRcdFx0bmFtZTogXCJcIiwgICAgICAgIC8vIGVtcHR5IFx1MjAxNCB0aGUgYnVnOiBmaW5lLWdyYWluZWQgc3RyZWFtaW5nIGxlZnQgbmFtZSBhcyBcIlwiXG5cdFx0XHRcdFx0YXJndW1lbnRzOiB7IHBhdGg6IFwiL2Zvb1wiIH0sXG5cdFx0XHRcdH0sXG5cdFx0XHRdLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwibWluaW1heFwiLFxuXHRcdFx0bW9kZWw6IFwiTWluaU1heC1NMlwiLFxuXHRcdFx0dXNhZ2U6IHsgaW5wdXQ6IDEsIG91dHB1dDogMSwgY2FjaGVSZWFkOiAwLCBjYWNoZVdyaXRlOiAwLCB0b3RhbFRva2VuczogMiwgY29zdDogeyBpbnB1dDogMCwgb3V0cHV0OiAwLCBjYWNoZVJlYWQ6IDAsIGNhY2hlV3JpdGU6IDAsIHRvdGFsOiAwIH0gfSxcblx0XHRcdHN0b3BSZWFzb246IFwidG9vbFVzZVwiLFxuXHRcdFx0dGltZXN0YW1wOiBEYXRlLm5vdygpLFxuXHRcdH07XG5cblx0XHRjb25zdCBtZXNzYWdlcyA9IFthc3Npc3RhbnRNc2ddO1xuXHRcdGNvbnN0IHJlc3VsdCA9IGNvbnZlcnRNZXNzYWdlcyhtZXNzYWdlcywgbWluaW1heE1vZGVsLCBmYWxzZSwgdW5kZWZpbmVkKTtcblxuXHRcdC8vIFRoZSBhc3Npc3RhbnQgYmxvY2sgd2l0aCB0aGUgZW1wdHktbmFtZSB0b29sQ2FsbCBtdXN0IG5vdCBhcHBlYXIgaW4gdGhlIG91dHB1dC5cblx0XHQvLyBJZiBpdCBkb2VzIGFwcGVhciwgaXRzIHRvb2xfdXNlIG5hbWUgbXVzdCBub3QgYmUgZW1wdHkuXG5cdFx0Zm9yIChjb25zdCBwYXJhbSBvZiByZXN1bHQpIHtcblx0XHRcdGlmIChwYXJhbS5yb2xlID09PSBcImFzc2lzdGFudFwiICYmIEFycmF5LmlzQXJyYXkocGFyYW0uY29udGVudCkpIHtcblx0XHRcdFx0Zm9yIChjb25zdCBibG9jayBvZiBwYXJhbS5jb250ZW50KSB7XG5cdFx0XHRcdFx0aWYgKChibG9jayBhcyBhbnkpLnR5cGUgPT09IFwidG9vbF91c2VcIikge1xuXHRcdFx0XHRcdFx0YXNzZXJ0Lm9rKFxuXHRcdFx0XHRcdFx0XHQoYmxvY2sgYXMgYW55KS5uYW1lICYmIChibG9jayBhcyBhbnkpLm5hbWUubGVuZ3RoID4gMCxcblx0XHRcdFx0XHRcdFx0YHRvb2xfdXNlIGJsb2NrIG11c3QgbmV2ZXIgaGF2ZSBhbiBlbXB0eSBuYW1lOyBnb3Q6IFwiJHsoYmxvY2sgYXMgYW55KS5uYW1lfVwiYCxcblx0XHRcdFx0XHRcdCk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fVxuXHR9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBWUEsT0FBTyxRQUFRLGdCQUFnQjtBQUMvQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxtQ0FBbUM7QUFDNUMsU0FBUyx1QkFBdUI7QUFJaEMsU0FBUyxlQUFlLFlBQWtELENBQUMsR0FBZ0M7QUFDMUcsU0FBTztBQUFBLElBQ04sSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsV0FBVztBQUFBLElBQ1gsT0FBTyxDQUFDLE1BQU07QUFBQSxJQUNkLE1BQU0sRUFBRSxPQUFPLEdBQUcsUUFBUSxHQUFHLFdBQVcsR0FBRyxZQUFZLEVBQUU7QUFBQSxJQUN6RCxlQUFlO0FBQUEsSUFDZixXQUFXO0FBQUEsSUFDWCxHQUFHO0FBQUEsRUFDSjtBQUNEO0FBRUEsU0FBUyx5REFBeUQsTUFBTTtBQUN2RSxPQUFLLHdFQUF3RSxNQUFNO0FBQ2xGLFVBQU0sVUFBVSw0QkFBNEIsZUFBZSxFQUFFLFVBQVUsVUFBVSxDQUFDLEdBQUcsV0FBVyxLQUFLO0FBRXJHLFdBQU87QUFBQSxNQUNOLFFBQVEsZUFBZSxnQkFBZ0I7QUFBQSxNQUN2QztBQUFBLE1BQ0E7QUFBQSxJQUNEO0FBQUEsRUFDRCxDQUFDO0FBRUQsT0FBSywyRUFBMkUsTUFBTTtBQUNyRixVQUFNLFVBQVUsNEJBQTRCLGVBQWUsRUFBRSxVQUFVLGFBQWEsQ0FBQyxHQUFHLFdBQVcsS0FBSztBQUV4RyxXQUFPO0FBQUEsTUFDTixRQUFRLGVBQWUsZ0JBQWdCO0FBQUEsTUFDdkM7QUFBQSxNQUNBO0FBQUEsSUFDRDtBQUFBLEVBQ0QsQ0FBQztBQUVELE9BQUssb0ZBQW9GLE1BQU07QUFDOUYsVUFBTSxVQUFVLDRCQUE0QixlQUFlLEdBQUcsV0FBVyxLQUFLO0FBRTlFLFdBQU8sTUFBTSxRQUFRLGVBQWUsZ0JBQWdCLEdBQUcsd0NBQXdDO0FBQUEsRUFDaEcsQ0FBQztBQUNGLENBQUM7QUFFRCxTQUFTLG9EQUFvRCxNQUFNO0FBSWxFLFFBQU0sZUFBZTtBQUFBLElBQ3BCLElBQUk7QUFBQSxJQUNKLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsSUFDTixNQUFNLEVBQUUsT0FBTyxLQUFLLFFBQVEsS0FBSyxXQUFXLEdBQUcsWUFBWSxFQUFFO0FBQUEsSUFDN0QsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFFQSxPQUFLLHVFQUF1RSxNQUFNO0FBQ2pGLFVBQU0sZUFBaUM7QUFBQSxNQUN0QyxNQUFNO0FBQUEsTUFDTixTQUFTO0FBQUEsUUFDUjtBQUFBLFVBQ0MsTUFBTTtBQUFBLFVBQ04sSUFBSTtBQUFBLFVBQ0osTUFBTTtBQUFBO0FBQUEsVUFDTixXQUFXLEVBQUUsTUFBTSxPQUFPO0FBQUEsUUFDM0I7QUFBQSxNQUNEO0FBQUEsTUFDQSxLQUFLO0FBQUEsTUFDTCxVQUFVO0FBQUEsTUFDVixPQUFPO0FBQUEsTUFDUCxPQUFPLEVBQUUsT0FBTyxHQUFHLFFBQVEsR0FBRyxXQUFXLEdBQUcsWUFBWSxHQUFHLGFBQWEsR0FBRyxNQUFNLEVBQUUsT0FBTyxHQUFHLFFBQVEsR0FBRyxXQUFXLEdBQUcsWUFBWSxHQUFHLE9BQU8sRUFBRSxFQUFFO0FBQUEsTUFDaEosWUFBWTtBQUFBLE1BQ1osV0FBVyxLQUFLLElBQUk7QUFBQSxJQUNyQjtBQUVBLFVBQU0sV0FBVyxDQUFDLFlBQVk7QUFDOUIsVUFBTSxTQUFTLGdCQUFnQixVQUFVLGNBQWMsT0FBTyxNQUFTO0FBSXZFLGVBQVcsU0FBUyxRQUFRO0FBQzNCLFVBQUksTUFBTSxTQUFTLGVBQWUsTUFBTSxRQUFRLE1BQU0sT0FBTyxHQUFHO0FBQy9ELG1CQUFXLFNBQVMsTUFBTSxTQUFTO0FBQ2xDLGNBQUssTUFBYyxTQUFTLFlBQVk7QUFDdkMsbUJBQU87QUFBQSxjQUNMLE1BQWMsUUFBUyxNQUFjLEtBQUssU0FBUztBQUFBLGNBQ3BELHVEQUF3RCxNQUFjLElBQUk7QUFBQSxZQUMzRTtBQUFBLFVBQ0Q7QUFBQSxRQUNEO0FBQUEsTUFDRDtBQUFBLElBQ0Q7QUFBQSxFQUNELENBQUM7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
