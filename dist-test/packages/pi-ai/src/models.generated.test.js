import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MODELS, getModel, getModels, getProviders } from "./models/index.js";
describe("regression #3582 \u2014 qwen/qwen3.6-plus available via openrouter", () => {
  it("qwen/qwen3.6-plus exists in MODELS['openrouter']", () => {
    const model = MODELS["openrouter"]["qwen/qwen3.6-plus"];
    assert.ok(model, "qwen/qwen3.6-plus must be present in MODELS.openrouter");
  });
  it("qwen/qwen3.6-plus is accessible via getModel()", () => {
    const model = getModel("openrouter", "qwen/qwen3.6-plus");
    assert.ok(model, "getModel('openrouter', 'qwen/qwen3.6-plus') must return a model");
  });
  it("qwen/qwen3.6-plus has id matching its registry key", () => {
    const model = getModel("openrouter", "qwen/qwen3.6-plus");
    assert.equal(model.id, "qwen/qwen3.6-plus");
  });
  it("qwen/qwen3.6-plus has provider set to openrouter", () => {
    const model = getModel("openrouter", "qwen/qwen3.6-plus");
    assert.equal(model.provider, "openrouter");
  });
  it("qwen/qwen3.6-plus has reasoning enabled", () => {
    const model = getModel("openrouter", "qwen/qwen3.6-plus");
    assert.equal(model.reasoning, true, "Qwen3.6 Plus is a reasoning model");
  });
  it("qwen/qwen3.6-plus has 1M context window", () => {
    const model = getModel("openrouter", "qwen/qwen3.6-plus");
    assert.equal(model.contextWindow, 1e6);
  });
});
describe("regression #4069 \u2014 z-ai/glm-5.1 available via openrouter", () => {
  it("z-ai/glm-5.1 exists in MODELS['openrouter']", () => {
    const model = MODELS["openrouter"]["z-ai/glm-5.1"];
    assert.ok(model, "z-ai/glm-5.1 must be present in MODELS.openrouter");
  });
  it("z-ai/glm-5.1 is accessible via getModel()", () => {
    const model = getModel("openrouter", "z-ai/glm-5.1");
    assert.ok(model, "getModel('openrouter', 'z-ai/glm-5.1') must return a model");
  });
  it("z-ai/glm-5.1 has id matching its registry key", () => {
    const model = getModel("openrouter", "z-ai/glm-5.1");
    assert.equal(model.id, "z-ai/glm-5.1");
  });
  it("z-ai/glm-5.1 has provider set to openrouter", () => {
    const model = getModel("openrouter", "z-ai/glm-5.1");
    assert.equal(model.provider, "openrouter");
  });
  it("z-ai/glm-5.1 has a positive context window", () => {
    const model = getModel("openrouter", "z-ai/glm-5.1");
    assert.ok(model.contextWindow > 0);
  });
  it("z-ai/glm-5.1 uses the OpenRouter base URL", () => {
    const model = getModel("openrouter", "z-ai/glm-5.1");
    assert.equal(model.baseUrl, "https://openrouter.ai/api/v1");
  });
});
describe("MODELS structural invariants", () => {
  function allModels() {
    const entries = [];
    for (const [providerKey, providerModels] of Object.entries(MODELS)) {
      for (const [modelKey, model] of Object.entries(providerModels)) {
        entries.push({ providerKey, modelKey, model });
      }
    }
    return entries;
  }
  it("every model's id field matches its key in MODELS", () => {
    const mismatches = [];
    for (const { providerKey, modelKey, model } of allModels()) {
      if (model["id"] !== modelKey) {
        mismatches.push(`${providerKey}/${modelKey}: id="${model["id"]}"`);
      }
    }
    assert.deepEqual(mismatches, [], `Models where 'id' doesn't match registry key:
  ${mismatches.join("\n  ")}`);
  });
  it("every model's provider field matches its parent provider key", () => {
    const mismatches = [];
    for (const { providerKey, modelKey, model } of allModels()) {
      if (model["provider"] !== providerKey) {
        mismatches.push(`${providerKey}/${modelKey}: provider="${model["provider"]}"`);
      }
    }
    assert.deepEqual(mismatches, [], `Models where 'provider' doesn't match parent key:
  ${mismatches.join("\n  ")}`);
  });
  it("every model has a non-empty string name", () => {
    const invalid = [];
    for (const { providerKey, modelKey, model } of allModels()) {
      if (typeof model["name"] !== "string" || model["name"].trim() === "") {
        invalid.push(`${providerKey}/${modelKey}`);
      }
    }
    assert.deepEqual(invalid, [], `Models with missing or empty name:
  ${invalid.join("\n  ")}`);
  });
  it("every model has a non-empty string api", () => {
    const invalid = [];
    for (const { providerKey, modelKey, model } of allModels()) {
      if (typeof model["api"] !== "string" || model["api"].trim() === "") {
        invalid.push(`${providerKey}/${modelKey}`);
      }
    }
    assert.deepEqual(invalid, [], `Models with missing or empty api:
  ${invalid.join("\n  ")}`);
  });
  it("every model's baseUrl starts with https:// (or is empty for azure-openai-responses)", () => {
    const invalid = [];
    for (const { providerKey, modelKey, model } of allModels()) {
      if (providerKey === "azure-openai-responses") continue;
      const url = model["baseUrl"];
      if (typeof url !== "string" || !url.startsWith("https://")) {
        invalid.push(`${providerKey}/${modelKey}: baseUrl="${url}"`);
      }
    }
    assert.deepEqual(invalid, [], `Models with missing or non-HTTPS baseUrl:
  ${invalid.join("\n  ")}`);
  });
  it("azure-openai-responses models have an empty baseUrl (runtime-configured)", () => {
    const models = getModels("azure-openai-responses");
    assert.ok(models.length > 0, "azure-openai-responses must have at least one model");
    for (const model of models) {
      assert.equal(model.baseUrl, "", `azure-openai-responses/${model.id} should have empty baseUrl`);
    }
  });
  it("every model has a boolean reasoning field", () => {
    const invalid = [];
    for (const { providerKey, modelKey, model } of allModels()) {
      if (typeof model["reasoning"] !== "boolean") {
        invalid.push(`${providerKey}/${modelKey}: reasoning=${model["reasoning"]}`);
      }
    }
    assert.deepEqual(invalid, [], `Models with non-boolean reasoning:
  ${invalid.join("\n  ")}`);
  });
  it("every model has a non-empty input array", () => {
    const invalid = [];
    for (const { providerKey, modelKey, model } of allModels()) {
      const input = model["input"];
      if (!Array.isArray(input) || input.length === 0) {
        invalid.push(`${providerKey}/${modelKey}`);
      }
    }
    assert.deepEqual(invalid, [], `Models with missing or empty input array:
  ${invalid.join("\n  ")}`);
  });
  it("every model has a positive contextWindow", () => {
    const invalid = [];
    for (const { providerKey, modelKey, model } of allModels()) {
      const cw = model["contextWindow"];
      if (typeof cw !== "number" || cw <= 0 || !Number.isFinite(cw)) {
        invalid.push(`${providerKey}/${modelKey}: contextWindow=${cw}`);
      }
    }
    assert.deepEqual(invalid, [], `Models with invalid contextWindow:
  ${invalid.join("\n  ")}`);
  });
  it("every model has a positive maxTokens", () => {
    const invalid = [];
    for (const { providerKey, modelKey, model } of allModels()) {
      const mt = model["maxTokens"];
      if (typeof mt !== "number" || mt <= 0 || !Number.isFinite(mt)) {
        invalid.push(`${providerKey}/${modelKey}: maxTokens=${mt}`);
      }
    }
    assert.deepEqual(invalid, [], `Models with invalid maxTokens:
  ${invalid.join("\n  ")}`);
  });
  it("every model's maxTokens does not exceed contextWindow", () => {
    const knownExceptions = /* @__PURE__ */ new Set([
      "openrouter/meta-llama/llama-3-8b-instruct",
      "openrouter/nex-agi/deepseek-v3.1-nex-n1",
      "openrouter/openai/gpt-3.5-turbo-0613",
      "openrouter/z-ai/glm-5"
    ]);
    const invalid = [];
    for (const { providerKey, modelKey, model } of allModels()) {
      if (knownExceptions.has(`${providerKey}/${modelKey}`)) continue;
      const cw = model["contextWindow"];
      const mt = model["maxTokens"];
      if (typeof cw === "number" && typeof mt === "number" && mt > cw) {
        invalid.push(`${providerKey}/${modelKey}: maxTokens(${mt}) > contextWindow(${cw})`);
      }
    }
    assert.deepEqual(invalid, [], `Models where maxTokens exceeds contextWindow:
  ${invalid.join("\n  ")}`);
  });
  it("every model has a cost object with non-negative numeric fields", () => {
    const knownNegativeCostModels = /* @__PURE__ */ new Set([
      "openrouter/openrouter/auto"
    ]);
    const invalid = [];
    for (const { providerKey, modelKey, model } of allModels()) {
      if (knownNegativeCostModels.has(`${providerKey}/${modelKey}`)) continue;
      const cost = model["cost"];
      if (!cost || typeof cost !== "object") {
        invalid.push(`${providerKey}/${modelKey}: missing cost object`);
        continue;
      }
      for (const field of ["input", "output", "cacheRead", "cacheWrite"]) {
        const val = cost[field];
        if (typeof val !== "number" || val < 0 || !Number.isFinite(val)) {
          invalid.push(`${providerKey}/${modelKey}: cost.${field}=${val}`);
        }
      }
    }
    assert.deepEqual(invalid, [], `Models with invalid cost fields:
  ${invalid.join("\n  ")}`);
  });
  it("no provider has duplicate model IDs", () => {
    const duplicates = [];
    for (const [providerKey, providerModels] of Object.entries(MODELS)) {
      const ids = Object.values(providerModels).map((m) => m["id"]);
      const seen = /* @__PURE__ */ new Set();
      for (const id of ids) {
        if (seen.has(id)) duplicates.push(`${providerKey}/${id}`);
        seen.add(id);
      }
    }
    assert.deepEqual(duplicates, [], `Duplicate model IDs within a provider:
  ${duplicates.join("\n  ")}`);
  });
});
describe("MODELS registry shape", () => {
  it("registry is non-empty", () => {
    const count = Object.keys(MODELS).length;
    assert.ok(count > 0, "MODELS must have at least one provider");
  });
  it("has at least 200 models in total (sanity check)", () => {
    let total = 0;
    for (const providerModels of Object.values(MODELS)) {
      total += Object.keys(providerModels).length;
    }
    assert.ok(total >= 200, `Registry has only ${total} models \u2014 unexpectedly small`);
  });
  it("getProviders() returns every generated provider", () => {
    const providers = getProviders();
    for (const p of Object.keys(MODELS)) {
      assert.ok(providers.includes(p), `getProviders() missing generated provider: ${p}`);
    }
  });
});
describe("removed models are absent from the registry", () => {
  const removedModels = [
    { provider: "openrouter", id: "anthropic/claude-3.5-sonnet" },
    { provider: "openrouter", id: "anthropic/claude-3.5-sonnet-20240620" },
    { provider: "openrouter", id: "mistralai/mistral-small-24b-instruct-2501" },
    { provider: "openrouter", id: "mistralai/mistral-small-3.1-24b-instruct:free" },
    { provider: "openrouter", id: "qwen/qwen3-4b:free" },
    { provider: "openrouter", id: "stepfun/step-3.5-flash:free" },
    { provider: "openrouter", id: "x-ai/grok-4.20-beta" },
    { provider: "openrouter", id: "arcee-ai/trinity-mini:free" },
    { provider: "openrouter", id: "google/gemini-3-pro-preview" },
    { provider: "openrouter", id: "kwaipilot/kat-coder-pro" },
    { provider: "openrouter", id: "meituan/longcat-flash-thinking" },
    { provider: "vercel-ai-gateway", id: "xai/grok-2-vision" },
    { provider: "anthropic", id: "claude-3-7-sonnet-latest" },
    // Groq decommissioned models — issue #4257
    { provider: "groq", id: "llama3-70b-8192" },
    { provider: "groq", id: "llama3-8b-8192" },
    { provider: "groq", id: "deepseek-r1-distill-llama-70b" },
    { provider: "groq", id: "gemma2-9b-it" },
    { provider: "groq", id: "meta-llama/llama-4-maverick-17b-128e-instruct" },
    { provider: "groq", id: "mistral-saba-24b" },
    { provider: "groq", id: "moonshotai/kimi-k2-instruct" },
    { provider: "groq", id: "moonshotai/kimi-k2-instruct-0905" },
    { provider: "groq", id: "qwen-qwq-32b" }
  ];
  for (const { provider, id } of removedModels) {
    it(`${provider}/${id} has been removed`, () => {
      const model = getModel(provider, id);
      assert.equal(model, void 0, `${provider}/${id} should be removed but is still present`);
    });
  }
});
describe("GPT-5.5 availability", () => {
  it("exposes GPT-5.5 through OpenAI API and OpenAI Codex providers", () => {
    const apiModel = getModel("openai", "gpt-5.5");
    assert.ok(apiModel, "openai/gpt-5.5 should be present");
    assert.equal(apiModel.contextWindow, 1e6);
    assert.equal(apiModel.cost.input, 5);
    assert.equal(apiModel.cost.output, 30);
    const codexModel = getModel("openai-codex", "gpt-5.5");
    assert.ok(codexModel, "openai-codex/gpt-5.5 should be present");
    assert.equal(codexModel.contextWindow, 4e5);
    assert.equal(codexModel.cost.input, 5);
    assert.equal(codexModel.cost.output, 30);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWkvc3JjL21vZGVscy5nZW5lcmF0ZWQudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgZGVzY3JpYmUsIGl0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBNT0RFTFMsIGdldE1vZGVsLCBnZXRNb2RlbHMsIGdldFByb3ZpZGVycyB9IGZyb20gXCIuL21vZGVscy9pbmRleC5qc1wiO1xuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIFJlZ3Jlc3Npb246IHF3ZW4vcXdlbjMuNi1wbHVzIG1pc3NpbmcgZnJvbSBPcGVuUm91dGVyIChpc3N1ZSAjMzU4Milcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG5kZXNjcmliZShcInJlZ3Jlc3Npb24gIzM1ODIgXHUyMDE0IHF3ZW4vcXdlbjMuNi1wbHVzIGF2YWlsYWJsZSB2aWEgb3BlbnJvdXRlclwiLCAoKSA9PiB7XG5cdGl0KFwicXdlbi9xd2VuMy42LXBsdXMgZXhpc3RzIGluIE1PREVMU1snb3BlbnJvdXRlciddXCIsICgpID0+IHtcblx0XHRjb25zdCBtb2RlbCA9IE1PREVMU1tcIm9wZW5yb3V0ZXJcIl1bXCJxd2VuL3F3ZW4zLjYtcGx1c1wiIGFzIGtleW9mICh0eXBlb2YgTU9ERUxTKVtcIm9wZW5yb3V0ZXJcIl1dO1xuXHRcdGFzc2VydC5vayhtb2RlbCwgXCJxd2VuL3F3ZW4zLjYtcGx1cyBtdXN0IGJlIHByZXNlbnQgaW4gTU9ERUxTLm9wZW5yb3V0ZXJcIik7XG5cdH0pO1xuXG5cdGl0KFwicXdlbi9xd2VuMy42LXBsdXMgaXMgYWNjZXNzaWJsZSB2aWEgZ2V0TW9kZWwoKVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgbW9kZWwgPSBnZXRNb2RlbChcIm9wZW5yb3V0ZXJcIiwgXCJxd2VuL3F3ZW4zLjYtcGx1c1wiIGFzIGFueSk7XG5cdFx0YXNzZXJ0Lm9rKG1vZGVsLCBcImdldE1vZGVsKCdvcGVucm91dGVyJywgJ3F3ZW4vcXdlbjMuNi1wbHVzJykgbXVzdCByZXR1cm4gYSBtb2RlbFwiKTtcblx0fSk7XG5cblx0aXQoXCJxd2VuL3F3ZW4zLjYtcGx1cyBoYXMgaWQgbWF0Y2hpbmcgaXRzIHJlZ2lzdHJ5IGtleVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgbW9kZWwgPSBnZXRNb2RlbChcIm9wZW5yb3V0ZXJcIiwgXCJxd2VuL3F3ZW4zLjYtcGx1c1wiIGFzIGFueSk7XG5cdFx0YXNzZXJ0LmVxdWFsKG1vZGVsLmlkLCBcInF3ZW4vcXdlbjMuNi1wbHVzXCIpO1xuXHR9KTtcblxuXHRpdChcInF3ZW4vcXdlbjMuNi1wbHVzIGhhcyBwcm92aWRlciBzZXQgdG8gb3BlbnJvdXRlclwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgbW9kZWwgPSBnZXRNb2RlbChcIm9wZW5yb3V0ZXJcIiwgXCJxd2VuL3F3ZW4zLjYtcGx1c1wiIGFzIGFueSk7XG5cdFx0YXNzZXJ0LmVxdWFsKG1vZGVsLnByb3ZpZGVyLCBcIm9wZW5yb3V0ZXJcIik7XG5cdH0pO1xuXG5cdGl0KFwicXdlbi9xd2VuMy42LXBsdXMgaGFzIHJlYXNvbmluZyBlbmFibGVkXCIsICgpID0+IHtcblx0XHRjb25zdCBtb2RlbCA9IGdldE1vZGVsKFwib3BlbnJvdXRlclwiLCBcInF3ZW4vcXdlbjMuNi1wbHVzXCIgYXMgYW55KTtcblx0XHRhc3NlcnQuZXF1YWwobW9kZWwucmVhc29uaW5nLCB0cnVlLCBcIlF3ZW4zLjYgUGx1cyBpcyBhIHJlYXNvbmluZyBtb2RlbFwiKTtcblx0fSk7XG5cblx0aXQoXCJxd2VuL3F3ZW4zLjYtcGx1cyBoYXMgMU0gY29udGV4dCB3aW5kb3dcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IG1vZGVsID0gZ2V0TW9kZWwoXCJvcGVucm91dGVyXCIsIFwicXdlbi9xd2VuMy42LXBsdXNcIiBhcyBhbnkpO1xuXHRcdGFzc2VydC5lcXVhbChtb2RlbC5jb250ZXh0V2luZG93LCAxXzAwMF8wMDApO1xuXHR9KTtcbn0pO1xuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIFJlZ3Jlc3Npb246IHotYWkvZ2xtLTUuMSBtaXNzaW5nIGZyb20gT3BlblJvdXRlciAoaXNzdWUgIzQwNjkpXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuZGVzY3JpYmUoXCJyZWdyZXNzaW9uICM0MDY5IFx1MjAxNCB6LWFpL2dsbS01LjEgYXZhaWxhYmxlIHZpYSBvcGVucm91dGVyXCIsICgpID0+IHtcblx0aXQoXCJ6LWFpL2dsbS01LjEgZXhpc3RzIGluIE1PREVMU1snb3BlbnJvdXRlciddXCIsICgpID0+IHtcblx0XHRjb25zdCBtb2RlbCA9IE1PREVMU1tcIm9wZW5yb3V0ZXJcIl1bXCJ6LWFpL2dsbS01LjFcIiBhcyBrZXlvZiAodHlwZW9mIE1PREVMUylbXCJvcGVucm91dGVyXCJdXTtcblx0XHRhc3NlcnQub2sobW9kZWwsIFwiei1haS9nbG0tNS4xIG11c3QgYmUgcHJlc2VudCBpbiBNT0RFTFMub3BlbnJvdXRlclwiKTtcblx0fSk7XG5cblx0aXQoXCJ6LWFpL2dsbS01LjEgaXMgYWNjZXNzaWJsZSB2aWEgZ2V0TW9kZWwoKVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgbW9kZWwgPSBnZXRNb2RlbChcIm9wZW5yb3V0ZXJcIiwgXCJ6LWFpL2dsbS01LjFcIiBhcyBhbnkpO1xuXHRcdGFzc2VydC5vayhtb2RlbCwgXCJnZXRNb2RlbCgnb3BlbnJvdXRlcicsICd6LWFpL2dsbS01LjEnKSBtdXN0IHJldHVybiBhIG1vZGVsXCIpO1xuXHR9KTtcblxuXHRpdChcInotYWkvZ2xtLTUuMSBoYXMgaWQgbWF0Y2hpbmcgaXRzIHJlZ2lzdHJ5IGtleVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgbW9kZWwgPSBnZXRNb2RlbChcIm9wZW5yb3V0ZXJcIiwgXCJ6LWFpL2dsbS01LjFcIiBhcyBhbnkpO1xuXHRcdGFzc2VydC5lcXVhbChtb2RlbC5pZCwgXCJ6LWFpL2dsbS01LjFcIik7XG5cdH0pO1xuXG5cdGl0KFwiei1haS9nbG0tNS4xIGhhcyBwcm92aWRlciBzZXQgdG8gb3BlbnJvdXRlclwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgbW9kZWwgPSBnZXRNb2RlbChcIm9wZW5yb3V0ZXJcIiwgXCJ6LWFpL2dsbS01LjFcIiBhcyBhbnkpO1xuXHRcdGFzc2VydC5lcXVhbChtb2RlbC5wcm92aWRlciwgXCJvcGVucm91dGVyXCIpO1xuXHR9KTtcblxuXHRpdChcInotYWkvZ2xtLTUuMSBoYXMgYSBwb3NpdGl2ZSBjb250ZXh0IHdpbmRvd1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgbW9kZWwgPSBnZXRNb2RlbChcIm9wZW5yb3V0ZXJcIiwgXCJ6LWFpL2dsbS01LjFcIiBhcyBhbnkpO1xuXHRcdGFzc2VydC5vayhtb2RlbC5jb250ZXh0V2luZG93ID4gMCk7XG5cdH0pO1xuXG5cdGl0KFwiei1haS9nbG0tNS4xIHVzZXMgdGhlIE9wZW5Sb3V0ZXIgYmFzZSBVUkxcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IG1vZGVsID0gZ2V0TW9kZWwoXCJvcGVucm91dGVyXCIsIFwiei1haS9nbG0tNS4xXCIgYXMgYW55KTtcblx0XHRhc3NlcnQuZXF1YWwobW9kZWwuYmFzZVVybCwgXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIpO1xuXHR9KTtcbn0pO1xuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIFN0cnVjdHVyYWwgaW52YXJpYW50cyBcdTIwMTQgZXZlcnkgbW9kZWwgaW4gTU9ERUxTIG11c3QgYmUgd2VsbC1mb3JtZWRcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG5kZXNjcmliZShcIk1PREVMUyBzdHJ1Y3R1cmFsIGludmFyaWFudHNcIiwgKCkgPT4ge1xuXHR0eXBlIE1vZGVsRW50cnkgPSB7IHByb3ZpZGVyS2V5OiBzdHJpbmc7IG1vZGVsS2V5OiBzdHJpbmc7IG1vZGVsOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB9O1xuXG5cdGZ1bmN0aW9uIGFsbE1vZGVscygpOiBNb2RlbEVudHJ5W10ge1xuXHRcdGNvbnN0IGVudHJpZXM6IE1vZGVsRW50cnlbXSA9IFtdO1xuXHRcdGZvciAoY29uc3QgW3Byb3ZpZGVyS2V5LCBwcm92aWRlck1vZGVsc10gb2YgT2JqZWN0LmVudHJpZXMoTU9ERUxTKSkge1xuXHRcdFx0Zm9yIChjb25zdCBbbW9kZWxLZXksIG1vZGVsXSBvZiBPYmplY3QuZW50cmllcyhwcm92aWRlck1vZGVscykpIHtcblx0XHRcdFx0ZW50cmllcy5wdXNoKHsgcHJvdmlkZXJLZXksIG1vZGVsS2V5LCBtb2RlbDogbW9kZWwgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfSk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdHJldHVybiBlbnRyaWVzO1xuXHR9XG5cblx0aXQoXCJldmVyeSBtb2RlbCdzIGlkIGZpZWxkIG1hdGNoZXMgaXRzIGtleSBpbiBNT0RFTFNcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IG1pc21hdGNoZXM6IHN0cmluZ1tdID0gW107XG5cdFx0Zm9yIChjb25zdCB7IHByb3ZpZGVyS2V5LCBtb2RlbEtleSwgbW9kZWwgfSBvZiBhbGxNb2RlbHMoKSkge1xuXHRcdFx0aWYgKG1vZGVsW1wiaWRcIl0gIT09IG1vZGVsS2V5KSB7XG5cdFx0XHRcdG1pc21hdGNoZXMucHVzaChgJHtwcm92aWRlcktleX0vJHttb2RlbEtleX06IGlkPVwiJHttb2RlbFtcImlkXCJdfVwiYCk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdGFzc2VydC5kZWVwRXF1YWwobWlzbWF0Y2hlcywgW10sIGBNb2RlbHMgd2hlcmUgJ2lkJyBkb2Vzbid0IG1hdGNoIHJlZ2lzdHJ5IGtleTpcXG4gICR7bWlzbWF0Y2hlcy5qb2luKFwiXFxuICBcIil9YCk7XG5cdH0pO1xuXG5cdGl0KFwiZXZlcnkgbW9kZWwncyBwcm92aWRlciBmaWVsZCBtYXRjaGVzIGl0cyBwYXJlbnQgcHJvdmlkZXIga2V5XCIsICgpID0+IHtcblx0XHRjb25zdCBtaXNtYXRjaGVzOiBzdHJpbmdbXSA9IFtdO1xuXHRcdGZvciAoY29uc3QgeyBwcm92aWRlcktleSwgbW9kZWxLZXksIG1vZGVsIH0gb2YgYWxsTW9kZWxzKCkpIHtcblx0XHRcdGlmIChtb2RlbFtcInByb3ZpZGVyXCJdICE9PSBwcm92aWRlcktleSkge1xuXHRcdFx0XHRtaXNtYXRjaGVzLnB1c2goYCR7cHJvdmlkZXJLZXl9LyR7bW9kZWxLZXl9OiBwcm92aWRlcj1cIiR7bW9kZWxbXCJwcm92aWRlclwiXX1cImApO1xuXHRcdFx0fVxuXHRcdH1cblx0XHRhc3NlcnQuZGVlcEVxdWFsKG1pc21hdGNoZXMsIFtdLCBgTW9kZWxzIHdoZXJlICdwcm92aWRlcicgZG9lc24ndCBtYXRjaCBwYXJlbnQga2V5OlxcbiAgJHttaXNtYXRjaGVzLmpvaW4oXCJcXG4gIFwiKX1gKTtcblx0fSk7XG5cblx0aXQoXCJldmVyeSBtb2RlbCBoYXMgYSBub24tZW1wdHkgc3RyaW5nIG5hbWVcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGludmFsaWQ6IHN0cmluZ1tdID0gW107XG5cdFx0Zm9yIChjb25zdCB7IHByb3ZpZGVyS2V5LCBtb2RlbEtleSwgbW9kZWwgfSBvZiBhbGxNb2RlbHMoKSkge1xuXHRcdFx0aWYgKHR5cGVvZiBtb2RlbFtcIm5hbWVcIl0gIT09IFwic3RyaW5nXCIgfHwgbW9kZWxbXCJuYW1lXCJdLnRyaW0oKSA9PT0gXCJcIikge1xuXHRcdFx0XHRpbnZhbGlkLnB1c2goYCR7cHJvdmlkZXJLZXl9LyR7bW9kZWxLZXl9YCk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdGFzc2VydC5kZWVwRXF1YWwoaW52YWxpZCwgW10sIGBNb2RlbHMgd2l0aCBtaXNzaW5nIG9yIGVtcHR5IG5hbWU6XFxuICAke2ludmFsaWQuam9pbihcIlxcbiAgXCIpfWApO1xuXHR9KTtcblxuXHRpdChcImV2ZXJ5IG1vZGVsIGhhcyBhIG5vbi1lbXB0eSBzdHJpbmcgYXBpXCIsICgpID0+IHtcblx0XHRjb25zdCBpbnZhbGlkOiBzdHJpbmdbXSA9IFtdO1xuXHRcdGZvciAoY29uc3QgeyBwcm92aWRlcktleSwgbW9kZWxLZXksIG1vZGVsIH0gb2YgYWxsTW9kZWxzKCkpIHtcblx0XHRcdGlmICh0eXBlb2YgbW9kZWxbXCJhcGlcIl0gIT09IFwic3RyaW5nXCIgfHwgbW9kZWxbXCJhcGlcIl0udHJpbSgpID09PSBcIlwiKSB7XG5cdFx0XHRcdGludmFsaWQucHVzaChgJHtwcm92aWRlcktleX0vJHttb2RlbEtleX1gKTtcblx0XHRcdH1cblx0XHR9XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChpbnZhbGlkLCBbXSwgYE1vZGVscyB3aXRoIG1pc3Npbmcgb3IgZW1wdHkgYXBpOlxcbiAgJHtpbnZhbGlkLmpvaW4oXCJcXG4gIFwiKX1gKTtcblx0fSk7XG5cblx0aXQoXCJldmVyeSBtb2RlbCdzIGJhc2VVcmwgc3RhcnRzIHdpdGggaHR0cHM6Ly8gKG9yIGlzIGVtcHR5IGZvciBhenVyZS1vcGVuYWktcmVzcG9uc2VzKVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgaW52YWxpZDogc3RyaW5nW10gPSBbXTtcblx0XHRmb3IgKGNvbnN0IHsgcHJvdmlkZXJLZXksIG1vZGVsS2V5LCBtb2RlbCB9IG9mIGFsbE1vZGVscygpKSB7XG5cdFx0XHRpZiAocHJvdmlkZXJLZXkgPT09IFwiYXp1cmUtb3BlbmFpLXJlc3BvbnNlc1wiKSBjb250aW51ZTtcblx0XHRcdGNvbnN0IHVybCA9IG1vZGVsW1wiYmFzZVVybFwiXTtcblx0XHRcdGlmICh0eXBlb2YgdXJsICE9PSBcInN0cmluZ1wiIHx8ICF1cmwuc3RhcnRzV2l0aChcImh0dHBzOi8vXCIpKSB7XG5cdFx0XHRcdGludmFsaWQucHVzaChgJHtwcm92aWRlcktleX0vJHttb2RlbEtleX06IGJhc2VVcmw9XCIke3VybH1cImApO1xuXHRcdFx0fVxuXHRcdH1cblx0XHRhc3NlcnQuZGVlcEVxdWFsKGludmFsaWQsIFtdLCBgTW9kZWxzIHdpdGggbWlzc2luZyBvciBub24tSFRUUFMgYmFzZVVybDpcXG4gICR7aW52YWxpZC5qb2luKFwiXFxuICBcIil9YCk7XG5cdH0pO1xuXG5cdGl0KFwiYXp1cmUtb3BlbmFpLXJlc3BvbnNlcyBtb2RlbHMgaGF2ZSBhbiBlbXB0eSBiYXNlVXJsIChydW50aW1lLWNvbmZpZ3VyZWQpXCIsICgpID0+IHtcblx0XHRjb25zdCBtb2RlbHMgPSBnZXRNb2RlbHMoXCJhenVyZS1vcGVuYWktcmVzcG9uc2VzXCIpO1xuXHRcdGFzc2VydC5vayhtb2RlbHMubGVuZ3RoID4gMCwgXCJhenVyZS1vcGVuYWktcmVzcG9uc2VzIG11c3QgaGF2ZSBhdCBsZWFzdCBvbmUgbW9kZWxcIik7XG5cdFx0Zm9yIChjb25zdCBtb2RlbCBvZiBtb2RlbHMpIHtcblx0XHRcdGFzc2VydC5lcXVhbChtb2RlbC5iYXNlVXJsLCBcIlwiLCBgYXp1cmUtb3BlbmFpLXJlc3BvbnNlcy8ke21vZGVsLmlkfSBzaG91bGQgaGF2ZSBlbXB0eSBiYXNlVXJsYCk7XG5cdFx0fVxuXHR9KTtcblxuXHRpdChcImV2ZXJ5IG1vZGVsIGhhcyBhIGJvb2xlYW4gcmVhc29uaW5nIGZpZWxkXCIsICgpID0+IHtcblx0XHRjb25zdCBpbnZhbGlkOiBzdHJpbmdbXSA9IFtdO1xuXHRcdGZvciAoY29uc3QgeyBwcm92aWRlcktleSwgbW9kZWxLZXksIG1vZGVsIH0gb2YgYWxsTW9kZWxzKCkpIHtcblx0XHRcdGlmICh0eXBlb2YgbW9kZWxbXCJyZWFzb25pbmdcIl0gIT09IFwiYm9vbGVhblwiKSB7XG5cdFx0XHRcdGludmFsaWQucHVzaChgJHtwcm92aWRlcktleX0vJHttb2RlbEtleX06IHJlYXNvbmluZz0ke21vZGVsW1wicmVhc29uaW5nXCJdfWApO1xuXHRcdFx0fVxuXHRcdH1cblx0XHRhc3NlcnQuZGVlcEVxdWFsKGludmFsaWQsIFtdLCBgTW9kZWxzIHdpdGggbm9uLWJvb2xlYW4gcmVhc29uaW5nOlxcbiAgJHtpbnZhbGlkLmpvaW4oXCJcXG4gIFwiKX1gKTtcblx0fSk7XG5cblx0aXQoXCJldmVyeSBtb2RlbCBoYXMgYSBub24tZW1wdHkgaW5wdXQgYXJyYXlcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGludmFsaWQ6IHN0cmluZ1tdID0gW107XG5cdFx0Zm9yIChjb25zdCB7IHByb3ZpZGVyS2V5LCBtb2RlbEtleSwgbW9kZWwgfSBvZiBhbGxNb2RlbHMoKSkge1xuXHRcdFx0Y29uc3QgaW5wdXQgPSBtb2RlbFtcImlucHV0XCJdO1xuXHRcdFx0aWYgKCFBcnJheS5pc0FycmF5KGlucHV0KSB8fCBpbnB1dC5sZW5ndGggPT09IDApIHtcblx0XHRcdFx0aW52YWxpZC5wdXNoKGAke3Byb3ZpZGVyS2V5fS8ke21vZGVsS2V5fWApO1xuXHRcdFx0fVxuXHRcdH1cblx0XHRhc3NlcnQuZGVlcEVxdWFsKGludmFsaWQsIFtdLCBgTW9kZWxzIHdpdGggbWlzc2luZyBvciBlbXB0eSBpbnB1dCBhcnJheTpcXG4gICR7aW52YWxpZC5qb2luKFwiXFxuICBcIil9YCk7XG5cdH0pO1xuXG5cdGl0KFwiZXZlcnkgbW9kZWwgaGFzIGEgcG9zaXRpdmUgY29udGV4dFdpbmRvd1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgaW52YWxpZDogc3RyaW5nW10gPSBbXTtcblx0XHRmb3IgKGNvbnN0IHsgcHJvdmlkZXJLZXksIG1vZGVsS2V5LCBtb2RlbCB9IG9mIGFsbE1vZGVscygpKSB7XG5cdFx0XHRjb25zdCBjdyA9IG1vZGVsW1wiY29udGV4dFdpbmRvd1wiXTtcblx0XHRcdGlmICh0eXBlb2YgY3cgIT09IFwibnVtYmVyXCIgfHwgY3cgPD0gMCB8fCAhTnVtYmVyLmlzRmluaXRlKGN3KSkge1xuXHRcdFx0XHRpbnZhbGlkLnB1c2goYCR7cHJvdmlkZXJLZXl9LyR7bW9kZWxLZXl9OiBjb250ZXh0V2luZG93PSR7Y3d9YCk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdGFzc2VydC5kZWVwRXF1YWwoaW52YWxpZCwgW10sIGBNb2RlbHMgd2l0aCBpbnZhbGlkIGNvbnRleHRXaW5kb3c6XFxuICAke2ludmFsaWQuam9pbihcIlxcbiAgXCIpfWApO1xuXHR9KTtcblxuXHRpdChcImV2ZXJ5IG1vZGVsIGhhcyBhIHBvc2l0aXZlIG1heFRva2Vuc1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgaW52YWxpZDogc3RyaW5nW10gPSBbXTtcblx0XHRmb3IgKGNvbnN0IHsgcHJvdmlkZXJLZXksIG1vZGVsS2V5LCBtb2RlbCB9IG9mIGFsbE1vZGVscygpKSB7XG5cdFx0XHRjb25zdCBtdCA9IG1vZGVsW1wibWF4VG9rZW5zXCJdO1xuXHRcdFx0aWYgKHR5cGVvZiBtdCAhPT0gXCJudW1iZXJcIiB8fCBtdCA8PSAwIHx8ICFOdW1iZXIuaXNGaW5pdGUobXQpKSB7XG5cdFx0XHRcdGludmFsaWQucHVzaChgJHtwcm92aWRlcktleX0vJHttb2RlbEtleX06IG1heFRva2Vucz0ke210fWApO1xuXHRcdFx0fVxuXHRcdH1cblx0XHRhc3NlcnQuZGVlcEVxdWFsKGludmFsaWQsIFtdLCBgTW9kZWxzIHdpdGggaW52YWxpZCBtYXhUb2tlbnM6XFxuICAke2ludmFsaWQuam9pbihcIlxcbiAgXCIpfWApO1xuXHR9KTtcblxuXHRpdChcImV2ZXJ5IG1vZGVsJ3MgbWF4VG9rZW5zIGRvZXMgbm90IGV4Y2VlZCBjb250ZXh0V2luZG93XCIsICgpID0+IHtcblx0XHRjb25zdCBrbm93bkV4Y2VwdGlvbnMgPSBuZXcgU2V0KFtcblx0XHRcdFwib3BlbnJvdXRlci9tZXRhLWxsYW1hL2xsYW1hLTMtOGItaW5zdHJ1Y3RcIixcblx0XHRcdFwib3BlbnJvdXRlci9uZXgtYWdpL2RlZXBzZWVrLXYzLjEtbmV4LW4xXCIsXG5cdFx0XHRcIm9wZW5yb3V0ZXIvb3BlbmFpL2dwdC0zLjUtdHVyYm8tMDYxM1wiLFxuXHRcdFx0XCJvcGVucm91dGVyL3otYWkvZ2xtLTVcIixcblx0XHRdKTtcblxuXHRcdGNvbnN0IGludmFsaWQ6IHN0cmluZ1tdID0gW107XG5cdFx0Zm9yIChjb25zdCB7IHByb3ZpZGVyS2V5LCBtb2RlbEtleSwgbW9kZWwgfSBvZiBhbGxNb2RlbHMoKSkge1xuXHRcdFx0aWYgKGtub3duRXhjZXB0aW9ucy5oYXMoYCR7cHJvdmlkZXJLZXl9LyR7bW9kZWxLZXl9YCkpIGNvbnRpbnVlO1xuXHRcdFx0Y29uc3QgY3cgPSBtb2RlbFtcImNvbnRleHRXaW5kb3dcIl0gYXMgbnVtYmVyO1xuXHRcdFx0Y29uc3QgbXQgPSBtb2RlbFtcIm1heFRva2Vuc1wiXSBhcyBudW1iZXI7XG5cdFx0XHRpZiAodHlwZW9mIGN3ID09PSBcIm51bWJlclwiICYmIHR5cGVvZiBtdCA9PT0gXCJudW1iZXJcIiAmJiBtdCA+IGN3KSB7XG5cdFx0XHRcdGludmFsaWQucHVzaChgJHtwcm92aWRlcktleX0vJHttb2RlbEtleX06IG1heFRva2Vucygke210fSkgPiBjb250ZXh0V2luZG93KCR7Y3d9KWApO1xuXHRcdFx0fVxuXHRcdH1cblx0XHRhc3NlcnQuZGVlcEVxdWFsKGludmFsaWQsIFtdLCBgTW9kZWxzIHdoZXJlIG1heFRva2VucyBleGNlZWRzIGNvbnRleHRXaW5kb3c6XFxuICAke2ludmFsaWQuam9pbihcIlxcbiAgXCIpfWApO1xuXHR9KTtcblxuXHRpdChcImV2ZXJ5IG1vZGVsIGhhcyBhIGNvc3Qgb2JqZWN0IHdpdGggbm9uLW5lZ2F0aXZlIG51bWVyaWMgZmllbGRzXCIsICgpID0+IHtcblx0XHRjb25zdCBrbm93bk5lZ2F0aXZlQ29zdE1vZGVscyA9IG5ldyBTZXQoW1xuXHRcdFx0XCJvcGVucm91dGVyL29wZW5yb3V0ZXIvYXV0b1wiLFxuXHRcdF0pO1xuXG5cdFx0Y29uc3QgaW52YWxpZDogc3RyaW5nW10gPSBbXTtcblx0XHRmb3IgKGNvbnN0IHsgcHJvdmlkZXJLZXksIG1vZGVsS2V5LCBtb2RlbCB9IG9mIGFsbE1vZGVscygpKSB7XG5cdFx0XHRpZiAoa25vd25OZWdhdGl2ZUNvc3RNb2RlbHMuaGFzKGAke3Byb3ZpZGVyS2V5fS8ke21vZGVsS2V5fWApKSBjb250aW51ZTtcblx0XHRcdGNvbnN0IGNvc3QgPSBtb2RlbFtcImNvc3RcIl0gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQ7XG5cdFx0XHRpZiAoIWNvc3QgfHwgdHlwZW9mIGNvc3QgIT09IFwib2JqZWN0XCIpIHtcblx0XHRcdFx0aW52YWxpZC5wdXNoKGAke3Byb3ZpZGVyS2V5fS8ke21vZGVsS2V5fTogbWlzc2luZyBjb3N0IG9iamVjdGApO1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblx0XHRcdGZvciAoY29uc3QgZmllbGQgb2YgW1wiaW5wdXRcIiwgXCJvdXRwdXRcIiwgXCJjYWNoZVJlYWRcIiwgXCJjYWNoZVdyaXRlXCJdIGFzIGNvbnN0KSB7XG5cdFx0XHRcdGNvbnN0IHZhbCA9IGNvc3RbZmllbGRdO1xuXHRcdFx0XHRpZiAodHlwZW9mIHZhbCAhPT0gXCJudW1iZXJcIiB8fCB2YWwgPCAwIHx8ICFOdW1iZXIuaXNGaW5pdGUodmFsKSkge1xuXHRcdFx0XHRcdGludmFsaWQucHVzaChgJHtwcm92aWRlcktleX0vJHttb2RlbEtleX06IGNvc3QuJHtmaWVsZH09JHt2YWx9YCk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChpbnZhbGlkLCBbXSwgYE1vZGVscyB3aXRoIGludmFsaWQgY29zdCBmaWVsZHM6XFxuICAke2ludmFsaWQuam9pbihcIlxcbiAgXCIpfWApO1xuXHR9KTtcblxuXHRpdChcIm5vIHByb3ZpZGVyIGhhcyBkdXBsaWNhdGUgbW9kZWwgSURzXCIsICgpID0+IHtcblx0XHRjb25zdCBkdXBsaWNhdGVzOiBzdHJpbmdbXSA9IFtdO1xuXHRcdGZvciAoY29uc3QgW3Byb3ZpZGVyS2V5LCBwcm92aWRlck1vZGVsc10gb2YgT2JqZWN0LmVudHJpZXMoTU9ERUxTKSkge1xuXHRcdFx0Y29uc3QgaWRzID0gT2JqZWN0LnZhbHVlcyhwcm92aWRlck1vZGVscykubWFwKChtKSA9PiAobSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPilbXCJpZFwiXSBhcyBzdHJpbmcpO1xuXHRcdFx0Y29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXHRcdFx0Zm9yIChjb25zdCBpZCBvZiBpZHMpIHtcblx0XHRcdFx0aWYgKHNlZW4uaGFzKGlkKSkgZHVwbGljYXRlcy5wdXNoKGAke3Byb3ZpZGVyS2V5fS8ke2lkfWApO1xuXHRcdFx0XHRzZWVuLmFkZChpZCk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdGFzc2VydC5kZWVwRXF1YWwoZHVwbGljYXRlcywgW10sIGBEdXBsaWNhdGUgbW9kZWwgSURzIHdpdGhpbiBhIHByb3ZpZGVyOlxcbiAgJHtkdXBsaWNhdGVzLmpvaW4oXCJcXG4gIFwiKX1gKTtcblx0fSk7XG59KTtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBSZWdpc3RyeSBzaGFwZVxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbmRlc2NyaWJlKFwiTU9ERUxTIHJlZ2lzdHJ5IHNoYXBlXCIsICgpID0+IHtcblx0Ly8gXCJleGFjdGx5IDIzIHByb3ZpZGVyc1wiIGFuZCBcImFsbCAyMyBleHBlY3RlZCBwcm92aWRlcnNcIiB0ZXN0c1xuXHQvLyByZW1vdmVkICgjNDgwNCk6IGVhY2ggaGFyZGNvZGVkIGEgc25hcHNob3QgY291bnQvbGlzdCB0aGF0IGJyZWFrc1xuXHQvLyBvbiBldmVyeSBiZW5pZ24gcHJvdmlkZXIgYWRkaXRpb24gd2l0aG91dCBpbmRpY2F0aW5nIGFueSByZWFsXG5cdC8vIHByb2JsZW0uIFRoZSBzdHJ1Y3R1cmFsIGludmFyaWFudHMgYmVsb3cgKG5vbi1lbXB0eSwgc2FuaXR5XG5cdC8vIHRocmVzaG9sZCwgZ2V0UHJvdmlkZXJzIGNvbnNpc3RlbmN5KSBhcmUgdGhlIHVzZWZ1bCBndWFyYW50ZWVzLlxuXG5cdGl0KFwicmVnaXN0cnkgaXMgbm9uLWVtcHR5XCIsICgpID0+IHtcblx0XHRjb25zdCBjb3VudCA9IE9iamVjdC5rZXlzKE1PREVMUykubGVuZ3RoO1xuXHRcdGFzc2VydC5vayhjb3VudCA+IDAsIFwiTU9ERUxTIG11c3QgaGF2ZSBhdCBsZWFzdCBvbmUgcHJvdmlkZXJcIik7XG5cdH0pO1xuXG5cdGl0KFwiaGFzIGF0IGxlYXN0IDIwMCBtb2RlbHMgaW4gdG90YWwgKHNhbml0eSBjaGVjaylcIiwgKCkgPT4ge1xuXHRcdGxldCB0b3RhbCA9IDA7XG5cdFx0Zm9yIChjb25zdCBwcm92aWRlck1vZGVscyBvZiBPYmplY3QudmFsdWVzKE1PREVMUykpIHtcblx0XHRcdHRvdGFsICs9IE9iamVjdC5rZXlzKHByb3ZpZGVyTW9kZWxzKS5sZW5ndGg7XG5cdFx0fVxuXHRcdGFzc2VydC5vayh0b3RhbCA+PSAyMDAsIGBSZWdpc3RyeSBoYXMgb25seSAke3RvdGFsfSBtb2RlbHMgXHUyMDE0IHVuZXhwZWN0ZWRseSBzbWFsbGApO1xuXHR9KTtcblxuXHRpdChcImdldFByb3ZpZGVycygpIHJldHVybnMgZXZlcnkgZ2VuZXJhdGVkIHByb3ZpZGVyXCIsICgpID0+IHtcblx0XHQvLyBgZ2V0UHJvdmlkZXJzKClgIG1heSBhbHNvIGluY2x1ZGUgcHJvdmlkZXJzIGRlZmluZWQgaW5cblx0XHQvLyBgbW9kZWxzL2N1c3RvbS50c2AgKG1hbnVhbGx5LXBhdGNoZWQgZW50cmllcykuIFdlIGFzc2VydCBvbmx5XG5cdFx0Ly8gdGhhdCBldmVyeSBHRU5FUkFURUQgcHJvdmlkZXIgaXMgcHJlc2VudCBcdTIwMTQgd2hpY2ggaXMgdGhlXG5cdFx0Ly8gaW52YXJpYW50IHRoZSBnZW5lcmF0b3IgY29udHJvbHMuXG5cdFx0Y29uc3QgcHJvdmlkZXJzID0gZ2V0UHJvdmlkZXJzKCk7XG5cdFx0Zm9yIChjb25zdCBwIG9mIE9iamVjdC5rZXlzKE1PREVMUykpIHtcblx0XHRcdGFzc2VydC5vayhwcm92aWRlcnMuaW5jbHVkZXMocCBhcyBhbnkpLCBgZ2V0UHJvdmlkZXJzKCkgbWlzc2luZyBnZW5lcmF0ZWQgcHJvdmlkZXI6ICR7cH1gKTtcblx0XHR9XG5cdH0pO1xufSk7XG5cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuLy8gUmVtb3ZlZCBtb2RlbHMgbXVzdCBub3QgZXhpc3Rcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG5kZXNjcmliZShcInJlbW92ZWQgbW9kZWxzIGFyZSBhYnNlbnQgZnJvbSB0aGUgcmVnaXN0cnlcIiwgKCkgPT4ge1xuXHRjb25zdCByZW1vdmVkTW9kZWxzOiBBcnJheTx7IHByb3ZpZGVyOiBzdHJpbmc7IGlkOiBzdHJpbmcgfT4gPSBbXG5cdFx0eyBwcm92aWRlcjogXCJvcGVucm91dGVyXCIsIGlkOiBcImFudGhyb3BpYy9jbGF1ZGUtMy41LXNvbm5ldFwiIH0sXG5cdFx0eyBwcm92aWRlcjogXCJvcGVucm91dGVyXCIsIGlkOiBcImFudGhyb3BpYy9jbGF1ZGUtMy41LXNvbm5ldC0yMDI0MDYyMFwiIH0sXG5cdFx0eyBwcm92aWRlcjogXCJvcGVucm91dGVyXCIsIGlkOiBcIm1pc3RyYWxhaS9taXN0cmFsLXNtYWxsLTI0Yi1pbnN0cnVjdC0yNTAxXCIgfSxcblx0XHR7IHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIiwgaWQ6IFwibWlzdHJhbGFpL21pc3RyYWwtc21hbGwtMy4xLTI0Yi1pbnN0cnVjdDpmcmVlXCIgfSxcblx0XHR7IHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIiwgaWQ6IFwicXdlbi9xd2VuMy00YjpmcmVlXCIgfSxcblx0XHR7IHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIiwgaWQ6IFwic3RlcGZ1bi9zdGVwLTMuNS1mbGFzaDpmcmVlXCIgfSxcblx0XHR7IHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIiwgaWQ6IFwieC1haS9ncm9rLTQuMjAtYmV0YVwiIH0sXG5cdFx0eyBwcm92aWRlcjogXCJvcGVucm91dGVyXCIsIGlkOiBcImFyY2VlLWFpL3RyaW5pdHktbWluaTpmcmVlXCIgfSxcblx0XHR7IHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIiwgaWQ6IFwiZ29vZ2xlL2dlbWluaS0zLXByby1wcmV2aWV3XCIgfSxcblx0XHR7IHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIiwgaWQ6IFwia3dhaXBpbG90L2thdC1jb2Rlci1wcm9cIiB9LFxuXHRcdHsgcHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLCBpZDogXCJtZWl0dWFuL2xvbmdjYXQtZmxhc2gtdGhpbmtpbmdcIiB9LFxuXHRcdHsgcHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIiwgaWQ6IFwieGFpL2dyb2stMi12aXNpb25cIiB9LFxuXHRcdHsgcHJvdmlkZXI6IFwiYW50aHJvcGljXCIsIGlkOiBcImNsYXVkZS0zLTctc29ubmV0LWxhdGVzdFwiIH0sXG5cdFx0Ly8gR3JvcSBkZWNvbW1pc3Npb25lZCBtb2RlbHMgXHUyMDE0IGlzc3VlICM0MjU3XG5cdFx0eyBwcm92aWRlcjogXCJncm9xXCIsIGlkOiBcImxsYW1hMy03MGItODE5MlwiIH0sXG5cdFx0eyBwcm92aWRlcjogXCJncm9xXCIsIGlkOiBcImxsYW1hMy04Yi04MTkyXCIgfSxcblx0XHR7IHByb3ZpZGVyOiBcImdyb3FcIiwgaWQ6IFwiZGVlcHNlZWstcjEtZGlzdGlsbC1sbGFtYS03MGJcIiB9LFxuXHRcdHsgcHJvdmlkZXI6IFwiZ3JvcVwiLCBpZDogXCJnZW1tYTItOWItaXRcIiB9LFxuXHRcdHsgcHJvdmlkZXI6IFwiZ3JvcVwiLCBpZDogXCJtZXRhLWxsYW1hL2xsYW1hLTQtbWF2ZXJpY2stMTdiLTEyOGUtaW5zdHJ1Y3RcIiB9LFxuXHRcdHsgcHJvdmlkZXI6IFwiZ3JvcVwiLCBpZDogXCJtaXN0cmFsLXNhYmEtMjRiXCIgfSxcblx0XHR7IHByb3ZpZGVyOiBcImdyb3FcIiwgaWQ6IFwibW9vbnNob3RhaS9raW1pLWsyLWluc3RydWN0XCIgfSxcblx0XHR7IHByb3ZpZGVyOiBcImdyb3FcIiwgaWQ6IFwibW9vbnNob3RhaS9raW1pLWsyLWluc3RydWN0LTA5MDVcIiB9LFxuXHRcdHsgcHJvdmlkZXI6IFwiZ3JvcVwiLCBpZDogXCJxd2VuLXF3cS0zMmJcIiB9LFxuXHRdO1xuXG5cdGZvciAoY29uc3QgeyBwcm92aWRlciwgaWQgfSBvZiByZW1vdmVkTW9kZWxzKSB7XG5cdFx0aXQoYCR7cHJvdmlkZXJ9LyR7aWR9IGhhcyBiZWVuIHJlbW92ZWRgLCAoKSA9PiB7XG5cdFx0XHRjb25zdCBtb2RlbCA9IGdldE1vZGVsKHByb3ZpZGVyIGFzIGFueSwgaWQgYXMgYW55KTtcblx0XHRcdGFzc2VydC5lcXVhbChtb2RlbCwgdW5kZWZpbmVkLCBgJHtwcm92aWRlcn0vJHtpZH0gc2hvdWxkIGJlIHJlbW92ZWQgYnV0IGlzIHN0aWxsIHByZXNlbnRgKTtcblx0XHR9KTtcblx0fVxufSk7XG5cbi8vIFwiU3BvdC1jaGVja3MgZm9yIG1vZGVscyBhZGRlZCBpbiB0aGlzIHJlZ2VuZXJhdGlvblwiIHJlbW92ZWQgKCM0ODA0KS5cbi8vXG4vLyBUaGUgYmxvY2sgYXNzZXJ0ZWQgdGhhdCBhIGhhcmRjb2RlZCBsaXN0IG9mIDIxIG1vZGVsIElEcyB3YXMgcHJlc2VudFxuLy8gaW4gdGhlIHJlZ2lzdHJ5LiBFYWNoIGFzc2VydGlvbiByZWFkIGEgdmFsdWUgdGhlIGdlbmVyYXRvciBoYWQganVzdFxuLy8gd3JpdHRlbiwgc28gdGhlIHRlc3QgY291bGQgbm90IGRldGVjdCBhIGJyb2tlbiBnZW5lcmF0b3IgXHUyMDE0IGl0IG9ubHlcbi8vIHRyaXBwZWQgd2hlbiBzb21lb25lIGhhbmQtZWRpdGVkIHRoZSBzbmFwc2hvdC4gV29yc2UsIHRoZSBsaXN0IHdlbnRcbi8vIHN0YWxlIG9uIGV2ZXJ5IHJlZ2VuZXJhdGlvbiAoYWRkaW5nIGEgZnJlc2ggbGlzdCBpcyB0aGUgcmV2aWV3ZXInc1xuLy8gdGF4KSB3aXRob3V0IHByb3ZpZGluZyBhbnkgaW52YXJpYW50IHRoZSBzdHJ1Y3R1cmFsIHRlc3RzIGFib3ZlXG4vLyBkaWRuJ3QgYWxyZWFkeSBjb3Zlcjpcbi8vICAgLSBldmVyeSBpZCBtYXRjaGVzIGl0cyBrZXlcbi8vICAgLSBldmVyeSBtb2RlbCBoYXMgYSBwb3NpdGl2ZSBjb250ZXh0V2luZG93XG4vLyAgIC0gbm8gZHVwbGljYXRlIG1vZGVsIElEc1xuLy9cbi8vIElmIGEgc3BlY2lmaWMgbW9kZWwgY2FwYWJpbGl0eSBpcyBsb2FkLWJlYXJpbmcgZm9yIGEgZmVhdHVyZSwgdGhlXG4vLyBndWFyZCBmb3IgdGhhdCBjYXBhYmlsaXR5IGJlbG9uZ3MgaW4gdGhlIGZlYXR1cmUncyBvd24gdGVzdCBcdTIwMTQgbm90XG4vLyBpbiBhIFwiZGlkIHRoZSBnZW5lcmF0b3Igb3V0cHV0IHdoYXQgaXQgb3V0cHV0XCIgc25hcHNob3QuIFRoZVxuLy8gR1BULTUuNSBhdmFpbGFiaWxpdHkgdGVzdCBiZWxvdyBpcyBhbiBleGFtcGxlOiBpdCBhc3NlcnRzIGNvbmNyZXRlXG4vLyBwcmljaW5nL2NvbnRleHQtd2luZG93IHZhbHVlcyB0aGUgZmVhdHVyZSBkZXBlbmRzIG9uLlxuXG5kZXNjcmliZShcIkdQVC01LjUgYXZhaWxhYmlsaXR5XCIsICgpID0+IHtcblx0aXQoXCJleHBvc2VzIEdQVC01LjUgdGhyb3VnaCBPcGVuQUkgQVBJIGFuZCBPcGVuQUkgQ29kZXggcHJvdmlkZXJzXCIsICgpID0+IHtcblx0XHRjb25zdCBhcGlNb2RlbCA9IGdldE1vZGVsKFwib3BlbmFpXCIsIFwiZ3B0LTUuNVwiIGFzIGFueSk7XG5cdFx0YXNzZXJ0Lm9rKGFwaU1vZGVsLCBcIm9wZW5haS9ncHQtNS41IHNob3VsZCBiZSBwcmVzZW50XCIpO1xuXHRcdGFzc2VydC5lcXVhbChhcGlNb2RlbC5jb250ZXh0V2luZG93LCAxMDAwMDAwKTtcblx0XHRhc3NlcnQuZXF1YWwoYXBpTW9kZWwuY29zdC5pbnB1dCwgNSk7XG5cdFx0YXNzZXJ0LmVxdWFsKGFwaU1vZGVsLmNvc3Qub3V0cHV0LCAzMCk7XG5cblx0XHRjb25zdCBjb2RleE1vZGVsID0gZ2V0TW9kZWwoXCJvcGVuYWktY29kZXhcIiwgXCJncHQtNS41XCIgYXMgYW55KTtcblx0XHRhc3NlcnQub2soY29kZXhNb2RlbCwgXCJvcGVuYWktY29kZXgvZ3B0LTUuNSBzaG91bGQgYmUgcHJlc2VudFwiKTtcblx0XHRhc3NlcnQuZXF1YWwoY29kZXhNb2RlbC5jb250ZXh0V2luZG93LCA0MDAwMDApO1xuXHRcdGFzc2VydC5lcXVhbChjb2RleE1vZGVsLmNvc3QuaW5wdXQsIDUpO1xuXHRcdGFzc2VydC5lcXVhbChjb2RleE1vZGVsLmNvc3Qub3V0cHV0LCAzMCk7XG5cdH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxTQUFTLFVBQVUsVUFBVTtBQUM3QixPQUFPLFlBQVk7QUFDbkIsU0FBUyxRQUFRLFVBQVUsV0FBVyxvQkFBb0I7QUFNMUQsU0FBUyxzRUFBaUUsTUFBTTtBQUMvRSxLQUFHLG9EQUFvRCxN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
