import { existsSync } from "node:fs";
import { join } from "node:path";
function isClaudeCodeBinaryInPath() {
  const pathDirs = (process.env.PATH ?? "").split(":");
  return pathDirs.some((dir) => dir && existsSync(join(dir, "claude")));
}
class CredentialCooldownError extends Error {
  constructor(provider, retryAfterMs) {
    super(
      `All credentials for "${provider}" are in a cooldown window. Please wait a moment and try again, or switch to a different provider.`
    );
    this.code = "AUTH_COOLDOWN";
    this.name = "CredentialCooldownError";
    this.retryAfterMs = retryAfterMs;
  }
}
function canRestoreSessionModel(modelRegistry, model) {
  return modelRegistry.isProviderRequestReady(model.provider);
}
const PROVIDER_TOOL_LIMITS = {
  groq: 128
};
function resolveProviderToolLimit(providerCaps, provider) {
  if (provider && PROVIDER_TOOL_LIMITS[provider]) {
    return PROVIDER_TOOL_LIMITS[provider];
  }
  return providerCaps.maxTools > 0 ? providerCaps.maxTools : 0;
}
function filterToolsForProviderRequest(tools, model) {
  const providerCaps = getProviderCapabilities(model.api);
  if (!providerCaps.toolCalling) {
    return { compatible: [], filtered: tools };
  }
  const compatible = [];
  const filtered = [];
  for (const tool of tools) {
    const compat = getToolCompatibility(tool.name);
    if (compat?.producesImages && !providerCaps.imageToolResults || compat?.schemaFeatures?.some((feature) => providerCaps.unsupportedSchemaFeatures.includes(feature))) {
      filtered.push(tool);
    } else {
      compatible.push(tool);
    }
  }
  const toolLimit = resolveProviderToolLimit(providerCaps, model.provider);
  if (toolLimit > 0 && compatible.length > toolLimit) {
    filtered.push(...compatible.splice(toolLimit));
  }
  return { compatible, filtered };
}
import { Agent, maybeLogProviderPayloadAudit } from "@gsd/pi-agent-core";
import { getProviderCapabilities } from "@gsd/pi-ai";
import { getAgentDir, getDocsPath } from "../config.js";
import { AgentSession } from "./agent-session.js";
import { AuthStorage } from "./auth-storage.js";
import { DEFAULT_THINKING_LEVEL } from "./defaults.js";
import { convertToLlm } from "./messages.js";
import { ModelRegistry } from "./model-registry.js";
import { findInitialModel } from "./model-resolver.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
import { time } from "./timings.js";
import {
  allTools,
  bashTool,
  codingTools,
  createBashTool,
  createCodingTools,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadOnlyTools,
  createReadTool,
  createWriteTool,
  editTool,
  findTool,
  grepTool,
  hashlineCodingTools,
  hashlineEditTool,
  hashlineReadTool,
  createHashlineCodingTools,
  createHashlineEditTool,
  createHashlineReadTool,
  lsTool,
  readOnlyTools,
  readTool,
  writeTool
} from "./tools/index.js";
import { getToolCompatibility } from "./tools/tool-compatibility-registry.js";
function getAdjustToolSetRequestCustomMessages(messages) {
  if (!messages) return [];
  const requestMessages = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "assistant") break;
    if (message?.role === "custom" && typeof message.customType === "string") {
      requestMessages.push({ index, customType: message.customType });
    }
  }
  return requestMessages.reverse();
}
function getDefaultAgentDir() {
  return getAgentDir();
}
async function createAgentSession(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const agentDir = options.agentDir ?? getDefaultAgentDir();
  let resourceLoader = options.resourceLoader;
  const authPath = options.agentDir ? join(agentDir, "auth.json") : void 0;
  const modelsPath = options.agentDir ? join(agentDir, "models.json") : void 0;
  const authStorage = options.authStorage ?? AuthStorage.create(authPath);
  const modelRegistry = options.modelRegistry ?? new ModelRegistry(authStorage, modelsPath);
  const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
  const sessionManager = options.sessionManager ?? SessionManager.create(cwd);
  if (!resourceLoader) {
    resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
    await resourceLoader.reload();
    time("resourceLoader.reload");
  }
  const { runtime: extensionRuntime } = resourceLoader.getExtensions();
  for (const { name, config } of extensionRuntime.pendingProviderRegistrations) {
    modelRegistry.registerProvider(name, config);
  }
  extensionRuntime.pendingProviderRegistrations = [];
  const existingSession = sessionManager.buildSessionContext();
  const hasExistingSession = existingSession.messages.length > 0;
  const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");
  let model = options.model;
  let modelFallbackMessage;
  if (!model && hasExistingSession && existingSession.model) {
    const restoredModel = modelRegistry.find(existingSession.model.provider, existingSession.model.modelId);
    if (restoredModel && canRestoreSessionModel(modelRegistry, restoredModel)) {
      model = restoredModel;
    }
    if (!model) {
      modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
    }
  }
  const extensionsForModelResolution = resourceLoader.getExtensions();
  for (const { name, config } of extensionsForModelResolution.runtime.pendingProviderRegistrations) {
    modelRegistry.registerProvider(name, config);
  }
  extensionsForModelResolution.runtime.pendingProviderRegistrations = [];
  if (!model) {
    const result = await findInitialModel({
      scopedModels: [],
      isContinuing: hasExistingSession,
      defaultProvider: settingsManager.getDefaultProvider(),
      defaultModelId: settingsManager.getDefaultModel(),
      defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
      modelRegistry
    });
    model = result.model;
    if (!model) {
      modelFallbackMessage = `No models available. Use /login or set an API key environment variable. See ${join(getDocsPath(), "providers.md")}. Then use /model to select a model.`;
    } else if (modelFallbackMessage) {
      modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
    }
  }
  let thinkingLevel = options.thinkingLevel;
  if (thinkingLevel === void 0 && hasExistingSession) {
    thinkingLevel = hasThinkingEntry ? existingSession.thinkingLevel : settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
  }
  if (thinkingLevel === void 0) {
    thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
  }
  if (!model || !model.reasoning) {
    thinkingLevel = "off";
  }
  const editMode = settingsManager.getEditMode();
  const defaultActiveToolNames = editMode === "hashline" ? ["hashline_read", "bash", "hashline_edit", "write", "lsp"] : ["read", "bash", "edit", "write", "lsp"];
  const builtinActiveToolNames = options.tools ? options.tools.map((t) => t.name).filter((n) => n in allTools) : defaultActiveToolNames;
  const initialActiveToolNames = options.extraActiveToolNames ? [...builtinActiveToolNames, ...options.extraActiveToolNames] : builtinActiveToolNames;
  let agent;
  const convertToLlmWithBlockImages = (messages) => {
    const converted = convertToLlm(messages);
    if (!settingsManager.getBlockImages()) {
      return converted;
    }
    return converted.map((msg) => {
      if (msg.role === "user" || msg.role === "toolResult") {
        const content = msg.content;
        if (Array.isArray(content)) {
          const hasImages = content.some((c) => c.type === "image");
          if (hasImages) {
            const filteredContent = content.map(
              (c) => c.type === "image" ? { type: "text", text: "Image reading is disabled." } : c
            ).filter(
              (c, i, arr) => (
                // Dedupe consecutive "Image reading is disabled." texts
                !(c.type === "text" && c.text === "Image reading is disabled." && i > 0 && arr[i - 1].type === "text" && arr[i - 1].text === "Image reading is disabled.")
              )
            );
            return { ...msg, content: filteredContent };
          }
        }
      }
      return msg;
    });
  };
  const extensionRunnerRef = {};
  const workspaceRootRef = { current: cwd };
  agent = new Agent({
    initialState: {
      systemPrompt: "",
      model,
      thinkingLevel,
      tools: []
    },
    convertToLlm: convertToLlmWithBlockImages,
    onPayload: async (payload, currentModel) => {
      const runner = extensionRunnerRef.current;
      if (!runner?.hasHandlers("before_provider_request")) {
        maybeLogProviderPayloadAudit(payload, "before_provider_request:unchanged");
        return payload;
      }
      const nextPayload = await runner.emitBeforeProviderRequest(payload, currentModel);
      maybeLogProviderPayloadAudit(nextPayload, "before_provider_request:after");
      return nextPayload;
    },
    sessionId: sessionManager.getSessionId(),
    transformContext: async (messages) => {
      const runner = extensionRunnerRef.current;
      if (!runner) return messages;
      return runner.emitContext(messages);
    },
    filterTools: async (tools, _signal, messages) => {
      const currentModel = agent.state.activeInferenceModel ?? agent.state.model ?? model;
      if (!currentModel) return tools;
      const providerFiltered = filterToolsForProviderRequest(tools, currentModel);
      const runner = extensionRunnerRef.current;
      if (!runner?.hasHandlers("adjust_tool_set")) return providerFiltered.compatible;
      const result = await runner.emitAdjustToolSet({
        selectedModelApi: currentModel.api,
        selectedModelProvider: currentModel.provider,
        selectedModelId: currentModel.id,
        activeToolNames: providerFiltered.compatible.map((tool) => tool.name),
        filteredTools: providerFiltered.filtered.map((tool) => tool.name),
        requestCustomMessages: getAdjustToolSetRequestCustomMessages(messages)
      });
      if (!result?.toolNames) return providerFiltered.compatible;
      const allowedNames = new Set(result.toolNames);
      return providerFiltered.compatible.filter((tool) => allowedNames.has(tool.name));
    },
    steeringMode: settingsManager.getSteeringMode(),
    followUpMode: settingsManager.getFollowUpMode(),
    transport: settingsManager.getTransport(),
    thinkingBudgets: settingsManager.getThinkingBudgets(),
    maxRetryDelayMs: settingsManager.getRetrySettings().maxDelayMs,
    externalToolExecution: (m) => modelRegistry.getProviderAuthMode(m.provider) === "externalCli",
    getProviderOptions: async (currentModel) => {
      if (currentModel.provider !== "claude-code") return void 0;
      const runner = extensionRunnerRef.current;
      if (!runner?.hasUI()) {
        return { cwd: workspaceRootRef.current };
      }
      return {
        cwd: workspaceRootRef.current,
        extensionUIContext: runner.getUIContext()
      };
    },
    getApiKey: async (provider) => {
      const resolvedProvider = provider || agent.state.model?.provider;
      if (!resolvedProvider) {
        throw new Error("No model selected");
      }
      const authMode = modelRegistry.getProviderAuthMode(resolvedProvider);
      if (authMode === "externalCli" || authMode === "none") {
        return void 0;
      }
      const maxAttempts = 3;
      const baseDelayMs = 2e3;
      const maxCooldownWaitMs = 6e4;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const key = await modelRegistry.getApiKeyForProvider(resolvedProvider);
        if (key) return key;
        if (attempt >= maxAttempts) break;
        const hasAuth2 = modelRegistry.authStorage.hasAuth(resolvedProvider);
        const model3 = agent.state.model;
        const isOAuth2 = model3 && modelRegistry.isUsingOAuth(model3);
        if (!hasAuth2 && !isOAuth2) break;
        const backoffExpiry = modelRegistry.authStorage.getEarliestBackoffExpiry(resolvedProvider);
        if (backoffExpiry !== void 0) {
          const waitMs = backoffExpiry - Date.now() + 500;
          if (waitMs > 0 && waitMs <= maxCooldownWaitMs) {
            await new Promise((resolve) => setTimeout(resolve, waitMs));
            continue;
          }
          if (waitMs > maxCooldownWaitMs) {
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt));
      }
      const hasAuth = modelRegistry.authStorage.hasAuth(resolvedProvider);
      if (hasAuth) {
        if (resolvedProvider === "anthropic" && modelRegistry.authStorage.hasLegacyOAuthCredential(resolvedProvider)) {
          const removed = modelRegistry.authStorage.removeLegacyOAuthCredential(resolvedProvider);
          if (removed) {
            console.warn(
              `[auth] Removed unsupported Anthropic OAuth credential from auth.json (#3952).`
            );
          }
          if (isClaudeCodeBinaryInPath()) {
            throw new Error(
              `Removed stale Anthropic OAuth credential (OAuth support removed in v2.74.0). Your current model's provider is set to "anthropic" but the local Claude Code CLI is available \u2014 switch the model's provider to "claude-code" in your preferences to use it, or set ANTHROPIC_API_KEY to continue with the Anthropic API directly.`
            );
          }
          throw new Error(
            `Removed stale Anthropic OAuth credential (OAuth support removed in v2.74.0). Set ANTHROPIC_API_KEY, run '/login' and paste an API key, or switch to a different provider.`
          );
        }
        const expiry = modelRegistry.authStorage.getEarliestBackoffExpiry(resolvedProvider);
        const retryAfterMs = expiry !== void 0 ? Math.max(0, expiry - Date.now()) : void 0;
        throw new CredentialCooldownError(resolvedProvider, retryAfterMs);
      }
      const model2 = agent.state.model;
      const isOAuth = model2 && modelRegistry.isUsingOAuth(model2);
      if (isOAuth) {
        if (modelRegistry.authStorage.areAllCredentialsBackedOff(resolvedProvider)) {
          const expiry = modelRegistry.authStorage.getEarliestBackoffExpiry(resolvedProvider);
          const retryAfterMs = expiry !== void 0 ? Math.max(0, expiry - Date.now()) : void 0;
          throw new CredentialCooldownError(resolvedProvider, retryAfterMs);
        }
        throw new Error(
          `Authentication failed for "${resolvedProvider}". Credentials may have expired or network is unavailable. Run '/login ${resolvedProvider}' to re-authenticate.`
        );
      }
      throw new Error(
        `No API key found for "${resolvedProvider}". Set an API key environment variable or run '/login ${resolvedProvider}'.`
      );
    }
  });
  if (hasExistingSession) {
    agent.replaceMessages(existingSession.messages);
    if (!hasThinkingEntry) {
      sessionManager.appendThinkingLevelChange(thinkingLevel);
    }
  } else {
    if (model) {
      sessionManager.appendModelChange(model.provider, model.id);
    }
    sessionManager.appendThinkingLevelChange(thinkingLevel);
  }
  const session = new AgentSession({
    agent,
    sessionManager,
    settingsManager,
    cwd,
    scopedModels: options.scopedModels,
    resourceLoader,
    customTools: options.customTools,
    modelRegistry,
    initialActiveToolNames,
    extensionRunnerRef,
    workspaceRootRef,
    isClaudeCodeReady: options.isClaudeCodeReady
  });
  const extensionsResult = resourceLoader.getExtensions();
  return {
    session,
    extensionsResult,
    modelFallbackMessage
  };
}
export {
  CredentialCooldownError,
  allTools as allBuiltInTools,
  bashTool,
  canRestoreSessionModel,
  codingTools,
  createAgentSession,
  createBashTool,
  createCodingTools,
  createEditTool,
  createFindTool,
  createGrepTool,
  createHashlineCodingTools,
  createHashlineEditTool,
  createHashlineReadTool,
  createLsTool,
  createReadOnlyTools,
  createReadTool,
  createWriteTool,
  editTool,
  filterToolsForProviderRequest,
  findTool,
  getAdjustToolSetRequestCustomMessages,
  grepTool,
  hashlineCodingTools,
  hashlineEditTool,
  hashlineReadTool,
  lsTool,
  readOnlyTools,
  readTool,
  writeTool
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL3Nkay50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NEMiAtIENvZGluZyBhZ2VudCBzZXNzaW9uIGZhY3RvcnkgYW5kIHJ1bnRpbWUgd2lyaW5nXG5pbXBvcnQgeyBleGlzdHNTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbi8qKlxuICogTGlnaHR3ZWlnaHQgUEFUSCBzY2FuIGZvciB0aGUgYGNsYXVkZWAgYmluYXJ5IFx1MjAxNCBubyBzdWJwcm9jZXNzLCBubyBuZXR3b3JrLlxuICogTWlycm9ycyB0aGUgY2hlY2sgaW4gc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9kb2N0b3ItcHJvdmlkZXJzLnRzIHNvIHRoZVxuICogbGVnYWN5IEFudGhyb3BpYyBPQXV0aCBzZWxmLWhlYWwgcGF0aCBjYW4gb25seSB0cmlnZ2VyIHdoZW4gdGhlIHVzZXIgaGFzIGFcbiAqIHdvcmtpbmcgQ2xhdWRlIENvZGUgQ0xJIHRvIGZhbGwgYmFjayB0by5cbiAqL1xuZnVuY3Rpb24gaXNDbGF1ZGVDb2RlQmluYXJ5SW5QYXRoKCk6IGJvb2xlYW4ge1xuXHRjb25zdCBwYXRoRGlycyA9IChwcm9jZXNzLmVudi5QQVRIID8/IFwiXCIpLnNwbGl0KFwiOlwiKTtcblx0cmV0dXJuIHBhdGhEaXJzLnNvbWUoKGRpcikgPT4gZGlyICYmIGV4aXN0c1N5bmMoam9pbihkaXIsIFwiY2xhdWRlXCIpKSk7XG59XG5cbi8qKlxuICogU3RydWN0dXJlZCBlcnJvciB0aHJvd24gd2hlbiBhbGwgY3JlZGVudGlhbHMgZm9yIGEgcHJvdmlkZXIgYXJlIGluIGFcbiAqIGJhY2tvZmYgd2luZG93LiAgQ2FycmllcyB0eXBlZCBtZXRhZGF0YSBzbyBjYWxsZXJzIChlLmcuIHRoZSBhdXRvLWxvb3ApXG4gKiBjYW4gbWFrZSBpbmZvcm1lZCByZXRyeSBkZWNpc2lvbnMgaW5zdGVhZCBvZiBzdHJpbmctbWF0Y2hpbmcgdGhlIG1lc3NhZ2UuXG4gKi9cbmV4cG9ydCBjbGFzcyBDcmVkZW50aWFsQ29vbGRvd25FcnJvciBleHRlbmRzIEVycm9yIHtcblx0cmVhZG9ubHkgY29kZSA9IFwiQVVUSF9DT09MRE9XTlwiIGFzIGNvbnN0O1xuXHQvKiogTWlsbGlzZWNvbmRzIHVudGlsIHRoZSBlYXJsaWVzdCBjcmVkZW50aWFsIGJlY29tZXMgYXZhaWxhYmxlLCBvciB1bmRlZmluZWQgaWYgdW5rbm93bi4gKi9cblx0cmVhZG9ubHkgcmV0cnlBZnRlck1zOiBudW1iZXIgfCB1bmRlZmluZWQ7XG5cblx0Y29uc3RydWN0b3IocHJvdmlkZXI6IHN0cmluZywgcmV0cnlBZnRlck1zPzogbnVtYmVyKSB7XG5cdFx0c3VwZXIoXG5cdFx0XHRgQWxsIGNyZWRlbnRpYWxzIGZvciBcIiR7cHJvdmlkZXJ9XCIgYXJlIGluIGEgY29vbGRvd24gd2luZG93LiBgICtcblx0XHRcdFx0YFBsZWFzZSB3YWl0IGEgbW9tZW50IGFuZCB0cnkgYWdhaW4sIG9yIHN3aXRjaCB0byBhIGRpZmZlcmVudCBwcm92aWRlci5gLFxuXHRcdCk7XG5cdFx0dGhpcy5uYW1lID0gXCJDcmVkZW50aWFsQ29vbGRvd25FcnJvclwiO1xuXHRcdHRoaXMucmV0cnlBZnRlck1zID0gcmV0cnlBZnRlck1zO1xuXHR9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjYW5SZXN0b3JlU2Vzc2lvbk1vZGVsKFxuXHRtb2RlbFJlZ2lzdHJ5OiBQaWNrPE1vZGVsUmVnaXN0cnksIFwiaXNQcm92aWRlclJlcXVlc3RSZWFkeVwiPixcblx0bW9kZWw6IE1vZGVsPGFueT4sXG4pOiBib29sZWFuIHtcblx0cmV0dXJuIG1vZGVsUmVnaXN0cnkuaXNQcm92aWRlclJlcXVlc3RSZWFkeShtb2RlbC5wcm92aWRlcik7XG59XG5cbmNvbnN0IFBST1ZJREVSX1RPT0xfTElNSVRTOiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+ID0ge1xuXHRncm9xOiAxMjgsXG59O1xuXG5mdW5jdGlvbiByZXNvbHZlUHJvdmlkZXJUb29sTGltaXQoXG5cdHByb3ZpZGVyQ2FwczogUmV0dXJuVHlwZTx0eXBlb2YgZ2V0UHJvdmlkZXJDYXBhYmlsaXRpZXM+LFxuXHRwcm92aWRlcjogc3RyaW5nIHwgdW5kZWZpbmVkLFxuKTogbnVtYmVyIHtcblx0aWYgKHByb3ZpZGVyICYmIFBST1ZJREVSX1RPT0xfTElNSVRTW3Byb3ZpZGVyXSkge1xuXHRcdHJldHVybiBQUk9WSURFUl9UT09MX0xJTUlUU1twcm92aWRlcl07XG5cdH1cblx0cmV0dXJuIHByb3ZpZGVyQ2Fwcy5tYXhUb29scyA+IDAgPyBwcm92aWRlckNhcHMubWF4VG9vbHMgOiAwO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZmlsdGVyVG9vbHNGb3JQcm92aWRlclJlcXVlc3QoXG5cdHRvb2xzOiBBZ2VudFRvb2xbXSxcblx0bW9kZWw6IFBpY2s8TW9kZWw8YW55PiwgXCJhcGlcIiB8IFwicHJvdmlkZXJcIj4sXG4pOiB7IGNvbXBhdGlibGU6IEFnZW50VG9vbFtdOyBmaWx0ZXJlZDogQWdlbnRUb29sW10gfSB7XG5cdGNvbnN0IHByb3ZpZGVyQ2FwcyA9IGdldFByb3ZpZGVyQ2FwYWJpbGl0aWVzKG1vZGVsLmFwaSk7XG5cdGlmICghcHJvdmlkZXJDYXBzLnRvb2xDYWxsaW5nKSB7XG5cdFx0cmV0dXJuIHsgY29tcGF0aWJsZTogW10sIGZpbHRlcmVkOiB0b29scyB9O1xuXHR9XG5cblx0Y29uc3QgY29tcGF0aWJsZTogQWdlbnRUb29sW10gPSBbXTtcblx0Y29uc3QgZmlsdGVyZWQ6IEFnZW50VG9vbFtdID0gW107XG5cdGZvciAoY29uc3QgdG9vbCBvZiB0b29scykge1xuXHRcdGNvbnN0IGNvbXBhdCA9IGdldFRvb2xDb21wYXRpYmlsaXR5KHRvb2wubmFtZSk7XG5cdFx0aWYgKFxuXHRcdFx0KGNvbXBhdD8ucHJvZHVjZXNJbWFnZXMgJiYgIXByb3ZpZGVyQ2Fwcy5pbWFnZVRvb2xSZXN1bHRzKSB8fFxuXHRcdFx0Y29tcGF0Py5zY2hlbWFGZWF0dXJlcz8uc29tZSgoZmVhdHVyZSkgPT4gcHJvdmlkZXJDYXBzLnVuc3VwcG9ydGVkU2NoZW1hRmVhdHVyZXMuaW5jbHVkZXMoZmVhdHVyZSkpXG5cdFx0KSB7XG5cdFx0XHRmaWx0ZXJlZC5wdXNoKHRvb2wpO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHRjb21wYXRpYmxlLnB1c2godG9vbCk7XG5cdFx0fVxuXHR9XG5cblx0Y29uc3QgdG9vbExpbWl0ID0gcmVzb2x2ZVByb3ZpZGVyVG9vbExpbWl0KHByb3ZpZGVyQ2FwcywgbW9kZWwucHJvdmlkZXIpO1xuXHRpZiAodG9vbExpbWl0ID4gMCAmJiBjb21wYXRpYmxlLmxlbmd0aCA+IHRvb2xMaW1pdCkge1xuXHRcdGZpbHRlcmVkLnB1c2goLi4uY29tcGF0aWJsZS5zcGxpY2UodG9vbExpbWl0KSk7XG5cdH1cblxuXHRyZXR1cm4geyBjb21wYXRpYmxlLCBmaWx0ZXJlZCB9O1xufVxuaW1wb3J0IHsgQWdlbnQsIG1heWJlTG9nUHJvdmlkZXJQYXlsb2FkQXVkaXQsIHR5cGUgQWdlbnRNZXNzYWdlLCB0eXBlIEFnZW50VG9vbCwgdHlwZSBUaGlua2luZ0xldmVsIH0gZnJvbSBcIkBnc2QvcGktYWdlbnQtY29yZVwiO1xuaW1wb3J0IHsgZ2V0UHJvdmlkZXJDYXBhYmlsaXRpZXMsIHR5cGUgTWVzc2FnZSwgdHlwZSBNb2RlbCB9IGZyb20gXCJAZ3NkL3BpLWFpXCI7XG5pbXBvcnQgeyBnZXRBZ2VudERpciwgZ2V0RG9jc1BhdGggfSBmcm9tIFwiLi4vY29uZmlnLmpzXCI7XG5pbXBvcnQgeyBBZ2VudFNlc3Npb24gfSBmcm9tIFwiLi9hZ2VudC1zZXNzaW9uLmpzXCI7XG5pbXBvcnQgeyBBdXRoU3RvcmFnZSB9IGZyb20gXCIuL2F1dGgtc3RvcmFnZS5qc1wiO1xuaW1wb3J0IHsgREVGQVVMVF9USElOS0lOR19MRVZFTCB9IGZyb20gXCIuL2RlZmF1bHRzLmpzXCI7XG5pbXBvcnQgdHlwZSB7IEV4dGVuc2lvblJ1bm5lciwgTG9hZEV4dGVuc2lvbnNSZXN1bHQsIFRvb2xEZWZpbml0aW9uIH0gZnJvbSBcIi4vZXh0ZW5zaW9ucy9pbmRleC5qc1wiO1xuaW1wb3J0IHsgY29udmVydFRvTGxtIH0gZnJvbSBcIi4vbWVzc2FnZXMuanNcIjtcbmltcG9ydCB7IE1vZGVsUmVnaXN0cnkgfSBmcm9tIFwiLi9tb2RlbC1yZWdpc3RyeS5qc1wiO1xuaW1wb3J0IHsgZmluZEluaXRpYWxNb2RlbCB9IGZyb20gXCIuL21vZGVsLXJlc29sdmVyLmpzXCI7XG5pbXBvcnQgdHlwZSB7IFJlc291cmNlTG9hZGVyIH0gZnJvbSBcIi4vcmVzb3VyY2UtbG9hZGVyLmpzXCI7XG5pbXBvcnQgeyBEZWZhdWx0UmVzb3VyY2VMb2FkZXIgfSBmcm9tIFwiLi9yZXNvdXJjZS1sb2FkZXIuanNcIjtcbmltcG9ydCB7IFNlc3Npb25NYW5hZ2VyIH0gZnJvbSBcIi4vc2Vzc2lvbi1tYW5hZ2VyLmpzXCI7XG5pbXBvcnQgeyBTZXR0aW5nc01hbmFnZXIgfSBmcm9tIFwiLi9zZXR0aW5ncy1tYW5hZ2VyLmpzXCI7XG5pbXBvcnQgeyB0aW1lIH0gZnJvbSBcIi4vdGltaW5ncy5qc1wiO1xuaW1wb3J0IHtcblx0YWxsVG9vbHMsXG5cdGJhc2hUb29sLFxuXHRjb2RpbmdUb29scyxcblx0Y3JlYXRlQmFzaFRvb2wsXG5cdGNyZWF0ZUNvZGluZ1Rvb2xzLFxuXHRjcmVhdGVFZGl0VG9vbCxcblx0Y3JlYXRlRmluZFRvb2wsXG5cdGNyZWF0ZUdyZXBUb29sLFxuXHRjcmVhdGVMc1Rvb2wsXG5cdGNyZWF0ZVJlYWRPbmx5VG9vbHMsXG5cdGNyZWF0ZVJlYWRUb29sLFxuXHRjcmVhdGVXcml0ZVRvb2wsXG5cdGVkaXRUb29sLFxuXHRmaW5kVG9vbCxcblx0Z3JlcFRvb2wsXG5cdGhhc2hsaW5lQ29kaW5nVG9vbHMsXG5cdGhhc2hsaW5lRWRpdFRvb2wsXG5cdGhhc2hsaW5lUmVhZFRvb2wsXG5cdGNyZWF0ZUhhc2hsaW5lQ29kaW5nVG9vbHMsXG5cdGNyZWF0ZUhhc2hsaW5lRWRpdFRvb2wsXG5cdGNyZWF0ZUhhc2hsaW5lUmVhZFRvb2wsXG5cdGxzVG9vbCxcblx0cmVhZE9ubHlUb29scyxcblx0cmVhZFRvb2wsXG5cdHR5cGUgVG9vbCxcblx0dHlwZSBUb29sTmFtZSxcblx0d3JpdGVUb29sLFxufSBmcm9tIFwiLi90b29scy9pbmRleC5qc1wiO1xuaW1wb3J0IHsgZ2V0VG9vbENvbXBhdGliaWxpdHkgfSBmcm9tIFwiLi90b29scy90b29sLWNvbXBhdGliaWxpdHktcmVnaXN0cnkuanNcIjtcblxuZXhwb3J0IGZ1bmN0aW9uIGdldEFkanVzdFRvb2xTZXRSZXF1ZXN0Q3VzdG9tTWVzc2FnZXMoXG5cdG1lc3NhZ2VzOiByZWFkb25seSBBZ2VudE1lc3NhZ2VbXSB8IHVuZGVmaW5lZCxcbik6IEFycmF5PHsgaW5kZXg6IG51bWJlcjsgY3VzdG9tVHlwZTogc3RyaW5nIH0+IHtcblx0aWYgKCFtZXNzYWdlcykgcmV0dXJuIFtdO1xuXHRjb25zdCByZXF1ZXN0TWVzc2FnZXM6IEFycmF5PHsgaW5kZXg6IG51bWJlcjsgY3VzdG9tVHlwZTogc3RyaW5nIH0+ID0gW107XG5cdGZvciAobGV0IGluZGV4ID0gbWVzc2FnZXMubGVuZ3RoIC0gMTsgaW5kZXggPj0gMDsgaW5kZXgtLSkge1xuXHRcdGNvbnN0IG1lc3NhZ2UgPSBtZXNzYWdlc1tpbmRleF0gYXMgeyByb2xlPzogdW5rbm93bjsgY3VzdG9tVHlwZT86IHVua25vd24gfTtcblx0XHRpZiAobWVzc2FnZT8ucm9sZSA9PT0gXCJhc3Npc3RhbnRcIikgYnJlYWs7XG5cdFx0aWYgKG1lc3NhZ2U/LnJvbGUgPT09IFwiY3VzdG9tXCIgJiYgdHlwZW9mIG1lc3NhZ2UuY3VzdG9tVHlwZSA9PT0gXCJzdHJpbmdcIikge1xuXHRcdFx0cmVxdWVzdE1lc3NhZ2VzLnB1c2goeyBpbmRleCwgY3VzdG9tVHlwZTogbWVzc2FnZS5jdXN0b21UeXBlIH0pO1xuXHRcdH1cblx0fVxuXHRyZXR1cm4gcmVxdWVzdE1lc3NhZ2VzLnJldmVyc2UoKTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDcmVhdGVBZ2VudFNlc3Npb25PcHRpb25zIHtcblx0LyoqIFdvcmtpbmcgZGlyZWN0b3J5IGZvciBwcm9qZWN0LWxvY2FsIGRpc2NvdmVyeS4gRGVmYXVsdDogcHJvY2Vzcy5jd2QoKSAqL1xuXHRjd2Q/OiBzdHJpbmc7XG5cdC8qKiBHbG9iYWwgY29uZmlnIGRpcmVjdG9yeS4gRGVmYXVsdDogfi8ucGkvYWdlbnQgKi9cblx0YWdlbnREaXI/OiBzdHJpbmc7XG5cblx0LyoqIEF1dGggc3RvcmFnZSBmb3IgY3JlZGVudGlhbHMuIERlZmF1bHQ6IEF1dGhTdG9yYWdlLmNyZWF0ZShhZ2VudERpci9hdXRoLmpzb24pICovXG5cdGF1dGhTdG9yYWdlPzogQXV0aFN0b3JhZ2U7XG5cdC8qKiBNb2RlbCByZWdpc3RyeS4gRGVmYXVsdDogbmV3IE1vZGVsUmVnaXN0cnkoYXV0aFN0b3JhZ2UsIGFnZW50RGlyL21vZGVscy5qc29uKSAqL1xuXHRtb2RlbFJlZ2lzdHJ5PzogTW9kZWxSZWdpc3RyeTtcblxuXHQvKiogTW9kZWwgdG8gdXNlLiBEZWZhdWx0OiBmcm9tIHNldHRpbmdzLCBlbHNlIGZpcnN0IGF2YWlsYWJsZSAqL1xuXHRtb2RlbD86IE1vZGVsPGFueT47XG5cdC8qKiBUaGlua2luZyBsZXZlbC4gRGVmYXVsdDogZnJvbSBzZXR0aW5ncywgZWxzZSAnbWVkaXVtJyAoY2xhbXBlZCB0byBtb2RlbCBjYXBhYmlsaXRpZXMpICovXG5cdHRoaW5raW5nTGV2ZWw/OiBUaGlua2luZ0xldmVsO1xuXHQvKiogTW9kZWxzIGF2YWlsYWJsZSBmb3IgY3ljbGluZyAoQ3RybCtQIGluIGludGVyYWN0aXZlIG1vZGUpICovXG5cdHNjb3BlZE1vZGVscz86IEFycmF5PHsgbW9kZWw6IE1vZGVsPGFueT47IHRoaW5raW5nTGV2ZWw/OiBUaGlua2luZ0xldmVsIH0+O1xuXG5cdC8qKiBCdWlsdC1pbiB0b29scyB0byB1c2UuIERlZmF1bHQ6IGNvZGluZ1Rvb2xzIFtyZWFkLCBiYXNoLCBlZGl0LCB3cml0ZV0gKi9cblx0dG9vbHM/OiBUb29sW107XG5cdC8qKiBDdXN0b20gdG9vbHMgdG8gcmVnaXN0ZXIgKGluIGFkZGl0aW9uIHRvIGJ1aWx0LWluIHRvb2xzKS4gKi9cblx0Y3VzdG9tVG9vbHM/OiBUb29sRGVmaW5pdGlvbltdO1xuXHQvKipcblx0ICogQWRkaXRpb25hbCB0b29sIG5hbWVzIHRvIGFjdGl2YXRlIGFmdGVyIGV4dGVuc2lvbnMvTUNQIHNlcnZlcnMgcmVnaXN0ZXIuXG5cdCAqIE5hbWVzIHRoYXQgYXJlIG5vdCByZWdpc3RlcmVkIGJ5IGFueSBleHRlbnNpb24gYXJlIHNpbGVudGx5IGlnbm9yZWRcblx0ICogYnkgQWdlbnRTZXNzaW9uLnNldEFjdGl2ZVRvb2xzQnlOYW1lLlxuXHQgKlxuXHQgKiBVc2VkIGJ5IC0tdG9vbHMgdG8gZm9yd2FyZCBuYW1lcyB0aGF0IGRvbid0IG1hdGNoIGEgYnVpbHQtaW4gKGxpa2VseVxuXHQgKiBleHRlbnNpb24tIG9yIE1DUC1wcm92aWRlZCksIHNvIHN1YmFnZW50cyB3aG9zZSBmcm9udG1hdHRlciBkZWNsYXJlc1xuXHQgKiBleHRlbnNpb24gdG9vbHMgZG9uJ3QgZW5kIHVwIHdpdGggYW4gZW1wdHkgdG9vbCBsaXN0LlxuXHQgKi9cblx0ZXh0cmFBY3RpdmVUb29sTmFtZXM/OiBzdHJpbmdbXTtcblxuXHQvKiogUmVzb3VyY2UgbG9hZGVyLiBXaGVuIG9taXR0ZWQsIERlZmF1bHRSZXNvdXJjZUxvYWRlciBpcyB1c2VkLiAqL1xuXHRyZXNvdXJjZUxvYWRlcj86IFJlc291cmNlTG9hZGVyO1xuXG5cdC8qKiBTZXNzaW9uIG1hbmFnZXIuIERlZmF1bHQ6IFNlc3Npb25NYW5hZ2VyLmNyZWF0ZShjd2QpICovXG5cdHNlc3Npb25NYW5hZ2VyPzogU2Vzc2lvbk1hbmFnZXI7XG5cblx0LyoqIFNldHRpbmdzIG1hbmFnZXIuIERlZmF1bHQ6IFNldHRpbmdzTWFuYWdlci5jcmVhdGUoY3dkLCBhZ2VudERpcikgKi9cblx0c2V0dGluZ3NNYW5hZ2VyPzogU2V0dGluZ3NNYW5hZ2VyO1xuXG5cdC8qKiBPcHRpb25hbDogY2hlY2sgaWYgdGhlIGNsYXVkZS1jb2RlIENMSSBwcm92aWRlciBpcyByZWFkeSAoaW5zdGFsbGVkICsgYXV0aGVkKS5cblx0ICogUGFzc2VkIHRvIFJldHJ5SGFuZGxlciBmb3IgdGhpcmQtcGFydHkgYmxvY2sgcmVjb3ZlcnkgKCMzNzcyKS4gKi9cblx0aXNDbGF1ZGVDb2RlUmVhZHk/OiAoKSA9PiBib29sZWFuO1xufVxuXG4vKiogUmVzdWx0IGZyb20gY3JlYXRlQWdlbnRTZXNzaW9uICovXG5leHBvcnQgaW50ZXJmYWNlIENyZWF0ZUFnZW50U2Vzc2lvblJlc3VsdCB7XG5cdC8qKiBUaGUgY3JlYXRlZCBzZXNzaW9uICovXG5cdHNlc3Npb246IEFnZW50U2Vzc2lvbjtcblx0LyoqIEV4dGVuc2lvbnMgcmVzdWx0IChmb3IgVUkgY29udGV4dCBzZXR1cCBpbiBpbnRlcmFjdGl2ZSBtb2RlKSAqL1xuXHRleHRlbnNpb25zUmVzdWx0OiBMb2FkRXh0ZW5zaW9uc1Jlc3VsdDtcblx0LyoqIFdhcm5pbmcgaWYgc2Vzc2lvbiB3YXMgcmVzdG9yZWQgd2l0aCBhIGRpZmZlcmVudCBtb2RlbCB0aGFuIHNhdmVkICovXG5cdG1vZGVsRmFsbGJhY2tNZXNzYWdlPzogc3RyaW5nO1xufVxuXG4vLyBSZS1leHBvcnRzXG5cbmV4cG9ydCB0eXBlIHtcblx0RXh0ZW5zaW9uQVBJLFxuXHRFeHRlbnNpb25Db21tYW5kQ29udGV4dCxcblx0RXh0ZW5zaW9uQ29udGV4dCxcblx0RXh0ZW5zaW9uRmFjdG9yeSxcblx0U2xhc2hDb21tYW5kSW5mbyxcblx0U2xhc2hDb21tYW5kTG9jYXRpb24sXG5cdFNsYXNoQ29tbWFuZFNvdXJjZSxcblx0VG9vbERlZmluaXRpb24sXG59IGZyb20gXCIuL2V4dGVuc2lvbnMvaW5kZXguanNcIjtcbmV4cG9ydCB0eXBlIHsgUHJvbXB0VGVtcGxhdGUgfSBmcm9tIFwiLi9wcm9tcHQtdGVtcGxhdGVzLmpzXCI7XG5leHBvcnQgdHlwZSB7IFNraWxsIH0gZnJvbSBcIi4vc2tpbGxzLmpzXCI7XG5leHBvcnQgdHlwZSB7IFRvb2wgfSBmcm9tIFwiLi90b29scy9pbmRleC5qc1wiO1xuXG5leHBvcnQge1xuXHQvLyBQcmUtYnVpbHQgdG9vbHMgKHVzZSBwcm9jZXNzLmN3ZCgpKVxuXHRyZWFkVG9vbCxcblx0YmFzaFRvb2wsXG5cdGVkaXRUb29sLFxuXHR3cml0ZVRvb2wsXG5cdGdyZXBUb29sLFxuXHRmaW5kVG9vbCxcblx0bHNUb29sLFxuXHRjb2RpbmdUb29scyxcblx0cmVhZE9ubHlUb29scyxcblx0YWxsVG9vbHMgYXMgYWxsQnVpbHRJblRvb2xzLFxuXHQvLyBUb29sIGZhY3RvcmllcyAoZm9yIGN1c3RvbSBjd2QpXG5cdGNyZWF0ZUNvZGluZ1Rvb2xzLFxuXHRjcmVhdGVSZWFkT25seVRvb2xzLFxuXHRjcmVhdGVSZWFkVG9vbCxcblx0Y3JlYXRlQmFzaFRvb2wsXG5cdGNyZWF0ZUVkaXRUb29sLFxuXHRjcmVhdGVXcml0ZVRvb2wsXG5cdGNyZWF0ZUdyZXBUb29sLFxuXHRjcmVhdGVGaW5kVG9vbCxcblx0Y3JlYXRlTHNUb29sLFxuXHQvLyBIYXNobGluZSBlZGl0IG1vZGVcblx0aGFzaGxpbmVDb2RpbmdUb29scyxcblx0aGFzaGxpbmVFZGl0VG9vbCxcblx0aGFzaGxpbmVSZWFkVG9vbCxcblx0Y3JlYXRlSGFzaGxpbmVDb2RpbmdUb29scyxcblx0Y3JlYXRlSGFzaGxpbmVFZGl0VG9vbCxcblx0Y3JlYXRlSGFzaGxpbmVSZWFkVG9vbCxcbn07XG5cbi8vIEhlbHBlciBGdW5jdGlvbnNcblxuZnVuY3Rpb24gZ2V0RGVmYXVsdEFnZW50RGlyKCk6IHN0cmluZyB7XG5cdHJldHVybiBnZXRBZ2VudERpcigpO1xufVxuXG4vKipcbiAqIENyZWF0ZSBhbiBBZ2VudFNlc3Npb24gd2l0aCB0aGUgc3BlY2lmaWVkIG9wdGlvbnMuXG4gKlxuICogQGV4YW1wbGVcbiAqIGBgYHR5cGVzY3JpcHRcbiAqIC8vIE1pbmltYWwgLSB1c2VzIGRlZmF1bHRzXG4gKiBjb25zdCB7IHNlc3Npb24gfSA9IGF3YWl0IGNyZWF0ZUFnZW50U2Vzc2lvbigpO1xuICpcbiAqIC8vIFdpdGggZXhwbGljaXQgbW9kZWxcbiAqIGltcG9ydCB7IGdldE1vZGVsIH0gZnJvbSAnQGdzZC9waS1haSc7XG4gKiBjb25zdCB7IHNlc3Npb24gfSA9IGF3YWl0IGNyZWF0ZUFnZW50U2Vzc2lvbih7XG4gKiAgIG1vZGVsOiBnZXRNb2RlbCgnYW50aHJvcGljJywgJ2NsYXVkZS1vcHVzLTQtNScpLFxuICogICB0aGlua2luZ0xldmVsOiAnaGlnaCcsXG4gKiB9KTtcbiAqXG4gKiAvLyBDb250aW51ZSBwcmV2aW91cyBzZXNzaW9uXG4gKiBjb25zdCB7IHNlc3Npb24sIG1vZGVsRmFsbGJhY2tNZXNzYWdlIH0gPSBhd2FpdCBjcmVhdGVBZ2VudFNlc3Npb24oe1xuICogICBjb250aW51ZVNlc3Npb246IHRydWUsXG4gKiB9KTtcbiAqXG4gKiAvLyBGdWxsIGNvbnRyb2xcbiAqIGNvbnN0IGxvYWRlciA9IG5ldyBEZWZhdWx0UmVzb3VyY2VMb2FkZXIoe1xuICogICBjd2Q6IHByb2Nlc3MuY3dkKCksXG4gKiAgIGFnZW50RGlyOiBnZXRBZ2VudERpcigpLFxuICogICBzZXR0aW5nc01hbmFnZXI6IFNldHRpbmdzTWFuYWdlci5jcmVhdGUoKSxcbiAqIH0pO1xuICogYXdhaXQgbG9hZGVyLnJlbG9hZCgpO1xuICogY29uc3QgeyBzZXNzaW9uIH0gPSBhd2FpdCBjcmVhdGVBZ2VudFNlc3Npb24oe1xuICogICBtb2RlbDogbXlNb2RlbCxcbiAqICAgdG9vbHM6IFtyZWFkVG9vbCwgYmFzaFRvb2xdLFxuICogICByZXNvdXJjZUxvYWRlcjogbG9hZGVyLFxuICogICBzZXNzaW9uTWFuYWdlcjogU2Vzc2lvbk1hbmFnZXIuaW5NZW1vcnkoKSxcbiAqIH0pO1xuICogYGBgXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjcmVhdGVBZ2VudFNlc3Npb24ob3B0aW9uczogQ3JlYXRlQWdlbnRTZXNzaW9uT3B0aW9ucyA9IHt9KTogUHJvbWlzZTxDcmVhdGVBZ2VudFNlc3Npb25SZXN1bHQ+IHtcblx0Y29uc3QgY3dkID0gb3B0aW9ucy5jd2QgPz8gcHJvY2Vzcy5jd2QoKTtcblx0Y29uc3QgYWdlbnREaXIgPSBvcHRpb25zLmFnZW50RGlyID8/IGdldERlZmF1bHRBZ2VudERpcigpO1xuXHRsZXQgcmVzb3VyY2VMb2FkZXIgPSBvcHRpb25zLnJlc291cmNlTG9hZGVyO1xuXG5cdC8vIFVzZSBwcm92aWRlZCBvciBjcmVhdGUgQXV0aFN0b3JhZ2UgYW5kIE1vZGVsUmVnaXN0cnlcblx0Y29uc3QgYXV0aFBhdGggPSBvcHRpb25zLmFnZW50RGlyID8gam9pbihhZ2VudERpciwgXCJhdXRoLmpzb25cIikgOiB1bmRlZmluZWQ7XG5cdGNvbnN0IG1vZGVsc1BhdGggPSBvcHRpb25zLmFnZW50RGlyID8gam9pbihhZ2VudERpciwgXCJtb2RlbHMuanNvblwiKSA6IHVuZGVmaW5lZDtcblx0Y29uc3QgYXV0aFN0b3JhZ2UgPSBvcHRpb25zLmF1dGhTdG9yYWdlID8/IEF1dGhTdG9yYWdlLmNyZWF0ZShhdXRoUGF0aCk7XG5cdGNvbnN0IG1vZGVsUmVnaXN0cnkgPSBvcHRpb25zLm1vZGVsUmVnaXN0cnkgPz8gbmV3IE1vZGVsUmVnaXN0cnkoYXV0aFN0b3JhZ2UsIG1vZGVsc1BhdGgpO1xuXG5cdGNvbnN0IHNldHRpbmdzTWFuYWdlciA9IG9wdGlvbnMuc2V0dGluZ3NNYW5hZ2VyID8/IFNldHRpbmdzTWFuYWdlci5jcmVhdGUoY3dkLCBhZ2VudERpcik7XG5cdGNvbnN0IHNlc3Npb25NYW5hZ2VyID0gb3B0aW9ucy5zZXNzaW9uTWFuYWdlciA/PyBTZXNzaW9uTWFuYWdlci5jcmVhdGUoY3dkKTtcblxuXHRpZiAoIXJlc291cmNlTG9hZGVyKSB7XG5cdFx0cmVzb3VyY2VMb2FkZXIgPSBuZXcgRGVmYXVsdFJlc291cmNlTG9hZGVyKHsgY3dkLCBhZ2VudERpciwgc2V0dGluZ3NNYW5hZ2VyIH0pO1xuXHRcdGF3YWl0IHJlc291cmNlTG9hZGVyLnJlbG9hZCgpO1xuXHRcdHRpbWUoXCJyZXNvdXJjZUxvYWRlci5yZWxvYWRcIik7XG5cdH1cblxuXHQvLyBGbHVzaCBwcm92aWRlciByZWdpc3RyYXRpb25zIHF1ZXVlZCBkdXJpbmcgZXh0ZW5zaW9uIGxvYWRpbmcgc28gdGhhdFxuXHQvLyBleHRlbnNpb24gbW9kZWxzIChlLmcuIHBpLWNsYXVkZS1jbGkpIGFyZSB2aXNpYmxlIGluIHRoZSByZWdpc3RyeSBiZWZvcmVcblx0Ly8gZmluZEluaXRpYWxNb2RlbCgpIHJ1bnMuIGJpbmRDb3JlKCkgcmVwZWF0cyB0aGlzIGZsdXNoIGFzIGEgc2FmZXR5IG5ldFxuXHQvLyBmb3IgYW55IGxhdGUtYXJyaXZpbmcgcmVnaXN0cmF0aW9ucy5cblx0Y29uc3QgeyBydW50aW1lOiBleHRlbnNpb25SdW50aW1lIH0gPSByZXNvdXJjZUxvYWRlci5nZXRFeHRlbnNpb25zKCk7XG5cdGZvciAoY29uc3QgeyBuYW1lLCBjb25maWcgfSBvZiBleHRlbnNpb25SdW50aW1lLnBlbmRpbmdQcm92aWRlclJlZ2lzdHJhdGlvbnMpIHtcblx0XHRtb2RlbFJlZ2lzdHJ5LnJlZ2lzdGVyUHJvdmlkZXIobmFtZSwgY29uZmlnKTtcblx0fVxuXHRleHRlbnNpb25SdW50aW1lLnBlbmRpbmdQcm92aWRlclJlZ2lzdHJhdGlvbnMgPSBbXTtcblxuXHQvLyBDaGVjayBpZiBzZXNzaW9uIGhhcyBleGlzdGluZyBkYXRhIHRvIHJlc3RvcmVcblx0Y29uc3QgZXhpc3RpbmdTZXNzaW9uID0gc2Vzc2lvbk1hbmFnZXIuYnVpbGRTZXNzaW9uQ29udGV4dCgpO1xuXHRjb25zdCBoYXNFeGlzdGluZ1Nlc3Npb24gPSBleGlzdGluZ1Nlc3Npb24ubWVzc2FnZXMubGVuZ3RoID4gMDtcblx0Y29uc3QgaGFzVGhpbmtpbmdFbnRyeSA9IHNlc3Npb25NYW5hZ2VyLmdldEJyYW5jaCgpLnNvbWUoKGVudHJ5KSA9PiBlbnRyeS50eXBlID09PSBcInRoaW5raW5nX2xldmVsX2NoYW5nZVwiKTtcblxuXHRsZXQgbW9kZWwgPSBvcHRpb25zLm1vZGVsO1xuXHRsZXQgbW9kZWxGYWxsYmFja01lc3NhZ2U6IHN0cmluZyB8IHVuZGVmaW5lZDtcblxuXHQvLyBJZiBzZXNzaW9uIGhhcyBkYXRhLCB0cnkgdG8gcmVzdG9yZSBtb2RlbCBmcm9tIGl0XG5cdGlmICghbW9kZWwgJiYgaGFzRXhpc3RpbmdTZXNzaW9uICYmIGV4aXN0aW5nU2Vzc2lvbi5tb2RlbCkge1xuXHRcdGNvbnN0IHJlc3RvcmVkTW9kZWwgPSBtb2RlbFJlZ2lzdHJ5LmZpbmQoZXhpc3RpbmdTZXNzaW9uLm1vZGVsLnByb3ZpZGVyLCBleGlzdGluZ1Nlc3Npb24ubW9kZWwubW9kZWxJZCk7XG5cdFx0XHRpZiAocmVzdG9yZWRNb2RlbCAmJiBjYW5SZXN0b3JlU2Vzc2lvbk1vZGVsKG1vZGVsUmVnaXN0cnksIHJlc3RvcmVkTW9kZWwpKSB7XG5cdFx0XHRcdG1vZGVsID0gcmVzdG9yZWRNb2RlbDtcblx0XHRcdH1cblx0XHRpZiAoIW1vZGVsKSB7XG5cdFx0XHRtb2RlbEZhbGxiYWNrTWVzc2FnZSA9IGBDb3VsZCBub3QgcmVzdG9yZSBtb2RlbCAke2V4aXN0aW5nU2Vzc2lvbi5tb2RlbC5wcm92aWRlcn0vJHtleGlzdGluZ1Nlc3Npb24ubW9kZWwubW9kZWxJZH1gO1xuXHRcdH1cblx0fVxuXG5cdC8vIEZsdXNoIGV4dGVuc2lvbiBwcm92aWRlciByZWdpc3RyYXRpb25zIHNvIGV4dGVuc2lvbi1wcm92aWRlZCBtb2RlbHMgKGUuZy4gY2xhdWRlLWNvZGUvKilcblx0Ly8gYXJlIGF2YWlsYWJsZSBpbiB0aGUgcmVnaXN0cnkgYmVmb3JlIG1vZGVsIHJlc29sdXRpb24uIFdpdGhvdXQgdGhpcywgZmluZEluaXRpYWxNb2RlbCgpXG5cdC8vIGNhbm5vdCBmaW5kIGV4dGVuc2lvbiBtb2RlbHMgYW5kIGZhbGxzIGJhY2sgdG8gYnVpbHQtaW4gcHJvdmlkZXJzICgjMzUzNCkuXG5cdGNvbnN0IGV4dGVuc2lvbnNGb3JNb2RlbFJlc29sdXRpb24gPSByZXNvdXJjZUxvYWRlci5nZXRFeHRlbnNpb25zKCk7XG5cdGZvciAoY29uc3QgeyBuYW1lLCBjb25maWcgfSBvZiBleHRlbnNpb25zRm9yTW9kZWxSZXNvbHV0aW9uLnJ1bnRpbWUucGVuZGluZ1Byb3ZpZGVyUmVnaXN0cmF0aW9ucykge1xuXHRcdG1vZGVsUmVnaXN0cnkucmVnaXN0ZXJQcm92aWRlcihuYW1lLCBjb25maWcpO1xuXHR9XG5cdC8vIENsZWFyIHRoZSBxdWV1ZSBzbyBiaW5kQ29yZSgpIGRvZXNuJ3QgcmUtcmVnaXN0ZXIgdGhlIHNhbWUgcHJvdmlkZXJzLlxuXHRleHRlbnNpb25zRm9yTW9kZWxSZXNvbHV0aW9uLnJ1bnRpbWUucGVuZGluZ1Byb3ZpZGVyUmVnaXN0cmF0aW9ucyA9IFtdO1xuXG5cdC8vIElmIHN0aWxsIG5vIG1vZGVsLCB1c2UgZmluZEluaXRpYWxNb2RlbCAoY2hlY2tzIHNldHRpbmdzIGRlZmF1bHQsIHRoZW4gcHJvdmlkZXIgZGVmYXVsdHMpXG5cdGlmICghbW9kZWwpIHtcblx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCBmaW5kSW5pdGlhbE1vZGVsKHtcblx0XHRcdHNjb3BlZE1vZGVsczogW10sXG5cdFx0XHRpc0NvbnRpbnVpbmc6IGhhc0V4aXN0aW5nU2Vzc2lvbixcblx0XHRcdGRlZmF1bHRQcm92aWRlcjogc2V0dGluZ3NNYW5hZ2VyLmdldERlZmF1bHRQcm92aWRlcigpLFxuXHRcdFx0ZGVmYXVsdE1vZGVsSWQ6IHNldHRpbmdzTWFuYWdlci5nZXREZWZhdWx0TW9kZWwoKSxcblx0XHRcdGRlZmF1bHRUaGlua2luZ0xldmVsOiBzZXR0aW5nc01hbmFnZXIuZ2V0RGVmYXVsdFRoaW5raW5nTGV2ZWwoKSxcblx0XHRcdG1vZGVsUmVnaXN0cnksXG5cdFx0fSk7XG5cdFx0bW9kZWwgPSByZXN1bHQubW9kZWw7XG5cdFx0aWYgKCFtb2RlbCkge1xuXHRcdFx0bW9kZWxGYWxsYmFja01lc3NhZ2UgPSBgTm8gbW9kZWxzIGF2YWlsYWJsZS4gVXNlIC9sb2dpbiBvciBzZXQgYW4gQVBJIGtleSBlbnZpcm9ubWVudCB2YXJpYWJsZS4gU2VlICR7am9pbihnZXREb2NzUGF0aCgpLCBcInByb3ZpZGVycy5tZFwiKX0uIFRoZW4gdXNlIC9tb2RlbCB0byBzZWxlY3QgYSBtb2RlbC5gO1xuXHRcdH0gZWxzZSBpZiAobW9kZWxGYWxsYmFja01lc3NhZ2UpIHtcblx0XHRcdG1vZGVsRmFsbGJhY2tNZXNzYWdlICs9IGAuIFVzaW5nICR7bW9kZWwucHJvdmlkZXJ9LyR7bW9kZWwuaWR9YDtcblx0XHR9XG5cdH1cblxuXHRsZXQgdGhpbmtpbmdMZXZlbCA9IG9wdGlvbnMudGhpbmtpbmdMZXZlbDtcblxuXHQvLyBJZiBzZXNzaW9uIGhhcyBkYXRhLCByZXN0b3JlIHRoaW5raW5nIGxldmVsIGZyb20gaXRcblx0aWYgKHRoaW5raW5nTGV2ZWwgPT09IHVuZGVmaW5lZCAmJiBoYXNFeGlzdGluZ1Nlc3Npb24pIHtcblx0XHR0aGlua2luZ0xldmVsID0gaGFzVGhpbmtpbmdFbnRyeVxuXHRcdFx0PyAoZXhpc3RpbmdTZXNzaW9uLnRoaW5raW5nTGV2ZWwgYXMgVGhpbmtpbmdMZXZlbClcblx0XHRcdDogKHNldHRpbmdzTWFuYWdlci5nZXREZWZhdWx0VGhpbmtpbmdMZXZlbCgpID8/IERFRkFVTFRfVEhJTktJTkdfTEVWRUwpO1xuXHR9XG5cblx0Ly8gRmFsbCBiYWNrIHRvIHNldHRpbmdzIGRlZmF1bHRcblx0aWYgKHRoaW5raW5nTGV2ZWwgPT09IHVuZGVmaW5lZCkge1xuXHRcdHRoaW5raW5nTGV2ZWwgPSBzZXR0aW5nc01hbmFnZXIuZ2V0RGVmYXVsdFRoaW5raW5nTGV2ZWwoKSA/PyBERUZBVUxUX1RISU5LSU5HX0xFVkVMO1xuXHR9XG5cblx0Ly8gQ2xhbXAgdG8gbW9kZWwgY2FwYWJpbGl0aWVzXG5cdGlmICghbW9kZWwgfHwgIW1vZGVsLnJlYXNvbmluZykge1xuXHRcdHRoaW5raW5nTGV2ZWwgPSBcIm9mZlwiO1xuXHR9XG5cblx0Y29uc3QgZWRpdE1vZGUgPSBzZXR0aW5nc01hbmFnZXIuZ2V0RWRpdE1vZGUoKTtcblx0Y29uc3QgZGVmYXVsdEFjdGl2ZVRvb2xOYW1lczogVG9vbE5hbWVbXSA9IGVkaXRNb2RlID09PSBcImhhc2hsaW5lXCJcblx0XHQ/IFtcImhhc2hsaW5lX3JlYWRcIiwgXCJiYXNoXCIsIFwiaGFzaGxpbmVfZWRpdFwiLCBcIndyaXRlXCIsIFwibHNwXCJdXG5cdFx0OiBbXCJyZWFkXCIsIFwiYmFzaFwiLCBcImVkaXRcIiwgXCJ3cml0ZVwiLCBcImxzcFwiXTtcblx0Y29uc3QgYnVpbHRpbkFjdGl2ZVRvb2xOYW1lczogVG9vbE5hbWVbXSA9IG9wdGlvbnMudG9vbHNcblx0XHQ/IG9wdGlvbnMudG9vbHMubWFwKCh0KSA9PiB0Lm5hbWUpLmZpbHRlcigobik6IG4gaXMgVG9vbE5hbWUgPT4gbiBpbiBhbGxUb29scylcblx0XHQ6IGRlZmF1bHRBY3RpdmVUb29sTmFtZXM7XG5cdC8vIE1lcmdlIGluIGV4dGVuc2lvbi9NQ1AgdG9vbCBuYW1lcyBmcm9tIC0tdG9vbHMgdGhhdCBkaWRuJ3QgbWF0Y2ggYSBidWlsdC1pbi5cblx0Ly8gQWdlbnRTZXNzaW9uLnNldEFjdGl2ZVRvb2xzQnlOYW1lIHNpbGVudGx5IGRyb3BzIG5hbWVzIHRoYXQgYXJlbid0IGluIHRoZVxuXHQvLyByZWdpc3RyeSwgc28gdW5rbm93biBuYW1lcyBhcmUgaGFybWxlc3MgaGVyZS5cblx0Y29uc3QgaW5pdGlhbEFjdGl2ZVRvb2xOYW1lczogc3RyaW5nW10gPSBvcHRpb25zLmV4dHJhQWN0aXZlVG9vbE5hbWVzXG5cdFx0PyBbLi4uYnVpbHRpbkFjdGl2ZVRvb2xOYW1lcywgLi4ub3B0aW9ucy5leHRyYUFjdGl2ZVRvb2xOYW1lc11cblx0XHQ6IGJ1aWx0aW5BY3RpdmVUb29sTmFtZXM7XG5cblx0bGV0IGFnZW50OiBBZ2VudDtcblxuXHQvLyBDcmVhdGUgY29udmVydFRvTGxtIHdyYXBwZXIgdGhhdCBmaWx0ZXJzIGltYWdlcyBpZiBibG9ja0ltYWdlcyBpcyBlbmFibGVkIChkZWZlbnNlLWluLWRlcHRoKVxuXHRjb25zdCBjb252ZXJ0VG9MbG1XaXRoQmxvY2tJbWFnZXMgPSAobWVzc2FnZXM6IEFnZW50TWVzc2FnZVtdKTogTWVzc2FnZVtdID0+IHtcblx0XHRjb25zdCBjb252ZXJ0ZWQgPSBjb252ZXJ0VG9MbG0obWVzc2FnZXMpO1xuXHRcdC8vIENoZWNrIHNldHRpbmcgZHluYW1pY2FsbHkgc28gbWlkLXNlc3Npb24gY2hhbmdlcyB0YWtlIGVmZmVjdFxuXHRcdGlmICghc2V0dGluZ3NNYW5hZ2VyLmdldEJsb2NrSW1hZ2VzKCkpIHtcblx0XHRcdHJldHVybiBjb252ZXJ0ZWQ7XG5cdFx0fVxuXHRcdC8vIEZpbHRlciBvdXQgSW1hZ2VDb250ZW50IGZyb20gYWxsIG1lc3NhZ2VzLCByZXBsYWNpbmcgd2l0aCB0ZXh0IHBsYWNlaG9sZGVyXG5cdFx0cmV0dXJuIGNvbnZlcnRlZC5tYXAoKG1zZykgPT4ge1xuXHRcdFx0aWYgKG1zZy5yb2xlID09PSBcInVzZXJcIiB8fCBtc2cucm9sZSA9PT0gXCJ0b29sUmVzdWx0XCIpIHtcblx0XHRcdFx0Y29uc3QgY29udGVudCA9IG1zZy5jb250ZW50O1xuXHRcdFx0XHRpZiAoQXJyYXkuaXNBcnJheShjb250ZW50KSkge1xuXHRcdFx0XHRcdGNvbnN0IGhhc0ltYWdlcyA9IGNvbnRlbnQuc29tZSgoYykgPT4gYy50eXBlID09PSBcImltYWdlXCIpO1xuXHRcdFx0XHRcdGlmIChoYXNJbWFnZXMpIHtcblx0XHRcdFx0XHRcdGNvbnN0IGZpbHRlcmVkQ29udGVudCA9IGNvbnRlbnRcblx0XHRcdFx0XHRcdFx0Lm1hcCgoYykgPT5cblx0XHRcdFx0XHRcdFx0XHRjLnR5cGUgPT09IFwiaW1hZ2VcIiA/IHsgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IFwiSW1hZ2UgcmVhZGluZyBpcyBkaXNhYmxlZC5cIiB9IDogYyxcblx0XHRcdFx0XHRcdFx0KVxuXHRcdFx0XHRcdFx0XHQuZmlsdGVyKFxuXHRcdFx0XHRcdFx0XHRcdChjLCBpLCBhcnIpID0+XG5cdFx0XHRcdFx0XHRcdFx0XHQvLyBEZWR1cGUgY29uc2VjdXRpdmUgXCJJbWFnZSByZWFkaW5nIGlzIGRpc2FibGVkLlwiIHRleHRzXG5cdFx0XHRcdFx0XHRcdFx0XHQhKFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRjLnR5cGUgPT09IFwidGV4dFwiICYmXG5cdFx0XHRcdFx0XHRcdFx0XHRcdGMudGV4dCA9PT0gXCJJbWFnZSByZWFkaW5nIGlzIGRpc2FibGVkLlwiICYmXG5cdFx0XHRcdFx0XHRcdFx0XHRcdGkgPiAwICYmXG5cdFx0XHRcdFx0XHRcdFx0XHRcdGFycltpIC0gMV0udHlwZSA9PT0gXCJ0ZXh0XCIgJiZcblx0XHRcdFx0XHRcdFx0XHRcdFx0KGFycltpIC0gMV0gYXMgeyB0eXBlOiBcInRleHRcIjsgdGV4dDogc3RyaW5nIH0pLnRleHQgPT09IFwiSW1hZ2UgcmVhZGluZyBpcyBkaXNhYmxlZC5cIlxuXHRcdFx0XHRcdFx0XHRcdFx0KSxcblx0XHRcdFx0XHRcdFx0KTtcblx0XHRcdFx0XHRcdHJldHVybiB7IC4uLm1zZywgY29udGVudDogZmlsdGVyZWRDb250ZW50IH07XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0XHRyZXR1cm4gbXNnO1xuXHRcdH0pO1xuXHR9O1xuXG5cdGNvbnN0IGV4dGVuc2lvblJ1bm5lclJlZjogeyBjdXJyZW50PzogRXh0ZW5zaW9uUnVubmVyIH0gPSB7fTtcblx0Y29uc3Qgd29ya3NwYWNlUm9vdFJlZjogeyBjdXJyZW50OiBzdHJpbmcgfSA9IHsgY3VycmVudDogY3dkIH07XG5cblx0YWdlbnQgPSBuZXcgQWdlbnQoe1xuXHRcdGluaXRpYWxTdGF0ZToge1xuXHRcdFx0c3lzdGVtUHJvbXB0OiBcIlwiLFxuXHRcdFx0bW9kZWwsXG5cdFx0XHR0aGlua2luZ0xldmVsLFxuXHRcdFx0dG9vbHM6IFtdLFxuXHRcdH0sXG5cdFx0Y29udmVydFRvTGxtOiBjb252ZXJ0VG9MbG1XaXRoQmxvY2tJbWFnZXMsXG5cdFx0b25QYXlsb2FkOiBhc3luYyAocGF5bG9hZCwgY3VycmVudE1vZGVsKSA9PiB7XG5cdFx0XHRjb25zdCBydW5uZXIgPSBleHRlbnNpb25SdW5uZXJSZWYuY3VycmVudDtcblx0XHRcdGlmICghcnVubmVyPy5oYXNIYW5kbGVycyhcImJlZm9yZV9wcm92aWRlcl9yZXF1ZXN0XCIpKSB7XG5cdFx0XHRcdG1heWJlTG9nUHJvdmlkZXJQYXlsb2FkQXVkaXQocGF5bG9hZCwgXCJiZWZvcmVfcHJvdmlkZXJfcmVxdWVzdDp1bmNoYW5nZWRcIik7XG5cdFx0XHRcdHJldHVybiBwYXlsb2FkO1xuXHRcdFx0fVxuXHRcdFx0Y29uc3QgbmV4dFBheWxvYWQgPSBhd2FpdCBydW5uZXIuZW1pdEJlZm9yZVByb3ZpZGVyUmVxdWVzdChwYXlsb2FkLCBjdXJyZW50TW9kZWwpO1xuXHRcdFx0bWF5YmVMb2dQcm92aWRlclBheWxvYWRBdWRpdChuZXh0UGF5bG9hZCwgXCJiZWZvcmVfcHJvdmlkZXJfcmVxdWVzdDphZnRlclwiKTtcblx0XHRcdHJldHVybiBuZXh0UGF5bG9hZDtcblx0XHR9LFxuXHRcdHNlc3Npb25JZDogc2Vzc2lvbk1hbmFnZXIuZ2V0U2Vzc2lvbklkKCksXG5cdFx0dHJhbnNmb3JtQ29udGV4dDogYXN5bmMgKG1lc3NhZ2VzKSA9PiB7XG5cdFx0XHRjb25zdCBydW5uZXIgPSBleHRlbnNpb25SdW5uZXJSZWYuY3VycmVudDtcblx0XHRcdGlmICghcnVubmVyKSByZXR1cm4gbWVzc2FnZXM7XG5cdFx0XHRyZXR1cm4gcnVubmVyLmVtaXRDb250ZXh0KG1lc3NhZ2VzKTtcblx0XHR9LFxuXHRcdGZpbHRlclRvb2xzOiBhc3luYyAodG9vbHMsIF9zaWduYWwsIG1lc3NhZ2VzKSA9PiB7XG5cdFx0XHRjb25zdCBjdXJyZW50TW9kZWwgPSBhZ2VudC5zdGF0ZS5hY3RpdmVJbmZlcmVuY2VNb2RlbCA/PyBhZ2VudC5zdGF0ZS5tb2RlbCA/PyBtb2RlbDtcblx0XHRcdGlmICghY3VycmVudE1vZGVsKSByZXR1cm4gdG9vbHM7XG5cdFx0XHRjb25zdCBwcm92aWRlckZpbHRlcmVkID0gZmlsdGVyVG9vbHNGb3JQcm92aWRlclJlcXVlc3QodG9vbHMsIGN1cnJlbnRNb2RlbCk7XG5cdFx0XHRjb25zdCBydW5uZXIgPSBleHRlbnNpb25SdW5uZXJSZWYuY3VycmVudDtcblx0XHRcdGlmICghcnVubmVyPy5oYXNIYW5kbGVycyhcImFkanVzdF90b29sX3NldFwiKSkgcmV0dXJuIHByb3ZpZGVyRmlsdGVyZWQuY29tcGF0aWJsZTtcblx0XHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bm5lci5lbWl0QWRqdXN0VG9vbFNldCh7XG5cdFx0XHRcdHNlbGVjdGVkTW9kZWxBcGk6IGN1cnJlbnRNb2RlbC5hcGksXG5cdFx0XHRcdHNlbGVjdGVkTW9kZWxQcm92aWRlcjogY3VycmVudE1vZGVsLnByb3ZpZGVyLFxuXHRcdFx0XHRzZWxlY3RlZE1vZGVsSWQ6IGN1cnJlbnRNb2RlbC5pZCxcblx0XHRcdFx0YWN0aXZlVG9vbE5hbWVzOiBwcm92aWRlckZpbHRlcmVkLmNvbXBhdGlibGUubWFwKCh0b29sKSA9PiB0b29sLm5hbWUpLFxuXHRcdFx0XHRmaWx0ZXJlZFRvb2xzOiBwcm92aWRlckZpbHRlcmVkLmZpbHRlcmVkLm1hcCgodG9vbCkgPT4gdG9vbC5uYW1lKSxcblx0XHRcdFx0cmVxdWVzdEN1c3RvbU1lc3NhZ2VzOiBnZXRBZGp1c3RUb29sU2V0UmVxdWVzdEN1c3RvbU1lc3NhZ2VzKG1lc3NhZ2VzKSxcblx0XHRcdH0pO1xuXHRcdFx0aWYgKCFyZXN1bHQ/LnRvb2xOYW1lcykgcmV0dXJuIHByb3ZpZGVyRmlsdGVyZWQuY29tcGF0aWJsZTtcblx0XHRcdGNvbnN0IGFsbG93ZWROYW1lcyA9IG5ldyBTZXQocmVzdWx0LnRvb2xOYW1lcyk7XG5cdFx0XHRyZXR1cm4gcHJvdmlkZXJGaWx0ZXJlZC5jb21wYXRpYmxlLmZpbHRlcigodG9vbCkgPT4gYWxsb3dlZE5hbWVzLmhhcyh0b29sLm5hbWUpKTtcblx0XHR9LFxuXHRcdHN0ZWVyaW5nTW9kZTogc2V0dGluZ3NNYW5hZ2VyLmdldFN0ZWVyaW5nTW9kZSgpLFxuXHRcdGZvbGxvd1VwTW9kZTogc2V0dGluZ3NNYW5hZ2VyLmdldEZvbGxvd1VwTW9kZSgpLFxuXHRcdHRyYW5zcG9ydDogc2V0dGluZ3NNYW5hZ2VyLmdldFRyYW5zcG9ydCgpLFxuXHRcdHRoaW5raW5nQnVkZ2V0czogc2V0dGluZ3NNYW5hZ2VyLmdldFRoaW5raW5nQnVkZ2V0cygpLFxuXHRcdG1heFJldHJ5RGVsYXlNczogc2V0dGluZ3NNYW5hZ2VyLmdldFJldHJ5U2V0dGluZ3MoKS5tYXhEZWxheU1zLFxuXHRcdGV4dGVybmFsVG9vbEV4ZWN1dGlvbjogKG0pID0+IG1vZGVsUmVnaXN0cnkuZ2V0UHJvdmlkZXJBdXRoTW9kZShtLnByb3ZpZGVyKSA9PT0gXCJleHRlcm5hbENsaVwiLFxuXHRcdGdldFByb3ZpZGVyT3B0aW9uczogYXN5bmMgKGN1cnJlbnRNb2RlbCkgPT4ge1xuXHRcdFx0aWYgKGN1cnJlbnRNb2RlbC5wcm92aWRlciAhPT0gXCJjbGF1ZGUtY29kZVwiKSByZXR1cm4gdW5kZWZpbmVkO1xuXHRcdFx0Y29uc3QgcnVubmVyID0gZXh0ZW5zaW9uUnVubmVyUmVmLmN1cnJlbnQ7XG5cdFx0XHRpZiAoIXJ1bm5lcj8uaGFzVUkoKSkge1xuXHRcdFx0XHRyZXR1cm4geyBjd2Q6IHdvcmtzcGFjZVJvb3RSZWYuY3VycmVudCB9O1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0Y3dkOiB3b3Jrc3BhY2VSb290UmVmLmN1cnJlbnQsXG5cdFx0XHRcdGV4dGVuc2lvblVJQ29udGV4dDogcnVubmVyLmdldFVJQ29udGV4dCgpLFxuXHRcdFx0fTtcblx0XHR9LFxuXHRcdGdldEFwaUtleTogYXN5bmMgKHByb3ZpZGVyKSA9PiB7XG5cdFx0XHQvLyBVc2UgdGhlIHByb3ZpZGVyIGFyZ3VtZW50IGZyb20gdGhlIGluLWZsaWdodCByZXF1ZXN0O1xuXHRcdFx0Ly8gYWdlbnQuc3RhdGUubW9kZWwgbWF5IGFscmVhZHkgYmUgc3dpdGNoZWQgbWlkLXR1cm4uXG5cdFx0XHRjb25zdCByZXNvbHZlZFByb3ZpZGVyID0gcHJvdmlkZXIgfHwgYWdlbnQuc3RhdGUubW9kZWw/LnByb3ZpZGVyO1xuXHRcdFx0aWYgKCFyZXNvbHZlZFByb3ZpZGVyKSB7XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihcIk5vIG1vZGVsIHNlbGVjdGVkXCIpO1xuXHRcdFx0fVxuXHRcdFx0Y29uc3QgYXV0aE1vZGUgPSBtb2RlbFJlZ2lzdHJ5LmdldFByb3ZpZGVyQXV0aE1vZGUocmVzb2x2ZWRQcm92aWRlcik7XG5cdFx0XHRpZiAoYXV0aE1vZGUgPT09IFwiZXh0ZXJuYWxDbGlcIiB8fCBhdXRoTW9kZSA9PT0gXCJub25lXCIpIHtcblx0XHRcdFx0cmV0dXJuIHVuZGVmaW5lZDtcblx0XHRcdH1cblxuXHRcdFx0Ly8gUmV0cnkga2V5IHJlc29sdXRpb24gd2l0aCBiYWNrb2ZmIHRvIGhhbmRsZSB0cmFuc2llbnQgbmV0d29yayBmYWlsdXJlc1xuXHRcdFx0Ly8gKGUuZy4sIE9BdXRoIHRva2VuIHJlZnJlc2ggZmFpbGluZyBkdWUgdG8gYnJpZWYgY29ubmVjdGl2aXR5IGxvc3MpLlxuXHRcdFx0Ly8gV2hlbiBjcmVkZW50aWFscyBhcmUgaW4gYSBjb29sZG93biB3aW5kb3cgKGUuZy4sIGFmdGVyIGEgNDI5KSwgd2FpdFxuXHRcdFx0Ly8gZm9yIHRoZSBiYWNrb2ZmIHRvIGV4cGlyZSBpbnN0ZWFkIG9mIHVzaW5nIGZpeGVkIGRlbGF5cyB0aGF0IGFyZVxuXHRcdFx0Ly8gc2hvcnRlciB0aGFuIHRoZSBjb29sZG93biBkdXJhdGlvbi5cblx0XHRcdGNvbnN0IG1heEF0dGVtcHRzID0gMztcblx0XHRcdGNvbnN0IGJhc2VEZWxheU1zID0gMjAwMDtcblx0XHRcdGNvbnN0IG1heENvb2xkb3duV2FpdE1zID0gNjBfMDAwOyAvLyBEb24ndCB3YWl0IGxvbmdlciB0aGFuIDYwcyAoc2tpcCBxdW90YS1leGhhdXN0ZWQgMzBtaW4gYmFja29mZnMpXG5cdFx0XHRmb3IgKGxldCBhdHRlbXB0ID0gMTsgYXR0ZW1wdCA8PSBtYXhBdHRlbXB0czsgYXR0ZW1wdCsrKSB7XG5cdFx0XHRcdGNvbnN0IGtleSA9IGF3YWl0IG1vZGVsUmVnaXN0cnkuZ2V0QXBpS2V5Rm9yUHJvdmlkZXIocmVzb2x2ZWRQcm92aWRlcik7XG5cdFx0XHRcdGlmIChrZXkpIHJldHVybiBrZXk7XG5cblx0XHRcdFx0Ly8gT24gdGhlIGxhc3QgYXR0ZW1wdCwgZmFsbCB0aHJvdWdoIHRvIGVycm9yIGhhbmRsaW5nIGJlbG93XG5cdFx0XHRcdGlmIChhdHRlbXB0ID49IG1heEF0dGVtcHRzKSBicmVhaztcblxuXHRcdFx0XHQvLyBPbmx5IHJldHJ5IGlmIGNyZWRlbnRpYWxzIGV4aXN0IChuZXR3b3JrIGlzc3VlKSBcdTIwMTQgbm8gcG9pbnQgcmV0cnlpbmdcblx0XHRcdFx0Ly8gd2hlbiB0aGVyZSBhcmUgZ2VudWluZWx5IG5vIGNyZWRlbnRpYWxzIGNvbmZpZ3VyZWQuXG5cdFx0XHRcdGNvbnN0IGhhc0F1dGggPSBtb2RlbFJlZ2lzdHJ5LmF1dGhTdG9yYWdlLmhhc0F1dGgocmVzb2x2ZWRQcm92aWRlcik7XG5cdFx0XHRcdGNvbnN0IG1vZGVsID0gYWdlbnQuc3RhdGUubW9kZWw7XG5cdFx0XHRcdGNvbnN0IGlzT0F1dGggPSBtb2RlbCAmJiBtb2RlbFJlZ2lzdHJ5LmlzVXNpbmdPQXV0aChtb2RlbCk7XG5cdFx0XHRcdGlmICghaGFzQXV0aCAmJiAhaXNPQXV0aCkgYnJlYWs7XG5cblx0XHRcdFx0Ly8gSWYgY3JlZGVudGlhbHMgYXJlIGluIGEgY29vbGRvd24gd2luZG93LCB3YWl0IGZvciB0aGUgZWFybGllc3Rcblx0XHRcdFx0Ly8gb25lIHRvIGV4cGlyZSByYXRoZXIgdGhhbiB1c2luZyBhIGZpeGVkIGRlbGF5IHRoYXQncyB0b28gc2hvcnQuXG5cdFx0XHRcdGNvbnN0IGJhY2tvZmZFeHBpcnkgPSBtb2RlbFJlZ2lzdHJ5LmF1dGhTdG9yYWdlLmdldEVhcmxpZXN0QmFja29mZkV4cGlyeShyZXNvbHZlZFByb3ZpZGVyKTtcblx0XHRcdFx0aWYgKGJhY2tvZmZFeHBpcnkgIT09IHVuZGVmaW5lZCkge1xuXHRcdFx0XHRcdGNvbnN0IHdhaXRNcyA9IGJhY2tvZmZFeHBpcnkgLSBEYXRlLm5vdygpICsgNTAwOyAvLyA1MDBtcyBidWZmZXJcblx0XHRcdFx0XHRpZiAod2FpdE1zID4gMCAmJiB3YWl0TXMgPD0gbWF4Q29vbGRvd25XYWl0TXMpIHtcblx0XHRcdFx0XHRcdGF3YWl0IG5ldyBQcm9taXNlKHJlc29sdmUgPT4gc2V0VGltZW91dChyZXNvbHZlLCB3YWl0TXMpKTtcblx0XHRcdFx0XHRcdGNvbnRpbnVlOyAvLyBSZXRyeSBpbW1lZGlhdGVseSBhZnRlciBjb29sZG93biBjbGVhcnNcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0aWYgKHdhaXRNcyA+IG1heENvb2xkb3duV2FpdE1zKSB7XG5cdFx0XHRcdFx0XHRicmVhazsgLy8gUXVvdGEtZXhoYXVzdGVkIG9yIHZlcnkgbG9uZyBiYWNrb2ZmIFx1MjAxNCBkb24ndCBibG9ja1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXG5cdFx0XHRcdC8vIFN0YW5kYXJkIGV4cG9uZW50aWFsIGJhY2tvZmYgZm9yIG5vbi1jb29sZG93biB0cmFuc2llbnQgZmFpbHVyZXNcblx0XHRcdFx0YXdhaXQgbmV3IFByb21pc2UocmVzb2x2ZSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIGJhc2VEZWxheU1zICogYXR0ZW1wdCkpO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBBbGwgcmV0cmllcyBleGhhdXN0ZWQgXHUyMDE0IHRocm93IGRlc2NyaXB0aXZlIGVycm9yLlxuXHRcdFx0Ly8gQ2hlY2sgaWYgY3JlZGVudGlhbHMgZXhpc3QgYnV0IGFyZSB0ZW1wb3JhcmlseSBpbiBhIGJhY2tvZmYgd2luZG93XG5cdFx0XHQvLyAoZS5nLiwgYWZ0ZXIgYSA0MjkpLiBUaGlzIG1lc3NhZ2UgaW50ZW50aW9uYWxseSBhdm9pZHMgcGhyYXNlcyBsaWtlXG5cdFx0XHQvLyBcInJhdGUgbGltaXRcIiAvIFwiNDI5XCIgdG8gcHJldmVudCBpc1JldHJ5YWJsZUVycm9yKCkgZnJvbSByZS1lbnRlcmluZ1xuXHRcdFx0Ly8gdGhlIHJldHJ5IGhhbmRsZXIgYW5kIGNyZWF0aW5nIGNhc2NhZGluZyBlcnJvciBlbnRyaWVzICgjMzQyOSkuXG5cdFx0XHRjb25zdCBoYXNBdXRoID0gbW9kZWxSZWdpc3RyeS5hdXRoU3RvcmFnZS5oYXNBdXRoKHJlc29sdmVkUHJvdmlkZXIpO1xuXHRcdFx0aWYgKGhhc0F1dGgpIHtcblx0XHRcdFx0Ly8gQW50aHJvcGljIE9BdXRoIHdhcyByZW1vdmVkIGluIHYyLjc0LjAgZm9yIFRPUyBjb21wbGlhbmNlICgjMzk1MikuXG5cdFx0XHRcdC8vIFVzZXJzIHdobyB1cGdyYWRlZCBmcm9tIGFuIG9sZGVyIHZlcnNpb24gbWF5IHN0aWxsIGhhdmUgT0F1dGhcblx0XHRcdFx0Ly8gY3JlZGVudGlhbHMgaW4gYXV0aC5qc29uIHRoYXQgd2lsbCBuZXZlciByZXNvbHZlIHRvIGEgdmFsaWQgQVBJIGtleS5cblx0XHRcdFx0aWYgKFxuXHRcdFx0XHRcdHJlc29sdmVkUHJvdmlkZXIgPT09IFwiYW50aHJvcGljXCIgJiZcblx0XHRcdFx0XHRtb2RlbFJlZ2lzdHJ5LmF1dGhTdG9yYWdlLmhhc0xlZ2FjeU9BdXRoQ3JlZGVudGlhbChyZXNvbHZlZFByb3ZpZGVyKVxuXHRcdFx0XHQpIHtcblx0XHRcdFx0XHQvLyBTZWxmLWhlYWw6IHN0cmlwIHRoZSBzdGFsZSBvYXV0aCBlbnRyeSBzbyBoYXNBdXRoKCkgc3RvcHMgbHlpbmdcblx0XHRcdFx0XHQvLyBhYm91dCBhbnRocm9waWMgYmVpbmcgY29uZmlndXJlZC4gVGhpcyBwcmVzZXJ2ZXMgYW55IGFwaV9rZXlcblx0XHRcdFx0XHQvLyBjcmVkZW50aWFscyBhbG9uZ3NpZGUgaXQuXG5cdFx0XHRcdFx0Y29uc3QgcmVtb3ZlZCA9IG1vZGVsUmVnaXN0cnkuYXV0aFN0b3JhZ2UucmVtb3ZlTGVnYWN5T0F1dGhDcmVkZW50aWFsKHJlc29sdmVkUHJvdmlkZXIpO1xuXHRcdFx0XHRcdGlmIChyZW1vdmVkKSB7XG5cdFx0XHRcdFx0XHRjb25zb2xlLndhcm4oXG5cdFx0XHRcdFx0XHRcdGBbYXV0aF0gUmVtb3ZlZCB1bnN1cHBvcnRlZCBBbnRocm9waWMgT0F1dGggY3JlZGVudGlhbCBmcm9tIGF1dGguanNvbiAoIzM5NTIpLmAsXG5cdFx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRpZiAoaXNDbGF1ZGVDb2RlQmluYXJ5SW5QYXRoKCkpIHtcblx0XHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcihcblx0XHRcdFx0XHRcdFx0YFJlbW92ZWQgc3RhbGUgQW50aHJvcGljIE9BdXRoIGNyZWRlbnRpYWwgKE9BdXRoIHN1cHBvcnQgcmVtb3ZlZCBpbiB2Mi43NC4wKS4gYCArXG5cdFx0XHRcdFx0XHRcdFx0YFlvdXIgY3VycmVudCBtb2RlbCdzIHByb3ZpZGVyIGlzIHNldCB0byBcImFudGhyb3BpY1wiIGJ1dCB0aGUgbG9jYWwgQ2xhdWRlIENvZGUgQ0xJIGAgK1xuXHRcdFx0XHRcdFx0XHRcdGBpcyBhdmFpbGFibGUgXHUyMDE0IHN3aXRjaCB0aGUgbW9kZWwncyBwcm92aWRlciB0byBcImNsYXVkZS1jb2RlXCIgaW4geW91ciBwcmVmZXJlbmNlcyBgICtcblx0XHRcdFx0XHRcdFx0XHRgdG8gdXNlIGl0LCBvciBzZXQgQU5USFJPUElDX0FQSV9LRVkgdG8gY29udGludWUgd2l0aCB0aGUgQW50aHJvcGljIEFQSSBkaXJlY3RseS5gLFxuXHRcdFx0XHRcdFx0KTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKFxuXHRcdFx0XHRcdFx0YFJlbW92ZWQgc3RhbGUgQW50aHJvcGljIE9BdXRoIGNyZWRlbnRpYWwgKE9BdXRoIHN1cHBvcnQgcmVtb3ZlZCBpbiB2Mi43NC4wKS4gYCArXG5cdFx0XHRcdFx0XHRcdGBTZXQgQU5USFJPUElDX0FQSV9LRVksIHJ1biAnL2xvZ2luJyBhbmQgcGFzdGUgYW4gQVBJIGtleSwgb3Igc3dpdGNoIHRvIGEgZGlmZmVyZW50IHByb3ZpZGVyLmAsXG5cdFx0XHRcdFx0KTtcblx0XHRcdFx0fVxuXHRcdFx0XHRjb25zdCBleHBpcnkgPSBtb2RlbFJlZ2lzdHJ5LmF1dGhTdG9yYWdlLmdldEVhcmxpZXN0QmFja29mZkV4cGlyeShyZXNvbHZlZFByb3ZpZGVyKTtcblx0XHRcdFx0Y29uc3QgcmV0cnlBZnRlck1zID0gZXhwaXJ5ICE9PSB1bmRlZmluZWQgPyBNYXRoLm1heCgwLCBleHBpcnkgLSBEYXRlLm5vdygpKSA6IHVuZGVmaW5lZDtcblx0XHRcdFx0dGhyb3cgbmV3IENyZWRlbnRpYWxDb29sZG93bkVycm9yKHJlc29sdmVkUHJvdmlkZXIsIHJldHJ5QWZ0ZXJNcyk7XG5cdFx0XHR9XG5cdFx0XHRjb25zdCBtb2RlbCA9IGFnZW50LnN0YXRlLm1vZGVsO1xuXHRcdFx0Y29uc3QgaXNPQXV0aCA9IG1vZGVsICYmIG1vZGVsUmVnaXN0cnkuaXNVc2luZ09BdXRoKG1vZGVsKTtcblx0XHRcdGlmIChpc09BdXRoKSB7XG5cdFx0XHRcdC8vIElmIGNyZWRlbnRpYWxzIGV4aXN0IGJ1dCBhcmUgYWxsIGluIGEgYmFja29mZiB3aW5kb3cgKHF1b3RhIC8gcmF0ZS1saW1pdCksXG5cdFx0XHRcdC8vIHN1cmZhY2UgYSBzcGVjaWZpYyBtZXNzYWdlIGluc3RlYWQgb2YgdGhlIG1pc2xlYWRpbmcgXCJBdXRoZW50aWNhdGlvbiBmYWlsZWRcIi5cblx0XHRcdFx0aWYgKG1vZGVsUmVnaXN0cnkuYXV0aFN0b3JhZ2UuYXJlQWxsQ3JlZGVudGlhbHNCYWNrZWRPZmYocmVzb2x2ZWRQcm92aWRlcikpIHtcblx0XHRcdFx0XHRjb25zdCBleHBpcnkgPSBtb2RlbFJlZ2lzdHJ5LmF1dGhTdG9yYWdlLmdldEVhcmxpZXN0QmFja29mZkV4cGlyeShyZXNvbHZlZFByb3ZpZGVyKTtcblx0XHRcdFx0XHRjb25zdCByZXRyeUFmdGVyTXMgPSBleHBpcnkgIT09IHVuZGVmaW5lZCA/IE1hdGgubWF4KDAsIGV4cGlyeSAtIERhdGUubm93KCkpIDogdW5kZWZpbmVkO1xuXHRcdFx0XHRcdHRocm93IG5ldyBDcmVkZW50aWFsQ29vbGRvd25FcnJvcihyZXNvbHZlZFByb3ZpZGVyLCByZXRyeUFmdGVyTXMpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihcblx0XHRcdFx0XHRgQXV0aGVudGljYXRpb24gZmFpbGVkIGZvciBcIiR7cmVzb2x2ZWRQcm92aWRlcn1cIi4gYCArXG5cdFx0XHRcdFx0XHRgQ3JlZGVudGlhbHMgbWF5IGhhdmUgZXhwaXJlZCBvciBuZXR3b3JrIGlzIHVuYXZhaWxhYmxlLiBgICtcblx0XHRcdFx0XHRcdGBSdW4gJy9sb2dpbiAke3Jlc29sdmVkUHJvdmlkZXJ9JyB0byByZS1hdXRoZW50aWNhdGUuYCxcblx0XHRcdFx0KTtcblx0XHRcdH1cblx0XHRcdHRocm93IG5ldyBFcnJvcihcblx0XHRcdFx0YE5vIEFQSSBrZXkgZm91bmQgZm9yIFwiJHtyZXNvbHZlZFByb3ZpZGVyfVwiLiBgICtcblx0XHRcdFx0XHRgU2V0IGFuIEFQSSBrZXkgZW52aXJvbm1lbnQgdmFyaWFibGUgb3IgcnVuICcvbG9naW4gJHtyZXNvbHZlZFByb3ZpZGVyfScuYCxcblx0XHRcdCk7XG5cdFx0fSxcblx0fSk7XG5cblx0Ly8gUmVzdG9yZSBtZXNzYWdlcyBpZiBzZXNzaW9uIGhhcyBleGlzdGluZyBkYXRhXG5cdGlmIChoYXNFeGlzdGluZ1Nlc3Npb24pIHtcblx0XHRhZ2VudC5yZXBsYWNlTWVzc2FnZXMoZXhpc3RpbmdTZXNzaW9uLm1lc3NhZ2VzKTtcblx0XHRpZiAoIWhhc1RoaW5raW5nRW50cnkpIHtcblx0XHRcdHNlc3Npb25NYW5hZ2VyLmFwcGVuZFRoaW5raW5nTGV2ZWxDaGFuZ2UodGhpbmtpbmdMZXZlbCk7XG5cdFx0fVxuXHR9IGVsc2Uge1xuXHRcdC8vIFNhdmUgaW5pdGlhbCBtb2RlbCBhbmQgdGhpbmtpbmcgbGV2ZWwgZm9yIG5ldyBzZXNzaW9ucyBzbyB0aGV5IGNhbiBiZSByZXN0b3JlZCBvbiByZXN1bWVcblx0XHRpZiAobW9kZWwpIHtcblx0XHRcdHNlc3Npb25NYW5hZ2VyLmFwcGVuZE1vZGVsQ2hhbmdlKG1vZGVsLnByb3ZpZGVyLCBtb2RlbC5pZCk7XG5cdFx0fVxuXHRcdHNlc3Npb25NYW5hZ2VyLmFwcGVuZFRoaW5raW5nTGV2ZWxDaGFuZ2UodGhpbmtpbmdMZXZlbCk7XG5cdH1cblxuXHRjb25zdCBzZXNzaW9uID0gbmV3IEFnZW50U2Vzc2lvbih7XG5cdFx0YWdlbnQsXG5cdFx0c2Vzc2lvbk1hbmFnZXIsXG5cdFx0c2V0dGluZ3NNYW5hZ2VyLFxuXHRcdGN3ZCxcblx0XHRzY29wZWRNb2RlbHM6IG9wdGlvbnMuc2NvcGVkTW9kZWxzLFxuXHRcdHJlc291cmNlTG9hZGVyLFxuXHRcdGN1c3RvbVRvb2xzOiBvcHRpb25zLmN1c3RvbVRvb2xzLFxuXHRcdG1vZGVsUmVnaXN0cnksXG5cdFx0aW5pdGlhbEFjdGl2ZVRvb2xOYW1lcyxcblx0XHRleHRlbnNpb25SdW5uZXJSZWYsXG5cdFx0d29ya3NwYWNlUm9vdFJlZixcblx0XHRpc0NsYXVkZUNvZGVSZWFkeTogb3B0aW9ucy5pc0NsYXVkZUNvZGVSZWFkeSxcblx0fSk7XG5cdGNvbnN0IGV4dGVuc2lvbnNSZXN1bHQgPSByZXNvdXJjZUxvYWRlci5nZXRFeHRlbnNpb25zKCk7XG5cblx0cmV0dXJuIHtcblx0XHRzZXNzaW9uLFxuXHRcdGV4dGVuc2lvbnNSZXN1bHQsXG5cdFx0bW9kZWxGYWxsYmFja01lc3NhZ2UsXG5cdH07XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFDQSxTQUFTLGtCQUFrQjtBQUMzQixTQUFTLFlBQVk7QUFRckIsU0FB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
