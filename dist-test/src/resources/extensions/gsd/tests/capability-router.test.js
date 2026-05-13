import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreModel,
  computeTaskRequirements,
  scoreEligibleModels,
  getEligibleModels,
  resolveModelForComplexity,
  MODEL_CAPABILITY_PROFILES,
  MODEL_CAPABILITY_TIER,
  BASE_REQUIREMENTS,
  defaultRoutingConfig
} from "../model-router.js";
describe("scoreModel", () => {
  const sonnetProfile = {
    coding: 85,
    debugging: 80,
    research: 75,
    reasoning: 80,
    speed: 60,
    longContext: 75,
    instruction: 85
  };
  test("produces correct weighted average for single dimension", () => {
    const score = scoreModel(sonnetProfile, { coding: 1 });
    assert.equal(score, 85);
  });
  test("produces correct weighted average for two dimensions (coding 0.9, instruction 0.7)", () => {
    const score = scoreModel(sonnetProfile, { coding: 0.9, instruction: 0.7 });
    assert.ok(Math.abs(score - 85) < 0.01, `Expected ~85.0, got ${score}`);
  });
  test("returns 50 when requirements is empty", () => {
    const score = scoreModel(sonnetProfile, {});
    assert.equal(score, 50);
  });
  test("uses 50 as fallback for unknown dimension in requirements", () => {
    const score = scoreModel(sonnetProfile, { coding: 0.5, unknown: 1 });
    assert.ok(score > 61 && score < 62, `Expected ~61.67, got ${score}`);
  });
});
describe("computeTaskRequirements", () => {
  test("execute-task with no metadata returns base requirements", () => {
    const req = computeTaskRequirements("execute-task", void 0);
    assert.deepStrictEqual(req, { coding: 0.9, instruction: 0.7, speed: 0.3 });
  });
  test("execute-task with docs tag returns docs-adjusted requirements", () => {
    const req = computeTaskRequirements("execute-task", { tags: ["docs"] });
    assert.equal(req.instruction, 0.9);
    assert.equal(req.coding, 0.3);
    assert.equal(req.speed, 0.7);
  });
  test("execute-task with readme tag returns docs-adjusted requirements", () => {
    const req = computeTaskRequirements("execute-task", { tags: ["readme"] });
    assert.equal(req.instruction, 0.9);
  });
  test("execute-task with concurrency keyword boosts debugging and reasoning", () => {
    const req = computeTaskRequirements("execute-task", { complexityKeywords: ["concurrency"] });
    assert.equal(req.debugging, 0.9);
    assert.equal(req.reasoning, 0.8);
  });
  test("execute-task with compatibility keyword boosts debugging and reasoning", () => {
    const req = computeTaskRequirements("execute-task", { complexityKeywords: ["compatibility"] });
    assert.equal(req.debugging, 0.9);
    assert.equal(req.reasoning, 0.8);
  });
  test("execute-task with migration keyword boosts reasoning and coding", () => {
    const req = computeTaskRequirements("execute-task", { complexityKeywords: ["migration"] });
    assert.equal(req.reasoning, 0.9);
    assert.equal(req.coding, 0.8);
  });
  test("execute-task with architecture keyword boosts reasoning and coding", () => {
    const req = computeTaskRequirements("execute-task", { complexityKeywords: ["architecture"] });
    assert.equal(req.reasoning, 0.9);
    assert.equal(req.coding, 0.8);
  });
  test("execute-task with fileCount >= 6 boosts coding and reasoning", () => {
    const req = computeTaskRequirements("execute-task", { fileCount: 8 });
    assert.equal(req.coding, 0.9);
    assert.equal(req.reasoning, 0.7);
  });
  test("execute-task with fileCount exactly 6 triggers large-file boost", () => {
    const req = computeTaskRequirements("execute-task", { fileCount: 6 });
    assert.equal(req.coding, 0.9);
    assert.equal(req.reasoning, 0.7);
  });
  test("execute-task with estimatedLines >= 500 boosts coding and reasoning", () => {
    const req = computeTaskRequirements("execute-task", { estimatedLines: 500 });
    assert.equal(req.coding, 0.9);
    assert.equal(req.reasoning, 0.7);
  });
  test("research-milestone with no metadata returns base requirements", () => {
    const req = computeTaskRequirements("research-milestone", void 0);
    assert.deepStrictEqual(req, { research: 0.9, longContext: 0.7, reasoning: 0.5 });
  });
  test("unknown unit type returns default reasoning requirement", () => {
    const req = computeTaskRequirements("unknown-type", void 0);
    assert.deepStrictEqual(req, { reasoning: 0.5 });
  });
});
describe("MODEL_CAPABILITY_PROFILES", () => {
  test("contains profiles for all tier-mapped models", () => {
    const tierModels = Object.keys(MODEL_CAPABILITY_TIER);
    for (const model of tierModels) {
      assert.ok(MODEL_CAPABILITY_PROFILES[model], `Missing profile for ${model}`);
    }
  });
  test("each profile has all 7 capability dimensions", () => {
    const dims = [
      "coding",
      "debugging",
      "research",
      "reasoning",
      "speed",
      "longContext",
      "instruction"
    ];
    for (const [modelId, profile] of Object.entries(MODEL_CAPABILITY_PROFILES)) {
      for (const dim of dims) {
        assert.ok(profile[dim] !== void 0, `${modelId} missing dimension ${dim}`);
        assert.ok(profile[dim] >= 0 && profile[dim] <= 100, `${modelId}.${dim} out of range`);
      }
    }
  });
  test("claude-opus-4-6 has high reasoning and coding", () => {
    const opus = MODEL_CAPABILITY_PROFILES["claude-opus-4-6"];
    assert.ok(opus.reasoning >= 90, `Expected reasoning >= 90, got ${opus.reasoning}`);
    assert.ok(opus.coding >= 90, `Expected coding >= 90, got ${opus.coding}`);
  });
  test("claude-haiku-4-5 has high speed but lower reasoning", () => {
    const haiku = MODEL_CAPABILITY_PROFILES["claude-haiku-4-5"];
    assert.ok(haiku.speed >= 90, `Expected speed >= 90, got ${haiku.speed}`);
    assert.ok(haiku.reasoning < 70, `Expected reasoning < 70, got ${haiku.reasoning}`);
  });
});
describe("BASE_REQUIREMENTS", () => {
  test("contains all 11 unit types", () => {
    const required = [
      "execute-task",
      "research-milestone",
      "research-slice",
      "plan-milestone",
      "plan-slice",
      "replan-slice",
      "reassess-roadmap",
      "complete-slice",
      "run-uat",
      "discuss-milestone",
      "complete-milestone"
    ];
    for (const unitType of required) {
      assert.ok(BASE_REQUIREMENTS[unitType], `Missing requirements for ${unitType}`);
    }
  });
});
describe("scoreEligibleModels", () => {
  test("returns array sorted by score descending", () => {
    const requirements = { research: 0.9, longContext: 0.7, reasoning: 0.5 };
    const results = scoreEligibleModels(["claude-sonnet-4-6", "gpt-4o"], requirements);
    assert.ok(results.length === 2);
    assert.ok(results[0].score >= results[1].score, "Should be sorted descending by score");
  });
  test("returns single model when only one eligible", () => {
    const requirements = { coding: 0.9 };
    const results = scoreEligibleModels(["claude-sonnet-4-6"], requirements);
    assert.equal(results.length, 1);
    assert.equal(results[0].modelId, "claude-sonnet-4-6");
  });
  test("models without profiles get uniform 50s score", () => {
    const requirements = { coding: 1 };
    const results = scoreEligibleModels(["unknown-model-xyz"], requirements);
    assert.equal(results[0].score, 50);
  });
  test("when two models score within 2 points, prefers cheaper model", () => {
    const requirements = { speed: 1 };
    const results = scoreEligibleModels(["gpt-4o-mini", "gemini-2.0-flash"], requirements);
    assert.equal(results[0].modelId, "gemini-2.0-flash");
  });
  test("tie-breaks by lexicographic model ID when cost and score are equal", () => {
    const requirements = { coding: 1 };
    const results = scoreEligibleModels(["model-z", "model-a"], requirements);
    assert.equal(results[0].modelId, "model-a");
  });
  test("scoreEligibleModels respects capabilityOverrides", () => {
    const requirements = { coding: 1 };
    const results = scoreEligibleModels(
      ["claude-sonnet-4-6", "gpt-4o"],
      requirements,
      { "claude-sonnet-4-6": { coding: 30 } }
    );
    assert.equal(results[0].modelId, "gpt-4o");
  });
});
describe("getEligibleModels", () => {
  const MODELS = [
    "claude-opus-4-6",
    // heavy
    "claude-sonnet-4-6",
    // standard
    "claude-haiku-4-5",
    // light
    "gpt-4o-mini"
    // light
  ];
  test("returns light-tier models sorted by cost when no explicit config", () => {
    const config = defaultRoutingConfig();
    const result = getEligibleModels("light", MODELS, config);
    assert.ok(result.length >= 1);
    for (const id of result) {
      assert.ok(
        ["claude-haiku-4-5", "gpt-4o-mini"].includes(id),
        `Expected light-tier model, got ${id}`
      );
    }
  });
  test("returns explicit tier_models when configured and available", () => {
    const config = {
      ...defaultRoutingConfig(),
      tier_models: { light: "gpt-4o-mini" }
    };
    const result = getEligibleModels("light", MODELS, config);
    assert.deepStrictEqual(result, ["gpt-4o-mini"]);
  });
  test("returns empty array when no eligible models for tier", () => {
    const config = defaultRoutingConfig();
    const result = getEligibleModels("light", ["claude-opus-4-6"], config);
    assert.equal(result.length, 0);
  });
});
describe("DynamicRoutingConfig.capability_routing", () => {
  test("defaultRoutingConfig includes capability_routing: true", () => {
    const config = defaultRoutingConfig();
    assert.equal(config.capability_routing, true);
  });
});
describe("RoutingDecision.selectionMethod", () => {
  const MODELS = ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5", "gpt-4o-mini"];
  function makeClassification(tier) {
    return { tier, reason: "test", downgraded: false };
  }
  test("returns selectionMethod: tier-only when routing is disabled", () => {
    const config = { ...defaultRoutingConfig(), enabled: false };
    const result = resolveModelForComplexity(
      makeClassification("light"),
      { primary: "claude-opus-4-6", fallbacks: [] },
      config,
      MODELS
    );
    assert.equal(result.selectionMethod, "tier-only");
  });
  test("returns selectionMethod: tier-only for no phase config passthrough", () => {
    const config = { ...defaultRoutingConfig(), enabled: true };
    const result = resolveModelForComplexity(
      makeClassification("light"),
      void 0,
      config,
      MODELS
    );
    assert.equal(result.selectionMethod, "tier-only");
  });
  test("returns selectionMethod: tier-only for unknown model passthrough", () => {
    const config = { ...defaultRoutingConfig(), enabled: true };
    const result = resolveModelForComplexity(
      makeClassification("light"),
      { primary: "custom-provider/my-model-v3", fallbacks: [] },
      config,
      ["custom-provider/my-model-v3", ...MODELS]
    );
    assert.equal(result.selectionMethod, "tier-only");
  });
  test("returns selectionMethod: tier-only for no-downgrade passthrough", () => {
    const config = { ...defaultRoutingConfig(), enabled: true };
    const result = resolveModelForComplexity(
      makeClassification("heavy"),
      { primary: "claude-opus-4-6", fallbacks: [] },
      config,
      MODELS
    );
    assert.equal(result.selectionMethod, "tier-only");
  });
  test("returns selectionMethod: tier-only when downgraded", () => {
    const config = { ...defaultRoutingConfig(), enabled: true };
    const result = resolveModelForComplexity(
      makeClassification("light"),
      { primary: "claude-opus-4-6", fallbacks: [] },
      config,
      MODELS
    );
    assert.equal(result.selectionMethod, "tier-only");
  });
});
describe("profile completeness (ADR-004 lint)", () => {
  test("every model in MODEL_CAPABILITY_TIER has a MODEL_CAPABILITY_PROFILES entry", () => {
    const tierModels = Object.keys(MODEL_CAPABILITY_TIER);
    const missing = tierModels.filter((id) => !MODEL_CAPABILITY_PROFILES[id]);
    assert.equal(
      missing.length,
      0,
      `Models in MODEL_CAPABILITY_TIER but missing from MODEL_CAPABILITY_PROFILES:
  ${missing.join("\n  ")}

Add capability profiles for these models in model-router.ts.`
    );
  });
  test("MODEL_CAPABILITY_PROFILES does not contain models absent from MODEL_CAPABILITY_TIER", () => {
    const profileModels = Object.keys(MODEL_CAPABILITY_PROFILES);
    const orphaned = profileModels.filter((id) => !MODEL_CAPABILITY_TIER[id]);
    assert.equal(
      orphaned.length,
      0,
      `Models in MODEL_CAPABILITY_PROFILES but not in MODEL_CAPABILITY_TIER:
  ${orphaned.join("\n  ")}

Either add these to MODEL_CAPABILITY_TIER or remove stale profiles.`
    );
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jYXBhYmlsaXR5LXJvdXRlci50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBHU0QgRXh0ZW5zaW9uIFx1MjAxNCBDYXBhYmlsaXR5LUF3YXJlIFJvdXRlciBUZXN0c1xuLy8gVGVzdHMgZm9yIG5ldyBjYXBhYmlsaXR5IHNjb3JpbmcgZnVuY3Rpb25zIGFuZCBkYXRhIHRhYmxlcyAoUGxhbiAwMS0wMSlcblxuaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcblxuaW1wb3J0IHtcbiAgc2NvcmVNb2RlbCxcbiAgY29tcHV0ZVRhc2tSZXF1aXJlbWVudHMsXG4gIHNjb3JlRWxpZ2libGVNb2RlbHMsXG4gIGdldEVsaWdpYmxlTW9kZWxzLFxuICByZXNvbHZlTW9kZWxGb3JDb21wbGV4aXR5LFxuICBNT0RFTF9DQVBBQklMSVRZX1BST0ZJTEVTLFxuICBNT0RFTF9DQVBBQklMSVRZX1RJRVIsXG4gIEJBU0VfUkVRVUlSRU1FTlRTLFxuICBkZWZhdWx0Um91dGluZ0NvbmZpZyxcbn0gZnJvbSBcIi4uL21vZGVsLXJvdXRlci5qc1wiO1xuaW1wb3J0IHR5cGUgeyBNb2RlbENhcGFiaWxpdGllcywgRHluYW1pY1JvdXRpbmdDb25maWcsIFJvdXRpbmdEZWNpc2lvbiB9IGZyb20gXCIuLi9tb2RlbC1yb3V0ZXIuanNcIjtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHNjb3JlTW9kZWwgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwic2NvcmVNb2RlbFwiLCAoKSA9PiB7XG4gIGNvbnN0IHNvbm5ldFByb2ZpbGU6IE1vZGVsQ2FwYWJpbGl0aWVzID0ge1xuICAgIGNvZGluZzogODUsIGRlYnVnZ2luZzogODAsIHJlc2VhcmNoOiA3NSwgcmVhc29uaW5nOiA4MCxcbiAgICBzcGVlZDogNjAsIGxvbmdDb250ZXh0OiA3NSwgaW5zdHJ1Y3Rpb246IDg1LFxuICB9O1xuXG4gIHRlc3QoXCJwcm9kdWNlcyBjb3JyZWN0IHdlaWdodGVkIGF2ZXJhZ2UgZm9yIHNpbmdsZSBkaW1lbnNpb25cIiwgKCkgPT4ge1xuICAgIC8vIE9ubHkgY29kaW5nIHdlaWdodCAxLjAgXHUyMTkyIHJlc3VsdCBzaG91bGQgYmUgdGhlIGNvZGluZyBzY29yZVxuICAgIGNvbnN0IHNjb3JlID0gc2NvcmVNb2RlbChzb25uZXRQcm9maWxlLCB7IGNvZGluZzogMS4wIH0pO1xuICAgIGFzc2VydC5lcXVhbChzY29yZSwgODUpO1xuICB9KTtcblxuICB0ZXN0KFwicHJvZHVjZXMgY29ycmVjdCB3ZWlnaHRlZCBhdmVyYWdlIGZvciB0d28gZGltZW5zaW9ucyAoY29kaW5nIDAuOSwgaW5zdHJ1Y3Rpb24gMC43KVwiLCAoKSA9PiB7XG4gICAgLy8gKDAuOSo4NSArIDAuNyo4NSkgLyAoMC45KzAuNykgPSAoNzYuNSs1OS41KS8xLjYgPSAxMzYvMS42ID0gODUuMFxuICAgIGNvbnN0IHNjb3JlID0gc2NvcmVNb2RlbChzb25uZXRQcm9maWxlLCB7IGNvZGluZzogMC45LCBpbnN0cnVjdGlvbjogMC43IH0pO1xuICAgIGFzc2VydC5vayhNYXRoLmFicyhzY29yZSAtIDg1LjApIDwgMC4wMSwgYEV4cGVjdGVkIH44NS4wLCBnb3QgJHtzY29yZX1gKTtcbiAgfSk7XG5cbiAgdGVzdChcInJldHVybnMgNTAgd2hlbiByZXF1aXJlbWVudHMgaXMgZW1wdHlcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHNjb3JlID0gc2NvcmVNb2RlbChzb25uZXRQcm9maWxlLCB7fSk7XG4gICAgYXNzZXJ0LmVxdWFsKHNjb3JlLCA1MCk7XG4gIH0pO1xuXG4gIHRlc3QoXCJ1c2VzIDUwIGFzIGZhbGxiYWNrIGZvciB1bmtub3duIGRpbWVuc2lvbiBpbiByZXF1aXJlbWVudHNcIiwgKCkgPT4ge1xuICAgIC8vICd1bmtub3duJyBkaW1lbnNpb24gbm90IGluIHByb2ZpbGUgXHUyMTkyIHRyZWF0ZWQgYXMgNTBcbiAgICBjb25zdCBzY29yZSA9IHNjb3JlTW9kZWwoc29ubmV0UHJvZmlsZSwgeyBjb2Rpbmc6IDAuNSwgdW5rbm93bjogMS4wIH0gYXMgYW55KTtcbiAgICAvLyAoMC41Kjg1ICsgMS4wKjUwKSAvICgwLjUrMS4wKSA9ICg0Mi41KzUwKS8xLjUgPSA5Mi41LzEuNSA9IDYxLjY3XG4gICAgYXNzZXJ0Lm9rKHNjb3JlID4gNjEgJiYgc2NvcmUgPCA2MiwgYEV4cGVjdGVkIH42MS42NywgZ290ICR7c2NvcmV9YCk7XG4gIH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBjb21wdXRlVGFza1JlcXVpcmVtZW50cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJjb21wdXRlVGFza1JlcXVpcmVtZW50c1wiLCAoKSA9PiB7XG4gIHRlc3QoXCJleGVjdXRlLXRhc2sgd2l0aCBubyBtZXRhZGF0YSByZXR1cm5zIGJhc2UgcmVxdWlyZW1lbnRzXCIsICgpID0+IHtcbiAgICBjb25zdCByZXEgPSBjb21wdXRlVGFza1JlcXVpcmVtZW50cyhcImV4ZWN1dGUtdGFza1wiLCB1bmRlZmluZWQpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVxLCB7IGNvZGluZzogMC45LCBpbnN0cnVjdGlvbjogMC43LCBzcGVlZDogMC4zIH0pO1xuICB9KTtcblxuICB0ZXN0KFwiZXhlY3V0ZS10YXNrIHdpdGggZG9jcyB0YWcgcmV0dXJucyBkb2NzLWFkanVzdGVkIHJlcXVpcmVtZW50c1wiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVxID0gY29tcHV0ZVRhc2tSZXF1aXJlbWVudHMoXCJleGVjdXRlLXRhc2tcIiwgeyB0YWdzOiBbXCJkb2NzXCJdIH0pO1xuICAgIGFzc2VydC5lcXVhbChyZXEuaW5zdHJ1Y3Rpb24sIDAuOSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlcS5jb2RpbmcsIDAuMyk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlcS5zcGVlZCwgMC43KTtcbiAgfSk7XG5cbiAgdGVzdChcImV4ZWN1dGUtdGFzayB3aXRoIHJlYWRtZSB0YWcgcmV0dXJucyBkb2NzLWFkanVzdGVkIHJlcXVpcmVtZW50c1wiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVxID0gY29tcHV0ZVRhc2tSZXF1aXJlbWVudHMoXCJleGVjdXRlLXRhc2tcIiwgeyB0YWdzOiBbXCJyZWFkbWVcIl0gfSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlcS5pbnN0cnVjdGlvbiwgMC45KTtcbiAgfSk7XG5cbiAgdGVzdChcImV4ZWN1dGUtdGFzayB3aXRoIGNvbmN1cnJlbmN5IGtleXdvcmQgYm9vc3RzIGRlYnVnZ2luZyBhbmQgcmVhc29uaW5nXCIsICgpID0+IHtcbiAgICBjb25zdCByZXEgPSBjb21wdXRlVGFza1JlcXVpcmVtZW50cyhcImV4ZWN1dGUtdGFza1wiLCB7IGNvbXBsZXhpdHlLZXl3b3JkczogW1wiY29uY3VycmVuY3lcIl0gfSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlcS5kZWJ1Z2dpbmcsIDAuOSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlcS5yZWFzb25pbmcsIDAuOCk7XG4gIH0pO1xuXG4gIHRlc3QoXCJleGVjdXRlLXRhc2sgd2l0aCBjb21wYXRpYmlsaXR5IGtleXdvcmQgYm9vc3RzIGRlYnVnZ2luZyBhbmQgcmVhc29uaW5nXCIsICgpID0+IHtcbiAgICBjb25zdCByZXEgPSBjb21wdXRlVGFza1JlcXVpcmVtZW50cyhcImV4ZWN1dGUtdGFza1wiLCB7IGNvbXBsZXhpdHlLZXl3b3JkczogW1wiY29tcGF0aWJpbGl0eVwiXSB9KTtcbiAgICBhc3NlcnQuZXF1YWwocmVxLmRlYnVnZ2luZywgMC45KTtcbiAgICBhc3NlcnQuZXF1YWwocmVxLnJlYXNvbmluZywgMC44KTtcbiAgfSk7XG5cbiAgdGVzdChcImV4ZWN1dGUtdGFzayB3aXRoIG1pZ3JhdGlvbiBrZXl3b3JkIGJvb3N0cyByZWFzb25pbmcgYW5kIGNvZGluZ1wiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVxID0gY29tcHV0ZVRhc2tSZXF1aXJlbWVudHMoXCJleGVjdXRlLXRhc2tcIiwgeyBjb21wbGV4aXR5S2V5d29yZHM6IFtcIm1pZ3JhdGlvblwiXSB9KTtcbiAgICBhc3NlcnQuZXF1YWwocmVxLnJlYXNvbmluZywgMC45KTtcbiAgICBhc3NlcnQuZXF1YWwocmVxLmNvZGluZywgMC44KTtcbiAgfSk7XG5cbiAgdGVzdChcImV4ZWN1dGUtdGFzayB3aXRoIGFyY2hpdGVjdHVyZSBrZXl3b3JkIGJvb3N0cyByZWFzb25pbmcgYW5kIGNvZGluZ1wiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVxID0gY29tcHV0ZVRhc2tSZXF1aXJlbWVudHMoXCJleGVjdXRlLXRhc2tcIiwgeyBjb21wbGV4aXR5S2V5d29yZHM6IFtcImFyY2hpdGVjdHVyZVwiXSB9KTtcbiAgICBhc3NlcnQuZXF1YWwocmVxLnJlYXNvbmluZywgMC45KTtcbiAgICBhc3NlcnQuZXF1YWwocmVxLmNvZGluZywgMC44KTtcbiAgfSk7XG5cbiAgdGVzdChcImV4ZWN1dGUtdGFzayB3aXRoIGZpbGVDb3VudCA+PSA2IGJvb3N0cyBjb2RpbmcgYW5kIHJlYXNvbmluZ1wiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVxID0gY29tcHV0ZVRhc2tSZXF1aXJlbWVudHMoXCJleGVjdXRlLXRhc2tcIiwgeyBmaWxlQ291bnQ6IDggfSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlcS5jb2RpbmcsIDAuOSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlcS5yZWFzb25pbmcsIDAuNyk7XG4gIH0pO1xuXG4gIHRlc3QoXCJleGVjdXRlLXRhc2sgd2l0aCBmaWxlQ291bnQgZXhhY3RseSA2IHRyaWdnZXJzIGxhcmdlLWZpbGUgYm9vc3RcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlcSA9IGNvbXB1dGVUYXNrUmVxdWlyZW1lbnRzKFwiZXhlY3V0ZS10YXNrXCIsIHsgZmlsZUNvdW50OiA2IH0pO1xuICAgIGFzc2VydC5lcXVhbChyZXEuY29kaW5nLCAwLjkpO1xuICAgIGFzc2VydC5lcXVhbChyZXEucmVhc29uaW5nLCAwLjcpO1xuICB9KTtcblxuICB0ZXN0KFwiZXhlY3V0ZS10YXNrIHdpdGggZXN0aW1hdGVkTGluZXMgPj0gNTAwIGJvb3N0cyBjb2RpbmcgYW5kIHJlYXNvbmluZ1wiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVxID0gY29tcHV0ZVRhc2tSZXF1aXJlbWVudHMoXCJleGVjdXRlLXRhc2tcIiwgeyBlc3RpbWF0ZWRMaW5lczogNTAwIH0pO1xuICAgIGFzc2VydC5lcXVhbChyZXEuY29kaW5nLCAwLjkpO1xuICAgIGFzc2VydC5lcXVhbChyZXEucmVhc29uaW5nLCAwLjcpO1xuICB9KTtcblxuICB0ZXN0KFwicmVzZWFyY2gtbWlsZXN0b25lIHdpdGggbm8gbWV0YWRhdGEgcmV0dXJucyBiYXNlIHJlcXVpcmVtZW50c1wiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVxID0gY29tcHV0ZVRhc2tSZXF1aXJlbWVudHMoXCJyZXNlYXJjaC1taWxlc3RvbmVcIiwgdW5kZWZpbmVkKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlcSwgeyByZXNlYXJjaDogMC45LCBsb25nQ29udGV4dDogMC43LCByZWFzb25pbmc6IDAuNSB9KTtcbiAgfSk7XG5cbiAgdGVzdChcInVua25vd24gdW5pdCB0eXBlIHJldHVybnMgZGVmYXVsdCByZWFzb25pbmcgcmVxdWlyZW1lbnRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlcSA9IGNvbXB1dGVUYXNrUmVxdWlyZW1lbnRzKFwidW5rbm93bi10eXBlXCIsIHVuZGVmaW5lZCk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXEsIHsgcmVhc29uaW5nOiAwLjUgfSk7XG4gIH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBNT0RFTF9DQVBBQklMSVRZX1BST0ZJTEVTIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcIk1PREVMX0NBUEFCSUxJVFlfUFJPRklMRVNcIiwgKCkgPT4ge1xuICB0ZXN0KFwiY29udGFpbnMgcHJvZmlsZXMgZm9yIGFsbCB0aWVyLW1hcHBlZCBtb2RlbHNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHRpZXJNb2RlbHMgPSBPYmplY3Qua2V5cyhNT0RFTF9DQVBBQklMSVRZX1RJRVIpO1xuICAgIGZvciAoY29uc3QgbW9kZWwgb2YgdGllck1vZGVscykge1xuICAgICAgYXNzZXJ0Lm9rKE1PREVMX0NBUEFCSUxJVFlfUFJPRklMRVNbbW9kZWxdLCBgTWlzc2luZyBwcm9maWxlIGZvciAke21vZGVsfWApO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcImVhY2ggcHJvZmlsZSBoYXMgYWxsIDcgY2FwYWJpbGl0eSBkaW1lbnNpb25zXCIsICgpID0+IHtcbiAgICBjb25zdCBkaW1zOiBBcnJheTxrZXlvZiBNb2RlbENhcGFiaWxpdGllcz4gPSBbXG4gICAgICBcImNvZGluZ1wiLCBcImRlYnVnZ2luZ1wiLCBcInJlc2VhcmNoXCIsIFwicmVhc29uaW5nXCIsXG4gICAgICBcInNwZWVkXCIsIFwibG9uZ0NvbnRleHRcIiwgXCJpbnN0cnVjdGlvblwiLFxuICAgIF07XG4gICAgZm9yIChjb25zdCBbbW9kZWxJZCwgcHJvZmlsZV0gb2YgT2JqZWN0LmVudHJpZXMoTU9ERUxfQ0FQQUJJTElUWV9QUk9GSUxFUykpIHtcbiAgICAgIGZvciAoY29uc3QgZGltIG9mIGRpbXMpIHtcbiAgICAgICAgYXNzZXJ0Lm9rKHByb2ZpbGVbZGltXSAhPT0gdW5kZWZpbmVkLCBgJHttb2RlbElkfSBtaXNzaW5nIGRpbWVuc2lvbiAke2RpbX1gKTtcbiAgICAgICAgYXNzZXJ0Lm9rKHByb2ZpbGVbZGltXSA+PSAwICYmIHByb2ZpbGVbZGltXSA8PSAxMDAsIGAke21vZGVsSWR9LiR7ZGltfSBvdXQgb2YgcmFuZ2VgKTtcbiAgICAgIH1cbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJjbGF1ZGUtb3B1cy00LTYgaGFzIGhpZ2ggcmVhc29uaW5nIGFuZCBjb2RpbmdcIiwgKCkgPT4ge1xuICAgIGNvbnN0IG9wdXMgPSBNT0RFTF9DQVBBQklMSVRZX1BST0ZJTEVTW1wiY2xhdWRlLW9wdXMtNC02XCJdO1xuICAgIGFzc2VydC5vayhvcHVzLnJlYXNvbmluZyA+PSA5MCwgYEV4cGVjdGVkIHJlYXNvbmluZyA+PSA5MCwgZ290ICR7b3B1cy5yZWFzb25pbmd9YCk7XG4gICAgYXNzZXJ0Lm9rKG9wdXMuY29kaW5nID49IDkwLCBgRXhwZWN0ZWQgY29kaW5nID49IDkwLCBnb3QgJHtvcHVzLmNvZGluZ31gKTtcbiAgfSk7XG5cbiAgdGVzdChcImNsYXVkZS1oYWlrdS00LTUgaGFzIGhpZ2ggc3BlZWQgYnV0IGxvd2VyIHJlYXNvbmluZ1wiLCAoKSA9PiB7XG4gICAgY29uc3QgaGFpa3UgPSBNT0RFTF9DQVBBQklMSVRZX1BST0ZJTEVTW1wiY2xhdWRlLWhhaWt1LTQtNVwiXTtcbiAgICBhc3NlcnQub2soaGFpa3Uuc3BlZWQgPj0gOTAsIGBFeHBlY3RlZCBzcGVlZCA+PSA5MCwgZ290ICR7aGFpa3Uuc3BlZWR9YCk7XG4gICAgYXNzZXJ0Lm9rKGhhaWt1LnJlYXNvbmluZyA8IDcwLCBgRXhwZWN0ZWQgcmVhc29uaW5nIDwgNzAsIGdvdCAke2hhaWt1LnJlYXNvbmluZ31gKTtcbiAgfSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEJBU0VfUkVRVUlSRU1FTlRTIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcIkJBU0VfUkVRVUlSRU1FTlRTXCIsICgpID0+IHtcbiAgdGVzdChcImNvbnRhaW5zIGFsbCAxMSB1bml0IHR5cGVzXCIsICgpID0+IHtcbiAgICBjb25zdCByZXF1aXJlZCA9IFtcbiAgICAgIFwiZXhlY3V0ZS10YXNrXCIsIFwicmVzZWFyY2gtbWlsZXN0b25lXCIsIFwicmVzZWFyY2gtc2xpY2VcIixcbiAgICAgIFwicGxhbi1taWxlc3RvbmVcIiwgXCJwbGFuLXNsaWNlXCIsIFwicmVwbGFuLXNsaWNlXCIsXG4gICAgICBcInJlYXNzZXNzLXJvYWRtYXBcIiwgXCJjb21wbGV0ZS1zbGljZVwiLCBcInJ1bi11YXRcIixcbiAgICAgIFwiZGlzY3Vzcy1taWxlc3RvbmVcIiwgXCJjb21wbGV0ZS1taWxlc3RvbmVcIixcbiAgICBdO1xuICAgIGZvciAoY29uc3QgdW5pdFR5cGUgb2YgcmVxdWlyZWQpIHtcbiAgICAgIGFzc2VydC5vayhCQVNFX1JFUVVJUkVNRU5UU1t1bml0VHlwZV0sIGBNaXNzaW5nIHJlcXVpcmVtZW50cyBmb3IgJHt1bml0VHlwZX1gKTtcbiAgICB9XG4gIH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBzY29yZUVsaWdpYmxlTW9kZWxzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcInNjb3JlRWxpZ2libGVNb2RlbHNcIiwgKCkgPT4ge1xuICB0ZXN0KFwicmV0dXJucyBhcnJheSBzb3J0ZWQgYnkgc2NvcmUgZGVzY2VuZGluZ1wiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVxdWlyZW1lbnRzID0geyByZXNlYXJjaDogMC45LCBsb25nQ29udGV4dDogMC43LCByZWFzb25pbmc6IDAuNSB9O1xuICAgIGNvbnN0IHJlc3VsdHMgPSBzY29yZUVsaWdpYmxlTW9kZWxzKFtcImNsYXVkZS1zb25uZXQtNC02XCIsIFwiZ3B0LTRvXCJdLCByZXF1aXJlbWVudHMpO1xuICAgIGFzc2VydC5vayhyZXN1bHRzLmxlbmd0aCA9PT0gMik7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdHNbMF0uc2NvcmUgPj0gcmVzdWx0c1sxXS5zY29yZSwgXCJTaG91bGQgYmUgc29ydGVkIGRlc2NlbmRpbmcgYnkgc2NvcmVcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJyZXR1cm5zIHNpbmdsZSBtb2RlbCB3aGVuIG9ubHkgb25lIGVsaWdpYmxlXCIsICgpID0+IHtcbiAgICBjb25zdCByZXF1aXJlbWVudHMgPSB7IGNvZGluZzogMC45IH07XG4gICAgY29uc3QgcmVzdWx0cyA9IHNjb3JlRWxpZ2libGVNb2RlbHMoW1wiY2xhdWRlLXNvbm5ldC00LTZcIl0sIHJlcXVpcmVtZW50cyk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdHMubGVuZ3RoLCAxKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0c1swXS5tb2RlbElkLCBcImNsYXVkZS1zb25uZXQtNC02XCIpO1xuICB9KTtcblxuICB0ZXN0KFwibW9kZWxzIHdpdGhvdXQgcHJvZmlsZXMgZ2V0IHVuaWZvcm0gNTBzIHNjb3JlXCIsICgpID0+IHtcbiAgICBjb25zdCByZXF1aXJlbWVudHMgPSB7IGNvZGluZzogMS4wIH07XG4gICAgY29uc3QgcmVzdWx0cyA9IHNjb3JlRWxpZ2libGVNb2RlbHMoW1widW5rbm93bi1tb2RlbC14eXpcIl0sIHJlcXVpcmVtZW50cyk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdHNbMF0uc2NvcmUsIDUwKTtcbiAgfSk7XG5cbiAgdGVzdChcIndoZW4gdHdvIG1vZGVscyBzY29yZSB3aXRoaW4gMiBwb2ludHMsIHByZWZlcnMgY2hlYXBlciBtb2RlbFwiLCAoKSA9PiB7XG4gICAgLy8gZ2VtaW5pLTIuMC1mbGFzaCBpcyBjaGVhcGVyIHRoYW4gZ3B0LTRvLW1pbmkgKCQwLjAwMDEgdnMgJDAuMDAwMTUpXG4gICAgLy8gVXNlIGEgcmVxdWlyZW1lbnQgdGhhdCBjYXVzZXMgc2ltaWxhciBzY29yZXMgZm9yIGJvdGhcbiAgICBjb25zdCByZXF1aXJlbWVudHMgPSB7IHNwZWVkOiAxLjAgfTtcbiAgICBjb25zdCByZXN1bHRzID0gc2NvcmVFbGlnaWJsZU1vZGVscyhbXCJncHQtNG8tbWluaVwiLCBcImdlbWluaS0yLjAtZmxhc2hcIl0sIHJlcXVpcmVtZW50cyk7XG4gICAgLy8gQm90aCBhcmUgaGlnaC1zcGVlZDogZ3B0LTRvLW1pbmk9OTAsIGdlbWluaS0yLjAtZmxhc2g9OTUgXHUyMDE0IHNjb3JlcyBkaWZmZXIgYnkgNSwgbm90IHdpdGhpbiAyXG4gICAgLy8gU28gdG9wIHNob3VsZCBiZSBnZW1pbmktMi4wLWZsYXNoIGJ5IHNjb3JlXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdHNbMF0ubW9kZWxJZCwgXCJnZW1pbmktMi4wLWZsYXNoXCIpO1xuICB9KTtcblxuICB0ZXN0KFwidGllLWJyZWFrcyBieSBsZXhpY29ncmFwaGljIG1vZGVsIElEIHdoZW4gY29zdCBhbmQgc2NvcmUgYXJlIGVxdWFsXCIsICgpID0+IHtcbiAgICAvLyBVc2UgbW9kZWxzIHdpdGhvdXQgY29zdCBlbnRyaWVzIFx1MjAxNCBib3RoIGdldCBJbmZpbml0eSBjb3N0XG4gICAgY29uc3QgcmVxdWlyZW1lbnRzID0geyBjb2Rpbmc6IDEuMCB9O1xuICAgIGNvbnN0IHJlc3VsdHMgPSBzY29yZUVsaWdpYmxlTW9kZWxzKFtcIm1vZGVsLXpcIiwgXCJtb2RlbC1hXCJdLCByZXF1aXJlbWVudHMpO1xuICAgIC8vIEJvdGggdW5rbm93biBcdTIxOTIgc2NvcmU9NTAsIGNvc3Q9SW5maW5pdHkgXHUyMTkyIHRpZWJyZWFrIGJ5IElEXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdHNbMF0ubW9kZWxJZCwgXCJtb2RlbC1hXCIpO1xuICB9KTtcblxuICB0ZXN0KFwic2NvcmVFbGlnaWJsZU1vZGVscyByZXNwZWN0cyBjYXBhYmlsaXR5T3ZlcnJpZGVzXCIsICgpID0+IHtcbiAgICBjb25zdCByZXF1aXJlbWVudHMgPSB7IGNvZGluZzogMS4wIH07XG4gICAgLy8gT3ZlcnJpZGUgY2xhdWRlLXNvbm5ldC00LTYncyBjb2RpbmcgdG8gMzAgKHdvcnNlKVxuICAgIGNvbnN0IHJlc3VsdHMgPSBzY29yZUVsaWdpYmxlTW9kZWxzKFxuICAgICAgW1wiY2xhdWRlLXNvbm5ldC00LTZcIiwgXCJncHQtNG9cIl0sXG4gICAgICByZXF1aXJlbWVudHMsXG4gICAgICB7IFwiY2xhdWRlLXNvbm5ldC00LTZcIjogeyBjb2Rpbmc6IDMwIH0gfSxcbiAgICApO1xuICAgIC8vIGdwdC00byBjb2Rpbmc9ODAgc2hvdWxkIGJlYXQgb3ZlcnJpZGRlbiBzb25uZXQgY29kaW5nPTMwXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdHNbMF0ubW9kZWxJZCwgXCJncHQtNG9cIik7XG4gIH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBnZXRFbGlnaWJsZU1vZGVscyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJnZXRFbGlnaWJsZU1vZGVsc1wiLCAoKSA9PiB7XG4gIGNvbnN0IE1PREVMUyA9IFtcbiAgICBcImNsYXVkZS1vcHVzLTQtNlwiLCAgICAgIC8vIGhlYXZ5XG4gICAgXCJjbGF1ZGUtc29ubmV0LTQtNlwiLCAgICAvLyBzdGFuZGFyZFxuICAgIFwiY2xhdWRlLWhhaWt1LTQtNVwiLCAgICAgLy8gbGlnaHRcbiAgICBcImdwdC00by1taW5pXCIsICAgICAgICAgIC8vIGxpZ2h0XG4gIF07XG5cbiAgdGVzdChcInJldHVybnMgbGlnaHQtdGllciBtb2RlbHMgc29ydGVkIGJ5IGNvc3Qgd2hlbiBubyBleHBsaWNpdCBjb25maWdcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGNvbmZpZzogRHluYW1pY1JvdXRpbmdDb25maWcgPSBkZWZhdWx0Um91dGluZ0NvbmZpZygpO1xuICAgIGNvbnN0IHJlc3VsdCA9IGdldEVsaWdpYmxlTW9kZWxzKFwibGlnaHRcIiwgTU9ERUxTLCBjb25maWcpO1xuICAgIGFzc2VydC5vayhyZXN1bHQubGVuZ3RoID49IDEpO1xuICAgIC8vIEFsbCByZXN1bHRzIHNob3VsZCBiZSBsaWdodC10aWVyXG4gICAgZm9yIChjb25zdCBpZCBvZiByZXN1bHQpIHtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgW1wiY2xhdWRlLWhhaWt1LTQtNVwiLCBcImdwdC00by1taW5pXCJdLmluY2x1ZGVzKGlkKSxcbiAgICAgICAgYEV4cGVjdGVkIGxpZ2h0LXRpZXIgbW9kZWwsIGdvdCAke2lkfWAsXG4gICAgICApO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcInJldHVybnMgZXhwbGljaXQgdGllcl9tb2RlbHMgd2hlbiBjb25maWd1cmVkIGFuZCBhdmFpbGFibGVcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGNvbmZpZzogRHluYW1pY1JvdXRpbmdDb25maWcgPSB7XG4gICAgICAuLi5kZWZhdWx0Um91dGluZ0NvbmZpZygpLFxuICAgICAgdGllcl9tb2RlbHM6IHsgbGlnaHQ6IFwiZ3B0LTRvLW1pbmlcIiB9LFxuICAgIH07XG4gICAgY29uc3QgcmVzdWx0ID0gZ2V0RWxpZ2libGVNb2RlbHMoXCJsaWdodFwiLCBNT0RFTFMsIGNvbmZpZyk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQsIFtcImdwdC00by1taW5pXCJdKTtcbiAgfSk7XG5cbiAgdGVzdChcInJldHVybnMgZW1wdHkgYXJyYXkgd2hlbiBubyBlbGlnaWJsZSBtb2RlbHMgZm9yIHRpZXJcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGNvbmZpZzogRHluYW1pY1JvdXRpbmdDb25maWcgPSBkZWZhdWx0Um91dGluZ0NvbmZpZygpO1xuICAgIC8vIE9ubHkgaGVhdnkgbW9kZWwgYXZhaWxhYmxlLCByZXF1ZXN0aW5nIGxpZ2h0XG4gICAgY29uc3QgcmVzdWx0ID0gZ2V0RWxpZ2libGVNb2RlbHMoXCJsaWdodFwiLCBbXCJjbGF1ZGUtb3B1cy00LTZcIl0sIGNvbmZpZyk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5sZW5ndGgsIDApO1xuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRHluYW1pY1JvdXRpbmdDb25maWcgZXh0ZW5zaW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcIkR5bmFtaWNSb3V0aW5nQ29uZmlnLmNhcGFiaWxpdHlfcm91dGluZ1wiLCAoKSA9PiB7XG4gIHRlc3QoXCJkZWZhdWx0Um91dGluZ0NvbmZpZyBpbmNsdWRlcyBjYXBhYmlsaXR5X3JvdXRpbmc6IHRydWVcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGNvbmZpZyA9IGRlZmF1bHRSb3V0aW5nQ29uZmlnKCk7XG4gICAgYXNzZXJ0LmVxdWFsKGNvbmZpZy5jYXBhYmlsaXR5X3JvdXRpbmcsIHRydWUpO1xuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUm91dGluZ0RlY2lzaW9uLnNlbGVjdGlvbk1ldGhvZCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJSb3V0aW5nRGVjaXNpb24uc2VsZWN0aW9uTWV0aG9kXCIsICgpID0+IHtcbiAgY29uc3QgTU9ERUxTID0gW1wiY2xhdWRlLW9wdXMtNC02XCIsIFwiY2xhdWRlLXNvbm5ldC00LTZcIiwgXCJjbGF1ZGUtaGFpa3UtNC01XCIsIFwiZ3B0LTRvLW1pbmlcIl07XG5cbiAgZnVuY3Rpb24gbWFrZUNsYXNzaWZpY2F0aW9uKHRpZXI6IFwibGlnaHRcIiB8IFwic3RhbmRhcmRcIiB8IFwiaGVhdnlcIikge1xuICAgIHJldHVybiB7IHRpZXIsIHJlYXNvbjogXCJ0ZXN0XCIsIGRvd25ncmFkZWQ6IGZhbHNlIH07XG4gIH1cblxuICB0ZXN0KFwicmV0dXJucyBzZWxlY3Rpb25NZXRob2Q6IHRpZXItb25seSB3aGVuIHJvdXRpbmcgaXMgZGlzYWJsZWRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGNvbmZpZyA9IHsgLi4uZGVmYXVsdFJvdXRpbmdDb25maWcoKSwgZW5hYmxlZDogZmFsc2UgfTtcbiAgICBjb25zdCByZXN1bHQ6IFJvdXRpbmdEZWNpc2lvbiA9IHJlc29sdmVNb2RlbEZvckNvbXBsZXhpdHkoXG4gICAgICBtYWtlQ2xhc3NpZmljYXRpb24oXCJsaWdodFwiKSxcbiAgICAgIHsgcHJpbWFyeTogXCJjbGF1ZGUtb3B1cy00LTZcIiwgZmFsbGJhY2tzOiBbXSB9LFxuICAgICAgY29uZmlnLFxuICAgICAgTU9ERUxTLFxuICAgICk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zZWxlY3Rpb25NZXRob2QsIFwidGllci1vbmx5XCIpO1xuICB9KTtcblxuICB0ZXN0KFwicmV0dXJucyBzZWxlY3Rpb25NZXRob2Q6IHRpZXItb25seSBmb3Igbm8gcGhhc2UgY29uZmlnIHBhc3N0aHJvdWdoXCIsICgpID0+IHtcbiAgICBjb25zdCBjb25maWcgPSB7IC4uLmRlZmF1bHRSb3V0aW5nQ29uZmlnKCksIGVuYWJsZWQ6IHRydWUgfTtcbiAgICBjb25zdCByZXN1bHQ6IFJvdXRpbmdEZWNpc2lvbiA9IHJlc29sdmVNb2RlbEZvckNvbXBsZXhpdHkoXG4gICAgICBtYWtlQ2xhc3NpZmljYXRpb24oXCJsaWdodFwiKSxcbiAgICAgIHVuZGVmaW5lZCxcbiAgICAgIGNvbmZpZyxcbiAgICAgIE1PREVMUyxcbiAgICApO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc2VsZWN0aW9uTWV0aG9kLCBcInRpZXItb25seVwiKTtcbiAgfSk7XG5cbiAgdGVzdChcInJldHVybnMgc2VsZWN0aW9uTWV0aG9kOiB0aWVyLW9ubHkgZm9yIHVua25vd24gbW9kZWwgcGFzc3Rocm91Z2hcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGNvbmZpZyA9IHsgLi4uZGVmYXVsdFJvdXRpbmdDb25maWcoKSwgZW5hYmxlZDogdHJ1ZSB9O1xuICAgIGNvbnN0IHJlc3VsdDogUm91dGluZ0RlY2lzaW9uID0gcmVzb2x2ZU1vZGVsRm9yQ29tcGxleGl0eShcbiAgICAgIG1ha2VDbGFzc2lmaWNhdGlvbihcImxpZ2h0XCIpLFxuICAgICAgeyBwcmltYXJ5OiBcImN1c3RvbS1wcm92aWRlci9teS1tb2RlbC12M1wiLCBmYWxsYmFja3M6IFtdIH0sXG4gICAgICBjb25maWcsXG4gICAgICBbXCJjdXN0b20tcHJvdmlkZXIvbXktbW9kZWwtdjNcIiwgLi4uTU9ERUxTXSxcbiAgICApO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc2VsZWN0aW9uTWV0aG9kLCBcInRpZXItb25seVwiKTtcbiAgfSk7XG5cbiAgdGVzdChcInJldHVybnMgc2VsZWN0aW9uTWV0aG9kOiB0aWVyLW9ubHkgZm9yIG5vLWRvd25ncmFkZSBwYXNzdGhyb3VnaFwiLCAoKSA9PiB7XG4gICAgY29uc3QgY29uZmlnID0geyAuLi5kZWZhdWx0Um91dGluZ0NvbmZpZygpLCBlbmFibGVkOiB0cnVlIH07XG4gICAgY29uc3QgcmVzdWx0OiBSb3V0aW5nRGVjaXNpb24gPSByZXNvbHZlTW9kZWxGb3JDb21wbGV4aXR5KFxuICAgICAgbWFrZUNsYXNzaWZpY2F0aW9uKFwiaGVhdnlcIiksXG4gICAgICB7IHByaW1hcnk6IFwiY2xhdWRlLW9wdXMtNC02XCIsIGZhbGxiYWNrczogW10gfSxcbiAgICAgIGNvbmZpZyxcbiAgICAgIE1PREVMUyxcbiAgICApO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc2VsZWN0aW9uTWV0aG9kLCBcInRpZXItb25seVwiKTtcbiAgfSk7XG5cbiAgdGVzdChcInJldHVybnMgc2VsZWN0aW9uTWV0aG9kOiB0aWVyLW9ubHkgd2hlbiBkb3duZ3JhZGVkXCIsICgpID0+IHtcbiAgICBjb25zdCBjb25maWcgPSB7IC4uLmRlZmF1bHRSb3V0aW5nQ29uZmlnKCksIGVuYWJsZWQ6IHRydWUgfTtcbiAgICBjb25zdCByZXN1bHQ6IFJvdXRpbmdEZWNpc2lvbiA9IHJlc29sdmVNb2RlbEZvckNvbXBsZXhpdHkoXG4gICAgICBtYWtlQ2xhc3NpZmljYXRpb24oXCJsaWdodFwiKSxcbiAgICAgIHsgcHJpbWFyeTogXCJjbGF1ZGUtb3B1cy00LTZcIiwgZmFsbGJhY2tzOiBbXSB9LFxuICAgICAgY29uZmlnLFxuICAgICAgTU9ERUxTLFxuICAgICk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zZWxlY3Rpb25NZXRob2QsIFwidGllci1vbmx5XCIpO1xuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQURSLTAwNDogUHJvZmlsZSBDb21wbGV0ZW5lc3MgTGludCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbi8vIEV2ZXJ5IG1vZGVsIGluIE1PREVMX0NBUEFCSUxJVFlfVElFUiBtdXN0IGhhdmUgYW4gZW50cnkgaW5cbi8vIE1PREVMX0NBUEFCSUxJVFlfUFJPRklMRVMuIFRoaXMgcHJldmVudHMgcHJvZmlsZSBzdGFsZW5lc3MgYXMgbmV3IG1vZGVsc1xuLy8gYXJlIGFkZGVkIHRvIHRoZSB0aWVyIG1hcCB3aXRob3V0IGNvcnJlc3BvbmRpbmcgY2FwYWJpbGl0eSBkYXRhLlxuXG5kZXNjcmliZShcInByb2ZpbGUgY29tcGxldGVuZXNzIChBRFItMDA0IGxpbnQpXCIsICgpID0+IHtcbiAgdGVzdChcImV2ZXJ5IG1vZGVsIGluIE1PREVMX0NBUEFCSUxJVFlfVElFUiBoYXMgYSBNT0RFTF9DQVBBQklMSVRZX1BST0ZJTEVTIGVudHJ5XCIsICgpID0+IHtcbiAgICBjb25zdCB0aWVyTW9kZWxzID0gT2JqZWN0LmtleXMoTU9ERUxfQ0FQQUJJTElUWV9USUVSKTtcbiAgICBjb25zdCBtaXNzaW5nID0gdGllck1vZGVscy5maWx0ZXIoaWQgPT4gIU1PREVMX0NBUEFCSUxJVFlfUFJPRklMRVNbaWRdKTtcbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICBtaXNzaW5nLmxlbmd0aCxcbiAgICAgIDAsXG4gICAgICBgTW9kZWxzIGluIE1PREVMX0NBUEFCSUxJVFlfVElFUiBidXQgbWlzc2luZyBmcm9tIE1PREVMX0NBUEFCSUxJVFlfUFJPRklMRVM6XFxuICAke21pc3Npbmcuam9pbihcIlxcbiAgXCIpfVxcblxcbkFkZCBjYXBhYmlsaXR5IHByb2ZpbGVzIGZvciB0aGVzZSBtb2RlbHMgaW4gbW9kZWwtcm91dGVyLnRzLmAsXG4gICAgKTtcbiAgfSk7XG5cbiAgdGVzdChcIk1PREVMX0NBUEFCSUxJVFlfUFJPRklMRVMgZG9lcyBub3QgY29udGFpbiBtb2RlbHMgYWJzZW50IGZyb20gTU9ERUxfQ0FQQUJJTElUWV9USUVSXCIsICgpID0+IHtcbiAgICBjb25zdCBwcm9maWxlTW9kZWxzID0gT2JqZWN0LmtleXMoTU9ERUxfQ0FQQUJJTElUWV9QUk9GSUxFUyk7XG4gICAgY29uc3Qgb3JwaGFuZWQgPSBwcm9maWxlTW9kZWxzLmZpbHRlcihpZCA9PiAhTU9ERUxfQ0FQQUJJTElUWV9USUVSW2lkXSk7XG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgb3JwaGFuZWQubGVuZ3RoLFxuICAgICAgMCxcbiAgICAgIGBNb2RlbHMgaW4gTU9ERUxfQ0FQQUJJTElUWV9QUk9GSUxFUyBidXQgbm90IGluIE1PREVMX0NBUEFCSUxJVFlfVElFUjpcXG4gICR7b3JwaGFuZWQuam9pbihcIlxcbiAgXCIpfVxcblxcbkVpdGhlciBhZGQgdGhlc2UgdG8gTU9ERUxfQ0FQQUJJTElUWV9USUVSIG9yIHJlbW92ZSBzdGFsZSBwcm9maWxlcy5gLFxuICAgICk7XG4gIH0pO1xu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
