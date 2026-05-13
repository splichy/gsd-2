import {
  AuthStorage
} from "@gsd/pi-coding-agent";
import { existsSync, statSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { getErrorMessage } from "./error-utils.js";
import { gsdHome } from "./gsd-home.js";
const PROVIDER_REGISTRY = [
  // LLM Providers
  { id: "anthropic", label: "Anthropic (Claude)", category: "llm", envVar: "ANTHROPIC_API_KEY", prefixes: ["sk-ant-"], hasOAuth: true, dashboardUrl: "console.anthropic.com" },
  // Claude Code CLI: routes through the local `claude` binary — no API key,
  // authentication is handled by the CLI's own OAuth flow.
  // Referenced by doctor-providers.ts, auto-model-selection.ts, and others;
  // must be in the canonical registry so all consumers see the same catalog.
  // See: https://github.com/gsd-build/gsd-2/issues/4541
  { id: "claude-code", label: "Claude Code CLI", category: "llm", hasOAuth: true },
  { id: "openai", label: "OpenAI", category: "llm", envVar: "OPENAI_API_KEY", prefixes: ["sk-"], dashboardUrl: "platform.openai.com/api-keys" },
  { id: "github-copilot", label: "GitHub Copilot", category: "llm", envVar: "GITHUB_TOKEN", hasOAuth: true },
  { id: "openai-codex", label: "ChatGPT Plus/Pro (Codex)", category: "llm", hasOAuth: true },
  { id: "google-gemini-cli", label: "Google Gemini CLI", category: "llm", hasOAuth: true },
  { id: "google-antigravity", label: "Antigravity", category: "llm", hasOAuth: true },
  { id: "google", label: "Google (Gemini)", category: "llm", envVar: "GEMINI_API_KEY", dashboardUrl: "aistudio.google.com/apikey" },
  { id: "groq", label: "Groq", category: "llm", envVar: "GROQ_API_KEY", dashboardUrl: "console.groq.com" },
  { id: "xai", label: "xAI (Grok)", category: "llm", envVar: "XAI_API_KEY", dashboardUrl: "console.x.ai" },
  { id: "openrouter", label: "OpenRouter", category: "llm", envVar: "OPENROUTER_API_KEY", dashboardUrl: "openrouter.ai/keys" },
  { id: "mistral", label: "Mistral", category: "llm", envVar: "MISTRAL_API_KEY", dashboardUrl: "console.mistral.ai" },
  { id: "minimax", label: "MiniMax", category: "llm", envVar: "MINIMAX_API_KEY", dashboardUrl: "platform.minimax.io" },
  { id: "minimax-cn", label: "MiniMax CN", category: "llm", envVar: "MINIMAX_CN_API_KEY", dashboardUrl: "platform.minimax.io" },
  { id: "ollama-cloud", label: "Ollama Cloud", category: "llm", envVar: "OLLAMA_API_KEY" },
  { id: "custom-openai", label: "Custom (OpenAI-compat)", category: "llm", envVar: "CUSTOM_OPENAI_API_KEY" },
  { id: "cerebras", label: "Cerebras", category: "llm", envVar: "CEREBRAS_API_KEY" },
  { id: "azure-openai-responses", label: "Azure OpenAI", category: "llm", envVar: "AZURE_OPENAI_API_KEY" },
  { id: "alibaba-coding-plan", label: "Alibaba Coding Plan", category: "llm", envVar: "ALIBABA_API_KEY", dashboardUrl: "bailian.console.aliyun.com" },
  { id: "alibaba-dashscope", label: "Alibaba DashScope", category: "llm", envVar: "DASHSCOPE_API_KEY", dashboardUrl: "dashscope.console.aliyun.com" },
  // Tool Keys
  { id: "context7", label: "Context7 Docs", category: "tool", envVar: "CONTEXT7_API_KEY", dashboardUrl: "context7.com/dashboard" },
  { id: "jina", label: "Jina Page Extract", category: "tool", envVar: "JINA_API_KEY", dashboardUrl: "jina.ai/api" },
  // Search Providers
  { id: "tavily", label: "Tavily Search", category: "search", envVar: "TAVILY_API_KEY", dashboardUrl: "tavily.com/app/api-keys" },
  { id: "brave", label: "Brave Search", category: "search", envVar: "BRAVE_API_KEY", dashboardUrl: "brave.com/search/api" },
  // Remote Integrations
  { id: "discord_bot", label: "Discord Bot", category: "remote", envVar: "DISCORD_BOT_TOKEN" },
  { id: "slack_bot", label: "Slack Bot", category: "remote", envVar: "SLACK_BOT_TOKEN", prefixes: ["xoxb-"] },
  { id: "telegram_bot", label: "Telegram Bot", category: "remote", envVar: "TELEGRAM_BOT_TOKEN" }
];
function maskKey(key) {
  if (!key) return "(empty)";
  if (key.length <= 8) return key.slice(0, 2) + "***" + key.slice(-2);
  return key.slice(0, 4) + "***" + key.slice(-4);
}
function formatDuration(ms) {
  if (ms <= 0) return "expired";
  const seconds = Math.floor(ms / 1e3);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return remainMinutes > 0 ? `${hours}h ${remainMinutes}m` : `${hours}h`;
}
function describeCredential(cred) {
  if (cred.type === "api_key") {
    const apiCred = cred;
    if (!apiCred.key) return "empty key";
    return `API key (${maskKey(apiCred.key)})`;
  }
  if (cred.type === "oauth") {
    const oauthCred = cred;
    const remaining = oauthCred.expires - Date.now();
    if (remaining <= 0) return "OAuth (expired \u2014 will auto-refresh)";
    return `OAuth (expires in ${formatDuration(remaining)})`;
  }
  return "unknown";
}
function getAuthPath() {
  return join(gsdHome(), "agent", "auth.json");
}
function getKeyManagerAuthStorage() {
  const authPath = getAuthPath();
  mkdirSync(dirname(authPath), { recursive: true });
  return AuthStorage.create(authPath);
}
function findProvider(idOrLabel) {
  const lower = idOrLabel.toLowerCase();
  return PROVIDER_REGISTRY.find(
    (p) => p.id.toLowerCase() === lower || p.label.toLowerCase() === lower
  );
}
function getAllKeyStatuses(auth) {
  return PROVIDER_REGISTRY.map((provider) => {
    const rawCreds = auth.getCredentialsForProvider(provider.id);
    const creds = rawCreds.filter((c) => !(c.type === "api_key" && !c.key));
    const envKey = provider.envVar ? process.env[provider.envVar] : void 0;
    if (creds.length > 0) {
      const firstCred = creds[0];
      const desc = creds.length > 1 ? `${creds.length} keys (round-robin)` : describeCredential(firstCred);
      return {
        provider,
        configured: true,
        source: "auth.json",
        credentialCount: creds.length,
        description: desc,
        backedOff: auth.areAllCredentialsBackedOff(provider.id)
      };
    }
    if (envKey) {
      return {
        provider,
        configured: true,
        source: "env",
        credentialCount: 1,
        description: `env ${provider.envVar}`,
        backedOff: false
      };
    }
    return {
      provider,
      configured: false,
      source: "none",
      credentialCount: 0,
      description: provider.dashboardUrl ? `not configured (${provider.dashboardUrl})` : provider.envVar ? `not configured (env: ${provider.envVar})` : "not configured",
      backedOff: false
    };
  });
}
function formatKeyDashboard(statuses) {
  const categories = [
    { label: "LLM Providers", key: "llm" },
    { label: "Search Providers", key: "search" },
    { label: "Tool Keys", key: "tool" },
    { label: "Remote Integrations", key: "remote" }
  ];
  const lines = ["GSD API Key Manager\n"];
  for (const cat of categories) {
    const items = statuses.filter((s) => s.provider.category === cat.key);
    if (items.length === 0) continue;
    lines.push(`  ${cat.label}`);
    for (const item of items) {
      const icon = item.configured ? "\u2713" : "\u2717";
      const backoff = item.backedOff ? " [backed off]" : "";
      const pad = item.provider.id.padEnd(20);
      lines.push(`  ${icon} ${pad} \u2014 ${item.description}${backoff}`);
    }
    lines.push("");
  }
  const configured = statuses.filter((s) => s.configured);
  const fromAuth = configured.filter((s) => s.source === "auth.json");
  const fromEnv = configured.filter((s) => s.source === "env");
  const oauthCount = statuses.filter((s) => {
    if (!s.configured || s.source !== "auth.json") return false;
    return s.description.startsWith("OAuth");
  }).length;
  const parts = [];
  parts.push(`${configured.length} configured`);
  if (fromAuth.length > 0) parts.push(`${fromAuth.length} in auth.json`);
  if (fromEnv.length > 0) parts.push(`${fromEnv.length} from env`);
  if (oauthCount > 0) parts.push(`${oauthCount} OAuth`);
  lines.push(`  Source: ${getAuthPath()}`);
  lines.push(`  ${parts.join(" | ")}`);
  return lines.join("\n");
}
async function handleAddKey(providerArg, ctx, auth) {
  let provider;
  if (providerArg) {
    provider = findProvider(providerArg);
    if (!provider) {
      ctx.ui.notify(`Unknown provider: "${providerArg}". Use /gsd keys list to see available providers.`, "error");
      return false;
    }
  } else {
    const options = PROVIDER_REGISTRY.map((p) => {
      const creds = auth.getCredentialsForProvider(p.id).filter((c) => !(c.type === "api_key" && !c.key));
      const existing = creds.length > 0 ? " (configured)" : "";
      return `[${p.category}] ${p.label}${existing}`;
    });
    const choice = await ctx.ui.select("Add key for which provider?", options);
    if (!choice || typeof choice !== "string") return false;
    const idx = options.indexOf(choice);
    if (idx === -1) return false;
    provider = PROVIDER_REGISTRY[idx];
  }
  if (provider.hasOAuth) {
    const methods = ["API key", "Browser login (OAuth)"];
    const method = await ctx.ui.select(
      `${provider.label} \u2014 how do you want to authenticate?`,
      methods
    );
    if (!method || typeof method !== "string") return false;
    if (method.includes("OAuth")) {
      ctx.ui.notify(
        `Use /login to authenticate via OAuth with ${provider.label}.
The /login command handles the full browser flow.`,
        "info"
      );
      return false;
    }
  }
  const input = await ctx.ui.input(
    `API key for ${provider.label}:`,
    provider.envVar ? `or set ${provider.envVar} env var` : "paste your key here"
  );
  if (input === null || input === void 0) return false;
  const key = input.trim();
  if (!key) {
    ctx.ui.notify("No key provided.", "warning");
    return false;
  }
  if (provider.prefixes && provider.prefixes.length > 0) {
    const valid = provider.prefixes.some((pfx) => key.startsWith(pfx));
    if (!valid) {
      ctx.ui.notify(
        `Warning: key doesn't start with expected prefix (${provider.prefixes.join(" or ")}). Saving anyway.`,
        "warning"
      );
    }
  }
  auth.set(provider.id, { type: "api_key", key });
  if (provider.envVar) {
    process.env[provider.envVar] = key;
  }
  ctx.ui.notify(`Key saved for ${provider.label}: ${maskKey(key)}`, "success");
  return true;
}
async function handleRemoveKey(providerArg, ctx, auth) {
  let provider;
  if (providerArg) {
    provider = findProvider(providerArg);
    if (!provider) {
      ctx.ui.notify(`Unknown provider: "${providerArg}".`, "error");
      return false;
    }
  } else {
    const configured = PROVIDER_REGISTRY.filter((p) => {
      const creds2 = auth.getCredentialsForProvider(p.id).filter((c) => !(c.type === "api_key" && !c.key));
      return creds2.length > 0;
    });
    if (configured.length === 0) {
      ctx.ui.notify("No keys configured to remove.", "info");
      return false;
    }
    const options = configured.map((p) => p.label);
    const choice = await ctx.ui.select("Remove key for which provider?", options);
    if (!choice || typeof choice !== "string") return false;
    provider = configured.find((p) => p.label === choice);
    if (!provider) return false;
  }
  const creds = auth.getCredentialsForProvider(provider.id);
  if (creds.length === 0) {
    ctx.ui.notify(`No keys found for ${provider.label}.`, "info");
    return false;
  }
  if (creds.length > 1) {
    const options = creds.map((c, i) => `[${i + 1}] ${describeCredential(c)}`);
    options.push("Remove all");
    const choice = await ctx.ui.select(
      `${provider.label} has ${creds.length} keys. Remove which?`,
      options
    );
    if (!choice || typeof choice !== "string") return false;
    if (choice === "Remove all") {
      auth.remove(provider.id);
    } else {
      const idx = options.indexOf(choice);
      if (idx === -1 || idx >= creds.length) return false;
      const remaining = creds.filter((_, i) => i !== idx);
      auth.remove(provider.id);
      for (const c of remaining) {
        auth.set(provider.id, c);
      }
    }
  } else {
    const confirmed = await ctx.ui.confirm(
      "Remove key?",
      `Remove ${describeCredential(creds[0])} for ${provider.label}?`
    );
    if (!confirmed) return false;
    auth.remove(provider.id);
  }
  if (provider.envVar && process.env[provider.envVar]) {
    delete process.env[provider.envVar];
  }
  ctx.ui.notify(`Key removed for ${provider.label}.`, "success");
  return true;
}
const TEST_ENDPOINTS = {
  anthropic: {
    url: "https://api.anthropic.com/v1/messages",
    method: "POST",
    headers: (key) => ({
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    }),
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1, messages: [{ role: "user", content: "hi" }] })
  },
  openai: {
    url: "https://api.openai.com/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` })
  },
  google: {
    url: "https://generativelanguage.googleapis.com/v1beta/models",
    headers: (key) => ({ "x-goog-api-key": key })
  },
  groq: {
    url: "https://api.groq.com/openai/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` })
  },
  brave: {
    url: "https://api.search.brave.com/res/v1/web/search?q=test&count=1",
    headers: (key) => ({ "X-Subscription-Token": key })
  },
  tavily: {
    url: "https://api.tavily.com/search",
    method: "POST",
    headers: () => ({ "content-type": "application/json" }),
    body: JSON.stringify({ query: "test", max_results: 1 })
  },
  discord_bot: {
    url: "https://discord.com/api/v10/users/@me",
    headers: (key) => ({ Authorization: `Bot ${key}` })
  },
  slack_bot: {
    url: "https://slack.com/api/auth.test",
    headers: (key) => ({ Authorization: `Bearer ${key}` })
  },
  telegram_bot: {
    url: "",
    // Constructed dynamically with token in URL
    headers: () => ({})
  },
  xai: {
    url: "https://api.x.ai/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` })
  },
  mistral: {
    url: "https://api.mistral.ai/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` })
  },
  minimax: {
    url: "https://api.minimax.io/anthropic/v1/messages",
    method: "POST",
    headers: (key) => ({
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    }),
    body: JSON.stringify({ model: "MiniMax-M2.7", max_tokens: 1, messages: [{ role: "user", content: "hi" }] })
  },
  "minimax-cn": {
    url: "https://api.minimaxi.com/anthropic/v1/messages",
    method: "POST",
    headers: (key) => ({
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    }),
    body: JSON.stringify({ model: "MiniMax-M2.7", max_tokens: 1, messages: [{ role: "user", content: "hi" }] })
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` })
  }
};
async function testProviderKey(provider, auth) {
  const key = await auth.getApiKey(provider.id);
  if (!key || key === "<authenticated>") {
    if (!key) {
      return { provider, status: "skipped", message: "not configured" };
    }
    return { provider, status: "skipped", message: "uses credential chain (not testable)" };
  }
  const endpoint = TEST_ENDPOINTS[provider.id];
  if (!endpoint) {
    return { provider, status: "skipped", message: "no test endpoint configured" };
  }
  let url = endpoint.url;
  if (provider.id === "telegram_bot") {
    url = `https://api.telegram.org/bot${key}/getMe`;
  }
  let body = endpoint.body;
  if (provider.id === "tavily" && body) {
    const parsed = JSON.parse(body);
    parsed.api_key = key;
    body = JSON.stringify(parsed);
  }
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: endpoint.method ?? "GET",
      headers: endpoint.headers?.(key) ?? {},
      body: body ?? void 0,
      signal: AbortSignal.timeout(15e3)
    });
    const latencyMs = Date.now() - start;
    if (res.ok) {
      return { provider, status: "valid", message: "valid", latencyMs };
    }
    if (res.status === 401 || res.status === 403) {
      return { provider, status: "invalid", message: `invalid key (${res.status})`, latencyMs };
    }
    if (res.status === 429) {
      return { provider, status: "rate_limited", message: "rate limited", latencyMs };
    }
    return { provider, status: "error", message: `HTTP ${res.status}`, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const msg = getErrorMessage(err);
    if (msg.includes("timeout") || msg.includes("AbortError")) {
      return { provider, status: "error", message: "timeout (15s)", latencyMs };
    }
    return { provider, status: "error", message: msg, latencyMs };
  }
}
function formatTestResults(results) {
  const lines = ["API Key Test Results\n"];
  for (const r of results) {
    const icon = r.status === "valid" ? "\u2713" : r.status === "invalid" ? "\u2717" : r.status === "rate_limited" ? "\u26A0" : r.status === "error" ? "\u2717" : "\u2014";
    const pad = r.provider.id.padEnd(20);
    const latency = r.latencyMs !== void 0 ? `  ${r.latencyMs}ms` : "";
    lines.push(`  ${icon} ${pad} \u2014 ${r.message}${latency}`);
  }
  lines.push("");
  const valid = results.filter((r) => r.status === "valid").length;
  const invalid = results.filter((r) => r.status === "invalid").length;
  const rateLimited = results.filter((r) => r.status === "rate_limited").length;
  const errors = results.filter((r) => r.status === "error").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const parts = [];
  if (valid > 0) parts.push(`${valid} valid`);
  if (invalid > 0) parts.push(`${invalid} invalid`);
  if (rateLimited > 0) parts.push(`${rateLimited} rate-limited`);
  if (errors > 0) parts.push(`${errors} errors`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  lines.push(`  ${parts.join(" | ")}`);
  return lines.join("\n");
}
async function handleRotateKey(providerArg, ctx, auth) {
  let provider;
  if (providerArg) {
    provider = findProvider(providerArg);
    if (!provider) {
      ctx.ui.notify(`Unknown provider: "${providerArg}".`, "error");
      return false;
    }
  } else {
    const configured = PROVIDER_REGISTRY.filter((p) => {
      const creds2 = auth.getCredentialsForProvider(p.id);
      return creds2.some((c) => c.type === "api_key" && c.key);
    });
    if (configured.length === 0) {
      ctx.ui.notify("No API keys configured to rotate.", "info");
      return false;
    }
    const options = configured.map((p) => p.label);
    const choice = await ctx.ui.select("Rotate key for which provider?", options);
    if (!choice || typeof choice !== "string") return false;
    provider = configured.find((p) => p.label === choice);
    if (!provider) return false;
  }
  const creds = auth.getCredentialsForProvider(provider.id);
  const apiKeyCreds = creds.filter((c) => c.type === "api_key");
  if (apiKeyCreds.length === 0) {
    ctx.ui.notify(`No API keys for ${provider.label} (may use OAuth instead).`, "info");
    return false;
  }
  const currentDesc = apiKeyCreds.map((c) => maskKey(c.key)).join(", ");
  ctx.ui.notify(`Current key${apiKeyCreds.length > 1 ? "s" : ""}: ${currentDesc}`, "info");
  const input = await ctx.ui.input(
    `New API key for ${provider.label}:`,
    "paste your new key here"
  );
  if (input === null || input === void 0) return false;
  const newKey = input.trim();
  if (!newKey) {
    ctx.ui.notify("No key provided. Rotation cancelled.", "warning");
    return false;
  }
  if (provider.prefixes && provider.prefixes.length > 0) {
    const valid = provider.prefixes.some((pfx) => newKey.startsWith(pfx));
    if (!valid) {
      ctx.ui.notify(
        `Warning: key doesn't start with expected prefix (${provider.prefixes.join(" or ")}).`,
        "warning"
      );
    }
  }
  const shouldTest = await ctx.ui.confirm(
    "Test key?",
    "Validate the new key before saving?"
  );
  if (shouldTest) {
    const tempAuth = AuthStorage.inMemory({ [provider.id]: { type: "api_key", key: newKey } });
    const result = await testProviderKey(provider, tempAuth);
    if (result.status === "invalid") {
      ctx.ui.notify(`Key validation failed: ${result.message}. Rotation cancelled.`, "error");
      return false;
    }
    if (result.status === "valid") {
      ctx.ui.notify(`Key validated successfully (${result.latencyMs}ms).`, "success");
    } else {
      ctx.ui.notify(`Key test result: ${result.message}. Proceeding anyway.`, "warning");
    }
  }
  const oauthCreds = creds.filter((c) => c.type === "oauth");
  auth.remove(provider.id);
  for (const c of oauthCreds) {
    auth.set(provider.id, c);
  }
  auth.set(provider.id, { type: "api_key", key: newKey });
  if (provider.envVar) {
    process.env[provider.envVar] = newKey;
  }
  ctx.ui.notify(`Key rotated for ${provider.label}: ${maskKey(newKey)}`, "success");
  return true;
}
function runKeyDoctor(auth) {
  const findings = [];
  const authPath = getAuthPath();
  if (existsSync(authPath)) {
    try {
      const stats = statSync(authPath);
      const mode = stats.mode & 511;
      if (mode !== 384) {
        chmodSync(authPath, 384);
        findings.push({
          severity: "fixed",
          message: `auth.json permissions were ${mode.toString(8)} \u2014 fixed to 600`
        });
      }
    } catch {
    }
  }
  for (const provider of PROVIDER_REGISTRY) {
    const creds = auth.getCredentialsForProvider(provider.id);
    for (const cred of creds) {
      if (cred.type === "api_key" && !cred.key) {
        findings.push({
          severity: "warning",
          provider: provider.id,
          message: `${provider.label}: empty key stored (from skipped setup) \u2014 run /gsd keys add ${provider.id}`
        });
      }
    }
  }
  for (const provider of PROVIDER_REGISTRY) {
    const creds = auth.getCredentialsForProvider(provider.id);
    for (const cred of creds) {
      if (cred.type === "oauth") {
        const oauthCred = cred;
        const remaining = oauthCred.expires - Date.now();
        if (remaining <= 0) {
          findings.push({
            severity: "warning",
            provider: provider.id,
            message: `${provider.label}: OAuth token expired \u2014 will auto-refresh on next use`
          });
        } else if (remaining < 5 * 60 * 1e3) {
          findings.push({
            severity: "info",
            provider: provider.id,
            message: `${provider.label}: OAuth token expires in ${formatDuration(remaining)} \u2014 will auto-refresh`
          });
        }
      }
    }
  }
  for (const provider of PROVIDER_REGISTRY) {
    if (!provider.envVar) continue;
    const envValue = process.env[provider.envVar];
    if (!envValue) continue;
    const creds = auth.getCredentialsForProvider(provider.id);
    const apiKey = creds.find((c) => c.type === "api_key" && c.key);
    if (apiKey?.key && apiKey.key !== envValue) {
      findings.push({
        severity: "warning",
        provider: provider.id,
        message: `${provider.label}: env ${provider.envVar} differs from auth.json \u2014 auth.json takes priority`
      });
    }
  }
  for (const provider of PROVIDER_REGISTRY) {
    if (auth.areAllCredentialsBackedOff(provider.id)) {
      const remaining = auth.getProviderBackoffRemaining(provider.id);
      findings.push({
        severity: "warning",
        provider: provider.id,
        message: `${provider.label}: all keys in backoff${remaining > 0 ? ` (${formatDuration(remaining)} remaining)` : ""}`
      });
    }
  }
  const llmProviders = PROVIDER_REGISTRY.filter((p) => p.category === "llm");
  const hasAnyLlm = llmProviders.some((p) => {
    const creds = auth.getCredentialsForProvider(p.id);
    const hasValidKey = creds.some((c) => c.type === "api_key" ? !!c.key : true);
    const hasEnv = p.envVar ? !!process.env[p.envVar] : false;
    return hasValidKey || hasEnv;
  });
  if (!hasAnyLlm) {
    findings.push({
      severity: "error",
      message: "No LLM provider configured \u2014 run /gsd keys add or /login"
    });
  }
  const keyToProviders = /* @__PURE__ */ new Map();
  for (const provider of PROVIDER_REGISTRY) {
    const creds = auth.getCredentialsForProvider(provider.id);
    for (const cred of creds) {
      if (cred.type === "api_key" && cred.key) {
        const key = cred.key;
        const existing = keyToProviders.get(key) ?? [];
        existing.push(provider.id);
        keyToProviders.set(key, existing);
      }
    }
  }
  for (const [, providers] of keyToProviders) {
    if (providers.length > 1) {
      findings.push({
        severity: "warning",
        message: `Same key used by multiple providers: ${providers.join(", ")}`
      });
    }
  }
  return findings;
}
function formatDoctorFindings(findings) {
  if (findings.length === 0) {
    return "API Key Health Check\n\n  All checks passed. No issues found.";
  }
  const lines = ["API Key Health Check\n"];
  for (const f of findings) {
    const icon = f.severity === "error" ? "\u2717" : f.severity === "warning" ? "\u26A0" : f.severity === "fixed" ? "\u2713" : "\u2139";
    lines.push(`  ${icon} ${f.message}`);
  }
  lines.push("");
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;
  const fixed = findings.filter((f) => f.severity === "fixed").length;
  const info = findings.filter((f) => f.severity === "info").length;
  const parts = [];
  if (errors > 0) parts.push(`${errors} error${errors > 1 ? "s" : ""}`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings > 1 ? "s" : ""}`);
  if (fixed > 0) parts.push(`${fixed} fixed`);
  if (info > 0) parts.push(`${info} info`);
  lines.push(`  ${parts.join(" | ")}`);
  return lines.join("\n");
}
async function handleKeys(args, ctx) {
  const auth = getKeyManagerAuthStorage();
  const parts = args.trim().split(/\s+/);
  const subcommand = parts[0] || "";
  const subArgs = parts.slice(1).join(" ").trim();
  switch (subcommand) {
    case "":
    case "list":
    case "status": {
      const statuses = getAllKeyStatuses(auth);
      ctx.ui.notify(formatKeyDashboard(statuses), "info");
      return;
    }
    case "add": {
      const changed = await handleAddKey(subArgs, ctx, auth);
      if (changed) {
        await ctx.waitForIdle();
        await ctx.reload();
      }
      return;
    }
    case "remove":
    case "rm":
    case "delete": {
      const changed = await handleRemoveKey(subArgs, ctx, auth);
      if (changed) {
        await ctx.waitForIdle();
        await ctx.reload();
      }
      return;
    }
    case "test":
    case "validate": {
      let providers;
      if (subArgs) {
        const p = findProvider(subArgs);
        if (!p) {
          ctx.ui.notify(`Unknown provider: "${subArgs}".`, "error");
          return;
        }
        providers = [p];
      } else {
        const statuses = getAllKeyStatuses(auth);
        providers = statuses.filter((s) => s.configured).map((s) => s.provider);
      }
      if (providers.length === 0) {
        ctx.ui.notify("No configured keys to test.", "info");
        return;
      }
      ctx.ui.notify(`Testing ${providers.length} key${providers.length > 1 ? "s" : ""}...`, "info");
      const results = [];
      for (const p of providers) {
        const result = await testProviderKey(p, auth);
        results.push(result);
      }
      ctx.ui.notify(formatTestResults(results), "info");
      return;
    }
    case "rotate": {
      const changed = await handleRotateKey(subArgs, ctx, auth);
      if (changed) {
        await ctx.waitForIdle();
        await ctx.reload();
      }
      return;
    }
    case "doctor":
    case "health": {
      const findings = runKeyDoctor(auth);
      ctx.ui.notify(formatDoctorFindings(findings), "info");
      return;
    }
    default:
      ctx.ui.notify(
        "Usage: /gsd keys [list|add|remove|test|rotate|doctor]\n\n  /gsd keys              Show key status dashboard\n  /gsd keys list         List all configured keys\n  /gsd keys add [id]     Add a key for a provider\n  /gsd keys remove [id]  Remove a key\n  /gsd keys test [id]    Validate key(s) with API call\n  /gsd keys rotate [id]  Replace an existing key\n  /gsd keys doctor       Health check all keys",
        "info"
      );
      return;
  }
}
export {
  PROVIDER_REGISTRY,
  describeCredential,
  findProvider,
  formatDoctorFindings,
  formatDuration,
  formatKeyDashboard,
  formatTestResults,
  getAllKeyStatuses,
  getAuthPath,
  getKeyManagerAuthStorage,
  handleAddKey,
  handleKeys,
  handleRemoveKey,
  handleRotateKey,
  maskKey,
  runKeyDoctor,
  testProviderKey
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9rZXktbWFuYWdlci50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBBUEkgS2V5IE1hbmFnZXIgXHUyMDE0IC9nc2Qga2V5c1xuICpcbiAqIENvbXByZWhlbnNpdmUgQ0xJIGZvciBtYW5hZ2luZyBBUEkga2V5czogbGlzdCwgYWRkLCByZW1vdmUsIHRlc3QsIHJvdGF0ZSwgZG9jdG9yLlxuICogV29ya3Mgd2l0aCBBdXRoU3RvcmFnZSBmcm9tIHBpLWNvZGluZy1hZ2VudCBcdTIwMTQgbm8gY29yZSBwYWNrYWdlIGNoYW5nZXMgbmVlZGVkLlxuICovXG5cbmltcG9ydCB0eXBlIHsgRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7XG4gIEF1dGhTdG9yYWdlLFxuICB0eXBlIEF1dGhDcmVkZW50aWFsLFxuICB0eXBlIEFwaUtleUNyZWRlbnRpYWwsXG4gIHR5cGUgT0F1dGhDcmVkZW50aWFsLFxufSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7IGdldEVudkFwaUtleSB9IGZyb20gXCJAZ3NkL3BpLWFpXCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCBzdGF0U3luYywgY2htb2RTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4sIGRpcm5hbWUgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBta2RpclN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgZ2V0RXJyb3JNZXNzYWdlIH0gZnJvbSBcIi4vZXJyb3ItdXRpbHMuanNcIjtcbmltcG9ydCB7IGdzZEhvbWUgfSBmcm9tIFwiLi9nc2QtaG9tZS5qc1wiO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUHJvdmlkZXIgUmVnaXN0cnkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCB0eXBlIFByb3ZpZGVyQ2F0ZWdvcnkgPSBcImxsbVwiIHwgXCJ0b29sXCIgfCBcInNlYXJjaFwiIHwgXCJyZW1vdGVcIjtcblxuZXhwb3J0IGludGVyZmFjZSBQcm92aWRlckluZm8ge1xuICBpZDogc3RyaW5nO1xuICBsYWJlbDogc3RyaW5nO1xuICBjYXRlZ29yeTogUHJvdmlkZXJDYXRlZ29yeTtcbiAgZW52VmFyPzogc3RyaW5nO1xuICBwcmVmaXhlcz86IHN0cmluZ1tdO1xuICBoYXNPQXV0aD86IGJvb2xlYW47XG4gIGRhc2hib2FyZFVybD86IHN0cmluZztcbn1cblxuZXhwb3J0IGNvbnN0IFBST1ZJREVSX1JFR0lTVFJZOiBQcm92aWRlckluZm9bXSA9IFtcbiAgLy8gTExNIFByb3ZpZGVyc1xuICB7IGlkOiBcImFudGhyb3BpY1wiLCAgICAgICAgbGFiZWw6IFwiQW50aHJvcGljIChDbGF1ZGUpXCIsICAgICAgY2F0ZWdvcnk6IFwibGxtXCIsIGVudlZhcjogXCJBTlRIUk9QSUNfQVBJX0tFWVwiLCAgICAgIHByZWZpeGVzOiBbXCJzay1hbnQtXCJdLCBoYXNPQXV0aDogdHJ1ZSwgZGFzaGJvYXJkVXJsOiBcImNvbnNvbGUuYW50aHJvcGljLmNvbVwiIH0sXG4gIC8vIENsYXVkZSBDb2RlIENMSTogcm91dGVzIHRocm91Z2ggdGhlIGxvY2FsIGBjbGF1ZGVgIGJpbmFyeSBcdTIwMTQgbm8gQVBJIGtleSxcbiAgLy8gYXV0aGVudGljYXRpb24gaXMgaGFuZGxlZCBieSB0aGUgQ0xJJ3Mgb3duIE9BdXRoIGZsb3cuXG4gIC8vIFJlZmVyZW5jZWQgYnkgZG9jdG9yLXByb3ZpZGVycy50cywgYXV0by1tb2RlbC1zZWxlY3Rpb24udHMsIGFuZCBvdGhlcnM7XG4gIC8vIG11c3QgYmUgaW4gdGhlIGNhbm9uaWNhbCByZWdpc3RyeSBzbyBhbGwgY29uc3VtZXJzIHNlZSB0aGUgc2FtZSBjYXRhbG9nLlxuICAvLyBTZWU6IGh0dHBzOi8vZ2l0aHViLmNvbS9nc2QtYnVpbGQvZ3NkLTIvaXNzdWVzLzQ1NDFcbiAgeyBpZDogXCJjbGF1ZGUtY29kZVwiLCAgICAgIGxhYmVsOiBcIkNsYXVkZSBDb2RlIENMSVwiLCAgICAgICAgIGNhdGVnb3J5OiBcImxsbVwiLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaGFzT0F1dGg6IHRydWUgfSxcbiAgeyBpZDogXCJvcGVuYWlcIiwgICAgICAgICAgIGxhYmVsOiBcIk9wZW5BSVwiLCAgICAgICAgICAgICAgICAgIGNhdGVnb3J5OiBcImxsbVwiLCBlbnZWYXI6IFwiT1BFTkFJX0FQSV9LRVlcIiwgICAgICAgICBwcmVmaXhlczogW1wic2stXCJdLCAgICAgZGFzaGJvYXJkVXJsOiBcInBsYXRmb3JtLm9wZW5haS5jb20vYXBpLWtleXNcIiB9LFxuICB7IGlkOiBcImdpdGh1Yi1jb3BpbG90XCIsICAgbGFiZWw6IFwiR2l0SHViIENvcGlsb3RcIiwgICAgICAgICAgY2F0ZWdvcnk6IFwibGxtXCIsIGVudlZhcjogXCJHSVRIVUJfVE9LRU5cIiwgICAgICAgICAgIGhhc09BdXRoOiB0cnVlIH0sXG4gIHsgaWQ6IFwib3BlbmFpLWNvZGV4XCIsICAgICBsYWJlbDogXCJDaGF0R1BUIFBsdXMvUHJvIChDb2RleClcIixjYXRlZ29yeTogXCJsbG1cIiwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGhhc09BdXRoOiB0cnVlIH0sXG4gIHsgaWQ6IFwiZ29vZ2xlLWdlbWluaS1jbGlcIixsYWJlbDogXCJHb29nbGUgR2VtaW5pIENMSVwiLCAgICAgICBjYXRlZ29yeTogXCJsbG1cIiwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGhhc09BdXRoOiB0cnVlIH0sXG4gIHsgaWQ6IFwiZ29vZ2xlLWFudGlncmF2aXR5XCIsbGFiZWw6IFwiQW50aWdyYXZpdHlcIiwgICAgICAgICAgICBjYXRlZ29yeTogXCJsbG1cIiwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGhhc09BdXRoOiB0cnVlIH0sXG4gIHsgaWQ6IFwiZ29vZ2xlXCIsICAgICAgICAgICBsYWJlbDogXCJHb29nbGUgKEdlbWluaSlcIiwgICAgICAgICBjYXRlZ29yeTogXCJsbG1cIiwgZW52VmFyOiBcIkdFTUlOSV9BUElfS0VZXCIsICAgICAgICAgZGFzaGJvYXJkVXJsOiBcImFpc3R1ZGlvLmdvb2dsZS5jb20vYXBpa2V5XCIgfSxcbiAgeyBpZDogXCJncm9xXCIsICAgICAgICAgICAgIGxhYmVsOiBcIkdyb3FcIiwgICAgICAgICAgICAgICAgICAgIGNhdGVnb3J5OiBcImxsbVwiLCBlbnZWYXI6IFwiR1JPUV9BUElfS0VZXCIsICAgICAgICAgICBkYXNoYm9hcmRVcmw6IFwiY29uc29sZS5ncm9xLmNvbVwiIH0sXG4gIHsgaWQ6IFwieGFpXCIsICAgICAgICAgICAgICBsYWJlbDogXCJ4QUkgKEdyb2spXCIsICAgICAgICAgICAgICBjYXRlZ29yeTogXCJsbG1cIiwgZW52VmFyOiBcIlhBSV9BUElfS0VZXCIsICAgICAgICAgICAgZGFzaGJvYXJkVXJsOiBcImNvbnNvbGUueC5haVwiIH0sXG4gIHsgaWQ6IFwib3BlbnJvdXRlclwiLCAgICAgICBsYWJlbDogXCJPcGVuUm91dGVyXCIsICAgICAgICAgICAgICBjYXRlZ29yeTogXCJsbG1cIiwgZW52VmFyOiBcIk9QRU5ST1VURVJfQVBJX0tFWVwiLCAgICAgZGFzaGJvYXJkVXJsOiBcIm9wZW5yb3V0ZXIuYWkva2V5c1wiIH0sXG4gIHsgaWQ6IFwibWlzdHJhbFwiLCAgICAgICAgICBsYWJlbDogXCJNaXN0cmFsXCIsICAgICAgICAgICAgICAgICBjYXRlZ29yeTogXCJsbG1cIiwgZW52VmFyOiBcIk1JU1RSQUxfQVBJX0tFWVwiLCAgICAgICAgZGFzaGJvYXJkVXJsOiBcImNvbnNvbGUubWlzdHJhbC5haVwiIH0sXG4gIHsgaWQ6IFwibWluaW1heFwiLCAgICAgICAgICBsYWJlbDogXCJNaW5pTWF4XCIsICAgICAgICAgICAgICAgICBjYXRlZ29yeTogXCJsbG1cIiwgZW52VmFyOiBcIk1JTklNQVhfQVBJX0tFWVwiLCAgICAgICAgZGFzaGJvYXJkVXJsOiBcInBsYXRmb3JtLm1pbmltYXguaW9cIiB9LFxuICB7IGlkOiBcIm1pbmltYXgtY25cIiwgICAgICAgbGFiZWw6IFwiTWluaU1heCBDTlwiLCAgICAgICAgICAgICAgY2F0ZWdvcnk6IFwibGxtXCIsIGVudlZhcjogXCJNSU5JTUFYX0NOX0FQSV9LRVlcIiwgICAgIGRhc2hib2FyZFVybDogXCJwbGF0Zm9ybS5taW5pbWF4LmlvXCIgfSxcbiAgeyBpZDogXCJvbGxhbWEtY2xvdWRcIiwgICAgIGxhYmVsOiBcIk9sbGFtYSBDbG91ZFwiLCAgICAgICAgICAgIGNhdGVnb3J5OiBcImxsbVwiLCBlbnZWYXI6IFwiT0xMQU1BX0FQSV9LRVlcIiB9LFxuICB7IGlkOiBcImN1c3RvbS1vcGVuYWlcIiwgICAgbGFiZWw6IFwiQ3VzdG9tIChPcGVuQUktY29tcGF0KVwiLCAgY2F0ZWdvcnk6IFwibGxtXCIsIGVudlZhcjogXCJDVVNUT01fT1BFTkFJX0FQSV9LRVlcIiB9LFxuICB7IGlkOiBcImNlcmVicmFzXCIsICAgICAgICAgbGFiZWw6IFwiQ2VyZWJyYXNcIiwgICAgICAgICAgICAgICAgY2F0ZWdvcnk6IFwibGxtXCIsIGVudlZhcjogXCJDRVJFQlJBU19BUElfS0VZXCIgfSxcbiAgeyBpZDogXCJhenVyZS1vcGVuYWktcmVzcG9uc2VzXCIsIGxhYmVsOiBcIkF6dXJlIE9wZW5BSVwiLCAgICAgIGNhdGVnb3J5OiBcImxsbVwiLCBlbnZWYXI6IFwiQVpVUkVfT1BFTkFJX0FQSV9LRVlcIiB9LFxuICB7IGlkOiBcImFsaWJhYmEtY29kaW5nLXBsYW5cIiwgbGFiZWw6IFwiQWxpYmFiYSBDb2RpbmcgUGxhblwiLCAgY2F0ZWdvcnk6IFwibGxtXCIsIGVudlZhcjogXCJBTElCQUJBX0FQSV9LRVlcIiwgICAgICBkYXNoYm9hcmRVcmw6IFwiYmFpbGlhbi5jb25zb2xlLmFsaXl1bi5jb21cIiB9LFxuICB7IGlkOiBcImFsaWJhYmEtZGFzaHNjb3BlXCIsICAgbGFiZWw6IFwiQWxpYmFiYSBEYXNoU2NvcGVcIiwgICAgY2F0ZWdvcnk6IFwibGxtXCIsIGVudlZhcjogXCJEQVNIU0NPUEVfQVBJX0tFWVwiLCAgICBkYXNoYm9hcmRVcmw6IFwiZGFzaHNjb3BlLmNvbnNvbGUuYWxpeXVuLmNvbVwiIH0sXG5cbiAgLy8gVG9vbCBLZXlzXG4gIHsgaWQ6IFwiY29udGV4dDdcIiwgIGxhYmVsOiBcIkNvbnRleHQ3IERvY3NcIiwgICAgIGNhdGVnb3J5OiBcInRvb2xcIiwgZW52VmFyOiBcIkNPTlRFWFQ3X0FQSV9LRVlcIiwgIGRhc2hib2FyZFVybDogXCJjb250ZXh0Ny5jb20vZGFzaGJvYXJkXCIgfSxcbiAgeyBpZDogXCJqaW5hXCIsICAgICAgbGFiZWw6IFwiSmluYSBQYWdlIEV4dHJhY3RcIiwgIGNhdGVnb3J5OiBcInRvb2xcIiwgZW52VmFyOiBcIkpJTkFfQVBJX0tFWVwiLCAgICAgIGRhc2hib2FyZFVybDogXCJqaW5hLmFpL2FwaVwiIH0sXG5cbiAgLy8gU2VhcmNoIFByb3ZpZGVyc1xuICB7IGlkOiBcInRhdmlseVwiLCAgICBsYWJlbDogXCJUYXZpbHkgU2VhcmNoXCIsICAgICAgY2F0ZWdvcnk6IFwic2VhcmNoXCIsIGVudlZhcjogXCJUQVZJTFlfQVBJX0tFWVwiLCAgZGFzaGJvYXJkVXJsOiBcInRhdmlseS5jb20vYXBwL2FwaS1rZXlzXCIgfSxcbiAgeyBpZDogXCJicmF2ZVwiLCAgICAgbGFiZWw6IFwiQnJhdmUgU2VhcmNoXCIsICAgICAgIGNhdGVnb3J5OiBcInNlYXJjaFwiLCBlbnZWYXI6IFwiQlJBVkVfQVBJX0tFWVwiLCAgIGRhc2hib2FyZFVybDogXCJicmF2ZS5jb20vc2VhcmNoL2FwaVwiIH0sXG5cbiAgLy8gUmVtb3RlIEludGVncmF0aW9uc1xuICB7IGlkOiBcImRpc2NvcmRfYm90XCIsICBsYWJlbDogXCJEaXNjb3JkIEJvdFwiLCAgICAgY2F0ZWdvcnk6IFwicmVtb3RlXCIsIGVudlZhcjogXCJESVNDT1JEX0JPVF9UT0tFTlwiIH0sXG4gIHsgaWQ6IFwic2xhY2tfYm90XCIsICAgIGxhYmVsOiBcIlNsYWNrIEJvdFwiLCAgICAgICAgY2F0ZWdvcnk6IFwicmVtb3RlXCIsIGVudlZhcjogXCJTTEFDS19CT1RfVE9LRU5cIiwgICBwcmVmaXhlczogW1wieG94Yi1cIl0gfSxcbiAgeyBpZDogXCJ0ZWxlZ3JhbV9ib3RcIiwgbGFiZWw6IFwiVGVsZWdyYW0gQm90XCIsICAgICBjYXRlZ29yeTogXCJyZW1vdGVcIiwgZW52VmFyOiBcIlRFTEVHUkFNX0JPVF9UT0tFTlwiIH0sXG5dO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVXRpbGl0aWVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIE1hc2sgYW4gQVBJIGtleSBmb3IgZGlzcGxheTogc2hvdyBmaXJzdCA0ICsgbGFzdCA0IGNoYXJzLlxuICogS2V5cyBzaG9ydGVyIHRoYW4gMTIgY2hhcnMgc2hvdyBvbmx5IGZpcnN0IDIgKyBsYXN0IDIuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtYXNrS2V5KGtleTogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKCFrZXkpIHJldHVybiBcIihlbXB0eSlcIjtcbiAgaWYgKGtleS5sZW5ndGggPD0gOCkgcmV0dXJuIGtleS5zbGljZSgwLCAyKSArIFwiKioqXCIgKyBrZXkuc2xpY2UoLTIpO1xuICByZXR1cm4ga2V5LnNsaWNlKDAsIDQpICsgXCIqKipcIiArIGtleS5zbGljZSgtNCk7XG59XG5cbi8qKlxuICogRm9ybWF0IGEgZHVyYXRpb24gaW4gbWlsbGlzZWNvbmRzIHRvIGh1bWFuLXJlYWRhYmxlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0RHVyYXRpb24obXM6IG51bWJlcik6IHN0cmluZyB7XG4gIGlmIChtcyA8PSAwKSByZXR1cm4gXCJleHBpcmVkXCI7XG4gIGNvbnN0IHNlY29uZHMgPSBNYXRoLmZsb29yKG1zIC8gMTAwMCk7XG4gIGlmIChzZWNvbmRzIDwgNjApIHJldHVybiBgJHtzZWNvbmRzfXNgO1xuICBjb25zdCBtaW51dGVzID0gTWF0aC5mbG9vcihzZWNvbmRzIC8gNjApO1xuICBpZiAobWludXRlcyA8IDYwKSByZXR1cm4gYCR7bWludXRlc31tYDtcbiAgY29uc3QgaG91cnMgPSBNYXRoLmZsb29yKG1pbnV0ZXMgLyA2MCk7XG4gIGNvbnN0IHJlbWFpbk1pbnV0ZXMgPSBtaW51dGVzICUgNjA7XG4gIHJldHVybiByZW1haW5NaW51dGVzID4gMCA/IGAke2hvdXJzfWggJHtyZW1haW5NaW51dGVzfW1gIDogYCR7aG91cnN9aGA7XG59XG5cbi8qKlxuICogRGVzY3JpYmUgYSBjcmVkZW50aWFsJ3MgdHlwZSBhbmQgc3RhdHVzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZGVzY3JpYmVDcmVkZW50aWFsKGNyZWQ6IEF1dGhDcmVkZW50aWFsKTogc3RyaW5nIHtcbiAgaWYgKGNyZWQudHlwZSA9PT0gXCJhcGlfa2V5XCIpIHtcbiAgICBjb25zdCBhcGlDcmVkID0gY3JlZCBhcyBBcGlLZXlDcmVkZW50aWFsO1xuICAgIGlmICghYXBpQ3JlZC5rZXkpIHJldHVybiBcImVtcHR5IGtleVwiO1xuICAgIHJldHVybiBgQVBJIGtleSAoJHttYXNrS2V5KGFwaUNyZWQua2V5KX0pYDtcbiAgfVxuICBpZiAoY3JlZC50eXBlID09PSBcIm9hdXRoXCIpIHtcbiAgICBjb25zdCBvYXV0aENyZWQgPSBjcmVkIGFzIE9BdXRoQ3JlZGVudGlhbDtcbiAgICBjb25zdCByZW1haW5pbmcgPSBvYXV0aENyZWQuZXhwaXJlcyAtIERhdGUubm93KCk7XG4gICAgaWYgKHJlbWFpbmluZyA8PSAwKSByZXR1cm4gXCJPQXV0aCAoZXhwaXJlZCBcdTIwMTQgd2lsbCBhdXRvLXJlZnJlc2gpXCI7XG4gICAgcmV0dXJuIGBPQXV0aCAoZXhwaXJlcyBpbiAke2Zvcm1hdER1cmF0aW9uKHJlbWFpbmluZyl9KWA7XG4gIH1cbiAgcmV0dXJuIFwidW5rbm93blwiO1xufVxuXG4vKipcbiAqIEdldCB0aGUgYXV0aC5qc29uIHBhdGguXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRBdXRoUGF0aCgpOiBzdHJpbmcge1xuICByZXR1cm4gam9pbihnc2RIb21lKCksIFwiYWdlbnRcIiwgXCJhdXRoLmpzb25cIik7XG59XG5cbi8qKlxuICogQ3JlYXRlIGFuIEF1dGhTdG9yYWdlIGluc3RhbmNlIGZvciBrZXkgbWFuYWdlbWVudC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldEtleU1hbmFnZXJBdXRoU3RvcmFnZSgpOiBBdXRoU3RvcmFnZSB7XG4gIGNvbnN0IGF1dGhQYXRoID0gZ2V0QXV0aFBhdGgoKTtcbiAgbWtkaXJTeW5jKGRpcm5hbWUoYXV0aFBhdGgpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgcmV0dXJuIEF1dGhTdG9yYWdlLmNyZWF0ZShhdXRoUGF0aCk7XG59XG5cbi8qKlxuICogTG9vayB1cCBhIHByb3ZpZGVyIGJ5IElEIChjYXNlLWluc2Vuc2l0aXZlKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpbmRQcm92aWRlcihpZE9yTGFiZWw6IHN0cmluZyk6IFByb3ZpZGVySW5mbyB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IGxvd2VyID0gaWRPckxhYmVsLnRvTG93ZXJDYXNlKCk7XG4gIHJldHVybiBQUk9WSURFUl9SRUdJU1RSWS5maW5kKFxuICAgIChwKSA9PiBwLmlkLnRvTG93ZXJDYXNlKCkgPT09IGxvd2VyIHx8IHAubGFiZWwudG9Mb3dlckNhc2UoKSA9PT0gbG93ZXIsXG4gICk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBLZXkgU3RhdHVzIC8gTGlzdCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGludGVyZmFjZSBLZXlTdGF0dXMge1xuICBwcm92aWRlcjogUHJvdmlkZXJJbmZvO1xuICBjb25maWd1cmVkOiBib29sZWFuO1xuICBzb3VyY2U6IFwiYXV0aC5qc29uXCIgfCBcImVudlwiIHwgXCJub25lXCI7XG4gIGNyZWRlbnRpYWxDb3VudDogbnVtYmVyO1xuICBkZXNjcmlwdGlvbjogc3RyaW5nO1xuICBiYWNrZWRPZmY6IGJvb2xlYW47XG59XG5cbi8qKlxuICogR2V0IHRoZSBzdGF0dXMgb2YgYWxsIGtub3duIHByb3ZpZGVycy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldEFsbEtleVN0YXR1c2VzKGF1dGg6IEF1dGhTdG9yYWdlKTogS2V5U3RhdHVzW10ge1xuICByZXR1cm4gUFJPVklERVJfUkVHSVNUUlkubWFwKChwcm92aWRlcikgPT4ge1xuICAgIGNvbnN0IHJhd0NyZWRzID0gYXV0aC5nZXRDcmVkZW50aWFsc0ZvclByb3ZpZGVyKHByb3ZpZGVyLmlkKTtcbiAgICAvLyBGaWx0ZXIgb3V0IGVtcHR5LWtleSBlbnRyaWVzIChsZWZ0IGJ5IGxlZ2FjeSByZW1vdmVQcm92aWRlclRva2VuIG9yIHNraXBwZWQgb25ib2FyZGluZylcbiAgICBjb25zdCBjcmVkcyA9IHJhd0NyZWRzLmZpbHRlcigoYykgPT4gIShjLnR5cGUgPT09IFwiYXBpX2tleVwiICYmICEoYyBhcyBBcGlLZXlDcmVkZW50aWFsKS5rZXkpKTtcbiAgICBjb25zdCBlbnZLZXkgPSBwcm92aWRlci5lbnZWYXIgPyBwcm9jZXNzLmVudltwcm92aWRlci5lbnZWYXJdIDogdW5kZWZpbmVkO1xuXG4gICAgaWYgKGNyZWRzLmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IGZpcnN0Q3JlZCA9IGNyZWRzWzBdO1xuICAgICAgY29uc3QgZGVzYyA9XG4gICAgICAgIGNyZWRzLmxlbmd0aCA+IDFcbiAgICAgICAgICA/IGAke2NyZWRzLmxlbmd0aH0ga2V5cyAocm91bmQtcm9iaW4pYFxuICAgICAgICAgIDogZGVzY3JpYmVDcmVkZW50aWFsKGZpcnN0Q3JlZCk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBwcm92aWRlcixcbiAgICAgICAgY29uZmlndXJlZDogdHJ1ZSxcbiAgICAgICAgc291cmNlOiBcImF1dGguanNvblwiIGFzIGNvbnN0LFxuICAgICAgICBjcmVkZW50aWFsQ291bnQ6IGNyZWRzLmxlbmd0aCxcbiAgICAgICAgZGVzY3JpcHRpb246IGRlc2MsXG4gICAgICAgIGJhY2tlZE9mZjogYXV0aC5hcmVBbGxDcmVkZW50aWFsc0JhY2tlZE9mZihwcm92aWRlci5pZCksXG4gICAgICB9O1xuICAgIH1cblxuICAgIGlmIChlbnZLZXkpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHByb3ZpZGVyLFxuICAgICAgICBjb25maWd1cmVkOiB0cnVlLFxuICAgICAgICBzb3VyY2U6IFwiZW52XCIgYXMgY29uc3QsXG4gICAgICAgIGNyZWRlbnRpYWxDb3VudDogMSxcbiAgICAgICAgZGVzY3JpcHRpb246IGBlbnYgJHtwcm92aWRlci5lbnZWYXJ9YCxcbiAgICAgICAgYmFja2VkT2ZmOiBmYWxzZSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgcmV0dXJuIHtcbiAgICAgIHByb3ZpZGVyLFxuICAgICAgY29uZmlndXJlZDogZmFsc2UsXG4gICAgICBzb3VyY2U6IFwibm9uZVwiIGFzIGNvbnN0LFxuICAgICAgY3JlZGVudGlhbENvdW50OiAwLFxuICAgICAgZGVzY3JpcHRpb246IHByb3ZpZGVyLmRhc2hib2FyZFVybFxuICAgICAgICA/IGBub3QgY29uZmlndXJlZCAoJHtwcm92aWRlci5kYXNoYm9hcmRVcmx9KWBcbiAgICAgICAgOiBwcm92aWRlci5lbnZWYXJcbiAgICAgICAgICA/IGBub3QgY29uZmlndXJlZCAoZW52OiAke3Byb3ZpZGVyLmVudlZhcn0pYFxuICAgICAgICAgIDogXCJub3QgY29uZmlndXJlZFwiLFxuICAgICAgYmFja2VkT2ZmOiBmYWxzZSxcbiAgICB9O1xuICB9KTtcbn1cblxuLyoqXG4gKiBGb3JtYXQgc3RhdHVzZXMgaW50byBhIGdyb3VwZWQgZGFzaGJvYXJkIHN0cmluZy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdEtleURhc2hib2FyZChzdGF0dXNlczogS2V5U3RhdHVzW10pOiBzdHJpbmcge1xuICBjb25zdCBjYXRlZ29yaWVzOiB7IGxhYmVsOiBzdHJpbmc7IGtleTogUHJvdmlkZXJDYXRlZ29yeSB9W10gPSBbXG4gICAgeyBsYWJlbDogXCJMTE0gUHJvdmlkZXJzXCIsIGtleTogXCJsbG1cIiB9LFxuICAgIHsgbGFiZWw6IFwiU2VhcmNoIFByb3ZpZGVyc1wiLCBrZXk6IFwic2VhcmNoXCIgfSxcbiAgICB7IGxhYmVsOiBcIlRvb2wgS2V5c1wiLCBrZXk6IFwidG9vbFwiIH0sXG4gICAgeyBsYWJlbDogXCJSZW1vdGUgSW50ZWdyYXRpb25zXCIsIGtleTogXCJyZW1vdGVcIiB9LFxuICBdO1xuXG4gIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtcIkdTRCBBUEkgS2V5IE1hbmFnZXJcXG5cIl07XG5cbiAgZm9yIChjb25zdCBjYXQgb2YgY2F0ZWdvcmllcykge1xuICAgIGNvbnN0IGl0ZW1zID0gc3RhdHVzZXMuZmlsdGVyKChzKSA9PiBzLnByb3ZpZGVyLmNhdGVnb3J5ID09PSBjYXQua2V5KTtcbiAgICBpZiAoaXRlbXMubGVuZ3RoID09PSAwKSBjb250aW51ZTtcblxuICAgIGxpbmVzLnB1c2goYCAgJHtjYXQubGFiZWx9YCk7XG4gICAgZm9yIChjb25zdCBpdGVtIG9mIGl0ZW1zKSB7XG4gICAgICBjb25zdCBpY29uID0gaXRlbS5jb25maWd1cmVkID8gXCJcdTI3MTNcIiA6IFwiXHUyNzE3XCI7XG4gICAgICBjb25zdCBiYWNrb2ZmID0gaXRlbS5iYWNrZWRPZmYgPyBcIiBbYmFja2VkIG9mZl1cIiA6IFwiXCI7XG4gICAgICBjb25zdCBwYWQgPSBpdGVtLnByb3ZpZGVyLmlkLnBhZEVuZCgyMCk7XG4gICAgICBsaW5lcy5wdXNoKGAgICR7aWNvbn0gJHtwYWR9IFx1MjAxNCAke2l0ZW0uZGVzY3JpcHRpb259JHtiYWNrb2ZmfWApO1xuICAgIH1cbiAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICB9XG5cbiAgLy8gU3VtbWFyeVxuICBjb25zdCBjb25maWd1cmVkID0gc3RhdHVzZXMuZmlsdGVyKChzKSA9PiBzLmNvbmZpZ3VyZWQpO1xuICBjb25zdCBmcm9tQXV0aCA9IGNvbmZpZ3VyZWQuZmlsdGVyKChzKSA9PiBzLnNvdXJjZSA9PT0gXCJhdXRoLmpzb25cIik7XG4gIGNvbnN0IGZyb21FbnYgPSBjb25maWd1cmVkLmZpbHRlcigocykgPT4gcy5zb3VyY2UgPT09IFwiZW52XCIpO1xuICBjb25zdCBvYXV0aENvdW50ID0gc3RhdHVzZXMuZmlsdGVyKChzKSA9PiB7XG4gICAgaWYgKCFzLmNvbmZpZ3VyZWQgfHwgcy5zb3VyY2UgIT09IFwiYXV0aC5qc29uXCIpIHJldHVybiBmYWxzZTtcbiAgICByZXR1cm4gcy5kZXNjcmlwdGlvbi5zdGFydHNXaXRoKFwiT0F1dGhcIik7XG4gIH0pLmxlbmd0aDtcblxuICBjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcbiAgcGFydHMucHVzaChgJHtjb25maWd1cmVkLmxlbmd0aH0gY29uZmlndXJlZGApO1xuICBpZiAoZnJvbUF1dGgubGVuZ3RoID4gMCkgcGFydHMucHVzaChgJHtmcm9tQXV0aC5sZW5ndGh9IGluIGF1dGguanNvbmApO1xuICBpZiAoZnJvbUVudi5sZW5ndGggPiAwKSBwYXJ0cy5wdXNoKGAke2Zyb21FbnYubGVuZ3RofSBmcm9tIGVudmApO1xuICBpZiAob2F1dGhDb3VudCA+IDApIHBhcnRzLnB1c2goYCR7b2F1dGhDb3VudH0gT0F1dGhgKTtcblxuICBsaW5lcy5wdXNoKGAgIFNvdXJjZTogJHtnZXRBdXRoUGF0aCgpfWApO1xuICBsaW5lcy5wdXNoKGAgICR7cGFydHMuam9pbihcIiB8IFwiKX1gKTtcblxuICByZXR1cm4gbGluZXMuam9pbihcIlxcblwiKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEFkZCBLZXkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogQWRkIGEga2V5IGludGVyYWN0aXZlbHkuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBoYW5kbGVBZGRLZXkoXG4gIHByb3ZpZGVyQXJnOiBzdHJpbmcsXG4gIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsXG4gIGF1dGg6IEF1dGhTdG9yYWdlLFxuKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGxldCBwcm92aWRlcjogUHJvdmlkZXJJbmZvIHwgdW5kZWZpbmVkO1xuXG4gIGlmIChwcm92aWRlckFyZykge1xuICAgIHByb3ZpZGVyID0gZmluZFByb3ZpZGVyKHByb3ZpZGVyQXJnKTtcbiAgICBpZiAoIXByb3ZpZGVyKSB7XG4gICAgICBjdHgudWkubm90aWZ5KGBVbmtub3duIHByb3ZpZGVyOiBcIiR7cHJvdmlkZXJBcmd9XCIuIFVzZSAvZ3NkIGtleXMgbGlzdCB0byBzZWUgYXZhaWxhYmxlIHByb3ZpZGVycy5gLCBcImVycm9yXCIpO1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICAvLyBJbnRlcmFjdGl2ZSBwcm92aWRlciBwaWNrZXJcbiAgICBjb25zdCBvcHRpb25zID0gUFJPVklERVJfUkVHSVNUUlkubWFwKChwKSA9PiB7XG4gICAgICBjb25zdCBjcmVkcyA9IGF1dGguZ2V0Q3JlZGVudGlhbHNGb3JQcm92aWRlcihwLmlkKS5maWx0ZXIoKGMpID0+ICEoYy50eXBlID09PSBcImFwaV9rZXlcIiAmJiAhKGMgYXMgQXBpS2V5Q3JlZGVudGlhbCkua2V5KSk7XG4gICAgICBjb25zdCBleGlzdGluZyA9IGNyZWRzLmxlbmd0aCA+IDAgPyBcIiAoY29uZmlndXJlZClcIiA6IFwiXCI7XG4gICAgICByZXR1cm4gYFske3AuY2F0ZWdvcnl9XSAke3AubGFiZWx9JHtleGlzdGluZ31gO1xuICAgIH0pO1xuICAgIGNvbnN0IGNob2ljZSA9IGF3YWl0IGN0eC51aS5zZWxlY3QoXCJBZGQga2V5IGZvciB3aGljaCBwcm92aWRlcj9cIiwgb3B0aW9ucyk7XG4gICAgaWYgKCFjaG9pY2UgfHwgdHlwZW9mIGNob2ljZSAhPT0gXCJzdHJpbmdcIikgcmV0dXJuIGZhbHNlO1xuXG4gICAgY29uc3QgaWR4ID0gb3B0aW9ucy5pbmRleE9mKGNob2ljZSk7XG4gICAgaWYgKGlkeCA9PT0gLTEpIHJldHVybiBmYWxzZTtcbiAgICBwcm92aWRlciA9IFBST1ZJREVSX1JFR0lTVFJZW2lkeF07XG4gIH1cblxuICAvLyBJZiBPQXV0aCBpcyBhdmFpbGFibGUsIG9mZmVyIGNob2ljZVxuICBpZiAocHJvdmlkZXIuaGFzT0F1dGgpIHtcbiAgICBjb25zdCBtZXRob2RzID0gW1wiQVBJIGtleVwiLCBcIkJyb3dzZXIgbG9naW4gKE9BdXRoKVwiXTtcbiAgICBjb25zdCBtZXRob2QgPSBhd2FpdCBjdHgudWkuc2VsZWN0KFxuICAgICAgYCR7cHJvdmlkZXIubGFiZWx9IFx1MjAxNCBob3cgZG8geW91IHdhbnQgdG8gYXV0aGVudGljYXRlP2AsXG4gICAgICBtZXRob2RzLFxuICAgICk7XG4gICAgaWYgKCFtZXRob2QgfHwgdHlwZW9mIG1ldGhvZCAhPT0gXCJzdHJpbmdcIikgcmV0dXJuIGZhbHNlO1xuXG4gICAgaWYgKG1ldGhvZC5pbmNsdWRlcyhcIk9BdXRoXCIpKSB7XG4gICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICBgVXNlIC9sb2dpbiB0byBhdXRoZW50aWNhdGUgdmlhIE9BdXRoIHdpdGggJHtwcm92aWRlci5sYWJlbH0uXFxuYCArXG4gICAgICAgIGBUaGUgL2xvZ2luIGNvbW1hbmQgaGFuZGxlcyB0aGUgZnVsbCBicm93c2VyIGZsb3cuYCxcbiAgICAgICAgXCJpbmZvXCIsXG4gICAgICApO1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgfVxuXG4gIC8vIEFQSSBrZXkgaW5wdXRcbiAgY29uc3QgaW5wdXQgPSBhd2FpdCBjdHgudWkuaW5wdXQoXG4gICAgYEFQSSBrZXkgZm9yICR7cHJvdmlkZXIubGFiZWx9OmAsXG4gICAgcHJvdmlkZXIuZW52VmFyID8gYG9yIHNldCAke3Byb3ZpZGVyLmVudlZhcn0gZW52IHZhcmAgOiBcInBhc3RlIHlvdXIga2V5IGhlcmVcIixcbiAgKTtcblxuICBpZiAoaW5wdXQgPT09IG51bGwgfHwgaW5wdXQgPT09IHVuZGVmaW5lZCkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBrZXkgPSBpbnB1dC50cmltKCk7XG4gIGlmICgha2V5KSB7XG4gICAgY3R4LnVpLm5vdGlmeShcIk5vIGtleSBwcm92aWRlZC5cIiwgXCJ3YXJuaW5nXCIpO1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIC8vIFByZWZpeCB2YWxpZGF0aW9uXG4gIGlmIChwcm92aWRlci5wcmVmaXhlcyAmJiBwcm92aWRlci5wcmVmaXhlcy5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgdmFsaWQgPSBwcm92aWRlci5wcmVmaXhlcy5zb21lKChwZngpID0+IGtleS5zdGFydHNXaXRoKHBmeCkpO1xuICAgIGlmICghdmFsaWQpIHtcbiAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgIGBXYXJuaW5nOiBrZXkgZG9lc24ndCBzdGFydCB3aXRoIGV4cGVjdGVkIHByZWZpeCAoJHtwcm92aWRlci5wcmVmaXhlcy5qb2luKFwiIG9yIFwiKX0pLiBTYXZpbmcgYW55d2F5LmAsXG4gICAgICAgIFwid2FybmluZ1wiLFxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICBhdXRoLnNldChwcm92aWRlci5pZCwgeyB0eXBlOiBcImFwaV9rZXlcIiwga2V5IH0pO1xuICBpZiAocHJvdmlkZXIuZW52VmFyKSB7XG4gICAgcHJvY2Vzcy5lbnZbcHJvdmlkZXIuZW52VmFyXSA9IGtleTtcbiAgfVxuXG4gIGN0eC51aS5ub3RpZnkoYEtleSBzYXZlZCBmb3IgJHtwcm92aWRlci5sYWJlbH06ICR7bWFza0tleShrZXkpfWAsIFwic3VjY2Vzc1wiKTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBSZW1vdmUgS2V5IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFJlbW92ZSBhIGtleSBpbnRlcmFjdGl2ZWx5LlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlUmVtb3ZlS2V5KFxuICBwcm92aWRlckFyZzogc3RyaW5nLFxuICBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LFxuICBhdXRoOiBBdXRoU3RvcmFnZSxcbik6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBsZXQgcHJvdmlkZXI6IFByb3ZpZGVySW5mbyB8IHVuZGVmaW5lZDtcblxuICBpZiAocHJvdmlkZXJBcmcpIHtcbiAgICBwcm92aWRlciA9IGZpbmRQcm92aWRlcihwcm92aWRlckFyZyk7XG4gICAgaWYgKCFwcm92aWRlcikge1xuICAgICAgY3R4LnVpLm5vdGlmeShgVW5rbm93biBwcm92aWRlcjogXCIke3Byb3ZpZGVyQXJnfVwiLmAsIFwiZXJyb3JcIik7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIC8vIFNob3cgb25seSBjb25maWd1cmVkIHByb3ZpZGVyc1xuICAgIGNvbnN0IGNvbmZpZ3VyZWQgPSBQUk9WSURFUl9SRUdJU1RSWS5maWx0ZXIoKHApID0+IHtcbiAgICAgIGNvbnN0IGNyZWRzID0gYXV0aC5nZXRDcmVkZW50aWFsc0ZvclByb3ZpZGVyKHAuaWQpLmZpbHRlcigoYykgPT4gIShjLnR5cGUgPT09IFwiYXBpX2tleVwiICYmICEoYyBhcyBBcGlLZXlDcmVkZW50aWFsKS5rZXkpKTtcbiAgICAgIHJldHVybiBjcmVkcy5sZW5ndGggPiAwO1xuICAgIH0pO1xuXG4gICAgaWYgKGNvbmZpZ3VyZWQubGVuZ3RoID09PSAwKSB7XG4gICAgICBjdHgudWkubm90aWZ5KFwiTm8ga2V5cyBjb25maWd1cmVkIHRvIHJlbW92ZS5cIiwgXCJpbmZvXCIpO1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIGNvbnN0IG9wdGlvbnMgPSBjb25maWd1cmVkLm1hcCgocCkgPT4gcC5sYWJlbCk7XG4gICAgY29uc3QgY2hvaWNlID0gYXdhaXQgY3R4LnVpLnNlbGVjdChcIlJlbW92ZSBrZXkgZm9yIHdoaWNoIHByb3ZpZGVyP1wiLCBvcHRpb25zKTtcbiAgICBpZiAoIWNob2ljZSB8fCB0eXBlb2YgY2hvaWNlICE9PSBcInN0cmluZ1wiKSByZXR1cm4gZmFsc2U7XG5cbiAgICBwcm92aWRlciA9IGNvbmZpZ3VyZWQuZmluZCgocCkgPT4gcC5sYWJlbCA9PT0gY2hvaWNlKTtcbiAgICBpZiAoIXByb3ZpZGVyKSByZXR1cm4gZmFsc2U7XG4gIH1cblxuICBjb25zdCBjcmVkcyA9IGF1dGguZ2V0Q3JlZGVudGlhbHNGb3JQcm92aWRlcihwcm92aWRlci5pZCk7XG4gIGlmIChjcmVkcy5sZW5ndGggPT09IDApIHtcbiAgICBjdHgudWkubm90aWZ5KGBObyBrZXlzIGZvdW5kIGZvciAke3Byb3ZpZGVyLmxhYmVsfS5gLCBcImluZm9cIik7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgLy8gTXVsdGkta2V5IGhhbmRsaW5nXG4gIGlmIChjcmVkcy5sZW5ndGggPiAxKSB7XG4gICAgY29uc3Qgb3B0aW9ucyA9IGNyZWRzLm1hcCgoYywgaSkgPT4gYFske2kgKyAxfV0gJHtkZXNjcmliZUNyZWRlbnRpYWwoYyl9YCk7XG4gICAgb3B0aW9ucy5wdXNoKFwiUmVtb3ZlIGFsbFwiKTtcblxuICAgIGNvbnN0IGNob2ljZSA9IGF3YWl0IGN0eC51aS5zZWxlY3QoXG4gICAgICBgJHtwcm92aWRlci5sYWJlbH0gaGFzICR7Y3JlZHMubGVuZ3RofSBrZXlzLiBSZW1vdmUgd2hpY2g/YCxcbiAgICAgIG9wdGlvbnMsXG4gICAgKTtcbiAgICBpZiAoIWNob2ljZSB8fCB0eXBlb2YgY2hvaWNlICE9PSBcInN0cmluZ1wiKSByZXR1cm4gZmFsc2U7XG5cbiAgICBpZiAoY2hvaWNlID09PSBcIlJlbW92ZSBhbGxcIikge1xuICAgICAgYXV0aC5yZW1vdmUocHJvdmlkZXIuaWQpO1xuICAgIH0gZWxzZSB7XG4gICAgICAvLyBSZW1vdmUgc3BlY2lmaWMgaW5kZXggXHUyMDE0IG5lZWQgdG8gcmVidWlsZCB0aGUgYXJyYXkgd2l0aG91dCB0aGF0IGVudHJ5XG4gICAgICBjb25zdCBpZHggPSBvcHRpb25zLmluZGV4T2YoY2hvaWNlKTtcbiAgICAgIGlmIChpZHggPT09IC0xIHx8IGlkeCA+PSBjcmVkcy5sZW5ndGgpIHJldHVybiBmYWxzZTtcbiAgICAgIGNvbnN0IHJlbWFpbmluZyA9IGNyZWRzLmZpbHRlcigoXywgaSkgPT4gaSAhPT0gaWR4KTtcbiAgICAgIGF1dGgucmVtb3ZlKHByb3ZpZGVyLmlkKTtcbiAgICAgIGZvciAoY29uc3QgYyBvZiByZW1haW5pbmcpIHtcbiAgICAgICAgYXV0aC5zZXQocHJvdmlkZXIuaWQsIGMpO1xuICAgICAgfVxuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBjb25zdCBjb25maXJtZWQgPSBhd2FpdCBjdHgudWkuY29uZmlybShcbiAgICAgIFwiUmVtb3ZlIGtleT9cIixcbiAgICAgIGBSZW1vdmUgJHtkZXNjcmliZUNyZWRlbnRpYWwoY3JlZHNbMF0pfSBmb3IgJHtwcm92aWRlci5sYWJlbH0/YCxcbiAgICApO1xuICAgIGlmICghY29uZmlybWVkKSByZXR1cm4gZmFsc2U7XG4gICAgYXV0aC5yZW1vdmUocHJvdmlkZXIuaWQpO1xuICB9XG5cbiAgLy8gQ2xlYXIgZW52IHZhclxuICBpZiAocHJvdmlkZXIuZW52VmFyICYmIHByb2Nlc3MuZW52W3Byb3ZpZGVyLmVudlZhcl0pIHtcbiAgICBkZWxldGUgcHJvY2Vzcy5lbnZbcHJvdmlkZXIuZW52VmFyXTtcbiAgfVxuXG4gIGN0eC51aS5ub3RpZnkoYEtleSByZW1vdmVkIGZvciAke3Byb3ZpZGVyLmxhYmVsfS5gLCBcInN1Y2Nlc3NcIik7XG4gIHJldHVybiB0cnVlO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCBLZXkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBpbnRlcmZhY2UgVGVzdFJlc3VsdCB7XG4gIHByb3ZpZGVyOiBQcm92aWRlckluZm87XG4gIHN0YXR1czogXCJ2YWxpZFwiIHwgXCJpbnZhbGlkXCIgfCBcInJhdGVfbGltaXRlZFwiIHwgXCJlcnJvclwiIHwgXCJza2lwcGVkXCI7XG4gIG1lc3NhZ2U6IHN0cmluZztcbiAgbGF0ZW5jeU1zPzogbnVtYmVyO1xufVxuXG4vKiogVGVzdCBlbmRwb2ludCBjb25maWd1cmF0aW9ucyBwZXIgcHJvdmlkZXIgKi9cbmNvbnN0IFRFU1RfRU5EUE9JTlRTOiBSZWNvcmQ8c3RyaW5nLCB7IHVybDogc3RyaW5nOyBtZXRob2Q/OiBzdHJpbmc7IGhlYWRlcnM/OiAoa2V5OiBzdHJpbmcpID0+IFJlY29yZDxzdHJpbmcsIHN0cmluZz47IGJvZHk/OiBzdHJpbmcgfT4gPSB7XG4gIGFudGhyb3BpYzoge1xuICAgIHVybDogXCJodHRwczovL2FwaS5hbnRocm9waWMuY29tL3YxL21lc3NhZ2VzXCIsXG4gICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICBoZWFkZXJzOiAoa2V5KSA9PiAoe1xuICAgICAgXCJ4LWFwaS1rZXlcIjoga2V5LFxuICAgICAgXCJhbnRocm9waWMtdmVyc2lvblwiOiBcIjIwMjMtMDYtMDFcIixcbiAgICAgIFwiY29udGVudC10eXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiLFxuICAgIH0pLFxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgbW9kZWw6IFwiY2xhdWRlLXNvbm5ldC00LTIwMjUwNTE0XCIsIG1heF90b2tlbnM6IDEsIG1lc3NhZ2VzOiBbeyByb2xlOiBcInVzZXJcIiwgY29udGVudDogXCJoaVwiIH1dIH0pLFxuICB9LFxuICBvcGVuYWk6IHtcbiAgICB1cmw6IFwiaHR0cHM6Ly9hcGkub3BlbmFpLmNvbS92MS9tb2RlbHNcIixcbiAgICBoZWFkZXJzOiAoa2V5KSA9PiAoeyBBdXRob3JpemF0aW9uOiBgQmVhcmVyICR7a2V5fWAgfSksXG4gIH0sXG4gIGdvb2dsZToge1xuICAgIHVybDogXCJodHRwczovL2dlbmVyYXRpdmVsYW5ndWFnZS5nb29nbGVhcGlzLmNvbS92MWJldGEvbW9kZWxzXCIsXG4gICAgaGVhZGVyczogKGtleSkgPT4gKHsgXCJ4LWdvb2ctYXBpLWtleVwiOiBrZXkgfSksXG4gIH0sXG4gIGdyb3E6IHtcbiAgICB1cmw6IFwiaHR0cHM6Ly9hcGkuZ3JvcS5jb20vb3BlbmFpL3YxL21vZGVsc1wiLFxuICAgIGhlYWRlcnM6IChrZXkpID0+ICh7IEF1dGhvcml6YXRpb246IGBCZWFyZXIgJHtrZXl9YCB9KSxcbiAgfSxcbiAgYnJhdmU6IHtcbiAgICB1cmw6IFwiaHR0cHM6Ly9hcGkuc2VhcmNoLmJyYXZlLmNvbS9yZXMvdjEvd2ViL3NlYXJjaD9xPXRlc3QmY291bnQ9MVwiLFxuICAgIGhlYWRlcnM6IChrZXkpID0+ICh7IFwiWC1TdWJzY3JpcHRpb24tVG9rZW5cIjoga2V5IH0pLFxuICB9LFxuICB0YXZpbHk6IHtcbiAgICB1cmw6IFwiaHR0cHM6Ly9hcGkudGF2aWx5LmNvbS9zZWFyY2hcIixcbiAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgIGhlYWRlcnM6ICgpID0+ICh7IFwiY29udGVudC10eXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0pLFxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgcXVlcnk6IFwidGVzdFwiLCBtYXhfcmVzdWx0czogMSB9KSxcbiAgfSxcbiAgZGlzY29yZF9ib3Q6IHtcbiAgICB1cmw6IFwiaHR0cHM6Ly9kaXNjb3JkLmNvbS9hcGkvdjEwL3VzZXJzL0BtZVwiLFxuICAgIGhlYWRlcnM6IChrZXkpID0+ICh7IEF1dGhvcml6YXRpb246IGBCb3QgJHtrZXl9YCB9KSxcbiAgfSxcbiAgc2xhY2tfYm90OiB7XG4gICAgdXJsOiBcImh0dHBzOi8vc2xhY2suY29tL2FwaS9hdXRoLnRlc3RcIixcbiAgICBoZWFkZXJzOiAoa2V5KSA9PiAoeyBBdXRob3JpemF0aW9uOiBgQmVhcmVyICR7a2V5fWAgfSksXG4gIH0sXG4gIHRlbGVncmFtX2JvdDoge1xuICAgIHVybDogXCJcIiwgLy8gQ29uc3RydWN0ZWQgZHluYW1pY2FsbHkgd2l0aCB0b2tlbiBpbiBVUkxcbiAgICBoZWFkZXJzOiAoKSA9PiAoe30pLFxuICB9LFxuICB4YWk6IHtcbiAgICB1cmw6IFwiaHR0cHM6Ly9hcGkueC5haS92MS9tb2RlbHNcIixcbiAgICBoZWFkZXJzOiAoa2V5KSA9PiAoeyBBdXRob3JpemF0aW9uOiBgQmVhcmVyICR7a2V5fWAgfSksXG4gIH0sXG4gIG1pc3RyYWw6IHtcbiAgICB1cmw6IFwiaHR0cHM6Ly9hcGkubWlzdHJhbC5haS92MS9tb2RlbHNcIixcbiAgICBoZWFkZXJzOiAoa2V5KSA9PiAoeyBBdXRob3JpemF0aW9uOiBgQmVhcmVyICR7a2V5fWAgfSksXG4gIH0sXG4gIG1pbmltYXg6IHtcbiAgICB1cmw6IFwiaHR0cHM6Ly9hcGkubWluaW1heC5pby9hbnRocm9waWMvdjEvbWVzc2FnZXNcIixcbiAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgIGhlYWRlcnM6IChrZXkpID0+ICh7XG4gICAgICBcIngtYXBpLWtleVwiOiBrZXksXG4gICAgICBcImFudGhyb3BpYy12ZXJzaW9uXCI6IFwiMjAyMy0wNi0wMVwiLFxuICAgICAgXCJjb250ZW50LXR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIsXG4gICAgfSksXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBtb2RlbDogXCJNaW5pTWF4LU0yLjdcIiwgbWF4X3Rva2VuczogMSwgbWVzc2FnZXM6IFt7IHJvbGU6IFwidXNlclwiLCBjb250ZW50OiBcImhpXCIgfV0gfSksXG4gIH0sXG4gIFwibWluaW1heC1jblwiOiB7XG4gICAgdXJsOiBcImh0dHBzOi8vYXBpLm1pbmltYXhpLmNvbS9hbnRocm9waWMvdjEvbWVzc2FnZXNcIixcbiAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgIGhlYWRlcnM6IChrZXkpID0+ICh7XG4gICAgICBcIngtYXBpLWtleVwiOiBrZXksXG4gICAgICBcImFudGhyb3BpYy12ZXJzaW9uXCI6IFwiMjAyMy0wNi0wMVwiLFxuICAgICAgXCJjb250ZW50LXR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIsXG4gICAgfSksXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBtb2RlbDogXCJNaW5pTWF4LU0yLjdcIiwgbWF4X3Rva2VuczogMSwgbWVzc2FnZXM6IFt7IHJvbGU6IFwidXNlclwiLCBjb250ZW50OiBcImhpXCIgfV0gfSksXG4gIH0sXG4gIG9wZW5yb3V0ZXI6IHtcbiAgICB1cmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MS9tb2RlbHNcIixcbiAgICBoZWFkZXJzOiAoa2V5KSA9PiAoeyBBdXRob3JpemF0aW9uOiBgQmVhcmVyICR7a2V5fWAgfSksXG4gIH0sXG59O1xuXG4vKipcbiAqIFRlc3QgYSBzaW5nbGUgcHJvdmlkZXIncyBrZXkuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB0ZXN0UHJvdmlkZXJLZXkoXG4gIHByb3ZpZGVyOiBQcm92aWRlckluZm8sXG4gIGF1dGg6IEF1dGhTdG9yYWdlLFxuKTogUHJvbWlzZTxUZXN0UmVzdWx0PiB7XG4gIC8vIEdldCB0aGUgQVBJIGtleVxuICBjb25zdCBrZXkgPSBhd2FpdCBhdXRoLmdldEFwaUtleShwcm92aWRlci5pZCk7XG4gIGlmICgha2V5IHx8IGtleSA9PT0gXCI8YXV0aGVudGljYXRlZD5cIikge1xuICAgIGlmICgha2V5KSB7XG4gICAgICByZXR1cm4geyBwcm92aWRlciwgc3RhdHVzOiBcInNraXBwZWRcIiwgbWVzc2FnZTogXCJub3QgY29uZmlndXJlZFwiIH07XG4gICAgfVxuICAgIHJldHVybiB7IHByb3ZpZGVyLCBzdGF0dXM6IFwic2tpcHBlZFwiLCBtZXNzYWdlOiBcInVzZXMgY3JlZGVudGlhbCBjaGFpbiAobm90IHRlc3RhYmxlKVwiIH07XG4gIH1cblxuICBjb25zdCBlbmRwb2ludCA9IFRFU1RfRU5EUE9JTlRTW3Byb3ZpZGVyLmlkXTtcbiAgaWYgKCFlbmRwb2ludCkge1xuICAgIHJldHVybiB7IHByb3ZpZGVyLCBzdGF0dXM6IFwic2tpcHBlZFwiLCBtZXNzYWdlOiBcIm5vIHRlc3QgZW5kcG9pbnQgY29uZmlndXJlZFwiIH07XG4gIH1cblxuICAvLyBTcGVjaWFsIGhhbmRsaW5nIGZvciBUZWxlZ3JhbSAodG9rZW4gaW4gVVJMKVxuICBsZXQgdXJsID0gZW5kcG9pbnQudXJsO1xuICBpZiAocHJvdmlkZXIuaWQgPT09IFwidGVsZWdyYW1fYm90XCIpIHtcbiAgICB1cmwgPSBgaHR0cHM6Ly9hcGkudGVsZWdyYW0ub3JnL2JvdCR7a2V5fS9nZXRNZWA7XG4gIH1cblxuICAvLyBTcGVjaWFsIGhhbmRsaW5nIGZvciBUYXZpbHkgKEFQSSBrZXkgaW4gYm9keSlcbiAgbGV0IGJvZHkgPSBlbmRwb2ludC5ib2R5O1xuICBpZiAocHJvdmlkZXIuaWQgPT09IFwidGF2aWx5XCIgJiYgYm9keSkge1xuICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UoYm9keSk7XG4gICAgcGFyc2VkLmFwaV9rZXkgPSBrZXk7XG4gICAgYm9keSA9IEpTT04uc3RyaW5naWZ5KHBhcnNlZCk7XG4gIH1cblxuICBjb25zdCBzdGFydCA9IERhdGUubm93KCk7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2godXJsLCB7XG4gICAgICBtZXRob2Q6IGVuZHBvaW50Lm1ldGhvZCA/PyBcIkdFVFwiLFxuICAgICAgaGVhZGVyczogZW5kcG9pbnQuaGVhZGVycz8uKGtleSkgPz8ge30sXG4gICAgICBib2R5OiBib2R5ID8/IHVuZGVmaW5lZCxcbiAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgxNV8wMDApLFxuICAgIH0pO1xuICAgIGNvbnN0IGxhdGVuY3lNcyA9IERhdGUubm93KCkgLSBzdGFydDtcblxuICAgIGlmIChyZXMub2spIHtcbiAgICAgIHJldHVybiB7IHByb3ZpZGVyLCBzdGF0dXM6IFwidmFsaWRcIiwgbWVzc2FnZTogXCJ2YWxpZFwiLCBsYXRlbmN5TXMgfTtcbiAgICB9XG5cbiAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxIHx8IHJlcy5zdGF0dXMgPT09IDQwMykge1xuICAgICAgcmV0dXJuIHsgcHJvdmlkZXIsIHN0YXR1czogXCJpbnZhbGlkXCIsIG1lc3NhZ2U6IGBpbnZhbGlkIGtleSAoJHtyZXMuc3RhdHVzfSlgLCBsYXRlbmN5TXMgfTtcbiAgICB9XG5cbiAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDI5KSB7XG4gICAgICByZXR1cm4geyBwcm92aWRlciwgc3RhdHVzOiBcInJhdGVfbGltaXRlZFwiLCBtZXNzYWdlOiBcInJhdGUgbGltaXRlZFwiLCBsYXRlbmN5TXMgfTtcbiAgICB9XG5cbiAgICByZXR1cm4geyBwcm92aWRlciwgc3RhdHVzOiBcImVycm9yXCIsIG1lc3NhZ2U6IGBIVFRQICR7cmVzLnN0YXR1c31gLCBsYXRlbmN5TXMgfTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY29uc3QgbGF0ZW5jeU1zID0gRGF0ZS5ub3coKSAtIHN0YXJ0O1xuICAgIGNvbnN0IG1zZyA9IGdldEVycm9yTWVzc2FnZShlcnIpO1xuICAgIGlmIChtc2cuaW5jbHVkZXMoXCJ0aW1lb3V0XCIpIHx8IG1zZy5pbmNsdWRlcyhcIkFib3J0RXJyb3JcIikpIHtcbiAgICAgIHJldHVybiB7IHByb3ZpZGVyLCBzdGF0dXM6IFwiZXJyb3JcIiwgbWVzc2FnZTogXCJ0aW1lb3V0ICgxNXMpXCIsIGxhdGVuY3lNcyB9O1xuICAgIH1cbiAgICByZXR1cm4geyBwcm92aWRlciwgc3RhdHVzOiBcImVycm9yXCIsIG1lc3NhZ2U6IG1zZywgbGF0ZW5jeU1zIH07XG4gIH1cbn1cblxuLyoqXG4gKiBGb3JtYXQgdGVzdCByZXN1bHRzIGZvciBkaXNwbGF5LlxuICovXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0VGVzdFJlc3VsdHMocmVzdWx0czogVGVzdFJlc3VsdFtdKTogc3RyaW5nIHtcbiAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW1wiQVBJIEtleSBUZXN0IFJlc3VsdHNcXG5cIl07XG5cbiAgZm9yIChjb25zdCByIG9mIHJlc3VsdHMpIHtcbiAgICBjb25zdCBpY29uID1cbiAgICAgIHIuc3RhdHVzID09PSBcInZhbGlkXCIgPyBcIlx1MjcxM1wiIDpcbiAgICAgIHIuc3RhdHVzID09PSBcImludmFsaWRcIiA/IFwiXHUyNzE3XCIgOlxuICAgICAgci5zdGF0dXMgPT09IFwicmF0ZV9saW1pdGVkXCIgPyBcIlx1MjZBMFwiIDpcbiAgICAgIHIuc3RhdHVzID09PSBcImVycm9yXCIgPyBcIlx1MjcxN1wiIDpcbiAgICAgIFwiXHUyMDE0XCI7XG4gICAgY29uc3QgcGFkID0gci5wcm92aWRlci5pZC5wYWRFbmQoMjApO1xuICAgIGNvbnN0IGxhdGVuY3kgPSByLmxhdGVuY3lNcyAhPT0gdW5kZWZpbmVkID8gYCAgJHtyLmxhdGVuY3lNc31tc2AgOiBcIlwiO1xuICAgIGxpbmVzLnB1c2goYCAgJHtpY29ufSAke3BhZH0gXHUyMDE0ICR7ci5tZXNzYWdlfSR7bGF0ZW5jeX1gKTtcbiAgfVxuXG4gIGxpbmVzLnB1c2goXCJcIik7XG4gIGNvbnN0IHZhbGlkID0gcmVzdWx0cy5maWx0ZXIoKHIpID0+IHIuc3RhdHVzID09PSBcInZhbGlkXCIpLmxlbmd0aDtcbiAgY29uc3QgaW52YWxpZCA9IHJlc3VsdHMuZmlsdGVyKChyKSA9PiByLnN0YXR1cyA9PT0gXCJpbnZhbGlkXCIpLmxlbmd0aDtcbiAgY29uc3QgcmF0ZUxpbWl0ZWQgPSByZXN1bHRzLmZpbHRlcigocikgPT4gci5zdGF0dXMgPT09IFwicmF0ZV9saW1pdGVkXCIpLmxlbmd0aDtcbiAgY29uc3QgZXJyb3JzID0gcmVzdWx0cy5maWx0ZXIoKHIpID0+IHIuc3RhdHVzID09PSBcImVycm9yXCIpLmxlbmd0aDtcbiAgY29uc3Qgc2tpcHBlZCA9IHJlc3VsdHMuZmlsdGVyKChyKSA9PiByLnN0YXR1cyA9PT0gXCJza2lwcGVkXCIpLmxlbmd0aDtcblxuICBjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcbiAgaWYgKHZhbGlkID4gMCkgcGFydHMucHVzaChgJHt2YWxpZH0gdmFsaWRgKTtcbiAgaWYgKGludmFsaWQgPiAwKSBwYXJ0cy5wdXNoKGAke2ludmFsaWR9IGludmFsaWRgKTtcbiAgaWYgKHJhdGVMaW1pdGVkID4gMCkgcGFydHMucHVzaChgJHtyYXRlTGltaXRlZH0gcmF0ZS1saW1pdGVkYCk7XG4gIGlmIChlcnJvcnMgPiAwKSBwYXJ0cy5wdXNoKGAke2Vycm9yc30gZXJyb3JzYCk7XG4gIGlmIChza2lwcGVkID4gMCkgcGFydHMucHVzaChgJHtza2lwcGVkfSBza2lwcGVkYCk7XG4gIGxpbmVzLnB1c2goYCAgJHtwYXJ0cy5qb2luKFwiIHwgXCIpfWApO1xuXG4gIHJldHVybiBsaW5lcy5qb2luKFwiXFxuXCIpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUm90YXRlIEtleSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBSb3RhdGUgYSBrZXk6IHNob3cgY3VycmVudCwgcHJvbXB0IGZvciBuZXcsIG9wdGlvbmFsbHkgdGVzdCwgdGhlbiBzYXZlLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlUm90YXRlS2V5KFxuICBwcm92aWRlckFyZzogc3RyaW5nLFxuICBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LFxuICBhdXRoOiBBdXRoU3RvcmFnZSxcbik6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBsZXQgcHJvdmlkZXI6IFByb3ZpZGVySW5mbyB8IHVuZGVmaW5lZDtcblxuICBpZiAocHJvdmlkZXJBcmcpIHtcbiAgICBwcm92aWRlciA9IGZpbmRQcm92aWRlcihwcm92aWRlckFyZyk7XG4gICAgaWYgKCFwcm92aWRlcikge1xuICAgICAgY3R4LnVpLm5vdGlmeShgVW5rbm93biBwcm92aWRlcjogXCIke3Byb3ZpZGVyQXJnfVwiLmAsIFwiZXJyb3JcIik7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIC8vIFNob3cgb25seSBjb25maWd1cmVkIEFQSSBrZXkgcHJvdmlkZXJzXG4gICAgY29uc3QgY29uZmlndXJlZCA9IFBST1ZJREVSX1JFR0lTVFJZLmZpbHRlcigocCkgPT4ge1xuICAgICAgY29uc3QgY3JlZHMgPSBhdXRoLmdldENyZWRlbnRpYWxzRm9yUHJvdmlkZXIocC5pZCk7XG4gICAgICByZXR1cm4gY3JlZHMuc29tZSgoYykgPT4gYy50eXBlID09PSBcImFwaV9rZXlcIiAmJiAoYyBhcyBBcGlLZXlDcmVkZW50aWFsKS5rZXkpO1xuICAgIH0pO1xuXG4gICAgaWYgKGNvbmZpZ3VyZWQubGVuZ3RoID09PSAwKSB7XG4gICAgICBjdHgudWkubm90aWZ5KFwiTm8gQVBJIGtleXMgY29uZmlndXJlZCB0byByb3RhdGUuXCIsIFwiaW5mb1wiKTtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICBjb25zdCBvcHRpb25zID0gY29uZmlndXJlZC5tYXAoKHApID0+IHAubGFiZWwpO1xuICAgIGNvbnN0IGNob2ljZSA9IGF3YWl0IGN0eC51aS5zZWxlY3QoXCJSb3RhdGUga2V5IGZvciB3aGljaCBwcm92aWRlcj9cIiwgb3B0aW9ucyk7XG4gICAgaWYgKCFjaG9pY2UgfHwgdHlwZW9mIGNob2ljZSAhPT0gXCJzdHJpbmdcIikgcmV0dXJuIGZhbHNlO1xuXG4gICAgcHJvdmlkZXIgPSBjb25maWd1cmVkLmZpbmQoKHApID0+IHAubGFiZWwgPT09IGNob2ljZSk7XG4gICAgaWYgKCFwcm92aWRlcikgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgY29uc3QgY3JlZHMgPSBhdXRoLmdldENyZWRlbnRpYWxzRm9yUHJvdmlkZXIocHJvdmlkZXIuaWQpO1xuICBjb25zdCBhcGlLZXlDcmVkcyA9IGNyZWRzLmZpbHRlcigoYykgPT4gYy50eXBlID09PSBcImFwaV9rZXlcIikgYXMgQXBpS2V5Q3JlZGVudGlhbFtdO1xuXG4gIGlmIChhcGlLZXlDcmVkcy5sZW5ndGggPT09IDApIHtcbiAgICBjdHgudWkubm90aWZ5KGBObyBBUEkga2V5cyBmb3IgJHtwcm92aWRlci5sYWJlbH0gKG1heSB1c2UgT0F1dGggaW5zdGVhZCkuYCwgXCJpbmZvXCIpO1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIC8vIFNob3cgY3VycmVudCBrZXkocylcbiAgY29uc3QgY3VycmVudERlc2MgPSBhcGlLZXlDcmVkcy5tYXAoKGMpID0+IG1hc2tLZXkoYy5rZXkpKS5qb2luKFwiLCBcIik7XG4gIGN0eC51aS5ub3RpZnkoYEN1cnJlbnQga2V5JHthcGlLZXlDcmVkcy5sZW5ndGggPiAxID8gXCJzXCIgOiBcIlwifTogJHtjdXJyZW50RGVzY31gLCBcImluZm9cIik7XG5cbiAgLy8gUHJvbXB0IGZvciBuZXcga2V5XG4gIGNvbnN0IGlucHV0ID0gYXdhaXQgY3R4LnVpLmlucHV0KFxuICAgIGBOZXcgQVBJIGtleSBmb3IgJHtwcm92aWRlci5sYWJlbH06YCxcbiAgICBcInBhc3RlIHlvdXIgbmV3IGtleSBoZXJlXCIsXG4gICk7XG5cbiAgaWYgKGlucHV0ID09PSBudWxsIHx8IGlucHV0ID09PSB1bmRlZmluZWQpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgbmV3S2V5ID0gaW5wdXQudHJpbSgpO1xuICBpZiAoIW5ld0tleSkge1xuICAgIGN0eC51aS5ub3RpZnkoXCJObyBrZXkgcHJvdmlkZWQuIFJvdGF0aW9uIGNhbmNlbGxlZC5cIiwgXCJ3YXJuaW5nXCIpO1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIC8vIFByZWZpeCB2YWxpZGF0aW9uXG4gIGlmIChwcm92aWRlci5wcmVmaXhlcyAmJiBwcm92aWRlci5wcmVmaXhlcy5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgdmFsaWQgPSBwcm92aWRlci5wcmVmaXhlcy5zb21lKChwZngpID0+IG5ld0tleS5zdGFydHNXaXRoKHBmeCkpO1xuICAgIGlmICghdmFsaWQpIHtcbiAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgIGBXYXJuaW5nOiBrZXkgZG9lc24ndCBzdGFydCB3aXRoIGV4cGVjdGVkIHByZWZpeCAoJHtwcm92aWRlci5wcmVmaXhlcy5qb2luKFwiIG9yIFwiKX0pLmAsXG4gICAgICAgIFwid2FybmluZ1wiLFxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICAvLyBPZmZlciB0byB0ZXN0IGJlZm9yZSBzYXZpbmdcbiAgY29uc3Qgc2hvdWxkVGVzdCA9IGF3YWl0IGN0eC51aS5jb25maXJtKFxuICAgIFwiVGVzdCBrZXk/XCIsXG4gICAgXCJWYWxpZGF0ZSB0aGUgbmV3IGtleSBiZWZvcmUgc2F2aW5nP1wiLFxuICApO1xuXG4gIGlmIChzaG91bGRUZXN0KSB7XG4gICAgLy8gVGVtcG9yYXJpbHkgdGVzdCB0aGUgbmV3IGtleVxuICAgIGNvbnN0IHRlbXBBdXRoID0gQXV0aFN0b3JhZ2UuaW5NZW1vcnkoeyBbcHJvdmlkZXIuaWRdOiB7IHR5cGU6IFwiYXBpX2tleVwiLCBrZXk6IG5ld0tleSB9IH0pO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRlc3RQcm92aWRlcktleShwcm92aWRlciwgdGVtcEF1dGgpO1xuXG4gICAgaWYgKHJlc3VsdC5zdGF0dXMgPT09IFwiaW52YWxpZFwiKSB7XG4gICAgICBjdHgudWkubm90aWZ5KGBLZXkgdmFsaWRhdGlvbiBmYWlsZWQ6ICR7cmVzdWx0Lm1lc3NhZ2V9LiBSb3RhdGlvbiBjYW5jZWxsZWQuYCwgXCJlcnJvclwiKTtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICBpZiAocmVzdWx0LnN0YXR1cyA9PT0gXCJ2YWxpZFwiKSB7XG4gICAgICBjdHgudWkubm90aWZ5KGBLZXkgdmFsaWRhdGVkIHN1Y2Nlc3NmdWxseSAoJHtyZXN1bHQubGF0ZW5jeU1zfW1zKS5gLCBcInN1Y2Nlc3NcIik7XG4gICAgfSBlbHNlIHtcbiAgICAgIGN0eC51aS5ub3RpZnkoYEtleSB0ZXN0IHJlc3VsdDogJHtyZXN1bHQubWVzc2FnZX0uIFByb2NlZWRpbmcgYW55d2F5LmAsIFwid2FybmluZ1wiKTtcbiAgICB9XG4gIH1cblxuICAvLyBSZW1vdmUgb2xkIGtleXMgYW5kIGFkZCBuZXcgb25lXG4gIC8vIFByZXNlcnZlIGFueSBPQXV0aCBjcmVkZW50aWFsc1xuICBjb25zdCBvYXV0aENyZWRzID0gY3JlZHMuZmlsdGVyKChjKSA9PiBjLnR5cGUgPT09IFwib2F1dGhcIik7XG4gIGF1dGgucmVtb3ZlKHByb3ZpZGVyLmlkKTtcbiAgZm9yIChjb25zdCBjIG9mIG9hdXRoQ3JlZHMpIHtcbiAgICBhdXRoLnNldChwcm92aWRlci5pZCwgYyk7XG4gIH1cbiAgYXV0aC5zZXQocHJvdmlkZXIuaWQsIHsgdHlwZTogXCJhcGlfa2V5XCIsIGtleTogbmV3S2V5IH0pO1xuXG4gIGlmIChwcm92aWRlci5lbnZWYXIpIHtcbiAgICBwcm9jZXNzLmVudltwcm92aWRlci5lbnZWYXJdID0gbmV3S2V5O1xuICB9XG5cbiAgY3R4LnVpLm5vdGlmeShgS2V5IHJvdGF0ZWQgZm9yICR7cHJvdmlkZXIubGFiZWx9OiAke21hc2tLZXkobmV3S2V5KX1gLCBcInN1Y2Nlc3NcIik7XG4gIHJldHVybiB0cnVlO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgS2V5IERvY3RvciBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGludGVyZmFjZSBEb2N0b3JGaW5kaW5nIHtcbiAgc2V2ZXJpdHk6IFwiZXJyb3JcIiB8IFwid2FybmluZ1wiIHwgXCJpbmZvXCIgfCBcImZpeGVkXCI7XG4gIHByb3ZpZGVyPzogc3RyaW5nO1xuICBtZXNzYWdlOiBzdHJpbmc7XG59XG5cbi8qKlxuICogUnVuIGhlYWx0aCBjaGVja3Mgb24gYWxsIEFQSSBrZXlzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcnVuS2V5RG9jdG9yKGF1dGg6IEF1dGhTdG9yYWdlKTogRG9jdG9yRmluZGluZ1tdIHtcbiAgY29uc3QgZmluZGluZ3M6IERvY3RvckZpbmRpbmdbXSA9IFtdO1xuXG4gIC8vIDEuIENoZWNrIGF1dGguanNvbiBwZXJtaXNzaW9uc1xuICBjb25zdCBhdXRoUGF0aCA9IGdldEF1dGhQYXRoKCk7XG4gIGlmIChleGlzdHNTeW5jKGF1dGhQYXRoKSkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzdGF0cyA9IHN0YXRTeW5jKGF1dGhQYXRoKTtcbiAgICAgIGNvbnN0IG1vZGUgPSBzdGF0cy5tb2RlICYgMG83Nzc7XG4gICAgICBpZiAobW9kZSAhPT0gMG82MDApIHtcbiAgICAgICAgY2htb2RTeW5jKGF1dGhQYXRoLCAwbzYwMCk7XG4gICAgICAgIGZpbmRpbmdzLnB1c2goe1xuICAgICAgICAgIHNldmVyaXR5OiBcImZpeGVkXCIsXG4gICAgICAgICAgbWVzc2FnZTogYGF1dGguanNvbiBwZXJtaXNzaW9ucyB3ZXJlICR7bW9kZS50b1N0cmluZyg4KX0gXHUyMDE0IGZpeGVkIHRvIDYwMGAsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gQ2FuJ3QgY2hlY2sgcGVybWlzc2lvbnMgXHUyMDE0IHNraXBcbiAgICB9XG4gIH1cblxuICAvLyAyLiBDaGVjayBmb3IgZW1wdHkga2V5c1xuICBmb3IgKGNvbnN0IHByb3ZpZGVyIG9mIFBST1ZJREVSX1JFR0lTVFJZKSB7XG4gICAgY29uc3QgY3JlZHMgPSBhdXRoLmdldENyZWRlbnRpYWxzRm9yUHJvdmlkZXIocHJvdmlkZXIuaWQpO1xuICAgIGZvciAoY29uc3QgY3JlZCBvZiBjcmVkcykge1xuICAgICAgaWYgKGNyZWQudHlwZSA9PT0gXCJhcGlfa2V5XCIgJiYgIShjcmVkIGFzIEFwaUtleUNyZWRlbnRpYWwpLmtleSkge1xuICAgICAgICBmaW5kaW5ncy5wdXNoKHtcbiAgICAgICAgICBzZXZlcml0eTogXCJ3YXJuaW5nXCIsXG4gICAgICAgICAgcHJvdmlkZXI6IHByb3ZpZGVyLmlkLFxuICAgICAgICAgIG1lc3NhZ2U6IGAke3Byb3ZpZGVyLmxhYmVsfTogZW1wdHkga2V5IHN0b3JlZCAoZnJvbSBza2lwcGVkIHNldHVwKSBcdTIwMTQgcnVuIC9nc2Qga2V5cyBhZGQgJHtwcm92aWRlci5pZH1gLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyAzLiBDaGVjayBleHBpcmVkIE9BdXRoXG4gIGZvciAoY29uc3QgcHJvdmlkZXIgb2YgUFJPVklERVJfUkVHSVNUUlkpIHtcbiAgICBjb25zdCBjcmVkcyA9IGF1dGguZ2V0Q3JlZGVudGlhbHNGb3JQcm92aWRlcihwcm92aWRlci5pZCk7XG4gICAgZm9yIChjb25zdCBjcmVkIG9mIGNyZWRzKSB7XG4gICAgICBpZiAoY3JlZC50eXBlID09PSBcIm9hdXRoXCIpIHtcbiAgICAgICAgY29uc3Qgb2F1dGhDcmVkID0gY3JlZCBhcyBPQXV0aENyZWRlbnRpYWw7XG4gICAgICAgIGNvbnN0IHJlbWFpbmluZyA9IG9hdXRoQ3JlZC5leHBpcmVzIC0gRGF0ZS5ub3coKTtcbiAgICAgICAgaWYgKHJlbWFpbmluZyA8PSAwKSB7XG4gICAgICAgICAgZmluZGluZ3MucHVzaCh7XG4gICAgICAgICAgICBzZXZlcml0eTogXCJ3YXJuaW5nXCIsXG4gICAgICAgICAgICBwcm92aWRlcjogcHJvdmlkZXIuaWQsXG4gICAgICAgICAgICBtZXNzYWdlOiBgJHtwcm92aWRlci5sYWJlbH06IE9BdXRoIHRva2VuIGV4cGlyZWQgXHUyMDE0IHdpbGwgYXV0by1yZWZyZXNoIG9uIG5leHQgdXNlYCxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSBlbHNlIGlmIChyZW1haW5pbmcgPCA1ICogNjAgKiAxMDAwKSB7XG4gICAgICAgICAgZmluZGluZ3MucHVzaCh7XG4gICAgICAgICAgICBzZXZlcml0eTogXCJpbmZvXCIsXG4gICAgICAgICAgICBwcm92aWRlcjogcHJvdmlkZXIuaWQsXG4gICAgICAgICAgICBtZXNzYWdlOiBgJHtwcm92aWRlci5sYWJlbH06IE9BdXRoIHRva2VuIGV4cGlyZXMgaW4gJHtmb3JtYXREdXJhdGlvbihyZW1haW5pbmcpfSBcdTIwMTQgd2lsbCBhdXRvLXJlZnJlc2hgLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gNC4gQ2hlY2sgZm9yIGVudiB2YXIgY29uZmxpY3RzXG4gIGZvciAoY29uc3QgcHJvdmlkZXIgb2YgUFJPVklERVJfUkVHSVNUUlkpIHtcbiAgICBpZiAoIXByb3ZpZGVyLmVudlZhcikgY29udGludWU7XG4gICAgY29uc3QgZW52VmFsdWUgPSBwcm9jZXNzLmVudltwcm92aWRlci5lbnZWYXJdO1xuICAgIGlmICghZW52VmFsdWUpIGNvbnRpbnVlO1xuXG4gICAgY29uc3QgY3JlZHMgPSBhdXRoLmdldENyZWRlbnRpYWxzRm9yUHJvdmlkZXIocHJvdmlkZXIuaWQpO1xuICAgIGNvbnN0IGFwaUtleSA9IGNyZWRzLmZpbmQoKGMpID0+IGMudHlwZSA9PT0gXCJhcGlfa2V5XCIgJiYgKGMgYXMgQXBpS2V5Q3JlZGVudGlhbCkua2V5KSBhcyBBcGlLZXlDcmVkZW50aWFsIHwgdW5kZWZpbmVkO1xuICAgIGlmIChhcGlLZXk/LmtleSAmJiBhcGlLZXkua2V5ICE9PSBlbnZWYWx1ZSkge1xuICAgICAgZmluZGluZ3MucHVzaCh7XG4gICAgICAgIHNldmVyaXR5OiBcIndhcm5pbmdcIixcbiAgICAgICAgcHJvdmlkZXI6IHByb3ZpZGVyLmlkLFxuICAgICAgICBtZXNzYWdlOiBgJHtwcm92aWRlci5sYWJlbH06IGVudiAke3Byb3ZpZGVyLmVudlZhcn0gZGlmZmVycyBmcm9tIGF1dGguanNvbiBcdTIwMTQgYXV0aC5qc29uIHRha2VzIHByaW9yaXR5YCxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuXG4gIC8vIDUuIENoZWNrIGZvciBiYWNrZWQtb2ZmIGtleXNcbiAgZm9yIChjb25zdCBwcm92aWRlciBvZiBQUk9WSURFUl9SRUdJU1RSWSkge1xuICAgIGlmIChhdXRoLmFyZUFsbENyZWRlbnRpYWxzQmFja2VkT2ZmKHByb3ZpZGVyLmlkKSkge1xuICAgICAgY29uc3QgcmVtYWluaW5nID0gYXV0aC5nZXRQcm92aWRlckJhY2tvZmZSZW1haW5pbmcocHJvdmlkZXIuaWQpO1xuICAgICAgZmluZGluZ3MucHVzaCh7XG4gICAgICAgIHNldmVyaXR5OiBcIndhcm5pbmdcIixcbiAgICAgICAgcHJvdmlkZXI6IHByb3ZpZGVyLmlkLFxuICAgICAgICBtZXNzYWdlOiBgJHtwcm92aWRlci5sYWJlbH06IGFsbCBrZXlzIGluIGJhY2tvZmYke3JlbWFpbmluZyA+IDAgPyBgICgke2Zvcm1hdER1cmF0aW9uKHJlbWFpbmluZyl9IHJlbWFpbmluZylgIDogXCJcIn1gLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgLy8gNi4gQ2hlY2sgZm9yIG1pc3NpbmcgTExNIHByb3ZpZGVyXG4gIGNvbnN0IGxsbVByb3ZpZGVycyA9IFBST1ZJREVSX1JFR0lTVFJZLmZpbHRlcigocCkgPT4gcC5jYXRlZ29yeSA9PT0gXCJsbG1cIik7XG4gIGNvbnN0IGhhc0FueUxsbSA9IGxsbVByb3ZpZGVycy5zb21lKChwKSA9PiB7XG4gICAgY29uc3QgY3JlZHMgPSBhdXRoLmdldENyZWRlbnRpYWxzRm9yUHJvdmlkZXIocC5pZCk7XG4gICAgY29uc3QgaGFzVmFsaWRLZXkgPSBjcmVkcy5zb21lKChjKSA9PiBjLnR5cGUgPT09IFwiYXBpX2tleVwiID8gISEoYyBhcyBBcGlLZXlDcmVkZW50aWFsKS5rZXkgOiB0cnVlKTtcbiAgICBjb25zdCBoYXNFbnYgPSBwLmVudlZhciA/ICEhcHJvY2Vzcy5lbnZbcC5lbnZWYXJdIDogZmFsc2U7XG4gICAgcmV0dXJuIGhhc1ZhbGlkS2V5IHx8IGhhc0VudjtcbiAgfSk7XG4gIGlmICghaGFzQW55TGxtKSB7XG4gICAgZmluZGluZ3MucHVzaCh7XG4gICAgICBzZXZlcml0eTogXCJlcnJvclwiLFxuICAgICAgbWVzc2FnZTogXCJObyBMTE0gcHJvdmlkZXIgY29uZmlndXJlZCBcdTIwMTQgcnVuIC9nc2Qga2V5cyBhZGQgb3IgL2xvZ2luXCIsXG4gICAgfSk7XG4gIH1cblxuICAvLyA3LiBDaGVjayBmb3IgZHVwbGljYXRlIGtleXMgYWNyb3NzIHByb3ZpZGVyc1xuICBjb25zdCBrZXlUb1Byb3ZpZGVycyA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmdbXT4oKTtcbiAgZm9yIChjb25zdCBwcm92aWRlciBvZiBQUk9WSURFUl9SRUdJU1RSWSkge1xuICAgIGNvbnN0IGNyZWRzID0gYXV0aC5nZXRDcmVkZW50aWFsc0ZvclByb3ZpZGVyKHByb3ZpZGVyLmlkKTtcbiAgICBmb3IgKGNvbnN0IGNyZWQgb2YgY3JlZHMpIHtcbiAgICAgIGlmIChjcmVkLnR5cGUgPT09IFwiYXBpX2tleVwiICYmIChjcmVkIGFzIEFwaUtleUNyZWRlbnRpYWwpLmtleSkge1xuICAgICAgICBjb25zdCBrZXkgPSAoY3JlZCBhcyBBcGlLZXlDcmVkZW50aWFsKS5rZXk7XG4gICAgICAgIGNvbnN0IGV4aXN0aW5nID0ga2V5VG9Qcm92aWRlcnMuZ2V0KGtleSkgPz8gW107XG4gICAgICAgIGV4aXN0aW5nLnB1c2gocHJvdmlkZXIuaWQpO1xuICAgICAgICBrZXlUb1Byb3ZpZGVycy5zZXQoa2V5LCBleGlzdGluZyk7XG4gICAgICB9XG4gICAgfVxuICB9XG4gIGZvciAoY29uc3QgWywgcHJvdmlkZXJzXSBvZiBrZXlUb1Byb3ZpZGVycykge1xuICAgIGlmIChwcm92aWRlcnMubGVuZ3RoID4gMSkge1xuICAgICAgZmluZGluZ3MucHVzaCh7XG4gICAgICAgIHNldmVyaXR5OiBcIndhcm5pbmdcIixcbiAgICAgICAgbWVzc2FnZTogYFNhbWUga2V5IHVzZWQgYnkgbXVsdGlwbGUgcHJvdmlkZXJzOiAke3Byb3ZpZGVycy5qb2luKFwiLCBcIil9YCxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBmaW5kaW5ncztcbn1cblxuLyoqXG4gKiBGb3JtYXQgZG9jdG9yIGZpbmRpbmdzIGZvciBkaXNwbGF5LlxuICovXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0RG9jdG9yRmluZGluZ3MoZmluZGluZ3M6IERvY3RvckZpbmRpbmdbXSk6IHN0cmluZyB7XG4gIGlmIChmaW5kaW5ncy5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4gXCJBUEkgS2V5IEhlYWx0aCBDaGVja1xcblxcbiAgQWxsIGNoZWNrcyBwYXNzZWQuIE5vIGlzc3VlcyBmb3VuZC5cIjtcbiAgfVxuXG4gIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtcIkFQSSBLZXkgSGVhbHRoIENoZWNrXFxuXCJdO1xuXG4gIGZvciAoY29uc3QgZiBvZiBmaW5kaW5ncykge1xuICAgIGNvbnN0IGljb24gPVxuICAgICAgZi5zZXZlcml0eSA9PT0gXCJlcnJvclwiID8gXCJcdTI3MTdcIiA6XG4gICAgICBmLnNldmVyaXR5ID09PSBcIndhcm5pbmdcIiA/IFwiXHUyNkEwXCIgOlxuICAgICAgZi5zZXZlcml0eSA9PT0gXCJmaXhlZFwiID8gXCJcdTI3MTNcIiA6XG4gICAgICBcIlx1MjEzOVwiO1xuICAgIGxpbmVzLnB1c2goYCAgJHtpY29ufSAke2YubWVzc2FnZX1gKTtcbiAgfVxuXG4gIGxpbmVzLnB1c2goXCJcIik7XG4gIGNvbnN0IGVycm9ycyA9IGZpbmRpbmdzLmZpbHRlcigoZikgPT4gZi5zZXZlcml0eSA9PT0gXCJlcnJvclwiKS5sZW5ndGg7XG4gIGNvbnN0IHdhcm5pbmdzID0gZmluZGluZ3MuZmlsdGVyKChmKSA9PiBmLnNldmVyaXR5ID09PSBcIndhcm5pbmdcIikubGVuZ3RoO1xuICBjb25zdCBmaXhlZCA9IGZpbmRpbmdzLmZpbHRlcigoZikgPT4gZi5zZXZlcml0eSA9PT0gXCJmaXhlZFwiKS5sZW5ndGg7XG4gIGNvbnN0IGluZm8gPSBmaW5kaW5ncy5maWx0ZXIoKGYpID0+IGYuc2V2ZXJpdHkgPT09IFwiaW5mb1wiKS5sZW5ndGg7XG5cbiAgY29uc3QgcGFydHM6IHN0cmluZ1tdID0gW107XG4gIGlmIChlcnJvcnMgPiAwKSBwYXJ0cy5wdXNoKGAke2Vycm9yc30gZXJyb3Ike2Vycm9ycyA+IDEgPyBcInNcIiA6IFwiXCJ9YCk7XG4gIGlmICh3YXJuaW5ncyA+IDApIHBhcnRzLnB1c2goYCR7d2FybmluZ3N9IHdhcm5pbmcke3dhcm5pbmdzID4gMSA/IFwic1wiIDogXCJcIn1gKTtcbiAgaWYgKGZpeGVkID4gMCkgcGFydHMucHVzaChgJHtmaXhlZH0gZml4ZWRgKTtcbiAgaWYgKGluZm8gPiAwKSBwYXJ0cy5wdXNoKGAke2luZm99IGluZm9gKTtcbiAgbGluZXMucHVzaChgICAke3BhcnRzLmpvaW4oXCIgfCBcIil9YCk7XG5cbiAgcmV0dXJuIGxpbmVzLmpvaW4oXCJcXG5cIik7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBNYWluIEhhbmRsZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogTWFpbiBlbnRyeSBwb2ludCBmb3IgL2dzZCBrZXlzIFtzdWJjb21tYW5kXS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZUtleXMoXG4gIGFyZ3M6IHN0cmluZyxcbiAgY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCxcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBhdXRoID0gZ2V0S2V5TWFuYWdlckF1dGhTdG9yYWdlKCk7XG4gIGNvbnN0IHBhcnRzID0gYXJncy50cmltKCkuc3BsaXQoL1xccysvKTtcbiAgY29uc3Qgc3ViY29tbWFuZCA9IHBhcnRzWzBdIHx8IFwiXCI7XG4gIGNvbnN0IHN1YkFyZ3MgPSBwYXJ0cy5zbGljZSgxKS5qb2luKFwiIFwiKS50cmltKCk7XG5cbiAgc3dpdGNoIChzdWJjb21tYW5kKSB7XG4gICAgY2FzZSBcIlwiOlxuICAgIGNhc2UgXCJsaXN0XCI6XG4gICAgY2FzZSBcInN0YXR1c1wiOiB7XG4gICAgICBjb25zdCBzdGF0dXNlcyA9IGdldEFsbEtleVN0YXR1c2VzKGF1dGgpO1xuICAgICAgY3R4LnVpLm5vdGlmeShmb3JtYXRLZXlEYXNoYm9hcmQoc3RhdHVzZXMpLCBcImluZm9cIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY2FzZSBcImFkZFwiOiB7XG4gICAgICBjb25zdCBjaGFuZ2VkID0gYXdhaXQgaGFuZGxlQWRkS2V5KHN1YkFyZ3MsIGN0eCwgYXV0aCk7XG4gICAgICBpZiAoY2hhbmdlZCkge1xuICAgICAgICBhd2FpdCBjdHgud2FpdEZvcklkbGUoKTtcbiAgICAgICAgYXdhaXQgY3R4LnJlbG9hZCgpO1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNhc2UgXCJyZW1vdmVcIjpcbiAgICBjYXNlIFwicm1cIjpcbiAgICBjYXNlIFwiZGVsZXRlXCI6IHtcbiAgICAgIGNvbnN0IGNoYW5nZWQgPSBhd2FpdCBoYW5kbGVSZW1vdmVLZXkoc3ViQXJncywgY3R4LCBhdXRoKTtcbiAgICAgIGlmIChjaGFuZ2VkKSB7XG4gICAgICAgIGF3YWl0IGN0eC53YWl0Rm9ySWRsZSgpO1xuICAgICAgICBhd2FpdCBjdHgucmVsb2FkKCk7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY2FzZSBcInRlc3RcIjpcbiAgICBjYXNlIFwidmFsaWRhdGVcIjoge1xuICAgICAgbGV0IHByb3ZpZGVyczogUHJvdmlkZXJJbmZvW107XG4gICAgICBpZiAoc3ViQXJncykge1xuICAgICAgICBjb25zdCBwID0gZmluZFByb3ZpZGVyKHN1YkFyZ3MpO1xuICAgICAgICBpZiAoIXApIHtcbiAgICAgICAgICBjdHgudWkubm90aWZ5KGBVbmtub3duIHByb3ZpZGVyOiBcIiR7c3ViQXJnc31cIi5gLCBcImVycm9yXCIpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBwcm92aWRlcnMgPSBbcF07XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBUZXN0IGFsbCBjb25maWd1cmVkIHByb3ZpZGVyc1xuICAgICAgICBjb25zdCBzdGF0dXNlcyA9IGdldEFsbEtleVN0YXR1c2VzKGF1dGgpO1xuICAgICAgICBwcm92aWRlcnMgPSBzdGF0dXNlc1xuICAgICAgICAgIC5maWx0ZXIoKHMpID0+IHMuY29uZmlndXJlZClcbiAgICAgICAgICAubWFwKChzKSA9PiBzLnByb3ZpZGVyKTtcbiAgICAgIH1cblxuICAgICAgaWYgKHByb3ZpZGVycy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgY3R4LnVpLm5vdGlmeShcIk5vIGNvbmZpZ3VyZWQga2V5cyB0byB0ZXN0LlwiLCBcImluZm9cIik7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgY3R4LnVpLm5vdGlmeShgVGVzdGluZyAke3Byb3ZpZGVycy5sZW5ndGh9IGtleSR7cHJvdmlkZXJzLmxlbmd0aCA+IDEgPyBcInNcIiA6IFwiXCJ9Li4uYCwgXCJpbmZvXCIpO1xuXG4gICAgICBjb25zdCByZXN1bHRzOiBUZXN0UmVzdWx0W10gPSBbXTtcbiAgICAgIGZvciAoY29uc3QgcCBvZiBwcm92aWRlcnMpIHtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdGVzdFByb3ZpZGVyS2V5KHAsIGF1dGgpO1xuICAgICAgICByZXN1bHRzLnB1c2gocmVzdWx0KTtcbiAgICAgIH1cblxuICAgICAgY3R4LnVpLm5vdGlmeShmb3JtYXRUZXN0UmVzdWx0cyhyZXN1bHRzKSwgXCJpbmZvXCIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNhc2UgXCJyb3RhdGVcIjoge1xuICAgICAgY29uc3QgY2hhbmdlZCA9IGF3YWl0IGhhbmRsZVJvdGF0ZUtleShzdWJBcmdzLCBjdHgsIGF1dGgpO1xuICAgICAgaWYgKGNoYW5nZWQpIHtcbiAgICAgICAgYXdhaXQgY3R4LndhaXRGb3JJZGxlKCk7XG4gICAgICAgIGF3YWl0IGN0eC5yZWxvYWQoKTtcbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjYXNlIFwiZG9jdG9yXCI6XG4gICAgY2FzZSBcImhlYWx0aFwiOiB7XG4gICAgICBjb25zdCBmaW5kaW5ncyA9IHJ1bktleURvY3RvcihhdXRoKTtcbiAgICAgIGN0eC51aS5ub3RpZnkoZm9ybWF0RG9jdG9yRmluZGluZ3MoZmluZGluZ3MpLCBcImluZm9cIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgZGVmYXVsdDpcbiAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgIFwiVXNhZ2U6IC9nc2Qga2V5cyBbbGlzdHxhZGR8cmVtb3ZlfHRlc3R8cm90YXRlfGRvY3Rvcl1cXG5cXG5cIiArXG4gICAgICAgIFwiICAvZ3NkIGtleXMgICAgICAgICAgICAgIFNob3cga2V5IHN0YXR1cyBkYXNoYm9hcmRcXG5cIiArXG4gICAgICAgIFwiICAvZ3NkIGtleXMgbGlzdCAgICAgICAgIExpc3QgYWxsIGNvbmZpZ3VyZWQga2V5c1xcblwiICtcbiAgICAgICAgXCIgIC9nc2Qga2V5cyBhZGQgW2lkXSAgICAgQWRkIGEga2V5IGZvciBhIHByb3ZpZGVyXFxuXCIgK1xuICAgICAgICBcIiAgL2dzZCBrZXlzIHJlbW92ZSBbaWRdICBSZW1vdmUgYSBrZXlcXG5cIiArXG4gICAgICAgIFwiICAvZ3NkIGtleXMgdGVzdCBbaWRdICAgIFZhbGlkYXRlIGtleShzKSB3aXRoIEFQSSBjYWxsXFxuXCIgK1xuICAgICAgICBcIiAgL2dzZCBrZXlzIHJvdGF0ZSBbaWRdICBSZXBsYWNlIGFuIGV4aXN0aW5nIGtleVxcblwiICtcbiAgICAgICAgXCIgIC9nc2Qga2V5cyBkb2N0b3IgICAgICAgSGVhbHRoIGNoZWNrIGFsbCBrZXlzXCIsXG4gICAgICAgIFwiaW5mb1wiLFxuICAgICAgKTtcbiAgICAgIHJldHVybjtcbiAgfVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBUUE7QUFBQSxFQUNFO0FBQUEsT0FJSztBQUVQLFNBQVMsWUFBWSxVQUFVLGlCQUFpQjtBQUNoRCxTQUFTLE1BQU0sZUFBZTtBQUM5QixTQUFTLGlCQUFpQjtBQUMxQixTQUFTLHVCQUF1QjtBQUNoQyxTQUFTLGVBQWU7QUFnQmpCLE1BQU0sb0JBQW9DO0FBQUE7QUFBQSxFQUUvQyxFQUFFLElBQUksYUFBb0IsT0FBTyxzQkFBMkIsVUFBVSxPQUFPLFFBQVEscUJBQTBCLFVBQVUsQ0FBQyxTQUFTLEdBQUcsVUFBVSxNQUFNLGNBQWMsd0JBQXdCO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLEVBTTVMLEVBQUUsSUFBSSxlQUFvQixPQUFPLG1CQUEyQixVQUFVLE9BQXlDLFVBQVUsS0FBSztBQUFBLEVBQzlILEVBQUUsSUFBSSxVQUFvQixPQUFPLFVBQTJCLFVBQVUsT0FBTyxRQUFRLGtCQUEwQixVQUFVLENBQUMsS0FBSyxHQUFPLGNBQWMsK0JBQStCO0FBQUEsRUFDbkwsRUFBRSxJQUFJLGtCQUFvQixPQUFPLGtCQUEyQixVQUFVLE9BQU8sUUFBUSxnQkFBMEIsVUFBVSxLQUFLO0FBQUEsRUFDOUgsRUFBRSxJQUFJLGdCQUFvQixPQUFPLDRCQUEyQixVQUFVLE9BQXlDLFVBQVUsS0FBSztBQUFBLEVBQzlILEVBQUUsSUFBSSxxQkFBb0IsT0FBTyxxQkFBMkIsVUFBVSxPQUF5QyxVQUFVLEtBQUs7QUFBQSxFQUM5SCxFQUFFLElBQUksc0JBQXFCLE9BQU8sZUFBMEIsVUFBVSxPQUF5QyxVQUFVLEtBQUs7QUFBQSxFQUM5SCxFQUFFLElBQUksVUFBb0IsT0FBTyxtQkFBMkIsVUFBVSxPQUFPLFFBQVEsa0JBQTBCLGNBQWMsNkJBQTZCO0FBQUEsRUFDMUosRUFBRSxJQUFJLFFBQW9CLE9BQU8sUUFBMkIsVUFBVSxPQUFPLFFBQVEsZ0JBQTBCLGNBQWMsbUJBQW1CO0FBQUEsRUFDaEosRUFBRSxJQUFJLE9BQW9CLE9BQU8sY0FBMkIsVUFBVSxPQUFPLFFBQVEsZUFBMEIsY0FBYyxlQUFlO0FBQUEsRUFDNUksRUFBRSxJQUFJLGNBQW9CLE9BQU8sY0FBMkIsVUFBVSxPQUFPLFFBQVEsc0JBQTBCLGNBQWMscUJBQXFCO0FBQUEsRUFDbEosRUFBRSxJQUFJLFdBQW9CLE9BQU8sV0FBMkIsVUFBVSxPQUFPLFFBQVEsbUJBQTBCLGNBQWMscUJBQXFCO0FBQUEsRUFDbEosRUFBRSxJQUFJLFdBQW9CLE9BQU8sV0FBMkIsVUFBVSxPQUFPLFFBQVEsbUJBQTBCLGNBQWMsc0JBQXNCO0FBQUEsRUFDbkosRUFBRSxJQUFJLGNBQW9CLE9BQU8sY0FBMkIsVUFBVSxPQUFPLFFBQVEsc0JBQTBCLGNBQWMsc0JBQXNCO0FBQUEsRUFDbkosRUFBRSxJQUFJLGdCQUFvQixPQUFPLGdCQUEyQixVQUFVLE9BQU8sUUFBUSxpQkFBaUI7QUFBQSxFQUN0RyxFQUFFLElBQUksaUJBQW9CLE9BQU8sMEJBQTJCLFVBQVUsT0FBTyxRQUFRLHdCQUF3QjtBQUFBLEVBQzdHLEVBQUUsSUFBSSxZQUFvQixPQUFPLFlBQTJCLFVBQVUsT0FBTyxRQUFRLG1CQUFtQjtBQUFBLEVBQ3hHLEVBQUUsSUFBSSwwQkFBMEIsT0FBTyxnQkFBcUIsVUFBVSxPQUFPLFFBQVEsdUJBQXVCO0FBQUEsRUFDNUcsRUFBRSxJQUFJLHVCQUF1QixPQUFPLHVCQUF3QixVQUFVLE9BQU8sUUFBUSxtQkFBd0IsY0FBYyw2QkFBNkI7QUFBQSxFQUN4SixFQUFFLElBQUkscUJBQXVCLE9BQU8scUJBQXdCLFVBQVUsT0FBTyxRQUFRLHFCQUF3QixjQUFjLCtCQUErQjtBQUFBO0FBQUEsRUFHMUosRUFBRSxJQUFJLFlBQWEsT0FBTyxpQkFBcUIsVUFBVSxRQUFRLFFBQVEsb0JBQXFCLGNBQWMseUJBQXlCO0FBQUEsRUFDckksRUFBRSxJQUFJLFFBQWEsT0FBTyxxQkFBc0IsVUFBVSxRQUFRLFFBQVEsZ0JBQXFCLGNBQWMsY0FBYztBQUFBO0FBQUEsRUFHM0gsRUFBRSxJQUFJLFVBQWEsT0FBTyxpQkFBc0IsVUFBVSxVQUFVLFFBQVEsa0JBQW1CLGNBQWMsMEJBQTBCO0FBQUEsRUFDdkksRUFBRSxJQUFJLFNBQWEsT0FBTyxnQkFBc0IsVUFBVSxVQUFVLFFBQVEsaUJBQW1CLGNBQWMsdUJBQXVCO0FBQUE7QUFBQSxFQUdwSSxFQUFFLElBQUksZUFBZ0IsT0FBTyxlQUFtQixVQUFVLFVBQVUsUUFBUSxvQkFBb0I7QUFBQSxFQUNoRyxFQUFFLElBQUksYUFBZ0IsT0FBTyxhQUFvQixVQUFVLFVBQVUsUUFBUSxtQkFBcUIsVUFBVSxDQUFDLE9BQU8sRUFBRTtBQUFBLEVBQ3RILEVBQUUsSUFBSSxnQkFBZ0IsT0FBTyxnQkFBb0IsVUFBVSxVQUFVLFFBQVEscUJBQXFCO0FBQ3BHO0FBUU8sU0FBUyxRQUFRLEtBQXFCO0FBQzNDLE1BQUksQ0FBQyxJQUFLLFFBQU87QUFDakIsTUFBSSxJQUFJLFVBQVUsRUFBRyxRQUFPLElBQUksTUFBTSxHQUFHLENBQUMsSUFBSSxRQUFRLElBQUksTUFBTSxFQUFFO0FBQ2xFLFNBQU8sSUFBSSxNQUFNLEdBQUcsQ0FBQyxJQUFJLFFBQVEsSUFBSSxNQUFNLEVBQUU7QUFDL0M7QUFLTyxTQUFTLGVBQWUsSUFBb0I7QUFDakQsTUFBSSxNQUFNLEVBQUcsUUFBTztBQUNwQixRQUFNLFVBQVUsS0FBSyxNQUFNLEtBQUssR0FBSTtBQUNwQyxNQUFJLFVBQVUsR0FBSSxRQUFPLEdBQUcsT0FBTztBQUNuQyxRQUFNLFVBQVUsS0FBSyxNQUFNLFVBQVUsRUFBRTtBQUN2QyxNQUFJLFVBQVUsR0FBSSxRQUFPLEdBQUcsT0FBTztBQUNuQyxRQUFNLFFBQVEsS0FBSyxNQUFNLFVBQVUsRUFBRTtBQUNyQyxRQUFNLGdCQUFnQixVQUFVO0FBQ2hDLFNBQU8sZ0JBQWdCLElBQUksR0FBRyxLQUFLLEtBQUssYUFBYSxNQUFNLEdBQUcsS0FBSztBQUNyRTtBQUtPLFNBQVMsbUJBQW1CLE1BQThCO0FBQy9ELE1BQUksS0FBSyxTQUFTLFdBQVc7QUFDM0IsVUFBTSxVQUFVO0FBQ2hCLFFBQUksQ0FBQyxRQUFRLElBQUssUUFBTztBQUN6QixXQUFPLFlBQVksUUFBUSxRQUFRLEdBQUcsQ0FBQztBQUFBLEVBQ3pDO0FBQ0EsTUFBSSxLQUFLLFNBQVMsU0FBUztBQUN6QixVQUFNLFlBQVk7QUFDbEIsVUFBTSxZQUFZLFVBQVUsVUFBVSxLQUFLLElBQUk7QUFDL0MsUUFBSSxhQUFhLEVBQUcsUUFBTztBQUMzQixXQUFPLHFCQUFxQixlQUFlLFNBQVMsQ0FBQztBQUFBLEVBQ3ZEO0FBQ0EsU0FBTztBQUNUO0FBS08sU0FBUyxjQUFzQjtBQUNwQyxTQUFPLEtBQUssUUFBUSxHQUFHLFNBQVMsV0FBVztBQUM3QztBQUtPLFNBQVMsMkJBQXdDO0FBQ3RELFFBQU0sV0FBVyxZQUFZO0FBQzdCLFlBQVUsUUFBUSxRQUFRLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNoRCxTQUFPLFlBQVksT0FBTyxRQUFRO0FBQ3BDO0FBS08sU0FBUyxhQUFhLFdBQTZDO0FBQ3hFLFFBQU0sUUFBUSxVQUFVLFlBQVk7QUFDcEMsU0FBTyxrQkFBa0I7QUFBQSxJQUN2QixDQUFDLE1BQU0sRUFBRSxHQUFHLFlBQVksTUFBTSxTQUFTLEVBQUUsTUFBTSxZQUFZLE1BQU07QUFBQSxFQUNuRTtBQUNGO0FBZ0JPLFNBQVMsa0JBQWtCLE1BQWdDO0FBQ2hFLFNBQU8sa0JBQWtCLElBQUksQ0FBQyxhQUFhO0FBQ3pDLFVBQU0sV0FBVyxLQUFLLDBCQUEwQixTQUFTLEVBQUU7QUFFM0QsVUFBTSxRQUFRLFNBQVMsT0FBTyxDQUFDLE1BQU0sRUFBRSxFQUFFLFNBQVMsYUFBYSxDQUFFLEVBQXVCLElBQUk7QUFDNUYsVUFBTSxTQUFTLFNBQVMsU0FBUyxRQUFRLElBQUksU0FBUyxNQUFNLElBQUk7QUFFaEUsUUFBSSxNQUFNLFNBQVMsR0FBRztBQUNwQixZQUFNLFlBQVksTUFBTSxDQUFDO0FBQ3pCLFlBQU0sT0FDSixNQUFNLFNBQVMsSUFDWCxHQUFHLE1BQU0sTUFBTSx3QkFDZixtQkFBbUIsU0FBUztBQUNsQyxhQUFPO0FBQUEsUUFDTDtBQUFBLFFBQ0EsWUFBWTtBQUFBLFFBQ1osUUFBUTtBQUFBLFFBQ1IsaUJBQWlCLE1BQU07QUFBQSxRQUN2QixhQUFhO0FBQUEsUUFDYixXQUFXLEtBQUssMkJBQTJCLFNBQVMsRUFBRTtBQUFBLE1BQ3hEO0FBQUEsSUFDRjtBQUVBLFFBQUksUUFBUTtBQUNWLGFBQU87QUFBQSxRQUNMO0FBQUEsUUFDQSxZQUFZO0FBQUEsUUFDWixRQUFRO0FBQUEsUUFDUixpQkFBaUI7QUFBQSxRQUNqQixhQUFhLE9BQU8sU0FBUyxNQUFNO0FBQUEsUUFDbkMsV0FBVztBQUFBLE1BQ2I7QUFBQSxJQUNGO0FBRUEsV0FBTztBQUFBLE1BQ0w7QUFBQSxNQUNBLFlBQVk7QUFBQSxNQUNaLFFBQVE7QUFBQSxNQUNSLGlCQUFpQjtBQUFBLE1BQ2pCLGFBQWEsU0FBUyxlQUNsQixtQkFBbUIsU0FBUyxZQUFZLE1BQ3hDLFNBQVMsU0FDUCx3QkFBd0IsU0FBUyxNQUFNLE1BQ3ZDO0FBQUEsTUFDTixXQUFXO0FBQUEsSUFDYjtBQUFBLEVBQ0YsQ0FBQztBQUNIO0FBS08sU0FBUyxtQkFBbUIsVUFBK0I7QUFDaEUsUUFBTSxhQUF5RDtBQUFBLElBQzdELEVBQUUsT0FBTyxpQkFBaUIsS0FBSyxNQUFNO0FBQUEsSUFDckMsRUFBRSxPQUFPLG9CQUFvQixLQUFLLFNBQVM7QUFBQSxJQUMzQyxFQUFFLE9BQU8sYUFBYSxLQUFLLE9BQU87QUFBQSxJQUNsQyxFQUFFLE9BQU8sdUJBQXVCLEtBQUssU0FBUztBQUFBLEVBQ2hEO0FBRUEsUUFBTSxRQUFrQixDQUFDLHVCQUF1QjtBQUVoRCxhQUFXLE9BQU8sWUFBWTtBQUM1QixVQUFNLFFBQVEsU0FBUyxPQUFPLENBQUMsTUFBTSxFQUFFLFNBQVMsYUFBYSxJQUFJLEdBQUc7QUFDcEUsUUFBSSxNQUFNLFdBQVcsRUFBRztBQUV4QixVQUFNLEtBQUssS0FBSyxJQUFJLEtBQUssRUFBRTtBQUMzQixlQUFXLFFBQVEsT0FBTztBQUN4QixZQUFNLE9BQU8sS0FBSyxhQUFhLFdBQU07QUFDckMsWUFBTSxVQUFVLEtBQUssWUFBWSxrQkFBa0I7QUFDbkQsWUFBTSxNQUFNLEtBQUssU0FBUyxHQUFHLE9BQU8sRUFBRTtBQUN0QyxZQUFNLEtBQUssS0FBSyxJQUFJLElBQUksR0FBRyxXQUFNLEtBQUssV0FBVyxHQUFHLE9BQU8sRUFBRTtBQUFBLElBQy9EO0FBQ0EsVUFBTSxLQUFLLEVBQUU7QUFBQSxFQUNmO0FBR0EsUUFBTSxhQUFhLFNBQVMsT0FBTyxDQUFDLE1BQU0sRUFBRSxVQUFVO0FBQ3RELFFBQU0sV0FBVyxXQUFXLE9BQU8sQ0FBQyxNQUFNLEVBQUUsV0FBVyxXQUFXO0FBQ2xFLFFBQU0sVUFBVSxXQUFXLE9BQU8sQ0FBQyxNQUFNLEVBQUUsV0FBVyxLQUFLO0FBQzNELFFBQU0sYUFBYSxTQUFTLE9BQU8sQ0FBQyxNQUFNO0FBQ3hDLFFBQUksQ0FBQyxFQUFFLGNBQWMsRUFBRSxXQUFXLFlBQWEsUUFBTztBQUN0RCxXQUFPLEVBQUUsWUFBWSxXQUFXLE9BQU87QUFBQSxFQUN6QyxDQUFDLEVBQUU7QUFFSCxRQUFNLFFBQWtCLENBQUM7QUFDekIsUUFBTSxLQUFLLEdBQUcsV0FBVyxNQUFNLGFBQWE7QUFDNUMsTUFBSSxTQUFTLFNBQVMsRUFBRyxPQUFNLEtBQUssR0FBRyxTQUFTLE1BQU0sZUFBZTtBQUNyRSxNQUFJLFFBQVEsU0FBUyxFQUFHLE9BQU0sS0FBSyxHQUFHLFFBQVEsTUFBTSxXQUFXO0FBQy9ELE1BQUksYUFBYSxFQUFHLE9BQU0sS0FBSyxHQUFHLFVBQVUsUUFBUTtBQUVwRCxRQUFNLEtBQUssYUFBYSxZQUFZLENBQUMsRUFBRTtBQUN2QyxRQUFNLEtBQUssS0FBSyxNQUFNLEtBQUssS0FBSyxDQUFDLEVBQUU7QUFFbkMsU0FBTyxNQUFNLEtBQUssSUFBSTtBQUN4QjtBQU9BLGVBQXNCLGFBQ3BCLGFBQ0EsS0FDQSxNQUNrQjtBQUNsQixNQUFJO0FBRUosTUFBSSxhQUFhO0FBQ2YsZUFBVyxhQUFhLFdBQVc7QUFDbkMsUUFBSSxDQUFDLFVBQVU7QUFDYixVQUFJLEdBQUcsT0FBTyxzQkFBc0IsV0FBVyxxREFBcUQsT0FBTztBQUMzRyxhQUFPO0FBQUEsSUFDVDtBQUFBLEVBQ0YsT0FBTztBQUVMLFVBQU0sVUFBVSxrQkFBa0IsSUFBSSxDQUFDLE1BQU07QUFDM0MsWUFBTSxRQUFRLEtBQUssMEJBQTBCLEVBQUUsRUFBRSxFQUFFLE9BQU8sQ0FBQyxNQUFNLEVBQUUsRUFBRSxTQUFTLGFBQWEsQ0FBRSxFQUF1QixJQUFJO0FBQ3hILFlBQU0sV0FBVyxNQUFNLFNBQVMsSUFBSSxrQkFBa0I7QUFDdEQsYUFBTyxJQUFJLEVBQUUsUUFBUSxLQUFLLEVBQUUsS0FBSyxHQUFHLFFBQVE7QUFBQSxJQUM5QyxDQUFDO0FBQ0QsVUFBTSxTQUFTLE1BQU0sSUFBSSxHQUFHLE9BQU8sK0JBQStCLE9BQU87QUFDekUsUUFBSSxDQUFDLFVBQVUsT0FBTyxXQUFXLFNBQVUsUUFBTztBQUVsRCxVQUFNLE1BQU0sUUFBUSxRQUFRLE1BQU07QUFDbEMsUUFBSSxRQUFRLEdBQUksUUFBTztBQUN2QixlQUFXLGtCQUFrQixHQUFHO0FBQUEsRUFDbEM7QUFHQSxNQUFJLFNBQVMsVUFBVTtBQUNyQixVQUFNLFVBQVUsQ0FBQyxXQUFXLHVCQUF1QjtBQUNuRCxVQUFNLFNBQVMsTUFBTSxJQUFJLEdBQUc7QUFBQSxNQUMxQixHQUFHLFNBQVMsS0FBSztBQUFBLE1BQ2pCO0FBQUEsSUFDRjtBQUNBLFFBQUksQ0FBQyxVQUFVLE9BQU8sV0FBVyxTQUFVLFFBQU87QUFFbEQsUUFBSSxPQUFPLFNBQVMsT0FBTyxHQUFHO0FBQzVCLFVBQUksR0FBRztBQUFBLFFBQ0wsNkNBQTZDLFNBQVMsS0FBSztBQUFBO0FBQUEsUUFFM0Q7QUFBQSxNQUNGO0FBQ0EsYUFBTztBQUFBLElBQ1Q7QUFBQSxFQUNGO0FBR0EsUUFBTSxRQUFRLE1BQU0sSUFBSSxHQUFHO0FBQUEsSUFDekIsZUFBZSxTQUFTLEtBQUs7QUFBQSxJQUM3QixTQUFTLFNBQVMsVUFBVSxTQUFTLE1BQU0sYUFBYTtBQUFBLEVBQzFEO0FBRUEsTUFBSSxVQUFVLFFBQVEsVUFBVSxPQUFXLFFBQU87QUFDbEQsUUFBTSxNQUFNLE1BQU0sS0FBSztBQUN2QixNQUFJLENBQUMsS0FBSztBQUNSLFFBQUksR0FBRyxPQUFPLG9CQUFvQixTQUFTO0FBQzNDLFdBQU87QUFBQSxFQUNUO0FBR0EsTUFBSSxTQUFTLFlBQVksU0FBUyxTQUFTLFNBQVMsR0FBRztBQUNyRCxVQUFNLFFBQVEsU0FBUyxTQUFTLEtBQUssQ0FBQyxRQUFRLElBQUksV0FBVyxHQUFHLENBQUM7QUFDakUsUUFBSSxDQUFDLE9BQU87QUFDVixVQUFJLEdBQUc7QUFBQSxRQUNMLG9EQUFvRCxTQUFTLFNBQVMsS0FBSyxNQUFNLENBQUM7QUFBQSxRQUNsRjtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUVBLE9BQUssSUFBSSxTQUFTLElBQUksRUFBRSxNQUFNLFdBQVcsSUFBSSxDQUFDO0FBQzlDLE1BQUksU0FBUyxRQUFRO0FBQ25CLFlBQVEsSUFBSSxTQUFTLE1BQU0sSUFBSTtBQUFBLEVBQ2pDO0FBRUEsTUFBSSxHQUFHLE9BQU8saUJBQWlCLFNBQVMsS0FBSyxLQUFLLFFBQVEsR0FBRyxDQUFDLElBQUksU0FBUztBQUMzRSxTQUFPO0FBQ1Q7QUFPQSxlQUFzQixnQkFDcEIsYUFDQSxLQUNBLE1BQ2tCO0FBQ2xCLE1BQUk7QUFFSixNQUFJLGFBQWE7QUFDZixlQUFXLGFBQWEsV0FBVztBQUNuQyxRQUFJLENBQUMsVUFBVTtBQUNiLFVBQUksR0FBRyxPQUFPLHNCQUFzQixXQUFXLE1BQU0sT0FBTztBQUM1RCxhQUFPO0FBQUEsSUFDVDtBQUFBLEVBQ0YsT0FBTztBQUVMLFVBQU0sYUFBYSxrQkFBa0IsT0FBTyxDQUFDLE1BQU07QUFDakQsWUFBTUEsU0FBUSxLQUFLLDBCQUEwQixFQUFFLEVBQUUsRUFBRSxPQUFPLENBQUMsTUFBTSxFQUFFLEVBQUUsU0FBUyxhQUFhLENBQUUsRUFBdUIsSUFBSTtBQUN4SCxhQUFPQSxPQUFNLFNBQVM7QUFBQSxJQUN4QixDQUFDO0FBRUQsUUFBSSxXQUFXLFdBQVcsR0FBRztBQUMzQixVQUFJLEdBQUcsT0FBTyxpQ0FBaUMsTUFBTTtBQUNyRCxhQUFPO0FBQUEsSUFDVDtBQUVBLFVBQU0sVUFBVSxXQUFXLElBQUksQ0FBQyxNQUFNLEVBQUUsS0FBSztBQUM3QyxVQUFNLFNBQVMsTUFBTSxJQUFJLEdBQUcsT0FBTyxrQ0FBa0MsT0FBTztBQUM1RSxRQUFJLENBQUMsVUFBVSxPQUFPLFdBQVcsU0FBVSxRQUFPO0FBRWxELGVBQVcsV0FBVyxLQUFLLENBQUMsTUFBTSxFQUFFLFVBQVUsTUFBTTtBQUNwRCxRQUFJLENBQUMsU0FBVSxRQUFPO0FBQUEsRUFDeEI7QUFFQSxRQUFNLFFBQVEsS0FBSywwQkFBMEIsU0FBUyxFQUFFO0FBQ3hELE1BQUksTUFBTSxXQUFXLEdBQUc7QUFDdEIsUUFBSSxHQUFHLE9BQU8scUJBQXFCLFNBQVMsS0FBSyxLQUFLLE1BQU07QUFDNUQsV0FBTztBQUFBLEVBQ1Q7QUFHQSxNQUFJLE1BQU0sU0FBUyxHQUFHO0FBQ3BCLFVBQU0sVUFBVSxNQUFNLElBQUksQ0FBQyxHQUFHLE1BQU0sSUFBSSxJQUFJLENBQUMsS0FBSyxtQkFBbUIsQ0FBQyxDQUFDLEVBQUU7QUFDekUsWUFBUSxLQUFLLFlBQVk7QUFFekIsVUFBTSxTQUFTLE1BQU0sSUFBSSxHQUFHO0FBQUEsTUFDMUIsR0FBRyxTQUFTLEtBQUssUUFBUSxNQUFNLE1BQU07QUFBQSxNQUNyQztBQUFBLElBQ0Y7QUFDQSxRQUFJLENBQUMsVUFBVSxPQUFPLFdBQVcsU0FBVSxRQUFPO0FBRWxELFFBQUksV0FBVyxjQUFjO0FBQzNCLFdBQUssT0FBTyxTQUFTLEVBQUU7QUFBQSxJQUN6QixPQUFPO0FBRUwsWUFBTSxNQUFNLFFBQVEsUUFBUSxNQUFNO0FBQ2xDLFVBQUksUUFBUSxNQUFNLE9BQU8sTUFBTSxPQUFRLFFBQU87QUFDOUMsWUFBTSxZQUFZLE1BQU0sT0FBTyxDQUFDLEdBQUcsTUFBTSxNQUFNLEdBQUc7QUFDbEQsV0FBSyxPQUFPLFNBQVMsRUFBRTtBQUN2QixpQkFBVyxLQUFLLFdBQVc7QUFDekIsYUFBSyxJQUFJLFNBQVMsSUFBSSxDQUFDO0FBQUEsTUFDekI7QUFBQSxJQUNGO0FBQUEsRUFDRixPQUFPO0FBQ0wsVUFBTSxZQUFZLE1BQU0sSUFBSSxHQUFHO0FBQUEsTUFDN0I7QUFBQSxNQUNBLFVBQVUsbUJBQW1CLE1BQU0sQ0FBQyxDQUFDLENBQUMsUUFBUSxTQUFTLEtBQUs7QUFBQSxJQUM5RDtBQUNBLFFBQUksQ0FBQyxVQUFXLFFBQU87QUFDdkIsU0FBSyxPQUFPLFNBQVMsRUFBRTtBQUFBLEVBQ3pCO0FBR0EsTUFBSSxTQUFTLFVBQVUsUUFBUSxJQUFJLFNBQVMsTUFBTSxHQUFHO0FBQ25ELFdBQU8sUUFBUSxJQUFJLFNBQVMsTUFBTTtBQUFBLEVBQ3BDO0FBRUEsTUFBSSxHQUFHLE9BQU8sbUJBQW1CLFNBQVMsS0FBSyxLQUFLLFNBQVM7QUFDN0QsU0FBTztBQUNUO0FBWUEsTUFBTSxpQkFBcUk7QUFBQSxFQUN6SSxXQUFXO0FBQUEsSUFDVCxLQUFLO0FBQUEsSUFDTCxRQUFRO0FBQUEsSUFDUixTQUFTLENBQUMsU0FBUztBQUFBLE1BQ2pCLGFBQWE7QUFBQSxNQUNiLHFCQUFxQjtBQUFBLE1BQ3JCLGdCQUFnQjtBQUFBLElBQ2xCO0FBQUEsSUFDQSxNQUFNLEtBQUssVUFBVSxFQUFFLE9BQU8sNEJBQTRCLFlBQVksR0FBRyxVQUFVLENBQUMsRUFBRSxNQUFNLFFBQVEsU0FBUyxLQUFLLENBQUMsRUFBRSxDQUFDO0FBQUEsRUFDeEg7QUFBQSxFQUNBLFFBQVE7QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFNBQVMsQ0FBQyxTQUFTLEVBQUUsZUFBZSxVQUFVLEdBQUcsR0FBRztBQUFBLEVBQ3REO0FBQUEsRUFDQSxRQUFRO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxTQUFTLENBQUMsU0FBUyxFQUFFLGtCQUFrQixJQUFJO0FBQUEsRUFDN0M7QUFBQSxFQUNBLE1BQU07QUFBQSxJQUNKLEtBQUs7QUFBQSxJQUNMLFNBQVMsQ0FBQyxTQUFTLEVBQUUsZUFBZSxVQUFVLEdBQUcsR0FBRztBQUFBLEVBQ3REO0FBQUEsRUFDQSxPQUFPO0FBQUEsSUFDTCxLQUFLO0FBQUEsSUFDTCxTQUFTLENBQUMsU0FBUyxFQUFFLHdCQUF3QixJQUFJO0FBQUEsRUFDbkQ7QUFBQSxFQUNBLFFBQVE7QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFFBQVE7QUFBQSxJQUNSLFNBQVMsT0FBTyxFQUFFLGdCQUFnQixtQkFBbUI7QUFBQSxJQUNyRCxNQUFNLEtBQUssVUFBVSxFQUFFLE9BQU8sUUFBUSxhQUFhLEVBQUUsQ0FBQztBQUFBLEVBQ3hEO0FBQUEsRUFDQSxhQUFhO0FBQUEsSUFDWCxLQUFLO0FBQUEsSUFDTCxTQUFTLENBQUMsU0FBUyxFQUFFLGVBQWUsT0FBTyxHQUFHLEdBQUc7QUFBQSxFQUNuRDtBQUFBLEVBQ0EsV0FBVztBQUFBLElBQ1QsS0FBSztBQUFBLElBQ0wsU0FBUyxDQUFDLFNBQVMsRUFBRSxlQUFlLFVBQVUsR0FBRyxHQUFHO0FBQUEsRUFDdEQ7QUFBQSxFQUNBLGNBQWM7QUFBQSxJQUNaLEtBQUs7QUFBQTtBQUFBLElBQ0wsU0FBUyxPQUFPLENBQUM7QUFBQSxFQUNuQjtBQUFBLEVBQ0EsS0FBSztBQUFBLElBQ0gsS0FBSztBQUFBLElBQ0wsU0FBUyxDQUFDLFNBQVMsRUFBRSxlQUFlLFVBQVUsR0FBRyxHQUFHO0FBQUEsRUFDdEQ7QUFBQSxFQUNBLFNBQVM7QUFBQSxJQUNQLEtBQUs7QUFBQSxJQUNMLFNBQVMsQ0FBQyxTQUFTLEVBQUUsZUFBZSxVQUFVLEdBQUcsR0FBRztBQUFBLEVBQ3REO0FBQUEsRUFDQSxTQUFTO0FBQUEsSUFDUCxLQUFLO0FBQUEsSUFDTCxRQUFRO0FBQUEsSUFDUixTQUFTLENBQUMsU0FBUztBQUFBLE1BQ2pCLGFBQWE7QUFBQSxNQUNiLHFCQUFxQjtBQUFBLE1BQ3JCLGdCQUFnQjtBQUFBLElBQ2xCO0FBQUEsSUFDQSxNQUFNLEtBQUssVUFBVSxFQUFFLE9BQU8sZ0JBQWdCLFlBQVksR0FBRyxVQUFVLENBQUMsRUFBRSxNQUFNLFFBQVEsU0FBUyxLQUFLLENBQUMsRUFBRSxDQUFDO0FBQUEsRUFDNUc7QUFBQSxFQUNBLGNBQWM7QUFBQSxJQUNaLEtBQUs7QUFBQSxJQUNMLFFBQVE7QUFBQSxJQUNSLFNBQVMsQ0FBQyxTQUFTO0FBQUEsTUFDakIsYUFBYTtBQUFBLE1BQ2IscUJBQXFCO0FBQUEsTUFDckIsZ0JBQWdCO0FBQUEsSUFDbEI7QUFBQSxJQUNBLE1BQU0sS0FBSyxVQUFVLEVBQUUsT0FBTyxnQkFBZ0IsWUFBWSxHQUFHLFVBQVUsQ0FBQyxFQUFFLE1BQU0sUUFBUSxTQUFTLEtBQUssQ0FBQyxFQUFFLENBQUM7QUFBQSxFQUM1RztBQUFBLEVBQ0EsWUFBWTtBQUFBLElBQ1YsS0FBSztBQUFBLElBQ0wsU0FBUyxDQUFDLFNBQVMsRUFBRSxlQUFlLFVBQVUsR0FBRyxHQUFHO0FBQUEsRUFDdEQ7QUFDRjtBQUtBLGVBQXNCLGdCQUNwQixVQUNBLE1BQ3FCO0FBRXJCLFFBQU0sTUFBTSxNQUFNLEtBQUssVUFBVSxTQUFTLEVBQUU7QUFDNUMsTUFBSSxDQUFDLE9BQU8sUUFBUSxtQkFBbUI7QUFDckMsUUFBSSxDQUFDLEtBQUs7QUFDUixhQUFPLEVBQUUsVUFBVSxRQUFRLFdBQVcsU0FBUyxpQkFBaUI7QUFBQSxJQUNsRTtBQUNBLFdBQU8sRUFBRSxVQUFVLFFBQVEsV0FBVyxTQUFTLHVDQUF1QztBQUFBLEVBQ3hGO0FBRUEsUUFBTSxXQUFXLGVBQWUsU0FBUyxFQUFFO0FBQzNDLE1BQUksQ0FBQyxVQUFVO0FBQ2IsV0FBTyxFQUFFLFVBQVUsUUFBUSxXQUFXLFNBQVMsOEJBQThCO0FBQUEsRUFDL0U7QUFHQSxNQUFJLE1BQU0sU0FBUztBQUNuQixNQUFJLFNBQVMsT0FBTyxnQkFBZ0I7QUFDbEMsVUFBTSwrQkFBK0IsR0FBRztBQUFBLEVBQzFDO0FBR0EsTUFBSSxPQUFPLFNBQVM7QUFDcEIsTUFBSSxTQUFTLE9BQU8sWUFBWSxNQUFNO0FBQ3BDLFVBQU0sU0FBUyxLQUFLLE1BQU0sSUFBSTtBQUM5QixXQUFPLFVBQVU7QUFDakIsV0FBTyxLQUFLLFVBQVUsTUFBTTtBQUFBLEVBQzlCO0FBRUEsUUFBTSxRQUFRLEtBQUssSUFBSTtBQUN2QixNQUFJO0FBQ0YsVUFBTSxNQUFNLE1BQU0sTUFBTSxLQUFLO0FBQUEsTUFDM0IsUUFBUSxTQUFTLFVBQVU7QUFBQSxNQUMzQixTQUFTLFNBQVMsVUFBVSxHQUFHLEtBQUssQ0FBQztBQUFBLE1BQ3JDLE1BQU0sUUFBUTtBQUFBLE1BQ2QsUUFBUSxZQUFZLFFBQVEsSUFBTTtBQUFBLElBQ3BDLENBQUM7QUFDRCxVQUFNLFlBQVksS0FBSyxJQUFJLElBQUk7QUFFL0IsUUFBSSxJQUFJLElBQUk7QUFDVixhQUFPLEVBQUUsVUFBVSxRQUFRLFNBQVMsU0FBUyxTQUFTLFVBQVU7QUFBQSxJQUNsRTtBQUVBLFFBQUksSUFBSSxXQUFXLE9BQU8sSUFBSSxXQUFXLEtBQUs7QUFDNUMsYUFBTyxFQUFFLFVBQVUsUUFBUSxXQUFXLFNBQVMsZ0JBQWdCLElBQUksTUFBTSxLQUFLLFVBQVU7QUFBQSxJQUMxRjtBQUVBLFFBQUksSUFBSSxXQUFXLEtBQUs7QUFDdEIsYUFBTyxFQUFFLFVBQVUsUUFBUSxnQkFBZ0IsU0FBUyxnQkFBZ0IsVUFBVTtBQUFBLElBQ2hGO0FBRUEsV0FBTyxFQUFFLFVBQVUsUUFBUSxTQUFTLFNBQVMsUUFBUSxJQUFJLE1BQU0sSUFBSSxVQUFVO0FBQUEsRUFDL0UsU0FBUyxLQUFLO0FBQ1osVUFBTSxZQUFZLEtBQUssSUFBSSxJQUFJO0FBQy9CLFVBQU0sTUFBTSxnQkFBZ0IsR0FBRztBQUMvQixRQUFJLElBQUksU0FBUyxTQUFTLEtBQUssSUFBSSxTQUFTLFlBQVksR0FBRztBQUN6RCxhQUFPLEVBQUUsVUFBVSxRQUFRLFNBQVMsU0FBUyxpQkFBaUIsVUFBVTtBQUFBLElBQzFFO0FBQ0EsV0FBTyxFQUFFLFVBQVUsUUFBUSxTQUFTLFNBQVMsS0FBSyxVQUFVO0FBQUEsRUFDOUQ7QUFDRjtBQUtPLFNBQVMsa0JBQWtCLFNBQStCO0FBQy9ELFFBQU0sUUFBa0IsQ0FBQyx3QkFBd0I7QUFFakQsYUFBVyxLQUFLLFNBQVM7QUFDdkIsVUFBTSxPQUNKLEVBQUUsV0FBVyxVQUFVLFdBQ3ZCLEVBQUUsV0FBVyxZQUFZLFdBQ3pCLEVBQUUsV0FBVyxpQkFBaUIsV0FDOUIsRUFBRSxXQUFXLFVBQVUsV0FDdkI7QUFDRixVQUFNLE1BQU0sRUFBRSxTQUFTLEdBQUcsT0FBTyxFQUFFO0FBQ25DLFVBQU0sVUFBVSxFQUFFLGNBQWMsU0FBWSxLQUFLLEVBQUUsU0FBUyxPQUFPO0FBQ25FLFVBQU0sS0FBSyxLQUFLLElBQUksSUFBSSxHQUFHLFdBQU0sRUFBRSxPQUFPLEdBQUcsT0FBTyxFQUFFO0FBQUEsRUFDeEQ7QUFFQSxRQUFNLEtBQUssRUFBRTtBQUNiLFFBQU0sUUFBUSxRQUFRLE9BQU8sQ0FBQyxNQUFNLEVBQUUsV0FBVyxPQUFPLEVBQUU7QUFDMUQsUUFBTSxVQUFVLFFBQVEsT0FBTyxDQUFDLE1BQU0sRUFBRSxXQUFXLFNBQVMsRUFBRTtBQUM5RCxRQUFNLGNBQWMsUUFBUSxPQUFPLENBQUMsTUFBTSxFQUFFLFdBQVcsY0FBYyxFQUFFO0FBQ3ZFLFFBQU0sU0FBUyxRQUFRLE9BQU8sQ0FBQyxNQUFNLEVBQUUsV0FBVyxPQUFPLEVBQUU7QUFDM0QsUUFBTSxVQUFVLFFBQVEsT0FBTyxDQUFDLE1BQU0sRUFBRSxXQUFXLFNBQVMsRUFBRTtBQUU5RCxRQUFNLFFBQWtCLENBQUM7QUFDekIsTUFBSSxRQUFRLEVBQUcsT0FBTSxLQUFLLEdBQUcsS0FBSyxRQUFRO0FBQzFDLE1BQUksVUFBVSxFQUFHLE9BQU0sS0FBSyxHQUFHLE9BQU8sVUFBVTtBQUNoRCxNQUFJLGNBQWMsRUFBRyxPQUFNLEtBQUssR0FBRyxXQUFXLGVBQWU7QUFDN0QsTUFBSSxTQUFTLEVBQUcsT0FBTSxLQUFLLEdBQUcsTUFBTSxTQUFTO0FBQzdDLE1BQUksVUFBVSxFQUFHLE9BQU0sS0FBSyxHQUFHLE9BQU8sVUFBVTtBQUNoRCxRQUFNLEtBQUssS0FBSyxNQUFNLEtBQUssS0FBSyxDQUFDLEVBQUU7QUFFbkMsU0FBTyxNQUFNLEtBQUssSUFBSTtBQUN4QjtBQU9BLGVBQXNCLGdCQUNwQixhQUNBLEtBQ0EsTUFDa0I7QUFDbEIsTUFBSTtBQUVKLE1BQUksYUFBYTtBQUNmLGVBQVcsYUFBYSxXQUFXO0FBQ25DLFFBQUksQ0FBQyxVQUFVO0FBQ2IsVUFBSSxHQUFHLE9BQU8sc0JBQXNCLFdBQVcsTUFBTSxPQUFPO0FBQzVELGFBQU87QUFBQSxJQUNUO0FBQUEsRUFDRixPQUFPO0FBRUwsVUFBTSxhQUFhLGtCQUFrQixPQUFPLENBQUMsTUFBTTtBQUNqRCxZQUFNQSxTQUFRLEtBQUssMEJBQTBCLEVBQUUsRUFBRTtBQUNqRCxhQUFPQSxPQUFNLEtBQUssQ0FBQyxNQUFNLEVBQUUsU0FBUyxhQUFjLEVBQXVCLEdBQUc7QUFBQSxJQUM5RSxDQUFDO0FBRUQsUUFBSSxXQUFXLFdBQVcsR0FBRztBQUMzQixVQUFJLEdBQUcsT0FBTyxxQ0FBcUMsTUFBTTtBQUN6RCxhQUFPO0FBQUEsSUFDVDtBQUVBLFVBQU0sVUFBVSxXQUFXLElBQUksQ0FBQyxNQUFNLEVBQUUsS0FBSztBQUM3QyxVQUFNLFNBQVMsTUFBTSxJQUFJLEdBQUcsT0FBTyxrQ0FBa0MsT0FBTztBQUM1RSxRQUFJLENBQUMsVUFBVSxPQUFPLFdBQVcsU0FBVSxRQUFPO0FBRWxELGVBQVcsV0FBVyxLQUFLLENBQUMsTUFBTSxFQUFFLFVBQVUsTUFBTTtBQUNwRCxRQUFJLENBQUMsU0FBVSxRQUFPO0FBQUEsRUFDeEI7QUFFQSxRQUFNLFFBQVEsS0FBSywwQkFBMEIsU0FBUyxFQUFFO0FBQ3hELFFBQU0sY0FBYyxNQUFNLE9BQU8sQ0FBQyxNQUFNLEVBQUUsU0FBUyxTQUFTO0FBRTVELE1BQUksWUFBWSxXQUFXLEdBQUc7QUFDNUIsUUFBSSxHQUFHLE9BQU8sbUJBQW1CLFNBQVMsS0FBSyw2QkFBNkIsTUFBTTtBQUNsRixXQUFPO0FBQUEsRUFDVDtBQUdBLFFBQU0sY0FBYyxZQUFZLElBQUksQ0FBQyxNQUFNLFFBQVEsRUFBRSxHQUFHLENBQUMsRUFBRSxLQUFLLElBQUk7QUFDcEUsTUFBSSxHQUFHLE9BQU8sY0FBYyxZQUFZLFNBQVMsSUFBSSxNQUFNLEVBQUUsS0FBSyxXQUFXLElBQUksTUFBTTtBQUd2RixRQUFNLFFBQVEsTUFBTSxJQUFJLEdBQUc7QUFBQSxJQUN6QixtQkFBbUIsU0FBUyxLQUFLO0FBQUEsSUFDakM7QUFBQSxFQUNGO0FBRUEsTUFBSSxVQUFVLFFBQVEsVUFBVSxPQUFXLFFBQU87QUFDbEQsUUFBTSxTQUFTLE1BQU0sS0FBSztBQUMxQixNQUFJLENBQUMsUUFBUTtBQUNYLFFBQUksR0FBRyxPQUFPLHdDQUF3QyxTQUFTO0FBQy9ELFdBQU87QUFBQSxFQUNUO0FBR0EsTUFBSSxTQUFTLFlBQVksU0FBUyxTQUFTLFNBQVMsR0FBRztBQUNyRCxVQUFNLFFBQVEsU0FBUyxTQUFTLEtBQUssQ0FBQyxRQUFRLE9BQU8sV0FBVyxHQUFHLENBQUM7QUFDcEUsUUFBSSxDQUFDLE9BQU87QUFDVixVQUFJLEdBQUc7QUFBQSxRQUNMLG9EQUFvRCxTQUFTLFNBQVMsS0FBSyxNQUFNLENBQUM7QUFBQSxRQUNsRjtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUdBLFFBQU0sYUFBYSxNQUFNLElBQUksR0FBRztBQUFBLElBQzlCO0FBQUEsSUFDQTtBQUFBLEVBQ0Y7QUFFQSxNQUFJLFlBQVk7QUFFZCxVQUFNLFdBQVcsWUFBWSxTQUFTLEVBQUUsQ0FBQyxTQUFTLEVBQUUsR0FBRyxFQUFFLE1BQU0sV0FBVyxLQUFLLE9BQU8sRUFBRSxDQUFDO0FBQ3pGLFVBQU0sU0FBUyxNQUFNLGdCQUFnQixVQUFVLFFBQVE7QUFFdkQsUUFBSSxPQUFPLFdBQVcsV0FBVztBQUMvQixVQUFJLEdBQUcsT0FBTywwQkFBMEIsT0FBTyxPQUFPLHlCQUF5QixPQUFPO0FBQ3RGLGFBQU87QUFBQSxJQUNUO0FBRUEsUUFBSSxPQUFPLFdBQVcsU0FBUztBQUM3QixVQUFJLEdBQUcsT0FBTywrQkFBK0IsT0FBTyxTQUFTLFFBQVEsU0FBUztBQUFBLElBQ2hGLE9BQU87QUFDTCxVQUFJLEdBQUcsT0FBTyxvQkFBb0IsT0FBTyxPQUFPLHdCQUF3QixTQUFTO0FBQUEsSUFDbkY7QUFBQSxFQUNGO0FBSUEsUUFBTSxhQUFhLE1BQU0sT0FBTyxDQUFDLE1BQU0sRUFBRSxTQUFTLE9BQU87QUFDekQsT0FBSyxPQUFPLFNBQVMsRUFBRTtBQUN2QixhQUFXLEtBQUssWUFBWTtBQUMxQixTQUFLLElBQUksU0FBUyxJQUFJLENBQUM7QUFBQSxFQUN6QjtBQUNBLE9BQUssSUFBSSxTQUFTLElBQUksRUFBRSxNQUFNLFdBQVcsS0FBSyxPQUFPLENBQUM7QUFFdEQsTUFBSSxTQUFTLFFBQVE7QUFDbkIsWUFBUSxJQUFJLFNBQVMsTUFBTSxJQUFJO0FBQUEsRUFDakM7QUFFQSxNQUFJLEdBQUcsT0FBTyxtQkFBbUIsU0FBUyxLQUFLLEtBQUssUUFBUSxNQUFNLENBQUMsSUFBSSxTQUFTO0FBQ2hGLFNBQU87QUFDVDtBQWFPLFNBQVMsYUFBYSxNQUFvQztBQUMvRCxRQUFNLFdBQTRCLENBQUM7QUFHbkMsUUFBTSxXQUFXLFlBQVk7QUFDN0IsTUFBSSxXQUFXLFFBQVEsR0FBRztBQUN4QixRQUFJO0FBQ0YsWUFBTSxRQUFRLFNBQVMsUUFBUTtBQUMvQixZQUFNLE9BQU8sTUFBTSxPQUFPO0FBQzFCLFVBQUksU0FBUyxLQUFPO0FBQ2xCLGtCQUFVLFVBQVUsR0FBSztBQUN6QixpQkFBUyxLQUFLO0FBQUEsVUFDWixVQUFVO0FBQUEsVUFDVixTQUFTLDhCQUE4QixLQUFLLFNBQVMsQ0FBQyxDQUFDO0FBQUEsUUFDekQsQ0FBQztBQUFBLE1BQ0g7QUFBQSxJQUNGLFFBQVE7QUFBQSxJQUVSO0FBQUEsRUFDRjtBQUdBLGFBQVcsWUFBWSxtQkFBbUI7QUFDeEMsVUFBTSxRQUFRLEtBQUssMEJBQTBCLFNBQVMsRUFBRTtBQUN4RCxlQUFXLFFBQVEsT0FBTztBQUN4QixVQUFJLEtBQUssU0FBUyxhQUFhLENBQUUsS0FBMEIsS0FBSztBQUM5RCxpQkFBUyxLQUFLO0FBQUEsVUFDWixVQUFVO0FBQUEsVUFDVixVQUFVLFNBQVM7QUFBQSxVQUNuQixTQUFTLEdBQUcsU0FBUyxLQUFLLG9FQUErRCxTQUFTLEVBQUU7QUFBQSxRQUN0RyxDQUFDO0FBQUEsTUFDSDtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBR0EsYUFBVyxZQUFZLG1CQUFtQjtBQUN4QyxVQUFNLFFBQVEsS0FBSywwQkFBMEIsU0FBUyxFQUFFO0FBQ3hELGVBQVcsUUFBUSxPQUFPO0FBQ3hCLFVBQUksS0FBSyxTQUFTLFNBQVM7QUFDekIsY0FBTSxZQUFZO0FBQ2xCLGNBQU0sWUFBWSxVQUFVLFVBQVUsS0FBSyxJQUFJO0FBQy9DLFlBQUksYUFBYSxHQUFHO0FBQ2xCLG1CQUFTLEtBQUs7QUFBQSxZQUNaLFVBQVU7QUFBQSxZQUNWLFVBQVUsU0FBUztBQUFBLFlBQ25CLFNBQVMsR0FBRyxTQUFTLEtBQUs7QUFBQSxVQUM1QixDQUFDO0FBQUEsUUFDSCxXQUFXLFlBQVksSUFBSSxLQUFLLEtBQU07QUFDcEMsbUJBQVMsS0FBSztBQUFBLFlBQ1osVUFBVTtBQUFBLFlBQ1YsVUFBVSxTQUFTO0FBQUEsWUFDbkIsU0FBUyxHQUFHLFNBQVMsS0FBSyw0QkFBNEIsZUFBZSxTQUFTLENBQUM7QUFBQSxVQUNqRixDQUFDO0FBQUEsUUFDSDtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUdBLGFBQVcsWUFBWSxtQkFBbUI7QUFDeEMsUUFBSSxDQUFDLFNBQVMsT0FBUTtBQUN0QixVQUFNLFdBQVcsUUFBUSxJQUFJLFNBQVMsTUFBTTtBQUM1QyxRQUFJLENBQUMsU0FBVTtBQUVmLFVBQU0sUUFBUSxLQUFLLDBCQUEwQixTQUFTLEVBQUU7QUFDeEQsVUFBTSxTQUFTLE1BQU0sS0FBSyxDQUFDLE1BQU0sRUFBRSxTQUFTLGFBQWMsRUFBdUIsR0FBRztBQUNwRixRQUFJLFFBQVEsT0FBTyxPQUFPLFFBQVEsVUFBVTtBQUMxQyxlQUFTLEtBQUs7QUFBQSxRQUNaLFVBQVU7QUFBQSxRQUNWLFVBQVUsU0FBUztBQUFBLFFBQ25CLFNBQVMsR0FBRyxTQUFTLEtBQUssU0FBUyxTQUFTLE1BQU07QUFBQSxNQUNwRCxDQUFDO0FBQUEsSUFDSDtBQUFBLEVBQ0Y7QUFHQSxhQUFXLFlBQVksbUJBQW1CO0FBQ3hDLFFBQUksS0FBSywyQkFBMkIsU0FBUyxFQUFFLEdBQUc7QUFDaEQsWUFBTSxZQUFZLEtBQUssNEJBQTRCLFNBQVMsRUFBRTtBQUM5RCxlQUFTLEtBQUs7QUFBQSxRQUNaLFVBQVU7QUFBQSxRQUNWLFVBQVUsU0FBUztBQUFBLFFBQ25CLFNBQVMsR0FBRyxTQUFTLEtBQUssd0JBQXdCLFlBQVksSUFBSSxLQUFLLGVBQWUsU0FBUyxDQUFDLGdCQUFnQixFQUFFO0FBQUEsTUFDcEgsQ0FBQztBQUFBLElBQ0g7QUFBQSxFQUNGO0FBR0EsUUFBTSxlQUFlLGtCQUFrQixPQUFPLENBQUMsTUFBTSxFQUFFLGFBQWEsS0FBSztBQUN6RSxRQUFNLFlBQVksYUFBYSxLQUFLLENBQUMsTUFBTTtBQUN6QyxVQUFNLFFBQVEsS0FBSywwQkFBMEIsRUFBRSxFQUFFO0FBQ2pELFVBQU0sY0FBYyxNQUFNLEtBQUssQ0FBQyxNQUFNLEVBQUUsU0FBUyxZQUFZLENBQUMsQ0FBRSxFQUF1QixNQUFNLElBQUk7QUFDakcsVUFBTSxTQUFTLEVBQUUsU0FBUyxDQUFDLENBQUMsUUFBUSxJQUFJLEVBQUUsTUFBTSxJQUFJO0FBQ3BELFdBQU8sZUFBZTtBQUFBLEVBQ3hCLENBQUM7QUFDRCxNQUFJLENBQUMsV0FBVztBQUNkLGFBQVMsS0FBSztBQUFBLE1BQ1osVUFBVTtBQUFBLE1BQ1YsU0FBUztBQUFBLElBQ1gsQ0FBQztBQUFBLEVBQ0g7QUFHQSxRQUFNLGlCQUFpQixvQkFBSSxJQUFzQjtBQUNqRCxhQUFXLFlBQVksbUJBQW1CO0FBQ3hDLFVBQU0sUUFBUSxLQUFLLDBCQUEwQixTQUFTLEVBQUU7QUFDeEQsZUFBVyxRQUFRLE9BQU87QUFDeEIsVUFBSSxLQUFLLFNBQVMsYUFBYyxLQUEwQixLQUFLO0FBQzdELGNBQU0sTUFBTyxLQUEwQjtBQUN2QyxjQUFNLFdBQVcsZUFBZSxJQUFJLEdBQUcsS0FBSyxDQUFDO0FBQzdDLGlCQUFTLEtBQUssU0FBUyxFQUFFO0FBQ3pCLHVCQUFlLElBQUksS0FBSyxRQUFRO0FBQUEsTUFDbEM7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUNBLGFBQVcsQ0FBQyxFQUFFLFNBQVMsS0FBSyxnQkFBZ0I7QUFDMUMsUUFBSSxVQUFVLFNBQVMsR0FBRztBQUN4QixlQUFTLEtBQUs7QUFBQSxRQUNaLFVBQVU7QUFBQSxRQUNWLFNBQVMsd0NBQXdDLFVBQVUsS0FBSyxJQUFJLENBQUM7QUFBQSxNQUN2RSxDQUFDO0FBQUEsSUFDSDtBQUFBLEVBQ0Y7QUFFQSxTQUFPO0FBQ1Q7QUFLTyxTQUFTLHFCQUFxQixVQUFtQztBQUN0RSxNQUFJLFNBQVMsV0FBVyxHQUFHO0FBQ3pCLFdBQU87QUFBQSxFQUNUO0FBRUEsUUFBTSxRQUFrQixDQUFDLHdCQUF3QjtBQUVqRCxhQUFXLEtBQUssVUFBVTtBQUN4QixVQUFNLE9BQ0osRUFBRSxhQUFhLFVBQVUsV0FDekIsRUFBRSxhQUFhLFlBQVksV0FDM0IsRUFBRSxhQUFhLFVBQVUsV0FDekI7QUFDRixVQUFNLEtBQUssS0FBSyxJQUFJLElBQUksRUFBRSxPQUFPLEVBQUU7QUFBQSxFQUNyQztBQUVBLFFBQU0sS0FBSyxFQUFFO0FBQ2IsUUFBTSxTQUFTLFNBQVMsT0FBTyxDQUFDLE1BQU0sRUFBRSxhQUFhLE9BQU8sRUFBRTtBQUM5RCxRQUFNLFdBQVcsU0FBUyxPQUFPLENBQUMsTUFBTSxFQUFFLGFBQWEsU0FBUyxFQUFFO0FBQ2xFLFFBQU0sUUFBUSxTQUFTLE9BQU8sQ0FBQyxNQUFNLEVBQUUsYUFBYSxPQUFPLEVBQUU7QUFDN0QsUUFBTSxPQUFPLFNBQVMsT0FBTyxDQUFDLE1BQU0sRUFBRSxhQUFhLE1BQU0sRUFBRTtBQUUzRCxRQUFNLFFBQWtCLENBQUM7QUFDekIsTUFBSSxTQUFTLEVBQUcsT0FBTSxLQUFLLEdBQUcsTUFBTSxTQUFTLFNBQVMsSUFBSSxNQUFNLEVBQUUsRUFBRTtBQUNwRSxNQUFJLFdBQVcsRUFBRyxPQUFNLEtBQUssR0FBRyxRQUFRLFdBQVcsV0FBVyxJQUFJLE1BQU0sRUFBRSxFQUFFO0FBQzVFLE1BQUksUUFBUSxFQUFHLE9BQU0sS0FBSyxHQUFHLEtBQUssUUFBUTtBQUMxQyxNQUFJLE9BQU8sRUFBRyxPQUFNLEtBQUssR0FBRyxJQUFJLE9BQU87QUFDdkMsUUFBTSxLQUFLLEtBQUssTUFBTSxLQUFLLEtBQUssQ0FBQyxFQUFFO0FBRW5DLFNBQU8sTUFBTSxLQUFLLElBQUk7QUFDeEI7QUFPQSxlQUFzQixXQUNwQixNQUNBLEtBQ2U7QUFDZixRQUFNLE9BQU8seUJBQXlCO0FBQ3RDLFFBQU0sUUFBUSxLQUFLLEtBQUssRUFBRSxNQUFNLEtBQUs7QUFDckMsUUFBTSxhQUFhLE1BQU0sQ0FBQyxLQUFLO0FBQy9CLFFBQU0sVUFBVSxNQUFNLE1BQU0sQ0FBQyxFQUFFLEtBQUssR0FBRyxFQUFFLEtBQUs7QUFFOUMsVUFBUSxZQUFZO0FBQUEsSUFDbEIsS0FBSztBQUFBLElBQ0wsS0FBSztBQUFBLElBQ0wsS0FBSyxVQUFVO0FBQ2IsWUFBTSxXQUFXLGtCQUFrQixJQUFJO0FBQ3ZDLFVBQUksR0FBRyxPQUFPLG1CQUFtQixRQUFRLEdBQUcsTUFBTTtBQUNsRDtBQUFBLElBQ0Y7QUFBQSxJQUVBLEtBQUssT0FBTztBQUNWLFlBQU0sVUFBVSxNQUFNLGFBQWEsU0FBUyxLQUFLLElBQUk7QUFDckQsVUFBSSxTQUFTO0FBQ1gsY0FBTSxJQUFJLFlBQVk7QUFDdEIsY0FBTSxJQUFJLE9BQU87QUFBQSxNQUNuQjtBQUNBO0FBQUEsSUFDRjtBQUFBLElBRUEsS0FBSztBQUFBLElBQ0wsS0FBSztBQUFBLElBQ0wsS0FBSyxVQUFVO0FBQ2IsWUFBTSxVQUFVLE1BQU0sZ0JBQWdCLFNBQVMsS0FBSyxJQUFJO0FBQ3hELFVBQUksU0FBUztBQUNYLGNBQU0sSUFBSSxZQUFZO0FBQ3RCLGNBQU0sSUFBSSxPQUFPO0FBQUEsTUFDbkI7QUFDQTtBQUFBLElBQ0Y7QUFBQSxJQUVBLEtBQUs7QUFBQSxJQUNMLEtBQUssWUFBWTtBQUNmLFVBQUk7QUFDSixVQUFJLFNBQVM7QUFDWCxjQUFNLElBQUksYUFBYSxPQUFPO0FBQzlCLFlBQUksQ0FBQyxHQUFHO0FBQ04sY0FBSSxHQUFHLE9BQU8sc0JBQXNCLE9BQU8sTUFBTSxPQUFPO0FBQ3hEO0FBQUEsUUFDRjtBQUNBLG9CQUFZLENBQUMsQ0FBQztBQUFBLE1BQ2hCLE9BQU87QUFFTCxjQUFNLFdBQVcsa0JBQWtCLElBQUk7QUFDdkMsb0JBQVksU0FDVCxPQUFPLENBQUMsTUFBTSxFQUFFLFVBQVUsRUFDMUIsSUFBSSxDQUFDLE1BQU0sRUFBRSxRQUFRO0FBQUEsTUFDMUI7QUFFQSxVQUFJLFVBQVUsV0FBVyxHQUFHO0FBQzFCLFlBQUksR0FBRyxPQUFPLCtCQUErQixNQUFNO0FBQ25EO0FBQUEsTUFDRjtBQUVBLFVBQUksR0FBRyxPQUFPLFdBQVcsVUFBVSxNQUFNLE9BQU8sVUFBVSxTQUFTLElBQUksTUFBTSxFQUFFLE9BQU8sTUFBTTtBQUU1RixZQUFNLFVBQXdCLENBQUM7QUFDL0IsaUJBQVcsS0FBSyxXQUFXO0FBQ3pCLGNBQU0sU0FBUyxNQUFNLGdCQUFnQixHQUFHLElBQUk7QUFDNUMsZ0JBQVEsS0FBSyxNQUFNO0FBQUEsTUFDckI7QUFFQSxVQUFJLEdBQUcsT0FBTyxrQkFBa0IsT0FBTyxHQUFHLE1BQU07QUFDaEQ7QUFBQSxJQUNGO0FBQUEsSUFFQSxLQUFLLFVBQVU7QUFDYixZQUFNLFVBQVUsTUFBTSxnQkFBZ0IsU0FBUyxLQUFLLElBQUk7QUFDeEQsVUFBSSxTQUFTO0FBQ1gsY0FBTSxJQUFJLFlBQVk7QUFDdEIsY0FBTSxJQUFJLE9BQU87QUFBQSxNQUNuQjtBQUNBO0FBQUEsSUFDRjtBQUFBLElBRUEsS0FBSztBQUFBLElBQ0wsS0FBSyxVQUFVO0FBQ2IsWUFBTSxXQUFXLGFBQWEsSUFBSTtBQUNsQyxVQUFJLEdBQUcsT0FBTyxxQkFBcUIsUUFBUSxHQUFHLE1BQU07QUFDcEQ7QUFBQSxJQUNGO0FBQUEsSUFFQTtBQUNFLFVBQUksR0FBRztBQUFBLFFBQ0w7QUFBQSxRQVFBO0FBQUEsTUFDRjtBQUNBO0FBQUEsRUFDSjtBQUNGOyIsCiAgIm5hbWVzIjogWyJjcmVkcyJdCn0K
