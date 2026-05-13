import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AuthStorage } from "./auth-storage.js";
function makeKey(key) {
  return { type: "api_key", key };
}
function inMemory(data = {}) {
  return AuthStorage.inMemory(data);
}
describe("AuthStorage \u2014 single credential (backward compat)", () => {
  it("returns the api key for a provider with one key", async () => {
    const storage = inMemory({ anthropic: makeKey("sk-abc") });
    const key = await storage.getApiKey("anthropic");
    assert.equal(key, "sk-abc");
  });
  it("returns undefined for unknown provider", async () => {
    const storage = inMemory({});
    const key = await storage.getApiKey("unknown");
    assert.equal(key, void 0);
  });
  it("runtime override takes precedence over stored key", async () => {
    const storage = inMemory({ anthropic: makeKey("sk-stored") });
    storage.setRuntimeApiKey("anthropic", "sk-runtime");
    const key = await storage.getApiKey("anthropic");
    assert.equal(key, "sk-runtime");
  });
});
describe("AuthStorage \u2014 multiple credentials", () => {
  it("round-robins across multiple api keys without sessionId", async () => {
    const storage = inMemory({
      anthropic: [makeKey("sk-1"), makeKey("sk-2"), makeKey("sk-3")]
    });
    const keys = /* @__PURE__ */ new Set();
    for (let i = 0; i < 6; i++) {
      const k = await storage.getApiKey("anthropic");
      assert.ok(k, `call ${i} should return a key`);
      keys.add(k);
    }
    assert.deepEqual(keys, /* @__PURE__ */ new Set(["sk-1", "sk-2", "sk-3"]));
  });
  it("session-sticky: same sessionId always picks the same key", async () => {
    const storage = inMemory({
      anthropic: [makeKey("sk-1"), makeKey("sk-2"), makeKey("sk-3")]
    });
    const sessionId = "sess-abc";
    const first = await storage.getApiKey("anthropic", sessionId);
    for (let i = 0; i < 5; i++) {
      const k = await storage.getApiKey("anthropic", sessionId);
      assert.equal(k, first, `call ${i} should be sticky to first selection`);
    }
  });
  it("different sessionIds may select different keys", async () => {
    const storage = inMemory({
      anthropic: [makeKey("sk-1"), makeKey("sk-2"), makeKey("sk-3")]
    });
    const results = /* @__PURE__ */ new Set();
    for (let i = 0; i < 20; i++) {
      const k = await storage.getApiKey("anthropic", `sess-${i}`);
      if (k) results.add(k);
    }
    assert.ok(results.size > 1, "multiple sessions should hash to different keys");
  });
});
describe("AuthStorage \u2014 login accumulation", () => {
  it("accumulates api keys on repeated set()", () => {
    const storage = inMemory({});
    storage.set("anthropic", makeKey("sk-1"));
    storage.set("anthropic", makeKey("sk-2"));
    const creds = storage.getCredentialsForProvider("anthropic");
    assert.equal(creds.length, 2);
    assert.deepEqual(
      creds.map((c) => c.type === "api_key" ? c.key : null),
      ["sk-1", "sk-2"]
    );
  });
  it("deduplicates identical api keys", () => {
    const storage = inMemory({});
    storage.set("anthropic", makeKey("sk-1"));
    storage.set("anthropic", makeKey("sk-1"));
    const creds = storage.getCredentialsForProvider("anthropic");
    assert.equal(creds.length, 1);
  });
});
describe("AuthStorage \u2014 rate-limit backoff", () => {
  it("returns true when a backed-off credential has an alternate", async () => {
    const storage = inMemory({
      anthropic: [makeKey("sk-1"), makeKey("sk-2")]
    });
    await storage.getApiKey("anthropic");
    const hasAlternate = storage.markUsageLimitReached("anthropic");
    assert.equal(hasAlternate, true);
  });
  it("returns false when all credentials are backed off", async () => {
    const storage = inMemory({
      anthropic: [makeKey("sk-1"), makeKey("sk-2")]
    });
    await storage.getApiKey("anthropic");
    storage.markUsageLimitReached("anthropic");
    await storage.getApiKey("anthropic");
    const hasAlternate = storage.markUsageLimitReached("anthropic");
    assert.equal(hasAlternate, false);
  });
  it("backed-off credential is skipped; next available key is returned", async () => {
    const storage = inMemory({
      anthropic: [makeKey("sk-1"), makeKey("sk-2")]
    });
    const first = await storage.getApiKey("anthropic");
    assert.equal(first, "sk-1");
    storage.markUsageLimitReached("anthropic");
    const second = await storage.getApiKey("anthropic");
    assert.equal(second, "sk-2");
  });
  it("single credential: markUsageLimitReached returns false", async () => {
    const storage = inMemory({ anthropic: makeKey("sk-only") });
    await storage.getApiKey("anthropic");
    const hasAlternate = storage.markUsageLimitReached("anthropic");
    assert.equal(hasAlternate, false);
  });
  it("single credential: unknown error type skips backoff entirely", async () => {
    const storage = inMemory({ anthropic: makeKey("sk-only") });
    await storage.getApiKey("anthropic");
    const hasAlternate = storage.markUsageLimitReached("anthropic", void 0, {
      errorType: "unknown"
    });
    assert.equal(hasAlternate, false);
    const key = await storage.getApiKey("anthropic");
    assert.equal(key, "sk-only");
  });
  it("multiple credentials: unknown error type still backs off the used credential", async () => {
    const storage = inMemory({
      anthropic: [makeKey("sk-1"), makeKey("sk-2")]
    });
    await storage.getApiKey("anthropic");
    const hasAlternate = storage.markUsageLimitReached("anthropic", void 0, {
      errorType: "unknown"
    });
    assert.equal(hasAlternate, true);
    const key = await storage.getApiKey("anthropic");
    assert.equal(key, "sk-2");
  });
  it("single credential: rate_limit error type still backs off", async () => {
    const storage = inMemory({ anthropic: makeKey("sk-only") });
    await storage.getApiKey("anthropic");
    const hasAlternate = storage.markUsageLimitReached("anthropic", void 0, {
      errorType: "rate_limit"
    });
    assert.equal(hasAlternate, false);
    const key = await storage.getApiKey("anthropic");
    assert.equal(key, void 0);
  });
  it("session-sticky: marks the correct credential as backed off", async () => {
    const storage = inMemory({
      anthropic: [makeKey("sk-1"), makeKey("sk-2")]
    });
    const sessionId = "sess-xyz";
    const chosen = await storage.getApiKey("anthropic", sessionId);
    assert.ok(chosen);
    const hasAlternate = storage.markUsageLimitReached("anthropic", sessionId);
    assert.equal(hasAlternate, true);
    const next = await storage.getApiKey("anthropic", sessionId);
    assert.ok(next);
    assert.notEqual(next, chosen);
  });
});
describe("AuthStorage \u2014 areAllCredentialsBackedOff", () => {
  it("returns false when no credentials are configured", () => {
    const storage = inMemory({});
    assert.equal(storage.areAllCredentialsBackedOff("anthropic"), false);
  });
  it("returns false when credentials exist and none are backed off", async () => {
    const storage = inMemory({ anthropic: makeKey("sk-abc") });
    assert.equal(storage.areAllCredentialsBackedOff("anthropic"), false);
  });
  it("returns true when the single credential is backed off", async () => {
    const storage = inMemory({ anthropic: makeKey("sk-only") });
    await storage.getApiKey("anthropic");
    storage.markUsageLimitReached("anthropic");
    assert.equal(storage.areAllCredentialsBackedOff("anthropic"), true);
  });
  it("returns false when at least one credential is still available", async () => {
    const storage = inMemory({ anthropic: [makeKey("sk-1"), makeKey("sk-2")] });
    await storage.getApiKey("anthropic");
    storage.markUsageLimitReached("anthropic");
    assert.equal(storage.areAllCredentialsBackedOff("anthropic"), false);
  });
  it("returns true when all credentials are backed off", async () => {
    const storage = inMemory({ anthropic: [makeKey("sk-1"), makeKey("sk-2")] });
    await storage.getApiKey("anthropic");
    storage.markUsageLimitReached("anthropic");
    await storage.getApiKey("anthropic");
    storage.markUsageLimitReached("anthropic");
    assert.equal(storage.areAllCredentialsBackedOff("anthropic"), true);
  });
});
describe("AuthStorage \u2014 oauth credential for non-OAuth provider (#2083)", () => {
  it("returns undefined when openrouter has type:oauth (no registered OAuth provider)", async (t) => {
    const storage = inMemory({
      openrouter: {
        type: "oauth",
        access_token: "sk-or-v1-fake",
        refresh_token: "rt-fake",
        expires: Date.now() + 36e5
      }
    });
    const origEnv = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    t.after(() => {
      if (origEnv === void 0) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = origEnv;
      }
    });
    const key = await storage.getApiKey("openrouter");
    assert.equal(key, void 0);
  });
  it("falls through to env var when openrouter has type:oauth credential", async (t) => {
    const storage = inMemory({
      openrouter: {
        type: "oauth",
        access_token: "sk-or-v1-fake",
        refresh_token: "rt-fake",
        expires: Date.now() + 36e5
      }
    });
    const origEnv = process.env.OPENROUTER_API_KEY;
    t.after(() => {
      if (origEnv === void 0) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = origEnv;
      }
    });
    process.env.OPENROUTER_API_KEY = "sk-or-v1-env-key";
    const key = await storage.getApiKey("openrouter");
    assert.equal(key, "sk-or-v1-env-key");
  });
  it("falls through to fallback resolver when openrouter has type:oauth credential", async (t) => {
    const storage = inMemory({
      openrouter: {
        type: "oauth",
        access_token: "sk-or-v1-fake",
        refresh_token: "rt-fake",
        expires: Date.now() + 36e5
      }
    });
    const origEnv = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    t.after(() => {
      if (origEnv === void 0) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = origEnv;
      }
    });
    storage.setFallbackResolver(
      (provider) => provider === "openrouter" ? "sk-or-v1-fallback" : void 0
    );
    const key = await storage.getApiKey("openrouter");
    assert.equal(key, "sk-or-v1-fallback");
  });
});
describe("AuthStorage \u2014 Gemini CLI OAuth token detection", () => {
  it("rejects Google OAuth access token (ya29. prefix) stored as api_key for google provider", () => {
    const storage = inMemory({});
    assert.throws(
      () => storage.set("google", makeKey("ya29.a0ARrdaM_fake_oauth_token_from_gemini_cli")),
      (err) => {
        assert.ok(err.message.includes("OAuth access token"), `Expected message about OAuth token, got: ${err.message}`);
        assert.ok(
          err.message.includes("GEMINI_API_KEY") || err.message.includes("google-gemini-cli"),
          `Expected guidance about GEMINI_API_KEY or google-gemini-cli, got: ${err.message}`
        );
        return true;
      }
    );
  });
  it("rejects Google OAuth access token for google provider via getApiKey when set as env var", async () => {
    const storage = inMemory({});
    storage.setRuntimeApiKey("google", "ya29.c.b0AXv0zTPQ_fake_oauth_token");
    const key = await storage.getApiKey("google");
    assert.equal(key, void 0, "OAuth token should be blocked for google provider");
  });
  it("allows legitimate Google API keys (AIza prefix) for google provider", () => {
    const storage = inMemory({});
    storage.set("google", makeKey("AIzaSyD_fake_legitimate_api_key_here"));
    const creds = storage.getCredentialsForProvider("google");
    assert.equal(creds.length, 1);
  });
  it("allows ya29 tokens for google-gemini-cli provider (OAuth is expected there)", () => {
    const storage = inMemory({});
    storage.set("google-gemini-cli", makeKey("ya29.a0ARrdaM_token_for_gemini_cli"));
    const creds = storage.getCredentialsForProvider("google-gemini-cli");
    assert.equal(creds.length, 1);
  });
  it("rejects Google OAuth token (ya29. prefix) for openai provider that uses GEMINI_API_KEY indirectly", () => {
    const storage = inMemory({});
    storage.set("openai", makeKey("ya29.some_value"));
    const creds = storage.getCredentialsForProvider("openai");
    assert.equal(creds.length, 1);
  });
});
describe("AuthStorage \u2014 getAll()", () => {
  it("returns first credential only for providers with multiple keys", () => {
    const storage = inMemory({
      anthropic: [makeKey("sk-1"), makeKey("sk-2")],
      openai: makeKey("sk-openai")
    });
    const all = storage.getAll();
    assert.ok(all["anthropic"]?.type === "api_key");
    assert.equal(all["anthropic"].key, "sk-1");
    assert.equal(all["openai"].key, "sk-openai");
  });
});
describe("AuthStorage \u2014 getEarliestBackoffExpiry", () => {
  it("returns undefined when no credentials are configured for the provider", () => {
    const storage = inMemory({});
    assert.equal(storage.getEarliestBackoffExpiry("anthropic"), void 0);
  });
  it("returns undefined when credentials exist but none are backed off", () => {
    const storage = inMemory({ anthropic: makeKey("sk-only") });
    assert.equal(storage.getEarliestBackoffExpiry("anthropic"), void 0);
  });
  it("returns a future timestamp when a single credential is backed off", async () => {
    const storage = inMemory({ anthropic: makeKey("sk-only") });
    await storage.getApiKey("anthropic");
    storage.markUsageLimitReached("anthropic");
    const expiry = storage.getEarliestBackoffExpiry("anthropic");
    assert.ok(expiry !== void 0, "should return a timestamp");
    assert.ok(expiry > Date.now(), "expiry should be in the future");
  });
  it("returns the earliest expiry when multiple credentials are backed off", async () => {
    const storage = inMemory({
      anthropic: [makeKey("sk-1"), makeKey("sk-2")]
    });
    await storage.getApiKey("anthropic");
    storage.markUsageLimitReached("anthropic");
    await storage.getApiKey("anthropic");
    storage.markUsageLimitReached("anthropic");
    const expiry = storage.getEarliestBackoffExpiry("anthropic");
    assert.ok(expiry !== void 0, "should return a timestamp");
    assert.ok(expiry > Date.now(), "expiry should be in the future");
  });
  it("returns undefined after backed-off credentials expire (cleans up entries)", () => {
    const storage = inMemory({ anthropic: makeKey("sk-only") });
    const credentialBackoff = storage.credentialBackoff;
    const providerMap = /* @__PURE__ */ new Map();
    providerMap.set(0, Date.now() - 1e3);
    credentialBackoff.set("anthropic", providerMap);
    const expiry = storage.getEarliestBackoffExpiry("anthropic");
    assert.equal(expiry, void 0);
    assert.equal(providerMap.size, 0, "expired entry should have been deleted");
  });
  it("returns undefined when provider is not in credentialBackoff map at all", () => {
    const storage = inMemory({ openai: makeKey("sk-openai") });
    assert.equal(storage.getEarliestBackoffExpiry("anthropic"), void 0);
  });
  it("only returns expiry for the requested provider, not other providers", async () => {
    const storage = inMemory({
      anthropic: makeKey("sk-ant"),
      openai: makeKey("sk-oai")
    });
    await storage.getApiKey("anthropic");
    storage.markUsageLimitReached("anthropic");
    assert.equal(storage.getEarliestBackoffExpiry("openai"), void 0);
    const expiry = storage.getEarliestBackoffExpiry("anthropic");
    assert.ok(expiry !== void 0);
    assert.ok(expiry > Date.now());
  });
  it("returns the minimum expiry when one credential expires sooner than another", () => {
    const storage = inMemory({
      anthropic: [makeKey("sk-1"), makeKey("sk-2")]
    });
    const now = Date.now();
    const nearExpiry = now + 5e3;
    const farExpiry = now + 3e4;
    const credentialBackoff = storage.credentialBackoff;
    const providerMap = /* @__PURE__ */ new Map();
    providerMap.set(0, nearExpiry);
    providerMap.set(1, farExpiry);
    credentialBackoff.set("anthropic", providerMap);
    const expiry = storage.getEarliestBackoffExpiry("anthropic");
    assert.equal(expiry, nearExpiry, "should return the nearest (smallest) expiry");
  });
});
describe("AuthStorage \u2014 localhost baseUrl shortcut", () => {
  it("returns 'local-no-key-needed' for localhost provider with no configured key", async () => {
    const storage = inMemory({});
    const key = await storage.getApiKey("ollama", void 0, { baseUrl: "http://localhost:11434" });
    assert.equal(key, "local-no-key-needed");
  });
  it("returns 'local-no-key-needed' for 127.0.0.1 provider with no configured key", async () => {
    const storage = inMemory({});
    const key = await storage.getApiKey("custom", void 0, { baseUrl: "http://127.0.0.1:8080/v1" });
    assert.equal(key, "local-no-key-needed");
  });
  it("returns configured key from fallback resolver for localhost custom provider (#4106)", async () => {
    const storage = inMemory({});
    storage.setFallbackResolver(
      (provider) => provider === "cliproxy" ? "sk-real-proxy-key" : void 0
    );
    const key = await storage.getApiKey("cliproxy", void 0, { baseUrl: "http://localhost:8317/v1" });
    assert.equal(key, "sk-real-proxy-key");
  });
  it("returns configured key from fallback resolver when baseUrl uses 127.0.0.1 (#4106)", async () => {
    const storage = inMemory({});
    storage.setFallbackResolver(
      (provider) => provider === "myproxy" ? "sk-myproxy-key" : void 0
    );
    const key = await storage.getApiKey("myproxy", void 0, { baseUrl: "http://127.0.0.1:9000/v1" });
    assert.equal(key, "sk-myproxy-key");
  });
});
describe("AuthStorage \u2014 hasLegacyOAuthCredential (#4280)", () => {
  it("returns true when anthropic has a type:oauth credential", () => {
    const storage = inMemory({
      anthropic: {
        type: "oauth",
        access: "ya29.fake-access-token",
        refresh: "1//fake-refresh-token",
        expires: Date.now() + 36e5
      }
    });
    assert.equal(storage.hasLegacyOAuthCredential("anthropic"), true);
  });
  it("returns false when anthropic has an api_key credential", () => {
    const storage = inMemory({ anthropic: makeKey("sk-ant-fake") });
    assert.equal(storage.hasLegacyOAuthCredential("anthropic"), false);
  });
  it("returns false when anthropic has no credential at all", () => {
    const storage = inMemory({});
    assert.equal(storage.hasLegacyOAuthCredential("anthropic"), false);
  });
  it("returns false for a provider with a legitimate OAuth credential (e.g. github-copilot)", () => {
    const storage = inMemory({
      "github-copilot": {
        type: "oauth",
        access: "gho_fake-token",
        refresh: "ghr_fake-refresh",
        expires: Date.now() + 288e5
      }
    });
    assert.equal(storage.hasLegacyOAuthCredential("github-copilot"), true);
  });
});
describe("AuthStorage \u2014 removeLegacyOAuthCredential (#4368)", () => {
  it("removes oauth entry and returns true when present", () => {
    const storage = inMemory({
      anthropic: {
        type: "oauth",
        access: "fake",
        refresh: "fake",
        expires: Date.now() + 36e5
      }
    });
    assert.equal(storage.removeLegacyOAuthCredential("anthropic"), true);
    assert.equal(storage.hasLegacyOAuthCredential("anthropic"), false);
    assert.equal(storage.has("anthropic"), false);
  });
  it("returns false when no oauth entry exists", () => {
    const storage = inMemory({ anthropic: makeKey("sk-ant-fake") });
    assert.equal(storage.removeLegacyOAuthCredential("anthropic"), false);
    assert.equal(storage.get("anthropic")?.type, "api_key");
  });
  it("preserves api_key credentials alongside oauth entry", () => {
    const storage = inMemory({
      anthropic: [
        makeKey("sk-ant-keep"),
        {
          type: "oauth",
          access: "fake",
          refresh: "fake",
          expires: Date.now() + 36e5
        }
      ]
    });
    assert.equal(storage.removeLegacyOAuthCredential("anthropic"), true);
    const remaining = storage.getCredentialsForProvider("anthropic");
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].type, "api_key");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL2F1dGgtc3RvcmFnZS50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBkZXNjcmliZSwgaXQgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IEF1dGhTdG9yYWdlIH0gZnJvbSBcIi4vYXV0aC1zdG9yYWdlLmpzXCI7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBoZWxwZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBtYWtlS2V5KGtleTogc3RyaW5nKSB7XG5cdHJldHVybiB7IHR5cGU6IFwiYXBpX2tleVwiIGFzIGNvbnN0LCBrZXkgfTtcbn1cblxuZnVuY3Rpb24gaW5NZW1vcnkoZGF0YTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fSkge1xuXHRyZXR1cm4gQXV0aFN0b3JhZ2UuaW5NZW1vcnkoZGF0YSBhcyBhbnkpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgc2luZ2xlIGNyZWRlbnRpYWwgKGJhY2t3YXJkIGNvbXBhdCkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiQXV0aFN0b3JhZ2UgXHUyMDE0IHNpbmdsZSBjcmVkZW50aWFsIChiYWNrd2FyZCBjb21wYXQpXCIsICgpID0+IHtcblx0aXQoXCJyZXR1cm5zIHRoZSBhcGkga2V5IGZvciBhIHByb3ZpZGVyIHdpdGggb25lIGtleVwiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3Qgc3RvcmFnZSA9IGluTWVtb3J5KHsgYW50aHJvcGljOiBtYWtlS2V5KFwic2stYWJjXCIpIH0pO1xuXHRcdGNvbnN0IGtleSA9IGF3YWl0IHN0b3JhZ2UuZ2V0QXBpS2V5KFwiYW50aHJvcGljXCIpO1xuXHRcdGFzc2VydC5lcXVhbChrZXksIFwic2stYWJjXCIpO1xuXHR9KTtcblxuXHRpdChcInJldHVybnMgdW5kZWZpbmVkIGZvciB1bmtub3duIHByb3ZpZGVyXCIsIGFzeW5jICgpID0+IHtcblx0XHRjb25zdCBzdG9yYWdlID0gaW5NZW1vcnkoe30pO1xuXHRcdGNvbnN0IGtleSA9IGF3YWl0IHN0b3JhZ2UuZ2V0QXBpS2V5KFwidW5rbm93blwiKTtcblx0XHRhc3NlcnQuZXF1YWwoa2V5LCB1bmRlZmluZWQpO1xuXHR9KTtcblxuXHRpdChcInJ1bnRpbWUgb3ZlcnJpZGUgdGFrZXMgcHJlY2VkZW5jZSBvdmVyIHN0b3JlZCBrZXlcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IHN0b3JhZ2UgPSBpbk1lbW9yeSh7IGFudGhyb3BpYzogbWFrZUtleShcInNrLXN0b3JlZFwiKSB9KTtcblx0XHRzdG9yYWdlLnNldFJ1bnRpbWVBcGlLZXkoXCJhbnRocm9waWNcIiwgXCJzay1ydW50aW1lXCIpO1xuXHRcdGNvbnN0IGtleSA9IGF3YWl0IHN0b3JhZ2UuZ2V0QXBpS2V5KFwiYW50aHJvcGljXCIpO1xuXHRcdGFzc2VydC5lcXVhbChrZXksIFwic2stcnVudGltZVwiKTtcblx0fSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIG11bHRpcGxlIGNyZWRlbnRpYWxzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcIkF1dGhTdG9yYWdlIFx1MjAxNCBtdWx0aXBsZSBjcmVkZW50aWFsc1wiLCAoKSA9PiB7XG5cdGl0KFwicm91bmQtcm9iaW5zIGFjcm9zcyBtdWx0aXBsZSBhcGkga2V5cyB3aXRob3V0IHNlc3Npb25JZFwiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3Qgc3RvcmFnZSA9IGluTWVtb3J5KHtcblx0XHRcdGFudGhyb3BpYzogW21ha2VLZXkoXCJzay0xXCIpLCBtYWtlS2V5KFwic2stMlwiKSwgbWFrZUtleShcInNrLTNcIildLFxuXHRcdH0pO1xuXG5cdFx0Y29uc3Qga2V5cyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXHRcdGZvciAobGV0IGkgPSAwOyBpIDwgNjsgaSsrKSB7XG5cdFx0XHRjb25zdCBrID0gYXdhaXQgc3RvcmFnZS5nZXRBcGlLZXkoXCJhbnRocm9waWNcIik7XG5cdFx0XHRhc3NlcnQub2soaywgYGNhbGwgJHtpfSBzaG91bGQgcmV0dXJuIGEga2V5YCk7XG5cdFx0XHRrZXlzLmFkZChrKTtcblx0XHR9XG5cdFx0Ly8gQWxsIHRocmVlIGtleXMgc2hvdWxkIGhhdmUgYmVlbiBzZWxlY3RlZCBhY3Jvc3MgNiBjYWxsc1xuXHRcdGFzc2VydC5kZWVwRXF1YWwoa2V5cywgbmV3IFNldChbXCJzay0xXCIsIFwic2stMlwiLCBcInNrLTNcIl0pKTtcblx0fSk7XG5cblx0aXQoXCJzZXNzaW9uLXN0aWNreTogc2FtZSBzZXNzaW9uSWQgYWx3YXlzIHBpY2tzIHRoZSBzYW1lIGtleVwiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3Qgc3RvcmFnZSA9IGluTWVtb3J5KHtcblx0XHRcdGFudGhyb3BpYzogW21ha2VLZXkoXCJzay0xXCIpLCBtYWtlS2V5KFwic2stMlwiKSwgbWFrZUtleShcInNrLTNcIildLFxuXHRcdH0pO1xuXG5cdFx0Y29uc3Qgc2Vzc2lvbklkID0gXCJzZXNzLWFiY1wiO1xuXHRcdGNvbnN0IGZpcnN0ID0gYXdhaXQgc3RvcmFnZS5nZXRBcGlLZXkoXCJhbnRocm9waWNcIiwgc2Vzc2lvbklkKTtcblx0XHRmb3IgKGxldCBpID0gMDsgaSA8IDU7IGkrKykge1xuXHRcdFx0Y29uc3QgayA9IGF3YWl0IHN0b3JhZ2UuZ2V0QXBpS2V5KFwiYW50aHJvcGljXCIsIHNlc3Npb25JZCk7XG5cdFx0XHRhc3NlcnQuZXF1YWwoaywgZmlyc3QsIGBjYWxsICR7aX0gc2hvdWxkIGJlIHN0aWNreSB0byBmaXJzdCBzZWxlY3Rpb25gKTtcblx0XHR9XG5cdH0pO1xuXG5cdGl0KFwiZGlmZmVyZW50IHNlc3Npb25JZHMgbWF5IHNlbGVjdCBkaWZmZXJlbnQga2V5c1wiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3Qgc3RvcmFnZSA9IGluTWVtb3J5KHtcblx0XHRcdGFudGhyb3BpYzogW21ha2VLZXkoXCJzay0xXCIpLCBtYWtlS2V5KFwic2stMlwiKSwgbWFrZUtleShcInNrLTNcIildLFxuXHRcdH0pO1xuXG5cdFx0Y29uc3QgcmVzdWx0cyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXHRcdGZvciAobGV0IGkgPSAwOyBpIDwgMjA7IGkrKykge1xuXHRcdFx0Y29uc3QgayA9IGF3YWl0IHN0b3JhZ2UuZ2V0QXBpS2V5KFwiYW50aHJvcGljXCIsIGBzZXNzLSR7aX1gKTtcblx0XHRcdGlmIChrKSByZXN1bHRzLmFkZChrKTtcblx0XHR9XG5cdFx0Ly8gV2l0aCAyMCBkaWZmZXJlbnQgc2Vzc2lvbnMgYW5kIDMga2V5cywgd2Ugc2hvdWxkIHNlZSBtb3JlIHRoYW4gb25lIGtleVxuXHRcdGFzc2VydC5vayhyZXN1bHRzLnNpemUgPiAxLCBcIm11bHRpcGxlIHNlc3Npb25zIHNob3VsZCBoYXNoIHRvIGRpZmZlcmVudCBrZXlzXCIpO1xuXHR9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgbG9naW4gYWNjdW11bGF0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcIkF1dGhTdG9yYWdlIFx1MjAxNCBsb2dpbiBhY2N1bXVsYXRpb25cIiwgKCkgPT4ge1xuXHRpdChcImFjY3VtdWxhdGVzIGFwaSBrZXlzIG9uIHJlcGVhdGVkIHNldCgpXCIsICgpID0+IHtcblx0XHRjb25zdCBzdG9yYWdlID0gaW5NZW1vcnkoe30pO1xuXHRcdHN0b3JhZ2Uuc2V0KFwiYW50aHJvcGljXCIsIG1ha2VLZXkoXCJzay0xXCIpKTtcblx0XHRzdG9yYWdlLnNldChcImFudGhyb3BpY1wiLCBtYWtlS2V5KFwic2stMlwiKSk7XG5cdFx0Y29uc3QgY3JlZHMgPSBzdG9yYWdlLmdldENyZWRlbnRpYWxzRm9yUHJvdmlkZXIoXCJhbnRocm9waWNcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKGNyZWRzLmxlbmd0aCwgMik7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChcblx0XHRcdGNyZWRzLm1hcCgoYykgPT4gKGMudHlwZSA9PT0gXCJhcGlfa2V5XCIgPyBjLmtleSA6IG51bGwpKSxcblx0XHRcdFtcInNrLTFcIiwgXCJzay0yXCJdLFxuXHRcdCk7XG5cdH0pO1xuXG5cdGl0KFwiZGVkdXBsaWNhdGVzIGlkZW50aWNhbCBhcGkga2V5c1wiLCAoKSA9PiB7XG5cdFx0Y29uc3Qgc3RvcmFnZSA9IGluTWVtb3J5KHt9KTtcblx0XHRzdG9yYWdlLnNldChcImFudGhyb3BpY1wiLCBtYWtlS2V5KFwic2stMVwiKSk7XG5cdFx0c3RvcmFnZS5zZXQoXCJhbnRocm9waWNcIiwgbWFrZUtleShcInNrLTFcIikpO1xuXHRcdGNvbnN0IGNyZWRzID0gc3RvcmFnZS5nZXRDcmVkZW50aWFsc0ZvclByb3ZpZGVyKFwiYW50aHJvcGljXCIpO1xuXHRcdGFzc2VydC5lcXVhbChjcmVkcy5sZW5ndGgsIDEpO1xuXHR9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgYmFja29mZiAvIG1hcmtVc2FnZUxpbWl0UmVhY2hlZCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJBdXRoU3RvcmFnZSBcdTIwMTQgcmF0ZS1saW1pdCBiYWNrb2ZmXCIsICgpID0+IHtcblx0aXQoXCJyZXR1cm5zIHRydWUgd2hlbiBhIGJhY2tlZC1vZmYgY3JlZGVudGlhbCBoYXMgYW4gYWx0ZXJuYXRlXCIsIGFzeW5jICgpID0+IHtcblx0XHRjb25zdCBzdG9yYWdlID0gaW5NZW1vcnkoe1xuXHRcdFx0YW50aHJvcGljOiBbbWFrZUtleShcInNrLTFcIiksIG1ha2VLZXkoXCJzay0yXCIpXSxcblx0XHR9KTtcblxuXHRcdC8vIFVzZSBzay0xIHZpYSByb3VuZC1yb2JpbiAoZmlyc3QgY2FsbCwgaW5kZXggMClcblx0XHRhd2FpdCBzdG9yYWdlLmdldEFwaUtleShcImFudGhyb3BpY1wiKTtcblxuXHRcdC8vIE1hcmsgaXQgYXMgcmF0ZS1saW1pdGVkOyBzay0yIHNob3VsZCBzdGlsbCBiZSBhdmFpbGFibGVcblx0XHRjb25zdCBoYXNBbHRlcm5hdGUgPSBzdG9yYWdlLm1hcmtVc2FnZUxpbWl0UmVhY2hlZChcImFudGhyb3BpY1wiKTtcblx0XHRhc3NlcnQuZXF1YWwoaGFzQWx0ZXJuYXRlLCB0cnVlKTtcblx0fSk7XG5cblx0aXQoXCJyZXR1cm5zIGZhbHNlIHdoZW4gYWxsIGNyZWRlbnRpYWxzIGFyZSBiYWNrZWQgb2ZmXCIsIGFzeW5jICgpID0+IHtcblx0XHRjb25zdCBzdG9yYWdlID0gaW5NZW1vcnkoe1xuXHRcdFx0YW50aHJvcGljOiBbbWFrZUtleShcInNrLTFcIiksIG1ha2VLZXkoXCJzay0yXCIpXSxcblx0XHR9KTtcblxuXHRcdC8vIEJhY2sgb2ZmIGJvdGgga2V5c1xuXHRcdGF3YWl0IHN0b3JhZ2UuZ2V0QXBpS2V5KFwiYW50aHJvcGljXCIpOyAvLyB1c2VzIGluZGV4IDBcblx0XHRzdG9yYWdlLm1hcmtVc2FnZUxpbWl0UmVhY2hlZChcImFudGhyb3BpY1wiKTsgLy8gYmFja3Mgb2ZmIGluZGV4IDBcblx0XHRhd2FpdCBzdG9yYWdlLmdldEFwaUtleShcImFudGhyb3BpY1wiKTsgLy8gdXNlcyBpbmRleCAxXG5cdFx0Y29uc3QgaGFzQWx0ZXJuYXRlID0gc3RvcmFnZS5tYXJrVXNhZ2VMaW1pdFJlYWNoZWQoXCJhbnRocm9waWNcIik7IC8vIGJhY2tzIG9mZiBpbmRleCAxXG5cdFx0YXNzZXJ0LmVxdWFsKGhhc0FsdGVybmF0ZSwgZmFsc2UpO1xuXHR9KTtcblxuXHRpdChcImJhY2tlZC1vZmYgY3JlZGVudGlhbCBpcyBza2lwcGVkOyBuZXh0IGF2YWlsYWJsZSBrZXkgaXMgcmV0dXJuZWRcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IHN0b3JhZ2UgPSBpbk1lbW9yeSh7XG5cdFx0XHRhbnRocm9waWM6IFttYWtlS2V5KFwic2stMVwiKSwgbWFrZUtleShcInNrLTJcIildLFxuXHRcdH0pO1xuXG5cdFx0Ly8gRmlyc3QgY2FsbCBcdTIxOTIgc2stMSAocm91bmQtcm9iaW4gaW5kZXggMClcblx0XHRjb25zdCBmaXJzdCA9IGF3YWl0IHN0b3JhZ2UuZ2V0QXBpS2V5KFwiYW50aHJvcGljXCIpO1xuXHRcdGFzc2VydC5lcXVhbChmaXJzdCwgXCJzay0xXCIpO1xuXG5cdFx0Ly8gQmFjayBvZmYgc2stMVxuXHRcdHN0b3JhZ2UubWFya1VzYWdlTGltaXRSZWFjaGVkKFwiYW50aHJvcGljXCIpO1xuXG5cdFx0Ly8gTmV4dCBjYWxsIHNob3VsZCBza2lwIGJhY2tlZC1vZmYgc2stMSBhbmQgcmV0dXJuIHNrLTJcblx0XHRjb25zdCBzZWNvbmQgPSBhd2FpdCBzdG9yYWdlLmdldEFwaUtleShcImFudGhyb3BpY1wiKTtcblx0XHRhc3NlcnQuZXF1YWwoc2Vjb25kLCBcInNrLTJcIik7XG5cdH0pO1xuXG5cdGl0KFwic2luZ2xlIGNyZWRlbnRpYWw6IG1hcmtVc2FnZUxpbWl0UmVhY2hlZCByZXR1cm5zIGZhbHNlXCIsIGFzeW5jICgpID0+IHtcblx0XHRjb25zdCBzdG9yYWdlID0gaW5NZW1vcnkoeyBhbnRocm9waWM6IG1ha2VLZXkoXCJzay1vbmx5XCIpIH0pO1xuXHRcdGF3YWl0IHN0b3JhZ2UuZ2V0QXBpS2V5KFwiYW50aHJvcGljXCIpO1xuXHRcdGNvbnN0IGhhc0FsdGVybmF0ZSA9IHN0b3JhZ2UubWFya1VzYWdlTGltaXRSZWFjaGVkKFwiYW50aHJvcGljXCIpO1xuXHRcdGFzc2VydC5lcXVhbChoYXNBbHRlcm5hdGUsIGZhbHNlKTtcblx0fSk7XG5cblx0aXQoXCJzaW5nbGUgY3JlZGVudGlhbDogdW5rbm93biBlcnJvciB0eXBlIHNraXBzIGJhY2tvZmYgZW50aXJlbHlcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IHN0b3JhZ2UgPSBpbk1lbW9yeSh7IGFudGhyb3BpYzogbWFrZUtleShcInNrLW9ubHlcIikgfSk7XG5cdFx0YXdhaXQgc3RvcmFnZS5nZXRBcGlLZXkoXCJhbnRocm9waWNcIik7XG5cblx0XHQvLyBNYXJrIHdpdGggdW5rbm93biBlcnJvciB0eXBlICh0cmFuc3BvcnQgZmFpbHVyZSlcblx0XHRjb25zdCBoYXNBbHRlcm5hdGUgPSBzdG9yYWdlLm1hcmtVc2FnZUxpbWl0UmVhY2hlZChcImFudGhyb3BpY1wiLCB1bmRlZmluZWQsIHtcblx0XHRcdGVycm9yVHlwZTogXCJ1bmtub3duXCIsXG5cdFx0fSk7XG5cdFx0YXNzZXJ0LmVxdWFsKGhhc0FsdGVybmF0ZSwgZmFsc2UpO1xuXG5cdFx0Ly8gS2V5IHNob3VsZCBzdGlsbCBiZSBhdmFpbGFibGUgXHUyMDE0IGJhY2tvZmYgd2FzIG5vdCBhcHBsaWVkXG5cdFx0Y29uc3Qga2V5ID0gYXdhaXQgc3RvcmFnZS5nZXRBcGlLZXkoXCJhbnRocm9waWNcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKGtleSwgXCJzay1vbmx5XCIpO1xuXHR9KTtcblxuXHRpdChcIm11bHRpcGxlIGNyZWRlbnRpYWxzOiB1bmtub3duIGVycm9yIHR5cGUgc3RpbGwgYmFja3Mgb2ZmIHRoZSB1c2VkIGNyZWRlbnRpYWxcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IHN0b3JhZ2UgPSBpbk1lbW9yeSh7XG5cdFx0XHRhbnRocm9waWM6IFttYWtlS2V5KFwic2stMVwiKSwgbWFrZUtleShcInNrLTJcIildLFxuXHRcdH0pO1xuXHRcdGF3YWl0IHN0b3JhZ2UuZ2V0QXBpS2V5KFwiYW50aHJvcGljXCIpOyAvLyB1c2VzIHNrLTFcblxuXHRcdC8vIE1hcmsgd2l0aCB1bmtub3duIGVycm9yIHR5cGUgXHUyMDE0IHNob3VsZCBzdGlsbCBiYWNrIG9mZiB3aGVuIGFsdGVybmF0ZXMgZXhpc3Rcblx0XHRjb25zdCBoYXNBbHRlcm5hdGUgPSBzdG9yYWdlLm1hcmtVc2FnZUxpbWl0UmVhY2hlZChcImFudGhyb3BpY1wiLCB1bmRlZmluZWQsIHtcblx0XHRcdGVycm9yVHlwZTogXCJ1bmtub3duXCIsXG5cdFx0fSk7XG5cdFx0YXNzZXJ0LmVxdWFsKGhhc0FsdGVybmF0ZSwgdHJ1ZSk7XG5cblx0XHQvLyBOZXh0IGNhbGwgc2hvdWxkIHJldHVybiBzay0yXG5cdFx0Y29uc3Qga2V5ID0gYXdhaXQgc3RvcmFnZS5nZXRBcGlLZXkoXCJhbnRocm9waWNcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKGtleSwgXCJzay0yXCIpO1xuXHR9KTtcblxuXHRpdChcInNpbmdsZSBjcmVkZW50aWFsOiByYXRlX2xpbWl0IGVycm9yIHR5cGUgc3RpbGwgYmFja3Mgb2ZmXCIsIGFzeW5jICgpID0+IHtcblx0XHRjb25zdCBzdG9yYWdlID0gaW5NZW1vcnkoeyBhbnRocm9waWM6IG1ha2VLZXkoXCJzay1vbmx5XCIpIH0pO1xuXHRcdGF3YWl0IHN0b3JhZ2UuZ2V0QXBpS2V5KFwiYW50aHJvcGljXCIpO1xuXG5cdFx0Ly8gcmF0ZV9saW1pdCBzaG91bGQgc3RpbGwgYmFjayBvZmYgZXZlbiBzaW5nbGUgY3JlZGVudGlhbHNcblx0XHRjb25zdCBoYXNBbHRlcm5hdGUgPSBzdG9yYWdlLm1hcmtVc2FnZUxpbWl0UmVhY2hlZChcImFudGhyb3BpY1wiLCB1bmRlZmluZWQsIHtcblx0XHRcdGVycm9yVHlwZTogXCJyYXRlX2xpbWl0XCIsXG5cdFx0fSk7XG5cdFx0YXNzZXJ0LmVxdWFsKGhhc0FsdGVybmF0ZSwgZmFsc2UpO1xuXG5cdFx0Ly8gS2V5IHNob3VsZCBiZSBiYWNrZWQgb2ZmXG5cdFx0Y29uc3Qga2V5ID0gYXdhaXQgc3RvcmFnZS5nZXRBcGlLZXkoXCJhbnRocm9waWNcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKGtleSwgdW5kZWZpbmVkKTtcblx0fSk7XG5cblx0aXQoXCJzZXNzaW9uLXN0aWNreTogbWFya3MgdGhlIGNvcnJlY3QgY3JlZGVudGlhbCBhcyBiYWNrZWQgb2ZmXCIsIGFzeW5jICgpID0+IHtcblx0XHRjb25zdCBzdG9yYWdlID0gaW5NZW1vcnkoe1xuXHRcdFx0YW50aHJvcGljOiBbbWFrZUtleShcInNrLTFcIiksIG1ha2VLZXkoXCJzay0yXCIpXSxcblx0XHR9KTtcblxuXHRcdGNvbnN0IHNlc3Npb25JZCA9IFwic2Vzcy14eXpcIjtcblx0XHRjb25zdCBjaG9zZW4gPSBhd2FpdCBzdG9yYWdlLmdldEFwaUtleShcImFudGhyb3BpY1wiLCBzZXNzaW9uSWQpO1xuXHRcdGFzc2VydC5vayhjaG9zZW4pO1xuXG5cdFx0Ly8gQmFjayBvZmYgdGhlIGNob3NlbiBjcmVkZW50aWFsIGZvciB0aGlzIHNlc3Npb25cblx0XHRjb25zdCBoYXNBbHRlcm5hdGUgPSBzdG9yYWdlLm1hcmtVc2FnZUxpbWl0UmVhY2hlZChcImFudGhyb3BpY1wiLCBzZXNzaW9uSWQpO1xuXHRcdGFzc2VydC5lcXVhbChoYXNBbHRlcm5hdGUsIHRydWUpO1xuXG5cdFx0Ly8gTmV4dCBjYWxsIHdpdGggc2FtZSBzZXNzaW9uIHNob3VsZCByZXR1cm4gdGhlIG90aGVyIGtleVxuXHRcdGNvbnN0IG5leHQgPSBhd2FpdCBzdG9yYWdlLmdldEFwaUtleShcImFudGhyb3BpY1wiLCBzZXNzaW9uSWQpO1xuXHRcdGFzc2VydC5vayhuZXh0KTtcblx0XHRhc3NlcnQubm90RXF1YWwobmV4dCwgY2hvc2VuKTtcblx0fSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGFyZUFsbENyZWRlbnRpYWxzQmFja2VkT2ZmIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcIkF1dGhTdG9yYWdlIFx1MjAxNCBhcmVBbGxDcmVkZW50aWFsc0JhY2tlZE9mZlwiLCAoKSA9PiB7XG5cdGl0KFwicmV0dXJucyBmYWxzZSB3aGVuIG5vIGNyZWRlbnRpYWxzIGFyZSBjb25maWd1cmVkXCIsICgpID0+IHtcblx0XHRjb25zdCBzdG9yYWdlID0gaW5NZW1vcnkoe30pO1xuXHRcdGFzc2VydC5lcXVhbChzdG9yYWdlLmFyZUFsbENyZWRlbnRpYWxzQmFja2VkT2ZmKFwiYW50aHJvcGljXCIpLCBmYWxzZSk7XG5cdH0pO1xuXG5cdGl0KFwicmV0dXJucyBmYWxzZSB3aGVuIGNyZWRlbnRpYWxzIGV4aXN0IGFuZCBub25lIGFyZSBiYWNrZWQgb2ZmXCIsIGFzeW5jICgpID0+IHtcblx0XHRjb25zdCBzdG9yYWdlID0gaW5NZW1vcnkoeyBhbnRocm9waWM6IG1ha2VLZXkoXCJzay1hYmNcIikgfSk7XG5cdFx0YXNzZXJ0LmVxdWFsKHN0b3JhZ2UuYXJlQWxsQ3JlZGVudGlhbHNCYWNrZWRPZmYoXCJhbnRocm9waWNcIiksIGZhbHNlKTtcblx0fSk7XG5cblx0aXQoXCJyZXR1cm5zIHRydWUgd2hlbiB0aGUgc2luZ2xlIGNyZWRlbnRpYWwgaXMgYmFja2VkIG9mZlwiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3Qgc3RvcmFnZSA9IGluTWVtb3J5KHsgYW50aHJvcGljOiBtYWtlS2V5KFwic2stb25seVwiKSB9KTtcblx0XHRhd2FpdCBzdG9yYWdlLmdldEFwaUtleShcImFudGhyb3BpY1wiKTtcblx0XHRzdG9yYWdlLm1hcmtVc2FnZUxpbWl0UmVhY2hlZChcImFudGhyb3BpY1wiKTtcblx0XHRhc3NlcnQuZXF1YWwoc3RvcmFnZS5hcmVBbGxDcmVkZW50aWFsc0JhY2tlZE9mZihcImFudGhyb3BpY1wiKSwgdHJ1ZSk7XG5cdH0pO1xuXG5cdGl0KFwicmV0dXJucyBmYWxzZSB3aGVuIGF0IGxlYXN0IG9uZSBjcmVkZW50aWFsIGlzIHN0aWxsIGF2YWlsYWJsZVwiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3Qgc3RvcmFnZSA9IGluTWVtb3J5KHsgYW50aHJvcGljOiBbbWFrZUtleShcInNrLTFcIiksIG1ha2VLZXkoXCJzay0yXCIpXSB9KTtcblx0XHRhd2FpdCBzdG9yYWdlLmdldEFwaUtleShcImFudGhyb3BpY1wiKTsgLy8gdXNlcyBpbmRleCAwXG5cdFx0c3RvcmFnZS5tYXJrVXNhZ2VMaW1pdFJlYWNoZWQoXCJhbnRocm9waWNcIik7IC8vIGJhY2tzIG9mZiBpbmRleCAwXG5cdFx0Ly8gaW5kZXggMSBpcyBzdGlsbCBhdmFpbGFibGVcblx0XHRhc3NlcnQuZXF1YWwoc3RvcmFnZS5hcmVBbGxDcmVkZW50aWFsc0JhY2tlZE9mZihcImFudGhyb3BpY1wiKSwgZmFsc2UpO1xuXHR9KTtcblxuXHRpdChcInJldHVybnMgdHJ1ZSB3aGVuIGFsbCBjcmVkZW50aWFscyBhcmUgYmFja2VkIG9mZlwiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3Qgc3RvcmFnZSA9IGluTWVtb3J5KHsgYW50aHJvcGljOiBbbWFrZUtleShcInNrLTFcIiksIG1ha2VLZXkoXCJzay0yXCIpXSB9KTtcblx0XHRhd2FpdCBzdG9yYWdlLmdldEFwaUtleShcImFudGhyb3BpY1wiKTsgLy8gdXNlcyBpbmRleCAwXG5cdFx0c3RvcmFnZS5tYXJrVXNhZ2VMaW1pdFJlYWNoZWQoXCJhbnRocm9waWNcIik7IC8vIGJhY2tzIG9mZiBpbmRleCAwXG5cdFx0YXdhaXQgc3RvcmFnZS5nZXRBcGlLZXkoXCJhbnRocm9waWNcIik7IC8vIHVzZXMgaW5kZXggMVxuXHRcdHN0b3JhZ2UubWFya1VzYWdlTGltaXRSZWFjaGVkKFwiYW50aHJvcGljXCIpOyAvLyBiYWNrcyBvZmYgaW5kZXggMVxuXHRcdGFzc2VydC5lcXVhbChzdG9yYWdlLmFyZUFsbENyZWRlbnRpYWxzQmFja2VkT2ZmKFwiYW50aHJvcGljXCIpLCB0cnVlKTtcblx0fSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIG1pc21hdGNoZWQgb2F1dGggY3JlZGVudGlhbCBmb3Igbm9uLU9BdXRoIHByb3ZpZGVyICgjMjA4MykgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiQXV0aFN0b3JhZ2UgXHUyMDE0IG9hdXRoIGNyZWRlbnRpYWwgZm9yIG5vbi1PQXV0aCBwcm92aWRlciAoIzIwODMpXCIsICgpID0+IHtcblx0aXQoXCJyZXR1cm5zIHVuZGVmaW5lZCB3aGVuIG9wZW5yb3V0ZXIgaGFzIHR5cGU6b2F1dGggKG5vIHJlZ2lzdGVyZWQgT0F1dGggcHJvdmlkZXIpXCIsIGFzeW5jICh0KSA9PiB7XG5cdFx0Ly8gU2ltdWxhdGVzIHRoZSBidWc6IE9wZW5Sb3V0ZXIgY3JlZGVudGlhbCBzdG9yZWQgYXMgdHlwZTpcIm9hdXRoXCJcblx0XHQvLyBidXQgT3BlblJvdXRlciBpcyBub3QgYSByZWdpc3RlcmVkIE9BdXRoIHByb3ZpZGVyLlxuXHRcdGNvbnN0IHN0b3JhZ2UgPSBpbk1lbW9yeSh7XG5cdFx0XHRvcGVucm91dGVyOiB7XG5cdFx0XHRcdHR5cGU6IFwib2F1dGhcIixcblx0XHRcdFx0YWNjZXNzX3Rva2VuOiBcInNrLW9yLXYxLWZha2VcIixcblx0XHRcdFx0cmVmcmVzaF90b2tlbjogXCJydC1mYWtlXCIsXG5cdFx0XHRcdGV4cGlyZXM6IERhdGUubm93KCkgKyAzXzYwMF8wMDAsXG5cdFx0XHR9LFxuXHRcdH0pO1xuXG5cdFx0Ly8gSXNvbGF0ZSBmcm9tIGFueSByZWFsIE9QRU5ST1VURVJfQVBJX0tFWSBpbiB0aGUgZW52aXJvbm1lbnQgc28gdGhlXG5cdFx0Ly8gZmFsbC10aHJvdWdoIHRvIGVudiAvIGZhbGxiYWNrIGZpbmRzIG5vdGhpbmcgYW5kIHJldHVybnMgdW5kZWZpbmVkLlxuXHRcdGNvbnN0IG9yaWdFbnYgPSBwcm9jZXNzLmVudi5PUEVOUk9VVEVSX0FQSV9LRVk7XG5cdFx0ZGVsZXRlIHByb2Nlc3MuZW52Lk9QRU5ST1VURVJfQVBJX0tFWTtcblx0XHR0LmFmdGVyKCgpID0+IHtcblx0XHRcdGlmIChvcmlnRW52ID09PSB1bmRlZmluZWQpIHtcblx0XHRcdFx0ZGVsZXRlIHByb2Nlc3MuZW52Lk9QRU5ST1VURVJfQVBJX0tFWTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdHByb2Nlc3MuZW52Lk9QRU5ST1VURVJfQVBJX0tFWSA9IG9yaWdFbnY7XG5cdFx0XHR9XG5cdFx0fSk7XG5cblx0XHQvLyBCZWZvcmUgdGhlIGZpeCwgZ2V0QXBpS2V5IHJldHVybnMgdW5kZWZpbmVkIGJlY2F1c2Vcblx0XHQvLyByZXNvbHZlQ3JlZGVudGlhbEFwaUtleSBjYWxscyBnZXRPQXV0aFByb3ZpZGVyKFwib3BlbnJvdXRlclwiKSBcdTIxOTIgbnVsbCBcdTIxOTIgdW5kZWZpbmVkLlxuXHRcdC8vIFRoZSBrZXkgaW4gdGhlIG9hdXRoIGNyZWRlbnRpYWwgaXMgbmV2ZXIgZXh0cmFjdGVkLlxuXHRcdGNvbnN0IGtleSA9IGF3YWl0IHN0b3JhZ2UuZ2V0QXBpS2V5KFwib3BlbnJvdXRlclwiKTtcblx0XHQvLyBBZnRlciB0aGUgZml4LCB0aGUgb2F1dGggY3JlZGVudGlhbCB3aXRoIGFuIHVucmVjb2duaXNlZCBwcm92aWRlclxuXHRcdC8vIHNob3VsZCBiZSBza2lwcGVkLCBhbmQgZ2V0QXBpS2V5IHNob3VsZCBmYWxsIHRocm91Z2ggdG8gZW52IC8gZmFsbGJhY2suXG5cdFx0Ly8gV2l0aCBubyBlbnYgdmFyIGFuZCBubyBmYWxsYmFjayByZXNvbHZlciBjb25maWd1cmVkLCB0aGUgcmVzdWx0IGlzIHVuZGVmaW5lZC5cblx0XHRhc3NlcnQuZXF1YWwoa2V5LCB1bmRlZmluZWQpO1xuXHR9KTtcblxuXHRpdChcImZhbGxzIHRocm91Z2ggdG8gZW52IHZhciB3aGVuIG9wZW5yb3V0ZXIgaGFzIHR5cGU6b2F1dGggY3JlZGVudGlhbFwiLCBhc3luYyAodCkgPT4ge1xuXHRcdGNvbnN0IHN0b3JhZ2UgPSBpbk1lbW9yeSh7XG5cdFx0XHRvcGVucm91dGVyOiB7XG5cdFx0XHRcdHR5cGU6IFwib2F1dGhcIixcblx0XHRcdFx0YWNjZXNzX3Rva2VuOiBcInNrLW9yLXYxLWZha2VcIixcblx0XHRcdFx0cmVmcmVzaF90b2tlbjogXCJydC1mYWtlXCIsXG5cdFx0XHRcdGV4cGlyZXM6IERhdGUubm93KCkgKyAzXzYwMF8wMDAsXG5cdFx0XHR9LFxuXHRcdH0pO1xuXG5cdFx0Ly8gU2ltdWxhdGUgT1BFTlJPVVRFUl9BUElfS0VZIGJlaW5nIHNldCB2aWEgZW52XG5cdFx0Y29uc3Qgb3JpZ0VudiA9IHByb2Nlc3MuZW52Lk9QRU5ST1VURVJfQVBJX0tFWTtcblx0XHR0LmFmdGVyKCgpID0+IHtcblx0XHRcdGlmIChvcmlnRW52ID09PSB1bmRlZmluZWQpIHtcblx0XHRcdFx0ZGVsZXRlIHByb2Nlc3MuZW52Lk9QRU5ST1VURVJfQVBJX0tFWTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdHByb2Nlc3MuZW52Lk9QRU5ST1VURVJfQVBJX0tFWSA9IG9yaWdFbnY7XG5cdFx0XHR9XG5cdFx0fSk7XG5cblx0XHRwcm9jZXNzLmVudi5PUEVOUk9VVEVSX0FQSV9LRVkgPSBcInNrLW9yLXYxLWVudi1rZXlcIjtcblx0XHRjb25zdCBrZXkgPSBhd2FpdCBzdG9yYWdlLmdldEFwaUtleShcIm9wZW5yb3V0ZXJcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKGtleSwgXCJzay1vci12MS1lbnYta2V5XCIpO1xuXHR9KTtcblxuXHRpdChcImZhbGxzIHRocm91Z2ggdG8gZmFsbGJhY2sgcmVzb2x2ZXIgd2hlbiBvcGVucm91dGVyIGhhcyB0eXBlOm9hdXRoIGNyZWRlbnRpYWxcIiwgYXN5bmMgKHQpID0+IHtcblx0XHRjb25zdCBzdG9yYWdlID0gaW5NZW1vcnkoe1xuXHRcdFx0b3BlbnJvdXRlcjoge1xuXHRcdFx0XHR0eXBlOiBcIm9hdXRoXCIsXG5cdFx0XHRcdGFjY2Vzc190b2tlbjogXCJzay1vci12MS1mYWtlXCIsXG5cdFx0XHRcdHJlZnJlc2hfdG9rZW46IFwicnQtZmFrZVwiLFxuXHRcdFx0XHRleHBpcmVzOiBEYXRlLm5vdygpICsgM182MDBfMDAwLFxuXHRcdFx0fSxcblx0XHR9KTtcblxuXHRcdC8vIElzb2xhdGUgZnJvbSBhbnkgcmVhbCBPUEVOUk9VVEVSX0FQSV9LRVkgc28gZW52IGZhbGxiYWNrIGlzIHNraXBwZWRcblx0XHQvLyBhbmQgdGhlIGZhbGxiYWNrIHJlc29sdmVyIGlzIHJlYWNoZWQuXG5cdFx0Y29uc3Qgb3JpZ0VudiA9IHByb2Nlc3MuZW52Lk9QRU5ST1VURVJfQVBJX0tFWTtcblx0XHRkZWxldGUgcHJvY2Vzcy5lbnYuT1BFTlJPVVRFUl9BUElfS0VZO1xuXHRcdHQuYWZ0ZXIoKCkgPT4ge1xuXHRcdFx0aWYgKG9yaWdFbnYgPT09IHVuZGVmaW5lZCkge1xuXHRcdFx0XHRkZWxldGUgcHJvY2Vzcy5lbnYuT1BFTlJPVVRFUl9BUElfS0VZO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0cHJvY2Vzcy5lbnYuT1BFTlJPVVRFUl9BUElfS0VZID0gb3JpZ0Vudjtcblx0XHRcdH1cblx0XHR9KTtcblxuXHRcdHN0b3JhZ2Uuc2V0RmFsbGJhY2tSZXNvbHZlcigocHJvdmlkZXIpID0+XG5cdFx0XHRwcm92aWRlciA9PT0gXCJvcGVucm91dGVyXCIgPyBcInNrLW9yLXYxLWZhbGxiYWNrXCIgOiB1bmRlZmluZWQsXG5cdFx0KTtcblxuXHRcdGNvbnN0IGtleSA9IGF3YWl0IHN0b3JhZ2UuZ2V0QXBpS2V5KFwib3BlbnJvdXRlclwiKTtcblx0XHRhc3NlcnQuZXF1YWwoa2V5LCBcInNrLW9yLXYxLWZhbGxiYWNrXCIpO1xuXHR9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgR2VtaW5pIENMSSBPQXV0aCB0b2tlbiBkZXRlY3Rpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiQXV0aFN0b3JhZ2UgXHUyMDE0IEdlbWluaSBDTEkgT0F1dGggdG9rZW4gZGV0ZWN0aW9uXCIsICgpID0+IHtcblx0aXQoXCJyZWplY3RzIEdvb2dsZSBPQXV0aCBhY2Nlc3MgdG9rZW4gKHlhMjkuIHByZWZpeCkgc3RvcmVkIGFzIGFwaV9rZXkgZm9yIGdvb2dsZSBwcm92aWRlclwiLCAoKSA9PiB7XG5cdFx0Y29uc3Qgc3RvcmFnZSA9IGluTWVtb3J5KHt9KTtcblx0XHRhc3NlcnQudGhyb3dzKFxuXHRcdFx0KCkgPT4gc3RvcmFnZS5zZXQoXCJnb29nbGVcIiwgbWFrZUtleShcInlhMjkuYTBBUnJkYU1fZmFrZV9vYXV0aF90b2tlbl9mcm9tX2dlbWluaV9jbGlcIikpLFxuXHRcdFx0KGVycjogRXJyb3IpID0+IHtcblx0XHRcdFx0YXNzZXJ0Lm9rKGVyci5tZXNzYWdlLmluY2x1ZGVzKFwiT0F1dGggYWNjZXNzIHRva2VuXCIpLCBgRXhwZWN0ZWQgbWVzc2FnZSBhYm91dCBPQXV0aCB0b2tlbiwgZ290OiAke2Vyci5tZXNzYWdlfWApO1xuXHRcdFx0XHRhc3NlcnQub2soXG5cdFx0XHRcdFx0ZXJyLm1lc3NhZ2UuaW5jbHVkZXMoXCJHRU1JTklfQVBJX0tFWVwiKSB8fCBlcnIubWVzc2FnZS5pbmNsdWRlcyhcImdvb2dsZS1nZW1pbmktY2xpXCIpLFxuXHRcdFx0XHRcdGBFeHBlY3RlZCBndWlkYW5jZSBhYm91dCBHRU1JTklfQVBJX0tFWSBvciBnb29nbGUtZ2VtaW5pLWNsaSwgZ290OiAke2Vyci5tZXNzYWdlfWAsXG5cdFx0XHRcdCk7XG5cdFx0XHRcdHJldHVybiB0cnVlO1xuXHRcdFx0fSxcblx0XHQpO1xuXHR9KTtcblxuXHRpdChcInJlamVjdHMgR29vZ2xlIE9BdXRoIGFjY2VzcyB0b2tlbiBmb3IgZ29vZ2xlIHByb3ZpZGVyIHZpYSBnZXRBcGlLZXkgd2hlbiBzZXQgYXMgZW52IHZhclwiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3Qgc3RvcmFnZSA9IGluTWVtb3J5KHt9KTtcblx0XHQvLyBTaW11bGF0ZSBydW50aW1lIG92ZXJyaWRlIHdpdGggT0F1dGggdG9rZW5cblx0XHRzdG9yYWdlLnNldFJ1bnRpbWVBcGlLZXkoXCJnb29nbGVcIiwgXCJ5YTI5LmMuYjBBWHYwelRQUV9mYWtlX29hdXRoX3Rva2VuXCIpO1xuXHRcdGNvbnN0IGtleSA9IGF3YWl0IHN0b3JhZ2UuZ2V0QXBpS2V5KFwiZ29vZ2xlXCIpO1xuXHRcdC8vIFNob3VsZCByZXR1cm4gdW5kZWZpbmVkIChibG9ja2VkKSBvciB0aHJvd1xuXHRcdGFzc2VydC5lcXVhbChrZXksIHVuZGVmaW5lZCwgXCJPQXV0aCB0b2tlbiBzaG91bGQgYmUgYmxvY2tlZCBmb3IgZ29vZ2xlIHByb3ZpZGVyXCIpO1xuXHR9KTtcblxuXHRpdChcImFsbG93cyBsZWdpdGltYXRlIEdvb2dsZSBBUEkga2V5cyAoQUl6YSBwcmVmaXgpIGZvciBnb29nbGUgcHJvdmlkZXJcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHN0b3JhZ2UgPSBpbk1lbW9yeSh7fSk7XG5cdFx0c3RvcmFnZS5zZXQoXCJnb29nbGVcIiwgbWFrZUtleShcIkFJemFTeURfZmFrZV9sZWdpdGltYXRlX2FwaV9rZXlfaGVyZVwiKSk7XG5cdFx0Y29uc3QgY3JlZHMgPSBzdG9yYWdlLmdldENyZWRlbnRpYWxzRm9yUHJvdmlkZXIoXCJnb29nbGVcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKGNyZWRzLmxlbmd0aCwgMSk7XG5cdH0pO1xuXG5cdGl0KFwiYWxsb3dzIHlhMjkgdG9rZW5zIGZvciBnb29nbGUtZ2VtaW5pLWNsaSBwcm92aWRlciAoT0F1dGggaXMgZXhwZWN0ZWQgdGhlcmUpXCIsICgpID0+IHtcblx0XHQvLyBnb29nbGUtZ2VtaW5pLWNsaSBzdG9yZXMgT0F1dGggY3JlZGVudGlhbHMgd2l0aCB0eXBlOiBcIm9hdXRoXCIsIG5vdCBcImFwaV9rZXlcIlxuXHRcdC8vIEJ1dCBpZiBzb21lb25lIHNvbWVob3cgc3RvcmVkIGFuIGFwaV9rZXksIGl0IHNob3VsZG4ndCBiZSBibG9ja2VkIGZvciBPQXV0aCBwcm92aWRlcnNcblx0XHRjb25zdCBzdG9yYWdlID0gaW5NZW1vcnkoe30pO1xuXHRcdHN0b3JhZ2Uuc2V0KFwiZ29vZ2xlLWdlbWluaS1jbGlcIiwgbWFrZUtleShcInlhMjkuYTBBUnJkYU1fdG9rZW5fZm9yX2dlbWluaV9jbGlcIikpO1xuXHRcdGNvbnN0IGNyZWRzID0gc3RvcmFnZS5nZXRDcmVkZW50aWFsc0ZvclByb3ZpZGVyKFwiZ29vZ2xlLWdlbWluaS1jbGlcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKGNyZWRzLmxlbmd0aCwgMSk7XG5cdH0pO1xuXG5cdGl0KFwicmVqZWN0cyBHb29nbGUgT0F1dGggdG9rZW4gKHlhMjkuIHByZWZpeCkgZm9yIG9wZW5haSBwcm92aWRlciB0aGF0IHVzZXMgR0VNSU5JX0FQSV9LRVkgaW5kaXJlY3RseVwiLCAoKSA9PiB7XG5cdFx0Ly8gT25seSBnb29nbGUgcHJvdmlkZXIgc2hvdWxkIGJlIGJsb2NrZWQsIG5vdCBvdGhlcnNcblx0XHRjb25zdCBzdG9yYWdlID0gaW5NZW1vcnkoe30pO1xuXHRcdC8vIFRoaXMgc2hvdWxkIE5PVCB0aHJvdyAtIG90aGVyIHByb3ZpZGVycyBjYW4gaGF2ZSB3aGF0ZXZlciBrZXlzIHRoZXkgd2FudFxuXHRcdHN0b3JhZ2Uuc2V0KFwib3BlbmFpXCIsIG1ha2VLZXkoXCJ5YTI5LnNvbWVfdmFsdWVcIikpO1xuXHRcdGNvbnN0IGNyZWRzID0gc3RvcmFnZS5nZXRDcmVkZW50aWFsc0ZvclByb3ZpZGVyKFwib3BlbmFpXCIpO1xuXHRcdGFzc2VydC5lcXVhbChjcmVkcy5sZW5ndGgsIDEpO1xuXHR9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgZ2V0QWxsIHRydW5jYXRpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiQXV0aFN0b3JhZ2UgXHUyMDE0IGdldEFsbCgpXCIsICgpID0+IHtcblx0aXQoXCJyZXR1cm5zIGZpcnN0IGNyZWRlbnRpYWwgb25seSBmb3IgcHJvdmlkZXJzIHdpdGggbXVsdGlwbGUga2V5c1wiLCAoKSA9PiB7XG5cdFx0Y29uc3Qgc3RvcmFnZSA9IGluTWVtb3J5KHtcblx0XHRcdGFudGhyb3BpYzogW21ha2VLZXkoXCJzay0xXCIpLCBtYWtlS2V5KFwic2stMlwiKV0sXG5cdFx0XHRvcGVuYWk6IG1ha2VLZXkoXCJzay1vcGVuYWlcIiksXG5cdFx0fSk7XG5cdFx0Y29uc3QgYWxsID0gc3RvcmFnZS5nZXRBbGwoKTtcblx0XHRhc3NlcnQub2soYWxsW1wiYW50aHJvcGljXCJdPy50eXBlID09PSBcImFwaV9rZXlcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKChhbGxbXCJhbnRocm9waWNcIl0gYXMgYW55KS5rZXksIFwic2stMVwiKTtcblx0XHRhc3NlcnQuZXF1YWwoKGFsbFtcIm9wZW5haVwiXSBhcyBhbnkpLmtleSwgXCJzay1vcGVuYWlcIik7XG5cdH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBnZXRFYXJsaWVzdEJhY2tvZmZFeHBpcnkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiQXV0aFN0b3JhZ2UgXHUyMDE0IGdldEVhcmxpZXN0QmFja29mZkV4cGlyeVwiLCAoKSA9PiB7XG5cdGl0KFwicmV0dXJucyB1bmRlZmluZWQgd2hlbiBubyBjcmVkZW50aWFscyBhcmUgY29uZmlndXJlZCBmb3IgdGhlIHByb3ZpZGVyXCIsICgpID0+IHtcblx0XHRjb25zdCBzdG9yYWdlID0gaW5NZW1vcnkoe30pO1xuXHRcdGFzc2VydC5lcXVhbChzdG9yYWdlLmdldEVhcmxpZXN0QmFja29mZkV4cGlyeShcImFudGhyb3BpY1wiKSwgdW5kZWZpbmVkKTtcblx0fSk7XG5cblx0aXQoXCJyZXR1cm5zIHVuZGVmaW5lZCB3aGVuIGNyZWRlbnRpYWxzIGV4aXN0IGJ1dCBub25lIGFyZSBiYWNrZWQgb2ZmXCIsICgpID0+IHtcblx0XHRjb25zdCBzdG9yYWdlID0gaW5NZW1vcnkoeyBhbnRocm9waWM6IG1ha2VLZXkoXCJzay1vbmx5XCIpIH0pO1xuXHRcdC8vIE5vIG1hcmtVc2FnZUxpbWl0UmVhY2hlZCBjYWxsIFx1MjAxNCBjcmVkZW50aWFsQmFja29mZiBtYXAgaXMgZW1wdHlcblx0XHRhc3NlcnQuZXF1YWwoc3RvcmFnZS5nZXRFYXJsaWVzdEJhY2tvZmZFeHBpcnkoXCJhbnRocm9waWNcIiksIHVuZGVmaW5lZCk7XG5cdH0pO1xuXG5cdGl0KFwicmV0dXJucyBhIGZ1dHVyZSB0aW1lc3RhbXAgd2hlbiBhIHNpbmdsZSBjcmVkZW50aWFsIGlzIGJhY2tlZCBvZmZcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IHN0b3JhZ2UgPSBpbk1lbW9yeSh7IGFudGhyb3BpYzogbWFrZUtleShcInNrLW9ubHlcIikgfSk7XG5cdFx0YXdhaXQgc3RvcmFnZS5nZXRBcGlLZXkoXCJhbnRocm9waWNcIik7XG5cdFx0c3RvcmFnZS5tYXJrVXNhZ2VMaW1pdFJlYWNoZWQoXCJhbnRocm9waWNcIik7XG5cblx0XHRjb25zdCBleHBpcnkgPSBzdG9yYWdlLmdldEVhcmxpZXN0QmFja29mZkV4cGlyeShcImFudGhyb3BpY1wiKTtcblx0XHRhc3NlcnQub2soZXhwaXJ5ICE9PSB1bmRlZmluZWQsIFwic2hvdWxkIHJldHVybiBhIHRpbWVzdGFtcFwiKTtcblx0XHRhc3NlcnQub2soZXhwaXJ5ID4gRGF0ZS5ub3coKSwgXCJleHBpcnkgc2hvdWxkIGJlIGluIHRoZSBmdXR1cmVcIik7XG5cdH0pO1xuXG5cdGl0KFwicmV0dXJucyB0aGUgZWFybGllc3QgZXhwaXJ5IHdoZW4gbXVsdGlwbGUgY3JlZGVudGlhbHMgYXJlIGJhY2tlZCBvZmZcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IHN0b3JhZ2UgPSBpbk1lbW9yeSh7XG5cdFx0XHRhbnRocm9waWM6IFttYWtlS2V5KFwic2stMVwiKSwgbWFrZUtleShcInNrLTJcIildLFxuXHRcdH0pO1xuXG5cdFx0Ly8gQmFjayBvZmYgYm90aCBjcmVkZW50aWFscyB3aXRoIHRoZSBkZWZhdWx0IHJhdGVfbGltaXQgYmFja29mZiAoMzAgcylcblx0XHRhd2FpdCBzdG9yYWdlLmdldEFwaUtleShcImFudGhyb3BpY1wiKTsgLy8gdXNlcyBpbmRleCAwXG5cdFx0c3RvcmFnZS5tYXJrVXNhZ2VMaW1pdFJlYWNoZWQoXCJhbnRocm9waWNcIik7IC8vIGJhY2tzIG9mZiBpbmRleCAwXG5cdFx0YXdhaXQgc3RvcmFnZS5nZXRBcGlLZXkoXCJhbnRocm9waWNcIik7IC8vIHVzZXMgaW5kZXggMVxuXHRcdHN0b3JhZ2UubWFya1VzYWdlTGltaXRSZWFjaGVkKFwiYW50aHJvcGljXCIpOyAvLyBiYWNrcyBvZmYgaW5kZXggMVxuXG5cdFx0Y29uc3QgZXhwaXJ5ID0gc3RvcmFnZS5nZXRFYXJsaWVzdEJhY2tvZmZFeHBpcnkoXCJhbnRocm9waWNcIik7XG5cdFx0YXNzZXJ0Lm9rKGV4cGlyeSAhPT0gdW5kZWZpbmVkLCBcInNob3VsZCByZXR1cm4gYSB0aW1lc3RhbXBcIik7XG5cdFx0YXNzZXJ0Lm9rKGV4cGlyeSA+IERhdGUubm93KCksIFwiZXhwaXJ5IHNob3VsZCBiZSBpbiB0aGUgZnV0dXJlXCIpO1xuXHR9KTtcblxuXHRpdChcInJldHVybnMgdW5kZWZpbmVkIGFmdGVyIGJhY2tlZC1vZmYgY3JlZGVudGlhbHMgZXhwaXJlIChjbGVhbnMgdXAgZW50cmllcylcIiwgKCkgPT4ge1xuXHRcdC8vIE1hbnVhbGx5IGluamVjdCBhbiBhbHJlYWR5LWV4cGlyZWQgYmFja29mZiBlbnRyeSBzbyB3ZSBjYW4gdGVzdFxuXHRcdC8vIHRoZSBjbGVhbnVwIHBhdGggd2l0aG91dCBhY3R1YWxseSB3YWl0aW5nIDMwIHNlY29uZHMuXG5cdFx0Y29uc3Qgc3RvcmFnZSA9IGluTWVtb3J5KHsgYW50aHJvcGljOiBtYWtlS2V5KFwic2stb25seVwiKSB9KTtcblxuXHRcdC8vIEFjY2VzcyBwcml2YXRlIGNyZWRlbnRpYWxCYWNrb2ZmIG1hcCB2aWEgdHlwZSBhc3NlcnRpb24gdG8gaW5qZWN0IGV4cGlyZWQgZW50cnlcblx0XHRjb25zdCBjcmVkZW50aWFsQmFja29mZjogTWFwPHN0cmluZywgTWFwPG51bWJlciwgbnVtYmVyPj4gPVxuXHRcdFx0KHN0b3JhZ2UgYXMgYW55KS5jcmVkZW50aWFsQmFja29mZjtcblx0XHRjb25zdCBwcm92aWRlck1hcCA9IG5ldyBNYXA8bnVtYmVyLCBudW1iZXI+KCk7XG5cdFx0Ly8gZXhwaXJlc0F0IGluIHRoZSBwYXN0XG5cdFx0cHJvdmlkZXJNYXAuc2V0KDAsIERhdGUubm93KCkgLSAxXzAwMCk7XG5cdFx0Y3JlZGVudGlhbEJhY2tvZmYuc2V0KFwiYW50aHJvcGljXCIsIHByb3ZpZGVyTWFwKTtcblxuXHRcdC8vIGdldEVhcmxpZXN0QmFja29mZkV4cGlyeSBzaG91bGQgY2xlYW4gdXAgdGhlIGV4cGlyZWQgZW50cnkgYW5kIHJldHVybiB1bmRlZmluZWRcblx0XHRjb25zdCBleHBpcnkgPSBzdG9yYWdlLmdldEVhcmxpZXN0QmFja29mZkV4cGlyeShcImFudGhyb3BpY1wiKTtcblx0XHRhc3NlcnQuZXF1YWwoZXhwaXJ5LCB1bmRlZmluZWQpO1xuXG5cdFx0Ly8gQ29uZmlybSB0aGUgZXhwaXJlZCBlbnRyeSB3YXMgcmVtb3ZlZCBmcm9tIHRoZSBtYXBcblx0XHRhc3NlcnQuZXF1YWwocHJvdmlkZXJNYXAuc2l6ZSwgMCwgXCJleHBpcmVkIGVudHJ5IHNob3VsZCBoYXZlIGJlZW4gZGVsZXRlZFwiKTtcblx0fSk7XG5cblx0aXQoXCJyZXR1cm5zIHVuZGVmaW5lZCB3aGVuIHByb3ZpZGVyIGlzIG5vdCBpbiBjcmVkZW50aWFsQmFja29mZiBtYXAgYXQgYWxsXCIsICgpID0+IHtcblx0XHRjb25zdCBzdG9yYWdlID0gaW5NZW1vcnkoeyBvcGVuYWk6IG1ha2VLZXkoXCJzay1vcGVuYWlcIikgfSk7XG5cdFx0Ly8gYW50aHJvcGljIGhhcyBubyBiYWNrb2ZmIG1hcCBlbnRyeSBhdCBhbGxcblx0XHRhc3NlcnQuZXF1YWwoc3RvcmFnZS5nZXRFYXJsaWVzdEJhY2tvZmZFeHBpcnkoXCJhbnRocm9waWNcIiksIHVuZGVmaW5lZCk7XG5cdH0pO1xuXG5cdGl0KFwib25seSByZXR1cm5zIGV4cGlyeSBmb3IgdGhlIHJlcXVlc3RlZCBwcm92aWRlciwgbm90IG90aGVyIHByb3ZpZGVyc1wiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3Qgc3RvcmFnZSA9IGluTWVtb3J5KHtcblx0XHRcdGFudGhyb3BpYzogbWFrZUtleShcInNrLWFudFwiKSxcblx0XHRcdG9wZW5haTogbWFrZUtleShcInNrLW9haVwiKSxcblx0XHR9KTtcblxuXHRcdC8vIEJhY2sgb2ZmIGFudGhyb3BpY1xuXHRcdGF3YWl0IHN0b3JhZ2UuZ2V0QXBpS2V5KFwiYW50aHJvcGljXCIpO1xuXHRcdHN0b3JhZ2UubWFya1VzYWdlTGltaXRSZWFjaGVkKFwiYW50aHJvcGljXCIpO1xuXG5cdFx0Ly8gb3BlbmFpIGlzIG5vdCBiYWNrZWQgb2ZmXG5cdFx0YXNzZXJ0LmVxdWFsKHN0b3JhZ2UuZ2V0RWFybGllc3RCYWNrb2ZmRXhwaXJ5KFwib3BlbmFpXCIpLCB1bmRlZmluZWQpO1xuXG5cdFx0Ly8gYW50aHJvcGljIGlzIGJhY2tlZCBvZmZcblx0XHRjb25zdCBleHBpcnkgPSBzdG9yYWdlLmdldEVhcmxpZXN0QmFja29mZkV4cGlyeShcImFudGhyb3BpY1wiKTtcblx0XHRhc3NlcnQub2soZXhwaXJ5ICE9PSB1bmRlZmluZWQpO1xuXHRcdGFzc2VydC5vayhleHBpcnkgPiBEYXRlLm5vdygpKTtcblx0fSk7XG5cblx0aXQoXCJyZXR1cm5zIHRoZSBtaW5pbXVtIGV4cGlyeSB3aGVuIG9uZSBjcmVkZW50aWFsIGV4cGlyZXMgc29vbmVyIHRoYW4gYW5vdGhlclwiLCAoKSA9PiB7XG5cdFx0Y29uc3Qgc3RvcmFnZSA9IGluTWVtb3J5KHtcblx0XHRcdGFudGhyb3BpYzogW21ha2VLZXkoXCJzay0xXCIpLCBtYWtlS2V5KFwic2stMlwiKV0sXG5cdFx0fSk7XG5cblx0XHRjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuXHRcdGNvbnN0IG5lYXJFeHBpcnkgPSBub3cgKyA1XzAwMDsgICAvLyBleHBpcmVzIGluIDUgc1xuXHRcdGNvbnN0IGZhckV4cGlyeSAgPSBub3cgKyAzMF8wMDA7ICAvLyBleHBpcmVzIGluIDMwIHNcblxuXHRcdC8vIEluamVjdCB0d28gZGlmZmVyZW50IGJhY2tvZmYgZXhwaXJpZXMgbWFudWFsbHlcblx0XHRjb25zdCBjcmVkZW50aWFsQmFja29mZjogTWFwPHN0cmluZywgTWFwPG51bWJlciwgbnVtYmVyPj4gPVxuXHRcdFx0KHN0b3JhZ2UgYXMgYW55KS5jcmVkZW50aWFsQmFja29mZjtcblx0XHRjb25zdCBwcm92aWRlck1hcCA9IG5ldyBNYXA8bnVtYmVyLCBudW1iZXI+KCk7XG5cdFx0cHJvdmlkZXJNYXAuc2V0KDAsIG5lYXJFeHBpcnkpO1xuXHRcdHByb3ZpZGVyTWFwLnNldCgxLCBmYXJFeHBpcnkpO1xuXHRcdGNyZWRlbnRpYWxCYWNrb2ZmLnNldChcImFudGhyb3BpY1wiLCBwcm92aWRlck1hcCk7XG5cblx0XHRjb25zdCBleHBpcnkgPSBzdG9yYWdlLmdldEVhcmxpZXN0QmFja29mZkV4cGlyeShcImFudGhyb3BpY1wiKTtcblx0XHRhc3NlcnQuZXF1YWwoZXhwaXJ5LCBuZWFyRXhwaXJ5LCBcInNob3VsZCByZXR1cm4gdGhlIG5lYXJlc3QgKHNtYWxsZXN0KSBleHBpcnlcIik7XG5cdH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBsb2NhbGhvc3QgYmFzZVVybCBzaG9ydGN1dCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJBdXRoU3RvcmFnZSBcdTIwMTQgbG9jYWxob3N0IGJhc2VVcmwgc2hvcnRjdXRcIiwgKCkgPT4ge1xuXHRpdChcInJldHVybnMgJ2xvY2FsLW5vLWtleS1uZWVkZWQnIGZvciBsb2NhbGhvc3QgcHJvdmlkZXIgd2l0aCBubyBjb25maWd1cmVkIGtleVwiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3Qgc3RvcmFnZSA9IGluTWVtb3J5KHt9KTtcblx0XHRjb25zdCBrZXkgPSBhd2FpdCBzdG9yYWdlLmdldEFwaUtleShcIm9sbGFtYVwiLCB1bmRlZmluZWQsIHsgYmFzZVVybDogXCJodHRwOi8vbG9jYWxob3N0OjExNDM0XCIgfSk7XG5cdFx0YXNzZXJ0LmVxdWFsKGtleSwgXCJsb2NhbC1uby1rZXktbmVlZGVkXCIpO1xuXHR9KTtcblxuXHRpdChcInJldHVybnMgJ2xvY2FsLW5vLWtleS1uZWVkZWQnIGZvciAxMjcuMC4wLjEgcHJvdmlkZXIgd2l0aCBubyBjb25maWd1cmVkIGtleVwiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3Qgc3RvcmFnZSA9IGluTWVtb3J5KHt9KTtcblx0XHRjb25zdCBrZXkgPSBhd2FpdCBzdG9yYWdlLmdldEFwaUtleShcImN1c3RvbVwiLCB1bmRlZmluZWQsIHsgYmFzZVVybDogXCJodHRwOi8vMTI3LjAuMC4xOjgwODAvdjFcIiB9KTtcblx0XHRhc3NlcnQuZXF1YWwoa2V5LCBcImxvY2FsLW5vLWtleS1uZWVkZWRcIik7XG5cdH0pO1xuXG5cdGl0KFwicmV0dXJucyBjb25maWd1cmVkIGtleSBmcm9tIGZhbGxiYWNrIHJlc29sdmVyIGZvciBsb2NhbGhvc3QgY3VzdG9tIHByb3ZpZGVyICgjNDEwNilcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdC8vIFJlZ3Jlc3Npb24gdGVzdDogY29tcGFjdGlvbiBjYWxsZWQgZ2V0QXBpS2V5KG1vZGVsKSB3aGVyZSBtb2RlbC5iYXNlVXJsIGlzIGxvY2FsaG9zdC5cblx0XHQvLyBUaGUgbG9jYWxob3N0IHNob3J0Y3V0IG11c3QgTk9UIG92ZXJyaWRlIGFuIGV4cGxpY2l0bHkgY29uZmlndXJlZCBhcGlLZXkgZnJvbSBtb2RlbHMuanNvbi5cblx0XHRjb25zdCBzdG9yYWdlID0gaW5NZW1vcnkoe30pO1xuXHRcdHN0b3JhZ2Uuc2V0RmFsbGJhY2tSZXNvbHZlcigocHJvdmlkZXIpID0+XG5cdFx0XHRwcm92aWRlciA9PT0gXCJjbGlwcm94eVwiID8gXCJzay1yZWFsLXByb3h5LWtleVwiIDogdW5kZWZpbmVkLFxuXHRcdCk7XG5cblx0XHRjb25zdCBrZXkgPSBhd2FpdCBzdG9yYWdlLmdldEFwaUtleShcImNsaXByb3h5XCIsIHVuZGVmaW5lZCwgeyBiYXNlVXJsOiBcImh0dHA6Ly9sb2NhbGhvc3Q6ODMxNy92MVwiIH0pO1xuXHRcdGFzc2VydC5lcXVhbChrZXksIFwic2stcmVhbC1wcm94eS1rZXlcIik7XG5cdH0pO1xuXG5cdGl0KFwicmV0dXJucyBjb25maWd1cmVkIGtleSBmcm9tIGZhbGxiYWNrIHJlc29sdmVyIHdoZW4gYmFzZVVybCB1c2VzIDEyNy4wLjAuMSAoIzQxMDYpXCIsIGFzeW5jICgpID0+IHtcblx0XHRjb25zdCBzdG9yYWdlID0gaW5NZW1vcnkoe30pO1xuXHRcdHN0b3JhZ2Uuc2V0RmFsbGJhY2tSZXNvbHZlcigocHJvdmlkZXIpID0+XG5cdFx0XHRwcm92aWRlciA9PT0gXCJteXByb3h5XCIgPyBcInNrLW15cHJveHkta2V5XCIgOiB1bmRlZmluZWQsXG5cdFx0KTtcblxuXHRcdGNvbnN0IGtleSA9IGF3YWl0IHN0b3JhZ2UuZ2V0QXBpS2V5KFwibXlwcm94eVwiLCB1bmRlZmluZWQsIHsgYmFzZVVybDogXCJodHRwOi8vMTI3LjAuMC4xOjkwMDAvdjFcIiB9KTtcblx0XHRhc3NlcnQuZXF1YWwoa2V5LCBcInNrLW15cHJveHkta2V5XCIpO1xuXHR9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgaGFzTGVnYWN5T0F1dGhDcmVkZW50aWFsIChBbnRocm9waWMgT0F1dGggcmVtb3ZlZCBpbiB2Mi43NC4wLCAjMzk1MikgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiQXV0aFN0b3JhZ2UgXHUyMDE0IGhhc0xlZ2FjeU9BdXRoQ3JlZGVudGlhbCAoIzQyODApXCIsICgpID0+IHtcblx0aXQoXCJyZXR1cm5zIHRydWUgd2hlbiBhbnRocm9waWMgaGFzIGEgdHlwZTpvYXV0aCBjcmVkZW50aWFsXCIsICgpID0+IHtcblx0XHRjb25zdCBzdG9yYWdlID0gaW5NZW1vcnkoe1xuXHRcdFx0YW50aHJvcGljOiB7XG5cdFx0XHRcdHR5cGU6IFwib2F1dGhcIixcblx0XHRcdFx0YWNjZXNzOiBcInlhMjkuZmFrZS1hY2Nlc3MtdG9rZW5cIixcblx0XHRcdFx0cmVmcmVzaDogXCIxLy9mYWtlLXJlZnJlc2gtdG9rZW5cIixcblx0XHRcdFx0ZXhwaXJlczogRGF0ZS5ub3coKSArIDNfNjAwXzAwMCxcblx0XHRcdH0sXG5cdFx0fSk7XG5cdFx0YXNzZXJ0LmVxdWFsKHN0b3JhZ2UuaGFzTGVnYWN5T0F1dGhDcmVkZW50aWFsKFwiYW50aHJvcGljXCIpLCB0cnVlKTtcblx0fSk7XG5cblx0aXQoXCJyZXR1cm5zIGZhbHNlIHdoZW4gYW50aHJvcGljIGhhcyBhbiBhcGlfa2V5IGNyZWRlbnRpYWxcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHN0b3JhZ2UgPSBpbk1lbW9yeSh7IGFudGhyb3BpYzogbWFrZUtleShcInNrLWFudC1mYWtlXCIpIH0pO1xuXHRcdGFzc2VydC5lcXVhbChzdG9yYWdlLmhhc0xlZ2FjeU9BdXRoQ3JlZGVudGlhbChcImFudGhyb3BpY1wiKSwgZmFsc2UpO1xuXHR9KTtcblxuXHRpdChcInJldHVybnMgZmFsc2Ugd2hlbiBhbnRocm9waWMgaGFzIG5vIGNyZWRlbnRpYWwgYXQgYWxsXCIsICgpID0+IHtcblx0XHRjb25zdCBzdG9yYWdlID0gaW5NZW1vcnkoe30pO1xuXHRcdGFzc2VydC5lcXVhbChzdG9yYWdlLmhhc0xlZ2FjeU9BdXRoQ3JlZGVudGlhbChcImFudGhyb3BpY1wiKSwgZmFsc2UpO1xuXHR9KTtcblxuXHRpdChcInJldHVybnMgZmFsc2UgZm9yIGEgcHJvdmlkZXIgd2l0aCBhIGxlZ2l0aW1hdGUgT0F1dGggY3JlZGVudGlhbCAoZS5nLiBnaXRodWItY29waWxvdClcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHN0b3JhZ2UgPSBpbk1lbW9yeSh7XG5cdFx0XHRcImdpdGh1Yi1jb3BpbG90XCI6IHtcblx0XHRcdFx0dHlwZTogXCJvYXV0aFwiLFxuXHRcdFx0XHRhY2Nlc3M6IFwiZ2hvX2Zha2UtdG9rZW5cIixcblx0XHRcdFx0cmVmcmVzaDogXCJnaHJfZmFrZS1yZWZyZXNoXCIsXG5cdFx0XHRcdGV4cGlyZXM6IERhdGUubm93KCkgKyAyOF84MDBfMDAwLFxuXHRcdFx0fSxcblx0XHR9KTtcblx0XHQvLyBoYXNMZWdhY3lPQXV0aENyZWRlbnRpYWwgaXMgaW50ZW50aW9uYWxseSBwcm92aWRlci1zY29wZWQgXHUyMDE0IGNhbGxpbmcgaXRcblx0XHQvLyBmb3IgYSBwcm92aWRlciB0aGF0IHN0aWxsIHN1cHBvcnRzIE9BdXRoIChsaWtlIGdpdGh1Yi1jb3BpbG90KSBpcyBub3Rcblx0XHQvLyBleHBlY3RlZCBpbiBwcm9kdWN0aW9uLCBidXQgdGhlIG1ldGhvZCBtdXN0IG5vdCBleHBsb2RlLlxuXHRcdGFzc2VydC5lcXVhbChzdG9yYWdlLmhhc0xlZ2FjeU9BdXRoQ3JlZGVudGlhbChcImdpdGh1Yi1jb3BpbG90XCIpLCB0cnVlKTtcblx0fSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHJlbW92ZUxlZ2FjeU9BdXRoQ3JlZGVudGlhbCAoc2VsZi1oZWFsIGZvciAjMzk1MiAvICM0MzY4KSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJBdXRoU3RvcmFnZSBcdTIwMTQgcmVtb3ZlTGVnYWN5T0F1dGhDcmVkZW50aWFsICgjNDM2OClcIiwgKCkgPT4ge1xuXHRpdChcInJlbW92ZXMgb2F1dGggZW50cnkgYW5kIHJldHVybnMgdHJ1ZSB3aGVuIHByZXNlbnRcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHN0b3JhZ2UgPSBpbk1lbW9yeSh7XG5cdFx0XHRhbnRocm9waWM6IHtcblx0XHRcdFx0dHlwZTogXCJvYXV0aFwiLFxuXHRcdFx0XHRhY2Nlc3M6IFwiZmFrZVwiLFxuXHRcdFx0XHRyZWZyZXNoOiBcImZha2VcIixcblx0XHRcdFx0ZXhwaXJlczogRGF0ZS5ub3coKSArIDNfNjAwXzAwMCxcblx0XHRcdH0sXG5cdFx0fSk7XG5cdFx0YXNzZXJ0LmVxdWFsKHN0b3JhZ2UucmVtb3ZlTGVnYWN5T0F1dGhDcmVkZW50aWFsKFwiYW50aHJvcGljXCIpLCB0cnVlKTtcblx0XHRhc3NlcnQuZXF1YWwoc3RvcmFnZS5oYXNMZWdhY3lPQXV0aENyZWRlbnRpYWwoXCJhbnRocm9waWNcIiksIGZhbHNlKTtcblx0XHRhc3NlcnQuZXF1YWwoc3RvcmFnZS5oYXMoXCJhbnRocm9waWNcIiksIGZhbHNlKTtcblx0fSk7XG5cblx0aXQoXCJyZXR1cm5zIGZhbHNlIHdoZW4gbm8gb2F1dGggZW50cnkgZXhpc3RzXCIsICgpID0+IHtcblx0XHRjb25zdCBzdG9yYWdlID0gaW5NZW1vcnkoeyBhbnRocm9waWM6IG1ha2VLZXkoXCJzay1hbnQtZmFrZVwiKSB9KTtcblx0XHRhc3NlcnQuZXF1YWwoc3RvcmFnZS5yZW1vdmVMZWdhY3lPQXV0aENyZWRlbnRpYWwoXCJhbnRocm9waWNcIiksIGZhbHNlKTtcblx0XHRhc3NlcnQuZXF1YWwoc3RvcmFnZS5nZXQoXCJhbnRocm9waWNcIik/LnR5cGUsIFwiYXBpX2tleVwiKTtcblx0fSk7XG5cblx0aXQoXCJwcmVzZXJ2ZXMgYXBpX2tleSBjcmVkZW50aWFscyBhbG9uZ3NpZGUgb2F1dGggZW50cnlcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHN0b3JhZ2UgPSBpbk1lbW9yeSh7XG5cdFx0XHRhbnRocm9waWM6IFtcblx0XHRcdFx0bWFrZUtleShcInNrLWFudC1rZWVwXCIpLFxuXHRcdFx0XHR7XG5cdFx0XHRcdFx0dHlwZTogXCJvYXV0aFwiLFxuXHRcdFx0XHRcdGFjY2VzczogXCJmYWtlXCIsXG5cdFx0XHRcdFx0cmVmcmVzaDogXCJmYWtlXCIsXG5cdFx0XHRcdFx0ZXhwaXJlczogRGF0ZS5ub3coKSArIDNfNjAwXzAwMCxcblx0XHRcdFx0fSxcblx0XHRcdF0sXG5cdFx0fSk7XG5cdFx0YXNzZXJ0LmVxdWFsKHN0b3JhZ2UucmVtb3ZlTGVnYWN5T0F1dGhDcmVkZW50aWFsKFwiYW50aHJvcGljXCIpLCB0cnVlKTtcblx0XHRjb25zdCByZW1haW5pbmcgPSBzdG9yYWdlLmdldENyZWRlbnRpYWxzRm9yUHJvdmlkZXIoXCJhbnRocm9waWNcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlbWFpbmluZy5sZW5ndGgsIDEpO1xuXHRcdGFzc2VydC5lcXVhbChyZW1haW5pbmdbMF0udHlwZSwgXCJhcGlfa2V5XCIpO1xuXHR9KTtcbn0pO1xuIl0sCiAgIm1hcHBp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
