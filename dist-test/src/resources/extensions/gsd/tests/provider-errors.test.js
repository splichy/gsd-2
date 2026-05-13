import test from "node:test";
import assert from "node:assert/strict";
import { classifyError, isTransient, isTransientNetworkError } from "../error-classifier.js";
import { pauseAutoForProviderError } from "../provider-error-pause.js";
import { resumeAutoAfterProviderDelay } from "../bootstrap/provider-error-resume.js";
import { MAX_TRANSIENT_AUTO_RESUMES, resetTransientRetryState } from "../bootstrap/agent-end-recovery.js";
import { _buildCancelledUnitStopReason } from "../auto/phases.js";
import { getNextFallbackModel } from "../preferences.js";
import { RETRYABLE_ERROR_RE } from "../../../../../packages/pi-coding-agent/src/core/retryable-error-regex.js";
import { streamOpenAICodexResponses } from "../../../../../packages/pi-ai/src/providers/openai-codex-responses.js";
test("classifyError detects rate limit from 429", () => {
  const result = classifyError("HTTP 429 Too Many Requests");
  assert.ok(isTransient(result));
  assert.equal(result.kind, "rate-limit");
  assert.ok("retryAfterMs" in result && result.retryAfterMs > 0);
});
test("classifyError detects rate limit from message", () => {
  const result = classifyError("rate limit exceeded");
  assert.ok(isTransient(result));
  assert.equal(result.kind, "rate-limit");
});
test("classifyError treats Anthropic quota-window phrasing as transient rate-limit (#4373)", () => {
  const result = classifyError("You've hit your limit \xB7 resets soon");
  assert.ok(isTransient(result));
  assert.equal(result.kind, "rate-limit");
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 6e4);
});
test("classifyError treats usage-limit phrasing as transient rate-limit (#4373)", () => {
  const result = classifyError("usage limit reached for this workspace");
  assert.ok(isTransient(result));
  assert.equal(result.kind, "rate-limit");
});
test("classifyError treats extra-usage phrasing as transient rate-limit (#4397)", () => {
  const result = classifyError("You are out of extra usage. Please wait before retrying.");
  assert.ok(isTransient(result));
  assert.equal(result.kind, "rate-limit");
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 6e4);
});
test("classifyError treats OpenRouter affordability errors as transient rate-limit class", () => {
  const result = classifyError(
    "402 This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 329."
  );
  assert.ok(isTransient(result));
  assert.equal(result.kind, "rate-limit");
  assert.ok("retryAfterMs" in result && result.retryAfterMs > 0);
});
test("classifyError extracts reset delay from message", () => {
  const result = classifyError("rate limit exceeded, reset in 45s");
  assert.equal(result.kind, "rate-limit");
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 45e3);
});
test("classifyError defaults to 60s for rate limit without reset", () => {
  const result = classifyError("429 too many requests");
  assert.equal(result.kind, "rate-limit");
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 6e4);
});
test("classifyError treats stream_exhausted_without_result as transient connection failure", () => {
  const result = classifyError("stream_exhausted_without_result");
  assert.ok(isTransient(result));
  assert.equal(result.kind, "connection");
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 15e3);
});
test("classifyError detects Anthropic internal server error", () => {
  const msg = '{"type":"error","error":{"details":null,"type":"api_error","message":"Internal server error"}}';
  const result = classifyError(msg);
  assert.ok(isTransient(result));
  assert.equal(result.kind, "server");
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 3e4);
});
test("classifyError detects Codex server_error from extracted message", () => {
  const msg = "Codex server_error: An error occurred while processing your request.";
  const result = classifyError(msg);
  assert.ok(isTransient(result));
  assert.equal(result.kind, "server");
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 3e4);
});
test("classifyError detects stream INTERNAL_ERROR received from peer as transient server", () => {
  const result = classifyError("stream error: stream ID 75; INTERNAL_ERROR; received from peer");
  assert.ok(isTransient(result));
  assert.equal(result.kind, "server");
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 3e4);
});
test("classifyError detects overloaded error", () => {
  const result = classifyError("overloaded_error: Overloaded");
  assert.ok(isTransient(result));
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 3e4);
});
test("classifyError detects 503 service unavailable", () => {
  const result = classifyError("HTTP 503 Service Unavailable");
  assert.ok(isTransient(result));
});
test("classifyError detects 502 bad gateway", () => {
  const result = classifyError("HTTP 502 Bad Gateway");
  assert.ok(isTransient(result));
});
test("classifyError detects auth error as permanent", () => {
  const result = classifyError("unauthorized: invalid API key");
  assert.ok(!isTransient(result));
  assert.equal(result.kind, "permanent");
});
test("classifyError detects billing error as permanent", () => {
  const result = classifyError("billing issue: payment required");
  assert.ok(!isTransient(result));
});
test("classifyError detects quota exceeded as permanent", () => {
  const result = classifyError("quota exceeded for this month");
  assert.ok(!isTransient(result));
});
test("classifyError treats plain 'Connection error.' as transient connection failure (#3594)", () => {
  const result = classifyError("Connection error.");
  assert.ok(isTransient(result));
  assert.equal(result.kind, "connection");
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 15e3);
});
test("classifyError treats unknown error as not transient", () => {
  const result = classifyError("something went wrong");
  assert.ok(!isTransient(result));
  assert.equal(result.kind, "unknown");
});
test("classifyError treats empty string as not transient", () => {
  const result = classifyError("");
  assert.ok(!isTransient(result));
});
test("classifyError: rate limit takes precedence over auth keywords", () => {
  const result = classifyError("429 unauthorized rate limit");
  assert.equal(result.kind, "rate-limit");
  assert.ok(isTransient(result));
});
test("classifyError: Codex ChatGPT-account entitlement rejection is unsupported-model", () => {
  const result = classifyError(
    "The 'gpt-5.1-codex-max' model is not supported when using Codex with a ChatGPT account."
  );
  assert.equal(result.kind, "unsupported-model");
  assert.ok(!isTransient(result));
});
test("classifyError: 'model not available for this plan' is unsupported-model", () => {
  const result = classifyError("This model is not available for your current plan.");
  assert.equal(result.kind, "unsupported-model");
});
test("classifyError: 'account does not have access to model' is unsupported-model", () => {
  const result = classifyError("Your account does not have access to the gpt-5 model.");
  assert.equal(result.kind, "unsupported-model");
});
test("classifyError: 'tier does not support deployment' is unsupported-model", () => {
  const result = classifyError("The free tier does not support this deployment.");
  assert.equal(result.kind, "unsupported-model");
});
test("classifyError: 'account suspended' stays permanent (not unsupported-model)", () => {
  const result = classifyError("Your account has been suspended. Contact support.");
  assert.equal(result.kind, "permanent");
});
test("classifyError: 'invalid account' stays permanent", () => {
  const result = classifyError("invalid account credentials");
  assert.equal(result.kind, "permanent");
});
test("classifyError: rate limit on unsupported-model phrasing stays rate-limit", () => {
  const result = classifyError(
    "429 rate limit \u2014 model not supported when using your account right now"
  );
  assert.equal(result.kind, "rate-limit");
});
test("classifyError: 'Expected comma/brace after property value in JSON' is transient stream", () => {
  const result = classifyError(
    "Expected ',' or '}' after property value in JSON at position 2056 (line 1 column 2057)"
  );
  assert.equal(result.kind, "stream");
  assert.ok(isTransient(result));
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 15e3);
});
test("classifyError: 'Expected colon after property name in JSON' is transient stream", () => {
  const result = classifyError(
    "Expected ':' after property name in JSON at position 500 (line 1 column 501)"
  );
  assert.equal(result.kind, "stream");
  assert.ok(isTransient(result));
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 15e3);
});
test("classifyError: 'Expected property name or brace in JSON' is transient stream", () => {
  const result = classifyError(
    "Expected property name or '}' in JSON at position 42 (line 1 column 43)"
  );
  assert.equal(result.kind, "stream");
  assert.ok(isTransient(result));
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 15e3);
});
test("classifyError: 'Unterminated string in JSON' is transient stream", () => {
  const result = classifyError(
    "Unterminated string in JSON at position 100 (line 1 column 101)"
  );
  assert.equal(result.kind, "stream");
  assert.ok(isTransient(result));
  assert.ok("retryAfterMs" in result && result.retryAfterMs === 15e3);
});
test("isTransientNetworkError detects ECONNRESET", () => {
  assert.ok(isTransientNetworkError("fetch failed: ECONNRESET"));
});
test("isTransientNetworkError detects ETIMEDOUT", () => {
  assert.ok(isTransientNetworkError("ETIMEDOUT: request timed out"));
});
test("isTransientNetworkError detects generic network error", () => {
  assert.ok(isTransientNetworkError("network error"));
});
test("isTransientNetworkError detects socket hang up", () => {
  assert.ok(isTransientNetworkError("socket hang up"));
});
test("isTransientNetworkError detects fetch failed", () => {
  assert.ok(isTransientNetworkError("fetch failed"));
});
test("isTransientNetworkError detects connection reset", () => {
  assert.ok(isTransientNetworkError("connection was reset by peer"));
});
test("isTransientNetworkError detects DNS errors", () => {
  assert.ok(isTransientNetworkError("dns resolution failed"));
});
test("isTransientNetworkError detects unexpected EOF", () => {
  assert.ok(isTransientNetworkError("unexpected EOF"));
});
test("isTransientNetworkError rejects auth errors", () => {
  assert.ok(!isTransientNetworkError("unauthorized: invalid API key"));
});
test("isTransientNetworkError rejects quota errors", () => {
  assert.ok(!isTransientNetworkError("quota exceeded"));
});
test("isTransientNetworkError rejects billing errors", () => {
  assert.ok(!isTransientNetworkError("billing issue: network payment required"));
});
test("isTransientNetworkError rejects empty string", () => {
  assert.ok(!isTransientNetworkError(""));
});
test("isTransientNetworkError rejects non-network errors", () => {
  assert.ok(!isTransientNetworkError("model not found"));
});
test("getNextFallbackModel selects next fallback if current is a fallback", () => {
  const modelConfig = { primary: "model-a", fallbacks: ["model-b", "model-c"] };
  assert.equal(getNextFallbackModel("model-b", modelConfig), "model-c");
});
test("getNextFallbackModel returns undefined if fallbacks exhausted", () => {
  const modelConfig = { primary: "model-a", fallbacks: ["model-b", "model-c"] };
  assert.equal(getNextFallbackModel("model-c", modelConfig), void 0);
});
test("getNextFallbackModel finds current model with provider prefix", () => {
  const modelConfig = { primary: "p/model-a", fallbacks: ["p/model-b"] };
  assert.equal(getNextFallbackModel("model-a", modelConfig), "p/model-b");
});
test("getNextFallbackModel returns primary if current is unknown", () => {
  const modelConfig = { primary: "model-a", fallbacks: ["model-b", "model-c"] };
  assert.equal(getNextFallbackModel("model-x", modelConfig), "model-a");
});
test("getNextFallbackModel returns primary if current is undefined", () => {
  const modelConfig = { primary: "model-a", fallbacks: ["model-b", "model-c"] };
  assert.equal(getNextFallbackModel(void 0, modelConfig), "model-a");
});
test("pauseAutoForProviderError warns and pauses without requiring ctx.log", async () => {
  const notifications = [];
  let pauseCalls = 0;
  await pauseAutoForProviderError(
    { notify(message, level) {
      notifications.push({ message, level: level ?? "info" });
    } },
    ": terminated",
    async () => {
      pauseCalls += 1;
    }
  );
  assert.equal(pauseCalls, 1);
  assert.deepEqual(notifications, [
    { message: "Auto-mode paused due to provider error: terminated", level: "warning" }
  ]);
});
test("pauseAutoForProviderError schedules auto-resume for rate limit errors", async () => {
  const notifications = [];
  let pauseCalls = 0;
  let resumeCalled = false;
  const originalSetTimeout = globalThis.setTimeout;
  const timers = [];
  globalThis.setTimeout = ((fn, delay) => {
    timers.push({ fn, delay });
    return 0;
  });
  try {
    await pauseAutoForProviderError(
      { notify(message, level) {
        notifications.push({ message, level: level ?? "info" });
      } },
      ": rate limit exceeded",
      async () => {
        pauseCalls += 1;
      },
      { isRateLimit: true, retryAfterMs: 9e4, resume: () => {
        resumeCalled = true;
      } }
    );
    assert.equal(pauseCalls, 1);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 9e4);
    assert.deepEqual(notifications[0], {
      message: "Rate limited: rate limit exceeded. Auto-resuming in 90s...",
      level: "warning"
    });
    timers[0].fn();
    assert.equal(resumeCalled, true);
    assert.deepEqual(notifications[1], {
      message: "Rate limit window elapsed. Resuming auto-mode.",
      level: "info"
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});
test("pauseAutoForProviderError falls back to indefinite pause when not rate limit", async () => {
  const notifications = [];
  let pauseCalls = 0;
  await pauseAutoForProviderError(
    { notify(message, level) {
      notifications.push({ message, level: level ?? "info" });
    } },
    ": connection refused",
    async () => {
      pauseCalls += 1;
    },
    { isRateLimit: false }
  );
  assert.equal(pauseCalls, 1);
  assert.deepEqual(notifications, [
    { message: "Auto-mode paused due to provider error: connection refused", level: "warning" }
  ]);
});
test("resumeAutoAfterProviderDelay restarts paused auto-mode from the recorded base path", async () => {
  const startCalls = [];
  const result = await resumeAutoAfterProviderDelay(
    {},
    { ui: { notify() {
    } } },
    {
      getSnapshot: () => ({
        active: false,
        paused: true,
        stepMode: true,
        basePath: "/tmp/project"
      }),
      resetTransientRetryState: () => {
      },
      startAuto: async (_ctx, _pi, base, verboseMode, options) => {
        startCalls.push({ base, verboseMode, step: options?.step });
      }
    }
  );
  assert.equal(result, "resumed");
  assert.deepEqual(startCalls, [
    { base: "/tmp/project", verboseMode: false, step: true }
  ]);
});
test("resumeAutoAfterProviderDelay does not double-start when auto-mode is already active", async () => {
  let startCalls = 0;
  const result = await resumeAutoAfterProviderDelay(
    {},
    { ui: { notify() {
    } } },
    {
      getSnapshot: () => ({
        active: true,
        paused: false,
        stepMode: false,
        basePath: "/tmp/project"
      }),
      resetTransientRetryState: () => {
      },
      startAuto: async () => {
        startCalls += 1;
      }
    }
  );
  assert.equal(result, "already-active");
  assert.equal(startCalls, 0);
});
test("resumeAutoAfterProviderDelay leaves auto paused when no base path is available", async () => {
  const notifications = [];
  let startCalls = 0;
  const result = await resumeAutoAfterProviderDelay(
    {},
    {
      ui: {
        notify(message, level) {
          notifications.push({ message, level: level ?? "info" });
        }
      }
    },
    {
      getSnapshot: () => ({
        active: false,
        paused: true,
        stepMode: false,
        basePath: ""
      }),
      resetTransientRetryState: () => {
      },
      startAuto: async () => {
        startCalls += 1;
      }
    }
  );
  assert.equal(result, "missing-base");
  assert.equal(startCalls, 0);
  assert.deepEqual(notifications, [
    {
      message: "Provider error recovery delay elapsed, but no paused auto-mode base path was available. Leaving auto-mode paused.",
      level: "warning"
    }
  ]);
});
test("resumeAutoAfterProviderDelay resets provider retry state without clearing session-timeout attempts", async () => {
  const calls = [];
  const result = await resumeAutoAfterProviderDelay(
    {},
    { ui: { notify() {
    } } },
    {
      getSnapshot: () => ({
        active: false,
        paused: true,
        stepMode: false,
        basePath: "/tmp/project"
      }),
      resetTransientRetryState: () => {
        calls.push("reset-transient");
      },
      startAuto: async () => {
        calls.push("start-auto");
      }
    }
  );
  assert.equal(result, "resumed");
  assert.deepEqual(calls, [
    "reset-transient",
    "start-auto"
  ]);
});
test("resetTransientRetryState is callable by resume recovery", () => {
  resetTransientRetryState();
  assert.equal(classifyError("stream_exhausted_without_result").kind, "connection");
});
test("cancelled unit stop reason differentiates session startup failures", () => {
  assert.deepEqual(
    _buildCancelledUnitStopReason("plan-slice", "S01", {
      category: "session-failed",
      message: "Session creation timed out"
    }),
    {
      notifyMessage: "Session creation failed for plan-slice S01: Session creation timed out. Stopping auto-mode.",
      stopReason: "Session creation failed: Session creation timed out",
      loopReason: "session-failed"
    }
  );
  assert.deepEqual(
    _buildCancelledUnitStopReason("execute-task", "T01", {
      category: "aborted",
      message: "Request aborted by user"
    }),
    {
      notifyMessage: "Unit execute-task T01 aborted after dispatch: Request aborted by user. Stopping auto-mode.",
      stopReason: "Unit aborted: Request aborted by user",
      loopReason: "unit-aborted"
    }
  );
});
test("openai-codex response stream surfaces nested error type and message", async () => {
  const originalFetch = globalThis.fetch;
  const tokenPayload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" }
  })).toString("base64");
  const apiKey = `header.${tokenPayload}.signature`;
  globalThis.fetch = (async () => new Response(
    'data: {"type":"error","error":{"type":"server_error","code":"server_error","message":"upstream failed"}}\n\n',
    { status: 200, headers: { "content-type": "text/event-stream" } }
  ));
  try {
    const stream = streamOpenAICodexResponses(
      {
        provider: "openai-codex-responses",
        id: "gpt-5.1-codex",
        baseUrl: "https://codex.example.test"
      },
      { messages: [], systemPrompt: "", tools: [] },
      { apiKey }
    );
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }
    const errorEvent = events.find((event) => event.type === "error");
    assert.ok(errorEvent, "stream should emit an error event");
    assert.equal(errorEvent.error.errorMessage, "Codex server_error: upstream failed");
    assert.equal(classifyError(errorEvent.error.errorMessage).kind, "server");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("MAX_TRANSIENT_AUTO_RESUMES is at least 8 for sustained overload resilience", () => {
  assert.ok(
    MAX_TRANSIENT_AUTO_RESUMES >= 8,
    `MAX_TRANSIENT_AUTO_RESUMES must be >= 8 for sustained overload resilience, got ${MAX_TRANSIENT_AUTO_RESUMES}`
  );
});
test("classifyError: 'Stream idle timeout - partial response received' is transient network", () => {
  const result = classifyError("API Error: Stream idle timeout - partial response received");
  assert.ok(isTransient(result), "stream idle timeout must be transient");
  assert.equal(result.kind, "network");
  assert.ok("retryAfterMs" in result && result.retryAfterMs > 0);
});
test("classifyError: 'stream idle timeout' (lowercase) is transient network", () => {
  const result = classifyError("stream idle timeout");
  assert.ok(isTransient(result), "lowercase stream idle timeout must be transient");
  assert.equal(result.kind, "network");
});
test("classifyError: 'partial response received' alone is transient network", () => {
  const result = classifyError("partial response received");
  assert.ok(isTransient(result), "partial response received must be transient");
  assert.equal(result.kind, "network");
});
test("classifyError: MiniMax context window error is transient server", () => {
  const result = classifyError("400 invalid params, context window exceeds limit (2013)");
  assert.ok(isTransient(result), "context window exceeded must be transient");
  assert.equal(result.kind, "server");
});
test("classifyError: 'context length exceeded' is transient server", () => {
  const result = classifyError("context length exceeded: max 128000 tokens");
  assert.ok(isTransient(result), "context length exceeded must be transient");
  assert.equal(result.kind, "server");
});
test("classifyError: 'context window' with 'exceed' is transient server", () => {
  const result = classifyError("context window exceeded for this model");
  assert.ok(isTransient(result), "context window exceeded must be transient");
  assert.equal(result.kind, "server");
});
test("agent-session retryable error regex matches server_error (underscore)", () => {
  assert.ok(RETRYABLE_ERROR_RE.test("Codex server_error: An error occurred"));
  assert.ok(RETRYABLE_ERROR_RE.test("server error occurred"));
  assert.ok(RETRYABLE_ERROR_RE.test("internal_error: something went wrong"));
  assert.ok(RETRYABLE_ERROR_RE.test("internal error"));
  assert.ok(!RETRYABLE_ERROR_RE.test("model not found"));
  assert.ok(!RETRYABLE_ERROR_RE.test("temporarily backed off"));
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wcm92aWRlci1lcnJvcnMudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBQcm92aWRlciBlcnJvciBoYW5kbGluZyB0ZXN0cyBcdTIwMTQgY29uc29saWRhdGVkIGZyb206XG4gKiAgIC0gcHJvdmlkZXItZXJyb3ItY2xhc3NpZnkudGVzdC50cyAoY2xhc3NpZnlFcnJvcilcbiAqICAgLSBuZXR3b3JrLWVycm9yLWZhbGxiYWNrLnRlc3QudHMgKGlzVHJhbnNpZW50TmV0d29ya0Vycm9yLCBnZXROZXh0RmFsbGJhY2tNb2RlbClcbiAqICAgLSBhZ2VudC1lbmQtcHJvdmlkZXItZXJyb3IudGVzdC50cyAocGF1c2VBdXRvRm9yUHJvdmlkZXJFcnJvcilcbiAqL1xuXG5pbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IGNsYXNzaWZ5RXJyb3IsIGlzVHJhbnNpZW50LCBpc1RyYW5zaWVudE5ldHdvcmtFcnJvciB9IGZyb20gXCIuLi9lcnJvci1jbGFzc2lmaWVyLnRzXCI7XG5pbXBvcnQgeyBwYXVzZUF1dG9Gb3JQcm92aWRlckVycm9yIH0gZnJvbSBcIi4uL3Byb3ZpZGVyLWVycm9yLXBhdXNlLnRzXCI7XG5pbXBvcnQgeyByZXN1bWVBdXRvQWZ0ZXJQcm92aWRlckRlbGF5IH0gZnJvbSBcIi4uL2Jvb3RzdHJhcC9wcm92aWRlci1lcnJvci1yZXN1bWUudHNcIjtcbmltcG9ydCB7IE1BWF9UUkFOU0lFTlRfQVVUT19SRVNVTUVTLCByZXNldFRyYW5zaWVudFJldHJ5U3RhdGUgfSBmcm9tIFwiLi4vYm9vdHN0cmFwL2FnZW50LWVuZC1yZWNvdmVyeS50c1wiO1xuaW1wb3J0IHsgX2J1aWxkQ2FuY2VsbGVkVW5pdFN0b3BSZWFzb24gfSBmcm9tIFwiLi4vYXV0by9waGFzZXMudHNcIjtcbmltcG9ydCB7IGdldE5leHRGYWxsYmFja01vZGVsIH0gZnJvbSBcIi4uL3ByZWZlcmVuY2VzLnRzXCI7XG4vLyBaZXJvLWltcG9ydCBtb2R1bGUgXHUyMDE0IGltcG9ydGVkIGJ5IHBhdGggcmF0aGVyIHRoYW4gdGhyb3VnaCB0aGUgcGFja2FnZVxuLy8gYmFycmVsIHRvIGF2b2lkIHB1bGxpbmcgdGhlIGZ1bGwgQWdlbnRTZXNzaW9uIC8gQGdzZC9waS1haSBkZXAgZ3JhcGggaW50b1xuLy8gdGhpcyB1bml0IHRlc3QgKHNlZSAjNDgzNykuXG5pbXBvcnQgeyBSRVRSWUFCTEVfRVJST1JfUkUgfSBmcm9tIFwiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL3JldHJ5YWJsZS1lcnJvci1yZWdleC50c1wiO1xuaW1wb3J0IHsgc3RyZWFtT3BlbkFJQ29kZXhSZXNwb25zZXMgfSBmcm9tIFwiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWkvc3JjL3Byb3ZpZGVycy9vcGVuYWktY29kZXgtcmVzcG9uc2VzLnRzXCI7XG5cbi8vIFx1MjUwMFx1MjUwMCBjbGFzc2lmeUVycm9yIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiY2xhc3NpZnlFcnJvciBkZXRlY3RzIHJhdGUgbGltaXQgZnJvbSA0MjlcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBjbGFzc2lmeUVycm9yKFwiSFRUUCA0MjkgVG9vIE1hbnkgUmVxdWVzdHNcIik7XG4gIGFzc2VydC5vayhpc1RyYW5zaWVudChyZXN1bHQpKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5raW5kLCBcInJhdGUtbGltaXRcIik7XG4gIGFzc2VydC5vayhcInJldHJ5QWZ0ZXJNc1wiIGluIHJlc3VsdCAmJiByZXN1bHQucmV0cnlBZnRlck1zID4gMCk7XG59KTtcblxudGVzdChcImNsYXNzaWZ5RXJyb3IgZGV0ZWN0cyByYXRlIGxpbWl0IGZyb20gbWVzc2FnZVwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IGNsYXNzaWZ5RXJyb3IoXCJyYXRlIGxpbWl0IGV4Y2VlZGVkXCIpO1xuICBhc3NlcnQub2soaXNUcmFuc2llbnQocmVzdWx0KSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQua2luZCwgXCJyYXRlLWxpbWl0XCIpO1xufSk7XG5cbnRlc3QoXCJjbGFzc2lmeUVycm9yIHRyZWF0cyBBbnRocm9waWMgcXVvdGEtd2luZG93IHBocmFzaW5nIGFzIHRyYW5zaWVudCByYXRlLWxpbWl0ICgjNDM3MylcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBjbGFzc2lmeUVycm9yKFwiWW91J3ZlIGhpdCB5b3VyIGxpbWl0IFx1MDBCNyByZXNldHMgc29vblwiKTtcbiAgYXNzZXJ0Lm9rKGlzVHJhbnNpZW50KHJlc3VsdCkpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LmtpbmQsIFwicmF0ZS1saW1pdFwiKTtcbiAgYXNzZXJ0Lm9rKFwicmV0cnlBZnRlck1zXCIgaW4gcmVzdWx0ICYmIHJlc3VsdC5yZXRyeUFmdGVyTXMgPT09IDYwXzAwMCk7XG59KTtcblxudGVzdChcImNsYXNzaWZ5RXJyb3IgdHJlYXRzIHVzYWdlLWxpbWl0IHBocmFzaW5nIGFzIHRyYW5zaWVudCByYXRlLWxpbWl0ICgjNDM3MylcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBjbGFzc2lmeUVycm9yKFwidXNhZ2UgbGltaXQgcmVhY2hlZCBmb3IgdGhpcyB3b3Jrc3BhY2VcIik7XG4gIGFzc2VydC5vayhpc1RyYW5zaWVudChyZXN1bHQpKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5raW5kLCBcInJhdGUtbGltaXRcIik7XG59KTtcblxudGVzdChcImNsYXNzaWZ5RXJyb3IgdHJlYXRzIGV4dHJhLXVzYWdlIHBocmFzaW5nIGFzIHRyYW5zaWVudCByYXRlLWxpbWl0ICgjNDM5NylcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBjbGFzc2lmeUVycm9yKFwiWW91IGFyZSBvdXQgb2YgZXh0cmEgdXNhZ2UuIFBsZWFzZSB3YWl0IGJlZm9yZSByZXRyeWluZy5cIik7XG4gIGFzc2VydC5vayhpc1RyYW5zaWVudChyZXN1bHQpKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5raW5kLCBcInJhdGUtbGltaXRcIik7XG4gIGFzc2VydC5vayhcInJldHJ5QWZ0ZXJNc1wiIGluIHJlc3VsdCAmJiByZXN1bHQucmV0cnlBZnRlck1zID09PSA2MF8wMDApO1xufSk7XG5cbnRlc3QoXCJjbGFzc2lmeUVycm9yIHRyZWF0cyBPcGVuUm91dGVyIGFmZm9yZGFiaWxpdHkgZXJyb3JzIGFzIHRyYW5zaWVudCByYXRlLWxpbWl0IGNsYXNzXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gY2xhc3NpZnlFcnJvcihcbiAgICBcIjQwMiBUaGlzIHJlcXVlc3QgcmVxdWlyZXMgbW9yZSBjcmVkaXRzLCBvciBmZXdlciBtYXhfdG9rZW5zLiBZb3UgcmVxdWVzdGVkIHVwIHRvIDMyMDAwIHRva2VucywgYnV0IGNhbiBvbmx5IGFmZm9yZCAzMjkuXCIsXG4gICk7XG4gIGFzc2VydC5vayhpc1RyYW5zaWVudChyZXN1bHQpKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5raW5kLCBcInJhdGUtbGltaXRcIik7XG4gIGFzc2VydC5vayhcInJldHJ5QWZ0ZXJNc1wiIGluIHJlc3VsdCAmJiByZXN1bHQucmV0cnlBZnRlck1zID4gMCk7XG59KTtcblxudGVzdChcImNsYXNzaWZ5RXJyb3IgZXh0cmFjdHMgcmVzZXQgZGVsYXkgZnJvbSBtZXNzYWdlXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gY2xhc3NpZnlFcnJvcihcInJhdGUgbGltaXQgZXhjZWVkZWQsIHJlc2V0IGluIDQ1c1wiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5raW5kLCBcInJhdGUtbGltaXRcIik7XG4gIGFzc2VydC5vayhcInJldHJ5QWZ0ZXJNc1wiIGluIHJlc3VsdCAmJiByZXN1bHQucmV0cnlBZnRlck1zID09PSA0NTAwMCk7XG59KTtcblxudGVzdChcImNsYXNzaWZ5RXJyb3IgZGVmYXVsdHMgdG8gNjBzIGZvciByYXRlIGxpbWl0IHdpdGhvdXQgcmVzZXRcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBjbGFzc2lmeUVycm9yKFwiNDI5IHRvbyBtYW55IHJlcXVlc3RzXCIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LmtpbmQsIFwicmF0ZS1saW1pdFwiKTtcbiAgYXNzZXJ0Lm9rKFwicmV0cnlBZnRlck1zXCIgaW4gcmVzdWx0ICYmIHJlc3VsdC5yZXRyeUFmdGVyTXMgPT09IDYwXzAwMCk7XG59KTtcblxudGVzdChcImNsYXNzaWZ5RXJyb3IgdHJlYXRzIHN0cmVhbV9leGhhdXN0ZWRfd2l0aG91dF9yZXN1bHQgYXMgdHJhbnNpZW50IGNvbm5lY3Rpb24gZmFpbHVyZVwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IGNsYXNzaWZ5RXJyb3IoXCJzdHJlYW1fZXhoYXVzdGVkX3dpdGhvdXRfcmVzdWx0XCIpO1xuICBhc3NlcnQub2soaXNUcmFuc2llbnQocmVzdWx0KSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQua2luZCwgXCJjb25uZWN0aW9uXCIpO1xuICBhc3NlcnQub2soXCJyZXRyeUFmdGVyTXNcIiBpbiByZXN1bHQgJiYgcmVzdWx0LnJldHJ5QWZ0ZXJNcyA9PT0gMTVfMDAwKTtcbn0pO1xuXG50ZXN0KFwiY2xhc3NpZnlFcnJvciBkZXRlY3RzIEFudGhyb3BpYyBpbnRlcm5hbCBzZXJ2ZXIgZXJyb3JcIiwgKCkgPT4ge1xuICBjb25zdCBtc2cgPSAne1widHlwZVwiOlwiZXJyb3JcIixcImVycm9yXCI6e1wiZGV0YWlsc1wiOm51bGwsXCJ0eXBlXCI6XCJhcGlfZXJyb3JcIixcIm1lc3NhZ2VcIjpcIkludGVybmFsIHNlcnZlciBlcnJvclwifX0nO1xuICBjb25zdCByZXN1bHQgPSBjbGFzc2lmeUVycm9yKG1zZyk7XG4gIGFzc2VydC5vayhpc1RyYW5zaWVudChyZXN1bHQpKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5raW5kLCBcInNlcnZlclwiKTtcbiAgYXNzZXJ0Lm9rKFwicmV0cnlBZnRlck1zXCIgaW4gcmVzdWx0ICYmIHJlc3VsdC5yZXRyeUFmdGVyTXMgPT09IDMwXzAwMCk7XG59KTtcblxudGVzdChcImNsYXNzaWZ5RXJyb3IgZGV0ZWN0cyBDb2RleCBzZXJ2ZXJfZXJyb3IgZnJvbSBleHRyYWN0ZWQgbWVzc2FnZVwiLCAoKSA9PiB7XG4gIC8vIEFmdGVyIGZpeCwgbWFwQ29kZXhFdmVudHMgZXh0cmFjdHMgdGhlIG5lc3RlZCBlcnJvciB0eXBlIGFuZCBwcm9kdWNlc1xuICAvLyBcIkNvZGV4IHNlcnZlcl9lcnJvcjogPG1lc3NhZ2U+XCIgaW5zdGVhZCBvZiByYXcgSlNPTi5cbiAgY29uc3QgbXNnID0gXCJDb2RleCBzZXJ2ZXJfZXJyb3I6IEFuIGVycm9yIG9jY3VycmVkIHdoaWxlIHByb2Nlc3NpbmcgeW91ciByZXF1ZXN0LlwiO1xuICBjb25zdCByZXN1bHQgPSBjbGFzc2lmeUVycm9yKG1zZyk7XG4gIGFzc2VydC5vayhpc1RyYW5zaWVudChyZXN1bHQpKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5raW5kLCBcInNlcnZlclwiKTtcbiAgYXNzZXJ0Lm9rKFwicmV0cnlBZnRlck1zXCIgaW4gcmVzdWx0ICYmIHJlc3VsdC5yZXRyeUFmdGVyTXMgPT09IDMwXzAwMCk7XG59KTtcblxudGVzdChcImNsYXNzaWZ5RXJyb3IgZGV0ZWN0cyBzdHJlYW0gSU5URVJOQUxfRVJST1IgcmVjZWl2ZWQgZnJvbSBwZWVyIGFzIHRyYW5zaWVudCBzZXJ2ZXJcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBjbGFzc2lmeUVycm9yKFwic3RyZWFtIGVycm9yOiBzdHJlYW0gSUQgNzU7IElOVEVSTkFMX0VSUk9SOyByZWNlaXZlZCBmcm9tIHBlZXJcIik7XG4gIGFzc2VydC5vayhpc1RyYW5zaWVudChyZXN1bHQpKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5raW5kLCBcInNlcnZlclwiKTtcbiAgYXNzZXJ0Lm9rKFwicmV0cnlBZnRlck1zXCIgaW4gcmVzdWx0ICYmIHJlc3VsdC5yZXRyeUFmdGVyTXMgPT09IDMwXzAwMCk7XG59KTtcblxudGVzdChcImNsYXNzaWZ5RXJyb3IgZGV0ZWN0cyBvdmVybG9hZGVkIGVycm9yXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gY2xhc3NpZnlFcnJvcihcIm92ZXJsb2FkZWRfZXJyb3I6IE92ZXJsb2FkZWRcIik7XG4gIGFzc2VydC5vayhpc1RyYW5zaWVudChyZXN1bHQpKTtcbiAgYXNzZXJ0Lm9rKFwicmV0cnlBZnRlck1zXCIgaW4gcmVzdWx0ICYmIHJlc3VsdC5yZXRyeUFmdGVyTXMgPT09IDMwXzAwMCk7XG59KTtcblxudGVzdChcImNsYXNzaWZ5RXJyb3IgZGV0ZWN0cyA1MDMgc2VydmljZSB1bmF2YWlsYWJsZVwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IGNsYXNzaWZ5RXJyb3IoXCJIVFRQIDUwMyBTZXJ2aWNlIFVuYXZhaWxhYmxlXCIpO1xuICBhc3NlcnQub2soaXNUcmFuc2llbnQocmVzdWx0KSk7XG59KTtcblxudGVzdChcImNsYXNzaWZ5RXJyb3IgZGV0ZWN0cyA1MDIgYmFkIGdhdGV3YXlcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBjbGFzc2lmeUVycm9yKFwiSFRUUCA1MDIgQmFkIEdhdGV3YXlcIik7XG4gIGFzc2VydC5vayhpc1RyYW5zaWVudChyZXN1bHQpKTtcbn0pO1xuXG50ZXN0KFwiY2xhc3NpZnlFcnJvciBkZXRlY3RzIGF1dGggZXJyb3IgYXMgcGVybWFuZW50XCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gY2xhc3NpZnlFcnJvcihcInVuYXV0aG9yaXplZDogaW52YWxpZCBBUEkga2V5XCIpO1xuICBhc3NlcnQub2soIWlzVHJhbnNpZW50KHJlc3VsdCkpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LmtpbmQsIFwicGVybWFuZW50XCIpO1xufSk7XG5cbnRlc3QoXCJjbGFzc2lmeUVycm9yIGRldGVjdHMgYmlsbGluZyBlcnJvciBhcyBwZXJtYW5lbnRcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBjbGFzc2lmeUVycm9yKFwiYmlsbGluZyBpc3N1ZTogcGF5bWVudCByZXF1aXJlZFwiKTtcbiAgYXNzZXJ0Lm9rKCFpc1RyYW5zaWVudChyZXN1bHQpKTtcbn0pO1xuXG50ZXN0KFwiY2xhc3NpZnlFcnJvciBkZXRlY3RzIHF1b3RhIGV4Y2VlZGVkIGFzIHBlcm1hbmVudFwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IGNsYXNzaWZ5RXJyb3IoXCJxdW90YSBleGNlZWRlZCBmb3IgdGhpcyBtb250aFwiKTtcbiAgYXNzZXJ0Lm9rKCFpc1RyYW5zaWVudChyZXN1bHQpKTtcbn0pO1xuXG50ZXN0KFwiY2xhc3NpZnlFcnJvciB0cmVhdHMgcGxhaW4gJ0Nvbm5lY3Rpb24gZXJyb3IuJyBhcyB0cmFuc2llbnQgY29ubmVjdGlvbiBmYWlsdXJlICgjMzU5NClcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBjbGFzc2lmeUVycm9yKFwiQ29ubmVjdGlvbiBlcnJvci5cIik7XG4gIGFzc2VydC5vayhpc1RyYW5zaWVudChyZXN1bHQpKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5raW5kLCBcImNvbm5lY3Rpb25cIik7XG4gIGFzc2VydC5vayhcInJldHJ5QWZ0ZXJNc1wiIGluIHJlc3VsdCAmJiByZXN1bHQucmV0cnlBZnRlck1zID09PSAxNV8wMDApO1xufSk7XG5cbnRlc3QoXCJjbGFzc2lmeUVycm9yIHRyZWF0cyB1bmtub3duIGVycm9yIGFzIG5vdCB0cmFuc2llbnRcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBjbGFzc2lmeUVycm9yKFwic29tZXRoaW5nIHdlbnQgd3JvbmdcIik7XG4gIGFzc2VydC5vayghaXNUcmFuc2llbnQocmVzdWx0KSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQua2luZCwgXCJ1bmtub3duXCIpO1xufSk7XG5cbnRlc3QoXCJjbGFzc2lmeUVycm9yIHRyZWF0cyBlbXB0eSBzdHJpbmcgYXMgbm90IHRyYW5zaWVudFwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IGNsYXNzaWZ5RXJyb3IoXCJcIik7XG4gIGFzc2VydC5vayghaXNUcmFuc2llbnQocmVzdWx0KSk7XG59KTtcblxudGVzdChcImNsYXNzaWZ5RXJyb3I6IHJhdGUgbGltaXQgdGFrZXMgcHJlY2VkZW5jZSBvdmVyIGF1dGgga2V5d29yZHNcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBjbGFzc2lmeUVycm9yKFwiNDI5IHVuYXV0aG9yaXplZCByYXRlIGxpbWl0XCIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LmtpbmQsIFwicmF0ZS1saW1pdFwiKTtcbiAgYXNzZXJ0Lm9rKGlzVHJhbnNpZW50KHJlc3VsdCkpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMCB1bnN1cHBvcnRlZC1tb2RlbDogYWNjb3VudC9wbGFuIGVudGl0bGVtZW50IHJlamVjdGlvbiAoIzQ1MTMpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiY2xhc3NpZnlFcnJvcjogQ29kZXggQ2hhdEdQVC1hY2NvdW50IGVudGl0bGVtZW50IHJlamVjdGlvbiBpcyB1bnN1cHBvcnRlZC1tb2RlbFwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IGNsYXNzaWZ5RXJyb3IoXG4gICAgXCJUaGUgJ2dwdC01LjEtY29kZXgtbWF4JyBtb2RlbCBpcyBub3Qgc3VwcG9ydGVkIHdoZW4gdXNpbmcgQ29kZXggd2l0aCBhIENoYXRHUFQgYWNjb3VudC5cIixcbiAgKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5raW5kLCBcInVuc3VwcG9ydGVkLW1vZGVsXCIpO1xuICBhc3NlcnQub2soIWlzVHJhbnNpZW50KHJlc3VsdCkpO1xufSk7XG5cbnRlc3QoXCJjbGFzc2lmeUVycm9yOiAnbW9kZWwgbm90IGF2YWlsYWJsZSBmb3IgdGhpcyBwbGFuJyBpcyB1bnN1cHBvcnRlZC1tb2RlbFwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IGNsYXNzaWZ5RXJyb3IoXCJUaGlzIG1vZGVsIGlzIG5vdCBhdmFpbGFibGUgZm9yIHlvdXIgY3VycmVudCBwbGFuLlwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5raW5kLCBcInVuc3VwcG9ydGVkLW1vZGVsXCIpO1xufSk7XG5cbnRlc3QoXCJjbGFzc2lmeUVycm9yOiAnYWNjb3VudCBkb2VzIG5vdCBoYXZlIGFjY2VzcyB0byBtb2RlbCcgaXMgdW5zdXBwb3J0ZWQtbW9kZWxcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBjbGFzc2lmeUVycm9yKFwiWW91ciBhY2NvdW50IGRvZXMgbm90IGhhdmUgYWNjZXNzIHRvIHRoZSBncHQtNSBtb2RlbC5cIik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQua2luZCwgXCJ1bnN1cHBvcnRlZC1tb2RlbFwiKTtcbn0pO1xuXG50ZXN0KFwiY2xhc3NpZnlFcnJvcjogJ3RpZXIgZG9lcyBub3Qgc3VwcG9ydCBkZXBsb3ltZW50JyBpcyB1bnN1cHBvcnRlZC1tb2RlbFwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IGNsYXNzaWZ5RXJyb3IoXCJUaGUgZnJlZSB0aWVyIGRvZXMgbm90IHN1cHBvcnQgdGhpcyBkZXBsb3ltZW50LlwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5raW5kLCBcInVuc3VwcG9ydGVkLW1vZGVsXCIpO1xufSk7XG5cbnRlc3QoXCJjbGFzc2lmeUVycm9yOiAnYWNjb3VudCBzdXNwZW5kZWQnIHN0YXlzIHBlcm1hbmVudCAobm90IHVuc3VwcG9ydGVkLW1vZGVsKVwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IGNsYXNzaWZ5RXJyb3IoXCJZb3VyIGFjY291bnQgaGFzIGJlZW4gc3VzcGVuZGVkLiBDb250YWN0IHN1cHBvcnQuXCIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LmtpbmQsIFwicGVybWFuZW50XCIpO1xufSk7XG5cbnRlc3QoXCJjbGFzc2lmeUVycm9yOiAnaW52YWxpZCBhY2NvdW50JyBzdGF5cyBwZXJtYW5lbnRcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBjbGFzc2lmeUVycm9yKFwiaW52YWxpZCBhY2NvdW50IGNyZWRlbnRpYWxzXCIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LmtpbmQsIFwicGVybWFuZW50XCIpO1xufSk7XG5cbnRlc3QoXCJjbGFzc2lmeUVycm9yOiByYXRlIGxpbWl0IG9uIHVuc3VwcG9ydGVkLW1vZGVsIHBocmFzaW5nIHN0YXlzIHJhdGUtbGltaXRcIiwgKCkgPT4ge1xuICAvLyBBIHRocm90dGxlZCBhY2NvdW50IGlzIG5vdCBhbiBlbnRpdGxlbWVudCBmYWlsdXJlLlxuICBjb25zdCByZXN1bHQgPSBjbGFzc2lmeUVycm9yKFxuICAgIFwiNDI5IHJhdGUgbGltaXQgXHUyMDE0IG1vZGVsIG5vdCBzdXBwb3J0ZWQgd2hlbiB1c2luZyB5b3VyIGFjY291bnQgcmlnaHQgbm93XCIsXG4gICk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQua2luZCwgXCJyYXRlLWxpbWl0XCIpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMCBTVFJFQU1fUkU6IFY4IEpTT04gcGFyc2UgZXJyb3IgdmFyaWFudHMgKCMyOTE2KSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcImNsYXNzaWZ5RXJyb3I6ICdFeHBlY3RlZCBjb21tYS9icmFjZSBhZnRlciBwcm9wZXJ0eSB2YWx1ZSBpbiBKU09OJyBpcyB0cmFuc2llbnQgc3RyZWFtXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gY2xhc3NpZnlFcnJvcihcbiAgICBcIkV4cGVjdGVkICcsJyBvciAnfScgYWZ0ZXIgcHJvcGVydHkgdmFsdWUgaW4gSlNPTiBhdCBwb3NpdGlvbiAyMDU2IChsaW5lIDEgY29sdW1uIDIwNTcpXCJcbiAgKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5raW5kLCBcInN0cmVhbVwiKTtcbiAgYXNzZXJ0Lm9rKGlzVHJhbnNpZW50KHJlc3VsdCkpO1xuICBhc3NlcnQub2soXCJyZXRyeUFmdGVyTXNcIiBpbiByZXN1bHQgJiYgcmVzdWx0LnJldHJ5QWZ0ZXJNcyA9PT0gMTVfMDAwKTtcbn0pO1xuXG50ZXN0KFwiY2xhc3NpZnlFcnJvcjogJ0V4cGVjdGVkIGNvbG9uIGFmdGVyIHByb3BlcnR5IG5hbWUgaW4gSlNPTicgaXMgdHJhbnNpZW50IHN0cmVhbVwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IGNsYXNzaWZ5RXJyb3IoXG4gICAgXCJFeHBlY3RlZCAnOicgYWZ0ZXIgcHJvcGVydHkgbmFtZSBpbiBKU09OIGF0IHBvc2l0aW9uIDUwMCAobGluZSAxIGNvbHVtbiA1MDEpXCJcbiAgKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5raW5kLCBcInN0cmVhbVwiKTtcbiAgYXNzZXJ0Lm9rKGlzVHJhbnNpZW50KHJlc3VsdCkpO1xuICBhc3NlcnQub2soXCJyZXRyeUFmdGVyTXNcIiBpbiByZXN1bHQgJiYgcmVzdWx0LnJldHJ5QWZ0ZXJNcyA9PT0gMTVfMDAwKTtcbn0pO1xuXG50ZXN0KFwiY2xhc3NpZnlFcnJvcjogJ0V4cGVjdGVkIHByb3BlcnR5IG5hbWUgb3IgYnJhY2UgaW4gSlNPTicgaXMgdHJhbnNpZW50IHN0cmVhbVwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IGNsYXNzaWZ5RXJyb3IoXG4gICAgXCJFeHBlY3RlZCBwcm9wZXJ0eSBuYW1lIG9yICd9JyBpbiBKU09OIGF0IHBvc2l0aW9uIDQyIChsaW5lIDEgY29sdW1uIDQzKVwiXG4gICk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQua2luZCwgXCJzdHJlYW1cIik7XG4gIGFzc2VydC5vayhpc1RyYW5zaWVudChyZXN1bHQpKTtcbiAgYXNzZXJ0Lm9rKFwicmV0cnlBZnRlck1zXCIgaW4gcmVzdWx0ICYmIHJlc3VsdC5yZXRyeUFmdGVyTXMgPT09IDE1XzAwMCk7XG59KTtcblxudGVzdChcImNsYXNzaWZ5RXJyb3I6ICdVbnRlcm1pbmF0ZWQgc3RyaW5nIGluIEpTT04nIGlzIHRyYW5zaWVudCBzdHJlYW1cIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBjbGFzc2lmeUVycm9yKFxuICAgIFwiVW50ZXJtaW5hdGVkIHN0cmluZyBpbiBKU09OIGF0IHBvc2l0aW9uIDEwMCAobGluZSAxIGNvbHVtbiAxMDEpXCJcbiAgKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5raW5kLCBcInN0cmVhbVwiKTtcbiAgYXNzZXJ0Lm9rKGlzVHJhbnNpZW50KHJlc3VsdCkpO1xuICBhc3NlcnQub2soXCJyZXRyeUFmdGVyTXNcIiBpbiByZXN1bHQgJiYgcmVzdWx0LnJldHJ5QWZ0ZXJNcyA9PT0gMTVfMDAwKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDAgaXNUcmFuc2llbnROZXR3b3JrRXJyb3IgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJpc1RyYW5zaWVudE5ldHdvcmtFcnJvciBkZXRlY3RzIEVDT05OUkVTRVRcIiwgKCkgPT4ge1xuICBhc3NlcnQub2soaXNUcmFuc2llbnROZXR3b3JrRXJyb3IoXCJmZXRjaCBmYWlsZWQ6IEVDT05OUkVTRVRcIikpO1xufSk7XG5cbnRlc3QoXCJpc1RyYW5zaWVudE5ldHdvcmtFcnJvciBkZXRlY3RzIEVUSU1FRE9VVFwiLCAoKSA9PiB7XG4gIGFzc2VydC5vayhpc1RyYW5zaWVudE5ldHdvcmtFcnJvcihcIkVUSU1FRE9VVDogcmVxdWVzdCB0aW1lZCBvdXRcIikpO1xufSk7XG5cbnRlc3QoXCJpc1RyYW5zaWVudE5ldHdvcmtFcnJvciBkZXRlY3RzIGdlbmVyaWMgbmV0d29yayBlcnJvclwiLCAoKSA9PiB7XG4gIGFzc2VydC5vayhpc1RyYW5zaWVudE5ldHdvcmtFcnJvcihcIm5ldHdvcmsgZXJyb3JcIikpO1xufSk7XG5cbnRlc3QoXCJpc1RyYW5zaWVudE5ldHdvcmtFcnJvciBkZXRlY3RzIHNvY2tldCBoYW5nIHVwXCIsICgpID0+IHtcbiAgYXNzZXJ0Lm9rKGlzVHJhbnNpZW50TmV0d29ya0Vycm9yKFwic29ja2V0IGhhbmcgdXBcIikpO1xufSk7XG5cbnRlc3QoXCJpc1RyYW5zaWVudE5ldHdvcmtFcnJvciBkZXRlY3RzIGZldGNoIGZhaWxlZFwiLCAoKSA9PiB7XG4gIGFzc2VydC5vayhpc1RyYW5zaWVudE5ldHdvcmtFcnJvcihcImZldGNoIGZhaWxlZFwiKSk7XG59KTtcblxudGVzdChcImlzVHJhbnNpZW50TmV0d29ya0Vycm9yIGRldGVjdHMgY29ubmVjdGlvbiByZXNldFwiLCAoKSA9PiB7XG4gIGFzc2VydC5vayhpc1RyYW5zaWVudE5ldHdvcmtFcnJvcihcImNvbm5lY3Rpb24gd2FzIHJlc2V0IGJ5IHBlZXJcIikpO1xufSk7XG5cbnRlc3QoXCJpc1RyYW5zaWVudE5ldHdvcmtFcnJvciBkZXRlY3RzIEROUyBlcnJvcnNcIiwgKCkgPT4ge1xuICBhc3NlcnQub2soaXNUcmFuc2llbnROZXR3b3JrRXJyb3IoXCJkbnMgcmVzb2x1dGlvbiBmYWlsZWRcIikpO1xufSk7XG5cbnRlc3QoXCJpc1RyYW5zaWVudE5ldHdvcmtFcnJvciBkZXRlY3RzIHVuZXhwZWN0ZWQgRU9GXCIsICgpID0+IHtcbiAgYXNzZXJ0Lm9rKGlzVHJhbnNpZW50TmV0d29ya0Vycm9yKFwidW5leHBlY3RlZCBFT0ZcIikpO1xufSk7XG5cbnRlc3QoXCJpc1RyYW5zaWVudE5ldHdvcmtFcnJvciByZWplY3RzIGF1dGggZXJyb3JzXCIsICgpID0+IHtcbiAgYXNzZXJ0Lm9rKCFpc1RyYW5zaWVudE5ldHdvcmtFcnJvcihcInVuYXV0aG9yaXplZDogaW52YWxpZCBBUEkga2V5XCIpKTtcbn0pO1xuXG50ZXN0KFwiaXNUcmFuc2llbnROZXR3b3JrRXJyb3IgcmVqZWN0cyBxdW90YSBlcnJvcnNcIiwgKCkgPT4ge1xuICBhc3NlcnQub2soIWlzVHJhbnNpZW50TmV0d29ya0Vycm9yKFwicXVvdGEgZXhjZWVkZWRcIikpO1xufSk7XG5cbnRlc3QoXCJpc1RyYW5zaWVudE5ldHdvcmtFcnJvciByZWplY3RzIGJpbGxpbmcgZXJyb3JzXCIsICgpID0+IHtcbiAgYXNzZXJ0Lm9rKCFpc1RyYW5zaWVudE5ldHdvcmtFcnJvcihcImJpbGxpbmcgaXNzdWU6IG5ldHdvcmsgcGF5bWVudCByZXF1aXJlZFwiKSk7XG59KTtcblxudGVzdChcImlzVHJhbnNpZW50TmV0d29ya0Vycm9yIHJlamVjdHMgZW1wdHkgc3RyaW5nXCIsICgpID0+IHtcbiAgYXNzZXJ0Lm9rKCFpc1RyYW5zaWVudE5ldHdvcmtFcnJvcihcIlwiKSk7XG59KTtcblxudGVzdChcImlzVHJhbnNpZW50TmV0d29ya0Vycm9yIHJlamVjdHMgbm9uLW5ldHdvcmsgZXJyb3JzXCIsICgpID0+IHtcbiAgYXNzZXJ0Lm9rKCFpc1RyYW5zaWVudE5ldHdvcmtFcnJvcihcIm1vZGVsIG5vdCBmb3VuZFwiKSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwIGdldE5leHRGYWxsYmFja01vZGVsIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiZ2V0TmV4dEZhbGxiYWNrTW9kZWwgc2VsZWN0cyBuZXh0IGZhbGxiYWNrIGlmIGN1cnJlbnQgaXMgYSBmYWxsYmFja1wiLCAoKSA9PiB7XG4gIGNvbnN0IG1vZGVsQ29uZmlnID0geyBwcmltYXJ5OiBcIm1vZGVsLWFcIiwgZmFsbGJhY2tzOiBbXCJtb2RlbC1iXCIsIFwibW9kZWwtY1wiXSB9O1xuICBhc3NlcnQuZXF1YWwoZ2V0TmV4dEZhbGxiYWNrTW9kZWwoXCJtb2RlbC1iXCIsIG1vZGVsQ29uZmlnKSwgXCJtb2RlbC1jXCIpO1xufSk7XG5cbnRlc3QoXCJnZXROZXh0RmFsbGJhY2tNb2RlbCByZXR1cm5zIHVuZGVmaW5lZCBpZiBmYWxsYmFja3MgZXhoYXVzdGVkXCIsICgpID0+IHtcbiAgY29uc3QgbW9kZWxDb25maWcgPSB7IHByaW1hcnk6IFwibW9kZWwtYVwiLCBmYWxsYmFja3M6IFtcIm1vZGVsLWJcIiwgXCJtb2RlbC1jXCJdIH07XG4gIGFzc2VydC5lcXVhbChnZXROZXh0RmFsbGJhY2tNb2RlbChcIm1vZGVsLWNcIiwgbW9kZWxDb25maWcpLCB1bmRlZmluZWQpO1xufSk7XG5cbnRlc3QoXCJnZXROZXh0RmFsbGJhY2tNb2RlbCBmaW5kcyBjdXJyZW50IG1vZGVsIHdpdGggcHJvdmlkZXIgcHJlZml4XCIsICgpID0+IHtcbiAgY29uc3QgbW9kZWxDb25maWcgPSB7IHByaW1hcnk6IFwicC9tb2RlbC1hXCIsIGZhbGxiYWNrczogW1wicC9tb2RlbC1iXCJdIH07XG4gIGFzc2VydC5lcXVhbChnZXROZXh0RmFsbGJhY2tNb2RlbChcIm1vZGVsLWFcIiwgbW9kZWxDb25maWcpLCBcInAvbW9kZWwtYlwiKTtcbn0pO1xuXG50ZXN0KFwiZ2V0TmV4dEZhbGxiYWNrTW9kZWwgcmV0dXJucyBwcmltYXJ5IGlmIGN1cnJlbnQgaXMgdW5rbm93blwiLCAoKSA9PiB7XG4gIGNvbnN0IG1vZGVsQ29uZmlnID0geyBwcmltYXJ5OiBcIm1vZGVsLWFcIiwgZmFsbGJhY2tzOiBbXCJtb2RlbC1iXCIsIFwibW9kZWwtY1wiXSB9O1xuICBhc3NlcnQuZXF1YWwoZ2V0TmV4dEZhbGxiYWNrTW9kZWwoXCJtb2RlbC14XCIsIG1vZGVsQ29uZmlnKSwgXCJtb2RlbC1hXCIpO1xufSk7XG5cbnRlc3QoXCJnZXROZXh0RmFsbGJhY2tNb2RlbCByZXR1cm5zIHByaW1hcnkgaWYgY3VycmVudCBpcyB1bmRlZmluZWRcIiwgKCkgPT4ge1xuICBjb25zdCBtb2RlbENvbmZpZyA9IHsgcHJpbWFyeTogXCJtb2RlbC1hXCIsIGZhbGxiYWNrczogW1wibW9kZWwtYlwiLCBcIm1vZGVsLWNcIl0gfTtcbiAgYXNzZXJ0LmVxdWFsKGdldE5leHRGYWxsYmFja01vZGVsKHVuZGVmaW5lZCwgbW9kZWxDb25maWcpLCBcIm1vZGVsLWFcIik7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwIHBhdXNlQXV0b0ZvclByb3ZpZGVyRXJyb3IgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJwYXVzZUF1dG9Gb3JQcm92aWRlckVycm9yIHdhcm5zIGFuZCBwYXVzZXMgd2l0aG91dCByZXF1aXJpbmcgY3R4LmxvZ1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IG5vdGlmaWNhdGlvbnM6IEFycmF5PHsgbWVzc2FnZTogc3RyaW5nOyBsZXZlbDogc3RyaW5nIH0+ID0gW107XG4gIGxldCBwYXVzZUNhbGxzID0gMDtcblxuICBhd2FpdCBwYXVzZUF1dG9Gb3JQcm92aWRlckVycm9yKFxuICAgIHsgbm90aWZ5KG1lc3NhZ2UsIGxldmVsPykgeyBub3RpZmljYXRpb25zLnB1c2goeyBtZXNzYWdlLCBsZXZlbDogbGV2ZWwgPz8gXCJpbmZvXCIgfSk7IH0gfSxcbiAgICBcIjogdGVybWluYXRlZFwiLFxuICAgIGFzeW5jICgpID0+IHsgcGF1c2VDYWxscyArPSAxOyB9LFxuICApO1xuXG4gIGFzc2VydC5lcXVhbChwYXVzZUNhbGxzLCAxKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChub3RpZmljYXRpb25zLCBbXG4gICAgeyBtZXNzYWdlOiBcIkF1dG8tbW9kZSBwYXVzZWQgZHVlIHRvIHByb3ZpZGVyIGVycm9yOiB0ZXJtaW5hdGVkXCIsIGxldmVsOiBcIndhcm5pbmdcIiB9LFxuICBdKTtcbn0pO1xuXG50ZXN0KFwicGF1c2VBdXRvRm9yUHJvdmlkZXJFcnJvciBzY2hlZHVsZXMgYXV0by1yZXN1bWUgZm9yIHJhdGUgbGltaXQgZXJyb3JzXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3Qgbm90aWZpY2F0aW9uczogQXJyYXk8eyBtZXNzYWdlOiBzdHJpbmc7IGxldmVsOiBzdHJpbmcgfT4gPSBbXTtcbiAgbGV0IHBhdXNlQ2FsbHMgPSAwO1xuICBsZXQgcmVzdW1lQ2FsbGVkID0gZmFsc2U7XG5cbiAgY29uc3Qgb3JpZ2luYWxTZXRUaW1lb3V0ID0gZ2xvYmFsVGhpcy5zZXRUaW1lb3V0O1xuICBjb25zdCB0aW1lcnM6IEFycmF5PHsgZm46ICgpID0+IHZvaWQ7IGRlbGF5OiBudW1iZXIgfT4gPSBbXTtcbiAgZ2xvYmFsVGhpcy5zZXRUaW1lb3V0ID0gKChmbjogKCkgPT4gdm9pZCwgZGVsYXk6IG51bWJlcikgPT4ge1xuICAgIHRpbWVycy5wdXNoKHsgZm4sIGRlbGF5IH0pO1xuICAgIHJldHVybiAwIGFzIHVua25vd24gYXMgUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD47XG4gIH0pIGFzIHR5cGVvZiBzZXRUaW1lb3V0O1xuXG4gIHRyeSB7XG4gICAgYXdhaXQgcGF1c2VBdXRvRm9yUHJvdmlkZXJFcnJvcihcbiAgICAgIHsgbm90aWZ5KG1lc3NhZ2UsIGxldmVsPykgeyBub3RpZmljYXRpb25zLnB1c2goeyBtZXNzYWdlLCBsZXZlbDogbGV2ZWwgPz8gXCJpbmZvXCIgfSk7IH0gfSxcbiAgICAgIFwiOiByYXRlIGxpbWl0IGV4Y2VlZGVkXCIsXG4gICAgICBhc3luYyAoKSA9PiB7IHBhdXNlQ2FsbHMgKz0gMTsgfSxcbiAgICAgIHsgaXNSYXRlTGltaXQ6IHRydWUsIHJldHJ5QWZ0ZXJNczogOTAwMDAsIHJlc3VtZTogKCkgPT4geyByZXN1bWVDYWxsZWQgPSB0cnVlOyB9IH0sXG4gICAgKTtcblxuICAgIGFzc2VydC5lcXVhbChwYXVzZUNhbGxzLCAxKTtcbiAgICBhc3NlcnQuZXF1YWwodGltZXJzLmxlbmd0aCwgMSk7XG4gICAgYXNzZXJ0LmVxdWFsKHRpbWVyc1swXS5kZWxheSwgOTAwMDApO1xuICAgIGFzc2VydC5kZWVwRXF1YWwobm90aWZpY2F0aW9uc1swXSwge1xuICAgICAgbWVzc2FnZTogXCJSYXRlIGxpbWl0ZWQ6IHJhdGUgbGltaXQgZXhjZWVkZWQuIEF1dG8tcmVzdW1pbmcgaW4gOTBzLi4uXCIsXG4gICAgICBsZXZlbDogXCJ3YXJuaW5nXCIsXG4gICAgfSk7XG5cbiAgICB0aW1lcnNbMF0uZm4oKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdW1lQ2FsbGVkLCB0cnVlKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKG5vdGlmaWNhdGlvbnNbMV0sIHtcbiAgICAgIG1lc3NhZ2U6IFwiUmF0ZSBsaW1pdCB3aW5kb3cgZWxhcHNlZC4gUmVzdW1pbmcgYXV0by1tb2RlLlwiLFxuICAgICAgbGV2ZWw6IFwiaW5mb1wiLFxuICAgIH0pO1xuICB9IGZpbmFsbHkge1xuICAgIGdsb2JhbFRoaXMuc2V0VGltZW91dCA9IG9yaWdpbmFsU2V0VGltZW91dDtcbiAgfVxufSk7XG5cbnRlc3QoXCJwYXVzZUF1dG9Gb3JQcm92aWRlckVycm9yIGZhbGxzIGJhY2sgdG8gaW5kZWZpbml0ZSBwYXVzZSB3aGVuIG5vdCByYXRlIGxpbWl0XCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3Qgbm90aWZpY2F0aW9uczogQXJyYXk8eyBtZXNzYWdlOiBzdHJpbmc7IGxldmVsOiBzdHJpbmcgfT4gPSBbXTtcbiAgbGV0IHBhdXNlQ2FsbHMgPSAwO1xuXG4gIGF3YWl0IHBhdXNlQXV0b0ZvclByb3ZpZGVyRXJyb3IoXG4gICAgeyBub3RpZnkobWVzc2FnZSwgbGV2ZWw/KSB7IG5vdGlmaWNhdGlvbnMucHVzaCh7IG1lc3NhZ2UsIGxldmVsOiBsZXZlbCA/PyBcImluZm9cIiB9KTsgfSB9LFxuICAgIFwiOiBjb25uZWN0aW9uIHJlZnVzZWRcIixcbiAgICBhc3luYyAoKSA9PiB7IHBhdXNlQ2FsbHMgKz0gMTsgfSxcbiAgICB7IGlzUmF0ZUxpbWl0OiBmYWxzZSB9LFxuICApO1xuXG4gIGFzc2VydC5lcXVhbChwYXVzZUNhbGxzLCAxKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChub3RpZmljYXRpb25zLCBbXG4gICAgeyBtZXNzYWdlOiBcIkF1dG8tbW9kZSBwYXVzZWQgZHVlIHRvIHByb3ZpZGVyIGVycm9yOiBjb25uZWN0aW9uIHJlZnVzZWRcIiwgbGV2ZWw6IFwid2FybmluZ1wiIH0sXG4gIF0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMCByZXN1bWVBdXRvQWZ0ZXJQcm92aWRlckRlbGF5IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwicmVzdW1lQXV0b0FmdGVyUHJvdmlkZXJEZWxheSByZXN0YXJ0cyBwYXVzZWQgYXV0by1tb2RlIGZyb20gdGhlIHJlY29yZGVkIGJhc2UgcGF0aFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHN0YXJ0Q2FsbHM6IEFycmF5PHsgYmFzZTogc3RyaW5nOyB2ZXJib3NlTW9kZTogYm9vbGVhbjsgc3RlcD86IGJvb2xlYW4gfT4gPSBbXTtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVzdW1lQXV0b0FmdGVyUHJvdmlkZXJEZWxheShcbiAgICB7fSBhcyBhbnksXG4gICAgeyB1aTogeyBub3RpZnkoKSB7fSB9IH0gYXMgYW55LFxuICAgIHtcbiAgICAgIGdldFNuYXBzaG90OiAoKSA9PiAoe1xuICAgICAgICBhY3RpdmU6IGZhbHNlLFxuICAgICAgICBwYXVzZWQ6IHRydWUsXG4gICAgICAgIHN0ZXBNb2RlOiB0cnVlLFxuICAgICAgICBiYXNlUGF0aDogXCIvdG1wL3Byb2plY3RcIixcbiAgICAgIH0pLFxuICAgICAgcmVzZXRUcmFuc2llbnRSZXRyeVN0YXRlOiAoKSA9PiB7fSxcbiAgICAgIHN0YXJ0QXV0bzogYXN5bmMgKF9jdHgsIF9waSwgYmFzZSwgdmVyYm9zZU1vZGUsIG9wdGlvbnMpID0+IHtcbiAgICAgICAgc3RhcnRDYWxscy5wdXNoKHsgYmFzZSwgdmVyYm9zZU1vZGUsIHN0ZXA6IG9wdGlvbnM/LnN0ZXAgfSk7XG4gICAgICB9LFxuICAgIH0sXG4gICk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgXCJyZXN1bWVkXCIpO1xuICBhc3NlcnQuZGVlcEVxdWFsKHN0YXJ0Q2FsbHMsIFtcbiAgICB7IGJhc2U6IFwiL3RtcC9wcm9qZWN0XCIsIHZlcmJvc2VNb2RlOiBmYWxzZSwgc3RlcDogdHJ1ZSB9LFxuICBdKTtcbn0pO1xuXG50ZXN0KFwicmVzdW1lQXV0b0FmdGVyUHJvdmlkZXJEZWxheSBkb2VzIG5vdCBkb3VibGUtc3RhcnQgd2hlbiBhdXRvLW1vZGUgaXMgYWxyZWFkeSBhY3RpdmVcIiwgYXN5bmMgKCkgPT4ge1xuICBsZXQgc3RhcnRDYWxscyA9IDA7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlc3VtZUF1dG9BZnRlclByb3ZpZGVyRGVsYXkoXG4gICAge30gYXMgYW55LFxuICAgIHsgdWk6IHsgbm90aWZ5KCkge30gfSB9IGFzIGFueSxcbiAgICB7XG4gICAgICBnZXRTbmFwc2hvdDogKCkgPT4gKHtcbiAgICAgICAgYWN0aXZlOiB0cnVlLFxuICAgICAgICBwYXVzZWQ6IGZhbHNlLFxuICAgICAgICBzdGVwTW9kZTogZmFsc2UsXG4gICAgICAgIGJhc2VQYXRoOiBcIi90bXAvcHJvamVjdFwiLFxuICAgICAgfSksXG4gICAgICByZXNldFRyYW5zaWVudFJldHJ5U3RhdGU6ICgpID0+IHt9LFxuICAgICAgc3RhcnRBdXRvOiBhc3luYyAoKSA9PiB7XG4gICAgICAgIHN0YXJ0Q2FsbHMgKz0gMTtcbiAgICAgIH0sXG4gICAgfSxcbiAgKTtcblxuICBhc3NlcnQuZXF1YWwocmVzdWx0LCBcImFscmVhZHktYWN0aXZlXCIpO1xuICBhc3NlcnQuZXF1YWwoc3RhcnRDYWxscywgMCk7XG59KTtcblxudGVzdChcInJlc3VtZUF1dG9BZnRlclByb3ZpZGVyRGVsYXkgbGVhdmVzIGF1dG8gcGF1c2VkIHdoZW4gbm8gYmFzZSBwYXRoIGlzIGF2YWlsYWJsZVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IG5vdGlmaWNhdGlvbnM6IEFycmF5PHsgbWVzc2FnZTogc3RyaW5nOyBsZXZlbDogc3RyaW5nIH0+ID0gW107XG4gIGxldCBzdGFydENhbGxzID0gMDtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXN1bWVBdXRvQWZ0ZXJQcm92aWRlckRlbGF5KFxuICAgIHt9IGFzIGFueSxcbiAgICB7XG4gICAgICB1aToge1xuICAgICAgICBub3RpZnkobWVzc2FnZTogc3RyaW5nLCBsZXZlbD86IHN0cmluZykge1xuICAgICAgICAgIG5vdGlmaWNhdGlvbnMucHVzaCh7IG1lc3NhZ2UsIGxldmVsOiBsZXZlbCA/PyBcImluZm9cIiB9KTtcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgfSBhcyBhbnksXG4gICAge1xuICAgICAgZ2V0U25hcHNob3Q6ICgpID0+ICh7XG4gICAgICAgIGFjdGl2ZTogZmFsc2UsXG4gICAgICAgIHBhdXNlZDogdHJ1ZSxcbiAgICAgICAgc3RlcE1vZGU6IGZhbHNlLFxuICAgICAgICBiYXNlUGF0aDogXCJcIixcbiAgICAgIH0pLFxuICAgICAgcmVzZXRUcmFuc2llbnRSZXRyeVN0YXRlOiAoKSA9PiB7fSxcbiAgICAgIHN0YXJ0QXV0bzogYXN5bmMgKCkgPT4ge1xuICAgICAgICBzdGFydENhbGxzICs9IDE7XG4gICAgICB9LFxuICAgIH0sXG4gICk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgXCJtaXNzaW5nLWJhc2VcIik7XG4gIGFzc2VydC5lcXVhbChzdGFydENhbGxzLCAwKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChub3RpZmljYXRpb25zLCBbXG4gICAge1xuICAgICAgbWVzc2FnZTogXCJQcm92aWRlciBlcnJvciByZWNvdmVyeSBkZWxheSBlbGFwc2VkLCBidXQgbm8gcGF1c2VkIGF1dG8tbW9kZSBiYXNlIHBhdGggd2FzIGF2YWlsYWJsZS4gTGVhdmluZyBhdXRvLW1vZGUgcGF1c2VkLlwiLFxuICAgICAgbGV2ZWw6IFwid2FybmluZ1wiLFxuICAgIH0sXG4gIF0pO1xufSk7XG5cbnRlc3QoXCJyZXN1bWVBdXRvQWZ0ZXJQcm92aWRlckRlbGF5IHJlc2V0cyBwcm92aWRlciByZXRyeSBzdGF0ZSB3aXRob3V0IGNsZWFyaW5nIHNlc3Npb24tdGltZW91dCBhdHRlbXB0c1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGNhbGxzOiBzdHJpbmdbXSA9IFtdO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlc3VtZUF1dG9BZnRlclByb3ZpZGVyRGVsYXkoXG4gICAge30gYXMgYW55LFxuICAgIHsgdWk6IHsgbm90aWZ5KCkge30gfSB9IGFzIGFueSxcbiAgICB7XG4gICAgICBnZXRTbmFwc2hvdDogKCkgPT4gKHtcbiAgICAgICAgYWN0aXZlOiBmYWxzZSxcbiAgICAgICAgcGF1c2VkOiB0cnVlLFxuICAgICAgICBzdGVwTW9kZTogZmFsc2UsXG4gICAgICAgIGJhc2VQYXRoOiBcIi90bXAvcHJvamVjdFwiLFxuICAgICAgfSksXG4gICAgICByZXNldFRyYW5zaWVudFJldHJ5U3RhdGU6ICgpID0+IHtcbiAgICAgICAgY2FsbHMucHVzaChcInJlc2V0LXRyYW5zaWVudFwiKTtcbiAgICAgIH0sXG4gICAgICBzdGFydEF1dG86IGFzeW5jICgpID0+IHtcbiAgICAgICAgY2FsbHMucHVzaChcInN0YXJ0LWF1dG9cIik7XG4gICAgICB9LFxuICAgIH0sXG4gICk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgXCJyZXN1bWVkXCIpO1xuICBhc3NlcnQuZGVlcEVxdWFsKGNhbGxzLCBbXG4gICAgXCJyZXNldC10cmFuc2llbnRcIixcbiAgICBcInN0YXJ0LWF1dG9cIixcbiAgXSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwIFByb3ZpZGVyIHJlY292ZXJ5IGJlaGF2aW9yICgjMTE2NiAvICMyODEzIC8gIzQzNzMpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwicmVzZXRUcmFuc2llbnRSZXRyeVN0YXRlIGlzIGNhbGxhYmxlIGJ5IHJlc3VtZSByZWNvdmVyeVwiLCAoKSA9PiB7XG4gIHJlc2V0VHJhbnNpZW50UmV0cnlTdGF0ZSgpO1xuICBhc3NlcnQuZXF1YWwoY2xhc3NpZnlFcnJvcihcInN0cmVhbV9leGhhdXN0ZWRfd2l0aG91dF9yZXN1bHRcIikua2luZCwgXCJjb25uZWN0aW9uXCIpO1xufSk7XG5cbnRlc3QoXCJjYW5jZWxsZWQgdW5pdCBzdG9wIHJlYXNvbiBkaWZmZXJlbnRpYXRlcyBzZXNzaW9uIHN0YXJ0dXAgZmFpbHVyZXNcIiwgKCkgPT4ge1xuICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgIF9idWlsZENhbmNlbGxlZFVuaXRTdG9wUmVhc29uKFwicGxhbi1zbGljZVwiLCBcIlMwMVwiLCB7XG4gICAgICBjYXRlZ29yeTogXCJzZXNzaW9uLWZhaWxlZFwiLFxuICAgICAgbWVzc2FnZTogXCJTZXNzaW9uIGNyZWF0aW9uIHRpbWVkIG91dFwiLFxuICAgIH0pLFxuICAgIHtcbiAgICAgIG5vdGlmeU1lc3NhZ2U6IFwiU2Vzc2lvbiBjcmVhdGlvbiBmYWlsZWQgZm9yIHBsYW4tc2xpY2UgUzAxOiBTZXNzaW9uIGNyZWF0aW9uIHRpbWVkIG91dC4gU3RvcHBpbmcgYXV0by1tb2RlLlwiLFxuICAgICAgc3RvcFJlYXNvbjogXCJTZXNzaW9uIGNyZWF0aW9uIGZhaWxlZDogU2Vzc2lvbiBjcmVhdGlvbiB0aW1lZCBvdXRcIixcbiAgICAgIGxvb3BSZWFzb246IFwic2Vzc2lvbi1mYWlsZWRcIixcbiAgICB9LFxuICApO1xuXG4gIGFzc2VydC5kZWVwRXF1YWwoXG4gICAgX2J1aWxkQ2FuY2VsbGVkVW5pdFN0b3BSZWFzb24oXCJleGVjdXRlLXRhc2tcIiwgXCJUMDFcIiwge1xuICAgICAgY2F0ZWdvcnk6IFwiYWJvcnRlZFwiLFxuICAgICAgbWVzc2FnZTogXCJSZXF1ZXN0IGFib3J0ZWQgYnkgdXNlclwiLFxuICAgIH0pLFxuICAgIHtcbiAgICAgIG5vdGlmeU1lc3NhZ2U6IFwiVW5pdCBleGVjdXRlLXRhc2sgVDAxIGFib3J0ZWQgYWZ0ZXIgZGlzcGF0Y2g6IFJlcXVlc3QgYWJvcnRlZCBieSB1c2VyLiBTdG9wcGluZyBhdXRvLW1vZGUuXCIsXG4gICAgICBzdG9wUmVhc29uOiBcIlVuaXQgYWJvcnRlZDogUmVxdWVzdCBhYm9ydGVkIGJ5IHVzZXJcIixcbiAgICAgIGxvb3BSZWFzb246IFwidW5pdC1hYm9ydGVkXCIsXG4gICAgfSxcbiAgKTtcbn0pO1xuXG50ZXN0KFwib3BlbmFpLWNvZGV4IHJlc3BvbnNlIHN0cmVhbSBzdXJmYWNlcyBuZXN0ZWQgZXJyb3IgdHlwZSBhbmQgbWVzc2FnZVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IG9yaWdpbmFsRmV0Y2ggPSBnbG9iYWxUaGlzLmZldGNoO1xuICBjb25zdCB0b2tlblBheWxvYWQgPSBCdWZmZXIuZnJvbShKU09OLnN0cmluZ2lmeSh7XG4gICAgXCJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGhcIjogeyBjaGF0Z3B0X2FjY291bnRfaWQ6IFwiYWNjdC10ZXN0XCIgfSxcbiAgfSkpLnRvU3RyaW5nKFwiYmFzZTY0XCIpO1xuICBjb25zdCBhcGlLZXkgPSBgaGVhZGVyLiR7dG9rZW5QYXlsb2FkfS5zaWduYXR1cmVgO1xuICBnbG9iYWxUaGlzLmZldGNoID0gKGFzeW5jICgpID0+IG5ldyBSZXNwb25zZShcbiAgICAnZGF0YToge1widHlwZVwiOlwiZXJyb3JcIixcImVycm9yXCI6e1widHlwZVwiOlwic2VydmVyX2Vycm9yXCIsXCJjb2RlXCI6XCJzZXJ2ZXJfZXJyb3JcIixcIm1lc3NhZ2VcIjpcInVwc3RyZWFtIGZhaWxlZFwifX1cXG5cXG4nLFxuICAgIHsgc3RhdHVzOiAyMDAsIGhlYWRlcnM6IHsgXCJjb250ZW50LXR5cGVcIjogXCJ0ZXh0L2V2ZW50LXN0cmVhbVwiIH0gfSxcbiAgKSkgYXMgdHlwZW9mIGZldGNoO1xuXG4gIHRyeSB7XG4gICAgY29uc3Qgc3RyZWFtID0gc3RyZWFtT3BlbkFJQ29kZXhSZXNwb25zZXMoXG4gICAgICB7XG4gICAgICAgIHByb3ZpZGVyOiBcIm9wZW5haS1jb2RleC1yZXNwb25zZXNcIixcbiAgICAgICAgaWQ6IFwiZ3B0LTUuMS1jb2RleFwiLFxuICAgICAgICBiYXNlVXJsOiBcImh0dHBzOi8vY29kZXguZXhhbXBsZS50ZXN0XCIsXG4gICAgICB9IGFzIGFueSxcbiAgICAgIHsgbWVzc2FnZXM6IFtdLCBzeXN0ZW1Qcm9tcHQ6IFwiXCIsIHRvb2xzOiBbXSB9IGFzIGFueSxcbiAgICAgIHsgYXBpS2V5IH0gYXMgYW55LFxuICAgICk7XG5cbiAgICBjb25zdCBldmVudHMgPSBbXTtcbiAgICBmb3IgYXdhaXQgKGNvbnN0IGV2ZW50IG9mIHN0cmVhbSkge1xuICAgICAgZXZlbnRzLnB1c2goZXZlbnQpO1xuICAgIH1cblxuICAgIGNvbnN0IGVycm9yRXZlbnQgPSBldmVudHMuZmluZCgoZXZlbnQpID0+IGV2ZW50LnR5cGUgPT09IFwiZXJyb3JcIik7XG4gICAgYXNzZXJ0Lm9rKGVycm9yRXZlbnQsIFwic3RyZWFtIHNob3VsZCBlbWl0IGFuIGVycm9yIGV2ZW50XCIpO1xuICAgIGFzc2VydC5lcXVhbChlcnJvckV2ZW50LmVycm9yLmVycm9yTWVzc2FnZSwgXCJDb2RleCBzZXJ2ZXJfZXJyb3I6IHVwc3RyZWFtIGZhaWxlZFwiKTtcbiAgICBhc3NlcnQuZXF1YWwoY2xhc3NpZnlFcnJvcihlcnJvckV2ZW50LmVycm9yLmVycm9yTWVzc2FnZSkua2luZCwgXCJzZXJ2ZXJcIik7XG4gIH0gZmluYWxseSB7XG4gICAgZ2xvYmFsVGhpcy5mZXRjaCA9IG9yaWdpbmFsRmV0Y2g7XG4gIH1cbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDAgRml4IDM6IE1BWF9UUkFOU0lFTlRfQVVUT19SRVNVTUVTIHJhaXNlZCB0byA4IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiTUFYX1RSQU5TSUVOVF9BVVRPX1JFU1VNRVMgaXMgYXQgbGVhc3QgOCBmb3Igc3VzdGFpbmVkIG92ZXJsb2FkIHJlc2lsaWVuY2VcIiwgKCkgPT4ge1xuICAvLyBJbXBvcnQgdGhlIHJlYWwgY29uc3RhbnQgcmF0aGVyIHRoYW4gcmVnZXgtc2NyYXBpbmcgdGhlIHNvdXJjZSBsaXRlcmFsIFx1MjAxNFxuICAvLyB0aGlzIHdheSB0aGUgYXNzZXJ0aW9uIGNhbm5vdCBzaWxlbnRseSBkcmlmdCBpZiB0aGUgc3ltYm9sIGlzIHJlbmFtZWQgb3JcbiAgLy8gdGhlIHZhbHVlIGlzIG1vdmVkLiBTZWUgIzQ4MzcuXG4gIGFzc2VydC5vayhcbiAgICBNQVhfVFJBTlNJRU5UX0FVVE9fUkVTVU1FUyA+PSA4LFxuICAgIGBNQVhfVFJBTlNJRU5UX0FVVE9fUkVTVU1FUyBtdXN0IGJlID49IDggZm9yIHN1c3RhaW5lZCBvdmVybG9hZCByZXNpbGllbmNlLCBnb3QgJHtNQVhfVFJBTlNJRU5UX0FVVE9fUkVTVU1FU31gLFxuICApO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMCBTdHJlYW0gaWRsZSB0aW1lb3V0IC8gcGFydGlhbCByZXNwb25zZSAoIzQ1NTgpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiY2xhc3NpZnlFcnJvcjogJ1N0cmVhbSBpZGxlIHRpbWVvdXQgLSBwYXJ0aWFsIHJlc3BvbnNlIHJlY2VpdmVkJyBpcyB0cmFuc2llbnQgbmV0d29ya1wiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IGNsYXNzaWZ5RXJyb3IoXCJBUEkgRXJyb3I6IFN0cmVhbSBpZGxlIHRpbWVvdXQgLSBwYXJ0aWFsIHJlc3BvbnNlIHJlY2VpdmVkXCIpO1xuICBhc3NlcnQub2soaXNUcmFuc2llbnQocmVzdWx0KSwgXCJzdHJlYW0gaWRsZSB0aW1lb3V0IG11c3QgYmUgdHJhbnNpZW50XCIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LmtpbmQsIFwibmV0d29ya1wiKTtcbiAgYXNzZXJ0Lm9rKFwicmV0cnlBZnRlck1zXCIgaW4gcmVzdWx0ICYmIHJlc3VsdC5yZXRyeUFmdGVyTXMgPiAwKTtcbn0pO1xuXG50ZXN0KFwiY2xhc3NpZnlFcnJvcjogJ3N0cmVhbSBpZGxlIHRpbWVvdXQnIChsb3dlcmNhc2UpIGlzIHRyYW5zaWVudCBuZXR3b3JrXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gY2xhc3NpZnlFcnJvcihcInN0cmVhbSBpZGxlIHRpbWVvdXRcIik7XG4gIGFzc2VydC5vayhpc1RyYW5zaWVudChyZXN1bHQpLCBcImxvd2VyY2FzZSBzdHJlYW0gaWRsZSB0aW1lb3V0IG11c3QgYmUgdHJhbnNpZW50XCIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LmtpbmQsIFwibmV0d29ya1wiKTtcbn0pO1xuXG50ZXN0KFwiY2xhc3NpZnlFcnJvcjogJ3BhcnRpYWwgcmVzcG9uc2UgcmVjZWl2ZWQnIGFsb25lIGlzIHRyYW5zaWVudCBuZXR3b3JrXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gY2xhc3NpZnlFcnJvcihcInBhcnRpYWwgcmVzcG9uc2UgcmVjZWl2ZWRcIik7XG4gIGFzc2VydC5vayhpc1RyYW5zaWVudChyZXN1bHQpLCBcInBhcnRpYWwgcmVzcG9uc2UgcmVjZWl2ZWQgbXVzdCBiZSB0cmFuc2llbnRcIik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQua2luZCwgXCJuZXR3b3JrXCIpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMCBDb250ZXh0IG92ZXJmbG93IC8gY29udGV4dCB3aW5kb3cgZXhjZWVkZWQgKCM0NTI4KSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcImNsYXNzaWZ5RXJyb3I6IE1pbmlNYXggY29udGV4dCB3aW5kb3cgZXJyb3IgaXMgdHJhbnNpZW50IHNlcnZlclwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IGNsYXNzaWZ5RXJyb3IoXCI0MDAgaW52YWxpZCBwYXJhbXMsIGNvbnRleHQgd2luZG93IGV4Y2VlZHMgbGltaXQgKDIwMTMpXCIpO1xuICBhc3NlcnQub2soaXNUcmFuc2llbnQocmVzdWx0KSwgXCJjb250ZXh0IHdpbmRvdyBleGNlZWRlZCBtdXN0IGJlIHRyYW5zaWVudFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5raW5kLCBcInNlcnZlclwiKTtcbn0pO1xuXG50ZXN0KFwiY2xhc3NpZnlFcnJvcjogJ2NvbnRleHQgbGVuZ3RoIGV4Y2VlZGVkJyBpcyB0cmFuc2llbnQgc2VydmVyXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gY2xhc3NpZnlFcnJvcihcImNvbnRleHQgbGVuZ3RoIGV4Y2VlZGVkOiBtYXggMTI4MDAwIHRva2Vuc1wiKTtcbiAgYXNzZXJ0Lm9rKGlzVHJhbnNpZW50KHJlc3VsdCksIFwiY29udGV4dCBsZW5ndGggZXhjZWVkZWQgbXVzdCBiZSB0cmFuc2llbnRcIik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQua2luZCwgXCJzZXJ2ZXJcIik7XG59KTtcblxudGVzdChcImNsYXNzaWZ5RXJyb3I6ICdjb250ZXh0IHdpbmRvdycgd2l0aCAnZXhjZWVkJyBpcyB0cmFuc2llbnQgc2VydmVyXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gY2xhc3NpZnlFcnJvcihcImNvbnRleHQgd2luZG93IGV4Y2VlZGVkIGZvciB0aGlzIG1vZGVsXCIpO1xuICBhc3NlcnQub2soaXNUcmFuc2llbnQocmVzdWx0KSwgXCJjb250ZXh0IHdpbmRvdyBleGNlZWRlZCBtdXN0IGJlIHRyYW5zaWVudFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5raW5kLCBcInNlcnZlclwiKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDAgYWdlbnQtc2Vzc2lvbiByZXRyeWFibGUgcmVnZXggaGFuZGxlcyBzZXJ2ZXJfZXJyb3IgKCMxMTY2KSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcImFnZW50LXNlc3Npb24gcmV0cnlhYmxlIGVycm9yIHJlZ2V4IG1hdGNoZXMgc2VydmVyX2Vycm9yICh1bmRlcnNjb3JlKVwiLCAoKSA9PiB7XG4gIC8vIEltcG9ydCB0aGUgcmVhbCByZWdleCBmcm9tIHRoZSByZXRyeS1oYW5kbGVyIHNvIHRoaXMgdGVzdCBjYW4gbmV2ZXJcbiAgLy8gc2lsZW50bHkgZHJpZnQgZnJvbSBydW50aW1lIGJlaGF2aW91ci4gVGhlIHJlZ2V4IG11c3QgbWF0Y2ggYm90aFxuICAvLyBcInNlcnZlciBlcnJvclwiIChzcGFjZSkgYW5kIFwic2VydmVyX2Vycm9yXCIgKHVuZGVyc2NvcmUpIHRvIHByb3Blcmx5XG4gIC8vIGNsYXNzaWZ5IENvZGV4IHN0cmVhbWluZyBlcnJvcnMgYXMgcmV0cnlhYmxlLlxuICAvLyBcInRlbXBvcmFyaWx5IGJhY2tlZCBvZmZcIiBpcyBpbnRlbnRpb25hbGx5IGV4Y2x1ZGVkIFx1MjAxNCBzZWUgIzM0MjkgLyAjNDgzNy5cblxuICAvLyBzZXJ2ZXJfZXJyb3IgKHdpdGggdW5kZXJzY29yZSBcdTIwMTQgQ29kZXggc3RyZWFtaW5nIGVycm9yIGZvcm1hdClcbiAgYXNzZXJ0Lm9rKFJFVFJZQUJMRV9FUlJPUl9SRS50ZXN0KFwiQ29kZXggc2VydmVyX2Vycm9yOiBBbiBlcnJvciBvY2N1cnJlZFwiKSk7XG4gIC8vIHNlcnZlciBlcnJvciAod2l0aCBzcGFjZSBcdTIwMTQgdHJhZGl0aW9uYWwgSFRUUCBlcnJvciBmb3JtYXQpXG4gIGFzc2VydC5vayhSRVRSWUFCTEVfRVJST1JfUkUudGVzdChcInNlcnZlciBlcnJvciBvY2N1cnJlZFwiKSk7XG4gIC8vIGludGVybmFsX2Vycm9yICh3aXRoIHVuZGVyc2NvcmUpXG4gIGFzc2VydC5vayhSRVRSWUFCTEVfRVJST1JfUkUudGVzdChcImludGVybmFsX2Vycm9yOiBzb21ldGhpbmcgd2VudCB3cm9uZ1wiKSk7XG4gIC8vIGludGVybmFsIGVycm9yICh3aXRoIHNwYWNlKVxuICBhc3NlcnQub2soUkVUUllBQkxFX0VSUk9SX1JFLnRlc3QoXCJpbnRlcm5hbCBlcnJvclwiKSk7XG4gIC8vIG5vbi1yZXRyeWFibGUgZXJyb3JzIG11c3Qgbm90IG1hdGNoXG4gIGFzc2VydC5vayghUkVUUllBQkxFX0VSUk9SX1JFLnRlc3QoXCJtb2RlbCBub3QgZm91bmRcIikpO1xuICAvLyBcInRlbXBvcmFyaWx5IGJhY2tlZCBvZmZcIiBtdXN0IE5PVCBiZSBtYXRjaGVkIChpbnRlbnRpb25hbCBleGNsdXNpb24gIzM0MjkpXG4gIGFzc2VydC5vayghUkVUUllBQkxFX0VSUk9SX1JFLnRlc3QoXCJ0ZW1wb3JhcmlseSBiYWNrZWQgb2ZmXCIpKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBT0EsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUNuQixTQUFTLGVBQWUsYUFBYSwrQkFBK0I7QUFDcEUsU0FBUyxpQ0FBaUM7QUFDMUMsU0FBUyxvQ0FBb0M7QUFDN0MsU0FBUyw0QkFBNEIsZ0NBQWdDO0FBQ3JFLFNBQVMscUNBQXFDO0FBQzlDLFNBQVMsNEJBQTRCO0FBSXJDLFNBQVMsMEJBQTBCO0FBQ25DLFNBQVMsa0NBQWtDO0FBSTNDLEtBQUssNkNBQTZDLE1BQU07QUFDdEQsUUFBTSxTQUFTLGNBQWMsNEJBQTRCO0FBQ3pELFNBQU8sR0FBRyxZQUFZLE1BQU0sQ0FBQztBQUM3QixTQUFPLE1BQU0sT0FBTyxNQUFNLFlBQVk7QUFDdEMsU0FBTyxHQUFHLGtCQUFrQixVQUFVLE9BQU8sZUFBZSxDQUFDO0FBQy9ELENBQUM7QUFFRCxLQUFLLGlEQUFpRCxNQUFNO0FBQzFELFFBQU0sU0FBUyxjQUFjLHFCQUFxQjtBQUNsRCxTQUFPLEdBQUcsWUFBWSxNQUFNLENBQUM7QUFDN0IsU0FBTyxNQUFNLE9BQU8sTUFBTSxZQUFZO0FBQ3hDLENBQUM7QUFFRCxLQUFLLHdGQUF3RixNQUFNO0FBQ2pHLFFBQU0sU0FBUyxjQUFjLHdDQUFxQztBQUNsRSxTQUFPLEdBQUcsWUFBWSxNQUFNLENBQUM7QUFDN0IsU0FBTyxNQUFNLE9BQU8sTUFBTSxZQUFZO0FBQ3RDLFNBQU8sR0FBRyxrQkFBa0IsVUFBVSxPQUFPLGlCQUFpQixHQUFNO0FBQ3RFLENBQUM7QUFFRCxLQUFLLDZFQUE2RSxNQUFNO0FBQ3RGLFFBQU0sU0FBUyxjQUFjLHdDQUF3QztBQUNyRSxTQUFPLEdBQUcsWUFBWSxNQUFNLENBQUM7QUFDN0IsU0FBTyxNQUFNLE9BQU8sTUFBTSxZQUFZO0FBQ3hDLENBQUM7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
