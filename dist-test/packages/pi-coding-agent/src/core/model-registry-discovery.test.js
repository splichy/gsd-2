import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { AuthStorage } from "./auth-storage.js";
import { ModelDiscoveryCache } from "./discovery-cache.js";
import { getDefaultTTL, getDiscoverableProviders, getDiscoveryAdapter } from "./model-discovery.js";
import { ModelRegistry } from "./model-registry.js";
let testDir;
beforeEach(() => {
  testDir = join(tmpdir(), `model-registry-discovery-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});
afterEach(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
  }
});
describe("ModelDiscoveryCache \u2014 integration with discovery", () => {
  it("cache respects provider-specific TTLs", () => {
    const cachePath = join(testDir, "cache.json");
    const cache = new ModelDiscoveryCache(cachePath);
    cache.set("ollama", [{ id: "llama2" }]);
    const entry = cache.get("ollama");
    assert.ok(entry);
    assert.equal(entry.ttlMs, getDefaultTTL("ollama"));
  });
  it("cache uses custom TTL when provided", () => {
    const cachePath = join(testDir, "cache.json");
    const cache = new ModelDiscoveryCache(cachePath);
    cache.set("openai", [{ id: "gpt-4o" }], 999);
    const entry = cache.get("openai");
    assert.ok(entry);
    assert.equal(entry.ttlMs, 999);
  });
});
describe("Discovery adapter resolution", () => {
  it("all discoverable providers have adapters", () => {
    const providers = getDiscoverableProviders();
    for (const provider of providers) {
      const adapter = getDiscoveryAdapter(provider);
      assert.equal(adapter.supportsDiscovery, true, `${provider} should support discovery`);
    }
  });
  it("static adapters return empty model lists", async () => {
    const staticProviders = ["anthropic", "bedrock", "azure-openai", "groq", "cerebras"];
    for (const provider of staticProviders) {
      const adapter = getDiscoveryAdapter(provider);
      assert.equal(adapter.supportsDiscovery, false, `${provider} should not support discovery`);
      const models = await adapter.fetchModels("dummy-key");
      assert.deepEqual(models, [], `${provider} should return empty models`);
    }
  });
});
describe("AuthStorage \u2014 hasAuth for discovery providers", () => {
  it("returns false for providers without auth", () => {
    const storage = AuthStorage.inMemory({});
    assert.equal(storage.hasAuth("openai"), false);
    assert.equal(storage.hasAuth("ollama"), false);
  });
  it("returns true for providers with stored keys", () => {
    const storage = AuthStorage.inMemory({
      openai: { type: "api_key", key: "sk-test" }
    });
    assert.equal(storage.hasAuth("openai"), true);
    assert.equal(storage.hasAuth("ollama"), false);
  });
});
describe("ModelDiscoveryCache \u2014 persistence", () => {
  it("data survives across cache instances", () => {
    const cachePath = join(testDir, "persist.json");
    const cache1 = new ModelDiscoveryCache(cachePath);
    cache1.set("openai", [
      { id: "gpt-4o", name: "GPT-4o", contextWindow: 128e3 },
      { id: "gpt-4o-mini", name: "GPT-4o Mini" }
    ]);
    const cache2 = new ModelDiscoveryCache(cachePath);
    const entry = cache2.get("openai");
    assert.ok(entry);
    assert.equal(entry.models.length, 2);
    assert.equal(entry.models[0].contextWindow, 128e3);
  });
  it("clear persists across instances", () => {
    const cachePath = join(testDir, "clear.json");
    const cache1 = new ModelDiscoveryCache(cachePath);
    cache1.set("openai", [{ id: "gpt-4o" }]);
    cache1.clear("openai");
    const cache2 = new ModelDiscoveryCache(cachePath);
    assert.equal(cache2.get("openai"), void 0);
  });
});
describe("Discovery TTL configuration", () => {
  it("ollama has shortest TTL (local models change often)", () => {
    const ollamaTTL = getDefaultTTL("ollama");
    const openaiTTL = getDefaultTTL("openai");
    assert.ok(ollamaTTL < openaiTTL, "ollama TTL should be shorter than openai");
  });
  it("unknown providers get default TTL", () => {
    const customTTL = getDefaultTTL("my-custom-provider");
    const defaultTTL = getDefaultTTL("default");
    assert.equal(customTTL, defaultTTL);
  });
});
describe("ModelRegistry discovery \u2014 OpenAI-compatible custom providers", () => {
  it("discovers custom OpenAI-compatible providers and maps capability metadata", async () => {
    const providerName = `minimax-openai-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const modelsPath = join(testDir, "models.json");
    writeFileSync(
      modelsPath,
      JSON.stringify(
        {
          providers: {
            [providerName]: {
              baseUrl: "https://api.minimax.example",
              apiKey: "minimax-test-key",
              api: "openai-completions",
              models: [{ id: "bootstrap-model" }]
            }
          }
        },
        null,
        2
      ),
      "utf-8"
    );
    const prevFetch = globalThis.fetch;
    let requestedUrl = "";
    globalThis.fetch = (async (input) => {
      requestedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "MiniMax-M2.7-highspeed",
              name: "MiniMax M2.7 Highspeed",
              context_window: 165e3,
              max_output_tokens: 32768,
              supports_reasoning: true,
              input_modalities: ["text", "image"]
            }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    });
    try {
      const registry = new ModelRegistry(AuthStorage.inMemory({}), modelsPath);
      registry.getDiscoveryCache().clear(providerName);
      const results = await registry.discoverModels([providerName]);
      const discovery = results.find((r) => r.provider === providerName);
      assert.ok(discovery, "discovery result should include custom provider");
      assert.equal(discovery?.error, void 0, "custom provider discovery should succeed");
      assert.equal(requestedUrl, "https://api.minimax.example/v1/models");
      const discovered = registry.getAllWithDiscovered().find((m) => m.provider === providerName && m.id === "MiniMax-M2.7-highspeed");
      assert.ok(discovered, "discovered model should be merged into model list");
      assert.equal(discovered?.api, "openai-completions");
      assert.equal(discovered?.baseUrl, "https://api.minimax.example");
      assert.equal(discovered?.contextWindow, 165e3);
      assert.equal(discovered?.maxTokens, 32768);
      assert.equal(discovered?.reasoning, true);
      assert.deepEqual(discovered?.input, ["text", "image"]);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL21vZGVsLXJlZ2lzdHJ5LWRpc2NvdmVyeS50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZGlyU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgYWZ0ZXJFYWNoLCBiZWZvcmVFYWNoLCBkZXNjcmliZSwgaXQgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgeyBBdXRoU3RvcmFnZSB9IGZyb20gXCIuL2F1dGgtc3RvcmFnZS5qc1wiO1xuaW1wb3J0IHsgTW9kZWxEaXNjb3ZlcnlDYWNoZSB9IGZyb20gXCIuL2Rpc2NvdmVyeS1jYWNoZS5qc1wiO1xuaW1wb3J0IHsgZ2V0RGVmYXVsdFRUTCwgZ2V0RGlzY292ZXJhYmxlUHJvdmlkZXJzLCBnZXREaXNjb3ZlcnlBZGFwdGVyIH0gZnJvbSBcIi4vbW9kZWwtZGlzY292ZXJ5LmpzXCI7XG5pbXBvcnQgeyBNb2RlbFJlZ2lzdHJ5IH0gZnJvbSBcIi4vbW9kZWwtcmVnaXN0cnkuanNcIjtcblxubGV0IHRlc3REaXI6IHN0cmluZztcblxuYmVmb3JlRWFjaCgoKSA9PiB7XG5cdHRlc3REaXIgPSBqb2luKHRtcGRpcigpLCBgbW9kZWwtcmVnaXN0cnktZGlzY292ZXJ5LXRlc3QtJHtEYXRlLm5vdygpfS0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIpfWApO1xuXHRta2RpclN5bmModGVzdERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG59KTtcblxuYWZ0ZXJFYWNoKCgpID0+IHtcblx0dHJ5IHtcblx0XHRybVN5bmModGVzdERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuXHR9IGNhdGNoIHtcblx0XHQvLyBDbGVhbnVwIGJlc3QtZWZmb3J0XG5cdH1cbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgZGlzY292ZXJ5IGNhY2hlIGludGVncmF0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcIk1vZGVsRGlzY292ZXJ5Q2FjaGUgXHUyMDE0IGludGVncmF0aW9uIHdpdGggZGlzY292ZXJ5XCIsICgpID0+IHtcblx0aXQoXCJjYWNoZSByZXNwZWN0cyBwcm92aWRlci1zcGVjaWZpYyBUVExzXCIsICgpID0+IHtcblx0XHRjb25zdCBjYWNoZVBhdGggPSBqb2luKHRlc3REaXIsIFwiY2FjaGUuanNvblwiKTtcblx0XHRjb25zdCBjYWNoZSA9IG5ldyBNb2RlbERpc2NvdmVyeUNhY2hlKGNhY2hlUGF0aCk7XG5cblx0XHRjYWNoZS5zZXQoXCJvbGxhbWFcIiwgW3sgaWQ6IFwibGxhbWEyXCIgfV0pO1xuXHRcdGNvbnN0IGVudHJ5ID0gY2FjaGUuZ2V0KFwib2xsYW1hXCIpO1xuXHRcdGFzc2VydC5vayhlbnRyeSk7XG5cdFx0YXNzZXJ0LmVxdWFsKGVudHJ5LnR0bE1zLCBnZXREZWZhdWx0VFRMKFwib2xsYW1hXCIpKTtcblx0fSk7XG5cblx0aXQoXCJjYWNoZSB1c2VzIGN1c3RvbSBUVEwgd2hlbiBwcm92aWRlZFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgY2FjaGVQYXRoID0gam9pbih0ZXN0RGlyLCBcImNhY2hlLmpzb25cIik7XG5cdFx0Y29uc3QgY2FjaGUgPSBuZXcgTW9kZWxEaXNjb3ZlcnlDYWNoZShjYWNoZVBhdGgpO1xuXG5cdFx0Y2FjaGUuc2V0KFwib3BlbmFpXCIsIFt7IGlkOiBcImdwdC00b1wiIH1dLCA5OTkpO1xuXHRcdGNvbnN0IGVudHJ5ID0gY2FjaGUuZ2V0KFwib3BlbmFpXCIpO1xuXHRcdGFzc2VydC5vayhlbnRyeSk7XG5cdFx0YXNzZXJ0LmVxdWFsKGVudHJ5LnR0bE1zLCA5OTkpO1xuXHR9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgYWRhcHRlciByZXNvbHV0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcIkRpc2NvdmVyeSBhZGFwdGVyIHJlc29sdXRpb25cIiwgKCkgPT4ge1xuXHRpdChcImFsbCBkaXNjb3ZlcmFibGUgcHJvdmlkZXJzIGhhdmUgYWRhcHRlcnNcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHByb3ZpZGVycyA9IGdldERpc2NvdmVyYWJsZVByb3ZpZGVycygpO1xuXHRcdGZvciAoY29uc3QgcHJvdmlkZXIgb2YgcHJvdmlkZXJzKSB7XG5cdFx0XHRjb25zdCBhZGFwdGVyID0gZ2V0RGlzY292ZXJ5QWRhcHRlcihwcm92aWRlcik7XG5cdFx0XHRhc3NlcnQuZXF1YWwoYWRhcHRlci5zdXBwb3J0c0Rpc2NvdmVyeSwgdHJ1ZSwgYCR7cHJvdmlkZXJ9IHNob3VsZCBzdXBwb3J0IGRpc2NvdmVyeWApO1xuXHRcdH1cblx0fSk7XG5cblx0aXQoXCJzdGF0aWMgYWRhcHRlcnMgcmV0dXJuIGVtcHR5IG1vZGVsIGxpc3RzXCIsIGFzeW5jICgpID0+IHtcblx0XHRjb25zdCBzdGF0aWNQcm92aWRlcnMgPSBbXCJhbnRocm9waWNcIiwgXCJiZWRyb2NrXCIsIFwiYXp1cmUtb3BlbmFpXCIsIFwiZ3JvcVwiLCBcImNlcmVicmFzXCJdO1xuXHRcdGZvciAoY29uc3QgcHJvdmlkZXIgb2Ygc3RhdGljUHJvdmlkZXJzKSB7XG5cdFx0XHRjb25zdCBhZGFwdGVyID0gZ2V0RGlzY292ZXJ5QWRhcHRlcihwcm92aWRlcik7XG5cdFx0XHRhc3NlcnQuZXF1YWwoYWRhcHRlci5zdXBwb3J0c0Rpc2NvdmVyeSwgZmFsc2UsIGAke3Byb3ZpZGVyfSBzaG91bGQgbm90IHN1cHBvcnQgZGlzY292ZXJ5YCk7XG5cdFx0XHRjb25zdCBtb2RlbHMgPSBhd2FpdCBhZGFwdGVyLmZldGNoTW9kZWxzKFwiZHVtbXkta2V5XCIpO1xuXHRcdFx0YXNzZXJ0LmRlZXBFcXVhbChtb2RlbHMsIFtdLCBgJHtwcm92aWRlcn0gc2hvdWxkIHJldHVybiBlbXB0eSBtb2RlbHNgKTtcblx0XHR9XG5cdH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBBdXRoU3RvcmFnZSBoYXNBdXRoIGZvciBkaXNjb3ZlcnkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiQXV0aFN0b3JhZ2UgXHUyMDE0IGhhc0F1dGggZm9yIGRpc2NvdmVyeSBwcm92aWRlcnNcIiwgKCkgPT4ge1xuXHRpdChcInJldHVybnMgZmFsc2UgZm9yIHByb3ZpZGVycyB3aXRob3V0IGF1dGhcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHN0b3JhZ2UgPSBBdXRoU3RvcmFnZS5pbk1lbW9yeSh7fSk7XG5cdFx0YXNzZXJ0LmVxdWFsKHN0b3JhZ2UuaGFzQXV0aChcIm9wZW5haVwiKSwgZmFsc2UpO1xuXHRcdGFzc2VydC5lcXVhbChzdG9yYWdlLmhhc0F1dGgoXCJvbGxhbWFcIiksIGZhbHNlKTtcblx0fSk7XG5cblx0aXQoXCJyZXR1cm5zIHRydWUgZm9yIHByb3ZpZGVycyB3aXRoIHN0b3JlZCBrZXlzXCIsICgpID0+IHtcblx0XHRjb25zdCBzdG9yYWdlID0gQXV0aFN0b3JhZ2UuaW5NZW1vcnkoe1xuXHRcdFx0b3BlbmFpOiB7IHR5cGU6IFwiYXBpX2tleVwiIGFzIGNvbnN0LCBrZXk6IFwic2stdGVzdFwiIH0sXG5cdFx0fSk7XG5cdFx0YXNzZXJ0LmVxdWFsKHN0b3JhZ2UuaGFzQXV0aChcIm9wZW5haVwiKSwgdHJ1ZSk7XG5cdFx0YXNzZXJ0LmVxdWFsKHN0b3JhZ2UuaGFzQXV0aChcIm9sbGFtYVwiKSwgZmFsc2UpO1xuXHR9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgY2FjaGUgcGVyc2lzdGVuY2UgYWNyb3NzIGluc3RhbmNlcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJNb2RlbERpc2NvdmVyeUNhY2hlIFx1MjAxNCBwZXJzaXN0ZW5jZVwiLCAoKSA9PiB7XG5cdGl0KFwiZGF0YSBzdXJ2aXZlcyBhY3Jvc3MgY2FjaGUgaW5zdGFuY2VzXCIsICgpID0+IHtcblx0XHRjb25zdCBjYWNoZVBhdGggPSBqb2luKHRlc3REaXIsIFwicGVyc2lzdC5qc29uXCIpO1xuXG5cdFx0Y29uc3QgY2FjaGUxID0gbmV3IE1vZGVsRGlzY292ZXJ5Q2FjaGUoY2FjaGVQYXRoKTtcblx0XHRjYWNoZTEuc2V0KFwib3BlbmFpXCIsIFtcblx0XHRcdHsgaWQ6IFwiZ3B0LTRvXCIsIG5hbWU6IFwiR1BULTRvXCIsIGNvbnRleHRXaW5kb3c6IDEyODAwMCB9LFxuXHRcdFx0eyBpZDogXCJncHQtNG8tbWluaVwiLCBuYW1lOiBcIkdQVC00byBNaW5pXCIgfSxcblx0XHRdKTtcblxuXHRcdGNvbnN0IGNhY2hlMiA9IG5ldyBNb2RlbERpc2NvdmVyeUNhY2hlKGNhY2hlUGF0aCk7XG5cdFx0Y29uc3QgZW50cnkgPSBjYWNoZTIuZ2V0KFwib3BlbmFpXCIpO1xuXHRcdGFzc2VydC5vayhlbnRyeSk7XG5cdFx0YXNzZXJ0LmVxdWFsKGVudHJ5Lm1vZGVscy5sZW5ndGgsIDIpO1xuXHRcdGFzc2VydC5lcXVhbChlbnRyeS5tb2RlbHNbMF0uY29udGV4dFdpbmRvdywgMTI4MDAwKTtcblx0fSk7XG5cblx0aXQoXCJjbGVhciBwZXJzaXN0cyBhY3Jvc3MgaW5zdGFuY2VzXCIsICgpID0+IHtcblx0XHRjb25zdCBjYWNoZVBhdGggPSBqb2luKHRlc3REaXIsIFwiY2xlYXIuanNvblwiKTtcblxuXHRcdGNvbnN0IGNhY2hlMSA9IG5ldyBNb2RlbERpc2NvdmVyeUNhY2hlKGNhY2hlUGF0aCk7XG5cdFx0Y2FjaGUxLnNldChcIm9wZW5haVwiLCBbeyBpZDogXCJncHQtNG9cIiB9XSk7XG5cdFx0Y2FjaGUxLmNsZWFyKFwib3BlbmFpXCIpO1xuXG5cdFx0Y29uc3QgY2FjaGUyID0gbmV3IE1vZGVsRGlzY292ZXJ5Q2FjaGUoY2FjaGVQYXRoKTtcblx0XHRhc3NlcnQuZXF1YWwoY2FjaGUyLmdldChcIm9wZW5haVwiKSwgdW5kZWZpbmVkKTtcblx0fSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGRpc2NvdmVyeSBUVEwgdmFsdWVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcIkRpc2NvdmVyeSBUVEwgY29uZmlndXJhdGlvblwiLCAoKSA9PiB7XG5cdGl0KFwib2xsYW1hIGhhcyBzaG9ydGVzdCBUVEwgKGxvY2FsIG1vZGVscyBjaGFuZ2Ugb2Z0ZW4pXCIsICgpID0+IHtcblx0XHRjb25zdCBvbGxhbWFUVEwgPSBnZXREZWZhdWx0VFRMKFwib2xsYW1hXCIpO1xuXHRcdGNvbnN0IG9wZW5haVRUTCA9IGdldERlZmF1bHRUVEwoXCJvcGVuYWlcIik7XG5cdFx0YXNzZXJ0Lm9rKG9sbGFtYVRUTCA8IG9wZW5haVRUTCwgXCJvbGxhbWEgVFRMIHNob3VsZCBiZSBzaG9ydGVyIHRoYW4gb3BlbmFpXCIpO1xuXHR9KTtcblxuXHRpdChcInVua25vd24gcHJvdmlkZXJzIGdldCBkZWZhdWx0IFRUTFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgY3VzdG9tVFRMID0gZ2V0RGVmYXVsdFRUTChcIm15LWN1c3RvbS1wcm92aWRlclwiKTtcblx0XHRjb25zdCBkZWZhdWx0VFRMID0gZ2V0RGVmYXVsdFRUTChcImRlZmF1bHRcIik7XG5cdFx0Ly8gVW5rbm93biBwcm92aWRlcnMgc2hvdWxkIGdldCB0aGUgc2FtZSBUVEwgYXMgdGhlIGV4cGxpY2l0IFwiZGVmYXVsdFwiIGtleVxuXHRcdGFzc2VydC5lcXVhbChjdXN0b21UVEwsIGRlZmF1bHRUVEwpO1xuXHR9KTtcbn0pO1xuXG5kZXNjcmliZShcIk1vZGVsUmVnaXN0cnkgZGlzY292ZXJ5IFx1MjAxNCBPcGVuQUktY29tcGF0aWJsZSBjdXN0b20gcHJvdmlkZXJzXCIsICgpID0+IHtcblx0aXQoXCJkaXNjb3ZlcnMgY3VzdG9tIE9wZW5BSS1jb21wYXRpYmxlIHByb3ZpZGVycyBhbmQgbWFwcyBjYXBhYmlsaXR5IG1ldGFkYXRhXCIsIGFzeW5jICgpID0+IHtcblx0XHRjb25zdCBwcm92aWRlck5hbWUgPSBgbWluaW1heC1vcGVuYWktJHtEYXRlLm5vdygpfS0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIpfWA7XG5cdFx0Y29uc3QgbW9kZWxzUGF0aCA9IGpvaW4odGVzdERpciwgXCJtb2RlbHMuanNvblwiKTtcblx0XHR3cml0ZUZpbGVTeW5jKFxuXHRcdFx0bW9kZWxzUGF0aCxcblx0XHRcdEpTT04uc3RyaW5naWZ5KFxuXHRcdFx0XHR7XG5cdFx0XHRcdFx0cHJvdmlkZXJzOiB7XG5cdFx0XHRcdFx0XHRbcHJvdmlkZXJOYW1lXToge1xuXHRcdFx0XHRcdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYXBpLm1pbmltYXguZXhhbXBsZVwiLFxuXHRcdFx0XHRcdFx0XHRhcGlLZXk6IFwibWluaW1heC10ZXN0LWtleVwiLFxuXHRcdFx0XHRcdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRcdFx0XHRcdG1vZGVsczogW3sgaWQ6IFwiYm9vdHN0cmFwLW1vZGVsXCIgfV0sXG5cdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdH0sXG5cdFx0XHRcdG51bGwsXG5cdFx0XHRcdDIsXG5cdFx0XHQpLFxuXHRcdFx0XCJ1dGYtOFwiLFxuXHRcdCk7XG5cblx0XHRjb25zdCBwcmV2RmV0Y2ggPSBnbG9iYWxUaGlzLmZldGNoO1xuXHRcdGxldCByZXF1ZXN0ZWRVcmwgPSBcIlwiO1xuXHRcdGdsb2JhbFRoaXMuZmV0Y2ggPSAoYXN5bmMgKGlucHV0OiBzdHJpbmcgfCBVUkwgfCBSZXF1ZXN0KSA9PiB7XG5cdFx0XHRyZXF1ZXN0ZWRVcmwgPSB0eXBlb2YgaW5wdXQgPT09IFwic3RyaW5nXCIgPyBpbnB1dCA6IGlucHV0IGluc3RhbmNlb2YgVVJMID8gaW5wdXQudG9TdHJpbmcoKSA6IGlucHV0LnVybDtcblx0XHRcdHJldHVybiBuZXcgUmVzcG9uc2UoXG5cdFx0XHRcdEpTT04uc3RyaW5naWZ5KHtcblx0XHRcdFx0XHRkYXRhOiBbXG5cdFx0XHRcdFx0XHR7XG5cdFx0XHRcdFx0XHRcdGlkOiBcIk1pbmlNYXgtTTIuNy1oaWdoc3BlZWRcIixcblx0XHRcdFx0XHRcdFx0bmFtZTogXCJNaW5pTWF4IE0yLjcgSGlnaHNwZWVkXCIsXG5cdFx0XHRcdFx0XHRcdGNvbnRleHRfd2luZG93OiAxNjUwMDAsXG5cdFx0XHRcdFx0XHRcdG1heF9vdXRwdXRfdG9rZW5zOiAzMjc2OCxcblx0XHRcdFx0XHRcdFx0c3VwcG9ydHNfcmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0XHRcdFx0XHRpbnB1dF9tb2RhbGl0aWVzOiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdF0sXG5cdFx0XHRcdH0pLFxuXHRcdFx0XHR7XG5cdFx0XHRcdFx0c3RhdHVzOiAyMDAsXG5cdFx0XHRcdFx0aGVhZGVyczogeyBcImNvbnRlbnQtdHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuXHRcdFx0XHR9LFxuXHRcdFx0KTtcblx0XHR9KSBhcyB0eXBlb2YgZ2xvYmFsVGhpcy5mZXRjaDtcblxuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCByZWdpc3RyeSA9IG5ldyBNb2RlbFJlZ2lzdHJ5KEF1dGhTdG9yYWdlLmluTWVtb3J5KHt9KSwgbW9kZWxzUGF0aCk7XG5cdFx0XHQvLyBHdWFyZCBhZ2FpbnN0IGdsb2JhbCBjYWNoZSBsZWFrYWdlIGZyb20gcHJpb3IgdGVzdCBydW5zLlxuXHRcdFx0cmVnaXN0cnkuZ2V0RGlzY292ZXJ5Q2FjaGUoKS5jbGVhcihwcm92aWRlck5hbWUpO1xuXHRcdFx0Y29uc3QgcmVzdWx0cyA9IGF3YWl0IHJlZ2lzdHJ5LmRpc2NvdmVyTW9kZWxzKFtwcm92aWRlck5hbWVdKTtcblxuXHRcdFx0Y29uc3QgZGlzY292ZXJ5ID0gcmVzdWx0cy5maW5kKChyKSA9PiByLnByb3ZpZGVyID09PSBwcm92aWRlck5hbWUpO1xuXHRcdFx0YXNzZXJ0Lm9rKGRpc2NvdmVyeSwgXCJkaXNjb3ZlcnkgcmVzdWx0IHNob3VsZCBpbmNsdWRlIGN1c3RvbSBwcm92aWRlclwiKTtcblx0XHRcdGFzc2VydC5lcXVhbChkaXNjb3Zlcnk/LmVycm9yLCB1bmRlZmluZWQsIFwiY3VzdG9tIHByb3ZpZGVyIGRpc2NvdmVyeSBzaG91bGQgc3VjY2VlZFwiKTtcblx0XHRcdGFzc2VydC5lcXVhbChyZXF1ZXN0ZWRVcmwsIFwiaHR0cHM6Ly9hcGkubWluaW1heC5leGFtcGxlL3YxL21vZGVsc1wiKTtcblxuXHRcdFx0Y29uc3QgZGlzY292ZXJlZCA9IHJlZ2lzdHJ5XG5cdFx0XHRcdC5nZXRBbGxXaXRoRGlzY292ZXJlZCgpXG5cdFx0XHRcdC5maW5kKChtKSA9PiBtLnByb3ZpZGVyID09PSBwcm92aWRlck5hbWUgJiYgbS5pZCA9PT0gXCJNaW5pTWF4LU0yLjctaGlnaHNwZWVkXCIpO1xuXHRcdFx0YXNzZXJ0Lm9rKGRpc2NvdmVyZWQsIFwiZGlzY292ZXJlZCBtb2RlbCBzaG91bGQgYmUgbWVyZ2VkIGludG8gbW9kZWwgbGlzdFwiKTtcblx0XHRcdGFzc2VydC5lcXVhbChkaXNjb3ZlcmVkPy5hcGksIFwib3BlbmFpLWNvbXBsZXRpb25zXCIpO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKGRpc2NvdmVyZWQ/LmJhc2VVcmwsIFwiaHR0cHM6Ly9hcGkubWluaW1heC5leGFtcGxlXCIpO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKGRpc2NvdmVyZWQ/LmNvbnRleHRXaW5kb3csIDE2NTAwMCk7XG5cdFx0XHRhc3NlcnQuZXF1YWwoZGlzY292ZXJlZD8ubWF4VG9rZW5zLCAzMjc2OCk7XG5cdFx0XHRhc3NlcnQuZXF1YWwoZGlzY292ZXJlZD8ucmVhc29uaW5nLCB0cnVlKTtcblx0XHRcdGFzc2VydC5kZWVwRXF1YWwoZGlzY292ZXJlZD8uaW5wdXQsIFtcInRleHRcIiwgXCJpbWFnZVwiXSk7XG5cdFx0fSBmaW5hbGx5IHtcblx0XHRcdGdsb2JhbFRoaXMuZmV0Y2ggPSBwcmV2RmV0Y2g7XG5cdFx0fVxuXHR9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsT0FBTyxZQUFZO0FBQ25CLFNBQVMsV0FBVyxRQUFRLHFCQUFxQjtBQUNqRCxTQUFTLGNBQWM7QUFDdkIsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsV0FBVyxZQUFZLFVBQVUsVUFBVTtBQUNwRCxTQUFTLG1CQUFtQjtBQUM1QixTQUFTLDJCQUEyQjtBQUNwQyxTQUFTLGVBQWUsMEJBQTBCLDJCQUEyQjtBQUM3RSxTQUFTLHFCQUFxQjtBQUU5QixJQUFJO0FBRUosV0FBVyxNQUFNO0FBQ2hCLFlBQVUsS0FBSyxPQUFPLEdBQUcsaUNBQWlDLEtBQUssSUFBSSxDQUFDLElBQUksS0FBSyxPQUFPLEVBQUUsU0FBUyxFQUFFLEVBQUUsTUFBTSxDQUFDLENBQUMsRUFBRTtBQUM3RyxZQUFVLFNBQVMsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUN2QyxDQUFDO0FBRUQsVUFBVSxNQUFNO0FBQ2YsTUFBSTtBQUNILFdBQU8sU0FBUyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQ2pELFFBQVE7QUFBQSxFQUVS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
