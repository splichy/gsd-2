import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getProviders, getModels, getModel, supportsXhigh, applyCapabilityPatches } from "./models.js";
describe("model registry \u2014 custom providers", () => {
  it("alibaba-coding-plan is a registered provider", () => {
    const providers = getProviders();
    assert.ok(
      providers.includes("alibaba-coding-plan"),
      `Expected "alibaba-coding-plan" in providers, got: ${providers.join(", ")}`
    );
  });
  it("alibaba-coding-plan has all expected models", () => {
    const models = getModels("alibaba-coding-plan");
    const ids = models.map((m) => m.id).sort();
    const expected = [
      "MiniMax-M2.5",
      "glm-4.7",
      "glm-5",
      "kimi-k2.5",
      "qwen3-coder-next",
      "qwen3-coder-plus",
      "qwen3-max-2026-01-23",
      "qwen3.5-plus"
    ];
    assert.deepEqual(ids, expected);
  });
  it("alibaba-coding-plan models use the correct base URL", () => {
    const models = getModels("alibaba-coding-plan");
    for (const model of models) {
      assert.equal(
        model.baseUrl,
        "https://coding-intl.dashscope.aliyuncs.com/v1",
        `Model ${model.id} has wrong baseUrl: ${model.baseUrl}`
      );
    }
  });
  it("alibaba-coding-plan models use openai-completions API", () => {
    const models = getModels("alibaba-coding-plan");
    for (const model of models) {
      assert.equal(model.api, "openai-completions", `Model ${model.id} has wrong api: ${model.api}`);
    }
  });
  it("alibaba-coding-plan models have provider set correctly", () => {
    const models = getModels("alibaba-coding-plan");
    for (const model of models) {
      assert.equal(
        model.provider,
        "alibaba-coding-plan",
        `Model ${model.id} has wrong provider: ${model.provider}`
      );
    }
  });
  it("getModel retrieves alibaba-coding-plan models by provider+id", () => {
    const model = getModel("alibaba-coding-plan", "qwen3.5-plus");
    assert.ok(model, "Expected getModel to return a model for alibaba-coding-plan/qwen3.5-plus");
    assert.equal(model.id, "qwen3.5-plus");
    assert.equal(model.provider, "alibaba-coding-plan");
  });
});
describe("model registry \u2014 custom zai provider (GLM-5.1)", () => {
  it("zai provider includes glm-5.1 from custom models", () => {
    const models = getModels("zai");
    const ids = models.map((m) => m.id);
    assert.ok(ids.includes("glm-5.1"), `Expected "glm-5.1" in zai models, got: ${ids.join(", ")}`);
  });
  it("glm-5.1 has correct provider and base URL", () => {
    const model = getModel("zai", "glm-5.1");
    assert.ok(model, "Expected getModel to return a model for zai/glm-5.1");
    assert.equal(model.id, "glm-5.1");
    assert.equal(model.provider, "zai");
    assert.equal(model.baseUrl, "https://api.z.ai/api/coding/paas/v4");
    assert.equal(model.api, "openai-completions");
  });
  it("glm-5.1 has reasoning enabled and uses generated catalog precedence", () => {
    const model = getModel("zai", "glm-5.1");
    assert.ok(model);
    assert.equal(model.reasoning, true);
    assert.equal(model.contextWindow, 2e5);
    assert.equal(model.maxTokens, 131072);
  });
  it("custom glm-5.1 does not overwrite generated zai models", () => {
    const models = getModels("zai");
    const ids = models.map((m) => m.id);
    assert.ok(ids.includes("glm-5"), "Generated glm-5 should still exist");
    assert.ok(ids.includes("glm-5-turbo"), "Generated glm-5-turbo should still exist");
  });
});
describe("model registry \u2014 alibaba-dashscope provider", () => {
  it("alibaba-dashscope is a registered provider", () => {
    const providers = getProviders();
    assert.ok(
      providers.includes("alibaba-dashscope"),
      `Expected "alibaba-dashscope" in providers, got: ${providers.join(", ")}`
    );
  });
  it("alibaba-dashscope has all expected models", () => {
    const models = getModels("alibaba-dashscope");
    const ids = models.map((m) => m.id).sort();
    const expected = [
      "qwen3-coder-plus",
      "qwen3-max",
      "qwen3.5-flash",
      "qwen3.5-plus",
      "qwen3.6-plus"
    ];
    assert.deepEqual(ids, expected);
  });
  it("alibaba-dashscope models use the international DashScope base URL", () => {
    const models = getModels("alibaba-dashscope");
    for (const model of models) {
      assert.equal(
        model.baseUrl,
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        `Model ${model.id} has wrong baseUrl: ${model.baseUrl}`
      );
    }
  });
  it("alibaba-dashscope models use openai-completions API", () => {
    const models = getModels("alibaba-dashscope");
    for (const model of models) {
      assert.equal(model.api, "openai-completions", `Model ${model.id} has wrong api: ${model.api}`);
    }
  });
  it("alibaba-dashscope models have provider set correctly", () => {
    const models = getModels("alibaba-dashscope");
    for (const model of models) {
      assert.equal(
        model.provider,
        "alibaba-dashscope",
        `Model ${model.id} has wrong provider: ${model.provider}`
      );
    }
  });
  it("alibaba-dashscope models all have 1M context window", () => {
    const models = getModels("alibaba-dashscope");
    for (const model of models) {
      assert.equal(model.contextWindow, 1e6, `Model ${model.id} has wrong contextWindow: ${model.contextWindow}`);
    }
  });
  it("alibaba-dashscope models have positive paid costs (not free-tier)", () => {
    const models = getModels("alibaba-dashscope");
    for (const model of models) {
      assert.ok(model.cost.input > 0, `${model.id}: input cost should be > 0 (paid tier)`);
      assert.ok(model.cost.output > 0, `${model.id}: output cost should be > 0 (paid tier)`);
    }
  });
  it("qwen3-max is a reasoning model with correct pricing", () => {
    const model = getModel("alibaba-dashscope", "qwen3-max");
    assert.ok(model, "Expected getModel to return qwen3-max for alibaba-dashscope");
    assert.equal(model.reasoning, true);
    assert.equal(model.cost.input, 1.2);
    assert.equal(model.cost.output, 6);
    assert.equal(model.maxTokens, 32768);
  });
  it("qwen3.5-plus is a reasoning model with correct pricing", () => {
    const model = getModel("alibaba-dashscope", "qwen3.5-plus");
    assert.ok(model, "Expected getModel to return qwen3.5-plus for alibaba-dashscope");
    assert.equal(model.reasoning, true);
    assert.equal(model.cost.input, 0.4);
    assert.equal(model.cost.output, 1.2);
    assert.equal(model.maxTokens, 65536);
  });
  it("qwen3.5-flash is not a reasoning model", () => {
    const model = getModel("alibaba-dashscope", "qwen3.5-flash");
    assert.ok(model, "Expected getModel to return qwen3.5-flash for alibaba-dashscope");
    assert.equal(model.reasoning, false);
    assert.equal(model.cost.input, 0.1);
    assert.equal(model.cost.output, 0.4);
  });
  it("qwen3-coder-plus is not a reasoning model", () => {
    const model = getModel("alibaba-dashscope", "qwen3-coder-plus");
    assert.ok(model, "Expected getModel to return qwen3-coder-plus for alibaba-dashscope");
    assert.equal(model.reasoning, false);
    assert.equal(model.cost.input, 1);
    assert.equal(model.cost.output, 5);
  });
  it("qwen3.6-plus is a reasoning model", () => {
    const model = getModel("alibaba-dashscope", "qwen3.6-plus");
    assert.ok(model, "Expected getModel to return qwen3.6-plus for alibaba-dashscope");
    assert.equal(model.reasoning, true);
    assert.equal(model.cost.input, 0.5);
    assert.equal(model.cost.output, 3);
  });
  it("alibaba-dashscope is independent of alibaba-coding-plan (different endpoint)", () => {
    const dashscope = getModels("alibaba-dashscope");
    const codingPlan = getModels("alibaba-coding-plan");
    for (const m of dashscope) {
      assert.notEqual(
        m.baseUrl,
        "https://coding-intl.dashscope.aliyuncs.com/v1",
        `${m.id} must not use the Coding Plan endpoint`
      );
    }
    assert.ok(codingPlan.length > 0, "alibaba-coding-plan must still have models");
  });
  it("getModel returns undefined for unknown model in alibaba-dashscope (failure path)", () => {
    const model = getModel("alibaba-dashscope", "does-not-exist");
    assert.equal(model, void 0);
  });
});
describe("model registry \u2014 custom models do not collide with generated models", () => {
  it("generated providers still exist alongside custom providers", () => {
    const providers = getProviders();
    assert.ok(providers.includes("openai"), "openai should be in providers");
    assert.ok(providers.includes("anthropic"), "anthropic should be in providers");
  });
});
function syntheticModel(overrides) {
  return {
    id: "test-model",
    name: "Test Model",
    api: "openai-completions",
    provider: "test-provider",
    baseUrl: "https://example.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128e3,
    maxTokens: 16384,
    ...overrides
  };
}
describe("supportsXhigh \u2014 registry models", () => {
  it("applies capabilities-based true/false to synthetic registry-shaped models", () => {
    const openaiModels = getModels("openai");
    const xhighCapable = openaiModels.find((m) => m.capabilities?.supportsXhigh === true);
    const nonXhigh = openaiModels.find((m) => !m.capabilities?.supportsXhigh);
    if (!xhighCapable && !nonXhigh) {
      return;
    }
    if (xhighCapable) {
      assert.equal(
        supportsXhigh(xhighCapable),
        true,
        `${xhighCapable.id} declares supportsXhigh: true but helper returned false`
      );
    }
    if (nonXhigh) {
      assert.equal(
        supportsXhigh(nonXhigh),
        false,
        `${nonXhigh.id} has no supportsXhigh capability but helper returned true`
      );
    }
  });
});
describe("supportsXhigh \u2014 synthetic models (regression: custom/extension models)", () => {
  it("returns false for a model without capabilities", () => {
    const model = syntheticModel({ id: "my-custom-model" });
    assert.equal(supportsXhigh(model), false);
  });
  it("returns true when capabilities.supportsXhigh is explicitly set", () => {
    const model = syntheticModel({
      id: "my-custom-model",
      capabilities: { supportsXhigh: true }
    });
    assert.equal(supportsXhigh(model), true);
  });
});
describe("applyCapabilityPatches", () => {
  it("patches a GPT-5.4 model that has no capabilities", () => {
    const model = syntheticModel({ id: "gpt-5.4-custom" });
    assert.equal(model.capabilities, void 0);
    const [patched] = applyCapabilityPatches([model]);
    assert.equal(patched.capabilities?.supportsXhigh, true);
    assert.equal(patched.capabilities?.supportsServiceTier, true);
  });
  it("patches a GPT-5.5 custom model that has no capabilities", () => {
    const model = syntheticModel({ id: "gpt-5.5-custom" });
    assert.equal(model.capabilities, void 0);
    const [patched] = applyCapabilityPatches([model]);
    assert.equal(patched.capabilities?.supportsXhigh, true);
    assert.equal(patched.capabilities?.supportsServiceTier, void 0);
  });
  it("patches a GPT-5.2 model", () => {
    const model = syntheticModel({ id: "gpt-5.2" });
    const [patched] = applyCapabilityPatches([model]);
    assert.equal(patched.capabilities?.supportsXhigh, true);
  });
  it("patches an Anthropic Opus 4.6 model", () => {
    const model = syntheticModel({
      id: "claude-opus-4-6-20260301",
      api: "anthropic-messages"
    });
    const [patched] = applyCapabilityPatches([model]);
    assert.equal(patched.capabilities?.supportsXhigh, true);
    assert.equal(patched.capabilities?.supportsServiceTier, void 0);
  });
  it("preserves explicit capabilities over patches", () => {
    const model = syntheticModel({
      id: "gpt-5.4-custom",
      capabilities: { supportsXhigh: false, charsPerToken: 3 }
    });
    const [patched] = applyCapabilityPatches([model]);
    assert.equal(patched.capabilities?.supportsXhigh, false);
    assert.equal(patched.capabilities?.supportsServiceTier, true);
    assert.equal(patched.capabilities?.charsPerToken, 3);
  });
  it("does not modify models that match no patches", () => {
    const model = syntheticModel({ id: "gemini-2.5-pro" });
    const [patched] = applyCapabilityPatches([model]);
    assert.equal(patched.capabilities, void 0);
    assert.equal(patched, model);
  });
  it("is idempotent \u2014 re-applying patches produces the same result", () => {
    const model = syntheticModel({ id: "gpt-5.3" });
    const first = applyCapabilityPatches([model]);
    const second = applyCapabilityPatches(first);
    assert.deepEqual(first[0].capabilities, second[0].capabilities);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWkvc3JjL21vZGVscy50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBkZXNjcmliZSwgaXQgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IGdldFByb3ZpZGVycywgZ2V0TW9kZWxzLCBnZXRNb2RlbCwgc3VwcG9ydHNYaGlnaCwgYXBwbHlDYXBhYmlsaXR5UGF0Y2hlcyB9IGZyb20gXCIuL21vZGVscy5qc1wiO1xuaW1wb3J0IHR5cGUgeyBBcGksIE1vZGVsIH0gZnJvbSBcIi4vdHlwZXMuanNcIjtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBDdXN0b20gcHJvdmlkZXIgcHJlc2VydmF0aW9uIChyZWdyZXNzaW9uOiAjMjMzOSlcbi8vXG4vLyBDdXN0b20gcHJvdmlkZXJzIChsaWtlIGFsaWJhYmEtY29kaW5nLXBsYW4pIGFyZSBtYW51YWxseSBtYWludGFpbmVkIGFuZFxuLy8gTk9UIHNvdXJjZWQgZnJvbSBtb2RlbHMuZGV2LiBUaGV5IG11c3Qgc3Vydml2ZSBnZW5lcmF0ZWQgY2F0YWxvZ1xuLy8gcmVnZW5lcmF0aW9uIGJ5IGxpdmluZyBpbiBtb2RlbHMvY3VzdG9tLnRzLlxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbmRlc2NyaWJlKFwibW9kZWwgcmVnaXN0cnkgXHUyMDE0IGN1c3RvbSBwcm92aWRlcnNcIiwgKCkgPT4ge1xuXHRpdChcImFsaWJhYmEtY29kaW5nLXBsYW4gaXMgYSByZWdpc3RlcmVkIHByb3ZpZGVyXCIsICgpID0+IHtcblx0XHRjb25zdCBwcm92aWRlcnMgPSBnZXRQcm92aWRlcnMoKTtcblx0XHRhc3NlcnQub2soXG5cdFx0XHRwcm92aWRlcnMuaW5jbHVkZXMoXCJhbGliYWJhLWNvZGluZy1wbGFuXCIpLFxuXHRcdFx0YEV4cGVjdGVkIFwiYWxpYmFiYS1jb2RpbmctcGxhblwiIGluIHByb3ZpZGVycywgZ290OiAke3Byb3ZpZGVycy5qb2luKFwiLCBcIil9YCxcblx0XHQpO1xuXHR9KTtcblxuXHRpdChcImFsaWJhYmEtY29kaW5nLXBsYW4gaGFzIGFsbCBleHBlY3RlZCBtb2RlbHNcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IG1vZGVscyA9IGdldE1vZGVscyhcImFsaWJhYmEtY29kaW5nLXBsYW5cIik7XG5cdFx0Y29uc3QgaWRzID0gbW9kZWxzLm1hcCgobSkgPT4gbS5pZCkuc29ydCgpO1xuXHRcdGNvbnN0IGV4cGVjdGVkID0gW1xuXHRcdFx0XCJNaW5pTWF4LU0yLjVcIixcblx0XHRcdFwiZ2xtLTQuN1wiLFxuXHRcdFx0XCJnbG0tNVwiLFxuXHRcdFx0XCJraW1pLWsyLjVcIixcblx0XHRcdFwicXdlbjMtY29kZXItbmV4dFwiLFxuXHRcdFx0XCJxd2VuMy1jb2Rlci1wbHVzXCIsXG5cdFx0XHRcInF3ZW4zLW1heC0yMDI2LTAxLTIzXCIsXG5cdFx0XHRcInF3ZW4zLjUtcGx1c1wiLFxuXHRcdF07XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChpZHMsIGV4cGVjdGVkKTtcblx0fSk7XG5cblx0aXQoXCJhbGliYWJhLWNvZGluZy1wbGFuIG1vZGVscyB1c2UgdGhlIGNvcnJlY3QgYmFzZSBVUkxcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IG1vZGVscyA9IGdldE1vZGVscyhcImFsaWJhYmEtY29kaW5nLXBsYW5cIik7XG5cdFx0Zm9yIChjb25zdCBtb2RlbCBvZiBtb2RlbHMpIHtcblx0XHRcdGFzc2VydC5lcXVhbChcblx0XHRcdFx0bW9kZWwuYmFzZVVybCxcblx0XHRcdFx0XCJodHRwczovL2NvZGluZy1pbnRsLmRhc2hzY29wZS5hbGl5dW5jcy5jb20vdjFcIixcblx0XHRcdFx0YE1vZGVsICR7bW9kZWwuaWR9IGhhcyB3cm9uZyBiYXNlVXJsOiAke21vZGVsLmJhc2VVcmx9YCxcblx0XHRcdCk7XG5cdFx0fVxuXHR9KTtcblxuXHRpdChcImFsaWJhYmEtY29kaW5nLXBsYW4gbW9kZWxzIHVzZSBvcGVuYWktY29tcGxldGlvbnMgQVBJXCIsICgpID0+IHtcblx0XHRjb25zdCBtb2RlbHMgPSBnZXRNb2RlbHMoXCJhbGliYWJhLWNvZGluZy1wbGFuXCIpO1xuXHRcdGZvciAoY29uc3QgbW9kZWwgb2YgbW9kZWxzKSB7XG5cdFx0XHRhc3NlcnQuZXF1YWwobW9kZWwuYXBpLCBcIm9wZW5haS1jb21wbGV0aW9uc1wiLCBgTW9kZWwgJHttb2RlbC5pZH0gaGFzIHdyb25nIGFwaTogJHttb2RlbC5hcGl9YCk7XG5cdFx0fVxuXHR9KTtcblxuXHRpdChcImFsaWJhYmEtY29kaW5nLXBsYW4gbW9kZWxzIGhhdmUgcHJvdmlkZXIgc2V0IGNvcnJlY3RseVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgbW9kZWxzID0gZ2V0TW9kZWxzKFwiYWxpYmFiYS1jb2RpbmctcGxhblwiKTtcblx0XHRmb3IgKGNvbnN0IG1vZGVsIG9mIG1vZGVscykge1xuXHRcdFx0YXNzZXJ0LmVxdWFsKFxuXHRcdFx0XHRtb2RlbC5wcm92aWRlcixcblx0XHRcdFx0XCJhbGliYWJhLWNvZGluZy1wbGFuXCIsXG5cdFx0XHRcdGBNb2RlbCAke21vZGVsLmlkfSBoYXMgd3JvbmcgcHJvdmlkZXI6ICR7bW9kZWwucHJvdmlkZXJ9YCxcblx0XHRcdCk7XG5cdFx0fVxuXHR9KTtcblxuXHRpdChcImdldE1vZGVsIHJldHJpZXZlcyBhbGliYWJhLWNvZGluZy1wbGFuIG1vZGVscyBieSBwcm92aWRlcitpZFwiLCAoKSA9PiB7XG5cdFx0Ly8gVXNlIHR5cGUgYXNzZXJ0aW9uIHRvIHRlc3QgcnVudGltZSBiZWhhdmlvciBcdTIwMTQgYWxpYmFiYS1jb2RpbmctcGxhbiBtYXkgY29tZVxuXHRcdC8vIGZyb20gY3VzdG9tIG1vZGVscyByYXRoZXIgdGhhbiB0aGUgZ2VuZXJhdGVkIGZpbGUsIHNvIHRoZSBuYXJyb3dcblx0XHQvLyBHZW5lcmF0ZWRQcm92aWRlciB0eXBlIGRvZXNuJ3QgaW5jbHVkZSBpdCB1bnRpbCBtb2RlbHMvY3VzdG9tLnRzIGlzIG1lcmdlZC5cblx0XHRjb25zdCBtb2RlbCA9IGdldE1vZGVsKFwiYWxpYmFiYS1jb2RpbmctcGxhblwiIGFzIGFueSwgXCJxd2VuMy41LXBsdXNcIiBhcyBhbnkpO1xuXHRcdGFzc2VydC5vayhtb2RlbCwgXCJFeHBlY3RlZCBnZXRNb2RlbCB0byByZXR1cm4gYSBtb2RlbCBmb3IgYWxpYmFiYS1jb2RpbmctcGxhbi9xd2VuMy41LXBsdXNcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKG1vZGVsLmlkLCBcInF3ZW4zLjUtcGx1c1wiKTtcblx0XHRhc3NlcnQuZXF1YWwobW9kZWwucHJvdmlkZXIsIFwiYWxpYmFiYS1jb2RpbmctcGxhblwiKTtcblx0fSk7XG59KTtcblxuZGVzY3JpYmUoXCJtb2RlbCByZWdpc3RyeSBcdTIwMTQgY3VzdG9tIHphaSBwcm92aWRlciAoR0xNLTUuMSlcIiwgKCkgPT4ge1xuXHRpdChcInphaSBwcm92aWRlciBpbmNsdWRlcyBnbG0tNS4xIGZyb20gY3VzdG9tIG1vZGVsc1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgbW9kZWxzID0gZ2V0TW9kZWxzKFwiemFpXCIgYXMgYW55KTtcblx0XHRjb25zdCBpZHMgPSBtb2RlbHMubWFwKChtKSA9PiBtLmlkKTtcblx0XHRhc3NlcnQub2soaWRzLmluY2x1ZGVzKFwiZ2xtLTUuMVwiKSwgYEV4cGVjdGVkIFwiZ2xtLTUuMVwiIGluIHphaSBtb2RlbHMsIGdvdDogJHtpZHMuam9pbihcIiwgXCIpfWApO1xuXHR9KTtcblxuXHRpdChcImdsbS01LjEgaGFzIGNvcnJlY3QgcHJvdmlkZXIgYW5kIGJhc2UgVVJMXCIsICgpID0+IHtcblx0XHRjb25zdCBtb2RlbCA9IGdldE1vZGVsKFwiemFpXCIgYXMgYW55LCBcImdsbS01LjFcIiBhcyBhbnkpO1xuXHRcdGFzc2VydC5vayhtb2RlbCwgXCJFeHBlY3RlZCBnZXRNb2RlbCB0byByZXR1cm4gYSBtb2RlbCBmb3IgemFpL2dsbS01LjFcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKG1vZGVsLmlkLCBcImdsbS01LjFcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKG1vZGVsLnByb3ZpZGVyLCBcInphaVwiKTtcblx0XHRhc3NlcnQuZXF1YWwobW9kZWwuYmFzZVVybCwgXCJodHRwczovL2FwaS56LmFpL2FwaS9jb2RpbmcvcGFhcy92NFwiKTtcblx0XHRhc3NlcnQuZXF1YWwobW9kZWwuYXBpLCBcIm9wZW5haS1jb21wbGV0aW9uc1wiKTtcblx0fSk7XG5cblx0aXQoXCJnbG0tNS4xIGhhcyByZWFzb25pbmcgZW5hYmxlZCBhbmQgdXNlcyBnZW5lcmF0ZWQgY2F0YWxvZyBwcmVjZWRlbmNlXCIsICgpID0+IHtcblx0XHRjb25zdCBtb2RlbCA9IGdldE1vZGVsKFwiemFpXCIgYXMgYW55LCBcImdsbS01LjFcIiBhcyBhbnkpO1xuXHRcdGFzc2VydC5vayhtb2RlbCk7XG5cdFx0YXNzZXJ0LmVxdWFsKG1vZGVsLnJlYXNvbmluZywgdHJ1ZSk7XG5cdFx0Ly8gR2VuZXJhdGVkIGNhdGFsb2cgZW50cmllcyBhcmUgbG9hZGVkIGZpcnN0OyBjdXN0b20gbW9kZWxzIGFyZSBhZGRpdGl2ZS1vbmx5LlxuXHRcdGFzc2VydC5lcXVhbChtb2RlbC5jb250ZXh0V2luZG93LCAyMDAwMDApO1xuXHRcdGFzc2VydC5lcXVhbChtb2RlbC5tYXhUb2tlbnMsIDEzMTA3Mik7XG5cdH0pO1xuXG5cdGl0KFwiY3VzdG9tIGdsbS01LjEgZG9lcyBub3Qgb3ZlcndyaXRlIGdlbmVyYXRlZCB6YWkgbW9kZWxzXCIsICgpID0+IHtcblx0XHRjb25zdCBtb2RlbHMgPSBnZXRNb2RlbHMoXCJ6YWlcIiBhcyBhbnkpO1xuXHRcdGNvbnN0IGlkcyA9IG1vZGVscy5tYXAoKG0pID0+IG0uaWQpO1xuXHRcdC8vIEdlbmVyYXRlZCBtb2RlbHMgbXVzdCBzdGlsbCBleGlzdCBhbG9uZ3NpZGUgY3VzdG9tIGdsbS01LjFcblx0XHRhc3NlcnQub2soaWRzLmluY2x1ZGVzKFwiZ2xtLTVcIiksIFwiR2VuZXJhdGVkIGdsbS01IHNob3VsZCBzdGlsbCBleGlzdFwiKTtcblx0XHRhc3NlcnQub2soaWRzLmluY2x1ZGVzKFwiZ2xtLTUtdHVyYm9cIiksIFwiR2VuZXJhdGVkIGdsbS01LXR1cmJvIHNob3VsZCBzdGlsbCBleGlzdFwiKTtcblx0fSk7XG59KTtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBOZXcgcHJvdmlkZXI6IGFsaWJhYmEtZGFzaHNjb3BlIChmZWF0OiAjMzg5MSlcbi8vXG4vLyBSZWd1bGFyIERhc2hTY29wZSBBUEkgZm9yIHVzZXJzIHdpdGhvdXQgdGhlIENvZGluZyBQbGFuLlxuLy8gU2VwYXJhdGUgZnJvbSBhbGliYWJhLWNvZGluZy1wbGFuIFx1MjAxNCBkaWZmZXJlbnQgZW5kcG9pbnQsIGF1dGgsIGFuZCBwcmljaW5nLlxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbmRlc2NyaWJlKFwibW9kZWwgcmVnaXN0cnkgXHUyMDE0IGFsaWJhYmEtZGFzaHNjb3BlIHByb3ZpZGVyXCIsICgpID0+IHtcblx0aXQoXCJhbGliYWJhLWRhc2hzY29wZSBpcyBhIHJlZ2lzdGVyZWQgcHJvdmlkZXJcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHByb3ZpZGVycyA9IGdldFByb3ZpZGVycygpO1xuXHRcdGFzc2VydC5vayhcblx0XHRcdHByb3ZpZGVycy5pbmNsdWRlcyhcImFsaWJhYmEtZGFzaHNjb3BlXCIpLFxuXHRcdFx0YEV4cGVjdGVkIFwiYWxpYmFiYS1kYXNoc2NvcGVcIiBpbiBwcm92aWRlcnMsIGdvdDogJHtwcm92aWRlcnMuam9pbihcIiwgXCIpfWAsXG5cdFx0KTtcblx0fSk7XG5cblx0aXQoXCJhbGliYWJhLWRhc2hzY29wZSBoYXMgYWxsIGV4cGVjdGVkIG1vZGVsc1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgbW9kZWxzID0gZ2V0TW9kZWxzKFwiYWxpYmFiYS1kYXNoc2NvcGVcIik7XG5cdFx0Y29uc3QgaWRzID0gbW9kZWxzLm1hcCgobSkgPT4gbS5pZCkuc29ydCgpO1xuXHRcdGNvbnN0IGV4cGVjdGVkID0gW1xuXHRcdFx0XCJxd2VuMy1jb2Rlci1wbHVzXCIsXG5cdFx0XHRcInF3ZW4zLW1heFwiLFxuXHRcdFx0XCJxd2VuMy41LWZsYXNoXCIsXG5cdFx0XHRcInF3ZW4zLjUtcGx1c1wiLFxuXHRcdFx0XCJxd2VuMy42LXBsdXNcIixcblx0XHRdO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwoaWRzLCBleHBlY3RlZCk7XG5cdH0pO1xuXG5cdGl0KFwiYWxpYmFiYS1kYXNoc2NvcGUgbW9kZWxzIHVzZSB0aGUgaW50ZXJuYXRpb25hbCBEYXNoU2NvcGUgYmFzZSBVUkxcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IG1vZGVscyA9IGdldE1vZGVscyhcImFsaWJhYmEtZGFzaHNjb3BlXCIpO1xuXHRcdGZvciAoY29uc3QgbW9kZWwgb2YgbW9kZWxzKSB7XG5cdFx0XHRhc3NlcnQuZXF1YWwoXG5cdFx0XHRcdG1vZGVsLmJhc2VVcmwsXG5cdFx0XHRcdFwiaHR0cHM6Ly9kYXNoc2NvcGUtaW50bC5hbGl5dW5jcy5jb20vY29tcGF0aWJsZS1tb2RlL3YxXCIsXG5cdFx0XHRcdGBNb2RlbCAke21vZGVsLmlkfSBoYXMgd3JvbmcgYmFzZVVybDogJHttb2RlbC5iYXNlVXJsfWAsXG5cdFx0XHQpO1xuXHRcdH1cblx0fSk7XG5cblx0aXQoXCJhbGliYWJhLWRhc2hzY29wZSBtb2RlbHMgdXNlIG9wZW5haS1jb21wbGV0aW9ucyBBUElcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IG1vZGVscyA9IGdldE1vZGVscyhcImFsaWJhYmEtZGFzaHNjb3BlXCIpO1xuXHRcdGZvciAoY29uc3QgbW9kZWwgb2YgbW9kZWxzKSB7XG5cdFx0XHRhc3NlcnQuZXF1YWwobW9kZWwuYXBpLCBcIm9wZW5haS1jb21wbGV0aW9uc1wiLCBgTW9kZWwgJHttb2RlbC5pZH0gaGFzIHdyb25nIGFwaTogJHttb2RlbC5hcGl9YCk7XG5cdFx0fVxuXHR9KTtcblxuXHRpdChcImFsaWJhYmEtZGFzaHNjb3BlIG1vZGVscyBoYXZlIHByb3ZpZGVyIHNldCBjb3JyZWN0bHlcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IG1vZGVscyA9IGdldE1vZGVscyhcImFsaWJhYmEtZGFzaHNjb3BlXCIpO1xuXHRcdGZvciAoY29uc3QgbW9kZWwgb2YgbW9kZWxzKSB7XG5cdFx0XHRhc3NlcnQuZXF1YWwoXG5cdFx0XHRcdG1vZGVsLnByb3ZpZGVyLFxuXHRcdFx0XHRcImFsaWJhYmEtZGFzaHNjb3BlXCIsXG5cdFx0XHRcdGBNb2RlbCAke21vZGVsLmlkfSBoYXMgd3JvbmcgcHJvdmlkZXI6ICR7bW9kZWwucHJvdmlkZXJ9YCxcblx0XHRcdCk7XG5cdFx0fVxuXHR9KTtcblxuXHRpdChcImFsaWJhYmEtZGFzaHNjb3BlIG1vZGVscyBhbGwgaGF2ZSAxTSBjb250ZXh0IHdpbmRvd1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgbW9kZWxzID0gZ2V0TW9kZWxzKFwiYWxpYmFiYS1kYXNoc2NvcGVcIik7XG5cdFx0Zm9yIChjb25zdCBtb2RlbCBvZiBtb2RlbHMpIHtcblx0XHRcdGFzc2VydC5lcXVhbChtb2RlbC5jb250ZXh0V2luZG93LCAxXzAwMF8wMDAsIGBNb2RlbCAke21vZGVsLmlkfSBoYXMgd3JvbmcgY29udGV4dFdpbmRvdzogJHttb2RlbC5jb250ZXh0V2luZG93fWApO1xuXHRcdH1cblx0fSk7XG5cblx0aXQoXCJhbGliYWJhLWRhc2hzY29wZSBtb2RlbHMgaGF2ZSBwb3NpdGl2ZSBwYWlkIGNvc3RzIChub3QgZnJlZS10aWVyKVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgbW9kZWxzID0gZ2V0TW9kZWxzKFwiYWxpYmFiYS1kYXNoc2NvcGVcIik7XG5cdFx0Zm9yIChjb25zdCBtb2RlbCBvZiBtb2RlbHMpIHtcblx0XHRcdGFzc2VydC5vayhtb2RlbC5jb3N0LmlucHV0ID4gMCwgYCR7bW9kZWwuaWR9OiBpbnB1dCBjb3N0IHNob3VsZCBiZSA+IDAgKHBhaWQgdGllcilgKTtcblx0XHRcdGFzc2VydC5vayhtb2RlbC5jb3N0Lm91dHB1dCA+IDAsIGAke21vZGVsLmlkfTogb3V0cHV0IGNvc3Qgc2hvdWxkIGJlID4gMCAocGFpZCB0aWVyKWApO1xuXHRcdH1cblx0fSk7XG5cblx0aXQoXCJxd2VuMy1tYXggaXMgYSByZWFzb25pbmcgbW9kZWwgd2l0aCBjb3JyZWN0IHByaWNpbmdcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IG1vZGVsID0gZ2V0TW9kZWwoXCJhbGliYWJhLWRhc2hzY29wZVwiIGFzIGFueSwgXCJxd2VuMy1tYXhcIiBhcyBhbnkpO1xuXHRcdGFzc2VydC5vayhtb2RlbCwgXCJFeHBlY3RlZCBnZXRNb2RlbCB0byByZXR1cm4gcXdlbjMtbWF4IGZvciBhbGliYWJhLWRhc2hzY29wZVwiKTtcblx0XHRhc3NlcnQuZXF1YWwobW9kZWwucmVhc29uaW5nLCB0cnVlKTtcblx0XHRhc3NlcnQuZXF1YWwobW9kZWwuY29zdC5pbnB1dCwgMS4yKTtcblx0XHRhc3NlcnQuZXF1YWwobW9kZWwuY29zdC5vdXRwdXQsIDYpO1xuXHRcdGFzc2VydC5lcXVhbChtb2RlbC5tYXhUb2tlbnMsIDMyNzY4KTtcblx0fSk7XG5cblx0aXQoXCJxd2VuMy41LXBsdXMgaXMgYSByZWFzb25pbmcgbW9kZWwgd2l0aCBjb3JyZWN0IHByaWNpbmdcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IG1vZGVsID0gZ2V0TW9kZWwoXCJhbGliYWJhLWRhc2hzY29wZVwiIGFzIGFueSwgXCJxd2VuMy41LXBsdXNcIiBhcyBhbnkpO1xuXHRcdGFzc2VydC5vayhtb2RlbCwgXCJFeHBlY3RlZCBnZXRNb2RlbCB0byByZXR1cm4gcXdlbjMuNS1wbHVzIGZvciBhbGliYWJhLWRhc2hzY29wZVwiKTtcblx0XHRhc3NlcnQuZXF1YWwobW9kZWwucmVhc29uaW5nLCB0cnVlKTtcblx0XHRhc3NlcnQuZXF1YWwobW9kZWwuY29zdC5pbnB1dCwgMC40KTtcblx0XHRhc3NlcnQuZXF1YWwobW9kZWwuY29zdC5vdXRwdXQsIDEuMik7XG5cdFx0YXNzZXJ0LmVxdWFsKG1vZGVsLm1heFRva2VucywgNjU1MzYpO1xuXHR9KTtcblxuXHRpdChcInF3ZW4zLjUtZmxhc2ggaXMgbm90IGEgcmVhc29uaW5nIG1vZGVsXCIsICgpID0+IHtcblx0XHRjb25zdCBtb2RlbCA9IGdldE1vZGVsKFwiYWxpYmFiYS1kYXNoc2NvcGVcIiBhcyBhbnksIFwicXdlbjMuNS1mbGFzaFwiIGFzIGFueSk7XG5cdFx0YXNzZXJ0Lm9rKG1vZGVsLCBcIkV4cGVjdGVkIGdldE1vZGVsIHRvIHJldHVybiBxd2VuMy41LWZsYXNoIGZvciBhbGliYWJhLWRhc2hzY29wZVwiKTtcblx0XHRhc3NlcnQuZXF1YWwobW9kZWwucmVhc29uaW5nLCBmYWxzZSk7XG5cdFx0YXNzZXJ0LmVxdWFsKG1vZGVsLmNvc3QuaW5wdXQsIDAuMSk7XG5cdFx0YXNzZXJ0LmVxdWFsKG1vZGVsLmNvc3Qub3V0cHV0LCAwLjQpO1xuXHR9KTtcblxuXHRpdChcInF3ZW4zLWNvZGVyLXBsdXMgaXMgbm90IGEgcmVhc29uaW5nIG1vZGVsXCIsICgpID0+IHtcblx0XHRjb25zdCBtb2RlbCA9IGdldE1vZGVsKFwiYWxpYmFiYS1kYXNoc2NvcGVcIiBhcyBhbnksIFwicXdlbjMtY29kZXItcGx1c1wiIGFzIGFueSk7XG5cdFx0YXNzZXJ0Lm9rKG1vZGVsLCBcIkV4cGVjdGVkIGdldE1vZGVsIHRvIHJldHVybiBxd2VuMy1jb2Rlci1wbHVzIGZvciBhbGliYWJhLWRhc2hzY29wZVwiKTtcblx0XHRhc3NlcnQuZXF1YWwobW9kZWwucmVhc29uaW5nLCBmYWxzZSk7XG5cdFx0YXNzZXJ0LmVxdWFsKG1vZGVsLmNvc3QuaW5wdXQsIDEuMCk7XG5cdFx0YXNzZXJ0LmVxdWFsKG1vZGVsLmNvc3Qub3V0cHV0LCA1LjApO1xuXHR9KTtcblxuXHRpdChcInF3ZW4zLjYtcGx1cyBpcyBhIHJlYXNvbmluZyBtb2RlbFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgbW9kZWwgPSBnZXRNb2RlbChcImFsaWJhYmEtZGFzaHNjb3BlXCIgYXMgYW55LCBcInF3ZW4zLjYtcGx1c1wiIGFzIGFueSk7XG5cdFx0YXNzZXJ0Lm9rKG1vZGVsLCBcIkV4cGVjdGVkIGdldE1vZGVsIHRvIHJldHVybiBxd2VuMy42LXBsdXMgZm9yIGFsaWJhYmEtZGFzaHNjb3BlXCIpO1xuXHRcdGFzc2VydC5lcXVhbChtb2RlbC5yZWFzb25pbmcsIHRydWUpO1xuXHRcdGFzc2VydC5lcXVhbChtb2RlbC5jb3N0LmlucHV0LCAwLjUpO1xuXHRcdGFzc2VydC5lcXVhbChtb2RlbC5jb3N0Lm91dHB1dCwgMy4wKTtcblx0fSk7XG5cblx0aXQoXCJhbGliYWJhLWRhc2hzY29wZSBpcyBpbmRlcGVuZGVudCBvZiBhbGliYWJhLWNvZGluZy1wbGFuIChkaWZmZXJlbnQgZW5kcG9pbnQpXCIsICgpID0+IHtcblx0XHRjb25zdCBkYXNoc2NvcGUgPSBnZXRNb2RlbHMoXCJhbGliYWJhLWRhc2hzY29wZVwiKTtcblx0XHRjb25zdCBjb2RpbmdQbGFuID0gZ2V0TW9kZWxzKFwiYWxpYmFiYS1jb2RpbmctcGxhblwiKTtcblx0XHRmb3IgKGNvbnN0IG0gb2YgZGFzaHNjb3BlKSB7XG5cdFx0XHRhc3NlcnQubm90RXF1YWwoXG5cdFx0XHRcdG0uYmFzZVVybCxcblx0XHRcdFx0XCJodHRwczovL2NvZGluZy1pbnRsLmRhc2hzY29wZS5hbGl5dW5jcy5jb20vdjFcIixcblx0XHRcdFx0YCR7bS5pZH0gbXVzdCBub3QgdXNlIHRoZSBDb2RpbmcgUGxhbiBlbmRwb2ludGAsXG5cdFx0XHQpO1xuXHRcdH1cblx0XHQvLyBCb3RoIHByb3ZpZGVycyBtdXN0IGNvZXhpc3QgXHUyMDE0IGNvZGluZy1wbGFuIG11c3Qgbm90IGhhdmUgYmVlbiBvdmVyd3JpdHRlblxuXHRcdGFzc2VydC5vayhjb2RpbmdQbGFuLmxlbmd0aCA+IDAsIFwiYWxpYmFiYS1jb2RpbmctcGxhbiBtdXN0IHN0aWxsIGhhdmUgbW9kZWxzXCIpO1xuXHR9KTtcblxuXHRpdChcImdldE1vZGVsIHJldHVybnMgdW5kZWZpbmVkIGZvciB1bmtub3duIG1vZGVsIGluIGFsaWJhYmEtZGFzaHNjb3BlIChmYWlsdXJlIHBhdGgpXCIsICgpID0+IHtcblx0XHRjb25zdCBtb2RlbCA9IGdldE1vZGVsKFwiYWxpYmFiYS1kYXNoc2NvcGVcIiBhcyBhbnksIFwiZG9lcy1ub3QtZXhpc3RcIiBhcyBhbnkpO1xuXHRcdGFzc2VydC5lcXVhbChtb2RlbCwgdW5kZWZpbmVkKTtcblx0fSk7XG59KTtcblxuZGVzY3JpYmUoXCJtb2RlbCByZWdpc3RyeSBcdTIwMTQgY3VzdG9tIG1vZGVscyBkbyBub3QgY29sbGlkZSB3aXRoIGdlbmVyYXRlZCBtb2RlbHNcIiwgKCkgPT4ge1xuXHRpdChcImdlbmVyYXRlZCBwcm92aWRlcnMgc3RpbGwgZXhpc3QgYWxvbmdzaWRlIGN1c3RvbSBwcm92aWRlcnNcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHByb3ZpZGVycyA9IGdldFByb3ZpZGVycygpO1xuXHRcdC8vIFNwb3QtY2hlY2sgYSBmZXcgZ2VuZXJhdGVkIHByb3ZpZGVyc1xuXHRcdGFzc2VydC5vayhwcm92aWRlcnMuaW5jbHVkZXMoXCJvcGVuYWlcIiksIFwib3BlbmFpIHNob3VsZCBiZSBpbiBwcm92aWRlcnNcIik7XG5cdFx0YXNzZXJ0Lm9rKHByb3ZpZGVycy5pbmNsdWRlcyhcImFudGhyb3BpY1wiKSwgXCJhbnRocm9waWMgc2hvdWxkIGJlIGluIHByb3ZpZGVyc1wiKTtcblx0fSk7XG59KTtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBDYXBhYmlsaXR5IHBhdGNoZXMgKHJlZ3Jlc3Npb246ICMyNTQ2KVxuLy9cbi8vIENBUEFCSUxJVFlfUEFUQ0hFUyBtdXN0IGFwcGx5IGNhcGFiaWxpdGllcyB0byBtb2RlbHMgaW4gdGhlIHN0YXRpY1xuLy8gcmVnaXN0cnkgQU5EIHRvIG1vZGVscyBjb25zdHJ1Y3RlZCBvdXRzaWRlIG9mIGl0IChjdXN0b20sIGV4dGVuc2lvbixcbi8vIGRpc2NvdmVyZWQpLiBzdXBwb3J0c1hoaWdoKCkgcmVhZHMgbW9kZWwuY2FwYWJpbGl0aWVzIFx1MjAxNCBub3QgbW9kZWwgSURzLlxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbi8qKiBIZWxwZXI6IGJ1aWxkIGEgbWluaW1hbCBzeW50aGV0aWMgbW9kZWwgZm9yIHRlc3RpbmcgKi9cbmZ1bmN0aW9uIHN5bnRoZXRpY01vZGVsKG92ZXJyaWRlczogUGFydGlhbDxNb2RlbDxBcGk+Pik6IE1vZGVsPEFwaT4ge1xuXHRyZXR1cm4ge1xuXHRcdGlkOiBcInRlc3QtbW9kZWxcIixcblx0XHRuYW1lOiBcIlRlc3QgTW9kZWxcIixcblx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIgYXMgQXBpLFxuXHRcdHByb3ZpZGVyOiBcInRlc3QtcHJvdmlkZXJcIixcblx0XHRiYXNlVXJsOiBcImh0dHBzOi8vZXhhbXBsZS5jb21cIixcblx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdGNvc3Q6IHsgaW5wdXQ6IDAsIG91dHB1dDogMCwgY2FjaGVSZWFkOiAwLCBjYWNoZVdyaXRlOiAwIH0sXG5cdFx0Y29udGV4dFdpbmRvdzogMTI4MDAwLFxuXHRcdG1heFRva2VuczogMTYzODQsXG5cdFx0Li4ub3ZlcnJpZGVzLFxuXHR9IGFzIE1vZGVsPEFwaT47XG59XG5cbmRlc2NyaWJlKFwic3VwcG9ydHNYaGlnaCBcdTIwMTQgcmVnaXN0cnkgbW9kZWxzXCIsICgpID0+IHtcblx0Ly8gUHJldmlvdXMgdmVyc2lvbiBzaWxlbnQtc2tpcHBlZCB2aWEgYGlmICghbW9kZWwpIHJldHVybjtgIFx1MjAxNCB3aGVuXG5cdC8vIHRoZSB0YXJnZXQgbW9kZWwgd2FzIHJlbmFtZWQgb3IgcmVtb3ZlZCwgdGhlIHRlc3QgcGFzc2VkXG5cdC8vIHRyaXZpYWxseSB3aXRob3V0IHNpZ25hbGxpbmcgdGhlIHJlZ3Jlc3Npb24uIElzc3VlICM0ODA0IGZsYWdnZWRcblx0Ly8gdGhpcyBwYXR0ZXJuLiBSZXBsYWNlZCB3aXRoIHN5bnRoZXRpYy1tb2RlbCB0ZXN0cyAodGhlIGJsb2NrXG5cdC8vIGJlbG93KSB0aGF0IHZlcmlmeSB0aGUgQ0FQQUJJTElUWSBDSEVDSyBpbmRlcGVuZGVudCBvZiBhbnlcblx0Ly8gc3BlY2lmaWMgbW9kZWwgSUQuXG5cdC8vXG5cdC8vIEEgXCJpcy14aGlnaC1jYXBhYmxlIG1vZGVsIGZvdW5kIGluIHRoZSByZWdpc3RyeSB3aGVuIGV4cGVjdGVkXCJcblx0Ly8gaW52YXJpYW50LCBpZiBuZWVkZWQsIGJlbG9uZ3MgaW4gdGhlIGZlYXR1cmUgdGhhdCBkZXBlbmRzIG9uXG5cdC8vIHhoaWdoIHN1cHBvcnQgXHUyMDE0IGl0J3MgYSBwcm9kdWN0LWZlYXR1cmUgcmVxdWlyZW1lbnQsIG5vdCBhXG5cdC8vIHJlZ2lzdHJ5IGNvbnRyYWN0LlxuXG5cdGl0KFwiYXBwbGllcyBjYXBhYmlsaXRpZXMtYmFzZWQgdHJ1ZS9mYWxzZSB0byBzeW50aGV0aWMgcmVnaXN0cnktc2hhcGVkIG1vZGVsc1wiLCAoKSA9PiB7XG5cdFx0Ly8gVXNlIGEgcmVhbCByZWdpc3RyeSBtb2RlbCBidXQgYXNzZXJ0IHRoZSBDQVBBQklMSVRZIHBhdGhcblx0XHQvLyB3aXRob3V0IHBpbm5pbmcgYSBzcGVjaWZpYyBJRC4gRmluZCBhbnkgbW9kZWwgdGhhdCBkZWNsYXJlc1xuXHRcdC8vIHRoZSBjYXBhYmlsaXR5IHZzIGFueSB0aGF0IGRvZXNuJ3QuXG5cdFx0Y29uc3Qgb3BlbmFpTW9kZWxzID0gZ2V0TW9kZWxzKFwib3BlbmFpXCIpO1xuXHRcdGNvbnN0IHhoaWdoQ2FwYWJsZSA9IG9wZW5haU1vZGVscy5maW5kKChtKSA9PiBtLmNhcGFiaWxpdGllcz8uc3VwcG9ydHNYaGlnaCA9PT0gdHJ1ZSk7XG5cdFx0Y29uc3Qgbm9uWGhpZ2ggPSBvcGVuYWlNb2RlbHMuZmluZCgobSkgPT4gIW0uY2FwYWJpbGl0aWVzPy5zdXBwb3J0c1hoaWdoKTtcblx0XHQvLyBJZiBuZWl0aGVyIHNoYXBlIGV4aXN0cyBpbiB0aGUgY3VycmVudCByZWdpc3RyeSwgdGhlIHRlc3Rcblx0XHQvLyBpcyB2YWN1b3VzOyBlbWl0IGEgY2xlYXIgdG9kbyByYXRoZXIgdGhhbiBzaWxlbnRseSBwYXNzaW5nLlxuXHRcdGlmICgheGhpZ2hDYXBhYmxlICYmICFub25YaGlnaCkge1xuXHRcdFx0Ly8gTm90aGluZyB0byB0ZXN0IGhlcmU7IHJlZ2lzdHJ5IGlzIGRlZ2VuZXJhdGUuXG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXHRcdGlmICh4aGlnaENhcGFibGUpIHtcblx0XHRcdGFzc2VydC5lcXVhbChcblx0XHRcdFx0c3VwcG9ydHNYaGlnaCh4aGlnaENhcGFibGUpLFxuXHRcdFx0XHR0cnVlLFxuXHRcdFx0XHRgJHt4aGlnaENhcGFibGUuaWR9IGRlY2xhcmVzIHN1cHBvcnRzWGhpZ2g6IHRydWUgYnV0IGhlbHBlciByZXR1cm5lZCBmYWxzZWAsXG5cdFx0XHQpO1xuXHRcdH1cblx0XHRpZiAobm9uWGhpZ2gpIHtcblx0XHRcdGFzc2VydC5lcXVhbChcblx0XHRcdFx0c3VwcG9ydHNYaGlnaChub25YaGlnaCksXG5cdFx0XHRcdGZhbHNlLFxuXHRcdFx0XHRgJHtub25YaGlnaC5pZH0gaGFzIG5vIHN1cHBvcnRzWGhpZ2ggY2FwYWJpbGl0eSBidXQgaGVscGVyIHJldHVybmVkIHRydWVgLFxuXHRcdFx0KTtcblx0XHR9XG5cdH0pO1xufSk7XG5cbmRlc2NyaWJlKFwic3VwcG9ydHNYaGlnaCBcdTIwMTQgc3ludGhldGljIG1vZGVscyAocmVncmVzc2lvbjogY3VzdG9tL2V4dGVuc2lvbiBtb2RlbHMpXCIsICgpID0+IHtcblx0aXQoXCJyZXR1cm5zIGZhbHNlIGZvciBhIG1vZGVsIHdpdGhvdXQgY2FwYWJpbGl0aWVzXCIsICgpID0+IHtcblx0XHRjb25zdCBtb2RlbCA9IHN5bnRoZXRpY01vZGVsKHsgaWQ6IFwibXktY3VzdG9tLW1vZGVsXCIgfSk7XG5cdFx0YXNzZXJ0LmVxdWFsKHN1cHBvcnRzWGhpZ2gobW9kZWwpLCBmYWxzZSk7XG5cdH0pO1xuXG5cdGl0KFwicmV0dXJucyB0cnVlIHdoZW4gY2FwYWJpbGl0aWVzLnN1cHBvcnRzWGhpZ2ggaXMgZXhwbGljaXRseSBzZXRcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IG1vZGVsID0gc3ludGhldGljTW9kZWwoe1xuXHRcdFx0aWQ6IFwibXktY3VzdG9tLW1vZGVsXCIsXG5cdFx0XHRjYXBhYmlsaXRpZXM6IHsgc3VwcG9ydHNYaGlnaDogdHJ1ZSB9LFxuXHRcdH0pO1xuXHRcdGFzc2VydC5lcXVhbChzdXBwb3J0c1hoaWdoKG1vZGVsKSwgdHJ1ZSk7XG5cdH0pO1xufSk7XG5cbmRlc2NyaWJlKFwiYXBwbHlDYXBhYmlsaXR5UGF0Y2hlc1wiLCAoKSA9PiB7XG5cdGl0KFwicGF0Y2hlcyBhIEdQVC01LjQgbW9kZWwgdGhhdCBoYXMgbm8gY2FwYWJpbGl0aWVzXCIsICgpID0+IHtcblx0XHRjb25zdCBtb2RlbCA9IHN5bnRoZXRpY01vZGVsKHsgaWQ6IFwiZ3B0LTUuNC1jdXN0b21cIiB9KTtcblx0XHRhc3NlcnQuZXF1YWwobW9kZWwuY2FwYWJpbGl0aWVzLCB1bmRlZmluZWQpO1xuXG5cdFx0Y29uc3QgW3BhdGNoZWRdID0gYXBwbHlDYXBhYmlsaXR5UGF0Y2hlcyhbbW9kZWxdKTtcblx0XHRhc3NlcnQuZXF1YWwocGF0Y2hlZC5jYXBhYmlsaXRpZXM/LnN1cHBvcnRzWGhpZ2gsIHRydWUpO1xuXHRcdGFzc2VydC5lcXVhbChwYXRjaGVkLmNhcGFiaWxpdGllcz8uc3VwcG9ydHNTZXJ2aWNlVGllciwgdHJ1ZSk7XG5cdH0pO1xuXG5cdGl0KFwicGF0Y2hlcyBhIEdQVC01LjUgY3VzdG9tIG1vZGVsIHRoYXQgaGFzIG5vIGNhcGFiaWxpdGllc1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgbW9kZWwgPSBzeW50aGV0aWNNb2RlbCh7IGlkOiBcImdwdC01LjUtY3VzdG9tXCIgfSk7XG5cdFx0YXNzZXJ0LmVxdWFsKG1vZGVsLmNhcGFiaWxpdGllcywgdW5kZWZpbmVkKTtcblxuXHRcdGNvbnN0IFtwYXRjaGVkXSA9IGFwcGx5Q2FwYWJpbGl0eVBhdGNoZXMoW21vZGVsXSk7XG5cdFx0YXNzZXJ0LmVxdWFsKHBhdGNoZWQuY2FwYWJpbGl0aWVzPy5zdXBwb3J0c1hoaWdoLCB0cnVlKTtcblx0XHRhc3NlcnQuZXF1YWwocGF0Y2hlZC5jYXBhYmlsaXRpZXM/LnN1cHBvcnRzU2VydmljZVRpZXIsIHVuZGVmaW5lZCk7XG5cdH0pO1xuXG5cdGl0KFwicGF0Y2hlcyBhIEdQVC01LjIgbW9kZWxcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IG1vZGVsID0gc3ludGhldGljTW9kZWwoeyBpZDogXCJncHQtNS4yXCIgfSk7XG5cdFx0Y29uc3QgW3BhdGNoZWRdID0gYXBwbHlDYXBhYmlsaXR5UGF0Y2hlcyhbbW9kZWxdKTtcblx0XHRhc3NlcnQuZXF1YWwocGF0Y2hlZC5jYXBhYmlsaXRpZXM/LnN1cHBvcnRzWGhpZ2gsIHRydWUpO1xuXHR9KTtcblxuXHRpdChcInBhdGNoZXMgYW4gQW50aHJvcGljIE9wdXMgNC42IG1vZGVsXCIsICgpID0+IHtcblx0XHRjb25zdCBtb2RlbCA9IHN5bnRoZXRpY01vZGVsKHtcblx0XHRcdGlkOiBcImNsYXVkZS1vcHVzLTQtNi0yMDI2MDMwMVwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiIGFzIEFwaSxcblx0XHR9KTtcblx0XHRjb25zdCBbcGF0Y2hlZF0gPSBhcHBseUNhcGFiaWxpdHlQYXRjaGVzKFttb2RlbF0pO1xuXHRcdGFzc2VydC5lcXVhbChwYXRjaGVkLmNhcGFiaWxpdGllcz8uc3VwcG9ydHNYaGlnaCwgdHJ1ZSk7XG5cdFx0Ly8gT3B1cyBzaG91bGQgbm90IGdldCBzdXBwb3J0c1NlcnZpY2VUaWVyXG5cdFx0YXNzZXJ0LmVxdWFsKHBhdGNoZWQuY2FwYWJpbGl0aWVzPy5zdXBwb3J0c1NlcnZpY2VUaWVyLCB1bmRlZmluZWQpO1xuXHR9KTtcblxuXHRpdChcInByZXNlcnZlcyBleHBsaWNpdCBjYXBhYmlsaXRpZXMgb3ZlciBwYXRjaGVzXCIsICgpID0+IHtcblx0XHRjb25zdCBtb2RlbCA9IHN5bnRoZXRpY01vZGVsKHtcblx0XHRcdGlkOiBcImdwdC01LjQtY3VzdG9tXCIsXG5cdFx0XHRjYXBhYmlsaXRpZXM6IHsgc3VwcG9ydHNYaGlnaDogZmFsc2UsIGNoYXJzUGVyVG9rZW46IDMgfSxcblx0XHR9KTtcblx0XHRjb25zdCBbcGF0Y2hlZF0gPSBhcHBseUNhcGFiaWxpdHlQYXRjaGVzKFttb2RlbF0pO1xuXHRcdC8vIEV4cGxpY2l0IHN1cHBvcnRzWGhpZ2g6IGZhbHNlIHdpbnMgb3ZlciBwYXRjaCdzIHRydWVcblx0XHRhc3NlcnQuZXF1YWwocGF0Y2hlZC5jYXBhYmlsaXRpZXM/LnN1cHBvcnRzWGhpZ2gsIGZhbHNlKTtcblx0XHQvLyBQYXRjaCBmaWxscyBpbiBzdXBwb3J0c1NlcnZpY2VUaWVyIHNpbmNlIGl0IHdhc24ndCBleHBsaWNpdGx5IHNldFxuXHRcdGFzc2VydC5lcXVhbChwYXRjaGVkLmNhcGFiaWxpdGllcz8uc3VwcG9ydHNTZXJ2aWNlVGllciwgdHJ1ZSk7XG5cdFx0Ly8gRXhwbGljaXQgY2hhcnNQZXJUb2tlbiBpcyBwcmVzZXJ2ZWRcblx0XHRhc3NlcnQuZXF1YWwocGF0Y2hlZC5jYXBhYmlsaXRpZXM/LmNoYXJzUGVyVG9rZW4sIDMpO1xuXHR9KTtcblxuXHRpdChcImRvZXMgbm90IG1vZGlmeSBtb2RlbHMgdGhhdCBtYXRjaCBubyBwYXRjaGVzXCIsICgpID0+IHtcblx0XHRjb25zdCBtb2RlbCA9IHN5bnRoZXRpY01vZGVsKHsgaWQ6IFwiZ2VtaW5pLTIuNS1wcm9cIiB9KTtcblx0XHRjb25zdCBbcGF0Y2hlZF0gPSBhcHBseUNhcGFiaWxpdHlQYXRjaGVzKFttb2RlbF0pO1xuXHRcdGFzc2VydC5lcXVhbChwYXRjaGVkLmNhcGFiaWxpdGllcywgdW5kZWZpbmVkKTtcblx0XHQvLyBTaG91bGQgcmV0dXJuIHRoZSBzYW1lIHJlZmVyZW5jZSB3aGVuIHVucGF0Y2hlZFxuXHRcdGFzc2VydC5lcXVhbChwYXRjaGVkLCBtb2RlbCk7XG5cdH0pO1xuXG5cdGl0KFwiaXMgaWRlbXBvdGVudCBcdTIwMTQgcmUtYXBwbHlpbmcgcGF0Y2hlcyBwcm9kdWNlcyB0aGUgc2FtZSByZXN1bHRcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IG1vZGVsID0gc3ludGhldGljTW9kZWwoeyBpZDogXCJncHQtNS4zXCIgfSk7XG5cdFx0Y29uc3QgZmlyc3QgPSBhcHBseUNhcGFiaWxpdHlQYXRjaGVzKFttb2RlbF0pO1xuXHRcdGNvbnN0IHNlY29uZCA9IGFwcGx5Q2FwYWJpbGl0eVBhdGNoZXMoZmlyc3QpO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwoZmlyc3RbMF0uY2FwYWJpbGl0aWVzLCBzZWNvbmRbMF0uY2FwYWJpbGl0aWVzKTtcblx0fSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsVUFBVSxVQUFVO0FBQzdCLE9BQU8sWUFBWTtBQUNuQixTQUFTLGNBQWMsV0FBVyxVQUFVLGVBQWUsOEJBQThCO0FBV3pGLFNBQVMsMENBQXFDLE1BQU07QUFDbkQsS0FBRyxnREFBZ0QsTUFBTTtBQUN4RCxVQUFNLFlBQVksYUFBYTtBQUMvQixXQUFPO0FBQUEsTUFDTixVQUFVLFNBQVMscUJBQXFCO0FBQUEsTUFDeEMscURBQXFELFVBQVUsS0FBSyxJQUFJLENBQUM7QUFBQSxJQUMxRTtBQUFBLEVBQ0QsQ0FBQztBQUVELEtBQUcsK0NBQStDLE1BQU07QUFDdkQsVUFBTSxTQUFTLFVBQVUscUJBQXFCO0FBQzlDLFVBQU0sTUFBTSxPQUFPLElBQUksQ0FBQyxNQUFNLEVBQUUsRUFBRSxFQUFFLEtBQUs7QUFDekMsVUFBTSxXQUFXO0FBQUEsTUFDaEI7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRDtBQUNBLFdBQU8sVUFBVSxLQUFLLFFBQVE7QUFBQSxFQUMvQixDQUFDO0FBRUQsS0FBRyx1REFBdUQsTUFBTTtBQUMvRCxVQUFNLFNBQVMsVUFBVSxxQkFBcUI7QUFDOUMsZUFBVyxTQUFTLFFBQVE7QUFDM0IsYUFBTztBQUFBLFFBQ04sTUFBTTtBQUFBLFFBQ047QUFBQSxRQUNBLFNBQVMsTUFBTSxFQUFFLHVCQUF1QixNQUFNLE9BQU87QUFBQSxNQUN0RDtBQUFBLElBQ0Q7QUFBQSxFQUNELENBQUM7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
