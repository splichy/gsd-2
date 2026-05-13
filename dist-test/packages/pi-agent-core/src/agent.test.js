import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "./agent.js";
import { getModel } from "@gsd/pi-ai";
function makeDoneStream(modelId) {
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  };
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: modelId,
    usage,
    stopReason: "stop",
    timestamp: Date.now()
  };
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial: message };
      yield { type: "done", message };
    },
    result: async () => message,
    [Symbol.asyncDispose]: async () => {
    }
  };
}
describe("Agent \u2014 activeInferenceModel (#1844 Bug 2)", () => {
  it("_runLoop sets activeInferenceModel = model mid-stream and clears it when finished", async () => {
    const model = getModel("anthropic", "claude-3-5-sonnet-20241022");
    let midStreamModel = "<not-captured>";
    const agent = new Agent({
      initialState: { model, systemPrompt: "test", tools: [] },
      streamFn: (streamModel) => {
        midStreamModel = agent.state.activeInferenceModel;
        return makeDoneStream(streamModel.id);
      }
    });
    assert.equal(
      agent.state.activeInferenceModel,
      void 0,
      "activeInferenceModel must be undefined before prompt()"
    );
    await agent.prompt("hello");
    assert.equal(
      midStreamModel?.id,
      model.id,
      "activeInferenceModel must equal the inference model while streaming"
    );
    assert.equal(
      agent.state.activeInferenceModel,
      void 0,
      "activeInferenceModel must be undefined after prompt() resolves"
    );
  });
  it("activeInferenceModel is also cleared when the stream throws", async () => {
    const model = getModel("anthropic", "claude-3-5-sonnet-20241022");
    let midStreamModel = "<not-captured>";
    const agent = new Agent({
      initialState: { model, systemPrompt: "test", tools: [] },
      streamFn: () => {
        midStreamModel = agent.state.activeInferenceModel;
        return {
          async *[Symbol.asyncIterator]() {
            throw new Error("boom");
          },
          result: async () => {
            throw new Error("boom");
          },
          [Symbol.asyncDispose]: async () => {
          }
        };
      }
    });
    await agent.prompt("hello");
    assert.equal(
      midStreamModel?.id,
      model.id,
      "activeInferenceModel must be set even when the stream later throws"
    );
    assert.equal(
      agent.state.activeInferenceModel,
      void 0,
      "activeInferenceModel must be cleared in finally even after stream errors"
    );
  });
  it("getProviderOptions are forwarded into the provider stream call", async () => {
    let capturedOptions;
    const model = getModel("anthropic", "claude-3-5-sonnet-20241022");
    const agent = new Agent({
      initialState: { model, systemPrompt: "test", tools: [] },
      getProviderOptions: async () => ({ customRuntimeOption: "present" }),
      streamFn: (_model, _context, options) => {
        capturedOptions = options;
        return makeDoneStream(model.id);
      }
    });
    await agent.prompt("hello");
    assert.equal(capturedOptions?.customRuntimeOption, "present");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWdlbnQtY29yZS9zcmMvYWdlbnQudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gQWdlbnQgYWN0aXZlSW5mZXJlbmNlTW9kZWwgcmVncmVzc2lvbiB0ZXN0c1xuLy8gVmVyaWZpZXMgdGhhdCBhY3RpdmVJbmZlcmVuY2VNb2RlbCBpcyBzZXQgYmVmb3JlIHN0cmVhbWluZyBiZWdpbnMgYW5kXG4vLyBjbGVhcmVkIGFmdGVyIHN0cmVhbWluZyBjb21wbGV0ZXMgXHUyMDE0IG9ic2VydmVkIHZpYSB0aGUgc3RyZWFtRm4gc2VhbSBhbmRcbi8vIHBvc3QtY29uZGl0aW9uLCBub3QgdGhlIHNvdXJjZSB0ZXh0LlxuLy8gUmVncmVzc2lvbiB0ZXN0IGZvciBodHRwczovL2dpdGh1Yi5jb20vZ3NkLWJ1aWxkL2dzZC0yL2lzc3Vlcy8xODQ0IEJ1ZyAyXG5cbmltcG9ydCB7IGRlc2NyaWJlLCBpdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgQWdlbnQgfSBmcm9tIFwiLi9hZ2VudC50c1wiO1xuaW1wb3J0IHsgZ2V0TW9kZWwsIHR5cGUgQXNzaXN0YW50TWVzc2FnZUV2ZW50U3RyZWFtIH0gZnJvbSBcIkBnc2QvcGktYWlcIjtcblxuZnVuY3Rpb24gbWFrZURvbmVTdHJlYW0obW9kZWxJZDogc3RyaW5nKTogQXNzaXN0YW50TWVzc2FnZUV2ZW50U3RyZWFtIHtcblx0Y29uc3QgdXNhZ2UgPSB7XG5cdFx0aW5wdXQ6IDAsXG5cdFx0b3V0cHV0OiAwLFxuXHRcdGNhY2hlUmVhZDogMCxcblx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdHRvdGFsVG9rZW5zOiAwLFxuXHRcdGNvc3Q6IHsgaW5wdXQ6IDAsIG91dHB1dDogMCwgY2FjaGVSZWFkOiAwLCBjYWNoZVdyaXRlOiAwLCB0b3RhbDogMCB9LFxuXHR9O1xuXHRjb25zdCBtZXNzYWdlID0ge1xuXHRcdHJvbGU6IFwiYXNzaXN0YW50XCIgYXMgY29uc3QsXG5cdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IFwib2tcIiB9XSxcblx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIgYXMgY29uc3QsXG5cdFx0cHJvdmlkZXI6IFwiYW50aHJvcGljXCIsXG5cdFx0bW9kZWw6IG1vZGVsSWQsXG5cdFx0dXNhZ2UsXG5cdFx0c3RvcFJlYXNvbjogXCJzdG9wXCIgYXMgY29uc3QsXG5cdFx0dGltZXN0YW1wOiBEYXRlLm5vdygpLFxuXHR9O1xuXHRyZXR1cm4ge1xuXHRcdGFzeW5jICpbU3ltYm9sLmFzeW5jSXRlcmF0b3JdKCkge1xuXHRcdFx0eWllbGQgeyB0eXBlOiBcInN0YXJ0XCIsIHBhcnRpYWw6IG1lc3NhZ2UgfTtcblx0XHRcdHlpZWxkIHsgdHlwZTogXCJkb25lXCIsIG1lc3NhZ2UgfTtcblx0XHR9LFxuXHRcdHJlc3VsdDogYXN5bmMgKCkgPT4gbWVzc2FnZSxcblx0XHRbU3ltYm9sLmFzeW5jRGlzcG9zZV06IGFzeW5jICgpID0+IHt9LFxuXHR9IGFzIEFzc2lzdGFudE1lc3NhZ2VFdmVudFN0cmVhbTtcbn1cblxuZGVzY3JpYmUoXCJBZ2VudCBcdTIwMTQgYWN0aXZlSW5mZXJlbmNlTW9kZWwgKCMxODQ0IEJ1ZyAyKVwiLCAoKSA9PiB7XG5cdGl0KFwiX3J1bkxvb3Agc2V0cyBhY3RpdmVJbmZlcmVuY2VNb2RlbCA9IG1vZGVsIG1pZC1zdHJlYW0gYW5kIGNsZWFycyBpdCB3aGVuIGZpbmlzaGVkXCIsIGFzeW5jICgpID0+IHtcblx0XHRjb25zdCBtb2RlbCA9IGdldE1vZGVsKFwiYW50aHJvcGljXCIsIFwiY2xhdWRlLTMtNS1zb25uZXQtMjAyNDEwMjJcIik7XG5cdFx0bGV0IG1pZFN0cmVhbU1vZGVsOiB1bmtub3duID0gXCI8bm90LWNhcHR1cmVkPlwiO1xuXG5cdFx0Y29uc3QgYWdlbnQgPSBuZXcgQWdlbnQoe1xuXHRcdFx0aW5pdGlhbFN0YXRlOiB7IG1vZGVsLCBzeXN0ZW1Qcm9tcHQ6IFwidGVzdFwiLCB0b29sczogW10gfSxcblx0XHRcdHN0cmVhbUZuOiAoc3RyZWFtTW9kZWwpOiBBc3Npc3RhbnRNZXNzYWdlRXZlbnRTdHJlYW0gPT4ge1xuXHRcdFx0XHQvLyBzdHJlYW1GbiBpcyBpbnZva2VkIEFGVEVSIGBhY3RpdmVJbmZlcmVuY2VNb2RlbCA9IG1vZGVsYCBhbmRcblx0XHRcdFx0Ly8gQkVGT1JFIHRoZSBmaW5hbGx5IGJsb2NrIHRoYXQgY2xlYXJzIGl0LiBDYXB0dXJlIHN0YXRlIGhlcmUuXG5cdFx0XHRcdG1pZFN0cmVhbU1vZGVsID0gYWdlbnQuc3RhdGUuYWN0aXZlSW5mZXJlbmNlTW9kZWw7XG5cdFx0XHRcdHJldHVybiBtYWtlRG9uZVN0cmVhbShzdHJlYW1Nb2RlbC5pZCk7XG5cdFx0XHR9LFxuXHRcdH0pO1xuXG5cdFx0Ly8gQmFzZWxpbmU6IHVuZGVmaW5lZCBiZWZvcmUgYW55IGluZmVyZW5jZS5cblx0XHRhc3NlcnQuZXF1YWwoXG5cdFx0XHRhZ2VudC5zdGF0ZS5hY3RpdmVJbmZlcmVuY2VNb2RlbCxcblx0XHRcdHVuZGVmaW5lZCxcblx0XHRcdFwiYWN0aXZlSW5mZXJlbmNlTW9kZWwgbXVzdCBiZSB1bmRlZmluZWQgYmVmb3JlIHByb21wdCgpXCIsXG5cdFx0KTtcblxuXHRcdGF3YWl0IGFnZW50LnByb21wdChcImhlbGxvXCIpO1xuXG5cdFx0Ly8gTWlkLXN0cmVhbTogc2V0IHRvIHRoZSBpbmZlcmVuY2UgbW9kZWwuXG5cdFx0YXNzZXJ0LmVxdWFsKFxuXHRcdFx0KG1pZFN0cmVhbU1vZGVsIGFzIHsgaWQ/OiBzdHJpbmcgfSB8IHVuZGVmaW5lZCk/LmlkLFxuXHRcdFx0bW9kZWwuaWQsXG5cdFx0XHRcImFjdGl2ZUluZmVyZW5jZU1vZGVsIG11c3QgZXF1YWwgdGhlIGluZmVyZW5jZSBtb2RlbCB3aGlsZSBzdHJlYW1pbmdcIixcblx0XHQpO1xuXG5cdFx0Ly8gUG9zdC1zdHJlYW06IGNsZWFyZWQgYmFjayB0byB1bmRlZmluZWQgKGZpbmFsbHkgYmxvY2spLlxuXHRcdGFzc2VydC5lcXVhbChcblx0XHRcdGFnZW50LnN0YXRlLmFjdGl2ZUluZmVyZW5jZU1vZGVsLFxuXHRcdFx0dW5kZWZpbmVkLFxuXHRcdFx0XCJhY3RpdmVJbmZlcmVuY2VNb2RlbCBtdXN0IGJlIHVuZGVmaW5lZCBhZnRlciBwcm9tcHQoKSByZXNvbHZlc1wiLFxuXHRcdCk7XG5cdH0pO1xuXG5cdGl0KFwiYWN0aXZlSW5mZXJlbmNlTW9kZWwgaXMgYWxzbyBjbGVhcmVkIHdoZW4gdGhlIHN0cmVhbSB0aHJvd3NcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IG1vZGVsID0gZ2V0TW9kZWwoXCJhbnRocm9waWNcIiwgXCJjbGF1ZGUtMy01LXNvbm5ldC0yMDI0MTAyMlwiKTtcblx0XHRsZXQgbWlkU3RyZWFtTW9kZWw6IHVua25vd24gPSBcIjxub3QtY2FwdHVyZWQ+XCI7XG5cblx0XHRjb25zdCBhZ2VudCA9IG5ldyBBZ2VudCh7XG5cdFx0XHRpbml0aWFsU3RhdGU6IHsgbW9kZWwsIHN5c3RlbVByb21wdDogXCJ0ZXN0XCIsIHRvb2xzOiBbXSB9LFxuXHRcdFx0c3RyZWFtRm46ICgpOiBBc3Npc3RhbnRNZXNzYWdlRXZlbnRTdHJlYW0gPT4ge1xuXHRcdFx0XHRtaWRTdHJlYW1Nb2RlbCA9IGFnZW50LnN0YXRlLmFjdGl2ZUluZmVyZW5jZU1vZGVsO1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGFzeW5jICpbU3ltYm9sLmFzeW5jSXRlcmF0b3JdKCkge1xuXHRcdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKFwiYm9vbVwiKTtcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdHJlc3VsdDogYXN5bmMgKCkgPT4ge1xuXHRcdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKFwiYm9vbVwiKTtcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdFtTeW1ib2wuYXN5bmNEaXNwb3NlXTogYXN5bmMgKCkgPT4ge30sXG5cdFx0XHRcdH0gYXMgQXNzaXN0YW50TWVzc2FnZUV2ZW50U3RyZWFtO1xuXHRcdFx0fSxcblx0XHR9KTtcblxuXHRcdGF3YWl0IGFnZW50LnByb21wdChcImhlbGxvXCIpO1xuXG5cdFx0YXNzZXJ0LmVxdWFsKFxuXHRcdFx0KG1pZFN0cmVhbU1vZGVsIGFzIHsgaWQ/OiBzdHJpbmcgfSB8IHVuZGVmaW5lZCk/LmlkLFxuXHRcdFx0bW9kZWwuaWQsXG5cdFx0XHRcImFjdGl2ZUluZmVyZW5jZU1vZGVsIG11c3QgYmUgc2V0IGV2ZW4gd2hlbiB0aGUgc3RyZWFtIGxhdGVyIHRocm93c1wiLFxuXHRcdCk7XG5cdFx0YXNzZXJ0LmVxdWFsKFxuXHRcdFx0YWdlbnQuc3RhdGUuYWN0aXZlSW5mZXJlbmNlTW9kZWwsXG5cdFx0XHR1bmRlZmluZWQsXG5cdFx0XHRcImFjdGl2ZUluZmVyZW5jZU1vZGVsIG11c3QgYmUgY2xlYXJlZCBpbiBmaW5hbGx5IGV2ZW4gYWZ0ZXIgc3RyZWFtIGVycm9yc1wiLFxuXHRcdCk7XG5cdH0pO1xuXG5cdGl0KFwiZ2V0UHJvdmlkZXJPcHRpb25zIGFyZSBmb3J3YXJkZWQgaW50byB0aGUgcHJvdmlkZXIgc3RyZWFtIGNhbGxcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGxldCBjYXB0dXJlZE9wdGlvbnM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkO1xuXHRcdGNvbnN0IG1vZGVsID0gZ2V0TW9kZWwoXCJhbnRocm9waWNcIiwgXCJjbGF1ZGUtMy01LXNvbm5ldC0yMDI0MTAyMlwiKTtcblx0XHRjb25zdCBhZ2VudCA9IG5ldyBBZ2VudCh7XG5cdFx0XHRpbml0aWFsU3RhdGU6IHsgbW9kZWwsIHN5c3RlbVByb21wdDogXCJ0ZXN0XCIsIHRvb2xzOiBbXSB9LFxuXHRcdFx0Z2V0UHJvdmlkZXJPcHRpb25zOiBhc3luYyAoKSA9PiAoeyBjdXN0b21SdW50aW1lT3B0aW9uOiBcInByZXNlbnRcIiB9KSxcblx0XHRcdHN0cmVhbUZuOiAoX21vZGVsLCBfY29udGV4dCwgb3B0aW9ucyk6IEFzc2lzdGFudE1lc3NhZ2VFdmVudFN0cmVhbSA9PiB7XG5cdFx0XHRcdGNhcHR1cmVkT3B0aW9ucyA9IG9wdGlvbnMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQ7XG5cdFx0XHRcdHJldHVybiBtYWtlRG9uZVN0cmVhbShtb2RlbC5pZCk7XG5cdFx0XHR9LFxuXHRcdH0pO1xuXG5cdFx0YXdhaXQgYWdlbnQucHJvbXB0KFwiaGVsbG9cIik7XG5cdFx0YXNzZXJ0LmVxdWFsKGNhcHR1cmVkT3B0aW9ucz8uY3VzdG9tUnVudGltZU9wdGlvbiwgXCJwcmVzZW50XCIpO1xuXHR9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBTUEsU0FBUyxVQUFVLFVBQVU7QUFDN0IsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYTtBQUN0QixTQUFTLGdCQUFrRDtBQUUzRCxTQUFTLGVBQWUsU0FBOEM7QUFDckUsUUFBTSxRQUFRO0FBQUEsSUFDYixPQUFPO0FBQUEsSUFDUCxRQUFRO0FBQUEsSUFDUixXQUFXO0FBQUEsSUFDWCxZQUFZO0FBQUEsSUFDWixhQUFhO0FBQUEsSUFDYixNQUFNLEVBQUUsT0FBTyxHQUFHLFFBQVEsR0FBRyxXQUFXLEdBQUcsWUFBWSxHQUFHLE9BQU8sRUFBRTtBQUFBLEVBQ3BFO0FBQ0EsUUFBTSxVQUFVO0FBQUEsSUFDZixNQUFNO0FBQUEsSUFDTixTQUFTLENBQUMsRUFBRSxNQUFNLFFBQWlCLE1BQU0sS0FBSyxDQUFDO0FBQUEsSUFDL0MsS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsT0FBTztBQUFBLElBQ1A7QUFBQSxJQUNBLFlBQVk7QUFBQSxJQUNaLFdBQVcsS0FBSyxJQUFJO0FBQUEsRUFDckI7QUFDQSxTQUFPO0FBQUEsSUFDTixRQUFRLE9BQU8sYUFBYSxJQUFJO0FBQy9CLFlBQU0sRUFBRSxNQUFNLFNBQVMsU0FBUyxRQUFRO0FBQ3hDLFlBQU0sRUFBRSxNQUFNLFFBQVEsUUFBUTtBQUFBLElB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
