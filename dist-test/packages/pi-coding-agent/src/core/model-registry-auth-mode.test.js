import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getApiProvider } from "@gsd/pi-ai";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";
function createRegistry(hasAuthFn, getApiKeyFn) {
  const authStorage = {
    setFallbackResolver: () => {
    },
    onCredentialChange: () => {
    },
    getOAuthProviders: () => [],
    get: () => void 0,
    hasAuth: hasAuthFn ?? (() => false),
    getApiKey: async (provider) => getApiKeyFn ? getApiKeyFn(provider) : void 0
  };
  return new ModelRegistry(authStorage, "");
}
function createInMemoryRegistry(data = {}) {
  return new ModelRegistry(AuthStorage.inMemory(data), "");
}
function createProviderModel(id, api) {
  return {
    id,
    name: id,
    api: api ?? "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128e3,
    maxTokens: 16384
  };
}
function findModel(registry, provider, id) {
  return registry.getAvailable().find((m) => m.provider === provider && m.id === id);
}
function availableModelIds(registry) {
  return new Set(registry.getAvailable().map((model) => `${model.provider}/${model.id}`));
}
function makeModel(provider, id, api) {
  return {
    id,
    name: id,
    api,
    provider,
    baseUrl: `${provider}:`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128e3,
    maxTokens: 16384
  };
}
function makeContext() {
  return {
    systemPrompt: "test",
    messages: [{ role: "user", content: "hello", timestamp: Date.now() }]
  };
}
const noopStreamSimple = (_model, _context, _options) => {
  return {
    [Symbol.asyncIterator]() {
      return { next: async () => ({ value: void 0, done: true }) };
    },
    result: () => Promise.resolve({ role: "assistant", content: [], api: "test", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() }),
    push: () => {
    },
    end: () => {
    }
  };
};
function createStreamSpy() {
  let capturedOptions;
  const streamSimple = (_model, _context, options) => {
    capturedOptions = options;
    return {
      [Symbol.asyncIterator]() {
        return { next: async () => ({ value: void 0, done: true }) };
      },
      result: () => Promise.resolve({ role: "assistant", content: [], api: "test", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() }),
      push: () => {
      },
      end: () => {
      }
    };
  };
  return { streamSimple, getCapturedOptions: () => capturedOptions };
}
describe("ModelRegistry authMode \u2014 registration", () => {
  it("includes GPT-5.5 in the authenticated all-models menu backing list", () => {
    const registry = createInMemoryRegistry({
      openai: { type: "api_key", key: "sk-test" },
      "openai-codex": {
        type: "oauth",
        access: "codex-access",
        refresh: "codex-refresh",
        expires: Date.now() + 6e4
      }
    });
    const ids = availableModelIds(registry);
    assert.ok(ids.has("openai/gpt-5.5"), "all-models menu backing list should include openai/gpt-5.5");
    assert.ok(ids.has("openai-codex/gpt-5.5"), "all-models menu backing list should include openai-codex/gpt-5.5");
  });
  it("registers externalCli provider with streamSimple and without apiKey/oauth", () => {
    const registry = createRegistry();
    const spy = createStreamSpy();
    assert.doesNotThrow(() => {
      registry.registerProvider("cli-provider", {
        authMode: "externalCli",
        baseUrl: "https://cli.local",
        api: "openai-completions",
        streamSimple: spy.streamSimple,
        models: [createProviderModel("cli-model")]
      });
    });
  });
  it("registers none provider with streamSimple and without apiKey/oauth", () => {
    const registry = createRegistry();
    const spy = createStreamSpy();
    assert.doesNotThrow(() => {
      registry.registerProvider("none-provider", {
        authMode: "none",
        baseUrl: "http://localhost:11434",
        api: "openai-completions",
        streamSimple: spy.streamSimple,
        models: [createProviderModel("local-model")]
      });
    });
  });
  it("rejects apiKey provider without apiKey or oauth \u2014 message mentions authMode", () => {
    const registry = createRegistry();
    assert.throws(() => {
      registry.registerProvider("apikey-provider", {
        authMode: "apiKey",
        baseUrl: "https://api.local",
        api: "openai-completions",
        models: [createProviderModel("model")]
      });
    }, (err) => {
      assert.ok(err.message.includes("authMode"), "error message must mention authMode");
      assert.ok(err.message.includes("externalCli"), "error message must suggest externalCli");
      return true;
    });
  });
  it("rejects provider with no authMode and no apiKey/oauth (defaults to apiKey)", () => {
    const registry = createRegistry();
    assert.throws(() => {
      registry.registerProvider("bare-provider", {
        baseUrl: "https://api.local",
        api: "openai-completions",
        models: [createProviderModel("model")]
      });
    }, (err) => {
      assert.ok(err.message.includes("authMode"), "error message must mention authMode");
      return true;
    });
  });
  it("rejects externalCli provider without streamSimple", () => {
    const registry = createRegistry();
    assert.throws(() => {
      registry.registerProvider("cli-no-stream", {
        authMode: "externalCli",
        baseUrl: "https://cli.local",
        api: "openai-completions",
        models: [createProviderModel("model")]
      });
    }, (err) => {
      assert.ok(err.message.includes("streamSimple"), "error message must mention streamSimple");
      assert.ok(err.message.includes("externalCli"), "error message must mention authMode");
      return true;
    });
  });
  it("rejects none provider without streamSimple", () => {
    const registry = createRegistry();
    assert.throws(() => {
      registry.registerProvider("none-no-stream", {
        authMode: "none",
        baseUrl: "http://localhost:11434",
        api: "openai-completions",
        models: [createProviderModel("model")]
      });
    }, (err) => {
      assert.ok(err.message.includes("streamSimple"), "error message must mention streamSimple");
      assert.ok(err.message.includes("none"), "error message must mention authMode");
      return true;
    });
  });
  it("rejects externalCli provider that also sets apiKey", () => {
    const registry = createRegistry();
    const spy = createStreamSpy();
    assert.throws(() => {
      registry.registerProvider("cli-with-key", {
        authMode: "externalCli",
        baseUrl: "https://cli.local",
        api: "openai-completions",
        apiKey: "SHOULD_NOT_EXIST",
        streamSimple: spy.streamSimple,
        models: [createProviderModel("model")]
      });
    }, (err) => {
      assert.ok(err.message.includes("apiKey"), "error message must mention apiKey");
      assert.ok(err.message.includes("externalCli"), "error message must mention authMode");
      return true;
    });
  });
  it("rejects none provider that also sets apiKey", () => {
    const registry = createRegistry();
    const spy = createStreamSpy();
    assert.throws(() => {
      registry.registerProvider("none-with-key", {
        authMode: "none",
        baseUrl: "http://localhost:11434",
        api: "openai-completions",
        apiKey: "SHOULD_NOT_EXIST",
        streamSimple: spy.streamSimple,
        models: [createProviderModel("model")]
      });
    }, (err) => {
      assert.ok(err.message.includes("apiKey"), "error message must mention apiKey");
      assert.ok(err.message.includes("none"), "error message must mention authMode");
      return true;
    });
  });
});
describe("ModelRegistry authMode \u2014 getProviderAuthMode", () => {
  it("returns apiKey for unregistered (built-in) providers", () => {
    const registry = createRegistry();
    assert.equal(registry.getProviderAuthMode("anthropic"), "apiKey");
  });
  it("returns explicit authMode when set", () => {
    const registry = createRegistry();
    registry.registerProvider("cli", {
      authMode: "externalCli",
      baseUrl: "https://cli.local",
      api: "openai-completions",
      streamSimple: noopStreamSimple,
      models: [createProviderModel("m")]
    });
    assert.equal(registry.getProviderAuthMode("cli"), "externalCli");
  });
  it("returns none when authMode is none", () => {
    const registry = createRegistry();
    registry.registerProvider("local", {
      authMode: "none",
      baseUrl: "http://localhost:11434",
      api: "openai-completions",
      streamSimple: noopStreamSimple,
      models: [createProviderModel("m")]
    });
    assert.equal(registry.getProviderAuthMode("local"), "none");
  });
});
describe("ModelRegistry authMode \u2014 isProviderRequestReady", () => {
  it("returns true for externalCli without stored auth", () => {
    const registry = createRegistry(() => false);
    registry.registerProvider("cli", {
      authMode: "externalCli",
      baseUrl: "https://cli.local",
      api: "openai-completions",
      streamSimple: noopStreamSimple,
      models: [createProviderModel("m")]
    });
    assert.equal(registry.isProviderRequestReady("cli"), true);
  });
  it("returns true for none without stored auth", () => {
    const registry = createRegistry(() => false);
    registry.registerProvider("local", {
      authMode: "none",
      baseUrl: "http://localhost:11434",
      api: "openai-completions",
      streamSimple: noopStreamSimple,
      models: [createProviderModel("m")]
    });
    assert.equal(registry.isProviderRequestReady("local"), true);
  });
  it("returns false for apiKey provider without stored auth", () => {
    const registry = createRegistry(() => false);
    assert.equal(registry.isProviderRequestReady("anthropic"), false);
  });
  it("returns true for apiKey provider with stored auth", () => {
    const registry = createRegistry(() => true);
    assert.equal(registry.isProviderRequestReady("anthropic"), true);
  });
  it("returns false for denylisted providers even when auth exists", () => {
    const registry = createRegistry(() => true);
    registry.setDisabledModelProviders(["anthropic"]);
    assert.equal(registry.isProviderRequestReady("anthropic"), false);
  });
});
describe("ModelRegistry authMode \u2014 isReady callback", () => {
  it("calls isReady and returns its result for externalCli provider", () => {
    const registry = createRegistry(() => false);
    registry.registerProvider("cli-down", {
      authMode: "externalCli",
      baseUrl: "https://cli.local",
      api: "openai-completions",
      streamSimple: noopStreamSimple,
      isReady: () => false,
      models: [createProviderModel("m")]
    });
    assert.equal(registry.isProviderRequestReady("cli-down"), false);
  });
  it("calls isReady for apiKey provider (overrides hasAuth)", () => {
    const registry = createRegistry(() => true);
    registry.registerProvider("strict-provider", {
      apiKey: "MY_KEY",
      baseUrl: "https://api.local",
      api: "openai-completions",
      isReady: () => false,
      models: [createProviderModel("m")]
    });
    assert.equal(registry.isProviderRequestReady("strict-provider"), false);
  });
  it("isReady returning true makes provider available", () => {
    const registry = createRegistry(() => false);
    registry.registerProvider("healthy-cli", {
      authMode: "externalCli",
      baseUrl: "https://cli.local",
      api: "openai-completions",
      streamSimple: noopStreamSimple,
      isReady: () => true,
      models: [createProviderModel("m")]
    });
    assert.equal(registry.isProviderRequestReady("healthy-cli"), true);
  });
  it("falls through to default behavior when isReady not provided", () => {
    const registry = createRegistry(() => false);
    registry.registerProvider("no-callback", {
      authMode: "externalCli",
      baseUrl: "https://cli.local",
      api: "openai-completions",
      streamSimple: noopStreamSimple,
      models: [createProviderModel("m")]
    });
    assert.equal(registry.isProviderRequestReady("no-callback"), true);
  });
});
describe("ModelRegistry authMode \u2014 getAvailable", () => {
  it("includes externalCli models without stored auth", () => {
    const registry = createRegistry(() => false);
    registry.registerProvider("cli", {
      authMode: "externalCli",
      baseUrl: "https://cli.local",
      api: "openai-completions",
      streamSimple: noopStreamSimple,
      models: [createProviderModel("cli-model")]
    });
    assert.ok(findModel(registry, "cli", "cli-model"));
  });
  it("includes none models without stored auth", () => {
    const registry = createRegistry(() => false);
    registry.registerProvider("local", {
      authMode: "none",
      baseUrl: "http://localhost:11434",
      api: "openai-completions",
      streamSimple: noopStreamSimple,
      models: [createProviderModel("local-model")]
    });
    assert.ok(findModel(registry, "local", "local-model"));
  });
  it("excludes externalCli models when isReady returns false", () => {
    const registry = createRegistry(() => false);
    registry.registerProvider("cli-down", {
      authMode: "externalCli",
      baseUrl: "https://cli.local",
      api: "openai-completions",
      streamSimple: noopStreamSimple,
      isReady: () => false,
      models: [createProviderModel("m")]
    });
    assert.equal(findModel(registry, "cli-down", "m"), void 0);
  });
  it("excludes apiKey models without stored auth", () => {
    const registry = createRegistry(() => false);
    const available = registry.getAvailable();
    assert.equal(available.length, 0);
  });
  it("excludes denylisted providers from available models", () => {
    const registry = createRegistry(() => true);
    registry.setDisabledModelProviders(["google-gemini-cli"]);
    const available = registry.getAvailable();
    assert.equal(
      available.some((m) => m.provider === "google-gemini-cli"),
      false,
      "google-gemini-cli models must be hidden when provider is denylisted"
    );
  });
  it("prunes Codex models removed from ChatGPT-backed openai-codex OAuth", () => {
    const registry = createInMemoryRegistry({
      "openai-codex": {
        type: "oauth",
        access: "oauth-access",
        refresh: "oauth-refresh",
        expires: Date.now() + 6e4,
        accountId: "acct_123"
      }
    });
    assert.equal(registry.find("openai-codex", "gpt-5.1-codex-max"), void 0);
    assert.equal(registry.find("openai-codex", "gpt-5.1"), void 0);
    assert.equal(findModel(registry, "openai-codex", "gpt-5.2-codex"), void 0);
    assert.ok(registry.find("openai-codex", "gpt-5.4"));
    assert.ok(findModel(registry, "openai-codex", "gpt-5.4"));
    assert.ok(registry.find("openai-codex", "gpt-5.4-mini"));
    assert.ok(findModel(registry, "openai-codex", "gpt-5.4-mini"));
  });
  it("keeps API-backed OpenAI Codex-capable models available", () => {
    const registry = createInMemoryRegistry({
      openai: {
        type: "api_key",
        key: "sk-test"
      }
    });
    assert.ok(registry.find("openai", "gpt-5.2-codex"));
    assert.ok(findModel(registry, "openai", "gpt-5.2-codex"));
  });
});
describe("ModelRegistry authMode \u2014 getApiKey", () => {
  it("returns undefined for externalCli provider", async () => {
    const registry = createRegistry();
    registry.registerProvider("cli", {
      authMode: "externalCli",
      baseUrl: "https://cli.local",
      api: "openai-completions",
      streamSimple: noopStreamSimple,
      models: [createProviderModel("m")]
    });
    const model = registry.getAll().find((m) => m.provider === "cli");
    assert.equal(await registry.getApiKey(model), void 0);
  });
  it("returns undefined for none provider", async () => {
    const registry = createRegistry();
    registry.registerProvider("local", {
      authMode: "none",
      baseUrl: "http://localhost:11434",
      api: "openai-completions",
      streamSimple: noopStreamSimple,
      models: [createProviderModel("m")]
    });
    const model = registry.getAll().find((m) => m.provider === "local");
    assert.equal(await registry.getApiKey(model), void 0);
  });
  it("delegates to authStorage for apiKey provider", async () => {
    const registry = createRegistry();
    const key = await registry.getApiKeyForProvider("anthropic");
    assert.equal(key, void 0);
  });
  it("still resolves provider keys for denylisted providers", async () => {
    const registry = createRegistry(
      () => true,
      async (provider) => provider === "google-gemini-cli" ? "ya29.test-token" : void 0
    );
    registry.setDisabledModelProviders(["google-gemini-cli"]);
    const key = await registry.getApiKeyForProvider("google-gemini-cli");
    assert.equal(key, "ya29.test-token");
  });
});
describe("ModelRegistry authMode \u2014 streamSimple apiKey boundary", () => {
  it("strips apiKey from options for externalCli provider", () => {
    const registry = createRegistry();
    const spy = createStreamSpy();
    const apiType = `ext-cli-strip-${Date.now()}`;
    registry.registerProvider("cli-strip", {
      authMode: "externalCli",
      baseUrl: "https://cli.local",
      api: apiType,
      streamSimple: spy.streamSimple,
      models: [createProviderModel("m", apiType)]
    });
    const provider = getApiProvider(apiType);
    assert.ok(provider, "provider must be registered in api registry");
    provider.streamSimple(
      makeModel("cli-strip", "m", apiType),
      makeContext(),
      { apiKey: "should-be-stripped", maxTokens: 1024 }
    );
    const captured = spy.getCapturedOptions();
    assert.ok(captured, "streamSimple must have been called");
    assert.equal("apiKey" in captured, false, "apiKey must not exist in options for externalCli provider");
    assert.equal(captured.maxTokens, 1024, "other options must pass through");
  });
  it("strips apiKey from options for none provider", () => {
    const registry = createRegistry();
    const spy = createStreamSpy();
    const apiType = `none-strip-${Date.now()}`;
    registry.registerProvider("none-strip", {
      authMode: "none",
      baseUrl: "http://localhost:11434",
      api: apiType,
      streamSimple: spy.streamSimple,
      models: [createProviderModel("m", apiType)]
    });
    const provider = getApiProvider(apiType);
    assert.ok(provider, "provider must be registered in api registry");
    provider.streamSimple(
      makeModel("none-strip", "m", apiType),
      makeContext(),
      { apiKey: "should-be-stripped", maxTokens: 2048 }
    );
    const captured = spy.getCapturedOptions();
    assert.ok(captured, "streamSimple must have been called");
    assert.equal("apiKey" in captured, false, "apiKey must not exist in options for none provider");
    assert.equal(captured.maxTokens, 2048, "other options must pass through");
  });
  it("preserves apiKey in options for apiKey provider", () => {
    const registry = createRegistry();
    const spy = createStreamSpy();
    const apiType = `apikey-preserve-${Date.now()}`;
    registry.registerProvider("apikey-preserve", {
      apiKey: "MY_KEY",
      baseUrl: "https://api.local",
      api: apiType,
      streamSimple: spy.streamSimple,
      models: [createProviderModel("m", apiType)]
    });
    const provider = getApiProvider(apiType);
    assert.ok(provider, "provider must be registered in api registry");
    provider.streamSimple(
      makeModel("apikey-preserve", "m", apiType),
      makeContext(),
      { apiKey: "sk-real-key", maxTokens: 4096 }
    );
    const captured = spy.getCapturedOptions();
    assert.ok(captured, "streamSimple must have been called");
    assert.equal(captured.apiKey, "sk-real-key", "apiKey must be preserved for apiKey provider");
    assert.equal(captured.maxTokens, 4096, "other options must pass through");
  });
  it("handles undefined options for externalCli provider", () => {
    const registry = createRegistry();
    const spy = createStreamSpy();
    const apiType = `ext-cli-undef-${Date.now()}`;
    registry.registerProvider("cli-undef", {
      authMode: "externalCli",
      baseUrl: "https://cli.local",
      api: apiType,
      streamSimple: spy.streamSimple,
      models: [createProviderModel("m", apiType)]
    });
    const provider = getApiProvider(apiType);
    assert.ok(provider, "provider must be registered in api registry");
    provider.streamSimple(
      makeModel("cli-undef", "m", apiType),
      makeContext(),
      void 0
    );
    const captured = spy.getCapturedOptions();
    assert.ok(captured !== void 0, "streamSimple must have been called");
    assert.equal("apiKey" in captured, false, "apiKey must not exist even when options is undefined");
  });
  it("strips apiKey but preserves signal and other fields for externalCli", () => {
    const registry = createRegistry();
    const spy = createStreamSpy();
    const apiType = `ext-cli-fields-${Date.now()}`;
    const abortController = new AbortController();
    registry.registerProvider("cli-fields", {
      authMode: "externalCli",
      baseUrl: "https://cli.local",
      api: apiType,
      streamSimple: spy.streamSimple,
      models: [createProviderModel("m", apiType)]
    });
    const provider = getApiProvider(apiType);
    assert.ok(provider, "provider must be registered in api registry");
    provider.streamSimple(
      makeModel("cli-fields", "m", apiType),
      makeContext(),
      { apiKey: "strip-me", maxTokens: 8192, signal: abortController.signal, reasoning: "high" }
    );
    const captured = spy.getCapturedOptions();
    assert.ok(captured, "streamSimple must have been called");
    assert.equal("apiKey" in captured, false, "apiKey must be stripped");
    assert.equal(captured.maxTokens, 8192, "maxTokens must pass through");
    assert.equal(captured.signal, abortController.signal, "signal must pass through");
    assert.equal(captured.reasoning, "high", "reasoning must pass through");
  });
});
describe("ModelRegistry authMode \u2014 provider-scoped stream routing", () => {
  it("does not clobber built-in stream handler when custom provider uses same api", () => {
    const registry = createRegistry(() => true);
    const customSpy = createStreamSpy();
    registry.registerProvider("custom-cli", {
      authMode: "externalCli",
      baseUrl: "local://custom",
      api: "anthropic-messages",
      streamSimple: customSpy.streamSimple,
      models: [createProviderModel("custom-model", "anthropic-messages")]
    });
    const provider = getApiProvider("anthropic-messages");
    assert.ok(provider, "anthropic-messages provider must still be registered");
    assert.throws(
      () => provider.streamSimple(
        makeModel("anthropic", "claude-sonnet-4-6", "anthropic-messages"),
        makeContext(),
        { maxTokens: 4096 }
      ),
      (err) => err.message.includes("API key"),
      "built-in Anthropic handler must be invoked (throws because no API key in tests)"
    );
    assert.equal(
      customSpy.getCapturedOptions(),
      void 0,
      "custom provider's streamSimple must NOT be called for anthropic provider models"
    );
  });
  it("routes to custom provider when model.provider matches", () => {
    const registry = createRegistry(() => true);
    const customSpy = createStreamSpy();
    registry.registerProvider("custom-cli", {
      authMode: "externalCli",
      baseUrl: "local://custom",
      api: "anthropic-messages",
      streamSimple: customSpy.streamSimple,
      models: [createProviderModel("custom-model", "anthropic-messages")]
    });
    const provider = getApiProvider("anthropic-messages");
    assert.ok(provider);
    provider.streamSimple(
      makeModel("custom-cli", "custom-model", "anthropic-messages"),
      makeContext(),
      { maxTokens: 2048 }
    );
    const captured = customSpy.getCapturedOptions();
    assert.ok(captured, "custom provider's streamSimple must be called for its own models");
    assert.equal(captured.maxTokens, 2048);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL21vZGVsLXJlZ2lzdHJ5LWF1dGgtbW9kZS50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IGRlc2NyaWJlLCBpdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCB0eXBlIHsgQXBpLCBNb2RlbCwgU2ltcGxlU3RyZWFtT3B0aW9ucywgQ29udGV4dCwgQXNzaXN0YW50TWVzc2FnZUV2ZW50U3RyZWFtIH0gZnJvbSBcIkBnc2QvcGktYWlcIjtcbmltcG9ydCB7IGdldEFwaVByb3ZpZGVyIH0gZnJvbSBcIkBnc2QvcGktYWlcIjtcbmltcG9ydCB7IEF1dGhTdG9yYWdlLCB0eXBlIEF1dGhTdG9yYWdlRGF0YSB9IGZyb20gXCIuL2F1dGgtc3RvcmFnZS5qc1wiO1xuaW1wb3J0IHsgTW9kZWxSZWdpc3RyeSB9IGZyb20gXCIuL21vZGVsLXJlZ2lzdHJ5LmpzXCI7XG5cbmZ1bmN0aW9uIGNyZWF0ZVJlZ2lzdHJ5KFxuXHRoYXNBdXRoRm4/OiAocHJvdmlkZXI6IHN0cmluZykgPT4gYm9vbGVhbixcblx0Z2V0QXBpS2V5Rm4/OiAocHJvdmlkZXI6IHN0cmluZykgPT4gUHJvbWlzZTxzdHJpbmcgfCB1bmRlZmluZWQ+LFxuKTogTW9kZWxSZWdpc3RyeSB7XG5cdGNvbnN0IGF1dGhTdG9yYWdlID0ge1xuXHRcdHNldEZhbGxiYWNrUmVzb2x2ZXI6ICgpID0+IHt9LFxuXHRcdG9uQ3JlZGVudGlhbENoYW5nZTogKCkgPT4ge30sXG5cdFx0Z2V0T0F1dGhQcm92aWRlcnM6ICgpID0+IFtdLFxuXHRcdGdldDogKCkgPT4gdW5kZWZpbmVkLFxuXHRcdGhhc0F1dGg6IGhhc0F1dGhGbiA/PyAoKCkgPT4gZmFsc2UpLFxuXHRcdGdldEFwaUtleTogYXN5bmMgKHByb3ZpZGVyOiBzdHJpbmcpID0+IGdldEFwaUtleUZuID8gZ2V0QXBpS2V5Rm4ocHJvdmlkZXIpIDogdW5kZWZpbmVkLFxuXHR9IGFzIHVua25vd24gYXMgQXV0aFN0b3JhZ2U7XG5cblx0cmV0dXJuIG5ldyBNb2RlbFJlZ2lzdHJ5KGF1dGhTdG9yYWdlLCBcIlwiKTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlSW5NZW1vcnlSZWdpc3RyeShkYXRhOiBBdXRoU3RvcmFnZURhdGEgPSB7fSk6IE1vZGVsUmVnaXN0cnkge1xuXHRyZXR1cm4gbmV3IE1vZGVsUmVnaXN0cnkoQXV0aFN0b3JhZ2UuaW5NZW1vcnkoZGF0YSksIFwiXCIpO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVQcm92aWRlck1vZGVsKGlkOiBzdHJpbmcsIGFwaT86IHN0cmluZyk6IE5vbk51bGxhYmxlPFBhcmFtZXRlcnM8TW9kZWxSZWdpc3RyeVtcInJlZ2lzdGVyUHJvdmlkZXJcIl0+WzFdW1wibW9kZWxzXCJdPltudW1iZXJdIHtcblx0cmV0dXJuIHtcblx0XHRpZCxcblx0XHRuYW1lOiBpZCxcblx0XHRhcGk6IChhcGkgPz8gXCJvcGVuYWktY29tcGxldGlvbnNcIikgYXMgQXBpLFxuXHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0Y29zdDogeyBpbnB1dDogMCwgb3V0cHV0OiAwLCBjYWNoZVJlYWQ6IDAsIGNhY2hlV3JpdGU6IDAgfSxcblx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0bWF4VG9rZW5zOiAxNjM4NCxcblx0fTtcbn1cblxuZnVuY3Rpb24gZmluZE1vZGVsKHJlZ2lzdHJ5OiBNb2RlbFJlZ2lzdHJ5LCBwcm92aWRlcjogc3RyaW5nLCBpZDogc3RyaW5nKTogTW9kZWw8QXBpPiB8IHVuZGVmaW5lZCB7XG5cdHJldHVybiByZWdpc3RyeS5nZXRBdmFpbGFibGUoKS5maW5kKChtKSA9PiBtLnByb3ZpZGVyID09PSBwcm92aWRlciAmJiBtLmlkID09PSBpZCk7XG59XG5cbmZ1bmN0aW9uIGF2YWlsYWJsZU1vZGVsSWRzKHJlZ2lzdHJ5OiBNb2RlbFJlZ2lzdHJ5KTogU2V0PHN0cmluZz4ge1xuXHRyZXR1cm4gbmV3IFNldChyZWdpc3RyeS5nZXRBdmFpbGFibGUoKS5tYXAoKG1vZGVsKSA9PiBgJHttb2RlbC5wcm92aWRlcn0vJHttb2RlbC5pZH1gKSk7XG59XG5cbmZ1bmN0aW9uIG1ha2VNb2RlbChwcm92aWRlcjogc3RyaW5nLCBpZDogc3RyaW5nLCBhcGk6IHN0cmluZyk6IE1vZGVsPEFwaT4ge1xuXHRyZXR1cm4ge1xuXHRcdGlkLFxuXHRcdG5hbWU6IGlkLFxuXHRcdGFwaTogYXBpIGFzIEFwaSxcblx0XHRwcm92aWRlcixcblx0XHRiYXNlVXJsOiBgJHtwcm92aWRlcn06YCxcblx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdGNvc3Q6IHsgaW5wdXQ6IDAsIG91dHB1dDogMCwgY2FjaGVSZWFkOiAwLCBjYWNoZVdyaXRlOiAwIH0sXG5cdFx0Y29udGV4dFdpbmRvdzogMTI4MDAwLFxuXHRcdG1heFRva2VuczogMTYzODQsXG5cdH07XG59XG5cbmZ1bmN0aW9uIG1ha2VDb250ZXh0KCk6IENvbnRleHQge1xuXHRyZXR1cm4ge1xuXHRcdHN5c3RlbVByb21wdDogXCJ0ZXN0XCIsXG5cdFx0bWVzc2FnZXM6IFt7IHJvbGU6IFwidXNlclwiLCBjb250ZW50OiBcImhlbGxvXCIsIHRpbWVzdGFtcDogRGF0ZS5ub3coKSB9XSxcblx0fTtcbn1cblxuLyoqIE5vLW9wIHN0cmVhbVNpbXBsZSBmb3IgdGVzdHMgdGhhdCBuZWVkIG9uZSB0byBwYXNzIHZhbGlkYXRpb24gYnV0IGRvbid0IGluc3BlY3QgaXQuICovXG5jb25zdCBub29wU3RyZWFtU2ltcGxlID0gKF9tb2RlbDogTW9kZWw8QXBpPiwgX2NvbnRleHQ6IENvbnRleHQsIF9vcHRpb25zPzogU2ltcGxlU3RyZWFtT3B0aW9ucykgPT4ge1xuXHRyZXR1cm4ge1xuXHRcdFtTeW1ib2wuYXN5bmNJdGVyYXRvcl0oKSB7IHJldHVybiB7IG5leHQ6IGFzeW5jICgpID0+ICh7IHZhbHVlOiB1bmRlZmluZWQsIGRvbmU6IHRydWUgYXMgY29uc3QgfSkgfTsgfSxcblx0XHRyZXN1bHQ6ICgpID0+IFByb21pc2UucmVzb2x2ZSh7IHJvbGU6IFwiYXNzaXN0YW50XCIgYXMgY29uc3QsIGNvbnRlbnQ6IFtdLCBhcGk6IFwidGVzdFwiIGFzIEFwaSwgcHJvdmlkZXI6IFwidGVzdFwiLCBtb2RlbDogXCJ0ZXN0XCIsIHVzYWdlOiB7IGlucHV0OiAwLCBvdXRwdXQ6IDAsIGNhY2hlUmVhZDogMCwgY2FjaGVXcml0ZTogMCwgdG90YWxUb2tlbnM6IDAsIGNvc3Q6IHsgaW5wdXQ6IDAsIG91dHB1dDogMCwgY2FjaGVSZWFkOiAwLCBjYWNoZVdyaXRlOiAwLCB0b3RhbDogMCB9IH0sIHN0b3BSZWFzb246IFwic3RvcFwiIGFzIGNvbnN0LCB0aW1lc3RhbXA6IERhdGUubm93KCkgfSksXG5cdFx0cHVzaDogKCkgPT4ge30sXG5cdFx0ZW5kOiAoKSA9PiB7fSxcblx0fSBhcyB1bmtub3duIGFzIEFzc2lzdGFudE1lc3NhZ2VFdmVudFN0cmVhbTtcbn07XG5cbi8qKiBDcmVhdGUgYSBzcHkgc3RyZWFtU2ltcGxlIHRoYXQgY2FwdHVyZXMgdGhlIG9wdGlvbnMgaXQgcmVjZWl2ZXMgYW5kIHJldHVybnMgYSBzdHViIHN0cmVhbS4gKi9cbmZ1bmN0aW9uIGNyZWF0ZVN0cmVhbVNweSgpOiB7XG5cdHN0cmVhbVNpbXBsZTogKG1vZGVsOiBNb2RlbDxBcGk+LCBjb250ZXh0OiBDb250ZXh0LCBvcHRpb25zPzogU2ltcGxlU3RyZWFtT3B0aW9ucykgPT4gQXNzaXN0YW50TWVzc2FnZUV2ZW50U3RyZWFtO1xuXHRnZXRDYXB0dXJlZE9wdGlvbnM6ICgpID0+IFNpbXBsZVN0cmVhbU9wdGlvbnMgfCB1bmRlZmluZWQ7XG59IHtcblx0bGV0IGNhcHR1cmVkT3B0aW9uczogU2ltcGxlU3RyZWFtT3B0aW9ucyB8IHVuZGVmaW5lZDtcblx0Y29uc3Qgc3RyZWFtU2ltcGxlID0gKF9tb2RlbDogTW9kZWw8QXBpPiwgX2NvbnRleHQ6IENvbnRleHQsIG9wdGlvbnM/OiBTaW1wbGVTdHJlYW1PcHRpb25zKSA9PiB7XG5cdFx0Y2FwdHVyZWRPcHRpb25zID0gb3B0aW9ucztcblx0XHQvLyBSZXR1cm4gYSBtaW5pbWFsIHN0dWIgdGhhdCBzYXRpc2ZpZXMgQXNzaXN0YW50TWVzc2FnZUV2ZW50U3RyZWFtXG5cdFx0cmV0dXJuIHtcblx0XHRcdFtTeW1ib2wuYXN5bmNJdGVyYXRvcl0oKSB7IHJldHVybiB7IG5leHQ6IGFzeW5jICgpID0+ICh7IHZhbHVlOiB1bmRlZmluZWQsIGRvbmU6IHRydWUgYXMgY29uc3QgfSkgfTsgfSxcblx0XHRcdHJlc3VsdDogKCkgPT4gUHJvbWlzZS5yZXNvbHZlKHsgcm9sZTogXCJhc3Npc3RhbnRcIiBhcyBjb25zdCwgY29udGVudDogW10sIGFwaTogXCJ0ZXN0XCIgYXMgQXBpLCBwcm92aWRlcjogXCJ0ZXN0XCIsIG1vZGVsOiBcInRlc3RcIiwgdXNhZ2U6IHsgaW5wdXQ6IDAsIG91dHB1dDogMCwgY2FjaGVSZWFkOiAwLCBjYWNoZVdyaXRlOiAwLCB0b3RhbFRva2VuczogMCwgY29zdDogeyBpbnB1dDogMCwgb3V0cHV0OiAwLCBjYWNoZVJlYWQ6IDAsIGNhY2hlV3JpdGU6IDAsIHRvdGFsOiAwIH0gfSwgc3RvcFJlYXNvbjogXCJzdG9wXCIgYXMgY29uc3QsIHRpbWVzdGFtcDogRGF0ZS5ub3coKSB9KSxcblx0XHRcdHB1c2g6ICgpID0+IHt9LFxuXHRcdFx0ZW5kOiAoKSA9PiB7fSxcblx0XHR9IGFzIHVua25vd24gYXMgQXNzaXN0YW50TWVzc2FnZUV2ZW50U3RyZWFtO1xuXHR9O1xuXHRyZXR1cm4geyBzdHJlYW1TaW1wbGUsIGdldENhcHR1cmVkT3B0aW9uczogKCkgPT4gY2FwdHVyZWRPcHRpb25zIH07XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBSZWdpc3RyYXRpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiTW9kZWxSZWdpc3RyeSBhdXRoTW9kZSBcdTIwMTQgcmVnaXN0cmF0aW9uXCIsICgpID0+IHtcblx0aXQoXCJpbmNsdWRlcyBHUFQtNS41IGluIHRoZSBhdXRoZW50aWNhdGVkIGFsbC1tb2RlbHMgbWVudSBiYWNraW5nIGxpc3RcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlZ2lzdHJ5ID0gY3JlYXRlSW5NZW1vcnlSZWdpc3RyeSh7XG5cdFx0XHRvcGVuYWk6IHsgdHlwZTogXCJhcGlfa2V5XCIsIGtleTogXCJzay10ZXN0XCIgfSxcblx0XHRcdFwib3BlbmFpLWNvZGV4XCI6IHtcblx0XHRcdFx0dHlwZTogXCJvYXV0aFwiLFxuXHRcdFx0XHRhY2Nlc3M6IFwiY29kZXgtYWNjZXNzXCIsXG5cdFx0XHRcdHJlZnJlc2g6IFwiY29kZXgtcmVmcmVzaFwiLFxuXHRcdFx0XHRleHBpcmVzOiBEYXRlLm5vdygpICsgNjBfMDAwLFxuXHRcdFx0fSxcblx0XHR9KTtcblxuXHRcdGNvbnN0IGlkcyA9IGF2YWlsYWJsZU1vZGVsSWRzKHJlZ2lzdHJ5KTtcblx0XHRhc3NlcnQub2soaWRzLmhhcyhcIm9wZW5haS9ncHQtNS41XCIpLCBcImFsbC1tb2RlbHMgbWVudSBiYWNraW5nIGxpc3Qgc2hvdWxkIGluY2x1ZGUgb3BlbmFpL2dwdC01LjVcIik7XG5cdFx0YXNzZXJ0Lm9rKGlkcy5oYXMoXCJvcGVuYWktY29kZXgvZ3B0LTUuNVwiKSwgXCJhbGwtbW9kZWxzIG1lbnUgYmFja2luZyBsaXN0IHNob3VsZCBpbmNsdWRlIG9wZW5haS1jb2RleC9ncHQtNS41XCIpO1xuXHR9KTtcblxuXHRpdChcInJlZ2lzdGVycyBleHRlcm5hbENsaSBwcm92aWRlciB3aXRoIHN0cmVhbVNpbXBsZSBhbmQgd2l0aG91dCBhcGlLZXkvb2F1dGhcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlZ2lzdHJ5ID0gY3JlYXRlUmVnaXN0cnkoKTtcblx0XHRjb25zdCBzcHkgPSBjcmVhdGVTdHJlYW1TcHkoKTtcblx0XHRhc3NlcnQuZG9lc05vdFRocm93KCgpID0+IHtcblx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyUHJvdmlkZXIoXCJjbGktcHJvdmlkZXJcIiwge1xuXHRcdFx0XHRhdXRoTW9kZTogXCJleHRlcm5hbENsaVwiLFxuXHRcdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vY2xpLmxvY2FsXCIsXG5cdFx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdFx0c3RyZWFtU2ltcGxlOiBzcHkuc3RyZWFtU2ltcGxlLFxuXHRcdFx0XHRtb2RlbHM6IFtjcmVhdGVQcm92aWRlck1vZGVsKFwiY2xpLW1vZGVsXCIpXSxcblx0XHRcdH0pO1xuXHRcdH0pO1xuXHR9KTtcblxuXHRpdChcInJlZ2lzdGVycyBub25lIHByb3ZpZGVyIHdpdGggc3RyZWFtU2ltcGxlIGFuZCB3aXRob3V0IGFwaUtleS9vYXV0aFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVnaXN0cnkgPSBjcmVhdGVSZWdpc3RyeSgpO1xuXHRcdGNvbnN0IHNweSA9IGNyZWF0ZVN0cmVhbVNweSgpO1xuXHRcdGFzc2VydC5kb2VzTm90VGhyb3coKCkgPT4ge1xuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXJQcm92aWRlcihcIm5vbmUtcHJvdmlkZXJcIiwge1xuXHRcdFx0XHRhdXRoTW9kZTogXCJub25lXCIsXG5cdFx0XHRcdGJhc2VVcmw6IFwiaHR0cDovL2xvY2FsaG9zdDoxMTQzNFwiLFxuXHRcdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRcdHN0cmVhbVNpbXBsZTogc3B5LnN0cmVhbVNpbXBsZSxcblx0XHRcdFx0bW9kZWxzOiBbY3JlYXRlUHJvdmlkZXJNb2RlbChcImxvY2FsLW1vZGVsXCIpXSxcblx0XHRcdH0pO1xuXHRcdH0pO1xuXHR9KTtcblxuXHRpdChcInJlamVjdHMgYXBpS2V5IHByb3ZpZGVyIHdpdGhvdXQgYXBpS2V5IG9yIG9hdXRoIFx1MjAxNCBtZXNzYWdlIG1lbnRpb25zIGF1dGhNb2RlXCIsICgpID0+IHtcblx0XHRjb25zdCByZWdpc3RyeSA9IGNyZWF0ZVJlZ2lzdHJ5KCk7XG5cdFx0YXNzZXJ0LnRocm93cygoKSA9PiB7XG5cdFx0XHRyZWdpc3RyeS5yZWdpc3RlclByb3ZpZGVyKFwiYXBpa2V5LXByb3ZpZGVyXCIsIHtcblx0XHRcdFx0YXV0aE1vZGU6IFwiYXBpS2V5XCIsXG5cdFx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9hcGkubG9jYWxcIixcblx0XHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0XHRtb2RlbHM6IFtjcmVhdGVQcm92aWRlck1vZGVsKFwibW9kZWxcIildLFxuXHRcdFx0fSk7XG5cdFx0fSwgKGVycjogRXJyb3IpID0+IHtcblx0XHRcdGFzc2VydC5vayhlcnIubWVzc2FnZS5pbmNsdWRlcyhcImF1dGhNb2RlXCIpLCBcImVycm9yIG1lc3NhZ2UgbXVzdCBtZW50aW9uIGF1dGhNb2RlXCIpO1xuXHRcdFx0YXNzZXJ0Lm9rKGVyci5tZXNzYWdlLmluY2x1ZGVzKFwiZXh0ZXJuYWxDbGlcIiksIFwiZXJyb3IgbWVzc2FnZSBtdXN0IHN1Z2dlc3QgZXh0ZXJuYWxDbGlcIik7XG5cdFx0XHRyZXR1cm4gdHJ1ZTtcblx0XHR9KTtcblx0fSk7XG5cblx0aXQoXCJyZWplY3RzIHByb3ZpZGVyIHdpdGggbm8gYXV0aE1vZGUgYW5kIG5vIGFwaUtleS9vYXV0aCAoZGVmYXVsdHMgdG8gYXBpS2V5KVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVnaXN0cnkgPSBjcmVhdGVSZWdpc3RyeSgpO1xuXHRcdGFzc2VydC50aHJvd3MoKCkgPT4ge1xuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXJQcm92aWRlcihcImJhcmUtcHJvdmlkZXJcIiwge1xuXHRcdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYXBpLmxvY2FsXCIsXG5cdFx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdFx0bW9kZWxzOiBbY3JlYXRlUHJvdmlkZXJNb2RlbChcIm1vZGVsXCIpXSxcblx0XHRcdH0pO1xuXHRcdH0sIChlcnI6IEVycm9yKSA9PiB7XG5cdFx0XHRhc3NlcnQub2soZXJyLm1lc3NhZ2UuaW5jbHVkZXMoXCJhdXRoTW9kZVwiKSwgXCJlcnJvciBtZXNzYWdlIG11c3QgbWVudGlvbiBhdXRoTW9kZVwiKTtcblx0XHRcdHJldHVybiB0cnVlO1xuXHRcdH0pO1xuXHR9KTtcblxuXHRpdChcInJlamVjdHMgZXh0ZXJuYWxDbGkgcHJvdmlkZXIgd2l0aG91dCBzdHJlYW1TaW1wbGVcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlZ2lzdHJ5ID0gY3JlYXRlUmVnaXN0cnkoKTtcblx0XHRhc3NlcnQudGhyb3dzKCgpID0+IHtcblx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyUHJvdmlkZXIoXCJjbGktbm8tc3RyZWFtXCIsIHtcblx0XHRcdFx0YXV0aE1vZGU6IFwiZXh0ZXJuYWxDbGlcIixcblx0XHRcdFx0YmFzZVVybDogXCJodHRwczovL2NsaS5sb2NhbFwiLFxuXHRcdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRcdG1vZGVsczogW2NyZWF0ZVByb3ZpZGVyTW9kZWwoXCJtb2RlbFwiKV0sXG5cdFx0XHR9KTtcblx0XHR9LCAoZXJyOiBFcnJvcikgPT4ge1xuXHRcdFx0YXNzZXJ0Lm9rKGVyci5tZXNzYWdlLmluY2x1ZGVzKFwic3RyZWFtU2ltcGxlXCIpLCBcImVycm9yIG1lc3NhZ2UgbXVzdCBtZW50aW9uIHN0cmVhbVNpbXBsZVwiKTtcblx0XHRcdGFzc2VydC5vayhlcnIubWVzc2FnZS5pbmNsdWRlcyhcImV4dGVybmFsQ2xpXCIpLCBcImVycm9yIG1lc3NhZ2UgbXVzdCBtZW50aW9uIGF1dGhNb2RlXCIpO1xuXHRcdFx0cmV0dXJuIHRydWU7XG5cdFx0fSk7XG5cdH0pO1xuXG5cdGl0KFwicmVqZWN0cyBub25lIHByb3ZpZGVyIHdpdGhvdXQgc3RyZWFtU2ltcGxlXCIsICgpID0+IHtcblx0XHRjb25zdCByZWdpc3RyeSA9IGNyZWF0ZVJlZ2lzdHJ5KCk7XG5cdFx0YXNzZXJ0LnRocm93cygoKSA9PiB7XG5cdFx0XHRyZWdpc3RyeS5yZWdpc3RlclByb3ZpZGVyKFwibm9uZS1uby1zdHJlYW1cIiwge1xuXHRcdFx0XHRhdXRoTW9kZTogXCJub25lXCIsXG5cdFx0XHRcdGJhc2VVcmw6IFwiaHR0cDovL2xvY2FsaG9zdDoxMTQzNFwiLFxuXHRcdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRcdG1vZGVsczogW2NyZWF0ZVByb3ZpZGVyTW9kZWwoXCJtb2RlbFwiKV0sXG5cdFx0XHR9KTtcblx0XHR9LCAoZXJyOiBFcnJvcikgPT4ge1xuXHRcdFx0YXNzZXJ0Lm9rKGVyci5tZXNzYWdlLmluY2x1ZGVzKFwic3RyZWFtU2ltcGxlXCIpLCBcImVycm9yIG1lc3NhZ2UgbXVzdCBtZW50aW9uIHN0cmVhbVNpbXBsZVwiKTtcblx0XHRcdGFzc2VydC5vayhlcnIubWVzc2FnZS5pbmNsdWRlcyhcIm5vbmVcIiksIFwiZXJyb3IgbWVzc2FnZSBtdXN0IG1lbnRpb24gYXV0aE1vZGVcIik7XG5cdFx0XHRyZXR1cm4gdHJ1ZTtcblx0XHR9KTtcblx0fSk7XG5cblx0aXQoXCJyZWplY3RzIGV4dGVybmFsQ2xpIHByb3ZpZGVyIHRoYXQgYWxzbyBzZXRzIGFwaUtleVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVnaXN0cnkgPSBjcmVhdGVSZWdpc3RyeSgpO1xuXHRcdGNvbnN0IHNweSA9IGNyZWF0ZVN0cmVhbVNweSgpO1xuXHRcdGFzc2VydC50aHJvd3MoKCkgPT4ge1xuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXJQcm92aWRlcihcImNsaS13aXRoLWtleVwiLCB7XG5cdFx0XHRcdGF1dGhNb2RlOiBcImV4dGVybmFsQ2xpXCIsXG5cdFx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9jbGkubG9jYWxcIixcblx0XHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0XHRhcGlLZXk6IFwiU0hPVUxEX05PVF9FWElTVFwiLFxuXHRcdFx0XHRzdHJlYW1TaW1wbGU6IHNweS5zdHJlYW1TaW1wbGUsXG5cdFx0XHRcdG1vZGVsczogW2NyZWF0ZVByb3ZpZGVyTW9kZWwoXCJtb2RlbFwiKV0sXG5cdFx0XHR9KTtcblx0XHR9LCAoZXJyOiBFcnJvcikgPT4ge1xuXHRcdFx0YXNzZXJ0Lm9rKGVyci5tZXNzYWdlLmluY2x1ZGVzKFwiYXBpS2V5XCIpLCBcImVycm9yIG1lc3NhZ2UgbXVzdCBtZW50aW9uIGFwaUtleVwiKTtcblx0XHRcdGFzc2VydC5vayhlcnIubWVzc2FnZS5pbmNsdWRlcyhcImV4dGVybmFsQ2xpXCIpLCBcImVycm9yIG1lc3NhZ2UgbXVzdCBtZW50aW9uIGF1dGhNb2RlXCIpO1xuXHRcdFx0cmV0dXJuIHRydWU7XG5cdFx0fSk7XG5cdH0pO1xuXG5cdGl0KFwicmVqZWN0cyBub25lIHByb3ZpZGVyIHRoYXQgYWxzbyBzZXRzIGFwaUtleVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVnaXN0cnkgPSBjcmVhdGVSZWdpc3RyeSgpO1xuXHRcdGNvbnN0IHNweSA9IGNyZWF0ZVN0cmVhbVNweSgpO1xuXHRcdGFzc2VydC50aHJvd3MoKCkgPT4ge1xuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXJQcm92aWRlcihcIm5vbmUtd2l0aC1rZXlcIiwge1xuXHRcdFx0XHRhdXRoTW9kZTogXCJub25lXCIsXG5cdFx0XHRcdGJhc2VVcmw6IFwiaHR0cDovL2xvY2FsaG9zdDoxMTQzNFwiLFxuXHRcdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRcdGFwaUtleTogXCJTSE9VTERfTk9UX0VYSVNUXCIsXG5cdFx0XHRcdHN0cmVhbVNpbXBsZTogc3B5LnN0cmVhbVNpbXBsZSxcblx0XHRcdFx0bW9kZWxzOiBbY3JlYXRlUHJvdmlkZXJNb2RlbChcIm1vZGVsXCIpXSxcblx0XHRcdH0pO1xuXHRcdH0sIChlcnI6IEVycm9yKSA9PiB7XG5cdFx0XHRhc3NlcnQub2soZXJyLm1lc3NhZ2UuaW5jbHVkZXMoXCJhcGlLZXlcIiksIFwiZXJyb3IgbWVzc2FnZSBtdXN0IG1lbnRpb24gYXBpS2V5XCIpO1xuXHRcdFx0YXNzZXJ0Lm9rKGVyci5tZXNzYWdlLmluY2x1ZGVzKFwibm9uZVwiKSwgXCJlcnJvciBtZXNzYWdlIG11c3QgbWVudGlvbiBhdXRoTW9kZVwiKTtcblx0XHRcdHJldHVybiB0cnVlO1xuXHRcdH0pO1xuXHR9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgZ2V0UHJvdmlkZXJBdXRoTW9kZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJNb2RlbFJlZ2lzdHJ5IGF1dGhNb2RlIFx1MjAxNCBnZXRQcm92aWRlckF1dGhNb2RlXCIsICgpID0+IHtcblx0aXQoXCJyZXR1cm5zIGFwaUtleSBmb3IgdW5yZWdpc3RlcmVkIChidWlsdC1pbikgcHJvdmlkZXJzXCIsICgpID0+IHtcblx0XHRjb25zdCByZWdpc3RyeSA9IGNyZWF0ZVJlZ2lzdHJ5KCk7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlZ2lzdHJ5LmdldFByb3ZpZGVyQXV0aE1vZGUoXCJhbnRocm9waWNcIiksIFwiYXBpS2V5XCIpO1xuXHR9KTtcblxuXHRpdChcInJldHVybnMgZXhwbGljaXQgYXV0aE1vZGUgd2hlbiBzZXRcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlZ2lzdHJ5ID0gY3JlYXRlUmVnaXN0cnkoKTtcblx0XHRyZWdpc3RyeS5yZWdpc3RlclByb3ZpZGVyKFwiY2xpXCIsIHtcblx0XHRcdGF1dGhNb2RlOiBcImV4dGVybmFsQ2xpXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vY2xpLmxvY2FsXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRzdHJlYW1TaW1wbGU6IG5vb3BTdHJlYW1TaW1wbGUsXG5cdFx0XHRtb2RlbHM6IFtjcmVhdGVQcm92aWRlck1vZGVsKFwibVwiKV0sXG5cdFx0fSk7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlZ2lzdHJ5LmdldFByb3ZpZGVyQXV0aE1vZGUoXCJjbGlcIiksIFwiZXh0ZXJuYWxDbGlcIik7XG5cdH0pO1xuXG5cdGl0KFwicmV0dXJucyBub25lIHdoZW4gYXV0aE1vZGUgaXMgbm9uZVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVnaXN0cnkgPSBjcmVhdGVSZWdpc3RyeSgpO1xuXHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyUHJvdmlkZXIoXCJsb2NhbFwiLCB7XG5cdFx0XHRhdXRoTW9kZTogXCJub25lXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHA6Ly9sb2NhbGhvc3Q6MTE0MzRcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHN0cmVhbVNpbXBsZTogbm9vcFN0cmVhbVNpbXBsZSxcblx0XHRcdG1vZGVsczogW2NyZWF0ZVByb3ZpZGVyTW9kZWwoXCJtXCIpXSxcblx0XHR9KTtcblx0XHRhc3NlcnQuZXF1YWwocmVnaXN0cnkuZ2V0UHJvdmlkZXJBdXRoTW9kZShcImxvY2FsXCIpLCBcIm5vbmVcIik7XG5cdH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBpc1Byb3ZpZGVyUmVxdWVzdFJlYWR5IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcIk1vZGVsUmVnaXN0cnkgYXV0aE1vZGUgXHUyMDE0IGlzUHJvdmlkZXJSZXF1ZXN0UmVhZHlcIiwgKCkgPT4ge1xuXHRpdChcInJldHVybnMgdHJ1ZSBmb3IgZXh0ZXJuYWxDbGkgd2l0aG91dCBzdG9yZWQgYXV0aFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVnaXN0cnkgPSBjcmVhdGVSZWdpc3RyeSgoKSA9PiBmYWxzZSk7XG5cdFx0cmVnaXN0cnkucmVnaXN0ZXJQcm92aWRlcihcImNsaVwiLCB7XG5cdFx0XHRhdXRoTW9kZTogXCJleHRlcm5hbENsaVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2NsaS5sb2NhbFwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0c3RyZWFtU2ltcGxlOiBub29wU3RyZWFtU2ltcGxlLFxuXHRcdFx0bW9kZWxzOiBbY3JlYXRlUHJvdmlkZXJNb2RlbChcIm1cIildLFxuXHRcdH0pO1xuXHRcdGFzc2VydC5lcXVhbChyZWdpc3RyeS5pc1Byb3ZpZGVyUmVxdWVzdFJlYWR5KFwiY2xpXCIpLCB0cnVlKTtcblx0fSk7XG5cblx0aXQoXCJyZXR1cm5zIHRydWUgZm9yIG5vbmUgd2l0aG91dCBzdG9yZWQgYXV0aFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVnaXN0cnkgPSBjcmVhdGVSZWdpc3RyeSgoKSA9PiBmYWxzZSk7XG5cdFx0cmVnaXN0cnkucmVnaXN0ZXJQcm92aWRlcihcImxvY2FsXCIsIHtcblx0XHRcdGF1dGhNb2RlOiBcIm5vbmVcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cDovL2xvY2FsaG9zdDoxMTQzNFwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0c3RyZWFtU2ltcGxlOiBub29wU3RyZWFtU2ltcGxlLFxuXHRcdFx0bW9kZWxzOiBbY3JlYXRlUHJvdmlkZXJNb2RlbChcIm1cIildLFxuXHRcdH0pO1xuXHRcdGFzc2VydC5lcXVhbChyZWdpc3RyeS5pc1Byb3ZpZGVyUmVxdWVzdFJlYWR5KFwibG9jYWxcIiksIHRydWUpO1xuXHR9KTtcblxuXHRpdChcInJldHVybnMgZmFsc2UgZm9yIGFwaUtleSBwcm92aWRlciB3aXRob3V0IHN0b3JlZCBhdXRoXCIsICgpID0+IHtcblx0XHRjb25zdCByZWdpc3RyeSA9IGNyZWF0ZVJlZ2lzdHJ5KCgpID0+IGZhbHNlKTtcblx0XHRhc3NlcnQuZXF1YWwocmVnaXN0cnkuaXNQcm92aWRlclJlcXVlc3RSZWFkeShcImFudGhyb3BpY1wiKSwgZmFsc2UpO1xuXHR9KTtcblxuXHRpdChcInJldHVybnMgdHJ1ZSBmb3IgYXBpS2V5IHByb3ZpZGVyIHdpdGggc3RvcmVkIGF1dGhcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlZ2lzdHJ5ID0gY3JlYXRlUmVnaXN0cnkoKCkgPT4gdHJ1ZSk7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlZ2lzdHJ5LmlzUHJvdmlkZXJSZXF1ZXN0UmVhZHkoXCJhbnRocm9waWNcIiksIHRydWUpO1xuXHR9KTtcblxuXHRpdChcInJldHVybnMgZmFsc2UgZm9yIGRlbnlsaXN0ZWQgcHJvdmlkZXJzIGV2ZW4gd2hlbiBhdXRoIGV4aXN0c1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVnaXN0cnkgPSBjcmVhdGVSZWdpc3RyeSgoKSA9PiB0cnVlKTtcblx0XHRyZWdpc3RyeS5zZXREaXNhYmxlZE1vZGVsUHJvdmlkZXJzKFtcImFudGhyb3BpY1wiXSk7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlZ2lzdHJ5LmlzUHJvdmlkZXJSZXF1ZXN0UmVhZHkoXCJhbnRocm9waWNcIiksIGZhbHNlKTtcblx0fSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGlzUmVhZHkgY2FsbGJhY2sgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiTW9kZWxSZWdpc3RyeSBhdXRoTW9kZSBcdTIwMTQgaXNSZWFkeSBjYWxsYmFja1wiLCAoKSA9PiB7XG5cdGl0KFwiY2FsbHMgaXNSZWFkeSBhbmQgcmV0dXJucyBpdHMgcmVzdWx0IGZvciBleHRlcm5hbENsaSBwcm92aWRlclwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVnaXN0cnkgPSBjcmVhdGVSZWdpc3RyeSgoKSA9PiBmYWxzZSk7XG5cdFx0cmVnaXN0cnkucmVnaXN0ZXJQcm92aWRlcihcImNsaS1kb3duXCIsIHtcblx0XHRcdGF1dGhNb2RlOiBcImV4dGVybmFsQ2xpXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vY2xpLmxvY2FsXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRzdHJlYW1TaW1wbGU6IG5vb3BTdHJlYW1TaW1wbGUsXG5cdFx0XHRpc1JlYWR5OiAoKSA9PiBmYWxzZSxcblx0XHRcdG1vZGVsczogW2NyZWF0ZVByb3ZpZGVyTW9kZWwoXCJtXCIpXSxcblx0XHR9KTtcblx0XHRhc3NlcnQuZXF1YWwocmVnaXN0cnkuaXNQcm92aWRlclJlcXVlc3RSZWFkeShcImNsaS1kb3duXCIpLCBmYWxzZSk7XG5cdH0pO1xuXG5cdGl0KFwiY2FsbHMgaXNSZWFkeSBmb3IgYXBpS2V5IHByb3ZpZGVyIChvdmVycmlkZXMgaGFzQXV0aClcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlZ2lzdHJ5ID0gY3JlYXRlUmVnaXN0cnkoKCkgPT4gdHJ1ZSk7XG5cdFx0cmVnaXN0cnkucmVnaXN0ZXJQcm92aWRlcihcInN0cmljdC1wcm92aWRlclwiLCB7XG5cdFx0XHRhcGlLZXk6IFwiTVlfS0VZXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYXBpLmxvY2FsXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRpc1JlYWR5OiAoKSA9PiBmYWxzZSxcblx0XHRcdG1vZGVsczogW2NyZWF0ZVByb3ZpZGVyTW9kZWwoXCJtXCIpXSxcblx0XHR9KTtcblx0XHRhc3NlcnQuZXF1YWwocmVnaXN0cnkuaXNQcm92aWRlclJlcXVlc3RSZWFkeShcInN0cmljdC1wcm92aWRlclwiKSwgZmFsc2UpO1xuXHR9KTtcblxuXHRpdChcImlzUmVhZHkgcmV0dXJuaW5nIHRydWUgbWFrZXMgcHJvdmlkZXIgYXZhaWxhYmxlXCIsICgpID0+IHtcblx0XHRjb25zdCByZWdpc3RyeSA9IGNyZWF0ZVJlZ2lzdHJ5KCgpID0+IGZhbHNlKTtcblx0XHRyZWdpc3RyeS5yZWdpc3RlclByb3ZpZGVyKFwiaGVhbHRoeS1jbGlcIiwge1xuXHRcdFx0YXV0aE1vZGU6IFwiZXh0ZXJuYWxDbGlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9jbGkubG9jYWxcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHN0cmVhbVNpbXBsZTogbm9vcFN0cmVhbVNpbXBsZSxcblx0XHRcdGlzUmVhZHk6ICgpID0+IHRydWUsXG5cdFx0XHRtb2RlbHM6IFtjcmVhdGVQcm92aWRlck1vZGVsKFwibVwiKV0sXG5cdFx0fSk7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlZ2lzdHJ5LmlzUHJvdmlkZXJSZXF1ZXN0UmVhZHkoXCJoZWFsdGh5LWNsaVwiKSwgdHJ1ZSk7XG5cdH0pO1xuXG5cdGl0KFwiZmFsbHMgdGhyb3VnaCB0byBkZWZhdWx0IGJlaGF2aW9yIHdoZW4gaXNSZWFkeSBub3QgcHJvdmlkZWRcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlZ2lzdHJ5ID0gY3JlYXRlUmVnaXN0cnkoKCkgPT4gZmFsc2UpO1xuXHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyUHJvdmlkZXIoXCJuby1jYWxsYmFja1wiLCB7XG5cdFx0XHRhdXRoTW9kZTogXCJleHRlcm5hbENsaVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2NsaS5sb2NhbFwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0c3RyZWFtU2ltcGxlOiBub29wU3RyZWFtU2ltcGxlLFxuXHRcdFx0bW9kZWxzOiBbY3JlYXRlUHJvdmlkZXJNb2RlbChcIm1cIildLFxuXHRcdH0pO1xuXHRcdC8vIGV4dGVybmFsQ2xpIHdpdGhvdXQgaXNSZWFkeSBcdTIxOTIgdHJ1ZSAoZGVmYXVsdClcblx0XHRhc3NlcnQuZXF1YWwocmVnaXN0cnkuaXNQcm92aWRlclJlcXVlc3RSZWFkeShcIm5vLWNhbGxiYWNrXCIpLCB0cnVlKTtcblx0fSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGdldEF2YWlsYWJsZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJNb2RlbFJlZ2lzdHJ5IGF1dGhNb2RlIFx1MjAxNCBnZXRBdmFpbGFibGVcIiwgKCkgPT4ge1xuXHRpdChcImluY2x1ZGVzIGV4dGVybmFsQ2xpIG1vZGVscyB3aXRob3V0IHN0b3JlZCBhdXRoXCIsICgpID0+IHtcblx0XHRjb25zdCByZWdpc3RyeSA9IGNyZWF0ZVJlZ2lzdHJ5KCgpID0+IGZhbHNlKTtcblx0XHRyZWdpc3RyeS5yZWdpc3RlclByb3ZpZGVyKFwiY2xpXCIsIHtcblx0XHRcdGF1dGhNb2RlOiBcImV4dGVybmFsQ2xpXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vY2xpLmxvY2FsXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRzdHJlYW1TaW1wbGU6IG5vb3BTdHJlYW1TaW1wbGUsXG5cdFx0XHRtb2RlbHM6IFtjcmVhdGVQcm92aWRlck1vZGVsKFwiY2xpLW1vZGVsXCIpXSxcblx0XHR9KTtcblx0XHRhc3NlcnQub2soZmluZE1vZGVsKHJlZ2lzdHJ5LCBcImNsaVwiLCBcImNsaS1tb2RlbFwiKSk7XG5cdH0pO1xuXG5cdGl0KFwiaW5jbHVkZXMgbm9uZSBtb2RlbHMgd2l0aG91dCBzdG9yZWQgYXV0aFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVnaXN0cnkgPSBjcmVhdGVSZWdpc3RyeSgoKSA9PiBmYWxzZSk7XG5cdFx0cmVnaXN0cnkucmVnaXN0ZXJQcm92aWRlcihcImxvY2FsXCIsIHtcblx0XHRcdGF1dGhNb2RlOiBcIm5vbmVcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cDovL2xvY2FsaG9zdDoxMTQzNFwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0c3RyZWFtU2ltcGxlOiBub29wU3RyZWFtU2ltcGxlLFxuXHRcdFx0bW9kZWxzOiBbY3JlYXRlUHJvdmlkZXJNb2RlbChcImxvY2FsLW1vZGVsXCIpXSxcblx0XHR9KTtcblx0XHRhc3NlcnQub2soZmluZE1vZGVsKHJlZ2lzdHJ5LCBcImxvY2FsXCIsIFwibG9jYWwtbW9kZWxcIikpO1xuXHR9KTtcblxuXHRpdChcImV4Y2x1ZGVzIGV4dGVybmFsQ2xpIG1vZGVscyB3aGVuIGlzUmVhZHkgcmV0dXJucyBmYWxzZVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVnaXN0cnkgPSBjcmVhdGVSZWdpc3RyeSgoKSA9PiBmYWxzZSk7XG5cdFx0cmVnaXN0cnkucmVnaXN0ZXJQcm92aWRlcihcImNsaS1kb3duXCIsIHtcblx0XHRcdGF1dGhNb2RlOiBcImV4dGVybmFsQ2xpXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vY2xpLmxvY2FsXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRzdHJlYW1TaW1wbGU6IG5vb3BTdHJlYW1TaW1wbGUsXG5cdFx0XHRpc1JlYWR5OiAoKSA9PiBmYWxzZSxcblx0XHRcdG1vZGVsczogW2NyZWF0ZVByb3ZpZGVyTW9kZWwoXCJtXCIpXSxcblx0XHR9KTtcblx0XHRhc3NlcnQuZXF1YWwoZmluZE1vZGVsKHJlZ2lzdHJ5LCBcImNsaS1kb3duXCIsIFwibVwiKSwgdW5kZWZpbmVkKTtcblx0fSk7XG5cblx0aXQoXCJleGNsdWRlcyBhcGlLZXkgbW9kZWxzIHdpdGhvdXQgc3RvcmVkIGF1dGhcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlZ2lzdHJ5ID0gY3JlYXRlUmVnaXN0cnkoKCkgPT4gZmFsc2UpO1xuXHRcdGNvbnN0IGF2YWlsYWJsZSA9IHJlZ2lzdHJ5LmdldEF2YWlsYWJsZSgpO1xuXHRcdGFzc2VydC5lcXVhbChhdmFpbGFibGUubGVuZ3RoLCAwKTtcblx0fSk7XG5cblx0aXQoXCJleGNsdWRlcyBkZW55bGlzdGVkIHByb3ZpZGVycyBmcm9tIGF2YWlsYWJsZSBtb2RlbHNcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlZ2lzdHJ5ID0gY3JlYXRlUmVnaXN0cnkoKCkgPT4gdHJ1ZSk7XG5cdFx0cmVnaXN0cnkuc2V0RGlzYWJsZWRNb2RlbFByb3ZpZGVycyhbXCJnb29nbGUtZ2VtaW5pLWNsaVwiXSk7XG5cdFx0Y29uc3QgYXZhaWxhYmxlID0gcmVnaXN0cnkuZ2V0QXZhaWxhYmxlKCk7XG5cdFx0YXNzZXJ0LmVxdWFsKFxuXHRcdFx0YXZhaWxhYmxlLnNvbWUoKG0pID0+IG0ucHJvdmlkZXIgPT09IFwiZ29vZ2xlLWdlbWluaS1jbGlcIiksXG5cdFx0XHRmYWxzZSxcblx0XHRcdFwiZ29vZ2xlLWdlbWluaS1jbGkgbW9kZWxzIG11c3QgYmUgaGlkZGVuIHdoZW4gcHJvdmlkZXIgaXMgZGVueWxpc3RlZFwiLFxuXHRcdCk7XG5cdH0pO1xuXG5cdGl0KFwicHJ1bmVzIENvZGV4IG1vZGVscyByZW1vdmVkIGZyb20gQ2hhdEdQVC1iYWNrZWQgb3BlbmFpLWNvZGV4IE9BdXRoXCIsICgpID0+IHtcblx0XHRjb25zdCByZWdpc3RyeSA9IGNyZWF0ZUluTWVtb3J5UmVnaXN0cnkoe1xuXHRcdFx0XCJvcGVuYWktY29kZXhcIjoge1xuXHRcdFx0XHR0eXBlOiBcIm9hdXRoXCIsXG5cdFx0XHRcdGFjY2VzczogXCJvYXV0aC1hY2Nlc3NcIixcblx0XHRcdFx0cmVmcmVzaDogXCJvYXV0aC1yZWZyZXNoXCIsXG5cdFx0XHRcdGV4cGlyZXM6IERhdGUubm93KCkgKyA2MF8wMDAsXG5cdFx0XHRcdGFjY291bnRJZDogXCJhY2N0XzEyM1wiLFxuXHRcdFx0fSxcblx0XHR9KTtcblxuXHRcdGFzc2VydC5lcXVhbChyZWdpc3RyeS5maW5kKFwib3BlbmFpLWNvZGV4XCIsIFwiZ3B0LTUuMS1jb2RleC1tYXhcIiksIHVuZGVmaW5lZCk7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlZ2lzdHJ5LmZpbmQoXCJvcGVuYWktY29kZXhcIiwgXCJncHQtNS4xXCIpLCB1bmRlZmluZWQpO1xuXHRcdGFzc2VydC5lcXVhbChmaW5kTW9kZWwocmVnaXN0cnksIFwib3BlbmFpLWNvZGV4XCIsIFwiZ3B0LTUuMi1jb2RleFwiKSwgdW5kZWZpbmVkKTtcblx0XHRhc3NlcnQub2socmVnaXN0cnkuZmluZChcIm9wZW5haS1jb2RleFwiLCBcImdwdC01LjRcIikpO1xuXHRcdGFzc2VydC5vayhmaW5kTW9kZWwocmVnaXN0cnksIFwib3BlbmFpLWNvZGV4XCIsIFwiZ3B0LTUuNFwiKSk7XG5cdFx0YXNzZXJ0Lm9rKHJlZ2lzdHJ5LmZpbmQoXCJvcGVuYWktY29kZXhcIiwgXCJncHQtNS40LW1pbmlcIikpO1xuXHRcdGFzc2VydC5vayhmaW5kTW9kZWwocmVnaXN0cnksIFwib3BlbmFpLWNvZGV4XCIsIFwiZ3B0LTUuNC1taW5pXCIpKTtcblx0fSk7XG5cblx0aXQoXCJrZWVwcyBBUEktYmFja2VkIE9wZW5BSSBDb2RleC1jYXBhYmxlIG1vZGVscyBhdmFpbGFibGVcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlZ2lzdHJ5ID0gY3JlYXRlSW5NZW1vcnlSZWdpc3RyeSh7XG5cdFx0XHRvcGVuYWk6IHtcblx0XHRcdFx0dHlwZTogXCJhcGlfa2V5XCIsXG5cdFx0XHRcdGtleTogXCJzay10ZXN0XCIsXG5cdFx0XHR9LFxuXHRcdH0pO1xuXG5cdFx0YXNzZXJ0Lm9rKHJlZ2lzdHJ5LmZpbmQoXCJvcGVuYWlcIiwgXCJncHQtNS4yLWNvZGV4XCIpKTtcblx0XHRhc3NlcnQub2soZmluZE1vZGVsKHJlZ2lzdHJ5LCBcIm9wZW5haVwiLCBcImdwdC01LjItY29kZXhcIikpO1xuXHR9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgZ2V0QXBpS2V5IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcIk1vZGVsUmVnaXN0cnkgYXV0aE1vZGUgXHUyMDE0IGdldEFwaUtleVwiLCAoKSA9PiB7XG5cdGl0KFwicmV0dXJucyB1bmRlZmluZWQgZm9yIGV4dGVybmFsQ2xpIHByb3ZpZGVyXCIsIGFzeW5jICgpID0+IHtcblx0XHRjb25zdCByZWdpc3RyeSA9IGNyZWF0ZVJlZ2lzdHJ5KCk7XG5cdFx0cmVnaXN0cnkucmVnaXN0ZXJQcm92aWRlcihcImNsaVwiLCB7XG5cdFx0XHRhdXRoTW9kZTogXCJleHRlcm5hbENsaVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2NsaS5sb2NhbFwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0c3RyZWFtU2ltcGxlOiBub29wU3RyZWFtU2ltcGxlLFxuXHRcdFx0bW9kZWxzOiBbY3JlYXRlUHJvdmlkZXJNb2RlbChcIm1cIildLFxuXHRcdH0pO1xuXHRcdGNvbnN0IG1vZGVsID0gcmVnaXN0cnkuZ2V0QWxsKCkuZmluZCgobSkgPT4gbS5wcm92aWRlciA9PT0gXCJjbGlcIikhO1xuXHRcdGFzc2VydC5lcXVhbChhd2FpdCByZWdpc3RyeS5nZXRBcGlLZXkobW9kZWwpLCB1bmRlZmluZWQpO1xuXHR9KTtcblxuXHRpdChcInJldHVybnMgdW5kZWZpbmVkIGZvciBub25lIHByb3ZpZGVyXCIsIGFzeW5jICgpID0+IHtcblx0XHRjb25zdCByZWdpc3RyeSA9IGNyZWF0ZVJlZ2lzdHJ5KCk7XG5cdFx0cmVnaXN0cnkucmVnaXN0ZXJQcm92aWRlcihcImxvY2FsXCIsIHtcblx0XHRcdGF1dGhNb2RlOiBcIm5vbmVcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cDovL2xvY2FsaG9zdDoxMTQzNFwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0c3RyZWFtU2ltcGxlOiBub29wU3RyZWFtU2ltcGxlLFxuXHRcdFx0bW9kZWxzOiBbY3JlYXRlUHJvdmlkZXJNb2RlbChcIm1cIildLFxuXHRcdH0pO1xuXHRcdGNvbnN0IG1vZGVsID0gcmVnaXN0cnkuZ2V0QWxsKCkuZmluZCgobSkgPT4gbS5wcm92aWRlciA9PT0gXCJsb2NhbFwiKSE7XG5cdFx0YXNzZXJ0LmVxdWFsKGF3YWl0IHJlZ2lzdHJ5LmdldEFwaUtleShtb2RlbCksIHVuZGVmaW5lZCk7XG5cdH0pO1xuXG5cdGl0KFwiZGVsZWdhdGVzIHRvIGF1dGhTdG9yYWdlIGZvciBhcGlLZXkgcHJvdmlkZXJcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IHJlZ2lzdHJ5ID0gY3JlYXRlUmVnaXN0cnkoKTtcblx0XHRjb25zdCBrZXkgPSBhd2FpdCByZWdpc3RyeS5nZXRBcGlLZXlGb3JQcm92aWRlcihcImFudGhyb3BpY1wiKTtcblx0XHRhc3NlcnQuZXF1YWwoa2V5LCB1bmRlZmluZWQpO1xuXHR9KTtcblxuXHRpdChcInN0aWxsIHJlc29sdmVzIHByb3ZpZGVyIGtleXMgZm9yIGRlbnlsaXN0ZWQgcHJvdmlkZXJzXCIsIGFzeW5jICgpID0+IHtcblx0XHRjb25zdCByZWdpc3RyeSA9IGNyZWF0ZVJlZ2lzdHJ5KFxuXHRcdFx0KCkgPT4gdHJ1ZSxcblx0XHRcdGFzeW5jIChwcm92aWRlcjogc3RyaW5nKSA9PiBwcm92aWRlciA9PT0gXCJnb29nbGUtZ2VtaW5pLWNsaVwiID8gXCJ5YTI5LnRlc3QtdG9rZW5cIiA6IHVuZGVmaW5lZCxcblx0XHQpO1xuXHRcdHJlZ2lzdHJ5LnNldERpc2FibGVkTW9kZWxQcm92aWRlcnMoW1wiZ29vZ2xlLWdlbWluaS1jbGlcIl0pO1xuXHRcdGNvbnN0IGtleSA9IGF3YWl0IHJlZ2lzdHJ5LmdldEFwaUtleUZvclByb3ZpZGVyKFwiZ29vZ2xlLWdlbWluaS1jbGlcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKGtleSwgXCJ5YTI5LnRlc3QtdG9rZW5cIik7XG5cdH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBzdHJlYW1TaW1wbGUgYXBpS2V5IHN0cmlwcGluZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJNb2RlbFJlZ2lzdHJ5IGF1dGhNb2RlIFx1MjAxNCBzdHJlYW1TaW1wbGUgYXBpS2V5IGJvdW5kYXJ5XCIsICgpID0+IHtcblx0aXQoXCJzdHJpcHMgYXBpS2V5IGZyb20gb3B0aW9ucyBmb3IgZXh0ZXJuYWxDbGkgcHJvdmlkZXJcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlZ2lzdHJ5ID0gY3JlYXRlUmVnaXN0cnkoKTtcblx0XHRjb25zdCBzcHkgPSBjcmVhdGVTdHJlYW1TcHkoKTtcblx0XHRjb25zdCBhcGlUeXBlID0gYGV4dC1jbGktc3RyaXAtJHtEYXRlLm5vdygpfWA7XG5cblx0XHRyZWdpc3RyeS5yZWdpc3RlclByb3ZpZGVyKFwiY2xpLXN0cmlwXCIsIHtcblx0XHRcdGF1dGhNb2RlOiBcImV4dGVybmFsQ2xpXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vY2xpLmxvY2FsXCIsXG5cdFx0XHRhcGk6IGFwaVR5cGUgYXMgQXBpLFxuXHRcdFx0c3RyZWFtU2ltcGxlOiBzcHkuc3RyZWFtU2ltcGxlLFxuXHRcdFx0bW9kZWxzOiBbY3JlYXRlUHJvdmlkZXJNb2RlbChcIm1cIiwgYXBpVHlwZSldLFxuXHRcdH0pO1xuXG5cdFx0Y29uc3QgcHJvdmlkZXIgPSBnZXRBcGlQcm92aWRlcihhcGlUeXBlIGFzIEFwaSk7XG5cdFx0YXNzZXJ0Lm9rKHByb3ZpZGVyLCBcInByb3ZpZGVyIG11c3QgYmUgcmVnaXN0ZXJlZCBpbiBhcGkgcmVnaXN0cnlcIik7XG5cblx0XHRwcm92aWRlci5zdHJlYW1TaW1wbGUoXG5cdFx0XHRtYWtlTW9kZWwoXCJjbGktc3RyaXBcIiwgXCJtXCIsIGFwaVR5cGUpLFxuXHRcdFx0bWFrZUNvbnRleHQoKSxcblx0XHRcdHsgYXBpS2V5OiBcInNob3VsZC1iZS1zdHJpcHBlZFwiLCBtYXhUb2tlbnM6IDEwMjQgfSBhcyBTaW1wbGVTdHJlYW1PcHRpb25zLFxuXHRcdCk7XG5cblx0XHRjb25zdCBjYXB0dXJlZCA9IHNweS5nZXRDYXB0dXJlZE9wdGlvbnMoKTtcblx0XHRhc3NlcnQub2soY2FwdHVyZWQsIFwic3RyZWFtU2ltcGxlIG11c3QgaGF2ZSBiZWVuIGNhbGxlZFwiKTtcblx0XHRhc3NlcnQuZXF1YWwoXCJhcGlLZXlcIiBpbiBjYXB0dXJlZCwgZmFsc2UsIFwiYXBpS2V5IG11c3Qgbm90IGV4aXN0IGluIG9wdGlvbnMgZm9yIGV4dGVybmFsQ2xpIHByb3ZpZGVyXCIpO1xuXHRcdGFzc2VydC5lcXVhbChjYXB0dXJlZC5tYXhUb2tlbnMsIDEwMjQsIFwib3RoZXIgb3B0aW9ucyBtdXN0IHBhc3MgdGhyb3VnaFwiKTtcblx0fSk7XG5cblx0aXQoXCJzdHJpcHMgYXBpS2V5IGZyb20gb3B0aW9ucyBmb3Igbm9uZSBwcm92aWRlclwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVnaXN0cnkgPSBjcmVhdGVSZWdpc3RyeSgpO1xuXHRcdGNvbnN0IHNweSA9IGNyZWF0ZVN0cmVhbVNweSgpO1xuXHRcdGNvbnN0IGFwaVR5cGUgPSBgbm9uZS1zdHJpcC0ke0RhdGUubm93KCl9YDtcblxuXHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyUHJvdmlkZXIoXCJub25lLXN0cmlwXCIsIHtcblx0XHRcdGF1dGhNb2RlOiBcIm5vbmVcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cDovL2xvY2FsaG9zdDoxMTQzNFwiLFxuXHRcdFx0YXBpOiBhcGlUeXBlIGFzIEFwaSxcblx0XHRcdHN0cmVhbVNpbXBsZTogc3B5LnN0cmVhbVNpbXBsZSxcblx0XHRcdG1vZGVsczogW2NyZWF0ZVByb3ZpZGVyTW9kZWwoXCJtXCIsIGFwaVR5cGUpXSxcblx0XHR9KTtcblxuXHRcdGNvbnN0IHByb3ZpZGVyID0gZ2V0QXBpUHJvdmlkZXIoYXBpVHlwZSBhcyBBcGkpO1xuXHRcdGFzc2VydC5vayhwcm92aWRlciwgXCJwcm92aWRlciBtdXN0IGJlIHJlZ2lzdGVyZWQgaW4gYXBpIHJlZ2lzdHJ5XCIpO1xuXG5cdFx0cHJvdmlkZXIuc3RyZWFtU2ltcGxlKFxuXHRcdFx0bWFrZU1vZGVsKFwibm9uZS1zdHJpcFwiLCBcIm1cIiwgYXBpVHlwZSksXG5cdFx0XHRtYWtlQ29udGV4dCgpLFxuXHRcdFx0eyBhcGlLZXk6IFwic2hvdWxkLWJlLXN0cmlwcGVkXCIsIG1heFRva2VuczogMjA0OCB9IGFzIFNpbXBsZVN0cmVhbU9wdGlvbnMsXG5cdFx0KTtcblxuXHRcdGNvbnN0IGNhcHR1cmVkID0gc3B5LmdldENhcHR1cmVkT3B0aW9ucygpO1xuXHRcdGFzc2VydC5vayhjYXB0dXJlZCwgXCJzdHJlYW1TaW1wbGUgbXVzdCBoYXZlIGJlZW4gY2FsbGVkXCIpO1xuXHRcdGFzc2VydC5lcXVhbChcImFwaUtleVwiIGluIGNhcHR1cmVkLCBmYWxzZSwgXCJhcGlLZXkgbXVzdCBub3QgZXhpc3QgaW4gb3B0aW9ucyBmb3Igbm9uZSBwcm92aWRlclwiKTtcblx0XHRhc3NlcnQuZXF1YWwoY2FwdHVyZWQubWF4VG9rZW5zLCAyMDQ4LCBcIm90aGVyIG9wdGlvbnMgbXVzdCBwYXNzIHRocm91Z2hcIik7XG5cdH0pO1xuXG5cdGl0KFwicHJlc2VydmVzIGFwaUtleSBpbiBvcHRpb25zIGZvciBhcGlLZXkgcHJvdmlkZXJcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlZ2lzdHJ5ID0gY3JlYXRlUmVnaXN0cnkoKTtcblx0XHRjb25zdCBzcHkgPSBjcmVhdGVTdHJlYW1TcHkoKTtcblx0XHRjb25zdCBhcGlUeXBlID0gYGFwaWtleS1wcmVzZXJ2ZS0ke0RhdGUubm93KCl9YDtcblxuXHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyUHJvdmlkZXIoXCJhcGlrZXktcHJlc2VydmVcIiwge1xuXHRcdFx0YXBpS2V5OiBcIk1ZX0tFWVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FwaS5sb2NhbFwiLFxuXHRcdFx0YXBpOiBhcGlUeXBlIGFzIEFwaSxcblx0XHRcdHN0cmVhbVNpbXBsZTogc3B5LnN0cmVhbVNpbXBsZSxcblx0XHRcdG1vZGVsczogW2NyZWF0ZVByb3ZpZGVyTW9kZWwoXCJtXCIsIGFwaVR5cGUpXSxcblx0XHR9KTtcblxuXHRcdGNvbnN0IHByb3ZpZGVyID0gZ2V0QXBpUHJvdmlkZXIoYXBpVHlwZSBhcyBBcGkpO1xuXHRcdGFzc2VydC5vayhwcm92aWRlciwgXCJwcm92aWRlciBtdXN0IGJlIHJlZ2lzdGVyZWQgaW4gYXBpIHJlZ2lzdHJ5XCIpO1xuXG5cdFx0cHJvdmlkZXIuc3RyZWFtU2ltcGxlKFxuXHRcdFx0bWFrZU1vZGVsKFwiYXBpa2V5LXByZXNlcnZlXCIsIFwibVwiLCBhcGlUeXBlKSxcblx0XHRcdG1ha2VDb250ZXh0KCksXG5cdFx0XHR7IGFwaUtleTogXCJzay1yZWFsLWtleVwiLCBtYXhUb2tlbnM6IDQwOTYgfSBhcyBTaW1wbGVTdHJlYW1PcHRpb25zLFxuXHRcdCk7XG5cblx0XHRjb25zdCBjYXB0dXJlZCA9IHNweS5nZXRDYXB0dXJlZE9wdGlvbnMoKTtcblx0XHRhc3NlcnQub2soY2FwdHVyZWQsIFwic3RyZWFtU2ltcGxlIG11c3QgaGF2ZSBiZWVuIGNhbGxlZFwiKTtcblx0XHRhc3NlcnQuZXF1YWwoY2FwdHVyZWQuYXBpS2V5LCBcInNrLXJlYWwta2V5XCIsIFwiYXBpS2V5IG11c3QgYmUgcHJlc2VydmVkIGZvciBhcGlLZXkgcHJvdmlkZXJcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKGNhcHR1cmVkLm1heFRva2VucywgNDA5NiwgXCJvdGhlciBvcHRpb25zIG11c3QgcGFzcyB0aHJvdWdoXCIpO1xuXHR9KTtcblxuXHRpdChcImhhbmRsZXMgdW5kZWZpbmVkIG9wdGlvbnMgZm9yIGV4dGVybmFsQ2xpIHByb3ZpZGVyXCIsICgpID0+IHtcblx0XHRjb25zdCByZWdpc3RyeSA9IGNyZWF0ZVJlZ2lzdHJ5KCk7XG5cdFx0Y29uc3Qgc3B5ID0gY3JlYXRlU3RyZWFtU3B5KCk7XG5cdFx0Y29uc3QgYXBpVHlwZSA9IGBleHQtY2xpLXVuZGVmLSR7RGF0ZS5ub3coKX1gO1xuXG5cdFx0cmVnaXN0cnkucmVnaXN0ZXJQcm92aWRlcihcImNsaS11bmRlZlwiLCB7XG5cdFx0XHRhdXRoTW9kZTogXCJleHRlcm5hbENsaVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2NsaS5sb2NhbFwiLFxuXHRcdFx0YXBpOiBhcGlUeXBlIGFzIEFwaSxcblx0XHRcdHN0cmVhbVNpbXBsZTogc3B5LnN0cmVhbVNpbXBsZSxcblx0XHRcdG1vZGVsczogW2NyZWF0ZVByb3ZpZGVyTW9kZWwoXCJtXCIsIGFwaVR5cGUpXSxcblx0XHR9KTtcblxuXHRcdGNvbnN0IHByb3ZpZGVyID0gZ2V0QXBpUHJvdmlkZXIoYXBpVHlwZSBhcyBBcGkpO1xuXHRcdGFzc2VydC5vayhwcm92aWRlciwgXCJwcm92aWRlciBtdXN0IGJlIHJlZ2lzdGVyZWQgaW4gYXBpIHJlZ2lzdHJ5XCIpO1xuXG5cdFx0cHJvdmlkZXIuc3RyZWFtU2ltcGxlKFxuXHRcdFx0bWFrZU1vZGVsKFwiY2xpLXVuZGVmXCIsIFwibVwiLCBhcGlUeXBlKSxcblx0XHRcdG1ha2VDb250ZXh0KCksXG5cdFx0XHR1bmRlZmluZWQsXG5cdFx0KTtcblxuXHRcdGNvbnN0IGNhcHR1cmVkID0gc3B5LmdldENhcHR1cmVkT3B0aW9ucygpO1xuXHRcdGFzc2VydC5vayhjYXB0dXJlZCAhPT0gdW5kZWZpbmVkLCBcInN0cmVhbVNpbXBsZSBtdXN0IGhhdmUgYmVlbiBjYWxsZWRcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKFwiYXBpS2V5XCIgaW4gY2FwdHVyZWQsIGZhbHNlLCBcImFwaUtleSBtdXN0IG5vdCBleGlzdCBldmVuIHdoZW4gb3B0aW9ucyBpcyB1bmRlZmluZWRcIik7XG5cdH0pO1xuXG5cdGl0KFwic3RyaXBzIGFwaUtleSBidXQgcHJlc2VydmVzIHNpZ25hbCBhbmQgb3RoZXIgZmllbGRzIGZvciBleHRlcm5hbENsaVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVnaXN0cnkgPSBjcmVhdGVSZWdpc3RyeSgpO1xuXHRcdGNvbnN0IHNweSA9IGNyZWF0ZVN0cmVhbVNweSgpO1xuXHRcdGNvbnN0IGFwaVR5cGUgPSBgZXh0LWNsaS1maWVsZHMtJHtEYXRlLm5vdygpfWA7XG5cdFx0Y29uc3QgYWJvcnRDb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuXG5cdFx0cmVnaXN0cnkucmVnaXN0ZXJQcm92aWRlcihcImNsaS1maWVsZHNcIiwge1xuXHRcdFx0YXV0aE1vZGU6IFwiZXh0ZXJuYWxDbGlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9jbGkubG9jYWxcIixcblx0XHRcdGFwaTogYXBpVHlwZSBhcyBBcGksXG5cdFx0XHRzdHJlYW1TaW1wbGU6IHNweS5zdHJlYW1TaW1wbGUsXG5cdFx0XHRtb2RlbHM6IFtjcmVhdGVQcm92aWRlck1vZGVsKFwibVwiLCBhcGlUeXBlKV0sXG5cdFx0fSk7XG5cblx0XHRjb25zdCBwcm92aWRlciA9IGdldEFwaVByb3ZpZGVyKGFwaVR5cGUgYXMgQXBpKTtcblx0XHRhc3NlcnQub2socHJvdmlkZXIsIFwicHJvdmlkZXIgbXVzdCBiZSByZWdpc3RlcmVkIGluIGFwaSByZWdpc3RyeVwiKTtcblxuXHRcdHByb3ZpZGVyLnN0cmVhbVNpbXBsZShcblx0XHRcdG1ha2VNb2RlbChcImNsaS1maWVsZHNcIiwgXCJtXCIsIGFwaVR5cGUpLFxuXHRcdFx0bWFrZUNvbnRleHQoKSxcblx0XHRcdHsgYXBpS2V5OiBcInN0cmlwLW1lXCIsIG1heFRva2VuczogODE5Miwgc2lnbmFsOiBhYm9ydENvbnRyb2xsZXIuc2lnbmFsLCByZWFzb25pbmc6IFwiaGlnaFwiIH0gYXMgU2ltcGxlU3RyZWFtT3B0aW9ucyxcblx0XHQpO1xuXG5cdFx0Y29uc3QgY2FwdHVyZWQgPSBzcHkuZ2V0Q2FwdHVyZWRPcHRpb25zKCk7XG5cdFx0YXNzZXJ0Lm9rKGNhcHR1cmVkLCBcInN0cmVhbVNpbXBsZSBtdXN0IGhhdmUgYmVlbiBjYWxsZWRcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKFwiYXBpS2V5XCIgaW4gY2FwdHVyZWQsIGZhbHNlLCBcImFwaUtleSBtdXN0IGJlIHN0cmlwcGVkXCIpO1xuXHRcdGFzc2VydC5lcXVhbChjYXB0dXJlZC5tYXhUb2tlbnMsIDgxOTIsIFwibWF4VG9rZW5zIG11c3QgcGFzcyB0aHJvdWdoXCIpO1xuXHRcdGFzc2VydC5lcXVhbChjYXB0dXJlZC5zaWduYWwsIGFib3J0Q29udHJvbGxlci5zaWduYWwsIFwic2lnbmFsIG11c3QgcGFzcyB0aHJvdWdoXCIpO1xuXHRcdGFzc2VydC5lcXVhbCgoY2FwdHVyZWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pLnJlYXNvbmluZywgXCJoaWdoXCIsIFwicmVhc29uaW5nIG11c3QgcGFzcyB0aHJvdWdoXCIpO1xuXHR9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUHJvdmlkZXItc2NvcGVkIHN0cmVhbSByb3V0aW5nICgjMjUzMykgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiTW9kZWxSZWdpc3RyeSBhdXRoTW9kZSBcdTIwMTQgcHJvdmlkZXItc2NvcGVkIHN0cmVhbSByb3V0aW5nXCIsICgpID0+IHtcblx0aXQoXCJkb2VzIG5vdCBjbG9iYmVyIGJ1aWx0LWluIHN0cmVhbSBoYW5kbGVyIHdoZW4gY3VzdG9tIHByb3ZpZGVyIHVzZXMgc2FtZSBhcGlcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlZ2lzdHJ5ID0gY3JlYXRlUmVnaXN0cnkoKCkgPT4gdHJ1ZSk7XG5cdFx0Y29uc3QgY3VzdG9tU3B5ID0gY3JlYXRlU3RyZWFtU3B5KCk7XG5cblx0XHQvLyBSZWdpc3RlciBhIGN1c3RvbSBwcm92aWRlciB3aXRoIHRoZSBzYW1lIEFQSSB0eXBlIGFzIGEgYnVpbHQtaW4gKGFudGhyb3BpYy1tZXNzYWdlcykuXG5cdFx0Ly8gVGhpcyBzaW11bGF0ZXMgdGhlIGNsYXVkZS1jb2RlLWNsaSBleHRlbnNpb24gcmVnaXN0ZXJpbmcgd2l0aCBhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIuXG5cdFx0cmVnaXN0cnkucmVnaXN0ZXJQcm92aWRlcihcImN1c3RvbS1jbGlcIiwge1xuXHRcdFx0YXV0aE1vZGU6IFwiZXh0ZXJuYWxDbGlcIixcblx0XHRcdGJhc2VVcmw6IFwibG9jYWw6Ly9jdXN0b21cIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHN0cmVhbVNpbXBsZTogY3VzdG9tU3B5LnN0cmVhbVNpbXBsZSxcblx0XHRcdG1vZGVsczogW2NyZWF0ZVByb3ZpZGVyTW9kZWwoXCJjdXN0b20tbW9kZWxcIiwgXCJhbnRocm9waWMtbWVzc2FnZXNcIildLFxuXHRcdH0pO1xuXG5cdFx0Ly8gVGhlIGJ1aWx0LWluIGFudGhyb3BpYy1tZXNzYWdlcyBwcm92aWRlciBzaG91bGQgc3RpbGwgYmUgYWNjZXNzaWJsZVxuXHRcdC8vIHdoZW4gY2FsbGluZyBzdHJlYW1TaW1wbGUgd2l0aCBhIG1vZGVsIGZyb20gdGhlIGJ1aWx0LWluIHByb3ZpZGVyLlxuXHRcdGNvbnN0IHByb3ZpZGVyID0gZ2V0QXBpUHJvdmlkZXIoXCJhbnRocm9waWMtbWVzc2FnZXNcIiBhcyBBcGkpO1xuXHRcdGFzc2VydC5vayhwcm92aWRlciwgXCJhbnRocm9waWMtbWVzc2FnZXMgcHJvdmlkZXIgbXVzdCBzdGlsbCBiZSByZWdpc3RlcmVkXCIpO1xuXG5cdFx0Ly8gQ2FsbCB3aXRoIGEgYnVpbHQtaW4gYW50aHJvcGljIG1vZGVsIFx1MjAxNCBzaG91bGQgTk9UIGhpdCB0aGUgY3VzdG9tIHNweS5cblx0XHQvLyBUaGUgYnVpbHQtaW4gaGFuZGxlciB3aWxsIHRocm93IChubyBBUEkga2V5KSwgd2hpY2ggcHJvdmVzIHRoZSByb3V0aW5nXG5cdFx0Ly8gY29ycmVjdGx5IGRlbGVnYXRlcyB0byB0aGUgYnVpbHQtaW4gaW5zdGVhZCBvZiB0aGUgY3VzdG9tIGhhbmRsZXIuXG5cdFx0YXNzZXJ0LnRocm93cyhcblx0XHRcdCgpID0+IHByb3ZpZGVyLnN0cmVhbVNpbXBsZShcblx0XHRcdFx0bWFrZU1vZGVsKFwiYW50aHJvcGljXCIsIFwiY2xhdWRlLXNvbm5ldC00LTZcIiwgXCJhbnRocm9waWMtbWVzc2FnZXNcIiksXG5cdFx0XHRcdG1ha2VDb250ZXh0KCksXG5cdFx0XHRcdHsgbWF4VG9rZW5zOiA0MDk2IH0gYXMgU2ltcGxlU3RyZWFtT3B0aW9ucyxcblx0XHRcdCksXG5cdFx0XHQoZXJyOiBFcnJvcikgPT4gZXJyLm1lc3NhZ2UuaW5jbHVkZXMoXCJBUEkga2V5XCIpLFxuXHRcdFx0XCJidWlsdC1pbiBBbnRocm9waWMgaGFuZGxlciBtdXN0IGJlIGludm9rZWQgKHRocm93cyBiZWNhdXNlIG5vIEFQSSBrZXkgaW4gdGVzdHMpXCIsXG5cdFx0KTtcblxuXHRcdGFzc2VydC5lcXVhbChcblx0XHRcdGN1c3RvbVNweS5nZXRDYXB0dXJlZE9wdGlvbnMoKSxcblx0XHRcdHVuZGVmaW5lZCxcblx0XHRcdFwiY3VzdG9tIHByb3ZpZGVyJ3Mgc3RyZWFtU2ltcGxlIG11c3QgTk9UIGJlIGNhbGxlZCBmb3IgYW50aHJvcGljIHByb3ZpZGVyIG1vZGVsc1wiLFxuXHRcdCk7XG5cdH0pO1xuXG5cdGl0KFwicm91dGVzIHRvIGN1c3RvbSBwcm92aWRlciB3aGVuIG1vZGVsLnByb3ZpZGVyIG1hdGNoZXNcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlZ2lzdHJ5ID0gY3JlYXRlUmVnaXN0cnkoKCkgPT4gdHJ1ZSk7XG5cdFx0Y29uc3QgY3VzdG9tU3B5ID0gY3JlYXRlU3RyZWFtU3B5KCk7XG5cblx0XHRyZWdpc3RyeS5yZWdpc3RlclByb3ZpZGVyKFwiY3VzdG9tLWNsaVwiLCB7XG5cdFx0XHRhdXRoTW9kZTogXCJleHRlcm5hbENsaVwiLFxuXHRcdFx0YmFzZVVybDogXCJsb2NhbDovL2N1c3RvbVwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0c3RyZWFtU2ltcGxlOiBjdXN0b21TcHkuc3RyZWFtU2ltcGxlLFxuXHRcdFx0bW9kZWxzOiBbY3JlYXRlUHJvdmlkZXJNb2RlbChcImN1c3RvbS1tb2RlbFwiLCBcImFudGhyb3BpYy1tZXNzYWdlc1wiKV0sXG5cdFx0fSk7XG5cblx0XHRjb25zdCBwcm92aWRlciA9IGdldEFwaVByb3ZpZGVyKFwiYW50aHJvcGljLW1lc3NhZ2VzXCIgYXMgQXBpKTtcblx0XHRhc3NlcnQub2socHJvdmlkZXIpO1xuXG5cdFx0Ly8gQ2FsbCB3aXRoIHRoZSBjdXN0b20gcHJvdmlkZXIncyBtb2RlbCBcdTIwMTQgc2hvdWxkIGhpdCB0aGUgY3VzdG9tIHNweVxuXHRcdHByb3ZpZGVyLnN0cmVhbVNpbXBsZShcblx0XHRcdG1ha2VNb2RlbChcImN1c3RvbS1jbGlcIiwgXCJjdXN0b20tbW9kZWxcIiwgXCJhbnRocm9waWMtbWVzc2FnZXNcIiksXG5cdFx0XHRtYWtlQ29udGV4dCgpLFxuXHRcdFx0eyBtYXhUb2tlbnM6IDIwNDggfSBhcyBTaW1wbGVTdHJlYW1PcHRpb25zLFxuXHRcdCk7XG5cblx0XHRjb25zdCBjYXB0dXJlZCA9IGN1c3RvbVNweS5nZXRDYXB0dXJlZE9wdGlvbnMoKTtcblx0XHRhc3NlcnQub2soY2FwdHVyZWQsIFwiY3VzdG9tIHByb3ZpZGVyJ3Mgc3RyZWFtU2ltcGxlIG11c3QgYmUgY2FsbGVkIGZvciBpdHMgb3duIG1vZGVsc1wiKTtcblx0XHRhc3NlcnQuZXF1YWwoY2FwdHVyZWQubWF4VG9rZW5zLCAyMDQ4KTtcblx0fSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLE9BQU8sWUFBWTtBQUNuQixTQUFTLFVBQVUsVUFBVTtBQUU3QixTQUFTLHNCQUFzQjtBQUMvQixTQUFTLG1CQUF5QztBQUNsRCxTQUFTLHFCQUFxQjtBQUU5QixTQUFTLGVBQ1IsV0FDQSxhQUNn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
