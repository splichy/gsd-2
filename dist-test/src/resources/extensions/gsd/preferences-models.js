import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gsdHome } from "./gsd-home.js";
import { canonicalModelForTier, defaultRoutingConfig, resolveModelForTier } from "./model-router.js";
import { loadEffectiveGSDPreferences, getGlobalGSDPreferencesPath } from "./preferences.js";
function resolveModelForUnit(unitType) {
  const resolved = resolveModelWithFallbacksForUnit(unitType);
  return resolved?.primary;
}
function resolveModelWithFallbacksForUnit(unitType) {
  const prefs = loadEffectiveGSDPreferences(void 0, { availableModelIds: [] });
  if (!prefs?.preferences.models) return void 0;
  const m = prefs.preferences.models;
  let phaseConfig;
  switch (unitType) {
    case "research-milestone":
    case "research-slice":
      phaseConfig = m.research;
      break;
    case "plan-milestone":
    case "plan-slice":
    case "refine-slice":
    case "replan-slice":
      phaseConfig = m.planning;
      break;
    case "discuss-milestone":
    case "discuss-slice":
    // Deep-mode project-level discussion units route to the same model
    // bucket as milestone-level discussion (interactive interview style).
    case "discuss-project":
    case "discuss-requirements":
    // Workflow preferences and research-decision are tiny ask_user_questions
    // style units; they share the discuss bucket because they are
    // conversational rather than research/execution. Falling back to planning
    // when no `discuss` bucket is set keeps parity with the milestone units.
    case "workflow-preferences":
    case "research-decision":
      phaseConfig = m.discuss ?? m.planning;
      break;
    // Deep-mode project research orchestrator. Reads PROJECT.md / REQUIREMENTS.md
    // and fans out research subagents. Routes to the research bucket so it
    // gets the research-tier model when one is configured.
    case "research-project":
      phaseConfig = m.research;
      break;
    case "execute-task":
    case "reactive-execute":
      phaseConfig = m.execution;
      break;
    case "execute-task-simple":
      phaseConfig = m.execution_simple ?? m.execution;
      break;
    case "complete-slice":
    case "complete-milestone":
    case "worktree-merge":
    case "run-uat":
      phaseConfig = m.completion;
      break;
    case "reassess-roadmap":
    case "rewrite-docs":
    case "gate-evaluate":
    case "validate-milestone":
      phaseConfig = m.validation ?? m.planning;
      break;
    default:
      if (unitType === "subagent" || unitType.startsWith("subagent/")) {
        phaseConfig = m.subagent;
        break;
      }
      return void 0;
  }
  if (!phaseConfig) return void 0;
  if (typeof phaseConfig === "string") {
    return { primary: phaseConfig, fallbacks: [] };
  }
  const primary = phaseConfig.provider && !phaseConfig.model.includes("/") ? `${phaseConfig.provider}/${phaseConfig.model}` : phaseConfig.model;
  return {
    primary,
    fallbacks: phaseConfig.fallbacks ?? []
  };
}
function resolveDefaultSessionModel(sessionProvider) {
  const prefs = loadEffectiveGSDPreferences(void 0, { availableModelIds: [] });
  if (!prefs?.preferences.models) return void 0;
  const m = prefs.preferences.models;
  const candidates = [
    m.execution,
    m.planning,
    m.research,
    m.discuss,
    m.completion,
    m.validation,
    m.subagent
  ];
  for (const cfg of candidates) {
    if (!cfg) continue;
    let provider;
    let id;
    if (typeof cfg === "string") {
      const slashIdx = cfg.indexOf("/");
      if (slashIdx !== -1) {
        provider = cfg.slice(0, slashIdx);
        id = cfg.slice(slashIdx + 1);
      } else {
        provider = sessionProvider;
        id = cfg;
      }
    } else {
      if (cfg.provider) {
        provider = cfg.provider;
      } else if (cfg.model.includes("/")) {
        const slashIdx = cfg.model.indexOf("/");
        provider = cfg.model.slice(0, slashIdx);
        id = cfg.model.slice(slashIdx + 1);
        return { provider, id };
      } else {
        provider = sessionProvider;
      }
      id = cfg.model;
    }
    if (provider && id) {
      return { provider, id };
    }
  }
  return void 0;
}
function isCustomProvider(provider) {
  if (!provider) return false;
  const candidates = [
    join(gsdHome(), "agent", "models.json"),
    join(homedir(), ".pi", "agent", "models.json")
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed?.providers && Object.prototype.hasOwnProperty.call(parsed.providers, provider)) {
        return true;
      }
    } catch {
    }
  }
  return false;
}
function getNextFallbackModel(currentModelId, modelConfig) {
  const modelsToTry = [modelConfig.primary, ...modelConfig.fallbacks];
  if (!currentModelId) {
    return modelsToTry[0];
  }
  let foundCurrent = false;
  for (let i = 0; i < modelsToTry.length; i++) {
    const mId = modelsToTry[i];
    if (mId === currentModelId || mId.includes("/") && mId.endsWith(`/${currentModelId}`)) {
      foundCurrent = true;
      return modelsToTry[i + 1];
    }
  }
  if (!foundCurrent) {
    return modelsToTry[0];
  }
}
function isTransientNetworkError(errorMsg) {
  if (!errorMsg) return false;
  const hasNetworkSignal = /network|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|fetch failed|connection.*reset|dns/i.test(errorMsg);
  const hasPermanentSignal = /auth|unauthorized|forbidden|invalid.*key|quota|billing/i.test(errorMsg);
  return hasNetworkSignal && !hasPermanentSignal;
}
function validateModelId(modelId) {
  if (!modelId || typeof modelId !== "string") return false;
  const trimmed = modelId.trim();
  if (trimmed.length === 0 || trimmed.length > 256) return false;
  return /^[a-zA-Z0-9\-_./:]+$/.test(trimmed);
}
function updatePreferencesModels(models) {
  const prefsPath = getGlobalGSDPreferencesPath();
  let content = "";
  if (existsSync(prefsPath)) {
    content = readFileSync(prefsPath, "utf-8");
  }
  const lines = ["models:"];
  for (const [phase, value] of Object.entries(models)) {
    if (typeof value === "string") {
      lines.push(`  ${phase}: ${value}`);
    } else if (value && typeof value === "object") {
      const config = value;
      lines.push(`  ${phase}:`);
      lines.push(`    model: ${config.model}`);
      if (config.provider) {
        lines.push(`    provider: ${config.provider}`);
      }
      if (config.fallbacks && config.fallbacks.length > 0) {
        lines.push(`    fallbacks:`);
        for (const fb of config.fallbacks) {
          lines.push(`      - ${fb}`);
        }
      }
    }
  }
  const modelsBlock = lines.join("\n");
  const modelsRegex = /^models:[\s\S]*?(?=\n[a-z_]|\n*$)/m;
  if (modelsRegex.test(content)) {
    content = content.replace(modelsRegex, modelsBlock);
  } else {
    content = content.trimEnd() + "\n\n" + modelsBlock + "\n";
  }
  writeFileSync(prefsPath, content, "utf-8");
}
function resolveDynamicRoutingConfig() {
  const prefs = loadEffectiveGSDPreferences();
  const configured = prefs?.preferences.dynamic_routing;
  if (!configured) return defaultRoutingConfig();
  return {
    ...defaultRoutingConfig(),
    ...configured
  };
}
function resolveAutoSupervisorConfig() {
  const prefs = loadEffectiveGSDPreferences();
  const configured = prefs?.preferences.auto_supervisor ?? {};
  return {
    soft_timeout_minutes: configured.soft_timeout_minutes ?? 20,
    idle_timeout_minutes: configured.idle_timeout_minutes ?? 10,
    hard_timeout_minutes: configured.hard_timeout_minutes ?? 30,
    ...configured.model ? { model: configured.model } : {}
  };
}
const VALID_TOKEN_PROFILES = /* @__PURE__ */ new Set(["budget", "balanced", "quality", "burn-max"]);
const PROFILE_TIER_MAP = {
  budget: {
    planning: "standard",
    research: "light",
    execution: "standard",
    execution_simple: "light",
    completion: "light",
    subagent: "light"
  },
  balanced: {
    planning: "standard",
    research: "standard",
    execution: "standard",
    execution_simple: "light",
    completion: "light",
    subagent: "light"
  },
  quality: {
    planning: "heavy",
    research: "standard",
    execution: "standard",
    execution_simple: "light",
    completion: "light",
    subagent: "standard"
  },
  // burn-max intentionally omits a tier map: it never writes model defaults
  // (it preserves the user's explicit model selection), so resolveProfileDefaults
  // skips model resolution for this profile.
  "burn-max": {}
};
function resolveProfileDefaults(profile, availableModelIds, routingConfig = defaultRoutingConfig()) {
  const tierMap = PROFILE_TIER_MAP[profile];
  const resolveTierModel = (tier) => Array.isArray(availableModelIds) ? resolveModelForTier(tier, availableModelIds, routingConfig) : canonicalModelForTier(tier);
  const models = profile === "burn-max" ? void 0 : {
    planning: resolveTierModel(tierMap.planning),
    research: resolveTierModel(tierMap.research),
    execution: resolveTierModel(tierMap.execution),
    execution_simple: resolveTierModel(tierMap.execution_simple),
    completion: resolveTierModel(tierMap.completion),
    subagent: resolveTierModel(tierMap.subagent)
  };
  switch (profile) {
    case "budget":
      return {
        models,
        phases: {
          skip_research: true,
          skip_reassess: true,
          skip_slice_research: true,
          skip_milestone_validation: true
        }
      };
    case "balanced":
      return {
        models,
        phases: {
          skip_research: true,
          skip_reassess: true,
          skip_slice_research: true
        }
      };
    case "quality":
      return {
        models,
        phases: {
          skip_research: true,
          skip_slice_research: true,
          skip_reassess: true
        }
      };
    case "burn-max":
      return {
        // Quality-first profile: keep user-selected models, disable downgrade routing.
        // Policy constraints still apply at dispatch time.
        dynamic_routing: {
          enabled: false
        },
        context_selection: "full",
        phases: {
          skip_research: false,
          skip_slice_research: false,
          skip_reassess: false,
          skip_milestone_validation: false,
          reassess_after_slice: true
        }
      };
  }
}
function getProfileTierMap(profile) {
  return { ...PROFILE_TIER_MAP[profile] };
}
function resolveEffectiveProfile() {
  const prefs = loadEffectiveGSDPreferences();
  const profile = prefs?.preferences.token_profile;
  if (profile && VALID_TOKEN_PROFILES.has(profile)) return profile;
  return "balanced";
}
function resolveInlineLevel() {
  const profile = resolveEffectiveProfile();
  switch (profile) {
    case "budget":
      return "minimal";
    case "balanced":
      return "standard";
    case "quality":
      return "full";
    case "burn-max":
      return "full";
  }
}
function resolveContextSelection() {
  const prefs = loadEffectiveGSDPreferences();
  if (prefs?.preferences.context_selection) return prefs.preferences.context_selection;
  const profile = resolveEffectiveProfile();
  return profile === "budget" ? "smart" : "full";
}
function resolveSearchProviderFromPreferences() {
  const prefs = loadEffectiveGSDPreferences();
  return prefs?.preferences.search_provider;
}
function resolveDisabledModelProvidersFromPreferences() {
  const prefs = loadEffectiveGSDPreferences();
  const raw = prefs?.preferences.disabled_model_providers;
  if (!Array.isArray(raw)) return [];
  return Array.from(new Set(
    raw.map((provider) => provider.trim()).filter((provider) => provider.length > 0)
  ));
}
export {
  getNextFallbackModel,
  getProfileTierMap,
  isCustomProvider,
  isTransientNetworkError,
  resolveAutoSupervisorConfig,
  resolveContextSelection,
  resolveDefaultSessionModel,
  resolveDisabledModelProvidersFromPreferences,
  resolveDynamicRoutingConfig,
  resolveEffectiveProfile,
  resolveInlineLevel,
  resolveModelForUnit,
  resolveModelWithFallbacksForUnit,
  resolveProfileDefaults,
  resolveSearchProviderFromPreferences,
  updatePreferencesModels,
  validateModelId
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9wcmVmZXJlbmNlcy1tb2RlbHMudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogTW9kZWwtcmVsYXRlZCBwcmVmZXJlbmNlczogcmVzb2x1dGlvbiwgZmFsbGJhY2tzLCBwcm9maWxlIGRlZmF1bHRzLCBhbmQgcm91dGluZy5cbiAqXG4gKiBDb250YWlucyBhbGwgbG9naWMgZm9yIHJlc29sdmluZyBtb2RlbCBjb25maWd1cmF0aW9ucyBmcm9tIHByZWZlcmVuY2VzLFxuICogaW5jbHVkaW5nIHBlci1waGFzZSBtb2RlbCBzZWxlY3Rpb24sIGZhbGxiYWNrIGNoYWlucywgdG9rZW4gcHJvZmlsZXMsXG4gKiBhbmQgZHluYW1pYyByb3V0aW5nIGNvbmZpZ3VyYXRpb24uXG4gKi9cblxuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGhvbWVkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGdzZEhvbWUgfSBmcm9tIFwiLi9nc2QtaG9tZS5qc1wiO1xuaW1wb3J0IHR5cGUgeyBEeW5hbWljUm91dGluZ0NvbmZpZyB9IGZyb20gXCIuL21vZGVsLXJvdXRlci5qc1wiO1xuaW1wb3J0IHsgY2Fub25pY2FsTW9kZWxGb3JUaWVyLCBkZWZhdWx0Um91dGluZ0NvbmZpZywgcmVzb2x2ZU1vZGVsRm9yVGllciB9IGZyb20gXCIuL21vZGVsLXJvdXRlci5qc1wiO1xuaW1wb3J0IHR5cGUgeyBDb21wbGV4aXR5VGllciB9IGZyb20gXCIuL2NvbXBsZXhpdHktY2xhc3NpZmllci5qc1wiO1xuaW1wb3J0IHR5cGUgeyBUb2tlblByb2ZpbGUsIElubGluZUxldmVsIH0gZnJvbSBcIi4vdHlwZXMuanNcIjtcblxuaW1wb3J0IHR5cGUge1xuICBHU0RQcmVmZXJlbmNlcyxcbiAgR1NETW9kZWxDb25maWdWMixcbiAgR1NEUGhhc2VNb2RlbENvbmZpZyxcbiAgUmVzb2x2ZWRNb2RlbENvbmZpZyxcbiAgQXV0b1N1cGVydmlzb3JDb25maWcsXG59IGZyb20gXCIuL3ByZWZlcmVuY2VzLXR5cGVzLmpzXCI7XG5pbXBvcnQgeyBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMsIGdldEdsb2JhbEdTRFByZWZlcmVuY2VzUGF0aCB9IGZyb20gXCIuL3ByZWZlcmVuY2VzLmpzXCI7XG5cbi8vIFJlLWV4cG9ydCB0eXBlcyBzbyBleGlzdGluZyBjb25zdW1lcnMgb2YgLi9wcmVmZXJlbmNlcy1tb2RlbHMuanMga2VlcCB3b3JraW5nXG5leHBvcnQgdHlwZSB7IEdTRFBoYXNlTW9kZWxDb25maWcsIEdTRE1vZGVsQ29uZmlnLCBHU0RNb2RlbENvbmZpZ1YyLCBSZXNvbHZlZE1vZGVsQ29uZmlnIH0gZnJvbSBcIi4vcHJlZmVyZW5jZXMtdHlwZXMuanNcIjtcblxuLyoqXG4gKiBSZXNvbHZlIHdoaWNoIG1vZGVsIElEIHRvIHVzZSBmb3IgYSBnaXZlbiBhdXRvLW1vZGUgdW5pdCB0eXBlLlxuICogUmV0dXJucyB1bmRlZmluZWQgaWYgbm8gbW9kZWwgcHJlZmVyZW5jZSBpcyBzZXQgZm9yIHRoaXMgdW5pdCB0eXBlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZU1vZGVsRm9yVW5pdCh1bml0VHlwZTogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgcmVzb2x2ZWQgPSByZXNvbHZlTW9kZWxXaXRoRmFsbGJhY2tzRm9yVW5pdCh1bml0VHlwZSk7XG4gIHJldHVybiByZXNvbHZlZD8ucHJpbWFyeTtcbn1cblxuLyoqXG4gKiBSZXNvbHZlIG1vZGVsIGFuZCBmYWxsYmFja3MgZm9yIGEgZ2l2ZW4gYXV0by1tb2RlIHVuaXQgdHlwZS5cbiAqIFJldHVybnMgdGhlIHByaW1hcnkgbW9kZWwgYW5kIG9yZGVyZWQgZmFsbGJhY2tzLCBvciB1bmRlZmluZWQgaWYgbm90IGNvbmZpZ3VyZWQuXG4gKlxuICogU3VwcG9ydHMgYm90aCBsZWdhY3kgc3RyaW5nIGZvcm1hdCBhbmQgZXh0ZW5kZWQgb2JqZWN0IGZvcm1hdDpcbiAqIC0gTGVnYWN5OiBgcGxhbm5pbmc6IGNsYXVkZS1vcHVzLTQtNmBcbiAqIC0gRXh0ZW5kZWQ6IGBwbGFubmluZzogeyBtb2RlbDogY2xhdWRlLW9wdXMtNC02LCBmYWxsYmFja3M6IFtnbG0tNSwgbWluaW1heC1tMi41XSB9YFxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZU1vZGVsV2l0aEZhbGxiYWNrc0ZvclVuaXQodW5pdFR5cGU6IHN0cmluZyk6IFJlc29sdmVkTW9kZWxDb25maWcgfCB1bmRlZmluZWQge1xuICBjb25zdCBwcmVmcyA9IGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcyh1bmRlZmluZWQsIHsgYXZhaWxhYmxlTW9kZWxJZHM6IFtdIH0pO1xuICBpZiAoIXByZWZzPy5wcmVmZXJlbmNlcy5tb2RlbHMpIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IG0gPSBwcmVmcy5wcmVmZXJlbmNlcy5tb2RlbHMgYXMgR1NETW9kZWxDb25maWdWMjtcblxuICBsZXQgcGhhc2VDb25maWc6IHN0cmluZyB8IEdTRFBoYXNlTW9kZWxDb25maWcgfCB1bmRlZmluZWQ7XG4gIHN3aXRjaCAodW5pdFR5cGUpIHtcbiAgICBjYXNlIFwicmVzZWFyY2gtbWlsZXN0b25lXCI6XG4gICAgY2FzZSBcInJlc2VhcmNoLXNsaWNlXCI6XG4gICAgICBwaGFzZUNvbmZpZyA9IG0ucmVzZWFyY2g7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwicGxhbi1taWxlc3RvbmVcIjpcbiAgICBjYXNlIFwicGxhbi1zbGljZVwiOlxuICAgIGNhc2UgXCJyZWZpbmUtc2xpY2VcIjpcbiAgICBjYXNlIFwicmVwbGFuLXNsaWNlXCI6XG4gICAgICBwaGFzZUNvbmZpZyA9IG0ucGxhbm5pbmc7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwiZGlzY3Vzcy1taWxlc3RvbmVcIjpcbiAgICBjYXNlIFwiZGlzY3Vzcy1zbGljZVwiOlxuICAgIC8vIERlZXAtbW9kZSBwcm9qZWN0LWxldmVsIGRpc2N1c3Npb24gdW5pdHMgcm91dGUgdG8gdGhlIHNhbWUgbW9kZWxcbiAgICAvLyBidWNrZXQgYXMgbWlsZXN0b25lLWxldmVsIGRpc2N1c3Npb24gKGludGVyYWN0aXZlIGludGVydmlldyBzdHlsZSkuXG4gICAgY2FzZSBcImRpc2N1c3MtcHJvamVjdFwiOlxuICAgIGNhc2UgXCJkaXNjdXNzLXJlcXVpcmVtZW50c1wiOlxuICAgIC8vIFdvcmtmbG93IHByZWZlcmVuY2VzIGFuZCByZXNlYXJjaC1kZWNpc2lvbiBhcmUgdGlueSBhc2tfdXNlcl9xdWVzdGlvbnNcbiAgICAvLyBzdHlsZSB1bml0czsgdGhleSBzaGFyZSB0aGUgZGlzY3VzcyBidWNrZXQgYmVjYXVzZSB0aGV5IGFyZVxuICAgIC8vIGNvbnZlcnNhdGlvbmFsIHJhdGhlciB0aGFuIHJlc2VhcmNoL2V4ZWN1dGlvbi4gRmFsbGluZyBiYWNrIHRvIHBsYW5uaW5nXG4gICAgLy8gd2hlbiBubyBgZGlzY3Vzc2AgYnVja2V0IGlzIHNldCBrZWVwcyBwYXJpdHkgd2l0aCB0aGUgbWlsZXN0b25lIHVuaXRzLlxuICAgIGNhc2UgXCJ3b3JrZmxvdy1wcmVmZXJlbmNlc1wiOlxuICAgIGNhc2UgXCJyZXNlYXJjaC1kZWNpc2lvblwiOlxuICAgICAgcGhhc2VDb25maWcgPSBtLmRpc2N1c3MgPz8gbS5wbGFubmluZztcbiAgICAgIGJyZWFrO1xuICAgIC8vIERlZXAtbW9kZSBwcm9qZWN0IHJlc2VhcmNoIG9yY2hlc3RyYXRvci4gUmVhZHMgUFJPSkVDVC5tZCAvIFJFUVVJUkVNRU5UUy5tZFxuICAgIC8vIGFuZCBmYW5zIG91dCByZXNlYXJjaCBzdWJhZ2VudHMuIFJvdXRlcyB0byB0aGUgcmVzZWFyY2ggYnVja2V0IHNvIGl0XG4gICAgLy8gZ2V0cyB0aGUgcmVzZWFyY2gtdGllciBtb2RlbCB3aGVuIG9uZSBpcyBjb25maWd1cmVkLlxuICAgIGNhc2UgXCJyZXNlYXJjaC1wcm9qZWN0XCI6XG4gICAgICBwaGFzZUNvbmZpZyA9IG0ucmVzZWFyY2g7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwiZXhlY3V0ZS10YXNrXCI6XG4gICAgY2FzZSBcInJlYWN0aXZlLWV4ZWN1dGVcIjpcbiAgICAgIHBoYXNlQ29uZmlnID0gbS5leGVjdXRpb247XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwiZXhlY3V0ZS10YXNrLXNpbXBsZVwiOlxuICAgICAgcGhhc2VDb25maWcgPSBtLmV4ZWN1dGlvbl9zaW1wbGUgPz8gbS5leGVjdXRpb247XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwiY29tcGxldGUtc2xpY2VcIjpcbiAgICBjYXNlIFwiY29tcGxldGUtbWlsZXN0b25lXCI6XG4gICAgY2FzZSBcIndvcmt0cmVlLW1lcmdlXCI6XG4gICAgY2FzZSBcInJ1bi11YXRcIjpcbiAgICAgIHBoYXNlQ29uZmlnID0gbS5jb21wbGV0aW9uO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcInJlYXNzZXNzLXJvYWRtYXBcIjpcbiAgICBjYXNlIFwicmV3cml0ZS1kb2NzXCI6XG4gICAgY2FzZSBcImdhdGUtZXZhbHVhdGVcIjpcbiAgICBjYXNlIFwidmFsaWRhdGUtbWlsZXN0b25lXCI6XG4gICAgICBwaGFzZUNvbmZpZyA9IG0udmFsaWRhdGlvbiA/PyBtLnBsYW5uaW5nO1xuICAgICAgYnJlYWs7XG4gICAgZGVmYXVsdDpcbiAgICAgIC8vIFN1YmFnZW50IHVuaXQgdHlwZXMgKGUuZy4sIFwic3ViYWdlbnRcIiwgXCJzdWJhZ2VudC9zY291dFwiKVxuICAgICAgaWYgKHVuaXRUeXBlID09PSBcInN1YmFnZW50XCIgfHwgdW5pdFR5cGUuc3RhcnRzV2l0aChcInN1YmFnZW50L1wiKSkge1xuICAgICAgICBwaGFzZUNvbmZpZyA9IG0uc3ViYWdlbnQ7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuXG4gIGlmICghcGhhc2VDb25maWcpIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgLy8gTm9ybWFsaXplOiBzdHJpbmcgLT4geyBtb2RlbCwgZmFsbGJhY2tzOiBbXSB9XG4gIGlmICh0eXBlb2YgcGhhc2VDb25maWcgPT09IFwic3RyaW5nXCIpIHtcbiAgICByZXR1cm4geyBwcmltYXJ5OiBwaGFzZUNvbmZpZywgZmFsbGJhY2tzOiBbXSB9O1xuICB9XG5cbiAgLy8gV2hlbiBwcm92aWRlciBpcyBleHBsaWNpdGx5IHNldCwgcHJlcGVuZCBpdCB0byB0aGUgbW9kZWwgSUQgc28gdGhlXG4gIC8vIHJlc29sdXRpb24gY29kZSBpbiBhdXRvLnRzIGNhbiBkbyBhbiBleHBsaWNpdCBwcm92aWRlciBtYXRjaC5cbiAgY29uc3QgcHJpbWFyeSA9IHBoYXNlQ29uZmlnLnByb3ZpZGVyICYmICFwaGFzZUNvbmZpZy5tb2RlbC5pbmNsdWRlcyhcIi9cIilcbiAgICA/IGAke3BoYXNlQ29uZmlnLnByb3ZpZGVyfS8ke3BoYXNlQ29uZmlnLm1vZGVsfWBcbiAgICA6IHBoYXNlQ29uZmlnLm1vZGVsO1xuXG4gIHJldHVybiB7XG4gICAgcHJpbWFyeSxcbiAgICBmYWxsYmFja3M6IHBoYXNlQ29uZmlnLmZhbGxiYWNrcyA/PyBbXSxcbiAgfTtcbn1cblxuLyoqXG4gKiBSZXNvbHZlIHRoZSBkZWZhdWx0IHNlc3Npb24gbW9kZWwgZnJvbSBHU0QgcHJlZmVyZW5jZXMuXG4gKlxuICogVXNlZCBhdCBhdXRvLW1vZGUgYm9vdHN0cmFwIHRvIG92ZXJyaWRlIHRoZSBzZXNzaW9uIG1vZGVsIHRoYXQgd2FzXG4gKiBkZXRlcm1pbmVkIGJ5IHNldHRpbmdzLmpzb24gKGRlZmF1bHRQcm92aWRlci9kZWZhdWx0TW9kZWwpLiAgV2hlblxuICogUFJFRkVSRU5DRVMubWQgKG9yIHByb2plY3QgcHJlZmVyZW5jZXMpIGNvbmZpZ3VyZXMgYW4gYGV4ZWN1dGlvbmAgbW9kZWxcbiAqIHdlIHRyZWF0IHRoYXQgYXMgdGhlIHNlc3Npb24gZGVmYXVsdC4gIEZhbGxzIGJhY2sgdGhyb3VnaCBleGVjdXRpb24gXHUyMTkyXG4gKiBwbGFubmluZyBcdTIxOTIgZmlyc3QgY29uZmlndXJlZCBtb2RlbC5cbiAqXG4gKiBBY2NlcHRzIGFuIG9wdGlvbmFsIGBzZXNzaW9uUHJvdmlkZXJgIGZvciBiYXJlIG1vZGVsIElEcyB0aGF0IGRvbid0XG4gKiBpbmNsdWRlIGFuIGV4cGxpY2l0IHByb3ZpZGVyIHByZWZpeCAoZS5nLiBgZ3B0LTUuNGAgaW5zdGVhZCBvZlxuICogYG9wZW5haS1jb2RleC9ncHQtNS40YCkuICBXaGVuIGEgYmFyZSBJRCBpcyBmb3VuZCBhbmQgc2Vzc2lvblByb3ZpZGVyXG4gKiBpcyBhdmFpbGFibGUsIHRoZSBzZXNzaW9uIHByb3ZpZGVyIGlzIHVzZWQuICBXaXRob3V0IHNlc3Npb25Qcm92aWRlcixcbiAqIGJhcmUgSURzIGFyZSBzdGlsbCByZXR1cm5lZCB3aXRoIHByb3ZpZGVyIHNldCB0byB0aGUgYmFyZSBJRCBpdHNlbGZcbiAqIHNvIGRvd25zdHJlYW0gcmVzb2x1dGlvbiAocmVzb2x2ZU1vZGVsSWQpIGNhbiBtYXRjaCBpdC5cbiAqXG4gKiBSZXR1cm5zIGB7IHByb3ZpZGVyLCBpZCB9YCBvciBgdW5kZWZpbmVkYCBpZiBubyBtb2RlbCBwcmVmZXJlbmNlIGlzXG4gKiBjb25maWd1cmVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZURlZmF1bHRTZXNzaW9uTW9kZWwoXG4gIHNlc3Npb25Qcm92aWRlcj86IHN0cmluZyxcbik6IHsgcHJvdmlkZXI6IHN0cmluZzsgaWQ6IHN0cmluZyB9IHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgcHJlZnMgPSBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXModW5kZWZpbmVkLCB7IGF2YWlsYWJsZU1vZGVsSWRzOiBbXSB9KTtcbiAgaWYgKCFwcmVmcz8ucHJlZmVyZW5jZXMubW9kZWxzKSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gIGNvbnN0IG0gPSBwcmVmcy5wcmVmZXJlbmNlcy5tb2RlbHMgYXMgR1NETW9kZWxDb25maWdWMjtcblxuICAvLyBQcmlvcml0eTogZXhlY3V0aW9uIFx1MjE5MiBwbGFubmluZyBcdTIxOTIgZmlyc3QgY29uZmlndXJlZCB2YWx1ZVxuICBjb25zdCBjYW5kaWRhdGVzOiBBcnJheTxzdHJpbmcgfCBHU0RQaGFzZU1vZGVsQ29uZmlnIHwgdW5kZWZpbmVkPiA9IFtcbiAgICBtLmV4ZWN1dGlvbixcbiAgICBtLnBsYW5uaW5nLFxuICAgIG0ucmVzZWFyY2gsXG4gICAgbS5kaXNjdXNzLFxuICAgIG0uY29tcGxldGlvbixcbiAgICBtLnZhbGlkYXRpb24sXG4gICAgbS5zdWJhZ2VudCxcbiAgXTtcblxuICBmb3IgKGNvbnN0IGNmZyBvZiBjYW5kaWRhdGVzKSB7XG4gICAgaWYgKCFjZmcpIGNvbnRpbnVlO1xuXG4gICAgLy8gTm9ybWFsaXplIHRvIHByb3ZpZGVyICsgaWQgZnJvbSB0aGUgdmFyaW91cyBjb25maWcgc2hhcGVzXG4gICAgbGV0IHByb3ZpZGVyOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gICAgbGV0IGlkOiBzdHJpbmc7XG5cbiAgICBpZiAodHlwZW9mIGNmZyA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgY29uc3Qgc2xhc2hJZHggPSBjZmcuaW5kZXhPZihcIi9cIik7XG4gICAgICBpZiAoc2xhc2hJZHggIT09IC0xKSB7XG4gICAgICAgIHByb3ZpZGVyID0gY2ZnLnNsaWNlKDAsIHNsYXNoSWR4KTtcbiAgICAgICAgaWQgPSBjZmcuc2xpY2Uoc2xhc2hJZHggKyAxKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIEJhcmUgbW9kZWwgSUQgKGUuZy4gXCJncHQtNS40XCIpIFx1MjAxNCB1c2Ugc2Vzc2lvbiBwcm92aWRlciBhcyBjb250ZXh0XG4gICAgICAgIHByb3ZpZGVyID0gc2Vzc2lvblByb3ZpZGVyO1xuICAgICAgICBpZCA9IGNmZztcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgLy8gT2JqZWN0IGNvbmZpZzogeyBtb2RlbCwgcHJvdmlkZXI/LCBmYWxsYmFja3M/IH1cbiAgICAgIGlmIChjZmcucHJvdmlkZXIpIHtcbiAgICAgICAgcHJvdmlkZXIgPSBjZmcucHJvdmlkZXI7XG4gICAgICB9IGVsc2UgaWYgKGNmZy5tb2RlbC5pbmNsdWRlcyhcIi9cIikpIHtcbiAgICAgICAgY29uc3Qgc2xhc2hJZHggPSBjZmcubW9kZWwuaW5kZXhPZihcIi9cIik7XG4gICAgICAgIHByb3ZpZGVyID0gY2ZnLm1vZGVsLnNsaWNlKDAsIHNsYXNoSWR4KTtcbiAgICAgICAgaWQgPSBjZmcubW9kZWwuc2xpY2Uoc2xhc2hJZHggKyAxKTtcbiAgICAgICAgcmV0dXJuIHsgcHJvdmlkZXIsIGlkIH07XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBwcm92aWRlciA9IHNlc3Npb25Qcm92aWRlcjtcbiAgICAgIH1cbiAgICAgIGlkID0gY2ZnLm1vZGVsO1xuICAgIH1cblxuICAgIGlmIChwcm92aWRlciAmJiBpZCkge1xuICAgICAgcmV0dXJuIHsgcHJvdmlkZXIsIGlkIH07XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn1cblxuLyoqXG4gKiBSZXR1cm5zIHRydWUgaWYgYHByb3ZpZGVyYCBpcyBkZWZpbmVkIGFzIGEgY3VzdG9tIHByb3ZpZGVyIGluIHRoZSB1c2VyJ3NcbiAqIGB+Ly5nc2QvYWdlbnQvbW9kZWxzLmpzb25gIChPbGxhbWEsIHZMTE0sIExNIFN0dWRpbywgT3BlbkFJLWNvbXBhdGlibGVcbiAqIHByb3hpZXMsIGV0Yy4pLlxuICpcbiAqIFVzZWQgYnkgYXV0by1tb2RlIGJvb3RzdHJhcCB0byBkZWNpZGUgd2hldGhlciB0aGUgc2Vzc2lvbiBtb2RlbFxuICogKHNldCB2aWEgYC9nc2QgbW9kZWxgKSBzaG91bGQgb3ZlcnJpZGUgYFBSRUZFUkVOQ0VTLm1kYC4gIEN1c3RvbSBwcm92aWRlcnNcbiAqIGFyZSBuZXZlciByZWFjaGFibGUgZnJvbSBgUFJFRkVSRU5DRVMubWRgICh3aGljaCBvbmx5IGtub3dzIGJ1aWx0LWluXG4gKiBwcm92aWRlcnMpLCBzbyB3aGVuIHRoZSB1c2VyIGhhcyBleHBsaWNpdGx5IHNlbGVjdGVkIG9uZSwgaXQgbXVzdCB0YWtlXG4gKiBwcmlvcml0eSBcdTIwMTQgb3RoZXJ3aXNlIGF1dG8tbW9kZSB0cmllcyB0byBzdGFydCB0aGUgYnVpbHQtaW4gcHJvdmlkZXIgZnJvbVxuICogUFJFRkVSRU5DRVMubWQgYW5kIGZhaWxzIHdpdGggXCJOb3QgbG9nZ2VkIGluIFx1MDBCNyBQbGVhc2UgcnVuIC9sb2dpblwiICgjNDEyMikuXG4gKlxuICogUmVhZHMgbW9kZWxzLmpzb24gZGlyZWN0bHkgd2l0aCBhIGxpZ2h0d2VpZ2h0IEpTT04gcGFyc2UgdG8gYXZvaWRcbiAqIHB1bGxpbmcgaW4gdGhlIGZ1bGwgbW9kZWwtcmVnaXN0cnkgYXQgdGhpcyBjYWxsIHNpdGUuICBGYWxscyBiYWNrIHRvXG4gKiBgfi8ucGkvYWdlbnQvbW9kZWxzLmpzb25gIGZvciBwYXJpdHkgd2l0aCBgcmVzb2x2ZU1vZGVsc0pzb25QYXRoKClgLlxuICogQW55IHJlYWQgb3IgcGFyc2UgZXJyb3IgeWllbGRzIGBmYWxzZWAgKHRyZWF0IGFzIG5vdC1jdXN0b20pIHNvIGFcbiAqIG1hbGZvcm1lZCBtb2RlbHMuanNvbiBuZXZlciBicmVha3MgdGhlIHNlc3Npb24gYm9vdHN0cmFwLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNDdXN0b21Qcm92aWRlcihwcm92aWRlcjogc3RyaW5nIHwgdW5kZWZpbmVkKTogYm9vbGVhbiB7XG4gIGlmICghcHJvdmlkZXIpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgY2FuZGlkYXRlcyA9IFtcbiAgICBqb2luKGdzZEhvbWUoKSwgXCJhZ2VudFwiLCBcIm1vZGVscy5qc29uXCIpLFxuICAgIGpvaW4oaG9tZWRpcigpLCBcIi5waVwiLCBcImFnZW50XCIsIFwibW9kZWxzLmpzb25cIiksXG4gIF07XG4gIGZvciAoY29uc3QgcGF0aCBvZiBjYW5kaWRhdGVzKSB7XG4gICAgaWYgKCFleGlzdHNTeW5jKHBhdGgpKSBjb250aW51ZTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmLThcIik7XG4gICAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHJhdykgYXMgeyBwcm92aWRlcnM/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB9O1xuICAgICAgaWYgKHBhcnNlZD8ucHJvdmlkZXJzICYmIE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChwYXJzZWQucHJvdmlkZXJzLCBwcm92aWRlcikpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBJZ25vcmUgXHUyMDE0IG1hbGZvcm1lZCBtb2RlbHMuanNvbiBtdXN0IG5vdCBicmVhayBib290c3RyYXAuXG4gICAgfVxuICB9XG4gIHJldHVybiBmYWxzZTtcbn1cblxuLyoqXG4gKiBEZXRlcm1pbmVzIHRoZSBuZXh0IGZhbGxiYWNrIG1vZGVsIHRvIHRyeSB3aGVuIHRoZSBjdXJyZW50IG1vZGVsIGZhaWxzLlxuICogSWYgdGhlIGN1cnJlbnQgbW9kZWwgaXMgbm90IGluIHRoZSBjb25maWd1cmVkIGxpc3QsIHJldHVybnMgdGhlIHByaW1hcnkgbW9kZWwuXG4gKiBJZiB0aGUgY3VycmVudCBtb2RlbCBpcyB0aGUgbGFzdCBpbiB0aGUgbGlzdCwgcmV0dXJucyB1bmRlZmluZWQgKGV4aGF1c3RlZCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXROZXh0RmFsbGJhY2tNb2RlbChcbiAgY3VycmVudE1vZGVsSWQ6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgbW9kZWxDb25maWc6IFJlc29sdmVkTW9kZWxDb25maWcsXG4pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBjb25zdCBtb2RlbHNUb1RyeSA9IFttb2RlbENvbmZpZy5wcmltYXJ5LCAuLi5tb2RlbENvbmZpZy5mYWxsYmFja3NdO1xuXG4gIGlmICghY3VycmVudE1vZGVsSWQpIHtcbiAgICByZXR1cm4gbW9kZWxzVG9UcnlbMF07XG4gIH1cblxuICBsZXQgZm91bmRDdXJyZW50ID0gZmFsc2U7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgbW9kZWxzVG9UcnkubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBtSWQgPSBtb2RlbHNUb1RyeVtpXTtcbiAgICAvLyBDaGVjayBmb3IgZXhhY3QgbWF0Y2ggb3IgcHJvdmlkZXIvbW9kZWwgc3VmZml4IG1hdGNoXG4gICAgaWYgKG1JZCA9PT0gY3VycmVudE1vZGVsSWQgfHwgKG1JZC5pbmNsdWRlcyhcIi9cIikgJiYgbUlkLmVuZHNXaXRoKGAvJHtjdXJyZW50TW9kZWxJZH1gKSkpIHtcbiAgICAgIGZvdW5kQ3VycmVudCA9IHRydWU7XG4gICAgICByZXR1cm4gbW9kZWxzVG9UcnlbaSArIDFdOyAvLyBSZXR1cm4gdGhlIG5leHQgb25lLCBvciB1bmRlZmluZWQgaWYgYXQgdGhlIGVuZFxuICAgIH1cbiAgfVxuXG4gIC8vIElmIHRoZSBjdXJyZW50IG1vZGVsIHdhc24ndCBpbiBvdXIgcHJlZmVyZW5jZSBsaXN0LCBkZWZhdWx0IHRvIHN0YXJ0aW5nIHRoZSBzZXF1ZW5jZVxuICBpZiAoIWZvdW5kQ3VycmVudCkge1xuICAgIHJldHVybiBtb2RlbHNUb1RyeVswXTtcbiAgfVxufVxuXG4vKipcbiAqIERldGVjdCB3aGV0aGVyIGFuIGVycm9yIG1lc3NhZ2UgaW5kaWNhdGVzIGEgdHJhbnNpZW50IG5ldHdvcmsgZXJyb3JcbiAqICh3b3J0aCByZXRyeWluZyB0aGUgc2FtZSBtb2RlbCkgdnMgYSBwZXJtYW5lbnQgcHJvdmlkZXIgZXJyb3JcbiAqIChhdXRoIGZhaWx1cmUsIHF1b3RhIGV4Y2VlZGVkLCBldGMuIC0tIHNob3VsZCBmYWxsIGJhY2sgaW1tZWRpYXRlbHkpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNUcmFuc2llbnROZXR3b3JrRXJyb3IoZXJyb3JNc2c6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBpZiAoIWVycm9yTXNnKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGhhc05ldHdvcmtTaWduYWwgPSAvbmV0d29ya3xFQ09OTlJFU0VUfEVUSU1FRE9VVHxFQ09OTlJFRlVTRUR8c29ja2V0IGhhbmcgdXB8ZmV0Y2ggZmFpbGVkfGNvbm5lY3Rpb24uKnJlc2V0fGRucy9pLnRlc3QoZXJyb3JNc2cpO1xuICBjb25zdCBoYXNQZXJtYW5lbnRTaWduYWwgPSAvYXV0aHx1bmF1dGhvcml6ZWR8Zm9yYmlkZGVufGludmFsaWQuKmtleXxxdW90YXxiaWxsaW5nL2kudGVzdChlcnJvck1zZyk7XG4gIHJldHVybiBoYXNOZXR3b3JrU2lnbmFsICYmICFoYXNQZXJtYW5lbnRTaWduYWw7XG59XG5cbi8qKlxuICogVmFsaWRhdGUgYSBtb2RlbCBJRCBzdHJpbmcuXG4gKiBSZXR1cm5zIHRydWUgaWYgdGhlIElEIGxvb2tzIGxpa2UgYSB2YWxpZCBtb2RlbCBpZGVudGlmaWVyLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdmFsaWRhdGVNb2RlbElkKG1vZGVsSWQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBpZiAoIW1vZGVsSWQgfHwgdHlwZW9mIG1vZGVsSWQgIT09IFwic3RyaW5nXCIpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgdHJpbW1lZCA9IG1vZGVsSWQudHJpbSgpO1xuICBpZiAodHJpbW1lZC5sZW5ndGggPT09IDAgfHwgdHJpbW1lZC5sZW5ndGggPiAyNTYpIHJldHVybiBmYWxzZTtcbiAgLy8gQWxsb3cgYWxwaGFudW1lcmljLCBoeXBoZW5zLCB1bmRlcnNjb3JlcywgZG90cywgc2xhc2hlcywgY29sb25zXG4gIHJldHVybiAvXlthLXpBLVowLTlcXC1fLi86XSskLy50ZXN0KHRyaW1tZWQpO1xufVxuXG4vKipcbiAqIFVwZGF0ZSB0aGUgbW9kZWxzIHNlY3Rpb24gb2YgdGhlIGdsb2JhbCBHU0QgcHJlZmVyZW5jZXMgZmlsZS5cbiAqIFBlcmZvcm1zIGEgc2FmZSByZWFkLW1vZGlmeS13cml0ZTogcmVhZHMgY3VycmVudCBjb250ZW50LCB1cGRhdGVzIHRoZSBtb2RlbHNcbiAqIFlBTUwgYmxvY2ssIGFuZCB3cml0ZXMgYmFjay4gQ3JlYXRlcyB0aGUgZmlsZSBpZiBpdCBkb2Vzbid0IGV4aXN0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gdXBkYXRlUHJlZmVyZW5jZXNNb2RlbHMobW9kZWxzOiBHU0RNb2RlbENvbmZpZ1YyKTogdm9pZCB7XG4gIGNvbnN0IHByZWZzUGF0aCA9IGdldEdsb2JhbEdTRFByZWZlcmVuY2VzUGF0aCgpO1xuXG4gIGxldCBjb250ZW50ID0gXCJcIjtcbiAgaWYgKGV4aXN0c1N5bmMocHJlZnNQYXRoKSkge1xuICAgIGNvbnRlbnQgPSByZWFkRmlsZVN5bmMocHJlZnNQYXRoLCBcInV0Zi04XCIpO1xuICB9XG5cbiAgLy8gQnVpbGQgdGhlIG5ldyBtb2RlbHMgYmxvY2tcbiAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW1wibW9kZWxzOlwiXTtcbiAgZm9yIChjb25zdCBbcGhhc2UsIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhtb2RlbHMpKSB7XG4gICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgbGluZXMucHVzaChgICAke3BoYXNlfTogJHt2YWx1ZX1gKTtcbiAgICB9IGVsc2UgaWYgKHZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gXCJvYmplY3RcIikge1xuICAgICAgY29uc3QgY29uZmlnID0gdmFsdWUgYXMgR1NEUGhhc2VNb2RlbENvbmZpZztcbiAgICAgIGxpbmVzLnB1c2goYCAgJHtwaGFzZX06YCk7XG4gICAgICBsaW5lcy5wdXNoKGAgICAgbW9kZWw6ICR7Y29uZmlnLm1vZGVsfWApO1xuICAgICAgaWYgKGNvbmZpZy5wcm92aWRlcikge1xuICAgICAgICBsaW5lcy5wdXNoKGAgICAgcHJvdmlkZXI6ICR7Y29uZmlnLnByb3ZpZGVyfWApO1xuICAgICAgfVxuICAgICAgaWYgKGNvbmZpZy5mYWxsYmFja3MgJiYgY29uZmlnLmZhbGxiYWNrcy5sZW5ndGggPiAwKSB7XG4gICAgICAgIGxpbmVzLnB1c2goYCAgICBmYWxsYmFja3M6YCk7XG4gICAgICAgIGZvciAoY29uc3QgZmIgb2YgY29uZmlnLmZhbGxiYWNrcykge1xuICAgICAgICAgIGxpbmVzLnB1c2goYCAgICAgIC0gJHtmYn1gKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxuICBjb25zdCBtb2RlbHNCbG9jayA9IGxpbmVzLmpvaW4oXCJcXG5cIik7XG5cbiAgLy8gUmVwbGFjZSBleGlzdGluZyBtb2RlbHMgYmxvY2sgb3IgYXBwZW5kXG4gIGNvbnN0IG1vZGVsc1JlZ2V4ID0gL15tb2RlbHM6W1xcc1xcU10qPyg/PVxcblthLXpfXXxcXG4qJCkvbTtcbiAgaWYgKG1vZGVsc1JlZ2V4LnRlc3QoY29udGVudCkpIHtcbiAgICBjb250ZW50ID0gY29udGVudC5yZXBsYWNlKG1vZGVsc1JlZ2V4LCBtb2RlbHNCbG9jayk7XG4gIH0gZWxzZSB7XG4gICAgY29udGVudCA9IGNvbnRlbnQudHJpbUVuZCgpICsgXCJcXG5cXG5cIiArIG1vZGVsc0Jsb2NrICsgXCJcXG5cIjtcbiAgfVxuXG4gIHdyaXRlRmlsZVN5bmMocHJlZnNQYXRoLCBjb250ZW50LCBcInV0Zi04XCIpO1xufVxuXG4vKipcbiAqIFJlc29sdmUgdGhlIGR5bmFtaWMgcm91dGluZyBjb25maWd1cmF0aW9uIGZyb20gZWZmZWN0aXZlIHByZWZlcmVuY2VzLlxuICogUmV0dXJucyB0aGUgbWVyZ2VkIGNvbmZpZyB3aXRoIGRlZmF1bHRzIGFwcGxpZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlRHluYW1pY1JvdXRpbmdDb25maWcoKTogRHluYW1pY1JvdXRpbmdDb25maWcge1xuICBjb25zdCBwcmVmcyA9IGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcygpO1xuICBjb25zdCBjb25maWd1cmVkID0gcHJlZnM/LnByZWZlcmVuY2VzLmR5bmFtaWNfcm91dGluZztcbiAgaWYgKCFjb25maWd1cmVkKSByZXR1cm4gZGVmYXVsdFJvdXRpbmdDb25maWcoKTtcbiAgcmV0dXJuIHtcbiAgICAuLi5kZWZhdWx0Um91dGluZ0NvbmZpZygpLFxuICAgIC4uLmNvbmZpZ3VyZWQsXG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlQXV0b1N1cGVydmlzb3JDb25maWcoKTogQXV0b1N1cGVydmlzb3JDb25maWcge1xuICBjb25zdCBwcmVmcyA9IGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcygpO1xuICBjb25zdCBjb25maWd1cmVkID0gcHJlZnM/LnByZWZlcmVuY2VzLmF1dG9fc3VwZXJ2aXNvciA/PyB7fTtcblxuICByZXR1cm4ge1xuICAgIHNvZnRfdGltZW91dF9taW51dGVzOiBjb25maWd1cmVkLnNvZnRfdGltZW91dF9taW51dGVzID8/IDIwLFxuICAgIGlkbGVfdGltZW91dF9taW51dGVzOiBjb25maWd1cmVkLmlkbGVfdGltZW91dF9taW51dGVzID8/IDEwLFxuICAgIGhhcmRfdGltZW91dF9taW51dGVzOiBjb25maWd1cmVkLmhhcmRfdGltZW91dF9taW51dGVzID8/IDMwLFxuICAgIC4uLihjb25maWd1cmVkLm1vZGVsID8geyBtb2RlbDogY29uZmlndXJlZC5tb2RlbCB9IDoge30pLFxuICB9O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVG9rZW4gUHJvZmlsZSBSZXNvbHV0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5jb25zdCBWQUxJRF9UT0tFTl9QUk9GSUxFUyA9IG5ldyBTZXQ8VG9rZW5Qcm9maWxlPihbXCJidWRnZXRcIiwgXCJiYWxhbmNlZFwiLCBcInF1YWxpdHlcIiwgXCJidXJuLW1heFwiXSk7XG5cbi8qKlxuICogUGVyLXBoYXNlIHRpZXIgaW50ZW50aW9ucyBmb3IgZWFjaCB0b2tlbiBwcm9maWxlLlxuICogUHJvZmlsZXMgZXhwcmVzcyBjYXBhYmlsaXR5IHRpZXJzLCBub3QgbW9kZWwgSURzLiBDb25jcmV0ZSBtb2RlbFxuICogcmVzb2x1dGlvbiBoYXBwZW5zIGF0IHJ1bnRpbWUgdmlhIHJlc29sdmVNb2RlbEZvclRpZXIoKSB3aGljaCBpc1xuICogcHJvdmlkZXItYWdub3N0aWMgXHUyMDE0IGl0IHBpY2tzIHRoZSBiZXN0IGF2YWlsYWJsZSBtb2RlbCBhdCBlYWNoIHRpZXIuXG4gKi9cbmNvbnN0IFBST0ZJTEVfVElFUl9NQVA6IFJlY29yZDxUb2tlblByb2ZpbGUsIFJlY29yZDxzdHJpbmcsIENvbXBsZXhpdHlUaWVyPj4gPSB7XG4gIGJ1ZGdldDoge1xuICAgIHBsYW5uaW5nOiBcInN0YW5kYXJkXCIsXG4gICAgcmVzZWFyY2g6IFwibGlnaHRcIixcbiAgICBleGVjdXRpb246IFwic3RhbmRhcmRcIixcbiAgICBleGVjdXRpb25fc2ltcGxlOiBcImxpZ2h0XCIsXG4gICAgY29tcGxldGlvbjogXCJsaWdodFwiLFxuICAgIHN1YmFnZW50OiBcImxpZ2h0XCIsXG4gIH0sXG4gIGJhbGFuY2VkOiB7XG4gICAgcGxhbm5pbmc6IFwic3RhbmRhcmRcIixcbiAgICByZXNlYXJjaDogXCJzdGFuZGFyZFwiLFxuICAgIGV4ZWN1dGlvbjogXCJzdGFuZGFyZFwiLFxuICAgIGV4ZWN1dGlvbl9zaW1wbGU6IFwibGlnaHRcIixcbiAgICBjb21wbGV0aW9uOiBcImxpZ2h0XCIsXG4gICAgc3ViYWdlbnQ6IFwibGlnaHRcIixcbiAgfSxcbiAgcXVhbGl0eToge1xuICAgIHBsYW5uaW5nOiBcImhlYXZ5XCIsXG4gICAgcmVzZWFyY2g6IFwic3RhbmRhcmRcIixcbiAgICBleGVjdXRpb246IFwic3RhbmRhcmRcIixcbiAgICBleGVjdXRpb25fc2ltcGxlOiBcImxpZ2h0XCIsXG4gICAgY29tcGxldGlvbjogXCJsaWdodFwiLFxuICAgIHN1YmFnZW50OiBcInN0YW5kYXJkXCIsXG4gIH0sXG4gIC8vIGJ1cm4tbWF4IGludGVudGlvbmFsbHkgb21pdHMgYSB0aWVyIG1hcDogaXQgbmV2ZXIgd3JpdGVzIG1vZGVsIGRlZmF1bHRzXG4gIC8vIChpdCBwcmVzZXJ2ZXMgdGhlIHVzZXIncyBleHBsaWNpdCBtb2RlbCBzZWxlY3Rpb24pLCBzbyByZXNvbHZlUHJvZmlsZURlZmF1bHRzXG4gIC8vIHNraXBzIG1vZGVsIHJlc29sdXRpb24gZm9yIHRoaXMgcHJvZmlsZS5cbiAgXCJidXJuLW1heFwiOiB7fSxcbn07XG5cbi8qKlxuICogUmVzb2x2ZSBwcm9maWxlIGRlZmF1bHRzIGZvciBhIGdpdmVuIHRva2VuIHByb2ZpbGUgdGllci5cbiAqIFJldHVybnMgYSBwYXJ0aWFsIEdTRFByZWZlcmVuY2VzIHRoYXQgaXMgdXNlZCBhcyB0aGUgYmFzZSBsYXllciAtLVxuICogZXhwbGljaXQgdXNlciBwcmVmZXJlbmNlcyBhbHdheXMgb3ZlcnJpZGUgdGhlc2UgZGVmYXVsdHMuXG4gKlxuICogTW9kZWwgSURzIGFyZSByZXNvbHZlZCBmcm9tIGNhcGFiaWxpdHkgdGllcnMsIG5vdCBoYXJkY29kZWQgdG8gYW55XG4gKiBwcm92aWRlci4gV2hlbiBhdmFpbGFibGUgbW9kZWxzIGFyZSBrbm93biAocnVudGltZSksIHRoZSByZXNvbHZlciBwaWNrc1xuICogdGhlIGJlc3QgbWF0Y2ggYWNyb3NzIGFsbCBjb25maWd1cmVkIHByb3ZpZGVycy4gV2hlbiBub3Qga25vd24gKGUuZy4sXG4gKiBlYXJseSBzdGFydHVwKSwgZmFsbHMgYmFjayB0byBjYW5vbmljYWwgQW50aHJvcGljIG1vZGVsIElEcy5cbiAqXG4gKiBAcGFyYW0gcHJvZmlsZSAgICAgICAgICAgVGhlIHRva2VuIHByb2ZpbGUgdG8gcmVzb2x2ZVxuICogQHBhcmFtIGF2YWlsYWJsZU1vZGVsSWRzIE9wdGlvbmFsIGxpc3Qgb2YgYXZhaWxhYmxlIG1vZGVsIElEcyBmb3IgY3Jvc3MtcHJvdmlkZXIgcmVzb2x1dGlvbi5cbiAqICAgICAgICAgICAgICAgICAgICAgICAgICBVbmRlZmluZWQgbWVhbnMgdGhlIHJlZ2lzdHJ5IGlzIHVuYXZhaWxhYmxlLlxuICogQHBhcmFtIHJvdXRpbmdDb25maWcgICAgIE9wdGlvbmFsIHJvdXRpbmcgY29uZmlnIGZvciB0aWVyIG1vZGVsIHBpbnMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlUHJvZmlsZURlZmF1bHRzKFxuICBwcm9maWxlOiBUb2tlblByb2ZpbGUsXG4gIGF2YWlsYWJsZU1vZGVsSWRzPzogc3RyaW5nW10sXG4gIHJvdXRpbmdDb25maWc6IER5bmFtaWNSb3V0aW5nQ29uZmlnID0gZGVmYXVsdFJvdXRpbmdDb25maWcoKSxcbik6IFBhcnRpYWw8R1NEUHJlZmVyZW5jZXM+IHtcbiAgLy8gYnVybi1tYXggbmV2ZXIgd3JpdGVzIG1vZGVsIGRlZmF1bHRzIFx1MjAxNCBwcmVzZXJ2ZSB1c2VyLXNlbGVjdGVkIG1vZGVscy5cbiAgLy8gRm9yIHRoZSBvdGhlciB0aHJlZSBwcm9maWxlcywgZGVyaXZlIGNvbmNyZXRlIG1vZGVsIElEcyBmcm9tIHRoZSB0aWVyIG1hcFxuICAvLyBhZ2FpbnN0IHRoZSBhdmFpbGFibGUtbW9kZWwgbGlzdCB3aGVuIHRoZSByZWdpc3RyeSBpcyBwcm92aWRlZC4gSWYgY2FsbGVyc1xuICAvLyBvbWl0IHRoZSByZWdpc3RyeSBlbnRpcmVseSwgdXNlIGNhbm9uaWNhbCBmYWxsYmFja3MgZXhwbGljaXRseS5cbiAgY29uc3QgdGllck1hcCA9IFBST0ZJTEVfVElFUl9NQVBbcHJvZmlsZV07XG4gIGNvbnN0IHJlc29sdmVUaWVyTW9kZWwgPSAodGllcjogQ29tcGxleGl0eVRpZXIpOiBzdHJpbmcgPT4gQXJyYXkuaXNBcnJheShhdmFpbGFibGVNb2RlbElkcylcbiAgICA/IHJlc29sdmVNb2RlbEZvclRpZXIodGllciwgYXZhaWxhYmxlTW9kZWxJZHMsIHJvdXRpbmdDb25maWcpXG4gICAgOiBjYW5vbmljYWxNb2RlbEZvclRpZXIodGllcik7XG4gIGNvbnN0IG1vZGVsczogR1NETW9kZWxDb25maWdWMiB8IHVuZGVmaW5lZCA9IHByb2ZpbGUgPT09IFwiYnVybi1tYXhcIlxuICAgID8gdW5kZWZpbmVkXG4gICAgOiB7XG4gICAgICAgIHBsYW5uaW5nOiByZXNvbHZlVGllck1vZGVsKHRpZXJNYXAucGxhbm5pbmcpLFxuICAgICAgICByZXNlYXJjaDogcmVzb2x2ZVRpZXJNb2RlbCh0aWVyTWFwLnJlc2VhcmNoKSxcbiAgICAgICAgZXhlY3V0aW9uOiByZXNvbHZlVGllck1vZGVsKHRpZXJNYXAuZXhlY3V0aW9uKSxcbiAgICAgICAgZXhlY3V0aW9uX3NpbXBsZTogcmVzb2x2ZVRpZXJNb2RlbCh0aWVyTWFwLmV4ZWN1dGlvbl9zaW1wbGUpLFxuICAgICAgICBjb21wbGV0aW9uOiByZXNvbHZlVGllck1vZGVsKHRpZXJNYXAuY29tcGxldGlvbiksXG4gICAgICAgIHN1YmFnZW50OiByZXNvbHZlVGllck1vZGVsKHRpZXJNYXAuc3ViYWdlbnQpLFxuICAgICAgfTtcblxuICBzd2l0Y2ggKHByb2ZpbGUpIHtcbiAgICBjYXNlIFwiYnVkZ2V0XCI6XG4gICAgICByZXR1cm4ge1xuICAgICAgICBtb2RlbHMsXG4gICAgICAgIHBoYXNlczoge1xuICAgICAgICAgIHNraXBfcmVzZWFyY2g6IHRydWUsXG4gICAgICAgICAgc2tpcF9yZWFzc2VzczogdHJ1ZSxcbiAgICAgICAgICBza2lwX3NsaWNlX3Jlc2VhcmNoOiB0cnVlLFxuICAgICAgICAgIHNraXBfbWlsZXN0b25lX3ZhbGlkYXRpb246IHRydWUsXG4gICAgICAgIH0sXG4gICAgICB9O1xuICAgIGNhc2UgXCJiYWxhbmNlZFwiOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgbW9kZWxzLFxuICAgICAgICBwaGFzZXM6IHtcbiAgICAgICAgICBza2lwX3Jlc2VhcmNoOiB0cnVlLFxuICAgICAgICAgIHNraXBfcmVhc3Nlc3M6IHRydWUsXG4gICAgICAgICAgc2tpcF9zbGljZV9yZXNlYXJjaDogdHJ1ZSxcbiAgICAgICAgfSxcbiAgICAgIH07XG4gICAgY2FzZSBcInF1YWxpdHlcIjpcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG1vZGVscyxcbiAgICAgICAgcGhhc2VzOiB7XG4gICAgICAgICAgc2tpcF9yZXNlYXJjaDogdHJ1ZSxcbiAgICAgICAgICBza2lwX3NsaWNlX3Jlc2VhcmNoOiB0cnVlLFxuICAgICAgICAgIHNraXBfcmVhc3Nlc3M6IHRydWUsXG4gICAgICAgIH0sXG4gICAgICB9O1xuICAgIGNhc2UgXCJidXJuLW1heFwiOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgLy8gUXVhbGl0eS1maXJzdCBwcm9maWxlOiBrZWVwIHVzZXItc2VsZWN0ZWQgbW9kZWxzLCBkaXNhYmxlIGRvd25ncmFkZSByb3V0aW5nLlxuICAgICAgICAvLyBQb2xpY3kgY29uc3RyYWludHMgc3RpbGwgYXBwbHkgYXQgZGlzcGF0Y2ggdGltZS5cbiAgICAgICAgZHluYW1pY19yb3V0aW5nOiB7XG4gICAgICAgICAgZW5hYmxlZDogZmFsc2UsXG4gICAgICAgIH0sXG4gICAgICAgIGNvbnRleHRfc2VsZWN0aW9uOiBcImZ1bGxcIixcbiAgICAgICAgcGhhc2VzOiB7XG4gICAgICAgICAgc2tpcF9yZXNlYXJjaDogZmFsc2UsXG4gICAgICAgICAgc2tpcF9zbGljZV9yZXNlYXJjaDogZmFsc2UsXG4gICAgICAgICAgc2tpcF9yZWFzc2VzczogZmFsc2UsXG4gICAgICAgICAgc2tpcF9taWxlc3RvbmVfdmFsaWRhdGlvbjogZmFsc2UsXG4gICAgICAgICAgcmVhc3Nlc3NfYWZ0ZXJfc2xpY2U6IHRydWUsXG4gICAgICAgIH0sXG4gICAgICB9O1xuICB9XG59XG5cbi8qKlxuICogR2V0IHRoZSB0aWVyIGludGVudGlvbnMgZm9yIGEgcHJvZmlsZSB3aXRob3V0IHJlc29sdmluZyB0byBtb2RlbCBJRHMuXG4gKiBVc2VmdWwgZm9yIGRpc3BsYXksIGRlYnVnZ2luZywgYW5kIHRlc3RpbmcuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRQcm9maWxlVGllck1hcChwcm9maWxlOiBUb2tlblByb2ZpbGUpOiBSZWNvcmQ8c3RyaW5nLCBDb21wbGV4aXR5VGllcj4ge1xuICByZXR1cm4geyAuLi5QUk9GSUxFX1RJRVJfTUFQW3Byb2ZpbGVdIH07XG59XG5cbi8qKlxuICogUmVzb2x2ZSB0aGUgZWZmZWN0aXZlIHRva2VuIHByb2ZpbGUgZnJvbSBwcmVmZXJlbmNlcy5cbiAqIFJldHVybnMgXCJiYWxhbmNlZFwiIHdoZW4gbm8gcHJvZmlsZSBpcyBzZXQgKEQwNDYpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZUVmZmVjdGl2ZVByb2ZpbGUoKTogVG9rZW5Qcm9maWxlIHtcbiAgY29uc3QgcHJlZnMgPSBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMoKTtcbiAgY29uc3QgcHJvZmlsZSA9IHByZWZzPy5wcmVmZXJlbmNlcy50b2tlbl9wcm9maWxlO1xuICBpZiAocHJvZmlsZSAmJiBWQUxJRF9UT0tFTl9QUk9GSUxFUy5oYXMocHJvZmlsZSkpIHJldHVybiBwcm9maWxlO1xuICByZXR1cm4gXCJiYWxhbmNlZFwiO1xufVxuXG4vKipcbiAqIFJlc29sdmUgdGhlIGlubGluZSBsZXZlbCBmcm9tIHRoZSBhY3RpdmUgdG9rZW4gcHJvZmlsZS5cbiAqIGJ1ZGdldCAtPiBtaW5pbWFsLCBiYWxhbmNlZCAtPiBzdGFuZGFyZCwgcXVhbGl0eS9idXJuLW1heCAtPiBmdWxsLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZUlubGluZUxldmVsKCk6IElubGluZUxldmVsIHtcbiAgY29uc3QgcHJvZmlsZSA9IHJlc29sdmVFZmZlY3RpdmVQcm9maWxlKCk7XG4gIHN3aXRjaCAocHJvZmlsZSkge1xuICAgIGNhc2UgXCJidWRnZXRcIjogcmV0dXJuIFwibWluaW1hbFwiO1xuICAgIGNhc2UgXCJiYWxhbmNlZFwiOiByZXR1cm4gXCJzdGFuZGFyZFwiO1xuICAgIGNhc2UgXCJxdWFsaXR5XCI6IHJldHVybiBcImZ1bGxcIjtcbiAgICBjYXNlIFwiYnVybi1tYXhcIjogcmV0dXJuIFwiZnVsbFwiO1xuICB9XG59XG5cbi8qKlxuICogUmVzb2x2ZSB0aGUgY29udGV4dCBzZWxlY3Rpb24gbW9kZSBmcm9tIHRoZSBhY3RpdmUgdG9rZW4gcHJvZmlsZS5cbiAqIGJ1ZGdldCAtPiBcInNtYXJ0XCIsIGJhbGFuY2VkL3F1YWxpdHkvYnVybi1tYXggLT4gXCJmdWxsXCIuXG4gKiBFeHBsaWNpdCBwcmVmZXJlbmNlIGFsd2F5cyB3aW5zLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZUNvbnRleHRTZWxlY3Rpb24oKTogaW1wb3J0KFwiLi90eXBlcy5qc1wiKS5Db250ZXh0U2VsZWN0aW9uTW9kZSB7XG4gIGNvbnN0IHByZWZzID0gbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzKCk7XG4gIGlmIChwcmVmcz8ucHJlZmVyZW5jZXMuY29udGV4dF9zZWxlY3Rpb24pIHJldHVybiBwcmVmcy5wcmVmZXJlbmNlcy5jb250ZXh0X3NlbGVjdGlvbjtcbiAgY29uc3QgcHJvZmlsZSA9IHJlc29sdmVFZmZlY3RpdmVQcm9maWxlKCk7XG4gIHJldHVybiBwcm9maWxlID09PSBcImJ1ZGdldFwiID8gXCJzbWFydFwiIDogXCJmdWxsXCI7XG59XG5cbi8qKlxuICogUmVzb2x2ZSB0aGUgc2VhcmNoIHByb3ZpZGVyIHByZWZlcmVuY2UgZnJvbSBwcmVmZXJlbmNlcy5tZC5cbiAqIFJldHVybnMgdW5kZWZpbmVkIGlmIG5vdCBjb25maWd1cmVkIChjYWxsZXIgZmFsbHMgYmFjayB0byBleGlzdGluZyBiZWhhdmlvcikuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlU2VhcmNoUHJvdmlkZXJGcm9tUHJlZmVyZW5jZXMoKTogR1NEUHJlZmVyZW5jZXNbXCJzZWFyY2hfcHJvdmlkZXJcIl0gfCB1bmRlZmluZWQge1xuICBjb25zdCBwcmVmcyA9IGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcygpO1xuICByZXR1cm4gcHJlZnM/LnByZWZlcmVuY2VzLnNlYXJjaF9wcm92aWRlcjtcbn1cblxuLyoqXG4gKiBSZXNvbHZlIHByb3ZpZGVyIElEcyBleGNsdWRlZCBmcm9tIG1vZGVsIHNlbGVjdGlvbi9yb3V0aW5nLlxuICogUmV0dXJucyBhIG5vcm1hbGl6ZWQsIGRlLWR1cGxpY2F0ZWQgbGlzdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVEaXNhYmxlZE1vZGVsUHJvdmlkZXJzRnJvbVByZWZlcmVuY2VzKCk6IHN0cmluZ1tdIHtcbiAgY29uc3QgcHJlZnMgPSBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMoKTtcbiAgY29uc3QgcmF3ID0gcHJlZnM/LnByZWZlcmVuY2VzLmRpc2FibGVkX21vZGVsX3Byb3ZpZGVycztcbiAgaWYgKCFBcnJheS5pc0FycmF5KHJhdykpIHJldHVybiBbXTtcbiAgcmV0dXJuIEFycmF5LmZyb20obmV3IFNldChcbiAgICByYXdcbiAgICAgIC5tYXAoKHByb3ZpZGVyKSA9PiBwcm92aWRlci50cmltKCkpXG4gICAgICAuZmlsdGVyKChwcm92aWRlcikgPT4gcHJvdmlkZXIubGVuZ3RoID4gMCksXG4gICkpO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBUUEsU0FBUyxZQUFZLGNBQWMscUJBQXFCO0FBQ3hELFNBQVMsZUFBZTtBQUN4QixTQUFTLFlBQVk7QUFDckIsU0FBUyxlQUFlO0FBRXhCLFNBQVMsdUJBQXVCLHNCQUFzQiwyQkFBMkI7QUFXakYsU0FBUyw2QkFBNkIsbUNBQW1DO0FBU2xFLFNBQVMsb0JBQW9CLFVBQXNDO0FB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
