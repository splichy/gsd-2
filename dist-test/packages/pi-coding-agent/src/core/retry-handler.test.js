import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { RetryHandler } from "./retry-handler.js";
function createMockModel(provider, id) {
  return {
    id,
    name: id,
    api: "anthropic",
    provider,
    baseUrl: "https://api.anthropic.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1e6,
    maxTokens: 16384
  };
}
function errorMessage(msg) {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-opus-4-6[1m]",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error",
    errorMessage: msg,
    timestamp: Date.now()
  };
}
function createMockDeps(overrides) {
  const model = overrides?.model ?? createMockModel("anthropic", "claude-opus-4-6[1m]");
  const emittedEvents = [];
  const continueFn = mock.fn(async () => {
  });
  const onModelChangeFn = mock.fn((_model) => {
  });
  const markUsageLimitReached = mock.fn(
    () => overrides?.markUsageLimitReachedResult ?? false
  );
  const findFallback = mock.fn(async () => overrides?.fallbackResult ?? null);
  const findModel = mock.fn(
    overrides?.findModelResult ?? ((_provider, _modelId) => void 0)
  );
  const messages = [];
  const deps = {
    agent: {
      continue: continueFn,
      state: { messages },
      setModel: mock.fn(),
      replaceMessages: mock.fn((newMessages) => {
        messages.length = 0;
        messages.push(...newMessages);
      })
    },
    settingsManager: {
      getRetryEnabled: () => overrides?.retryEnabled ?? true,
      getRetrySettings: () => ({
        enabled: overrides?.retryEnabled ?? true,
        maxRetries: overrides?.retrySettings?.maxRetries ?? 5,
        baseDelayMs: overrides?.retrySettings?.baseDelayMs ?? 1e3,
        maxDelayMs: overrides?.retrySettings?.maxDelayMs ?? 3e4
      })
    },
    modelRegistry: {
      authStorage: {
        markUsageLimitReached
      },
      find: findModel
    },
    fallbackResolver: {
      findFallback
    },
    getModel: () => model,
    getSessionId: () => "test-session",
    emit: (event) => emittedEvents.push(event),
    onModelChange: onModelChangeFn
  };
  return { deps, emittedEvents, continueFn, onModelChangeFn, markUsageLimitReached, findFallback, findModel };
}
describe("RetryHandler \u2014 long-context entitlement 429 (#2803)", () => {
  describe("error classification", () => {
    it("classifies 'Extra usage is required for long context requests' as quota_exhausted, not rate_limit", async () => {
      const { deps, emittedEvents, findModel } = createMockDeps({
        model: createMockModel("anthropic", "claude-opus-4-6[1m]"),
        markUsageLimitReachedResult: false,
        // no alternate credentials
        fallbackResult: null,
        // no cross-provider fallback
        findModelResult: () => void 0
        // no base model either
      });
      const handler = new RetryHandler(deps);
      const msg = errorMessage(
        '429 {"type":"error","error":{"type":"rate_limit_error","message":"Extra usage is required for long context requests."}}'
      );
      const result = await handler.handleRetryableError(msg);
      assert.equal(result, false);
      const chainExhausted = emittedEvents.find((e) => e.type === "fallback_chain_exhausted");
      assert.ok(chainExhausted, "Expected fallback_chain_exhausted event for entitlement error");
      const retryStart = emittedEvents.find((e) => e.type === "auto_retry_start");
      assert.equal(retryStart, void 0, "Should NOT emit auto_retry_start for entitlement error");
    });
    it("still classifies regular 429 rate limits as rate_limit", async () => {
      const { deps, emittedEvents } = createMockDeps({
        model: createMockModel("anthropic", "claude-opus-4-6"),
        markUsageLimitReachedResult: false,
        fallbackResult: null
      });
      const handler = new RetryHandler(deps);
      const msg = errorMessage("429 Too Many Requests");
      const result = await handler.handleRetryableError(msg);
      assert.equal(result, true);
      const retryStart = emittedEvents.find((e) => e.type === "auto_retry_start");
      assert.ok(retryStart, "Regular 429 should enter backoff retry");
    });
    it("classifies OpenRouter credit affordability errors as quota_exhausted", async () => {
      const { deps, emittedEvents } = createMockDeps({
        model: createMockModel("openrouter", "openai/gpt-5-pro"),
        markUsageLimitReachedResult: false,
        fallbackResult: null
      });
      const handler = new RetryHandler(deps);
      const msg = errorMessage(
        "402 This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 329."
      );
      const result = await handler.handleRetryableError(msg);
      assert.equal(result, true, "affordability error should trigger credit-aware retry");
      const retryStart = emittedEvents.find((e) => e.type === "auto_retry_start");
      assert.ok(retryStart, "Expected immediate retry after reducing max tokens");
    });
  });
  describe("long-context model downgrade", () => {
    it("downgrades from [1m] to base model when entitlement error and no fallback", async () => {
      const baseModel = createMockModel("anthropic", "claude-opus-4-6");
      const { deps, emittedEvents, onModelChangeFn, continueFn } = createMockDeps({
        model: createMockModel("anthropic", "claude-opus-4-6[1m]"),
        markUsageLimitReachedResult: false,
        fallbackResult: null,
        findModelResult: (provider, modelId) => {
          if (provider === "anthropic" && modelId === "claude-opus-4-6") return baseModel;
          return void 0;
        }
      });
      const handler = new RetryHandler(deps);
      const msg = errorMessage("Extra usage is required for long context requests.");
      const result = await handler.handleRetryableError(msg);
      assert.equal(result, true, "Should retry after downgrade");
      const setModelCalls = deps.agent.setModel.mock.calls;
      assert.equal(setModelCalls.length, 1);
      assert.equal(setModelCalls[0].arguments[0].id, "claude-opus-4-6");
      assert.equal(onModelChangeFn.mock.calls.length, 1);
      const switchEvent = emittedEvents.find((e) => e.type === "fallback_provider_switch");
      assert.ok(switchEvent, "Expected fallback_provider_switch event for downgrade");
      assert.ok(switchEvent.reason.includes("long context downgrade"), `reason should mention downgrade: ${switchEvent.reason}`);
    });
    it("emits fallback_chain_exhausted when base model is also unavailable", async () => {
      const { deps, emittedEvents } = createMockDeps({
        model: createMockModel("anthropic", "claude-opus-4-6[1m]"),
        markUsageLimitReachedResult: false,
        fallbackResult: null,
        findModelResult: () => void 0
        // base model not found
      });
      const handler = new RetryHandler(deps);
      const msg = errorMessage("Extra usage is required for long context requests.");
      const result = await handler.handleRetryableError(msg);
      assert.equal(result, false);
      const chainExhausted = emittedEvents.find((e) => e.type === "fallback_chain_exhausted");
      assert.ok(chainExhausted, "Expected fallback_chain_exhausted when base model unavailable");
    });
    it("does not attempt downgrade for non-[1m] models", async () => {
      const { deps, emittedEvents } = createMockDeps({
        model: createMockModel("anthropic", "claude-opus-4-6"),
        markUsageLimitReachedResult: false,
        fallbackResult: null
      });
      const handler = new RetryHandler(deps);
      const msg = errorMessage("Extra usage is required for long context requests.");
      const result = await handler.handleRetryableError(msg);
      assert.equal(result, false);
      const chainExhausted = emittedEvents.find((e) => e.type === "fallback_chain_exhausted");
      assert.ok(chainExhausted);
      const switchEvent = emittedEvents.find((e) => e.type === "fallback_provider_switch");
      assert.equal(switchEvent, void 0, "Should not switch for non-[1m] models");
    });
  });
  describe("retry cancellation", () => {
    it("cancels queued immediate continue callbacks when retry is aborted", async () => {
      const { deps, emittedEvents, continueFn } = createMockDeps({
        markUsageLimitReachedResult: true
      });
      const handler = new RetryHandler(deps);
      const msg = errorMessage("429 Too Many Requests");
      const result = await handler.handleRetryableError(msg);
      assert.equal(result, true, "retry should be initiated");
      handler.abortRetry();
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(continueFn.mock.calls.length, 0, "cancelled retry must not continue after explicit abort");
      const endEvents = emittedEvents.filter((e) => e.type === "auto_retry_end");
      assert.equal(endEvents.length, 1, "retry cancellation should emit a single auto_retry_end event");
      assert.equal(endEvents[0]?.finalError, "Retry cancelled");
    });
  });
  describe("credit-aware maxTokens retry", () => {
    it("reduces maxTokens on same model when provider reports affordable cap", async () => {
      const expensiveModel = createMockModel("openrouter", "openai/gpt-5-pro");
      expensiveModel.maxTokens = 128e3;
      const { deps, emittedEvents, onModelChangeFn } = createMockDeps({
        model: expensiveModel,
        markUsageLimitReachedResult: false,
        fallbackResult: null
      });
      const handler = new RetryHandler(deps);
      const msg = errorMessage(
        "402 This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 329."
      );
      const result = await handler.handleRetryableError(msg);
      assert.equal(result, true, "should retry after reducing maxTokens");
      const setModelCalls = deps.agent.setModel.mock.calls;
      assert.equal(setModelCalls.length, 1, "should apply one model downgrade");
      const downgraded = setModelCalls[0].arguments[0];
      assert.equal(downgraded.provider, "openrouter");
      assert.equal(downgraded.id, "openai/gpt-5-pro");
      assert.equal(downgraded.maxTokens, 297, "expected affordability cap with safety buffer");
      assert.equal(onModelChangeFn.mock.calls.length, 1, "should notify about model update");
      const switchEvent = emittedEvents.find((e) => e.type === "fallback_provider_switch");
      assert.ok(switchEvent, "should emit model-adjustment event");
      assert.ok(
        String(switchEvent?.reason || "").includes("credit-aware retry"),
        "switch reason should mention credit-aware retry"
      );
    });
    it("does not mark credentials in cooldown for affordability quota errors", async () => {
      const expensiveModel = createMockModel("openrouter", "openai/gpt-5-pro");
      expensiveModel.maxTokens = 128e3;
      const { deps, markUsageLimitReached } = createMockDeps({
        model: expensiveModel,
        markUsageLimitReachedResult: false,
        fallbackResult: null
      });
      const handler = new RetryHandler(deps);
      const msg = errorMessage(
        "402 This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 329."
      );
      await handler.handleRetryableError(msg);
      assert.equal(markUsageLimitReached.mock.calls.length, 0, "quota error should skip credential cooldown");
    });
  });
  describe("isRetryableError", () => {
    it("considers long-context entitlement error as retryable", () => {
      const { deps } = createMockDeps();
      const handler = new RetryHandler(deps);
      const msg = errorMessage("Extra usage is required for long context requests.");
      assert.equal(handler.isRetryableError(msg), true);
    });
    it("does NOT consider credential cooldown error as retryable (#3429)", () => {
      const { deps } = createMockDeps();
      const handler = new RetryHandler(deps);
      const msg = errorMessage(
        'All credentials for "anthropic" are in a cooldown window. Please wait a moment and try again, or switch to a different provider.'
      );
      assert.equal(handler.isRetryableError(msg), false);
    });
    it("considers OpenRouter affordability credit errors as retryable", () => {
      const { deps } = createMockDeps();
      const handler = new RetryHandler(deps);
      const msg = errorMessage(
        "402 This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 329."
      );
      assert.equal(handler.isRetryableError(msg), true);
    });
  });
  describe("third-party block claude-code fallback (#3772)", () => {
    it("switches to claude-code provider when current provider is anthropic", async () => {
      const ccModel = createMockModel("claude-code", "claude-opus-4-6");
      const { deps, emittedEvents, onModelChangeFn } = createMockDeps({
        model: createMockModel("anthropic", "claude-opus-4-6"),
        findModelResult: (provider, modelId) => {
          if (provider === "claude-code" && modelId === "claude-opus-4-6") return ccModel;
          return void 0;
        }
      });
      deps.isClaudeCodeReady = () => true;
      const handler = new RetryHandler(deps);
      const msg = errorMessage("third-party apps cannot draw from extra usage");
      const result = await handler.handleRetryableError(msg);
      assert.equal(result, true, "should retry via claude-code fallback");
      const switchEvent = emittedEvents.find((e) => e.type === "fallback_provider_switch");
      assert.ok(switchEvent, "Expected fallback_provider_switch event");
      assert.ok(switchEvent.to.startsWith("claude-code/"), "Should switch to claude-code provider");
    });
    it("switches to claude-code on 'out of extra usage' error (#3772)", async () => {
      const ccModel = createMockModel("claude-code", "claude-opus-4-6");
      const { deps, emittedEvents } = createMockDeps({
        model: createMockModel("anthropic", "claude-opus-4-6"),
        findModelResult: (provider, modelId) => {
          if (provider === "claude-code" && modelId === "claude-opus-4-6") return ccModel;
          return void 0;
        }
      });
      deps.isClaudeCodeReady = () => true;
      const handler = new RetryHandler(deps);
      const msg = errorMessage("You're out of extra usage. Add more at claude.ai/settings/usage and keep going.");
      const result = await handler.handleRetryableError(msg);
      assert.equal(result, true, "should retry via claude-code fallback");
      const switchEvent = emittedEvents.find((e) => e.type === "fallback_provider_switch");
      assert.ok(switchEvent, "Expected fallback_provider_switch event");
      assert.ok(switchEvent.to.startsWith("claude-code/"), "Should switch to claude-code provider");
    });
    it("does NOT switch to claude-code when current provider is not anthropic", async () => {
      const ccModel = createMockModel("claude-code", "gpt-4o");
      const { deps, emittedEvents } = createMockDeps({
        model: createMockModel("openai", "gpt-4o"),
        findModelResult: (provider, modelId) => {
          if (provider === "claude-code" && modelId === "gpt-4o") return ccModel;
          return void 0;
        }
      });
      deps.isClaudeCodeReady = () => true;
      const handler = new RetryHandler(deps);
      const msg = errorMessage("third-party apps are not supported for this plan");
      const result = await handler.handleRetryableError(msg);
      const switchEvent = emittedEvents.find(
        (e) => e.type === "fallback_provider_switch" && e.to?.startsWith("claude-code/")
      );
      assert.equal(switchEvent, void 0, "Should NOT switch non-anthropic provider to claude-code");
    });
  });
  describe("quota_exhausted credential backoff (#3430)", () => {
    it("does NOT call markUsageLimitReached for quota_exhausted errors", async () => {
      const { deps, markUsageLimitReached } = createMockDeps({
        model: createMockModel("anthropic", "claude-opus-4-6[1m]"),
        markUsageLimitReachedResult: false,
        fallbackResult: null,
        findModelResult: () => void 0
      });
      const handler = new RetryHandler(deps);
      const msg = errorMessage(
        '429 {"type":"error","error":{"type":"rate_limit_error","message":"Extra usage is required for long context requests."}}'
      );
      await handler.handleRetryableError(msg);
      assert.equal(
        markUsageLimitReached.mock.calls.length,
        0,
        "markUsageLimitReached must NOT be called for quota_exhausted errors"
      );
    });
    it("still calls markUsageLimitReached for regular rate_limit errors", async () => {
      const { deps, markUsageLimitReached } = createMockDeps({
        model: createMockModel("anthropic", "claude-opus-4-6"),
        markUsageLimitReachedResult: false,
        fallbackResult: null
      });
      const handler = new RetryHandler(deps);
      const msg = errorMessage("429 Too Many Requests");
      await handler.handleRetryableError(msg);
      assert.equal(
        markUsageLimitReached.mock.calls.length,
        1,
        "markUsageLimitReached should be called for rate_limit errors"
      );
    });
    it("still tries cross-provider fallback for quota_exhausted without credential backoff", async () => {
      const fallbackModel = createMockModel("openai", "gpt-4o");
      const { deps, markUsageLimitReached, continueFn } = createMockDeps({
        model: createMockModel("anthropic", "claude-opus-4-6[1m]"),
        markUsageLimitReachedResult: false,
        fallbackResult: { model: fallbackModel, reason: "cross-provider fallback" }
      });
      const handler = new RetryHandler(deps);
      const msg = errorMessage("Extra usage is required for long context requests.");
      const result = await handler.handleRetryableError(msg);
      assert.equal(result, true, "should retry with fallback provider");
      assert.equal(
        markUsageLimitReached.mock.calls.length,
        0,
        "should NOT back off credentials before trying fallback"
      );
    });
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL3JldHJ5LWhhbmRsZXIudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBSZXRyeUhhbmRsZXIgdGVzdHMgXHUyMDE0IGxvbmctY29udGV4dCBlbnRpdGxlbWVudCA0MjkgZXJyb3IgaGFuZGxpbmcgKCMyODAzKVxuICpcbiAqIFZlcmlmaWVzIHRoYXQgXCJFeHRyYSB1c2FnZSBpcyByZXF1aXJlZCBmb3IgbG9uZyBjb250ZXh0IHJlcXVlc3RzXCIgZXJyb3JzXG4gKiBhcmUgY2xhc3NpZmllZCBhcyBxdW90YV9leGhhdXN0ZWQgKG5vdCByYXRlX2xpbWl0KSBhbmQgdHJpZ2dlciBhIG1vZGVsXG4gKiBkb3duZ3JhZGUgZnJvbSBbMW1dIHRvIGJhc2Ugd2hlbiBubyBjcm9zcy1wcm92aWRlciBmYWxsYmFjayBleGlzdHMuXG4gKi9cblxuaW1wb3J0IHsgZGVzY3JpYmUsIGl0LCBiZWZvcmVFYWNoLCBtb2NrLCB0eXBlIE1vY2sgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IFJldHJ5SGFuZGxlciwgdHlwZSBSZXRyeUhhbmRsZXJEZXBzIH0gZnJvbSBcIi4vcmV0cnktaGFuZGxlci5qc1wiO1xuaW1wb3J0IHR5cGUgeyBBcGksIEFzc2lzdGFudE1lc3NhZ2UsIE1vZGVsIH0gZnJvbSBcIkBnc2QvcGktYWlcIjtcbmltcG9ydCB0eXBlIHsgRmFsbGJhY2tSZXNvbHZlciB9IGZyb20gXCIuL2ZhbGxiYWNrLXJlc29sdmVyLmpzXCI7XG5pbXBvcnQgdHlwZSB7IE1vZGVsUmVnaXN0cnkgfSBmcm9tIFwiLi9tb2RlbC1yZWdpc3RyeS5qc1wiO1xuaW1wb3J0IHR5cGUgeyBTZXR0aW5nc01hbmFnZXIgfSBmcm9tIFwiLi9zZXR0aW5ncy1tYW5hZ2VyLmpzXCI7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBIZWxwZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBjcmVhdGVNb2NrTW9kZWwocHJvdmlkZXI6IHN0cmluZywgaWQ6IHN0cmluZyk6IE1vZGVsPEFwaT4ge1xuXHRyZXR1cm4ge1xuXHRcdGlkLFxuXHRcdG5hbWU6IGlkLFxuXHRcdGFwaTogXCJhbnRocm9waWNcIiBhcyBBcGksXG5cdFx0cHJvdmlkZXIsXG5cdFx0YmFzZVVybDogXCJodHRwczovL2FwaS5hbnRocm9waWMuY29tXCIsXG5cdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRjb3N0OiB7IGlucHV0OiAwLCBvdXRwdXQ6IDAsIGNhY2hlUmVhZDogMCwgY2FjaGVXcml0ZTogMCB9LFxuXHRcdGNvbnRleHRXaW5kb3c6IDFfMDAwXzAwMCxcblx0XHRtYXhUb2tlbnM6IDE2Mzg0LFxuXHR9IGFzIE1vZGVsPEFwaT47XG59XG5cbmZ1bmN0aW9uIGVycm9yTWVzc2FnZShtc2c6IHN0cmluZyk6IEFzc2lzdGFudE1lc3NhZ2Uge1xuXHRyZXR1cm4ge1xuXHRcdHJvbGU6IFwiYXNzaXN0YW50XCIsXG5cdFx0Y29udGVudDogW10sXG5cdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdHByb3ZpZGVyOiBcImFudGhyb3BpY1wiLFxuXHRcdG1vZGVsOiBcImNsYXVkZS1vcHVzLTQtNlsxbV1cIixcblx0XHR1c2FnZTogeyBpbnB1dDogMCwgb3V0cHV0OiAwLCBjYWNoZVJlYWQ6IDAsIGNhY2hlV3JpdGU6IDAsIHRvdGFsVG9rZW5zOiAwLCBjb3N0OiB7IGlucHV0OiAwLCBvdXRwdXQ6IDAsIGNhY2hlUmVhZDogMCwgY2FjaGVXcml0ZTogMCwgdG90YWw6IDAgfSB9LFxuXHRcdHN0b3BSZWFzb246IFwiZXJyb3JcIixcblx0XHRlcnJvck1lc3NhZ2U6IG1zZyxcblx0XHR0aW1lc3RhbXA6IERhdGUubm93KCksXG5cdH0gYXMgQXNzaXN0YW50TWVzc2FnZTtcbn1cblxuaW50ZXJmYWNlIE1vY2tEZXBzIHtcblx0ZGVwczogUmV0cnlIYW5kbGVyRGVwcztcblx0ZW1pdHRlZEV2ZW50czogQXJyYXk8UmVjb3JkPHN0cmluZywgYW55Pj47XG5cdGNvbnRpbnVlRm46IE1vY2s8KCkgPT4gUHJvbWlzZTx2b2lkPj47XG5cdG9uTW9kZWxDaGFuZ2VGbjogTW9jazwobW9kZWw6IE1vZGVsPGFueT4pID0+IHZvaWQ+O1xuXHRtYXJrVXNhZ2VMaW1pdFJlYWNoZWQ6IE1vY2s8KC4uLmFyZ3M6IGFueVtdKSA9PiBib29sZWFuPjtcblx0ZmluZEZhbGxiYWNrOiBNb2NrPCguLi5hcmdzOiBhbnlbXSkgPT4gUHJvbWlzZTxhbnk+Pjtcblx0ZmluZE1vZGVsOiBNb2NrPChwcm92aWRlcjogc3RyaW5nLCBtb2RlbElkOiBzdHJpbmcpID0+IE1vZGVsPEFwaT4gfCB1bmRlZmluZWQ+O1xufVxuXG5mdW5jdGlvbiBjcmVhdGVNb2NrRGVwcyhvdmVycmlkZXM/OiB7XG5cdG1vZGVsPzogTW9kZWw8QXBpPjtcblx0cmV0cnlFbmFibGVkPzogYm9vbGVhbjtcblx0bWFya1VzYWdlTGltaXRSZWFjaGVkUmVzdWx0PzogYm9vbGVhbjtcblx0ZmFsbGJhY2tSZXN1bHQ/OiBhbnk7XG5cdGZpbmRNb2RlbFJlc3VsdD86IChwcm92aWRlcjogc3RyaW5nLCBtb2RlbElkOiBzdHJpbmcpID0+IE1vZGVsPEFwaT4gfCB1bmRlZmluZWQ7XG5cdHJldHJ5U2V0dGluZ3M/OiB7XG5cdFx0bWF4UmV0cmllcz86IG51bWJlcjtcblx0XHRiYXNlRGVsYXlNcz86IG51bWJlcjtcblx0XHRtYXhEZWxheU1zPzogbnVtYmVyO1xuXHR9O1xufSk6IE1vY2tEZXBzIHtcblx0Y29uc3QgbW9kZWwgPSBvdmVycmlkZXM/Lm1vZGVsID8/IGNyZWF0ZU1vY2tNb2RlbChcImFudGhyb3BpY1wiLCBcImNsYXVkZS1vcHVzLTQtNlsxbV1cIik7XG5cdGNvbnN0IGVtaXR0ZWRFdmVudHM6IEFycmF5PFJlY29yZDxzdHJpbmcsIGFueT4+ID0gW107XG5cdGNvbnN0IGNvbnRpbnVlRm4gPSBtb2NrLmZuKGFzeW5jICgpID0+IHt9KTtcblx0Y29uc3Qgb25Nb2RlbENoYW5nZUZuID0gbW9jay5mbigoX21vZGVsOiBNb2RlbDxhbnk+KSA9PiB7fSk7XG5cdGNvbnN0IG1hcmtVc2FnZUxpbWl0UmVhY2hlZCA9IG1vY2suZm4oXG5cdFx0KCkgPT4gb3ZlcnJpZGVzPy5tYXJrVXNhZ2VMaW1pdFJlYWNoZWRSZXN1bHQgPz8gZmFsc2UsXG5cdCk7XG5cdGNvbnN0IGZpbmRGYWxsYmFjayA9IG1vY2suZm4oYXN5bmMgKCkgPT4gb3ZlcnJpZGVzPy5mYWxsYmFja1Jlc3VsdCA/PyBudWxsKTtcblx0Y29uc3QgZmluZE1vZGVsID0gbW9jay5mbihcblx0XHRvdmVycmlkZXM/LmZpbmRNb2RlbFJlc3VsdCA/PyAoKF9wcm92aWRlcjogc3RyaW5nLCBfbW9kZWxJZDogc3RyaW5nKSA9PiB1bmRlZmluZWQpLFxuXHQpO1xuXG5cdGNvbnN0IG1lc3NhZ2VzOiBBcnJheTx7IHJvbGU6IHN0cmluZyB9ICYgUmVjb3JkPHN0cmluZywgYW55Pj4gPSBbXTtcblxuXHRjb25zdCBkZXBzOiBSZXRyeUhhbmRsZXJEZXBzID0ge1xuXHRcdGFnZW50OiB7XG5cdFx0XHRjb250aW51ZTogY29udGludWVGbixcblx0XHRcdHN0YXRlOiB7IG1lc3NhZ2VzIH0sXG5cdFx0XHRzZXRNb2RlbDogbW9jay5mbigpLFxuXHRcdFx0cmVwbGFjZU1lc3NhZ2VzOiBtb2NrLmZuKChuZXdNZXNzYWdlczogYW55W10pID0+IHtcblx0XHRcdFx0bWVzc2FnZXMubGVuZ3RoID0gMDtcblx0XHRcdFx0bWVzc2FnZXMucHVzaCguLi5uZXdNZXNzYWdlcyk7XG5cdFx0XHR9KSxcblx0XHR9IGFzIGFueSxcblx0XHRzZXR0aW5nc01hbmFnZXI6IHtcblx0XHRcdGdldFJldHJ5RW5hYmxlZDogKCkgPT4gb3ZlcnJpZGVzPy5yZXRyeUVuYWJsZWQgPz8gdHJ1ZSxcblx0XHRcdGdldFJldHJ5U2V0dGluZ3M6ICgpID0+ICh7XG5cdFx0XHRcdGVuYWJsZWQ6IG92ZXJyaWRlcz8ucmV0cnlFbmFibGVkID8/IHRydWUsXG5cdFx0XHRcdG1heFJldHJpZXM6IG92ZXJyaWRlcz8ucmV0cnlTZXR0aW5ncz8ubWF4UmV0cmllcyA/PyA1LFxuXHRcdFx0XHRiYXNlRGVsYXlNczogb3ZlcnJpZGVzPy5yZXRyeVNldHRpbmdzPy5iYXNlRGVsYXlNcyA/PyAxMDAwLFxuXHRcdFx0XHRtYXhEZWxheU1zOiBvdmVycmlkZXM/LnJldHJ5U2V0dGluZ3M/Lm1heERlbGF5TXMgPz8gMzAwMDAsXG5cdFx0XHR9KSxcblx0XHR9IGFzIHVua25vd24gYXMgU2V0dGluZ3NNYW5hZ2VyLFxuXHRcdG1vZGVsUmVnaXN0cnk6IHtcblx0XHRcdGF1dGhTdG9yYWdlOiB7XG5cdFx0XHRcdG1hcmtVc2FnZUxpbWl0UmVhY2hlZCxcblx0XHRcdH0sXG5cdFx0XHRmaW5kOiBmaW5kTW9kZWwsXG5cdFx0fSBhcyB1bmtub3duIGFzIE1vZGVsUmVnaXN0cnksXG5cdFx0ZmFsbGJhY2tSZXNvbHZlcjoge1xuXHRcdFx0ZmluZEZhbGxiYWNrLFxuXHRcdH0gYXMgdW5rbm93biBhcyBGYWxsYmFja1Jlc29sdmVyLFxuXHRcdGdldE1vZGVsOiAoKSA9PiBtb2RlbCxcblx0XHRnZXRTZXNzaW9uSWQ6ICgpID0+IFwidGVzdC1zZXNzaW9uXCIsXG5cdFx0ZW1pdDogKGV2ZW50OiBhbnkpID0+IGVtaXR0ZWRFdmVudHMucHVzaChldmVudCksXG5cdFx0b25Nb2RlbENoYW5nZTogb25Nb2RlbENoYW5nZUZuLFxuXHR9O1xuXG5cdHJldHVybiB7IGRlcHMsIGVtaXR0ZWRFdmVudHMsIGNvbnRpbnVlRm4sIG9uTW9kZWxDaGFuZ2VGbiwgbWFya1VzYWdlTGltaXRSZWFjaGVkLCBmaW5kRmFsbGJhY2ssIGZpbmRNb2RlbCB9O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgX2NsYXNzaWZ5RXJyb3JUeXBlICh0ZXN0ZWQgdmlhIGhhbmRsZVJldHJ5YWJsZUVycm9yIGJlaGF2aW9yKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJSZXRyeUhhbmRsZXIgXHUyMDE0IGxvbmctY29udGV4dCBlbnRpdGxlbWVudCA0MjkgKCMyODAzKVwiLCAoKSA9PiB7XG5cblx0ZGVzY3JpYmUoXCJlcnJvciBjbGFzc2lmaWNhdGlvblwiLCAoKSA9PiB7XG5cdFx0aXQoXCJjbGFzc2lmaWVzICdFeHRyYSB1c2FnZSBpcyByZXF1aXJlZCBmb3IgbG9uZyBjb250ZXh0IHJlcXVlc3RzJyBhcyBxdW90YV9leGhhdXN0ZWQsIG5vdCByYXRlX2xpbWl0XCIsIGFzeW5jICgpID0+IHtcblx0XHRcdC8vIFdoZW4gdGhlIGVycm9yIGlzIGNsYXNzaWZpZWQgYXMgcXVvdGFfZXhoYXVzdGVkIEFORCBubyBhbHRlcm5hdGUgY3JlZGVudGlhbHNcblx0XHRcdC8vIEFORCBubyBmYWxsYmFjaywgdGhlIGhhbmRsZXIgc2hvdWxkIGVtaXQgZmFsbGJhY2tfY2hhaW5fZXhoYXVzdGVkIGFuZCBzdG9wLlxuXHRcdFx0Ly8gSWYgbWlzY2xhc3NpZmllZCBhcyByYXRlX2xpbWl0LCBpdCB3b3VsZCBlbnRlciB0aGUgYmFja29mZiBsb29wIGluc3RlYWQuXG5cdFx0XHRjb25zdCB7IGRlcHMsIGVtaXR0ZWRFdmVudHMsIGZpbmRNb2RlbCB9ID0gY3JlYXRlTW9ja0RlcHMoe1xuXHRcdFx0XHRtb2RlbDogY3JlYXRlTW9ja01vZGVsKFwiYW50aHJvcGljXCIsIFwiY2xhdWRlLW9wdXMtNC02WzFtXVwiKSxcblx0XHRcdFx0bWFya1VzYWdlTGltaXRSZWFjaGVkUmVzdWx0OiBmYWxzZSwgLy8gbm8gYWx0ZXJuYXRlIGNyZWRlbnRpYWxzXG5cdFx0XHRcdGZhbGxiYWNrUmVzdWx0OiBudWxsLCAvLyBubyBjcm9zcy1wcm92aWRlciBmYWxsYmFja1xuXHRcdFx0XHRmaW5kTW9kZWxSZXN1bHQ6ICgpID0+IHVuZGVmaW5lZCwgLy8gbm8gYmFzZSBtb2RlbCBlaXRoZXJcblx0XHRcdH0pO1xuXG5cdFx0XHRjb25zdCBoYW5kbGVyID0gbmV3IFJldHJ5SGFuZGxlcihkZXBzKTtcblx0XHRcdGNvbnN0IG1zZyA9IGVycm9yTWVzc2FnZShcblx0XHRcdFx0JzQyOSB7XCJ0eXBlXCI6XCJlcnJvclwiLFwiZXJyb3JcIjp7XCJ0eXBlXCI6XCJyYXRlX2xpbWl0X2Vycm9yXCIsXCJtZXNzYWdlXCI6XCJFeHRyYSB1c2FnZSBpcyByZXF1aXJlZCBmb3IgbG9uZyBjb250ZXh0IHJlcXVlc3RzLlwifX0nXG5cdFx0XHQpO1xuXG5cdFx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVyLmhhbmRsZVJldHJ5YWJsZUVycm9yKG1zZyk7XG5cblx0XHRcdC8vIFNob3VsZCBOT1QgcmV0cnkgKHdvdWxkIGJlIHRydWUgaWYgbWlzY2xhc3NpZmllZCBhcyByYXRlX2xpbWl0IGVudGVyaW5nIGJhY2tvZmYpXG5cdFx0XHRhc3NlcnQuZXF1YWwocmVzdWx0LCBmYWxzZSk7XG5cblx0XHRcdC8vIFNob3VsZCBlbWl0IGZhbGxiYWNrX2NoYWluX2V4aGF1c3RlZCAocXVvdGFfZXhoYXVzdGVkIHBhdGgpLCBOT1QgYXV0b19yZXRyeV9zdGFydCAoYmFja29mZiBwYXRoKVxuXHRcdFx0Y29uc3QgY2hhaW5FeGhhdXN0ZWQgPSBlbWl0dGVkRXZlbnRzLmZpbmQoKGUpID0+IGUudHlwZSA9PT0gXCJmYWxsYmFja19jaGFpbl9leGhhdXN0ZWRcIik7XG5cdFx0XHRhc3NlcnQub2soY2hhaW5FeGhhdXN0ZWQsIFwiRXhwZWN0ZWQgZmFsbGJhY2tfY2hhaW5fZXhoYXVzdGVkIGV2ZW50IGZvciBlbnRpdGxlbWVudCBlcnJvclwiKTtcblxuXHRcdFx0Y29uc3QgcmV0cnlTdGFydCA9IGVtaXR0ZWRFdmVudHMuZmluZCgoZSkgPT4gZS50eXBlID09PSBcImF1dG9fcmV0cnlfc3RhcnRcIik7XG5cdFx0XHRhc3NlcnQuZXF1YWwocmV0cnlTdGFydCwgdW5kZWZpbmVkLCBcIlNob3VsZCBOT1QgZW1pdCBhdXRvX3JldHJ5X3N0YXJ0IGZvciBlbnRpdGxlbWVudCBlcnJvclwiKTtcblx0XHR9KTtcblxuXHRcdGl0KFwic3RpbGwgY2xhc3NpZmllcyByZWd1bGFyIDQyOSByYXRlIGxpbWl0cyBhcyByYXRlX2xpbWl0XCIsIGFzeW5jICgpID0+IHtcblx0XHRcdC8vIEEgbm9ybWFsIFwicmF0ZSBsaW1pdFwiIDQyOSBzaG91bGQgc3RpbGwgYmUgY2xhc3NpZmllZCBhcyByYXRlX2xpbWl0XG5cdFx0XHRjb25zdCB7IGRlcHMsIGVtaXR0ZWRFdmVudHMgfSA9IGNyZWF0ZU1vY2tEZXBzKHtcblx0XHRcdFx0bW9kZWw6IGNyZWF0ZU1vY2tNb2RlbChcImFudGhyb3BpY1wiLCBcImNsYXVkZS1vcHVzLTQtNlwiKSxcblx0XHRcdFx0bWFya1VzYWdlTGltaXRSZWFjaGVkUmVzdWx0OiBmYWxzZSxcblx0XHRcdFx0ZmFsbGJhY2tSZXN1bHQ6IG51bGwsXG5cdFx0XHR9KTtcblxuXHRcdFx0Y29uc3QgaGFuZGxlciA9IG5ldyBSZXRyeUhhbmRsZXIoZGVwcyk7XG5cdFx0XHRjb25zdCBtc2cgPSBlcnJvck1lc3NhZ2UoXCI0MjkgVG9vIE1hbnkgUmVxdWVzdHNcIik7XG5cblx0XHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZXIuaGFuZGxlUmV0cnlhYmxlRXJyb3IobXNnKTtcblxuXHRcdFx0Ly8gU2hvdWxkIGVudGVyIHRoZSBiYWNrb2ZmIGxvb3AgKHJhdGVfbGltaXQgcGF0aCwgbm90IHF1b3RhX2V4aGF1c3RlZClcblx0XHRcdGFzc2VydC5lcXVhbChyZXN1bHQsIHRydWUpO1xuXG5cdFx0XHRjb25zdCByZXRyeVN0YXJ0ID0gZW1pdHRlZEV2ZW50cy5maW5kKChlKSA9PiBlLnR5cGUgPT09IFwiYXV0b19yZXRyeV9zdGFydFwiKTtcblx0XHRcdGFzc2VydC5vayhyZXRyeVN0YXJ0LCBcIlJlZ3VsYXIgNDI5IHNob3VsZCBlbnRlciBiYWNrb2ZmIHJldHJ5XCIpO1xuXHRcdH0pO1xuXG5cdFx0aXQoXCJjbGFzc2lmaWVzIE9wZW5Sb3V0ZXIgY3JlZGl0IGFmZm9yZGFiaWxpdHkgZXJyb3JzIGFzIHF1b3RhX2V4aGF1c3RlZFwiLCBhc3luYyAoKSA9PiB7XG5cdFx0XHRjb25zdCB7IGRlcHMsIGVtaXR0ZWRFdmVudHMgfSA9IGNyZWF0ZU1vY2tEZXBzKHtcblx0XHRcdFx0bW9kZWw6IGNyZWF0ZU1vY2tNb2RlbChcIm9wZW5yb3V0ZXJcIiwgXCJvcGVuYWkvZ3B0LTUtcHJvXCIpLFxuXHRcdFx0XHRtYXJrVXNhZ2VMaW1pdFJlYWNoZWRSZXN1bHQ6IGZhbHNlLFxuXHRcdFx0XHRmYWxsYmFja1Jlc3VsdDogbnVsbCxcblx0XHRcdH0pO1xuXG5cdFx0XHRjb25zdCBoYW5kbGVyID0gbmV3IFJldHJ5SGFuZGxlcihkZXBzKTtcblx0XHRcdGNvbnN0IG1zZyA9IGVycm9yTWVzc2FnZShcblx0XHRcdFx0XCI0MDIgVGhpcyByZXF1ZXN0IHJlcXVpcmVzIG1vcmUgY3JlZGl0cywgb3IgZmV3ZXIgbWF4X3Rva2Vucy4gWW91IHJlcXVlc3RlZCB1cCB0byAzMjAwMCB0b2tlbnMsIGJ1dCBjYW4gb25seSBhZmZvcmQgMzI5LlwiLFxuXHRcdFx0KTtcblxuXHRcdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlci5oYW5kbGVSZXRyeWFibGVFcnJvcihtc2cpO1xuXG5cdFx0XHRhc3NlcnQuZXF1YWwocmVzdWx0LCB0cnVlLCBcImFmZm9yZGFiaWxpdHkgZXJyb3Igc2hvdWxkIHRyaWdnZXIgY3JlZGl0LWF3YXJlIHJldHJ5XCIpO1xuXHRcdFx0Y29uc3QgcmV0cnlTdGFydCA9IGVtaXR0ZWRFdmVudHMuZmluZCgoZSkgPT4gZS50eXBlID09PSBcImF1dG9fcmV0cnlfc3RhcnRcIik7XG5cdFx0XHRhc3NlcnQub2socmV0cnlTdGFydCwgXCJFeHBlY3RlZCBpbW1lZGlhdGUgcmV0cnkgYWZ0ZXIgcmVkdWNpbmcgbWF4IHRva2Vuc1wiKTtcblx0XHR9KTtcblx0fSk7XG5cblx0ZGVzY3JpYmUoXCJsb25nLWNvbnRleHQgbW9kZWwgZG93bmdyYWRlXCIsICgpID0+IHtcblx0XHRpdChcImRvd25ncmFkZXMgZnJvbSBbMW1dIHRvIGJhc2UgbW9kZWwgd2hlbiBlbnRpdGxlbWVudCBlcnJvciBhbmQgbm8gZmFsbGJhY2tcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdFx0Y29uc3QgYmFzZU1vZGVsID0gY3JlYXRlTW9ja01vZGVsKFwiYW50aHJvcGljXCIsIFwiY2xhdWRlLW9wdXMtNC02XCIpO1xuXHRcdFx0Y29uc3QgeyBkZXBzLCBlbWl0dGVkRXZlbnRzLCBvbk1vZGVsQ2hhbmdlRm4sIGNvbnRpbnVlRm4gfSA9IGNyZWF0ZU1vY2tEZXBzKHtcblx0XHRcdFx0bW9kZWw6IGNyZWF0ZU1vY2tNb2RlbChcImFudGhyb3BpY1wiLCBcImNsYXVkZS1vcHVzLTQtNlsxbV1cIiksXG5cdFx0XHRcdG1hcmtVc2FnZUxpbWl0UmVhY2hlZFJlc3VsdDogZmFsc2UsXG5cdFx0XHRcdGZhbGxiYWNrUmVzdWx0OiBudWxsLFxuXHRcdFx0XHRmaW5kTW9kZWxSZXN1bHQ6IChwcm92aWRlcjogc3RyaW5nLCBtb2RlbElkOiBzdHJpbmcpID0+IHtcblx0XHRcdFx0XHRpZiAocHJvdmlkZXIgPT09IFwiYW50aHJvcGljXCIgJiYgbW9kZWxJZCA9PT0gXCJjbGF1ZGUtb3B1cy00LTZcIikgcmV0dXJuIGJhc2VNb2RlbDtcblx0XHRcdFx0XHRyZXR1cm4gdW5kZWZpbmVkO1xuXHRcdFx0XHR9LFxuXHRcdFx0fSk7XG5cblx0XHRcdGNvbnN0IGhhbmRsZXIgPSBuZXcgUmV0cnlIYW5kbGVyKGRlcHMpO1xuXHRcdFx0Y29uc3QgbXNnID0gZXJyb3JNZXNzYWdlKFwiRXh0cmEgdXNhZ2UgaXMgcmVxdWlyZWQgZm9yIGxvbmcgY29udGV4dCByZXF1ZXN0cy5cIik7XG5cblx0XHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZXIuaGFuZGxlUmV0cnlhYmxlRXJyb3IobXNnKTtcblxuXHRcdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdCwgdHJ1ZSwgXCJTaG91bGQgcmV0cnkgYWZ0ZXIgZG93bmdyYWRlXCIpO1xuXG5cdFx0XHQvLyBTaG91bGQgaGF2ZSBjYWxsZWQgc2V0TW9kZWwgd2l0aCB0aGUgYmFzZSBtb2RlbFxuXHRcdFx0Y29uc3Qgc2V0TW9kZWxDYWxscyA9IChkZXBzLmFnZW50LnNldE1vZGVsIGFzIGFueSkubW9jay5jYWxscztcblx0XHRcdGFzc2VydC5lcXVhbChzZXRNb2RlbENhbGxzLmxlbmd0aCwgMSk7XG5cdFx0XHRhc3NlcnQuZXF1YWwoc2V0TW9kZWxDYWxsc1swXS5hcmd1bWVudHNbMF0uaWQsIFwiY2xhdWRlLW9wdXMtNC02XCIpO1xuXG5cdFx0XHQvLyBTaG91bGQgaGF2ZSBub3RpZmllZCBhYm91dCBtb2RlbCBjaGFuZ2Vcblx0XHRcdGFzc2VydC5lcXVhbChvbk1vZGVsQ2hhbmdlRm4ubW9jay5jYWxscy5sZW5ndGgsIDEpO1xuXG5cdFx0XHQvLyBTaG91bGQgZW1pdCBhIGZhbGxiYWNrX3Byb3ZpZGVyX3N3aXRjaCBldmVudCBpbmRpY2F0aW5nIGRvd25ncmFkZVxuXHRcdFx0Y29uc3Qgc3dpdGNoRXZlbnQgPSBlbWl0dGVkRXZlbnRzLmZpbmQoKGUpID0+IGUudHlwZSA9PT0gXCJmYWxsYmFja19wcm92aWRlcl9zd2l0Y2hcIik7XG5cdFx0XHRhc3NlcnQub2soc3dpdGNoRXZlbnQsIFwiRXhwZWN0ZWQgZmFsbGJhY2tfcHJvdmlkZXJfc3dpdGNoIGV2ZW50IGZvciBkb3duZ3JhZGVcIik7XG5cdFx0XHRhc3NlcnQub2soc3dpdGNoRXZlbnQhLnJlYXNvbi5pbmNsdWRlcyhcImxvbmcgY29udGV4dCBkb3duZ3JhZGVcIiksIGByZWFzb24gc2hvdWxkIG1lbnRpb24gZG93bmdyYWRlOiAke3N3aXRjaEV2ZW50IS5yZWFzb259YCk7XG5cdFx0fSk7XG5cblx0XHRpdChcImVtaXRzIGZhbGxiYWNrX2NoYWluX2V4aGF1c3RlZCB3aGVuIGJhc2UgbW9kZWwgaXMgYWxzbyB1bmF2YWlsYWJsZVwiLCBhc3luYyAoKSA9PiB7XG5cdFx0XHRjb25zdCB7IGRlcHMsIGVtaXR0ZWRFdmVudHMgfSA9IGNyZWF0ZU1vY2tEZXBzKHtcblx0XHRcdFx0bW9kZWw6IGNyZWF0ZU1vY2tNb2RlbChcImFudGhyb3BpY1wiLCBcImNsYXVkZS1vcHVzLTQtNlsxbV1cIiksXG5cdFx0XHRcdG1hcmtVc2FnZUxpbWl0UmVhY2hlZFJlc3VsdDogZmFsc2UsXG5cdFx0XHRcdGZhbGxiYWNrUmVzdWx0OiBudWxsLFxuXHRcdFx0XHRmaW5kTW9kZWxSZXN1bHQ6ICgpID0+IHVuZGVmaW5lZCwgLy8gYmFzZSBtb2RlbCBub3QgZm91bmRcblx0XHRcdH0pO1xuXG5cdFx0XHRjb25zdCBoYW5kbGVyID0gbmV3IFJldHJ5SGFuZGxlcihkZXBzKTtcblx0XHRcdGNvbnN0IG1zZyA9IGVycm9yTWVzc2FnZShcIkV4dHJhIHVzYWdlIGlzIHJlcXVpcmVkIGZvciBsb25nIGNvbnRleHQgcmVxdWVzdHMuXCIpO1xuXG5cdFx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVyLmhhbmRsZVJldHJ5YWJsZUVycm9yKG1zZyk7XG5cblx0XHRcdGFzc2VydC5lcXVhbChyZXN1bHQsIGZhbHNlKTtcblx0XHRcdGNvbnN0IGNoYWluRXhoYXVzdGVkID0gZW1pdHRlZEV2ZW50cy5maW5kKChlKSA9PiBlLnR5cGUgPT09IFwiZmFsbGJhY2tfY2hhaW5fZXhoYXVzdGVkXCIpO1xuXHRcdFx0YXNzZXJ0Lm9rKGNoYWluRXhoYXVzdGVkLCBcIkV4cGVjdGVkIGZhbGxiYWNrX2NoYWluX2V4aGF1c3RlZCB3aGVuIGJhc2UgbW9kZWwgdW5hdmFpbGFibGVcIik7XG5cdFx0fSk7XG5cblx0XHRpdChcImRvZXMgbm90IGF0dGVtcHQgZG93bmdyYWRlIGZvciBub24tWzFtXSBtb2RlbHNcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdFx0Ly8gV2hlbiBhIHJlZ3VsYXIgbW9kZWwgKG5vIFsxbV0gc3VmZml4KSBnZXRzIGEgcXVvdGFfZXhoYXVzdGVkIGVycm9yXG5cdFx0XHQvLyB3aXRoIG5vIGZhbGxiYWNrLCBpdCBzaG91bGQganVzdCBzdG9wIFx1MjAxNCBubyBkb3duZ3JhZGUgYXR0ZW1wdC5cblx0XHRcdGNvbnN0IHsgZGVwcywgZW1pdHRlZEV2ZW50cyB9ID0gY3JlYXRlTW9ja0RlcHMoe1xuXHRcdFx0XHRtb2RlbDogY3JlYXRlTW9ja01vZGVsKFwiYW50aHJvcGljXCIsIFwiY2xhdWRlLW9wdXMtNC02XCIpLFxuXHRcdFx0XHRtYXJrVXNhZ2VMaW1pdFJlYWNoZWRSZXN1bHQ6IGZhbHNlLFxuXHRcdFx0XHRmYWxsYmFja1Jlc3VsdDogbnVsbCxcblx0XHRcdH0pO1xuXG5cdFx0XHRjb25zdCBoYW5kbGVyID0gbmV3IFJldHJ5SGFuZGxlcihkZXBzKTtcblx0XHRcdGNvbnN0IG1zZyA9IGVycm9yTWVzc2FnZShcIkV4dHJhIHVzYWdlIGlzIHJlcXVpcmVkIGZvciBsb25nIGNvbnRleHQgcmVxdWVzdHMuXCIpO1xuXG5cdFx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVyLmhhbmRsZVJldHJ5YWJsZUVycm9yKG1zZyk7XG5cblx0XHRcdGFzc2VydC5lcXVhbChyZXN1bHQsIGZhbHNlKTtcblx0XHRcdGNvbnN0IGNoYWluRXhoYXVzdGVkID0gZW1pdHRlZEV2ZW50cy5maW5kKChlKSA9PiBlLnR5cGUgPT09IFwiZmFsbGJhY2tfY2hhaW5fZXhoYXVzdGVkXCIpO1xuXHRcdFx0YXNzZXJ0Lm9rKGNoYWluRXhoYXVzdGVkKTtcblxuXHRcdFx0Ly8gTm8gZG93bmdyYWRlIHN3aXRjaCBzaG91bGQgb2NjdXJcblx0XHRcdGNvbnN0IHN3aXRjaEV2ZW50ID0gZW1pdHRlZEV2ZW50cy5maW5kKChlKSA9PiBlLnR5cGUgPT09IFwiZmFsbGJhY2tfcHJvdmlkZXJfc3dpdGNoXCIpO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKHN3aXRjaEV2ZW50LCB1bmRlZmluZWQsIFwiU2hvdWxkIG5vdCBzd2l0Y2ggZm9yIG5vbi1bMW1dIG1vZGVsc1wiKTtcblx0XHR9KTtcblx0fSk7XG5cblx0ZGVzY3JpYmUoXCJyZXRyeSBjYW5jZWxsYXRpb25cIiwgKCkgPT4ge1xuXHRcdGl0KFwiY2FuY2VscyBxdWV1ZWQgaW1tZWRpYXRlIGNvbnRpbnVlIGNhbGxiYWNrcyB3aGVuIHJldHJ5IGlzIGFib3J0ZWRcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdFx0Y29uc3QgeyBkZXBzLCBlbWl0dGVkRXZlbnRzLCBjb250aW51ZUZuIH0gPSBjcmVhdGVNb2NrRGVwcyh7XG5cdFx0XHRcdG1hcmtVc2FnZUxpbWl0UmVhY2hlZFJlc3VsdDogdHJ1ZSxcblx0XHRcdH0pO1xuXG5cdFx0XHRjb25zdCBoYW5kbGVyID0gbmV3IFJldHJ5SGFuZGxlcihkZXBzKTtcblx0XHRcdGNvbnN0IG1zZyA9IGVycm9yTWVzc2FnZShcIjQyOSBUb28gTWFueSBSZXF1ZXN0c1wiKTtcblxuXHRcdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlci5oYW5kbGVSZXRyeWFibGVFcnJvcihtc2cpO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdCwgdHJ1ZSwgXCJyZXRyeSBzaG91bGQgYmUgaW5pdGlhdGVkXCIpO1xuXG5cdFx0XHRoYW5kbGVyLmFib3J0UmV0cnkoKTtcblx0XHRcdC8vIFlpZWxkIHRoZSBtaWNyb3Rhc2sgcXVldWUgc28gYW55IHN5bmNocm9ub3VzIGNvbnRpbnVhdGlvblxuXHRcdFx0Ly8gc2NoZWR1bGVkIGJ5IGFib3J0UmV0cnkoKSBzZXR0bGVzIGJlZm9yZSB3ZSBhc3NlcnQuIFRoaXMgaXNcblx0XHRcdC8vIGRldGVybWluaXN0aWMgXHUyMDE0IG5vIG1hZ2ljLXNsZWVwIGRlcGVuZGVuY3kgKCM0Nzk4IC8gIzQ3ODQpLlxuXHRcdFx0YXdhaXQgUHJvbWlzZS5yZXNvbHZlKCk7XG5cdFx0XHRhd2FpdCBQcm9taXNlLnJlc29sdmUoKTtcblxuXHRcdFx0YXNzZXJ0LmVxdWFsKGNvbnRpbnVlRm4ubW9jay5jYWxscy5sZW5ndGgsIDAsIFwiY2FuY2VsbGVkIHJldHJ5IG11c3Qgbm90IGNvbnRpbnVlIGFmdGVyIGV4cGxpY2l0IGFib3J0XCIpO1xuXHRcdFx0Y29uc3QgZW5kRXZlbnRzID0gZW1pdHRlZEV2ZW50cy5maWx0ZXIoKGUpID0+IGUudHlwZSA9PT0gXCJhdXRvX3JldHJ5X2VuZFwiKTtcblx0XHRcdGFzc2VydC5lcXVhbChlbmRFdmVudHMubGVuZ3RoLCAxLCBcInJldHJ5IGNhbmNlbGxhdGlvbiBzaG91bGQgZW1pdCBhIHNpbmdsZSBhdXRvX3JldHJ5X2VuZCBldmVudFwiKTtcblx0XHRcdGFzc2VydC5lcXVhbChlbmRFdmVudHNbMF0/LmZpbmFsRXJyb3IsIFwiUmV0cnkgY2FuY2VsbGVkXCIpO1xuXHRcdH0pO1xuXHR9KTtcblxuXHRkZXNjcmliZShcImNyZWRpdC1hd2FyZSBtYXhUb2tlbnMgcmV0cnlcIiwgKCkgPT4ge1xuXHRcdGl0KFwicmVkdWNlcyBtYXhUb2tlbnMgb24gc2FtZSBtb2RlbCB3aGVuIHByb3ZpZGVyIHJlcG9ydHMgYWZmb3JkYWJsZSBjYXBcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdFx0Y29uc3QgZXhwZW5zaXZlTW9kZWwgPSBjcmVhdGVNb2NrTW9kZWwoXCJvcGVucm91dGVyXCIsIFwib3BlbmFpL2dwdC01LXByb1wiKTtcblx0XHRcdGV4cGVuc2l2ZU1vZGVsLm1heFRva2VucyA9IDEyODAwMDtcblxuXHRcdFx0Y29uc3QgeyBkZXBzLCBlbWl0dGVkRXZlbnRzLCBvbk1vZGVsQ2hhbmdlRm4gfSA9IGNyZWF0ZU1vY2tEZXBzKHtcblx0XHRcdFx0bW9kZWw6IGV4cGVuc2l2ZU1vZGVsLFxuXHRcdFx0XHRtYXJrVXNhZ2VMaW1pdFJlYWNoZWRSZXN1bHQ6IGZhbHNlLFxuXHRcdFx0XHRmYWxsYmFja1Jlc3VsdDogbnVsbCxcblx0XHRcdH0pO1xuXG5cdFx0XHRjb25zdCBoYW5kbGVyID0gbmV3IFJldHJ5SGFuZGxlcihkZXBzKTtcblx0XHRcdGNvbnN0IG1zZyA9IGVycm9yTWVzc2FnZShcblx0XHRcdFx0XCI0MDIgVGhpcyByZXF1ZXN0IHJlcXVpcmVzIG1vcmUgY3JlZGl0cywgb3IgZmV3ZXIgbWF4X3Rva2Vucy4gWW91IHJlcXVlc3RlZCB1cCB0byAzMjAwMCB0b2tlbnMsIGJ1dCBjYW4gb25seSBhZmZvcmQgMzI5LlwiLFxuXHRcdFx0KTtcblxuXHRcdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlci5oYW5kbGVSZXRyeWFibGVFcnJvcihtc2cpO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdCwgdHJ1ZSwgXCJzaG91bGQgcmV0cnkgYWZ0ZXIgcmVkdWNpbmcgbWF4VG9rZW5zXCIpO1xuXG5cdFx0XHRjb25zdCBzZXRNb2RlbENhbGxzID0gKGRlcHMuYWdlbnQuc2V0TW9kZWwgYXMgYW55KS5tb2NrLmNhbGxzO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKHNldE1vZGVsQ2FsbHMubGVuZ3RoLCAxLCBcInNob3VsZCBhcHBseSBvbmUgbW9kZWwgZG93bmdyYWRlXCIpO1xuXHRcdFx0Y29uc3QgZG93bmdyYWRlZCA9IHNldE1vZGVsQ2FsbHNbMF0uYXJndW1lbnRzWzBdIGFzIE1vZGVsPEFwaT47XG5cdFx0XHRhc3NlcnQuZXF1YWwoZG93bmdyYWRlZC5wcm92aWRlciwgXCJvcGVucm91dGVyXCIpO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKGRvd25ncmFkZWQuaWQsIFwib3BlbmFpL2dwdC01LXByb1wiKTtcblx0XHRcdGFzc2VydC5lcXVhbChkb3duZ3JhZGVkLm1heFRva2VucywgMjk3LCBcImV4cGVjdGVkIGFmZm9yZGFiaWxpdHkgY2FwIHdpdGggc2FmZXR5IGJ1ZmZlclwiKTtcblxuXHRcdFx0YXNzZXJ0LmVxdWFsKG9uTW9kZWxDaGFuZ2VGbi5tb2NrLmNhbGxzLmxlbmd0aCwgMSwgXCJzaG91bGQgbm90aWZ5IGFib3V0IG1vZGVsIHVwZGF0ZVwiKTtcblx0XHRcdGNvbnN0IHN3aXRjaEV2ZW50ID0gZW1pdHRlZEV2ZW50cy5maW5kKChlKSA9PiBlLnR5cGUgPT09IFwiZmFsbGJhY2tfcHJvdmlkZXJfc3dpdGNoXCIpO1xuXHRcdFx0YXNzZXJ0Lm9rKHN3aXRjaEV2ZW50LCBcInNob3VsZCBlbWl0IG1vZGVsLWFkanVzdG1lbnQgZXZlbnRcIik7XG5cdFx0XHRhc3NlcnQub2soXG5cdFx0XHRcdFN0cmluZyhzd2l0Y2hFdmVudD8ucmVhc29uIHx8IFwiXCIpLmluY2x1ZGVzKFwiY3JlZGl0LWF3YXJlIHJldHJ5XCIpLFxuXHRcdFx0XHRcInN3aXRjaCByZWFzb24gc2hvdWxkIG1lbnRpb24gY3JlZGl0LWF3YXJlIHJldHJ5XCIsXG5cdFx0XHQpO1xuXHRcdH0pO1xuXG5cdFx0aXQoXCJkb2VzIG5vdCBtYXJrIGNyZWRlbnRpYWxzIGluIGNvb2xkb3duIGZvciBhZmZvcmRhYmlsaXR5IHF1b3RhIGVycm9yc1wiLCBhc3luYyAoKSA9PiB7XG5cdFx0XHRjb25zdCBleHBlbnNpdmVNb2RlbCA9IGNyZWF0ZU1vY2tNb2RlbChcIm9wZW5yb3V0ZXJcIiwgXCJvcGVuYWkvZ3B0LTUtcHJvXCIpO1xuXHRcdFx0ZXhwZW5zaXZlTW9kZWwubWF4VG9rZW5zID0gMTI4MDAwO1xuXG5cdFx0XHRjb25zdCB7IGRlcHMsIG1hcmtVc2FnZUxpbWl0UmVhY2hlZCB9ID0gY3JlYXRlTW9ja0RlcHMoe1xuXHRcdFx0XHRtb2RlbDogZXhwZW5zaXZlTW9kZWwsXG5cdFx0XHRcdG1hcmtVc2FnZUxpbWl0UmVhY2hlZFJlc3VsdDogZmFsc2UsXG5cdFx0XHRcdGZhbGxiYWNrUmVzdWx0OiBudWxsLFxuXHRcdFx0fSk7XG5cblx0XHRcdGNvbnN0IGhhbmRsZXIgPSBuZXcgUmV0cnlIYW5kbGVyKGRlcHMpO1xuXHRcdFx0Y29uc3QgbXNnID0gZXJyb3JNZXNzYWdlKFxuXHRcdFx0XHRcIjQwMiBUaGlzIHJlcXVlc3QgcmVxdWlyZXMgbW9yZSBjcmVkaXRzLCBvciBmZXdlciBtYXhfdG9rZW5zLiBZb3UgcmVxdWVzdGVkIHVwIHRvIDMyMDAwIHRva2VucywgYnV0IGNhbiBvbmx5IGFmZm9yZCAzMjkuXCIsXG5cdFx0XHQpO1xuXG5cdFx0XHRhd2FpdCBoYW5kbGVyLmhhbmRsZVJldHJ5YWJsZUVycm9yKG1zZyk7XG5cdFx0XHRhc3NlcnQuZXF1YWwobWFya1VzYWdlTGltaXRSZWFjaGVkLm1vY2suY2FsbHMubGVuZ3RoLCAwLCBcInF1b3RhIGVycm9yIHNob3VsZCBza2lwIGNyZWRlbnRpYWwgY29vbGRvd25cIik7XG5cdFx0fSk7XG5cdH0pO1xuXG5cdGRlc2NyaWJlKFwiaXNSZXRyeWFibGVFcnJvclwiLCAoKSA9PiB7XG5cdFx0aXQoXCJjb25zaWRlcnMgbG9uZy1jb250ZXh0IGVudGl0bGVtZW50IGVycm9yIGFzIHJldHJ5YWJsZVwiLCAoKSA9PiB7XG5cdFx0XHRjb25zdCB7IGRlcHMgfSA9IGNyZWF0ZU1vY2tEZXBzKCk7XG5cdFx0XHRjb25zdCBoYW5kbGVyID0gbmV3IFJldHJ5SGFuZGxlcihkZXBzKTtcblx0XHRcdGNvbnN0IG1zZyA9IGVycm9yTWVzc2FnZShcIkV4dHJhIHVzYWdlIGlzIHJlcXVpcmVkIGZvciBsb25nIGNvbnRleHQgcmVxdWVzdHMuXCIpO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKGhhbmRsZXIuaXNSZXRyeWFibGVFcnJvcihtc2cpLCB0cnVlKTtcblx0XHR9KTtcblxuXHRcdGl0KFwiZG9lcyBOT1QgY29uc2lkZXIgY3JlZGVudGlhbCBjb29sZG93biBlcnJvciBhcyByZXRyeWFibGUgKCMzNDI5KVwiLCAoKSA9PiB7XG5cdFx0XHQvLyBUaGUgY3JlZGVudGlhbCBjb29sZG93biBtZXNzYWdlIGZyb20gZ2V0QXBpS2V5KCkgbXVzdCBub3QgcmUtZW50ZXJcblx0XHRcdC8vIHRoZSByZXRyeSBoYW5kbGVyLiBSZS1lbnRyeSBjcmVhdGVzIGNhc2NhZGluZyBlbXB0eSBlcnJvciBlbnRyaWVzXG5cdFx0XHQvLyBpbiB0aGUgc2Vzc2lvbiBmaWxlIHRoYXQgYnJlYWsgcmVzdW1lLlxuXHRcdFx0Y29uc3QgeyBkZXBzIH0gPSBjcmVhdGVNb2NrRGVwcygpO1xuXHRcdFx0Y29uc3QgaGFuZGxlciA9IG5ldyBSZXRyeUhhbmRsZXIoZGVwcyk7XG5cdFx0XHRjb25zdCBtc2cgPSBlcnJvck1lc3NhZ2UoXG5cdFx0XHRcdCdBbGwgY3JlZGVudGlhbHMgZm9yIFwiYW50aHJvcGljXCIgYXJlIGluIGEgY29vbGRvd24gd2luZG93LiAnICtcblx0XHRcdFx0J1BsZWFzZSB3YWl0IGEgbW9tZW50IGFuZCB0cnkgYWdhaW4sIG9yIHN3aXRjaCB0byBhIGRpZmZlcmVudCBwcm92aWRlci4nLFxuXHRcdFx0KTtcblx0XHRcdGFzc2VydC5lcXVhbChoYW5kbGVyLmlzUmV0cnlhYmxlRXJyb3IobXNnKSwgZmFsc2UpO1xuXHRcdH0pO1xuXG5cdFx0aXQoXCJjb25zaWRlcnMgT3BlblJvdXRlciBhZmZvcmRhYmlsaXR5IGNyZWRpdCBlcnJvcnMgYXMgcmV0cnlhYmxlXCIsICgpID0+IHtcblx0XHRcdGNvbnN0IHsgZGVwcyB9ID0gY3JlYXRlTW9ja0RlcHMoKTtcblx0XHRcdGNvbnN0IGhhbmRsZXIgPSBuZXcgUmV0cnlIYW5kbGVyKGRlcHMpO1xuXHRcdFx0Y29uc3QgbXNnID0gZXJyb3JNZXNzYWdlKFxuXHRcdFx0XHRcIjQwMiBUaGlzIHJlcXVlc3QgcmVxdWlyZXMgbW9yZSBjcmVkaXRzLCBvciBmZXdlciBtYXhfdG9rZW5zLiBZb3UgcmVxdWVzdGVkIHVwIHRvIDMyMDAwIHRva2VucywgYnV0IGNhbiBvbmx5IGFmZm9yZCAzMjkuXCIsXG5cdFx0XHQpO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKGhhbmRsZXIuaXNSZXRyeWFibGVFcnJvcihtc2cpLCB0cnVlKTtcblx0XHR9KTtcblx0fSk7XG5cblx0ZGVzY3JpYmUoXCJ0aGlyZC1wYXJ0eSBibG9jayBjbGF1ZGUtY29kZSBmYWxsYmFjayAoIzM3NzIpXCIsICgpID0+IHtcblx0XHRpdChcInN3aXRjaGVzIHRvIGNsYXVkZS1jb2RlIHByb3ZpZGVyIHdoZW4gY3VycmVudCBwcm92aWRlciBpcyBhbnRocm9waWNcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdFx0Y29uc3QgY2NNb2RlbCA9IGNyZWF0ZU1vY2tNb2RlbChcImNsYXVkZS1jb2RlXCIsIFwiY2xhdWRlLW9wdXMtNC02XCIpO1xuXHRcdFx0Y29uc3QgeyBkZXBzLCBlbWl0dGVkRXZlbnRzLCBvbk1vZGVsQ2hhbmdlRm4gfSA9IGNyZWF0ZU1vY2tEZXBzKHtcblx0XHRcdFx0bW9kZWw6IGNyZWF0ZU1vY2tNb2RlbChcImFudGhyb3BpY1wiLCBcImNsYXVkZS1vcHVzLTQtNlwiKSxcblx0XHRcdFx0ZmluZE1vZGVsUmVzdWx0OiAocHJvdmlkZXI6IHN0cmluZywgbW9kZWxJZDogc3RyaW5nKSA9PiB7XG5cdFx0XHRcdFx0aWYgKHByb3ZpZGVyID09PSBcImNsYXVkZS1jb2RlXCIgJiYgbW9kZWxJZCA9PT0gXCJjbGF1ZGUtb3B1cy00LTZcIikgcmV0dXJuIGNjTW9kZWw7XG5cdFx0XHRcdFx0cmV0dXJuIHVuZGVmaW5lZDtcblx0XHRcdFx0fSxcblx0XHRcdH0pO1xuXHRcdFx0ZGVwcy5pc0NsYXVkZUNvZGVSZWFkeSA9ICgpID0+IHRydWU7XG5cblx0XHRcdGNvbnN0IGhhbmRsZXIgPSBuZXcgUmV0cnlIYW5kbGVyKGRlcHMpO1xuXHRcdFx0Y29uc3QgbXNnID0gZXJyb3JNZXNzYWdlKFwidGhpcmQtcGFydHkgYXBwcyBjYW5ub3QgZHJhdyBmcm9tIGV4dHJhIHVzYWdlXCIpO1xuXG5cdFx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVyLmhhbmRsZVJldHJ5YWJsZUVycm9yKG1zZyk7XG5cblx0XHRcdGFzc2VydC5lcXVhbChyZXN1bHQsIHRydWUsIFwic2hvdWxkIHJldHJ5IHZpYSBjbGF1ZGUtY29kZSBmYWxsYmFja1wiKTtcblx0XHRcdGNvbnN0IHN3aXRjaEV2ZW50ID0gZW1pdHRlZEV2ZW50cy5maW5kKChlKSA9PiBlLnR5cGUgPT09IFwiZmFsbGJhY2tfcHJvdmlkZXJfc3dpdGNoXCIpO1xuXHRcdFx0YXNzZXJ0Lm9rKHN3aXRjaEV2ZW50LCBcIkV4cGVjdGVkIGZhbGxiYWNrX3Byb3ZpZGVyX3N3aXRjaCBldmVudFwiKTtcblx0XHRcdGFzc2VydC5vayhzd2l0Y2hFdmVudCEudG8uc3RhcnRzV2l0aChcImNsYXVkZS1jb2RlL1wiKSwgXCJTaG91bGQgc3dpdGNoIHRvIGNsYXVkZS1jb2RlIHByb3ZpZGVyXCIpO1xuXHRcdH0pO1xuXG5cdFx0aXQoXCJzd2l0Y2hlcyB0byBjbGF1ZGUtY29kZSBvbiAnb3V0IG9mIGV4dHJhIHVzYWdlJyBlcnJvciAoIzM3NzIpXCIsIGFzeW5jICgpID0+IHtcblx0XHRcdGNvbnN0IGNjTW9kZWwgPSBjcmVhdGVNb2NrTW9kZWwoXCJjbGF1ZGUtY29kZVwiLCBcImNsYXVkZS1vcHVzLTQtNlwiKTtcblx0XHRcdGNvbnN0IHsgZGVwcywgZW1pdHRlZEV2ZW50cyB9ID0gY3JlYXRlTW9ja0RlcHMoe1xuXHRcdFx0XHRtb2RlbDogY3JlYXRlTW9ja01vZGVsKFwiYW50aHJvcGljXCIsIFwiY2xhdWRlLW9wdXMtNC02XCIpLFxuXHRcdFx0XHRmaW5kTW9kZWxSZXN1bHQ6IChwcm92aWRlcjogc3RyaW5nLCBtb2RlbElkOiBzdHJpbmcpID0+IHtcblx0XHRcdFx0XHRpZiAocHJvdmlkZXIgPT09IFwiY2xhdWRlLWNvZGVcIiAmJiBtb2RlbElkID09PSBcImNsYXVkZS1vcHVzLTQtNlwiKSByZXR1cm4gY2NNb2RlbDtcblx0XHRcdFx0XHRyZXR1cm4gdW5kZWZpbmVkO1xuXHRcdFx0XHR9LFxuXHRcdFx0fSk7XG5cdFx0XHRkZXBzLmlzQ2xhdWRlQ29kZVJlYWR5ID0gKCkgPT4gdHJ1ZTtcblxuXHRcdFx0Y29uc3QgaGFuZGxlciA9IG5ldyBSZXRyeUhhbmRsZXIoZGVwcyk7XG5cdFx0XHRjb25zdCBtc2cgPSBlcnJvck1lc3NhZ2UoXCJZb3UncmUgb3V0IG9mIGV4dHJhIHVzYWdlLiBBZGQgbW9yZSBhdCBjbGF1ZGUuYWkvc2V0dGluZ3MvdXNhZ2UgYW5kIGtlZXAgZ29pbmcuXCIpO1xuXG5cdFx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVyLmhhbmRsZVJldHJ5YWJsZUVycm9yKG1zZyk7XG5cblx0XHRcdGFzc2VydC5lcXVhbChyZXN1bHQsIHRydWUsIFwic2hvdWxkIHJldHJ5IHZpYSBjbGF1ZGUtY29kZSBmYWxsYmFja1wiKTtcblx0XHRcdGNvbnN0IHN3aXRjaEV2ZW50ID0gZW1pdHRlZEV2ZW50cy5maW5kKChlKSA9PiBlLnR5cGUgPT09IFwiZmFsbGJhY2tfcHJvdmlkZXJfc3dpdGNoXCIpO1xuXHRcdFx0YXNzZXJ0Lm9rKHN3aXRjaEV2ZW50LCBcIkV4cGVjdGVkIGZhbGxiYWNrX3Byb3ZpZGVyX3N3aXRjaCBldmVudFwiKTtcblx0XHRcdGFzc2VydC5vayhzd2l0Y2hFdmVudCEudG8uc3RhcnRzV2l0aChcImNsYXVkZS1jb2RlL1wiKSwgXCJTaG91bGQgc3dpdGNoIHRvIGNsYXVkZS1jb2RlIHByb3ZpZGVyXCIpO1xuXHRcdH0pO1xuXG5cdFx0aXQoXCJkb2VzIE5PVCBzd2l0Y2ggdG8gY2xhdWRlLWNvZGUgd2hlbiBjdXJyZW50IHByb3ZpZGVyIGlzIG5vdCBhbnRocm9waWNcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdFx0Y29uc3QgY2NNb2RlbCA9IGNyZWF0ZU1vY2tNb2RlbChcImNsYXVkZS1jb2RlXCIsIFwiZ3B0LTRvXCIpO1xuXHRcdFx0Y29uc3QgeyBkZXBzLCBlbWl0dGVkRXZlbnRzIH0gPSBjcmVhdGVNb2NrRGVwcyh7XG5cdFx0XHRcdG1vZGVsOiBjcmVhdGVNb2NrTW9kZWwoXCJvcGVuYWlcIiwgXCJncHQtNG9cIiksXG5cdFx0XHRcdGZpbmRNb2RlbFJlc3VsdDogKHByb3ZpZGVyOiBzdHJpbmcsIG1vZGVsSWQ6IHN0cmluZykgPT4ge1xuXHRcdFx0XHRcdGlmIChwcm92aWRlciA9PT0gXCJjbGF1ZGUtY29kZVwiICYmIG1vZGVsSWQgPT09IFwiZ3B0LTRvXCIpIHJldHVybiBjY01vZGVsO1xuXHRcdFx0XHRcdHJldHVybiB1bmRlZmluZWQ7XG5cdFx0XHRcdH0sXG5cdFx0XHR9KTtcblx0XHRcdGRlcHMuaXNDbGF1ZGVDb2RlUmVhZHkgPSAoKSA9PiB0cnVlO1xuXG5cdFx0XHRjb25zdCBoYW5kbGVyID0gbmV3IFJldHJ5SGFuZGxlcihkZXBzKTtcblx0XHRcdGNvbnN0IG1zZyA9IGVycm9yTWVzc2FnZShcInRoaXJkLXBhcnR5IGFwcHMgYXJlIG5vdCBzdXBwb3J0ZWQgZm9yIHRoaXMgcGxhblwiKTtcblxuXHRcdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlci5oYW5kbGVSZXRyeWFibGVFcnJvcihtc2cpO1xuXG5cdFx0XHQvLyBTaG91bGQgTk9UIGhhdmUgdHJpZ2dlcmVkIHRoZSBjbGF1ZGUtY29kZSBmYWxsYmFja1xuXHRcdFx0Y29uc3Qgc3dpdGNoRXZlbnQgPSBlbWl0dGVkRXZlbnRzLmZpbmQoXG5cdFx0XHRcdChlKSA9PiBlLnR5cGUgPT09IFwiZmFsbGJhY2tfcHJvdmlkZXJfc3dpdGNoXCIgJiYgZS50bz8uc3RhcnRzV2l0aChcImNsYXVkZS1jb2RlL1wiKSxcblx0XHRcdCk7XG5cdFx0XHRhc3NlcnQuZXF1YWwoc3dpdGNoRXZlbnQsIHVuZGVmaW5lZCwgXCJTaG91bGQgTk9UIHN3aXRjaCBub24tYW50aHJvcGljIHByb3ZpZGVyIHRvIGNsYXVkZS1jb2RlXCIpO1xuXHRcdH0pO1xuXHR9KTtcblxuXHRkZXNjcmliZShcInF1b3RhX2V4aGF1c3RlZCBjcmVkZW50aWFsIGJhY2tvZmYgKCMzNDMwKVwiLCAoKSA9PiB7XG5cdFx0aXQoXCJkb2VzIE5PVCBjYWxsIG1hcmtVc2FnZUxpbWl0UmVhY2hlZCBmb3IgcXVvdGFfZXhoYXVzdGVkIGVycm9yc1wiLCBhc3luYyAoKSA9PiB7XG5cdFx0XHQvLyBcIkV4dHJhIHVzYWdlIGlzIHJlcXVpcmVkXCIgaXMgYW4gYWNjb3VudC1sZXZlbCBiaWxsaW5nIGdhdGUuXG5cdFx0XHQvLyBCYWNraW5nIG9mZiB0aGUgY3JlZGVudGlhbCBmb3IgMzAgbWludXRlcyBibG9ja3MgYWxsIHByb3ZpZGVyXG5cdFx0XHQvLyByZXF1ZXN0cyBhbmQgaGFzIG5vIGVmZmVjdCBvbiB0aGUgYmlsbGluZyBjb25kaXRpb24uXG5cdFx0XHRjb25zdCB7IGRlcHMsIG1hcmtVc2FnZUxpbWl0UmVhY2hlZCB9ID0gY3JlYXRlTW9ja0RlcHMoe1xuXHRcdFx0XHRtb2RlbDogY3JlYXRlTW9ja01vZGVsKFwiYW50aHJvcGljXCIsIFwiY2xhdWRlLW9wdXMtNC02WzFtXVwiKSxcblx0XHRcdFx0bWFya1VzYWdlTGltaXRSZWFjaGVkUmVzdWx0OiBmYWxzZSxcblx0XHRcdFx0ZmFsbGJhY2tSZXN1bHQ6IG51bGwsXG5cdFx0XHRcdGZpbmRNb2RlbFJlc3VsdDogKCkgPT4gdW5kZWZpbmVkLFxuXHRcdFx0fSk7XG5cblx0XHRcdGNvbnN0IGhhbmRsZXIgPSBuZXcgUmV0cnlIYW5kbGVyKGRlcHMpO1xuXHRcdFx0Y29uc3QgbXNnID0gZXJyb3JNZXNzYWdlKFxuXHRcdFx0XHQnNDI5IHtcInR5cGVcIjpcImVycm9yXCIsXCJlcnJvclwiOntcInR5cGVcIjpcInJhdGVfbGltaXRfZXJyb3JcIixcIm1lc3NhZ2VcIjpcIkV4dHJhIHVzYWdlIGlzIHJlcXVpcmVkIGZvciBsb25nIGNvbnRleHQgcmVxdWVzdHMuXCJ9fScsXG5cdFx0XHQpO1xuXG5cdFx0XHRhd2FpdCBoYW5kbGVyLmhhbmRsZVJldHJ5YWJsZUVycm9yKG1zZyk7XG5cblx0XHRcdGFzc2VydC5lcXVhbChcblx0XHRcdFx0bWFya1VzYWdlTGltaXRSZWFjaGVkLm1vY2suY2FsbHMubGVuZ3RoLFxuXHRcdFx0XHQwLFxuXHRcdFx0XHRcIm1hcmtVc2FnZUxpbWl0UmVhY2hlZCBtdXN0IE5PVCBiZSBjYWxsZWQgZm9yIHF1b3RhX2V4aGF1c3RlZCBlcnJvcnNcIixcblx0XHRcdCk7XG5cdFx0fSk7XG5cblx0XHRpdChcInN0aWxsIGNhbGxzIG1hcmtVc2FnZUxpbWl0UmVhY2hlZCBmb3IgcmVndWxhciByYXRlX2xpbWl0IGVycm9yc1wiLCBhc3luYyAoKSA9PiB7XG5cdFx0XHRjb25zdCB7IGRlcHMsIG1hcmtVc2FnZUxpbWl0UmVhY2hlZCB9ID0gY3JlYXRlTW9ja0RlcHMoe1xuXHRcdFx0XHRtb2RlbDogY3JlYXRlTW9ja01vZGVsKFwiYW50aHJvcGljXCIsIFwiY2xhdWRlLW9wdXMtNC02XCIpLFxuXHRcdFx0XHRtYXJrVXNhZ2VMaW1pdFJlYWNoZWRSZXN1bHQ6IGZhbHNlLFxuXHRcdFx0XHRmYWxsYmFja1Jlc3VsdDogbnVsbCxcblx0XHRcdH0pO1xuXG5cdFx0XHRjb25zdCBoYW5kbGVyID0gbmV3IFJldHJ5SGFuZGxlcihkZXBzKTtcblx0XHRcdGNvbnN0IG1zZyA9IGVycm9yTWVzc2FnZShcIjQyOSBUb28gTWFueSBSZXF1ZXN0c1wiKTtcblxuXHRcdFx0YXdhaXQgaGFuZGxlci5oYW5kbGVSZXRyeWFibGVFcnJvcihtc2cpO1xuXG5cdFx0XHRhc3NlcnQuZXF1YWwoXG5cdFx0XHRcdG1hcmtVc2FnZUxpbWl0UmVhY2hlZC5tb2NrLmNhbGxzLmxlbmd0aCxcblx0XHRcdFx0MSxcblx0XHRcdFx0XCJtYXJrVXNhZ2VMaW1pdFJlYWNoZWQgc2hvdWxkIGJlIGNhbGxlZCBmb3IgcmF0ZV9saW1pdCBlcnJvcnNcIixcblx0XHRcdCk7XG5cdFx0fSk7XG5cblx0XHRpdChcInN0aWxsIHRyaWVzIGNyb3NzLXByb3ZpZGVyIGZhbGxiYWNrIGZvciBxdW90YV9leGhhdXN0ZWQgd2l0aG91dCBjcmVkZW50aWFsIGJhY2tvZmZcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdFx0Y29uc3QgZmFsbGJhY2tNb2RlbCA9IGNyZWF0ZU1vY2tNb2RlbChcIm9wZW5haVwiLCBcImdwdC00b1wiKTtcblx0XHRcdGNvbnN0IHsgZGVwcywgbWFya1VzYWdlTGltaXRSZWFjaGVkLCBjb250aW51ZUZuIH0gPSBjcmVhdGVNb2NrRGVwcyh7XG5cdFx0XHRcdG1vZGVsOiBjcmVhdGVNb2NrTW9kZWwoXCJhbnRocm9waWNcIiwgXCJjbGF1ZGUtb3B1cy00LTZbMW1dXCIpLFxuXHRcdFx0XHRtYXJrVXNhZ2VMaW1pdFJlYWNoZWRSZXN1bHQ6IGZhbHNlLFxuXHRcdFx0XHRmYWxsYmFja1Jlc3VsdDogeyBtb2RlbDogZmFsbGJhY2tNb2RlbCwgcmVhc29uOiBcImNyb3NzLXByb3ZpZGVyIGZhbGxiYWNrXCIgfSxcblx0XHRcdH0pO1xuXG5cdFx0XHRjb25zdCBoYW5kbGVyID0gbmV3IFJldHJ5SGFuZGxlcihkZXBzKTtcblx0XHRcdGNvbnN0IG1zZyA9IGVycm9yTWVzc2FnZShcIkV4dHJhIHVzYWdlIGlzIHJlcXVpcmVkIGZvciBsb25nIGNvbnRleHQgcmVxdWVzdHMuXCIpO1xuXG5cdFx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVyLmhhbmRsZVJldHJ5YWJsZUVycm9yKG1zZyk7XG5cblx0XHRcdGFzc2VydC5lcXVhbChyZXN1bHQsIHRydWUsIFwic2hvdWxkIHJldHJ5IHdpdGggZmFsbGJhY2sgcHJvdmlkZXJcIik7XG5cdFx0XHRhc3NlcnQuZXF1YWwoXG5cdFx0XHRcdG1hcmtVc2FnZUxpbWl0UmVhY2hlZC5tb2NrLmNhbGxzLmxlbmd0aCxcblx0XHRcdFx0MCxcblx0XHRcdFx0XCJzaG91bGQgTk9UIGJhY2sgb2ZmIGNyZWRlbnRpYWxzIGJlZm9yZSB0cnlpbmcgZmFsbGJhY2tcIixc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
