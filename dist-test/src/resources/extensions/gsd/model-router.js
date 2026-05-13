import { tierOrdinal } from "./complexity-classifier.js";
import { getProviderCapabilities } from "@gsd/pi-ai";
import { getToolCompatibility } from "@gsd/pi-coding-agent";
import { incrementLegacyTelemetry } from "./legacy-telemetry.js";
const MODEL_CAPABILITY_TIER = {
  // Light-tier models (cheapest)
  "claude-haiku-4-5": "light",
  "claude-3-5-haiku-latest": "light",
  "claude-3-haiku-20240307": "light",
  "gpt-4o-mini": "light",
  "gpt-4.1-mini": "light",
  "gpt-4.1-nano": "light",
  "gpt-5-mini": "light",
  "gpt-5-nano": "light",
  "gpt-5.4-mini": "light",
  "gpt-5.1-codex-mini": "light",
  "gpt-5.3-codex-spark": "light",
  "gemini-2.0-flash": "light",
  "gemini-flash-2.0": "light",
  // Standard-tier models
  "claude-sonnet-4-6": "standard",
  "claude-sonnet-4-5-20250514": "standard",
  "claude-3-5-sonnet-latest": "standard",
  "gpt-4o": "standard",
  "gpt-4.1": "standard",
  "gpt-5.1-codex-max": "standard",
  "gemini-2.5-pro": "standard",
  "deepseek-chat": "standard",
  // Heavy-tier models (most capable)
  "claude-opus-4-6": "heavy",
  "claude-opus-4-7": "heavy",
  "claude-3-opus-latest": "heavy",
  "gpt-4-turbo": "heavy",
  "gpt-5": "heavy",
  "gpt-5-pro": "heavy",
  "gpt-5.1": "heavy",
  "gpt-5.2": "heavy",
  "gpt-5.2-codex": "heavy",
  "gpt-5.3-codex": "heavy",
  "gpt-5.4": "heavy",
  "gpt-5.5": "heavy",
  "o1": "heavy",
  "o3": "heavy",
  "o4-mini": "heavy",
  "o4-mini-deep-research": "heavy"
};
const MODEL_COST_PER_1K_INPUT = {
  "claude-haiku-4-5": 8e-4,
  "claude-3-5-haiku-latest": 8e-4,
  "claude-sonnet-4-6": 3e-3,
  "claude-sonnet-4-5-20250514": 3e-3,
  "claude-opus-4-6": 5e-3,
  "claude-opus-4-7": 5e-3,
  "gpt-4o-mini": 15e-5,
  "gpt-4o": 25e-4,
  "gpt-4.1": 2e-3,
  "gpt-4.1-mini": 4e-4,
  "gpt-4.1-nano": 1e-4,
  "gpt-5": 0.01,
  "gpt-5-mini": 3e-4,
  "gpt-5-nano": 1e-4,
  "gpt-5.4-mini": 75e-5,
  "gpt-5-pro": 0.015,
  "gpt-5.1": 5e-3,
  "gpt-5.1-codex-max": 3e-3,
  "gpt-5.1-codex-mini": 3e-4,
  "gpt-5.2": 5e-3,
  "gpt-5.2-codex": 5e-3,
  "gpt-5.3-codex": 5e-3,
  "gpt-5.3-codex-spark": 3e-4,
  "gpt-5.4": 5e-3,
  "gpt-5.5": 5e-3,
  "o4-mini": 5e-3,
  "o4-mini-deep-research": 5e-3,
  "gemini-2.0-flash": 1e-4,
  "gemini-2.5-pro": 125e-5,
  "deepseek-chat": 14e-5
};
const MODEL_CAPABILITY_PROFILES = {
  // ── Anthropic ──────────────────────────────────────────────────────────────
  "claude-opus-4-6": { coding: 95, debugging: 90, research: 85, reasoning: 95, speed: 30, longContext: 80, instruction: 90 },
  "claude-opus-4-7": { coding: 95, debugging: 90, research: 85, reasoning: 95, speed: 30, longContext: 80, instruction: 90 },
  "claude-sonnet-4-6": { coding: 85, debugging: 80, research: 75, reasoning: 80, speed: 60, longContext: 75, instruction: 85 },
  "claude-sonnet-4-5-20250514": { coding: 85, debugging: 80, research: 75, reasoning: 80, speed: 60, longContext: 75, instruction: 85 },
  "claude-3-5-sonnet-latest": { coding: 82, debugging: 78, research: 72, reasoning: 78, speed: 62, longContext: 70, instruction: 82 },
  "claude-haiku-4-5": { coding: 60, debugging: 50, research: 45, reasoning: 50, speed: 95, longContext: 50, instruction: 75 },
  "claude-3-5-haiku-latest": { coding: 60, debugging: 50, research: 45, reasoning: 50, speed: 95, longContext: 50, instruction: 75 },
  "claude-3-haiku-20240307": { coding: 50, debugging: 40, research: 35, reasoning: 40, speed: 95, longContext: 40, instruction: 65 },
  "claude-3-opus-latest": { coding: 90, debugging: 85, research: 82, reasoning: 90, speed: 35, longContext: 75, instruction: 88 },
  // ── OpenAI GPT ─────────────────────────────────────────────────────────────
  "gpt-4o": { coding: 80, debugging: 75, research: 70, reasoning: 75, speed: 65, longContext: 70, instruction: 80 },
  "gpt-4o-mini": { coding: 55, debugging: 45, research: 40, reasoning: 45, speed: 90, longContext: 45, instruction: 70 },
  "gpt-4-turbo": { coding: 78, debugging: 72, research: 68, reasoning: 72, speed: 50, longContext: 65, instruction: 78 },
  "gpt-4.1": { coding: 82, debugging: 78, research: 72, reasoning: 78, speed: 62, longContext: 72, instruction: 82 },
  "gpt-4.1-mini": { coding: 58, debugging: 48, research: 42, reasoning: 48, speed: 88, longContext: 48, instruction: 72 },
  "gpt-4.1-nano": { coding: 40, debugging: 30, research: 25, reasoning: 30, speed: 95, longContext: 30, instruction: 60 },
  "gpt-5": { coding: 92, debugging: 88, research: 85, reasoning: 92, speed: 40, longContext: 85, instruction: 90 },
  "gpt-5-mini": { coding: 62, debugging: 52, research: 48, reasoning: 52, speed: 88, longContext: 52, instruction: 74 },
  "gpt-5-nano": { coding: 42, debugging: 32, research: 28, reasoning: 32, speed: 95, longContext: 32, instruction: 62 },
  "gpt-5.4-mini": { coding: 70, debugging: 60, research: 55, reasoning: 60, speed: 84, longContext: 60, instruction: 78 },
  "gpt-5-pro": { coding: 94, debugging: 90, research: 88, reasoning: 94, speed: 35, longContext: 88, instruction: 92 },
  "gpt-5.1": { coding: 93, debugging: 89, research: 86, reasoning: 93, speed: 42, longContext: 86, instruction: 91 },
  "gpt-5.1-codex-max": { coding: 90, debugging: 85, research: 70, reasoning: 85, speed: 55, longContext: 75, instruction: 85 },
  "gpt-5.1-codex-mini": { coding: 65, debugging: 55, research: 40, reasoning: 50, speed: 88, longContext: 48, instruction: 72 },
  "gpt-5.2": { coding: 93, debugging: 90, research: 87, reasoning: 93, speed: 42, longContext: 87, instruction: 91 },
  "gpt-5.2-codex": { coding: 93, debugging: 90, research: 72, reasoning: 88, speed: 50, longContext: 78, instruction: 88 },
  "gpt-5.3-codex": { coding: 94, debugging: 91, research: 74, reasoning: 89, speed: 50, longContext: 80, instruction: 89 },
  "gpt-5.3-codex-spark": { coding: 68, debugging: 58, research: 42, reasoning: 52, speed: 90, longContext: 50, instruction: 74 },
  "gpt-5.4": { coding: 95, debugging: 92, research: 88, reasoning: 94, speed: 42, longContext: 88, instruction: 92 },
  // GPT-5.5 scores are relative to the existing gpt-5.4 profile and backed by
  // OpenAI's 2026-04-23 published eval deltas across coding, tool use, and long context.
  // Source: https://openai.com/index/introducing-gpt-5-5/
  "gpt-5.5": { coding: 96, debugging: 93, research: 89, reasoning: 95, speed: 42, longContext: 90, instruction: 93 },
  // ── OpenAI o-series (reasoning-first) ──────────────────────────────────────
  "o1": { coding: 78, debugging: 82, research: 78, reasoning: 90, speed: 20, longContext: 65, instruction: 82 },
  "o3": { coding: 80, debugging: 85, research: 80, reasoning: 92, speed: 25, longContext: 70, instruction: 85 },
  "o4-mini": { coding: 75, debugging: 80, research: 72, reasoning: 88, speed: 60, longContext: 65, instruction: 80 },
  "o4-mini-deep-research": { coding: 75, debugging: 80, research: 85, reasoning: 88, speed: 30, longContext: 80, instruction: 80 },
  // ── Google ─────────────────────────────────────────────────────────────────
  "gemini-2.5-pro": { coding: 75, debugging: 70, research: 85, reasoning: 75, speed: 55, longContext: 90, instruction: 75 },
  "gemini-2.0-flash": { coding: 50, debugging: 40, research: 50, reasoning: 40, speed: 95, longContext: 60, instruction: 65 },
  "gemini-flash-2.0": { coding: 50, debugging: 40, research: 50, reasoning: 40, speed: 95, longContext: 60, instruction: 65 },
  // ── DeepSeek ───────────────────────────────────────────────────────────────
  "deepseek-chat": { coding: 75, debugging: 65, research: 55, reasoning: 70, speed: 70, longContext: 55, instruction: 65 }
};
const BASE_REQUIREMENTS = {
  "execute-task": { coding: 0.9, instruction: 0.7, speed: 0.3 },
  "research-milestone": { research: 0.9, longContext: 0.7, reasoning: 0.5 },
  "research-slice": { research: 0.9, longContext: 0.7, reasoning: 0.5 },
  "plan-milestone": { reasoning: 0.9, coding: 0.5 },
  "plan-slice": { reasoning: 0.9, coding: 0.5 },
  "replan-slice": { reasoning: 0.9, debugging: 0.6, coding: 0.5 },
  "reassess-roadmap": { reasoning: 0.9, research: 0.5 },
  "complete-slice": { instruction: 0.8, speed: 0.7 },
  "run-uat": { instruction: 0.7, speed: 0.8 },
  "discuss-milestone": { reasoning: 0.6, instruction: 0.7 },
  "complete-milestone": { instruction: 0.8, reasoning: 0.5 }
};
function scoreModel(model, requirements) {
  let weightedSum = 0;
  let weightSum = 0;
  for (const [dim, weight] of Object.entries(requirements)) {
    const capability = model[dim] ?? 50;
    weightedSum += weight * capability;
    weightSum += weight;
  }
  return weightSum > 0 ? weightedSum / weightSum : 50;
}
function computeTaskRequirements(unitType, metadata) {
  const base = BASE_REQUIREMENTS[unitType] ?? { reasoning: 0.5 };
  if (unitType === "execute-task" && metadata) {
    if (metadata.tags?.some((t) => /^(docs?|readme|comment|config|typo|rename)$/i.test(t))) {
      return { ...base, instruction: 0.9, coding: 0.3, speed: 0.7 };
    }
    if (metadata.complexityKeywords?.some((k) => k === "concurrency" || k === "compatibility")) {
      return { ...base, debugging: 0.9, reasoning: 0.8 };
    }
    if (metadata.complexityKeywords?.some((k) => k === "migration" || k === "architecture")) {
      return { ...base, reasoning: 0.9, coding: 0.8 };
    }
    if ((metadata.fileCount ?? 0) >= 6 || (metadata.estimatedLines ?? 0) >= 500) {
      return { ...base, coding: 0.9, reasoning: 0.7 };
    }
  }
  return base;
}
function scoreEligibleModels(eligibleModelIds, requirements, capabilityOverrides) {
  const scored = eligibleModelIds.map((modelId) => {
    const bareId = bareModelId(modelId);
    const builtin = MODEL_CAPABILITY_PROFILES[bareId];
    const override = capabilityOverrides?.[modelId] ?? capabilityOverrides?.[bareId];
    const profile = builtin ? override ? { ...builtin, ...override } : builtin : { coding: 50, debugging: 50, research: 50, reasoning: 50, speed: 50, longContext: 50, instruction: 50 };
    return { modelId, score: scoreModel(profile, requirements) };
  });
  scored.sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (Math.abs(scoreDiff) > 2) return scoreDiff;
    const costA = MODEL_COST_PER_1K_INPUT[a.modelId] ?? Infinity;
    const costB = MODEL_COST_PER_1K_INPUT[b.modelId] ?? Infinity;
    if (costA !== costB) return costA - costB;
    return a.modelId.localeCompare(b.modelId);
  });
  return scored;
}
function getEligibleModels(tier, availableModelIds, routingConfig) {
  const explicitModel = routingConfig.tier_models?.[tier];
  if (explicitModel) {
    if (availableModelIds.includes(explicitModel)) return [explicitModel];
    const bareExplicit = bareModelId(explicitModel);
    const match = availableModelIds.find((id) => bareModelId(id) === bareExplicit);
    if (match) return [match];
  }
  return availableModelIds.filter((id) => getModelTier(id) === tier).sort((a, b) => {
    const costA = getModelCost(a);
    const costB = getModelCost(b);
    return costA - costB;
  });
}
function buildFallbackChain(selectedModelId, phaseConfig) {
  return [
    ...phaseConfig.fallbacks.filter((f) => f !== selectedModelId),
    phaseConfig.primary
  ].filter((f) => f !== selectedModelId);
}
function loadCapabilityOverrides(prefs) {
  const result = {};
  if (!prefs.modelOverrides) return result;
  for (const [modelId, overrideEntry] of Object.entries(prefs.modelOverrides)) {
    if (overrideEntry.capabilities) {
      result[modelId] = overrideEntry.capabilities;
    }
  }
  return result;
}
function resolveModelForComplexity(classification, phaseConfig, routingConfig, availableModelIds, unitType, taskMetadata, capabilityOverrides) {
  if (!phaseConfig || !routingConfig.enabled) {
    return {
      modelId: phaseConfig?.primary ?? "",
      fallbacks: phaseConfig?.fallbacks ?? [],
      tier: classification.tier,
      wasDowngraded: false,
      reason: "dynamic routing disabled or no phase config",
      selectionMethod: "tier-only"
    };
  }
  const configuredPrimary = phaseConfig.primary;
  const configuredTier = getModelTier(configuredPrimary);
  const requestedTier = classification.tier;
  if (!isKnownModel(configuredPrimary)) {
    return {
      modelId: configuredPrimary,
      fallbacks: phaseConfig.fallbacks,
      tier: requestedTier,
      wasDowngraded: false,
      reason: `configured model "${configuredPrimary}" is not in the known tier map \u2014 honoring explicit config`,
      selectionMethod: "tier-only"
    };
  }
  if (tierOrdinal(requestedTier) >= tierOrdinal(configuredTier)) {
    if (isModelAvailable(configuredPrimary, availableModelIds)) {
      return {
        modelId: configuredPrimary,
        fallbacks: phaseConfig.fallbacks,
        tier: requestedTier,
        wasDowngraded: false,
        reason: `tier ${requestedTier} >= configured ${configuredTier}`,
        selectionMethod: "tier-only"
      };
    }
    const crossProviderEquivalent = findModelForTier(
      configuredTier,
      routingConfig,
      availableModelIds,
      routingConfig.cross_provider !== false
    );
    return {
      modelId: crossProviderEquivalent ?? configuredPrimary,
      fallbacks: crossProviderEquivalent ? [...phaseConfig.fallbacks.filter((f) => f !== crossProviderEquivalent), configuredPrimary] : phaseConfig.fallbacks,
      tier: requestedTier,
      wasDowngraded: false,
      reason: crossProviderEquivalent ? `cross-provider ${configuredTier}-tier equivalent` : `tier ${requestedTier} >= configured ${configuredTier}`,
      selectionMethod: "tier-only"
    };
  }
  const eligible = getEligibleModels(requestedTier, availableModelIds, routingConfig);
  if (eligible.length === 0) {
    return {
      modelId: configuredPrimary,
      fallbacks: phaseConfig.fallbacks,
      tier: requestedTier,
      wasDowngraded: false,
      reason: `no ${requestedTier}-tier model available`,
      selectionMethod: "tier-only"
    };
  }
  if (routingConfig.capability_routing !== false && eligible.length > 1 && unitType) {
    const requirements = computeTaskRequirements(unitType, taskMetadata);
    const scored = scoreEligibleModels(eligible, requirements, capabilityOverrides);
    const winner = scored[0];
    if (winner) {
      const capScores = {};
      for (const s of scored) capScores[s.modelId] = s.score;
      const fallbacks2 = buildFallbackChain(winner.modelId, phaseConfig);
      return {
        modelId: winner.modelId,
        fallbacks: fallbacks2,
        tier: requestedTier,
        wasDowngraded: true,
        reason: `capability-scored: ${winner.modelId} (${winner.score.toFixed(1)}) for ${unitType}`,
        capabilityScores: capScores,
        taskRequirements: requirements,
        selectionMethod: "capability-scored"
      };
    }
  }
  const targetModelId = eligible[0];
  const fallbacks = buildFallbackChain(targetModelId, phaseConfig);
  return {
    modelId: targetModelId,
    fallbacks,
    tier: requestedTier,
    wasDowngraded: true,
    reason: classification.reason,
    selectionMethod: "tier-only"
  };
}
function escalateTier(currentTier) {
  switch (currentTier) {
    case "light":
      return "standard";
    case "standard":
      return "heavy";
    case "heavy":
      return null;
  }
}
function defaultRoutingConfig() {
  return {
    enabled: true,
    capability_routing: true,
    escalate_on_failure: true,
    budget_pressure: true,
    cross_provider: true,
    hooks: true
  };
}
const CANONICAL_TIER_MODELS = {
  light: "claude-haiku-4-5",
  standard: "claude-sonnet-4-6",
  heavy: "claude-opus-4-6"
};
function canonicalModelForTier(tier) {
  return CANONICAL_TIER_MODELS[tier];
}
function findModelForTier(tier, routingConfig, availableModelIds, crossProvider) {
  const eligible = getEligibleModels(tier, availableModelIds, routingConfig);
  if (eligible.length === 0) return void 0;
  if (crossProvider) {
    return eligible[0];
  }
  const sameProvider = eligible.filter((id) => {
    const bare = bareModelId(id);
    return MODEL_CAPABILITY_TIER[bare] === tier && bare.startsWith("claude-");
  });
  return sameProvider[0];
}
function resolveModelForTier(tier, availableModelIds, routingConfigOrCrossProvider = defaultRoutingConfig(), crossProvider) {
  const routingConfig = typeof routingConfigOrCrossProvider === "boolean" ? defaultRoutingConfig() : { ...defaultRoutingConfig(), ...routingConfigOrCrossProvider };
  const allowCrossProvider = typeof routingConfigOrCrossProvider === "boolean" ? routingConfigOrCrossProvider : crossProvider ?? routingConfig.cross_provider !== false;
  if (availableModelIds.length === 0) {
    incrementLegacyTelemetry("legacy.providerDefaultUsed");
    return canonicalModelForTier(tier);
  }
  const resolved = findModelForTier(tier, routingConfig, availableModelIds, allowCrossProvider);
  if (resolved) {
    return normalizeResolvedTierModelId(resolved, tier, routingConfig);
  }
  incrementLegacyTelemetry("legacy.providerDefaultUsed");
  return canonicalModelForTier(tier);
}
function isModelAvailable(modelId, availableModelIds) {
  if (availableModelIds.includes(modelId)) return true;
  const bare = bareModelId(modelId);
  if (!bare) return false;
  return availableModelIds.some((id) => bareModelId(id) === bare);
}
function getModelTier(modelId) {
  const bareId = bareModelId(modelId);
  if (MODEL_CAPABILITY_TIER[bareId]) return MODEL_CAPABILITY_TIER[bareId];
  for (const [knownId, tier] of Object.entries(MODEL_CAPABILITY_TIER)) {
    if (bareId.includes(knownId) || knownId.includes(bareId)) return tier;
  }
  return "standard";
}
function isKnownModel(modelId) {
  const bareId = bareModelId(modelId);
  if (MODEL_CAPABILITY_TIER[bareId]) return true;
  for (const knownId of Object.keys(MODEL_CAPABILITY_TIER)) {
    if (bareId.includes(knownId) || knownId.includes(bareId)) return true;
  }
  return false;
}
function getModelCost(modelId) {
  const bareId = bareModelId(modelId);
  if (MODEL_COST_PER_1K_INPUT[bareId] !== void 0) {
    return MODEL_COST_PER_1K_INPUT[bareId];
  }
  for (const [knownId, cost] of Object.entries(MODEL_COST_PER_1K_INPUT)) {
    if (bareId.includes(knownId) || knownId.includes(bareId)) return cost;
  }
  return 999;
}
function normalizeResolvedTierModelId(modelId, tier, routingConfig) {
  const explicitModel = routingConfig.tier_models?.[tier];
  if (explicitModel?.includes("/")) {
    return modelId;
  }
  const bareId = bareModelId(modelId);
  return MODEL_CAPABILITY_TIER[bareId] ? bareId : modelId;
}
function bareModelId(modelId) {
  if (!modelId.includes("/")) return modelId;
  return modelId.split("/").pop() ?? modelId;
}
const GROQ_MAX_TOOLS = 128;
const GROQ_PROVIDER_IDS = /* @__PURE__ */ new Set(["groq"]);
function isToolCompatibleWithProvider(toolName, providerCaps) {
  const compat = getToolCompatibility(toolName);
  if (!compat) return true;
  if (compat.producesImages && !providerCaps.imageToolResults) return false;
  if (compat.schemaFeatures?.some((f) => providerCaps.unsupportedSchemaFeatures.includes(f))) {
    return false;
  }
  return true;
}
function filterToolsForProvider(toolNames, providerApi, provider) {
  const providerCaps = getProviderCapabilities(providerApi);
  if (!providerCaps.toolCalling) {
    return { compatible: [], filtered: toolNames };
  }
  const compatible = [];
  const filtered = [];
  for (const name of toolNames) {
    if (isToolCompatibleWithProvider(name, providerCaps)) {
      compatible.push(name);
    } else {
      filtered.push(name);
    }
  }
  if (provider && GROQ_PROVIDER_IDS.has(provider) && compatible.length > GROQ_MAX_TOOLS) {
    const trimmed = compatible.splice(GROQ_MAX_TOOLS);
    filtered.push(...trimmed);
    console.warn(
      `[gsd] Groq tool limit: ${compatible.length + trimmed.length} tools active but Groq allows at most ${GROQ_MAX_TOOLS}. Trimming to the first ${GROQ_MAX_TOOLS} tools. Removed: ${trimmed.join(", ")}`
    );
  }
  return { compatible, filtered };
}
function adjustToolSet(activeToolNames, selectedModelApi, provider) {
  const { compatible, filtered } = filterToolsForProvider(activeToolNames, selectedModelApi, provider);
  return { toolNames: compatible, removedTools: filtered };
}
export {
  BASE_REQUIREMENTS,
  GROQ_MAX_TOOLS,
  MODEL_CAPABILITY_PROFILES,
  MODEL_CAPABILITY_TIER,
  adjustToolSet,
  canonicalModelForTier,
  computeTaskRequirements,
  defaultRoutingConfig,
  escalateTier,
  filterToolsForProvider,
  getEligibleModels,
  isToolCompatibleWithProvider,
  loadCapabilityOverrides,
  resolveModelForComplexity,
  resolveModelForTier,
  scoreEligibleModels,
  scoreModel
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9tb2RlbC1yb3V0ZXIudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFByb2plY3QvQXBwOiBHU0QtMlxuLy8gRmlsZSBQdXJwb3NlOiBSb3V0ZXMgd29yayB0byBhcHByb3ByaWF0ZSBtb2RlbHMgd2hpbGUgcHJlc2VydmluZyBjb25maWd1cmVkIGNlaWxpbmdzLlxuXG5pbXBvcnQgdHlwZSB7IENvbXBsZXhpdHlUaWVyLCBDbGFzc2lmaWNhdGlvblJlc3VsdCwgVGFza01ldGFkYXRhIH0gZnJvbSBcIi4vY29tcGxleGl0eS1jbGFzc2lmaWVyLmpzXCI7XG5pbXBvcnQgeyB0aWVyT3JkaW5hbCB9IGZyb20gXCIuL2NvbXBsZXhpdHktY2xhc3NpZmllci5qc1wiO1xuaW1wb3J0IHR5cGUgeyBSZXNvbHZlZE1vZGVsQ29uZmlnIH0gZnJvbSBcIi4vcHJlZmVyZW5jZXMuanNcIjtcbmltcG9ydCB7IGdldFByb3ZpZGVyQ2FwYWJpbGl0aWVzLCB0eXBlIFByb3ZpZGVyQ2FwYWJpbGl0aWVzIH0gZnJvbSBcIkBnc2QvcGktYWlcIjtcbmltcG9ydCB7IGdldFRvb2xDb21wYXRpYmlsaXR5LCBnZXRBbGxUb29sQ29tcGF0aWJpbGl0eSB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuaW1wb3J0IHR5cGUgeyBUb29sQ29tcGF0aWJpbGl0eSB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuaW1wb3J0IHsgaW5jcmVtZW50TGVnYWN5VGVsZW1ldHJ5IH0gZnJvbSBcIi4vbGVnYWN5LXRlbGVtZXRyeS5qc1wiO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVHlwZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBpbnRlcmZhY2UgRHluYW1pY1JvdXRpbmdDb25maWcge1xuICBlbmFibGVkPzogYm9vbGVhbjtcbiAgY2FwYWJpbGl0eV9yb3V0aW5nPzogYm9vbGVhbjsgICAgLy8gZGVmYXVsdDogZmFsc2UgXHUyMDE0IGVuYWJsZSBjYXBhYmlsaXR5IHByb2ZpbGUgc2NvcmluZ1xuICB0aWVyX21vZGVscz86IHtcbiAgICBsaWdodD86IHN0cmluZztcbiAgICBzdGFuZGFyZD86IHN0cmluZztcbiAgICBoZWF2eT86IHN0cmluZztcbiAgfTtcbiAgZXNjYWxhdGVfb25fZmFpbHVyZT86IGJvb2xlYW47ICAgLy8gZGVmYXVsdDogdHJ1ZVxuICBidWRnZXRfcHJlc3N1cmU/OiBib29sZWFuOyAgICAgICAvLyBkZWZhdWx0OiB0cnVlXG4gIGNyb3NzX3Byb3ZpZGVyPzogYm9vbGVhbjsgICAgICAgIC8vIGRlZmF1bHQ6IHRydWVcbiAgaG9va3M/OiBib29sZWFuOyAgICAgICAgICAgICAgICAgLy8gZGVmYXVsdDogdHJ1ZVxuICAvKipcbiAgICogT3B0IGludG8gZHluYW1pYyByb3V0aW5nIGZvciBmbGF0LXJhdGUgcHJvdmlkZXJzIChlLmcuIGNsYXVkZS1jb2RlLFxuICAgKiBHaXRIdWIgQ29waWxvdCkuIERlZmF1bHQgZmFsc2UgcHJlc2VydmVzIHRoZSAjMzQ1MyBieXBhc3MgdGhhdCBza2lwc1xuICAgKiByb3V0aW5nIHdoZW4gdGhlIHN1YnNjcmlwdGlvbiBtYWtlcyBwZXItcmVxdWVzdCBjb3N0IGlkZW50aWNhbC5cbiAgICogRW5hYmxlIG9ubHkgd2hlbiB5b3Ugd2FudCBwZXItdGFzayBtb2RlbCBzZWxlY3Rpb24gYWNyb3NzIGEgZmxhdC1yYXRlXG4gICAqIHN1YnNjcmlwdGlvbiAoZS5nLiBoYWlrdSBmb3IgcmVzZWFyY2gsIG9wdXMgZm9yIGFyY2hpdGVjdHVyZSkuICgjNDM4NilcbiAgICovXG4gIGFsbG93X2ZsYXRfcmF0ZV9wcm92aWRlcnM/OiBib29sZWFuO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFJvdXRpbmdEZWNpc2lvbiB7XG4gIC8qKiBUaGUgbW9kZWwgSUQgdG8gdXNlIChtYXkgYmUgZG93bmdyYWRlZCBmcm9tIGNvbmZpZ3VyZWQpICovXG4gIG1vZGVsSWQ6IHN0cmluZztcbiAgLyoqIEZhbGxiYWNrIGNoYWluOiBbc2VsZWN0ZWRfbW9kZWwsIC4uLmNvbmZpZ3VyZWRfZmFsbGJhY2tzLCBjb25maWd1cmVkX3ByaW1hcnldICovXG4gIGZhbGxiYWNrczogc3RyaW5nW107XG4gIC8qKiBUaGUgY29tcGxleGl0eSB0aWVyIHRoYXQgZHJvdmUgdGhpcyBkZWNpc2lvbiAqL1xuICB0aWVyOiBDb21wbGV4aXR5VGllcjtcbiAgLyoqIFRydWUgaWYgdGhlIG1vZGVsIHdhcyBkb3duZ3JhZGVkIGZyb20gdGhlIGNvbmZpZ3VyZWQgcHJpbWFyeSAqL1xuICB3YXNEb3duZ3JhZGVkOiBib29sZWFuO1xuICAvKiogSHVtYW4tcmVhZGFibGUgcmVhc29uIGZvciB0aGlzIGRlY2lzaW9uICovXG4gIHJlYXNvbjogc3RyaW5nO1xuICAvKiogSG93IHRoZSBtb2RlbCB3YXMgc2VsZWN0ZWQgKi9cbiAgc2VsZWN0aW9uTWV0aG9kOiBcInRpZXItb25seVwiIHwgXCJjYXBhYmlsaXR5LXNjb3JlZFwiO1xuICAvKiogQ2FwYWJpbGl0eSBzY29yZXMgcGVyIGVsaWdpYmxlIG1vZGVsIChjYXBhYmlsaXR5LXNjb3JlZCBwYXRoIG9ubHkpICovXG4gIGNhcGFiaWxpdHlTY29yZXM/OiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+O1xuICAvKiogVG9vbHMgZmlsdGVyZWQgb3V0IGR1ZSB0byBwcm92aWRlciBpbmNvbXBhdGliaWxpdHkgKEFEUi0wMDUpICovXG4gIGZpbHRlcmVkVG9vbHM/OiBzdHJpbmdbXTtcbiAgLyoqIFRhc2sgcmVxdWlyZW1lbnQgdmVjdG9yIHVzZWQgZm9yIHNjb3JpbmcgKi9cbiAgdGFza1JlcXVpcmVtZW50cz86IFBhcnRpYWw8UmVjb3JkPHN0cmluZywgbnVtYmVyPj47XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBDYXBhYmlsaXR5IFByb2ZpbGVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKiogU2V2ZW4tZGltZW5zaW9uIGNhcGFiaWxpdHkgcHJvZmlsZSBmb3IgYSBtb2RlbC4gQWxsIHZhbHVlcyBpbiAwXHUyMDEzMTAwIHJhbmdlLiAqL1xuZXhwb3J0IGludGVyZmFjZSBNb2RlbENhcGFiaWxpdGllcyB7XG4gIGNvZGluZzogbnVtYmVyO1xuICBkZWJ1Z2dpbmc6IG51bWJlcjtcbiAgcmVzZWFyY2g6IG51bWJlcjtcbiAgcmVhc29uaW5nOiBudW1iZXI7XG4gIHNwZWVkOiBudW1iZXI7XG4gIGxvbmdDb250ZXh0OiBudW1iZXI7XG4gIGluc3RydWN0aW9uOiBudW1iZXI7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBLbm93biBNb2RlbCBUaWVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbi8vIE1hcHMga25vd24gbW9kZWwgSURzIHRvIHRoZWlyIGNhcGFiaWxpdHkgdGllci4gVXNlZCB3aGVuIHRpZXJfbW9kZWxzIGlzIG5vdFxuLy8gZXhwbGljaXRseSBjb25maWd1cmVkIHRvIHBpY2sgdGhlIGJlc3QgYXZhaWxhYmxlIG1vZGVsIGZvciBlYWNoIHRpZXIuXG5cbmV4cG9ydCBjb25zdCBNT0RFTF9DQVBBQklMSVRZX1RJRVI6IFJlY29yZDxzdHJpbmcsIENvbXBsZXhpdHlUaWVyPiA9IHtcbiAgLy8gTGlnaHQtdGllciBtb2RlbHMgKGNoZWFwZXN0KVxuICBcImNsYXVkZS1oYWlrdS00LTVcIjogXCJsaWdodFwiLFxuICBcImNsYXVkZS0zLTUtaGFpa3UtbGF0ZXN0XCI6IFwibGlnaHRcIixcbiAgXCJjbGF1ZGUtMy1oYWlrdS0yMDI0MDMwN1wiOiBcImxpZ2h0XCIsXG4gIFwiZ3B0LTRvLW1pbmlcIjogXCJsaWdodFwiLFxuICBcImdwdC00LjEtbWluaVwiOiBcImxpZ2h0XCIsXG4gIFwiZ3B0LTQuMS1uYW5vXCI6IFwibGlnaHRcIixcbiAgXCJncHQtNS1taW5pXCI6IFwibGlnaHRcIixcbiAgXCJncHQtNS1uYW5vXCI6IFwibGlnaHRcIixcbiAgXCJncHQtNS40LW1pbmlcIjogXCJsaWdodFwiLFxuICBcImdwdC01LjEtY29kZXgtbWluaVwiOiBcImxpZ2h0XCIsXG4gIFwiZ3B0LTUuMy1jb2RleC1zcGFya1wiOiBcImxpZ2h0XCIsXG4gIFwiZ2VtaW5pLTIuMC1mbGFzaFwiOiBcImxpZ2h0XCIsXG4gIFwiZ2VtaW5pLWZsYXNoLTIuMFwiOiBcImxpZ2h0XCIsXG5cbiAgLy8gU3RhbmRhcmQtdGllciBtb2RlbHNcbiAgXCJjbGF1ZGUtc29ubmV0LTQtNlwiOiBcInN0YW5kYXJkXCIsXG4gIFwiY2xhdWRlLXNvbm5ldC00LTUtMjAyNTA1MTRcIjogXCJzdGFuZGFyZFwiLFxuICBcImNsYXVkZS0zLTUtc29ubmV0LWxhdGVzdFwiOiBcInN0YW5kYXJkXCIsXG4gIFwiZ3B0LTRvXCI6IFwic3RhbmRhcmRcIixcbiAgXCJncHQtNC4xXCI6IFwic3RhbmRhcmRcIixcbiAgXCJncHQtNS4xLWNvZGV4LW1heFwiOiBcInN0YW5kYXJkXCIsXG4gIFwiZ2VtaW5pLTIuNS1wcm9cIjogXCJzdGFuZGFyZFwiLFxuICBcImRlZXBzZWVrLWNoYXRcIjogXCJzdGFuZGFyZFwiLFxuXG4gIC8vIEhlYXZ5LXRpZXIgbW9kZWxzIChtb3N0IGNhcGFibGUpXG4gIFwiY2xhdWRlLW9wdXMtNC02XCI6IFwiaGVhdnlcIixcbiAgXCJjbGF1ZGUtb3B1cy00LTdcIjogXCJoZWF2eVwiLFxuICBcImNsYXVkZS0zLW9wdXMtbGF0ZXN0XCI6IFwiaGVhdnlcIixcbiAgXCJncHQtNC10dXJib1wiOiBcImhlYXZ5XCIsXG4gIFwiZ3B0LTVcIjogXCJoZWF2eVwiLFxuICBcImdwdC01LXByb1wiOiBcImhlYXZ5XCIsXG4gIFwiZ3B0LTUuMVwiOiBcImhlYXZ5XCIsXG4gIFwiZ3B0LTUuMlwiOiBcImhlYXZ5XCIsXG4gIFwiZ3B0LTUuMi1jb2RleFwiOiBcImhlYXZ5XCIsXG4gIFwiZ3B0LTUuMy1jb2RleFwiOiBcImhlYXZ5XCIsXG4gIFwiZ3B0LTUuNFwiOiBcImhlYXZ5XCIsXG4gIFwiZ3B0LTUuNVwiOiBcImhlYXZ5XCIsXG4gIFwibzFcIjogXCJoZWF2eVwiLFxuICBcIm8zXCI6IFwiaGVhdnlcIixcbiAgXCJvNC1taW5pXCI6IFwiaGVhdnlcIixcbiAgXCJvNC1taW5pLWRlZXAtcmVzZWFyY2hcIjogXCJoZWF2eVwiLFxufTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIENvc3QgVGFibGUgKHBlciAxSyBpbnB1dCB0b2tlbnMsIGFwcHJveGltYXRlIFVTRCkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4vLyBVc2VkIGZvciBjcm9zcy1wcm92aWRlciBjb3N0IGNvbXBhcmlzb24gd2hlbiBtdWx0aXBsZSBwcm92aWRlcnMgb2ZmZXJcbi8vIHRoZSBzYW1lIGNhcGFiaWxpdHkgdGllci5cblxuY29uc3QgTU9ERUxfQ09TVF9QRVJfMUtfSU5QVVQ6IFJlY29yZDxzdHJpbmcsIG51bWJlcj4gPSB7XG4gIFwiY2xhdWRlLWhhaWt1LTQtNVwiOiAwLjAwMDgsXG4gIFwiY2xhdWRlLTMtNS1oYWlrdS1sYXRlc3RcIjogMC4wMDA4LFxuICBcImNsYXVkZS1zb25uZXQtNC02XCI6IDAuMDAzLFxuICBcImNsYXVkZS1zb25uZXQtNC01LTIwMjUwNTE0XCI6IDAuMDAzLFxuICBcImNsYXVkZS1vcHVzLTQtNlwiOiAwLjAwNSxcbiAgXCJjbGF1ZGUtb3B1cy00LTdcIjogMC4wMDUsXG4gIFwiZ3B0LTRvLW1pbmlcIjogMC4wMDAxNSxcbiAgXCJncHQtNG9cIjogMC4wMDI1LFxuICBcImdwdC00LjFcIjogMC4wMDIsXG4gIFwiZ3B0LTQuMS1taW5pXCI6IDAuMDAwNCxcbiAgXCJncHQtNC4xLW5hbm9cIjogMC4wMDAxLFxuICBcImdwdC01XCI6IDAuMDEsXG4gIFwiZ3B0LTUtbWluaVwiOiAwLjAwMDMsXG4gIFwiZ3B0LTUtbmFub1wiOiAwLjAwMDEsXG4gIFwiZ3B0LTUuNC1taW5pXCI6IDAuMDAwNzUsXG4gIFwiZ3B0LTUtcHJvXCI6IDAuMDE1LFxuICBcImdwdC01LjFcIjogMC4wMDUsXG4gIFwiZ3B0LTUuMS1jb2RleC1tYXhcIjogMC4wMDMsXG4gIFwiZ3B0LTUuMS1jb2RleC1taW5pXCI6IDAuMDAwMyxcbiAgXCJncHQtNS4yXCI6IDAuMDA1LFxuICBcImdwdC01LjItY29kZXhcIjogMC4wMDUsXG4gIFwiZ3B0LTUuMy1jb2RleFwiOiAwLjAwNSxcbiAgXCJncHQtNS4zLWNvZGV4LXNwYXJrXCI6IDAuMDAwMyxcbiAgXCJncHQtNS40XCI6IDAuMDA1LFxuICBcImdwdC01LjVcIjogMC4wMDUsXG4gIFwibzQtbWluaVwiOiAwLjAwNSxcbiAgXCJvNC1taW5pLWRlZXAtcmVzZWFyY2hcIjogMC4wMDUsXG4gIFwiZ2VtaW5pLTIuMC1mbGFzaFwiOiAwLjAwMDEsXG4gIFwiZ2VtaW5pLTIuNS1wcm9cIjogMC4wMDEyNSxcbiAgXCJkZWVwc2Vlay1jaGF0XCI6IDAuMDAwMTQsXG59O1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQ2FwYWJpbGl0eSBQcm9maWxlcyBEYXRhIFRhYmxlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuLy8gUGVyLW1vZGVsIGNhcGFiaWxpdHkgcHJvZmlsZXMgKDBcdTIwMTMxMDAgc2NhbGUpLiBVc2VkIGZvciBjYXBhYmlsaXR5LWF3YXJlXG4vLyBtb2RlbCBzZWxlY3Rpb24gd2l0aGluIGFuIGVsaWdpYmxlIHRpZXIgc2V0LlxuXG5leHBvcnQgY29uc3QgTU9ERUxfQ0FQQUJJTElUWV9QUk9GSUxFUzogUmVjb3JkPHN0cmluZywgTW9kZWxDYXBhYmlsaXRpZXM+ID0ge1xuICAvLyBcdTI1MDBcdTI1MDAgQW50aHJvcGljIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBcImNsYXVkZS1vcHVzLTQtNlwiOiAgICAgICAgICAgICAgeyBjb2Rpbmc6IDk1LCBkZWJ1Z2dpbmc6IDkwLCByZXNlYXJjaDogODUsIHJlYXNvbmluZzogOTUsIHNwZWVkOiAzMCwgbG9uZ0NvbnRleHQ6IDgwLCBpbnN0cnVjdGlvbjogOTAgfSxcbiAgXCJjbGF1ZGUtb3B1cy00LTdcIjogICAgICAgICAgICAgIHsgY29kaW5nOiA5NSwgZGVidWdnaW5nOiA5MCwgcmVzZWFyY2g6IDg1LCByZWFzb25pbmc6IDk1LCBzcGVlZDogMzAsIGxvbmdDb250ZXh0OiA4MCwgaW5zdHJ1Y3Rpb246IDkwIH0sXG4gIFwiY2xhdWRlLXNvbm5ldC00LTZcIjogICAgICAgICAgICB7IGNvZGluZzogODUsIGRlYnVnZ2luZzogODAsIHJlc2VhcmNoOiA3NSwgcmVhc29uaW5nOiA4MCwgc3BlZWQ6IDYwLCBsb25nQ29udGV4dDogNzUsIGluc3RydWN0aW9uOiA4NSB9LFxuICBcImNsYXVkZS1zb25uZXQtNC01LTIwMjUwNTE0XCI6ICAgeyBjb2Rpbmc6IDg1LCBkZWJ1Z2dpbmc6IDgwLCByZXNlYXJjaDogNzUsIHJlYXNvbmluZzogODAsIHNwZWVkOiA2MCwgbG9uZ0NvbnRleHQ6IDc1LCBpbnN0cnVjdGlvbjogODUgfSxcbiAgXCJjbGF1ZGUtMy01LXNvbm5ldC1sYXRlc3RcIjogICAgIHsgY29kaW5nOiA4MiwgZGVidWdnaW5nOiA3OCwgcmVzZWFyY2g6IDcyLCByZWFzb25pbmc6IDc4LCBzcGVlZDogNjIsIGxvbmdDb250ZXh0OiA3MCwgaW5zdHJ1Y3Rpb246IDgyIH0sXG4gIFwiY2xhdWRlLWhhaWt1LTQtNVwiOiAgICAgICAgICAgICB7IGNvZGluZzogNjAsIGRlYnVnZ2luZzogNTAsIHJlc2VhcmNoOiA0NSwgcmVhc29uaW5nOiA1MCwgc3BlZWQ6IDk1LCBsb25nQ29udGV4dDogNTAsIGluc3RydWN0aW9uOiA3NSB9LFxuICBcImNsYXVkZS0zLTUtaGFpa3UtbGF0ZXN0XCI6ICAgICAgeyBjb2Rpbmc6IDYwLCBkZWJ1Z2dpbmc6IDUwLCByZXNlYXJjaDogNDUsIHJlYXNvbmluZzogNTAsIHNwZWVkOiA5NSwgbG9uZ0NvbnRleHQ6IDUwLCBpbnN0cnVjdGlvbjogNzUgfSxcbiAgXCJjbGF1ZGUtMy1oYWlrdS0yMDI0MDMwN1wiOiAgICAgIHsgY29kaW5nOiA1MCwgZGVidWdnaW5nOiA0MCwgcmVzZWFyY2g6IDM1LCByZWFzb25pbmc6IDQwLCBzcGVlZDogOTUsIGxvbmdDb250ZXh0OiA0MCwgaW5zdHJ1Y3Rpb246IDY1IH0sXG4gIFwiY2xhdWRlLTMtb3B1cy1sYXRlc3RcIjogICAgICAgICB7IGNvZGluZzogOTAsIGRlYnVnZ2luZzogODUsIHJlc2VhcmNoOiA4MiwgcmVhc29uaW5nOiA5MCwgc3BlZWQ6IDM1LCBsb25nQ29udGV4dDogNzUsIGluc3RydWN0aW9uOiA4OCB9LFxuXG4gIC8vIFx1MjUwMFx1MjUwMCBPcGVuQUkgR1BUIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBcImdwdC00b1wiOiAgICAgICAgICAgICAgICAgICAgICAgeyBjb2Rpbmc6IDgwLCBkZWJ1Z2dpbmc6IDc1LCByZXNlYXJjaDogNzAsIHJlYXNvbmluZzogNzUsIHNwZWVkOiA2NSwgbG9uZ0NvbnRleHQ6IDcwLCBpbnN0cnVjdGlvbjogODAgfSxcbiAgXCJncHQtNG8tbWluaVwiOiAgICAgICAgICAgICAgICAgIHsgY29kaW5nOiA1NSwgZGVidWdnaW5nOiA0NSwgcmVzZWFyY2g6IDQwLCByZWFzb25pbmc6IDQ1LCBzcGVlZDogOTAsIGxvbmdDb250ZXh0OiA0NSwgaW5zdHJ1Y3Rpb246IDcwIH0sXG4gIFwiZ3B0LTQtdHVyYm9cIjogICAgICAgICAgICAgICAgICB7IGNvZGluZzogNzgsIGRlYnVnZ2luZzogNzIsIHJlc2VhcmNoOiA2OCwgcmVhc29uaW5nOiA3Miwgc3BlZWQ6IDUwLCBsb25nQ29udGV4dDogNjUsIGluc3RydWN0aW9uOiA3OCB9LFxuICBcImdwdC00LjFcIjogICAgICAgICAgICAgICAgICAgICAgeyBjb2Rpbmc6IDgyLCBkZWJ1Z2dpbmc6IDc4LCByZXNlYXJjaDogNzIsIHJlYXNvbmluZzogNzgsIHNwZWVkOiA2MiwgbG9uZ0NvbnRleHQ6IDcyLCBpbnN0cnVjdGlvbjogODIgfSxcbiAgXCJncHQtNC4xLW1pbmlcIjogICAgICAgICAgICAgICAgIHsgY29kaW5nOiA1OCwgZGVidWdnaW5nOiA0OCwgcmVzZWFyY2g6IDQyLCByZWFzb25pbmc6IDQ4LCBzcGVlZDogODgsIGxvbmdDb250ZXh0OiA0OCwgaW5zdHJ1Y3Rpb246IDcyIH0sXG4gIFwiZ3B0LTQuMS1uYW5vXCI6ICAgICAgICAgICAgICAgICB7IGNvZGluZzogNDAsIGRlYnVnZ2luZzogMzAsIHJlc2VhcmNoOiAyNSwgcmVhc29uaW5nOiAzMCwgc3BlZWQ6IDk1LCBsb25nQ29udGV4dDogMzAsIGluc3RydWN0aW9uOiA2MCB9LFxuICBcImdwdC01XCI6ICAgICAgICAgICAgICAgICAgICAgICAgeyBjb2Rpbmc6IDkyLCBkZWJ1Z2dpbmc6IDg4LCByZXNlYXJjaDogODUsIHJlYXNvbmluZzogOTIsIHNwZWVkOiA0MCwgbG9uZ0NvbnRleHQ6IDg1LCBpbnN0cnVjdGlvbjogOTAgfSxcbiAgXCJncHQtNS1taW5pXCI6ICAgICAgICAgICAgICAgICAgIHsgY29kaW5nOiA2MiwgZGVidWdnaW5nOiA1MiwgcmVzZWFyY2g6IDQ4LCByZWFzb25pbmc6IDUyLCBzcGVlZDogODgsIGxvbmdDb250ZXh0OiA1MiwgaW5zdHJ1Y3Rpb246IDc0IH0sXG4gIFwiZ3B0LTUtbmFub1wiOiAgICAgICAgICAgICAgICAgICB7IGNvZGluZzogNDIsIGRlYnVnZ2luZzogMzIsIHJlc2VhcmNoOiAyOCwgcmVhc29uaW5nOiAzMiwgc3BlZWQ6IDk1LCBsb25nQ29udGV4dDogMzIsIGluc3RydWN0aW9uOiA2MiB9LFxuICBcImdwdC01LjQtbWluaVwiOiAgICAgICAgICAgICAgICAgeyBjb2Rpbmc6IDcwLCBkZWJ1Z2dpbmc6IDYwLCByZXNlYXJjaDogNTUsIHJlYXNvbmluZzogNjAsIHNwZWVkOiA4NCwgbG9uZ0NvbnRleHQ6IDYwLCBpbnN0cnVjdGlvbjogNzggfSxcbiAgXCJncHQtNS1wcm9cIjogICAgICAgICAgICAgICAgICAgIHsgY29kaW5nOiA5NCwgZGVidWdnaW5nOiA5MCwgcmVzZWFyY2g6IDg4LCByZWFzb25pbmc6IDk0LCBzcGVlZDogMzUsIGxvbmdDb250ZXh0OiA4OCwgaW5zdHJ1Y3Rpb246IDkyIH0sXG4gIFwiZ3B0LTUuMVwiOiAgICAgICAgICAgICAgICAgICAgICB7IGNvZGluZzogOTMsIGRlYnVnZ2luZzogODksIHJlc2VhcmNoOiA4NiwgcmVhc29uaW5nOiA5Mywgc3BlZWQ6IDQyLCBsb25nQ29udGV4dDogODYsIGluc3RydWN0aW9uOiA5MSB9LFxuICBcImdwdC01LjEtY29kZXgtbWF4XCI6ICAgICAgICAgICAgeyBjb2Rpbmc6IDkwLCBkZWJ1Z2dpbmc6IDg1LCByZXNlYXJjaDogNzAsIHJlYXNvbmluZzogODUsIHNwZWVkOiA1NSwgbG9uZ0NvbnRleHQ6IDc1LCBpbnN0cnVjdGlvbjogODUgfSxcbiAgXCJncHQtNS4xLWNvZGV4LW1pbmlcIjogICAgICAgICAgIHsgY29kaW5nOiA2NSwgZGVidWdnaW5nOiA1NSwgcmVzZWFyY2g6IDQwLCByZWFzb25pbmc6IDUwLCBzcGVlZDogODgsIGxvbmdDb250ZXh0OiA0OCwgaW5zdHJ1Y3Rpb246IDcyIH0sXG4gIFwiZ3B0LTUuMlwiOiAgICAgICAgICAgICAgICAgICAgICB7IGNvZGluZzogOTMsIGRlYnVnZ2luZzogOTAsIHJlc2VhcmNoOiA4NywgcmVhc29uaW5nOiA5Mywgc3BlZWQ6IDQyLCBsb25nQ29udGV4dDogODcsIGluc3RydWN0aW9uOiA5MSB9LFxuICBcImdwdC01LjItY29kZXhcIjogICAgICAgICAgICAgICAgeyBjb2Rpbmc6IDkzLCBkZWJ1Z2dpbmc6IDkwLCByZXNlYXJjaDogNzIsIHJlYXNvbmluZzogODgsIHNwZWVkOiA1MCwgbG9uZ0NvbnRleHQ6IDc4LCBpbnN0cnVjdGlvbjogODggfSxcbiAgXCJncHQtNS4zLWNvZGV4XCI6ICAgICAgICAgICAgICAgIHsgY29kaW5nOiA5NCwgZGVidWdnaW5nOiA5MSwgcmVzZWFyY2g6IDc0LCByZWFzb25pbmc6IDg5LCBzcGVlZDogNTAsIGxvbmdDb250ZXh0OiA4MCwgaW5zdHJ1Y3Rpb246IDg5IH0sXG4gIFwiZ3B0LTUuMy1jb2RleC1zcGFya1wiOiAgICAgICAgICB7IGNvZGluZzogNjgsIGRlYnVnZ2luZzogNTgsIHJlc2VhcmNoOiA0MiwgcmVhc29uaW5nOiA1Miwgc3BlZWQ6IDkwLCBsb25nQ29udGV4dDogNTAsIGluc3RydWN0aW9uOiA3NCB9LFxuICBcImdwdC01LjRcIjogICAgICAgICAgICAgICAgICAgICAgeyBjb2Rpbmc6IDk1LCBkZWJ1Z2dpbmc6IDkyLCByZXNlYXJjaDogODgsIHJlYXNvbmluZzogOTQsIHNwZWVkOiA0MiwgbG9uZ0NvbnRleHQ6IDg4LCBpbnN0cnVjdGlvbjogOTIgfSxcbiAgLy8gR1BULTUuNSBzY29yZXMgYXJlIHJlbGF0aXZlIHRvIHRoZSBleGlzdGluZyBncHQtNS40IHByb2ZpbGUgYW5kIGJhY2tlZCBieVxuICAvLyBPcGVuQUkncyAyMDI2LTA0LTIzIHB1Ymxpc2hlZCBldmFsIGRlbHRhcyBhY3Jvc3MgY29kaW5nLCB0b29sIHVzZSwgYW5kIGxvbmcgY29udGV4dC5cbiAgLy8gU291cmNlOiBodHRwczovL29wZW5haS5jb20vaW5kZXgvaW50cm9kdWNpbmctZ3B0LTUtNS9cbiAgXCJncHQtNS41XCI6ICAgICAgICAgICAgICAgICAgICAgIHsgY29kaW5nOiA5NiwgZGVidWdnaW5nOiA5MywgcmVzZWFyY2g6IDg5LCByZWFzb25pbmc6IDk1LCBzcGVlZDogNDIsIGxvbmdDb250ZXh0OiA5MCwgaW5zdHJ1Y3Rpb246IDkzIH0sXG5cbiAgLy8gXHUyNTAwXHUyNTAwIE9wZW5BSSBvLXNlcmllcyAocmVhc29uaW5nLWZpcnN0KSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgXCJvMVwiOiAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgY29kaW5nOiA3OCwgZGVidWdnaW5nOiA4MiwgcmVzZWFyY2g6IDc4LCByZWFzb25pbmc6IDkwLCBzcGVlZDogMjAsIGxvbmdDb250ZXh0OiA2NSwgaW5zdHJ1Y3Rpb246IDgyIH0sXG4gIFwibzNcIjogICAgICAgICAgICAgICAgICAgICAgICAgICB7IGNvZGluZzogODAsIGRlYnVnZ2luZzogODUsIHJlc2VhcmNoOiA4MCwgcmVhc29uaW5nOiA5Miwgc3BlZWQ6IDI1LCBsb25nQ29udGV4dDogNzAsIGluc3RydWN0aW9uOiA4NSB9LFxuICBcIm80LW1pbmlcIjogICAgICAgICAgICAgICAgICAgICAgeyBjb2Rpbmc6IDc1LCBkZWJ1Z2dpbmc6IDgwLCByZXNlYXJjaDogNzIsIHJlYXNvbmluZzogODgsIHNwZWVkOiA2MCwgbG9uZ0NvbnRleHQ6IDY1LCBpbnN0cnVjdGlvbjogODAgfSxcbiAgXCJvNC1taW5pLWRlZXAtcmVzZWFyY2hcIjogICAgICAgIHsgY29kaW5nOiA3NSwgZGVidWdnaW5nOiA4MCwgcmVzZWFyY2g6IDg1LCByZWFzb25pbmc6IDg4LCBzcGVlZDogMzAsIGxvbmdDb250ZXh0OiA4MCwgaW5zdHJ1Y3Rpb246IDgwIH0sXG5cbiAgLy8gXHUyNTAwXHUyNTAwIEdvb2dsZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgXCJnZW1pbmktMi41LXByb1wiOiAgICAgICAgICAgICAgIHsgY29kaW5nOiA3NSwgZGVidWdnaW5nOiA3MCwgcmVzZWFyY2g6IDg1LCByZWFzb25pbmc6IDc1LCBzcGVlZDogNTUsIGxvbmdDb250ZXh0OiA5MCwgaW5zdHJ1Y3Rpb246IDc1IH0sXG4gIFwiZ2VtaW5pLTIuMC1mbGFzaFwiOiAgICAgICAgICAgICB7IGNvZGluZzogNTAsIGRlYnVnZ2luZzogNDAsIHJlc2VhcmNoOiA1MCwgcmVhc29uaW5nOiA0MCwgc3BlZWQ6IDk1LCBsb25nQ29udGV4dDogNjAsIGluc3RydWN0aW9uOiA2NSB9LFxuICBcImdlbWluaS1mbGFzaC0yLjBcIjogICAgICAgICAgICAgeyBjb2Rpbmc6IDUwLCBkZWJ1Z2dpbmc6IDQwLCByZXNlYXJjaDogNTAsIHJlYXNvbmluZzogNDAsIHNwZWVkOiA5NSwgbG9uZ0NvbnRleHQ6IDYwLCBpbnN0cnVjdGlvbjogNjUgfSxcblxuICAvLyBcdTI1MDBcdTI1MDAgRGVlcFNlZWsgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIFwiZGVlcHNlZWstY2hhdFwiOiAgICAgICAgICAgICAgICB7IGNvZGluZzogNzUsIGRlYnVnZ2luZzogNjUsIHJlc2VhcmNoOiA1NSwgcmVhc29uaW5nOiA3MCwgc3BlZWQ6IDcwLCBsb25nQ29udGV4dDogNTUsIGluc3RydWN0aW9uOiA2NSB9LFxufTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEJhc2UgVGFzayBSZXF1aXJlbWVudHMgRGF0YSBUYWJsZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbi8vIFBlci11bml0LXR5cGUgYmFzZSByZXF1aXJlbWVudCB2ZWN0b3JzLiBXZWlnaHRzIGluZGljYXRlIGhvdyBpbXBvcnRhbnQgZWFjaFxuLy8gY2FwYWJpbGl0eSBkaW1lbnNpb24gaXMgZm9yIHRoaXMgdW5pdCB0eXBlLlxuXG5leHBvcnQgY29uc3QgQkFTRV9SRVFVSVJFTUVOVFM6IFJlY29yZDxzdHJpbmcsIFBhcnRpYWw8UmVjb3JkPGtleW9mIE1vZGVsQ2FwYWJpbGl0aWVzLCBudW1iZXI+Pj4gPSB7XG4gIFwiZXhlY3V0ZS10YXNrXCI6ICAgICAgIHsgY29kaW5nOiAwLjksIGluc3RydWN0aW9uOiAwLjcsIHNwZWVkOiAwLjMgfSxcbiAgXCJyZXNlYXJjaC1taWxlc3RvbmVcIjogeyByZXNlYXJjaDogMC45LCBsb25nQ29udGV4dDogMC43LCByZWFzb25pbmc6IDAuNSB9LFxuICBcInJlc2VhcmNoLXNsaWNlXCI6ICAgICB7IHJlc2VhcmNoOiAwLjksIGxvbmdDb250ZXh0OiAwLjcsIHJlYXNvbmluZzogMC41IH0sXG4gIFwicGxhbi1taWxlc3RvbmVcIjogICAgIHsgcmVhc29uaW5nOiAwLjksIGNvZGluZzogMC41IH0sXG4gIFwicGxhbi1zbGljZVwiOiAgICAgICAgIHsgcmVhc29uaW5nOiAwLjksIGNvZGluZzogMC41IH0sXG4gIFwicmVwbGFuLXNsaWNlXCI6ICAgICAgIHsgcmVhc29uaW5nOiAwLjksIGRlYnVnZ2luZzogMC42LCBjb2Rpbmc6IDAuNSB9LFxuICBcInJlYXNzZXNzLXJvYWRtYXBcIjogICB7IHJlYXNvbmluZzogMC45LCByZXNlYXJjaDogMC41IH0sXG4gIFwiY29tcGxldGUtc2xpY2VcIjogICAgIHsgaW5zdHJ1Y3Rpb246IDAuOCwgc3BlZWQ6IDAuNyB9LFxuICBcInJ1bi11YXRcIjogICAgICAgICAgICB7IGluc3RydWN0aW9uOiAwLjcsIHNwZWVkOiAwLjggfSxcbiAgXCJkaXNjdXNzLW1pbGVzdG9uZVwiOiAgeyByZWFzb25pbmc6IDAuNiwgaW5zdHJ1Y3Rpb246IDAuNyB9LFxuICBcImNvbXBsZXRlLW1pbGVzdG9uZVwiOiB7IGluc3RydWN0aW9uOiAwLjgsIHJlYXNvbmluZzogMC41IH0sXG59O1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUHVibGljIEFQSSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBTY29yZSBhIG1vZGVsJ3Mgc3VpdGFiaWxpdHkgZm9yIGEgdGFzayBnaXZlbiBhIHJlcXVpcmVtZW50IHZlY3Rvci5cbiAqIFJldHVybnMgYSB3ZWlnaHRlZCBhdmVyYWdlIG9mIGNhcGFiaWxpdHkgZGltZW5zaW9ucyAoMFx1MjAxMzEwMCkuXG4gKiBSZXR1cm5zIDUwIGlmIHJlcXVpcmVtZW50cyBhcmUgZW1wdHkgKG5ldXRyYWwgc2NvcmUpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2NvcmVNb2RlbChcbiAgbW9kZWw6IE1vZGVsQ2FwYWJpbGl0aWVzLFxuICByZXF1aXJlbWVudHM6IFBhcnRpYWw8UmVjb3JkPGtleW9mIE1vZGVsQ2FwYWJpbGl0aWVzLCBudW1iZXI+Pixcbik6IG51bWJlciB7XG4gIGxldCB3ZWlnaHRlZFN1bSA9IDA7XG4gIGxldCB3ZWlnaHRTdW0gPSAwO1xuICBmb3IgKGNvbnN0IFtkaW0sIHdlaWdodF0gb2YgT2JqZWN0LmVudHJpZXMocmVxdWlyZW1lbnRzKSkge1xuICAgIGNvbnN0IGNhcGFiaWxpdHkgPSBtb2RlbFtkaW0gYXMga2V5b2YgTW9kZWxDYXBhYmlsaXRpZXNdID8/IDUwO1xuICAgIHdlaWdodGVkU3VtICs9IHdlaWdodCAqIGNhcGFiaWxpdHk7XG4gICAgd2VpZ2h0U3VtICs9IHdlaWdodDtcbiAgfVxuICByZXR1cm4gd2VpZ2h0U3VtID4gMCA/IHdlaWdodGVkU3VtIC8gd2VpZ2h0U3VtIDogNTA7XG59XG5cbi8qKlxuICogQ29tcHV0ZSBkeW5hbWljIHRhc2sgcmVxdWlyZW1lbnRzIGZyb20gdW5pdCB0eXBlIGFuZCBvcHRpb25hbCB0YXNrIG1ldGFkYXRhLlxuICogUmV0dXJucyBhIHJlcXVpcmVtZW50IHZlY3RvciByZWZpbmVkIGJ5IHRhc2stc3BlY2lmaWMgc2lnbmFscy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbXB1dGVUYXNrUmVxdWlyZW1lbnRzKFxuICB1bml0VHlwZTogc3RyaW5nLFxuICBtZXRhZGF0YT86IFRhc2tNZXRhZGF0YSxcbik6IFBhcnRpYWw8UmVjb3JkPGtleW9mIE1vZGVsQ2FwYWJpbGl0aWVzLCBudW1iZXI+PiB7XG4gIGNvbnN0IGJhc2UgPSBCQVNFX1JFUVVJUkVNRU5UU1t1bml0VHlwZV0gPz8geyByZWFzb25pbmc6IDAuNSB9O1xuICBpZiAodW5pdFR5cGUgPT09IFwiZXhlY3V0ZS10YXNrXCIgJiYgbWV0YWRhdGEpIHtcbiAgICBpZiAobWV0YWRhdGEudGFncz8uc29tZSh0ID0+IC9eKGRvY3M/fHJlYWRtZXxjb21tZW50fGNvbmZpZ3x0eXBvfHJlbmFtZSkkL2kudGVzdCh0KSkpIHtcbiAgICAgIHJldHVybiB7IC4uLmJhc2UsIGluc3RydWN0aW9uOiAwLjksIGNvZGluZzogMC4zLCBzcGVlZDogMC43IH07XG4gICAgfVxuICAgIGlmIChtZXRhZGF0YS5jb21wbGV4aXR5S2V5d29yZHM/LnNvbWUoayA9PiBrID09PSBcImNvbmN1cnJlbmN5XCIgfHwgayA9PT0gXCJjb21wYXRpYmlsaXR5XCIpKSB7XG4gICAgICByZXR1cm4geyAuLi5iYXNlLCBkZWJ1Z2dpbmc6IDAuOSwgcmVhc29uaW5nOiAwLjggfTtcbiAgICB9XG4gICAgaWYgKG1ldGFkYXRhLmNvbXBsZXhpdHlLZXl3b3Jkcz8uc29tZShrID0+IGsgPT09IFwibWlncmF0aW9uXCIgfHwgayA9PT0gXCJhcmNoaXRlY3R1cmVcIikpIHtcbiAgICAgIHJldHVybiB7IC4uLmJhc2UsIHJlYXNvbmluZzogMC45LCBjb2Rpbmc6IDAuOCB9O1xuICAgIH1cbiAgICBpZiAoKG1ldGFkYXRhLmZpbGVDb3VudCA/PyAwKSA+PSA2IHx8IChtZXRhZGF0YS5lc3RpbWF0ZWRMaW5lcyA/PyAwKSA+PSA1MDApIHtcbiAgICAgIHJldHVybiB7IC4uLmJhc2UsIGNvZGluZzogMC45LCByZWFzb25pbmc6IDAuNyB9O1xuICAgIH1cbiAgfVxuICByZXR1cm4gYmFzZTtcbn1cblxuLyoqXG4gKiBTY29yZSBhbGwgZWxpZ2libGUgbW9kZWxzIGFnYWluc3QgYSByZXF1aXJlbWVudCB2ZWN0b3IgYW5kIHJldHVybiB0aGVtXG4gKiBzb3J0ZWQgYnkgc2NvcmUgZGVzY2VuZGluZy4gV2l0aGluIDIgcG9pbnRzOiBwcmVmZXIgY2hlYXBlcjsgZXF1YWwgY29zdDpcbiAqIGxleGljb2dyYXBoaWMgdGllLWJyZWFrIGJ5IG1vZGVsIElELlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2NvcmVFbGlnaWJsZU1vZGVscyhcbiAgZWxpZ2libGVNb2RlbElkczogc3RyaW5nW10sXG4gIHJlcXVpcmVtZW50czogUGFydGlhbDxSZWNvcmQ8a2V5b2YgTW9kZWxDYXBhYmlsaXRpZXMsIG51bWJlcj4+LFxuICBjYXBhYmlsaXR5T3ZlcnJpZGVzPzogUmVjb3JkPHN0cmluZywgUGFydGlhbDxNb2RlbENhcGFiaWxpdGllcz4+LFxuKTogQXJyYXk8eyBtb2RlbElkOiBzdHJpbmc7IHNjb3JlOiBudW1iZXIgfT4ge1xuICBjb25zdCBzY29yZWQgPSBlbGlnaWJsZU1vZGVsSWRzLm1hcChtb2RlbElkID0+IHtcbiAgICBjb25zdCBiYXJlSWQgPSBiYXJlTW9kZWxJZChtb2RlbElkKTtcbiAgICBjb25zdCBidWlsdGluID0gTU9ERUxfQ0FQQUJJTElUWV9QUk9GSUxFU1tiYXJlSWRdO1xuICAgIGNvbnN0IG92ZXJyaWRlID0gY2FwYWJpbGl0eU92ZXJyaWRlcz8uW21vZGVsSWRdID8/IGNhcGFiaWxpdHlPdmVycmlkZXM/LltiYXJlSWRdO1xuICAgIGNvbnN0IHByb2ZpbGU6IE1vZGVsQ2FwYWJpbGl0aWVzID0gYnVpbHRpblxuICAgICAgPyBvdmVycmlkZSA/IHsgLi4uYnVpbHRpbiwgLi4ub3ZlcnJpZGUgfSA6IGJ1aWx0aW5cbiAgICAgIDogeyBjb2Rpbmc6IDUwLCBkZWJ1Z2dpbmc6IDUwLCByZXNlYXJjaDogNTAsIHJlYXNvbmluZzogNTAsIHNwZWVkOiA1MCwgbG9uZ0NvbnRleHQ6IDUwLCBpbnN0cnVjdGlvbjogNTAgfTtcbiAgICByZXR1cm4geyBtb2RlbElkLCBzY29yZTogc2NvcmVNb2RlbChwcm9maWxlLCByZXF1aXJlbWVudHMpIH07XG4gIH0pO1xuICBzY29yZWQuc29ydCgoYSwgYikgPT4ge1xuICAgIGNvbnN0IHNjb3JlRGlmZiA9IGIuc2NvcmUgLSBhLnNjb3JlO1xuICAgIGlmIChNYXRoLmFicyhzY29yZURpZmYpID4gMikgcmV0dXJuIHNjb3JlRGlmZjtcbiAgICBjb25zdCBjb3N0QSA9IE1PREVMX0NPU1RfUEVSXzFLX0lOUFVUW2EubW9kZWxJZF0gPz8gSW5maW5pdHk7XG4gICAgY29uc3QgY29zdEIgPSBNT0RFTF9DT1NUX1BFUl8xS19JTlBVVFtiLm1vZGVsSWRdID8/IEluZmluaXR5O1xuICAgIGlmIChjb3N0QSAhPT0gY29zdEIpIHJldHVybiBjb3N0QSAtIGNvc3RCO1xuICAgIHJldHVybiBhLm1vZGVsSWQubG9jYWxlQ29tcGFyZShiLm1vZGVsSWQpO1xuICB9KTtcbiAgcmV0dXJuIHNjb3JlZDtcbn1cblxuLyoqXG4gKiBSZXR1cm4gYWxsIG1vZGVscyBlbGlnaWJsZSBmb3IgYSBnaXZlbiB0aWVyLCBzb3J0ZWQgY2hlYXBlc3QgZmlyc3QuXG4gKiBJZiByb3V0aW5nQ29uZmlnLnRpZXJfbW9kZWxzW3RpZXJdIGlzIHNldCBhbmQgYXZhaWxhYmxlLCByZXR1cm5zIG9ubHkgdGhhdFxuICogbW9kZWwuIE90aGVyd2lzZSBmaWx0ZXJzIGF2YWlsYWJsZU1vZGVsSWRzIGJ5IHRpZXIgZnJvbSBNT0RFTF9DQVBBQklMSVRZX1RJRVIuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRFbGlnaWJsZU1vZGVscyhcbiAgdGllcjogQ29tcGxleGl0eVRpZXIsXG4gIGF2YWlsYWJsZU1vZGVsSWRzOiBzdHJpbmdbXSxcbiAgcm91dGluZ0NvbmZpZzogRHluYW1pY1JvdXRpbmdDb25maWcsXG4pOiBzdHJpbmdbXSB7XG4gIC8vIDEuIENoZWNrIGV4cGxpY2l0IHRpZXJfbW9kZWxzIGNvbmZpZ1xuICBjb25zdCBleHBsaWNpdE1vZGVsID0gcm91dGluZ0NvbmZpZy50aWVyX21vZGVscz8uW3RpZXJdO1xuICBpZiAoZXhwbGljaXRNb2RlbCkge1xuICAgIC8vIEV4YWN0IG1hdGNoXG4gICAgaWYgKGF2YWlsYWJsZU1vZGVsSWRzLmluY2x1ZGVzKGV4cGxpY2l0TW9kZWwpKSByZXR1cm4gW2V4cGxpY2l0TW9kZWxdO1xuICAgIC8vIFByb3ZpZGVyLXByZWZpeC1zdHJpcHBlZCBtYXRjaFxuICAgIGNvbnN0IGJhcmVFeHBsaWNpdCA9IGJhcmVNb2RlbElkKGV4cGxpY2l0TW9kZWwpO1xuICAgIGNvbnN0IG1hdGNoID0gYXZhaWxhYmxlTW9kZWxJZHMuZmluZChpZCA9PiBiYXJlTW9kZWxJZChpZCkgPT09IGJhcmVFeHBsaWNpdCk7XG4gICAgaWYgKG1hdGNoKSByZXR1cm4gW21hdGNoXTtcbiAgfVxuXG4gIC8vIDIuIEF1dG8tZGV0ZWN0OiBmaWx0ZXIgYnkgdGllciwgc29ydCBjaGVhcGVzdCBmaXJzdFxuICByZXR1cm4gYXZhaWxhYmxlTW9kZWxJZHNcbiAgICAuZmlsdGVyKGlkID0+IGdldE1vZGVsVGllcihpZCkgPT09IHRpZXIpXG4gICAgLnNvcnQoKGEsIGIpID0+IHtcbiAgICAgIGNvbnN0IGNvc3RBID0gZ2V0TW9kZWxDb3N0KGEpO1xuICAgICAgY29uc3QgY29zdEIgPSBnZXRNb2RlbENvc3QoYik7XG4gICAgICByZXR1cm4gY29zdEEgLSBjb3N0QjtcbiAgICB9KTtcbn1cblxuLyoqXG4gKiBCdWlsZCBhIGZhbGxiYWNrIGNoYWluIGZvciBhIHNlbGVjdGVkIG1vZGVsOiBbc2VsZWN0ZWRNb2RlbCwgLi4uY29uZmlndXJlZEZhbGxiYWNrcywgY29uZmlndXJlZFByaW1hcnldXG4gKiBEZWR1cGxpY2F0ZXMgZW50cmllcyB3aGlsZSBwcmVzZXJ2aW5nIG9yZGVyLlxuICovXG5mdW5jdGlvbiBidWlsZEZhbGxiYWNrQ2hhaW4oc2VsZWN0ZWRNb2RlbElkOiBzdHJpbmcsIHBoYXNlQ29uZmlnOiBSZXNvbHZlZE1vZGVsQ29uZmlnKTogc3RyaW5nW10ge1xuICByZXR1cm4gW1xuICAgIC4uLnBoYXNlQ29uZmlnLmZhbGxiYWNrcy5maWx0ZXIoZiA9PiBmICE9PSBzZWxlY3RlZE1vZGVsSWQpLFxuICAgIHBoYXNlQ29uZmlnLnByaW1hcnksXG4gIF0uZmlsdGVyKGYgPT4gZiAhPT0gc2VsZWN0ZWRNb2RlbElkKTtcbn1cblxuLyoqXG4gKiBMb2FkIGNhcGFiaWxpdHkgb3ZlcnJpZGVzIGZyb20gdXNlciBwcmVmZXJlbmNlcycgbW9kZWxPdmVycmlkZXMgc2VjdGlvbi5cbiAqIFJldHVybnMgYSBtYXAgb2YgbW9kZWwgSUQgXHUyMTkyIHBhcnRpYWwgY2FwYWJpbGl0eSBvdmVycmlkZXMgdG8gZGVlcC1tZXJnZSB3aXRoIGJ1aWx0LWluIHByb2ZpbGVzLlxuICpcbiAqIFBlciBELTE3OiBwYXJ0aWFsIGNhcGFiaWxpdHkgb3ZlcnJpZGVzIHZpYSBtb2RlbHMuanNvbiBtb2RlbE92ZXJyaWRlcywgZGVlcC1tZXJnZWQgd2l0aCBkZWZhdWx0cy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxvYWRDYXBhYmlsaXR5T3ZlcnJpZGVzKFxuICBwcmVmczogeyBtb2RlbE92ZXJyaWRlcz86IFJlY29yZDxzdHJpbmcsIHsgY2FwYWJpbGl0aWVzPzogUGFydGlhbDxNb2RlbENhcGFiaWxpdGllcz4gfT4gfSxcbik6IFJlY29yZDxzdHJpbmcsIFBhcnRpYWw8TW9kZWxDYXBhYmlsaXRpZXM+PiB7XG4gIGNvbnN0IHJlc3VsdDogUmVjb3JkPHN0cmluZywgUGFydGlhbDxNb2RlbENhcGFiaWxpdGllcz4+ID0ge307XG4gIGlmICghcHJlZnMubW9kZWxPdmVycmlkZXMpIHJldHVybiByZXN1bHQ7XG4gIGZvciAoY29uc3QgW21vZGVsSWQsIG92ZXJyaWRlRW50cnldIG9mIE9iamVjdC5lbnRyaWVzKHByZWZzLm1vZGVsT3ZlcnJpZGVzKSkge1xuICAgIGlmIChvdmVycmlkZUVudHJ5LmNhcGFiaWxpdGllcykge1xuICAgICAgcmVzdWx0W21vZGVsSWRdID0gb3ZlcnJpZGVFbnRyeS5jYXBhYmlsaXRpZXM7XG4gICAgfVxuICB9XG4gIHJldHVybiByZXN1bHQ7XG59XG5cbi8qKlxuICogUmVzb2x2ZSB0aGUgbW9kZWwgdG8gdXNlIGZvciBhIGdpdmVuIGNvbXBsZXhpdHkgdGllci5cbiAqXG4gKiBEb3duZ3JhZGUtb25seTogdGhlIHJldHVybmVkIG1vZGVsIGlzIGFsd2F5cyBlcXVhbCB0byBvciBjaGVhcGVyIHRoYW5cbiAqIHRoZSB1c2VyJ3MgY29uZmlndXJlZCBwcmltYXJ5IG1vZGVsLiBOZXZlciB1cGdyYWRlcyBiZXlvbmQgY29uZmlndXJhdGlvbi5cbiAqXG4gKiBTVEVQIDE6IEZpbHRlciB0byBlbGlnaWJsZSBtb2RlbHMgZm9yIHRoZSByZXF1ZXN0ZWQgdGllci5cbiAqIFNURVAgMjogQ2FwYWJpbGl0eSBzY29yaW5nIFx1MjAxNCByYW5rcyBlbGlnaWJsZSBtb2RlbHMgYnkgdGFzay1jYXBhYmlsaXR5IG1hdGNoXG4gKiAgICAgICAgIHdoZW4gY2FwYWJpbGl0eV9yb3V0aW5nIGlzIGVuYWJsZWQgYW5kIG11bHRpcGxlIGVsaWdpYmxlIG1vZGVscyBleGlzdC5cbiAqIFNURVAgMzogRmFsbGJhY2sgY2hhaW4gYXNzZW1ibHkuXG4gKlxuICogQHBhcmFtIGNsYXNzaWZpY2F0aW9uICAgICAgVGhlIGNvbXBsZXhpdHkgY2xhc3NpZmljYXRpb24gcmVzdWx0XG4gKiBAcGFyYW0gcGhhc2VDb25maWcgICAgICAgICBUaGUgdXNlcidzIGNvbmZpZ3VyZWQgbW9kZWwgZm9yIHRoaXMgcGhhc2UgKGNlaWxpbmcpXG4gKiBAcGFyYW0gcm91dGluZ0NvbmZpZyAgICAgICBEeW5hbWljIHJvdXRpbmcgY29uZmlndXJhdGlvblxuICogQHBhcmFtIGF2YWlsYWJsZU1vZGVsSWRzICAgTGlzdCBvZiBhdmFpbGFibGUgbW9kZWwgSURzIChmcm9tIHJlZ2lzdHJ5KVxuICogQHBhcmFtIHVuaXRUeXBlICAgICAgICAgICAgVGhlIHVuaXQgdHlwZSBmb3IgY2FwYWJpbGl0eSByZXF1aXJlbWVudCBjb21wdXRhdGlvbiAob3B0aW9uYWwpXG4gKiBAcGFyYW0gdGFza01ldGFkYXRhICAgICAgICBUYXNrIG1ldGFkYXRhIGZvciByZWZpbmVkIHJlcXVpcmVtZW50IHZlY3RvcnMgKG9wdGlvbmFsKVxuICogQHBhcmFtIGNhcGFiaWxpdHlPdmVycmlkZXMgVXNlci1wcm92aWRlZCBjYXBhYmlsaXR5IG92ZXJyaWRlcyAoZGVlcC1tZXJnZWQgd2l0aCBidWlsdC1pbiBwcm9maWxlcywgb3B0aW9uYWwpXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlTW9kZWxGb3JDb21wbGV4aXR5KFxuICBjbGFzc2lmaWNhdGlvbjogQ2xhc3NpZmljYXRpb25SZXN1bHQsXG4gIHBoYXNlQ29uZmlnOiBSZXNvbHZlZE1vZGVsQ29uZmlnIHwgdW5kZWZpbmVkLFxuICByb3V0aW5nQ29uZmlnOiBEeW5hbWljUm91dGluZ0NvbmZpZyxcbiAgYXZhaWxhYmxlTW9kZWxJZHM6IHN0cmluZ1tdLFxuICB1bml0VHlwZT86IHN0cmluZyxcbiAgdGFza01ldGFkYXRhPzogVGFza01ldGFkYXRhLFxuICBjYXBhYmlsaXR5T3ZlcnJpZGVzPzogUmVjb3JkPHN0cmluZywgUGFydGlhbDxNb2RlbENhcGFiaWxpdGllcz4+LFxuKTogUm91dGluZ0RlY2lzaW9uIHtcbiAgLy8gSWYgbm8gcGhhc2UgY29uZmlnIG9yIHJvdXRpbmcgZGlzYWJsZWQsIHBhc3MgdGhyb3VnaFxuICBpZiAoIXBoYXNlQ29uZmlnIHx8ICFyb3V0aW5nQ29uZmlnLmVuYWJsZWQpIHtcbiAgICByZXR1cm4ge1xuICAgICAgbW9kZWxJZDogcGhhc2VDb25maWc/LnByaW1hcnkgPz8gXCJcIixcbiAgICAgIGZhbGxiYWNrczogcGhhc2VDb25maWc/LmZhbGxiYWNrcyA/PyBbXSxcbiAgICAgIHRpZXI6IGNsYXNzaWZpY2F0aW9uLnRpZXIsXG4gICAgICB3YXNEb3duZ3JhZGVkOiBmYWxzZSxcbiAgICAgIHJlYXNvbjogXCJkeW5hbWljIHJvdXRpbmcgZGlzYWJsZWQgb3Igbm8gcGhhc2UgY29uZmlnXCIsXG4gICAgICBzZWxlY3Rpb25NZXRob2Q6IFwidGllci1vbmx5XCIsXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IGNvbmZpZ3VyZWRQcmltYXJ5ID0gcGhhc2VDb25maWcucHJpbWFyeTtcbiAgY29uc3QgY29uZmlndXJlZFRpZXIgPSBnZXRNb2RlbFRpZXIoY29uZmlndXJlZFByaW1hcnkpO1xuICBjb25zdCByZXF1ZXN0ZWRUaWVyID0gY2xhc3NpZmljYXRpb24udGllcjtcblxuICAvLyBJZiB0aGUgY29uZmlndXJlZCBtb2RlbCBpcyB1bmtub3duIChub3QgaW4gTU9ERUxfQ0FQQUJJTElUWV9USUVSKSxcbiAgLy8gaG9ub3IgdGhlIHVzZXIncyBleHBsaWNpdCBjaG9pY2UgXHUyMDE0IGRvbid0IGRvd25ncmFkZSBiYXNlZCBvbiBhIGd1ZXNzLlxuICAvLyBVbmtub3duIG1vZGVscyBkZWZhdWx0IHRvIFwiaGVhdnlcIiBpbiBnZXRNb2RlbFRpZXIsIHdoaWNoIG1ha2VzIGV2ZXJ5XG4gIC8vIHN0YW5kYXJkL2xpZ2h0IHVuaXQgZ2V0IGRvd25ncmFkZWQgdG8gdGllcl9tb2RlbHMsIHNpbGVudGx5IGlnbm9yaW5nXG4gIC8vIHRoZSB1c2VyJ3MgY29uZmlndXJhdGlvbi4gKCMyMTkyKVxuICBpZiAoIWlzS25vd25Nb2RlbChjb25maWd1cmVkUHJpbWFyeSkpIHtcbiAgICByZXR1cm4ge1xuICAgICAgbW9kZWxJZDogY29uZmlndXJlZFByaW1hcnksXG4gICAgICBmYWxsYmFja3M6IHBoYXNlQ29uZmlnLmZhbGxiYWNrcyxcbiAgICAgIHRpZXI6IHJlcXVlc3RlZFRpZXIsXG4gICAgICB3YXNEb3duZ3JhZGVkOiBmYWxzZSxcbiAgICAgIHJlYXNvbjogYGNvbmZpZ3VyZWQgbW9kZWwgXCIke2NvbmZpZ3VyZWRQcmltYXJ5fVwiIGlzIG5vdCBpbiB0aGUga25vd24gdGllciBtYXAgXHUyMDE0IGhvbm9yaW5nIGV4cGxpY2l0IGNvbmZpZ2AsXG4gICAgICBzZWxlY3Rpb25NZXRob2Q6IFwidGllci1vbmx5XCIsXG4gICAgfTtcbiAgfVxuXG4gIC8vIERvd25ncmFkZS1vbmx5OiBpZiByZXF1ZXN0ZWQgdGllciA+PSBjb25maWd1cmVkIHRpZXIsIG5vIGNoYW5nZVxuICBpZiAodGllck9yZGluYWwocmVxdWVzdGVkVGllcikgPj0gdGllck9yZGluYWwoY29uZmlndXJlZFRpZXIpKSB7XG4gICAgLy8gSWYgdGhlIGNvbmZpZ3VyZWQgcHJpbWFyeSBpcyBkaXJlY3RseSBhdmFpbGFibGUsIHVzZSBpdFxuICAgIGlmIChpc01vZGVsQXZhaWxhYmxlKGNvbmZpZ3VyZWRQcmltYXJ5LCBhdmFpbGFibGVNb2RlbElkcykpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG1vZGVsSWQ6IGNvbmZpZ3VyZWRQcmltYXJ5LFxuICAgICAgICBmYWxsYmFja3M6IHBoYXNlQ29uZmlnLmZhbGxiYWNrcyxcbiAgICAgICAgdGllcjogcmVxdWVzdGVkVGllcixcbiAgICAgICAgd2FzRG93bmdyYWRlZDogZmFsc2UsXG4gICAgICAgIHJlYXNvbjogYHRpZXIgJHtyZXF1ZXN0ZWRUaWVyfSA+PSBjb25maWd1cmVkICR7Y29uZmlndXJlZFRpZXJ9YCxcbiAgICAgICAgc2VsZWN0aW9uTWV0aG9kOiBcInRpZXItb25seVwiLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyBDb25maWd1cmVkIHByaW1hcnkgaXMgdW5hdmFpbGFibGUgKGUuZy4gQW50aHJvcGljIG1vZGVsIGNvbmZpZ3VyZWQgYnV0XG4gICAgLy8gcnVubmluZyBvbiBhIG5vbi1BbnRocm9waWMgcHJvdmlkZXIpLiBGaW5kIHRoZSBiZXN0IGF2YWlsYWJsZSBtb2RlbCBhdFxuICAgIC8vIHRoZSBzYW1lIGNhcGFiaWxpdHkgdGllciBzbyByb3V0aW5nIHN0aWxsIHdvcmtzIGNyb3NzLXByb3ZpZGVyLlxuICAgIGNvbnN0IGNyb3NzUHJvdmlkZXJFcXVpdmFsZW50ID0gZmluZE1vZGVsRm9yVGllcihcbiAgICAgIGNvbmZpZ3VyZWRUaWVyLFxuICAgICAgcm91dGluZ0NvbmZpZyxcbiAgICAgIGF2YWlsYWJsZU1vZGVsSWRzLFxuICAgICAgcm91dGluZ0NvbmZpZy5jcm9zc19wcm92aWRlciAhPT0gZmFsc2UsXG4gICAgKTtcblxuICAgIHJldHVybiB7XG4gICAgICBtb2RlbElkOiBjcm9zc1Byb3ZpZGVyRXF1aXZhbGVudCA/PyBjb25maWd1cmVkUHJpbWFyeSxcbiAgICAgIGZhbGxiYWNrczogY3Jvc3NQcm92aWRlckVxdWl2YWxlbnRcbiAgICAgICAgPyBbLi4ucGhhc2VDb25maWcuZmFsbGJhY2tzLmZpbHRlcihmID0+IGYgIT09IGNyb3NzUHJvdmlkZXJFcXVpdmFsZW50KSwgY29uZmlndXJlZFByaW1hcnldXG4gICAgICAgIDogcGhhc2VDb25maWcuZmFsbGJhY2tzLFxuICAgICAgdGllcjogcmVxdWVzdGVkVGllcixcbiAgICAgIHdhc0Rvd25ncmFkZWQ6IGZhbHNlLFxuICAgICAgcmVhc29uOiBjcm9zc1Byb3ZpZGVyRXF1aXZhbGVudFxuICAgICAgICA/IGBjcm9zcy1wcm92aWRlciAke2NvbmZpZ3VyZWRUaWVyfS10aWVyIGVxdWl2YWxlbnRgXG4gICAgICAgIDogYHRpZXIgJHtyZXF1ZXN0ZWRUaWVyfSA+PSBjb25maWd1cmVkICR7Y29uZmlndXJlZFRpZXJ9YCxcbiAgICAgIHNlbGVjdGlvbk1ldGhvZDogXCJ0aWVyLW9ubHlcIixcbiAgICB9O1xuICB9XG5cbiAgLy8gU1RFUCAxOiBHZXQgYWxsIGVsaWdpYmxlIG1vZGVscyBmb3IgdGhlIHJlcXVlc3RlZCB0aWVyXG4gIGNvbnN0IGVsaWdpYmxlID0gZ2V0RWxpZ2libGVNb2RlbHMocmVxdWVzdGVkVGllciwgYXZhaWxhYmxlTW9kZWxJZHMsIHJvdXRpbmdDb25maWcpO1xuXG4gIGlmIChlbGlnaWJsZS5sZW5ndGggPT09IDApIHtcbiAgICAvLyBObyBzdWl0YWJsZSBtb2RlbCBmb3VuZCBcdTIwMTQgdXNlIGNvbmZpZ3VyZWQgcHJpbWFyeVxuICAgIHJldHVybiB7XG4gICAgICBtb2RlbElkOiBjb25maWd1cmVkUHJpbWFyeSxcbiAgICAgIGZhbGxiYWNrczogcGhhc2VDb25maWcuZmFsbGJhY2tzLFxuICAgICAgdGllcjogcmVxdWVzdGVkVGllcixcbiAgICAgIHdhc0Rvd25ncmFkZWQ6IGZhbHNlLFxuICAgICAgcmVhc29uOiBgbm8gJHtyZXF1ZXN0ZWRUaWVyfS10aWVyIG1vZGVsIGF2YWlsYWJsZWAsXG4gICAgICBzZWxlY3Rpb25NZXRob2Q6IFwidGllci1vbmx5XCIsXG4gICAgfTtcbiAgfVxuXG4gIC8vIFNURVAgMjogQ2FwYWJpbGl0eSBzY29yaW5nICh3aGVuIGVuYWJsZWQgYW5kIG11bHRpcGxlIGVsaWdpYmxlIG1vZGVscyBleGlzdClcbiAgaWYgKHJvdXRpbmdDb25maWcuY2FwYWJpbGl0eV9yb3V0aW5nICE9PSBmYWxzZSAmJiBlbGlnaWJsZS5sZW5ndGggPiAxICYmIHVuaXRUeXBlKSB7XG4gICAgY29uc3QgcmVxdWlyZW1lbnRzID0gY29tcHV0ZVRhc2tSZXF1aXJlbWVudHModW5pdFR5cGUsIHRhc2tNZXRhZGF0YSk7XG4gICAgY29uc3Qgc2NvcmVkID0gc2NvcmVFbGlnaWJsZU1vZGVscyhlbGlnaWJsZSwgcmVxdWlyZW1lbnRzLCBjYXBhYmlsaXR5T3ZlcnJpZGVzKTtcbiAgICBjb25zdCB3aW5uZXIgPSBzY29yZWRbMF07XG4gICAgaWYgKHdpbm5lcikge1xuICAgICAgY29uc3QgY2FwU2NvcmVzOiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+ID0ge307XG4gICAgICBmb3IgKGNvbnN0IHMgb2Ygc2NvcmVkKSBjYXBTY29yZXNbcy5tb2RlbElkXSA9IHMuc2NvcmU7XG4gICAgICBjb25zdCBmYWxsYmFja3MgPSBidWlsZEZhbGxiYWNrQ2hhaW4od2lubmVyLm1vZGVsSWQsIHBoYXNlQ29uZmlnKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG1vZGVsSWQ6IHdpbm5lci5tb2RlbElkLFxuICAgICAgICBmYWxsYmFja3MsXG4gICAgICAgIHRpZXI6IHJlcXVlc3RlZFRpZXIsXG4gICAgICAgIHdhc0Rvd25ncmFkZWQ6IHRydWUsXG4gICAgICAgIHJlYXNvbjogYGNhcGFiaWxpdHktc2NvcmVkOiAke3dpbm5lci5tb2RlbElkfSAoJHt3aW5uZXIuc2NvcmUudG9GaXhlZCgxKX0pIGZvciAke3VuaXRUeXBlfWAsXG4gICAgICAgIGNhcGFiaWxpdHlTY29yZXM6IGNhcFNjb3JlcyxcbiAgICAgICAgdGFza1JlcXVpcmVtZW50czogcmVxdWlyZW1lbnRzLFxuICAgICAgICBzZWxlY3Rpb25NZXRob2Q6IFwiY2FwYWJpbGl0eS1zY29yZWRcIixcbiAgICAgIH07XG4gICAgfVxuICB9XG5cbiAgLy8gU1RFUCAzOiBGYWxsYmFjayBcdTIwMTQgdXNlIGZpcnN0IGVsaWdpYmxlIG1vZGVsIChjaGVhcGVzdCBpbiB0aWVyLCBvciBzaW5nbGUgZWxpZ2libGUpXG4gIGNvbnN0IHRhcmdldE1vZGVsSWQgPSBlbGlnaWJsZVswXTtcblxuICAvLyBCdWlsZCBmYWxsYmFjayBjaGFpbjogW2Rvd25ncmFkZWRfbW9kZWwsIC4uLmNvbmZpZ3VyZWRfZmFsbGJhY2tzLCBjb25maWd1cmVkX3ByaW1hcnldXG4gIGNvbnN0IGZhbGxiYWNrcyA9IGJ1aWxkRmFsbGJhY2tDaGFpbih0YXJnZXRNb2RlbElkLCBwaGFzZUNvbmZpZyk7XG5cbiAgcmV0dXJuIHtcbiAgICBtb2RlbElkOiB0YXJnZXRNb2RlbElkLFxuICAgIGZhbGxiYWNrcyxcbiAgICB0aWVyOiByZXF1ZXN0ZWRUaWVyLFxuICAgIHdhc0Rvd25ncmFkZWQ6IHRydWUsXG4gICAgcmVhc29uOiBjbGFzc2lmaWNhdGlvbi5yZWFzb24sXG4gICAgc2VsZWN0aW9uTWV0aG9kOiBcInRpZXItb25seVwiLFxuICB9O1xufVxuXG4vKipcbiAqIEVzY2FsYXRlIHRvIHRoZSBuZXh0IHRpZXIgYWZ0ZXIgYSBmYWlsdXJlLlxuICogUmV0dXJucyB0aGUgbmV3IHRpZXIsIG9yIG51bGwgaWYgYWxyZWFkeSBhdCBoZWF2eSAobWF4KS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVzY2FsYXRlVGllcihjdXJyZW50VGllcjogQ29tcGxleGl0eVRpZXIpOiBDb21wbGV4aXR5VGllciB8IG51bGwge1xuICBzd2l0Y2ggKGN1cnJlbnRUaWVyKSB7XG4gICAgY2FzZSBcImxpZ2h0XCI6IHJldHVybiBcInN0YW5kYXJkXCI7XG4gICAgY2FzZSBcInN0YW5kYXJkXCI6IHJldHVybiBcImhlYXZ5XCI7XG4gICAgY2FzZSBcImhlYXZ5XCI6IHJldHVybiBudWxsO1xuICB9XG59XG5cbi8qKlxuICogR2V0IHRoZSBkZWZhdWx0IHJvdXRpbmcgY29uZmlnIChhbGwgZmVhdHVyZXMgZW5hYmxlZCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZWZhdWx0Um91dGluZ0NvbmZpZygpOiBEeW5hbWljUm91dGluZ0NvbmZpZyB7XG4gIHJldHVybiB7XG4gICAgZW5hYmxlZDogdHJ1ZSxcbiAgICBjYXBhYmlsaXR5X3JvdXRpbmc6IHRydWUsXG4gICAgZXNjYWxhdGVfb25fZmFpbHVyZTogdHJ1ZSxcbiAgICBidWRnZXRfcHJlc3N1cmU6IHRydWUsXG4gICAgY3Jvc3NfcHJvdmlkZXI6IHRydWUsXG4gICAgaG9va3M6IHRydWUsXG4gIH07XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUaWVyLUJhc2VkIE1vZGVsIFJlc29sdXRpb24gKGZvciBwcm9maWxlIGRlZmF1bHRzKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBGYWxsYmFjay1vbmx5IGNhbm9uaWNhbCBtb2RlbCBJRHMgcGVyIHRpZXIuIFJldHVybmVkIHdoZW4gdGhlXG4gKiBhdmFpbGFibGUtbW9kZWwgbGlzdCBpcyBlbXB0eSAoZS5nLiwgcHJlZmVyZW5jZXMgYXJlIGxvYWRlZCBiZWZvcmUgdGhlXG4gKiBtb2RlbCByZWdpc3RyeSBpcyBwb3B1bGF0ZWQgYXQgYm9vdHN0cmFwKSwgb3Igd2hlbiBhIG5vbi1lbXB0eSByZWdpc3RyeSBoYXNcbiAqIG5vIG1vZGVsIGF0IHRoZSByZXF1ZXN0ZWQgdGllci5cbiAqXG4gKiBQcmVjZWRlbmNlIChyZXNvbHZlTW9kZWxGb3JUaWVyKTpcbiAqICAgMS4gY29uZmlndXJlZCBgdGllcl9tb2RlbHNbdGllcl1gICh2aWEgZ2V0RWxpZ2libGVNb2RlbHMpIFx1MjAxNCBleGFjdC9iYXJlIG1hdGNoXG4gKiAgIDIuIGNoZWFwZXN0IGF2YWlsYWJsZSBtb2RlbCB3aG9zZSB0aWVyIG1hdGNoZXMgYHRpZXJgXG4gKiAgIDMuIENBTk9OSUNBTF9USUVSX01PREVMU1t0aWVyXSBhcyBsYXN0LXJlc29ydCBmYWxsYmFja1xuICovXG5jb25zdCBDQU5PTklDQUxfVElFUl9NT0RFTFM6IFJlY29yZDxDb21wbGV4aXR5VGllciwgc3RyaW5nPiA9IHtcbiAgbGlnaHQ6IFwiY2xhdWRlLWhhaWt1LTQtNVwiLFxuICBzdGFuZGFyZDogXCJjbGF1ZGUtc29ubmV0LTQtNlwiLFxuICBoZWF2eTogXCJjbGF1ZGUtb3B1cy00LTZcIixcbn07XG5cbmV4cG9ydCBmdW5jdGlvbiBjYW5vbmljYWxNb2RlbEZvclRpZXIodGllcjogQ29tcGxleGl0eVRpZXIpOiBzdHJpbmcge1xuICByZXR1cm4gQ0FOT05JQ0FMX1RJRVJfTU9ERUxTW3RpZXJdO1xufVxuXG4vKipcbiAqIFNpbmdsZSBzb3VyY2Ugb2YgdHJ1dGggZm9yIHRpZXItYmFzZWQgbW9kZWwgc2VsZWN0aW9uLlxuICogUmV0dXJucyB0aGUgY2hlYXBlc3QgYXZhaWxhYmxlIG1vZGVsIHdob3NlIGNhcGFiaWxpdHkgdGllciBtYXRjaGVzIGB0aWVyYCxcbiAqIGhvbm9yaW5nIGByb3V0aW5nQ29uZmlnLnRpZXJfbW9kZWxzW3RpZXJdYCB3aGVuIHNldC4gUmV0dXJucyB1bmRlZmluZWQgd2hlblxuICogbm8gYXZhaWxhYmxlIG1vZGVsIG1hdGNoZXMgdGhlIHRpZXIuXG4gKlxuICogYGNyb3NzUHJvdmlkZXJgOiB3aGVuIGZhbHNlLCByZXN0cmljdHMgdGhlIHNlYXJjaCB0byBtb2RlbHMgdGhhdCBzaGFyZSB0aGVcbiAqIGNhbm9uaWNhbCAoQW50aHJvcGljKSBwcm92aWRlciBmb3IgdGhlIHRpZXIuIFdoZW4gdHJ1ZSwgYW55IHByb3ZpZGVyIGlzXG4gKiBlbGlnaWJsZS5cbiAqL1xuZnVuY3Rpb24gZmluZE1vZGVsRm9yVGllcihcbiAgdGllcjogQ29tcGxleGl0eVRpZXIsXG4gIHJvdXRpbmdDb25maWc6IER5bmFtaWNSb3V0aW5nQ29uZmlnLFxuICBhdmFpbGFibGVNb2RlbElkczogc3RyaW5nW10sXG4gIGNyb3NzUHJvdmlkZXI6IGJvb2xlYW4sXG4pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBjb25zdCBlbGlnaWJsZSA9IGdldEVsaWdpYmxlTW9kZWxzKHRpZXIsIGF2YWlsYWJsZU1vZGVsSWRzLCByb3V0aW5nQ29uZmlnKTtcbiAgaWYgKGVsaWdpYmxlLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHVuZGVmaW5lZDtcblxuICBpZiAoY3Jvc3NQcm92aWRlcikge1xuICAgIHJldHVybiBlbGlnaWJsZVswXTtcbiAgfVxuXG4gIC8vIFNhbWUtcHJvdmlkZXIgb25seToga2VlcCBtb2RlbHMgd2hvc2UgYmFyZSBJRCBtYXRjaGVzIGEgY2Fub25pY2FsXG4gIC8vIEFudGhyb3BpYyBJRCBhdCB0aGlzIHRpZXIgKGkuZS4sIGEgY2xhdWRlLSogbW9kZWwgaW4gdGhlIHRpZXIgbWFwKS5cbiAgY29uc3Qgc2FtZVByb3ZpZGVyID0gZWxpZ2libGUuZmlsdGVyKGlkID0+IHtcbiAgICBjb25zdCBiYXJlID0gYmFyZU1vZGVsSWQoaWQpO1xuICAgIHJldHVybiBNT0RFTF9DQVBBQklMSVRZX1RJRVJbYmFyZV0gPT09IHRpZXIgJiYgYmFyZS5zdGFydHNXaXRoKFwiY2xhdWRlLVwiKTtcbiAgfSk7XG4gIHJldHVybiBzYW1lUHJvdmlkZXJbMF07XG59XG5cbi8qKlxuICogUmVzb2x2ZSBhIGNvbmNyZXRlIG1vZGVsIElEIGZvciBhIGdpdmVuIGNhcGFiaWxpdHkgdGllciB1c2luZyB0aGVcbiAqIGF2YWlsYWJsZSBtb2RlbCBsaXN0LiBQcm92aWRlci1hZ25vc3RpYzogcGlja3MgdGhlIGJlc3QgYXZhaWxhYmxlXG4gKiBtb2RlbCBhdCB0aGUgcmVxdWVzdGVkIHRpZXIuXG4gKlxuICogUHJlY2VkZW5jZTpcbiAqICAgMS4gY29uZmlndXJlZCBgdGllcl9tb2RlbHNbdGllcl1gLCBpZiBwcm92aWRlZCBhbmQgYXZhaWxhYmxlXG4gKiAgIDIuIHRpZXItbWF0Y2hpbmcgbW9kZWwgZnJvbSBhbnkgcHJvdmlkZXIgaW4gYGF2YWlsYWJsZU1vZGVsSWRzYFxuICogICAzLiBjYW5vbmljYWwgQW50aHJvcGljIElEIGFzIGEgZmFsbGJhY2sgb25seSB3aGVuIG5vdGhpbmcgZWxzZSBtYXRjaGVzXG4gKiAgICAgIChvciBgYXZhaWxhYmxlTW9kZWxJZHNgIGlzIGVtcHR5LCBlLmcuLCBkdXJpbmcgZWFybHkgYm9vdHN0cmFwKVxuICpcbiAqIEBwYXJhbSB0aWVyICAgICAgICAgICAgICBUaGUgY2FwYWJpbGl0eSB0aWVyIHRvIHJlc29sdmVcbiAqIEBwYXJhbSBhdmFpbGFibGVNb2RlbElkcyBMaXN0IG9mIGF2YWlsYWJsZSBtb2RlbCBJRHMgKFJFUVVJUkVEIGZvclxuICogICAgICAgICAgICAgICAgICAgICAgICAgIHByb3ZpZGVyLWFnbm9zdGljIHJlc29sdXRpb247IHBhc3MgW10gb25seSB3aGVuXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgdGhlIG1vZGVsIHJlZ2lzdHJ5IGlzIGdlbnVpbmVseSB1bmF2YWlsYWJsZSlcbiAqIEBwYXJhbSByb3V0aW5nQ29uZmlnICAgICBPcHRpb25hbCByb3V0aW5nIGNvbmZpZywgb3IgbGVnYWN5IGNyb3NzUHJvdmlkZXIgYm9vbGVhblxuICogQHBhcmFtIGNyb3NzUHJvdmlkZXIgICAgIFdoZXRoZXIgdG8gY29uc2lkZXIgbW9kZWxzIGZyb20gb3RoZXIgcHJvdmlkZXJzXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlTW9kZWxGb3JUaWVyKFxuICB0aWVyOiBDb21wbGV4aXR5VGllcixcbiAgYXZhaWxhYmxlTW9kZWxJZHM6IHN0cmluZ1tdLFxuICBjcm9zc1Byb3ZpZGVyPzogYm9vbGVhbixcbik6IHN0cmluZztcbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlTW9kZWxGb3JUaWVyKFxuICB0aWVyOiBDb21wbGV4aXR5VGllcixcbiAgYXZhaWxhYmxlTW9kZWxJZHM6IHN0cmluZ1tdLFxuICByb3V0aW5nQ29uZmlnPzogRHluYW1pY1JvdXRpbmdDb25maWcsXG4gIGNyb3NzUHJvdmlkZXI/OiBib29sZWFuLFxuKTogc3RyaW5nO1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVNb2RlbEZvclRpZXIoXG4gIHRpZXI6IENvbXBsZXhpdHlUaWVyLFxuICBhdmFpbGFibGVNb2RlbElkczogc3RyaW5nW10sXG4gIHJvdXRpbmdDb25maWdPckNyb3NzUHJvdmlkZXI6IER5bmFtaWNSb3V0aW5nQ29uZmlnIHwgYm9vbGVhbiA9IGRlZmF1bHRSb3V0aW5nQ29uZmlnKCksXG4gIGNyb3NzUHJvdmlkZXI/OiBib29sZWFuLFxuKTogc3RyaW5nIHtcbiAgY29uc3Qgcm91dGluZ0NvbmZpZyA9IHR5cGVvZiByb3V0aW5nQ29uZmlnT3JDcm9zc1Byb3ZpZGVyID09PSBcImJvb2xlYW5cIlxuICAgID8gZGVmYXVsdFJvdXRpbmdDb25maWcoKVxuICAgIDogeyAuLi5kZWZhdWx0Um91dGluZ0NvbmZpZygpLCAuLi5yb3V0aW5nQ29uZmlnT3JDcm9zc1Byb3ZpZGVyIH07XG4gIGNvbnN0IGFsbG93Q3Jvc3NQcm92aWRlciA9IHR5cGVvZiByb3V0aW5nQ29uZmlnT3JDcm9zc1Byb3ZpZGVyID09PSBcImJvb2xlYW5cIlxuICAgID8gcm91dGluZ0NvbmZpZ09yQ3Jvc3NQcm92aWRlclxuICAgIDogY3Jvc3NQcm92aWRlciA/PyByb3V0aW5nQ29uZmlnLmNyb3NzX3Byb3ZpZGVyICE9PSBmYWxzZTtcblxuICAvLyBObyBhdmFpbGFibGUgbW9kZWxzIGtub3duIFx1MjAxNCByZXR1cm4gY2Fub25pY2FsIGZhbGxiYWNrXG4gIGlmIChhdmFpbGFibGVNb2RlbElkcy5sZW5ndGggPT09IDApIHtcbiAgICBpbmNyZW1lbnRMZWdhY3lUZWxlbWV0cnkoXCJsZWdhY3kucHJvdmlkZXJEZWZhdWx0VXNlZFwiKTtcbiAgICByZXR1cm4gY2Fub25pY2FsTW9kZWxGb3JUaWVyKHRpZXIpO1xuICB9XG5cbiAgLy8gQ3Jvc3MtcHJvdmlkZXIgdGllciBzZWFyY2hcbiAgY29uc3QgcmVzb2x2ZWQgPSBmaW5kTW9kZWxGb3JUaWVyKHRpZXIsIHJvdXRpbmdDb25maWcsIGF2YWlsYWJsZU1vZGVsSWRzLCBhbGxvd0Nyb3NzUHJvdmlkZXIpO1xuICBpZiAocmVzb2x2ZWQpIHtcbiAgICByZXR1cm4gbm9ybWFsaXplUmVzb2x2ZWRUaWVyTW9kZWxJZChyZXNvbHZlZCwgdGllciwgcm91dGluZ0NvbmZpZyk7XG4gIH1cblxuICBpbmNyZW1lbnRMZWdhY3lUZWxlbWV0cnkoXCJsZWdhY3kucHJvdmlkZXJEZWZhdWx0VXNlZFwiKTtcbiAgcmV0dXJuIGNhbm9uaWNhbE1vZGVsRm9yVGllcih0aWVyKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEludGVybmFsIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIENoZWNrIHdoZXRoZXIgYSBtb2RlbCBJRCBpcyBwcmVzZW50IGluIHRoZSBhdmFpbGFibGUgbW9kZWxzIGxpc3QuXG4gKiBIYW5kbGVzIGJhcmUgSURzIChcImNsYXVkZS1vcHVzLTQtNlwiKSBhbmQgcHJvdmlkZXItcHJlZml4ZWQgSURzIChcImFudGhyb3BpYy9jbGF1ZGUtb3B1cy00LTZcIikuXG4gKi9cbmZ1bmN0aW9uIGlzTW9kZWxBdmFpbGFibGUobW9kZWxJZDogc3RyaW5nLCBhdmFpbGFibGVNb2RlbElkczogc3RyaW5nW10pOiBib29sZWFuIHtcbiAgaWYgKGF2YWlsYWJsZU1vZGVsSWRzLmluY2x1ZGVzKG1vZGVsSWQpKSByZXR1cm4gdHJ1ZTtcbiAgLy8gU3RyaXAgcHJvdmlkZXIgcHJlZml4IGZvciBjb21wYXJpc29uLiBUcmVhdCB0cmFpbGluZy1zbGFzaCBJRHMgKFwicHJvdmlkZXIvXCIpXG4gIC8vIGFzIG5vLWJhcmUtSUQgcmF0aGVyIHRoYW4gZW1wdHktc3RyaW5nIG1hdGNoICh3aGljaCB3b3VsZCBlcnJvbmVvdXNseSBtYXRjaFxuICAvLyBhbnkgb3RoZXIgXCJwcm92aWRlci9cIiBJRCkuXG4gIGNvbnN0IGJhcmUgPSBiYXJlTW9kZWxJZChtb2RlbElkKTtcbiAgaWYgKCFiYXJlKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiBhdmFpbGFibGVNb2RlbElkcy5zb21lKGlkID0+IGJhcmVNb2RlbElkKGlkKSA9PT0gYmFyZSk7XG59XG5cbmZ1bmN0aW9uIGdldE1vZGVsVGllcihtb2RlbElkOiBzdHJpbmcpOiBDb21wbGV4aXR5VGllciB7XG4gIC8vIFN0cmlwIHByb3ZpZGVyIHByZWZpeCBpZiBwcmVzZW50XG4gIGNvbnN0IGJhcmVJZCA9IGJhcmVNb2RlbElkKG1vZGVsSWQpO1xuXG4gIC8vIENoZWNrIGV4YWN0IG1hdGNoIGZpcnN0XG4gIGlmIChNT0RFTF9DQVBBQklMSVRZX1RJRVJbYmFyZUlkXSkgcmV0dXJuIE1PREVMX0NBUEFCSUxJVFlfVElFUltiYXJlSWRdO1xuXG4gIC8vIENoZWNrIGlmIGFueSBrbm93biBtb2RlbCBJRCBpcyBhIHByZWZpeC9zdWZmaXggbWF0Y2hcbiAgZm9yIChjb25zdCBba25vd25JZCwgdGllcl0gb2YgT2JqZWN0LmVudHJpZXMoTU9ERUxfQ0FQQUJJTElUWV9USUVSKSkge1xuICAgIGlmIChiYXJlSWQuaW5jbHVkZXMoa25vd25JZCkgfHwga25vd25JZC5pbmNsdWRlcyhiYXJlSWQpKSByZXR1cm4gdGllcjtcbiAgfVxuXG4gIC8vIFVua25vd24gbW9kZWxzIGFyZSBhc3N1bWVkIHN0YW5kYXJkIChwZXIgRC0xNTogYXZvaWRzIHNpbGVudGx5IGlnbm9yaW5nIHVzZXIgY29uZmlnKVxuICByZXR1cm4gXCJzdGFuZGFyZFwiO1xufVxuXG4vKiogQ2hlY2sgaWYgYSBtb2RlbCBJRCBoYXMgYSBrbm93biBjYXBhYmlsaXR5IHRpZXIgbWFwcGluZy4gKCMyMTkyKSAqL1xuZnVuY3Rpb24gaXNLbm93bk1vZGVsKG1vZGVsSWQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBiYXJlSWQgPSBiYXJlTW9kZWxJZChtb2RlbElkKTtcbiAgaWYgKE1PREVMX0NBUEFCSUxJVFlfVElFUltiYXJlSWRdKSByZXR1cm4gdHJ1ZTtcbiAgZm9yIChjb25zdCBrbm93bklkIG9mIE9iamVjdC5rZXlzKE1PREVMX0NBUEFCSUxJVFlfVElFUikpIHtcbiAgICBpZiAoYmFyZUlkLmluY2x1ZGVzKGtub3duSWQpIHx8IGtub3duSWQuaW5jbHVkZXMoYmFyZUlkKSkgcmV0dXJuIHRydWU7XG4gIH1cbiAgcmV0dXJuIGZhbHNlO1xufVxuXG5mdW5jdGlvbiBnZXRNb2RlbENvc3QobW9kZWxJZDogc3RyaW5nKTogbnVtYmVyIHtcbiAgY29uc3QgYmFyZUlkID0gYmFyZU1vZGVsSWQobW9kZWxJZCk7XG5cbiAgaWYgKE1PREVMX0NPU1RfUEVSXzFLX0lOUFVUW2JhcmVJZF0gIT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiBNT0RFTF9DT1NUX1BFUl8xS19JTlBVVFtiYXJlSWRdO1xuICB9XG5cbiAgLy8gQ2hlY2sgcGFydGlhbCBtYXRjaGVzXG4gIGZvciAoY29uc3QgW2tub3duSWQsIGNvc3RdIG9mIE9iamVjdC5lbnRyaWVzKE1PREVMX0NPU1RfUEVSXzFLX0lOUFVUKSkge1xuICAgIGlmIChiYXJlSWQuaW5jbHVkZXMoa25vd25JZCkgfHwga25vd25JZC5pbmNsdWRlcyhiYXJlSWQpKSByZXR1cm4gY29zdDtcbiAgfVxuXG4gIC8vIFVua25vd24gY29zdCBcdTIwMTQgYXNzdW1lIGV4cGVuc2l2ZSB0byBhdm9pZCByb3V0aW5nIHRvIHVua25vd24gY2hlYXAgbW9kZWxzXG4gIHJldHVybiA5OTk7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVJlc29sdmVkVGllck1vZGVsSWQoXG4gIG1vZGVsSWQ6IHN0cmluZyxcbiAgdGllcjogQ29tcGxleGl0eVRpZXIsXG4gIHJvdXRpbmdDb25maWc6IER5bmFtaWNSb3V0aW5nQ29uZmlnLFxuKTogc3RyaW5nIHtcbiAgY29uc3QgZXhwbGljaXRNb2RlbCA9IHJvdXRpbmdDb25maWcudGllcl9tb2RlbHM/Llt0aWVyXTtcbiAgaWYgKGV4cGxpY2l0TW9kZWw/LmluY2x1ZGVzKFwiL1wiKSkge1xuICAgIHJldHVybiBtb2RlbElkO1xuICB9XG5cbiAgY29uc3QgYmFyZUlkID0gYmFyZU1vZGVsSWQobW9kZWxJZCk7XG4gIHJldHVybiBNT0RFTF9DQVBBQklMSVRZX1RJRVJbYmFyZUlkXSA/IGJhcmVJZCA6IG1vZGVsSWQ7XG59XG5cbmZ1bmN0aW9uIGJhcmVNb2RlbElkKG1vZGVsSWQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmICghbW9kZWxJZC5pbmNsdWRlcyhcIi9cIikpIHJldHVybiBtb2RlbElkO1xuICAvLyAucG9wKCkgbmV2ZXIgcmV0dXJucyB1bmRlZmluZWQgb24gYSBub24tZW1wdHkgc3RyaW5nIGJ1dCA/PyBndWFyZHMgZnV0dXJlXG4gIC8vIHJlZmFjdG9ycyBhbmQgYXZvaWRzIHRoZSBtaXNsZWFkaW5nIG5vbi1udWxsIGFzc2VydGlvbi5cbiAgcmV0dXJuIG1vZGVsSWQuc3BsaXQoXCIvXCIpLnBvcCgpID8/IG1vZGVsSWQ7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBQcm92aWRlci1zcGVjaWZpYyBUb29sIExpbWl0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBHcm9xIGVuZm9yY2VzIGEgaGFyZCBsaW1pdCBvZiAxMjggdG9vbHMgcGVyIHJlcXVlc3QuXG4gKiBSZXF1ZXN0cyBleGNlZWRpbmcgdGhpcyBsaW1pdCByZWNlaXZlIGEgNDAwIGVycm9yOlxuICogXCJtYXhpbXVtIG51bWJlciBvZiBpdGVtcyBpcyAxMjhcIlxuICogQHNlZSBodHRwczovL2NvbnNvbGUuZ3JvcS5jb20vZG9jcy90b29sLXVzZVxuICovXG5leHBvcnQgY29uc3QgR1JPUV9NQVhfVE9PTFMgPSAxMjg7XG5cbi8qKlxuICogUHJvdmlkZXIgSURzIHRoYXQgbWFwIHRvIHRoZSBHcm9xIEFQSSBiYWNrZW5kLlxuICogVXNlZCB0byBkZXRlY3QgR3JvcSBhdCB0aGUgR1NEIHJvdXRpbmcgbGF5ZXIgd2hlcmUgb25seSB0aGUgcHJvdmlkZXIgc3RyaW5nXG4gKiBpcyBhdmFpbGFibGUgKHRoZSBwaS1haSBvcGVuYWktY29tcGxldGlvbnMgYWRhcHRlciBpcyBzaGFyZWQgYWNyb3NzIHByb3ZpZGVycykuXG4gKi9cbmNvbnN0IEdST1FfUFJPVklERVJfSURTID0gbmV3IFNldChbXCJncm9xXCJdKTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRvb2wgQ29tcGF0aWJpbGl0eSBGaWx0ZXIgKEFEUi0wMDUgUGhhc2UgMykgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogQ2hlY2sgaWYgYSB0b29sIGlzIGNvbXBhdGlibGUgd2l0aCBhIHByb3ZpZGVyJ3MgY2FwYWJpbGl0aWVzLlxuICogUmV0dXJucyB0cnVlIGlmIHRoZSB0b29sIGNhbiBiZSB1c2VkIHdpdGggdGhlIHByb3ZpZGVyLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNUb29sQ29tcGF0aWJsZVdpdGhQcm92aWRlcihcbiAgdG9vbE5hbWU6IHN0cmluZyxcbiAgcHJvdmlkZXJDYXBzOiBQcm92aWRlckNhcGFiaWxpdGllcyxcbik6IGJvb2xlYW4ge1xuICBjb25zdCBjb21wYXQgPSBnZXRUb29sQ29tcGF0aWJpbGl0eSh0b29sTmFtZSk7XG4gIGlmICghY29tcGF0KSByZXR1cm4gdHJ1ZTsgIC8vIG5vIG1ldGFkYXRhID0gYWx3YXlzIGNvbXBhdGlibGVcblxuICAvLyBIYXJkIGZpbHRlcjogcHJvdmlkZXIgZG9lc24ndCBzdXBwb3J0IGltYWdlIHRvb2wgcmVzdWx0c1xuICBpZiAoY29tcGF0LnByb2R1Y2VzSW1hZ2VzICYmICFwcm92aWRlckNhcHMuaW1hZ2VUb29sUmVzdWx0cykgcmV0dXJuIGZhbHNlO1xuXG4gIC8vIEhhcmQgZmlsdGVyOiB0b29sIHVzZXMgc2NoZW1hIGZlYXR1cmVzIHByb3ZpZGVyIGRvZXNuJ3Qgc3VwcG9ydFxuICBpZiAoY29tcGF0LnNjaGVtYUZlYXR1cmVzPy5zb21lKGYgPT4gcHJvdmlkZXJDYXBzLnVuc3VwcG9ydGVkU2NoZW1hRmVhdHVyZXMuaW5jbHVkZXMoZikpKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgcmV0dXJuIHRydWU7XG59XG5cbi8qKlxuICogRmlsdGVyIGEgbGlzdCBvZiB0b29sIG5hbWVzIHRvIG9ubHkgdGhvc2UgY29tcGF0aWJsZSB3aXRoIGEgcHJvdmlkZXIuXG4gKiBVc2VkIGJ5IHRoZSByb3V0aW5nIHBpcGVsaW5lIHRvIGFkanVzdCB0b29sIHNldHMgd2hlbiBzd2l0Y2hpbmcgcHJvdmlkZXJzLlxuICpcbiAqIEBwYXJhbSB0b29sTmFtZXMgLSBUaGUgZnVsbCBsaXN0IG9mIGFjdGl2ZSB0b29sIG5hbWVzIHRvIGZpbHRlci5cbiAqIEBwYXJhbSBwcm92aWRlckFwaSAtIFRoZSBwaS1haSBBUEkgc3RyaW5nIChlLmcuIFwib3BlbmFpLWNvbXBsZXRpb25zXCIpLlxuICogQHBhcmFtIHByb3ZpZGVyIC0gT3B0aW9uYWwgcHJvdmlkZXIgSUQgKGUuZy4gXCJncm9xXCIpLiBVc2VkIHRvIGFwcGx5XG4gKiAgIHByb3ZpZGVyLXNwZWNpZmljIGxpbWl0cyB0aGF0IGNhbid0IGJlIGV4cHJlc3NlZCBhcyBBUEktbGV2ZWwgY2FwYWJpbGl0aWVzXG4gKiAgIChlLmcuIEdyb3EncyAxMjgtdG9vbCBoYXJkIGxpbWl0IG9uIHRoZSBzaGFyZWQgb3BlbmFpLWNvbXBsZXRpb25zIGFkYXB0ZXIpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZmlsdGVyVG9vbHNGb3JQcm92aWRlcihcbiAgdG9vbE5hbWVzOiBzdHJpbmdbXSxcbiAgcHJvdmlkZXJBcGk6IHN0cmluZyxcbiAgcHJvdmlkZXI/OiBzdHJpbmcsXG4pOiB7IGNvbXBhdGlibGU6IHN0cmluZ1tdOyBmaWx0ZXJlZDogc3RyaW5nW10gfSB7XG4gIGNvbnN0IHByb3ZpZGVyQ2FwcyA9IGdldFByb3ZpZGVyQ2FwYWJpbGl0aWVzKHByb3ZpZGVyQXBpKTtcblxuICAvLyBQcm92aWRlciBkb2Vzbid0IHN1cHBvcnQgdG9vbCBjYWxsaW5nIGF0IGFsbFxuICBpZiAoIXByb3ZpZGVyQ2Fwcy50b29sQ2FsbGluZykge1xuICAgIHJldHVybiB7IGNvbXBhdGlibGU6IFtdLCBmaWx0ZXJlZDogdG9vbE5hbWVzIH07XG4gIH1cblxuICBjb25zdCBjb21wYXRpYmxlOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBmaWx0ZXJlZDogc3RyaW5nW10gPSBbXTtcblxuICBmb3IgKGNvbnN0IG5hbWUgb2YgdG9vbE5hbWVzKSB7XG4gICAgaWYgKGlzVG9vbENvbXBhdGlibGVXaXRoUHJvdmlkZXIobmFtZSwgcHJvdmlkZXJDYXBzKSkge1xuICAgICAgY29tcGF0aWJsZS5wdXNoKG5hbWUpO1xuICAgIH0gZWxzZSB7XG4gICAgICBmaWx0ZXJlZC5wdXNoKG5hbWUpO1xuICAgIH1cbiAgfVxuXG4gIC8vIEdyb3EgZW5mb3JjZXMgYSBoYXJkIGxpbWl0IG9mIDEyOCB0b29scyBwZXIgcmVxdWVzdCAoIzQzNzYpLlxuICAvLyBUcmltIHRoZSBjb21wYXRpYmxlIGxpc3QgdG8gR1JPUV9NQVhfVE9PTFMgYW5kIG1vdmUgdGhlIGV4Y2VzcyB0byBmaWx0ZXJlZC5cbiAgaWYgKHByb3ZpZGVyICYmIEdST1FfUFJPVklERVJfSURTLmhhcyhwcm92aWRlcikgJiYgY29tcGF0aWJsZS5sZW5ndGggPiBHUk9RX01BWF9UT09MUykge1xuICAgIGNvbnN0IHRyaW1tZWQgPSBjb21wYXRpYmxlLnNwbGljZShHUk9RX01BWF9UT09MUyk7XG4gICAgZmlsdGVyZWQucHVzaCguLi50cmltbWVkKTtcbiAgICBjb25zb2xlLndhcm4oXG4gICAgICBgW2dzZF0gR3JvcSB0b29sIGxpbWl0OiAke2NvbXBhdGlibGUubGVuZ3RoICsgdHJpbW1lZC5sZW5ndGh9IHRvb2xzIGFjdGl2ZSBidXQgR3JvcSBhbGxvd3MgYXQgbW9zdCAke0dST1FfTUFYX1RPT0xTfS4gYCArXG4gICAgICAgIGBUcmltbWluZyB0byB0aGUgZmlyc3QgJHtHUk9RX01BWF9UT09MU30gdG9vbHMuIFJlbW92ZWQ6ICR7dHJpbW1lZC5qb2luKFwiLCBcIil9YCxcbiAgICApO1xuICB9XG5cbiAgcmV0dXJuIHsgY29tcGF0aWJsZSwgZmlsdGVyZWQgfTtcbn1cblxuLyoqXG4gKiBBZGp1c3QgdGhlIGFjdGl2ZSB0b29sIHNldCBmb3IgYSBzZWxlY3RlZCBtb2RlbCdzIHByb3ZpZGVyIGNhcGFiaWxpdGllcy5cbiAqIFJldHVybnMgdG9vbCBuYW1lcyB0aGF0IHNob3VsZCBiZSBhY3RpdmUgXHUyMDE0IHJlbW92ZXMgaW5jb21wYXRpYmxlIHRvb2xzLlxuICpcbiAqIFRoaXMgaXMgYSBoYXJkIGZpbHRlciBvbmx5IFx1MjAxNCBpdCByZW1vdmVzIHRvb2xzIHRoYXQgd291bGQgZmFpbCBhdCB0aGVcbiAqIHByb3ZpZGVyIGxldmVsLiBJdCBkb2VzIE5PVCByZW1vdmUgdG9vbHMgYmFzZWQgb24gc29mdCBoZXVyaXN0aWNzLlxuICpcbiAqIEBwYXJhbSBhY3RpdmVUb29sTmFtZXMgLSBUaGUgZnVsbCBsaXN0IG9mIGN1cnJlbnRseSBhY3RpdmUgdG9vbCBuYW1lcy5cbiAqIEBwYXJhbSBzZWxlY3RlZE1vZGVsQXBpIC0gVGhlIHBpLWFpIEFQSSBzdHJpbmcgZm9yIHRoZSBzZWxlY3RlZCBtb2RlbC5cbiAqIEBwYXJhbSBwcm92aWRlciAtIE9wdGlvbmFsIHByb3ZpZGVyIElEIChlLmcuIFwiZ3JvcVwiKSBmb3IgcHJvdmlkZXItc3BlY2lmaWNcbiAqICAgbGltaXRzIGJleW9uZCB3aGF0IHRoZSBBUEktbGV2ZWwgY2FwYWJpbGl0eSBwcm9maWxlIGV4cHJlc3Nlcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFkanVzdFRvb2xTZXQoXG4gIGFjdGl2ZVRvb2xOYW1lczogc3RyaW5nW10sXG4gIHNlbGVjdGVkTW9kZWxBcGk6IHN0cmluZyxcbiAgcHJvdmlkZXI/OiBzdHJpbmcsXG4pOiB7IHRvb2xOYW1lczogc3RyaW5nW107IHJlbW92ZWRUb29sczogc3RyaW5nW10gfSB7XG4gIGNvbnN0IHsgY29tcGF0aWJsZSwgZmlsdGVyZWQgfSA9IGZpbHRlclRvb2xzRm9yUHJvdmlkZXIoYWN0aXZlVG9vbE5hbWVzLCBzZWxlY3RlZE1vZGVsQXBpLCBwcm92aWRlcik7XG4gIHJldHVybiB7IHRvb2xOYW1lczogY29tcGF0aWJsZSwgcmVtb3ZlZFRvb2xzOiBmaWx0ZXJlZCB9O1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBSUEsU0FBUyxtQkFBbUI7QUFFNUIsU0FBUywrQkFBMEQ7QUFDbkUsU0FBUyw0QkFBcUQ7QUFFOUQsU0FBUyxnQ0FBZ0M7QUFnRWxDLE1BQU0sd0JBQXdEO0FBQUE7QUFBQSxFQUVuRSxvQkFBb0I7QUFBQSxFQUNwQiwyQkFBMkI7QUFBQSxFQUMzQiwyQkFBMkI7QUFBQSxFQUMzQixlQUFlO0FBQUEsRUFDZixnQkFBZ0I7QUFBQSxFQUNoQixnQkFBZ0I7QUFBQSxFQUNoQixjQUFjO0FBQUEsRUFDZCxjQUFjO0FBQUEsRUFDZCxnQkFBZ0I7QUFBQSxFQUNoQixzQkFBc0I7QUFBQSxFQUN0Qix1QkFBdUI7QUFBQSxFQUN2QixvQkFBb0I7QUFBQSxFQUNwQixvQkFBb0I7QUFBQTtBQUFBLEVBR3BCLHFCQUFxQjtBQUFBLEVBQ3JCLDhCQUE4QjtBQUFBLEVBQzlCLDRCQUE0QjtBQUFBLEVBQzVCLFVBQVU7QUFBQSxFQUNWLFdBQVc7QUFBQSxFQUNYLHFCQUFxQjtBQUFBLEVBQ3JCLGtCQUFrQjtBQUFBLEVBQ2xCLGlCQUFpQjtBQUFBO0FBQUEsRUFHakIsbUJBQW1CO0FBQUEsRUFDbkIsbUJBQW1CO0FBQUEsRUFDbkIsd0JBQXdCO0FBQUEsRUFDeEIsZUFBZTtBQUFBLEVBQ2YsU0FBUztBQUFBLEVBQ1QsYUFBYTtBQUFBLEVBQ2IsV0FBVztBQUFBLEVBQ1gsV0FBVztBQUFBLEVBQ1gsaUJBQWlCO0FBQUEsRUFDakIsaUJBQWlCO0FBQUEsRUFDakIsV0FBVztBQUFBLEVBQ1gsV0FBVztBQUFBLEVBQ1gsTUFBTTtBQUFBLEVBQ04sTUFBTTtBQUFBLEVBQ04sV0FBVztBQUFBLEVBQ1gseUJBQXlCO0FBQzNCO0FBTUEsTUFBTSwwQkFBa0Q7QUFBQSxFQUN0RCxvQkFBb0I7QUFBQSxFQUNwQiwyQkFBMkI7QUFBQSxFQUMzQixxQkFBcUI7QUFBQSxFQUNyQiw4QkFBOEI7QUFBQSxFQUM5QixtQkFBbUI7QUFBQSxFQUNuQixtQkFBbUI7QUFBQSxFQUNuQixlQUFlO0FBQUEsRUFDZixVQUFVO0FBQUEsRUFDVixXQUFXO0FBQUEsRUFDWCxnQkFBZ0I7QUFBQSxFQUNoQixnQkFBZ0I7QUFBQSxFQUNoQixTQUFTO0FBQUEsRUFDVCxjQUFjO0FBQUEsRUFDZCxjQUFjO0FBQUEsRUFDZCxnQkFBZ0I7QUFBQSxFQUNoQixhQUFhO0FBQUEsRUFDYixXQUFXO0FBQUEsRUFDWCxxQkFBcUI7QUFBQSxFQUNyQixzQkFBc0I7QUFBQSxFQUN0QixXQUFXO0FBQUEsRUFDWCxpQkFBaUI7QUFBQSxFQUNqQixpQkFBaUI7QUFBQSxFQUNqQix1QkFBdUI7QUFBQSxFQUN2QixXQUFXO0FBQUEsRUFDWCxXQUFXO0FBQUEsRUFDWCxXQUFXO0FBQUEsRUFDWCx5QkFBeUI7QUFBQSxFQUN6QixvQkFBb0I7QUFBQSxFQUNwQixrQkFBa0I7QUFBQSxFQUNsQixpQkFBaUI7QUFDbkI7QUFNTyxNQUFNLDRCQUErRDtBQUFBO0FBQUEsRUFFMUUsbUJBQWdDLEVBQUUsUUFBUSxJQUFJLFdBQVcsSUFBSSxVQUFVLElBQUksV0FBVyxJQUFJLE9BQU8sSUFBSSxhQUFhLElBQUksYUFBYSxHQUFHO0FBQUEsRUFDdEksbUJBQWdDLEVBQUUsUUFBUSxJQUFJLFdBQVcsSUFBSSxVQUFVLElBQUksV0FBVyxJQUFJLE9BQU8sSUFBSSxhQUFhLElBQUksYUFBYSxHQUFHO0FBQUEsRUFDdEkscUJBQWdDLEVBQUUsUUFBUSxJQUFJLFdBQVcsSUFBSSxVQUFVLElBQUksV0FBVyxJQUFJLE9BQU8sSUFBSSxhQUFhLElBQUksYUFBYSxHQUFHO0FBQUEsRUFDdEksOEJBQWdDLEVBQUUsUUFBUSxJQUFJLFdBQVcsSUFBSSxVQUFVLElBQUksV0FBVyxJQUFJLE9BQU8sSUFBSSxhQUFhLElBQUksYUFBYSxHQUFHO0FBQUEsRUFDdEksNEJBQWdDLEVBQUUsUUFBUSxJQUFJLFdBQVcsSUFBSSxVQUFVLElBQUksV0FBVyxJQUFJLE9BQU8sSUFBSSxhQUFhLElBQUksYUFBYSxHQUFHO0FBQUEsRUFDdEksb0JBQWdDLEVBQUUsUUFBUSxJQUFJLFdBQVcsSUFBSSxVQUFVLElBQUksV0FBVyxJQUFJLE9BQU8sSUFBSSxhQUFhLElBQUksYUFBYSxHQUFHO0FBQUEsRUFDdEksMkJBQWdDLEVBQUUsUUFBUSxJQUFJLFdBQVcsSUFBSSxVQUFVLElBQUksV0FBVyxJQUFJLE9BQU8sSUFBSSxhQUFhLElBQUksYUFBYSxHQUFHO0FBQUEsRUFDdEksMkJBQWdDLEVBQUUsUUFBUSxJQUFJLFdBQVcsSUFBSSxVQUFVLElBQUksV0FBVyxJQUFJLE9BQU8sSUFBSSxhQUFhLElBQUksYUFBYSxHQUFHO0FBQUEsRUFDdEksd0JBQWdDLEVBQUUsUUFBUSxJQUFJLFdBQVcsSUFBSSxVQUFVLElBQUksV0FBVyxJQUFJLE9BQU8sSUFBSSxhQUFhLElBQUksYUFBYSxHQUFHO0FBQUE7QUFBQSxFQUd0SSxVQUFnQyxFQUFFLFFBQVEsSUFBSSxXQUFXLElBQUksVUFBVSxJQUFJLFdBQVcsSUFBSSxPQUFPLElBQUksYUFBYSxJQUFJLGFBQWEsR0FBRztBQUFBLEVBQ3RJLGVBQWdDLEVBQUUsUUFBUSxJQUFJLFdBQVcsSUFBSSxVQUFVLElBQUksV0FBVyxJQUFJLE9BQU8sSUFBSSxhQUFhLElBQUksYUFBYSxHQUFHO0FBQUEsRUFDdEksZUFBZ0MsRUFBRSxRQUFRLElBQUksV0FBVyxJQUFJLFVBQVUsSUFBSSxXQUFXLElBQUksT0FBTyxJQUFJLGFBQWEsSUFBSSxhQUFhLEdBQUc7QUFBQSxFQUN0SSxXQUFnQyxFQUFFLFFBQVEsSUFBSSxXQUFXLElBQUksVUFBVSxJQUFJLFdBQVcsSUFBSSxPQUFPLElBQUksYUFBYSxJQUFJLGFBQWEsR0FBRztBQUFBLEVBQ3RJLGdCQUFnQyxFQUFFLFFBQVEsSUFBSSxXQUFXLElBQUksVUFBVSxJQUFJLFdBQVcsSUFBSSxPQUFPLElBQUksYUFBYSxJQUFJLGFBQWEsR0FBRztBQUFBLEVBQ3RJLGdCQUFnQyxFQUFFLFFBQVEsSUFBSSxXQUFXLElBQUksVUFBVSxJQUFJLFdBQVcsSUFBSSxPQUFPLElBQUksYUFBYSxJQUFJLGFBQWEsR0FBRztBQUFBLEVBQ3RJLFNBQWdDLEVBQUUsUUFBUSxJQUFJLFdBQVcsSUFBSSxVQUFVLElBQUksV0FBVyxJQUFJLE9BQU8sSUFBSSxhQUFhLElBQUksYUFBYSxHQUFHO0FBQUEsRUFDdEksY0FBZ0MsRUFBRSxRQUFRLElBQUksV0FBVyxJQUFJLFVBQVUsSUFBSSxXQUFXLElBQUksT0FBTyxJQUFJLGFBQWEsSUFBSSxhQUFhLEdBQUc7QUFBQSxFQUN0SSxjQUFnQyxFQUFFLFFBQVEsSUFBSSxXQUFXLElBQUksVUFBVSxJQUFJLFdBQVcsSUFBSSxPQUFPLElBQUksYUFBYSxJQUFJLGFBQWEsR0FBRztBQUFBLEVBQ3RJLGdCQUFnQyxFQUFFLFFBQVEsSUFBSSxXQUFXLElBQUksVUFBVSxJQUFJLFdBQVcsSUFBSSxPQUFPLElBQUksYUFBYSxJQUFJLGFBQWEsR0FBRztBQUFBLEVBQ3RJLGFBQWdDLEVBQUUsUUFBUSxJQUFJLFdBQVcsSUFBSSxVQUFVLElBQUksV0FBVyxJQUFJLE9BQU8sSUFBSSxhQUFhLElBQUksYUFBYSxHQUFHO0FBQUEsRUFDdEksV0FBZ0MsRUFBRSxRQUFRLElBQUksV0FBVyxJQUFJLFVBQVUsSUFBSSxXQUFXLElBQUksT0FBTyxJQUFJLGFBQWEsSUFBSSxhQUFhLEdBQUc7QUFBQSxFQUN0SSxxQkFBZ0MsRUFBRSxRQUFRLElBQUksV0FBVyxJQUFJLFVBQVUsSUFBSSxXQUFXLElBQUksT0FBTyxJQUFJLGFBQWEsSUFBSSxhQUFhLEdBQUc7QUFBQSxFQUN0SSxzQkFBZ0MsRUFBRSxRQUFRLElBQUksV0FBVyxJQUFJLFVBQVUsSUFBSSxXQUFXLElBQUksT0FBTyxJQUFJLGFBQWEsSUFBSSxhQUFhLEdBQUc7QUFBQSxFQUN0SSxXQUFnQyxFQUFFLFFBQVEsSUFBSSxXQUFXLElBQUksVUFBVSxJQUFJLFdBQVcsSUFBSSxPQUFPLElBQUksYUFBYSxJQUFJLGFBQWEsR0FBRztBQUFBLEVBQ3RJLGlCQUFnQyxFQUFFLFFBQVEsSUFBSSxXQUFXLElBQUksVUFBVSxJQUFJLFdBQVcsSUFBSSxPQUFPLElBQUksYUFBYSxJQUFJLGFBQWEsR0FBRztBQUFBLEVBQ3RJLGlCQUFnQyxFQUFFLFFBQVEsSUFBSSxXQUFXLElBQUksVUFBVSxJQUFJLFdBQVcsSUFBSSxPQUFPLElBQUksYUFBYSxJQUFJLGFBQWEsR0FBRztBQUFBLEVBQ3RJLHVCQUFnQyxFQUFFLFFBQVEsSUFBSSxXQUFXLElBQUksVUFBVSxJQUFJLFdBQVcsSUFBSSxPQUFPLElBQUksYUFBYSxJQUFJLGFBQWEsR0FBRztBQUFBLEVBQ3RJLFdBQWdDLEVBQUUsUUFBUSxJQUFJLFdBQVcsSUFBSSxVQUFVLElBQUksV0FBVyxJQUFJLE9BQU8sSUFBSSxhQUFhLElBQUksYUFBYSxHQUFHO0FBQUE7QUFBQTtBQUFBO0FBQUEsRUFJdEksV0FBZ0MsRUFBRSxRQUFRLElBQUksV0FBVyxJQUFJ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
