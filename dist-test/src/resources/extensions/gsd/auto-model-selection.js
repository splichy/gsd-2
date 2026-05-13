import { resolveModelWithFallbacksForUnit, resolveDynamicRoutingConfig } from "./preferences.js";
import { classifyUnitComplexity, extractTaskMetadata, tierLabel } from "./complexity-classifier.js";
import { resolveModelForComplexity, escalateTier, getEligibleModels, loadCapabilityOverrides, adjustToolSet } from "./model-router.js";
import { getLedger, getProjectTotals } from "./metrics.js";
import { unitPhaseLabel } from "./auto-dashboard.js";
import { getSessionModelOverride } from "./session-model-override.js";
import { logWarning } from "./workflow-logger.js";
import { resolveUokFlags } from "./uok/flags.js";
import { applyModelPolicyFilter } from "./uok/model-policy.js";
import { isModelBlocked } from "./blocked-models.js";
import { getRequiredWorkflowToolsForAutoUnit } from "./workflow-mcp.js";
class ModelPolicyDispatchBlockedError extends Error {
  unitType;
  unitId;
  reasons;
  constructor(unitType, unitId, reasons) {
    const summary = reasons.length === 0 ? "no candidate models" : reasons.slice(0, 4).map((r) => `${r.provider}/${r.modelId} (${r.reason})`).join("; ");
    super(`Model policy denied dispatch for ${unitType}/${unitId} before prompt send. Rejected: ${summary}`);
    this.name = "ModelPolicyDispatchBlockedError";
    this.unitType = unitType;
    this.unitId = unitId;
    this.reasons = reasons;
  }
}
const TOOL_BASELINE = /* @__PURE__ */ new WeakMap();
function clearToolBaseline(pi) {
  TOOL_BASELINE.delete(pi);
}
function restoreToolBaseline(pi) {
  const key = pi;
  const baseline = TOOL_BASELINE.get(key);
  if (baseline === void 0) {
    const initial = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
    TOOL_BASELINE.set(key, [...initial]);
    return;
  }
  if (typeof pi.setActiveTools === "function") {
    pi.setActiveTools([...baseline]);
  }
}
function reapplyThinkingLevel(pi, level) {
  if (!level) return;
  pi.setThinkingLevel(level);
}
function resolvePreferredModelConfig(unitType, autoModeStartModel, isAutoMode = true) {
  const explicitConfig = resolveModelWithFallbacksForUnit(unitType);
  if (explicitConfig) {
    return {
      ...explicitConfig,
      source: "explicit"
    };
  }
  if (!isAutoMode) return void 0;
  const routingConfig = resolveDynamicRoutingConfig();
  if (!routingConfig.enabled || !routingConfig.tier_models) return void 0;
  if (!routingConfig.allow_flat_rate_providers && autoModeStartModel && isFlatRateProvider(autoModeStartModel.provider, autoModeStartModel.flatRateCtx)) {
    return void 0;
  }
  const ceilingModel = routingConfig.tier_models.heavy ?? (autoModeStartModel ? `${autoModeStartModel.provider}/${autoModeStartModel.id}` : void 0);
  if (!ceilingModel) return void 0;
  return {
    primary: ceilingModel,
    fallbacks: [],
    source: "synthesized"
  };
}
async function selectAndApplyModel(ctx, pi, unitType, unitId, basePath, prefs, verbose, autoModeStartModel, retryContext, isAutoMode = true, sessionModelOverride, autoModeStartThinkingLevel) {
  const uokFlags = resolveUokFlags(prefs);
  const effectiveSessionModelOverride = sessionModelOverride === void 0 ? getSessionModelOverride(ctx.sessionManager.getSessionId()) : sessionModelOverride ?? void 0;
  if (autoModeStartModel) {
    autoModeStartModel = {
      ...autoModeStartModel,
      flatRateCtx: buildFlatRateContext(autoModeStartModel.provider, ctx, prefs)
    };
  }
  const modelConfig = effectiveSessionModelOverride ? void 0 : resolvePreferredModelConfig(unitType, autoModeStartModel, isAutoMode);
  let routing = null;
  let appliedModel = null;
  if (isAutoMode) restoreToolBaseline(pi);
  if (modelConfig) {
    const availableModels = ctx.modelRegistry.getAvailable();
    const modelPolicyTraceId = `model:${ctx.sessionManager.getSessionId()}:${Date.now()}`;
    const modelPolicyTurnId = `${unitType}:${unitId}`;
    let policyAllowedModelKeys = null;
    const routingConfig = resolveDynamicRoutingConfig();
    if (!isAutoMode) {
      routingConfig.enabled = false;
    }
    if (prefs?.token_profile === "burn-max") {
      routingConfig.enabled = false;
    }
    if (modelConfig.source === "explicit") {
      routingConfig.enabled = false;
    }
    let effectiveModelConfig = modelConfig;
    let routingTierLabel = "";
    let routingEligibleModels = availableModels;
    const taskMetadataForPolicy = unitType === "execute-task" ? extractTaskMetadata(unitId, basePath) : void 0;
    let policyDenyReasons = [];
    if (uokFlags.modelPolicy) {
      const requiredTools = getRequiredWorkflowToolsForAutoUnit(unitType);
      const policy = applyModelPolicyFilter(
        availableModels,
        {
          basePath,
          traceId: modelPolicyTraceId,
          turnId: modelPolicyTurnId,
          unitType,
          taskMetadata: taskMetadataForPolicy,
          currentProvider: ctx.model?.provider,
          allowCrossProvider: routingConfig.cross_provider !== false,
          requiredTools
        }
      );
      routingEligibleModels = policy.eligible;
      policyAllowedModelKeys = new Set(
        policy.eligible.map((m) => `${m.provider.toLowerCase()}/${m.id.toLowerCase()}`)
      );
      policyDenyReasons = policy.decisions.filter((d) => !d.allowed).map((d) => ({ provider: d.provider, modelId: d.modelId, reason: d.reason }));
      if (routingEligibleModels.length === 0) {
        throw new ModelPolicyDispatchBlockedError(unitType, unitId, policyDenyReasons);
      }
    }
    if (routingConfig.enabled && !routingConfig.allow_flat_rate_providers) {
      const primaryModel = resolveModelId(modelConfig.primary, routingEligibleModels, ctx.model?.provider);
      if (primaryModel) {
        const primaryFlatRateCtx = buildFlatRateContext(primaryModel.provider, ctx, prefs);
        if (isFlatRateProvider(primaryModel.provider, primaryFlatRateCtx)) {
          routingConfig.enabled = false;
        }
      } else if (autoModeStartModel && isFlatRateProvider(autoModeStartModel.provider, autoModeStartModel.flatRateCtx) || ctx.model?.provider && isFlatRateProvider(
        ctx.model.provider,
        buildFlatRateContext(ctx.model.provider, ctx, prefs)
      )) {
        routingConfig.enabled = false;
      }
    }
    if (routingConfig.enabled) {
      let budgetPct;
      if (routingConfig.budget_pressure !== false) {
        const budgetCeiling = prefs?.budget_ceiling;
        if (budgetCeiling !== void 0 && budgetCeiling > 0) {
          const currentLedger = getLedger();
          const totalCost = currentLedger ? getProjectTotals(currentLedger.units).cost : 0;
          budgetPct = totalCost / budgetCeiling;
        }
      }
      const isHook = unitType.startsWith("hook/");
      const shouldClassify = !isHook || routingConfig.hooks !== false;
      if (shouldClassify) {
        let classification = classifyUnitComplexity(
          unitType,
          unitId,
          basePath,
          budgetPct,
          taskMetadataForPolicy
        );
        const availableModelIds = routingEligibleModels.map((m) => `${m.provider}/${m.id}`);
        if (retryContext?.isRetry && retryContext.previousTier && routingConfig.escalate_on_failure !== false) {
          const escalated = escalateTier(retryContext.previousTier);
          if (escalated) {
            classification = { ...classification, tier: escalated, reason: "escalated after failure" };
            ctx.ui.notify(
              `Tier escalation: ${retryContext.previousTier} \u2192 ${escalated} (retry after failure)`,
              "info"
            );
          } else {
            const tierOrder = { light: 0, standard: 1, heavy: 2 };
            const prevOrder = tierOrder[retryContext.previousTier] ?? 0;
            const freshOrder = tierOrder[classification.tier] ?? 0;
            if (prevOrder > freshOrder) {
              classification = { ...classification, tier: retryContext.previousTier, reason: "retained escalated tier from retry" };
            }
          }
        }
        const capabilityOverrides = loadCapabilityOverrides(prefs ?? {});
        let hookOverride;
        if (routingConfig.hooks !== false) {
          const eligible = getEligibleModels(
            classification.tier,
            availableModelIds,
            routingConfig
          );
          const hookResult = await pi.emitBeforeModelSelect({
            unitType,
            unitId,
            classification: {
              tier: classification.tier,
              reason: classification.reason,
              downgraded: classification.downgraded
            },
            taskMetadata: classification.taskMetadata,
            eligibleModels: eligible,
            phaseConfig: modelConfig ? {
              primary: modelConfig.primary,
              fallbacks: modelConfig.fallbacks ?? []
            } : void 0
          });
          if (hookResult?.modelId) {
            hookOverride = hookResult.modelId;
          }
        }
        let routingResult;
        if (hookOverride) {
          routingResult = {
            modelId: hookOverride,
            fallbacks: [
              ...(modelConfig?.fallbacks ?? []).filter((f) => f !== hookOverride),
              ...modelConfig?.primary && modelConfig.primary !== hookOverride ? [modelConfig.primary] : []
            ],
            tier: classification.tier,
            wasDowngraded: hookOverride !== modelConfig?.primary,
            reason: `hook override: ${hookOverride}`,
            selectionMethod: "tier-only"
          };
        } else {
          routingResult = resolveModelForComplexity(
            classification,
            modelConfig,
            routingConfig,
            availableModelIds,
            unitType,
            classification.taskMetadata,
            capabilityOverrides
          );
        }
        if (routingResult.wasDowngraded) {
          effectiveModelConfig = {
            primary: routingResult.modelId,
            fallbacks: routingResult.fallbacks,
            source: modelConfig.source
          };
          if (routingResult.selectionMethod === "capability-scored" && routingResult.capabilityScores) {
            const tierLbl = tierLabel(classification.tier);
            const scores = Object.entries(routingResult.capabilityScores).sort(([, a], [, b]) => b - a).map(([id, score]) => `${id}: ${score.toFixed(1)}`).join(", ");
            ctx.ui.notify(
              `Dynamic routing [${tierLbl}]: ${routingResult.modelId} (capability-scored) \u2014 ${scores}`,
              "info"
            );
          } else {
            ctx.ui.notify(
              `Dynamic routing [${tierLabel(classification.tier)}]: ${routingResult.modelId} (${classification.reason})`,
              "info"
            );
          }
        }
        routingTierLabel = ` [${tierLabel(classification.tier)}]`;
        routing = { tier: classification.tier, modelDowngraded: routingResult.wasDowngraded };
      }
    }
    const modelsToTry = [effectiveModelConfig.primary, ...effectiveModelConfig.fallbacks];
    let attemptedPolicyEligible = false;
    for (const modelId of modelsToTry) {
      const resolutionPool = uokFlags.modelPolicy ? routingEligibleModels : availableModels;
      const model = resolveModelId(modelId, resolutionPool, ctx.model?.provider);
      if (!model) {
        if (verbose) ctx.ui.notify(`Model ${modelId} not found, trying fallback.`, "info");
        continue;
      }
      if (policyAllowedModelKeys) {
        const key = `${model.provider.toLowerCase()}/${model.id.toLowerCase()}`;
        if (!policyAllowedModelKeys.has(key)) {
          if (verbose) {
            ctx.ui.notify(`Model policy denied ${model.provider}/${model.id}; trying fallback.`, "warning");
          }
          continue;
        }
        attemptedPolicyEligible = true;
      }
      if (isModelBlocked(basePath, model.provider, model.id)) {
        ctx.ui.notify(
          `Skipping blocked model ${model.provider}/${model.id} (provider rejected it for this account).`,
          "warning"
        );
        continue;
      }
      if (!modelId.includes("/")) {
        const providers = availableModels.filter((m) => m.id === modelId).map((m) => m.provider);
        if (providers.length > 1 && model.provider !== ctx.model?.provider) {
          ctx.ui.notify(
            `Model ID "${modelId}" exists in multiple providers (${providers.join(", ")}). Resolved to ${model.provider}. Use "provider/model" format for explicit targeting.`,
            "warning"
          );
        }
      }
      const ok = await pi.setModel(model, { persist: false });
      if (ok) {
        appliedModel = model;
        reapplyThinkingLevel(pi, autoModeStartThinkingLevel);
        const activeToolNames = pi.getActiveTools();
        const { toolNames: compatibleTools, removedTools } = adjustToolSet(activeToolNames, model.api, model.provider);
        let finalToolNames = compatibleTools;
        if (routingConfig.hooks !== false) {
          const hookResult = await pi.emitAdjustToolSet({
            selectedModelApi: model.api,
            selectedModelProvider: model.provider,
            selectedModelId: model.id,
            activeToolNames,
            filteredTools: removedTools
          });
          if (hookResult?.toolNames) {
            finalToolNames = hookResult.toolNames;
          }
        }
        if (removedTools.length > 0 || finalToolNames.length !== activeToolNames.length) {
          pi.setActiveTools(finalToolNames);
        }
        if (verbose) {
          const fallbackNote = modelId === effectiveModelConfig.primary ? "" : ` (fallback from ${effectiveModelConfig.primary})`;
          const phase = unitPhaseLabel(unitType);
          ctx.ui.notify(`Model [${phase}]${routingTierLabel}: ${model.provider}/${model.id}${fallbackNote}`, "info");
          if (removedTools.length > 0) {
            ctx.ui.notify(
              `Tool compatibility: ${removedTools.length} tools filtered for ${model.api} \u2014 ${removedTools.join(", ")}`,
              "info"
            );
          }
        }
        break;
      } else {
        const nextModel = modelsToTry[modelsToTry.indexOf(modelId) + 1];
        if (nextModel) {
          if (verbose) ctx.ui.notify(`Failed to set model ${modelId}, trying ${nextModel}...`, "info");
        } else {
          ctx.ui.notify(`All preferred models unavailable for ${unitType}. Using default.`, "warning");
        }
      }
    }
    if (uokFlags.modelPolicy && policyAllowedModelKeys && !attemptedPolicyEligible) {
      throw new ModelPolicyDispatchBlockedError(unitType, unitId, policyDenyReasons);
    }
  } else if (autoModeStartModel) {
    const availableModels = ctx.modelRegistry.getAvailable();
    const startBlocked = isModelBlocked(basePath, autoModeStartModel.provider, autoModeStartModel.id);
    if (startBlocked) {
      ctx.ui.notify(
        `Auto-mode start model ${autoModeStartModel.provider}/${autoModeStartModel.id} is blocked for this account. Using current session model instead.`,
        "warning"
      );
    } else {
      const startModel = availableModels.find(
        (m) => m.provider === autoModeStartModel.provider && m.id === autoModeStartModel.id
      );
      if (startModel) {
        const ok = await pi.setModel(startModel, { persist: false });
        if (!ok) {
          const byId = availableModels.find(
            (m) => m.id === autoModeStartModel.id && !isModelBlocked(basePath, m.provider, m.id)
          );
          if (byId) {
            const fallbackOk = await pi.setModel(byId, { persist: false });
            if (fallbackOk) {
              appliedModel = byId;
              reapplyThinkingLevel(pi, autoModeStartThinkingLevel);
            }
          }
        } else {
          appliedModel = startModel;
          reapplyThinkingLevel(pi, autoModeStartThinkingLevel);
        }
      }
    }
  }
  return { routing, appliedModel };
}
function resolveModelId(modelId, availableModels, currentProvider) {
  if (!modelId) return void 0;
  const slashIdx = modelId.indexOf("/");
  if (slashIdx !== -1) {
    const maybeProvider = modelId.substring(0, slashIdx);
    const id = modelId.substring(slashIdx + 1);
    const knownProviders = new Set(availableModels.map((m) => m.provider.toLowerCase()));
    if (knownProviders.has(maybeProvider.toLowerCase())) {
      const match = availableModels.find(
        (m) => m.provider.toLowerCase() === maybeProvider.toLowerCase() && m.id.toLowerCase() === id.toLowerCase()
      );
      if (match) return match;
    }
    const lower = modelId.toLowerCase();
    return availableModels.find(
      (m) => m.id.toLowerCase() === lower || `${m.provider}/${m.id}`.toLowerCase() === lower
    );
  }
  const candidates = availableModels.filter((m) => m.id === modelId);
  if (candidates.length === 0) return void 0;
  if (candidates.length === 1) return candidates[0];
  if (currentProvider === "claude-code") {
    const ccMatch = candidates.find((m) => m.provider === "claude-code");
    if (ccMatch) return ccMatch;
  }
  const EXTENSION_PROVIDERS = /* @__PURE__ */ new Set(["claude-code"]);
  if (currentProvider && !EXTENSION_PROVIDERS.has(currentProvider)) {
    const providerMatch = candidates.find((m) => m.provider === currentProvider);
    if (providerMatch) return providerMatch;
  }
  const anthropicMatch = candidates.find((m) => m.provider === "anthropic");
  if (anthropicMatch) return anthropicMatch;
  return candidates.find((m) => !EXTENSION_PROVIDERS.has(m.provider)) ?? candidates[0];
}
const BUILTIN_FLAT_RATE = /* @__PURE__ */ new Set(["github-copilot", "copilot", "claude-code"]);
function isFlatRateProvider(provider, opts) {
  const p = provider.toLowerCase();
  if (BUILTIN_FLAT_RATE.has(p)) return true;
  if (opts?.userFlatRate?.some((id) => id.toLowerCase() === p)) return true;
  if (opts?.authMode === "externalCli") return true;
  return false;
}
function buildFlatRateContext(provider, ctx, prefs) {
  let authMode;
  const registry = ctx?.modelRegistry;
  if (registry && typeof registry.getProviderAuthMode === "function") {
    try {
      const mode = registry.getProviderAuthMode(provider);
      if (mode === "apiKey" || mode === "oauth" || mode === "externalCli" || mode === "none") {
        authMode = mode;
      }
    } catch (err) {
      logWarning(
        "dispatch",
        `flat-rate auth-mode lookup failed for ${provider}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return {
    authMode,
    userFlatRate: prefs?.flat_rate_providers
  };
}
export {
  ModelPolicyDispatchBlockedError,
  buildFlatRateContext,
  clearToolBaseline,
  isFlatRateProvider,
  resolveModelId,
  resolvePreferredModelConfig,
  selectAndApplyModel
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9hdXRvLW1vZGVsLXNlbGVjdGlvbi50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBNb2RlbCBzZWxlY3Rpb24gYW5kIGR5bmFtaWMgcm91dGluZyBmb3IgYXV0by1tb2RlIHVuaXQgZGlzcGF0Y2guXG4gKiBIYW5kbGVzIGNvbXBsZXhpdHktYmFzZWQgcm91dGluZywgbW9kZWwgcmVzb2x1dGlvbiBhY3Jvc3MgcHJvdmlkZXJzLFxuICogYW5kIGZhbGxiYWNrIGNoYWlucy5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEFwaSwgTW9kZWwgfSBmcm9tIFwiQGdzZC9waS1haVwiO1xuaW1wb3J0IHsgZ2V0UHJvdmlkZXJDYXBhYmlsaXRpZXMgfSBmcm9tIFwiQGdzZC9waS1haVwiO1xuaW1wb3J0IHR5cGUgeyBFeHRlbnNpb25BUEksIEV4dGVuc2lvbkNvbnRleHQgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB0eXBlIHsgR1NEUHJlZmVyZW5jZXMgfSBmcm9tIFwiLi9wcmVmZXJlbmNlcy5qc1wiO1xuaW1wb3J0IHsgcmVzb2x2ZU1vZGVsV2l0aEZhbGxiYWNrc0ZvclVuaXQsIHJlc29sdmVEeW5hbWljUm91dGluZ0NvbmZpZyB9IGZyb20gXCIuL3ByZWZlcmVuY2VzLmpzXCI7XG5pbXBvcnQgdHlwZSB7IENvbXBsZXhpdHlUaWVyIH0gZnJvbSBcIi4vY29tcGxleGl0eS1jbGFzc2lmaWVyLmpzXCI7XG5pbXBvcnQgeyBjbGFzc2lmeVVuaXRDb21wbGV4aXR5LCBleHRyYWN0VGFza01ldGFkYXRhLCB0aWVyTGFiZWwgfSBmcm9tIFwiLi9jb21wbGV4aXR5LWNsYXNzaWZpZXIuanNcIjtcbmltcG9ydCB7IHJlc29sdmVNb2RlbEZvckNvbXBsZXhpdHksIGVzY2FsYXRlVGllciwgZ2V0RWxpZ2libGVNb2RlbHMsIGxvYWRDYXBhYmlsaXR5T3ZlcnJpZGVzLCBhZGp1c3RUb29sU2V0LCBmaWx0ZXJUb29sc0ZvclByb3ZpZGVyIH0gZnJvbSBcIi4vbW9kZWwtcm91dGVyLmpzXCI7XG5pbXBvcnQgeyBnZXRMZWRnZXIsIGdldFByb2plY3RUb3RhbHMgfSBmcm9tIFwiLi9tZXRyaWNzLmpzXCI7XG5pbXBvcnQgeyB1bml0UGhhc2VMYWJlbCB9IGZyb20gXCIuL2F1dG8tZGFzaGJvYXJkLmpzXCI7XG5pbXBvcnQgeyBnZXRTZXNzaW9uTW9kZWxPdmVycmlkZSB9IGZyb20gXCIuL3Nlc3Npb24tbW9kZWwtb3ZlcnJpZGUuanNcIjtcbmltcG9ydCB7IGxvZ1dhcm5pbmcgfSBmcm9tIFwiLi93b3JrZmxvdy1sb2dnZXIuanNcIjtcbmltcG9ydCB7IHJlc29sdmVVb2tGbGFncyB9IGZyb20gXCIuL3Vvay9mbGFncy5qc1wiO1xuaW1wb3J0IHsgYXBwbHlNb2RlbFBvbGljeUZpbHRlciB9IGZyb20gXCIuL3Vvay9tb2RlbC1wb2xpY3kuanNcIjtcbmltcG9ydCB7IGlzTW9kZWxCbG9ja2VkIH0gZnJvbSBcIi4vYmxvY2tlZC1tb2RlbHMuanNcIjtcbmltcG9ydCB7IGdldFJlcXVpcmVkV29ya2Zsb3dUb29sc0ZvckF1dG9Vbml0IH0gZnJvbSBcIi4vd29ya2Zsb3ctbWNwLmpzXCI7XG5cbi8qKlxuICogVGhyb3duIHdoZW4gdGhlIG1vZGVsLXBvbGljeSBnYXRlIHJlamVjdHMgZXZlcnkgY2FuZGlkYXRlIG1vZGVsIGZvciBhIHVuaXRcbiAqIGRpc3BhdGNoICgjNDk1OSAvICM0NjgxIC8gIzQ4NTApLiAgVGhlIGF1dG8tbG9vcCBjYXRjaGVzIHRoaXMgc3BlY2lmaWNhbGx5XG4gKiB0byBjbGFzc2lmeSB0aGUgdW5pdCBhcyBgYmxvY2tlZGAgcmF0aGVyIHRoYW4gY291bnRpbmcgaXQgYXMgYSByZXRyeWFibGVcbiAqIGl0ZXJhdGlvbiBlcnJvciBcdTIwMTQgcHJlLXNlbmQgcG9saWN5IGRlbmlhbCBpcyBhIGNvbmZpZ3VyYXRpb24gcHJvYmxlbSwgbm90IGFcbiAqIHRyYW5zaWVudCBydW50aW1lIGZhaWx1cmUsIHNvIHJldHJ5aW5nIGp1c3QgYnVybnMgdGhlIGNvbnNlY3V0aXZlLWVycm9yXG4gKiBidWRnZXQgdG93YXJkIGEgaGFyZCBzdG9wLlxuICovXG5leHBvcnQgY2xhc3MgTW9kZWxQb2xpY3lEaXNwYXRjaEJsb2NrZWRFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgcmVhZG9ubHkgdW5pdFR5cGU6IHN0cmluZztcbiAgcmVhZG9ubHkgdW5pdElkOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHJlYXNvbnM6IFJlYWRvbmx5QXJyYXk8eyBwcm92aWRlcjogc3RyaW5nOyBtb2RlbElkOiBzdHJpbmc7IHJlYXNvbjogc3RyaW5nIH0+O1xuICBjb25zdHJ1Y3RvcihcbiAgICB1bml0VHlwZTogc3RyaW5nLFxuICAgIHVuaXRJZDogc3RyaW5nLFxuICAgIHJlYXNvbnM6IFJlYWRvbmx5QXJyYXk8eyBwcm92aWRlcjogc3RyaW5nOyBtb2RlbElkOiBzdHJpbmc7IHJlYXNvbjogc3RyaW5nIH0+LFxuICApIHtcbiAgICBjb25zdCBzdW1tYXJ5ID0gcmVhc29ucy5sZW5ndGggPT09IDBcbiAgICAgID8gXCJubyBjYW5kaWRhdGUgbW9kZWxzXCJcbiAgICAgIDogcmVhc29uc1xuICAgICAgICAgIC5zbGljZSgwLCA0KVxuICAgICAgICAgIC5tYXAoKHIpID0+IGAke3IucHJvdmlkZXJ9LyR7ci5tb2RlbElkfSAoJHtyLnJlYXNvbn0pYClcbiAgICAgICAgICAuam9pbihcIjsgXCIpO1xuICAgIHN1cGVyKGBNb2RlbCBwb2xpY3kgZGVuaWVkIGRpc3BhdGNoIGZvciAke3VuaXRUeXBlfS8ke3VuaXRJZH0gYmVmb3JlIHByb21wdCBzZW5kLiBSZWplY3RlZDogJHtzdW1tYXJ5fWApO1xuICAgIHRoaXMubmFtZSA9IFwiTW9kZWxQb2xpY3lEaXNwYXRjaEJsb2NrZWRFcnJvclwiO1xuICAgIHRoaXMudW5pdFR5cGUgPSB1bml0VHlwZTtcbiAgICB0aGlzLnVuaXRJZCA9IHVuaXRJZDtcbiAgICB0aGlzLnJlYXNvbnMgPSByZWFzb25zO1xuICB9XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgTW9kZWxTZWxlY3Rpb25SZXN1bHQge1xuICAvKiogUm91dGluZyBtZXRhZGF0YSBmb3IgbWV0cmljcyByZWNvcmRpbmcgKi9cbiAgcm91dGluZzogeyB0aWVyOiBzdHJpbmc7IG1vZGVsRG93bmdyYWRlZDogYm9vbGVhbiB9IHwgbnVsbDtcbiAgLyoqIENvbmNyZXRlIG1vZGVsIGFwcGxpZWQgYmVmb3JlIGRpc3BhdGNoIHNvIGl0IGNhbiBiZSByZXN0b3JlZCBhZnRlciBhIGZyZXNoIHNlc3Npb24uICovXG4gIGFwcGxpZWRNb2RlbDogTW9kZWw8QXBpPiB8IG51bGw7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUHJlZmVycmVkTW9kZWxDb25maWcge1xuICBwcmltYXJ5OiBzdHJpbmc7XG4gIGZhbGxiYWNrczogc3RyaW5nW107XG4gIHNvdXJjZTogXCJleHBsaWNpdFwiIHwgXCJzeW50aGVzaXplZFwiO1xufVxuXG4vLyBCYXNlbGluZSBhY3RpdmUtdG9vbCBzZXQgcGVyLWBwaWAgaW5zdGFuY2UsIGNhcHR1cmVkIHRoZSBmaXJzdCB0aW1lXG4vLyBgc2VsZWN0QW5kQXBwbHlNb2RlbGAgcnVucyBhZ2FpbnN0IHRoYXQgaW5zdGFuY2UgZHVyaW5nIGFuIGF1dG8gc2Vzc2lvblxuLy8gYW5kIHJlLWFwcGxpZWQgYmVmb3JlIGVhY2ggc3Vic2VxdWVudCBkaXNwYXRjaC4gIFdlYWtNYXAgc28gdGhhdCB0ZXN0XG4vLyBmYWtlcyAvIGRpc3Bvc2VkIHNlc3Npb25zIGFyZSBnYXJiYWdlLWNvbGxlY3RlZCBub3JtYWxseS4gIFNlZVxuLy8gIzQ5NTkgLyAjNDY4MSBjcm9zcy11bml0IHBvaXNvbmluZyBub3RlcyBhdCB0aGUgY2FsbCBzaXRlIGJlbG93LlxuLy9cbi8vIExJRkVDWUNMRTogdGhlIGJhc2VsaW5lIGlzIHRpZWQgdG8gYSBzaW5nbGUgYXV0byBzZXNzaW9uLCBOT1QgdG8gdGhlXG4vLyBsaWZldGltZSBvZiB0aGUgYHBpYCBpbnN0YW5jZSAod2hpY2ggY2FuIG91dGxpdmUgbWFueSBhdXRvIHJ1bnMgYW5kIGhhdmVcbi8vIHRoZSB1c2VyIG11dGF0ZSB0b29scyBiZXR3ZWVuIHRoZW0pLiAgYGNsZWFyVG9vbEJhc2VsaW5lYCBNVVNUIGJlIGNhbGxlZFxuLy8gYXQgYXV0byBzdGFydCBBTkQgYXV0byBzdG9wIHNvIHRoYXQgYSBzZWNvbmQgYC9nc2QgYXV0b2AgcnVuIG9uIHRoZSBzYW1lXG4vLyBgcGlgIGRvZXMgbm90IHNpbGVudGx5IHJlc3RvcmUgYSBzdGFsZSBzbmFwc2hvdCBmcm9tIHRoZSBwcmlvciBydW4gYW5kXG4vLyB1bmRvIGFueSB0b29sIGNoYW5nZXMgdGhlIHVzZXIgbWFkZSBiZXR3ZWVuIHNlc3Npb25zLlxuY29uc3QgVE9PTF9CQVNFTElORSA9IG5ldyBXZWFrTWFwPG9iamVjdCwgc3RyaW5nW10+KCk7XG5cbi8qKlxuICogRHJvcCB0aGUgY2FwdHVyZWQgdG9vbCBiYXNlbGluZSBmb3IgYHBpYCBzbyB0aGUgbmV4dCBgc2VsZWN0QW5kQXBwbHlNb2RlbGBcbiAqIGNhbGwgcmUtY2FwdHVyZXMgZnJvbSB0aGUgbGl2ZSBhY3RpdmUgc2V0LiAgV2lyZWQgaW50byBgc3RhcnRBdXRvYCBhbmRcbiAqIGBzdG9wQXV0b2AgaW4gYGF1dG8udHNgIHRvIGJvdW5kIHRoZSBiYXNlbGluZSB0byBhIHNpbmdsZSBhdXRvIHNlc3Npb24uXG4gKlxuICogU2FmZSB0byBjYWxsIHdoZW4gbm8gYmFzZWxpbmUgaXMgcmVjb3JkZWQgKG5vLW9wKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNsZWFyVG9vbEJhc2VsaW5lKHBpOiBFeHRlbnNpb25BUEkgfCBvYmplY3QpOiB2b2lkIHtcbiAgVE9PTF9CQVNFTElORS5kZWxldGUocGkgYXMgdW5rbm93biBhcyBvYmplY3QpO1xufVxuXG5mdW5jdGlvbiByZXN0b3JlVG9vbEJhc2VsaW5lKHBpOiBFeHRlbnNpb25BUEkpOiB2b2lkIHtcbiAgY29uc3Qga2V5ID0gcGkgYXMgdW5rbm93biBhcyBvYmplY3Q7XG4gIGNvbnN0IGJhc2VsaW5lID0gVE9PTF9CQVNFTElORS5nZXQoa2V5KTtcbiAgaWYgKGJhc2VsaW5lID09PSB1bmRlZmluZWQpIHtcbiAgICAvLyBGaXJzdCBjYWxsOiBjYXB0dXJlIHRoZSBjYW5vbmljYWwgcHJlLWRpc3BhdGNoIHRvb2wgc2V0LiAgQXQgYXV0by1tb2RlXG4gICAgLy8gc3RhcnQgdGhlIGFjdGl2ZSBzZXQgaGFzIG5vdCB5ZXQgYmVlbiBuYXJyb3dlZCBmb3IgYW55IHByb3ZpZGVyLlxuICAgIC8vIEd1YXJkZWQgYWdhaW5zdCB0ZXN0IGZha2VzIHRoYXQgb21pdCBnZXRBY3RpdmVUb29scyBcdTIwMTQgcmVjb3JkIGFuIGVtcHR5XG4gICAgLy8gYmFzZWxpbmUgc28gc3Vic2VxdWVudCBjYWxscyBkb24ndCBrZWVwIHJlLXByb2JpbmcuXG4gICAgY29uc3QgaW5pdGlhbCA9IHR5cGVvZiBwaS5nZXRBY3RpdmVUb29scyA9PT0gXCJmdW5jdGlvblwiID8gcGkuZ2V0QWN0aXZlVG9vbHMoKSA6IFtdO1xuICAgIFRPT0xfQkFTRUxJTkUuc2V0KGtleSwgWy4uLmluaXRpYWxdKTtcbiAgICByZXR1cm47XG4gIH1cbiAgLy8gUmVzdG9yZSBiYXNlbGluZSBiZWZvcmUgdGhlIG5leHQgdW5pdCByZWFkcyBnZXRBY3RpdmVUb29scyAvIGFwcGxpZXNcbiAgLy8gcG9zdC1zZWxlY3Rpb24gYWRqdXN0VG9vbFNldC4gIE9sZGVyIGZha2VzIHRoYXQgb21pdCBzZXRBY3RpdmVUb29scyBhcmVcbiAgLy8gdG9sZXJhdGVkIFx1MjAxNCB0aGUgdGVzdCBhc3NlcnRzIGNhbGwgb3JkZXIgb24gcmVhbCBmYWtlcy5cbiAgaWYgKHR5cGVvZiBwaS5zZXRBY3RpdmVUb29scyA9PT0gXCJmdW5jdGlvblwiKSB7XG4gICAgcGkuc2V0QWN0aXZlVG9vbHMoWy4uLmJhc2VsaW5lXSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gcmVhcHBseVRoaW5raW5nTGV2ZWwoXG4gIHBpOiBFeHRlbnNpb25BUEksXG4gIGxldmVsOiBSZXR1cm5UeXBlPEV4dGVuc2lvbkFQSVtcImdldFRoaW5raW5nTGV2ZWxcIl0+IHwgbnVsbCB8IHVuZGVmaW5lZCxcbik6IHZvaWQge1xuICBpZiAoIWxldmVsKSByZXR1cm47XG4gIHBpLnNldFRoaW5raW5nTGV2ZWwobGV2ZWwpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZVByZWZlcnJlZE1vZGVsQ29uZmlnKFxuICB1bml0VHlwZTogc3RyaW5nLFxuICBhdXRvTW9kZVN0YXJ0TW9kZWw6IHsgcHJvdmlkZXI6IHN0cmluZzsgaWQ6IHN0cmluZzsgZmxhdFJhdGVDdHg/OiBGbGF0UmF0ZUNvbnRleHQgfSB8IG51bGwsXG4gIGlzQXV0b01vZGUgPSB0cnVlLFxuKTogUHJlZmVycmVkTW9kZWxDb25maWcgfCB1bmRlZmluZWQge1xuICBjb25zdCBleHBsaWNpdENvbmZpZyA9IHJlc29sdmVNb2RlbFdpdGhGYWxsYmFja3NGb3JVbml0KHVuaXRUeXBlKTtcbiAgaWYgKGV4cGxpY2l0Q29uZmlnKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIC4uLmV4cGxpY2l0Q29uZmlnLFxuICAgICAgc291cmNlOiBcImV4cGxpY2l0XCIsXG4gICAgfTtcbiAgfVxuXG4gIC8vIEluIGludGVyYWN0aXZlIG1vZGUsIGRvbid0IHN5bnRoZXNpemUgYSByb3V0aW5nLWJhc2VkIG1vZGVsIGNvbmZpZy5cbiAgLy8gVGhlIHVzZXIncyBzZXNzaW9uIG1vZGVsICgvbW9kZWwpIHNob3VsZCBiZSB1c2VkIGFzLWlzICgjMzk2MikuXG4gIGlmICghaXNBdXRvTW9kZSkgcmV0dXJuIHVuZGVmaW5lZDtcblxuICBjb25zdCByb3V0aW5nQ29uZmlnID0gcmVzb2x2ZUR5bmFtaWNSb3V0aW5nQ29uZmlnKCk7XG4gIGlmICghcm91dGluZ0NvbmZpZy5lbmFibGVkIHx8ICFyb3V0aW5nQ29uZmlnLnRpZXJfbW9kZWxzKSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gIC8vIERvbid0IHN5bnRoZXNpemUgYSByb3V0aW5nIGNvbmZpZyBmb3IgZmxhdC1yYXRlIHByb3ZpZGVycyAoIzM0NTMpLlxuICAvLyBVc2VycyBjYW4gb3B0IGludG8gcm91dGluZyBmb3IgZmxhdC1yYXRlIHN1YnNjcmlwdGlvbnMgKGUuZy4gY2xhdWRlLWNvZGUpXG4gIC8vIHZpYSBkeW5hbWljX3JvdXRpbmcuYWxsb3dfZmxhdF9yYXRlX3Byb3ZpZGVycyAoIzQzODYpLlxuICBpZiAoXG4gICAgIXJvdXRpbmdDb25maWcuYWxsb3dfZmxhdF9yYXRlX3Byb3ZpZGVycyAmJlxuICAgIGF1dG9Nb2RlU3RhcnRNb2RlbCAmJlxuICAgIGlzRmxhdFJhdGVQcm92aWRlcihhdXRvTW9kZVN0YXJ0TW9kZWwucHJvdmlkZXIsIGF1dG9Nb2RlU3RhcnRNb2RlbC5mbGF0UmF0ZUN0eClcbiAgKSB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuXG4gIGNvbnN0IGNlaWxpbmdNb2RlbCA9IHJvdXRpbmdDb25maWcudGllcl9tb2RlbHMuaGVhdnlcbiAgICA/PyAoYXV0b01vZGVTdGFydE1vZGVsID8gYCR7YXV0b01vZGVTdGFydE1vZGVsLnByb3ZpZGVyfS8ke2F1dG9Nb2RlU3RhcnRNb2RlbC5pZH1gIDogdW5kZWZpbmVkKTtcbiAgaWYgKCFjZWlsaW5nTW9kZWwpIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgcmV0dXJuIHtcbiAgICBwcmltYXJ5OiBjZWlsaW5nTW9kZWwsXG4gICAgZmFsbGJhY2tzOiBbXSxcbiAgICBzb3VyY2U6IFwic3ludGhlc2l6ZWRcIixcbiAgfTtcbn1cblxuLyoqXG4gKiBTZWxlY3QgYW5kIGFwcGx5IHRoZSBhcHByb3ByaWF0ZSBtb2RlbCBmb3IgYSB1bml0IGRpc3BhdGNoLlxuICogSGFuZGxlczogcGVyLXVuaXQtdHlwZSBtb2RlbCBwcmVmZXJlbmNlcywgZHluYW1pYyBjb21wbGV4aXR5IHJvdXRpbmcsXG4gKiBwcm92aWRlci9tb2RlbCByZXNvbHV0aW9uLCBmYWxsYmFjayBjaGFpbnMsIGFuZCBzdGFydC1tb2RlbCByZS1hcHBsaWNhdGlvbi5cbiAqXG4gKiBSZXR1cm5zIHJvdXRpbmcgbWV0YWRhdGEgZm9yIG1ldHJpY3MgdHJhY2tpbmcuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzZWxlY3RBbmRBcHBseU1vZGVsKFxuICBjdHg6IEV4dGVuc2lvbkNvbnRleHQsXG4gIHBpOiBFeHRlbnNpb25BUEksXG4gIHVuaXRUeXBlOiBzdHJpbmcsXG4gIHVuaXRJZDogc3RyaW5nLFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICBwcmVmczogR1NEUHJlZmVyZW5jZXMgfCB1bmRlZmluZWQsXG4gIHZlcmJvc2U6IGJvb2xlYW4sXG4gIGF1dG9Nb2RlU3RhcnRNb2RlbDogeyBwcm92aWRlcjogc3RyaW5nOyBpZDogc3RyaW5nOyBmbGF0UmF0ZUN0eD86IEZsYXRSYXRlQ29udGV4dCB9IHwgbnVsbCxcbiAgcmV0cnlDb250ZXh0PzogeyBpc1JldHJ5OiBib29sZWFuOyBwcmV2aW91c1RpZXI/OiBzdHJpbmcgfSxcbiAgLyoqIFdoZW4gZmFsc2UgKGludGVyYWN0aXZlL2d1aWRlZC1mbG93KSwgc2tpcCBkeW5hbWljIHJvdXRpbmcgYW5kIHVzZSB0aGUgc2Vzc2lvbiBtb2RlbC5cbiAgICogIER5bmFtaWMgcm91dGluZyBvbmx5IGFwcGxpZXMgaW4gYXV0by1tb2RlIHdoZXJlIGNvc3Qgb3B0aW1pemF0aW9uIGlzIGV4cGVjdGVkLiAoIzM5NjIpICovXG4gIGlzQXV0b01vZGUgPSB0cnVlLFxuICAvKiogRXhwbGljaXQgL2dzZCBtb2RlbCBwaW4gY2FwdHVyZWQgYXQgYm9vdHN0cmFwIGZvciBsb25nLXJ1bm5pbmcgYXV0byBsb29wcy4gKi9cbiAgc2Vzc2lvbk1vZGVsT3ZlcnJpZGU/OiB7IHByb3ZpZGVyOiBzdHJpbmc7IGlkOiBzdHJpbmcgfSB8IG51bGwsXG4gIC8qKiBUaGlua2luZyBsZXZlbCBjYXB0dXJlZCBhdCBhdXRvLW1vZGUgc3RhcnQgYW5kIHJlLWFwcGxpZWQgYWZ0ZXIgbW9kZWwgc3dhcHMuICovXG4gIGF1dG9Nb2RlU3RhcnRUaGlua2luZ0xldmVsPzogUmV0dXJuVHlwZTxFeHRlbnNpb25BUElbXCJnZXRUaGlua2luZ0xldmVsXCJdPiB8IG51bGwsXG4pOiBQcm9taXNlPE1vZGVsU2VsZWN0aW9uUmVzdWx0PiB7XG4gIGNvbnN0IHVva0ZsYWdzID0gcmVzb2x2ZVVva0ZsYWdzKHByZWZzKTtcbiAgY29uc3QgZWZmZWN0aXZlU2Vzc2lvbk1vZGVsT3ZlcnJpZGUgPSBzZXNzaW9uTW9kZWxPdmVycmlkZSA9PT0gdW5kZWZpbmVkXG4gICAgPyBnZXRTZXNzaW9uTW9kZWxPdmVycmlkZShjdHguc2Vzc2lvbk1hbmFnZXIuZ2V0U2Vzc2lvbklkKCkpXG4gICAgOiAoc2Vzc2lvbk1vZGVsT3ZlcnJpZGUgPz8gdW5kZWZpbmVkKTtcbiAgLy8gRW5yaWNoIHRoZSBzdGFydCBtb2RlbCB3aXRoIGEgZmxhdC1yYXRlIGNvbnRleHQgdXAgZnJvbnQgc28gcm91dGluZ1xuICAvLyBzeW50aGVzaXMgYW5kIHRoZSBkaXNwYXRjaC10aW1lIGd1YXJkIHNlZSB0aGUgc2FtZSBzaWduYWxzIChidWlsdC1pblxuICAvLyBsaXN0ICsgdXNlciBgZmxhdF9yYXRlX3Byb3ZpZGVyc2AgcHJlZmVyZW5jZSArIGV4dGVybmFsQ2xpIGF1dG8tXG4gIC8vIGRldGVjdGlvbikuICBUaGUgZGlzcGF0Y2gtdGltZSBwcmltYXJ5LW1vZGVsIGNoZWNrIGJlbG93IGJ1aWxkcyBpdHNcbiAgLy8gb3duIHBlci1wcm92aWRlciBjb250ZXh0IHdoZW4gaXQgaGFzIGEgcmVzb2x2ZWQgcHJpbWFyeSBtb2RlbC5cbiAgaWYgKGF1dG9Nb2RlU3RhcnRNb2RlbCkge1xuICAgIGF1dG9Nb2RlU3RhcnRNb2RlbCA9IHtcbiAgICAgIC4uLmF1dG9Nb2RlU3RhcnRNb2RlbCxcbiAgICAgIGZsYXRSYXRlQ3R4OiBidWlsZEZsYXRSYXRlQ29udGV4dChhdXRvTW9kZVN0YXJ0TW9kZWwucHJvdmlkZXIsIGN0eCwgcHJlZnMpLFxuICAgIH07XG4gIH1cbiAgY29uc3QgbW9kZWxDb25maWcgPSBlZmZlY3RpdmVTZXNzaW9uTW9kZWxPdmVycmlkZVxuICAgID8gdW5kZWZpbmVkXG4gICAgOiByZXNvbHZlUHJlZmVycmVkTW9kZWxDb25maWcodW5pdFR5cGUsIGF1dG9Nb2RlU3RhcnRNb2RlbCwgaXNBdXRvTW9kZSk7XG4gIGxldCByb3V0aW5nOiB7IHRpZXI6IHN0cmluZzsgbW9kZWxEb3duZ3JhZGVkOiBib29sZWFuIH0gfCBudWxsID0gbnVsbDtcbiAgbGV0IGFwcGxpZWRNb2RlbDogTW9kZWw8QXBpPiB8IG51bGwgPSBudWxsO1xuXG4gIC8vIFx1MjUwMFx1MjUwMCBSZXN0b3JlIGFjdGl2ZS10b29sIGJhc2VsaW5lIGJlZm9yZSBwb2xpY3kgZXZhbHVhdGlvbiAoIzQ5NTksICM0NjgxLCAjNDg1MCkgXHUyNTAwXHUyNTAwXG4gIC8vIFBlci11bml0IG5hcnJvd2luZyBhdCB0aGUgYm90dG9tIG9mIHRoaXMgZnVuY3Rpb24gKGxpbmUgfjQxNykgY2FsbHNcbiAgLy8gYHBpLnNldEFjdGl2ZVRvb2xzKGZpbmFsVG9vbE5hbWVzKWAgYW5kIG1vbm90b25pY2FsbHkgbmFycm93cyB0aGUgYWN0aXZlXG4gIC8vIHNldCBhY3Jvc3MgdW5pdHMuICBXaXRob3V0IHJlc3RvcmF0aW9uLCBhIHByZXZpb3VzbHktZGlzcGF0Y2hlZCB1bml0IG9uIGFcbiAgLy8gbmFycm93LUFQSSBwcm92aWRlciAoZS5nLiBvcGVuYWktY29tcGxldGlvbnMpIGxlYXZlcyB0aGUgYWN0aXZlIHNldFxuICAvLyBtaXNzaW5nIHRvb2xzIHRoYXQgdGhlIG5leHQgdW5pdCdzIHNlbGVjdGVkIG1vZGVsIGZ1bGx5IHN1cHBvcnRzLCBidXRcbiAgLy8gYHBpLmdldEFjdGl2ZVRvb2xzKClgIHNuYXBzaG90LWFzLWhhcmQtZ2F0ZSAodGhlIG9sZCBiZWhhdmlvdXIpIGJsb2NrZWRcbiAgLy8gZGlzcGF0Y2ggd2l0aCBcInRvb2wgcG9saWN5IGRlbmllZFwiIGFueXdheS5cbiAgLy9cbiAgLy8gVGhlIGJhc2VsaW5lIGlzIGNhcHR1cmVkIG9uY2UgcGVyIGBwaWAgaW5zdGFuY2UgdmlhIGEgV2Vha01hcCBhbmRcbiAgLy8gcmUtYXBwbGllZCBoZXJlIHNvIGVhY2ggdW5pdCBzdGFydHMgZnJvbSBhIGNsZWFuIHNsYXRlLiAgU29mdCBhZGFwdGF0aW9uXG4gIC8vIChhZGp1c3RUb29sU2V0IGF0IHRoZSBib3R0b20gb2YgdGhpcyBmdW5jdGlvbikgc3RpbGwgdHJpbXMgZm9yIHRoZVxuICAvLyBzZWxlY3RlZCBtb2RlbC5cbiAgLy9cbiAgLy8gQXV0by1tb2RlIG9ubHkgKCM0OTY1KTogYGd1aWRlZC1mbG93LnRzOmRpc3BhdGNoV29ya2Zsb3dgIGFsc28gY2FsbHNcbiAgLy8gYHNlbGVjdEFuZEFwcGx5TW9kZWxgIHdpdGggYGlzQXV0b01vZGU9ZmFsc2VgLiBHdWlkZWQtZmxvdyBoYXMgaXRzIG93blxuICAvLyBuYXJyb3cvcmVzdG9yZSB2aWEgZGlzY3Vzcy10b29sLXNjb3BpbmcgKGd1aWRlZC1mbG93LnRzOjU4Ny02MjIpIGFuZCBub1xuICAvLyBiYXNlbGluZS1jbGVhciBob29rIG9mIGl0cyBvd24sIHNvIGFuIHVuY29uZGl0aW9uYWwgcmVzdG9yZSBoZXJlIHdvdWxkXG4gIC8vIHJlc3VycmVjdCBhbiBhdXRvLWVyYSBiYXNlbGluZSBvbiBndWlkZWQtZmxvdyBkaXNwYXRjaGVzIFx1MjAxNCBzaWxlbnRseVxuICAvLyBvdmVyd3JpdGluZyBhbnkgdG9vbCBjaGFuZ2VzIG1hZGUgaW50ZXJhY3RpdmVseSBiZXR3ZWVuIGF1dG8gc2Vzc2lvbnMuXG4gIC8vIFRoZSBiYXNlbGluZSBpcyBzdHJ1Y3R1cmFsbHkgYW4gYXV0by1tb2RlIGNvbmNlcHQ7IGdhdGUgaXQgYWNjb3JkaW5nbHkuXG4gIGlmIChpc0F1dG9Nb2RlKSByZXN0b3JlVG9vbEJhc2VsaW5lKHBpKTtcblxuICBpZiAobW9kZWxDb25maWcpIHtcbiAgICBjb25zdCBhdmFpbGFibGVNb2RlbHMgPSBjdHgubW9kZWxSZWdpc3RyeS5nZXRBdmFpbGFibGUoKTtcbiAgICBjb25zdCBtb2RlbFBvbGljeVRyYWNlSWQgPSBgbW9kZWw6JHtjdHguc2Vzc2lvbk1hbmFnZXIuZ2V0U2Vzc2lvbklkKCl9OiR7RGF0ZS5ub3coKX1gO1xuICAgIGNvbnN0IG1vZGVsUG9saWN5VHVybklkID0gYCR7dW5pdFR5cGV9OiR7dW5pdElkfWA7XG4gICAgbGV0IHBvbGljeUFsbG93ZWRNb2RlbEtleXM6IFNldDxzdHJpbmc+IHwgbnVsbCA9IG51bGw7XG5cbiAgICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgRHluYW1pYyBNb2RlbCBSb3V0aW5nIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgIC8vIER5bmFtaWMgcm91dGluZyAoY29tcGxleGl0eS1iYXNlZCBkb3duZ3JhZGluZykgb25seSBhcHBsaWVzIGluIGF1dG8tbW9kZS5cbiAgICAvLyBJbnRlcmFjdGl2ZS9ndWlkZWQtZmxvdyBkaXNwYXRjaGVzIHVzZSB0aGUgdXNlcidzIHNlc3Npb24gbW9kZWwgZGlyZWN0bHksXG4gICAgLy8gcmVzcGVjdGluZyB0aGVpciAvbW9kZWwgc2VsZWN0aW9uIHdpdGhvdXQgc2lsZW50IGRvd25ncmFkZXMgKCMzOTYyKS5cbiAgICBjb25zdCByb3V0aW5nQ29uZmlnID0gcmVzb2x2ZUR5bmFtaWNSb3V0aW5nQ29uZmlnKCk7XG4gICAgaWYgKCFpc0F1dG9Nb2RlKSB7XG4gICAgICByb3V0aW5nQ29uZmlnLmVuYWJsZWQgPSBmYWxzZTtcbiAgICB9XG4gICAgLy8gYnVybi1tYXggZGVmYXVsdHMgdG8gcXVhbGl0eS1maXJzdCBkaXNwYXRjaCAobm8gZG93bmdyYWRlIHJvdXRpbmcpLlxuICAgIGlmIChwcmVmcz8udG9rZW5fcHJvZmlsZSA9PT0gXCJidXJuLW1heFwiKSB7XG4gICAgICByb3V0aW5nQ29uZmlnLmVuYWJsZWQgPSBmYWxzZTtcbiAgICB9XG4gICAgaWYgKG1vZGVsQ29uZmlnLnNvdXJjZSA9PT0gXCJleHBsaWNpdFwiKSB7XG4gICAgICAvLyBFeHBsaWNpdCBwZXItcGhhc2UgbW9kZWwgcHJlZmVyZW5jZXMgZXhwcmVzcyBoYXJkIHVzZXIgaW50ZW50LlxuICAgICAgLy8gRHluYW1pYyByb3V0aW5nIG1heSBvbmx5IHRyZWF0IHN5bnRoZXNpemVkIHRpZXIgY2VpbGluZ3MgYXMgZG93bmdyYWRlYWJsZS5cbiAgICAgIHJvdXRpbmdDb25maWcuZW5hYmxlZCA9IGZhbHNlO1xuICAgIH1cbiAgICBsZXQgZWZmZWN0aXZlTW9kZWxDb25maWcgPSBtb2RlbENvbmZpZztcbiAgICBsZXQgcm91dGluZ1RpZXJMYWJlbCA9IFwiXCI7XG4gICAgbGV0IHJvdXRpbmdFbGlnaWJsZU1vZGVscyA9IGF2YWlsYWJsZU1vZGVscztcblxuICAgIGNvbnN0IHRhc2tNZXRhZGF0YUZvclBvbGljeSA9IHVuaXRUeXBlID09PSBcImV4ZWN1dGUtdGFza1wiXG4gICAgICA/IGV4dHJhY3RUYXNrTWV0YWRhdGEodW5pdElkLCBiYXNlUGF0aClcbiAgICAgIDogdW5kZWZpbmVkO1xuXG4gICAgbGV0IHBvbGljeURlbnlSZWFzb25zOiBBcnJheTx7IHByb3ZpZGVyOiBzdHJpbmc7IG1vZGVsSWQ6IHN0cmluZzsgcmVhc29uOiBzdHJpbmcgfT4gPSBbXTtcbiAgICBpZiAodW9rRmxhZ3MubW9kZWxQb2xpY3kpIHtcbiAgICAgIC8vIFVzZSB0aGUgd29ya2Zsb3ctc3BlYyByZXF1aXJlZC10b29sIHN1YnNldCBmb3IgdGhlIHVuaXQgdHlwZSByYXRoZXJcbiAgICAgIC8vIHRoYW4gdGhlIGxpdmUgYHBpLmdldEFjdGl2ZVRvb2xzKClgIHNuYXBzaG90ICgjNDk1OSkuICBUaGUgYWN0aXZlIHNldFxuICAgICAgLy8gaXMgcG9pc29uZWQgYnkgcGVyLXVuaXQgbmFycm93aW5nIGZvciBuYXJyb3ctQVBJIHByb3ZpZGVycyBcdTIwMTQgdXNpbmcgaXRcbiAgICAgIC8vIGFzIGEgaGFyZCBnYXRlIHByb21vdGVzIHNvZnQgYWRhcHRhdGlvbiAoYWRqdXN0VG9vbFNldCBhdCBsaW5lIH40MTcpXG4gICAgICAvLyBpbnRvIGEgbGF5ZXJpbmcgdmlvbGF0aW9uIHRoYXQgdGhyb3dzIGJlZm9yZSBkaXNwYXRjaC4gIFRoZSBzbWFsbGVyXG4gICAgICAvLyB3b3JrZmxvdy1yZXF1aXJlZCBzdWJzZXQgcmVmbGVjdHMgd2hhdCB0aGUgdW5pdCBhY3R1YWxseSBuZWVkczsgc29mdFxuICAgICAgLy8gYWRhcHRhdGlvbiBwb3N0LXNlbGVjdGlvbiBzdGlsbCB0cmltcyBwcm92aWRlci1pbmNvbXBhdGlibGUgdG9vbHMuXG4gICAgICBjb25zdCByZXF1aXJlZFRvb2xzID0gZ2V0UmVxdWlyZWRXb3JrZmxvd1Rvb2xzRm9yQXV0b1VuaXQodW5pdFR5cGUpO1xuICAgICAgY29uc3QgcG9saWN5ID0gYXBwbHlNb2RlbFBvbGljeUZpbHRlcihcbiAgICAgICAgYXZhaWxhYmxlTW9kZWxzLFxuICAgICAgICB7XG4gICAgICAgICAgYmFzZVBhdGgsXG4gICAgICAgICAgdHJhY2VJZDogbW9kZWxQb2xpY3lUcmFjZUlkLFxuICAgICAgICAgIHR1cm5JZDogbW9kZWxQb2xpY3lUdXJuSWQsXG4gICAgICAgICAgdW5pdFR5cGUsXG4gICAgICAgICAgdGFza01ldGFkYXRhOiB0YXNrTWV0YWRhdGFGb3JQb2xpY3ksXG4gICAgICAgICAgY3VycmVudFByb3ZpZGVyOiBjdHgubW9kZWw/LnByb3ZpZGVyLFxuICAgICAgICAgIGFsbG93Q3Jvc3NQcm92aWRlcjogcm91dGluZ0NvbmZpZy5jcm9zc19wcm92aWRlciAhPT0gZmFsc2UsXG4gICAgICAgICAgcmVxdWlyZWRUb29scyxcbiAgICAgICAgfSxcbiAgICAgICk7XG4gICAgICByb3V0aW5nRWxpZ2libGVNb2RlbHMgPSBwb2xpY3kuZWxpZ2libGU7XG4gICAgICBwb2xpY3lBbGxvd2VkTW9kZWxLZXlzID0gbmV3IFNldChcbiAgICAgICAgcG9saWN5LmVsaWdpYmxlLm1hcCgobSkgPT4gYCR7bS5wcm92aWRlci50b0xvd2VyQ2FzZSgpfS8ke20uaWQudG9Mb3dlckNhc2UoKX1gKSxcbiAgICAgICk7XG4gICAgICBwb2xpY3lEZW55UmVhc29ucyA9IHBvbGljeS5kZWNpc2lvbnNcbiAgICAgICAgLmZpbHRlcigoZCkgPT4gIWQuYWxsb3dlZClcbiAgICAgICAgLm1hcCgoZCkgPT4gKHsgcHJvdmlkZXI6IGQucHJvdmlkZXIsIG1vZGVsSWQ6IGQubW9kZWxJZCwgcmVhc29uOiBkLnJlYXNvbiB9KSk7XG4gICAgICBpZiAocm91dGluZ0VsaWdpYmxlTW9kZWxzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICB0aHJvdyBuZXcgTW9kZWxQb2xpY3lEaXNwYXRjaEJsb2NrZWRFcnJvcih1bml0VHlwZSwgdW5pdElkLCBwb2xpY3lEZW55UmVhc29ucyk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gRGlzYWJsZSByb3V0aW5nIGZvciBmbGF0LXJhdGUgcHJvdmlkZXJzIGxpa2UgR2l0SHViIENvcGlsb3QgKCMzNDUzKS5cbiAgICAvLyBBbGwgbW9kZWxzIGNvc3QgdGhlIHNhbWUgcGVyIHJlcXVlc3QsIHNvIGRvd25ncmFkaW5nIHRvIGEgY2hlYXBlclxuICAgIC8vIG1vZGVsIHByb3ZpZGVzIG5vIGNvc3QgYmVuZWZpdCBcdTIwMTQgaXQgb25seSBkZWdyYWRlcyBxdWFsaXR5LlxuICAgIC8vIEZhaWwtY2xvc2VkOiBpZiBwcmltYXJ5IG1vZGVsIGNhbid0IGJlIHJlc29sdmVkLCBmYWxsIGJhY2sgdG9cbiAgICAvLyBwcm92aWRlci1sZXZlbCBzaWduYWxzIHJhdGhlciB0aGFuIGFsbG93aW5nIHVud2FudGVkIGRvd25ncmFkZXMuXG4gICAgLy8gT3B0LWluOiBkeW5hbWljX3JvdXRpbmcuYWxsb3dfZmxhdF9yYXRlX3Byb3ZpZGVycyBza2lwcyB0aGUgYnlwYXNzIHNvXG4gICAgLy8gY2xhdWRlLWNvZGUgc3Vic2NyaWJlcnMgY2FuIHN0aWxsIGdldCBpbnRlbGxpZ2VudCBwZXItdGFzayBzZWxlY3Rpb25cbiAgICAvLyBhY3Jvc3MgdGhlaXIgc3Vic2NyaXB0aW9uICgjNDM4NikuXG4gICAgaWYgKHJvdXRpbmdDb25maWcuZW5hYmxlZCAmJiAhcm91dGluZ0NvbmZpZy5hbGxvd19mbGF0X3JhdGVfcHJvdmlkZXJzKSB7XG4gICAgICBjb25zdCBwcmltYXJ5TW9kZWwgPSByZXNvbHZlTW9kZWxJZChtb2RlbENvbmZpZy5wcmltYXJ5LCByb3V0aW5nRWxpZ2libGVNb2RlbHMsIGN0eC5tb2RlbD8ucHJvdmlkZXIpO1xuICAgICAgaWYgKHByaW1hcnlNb2RlbCkge1xuICAgICAgICBjb25zdCBwcmltYXJ5RmxhdFJhdGVDdHggPSBidWlsZEZsYXRSYXRlQ29udGV4dChwcmltYXJ5TW9kZWwucHJvdmlkZXIsIGN0eCwgcHJlZnMpO1xuICAgICAgICBpZiAoaXNGbGF0UmF0ZVByb3ZpZGVyKHByaW1hcnlNb2RlbC5wcm92aWRlciwgcHJpbWFyeUZsYXRSYXRlQ3R4KSkge1xuICAgICAgICAgIHJvdXRpbmdDb25maWcuZW5hYmxlZCA9IGZhbHNlO1xuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKFxuICAgICAgICAoYXV0b01vZGVTdGFydE1vZGVsICYmIGlzRmxhdFJhdGVQcm92aWRlcihhdXRvTW9kZVN0YXJ0TW9kZWwucHJvdmlkZXIsIGF1dG9Nb2RlU3RhcnRNb2RlbC5mbGF0UmF0ZUN0eCkpXG4gICAgICAgIHx8IChjdHgubW9kZWw/LnByb3ZpZGVyICYmIGlzRmxhdFJhdGVQcm92aWRlcihcbiAgICAgICAgICBjdHgubW9kZWwucHJvdmlkZXIsXG4gICAgICAgICAgYnVpbGRGbGF0UmF0ZUNvbnRleHQoY3R4Lm1vZGVsLnByb3ZpZGVyLCBjdHgsIHByZWZzKSxcbiAgICAgICAgKSlcbiAgICAgICkge1xuICAgICAgICAvLyBQcmltYXJ5IG1vZGVsIHVucmVzb2x2YWJsZSBidXQgcHJvdmlkZXIgc2lnbmFscyBpbmRpY2F0ZSBmbGF0LXJhdGUgXHUyMDE0XG4gICAgICAgIC8vIGRpc2FibGUgcm91dGluZyB0byBwcmV2ZW50IHF1YWxpdHkgZGVncmFkYXRpb24uXG4gICAgICAgIHJvdXRpbmdDb25maWcuZW5hYmxlZCA9IGZhbHNlO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChyb3V0aW5nQ29uZmlnLmVuYWJsZWQpIHtcbiAgICAgIGxldCBidWRnZXRQY3Q6IG51bWJlciB8IHVuZGVmaW5lZDtcbiAgICAgIGlmIChyb3V0aW5nQ29uZmlnLmJ1ZGdldF9wcmVzc3VyZSAhPT0gZmFsc2UpIHtcbiAgICAgICAgY29uc3QgYnVkZ2V0Q2VpbGluZyA9IHByZWZzPy5idWRnZXRfY2VpbGluZztcbiAgICAgICAgaWYgKGJ1ZGdldENlaWxpbmcgIT09IHVuZGVmaW5lZCAmJiBidWRnZXRDZWlsaW5nID4gMCkge1xuICAgICAgICAgIGNvbnN0IGN1cnJlbnRMZWRnZXIgPSBnZXRMZWRnZXIoKTtcbiAgICAgICAgICBjb25zdCB0b3RhbENvc3QgPSBjdXJyZW50TGVkZ2VyID8gZ2V0UHJvamVjdFRvdGFscyhjdXJyZW50TGVkZ2VyLnVuaXRzKS5jb3N0IDogMDtcbiAgICAgICAgICBidWRnZXRQY3QgPSB0b3RhbENvc3QgLyBidWRnZXRDZWlsaW5nO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGlzSG9vayA9IHVuaXRUeXBlLnN0YXJ0c1dpdGgoXCJob29rL1wiKTtcbiAgICAgIGNvbnN0IHNob3VsZENsYXNzaWZ5ID0gIWlzSG9vayB8fCByb3V0aW5nQ29uZmlnLmhvb2tzICE9PSBmYWxzZTtcblxuICAgICAgaWYgKHNob3VsZENsYXNzaWZ5KSB7XG4gICAgICAgIGxldCBjbGFzc2lmaWNhdGlvbiA9IGNsYXNzaWZ5VW5pdENvbXBsZXhpdHkoXG4gICAgICAgICAgdW5pdFR5cGUsXG4gICAgICAgICAgdW5pdElkLFxuICAgICAgICAgIGJhc2VQYXRoLFxuICAgICAgICAgIGJ1ZGdldFBjdCxcbiAgICAgICAgICB0YXNrTWV0YWRhdGFGb3JQb2xpY3ksXG4gICAgICAgICk7XG4gICAgICAgIGNvbnN0IGF2YWlsYWJsZU1vZGVsSWRzID0gcm91dGluZ0VsaWdpYmxlTW9kZWxzLm1hcChtID0+IGAke20ucHJvdmlkZXJ9LyR7bS5pZH1gKTtcblxuICAgICAgICAvLyBFc2NhbGF0ZSB0aWVyIG9uIHJldHJ5IHdoZW4gZXNjYWxhdGVfb25fZmFpbHVyZSBpcyBlbmFibGVkIChkZWZhdWx0OiB0cnVlKS5cbiAgICAgICAgLy8gIzQ5NzM6IERldGVybWluaXN0aWMgcG9saWN5IGVycm9ycyBhcmUgc2hvcnQtY2lyY3VpdGVkIGF0IHRoZSBwb3N0VW5pdFxuICAgICAgICAvLyBsZXZlbCAoYXV0by1wb3N0LXVuaXQudHMgd3JpdGVzIGEgcGxhY2Vob2xkZXIgYW5kIHJldHVybnMgXCJjb250aW51ZVwiKSxcbiAgICAgICAgLy8gc28gdGhpcyBjb2RlIHBhdGggb25seSBydW5zIGZvciBsZWdpdGltYXRlIG1vZGVsLXF1YWxpdHkgcmV0cmllcyB3aGVyZVxuICAgICAgICAvLyB0aWVyIGVzY2FsYXRpb24gaXMgdGhlIHJpZ2h0IHJlc3BvbnNlLlxuICAgICAgICBpZiAoXG4gICAgICAgICAgcmV0cnlDb250ZXh0Py5pc1JldHJ5ICYmXG4gICAgICAgICAgcmV0cnlDb250ZXh0LnByZXZpb3VzVGllciAmJlxuICAgICAgICAgIHJvdXRpbmdDb25maWcuZXNjYWxhdGVfb25fZmFpbHVyZSAhPT0gZmFsc2VcbiAgICAgICAgKSB7XG4gICAgICAgICAgY29uc3QgZXNjYWxhdGVkID0gZXNjYWxhdGVUaWVyKHJldHJ5Q29udGV4dC5wcmV2aW91c1RpZXIgYXMgQ29tcGxleGl0eVRpZXIpO1xuICAgICAgICAgIGlmIChlc2NhbGF0ZWQpIHtcbiAgICAgICAgICAgIGNsYXNzaWZpY2F0aW9uID0geyAuLi5jbGFzc2lmaWNhdGlvbiwgdGllcjogZXNjYWxhdGVkLCByZWFzb246IFwiZXNjYWxhdGVkIGFmdGVyIGZhaWx1cmVcIiB9O1xuICAgICAgICAgICAgLy8gQWx3YXlzIG5vdGlmeSBvbiB0aWVyIGVzY2FsYXRpb24gXHUyMDE0IG1vZGVsIGNoYW5nZXMgc2hvdWxkIGJlIHZpc2libGUgKCMzOTYyKVxuICAgICAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICAgICAgYFRpZXIgZXNjYWxhdGlvbjogJHtyZXRyeUNvbnRleHQucHJldmlvdXNUaWVyfSBcdTIxOTIgJHtlc2NhbGF0ZWR9IChyZXRyeSBhZnRlciBmYWlsdXJlKWAsXG4gICAgICAgICAgICAgIFwiaW5mb1wiLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgLy8gIzQ5NzM6IEFscmVhZHkgYXQgbWF4IHRpZXIgXHUyMDE0IGtlZXAgcHJldmlvdXNUaWVyIHJhdGhlciB0aGFuIGxldHRpbmdcbiAgICAgICAgICAgIC8vIGZyZXNoIGNsYXNzaWZpY2F0aW9uIHNpbGVudGx5IGRvd25ncmFkZSB0aGUgbW9kZWwgYmFjayB0byBhIGxvd2VyIHRpZXIuXG4gICAgICAgICAgICAvLyBXaXRob3V0IHRoaXMsIGEgbGlnaHQtc3RhcnQgdW5pdCBvbiByZXRyeSAzIHdvdWxkIHJldmVydCB0byB0aGUgbGlnaHRcbiAgICAgICAgICAgIC8vIG1vZGVsIGFmdGVyIGVzY2FsYXRpbmcgdG8gaGVhdnkgb24gcmV0cmllcyAxIGFuZCAyLlxuICAgICAgICAgICAgY29uc3QgdGllck9yZGVyOiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+ID0geyBsaWdodDogMCwgc3RhbmRhcmQ6IDEsIGhlYXZ5OiAyIH07XG4gICAgICAgICAgICBjb25zdCBwcmV2T3JkZXIgPSB0aWVyT3JkZXJbcmV0cnlDb250ZXh0LnByZXZpb3VzVGllcl0gPz8gMDtcbiAgICAgICAgICAgIGNvbnN0IGZyZXNoT3JkZXIgPSB0aWVyT3JkZXJbY2xhc3NpZmljYXRpb24udGllcl0gPz8gMDtcbiAgICAgICAgICAgIGlmIChwcmV2T3JkZXIgPiBmcmVzaE9yZGVyKSB7XG4gICAgICAgICAgICAgIGNsYXNzaWZpY2F0aW9uID0geyAuLi5jbGFzc2lmaWNhdGlvbiwgdGllcjogcmV0cnlDb250ZXh0LnByZXZpb3VzVGllciBhcyBDb21wbGV4aXR5VGllciwgcmVhc29uOiBcInJldGFpbmVkIGVzY2FsYXRlZCB0aWVyIGZyb20gcmV0cnlcIiB9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vIExvYWQgdXNlciBjYXBhYmlsaXR5IG92ZXJyaWRlcyBmcm9tIHByZWZlcmVuY2VzIChELTE3OiBkZWVwLW1lcmdlZCB3aXRoIGJ1aWx0LWluIHByb2ZpbGVzKVxuICAgICAgICBjb25zdCBjYXBhYmlsaXR5T3ZlcnJpZGVzID0gbG9hZENhcGFiaWxpdHlPdmVycmlkZXMocHJlZnMgPz8ge30pO1xuXG4gICAgICAgIC8vIEZpcmUgYmVmb3JlX21vZGVsX3NlbGVjdCBob29rIChBRFItMDA0LCBELTAzKVxuICAgICAgICAvLyBIb29rIGNhbiBvdmVycmlkZSBtb2RlbCBzZWxlY3Rpb24gZW50aXJlbHkgYnkgcmV0dXJuaW5nIHsgbW9kZWxJZCB9XG4gICAgICAgIGxldCBob29rT3ZlcnJpZGU6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICAgICAgaWYgKHJvdXRpbmdDb25maWcuaG9va3MgIT09IGZhbHNlKSB7XG4gICAgICAgICAgY29uc3QgZWxpZ2libGUgPSBnZXRFbGlnaWJsZU1vZGVscyhcbiAgICAgICAgICAgIGNsYXNzaWZpY2F0aW9uLnRpZXIsXG4gICAgICAgICAgICBhdmFpbGFibGVNb2RlbElkcyxcbiAgICAgICAgICAgIHJvdXRpbmdDb25maWcsXG4gICAgICAgICAgKTtcbiAgICAgICAgICBjb25zdCBob29rUmVzdWx0ID0gYXdhaXQgcGkuZW1pdEJlZm9yZU1vZGVsU2VsZWN0KHtcbiAgICAgICAgICAgIHVuaXRUeXBlLFxuICAgICAgICAgICAgdW5pdElkLFxuICAgICAgICAgICAgY2xhc3NpZmljYXRpb246IHtcbiAgICAgICAgICAgICAgdGllcjogY2xhc3NpZmljYXRpb24udGllcixcbiAgICAgICAgICAgICAgcmVhc29uOiBjbGFzc2lmaWNhdGlvbi5yZWFzb24sXG4gICAgICAgICAgICAgIGRvd25ncmFkZWQ6IGNsYXNzaWZpY2F0aW9uLmRvd25ncmFkZWQsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgdGFza01ldGFkYXRhOiBjbGFzc2lmaWNhdGlvbi50YXNrTWV0YWRhdGEgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQsXG4gICAgICAgICAgICBlbGlnaWJsZU1vZGVsczogZWxpZ2libGUsXG4gICAgICAgICAgICBwaGFzZUNvbmZpZzogbW9kZWxDb25maWcgPyB7XG4gICAgICAgICAgICAgIHByaW1hcnk6IG1vZGVsQ29uZmlnLnByaW1hcnksXG4gICAgICAgICAgICAgIGZhbGxiYWNrczogbW9kZWxDb25maWcuZmFsbGJhY2tzID8/IFtdLFxuICAgICAgICAgICAgfSA6IHVuZGVmaW5lZCxcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBpZiAoaG9va1Jlc3VsdD8ubW9kZWxJZCkge1xuICAgICAgICAgICAgaG9va092ZXJyaWRlID0gaG9va1Jlc3VsdC5tb2RlbElkO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByb3V0aW5nUmVzdWx0OiBSZXR1cm5UeXBlPHR5cGVvZiByZXNvbHZlTW9kZWxGb3JDb21wbGV4aXR5PjtcbiAgICAgICAgaWYgKGhvb2tPdmVycmlkZSkge1xuICAgICAgICAgIC8vIEhvb2sgb3ZlcnJpZGUgYnlwYXNzZXMgY2FwYWJpbGl0eSBzY29yaW5nIGVudGlyZWx5XG4gICAgICAgICAgcm91dGluZ1Jlc3VsdCA9IHtcbiAgICAgICAgICAgIG1vZGVsSWQ6IGhvb2tPdmVycmlkZSxcbiAgICAgICAgICAgIGZhbGxiYWNrczogW1xuICAgICAgICAgICAgICAuLi4obW9kZWxDb25maWc/LmZhbGxiYWNrcyA/PyBbXSkuZmlsdGVyKGYgPT4gZiAhPT0gaG9va092ZXJyaWRlKSxcbiAgICAgICAgICAgICAgLi4uKG1vZGVsQ29uZmlnPy5wcmltYXJ5ICYmIG1vZGVsQ29uZmlnLnByaW1hcnkgIT09IGhvb2tPdmVycmlkZSA/IFttb2RlbENvbmZpZy5wcmltYXJ5XSA6IFtdKSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICB0aWVyOiBjbGFzc2lmaWNhdGlvbi50aWVyLFxuICAgICAgICAgICAgd2FzRG93bmdyYWRlZDogaG9va092ZXJyaWRlICE9PSBtb2RlbENvbmZpZz8ucHJpbWFyeSxcbiAgICAgICAgICAgIHJlYXNvbjogYGhvb2sgb3ZlcnJpZGU6ICR7aG9va092ZXJyaWRlfWAsXG4gICAgICAgICAgICBzZWxlY3Rpb25NZXRob2Q6IFwidGllci1vbmx5XCIsXG4gICAgICAgICAgfTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICByb3V0aW5nUmVzdWx0ID0gcmVzb2x2ZU1vZGVsRm9yQ29tcGxleGl0eShcbiAgICAgICAgICAgIGNsYXNzaWZpY2F0aW9uLFxuICAgICAgICAgICAgbW9kZWxDb25maWcsXG4gICAgICAgICAgICByb3V0aW5nQ29uZmlnLFxuICAgICAgICAgICAgYXZhaWxhYmxlTW9kZWxJZHMsXG4gICAgICAgICAgICB1bml0VHlwZSxcbiAgICAgICAgICAgIGNsYXNzaWZpY2F0aW9uLnRhc2tNZXRhZGF0YSxcbiAgICAgICAgICAgIGNhcGFiaWxpdHlPdmVycmlkZXMsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChyb3V0aW5nUmVzdWx0Lndhc0Rvd25ncmFkZWQpIHtcbiAgICAgICAgICBlZmZlY3RpdmVNb2RlbENvbmZpZyA9IHtcbiAgICAgICAgICAgIHByaW1hcnk6IHJvdXRpbmdSZXN1bHQubW9kZWxJZCxcbiAgICAgICAgICAgIGZhbGxiYWNrczogcm91dGluZ1Jlc3VsdC5mYWxsYmFja3MsXG4gICAgICAgICAgICBzb3VyY2U6IG1vZGVsQ29uZmlnLnNvdXJjZSxcbiAgICAgICAgICB9O1xuICAgICAgICAgIC8vIEFsd2F5cyBub3RpZnkgb24gbW9kZWwgZG93bmdyYWRlIFx1MjAxNCB1c2VycyBzaG91bGQgc2VlIHdoZW4gdGhlaXJcbiAgICAgICAgICAvLyBtb2RlbCBzZWxlY3Rpb24gaXMgb3ZlcnJpZGRlbiwgbm90IGp1c3QgaW4gdmVyYm9zZSBtb2RlICgjMzk2MikuXG4gICAgICAgICAgaWYgKHJvdXRpbmdSZXN1bHQuc2VsZWN0aW9uTWV0aG9kID09PSBcImNhcGFiaWxpdHktc2NvcmVkXCIgJiYgcm91dGluZ1Jlc3VsdC5jYXBhYmlsaXR5U2NvcmVzKSB7XG4gICAgICAgICAgICBjb25zdCB0aWVyTGJsID0gdGllckxhYmVsKGNsYXNzaWZpY2F0aW9uLnRpZXIpO1xuICAgICAgICAgICAgY29uc3Qgc2NvcmVzID0gT2JqZWN0LmVudHJpZXMocm91dGluZ1Jlc3VsdC5jYXBhYmlsaXR5U2NvcmVzKVxuICAgICAgICAgICAgICAuc29ydCgoWywgYV0sIFssIGJdKSA9PiBiIC0gYSlcbiAgICAgICAgICAgICAgLm1hcCgoW2lkLCBzY29yZV0pID0+IGAke2lkfTogJHtzY29yZS50b0ZpeGVkKDEpfWApXG4gICAgICAgICAgICAgIC5qb2luKFwiLCBcIik7XG4gICAgICAgICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICAgICAgICBgRHluYW1pYyByb3V0aW5nIFske3RpZXJMYmx9XTogJHtyb3V0aW5nUmVzdWx0Lm1vZGVsSWR9IChjYXBhYmlsaXR5LXNjb3JlZCkgXHUyMDE0ICR7c2NvcmVzfWAsXG4gICAgICAgICAgICAgIFwiaW5mb1wiLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICAgICAgYER5bmFtaWMgcm91dGluZyBbJHt0aWVyTGFiZWwoY2xhc3NpZmljYXRpb24udGllcil9XTogJHtyb3V0aW5nUmVzdWx0Lm1vZGVsSWR9ICgke2NsYXNzaWZpY2F0aW9uLnJlYXNvbn0pYCxcbiAgICAgICAgICAgICAgXCJpbmZvXCIsXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICByb3V0aW5nVGllckxhYmVsID0gYCBbJHt0aWVyTGFiZWwoY2xhc3NpZmljYXRpb24udGllcil9XWA7XG4gICAgICAgIHJvdXRpbmcgPSB7IHRpZXI6IGNsYXNzaWZpY2F0aW9uLnRpZXIsIG1vZGVsRG93bmdyYWRlZDogcm91dGluZ1Jlc3VsdC53YXNEb3duZ3JhZGVkIH07XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgbW9kZWxzVG9UcnkgPSBbZWZmZWN0aXZlTW9kZWxDb25maWcucHJpbWFyeSwgLi4uZWZmZWN0aXZlTW9kZWxDb25maWcuZmFsbGJhY2tzXTtcbiAgICBsZXQgYXR0ZW1wdGVkUG9saWN5RWxpZ2libGUgPSBmYWxzZTtcblxuICAgIGZvciAoY29uc3QgbW9kZWxJZCBvZiBtb2RlbHNUb1RyeSkge1xuICAgICAgY29uc3QgcmVzb2x1dGlvblBvb2wgPSB1b2tGbGFncy5tb2RlbFBvbGljeSA/IHJvdXRpbmdFbGlnaWJsZU1vZGVscyA6IGF2YWlsYWJsZU1vZGVscztcbiAgICAgIGNvbnN0IG1vZGVsID0gcmVzb2x2ZU1vZGVsSWQobW9kZWxJZCwgcmVzb2x1dGlvblBvb2wsIGN0eC5tb2RlbD8ucHJvdmlkZXIpO1xuXG4gICAgICBpZiAoIW1vZGVsKSB7XG4gICAgICAgIGlmICh2ZXJib3NlKSBjdHgudWkubm90aWZ5KGBNb2RlbCAke21vZGVsSWR9IG5vdCBmb3VuZCwgdHJ5aW5nIGZhbGxiYWNrLmAsIFwiaW5mb1wiKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIGlmIChwb2xpY3lBbGxvd2VkTW9kZWxLZXlzKSB7XG4gICAgICAgIGNvbnN0IGtleSA9IGAke21vZGVsLnByb3ZpZGVyLnRvTG93ZXJDYXNlKCl9LyR7bW9kZWwuaWQudG9Mb3dlckNhc2UoKX1gO1xuICAgICAgICBpZiAoIXBvbGljeUFsbG93ZWRNb2RlbEtleXMuaGFzKGtleSkpIHtcbiAgICAgICAgICBpZiAodmVyYm9zZSkge1xuICAgICAgICAgICAgY3R4LnVpLm5vdGlmeShgTW9kZWwgcG9saWN5IGRlbmllZCAke21vZGVsLnByb3ZpZGVyfS8ke21vZGVsLmlkfTsgdHJ5aW5nIGZhbGxiYWNrLmAsIFwid2FybmluZ1wiKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgYXR0ZW1wdGVkUG9saWN5RWxpZ2libGUgPSB0cnVlO1xuICAgICAgfVxuXG4gICAgICAvLyBTa2lwIG1vZGVscyB0aGUgcHJvdmlkZXIgaGFzIHByZXZpb3VzbHkgcmVqZWN0ZWQgZm9yIHRoaXMgYWNjb3VudFxuICAgICAgLy8gKGlzc3VlICM0NTEzKS4gIFRoZSBibG9jayBpcyBwZXJzaXN0ZWQgaW4gLmdzZC9ydW50aW1lL2Jsb2NrZWQtbW9kZWxzLmpzb25cbiAgICAgIC8vIHNvIGl0IHN1cnZpdmVzIC9nc2QgYXV0byByZXN0YXJ0cyBcdTIwMTQgd2l0aG91dCB0aGlzLCB0aGUgc2FtZSBkZWFkIG1vZGVsXG4gICAgICAvLyBnZXRzIHJlc2VsZWN0ZWQgYWZ0ZXIgZXZlcnkgcmVzdGFydC5cbiAgICAgIGlmIChpc01vZGVsQmxvY2tlZChiYXNlUGF0aCwgbW9kZWwucHJvdmlkZXIsIG1vZGVsLmlkKSkge1xuICAgICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICAgIGBTa2lwcGluZyBibG9ja2VkIG1vZGVsICR7bW9kZWwucHJvdmlkZXJ9LyR7bW9kZWwuaWR9IChwcm92aWRlciByZWplY3RlZCBpdCBmb3IgdGhpcyBhY2NvdW50KS5gLFxuICAgICAgICAgIFwid2FybmluZ1wiLFxuICAgICAgICApO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgLy8gV2FybiBpZiB0aGUgSUQgaXMgYW1iaWd1b3VzIGFjcm9zcyBwcm92aWRlcnNcbiAgICAgIGlmICghbW9kZWxJZC5pbmNsdWRlcyhcIi9cIikpIHtcbiAgICAgICAgY29uc3QgcHJvdmlkZXJzID0gYXZhaWxhYmxlTW9kZWxzLmZpbHRlcihtID0+IG0uaWQgPT09IG1vZGVsSWQpLm1hcChtID0+IG0ucHJvdmlkZXIpO1xuICAgICAgICBpZiAocHJvdmlkZXJzLmxlbmd0aCA+IDEgJiYgbW9kZWwucHJvdmlkZXIgIT09IGN0eC5tb2RlbD8ucHJvdmlkZXIpIHtcbiAgICAgICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICAgICAgYE1vZGVsIElEIFwiJHttb2RlbElkfVwiIGV4aXN0cyBpbiBtdWx0aXBsZSBwcm92aWRlcnMgKCR7cHJvdmlkZXJzLmpvaW4oXCIsIFwiKX0pLiBgICtcbiAgICAgICAgICAgIGBSZXNvbHZlZCB0byAke21vZGVsLnByb3ZpZGVyfS4gVXNlIFwicHJvdmlkZXIvbW9kZWxcIiBmb3JtYXQgZm9yIGV4cGxpY2l0IHRhcmdldGluZy5gLFxuICAgICAgICAgICAgXCJ3YXJuaW5nXCIsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBjb25zdCBvayA9IGF3YWl0IHBpLnNldE1vZGVsKG1vZGVsLCB7IHBlcnNpc3Q6IGZhbHNlIH0pO1xuICAgICAgaWYgKG9rKSB7XG4gICAgICAgIGFwcGxpZWRNb2RlbCA9IG1vZGVsO1xuICAgICAgICByZWFwcGx5VGhpbmtpbmdMZXZlbChwaSwgYXV0b01vZGVTdGFydFRoaW5raW5nTGV2ZWwpO1xuXG4gICAgICAgIC8vIEFEUi0wMDU6IEFkanVzdCBhY3RpdmUgdG9vbCBzZXQgZm9yIHRoZSBzZWxlY3RlZCBtb2RlbCdzIHByb3ZpZGVyIGNhcGFiaWxpdGllcy5cbiAgICAgICAgLy8gSGFyZC1maWx0ZXIgaW5jb21wYXRpYmxlIHRvb2xzLCB0aGVuIGxldCBleHRlbnNpb25zIG92ZXJyaWRlIHZpYSBhZGp1c3RfdG9vbF9zZXQgaG9vay5cbiAgICAgICAgY29uc3QgYWN0aXZlVG9vbE5hbWVzID0gcGkuZ2V0QWN0aXZlVG9vbHMoKTtcbiAgICAgICAgY29uc3QgeyB0b29sTmFtZXM6IGNvbXBhdGlibGVUb29scywgcmVtb3ZlZFRvb2xzIH0gPSBhZGp1c3RUb29sU2V0KGFjdGl2ZVRvb2xOYW1lcywgbW9kZWwuYXBpLCBtb2RlbC5wcm92aWRlcik7XG4gICAgICAgIGxldCBmaW5hbFRvb2xOYW1lcyA9IGNvbXBhdGlibGVUb29scztcblxuICAgICAgICAvLyBGaXJlIGFkanVzdF90b29sX3NldCBob29rIFx1MjAxNCBleHRlbnNpb25zIGNhbiBvdmVycmlkZSB0aGUgZmlsdGVyZWQgdG9vbCBzZXRcbiAgICAgICAgaWYgKHJvdXRpbmdDb25maWcuaG9va3MgIT09IGZhbHNlKSB7XG4gICAgICAgICAgY29uc3QgaG9va1Jlc3VsdCA9IGF3YWl0IHBpLmVtaXRBZGp1c3RUb29sU2V0KHtcbiAgICAgICAgICAgIHNlbGVjdGVkTW9kZWxBcGk6IG1vZGVsLmFwaSxcbiAgICAgICAgICAgIHNlbGVjdGVkTW9kZWxQcm92aWRlcjogbW9kZWwucHJvdmlkZXIsXG4gICAgICAgICAgICBzZWxlY3RlZE1vZGVsSWQ6IG1vZGVsLmlkLFxuICAgICAgICAgICAgYWN0aXZlVG9vbE5hbWVzLFxuICAgICAgICAgICAgZmlsdGVyZWRUb29sczogcmVtb3ZlZFRvb2xzLFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIGlmIChob29rUmVzdWx0Py50b29sTmFtZXMpIHtcbiAgICAgICAgICAgIGZpbmFsVG9vbE5hbWVzID0gaG9va1Jlc3VsdC50b29sTmFtZXM7XG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gQXBwbHkgdGhlIGZpbHRlcmVkIHRvb2wgc2V0IGlmIGFueSB0b29scyB3ZXJlIHJlbW92ZWRcbiAgICAgICAgaWYgKHJlbW92ZWRUb29scy5sZW5ndGggPiAwIHx8IGZpbmFsVG9vbE5hbWVzLmxlbmd0aCAhPT0gYWN0aXZlVG9vbE5hbWVzLmxlbmd0aCkge1xuICAgICAgICAgIHBpLnNldEFjdGl2ZVRvb2xzKGZpbmFsVG9vbE5hbWVzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh2ZXJib3NlKSB7XG4gICAgICAgICAgY29uc3QgZmFsbGJhY2tOb3RlID0gbW9kZWxJZCA9PT0gZWZmZWN0aXZlTW9kZWxDb25maWcucHJpbWFyeVxuICAgICAgICAgICAgPyBcIlwiXG4gICAgICAgICAgICA6IGAgKGZhbGxiYWNrIGZyb20gJHtlZmZlY3RpdmVNb2RlbENvbmZpZy5wcmltYXJ5fSlgO1xuICAgICAgICAgIGNvbnN0IHBoYXNlID0gdW5pdFBoYXNlTGFiZWwodW5pdFR5cGUpO1xuICAgICAgICAgIGN0eC51aS5ub3RpZnkoYE1vZGVsIFske3BoYXNlfV0ke3JvdXRpbmdUaWVyTGFiZWx9OiAke21vZGVsLnByb3ZpZGVyfS8ke21vZGVsLmlkfSR7ZmFsbGJhY2tOb3RlfWAsIFwiaW5mb1wiKTtcbiAgICAgICAgICAvLyBBRFItMDA1OiBSZXBvcnQgdG9vbHMgZmlsdGVyZWQgZHVlIHRvIHByb3ZpZGVyIGluY29tcGF0aWJpbGl0eVxuICAgICAgICAgIGlmIChyZW1vdmVkVG9vbHMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICAgICAgYFRvb2wgY29tcGF0aWJpbGl0eTogJHtyZW1vdmVkVG9vbHMubGVuZ3RofSB0b29scyBmaWx0ZXJlZCBmb3IgJHttb2RlbC5hcGl9IFx1MjAxNCAke3JlbW92ZWRUb29scy5qb2luKFwiLCBcIil9YCxcbiAgICAgICAgICAgICAgXCJpbmZvXCIsXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBicmVhaztcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnN0IG5leHRNb2RlbCA9IG1vZGVsc1RvVHJ5W21vZGVsc1RvVHJ5LmluZGV4T2YobW9kZWxJZCkgKyAxXTtcbiAgICAgICAgaWYgKG5leHRNb2RlbCkge1xuICAgICAgICAgIGlmICh2ZXJib3NlKSBjdHgudWkubm90aWZ5KGBGYWlsZWQgdG8gc2V0IG1vZGVsICR7bW9kZWxJZH0sIHRyeWluZyAke25leHRNb2RlbH0uLi5gLCBcImluZm9cIik7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgY3R4LnVpLm5vdGlmeShgQWxsIHByZWZlcnJlZCBtb2RlbHMgdW5hdmFpbGFibGUgZm9yICR7dW5pdFR5cGV9LiBVc2luZyBkZWZhdWx0LmAsIFwid2FybmluZ1wiKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIGlmICh1b2tGbGFncy5tb2RlbFBvbGljeSAmJiBwb2xpY3lBbGxvd2VkTW9kZWxLZXlzICYmICFhdHRlbXB0ZWRQb2xpY3lFbGlnaWJsZSkge1xuICAgICAgdGhyb3cgbmV3IE1vZGVsUG9saWN5RGlzcGF0Y2hCbG9ja2VkRXJyb3IodW5pdFR5cGUsIHVuaXRJZCwgcG9saWN5RGVueVJlYXNvbnMpO1xuICAgIH1cbiAgfSBlbHNlIGlmIChhdXRvTW9kZVN0YXJ0TW9kZWwpIHtcbiAgICAvLyBObyBtb2RlbCBwcmVmZXJlbmNlIGZvciB0aGlzIHVuaXQgdHlwZSBcdTIwMTQgcmUtYXBwbHkgdGhlIG1vZGVsIGNhcHR1cmVkXG4gICAgLy8gYXQgYXV0by1tb2RlIHN0YXJ0IHRvIHByZXZlbnQgYmxlZWQgZnJvbSBzaGFyZWQgZ2xvYmFsIHNldHRpbmdzLmpzb24gKCM2NTApLlxuICAgIGNvbnN0IGF2YWlsYWJsZU1vZGVscyA9IGN0eC5tb2RlbFJlZ2lzdHJ5LmdldEF2YWlsYWJsZSgpO1xuICAgIGNvbnN0IHN0YXJ0QmxvY2tlZCA9IGlzTW9kZWxCbG9ja2VkKGJhc2VQYXRoLCBhdXRvTW9kZVN0YXJ0TW9kZWwucHJvdmlkZXIsIGF1dG9Nb2RlU3RhcnRNb2RlbC5pZCk7XG4gICAgaWYgKHN0YXJ0QmxvY2tlZCkge1xuICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgYEF1dG8tbW9kZSBzdGFydCBtb2RlbCAke2F1dG9Nb2RlU3RhcnRNb2RlbC5wcm92aWRlcn0vJHthdXRvTW9kZVN0YXJ0TW9kZWwuaWR9IGlzIGJsb2NrZWQgZm9yIHRoaXMgYWNjb3VudC4gVXNpbmcgY3VycmVudCBzZXNzaW9uIG1vZGVsIGluc3RlYWQuYCxcbiAgICAgICAgXCJ3YXJuaW5nXCIsXG4gICAgICApO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBzdGFydE1vZGVsID0gYXZhaWxhYmxlTW9kZWxzLmZpbmQoXG4gICAgICAgIG0gPT4gbS5wcm92aWRlciA9PT0gYXV0b01vZGVTdGFydE1vZGVsLnByb3ZpZGVyICYmIG0uaWQgPT09IGF1dG9Nb2RlU3RhcnRNb2RlbC5pZCxcbiAgICAgICk7XG4gICAgICBpZiAoc3RhcnRNb2RlbCkge1xuICAgICAgICBjb25zdCBvayA9IGF3YWl0IHBpLnNldE1vZGVsKHN0YXJ0TW9kZWwsIHsgcGVyc2lzdDogZmFsc2UgfSk7XG4gICAgICAgIGlmICghb2spIHtcbiAgICAgICAgICBjb25zdCBieUlkID0gYXZhaWxhYmxlTW9kZWxzLmZpbmQoXG4gICAgICAgICAgICBtID0+IG0uaWQgPT09IGF1dG9Nb2RlU3RhcnRNb2RlbC5pZCAmJiAhaXNNb2RlbEJsb2NrZWQoYmFzZVBhdGgsIG0ucHJvdmlkZXIsIG0uaWQpLFxuICAgICAgICAgICk7XG4gICAgICAgICAgaWYgKGJ5SWQpIHtcbiAgICAgICAgICAgIGNvbnN0IGZhbGxiYWNrT2sgPSBhd2FpdCBwaS5zZXRNb2RlbChieUlkLCB7IHBlcnNpc3Q6IGZhbHNlIH0pO1xuICAgICAgICAgICAgaWYgKGZhbGxiYWNrT2spIHtcbiAgICAgICAgICAgICAgYXBwbGllZE1vZGVsID0gYnlJZDtcbiAgICAgICAgICAgICAgcmVhcHBseVRoaW5raW5nTGV2ZWwocGksIGF1dG9Nb2RlU3RhcnRUaGlua2luZ0xldmVsKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgYXBwbGllZE1vZGVsID0gc3RhcnRNb2RlbDtcbiAgICAgICAgICByZWFwcGx5VGhpbmtpbmdMZXZlbChwaSwgYXV0b01vZGVTdGFydFRoaW5raW5nTGV2ZWwpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHsgcm91dGluZywgYXBwbGllZE1vZGVsIH07XG59XG5cbi8qKlxuICogUmVzb2x2ZSBhIG1vZGVsIElEIHN0cmluZyB0byBhIG1vZGVsIG9iamVjdCBmcm9tIHRoZSBhdmFpbGFibGUgbW9kZWxzIGxpc3QuXG4gKiBIYW5kbGVzIGZvcm1hdHM6IFwicHJvdmlkZXIvbW9kZWxcIiwgXCJiYXJlLWlkXCIsIFwib3JnL21vZGVsLW5hbWVcIiAoT3BlblJvdXRlcikuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlTW9kZWxJZDxUIGV4dGVuZHMgeyBpZDogc3RyaW5nOyBwcm92aWRlcjogc3RyaW5nIH0+KFxuICBtb2RlbElkOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIGF2YWlsYWJsZU1vZGVsczogVFtdLFxuICBjdXJyZW50UHJvdmlkZXI6IHN0cmluZyB8IHVuZGVmaW5lZCxcbik6IFQgfCB1bmRlZmluZWQge1xuICBpZiAoIW1vZGVsSWQpIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IHNsYXNoSWR4ID0gbW9kZWxJZC5pbmRleE9mKFwiL1wiKTtcblxuICBpZiAoc2xhc2hJZHggIT09IC0xKSB7XG4gICAgY29uc3QgbWF5YmVQcm92aWRlciA9IG1vZGVsSWQuc3Vic3RyaW5nKDAsIHNsYXNoSWR4KTtcbiAgICBjb25zdCBpZCA9IG1vZGVsSWQuc3Vic3RyaW5nKHNsYXNoSWR4ICsgMSk7XG5cbiAgICBjb25zdCBrbm93blByb3ZpZGVycyA9IG5ldyBTZXQoYXZhaWxhYmxlTW9kZWxzLm1hcChtID0+IG0ucHJvdmlkZXIudG9Mb3dlckNhc2UoKSkpO1xuICAgIGlmIChrbm93blByb3ZpZGVycy5oYXMobWF5YmVQcm92aWRlci50b0xvd2VyQ2FzZSgpKSkge1xuICAgICAgY29uc3QgbWF0Y2ggPSBhdmFpbGFibGVNb2RlbHMuZmluZChcbiAgICAgICAgbSA9PiBtLnByb3ZpZGVyLnRvTG93ZXJDYXNlKCkgPT09IG1heWJlUHJvdmlkZXIudG9Mb3dlckNhc2UoKVxuICAgICAgICAgICYmIG0uaWQudG9Mb3dlckNhc2UoKSA9PT0gaWQudG9Mb3dlckNhc2UoKSxcbiAgICAgICk7XG4gICAgICBpZiAobWF0Y2gpIHJldHVybiBtYXRjaDtcbiAgICB9XG5cbiAgICAvLyBUcnkgbWF0Y2hpbmcgdGhlIGZ1bGwgc3RyaW5nIGFzIGEgbW9kZWwgSUQgKE9wZW5Sb3V0ZXItc3R5bGUpXG4gICAgY29uc3QgbG93ZXIgPSBtb2RlbElkLnRvTG93ZXJDYXNlKCk7XG4gICAgcmV0dXJuIGF2YWlsYWJsZU1vZGVscy5maW5kKFxuICAgICAgbSA9PiBtLmlkLnRvTG93ZXJDYXNlKCkgPT09IGxvd2VyXG4gICAgICAgIHx8IGAke20ucHJvdmlkZXJ9LyR7bS5pZH1gLnRvTG93ZXJDYXNlKCkgPT09IGxvd2VyLFxuICAgICk7XG4gIH1cblxuICAvLyBCYXJlIElEIFx1MjAxNCByZXNvbHZlIHdpdGggcHJvdmlkZXIgcHJlY2VkZW5jZSB0byBhdm9pZCBzaWxlbnQgbWlzcm91dGluZy5cbiAgLy8gRXh0ZW5zaW9uIHByb3ZpZGVycyAoZS5nLiBjbGF1ZGUtY29kZSkgZXhwb3NlIHRoZSBzYW1lIG1vZGVsIElEcyBhcyB0aGVpclxuICAvLyB1cHN0cmVhbSBBUEkgcHJvdmlkZXJzIGJ1dCByb3V0ZSB0aHJvdWdoIGEgc3VicHJvY2VzcyB3aXRoIGRpZmZlcmVudFxuICAvLyBjb250ZXh0LCB0b29sIHZpc2liaWxpdHksIGFuZCBjb3N0IGNoYXJhY3RlcmlzdGljcyAoIzI5MDUpLiAgQmFyZSBJRHMgaW5cbiAgLy8gUFJFRkVSRU5DRVMubWQgbXVzdCByZXNvbHZlIHRvIHRoZSBjYW5vbmljYWwgQVBJIHByb3ZpZGVyLCBub3QgdG8gYW5cbiAgLy8gZXh0ZW5zaW9uIHdyYXBwZXIgdGhhdCBoYXBwZW5zIHRvIGJlIHRoZSBjdXJyZW50IHNlc3Npb24gcHJvdmlkZXIuXG4gIGNvbnN0IGNhbmRpZGF0ZXMgPSBhdmFpbGFibGVNb2RlbHMuZmlsdGVyKG0gPT4gbS5pZCA9PT0gbW9kZWxJZCk7XG4gIGlmIChjYW5kaWRhdGVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgaWYgKGNhbmRpZGF0ZXMubGVuZ3RoID09PSAxKSByZXR1cm4gY2FuZGlkYXRlc1swXTtcblxuICAvLyBXaGVuIHRoZSB1c2VyJ3MgY3VycmVudCBwcm92aWRlciBpcyBjbGF1ZGUtY29kZSAoc2V0IGJ5IHN0YXJ0dXAgbWlncmF0aW9uXG4gIC8vIG9yIGV4cGxpY2l0IHNlbGVjdGlvbiksIGhvbm91ciBpdCBmb3IgYmFyZSBJRHMuICBSb3V0aW5nIGJhY2sgdG8gYW50aHJvcGljXG4gIC8vIHdvdWxkIHVuZG8gdGhlIG1pZ3JhdGlvbiBhbmQgaGl0IHRoZSB0aGlyZC1wYXJ0eSBzdWJzY3JpcHRpb24gYmxvY2sgKCMzNzcyKS5cbiAgaWYgKGN1cnJlbnRQcm92aWRlciA9PT0gXCJjbGF1ZGUtY29kZVwiKSB7XG4gICAgY29uc3QgY2NNYXRjaCA9IGNhbmRpZGF0ZXMuZmluZChtID0+IG0ucHJvdmlkZXIgPT09IFwiY2xhdWRlLWNvZGVcIik7XG4gICAgaWYgKGNjTWF0Y2gpIHJldHVybiBjY01hdGNoO1xuICB9XG5cbiAgLy8gRXh0ZW5zaW9uIC8gQ0xJLXdyYXBwZXIgcHJvdmlkZXJzIHRoYXQgc2hvdWxkIG5vdCB3aW4gYmFyZS1JRCByZXNvbHV0aW9uXG4gIC8vIHdoZW4gYSBmaXJzdC1jbGFzcyBBUEkgcHJvdmlkZXIgYWxzbyBvZmZlcnMgdGhlIHNhbWUgbW9kZWwgQU5EIHRoZSB1c2VyXG4gIC8vIGhhcyBub3QgZXhwbGljaXRseSBjaG9zZW4gdGhlIGV4dGVuc2lvbiBwcm92aWRlci5cbiAgY29uc3QgRVhURU5TSU9OX1BST1ZJREVSUyA9IG5ldyBTZXQoW1wiY2xhdWRlLWNvZGVcIl0pO1xuXG4gIC8vIFByZWZlciBjdXJyZW50UHJvdmlkZXIgb25seSB3aGVuIGl0IGlzIGEgZmlyc3QtY2xhc3MgQVBJIHByb3ZpZGVyXG4gIGlmIChjdXJyZW50UHJvdmlkZXIgJiYgIUVYVEVOU0lPTl9QUk9WSURFUlMuaGFzKGN1cnJlbnRQcm92aWRlcikpIHtcbiAgICBjb25zdCBwcm92aWRlck1hdGNoID0gY2FuZGlkYXRlcy5maW5kKG0gPT4gbS5wcm92aWRlciA9PT0gY3VycmVudFByb3ZpZGVyKTtcbiAgICBpZiAocHJvdmlkZXJNYXRjaCkgcmV0dXJuIHByb3ZpZGVyTWF0Y2g7XG4gIH1cblxuICAvLyBQcmVmZXIgXCJhbnRocm9waWNcIiBhcyB0aGUgY2Fub25pY2FsIHByb3ZpZGVyIGZvciBBbnRocm9waWMgbW9kZWxzLlxuICAvLyBUcmFuc3BvcnQtc3BlY2lmaWMgdGllYnJlYWtlciAoQURSLTAxMik6IGludGVudGlvbmFsbHkga2V5cyBvbiBwcm92aWRlcixcbiAgLy8gbm90IGFwaSBcdTIwMTQgd2Ugd2FudCB0aGUgcGxhaW4gQW50aHJvcGljIHRyYW5zcG9ydCB3aGVuIG11bHRpcGxlIGFyZSBhdmFpbGFibGUuXG4gIGNvbnN0IGFudGhyb3BpY01hdGNoID0gY2FuZGlkYXRlcy5maW5kKG0gPT4gbS5wcm92aWRlciA9PT0gXCJhbnRocm9waWNcIik7XG4gIGlmIChhbnRocm9waWNNYXRjaCkgcmV0dXJuIGFudGhyb3BpY01hdGNoO1xuXG4gIC8vIEZhbGwgYmFjayB0byBmaXJzdCBub24tZXh0ZW5zaW9uIGNhbmRpZGF0ZSwgb3IgYW55IGNhbmRpZGF0ZVxuICByZXR1cm4gY2FuZGlkYXRlcy5maW5kKG0gPT4gIUVYVEVOU0lPTl9QUk9WSURFUlMuaGFzKG0ucHJvdmlkZXIpKSA/PyBjYW5kaWRhdGVzWzBdO1xufVxuXG4vKipcbiAqIEZsYXQtcmF0ZSBwcm92aWRlcnMgY2hhcmdlIHRoZSBzYW1lIHBlciByZXF1ZXN0IHJlZ2FyZGxlc3Mgb2YgbW9kZWwuXG4gKiBEeW5hbWljIHJvdXRpbmcgcHJvdmlkZXMgbm8gY29zdCBiZW5lZml0IFx1MjAxNCBpdCBvbmx5IGRlZ3JhZGVzIHF1YWxpdHkgKCMzNDUzKS5cbiAqIFVzZXMgY2FzZS1pbnNlbnNpdGl2ZSBtYXRjaGluZyB3aXRoIGFsaWFzIHN1cHBvcnQgdG8gcHJldmVudCBmYWlsLW9wZW4gb25cbiAqIHByb3ZpZGVyIG5hbWluZyB2YXJpYXRpb25zIChlLmcuIFwiY29waWxvdFwiIHZzIFwiZ2l0aHViLWNvcGlsb3RcIikuXG4gKi9cbmNvbnN0IEJVSUxUSU5fRkxBVF9SQVRFID0gbmV3IFNldChbXCJnaXRodWItY29waWxvdFwiLCBcImNvcGlsb3RcIiwgXCJjbGF1ZGUtY29kZVwiXSk7XG5cbi8qKlxuICogT3B0aW9uYWwgY29udGV4dCB0aGF0IGxldHMgY2FsbGVycyBleHRlbmQgZmxhdC1yYXRlIGRldGVjdGlvbiBiZXlvbmQgdGhlXG4gKiBoYXJkLWNvZGVkIGJ1aWx0LWluIGxpc3QuICBFaXRoZXIgc2lnbmFsIG9uIGl0cyBvd24gaXMgZW5vdWdoIHRvIGNsYXNzaWZ5XG4gKiBhIHByb3ZpZGVyIGFzIGZsYXQtcmF0ZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBGbGF0UmF0ZUNvbnRleHQge1xuICAvKipcbiAgICogQXV0aCBtb2RlIGZvciB0aGUgc3BlY2lmaWMgcHJvdmlkZXIgYmVpbmcgY2hlY2tlZCwgYXMgcmV0dXJuZWQgYnlcbiAgICogYGN0eC5tb2RlbFJlZ2lzdHJ5LmdldFByb3ZpZGVyQXV0aE1vZGUocHJvdmlkZXIpYC4gIEFueSBwcm92aWRlciB0aGF0XG4gICAqIHdyYXBzIGEgbG9jYWwgQ0xJIChleHRlcm5hbENsaSkgaXMsIGJ5IGRlZmluaXRpb24sIGEgZmxhdC1yYXRlXG4gICAqIHN1YnNjcmlwdGlvbiB3cmFwcGVyIFx1MjAxNCBldmVyeSByZXF1ZXN0IGNvc3RzIHRoZSBzYW1lIHJlZ2FyZGxlc3Mgb2ZcbiAgICogbW9kZWwsIHNvIGR5bmFtaWMgcm91dGluZyBvbmx5IGRlZ3JhZGVzIHF1YWxpdHkuXG4gICAqL1xuICBhdXRoTW9kZT86IFwiYXBpS2V5XCIgfCBcIm9hdXRoXCIgfCBcImV4dGVybmFsQ2xpXCIgfCBcIm5vbmVcIjtcbiAgLyoqXG4gICAqIENhc2UtaW5zZW5zaXRpdmUgbGlzdCBvZiBleHRyYSBwcm92aWRlciBJRHMgdGhlIHVzZXIgaGFzIGRlY2xhcmVkIGFzXG4gICAqIGZsYXQtcmF0ZSB2aWEgYHByZWZlcmVuY2VzLmZsYXRfcmF0ZV9wcm92aWRlcnNgLiAgVXNlZCBmb3IgcHJpdmF0ZVxuICAgKiBzdWJzY3JpcHRpb24tYmFja2VkIHByb3hpZXMgYW5kIGVudGVycHJpc2UtZ2F0ZWQgZGVwbG95bWVudHMgdGhhdCB0aGVcbiAgICogYnVpbHQtaW4gbGlzdCBkb2Vzbid0IGtub3cgYWJvdXQuXG4gICAqL1xuICB1c2VyRmxhdFJhdGU/OiByZWFkb25seSBzdHJpbmdbXTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzRmxhdFJhdGVQcm92aWRlcihwcm92aWRlcjogc3RyaW5nLCBvcHRzPzogRmxhdFJhdGVDb250ZXh0KTogYm9vbGVhbiB7XG4gIGNvbnN0IHAgPSBwcm92aWRlci50b0xvd2VyQ2FzZSgpO1xuICBpZiAoQlVJTFRJTl9GTEFUX1JBVEUuaGFzKHApKSByZXR1cm4gdHJ1ZTtcbiAgaWYgKG9wdHM/LnVzZXJGbGF0UmF0ZT8uc29tZShpZCA9PiBpZC50b0xvd2VyQ2FzZSgpID09PSBwKSkgcmV0dXJuIHRydWU7XG4gIGlmIChvcHRzPy5hdXRoTW9kZSA9PT0gXCJleHRlcm5hbENsaVwiKSByZXR1cm4gdHJ1ZTtcbiAgcmV0dXJuIGZhbHNlO1xufVxuXG4vKipcbiAqIEJ1aWxkIGEgRmxhdFJhdGVDb250ZXh0IGZvciBhIGdpdmVuIHByb3ZpZGVyIGZyb20gbGl2ZSBydW50aW1lIHN0YXRlLlxuICogU2FmZSB0byBjYWxsIHdoZW4gY3R4IG9yIHByZWZzIGFyZSB1bmRlZmluZWQgXHUyMDE0IG1pc3NpbmcgcGllY2VzIGFyZVxuICogdHJlYXRlZCBhcyBcIm5vIHNpZ25hbFwiLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRGbGF0UmF0ZUNvbnRleHQoXG4gIHByb3ZpZGVyOiBzdHJpbmcsXG4gIGN0eD86IHsgbW9kZWxSZWdpc3RyeT86IHsgZ2V0UHJvdmlkZXJBdXRoTW9kZT86IChwOiBzdHJpbmcpID0+IHN0cmluZyB9IH0sXG4gIHByZWZzPzogeyBmbGF0X3JhdGVfcHJvdmlkZXJzPzogcmVhZG9ubHkgc3RyaW5nW10gfSxcbik6IEZsYXRSYXRlQ29udGV4dCB7XG4gIGxldCBhdXRoTW9kZTogRmxhdFJhdGVDb250ZXh0W1wiYXV0aE1vZGVcIl07XG4gIGNvbnN0IHJlZ2lzdHJ5ID0gY3R4Py5tb2RlbFJlZ2lzdHJ5O1xuICBpZiAocmVnaXN0cnkgJiYgdHlwZW9mIHJlZ2lzdHJ5LmdldFByb3ZpZGVyQXV0aE1vZGUgPT09IFwiZnVuY3Rpb25cIikge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBtb2RlID0gcmVnaXN0cnkuZ2V0UHJvdmlkZXJBdXRoTW9kZShwcm92aWRlcik7XG4gICAgICBpZiAobW9kZSA9PT0gXCJhcGlLZXlcIiB8fCBtb2RlID09PSBcIm9hdXRoXCIgfHwgbW9kZSA9PT0gXCJleHRlcm5hbENsaVwiIHx8IG1vZGUgPT09IFwibm9uZVwiKSB7XG4gICAgICAgIGF1dGhNb2RlID0gbW9kZTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIC8vIFJlZ2lzdHJ5IGxvb2t1cCBmYWlsdXJlIG11c3QgbmV2ZXIgYnJlYWsgZmxhdC1yYXRlIGRldGVjdGlvbiBcdTIwMTRcbiAgICAgIC8vIGZhbGwgdGhyb3VnaCB3aXRoIGF1dGhNb2RlIHVuZGVmaW5lZCBhbmQgc3VyZmFjZSB0aGUgY2F1c2UuXG4gICAgICBsb2dXYXJuaW5nKFxuICAgICAgICBcImRpc3BhdGNoXCIsXG4gICAgICAgIGBmbGF0LXJhdGUgYXV0aC1tb2RlIGxvb2t1cCBmYWlsZWQgZm9yICR7cHJvdmlkZXJ9OiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gLFxuICAgICAgKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBhdXRoTW9kZSxcbiAgICB1c2VyRmxhdFJhdGU6IHByZWZzPy5mbGF0X3JhdGVfcHJvdmlkZXJzLFxuICB9O1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBVUEsU0FBUyxrQ0FBa0MsbUNBQW1DO0FBRTlFLFNBQVMsd0JBQXdCLHFCQUFxQixpQkFBaUI7QUFDdkUsU0FBUywyQkFBMkIsY0FBYyxtQkFBbUIseUJBQXlCLHFCQUE2QztBQUMzSSxTQUFTLFdBQVcsd0JBQXdCO0FBQzVDLFNBQVMsc0JBQXNCO0FBQy9CLFNBQVMsK0JBQStCO0FBQ3hDLFNBQVMsa0JBQWtCO0FBQzNCLFNBQVMsdUJBQXVCO0FBQ2hDLFNBQVMsOEJBQThCO0FBQ3ZDLFNBQVMsc0JBQXNCO0FBQy9CLFNBQVMsMkNBQTJDO0FBVTdDLE1BQU0sd0NBQXdDLE1BQU07QUFBQSxFQUNoRDtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDVCxZQUNFLFVBQ0EsUUFDQSxTQUNBO0FBQ0EsVUFBTSxVQUFVLFFBQVEsV0FBVyxJQUMvQix3QkFDQSxRQUNHLE1BQU0sR0FBRyxDQUFDLEVBQ1YsSUFBSSxDQUFDLE1BQU0sR0FBRyxFQUFFLFFBQVEsSUFBSSxFQUFFLE9BQU8sS0FBSyxFQUFFLE1BQU0sR0FBRyxFQUNyRCxLQUFLLElBQUk7QUFDaEIsVUFBTSxvQ0FBb0MsUUFBUSxJQUFJLE1BQU0sa0NBQWtDLE9BQU8sRUFBRTtBQUN2RyxTQUFLLE9BQU87QUFDWixTQUFLLFdBQVc7QUFDaEIsU0FBSyxTQUFTO0FBQ2QsU0FBSyxVQUFVO0FBQUEsRUFDakI7QUFDRjtBQTJCQSxNQUFN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V0FBVyxDQUFDO0FBS2hELE1BQUksb0JBQW9CLGVBQWU7QUFDckMsVUFBTSxVQUFVLFdBQVcsS0FBSyxPQUFLLEVBQUUsYUFBYSxhQUFhO0FBQ2pFLFFBQUksUUFBUyxRQUFPO0FBQUEsRUFDdEI7QUFLQSxRQUFNLHNCQUFzQixvQkFBSSxJQUFJLENBQUMsYUFBYSxDQUFDO0FBR25ELE1BQUksbUJBQW1CLENBQUMsb0JBQW9CLElBQUksZUFBZSxHQUFHO0FBQ2hFLFVBQU0sZ0JBQWdCLFdBQVcsS0FBSyxPQUFLLEVBQUUsYUFBYSxlQUFlO0FBQ3pFLFFBQUksY0FBZSxRQUFPO0FBQUEsRUFDNUI7QUFLQSxRQUFNLGlCQUFpQixXQUFXLEtBQUssT0FBSyxFQUFFLGFBQWEsV0FBVztBQUN0RSxNQUFJLGVBQWdCLFFBQU87QUFHM0IsU0FBTyxXQUFXLEtBQUssT0FBSyxDQUFDLG9CQUFvQixJQUFJLEVBQUUsUUFBUSxDQUFDLEtBQUssV0FBVyxDQUFDO0FBQ25GO0FBUUEsTUFBTSxvQkFBb0Isb0JBQUksSUFBSSxDQUFDLGtCQUFrQixXQUFXLGFBQWEsQ0FBQztBQXlCdkUsU0FBUyxtQkFBbUIsVUFBa0IsTUFBaUM7QUFDcEYsUUFBTSxJQUFJLFNBQVMsWUFBWTtBQUMvQixNQUFJLGtCQUFrQixJQUFJLENBQUMsRUFBRyxRQUFPO0FBQ3JDLE1BQUksTUFBTSxjQUFjLEtBQUssUUFBTSxHQUFHLFlBQVksTUFBTSxDQUFDLEVBQUcsUUFBTztBQUNuRSxNQUFJLE1BQU0sYUFBYSxjQUFlLFFBQU87QUFDN0MsU0FBTztBQUNUO0FBT08sU0FBUyxxQkFDZCxVQUNBLEtBQ0EsT0FDaUI7QUFDakIsTUFBSTtBQUNKLFFBQU0sV0FBVyxLQUFLO0FBQ3RCLE1BQUksWUFBWSxPQUFPLFNBQVMsd0JBQXdCLFlBQVk7QUFDbEUsUUFBSTtBQUNGLFlBQU0sT0FBTyxTQUFTLG9CQUFvQixRQUFRO0FBQ2xELFVBQUksU0FBUyxZQUFZLFNBQVMsV0FBVyxTQUFTLGlCQUFpQixTQUFTLFFBQVE7QUFDdEYsbUJBQVc7QUFBQSxNQUNiO0FBQUEsSUFDRixTQUFTLEtBQUs7QUFHWjtBQUFBLFFBQ0U7QUFBQSxRQUNBLHlDQUF5QyxRQUFRLEtBQUssZUFBZSxRQUFRLElBQUksVUFBVSxPQUFPLEdBQUcsQ0FBQztBQUFBLE1BQ3hHO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFDQSxTQUFPO0FBQUEsSUFDTDtBQUFBLElBQ0EsY0FBYyxPQUFPO0FBQUEsRUFDdkI7QUFDRjsiLAogICJuYW1lcyI6IFtdCn0K
