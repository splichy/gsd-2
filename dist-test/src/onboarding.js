import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { renderLogo } from "./logo.js";
import { agentDir } from "./app-paths.js";
import { isClaudeCliReady } from "./claude-cli-check.js";
import {
  markOnboardingComplete,
  markStepCompleted,
  markStepSkipped,
  isOnboardingComplete
} from "./resources/extensions/gsd/onboarding-state.js";
import { getLlmProviderIds } from "./resources/extensions/gsd/setup-catalog.js";
const TOOL_KEYS = [
  {
    provider: "context7",
    envVar: "CONTEXT7_API_KEY",
    label: "Context7",
    hint: "up-to-date library docs"
  },
  {
    provider: "jina",
    envVar: "JINA_API_KEY",
    label: "Jina AI",
    hint: "clean web page extraction"
  },
  {
    provider: "groq",
    envVar: "GROQ_API_KEY",
    label: "Groq",
    hint: "voice transcription \u2014 free at console.groq.com"
  }
];
const LLM_PROVIDER_IDS = Array.from(/* @__PURE__ */ new Set([
  ...getLlmProviderIds(),
  "anthropic-vertex",
  "ollama"
]));
const API_KEY_PREFIXES = {
  anthropic: ["sk-ant-"],
  openai: ["sk-"]
};
const OTHER_PROVIDERS = [
  { value: "google", label: "Google (Gemini)", hint: "aistudio.google.com/app/apikey" },
  { value: "groq", label: "Groq", hint: "console.groq.com/keys" },
  { value: "xai", label: "xAI (Grok)", hint: "console.x.ai" },
  { value: "openrouter", label: "OpenRouter", hint: "200+ models \u2014 openrouter.ai/keys" },
  { value: "mistral", label: "Mistral", hint: "console.mistral.ai/api-keys" },
  { value: "minimax", label: "MiniMax", hint: "platform.minimax.io (Anthropic-compatible recommended)" },
  { value: "minimax-cn", label: "MiniMax CN", hint: "api.minimaxi.com (Anthropic-compatible)" },
  { value: "ollama-cloud", label: "Ollama Cloud" },
  { value: "custom-openai", label: "Custom (OpenAI-compatible)", hint: "Ollama, LM Studio, vLLM, proxies \u2014 see docs/providers.md" }
];
async function loadClack() {
  try {
    return await import("@clack/prompts");
  } catch {
    throw new Error("[gsd] @clack/prompts not found \u2014 onboarding wizard requires this dependency");
  }
}
async function loadPico() {
  try {
    const { default: chalk } = await import("chalk");
    return {
      cyan: (s) => chalk.cyan(s),
      green: (s) => chalk.green(s),
      yellow: (s) => chalk.yellow(s),
      dim: (s) => chalk.dim(s),
      bold: (s) => chalk.bold(s),
      red: (s) => chalk.red(s),
      reset: (s) => chalk.reset(s)
    };
  } catch {
    const identity = (s) => s;
    return { cyan: identity, green: identity, yellow: identity, dim: identity, bold: identity, red: identity, reset: identity };
  }
}
function openBrowser(url) {
  if (process.platform === "win32") {
    execFile("powershell", ["-c", `Start-Process '${url.replace(/'/g, "''")}'`], () => {
    });
  } else {
    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    execFile(cmd, [url], () => {
    });
  }
}
function persistDefaultProvider(providerId) {
  const settingsPath = join(agentDir, "settings.json");
  try {
    const raw = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf-8")) : {};
    raw.defaultProvider = providerId;
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(raw, null, 2), "utf-8");
  } catch {
  }
}
function persistDefaultModel(modelId) {
  const settingsPath = join(agentDir, "settings.json");
  try {
    const raw = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf-8")) : {};
    raw.defaultModel = modelId;
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(raw, null, 2), "utf-8");
  } catch {
  }
}
function detectNativeProviderFromBaseUrl(baseUrl) {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    if (hostname === "api.minimax.io" || hostname.endsWith(".minimax.io")) {
      return "minimax";
    }
    if (hostname === "api.minimaxi.com" || hostname.endsWith(".minimaxi.com")) {
      return "minimax-cn";
    }
  } catch {
  }
  return null;
}
const STEP_CANCELLED = Symbol("step-cancelled");
async function runStep(p, warnLabel, fn, opts = {}) {
  try {
    return await fn();
  } catch (err) {
    if (p.isCancel(err)) {
      p.cancel(opts.cancelMessage ?? "Setup cancelled.");
      return STEP_CANCELLED;
    }
    p.log.warn(`${warnLabel}: ${err instanceof Error ? err.message : String(err)}`);
    if (opts.errorInfo) p.log.info(opts.errorInfo);
    return null;
  }
}
function shouldRunOnboarding(authStorage, settingsDefaultProvider) {
  if (!process.stdin.isTTY) return false;
  if (isOnboardingComplete()) return false;
  if (settingsDefaultProvider) return false;
  const hasLlmAuth = LLM_PROVIDER_IDS.some((id) => authStorage.hasAuth(id));
  return !hasLlmAuth;
}
async function runOnboarding(authStorage, opts = {}) {
  let p;
  let pc;
  try {
    ;
    [p, pc] = await Promise.all([loadClack(), loadPico()]);
  } catch (err) {
    process.stderr.write(`[gsd] Onboarding wizard unavailable: ${err instanceof Error ? err.message : String(err)}
`);
    return;
  }
  if (opts.showIntro !== false) {
    process.stderr.write(renderLogo(pc.cyan));
    p.intro(pc.bold("Welcome to GSD \u2014 let's get you set up"));
  }
  const completedSteps = [];
  const llmResult = await runStep(p, "LLM setup failed", () => runLlmStep(p, pc, authStorage), {
    cancelMessage: "Setup cancelled \u2014 you can run /gsd onboarding --resume later.",
    errorInfo: "You can configure your LLM provider later with /login inside GSD."
  });
  if (llmResult === STEP_CANCELLED) return;
  const llmConfigured = llmResult ?? false;
  if (llmConfigured) {
    markStepCompleted("llm");
    completedSteps.push("llm");
  } else {
    markStepSkipped("llm");
  }
  const searchResult = await runStep(
    p,
    "Web search setup failed",
    () => runWebSearchStep(p, pc, authStorage, llmConfigured)
  );
  if (searchResult === STEP_CANCELLED) return;
  const searchConfigured = searchResult;
  if (searchConfigured) {
    markStepCompleted("search");
    completedSteps.push("search");
  } else {
    markStepSkipped("search");
  }
  const remoteResult = await runStep(
    p,
    "Remote questions setup failed",
    () => runRemoteQuestionsStep(p, pc, authStorage)
  );
  if (remoteResult === STEP_CANCELLED) return;
  const remoteConfigured = remoteResult;
  if (remoteConfigured) {
    markStepCompleted("remote");
    completedSteps.push("remote");
  } else {
    markStepSkipped("remote");
  }
  const toolResult = await runStep(
    p,
    "Tool key setup failed",
    () => runToolKeysStep(p, pc, authStorage)
  );
  if (toolResult === STEP_CANCELLED) return;
  const toolKeyCount = toolResult ?? 0;
  if (toolKeyCount > 0) {
    markStepCompleted("tool-keys");
    completedSteps.push("tool-keys");
  } else {
    markStepSkipped("tool-keys");
  }
  const summaryLines = [];
  if (llmConfigured) {
    const authed = authStorage.list().filter((id) => LLM_PROVIDER_IDS.includes(id));
    if (authed.length > 0) {
      const name = authed[0];
      summaryLines.push(`${pc.green("\u2713")} LLM provider: ${name}`);
    } else {
      summaryLines.push(`${pc.green("\u2713")} LLM provider configured`);
    }
  } else {
    summaryLines.push(`${pc.yellow("\u21B7")} LLM provider: skipped \u2014 use /login inside GSD`);
  }
  if (searchConfigured) {
    summaryLines.push(`${pc.green("\u2713")} Web search: ${searchConfigured}`);
  } else {
    summaryLines.push(`${pc.dim("\u21B7")} Web search: not configured \u2014 use /search-provider inside GSD`);
  }
  if (remoteConfigured) {
    summaryLines.push(`${pc.green("\u2713")} Remote questions: ${remoteConfigured}`);
  } else {
    summaryLines.push(`${pc.dim("\u21B7")} Remote questions: not configured \u2014 use /gsd remote inside GSD`);
  }
  if (toolKeyCount > 0) {
    summaryLines.push(`${pc.green("\u2713")} ${toolKeyCount} tool key${toolKeyCount > 1 ? "s" : ""} saved`);
  } else {
    summaryLines.push(`${pc.dim("\u21B7")} Tool keys: none configured`);
  }
  markOnboardingComplete(completedSteps);
  summaryLines.push("");
  summaryLines.push(`${pc.dim("Tip:")} re-run anytime with ${pc.cyan("/gsd onboarding")}`);
  p.note(summaryLines.join("\n"), "Setup complete");
  p.outro(pc.dim("Launching GSD..."));
}
async function runLlmStep(p, pc, authStorage) {
  const oauthProviders = authStorage.getOAuthProviders();
  const oauthMap = new Map(oauthProviders.map((op) => [op.id, op]));
  const existingAuth = LLM_PROVIDER_IDS.find((id) => authStorage.hasAuth(id));
  const authOptions = [];
  if (existingAuth) {
    authOptions.push({ value: "keep", label: `Keep current (${existingAuth})`, hint: "already configured" });
  }
  if (isClaudeCliReady()) {
    authOptions.push(
      { value: "claude-cli", label: "Use Claude Code CLI", hint: "recommended \u2014 uses your existing Claude subscription" }
    );
  }
  authOptions.push(
    { value: "browser", label: "Sign in with your browser", hint: "GitHub Copilot, ChatGPT, Google, etc." },
    { value: "api-key", label: "Paste an API key", hint: "from your provider dashboard" },
    { value: "skip", label: "Skip for now", hint: "use /login inside GSD later" }
  );
  const method = await p.select({
    message: existingAuth ? `LLM provider: ${existingAuth} \u2014 change it?` : "How do you want to sign in?",
    options: authOptions
  });
  if (p.isCancel(method) || method === "skip") return false;
  if (method === "keep") return true;
  if (method === "claude-cli") {
    p.log.success("Claude Code CLI detected \u2014 routing through local CLI (TOS-compliant)");
    p.log.info("Your Claude subscription will be used for inference. No API key needed.");
    authStorage.set("claude-code", { type: "api_key", key: "cli" });
    persistDefaultProvider("claude-code");
    return true;
  }
  if (method === "browser") {
    const provider = await p.select({
      message: "Choose provider",
      options: [
        { value: "github-copilot", label: "GitHub Copilot" },
        { value: "openai-codex", label: "ChatGPT Plus/Pro (Codex)" },
        { value: "google-gemini-cli", label: "Google Gemini CLI" },
        { value: "google-antigravity", label: "Antigravity (Gemini 3, Claude, GPT-OSS)" }
      ]
    });
    if (p.isCancel(provider)) return false;
    return await runOAuthFlow(p, pc, authStorage, provider, oauthMap);
  }
  if (method === "api-key") {
    const provider = await p.select({
      message: "Choose provider",
      options: [
        { value: "anthropic", label: "Anthropic (Claude)" },
        { value: "openai", label: "OpenAI" },
        ...OTHER_PROVIDERS.map((op) => ({ value: op.value, label: op.label }))
      ]
    });
    if (p.isCancel(provider)) return false;
    if (provider === "custom-openai") {
      return await runCustomOpenAIFlow(p, pc, authStorage);
    }
    if (provider === "ollama") {
      return await runOllamaLocalFlow(p, pc, authStorage);
    }
    const label = provider === "anthropic" ? "Anthropic" : provider === "openai" ? "OpenAI" : OTHER_PROVIDERS.find((op) => op.value === provider)?.label ?? String(provider);
    return await runApiKeyFlow(p, pc, authStorage, provider, label);
  }
  return false;
}
async function runOAuthFlow(p, pc, authStorage, providerId, oauthMap) {
  const providerInfo = oauthMap.get(providerId);
  const providerName = providerInfo?.name ?? providerId;
  const usesCallbackServer = providerInfo?.usesCallbackServer ?? false;
  const s = p.spinner();
  s.start(`Authenticating with ${providerName}...`);
  try {
    const loginCallbacks = {
      onAuth: (info) => {
        s.stop(`Opening browser for ${providerName}`);
        openBrowser(info.url);
        p.log.info(`${pc.dim("URL:")} ${pc.cyan(info.url)}`);
        if (info.instructions) {
          p.log.info(pc.yellow(info.instructions));
        }
      },
      onPrompt: async (prompt) => {
        const result = await p.text({
          message: prompt.message,
          placeholder: prompt.placeholder
        });
        if (p.isCancel(result)) return "";
        return result;
      },
      onProgress: (message) => {
        p.log.step(pc.dim(message));
      },
      onManualCodeInput: usesCallbackServer ? async () => {
        const result = await p.text({
          message: "Paste the redirect URL from your browser:",
          placeholder: "http://localhost:..."
        });
        if (p.isCancel(result)) return "";
        return result;
      } : void 0
    };
    await authStorage.login(providerId, loginCallbacks);
    persistDefaultProvider(providerId);
    p.log.success(`Authenticated with ${pc.green(providerName)}`);
    return true;
  } catch (err) {
    s.stop(`${providerName} authentication failed`);
    const errorMsg = err instanceof Error ? err.message : String(err);
    p.log.warn(`OAuth error: ${errorMsg}`);
    const retry = await p.select({
      message: "What would you like to do?",
      options: [
        { value: "retry", label: "Try again" },
        { value: "skip", label: "Skip \u2014 configure later with /login" }
      ]
    });
    if (p.isCancel(retry) || retry === "skip") return false;
    return runOAuthFlow(p, pc, authStorage, providerId, oauthMap);
  }
}
async function runApiKeyFlow(p, pc, authStorage, providerId, providerLabel) {
  const key = await p.password({
    message: `Paste your ${providerLabel} API key:`,
    mask: "\u25CF"
  });
  if (p.isCancel(key) || !key) return false;
  const trimmed = key.trim();
  if (!trimmed) return false;
  const expectedPrefixes = API_KEY_PREFIXES[providerId];
  if (expectedPrefixes && !expectedPrefixes.some((pfx) => trimmed.startsWith(pfx))) {
    p.log.warn(`Key doesn't start with expected prefix (${expectedPrefixes.join(" or ")}). Saving anyway.`);
  }
  authStorage.set(providerId, { type: "api_key", key: trimmed });
  persistDefaultProvider(providerId);
  p.log.success(`API key saved for ${pc.green(providerLabel)}`);
  if (providerId === "openrouter") {
    p.log.info(`Use ${pc.cyan("/model")} inside GSD to pick an OpenRouter model.`);
    p.log.info(`To add custom models or control routing, see ${pc.dim("docs/providers.md#openrouter")}`);
  }
  return true;
}
async function runOllamaLocalFlow(p, pc, authStorage) {
  const host = process.env.OLLAMA_HOST || "http://localhost:11434";
  const s = p.spinner();
  s.start(`Checking Ollama at ${host}...`);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3e3);
    const response = await fetch(host, { signal: controller.signal });
    clearTimeout(timeout);
    if (response.ok) {
      s.stop(`Ollama is running at ${pc.green(host)}`);
      authStorage.set("ollama", { type: "api_key", key: "ollama" });
      persistDefaultProvider("ollama");
      p.log.success(`${pc.green("Ollama (Local)")} configured \u2014 no API key needed`);
      p.log.info(pc.dim("Models are discovered automatically from your local Ollama instance."));
      return true;
    } else {
      s.stop("Ollama check failed");
      p.log.warn(`Ollama responded with status ${response.status} at ${host}`);
    }
  } catch {
    s.stop("Ollama not detected");
    p.log.warn(`Could not reach Ollama at ${host}`);
    p.log.info(pc.dim('Install Ollama from https://ollama.com and run "ollama serve"'));
    p.log.info(pc.dim("Set OLLAMA_HOST if using a non-default address."));
  }
  const proceed = await p.confirm({
    message: "Save Ollama as your provider anyway? (it will auto-detect when running)"
  });
  if (p.isCancel(proceed) || !proceed) return false;
  authStorage.set("ollama", { type: "api_key", key: "ollama" });
  persistDefaultProvider("ollama");
  p.log.success(`${pc.green("Ollama (Local)")} saved \u2014 models will appear when Ollama is running`);
  return true;
}
async function runCustomOpenAIFlow(p, pc, authStorage) {
  p.log.info(pc.dim("Common endpoints:\n  Ollama:     http://localhost:11434/v1\n  LM Studio:  http://localhost:1234/v1\n  vLLM:       http://localhost:8000/v1"));
  const baseUrl = await p.text({
    message: "Base URL of your OpenAI-compatible endpoint:",
    placeholder: "http://localhost:11434/v1",
    validate: (val) => {
      const trimmed = val?.trim();
      if (!trimmed) return "Base URL is required";
      try {
        new URL(trimmed);
      } catch {
        return "Must be a valid URL (e.g. https://my-proxy.example.com/v1)";
      }
    }
  });
  if (p.isCancel(baseUrl) || !baseUrl) return false;
  const trimmedUrl = baseUrl.trim();
  const apiKey = await p.password({
    message: "API key for this endpoint:",
    mask: "\u25CF"
  });
  if (p.isCancel(apiKey) || !apiKey) return false;
  const trimmedKey = apiKey.trim();
  if (!trimmedKey) return false;
  const modelId = await p.text({
    message: "Model ID to use:",
    placeholder: "gpt-4o",
    validate: (val) => {
      if (!val?.trim()) return "Model ID is required";
    }
  });
  if (p.isCancel(modelId) || !modelId) return false;
  const trimmedModelId = modelId.trim();
  const nativeProvider = detectNativeProviderFromBaseUrl(trimmedUrl);
  if (nativeProvider) {
    const envVar = nativeProvider === "minimax" ? "MINIMAX_API_KEY" : "MINIMAX_CN_API_KEY";
    authStorage.set(nativeProvider, { type: "api_key", key: trimmedKey });
    persistDefaultProvider(nativeProvider);
    persistDefaultModel(trimmedModelId);
    process.env[envVar] = trimmedKey;
    p.log.success(`${pc.green("MiniMax")} detected \u2014 configured as native provider (${pc.cyan(nativeProvider)})`);
    p.log.info(`Model: ${pc.cyan(trimmedModelId)}`);
    p.log.info(pc.dim("Using Anthropic-compatible MiniMax integration for full model metadata and clean thinking output."));
    return true;
  }
  authStorage.set("custom-openai", { type: "api_key", key: trimmedKey });
  persistDefaultProvider("custom-openai");
  persistDefaultModel(trimmedModelId);
  const modelsJsonPath = join(agentDir, "models.json");
  let config = { providers: {} };
  if (existsSync(modelsJsonPath)) {
    try {
      config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"));
      if (!config.providers) config.providers = {};
    } catch {
      config = { providers: {} };
    }
  }
  config.providers["custom-openai"] = {
    baseUrl: trimmedUrl,
    apiKey: `env:CUSTOM_OPENAI_API_KEY`,
    api: "openai-completions",
    models: [
      {
        id: trimmedModelId,
        name: trimmedModelId,
        reasoning: false,
        input: ["text"],
        contextWindow: 128e3,
        maxTokens: 16384,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      }
    ]
  };
  const dir = dirname(modelsJsonPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(modelsJsonPath, JSON.stringify(config, null, 2), "utf-8");
  process.env.CUSTOM_OPENAI_API_KEY = trimmedKey;
  p.log.success(`Custom endpoint saved: ${pc.green(trimmedUrl)}`);
  p.log.info(`Model: ${pc.cyan(trimmedModelId)}`);
  p.log.info(`Config written to ${pc.dim(modelsJsonPath)}`);
  p.log.info(`If you get role or streaming errors, add compat settings to models.json.`);
  p.log.info(`See ${pc.dim("docs/providers.md#common-pitfalls")} for details.`);
  return true;
}
async function runWebSearchStep(p, pc, authStorage, isAnthropicAuth) {
  const authed = authStorage.list().filter((id) => LLM_PROVIDER_IDS.includes(id));
  const isAnthropic = isAnthropicAuth && authed.includes("anthropic");
  const hasBrave = !!process.env.BRAVE_API_KEY || authStorage.has("brave");
  const hasTavily = !!process.env.TAVILY_API_KEY || authStorage.has("tavily");
  const existingSearch = hasBrave ? "Brave Search" : hasTavily ? "Tavily" : null;
  const options = [];
  if (existingSearch) {
    options.push({ value: "keep", label: `Keep current (${existingSearch})`, hint: "already configured" });
  }
  if (isAnthropic) {
    options.push({
      value: "anthropic-native",
      label: "Anthropic built-in web search",
      hint: "no API key needed \u2014 already included with Claude"
    });
  }
  options.push(
    { value: "brave", label: "Brave Search", hint: "requires API key \u2014 brave.com/search/api" },
    { value: "tavily", label: "Tavily", hint: "requires API key \u2014 tavily.com" },
    { value: "skip", label: "Skip for now", hint: "use /search-provider inside GSD later" }
  );
  const choice = await p.select({
    message: "How do you want to search the web?",
    options
  });
  if (p.isCancel(choice) || choice === "skip") return null;
  if (choice === "keep") return existingSearch;
  if (choice === "anthropic-native") {
    p.log.success(`Web search: ${pc.green("Anthropic built-in")} \u2014 works out of the box`);
    return "Anthropic built-in";
  }
  if (choice === "brave") {
    const key = await p.password({
      message: `Paste your Brave Search API key ${pc.dim("(brave.com/search/api)")}:`,
      mask: "\u25CF"
    });
    if (p.isCancel(key) || !key?.trim()) return null;
    const trimmed = key.trim();
    authStorage.set("brave", { type: "api_key", key: trimmed });
    process.env.BRAVE_API_KEY = trimmed;
    p.log.success(`Web search: ${pc.green("Brave Search")} configured`);
    return "Brave Search";
  }
  if (choice === "tavily") {
    const key = await p.password({
      message: `Paste your Tavily API key ${pc.dim("(tavily.com)")}:`,
      mask: "\u25CF"
    });
    if (p.isCancel(key) || !key?.trim()) return null;
    const trimmed = key.trim();
    authStorage.set("tavily", { type: "api_key", key: trimmed });
    process.env.TAVILY_API_KEY = trimmed;
    p.log.success(`Web search: ${pc.green("Tavily")} configured`);
    return "Tavily";
  }
  return null;
}
async function runToolKeysStep(p, pc, authStorage) {
  const missing = TOOL_KEYS.filter((tk) => !authStorage.has(tk.provider) && !process.env[tk.envVar]);
  if (missing.length === 0) return 0;
  const wantToolKeys = await p.confirm({
    message: "Set up optional tool API keys? (web search, docs, etc.)",
    initialValue: false
  });
  if (p.isCancel(wantToolKeys) || !wantToolKeys) return 0;
  let savedCount = 0;
  for (const tk of missing) {
    const key = await p.password({
      message: `${tk.label} ${pc.dim(`(${tk.hint})`)} \u2014 Enter to skip:`,
      mask: "\u25CF"
    });
    if (p.isCancel(key)) break;
    const trimmed = key?.trim();
    if (trimmed) {
      authStorage.set(tk.provider, { type: "api_key", key: trimmed });
      process.env[tk.envVar] = trimmed;
      p.log.success(`${tk.label} saved`);
      savedCount++;
    } else {
      authStorage.set(tk.provider, { type: "api_key", key: "" });
      p.log.info(pc.dim(`${tk.label} skipped`));
    }
  }
  return savedCount;
}
async function runRemoteQuestionsStep(p, pc, authStorage) {
  const hasValidKey = (provider) => authStorage.getCredentialsForProvider(provider).some((c) => c.type === "api_key" && typeof c.key === "string" && c.key.length > 0);
  const hasDiscord = hasValidKey("discord_bot");
  const hasSlack = hasValidKey("slack_bot");
  const hasTelegram = hasValidKey("telegram_bot");
  const existingChannel = hasDiscord ? "Discord" : hasSlack ? "Slack" : hasTelegram ? "Telegram" : null;
  const options = [];
  if (existingChannel) {
    options.push({ value: "keep", label: `Keep current (${existingChannel})`, hint: "already configured" });
  }
  options.push(
    { value: "discord", label: "Discord", hint: "receive questions in a Discord channel" },
    { value: "slack", label: "Slack", hint: "receive questions in a Slack channel" },
    { value: "telegram", label: "Telegram", hint: "receive questions via Telegram bot" },
    { value: "skip", label: "Skip for now", hint: "use /gsd remote inside GSD later" }
  );
  const choice = await p.select({
    message: "Set up remote questions? (get notified when GSD needs input)",
    options
  });
  if (p.isCancel(choice) || choice === "skip") return null;
  if (choice === "keep") return existingChannel;
  if (choice === "discord") {
    const token = await p.password({
      message: "Paste your Discord bot token:",
      mask: "\u25CF"
    });
    if (p.isCancel(token) || !token?.trim()) return null;
    const trimmed = token.trim();
    authStorage.set("discord_bot", { type: "api_key", key: trimmed });
    process.env.DISCORD_BOT_TOKEN = trimmed;
    const channelName = await runDiscordChannelStep(p, pc, trimmed);
    return channelName ? `Discord #${channelName}` : "Discord";
  }
  if (choice === "slack") {
    const token = await p.password({
      message: `Paste your Slack bot token ${pc.dim("(xoxb-...)")}:`,
      mask: "\u25CF"
    });
    if (p.isCancel(token) || !token?.trim()) return null;
    const trimmed = token.trim();
    if (!trimmed.startsWith("xoxb-")) {
      p.log.warn("Invalid token format \u2014 Slack bot tokens start with xoxb-.");
      return null;
    }
    const s = p.spinner();
    s.start("Validating Slack token...");
    try {
      const res = await fetch("https://slack.com/api/auth.test", {
        headers: { Authorization: `Bearer ${trimmed}` },
        signal: AbortSignal.timeout(15e3)
      });
      const data = await res.json();
      if (!data?.ok) {
        s.stop("Slack token validation failed");
        return null;
      }
      s.stop(`Slack authenticated as ${pc.green(data.user ?? "bot")}`);
    } catch {
      s.stop("Could not reach Slack API");
      return null;
    }
    authStorage.set("slack_bot", { type: "api_key", key: trimmed });
    process.env.SLACK_BOT_TOKEN = trimmed;
    const channelId = await p.text({
      message: "Paste the Slack channel ID (e.g. C0123456789):",
      validate: (val) => {
        if (!val || !/^[A-Z0-9]{9,12}$/.test(val.trim())) return "Expected 9-12 uppercase alphanumeric characters";
      }
    });
    if (p.isCancel(channelId) || !channelId) return null;
    const { saveRemoteQuestionsConfig } = await import("./remote-questions-config.js");
    saveRemoteQuestionsConfig("slack", channelId.trim());
    p.log.success(`Slack channel: ${pc.green(channelId.trim())}`);
    return "Slack";
  }
  if (choice === "telegram") {
    const token = await p.password({
      message: "Paste your Telegram bot token (from @BotFather):",
      mask: "\u25CF"
    });
    if (p.isCancel(token) || !token?.trim()) return null;
    const trimmed = token.trim();
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(trimmed)) {
      p.log.warn("Invalid token format \u2014 Telegram bot tokens look like 123456789:ABCdefGHI...");
      return null;
    }
    const s = p.spinner();
    s.start("Validating Telegram bot token...");
    try {
      const res = await fetch(`https://api.telegram.org/bot${trimmed}/getMe`, {
        signal: AbortSignal.timeout(15e3)
      });
      const data = await res.json();
      if (!data?.ok || !data?.result?.id) {
        s.stop("Telegram token validation failed");
        return null;
      }
      s.stop(`Telegram bot: ${pc.green(data.result.first_name ?? data.result.username ?? "bot")}`);
    } catch {
      s.stop("Could not reach Telegram API");
      return null;
    }
    authStorage.set("telegram_bot", { type: "api_key", key: trimmed });
    process.env.TELEGRAM_BOT_TOKEN = trimmed;
    const chatId = await p.text({
      message: "Paste the Telegram chat ID (e.g. -1001234567890):",
      validate: (val) => {
        if (!val || !/^-?\d{5,20}$/.test(val.trim())) return "Expected a numeric chat ID (can be negative for groups)";
      }
    });
    if (p.isCancel(chatId) || !chatId) return null;
    const trimmedChatId = chatId.trim();
    const ts = p.spinner();
    ts.start("Testing message delivery...");
    try {
      const res = await fetch(`https://api.telegram.org/bot${trimmed}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: trimmedChatId, text: "GSD remote questions connected." }),
        signal: AbortSignal.timeout(15e3)
      });
      const data = await res.json();
      if (!data?.ok) {
        ts.stop(`Could not send to chat: ${data?.description ?? "unknown error"}`);
        return null;
      }
      ts.stop("Test message sent");
    } catch {
      ts.stop("Could not reach Telegram API");
      return null;
    }
    const { saveRemoteQuestionsConfig } = await import("./remote-questions-config.js");
    saveRemoteQuestionsConfig("telegram", trimmedChatId);
    p.log.success(`Telegram chat: ${pc.green(trimmedChatId)}`);
    return "Telegram";
  }
  return null;
}
async function runDiscordChannelStep(p, pc, token) {
  const headers = { Authorization: `Bot ${token}` };
  const s = p.spinner();
  s.start("Validating Discord bot token...");
  let auth;
  try {
    const res = await fetch("https://discord.com/api/v10/users/@me", { headers, signal: AbortSignal.timeout(15e3) });
    auth = await res.json();
  } catch {
    s.stop("Could not reach Discord API");
    return null;
  }
  if (!auth?.id) {
    s.stop("Discord token validation failed");
    return null;
  }
  s.stop(`Bot authenticated as ${pc.green(auth.username ?? "unknown")}`);
  let guilds;
  try {
    const res = await fetch("https://discord.com/api/v10/users/@me/guilds", { headers, signal: AbortSignal.timeout(15e3) });
    const data = await res.json();
    guilds = Array.isArray(data) ? data : [];
  } catch {
    p.log.warn("Could not fetch Discord servers \u2014 configure channel later with /gsd remote discord");
    return null;
  }
  if (guilds.length === 0) {
    p.log.warn("Bot is not in any Discord servers \u2014 configure channel later with /gsd remote discord");
    return null;
  }
  let guildId;
  let guildName;
  if (guilds.length === 1) {
    guildId = guilds[0].id;
    guildName = guilds[0].name;
    p.log.info(`Server: ${pc.green(guildName)}`);
  } else {
    const choice = await p.select({
      message: "Which Discord server?",
      options: guilds.map((g) => ({ value: g.id, label: g.name }))
    });
    if (p.isCancel(choice)) return null;
    guildId = choice;
    guildName = guilds.find((g) => g.id === guildId)?.name ?? guildId;
  }
  let channels;
  try {
    const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, { headers, signal: AbortSignal.timeout(15e3) });
    const data = await res.json();
    channels = Array.isArray(data) ? data.filter(
      (ch) => typeof ch === "object" && ch !== null && typeof ch.id === "string" && typeof ch.name === "string" && (ch.type === 0 || ch.type === 5)
    ) : [];
  } catch {
    p.log.warn("Could not fetch channels \u2014 configure later with /gsd remote discord");
    return null;
  }
  if (channels.length === 0) {
    p.log.warn("No text channels found \u2014 configure later with /gsd remote discord");
    return null;
  }
  const MANUAL_VALUE = "__manual__";
  const channelChoice = await p.select({
    message: "Which channel should GSD use for remote questions?",
    options: [
      ...channels.map((ch) => ({ value: ch.id, label: `#${ch.name}` })),
      { value: MANUAL_VALUE, label: "Enter channel ID manually" }
    ]
  });
  if (p.isCancel(channelChoice)) return null;
  let channelId;
  if (channelChoice === MANUAL_VALUE) {
    const manualId = await p.text({
      message: "Paste the Discord channel ID:",
      placeholder: "1234567890123456789",
      validate: (val) => {
        if (!val || !/^\d{17,20}$/.test(val.trim())) return "Expected 17-20 digit numeric ID";
      }
    });
    if (p.isCancel(manualId) || !manualId) return null;
    channelId = manualId.trim();
  } else {
    channelId = channelChoice;
  }
  const { saveRemoteQuestionsConfig } = await import("./remote-questions-config.js");
  saveRemoteQuestionsConfig("discord", channelId);
  const channelName = channels.find((ch) => ch.id === channelId)?.name;
  p.log.success(`Discord channel: ${pc.green(channelName ? `#${channelName}` : channelId)}`);
  return channelName ?? null;
}
export {
  OTHER_PROVIDERS,
  detectNativeProviderFromBaseUrl,
  runLlmStep,
  runOnboarding,
  runRemoteQuestionsStep,
  runToolKeysStep,
  runWebSearchStep,
  shouldRunOnboarding
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL29uYm9hcmRpbmcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogVW5pZmllZCBmaXJzdC1ydW4gb25ib2FyZGluZyB3aXphcmQuXG4gKlxuICogUmVwbGFjZXMgdGhlIHJhdyBBUEkta2V5LW9ubHkgd2l6YXJkIHdpdGggYSBicmFuZGVkLCBjbGFjay1iYXNlZCBleHBlcmllbmNlXG4gKiB0aGF0IGd1aWRlcyB1c2VycyB0aHJvdWdoIExMTSBwcm92aWRlciBhdXRoZW50aWNhdGlvbiBiZWZvcmUgdGhlIFRVSSBsYXVuY2hlcy5cbiAqXG4gKiBGbG93OiBsb2dvIC0+IGNob29zZSBMTE0gcHJvdmlkZXIgLT4gYXV0aGVudGljYXRlIChPQXV0aCBvciBBUEkga2V5KSAtPlxuICogICAgICAgb3B0aW9uYWwgdG9vbCBrZXlzIC0+IHN1bW1hcnkgLT4gVFVJIGxhdW5jaGVzLlxuICpcbiAqIEFsbCBzdGVwcyBhcmUgc2tpcHBhYmxlLiBBbGwgZXJyb3JzIGFyZSByZWNvdmVyYWJsZS4gTmV2ZXIgY3Jhc2hlcyBib290LlxuICovXG5cbmltcG9ydCB7IGV4ZWNGaWxlIH0gZnJvbSAnbm9kZTpjaGlsZF9wcm9jZXNzJ1xuaW1wb3J0IHsgZXhpc3RzU3luYywgbWtkaXJTeW5jLCByZWFkRmlsZVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tICdub2RlOmZzJ1xuaW1wb3J0IHsgZGlybmFtZSwgam9pbiB9IGZyb20gJ25vZGU6cGF0aCdcbmltcG9ydCB0eXBlIHsgQXV0aFN0b3JhZ2UgfSBmcm9tICdAZ3NkL3BpLWNvZGluZy1hZ2VudCdcbmltcG9ydCB7IHJlbmRlckxvZ28gfSBmcm9tICcuL2xvZ28uanMnXG5pbXBvcnQgeyBhZ2VudERpciB9IGZyb20gJy4vYXBwLXBhdGhzLmpzJ1xuaW1wb3J0IHsgaXNDbGF1ZGVDbGlSZWFkeSB9IGZyb20gJy4vY2xhdWRlLWNsaS1jaGVjay5qcydcbmltcG9ydCB7XG4gIG1hcmtPbmJvYXJkaW5nQ29tcGxldGUsXG4gIG1hcmtTdGVwQ29tcGxldGVkLFxuICBtYXJrU3RlcFNraXBwZWQsXG4gIGlzT25ib2FyZGluZ0NvbXBsZXRlLFxufSBmcm9tICcuL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9vbmJvYXJkaW5nLXN0YXRlLmpzJ1xuaW1wb3J0IHsgZ2V0TGxtUHJvdmlkZXJJZHMgfSBmcm9tICcuL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9zZXR1cC1jYXRhbG9nLmpzJ1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVHlwZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmludGVyZmFjZSBUb29sS2V5Q29uZmlnIHtcbiAgcHJvdmlkZXI6IHN0cmluZ1xuICBlbnZWYXI6IHN0cmluZ1xuICBsYWJlbDogc3RyaW5nXG4gIGhpbnQ6IHN0cmluZ1xufVxuXG50eXBlIEFwaUtleUNyZWRlbnRpYWwgPSB7IHR5cGU/OiBzdHJpbmc7IGtleT86IHN0cmluZyB9XG50eXBlIExvZ2luUHJvdmlkZXJJZCA9IFBhcmFtZXRlcnM8QXV0aFN0b3JhZ2VbXCJsb2dpblwiXT5bMF1cbnR5cGUgTG9naW5DYWxsYmFja3MgPSBQYXJhbWV0ZXJzPEF1dGhTdG9yYWdlW1wibG9naW5cIl0+WzFdXG50eXBlIFNsYWNrQXV0aFRlc3RSZXNwb25zZSA9IHsgb2s/OiBib29sZWFuOyB1c2VyPzogc3RyaW5nIH1cbnR5cGUgVGVsZWdyYW1HZXRNZVJlc3BvbnNlID0ge1xuICBvaz86IGJvb2xlYW5cbiAgcmVzdWx0PzogeyBpZD86IHN0cmluZyB8IG51bWJlcjsgZmlyc3RfbmFtZT86IHN0cmluZzsgdXNlcm5hbWU/OiBzdHJpbmcgfVxuICBkZXNjcmlwdGlvbj86IHN0cmluZ1xufVxudHlwZSBEaXNjb3JkVXNlclJlc3BvbnNlID0geyBpZD86IHN0cmluZzsgdXNlcm5hbWU/OiBzdHJpbmcgfVxudHlwZSBEaXNjb3JkQ2hhbm5lbCA9IHsgaWQ6IHN0cmluZzsgbmFtZTogc3RyaW5nOyB0eXBlOiBudW1iZXIgfVxuXG50eXBlIENsYWNrTW9kdWxlID0gdHlwZW9mIGltcG9ydCgnQGNsYWNrL3Byb21wdHMnKVxudHlwZSBQaWNvTW9kdWxlID0ge1xuICBjeWFuOiAoczogc3RyaW5nKSA9PiBzdHJpbmdcbiAgZ3JlZW46IChzOiBzdHJpbmcpID0+IHN0cmluZ1xuICB5ZWxsb3c6IChzOiBzdHJpbmcpID0+IHN0cmluZ1xuICBkaW06IChzOiBzdHJpbmcpID0+IHN0cmluZ1xuICBib2xkOiAoczogc3RyaW5nKSA9PiBzdHJpbmdcbiAgcmVkOiAoczogc3RyaW5nKSA9PiBzdHJpbmdcbiAgcmVzZXQ6IChzOiBzdHJpbmcpID0+IHN0cmluZ1xufVxuXG5pbnRlcmZhY2UgUnVuT25ib2FyZGluZ09wdGlvbnMge1xuICAvKiogU2hvdyBsb2dvICsgaW50cm8gYmFubmVyLiBEaXNhYmxlIHdoZW4gb25ib2FyZGluZyBpcyBsYXVuY2hlZCBpbnNpZGUgYW4gYWN0aXZlIFRVSSBzZXNzaW9uLiAqL1xuICBzaG93SW50cm8/OiBib29sZWFuXG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBDb25zdGFudHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmNvbnN0IFRPT0xfS0VZUzogVG9vbEtleUNvbmZpZ1tdID0gW1xuICB7XG4gICAgcHJvdmlkZXI6ICdjb250ZXh0NycsXG4gICAgZW52VmFyOiAnQ09OVEVYVDdfQVBJX0tFWScsXG4gICAgbGFiZWw6ICdDb250ZXh0NycsXG4gICAgaGludDogJ3VwLXRvLWRhdGUgbGlicmFyeSBkb2NzJyxcbiAgfSxcbiAge1xuICAgIHByb3ZpZGVyOiAnamluYScsXG4gICAgZW52VmFyOiAnSklOQV9BUElfS0VZJyxcbiAgICBsYWJlbDogJ0ppbmEgQUknLFxuICAgIGhpbnQ6ICdjbGVhbiB3ZWIgcGFnZSBleHRyYWN0aW9uJyxcbiAgfSxcbiAge1xuICAgIHByb3ZpZGVyOiAnZ3JvcScsXG4gICAgZW52VmFyOiAnR1JPUV9BUElfS0VZJyxcbiAgICBsYWJlbDogJ0dyb3EnLFxuICAgIGhpbnQ6ICd2b2ljZSB0cmFuc2NyaXB0aW9uIFx1MjAxNCBmcmVlIGF0IGNvbnNvbGUuZ3JvcS5jb20nLFxuICB9LFxuXVxuXG4vKipcbiAqIEtub3duIExMTSBwcm92aWRlciBJRHMgdGhhdCwgaWYgYXV0aGVkLCBtZWFuIHRoZSB1c2VyIGRvZXNuJ3QgbmVlZCBvbmJvYXJkaW5nLlxuICogU291cmNlZCBmcm9tIHRoZSBzaGFyZWQgc2V0dXAtY2F0YWxvZyBzbyBhZGRpbmcgYSBwcm92aWRlciBsYW5kcyBpbiBvbmUgcGxhY2UuXG4gKiAnYW50aHJvcGljLXZlcnRleCcgYW5kICdvbGxhbWEnIGFyZW4ndCBpbiBQUk9WSURFUl9SRUdJU1RSWSBidXQgYXJlIHN0aWxsXG4gKiB0cmVhdGVkIGFzIFwiYXV0aGVkID0gbm8gb25ib2FyZGluZyBuZWVkZWRcIiBmb3IgYmFjay1jb21wYXQuXG4gKi9cbmNvbnN0IExMTV9QUk9WSURFUl9JRFMgPSBBcnJheS5mcm9tKG5ldyBTZXQoW1xuICAuLi5nZXRMbG1Qcm92aWRlcklkcygpLFxuICAnYW50aHJvcGljLXZlcnRleCcsXG4gICdvbGxhbWEnLFxuXSkpXG5cbi8qKiBBUEkga2V5IHByZWZpeCB2YWxpZGF0aW9uIFx1MjAxNCBsb29zZSBjaGVja3MgdG8gY2F0Y2ggb2J2aW91cyBtaXN0YWtlcyAqL1xuY29uc3QgQVBJX0tFWV9QUkVGSVhFUzogUmVjb3JkPHN0cmluZywgc3RyaW5nW10+ID0ge1xuICBhbnRocm9waWM6IFsnc2stYW50LSddLFxuICBvcGVuYWk6IFsnc2stJ10sXG59XG5cbmV4cG9ydCBjb25zdCBPVEhFUl9QUk9WSURFUlMgPSBbXG4gIHsgdmFsdWU6ICdnb29nbGUnLCBsYWJlbDogJ0dvb2dsZSAoR2VtaW5pKScsIGhpbnQ6ICdhaXN0dWRpby5nb29nbGUuY29tL2FwcC9hcGlrZXknIH0sXG4gIHsgdmFsdWU6ICdncm9xJywgbGFiZWw6ICdHcm9xJywgaGludDogJ2NvbnNvbGUuZ3JvcS5jb20va2V5cycgfSxcbiAgeyB2YWx1ZTogJ3hhaScsIGxhYmVsOiAneEFJIChHcm9rKScsIGhpbnQ6ICdjb25zb2xlLnguYWknIH0sXG4gIHsgdmFsdWU6ICdvcGVucm91dGVyJywgbGFiZWw6ICdPcGVuUm91dGVyJywgaGludDogJzIwMCsgbW9kZWxzIFx1MjAxNCBvcGVucm91dGVyLmFpL2tleXMnIH0sXG4gIHsgdmFsdWU6ICdtaXN0cmFsJywgbGFiZWw6ICdNaXN0cmFsJywgaGludDogJ2NvbnNvbGUubWlzdHJhbC5haS9hcGkta2V5cycgfSxcbiAgeyB2YWx1ZTogJ21pbmltYXgnLCBsYWJlbDogJ01pbmlNYXgnLCBoaW50OiAncGxhdGZvcm0ubWluaW1heC5pbyAoQW50aHJvcGljLWNvbXBhdGlibGUgcmVjb21tZW5kZWQpJyB9LFxuICB7IHZhbHVlOiAnbWluaW1heC1jbicsIGxhYmVsOiAnTWluaU1heCBDTicsIGhpbnQ6ICdhcGkubWluaW1heGkuY29tIChBbnRocm9waWMtY29tcGF0aWJsZSknIH0sXG4gIHsgdmFsdWU6ICdvbGxhbWEtY2xvdWQnLCBsYWJlbDogJ09sbGFtYSBDbG91ZCcgfSxcbiAgeyB2YWx1ZTogJ2N1c3RvbS1vcGVuYWknLCBsYWJlbDogJ0N1c3RvbSAoT3BlbkFJLWNvbXBhdGlibGUpJywgaGludDogJ09sbGFtYSwgTE0gU3R1ZGlvLCB2TExNLCBwcm94aWVzIFx1MjAxNCBzZWUgZG9jcy9wcm92aWRlcnMubWQnIH0sXG5dXG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBEeW5hbWljIGltcG9ydHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogRHluYW1pY2FsbHkgaW1wb3J0IEBjbGFjay9wcm9tcHRzLlxuICogRHluYW1pYyBpbXBvcnQgd2l0aCBmYWxsYmFjayBzbyB0aGUgbW9kdWxlIGRvZXNuJ3QgY3Jhc2ggaWYgaXQncyBtaXNzaW5nLlxuICovXG5hc3luYyBmdW5jdGlvbiBsb2FkQ2xhY2soKTogUHJvbWlzZTxDbGFja01vZHVsZT4ge1xuICB0cnkge1xuICAgIHJldHVybiBhd2FpdCBpbXBvcnQoJ0BjbGFjay9wcm9tcHRzJylcbiAgfSBjYXRjaCB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdbZ3NkXSBAY2xhY2svcHJvbXB0cyBub3QgZm91bmQgXHUyMDE0IG9uYm9hcmRpbmcgd2l6YXJkIHJlcXVpcmVzIHRoaXMgZGVwZW5kZW5jeScpXG4gIH1cbn1cblxuLyoqXG4gKiBCdWlsZCB0aGUgUGljb01vZHVsZSBjb2xvciBzdXJmYWNlIGZyb20gY2hhbGsuIENoYWxrIGlzIGFscmVhZHkgYVxuICogZGVwZW5kZW5jeSBvZiB0aGUgQ0xJOyB0aGlzIGFkYXB0ZXIga2VlcHMgdGhlIG9uYm9hcmRpbmcgY2FsbCBzaXRlcyBzdGFibGVcbiAqIHdoaWxlIHJlbW92aW5nIHRoZSByZWR1bmRhbnQgcGljb2NvbG9ycyBkZXAuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGxvYWRQaWNvKCk6IFByb21pc2U8UGljb01vZHVsZT4ge1xuICB0cnkge1xuICAgIGNvbnN0IHsgZGVmYXVsdDogY2hhbGsgfSA9IGF3YWl0IGltcG9ydCgnY2hhbGsnKVxuICAgIHJldHVybiB7XG4gICAgICBjeWFuOiAoczogc3RyaW5nKSA9PiBjaGFsay5jeWFuKHMpLFxuICAgICAgZ3JlZW46IChzOiBzdHJpbmcpID0+IGNoYWxrLmdyZWVuKHMpLFxuICAgICAgeWVsbG93OiAoczogc3RyaW5nKSA9PiBjaGFsay55ZWxsb3cocyksXG4gICAgICBkaW06IChzOiBzdHJpbmcpID0+IGNoYWxrLmRpbShzKSxcbiAgICAgIGJvbGQ6IChzOiBzdHJpbmcpID0+IGNoYWxrLmJvbGQocyksXG4gICAgICByZWQ6IChzOiBzdHJpbmcpID0+IGNoYWxrLnJlZChzKSxcbiAgICAgIHJlc2V0OiAoczogc3RyaW5nKSA9PiBjaGFsay5yZXNldChzKSxcbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIEZhbGxiYWNrOiByZXR1cm4gaWRlbnRpdHkgZnVuY3Rpb25zXG4gICAgY29uc3QgaWRlbnRpdHkgPSAoczogc3RyaW5nKSA9PiBzXG4gICAgcmV0dXJuIHsgY3lhbjogaWRlbnRpdHksIGdyZWVuOiBpZGVudGl0eSwgeWVsbG93OiBpZGVudGl0eSwgZGltOiBpZGVudGl0eSwgYm9sZDogaWRlbnRpdHksIHJlZDogaWRlbnRpdHksIHJlc2V0OiBpZGVudGl0eSB9XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFV0aWxpdGllcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqIE9wZW4gYSBVUkwgaW4gdGhlIHN5c3RlbSBicm93c2VyIChiZXN0LWVmZm9ydCwgbm9uLWJsb2NraW5nKSAqL1xuZnVuY3Rpb24gb3BlbkJyb3dzZXIodXJsOiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKHByb2Nlc3MucGxhdGZvcm0gPT09ICd3aW4zMicpIHtcbiAgICAvLyBQb3dlclNoZWxsJ3MgU3RhcnQtUHJvY2VzcyBoYW5kbGVzIFVSTHMgd2l0aCAnJicgc2FmZWx5OyBjbWQgL2Mgc3RhcnQgZG9lcyBub3QuXG4gICAgZXhlY0ZpbGUoJ3Bvd2Vyc2hlbGwnLCBbJy1jJywgYFN0YXJ0LVByb2Nlc3MgJyR7dXJsLnJlcGxhY2UoLycvZywgXCInJ1wiKX0nYF0sICgpID0+IHt9KVxuICB9IGVsc2Uge1xuICAgIGNvbnN0IGNtZCA9IHByb2Nlc3MucGxhdGZvcm0gPT09ICdkYXJ3aW4nID8gJ29wZW4nIDogJ3hkZy1vcGVuJ1xuICAgIGV4ZWNGaWxlKGNtZCwgW3VybF0sICgpID0+IHt9KVxuICB9XG59XG5cbi8qKlxuICogUGVyc2lzdCB0aGUgc2VsZWN0ZWQgZGVmYXVsdCBwcm92aWRlciB0byBzZXR0aW5ncy5qc29uLlxuICpcbiAqIFRoaXMgZW5zdXJlcyBmaXJzdCBzdGFydHVwIGFmdGVyIG9uYm9hcmRpbmcgcHJlZmVycyB0aGUgcHJvdmlkZXIgdGhlIHVzZXJcbiAqIGp1c3QgY29uZmlndXJlZCwgaW5zdGVhZCBvZiBmYWxsaW5nIGJhY2sgdG8gdGhlIGZpcnN0IFwiYXZhaWxhYmxlXCIgcHJvdmlkZXJcbiAqICh3aGljaCBjYW4gYmUgaW5mbHVlbmNlZCBieSB1bnJlbGF0ZWQgZW52IGF1dGggbGlrZSBBV1NfUFJPRklMRSkuXG4gKi9cbmZ1bmN0aW9uIHBlcnNpc3REZWZhdWx0UHJvdmlkZXIocHJvdmlkZXJJZDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHNldHRpbmdzUGF0aCA9IGpvaW4oYWdlbnREaXIsICdzZXR0aW5ncy5qc29uJylcbiAgdHJ5IHtcbiAgICBjb25zdCByYXcgPSBleGlzdHNTeW5jKHNldHRpbmdzUGF0aCkgPyBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhzZXR0aW5nc1BhdGgsICd1dGYtOCcpKSA6IHt9XG4gICAgcmF3LmRlZmF1bHRQcm92aWRlciA9IHByb3ZpZGVySWRcbiAgICBta2RpclN5bmMoZGlybmFtZShzZXR0aW5nc1BhdGgpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KVxuICAgIHdyaXRlRmlsZVN5bmMoc2V0dGluZ3NQYXRoLCBKU09OLnN0cmluZ2lmeShyYXcsIG51bGwsIDIpLCAndXRmLTgnKVxuICB9IGNhdGNoIHtcbiAgICAvLyBOb24tZmF0YWw6IHN0YXJ0dXAgZmFsbGJhY2sgbG9naWMgd2lsbCBzdGlsbCBydW4uXG4gIH1cbn1cblxuLyoqXG4gKiBQZXJzaXN0IHRoZSBzZWxlY3RlZCBkZWZhdWx0IG1vZGVsIHRvIHNldHRpbmdzLmpzb24uXG4gKi9cbmZ1bmN0aW9uIHBlcnNpc3REZWZhdWx0TW9kZWwobW9kZWxJZDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHNldHRpbmdzUGF0aCA9IGpvaW4oYWdlbnREaXIsICdzZXR0aW5ncy5qc29uJylcbiAgdHJ5IHtcbiAgICBjb25zdCByYXcgPSBleGlzdHNTeW5jKHNldHRpbmdzUGF0aCkgPyBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhzZXR0aW5nc1BhdGgsICd1dGYtOCcpKSA6IHt9XG4gICAgcmF3LmRlZmF1bHRNb2RlbCA9IG1vZGVsSWRcbiAgICBta2RpclN5bmMoZGlybmFtZShzZXR0aW5nc1BhdGgpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KVxuICAgIHdyaXRlRmlsZVN5bmMoc2V0dGluZ3NQYXRoLCBKU09OLnN0cmluZ2lmeShyYXcsIG51bGwsIDIpLCAndXRmLTgnKVxuICB9IGNhdGNoIHtcbiAgICAvLyBOb24tZmF0YWw6IHN0YXJ0dXAgZmFsbGJhY2sgbG9naWMgd2lsbCBzdGlsbCBydW4uXG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGRldGVjdE5hdGl2ZVByb3ZpZGVyRnJvbUJhc2VVcmwoYmFzZVVybDogc3RyaW5nKTogJ21pbmltYXgnIHwgJ21pbmltYXgtY24nIHwgbnVsbCB7XG4gIHRyeSB7XG4gICAgY29uc3QgaG9zdG5hbWUgPSBuZXcgVVJMKGJhc2VVcmwpLmhvc3RuYW1lLnRvTG93ZXJDYXNlKClcbiAgICBpZiAoaG9zdG5hbWUgPT09ICdhcGkubWluaW1heC5pbycgfHwgaG9zdG5hbWUuZW5kc1dpdGgoJy5taW5pbWF4LmlvJykpIHtcbiAgICAgIHJldHVybiAnbWluaW1heCdcbiAgICB9XG4gICAgaWYgKGhvc3RuYW1lID09PSAnYXBpLm1pbmltYXhpLmNvbScgfHwgaG9zdG5hbWUuZW5kc1dpdGgoJy5taW5pbWF4aS5jb20nKSkge1xuICAgICAgcmV0dXJuICdtaW5pbWF4LWNuJ1xuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gaWdub3JlIHBhcnNlIGZhaWx1cmVzOyBoYW5kbGVkIGJ5IHByaW9yIHZhbGlkYXRpb25cbiAgfVxuICByZXR1cm4gbnVsbFxufVxuXG4vKiogU2VudGluZWwgcmV0dXJuZWQgYnkgcnVuU3RlcCB3aGVuIHRoZSB1c2VyIGNhbmNlbHMgXHUyMDE0IHRlbGxzIHRoZSBjYWxsZXJcbiAqICB0byBhYm9ydCB0aGUgZW50aXJlIHdpemFyZC4gKi9cbmNvbnN0IFNURVBfQ0FOQ0VMTEVEID0gU3ltYm9sKCdzdGVwLWNhbmNlbGxlZCcpXG50eXBlIFN0ZXBDYW5jZWxsZWQgPSB0eXBlb2YgU1RFUF9DQU5DRUxMRURcblxuLyoqXG4gKiBSdW4gYSBzaW5nbGUgb25ib2FyZGluZyBzdGVwIHdpdGggc2hhcmVkIGVycm9yIGhhbmRsaW5nOlxuICogICAtIHVzZXIgY2FuY2VsIChDdHJsK0MpIFx1MjE5MiBwLmNhbmNlbChjYW5jZWxNZXNzYWdlKSwgcmV0dXJucyBTVEVQX0NBTkNFTExFRFxuICogICAtIG90aGVyIGVycm9yIFx1MjE5MiBwLmxvZy53YXJuICsgb3B0aW9uYWwgaW5mbyBmb2xsb3ctdXAsIHJldHVybnMgbnVsbFxuICogICAtIHN1Y2Nlc3MgXHUyMTkyIHRoZSBzdGVwJ3MgcmV0dXJuIHZhbHVlXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJ1blN0ZXA8VD4oXG4gIHA6IENsYWNrTW9kdWxlLFxuICB3YXJuTGFiZWw6IHN0cmluZyxcbiAgZm46ICgpID0+IFByb21pc2U8VD4sXG4gIG9wdHM6IHsgY2FuY2VsTWVzc2FnZT86IHN0cmluZzsgZXJyb3JJbmZvPzogc3RyaW5nIH0gPSB7fSxcbik6IFByb21pc2U8VCB8IG51bGwgfCBTdGVwQ2FuY2VsbGVkPiB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIGF3YWl0IGZuKClcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgaWYgKHAuaXNDYW5jZWwoZXJyKSkge1xuICAgICAgcC5jYW5jZWwob3B0cy5jYW5jZWxNZXNzYWdlID8/ICdTZXR1cCBjYW5jZWxsZWQuJylcbiAgICAgIHJldHVybiBTVEVQX0NBTkNFTExFRFxuICAgIH1cbiAgICBwLmxvZy53YXJuKGAke3dhcm5MYWJlbH06ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWApXG4gICAgaWYgKG9wdHMuZXJyb3JJbmZvKSBwLmxvZy5pbmZvKG9wdHMuZXJyb3JJbmZvKVxuICAgIHJldHVybiBudWxsXG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFB1YmxpYyBBUEkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogRGV0ZXJtaW5lIGlmIHRoZSBvbmJvYXJkaW5nIHdpemFyZCBzaG91bGQgcnVuLlxuICpcbiAqIFJldHVybnMgdHJ1ZSB3aGVuOlxuICogLSBObyBMTE0gcHJvdmlkZXIgYXV0aCBpcyBhdmFpbGFibGVcbiAqIC0gV2UncmUgb24gYSBUVFkgKGludGVyYWN0aXZlIHRlcm1pbmFsKVxuICpcbiAqIFJldHVybnMgZmFsc2UgKHNraXAgd2l6YXJkKSB3aGVuOlxuICogLSBBbnkgTExNIHByb3ZpZGVyIGlzIGFscmVhZHkgYXZhaWxhYmxlIHZpYSBhdXRoLmpzb24sIGVudiB2YXJzLCBydW50aW1lIG92ZXJyaWRlcywgb3IgZmFsbGJhY2sgYXV0aFxuICogLSBBIGRlZmF1bHQgcHJvdmlkZXIgaXMgYWxyZWFkeSBjb25maWd1cmVkIGluIHNldHRpbmdzIChjb3ZlcnMgZXh0ZW5zaW9uLWJhc2VkIHByb3ZpZGVyc1xuICogICB0aGF0IG1heSBub3QgcmVxdWlyZSBjcmVkZW50aWFscyBpbiBhdXRoLmpzb24pXG4gKiAtIE5vdCBhIFRUWSAocGlwZWQgaW5wdXQsIHN1YmFnZW50LCBDSSlcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNob3VsZFJ1bk9uYm9hcmRpbmcoYXV0aFN0b3JhZ2U6IEF1dGhTdG9yYWdlLCBzZXR0aW5nc0RlZmF1bHRQcm92aWRlcj86IHN0cmluZyk6IGJvb2xlYW4ge1xuICBpZiAoIXByb2Nlc3Muc3RkaW4uaXNUVFkpIHJldHVybiBmYWxzZVxuICAvLyBFeHBsaWNpdCBjb21wbGV0aW9uIHJlY29yZCB3aW5zIFx1MjAxNCB1c2VyIGhhcyBhbHJlYWR5IGZpbmlzaGVkIG9uYm9hcmRpbmcgKGFuZFxuICAvLyBvdXIgZmxvd1ZlcnNpb24gaGFzbid0IGJ1bXBlZCBzaW5jZSkuXG4gIGlmIChpc09uYm9hcmRpbmdDb21wbGV0ZSgpKSByZXR1cm4gZmFsc2VcbiAgaWYgKHNldHRpbmdzRGVmYXVsdFByb3ZpZGVyKSByZXR1cm4gZmFsc2VcbiAgLy8gQ2hlY2sgaWYgYW55IExMTSBwcm92aWRlciBoYXMgY3JlZGVudGlhbHNcbiAgY29uc3QgaGFzTGxtQXV0aCA9IExMTV9QUk9WSURFUl9JRFMuc29tZShpZCA9PiBhdXRoU3RvcmFnZS5oYXNBdXRoKGlkKSlcbiAgcmV0dXJuICFoYXNMbG1BdXRoXG59XG5cbi8qKlxuICogUnVuIHRoZSB1bmlmaWVkIG9uYm9hcmRpbmcgd2l6YXJkLlxuICpcbiAqIFdhbGtzIHRoZSB1c2VyIHRocm91Z2g6XG4gKiAxLiBDaG9vc2UgTExNIHByb3ZpZGVyXG4gKiAyLiBBdXRoZW50aWNhdGUgKE9BdXRoIG9yIEFQSSBrZXkpXG4gKiAzLiBPcHRpb25hbCB0b29sIEFQSSBrZXlzXG4gKiA0LiBTdW1tYXJ5XG4gKlxuICogQWxsIHN0ZXBzIGFyZSBza2lwcGFibGUuIEFsbCBlcnJvcnMgYXJlIHJlY292ZXJhYmxlLlxuICogV3JpdGVzIHN0YXR1cyB0byBzdGRlcnIgZHVyaW5nIGV4ZWN1dGlvbi5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bk9uYm9hcmRpbmcoXG4gIGF1dGhTdG9yYWdlOiBBdXRoU3RvcmFnZSxcbiAgb3B0czogUnVuT25ib2FyZGluZ09wdGlvbnMgPSB7fSxcbik6IFByb21pc2U8dm9pZD4ge1xuICBsZXQgcDogQ2xhY2tNb2R1bGVcbiAgbGV0IHBjOiBQaWNvTW9kdWxlXG4gIHRyeSB7XG4gICAgO1twLCBwY10gPSBhd2FpdCBQcm9taXNlLmFsbChbbG9hZENsYWNrKCksIGxvYWRQaWNvKCldKVxuICB9IGNhdGNoIChlcnIpIHtcbiAgICAvLyBJZiBjbGFjayBpc24ndCBhdmFpbGFibGUsIGZhbGwgYmFjayBzaWxlbnRseSBcdTIwMTQgZG9uJ3QgYmxvY2sgYm9vdFxuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBbZ3NkXSBPbmJvYXJkaW5nIHdpemFyZCB1bmF2YWlsYWJsZTogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9XFxuYClcbiAgICByZXR1cm5cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBJbnRybyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgaWYgKG9wdHMuc2hvd0ludHJvICE9PSBmYWxzZSkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKHJlbmRlckxvZ28ocGMuY3lhbikpXG4gICAgcC5pbnRybyhwYy5ib2xkKCdXZWxjb21lIHRvIEdTRCBcdTIwMTQgbGV0XFwncyBnZXQgeW91IHNldCB1cCcpKVxuICB9XG5cbiAgY29uc3QgY29tcGxldGVkU3RlcHM6IHN0cmluZ1tdID0gW11cblxuICAvLyBcdTI1MDBcdTI1MDAgTExNIFByb3ZpZGVyIFNlbGVjdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgY29uc3QgbGxtUmVzdWx0ID0gYXdhaXQgcnVuU3RlcChwLCAnTExNIHNldHVwIGZhaWxlZCcsICgpID0+IHJ1bkxsbVN0ZXAocCwgcGMsIGF1dGhTdG9yYWdlKSwge1xuICAgIGNhbmNlbE1lc3NhZ2U6ICdTZXR1cCBjYW5jZWxsZWQgXHUyMDE0IHlvdSBjYW4gcnVuIC9nc2Qgb25ib2FyZGluZyAtLXJlc3VtZSBsYXRlci4nLFxuICAgIGVycm9ySW5mbzogJ1lvdSBjYW4gY29uZmlndXJlIHlvdXIgTExNIHByb3ZpZGVyIGxhdGVyIHdpdGggL2xvZ2luIGluc2lkZSBHU0QuJyxcbiAgfSlcbiAgaWYgKGxsbVJlc3VsdCA9PT0gU1RFUF9DQU5DRUxMRUQpIHJldHVyblxuICBjb25zdCBsbG1Db25maWd1cmVkID0gbGxtUmVzdWx0ID8/IGZhbHNlXG4gIGlmIChsbG1Db25maWd1cmVkKSB7IG1hcmtTdGVwQ29tcGxldGVkKCdsbG0nKTsgY29tcGxldGVkU3RlcHMucHVzaCgnbGxtJykgfSBlbHNlIHsgbWFya1N0ZXBTa2lwcGVkKCdsbG0nKSB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIFdlYiBTZWFyY2ggUHJvdmlkZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGNvbnN0IHNlYXJjaFJlc3VsdCA9IGF3YWl0IHJ1blN0ZXAocCwgJ1dlYiBzZWFyY2ggc2V0dXAgZmFpbGVkJyxcbiAgICAoKSA9PiBydW5XZWJTZWFyY2hTdGVwKHAsIHBjLCBhdXRoU3RvcmFnZSwgbGxtQ29uZmlndXJlZCkpXG4gIGlmIChzZWFyY2hSZXN1bHQgPT09IFNURVBfQ0FOQ0VMTEVEKSByZXR1cm5cbiAgY29uc3Qgc2VhcmNoQ29uZmlndXJlZCA9IHNlYXJjaFJlc3VsdFxuICBpZiAoc2VhcmNoQ29uZmlndXJlZCkgeyBtYXJrU3RlcENvbXBsZXRlZCgnc2VhcmNoJyk7IGNvbXBsZXRlZFN0ZXBzLnB1c2goJ3NlYXJjaCcpIH0gZWxzZSB7IG1hcmtTdGVwU2tpcHBlZCgnc2VhcmNoJykgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBSZW1vdGUgUXVlc3Rpb25zIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBjb25zdCByZW1vdGVSZXN1bHQgPSBhd2FpdCBydW5TdGVwKHAsICdSZW1vdGUgcXVlc3Rpb25zIHNldHVwIGZhaWxlZCcsXG4gICAgKCkgPT4gcnVuUmVtb3RlUXVlc3Rpb25zU3RlcChwLCBwYywgYXV0aFN0b3JhZ2UpKVxuICBpZiAocmVtb3RlUmVzdWx0ID09PSBTVEVQX0NBTkNFTExFRCkgcmV0dXJuXG4gIGNvbnN0IHJlbW90ZUNvbmZpZ3VyZWQgPSByZW1vdGVSZXN1bHRcbiAgaWYgKHJlbW90ZUNvbmZpZ3VyZWQpIHsgbWFya1N0ZXBDb21wbGV0ZWQoJ3JlbW90ZScpOyBjb21wbGV0ZWRTdGVwcy5wdXNoKCdyZW1vdGUnKSB9IGVsc2UgeyBtYXJrU3RlcFNraXBwZWQoJ3JlbW90ZScpIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgVG9vbCBBUEkgS2V5cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgY29uc3QgdG9vbFJlc3VsdCA9IGF3YWl0IHJ1blN0ZXAocCwgJ1Rvb2wga2V5IHNldHVwIGZhaWxlZCcsXG4gICAgKCkgPT4gcnVuVG9vbEtleXNTdGVwKHAsIHBjLCBhdXRoU3RvcmFnZSkpXG4gIGlmICh0b29sUmVzdWx0ID09PSBTVEVQX0NBTkNFTExFRCkgcmV0dXJuXG4gIGNvbnN0IHRvb2xLZXlDb3VudCA9IHRvb2xSZXN1bHQgPz8gMFxuICBpZiAodG9vbEtleUNvdW50ID4gMCkgeyBtYXJrU3RlcENvbXBsZXRlZCgndG9vbC1rZXlzJyk7IGNvbXBsZXRlZFN0ZXBzLnB1c2goJ3Rvb2wta2V5cycpIH0gZWxzZSB7IG1hcmtTdGVwU2tpcHBlZCgndG9vbC1rZXlzJykgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBTdW1tYXJ5IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBjb25zdCBzdW1tYXJ5TGluZXM6IHN0cmluZ1tdID0gW11cbiAgaWYgKGxsbUNvbmZpZ3VyZWQpIHtcbiAgICAvLyBSZS1yZWFkIHdoYXQgcHJvdmlkZXIgd2FzIHN0b3JlZFxuICAgIGNvbnN0IGF1dGhlZCA9IGF1dGhTdG9yYWdlLmxpc3QoKS5maWx0ZXIoaWQgPT4gTExNX1BST1ZJREVSX0lEUy5pbmNsdWRlcyhpZCkpXG4gICAgaWYgKGF1dGhlZC5sZW5ndGggPiAwKSB7XG4gICAgICBjb25zdCBuYW1lID0gYXV0aGVkWzBdXG4gICAgICBzdW1tYXJ5TGluZXMucHVzaChgJHtwYy5ncmVlbignXHUyNzEzJyl9IExMTSBwcm92aWRlcjogJHtuYW1lfWApXG4gICAgfSBlbHNlIHtcbiAgICAgIHN1bW1hcnlMaW5lcy5wdXNoKGAke3BjLmdyZWVuKCdcdTI3MTMnKX0gTExNIHByb3ZpZGVyIGNvbmZpZ3VyZWRgKVxuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBzdW1tYXJ5TGluZXMucHVzaChgJHtwYy55ZWxsb3coJ1x1MjFCNycpfSBMTE0gcHJvdmlkZXI6IHNraXBwZWQgXHUyMDE0IHVzZSAvbG9naW4gaW5zaWRlIEdTRGApXG4gIH1cblxuICBpZiAoc2VhcmNoQ29uZmlndXJlZCkge1xuICAgIHN1bW1hcnlMaW5lcy5wdXNoKGAke3BjLmdyZWVuKCdcdTI3MTMnKX0gV2ViIHNlYXJjaDogJHtzZWFyY2hDb25maWd1cmVkfWApXG4gIH0gZWxzZSB7XG4gICAgc3VtbWFyeUxpbmVzLnB1c2goYCR7cGMuZGltKCdcdTIxQjcnKX0gV2ViIHNlYXJjaDogbm90IGNvbmZpZ3VyZWQgXHUyMDE0IHVzZSAvc2VhcmNoLXByb3ZpZGVyIGluc2lkZSBHU0RgKVxuICB9XG5cbiAgaWYgKHJlbW90ZUNvbmZpZ3VyZWQpIHtcbiAgICBzdW1tYXJ5TGluZXMucHVzaChgJHtwYy5ncmVlbignXHUyNzEzJyl9IFJlbW90ZSBxdWVzdGlvbnM6ICR7cmVtb3RlQ29uZmlndXJlZH1gKVxuICB9IGVsc2Uge1xuICAgIHN1bW1hcnlMaW5lcy5wdXNoKGAke3BjLmRpbSgnXHUyMUI3Jyl9IFJlbW90ZSBxdWVzdGlvbnM6IG5vdCBjb25maWd1cmVkIFx1MjAxNCB1c2UgL2dzZCByZW1vdGUgaW5zaWRlIEdTRGApXG4gIH1cblxuICBpZiAodG9vbEtleUNvdW50ID4gMCkge1xuICAgIHN1bW1hcnlMaW5lcy5wdXNoKGAke3BjLmdyZWVuKCdcdTI3MTMnKX0gJHt0b29sS2V5Q291bnR9IHRvb2wga2V5JHt0b29sS2V5Q291bnQgPiAxID8gJ3MnIDogJyd9IHNhdmVkYClcbiAgfSBlbHNlIHtcbiAgICBzdW1tYXJ5TGluZXMucHVzaChgJHtwYy5kaW0oJ1x1MjFCNycpfSBUb29sIGtleXM6IG5vbmUgY29uZmlndXJlZGApXG4gIH1cblxuICAvLyBQZXJzaXN0IGNvbXBsZXRpb24gcmVjb3JkIHNvIHJlLWVudHJ5LCB3ZWIgYm9vdCBwcm9iZSwgYW5kIHNob3VsZFJ1bk9uYm9hcmRpbmdcbiAgLy8gYWxsIGFncmVlIHRoZSB3aXphcmQgZmluaXNoZWQuIFJlcXVpcmVkIHN0ZXBzIGRyaXZlIHRoZSBcImNvbXBsZXRlXCIgc2VtYW50aWNzXG4gIC8vIGluIG9uYm9hcmRpbmctc3RhdGUudHM7IGhlcmUgd2UgbWFyayB3aXphcmQtbGV2ZWwgY29tcGxldGlvbiByZWdhcmRsZXNzLlxuICBtYXJrT25ib2FyZGluZ0NvbXBsZXRlKGNvbXBsZXRlZFN0ZXBzKVxuXG4gIHN1bW1hcnlMaW5lcy5wdXNoKCcnKVxuICBzdW1tYXJ5TGluZXMucHVzaChgJHtwYy5kaW0oJ1RpcDonKX0gcmUtcnVuIGFueXRpbWUgd2l0aCAke3BjLmN5YW4oJy9nc2Qgb25ib2FyZGluZycpfWApXG5cbiAgcC5ub3RlKHN1bW1hcnlMaW5lcy5qb2luKCdcXG4nKSwgJ1NldHVwIGNvbXBsZXRlJylcbiAgcC5vdXRybyhwYy5kaW0oJ0xhdW5jaGluZyBHU0QuLi4nKSlcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIExMTSBBdXRoZW50aWNhdGlvbiBTdGVwIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuTGxtU3RlcChwOiBDbGFja01vZHVsZSwgcGM6IFBpY29Nb2R1bGUsIGF1dGhTdG9yYWdlOiBBdXRoU3RvcmFnZSk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICAvLyBCdWlsZCB0aGUgT0F1dGggcHJvdmlkZXIgbGlzdCBkeW5hbWljYWxseSBmcm9tIHdoYXQncyByZWdpc3RlcmVkXG4gIGNvbnN0IG9hdXRoUHJvdmlkZXJzID0gYXV0aFN0b3JhZ2UuZ2V0T0F1dGhQcm92aWRlcnMoKVxuICBjb25zdCBvYXV0aE1hcCA9IG5ldyBNYXAob2F1dGhQcm92aWRlcnMubWFwKG9wID0+IFtvcC5pZCwgb3BdKSlcblxuICAvLyBDaGVjayBpZiBhbHJlYWR5IGF1dGhlbnRpY2F0ZWRcbiAgY29uc3QgZXhpc3RpbmdBdXRoID0gTExNX1BST1ZJREVSX0lEUy5maW5kKGlkID0+IGF1dGhTdG9yYWdlLmhhc0F1dGgoaWQpKVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBTdGVwIDE6IEhvdyBkbyB5b3Ugd2FudCB0byBhdXRoZW50aWNhdGU/IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICB0eXBlIEF1dGhPcHRpb24gPSB7IHZhbHVlOiBzdHJpbmc7IGxhYmVsOiBzdHJpbmc7IGhpbnQ/OiBzdHJpbmcgfVxuICBjb25zdCBhdXRoT3B0aW9uczogQXV0aE9wdGlvbltdID0gW11cblxuICBpZiAoZXhpc3RpbmdBdXRoKSB7XG4gICAgYXV0aE9wdGlvbnMucHVzaCh7IHZhbHVlOiAna2VlcCcsIGxhYmVsOiBgS2VlcCBjdXJyZW50ICgke2V4aXN0aW5nQXV0aH0pYCwgaGludDogJ2FscmVhZHkgY29uZmlndXJlZCcgfSlcbiAgfVxuXG4gIC8vIFNob3cgQ2xhdWRlIENvZGUgQ0xJIG9wdGlvbiBhdCB0aGUgdG9wIHdoZW4gdGhlIENMSSBpcyBpbnN0YWxsZWQgYW5kIGF1dGhlbnRpY2F0ZWQgKCMzNzcyKS5cbiAgLy8gVGhpcyBpcyB0aGUgb25seSBUT1MtY29tcGxpYW50IHBhdGggZm9yIEFudGhyb3BpYyBzdWJzY3JpcHRpb24gdXNlcnMuXG4gIGlmIChpc0NsYXVkZUNsaVJlYWR5KCkpIHtcbiAgICBhdXRoT3B0aW9ucy5wdXNoKFxuICAgICAgeyB2YWx1ZTogJ2NsYXVkZS1jbGknLCBsYWJlbDogJ1VzZSBDbGF1ZGUgQ29kZSBDTEknLCBoaW50OiAncmVjb21tZW5kZWQgXHUyMDE0IHVzZXMgeW91ciBleGlzdGluZyBDbGF1ZGUgc3Vic2NyaXB0aW9uJyB9LFxuICAgIClcbiAgfVxuXG4gIGF1dGhPcHRpb25zLnB1c2goXG4gICAgeyB2YWx1ZTogJ2Jyb3dzZXInLCBsYWJlbDogJ1NpZ24gaW4gd2l0aCB5b3VyIGJyb3dzZXInLCBoaW50OiAnR2l0SHViIENvcGlsb3QsIENoYXRHUFQsIEdvb2dsZSwgZXRjLicgfSxcbiAgICB7IHZhbHVlOiAnYXBpLWtleScsIGxhYmVsOiAnUGFzdGUgYW4gQVBJIGtleScsIGhpbnQ6ICdmcm9tIHlvdXIgcHJvdmlkZXIgZGFzaGJvYXJkJyB9LFxuICAgIHsgdmFsdWU6ICdza2lwJywgbGFiZWw6ICdTa2lwIGZvciBub3cnLCBoaW50OiAndXNlIC9sb2dpbiBpbnNpZGUgR1NEIGxhdGVyJyB9LFxuICApXG5cbiAgY29uc3QgbWV0aG9kID0gYXdhaXQgcC5zZWxlY3Qoe1xuICAgIG1lc3NhZ2U6IGV4aXN0aW5nQXV0aCA/IGBMTE0gcHJvdmlkZXI6ICR7ZXhpc3RpbmdBdXRofSBcdTIwMTQgY2hhbmdlIGl0P2AgOiAnSG93IGRvIHlvdSB3YW50IHRvIHNpZ24gaW4/JyxcbiAgICBvcHRpb25zOiBhdXRoT3B0aW9ucyxcbiAgfSlcblxuICBpZiAocC5pc0NhbmNlbChtZXRob2QpIHx8IG1ldGhvZCA9PT0gJ3NraXAnKSByZXR1cm4gZmFsc2VcbiAgaWYgKG1ldGhvZCA9PT0gJ2tlZXAnKSByZXR1cm4gdHJ1ZVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBDbGF1ZGUgQ29kZSBDTEkgcGF0aCAoIzM3NzIpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBpZiAobWV0aG9kID09PSAnY2xhdWRlLWNsaScpIHtcbiAgICBwLmxvZy5zdWNjZXNzKCdDbGF1ZGUgQ29kZSBDTEkgZGV0ZWN0ZWQgXHUyMDE0IHJvdXRpbmcgdGhyb3VnaCBsb2NhbCBDTEkgKFRPUy1jb21wbGlhbnQpJylcbiAgICBwLmxvZy5pbmZvKCdZb3VyIENsYXVkZSBzdWJzY3JpcHRpb24gd2lsbCBiZSB1c2VkIGZvciBpbmZlcmVuY2UuIE5vIEFQSSBrZXkgbmVlZGVkLicpXG4gICAgLy8gU3RvcmUgc2VudGluZWwgc28gaGFzQXV0aCgnY2xhdWRlLWNvZGUnKSByZXR1cm5zIHRydWUgb24gZnV0dXJlIGJvb3RzXG4gICAgYXV0aFN0b3JhZ2Uuc2V0KCdjbGF1ZGUtY29kZScsIHsgdHlwZTogJ2FwaV9rZXknLCBrZXk6ICdjbGknIH0pXG4gICAgLy8gUGVyc2lzdCBjbGF1ZGUtY29kZSBzbyBzdGFydHVwIGRvZXMgbm90IGtlZXAgdXNlcnMgb24gYW50aHJvcGljIGRpcmVjdCBBUEkuXG4gICAgcGVyc2lzdERlZmF1bHRQcm92aWRlcignY2xhdWRlLWNvZGUnKVxuICAgIHJldHVybiB0cnVlXG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgU3RlcCAyOiBXaGljaCBwcm92aWRlcj8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGlmIChtZXRob2QgPT09ICdicm93c2VyJykge1xuICAgIC8vIEFudGhyb3BpYyBPQXV0aCBpcyByZW1vdmVkIGZyb20gYnJvd3NlciBhdXRoIFx1MjAxNCBpdCB2aW9sYXRlcyBBbnRocm9waWMgVE9TIGZvclxuICAgIC8vIHRoaXJkLXBhcnR5IGFwcHMgKCMzNzcyKS4gQW50aHJvcGljIHN1YnNjcmlwdGlvbiB1c2VycyBzaG91bGQgdXNlIHRoZSBDbGF1ZGVcbiAgICAvLyBDb2RlIENMSSBwYXRoIChzaG93biBhYm92ZSB3aGVuIENMSSBpcyBpbnN0YWxsZWQpIG9yIHBhc3RlIGFuIEFQSSBrZXkuXG4gICAgY29uc3QgcHJvdmlkZXIgPSBhd2FpdCBwLnNlbGVjdCh7XG4gICAgICBtZXNzYWdlOiAnQ2hvb3NlIHByb3ZpZGVyJyxcbiAgICAgIG9wdGlvbnM6IFtcbiAgICAgICAgeyB2YWx1ZTogJ2dpdGh1Yi1jb3BpbG90JywgbGFiZWw6ICdHaXRIdWIgQ29waWxvdCcgfSxcbiAgICAgICAgeyB2YWx1ZTogJ29wZW5haS1jb2RleCcsIGxhYmVsOiAnQ2hhdEdQVCBQbHVzL1BybyAoQ29kZXgpJyB9LFxuICAgICAgICB7IHZhbHVlOiAnZ29vZ2xlLWdlbWluaS1jbGknLCBsYWJlbDogJ0dvb2dsZSBHZW1pbmkgQ0xJJyB9LFxuICAgICAgICB7IHZhbHVlOiAnZ29vZ2xlLWFudGlncmF2aXR5JywgbGFiZWw6ICdBbnRpZ3Jhdml0eSAoR2VtaW5pIDMsIENsYXVkZSwgR1BULU9TUyknIH0sXG4gICAgICBdLFxuICAgIH0pXG4gICAgaWYgKHAuaXNDYW5jZWwocHJvdmlkZXIpKSByZXR1cm4gZmFsc2VcbiAgICByZXR1cm4gYXdhaXQgcnVuT0F1dGhGbG93KHAsIHBjLCBhdXRoU3RvcmFnZSwgcHJvdmlkZXIgYXMgc3RyaW5nLCBvYXV0aE1hcClcbiAgfVxuXG4gIGlmIChtZXRob2QgPT09ICdhcGkta2V5Jykge1xuICAgIGNvbnN0IHByb3ZpZGVyID0gYXdhaXQgcC5zZWxlY3Qoe1xuICAgICAgbWVzc2FnZTogJ0Nob29zZSBwcm92aWRlcicsXG4gICAgICBvcHRpb25zOiBbXG4gICAgICAgIHsgdmFsdWU6ICdhbnRocm9waWMnLCBsYWJlbDogJ0FudGhyb3BpYyAoQ2xhdWRlKScgfSxcbiAgICAgICAgeyB2YWx1ZTogJ29wZW5haScsIGxhYmVsOiAnT3BlbkFJJyB9LFxuICAgICAgICAuLi5PVEhFUl9QUk9WSURFUlMubWFwKG9wID0+ICh7IHZhbHVlOiBvcC52YWx1ZSwgbGFiZWw6IG9wLmxhYmVsIH0pKSxcbiAgICAgIF0sXG4gICAgfSlcbiAgICBpZiAocC5pc0NhbmNlbChwcm92aWRlcikpIHJldHVybiBmYWxzZVxuICAgIGlmIChwcm92aWRlciA9PT0gJ2N1c3RvbS1vcGVuYWknKSB7XG4gICAgICByZXR1cm4gYXdhaXQgcnVuQ3VzdG9tT3BlbkFJRmxvdyhwLCBwYywgYXV0aFN0b3JhZ2UpXG4gICAgfVxuICAgIGlmIChwcm92aWRlciA9PT0gJ29sbGFtYScpIHtcbiAgICAgIHJldHVybiBhd2FpdCBydW5PbGxhbWFMb2NhbEZsb3cocCwgcGMsIGF1dGhTdG9yYWdlKVxuICAgIH1cbiAgICBjb25zdCBsYWJlbCA9IHByb3ZpZGVyID09PSAnYW50aHJvcGljJyA/ICdBbnRocm9waWMnXG4gICAgICA6IHByb3ZpZGVyID09PSAnb3BlbmFpJyA/ICdPcGVuQUknXG4gICAgICA6IE9USEVSX1BST1ZJREVSUy5maW5kKG9wID0+IG9wLnZhbHVlID09PSBwcm92aWRlcik/LmxhYmVsID8/IFN0cmluZyhwcm92aWRlcilcbiAgICByZXR1cm4gYXdhaXQgcnVuQXBpS2V5RmxvdyhwLCBwYywgYXV0aFN0b3JhZ2UsIHByb3ZpZGVyIGFzIHN0cmluZywgbGFiZWwpXG4gIH1cblxuICByZXR1cm4gZmFsc2Vcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIE9BdXRoIEZsb3cgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmFzeW5jIGZ1bmN0aW9uIHJ1bk9BdXRoRmxvdyhcbiAgcDogQ2xhY2tNb2R1bGUsXG4gIHBjOiBQaWNvTW9kdWxlLFxuICBhdXRoU3RvcmFnZTogQXV0aFN0b3JhZ2UsXG4gIHByb3ZpZGVySWQ6IHN0cmluZyxcbiAgb2F1dGhNYXA6IE1hcDxzdHJpbmcsIHsgaWQ6IHN0cmluZzsgbmFtZT86IHN0cmluZzsgdXNlc0NhbGxiYWNrU2VydmVyPzogYm9vbGVhbiB9Pixcbik6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBjb25zdCBwcm92aWRlckluZm8gPSBvYXV0aE1hcC5nZXQocHJvdmlkZXJJZClcbiAgY29uc3QgcHJvdmlkZXJOYW1lID0gcHJvdmlkZXJJbmZvPy5uYW1lID8/IHByb3ZpZGVySWRcbiAgY29uc3QgdXNlc0NhbGxiYWNrU2VydmVyID0gcHJvdmlkZXJJbmZvPy51c2VzQ2FsbGJhY2tTZXJ2ZXIgPz8gZmFsc2VcblxuICBjb25zdCBzID0gcC5zcGlubmVyKClcbiAgcy5zdGFydChgQXV0aGVudGljYXRpbmcgd2l0aCAke3Byb3ZpZGVyTmFtZX0uLi5gKVxuXG4gIHRyeSB7XG4gICAgY29uc3QgbG9naW5DYWxsYmFja3M6IExvZ2luQ2FsbGJhY2tzID0ge1xuICAgICAgb25BdXRoOiAoaW5mbzogeyB1cmw6IHN0cmluZzsgaW5zdHJ1Y3Rpb25zPzogc3RyaW5nIH0pID0+IHtcbiAgICAgICAgcy5zdG9wKGBPcGVuaW5nIGJyb3dzZXIgZm9yICR7cHJvdmlkZXJOYW1lfWApXG4gICAgICAgIG9wZW5Ccm93c2VyKGluZm8udXJsKVxuICAgICAgICBwLmxvZy5pbmZvKGAke3BjLmRpbSgnVVJMOicpfSAke3BjLmN5YW4oaW5mby51cmwpfWApXG4gICAgICAgIGlmIChpbmZvLmluc3RydWN0aW9ucykge1xuICAgICAgICAgIHAubG9nLmluZm8ocGMueWVsbG93KGluZm8uaW5zdHJ1Y3Rpb25zKSlcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICAgIG9uUHJvbXB0OiBhc3luYyAocHJvbXB0OiB7IG1lc3NhZ2U6IHN0cmluZzsgcGxhY2Vob2xkZXI/OiBzdHJpbmcgfSkgPT4ge1xuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBwLnRleHQoe1xuICAgICAgICAgIG1lc3NhZ2U6IHByb21wdC5tZXNzYWdlLFxuICAgICAgICAgIHBsYWNlaG9sZGVyOiBwcm9tcHQucGxhY2Vob2xkZXIsXG4gICAgICAgIH0pXG4gICAgICAgIGlmIChwLmlzQ2FuY2VsKHJlc3VsdCkpIHJldHVybiAnJ1xuICAgICAgICByZXR1cm4gcmVzdWx0IGFzIHN0cmluZ1xuICAgICAgfSxcbiAgICAgIG9uUHJvZ3Jlc3M6IChtZXNzYWdlOiBzdHJpbmcpID0+IHtcbiAgICAgICAgcC5sb2cuc3RlcChwYy5kaW0obWVzc2FnZSkpXG4gICAgICB9LFxuICAgICAgb25NYW51YWxDb2RlSW5wdXQ6IHVzZXNDYWxsYmFja1NlcnZlclxuICAgICAgICA/IGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHAudGV4dCh7XG4gICAgICAgICAgICAgIG1lc3NhZ2U6ICdQYXN0ZSB0aGUgcmVkaXJlY3QgVVJMIGZyb20geW91ciBicm93c2VyOicsXG4gICAgICAgICAgICAgIHBsYWNlaG9sZGVyOiAnaHR0cDovL2xvY2FsaG9zdDouLi4nLFxuICAgICAgICAgICAgfSlcbiAgICAgICAgICAgIGlmIChwLmlzQ2FuY2VsKHJlc3VsdCkpIHJldHVybiAnJ1xuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdCBhcyBzdHJpbmdcbiAgICAgICAgICB9XG4gICAgICAgIDogdW5kZWZpbmVkLFxuICAgIH1cblxuICAgIGF3YWl0IGF1dGhTdG9yYWdlLmxvZ2luKHByb3ZpZGVySWQgYXMgTG9naW5Qcm92aWRlcklkLCBsb2dpbkNhbGxiYWNrcylcbiAgICBwZXJzaXN0RGVmYXVsdFByb3ZpZGVyKHByb3ZpZGVySWQpXG5cbiAgICBwLmxvZy5zdWNjZXNzKGBBdXRoZW50aWNhdGVkIHdpdGggJHtwYy5ncmVlbihwcm92aWRlck5hbWUpfWApXG4gICAgcmV0dXJuIHRydWVcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgcy5zdG9wKGAke3Byb3ZpZGVyTmFtZX0gYXV0aGVudGljYXRpb24gZmFpbGVkYClcbiAgICBjb25zdCBlcnJvck1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKVxuICAgIHAubG9nLndhcm4oYE9BdXRoIGVycm9yOiAke2Vycm9yTXNnfWApXG5cbiAgICAvLyBPZmZlciByZXRyeSBvciBza2lwXG4gICAgY29uc3QgcmV0cnkgPSBhd2FpdCBwLnNlbGVjdCh7XG4gICAgICBtZXNzYWdlOiAnV2hhdCB3b3VsZCB5b3UgbGlrZSB0byBkbz8nLFxuICAgICAgb3B0aW9uczogW1xuICAgICAgICB7IHZhbHVlOiAncmV0cnknLCBsYWJlbDogJ1RyeSBhZ2FpbicgfSxcbiAgICAgICAgeyB2YWx1ZTogJ3NraXAnLCBsYWJlbDogJ1NraXAgXHUyMDE0IGNvbmZpZ3VyZSBsYXRlciB3aXRoIC9sb2dpbicgfSxcbiAgICAgIF0sXG4gICAgfSlcblxuICAgIGlmIChwLmlzQ2FuY2VsKHJldHJ5KSB8fCByZXRyeSA9PT0gJ3NraXAnKSByZXR1cm4gZmFsc2VcbiAgICAvLyBSZWN1cnNpdmUgcmV0cnlcbiAgICByZXR1cm4gcnVuT0F1dGhGbG93KHAsIHBjLCBhdXRoU3RvcmFnZSwgcHJvdmlkZXJJZCwgb2F1dGhNYXApXG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEFQSSBLZXkgRmxvdyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuYXN5bmMgZnVuY3Rpb24gcnVuQXBpS2V5RmxvdyhcbiAgcDogQ2xhY2tNb2R1bGUsXG4gIHBjOiBQaWNvTW9kdWxlLFxuICBhdXRoU3RvcmFnZTogQXV0aFN0b3JhZ2UsXG4gIHByb3ZpZGVySWQ6IHN0cmluZyxcbiAgcHJvdmlkZXJMYWJlbDogc3RyaW5nLFxuKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGNvbnN0IGtleSA9IGF3YWl0IHAucGFzc3dvcmQoe1xuICAgIG1lc3NhZ2U6IGBQYXN0ZSB5b3VyICR7cHJvdmlkZXJMYWJlbH0gQVBJIGtleTpgLFxuICAgIG1hc2s6ICdcdTI1Q0YnLFxuICB9KVxuXG4gIGlmIChwLmlzQ2FuY2VsKGtleSkgfHwgIWtleSkgcmV0dXJuIGZhbHNlXG4gIGNvbnN0IHRyaW1tZWQgPSAoa2V5IGFzIHN0cmluZykudHJpbSgpXG4gIGlmICghdHJpbW1lZCkgcmV0dXJuIGZhbHNlXG5cbiAgLy8gQmFzaWMgcHJlZml4IHZhbGlkYXRpb25cbiAgY29uc3QgZXhwZWN0ZWRQcmVmaXhlcyA9IEFQSV9LRVlfUFJFRklYRVNbcHJvdmlkZXJJZF1cbiAgaWYgKGV4cGVjdGVkUHJlZml4ZXMgJiYgIWV4cGVjdGVkUHJlZml4ZXMuc29tZShwZnggPT4gdHJpbW1lZC5zdGFydHNXaXRoKHBmeCkpKSB7XG4gICAgcC5sb2cud2FybihgS2V5IGRvZXNuJ3Qgc3RhcnQgd2l0aCBleHBlY3RlZCBwcmVmaXggKCR7ZXhwZWN0ZWRQcmVmaXhlcy5qb2luKCcgb3IgJyl9KS4gU2F2aW5nIGFueXdheS5gKVxuICB9XG5cbiAgYXV0aFN0b3JhZ2Uuc2V0KHByb3ZpZGVySWQsIHsgdHlwZTogJ2FwaV9rZXknLCBrZXk6IHRyaW1tZWQgfSlcbiAgcGVyc2lzdERlZmF1bHRQcm92aWRlcihwcm92aWRlcklkKVxuICBwLmxvZy5zdWNjZXNzKGBBUEkga2V5IHNhdmVkIGZvciAke3BjLmdyZWVuKHByb3ZpZGVyTGFiZWwpfWApXG5cbiAgLy8gUHJvdmlkZXItc3BlY2lmaWMgcG9zdC1zZXR1cCBoaW50c1xuICBpZiAocHJvdmlkZXJJZCA9PT0gJ29wZW5yb3V0ZXInKSB7XG4gICAgcC5sb2cuaW5mbyhgVXNlICR7cGMuY3lhbignL21vZGVsJyl9IGluc2lkZSBHU0QgdG8gcGljayBhbiBPcGVuUm91dGVyIG1vZGVsLmApXG4gICAgcC5sb2cuaW5mbyhgVG8gYWRkIGN1c3RvbSBtb2RlbHMgb3IgY29udHJvbCByb3V0aW5nLCBzZWUgJHtwYy5kaW0oJ2RvY3MvcHJvdmlkZXJzLm1kI29wZW5yb3V0ZXInKX1gKVxuICB9XG5cbiAgcmV0dXJuIHRydWVcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIE9sbGFtYSBMb2NhbCBGbG93IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5hc3luYyBmdW5jdGlvbiBydW5PbGxhbWFMb2NhbEZsb3coXG4gIHA6IENsYWNrTW9kdWxlLFxuICBwYzogUGljb01vZHVsZSxcbiAgYXV0aFN0b3JhZ2U6IEF1dGhTdG9yYWdlLFxuKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGNvbnN0IGhvc3QgPSBwcm9jZXNzLmVudi5PTExBTUFfSE9TVCB8fCAnaHR0cDovL2xvY2FsaG9zdDoxMTQzNCdcblxuICBjb25zdCBzID0gcC5zcGlubmVyKClcbiAgcy5zdGFydChgQ2hlY2tpbmcgT2xsYW1hIGF0ICR7aG9zdH0uLi5gKVxuXG4gIHRyeSB7XG4gICAgY29uc3QgY29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKVxuICAgIGNvbnN0IHRpbWVvdXQgPSBzZXRUaW1lb3V0KCgpID0+IGNvbnRyb2xsZXIuYWJvcnQoKSwgMzAwMClcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKGhvc3QsIHsgc2lnbmFsOiBjb250cm9sbGVyLnNpZ25hbCB9KVxuICAgIGNsZWFyVGltZW91dCh0aW1lb3V0KVxuXG4gICAgaWYgKHJlc3BvbnNlLm9rKSB7XG4gICAgICBzLnN0b3AoYE9sbGFtYSBpcyBydW5uaW5nIGF0ICR7cGMuZ3JlZW4oaG9zdCl9YClcbiAgICAgIC8vIFN0b3JlIGEgcGxhY2Vob2xkZXIgc28gdGhlIHByb3ZpZGVyIGlzIHJlY29nbml6ZWQgYXMgYXV0aGVudGljYXRlZFxuICAgICAgYXV0aFN0b3JhZ2Uuc2V0KCdvbGxhbWEnLCB7IHR5cGU6ICdhcGlfa2V5Jywga2V5OiAnb2xsYW1hJyB9KVxuICAgICAgcGVyc2lzdERlZmF1bHRQcm92aWRlcignb2xsYW1hJylcbiAgICAgIHAubG9nLnN1Y2Nlc3MoYCR7cGMuZ3JlZW4oJ09sbGFtYSAoTG9jYWwpJyl9IGNvbmZpZ3VyZWQgXHUyMDE0IG5vIEFQSSBrZXkgbmVlZGVkYClcbiAgICAgIHAubG9nLmluZm8ocGMuZGltKCdNb2RlbHMgYXJlIGRpc2NvdmVyZWQgYXV0b21hdGljYWxseSBmcm9tIHlvdXIgbG9jYWwgT2xsYW1hIGluc3RhbmNlLicpKVxuICAgICAgcmV0dXJuIHRydWVcbiAgICB9IGVsc2Uge1xuICAgICAgcy5zdG9wKCdPbGxhbWEgY2hlY2sgZmFpbGVkJylcbiAgICAgIHAubG9nLndhcm4oYE9sbGFtYSByZXNwb25kZWQgd2l0aCBzdGF0dXMgJHtyZXNwb25zZS5zdGF0dXN9IGF0ICR7aG9zdH1gKVxuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgcy5zdG9wKCdPbGxhbWEgbm90IGRldGVjdGVkJylcbiAgICBwLmxvZy53YXJuKGBDb3VsZCBub3QgcmVhY2ggT2xsYW1hIGF0ICR7aG9zdH1gKVxuICAgIHAubG9nLmluZm8ocGMuZGltKCdJbnN0YWxsIE9sbGFtYSBmcm9tIGh0dHBzOi8vb2xsYW1hLmNvbSBhbmQgcnVuIFwib2xsYW1hIHNlcnZlXCInKSlcbiAgICBwLmxvZy5pbmZvKHBjLmRpbSgnU2V0IE9MTEFNQV9IT1NUIGlmIHVzaW5nIGEgbm9uLWRlZmF1bHQgYWRkcmVzcy4nKSlcbiAgfVxuXG4gIC8vIEV2ZW4gaWYgbm90IHJlYWNoYWJsZSBub3csIHNhdmUgdGhlIGNvbmZpZyBcdTIwMTQgdGhlIGV4dGVuc2lvbiB3aWxsIGRldGVjdCBpdCBhdCBydW50aW1lXG4gIGNvbnN0IHByb2NlZWQgPSBhd2FpdCBwLmNvbmZpcm0oe1xuICAgIG1lc3NhZ2U6ICdTYXZlIE9sbGFtYSBhcyB5b3VyIHByb3ZpZGVyIGFueXdheT8gKGl0IHdpbGwgYXV0by1kZXRlY3Qgd2hlbiBydW5uaW5nKScsXG4gIH0pXG5cbiAgaWYgKHAuaXNDYW5jZWwocHJvY2VlZCkgfHwgIXByb2NlZWQpIHJldHVybiBmYWxzZVxuXG4gIGF1dGhTdG9yYWdlLnNldCgnb2xsYW1hJywgeyB0eXBlOiAnYXBpX2tleScsIGtleTogJ29sbGFtYScgfSlcbiAgcGVyc2lzdERlZmF1bHRQcm92aWRlcignb2xsYW1hJylcbiAgcC5sb2cuc3VjY2VzcyhgJHtwYy5ncmVlbignT2xsYW1hIChMb2NhbCknKX0gc2F2ZWQgXHUyMDE0IG1vZGVscyB3aWxsIGFwcGVhciB3aGVuIE9sbGFtYSBpcyBydW5uaW5nYClcbiAgcmV0dXJuIHRydWVcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEN1c3RvbSBPcGVuQUktY29tcGF0aWJsZSBGbG93IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5hc3luYyBmdW5jdGlvbiBydW5DdXN0b21PcGVuQUlGbG93KFxuICBwOiBDbGFja01vZHVsZSxcbiAgcGM6IFBpY29Nb2R1bGUsXG4gIGF1dGhTdG9yYWdlOiBBdXRoU3RvcmFnZSxcbik6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBwLmxvZy5pbmZvKHBjLmRpbSgnQ29tbW9uIGVuZHBvaW50czpcXG4gIE9sbGFtYTogICAgIGh0dHA6Ly9sb2NhbGhvc3Q6MTE0MzQvdjFcXG4gIExNIFN0dWRpbzogIGh0dHA6Ly9sb2NhbGhvc3Q6MTIzNC92MVxcbiAgdkxMTTogICAgICAgaHR0cDovL2xvY2FsaG9zdDo4MDAwL3YxJykpXG5cbiAgLy8gUHJvbXB0IGZvciBiYXNlIFVSTFxuICBjb25zdCBiYXNlVXJsID0gYXdhaXQgcC50ZXh0KHtcbiAgICBtZXNzYWdlOiAnQmFzZSBVUkwgb2YgeW91ciBPcGVuQUktY29tcGF0aWJsZSBlbmRwb2ludDonLFxuICAgIHBsYWNlaG9sZGVyOiAnaHR0cDovL2xvY2FsaG9zdDoxMTQzNC92MScsXG4gICAgdmFsaWRhdGU6ICh2YWwpID0+IHtcbiAgICAgIGNvbnN0IHRyaW1tZWQgPSB2YWw/LnRyaW0oKVxuICAgICAgaWYgKCF0cmltbWVkKSByZXR1cm4gJ0Jhc2UgVVJMIGlzIHJlcXVpcmVkJ1xuICAgICAgdHJ5IHtcbiAgICAgICAgbmV3IFVSTCh0cmltbWVkKVxuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiAnTXVzdCBiZSBhIHZhbGlkIFVSTCAoZS5nLiBodHRwczovL215LXByb3h5LmV4YW1wbGUuY29tL3YxKSdcbiAgICAgIH1cbiAgICB9LFxuICB9KVxuICBpZiAocC5pc0NhbmNlbChiYXNlVXJsKSB8fCAhYmFzZVVybCkgcmV0dXJuIGZhbHNlXG4gIGNvbnN0IHRyaW1tZWRVcmwgPSAoYmFzZVVybCBhcyBzdHJpbmcpLnRyaW0oKVxuXG4gIC8vIFByb21wdCBmb3IgQVBJIGtleVxuICBjb25zdCBhcGlLZXkgPSBhd2FpdCBwLnBhc3N3b3JkKHtcbiAgICBtZXNzYWdlOiAnQVBJIGtleSBmb3IgdGhpcyBlbmRwb2ludDonLFxuICAgIG1hc2s6ICdcdTI1Q0YnLFxuICB9KVxuICBpZiAocC5pc0NhbmNlbChhcGlLZXkpIHx8ICFhcGlLZXkpIHJldHVybiBmYWxzZVxuICBjb25zdCB0cmltbWVkS2V5ID0gKGFwaUtleSBhcyBzdHJpbmcpLnRyaW0oKVxuICBpZiAoIXRyaW1tZWRLZXkpIHJldHVybiBmYWxzZVxuXG4gIC8vIFByb21wdCBmb3IgbW9kZWwgSURcbiAgY29uc3QgbW9kZWxJZCA9IGF3YWl0IHAudGV4dCh7XG4gICAgbWVzc2FnZTogJ01vZGVsIElEIHRvIHVzZTonLFxuICAgIHBsYWNlaG9sZGVyOiAnZ3B0LTRvJyxcbiAgICB2YWxpZGF0ZTogKHZhbCkgPT4ge1xuICAgICAgaWYgKCF2YWw/LnRyaW0oKSkgcmV0dXJuICdNb2RlbCBJRCBpcyByZXF1aXJlZCdcbiAgICB9LFxuICB9KVxuICBpZiAocC5pc0NhbmNlbChtb2RlbElkKSB8fCAhbW9kZWxJZCkgcmV0dXJuIGZhbHNlXG4gIGNvbnN0IHRyaW1tZWRNb2RlbElkID0gKG1vZGVsSWQgYXMgc3RyaW5nKS50cmltKClcblxuICBjb25zdCBuYXRpdmVQcm92aWRlciA9IGRldGVjdE5hdGl2ZVByb3ZpZGVyRnJvbUJhc2VVcmwodHJpbW1lZFVybClcbiAgaWYgKG5hdGl2ZVByb3ZpZGVyKSB7XG4gICAgY29uc3QgZW52VmFyID0gbmF0aXZlUHJvdmlkZXIgPT09ICdtaW5pbWF4JyA/ICdNSU5JTUFYX0FQSV9LRVknIDogJ01JTklNQVhfQ05fQVBJX0tFWSdcbiAgICBhdXRoU3RvcmFnZS5zZXQobmF0aXZlUHJvdmlkZXIsIHsgdHlwZTogJ2FwaV9rZXknLCBrZXk6IHRyaW1tZWRLZXkgfSlcbiAgICBwZXJzaXN0RGVmYXVsdFByb3ZpZGVyKG5hdGl2ZVByb3ZpZGVyKVxuICAgIHBlcnNpc3REZWZhdWx0TW9kZWwodHJpbW1lZE1vZGVsSWQpXG4gICAgcHJvY2Vzcy5lbnZbZW52VmFyXSA9IHRyaW1tZWRLZXlcblxuICAgIHAubG9nLnN1Y2Nlc3MoYCR7cGMuZ3JlZW4oJ01pbmlNYXgnKX0gZGV0ZWN0ZWQgXHUyMDE0IGNvbmZpZ3VyZWQgYXMgbmF0aXZlIHByb3ZpZGVyICgke3BjLmN5YW4obmF0aXZlUHJvdmlkZXIpfSlgKVxuICAgIHAubG9nLmluZm8oYE1vZGVsOiAke3BjLmN5YW4odHJpbW1lZE1vZGVsSWQpfWApXG4gICAgcC5sb2cuaW5mbyhwYy5kaW0oJ1VzaW5nIEFudGhyb3BpYy1jb21wYXRpYmxlIE1pbmlNYXggaW50ZWdyYXRpb24gZm9yIGZ1bGwgbW9kZWwgbWV0YWRhdGEgYW5kIGNsZWFuIHRoaW5raW5nIG91dHB1dC4nKSlcbiAgICByZXR1cm4gdHJ1ZVxuICB9XG5cbiAgLy8gU2F2ZSBBUEkga2V5IHRvIGF1dGggc3RvcmFnZVxuICBhdXRoU3RvcmFnZS5zZXQoJ2N1c3RvbS1vcGVuYWknLCB7IHR5cGU6ICdhcGlfa2V5Jywga2V5OiB0cmltbWVkS2V5IH0pXG4gIHBlcnNpc3REZWZhdWx0UHJvdmlkZXIoJ2N1c3RvbS1vcGVuYWknKVxuICBwZXJzaXN0RGVmYXVsdE1vZGVsKHRyaW1tZWRNb2RlbElkKVxuXG4gIC8vIFdyaXRlIG9yIG1lcmdlIGludG8gbW9kZWxzLmpzb25cbiAgY29uc3QgbW9kZWxzSnNvblBhdGggPSBqb2luKGFnZW50RGlyLCAnbW9kZWxzLmpzb24nKVxuICBsZXQgY29uZmlnOiB7IHByb3ZpZGVyczogUmVjb3JkPHN0cmluZywgYW55PiB9ID0geyBwcm92aWRlcnM6IHt9IH1cblxuICBpZiAoZXhpc3RzU3luYyhtb2RlbHNKc29uUGF0aCkpIHtcbiAgICB0cnkge1xuICAgICAgY29uZmlnID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMobW9kZWxzSnNvblBhdGgsICd1dGYtOCcpKVxuICAgICAgaWYgKCFjb25maWcucHJvdmlkZXJzKSBjb25maWcucHJvdmlkZXJzID0ge31cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIElmIGV4aXN0aW5nIGZpbGUgaXMgY29ycnVwdCwgc3RhcnQgZnJlc2hcbiAgICAgIGNvbmZpZyA9IHsgcHJvdmlkZXJzOiB7fSB9XG4gICAgfVxuICB9XG5cbiAgY29uZmlnLnByb3ZpZGVyc1snY3VzdG9tLW9wZW5haSddID0ge1xuICAgIGJhc2VVcmw6IHRyaW1tZWRVcmwsXG4gICAgYXBpS2V5OiBgZW52OkNVU1RPTV9PUEVOQUlfQVBJX0tFWWAsXG4gICAgYXBpOiAnb3BlbmFpLWNvbXBsZXRpb25zJyxcbiAgICBtb2RlbHM6IFtcbiAgICAgIHtcbiAgICAgICAgaWQ6IHRyaW1tZWRNb2RlbElkLFxuICAgICAgICBuYW1lOiB0cmltbWVkTW9kZWxJZCxcbiAgICAgICAgcmVhc29uaW5nOiBmYWxzZSxcbiAgICAgICAgaW5wdXQ6IFsndGV4dCddLFxuICAgICAgICBjb250ZXh0V2luZG93OiAxMjgwMDAsXG4gICAgICAgIG1heFRva2VuczogMTYzODQsXG4gICAgICAgIGNvc3Q6IHsgaW5wdXQ6IDAsIG91dHB1dDogMCwgY2FjaGVSZWFkOiAwLCBjYWNoZVdyaXRlOiAwIH0sXG4gICAgICB9LFxuICAgIF0sXG4gIH1cblxuICAvLyBFbnN1cmUgcGFyZW50IGRpcmVjdG9yeSBleGlzdHNcbiAgY29uc3QgZGlyID0gZGlybmFtZShtb2RlbHNKc29uUGF0aClcbiAgaWYgKCFleGlzdHNTeW5jKGRpcikpIHtcbiAgICBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KVxuICB9XG4gIHdyaXRlRmlsZVN5bmMobW9kZWxzSnNvblBhdGgsIEpTT04uc3RyaW5naWZ5KGNvbmZpZywgbnVsbCwgMiksICd1dGYtOCcpXG5cbiAgLy8gQWxzbyBzZXQgZW52IHZhciBzbyB0aGUgY3VycmVudCBzZXNzaW9uIHBpY2tzIHVwIHRoZSBrZXkgdmlhIGZhbGxiYWNrIHJlc29sdmVyXG4gIHByb2Nlc3MuZW52LkNVU1RPTV9PUEVOQUlfQVBJX0tFWSA9IHRyaW1tZWRLZXlcblxuICBwLmxvZy5zdWNjZXNzKGBDdXN0b20gZW5kcG9pbnQgc2F2ZWQ6ICR7cGMuZ3JlZW4odHJpbW1lZFVybCl9YClcbiAgcC5sb2cuaW5mbyhgTW9kZWw6ICR7cGMuY3lhbih0cmltbWVkTW9kZWxJZCl9YClcbiAgcC5sb2cuaW5mbyhgQ29uZmlnIHdyaXR0ZW4gdG8gJHtwYy5kaW0obW9kZWxzSnNvblBhdGgpfWApXG4gIHAubG9nLmluZm8oYElmIHlvdSBnZXQgcm9sZSBvciBzdHJlYW1pbmcgZXJyb3JzLCBhZGQgY29tcGF0IHNldHRpbmdzIHRvIG1vZGVscy5qc29uLmApXG4gIHAubG9nLmluZm8oYFNlZSAke3BjLmRpbSgnZG9jcy9wcm92aWRlcnMubWQjY29tbW9uLXBpdGZhbGxzJyl9IGZvciBkZXRhaWxzLmApXG4gIHJldHVybiB0cnVlXG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBXZWIgU2VhcmNoIFByb3ZpZGVyIFN0ZXAgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5XZWJTZWFyY2hTdGVwKFxuICBwOiBDbGFja01vZHVsZSxcbiAgcGM6IFBpY29Nb2R1bGUsXG4gIGF1dGhTdG9yYWdlOiBBdXRoU3RvcmFnZSxcbiAgaXNBbnRocm9waWNBdXRoOiBib29sZWFuLFxuKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG4gIC8vIENoZWNrIHdoaWNoIExMTSBwcm92aWRlciB3YXMgY29uZmlndXJlZFxuICBjb25zdCBhdXRoZWQgPSBhdXRoU3RvcmFnZS5saXN0KCkuZmlsdGVyKGlkID0+IExMTV9QUk9WSURFUl9JRFMuaW5jbHVkZXMoaWQpKVxuICBjb25zdCBpc0FudGhyb3BpYyA9IGlzQW50aHJvcGljQXV0aCAmJiBhdXRoZWQuaW5jbHVkZXMoJ2FudGhyb3BpYycpXG5cbiAgLy8gQ2hlY2sgaWYgd2ViIHNlYXJjaCBpcyBhbHJlYWR5IGNvbmZpZ3VyZWRcbiAgY29uc3QgaGFzQnJhdmUgPSAhIXByb2Nlc3MuZW52LkJSQVZFX0FQSV9LRVkgfHwgYXV0aFN0b3JhZ2UuaGFzKCdicmF2ZScpXG4gIGNvbnN0IGhhc1RhdmlseSA9ICEhcHJvY2Vzcy5lbnYuVEFWSUxZX0FQSV9LRVkgfHwgYXV0aFN0b3JhZ2UuaGFzKCd0YXZpbHknKVxuICBjb25zdCBleGlzdGluZ1NlYXJjaCA9IGhhc0JyYXZlID8gJ0JyYXZlIFNlYXJjaCcgOiBoYXNUYXZpbHkgPyAnVGF2aWx5JyA6IG51bGxcblxuICAvLyBCdWlsZCBvcHRpb25zIGJhc2VkIG9uIHdoYXQncyBhdmFpbGFibGVcbiAgdHlwZSBTZWFyY2hPcHRpb24gPSB7IHZhbHVlOiBzdHJpbmc7IGxhYmVsOiBzdHJpbmc7IGhpbnQ/OiBzdHJpbmcgfVxuICBjb25zdCBvcHRpb25zOiBTZWFyY2hPcHRpb25bXSA9IFtdXG5cbiAgaWYgKGV4aXN0aW5nU2VhcmNoKSB7XG4gICAgb3B0aW9ucy5wdXNoKHsgdmFsdWU6ICdrZWVwJywgbGFiZWw6IGBLZWVwIGN1cnJlbnQgKCR7ZXhpc3RpbmdTZWFyY2h9KWAsIGhpbnQ6ICdhbHJlYWR5IGNvbmZpZ3VyZWQnIH0pXG4gIH1cblxuICBpZiAoaXNBbnRocm9waWMpIHtcbiAgICBvcHRpb25zLnB1c2goe1xuICAgICAgdmFsdWU6ICdhbnRocm9waWMtbmF0aXZlJyxcbiAgICAgIGxhYmVsOiAnQW50aHJvcGljIGJ1aWx0LWluIHdlYiBzZWFyY2gnLFxuICAgICAgaGludDogJ25vIEFQSSBrZXkgbmVlZGVkIFx1MjAxNCBhbHJlYWR5IGluY2x1ZGVkIHdpdGggQ2xhdWRlJyxcbiAgICB9KVxuICB9XG5cbiAgb3B0aW9ucy5wdXNoKFxuICAgIHsgdmFsdWU6ICdicmF2ZScsIGxhYmVsOiAnQnJhdmUgU2VhcmNoJywgaGludDogJ3JlcXVpcmVzIEFQSSBrZXkgXHUyMDE0IGJyYXZlLmNvbS9zZWFyY2gvYXBpJyB9LFxuICAgIHsgdmFsdWU6ICd0YXZpbHknLCBsYWJlbDogJ1RhdmlseScsIGhpbnQ6ICdyZXF1aXJlcyBBUEkga2V5IFx1MjAxNCB0YXZpbHkuY29tJyB9LFxuICAgIHsgdmFsdWU6ICdza2lwJywgbGFiZWw6ICdTa2lwIGZvciBub3cnLCBoaW50OiAndXNlIC9zZWFyY2gtcHJvdmlkZXIgaW5zaWRlIEdTRCBsYXRlcicgfSxcbiAgKVxuXG4gIGNvbnN0IGNob2ljZSA9IGF3YWl0IHAuc2VsZWN0KHtcbiAgICBtZXNzYWdlOiAnSG93IGRvIHlvdSB3YW50IHRvIHNlYXJjaCB0aGUgd2ViPycsXG4gICAgb3B0aW9ucyxcbiAgfSlcblxuICBpZiAocC5pc0NhbmNlbChjaG9pY2UpIHx8IGNob2ljZSA9PT0gJ3NraXAnKSByZXR1cm4gbnVsbFxuICBpZiAoY2hvaWNlID09PSAna2VlcCcpIHJldHVybiBleGlzdGluZ1NlYXJjaFxuXG4gIGlmIChjaG9pY2UgPT09ICdhbnRocm9waWMtbmF0aXZlJykge1xuICAgIHAubG9nLnN1Y2Nlc3MoYFdlYiBzZWFyY2g6ICR7cGMuZ3JlZW4oJ0FudGhyb3BpYyBidWlsdC1pbicpfSBcdTIwMTQgd29ya3Mgb3V0IG9mIHRoZSBib3hgKVxuICAgIHJldHVybiAnQW50aHJvcGljIGJ1aWx0LWluJ1xuICB9XG5cbiAgaWYgKGNob2ljZSA9PT0gJ2JyYXZlJykge1xuICAgIGNvbnN0IGtleSA9IGF3YWl0IHAucGFzc3dvcmQoe1xuICAgICAgbWVzc2FnZTogYFBhc3RlIHlvdXIgQnJhdmUgU2VhcmNoIEFQSSBrZXkgJHtwYy5kaW0oJyhicmF2ZS5jb20vc2VhcmNoL2FwaSknKX06YCxcbiAgICAgIG1hc2s6ICdcdTI1Q0YnLFxuICAgIH0pXG4gICAgaWYgKHAuaXNDYW5jZWwoa2V5KSB8fCAhKGtleSBhcyBzdHJpbmcpPy50cmltKCkpIHJldHVybiBudWxsXG4gICAgY29uc3QgdHJpbW1lZCA9IChrZXkgYXMgc3RyaW5nKS50cmltKClcbiAgICBhdXRoU3RvcmFnZS5zZXQoJ2JyYXZlJywgeyB0eXBlOiAnYXBpX2tleScsIGtleTogdHJpbW1lZCB9KVxuICAgIHByb2Nlc3MuZW52LkJSQVZFX0FQSV9LRVkgPSB0cmltbWVkXG4gICAgcC5sb2cuc3VjY2VzcyhgV2ViIHNlYXJjaDogJHtwYy5ncmVlbignQnJhdmUgU2VhcmNoJyl9IGNvbmZpZ3VyZWRgKVxuICAgIHJldHVybiAnQnJhdmUgU2VhcmNoJ1xuICB9XG5cbiAgaWYgKGNob2ljZSA9PT0gJ3RhdmlseScpIHtcbiAgICBjb25zdCBrZXkgPSBhd2FpdCBwLnBhc3N3b3JkKHtcbiAgICAgIG1lc3NhZ2U6IGBQYXN0ZSB5b3VyIFRhdmlseSBBUEkga2V5ICR7cGMuZGltKCcodGF2aWx5LmNvbSknKX06YCxcbiAgICAgIG1hc2s6ICdcdTI1Q0YnLFxuICAgIH0pXG4gICAgaWYgKHAuaXNDYW5jZWwoa2V5KSB8fCAhKGtleSBhcyBzdHJpbmcpPy50cmltKCkpIHJldHVybiBudWxsXG4gICAgY29uc3QgdHJpbW1lZCA9IChrZXkgYXMgc3RyaW5nKS50cmltKClcbiAgICBhdXRoU3RvcmFnZS5zZXQoJ3RhdmlseScsIHsgdHlwZTogJ2FwaV9rZXknLCBrZXk6IHRyaW1tZWQgfSlcbiAgICBwcm9jZXNzLmVudi5UQVZJTFlfQVBJX0tFWSA9IHRyaW1tZWRcbiAgICBwLmxvZy5zdWNjZXNzKGBXZWIgc2VhcmNoOiAke3BjLmdyZWVuKCdUYXZpbHknKX0gY29uZmlndXJlZGApXG4gICAgcmV0dXJuICdUYXZpbHknXG4gIH1cblxuICByZXR1cm4gbnVsbFxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVG9vbCBBUEkgS2V5cyBTdGVwIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuVG9vbEtleXNTdGVwKFxuICBwOiBDbGFja01vZHVsZSxcbiAgcGM6IFBpY29Nb2R1bGUsXG4gIGF1dGhTdG9yYWdlOiBBdXRoU3RvcmFnZSxcbik6IFByb21pc2U8bnVtYmVyPiB7XG4gIC8vIEZpbHRlciB0byBrZXlzIG5vdCBhbHJlYWR5IGNvbmZpZ3VyZWRcbiAgY29uc3QgbWlzc2luZyA9IFRPT0xfS0VZUy5maWx0ZXIodGsgPT4gIWF1dGhTdG9yYWdlLmhhcyh0ay5wcm92aWRlcikgJiYgIXByb2Nlc3MuZW52W3RrLmVudlZhcl0pXG4gIGlmIChtaXNzaW5nLmxlbmd0aCA9PT0gMCkgcmV0dXJuIDBcblxuICBjb25zdCB3YW50VG9vbEtleXMgPSBhd2FpdCBwLmNvbmZpcm0oe1xuICAgIG1lc3NhZ2U6ICdTZXQgdXAgb3B0aW9uYWwgdG9vbCBBUEkga2V5cz8gKHdlYiBzZWFyY2gsIGRvY3MsIGV0Yy4pJyxcbiAgICBpbml0aWFsVmFsdWU6IGZhbHNlLFxuICB9KVxuXG4gIGlmIChwLmlzQ2FuY2VsKHdhbnRUb29sS2V5cykgfHwgIXdhbnRUb29sS2V5cykgcmV0dXJuIDBcblxuICBsZXQgc2F2ZWRDb3VudCA9IDBcbiAgZm9yIChjb25zdCB0ayBvZiBtaXNzaW5nKSB7XG4gICAgY29uc3Qga2V5ID0gYXdhaXQgcC5wYXNzd29yZCh7XG4gICAgICBtZXNzYWdlOiBgJHt0ay5sYWJlbH0gJHtwYy5kaW0oYCgke3RrLmhpbnR9KWApfSBcdTIwMTQgRW50ZXIgdG8gc2tpcDpgLFxuICAgICAgbWFzazogJ1x1MjVDRicsXG4gICAgfSlcblxuICAgIGlmIChwLmlzQ2FuY2VsKGtleSkpIGJyZWFrXG5cbiAgICBjb25zdCB0cmltbWVkID0gKGtleSBhcyBzdHJpbmcgfCB1bmRlZmluZWQpPy50cmltKClcbiAgICBpZiAodHJpbW1lZCkge1xuICAgICAgYXV0aFN0b3JhZ2Uuc2V0KHRrLnByb3ZpZGVyLCB7IHR5cGU6ICdhcGlfa2V5Jywga2V5OiB0cmltbWVkIH0pXG4gICAgICBwcm9jZXNzLmVudlt0ay5lbnZWYXJdID0gdHJpbW1lZFxuICAgICAgcC5sb2cuc3VjY2VzcyhgJHt0ay5sYWJlbH0gc2F2ZWRgKVxuICAgICAgc2F2ZWRDb3VudCsrXG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIFN0b3JlIGVtcHR5IGtleSBzbyB3aXphcmQgZG9lc24ndCByZS1hc2sgb24gbmV4dCBsYXVuY2hcbiAgICAgIGF1dGhTdG9yYWdlLnNldCh0ay5wcm92aWRlciwgeyB0eXBlOiAnYXBpX2tleScsIGtleTogJycgfSlcbiAgICAgIHAubG9nLmluZm8ocGMuZGltKGAke3RrLmxhYmVsfSBza2lwcGVkYCkpXG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHNhdmVkQ291bnRcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFJlbW90ZSBRdWVzdGlvbnMgU3RlcCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1blJlbW90ZVF1ZXN0aW9uc1N0ZXAoXG4gIHA6IENsYWNrTW9kdWxlLFxuICBwYzogUGljb01vZHVsZSxcbiAgYXV0aFN0b3JhZ2U6IEF1dGhTdG9yYWdlLFxuKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG4gIC8vIENoZWNrIGV4aXN0aW5nIGNvbmZpZyBcdTIwMTQgdXNlIGdldENyZWRlbnRpYWxzRm9yUHJvdmlkZXIgdG8gc2tpcCBlbXB0eS1rZXkgZW50cmllc1xuICBjb25zdCBoYXNWYWxpZEtleSA9IChwcm92aWRlcjogc3RyaW5nKSA9PlxuICAgIGF1dGhTdG9yYWdlXG4gICAgICAuZ2V0Q3JlZGVudGlhbHNGb3JQcm92aWRlcihwcm92aWRlcilcbiAgICAgIC5zb21lKChjOiBBcGlLZXlDcmVkZW50aWFsKSA9PiBjLnR5cGUgPT09ICdhcGlfa2V5JyAmJiB0eXBlb2YgYy5rZXkgPT09ICdzdHJpbmcnICYmIGMua2V5Lmxlbmd0aCA+IDApXG4gIGNvbnN0IGhhc0Rpc2NvcmQgPSBoYXNWYWxpZEtleSgnZGlzY29yZF9ib3QnKVxuICBjb25zdCBoYXNTbGFjayA9IGhhc1ZhbGlkS2V5KCdzbGFja19ib3QnKVxuICBjb25zdCBoYXNUZWxlZ3JhbSA9IGhhc1ZhbGlkS2V5KCd0ZWxlZ3JhbV9ib3QnKVxuICBjb25zdCBleGlzdGluZ0NoYW5uZWwgPSBoYXNEaXNjb3JkID8gJ0Rpc2NvcmQnIDogaGFzU2xhY2sgPyAnU2xhY2snIDogaGFzVGVsZWdyYW0gPyAnVGVsZWdyYW0nIDogbnVsbFxuXG4gIHR5cGUgUmVtb3RlT3B0aW9uID0geyB2YWx1ZTogc3RyaW5nOyBsYWJlbDogc3RyaW5nOyBoaW50Pzogc3RyaW5nIH1cbiAgY29uc3Qgb3B0aW9uczogUmVtb3RlT3B0aW9uW10gPSBbXVxuXG4gIGlmIChleGlzdGluZ0NoYW5uZWwpIHtcbiAgICBvcHRpb25zLnB1c2goeyB2YWx1ZTogJ2tlZXAnLCBsYWJlbDogYEtlZXAgY3VycmVudCAoJHtleGlzdGluZ0NoYW5uZWx9KWAsIGhpbnQ6ICdhbHJlYWR5IGNvbmZpZ3VyZWQnIH0pXG4gIH1cblxuICBvcHRpb25zLnB1c2goXG4gICAgeyB2YWx1ZTogJ2Rpc2NvcmQnLCBsYWJlbDogJ0Rpc2NvcmQnLCBoaW50OiAncmVjZWl2ZSBxdWVzdGlvbnMgaW4gYSBEaXNjb3JkIGNoYW5uZWwnIH0sXG4gICAgeyB2YWx1ZTogJ3NsYWNrJywgbGFiZWw6ICdTbGFjaycsIGhpbnQ6ICdyZWNlaXZlIHF1ZXN0aW9ucyBpbiBhIFNsYWNrIGNoYW5uZWwnIH0sXG4gICAgeyB2YWx1ZTogJ3RlbGVncmFtJywgbGFiZWw6ICdUZWxlZ3JhbScsIGhpbnQ6ICdyZWNlaXZlIHF1ZXN0aW9ucyB2aWEgVGVsZWdyYW0gYm90JyB9LFxuICAgIHsgdmFsdWU6ICdza2lwJywgbGFiZWw6ICdTa2lwIGZvciBub3cnLCBoaW50OiAndXNlIC9nc2QgcmVtb3RlIGluc2lkZSBHU0QgbGF0ZXInIH0sXG4gIClcblxuICBjb25zdCBjaG9pY2UgPSBhd2FpdCBwLnNlbGVjdCh7XG4gICAgbWVzc2FnZTogJ1NldCB1cCByZW1vdGUgcXVlc3Rpb25zPyAoZ2V0IG5vdGlmaWVkIHdoZW4gR1NEIG5lZWRzIGlucHV0KScsXG4gICAgb3B0aW9ucyxcbiAgfSlcblxuICBpZiAocC5pc0NhbmNlbChjaG9pY2UpIHx8IGNob2ljZSA9PT0gJ3NraXAnKSByZXR1cm4gbnVsbFxuICBpZiAoY2hvaWNlID09PSAna2VlcCcpIHJldHVybiBleGlzdGluZ0NoYW5uZWxcblxuICBpZiAoY2hvaWNlID09PSAnZGlzY29yZCcpIHtcbiAgICBjb25zdCB0b2tlbiA9IGF3YWl0IHAucGFzc3dvcmQoe1xuICAgICAgbWVzc2FnZTogJ1Bhc3RlIHlvdXIgRGlzY29yZCBib3QgdG9rZW46JyxcbiAgICAgIG1hc2s6ICdcdTI1Q0YnLFxuICAgIH0pXG4gICAgaWYgKHAuaXNDYW5jZWwodG9rZW4pIHx8ICEodG9rZW4gYXMgc3RyaW5nKT8udHJpbSgpKSByZXR1cm4gbnVsbFxuICAgIGNvbnN0IHRyaW1tZWQgPSAodG9rZW4gYXMgc3RyaW5nKS50cmltKClcblxuICAgIGF1dGhTdG9yYWdlLnNldCgnZGlzY29yZF9ib3QnLCB7IHR5cGU6ICdhcGlfa2V5Jywga2V5OiB0cmltbWVkIH0pXG4gICAgcHJvY2Vzcy5lbnYuRElTQ09SRF9CT1RfVE9LRU4gPSB0cmltbWVkXG5cbiAgICBjb25zdCBjaGFubmVsTmFtZSA9IGF3YWl0IHJ1bkRpc2NvcmRDaGFubmVsU3RlcChwLCBwYywgdHJpbW1lZClcbiAgICByZXR1cm4gY2hhbm5lbE5hbWUgPyBgRGlzY29yZCAjJHtjaGFubmVsTmFtZX1gIDogJ0Rpc2NvcmQnXG4gIH1cblxuICBpZiAoY2hvaWNlID09PSAnc2xhY2snKSB7XG4gICAgY29uc3QgdG9rZW4gPSBhd2FpdCBwLnBhc3N3b3JkKHtcbiAgICAgIG1lc3NhZ2U6IGBQYXN0ZSB5b3VyIFNsYWNrIGJvdCB0b2tlbiAke3BjLmRpbSgnKHhveGItLi4uKScpfTpgLFxuICAgICAgbWFzazogJ1x1MjVDRicsXG4gICAgfSlcbiAgICBpZiAocC5pc0NhbmNlbCh0b2tlbikgfHwgISh0b2tlbiBhcyBzdHJpbmcpPy50cmltKCkpIHJldHVybiBudWxsXG4gICAgY29uc3QgdHJpbW1lZCA9ICh0b2tlbiBhcyBzdHJpbmcpLnRyaW0oKVxuICAgIGlmICghdHJpbW1lZC5zdGFydHNXaXRoKCd4b3hiLScpKSB7XG4gICAgICBwLmxvZy53YXJuKCdJbnZhbGlkIHRva2VuIGZvcm1hdCBcdTIwMTQgU2xhY2sgYm90IHRva2VucyBzdGFydCB3aXRoIHhveGItLicpXG4gICAgICByZXR1cm4gbnVsbFxuICAgIH1cblxuICAgIC8vIFZhbGlkYXRlXG4gICAgY29uc3QgcyA9IHAuc3Bpbm5lcigpXG4gICAgcy5zdGFydCgnVmFsaWRhdGluZyBTbGFjayB0b2tlbi4uLicpXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKCdodHRwczovL3NsYWNrLmNvbS9hcGkvYXV0aC50ZXN0Jywge1xuICAgICAgICBoZWFkZXJzOiB7IEF1dGhvcml6YXRpb246IGBCZWFyZXIgJHt0cmltbWVkfWAgfSxcbiAgICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDE1XzAwMCksXG4gICAgICB9KVxuICAgICAgY29uc3QgZGF0YSA9IGF3YWl0IHJlcy5qc29uKCkgYXMgU2xhY2tBdXRoVGVzdFJlc3BvbnNlXG4gICAgICBpZiAoIWRhdGE/Lm9rKSB7XG4gICAgICAgIHMuc3RvcCgnU2xhY2sgdG9rZW4gdmFsaWRhdGlvbiBmYWlsZWQnKVxuICAgICAgICByZXR1cm4gbnVsbFxuICAgICAgfVxuICAgICAgcy5zdG9wKGBTbGFjayBhdXRoZW50aWNhdGVkIGFzICR7cGMuZ3JlZW4oZGF0YS51c2VyID8/ICdib3QnKX1gKVxuICAgIH0gY2F0Y2gge1xuICAgICAgcy5zdG9wKCdDb3VsZCBub3QgcmVhY2ggU2xhY2sgQVBJJylcbiAgICAgIHJldHVybiBudWxsXG4gICAgfVxuXG4gICAgYXV0aFN0b3JhZ2Uuc2V0KCdzbGFja19ib3QnLCB7IHR5cGU6ICdhcGlfa2V5Jywga2V5OiB0cmltbWVkIH0pXG4gICAgcHJvY2Vzcy5lbnYuU0xBQ0tfQk9UX1RPS0VOID0gdHJpbW1lZFxuXG4gICAgY29uc3QgY2hhbm5lbElkID0gYXdhaXQgcC50ZXh0KHtcbiAgICAgIG1lc3NhZ2U6ICdQYXN0ZSB0aGUgU2xhY2sgY2hhbm5lbCBJRCAoZS5nLiBDMDEyMzQ1Njc4OSk6JyxcbiAgICAgIHZhbGlkYXRlOiAodmFsKSA9PiB7XG4gICAgICAgIGlmICghdmFsIHx8ICEvXltBLVowLTldezksMTJ9JC8udGVzdCh2YWwudHJpbSgpKSkgcmV0dXJuICdFeHBlY3RlZCA5LTEyIHVwcGVyY2FzZSBhbHBoYW51bWVyaWMgY2hhcmFjdGVycydcbiAgICAgIH0sXG4gICAgfSlcbiAgICBpZiAocC5pc0NhbmNlbChjaGFubmVsSWQpIHx8ICFjaGFubmVsSWQpIHJldHVybiBudWxsXG5cbiAgICBjb25zdCB7IHNhdmVSZW1vdGVRdWVzdGlvbnNDb25maWcgfSA9IGF3YWl0IGltcG9ydCgnLi9yZW1vdGUtcXVlc3Rpb25zLWNvbmZpZy5qcycpXG4gICAgc2F2ZVJlbW90ZVF1ZXN0aW9uc0NvbmZpZygnc2xhY2snLCAoY2hhbm5lbElkIGFzIHN0cmluZykudHJpbSgpKVxuICAgIHAubG9nLnN1Y2Nlc3MoYFNsYWNrIGNoYW5uZWw6ICR7cGMuZ3JlZW4oKGNoYW5uZWxJZCBhcyBzdHJpbmcpLnRyaW0oKSl9YClcbiAgICByZXR1cm4gJ1NsYWNrJ1xuICB9XG5cbiAgaWYgKGNob2ljZSA9PT0gJ3RlbGVncmFtJykge1xuICAgIGNvbnN0IHRva2VuID0gYXdhaXQgcC5wYXNzd29yZCh7XG4gICAgICBtZXNzYWdlOiAnUGFzdGUgeW91ciBUZWxlZ3JhbSBib3QgdG9rZW4gKGZyb20gQEJvdEZhdGhlcik6JyxcbiAgICAgIG1hc2s6ICdcdTI1Q0YnLFxuICAgIH0pXG4gICAgaWYgKHAuaXNDYW5jZWwodG9rZW4pIHx8ICEodG9rZW4gYXMgc3RyaW5nKT8udHJpbSgpKSByZXR1cm4gbnVsbFxuICAgIGNvbnN0IHRyaW1tZWQgPSAodG9rZW4gYXMgc3RyaW5nKS50cmltKClcbiAgICBpZiAoIS9eXFxkKzpbQS1aYS16MC05Xy1dKyQvLnRlc3QodHJpbW1lZCkpIHtcbiAgICAgIHAubG9nLndhcm4oJ0ludmFsaWQgdG9rZW4gZm9ybWF0IFx1MjAxNCBUZWxlZ3JhbSBib3QgdG9rZW5zIGxvb2sgbGlrZSAxMjM0NTY3ODk6QUJDZGVmR0hJLi4uJylcbiAgICAgIHJldHVybiBudWxsXG4gICAgfVxuXG4gICAgLy8gVmFsaWRhdGVcbiAgICBjb25zdCBzID0gcC5zcGlubmVyKClcbiAgICBzLnN0YXJ0KCdWYWxpZGF0aW5nIFRlbGVncmFtIGJvdCB0b2tlbi4uLicpXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwczovL2FwaS50ZWxlZ3JhbS5vcmcvYm90JHt0cmltbWVkfS9nZXRNZWAsIHtcbiAgICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDE1XzAwMCksXG4gICAgICB9KVxuICAgICAgY29uc3QgZGF0YSA9IGF3YWl0IHJlcy5qc29uKCkgYXMgVGVsZWdyYW1HZXRNZVJlc3BvbnNlXG4gICAgICBpZiAoIWRhdGE/Lm9rIHx8ICFkYXRhPy5yZXN1bHQ/LmlkKSB7XG4gICAgICAgIHMuc3RvcCgnVGVsZWdyYW0gdG9rZW4gdmFsaWRhdGlvbiBmYWlsZWQnKVxuICAgICAgICByZXR1cm4gbnVsbFxuICAgICAgfVxuICAgICAgcy5zdG9wKGBUZWxlZ3JhbSBib3Q6ICR7cGMuZ3JlZW4oZGF0YS5yZXN1bHQuZmlyc3RfbmFtZSA/PyBkYXRhLnJlc3VsdC51c2VybmFtZSA/PyAnYm90Jyl9YClcbiAgICB9IGNhdGNoIHtcbiAgICAgIHMuc3RvcCgnQ291bGQgbm90IHJlYWNoIFRlbGVncmFtIEFQSScpXG4gICAgICByZXR1cm4gbnVsbFxuICAgIH1cblxuICAgIGF1dGhTdG9yYWdlLnNldCgndGVsZWdyYW1fYm90JywgeyB0eXBlOiAnYXBpX2tleScsIGtleTogdHJpbW1lZCB9KVxuICAgIHByb2Nlc3MuZW52LlRFTEVHUkFNX0JPVF9UT0tFTiA9IHRyaW1tZWRcblxuICAgIGNvbnN0IGNoYXRJZCA9IGF3YWl0IHAudGV4dCh7XG4gICAgICBtZXNzYWdlOiAnUGFzdGUgdGhlIFRlbGVncmFtIGNoYXQgSUQgKGUuZy4gLTEwMDEyMzQ1Njc4OTApOicsXG4gICAgICB2YWxpZGF0ZTogKHZhbCkgPT4ge1xuICAgICAgICBpZiAoIXZhbCB8fCAhL14tP1xcZHs1LDIwfSQvLnRlc3QodmFsLnRyaW0oKSkpIHJldHVybiAnRXhwZWN0ZWQgYSBudW1lcmljIGNoYXQgSUQgKGNhbiBiZSBuZWdhdGl2ZSBmb3IgZ3JvdXBzKSdcbiAgICAgIH0sXG4gICAgfSlcbiAgICBpZiAocC5pc0NhbmNlbChjaGF0SWQpIHx8ICFjaGF0SWQpIHJldHVybiBudWxsXG4gICAgY29uc3QgdHJpbW1lZENoYXRJZCA9IChjaGF0SWQgYXMgc3RyaW5nKS50cmltKClcblxuICAgIC8vIFRlc3Qgc2VuZFxuICAgIGNvbnN0IHRzID0gcC5zcGlubmVyKClcbiAgICB0cy5zdGFydCgnVGVzdGluZyBtZXNzYWdlIGRlbGl2ZXJ5Li4uJylcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHBzOi8vYXBpLnRlbGVncmFtLm9yZy9ib3Qke3RyaW1tZWR9L3NlbmRNZXNzYWdlYCwge1xuICAgICAgICBtZXRob2Q6ICdQT1NUJyxcbiAgICAgICAgaGVhZGVyczogeyAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nIH0sXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgY2hhdF9pZDogdHJpbW1lZENoYXRJZCwgdGV4dDogJ0dTRCByZW1vdGUgcXVlc3Rpb25zIGNvbm5lY3RlZC4nIH0pLFxuICAgICAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoMTVfMDAwKSxcbiAgICAgIH0pXG4gICAgICBjb25zdCBkYXRhID0gYXdhaXQgcmVzLmpzb24oKSBhcyBUZWxlZ3JhbUdldE1lUmVzcG9uc2VcbiAgICAgIGlmICghZGF0YT8ub2spIHtcbiAgICAgICAgdHMuc3RvcChgQ291bGQgbm90IHNlbmQgdG8gY2hhdDogJHtkYXRhPy5kZXNjcmlwdGlvbiA/PyAndW5rbm93biBlcnJvcid9YClcbiAgICAgICAgcmV0dXJuIG51bGxcbiAgICAgIH1cbiAgICAgIHRzLnN0b3AoJ1Rlc3QgbWVzc2FnZSBzZW50JylcbiAgICB9IGNhdGNoIHtcbiAgICAgIHRzLnN0b3AoJ0NvdWxkIG5vdCByZWFjaCBUZWxlZ3JhbSBBUEknKVxuICAgICAgcmV0dXJuIG51bGxcbiAgICB9XG5cbiAgICBjb25zdCB7IHNhdmVSZW1vdGVRdWVzdGlvbnNDb25maWcgfSA9IGF3YWl0IGltcG9ydCgnLi9yZW1vdGUtcXVlc3Rpb25zLWNvbmZpZy5qcycpXG4gICAgc2F2ZVJlbW90ZVF1ZXN0aW9uc0NvbmZpZygndGVsZWdyYW0nLCB0cmltbWVkQ2hhdElkKVxuICAgIHAubG9nLnN1Y2Nlc3MoYFRlbGVncmFtIGNoYXQ6ICR7cGMuZ3JlZW4odHJpbW1lZENoYXRJZCl9YClcbiAgICByZXR1cm4gJ1RlbGVncmFtJ1xuICB9XG5cbiAgcmV0dXJuIG51bGxcbn1cblxuYXN5bmMgZnVuY3Rpb24gcnVuRGlzY29yZENoYW5uZWxTdGVwKHA6IENsYWNrTW9kdWxlLCBwYzogUGljb01vZHVsZSwgdG9rZW46IHN0cmluZyk6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICBjb25zdCBoZWFkZXJzID0geyBBdXRob3JpemF0aW9uOiBgQm90ICR7dG9rZW59YCB9XG5cbiAgLy8gVmFsaWRhdGUgdG9rZW5cbiAgY29uc3QgcyA9IHAuc3Bpbm5lcigpXG4gIHMuc3RhcnQoJ1ZhbGlkYXRpbmcgRGlzY29yZCBib3QgdG9rZW4uLi4nKVxuICBsZXQgYXV0aDogRGlzY29yZFVzZXJSZXNwb25zZVxuICB0cnkge1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKCdodHRwczovL2Rpc2NvcmQuY29tL2FwaS92MTAvdXNlcnMvQG1lJywgeyBoZWFkZXJzLCBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoMTVfMDAwKSB9KVxuICAgIGF1dGggPSBhd2FpdCByZXMuanNvbigpXG4gIH0gY2F0Y2gge1xuICAgIHMuc3RvcCgnQ291bGQgbm90IHJlYWNoIERpc2NvcmQgQVBJJylcbiAgICByZXR1cm4gbnVsbFxuICB9XG4gIGlmICghYXV0aD8uaWQpIHtcbiAgICBzLnN0b3AoJ0Rpc2NvcmQgdG9rZW4gdmFsaWRhdGlvbiBmYWlsZWQnKVxuICAgIHJldHVybiBudWxsXG4gIH1cbiAgcy5zdG9wKGBCb3QgYXV0aGVudGljYXRlZCBhcyAke3BjLmdyZWVuKGF1dGgudXNlcm5hbWUgPz8gJ3Vua25vd24nKX1gKVxuXG4gIC8vIEZldGNoIGd1aWxkc1xuICBsZXQgZ3VpbGRzOiBBcnJheTx7IGlkOiBzdHJpbmc7IG5hbWU6IHN0cmluZyB9PlxuICB0cnkge1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKCdodHRwczovL2Rpc2NvcmQuY29tL2FwaS92MTAvdXNlcnMvQG1lL2d1aWxkcycsIHsgaGVhZGVycywgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDE1XzAwMCkgfSlcbiAgICBjb25zdCBkYXRhID0gYXdhaXQgcmVzLmpzb24oKVxuICAgIGd1aWxkcyA9IEFycmF5LmlzQXJyYXkoZGF0YSkgPyBkYXRhIDogW11cbiAgfSBjYXRjaCB7XG4gICAgcC5sb2cud2FybignQ291bGQgbm90IGZldGNoIERpc2NvcmQgc2VydmVycyBcdTIwMTQgY29uZmlndXJlIGNoYW5uZWwgbGF0ZXIgd2l0aCAvZ3NkIHJlbW90ZSBkaXNjb3JkJylcbiAgICByZXR1cm4gbnVsbFxuICB9XG5cbiAgaWYgKGd1aWxkcy5sZW5ndGggPT09IDApIHtcbiAgICBwLmxvZy53YXJuKCdCb3QgaXMgbm90IGluIGFueSBEaXNjb3JkIHNlcnZlcnMgXHUyMDE0IGNvbmZpZ3VyZSBjaGFubmVsIGxhdGVyIHdpdGggL2dzZCByZW1vdGUgZGlzY29yZCcpXG4gICAgcmV0dXJuIG51bGxcbiAgfVxuXG4gIC8vIFNlbGVjdCBndWlsZFxuICBsZXQgZ3VpbGRJZDogc3RyaW5nXG4gIGxldCBndWlsZE5hbWU6IHN0cmluZ1xuICBpZiAoZ3VpbGRzLmxlbmd0aCA9PT0gMSkge1xuICAgIGd1aWxkSWQgPSBndWlsZHNbMF0uaWRcbiAgICBndWlsZE5hbWUgPSBndWlsZHNbMF0ubmFtZVxuICAgIHAubG9nLmluZm8oYFNlcnZlcjogJHtwYy5ncmVlbihndWlsZE5hbWUpfWApXG4gIH0gZWxzZSB7XG4gICAgY29uc3QgY2hvaWNlID0gYXdhaXQgcC5zZWxlY3Qoe1xuICAgICAgbWVzc2FnZTogJ1doaWNoIERpc2NvcmQgc2VydmVyPycsXG4gICAgICBvcHRpb25zOiBndWlsZHMubWFwKGcgPT4gKHsgdmFsdWU6IGcuaWQsIGxhYmVsOiBnLm5hbWUgfSkpLFxuICAgIH0pXG4gICAgaWYgKHAuaXNDYW5jZWwoY2hvaWNlKSkgcmV0dXJuIG51bGxcbiAgICBndWlsZElkID0gY2hvaWNlIGFzIHN0cmluZ1xuICAgIGd1aWxkTmFtZSA9IGd1aWxkcy5maW5kKGcgPT4gZy5pZCA9PT0gZ3VpbGRJZCk/Lm5hbWUgPz8gZ3VpbGRJZFxuICB9XG5cbiAgLy8gRmV0Y2ggY2hhbm5lbHNcbiAgbGV0IGNoYW5uZWxzOiBEaXNjb3JkQ2hhbm5lbFtdXG4gIHRyeSB7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHBzOi8vZGlzY29yZC5jb20vYXBpL3YxMC9ndWlsZHMvJHtndWlsZElkfS9jaGFubmVsc2AsIHsgaGVhZGVycywgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDE1XzAwMCkgfSlcbiAgICBjb25zdCBkYXRhID0gYXdhaXQgcmVzLmpzb24oKVxuICAgIGNoYW5uZWxzID0gQXJyYXkuaXNBcnJheShkYXRhKVxuICAgICAgPyBkYXRhLmZpbHRlcigoY2gpOiBjaCBpcyBEaXNjb3JkQ2hhbm5lbCA9PlxuICAgICAgICAgIHR5cGVvZiBjaCA9PT0gJ29iamVjdCcgJiZcbiAgICAgICAgICBjaCAhPT0gbnVsbCAmJlxuICAgICAgICAgIHR5cGVvZiAoY2ggYXMgeyBpZD86IHVua25vd24gfSkuaWQgPT09ICdzdHJpbmcnICYmXG4gICAgICAgICAgdHlwZW9mIChjaCBhcyB7IG5hbWU/OiB1bmtub3duIH0pLm5hbWUgPT09ICdzdHJpbmcnICYmXG4gICAgICAgICAgKChjaCBhcyB7IHR5cGU/OiB1bmtub3duIH0pLnR5cGUgPT09IDAgfHwgKGNoIGFzIHsgdHlwZT86IHVua25vd24gfSkudHlwZSA9PT0gNSksXG4gICAgICAgIClcbiAgICAgIDogW11cbiAgfSBjYXRjaCB7XG4gICAgcC5sb2cud2FybignQ291bGQgbm90IGZldGNoIGNoYW5uZWxzIFx1MjAxNCBjb25maWd1cmUgbGF0ZXIgd2l0aCAvZ3NkIHJlbW90ZSBkaXNjb3JkJylcbiAgICByZXR1cm4gbnVsbFxuICB9XG5cbiAgaWYgKGNoYW5uZWxzLmxlbmd0aCA9PT0gMCkge1xuICAgIHAubG9nLndhcm4oJ05vIHRleHQgY2hhbm5lbHMgZm91bmQgXHUyMDE0IGNvbmZpZ3VyZSBsYXRlciB3aXRoIC9nc2QgcmVtb3RlIGRpc2NvcmQnKVxuICAgIHJldHVybiBudWxsXG4gIH1cblxuICAvLyBTZWxlY3QgY2hhbm5lbFxuICBjb25zdCBNQU5VQUxfVkFMVUUgPSAnX19tYW51YWxfXydcbiAgY29uc3QgY2hhbm5lbENob2ljZSA9IGF3YWl0IHAuc2VsZWN0KHtcbiAgICBtZXNzYWdlOiAnV2hpY2ggY2hhbm5lbCBzaG91bGQgR1NEIHVzZSBmb3IgcmVtb3RlIHF1ZXN0aW9ucz8nLFxuICAgIG9wdGlvbnM6IFtcbiAgICAgIC4uLmNoYW5uZWxzLm1hcChjaCA9PiAoeyB2YWx1ZTogY2guaWQsIGxhYmVsOiBgIyR7Y2gubmFtZX1gIH0pKSxcbiAgICAgIHsgdmFsdWU6IE1BTlVBTF9WQUxVRSwgbGFiZWw6ICdFbnRlciBjaGFubmVsIElEIG1hbnVhbGx5JyB9LFxuICAgIF0sXG4gIH0pXG4gIGlmIChwLmlzQ2FuY2VsKGNoYW5uZWxDaG9pY2UpKSByZXR1cm4gbnVsbFxuXG4gIGxldCBjaGFubmVsSWQ6IHN0cmluZ1xuICBpZiAoY2hhbm5lbENob2ljZSA9PT0gTUFOVUFMX1ZBTFVFKSB7XG4gICAgY29uc3QgbWFudWFsSWQgPSBhd2FpdCBwLnRleHQoe1xuICAgICAgbWVzc2FnZTogJ1Bhc3RlIHRoZSBEaXNjb3JkIGNoYW5uZWwgSUQ6JyxcbiAgICAgIHBsYWNlaG9sZGVyOiAnMTIzNDU2Nzg5MDEyMzQ1Njc4OScsXG4gICAgICB2YWxpZGF0ZTogKHZhbCkgPT4ge1xuICAgICAgICBpZiAoIXZhbCB8fCAhL15cXGR7MTcsMjB9JC8udGVzdCh2YWwudHJpbSgpKSkgcmV0dXJuICdFeHBlY3RlZCAxNy0yMCBkaWdpdCBudW1lcmljIElEJ1xuICAgICAgfSxcbiAgICB9KVxuICAgIGlmIChwLmlzQ2FuY2VsKG1hbnVhbElkKSB8fCAhbWFudWFsSWQpIHJldHVybiBudWxsXG4gICAgY2hhbm5lbElkID0gKG1hbnVhbElkIGFzIHN0cmluZykudHJpbSgpXG4gIH0gZWxzZSB7XG4gICAgY2hhbm5lbElkID0gY2hhbm5lbENob2ljZSBhcyBzdHJpbmdcbiAgfVxuXG4gIC8vIFNhdmUgcmVtb3RlIHF1ZXN0aW9ucyBjb25maWdcbiAgY29uc3QgeyBzYXZlUmVtb3RlUXVlc3Rpb25zQ29uZmlnIH0gPSBhd2FpdCBpbXBvcnQoJy4vcmVtb3RlLXF1ZXN0aW9ucy1jb25maWcuanMnKVxuICBzYXZlUmVtb3RlUXVlc3Rpb25zQ29uZmlnKCdkaXNjb3JkJywgY2hhbm5lbElkKVxuICBjb25zdCBjaGFubmVsTmFtZSA9IGNoYW5uZWxzLmZpbmQoY2ggPT4gY2guaWQgPT09IGNoYW5uZWxJZCk/Lm5hbWVcbiAgcC5sb2cuc3VjY2VzcyhgRGlzY29yZCBjaGFubmVsOiAke3BjLmdyZWVuKGNoYW5uZWxOYW1lID8gYCMke2NoYW5uZWxOYW1lfWAgOiBjaGFubmVsSWQpfWApXG4gIHJldHVybiBjaGFubmVsTmFtZSA/PyBudWxsXG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFZQSxTQUFTLGdCQUFnQjtBQUN6QixTQUFTLFlBQVksV0FBVyxjQUFjLHFCQUFxQjtBQUNuRSxTQUFTLFNBQVMsWUFBWTtBQUU5QixTQUFTLGtCQUFrQjtBQUMzQixTQUFTLGdCQUFnQjtBQUN6QixTQUFTLHdCQUF3QjtBQUNqQztBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1AsU0FBUyx5QkFBeUI7QUF5Q2xDLE1BQU0sWUFBNkI7QUFBQSxFQUNqQztBQUFBLElBQ0UsVUFBVTtBQUFBLElBQ1YsUUFBUTtBQUFBLElBQ1IsT0FBTztBQUFBLElBQ1AsTUFBTTtBQUFBLEVBQ1I7QUFBQSxFQUNBO0FBQUEsSUFDRSxVQUFVO0FBQUEsSUFDVixRQUFRO0FBQUEsSUFDUixPQUFPO0FBQUEsSUFDUCxNQUFNO0FBQUEsRUFDUjtBQUFBLEVBQ0E7QUFBQSxJQUNFLFVBQVU7QUFBQSxJQUNWLFFBQVE7QUFBQSxJQUNSLE9BQU87QUFBQSxJQUNQLE1BQU07QUFBQSxFQUNSO0FBQ0Y7QUFRQSxNQUFNLG1CQUFtQixNQUFNLEtBQUssb0JBQUksSUFBSTtBQUFBLEVBQzFDLEdBQUcsa0JBQWtCO0FBQUEsRUFDckI7QUFBQSxFQUNBO0FBQ0YsQ0FBQyxD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
