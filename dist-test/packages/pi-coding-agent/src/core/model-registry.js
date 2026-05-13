import {
  applyCapabilityPatches,
  getApiProvider,
  getEnvApiKey,
  getModels,
  getProviders,
  registerApiProvider,
  resetApiProviders
} from "@gsd/pi-ai";
import { registerOAuthProvider, resetOAuthProviders } from "@gsd/pi-ai/oauth";
import { Type } from "@sinclair/typebox";
import AjvModule from "ajv";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getAgentDir } from "../config.js";
import { ModelDiscoveryCache } from "./discovery-cache.js";
import { getDefaultTTL, getDiscoverableProviders, getDiscoveryAdapter, supportsDiscoveryForApi } from "./model-discovery.js";
import { resolveConfigValue, resolveHeaders } from "./resolve-config-value.js";
import { isLocalModel } from "./local-model-check.js";
const Ajv = AjvModule.default || AjvModule;
const ajv = new Ajv();
const OpenRouterRoutingSchema = Type.Object({
  only: Type.Optional(Type.Array(Type.String())),
  order: Type.Optional(Type.Array(Type.String()))
});
const VercelGatewayRoutingSchema = Type.Object({
  only: Type.Optional(Type.Array(Type.String())),
  order: Type.Optional(Type.Array(Type.String()))
});
const ModelCapabilitiesSchema = Type.Object({
  supportsXhigh: Type.Optional(Type.Boolean()),
  requiresToolCallId: Type.Optional(Type.Boolean()),
  supportsServiceTier: Type.Optional(Type.Boolean()),
  charsPerToken: Type.Optional(Type.Number())
});
const OpenAICompletionsCompatSchema = Type.Object({
  supportsStore: Type.Optional(Type.Boolean()),
  supportsDeveloperRole: Type.Optional(Type.Boolean()),
  supportsReasoningEffort: Type.Optional(Type.Boolean()),
  supportsUsageInStreaming: Type.Optional(Type.Boolean()),
  maxTokensField: Type.Optional(Type.Union([Type.Literal("max_completion_tokens"), Type.Literal("max_tokens")])),
  requiresToolResultName: Type.Optional(Type.Boolean()),
  requiresAssistantAfterToolResult: Type.Optional(Type.Boolean()),
  requiresThinkingAsText: Type.Optional(Type.Boolean()),
  requiresMistralToolIds: Type.Optional(Type.Boolean()),
  thinkingFormat: Type.Optional(Type.Union([Type.Literal("openai"), Type.Literal("zai"), Type.Literal("qwen")])),
  openRouterRouting: Type.Optional(OpenRouterRoutingSchema),
  vercelGatewayRouting: Type.Optional(VercelGatewayRoutingSchema)
});
const OpenAIResponsesCompatSchema = Type.Object({
  // Reserved for future use
});
const OpenAICompatSchema = Type.Union([OpenAICompletionsCompatSchema, OpenAIResponsesCompatSchema]);
const ModelDefinitionSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.Optional(Type.String({ minLength: 1 })),
  api: Type.Optional(Type.String({ minLength: 1 })),
  baseUrl: Type.Optional(Type.String({ minLength: 1 })),
  reasoning: Type.Optional(Type.Boolean()),
  input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
  cost: Type.Optional(
    Type.Object({
      input: Type.Number(),
      output: Type.Number(),
      cacheRead: Type.Number(),
      cacheWrite: Type.Number()
    })
  ),
  contextWindow: Type.Optional(Type.Number()),
  maxTokens: Type.Optional(Type.Number()),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  compat: Type.Optional(OpenAICompatSchema),
  capabilities: Type.Optional(ModelCapabilitiesSchema)
});
const ModelOverrideSchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1 })),
  reasoning: Type.Optional(Type.Boolean()),
  input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
  cost: Type.Optional(
    Type.Object({
      input: Type.Optional(Type.Number()),
      output: Type.Optional(Type.Number()),
      cacheRead: Type.Optional(Type.Number()),
      cacheWrite: Type.Optional(Type.Number())
    })
  ),
  contextWindow: Type.Optional(Type.Number()),
  maxTokens: Type.Optional(Type.Number()),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  compat: Type.Optional(OpenAICompatSchema),
  capabilities: Type.Optional(ModelCapabilitiesSchema)
});
const ProviderConfigSchema = Type.Object({
  baseUrl: Type.Optional(Type.String({ minLength: 1 })),
  apiKey: Type.Optional(Type.String({ minLength: 1 })),
  api: Type.Optional(Type.String({ minLength: 1 })),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  authHeader: Type.Optional(Type.Boolean()),
  models: Type.Optional(Type.Array(ModelDefinitionSchema)),
  modelOverrides: Type.Optional(Type.Record(Type.String(), ModelOverrideSchema))
});
const ModelsConfigSchema = Type.Object({
  providers: Type.Record(Type.String(), ProviderConfigSchema)
});
ajv.addSchema(ModelsConfigSchema, "ModelsConfig");
function emptyCustomModelsResult(error) {
  return { models: [], overrides: /* @__PURE__ */ new Map(), modelOverrides: /* @__PURE__ */ new Map(), error };
}
function mergeCompat(baseCompat, overrideCompat) {
  if (!overrideCompat) return baseCompat;
  const base = baseCompat;
  const override = overrideCompat;
  const merged = { ...base, ...override };
  const baseCompletions = base;
  const overrideCompletions = override;
  const mergedCompletions = merged;
  if (baseCompletions?.openRouterRouting || overrideCompletions.openRouterRouting) {
    mergedCompletions.openRouterRouting = {
      ...baseCompletions?.openRouterRouting,
      ...overrideCompletions.openRouterRouting
    };
  }
  if (baseCompletions?.vercelGatewayRouting || overrideCompletions.vercelGatewayRouting) {
    mergedCompletions.vercelGatewayRouting = {
      ...baseCompletions?.vercelGatewayRouting,
      ...overrideCompletions.vercelGatewayRouting
    };
  }
  return merged;
}
function applyModelOverride(model, override) {
  const result = { ...model };
  if (override.name !== void 0) result.name = override.name;
  if (override.reasoning !== void 0) result.reasoning = override.reasoning;
  if (override.input !== void 0) result.input = override.input;
  if (override.contextWindow !== void 0) result.contextWindow = override.contextWindow;
  if (override.maxTokens !== void 0) result.maxTokens = override.maxTokens;
  if (override.cost) {
    result.cost = {
      input: override.cost.input ?? model.cost.input,
      output: override.cost.output ?? model.cost.output,
      cacheRead: override.cost.cacheRead ?? model.cost.cacheRead,
      cacheWrite: override.cost.cacheWrite ?? model.cost.cacheWrite
    };
  }
  if (override.headers) {
    const resolvedHeaders = resolveHeaders(override.headers);
    result.headers = resolvedHeaders ? { ...model.headers, ...resolvedHeaders } : model.headers;
  }
  result.compat = mergeCompat(model.compat, override.compat);
  if (override.capabilities) {
    result.capabilities = { ...model.capabilities, ...override.capabilities };
  }
  return result;
}
class ModelRegistry {
  constructor(authStorage, modelsJsonPath = join(getAgentDir(), "models.json")) {
    this.authStorage = authStorage;
    this.modelsJsonPath = modelsJsonPath;
    this.models = [];
    this.discoveredModels = [];
    this.customProviderApiKeys = /* @__PURE__ */ new Map();
    this.registeredProviders = /* @__PURE__ */ new Map();
    this.disabledModelProviders = /* @__PURE__ */ new Set();
    this.loadError = void 0;
    this.discoveryCache = new ModelDiscoveryCache();
    this.authStorage.setFallbackResolver((provider) => {
      const keyConfig = this.customProviderApiKeys.get(provider);
      if (keyConfig) {
        return resolveConfigValue(keyConfig);
      }
      return getEnvApiKey(provider);
    });
    this.authStorage.onCredentialChange(() => this.refresh());
    this.loadModels();
  }
  /**
   * Reload models from disk (built-in + custom from models.json).
   */
  refresh() {
    this.customProviderApiKeys.clear();
    this.loadError = void 0;
    resetApiProviders();
    resetOAuthProviders();
    this.loadModels();
    for (const [providerName, config] of this.registeredProviders.entries()) {
      this.applyProviderConfig(providerName, config);
    }
  }
  /**
   * Get any error from loading models.json (undefined if no error).
   */
  getError() {
    return this.loadError;
  }
  loadModels() {
    const {
      models: customModels,
      overrides,
      modelOverrides,
      error
    } = this.modelsJsonPath ? this.loadCustomModels(this.modelsJsonPath) : emptyCustomModelsResult();
    if (error) {
      this.loadError = error;
    }
    const builtInModels = this.loadBuiltInModels(overrides, modelOverrides);
    let combined = this.mergeCustomModels(builtInModels, customModels);
    for (const oauthProvider of this.authStorage.getOAuthProviders()) {
      const cred = this.authStorage.get(oauthProvider.id);
      if (cred?.type === "oauth" && oauthProvider.modifyModels) {
        combined = oauthProvider.modifyModels(combined, cred);
      }
    }
    this.models = applyCapabilityPatches(combined);
  }
  /** Load built-in models and apply provider/model overrides */
  loadBuiltInModels(overrides, modelOverrides) {
    return getProviders().flatMap((provider) => {
      const models = getModels(provider);
      const providerOverride = overrides.get(provider);
      const perModelOverrides = modelOverrides.get(provider);
      return models.map((m) => {
        let model = m;
        if (providerOverride) {
          const resolvedHeaders = resolveHeaders(providerOverride.headers);
          model = {
            ...model,
            baseUrl: providerOverride.baseUrl ?? model.baseUrl,
            headers: resolvedHeaders ? { ...model.headers, ...resolvedHeaders } : model.headers
          };
        }
        const modelOverride = perModelOverrides?.get(m.id);
        if (modelOverride) {
          model = applyModelOverride(model, modelOverride);
        }
        return model;
      });
    });
  }
  /** Merge custom models into built-in list by provider+id (custom wins on conflicts). */
  mergeCustomModels(builtInModels, customModels) {
    const merged = [...builtInModels];
    for (const customModel of customModels) {
      const existingIndex = merged.findIndex((m) => m.provider === customModel.provider && m.id === customModel.id);
      if (existingIndex >= 0) {
        merged[existingIndex] = customModel;
      } else {
        merged.push(customModel);
      }
    }
    return merged;
  }
  loadCustomModels(modelsJsonPath) {
    if (!existsSync(modelsJsonPath)) {
      return emptyCustomModelsResult();
    }
    try {
      const content = readFileSync(modelsJsonPath, "utf-8");
      const config = JSON.parse(content);
      const validate = ajv.getSchema("ModelsConfig");
      if (!validate(config)) {
        const errors = validate.errors?.map((e) => `  - ${e.instancePath || "root"}: ${e.message}`).join("\n") || "Unknown schema error";
        return emptyCustomModelsResult(`Invalid models.json schema:
${errors}

File: ${modelsJsonPath}`);
      }
      this.validateConfig(config);
      const overrides = /* @__PURE__ */ new Map();
      const modelOverrides = /* @__PURE__ */ new Map();
      for (const [providerName, providerConfig] of Object.entries(config.providers)) {
        if (providerConfig.baseUrl || providerConfig.headers || providerConfig.apiKey) {
          overrides.set(providerName, {
            baseUrl: providerConfig.baseUrl,
            headers: providerConfig.headers,
            apiKey: providerConfig.apiKey
          });
        }
        if (providerConfig.apiKey) {
          this.customProviderApiKeys.set(providerName, providerConfig.apiKey);
        }
        if (providerConfig.modelOverrides) {
          modelOverrides.set(providerName, new Map(Object.entries(providerConfig.modelOverrides)));
        }
      }
      return { models: this.parseModels(config), overrides, modelOverrides, error: void 0 };
    } catch (error) {
      if (error instanceof SyntaxError) {
        return emptyCustomModelsResult(`Failed to parse models.json: ${error.message}

File: ${modelsJsonPath}`);
      }
      return emptyCustomModelsResult(
        `Failed to load models.json: ${error instanceof Error ? error.message : error}

File: ${modelsJsonPath}`
      );
    }
  }
  validateConfig(config) {
    for (const [providerName, providerConfig] of Object.entries(config.providers)) {
      const hasProviderApi = !!providerConfig.api;
      const models = providerConfig.models ?? [];
      const hasModelOverrides = providerConfig.modelOverrides && Object.keys(providerConfig.modelOverrides).length > 0;
      if (models.length === 0) {
        if (!providerConfig.baseUrl && !hasModelOverrides) {
          throw new Error(`Provider ${providerName}: must specify "baseUrl", "modelOverrides", or "models".`);
        }
      } else {
        if (!providerConfig.baseUrl) {
          throw new Error(`Provider ${providerName}: "baseUrl" is required when defining custom models.`);
        }
        if (!providerConfig.apiKey) {
          throw new Error(`Provider ${providerName}: "apiKey" is required when defining custom models.`);
        }
      }
      for (const modelDef of models) {
        const hasModelApi = !!modelDef.api;
        if (!hasProviderApi && !hasModelApi) {
          throw new Error(
            `Provider ${providerName}, model ${modelDef.id}: no "api" specified. Set at provider or model level.`
          );
        }
        if (!modelDef.id) throw new Error(`Provider ${providerName}: model missing "id"`);
        if (modelDef.contextWindow !== void 0 && modelDef.contextWindow <= 0)
          throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid contextWindow`);
        if (modelDef.maxTokens !== void 0 && modelDef.maxTokens <= 0)
          throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid maxTokens`);
      }
    }
  }
  parseModels(config) {
    const models = [];
    for (const [providerName, providerConfig] of Object.entries(config.providers)) {
      const modelDefs = providerConfig.models ?? [];
      if (modelDefs.length === 0) continue;
      if (providerConfig.apiKey) {
        this.customProviderApiKeys.set(providerName, providerConfig.apiKey);
      }
      if (!this.registeredProviders.has(providerName)) {
        this.registeredProviders.set(providerName, {
          authMode: providerConfig.apiKey ? "apiKey" : "none",
          apiKey: providerConfig.apiKey,
          baseUrl: providerConfig.baseUrl,
          isReady: providerConfig.apiKey ? () => true : void 0
        });
      }
      for (const modelDef of modelDefs) {
        const api = modelDef.api || providerConfig.api;
        if (!api) continue;
        const providerHeaders = resolveHeaders(providerConfig.headers);
        const modelHeaders = resolveHeaders(modelDef.headers);
        let headers = providerHeaders || modelHeaders ? { ...providerHeaders, ...modelHeaders } : void 0;
        if (providerConfig.authHeader && providerConfig.apiKey) {
          const resolvedKey = resolveConfigValue(providerConfig.apiKey);
          if (resolvedKey) {
            headers = { ...headers, Authorization: `Bearer ${resolvedKey}` };
          }
        }
        const defaultCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        models.push({
          id: modelDef.id,
          name: modelDef.name ?? modelDef.id,
          api,
          provider: providerName,
          baseUrl: modelDef.baseUrl ?? providerConfig.baseUrl,
          reasoning: modelDef.reasoning ?? false,
          input: modelDef.input ?? ["text"],
          cost: modelDef.cost ?? defaultCost,
          contextWindow: modelDef.contextWindow ?? 128e3,
          maxTokens: modelDef.maxTokens ?? 16384,
          headers,
          compat: modelDef.compat,
          capabilities: modelDef.capabilities
        });
      }
    }
    return models;
  }
  /**
   * Get all models (built-in + custom).
   * If models.json had errors, returns only built-in models.
   */
  getAll() {
    return this.models;
  }
  /**
   * Get only models that have auth configured.
   * This is a fast check that doesn't refresh OAuth tokens.
   */
  getAvailable() {
    return this.models.filter((m) => this.isProviderRequestReady(m.provider));
  }
  /**
   * Set provider IDs that should be excluded from model selection/routing.
   * This does not affect direct tool auth flows that resolve provider keys.
   */
  setDisabledModelProviders(providers) {
    this.disabledModelProviders = new Set(
      providers.map((provider) => provider.trim().toLowerCase()).filter((provider) => provider.length > 0)
    );
  }
  /**
   * Get current provider denylist used for model selection/routing.
   */
  getDisabledModelProviders() {
    return Array.from(this.disabledModelProviders);
  }
  /**
   * Get auth mode for a provider.
   * Defaults to "apiKey" for built-ins and providers without explicit mode.
   */
  getProviderAuthMode(provider) {
    if (provider === "gsd-fake") return "none";
    const config = this.registeredProviders.get(provider);
    if (!config) return "apiKey";
    if (config.authMode) return config.authMode;
    if (config.oauth) return "oauth";
    if (config.apiKey) return "apiKey";
    return "apiKey";
  }
  /**
   * Whether a provider can be used for requests/fallback without hard auth gating.
   */
  isProviderRequestReady(provider) {
    if (this.disabledModelProviders.has(provider.trim().toLowerCase())) return false;
    const config = this.registeredProviders.get(provider);
    if (config?.isReady) return config.isReady();
    const authMode = this.getProviderAuthMode(provider);
    if (authMode === "externalCli" || authMode === "none") return true;
    return this.authStorage.hasAuth(provider);
  }
  /**
   * Find a model by provider and ID.
   */
  find(provider, modelId) {
    return this.models.find((m) => m.provider === provider && m.id === modelId);
  }
  /**
   * Get API key for a model.
   * Returns undefined for externalCli/none providers (no key needed).
   * @param sessionId - Optional session ID for sticky credential selection
   */
  async getApiKey(model, sessionId) {
    const authMode = this.getProviderAuthMode(model.provider);
    if (authMode === "externalCli" || authMode === "none") return void 0;
    return this.authStorage.getApiKey(model.provider, sessionId, { baseUrl: model.baseUrl });
  }
  /**
   * Get API key for a provider.
   * Returns undefined for externalCli/none providers (no key needed).
   * @param sessionId - Optional session ID for sticky credential selection
   */
  async getApiKeyForProvider(provider, sessionId) {
    const authMode = this.getProviderAuthMode(provider);
    if (authMode === "externalCli" || authMode === "none") return void 0;
    return this.authStorage.getApiKey(provider, sessionId);
  }
  /**
   * Check if a model is using OAuth credentials (subscription).
   */
  isUsingOAuth(model) {
    const cred = this.authStorage.get(model.provider);
    return cred?.type === "oauth";
  }
  /**
   * Register a provider dynamically (from extensions).
   *
   * If provider has models: replaces all existing models for this provider.
   * If provider has only baseUrl/headers: overrides existing models' URLs.
   * If provider has oauth: registers OAuth provider for /login support.
   */
  registerProvider(providerName, config) {
    this.registeredProviders.set(providerName, config);
    this.applyProviderConfig(providerName, config);
  }
  /**
   * Unregister a previously registered provider.
   *
   * Removes the provider from the registry and reloads models from disk so that
   * built-in models overridden by this provider are restored to their original state.
   * Also resets dynamic OAuth and API stream registrations before reapplying
   * remaining dynamic providers.
   * Has no effect if the provider was never registered.
   */
  unregisterProvider(providerName) {
    if (!this.registeredProviders.has(providerName)) return;
    this.registeredProviders.delete(providerName);
    this.customProviderApiKeys.delete(providerName);
    this.refresh();
  }
  applyProviderConfig(providerName, config) {
    if (config.oauth) {
      const oauthProvider = {
        ...config.oauth,
        id: providerName
      };
      registerOAuthProvider(oauthProvider);
    }
    if (config.streamSimple) {
      if (!config.api) {
        throw new Error(`Provider ${providerName}: "api" is required when registering streamSimple.`);
      }
      const rawStreamSimple = config.streamSimple;
      const authMode = config.authMode ?? "apiKey";
      const streamSimple = authMode === "externalCli" || authMode === "none" ? ((model, context, options) => {
        const { apiKey: _, ...opts } = options ?? {};
        return rawStreamSimple(model, context, opts);
      }) : rawStreamSimple;
      const existingProvider = getApiProvider(config.api);
      const scopedStream = existingProvider ? (model, context, options) => {
        if (model.provider === providerName) {
          return streamSimple(model, context, options);
        }
        return existingProvider.streamSimple(model, context, options);
      } : streamSimple;
      const newFullStream = (model, context, options) => scopedStream(model, context, options);
      const scopedFullStream = existingProvider ? (model, context, options) => {
        if (model.provider === providerName) {
          return newFullStream(model, context, options);
        }
        return existingProvider.stream(model, context, options);
      } : newFullStream;
      registerApiProvider(
        {
          api: config.api,
          stream: scopedFullStream,
          streamSimple: scopedStream
        },
        `provider:${providerName}`
      );
    }
    if (config.apiKey) {
      this.customProviderApiKeys.set(providerName, config.apiKey);
    }
    if (config.models && config.models.length > 0) {
      this.models = this.models.filter((m) => m.provider !== providerName);
      if (!config.baseUrl) {
        throw new Error(`Provider ${providerName}: "baseUrl" is required when defining models.`);
      }
      const authMode = config.authMode ?? (config.oauth ? "oauth" : config.apiKey ? "apiKey" : "apiKey");
      if (authMode === "apiKey" && !config.apiKey && !config.oauth) {
        throw new Error(
          `Provider ${providerName}: "apiKey" or "oauth" is required when authMode is "apiKey" (the default). Set authMode to "externalCli" or "none" for keyless providers.`
        );
      }
      if ((authMode === "externalCli" || authMode === "none") && !config.streamSimple) {
        throw new Error(
          `Provider ${providerName}: "streamSimple" is required when authMode is "${authMode}". Keyless providers must supply their own stream handler.`
        );
      }
      if ((authMode === "externalCli" || authMode === "none") && config.apiKey) {
        throw new Error(
          `Provider ${providerName}: "apiKey" cannot be set when authMode is "${authMode}". Keyless providers should not provide API key credentials.`
        );
      }
      for (const modelDef of config.models) {
        const api = modelDef.api || config.api;
        if (!api) {
          throw new Error(`Provider ${providerName}, model ${modelDef.id}: no "api" specified.`);
        }
        const providerHeaders = resolveHeaders(config.headers);
        const modelHeaders = resolveHeaders(modelDef.headers);
        let headers = providerHeaders || modelHeaders ? { ...providerHeaders, ...modelHeaders } : void 0;
        if (config.authHeader && config.apiKey) {
          const resolvedKey = resolveConfigValue(config.apiKey);
          if (resolvedKey) {
            headers = { ...headers, Authorization: `Bearer ${resolvedKey}` };
          }
        }
        this.models.push({
          id: modelDef.id,
          name: modelDef.name,
          api,
          provider: providerName,
          baseUrl: config.baseUrl,
          reasoning: modelDef.reasoning,
          input: modelDef.input,
          cost: modelDef.cost,
          contextWindow: modelDef.contextWindow,
          maxTokens: modelDef.maxTokens,
          headers,
          compat: modelDef.compat,
          providerOptions: modelDef.providerOptions
        });
      }
      if (config.oauth?.modifyModels) {
        const cred = this.authStorage.get(providerName);
        if (cred?.type === "oauth") {
          this.models = config.oauth.modifyModels(this.models, cred);
        }
      }
      this.models = applyCapabilityPatches(this.models);
    } else if (config.baseUrl) {
      const resolvedHeaders = resolveHeaders(config.headers);
      this.models = this.models.map((m) => {
        if (m.provider !== providerName) return m;
        return {
          ...m,
          baseUrl: config.baseUrl ?? m.baseUrl,
          headers: resolvedHeaders ? { ...m.headers, ...resolvedHeaders } : m.headers
        };
      });
    }
  }
  /**
   * Discover models from all providers that support discovery.
   * Results are cached and merged into the registry (never overrides existing models).
   */
  async discoverModels(providers) {
    const targetProviders = providers ?? this.getAutoDiscoverableProviders();
    const results = [];
    for (const providerName of targetProviders) {
      const providerApis = this.getProviderApis(providerName);
      const adapter = getDiscoveryAdapter(providerName, providerApis);
      if (!adapter.supportsDiscovery) continue;
      if (!this.discoveryCache.isStale(providerName)) {
        const cached = this.discoveryCache.get(providerName);
        if (cached) {
          results.push({
            provider: providerName,
            models: cached.models,
            fetchedAt: cached.fetchedAt
          });
          continue;
        }
      }
      try {
        const apiKey = await this.authStorage.getApiKey(providerName);
        if (!apiKey && !this.isProviderRequestReady(providerName)) continue;
        const baseUrl = this.getProviderBaseUrl(providerName);
        const models = await adapter.fetchModels(apiKey ?? "", baseUrl);
        const ttlMs = this.getDiscoveryTtl(providerName, providerApis);
        this.discoveryCache.set(providerName, models, ttlMs);
        results.push({
          provider: providerName,
          models,
          fetchedAt: Date.now()
        });
      } catch (error) {
        results.push({
          provider: providerName,
          models: [],
          fetchedAt: Date.now(),
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    this.discoveredModels = applyCapabilityPatches(this.convertDiscoveredModels(results));
    return results;
  }
  /**
   * Get all models including discovered ones.
   * Discovered models are appended but never override existing models.
   */
  getAllWithDiscovered() {
    const existingIds = new Set(this.models.map((m) => `${m.provider}/${m.id}`));
    const unique = this.discoveredModels.filter((m) => !existingIds.has(`${m.provider}/${m.id}`));
    return [...this.models, ...unique];
  }
  /**
   * Check if a model was added via discovery (not built-in or custom).
   */
  isDiscovered(model) {
    return this.discoveredModels.some((m) => m.provider === model.provider && m.id === model.id);
  }
  /**
   * Get the discovery cache instance.
   */
  getDiscoveryCache() {
    return this.discoveryCache;
  }
  /**
   * Convert DiscoveryResult[] into Model<Api>[] with default values.
   */
  convertDiscoveredModels(results) {
    const converted = [];
    for (const result of results) {
      if (result.error) continue;
      const providerDefaults = this.getDiscoveryProviderDefaults(result.provider);
      for (const dm of result.models) {
        converted.push({
          id: dm.id,
          name: dm.name ?? dm.id,
          api: providerDefaults.api,
          provider: result.provider,
          baseUrl: providerDefaults.baseUrl,
          reasoning: dm.reasoning ?? false,
          input: dm.input ?? providerDefaults.input,
          cost: dm.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: dm.contextWindow ?? providerDefaults.contextWindow,
          maxTokens: dm.maxTokens ?? providerDefaults.maxTokens
        });
      }
    }
    return converted;
  }
  getProviderApis(provider) {
    const apis = /* @__PURE__ */ new Set();
    for (const model of this.models) {
      if (model.provider === provider && typeof model.api === "string" && model.api.length > 0) {
        apis.add(model.api);
      }
    }
    const providerConfig = this.registeredProviders.get(provider);
    if (providerConfig?.api) apis.add(providerConfig.api);
    for (const modelDef of providerConfig?.models ?? []) {
      if (modelDef.api) apis.add(modelDef.api);
    }
    return apis;
  }
  getAutoDiscoverableProviders() {
    const discoverable = new Set(getDiscoverableProviders());
    for (const provider of new Set(this.models.map((m) => m.provider))) {
      const apis = this.getProviderApis(provider);
      for (const api of apis) {
        if (supportsDiscoveryForApi(api)) {
          discoverable.add(provider);
          break;
        }
      }
    }
    return [...discoverable];
  }
  getProviderBaseUrl(provider) {
    const fromModels = this.models.find((m) => m.provider === provider && typeof m.baseUrl === "string" && m.baseUrl.length > 0);
    if (fromModels?.baseUrl) return fromModels.baseUrl;
    return this.registeredProviders.get(provider)?.baseUrl;
  }
  getDiscoveryProviderDefaults(provider) {
    const first = this.models.find((m) => m.provider === provider);
    if (first) {
      return {
        api: first.api,
        baseUrl: first.baseUrl,
        input: first.input,
        contextWindow: first.contextWindow,
        maxTokens: first.maxTokens
      };
    }
    return {
      api: "openai-completions",
      baseUrl: this.registeredProviders.get(provider)?.baseUrl ?? "",
      input: ["text"],
      contextWindow: 128e3,
      maxTokens: 16384
    };
  }
  getDiscoveryTtl(provider, providerApis) {
    for (const api of providerApis) {
      if (supportsDiscoveryForApi(api)) {
        return getDefaultTTL("openai");
      }
    }
    return getDefaultTTL(provider);
  }
  /**
   * Check if a model's baseUrl points to a local endpoint.
   * Delegates to standalone isLocalModel() function.
   */
  static isLocalModel(model) {
    return isLocalModel(model);
  }
  /**
   * Check if all models in the registry are local.
   * Returns true only if every model passes isLocalModel().
   * Returns false if there are no models.
   */
  isAllLocalChain() {
    const models = this.getAll();
    if (models.length === 0) return false;
    return models.every((m) => isLocalModel(m));
  }
}
export {
  ModelRegistry
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL21vZGVsLXJlZ2lzdHJ5LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIE1vZGVsIHJlZ2lzdHJ5IC0gbWFuYWdlcyBidWlsdC1pbiBhbmQgY3VzdG9tIG1vZGVscywgcHJvdmlkZXMgQVBJIGtleSByZXNvbHV0aW9uLlxuICovXG5cbmltcG9ydCB7XG5cdHR5cGUgQXBpLFxuXHRhcHBseUNhcGFiaWxpdHlQYXRjaGVzLFxuXHR0eXBlIEFzc2lzdGFudE1lc3NhZ2VFdmVudFN0cmVhbSxcblx0dHlwZSBDb250ZXh0LFxuXHRnZXRBcGlQcm92aWRlcixcblx0Z2V0RW52QXBpS2V5LFxuXHRnZXRNb2RlbHMsXG5cdGdldFByb3ZpZGVycyxcblx0dHlwZSBLbm93blByb3ZpZGVyLFxuXHR0eXBlIE1vZGVsLFxuXHR0eXBlIE9BdXRoUHJvdmlkZXJJbnRlcmZhY2UsXG5cdHR5cGUgT3BlbkFJQ29tcGxldGlvbnNDb21wYXQsXG5cdHR5cGUgT3BlbkFJUmVzcG9uc2VzQ29tcGF0LFxuXHRyZWdpc3RlckFwaVByb3ZpZGVyLFxuXHRyZXNldEFwaVByb3ZpZGVycyxcblx0dHlwZSBTaW1wbGVTdHJlYW1PcHRpb25zLFxufSBmcm9tIFwiQGdzZC9waS1haVwiO1xuaW1wb3J0IHsgcmVnaXN0ZXJPQXV0aFByb3ZpZGVyLCByZXNldE9BdXRoUHJvdmlkZXJzIH0gZnJvbSBcIkBnc2QvcGktYWkvb2F1dGhcIjtcbmltcG9ydCB7IHR5cGUgU3RhdGljLCBUeXBlIH0gZnJvbSBcIkBzaW5jbGFpci90eXBlYm94XCI7XG5pbXBvcnQgQWp2TW9kdWxlIGZyb20gXCJhanZcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMsIHJlYWRGaWxlU3luYyB9IGZyb20gXCJmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJwYXRoXCI7XG5pbXBvcnQgeyBnZXRBZ2VudERpciB9IGZyb20gXCIuLi9jb25maWcuanNcIjtcbmltcG9ydCB0eXBlIHsgQXV0aFN0b3JhZ2UgfSBmcm9tIFwiLi9hdXRoLXN0b3JhZ2UuanNcIjtcbmltcG9ydCB7IE1vZGVsRGlzY292ZXJ5Q2FjaGUgfSBmcm9tIFwiLi9kaXNjb3ZlcnktY2FjaGUuanNcIjtcbmltcG9ydCB0eXBlIHsgRGlzY292ZXJlZE1vZGVsLCBEaXNjb3ZlcnlSZXN1bHQgfSBmcm9tIFwiLi9tb2RlbC1kaXNjb3ZlcnkuanNcIjtcbmltcG9ydCB7IGdldERlZmF1bHRUVEwsIGdldERpc2NvdmVyYWJsZVByb3ZpZGVycywgZ2V0RGlzY292ZXJ5QWRhcHRlciwgc3VwcG9ydHNEaXNjb3ZlcnlGb3JBcGkgfSBmcm9tIFwiLi9tb2RlbC1kaXNjb3ZlcnkuanNcIjtcbmltcG9ydCB7IGNsZWFyQ29uZmlnVmFsdWVDYWNoZSwgcmVzb2x2ZUNvbmZpZ1ZhbHVlLCByZXNvbHZlSGVhZGVycyB9IGZyb20gXCIuL3Jlc29sdmUtY29uZmlnLXZhbHVlLmpzXCI7XG5pbXBvcnQgeyBpc0xvY2FsTW9kZWwgfSBmcm9tIFwiLi9sb2NhbC1tb2RlbC1jaGVjay5qc1wiO1xuXG5jb25zdCBBanYgPSAoQWp2TW9kdWxlIGFzIGFueSkuZGVmYXVsdCB8fCBBanZNb2R1bGU7XG5jb25zdCBhanYgPSBuZXcgQWp2KCk7XG5cbi8vIFNjaGVtYSBmb3IgT3BlblJvdXRlciByb3V0aW5nIHByZWZlcmVuY2VzXG5jb25zdCBPcGVuUm91dGVyUm91dGluZ1NjaGVtYSA9IFR5cGUuT2JqZWN0KHtcblx0b25seTogVHlwZS5PcHRpb25hbChUeXBlLkFycmF5KFR5cGUuU3RyaW5nKCkpKSxcblx0b3JkZXI6IFR5cGUuT3B0aW9uYWwoVHlwZS5BcnJheShUeXBlLlN0cmluZygpKSksXG59KTtcblxuLy8gU2NoZW1hIGZvciBWZXJjZWwgQUkgR2F0ZXdheSByb3V0aW5nIHByZWZlcmVuY2VzXG5jb25zdCBWZXJjZWxHYXRld2F5Um91dGluZ1NjaGVtYSA9IFR5cGUuT2JqZWN0KHtcblx0b25seTogVHlwZS5PcHRpb25hbChUeXBlLkFycmF5KFR5cGUuU3RyaW5nKCkpKSxcblx0b3JkZXI6IFR5cGUuT3B0aW9uYWwoVHlwZS5BcnJheShUeXBlLlN0cmluZygpKSksXG59KTtcblxuLy8gU2NoZW1hIGZvciBtb2RlbCBjYXBhYmlsaXR5IGRlY2xhcmF0aW9ucyAobWlycm9ycyBNb2RlbENhcGFiaWxpdGllcyBpbiBwaS1haSB0eXBlcylcbmNvbnN0IE1vZGVsQ2FwYWJpbGl0aWVzU2NoZW1hID0gVHlwZS5PYmplY3Qoe1xuXHRzdXBwb3J0c1hoaWdoOiBUeXBlLk9wdGlvbmFsKFR5cGUuQm9vbGVhbigpKSxcblx0cmVxdWlyZXNUb29sQ2FsbElkOiBUeXBlLk9wdGlvbmFsKFR5cGUuQm9vbGVhbigpKSxcblx0c3VwcG9ydHNTZXJ2aWNlVGllcjogVHlwZS5PcHRpb25hbChUeXBlLkJvb2xlYW4oKSksXG5cdGNoYXJzUGVyVG9rZW46IFR5cGUuT3B0aW9uYWwoVHlwZS5OdW1iZXIoKSksXG59KTtcblxuLy8gU2NoZW1hIGZvciBPcGVuQUkgY29tcGF0aWJpbGl0eSBzZXR0aW5nc1xuY29uc3QgT3BlbkFJQ29tcGxldGlvbnNDb21wYXRTY2hlbWEgPSBUeXBlLk9iamVjdCh7XG5cdHN1cHBvcnRzU3RvcmU6IFR5cGUuT3B0aW9uYWwoVHlwZS5Cb29sZWFuKCkpLFxuXHRzdXBwb3J0c0RldmVsb3BlclJvbGU6IFR5cGUuT3B0aW9uYWwoVHlwZS5Cb29sZWFuKCkpLFxuXHRzdXBwb3J0c1JlYXNvbmluZ0VmZm9ydDogVHlwZS5PcHRpb25hbChUeXBlLkJvb2xlYW4oKSksXG5cdHN1cHBvcnRzVXNhZ2VJblN0cmVhbWluZzogVHlwZS5PcHRpb25hbChUeXBlLkJvb2xlYW4oKSksXG5cdG1heFRva2Vuc0ZpZWxkOiBUeXBlLk9wdGlvbmFsKFR5cGUuVW5pb24oW1R5cGUuTGl0ZXJhbChcIm1heF9jb21wbGV0aW9uX3Rva2Vuc1wiKSwgVHlwZS5MaXRlcmFsKFwibWF4X3Rva2Vuc1wiKV0pKSxcblx0cmVxdWlyZXNUb29sUmVzdWx0TmFtZTogVHlwZS5PcHRpb25hbChUeXBlLkJvb2xlYW4oKSksXG5cdHJlcXVpcmVzQXNzaXN0YW50QWZ0ZXJUb29sUmVzdWx0OiBUeXBlLk9wdGlvbmFsKFR5cGUuQm9vbGVhbigpKSxcblx0cmVxdWlyZXNUaGlua2luZ0FzVGV4dDogVHlwZS5PcHRpb25hbChUeXBlLkJvb2xlYW4oKSksXG5cdHJlcXVpcmVzTWlzdHJhbFRvb2xJZHM6IFR5cGUuT3B0aW9uYWwoVHlwZS5Cb29sZWFuKCkpLFxuXHR0aGlua2luZ0Zvcm1hdDogVHlwZS5PcHRpb25hbChUeXBlLlVuaW9uKFtUeXBlLkxpdGVyYWwoXCJvcGVuYWlcIiksIFR5cGUuTGl0ZXJhbChcInphaVwiKSwgVHlwZS5MaXRlcmFsKFwicXdlblwiKV0pKSxcblx0b3BlblJvdXRlclJvdXRpbmc6IFR5cGUuT3B0aW9uYWwoT3BlblJvdXRlclJvdXRpbmdTY2hlbWEpLFxuXHR2ZXJjZWxHYXRld2F5Um91dGluZzogVHlwZS5PcHRpb25hbChWZXJjZWxHYXRld2F5Um91dGluZ1NjaGVtYSksXG59KTtcblxuY29uc3QgT3BlbkFJUmVzcG9uc2VzQ29tcGF0U2NoZW1hID0gVHlwZS5PYmplY3Qoe1xuXHQvLyBSZXNlcnZlZCBmb3IgZnV0dXJlIHVzZVxufSk7XG5cbmNvbnN0IE9wZW5BSUNvbXBhdFNjaGVtYSA9IFR5cGUuVW5pb24oW09wZW5BSUNvbXBsZXRpb25zQ29tcGF0U2NoZW1hLCBPcGVuQUlSZXNwb25zZXNDb21wYXRTY2hlbWFdKTtcblxuLy8gU2NoZW1hIGZvciBjdXN0b20gbW9kZWwgZGVmaW5pdGlvblxuLy8gTW9zdCBmaWVsZHMgYXJlIG9wdGlvbmFsIHdpdGggc2Vuc2libGUgZGVmYXVsdHMgZm9yIGxvY2FsIG1vZGVscyAoT2xsYW1hLCBMTSBTdHVkaW8sIGV0Yy4pXG5jb25zdCBNb2RlbERlZmluaXRpb25TY2hlbWEgPSBUeXBlLk9iamVjdCh7XG5cdGlkOiBUeXBlLlN0cmluZyh7IG1pbkxlbmd0aDogMSB9KSxcblx0bmFtZTogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IG1pbkxlbmd0aDogMSB9KSksXG5cdGFwaTogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IG1pbkxlbmd0aDogMSB9KSksXG5cdGJhc2VVcmw6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBtaW5MZW5ndGg6IDEgfSkpLFxuXHRyZWFzb25pbmc6IFR5cGUuT3B0aW9uYWwoVHlwZS5Cb29sZWFuKCkpLFxuXHRpbnB1dDogVHlwZS5PcHRpb25hbChUeXBlLkFycmF5KFR5cGUuVW5pb24oW1R5cGUuTGl0ZXJhbChcInRleHRcIiksIFR5cGUuTGl0ZXJhbChcImltYWdlXCIpXSkpKSxcblx0Y29zdDogVHlwZS5PcHRpb25hbChcblx0XHRUeXBlLk9iamVjdCh7XG5cdFx0XHRpbnB1dDogVHlwZS5OdW1iZXIoKSxcblx0XHRcdG91dHB1dDogVHlwZS5OdW1iZXIoKSxcblx0XHRcdGNhY2hlUmVhZDogVHlwZS5OdW1iZXIoKSxcblx0XHRcdGNhY2hlV3JpdGU6IFR5cGUuTnVtYmVyKCksXG5cdFx0fSksXG5cdCksXG5cdGNvbnRleHRXaW5kb3c6IFR5cGUuT3B0aW9uYWwoVHlwZS5OdW1iZXIoKSksXG5cdG1heFRva2VuczogVHlwZS5PcHRpb25hbChUeXBlLk51bWJlcigpKSxcblx0aGVhZGVyczogVHlwZS5PcHRpb25hbChUeXBlLlJlY29yZChUeXBlLlN0cmluZygpLCBUeXBlLlN0cmluZygpKSksXG5cdGNvbXBhdDogVHlwZS5PcHRpb25hbChPcGVuQUlDb21wYXRTY2hlbWEpLFxuXHRjYXBhYmlsaXRpZXM6IFR5cGUuT3B0aW9uYWwoTW9kZWxDYXBhYmlsaXRpZXNTY2hlbWEpLFxufSk7XG5cbi8vIFNjaGVtYSBmb3IgcGVyLW1vZGVsIG92ZXJyaWRlcyAoYWxsIGZpZWxkcyBvcHRpb25hbCwgbWVyZ2VkIHdpdGggYnVpbHQtaW4gbW9kZWwpXG5jb25zdCBNb2RlbE92ZXJyaWRlU2NoZW1hID0gVHlwZS5PYmplY3Qoe1xuXHRuYW1lOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgbWluTGVuZ3RoOiAxIH0pKSxcblx0cmVhc29uaW5nOiBUeXBlLk9wdGlvbmFsKFR5cGUuQm9vbGVhbigpKSxcblx0aW5wdXQ6IFR5cGUuT3B0aW9uYWwoVHlwZS5BcnJheShUeXBlLlVuaW9uKFtUeXBlLkxpdGVyYWwoXCJ0ZXh0XCIpLCBUeXBlLkxpdGVyYWwoXCJpbWFnZVwiKV0pKSksXG5cdGNvc3Q6IFR5cGUuT3B0aW9uYWwoXG5cdFx0VHlwZS5PYmplY3Qoe1xuXHRcdFx0aW5wdXQ6IFR5cGUuT3B0aW9uYWwoVHlwZS5OdW1iZXIoKSksXG5cdFx0XHRvdXRwdXQ6IFR5cGUuT3B0aW9uYWwoVHlwZS5OdW1iZXIoKSksXG5cdFx0XHRjYWNoZVJlYWQ6IFR5cGUuT3B0aW9uYWwoVHlwZS5OdW1iZXIoKSksXG5cdFx0XHRjYWNoZVdyaXRlOiBUeXBlLk9wdGlvbmFsKFR5cGUuTnVtYmVyKCkpLFxuXHRcdH0pLFxuXHQpLFxuXHRjb250ZXh0V2luZG93OiBUeXBlLk9wdGlvbmFsKFR5cGUuTnVtYmVyKCkpLFxuXHRtYXhUb2tlbnM6IFR5cGUuT3B0aW9uYWwoVHlwZS5OdW1iZXIoKSksXG5cdGhlYWRlcnM6IFR5cGUuT3B0aW9uYWwoVHlwZS5SZWNvcmQoVHlwZS5TdHJpbmcoKSwgVHlwZS5TdHJpbmcoKSkpLFxuXHRjb21wYXQ6IFR5cGUuT3B0aW9uYWwoT3BlbkFJQ29tcGF0U2NoZW1hKSxcblx0Y2FwYWJpbGl0aWVzOiBUeXBlLk9wdGlvbmFsKE1vZGVsQ2FwYWJpbGl0aWVzU2NoZW1hKSxcbn0pO1xuXG50eXBlIE1vZGVsT3ZlcnJpZGUgPSBTdGF0aWM8dHlwZW9mIE1vZGVsT3ZlcnJpZGVTY2hlbWE+O1xuXG5jb25zdCBQcm92aWRlckNvbmZpZ1NjaGVtYSA9IFR5cGUuT2JqZWN0KHtcblx0YmFzZVVybDogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IG1pbkxlbmd0aDogMSB9KSksXG5cdGFwaUtleTogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IG1pbkxlbmd0aDogMSB9KSksXG5cdGFwaTogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IG1pbkxlbmd0aDogMSB9KSksXG5cdGhlYWRlcnM6IFR5cGUuT3B0aW9uYWwoVHlwZS5SZWNvcmQoVHlwZS5TdHJpbmcoKSwgVHlwZS5TdHJpbmcoKSkpLFxuXHRhdXRoSGVhZGVyOiBUeXBlLk9wdGlvbmFsKFR5cGUuQm9vbGVhbigpKSxcblx0bW9kZWxzOiBUeXBlLk9wdGlvbmFsKFR5cGUuQXJyYXkoTW9kZWxEZWZpbml0aW9uU2NoZW1hKSksXG5cdG1vZGVsT3ZlcnJpZGVzOiBUeXBlLk9wdGlvbmFsKFR5cGUuUmVjb3JkKFR5cGUuU3RyaW5nKCksIE1vZGVsT3ZlcnJpZGVTY2hlbWEpKSxcbn0pO1xuXG5jb25zdCBNb2RlbHNDb25maWdTY2hlbWEgPSBUeXBlLk9iamVjdCh7XG5cdHByb3ZpZGVyczogVHlwZS5SZWNvcmQoVHlwZS5TdHJpbmcoKSwgUHJvdmlkZXJDb25maWdTY2hlbWEpLFxufSk7XG5cbmFqdi5hZGRTY2hlbWEoTW9kZWxzQ29uZmlnU2NoZW1hLCBcIk1vZGVsc0NvbmZpZ1wiKTtcblxudHlwZSBNb2RlbHNDb25maWcgPSBTdGF0aWM8dHlwZW9mIE1vZGVsc0NvbmZpZ1NjaGVtYT47XG5cbmV4cG9ydCB0eXBlIFByb3ZpZGVyQXV0aE1vZGUgPSBcImFwaUtleVwiIHwgXCJvYXV0aFwiIHwgXCJleHRlcm5hbENsaVwiIHwgXCJub25lXCI7XG5cbi8qKiBQcm92aWRlciBvdmVycmlkZSBjb25maWcgKGJhc2VVcmwsIGhlYWRlcnMsIGFwaUtleSkgd2l0aG91dCBjdXN0b20gbW9kZWxzICovXG5pbnRlcmZhY2UgUHJvdmlkZXJPdmVycmlkZSB7XG5cdGJhc2VVcmw/OiBzdHJpbmc7XG5cdGhlYWRlcnM/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuXHRhcGlLZXk/OiBzdHJpbmc7XG59XG5cbi8qKiBSZXN1bHQgb2YgbG9hZGluZyBjdXN0b20gbW9kZWxzIGZyb20gbW9kZWxzLmpzb24gKi9cbmludGVyZmFjZSBDdXN0b21Nb2RlbHNSZXN1bHQge1xuXHRtb2RlbHM6IE1vZGVsPEFwaT5bXTtcblx0LyoqIFByb3ZpZGVycyB3aXRoIGJhc2VVcmwvaGVhZGVycy9hcGlLZXkgb3ZlcnJpZGVzIGZvciBidWlsdC1pbiBtb2RlbHMgKi9cblx0b3ZlcnJpZGVzOiBNYXA8c3RyaW5nLCBQcm92aWRlck92ZXJyaWRlPjtcblx0LyoqIFBlci1tb2RlbCBvdmVycmlkZXM6IHByb3ZpZGVyIC0+IG1vZGVsSWQgLT4gb3ZlcnJpZGUgKi9cblx0bW9kZWxPdmVycmlkZXM6IE1hcDxzdHJpbmcsIE1hcDxzdHJpbmcsIE1vZGVsT3ZlcnJpZGU+Pjtcblx0ZXJyb3I6IHN0cmluZyB8IHVuZGVmaW5lZDtcbn1cblxuZnVuY3Rpb24gZW1wdHlDdXN0b21Nb2RlbHNSZXN1bHQoZXJyb3I/OiBzdHJpbmcpOiBDdXN0b21Nb2RlbHNSZXN1bHQge1xuXHRyZXR1cm4geyBtb2RlbHM6IFtdLCBvdmVycmlkZXM6IG5ldyBNYXAoKSwgbW9kZWxPdmVycmlkZXM6IG5ldyBNYXAoKSwgZXJyb3IgfTtcbn1cblxuZnVuY3Rpb24gbWVyZ2VDb21wYXQoXG5cdGJhc2VDb21wYXQ6IE1vZGVsPEFwaT5bXCJjb21wYXRcIl0sXG5cdG92ZXJyaWRlQ29tcGF0OiBNb2RlbE92ZXJyaWRlW1wiY29tcGF0XCJdLFxuKTogTW9kZWw8QXBpPltcImNvbXBhdFwiXSB8IHVuZGVmaW5lZCB7XG5cdGlmICghb3ZlcnJpZGVDb21wYXQpIHJldHVybiBiYXNlQ29tcGF0O1xuXG5cdGNvbnN0IGJhc2UgPSBiYXNlQ29tcGF0IGFzIE9wZW5BSUNvbXBsZXRpb25zQ29tcGF0IHwgT3BlbkFJUmVzcG9uc2VzQ29tcGF0IHwgdW5kZWZpbmVkO1xuXHRjb25zdCBvdmVycmlkZSA9IG92ZXJyaWRlQ29tcGF0IGFzIE9wZW5BSUNvbXBsZXRpb25zQ29tcGF0IHwgT3BlbkFJUmVzcG9uc2VzQ29tcGF0O1xuXHRjb25zdCBtZXJnZWQgPSB7IC4uLmJhc2UsIC4uLm92ZXJyaWRlIH0gYXMgT3BlbkFJQ29tcGxldGlvbnNDb21wYXQgfCBPcGVuQUlSZXNwb25zZXNDb21wYXQ7XG5cblx0Y29uc3QgYmFzZUNvbXBsZXRpb25zID0gYmFzZSBhcyBPcGVuQUlDb21wbGV0aW9uc0NvbXBhdCB8IHVuZGVmaW5lZDtcblx0Y29uc3Qgb3ZlcnJpZGVDb21wbGV0aW9ucyA9IG92ZXJyaWRlIGFzIE9wZW5BSUNvbXBsZXRpb25zQ29tcGF0O1xuXHRjb25zdCBtZXJnZWRDb21wbGV0aW9ucyA9IG1lcmdlZCBhcyBPcGVuQUlDb21wbGV0aW9uc0NvbXBhdDtcblxuXHRpZiAoYmFzZUNvbXBsZXRpb25zPy5vcGVuUm91dGVyUm91dGluZyB8fCBvdmVycmlkZUNvbXBsZXRpb25zLm9wZW5Sb3V0ZXJSb3V0aW5nKSB7XG5cdFx0bWVyZ2VkQ29tcGxldGlvbnMub3BlblJvdXRlclJvdXRpbmcgPSB7XG5cdFx0XHQuLi5iYXNlQ29tcGxldGlvbnM/Lm9wZW5Sb3V0ZXJSb3V0aW5nLFxuXHRcdFx0Li4ub3ZlcnJpZGVDb21wbGV0aW9ucy5vcGVuUm91dGVyUm91dGluZyxcblx0XHR9O1xuXHR9XG5cblx0aWYgKGJhc2VDb21wbGV0aW9ucz8udmVyY2VsR2F0ZXdheVJvdXRpbmcgfHwgb3ZlcnJpZGVDb21wbGV0aW9ucy52ZXJjZWxHYXRld2F5Um91dGluZykge1xuXHRcdG1lcmdlZENvbXBsZXRpb25zLnZlcmNlbEdhdGV3YXlSb3V0aW5nID0ge1xuXHRcdFx0Li4uYmFzZUNvbXBsZXRpb25zPy52ZXJjZWxHYXRld2F5Um91dGluZyxcblx0XHRcdC4uLm92ZXJyaWRlQ29tcGxldGlvbnMudmVyY2VsR2F0ZXdheVJvdXRpbmcsXG5cdFx0fTtcblx0fVxuXG5cdHJldHVybiBtZXJnZWQgYXMgTW9kZWw8QXBpPltcImNvbXBhdFwiXTtcbn1cblxuLyoqXG4gKiBEZWVwIG1lcmdlIGEgbW9kZWwgb3ZlcnJpZGUgaW50byBhIG1vZGVsLlxuICogSGFuZGxlcyBuZXN0ZWQgb2JqZWN0cyAoY29zdCwgY29tcGF0KSBieSBtZXJnaW5nIHJhdGhlciB0aGFuIHJlcGxhY2luZy5cbiAqL1xuZnVuY3Rpb24gYXBwbHlNb2RlbE92ZXJyaWRlKG1vZGVsOiBNb2RlbDxBcGk+LCBvdmVycmlkZTogTW9kZWxPdmVycmlkZSk6IE1vZGVsPEFwaT4ge1xuXHRjb25zdCByZXN1bHQgPSB7IC4uLm1vZGVsIH07XG5cblx0Ly8gU2ltcGxlIGZpZWxkIG92ZXJyaWRlc1xuXHRpZiAob3ZlcnJpZGUubmFtZSAhPT0gdW5kZWZpbmVkKSByZXN1bHQubmFtZSA9IG92ZXJyaWRlLm5hbWU7XG5cdGlmIChvdmVycmlkZS5yZWFzb25pbmcgIT09IHVuZGVmaW5lZCkgcmVzdWx0LnJlYXNvbmluZyA9IG92ZXJyaWRlLnJlYXNvbmluZztcblx0aWYgKG92ZXJyaWRlLmlucHV0ICE9PSB1bmRlZmluZWQpIHJlc3VsdC5pbnB1dCA9IG92ZXJyaWRlLmlucHV0IGFzIChcInRleHRcIiB8IFwiaW1hZ2VcIilbXTtcblx0aWYgKG92ZXJyaWRlLmNvbnRleHRXaW5kb3cgIT09IHVuZGVmaW5lZCkgcmVzdWx0LmNvbnRleHRXaW5kb3cgPSBvdmVycmlkZS5jb250ZXh0V2luZG93O1xuXHRpZiAob3ZlcnJpZGUubWF4VG9rZW5zICE9PSB1bmRlZmluZWQpIHJlc3VsdC5tYXhUb2tlbnMgPSBvdmVycmlkZS5tYXhUb2tlbnM7XG5cblx0Ly8gTWVyZ2UgY29zdCAocGFydGlhbCBvdmVycmlkZSlcblx0aWYgKG92ZXJyaWRlLmNvc3QpIHtcblx0XHRyZXN1bHQuY29zdCA9IHtcblx0XHRcdGlucHV0OiBvdmVycmlkZS5jb3N0LmlucHV0ID8/IG1vZGVsLmNvc3QuaW5wdXQsXG5cdFx0XHRvdXRwdXQ6IG92ZXJyaWRlLmNvc3Qub3V0cHV0ID8/IG1vZGVsLmNvc3Qub3V0cHV0LFxuXHRcdFx0Y2FjaGVSZWFkOiBvdmVycmlkZS5jb3N0LmNhY2hlUmVhZCA/PyBtb2RlbC5jb3N0LmNhY2hlUmVhZCxcblx0XHRcdGNhY2hlV3JpdGU6IG92ZXJyaWRlLmNvc3QuY2FjaGVXcml0ZSA/PyBtb2RlbC5jb3N0LmNhY2hlV3JpdGUsXG5cdFx0fTtcblx0fVxuXG5cdC8vIE1lcmdlIGhlYWRlcnNcblx0aWYgKG92ZXJyaWRlLmhlYWRlcnMpIHtcblx0XHRjb25zdCByZXNvbHZlZEhlYWRlcnMgPSByZXNvbHZlSGVhZGVycyhvdmVycmlkZS5oZWFkZXJzKTtcblx0XHRyZXN1bHQuaGVhZGVycyA9IHJlc29sdmVkSGVhZGVycyA/IHsgLi4ubW9kZWwuaGVhZGVycywgLi4ucmVzb2x2ZWRIZWFkZXJzIH0gOiBtb2RlbC5oZWFkZXJzO1xuXHR9XG5cblx0Ly8gRGVlcCBtZXJnZSBjb21wYXRcblx0cmVzdWx0LmNvbXBhdCA9IG1lcmdlQ29tcGF0KG1vZGVsLmNvbXBhdCwgb3ZlcnJpZGUuY29tcGF0KTtcblxuXHQvLyBNZXJnZSBjYXBhYmlsaXRpZXMgKG92ZXJyaWRlIHdpbnMgcGVyLWZpZWxkKVxuXHRpZiAob3ZlcnJpZGUuY2FwYWJpbGl0aWVzKSB7XG5cdFx0cmVzdWx0LmNhcGFiaWxpdGllcyA9IHsgLi4ubW9kZWwuY2FwYWJpbGl0aWVzLCAuLi5vdmVycmlkZS5jYXBhYmlsaXRpZXMgfTtcblx0fVxuXG5cdHJldHVybiByZXN1bHQ7XG59XG5cblxuLyoqXG4gKiBNb2RlbCByZWdpc3RyeSAtIGxvYWRzIGFuZCBtYW5hZ2VzIG1vZGVscywgcmVzb2x2ZXMgQVBJIGtleXMgdmlhIEF1dGhTdG9yYWdlLlxuICovXG5leHBvcnQgY2xhc3MgTW9kZWxSZWdpc3RyeSB7XG5cdHByaXZhdGUgbW9kZWxzOiBNb2RlbDxBcGk+W10gPSBbXTtcblx0cHJpdmF0ZSBkaXNjb3ZlcmVkTW9kZWxzOiBNb2RlbDxBcGk+W10gPSBbXTtcblx0cHJpdmF0ZSBkaXNjb3ZlcnlDYWNoZTogTW9kZWxEaXNjb3ZlcnlDYWNoZTtcblx0cHJpdmF0ZSBjdXN0b21Qcm92aWRlckFwaUtleXM6IE1hcDxzdHJpbmcsIHN0cmluZz4gPSBuZXcgTWFwKCk7XG5cdHByaXZhdGUgcmVnaXN0ZXJlZFByb3ZpZGVyczogTWFwPHN0cmluZywgUHJvdmlkZXJDb25maWdJbnB1dD4gPSBuZXcgTWFwKCk7XG5cdHByaXZhdGUgZGlzYWJsZWRNb2RlbFByb3ZpZGVyczogU2V0PHN0cmluZz4gPSBuZXcgU2V0KCk7XG5cdHByaXZhdGUgbG9hZEVycm9yOiBzdHJpbmcgfCB1bmRlZmluZWQgPSB1bmRlZmluZWQ7XG5cblx0Y29uc3RydWN0b3IoXG5cdFx0cmVhZG9ubHkgYXV0aFN0b3JhZ2U6IEF1dGhTdG9yYWdlLFxuXHRcdHJlYWRvbmx5IG1vZGVsc0pzb25QYXRoOiBzdHJpbmcgfCB1bmRlZmluZWQgPSBqb2luKGdldEFnZW50RGlyKCksIFwibW9kZWxzLmpzb25cIiksXG5cdCkge1xuXHRcdHRoaXMuZGlzY292ZXJ5Q2FjaGUgPSBuZXcgTW9kZWxEaXNjb3ZlcnlDYWNoZSgpO1xuXG5cdFx0Ly8gU2V0IHVwIGZhbGxiYWNrIHJlc29sdmVyIGZvciBjdXN0b20gcHJvdmlkZXIgQVBJIGtleXNcblx0XHR0aGlzLmF1dGhTdG9yYWdlLnNldEZhbGxiYWNrUmVzb2x2ZXIoKHByb3ZpZGVyKSA9PiB7XG5cdFx0XHRjb25zdCBrZXlDb25maWcgPSB0aGlzLmN1c3RvbVByb3ZpZGVyQXBpS2V5cy5nZXQocHJvdmlkZXIpO1xuXHRcdFx0aWYgKGtleUNvbmZpZykge1xuXHRcdFx0XHRyZXR1cm4gcmVzb2x2ZUNvbmZpZ1ZhbHVlKGtleUNvbmZpZyk7XG5cdFx0XHR9XG5cdFx0XHRyZXR1cm4gZ2V0RW52QXBpS2V5KHByb3ZpZGVyKTtcblx0XHR9KTtcblxuXHRcdC8vIFJlZnJlc2ggbW9kZWxzIHdoZW4gY3JlZGVudGlhbHMgY2hhbmdlIChlLmcuLCBPQXV0aCB0b2tlbiByZWZyZXNoIHdpdGggbmV3IG1vZGVsIGxpbWl0cylcblx0XHR0aGlzLmF1dGhTdG9yYWdlLm9uQ3JlZGVudGlhbENoYW5nZSgoKSA9PiB0aGlzLnJlZnJlc2goKSk7XG5cblx0XHQvLyBMb2FkIG1vZGVsc1xuXHRcdHRoaXMubG9hZE1vZGVscygpO1xuXHR9XG5cblx0LyoqXG5cdCAqIFJlbG9hZCBtb2RlbHMgZnJvbSBkaXNrIChidWlsdC1pbiArIGN1c3RvbSBmcm9tIG1vZGVscy5qc29uKS5cblx0ICovXG5cdHJlZnJlc2goKTogdm9pZCB7XG5cdFx0dGhpcy5jdXN0b21Qcm92aWRlckFwaUtleXMuY2xlYXIoKTtcblx0XHR0aGlzLmxvYWRFcnJvciA9IHVuZGVmaW5lZDtcblxuXHRcdC8vIEVuc3VyZSBkeW5hbWljIEFQSS9PQXV0aCByZWdpc3RyYXRpb25zIGFyZSByZWJ1aWx0IGZyb20gY3VycmVudCBwcm92aWRlciBzdGF0ZS5cblx0XHRyZXNldEFwaVByb3ZpZGVycygpO1xuXHRcdHJlc2V0T0F1dGhQcm92aWRlcnMoKTtcblxuXHRcdHRoaXMubG9hZE1vZGVscygpO1xuXG5cdFx0Zm9yIChjb25zdCBbcHJvdmlkZXJOYW1lLCBjb25maWddIG9mIHRoaXMucmVnaXN0ZXJlZFByb3ZpZGVycy5lbnRyaWVzKCkpIHtcblx0XHRcdHRoaXMuYXBwbHlQcm92aWRlckNvbmZpZyhwcm92aWRlck5hbWUsIGNvbmZpZyk7XG5cdFx0fVxuXHR9XG5cblx0LyoqXG5cdCAqIEdldCBhbnkgZXJyb3IgZnJvbSBsb2FkaW5nIG1vZGVscy5qc29uICh1bmRlZmluZWQgaWYgbm8gZXJyb3IpLlxuXHQgKi9cblx0Z2V0RXJyb3IoKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcblx0XHRyZXR1cm4gdGhpcy5sb2FkRXJyb3I7XG5cdH1cblxuXHRwcml2YXRlIGxvYWRNb2RlbHMoKTogdm9pZCB7XG5cdFx0Ly8gTG9hZCBjdXN0b20gbW9kZWxzIGFuZCBvdmVycmlkZXMgZnJvbSBtb2RlbHMuanNvblxuXHRcdGNvbnN0IHtcblx0XHRcdG1vZGVsczogY3VzdG9tTW9kZWxzLFxuXHRcdFx0b3ZlcnJpZGVzLFxuXHRcdFx0bW9kZWxPdmVycmlkZXMsXG5cdFx0XHRlcnJvcixcblx0XHR9ID0gdGhpcy5tb2RlbHNKc29uUGF0aCA/IHRoaXMubG9hZEN1c3RvbU1vZGVscyh0aGlzLm1vZGVsc0pzb25QYXRoKSA6IGVtcHR5Q3VzdG9tTW9kZWxzUmVzdWx0KCk7XG5cblx0XHRpZiAoZXJyb3IpIHtcblx0XHRcdHRoaXMubG9hZEVycm9yID0gZXJyb3I7XG5cdFx0XHQvLyBLZWVwIGJ1aWx0LWluIG1vZGVscyBldmVuIGlmIGN1c3RvbSBtb2RlbHMgZmFpbGVkIHRvIGxvYWRcblx0XHR9XG5cblx0XHRjb25zdCBidWlsdEluTW9kZWxzID0gdGhpcy5sb2FkQnVpbHRJbk1vZGVscyhvdmVycmlkZXMsIG1vZGVsT3ZlcnJpZGVzKTtcblx0XHRsZXQgY29tYmluZWQgPSB0aGlzLm1lcmdlQ3VzdG9tTW9kZWxzKGJ1aWx0SW5Nb2RlbHMsIGN1c3RvbU1vZGVscyk7XG5cblx0XHQvLyBMZXQgT0F1dGggcHJvdmlkZXJzIG1vZGlmeSB0aGVpciBtb2RlbHMgKGUuZy4sIHVwZGF0ZSBiYXNlVXJsKVxuXHRcdGZvciAoY29uc3Qgb2F1dGhQcm92aWRlciBvZiB0aGlzLmF1dGhTdG9yYWdlLmdldE9BdXRoUHJvdmlkZXJzKCkpIHtcblx0XHRcdGNvbnN0IGNyZWQgPSB0aGlzLmF1dGhTdG9yYWdlLmdldChvYXV0aFByb3ZpZGVyLmlkKTtcblx0XHRcdGlmIChjcmVkPy50eXBlID09PSBcIm9hdXRoXCIgJiYgb2F1dGhQcm92aWRlci5tb2RpZnlNb2RlbHMpIHtcblx0XHRcdFx0Y29tYmluZWQgPSBvYXV0aFByb3ZpZGVyLm1vZGlmeU1vZGVscyhjb21iaW5lZCwgY3JlZCk7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0Ly8gQXBwbHkgY2FwYWJpbGl0eSBwYXRjaGVzIHNvIGN1c3RvbS9kaXNjb3ZlcmVkL2V4dGVuc2lvbiBtb2RlbHMgZ2V0XG5cdFx0Ly8gY2FwYWJpbGl0aWVzIChzdXBwb3J0c1hoaWdoLCBzdXBwb3J0c1NlcnZpY2VUaWVyLCBldGMuKSB0aGF0IHRoZVxuXHRcdC8vIHN0YXRpYyBwaS1haSByZWdpc3RyeSBhcHBsaWVzIGF0IG1vZHVsZSBsb2FkIGZvciBidWlsdC1pbiBtb2RlbHMuXG5cdFx0dGhpcy5tb2RlbHMgPSBhcHBseUNhcGFiaWxpdHlQYXRjaGVzKGNvbWJpbmVkKTtcblx0fVxuXG5cdC8qKiBMb2FkIGJ1aWx0LWluIG1vZGVscyBhbmQgYXBwbHkgcHJvdmlkZXIvbW9kZWwgb3ZlcnJpZGVzICovXG5cdHByaXZhdGUgbG9hZEJ1aWx0SW5Nb2RlbHMoXG5cdFx0b3ZlcnJpZGVzOiBNYXA8c3RyaW5nLCBQcm92aWRlck92ZXJyaWRlPixcblx0XHRtb2RlbE92ZXJyaWRlczogTWFwPHN0cmluZywgTWFwPHN0cmluZywgTW9kZWxPdmVycmlkZT4+LFxuXHQpOiBNb2RlbDxBcGk+W10ge1xuXHRcdHJldHVybiBnZXRQcm92aWRlcnMoKS5mbGF0TWFwKChwcm92aWRlcikgPT4ge1xuXHRcdFx0Y29uc3QgbW9kZWxzID0gZ2V0TW9kZWxzKHByb3ZpZGVyIGFzIEtub3duUHJvdmlkZXIpIGFzIE1vZGVsPEFwaT5bXTtcblx0XHRcdGNvbnN0IHByb3ZpZGVyT3ZlcnJpZGUgPSBvdmVycmlkZXMuZ2V0KHByb3ZpZGVyKTtcblx0XHRcdGNvbnN0IHBlck1vZGVsT3ZlcnJpZGVzID0gbW9kZWxPdmVycmlkZXMuZ2V0KHByb3ZpZGVyKTtcblxuXHRcdFx0cmV0dXJuIG1vZGVscy5tYXAoKG0pID0+IHtcblx0XHRcdFx0bGV0IG1vZGVsID0gbTtcblxuXHRcdFx0XHQvLyBBcHBseSBwcm92aWRlci1sZXZlbCBiYXNlVXJsL2hlYWRlcnMgb3ZlcnJpZGVcblx0XHRcdFx0aWYgKHByb3ZpZGVyT3ZlcnJpZGUpIHtcblx0XHRcdFx0XHRjb25zdCByZXNvbHZlZEhlYWRlcnMgPSByZXNvbHZlSGVhZGVycyhwcm92aWRlck92ZXJyaWRlLmhlYWRlcnMpO1xuXHRcdFx0XHRcdG1vZGVsID0ge1xuXHRcdFx0XHRcdFx0Li4ubW9kZWwsXG5cdFx0XHRcdFx0XHRiYXNlVXJsOiBwcm92aWRlck92ZXJyaWRlLmJhc2VVcmwgPz8gbW9kZWwuYmFzZVVybCxcblx0XHRcdFx0XHRcdGhlYWRlcnM6IHJlc29sdmVkSGVhZGVycyA/IHsgLi4ubW9kZWwuaGVhZGVycywgLi4ucmVzb2x2ZWRIZWFkZXJzIH0gOiBtb2RlbC5oZWFkZXJzLFxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdH1cblxuXHRcdFx0XHQvLyBBcHBseSBwZXItbW9kZWwgb3ZlcnJpZGVcblx0XHRcdFx0Y29uc3QgbW9kZWxPdmVycmlkZSA9IHBlck1vZGVsT3ZlcnJpZGVzPy5nZXQobS5pZCk7XG5cdFx0XHRcdGlmIChtb2RlbE92ZXJyaWRlKSB7XG5cdFx0XHRcdFx0bW9kZWwgPSBhcHBseU1vZGVsT3ZlcnJpZGUobW9kZWwsIG1vZGVsT3ZlcnJpZGUpO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0cmV0dXJuIG1vZGVsO1xuXHRcdFx0fSk7XG5cdFx0fSk7XG5cdH1cblxuXHQvKiogTWVyZ2UgY3VzdG9tIG1vZGVscyBpbnRvIGJ1aWx0LWluIGxpc3QgYnkgcHJvdmlkZXIraWQgKGN1c3RvbSB3aW5zIG9uIGNvbmZsaWN0cykuICovXG5cdHByaXZhdGUgbWVyZ2VDdXN0b21Nb2RlbHMoYnVpbHRJbk1vZGVsczogTW9kZWw8QXBpPltdLCBjdXN0b21Nb2RlbHM6IE1vZGVsPEFwaT5bXSk6IE1vZGVsPEFwaT5bXSB7XG5cdFx0Y29uc3QgbWVyZ2VkID0gWy4uLmJ1aWx0SW5Nb2RlbHNdO1xuXHRcdGZvciAoY29uc3QgY3VzdG9tTW9kZWwgb2YgY3VzdG9tTW9kZWxzKSB7XG5cdFx0XHRjb25zdCBleGlzdGluZ0luZGV4ID0gbWVyZ2VkLmZpbmRJbmRleCgobSkgPT4gbS5wcm92aWRlciA9PT0gY3VzdG9tTW9kZWwucHJvdmlkZXIgJiYgbS5pZCA9PT0gY3VzdG9tTW9kZWwuaWQpO1xuXHRcdFx0aWYgKGV4aXN0aW5nSW5kZXggPj0gMCkge1xuXHRcdFx0XHRtZXJnZWRbZXhpc3RpbmdJbmRleF0gPSBjdXN0b21Nb2RlbDtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdG1lcmdlZC5wdXNoKGN1c3RvbU1vZGVsKTtcblx0XHRcdH1cblx0XHR9XG5cdFx0cmV0dXJuIG1lcmdlZDtcblx0fVxuXG5cdHByaXZhdGUgbG9hZEN1c3RvbU1vZGVscyhtb2RlbHNKc29uUGF0aDogc3RyaW5nKTogQ3VzdG9tTW9kZWxzUmVzdWx0IHtcblx0XHRpZiAoIWV4aXN0c1N5bmMobW9kZWxzSnNvblBhdGgpKSB7XG5cdFx0XHRyZXR1cm4gZW1wdHlDdXN0b21Nb2RlbHNSZXN1bHQoKTtcblx0XHR9XG5cblx0XHR0cnkge1xuXHRcdFx0Y29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhtb2RlbHNKc29uUGF0aCwgXCJ1dGYtOFwiKTtcblx0XHRcdGNvbnN0IGNvbmZpZzogTW9kZWxzQ29uZmlnID0gSlNPTi5wYXJzZShjb250ZW50KTtcblxuXHRcdFx0Ly8gVmFsaWRhdGUgc2NoZW1hXG5cdFx0XHRjb25zdCB2YWxpZGF0ZSA9IGFqdi5nZXRTY2hlbWEoXCJNb2RlbHNDb25maWdcIikhO1xuXHRcdFx0aWYgKCF2YWxpZGF0ZShjb25maWcpKSB7XG5cdFx0XHRcdGNvbnN0IGVycm9ycyA9XG5cdFx0XHRcdFx0dmFsaWRhdGUuZXJyb3JzPy5tYXAoKGU6IGFueSkgPT4gYCAgLSAke2UuaW5zdGFuY2VQYXRoIHx8IFwicm9vdFwifTogJHtlLm1lc3NhZ2V9YCkuam9pbihcIlxcblwiKSB8fFxuXHRcdFx0XHRcdFwiVW5rbm93biBzY2hlbWEgZXJyb3JcIjtcblx0XHRcdFx0cmV0dXJuIGVtcHR5Q3VzdG9tTW9kZWxzUmVzdWx0KGBJbnZhbGlkIG1vZGVscy5qc29uIHNjaGVtYTpcXG4ke2Vycm9yc31cXG5cXG5GaWxlOiAke21vZGVsc0pzb25QYXRofWApO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBBZGRpdGlvbmFsIHZhbGlkYXRpb25cblx0XHRcdHRoaXMudmFsaWRhdGVDb25maWcoY29uZmlnKTtcblxuXHRcdFx0Y29uc3Qgb3ZlcnJpZGVzID0gbmV3IE1hcDxzdHJpbmcsIFByb3ZpZGVyT3ZlcnJpZGU+KCk7XG5cdFx0XHRjb25zdCBtb2RlbE92ZXJyaWRlcyA9IG5ldyBNYXA8c3RyaW5nLCBNYXA8c3RyaW5nLCBNb2RlbE92ZXJyaWRlPj4oKTtcblxuXHRcdFx0Zm9yIChjb25zdCBbcHJvdmlkZXJOYW1lLCBwcm92aWRlckNvbmZpZ10gb2YgT2JqZWN0LmVudHJpZXMoY29uZmlnLnByb3ZpZGVycykpIHtcblx0XHRcdFx0Ly8gQXBwbHkgcHJvdmlkZXItbGV2ZWwgYmFzZVVybC9oZWFkZXJzL2FwaUtleSBvdmVycmlkZSB0byBidWlsdC1pbiBtb2RlbHMgd2hlbiBjb25maWd1cmVkLlxuXHRcdFx0XHRpZiAocHJvdmlkZXJDb25maWcuYmFzZVVybCB8fCBwcm92aWRlckNvbmZpZy5oZWFkZXJzIHx8IHByb3ZpZGVyQ29uZmlnLmFwaUtleSkge1xuXHRcdFx0XHRcdG92ZXJyaWRlcy5zZXQocHJvdmlkZXJOYW1lLCB7XG5cdFx0XHRcdFx0XHRiYXNlVXJsOiBwcm92aWRlckNvbmZpZy5iYXNlVXJsLFxuXHRcdFx0XHRcdFx0aGVhZGVyczogcHJvdmlkZXJDb25maWcuaGVhZGVycyxcblx0XHRcdFx0XHRcdGFwaUtleTogcHJvdmlkZXJDb25maWcuYXBpS2V5LFxuXHRcdFx0XHRcdH0pO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gU3RvcmUgQVBJIGtleSBmb3IgZmFsbGJhY2sgcmVzb2x2ZXIuXG5cdFx0XHRcdGlmIChwcm92aWRlckNvbmZpZy5hcGlLZXkpIHtcblx0XHRcdFx0XHR0aGlzLmN1c3RvbVByb3ZpZGVyQXBpS2V5cy5zZXQocHJvdmlkZXJOYW1lLCBwcm92aWRlckNvbmZpZy5hcGlLZXkpO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0aWYgKHByb3ZpZGVyQ29uZmlnLm1vZGVsT3ZlcnJpZGVzKSB7XG5cdFx0XHRcdFx0bW9kZWxPdmVycmlkZXMuc2V0KHByb3ZpZGVyTmFtZSwgbmV3IE1hcChPYmplY3QuZW50cmllcyhwcm92aWRlckNvbmZpZy5tb2RlbE92ZXJyaWRlcykpKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHRyZXR1cm4geyBtb2RlbHM6IHRoaXMucGFyc2VNb2RlbHMoY29uZmlnKSwgb3ZlcnJpZGVzLCBtb2RlbE92ZXJyaWRlcywgZXJyb3I6IHVuZGVmaW5lZCB9O1xuXHRcdH0gY2F0Y2ggKGVycm9yKSB7XG5cdFx0XHRpZiAoZXJyb3IgaW5zdGFuY2VvZiBTeW50YXhFcnJvcikge1xuXHRcdFx0XHRyZXR1cm4gZW1wdHlDdXN0b21Nb2RlbHNSZXN1bHQoYEZhaWxlZCB0byBwYXJzZSBtb2RlbHMuanNvbjogJHtlcnJvci5tZXNzYWdlfVxcblxcbkZpbGU6ICR7bW9kZWxzSnNvblBhdGh9YCk7XG5cdFx0XHR9XG5cdFx0XHRyZXR1cm4gZW1wdHlDdXN0b21Nb2RlbHNSZXN1bHQoXG5cdFx0XHRcdGBGYWlsZWQgdG8gbG9hZCBtb2RlbHMuanNvbjogJHtlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IGVycm9yfVxcblxcbkZpbGU6ICR7bW9kZWxzSnNvblBhdGh9YCxcblx0XHRcdCk7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSB2YWxpZGF0ZUNvbmZpZyhjb25maWc6IE1vZGVsc0NvbmZpZyk6IHZvaWQge1xuXHRcdGZvciAoY29uc3QgW3Byb3ZpZGVyTmFtZSwgcHJvdmlkZXJDb25maWddIG9mIE9iamVjdC5lbnRyaWVzKGNvbmZpZy5wcm92aWRlcnMpKSB7XG5cdFx0XHRjb25zdCBoYXNQcm92aWRlckFwaSA9ICEhcHJvdmlkZXJDb25maWcuYXBpO1xuXHRcdFx0Y29uc3QgbW9kZWxzID0gcHJvdmlkZXJDb25maWcubW9kZWxzID8/IFtdO1xuXHRcdFx0Y29uc3QgaGFzTW9kZWxPdmVycmlkZXMgPVxuXHRcdFx0XHRwcm92aWRlckNvbmZpZy5tb2RlbE92ZXJyaWRlcyAmJiBPYmplY3Qua2V5cyhwcm92aWRlckNvbmZpZy5tb2RlbE92ZXJyaWRlcykubGVuZ3RoID4gMDtcblxuXHRcdFx0aWYgKG1vZGVscy5sZW5ndGggPT09IDApIHtcblx0XHRcdFx0Ly8gT3ZlcnJpZGUtb25seSBjb25maWc6IG5lZWRzIGJhc2VVcmwgT1IgbW9kZWxPdmVycmlkZXMgKG9yIGJvdGgpXG5cdFx0XHRcdGlmICghcHJvdmlkZXJDb25maWcuYmFzZVVybCAmJiAhaGFzTW9kZWxPdmVycmlkZXMpIHtcblx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoYFByb3ZpZGVyICR7cHJvdmlkZXJOYW1lfTogbXVzdCBzcGVjaWZ5IFwiYmFzZVVybFwiLCBcIm1vZGVsT3ZlcnJpZGVzXCIsIG9yIFwibW9kZWxzXCIuYCk7XG5cdFx0XHRcdH1cblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdC8vIEN1c3RvbSBtb2RlbHMgYXJlIG1lcmdlZCBpbnRvIHByb3ZpZGVyIG1vZGVscyBhbmQgcmVxdWlyZSBlbmRwb2ludCArIGF1dGguXG5cdFx0XHRcdGlmICghcHJvdmlkZXJDb25maWcuYmFzZVVybCkge1xuXHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcihgUHJvdmlkZXIgJHtwcm92aWRlck5hbWV9OiBcImJhc2VVcmxcIiBpcyByZXF1aXJlZCB3aGVuIGRlZmluaW5nIGN1c3RvbSBtb2RlbHMuYCk7XG5cdFx0XHRcdH1cblx0XHRcdFx0aWYgKCFwcm92aWRlckNvbmZpZy5hcGlLZXkpIHtcblx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoYFByb3ZpZGVyICR7cHJvdmlkZXJOYW1lfTogXCJhcGlLZXlcIiBpcyByZXF1aXJlZCB3aGVuIGRlZmluaW5nIGN1c3RvbSBtb2RlbHMuYCk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0Zm9yIChjb25zdCBtb2RlbERlZiBvZiBtb2RlbHMpIHtcblx0XHRcdFx0Y29uc3QgaGFzTW9kZWxBcGkgPSAhIW1vZGVsRGVmLmFwaTtcblxuXHRcdFx0XHRpZiAoIWhhc1Byb3ZpZGVyQXBpICYmICFoYXNNb2RlbEFwaSkge1xuXHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcihcblx0XHRcdFx0XHRcdGBQcm92aWRlciAke3Byb3ZpZGVyTmFtZX0sIG1vZGVsICR7bW9kZWxEZWYuaWR9OiBubyBcImFwaVwiIHNwZWNpZmllZC4gU2V0IGF0IHByb3ZpZGVyIG9yIG1vZGVsIGxldmVsLmAsXG5cdFx0XHRcdFx0KTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGlmICghbW9kZWxEZWYuaWQpIHRocm93IG5ldyBFcnJvcihgUHJvdmlkZXIgJHtwcm92aWRlck5hbWV9OiBtb2RlbCBtaXNzaW5nIFwiaWRcImApO1xuXHRcdFx0XHQvLyBWYWxpZGF0ZSBjb250ZXh0V2luZG93L21heFRva2VucyBvbmx5IGlmIHByb3ZpZGVkICh0aGV5IGhhdmUgZGVmYXVsdHMpXG5cdFx0XHRcdGlmIChtb2RlbERlZi5jb250ZXh0V2luZG93ICE9PSB1bmRlZmluZWQgJiYgbW9kZWxEZWYuY29udGV4dFdpbmRvdyA8PSAwKVxuXHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcihgUHJvdmlkZXIgJHtwcm92aWRlck5hbWV9LCBtb2RlbCAke21vZGVsRGVmLmlkfTogaW52YWxpZCBjb250ZXh0V2luZG93YCk7XG5cdFx0XHRcdGlmIChtb2RlbERlZi5tYXhUb2tlbnMgIT09IHVuZGVmaW5lZCAmJiBtb2RlbERlZi5tYXhUb2tlbnMgPD0gMClcblx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoYFByb3ZpZGVyICR7cHJvdmlkZXJOYW1lfSwgbW9kZWwgJHttb2RlbERlZi5pZH06IGludmFsaWQgbWF4VG9rZW5zYCk7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBwYXJzZU1vZGVscyhjb25maWc6IE1vZGVsc0NvbmZpZyk6IE1vZGVsPEFwaT5bXSB7XG5cdFx0Y29uc3QgbW9kZWxzOiBNb2RlbDxBcGk+W10gPSBbXTtcblxuXHRcdGZvciAoY29uc3QgW3Byb3ZpZGVyTmFtZSwgcHJvdmlkZXJDb25maWddIG9mIE9iamVjdC5lbnRyaWVzKGNvbmZpZy5wcm92aWRlcnMpKSB7XG5cdFx0XHRjb25zdCBtb2RlbERlZnMgPSBwcm92aWRlckNvbmZpZy5tb2RlbHMgPz8gW107XG5cdFx0XHRpZiAobW9kZWxEZWZzLmxlbmd0aCA9PT0gMCkgY29udGludWU7IC8vIE92ZXJyaWRlLW9ubHksIG5vIGN1c3RvbSBtb2RlbHNcblxuXHRcdFx0Ly8gU3RvcmUgQVBJIGtleSBjb25maWcgZm9yIGZhbGxiYWNrIHJlc29sdmVyXG5cdFx0XHRpZiAocHJvdmlkZXJDb25maWcuYXBpS2V5KSB7XG5cdFx0XHRcdHRoaXMuY3VzdG9tUHJvdmlkZXJBcGlLZXlzLnNldChwcm92aWRlck5hbWUsIHByb3ZpZGVyQ29uZmlnLmFwaUtleSk7XG5cdFx0XHR9XG5cblx0XHRcdC8vIFJlZ2lzdGVyIGN1c3RvbSBwcm92aWRlcnMgc28gaXNQcm92aWRlclJlcXVlc3RSZWFkeSgpIGNhbiBmaW5kXG5cdFx0XHQvLyB0aGVtICgjMzUzMSkuIFdpdGhvdXQgdGhpcywgbW9kZWxzLmpzb24gcHJvdmlkZXJzIHdpdGggYXBpS2V5XG5cdFx0XHQvLyBmYWlsIHRoZSBhdXRoIGNoZWNrIGFuZCBhcmUgaW52aXNpYmxlIHRvIHRoZSBmYWxsYmFjayByZXNvbHZlci5cblx0XHRcdGlmICghdGhpcy5yZWdpc3RlcmVkUHJvdmlkZXJzLmhhcyhwcm92aWRlck5hbWUpKSB7XG5cdFx0XHRcdHRoaXMucmVnaXN0ZXJlZFByb3ZpZGVycy5zZXQocHJvdmlkZXJOYW1lLCB7XG5cdFx0XHRcdFx0YXV0aE1vZGU6IHByb3ZpZGVyQ29uZmlnLmFwaUtleSA/IFwiYXBpS2V5XCIgOiBcIm5vbmVcIixcblx0XHRcdFx0XHRhcGlLZXk6IHByb3ZpZGVyQ29uZmlnLmFwaUtleSxcblx0XHRcdFx0XHRiYXNlVXJsOiBwcm92aWRlckNvbmZpZy5iYXNlVXJsLFxuXHRcdFx0XHRcdGlzUmVhZHk6IHByb3ZpZGVyQ29uZmlnLmFwaUtleSA/ICgpID0+IHRydWUgOiB1bmRlZmluZWQsXG5cdFx0XHRcdH0gYXMgYW55KTtcblx0XHRcdH1cblxuXHRcdFx0Zm9yIChjb25zdCBtb2RlbERlZiBvZiBtb2RlbERlZnMpIHtcblx0XHRcdFx0Y29uc3QgYXBpID0gbW9kZWxEZWYuYXBpIHx8IHByb3ZpZGVyQ29uZmlnLmFwaTtcblx0XHRcdFx0aWYgKCFhcGkpIGNvbnRpbnVlO1xuXG5cdFx0XHRcdC8vIE1lcmdlIGhlYWRlcnM6IHByb3ZpZGVyIGhlYWRlcnMgYXJlIGJhc2UsIG1vZGVsIGhlYWRlcnMgb3ZlcnJpZGVcblx0XHRcdFx0Ly8gUmVzb2x2ZSBlbnYgdmFycyBhbmQgc2hlbGwgY29tbWFuZHMgaW4gaGVhZGVyIHZhbHVlc1xuXHRcdFx0XHRjb25zdCBwcm92aWRlckhlYWRlcnMgPSByZXNvbHZlSGVhZGVycyhwcm92aWRlckNvbmZpZy5oZWFkZXJzKTtcblx0XHRcdFx0Y29uc3QgbW9kZWxIZWFkZXJzID0gcmVzb2x2ZUhlYWRlcnMobW9kZWxEZWYuaGVhZGVycyk7XG5cdFx0XHRcdGxldCBoZWFkZXJzID0gcHJvdmlkZXJIZWFkZXJzIHx8IG1vZGVsSGVhZGVycyA/IHsgLi4ucHJvdmlkZXJIZWFkZXJzLCAuLi5tb2RlbEhlYWRlcnMgfSA6IHVuZGVmaW5lZDtcblxuXHRcdFx0XHQvLyBJZiBhdXRoSGVhZGVyIGlzIHRydWUsIGFkZCBBdXRob3JpemF0aW9uIGhlYWRlciB3aXRoIHJlc29sdmVkIEFQSSBrZXlcblx0XHRcdFx0aWYgKHByb3ZpZGVyQ29uZmlnLmF1dGhIZWFkZXIgJiYgcHJvdmlkZXJDb25maWcuYXBpS2V5KSB7XG5cdFx0XHRcdFx0Y29uc3QgcmVzb2x2ZWRLZXkgPSByZXNvbHZlQ29uZmlnVmFsdWUocHJvdmlkZXJDb25maWcuYXBpS2V5KTtcblx0XHRcdFx0XHRpZiAocmVzb2x2ZWRLZXkpIHtcblx0XHRcdFx0XHRcdGhlYWRlcnMgPSB7IC4uLmhlYWRlcnMsIEF1dGhvcml6YXRpb246IGBCZWFyZXIgJHtyZXNvbHZlZEtleX1gIH07XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gUHJvdmlkZXIgYmFzZVVybCBpcyByZXF1aXJlZCB3aGVuIGN1c3RvbSBtb2RlbHMgYXJlIGRlZmluZWQuXG5cdFx0XHRcdC8vIEluZGl2aWR1YWwgbW9kZWxzIGNhbiBvdmVycmlkZSBpdCB3aXRoIG1vZGVsRGVmLmJhc2VVcmwuXG5cdFx0XHRcdGNvbnN0IGRlZmF1bHRDb3N0ID0geyBpbnB1dDogMCwgb3V0cHV0OiAwLCBjYWNoZVJlYWQ6IDAsIGNhY2hlV3JpdGU6IDAgfTtcblx0XHRcdFx0bW9kZWxzLnB1c2goe1xuXHRcdFx0XHRcdGlkOiBtb2RlbERlZi5pZCxcblx0XHRcdFx0XHRuYW1lOiBtb2RlbERlZi5uYW1lID8/IG1vZGVsRGVmLmlkLFxuXHRcdFx0XHRcdGFwaTogYXBpIGFzIEFwaSxcblx0XHRcdFx0XHRwcm92aWRlcjogcHJvdmlkZXJOYW1lLFxuXHRcdFx0XHRcdGJhc2VVcmw6IG1vZGVsRGVmLmJhc2VVcmwgPz8gcHJvdmlkZXJDb25maWcuYmFzZVVybCEsXG5cdFx0XHRcdFx0cmVhc29uaW5nOiBtb2RlbERlZi5yZWFzb25pbmcgPz8gZmFsc2UsXG5cdFx0XHRcdFx0aW5wdXQ6IChtb2RlbERlZi5pbnB1dCA/PyBbXCJ0ZXh0XCJdKSBhcyAoXCJ0ZXh0XCIgfCBcImltYWdlXCIpW10sXG5cdFx0XHRcdFx0Y29zdDogbW9kZWxEZWYuY29zdCA/PyBkZWZhdWx0Q29zdCxcblx0XHRcdFx0XHRjb250ZXh0V2luZG93OiBtb2RlbERlZi5jb250ZXh0V2luZG93ID8/IDEyODAwMCxcblx0XHRcdFx0XHRtYXhUb2tlbnM6IG1vZGVsRGVmLm1heFRva2VucyA/PyAxNjM4NCxcblx0XHRcdFx0XHRoZWFkZXJzLFxuXHRcdFx0XHRcdGNvbXBhdDogbW9kZWxEZWYuY29tcGF0LFxuXHRcdFx0XHRcdGNhcGFiaWxpdGllczogbW9kZWxEZWYuY2FwYWJpbGl0aWVzLFxuXHRcdFx0XHR9IGFzIE1vZGVsPEFwaT4pO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdHJldHVybiBtb2RlbHM7XG5cdH1cblxuXHQvKipcblx0ICogR2V0IGFsbCBtb2RlbHMgKGJ1aWx0LWluICsgY3VzdG9tKS5cblx0ICogSWYgbW9kZWxzLmpzb24gaGFkIGVycm9ycywgcmV0dXJucyBvbmx5IGJ1aWx0LWluIG1vZGVscy5cblx0ICovXG5cdGdldEFsbCgpOiBNb2RlbDxBcGk+W10ge1xuXHRcdHJldHVybiB0aGlzLm1vZGVscztcblx0fVxuXG5cdC8qKlxuXHQgKiBHZXQgb25seSBtb2RlbHMgdGhhdCBoYXZlIGF1dGggY29uZmlndXJlZC5cblx0ICogVGhpcyBpcyBhIGZhc3QgY2hlY2sgdGhhdCBkb2Vzbid0IHJlZnJlc2ggT0F1dGggdG9rZW5zLlxuXHQgKi9cblx0Z2V0QXZhaWxhYmxlKCk6IE1vZGVsPEFwaT5bXSB7XG5cdFx0cmV0dXJuIHRoaXMubW9kZWxzLmZpbHRlcigobSkgPT4gdGhpcy5pc1Byb3ZpZGVyUmVxdWVzdFJlYWR5KG0ucHJvdmlkZXIpKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBTZXQgcHJvdmlkZXIgSURzIHRoYXQgc2hvdWxkIGJlIGV4Y2x1ZGVkIGZyb20gbW9kZWwgc2VsZWN0aW9uL3JvdXRpbmcuXG5cdCAqIFRoaXMgZG9lcyBub3QgYWZmZWN0IGRpcmVjdCB0b29sIGF1dGggZmxvd3MgdGhhdCByZXNvbHZlIHByb3ZpZGVyIGtleXMuXG5cdCAqL1xuXHRzZXREaXNhYmxlZE1vZGVsUHJvdmlkZXJzKHByb3ZpZGVyczogc3RyaW5nW10pOiB2b2lkIHtcblx0XHR0aGlzLmRpc2FibGVkTW9kZWxQcm92aWRlcnMgPSBuZXcgU2V0KFxuXHRcdFx0cHJvdmlkZXJzXG5cdFx0XHRcdC5tYXAoKHByb3ZpZGVyKSA9PiBwcm92aWRlci50cmltKCkudG9Mb3dlckNhc2UoKSlcblx0XHRcdFx0LmZpbHRlcigocHJvdmlkZXIpID0+IHByb3ZpZGVyLmxlbmd0aCA+IDApLFxuXHRcdCk7XG5cdH1cblxuXHQvKipcblx0ICogR2V0IGN1cnJlbnQgcHJvdmlkZXIgZGVueWxpc3QgdXNlZCBmb3IgbW9kZWwgc2VsZWN0aW9uL3JvdXRpbmcuXG5cdCAqL1xuXHRnZXREaXNhYmxlZE1vZGVsUHJvdmlkZXJzKCk6IHN0cmluZ1tdIHtcblx0XHRyZXR1cm4gQXJyYXkuZnJvbSh0aGlzLmRpc2FibGVkTW9kZWxQcm92aWRlcnMpO1xuXHR9XG5cblx0LyoqXG5cdCAqIEdldCBhdXRoIG1vZGUgZm9yIGEgcHJvdmlkZXIuXG5cdCAqIERlZmF1bHRzIHRvIFwiYXBpS2V5XCIgZm9yIGJ1aWx0LWlucyBhbmQgcHJvdmlkZXJzIHdpdGhvdXQgZXhwbGljaXQgbW9kZS5cblx0ICovXG5cdGdldFByb3ZpZGVyQXV0aE1vZGUocHJvdmlkZXI6IHN0cmluZyk6IFByb3ZpZGVyQXV0aE1vZGUge1xuXHRcdC8vIEUyRS10ZXN0LW9ubHk6IHRoZSBmYWtlIHByb3ZpZGVyIGlzIGtleWxlc3MuIFNlbnRpbmVsIGlzIHByb2plY3QtXG5cdFx0Ly8gaW50ZXJuYWwgKFwiZ3NkLWZha2VcIikgc28gaXQgY2Fubm90IGNvbGxpZGUgd2l0aCBhIHJlYWwgcHJvdmlkZXIuXG5cdFx0Ly8gU2VlIHBhY2thZ2VzL3BpLWFpL3NyYy9wcm92aWRlcnMvZmFrZS50cy5cblx0XHRpZiAocHJvdmlkZXIgPT09IFwiZ3NkLWZha2VcIikgcmV0dXJuIFwibm9uZVwiO1xuXHRcdGNvbnN0IGNvbmZpZyA9IHRoaXMucmVnaXN0ZXJlZFByb3ZpZGVycy5nZXQocHJvdmlkZXIpO1xuXHRcdGlmICghY29uZmlnKSByZXR1cm4gXCJhcGlLZXlcIjtcblx0XHRpZiAoY29uZmlnLmF1dGhNb2RlKSByZXR1cm4gY29uZmlnLmF1dGhNb2RlO1xuXHRcdGlmIChjb25maWcub2F1dGgpIHJldHVybiBcIm9hdXRoXCI7XG5cdFx0aWYgKGNvbmZpZy5hcGlLZXkpIHJldHVybiBcImFwaUtleVwiO1xuXHRcdHJldHVybiBcImFwaUtleVwiO1xuXHR9XG5cblx0LyoqXG5cdCAqIFdoZXRoZXIgYSBwcm92aWRlciBjYW4gYmUgdXNlZCBmb3IgcmVxdWVzdHMvZmFsbGJhY2sgd2l0aG91dCBoYXJkIGF1dGggZ2F0aW5nLlxuXHQgKi9cblx0aXNQcm92aWRlclJlcXVlc3RSZWFkeShwcm92aWRlcjogc3RyaW5nKTogYm9vbGVhbiB7XG5cdFx0aWYgKHRoaXMuZGlzYWJsZWRNb2RlbFByb3ZpZGVycy5oYXMocHJvdmlkZXIudHJpbSgpLnRvTG93ZXJDYXNlKCkpKSByZXR1cm4gZmFsc2U7XG5cdFx0Y29uc3QgY29uZmlnID0gdGhpcy5yZWdpc3RlcmVkUHJvdmlkZXJzLmdldChwcm92aWRlcik7XG5cdFx0aWYgKGNvbmZpZz8uaXNSZWFkeSkgcmV0dXJuIGNvbmZpZy5pc1JlYWR5KCk7XG5cdFx0Y29uc3QgYXV0aE1vZGUgPSB0aGlzLmdldFByb3ZpZGVyQXV0aE1vZGUocHJvdmlkZXIpO1xuXHRcdGlmIChhdXRoTW9kZSA9PT0gXCJleHRlcm5hbENsaVwiIHx8IGF1dGhNb2RlID09PSBcIm5vbmVcIikgcmV0dXJuIHRydWU7XG5cdFx0cmV0dXJuIHRoaXMuYXV0aFN0b3JhZ2UuaGFzQXV0aChwcm92aWRlcik7XG5cdH1cblxuXHQvKipcblx0ICogRmluZCBhIG1vZGVsIGJ5IHByb3ZpZGVyIGFuZCBJRC5cblx0ICovXG5cdGZpbmQocHJvdmlkZXI6IHN0cmluZywgbW9kZWxJZDogc3RyaW5nKTogTW9kZWw8QXBpPiB8IHVuZGVmaW5lZCB7XG5cdFx0cmV0dXJuIHRoaXMubW9kZWxzLmZpbmQoKG0pID0+IG0ucHJvdmlkZXIgPT09IHByb3ZpZGVyICYmIG0uaWQgPT09IG1vZGVsSWQpO1xuXHR9XG5cblx0LyoqXG5cdCAqIEdldCBBUEkga2V5IGZvciBhIG1vZGVsLlxuXHQgKiBSZXR1cm5zIHVuZGVmaW5lZCBmb3IgZXh0ZXJuYWxDbGkvbm9uZSBwcm92aWRlcnMgKG5vIGtleSBuZWVkZWQpLlxuXHQgKiBAcGFyYW0gc2Vzc2lvbklkIC0gT3B0aW9uYWwgc2Vzc2lvbiBJRCBmb3Igc3RpY2t5IGNyZWRlbnRpYWwgc2VsZWN0aW9uXG5cdCAqL1xuXHRhc3luYyBnZXRBcGlLZXkobW9kZWw6IE1vZGVsPEFwaT4sIHNlc3Npb25JZD86IHN0cmluZyk6IFByb21pc2U8c3RyaW5nIHwgdW5kZWZpbmVkPiB7XG5cdFx0Y29uc3QgYXV0aE1vZGUgPSB0aGlzLmdldFByb3ZpZGVyQXV0aE1vZGUobW9kZWwucHJvdmlkZXIpO1xuXHRcdGlmIChhdXRoTW9kZSA9PT0gXCJleHRlcm5hbENsaVwiIHx8IGF1dGhNb2RlID09PSBcIm5vbmVcIikgcmV0dXJuIHVuZGVmaW5lZDtcblx0XHRyZXR1cm4gdGhpcy5hdXRoU3RvcmFnZS5nZXRBcGlLZXkobW9kZWwucHJvdmlkZXIsIHNlc3Npb25JZCwgeyBiYXNlVXJsOiBtb2RlbC5iYXNlVXJsIH0pO1xuXHR9XG5cblx0LyoqXG5cdCAqIEdldCBBUEkga2V5IGZvciBhIHByb3ZpZGVyLlxuXHQgKiBSZXR1cm5zIHVuZGVmaW5lZCBmb3IgZXh0ZXJuYWxDbGkvbm9uZSBwcm92aWRlcnMgKG5vIGtleSBuZWVkZWQpLlxuXHQgKiBAcGFyYW0gc2Vzc2lvbklkIC0gT3B0aW9uYWwgc2Vzc2lvbiBJRCBmb3Igc3RpY2t5IGNyZWRlbnRpYWwgc2VsZWN0aW9uXG5cdCAqL1xuXHRhc3luYyBnZXRBcGlLZXlGb3JQcm92aWRlcihwcm92aWRlcjogc3RyaW5nLCBzZXNzaW9uSWQ/OiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZyB8IHVuZGVmaW5lZD4ge1xuXHRcdGNvbnN0IGF1dGhNb2RlID0gdGhpcy5nZXRQcm92aWRlckF1dGhNb2RlKHByb3ZpZGVyKTtcblx0XHRpZiAoYXV0aE1vZGUgPT09IFwiZXh0ZXJuYWxDbGlcIiB8fCBhdXRoTW9kZSA9PT0gXCJub25lXCIpIHJldHVybiB1bmRlZmluZWQ7XG5cdFx0cmV0dXJuIHRoaXMuYXV0aFN0b3JhZ2UuZ2V0QXBpS2V5KHByb3ZpZGVyLCBzZXNzaW9uSWQpO1xuXHR9XG5cblx0LyoqXG5cdCAqIENoZWNrIGlmIGEgbW9kZWwgaXMgdXNpbmcgT0F1dGggY3JlZGVudGlhbHMgKHN1YnNjcmlwdGlvbikuXG5cdCAqL1xuXHRpc1VzaW5nT0F1dGgobW9kZWw6IE1vZGVsPEFwaT4pOiBib29sZWFuIHtcblx0XHRjb25zdCBjcmVkID0gdGhpcy5hdXRoU3RvcmFnZS5nZXQobW9kZWwucHJvdmlkZXIpO1xuXHRcdHJldHVybiBjcmVkPy50eXBlID09PSBcIm9hdXRoXCI7XG5cdH1cblxuXHQvKipcblx0ICogUmVnaXN0ZXIgYSBwcm92aWRlciBkeW5hbWljYWxseSAoZnJvbSBleHRlbnNpb25zKS5cblx0ICpcblx0ICogSWYgcHJvdmlkZXIgaGFzIG1vZGVsczogcmVwbGFjZXMgYWxsIGV4aXN0aW5nIG1vZGVscyBmb3IgdGhpcyBwcm92aWRlci5cblx0ICogSWYgcHJvdmlkZXIgaGFzIG9ubHkgYmFzZVVybC9oZWFkZXJzOiBvdmVycmlkZXMgZXhpc3RpbmcgbW9kZWxzJyBVUkxzLlxuXHQgKiBJZiBwcm92aWRlciBoYXMgb2F1dGg6IHJlZ2lzdGVycyBPQXV0aCBwcm92aWRlciBmb3IgL2xvZ2luIHN1cHBvcnQuXG5cdCAqL1xuXHRyZWdpc3RlclByb3ZpZGVyKHByb3ZpZGVyTmFtZTogc3RyaW5nLCBjb25maWc6IFByb3ZpZGVyQ29uZmlnSW5wdXQpOiB2b2lkIHtcblx0XHR0aGlzLnJlZ2lzdGVyZWRQcm92aWRlcnMuc2V0KHByb3ZpZGVyTmFtZSwgY29uZmlnKTtcblx0XHR0aGlzLmFwcGx5UHJvdmlkZXJDb25maWcocHJvdmlkZXJOYW1lLCBjb25maWcpO1xuXHR9XG5cblx0LyoqXG5cdCAqIFVucmVnaXN0ZXIgYSBwcmV2aW91c2x5IHJlZ2lzdGVyZWQgcHJvdmlkZXIuXG5cdCAqXG5cdCAqIFJlbW92ZXMgdGhlIHByb3ZpZGVyIGZyb20gdGhlIHJlZ2lzdHJ5IGFuZCByZWxvYWRzIG1vZGVscyBmcm9tIGRpc2sgc28gdGhhdFxuXHQgKiBidWlsdC1pbiBtb2RlbHMgb3ZlcnJpZGRlbiBieSB0aGlzIHByb3ZpZGVyIGFyZSByZXN0b3JlZCB0byB0aGVpciBvcmlnaW5hbCBzdGF0ZS5cblx0ICogQWxzbyByZXNldHMgZHluYW1pYyBPQXV0aCBhbmQgQVBJIHN0cmVhbSByZWdpc3RyYXRpb25zIGJlZm9yZSByZWFwcGx5aW5nXG5cdCAqIHJlbWFpbmluZyBkeW5hbWljIHByb3ZpZGVycy5cblx0ICogSGFzIG5vIGVmZmVjdCBpZiB0aGUgcHJvdmlkZXIgd2FzIG5ldmVyIHJlZ2lzdGVyZWQuXG5cdCAqL1xuXHR1bnJlZ2lzdGVyUHJvdmlkZXIocHJvdmlkZXJOYW1lOiBzdHJpbmcpOiB2b2lkIHtcblx0XHRpZiAoIXRoaXMucmVnaXN0ZXJlZFByb3ZpZGVycy5oYXMocHJvdmlkZXJOYW1lKSkgcmV0dXJuO1xuXHRcdHRoaXMucmVnaXN0ZXJlZFByb3ZpZGVycy5kZWxldGUocHJvdmlkZXJOYW1lKTtcblx0XHR0aGlzLmN1c3RvbVByb3ZpZGVyQXBpS2V5cy5kZWxldGUocHJvdmlkZXJOYW1lKTtcblx0XHR0aGlzLnJlZnJlc2goKTtcblx0fVxuXG5cdHByaXZhdGUgYXBwbHlQcm92aWRlckNvbmZpZyhwcm92aWRlck5hbWU6IHN0cmluZywgY29uZmlnOiBQcm92aWRlckNvbmZpZ0lucHV0KTogdm9pZCB7XG5cdFx0Ly8gUmVnaXN0ZXIgT0F1dGggcHJvdmlkZXIgaWYgcHJvdmlkZWRcblx0XHRpZiAoY29uZmlnLm9hdXRoKSB7XG5cdFx0XHQvLyBFbnN1cmUgdGhlIE9BdXRoIHByb3ZpZGVyIElEIG1hdGNoZXMgdGhlIHByb3ZpZGVyIG5hbWVcblx0XHRcdGNvbnN0IG9hdXRoUHJvdmlkZXI6IE9BdXRoUHJvdmlkZXJJbnRlcmZhY2UgPSB7XG5cdFx0XHRcdC4uLmNvbmZpZy5vYXV0aCxcblx0XHRcdFx0aWQ6IHByb3ZpZGVyTmFtZSxcblx0XHRcdH07XG5cdFx0XHRyZWdpc3Rlck9BdXRoUHJvdmlkZXIob2F1dGhQcm92aWRlcik7XG5cdFx0fVxuXG5cdFx0aWYgKGNvbmZpZy5zdHJlYW1TaW1wbGUpIHtcblx0XHRcdGlmICghY29uZmlnLmFwaSkge1xuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoYFByb3ZpZGVyICR7cHJvdmlkZXJOYW1lfTogXCJhcGlcIiBpcyByZXF1aXJlZCB3aGVuIHJlZ2lzdGVyaW5nIHN0cmVhbVNpbXBsZS5gKTtcblx0XHRcdH1cblx0XHRcdGNvbnN0IHJhd1N0cmVhbVNpbXBsZSA9IGNvbmZpZy5zdHJlYW1TaW1wbGU7XG5cdFx0XHRjb25zdCBhdXRoTW9kZSA9IGNvbmZpZy5hdXRoTW9kZSA/PyBcImFwaUtleVwiO1xuXG5cdFx0XHQvLyBLZXlsZXNzIHByb3ZpZGVycyBuZXZlciBzZWUgYXBpS2V5IGluIG9wdGlvbnMgXHUyMDE0IGVuZm9yY2VkIGF0IHJlZ2lzdHJhdGlvbixcblx0XHRcdC8vIG5vdCBieSBjb252ZW50aW9uLiBQcmV2ZW50cyB1bmRlZmluZWQgZnJvbSByZWFjaGluZyBhbnkgaGFuZGxlci5cblx0XHRcdGNvbnN0IHN0cmVhbVNpbXBsZSA9IChhdXRoTW9kZSA9PT0gXCJleHRlcm5hbENsaVwiIHx8IGF1dGhNb2RlID09PSBcIm5vbmVcIilcblx0XHRcdFx0PyAoKG1vZGVsOiBNb2RlbDxBcGk+LCBjb250ZXh0OiBDb250ZXh0LCBvcHRpb25zPzogU2ltcGxlU3RyZWFtT3B0aW9ucykgPT4ge1xuXHRcdFx0XHRcdFx0Y29uc3QgeyBhcGlLZXk6IF8sIC4uLm9wdHMgfSA9IG9wdGlvbnMgPz8ge307XG5cdFx0XHRcdFx0XHRyZXR1cm4gcmF3U3RyZWFtU2ltcGxlKG1vZGVsLCBjb250ZXh0LCBvcHRzIGFzIFNpbXBsZVN0cmVhbU9wdGlvbnMpO1xuXHRcdFx0XHRcdH0pXG5cdFx0XHRcdDogcmF3U3RyZWFtU2ltcGxlO1xuXG5cdFx0XHQvLyBHdWFyZDogaWYgdGhlcmUncyBhbHJlYWR5IGEgaGFuZGxlciByZWdpc3RlcmVkIGZvciB0aGlzIEFQSSwgd3JhcFxuXHRcdFx0Ly8gdGhlIG5ldyBvbmUgc28gaXQgb25seSBmaXJlcyBmb3IgbW9kZWxzIGZyb20gdGhpcyBwcm92aWRlciBhbmRcblx0XHRcdC8vIGRlbGVnYXRlcyB0byB0aGUgcHJldmlvdXMgaGFuZGxlciBmb3IgYWxsIG90aGVyIHByb3ZpZGVycy4gV2l0aG91dFxuXHRcdFx0Ly8gdGhpcywgYSBjdXN0b20gcHJvdmlkZXIgdXNpbmcgYXBpOlwiYW50aHJvcGljLW1lc3NhZ2VzXCIgd291bGQgY2xvYmJlclxuXHRcdFx0Ly8gdGhlIGJ1aWx0LWluIEFudGhyb3BpYyBzdHJlYW0gaGFuZGxlciAoIzI1MzYpLlxuXHRcdFx0Y29uc3QgZXhpc3RpbmdQcm92aWRlciA9IGdldEFwaVByb3ZpZGVyKGNvbmZpZy5hcGkgYXMgQXBpKTtcblx0XHRcdGNvbnN0IHNjb3BlZFN0cmVhbSA9IGV4aXN0aW5nUHJvdmlkZXJcblx0XHRcdFx0PyAobW9kZWw6IE1vZGVsPEFwaT4sIGNvbnRleHQ6IENvbnRleHQsIG9wdGlvbnM/OiBTaW1wbGVTdHJlYW1PcHRpb25zKTogQXNzaXN0YW50TWVzc2FnZUV2ZW50U3RyZWFtID0+IHtcblx0XHRcdFx0XHRcdGlmIChtb2RlbC5wcm92aWRlciA9PT0gcHJvdmlkZXJOYW1lKSB7XG5cdFx0XHRcdFx0XHRcdHJldHVybiBzdHJlYW1TaW1wbGUobW9kZWwsIGNvbnRleHQsIG9wdGlvbnMpO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0cmV0dXJuIGV4aXN0aW5nUHJvdmlkZXIuc3RyZWFtU2ltcGxlKG1vZGVsLCBjb250ZXh0LCBvcHRpb25zKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdDogc3RyZWFtU2ltcGxlO1xuXG5cdFx0XHRjb25zdCBuZXdGdWxsU3RyZWFtID0gKG1vZGVsOiBNb2RlbDxBcGk+LCBjb250ZXh0OiBDb250ZXh0LCBvcHRpb25zPzogU2ltcGxlU3RyZWFtT3B0aW9ucykgPT5cblx0XHRcdFx0c2NvcGVkU3RyZWFtKG1vZGVsLCBjb250ZXh0LCBvcHRpb25zIGFzIFNpbXBsZVN0cmVhbU9wdGlvbnMpO1xuXHRcdFx0Y29uc3Qgc2NvcGVkRnVsbFN0cmVhbSA9IGV4aXN0aW5nUHJvdmlkZXJcblx0XHRcdFx0PyAobW9kZWw6IE1vZGVsPEFwaT4sIGNvbnRleHQ6IENvbnRleHQsIG9wdGlvbnM/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4ge1xuXHRcdFx0XHRcdFx0aWYgKG1vZGVsLnByb3ZpZGVyID09PSBwcm92aWRlck5hbWUpIHtcblx0XHRcdFx0XHRcdFx0cmV0dXJuIG5ld0Z1bGxTdHJlYW0obW9kZWwsIGNvbnRleHQsIG9wdGlvbnMgYXMgU2ltcGxlU3RyZWFtT3B0aW9ucyk7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRyZXR1cm4gZXhpc3RpbmdQcm92aWRlci5zdHJlYW0obW9kZWwsIGNvbnRleHQsIG9wdGlvbnMpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0OiBuZXdGdWxsU3RyZWFtO1xuXG5cdFx0XHRyZWdpc3RlckFwaVByb3ZpZGVyKFxuXHRcdFx0XHR7XG5cdFx0XHRcdFx0YXBpOiBjb25maWcuYXBpLFxuXHRcdFx0XHRcdHN0cmVhbTogc2NvcGVkRnVsbFN0cmVhbSBhcyBhbnksXG5cdFx0XHRcdFx0c3RyZWFtU2ltcGxlOiBzY29wZWRTdHJlYW0sXG5cdFx0XHRcdH0sXG5cdFx0XHRcdGBwcm92aWRlcjoke3Byb3ZpZGVyTmFtZX1gLFxuXHRcdFx0KTtcblx0XHR9XG5cblx0XHQvLyBTdG9yZSBBUEkga2V5IGZvciBhdXRoIHJlc29sdXRpb25cblx0XHRpZiAoY29uZmlnLmFwaUtleSkge1xuXHRcdFx0dGhpcy5jdXN0b21Qcm92aWRlckFwaUtleXMuc2V0KHByb3ZpZGVyTmFtZSwgY29uZmlnLmFwaUtleSk7XG5cdFx0fVxuXG5cdFx0aWYgKGNvbmZpZy5tb2RlbHMgJiYgY29uZmlnLm1vZGVscy5sZW5ndGggPiAwKSB7XG5cdFx0XHQvLyBGdWxsIHJlcGxhY2VtZW50OiByZW1vdmUgZXhpc3RpbmcgbW9kZWxzIGZvciB0aGlzIHByb3ZpZGVyXG5cdFx0XHR0aGlzLm1vZGVscyA9IHRoaXMubW9kZWxzLmZpbHRlcigobSkgPT4gbS5wcm92aWRlciAhPT0gcHJvdmlkZXJOYW1lKTtcblxuXHRcdFx0Ly8gVmFsaWRhdGUgcmVxdWlyZWQgZmllbGRzXG5cdFx0XHRpZiAoIWNvbmZpZy5iYXNlVXJsKSB7XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihgUHJvdmlkZXIgJHtwcm92aWRlck5hbWV9OiBcImJhc2VVcmxcIiBpcyByZXF1aXJlZCB3aGVuIGRlZmluaW5nIG1vZGVscy5gKTtcblx0XHRcdH1cblx0XHRcdGNvbnN0IGF1dGhNb2RlID0gY29uZmlnLmF1dGhNb2RlID8/IChjb25maWcub2F1dGggPyBcIm9hdXRoXCIgOiBjb25maWcuYXBpS2V5ID8gXCJhcGlLZXlcIiA6IFwiYXBpS2V5XCIpO1xuXHRcdFx0aWYgKGF1dGhNb2RlID09PSBcImFwaUtleVwiICYmICFjb25maWcuYXBpS2V5ICYmICFjb25maWcub2F1dGgpIHtcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKFxuXHRcdFx0XHRcdGBQcm92aWRlciAke3Byb3ZpZGVyTmFtZX06IFwiYXBpS2V5XCIgb3IgXCJvYXV0aFwiIGlzIHJlcXVpcmVkIHdoZW4gYXV0aE1vZGUgaXMgXCJhcGlLZXlcIiAodGhlIGRlZmF1bHQpLiBgICtcblx0XHRcdFx0XHRgU2V0IGF1dGhNb2RlIHRvIFwiZXh0ZXJuYWxDbGlcIiBvciBcIm5vbmVcIiBmb3Iga2V5bGVzcyBwcm92aWRlcnMuYCxcblx0XHRcdFx0KTtcblx0XHRcdH1cblx0XHRcdGlmICgoYXV0aE1vZGUgPT09IFwiZXh0ZXJuYWxDbGlcIiB8fCBhdXRoTW9kZSA9PT0gXCJub25lXCIpICYmICFjb25maWcuc3RyZWFtU2ltcGxlKSB7XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihcblx0XHRcdFx0XHRgUHJvdmlkZXIgJHtwcm92aWRlck5hbWV9OiBcInN0cmVhbVNpbXBsZVwiIGlzIHJlcXVpcmVkIHdoZW4gYXV0aE1vZGUgaXMgXCIke2F1dGhNb2RlfVwiLiBgICtcblx0XHRcdFx0XHRgS2V5bGVzcyBwcm92aWRlcnMgbXVzdCBzdXBwbHkgdGhlaXIgb3duIHN0cmVhbSBoYW5kbGVyLmAsXG5cdFx0XHRcdCk7XG5cdFx0XHR9XG5cdFx0XHRpZiAoKGF1dGhNb2RlID09PSBcImV4dGVybmFsQ2xpXCIgfHwgYXV0aE1vZGUgPT09IFwibm9uZVwiKSAmJiBjb25maWcuYXBpS2V5KSB7XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihcblx0XHRcdFx0XHRgUHJvdmlkZXIgJHtwcm92aWRlck5hbWV9OiBcImFwaUtleVwiIGNhbm5vdCBiZSBzZXQgd2hlbiBhdXRoTW9kZSBpcyBcIiR7YXV0aE1vZGV9XCIuIGAgK1xuXHRcdFx0XHRcdGBLZXlsZXNzIHByb3ZpZGVycyBzaG91bGQgbm90IHByb3ZpZGUgQVBJIGtleSBjcmVkZW50aWFscy5gLFxuXHRcdFx0XHQpO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBQYXJzZSBhbmQgYWRkIG5ldyBtb2RlbHNcblx0XHRcdGZvciAoY29uc3QgbW9kZWxEZWYgb2YgY29uZmlnLm1vZGVscykge1xuXHRcdFx0XHRjb25zdCBhcGkgPSBtb2RlbERlZi5hcGkgfHwgY29uZmlnLmFwaTtcblx0XHRcdFx0aWYgKCFhcGkpIHtcblx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoYFByb3ZpZGVyICR7cHJvdmlkZXJOYW1lfSwgbW9kZWwgJHttb2RlbERlZi5pZH06IG5vIFwiYXBpXCIgc3BlY2lmaWVkLmApO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gTWVyZ2UgaGVhZGVyc1xuXHRcdFx0XHRjb25zdCBwcm92aWRlckhlYWRlcnMgPSByZXNvbHZlSGVhZGVycyhjb25maWcuaGVhZGVycyk7XG5cdFx0XHRcdGNvbnN0IG1vZGVsSGVhZGVycyA9IHJlc29sdmVIZWFkZXJzKG1vZGVsRGVmLmhlYWRlcnMpO1xuXHRcdFx0XHRsZXQgaGVhZGVycyA9IHByb3ZpZGVySGVhZGVycyB8fCBtb2RlbEhlYWRlcnMgPyB7IC4uLnByb3ZpZGVySGVhZGVycywgLi4ubW9kZWxIZWFkZXJzIH0gOiB1bmRlZmluZWQ7XG5cblx0XHRcdFx0Ly8gSWYgYXV0aEhlYWRlciBpcyB0cnVlLCBhZGQgQXV0aG9yaXphdGlvbiBoZWFkZXJcblx0XHRcdFx0aWYgKGNvbmZpZy5hdXRoSGVhZGVyICYmIGNvbmZpZy5hcGlLZXkpIHtcblx0XHRcdFx0XHRjb25zdCByZXNvbHZlZEtleSA9IHJlc29sdmVDb25maWdWYWx1ZShjb25maWcuYXBpS2V5KTtcblx0XHRcdFx0XHRpZiAocmVzb2x2ZWRLZXkpIHtcblx0XHRcdFx0XHRcdGhlYWRlcnMgPSB7IC4uLmhlYWRlcnMsIEF1dGhvcml6YXRpb246IGBCZWFyZXIgJHtyZXNvbHZlZEtleX1gIH07XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cblx0XHRcdFx0dGhpcy5tb2RlbHMucHVzaCh7XG5cdFx0XHRcdFx0aWQ6IG1vZGVsRGVmLmlkLFxuXHRcdFx0XHRcdG5hbWU6IG1vZGVsRGVmLm5hbWUsXG5cdFx0XHRcdFx0YXBpOiBhcGkgYXMgQXBpLFxuXHRcdFx0XHRcdHByb3ZpZGVyOiBwcm92aWRlck5hbWUsXG5cdFx0XHRcdFx0YmFzZVVybDogY29uZmlnLmJhc2VVcmwsXG5cdFx0XHRcdFx0cmVhc29uaW5nOiBtb2RlbERlZi5yZWFzb25pbmcsXG5cdFx0XHRcdFx0aW5wdXQ6IG1vZGVsRGVmLmlucHV0IGFzIChcInRleHRcIiB8IFwiaW1hZ2VcIilbXSxcblx0XHRcdFx0XHRjb3N0OiBtb2RlbERlZi5jb3N0LFxuXHRcdFx0XHRcdGNvbnRleHRXaW5kb3c6IG1vZGVsRGVmLmNvbnRleHRXaW5kb3csXG5cdFx0XHRcdFx0bWF4VG9rZW5zOiBtb2RlbERlZi5tYXhUb2tlbnMsXG5cdFx0XHRcdFx0aGVhZGVycyxcblx0XHRcdFx0XHRjb21wYXQ6IG1vZGVsRGVmLmNvbXBhdCxcblx0XHRcdFx0XHRwcm92aWRlck9wdGlvbnM6IG1vZGVsRGVmLnByb3ZpZGVyT3B0aW9ucyxcblx0XHRcdFx0fSBhcyBNb2RlbDxBcGk+KTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gQXBwbHkgT0F1dGggbW9kaWZ5TW9kZWxzIGlmIGNyZWRlbnRpYWxzIGV4aXN0IChlLmcuLCB0byB1cGRhdGUgYmFzZVVybClcblx0XHRcdGlmIChjb25maWcub2F1dGg/Lm1vZGlmeU1vZGVscykge1xuXHRcdFx0XHRjb25zdCBjcmVkID0gdGhpcy5hdXRoU3RvcmFnZS5nZXQocHJvdmlkZXJOYW1lKTtcblx0XHRcdFx0aWYgKGNyZWQ/LnR5cGUgPT09IFwib2F1dGhcIikge1xuXHRcdFx0XHRcdHRoaXMubW9kZWxzID0gY29uZmlnLm9hdXRoLm1vZGlmeU1vZGVscyh0aGlzLm1vZGVscywgY3JlZCk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0Ly8gRW5zdXJlIG5ld2x5IGFkZGVkIGV4dGVuc2lvbiBtb2RlbHMgZ2V0IGNhcGFiaWxpdHkgcGF0Y2hlc1xuXHRcdFx0dGhpcy5tb2RlbHMgPSBhcHBseUNhcGFiaWxpdHlQYXRjaGVzKHRoaXMubW9kZWxzKTtcblx0XHR9IGVsc2UgaWYgKGNvbmZpZy5iYXNlVXJsKSB7XG5cdFx0XHQvLyBPdmVycmlkZS1vbmx5OiB1cGRhdGUgYmFzZVVybC9oZWFkZXJzIGZvciBleGlzdGluZyBtb2RlbHNcblx0XHRcdGNvbnN0IHJlc29sdmVkSGVhZGVycyA9IHJlc29sdmVIZWFkZXJzKGNvbmZpZy5oZWFkZXJzKTtcblx0XHRcdHRoaXMubW9kZWxzID0gdGhpcy5tb2RlbHMubWFwKChtKSA9PiB7XG5cdFx0XHRcdGlmIChtLnByb3ZpZGVyICE9PSBwcm92aWRlck5hbWUpIHJldHVybiBtO1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdC4uLm0sXG5cdFx0XHRcdFx0YmFzZVVybDogY29uZmlnLmJhc2VVcmwgPz8gbS5iYXNlVXJsLFxuXHRcdFx0XHRcdGhlYWRlcnM6IHJlc29sdmVkSGVhZGVycyA/IHsgLi4ubS5oZWFkZXJzLCAuLi5yZXNvbHZlZEhlYWRlcnMgfSA6IG0uaGVhZGVycyxcblx0XHRcdFx0fTtcblx0XHRcdH0pO1xuXHRcdH1cblx0fVxuXG5cdC8qKlxuXHQgKiBEaXNjb3ZlciBtb2RlbHMgZnJvbSBhbGwgcHJvdmlkZXJzIHRoYXQgc3VwcG9ydCBkaXNjb3ZlcnkuXG5cdCAqIFJlc3VsdHMgYXJlIGNhY2hlZCBhbmQgbWVyZ2VkIGludG8gdGhlIHJlZ2lzdHJ5IChuZXZlciBvdmVycmlkZXMgZXhpc3RpbmcgbW9kZWxzKS5cblx0ICovXG5cdGFzeW5jIGRpc2NvdmVyTW9kZWxzKHByb3ZpZGVycz86IHN0cmluZ1tdKTogUHJvbWlzZTxEaXNjb3ZlcnlSZXN1bHRbXT4ge1xuXHRcdGNvbnN0IHRhcmdldFByb3ZpZGVycyA9IHByb3ZpZGVycyA/PyB0aGlzLmdldEF1dG9EaXNjb3ZlcmFibGVQcm92aWRlcnMoKTtcblx0XHRjb25zdCByZXN1bHRzOiBEaXNjb3ZlcnlSZXN1bHRbXSA9IFtdO1xuXG5cdFx0Zm9yIChjb25zdCBwcm92aWRlck5hbWUgb2YgdGFyZ2V0UHJvdmlkZXJzKSB7XG5cdFx0XHRjb25zdCBwcm92aWRlckFwaXMgPSB0aGlzLmdldFByb3ZpZGVyQXBpcyhwcm92aWRlck5hbWUpO1xuXHRcdFx0Y29uc3QgYWRhcHRlciA9IGdldERpc2NvdmVyeUFkYXB0ZXIocHJvdmlkZXJOYW1lLCBwcm92aWRlckFwaXMpO1xuXHRcdFx0aWYgKCFhZGFwdGVyLnN1cHBvcnRzRGlzY292ZXJ5KSBjb250aW51ZTtcblxuXHRcdFx0Ly8gU2tpcCBpZiBjYWNoZSBpcyBzdGlsbCBmcmVzaFxuXHRcdFx0aWYgKCF0aGlzLmRpc2NvdmVyeUNhY2hlLmlzU3RhbGUocHJvdmlkZXJOYW1lKSkge1xuXHRcdFx0XHRjb25zdCBjYWNoZWQgPSB0aGlzLmRpc2NvdmVyeUNhY2hlLmdldChwcm92aWRlck5hbWUpO1xuXHRcdFx0XHRpZiAoY2FjaGVkKSB7XG5cdFx0XHRcdFx0cmVzdWx0cy5wdXNoKHtcblx0XHRcdFx0XHRcdHByb3ZpZGVyOiBwcm92aWRlck5hbWUsXG5cdFx0XHRcdFx0XHRtb2RlbHM6IGNhY2hlZC5tb2RlbHMsXG5cdFx0XHRcdFx0XHRmZXRjaGVkQXQ6IGNhY2hlZC5mZXRjaGVkQXQsXG5cdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0Y29udGludWU7XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0dHJ5IHtcblx0XHRcdFx0Y29uc3QgYXBpS2V5ID0gYXdhaXQgdGhpcy5hdXRoU3RvcmFnZS5nZXRBcGlLZXkocHJvdmlkZXJOYW1lKTtcblx0XHRcdFx0aWYgKCFhcGlLZXkgJiYgIXRoaXMuaXNQcm92aWRlclJlcXVlc3RSZWFkeShwcm92aWRlck5hbWUpKSBjb250aW51ZTtcblxuXHRcdFx0XHRjb25zdCBiYXNlVXJsID0gdGhpcy5nZXRQcm92aWRlckJhc2VVcmwocHJvdmlkZXJOYW1lKTtcblx0XHRcdFx0Y29uc3QgbW9kZWxzID0gYXdhaXQgYWRhcHRlci5mZXRjaE1vZGVscyhhcGlLZXkgPz8gXCJcIiwgYmFzZVVybCk7XG5cdFx0XHRcdGNvbnN0IHR0bE1zID0gdGhpcy5nZXREaXNjb3ZlcnlUdGwocHJvdmlkZXJOYW1lLCBwcm92aWRlckFwaXMpO1xuXHRcdFx0XHR0aGlzLmRpc2NvdmVyeUNhY2hlLnNldChwcm92aWRlck5hbWUsIG1vZGVscywgdHRsTXMpO1xuXHRcdFx0XHRyZXN1bHRzLnB1c2goe1xuXHRcdFx0XHRcdHByb3ZpZGVyOiBwcm92aWRlck5hbWUsXG5cdFx0XHRcdFx0bW9kZWxzLFxuXHRcdFx0XHRcdGZldGNoZWRBdDogRGF0ZS5ub3coKSxcblx0XHRcdFx0fSk7XG5cdFx0XHR9IGNhdGNoIChlcnJvcikge1xuXHRcdFx0XHRyZXN1bHRzLnB1c2goe1xuXHRcdFx0XHRcdHByb3ZpZGVyOiBwcm92aWRlck5hbWUsXG5cdFx0XHRcdFx0bW9kZWxzOiBbXSxcblx0XHRcdFx0XHRmZXRjaGVkQXQ6IERhdGUubm93KCksXG5cdFx0XHRcdFx0ZXJyb3I6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKSxcblx0XHRcdFx0fSk7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0Ly8gQ29udmVydCBhbmQgbWVyZ2UgZGlzY292ZXJlZCBtb2RlbHMsIHRoZW4gYXBwbHkgY2FwYWJpbGl0eSBwYXRjaGVzXG5cdFx0dGhpcy5kaXNjb3ZlcmVkTW9kZWxzID0gYXBwbHlDYXBhYmlsaXR5UGF0Y2hlcyh0aGlzLmNvbnZlcnREaXNjb3ZlcmVkTW9kZWxzKHJlc3VsdHMpKTtcblx0XHRyZXR1cm4gcmVzdWx0cztcblx0fVxuXG5cdC8qKlxuXHQgKiBHZXQgYWxsIG1vZGVscyBpbmNsdWRpbmcgZGlzY292ZXJlZCBvbmVzLlxuXHQgKiBEaXNjb3ZlcmVkIG1vZGVscyBhcmUgYXBwZW5kZWQgYnV0IG5ldmVyIG92ZXJyaWRlIGV4aXN0aW5nIG1vZGVscy5cblx0ICovXG5cdGdldEFsbFdpdGhEaXNjb3ZlcmVkKCk6IE1vZGVsPEFwaT5bXSB7XG5cdFx0Y29uc3QgZXhpc3RpbmdJZHMgPSBuZXcgU2V0KHRoaXMubW9kZWxzLm1hcCgobSkgPT4gYCR7bS5wcm92aWRlcn0vJHttLmlkfWApKTtcblx0XHRjb25zdCB1bmlxdWUgPSB0aGlzLmRpc2NvdmVyZWRNb2RlbHMuZmlsdGVyKChtKSA9PiAhZXhpc3RpbmdJZHMuaGFzKGAke20ucHJvdmlkZXJ9LyR7bS5pZH1gKSk7XG5cdFx0cmV0dXJuIFsuLi50aGlzLm1vZGVscywgLi4udW5pcXVlXTtcblx0fVxuXG5cdC8qKlxuXHQgKiBDaGVjayBpZiBhIG1vZGVsIHdhcyBhZGRlZCB2aWEgZGlzY292ZXJ5IChub3QgYnVpbHQtaW4gb3IgY3VzdG9tKS5cblx0ICovXG5cdGlzRGlzY292ZXJlZChtb2RlbDogTW9kZWw8QXBpPik6IGJvb2xlYW4ge1xuXHRcdHJldHVybiB0aGlzLmRpc2NvdmVyZWRNb2RlbHMuc29tZSgobSkgPT4gbS5wcm92aWRlciA9PT0gbW9kZWwucHJvdmlkZXIgJiYgbS5pZCA9PT0gbW9kZWwuaWQpO1xuXHR9XG5cblx0LyoqXG5cdCAqIEdldCB0aGUgZGlzY292ZXJ5IGNhY2hlIGluc3RhbmNlLlxuXHQgKi9cblx0Z2V0RGlzY292ZXJ5Q2FjaGUoKTogTW9kZWxEaXNjb3ZlcnlDYWNoZSB7XG5cdFx0cmV0dXJuIHRoaXMuZGlzY292ZXJ5Q2FjaGU7XG5cdH1cblxuXHQvKipcblx0ICogQ29udmVydCBEaXNjb3ZlcnlSZXN1bHRbXSBpbnRvIE1vZGVsPEFwaT5bXSB3aXRoIGRlZmF1bHQgdmFsdWVzLlxuXHQgKi9cblx0cHJpdmF0ZSBjb252ZXJ0RGlzY292ZXJlZE1vZGVscyhyZXN1bHRzOiBEaXNjb3ZlcnlSZXN1bHRbXSk6IE1vZGVsPEFwaT5bXSB7XG5cdFx0Y29uc3QgY29udmVydGVkOiBNb2RlbDxBcGk+W10gPSBbXTtcblx0XHRmb3IgKGNvbnN0IHJlc3VsdCBvZiByZXN1bHRzKSB7XG5cdFx0XHRpZiAocmVzdWx0LmVycm9yKSBjb250aW51ZTtcblx0XHRcdGNvbnN0IHByb3ZpZGVyRGVmYXVsdHMgPSB0aGlzLmdldERpc2NvdmVyeVByb3ZpZGVyRGVmYXVsdHMocmVzdWx0LnByb3ZpZGVyKTtcblx0XHRcdGZvciAoY29uc3QgZG0gb2YgcmVzdWx0Lm1vZGVscykge1xuXHRcdFx0XHRjb252ZXJ0ZWQucHVzaCh7XG5cdFx0XHRcdFx0aWQ6IGRtLmlkLFxuXHRcdFx0XHRcdG5hbWU6IGRtLm5hbWUgPz8gZG0uaWQsXG5cdFx0XHRcdFx0YXBpOiBwcm92aWRlckRlZmF1bHRzLmFwaSxcblx0XHRcdFx0XHRwcm92aWRlcjogcmVzdWx0LnByb3ZpZGVyLFxuXHRcdFx0XHRcdGJhc2VVcmw6IHByb3ZpZGVyRGVmYXVsdHMuYmFzZVVybCxcblx0XHRcdFx0XHRyZWFzb25pbmc6IGRtLnJlYXNvbmluZyA/PyBmYWxzZSxcblx0XHRcdFx0XHRpbnB1dDogZG0uaW5wdXQgPz8gcHJvdmlkZXJEZWZhdWx0cy5pbnB1dCxcblx0XHRcdFx0XHRjb3N0OiBkbS5jb3N0ID8/IHsgaW5wdXQ6IDAsIG91dHB1dDogMCwgY2FjaGVSZWFkOiAwLCBjYWNoZVdyaXRlOiAwIH0sXG5cdFx0XHRcdFx0Y29udGV4dFdpbmRvdzogZG0uY29udGV4dFdpbmRvdyA/PyBwcm92aWRlckRlZmF1bHRzLmNvbnRleHRXaW5kb3csXG5cdFx0XHRcdFx0bWF4VG9rZW5zOiBkbS5tYXhUb2tlbnMgPz8gcHJvdmlkZXJEZWZhdWx0cy5tYXhUb2tlbnMsXG5cdFx0XHRcdH0gYXMgTW9kZWw8QXBpPik7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdHJldHVybiBjb252ZXJ0ZWQ7XG5cdH1cblxuXHRwcml2YXRlIGdldFByb3ZpZGVyQXBpcyhwcm92aWRlcjogc3RyaW5nKTogU2V0PHN0cmluZz4ge1xuXHRcdGNvbnN0IGFwaXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcblx0XHRmb3IgKGNvbnN0IG1vZGVsIG9mIHRoaXMubW9kZWxzKSB7XG5cdFx0XHRpZiAobW9kZWwucHJvdmlkZXIgPT09IHByb3ZpZGVyICYmIHR5cGVvZiBtb2RlbC5hcGkgPT09IFwic3RyaW5nXCIgJiYgbW9kZWwuYXBpLmxlbmd0aCA+IDApIHtcblx0XHRcdFx0YXBpcy5hZGQobW9kZWwuYXBpKTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHRjb25zdCBwcm92aWRlckNvbmZpZyA9IHRoaXMucmVnaXN0ZXJlZFByb3ZpZGVycy5nZXQocHJvdmlkZXIpO1xuXHRcdGlmIChwcm92aWRlckNvbmZpZz8uYXBpKSBhcGlzLmFkZChwcm92aWRlckNvbmZpZy5hcGkpO1xuXHRcdGZvciAoY29uc3QgbW9kZWxEZWYgb2YgcHJvdmlkZXJDb25maWc/Lm1vZGVscyA/PyBbXSkge1xuXHRcdFx0aWYgKG1vZGVsRGVmLmFwaSkgYXBpcy5hZGQobW9kZWxEZWYuYXBpKTtcblx0XHR9XG5cdFx0cmV0dXJuIGFwaXM7XG5cdH1cblxuXHRwcml2YXRlIGdldEF1dG9EaXNjb3ZlcmFibGVQcm92aWRlcnMoKTogc3RyaW5nW10ge1xuXHRcdGNvbnN0IGRpc2NvdmVyYWJsZSA9IG5ldyBTZXQ8c3RyaW5nPihnZXREaXNjb3ZlcmFibGVQcm92aWRlcnMoKSk7XG5cdFx0Zm9yIChjb25zdCBwcm92aWRlciBvZiBuZXcgU2V0KHRoaXMubW9kZWxzLm1hcCgobSkgPT4gbS5wcm92aWRlcikpKSB7XG5cdFx0XHRjb25zdCBhcGlzID0gdGhpcy5nZXRQcm92aWRlckFwaXMocHJvdmlkZXIpO1xuXHRcdFx0Zm9yIChjb25zdCBhcGkgb2YgYXBpcykge1xuXHRcdFx0XHRpZiAoc3VwcG9ydHNEaXNjb3ZlcnlGb3JBcGkoYXBpKSkge1xuXHRcdFx0XHRcdGRpc2NvdmVyYWJsZS5hZGQocHJvdmlkZXIpO1xuXHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fVxuXHRcdHJldHVybiBbLi4uZGlzY292ZXJhYmxlXTtcblx0fVxuXG5cdHByaXZhdGUgZ2V0UHJvdmlkZXJCYXNlVXJsKHByb3ZpZGVyOiBzdHJpbmcpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuXHRcdGNvbnN0IGZyb21Nb2RlbHMgPSB0aGlzLm1vZGVscy5maW5kKChtKSA9PiBtLnByb3ZpZGVyID09PSBwcm92aWRlciAmJiB0eXBlb2YgbS5iYXNlVXJsID09PSBcInN0cmluZ1wiICYmIG0uYmFzZVVybC5sZW5ndGggPiAwKTtcblx0XHRpZiAoZnJvbU1vZGVscz8uYmFzZVVybCkgcmV0dXJuIGZyb21Nb2RlbHMuYmFzZVVybDtcblx0XHRyZXR1cm4gdGhpcy5yZWdpc3RlcmVkUHJvdmlkZXJzLmdldChwcm92aWRlcik/LmJhc2VVcmw7XG5cdH1cblxuXHRwcml2YXRlIGdldERpc2NvdmVyeVByb3ZpZGVyRGVmYXVsdHMocHJvdmlkZXI6IHN0cmluZyk6IHtcblx0XHRhcGk6IEFwaTtcblx0XHRiYXNlVXJsOiBzdHJpbmc7XG5cdFx0aW5wdXQ6IChcInRleHRcIiB8IFwiaW1hZ2VcIilbXTtcblx0XHRjb250ZXh0V2luZG93OiBudW1iZXI7XG5cdFx0bWF4VG9rZW5zOiBudW1iZXI7XG5cdH0ge1xuXHRcdGNvbnN0IGZpcnN0ID0gdGhpcy5tb2RlbHMuZmluZCgobSkgPT4gbS5wcm92aWRlciA9PT0gcHJvdmlkZXIpO1xuXHRcdGlmIChmaXJzdCkge1xuXHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0YXBpOiBmaXJzdC5hcGksXG5cdFx0XHRcdGJhc2VVcmw6IGZpcnN0LmJhc2VVcmwsXG5cdFx0XHRcdGlucHV0OiBmaXJzdC5pbnB1dCxcblx0XHRcdFx0Y29udGV4dFdpbmRvdzogZmlyc3QuY29udGV4dFdpbmRvdyxcblx0XHRcdFx0bWF4VG9rZW5zOiBmaXJzdC5tYXhUb2tlbnMsXG5cdFx0XHR9O1xuXHRcdH1cblxuXHRcdHJldHVybiB7XG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRiYXNlVXJsOiB0aGlzLnJlZ2lzdGVyZWRQcm92aWRlcnMuZ2V0KHByb3ZpZGVyKT8uYmFzZVVybCA/PyBcIlwiLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDE2Mzg0LFxuXHRcdH07XG5cdH1cblxuXHRwcml2YXRlIGdldERpc2NvdmVyeVR0bChwcm92aWRlcjogc3RyaW5nLCBwcm92aWRlckFwaXM6IFNldDxzdHJpbmc+KTogbnVtYmVyIHtcblx0XHRmb3IgKGNvbnN0IGFwaSBvZiBwcm92aWRlckFwaXMpIHtcblx0XHRcdGlmIChzdXBwb3J0c0Rpc2NvdmVyeUZvckFwaShhcGkpKSB7XG5cdFx0XHRcdHJldHVybiBnZXREZWZhdWx0VFRMKFwib3BlbmFpXCIpO1xuXHRcdFx0fVxuXHRcdH1cblx0XHRyZXR1cm4gZ2V0RGVmYXVsdFRUTChwcm92aWRlcik7XG5cdH1cblxuXHQvKipcblx0ICogQ2hlY2sgaWYgYSBtb2RlbCdzIGJhc2VVcmwgcG9pbnRzIHRvIGEgbG9jYWwgZW5kcG9pbnQuXG5cdCAqIERlbGVnYXRlcyB0byBzdGFuZGFsb25lIGlzTG9jYWxNb2RlbCgpIGZ1bmN0aW9uLlxuXHQgKi9cblx0c3RhdGljIGlzTG9jYWxNb2RlbChtb2RlbDogTW9kZWw8QXBpPik6IGJvb2xlYW4ge1xuXHRcdHJldHVybiBpc0xvY2FsTW9kZWwobW9kZWwpO1xuXHR9XG5cblx0LyoqXG5cdCAqIENoZWNrIGlmIGFsbCBtb2RlbHMgaW4gdGhlIHJlZ2lzdHJ5IGFyZSBsb2NhbC5cblx0ICogUmV0dXJucyB0cnVlIG9ubHkgaWYgZXZlcnkgbW9kZWwgcGFzc2VzIGlzTG9jYWxNb2RlbCgpLlxuXHQgKiBSZXR1cm5zIGZhbHNlIGlmIHRoZXJlIGFyZSBubyBtb2RlbHMuXG5cdCAqL1xuXHRpc0FsbExvY2FsQ2hhaW4oKTogYm9vbGVhbiB7XG5cdFx0Y29uc3QgbW9kZWxzID0gdGhpcy5nZXRBbGwoKTtcblx0XHRpZiAobW9kZWxzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIGZhbHNlO1xuXHRcdHJldHVybiBtb2RlbHMuZXZlcnkoKG0pID0+IGlzTG9jYWxNb2RlbChtKSk7XG5cdH1cbn1cblxuLyoqXG4gKiBJbnB1dCB0eXBlIGZvciByZWdpc3RlclByb3ZpZGVyIEFQSS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBQcm92aWRlckNvbmZpZ0lucHV0IHtcblx0YXV0aE1vZGU/OiBQcm92aWRlckF1dGhNb2RlO1xuXHQvKiogT3B0aW9uYWwgcmVhZGluZXNzIGNoZWNrLiBDYWxsZWQgYnkgaXNQcm92aWRlclJlcXVlc3RSZWFkeSgpIGJlZm9yZSBkZWZhdWx0IGF1dGggY2hlY2tzLlxuXHQgKiBUcnVzdGVkIGF0IHRoZSBzYW1lIGxldmVsIGFzIGV4dGVuc2lvbiBjb2RlIFx1MjAxNCBleHRlbnNpb25zIGFscmVhZHkgaGF2ZSBhcmJpdHJhcnkgY29kZSBleGVjdXRpb24uICovXG5cdGlzUmVhZHk/OiAoKSA9PiBib29sZWFuO1xuXHRiYXNlVXJsPzogc3RyaW5nO1xuXHRhcGlLZXk/OiBzdHJpbmc7XG5cdGFwaT86IEFwaTtcblx0c3RyZWFtU2ltcGxlPzogKG1vZGVsOiBNb2RlbDxBcGk+LCBjb250ZXh0OiBDb250ZXh0LCBvcHRpb25zPzogU2ltcGxlU3RyZWFtT3B0aW9ucykgPT4gQXNzaXN0YW50TWVzc2FnZUV2ZW50U3RyZWFtO1xuXHRoZWFkZXJzPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcblx0YXV0aEhlYWRlcj86IGJvb2xlYW47XG5cdC8qKiBPQXV0aCBwcm92aWRlciBmb3IgL2xvZ2luIHN1cHBvcnQgKi9cblx0b2F1dGg/OiBPbWl0PE9BdXRoUHJvdmlkZXJJbnRlcmZhY2UsIFwiaWRcIj47XG5cdG1vZGVscz86IEFycmF5PHtcblx0XHRpZDogc3RyaW5nO1xuXHRcdG5hbWU6IHN0cmluZztcblx0XHRhcGk/OiBBcGk7XG5cdFx0YmFzZVVybD86IHN0cmluZztcblx0XHRyZWFzb25pbmc6IGJvb2xlYW47XG5cdFx0aW5wdXQ6IChcInRleHRcIiB8IFwiaW1hZ2VcIilbXTtcblx0XHRjb3N0OiB7IGlucHV0OiBudW1iZXI7IG91dHB1dDogbnVtYmVyOyBjYWNoZVJlYWQ6IG51bWJlcjsgY2FjaGVXcml0ZTogbnVtYmVyIH07XG5cdFx0Y29udGV4dFdpbmRvdzogbnVtYmVyO1xuXHRcdG1heFRva2VuczogbnVtYmVyO1xuXHRcdGhlYWRlcnM/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuXHRcdGNvbXBhdD86IE1vZGVsPEFwaT5bXCJjb21wYXRcIl07XG5cdFx0cHJvdmlkZXJPcHRpb25zPzogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG5cdH0+O1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBSUE7QUFBQSxFQUVDO0FBQUEsRUFHQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBTUE7QUFBQSxFQUNBO0FBQUEsT0FFTTtBQUNQLFNBQVMsdUJBQXVCLDJCQUEyQjtBQUMzRCxTQUFzQixZQUFZO0FBQ2xDLE9BQU8sZUFBZTtBQUN0QixTQUFTLFlBQVksb0JBQW9CO0FBQ3pDLFNBQVMsWUFBWTtBQUNyQixTQUFTLG1CQUFtQjtBQUU1QixTQUFTLDJCQUEyQjtBQUVwQyxTQUFTLGVBQWUsMEJBQTBCLHFCQUFxQiwrQkFBK0I7QUFDdEcsU0FBZ0Msb0JBQW9CLHNCQUFzQjtBQUMxRSxTQUFTLG9CQUFvQjtBQUU3QixNQUFNLE1BQU8sVUFBa0IsV0FBVztBQUMxQyxNQUFNLE1BQU0sSUFBSSxJQUFJO0FBR3BCLE1BQU0sMEJBQTBCLEtBQUssT0FBTztBQUFBLEVBQzNDLE1BQU0sS0FBSyxTQUFTLEtBQUssTUFB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
