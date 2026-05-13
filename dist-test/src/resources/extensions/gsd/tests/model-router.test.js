import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  resolveModelForComplexity,
  escalateTier,
  defaultRoutingConfig,
  resolveModelForTier,
  scoreModel,
  computeTaskRequirements,
  scoreEligibleModels,
  getEligibleModels,
  MODEL_CAPABILITY_PROFILES
} from "../model-router.js";
import { getLegacyTelemetry, resetLegacyTelemetry } from "../legacy-telemetry.js";
function makeClassification(tier, reason = "test") {
  return { tier, reason, downgraded: false };
}
const AVAILABLE_MODELS = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "gpt-4o-mini"
];
test("returns configured model when routing is disabled", () => {
  const config = { ...defaultRoutingConfig(), enabled: false };
  const result = resolveModelForComplexity(
    makeClassification("light"),
    { primary: "claude-opus-4-6", fallbacks: [] },
    config,
    AVAILABLE_MODELS
  );
  assert.equal(result.modelId, "claude-opus-4-6");
  assert.equal(result.wasDowngraded, false);
});
test("returns configured model when no phase config", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const result = resolveModelForComplexity(
    makeClassification("light"),
    void 0,
    config,
    AVAILABLE_MODELS
  );
  assert.equal(result.modelId, "");
  assert.equal(result.wasDowngraded, false);
});
test("does not downgrade when tier matches configured model tier", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const result = resolveModelForComplexity(
    makeClassification("heavy"),
    { primary: "claude-opus-4-6", fallbacks: [] },
    config,
    AVAILABLE_MODELS
  );
  assert.equal(result.modelId, "claude-opus-4-6");
  assert.equal(result.wasDowngraded, false);
});
test("does not upgrade beyond configured model", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const result = resolveModelForComplexity(
    makeClassification("heavy"),
    { primary: "claude-sonnet-4-6", fallbacks: [] },
    config,
    AVAILABLE_MODELS
  );
  assert.equal(result.modelId, "claude-sonnet-4-6");
  assert.equal(result.wasDowngraded, false);
});
test("downgrades from opus to haiku for light tier", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const result = resolveModelForComplexity(
    makeClassification("light"),
    { primary: "claude-opus-4-6", fallbacks: [] },
    config,
    AVAILABLE_MODELS
  );
  assert.ok(
    result.modelId === "claude-haiku-4-5" || result.modelId === "gpt-4o-mini",
    `Expected light-tier model, got ${result.modelId}`
  );
  assert.equal(result.wasDowngraded, true);
});
test("downgrades from opus to sonnet for standard tier", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const result = resolveModelForComplexity(
    makeClassification("standard"),
    { primary: "claude-opus-4-6", fallbacks: [] },
    config,
    AVAILABLE_MODELS
  );
  assert.equal(result.modelId, "claude-sonnet-4-6");
  assert.equal(result.wasDowngraded, true);
});
test("uses explicit tier_models when configured", () => {
  const config = {
    ...defaultRoutingConfig(),
    enabled: true,
    tier_models: { light: "gpt-4o-mini", standard: "claude-sonnet-4-6" }
  };
  const result = resolveModelForComplexity(
    makeClassification("light"),
    { primary: "claude-opus-4-6", fallbacks: [] },
    config,
    AVAILABLE_MODELS
  );
  assert.equal(result.modelId, "gpt-4o-mini");
  assert.equal(result.wasDowngraded, true);
});
test("preserves explicit provider-qualified tier_models when duplicate bare IDs exist", () => {
  const config = {
    ...defaultRoutingConfig(),
    enabled: true,
    capability_routing: false,
    tier_models: {
      light: "custom-openai/gpt-5.3-codex-spark",
      standard: "custom-openai/gpt-5.4"
    }
  };
  const providerModels = [
    "openai-codex/gpt-5.4",
    "custom-openai/gpt-5.4",
    "openai-codex/gpt-5.3-codex-spark",
    "custom-openai/gpt-5.3-codex-spark",
    "custom-anthropic/claude-opus-4-7"
  ];
  const standard = resolveModelForComplexity(
    makeClassification("standard"),
    { primary: "custom-anthropic/claude-opus-4-7", fallbacks: [] },
    config,
    providerModels
  );
  assert.equal(standard.modelId, "custom-openai/gpt-5.4");
  assert.equal(standard.wasDowngraded, true);
  const light = resolveModelForComplexity(
    makeClassification("light"),
    { primary: "custom-anthropic/claude-opus-4-7", fallbacks: [] },
    config,
    providerModels
  );
  assert.equal(light.modelId, "custom-openai/gpt-5.3-codex-spark");
  assert.equal(light.wasDowngraded, true);
});
test("fallback chain includes configured primary as last resort", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const result = resolveModelForComplexity(
    makeClassification("light"),
    { primary: "claude-opus-4-6", fallbacks: ["claude-sonnet-4-6"] },
    config,
    AVAILABLE_MODELS
  );
  assert.ok(result.wasDowngraded);
  assert.ok(result.fallbacks.includes("claude-opus-4-6"), "primary should be in fallbacks");
  assert.ok(result.fallbacks.includes("claude-sonnet-4-6"), "configured fallback should be in fallbacks");
});
test("escalateTier moves light \u2192 standard", () => {
  assert.equal(escalateTier("light"), "standard");
});
test("escalateTier moves standard \u2192 heavy", () => {
  assert.equal(escalateTier("standard"), "heavy");
});
test("escalateTier returns null for heavy (max)", () => {
  assert.equal(escalateTier("heavy"), null);
});
test("falls back to configured model when no light-tier model available", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const result = resolveModelForComplexity(
    makeClassification("light"),
    { primary: "claude-opus-4-6", fallbacks: [] },
    config,
    ["claude-opus-4-6"]
  );
  assert.equal(result.modelId, "claude-opus-4-6");
  assert.equal(result.wasDowngraded, false);
});
test("#2192: unknown model is not downgraded \u2014 respects user config", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const result = resolveModelForComplexity(
    makeClassification("light"),
    { primary: "some-future-unknown-model-v9", fallbacks: [] },
    config,
    ["some-future-unknown-model-v9", ...AVAILABLE_MODELS]
  );
  assert.equal(result.modelId, "some-future-unknown-model-v9", "unknown model should be used as-is");
  assert.equal(result.wasDowngraded, false, "should not be downgraded");
  assert.ok(result.reason.includes("not in the known tier map"), "reason should explain why");
});
test("#2192: unknown model with provider prefix is not downgraded", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const result = resolveModelForComplexity(
    makeClassification("standard"),
    { primary: "custom-provider/my-model-v3", fallbacks: [] },
    config,
    ["custom-provider/my-model-v3", ...AVAILABLE_MODELS]
  );
  assert.equal(result.modelId, "custom-provider/my-model-v3");
  assert.equal(result.wasDowngraded, false);
});
test("#2192: known model is still downgraded normally", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const result = resolveModelForComplexity(
    makeClassification("light"),
    { primary: "claude-opus-4-6", fallbacks: [] },
    config,
    AVAILABLE_MODELS
  );
  assert.equal(result.wasDowngraded, true, "known heavy model should still be downgraded for light tasks");
  assert.notEqual(result.modelId, "claude-opus-4-6");
});
test("uses cross-provider equivalent when configured primary is unavailable", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const result = resolveModelForComplexity(
    makeClassification("heavy"),
    { primary: "claude-opus-4-6", fallbacks: [] },
    config,
    ["gpt-4o", "gpt-4o-mini", "o1"]
  );
  assert.equal(result.modelId, "o1");
  assert.equal(result.wasDowngraded, false);
  assert.match(result.reason, /cross-provider/);
});
test("cross-provider: selects standard-tier equivalent when primary unavailable", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const result = resolveModelForComplexity(
    makeClassification("heavy"),
    { primary: "claude-opus-4-6", fallbacks: [] },
    config,
    ["gpt-4o", "gpt-4o-mini"]
  );
  assert.ok(result.modelId === "gpt-4o" || result.modelId === "claude-opus-4-6");
  assert.equal(result.wasDowngraded, false);
});
test("cross-provider: configured primary available by bare ID wins over equivalent", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const result = resolveModelForComplexity(
    makeClassification("heavy"),
    { primary: "claude-opus-4-6", fallbacks: [] },
    config,
    ["anthropic/claude-opus-4-6", "o1"]
  );
  assert.equal(result.modelId, "claude-opus-4-6");
  assert.equal(result.wasDowngraded, false);
});
test("resolveModelForTier: returns canonical Anthropic model when no available models", () => {
  try {
    resetLegacyTelemetry();
    assert.equal(resolveModelForTier("heavy", []), "claude-opus-4-6");
    assert.equal(resolveModelForTier("standard", []), "claude-sonnet-4-6");
    assert.equal(resolveModelForTier("light", []), "claude-haiku-4-5");
    assert.equal(getLegacyTelemetry()["legacy.providerDefaultUsed"], 3);
  } finally {
    resetLegacyTelemetry();
  }
});
test("resolveModelForTier: returns canonical model when it is available", () => {
  try {
    resetLegacyTelemetry();
    assert.equal(
      resolveModelForTier("heavy", ["claude-opus-4-6", "claude-sonnet-4-6"]),
      "claude-opus-4-6"
    );
    assert.equal(getLegacyTelemetry()["legacy.providerDefaultUsed"], 0);
  } finally {
    resetLegacyTelemetry();
  }
});
test("resolveModelForTier: does not prefer canonical over cheaper same-tier model", () => {
  const result = resolveModelForTier("light", ["claude-haiku-4-5", "gpt-4o-mini"]);
  assert.equal(result, "gpt-4o-mini");
});
test("resolveModelForTier: honors configured tier_models pins", () => {
  const config = {
    ...defaultRoutingConfig(),
    tier_models: { light: "claude-haiku-4-5" }
  };
  const result = resolveModelForTier("light", ["claude-haiku-4-5", "gpt-4o-mini"], config);
  assert.equal(result, "claude-haiku-4-5");
});
test("resolveModelForTier: picks cross-provider equivalent when Anthropic unavailable", () => {
  const result = resolveModelForTier("heavy", ["gpt-4o", "gpt-4o-mini", "o1"]);
  assert.equal(result, "o1");
});
test("resolveModelForTier: picks standard-tier cross-provider model", () => {
  const result = resolveModelForTier("standard", ["gpt-4o", "gpt-4o-mini"]);
  assert.equal(result, "gpt-4o");
});
test("resolveModelForTier: picks light-tier cross-provider model", () => {
  const result = resolveModelForTier("light", ["gpt-4o", "gpt-4o-mini"]);
  assert.equal(result, "gpt-4o-mini");
});
test("resolveModelForTier: falls back to canonical when no tier match available", () => {
  try {
    resetLegacyTelemetry();
    const result = resolveModelForTier("heavy", ["some-custom-model"]);
    assert.equal(result, "claude-opus-4-6");
    assert.equal(getLegacyTelemetry()["legacy.providerDefaultUsed"], 1);
  } finally {
    resetLegacyTelemetry();
  }
});
test("resolveModelForTier: handles provider-prefixed available models", () => {
  const result = resolveModelForTier("heavy", ["anthropic/claude-opus-4-6"]);
  assert.equal(result, "claude-opus-4-6");
});
test("resolveModelForTier: picks Gemini models when only Google available", () => {
  const result = resolveModelForTier("light", ["gemini-2.5-pro", "gemini-2.0-flash"]);
  assert.equal(result, "gemini-2.0-flash");
});
test("resolveProfileDefaults: balanced with only OpenAI models returns OpenAI IDs", async () => {
  const { resolveProfileDefaults } = await import("../preferences-models.js");
  const defaults = resolveProfileDefaults("balanced", ["gpt-4o", "gpt-4o-mini"]);
  assert.ok(defaults.models, "balanced should populate models");
  for (const [phase, modelId] of Object.entries(defaults.models)) {
    assert.ok(typeof modelId === "string" && modelId.length > 0, `${phase} should resolve to a model ID`);
    assert.ok(
      !String(modelId).startsWith("claude-"),
      `${phase} resolved to ${modelId} but no claude-* model is available \u2014 should be OpenAI`
    );
  }
});
test("resolveProfileDefaults: budget with only OpenAI models picks gpt-4o-mini for light slots", async () => {
  const { resolveProfileDefaults } = await import("../preferences-models.js");
  const defaults = resolveProfileDefaults("budget", ["gpt-4o", "gpt-4o-mini"]);
  assert.equal(defaults.models?.research, "gpt-4o-mini");
  assert.equal(defaults.models?.execution_simple, "gpt-4o-mini");
  assert.equal(defaults.models?.completion, "gpt-4o-mini");
  assert.equal(defaults.models?.subagent, "gpt-4o-mini");
  assert.equal(defaults.models?.planning, "gpt-4o");
  assert.equal(defaults.models?.execution, "gpt-4o");
});
test("resolveProfileDefaults: honors dynamic routing tier_models pins", async () => {
  const { resolveProfileDefaults } = await import("../preferences-models.js");
  const defaults = resolveProfileDefaults(
    "budget",
    ["claude-haiku-4-5", "gpt-4o-mini", "gpt-4o"],
    { ...defaultRoutingConfig(), tier_models: { light: "claude-haiku-4-5" } }
  );
  assert.equal(defaults.models?.research, "claude-haiku-4-5");
  assert.equal(defaults.models?.execution_simple, "claude-haiku-4-5");
  assert.equal(defaults.models?.completion, "claude-haiku-4-5");
  assert.equal(defaults.models?.subagent, "claude-haiku-4-5");
});
test("resolveProfileDefaults: empty availableModelIds falls back to canonical Anthropic IDs", async () => {
  const { resolveProfileDefaults } = await import("../preferences-models.js");
  const defaults = resolveProfileDefaults("balanced", []);
  const planningModel = defaults.models?.planning;
  assert.ok(typeof planningModel === "string" && planningModel.startsWith("claude-"));
});
test("resolveProfileDefaults: burn-max omits models so user choice is preserved", async () => {
  const { resolveProfileDefaults } = await import("../preferences-models.js");
  const defaults = resolveProfileDefaults("burn-max", ["gpt-4o"]);
  assert.equal(defaults.models, void 0, "burn-max must not write model defaults");
  assert.equal(defaults.dynamic_routing?.enabled, false);
});
test("defaultRoutingConfig includes capability_routing: true", () => {
  const config = defaultRoutingConfig();
  assert.equal(config.capability_routing, true);
});
test("scoreEligibleModels uses bare capability profiles for provider-qualified IDs", () => {
  const scored = scoreEligibleModels(
    ["custom-openai/gpt-5.4", "custom-openai/gpt-5.3-codex-spark"],
    { coding: 1 }
  );
  assert.equal(scored[0]?.modelId, "custom-openai/gpt-5.4");
  assert.ok(
    (scored[0]?.score ?? 0) > (scored[1]?.score ?? 0),
    "provider-qualified IDs should still use the built-in bare model capability profile"
  );
});
test("scoreModel computes weighted average of capability \xD7 requirement", () => {
  const caps = {
    coding: 90,
    debugging: 80,
    research: 70,
    reasoning: 85,
    speed: 50,
    longContext: 60,
    instruction: 75
  };
  const reqs = { coding: 0.9, reasoning: 0.5 };
  const score = scoreModel(caps, reqs);
  assert.ok(Math.abs(score - 88.21) < 0.1, `score ${score} should be ~88.21`);
});
test("computeTaskRequirements returns base vector for known unit type", () => {
  const reqs = computeTaskRequirements("execute-task");
  assert.ok(reqs.coding !== void 0 && reqs.coding > 0);
});
test("computeTaskRequirements boosts instruction for docs-tagged tasks", () => {
  const reqs = computeTaskRequirements("execute-task", { tags: ["docs"] });
  assert.ok((reqs.instruction ?? 0) >= 0.8);
  assert.ok((reqs.coding ?? 1) <= 0.4);
});
test("computeTaskRequirements returns generic vector for unknown unit type", () => {
  const reqs = computeTaskRequirements("unknown-unit");
  assert.ok(reqs.reasoning !== void 0);
});
test("resolveModelForComplexity uses capability scoring when enabled", () => {
  const config = {
    ...defaultRoutingConfig(),
    enabled: true,
    capability_routing: true
  };
  const result = resolveModelForComplexity(
    makeClassification("light"),
    { primary: "claude-opus-4-6", fallbacks: [] },
    config,
    ["claude-opus-4-6", "claude-haiku-4-5", "gpt-4o-mini"],
    "execute-task"
  );
  assert.equal(result.wasDowngraded, true);
  assert.equal(result.selectionMethod, "capability-scored");
});
test("resolveModelForComplexity falls back to tier-only when capability_routing is false", () => {
  const config = {
    ...defaultRoutingConfig(),
    enabled: true,
    capability_routing: false
  };
  const result = resolveModelForComplexity(
    makeClassification("light"),
    { primary: "claude-opus-4-6", fallbacks: [] },
    config,
    ["claude-opus-4-6", "claude-haiku-4-5", "gpt-4o-mini"]
  );
  assert.equal(result.wasDowngraded, true);
  assert.ok(!result.selectionMethod || result.selectionMethod === "tier-only");
});
test("MODEL_CAPABILITY_PROFILES has entries for all tier-mapped models", () => {
  const profiledModels = Object.keys(MODEL_CAPABILITY_PROFILES);
  assert.ok(profiledModels.length >= 30, `Expected \u226530 profiles, got ${profiledModels.length}`);
  assert.ok(MODEL_CAPABILITY_PROFILES["claude-opus-4-6"]);
  assert.ok(MODEL_CAPABILITY_PROFILES["claude-haiku-4-5"]);
});
test("#2885: openai-codex light-tier models are recognized", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const lightModels = ["gpt-4.1-mini", "gpt-4.1-nano", "gpt-5-mini", "gpt-5-nano", "gpt-5.1-codex-mini", "gpt-5.3-codex-spark", "gpt-5.4-mini"];
  for (const model of lightModels) {
    const result = resolveModelForComplexity(
      makeClassification("light"),
      { primary: model, fallbacks: [] },
      config,
      [model, ...AVAILABLE_MODELS]
    );
    assert.equal(result.wasDowngraded, false, `${model} should be known as light tier (wasDowngraded)`);
    assert.equal(result.modelId, model, `${model} should be returned as-is for light tier`);
    assert.ok(!result.reason.includes("not in the known tier map"), `${model} should be in the known tier map`);
  }
});
test("#2885: openai-codex standard-tier models are recognized", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const standardModels = ["gpt-4.1", "gpt-5.1-codex-max"];
  for (const model of standardModels) {
    const result = resolveModelForComplexity(
      makeClassification("standard"),
      { primary: model, fallbacks: [] },
      config,
      [model, ...AVAILABLE_MODELS]
    );
    assert.equal(result.wasDowngraded, false, `${model} should be known as standard tier`);
    assert.equal(result.modelId, model, `${model} should be returned as-is for standard tier`);
    assert.ok(!result.reason.includes("not in the known tier map"), `${model} should be in the known tier map`);
  }
});
test("#2885: openai-codex heavy-tier models are recognized", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const heavyModels = ["gpt-5", "gpt-5-pro", "gpt-5.1", "gpt-5.2", "gpt-5.2-codex", "gpt-5.3-codex", "gpt-5.4", "gpt-5.5", "o4-mini", "o4-mini-deep-research"];
  for (const model of heavyModels) {
    const result = resolveModelForComplexity(
      makeClassification("heavy"),
      { primary: model, fallbacks: [] },
      config,
      [model, ...AVAILABLE_MODELS]
    );
    assert.equal(result.wasDowngraded, false, `${model} should be known as heavy tier`);
    assert.equal(result.modelId, model, `${model} should be returned as-is for heavy tier`);
    assert.ok(!result.reason.includes("not in the known tier map"), `${model} should be in the known tier map`);
  }
});
test("#2885: heavy openai-codex model downgrades to light for light task", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const result = resolveModelForComplexity(
    makeClassification("light"),
    { primary: "gpt-5.4", fallbacks: [] },
    config,
    ["gpt-5.4", "gpt-4.1-nano", ...AVAILABLE_MODELS]
  );
  assert.equal(result.wasDowngraded, true, "heavy model should downgrade for light task");
  assert.notEqual(result.modelId, "gpt-5.4", "should not use the heavy model for light task");
});
describe("scoreModel", () => {
  const sonnetProfile = MODEL_CAPABILITY_PROFILES["claude-sonnet-4-6"];
  test("produces correct weighted average for two dimensions (coding:0.9, instruction:0.7)", () => {
    const score = scoreModel(sonnetProfile, { coding: 0.9, instruction: 0.7 });
    assert.ok(Math.abs(score - 85) < 0.01, `Expected ~85.0, got ${score}`);
  });
  test("returns 50 when requirements is empty", () => {
    const score = scoreModel(sonnetProfile, {});
    assert.equal(score, 50);
  });
  test("returns correct score for single dimension coding:1.0", () => {
    const opusProfile = MODEL_CAPABILITY_PROFILES["claude-opus-4-6"];
    const score = scoreModel(opusProfile, { coding: 1 });
    assert.equal(score, 95);
  });
  test("handles all 7 dimensions correctly", () => {
    const profile = {
      coding: 60,
      debugging: 60,
      research: 60,
      reasoning: 60,
      speed: 60,
      longContext: 60,
      instruction: 60
    };
    const reqs = {
      coding: 1,
      debugging: 1,
      research: 1,
      reasoning: 1,
      speed: 1,
      longContext: 1,
      instruction: 1
    };
    const score = scoreModel(profile, reqs);
    assert.equal(score, 60);
  });
});
describe("computeTaskRequirements", () => {
  test("execute-task with no metadata returns base vector", () => {
    const req = computeTaskRequirements("execute-task", void 0);
    assert.deepStrictEqual(req, { coding: 0.9, instruction: 0.7, speed: 0.3 });
  });
  test("execute-task with tags:['docs'] adjusts requirements", () => {
    const req = computeTaskRequirements("execute-task", { tags: ["docs"] });
    assert.equal(req.instruction, 0.9);
    assert.equal(req.coding, 0.3);
    assert.equal(req.speed, 0.7);
  });
  test("execute-task with tags:['config'] adjusts requirements", () => {
    const req = computeTaskRequirements("execute-task", { tags: ["config"] });
    assert.equal(req.instruction, 0.9);
  });
  test("execute-task with complexityKeywords:['concurrency'] boosts debugging and reasoning", () => {
    const req = computeTaskRequirements("execute-task", { complexityKeywords: ["concurrency"] });
    assert.equal(req.debugging, 0.9);
    assert.equal(req.reasoning, 0.8);
  });
  test("execute-task with complexityKeywords:['migration'] boosts reasoning and coding", () => {
    const req = computeTaskRequirements("execute-task", { complexityKeywords: ["migration"] });
    assert.equal(req.reasoning, 0.9);
    assert.equal(req.coding, 0.8);
  });
  test("execute-task with fileCount:8 boosts coding and reasoning", () => {
    const req = computeTaskRequirements("execute-task", { fileCount: 8 });
    assert.equal(req.coding, 0.9);
    assert.equal(req.reasoning, 0.7);
  });
  test("execute-task with estimatedLines:600 boosts coding and reasoning", () => {
    const req = computeTaskRequirements("execute-task", { estimatedLines: 600 });
    assert.equal(req.coding, 0.9);
    assert.equal(req.reasoning, 0.7);
  });
  test("research-milestone returns correct base vector", () => {
    const req = computeTaskRequirements("research-milestone");
    assert.deepStrictEqual(req, { research: 0.9, longContext: 0.7, reasoning: 0.5 });
  });
  test("plan-slice returns correct base vector", () => {
    const req = computeTaskRequirements("plan-slice");
    assert.deepStrictEqual(req, { reasoning: 0.9, coding: 0.5 });
  });
  test("unknown-unit-type returns default reasoning requirement", () => {
    const req = computeTaskRequirements("unknown-unit-type");
    assert.deepStrictEqual(req, { reasoning: 0.5 });
  });
  test("non-execute-task with metadata ignores metadata refinements", () => {
    const reqWithMeta = computeTaskRequirements("research-milestone", { tags: ["docs"], fileCount: 10 });
    const reqWithout = computeTaskRequirements("research-milestone");
    assert.deepStrictEqual(reqWithMeta, reqWithout);
  });
});
describe("scoreEligibleModels", () => {
  test("ranks models by score descending when scores differ by more than 2", () => {
    const requirements = { research: 0.9, longContext: 0.7, reasoning: 0.5 };
    const results = scoreEligibleModels(["claude-sonnet-4-6", "gemini-2.5-pro"], requirements);
    assert.equal(results.length, 2);
    assert.ok(results[0].score >= results[1].score, "Should be sorted by score descending");
  });
  test("within 2-point threshold, prefers cheaper model", () => {
    const requirements = { coding: 1 };
    const results = scoreEligibleModels(["model-z", "model-a"], requirements);
    assert.equal(results[0].modelId, "model-a");
  });
  test("single model returns array of one", () => {
    const results = scoreEligibleModels(["claude-sonnet-4-6"], { coding: 0.9 });
    assert.equal(results.length, 1);
    assert.equal(results[0].modelId, "claude-sonnet-4-6");
  });
  test("unknown model with no profile gets score of 50", () => {
    const results = scoreEligibleModels(["totally-unknown-model"], { coding: 1 });
    assert.equal(results[0].score, 50);
  });
  test("capabilityOverrides deep-merges with built-in profile", () => {
    const requirements = { coding: 1 };
    const results = scoreEligibleModels(
      ["claude-sonnet-4-6", "gpt-4o"],
      requirements,
      { "claude-sonnet-4-6": { coding: 30 } }
    );
    assert.equal(results[0].modelId, "gpt-4o", "gpt-4o should rank first after coding override");
  });
});
describe("getEligibleModels", () => {
  const ALL_MODELS = [
    "claude-opus-4-6",
    // heavy
    "claude-sonnet-4-6",
    // standard
    "claude-haiku-4-5",
    // light
    "gpt-4o-mini",
    // light
    "gpt-4o"
    // standard
  ];
  test("returns light-tier models from available list sorted by cost", () => {
    const config = defaultRoutingConfig();
    const result = getEligibleModels("light", ALL_MODELS, config);
    assert.ok(result.length >= 1);
    for (const id of result) {
      assert.ok(
        ["claude-haiku-4-5", "gpt-4o-mini"].includes(id),
        `Expected light-tier model, got ${id}`
      );
    }
  });
  test("returns standard-tier models from available list sorted by cost", () => {
    const config = defaultRoutingConfig();
    const result = getEligibleModels("standard", ALL_MODELS, config);
    assert.ok(result.length >= 1);
    for (const id of result) {
      assert.ok(
        ["claude-sonnet-4-6", "gpt-4o"].includes(id),
        `Expected standard-tier model, got ${id}`
      );
    }
  });
  test("tier_models pinned model returns single-element array", () => {
    const config = {
      ...defaultRoutingConfig(),
      tier_models: { light: "gpt-4o-mini" }
    };
    const result = getEligibleModels("light", ALL_MODELS, config);
    assert.deepStrictEqual(result, ["gpt-4o-mini"]);
  });
  test("empty available list returns empty array", () => {
    const config = defaultRoutingConfig();
    const result = getEligibleModels("light", [], config);
    assert.equal(result.length, 0);
  });
  test("unknown models classified as standard appear in standard tier results", () => {
    const config = defaultRoutingConfig();
    const result = getEligibleModels("standard", ["unknown-model-xyz"], config);
    assert.ok(result.includes("unknown-model-xyz"), "Unknown model should appear in standard tier");
  });
});
describe("capability-aware routing integration", () => {
  const MULTI_MODEL_AVAILABLE = [
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "gpt-4o",
    "gemini-2.5-pro",
    "claude-haiku-4-5",
    "gpt-4o-mini"
  ];
  test("full pipeline with capability_routing: true returns capability-scored decision", () => {
    const config = { ...defaultRoutingConfig(), enabled: true, capability_routing: true };
    const result = resolveModelForComplexity(
      { tier: "standard", reason: "test", downgraded: false },
      { primary: "claude-opus-4-6", fallbacks: [] },
      config,
      MULTI_MODEL_AVAILABLE,
      "execute-task",
      { tags: [], complexityKeywords: [], fileCount: 3, estimatedLines: 100, codeBlockCount: 0 }
    );
    assert.equal(result.selectionMethod, "capability-scored", "should use capability scoring when enabled with multiple eligible models");
    assert.ok(result.capabilityScores !== void 0, "capabilityScores should be populated");
    assert.ok(Object.keys(result.capabilityScores).length > 1, "should have scores for multiple models");
    assert.equal(result.wasDowngraded, true, "should be downgraded from opus");
  });
  test("capability_routing: false skips scoring and uses tier-only", () => {
    const config = { ...defaultRoutingConfig(), enabled: true, capability_routing: false };
    const result = resolveModelForComplexity(
      { tier: "standard", reason: "test", downgraded: false },
      { primary: "claude-opus-4-6", fallbacks: [] },
      config,
      MULTI_MODEL_AVAILABLE,
      "execute-task",
      void 0
    );
    assert.equal(result.selectionMethod, "tier-only", "capability_routing: false should use tier-only");
    assert.equal(result.capabilityScores, void 0, "capabilityScores should be undefined for tier-only");
  });
  test("single eligible model skips capability scoring and uses tier-only", () => {
    const config = {
      ...defaultRoutingConfig(),
      enabled: true,
      capability_routing: true,
      tier_models: { standard: "claude-sonnet-4-6" }
    };
    const result = resolveModelForComplexity(
      { tier: "standard", reason: "test", downgraded: false },
      { primary: "claude-opus-4-6", fallbacks: [] },
      config,
      MULTI_MODEL_AVAILABLE,
      "execute-task",
      void 0
    );
    assert.equal(result.selectionMethod, "tier-only", "single eligible model should use tier-only");
    assert.equal(result.modelId, "claude-sonnet-4-6", "should use the pinned model");
  });
  test("unknown model with no profile gets uniform score of 50 and can compete", () => {
    const unknownModel = "unknown-future-model-xyz";
    const config = { ...defaultRoutingConfig(), enabled: true, capability_routing: true };
    const requirements = { coding: 0.9, instruction: 0.7, speed: 0.3 };
    const scored = scoreEligibleModels([unknownModel, "claude-sonnet-4-6"], requirements);
    const unknownEntry = scored.find((s) => s.modelId === unknownModel);
    assert.ok(unknownEntry !== void 0, "unknown model should be in scored results");
    assert.ok(Math.abs(unknownEntry.score - 50) < 0.01, `expected score ~50, got ${unknownEntry.score}`);
  });
  test("capabilityOverrides boost a model above another for same task", () => {
    const requirements = { coding: 1 };
    const overrides = { "gpt-4o": { coding: 99 } };
    const scored = scoreEligibleModels(["claude-sonnet-4-6", "gpt-4o"], requirements, overrides);
    assert.equal(scored[0].modelId, "gpt-4o", "overridden model should win for coding-heavy task");
    assert.ok(scored[0].score > 90, `expected score > 90 after override, got ${scored[0].score}`);
  });
  test("resolveModelForComplexity passes capabilityOverrides to scoring step", () => {
    const config = { ...defaultRoutingConfig(), enabled: true, capability_routing: true };
    const overrides = { "gpt-4o": { coding: 99 } };
    const result = resolveModelForComplexity(
      { tier: "standard", reason: "test", downgraded: false },
      { primary: "claude-opus-4-6", fallbacks: [] },
      config,
      ["claude-opus-4-6", "claude-sonnet-4-6", "gpt-4o"],
      "execute-task",
      void 0,
      overrides
    );
    assert.equal(result.selectionMethod, "capability-scored");
    assert.equal(result.modelId, "gpt-4o", "gpt-4o should win with coding override");
  });
  test("regression: routing-disabled passthrough still returns tier-only", () => {
    const config = { ...defaultRoutingConfig(), enabled: false };
    const result = resolveModelForComplexity(
      { tier: "light", reason: "test", downgraded: false },
      { primary: "claude-opus-4-6", fallbacks: [] },
      config,
      MULTI_MODEL_AVAILABLE,
      "execute-task",
      void 0
    );
    assert.equal(result.selectionMethod, "tier-only");
    assert.equal(result.wasDowngraded, false);
    assert.equal(result.modelId, "claude-opus-4-6");
  });
  test("regression: unknown-model bypass returns tier-only and does not downgrade", () => {
    const config = { ...defaultRoutingConfig(), enabled: true };
    const result = resolveModelForComplexity(
      { tier: "light", reason: "test", downgraded: false },
      { primary: "totally-unknown-custom-model", fallbacks: [] },
      config,
      ["totally-unknown-custom-model", ...MULTI_MODEL_AVAILABLE],
      "execute-task",
      void 0
    );
    assert.equal(result.selectionMethod, "tier-only");
    assert.equal(result.wasDowngraded, false);
    assert.equal(result.modelId, "totally-unknown-custom-model");
  });
  test("regression: no-downgrade-needed path returns tier-only", () => {
    const config = { ...defaultRoutingConfig(), enabled: true, capability_routing: true };
    const result = resolveModelForComplexity(
      { tier: "standard", reason: "test", downgraded: false },
      { primary: "claude-sonnet-4-6", fallbacks: [] },
      config,
      MULTI_MODEL_AVAILABLE,
      "execute-task",
      void 0
    );
    assert.equal(result.selectionMethod, "tier-only");
    assert.equal(result.wasDowngraded, false);
    assert.equal(result.modelId, "claude-sonnet-4-6");
  });
});
describe("getModelTier unknown default", () => {
  test("unknown model returns standard tier (not heavy) via downgrade behavior", () => {
    const config = { ...defaultRoutingConfig(), enabled: true };
    const result = resolveModelForComplexity(
      makeClassification("standard"),
      { primary: "claude-sonnet-4-6", fallbacks: [] },
      config,
      ["claude-sonnet-4-6", "claude-haiku-4-5", "gpt-4o-mini"]
    );
    assert.equal(result.wasDowngraded, false, "standard model should not downgrade for standard task");
    assert.equal(result.modelId, "claude-sonnet-4-6");
  });
  test("unknown model in getEligibleModels defaults to standard tier", () => {
    const config = defaultRoutingConfig();
    const standardModels = getEligibleModels("standard", ["totally-unknown-model-abc"], config);
    const lightModels = getEligibleModels("light", ["totally-unknown-model-abc"], config);
    const heavyModels = getEligibleModels("heavy", ["totally-unknown-model-abc"], config);
    assert.ok(standardModels.includes("totally-unknown-model-abc"), "Unknown model should be in standard tier");
    assert.equal(lightModels.length, 0, "Unknown model should NOT be in light tier");
    assert.equal(heavyModels.length, 0, "Unknown model should NOT be in heavy tier");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9tb2RlbC1yb3V0ZXIudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IFZlcmlmaWVzIG1vZGVsIHJvdXRpbmcgZGVjaXNpb25zIGFuZCBsZWdhY3kgcHJvdmlkZXItZGVmYXVsdCB0ZWxlbWV0cnkuXG5pbXBvcnQgdGVzdCwgeyBkZXNjcmliZSB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuXG5pbXBvcnQge1xuICByZXNvbHZlTW9kZWxGb3JDb21wbGV4aXR5LFxuICBlc2NhbGF0ZVRpZXIsXG4gIGRlZmF1bHRSb3V0aW5nQ29uZmlnLFxuICByZXNvbHZlTW9kZWxGb3JUaWVyLFxuICBzY29yZU1vZGVsLFxuICBjb21wdXRlVGFza1JlcXVpcmVtZW50cyxcbiAgc2NvcmVFbGlnaWJsZU1vZGVscyxcbiAgZ2V0RWxpZ2libGVNb2RlbHMsXG4gIE1PREVMX0NBUEFCSUxJVFlfUFJPRklMRVMsXG59IGZyb20gXCIuLi9tb2RlbC1yb3V0ZXIuanNcIjtcbmltcG9ydCB0eXBlIHsgRHluYW1pY1JvdXRpbmdDb25maWcsIFJvdXRpbmdEZWNpc2lvbiwgTW9kZWxDYXBhYmlsaXRpZXMgfSBmcm9tIFwiLi4vbW9kZWwtcm91dGVyLmpzXCI7XG5pbXBvcnQgdHlwZSB7IENsYXNzaWZpY2F0aW9uUmVzdWx0IH0gZnJvbSBcIi4uL2NvbXBsZXhpdHktY2xhc3NpZmllci5qc1wiO1xuaW1wb3J0IHsgZ2V0TGVnYWN5VGVsZW1ldHJ5LCByZXNldExlZ2FjeVRlbGVtZXRyeSB9IGZyb20gXCIuLi9sZWdhY3ktdGVsZW1ldHJ5LmpzXCI7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBIZWxwZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBtYWtlQ2xhc3NpZmljYXRpb24odGllcjogXCJsaWdodFwiIHwgXCJzdGFuZGFyZFwiIHwgXCJoZWF2eVwiLCByZWFzb24gPSBcInRlc3RcIik6IENsYXNzaWZpY2F0aW9uUmVzdWx0IHtcbiAgcmV0dXJuIHsgdGllciwgcmVhc29uLCBkb3duZ3JhZGVkOiBmYWxzZSB9O1xufVxuXG5jb25zdCBBVkFJTEFCTEVfTU9ERUxTID0gW1xuICBcImNsYXVkZS1vcHVzLTQtNlwiLFxuICBcImNsYXVkZS1zb25uZXQtNC02XCIsXG4gIFwiY2xhdWRlLWhhaWt1LTQtNVwiLFxuICBcImdwdC00by1taW5pXCIsXG5dO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUGFzc3Rocm91Z2ggd2hlbiBkaXNhYmxlZCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcInJldHVybnMgY29uZmlndXJlZCBtb2RlbCB3aGVuIHJvdXRpbmcgaXMgZGlzYWJsZWRcIiwgKCkgPT4ge1xuICBjb25zdCBjb25maWcgPSB7IC4uLmRlZmF1bHRSb3V0aW5nQ29uZmlnKCksIGVuYWJsZWQ6IGZhbHNlIH07XG4gIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVNb2RlbEZvckNvbXBsZXhpdHkoXG4gICAgbWFrZUNsYXNzaWZpY2F0aW9uKFwibGlnaHRcIiksXG4gICAgeyBwcmltYXJ5OiBcImNsYXVkZS1vcHVzLTQtNlwiLCBmYWxsYmFja3M6IFtdIH0sXG4gICAgY29uZmlnLFxuICAgIEFWQUlMQUJMRV9NT0RFTFMsXG4gICk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQubW9kZWxJZCwgXCJjbGF1ZGUtb3B1cy00LTZcIik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQud2FzRG93bmdyYWRlZCwgZmFsc2UpO1xufSk7XG5cbnRlc3QoXCJyZXR1cm5zIGNvbmZpZ3VyZWQgbW9kZWwgd2hlbiBubyBwaGFzZSBjb25maWdcIiwgKCkgPT4ge1xuICBjb25zdCBjb25maWcgPSB7IC4uLmRlZmF1bHRSb3V0aW5nQ29uZmlnKCksIGVuYWJsZWQ6IHRydWUgfTtcbiAgY29uc3QgcmVzdWx0ID0gcmVzb2x2ZU1vZGVsRm9yQ29tcGxleGl0eShcbiAgICBtYWtlQ2xhc3NpZmljYXRpb24oXCJsaWdodFwiKSxcbiAgICB1bmRlZmluZWQsXG4gICAgY29uZmlnLFxuICAgIEFWQUlMQUJMRV9NT0RFTFMsXG4gICk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQubW9kZWxJZCwgXCJcIik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQud2FzRG93bmdyYWRlZCwgZmFsc2UpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBEb3duZ3JhZGUtb25seSBzZW1hbnRpY3MgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJkb2VzIG5vdCBkb3duZ3JhZGUgd2hlbiB0aWVyIG1hdGNoZXMgY29uZmlndXJlZCBtb2RlbCB0aWVyXCIsICgpID0+IHtcbiAgY29uc3QgY29uZmlnID0geyAuLi5kZWZhdWx0Um91dGluZ0NvbmZpZygpLCBlbmFibGVkOiB0cnVlIH07XG4gIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVNb2RlbEZvckNvbXBsZXhpdHkoXG4gICAgbWFrZUNsYXNzaWZpY2F0aW9uKFwiaGVhdnlcIiksXG4gICAgeyBwcmltYXJ5OiBcImNsYXVkZS1vcHVzLTQtNlwiLCBmYWxsYmFja3M6IFtdIH0sXG4gICAgY29uZmlnLFxuICAgIEFWQUlMQUJMRV9NT0RFTFMsXG4gICk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQubW9kZWxJZCwgXCJjbGF1ZGUtb3B1cy00LTZcIik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQud2FzRG93bmdyYWRlZCwgZmFsc2UpO1xufSk7XG5cbnRlc3QoXCJkb2VzIG5vdCB1cGdyYWRlIGJleW9uZCBjb25maWd1cmVkIG1vZGVsXCIsICgpID0+IHtcbiAgY29uc3QgY29uZmlnID0geyAuLi5kZWZhdWx0Um91dGluZ0NvbmZpZygpLCBlbmFibGVkOiB0cnVlIH07XG4gIC8vIENvbmZpZ3VyZWQgbW9kZWwgaXMgc29ubmV0IChzdGFuZGFyZCksIGNsYXNzaWZpY2F0aW9uIHNheXMgaGVhdnlcbiAgY29uc3QgcmVzdWx0ID0gcmVzb2x2ZU1vZGVsRm9yQ29tcGxleGl0eShcbiAgICBtYWtlQ2xhc3NpZmljYXRpb24oXCJoZWF2eVwiKSxcbiAgICB7IHByaW1hcnk6IFwiY2xhdWRlLXNvbm5ldC00LTZcIiwgZmFsbGJhY2tzOiBbXSB9LFxuICAgIGNvbmZpZyxcbiAgICBBVkFJTEFCTEVfTU9ERUxTLFxuICApO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0Lm1vZGVsSWQsIFwiY2xhdWRlLXNvbm5ldC00LTZcIik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQud2FzRG93bmdyYWRlZCwgZmFsc2UpO1xufSk7XG5cbnRlc3QoXCJkb3duZ3JhZGVzIGZyb20gb3B1cyB0byBoYWlrdSBmb3IgbGlnaHQgdGllclwiLCAoKSA9PiB7XG4gIGNvbnN0IGNvbmZpZyA9IHsgLi4uZGVmYXVsdFJvdXRpbmdDb25maWcoKSwgZW5hYmxlZDogdHJ1ZSB9O1xuICBjb25zdCByZXN1bHQgPSByZXNvbHZlTW9kZWxGb3JDb21wbGV4aXR5KFxuICAgIG1ha2VDbGFzc2lmaWNhdGlvbihcImxpZ2h0XCIpLFxuICAgIHsgcHJpbWFyeTogXCJjbGF1ZGUtb3B1cy00LTZcIiwgZmFsbGJhY2tzOiBbXSB9LFxuICAgIGNvbmZpZyxcbiAgICBBVkFJTEFCTEVfTU9ERUxTLFxuICApO1xuICAvLyBTaG91bGQgcGljayBoYWlrdSBvciBncHQtNG8tbWluaSAoY2hlYXBlc3QgbGlnaHQgdGllcilcbiAgYXNzZXJ0Lm9rKFxuICAgIHJlc3VsdC5tb2RlbElkID09PSBcImNsYXVkZS1oYWlrdS00LTVcIiB8fCByZXN1bHQubW9kZWxJZCA9PT0gXCJncHQtNG8tbWluaVwiLFxuICAgIGBFeHBlY3RlZCBsaWdodC10aWVyIG1vZGVsLCBnb3QgJHtyZXN1bHQubW9kZWxJZH1gLFxuICApO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0Lndhc0Rvd25ncmFkZWQsIHRydWUpO1xufSk7XG5cbnRlc3QoXCJkb3duZ3JhZGVzIGZyb20gb3B1cyB0byBzb25uZXQgZm9yIHN0YW5kYXJkIHRpZXJcIiwgKCkgPT4ge1xuICBjb25zdCBjb25maWcgPSB7IC4uLmRlZmF1bHRSb3V0aW5nQ29uZmlnKCksIGVuYWJsZWQ6IHRydWUgfTtcbiAgY29uc3QgcmVzdWx0ID0gcmVzb2x2ZU1vZGVsRm9yQ29tcGxleGl0eShcbiAgICBtYWtlQ2xhc3NpZmljYXRpb24oXCJzdGFuZGFyZFwiKSxcbiAgICB7IHByaW1hcnk6IFwiY2xhdWRlLW9wdXMtNC02XCIsIGZhbGxiYWNrczogW10gfSxcbiAgICBjb25maWcsXG4gICAgQVZBSUxBQkxFX01PREVMUyxcbiAgKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5tb2RlbElkLCBcImNsYXVkZS1zb25uZXQtNC02XCIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0Lndhc0Rvd25ncmFkZWQsIHRydWUpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBFeHBsaWNpdCB0aWVyX21vZGVscyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcInVzZXMgZXhwbGljaXQgdGllcl9tb2RlbHMgd2hlbiBjb25maWd1cmVkXCIsICgpID0+IHtcbiAgY29uc3QgY29uZmlnOiBEeW5hbWljUm91dGluZ0NvbmZpZyA9IHtcbiAgICAuLi5kZWZhdWx0Um91dGluZ0NvbmZpZygpLFxuICAgIGVuYWJsZWQ6IHRydWUsXG4gICAgdGllcl9tb2RlbHM6IHsgbGlnaHQ6IFwiZ3B0LTRvLW1pbmlcIiwgc3RhbmRhcmQ6IFwiY2xhdWRlLXNvbm5ldC00LTZcIiB9LFxuICB9O1xuICBjb25zdCByZXN1bHQgPSByZXNvbHZlTW9kZWxGb3JDb21wbGV4aXR5KFxuICAgIG1ha2VDbGFzc2lmaWNhdGlvbihcImxpZ2h0XCIpLFxuICAgIHsgcHJpbWFyeTogXCJjbGF1ZGUtb3B1cy00LTZcIiwgZmFsbGJhY2tzOiBbXSB9LFxuICAgIGNvbmZpZyxcbiAgICBBVkFJTEFCTEVfTU9ERUxTLFxuICApO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0Lm1vZGVsSWQsIFwiZ3B0LTRvLW1pbmlcIik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQud2FzRG93bmdyYWRlZCwgdHJ1ZSk7XG59KTtcblxudGVzdChcInByZXNlcnZlcyBleHBsaWNpdCBwcm92aWRlci1xdWFsaWZpZWQgdGllcl9tb2RlbHMgd2hlbiBkdXBsaWNhdGUgYmFyZSBJRHMgZXhpc3RcIiwgKCkgPT4ge1xuICBjb25zdCBjb25maWc6IER5bmFtaWNSb3V0aW5nQ29uZmlnID0ge1xuICAgIC4uLmRlZmF1bHRSb3V0aW5nQ29uZmlnKCksXG4gICAgZW5hYmxlZDogdHJ1ZSxcbiAgICBjYXBhYmlsaXR5X3JvdXRpbmc6IGZhbHNlLFxuICAgIHRpZXJfbW9kZWxzOiB7XG4gICAgICBsaWdodDogXCJjdXN0b20tb3BlbmFpL2dwdC01LjMtY29kZXgtc3BhcmtcIixcbiAgICAgIHN0YW5kYXJkOiBcImN1c3RvbS1vcGVuYWkvZ3B0LTUuNFwiLFxuICAgIH0sXG4gIH07XG4gIGNvbnN0IHByb3ZpZGVyTW9kZWxzID0gW1xuICAgIFwib3BlbmFpLWNvZGV4L2dwdC01LjRcIixcbiAgICBcImN1c3RvbS1vcGVuYWkvZ3B0LTUuNFwiLFxuICAgIFwib3BlbmFpLWNvZGV4L2dwdC01LjMtY29kZXgtc3BhcmtcIixcbiAgICBcImN1c3RvbS1vcGVuYWkvZ3B0LTUuMy1jb2RleC1zcGFya1wiLFxuICAgIFwiY3VzdG9tLWFudGhyb3BpYy9jbGF1ZGUtb3B1cy00LTdcIixcbiAgXTtcblxuICBjb25zdCBzdGFuZGFyZCA9IHJlc29sdmVNb2RlbEZvckNvbXBsZXhpdHkoXG4gICAgbWFrZUNsYXNzaWZpY2F0aW9uKFwic3RhbmRhcmRcIiksXG4gICAgeyBwcmltYXJ5OiBcImN1c3RvbS1hbnRocm9waWMvY2xhdWRlLW9wdXMtNC03XCIsIGZhbGxiYWNrczogW10gfSxcbiAgICBjb25maWcsXG4gICAgcHJvdmlkZXJNb2RlbHMsXG4gICk7XG4gIGFzc2VydC5lcXVhbChzdGFuZGFyZC5tb2RlbElkLCBcImN1c3RvbS1vcGVuYWkvZ3B0LTUuNFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHN0YW5kYXJkLndhc0Rvd25ncmFkZWQsIHRydWUpO1xuXG4gIGNvbnN0IGxpZ2h0ID0gcmVzb2x2ZU1vZGVsRm9yQ29tcGxleGl0eShcbiAgICBtYWtlQ2xhc3NpZmljYXRpb24oXCJsaWdodFwiKSxcbiAgICB7IHByaW1hcnk6IFwiY3VzdG9tLWFudGhyb3BpYy9jbGF1ZGUtb3B1cy00LTdcIiwgZmFsbGJhY2tzOiBbXSB9LFxuICAgIGNvbmZpZyxcbiAgICBwcm92aWRlck1vZGVscyxcbiAgKTtcbiAgYXNzZXJ0LmVxdWFsKGxpZ2h0Lm1vZGVsSWQsIFwiY3VzdG9tLW9wZW5haS9ncHQtNS4zLWNvZGV4LXNwYXJrXCIpO1xuICBhc3NlcnQuZXF1YWwobGlnaHQud2FzRG93bmdyYWRlZCwgdHJ1ZSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEZhbGxiYWNrIGNoYWluIGNvbnN0cnVjdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcImZhbGxiYWNrIGNoYWluIGluY2x1ZGVzIGNvbmZpZ3VyZWQgcHJpbWFyeSBhcyBsYXN0IHJlc29ydFwiLCAoKSA9PiB7XG4gIGNvbnN0IGNvbmZpZyA9IHsgLi4uZGVmYXVsdFJvdXRpbmdDb25maWcoKSwgZW5hYmxlZDogdHJ1ZSB9O1xuICBjb25zdCByZXN1bHQgPSByZXNvbHZlTW9kZWxGb3JDb21wbGV4aXR5KFxuICAgIG1ha2VDbGFzc2lmaWNhdGlvbihcImxpZ2h0XCIpLFxuICAgIHsgcHJpbWFyeTogXCJjbGF1ZGUtb3B1cy00LTZcIiwgZmFsbGJhY2tzOiBbXCJjbGF1ZGUtc29ubmV0LTQtNlwiXSB9LFxuICAgIGNvbmZpZyxcbiAgICBBVkFJTEFCTEVfTU9ERUxTLFxuICApO1xuICBhc3NlcnQub2socmVzdWx0Lndhc0Rvd25ncmFkZWQpO1xuICAvLyBGYWxsYmFja3Mgc2hvdWxkIGluY2x1ZGUgdGhlIGNvbmZpZ3VyZWQgZmFsbGJhY2tzIGFuZCBwcmltYXJ5XG4gIGFzc2VydC5vayhyZXN1bHQuZmFsbGJhY2tzLmluY2x1ZGVzKFwiY2xhdWRlLW9wdXMtNC02XCIpLCBcInByaW1hcnkgc2hvdWxkIGJlIGluIGZhbGxiYWNrc1wiKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdC5mYWxsYmFja3MuaW5jbHVkZXMoXCJjbGF1ZGUtc29ubmV0LTQtNlwiKSwgXCJjb25maWd1cmVkIGZhbGxiYWNrIHNob3VsZCBiZSBpbiBmYWxsYmFja3NcIik7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEVzY2FsYXRpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJlc2NhbGF0ZVRpZXIgbW92ZXMgbGlnaHQgXHUyMTkyIHN0YW5kYXJkXCIsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKGVzY2FsYXRlVGllcihcImxpZ2h0XCIpLCBcInN0YW5kYXJkXCIpO1xufSk7XG5cbnRlc3QoXCJlc2NhbGF0ZVRpZXIgbW92ZXMgc3RhbmRhcmQgXHUyMTkyIGhlYXZ5XCIsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKGVzY2FsYXRlVGllcihcInN0YW5kYXJkXCIpLCBcImhlYXZ5XCIpO1xufSk7XG5cbnRlc3QoXCJlc2NhbGF0ZVRpZXIgcmV0dXJucyBudWxsIGZvciBoZWF2eSAobWF4KVwiLCAoKSA9PiB7XG4gIGFzc2VydC5lcXVhbChlc2NhbGF0ZVRpZXIoXCJoZWF2eVwiKSwgbnVsbCk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIE5vIHN1aXRhYmxlIG1vZGVsIGF2YWlsYWJsZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcImZhbGxzIGJhY2sgdG8gY29uZmlndXJlZCBtb2RlbCB3aGVuIG5vIGxpZ2h0LXRpZXIgbW9kZWwgYXZhaWxhYmxlXCIsICgpID0+IHtcbiAgY29uc3QgY29uZmlnID0geyAuLi5kZWZhdWx0Um91dGluZ0NvbmZpZygpLCBlbmFibGVkOiB0cnVlIH07XG4gIC8vIE9ubHkgaGVhdnktdGllciBtb2RlbHMgYXZhaWxhYmxlXG4gIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVNb2RlbEZvckNvbXBsZXhpdHkoXG4gICAgbWFrZUNsYXNzaWZpY2F0aW9uKFwibGlnaHRcIiksXG4gICAgeyBwcmltYXJ5OiBcImNsYXVkZS1vcHVzLTQtNlwiLCBmYWxsYmFja3M6IFtdIH0sXG4gICAgY29uZmlnLFxuICAgIFtcImNsYXVkZS1vcHVzLTQtNlwiXSxcbiAgKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5tb2RlbElkLCBcImNsYXVkZS1vcHVzLTQtNlwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC53YXNEb3duZ3JhZGVkLCBmYWxzZSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwICMyMTkyOiBVbmtub3duIG1vZGVscyBob25vciBleHBsaWNpdCBjb25maWcgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCIjMjE5MjogdW5rbm93biBtb2RlbCBpcyBub3QgZG93bmdyYWRlZCBcdTIwMTQgcmVzcGVjdHMgdXNlciBjb25maWdcIiwgKCkgPT4ge1xuICBjb25zdCBjb25maWcgPSB7IC4uLmRlZmF1bHRSb3V0aW5nQ29uZmlnKCksIGVuYWJsZWQ6IHRydWUgfTtcbiAgY29uc3QgcmVzdWx0ID0gcmVzb2x2ZU1vZGVsRm9yQ29tcGxleGl0eShcbiAgICBtYWtlQ2xhc3NpZmljYXRpb24oXCJsaWdodFwiKSxcbiAgICB7IHByaW1hcnk6IFwic29tZS1mdXR1cmUtdW5rbm93bi1tb2RlbC12OVwiLCBmYWxsYmFja3M6IFtdIH0sXG4gICAgY29uZmlnLFxuICAgIFtcInNvbWUtZnV0dXJlLXVua25vd24tbW9kZWwtdjlcIiwgLi4uQVZBSUxBQkxFX01PREVMU10sXG4gICk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQubW9kZWxJZCwgXCJzb21lLWZ1dHVyZS11bmtub3duLW1vZGVsLXY5XCIsIFwidW5rbm93biBtb2RlbCBzaG91bGQgYmUgdXNlZCBhcy1pc1wiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC53YXNEb3duZ3JhZGVkLCBmYWxzZSwgXCJzaG91bGQgbm90IGJlIGRvd25ncmFkZWRcIik7XG4gIGFzc2VydC5vayhyZXN1bHQucmVhc29uLmluY2x1ZGVzKFwibm90IGluIHRoZSBrbm93biB0aWVyIG1hcFwiKSwgXCJyZWFzb24gc2hvdWxkIGV4cGxhaW4gd2h5XCIpO1xufSk7XG5cbnRlc3QoXCIjMjE5MjogdW5rbm93biBtb2RlbCB3aXRoIHByb3ZpZGVyIHByZWZpeCBpcyBub3QgZG93bmdyYWRlZFwiLCAoKSA9PiB7XG4gIGNvbnN0IGNvbmZpZyA9IHsgLi4uZGVmYXVsdFJvdXRpbmdDb25maWcoKSwgZW5hYmxlZDogdHJ1ZSB9O1xuICBjb25zdCByZXN1bHQgPSByZXNvbHZlTW9kZWxGb3JDb21wbGV4aXR5KFxuICAgIG1ha2VDbGFzc2lmaWNhdGlvbihcInN0YW5kYXJkXCIpLFxuICAgIHsgcHJpbWFyeTogXCJjdXN0b20tcHJvdmlkZXIvbXktbW9kZWwtdjNcIiwgZmFsbGJhY2tzOiBbXSB9LFxuICAgIGNvbmZpZyxcbiAgICBbXCJjdXN0b20tcHJvdmlkZXIvbXktbW9kZWwtdjNcIiwgLi4uQVZBSUxBQkxFX01PREVMU10sXG4gICk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQubW9kZWxJZCwgXCJjdXN0b20tcHJvdmlkZXIvbXktbW9kZWwtdjNcIik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQud2FzRG93bmdyYWRlZCwgZmFsc2UpO1xufSk7XG5cbnRlc3QoXCIjMjE5Mjoga25vd24gbW9kZWwgaXMgc3RpbGwgZG93bmdyYWRlZCBub3JtYWxseVwiLCAoKSA9PiB7XG4gIGNvbnN0IGNvbmZpZyA9IHsgLi4uZGVmYXVsdFJvdXRpbmdDb25maWcoKSwgZW5hYmxlZDogdHJ1ZSB9O1xuICAvLyBjbGF1ZGUtb3B1cy00LTYgaXMga25vd24gYXMgXCJoZWF2eVwiIFx1MjAxNCBhIGxpZ2h0IHJlcXVlc3Qgc2hvdWxkIGRvd25ncmFkZVxuICBjb25zdCByZXN1bHQgPSByZXNvbHZlTW9kZWxGb3JDb21wbGV4aXR5KFxuICAgIG1ha2VDbGFzc2lmaWNhdGlvbihcImxpZ2h0XCIpLFxuICAgIHsgcHJpbWFyeTogXCJjbGF1ZGUtb3B1cy00LTZcIiwgZmFsbGJhY2tzOiBbXSB9LFxuICAgIGNvbmZpZyxcbiAgICBBVkFJTEFCTEVfTU9ERUxTLFxuICApO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0Lndhc0Rvd25ncmFkZWQsIHRydWUsIFwia25vd24gaGVhdnkgbW9kZWwgc2hvdWxkIHN0aWxsIGJlIGRvd25ncmFkZWQgZm9yIGxpZ2h0IHRhc2tzXCIpO1xuICBhc3NlcnQubm90RXF1YWwocmVzdWx0Lm1vZGVsSWQsIFwiY2xhdWRlLW9wdXMtNC02XCIpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBDcm9zcy1wcm92aWRlciBmYWxsYmFjayBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcInVzZXMgY3Jvc3MtcHJvdmlkZXIgZXF1aXZhbGVudCB3aGVuIGNvbmZpZ3VyZWQgcHJpbWFyeSBpcyB1bmF2YWlsYWJsZVwiLCAoKSA9PiB7XG4gIGNvbnN0IGNvbmZpZyA9IHsgLi4uZGVmYXVsdFJvdXRpbmdDb25maWcoKSwgZW5hYmxlZDogdHJ1ZSB9O1xuICAvLyBQcm9maWxlIGRlZmF1bHQgc2F5cyBjbGF1ZGUtb3B1cy00LTYgZm9yIHBsYW5uaW5nLCBidXQgdXNlciBpcyBvbiBHUFQgb25seVxuICBjb25zdCByZXN1bHQgPSByZXNvbHZlTW9kZWxGb3JDb21wbGV4aXR5KFxuICAgIG1ha2VDbGFzc2lmaWNhdGlvbihcImhlYXZ5XCIpLFxuICAgIHsgcHJpbWFyeTogXCJjbGF1ZGUtb3B1cy00LTZcIiwgZmFsbGJhY2tzOiBbXSB9LFxuICAgIGNvbmZpZyxcbiAgICBbXCJncHQtNG9cIiwgXCJncHQtNG8tbWluaVwiLCBcIm8xXCJdLFxuICApO1xuICAvLyBvMSBpcyB0aGUgaGVhdnktdGllciBHUFQgbW9kZWwgXHUyMDE0IHNob3VsZCBiZSBzZWxlY3RlZCBhcyBjcm9zcy1wcm92aWRlciBlcXVpdmFsZW50XG4gIGFzc2VydC5lcXVhbChyZXN1bHQubW9kZWxJZCwgXCJvMVwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC53YXNEb3duZ3JhZGVkLCBmYWxzZSk7XG4gIGFzc2VydC5tYXRjaChyZXN1bHQucmVhc29uLCAvY3Jvc3MtcHJvdmlkZXIvKTtcbn0pO1xuXG50ZXN0KFwiY3Jvc3MtcHJvdmlkZXI6IHNlbGVjdHMgc3RhbmRhcmQtdGllciBlcXVpdmFsZW50IHdoZW4gcHJpbWFyeSB1bmF2YWlsYWJsZVwiLCAoKSA9PiB7XG4gIGNvbnN0IGNvbmZpZyA9IHsgLi4uZGVmYXVsdFJvdXRpbmdDb25maWcoKSwgZW5hYmxlZDogdHJ1ZSB9O1xuICAvLyBQbGFubmluZyBjb25maWd1cmVkIHdpdGggT3B1cywgYnV0IG9ubHkgR1BUIHN0YW5kYXJkIG1vZGVscyBhdmFpbGFibGVcbiAgY29uc3QgcmVzdWx0ID0gcmVzb2x2ZU1vZGVsRm9yQ29tcGxleGl0eShcbiAgICBtYWtlQ2xhc3NpZmljYXRpb24oXCJoZWF2eVwiKSxcbiAgICB7IHByaW1hcnk6IFwiY2xhdWRlLW9wdXMtNC02XCIsIGZhbGxiYWNrczogW10gfSxcbiAgICBjb25maWcsXG4gICAgW1wiZ3B0LTRvXCIsIFwiZ3B0LTRvLW1pbmlcIl0sXG4gICk7XG4gIC8vIGdwdC00byBpcyBzdGFuZGFyZCB0aWVyLCBub3QgaGVhdnkgXHUyMDE0IG5vIGhlYXZ5LXRpZXIgbW9kZWwgYXZhaWxhYmxlXG4gIC8vIFNob3VsZCBmYWxsIGJhY2sgdG8gZ3B0LTRvIChiZXN0IGF2YWlsYWJsZSlcbiAgYXNzZXJ0Lm9rKHJlc3VsdC5tb2RlbElkID09PSBcImdwdC00b1wiIHx8IHJlc3VsdC5tb2RlbElkID09PSBcImNsYXVkZS1vcHVzLTQtNlwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC53YXNEb3duZ3JhZGVkLCBmYWxzZSk7XG59KTtcblxudGVzdChcImNyb3NzLXByb3ZpZGVyOiBjb25maWd1cmVkIHByaW1hcnkgYXZhaWxhYmxlIGJ5IGJhcmUgSUQgd2lucyBvdmVyIGVxdWl2YWxlbnRcIiwgKCkgPT4ge1xuICBjb25zdCBjb25maWcgPSB7IC4uLmRlZmF1bHRSb3V0aW5nQ29uZmlnKCksIGVuYWJsZWQ6IHRydWUgfTtcbiAgLy8gUHJvdmlkZXItcHJlZml4ZWQgSUQgXHUyMDE0IGJhcmUgbWF0Y2ggc2hvdWxkIGZpbmQgaXRcbiAgY29uc3QgcmVzdWx0ID0gcmVzb2x2ZU1vZGVsRm9yQ29tcGxleGl0eShcbiAgICBtYWtlQ2xhc3NpZmljYXRpb24oXCJoZWF2eVwiKSxcbiAgICB7IHByaW1hcnk6IFwiY2xhdWRlLW9wdXMtNC02XCIsIGZhbGxiYWNrczogW10gfSxcbiAgICBjb25maWcsXG4gICAgW1wiYW50aHJvcGljL2NsYXVkZS1vcHVzLTQtNlwiLCBcIm8xXCJdLFxuICApO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0Lm1vZGVsSWQsIFwiY2xhdWRlLW9wdXMtNC02XCIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0Lndhc0Rvd25ncmFkZWQsIGZhbHNlKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgcmVzb2x2ZU1vZGVsRm9yVGllciAocHJvdmlkZXItYWdub3N0aWMgdGllciByZXNvbHV0aW9uKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcInJlc29sdmVNb2RlbEZvclRpZXI6IHJldHVybnMgY2Fub25pY2FsIEFudGhyb3BpYyBtb2RlbCB3aGVuIG5vIGF2YWlsYWJsZSBtb2RlbHNcIiwgKCkgPT4ge1xuICB0cnkge1xuICAgIHJlc2V0TGVnYWN5VGVsZW1ldHJ5KCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc29sdmVNb2RlbEZvclRpZXIoXCJoZWF2eVwiLCBbXSksIFwiY2xhdWRlLW9wdXMtNC02XCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXNvbHZlTW9kZWxGb3JUaWVyKFwic3RhbmRhcmRcIiwgW10pLCBcImNsYXVkZS1zb25uZXQtNC02XCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXNvbHZlTW9kZWxGb3JUaWVyKFwibGlnaHRcIiwgW10pLCBcImNsYXVkZS1oYWlrdS00LTVcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGdldExlZ2FjeVRlbGVtZXRyeSgpW1wibGVnYWN5LnByb3ZpZGVyRGVmYXVsdFVzZWRcIl0sIDMpO1xuICB9IGZpbmFsbHkge1xuICAgIHJlc2V0TGVnYWN5VGVsZW1ldHJ5KCk7XG4gIH1cbn0pO1xuXG50ZXN0KFwicmVzb2x2ZU1vZGVsRm9yVGllcjogcmV0dXJucyBjYW5vbmljYWwgbW9kZWwgd2hlbiBpdCBpcyBhdmFpbGFibGVcIiwgKCkgPT4ge1xuICB0cnkge1xuICAgIHJlc2V0TGVnYWN5VGVsZW1ldHJ5KCk7XG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgcmVzb2x2ZU1vZGVsRm9yVGllcihcImhlYXZ5XCIsIFtcImNsYXVkZS1vcHVzLTQtNlwiLCBcImNsYXVkZS1zb25uZXQtNC02XCJdKSxcbiAgICAgIFwiY2xhdWRlLW9wdXMtNC02XCIsXG4gICAgKTtcbiAgICBhc3NlcnQuZXF1YWwoZ2V0TGVnYWN5VGVsZW1ldHJ5KClbXCJsZWdhY3kucHJvdmlkZXJEZWZhdWx0VXNlZFwiXSwgMCk7XG4gIH0gZmluYWxseSB7XG4gICAgcmVzZXRMZWdhY3lUZWxlbWV0cnkoKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJyZXNvbHZlTW9kZWxGb3JUaWVyOiBkb2VzIG5vdCBwcmVmZXIgY2Fub25pY2FsIG92ZXIgY2hlYXBlciBzYW1lLXRpZXIgbW9kZWxcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSByZXNvbHZlTW9kZWxGb3JUaWVyKFwibGlnaHRcIiwgW1wiY2xhdWRlLWhhaWt1LTQtNVwiLCBcImdwdC00by1taW5pXCJdKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgXCJncHQtNG8tbWluaVwiKTtcbn0pO1xuXG50ZXN0KFwicmVzb2x2ZU1vZGVsRm9yVGllcjogaG9ub3JzIGNvbmZpZ3VyZWQgdGllcl9tb2RlbHMgcGluc1wiLCAoKSA9PiB7XG4gIGNvbnN0IGNvbmZpZzogRHluYW1pY1JvdXRpbmdDb25maWcgPSB7XG4gICAgLi4uZGVmYXVsdFJvdXRpbmdDb25maWcoKSxcbiAgICB0aWVyX21vZGVsczogeyBsaWdodDogXCJjbGF1ZGUtaGFpa3UtNC01XCIgfSxcbiAgfTtcbiAgY29uc3QgcmVzdWx0ID0gcmVzb2x2ZU1vZGVsRm9yVGllcihcImxpZ2h0XCIsIFtcImNsYXVkZS1oYWlrdS00LTVcIiwgXCJncHQtNG8tbWluaVwiXSwgY29uZmlnKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgXCJjbGF1ZGUtaGFpa3UtNC01XCIpO1xufSk7XG5cbnRlc3QoXCJyZXNvbHZlTW9kZWxGb3JUaWVyOiBwaWNrcyBjcm9zcy1wcm92aWRlciBlcXVpdmFsZW50IHdoZW4gQW50aHJvcGljIHVuYXZhaWxhYmxlXCIsICgpID0+IHtcbiAgLy8gT25seSBPcGVuQUkgbW9kZWxzIGF2YWlsYWJsZVxuICBjb25zdCByZXN1bHQgPSByZXNvbHZlTW9kZWxGb3JUaWVyKFwiaGVhdnlcIiwgW1wiZ3B0LTRvXCIsIFwiZ3B0LTRvLW1pbmlcIiwgXCJvMVwiXSk7XG4gIC8vIG8xIGlzIHRoZSBoZWF2eS10aWVyIG1vZGVsIGluIHRoZSBPcGVuQUkgbGluZXVwXG4gIGFzc2VydC5lcXVhbChyZXN1bHQsIFwibzFcIik7XG59KTtcblxudGVzdChcInJlc29sdmVNb2RlbEZvclRpZXI6IHBpY2tzIHN0YW5kYXJkLXRpZXIgY3Jvc3MtcHJvdmlkZXIgbW9kZWxcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSByZXNvbHZlTW9kZWxGb3JUaWVyKFwic3RhbmRhcmRcIiwgW1wiZ3B0LTRvXCIsIFwiZ3B0LTRvLW1pbmlcIl0pO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LCBcImdwdC00b1wiKTtcbn0pO1xuXG50ZXN0KFwicmVzb2x2ZU1vZGVsRm9yVGllcjogcGlja3MgbGlnaHQtdGllciBjcm9zcy1wcm92aWRlciBtb2RlbFwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVNb2RlbEZvclRpZXIoXCJsaWdodFwiLCBbXCJncHQtNG9cIiwgXCJncHQtNG8tbWluaVwiXSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQsIFwiZ3B0LTRvLW1pbmlcIik7XG59KTtcblxudGVzdChcInJlc29sdmVNb2RlbEZvclRpZXI6IGZhbGxzIGJhY2sgdG8gY2Fub25pY2FsIHdoZW4gbm8gdGllciBtYXRjaCBhdmFpbGFibGVcIiwgKCkgPT4ge1xuICB0cnkge1xuICAgIHJlc2V0TGVnYWN5VGVsZW1ldHJ5KCk7XG4gICAgLy8gT25seSB1bmtub3duIG1vZGVscyBhdmFpbGFibGUgXHUyMDE0IGdldE1vZGVsVGllciBjbGFzc2lmaWVzIHVua25vd25zIGFzXG4gICAgLy8gXCJzdGFuZGFyZFwiLCBzbyBhIHJlcXVlc3QgZm9yIFwiaGVhdnlcIiBmaW5kcyBubyBtYXRjaCBhbmQgdGhlIGNhbm9uaWNhbFxuICAgIC8vIEFudGhyb3BpYyBJRCBpcyByZXR1cm5lZCBhcyBhIGRvY3VtZW50ZWQgZmFsbGJhY2suXG4gICAgY29uc3QgcmVzdWx0ID0gcmVzb2x2ZU1vZGVsRm9yVGllcihcImhlYXZ5XCIsIFtcInNvbWUtY3VzdG9tLW1vZGVsXCJdKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCBcImNsYXVkZS1vcHVzLTQtNlwiKTtcbiAgICBhc3NlcnQuZXF1YWwoZ2V0TGVnYWN5VGVsZW1ldHJ5KClbXCJsZWdhY3kucHJvdmlkZXJEZWZhdWx0VXNlZFwiXSwgMSk7XG4gIH0gZmluYWxseSB7XG4gICAgcmVzZXRMZWdhY3lUZWxlbWV0cnkoKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJyZXNvbHZlTW9kZWxGb3JUaWVyOiBoYW5kbGVzIHByb3ZpZGVyLXByZWZpeGVkIGF2YWlsYWJsZSBtb2RlbHNcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSByZXNvbHZlTW9kZWxGb3JUaWVyKFwiaGVhdnlcIiwgW1wiYW50aHJvcGljL2NsYXVkZS1vcHVzLTQtNlwiXSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQsIFwiY2xhdWRlLW9wdXMtNC02XCIpO1xufSk7XG5cbnRlc3QoXCJyZXNvbHZlTW9kZWxGb3JUaWVyOiBwaWNrcyBHZW1pbmkgbW9kZWxzIHdoZW4gb25seSBHb29nbGUgYXZhaWxhYmxlXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gcmVzb2x2ZU1vZGVsRm9yVGllcihcImxpZ2h0XCIsIFtcImdlbWluaS0yLjUtcHJvXCIsIFwiZ2VtaW5pLTIuMC1mbGFzaFwiXSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQsIFwiZ2VtaW5pLTIuMC1mbGFzaFwiKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQmVoYXZpb3JhbDogcHJvZmlsZSBkZWZhdWx0cyBhcmUgcHJvdmlkZXItYWdub3N0aWMgYXQgcnVudGltZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcInJlc29sdmVQcm9maWxlRGVmYXVsdHM6IGJhbGFuY2VkIHdpdGggb25seSBPcGVuQUkgbW9kZWxzIHJldHVybnMgT3BlbkFJIElEc1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgcmVzb2x2ZVByb2ZpbGVEZWZhdWx0cyB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vcHJlZmVyZW5jZXMtbW9kZWxzLmpzXCIpO1xuICBjb25zdCBkZWZhdWx0cyA9IHJlc29sdmVQcm9maWxlRGVmYXVsdHMoXCJiYWxhbmNlZFwiLCBbXCJncHQtNG9cIiwgXCJncHQtNG8tbWluaVwiXSk7XG4gIGFzc2VydC5vayhkZWZhdWx0cy5tb2RlbHMsIFwiYmFsYW5jZWQgc2hvdWxkIHBvcHVsYXRlIG1vZGVsc1wiKTtcbiAgLy8gQWxsIHNsb3RzIG11c3QgcmVzb2x2ZSB0byBhbiBhdmFpbGFibGUgT3BlbkFJIElEIFx1MjAxNCBub3QgYSBjbGF1ZGUtIGNhbm9uaWNhbC5cbiAgZm9yIChjb25zdCBbcGhhc2UsIG1vZGVsSWRdIG9mIE9iamVjdC5lbnRyaWVzKGRlZmF1bHRzLm1vZGVscyEpKSB7XG4gICAgYXNzZXJ0Lm9rKHR5cGVvZiBtb2RlbElkID09PSBcInN0cmluZ1wiICYmIG1vZGVsSWQubGVuZ3RoID4gMCwgYCR7cGhhc2V9IHNob3VsZCByZXNvbHZlIHRvIGEgbW9kZWwgSURgKTtcbiAgICBhc3NlcnQub2soXG4gICAgICAhU3RyaW5nKG1vZGVsSWQpLnN0YXJ0c1dpdGgoXCJjbGF1ZGUtXCIpLFxuICAgICAgYCR7cGhhc2V9IHJlc29sdmVkIHRvICR7bW9kZWxJZH0gYnV0IG5vIGNsYXVkZS0qIG1vZGVsIGlzIGF2YWlsYWJsZSBcdTIwMTQgc2hvdWxkIGJlIE9wZW5BSWAsXG4gICAgKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJyZXNvbHZlUHJvZmlsZURlZmF1bHRzOiBidWRnZXQgd2l0aCBvbmx5IE9wZW5BSSBtb2RlbHMgcGlja3MgZ3B0LTRvLW1pbmkgZm9yIGxpZ2h0IHNsb3RzXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyByZXNvbHZlUHJvZmlsZURlZmF1bHRzIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9wcmVmZXJlbmNlcy1tb2RlbHMuanNcIik7XG4gIGNvbnN0IGRlZmF1bHRzID0gcmVzb2x2ZVByb2ZpbGVEZWZhdWx0cyhcImJ1ZGdldFwiLCBbXCJncHQtNG9cIiwgXCJncHQtNG8tbWluaVwiXSk7XG4gIC8vIGxpZ2h0LXRpZXIgc2xvdHMgaW4gYnVkZ2V0OiByZXNlYXJjaCwgZXhlY3V0aW9uX3NpbXBsZSwgY29tcGxldGlvbiwgc3ViYWdlbnRcbiAgYXNzZXJ0LmVxdWFsKGRlZmF1bHRzLm1vZGVscz8ucmVzZWFyY2gsIFwiZ3B0LTRvLW1pbmlcIik7XG4gIGFzc2VydC5lcXVhbChkZWZhdWx0cy5tb2RlbHM/LmV4ZWN1dGlvbl9zaW1wbGUsIFwiZ3B0LTRvLW1pbmlcIik7XG4gIGFzc2VydC5lcXVhbChkZWZhdWx0cy5tb2RlbHM/LmNvbXBsZXRpb24sIFwiZ3B0LTRvLW1pbmlcIik7XG4gIGFzc2VydC5lcXVhbChkZWZhdWx0cy5tb2RlbHM/LnN1YmFnZW50LCBcImdwdC00by1taW5pXCIpO1xuICAvLyBzdGFuZGFyZC10aWVyIHNsb3RzOiBwbGFubmluZywgZXhlY3V0aW9uXG4gIGFzc2VydC5lcXVhbChkZWZhdWx0cy5tb2RlbHM/LnBsYW5uaW5nLCBcImdwdC00b1wiKTtcbiAgYXNzZXJ0LmVxdWFsKGRlZmF1bHRzLm1vZGVscz8uZXhlY3V0aW9uLCBcImdwdC00b1wiKTtcbn0pO1xuXG50ZXN0KFwicmVzb2x2ZVByb2ZpbGVEZWZhdWx0czogaG9ub3JzIGR5bmFtaWMgcm91dGluZyB0aWVyX21vZGVscyBwaW5zXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyByZXNvbHZlUHJvZmlsZURlZmF1bHRzIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9wcmVmZXJlbmNlcy1tb2RlbHMuanNcIik7XG4gIGNvbnN0IGRlZmF1bHRzID0gcmVzb2x2ZVByb2ZpbGVEZWZhdWx0cyhcbiAgICBcImJ1ZGdldFwiLFxuICAgIFtcImNsYXVkZS1oYWlrdS00LTVcIiwgXCJncHQtNG8tbWluaVwiLCBcImdwdC00b1wiXSxcbiAgICB7IC4uLmRlZmF1bHRSb3V0aW5nQ29uZmlnKCksIHRpZXJfbW9kZWxzOiB7IGxpZ2h0OiBcImNsYXVkZS1oYWlrdS00LTVcIiB9IH0sXG4gICk7XG4gIGFzc2VydC5lcXVhbChkZWZhdWx0cy5tb2RlbHM/LnJlc2VhcmNoLCBcImNsYXVkZS1oYWlrdS00LTVcIik7XG4gIGFzc2VydC5lcXVhbChkZWZhdWx0cy5tb2RlbHM/LmV4ZWN1dGlvbl9zaW1wbGUsIFwiY2xhdWRlLWhhaWt1LTQtNVwiKTtcbiAgYXNzZXJ0LmVxdWFsKGRlZmF1bHRzLm1vZGVscz8uY29tcGxldGlvbiwgXCJjbGF1ZGUtaGFpa3UtNC01XCIpO1xuICBhc3NlcnQuZXF1YWwoZGVmYXVsdHMubW9kZWxzPy5zdWJhZ2VudCwgXCJjbGF1ZGUtaGFpa3UtNC01XCIpO1xufSk7XG5cbnRlc3QoXCJyZXNvbHZlUHJvZmlsZURlZmF1bHRzOiBlbXB0eSBhdmFpbGFibGVNb2RlbElkcyBmYWxscyBiYWNrIHRvIGNhbm9uaWNhbCBBbnRocm9waWMgSURzXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyByZXNvbHZlUHJvZmlsZURlZmF1bHRzIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9wcmVmZXJlbmNlcy1tb2RlbHMuanNcIik7XG4gIGNvbnN0IGRlZmF1bHRzID0gcmVzb2x2ZVByb2ZpbGVEZWZhdWx0cyhcImJhbGFuY2VkXCIsIFtdKTtcbiAgLy8gRG9jdW1lbnRlZCBmYWxsYmFjayBvbmx5IFx1MjAxNCB3aGVuIHJlZ2lzdHJ5IGlzIHVuYXZhaWxhYmxlIGF0IGJvb3RzdHJhcC5cbiAgY29uc3QgcGxhbm5pbmdNb2RlbCA9IGRlZmF1bHRzLm1vZGVscz8ucGxhbm5pbmc7XG4gIGFzc2VydC5vayh0eXBlb2YgcGxhbm5pbmdNb2RlbCA9PT0gXCJzdHJpbmdcIiAmJiBwbGFubmluZ01vZGVsLnN0YXJ0c1dpdGgoXCJjbGF1ZGUtXCIpKTtcbn0pO1xuXG50ZXN0KFwicmVzb2x2ZVByb2ZpbGVEZWZhdWx0czogYnVybi1tYXggb21pdHMgbW9kZWxzIHNvIHVzZXIgY2hvaWNlIGlzIHByZXNlcnZlZFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgcmVzb2x2ZVByb2ZpbGVEZWZhdWx0cyB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vcHJlZmVyZW5jZXMtbW9kZWxzLmpzXCIpO1xuICBjb25zdCBkZWZhdWx0cyA9IHJlc29sdmVQcm9maWxlRGVmYXVsdHMoXCJidXJuLW1heFwiLCBbXCJncHQtNG9cIl0pO1xuICBhc3NlcnQuZXF1YWwoZGVmYXVsdHMubW9kZWxzLCB1bmRlZmluZWQsIFwiYnVybi1tYXggbXVzdCBub3Qgd3JpdGUgbW9kZWwgZGVmYXVsdHNcIik7XG4gIGFzc2VydC5lcXVhbChkZWZhdWx0cy5keW5hbWljX3JvdXRpbmc/LmVuYWJsZWQsIGZhbHNlKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQ2FwYWJpbGl0eSBTY29yaW5nIChBRFItMDA0IFBoYXNlIDIpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiZGVmYXVsdFJvdXRpbmdDb25maWcgaW5jbHVkZXMgY2FwYWJpbGl0eV9yb3V0aW5nOiB0cnVlXCIsICgpID0+IHtcbiAgY29uc3QgY29uZmlnID0gZGVmYXVsdFJvdXRpbmdDb25maWcoKTtcbiAgYXNzZXJ0LmVxdWFsKGNvbmZpZy5jYXBhYmlsaXR5X3JvdXRpbmcsIHRydWUpO1xufSk7XG5cbnRlc3QoXCJzY29yZUVsaWdpYmxlTW9kZWxzIHVzZXMgYmFyZSBjYXBhYmlsaXR5IHByb2ZpbGVzIGZvciBwcm92aWRlci1xdWFsaWZpZWQgSURzXCIsICgpID0+IHtcbiAgY29uc3Qgc2NvcmVkID0gc2NvcmVFbGlnaWJsZU1vZGVscyhcbiAgICBbXCJjdXN0b20tb3BlbmFpL2dwdC01LjRcIiwgXCJjdXN0b20tb3BlbmFpL2dwdC01LjMtY29kZXgtc3BhcmtcIl0sXG4gICAgeyBjb2Rpbmc6IDEgfSxcbiAgKTtcblxuICBhc3NlcnQuZXF1YWwoc2NvcmVkWzBdPy5tb2RlbElkLCBcImN1c3RvbS1vcGVuYWkvZ3B0LTUuNFwiKTtcbiAgYXNzZXJ0Lm9rKFxuICAgIChzY29yZWRbMF0/LnNjb3JlID8/IDApID4gKHNjb3JlZFsxXT8uc2NvcmUgPz8gMCksXG4gICAgXCJwcm92aWRlci1xdWFsaWZpZWQgSURzIHNob3VsZCBzdGlsbCB1c2UgdGhlIGJ1aWx0LWluIGJhcmUgbW9kZWwgY2FwYWJpbGl0eSBwcm9maWxlXCIsXG4gICk7XG59KTtcblxudGVzdChcInNjb3JlTW9kZWwgY29tcHV0ZXMgd2VpZ2h0ZWQgYXZlcmFnZSBvZiBjYXBhYmlsaXR5IFx1MDBENyByZXF1aXJlbWVudFwiLCAoKSA9PiB7XG4gIGNvbnN0IGNhcHM6IE1vZGVsQ2FwYWJpbGl0aWVzID0ge1xuICAgIGNvZGluZzogOTAsIGRlYnVnZ2luZzogODAsIHJlc2VhcmNoOiA3MCxcbiAgICByZWFzb25pbmc6IDg1LCBzcGVlZDogNTAsIGxvbmdDb250ZXh0OiA2MCwgaW5zdHJ1Y3Rpb246IDc1LFxuICB9O1xuICBjb25zdCByZXFzID0geyBjb2Rpbmc6IDAuOSwgcmVhc29uaW5nOiAwLjUgfTtcbiAgY29uc3Qgc2NvcmUgPSBzY29yZU1vZGVsKGNhcHMsIHJlcXMpO1xuICAvLyBFeHBlY3RlZDogKDAuOSo5MCArIDAuNSo4NSkgLyAoMC45ICsgMC41KSA9ICg4MSArIDQyLjUpIC8gMS40ID0gODguMjEuLi5cbiAgYXNzZXJ0Lm9rKE1hdGguYWJzKHNjb3JlIC0gODguMjEpIDwgMC4xLCBgc2NvcmUgJHtzY29yZX0gc2hvdWxkIGJlIH44OC4yMWApO1xufSk7XG5cbi8vIChSZW1vdmVkIGR1cGxpY2F0ZSBcInNjb3JlTW9kZWwgcmV0dXJucyA1MCBmb3IgZW1wdHkgcmVxdWlyZW1lbnRzXCIgXHUyMDE0IHRoZVxuLy8gYGRlc2NyaWJlKFwic2NvcmVNb2RlbFwiKWAgYmxvY2sgYmVsb3cgaGFzIHRoZSBzYW1lIHNjZW5hcmlvLilcblxudGVzdChcImNvbXB1dGVUYXNrUmVxdWlyZW1lbnRzIHJldHVybnMgYmFzZSB2ZWN0b3IgZm9yIGtub3duIHVuaXQgdHlwZVwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlcXMgPSBjb21wdXRlVGFza1JlcXVpcmVtZW50cyhcImV4ZWN1dGUtdGFza1wiKTtcbiAgYXNzZXJ0Lm9rKHJlcXMuY29kaW5nICE9PSB1bmRlZmluZWQgJiYgcmVxcy5jb2RpbmcgPiAwKTtcbn0pO1xuXG50ZXN0KFwiY29tcHV0ZVRhc2tSZXF1aXJlbWVudHMgYm9vc3RzIGluc3RydWN0aW9uIGZvciBkb2NzLXRhZ2dlZCB0YXNrc1wiLCAoKSA9PiB7XG4gIGNvbnN0IHJlcXMgPSBjb21wdXRlVGFza1JlcXVpcmVtZW50cyhcImV4ZWN1dGUtdGFza1wiLCB7IHRhZ3M6IFtcImRvY3NcIl0gfSk7XG4gIGFzc2VydC5vaygocmVxcy5pbnN0cnVjdGlvbiA/PyAwKSA+PSAwLjgpO1xuICBhc3NlcnQub2soKHJlcXMuY29kaW5nID8/IDEpIDw9IDAuNCk7XG59KTtcblxudGVzdChcImNvbXB1dGVUYXNrUmVxdWlyZW1lbnRzIHJldHVybnMgZ2VuZXJpYyB2ZWN0b3IgZm9yIHVua25vd24gdW5pdCB0eXBlXCIsICgpID0+IHtcbiAgY29uc3QgcmVxcyA9IGNvbXB1dGVUYXNrUmVxdWlyZW1lbnRzKFwidW5rbm93bi11bml0XCIpO1xuICBhc3NlcnQub2socmVxcy5yZWFzb25pbmcgIT09IHVuZGVmaW5lZCk7XG59KTtcblxudGVzdChcInJlc29sdmVNb2RlbEZvckNvbXBsZXhpdHkgdXNlcyBjYXBhYmlsaXR5IHNjb3Jpbmcgd2hlbiBlbmFibGVkXCIsICgpID0+IHtcbiAgY29uc3QgY29uZmlnOiBEeW5hbWljUm91dGluZ0NvbmZpZyA9IHtcbiAgICAuLi5kZWZhdWx0Um91dGluZ0NvbmZpZygpLFxuICAgIGVuYWJsZWQ6IHRydWUsXG4gICAgY2FwYWJpbGl0eV9yb3V0aW5nOiB0cnVlLFxuICB9O1xuICBjb25zdCByZXN1bHQgPSByZXNvbHZlTW9kZWxGb3JDb21wbGV4aXR5KFxuICAgIG1ha2VDbGFzc2lmaWNhdGlvbihcImxpZ2h0XCIpLFxuICAgIHsgcHJpbWFyeTogXCJjbGF1ZGUtb3B1cy00LTZcIiwgZmFsbGJhY2tzOiBbXSB9LFxuICAgIGNvbmZpZyxcbiAgICBbXCJjbGF1ZGUtb3B1cy00LTZcIiwgXCJjbGF1ZGUtaGFpa3UtNC01XCIsIFwiZ3B0LTRvLW1pbmlcIl0sXG4gICAgXCJleGVjdXRlLXRhc2tcIixcbiAgKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC53YXNEb3duZ3JhZGVkLCB0cnVlKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zZWxlY3Rpb25NZXRob2QsIFwiY2FwYWJpbGl0eS1zY29yZWRcIik7XG59KTtcblxudGVzdChcInJlc29sdmVNb2RlbEZvckNvbXBsZXhpdHkgZmFsbHMgYmFjayB0byB0aWVyLW9ubHkgd2hlbiBjYXBhYmlsaXR5X3JvdXRpbmcgaXMgZmFsc2VcIiwgKCkgPT4ge1xuICBjb25zdCBjb25maWc6IER5bmFtaWNSb3V0aW5nQ29uZmlnID0ge1xuICAgIC4uLmRlZmF1bHRSb3V0aW5nQ29uZmlnKCksXG4gICAgZW5hYmxlZDogdHJ1ZSxcbiAgICBjYXBhYmlsaXR5X3JvdXRpbmc6IGZhbHNlLFxuICB9O1xuICBjb25zdCByZXN1bHQgPSByZXNvbHZlTW9kZWxGb3JDb21wbGV4aXR5KFxuICAgIG1ha2VDbGFzc2lmaWNhdGlvbihcImxpZ2h0XCIpLFxuICAgIHsgcHJpbWFyeTogXCJjbGF1ZGUtb3B1cy00LTZcIiwgZmFsbGJhY2tzOiBbXSB9LFxuICAgIGNvbmZpZyxcbiAgICBbXCJjbGF1ZGUtb3B1cy00LTZcIiwgXCJjbGF1ZGUtaGFpa3UtNC01XCIsIFwiZ3B0LTRvLW1pbmlcIl0sXG4gICk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQud2FzRG93bmdyYWRlZCwgdHJ1ZSk7XG4gIGFzc2VydC5vayghcmVzdWx0LnNlbGVjdGlvbk1ldGhvZCB8fCByZXN1bHQuc2VsZWN0aW9uTWV0aG9kID09PSBcInRpZXItb25seVwiKTtcbn0pO1xuXG50ZXN0KFwiTU9ERUxfQ0FQQUJJTElUWV9QUk9GSUxFUyBoYXMgZW50cmllcyBmb3IgYWxsIHRpZXItbWFwcGVkIG1vZGVsc1wiLCAoKSA9PiB7XG4gIGNvbnN0IHByb2ZpbGVkTW9kZWxzID0gT2JqZWN0LmtleXMoTU9ERUxfQ0FQQUJJTElUWV9QUk9GSUxFUyk7XG4gIGFzc2VydC5vayhwcm9maWxlZE1vZGVscy5sZW5ndGggPj0gMzAsIGBFeHBlY3RlZCBcdTIyNjUzMCBwcm9maWxlcywgZ290ICR7cHJvZmlsZWRNb2RlbHMubGVuZ3RofWApO1xuICBhc3NlcnQub2soTU9ERUxfQ0FQQUJJTElUWV9QUk9GSUxFU1tcImNsYXVkZS1vcHVzLTQtNlwiXSk7XG4gIGFzc2VydC5vayhNT0RFTF9DQVBBQklMSVRZX1BST0ZJTEVTW1wiY2xhdWRlLWhhaWt1LTQtNVwiXSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwICMyODg1OiBvcGVuYWktY29kZXggYW5kIG1vZGVybiBPcGVuQUkgbW9kZWxzIGluIHRpZXIgbWFwIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiIzI4ODU6IG9wZW5haS1jb2RleCBsaWdodC10aWVyIG1vZGVscyBhcmUgcmVjb2duaXplZFwiLCAoKSA9PiB7XG4gIGNvbnN0IGNvbmZpZyA9IHsgLi4uZGVmYXVsdFJvdXRpbmdDb25maWcoKSwgZW5hYmxlZDogdHJ1ZSB9O1xuICBjb25zdCBsaWdodE1vZGVscyA9IFtcImdwdC00LjEtbWluaVwiLCBcImdwdC00LjEtbmFub1wiLCBcImdwdC01LW1pbmlcIiwgXCJncHQtNS1uYW5vXCIsIFwiZ3B0LTUuMS1jb2RleC1taW5pXCIsIFwiZ3B0LTUuMy1jb2RleC1zcGFya1wiLCBcImdwdC01LjQtbWluaVwiXTtcbiAgZm9yIChjb25zdCBtb2RlbCBvZiBsaWdodE1vZGVscykge1xuICAgIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVNb2RlbEZvckNvbXBsZXhpdHkoXG4gICAgICBtYWtlQ2xhc3NpZmljYXRpb24oXCJsaWdodFwiKSxcbiAgICAgIHsgcHJpbWFyeTogbW9kZWwsIGZhbGxiYWNrczogW10gfSxcbiAgICAgIGNvbmZpZyxcbiAgICAgIFttb2RlbCwgLi4uQVZBSUxBQkxFX01PREVMU10sXG4gICAgKTtcbiAgICAvLyBNb2RlbCBpcyBrbm93biBBTkQgbGlnaHQtdGllciwgc28gcmVxdWVzdGluZyBsaWdodCBzaG91bGQgTk9UIGRvd25ncmFkZVxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQud2FzRG93bmdyYWRlZCwgZmFsc2UsIGAke21vZGVsfSBzaG91bGQgYmUga25vd24gYXMgbGlnaHQgdGllciAod2FzRG93bmdyYWRlZClgKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm1vZGVsSWQsIG1vZGVsLCBgJHttb2RlbH0gc2hvdWxkIGJlIHJldHVybmVkIGFzLWlzIGZvciBsaWdodCB0aWVyYCk7XG4gICAgLy8gVmVyaWZ5IGl0IElTIGtub3duIChub3QgaGl0dGluZyB0aGUgdW5rbm93bi1tb2RlbCBiYWlsLW91dClcbiAgICBhc3NlcnQub2soIXJlc3VsdC5yZWFzb24uaW5jbHVkZXMoXCJub3QgaW4gdGhlIGtub3duIHRpZXIgbWFwXCIpLCBgJHttb2RlbH0gc2hvdWxkIGJlIGluIHRoZSBrbm93biB0aWVyIG1hcGApO1xuICB9XG59KTtcblxudGVzdChcIiMyODg1OiBvcGVuYWktY29kZXggc3RhbmRhcmQtdGllciBtb2RlbHMgYXJlIHJlY29nbml6ZWRcIiwgKCkgPT4ge1xuICBjb25zdCBjb25maWcgPSB7IC4uLmRlZmF1bHRSb3V0aW5nQ29uZmlnKCksIGVuYWJsZWQ6IHRydWUgfTtcbiAgY29uc3Qgc3RhbmRhcmRNb2RlbHMgPSBbXCJncHQtNC4xXCIsIFwiZ3B0LTUuMS1jb2RleC1tYXhcIl07XG4gIGZvciAoY29uc3QgbW9kZWwgb2Ygc3RhbmRhcmRNb2RlbHMpIHtcbiAgICBjb25zdCByZXN1bHQgPSByZXNvbHZlTW9kZWxGb3JDb21wbGV4aXR5KFxuICAgICAgbWFrZUNsYXNzaWZpY2F0aW9uKFwic3RhbmRhcmRcIiksXG4gICAgICB7IHByaW1hcnk6IG1vZGVsLCBmYWxsYmFja3M6IFtdIH0sXG4gICAgICBjb25maWcsXG4gICAgICBbbW9kZWwsIC4uLkFWQUlMQUJMRV9NT0RFTFNdLFxuICAgICk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC53YXNEb3duZ3JhZGVkLCBmYWxzZSwgYCR7bW9kZWx9IHNob3VsZCBiZSBrbm93biBhcyBzdGFuZGFyZCB0aWVyYCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5tb2RlbElkLCBtb2RlbCwgYCR7bW9kZWx9IHNob3VsZCBiZSByZXR1cm5lZCBhcy1pcyBmb3Igc3RhbmRhcmQgdGllcmApO1xuICAgIGFzc2VydC5vayghcmVzdWx0LnJlYXNvbi5pbmNsdWRlcyhcIm5vdCBpbiB0aGUga25vd24gdGllciBtYXBcIiksIGAke21vZGVsfSBzaG91bGQgYmUgaW4gdGhlIGtub3duIHRpZXIgbWFwYCk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiIzI4ODU6IG9wZW5haS1jb2RleCBoZWF2eS10aWVyIG1vZGVscyBhcmUgcmVjb2duaXplZFwiLCAoKSA9PiB7XG4gIGNvbnN0IGNvbmZpZyA9IHsgLi4uZGVmYXVsdFJvdXRpbmdDb25maWcoKSwgZW5hYmxlZDogdHJ1ZSB9O1xuICBjb25zdCBoZWF2eU1vZGVscyA9IFtcImdwdC01XCIsIFwiZ3B0LTUtcHJvXCIsIFwiZ3B0LTUuMVwiLCBcImdwdC01LjJcIiwgXCJncHQtNS4yLWNvZGV4XCIsIFwiZ3B0LTUuMy1jb2RleFwiLCBcImdwdC01LjRcIiwgXCJncHQtNS41XCIsIFwibzQtbWluaVwiLCBcIm80LW1pbmktZGVlcC1yZXNlYXJjaFwiXTtcbiAgZm9yIChjb25zdCBtb2RlbCBvZiBoZWF2eU1vZGVscykge1xuICAgIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVNb2RlbEZvckNvbXBsZXhpdHkoXG4gICAgICBtYWtlQ2xhc3NpZmljYXRpb24oXCJoZWF2eVwiKSxcbiAgICAgIHsgcHJpbWFyeTogbW9kZWwsIGZhbGxiYWNrczogW10gfSxcbiAgICAgIGNvbmZpZyxcbiAgICAgIFttb2RlbCwgLi4uQVZBSUxBQkxFX01PREVMU10sXG4gICAgKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lndhc0Rvd25ncmFkZWQsIGZhbHNlLCBgJHttb2RlbH0gc2hvdWxkIGJlIGtub3duIGFzIGhlYXZ5IHRpZXJgKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm1vZGVsSWQsIG1vZGVsLCBgJHttb2RlbH0gc2hvdWxkIGJlIHJldHVybmVkIGFzLWlzIGZvciBoZWF2eSB0aWVyYCk7XG4gICAgYXNzZXJ0Lm9rKCFyZXN1bHQucmVhc29uLmluY2x1ZGVzKFwibm90IGluIHRoZSBrbm93biB0aWVyIG1hcFwiKSwgYCR7bW9kZWx9IHNob3VsZCBiZSBpbiB0aGUga25vd24gdGllciBtYXBgKTtcbiAgfVxufSk7XG5cbnRlc3QoXCIjMjg4NTogaGVhdnkgb3BlbmFpLWNvZGV4IG1vZGVsIGRvd25ncmFkZXMgdG8gbGlnaHQgZm9yIGxpZ2h0IHRhc2tcIiwgKCkgPT4ge1xuICBjb25zdCBjb25maWcgPSB7IC4uLmRlZmF1bHRSb3V0aW5nQ29uZmlnKCksIGVuYWJsZWQ6IHRydWUgfTtcbiAgY29uc3QgcmVzdWx0ID0gcmVzb2x2ZU1vZGVsRm9yQ29tcGxleGl0eShcbiAgICBtYWtlQ2xhc3NpZmljYXRpb24oXCJsaWdodFwiKSxcbiAgICB7IHByaW1hcnk6IFwiZ3B0LTUuNFwiLCBmYWxsYmFja3M6IFtdIH0sXG4gICAgY29uZmlnLFxuICAgIFtcImdwdC01LjRcIiwgXCJncHQtNC4xLW5hbm9cIiwgLi4uQVZBSUxBQkxFX01PREVMU10sXG4gICk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQud2FzRG93bmdyYWRlZCwgdHJ1ZSwgXCJoZWF2eSBtb2RlbCBzaG91bGQgZG93bmdyYWRlIGZvciBsaWdodCB0YXNrXCIpO1xuICAvLyBTaG91bGQgcGljayBhIGxpZ2h0LXRpZXIgbW9kZWxcbiAgYXNzZXJ0Lm5vdEVxdWFsKHJlc3VsdC5tb2RlbElkLCBcImdwdC01LjRcIiwgXCJzaG91bGQgbm90IHVzZSB0aGUgaGVhdnkgbW9kZWwgZm9yIGxpZ2h0IHRhc2tcIik7XG59KTtcbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBzY29yZU1vZGVsIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcInNjb3JlTW9kZWxcIiwgKCkgPT4ge1xuICBjb25zdCBzb25uZXRQcm9maWxlOiBNb2RlbENhcGFiaWxpdGllcyA9IE1PREVMX0NBUEFCSUxJVFlfUFJPRklMRVNbXCJjbGF1ZGUtc29ubmV0LTQtNlwiXSE7XG5cbiAgdGVzdChcInByb2R1Y2VzIGNvcnJlY3Qgd2VpZ2h0ZWQgYXZlcmFnZSBmb3IgdHdvIGRpbWVuc2lvbnMgKGNvZGluZzowLjksIGluc3RydWN0aW9uOjAuNylcIiwgKCkgPT4ge1xuICAgIC8vICgwLjkqODUgKyAwLjcqODUpIC8gKDAuOSswLjcpID0gKDc2LjUrNTkuNSkvMS42ID0gMTM2LzEuNiA9IDg1LjBcbiAgICBjb25zdCBzY29yZSA9IHNjb3JlTW9kZWwoc29ubmV0UHJvZmlsZSwgeyBjb2Rpbmc6IDAuOSwgaW5zdHJ1Y3Rpb246IDAuNyB9KTtcbiAgICBhc3NlcnQub2soTWF0aC5hYnMoc2NvcmUgLSA4NS4wKSA8IDAuMDEsIGBFeHBlY3RlZCB+ODUuMCwgZ290ICR7c2NvcmV9YCk7XG4gIH0pO1xuXG4gIHRlc3QoXCJyZXR1cm5zIDUwIHdoZW4gcmVxdWlyZW1lbnRzIGlzIGVtcHR5XCIsICgpID0+IHtcbiAgICBjb25zdCBzY29yZSA9IHNjb3JlTW9kZWwoc29ubmV0UHJvZmlsZSwge30pO1xuICAgIGFzc2VydC5lcXVhbChzY29yZSwgNTApO1xuICB9KTtcblxuICB0ZXN0KFwicmV0dXJucyBjb3JyZWN0IHNjb3JlIGZvciBzaW5nbGUgZGltZW5zaW9uIGNvZGluZzoxLjBcIiwgKCkgPT4ge1xuICAgIC8vIGNvZGluZz05MCBmb3IgY2xhdWRlLW9wdXMtNC02XG4gICAgY29uc3Qgb3B1c1Byb2ZpbGUgPSBNT0RFTF9DQVBBQklMSVRZX1BST0ZJTEVTW1wiY2xhdWRlLW9wdXMtNC02XCJdITtcbiAgICBjb25zdCBzY29yZSA9IHNjb3JlTW9kZWwob3B1c1Byb2ZpbGUsIHsgY29kaW5nOiAxLjAgfSk7XG4gICAgYXNzZXJ0LmVxdWFsKHNjb3JlLCA5NSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJoYW5kbGVzIGFsbCA3IGRpbWVuc2lvbnMgY29ycmVjdGx5XCIsICgpID0+IHtcbiAgICAvLyBVbmlmb3JtIHdlaWdodCAxLjAgb24gZXZlcnkgZGltIFx1MjE5MiBhdmVyYWdlIG9mIGFsbCBkaW0gdmFsdWVzXG4gICAgY29uc3QgcHJvZmlsZTogTW9kZWxDYXBhYmlsaXRpZXMgPSB7XG4gICAgICBjb2Rpbmc6IDYwLCBkZWJ1Z2dpbmc6IDYwLCByZXNlYXJjaDogNjAsIHJlYXNvbmluZzogNjAsXG4gICAgICBzcGVlZDogNjAsIGxvbmdDb250ZXh0OiA2MCwgaW5zdHJ1Y3Rpb246IDYwLFxuICAgIH07XG4gICAgY29uc3QgcmVxczogUGFydGlhbDxSZWNvcmQ8a2V5b2YgTW9kZWxDYXBhYmlsaXRpZXMsIG51bWJlcj4+ID0ge1xuICAgICAgY29kaW5nOiAxLjAsIGRlYnVnZ2luZzogMS4wLCByZXNlYXJjaDogMS4wLCByZWFzb25pbmc6IDEuMCxcbiAgICAgIHNwZWVkOiAxLjAsIGxvbmdDb250ZXh0OiAxLjAsIGluc3RydWN0aW9uOiAxLjAsXG4gICAgfTtcbiAgICBjb25zdCBzY29yZSA9IHNjb3JlTW9kZWwocHJvZmlsZSwgcmVxcyk7XG4gICAgYXNzZXJ0LmVxdWFsKHNjb3JlLCA2MCk7XG4gIH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBjb21wdXRlVGFza1JlcXVpcmVtZW50cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJjb21wdXRlVGFza1JlcXVpcmVtZW50c1wiLCAoKSA9PiB7XG4gIHRlc3QoXCJleGVjdXRlLXRhc2sgd2l0aCBubyBtZXRhZGF0YSByZXR1cm5zIGJhc2UgdmVjdG9yXCIsICgpID0+IHtcbiAgICBjb25zdCByZXEgPSBjb21wdXRlVGFza1JlcXVpcmVtZW50cyhcImV4ZWN1dGUtdGFza1wiLCB1bmRlZmluZWQpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVxLCB7IGNvZGluZzogMC45LCBpbnN0cnVjdGlvbjogMC43LCBzcGVlZDogMC4zIH0pO1xuICB9KTtcblxuICB0ZXN0KFwiZXhlY3V0ZS10YXNrIHdpdGggdGFnczpbJ2RvY3MnXSBhZGp1c3RzIHJlcXVpcmVtZW50c1wiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVxID0gY29tcHV0ZVRhc2tSZXF1aXJlbWVudHMoXCJleGVjdXRlLXRhc2tcIiwgeyB0YWdzOiBbXCJkb2NzXCJdIH0pO1xuICAgIGFzc2VydC5lcXVhbChyZXEuaW5zdHJ1Y3Rpb24sIDAuOSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlcS5jb2RpbmcsIDAuMyk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlcS5zcGVlZCwgMC43KTtcbiAgfSk7XG5cbiAgdGVzdChcImV4ZWN1dGUtdGFzayB3aXRoIHRhZ3M6Wydjb25maWcnXSBhZGp1c3RzIHJlcXVpcmVtZW50c1wiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVxID0gY29tcHV0ZVRhc2tSZXF1aXJlbWVudHMoXCJleGVjdXRlLXRhc2tcIiwgeyB0YWdzOiBbXCJjb25maWdcIl0gfSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlcS5pbnN0cnVjdGlvbiwgMC45KTtcbiAgfSk7XG5cbiAgdGVzdChcImV4ZWN1dGUtdGFzayB3aXRoIGNvbXBsZXhpdHlLZXl3b3JkczpbJ2NvbmN1cnJlbmN5J10gYm9vc3RzIGRlYnVnZ2luZyBhbmQgcmVhc29uaW5nXCIsICgpID0+IHtcbiAgICBjb25zdCByZXEgPSBjb21wdXRlVGFza1JlcXVpcmVtZW50cyhcImV4ZWN1dGUtdGFza1wiLCB7IGNvbXBsZXhpdHlLZXl3b3JkczogW1wiY29uY3VycmVuY3lcIl0gfSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlcS5kZWJ1Z2dpbmcsIDAuOSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlcS5yZWFzb25pbmcsIDAuOCk7XG4gIH0pO1xuXG4gIHRlc3QoXCJleGVjdXRlLXRhc2sgd2l0aCBjb21wbGV4aXR5S2V5d29yZHM6WydtaWdyYXRpb24nXSBib29zdHMgcmVhc29uaW5nIGFuZCBjb2RpbmdcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlcSA9IGNvbXB1dGVUYXNrUmVxdWlyZW1lbnRzKFwiZXhlY3V0ZS10YXNrXCIsIHsgY29tcGxleGl0eUtleXdvcmRzOiBbXCJtaWdyYXRpb25cIl0gfSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlcS5yZWFzb25pbmcsIDAuOSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlcS5jb2RpbmcsIDAuOCk7XG4gIH0pO1xuXG4gIHRlc3QoXCJleGVjdXRlLXRhc2sgd2l0aCBmaWxlQ291bnQ6OCBib29zdHMgY29kaW5nIGFuZCByZWFzb25pbmdcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlcSA9IGNvbXB1dGVUYXNrUmVxdWlyZW1lbnRzKFwiZXhlY3V0ZS10YXNrXCIsIHsgZmlsZUNvdW50OiA4IH0pO1xuICAgIGFzc2VydC5lcXVhbChyZXEuY29kaW5nLCAwLjkpO1xuICAgIGFzc2VydC5lcXVhbChyZXEucmVhc29uaW5nLCAwLjcpO1xuICB9KTtcblxuICB0ZXN0KFwiZXhlY3V0ZS10YXNrIHdpdGggZXN0aW1hdGVkTGluZXM6NjAwIGJvb3N0cyBjb2RpbmcgYW5kIHJlYXNvbmluZ1wiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVxID0gY29tcHV0ZVRhc2tSZXF1aXJlbWVudHMoXCJleGVjdXRlLXRhc2tcIiwgeyBlc3RpbWF0ZWRMaW5lczogNjAwIH0pO1xuICAgIGFzc2VydC5lcXVhbChyZXEuY29kaW5nLCAwLjkpO1xuICAgIGFzc2VydC5lcXVhbChyZXEucmVhc29uaW5nLCAwLjcpO1xuICB9KTtcblxuICB0ZXN0KFwicmVzZWFyY2gtbWlsZXN0b25lIHJldHVybnMgY29ycmVjdCBiYXNlIHZlY3RvclwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVxID0gY29tcHV0ZVRhc2tSZXF1aXJlbWVudHMoXCJyZXNlYXJjaC1taWxlc3RvbmVcIik7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXEsIHsgcmVzZWFyY2g6IDAuOSwgbG9uZ0NvbnRleHQ6IDAuNywgcmVhc29uaW5nOiAwLjUgfSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJwbGFuLXNsaWNlIHJldHVybnMgY29ycmVjdCBiYXNlIHZlY3RvclwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVxID0gY29tcHV0ZVRhc2tSZXF1aXJlbWVudHMoXCJwbGFuLXNsaWNlXCIpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVxLCB7IHJlYXNvbmluZzogMC45LCBjb2Rpbmc6IDAuNSB9KTtcbiAgfSk7XG5cbiAgdGVzdChcInVua25vd24tdW5pdC10eXBlIHJldHVybnMgZGVmYXVsdCByZWFzb25pbmcgcmVxdWlyZW1lbnRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlcSA9IGNvbXB1dGVUYXNrUmVxdWlyZW1lbnRzKFwidW5rbm93bi11bml0LXR5cGVcIik7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXEsIHsgcmVhc29uaW5nOiAwLjUgfSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJub24tZXhlY3V0ZS10YXNrIHdpdGggbWV0YWRhdGEgaWdub3JlcyBtZXRhZGF0YSByZWZpbmVtZW50c1wiLCAoKSA9PiB7XG4gICAgLy8gcmVzZWFyY2gtbWlsZXN0b25lIHNob3VsZCByZXR1cm4gdGhlIHNhbWUgdmVjdG9yIHJlZ2FyZGxlc3Mgb2YgbWV0YWRhdGFcbiAgICBjb25zdCByZXFXaXRoTWV0YSA9IGNvbXB1dGVUYXNrUmVxdWlyZW1lbnRzKFwicmVzZWFyY2gtbWlsZXN0b25lXCIsIHsgdGFnczogW1wiZG9jc1wiXSwgZmlsZUNvdW50OiAxMCB9KTtcbiAgICBjb25zdCByZXFXaXRob3V0ID0gY29tcHV0ZVRhc2tSZXF1aXJlbWVudHMoXCJyZXNlYXJjaC1taWxlc3RvbmVcIik7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXFXaXRoTWV0YSwgcmVxV2l0aG91dCk7XG4gIH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBzY29yZUVsaWdpYmxlTW9kZWxzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcInNjb3JlRWxpZ2libGVNb2RlbHNcIiwgKCkgPT4ge1xuICB0ZXN0KFwicmFua3MgbW9kZWxzIGJ5IHNjb3JlIGRlc2NlbmRpbmcgd2hlbiBzY29yZXMgZGlmZmVyIGJ5IG1vcmUgdGhhbiAyXCIsICgpID0+IHtcbiAgICAvLyByZXNlYXJjaDogaGVhdmlseSB3ZWlnaHRzIHJlc2VhcmNoIGRpbWVuc2lvbi4gZ2VtaW5pLTIuNS1wcm8gaGFzIDg1IHJlc2VhcmNoIHZzIHNvbm5ldCdzIDc1XG4gICAgY29uc3QgcmVxdWlyZW1lbnRzID0geyByZXNlYXJjaDogMC45LCBsb25nQ29udGV4dDogMC43LCByZWFzb25pbmc6IDAuNSB9O1xuICAgIGNvbnN0IHJlc3VsdHMgPSBzY29yZUVsaWdpYmxlTW9kZWxzKFtcImNsYXVkZS1zb25uZXQtNC02XCIsIFwiZ2VtaW5pLTIuNS1wcm9cIl0sIHJlcXVpcmVtZW50cyk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdHMubGVuZ3RoLCAyKTtcbiAgICBhc3NlcnQub2socmVzdWx0c1swXS5zY29yZSA+PSByZXN1bHRzWzFdLnNjb3JlLCBcIlNob3VsZCBiZSBzb3J0ZWQgYnkgc2NvcmUgZGVzY2VuZGluZ1wiKTtcbiAgfSk7XG5cbiAgdGVzdChcIndpdGhpbiAyLXBvaW50IHRocmVzaG9sZCwgcHJlZmVycyBjaGVhcGVyIG1vZGVsXCIsICgpID0+IHtcbiAgICAvLyBVc2UgbW9kZWxzIHdpdGhvdXQgYnVpbHQtaW4gcHJvZmlsZXMgKGJvdGggZ2V0IHNjb3JlIDUwKSBzbyB0aWUtYnJlYWsgYXBwbGllc1xuICAgIC8vIFRoZW4gdXNlIGtub3duIG1vZGVscyB3aXRoIGVxdWFsIHNjb3JlczogZm9yY2UgdGhpcyB2aWEgc2luZ2xlIHVua25vd24gbW9kZWwgcGFpclxuICAgIGNvbnN0IHJlcXVpcmVtZW50cyA9IHsgY29kaW5nOiAxLjAgfTtcbiAgICAvLyBtb2RlbC1hIGFuZCBtb2RlbC1iIGFyZSBib3RoIHVua25vd24gXHUyMTkyIHNjb3JlPTUwLCBjb3N0PUluZmluaXR5IFx1MjE5MiBsZXhpY29ncmFwaGljXG4gICAgY29uc3QgcmVzdWx0cyA9IHNjb3JlRWxpZ2libGVNb2RlbHMoW1wibW9kZWwtelwiLCBcIm1vZGVsLWFcIl0sIHJlcXVpcmVtZW50cyk7XG4gICAgLy8gQm90aCB1bmtub3duOiBzY29yZT01MCAod2l0aGluIDIpLCBjb3N0PUluZmluaXR5IChlcXVhbCkgXHUyMTkyIGxleDogbW9kZWwtYSBmaXJzdFxuICAgIGFzc2VydC5lcXVhbChyZXN1bHRzWzBdLm1vZGVsSWQsIFwibW9kZWwtYVwiKTtcbiAgfSk7XG5cbiAgdGVzdChcInNpbmdsZSBtb2RlbCByZXR1cm5zIGFycmF5IG9mIG9uZVwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0cyA9IHNjb3JlRWxpZ2libGVNb2RlbHMoW1wiY2xhdWRlLXNvbm5ldC00LTZcIl0sIHsgY29kaW5nOiAwLjkgfSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdHMubGVuZ3RoLCAxKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0c1swXS5tb2RlbElkLCBcImNsYXVkZS1zb25uZXQtNC02XCIpO1xuICB9KTtcblxuICB0ZXN0KFwidW5rbm93biBtb2RlbCB3aXRoIG5vIHByb2ZpbGUgZ2V0cyBzY29yZSBvZiA1MFwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0cyA9IHNjb3JlRWxpZ2libGVNb2RlbHMoW1widG90YWxseS11bmtub3duLW1vZGVsXCJdLCB7IGNvZGluZzogMS4wIH0pO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHRzWzBdLnNjb3JlLCA1MCk7XG4gIH0pO1xuXG4gIHRlc3QoXCJjYXBhYmlsaXR5T3ZlcnJpZGVzIGRlZXAtbWVyZ2VzIHdpdGggYnVpbHQtaW4gcHJvZmlsZVwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVxdWlyZW1lbnRzID0geyBjb2Rpbmc6IDEuMCB9O1xuICAgIC8vIE92ZXJyaWRlIHNvbm5ldCdzIGNvZGluZyB0byAzMCBcdTIwMTQgZ3B0LTRvIChjb2Rpbmc9ODApIHNob3VsZCB3aW5cbiAgICBjb25zdCByZXN1bHRzID0gc2NvcmVFbGlnaWJsZU1vZGVscyhcbiAgICAgIFtcImNsYXVkZS1zb25uZXQtNC02XCIsIFwiZ3B0LTRvXCJdLFxuICAgICAgcmVxdWlyZW1lbnRzLFxuICAgICAgeyBcImNsYXVkZS1zb25uZXQtNC02XCI6IHsgY29kaW5nOiAzMCB9IH0sXG4gICAgKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0c1swXS5tb2RlbElkLCBcImdwdC00b1wiLCBcImdwdC00byBzaG91bGQgcmFuayBmaXJzdCBhZnRlciBjb2Rpbmcgb3ZlcnJpZGVcIik7XG4gIH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBnZXRFbGlnaWJsZU1vZGVscyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJnZXRFbGlnaWJsZU1vZGVsc1wiLCAoKSA9PiB7XG4gIGNvbnN0IEFMTF9NT0RFTFMgPSBbXG4gICAgXCJjbGF1ZGUtb3B1cy00LTZcIiwgICAvLyBoZWF2eVxuICAgIFwiY2xhdWRlLXNvbm5ldC00LTZcIiwgLy8gc3RhbmRhcmRcbiAgICBcImNsYXVkZS1oYWlrdS00LTVcIiwgIC8vIGxpZ2h0XG4gICAgXCJncHQtNG8tbWluaVwiLCAgICAgICAvLyBsaWdodFxuICAgIFwiZ3B0LTRvXCIsICAgICAgICAgICAgLy8gc3RhbmRhcmRcbiAgXTtcblxuICB0ZXN0KFwicmV0dXJucyBsaWdodC10aWVyIG1vZGVscyBmcm9tIGF2YWlsYWJsZSBsaXN0IHNvcnRlZCBieSBjb3N0XCIsICgpID0+IHtcbiAgICBjb25zdCBjb25maWc6IER5bmFtaWNSb3V0aW5nQ29uZmlnID0gZGVmYXVsdFJvdXRpbmdDb25maWcoKTtcbiAgICBjb25zdCByZXN1bHQgPSBnZXRFbGlnaWJsZU1vZGVscyhcImxpZ2h0XCIsIEFMTF9NT0RFTFMsIGNvbmZpZyk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5sZW5ndGggPj0gMSk7XG4gICAgZm9yIChjb25zdCBpZCBvZiByZXN1bHQpIHtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgW1wiY2xhdWRlLWhhaWt1LTQtNVwiLCBcImdwdC00by1taW5pXCJdLmluY2x1ZGVzKGlkKSxcbiAgICAgICAgYEV4cGVjdGVkIGxpZ2h0LXRpZXIgbW9kZWwsIGdvdCAke2lkfWAsXG4gICAgICApO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcInJldHVybnMgc3RhbmRhcmQtdGllciBtb2RlbHMgZnJvbSBhdmFpbGFibGUgbGlzdCBzb3J0ZWQgYnkgY29zdFwiLCAoKSA9PiB7XG4gICAgY29uc3QgY29uZmlnOiBEeW5hbWljUm91dGluZ0NvbmZpZyA9IGRlZmF1bHRSb3V0aW5nQ29uZmlnKCk7XG4gICAgY29uc3QgcmVzdWx0ID0gZ2V0RWxpZ2libGVNb2RlbHMoXCJzdGFuZGFyZFwiLCBBTExfTU9ERUxTLCBjb25maWcpO1xuICAgIGFzc2VydC5vayhyZXN1bHQubGVuZ3RoID49IDEpO1xuICAgIGZvciAoY29uc3QgaWQgb2YgcmVzdWx0KSB7XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgIFtcImNsYXVkZS1zb25uZXQtNC02XCIsIFwiZ3B0LTRvXCJdLmluY2x1ZGVzKGlkKSxcbiAgICAgICAgYEV4cGVjdGVkIHN0YW5kYXJkLXRpZXIgbW9kZWwsIGdvdCAke2lkfWAsXG4gICAgICApO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcInRpZXJfbW9kZWxzIHBpbm5lZCBtb2RlbCByZXR1cm5zIHNpbmdsZS1lbGVtZW50IGFycmF5XCIsICgpID0+IHtcbiAgICBjb25zdCBjb25maWc6IER5bmFtaWNSb3V0aW5nQ29uZmlnID0ge1xuICAgICAgLi4uZGVmYXVsdFJvdXRpbmdDb25maWcoKSxcbiAgICAgIHRpZXJfbW9kZWxzOiB7IGxpZ2h0OiBcImdwdC00by1taW5pXCIgfSxcbiAgICB9O1xuICAgIGNvbnN0IHJlc3VsdCA9IGdldEVsaWdpYmxlTW9kZWxzKFwibGlnaHRcIiwgQUxMX01PREVMUywgY29uZmlnKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdCwgW1wiZ3B0LTRvLW1pbmlcIl0pO1xuICB9KTtcblxuICB0ZXN0KFwiZW1wdHkgYXZhaWxhYmxlIGxpc3QgcmV0dXJucyBlbXB0eSBhcnJheVwiLCAoKSA9PiB7XG4gICAgY29uc3QgY29uZmlnOiBEeW5hbWljUm91dGluZ0NvbmZpZyA9IGRlZmF1bHRSb3V0aW5nQ29uZmlnKCk7XG4gICAgY29uc3QgcmVzdWx0ID0gZ2V0RWxpZ2libGVNb2RlbHMoXCJsaWdodFwiLCBbXSwgY29uZmlnKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lmxlbmd0aCwgMCk7XG4gIH0pO1xuXG4gIHRlc3QoXCJ1bmtub3duIG1vZGVscyBjbGFzc2lmaWVkIGFzIHN0YW5kYXJkIGFwcGVhciBpbiBzdGFuZGFyZCB0aWVyIHJlc3VsdHNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGNvbmZpZzogRHluYW1pY1JvdXRpbmdDb25maWcgPSBkZWZhdWx0Um91dGluZ0NvbmZpZygpO1xuICAgIC8vIHVua25vd24tbW9kZWwteHl6IGhhcyBubyBlbnRyeSBcdTIxOTIgZGVmYXVsdHMgdG8gc3RhbmRhcmQgdGllclxuICAgIGNvbnN0IHJlc3VsdCA9IGdldEVsaWdpYmxlTW9kZWxzKFwic3RhbmRhcmRcIiwgW1widW5rbm93bi1tb2RlbC14eXpcIl0sIGNvbmZpZyk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcyhcInVua25vd24tbW9kZWwteHl6XCIpLCBcIlVua25vd24gbW9kZWwgc2hvdWxkIGFwcGVhciBpbiBzdGFuZGFyZCB0aWVyXCIpO1xuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgY2FwYWJpbGl0eS1hd2FyZSByb3V0aW5nIGludGVncmF0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcImNhcGFiaWxpdHktYXdhcmUgcm91dGluZyBpbnRlZ3JhdGlvblwiLCAoKSA9PiB7XG4gIC8vIEFsbCBzdGFuZGFyZC10aWVyIG1vZGVscyBhdmFpbGFibGUgYWxvbmdzaWRlIGhlYXZ5IChvcHVzKVxuICBjb25zdCBNVUxUSV9NT0RFTF9BVkFJTEFCTEUgPSBbXG4gICAgXCJjbGF1ZGUtb3B1cy00LTZcIixcbiAgICBcImNsYXVkZS1zb25uZXQtNC02XCIsXG4gICAgXCJncHQtNG9cIixcbiAgICBcImdlbWluaS0yLjUtcHJvXCIsXG4gICAgXCJjbGF1ZGUtaGFpa3UtNC01XCIsXG4gICAgXCJncHQtNG8tbWluaVwiLFxuICBdO1xuXG4gIC8vIDEuIEZ1bGwgcGlwZWxpbmUgd2l0aCBjYXBhYmlsaXR5IHNjb3JpbmcgYWN0aXZlXG4gIHRlc3QoXCJmdWxsIHBpcGVsaW5lIHdpdGggY2FwYWJpbGl0eV9yb3V0aW5nOiB0cnVlIHJldHVybnMgY2FwYWJpbGl0eS1zY29yZWQgZGVjaXNpb25cIiwgKCkgPT4ge1xuICAgIGNvbnN0IGNvbmZpZzogRHluYW1pY1JvdXRpbmdDb25maWcgPSB7IC4uLmRlZmF1bHRSb3V0aW5nQ29uZmlnKCksIGVuYWJsZWQ6IHRydWUsIGNhcGFiaWxpdHlfcm91dGluZzogdHJ1ZSB9O1xuICAgIC8vIENvbmZpZ3VyZWQgcHJpbWFyeSBpcyBvcHVzIChoZWF2eSkgXHUyMDE0IHN0YW5kYXJkIHRpZXIgc2hvdWxkIHRyaWdnZXIgY2FwYWJpbGl0eSBzY29yaW5nXG4gICAgY29uc3QgcmVzdWx0ID0gcmVzb2x2ZU1vZGVsRm9yQ29tcGxleGl0eShcbiAgICAgIHsgdGllcjogXCJzdGFuZGFyZFwiLCByZWFzb246IFwidGVzdFwiLCBkb3duZ3JhZGVkOiBmYWxzZSB9LFxuICAgICAgeyBwcmltYXJ5OiBcImNsYXVkZS1vcHVzLTQtNlwiLCBmYWxsYmFja3M6IFtdIH0sXG4gICAgICBjb25maWcsXG4gICAgICBNVUxUSV9NT0RFTF9BVkFJTEFCTEUsXG4gICAgICBcImV4ZWN1dGUtdGFza1wiLFxuICAgICAgeyB0YWdzOiBbXSwgY29tcGxleGl0eUtleXdvcmRzOiBbXSwgZmlsZUNvdW50OiAzLCBlc3RpbWF0ZWRMaW5lczogMTAwLCBjb2RlQmxvY2tDb3VudDogMCB9LFxuICAgICk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zZWxlY3Rpb25NZXRob2QsIFwiY2FwYWJpbGl0eS1zY29yZWRcIiwgXCJzaG91bGQgdXNlIGNhcGFiaWxpdHkgc2NvcmluZyB3aGVuIGVuYWJsZWQgd2l0aCBtdWx0aXBsZSBlbGlnaWJsZSBtb2RlbHNcIik7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5jYXBhYmlsaXR5U2NvcmVzICE9PSB1bmRlZmluZWQsIFwiY2FwYWJpbGl0eVNjb3JlcyBzaG91bGQgYmUgcG9wdWxhdGVkXCIpO1xuICAgIGFzc2VydC5vayhPYmplY3Qua2V5cyhyZXN1bHQuY2FwYWJpbGl0eVNjb3JlcyEpLmxlbmd0aCA+IDEsIFwic2hvdWxkIGhhdmUgc2NvcmVzIGZvciBtdWx0aXBsZSBtb2RlbHNcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC53YXNEb3duZ3JhZGVkLCB0cnVlLCBcInNob3VsZCBiZSBkb3duZ3JhZGVkIGZyb20gb3B1c1wiKTtcbiAgfSk7XG5cbiAgLy8gMi4gY2FwYWJpbGl0eV9yb3V0aW5nOiBmYWxzZSBmYWxscyBiYWNrIHRvIHRpZXItb25seVxuICB0ZXN0KFwiY2FwYWJpbGl0eV9yb3V0aW5nOiBmYWxzZSBza2lwcyBzY29yaW5nIGFuZCB1c2VzIHRpZXItb25seVwiLCAoKSA9PiB7XG4gICAgY29uc3QgY29uZmlnOiBEeW5hbWljUm91dGluZ0NvbmZpZyA9IHsgLi4uZGVmYXVsdFJvdXRpbmdDb25maWcoKSwgZW5hYmxlZDogdHJ1ZSwgY2FwYWJpbGl0eV9yb3V0aW5nOiBmYWxzZSB9O1xuICAgIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVNb2RlbEZvckNvbXBsZXhpdHkoXG4gICAgICB7IHRpZXI6IFwic3RhbmRhcmRcIiwgcmVhc29uOiBcInRlc3RcIiwgZG93bmdyYWRlZDogZmFsc2UgfSxcbiAgICAgIHsgcHJpbWFyeTogXCJjbGF1ZGUtb3B1cy00LTZcIiwgZmFsbGJhY2tzOiBbXSB9LFxuICAgICAgY29uZmlnLFxuICAgICAgTVVMVElfTU9ERUxfQVZBSUxBQkxFLFxuICAgICAgXCJleGVjdXRlLXRhc2tcIixcbiAgICAgIHVuZGVmaW5lZCxcbiAgICApO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc2VsZWN0aW9uTWV0aG9kLCBcInRpZXItb25seVwiLCBcImNhcGFiaWxpdHlfcm91dGluZzogZmFsc2Ugc2hvdWxkIHVzZSB0aWVyLW9ubHlcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5jYXBhYmlsaXR5U2NvcmVzLCB1bmRlZmluZWQsIFwiY2FwYWJpbGl0eVNjb3JlcyBzaG91bGQgYmUgdW5kZWZpbmVkIGZvciB0aWVyLW9ubHlcIik7XG4gIH0pO1xuXG4gIC8vIDMuIFNpbmdsZSBlbGlnaWJsZSBtb2RlbCBza2lwcyBzY29yaW5nXG4gIHRlc3QoXCJzaW5nbGUgZWxpZ2libGUgbW9kZWwgc2tpcHMgY2FwYWJpbGl0eSBzY29yaW5nIGFuZCB1c2VzIHRpZXItb25seVwiLCAoKSA9PiB7XG4gICAgY29uc3QgY29uZmlnOiBEeW5hbWljUm91dGluZ0NvbmZpZyA9IHtcbiAgICAgIC4uLmRlZmF1bHRSb3V0aW5nQ29uZmlnKCksXG4gICAgICBlbmFibGVkOiB0cnVlLFxuICAgICAgY2FwYWJpbGl0eV9yb3V0aW5nOiB0cnVlLFxuICAgICAgdGllcl9tb2RlbHM6IHsgc3RhbmRhcmQ6IFwiY2xhdWRlLXNvbm5ldC00LTZcIiB9LFxuICAgIH07XG4gICAgLy8gUGluIHRvIHNpbmdsZSBzdGFuZGFyZCBtb2RlbCBcdTIwMTQgZWxpZ2libGUubGVuZ3RoID09PSAxIFx1MjE5MiBza2lwcyBTVEVQIDJcbiAgICBjb25zdCByZXN1bHQgPSByZXNvbHZlTW9kZWxGb3JDb21wbGV4aXR5KFxuICAgICAgeyB0aWVyOiBcInN0YW5kYXJkXCIsIHJlYXNvbjogXCJ0ZXN0XCIsIGRvd25ncmFkZWQ6IGZhbHNlIH0sXG4gICAgICB7IHByaW1hcnk6IFwiY2xhdWRlLW9wdXMtNC02XCIsIGZhbGxiYWNrczogW10gfSxcbiAgICAgIGNvbmZpZyxcbiAgICAgIE1VTFRJX01PREVMX0FWQUlMQUJMRSxcbiAgICAgIFwiZXhlY3V0ZS10YXNrXCIsXG4gICAgICB1bmRlZmluZWQsXG4gICAgKTtcbiAgICAvLyBTaW5nbGUgcGlubmVkIG1vZGVsIFx1MjE5MiB0aWVyLW9ubHkgKG5vIHNjb3JpbmcgbmVlZGVkKVxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc2VsZWN0aW9uTWV0aG9kLCBcInRpZXItb25seVwiLCBcInNpbmdsZSBlbGlnaWJsZSBtb2RlbCBzaG91bGQgdXNlIHRpZXItb25seVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm1vZGVsSWQsIFwiY2xhdWRlLXNvbm5ldC00LTZcIiwgXCJzaG91bGQgdXNlIHRoZSBwaW5uZWQgbW9kZWxcIik7XG4gIH0pO1xuXG4gIC8vIDQuIFVua25vd24gbW9kZWwgd2l0aCBubyBwcm9maWxlIGdldHMgdW5pZm9ybSA1MHMgYW5kIGNvbXBldGVzXG4gIHRlc3QoXCJ1bmtub3duIG1vZGVsIHdpdGggbm8gcHJvZmlsZSBnZXRzIHVuaWZvcm0gc2NvcmUgb2YgNTAgYW5kIGNhbiBjb21wZXRlXCIsICgpID0+IHtcbiAgICBjb25zdCB1bmtub3duTW9kZWwgPSBcInVua25vd24tZnV0dXJlLW1vZGVsLXh5elwiO1xuICAgIGNvbnN0IGNvbmZpZzogRHluYW1pY1JvdXRpbmdDb25maWcgPSB7IC4uLmRlZmF1bHRSb3V0aW5nQ29uZmlnKCksIGVuYWJsZWQ6IHRydWUsIGNhcGFiaWxpdHlfcm91dGluZzogdHJ1ZSB9O1xuICAgIC8vIEFkZCB1bmtub3duIG1vZGVsIHRvIGF2YWlsYWJsZSBsaXN0IGF0IHN0YW5kYXJkIHRpZXIgKHVua25vd24gXHUyMTkyIHN0YW5kYXJkIHBlciBELTE1KVxuICAgIC8vIHNjb3Jpbmcgc2hvdWxkIHN0aWxsIHdvcmsgd2l0aCBzY29yZT01MCBmb3IgdGhlIHVua25vd24gbW9kZWxcbiAgICBjb25zdCByZXF1aXJlbWVudHMgPSB7IGNvZGluZzogMC45LCBpbnN0cnVjdGlvbjogMC43LCBzcGVlZDogMC4zIH07XG4gICAgY29uc3Qgc2NvcmVkID0gc2NvcmVFbGlnaWJsZU1vZGVscyhbdW5rbm93bk1vZGVsLCBcImNsYXVkZS1zb25uZXQtNC02XCJdLCByZXF1aXJlbWVudHMpO1xuICAgIGNvbnN0IHVua25vd25FbnRyeSA9IHNjb3JlZC5maW5kKHMgPT4gcy5tb2RlbElkID09PSB1bmtub3duTW9kZWwpO1xuICAgIGFzc2VydC5vayh1bmtub3duRW50cnkgIT09IHVuZGVmaW5lZCwgXCJ1bmtub3duIG1vZGVsIHNob3VsZCBiZSBpbiBzY29yZWQgcmVzdWx0c1wiKTtcbiAgICAvLyBVbmtub3duIG1vZGVsIGdldHMgdW5pZm9ybSA1MHM6ICgwLjkqNTAgKyAwLjcqNTAgKyAwLjMqNTApIC8gKDAuOSswLjcrMC4zKSBcdTIyNDggNTBcbiAgICBhc3NlcnQub2soTWF0aC5hYnModW5rbm93bkVudHJ5IS5zY29yZSAtIDUwKSA8IDAuMDEsIGBleHBlY3RlZCBzY29yZSB+NTAsIGdvdCAke3Vua25vd25FbnRyeSEuc2NvcmV9YCk7XG4gIH0pO1xuXG4gIC8vIDUuIENhcGFiaWxpdHkgb3ZlcnJpZGVzIGNoYW5nZSBzY29yaW5nIG91dGNvbWVcbiAgdGVzdChcImNhcGFiaWxpdHlPdmVycmlkZXMgYm9vc3QgYSBtb2RlbCBhYm92ZSBhbm90aGVyIGZvciBzYW1lIHRhc2tcIiwgKCkgPT4ge1xuICAgIC8vIHNvbm5ldDogY29kaW5nPTg1LCBncHQtNG86IGNvZGluZz04MC4gT3ZlcnJpZGUgZ3B0LTRvIGNvZGluZyB0byA5OSBcdTIxOTIgZ3B0LTRvIHNob3VsZCB3aW4uXG4gICAgY29uc3QgcmVxdWlyZW1lbnRzID0geyBjb2Rpbmc6IDEuMCB9O1xuICAgIGNvbnN0IG92ZXJyaWRlcyA9IHsgXCJncHQtNG9cIjogeyBjb2Rpbmc6IDk5IH0gfTtcbiAgICBjb25zdCBzY29yZWQgPSBzY29yZUVsaWdpYmxlTW9kZWxzKFtcImNsYXVkZS1zb25uZXQtNC02XCIsIFwiZ3B0LTRvXCJdLCByZXF1aXJlbWVudHMsIG92ZXJyaWRlcyk7XG4gICAgYXNzZXJ0LmVxdWFsKHNjb3JlZFswXS5tb2RlbElkLCBcImdwdC00b1wiLCBcIm92ZXJyaWRkZW4gbW9kZWwgc2hvdWxkIHdpbiBmb3IgY29kaW5nLWhlYXZ5IHRhc2tcIik7XG4gICAgYXNzZXJ0Lm9rKHNjb3JlZFswXS5zY29yZSA+IDkwLCBgZXhwZWN0ZWQgc2NvcmUgPiA5MCBhZnRlciBvdmVycmlkZSwgZ290ICR7c2NvcmVkWzBdLnNjb3JlfWApO1xuICB9KTtcblxuICAvLyA1Yi4gQ2FwYWJpbGl0eSBvdmVycmlkZXMgcGFzcyB0aHJvdWdoIHJlc29sdmVNb2RlbEZvckNvbXBsZXhpdHkgdG8gc2NvcmVFbGlnaWJsZU1vZGVsc1xuICB0ZXN0KFwicmVzb2x2ZU1vZGVsRm9yQ29tcGxleGl0eSBwYXNzZXMgY2FwYWJpbGl0eU92ZXJyaWRlcyB0byBzY29yaW5nIHN0ZXBcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGNvbmZpZzogRHluYW1pY1JvdXRpbmdDb25maWcgPSB7IC4uLmRlZmF1bHRSb3V0aW5nQ29uZmlnKCksIGVuYWJsZWQ6IHRydWUsIGNhcGFiaWxpdHlfcm91dGluZzogdHJ1ZSB9O1xuICAgIC8vIHNvbm5ldCBjb2Rpbmc9ODUsIGdwdC00byBjb2Rpbmc9ODAuIE92ZXJyaWRlIGdwdC00byBjb2RpbmcgdG8gOTkgXHUyMTkyIGdwdC00byBzaG91bGQgd2luLlxuICAgIGNvbnN0IG92ZXJyaWRlczogUmVjb3JkPHN0cmluZywgUGFydGlhbDxNb2RlbENhcGFiaWxpdGllcz4+ID0geyBcImdwdC00b1wiOiB7IGNvZGluZzogOTkgfSB9O1xuICAgIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVNb2RlbEZvckNvbXBsZXhpdHkoXG4gICAgICB7IHRpZXI6IFwic3RhbmRhcmRcIiwgcmVhc29uOiBcInRlc3RcIiwgZG93bmdyYWRlZDogZmFsc2UgfSxcbiAgICAgIHsgcHJpbWFyeTogXCJjbGF1ZGUtb3B1cy00LTZcIiwgZmFsbGJhY2tzOiBbXSB9LFxuICAgICAgY29uZmlnLFxuICAgICAgW1wiY2xhdWRlLW9wdXMtNC02XCIsIFwiY2xhdWRlLXNvbm5ldC00LTZcIiwgXCJncHQtNG9cIl0sXG4gICAgICBcImV4ZWN1dGUtdGFza1wiLFxuICAgICAgdW5kZWZpbmVkLFxuICAgICAgb3ZlcnJpZGVzLFxuICAgICk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zZWxlY3Rpb25NZXRob2QsIFwiY2FwYWJpbGl0eS1zY29yZWRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5tb2RlbElkLCBcImdwdC00b1wiLCBcImdwdC00byBzaG91bGQgd2luIHdpdGggY29kaW5nIG92ZXJyaWRlXCIpO1xuICB9KTtcblxuICAvLyA2LiBSZWdyZXNzaW9uOiBleGlzdGluZyByb3V0aW5nIGd1YXJkcyB1bmNoYW5nZWRcbiAgdGVzdChcInJlZ3Jlc3Npb246IHJvdXRpbmctZGlzYWJsZWQgcGFzc3Rocm91Z2ggc3RpbGwgcmV0dXJucyB0aWVyLW9ubHlcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGNvbmZpZzogRHluYW1pY1JvdXRpbmdDb25maWcgPSB7IC4uLmRlZmF1bHRSb3V0aW5nQ29uZmlnKCksIGVuYWJsZWQ6IGZhbHNlIH07XG4gICAgY29uc3QgcmVzdWx0ID0gcmVzb2x2ZU1vZGVsRm9yQ29tcGxleGl0eShcbiAgICAgIHsgdGllcjogXCJsaWdodFwiLCByZWFzb246IFwidGVzdFwiLCBkb3duZ3JhZGVkOiBmYWxzZSB9LFxuICAgICAgeyBwcmltYXJ5OiBcImNsYXVkZS1vcHVzLTQtNlwiLCBmYWxsYmFja3M6IFtdIH0sXG4gICAgICBjb25maWcsXG4gICAgICBNVUxUSV9NT0RFTF9BVkFJTEFCTEUsXG4gICAgICBcImV4ZWN1dGUtdGFza1wiLFxuICAgICAgdW5kZWZpbmVkLFxuICAgICk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zZWxlY3Rpb25NZXRob2QsIFwidGllci1vbmx5XCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQud2FzRG93bmdyYWRlZCwgZmFsc2UpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQubW9kZWxJZCwgXCJjbGF1ZGUtb3B1cy00LTZcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJyZWdyZXNzaW9uOiB1bmtub3duLW1vZGVsIGJ5cGFzcyByZXR1cm5zIHRpZXItb25seSBhbmQgZG9lcyBub3QgZG93bmdyYWRlXCIsICgpID0+IHtcbiAgICBjb25zdCBjb25maWc6IER5bmFtaWNSb3V0aW5nQ29uZmlnID0geyAuLi5kZWZhdWx0Um91dGluZ0NvbmZpZygpLCBlbmFibGVkOiB0cnVlIH07XG4gICAgY29uc3QgcmVzdWx0ID0gcmVzb2x2ZU1vZGVsRm9yQ29tcGxleGl0eShcbiAgICAgIHsgdGllcjogXCJsaWdodFwiLCByZWFzb246IFwidGVzdFwiLCBkb3duZ3JhZGVkOiBmYWxzZSB9LFxuICAgICAgeyBwcmltYXJ5OiBcInRvdGFsbHktdW5rbm93bi1jdXN0b20tbW9kZWxcIiwgZmFsbGJhY2tzOiBbXSB9LFxuICAgICAgY29uZmlnLFxuICAgICAgW1widG90YWxseS11bmtub3duLWN1c3RvbS1tb2RlbFwiLCAuLi5NVUxUSV9NT0RFTF9BVkFJTEFCTEVdLFxuICAgICAgXCJleGVjdXRlLXRhc2tcIixcbiAgICAgIHVuZGVmaW5lZCxcbiAgICApO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc2VsZWN0aW9uTWV0aG9kLCBcInRpZXItb25seVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lndhc0Rvd25ncmFkZWQsIGZhbHNlKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm1vZGVsSWQsIFwidG90YWxseS11bmtub3duLWN1c3RvbS1tb2RlbFwiKTtcbiAgfSk7XG5cbiAgdGVzdChcInJlZ3Jlc3Npb246IG5vLWRvd25ncmFkZS1uZWVkZWQgcGF0aCByZXR1cm5zIHRpZXItb25seVwiLCAoKSA9PiB7XG4gICAgY29uc3QgY29uZmlnOiBEeW5hbWljUm91dGluZ0NvbmZpZyA9IHsgLi4uZGVmYXVsdFJvdXRpbmdDb25maWcoKSwgZW5hYmxlZDogdHJ1ZSwgY2FwYWJpbGl0eV9yb3V0aW5nOiB0cnVlIH07XG4gICAgLy8gQ29uZmlndXJlZCBtb2RlbCBpcyBzb25uZXQgKHN0YW5kYXJkKSwgcmVxdWVzdGluZyBzdGFuZGFyZCBcdTIxOTIgbm8gZG93bmdyYWRlIG5lZWRlZFxuICAgIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVNb2RlbEZvckNvbXBsZXhpdHkoXG4gICAgICB7IHRpZXI6IFwic3RhbmRhcmRcIiwgcmVhc29uOiBcInRlc3RcIiwgZG93bmdyYWRlZDogZmFsc2UgfSxcbiAgICAgIHsgcHJpbWFyeTogXCJjbGF1ZGUtc29ubmV0LTQtNlwiLCBmYWxsYmFja3M6IFtdIH0sXG4gICAgICBjb25maWcsXG4gICAgICBNVUxUSV9NT0RFTF9BVkFJTEFCTEUsXG4gICAgICBcImV4ZWN1dGUtdGFza1wiLFxuICAgICAgdW5kZWZpbmVkLFxuICAgICk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zZWxlY3Rpb25NZXRob2QsIFwidGllci1vbmx5XCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQud2FzRG93bmdyYWRlZCwgZmFsc2UpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQubW9kZWxJZCwgXCJjbGF1ZGUtc29ubmV0LTQtNlwiKTtcbiAgfSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGdldE1vZGVsVGllciB1bmtub3duIGRlZmF1bHQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiZ2V0TW9kZWxUaWVyIHVua25vd24gZGVmYXVsdFwiLCAoKSA9PiB7XG4gIHRlc3QoXCJ1bmtub3duIG1vZGVsIHJldHVybnMgc3RhbmRhcmQgdGllciAobm90IGhlYXZ5KSB2aWEgZG93bmdyYWRlIGJlaGF2aW9yXCIsICgpID0+IHtcbiAgICAvLyBXZSBjYW4gdmVyaWZ5IHRoaXMgaW5kaXJlY3RseTogcmVzb2x2ZU1vZGVsRm9yQ29tcGxleGl0eSBmb3IgYSBzdGFuZGFyZCBjbGFzc2lmaWNhdGlvblxuICAgIC8vIHdpdGggYW4gdW5rbm93biBwcmltYXJ5IG1vZGVsIHNob3VsZCBOT1QgZG93bmdyYWRlIChiZWNhdXNlIHVua25vd24gXHUyMTkyIHN0YW5kYXJkLCBub3QgaGVhdnkpXG4gICAgY29uc3QgY29uZmlnID0geyAuLi5kZWZhdWx0Um91dGluZ0NvbmZpZygpLCBlbmFibGVkOiB0cnVlIH07XG4gICAgLy8gVXNlIFwidW5rbm93bi1tb2RlbC14eXpcIiBhcyBwcmltYXJ5IFx1MjAxNCBpdHMgdGllciB3aWxsIGJlIFwic3RhbmRhcmRcIiBwZXIgRC0xNVxuICAgIC8vIENsYXNzaWZpY2F0aW9uIGlzIFwiaGVhdnlcIiBcdTIxOTIgdGllciA+PSBzdGFuZGFyZCBcdTIxOTIgbm8gZG93bmdyYWRlXG4gICAgLy8gQnV0IHVua25vd24gbW9kZWxzIHVzZSB0aGUgaXNLbm93bk1vZGVsKCkgZ3VhcmQsIHNvIHRoZXkgcGFzcyB0aHJvdWdoIGFueXdheVxuICAgIC8vIFRlc3QgdGhlIHBvc2l0aXZlOiBhbiB1bmtub3duIG1vZGVsIGlzIE5PVCB0cmVhdGVkIGFzIGhlYXZ5XG4gICAgY29uc3QgcmVzdWx0ID0gcmVzb2x2ZU1vZGVsRm9yQ29tcGxleGl0eShcbiAgICAgIG1ha2VDbGFzc2lmaWNhdGlvbihcInN0YW5kYXJkXCIpLFxuICAgICAgeyBwcmltYXJ5OiBcImNsYXVkZS1zb25uZXQtNC02XCIsIGZhbGxiYWNrczogW10gfSxcbiAgICAgIGNvbmZpZyxcbiAgICAgIFtcImNsYXVkZS1zb25uZXQtNC02XCIsIFwiY2xhdWRlLWhhaWt1LTQtNVwiLCBcImdwdC00by1taW5pXCJdLFxuICAgICk7XG4gICAgLy8gc3RhbmRhcmQgY2xhc3NpZmljYXRpb24gd2l0aCBzdGFuZGFyZCBtb2RlbCAoc29ubmV0KSBcdTIxOTIgbm8gZG93bmdyYWRlXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC53YXNEb3duZ3JhZGVkLCBmYWxzZSwgXCJzdGFuZGFyZCBtb2RlbCBzaG91bGQgbm90IGRvd25ncmFkZSBmb3Igc3RhbmRhcmQgdGFza1wiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm1vZGVsSWQsIFwiY2xhdWRlLXNvbm5ldC00LTZcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJ1bmtub3duIG1vZGVsIGluIGdldEVsaWdpYmxlTW9kZWxzIGRlZmF1bHRzIHRvIHN0YW5kYXJkIHRpZXJcIiwgKCkgPT4ge1xuICAgIC8vIFBlciBELTE1OiBnZXRNb2RlbFRpZXIgcmV0dXJucyBcInN0YW5kYXJkXCIgZm9yIHVua25vd24gbW9kZWxzXG4gICAgY29uc3QgY29uZmlnOiBEeW5hbWljUm91dGluZ0NvbmZpZyA9IGRlZmF1bHRSb3V0aW5nQ29uZmlnKCk7XG4gICAgY29uc3Qgc3RhbmRhcmRNb2RlbHMgPSBnZXRFbGlnaWJsZU1vZGVscyhcInN0YW5kYXJkXCIsIFtcInRvdGFsbHktdW5rbm93bi1tb2RlbC1hYmNcIl0sIGNvbmZpZyk7XG4gICAgY29uc3QgbGlnaHRNb2RlbHMgPSBnZXRFbGlnaWJsZU1vZGVscyhcImxpZ2h0XCIsIFtcInRvdGFsbHktdW5rbm93bi1tb2RlbC1hYmNcIl0sIGNvbmZpZyk7XG4gICAgY29uc3QgaGVhdnlNb2RlbHMgPSBnZXRFbGlnaWJsZU1vZGVscyhcImhlYXZ5XCIsIFtcInRvdGFsbHktdW5rbm93bi1tb2RlbC1hYmNcIl0sIGNvbmZpZyk7XG4gICAgYXNzZXJ0Lm9rKHN0YW5kYXJkTW9kZWxzLmluY2x1ZGVzKFwidG90YWxseS11bmtub3duLW1vZGVsLWFiY1wiKSwgXCJVbmtub3duIG1vZGVsIHNob3VsZCBiZSBpbiBzdGFuZGFyZCB0aWVyXCIpO1xuICAgIGFzc2VydC5lcXVhbChsaWdodE1vZGVscy5sZW5ndGgsIDAsIFwiVW5rbm93biBtb2RlbCBzaG91bGQgTk9UIGJlIGluIGxpZ2h0IHRpZXJcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGhlYXZ5TW9kZWxzLmxlbmd0aCwgMCwgXCJVbmtub3duIG1vZGVsIHNob3VsZCBOT1QgYmUgaW4gaGVhdnkgdGllclwiKTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUVBLE9BQU8sUUFBUSxnQkFBZ0I7QUFDL0IsT0FBTyxZQUFZO0FBRW5CO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUdQLFNBQVMsb0JBQW9CLDRCQUE0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
