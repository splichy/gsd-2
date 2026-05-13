import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { AuthStorage } from "@gsd/pi-coding-agent";
import { getEnvApiKey } from "@gsd/pi-ai";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { getAuthPath, PROVIDER_REGISTRY } from "./key-manager.js";
import { homedir } from "node:os";
const CLI_AUTH_PROVIDERS = /* @__PURE__ */ new Set([
  "claude-code",
  "openai-codex",
  "google-gemini-cli",
  "google-antigravity"
]);
const PROVIDER_ROUTES = {
  anthropic: ["github-copilot", "claude-code"],
  openai: ["github-copilot", "openai-codex"],
  google: ["google-gemini-cli"]
};
function modelToProviderId(model) {
  if (!model) return null;
  if (model.includes("/")) {
    const rawPrefix = model.split("/")[0];
    const prefix = rawPrefix.toLowerCase();
    const prefixMap = {
      "anthropic-vertex": "anthropic-vertex",
      openrouter: "openrouter",
      groq: "groq",
      mistral: "mistral",
      google: "google",
      "google-vertex": "google-vertex",
      anthropic: "anthropic",
      openai: "openai",
      "github-copilot": "github-copilot"
    };
    if (prefixMap[prefix]) return prefixMap[prefix];
    return rawPrefix;
  }
  const lower = model.toLowerCase();
  if (lower.startsWith("claude")) return "anthropic";
  if (lower.startsWith("gpt-") || lower.startsWith("o1") || lower.startsWith("o3")) return "openai";
  if (lower.startsWith("gemini")) return "google";
  if (lower.startsWith("llama") || lower.startsWith("mixtral")) return "groq";
  if (lower.startsWith("grok")) return "xai";
  if (lower.startsWith("mistral") || lower.startsWith("codestral")) return "mistral";
  return null;
}
function collectConfiguredModelProviders() {
  const providers = /* @__PURE__ */ new Set();
  try {
    const loaded = loadEffectiveGSDPreferences();
    const models = loaded?.preferences?.models;
    if (!models) {
      providers.add("anthropic");
      return providers;
    }
    const modelEntries = typeof models === "object" ? Object.values(models) : [];
    for (const entry of modelEntries) {
      if (typeof entry === "string") {
        const pid = modelToProviderId(entry);
        if (pid) providers.add(pid);
        continue;
      }
      if (typeof entry === "object" && entry !== null && "model" in entry) {
        const configuredProvider = "provider" in entry ? entry.provider : void 0;
        if (typeof configuredProvider === "string" && configuredProvider.trim().length > 0) {
          providers.add(configuredProvider);
          continue;
        }
        const modelId = String(entry.model);
        const pid = modelToProviderId(modelId);
        if (pid) providers.add(pid);
      }
    }
  } catch {
    providers.add("anthropic");
  }
  if (providers.size === 0) providers.add("anthropic");
  return providers;
}
const CLI_BINARY_MAP = {
  "claude-code": "claude",
  "openai-codex": "codex",
  "google-gemini-cli": "gemini",
  "google-antigravity": "antigravity"
};
function isCliBinaryInPath(providerId) {
  const binary = CLI_BINARY_MAP[providerId];
  if (!binary) return false;
  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const executableNames = [binary];
  if (process.platform === "win32") {
    const rawPathExt = process.env.PATHEXT?.split(";").map((ext) => ext.trim()).filter(Boolean) ?? [];
    const normalizedPathExt = rawPathExt.map(
      (ext) => ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`
    );
    const defaultExt = [".exe", ".cmd", ".bat", ".com"];
    for (const ext of [...normalizedPathExt, ...defaultExt]) {
      const candidate = `${binary}${ext}`;
      if (!executableNames.includes(candidate)) executableNames.push(candidate);
    }
  }
  return pathDirs.some((dir) => executableNames.some((name) => existsSync(join(dir, name))));
}
function modelsJsonPaths() {
  const home = homedir();
  return [
    join(home, ".gsd", "agent", "models.json"),
    // Keep parity with custom-provider discovery during auto bootstrap.
    join(home, ".pi", "agent", "models.json")
  ];
}
function hasModelsJsonApiKey(providerId) {
  for (const path of modelsJsonPaths()) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      const apiKey = parsed.providers?.[providerId]?.apiKey;
      if (typeof apiKey === "string" && apiKey.trim().length > 0) {
        return true;
      }
    } catch {
    }
  }
  return false;
}
function resolveKey(providerId) {
  const info = PROVIDER_REGISTRY.find((p) => p.id === providerId);
  if (providerId === "claude-code") {
    return { found: isCliBinaryInPath("claude-code"), source: "env", backedOff: false };
  }
  if (providerId === "anthropic-vertex" && process.env.ANTHROPIC_VERTEX_PROJECT_ID) {
    return { found: true, source: "env", backedOff: false };
  }
  const authPath = getAuthPath();
  if (existsSync(authPath)) {
    try {
      const auth = AuthStorage.create(authPath);
      const creds = auth.getCredentialsForProvider(providerId);
      if (creds.length > 0) {
        const hasRealKey = creds.some(
          (c) => c.type === "oauth" || c.type === "api_key" && c.key
        );
        if (hasRealKey) {
          return {
            found: true,
            source: "auth.json",
            backedOff: auth.areAllCredentialsBackedOff(providerId)
          };
        }
      }
    } catch {
    }
  }
  if (getEnvApiKey(providerId)) {
    return { found: true, source: "env", backedOff: false };
  }
  if (info?.envVar && process.env[info.envVar]) {
    return { found: true, source: "env", backedOff: false };
  }
  if (hasModelsJsonApiKey(providerId)) {
    return { found: true, source: "models.json", backedOff: false };
  }
  return { found: false, source: "none", backedOff: false };
}
function checkLlmProviders() {
  const required = collectConfiguredModelProviders();
  const results = [];
  for (const providerId of required) {
    if (CLI_AUTH_PROVIDERS.has(providerId)) {
      const info2 = PROVIDER_REGISTRY.find((p) => p.id === providerId);
      results.push({
        name: providerId,
        label: info2?.label ?? providerId,
        category: "llm",
        status: "ok",
        message: `${info2?.label ?? providerId} \u2014 CLI auth (no key needed)`,
        required: true
      });
      continue;
    }
    const info = PROVIDER_REGISTRY.find((p) => p.id === providerId);
    const label = providerId === "anthropic-vertex" ? "Anthropic Vertex" : info?.label ?? providerId;
    const lookup = resolveKey(providerId);
    if (!lookup.found) {
      const routes = PROVIDER_ROUTES[providerId];
      const routeProvider = routes?.find((routeId) => resolveKey(routeId).found);
      if (routeProvider) {
        const routeInfo = PROVIDER_REGISTRY.find((p) => p.id === routeProvider);
        const routeLabel = routeInfo?.label ?? routeProvider;
        results.push({
          name: providerId,
          label,
          category: "llm",
          status: "ok",
          message: `${label} \u2014 available via ${routeLabel}`,
          required: true
        });
        continue;
      }
      const envVar = providerId === "anthropic-vertex" ? "ANTHROPIC_VERTEX_PROJECT_ID" : info?.envVar ?? `${providerId.toUpperCase()}_API_KEY`;
      results.push({
        name: providerId,
        label,
        category: "llm",
        status: "error",
        message: `${label} \u2014 not configured`,
        detail: providerId === "anthropic-vertex" ? "Set ANTHROPIC_VERTEX_PROJECT_ID and authenticate with Google ADC" : info?.hasOAuth ? `Run /gsd keys to authenticate` : `Set ${envVar} or run /gsd keys`,
        required: true
      });
    } else if (lookup.backedOff) {
      results.push({
        name: providerId,
        label,
        category: "llm",
        status: "warning",
        message: `${label} \u2014 all credentials backed off (rate limited)`,
        detail: `GSD will retry automatically`,
        required: true
      });
    } else {
      results.push({
        name: providerId,
        label,
        category: "llm",
        status: "ok",
        message: `${label} \u2014 key present (${lookup.source})`,
        required: true
      });
    }
  }
  return results;
}
function checkRemoteQuestionsProvider() {
  try {
    const loaded = loadEffectiveGSDPreferences();
    const rq = loaded?.preferences?.remote_questions;
    if (!rq) return null;
    const channel = rq.channel;
    if (!channel) return null;
    const providerMap = {
      slack: "slack_bot",
      discord: "discord_bot",
      telegram: "telegram_bot"
    };
    const providerId = providerMap[channel.toLowerCase()];
    if (!providerId) return null;
    const info = PROVIDER_REGISTRY.find((p) => p.id === providerId);
    const label = info?.label ?? channel;
    const lookup = resolveKey(providerId);
    if (!lookup.found) {
      return {
        name: providerId,
        label,
        category: "remote",
        status: "warning",
        message: `${label} \u2014 channel configured but token not found`,
        detail: info?.envVar ? `Set ${info.envVar} or run /gsd keys` : `Run /gsd keys to configure`,
        required: true
      };
    }
    return {
      name: providerId,
      label,
      category: "remote",
      status: "ok",
      message: `${label} \u2014 token present (${lookup.source})`,
      required: true
    };
  } catch {
    return null;
  }
}
function checkOptionalProviders() {
  const optional = ["brave", "tavily", "jina", "context7"];
  const results = [];
  const searchProviderIds = ["brave", "tavily"];
  const hasAnySearchProvider = searchProviderIds.some((id) => resolveKey(id).found);
  for (const providerId of optional) {
    const info = PROVIDER_REGISTRY.find((p) => p.id === providerId);
    if (!info) continue;
    const lookup = resolveKey(providerId);
    if (!lookup.found && hasAnySearchProvider && info.category === "search") {
      continue;
    }
    results.push({
      name: providerId,
      label: info.label,
      category: info.category,
      status: lookup.found ? "ok" : "unconfigured",
      message: lookup.found ? `${info.label} \u2014 key present (${lookup.source})` : `${info.label} \u2014 not configured (optional)`,
      detail: !lookup.found && info.envVar ? `Set ${info.envVar} to enable` : void 0,
      required: false
    });
  }
  return results;
}
function runProviderChecks() {
  const results = [];
  results.push(...checkLlmProviders());
  const remoteCheck = checkRemoteQuestionsProvider();
  if (remoteCheck) results.push(remoteCheck);
  results.push(...checkOptionalProviders());
  return results;
}
function formatProviderReport(results) {
  if (results.length === 0) return "No provider checks run.";
  const lines = [];
  const groups = {};
  for (const r of results) {
    (groups[r.category] ??= []).push(r);
  }
  const categoryLabels = {
    llm: "LLM Providers",
    remote: "Notifications",
    search: "Search",
    tool: "Tools"
  };
  for (const [cat, items] of Object.entries(groups)) {
    lines.push(`${categoryLabels[cat] ?? cat}:`);
    for (const item of items) {
      const icon = item.status === "ok" ? "\u2713" : item.status === "warning" ? "\u26A0" : item.status === "error" ? "\u2717" : "\xB7";
      lines.push(`  ${icon} ${item.message}`);
      if (item.detail && item.status !== "ok") {
        lines.push(`    ${item.detail}`);
      }
    }
  }
  return lines.join("\n");
}
function summariseProviderIssues(results) {
  const errors = results.filter((r) => r.required && r.status === "error");
  const warnings = results.filter((r) => r.required && r.status === "warning");
  if (errors.length === 0 && warnings.length === 0) return null;
  const parts = [];
  if (errors.length > 0) parts.push(`\u2717 ${errors[0].label} key missing`);
  if (warnings.length > 0 && errors.length === 0) parts.push(`\u26A0 ${warnings[0].label} backed off`);
  if (errors.length + warnings.length > 1) parts.push(`(+${errors.length + warnings.length - 1} more)`);
  return parts.join(" ");
}
export {
  formatProviderReport,
  runProviderChecks,
  summariseProviderIssues
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9kb2N0b3ItcHJvdmlkZXJzLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIEdTRCBEb2N0b3IgXHUyMDE0IFByb3ZpZGVyICYgSW50ZWdyYXRpb24gSGVhbHRoIENoZWNrc1xuICpcbiAqIEZhc3QsIGRldGVybWluaXN0aWMgY2hlY2tzIGZvciBleHRlcm5hbCBzZXJ2aWNlIGNvbmZpZ3VyYXRpb24uXG4gKiBDaGVja3Mga2V5IHByZXNlbmNlIGluIGF1dGguanNvbiBhbmQgZW52aXJvbm1lbnQgdmFyaWFibGVzIFx1MjAxNCBubyBIVFRQIGNhbGxzLFxuICogbm8gbmV0d29yayBJL08sIGFsd2F5cyBzdWItMTBtcy5cbiAqXG4gKiBDb3ZlcnM6XG4gKiAgIC0gTExNIHByb3ZpZGVycyByZXF1aXJlZCBieSB0aGUgZWZmZWN0aXZlIG1vZGVsIHByZWZlcmVuY2VzIChwZXIgcGhhc2UpXG4gKiAgIC0gUmVtb3RlIHF1ZXN0aW9ucyBjaGFubmVsIGlmIGNvbmZpZ3VyZWQgKFNsYWNrL0Rpc2NvcmQvVGVsZWdyYW0gdG9rZW4pXG4gKiAgIC0gT3B0aW9uYWwgc2VhcmNoL3Rvb2wgaW50ZWdyYXRpb25zIChCcmF2ZSwgVGF2aWx5LCBKaW5hLCBDb250ZXh0NylcbiAqL1xuXG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgZGVsaW1pdGVyLCBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgQXV0aFN0b3JhZ2UgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7IGdldEVudkFwaUtleSB9IGZyb20gXCJAZ3NkL3BpLWFpXCI7XG5pbXBvcnQgeyBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMgfSBmcm9tIFwiLi9wcmVmZXJlbmNlcy5qc1wiO1xuaW1wb3J0IHsgZ2V0QXV0aFBhdGgsIFBST1ZJREVSX1JFR0lTVFJZLCB0eXBlIFByb3ZpZGVyQ2F0ZWdvcnkgfSBmcm9tIFwiLi9rZXktbWFuYWdlci5qc1wiO1xuaW1wb3J0IHsgaG9tZWRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5cbi8vIFx1MjUwMFx1MjUwMCBUeXBlcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IHR5cGUgUHJvdmlkZXJDaGVja1N0YXR1cyA9IFwib2tcIiB8IFwid2FybmluZ1wiIHwgXCJlcnJvclwiIHwgXCJ1bmNvbmZpZ3VyZWRcIjtcblxuZXhwb3J0IGludGVyZmFjZSBQcm92aWRlckNoZWNrUmVzdWx0IHtcbiAgLyoqIFByb3ZpZGVyIGlkIGZyb20gUFJPVklERVJfUkVHSVNUUlkgKGUuZy4gXCJhbnRocm9waWNcIiwgXCJzbGFja19ib3RcIikgKi9cbiAgbmFtZTogc3RyaW5nO1xuICAvKiogSHVtYW4tcmVhZGFibGUgbGFiZWwgKi9cbiAgbGFiZWw6IHN0cmluZztcbiAgLyoqIEZ1bmN0aW9uYWwgZ3JvdXBpbmcgKi9cbiAgY2F0ZWdvcnk6IFByb3ZpZGVyQ2F0ZWdvcnk7XG4gIHN0YXR1czogUHJvdmlkZXJDaGVja1N0YXR1cztcbiAgbWVzc2FnZTogc3RyaW5nO1xuICAvKiogT3B0aW9uYWwgZXh0cmEgZGV0YWlsIChlLmcuIHdoaWNoIGVudiB2YXIgdG8gc2V0KSAqL1xuICBkZXRhaWw/OiBzdHJpbmc7XG4gIC8qKiBUcnVlIGlmIHRoaXMgcHJvdmlkZXIgaXMgYWN0aXZlbHkgcmVxdWlyZWQgYnkgcHJlZmVyZW5jZXMgKi9cbiAgcmVxdWlyZWQ6IGJvb2xlYW47XG59XG5cbi8vIFx1MjUwMFx1MjUwMCBQcm92aWRlciByb3V0aW5nIGNvbnN0YW50cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBQcm92aWRlcnMgdGhhdCB1c2UgZXh0ZXJuYWwgQ0xJIGF1dGhlbnRpY2F0aW9uIChub3QgQVBJIGtleXMpLlxuICogVGhlc2UgYXJlIGFsd2F5cyBjb25zaWRlcmVkIFwiZm91bmRcIiBcdTIwMTQgdGhlIGhvc3QgQ0xJIGhhbmRsZXMgYXV0aC5cbiAqL1xuY29uc3QgQ0xJX0FVVEhfUFJPVklERVJTID0gbmV3IFNldChbXG4gIFwiY2xhdWRlLWNvZGVcIixcbiAgXCJvcGVuYWktY29kZXhcIixcbiAgXCJnb29nbGUtZ2VtaW5pLWNsaVwiLFxuICBcImdvb2dsZS1hbnRpZ3Jhdml0eVwiLFxuXSk7XG5cbi8qKlxuICogUHJvdmlkZXJzIHRoYXQgY2FuIHNlcnZlIG1vZGVscyBub3JtYWxseSBhc3NvY2lhdGVkIHdpdGggYW5vdGhlciBwcm92aWRlci5cbiAqIEtleSA9IHRoZSBwcm92aWRlciB3aG9zZSBtb2RlbHMgY2FuIGJlIHNlcnZlZCwgVmFsdWUgPSBhbHRlcm5hdGl2ZSBwcm92aWRlcnMgdG8gY2hlY2suXG4gKiBlLmcuIEdpdEh1YiBDb3BpbG90IHN1YnNjcmlwdGlvbnMgY2FuIGFjY2VzcyBDbGF1ZGUgYW5kIEdQVCBtb2RlbHMuXG4gKi9cbmNvbnN0IFBST1ZJREVSX1JPVVRFUzogUmVjb3JkPHN0cmluZywgc3RyaW5nW10+ID0ge1xuICBhbnRocm9waWM6IFtcImdpdGh1Yi1jb3BpbG90XCIsIFwiY2xhdWRlLWNvZGVcIl0sXG4gIG9wZW5haTogW1wiZ2l0aHViLWNvcGlsb3RcIiwgXCJvcGVuYWktY29kZXhcIl0sXG4gIGdvb2dsZTogW1wiZ29vZ2xlLWdlbWluaS1jbGlcIl0sXG59O1xuXG4vLyBcdTI1MDBcdTI1MDAgTW9kZWwgXHUyMTkyIFByb3ZpZGVyIElEIG1hcHBpbmcgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogSW5mZXIgdGhlIGF1dGggcHJvdmlkZXIgSUQgZnJvbSBhIG1vZGVsIHN0cmluZy5cbiAqIEhhbmRsZXMgcGxhaW4gbW9kZWwgSURzIChcImNsYXVkZS1zb25uZXQtNC02XCIpIGFuZCBwcmVmaXhlZCBvbmVzIChcIm9wZW5yb3V0ZXIvZGVlcHNlZWtcIikuXG4gKi9cbmZ1bmN0aW9uIG1vZGVsVG9Qcm92aWRlcklkKG1vZGVsOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgaWYgKCFtb2RlbCkgcmV0dXJuIG51bGw7XG5cbiAgLy8gRXhwbGljaXQgcHJvdmlkZXIgcHJlZml4IChlLmcuIFwib3BlbnJvdXRlci9kZWVwc2Vlay1yMVwiKVxuICBpZiAobW9kZWwuaW5jbHVkZXMoXCIvXCIpKSB7XG4gICAgY29uc3QgcmF3UHJlZml4ID0gbW9kZWwuc3BsaXQoXCIvXCIpWzBdO1xuICAgIGNvbnN0IHByZWZpeCA9IHJhd1ByZWZpeC50b0xvd2VyQ2FzZSgpO1xuICAgIC8vIE1hcCBrbm93biBwcmVmaXhlcyB0byByZWdpc3RyeSBJRHNcbiAgICBjb25zdCBwcmVmaXhNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gICAgICBcImFudGhyb3BpYy12ZXJ0ZXhcIjogXCJhbnRocm9waWMtdmVydGV4XCIsXG4gICAgICBvcGVucm91dGVyOiBcIm9wZW5yb3V0ZXJcIixcbiAgICAgIGdyb3E6IFwiZ3JvcVwiLFxuICAgICAgbWlzdHJhbDogXCJtaXN0cmFsXCIsXG4gICAgICBnb29nbGU6IFwiZ29vZ2xlXCIsXG4gICAgICBcImdvb2dsZS12ZXJ0ZXhcIjogXCJnb29nbGUtdmVydGV4XCIsXG4gICAgICBhbnRocm9waWM6IFwiYW50aHJvcGljXCIsXG4gICAgICBvcGVuYWk6IFwib3BlbmFpXCIsXG4gICAgICBcImdpdGh1Yi1jb3BpbG90XCI6IFwiZ2l0aHViLWNvcGlsb3RcIixcbiAgICB9O1xuICAgIGlmIChwcmVmaXhNYXBbcHJlZml4XSkgcmV0dXJuIHByZWZpeE1hcFtwcmVmaXhdO1xuICAgIHJldHVybiByYXdQcmVmaXg7XG4gIH1cblxuICBjb25zdCBsb3dlciA9IG1vZGVsLnRvTG93ZXJDYXNlKCk7XG4gIGlmIChsb3dlci5zdGFydHNXaXRoKFwiY2xhdWRlXCIpKSAgICAgICAgcmV0dXJuIFwiYW50aHJvcGljXCI7XG4gIGlmIChsb3dlci5zdGFydHNXaXRoKFwiZ3B0LVwiKSB8fCBsb3dlci5zdGFydHNXaXRoKFwibzFcIikgfHwgbG93ZXIuc3RhcnRzV2l0aChcIm8zXCIpKSByZXR1cm4gXCJvcGVuYWlcIjtcbiAgaWYgKGxvd2VyLnN0YXJ0c1dpdGgoXCJnZW1pbmlcIikpICAgICAgICByZXR1cm4gXCJnb29nbGVcIjtcbiAgaWYgKGxvd2VyLnN0YXJ0c1dpdGgoXCJsbGFtYVwiKSB8fCBsb3dlci5zdGFydHNXaXRoKFwibWl4dHJhbFwiKSkgcmV0dXJuIFwiZ3JvcVwiO1xuICBpZiAobG93ZXIuc3RhcnRzV2l0aChcImdyb2tcIikpICAgICAgICAgIHJldHVybiBcInhhaVwiO1xuICBpZiAobG93ZXIuc3RhcnRzV2l0aChcIm1pc3RyYWxcIikgfHwgbG93ZXIuc3RhcnRzV2l0aChcImNvZGVzdHJhbFwiKSkgcmV0dXJuIFwibWlzdHJhbFwiO1xuXG4gIHJldHVybiBudWxsO1xufVxuXG4vKiogQ29sbGVjdCBhbGwgbW9kZWwgc3RyaW5ncyBmcm9tIGVmZmVjdGl2ZSBwcmVmZXJlbmNlcyBhY3Jvc3MgYWxsIHBoYXNlcy4gKi9cbmZ1bmN0aW9uIGNvbGxlY3RDb25maWd1cmVkTW9kZWxQcm92aWRlcnMoKTogU2V0PHN0cmluZz4ge1xuICBjb25zdCBwcm92aWRlcnMgPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuICB0cnkge1xuICAgIGNvbnN0IGxvYWRlZCA9IGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcygpO1xuICAgIGNvbnN0IG1vZGVscyA9IGxvYWRlZD8ucHJlZmVyZW5jZXM/Lm1vZGVscztcbiAgICBpZiAoIW1vZGVscykge1xuICAgICAgLy8gRGVmYXVsdDogQW50aHJvcGljXG4gICAgICBwcm92aWRlcnMuYWRkKFwiYW50aHJvcGljXCIpO1xuICAgICAgcmV0dXJuIHByb3ZpZGVycztcbiAgICB9XG5cbiAgICBjb25zdCBtb2RlbEVudHJpZXMgPSB0eXBlb2YgbW9kZWxzID09PSBcIm9iamVjdFwiID8gT2JqZWN0LnZhbHVlcyhtb2RlbHMpIDogW107XG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiBtb2RlbEVudHJpZXMpIHtcbiAgICAgIGlmICh0eXBlb2YgZW50cnkgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgY29uc3QgcGlkID0gbW9kZWxUb1Byb3ZpZGVySWQoZW50cnkpO1xuICAgICAgICBpZiAocGlkKSBwcm92aWRlcnMuYWRkKHBpZCk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICBpZiAodHlwZW9mIGVudHJ5ID09PSBcIm9iamVjdFwiICYmIGVudHJ5ICE9PSBudWxsICYmIFwibW9kZWxcIiBpbiBlbnRyeSkge1xuICAgICAgICBjb25zdCBjb25maWd1cmVkUHJvdmlkZXIgPSBcInByb3ZpZGVyXCIgaW4gZW50cnkgPyAoZW50cnkgYXMgeyBwcm92aWRlcj86IHVua25vd24gfSkucHJvdmlkZXIgOiB1bmRlZmluZWQ7XG4gICAgICAgIGlmICh0eXBlb2YgY29uZmlndXJlZFByb3ZpZGVyID09PSBcInN0cmluZ1wiICYmIGNvbmZpZ3VyZWRQcm92aWRlci50cmltKCkubGVuZ3RoID4gMCkge1xuICAgICAgICAgIHByb3ZpZGVycy5hZGQoY29uZmlndXJlZFByb3ZpZGVyKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IG1vZGVsSWQgPSBTdHJpbmcoKGVudHJ5IGFzIHsgbW9kZWw6IHVua25vd24gfSkubW9kZWwpO1xuICAgICAgICBjb25zdCBwaWQgPSBtb2RlbFRvUHJvdmlkZXJJZChtb2RlbElkKTtcbiAgICAgICAgaWYgKHBpZCkgcHJvdmlkZXJzLmFkZChwaWQpO1xuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gUHJlZmVyZW5jZXMgbm90IHJlYWRhYmxlIFx1MjAxNCBhc3N1bWUgQW50aHJvcGljIGFzIGRlZmF1bHRcbiAgICBwcm92aWRlcnMuYWRkKFwiYW50aHJvcGljXCIpO1xuICB9XG5cbiAgaWYgKHByb3ZpZGVycy5zaXplID09PSAwKSBwcm92aWRlcnMuYWRkKFwiYW50aHJvcGljXCIpO1xuICByZXR1cm4gcHJvdmlkZXJzO1xufVxuXG4vLyBcdTI1MDBcdTI1MDAgS2V5IHJlc29sdXRpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmludGVyZmFjZSBLZXlMb29rdXAge1xuICBmb3VuZDogYm9vbGVhbjtcbiAgc291cmNlOiBcImF1dGguanNvblwiIHwgXCJlbnZcIiB8IFwibW9kZWxzLmpzb25cIiB8IFwibm9uZVwiO1xuICBiYWNrZWRPZmY6IGJvb2xlYW47XG59XG5cbi8qKlxuICogTWFwIG9mIENMSSBwcm92aWRlciBJRHMgdG8gdGhlaXIgYmluYXJ5IG5hbWVzIG9uIGRpc2suXG4gKiBVc2VkIGZvciBsaWdodHdlaWdodCBiaW5hcnktcHJlc2VuY2UgY2hlY2tzIChQQVRIIHNjYW4sIG5vIHN1YnByb2Nlc3MpLlxuICovXG5jb25zdCBDTElfQklOQVJZX01BUDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgXCJjbGF1ZGUtY29kZVwiOiBcImNsYXVkZVwiLFxuICBcIm9wZW5haS1jb2RleFwiOiBcImNvZGV4XCIsXG4gIFwiZ29vZ2xlLWdlbWluaS1jbGlcIjogXCJnZW1pbmlcIixcbiAgXCJnb29nbGUtYW50aWdyYXZpdHlcIjogXCJhbnRpZ3Jhdml0eVwiLFxufTtcblxuLyoqXG4gKiBDaGVjayBpZiBhIENMSSBwcm92aWRlcidzIGJpbmFyeSBleGlzdHMgYW55d2hlcmUgaW4gUEFUSC5cbiAqIEZhc3QgZmlsZXN5c3RlbSBzY2FuIFx1MjAxNCBubyBzdWJwcm9jZXNzLCBubyBuZXR3b3JrLCBzdWItMW1zLlxuICovXG5mdW5jdGlvbiBpc0NsaUJpbmFyeUluUGF0aChwcm92aWRlcklkOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgYmluYXJ5ID0gQ0xJX0JJTkFSWV9NQVBbcHJvdmlkZXJJZF07XG4gIGlmICghYmluYXJ5KSByZXR1cm4gZmFsc2U7XG5cbiAgY29uc3QgcGF0aERpcnMgPSAocHJvY2Vzcy5lbnYuUEFUSCA/PyBcIlwiKS5zcGxpdChkZWxpbWl0ZXIpLmZpbHRlcihCb29sZWFuKTtcblxuICAvLyBPbiBXaW5kb3dzLCBjb21tYW5kIHNoaW1zIGFyZSBjb21tb25seSBpbnN0YWxsZWQgYXMgLmNtZC8uZXhlLy5iYXQvLmNvbS5cbiAgLy8gU2NhbiBQQVRIRVhUIGNhbmRpZGF0ZXMgaW4gYWRkaXRpb24gdG8gdGhlIGJhcmUgYmluYXJ5IG5hbWUuXG4gIGNvbnN0IGV4ZWN1dGFibGVOYW1lczogc3RyaW5nW10gPSBbYmluYXJ5XTtcbiAgaWYgKHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIikge1xuICAgIGNvbnN0IHJhd1BhdGhFeHQgPSBwcm9jZXNzLmVudi5QQVRIRVhUXG4gICAgICA/LnNwbGl0KFwiO1wiKVxuICAgICAgLm1hcChleHQgPT4gZXh0LnRyaW0oKSlcbiAgICAgIC5maWx0ZXIoQm9vbGVhbikgPz8gW107XG4gICAgY29uc3Qgbm9ybWFsaXplZFBhdGhFeHQgPSByYXdQYXRoRXh0Lm1hcChleHQgPT5cbiAgICAgIGV4dC5zdGFydHNXaXRoKFwiLlwiKSA/IGV4dC50b0xvd2VyQ2FzZSgpIDogYC4ke2V4dC50b0xvd2VyQ2FzZSgpfWAsXG4gICAgKTtcbiAgICBjb25zdCBkZWZhdWx0RXh0ID0gW1wiLmV4ZVwiLCBcIi5jbWRcIiwgXCIuYmF0XCIsIFwiLmNvbVwiXTtcbiAgICBmb3IgKGNvbnN0IGV4dCBvZiBbLi4ubm9ybWFsaXplZFBhdGhFeHQsIC4uLmRlZmF1bHRFeHRdKSB7XG4gICAgICBjb25zdCBjYW5kaWRhdGUgPSBgJHtiaW5hcnl9JHtleHR9YDtcbiAgICAgIGlmICghZXhlY3V0YWJsZU5hbWVzLmluY2x1ZGVzKGNhbmRpZGF0ZSkpIGV4ZWN1dGFibGVOYW1lcy5wdXNoKGNhbmRpZGF0ZSk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHBhdGhEaXJzLnNvbWUoZGlyID0+IGV4ZWN1dGFibGVOYW1lcy5zb21lKG5hbWUgPT4gZXhpc3RzU3luYyhqb2luKGRpciwgbmFtZSkpKSk7XG59XG5cbmZ1bmN0aW9uIG1vZGVsc0pzb25QYXRocygpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGhvbWUgPSBob21lZGlyKCk7XG4gIHJldHVybiBbXG4gICAgam9pbihob21lLCBcIi5nc2RcIiwgXCJhZ2VudFwiLCBcIm1vZGVscy5qc29uXCIpLFxuICAgIC8vIEtlZXAgcGFyaXR5IHdpdGggY3VzdG9tLXByb3ZpZGVyIGRpc2NvdmVyeSBkdXJpbmcgYXV0byBib290c3RyYXAuXG4gICAgam9pbihob21lLCBcIi5waVwiLCBcImFnZW50XCIsIFwibW9kZWxzLmpzb25cIiksXG4gIF07XG59XG5cbmZ1bmN0aW9uIGhhc01vZGVsc0pzb25BcGlLZXkocHJvdmlkZXJJZDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGZvciAoY29uc3QgcGF0aCBvZiBtb2RlbHNKc29uUGF0aHMoKSkge1xuICAgIGlmICghZXhpc3RzU3luYyhwYXRoKSkgY29udGludWU7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmLThcIikpIGFzIHtcbiAgICAgICAgcHJvdmlkZXJzPzogUmVjb3JkPHN0cmluZywgeyBhcGlLZXk/OiB1bmtub3duIH0+O1xuICAgICAgfTtcbiAgICAgIGNvbnN0IGFwaUtleSA9IHBhcnNlZC5wcm92aWRlcnM/Lltwcm92aWRlcklkXT8uYXBpS2V5O1xuICAgICAgaWYgKHR5cGVvZiBhcGlLZXkgPT09IFwic3RyaW5nXCIgJiYgYXBpS2V5LnRyaW0oKS5sZW5ndGggPiAwKSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gTWFsZm9ybWVkIG1vZGVscy5qc29uIHNob3VsZCBub3QgYnJlYWsgdGhlIGRhc2hib2FyZCBoZWFsdGggY2hlY2suXG4gICAgfVxuICB9XG4gIHJldHVybiBmYWxzZTtcbn1cblxuZnVuY3Rpb24gcmVzb2x2ZUtleShwcm92aWRlcklkOiBzdHJpbmcpOiBLZXlMb29rdXAge1xuICBjb25zdCBpbmZvID0gUFJPVklERVJfUkVHSVNUUlkuZmluZChwID0+IHAuaWQgPT09IHByb3ZpZGVySWQpO1xuXG4gIC8vIGNsYXVkZS1jb2RlIG5ldmVyIHN0b3JlcyBjcmVkZW50aWFscyBpbiBhdXRoLmpzb24gXHUyMDE0IEdTRCBkZWxlZ2F0ZXMgZW50aXJlbHkgdG9cbiAgLy8gdGhlIGxvY2FsIENMSSBiaW5hcnkuIFByZXNlbmNlIG9mIHRoZSBiaW5hcnkgaW4gUEFUSCBpcyB0aGUgb25seSBzaWduYWwuXG4gIGlmIChwcm92aWRlcklkID09PSBcImNsYXVkZS1jb2RlXCIpIHtcbiAgICByZXR1cm4geyBmb3VuZDogaXNDbGlCaW5hcnlJblBhdGgoXCJjbGF1ZGUtY29kZVwiKSwgc291cmNlOiBcImVudlwiLCBiYWNrZWRPZmY6IGZhbHNlIH07XG4gIH1cblxuICBpZiAocHJvdmlkZXJJZCA9PT0gXCJhbnRocm9waWMtdmVydGV4XCIgJiYgcHJvY2Vzcy5lbnYuQU5USFJPUElDX1ZFUlRFWF9QUk9KRUNUX0lEKSB7XG4gICAgcmV0dXJuIHsgZm91bmQ6IHRydWUsIHNvdXJjZTogXCJlbnZcIiwgYmFja2VkT2ZmOiBmYWxzZSB9O1xuICB9XG5cbiAgLy8gQ2hlY2sgYXV0aC5qc29uXG4gIGNvbnN0IGF1dGhQYXRoID0gZ2V0QXV0aFBhdGgoKTtcbiAgaWYgKGV4aXN0c1N5bmMoYXV0aFBhdGgpKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGF1dGggPSBBdXRoU3RvcmFnZS5jcmVhdGUoYXV0aFBhdGgpO1xuICAgICAgY29uc3QgY3JlZHMgPSBhdXRoLmdldENyZWRlbnRpYWxzRm9yUHJvdmlkZXIocHJvdmlkZXJJZCk7XG4gICAgICBpZiAoY3JlZHMubGVuZ3RoID4gMCkge1xuICAgICAgICAvLyBGaWx0ZXIgb3V0IGVtcHR5IHBsYWNlaG9sZGVyIGtleXMgKGZyb20gc2tpcHBlZCBvbmJvYXJkaW5nKVxuICAgICAgICBjb25zdCBoYXNSZWFsS2V5ID0gY3JlZHMuc29tZShjID0+XG4gICAgICAgICAgYy50eXBlID09PSBcIm9hdXRoXCIgfHwgKGMudHlwZSA9PT0gXCJhcGlfa2V5XCIgJiYgKGMgYXMgeyBrZXk/OiBzdHJpbmcgfSkua2V5KVxuICAgICAgICApO1xuICAgICAgICBpZiAoaGFzUmVhbEtleSkge1xuICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBmb3VuZDogdHJ1ZSxcbiAgICAgICAgICAgIHNvdXJjZTogXCJhdXRoLmpzb25cIixcbiAgICAgICAgICAgIGJhY2tlZE9mZjogYXV0aC5hcmVBbGxDcmVkZW50aWFsc0JhY2tlZE9mZihwcm92aWRlcklkKSxcbiAgICAgICAgICB9O1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBhdXRoLmpzb24gbWFsZm9ybWVkIFx1MjAxNCBmYWxsIHRocm91Z2ggdG8gZW52IGNoZWNrXG4gICAgfVxuICB9XG5cbiAgLy8gQ2hlY2sgZW52aXJvbm1lbnQgdmFyaWFibGUgdXNpbmcgdGhlIGF1dGhvcml0YXRpdmUgZW52IHZhciByZXNvbHV0aW9uXG4gIC8vIChoYW5kbGVzIG11bHRpLXZhciBsb29rdXBzIGxpa2UgQU5USFJPUElDX09BVVRIX1RPS0VOIHx8IEFOVEhST1BJQ19BUElfS0VZLFxuICAvLyAgQ09QSUxPVF9HSVRIVUJfVE9LRU4gfHwgR0hfVE9LRU4gfHwgR0lUSFVCX1RPS0VOLCBWZXJ0ZXggQURDLCBCZWRyb2NrLCBldGMuKVxuICBpZiAoZ2V0RW52QXBpS2V5KHByb3ZpZGVySWQpKSB7XG4gICAgcmV0dXJuIHsgZm91bmQ6IHRydWUsIHNvdXJjZTogXCJlbnZcIiwgYmFja2VkT2ZmOiBmYWxzZSB9O1xuICB9XG5cbiAgLy8gRmFsbCBiYWNrIHRvIFBST1ZJREVSX1JFR0lTVFJZIGVudiB2YXIgZm9yIHByb3ZpZGVycyBub3QgY292ZXJlZCBieSBnZXRFbnZBcGlLZXlcbiAgLy8gKGUuZy4sIHNlYXJjaCBwcm92aWRlcnMgbGlrZSBCcmF2ZSwgVGF2aWx5OyB0b29sIHByb3ZpZGVycyBsaWtlIEppbmEsIENvbnRleHQ3KVxuICBpZiAoaW5mbz8uZW52VmFyICYmIHByb2Nlc3MuZW52W2luZm8uZW52VmFyXSkge1xuICAgIHJldHVybiB7IGZvdW5kOiB0cnVlLCBzb3VyY2U6IFwiZW52XCIsIGJhY2tlZE9mZjogZmFsc2UgfTtcbiAgfVxuXG4gIGlmIChoYXNNb2RlbHNKc29uQXBpS2V5KHByb3ZpZGVySWQpKSB7XG4gICAgcmV0dXJuIHsgZm91bmQ6IHRydWUsIHNvdXJjZTogXCJtb2RlbHMuanNvblwiLCBiYWNrZWRPZmY6IGZhbHNlIH07XG4gIH1cblxuICByZXR1cm4geyBmb3VuZDogZmFsc2UsIHNvdXJjZTogXCJub25lXCIsIGJhY2tlZE9mZjogZmFsc2UgfTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwIEluZGl2aWR1YWwgY2hlY2sgZ3JvdXBzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBjaGVja0xsbVByb3ZpZGVycygpOiBQcm92aWRlckNoZWNrUmVzdWx0W10ge1xuICBjb25zdCByZXF1aXJlZCA9IGNvbGxlY3RDb25maWd1cmVkTW9kZWxQcm92aWRlcnMoKTtcbiAgY29uc3QgcmVzdWx0czogUHJvdmlkZXJDaGVja1Jlc3VsdFtdID0gW107XG5cbiAgZm9yIChjb25zdCBwcm92aWRlcklkIG9mIHJlcXVpcmVkKSB7XG4gICAgLy8gQ0xJLWF1dGhlbnRpY2F0ZWQgcHJvdmlkZXJzIGRvbid0IG5lZWQgQVBJIGtleXMgXHUyMDE0IHNraXAga2V5IGNoZWNrXG4gICAgaWYgKENMSV9BVVRIX1BST1ZJREVSUy5oYXMocHJvdmlkZXJJZCkpIHtcbiAgICAgIGNvbnN0IGluZm8gPSBQUk9WSURFUl9SRUdJU1RSWS5maW5kKHAgPT4gcC5pZCA9PT0gcHJvdmlkZXJJZCk7XG4gICAgICByZXN1bHRzLnB1c2goe1xuICAgICAgICBuYW1lOiBwcm92aWRlcklkLFxuICAgICAgICBsYWJlbDogaW5mbz8ubGFiZWwgPz8gcHJvdmlkZXJJZCxcbiAgICAgICAgY2F0ZWdvcnk6IFwibGxtXCIsXG4gICAgICAgIHN0YXR1czogXCJva1wiLFxuICAgICAgICBtZXNzYWdlOiBgJHtpbmZvPy5sYWJlbCA/PyBwcm92aWRlcklkfSBcdTIwMTQgQ0xJIGF1dGggKG5vIGtleSBuZWVkZWQpYCxcbiAgICAgICAgcmVxdWlyZWQ6IHRydWUsXG4gICAgICB9KTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBpbmZvID0gUFJPVklERVJfUkVHSVNUUlkuZmluZChwID0+IHAuaWQgPT09IHByb3ZpZGVySWQpO1xuICAgIGNvbnN0IGxhYmVsID0gcHJvdmlkZXJJZCA9PT0gXCJhbnRocm9waWMtdmVydGV4XCJcbiAgICAgID8gXCJBbnRocm9waWMgVmVydGV4XCJcbiAgICAgIDogaW5mbz8ubGFiZWwgPz8gcHJvdmlkZXJJZDtcbiAgICBjb25zdCBsb29rdXAgPSByZXNvbHZlS2V5KHByb3ZpZGVySWQpO1xuXG4gICAgaWYgKCFsb29rdXAuZm91bmQpIHtcbiAgICAgIC8vIENoZWNrIGlmIGEgY3Jvc3MtcHJvdmlkZXIgY2FuIHNlcnZlIHRoaXMgcHJvdmlkZXIncyBtb2RlbHNcbiAgICAgIGNvbnN0IHJvdXRlcyA9IFBST1ZJREVSX1JPVVRFU1twcm92aWRlcklkXTtcbiAgICAgIGNvbnN0IHJvdXRlUHJvdmlkZXIgPSByb3V0ZXM/LmZpbmQocm91dGVJZCA9PiByZXNvbHZlS2V5KHJvdXRlSWQpLmZvdW5kKTtcbiAgICAgIGlmIChyb3V0ZVByb3ZpZGVyKSB7XG4gICAgICAgIGNvbnN0IHJvdXRlSW5mbyA9IFBST1ZJREVSX1JFR0lTVFJZLmZpbmQocCA9PiBwLmlkID09PSByb3V0ZVByb3ZpZGVyKTtcbiAgICAgICAgY29uc3Qgcm91dGVMYWJlbCA9IHJvdXRlSW5mbz8ubGFiZWwgPz8gcm91dGVQcm92aWRlcjtcbiAgICAgICAgcmVzdWx0cy5wdXNoKHtcbiAgICAgICAgICBuYW1lOiBwcm92aWRlcklkLFxuICAgICAgICAgIGxhYmVsLFxuICAgICAgICAgIGNhdGVnb3J5OiBcImxsbVwiLFxuICAgICAgICAgIHN0YXR1czogXCJva1wiLFxuICAgICAgICAgIG1lc3NhZ2U6IGAke2xhYmVsfSBcdTIwMTQgYXZhaWxhYmxlIHZpYSAke3JvdXRlTGFiZWx9YCxcbiAgICAgICAgICByZXF1aXJlZDogdHJ1ZSxcbiAgICAgICAgfSk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBlbnZWYXIgPSBwcm92aWRlcklkID09PSBcImFudGhyb3BpYy12ZXJ0ZXhcIlxuICAgICAgICA/IFwiQU5USFJPUElDX1ZFUlRFWF9QUk9KRUNUX0lEXCJcbiAgICAgICAgOiBpbmZvPy5lbnZWYXIgPz8gYCR7cHJvdmlkZXJJZC50b1VwcGVyQ2FzZSgpfV9BUElfS0VZYDtcbiAgICAgIHJlc3VsdHMucHVzaCh7XG4gICAgICAgIG5hbWU6IHByb3ZpZGVySWQsXG4gICAgICAgIGxhYmVsLFxuICAgICAgICBjYXRlZ29yeTogXCJsbG1cIixcbiAgICAgICAgc3RhdHVzOiBcImVycm9yXCIsXG4gICAgICAgIG1lc3NhZ2U6IGAke2xhYmVsfSBcdTIwMTQgbm90IGNvbmZpZ3VyZWRgLFxuICAgICAgICBkZXRhaWw6IHByb3ZpZGVySWQgPT09IFwiYW50aHJvcGljLXZlcnRleFwiXG4gICAgICAgICAgPyBcIlNldCBBTlRIUk9QSUNfVkVSVEVYX1BST0pFQ1RfSUQgYW5kIGF1dGhlbnRpY2F0ZSB3aXRoIEdvb2dsZSBBRENcIlxuICAgICAgICAgIDogaW5mbz8uaGFzT0F1dGhcbiAgICAgICAgICA/IGBSdW4gL2dzZCBrZXlzIHRvIGF1dGhlbnRpY2F0ZWBcbiAgICAgICAgICA6IGBTZXQgJHtlbnZWYXJ9IG9yIHJ1biAvZ3NkIGtleXNgLFxuICAgICAgICByZXF1aXJlZDogdHJ1ZSxcbiAgICAgIH0pO1xuICAgIH0gZWxzZSBpZiAobG9va3VwLmJhY2tlZE9mZikge1xuICAgICAgcmVzdWx0cy5wdXNoKHtcbiAgICAgICAgbmFtZTogcHJvdmlkZXJJZCxcbiAgICAgICAgbGFiZWwsXG4gICAgICAgIGNhdGVnb3J5OiBcImxsbVwiLFxuICAgICAgICBzdGF0dXM6IFwid2FybmluZ1wiLFxuICAgICAgICBtZXNzYWdlOiBgJHtsYWJlbH0gXHUyMDE0IGFsbCBjcmVkZW50aWFscyBiYWNrZWQgb2ZmIChyYXRlIGxpbWl0ZWQpYCxcbiAgICAgICAgZGV0YWlsOiBgR1NEIHdpbGwgcmV0cnkgYXV0b21hdGljYWxseWAsXG4gICAgICAgIHJlcXVpcmVkOiB0cnVlLFxuICAgICAgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJlc3VsdHMucHVzaCh7XG4gICAgICAgIG5hbWU6IHByb3ZpZGVySWQsXG4gICAgICAgIGxhYmVsLFxuICAgICAgICBjYXRlZ29yeTogXCJsbG1cIixcbiAgICAgICAgc3RhdHVzOiBcIm9rXCIsXG4gICAgICAgIG1lc3NhZ2U6IGAke2xhYmVsfSBcdTIwMTQga2V5IHByZXNlbnQgKCR7bG9va3VwLnNvdXJjZX0pYCxcbiAgICAgICAgcmVxdWlyZWQ6IHRydWUsXG4gICAgICB9KTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gcmVzdWx0cztcbn1cblxuZnVuY3Rpb24gY2hlY2tSZW1vdGVRdWVzdGlvbnNQcm92aWRlcigpOiBQcm92aWRlckNoZWNrUmVzdWx0IHwgbnVsbCB7XG4gIHRyeSB7XG4gICAgY29uc3QgbG9hZGVkID0gbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzKCk7XG4gICAgY29uc3QgcnEgPSBsb2FkZWQ/LnByZWZlcmVuY2VzPy5yZW1vdGVfcXVlc3Rpb25zO1xuICAgIGlmICghcnEpIHJldHVybiBudWxsO1xuXG4gICAgY29uc3QgY2hhbm5lbCA9IHJxLmNoYW5uZWwgYXMgc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAgIGlmICghY2hhbm5lbCkgcmV0dXJuIG51bGw7XG5cbiAgICBjb25zdCBwcm92aWRlck1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgICAgIHNsYWNrOiBcInNsYWNrX2JvdFwiLFxuICAgICAgZGlzY29yZDogXCJkaXNjb3JkX2JvdFwiLFxuICAgICAgdGVsZWdyYW06IFwidGVsZWdyYW1fYm90XCIsXG4gICAgfTtcblxuICAgIGNvbnN0IHByb3ZpZGVySWQgPSBwcm92aWRlck1hcFtjaGFubmVsLnRvTG93ZXJDYXNlKCldO1xuICAgIGlmICghcHJvdmlkZXJJZCkgcmV0dXJuIG51bGw7XG5cbiAgICBjb25zdCBpbmZvID0gUFJPVklERVJfUkVHSVNUUlkuZmluZChwID0+IHAuaWQgPT09IHByb3ZpZGVySWQpO1xuICAgIGNvbnN0IGxhYmVsID0gaW5mbz8ubGFiZWwgPz8gY2hhbm5lbDtcbiAgICBjb25zdCBsb29rdXAgPSByZXNvbHZlS2V5KHByb3ZpZGVySWQpO1xuXG4gICAgaWYgKCFsb29rdXAuZm91bmQpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG5hbWU6IHByb3ZpZGVySWQsXG4gICAgICAgIGxhYmVsLFxuICAgICAgICBjYXRlZ29yeTogXCJyZW1vdGVcIixcbiAgICAgICAgc3RhdHVzOiBcIndhcm5pbmdcIixcbiAgICAgICAgbWVzc2FnZTogYCR7bGFiZWx9IFx1MjAxNCBjaGFubmVsIGNvbmZpZ3VyZWQgYnV0IHRva2VuIG5vdCBmb3VuZGAsXG4gICAgICAgIGRldGFpbDogaW5mbz8uZW52VmFyID8gYFNldCAke2luZm8uZW52VmFyfSBvciBydW4gL2dzZCBrZXlzYCA6IGBSdW4gL2dzZCBrZXlzIHRvIGNvbmZpZ3VyZWAsXG4gICAgICAgIHJlcXVpcmVkOiB0cnVlLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICByZXR1cm4ge1xuICAgICAgbmFtZTogcHJvdmlkZXJJZCxcbiAgICAgIGxhYmVsLFxuICAgICAgY2F0ZWdvcnk6IFwicmVtb3RlXCIsXG4gICAgICBzdGF0dXM6IFwib2tcIixcbiAgICAgIG1lc3NhZ2U6IGAke2xhYmVsfSBcdTIwMTQgdG9rZW4gcHJlc2VudCAoJHtsb29rdXAuc291cmNlfSlgLFxuICAgICAgcmVxdWlyZWQ6IHRydWUsXG4gICAgfTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuZnVuY3Rpb24gY2hlY2tPcHRpb25hbFByb3ZpZGVycygpOiBQcm92aWRlckNoZWNrUmVzdWx0W10ge1xuICBjb25zdCBvcHRpb25hbCA9IFtcImJyYXZlXCIsIFwidGF2aWx5XCIsIFwiamluYVwiLCBcImNvbnRleHQ3XCJdIGFzIGNvbnN0O1xuICBjb25zdCByZXN1bHRzOiBQcm92aWRlckNoZWNrUmVzdWx0W10gPSBbXTtcblxuICAvLyBEZXRlcm1pbmUgd2hpY2ggc2VhcmNoIHByb3ZpZGVycyBhcmUgY29uZmlndXJlZCBzbyB3ZSBjYW4gc3VwcHJlc3NcbiAgLy8gXCJub3QgY29uZmlndXJlZFwiIG5vaXNlIGZvciBhbHRlcm5hdGl2ZSBzZWFyY2ggcHJvdmlkZXJzIHdoZW4gYXQgbGVhc3RcbiAgLy8gb25lIGlzIGFscmVhZHkgYWN0aXZlIChlLmcuIGRvbid0IHdhcm4gYWJvdXQgbWlzc2luZyBCUkFWRV9BUElfS0VZXG4gIC8vIHdoZW4gVGF2aWx5IGlzIGNvbmZpZ3VyZWQpLlxuICBjb25zdCBzZWFyY2hQcm92aWRlcklkcyA9IFtcImJyYXZlXCIsIFwidGF2aWx5XCJdIGFzIGNvbnN0O1xuICBjb25zdCBoYXNBbnlTZWFyY2hQcm92aWRlciA9IHNlYXJjaFByb3ZpZGVySWRzLnNvbWUoaWQgPT4gcmVzb2x2ZUtleShpZCkuZm91bmQpO1xuXG4gIGZvciAoY29uc3QgcHJvdmlkZXJJZCBvZiBvcHRpb25hbCkge1xuICAgIGNvbnN0IGluZm8gPSBQUk9WSURFUl9SRUdJU1RSWS5maW5kKHAgPT4gcC5pZCA9PT0gcHJvdmlkZXJJZCk7XG4gICAgaWYgKCFpbmZvKSBjb250aW51ZTtcblxuICAgIGNvbnN0IGxvb2t1cCA9IHJlc29sdmVLZXkocHJvdmlkZXJJZCk7XG5cbiAgICAvLyBTa2lwIHVuY29uZmlndXJlZCBzZWFyY2ggcHJvdmlkZXJzIHdoZW4gYW5vdGhlciBzZWFyY2ggcHJvdmlkZXIgaXMgYWN0aXZlXG4gICAgaWYgKCFsb29rdXAuZm91bmQgJiYgaGFzQW55U2VhcmNoUHJvdmlkZXIgJiYgaW5mby5jYXRlZ29yeSA9PT0gXCJzZWFyY2hcIikge1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgcmVzdWx0cy5wdXNoKHtcbiAgICAgIG5hbWU6IHByb3ZpZGVySWQsXG4gICAgICBsYWJlbDogaW5mby5sYWJlbCxcbiAgICAgIGNhdGVnb3J5OiBpbmZvLmNhdGVnb3J5IGFzIFByb3ZpZGVyQ2F0ZWdvcnksXG4gICAgICBzdGF0dXM6IGxvb2t1cC5mb3VuZCA/IFwib2tcIiA6IFwidW5jb25maWd1cmVkXCIsXG4gICAgICBtZXNzYWdlOiBsb29rdXAuZm91bmRcbiAgICAgICAgPyBgJHtpbmZvLmxhYmVsfSBcdTIwMTQga2V5IHByZXNlbnQgKCR7bG9va3VwLnNvdXJjZX0pYFxuICAgICAgICA6IGAke2luZm8ubGFiZWx9IFx1MjAxNCBub3QgY29uZmlndXJlZCAob3B0aW9uYWwpYCxcbiAgICAgIGRldGFpbDogIWxvb2t1cC5mb3VuZCAmJiBpbmZvLmVudlZhciA/IGBTZXQgJHtpbmZvLmVudlZhcn0gdG8gZW5hYmxlYCA6IHVuZGVmaW5lZCxcbiAgICAgIHJlcXVpcmVkOiBmYWxzZSxcbiAgICB9KTtcbiAgfVxuXG4gIHJldHVybiByZXN1bHRzO1xufVxuXG4vLyBcdTI1MDBcdTI1MDAgUHVibGljIEFQSSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBSdW4gYWxsIHByb3ZpZGVyIGNoZWNrczogcmVxdWlyZWQgTExNIGtleXMsIHJlbW90ZSBxdWVzdGlvbnMgY2hhbm5lbCwgb3B0aW9uYWwgdG9vbHMuXG4gKiBGYXN0IChzdWItMTBtcykgXHUyMDE0IHJlYWRzIGF1dGguanNvbiBhbmQgZW52IHZhcnMgb25seSwgbm8gbmV0d29yayBJL08uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBydW5Qcm92aWRlckNoZWNrcygpOiBQcm92aWRlckNoZWNrUmVzdWx0W10ge1xuICBjb25zdCByZXN1bHRzOiBQcm92aWRlckNoZWNrUmVzdWx0W10gPSBbXTtcblxuICByZXN1bHRzLnB1c2goLi4uY2hlY2tMbG1Qcm92aWRlcnMoKSk7XG5cbiAgY29uc3QgcmVtb3RlQ2hlY2sgPSBjaGVja1JlbW90ZVF1ZXN0aW9uc1Byb3ZpZGVyKCk7XG4gIGlmIChyZW1vdGVDaGVjaykgcmVzdWx0cy5wdXNoKHJlbW90ZUNoZWNrKTtcblxuICByZXN1bHRzLnB1c2goLi4uY2hlY2tPcHRpb25hbFByb3ZpZGVycygpKTtcblxuICByZXR1cm4gcmVzdWx0cztcbn1cblxuLyoqXG4gKiBGb3JtYXQgcHJvdmlkZXIgY2hlY2sgcmVzdWx0cyBhcyBhIGh1bWFuLXJlYWRhYmxlIHJlcG9ydCBzdHJpbmcuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXRQcm92aWRlclJlcG9ydChyZXN1bHRzOiBQcm92aWRlckNoZWNrUmVzdWx0W10pOiBzdHJpbmcge1xuICBpZiAocmVzdWx0cy5sZW5ndGggPT09IDApIHJldHVybiBcIk5vIHByb3ZpZGVyIGNoZWNrcyBydW4uXCI7XG5cbiAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG5cbiAgY29uc3QgZ3JvdXBzOiBSZWNvcmQ8c3RyaW5nLCBQcm92aWRlckNoZWNrUmVzdWx0W10+ID0ge307XG4gIGZvciAoY29uc3QgciBvZiByZXN1bHRzKSB7XG4gICAgKGdyb3Vwc1tyLmNhdGVnb3J5XSA/Pz0gW10pLnB1c2gocik7XG4gIH1cblxuICBjb25zdCBjYXRlZ29yeUxhYmVsczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgICBsbG06IFwiTExNIFByb3ZpZGVyc1wiLFxuICAgIHJlbW90ZTogXCJOb3RpZmljYXRpb25zXCIsXG4gICAgc2VhcmNoOiBcIlNlYXJjaFwiLFxuICAgIHRvb2w6IFwiVG9vbHNcIixcbiAgfTtcblxuICBmb3IgKGNvbnN0IFtjYXQsIGl0ZW1zXSBvZiBPYmplY3QuZW50cmllcyhncm91cHMpKSB7XG4gICAgbGluZXMucHVzaChgJHtjYXRlZ29yeUxhYmVsc1tjYXRdID8/IGNhdH06YCk7XG4gICAgZm9yIChjb25zdCBpdGVtIG9mIGl0ZW1zKSB7XG4gICAgICBjb25zdCBpY29uID0gaXRlbS5zdGF0dXMgPT09IFwib2tcIiA/IFwiXHUyNzEzXCJcbiAgICAgICAgOiBpdGVtLnN0YXR1cyA9PT0gXCJ3YXJuaW5nXCIgPyBcIlx1MjZBMFwiXG4gICAgICAgIDogaXRlbS5zdGF0dXMgPT09IFwiZXJyb3JcIiA/IFwiXHUyNzE3XCJcbiAgICAgICAgOiBcIlx1MDBCN1wiO1xuICAgICAgbGluZXMucHVzaChgICAke2ljb259ICR7aXRlbS5tZXNzYWdlfWApO1xuICAgICAgaWYgKGl0ZW0uZGV0YWlsICYmIGl0ZW0uc3RhdHVzICE9PSBcIm9rXCIpIHtcbiAgICAgICAgbGluZXMucHVzaChgICAgICR7aXRlbS5kZXRhaWx9YCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGxpbmVzLmpvaW4oXCJcXG5cIik7XG59XG5cbi8qKlxuICogU3VtbWFyaXNlIGNoZWNrIHJlc3VsdHMgdG8gYSBjb21wYWN0IHdpZGdldC1mcmllbmRseSBzdHJpbmcuXG4gKiBSZXR1cm5zIG51bGwgaWYgYWxsIHJlcXVpcmVkIHByb3ZpZGVycyBhcmUgb2suXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdW1tYXJpc2VQcm92aWRlcklzc3VlcyhyZXN1bHRzOiBQcm92aWRlckNoZWNrUmVzdWx0W10pOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3QgZXJyb3JzID0gcmVzdWx0cy5maWx0ZXIociA9PiByLnJlcXVpcmVkICYmIHIuc3RhdHVzID09PSBcImVycm9yXCIpO1xuICBjb25zdCB3YXJuaW5ncyA9IHJlc3VsdHMuZmlsdGVyKHIgPT4gci5yZXF1aXJlZCAmJiByLnN0YXR1cyA9PT0gXCJ3YXJuaW5nXCIpO1xuXG4gIGlmIChlcnJvcnMubGVuZ3RoID09PSAwICYmIHdhcm5pbmdzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG5cbiAgY29uc3QgcGFydHM6IHN0cmluZ1tdID0gW107XG4gIGlmIChlcnJvcnMubGVuZ3RoID4gMCkgcGFydHMucHVzaChgXHUyNzE3ICR7ZXJyb3JzWzBdLmxhYmVsfSBrZXkgbWlzc2luZ2ApO1xuICBpZiAod2FybmluZ3MubGVuZ3RoID4gMCAmJiBlcnJvcnMubGVuZ3RoID09PSAwKSBwYXJ0cy5wdXNoKGBcdTI2QTAgJHt3YXJuaW5nc1swXS5sYWJlbH0gYmFja2VkIG9mZmApO1xuICBpZiAoZXJyb3JzLmxlbmd0aCArIHdhcm5pbmdzLmxlbmd0aCA+IDEpIHBhcnRzLnB1c2goYCgrJHtlcnJvcnMubGVuZ3RoICsgd2FybmluZ3MubGVuZ3RoIC0gMX0gbW9yZSlgKTtcblxuICByZXR1cm4gcGFydHMuam9pbihcIiBcIik7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFhQSxTQUFTLFlBQVksb0JBQW9CO0FBQ3pDLFNBQVMsV0FBVyxZQUFZO0FBQ2hDLFNBQVMsbUJBQW1CO0FBQzVCLFNBQVMsb0JBQW9CO0FBQzdCLFNBQVMsbUNBQW1DO0FBQzVDLFNBQVMsYUFBYSx5QkFBZ0Q7QUFDdEUsU0FBUyxlQUFlO0FBMkJ4QixNQUFNLHFCQUFxQixvQkFBSSxJQUFJO0FBQUEsRUFDakM7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFDRixDQUFDO0FBT0QsTUFBTSxrQkFBNEM7QUFBQSxFQUNoRCxXQUFXLENBQUMsa0JBQWtCLGFBQWE7QUFBQSxFQUMzQyxRQUFRLENBQUMsa0JBQWtCLGNBQWM7QUFBQSxFQUN6QyxRQUFRLENBQUMsbUJBQW1CO0FBQzlCO0FBUUEsU0FBUyxrQkFBa0IsT0FBOEI7QUFDdkQsTUFBSSxDQUFDLE1BQU8s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
