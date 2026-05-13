import { randomUUID } from "node:crypto";
import { getEnvApiKey } from "../../packages/pi-ai/src/web-runtime-env-api-keys.js";
import { authFilePath } from "../app-paths.js";
import { createOnboardingAuthStorage } from "./web-auth-storage.js";
let onboardingBridgeAuthRefresher = null;
const REQUIRED_PROVIDER_CATALOG = [
  { id: "anthropic", label: "Anthropic (Claude)", supportsApiKey: true, supportsOAuth: false, recommended: true },
  { id: "openai", label: "OpenAI", supportsApiKey: true, supportsOAuth: false },
  { id: "github-copilot", label: "GitHub Copilot", supportsApiKey: false, supportsOAuth: true },
  { id: "openai-codex", label: "ChatGPT Plus/Pro (Codex Subscription)", supportsApiKey: false, supportsOAuth: true },
  { id: "google-gemini-cli", label: "Google Cloud Code Assist (Gemini CLI)", supportsApiKey: false, supportsOAuth: true },
  { id: "google-antigravity", label: "Antigravity (Gemini 3, Claude, GPT-OSS)", supportsApiKey: false, supportsOAuth: true },
  { id: "google", label: "Google (Gemini API)", supportsApiKey: true, supportsOAuth: false },
  { id: "groq", label: "Groq", supportsApiKey: true, supportsOAuth: false },
  { id: "xai", label: "xAI (Grok)", supportsApiKey: true, supportsOAuth: false },
  { id: "openrouter", label: "OpenRouter", supportsApiKey: true, supportsOAuth: false },
  { id: "mistral", label: "Mistral", supportsApiKey: true, supportsOAuth: false },
  { id: "minimax", label: "MiniMax", supportsApiKey: true, supportsOAuth: false },
  { id: "minimax-cn", label: "MiniMax CN", supportsApiKey: true, supportsOAuth: false },
  // Supported by the core provider registry; configured via env/auth today.
  { id: "ollama-cloud", label: "Ollama Cloud", supportsApiKey: false, supportsOAuth: false },
  { id: "custom-openai", label: "Custom (OpenAI-compatible)", supportsApiKey: false, supportsOAuth: false },
  { id: "cerebras", label: "Cerebras", supportsApiKey: false, supportsOAuth: false },
  { id: "azure-openai-responses", label: "Azure OpenAI", supportsApiKey: false, supportsOAuth: false },
  { id: "alibaba-coding-plan", label: "Alibaba Coding Plan", supportsApiKey: false, supportsOAuth: false },
  { id: "alibaba-dashscope", label: "Alibaba DashScope", supportsApiKey: false, supportsOAuth: false },
  { id: "claude-code", label: "Claude Code (Local CLI)", supportsApiKey: false, supportsOAuth: false, supportsExternalCli: true, recommended: true }
];
const OPTIONAL_SECTION_CATALOG = [
  {
    id: "web_search",
    label: "Web search",
    providers: [
      { id: "brave", label: "Brave Search", envVar: "BRAVE_API_KEY" },
      { id: "tavily", label: "Tavily", envVar: "TAVILY_API_KEY" }
    ]
  },
  {
    id: "tool_keys",
    label: "Tool API keys",
    providers: [
      { id: "context7", label: "Context7", envVar: "CONTEXT7_API_KEY" },
      { id: "jina", label: "Jina AI", envVar: "JINA_API_KEY" },
      { id: "groq", label: "Groq", envVar: "GROQ_API_KEY" }
    ]
  },
  {
    id: "remote_questions",
    label: "Remote questions",
    providers: [
      { id: "discord_bot", label: "Discord", envVar: "DISCORD_BOT_TOKEN" },
      { id: "slack_bot", label: "Slack", envVar: "SLACK_BOT_TOKEN" },
      { id: "telegram_bot", label: "Telegram", envVar: "TELEGRAM_BOT_TOKEN" }
    ]
  }
];
const CLI_AUTH_PROVIDER_IDS = /* @__PURE__ */ new Set([
  "claude-code"
]);
function defaultIsExternalCliProvider(id) {
  return CLI_AUTH_PROVIDER_IDS.has(id);
}
let onboardingServiceOverrides = null;
let onboardingServiceSingleton = null;
function nowIso(now) {
  return now().toISOString();
}
function redactSensitiveText(value) {
  return value.replace(/sk-[A-Za-z0-9_-]{6,}/g, "[redacted]").replace(/xox[baprs]-[A-Za-z0-9-]+/g, "[redacted]").replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]").replace(/([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET)["'=:\s]+)([^\s,;"']+)/gi, "$1[redacted]");
}
function sanitizeMessage(message) {
  const raw = message instanceof Error ? message.message : String(message);
  return redactSensitiveText(raw).replace(/\s+/g, " ").trim();
}
function createIdleBridgeAuthRefreshState() {
  return {
    phase: "idle",
    strategy: null,
    startedAt: null,
    completedAt: null,
    error: null
  };
}
function resolveOnboardingLockReason(requiredSatisfied, bridgeAuthRefresh) {
  if (!requiredSatisfied) {
    return "required_setup";
  }
  if (bridgeAuthRefresh.phase === "pending") {
    return "bridge_refresh_pending";
  }
  if (bridgeAuthRefresh.phase === "failed") {
    return "bridge_refresh_failed";
  }
  return null;
}
function hasStoredCredentialValue(authStorage, providerId) {
  return authStorage.getCredentialsForProvider(providerId).some((credential) => {
    if (credential.type === "oauth") {
      return typeof credential.access === "string" && credential.access.trim().length > 0;
    }
    return typeof credential.key === "string" && credential.key.trim().length > 0;
  });
}
function resolveCredentialSource(authStorage, providerId, getEnvApiKeyFn, isExternalCliProviderFn) {
  if (isExternalCliProviderFn(providerId)) {
    return "external_cli";
  }
  if (hasStoredCredentialValue(authStorage, providerId)) {
    return "auth_file";
  }
  if (getEnvApiKeyFn(providerId)) {
    return "environment";
  }
  return null;
}
function extractErrorDetail(payload) {
  if (!payload) return null;
  if (typeof payload === "string") return payload;
  if (typeof payload !== "object") return null;
  const record = payload;
  const candidates = [record.message, record.error, record.detail, record.error_description];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
    const nested = extractErrorDetail(candidate);
    if (nested) return nested;
  }
  return null;
}
async function parseFailureMessage(providerId, response) {
  let detail = "";
  try {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const payload = await response.json();
      detail = extractErrorDetail(payload) ?? JSON.stringify(payload);
    } else {
      detail = await response.text();
    }
  } catch {
    detail = "";
  }
  const sanitizedDetail = sanitizeMessage(detail);
  return sanitizedDetail ? `${providerId} validation failed (${response.status}): ${sanitizedDetail}` : `${providerId} validation failed (${response.status})`;
}
async function validateBearerRequest(fetchImpl, providerId, url, apiKey, extraHeaders = {}) {
  try {
    const response = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...extraHeaders
      },
      signal: AbortSignal.timeout(15e3)
    });
    if (!response.ok) {
      return { ok: false, message: await parseFailureMessage(providerId, response) };
    }
    return { ok: true, message: `${providerId} credentials validated` };
  } catch (error) {
    return { ok: false, message: `${providerId} validation failed: ${sanitizeMessage(error)}` };
  }
}
async function validateGoogleApiKey(fetchImpl, apiKey) {
  try {
    const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
    url.searchParams.set("key", apiKey);
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(15e3) });
    if (!response.ok) {
      return { ok: false, message: await parseFailureMessage("google", response) };
    }
    return { ok: true, message: "google credentials validated" };
  } catch (error) {
    return { ok: false, message: `google validation failed: ${sanitizeMessage(error)}` };
  }
}
async function validateAnthropicApiKey(fetchImpl, apiKey) {
  try {
    const response = await fetchImpl("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      signal: AbortSignal.timeout(15e3)
    });
    if (!response.ok) {
      return { ok: false, message: await parseFailureMessage("anthropic", response) };
    }
    return { ok: true, message: "anthropic credentials validated" };
  } catch (error) {
    return { ok: false, message: `anthropic validation failed: ${sanitizeMessage(error)}` };
  }
}
async function validateAnthropicCompatibleApiKey(fetchImpl, providerId, apiKey, baseUrl, model) {
  try {
    const response = await fetchImpl(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }]
      }),
      signal: AbortSignal.timeout(15e3)
    });
    if (!response.ok) {
      return { ok: false, message: await parseFailureMessage(providerId, response) };
    }
    return { ok: true, message: `${providerId} credentials validated` };
  } catch (error) {
    return { ok: false, message: `${providerId} validation failed: ${sanitizeMessage(error)}` };
  }
}
async function defaultValidateApiKey(providerId, apiKey, fetchImpl) {
  switch (providerId) {
    case "anthropic":
      return await validateAnthropicApiKey(fetchImpl, apiKey);
    case "openai":
      return await validateBearerRequest(fetchImpl, providerId, "https://api.openai.com/v1/models", apiKey);
    case "google":
      return await validateGoogleApiKey(fetchImpl, apiKey);
    case "groq":
      return await validateBearerRequest(fetchImpl, providerId, "https://api.groq.com/openai/v1/models", apiKey);
    case "xai":
      return await validateBearerRequest(fetchImpl, providerId, "https://api.x.ai/v1/models", apiKey);
    case "openrouter":
      return await validateBearerRequest(fetchImpl, providerId, "https://openrouter.ai/api/v1/models", apiKey, {
        "HTTP-Referer": "https://localhost",
        "X-Title": "GSD onboarding"
      });
    case "mistral":
      return await validateBearerRequest(fetchImpl, providerId, "https://api.mistral.ai/v1/models", apiKey);
    case "minimax":
      return await validateAnthropicCompatibleApiKey(
        fetchImpl,
        providerId,
        apiKey,
        "https://api.minimax.io/anthropic",
        "MiniMax-M2.7"
      );
    case "minimax-cn":
      return await validateAnthropicCompatibleApiKey(
        fetchImpl,
        providerId,
        apiKey,
        "https://api.minimaxi.com/anthropic",
        "MiniMax-M2.7"
      );
    default:
      return { ok: false, message: `${providerId} does not support API-key validation via onboarding` };
  }
}
function resolveRuntimeTestIsExternalCliProvider(env) {
  if (env.GSD_WEB_TEST_DISABLE_EXTERNAL_CLI !== "1") {
    return void 0;
  }
  return () => false;
}
function resolveRuntimeTestValidateApiKey(env) {
  if (env.GSD_WEB_TEST_FAKE_API_KEY_VALIDATION !== "1") {
    return void 0;
  }
  return async (providerId, apiKey) => {
    const providerLabel = REQUIRED_PROVIDER_CATALOG.find((entry) => entry.id === providerId)?.label ?? providerId;
    const candidate = apiKey.trim().toLowerCase();
    if (!candidate || candidate.includes("invalid") || candidate.includes("reject") || candidate.includes("fail")) {
      return {
        ok: false,
        message: `${providerLabel} rejected the supplied key`
      };
    }
    return {
      ok: true,
      message: `${providerLabel} credentials validated`
    };
  };
}
function getOnboardingDeps() {
  return {
    env: process.env,
    authPath: authFilePath,
    fetch,
    now: () => /* @__PURE__ */ new Date(),
    createFlowId: () => randomUUID(),
    validateApiKey: resolveRuntimeTestValidateApiKey(process.env),
    isExternalCliProvider: resolveRuntimeTestIsExternalCliProvider(process.env),
    refreshBridgeAuth: onboardingBridgeAuthRefresher ?? void 0,
    ...onboardingServiceOverrides ?? {}
  };
}
class OnboardingService {
  deps;
  authStorage = null;
  lastValidation = null;
  activeFlow = null;
  bridgeAuthRefresh = createIdleBridgeAuthRefreshState();
  constructor(deps) {
    this.deps = deps;
  }
  async getState() {
    return this.buildState();
  }
  async validateAndSaveApiKey(providerId, apiKey) {
    const provider = REQUIRED_PROVIDER_CATALOG.find((entry) => entry.id === providerId);
    if (!provider) {
      throw new Error(`Unknown onboarding provider: ${providerId}`);
    }
    if (!provider.supportsApiKey) {
      throw new Error(`${providerId} must be configured with browser sign-in`);
    }
    const trimmedKey = apiKey.trim();
    if (!trimmedKey) {
      throw new Error("API key is required");
    }
    const validateApiKey = this.deps.validateApiKey ?? (async (candidateProviderId, candidateApiKey) => await defaultValidateApiKey(candidateProviderId, candidateApiKey, this.deps.fetch ?? fetch));
    const validation = await validateApiKey(providerId, trimmedKey);
    const checkedAt = nowIso(this.deps.now ?? (() => /* @__PURE__ */ new Date()));
    if (!validation.ok) {
      this.lastValidation = {
        status: "failed",
        providerId,
        method: "api_key",
        checkedAt,
        message: sanitizeMessage(validation.message),
        persisted: false
      };
      return await this.buildState();
    }
    const authStorage = await this.getAuthStorage();
    authStorage.reload();
    authStorage.set(providerId, { type: "api_key", key: trimmedKey });
    this.lastValidation = {
      status: "succeeded",
      providerId,
      method: "api_key",
      checkedAt,
      message: sanitizeMessage(validation.message || `${providerId} credentials validated`),
      persisted: true
    };
    await this.refreshBridgeAuth();
    return await this.buildState();
  }
  async startProviderFlow(providerId) {
    const authStorage = await this.getAuthStorage();
    authStorage.reload();
    const oauthProvider = authStorage.getOAuthProviders().find((provider) => provider.id === providerId);
    if (!oauthProvider) {
      throw new Error(`OAuth provider not available for onboarding: ${providerId}`);
    }
    if (this.activeFlow && ["running", "awaiting_browser_auth", "awaiting_input"].includes(this.activeFlow.state.status)) {
      this.cancelActiveFlow();
    }
    const runtime = {
      state: {
        flowId: (this.deps.createFlowId ?? (() => randomUUID()))(),
        providerId,
        providerLabel: oauthProvider.name,
        status: "running",
        updatedAt: nowIso(this.deps.now ?? (() => /* @__PURE__ */ new Date())),
        auth: null,
        prompt: null,
        progress: [],
        error: null
      },
      awaitingInput: null,
      abortController: new AbortController()
    };
    this.activeFlow = runtime;
    void this.runOAuthFlow(runtime, oauthProvider, authStorage);
    return await this.buildState();
  }
  async submitProviderFlowInput(flowId, input) {
    const runtime = this.activeFlow;
    if (!runtime || runtime.state.flowId !== flowId) {
      throw new Error(`Unknown onboarding flow: ${flowId}`);
    }
    if (!runtime.awaitingInput) {
      throw new Error(`Onboarding flow ${flowId} is not waiting for input`);
    }
    const resolveInput = runtime.awaitingInput;
    runtime.awaitingInput = null;
    runtime.state.prompt = null;
    runtime.state.status = "running";
    runtime.state.updatedAt = nowIso(this.deps.now ?? (() => /* @__PURE__ */ new Date()));
    resolveInput(input);
    return await this.buildState();
  }
  async cancelProviderFlow(flowId) {
    const runtime = this.activeFlow;
    if (!runtime || runtime.state.flowId !== flowId) {
      throw new Error(`Unknown onboarding flow: ${flowId}`);
    }
    this.cancelActiveFlow();
    return await this.buildState();
  }
  async logoutProvider(providerId) {
    const authStorage = await this.getAuthStorage();
    authStorage.reload();
    const currentState = await this.buildState();
    const requestedProviderId = providerId.trim();
    const resolvedProviderId = requestedProviderId || currentState.required.satisfiedBy?.providerId || currentState.required.providers.find((provider) => provider.configured)?.id;
    if (!resolvedProviderId) {
      throw new Error("No configured provider is available to log out");
    }
    const providerState = currentState.required.providers.find((provider) => provider.id === resolvedProviderId);
    const providerLabel = providerState?.label ?? resolvedProviderId;
    if (!providerState?.configured) {
      throw new Error(`${providerLabel} is not configured in this workspace`);
    }
    if (providerState.configuredVia !== "auth_file") {
      throw new Error(`${providerLabel} is configured via ${providerState.configuredVia} and cannot be logged out from the browser surface`);
    }
    if (this.activeFlow && this.activeFlow.state.providerId === resolvedProviderId && ["running", "awaiting_browser_auth", "awaiting_input"].includes(this.activeFlow.state.status)) {
      this.cancelActiveFlow();
    }
    authStorage.logout(resolvedProviderId);
    this.lastValidation = null;
    await this.refreshBridgeAuth();
    return await this.buildState();
  }
  async refreshBridgeAuth() {
    const refreshBridgeAuth = this.deps.refreshBridgeAuth;
    if (!refreshBridgeAuth) {
      this.bridgeAuthRefresh = createIdleBridgeAuthRefreshState();
      return;
    }
    const startedAt = nowIso(this.deps.now ?? (() => /* @__PURE__ */ new Date()));
    this.bridgeAuthRefresh = {
      phase: "pending",
      strategy: "restart",
      startedAt,
      completedAt: null,
      error: null
    };
    try {
      await refreshBridgeAuth();
      this.bridgeAuthRefresh = {
        phase: "succeeded",
        strategy: "restart",
        startedAt,
        completedAt: nowIso(this.deps.now ?? (() => /* @__PURE__ */ new Date())),
        error: null
      };
    } catch (error) {
      this.bridgeAuthRefresh = {
        phase: "failed",
        strategy: "restart",
        startedAt,
        completedAt: nowIso(this.deps.now ?? (() => /* @__PURE__ */ new Date())),
        error: sanitizeMessage(error)
      };
    }
  }
  async getAuthStorage() {
    if (!this.authStorage) {
      if (this.deps.authStorage) {
        this.authStorage = this.deps.authStorage;
      } else if (this.deps.createAuthStorage) {
        this.authStorage = await this.deps.createAuthStorage(this.deps.authPath ?? authFilePath);
      } else {
        this.authStorage = createOnboardingAuthStorage(this.deps.authPath ?? authFilePath);
      }
    }
    return this.authStorage;
  }
  buildOptionalSectionState(authStorage) {
    const env = this.deps.env ?? process.env;
    return OPTIONAL_SECTION_CATALOG.map((section) => {
      const configuredItems = section.providers.filter((provider) => {
        const envConfigured = provider.envVar ? typeof env[provider.envVar] === "string" && env[provider.envVar].trim().length > 0 : false;
        const storedConfigured = hasStoredCredentialValue(authStorage, provider.id);
        return envConfigured || storedConfigured;
      }).map((provider) => provider.label);
      return {
        id: section.id,
        label: section.label,
        blocking: false,
        skippable: true,
        configured: configuredItems.length > 0,
        configuredItems
      };
    });
  }
  buildProviderState(authStorage, getEnvApiKeyFn) {
    const oauthProviders = new Map(authStorage.getOAuthProviders().map((provider) => [provider.id, provider]));
    const isExternalCliProviderFn = this.deps.isExternalCliProvider ?? defaultIsExternalCliProvider;
    return REQUIRED_PROVIDER_CATALOG.map((provider) => {
      const oauthProvider = oauthProviders.get(provider.id);
      const configuredVia = resolveCredentialSource(authStorage, provider.id, getEnvApiKeyFn, isExternalCliProviderFn);
      return {
        id: provider.id,
        label: oauthProvider?.name ?? provider.label,
        required: true,
        recommended: Boolean(provider.recommended),
        configured: configuredVia !== null,
        configuredVia,
        supports: {
          apiKey: provider.supportsApiKey,
          oauth: provider.supportsOAuth,
          oauthAvailable: provider.supportsOAuth ? Boolean(oauthProvider) : false,
          usesCallbackServer: Boolean(oauthProvider?.usesCallbackServer),
          externalCli: Boolean(provider.supportsExternalCli)
        }
      };
    });
  }
  async buildState() {
    const authStorage = await this.getAuthStorage();
    const getEnvApiKeyFn = this.deps.getEnvApiKey ?? getEnvApiKey;
    authStorage.reload();
    const providers = this.buildProviderState(authStorage, getEnvApiKeyFn);
    const satisfiedByProvider = providers.find((provider) => provider.configured) ?? null;
    const optionalSections = this.buildOptionalSectionState(authStorage);
    const lockReason = resolveOnboardingLockReason(Boolean(satisfiedByProvider), this.bridgeAuthRefresh);
    let completionRecord = null;
    try {
      const { readOnboardingRecord, isOnboardingComplete } = await import("../resources/extensions/gsd/onboarding-state.js");
      const r = readOnboardingRecord();
      completionRecord = {
        completedAt: isOnboardingComplete() ? r.completedAt : null,
        completedSteps: r.completedSteps,
        skippedSteps: r.skippedSteps,
        lastResumePoint: r.lastResumePoint,
        flowVersion: r.flowVersion
      };
    } catch {
      completionRecord = null;
    }
    return {
      status: lockReason ? "blocked" : "ready",
      locked: lockReason !== null,
      lockReason,
      required: {
        blocking: true,
        skippable: false,
        satisfied: Boolean(satisfiedByProvider),
        satisfiedBy: satisfiedByProvider ? {
          providerId: satisfiedByProvider.id,
          source: satisfiedByProvider.configuredVia ?? "runtime"
        } : null,
        providers
      },
      optional: {
        blocking: false,
        skippable: true,
        sections: optionalSections
      },
      lastValidation: this.lastValidation ? { ...this.lastValidation } : null,
      activeFlow: this.activeFlow ? structuredClone(this.activeFlow.state) : null,
      bridgeAuthRefresh: { ...this.bridgeAuthRefresh },
      completionRecord
    };
  }
  cancelActiveFlow() {
    if (!this.activeFlow) return;
    this.activeFlow.abortController.abort();
    if (this.activeFlow.awaitingInput) {
      this.activeFlow.awaitingInput("");
      this.activeFlow.awaitingInput = null;
    }
    this.activeFlow.state.status = "cancelled";
    this.activeFlow.state.prompt = null;
    this.activeFlow.state.error = null;
    this.activeFlow.state.updatedAt = nowIso(this.deps.now ?? (() => /* @__PURE__ */ new Date()));
  }
  async runOAuthFlow(runtime, provider, authStorage) {
    try {
      await authStorage.login(provider.id, {
        onAuth: (info) => {
          runtime.state.auth = info;
          runtime.state.status = "awaiting_browser_auth";
          runtime.state.updatedAt = nowIso(this.deps.now ?? (() => /* @__PURE__ */ new Date()));
        },
        onPrompt: async (prompt) => await this.waitForFlowInput(runtime, "text", prompt),
        onProgress: (message) => {
          runtime.state.progress = [...runtime.state.progress, sanitizeMessage(message)].slice(-20);
          if (runtime.state.status !== "awaiting_input") {
            runtime.state.status = "running";
          }
          runtime.state.updatedAt = nowIso(this.deps.now ?? (() => /* @__PURE__ */ new Date()));
        },
        onManualCodeInput: async () => await this.waitForFlowInput(runtime, "manual_code", {
          message: "Paste the redirect URL from your browser:",
          placeholder: "http://localhost:..."
        }),
        signal: runtime.abortController.signal
      });
      runtime.state.status = "succeeded";
      runtime.state.prompt = null;
      runtime.state.error = null;
      runtime.state.updatedAt = nowIso(this.deps.now ?? (() => /* @__PURE__ */ new Date()));
      this.lastValidation = {
        status: "succeeded",
        providerId: provider.id,
        method: "oauth",
        checkedAt: runtime.state.updatedAt,
        message: `${provider.id} sign-in complete`,
        persisted: true
      };
      await this.refreshBridgeAuth();
    } catch (error) {
      const cancelled = runtime.abortController.signal.aborted;
      runtime.state.status = cancelled ? "cancelled" : "failed";
      runtime.state.prompt = null;
      runtime.state.error = cancelled ? null : sanitizeMessage(error);
      runtime.state.updatedAt = nowIso(this.deps.now ?? (() => /* @__PURE__ */ new Date()));
      if (!cancelled) {
        this.lastValidation = {
          status: "failed",
          providerId: provider.id,
          method: "oauth",
          checkedAt: runtime.state.updatedAt,
          message: runtime.state.error || `${provider.id} sign-in failed`,
          persisted: false
        };
      }
    }
  }
  async waitForFlowInput(runtime, kind, prompt) {
    runtime.state.status = "awaiting_input";
    runtime.state.prompt = {
      kind,
      message: prompt.message,
      placeholder: prompt.placeholder,
      allowEmpty: prompt.allowEmpty
    };
    runtime.state.updatedAt = nowIso(this.deps.now ?? (() => /* @__PURE__ */ new Date()));
    return await new Promise((resolve) => {
      runtime.awaitingInput = resolve;
    });
  }
}
function getOnboardingService() {
  if (!onboardingServiceSingleton) {
    onboardingServiceSingleton = new OnboardingService(getOnboardingDeps());
  }
  return onboardingServiceSingleton;
}
async function collectOnboardingState() {
  return await getOnboardingService().getState();
}
function registerOnboardingBridgeAuthRefresher(refresher) {
  onboardingBridgeAuthRefresher = refresher;
  onboardingServiceSingleton = null;
}
function configureOnboardingServiceForTests(overrides) {
  onboardingServiceOverrides = overrides;
  onboardingServiceSingleton = null;
}
function resetOnboardingServiceForTests() {
  onboardingServiceOverrides = null;
  onboardingServiceSingleton = null;
}
export {
  OnboardingService,
  collectOnboardingState,
  configureOnboardingServiceForTests,
  getOnboardingService,
  registerOnboardingBridgeAuthRefresher,
  resetOnboardingServiceForTests
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3dlYi9vbmJvYXJkaW5nLXNlcnZpY2UudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcblxuaW1wb3J0IHsgZ2V0RW52QXBpS2V5IH0gZnJvbSBcIi4uLy4uL3BhY2thZ2VzL3BpLWFpL3NyYy93ZWItcnVudGltZS1lbnYtYXBpLWtleXMudHNcIjtcbmltcG9ydCB0eXBlIHsgT0F1dGhBdXRoSW5mbywgT0F1dGhQcm9tcHQsIE9BdXRoUHJvdmlkZXJJbnRlcmZhY2UgfSBmcm9tIFwiLi4vLi4vcGFja2FnZXMvcGktYWkvZGlzdC9vYXV0aC5qc1wiO1xuaW1wb3J0IHsgYXV0aEZpbGVQYXRoIH0gZnJvbSBcIi4uL2FwcC1wYXRocy50c1wiO1xuaW1wb3J0IHsgY3JlYXRlT25ib2FyZGluZ0F1dGhTdG9yYWdlLCB0eXBlIE9uYm9hcmRpbmdBdXRoU3RvcmFnZSBhcyBBdXRoU3RvcmFnZUluc3RhbmNlIH0gZnJvbSBcIi4vd2ViLWF1dGgtc3RvcmFnZS50c1wiO1xuXG50eXBlIFJlcXVpcmVkUHJvdmlkZXJDYXRhbG9nRW50cnkgPSB7XG4gIGlkOiBzdHJpbmc7XG4gIGxhYmVsOiBzdHJpbmc7XG4gIHN1cHBvcnRzQXBpS2V5OiBib29sZWFuO1xuICBzdXBwb3J0c09BdXRoOiBib29sZWFuO1xuICBzdXBwb3J0c0V4dGVybmFsQ2xpPzogYm9vbGVhbjtcbiAgcmVjb21tZW5kZWQ/OiBib29sZWFuO1xufTtcblxudHlwZSBPcHRpb25hbFNlY3Rpb25DYXRhbG9nRW50cnkgPSB7XG4gIGlkOiBzdHJpbmc7XG4gIGxhYmVsOiBzdHJpbmc7XG4gIHByb3ZpZGVyczogQXJyYXk8eyBpZDogc3RyaW5nOyBsYWJlbDogc3RyaW5nOyBlbnZWYXI/OiBzdHJpbmcgfT47XG59O1xuXG50eXBlIFZhbGlkYXRpb25Qcm9iZVJlc3VsdCA9XG4gIHwgeyBvazogdHJ1ZTsgbWVzc2FnZT86IHN0cmluZyB9XG4gIHwgeyBvazogZmFsc2U7IG1lc3NhZ2U6IHN0cmluZyB9O1xuXG50eXBlIEdldEVudkFwaUtleUZuID0gdHlwZW9mIGdldEVudkFwaUtleTtcbnR5cGUgQnJpZGdlQXV0aFJlZnJlc2hlciA9ICgpID0+IFByb21pc2U8dm9pZD47XG5cbmxldCBvbmJvYXJkaW5nQnJpZGdlQXV0aFJlZnJlc2hlcjogQnJpZGdlQXV0aFJlZnJlc2hlciB8IG51bGwgPSBudWxsO1xuXG50eXBlIE9uYm9hcmRpbmdTZXJ2aWNlRGVwcyA9IHtcbiAgZW52PzogTm9kZUpTLlByb2Nlc3NFbnY7XG4gIGF1dGhQYXRoPzogc3RyaW5nO1xuICBhdXRoU3RvcmFnZT86IEF1dGhTdG9yYWdlSW5zdGFuY2U7XG4gIGNyZWF0ZUF1dGhTdG9yYWdlPzogKGF1dGhQYXRoOiBzdHJpbmcpID0+IEF1dGhTdG9yYWdlSW5zdGFuY2UgfCBQcm9taXNlPEF1dGhTdG9yYWdlSW5zdGFuY2U+O1xuICB2YWxpZGF0ZUFwaUtleT86IChwcm92aWRlcklkOiBzdHJpbmcsIGFwaUtleTogc3RyaW5nKSA9PiBQcm9taXNlPFZhbGlkYXRpb25Qcm9iZVJlc3VsdD47XG4gIGZldGNoPzogdHlwZW9mIGZldGNoO1xuICBub3c/OiAoKSA9PiBEYXRlO1xuICBjcmVhdGVGbG93SWQ/OiAoKSA9PiBzdHJpbmc7XG4gIGdldEVudkFwaUtleT86IEdldEVudkFwaUtleUZuO1xuICByZWZyZXNoQnJpZGdlQXV0aD86ICgpID0+IFByb21pc2U8dm9pZD47XG4gIGlzRXh0ZXJuYWxDbGlQcm92aWRlcj86IChwcm92aWRlcklkOiBzdHJpbmcpID0+IGJvb2xlYW47XG59O1xuXG5leHBvcnQgdHlwZSBPbmJvYXJkaW5nQ3JlZGVudGlhbFNvdXJjZSA9IFwiYXV0aF9maWxlXCIgfCBcImVudmlyb25tZW50XCIgfCBcInJ1bnRpbWVcIiB8IFwiZXh0ZXJuYWxfY2xpXCI7XG5leHBvcnQgdHlwZSBPbmJvYXJkaW5nVmFsaWRhdGlvblN0YXR1cyA9IFwic3VjY2VlZGVkXCIgfCBcImZhaWxlZFwiO1xuZXhwb3J0IHR5cGUgT25ib2FyZGluZ0Zsb3dTdGF0dXMgPVxuICB8IFwiaWRsZVwiXG4gIHwgXCJydW5uaW5nXCJcbiAgfCBcImF3YWl0aW5nX2Jyb3dzZXJfYXV0aFwiXG4gIHwgXCJhd2FpdGluZ19pbnB1dFwiXG4gIHwgXCJzdWNjZWVkZWRcIlxuICB8IFwiZmFpbGVkXCJcbiAgfCBcImNhbmNlbGxlZFwiO1xuZXhwb3J0IHR5cGUgT25ib2FyZGluZ0xvY2tSZWFzb24gPSBcInJlcXVpcmVkX3NldHVwXCIgfCBcImJyaWRnZV9yZWZyZXNoX3BlbmRpbmdcIiB8IFwiYnJpZGdlX3JlZnJlc2hfZmFpbGVkXCI7XG5leHBvcnQgdHlwZSBPbmJvYXJkaW5nQnJpZGdlQXV0aFJlZnJlc2hQaGFzZSA9IFwiaWRsZVwiIHwgXCJwZW5kaW5nXCIgfCBcInN1Y2NlZWRlZFwiIHwgXCJmYWlsZWRcIjtcblxuZXhwb3J0IGludGVyZmFjZSBPbmJvYXJkaW5nUHJvdmlkZXJTdGF0ZSB7XG4gIGlkOiBzdHJpbmc7XG4gIGxhYmVsOiBzdHJpbmc7XG4gIHJlcXVpcmVkOiB0cnVlO1xuICByZWNvbW1lbmRlZDogYm9vbGVhbjtcbiAgY29uZmlndXJlZDogYm9vbGVhbjtcbiAgY29uZmlndXJlZFZpYTogT25ib2FyZGluZ0NyZWRlbnRpYWxTb3VyY2UgfCBudWxsO1xuICBzdXBwb3J0czoge1xuICAgIGFwaUtleTogYm9vbGVhbjtcbiAgICBvYXV0aDogYm9vbGVhbjtcbiAgICBvYXV0aEF2YWlsYWJsZTogYm9vbGVhbjtcbiAgICB1c2VzQ2FsbGJhY2tTZXJ2ZXI6IGJvb2xlYW47XG4gICAgZXh0ZXJuYWxDbGk6IGJvb2xlYW47XG4gIH07XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgT25ib2FyZGluZ09wdGlvbmFsU2VjdGlvblN0YXRlIHtcbiAgaWQ6IHN0cmluZztcbiAgbGFiZWw6IHN0cmluZztcbiAgYmxvY2tpbmc6IGZhbHNlO1xuICBza2lwcGFibGU6IHRydWU7XG4gIGNvbmZpZ3VyZWQ6IGJvb2xlYW47XG4gIGNvbmZpZ3VyZWRJdGVtczogc3RyaW5nW107XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgT25ib2FyZGluZ1ZhbGlkYXRpb25SZXN1bHQge1xuICBzdGF0dXM6IE9uYm9hcmRpbmdWYWxpZGF0aW9uU3RhdHVzO1xuICBwcm92aWRlcklkOiBzdHJpbmc7XG4gIG1ldGhvZDogXCJhcGlfa2V5XCIgfCBcIm9hdXRoXCI7XG4gIGNoZWNrZWRBdDogc3RyaW5nO1xuICBtZXNzYWdlOiBzdHJpbmc7XG4gIHBlcnNpc3RlZDogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBPbmJvYXJkaW5nRmxvd1Byb21wdFN0YXRlIHtcbiAga2luZDogXCJ0ZXh0XCIgfCBcIm1hbnVhbF9jb2RlXCI7XG4gIG1lc3NhZ2U6IHN0cmluZztcbiAgcGxhY2Vob2xkZXI/OiBzdHJpbmc7XG4gIGFsbG93RW1wdHk/OiBib29sZWFuO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIE9uYm9hcmRpbmdQcm92aWRlckZsb3dTdGF0ZSB7XG4gIGZsb3dJZDogc3RyaW5nO1xuICBwcm92aWRlcklkOiBzdHJpbmc7XG4gIHByb3ZpZGVyTGFiZWw6IHN0cmluZztcbiAgc3RhdHVzOiBPbmJvYXJkaW5nRmxvd1N0YXR1cztcbiAgdXBkYXRlZEF0OiBzdHJpbmc7XG4gIGF1dGg6IE9BdXRoQXV0aEluZm8gfCBudWxsO1xuICBwcm9tcHQ6IE9uYm9hcmRpbmdGbG93UHJvbXB0U3RhdGUgfCBudWxsO1xuICBwcm9ncmVzczogc3RyaW5nW107XG4gIGVycm9yOiBzdHJpbmcgfCBudWxsO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIE9uYm9hcmRpbmdCcmlkZ2VBdXRoUmVmcmVzaFN0YXRlIHtcbiAgcGhhc2U6IE9uYm9hcmRpbmdCcmlkZ2VBdXRoUmVmcmVzaFBoYXNlO1xuICBzdHJhdGVneTogXCJyZXN0YXJ0XCIgfCBudWxsO1xuICBzdGFydGVkQXQ6IHN0cmluZyB8IG51bGw7XG4gIGNvbXBsZXRlZEF0OiBzdHJpbmcgfCBudWxsO1xuICBlcnJvcjogc3RyaW5nIHwgbnVsbDtcbn1cblxuLyoqXG4gKiBDTEktc2lkZSBvbmJvYXJkaW5nIGNvbXBsZXRpb24gcmVjb3JkIGV4cG9zZWQgdG8gdGhlIHdlYiBjbGllbnQuXG4gKlxuICogTWlycm9ycyB0aGUgSlNPTiB3cml0dGVuIGJ5IGBzcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL29uYm9hcmRpbmctc3RhdGUudHNgLlxuICogUmVhZC1vbmx5IG1ldGFkYXRhOiBsZXRzIHRoZSB3ZWIgVUkgcmVuZGVyIFwic2V0dXAgY29tcGxldGUgKGRhdGUpXCIgaW5kaWNhdG9yc1xuICogYW5kIG9mZmVyIGEgXCJyZS1ydW4gc2V0dXBcIiBhZmZvcmRhbmNlLiBEb2VzIE5PVCBpbmZsdWVuY2UgdGhlIGBsb2NrZWRgIGZsYWcgXHUyMDE0XG4gKiBsb2NrIHNlbWFudGljcyBzdGlsbCBkZXBlbmQgb24gd2hldGhlciBhIHJlcXVpcmVkIHByb3ZpZGVyIGlzIGNvbmZpZ3VyZWQuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgT25ib2FyZGluZ0NvbXBsZXRpb25SZWNvcmQge1xuICBjb21wbGV0ZWRBdDogc3RyaW5nIHwgbnVsbDtcbiAgY29tcGxldGVkU3RlcHM6IHN0cmluZ1tdO1xuICBza2lwcGVkU3RlcHM6IHN0cmluZ1tdO1xuICBsYXN0UmVzdW1lUG9pbnQ6IHN0cmluZyB8IG51bGw7XG4gIGZsb3dWZXJzaW9uOiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgT25ib2FyZGluZ1N0YXRlIHtcbiAgc3RhdHVzOiBcImJsb2NrZWRcIiB8IFwicmVhZHlcIjtcbiAgbG9ja2VkOiBib29sZWFuO1xuICBsb2NrUmVhc29uOiBPbmJvYXJkaW5nTG9ja1JlYXNvbiB8IG51bGw7XG4gIHJlcXVpcmVkOiB7XG4gICAgYmxvY2tpbmc6IHRydWU7XG4gICAgc2tpcHBhYmxlOiBmYWxzZTtcbiAgICBzYXRpc2ZpZWQ6IGJvb2xlYW47XG4gICAgc2F0aXNmaWVkQnk6IHsgcHJvdmlkZXJJZDogc3RyaW5nOyBzb3VyY2U6IE9uYm9hcmRpbmdDcmVkZW50aWFsU291cmNlIH0gfCBudWxsO1xuICAgIHByb3ZpZGVyczogT25ib2FyZGluZ1Byb3ZpZGVyU3RhdGVbXTtcbiAgfTtcbiAgb3B0aW9uYWw6IHtcbiAgICBibG9ja2luZzogZmFsc2U7XG4gICAgc2tpcHBhYmxlOiB0cnVlO1xuICAgIHNlY3Rpb25zOiBPbmJvYXJkaW5nT3B0aW9uYWxTZWN0aW9uU3RhdGVbXTtcbiAgfTtcbiAgbGFzdFZhbGlkYXRpb246IE9uYm9hcmRpbmdWYWxpZGF0aW9uUmVzdWx0IHwgbnVsbDtcbiAgYWN0aXZlRmxvdzogT25ib2FyZGluZ1Byb3ZpZGVyRmxvd1N0YXRlIHwgbnVsbDtcbiAgYnJpZGdlQXV0aFJlZnJlc2g6IE9uYm9hcmRpbmdCcmlkZ2VBdXRoUmVmcmVzaFN0YXRlO1xuICAvKiogQ0xJLXNpZGUgb25ib2FyZGluZyB3aXphcmQgY29tcGxldGlvbiByZWNvcmQuIE51bGwgaWYgbmV2ZXIgY29tcGxldGVkLiBPcHRpb25hbCBmb3IgYmFjay1jb21wYXQgd2l0aCBleGlzdGluZyBmaXh0dXJlcy4gKi9cbiAgY29tcGxldGlvblJlY29yZD86IE9uYm9hcmRpbmdDb21wbGV0aW9uUmVjb3JkIHwgbnVsbDtcbn1cblxudHlwZSBQcm92aWRlckZsb3dSdW50aW1lID0ge1xuICBzdGF0ZTogT25ib2FyZGluZ1Byb3ZpZGVyRmxvd1N0YXRlO1xuICBhd2FpdGluZ0lucHV0OiAoKHZhbHVlOiBzdHJpbmcpID0+IHZvaWQpIHwgbnVsbDtcbiAgYWJvcnRDb250cm9sbGVyOiBBYm9ydENvbnRyb2xsZXI7XG59O1xuXG4vKipcbiAqIE9yZGVyZWQgY2F0YWxvZyBvZiByZXF1aXJlZCBBSSBwcm92aWRlcnMgc2hvd24gaW4gdGhlIG9uYm9hcmRpbmcgd2l6YXJkLlxuICpcbiAqICoqUHJlY2VkZW5jZSBjb250cmFjdDoqKiBgc2F0aXNmaWVkQnlgIGlzIHNldCB0byB0aGUgZmlyc3QgKmNvbmZpZ3VyZWQqXG4gKiBwcm92aWRlciBpbiB0aGlzIGxpc3QuIFJlb3JkZXJpbmcgZW50cmllcyBjaGFuZ2VzIHdoaWNoIHByb3ZpZGVyIHdpbnMgd2hlblxuICogbXVsdGlwbGUgYXJlIGNvbmZpZ3VyZWQgc2ltdWx0YW5lb3VzbHkgXHUyMDE0IGRvIHNvIGludGVudGlvbmFsbHkuXG4gKlxuICogRXh0ZXJuYWxDbGkgcHJvdmlkZXJzICh0aG9zZSB3aXRoIGBzdXBwb3J0c0V4dGVybmFsQ2xpOiB0cnVlYCkgYXJlIGFsd2F5c1xuICogdHJlYXRlZCBhcyBjb25maWd1cmVkIGJ5IHRoZSBvbmJvYXJkaW5nIHNlcnZpY2UgcmVnYXJkbGVzcyBvZiBhdXRoLWZpbGVcbiAqIGNvbnRlbnRzLCBzbyBwbGFjaW5nIHRoZW0gaGlnaGVyIGluIHRoZSBsaXN0IGdpdmVzIHRoZW0gaGlnaGVyIHByZWNlZGVuY2UuXG4gKi9cbmNvbnN0IFJFUVVJUkVEX1BST1ZJREVSX0NBVEFMT0c6IFJlcXVpcmVkUHJvdmlkZXJDYXRhbG9nRW50cnlbXSA9IFtcbiAgeyBpZDogXCJhbnRocm9waWNcIiwgbGFiZWw6IFwiQW50aHJvcGljIChDbGF1ZGUpXCIsIHN1cHBvcnRzQXBpS2V5OiB0cnVlLCBzdXBwb3J0c09BdXRoOiBmYWxzZSwgcmVjb21tZW5kZWQ6IHRydWUgfSxcbiAgeyBpZDogXCJvcGVuYWlcIiwgbGFiZWw6IFwiT3BlbkFJXCIsIHN1cHBvcnRzQXBpS2V5OiB0cnVlLCBzdXBwb3J0c09BdXRoOiBmYWxzZSB9LFxuICB7IGlkOiBcImdpdGh1Yi1jb3BpbG90XCIsIGxhYmVsOiBcIkdpdEh1YiBDb3BpbG90XCIsIHN1cHBvcnRzQXBpS2V5OiBmYWxzZSwgc3VwcG9ydHNPQXV0aDogdHJ1ZSB9LFxuICB7IGlkOiBcIm9wZW5haS1jb2RleFwiLCBsYWJlbDogXCJDaGF0R1BUIFBsdXMvUHJvIChDb2RleCBTdWJzY3JpcHRpb24pXCIsIHN1cHBvcnRzQXBpS2V5OiBmYWxzZSwgc3VwcG9ydHNPQXV0aDogdHJ1ZSB9LFxuICB7IGlkOiBcImdvb2dsZS1nZW1pbmktY2xpXCIsIGxhYmVsOiBcIkdvb2dsZSBDbG91ZCBDb2RlIEFzc2lzdCAoR2VtaW5pIENMSSlcIiwgc3VwcG9ydHNBcGlLZXk6IGZhbHNlLCBzdXBwb3J0c09BdXRoOiB0cnVlIH0sXG4gIHsgaWQ6IFwiZ29vZ2xlLWFudGlncmF2aXR5XCIsIGxhYmVsOiBcIkFudGlncmF2aXR5IChHZW1pbmkgMywgQ2xhdWRlLCBHUFQtT1NTKVwiLCBzdXBwb3J0c0FwaUtleTogZmFsc2UsIHN1cHBvcnRzT0F1dGg6IHRydWUgfSxcbiAgeyBpZDogXCJnb29nbGVcIiwgbGFiZWw6IFwiR29vZ2xlIChHZW1pbmkgQVBJKVwiLCBzdXBwb3J0c0FwaUtleTogdHJ1ZSwgc3VwcG9ydHNPQXV0aDogZmFsc2UgfSxcbiAgeyBpZDogXCJncm9xXCIsIGxhYmVsOiBcIkdyb3FcIiwgc3VwcG9ydHNBcGlLZXk6IHRydWUsIHN1cHBvcnRzT0F1dGg6IGZhbHNlIH0sXG4gIHsgaWQ6IFwieGFpXCIsIGxhYmVsOiBcInhBSSAoR3JvaylcIiwgc3VwcG9ydHNBcGlLZXk6IHRydWUsIHN1cHBvcnRzT0F1dGg6IGZhbHNlIH0sXG4gIHsgaWQ6IFwib3BlbnJvdXRlclwiLCBsYWJlbDogXCJPcGVuUm91dGVyXCIsIHN1cHBvcnRzQXBpS2V5OiB0cnVlLCBzdXBwb3J0c09BdXRoOiBmYWxzZSB9LFxuICB7IGlkOiBcIm1pc3RyYWxcIiwgbGFiZWw6IFwiTWlzdHJhbFwiLCBzdXBwb3J0c0FwaUtleTogdHJ1ZSwgc3VwcG9ydHNPQXV0aDogZmFsc2UgfSxcbiAgeyBpZDogXCJtaW5pbWF4XCIsIGxhYmVsOiBcIk1pbmlNYXhcIiwgc3VwcG9ydHNBcGlLZXk6IHRydWUsIHN1cHBvcnRzT0F1dGg6IGZhbHNlIH0sXG4gIHsgaWQ6IFwibWluaW1heC1jblwiLCBsYWJlbDogXCJNaW5pTWF4IENOXCIsIHN1cHBvcnRzQXBpS2V5OiB0cnVlLCBzdXBwb3J0c09BdXRoOiBmYWxzZSB9LFxuICAvLyBTdXBwb3J0ZWQgYnkgdGhlIGNvcmUgcHJvdmlkZXIgcmVnaXN0cnk7IGNvbmZpZ3VyZWQgdmlhIGVudi9hdXRoIHRvZGF5LlxuICB7IGlkOiBcIm9sbGFtYS1jbG91ZFwiLCBsYWJlbDogXCJPbGxhbWEgQ2xvdWRcIiwgc3VwcG9ydHNBcGlLZXk6IGZhbHNlLCBzdXBwb3J0c09BdXRoOiBmYWxzZSB9LFxuICB7IGlkOiBcImN1c3RvbS1vcGVuYWlcIiwgbGFiZWw6IFwiQ3VzdG9tIChPcGVuQUktY29tcGF0aWJsZSlcIiwgc3VwcG9ydHNBcGlLZXk6IGZhbHNlLCBzdXBwb3J0c09BdXRoOiBmYWxzZSB9LFxuICB7IGlkOiBcImNlcmVicmFzXCIsIGxhYmVsOiBcIkNlcmVicmFzXCIsIHN1cHBvcnRzQXBpS2V5OiBmYWxzZSwgc3VwcG9ydHNPQXV0aDogZmFsc2UgfSxcbiAgeyBpZDogXCJhenVyZS1vcGVuYWktcmVzcG9uc2VzXCIsIGxhYmVsOiBcIkF6dXJlIE9wZW5BSVwiLCBzdXBwb3J0c0FwaUtleTogZmFsc2UsIHN1cHBvcnRzT0F1dGg6IGZhbHNlIH0sXG4gIHsgaWQ6IFwiYWxpYmFiYS1jb2RpbmctcGxhblwiLCBsYWJlbDogXCJBbGliYWJhIENvZGluZyBQbGFuXCIsIHN1cHBvcnRzQXBpS2V5OiBmYWxzZSwgc3VwcG9ydHNPQXV0aDogZmFsc2UgfSxcbiAgeyBpZDogXCJhbGliYWJhLWRhc2hzY29wZVwiLCBsYWJlbDogXCJBbGliYWJhIERhc2hTY29wZVwiLCBzdXBwb3J0c0FwaUtleTogZmFsc2UsIHN1cHBvcnRzT0F1dGg6IGZhbHNlIH0sXG4gIHsgaWQ6IFwiY2xhdWRlLWNvZGVcIiwgbGFiZWw6IFwiQ2xhdWRlIENvZGUgKExvY2FsIENMSSlcIiwgc3VwcG9ydHNBcGlLZXk6IGZhbHNlLCBzdXBwb3J0c09BdXRoOiBmYWxzZSwgc3VwcG9ydHNFeHRlcm5hbENsaTogdHJ1ZSwgcmVjb21tZW5kZWQ6IHRydWUgfSxcbl07XG5cbmNvbnN0IE9QVElPTkFMX1NFQ1RJT05fQ0FUQUxPRzogT3B0aW9uYWxTZWN0aW9uQ2F0YWxvZ0VudHJ5W10gPSBbXG4gIHtcbiAgICBpZDogXCJ3ZWJfc2VhcmNoXCIsXG4gICAgbGFiZWw6IFwiV2ViIHNlYXJjaFwiLFxuICAgIHByb3ZpZGVyczogW1xuICAgICAgeyBpZDogXCJicmF2ZVwiLCBsYWJlbDogXCJCcmF2ZSBTZWFyY2hcIiwgZW52VmFyOiBcIkJSQVZFX0FQSV9LRVlcIiB9LFxuICAgICAgeyBpZDogXCJ0YXZpbHlcIiwgbGFiZWw6IFwiVGF2aWx5XCIsIGVudlZhcjogXCJUQVZJTFlfQVBJX0tFWVwiIH0sXG4gICAgXSxcbiAgfSxcbiAge1xuICAgIGlkOiBcInRvb2xfa2V5c1wiLFxuICAgIGxhYmVsOiBcIlRvb2wgQVBJIGtleXNcIixcbiAgICBwcm92aWRlcnM6IFtcbiAgICAgIHsgaWQ6IFwiY29udGV4dDdcIiwgbGFiZWw6IFwiQ29udGV4dDdcIiwgZW52VmFyOiBcIkNPTlRFWFQ3X0FQSV9LRVlcIiB9LFxuICAgICAgeyBpZDogXCJqaW5hXCIsIGxhYmVsOiBcIkppbmEgQUlcIiwgZW52VmFyOiBcIkpJTkFfQVBJX0tFWVwiIH0sXG4gICAgICB7IGlkOiBcImdyb3FcIiwgbGFiZWw6IFwiR3JvcVwiLCBlbnZWYXI6IFwiR1JPUV9BUElfS0VZXCIgfSxcbiAgICBdLFxuICB9LFxuICB7XG4gICAgaWQ6IFwicmVtb3RlX3F1ZXN0aW9uc1wiLFxuICAgIGxhYmVsOiBcIlJlbW90ZSBxdWVzdGlvbnNcIixcbiAgICBwcm92aWRlcnM6IFtcbiAgICAgIHsgaWQ6IFwiZGlzY29yZF9ib3RcIiwgbGFiZWw6IFwiRGlzY29yZFwiLCBlbnZWYXI6IFwiRElTQ09SRF9CT1RfVE9LRU5cIiB9LFxuICAgICAgeyBpZDogXCJzbGFja19ib3RcIiwgbGFiZWw6IFwiU2xhY2tcIiwgZW52VmFyOiBcIlNMQUNLX0JPVF9UT0tFTlwiIH0sXG4gICAgICB7IGlkOiBcInRlbGVncmFtX2JvdFwiLCBsYWJlbDogXCJUZWxlZ3JhbVwiLCBlbnZWYXI6IFwiVEVMRUdSQU1fQk9UX1RPS0VOXCIgfSxcbiAgICBdLFxuICB9LFxuXTtcblxuLyoqXG4gKiBFeHRlcm5hbENsaSBwcm92aWRlcnMgYXV0aGVudGljYXRlIHRocm91Z2ggYSBsb2NhbCBDTEkgdG9vbCByYXRoZXIgdGhhblxuICogc3RvcmluZyBjcmVkZW50aWFscyBpbiBHU0QuIFRoZXkgYXJlIGFsd2F5cyB0cmVhdGVkIGFzIFwiY29uZmlndXJlZFwiIGJ5IHRoZVxuICogb25ib2FyZGluZyBzZXJ2aWNlIFx1MjAxNCBpZiB0aGUgYmluYXJ5IGlzIG1pc3NpbmcsIGluZmVyZW5jZSB3aWxsIGZhaWwgYXRcbiAqIHJ1bnRpbWUgKHRoZSBjb3JyZWN0IHBsYWNlIHRvIHN1cmZhY2UgdGhhdCBlcnJvcikuXG4gKlxuICogKipTeW5jIHJlcXVpcmVtZW50OioqIFRoaXMgc2V0IG11c3Qgc3RheSBpbiBzeW5jIHdpdGggYENMSV9BVVRIX1BST1ZJREVSU2BcbiAqIGluIGBzcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL2RvY3Rvci1wcm92aWRlcnMudHNgLiBJZiBhIG5ldyBFeHRlcm5hbENsaVxuICogcHJvdmlkZXIgaXMgYWRkZWQgdG8gb25lIHNldCBidXQgbm90IHRoZSBvdGhlciwgb25ib2FyZGluZyB3aWxsIHNpbGVudGx5XG4gKiBtaXMtY2xhc3NpZnkgaXQgKHRyZWF0aW5nIGl0IGFzIHVuY29uZmlndXJlZCBvciB2aWNlLXZlcnNhKS5cbiAqL1xuY29uc3QgQ0xJX0FVVEhfUFJPVklERVJfSURTID0gbmV3IFNldChbXG4gIFwiY2xhdWRlLWNvZGVcIixcbl0pO1xuXG5mdW5jdGlvbiBkZWZhdWx0SXNFeHRlcm5hbENsaVByb3ZpZGVyKGlkOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIENMSV9BVVRIX1BST1ZJREVSX0lEUy5oYXMoaWQpO1xufVxuXG5sZXQgb25ib2FyZGluZ1NlcnZpY2VPdmVycmlkZXM6IFBhcnRpYWw8T25ib2FyZGluZ1NlcnZpY2VEZXBzPiB8IG51bGwgPSBudWxsO1xubGV0IG9uYm9hcmRpbmdTZXJ2aWNlU2luZ2xldG9uOiBPbmJvYXJkaW5nU2VydmljZSB8IG51bGwgPSBudWxsO1xuXG5mdW5jdGlvbiBub3dJc28obm93OiAoKSA9PiBEYXRlKTogc3RyaW5nIHtcbiAgcmV0dXJuIG5vdygpLnRvSVNPU3RyaW5nKCk7XG59XG5cbmZ1bmN0aW9uIHJlZGFjdFNlbnNpdGl2ZVRleHQodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiB2YWx1ZVxuICAgIC5yZXBsYWNlKC9zay1bQS1aYS16MC05Xy1dezYsfS9nLCBcIltyZWRhY3RlZF1cIilcbiAgICAucmVwbGFjZSgveG94W2JhcHJzXS1bQS1aYS16MC05LV0rL2csIFwiW3JlZGFjdGVkXVwiKVxuICAgIC5yZXBsYWNlKC9CZWFyZXJcXHMrW15cXHNdKy9naSwgXCJCZWFyZXIgW3JlZGFjdGVkXVwiKVxuICAgIC5yZXBsYWNlKC8oW0EtWjAtOV9dKig/OkFQSVtfLV0/S0VZfFRPS0VOfFNFQ1JFVClbXCInPTpcXHNdKykoW15cXHMsO1wiJ10rKS9naSwgXCIkMVtyZWRhY3RlZF1cIik7XG59XG5cbmZ1bmN0aW9uIHNhbml0aXplTWVzc2FnZShtZXNzYWdlOiB1bmtub3duKTogc3RyaW5nIHtcbiAgY29uc3QgcmF3ID0gbWVzc2FnZSBpbnN0YW5jZW9mIEVycm9yID8gbWVzc2FnZS5tZXNzYWdlIDogU3RyaW5nKG1lc3NhZ2UpO1xuICByZXR1cm4gcmVkYWN0U2Vuc2l0aXZlVGV4dChyYXcpLnJlcGxhY2UoL1xccysvZywgXCIgXCIpLnRyaW0oKTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlSWRsZUJyaWRnZUF1dGhSZWZyZXNoU3RhdGUoKTogT25ib2FyZGluZ0JyaWRnZUF1dGhSZWZyZXNoU3RhdGUge1xuICByZXR1cm4ge1xuICAgIHBoYXNlOiBcImlkbGVcIixcbiAgICBzdHJhdGVneTogbnVsbCxcbiAgICBzdGFydGVkQXQ6IG51bGwsXG4gICAgY29tcGxldGVkQXQ6IG51bGwsXG4gICAgZXJyb3I6IG51bGwsXG4gIH07XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVPbmJvYXJkaW5nTG9ja1JlYXNvbihcbiAgcmVxdWlyZWRTYXRpc2ZpZWQ6IGJvb2xlYW4sXG4gIGJyaWRnZUF1dGhSZWZyZXNoOiBPbmJvYXJkaW5nQnJpZGdlQXV0aFJlZnJlc2hTdGF0ZSxcbik6IE9uYm9hcmRpbmdMb2NrUmVhc29uIHwgbnVsbCB7XG4gIGlmICghcmVxdWlyZWRTYXRpc2ZpZWQpIHtcbiAgICByZXR1cm4gXCJyZXF1aXJlZF9zZXR1cFwiO1xuICB9XG4gIGlmIChicmlkZ2VBdXRoUmVmcmVzaC5waGFzZSA9PT0gXCJwZW5kaW5nXCIpIHtcbiAgICByZXR1cm4gXCJicmlkZ2VfcmVmcmVzaF9wZW5kaW5nXCI7XG4gIH1cbiAgaWYgKGJyaWRnZUF1dGhSZWZyZXNoLnBoYXNlID09PSBcImZhaWxlZFwiKSB7XG4gICAgcmV0dXJuIFwiYnJpZGdlX3JlZnJlc2hfZmFpbGVkXCI7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIGhhc1N0b3JlZENyZWRlbnRpYWxWYWx1ZShhdXRoU3RvcmFnZTogQXV0aFN0b3JhZ2VJbnN0YW5jZSwgcHJvdmlkZXJJZDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBhdXRoU3RvcmFnZS5nZXRDcmVkZW50aWFsc0ZvclByb3ZpZGVyKHByb3ZpZGVySWQpLnNvbWUoKGNyZWRlbnRpYWwpID0+IHtcbiAgICBpZiAoY3JlZGVudGlhbC50eXBlID09PSBcIm9hdXRoXCIpIHtcbiAgICAgIHJldHVybiB0eXBlb2YgY3JlZGVudGlhbC5hY2Nlc3MgPT09IFwic3RyaW5nXCIgJiYgY3JlZGVudGlhbC5hY2Nlc3MudHJpbSgpLmxlbmd0aCA+IDA7XG4gICAgfVxuICAgIHJldHVybiB0eXBlb2YgY3JlZGVudGlhbC5rZXkgPT09IFwic3RyaW5nXCIgJiYgY3JlZGVudGlhbC5rZXkudHJpbSgpLmxlbmd0aCA+IDA7XG4gIH0pO1xufVxuXG5mdW5jdGlvbiByZXNvbHZlQ3JlZGVudGlhbFNvdXJjZShcbiAgYXV0aFN0b3JhZ2U6IEF1dGhTdG9yYWdlSW5zdGFuY2UsXG4gIHByb3ZpZGVySWQ6IHN0cmluZyxcbiAgZ2V0RW52QXBpS2V5Rm46IEdldEVudkFwaUtleUZuLFxuICBpc0V4dGVybmFsQ2xpUHJvdmlkZXJGbjogKGlkOiBzdHJpbmcpID0+IGJvb2xlYW4sXG4pOiBPbmJvYXJkaW5nQ3JlZGVudGlhbFNvdXJjZSB8IG51bGwge1xuICAvLyBFeHRlcm5hbENsaSBwcm92aWRlcnMgYXV0aGVudGljYXRlIHRocm91Z2ggYSBsb2NhbCBDTEkgXHUyMDE0IG5vIGNyZWRlbnRpYWxzXG4gIC8vIGFyZSBzdG9yZWQgaW4gR1NELiBUcmVhdCB0aGVtIGFzIGFsd2F5cyBjb25maWd1cmVkLlxuICBpZiAoaXNFeHRlcm5hbENsaVByb3ZpZGVyRm4ocHJvdmlkZXJJZCkpIHtcbiAgICByZXR1cm4gXCJleHRlcm5hbF9jbGlcIjtcbiAgfVxuICBpZiAoaGFzU3RvcmVkQ3JlZGVudGlhbFZhbHVlKGF1dGhTdG9yYWdlLCBwcm92aWRlcklkKSkge1xuICAgIHJldHVybiBcImF1dGhfZmlsZVwiO1xuICB9XG4gIGlmIChnZXRFbnZBcGlLZXlGbihwcm92aWRlcklkKSkge1xuICAgIHJldHVybiBcImVudmlyb25tZW50XCI7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIGV4dHJhY3RFcnJvckRldGFpbChwYXlsb2FkOiB1bmtub3duKTogc3RyaW5nIHwgbnVsbCB7XG4gIGlmICghcGF5bG9hZCkgcmV0dXJuIG51bGw7XG4gIGlmICh0eXBlb2YgcGF5bG9hZCA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIHBheWxvYWQ7XG4gIGlmICh0eXBlb2YgcGF5bG9hZCAhPT0gXCJvYmplY3RcIikgcmV0dXJuIG51bGw7XG5cbiAgY29uc3QgcmVjb3JkID0gcGF5bG9hZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgY29uc3QgY2FuZGlkYXRlcyA9IFtyZWNvcmQubWVzc2FnZSwgcmVjb3JkLmVycm9yLCByZWNvcmQuZGV0YWlsLCByZWNvcmQuZXJyb3JfZGVzY3JpcHRpb25dO1xuICBmb3IgKGNvbnN0IGNhbmRpZGF0ZSBvZiBjYW5kaWRhdGVzKSB7XG4gICAgaWYgKHR5cGVvZiBjYW5kaWRhdGUgPT09IFwic3RyaW5nXCIgJiYgY2FuZGlkYXRlLnRyaW0oKS5sZW5ndGggPiAwKSB7XG4gICAgICByZXR1cm4gY2FuZGlkYXRlO1xuICAgIH1cbiAgICBjb25zdCBuZXN0ZWQgPSBleHRyYWN0RXJyb3JEZXRhaWwoY2FuZGlkYXRlKTtcbiAgICBpZiAobmVzdGVkKSByZXR1cm4gbmVzdGVkO1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG5hc3luYyBmdW5jdGlvbiBwYXJzZUZhaWx1cmVNZXNzYWdlKHByb3ZpZGVySWQ6IHN0cmluZywgcmVzcG9uc2U6IFJlc3BvbnNlKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgbGV0IGRldGFpbCA9IFwiXCI7XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBjb250ZW50VHlwZSA9IHJlc3BvbnNlLmhlYWRlcnMuZ2V0KFwiY29udGVudC10eXBlXCIpIHx8IFwiXCI7XG4gICAgaWYgKGNvbnRlbnRUeXBlLmluY2x1ZGVzKFwiYXBwbGljYXRpb24vanNvblwiKSkge1xuICAgICAgY29uc3QgcGF5bG9hZCA9IGF3YWl0IHJlc3BvbnNlLmpzb24oKTtcbiAgICAgIGRldGFpbCA9IGV4dHJhY3RFcnJvckRldGFpbChwYXlsb2FkKSA/PyBKU09OLnN0cmluZ2lmeShwYXlsb2FkKTtcbiAgICB9IGVsc2Uge1xuICAgICAgZGV0YWlsID0gYXdhaXQgcmVzcG9uc2UudGV4dCgpO1xuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgZGV0YWlsID0gXCJcIjtcbiAgfVxuXG4gIGNvbnN0IHNhbml0aXplZERldGFpbCA9IHNhbml0aXplTWVzc2FnZShkZXRhaWwpO1xuICByZXR1cm4gc2FuaXRpemVkRGV0YWlsXG4gICAgPyBgJHtwcm92aWRlcklkfSB2YWxpZGF0aW9uIGZhaWxlZCAoJHtyZXNwb25zZS5zdGF0dXN9KTogJHtzYW5pdGl6ZWREZXRhaWx9YFxuICAgIDogYCR7cHJvdmlkZXJJZH0gdmFsaWRhdGlvbiBmYWlsZWQgKCR7cmVzcG9uc2Uuc3RhdHVzfSlgO1xufVxuXG5hc3luYyBmdW5jdGlvbiB2YWxpZGF0ZUJlYXJlclJlcXVlc3QoXG4gIGZldGNoSW1wbDogdHlwZW9mIGZldGNoLFxuICBwcm92aWRlcklkOiBzdHJpbmcsXG4gIHVybDogc3RyaW5nLFxuICBhcGlLZXk6IHN0cmluZyxcbiAgZXh0cmFIZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge30sXG4pOiBQcm9taXNlPFZhbGlkYXRpb25Qcm9iZVJlc3VsdD4ge1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2hJbXBsKHVybCwge1xuICAgICAgaGVhZGVyczoge1xuICAgICAgICBBdXRob3JpemF0aW9uOiBgQmVhcmVyICR7YXBpS2V5fWAsXG4gICAgICAgIC4uLmV4dHJhSGVhZGVycyxcbiAgICAgIH0sXG4gICAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoMTVfMDAwKSxcbiAgICB9KTtcblxuICAgIGlmICghcmVzcG9uc2Uub2spIHtcbiAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgbWVzc2FnZTogYXdhaXQgcGFyc2VGYWlsdXJlTWVzc2FnZShwcm92aWRlcklkLCByZXNwb25zZSkgfTtcbiAgICB9XG5cbiAgICByZXR1cm4geyBvazogdHJ1ZSwgbWVzc2FnZTogYCR7cHJvdmlkZXJJZH0gY3JlZGVudGlhbHMgdmFsaWRhdGVkYCB9O1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHJldHVybiB7IG9rOiBmYWxzZSwgbWVzc2FnZTogYCR7cHJvdmlkZXJJZH0gdmFsaWRhdGlvbiBmYWlsZWQ6ICR7c2FuaXRpemVNZXNzYWdlKGVycm9yKX1gIH07XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gdmFsaWRhdGVHb29nbGVBcGlLZXkoZmV0Y2hJbXBsOiB0eXBlb2YgZmV0Y2gsIGFwaUtleTogc3RyaW5nKTogUHJvbWlzZTxWYWxpZGF0aW9uUHJvYmVSZXN1bHQ+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCB1cmwgPSBuZXcgVVJMKFwiaHR0cHM6Ly9nZW5lcmF0aXZlbGFuZ3VhZ2UuZ29vZ2xlYXBpcy5jb20vdjFiZXRhL21vZGVsc1wiKTtcbiAgICB1cmwuc2VhcmNoUGFyYW1zLnNldChcImtleVwiLCBhcGlLZXkpO1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2hJbXBsKHVybCwgeyBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoMTVfMDAwKSB9KTtcbiAgICBpZiAoIXJlc3BvbnNlLm9rKSB7XG4gICAgICByZXR1cm4geyBvazogZmFsc2UsIG1lc3NhZ2U6IGF3YWl0IHBhcnNlRmFpbHVyZU1lc3NhZ2UoXCJnb29nbGVcIiwgcmVzcG9uc2UpIH07XG4gICAgfVxuICAgIHJldHVybiB7IG9rOiB0cnVlLCBtZXNzYWdlOiBcImdvb2dsZSBjcmVkZW50aWFscyB2YWxpZGF0ZWRcIiB9O1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHJldHVybiB7IG9rOiBmYWxzZSwgbWVzc2FnZTogYGdvb2dsZSB2YWxpZGF0aW9uIGZhaWxlZDogJHtzYW5pdGl6ZU1lc3NhZ2UoZXJyb3IpfWAgfTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiB2YWxpZGF0ZUFudGhyb3BpY0FwaUtleShmZXRjaEltcGw6IHR5cGVvZiBmZXRjaCwgYXBpS2V5OiBzdHJpbmcpOiBQcm9taXNlPFZhbGlkYXRpb25Qcm9iZVJlc3VsdD4ge1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2hJbXBsKFwiaHR0cHM6Ly9hcGkuYW50aHJvcGljLmNvbS92MS9tb2RlbHNcIiwge1xuICAgICAgaGVhZGVyczoge1xuICAgICAgICBcIngtYXBpLWtleVwiOiBhcGlLZXksXG4gICAgICAgIFwiYW50aHJvcGljLXZlcnNpb25cIjogXCIyMDIzLTA2LTAxXCIsXG4gICAgICB9LFxuICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDE1XzAwMCksXG4gICAgfSk7XG5cbiAgICBpZiAoIXJlc3BvbnNlLm9rKSB7XG4gICAgICByZXR1cm4geyBvazogZmFsc2UsIG1lc3NhZ2U6IGF3YWl0IHBhcnNlRmFpbHVyZU1lc3NhZ2UoXCJhbnRocm9waWNcIiwgcmVzcG9uc2UpIH07XG4gICAgfVxuXG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIG1lc3NhZ2U6IFwiYW50aHJvcGljIGNyZWRlbnRpYWxzIHZhbGlkYXRlZFwiIH07XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBtZXNzYWdlOiBgYW50aHJvcGljIHZhbGlkYXRpb24gZmFpbGVkOiAke3Nhbml0aXplTWVzc2FnZShlcnJvcil9YCB9O1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHZhbGlkYXRlQW50aHJvcGljQ29tcGF0aWJsZUFwaUtleShcbiAgZmV0Y2hJbXBsOiB0eXBlb2YgZmV0Y2gsXG4gIHByb3ZpZGVySWQ6IHN0cmluZyxcbiAgYXBpS2V5OiBzdHJpbmcsXG4gIGJhc2VVcmw6IHN0cmluZyxcbiAgbW9kZWw6IHN0cmluZyxcbik6IFByb21pc2U8VmFsaWRhdGlvblByb2JlUmVzdWx0PiB7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaEltcGwoYCR7YmFzZVVybH0vdjEvbWVzc2FnZXNgLCB7XG4gICAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgICAgaGVhZGVyczoge1xuICAgICAgICBcIngtYXBpLWtleVwiOiBhcGlLZXksXG4gICAgICAgIFwiYW50aHJvcGljLXZlcnNpb25cIjogXCIyMDIzLTA2LTAxXCIsXG4gICAgICAgIFwiY29udGVudC10eXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiLFxuICAgICAgfSxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgbW9kZWwsXG4gICAgICAgIG1heF90b2tlbnM6IDEsXG4gICAgICAgIG1lc3NhZ2VzOiBbeyByb2xlOiBcInVzZXJcIiwgY29udGVudDogXCJoaVwiIH1dLFxuICAgICAgfSksXG4gICAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoMTVfMDAwKSxcbiAgICB9KTtcblxuICAgIGlmICghcmVzcG9uc2Uub2spIHtcbiAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgbWVzc2FnZTogYXdhaXQgcGFyc2VGYWlsdXJlTWVzc2FnZShwcm92aWRlcklkLCByZXNwb25zZSkgfTtcbiAgICB9XG5cbiAgICByZXR1cm4geyBvazogdHJ1ZSwgbWVzc2FnZTogYCR7cHJvdmlkZXJJZH0gY3JlZGVudGlhbHMgdmFsaWRhdGVkYCB9O1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHJldHVybiB7IG9rOiBmYWxzZSwgbWVzc2FnZTogYCR7cHJvdmlkZXJJZH0gdmFsaWRhdGlvbiBmYWlsZWQ6ICR7c2FuaXRpemVNZXNzYWdlKGVycm9yKX1gIH07XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gZGVmYXVsdFZhbGlkYXRlQXBpS2V5KFxuICBwcm92aWRlcklkOiBzdHJpbmcsXG4gIGFwaUtleTogc3RyaW5nLFxuICBmZXRjaEltcGw6IHR5cGVvZiBmZXRjaCxcbik6IFByb21pc2U8VmFsaWRhdGlvblByb2JlUmVzdWx0PiB7XG4gIHN3aXRjaCAocHJvdmlkZXJJZCkge1xuICAgIGNhc2UgXCJhbnRocm9waWNcIjpcbiAgICAgIHJldHVybiBhd2FpdCB2YWxpZGF0ZUFudGhyb3BpY0FwaUtleShmZXRjaEltcGwsIGFwaUtleSk7XG4gICAgY2FzZSBcIm9wZW5haVwiOlxuICAgICAgcmV0dXJuIGF3YWl0IHZhbGlkYXRlQmVhcmVyUmVxdWVzdChmZXRjaEltcGwsIHByb3ZpZGVySWQsIFwiaHR0cHM6Ly9hcGkub3BlbmFpLmNvbS92MS9tb2RlbHNcIiwgYXBpS2V5KTtcbiAgICBjYXNlIFwiZ29vZ2xlXCI6XG4gICAgICByZXR1cm4gYXdhaXQgdmFsaWRhdGVHb29nbGVBcGlLZXkoZmV0Y2hJbXBsLCBhcGlLZXkpO1xuICAgIGNhc2UgXCJncm9xXCI6XG4gICAgICByZXR1cm4gYXdhaXQgdmFsaWRhdGVCZWFyZXJSZXF1ZXN0KGZldGNoSW1wbCwgcHJvdmlkZXJJZCwgXCJodHRwczovL2FwaS5ncm9xLmNvbS9vcGVuYWkvdjEvbW9kZWxzXCIsIGFwaUtleSk7XG4gICAgY2FzZSBcInhhaVwiOlxuICAgICAgcmV0dXJuIGF3YWl0IHZhbGlkYXRlQmVhcmVyUmVxdWVzdChmZXRjaEltcGwsIHByb3ZpZGVySWQsIFwiaHR0cHM6Ly9hcGkueC5haS92MS9tb2RlbHNcIiwgYXBpS2V5KTtcbiAgICBjYXNlIFwib3BlbnJvdXRlclwiOlxuICAgICAgcmV0dXJuIGF3YWl0IHZhbGlkYXRlQmVhcmVyUmVxdWVzdChmZXRjaEltcGwsIHByb3ZpZGVySWQsIFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MS9tb2RlbHNcIiwgYXBpS2V5LCB7XG4gICAgICAgIFwiSFRUUC1SZWZlcmVyXCI6IFwiaHR0cHM6Ly9sb2NhbGhvc3RcIixcbiAgICAgICAgXCJYLVRpdGxlXCI6IFwiR1NEIG9uYm9hcmRpbmdcIixcbiAgICAgIH0pO1xuICAgIGNhc2UgXCJtaXN0cmFsXCI6XG4gICAgICByZXR1cm4gYXdhaXQgdmFsaWRhdGVCZWFyZXJSZXF1ZXN0KGZldGNoSW1wbCwgcHJvdmlkZXJJZCwgXCJodHRwczovL2FwaS5taXN0cmFsLmFpL3YxL21vZGVsc1wiLCBhcGlLZXkpO1xuICAgIGNhc2UgXCJtaW5pbWF4XCI6XG4gICAgICByZXR1cm4gYXdhaXQgdmFsaWRhdGVBbnRocm9waWNDb21wYXRpYmxlQXBpS2V5KFxuICAgICAgICBmZXRjaEltcGwsXG4gICAgICAgIHByb3ZpZGVySWQsXG4gICAgICAgIGFwaUtleSxcbiAgICAgICAgXCJodHRwczovL2FwaS5taW5pbWF4LmlvL2FudGhyb3BpY1wiLFxuICAgICAgICBcIk1pbmlNYXgtTTIuN1wiLFxuICAgICAgKTtcbiAgICBjYXNlIFwibWluaW1heC1jblwiOlxuICAgICAgcmV0dXJuIGF3YWl0IHZhbGlkYXRlQW50aHJvcGljQ29tcGF0aWJsZUFwaUtleShcbiAgICAgICAgZmV0Y2hJbXBsLFxuICAgICAgICBwcm92aWRlcklkLFxuICAgICAgICBhcGlLZXksXG4gICAgICAgIFwiaHR0cHM6Ly9hcGkubWluaW1heGkuY29tL2FudGhyb3BpY1wiLFxuICAgICAgICBcIk1pbmlNYXgtTTIuN1wiLFxuICAgICAgKTtcbiAgICBkZWZhdWx0OlxuICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBtZXNzYWdlOiBgJHtwcm92aWRlcklkfSBkb2VzIG5vdCBzdXBwb3J0IEFQSS1rZXkgdmFsaWRhdGlvbiB2aWEgb25ib2FyZGluZ2AgfTtcbiAgfVxufVxuXG5mdW5jdGlvbiByZXNvbHZlUnVudGltZVRlc3RJc0V4dGVybmFsQ2xpUHJvdmlkZXIoZW52OiBOb2RlSlMuUHJvY2Vzc0Vudik6IE9uYm9hcmRpbmdTZXJ2aWNlRGVwc1tcImlzRXh0ZXJuYWxDbGlQcm92aWRlclwiXSB8IHVuZGVmaW5lZCB7XG4gIGlmIChlbnYuR1NEX1dFQl9URVNUX0RJU0FCTEVfRVhURVJOQUxfQ0xJICE9PSBcIjFcIikge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbiAgcmV0dXJuICgpID0+IGZhbHNlO1xufVxuXG5mdW5jdGlvbiByZXNvbHZlUnVudGltZVRlc3RWYWxpZGF0ZUFwaUtleShlbnY6IE5vZGVKUy5Qcm9jZXNzRW52KTogT25ib2FyZGluZ1NlcnZpY2VEZXBzW1widmFsaWRhdGVBcGlLZXlcIl0gfCB1bmRlZmluZWQge1xuICBpZiAoZW52LkdTRF9XRUJfVEVTVF9GQUtFX0FQSV9LRVlfVkFMSURBVElPTiAhPT0gXCIxXCIpIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG5cbiAgcmV0dXJuIGFzeW5jIChwcm92aWRlcklkOiBzdHJpbmcsIGFwaUtleTogc3RyaW5nKSA9PiB7XG4gICAgY29uc3QgcHJvdmlkZXJMYWJlbCA9IFJFUVVJUkVEX1BST1ZJREVSX0NBVEFMT0cuZmluZCgoZW50cnkpID0+IGVudHJ5LmlkID09PSBwcm92aWRlcklkKT8ubGFiZWwgPz8gcHJvdmlkZXJJZDtcbiAgICBjb25zdCBjYW5kaWRhdGUgPSBhcGlLZXkudHJpbSgpLnRvTG93ZXJDYXNlKCk7XG4gICAgaWYgKCFjYW5kaWRhdGUgfHwgY2FuZGlkYXRlLmluY2x1ZGVzKFwiaW52YWxpZFwiKSB8fCBjYW5kaWRhdGUuaW5jbHVkZXMoXCJyZWplY3RcIikgfHwgY2FuZGlkYXRlLmluY2x1ZGVzKFwiZmFpbFwiKSkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICBtZXNzYWdlOiBgJHtwcm92aWRlckxhYmVsfSByZWplY3RlZCB0aGUgc3VwcGxpZWQga2V5YCxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiB0cnVlLFxuICAgICAgbWVzc2FnZTogYCR7cHJvdmlkZXJMYWJlbH0gY3JlZGVudGlhbHMgdmFsaWRhdGVkYCxcbiAgICB9O1xuICB9O1xufVxuXG5mdW5jdGlvbiBnZXRPbmJvYXJkaW5nRGVwcygpOiBPbmJvYXJkaW5nU2VydmljZURlcHMge1xuICByZXR1cm4ge1xuICAgIGVudjogcHJvY2Vzcy5lbnYsXG4gICAgYXV0aFBhdGg6IGF1dGhGaWxlUGF0aCxcbiAgICBmZXRjaCxcbiAgICBub3c6ICgpID0+IG5ldyBEYXRlKCksXG4gICAgY3JlYXRlRmxvd0lkOiAoKSA9PiByYW5kb21VVUlEKCksXG4gICAgdmFsaWRhdGVBcGlLZXk6IHJlc29sdmVSdW50aW1lVGVzdFZhbGlkYXRlQXBpS2V5KHByb2Nlc3MuZW52KSxcbiAgICBpc0V4dGVybmFsQ2xpUHJvdmlkZXI6IHJlc29sdmVSdW50aW1lVGVzdElzRXh0ZXJuYWxDbGlQcm92aWRlcihwcm9jZXNzLmVudiksXG4gICAgcmVmcmVzaEJyaWRnZUF1dGg6IG9uYm9hcmRpbmdCcmlkZ2VBdXRoUmVmcmVzaGVyID8/IHVuZGVmaW5lZCxcbiAgICAuLi4ob25ib2FyZGluZ1NlcnZpY2VPdmVycmlkZXMgPz8ge30pLFxuICB9O1xufVxuXG5leHBvcnQgY2xhc3MgT25ib2FyZGluZ1NlcnZpY2Uge1xuICBwcml2YXRlIHJlYWRvbmx5IGRlcHM6IE9uYm9hcmRpbmdTZXJ2aWNlRGVwcztcbiAgcHJpdmF0ZSBhdXRoU3RvcmFnZTogQXV0aFN0b3JhZ2VJbnN0YW5jZSB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIGxhc3RWYWxpZGF0aW9uOiBPbmJvYXJkaW5nVmFsaWRhdGlvblJlc3VsdCB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIGFjdGl2ZUZsb3c6IFByb3ZpZGVyRmxvd1J1bnRpbWUgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBicmlkZ2VBdXRoUmVmcmVzaDogT25ib2FyZGluZ0JyaWRnZUF1dGhSZWZyZXNoU3RhdGUgPSBjcmVhdGVJZGxlQnJpZGdlQXV0aFJlZnJlc2hTdGF0ZSgpO1xuXG4gIGNvbnN0cnVjdG9yKGRlcHM6IE9uYm9hcmRpbmdTZXJ2aWNlRGVwcykge1xuICAgIHRoaXMuZGVwcyA9IGRlcHM7XG4gIH1cblxuICBhc3luYyBnZXRTdGF0ZSgpOiBQcm9taXNlPE9uYm9hcmRpbmdTdGF0ZT4ge1xuICAgIHJldHVybiB0aGlzLmJ1aWxkU3RhdGUoKTtcbiAgfVxuXG4gIGFzeW5jIHZhbGlkYXRlQW5kU2F2ZUFwaUtleShwcm92aWRlcklkOiBzdHJpbmcsIGFwaUtleTogc3RyaW5nKTogUHJvbWlzZTxPbmJvYXJkaW5nU3RhdGU+IHtcbiAgICBjb25zdCBwcm92aWRlciA9IFJFUVVJUkVEX1BST1ZJREVSX0NBVEFMT0cuZmluZCgoZW50cnkpID0+IGVudHJ5LmlkID09PSBwcm92aWRlcklkKTtcbiAgICBpZiAoIXByb3ZpZGVyKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFVua25vd24gb25ib2FyZGluZyBwcm92aWRlcjogJHtwcm92aWRlcklkfWApO1xuICAgIH1cbiAgICBpZiAoIXByb3ZpZGVyLnN1cHBvcnRzQXBpS2V5KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYCR7cHJvdmlkZXJJZH0gbXVzdCBiZSBjb25maWd1cmVkIHdpdGggYnJvd3NlciBzaWduLWluYCk7XG4gICAgfVxuXG4gICAgY29uc3QgdHJpbW1lZEtleSA9IGFwaUtleS50cmltKCk7XG4gICAgaWYgKCF0cmltbWVkS2V5KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBUEkga2V5IGlzIHJlcXVpcmVkXCIpO1xuICAgIH1cblxuICAgIGNvbnN0IHZhbGlkYXRlQXBpS2V5ID1cbiAgICAgIHRoaXMuZGVwcy52YWxpZGF0ZUFwaUtleSA/P1xuICAgICAgKGFzeW5jIChjYW5kaWRhdGVQcm92aWRlcklkOiBzdHJpbmcsIGNhbmRpZGF0ZUFwaUtleTogc3RyaW5nKSA9PlxuICAgICAgICBhd2FpdCBkZWZhdWx0VmFsaWRhdGVBcGlLZXkoY2FuZGlkYXRlUHJvdmlkZXJJZCwgY2FuZGlkYXRlQXBpS2V5LCB0aGlzLmRlcHMuZmV0Y2ggPz8gZmV0Y2gpKTtcblxuICAgIGNvbnN0IHZhbGlkYXRpb24gPSBhd2FpdCB2YWxpZGF0ZUFwaUtleShwcm92aWRlcklkLCB0cmltbWVkS2V5KTtcbiAgICBjb25zdCBjaGVja2VkQXQgPSBub3dJc28odGhpcy5kZXBzLm5vdyA/PyAoKCkgPT4gbmV3IERhdGUoKSkpO1xuXG4gICAgaWYgKCF2YWxpZGF0aW9uLm9rKSB7XG4gICAgICB0aGlzLmxhc3RWYWxpZGF0aW9uID0ge1xuICAgICAgICBzdGF0dXM6IFwiZmFpbGVkXCIsXG4gICAgICAgIHByb3ZpZGVySWQsXG4gICAgICAgIG1ldGhvZDogXCJhcGlfa2V5XCIsXG4gICAgICAgIGNoZWNrZWRBdCxcbiAgICAgICAgbWVzc2FnZTogc2FuaXRpemVNZXNzYWdlKHZhbGlkYXRpb24ubWVzc2FnZSksXG4gICAgICAgIHBlcnNpc3RlZDogZmFsc2UsXG4gICAgICB9O1xuICAgICAgcmV0dXJuIGF3YWl0IHRoaXMuYnVpbGRTdGF0ZSgpO1xuICAgIH1cblxuICAgIGNvbnN0IGF1dGhTdG9yYWdlID0gYXdhaXQgdGhpcy5nZXRBdXRoU3RvcmFnZSgpO1xuICAgIGF1dGhTdG9yYWdlLnJlbG9hZCgpO1xuICAgIGF1dGhTdG9yYWdlLnNldChwcm92aWRlcklkLCB7IHR5cGU6IFwiYXBpX2tleVwiLCBrZXk6IHRyaW1tZWRLZXkgfSk7XG4gICAgdGhpcy5sYXN0VmFsaWRhdGlvbiA9IHtcbiAgICAgIHN0YXR1czogXCJzdWNjZWVkZWRcIixcbiAgICAgIHByb3ZpZGVySWQsXG4gICAgICBtZXRob2Q6IFwiYXBpX2tleVwiLFxuICAgICAgY2hlY2tlZEF0LFxuICAgICAgbWVzc2FnZTogc2FuaXRpemVNZXNzYWdlKHZhbGlkYXRpb24ubWVzc2FnZSB8fCBgJHtwcm92aWRlcklkfSBjcmVkZW50aWFscyB2YWxpZGF0ZWRgKSxcbiAgICAgIHBlcnNpc3RlZDogdHJ1ZSxcbiAgICB9O1xuICAgIGF3YWl0IHRoaXMucmVmcmVzaEJyaWRnZUF1dGgoKTtcblxuICAgIHJldHVybiBhd2FpdCB0aGlzLmJ1aWxkU3RhdGUoKTtcbiAgfVxuXG4gIGFzeW5jIHN0YXJ0UHJvdmlkZXJGbG93KHByb3ZpZGVySWQ6IHN0cmluZyk6IFByb21pc2U8T25ib2FyZGluZ1N0YXRlPiB7XG4gICAgY29uc3QgYXV0aFN0b3JhZ2UgPSBhd2FpdCB0aGlzLmdldEF1dGhTdG9yYWdlKCk7XG4gICAgYXV0aFN0b3JhZ2UucmVsb2FkKCk7XG5cbiAgICBjb25zdCBvYXV0aFByb3ZpZGVyID0gYXV0aFN0b3JhZ2UuZ2V0T0F1dGhQcm92aWRlcnMoKS5maW5kKChwcm92aWRlcikgPT4gcHJvdmlkZXIuaWQgPT09IHByb3ZpZGVySWQpO1xuICAgIGlmICghb2F1dGhQcm92aWRlcikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBPQXV0aCBwcm92aWRlciBub3QgYXZhaWxhYmxlIGZvciBvbmJvYXJkaW5nOiAke3Byb3ZpZGVySWR9YCk7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuYWN0aXZlRmxvdyAmJiBbXCJydW5uaW5nXCIsIFwiYXdhaXRpbmdfYnJvd3Nlcl9hdXRoXCIsIFwiYXdhaXRpbmdfaW5wdXRcIl0uaW5jbHVkZXModGhpcy5hY3RpdmVGbG93LnN0YXRlLnN0YXR1cykpIHtcbiAgICAgIHRoaXMuY2FuY2VsQWN0aXZlRmxvdygpO1xuICAgIH1cblxuICAgIGNvbnN0IHJ1bnRpbWU6IFByb3ZpZGVyRmxvd1J1bnRpbWUgPSB7XG4gICAgICBzdGF0ZToge1xuICAgICAgICBmbG93SWQ6ICh0aGlzLmRlcHMuY3JlYXRlRmxvd0lkID8/ICgoKSA9PiByYW5kb21VVUlEKCkpKSgpLFxuICAgICAgICBwcm92aWRlcklkLFxuICAgICAgICBwcm92aWRlckxhYmVsOiBvYXV0aFByb3ZpZGVyLm5hbWUsXG4gICAgICAgIHN0YXR1czogXCJydW5uaW5nXCIsXG4gICAgICAgIHVwZGF0ZWRBdDogbm93SXNvKHRoaXMuZGVwcy5ub3cgPz8gKCgpID0+IG5ldyBEYXRlKCkpKSxcbiAgICAgICAgYXV0aDogbnVsbCxcbiAgICAgICAgcHJvbXB0OiBudWxsLFxuICAgICAgICBwcm9ncmVzczogW10sXG4gICAgICAgIGVycm9yOiBudWxsLFxuICAgICAgfSxcbiAgICAgIGF3YWl0aW5nSW5wdXQ6IG51bGwsXG4gICAgICBhYm9ydENvbnRyb2xsZXI6IG5ldyBBYm9ydENvbnRyb2xsZXIoKSxcbiAgICB9O1xuXG4gICAgdGhpcy5hY3RpdmVGbG93ID0gcnVudGltZTtcbiAgICB2b2lkIHRoaXMucnVuT0F1dGhGbG93KHJ1bnRpbWUsIG9hdXRoUHJvdmlkZXIsIGF1dGhTdG9yYWdlKTtcbiAgICByZXR1cm4gYXdhaXQgdGhpcy5idWlsZFN0YXRlKCk7XG4gIH1cblxuICBhc3luYyBzdWJtaXRQcm92aWRlckZsb3dJbnB1dChmbG93SWQ6IHN0cmluZywgaW5wdXQ6IHN0cmluZyk6IFByb21pc2U8T25ib2FyZGluZ1N0YXRlPiB7XG4gICAgY29uc3QgcnVudGltZSA9IHRoaXMuYWN0aXZlRmxvdztcbiAgICBpZiAoIXJ1bnRpbWUgfHwgcnVudGltZS5zdGF0ZS5mbG93SWQgIT09IGZsb3dJZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbmtub3duIG9uYm9hcmRpbmcgZmxvdzogJHtmbG93SWR9YCk7XG4gICAgfVxuICAgIGlmICghcnVudGltZS5hd2FpdGluZ0lucHV0KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYE9uYm9hcmRpbmcgZmxvdyAke2Zsb3dJZH0gaXMgbm90IHdhaXRpbmcgZm9yIGlucHV0YCk7XG4gICAgfVxuXG4gICAgY29uc3QgcmVzb2x2ZUlucHV0ID0gcnVudGltZS5hd2FpdGluZ0lucHV0O1xuICAgIHJ1bnRpbWUuYXdhaXRpbmdJbnB1dCA9IG51bGw7XG4gICAgcnVudGltZS5zdGF0ZS5wcm9tcHQgPSBudWxsO1xuICAgIHJ1bnRpbWUuc3RhdGUuc3RhdHVzID0gXCJydW5uaW5nXCI7XG4gICAgcnVudGltZS5zdGF0ZS51cGRhdGVkQXQgPSBub3dJc28odGhpcy5kZXBzLm5vdyA/PyAoKCkgPT4gbmV3IERhdGUoKSkpO1xuICAgIHJlc29sdmVJbnB1dChpbnB1dCk7XG5cbiAgICByZXR1cm4gYXdhaXQgdGhpcy5idWlsZFN0YXRlKCk7XG4gIH1cblxuICBhc3luYyBjYW5jZWxQcm92aWRlckZsb3coZmxvd0lkOiBzdHJpbmcpOiBQcm9taXNlPE9uYm9hcmRpbmdTdGF0ZT4ge1xuICAgIGNvbnN0IHJ1bnRpbWUgPSB0aGlzLmFjdGl2ZUZsb3c7XG4gICAgaWYgKCFydW50aW1lIHx8IHJ1bnRpbWUuc3RhdGUuZmxvd0lkICE9PSBmbG93SWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgVW5rbm93biBvbmJvYXJkaW5nIGZsb3c6ICR7Zmxvd0lkfWApO1xuICAgIH1cblxuICAgIHRoaXMuY2FuY2VsQWN0aXZlRmxvdygpO1xuICAgIHJldHVybiBhd2FpdCB0aGlzLmJ1aWxkU3RhdGUoKTtcbiAgfVxuXG4gIGFzeW5jIGxvZ291dFByb3ZpZGVyKHByb3ZpZGVySWQ6IHN0cmluZyk6IFByb21pc2U8T25ib2FyZGluZ1N0YXRlPiB7XG4gICAgY29uc3QgYXV0aFN0b3JhZ2UgPSBhd2FpdCB0aGlzLmdldEF1dGhTdG9yYWdlKCk7XG4gICAgYXV0aFN0b3JhZ2UucmVsb2FkKCk7XG5cbiAgICBjb25zdCBjdXJyZW50U3RhdGUgPSBhd2FpdCB0aGlzLmJ1aWxkU3RhdGUoKTtcbiAgICBjb25zdCByZXF1ZXN0ZWRQcm92aWRlcklkID0gcHJvdmlkZXJJZC50cmltKCk7XG4gICAgY29uc3QgcmVzb2x2ZWRQcm92aWRlcklkID1cbiAgICAgIHJlcXVlc3RlZFByb3ZpZGVySWQgfHxcbiAgICAgIGN1cnJlbnRTdGF0ZS5yZXF1aXJlZC5zYXRpc2ZpZWRCeT8ucHJvdmlkZXJJZCB8fFxuICAgICAgY3VycmVudFN0YXRlLnJlcXVpcmVkLnByb3ZpZGVycy5maW5kKChwcm92aWRlcikgPT4gcHJvdmlkZXIuY29uZmlndXJlZCk/LmlkO1xuXG4gICAgaWYgKCFyZXNvbHZlZFByb3ZpZGVySWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIk5vIGNvbmZpZ3VyZWQgcHJvdmlkZXIgaXMgYXZhaWxhYmxlIHRvIGxvZyBvdXRcIik7XG4gICAgfVxuXG4gICAgY29uc3QgcHJvdmlkZXJTdGF0ZSA9IGN1cnJlbnRTdGF0ZS5yZXF1aXJlZC5wcm92aWRlcnMuZmluZCgocHJvdmlkZXIpID0+IHByb3ZpZGVyLmlkID09PSByZXNvbHZlZFByb3ZpZGVySWQpO1xuICAgIGNvbnN0IHByb3ZpZGVyTGFiZWwgPSBwcm92aWRlclN0YXRlPy5sYWJlbCA/PyByZXNvbHZlZFByb3ZpZGVySWQ7XG5cbiAgICBpZiAoIXByb3ZpZGVyU3RhdGU/LmNvbmZpZ3VyZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgJHtwcm92aWRlckxhYmVsfSBpcyBub3QgY29uZmlndXJlZCBpbiB0aGlzIHdvcmtzcGFjZWApO1xuICAgIH1cblxuICAgIGlmIChwcm92aWRlclN0YXRlLmNvbmZpZ3VyZWRWaWEgIT09IFwiYXV0aF9maWxlXCIpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgJHtwcm92aWRlckxhYmVsfSBpcyBjb25maWd1cmVkIHZpYSAke3Byb3ZpZGVyU3RhdGUuY29uZmlndXJlZFZpYX0gYW5kIGNhbm5vdCBiZSBsb2dnZWQgb3V0IGZyb20gdGhlIGJyb3dzZXIgc3VyZmFjZWApO1xuICAgIH1cblxuICAgIGlmIChcbiAgICAgIHRoaXMuYWN0aXZlRmxvdyAmJlxuICAgICAgdGhpcy5hY3RpdmVGbG93LnN0YXRlLnByb3ZpZGVySWQgPT09IHJlc29sdmVkUHJvdmlkZXJJZCAmJlxuICAgICAgW1wicnVubmluZ1wiLCBcImF3YWl0aW5nX2Jyb3dzZXJfYXV0aFwiLCBcImF3YWl0aW5nX2lucHV0XCJdLmluY2x1ZGVzKHRoaXMuYWN0aXZlRmxvdy5zdGF0ZS5zdGF0dXMpXG4gICAgKSB7XG4gICAgICB0aGlzLmNhbmNlbEFjdGl2ZUZsb3coKTtcbiAgICB9XG5cbiAgICBhdXRoU3RvcmFnZS5sb2dvdXQocmVzb2x2ZWRQcm92aWRlcklkKTtcbiAgICB0aGlzLmxhc3RWYWxpZGF0aW9uID0gbnVsbDtcbiAgICBhd2FpdCB0aGlzLnJlZnJlc2hCcmlkZ2VBdXRoKCk7XG4gICAgcmV0dXJuIGF3YWl0IHRoaXMuYnVpbGRTdGF0ZSgpO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyByZWZyZXNoQnJpZGdlQXV0aCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCByZWZyZXNoQnJpZGdlQXV0aCA9IHRoaXMuZGVwcy5yZWZyZXNoQnJpZGdlQXV0aDtcbiAgICBpZiAoIXJlZnJlc2hCcmlkZ2VBdXRoKSB7XG4gICAgICB0aGlzLmJyaWRnZUF1dGhSZWZyZXNoID0gY3JlYXRlSWRsZUJyaWRnZUF1dGhSZWZyZXNoU3RhdGUoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCBzdGFydGVkQXQgPSBub3dJc28odGhpcy5kZXBzLm5vdyA/PyAoKCkgPT4gbmV3IERhdGUoKSkpO1xuICAgIHRoaXMuYnJpZGdlQXV0aFJlZnJlc2ggPSB7XG4gICAgICBwaGFzZTogXCJwZW5kaW5nXCIsXG4gICAgICBzdHJhdGVneTogXCJyZXN0YXJ0XCIsXG4gICAgICBzdGFydGVkQXQsXG4gICAgICBjb21wbGV0ZWRBdDogbnVsbCxcbiAgICAgIGVycm9yOiBudWxsLFxuICAgIH07XG5cbiAgICB0cnkge1xuICAgICAgYXdhaXQgcmVmcmVzaEJyaWRnZUF1dGgoKTtcbiAgICAgIHRoaXMuYnJpZGdlQXV0aFJlZnJlc2ggPSB7XG4gICAgICAgIHBoYXNlOiBcInN1Y2NlZWRlZFwiLFxuICAgICAgICBzdHJhdGVneTogXCJyZXN0YXJ0XCIsXG4gICAgICAgIHN0YXJ0ZWRBdCxcbiAgICAgICAgY29tcGxldGVkQXQ6IG5vd0lzbyh0aGlzLmRlcHMubm93ID8/ICgoKSA9PiBuZXcgRGF0ZSgpKSksXG4gICAgICAgIGVycm9yOiBudWxsLFxuICAgICAgfTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgdGhpcy5icmlkZ2VBdXRoUmVmcmVzaCA9IHtcbiAgICAgICAgcGhhc2U6IFwiZmFpbGVkXCIsXG4gICAgICAgIHN0cmF0ZWd5OiBcInJlc3RhcnRcIixcbiAgICAgICAgc3RhcnRlZEF0LFxuICAgICAgICBjb21wbGV0ZWRBdDogbm93SXNvKHRoaXMuZGVwcy5ub3cgPz8gKCgpID0+IG5ldyBEYXRlKCkpKSxcbiAgICAgICAgZXJyb3I6IHNhbml0aXplTWVzc2FnZShlcnJvciksXG4gICAgICB9O1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgZ2V0QXV0aFN0b3JhZ2UoKTogUHJvbWlzZTxBdXRoU3RvcmFnZUluc3RhbmNlPiB7XG4gICAgaWYgKCF0aGlzLmF1dGhTdG9yYWdlKSB7XG4gICAgICBpZiAodGhpcy5kZXBzLmF1dGhTdG9yYWdlKSB7XG4gICAgICAgIHRoaXMuYXV0aFN0b3JhZ2UgPSB0aGlzLmRlcHMuYXV0aFN0b3JhZ2U7XG4gICAgICB9IGVsc2UgaWYgKHRoaXMuZGVwcy5jcmVhdGVBdXRoU3RvcmFnZSkge1xuICAgICAgICB0aGlzLmF1dGhTdG9yYWdlID0gYXdhaXQgdGhpcy5kZXBzLmNyZWF0ZUF1dGhTdG9yYWdlKHRoaXMuZGVwcy5hdXRoUGF0aCA/PyBhdXRoRmlsZVBhdGgpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5hdXRoU3RvcmFnZSA9IGNyZWF0ZU9uYm9hcmRpbmdBdXRoU3RvcmFnZSh0aGlzLmRlcHMuYXV0aFBhdGggPz8gYXV0aEZpbGVQYXRoKTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHRoaXMuYXV0aFN0b3JhZ2U7XG4gIH1cblxuICBwcml2YXRlIGJ1aWxkT3B0aW9uYWxTZWN0aW9uU3RhdGUoYXV0aFN0b3JhZ2U6IEF1dGhTdG9yYWdlSW5zdGFuY2UpOiBPbmJvYXJkaW5nT3B0aW9uYWxTZWN0aW9uU3RhdGVbXSB7XG4gICAgY29uc3QgZW52ID0gdGhpcy5kZXBzLmVudiA/PyBwcm9jZXNzLmVudjtcblxuICAgIHJldHVybiBPUFRJT05BTF9TRUNUSU9OX0NBVEFMT0cubWFwKChzZWN0aW9uKSA9PiB7XG4gICAgICBjb25zdCBjb25maWd1cmVkSXRlbXMgPSBzZWN0aW9uLnByb3ZpZGVyc1xuICAgICAgICAuZmlsdGVyKChwcm92aWRlcikgPT4ge1xuICAgICAgICAgIGNvbnN0IGVudkNvbmZpZ3VyZWQgPSBwcm92aWRlci5lbnZWYXIgPyB0eXBlb2YgZW52W3Byb3ZpZGVyLmVudlZhcl0gPT09IFwic3RyaW5nXCIgJiYgZW52W3Byb3ZpZGVyLmVudlZhcl0hLnRyaW0oKS5sZW5ndGggPiAwIDogZmFsc2U7XG4gICAgICAgICAgY29uc3Qgc3RvcmVkQ29uZmlndXJlZCA9IGhhc1N0b3JlZENyZWRlbnRpYWxWYWx1ZShhdXRoU3RvcmFnZSwgcHJvdmlkZXIuaWQpO1xuICAgICAgICAgIHJldHVybiBlbnZDb25maWd1cmVkIHx8IHN0b3JlZENvbmZpZ3VyZWQ7XG4gICAgICAgIH0pXG4gICAgICAgIC5tYXAoKHByb3ZpZGVyKSA9PiBwcm92aWRlci5sYWJlbCk7XG5cbiAgICAgIHJldHVybiB7XG4gICAgICAgIGlkOiBzZWN0aW9uLmlkLFxuICAgICAgICBsYWJlbDogc2VjdGlvbi5sYWJlbCxcbiAgICAgICAgYmxvY2tpbmc6IGZhbHNlLFxuICAgICAgICBza2lwcGFibGU6IHRydWUsXG4gICAgICAgIGNvbmZpZ3VyZWQ6IGNvbmZpZ3VyZWRJdGVtcy5sZW5ndGggPiAwLFxuICAgICAgICBjb25maWd1cmVkSXRlbXMsXG4gICAgICB9O1xuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBidWlsZFByb3ZpZGVyU3RhdGUoXG4gICAgYXV0aFN0b3JhZ2U6IEF1dGhTdG9yYWdlSW5zdGFuY2UsXG4gICAgZ2V0RW52QXBpS2V5Rm46IEdldEVudkFwaUtleUZuLFxuICApOiBPbmJvYXJkaW5nUHJvdmlkZXJTdGF0ZVtdIHtcbiAgICBjb25zdCBvYXV0aFByb3ZpZGVycyA9IG5ldyBNYXAoYXV0aFN0b3JhZ2UuZ2V0T0F1dGhQcm92aWRlcnMoKS5tYXAoKHByb3ZpZGVyKSA9PiBbcHJvdmlkZXIuaWQsIHByb3ZpZGVyXSkpO1xuICAgIGNvbnN0IGlzRXh0ZXJuYWxDbGlQcm92aWRlckZuID0gdGhpcy5kZXBzLmlzRXh0ZXJuYWxDbGlQcm92aWRlciA/PyBkZWZhdWx0SXNFeHRlcm5hbENsaVByb3ZpZGVyO1xuXG4gICAgcmV0dXJuIFJFUVVJUkVEX1BST1ZJREVSX0NBVEFMT0cubWFwKChwcm92aWRlcikgPT4ge1xuICAgICAgY29uc3Qgb2F1dGhQcm92aWRlciA9IG9hdXRoUHJvdmlkZXJzLmdldChwcm92aWRlci5pZCk7XG4gICAgICBjb25zdCBjb25maWd1cmVkVmlhID0gcmVzb2x2ZUNyZWRlbnRpYWxTb3VyY2UoYXV0aFN0b3JhZ2UsIHByb3ZpZGVyLmlkLCBnZXRFbnZBcGlLZXlGbiwgaXNFeHRlcm5hbENsaVByb3ZpZGVyRm4pO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgaWQ6IHByb3ZpZGVyLmlkLFxuICAgICAgICBsYWJlbDogb2F1dGhQcm92aWRlcj8ubmFtZSA/PyBwcm92aWRlci5sYWJlbCxcbiAgICAgICAgcmVxdWlyZWQ6IHRydWUsXG4gICAgICAgIHJlY29tbWVuZGVkOiBCb29sZWFuKHByb3ZpZGVyLnJlY29tbWVuZGVkKSxcbiAgICAgICAgY29uZmlndXJlZDogY29uZmlndXJlZFZpYSAhPT0gbnVsbCxcbiAgICAgICAgY29uZmlndXJlZFZpYSxcbiAgICAgICAgc3VwcG9ydHM6IHtcbiAgICAgICAgICBhcGlLZXk6IHByb3ZpZGVyLnN1cHBvcnRzQXBpS2V5LFxuICAgICAgICAgIG9hdXRoOiBwcm92aWRlci5zdXBwb3J0c09BdXRoLFxuICAgICAgICAgIG9hdXRoQXZhaWxhYmxlOiBwcm92aWRlci5zdXBwb3J0c09BdXRoID8gQm9vbGVhbihvYXV0aFByb3ZpZGVyKSA6IGZhbHNlLFxuICAgICAgICAgIHVzZXNDYWxsYmFja1NlcnZlcjogQm9vbGVhbihvYXV0aFByb3ZpZGVyPy51c2VzQ2FsbGJhY2tTZXJ2ZXIpLFxuICAgICAgICAgIGV4dGVybmFsQ2xpOiBCb29sZWFuKHByb3ZpZGVyLnN1cHBvcnRzRXh0ZXJuYWxDbGkpLFxuICAgICAgICB9LFxuICAgICAgfTtcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgYnVpbGRTdGF0ZSgpOiBQcm9taXNlPE9uYm9hcmRpbmdTdGF0ZT4ge1xuICAgIGNvbnN0IGF1dGhTdG9yYWdlID0gYXdhaXQgdGhpcy5nZXRBdXRoU3RvcmFnZSgpO1xuICAgIGNvbnN0IGdldEVudkFwaUtleUZuID0gdGhpcy5kZXBzLmdldEVudkFwaUtleSA/PyBnZXRFbnZBcGlLZXk7XG4gICAgYXV0aFN0b3JhZ2UucmVsb2FkKCk7XG5cbiAgICBjb25zdCBwcm92aWRlcnMgPSB0aGlzLmJ1aWxkUHJvdmlkZXJTdGF0ZShhdXRoU3RvcmFnZSwgZ2V0RW52QXBpS2V5Rm4pO1xuICAgIGNvbnN0IHNhdGlzZmllZEJ5UHJvdmlkZXIgPSBwcm92aWRlcnMuZmluZCgocHJvdmlkZXIpID0+IHByb3ZpZGVyLmNvbmZpZ3VyZWQpID8/IG51bGw7XG4gICAgY29uc3Qgb3B0aW9uYWxTZWN0aW9ucyA9IHRoaXMuYnVpbGRPcHRpb25hbFNlY3Rpb25TdGF0ZShhdXRoU3RvcmFnZSk7XG4gICAgY29uc3QgbG9ja1JlYXNvbiA9IHJlc29sdmVPbmJvYXJkaW5nTG9ja1JlYXNvbihCb29sZWFuKHNhdGlzZmllZEJ5UHJvdmlkZXIpLCB0aGlzLmJyaWRnZUF1dGhSZWZyZXNoKTtcblxuICAgIC8vIFJlYWQgQ0xJLXNpZGUgY29tcGxldGlvbiByZWNvcmQgKGJlc3QtZWZmb3J0IFx1MjAxNCBuZXZlciB0aHJvdylcbiAgICBsZXQgY29tcGxldGlvblJlY29yZDogT25ib2FyZGluZ0NvbXBsZXRpb25SZWNvcmQgfCBudWxsID0gbnVsbDtcbiAgICB0cnkge1xuICAgICAgY29uc3QgeyByZWFkT25ib2FyZGluZ1JlY29yZCwgaXNPbmJvYXJkaW5nQ29tcGxldGUgfSA9IGF3YWl0IGltcG9ydChcbiAgICAgICAgXCIuLi9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2Qvb25ib2FyZGluZy1zdGF0ZS5qc1wiXG4gICAgICApO1xuICAgICAgY29uc3QgciA9IHJlYWRPbmJvYXJkaW5nUmVjb3JkKCk7XG4gICAgICBjb21wbGV0aW9uUmVjb3JkID0ge1xuICAgICAgICBjb21wbGV0ZWRBdDogaXNPbmJvYXJkaW5nQ29tcGxldGUoKSA/IHIuY29tcGxldGVkQXQgOiBudWxsLFxuICAgICAgICBjb21wbGV0ZWRTdGVwczogci5jb21wbGV0ZWRTdGVwcyxcbiAgICAgICAgc2tpcHBlZFN0ZXBzOiByLnNraXBwZWRTdGVwcyxcbiAgICAgICAgbGFzdFJlc3VtZVBvaW50OiByLmxhc3RSZXN1bWVQb2ludCxcbiAgICAgICAgZmxvd1ZlcnNpb246IHIuZmxvd1ZlcnNpb24sXG4gICAgICB9O1xuICAgIH0gY2F0Y2gge1xuICAgICAgY29tcGxldGlvblJlY29yZCA9IG51bGw7XG4gICAgfVxuXG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1czogbG9ja1JlYXNvbiA/IFwiYmxvY2tlZFwiIDogXCJyZWFkeVwiLFxuICAgICAgbG9ja2VkOiBsb2NrUmVhc29uICE9PSBudWxsLFxuICAgICAgbG9ja1JlYXNvbixcbiAgICAgIHJlcXVpcmVkOiB7XG4gICAgICAgIGJsb2NraW5nOiB0cnVlLFxuICAgICAgICBza2lwcGFibGU6IGZhbHNlLFxuICAgICAgICBzYXRpc2ZpZWQ6IEJvb2xlYW4oc2F0aXNmaWVkQnlQcm92aWRlciksXG4gICAgICAgIHNhdGlzZmllZEJ5OiBzYXRpc2ZpZWRCeVByb3ZpZGVyXG4gICAgICAgICAgPyB7XG4gICAgICAgICAgICAgIHByb3ZpZGVySWQ6IHNhdGlzZmllZEJ5UHJvdmlkZXIuaWQsXG4gICAgICAgICAgICAgIHNvdXJjZTogc2F0aXNmaWVkQnlQcm92aWRlci5jb25maWd1cmVkVmlhID8/IFwicnVudGltZVwiLFxuICAgICAgICAgICAgfVxuICAgICAgICAgIDogbnVsbCxcbiAgICAgICAgcHJvdmlkZXJzLFxuICAgICAgfSxcbiAgICAgIG9wdGlvbmFsOiB7XG4gICAgICAgIGJsb2NraW5nOiBmYWxzZSxcbiAgICAgICAgc2tpcHBhYmxlOiB0cnVlLFxuICAgICAgICBzZWN0aW9uczogb3B0aW9uYWxTZWN0aW9ucyxcbiAgICAgIH0sXG4gICAgICBsYXN0VmFsaWRhdGlvbjogdGhpcy5sYXN0VmFsaWRhdGlvbiA/IHsgLi4udGhpcy5sYXN0VmFsaWRhdGlvbiB9IDogbnVsbCxcbiAgICAgIGFjdGl2ZUZsb3c6IHRoaXMuYWN0aXZlRmxvdyA/IHN0cnVjdHVyZWRDbG9uZSh0aGlzLmFjdGl2ZUZsb3cuc3RhdGUpIDogbnVsbCxcbiAgICAgIGJyaWRnZUF1dGhSZWZyZXNoOiB7IC4uLnRoaXMuYnJpZGdlQXV0aFJlZnJlc2ggfSxcbiAgICAgIGNvbXBsZXRpb25SZWNvcmQsXG4gICAgfTtcbiAgfVxuXG4gIHByaXZhdGUgY2FuY2VsQWN0aXZlRmxvdygpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuYWN0aXZlRmxvdykgcmV0dXJuO1xuICAgIHRoaXMuYWN0aXZlRmxvdy5hYm9ydENvbnRyb2xsZXIuYWJvcnQoKTtcbiAgICBpZiAodGhpcy5hY3RpdmVGbG93LmF3YWl0aW5nSW5wdXQpIHtcbiAgICAgIHRoaXMuYWN0aXZlRmxvdy5hd2FpdGluZ0lucHV0KFwiXCIpO1xuICAgICAgdGhpcy5hY3RpdmVGbG93LmF3YWl0aW5nSW5wdXQgPSBudWxsO1xuICAgIH1cbiAgICB0aGlzLmFjdGl2ZUZsb3cuc3RhdGUuc3RhdHVzID0gXCJjYW5jZWxsZWRcIjtcbiAgICB0aGlzLmFjdGl2ZUZsb3cuc3RhdGUucHJvbXB0ID0gbnVsbDtcbiAgICB0aGlzLmFjdGl2ZUZsb3cuc3RhdGUuZXJyb3IgPSBudWxsO1xuICAgIHRoaXMuYWN0aXZlRmxvdy5zdGF0ZS51cGRhdGVkQXQgPSBub3dJc28odGhpcy5kZXBzLm5vdyA/PyAoKCkgPT4gbmV3IERhdGUoKSkpO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBydW5PQXV0aEZsb3coXG4gICAgcnVudGltZTogUHJvdmlkZXJGbG93UnVudGltZSxcbiAgICBwcm92aWRlcjogT0F1dGhQcm92aWRlckludGVyZmFjZSxcbiAgICBhdXRoU3RvcmFnZTogQXV0aFN0b3JhZ2VJbnN0YW5jZSxcbiAgKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IGF1dGhTdG9yYWdlLmxvZ2luKHByb3ZpZGVyLmlkLCB7XG4gICAgICAgIG9uQXV0aDogKGluZm8pID0+IHtcbiAgICAgICAgICBydW50aW1lLnN0YXRlLmF1dGggPSBpbmZvO1xuICAgICAgICAgIHJ1bnRpbWUuc3RhdGUuc3RhdHVzID0gXCJhd2FpdGluZ19icm93c2VyX2F1dGhcIjtcbiAgICAgICAgICBydW50aW1lLnN0YXRlLnVwZGF0ZWRBdCA9IG5vd0lzbyh0aGlzLmRlcHMubm93ID8/ICgoKSA9PiBuZXcgRGF0ZSgpKSk7XG4gICAgICAgIH0sXG4gICAgICAgIG9uUHJvbXB0OiBhc3luYyAocHJvbXB0KSA9PiBhd2FpdCB0aGlzLndhaXRGb3JGbG93SW5wdXQocnVudGltZSwgXCJ0ZXh0XCIsIHByb21wdCksXG4gICAgICAgIG9uUHJvZ3Jlc3M6IChtZXNzYWdlKSA9PiB7XG4gICAgICAgICAgcnVudGltZS5zdGF0ZS5wcm9ncmVzcyA9IFsuLi5ydW50aW1lLnN0YXRlLnByb2dyZXNzLCBzYW5pdGl6ZU1lc3NhZ2UobWVzc2FnZSldLnNsaWNlKC0yMCk7XG4gICAgICAgICAgaWYgKHJ1bnRpbWUuc3RhdGUuc3RhdHVzICE9PSBcImF3YWl0aW5nX2lucHV0XCIpIHtcbiAgICAgICAgICAgIHJ1bnRpbWUuc3RhdGUuc3RhdHVzID0gXCJydW5uaW5nXCI7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJ1bnRpbWUuc3RhdGUudXBkYXRlZEF0ID0gbm93SXNvKHRoaXMuZGVwcy5ub3cgPz8gKCgpID0+IG5ldyBEYXRlKCkpKTtcbiAgICAgICAgfSxcbiAgICAgICAgb25NYW51YWxDb2RlSW5wdXQ6IGFzeW5jICgpID0+XG4gICAgICAgICAgYXdhaXQgdGhpcy53YWl0Rm9yRmxvd0lucHV0KHJ1bnRpbWUsIFwibWFudWFsX2NvZGVcIiwge1xuICAgICAgICAgICAgbWVzc2FnZTogXCJQYXN0ZSB0aGUgcmVkaXJlY3QgVVJMIGZyb20geW91ciBicm93c2VyOlwiLFxuICAgICAgICAgICAgcGxhY2Vob2xkZXI6IFwiaHR0cDovL2xvY2FsaG9zdDouLi5cIixcbiAgICAgICAgICB9KSxcbiAgICAgICAgc2lnbmFsOiBydW50aW1lLmFib3J0Q29udHJvbGxlci5zaWduYWwsXG4gICAgICB9KTtcblxuICAgICAgcnVudGltZS5zdGF0ZS5zdGF0dXMgPSBcInN1Y2NlZWRlZFwiO1xuICAgICAgcnVudGltZS5zdGF0ZS5wcm9tcHQgPSBudWxsO1xuICAgICAgcnVudGltZS5zdGF0ZS5lcnJvciA9IG51bGw7XG4gICAgICBydW50aW1lLnN0YXRlLnVwZGF0ZWRBdCA9IG5vd0lzbyh0aGlzLmRlcHMubm93ID8/ICgoKSA9PiBuZXcgRGF0ZSgpKSk7XG4gICAgICB0aGlzLmxhc3RWYWxpZGF0aW9uID0ge1xuICAgICAgICBzdGF0dXM6IFwic3VjY2VlZGVkXCIsXG4gICAgICAgIHByb3ZpZGVySWQ6IHByb3ZpZGVyLmlkLFxuICAgICAgICBtZXRob2Q6IFwib2F1dGhcIixcbiAgICAgICAgY2hlY2tlZEF0OiBydW50aW1lLnN0YXRlLnVwZGF0ZWRBdCxcbiAgICAgICAgbWVzc2FnZTogYCR7cHJvdmlkZXIuaWR9IHNpZ24taW4gY29tcGxldGVgLFxuICAgICAgICBwZXJzaXN0ZWQ6IHRydWUsXG4gICAgICB9O1xuICAgICAgYXdhaXQgdGhpcy5yZWZyZXNoQnJpZGdlQXV0aCgpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBjb25zdCBjYW5jZWxsZWQgPSBydW50aW1lLmFib3J0Q29udHJvbGxlci5zaWduYWwuYWJvcnRlZDtcbiAgICAgIHJ1bnRpbWUuc3RhdGUuc3RhdHVzID0gY2FuY2VsbGVkID8gXCJjYW5jZWxsZWRcIiA6IFwiZmFpbGVkXCI7XG4gICAgICBydW50aW1lLnN0YXRlLnByb21wdCA9IG51bGw7XG4gICAgICBydW50aW1lLnN0YXRlLmVycm9yID0gY2FuY2VsbGVkID8gbnVsbCA6IHNhbml0aXplTWVzc2FnZShlcnJvcik7XG4gICAgICBydW50aW1lLnN0YXRlLnVwZGF0ZWRBdCA9IG5vd0lzbyh0aGlzLmRlcHMubm93ID8/ICgoKSA9PiBuZXcgRGF0ZSgpKSk7XG4gICAgICBpZiAoIWNhbmNlbGxlZCkge1xuICAgICAgICB0aGlzLmxhc3RWYWxpZGF0aW9uID0ge1xuICAgICAgICAgIHN0YXR1czogXCJmYWlsZWRcIixcbiAgICAgICAgICBwcm92aWRlcklkOiBwcm92aWRlci5pZCxcbiAgICAgICAgICBtZXRob2Q6IFwib2F1dGhcIixcbiAgICAgICAgICBjaGVja2VkQXQ6IHJ1bnRpbWUuc3RhdGUudXBkYXRlZEF0LFxuICAgICAgICAgIG1lc3NhZ2U6IHJ1bnRpbWUuc3RhdGUuZXJyb3IgfHwgYCR7cHJvdmlkZXIuaWR9IHNpZ24taW4gZmFpbGVkYCxcbiAgICAgICAgICBwZXJzaXN0ZWQ6IGZhbHNlLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgd2FpdEZvckZsb3dJbnB1dChcbiAgICBydW50aW1lOiBQcm92aWRlckZsb3dSdW50aW1lLFxuICAgIGtpbmQ6IE9uYm9hcmRpbmdGbG93UHJvbXB0U3RhdGVbXCJraW5kXCJdLFxuICAgIHByb21wdDogT0F1dGhQcm9tcHQsXG4gICk6IFByb21pc2U8c3RyaW5nPiB7XG4gICAgcnVudGltZS5zdGF0ZS5zdGF0dXMgPSBcImF3YWl0aW5nX2lucHV0XCI7XG4gICAgcnVudGltZS5zdGF0ZS5wcm9tcHQgPSB7XG4gICAgICBraW5kLFxuICAgICAgbWVzc2FnZTogcHJvbXB0Lm1lc3NhZ2UsXG4gICAgICBwbGFjZWhvbGRlcjogcHJvbXB0LnBsYWNlaG9sZGVyLFxuICAgICAgYWxsb3dFbXB0eTogcHJvbXB0LmFsbG93RW1wdHksXG4gICAgfTtcbiAgICBydW50aW1lLnN0YXRlLnVwZGF0ZWRBdCA9IG5vd0lzbyh0aGlzLmRlcHMubm93ID8/ICgoKSA9PiBuZXcgRGF0ZSgpKSk7XG5cbiAgICByZXR1cm4gYXdhaXQgbmV3IFByb21pc2U8c3RyaW5nPigocmVzb2x2ZSkgPT4ge1xuICAgICAgcnVudGltZS5hd2FpdGluZ0lucHV0ID0gcmVzb2x2ZTtcbiAgICB9KTtcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0T25ib2FyZGluZ1NlcnZpY2UoKTogT25ib2FyZGluZ1NlcnZpY2Uge1xuICBpZiAoIW9uYm9hcmRpbmdTZXJ2aWNlU2luZ2xldG9uKSB7XG4gICAgb25ib2FyZGluZ1NlcnZpY2VTaW5nbGV0b24gPSBuZXcgT25ib2FyZGluZ1NlcnZpY2UoZ2V0T25ib2FyZGluZ0RlcHMoKSk7XG4gIH1cbiAgcmV0dXJuIG9uYm9hcmRpbmdTZXJ2aWNlU2luZ2xldG9uO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY29sbGVjdE9uYm9hcmRpbmdTdGF0ZSgpOiBQcm9taXNlPE9uYm9hcmRpbmdTdGF0ZT4ge1xuICByZXR1cm4gYXdhaXQgZ2V0T25ib2FyZGluZ1NlcnZpY2UoKS5nZXRTdGF0ZSgpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJPbmJvYXJkaW5nQnJpZGdlQXV0aFJlZnJlc2hlcihyZWZyZXNoZXI6IEJyaWRnZUF1dGhSZWZyZXNoZXIgfCBudWxsKTogdm9pZCB7XG4gIG9uYm9hcmRpbmdCcmlkZ2VBdXRoUmVmcmVzaGVyID0gcmVmcmVzaGVyO1xuICBvbmJvYXJkaW5nU2VydmljZVNpbmdsZXRvbiA9IG51bGw7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjb25maWd1cmVPbmJvYXJkaW5nU2VydmljZUZvclRlc3RzKG92ZXJyaWRlczogUGFydGlhbDxPbmJvYXJkaW5nU2VydmljZURlcHM+IHwgbnVsbCk6IHZvaWQge1xuICBvbmJvYXJkaW5nU2VydmljZU92ZXJyaWRlcyA9IG92ZXJyaWRlcztcbiAgb25ib2FyZGluZ1NlcnZpY2VTaW5nbGV0b24gPSBudWxsO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVzZXRPbmJvYXJkaW5nU2VydmljZUZvclRlc3RzKCk6IHZvaWQge1xuICBvbmJvYXJkaW5nU2VydmljZU92ZXJyaWRlcyA9IG51bGw7XG4gIG9uYm9hcmRpbmdTZXJ2aWNlU2luZ2xldG9uID0gbnVsbDtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsa0JBQWtCO0FBRTNCLFNBQVMsb0JBQW9CO0FBRTdCLFNBQVMsb0JBQW9CO0FBQzdCLFNBQVMsbUNBQXNGO0FBd0IvRixJQUFJLGdDQUE0RDtBQWtKaEUsTUFBTSw0QkFBNEQ7QUFBQSxFQUNoRSxFQUFFLElBQUksYUFBYSxPQUFPLHNCQUFzQixnQkFBZ0IsTUFBTSxlQUFlLE9BQU8sYUFBYSxLQUFLO0FBQUEsRUFDOUcsRUFBRSxJ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
