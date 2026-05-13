import test from "node:test";
import assert from "node:assert/strict";
import { AuthStorage } from "@gsd/pi-coding-agent";
import {
  maskKey,
  formatDuration,
  describeCredential,
  findProvider,
  getAllKeyStatuses,
  formatKeyDashboard,
  formatTestResults,
  runKeyDoctor,
  formatDoctorFindings,
  PROVIDER_REGISTRY
} from "../key-manager.js";
function makeAuth(data = {}) {
  return AuthStorage.inMemory(data);
}
test("maskKey masks a normal API key showing first 4 and last 4", () => {
  assert.equal(maskKey("sk-ant-api03-abcdefghijklmnop"), "sk-a***mnop");
});
test("maskKey masks a short key showing first 2 and last 2", () => {
  assert.equal(maskKey("abc12345"), "ab***45");
});
test("maskKey returns (empty) for empty string", () => {
  assert.equal(maskKey(""), "(empty)");
});
test("maskKey handles very short keys gracefully", () => {
  assert.equal(maskKey("ab"), "ab***ab");
});
test("maskKey handles 12-char boundary", () => {
  assert.equal(maskKey("123456789012"), "1234***9012");
});
test("formatDuration formats seconds", () => {
  assert.equal(formatDuration(3e4), "30s");
});
test("formatDuration formats minutes", () => {
  assert.equal(formatDuration(5 * 6e4), "5m");
});
test("formatDuration formats hours and minutes", () => {
  assert.equal(formatDuration(90 * 6e4), "1h 30m");
});
test("formatDuration formats exact hours without minutes", () => {
  assert.equal(formatDuration(2 * 60 * 6e4), "2h");
});
test("formatDuration returns expired for zero or negative", () => {
  assert.equal(formatDuration(0), "expired");
  assert.equal(formatDuration(-1e3), "expired");
});
test("describeCredential describes an API key with masked value", () => {
  const result = describeCredential({ type: "api_key", key: "sk-ant-test-key-12345" });
  assert.ok(result.includes("API key"));
  assert.ok(result.includes("sk-a"));
  assert.ok(result.includes("2345"));
});
test("describeCredential describes an empty API key", () => {
  assert.equal(describeCredential({ type: "api_key", key: "" }), "empty key");
});
test("describeCredential describes an OAuth token with expiry", () => {
  const result = describeCredential({
    type: "oauth",
    access: "token",
    refresh: "refresh",
    expires: Date.now() + 60 * 6e4
  });
  assert.ok(result.includes("OAuth"));
  assert.ok(result.includes("expires in"));
});
test("describeCredential describes an expired OAuth token", () => {
  const result = describeCredential({
    type: "oauth",
    access: "token",
    refresh: "refresh",
    expires: Date.now() - 1e3
  });
  assert.ok(result.includes("expired"));
});
test("findProvider finds by exact ID", () => {
  assert.equal(findProvider("anthropic")?.id, "anthropic");
});
test("findProvider finds by ID case-insensitively", () => {
  assert.equal(findProvider("OPENAI")?.id, "openai");
});
test("findProvider finds by label", () => {
  assert.equal(findProvider("Brave Search")?.id, "brave");
});
test("findProvider returns undefined for unknown", () => {
  assert.equal(findProvider("nonexistent"), void 0);
});
test("PROVIDER_REGISTRY has at least 15 providers", () => {
  assert.ok(PROVIDER_REGISTRY.length >= 15);
});
test("PROVIDER_REGISTRY has unique IDs", () => {
  const ids = PROVIDER_REGISTRY.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});
test("PROVIDER_REGISTRY every provider has id, label, and category", () => {
  const validCategories = ["llm", "tool", "search", "remote"];
  for (const p of PROVIDER_REGISTRY) {
    assert.ok(p.id, `provider missing id`);
    assert.ok(p.label, `provider ${p.id} missing label`);
    assert.ok(validCategories.includes(p.category), `provider ${p.id} has invalid category: ${p.category}`);
  }
});
test("PROVIDER_REGISTRY includes all major LLM providers", () => {
  const ids = PROVIDER_REGISTRY.map((p) => p.id);
  assert.ok(ids.includes("anthropic"));
  assert.ok(ids.includes("openai"));
  assert.ok(ids.includes("google"));
  assert.ok(ids.includes("groq"));
  assert.ok(ids.includes("minimax"));
  assert.ok(ids.includes("minimax-cn"));
});
test("PROVIDER_REGISTRY includes claude-code as a first-class LLM provider (#4541)", () => {
  const entry = PROVIDER_REGISTRY.find((p) => p.id === "claude-code");
  assert.ok(entry, "claude-code must be in PROVIDER_REGISTRY");
  assert.equal(entry.category, "llm");
  assert.ok(entry.hasOAuth, "claude-code uses OAuth (CLI auth)");
});
test("PROVIDER_REGISTRY includes all tool/search providers", () => {
  const ids = PROVIDER_REGISTRY.map((p) => p.id);
  assert.ok(ids.includes("tavily"));
  assert.ok(ids.includes("brave"));
  assert.ok(ids.includes("context7"));
  assert.ok(ids.includes("jina"));
});
test("getAllKeyStatuses shows unconfigured providers as not configured", () => {
  const auth = makeAuth();
  const statuses = getAllKeyStatuses(auth);
  const anthropic = statuses.find((s) => s.provider.id === "anthropic");
  assert.equal(anthropic?.configured, false);
  assert.equal(anthropic?.source, "none");
});
test("getAllKeyStatuses detects keys in auth.json", () => {
  const auth = makeAuth({ anthropic: { type: "api_key", key: "sk-ant-test" } });
  const statuses = getAllKeyStatuses(auth);
  const anthropic = statuses.find((s) => s.provider.id === "anthropic");
  assert.equal(anthropic?.configured, true);
  assert.equal(anthropic?.source, "auth.json");
  assert.equal(anthropic?.credentialCount, 1);
});
test("getAllKeyStatuses detects multiple keys", () => {
  const auth = makeAuth({
    openai: [
      { type: "api_key", key: "sk-key1" },
      { type: "api_key", key: "sk-key2" }
    ]
  });
  const statuses = getAllKeyStatuses(auth);
  const openai = statuses.find((s) => s.provider.id === "openai");
  assert.equal(openai?.configured, true);
  assert.equal(openai?.credentialCount, 2);
  assert.ok(openai?.description.includes("round-robin"));
});
test("getAllKeyStatuses detects empty keys as not configured", () => {
  const auth = makeAuth({ groq: { type: "api_key", key: "" } });
  const statuses = getAllKeyStatuses(auth);
  const groq = statuses.find((s) => s.provider.id === "groq");
  assert.equal(groq?.configured, false);
  assert.equal(groq?.source, "none");
});
test("getAllKeyStatuses finds valid keys even when empty-key entry exists at index 0", () => {
  const auth = makeAuth({
    groq: [
      { type: "api_key", key: "" },
      { type: "api_key", key: "gsk-real-key" }
    ]
  });
  const statuses = getAllKeyStatuses(auth);
  const groq = statuses.find((s) => s.provider.id === "groq");
  assert.equal(groq?.configured, true);
  assert.equal(groq?.source, "auth.json");
  assert.equal(groq?.credentialCount, 1);
});
test("getAllKeyStatuses detects env var keys", () => {
  const original = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-env-test";
  try {
    const auth = makeAuth();
    const statuses = getAllKeyStatuses(auth);
    const openai = statuses.find((s) => s.provider.id === "openai");
    assert.equal(openai?.configured, true);
    assert.equal(openai?.source, "env");
  } finally {
    if (original === void 0) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = original;
    }
  }
});
test("formatKeyDashboard includes header and category sections", () => {
  const auth = makeAuth({ anthropic: { type: "api_key", key: "sk-ant-test-key" } });
  const statuses = getAllKeyStatuses(auth);
  const output = formatKeyDashboard(statuses);
  assert.ok(output.includes("GSD API Key Manager"));
  assert.ok(output.includes("LLM Providers"));
  assert.ok(output.includes("Search Providers"));
  assert.ok(output.includes("Tool Keys"));
  assert.ok(output.includes("Remote Integrations"));
});
test("formatKeyDashboard shows configured counts", () => {
  const auth = makeAuth({
    anthropic: { type: "api_key", key: "sk-ant-test" },
    tavily: { type: "api_key", key: "tvly-test" }
  });
  const statuses = getAllKeyStatuses(auth);
  const output = formatKeyDashboard(statuses);
  assert.ok(output.includes("configured"));
  assert.ok(output.includes("auth.json"));
});
test("formatTestResults formats valid results with checkmark", () => {
  const results = [
    {
      provider: { id: "anthropic", label: "Anthropic", category: "llm" },
      status: "valid",
      message: "valid",
      latencyMs: 142
    }
  ];
  const output = formatTestResults(results);
  assert.ok(output.includes("\u2713"));
  assert.ok(output.includes("anthropic"));
  assert.ok(output.includes("142ms"));
  assert.ok(output.includes("1 valid"));
});
test("formatTestResults formats invalid results with X", () => {
  const results = [
    {
      provider: { id: "groq", label: "Groq", category: "llm" },
      status: "invalid",
      message: "invalid key (401)",
      latencyMs: 89
    }
  ];
  const output = formatTestResults(results);
  assert.ok(output.includes("\u2717"));
  assert.ok(output.includes("invalid"));
});
test("formatTestResults formats skipped results with dash", () => {
  const results = [
    {
      provider: { id: "jina", label: "Jina", category: "tool" },
      status: "skipped",
      message: "not configured"
    }
  ];
  const output = formatTestResults(results);
  assert.ok(output.includes("\u2014"));
  assert.ok(output.includes("1 skipped"));
});
test("formatTestResults shows summary counts for mixed results", () => {
  const results = [
    { provider: { id: "a", label: "A", category: "llm" }, status: "valid", message: "ok", latencyMs: 100 },
    { provider: { id: "b", label: "B", category: "llm" }, status: "invalid", message: "401", latencyMs: 50 },
    { provider: { id: "c", label: "C", category: "tool" }, status: "skipped", message: "n/a" }
  ];
  const output = formatTestResults(results);
  assert.ok(output.includes("1 valid"));
  assert.ok(output.includes("1 invalid"));
  assert.ok(output.includes("1 skipped"));
});
test("runKeyDoctor reports empty keys", () => {
  const auth = makeAuth({ groq: { type: "api_key", key: "" } });
  const findings = runKeyDoctor(auth);
  const emptyFinding = findings.find((f) => f.message.includes("empty key"));
  assert.ok(emptyFinding, "should find empty key warning");
  assert.equal(emptyFinding?.severity, "warning");
});
test("runKeyDoctor reports expired OAuth", () => {
  const auth = makeAuth({
    anthropic: { type: "oauth", access: "t", refresh: "r", expires: Date.now() - 1e4 }
  });
  const findings = runKeyDoctor(auth);
  const oauthFinding = findings.find((f) => f.message.includes("expired"));
  assert.ok(oauthFinding, "should find expired OAuth warning");
  assert.equal(oauthFinding?.severity, "warning");
});
test("runKeyDoctor reports soon-to-expire OAuth as info", () => {
  const auth = makeAuth({
    anthropic: { type: "oauth", access: "t", refresh: "r", expires: Date.now() + 2 * 6e4 }
  });
  const findings = runKeyDoctor(auth);
  const oauthFinding = findings.find((f) => f.message.includes("expires in"));
  assert.ok(oauthFinding, "should find expiring OAuth info");
  assert.equal(oauthFinding?.severity, "info");
});
test("runKeyDoctor reports missing LLM provider", () => {
  const llmEnvVars = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GROQ_API_KEY",
    "XAI_API_KEY",
    "OPENROUTER_API_KEY",
    "MISTRAL_API_KEY",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "COPILOT_GITHUB_TOKEN",
    "OLLAMA_API_KEY",
    "CUSTOM_OPENAI_API_KEY",
    "CEREBRAS_API_KEY",
    "AZURE_OPENAI_API_KEY"
  ];
  const saved = {};
  for (const v of llmEnvVars) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
  try {
    const auth = makeAuth();
    const findings = runKeyDoctor(auth);
    const missingLlm = findings.find((f) => f.message.includes("No LLM provider"));
    assert.ok(missingLlm, "should find missing LLM error");
    assert.equal(missingLlm?.severity, "error");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v !== void 0) process.env[k] = v;
      else delete process.env[k];
    }
  }
});
test("runKeyDoctor does not report missing LLM when one is configured", () => {
  const auth = makeAuth({ anthropic: { type: "api_key", key: "sk-ant-test" } });
  const findings = runKeyDoctor(auth);
  const missingLlm = findings.find((f) => f.message.includes("No LLM provider"));
  assert.equal(missingLlm, void 0);
});
test("runKeyDoctor reports duplicate keys across providers", () => {
  const auth = makeAuth({
    openai: { type: "api_key", key: "shared-key-123" },
    groq: { type: "api_key", key: "shared-key-123" }
  });
  const findings = runKeyDoctor(auth);
  const dupFinding = findings.find((f) => f.message.includes("Same key used"));
  assert.ok(dupFinding, "should find duplicate key warning");
  assert.equal(dupFinding?.severity, "warning");
});
test("runKeyDoctor reports env var conflicts", () => {
  const original = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "env-key";
  try {
    const auth = makeAuth({ openai: { type: "api_key", key: "different-key" } });
    const findings = runKeyDoctor(auth);
    const conflict = findings.find((f) => f.message.includes("differs from auth.json"));
    assert.ok(conflict, "should find env var conflict");
    assert.equal(conflict?.severity, "warning");
  } finally {
    if (original === void 0) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = original;
    }
  }
});
test("runKeyDoctor returns no issues when everything is healthy", () => {
  const auth = makeAuth({ anthropic: { type: "api_key", key: "sk-ant-healthy" } });
  const findings = runKeyDoctor(auth);
  const nonFileFindings = findings.filter((f) => !f.message.includes("auth.json permissions"));
  assert.equal(nonFileFindings.length, 0);
});
test("formatDoctorFindings shows all-clear for no findings", () => {
  const output = formatDoctorFindings([]);
  assert.ok(output.includes("All checks passed"));
});
test("formatDoctorFindings shows findings with appropriate icons", () => {
  const output = formatDoctorFindings([
    { severity: "error", message: "No LLM provider configured" },
    { severity: "warning", provider: "groq", message: "Empty key" },
    { severity: "fixed", message: "Permissions fixed" }
  ]);
  assert.ok(output.includes("\u2717"));
  assert.ok(output.includes("\u26A0"));
  assert.ok(output.includes("\u2713"));
  assert.ok(output.includes("1 error"));
  assert.ok(output.includes("1 warning"));
  assert.ok(output.includes("1 fixed"));
});
test("regression #3891 \u2014 alibaba-coding-plan is in PROVIDER_REGISTRY", () => {
  const provider = findProvider("alibaba-coding-plan");
  assert.ok(provider, "alibaba-coding-plan must be in PROVIDER_REGISTRY for /gsd keys add to work");
  assert.equal(provider.id, "alibaba-coding-plan");
  assert.equal(provider.category, "llm");
  assert.equal(provider.envVar, "ALIBABA_API_KEY");
});
test("alibaba-dashscope is in PROVIDER_REGISTRY", () => {
  const provider = findProvider("alibaba-dashscope");
  assert.ok(provider, "alibaba-dashscope must be in PROVIDER_REGISTRY for /gsd keys add to work");
  assert.equal(provider.id, "alibaba-dashscope");
  assert.equal(provider.category, "llm");
  assert.equal(provider.envVar, "DASHSCOPE_API_KEY");
});
test("alibaba-coding-plan and alibaba-dashscope are separate providers (different env vars)", () => {
  const codingPlan = findProvider("alibaba-coding-plan");
  const dashscope = findProvider("alibaba-dashscope");
  assert.ok(codingPlan, "alibaba-coding-plan must exist");
  assert.ok(dashscope, "alibaba-dashscope must exist");
  assert.notEqual(
    codingPlan.envVar,
    dashscope.envVar,
    "alibaba-coding-plan and alibaba-dashscope must use different env vars"
  );
});
test("getAllKeyStatuses includes alibaba-coding-plan", () => {
  const auth = makeAuth();
  const statuses = getAllKeyStatuses(auth);
  const found = statuses.find((s) => s.provider.id === "alibaba-coding-plan");
  assert.ok(found, "getAllKeyStatuses must include alibaba-coding-plan");
});
test("getAllKeyStatuses includes alibaba-dashscope", () => {
  const auth = makeAuth();
  const statuses = getAllKeyStatuses(auth);
  const found = statuses.find((s) => s.provider.id === "alibaba-dashscope");
  assert.ok(found, "getAllKeyStatuses must include alibaba-dashscope");
});
test("getAllKeyStatuses detects DASHSCOPE_API_KEY for alibaba-dashscope (failure path: missing key shows not configured)", () => {
  const saved = process.env.DASHSCOPE_API_KEY;
  delete process.env.DASHSCOPE_API_KEY;
  try {
    const auth = makeAuth();
    const statuses = getAllKeyStatuses(auth);
    const found = statuses.find((s) => s.provider.id === "alibaba-dashscope");
    assert.ok(found);
    assert.equal(found.configured, false);
    assert.equal(found.source, "none");
  } finally {
    if (saved !== void 0) process.env.DASHSCOPE_API_KEY = saved;
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9rZXktbWFuYWdlci50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IEF1dGhTdG9yYWdlIH0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XG5pbXBvcnQge1xuICBtYXNrS2V5LFxuICBmb3JtYXREdXJhdGlvbixcbiAgZGVzY3JpYmVDcmVkZW50aWFsLFxuICBmaW5kUHJvdmlkZXIsXG4gIGdldEFsbEtleVN0YXR1c2VzLFxuICBmb3JtYXRLZXlEYXNoYm9hcmQsXG4gIGZvcm1hdFRlc3RSZXN1bHRzLFxuICBydW5LZXlEb2N0b3IsXG4gIGZvcm1hdERvY3RvckZpbmRpbmdzLFxuICBQUk9WSURFUl9SRUdJU1RSWSxcbn0gZnJvbSBcIi4uL2tleS1tYW5hZ2VyLnRzXCI7XG5cbmZ1bmN0aW9uIG1ha2VBdXRoKGRhdGE6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7fSk6IEF1dGhTdG9yYWdlIHtcbiAgcmV0dXJuIEF1dGhTdG9yYWdlLmluTWVtb3J5KGRhdGEpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgbWFza0tleSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcIm1hc2tLZXkgbWFza3MgYSBub3JtYWwgQVBJIGtleSBzaG93aW5nIGZpcnN0IDQgYW5kIGxhc3QgNFwiLCAoKSA9PiB7XG4gIGFzc2VydC5lcXVhbChtYXNrS2V5KFwic2stYW50LWFwaTAzLWFiY2RlZmdoaWprbG1ub3BcIiksIFwic2stYSoqKm1ub3BcIik7XG59KTtcblxudGVzdChcIm1hc2tLZXkgbWFza3MgYSBzaG9ydCBrZXkgc2hvd2luZyBmaXJzdCAyIGFuZCBsYXN0IDJcIiwgKCkgPT4ge1xuICBhc3NlcnQuZXF1YWwobWFza0tleShcImFiYzEyMzQ1XCIpLCBcImFiKioqNDVcIik7XG59KTtcblxudGVzdChcIm1hc2tLZXkgcmV0dXJucyAoZW1wdHkpIGZvciBlbXB0eSBzdHJpbmdcIiwgKCkgPT4ge1xuICBhc3NlcnQuZXF1YWwobWFza0tleShcIlwiKSwgXCIoZW1wdHkpXCIpO1xufSk7XG5cbnRlc3QoXCJtYXNrS2V5IGhhbmRsZXMgdmVyeSBzaG9ydCBrZXlzIGdyYWNlZnVsbHlcIiwgKCkgPT4ge1xuICBhc3NlcnQuZXF1YWwobWFza0tleShcImFiXCIpLCBcImFiKioqYWJcIik7XG59KTtcblxudGVzdChcIm1hc2tLZXkgaGFuZGxlcyAxMi1jaGFyIGJvdW5kYXJ5XCIsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKG1hc2tLZXkoXCIxMjM0NTY3ODkwMTJcIiksIFwiMTIzNCoqKjkwMTJcIik7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGZvcm1hdER1cmF0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiZm9ybWF0RHVyYXRpb24gZm9ybWF0cyBzZWNvbmRzXCIsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKGZvcm1hdER1cmF0aW9uKDMwXzAwMCksIFwiMzBzXCIpO1xufSk7XG5cbnRlc3QoXCJmb3JtYXREdXJhdGlvbiBmb3JtYXRzIG1pbnV0ZXNcIiwgKCkgPT4ge1xuICBhc3NlcnQuZXF1YWwoZm9ybWF0RHVyYXRpb24oNSAqIDYwXzAwMCksIFwiNW1cIik7XG59KTtcblxudGVzdChcImZvcm1hdER1cmF0aW9uIGZvcm1hdHMgaG91cnMgYW5kIG1pbnV0ZXNcIiwgKCkgPT4ge1xuICBhc3NlcnQuZXF1YWwoZm9ybWF0RHVyYXRpb24oOTAgKiA2MF8wMDApLCBcIjFoIDMwbVwiKTtcbn0pO1xuXG50ZXN0KFwiZm9ybWF0RHVyYXRpb24gZm9ybWF0cyBleGFjdCBob3VycyB3aXRob3V0IG1pbnV0ZXNcIiwgKCkgPT4ge1xuICBhc3NlcnQuZXF1YWwoZm9ybWF0RHVyYXRpb24oMiAqIDYwICogNjBfMDAwKSwgXCIyaFwiKTtcbn0pO1xuXG50ZXN0KFwiZm9ybWF0RHVyYXRpb24gcmV0dXJucyBleHBpcmVkIGZvciB6ZXJvIG9yIG5lZ2F0aXZlXCIsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKGZvcm1hdER1cmF0aW9uKDApLCBcImV4cGlyZWRcIik7XG4gIGFzc2VydC5lcXVhbChmb3JtYXREdXJhdGlvbigtMTAwMCksIFwiZXhwaXJlZFwiKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgZGVzY3JpYmVDcmVkZW50aWFsIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiZGVzY3JpYmVDcmVkZW50aWFsIGRlc2NyaWJlcyBhbiBBUEkga2V5IHdpdGggbWFza2VkIHZhbHVlXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gZGVzY3JpYmVDcmVkZW50aWFsKHsgdHlwZTogXCJhcGlfa2V5XCIsIGtleTogXCJzay1hbnQtdGVzdC1rZXktMTIzNDVcIiB9KTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcyhcIkFQSSBrZXlcIikpO1xuICBhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKFwic2stYVwiKSk7XG4gIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoXCIyMzQ1XCIpKTtcbn0pO1xuXG50ZXN0KFwiZGVzY3JpYmVDcmVkZW50aWFsIGRlc2NyaWJlcyBhbiBlbXB0eSBBUEkga2V5XCIsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKGRlc2NyaWJlQ3JlZGVudGlhbCh7IHR5cGU6IFwiYXBpX2tleVwiLCBrZXk6IFwiXCIgfSksIFwiZW1wdHkga2V5XCIpO1xufSk7XG5cbnRlc3QoXCJkZXNjcmliZUNyZWRlbnRpYWwgZGVzY3JpYmVzIGFuIE9BdXRoIHRva2VuIHdpdGggZXhwaXJ5XCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gZGVzY3JpYmVDcmVkZW50aWFsKHtcbiAgICB0eXBlOiBcIm9hdXRoXCIsXG4gICAgYWNjZXNzOiBcInRva2VuXCIsXG4gICAgcmVmcmVzaDogXCJyZWZyZXNoXCIsXG4gICAgZXhwaXJlczogRGF0ZS5ub3coKSArIDYwICogNjBfMDAwLFxuICB9KTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcyhcIk9BdXRoXCIpKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcyhcImV4cGlyZXMgaW5cIikpO1xufSk7XG5cbnRlc3QoXCJkZXNjcmliZUNyZWRlbnRpYWwgZGVzY3JpYmVzIGFuIGV4cGlyZWQgT0F1dGggdG9rZW5cIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBkZXNjcmliZUNyZWRlbnRpYWwoe1xuICAgIHR5cGU6IFwib2F1dGhcIixcbiAgICBhY2Nlc3M6IFwidG9rZW5cIixcbiAgICByZWZyZXNoOiBcInJlZnJlc2hcIixcbiAgICBleHBpcmVzOiBEYXRlLm5vdygpIC0gMTAwMCxcbiAgfSk7XG4gIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoXCJleHBpcmVkXCIpKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgZmluZFByb3ZpZGVyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiZmluZFByb3ZpZGVyIGZpbmRzIGJ5IGV4YWN0IElEXCIsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKGZpbmRQcm92aWRlcihcImFudGhyb3BpY1wiKT8uaWQsIFwiYW50aHJvcGljXCIpO1xufSk7XG5cbnRlc3QoXCJmaW5kUHJvdmlkZXIgZmluZHMgYnkgSUQgY2FzZS1pbnNlbnNpdGl2ZWx5XCIsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKGZpbmRQcm92aWRlcihcIk9QRU5BSVwiKT8uaWQsIFwib3BlbmFpXCIpO1xufSk7XG5cbnRlc3QoXCJmaW5kUHJvdmlkZXIgZmluZHMgYnkgbGFiZWxcIiwgKCkgPT4ge1xuICBhc3NlcnQuZXF1YWwoZmluZFByb3ZpZGVyKFwiQnJhdmUgU2VhcmNoXCIpPy5pZCwgXCJicmF2ZVwiKTtcbn0pO1xuXG50ZXN0KFwiZmluZFByb3ZpZGVyIHJldHVybnMgdW5kZWZpbmVkIGZvciB1bmtub3duXCIsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKGZpbmRQcm92aWRlcihcIm5vbmV4aXN0ZW50XCIpLCB1bmRlZmluZWQpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBQUk9WSURFUl9SRUdJU1RSWSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcIlBST1ZJREVSX1JFR0lTVFJZIGhhcyBhdCBsZWFzdCAxNSBwcm92aWRlcnNcIiwgKCkgPT4ge1xuICBhc3NlcnQub2soUFJPVklERVJfUkVHSVNUUlkubGVuZ3RoID49IDE1KTtcbn0pO1xuXG50ZXN0KFwiUFJPVklERVJfUkVHSVNUUlkgaGFzIHVuaXF1ZSBJRHNcIiwgKCkgPT4ge1xuICBjb25zdCBpZHMgPSBQUk9WSURFUl9SRUdJU1RSWS5tYXAoKHApID0+IHAuaWQpO1xuICBhc3NlcnQuZXF1YWwobmV3IFNldChpZHMpLnNpemUsIGlkcy5sZW5ndGgpO1xufSk7XG5cbnRlc3QoXCJQUk9WSURFUl9SRUdJU1RSWSBldmVyeSBwcm92aWRlciBoYXMgaWQsIGxhYmVsLCBhbmQgY2F0ZWdvcnlcIiwgKCkgPT4ge1xuICBjb25zdCB2YWxpZENhdGVnb3JpZXMgPSBbXCJsbG1cIiwgXCJ0b29sXCIsIFwic2VhcmNoXCIsIFwicmVtb3RlXCJdO1xuICBmb3IgKGNvbnN0IHAgb2YgUFJPVklERVJfUkVHSVNUUlkpIHtcbiAgICBhc3NlcnQub2socC5pZCwgYHByb3ZpZGVyIG1pc3NpbmcgaWRgKTtcbiAgICBhc3NlcnQub2socC5sYWJlbCwgYHByb3ZpZGVyICR7cC5pZH0gbWlzc2luZyBsYWJlbGApO1xuICAgIGFzc2VydC5vayh2YWxpZENhdGVnb3JpZXMuaW5jbHVkZXMocC5jYXRlZ29yeSksIGBwcm92aWRlciAke3AuaWR9IGhhcyBpbnZhbGlkIGNhdGVnb3J5OiAke3AuY2F0ZWdvcnl9YCk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiUFJPVklERVJfUkVHSVNUUlkgaW5jbHVkZXMgYWxsIG1ham9yIExMTSBwcm92aWRlcnNcIiwgKCkgPT4ge1xuICBjb25zdCBpZHMgPSBQUk9WSURFUl9SRUdJU1RSWS5tYXAoKHApID0+IHAuaWQpO1xuICBhc3NlcnQub2soaWRzLmluY2x1ZGVzKFwiYW50aHJvcGljXCIpKTtcbiAgYXNzZXJ0Lm9rKGlkcy5pbmNsdWRlcyhcIm9wZW5haVwiKSk7XG4gIGFzc2VydC5vayhpZHMuaW5jbHVkZXMoXCJnb29nbGVcIikpO1xuICBhc3NlcnQub2soaWRzLmluY2x1ZGVzKFwiZ3JvcVwiKSk7XG4gIGFzc2VydC5vayhpZHMuaW5jbHVkZXMoXCJtaW5pbWF4XCIpKTtcbiAgYXNzZXJ0Lm9rKGlkcy5pbmNsdWRlcyhcIm1pbmltYXgtY25cIikpO1xufSk7XG5cbnRlc3QoXCJQUk9WSURFUl9SRUdJU1RSWSBpbmNsdWRlcyBjbGF1ZGUtY29kZSBhcyBhIGZpcnN0LWNsYXNzIExMTSBwcm92aWRlciAoIzQ1NDEpXCIsICgpID0+IHtcbiAgY29uc3QgZW50cnkgPSBQUk9WSURFUl9SRUdJU1RSWS5maW5kKChwKSA9PiBwLmlkID09PSBcImNsYXVkZS1jb2RlXCIpO1xuICBhc3NlcnQub2soZW50cnksIFwiY2xhdWRlLWNvZGUgbXVzdCBiZSBpbiBQUk9WSURFUl9SRUdJU1RSWVwiKTtcbiAgYXNzZXJ0LmVxdWFsKGVudHJ5IS5jYXRlZ29yeSwgXCJsbG1cIik7XG4gIGFzc2VydC5vayhlbnRyeSEuaGFzT0F1dGgsIFwiY2xhdWRlLWNvZGUgdXNlcyBPQXV0aCAoQ0xJIGF1dGgpXCIpO1xufSk7XG5cbnRlc3QoXCJQUk9WSURFUl9SRUdJU1RSWSBpbmNsdWRlcyBhbGwgdG9vbC9zZWFyY2ggcHJvdmlkZXJzXCIsICgpID0+IHtcbiAgY29uc3QgaWRzID0gUFJPVklERVJfUkVHSVNUUlkubWFwKChwKSA9PiBwLmlkKTtcbiAgYXNzZXJ0Lm9rKGlkcy5pbmNsdWRlcyhcInRhdmlseVwiKSk7XG4gIGFzc2VydC5vayhpZHMuaW5jbHVkZXMoXCJicmF2ZVwiKSk7XG4gIGFzc2VydC5vayhpZHMuaW5jbHVkZXMoXCJjb250ZXh0N1wiKSk7XG4gIGFzc2VydC5vayhpZHMuaW5jbHVkZXMoXCJqaW5hXCIpKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgZ2V0QWxsS2V5U3RhdHVzZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJnZXRBbGxLZXlTdGF0dXNlcyBzaG93cyB1bmNvbmZpZ3VyZWQgcHJvdmlkZXJzIGFzIG5vdCBjb25maWd1cmVkXCIsICgpID0+IHtcbiAgY29uc3QgYXV0aCA9IG1ha2VBdXRoKCk7XG4gIGNvbnN0IHN0YXR1c2VzID0gZ2V0QWxsS2V5U3RhdHVzZXMoYXV0aCk7XG4gIGNvbnN0IGFudGhyb3BpYyA9IHN0YXR1c2VzLmZpbmQoKHMpID0+IHMucHJvdmlkZXIuaWQgPT09IFwiYW50aHJvcGljXCIpO1xuICBhc3NlcnQuZXF1YWwoYW50aHJvcGljPy5jb25maWd1cmVkLCBmYWxzZSk7XG4gIGFzc2VydC5lcXVhbChhbnRocm9waWM/LnNvdXJjZSwgXCJub25lXCIpO1xufSk7XG5cbnRlc3QoXCJnZXRBbGxLZXlTdGF0dXNlcyBkZXRlY3RzIGtleXMgaW4gYXV0aC5qc29uXCIsICgpID0+IHtcbiAgY29uc3QgYXV0aCA9IG1ha2VBdXRoKHsgYW50aHJvcGljOiB7IHR5cGU6IFwiYXBpX2tleVwiLCBrZXk6IFwic2stYW50LXRlc3RcIiB9IH0pO1xuICBjb25zdCBzdGF0dXNlcyA9IGdldEFsbEtleVN0YXR1c2VzKGF1dGgpO1xuICBjb25zdCBhbnRocm9waWMgPSBzdGF0dXNlcy5maW5kKChzKSA9PiBzLnByb3ZpZGVyLmlkID09PSBcImFudGhyb3BpY1wiKTtcbiAgYXNzZXJ0LmVxdWFsKGFudGhyb3BpYz8uY29uZmlndXJlZCwgdHJ1ZSk7XG4gIGFzc2VydC5lcXVhbChhbnRocm9waWM/LnNvdXJjZSwgXCJhdXRoLmpzb25cIik7XG4gIGFzc2VydC5lcXVhbChhbnRocm9waWM/LmNyZWRlbnRpYWxDb3VudCwgMSk7XG59KTtcblxudGVzdChcImdldEFsbEtleVN0YXR1c2VzIGRldGVjdHMgbXVsdGlwbGUga2V5c1wiLCAoKSA9PiB7XG4gIGNvbnN0IGF1dGggPSBtYWtlQXV0aCh7XG4gICAgb3BlbmFpOiBbXG4gICAgICB7IHR5cGU6IFwiYXBpX2tleVwiLCBrZXk6IFwic2sta2V5MVwiIH0sXG4gICAgICB7IHR5cGU6IFwiYXBpX2tleVwiLCBrZXk6IFwic2sta2V5MlwiIH0sXG4gICAgXSxcbiAgfSk7XG4gIGNvbnN0IHN0YXR1c2VzID0gZ2V0QWxsS2V5U3RhdHVzZXMoYXV0aCk7XG4gIGNvbnN0IG9wZW5haSA9IHN0YXR1c2VzLmZpbmQoKHMpID0+IHMucHJvdmlkZXIuaWQgPT09IFwib3BlbmFpXCIpO1xuICBhc3NlcnQuZXF1YWwob3BlbmFpPy5jb25maWd1cmVkLCB0cnVlKTtcbiAgYXNzZXJ0LmVxdWFsKG9wZW5haT8uY3JlZGVudGlhbENvdW50LCAyKTtcbiAgYXNzZXJ0Lm9rKG9wZW5haT8uZGVzY3JpcHRpb24uaW5jbHVkZXMoXCJyb3VuZC1yb2JpblwiKSk7XG59KTtcblxudGVzdChcImdldEFsbEtleVN0YXR1c2VzIGRldGVjdHMgZW1wdHkga2V5cyBhcyBub3QgY29uZmlndXJlZFwiLCAoKSA9PiB7XG4gIGNvbnN0IGF1dGggPSBtYWtlQXV0aCh7IGdyb3E6IHsgdHlwZTogXCJhcGlfa2V5XCIsIGtleTogXCJcIiB9IH0pO1xuICBjb25zdCBzdGF0dXNlcyA9IGdldEFsbEtleVN0YXR1c2VzKGF1dGgpO1xuICBjb25zdCBncm9xID0gc3RhdHVzZXMuZmluZCgocykgPT4gcy5wcm92aWRlci5pZCA9PT0gXCJncm9xXCIpO1xuICBhc3NlcnQuZXF1YWwoZ3JvcT8uY29uZmlndXJlZCwgZmFsc2UpO1xuICAvLyBFbXB0eS1rZXkgZW50cmllcyBhcmUgZmlsdGVyZWQgb3V0LCBzbyBwcm92aWRlciBhcHBlYXJzIHVuY29uZmlndXJlZFxuICBhc3NlcnQuZXF1YWwoZ3JvcT8uc291cmNlLCBcIm5vbmVcIik7XG59KTtcblxudGVzdChcImdldEFsbEtleVN0YXR1c2VzIGZpbmRzIHZhbGlkIGtleXMgZXZlbiB3aGVuIGVtcHR5LWtleSBlbnRyeSBleGlzdHMgYXQgaW5kZXggMFwiLCAoKSA9PiB7XG4gIGNvbnN0IGF1dGggPSBtYWtlQXV0aCh7XG4gICAgZ3JvcTogW1xuICAgICAgeyB0eXBlOiBcImFwaV9rZXlcIiwga2V5OiBcIlwiIH0sXG4gICAgICB7IHR5cGU6IFwiYXBpX2tleVwiLCBrZXk6IFwiZ3NrLXJlYWwta2V5XCIgfSxcbiAgICBdLFxuICB9KTtcbiAgY29uc3Qgc3RhdHVzZXMgPSBnZXRBbGxLZXlTdGF0dXNlcyhhdXRoKTtcbiAgY29uc3QgZ3JvcSA9IHN0YXR1c2VzLmZpbmQoKHMpID0+IHMucHJvdmlkZXIuaWQgPT09IFwiZ3JvcVwiKTtcbiAgYXNzZXJ0LmVxdWFsKGdyb3E/LmNvbmZpZ3VyZWQsIHRydWUpO1xuICBhc3NlcnQuZXF1YWwoZ3JvcT8uc291cmNlLCBcImF1dGguanNvblwiKTtcbiAgYXNzZXJ0LmVxdWFsKGdyb3E/LmNyZWRlbnRpYWxDb3VudCwgMSk7IC8vIG9ubHkgdGhlIHZhbGlkIGtleSBjb3VudHNcbn0pO1xuXG50ZXN0KFwiZ2V0QWxsS2V5U3RhdHVzZXMgZGV0ZWN0cyBlbnYgdmFyIGtleXNcIiwgKCkgPT4ge1xuICBjb25zdCBvcmlnaW5hbCA9IHByb2Nlc3MuZW52Lk9QRU5BSV9BUElfS0VZO1xuICBwcm9jZXNzLmVudi5PUEVOQUlfQVBJX0tFWSA9IFwic2stZW52LXRlc3RcIjtcbiAgdHJ5IHtcbiAgICBjb25zdCBhdXRoID0gbWFrZUF1dGgoKTtcbiAgICBjb25zdCBzdGF0dXNlcyA9IGdldEFsbEtleVN0YXR1c2VzKGF1dGgpO1xuICAgIGNvbnN0IG9wZW5haSA9IHN0YXR1c2VzLmZpbmQoKHMpID0+IHMucHJvdmlkZXIuaWQgPT09IFwib3BlbmFpXCIpO1xuICAgIGFzc2VydC5lcXVhbChvcGVuYWk/LmNvbmZpZ3VyZWQsIHRydWUpO1xuICAgIGFzc2VydC5lcXVhbChvcGVuYWk/LnNvdXJjZSwgXCJlbnZcIik7XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKG9yaWdpbmFsID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGRlbGV0ZSBwcm9jZXNzLmVudi5PUEVOQUlfQVBJX0tFWTtcbiAgICB9IGVsc2Uge1xuICAgICAgcHJvY2Vzcy5lbnYuT1BFTkFJX0FQSV9LRVkgPSBvcmlnaW5hbDtcbiAgICB9XG4gIH1cbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgZm9ybWF0S2V5RGFzaGJvYXJkIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiZm9ybWF0S2V5RGFzaGJvYXJkIGluY2x1ZGVzIGhlYWRlciBhbmQgY2F0ZWdvcnkgc2VjdGlvbnNcIiwgKCkgPT4ge1xuICBjb25zdCBhdXRoID0gbWFrZUF1dGgoeyBhbnRocm9waWM6IHsgdHlwZTogXCJhcGlfa2V5XCIsIGtleTogXCJzay1hbnQtdGVzdC1rZXlcIiB9IH0pO1xuICBjb25zdCBzdGF0dXNlcyA9IGdldEFsbEtleVN0YXR1c2VzKGF1dGgpO1xuICBjb25zdCBvdXRwdXQgPSBmb3JtYXRLZXlEYXNoYm9hcmQoc3RhdHVzZXMpO1xuXG4gIGFzc2VydC5vayhvdXRwdXQuaW5jbHVkZXMoXCJHU0QgQVBJIEtleSBNYW5hZ2VyXCIpKTtcbiAgYXNzZXJ0Lm9rKG91dHB1dC5pbmNsdWRlcyhcIkxMTSBQcm92aWRlcnNcIikpO1xuICBhc3NlcnQub2sob3V0cHV0LmluY2x1ZGVzKFwiU2VhcmNoIFByb3ZpZGVyc1wiKSk7XG4gIGFzc2VydC5vayhvdXRwdXQuaW5jbHVkZXMoXCJUb29sIEtleXNcIikpO1xuICBhc3NlcnQub2sob3V0cHV0LmluY2x1ZGVzKFwiUmVtb3RlIEludGVncmF0aW9uc1wiKSk7XG59KTtcblxudGVzdChcImZvcm1hdEtleURhc2hib2FyZCBzaG93cyBjb25maWd1cmVkIGNvdW50c1wiLCAoKSA9PiB7XG4gIGNvbnN0IGF1dGggPSBtYWtlQXV0aCh7XG4gICAgYW50aHJvcGljOiB7IHR5cGU6IFwiYXBpX2tleVwiLCBrZXk6IFwic2stYW50LXRlc3RcIiB9LFxuICAgIHRhdmlseTogeyB0eXBlOiBcImFwaV9rZXlcIiwga2V5OiBcInR2bHktdGVzdFwiIH0sXG4gIH0pO1xuICBjb25zdCBzdGF0dXNlcyA9IGdldEFsbEtleVN0YXR1c2VzKGF1dGgpO1xuICBjb25zdCBvdXRwdXQgPSBmb3JtYXRLZXlEYXNoYm9hcmQoc3RhdHVzZXMpO1xuICBhc3NlcnQub2sob3V0cHV0LmluY2x1ZGVzKFwiY29uZmlndXJlZFwiKSk7XG4gIGFzc2VydC5vayhvdXRwdXQuaW5jbHVkZXMoXCJhdXRoLmpzb25cIikpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBmb3JtYXRUZXN0UmVzdWx0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcImZvcm1hdFRlc3RSZXN1bHRzIGZvcm1hdHMgdmFsaWQgcmVzdWx0cyB3aXRoIGNoZWNrbWFya1wiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdHMgPSBbXG4gICAge1xuICAgICAgcHJvdmlkZXI6IHsgaWQ6IFwiYW50aHJvcGljXCIsIGxhYmVsOiBcIkFudGhyb3BpY1wiLCBjYXRlZ29yeTogXCJsbG1cIiBhcyBjb25zdCB9LFxuICAgICAgc3RhdHVzOiBcInZhbGlkXCIgYXMgY29uc3QsXG4gICAgICBtZXNzYWdlOiBcInZhbGlkXCIsXG4gICAgICBsYXRlbmN5TXM6IDE0MixcbiAgICB9LFxuICBdO1xuICBjb25zdCBvdXRwdXQgPSBmb3JtYXRUZXN0UmVzdWx0cyhyZXN1bHRzKTtcbiAgYXNzZXJ0Lm9rKG91dHB1dC5pbmNsdWRlcyhcIlx1MjcxM1wiKSk7XG4gIGFzc2VydC5vayhvdXRwdXQuaW5jbHVkZXMoXCJhbnRocm9waWNcIikpO1xuICBhc3NlcnQub2sob3V0cHV0LmluY2x1ZGVzKFwiMTQybXNcIikpO1xuICBhc3NlcnQub2sob3V0cHV0LmluY2x1ZGVzKFwiMSB2YWxpZFwiKSk7XG59KTtcblxudGVzdChcImZvcm1hdFRlc3RSZXN1bHRzIGZvcm1hdHMgaW52YWxpZCByZXN1bHRzIHdpdGggWFwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdHMgPSBbXG4gICAge1xuICAgICAgcHJvdmlkZXI6IHsgaWQ6IFwiZ3JvcVwiLCBsYWJlbDogXCJHcm9xXCIsIGNhdGVnb3J5OiBcImxsbVwiIGFzIGNvbnN0IH0sXG4gICAgICBzdGF0dXM6IFwiaW52YWxpZFwiIGFzIGNvbnN0LFxuICAgICAgbWVzc2FnZTogXCJpbnZhbGlkIGtleSAoNDAxKVwiLFxuICAgICAgbGF0ZW5jeU1zOiA4OSxcbiAgICB9LFxuICBdO1xuICBjb25zdCBvdXRwdXQgPSBmb3JtYXRUZXN0UmVzdWx0cyhyZXN1bHRzKTtcbiAgYXNzZXJ0Lm9rKG91dHB1dC5pbmNsdWRlcyhcIlx1MjcxN1wiKSk7XG4gIGFzc2VydC5vayhvdXRwdXQuaW5jbHVkZXMoXCJpbnZhbGlkXCIpKTtcbn0pO1xuXG50ZXN0KFwiZm9ybWF0VGVzdFJlc3VsdHMgZm9ybWF0cyBza2lwcGVkIHJlc3VsdHMgd2l0aCBkYXNoXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0cyA9IFtcbiAgICB7XG4gICAgICBwcm92aWRlcjogeyBpZDogXCJqaW5hXCIsIGxhYmVsOiBcIkppbmFcIiwgY2F0ZWdvcnk6IFwidG9vbFwiIGFzIGNvbnN0IH0sXG4gICAgICBzdGF0dXM6IFwic2tpcHBlZFwiIGFzIGNvbnN0LFxuICAgICAgbWVzc2FnZTogXCJub3QgY29uZmlndXJlZFwiLFxuICAgIH0sXG4gIF07XG4gIGNvbnN0IG91dHB1dCA9IGZvcm1hdFRlc3RSZXN1bHRzKHJlc3VsdHMpO1xuICBhc3NlcnQub2sob3V0cHV0LmluY2x1ZGVzKFwiXHUyMDE0XCIpKTtcbiAgYXNzZXJ0Lm9rKG91dHB1dC5pbmNsdWRlcyhcIjEgc2tpcHBlZFwiKSk7XG59KTtcblxudGVzdChcImZvcm1hdFRlc3RSZXN1bHRzIHNob3dzIHN1bW1hcnkgY291bnRzIGZvciBtaXhlZCByZXN1bHRzXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0cyA9IFtcbiAgICB7IHByb3ZpZGVyOiB7IGlkOiBcImFcIiwgbGFiZWw6IFwiQVwiLCBjYXRlZ29yeTogXCJsbG1cIiBhcyBjb25zdCB9LCBzdGF0dXM6IFwidmFsaWRcIiBhcyBjb25zdCwgbWVzc2FnZTogXCJva1wiLCBsYXRlbmN5TXM6IDEwMCB9LFxuICAgIHsgcHJvdmlkZXI6IHsgaWQ6IFwiYlwiLCBsYWJlbDogXCJCXCIsIGNhdGVnb3J5OiBcImxsbVwiIGFzIGNvbnN0IH0sIHN0YXR1czogXCJpbnZhbGlkXCIgYXMgY29uc3QsIG1lc3NhZ2U6IFwiNDAxXCIsIGxhdGVuY3lNczogNTAgfSxcbiAgICB7IHByb3ZpZGVyOiB7IGlkOiBcImNcIiwgbGFiZWw6IFwiQ1wiLCBjYXRlZ29yeTogXCJ0b29sXCIgYXMgY29uc3QgfSwgc3RhdHVzOiBcInNraXBwZWRcIiBhcyBjb25zdCwgbWVzc2FnZTogXCJuL2FcIiB9LFxuICBdO1xuICBjb25zdCBvdXRwdXQgPSBmb3JtYXRUZXN0UmVzdWx0cyhyZXN1bHRzKTtcbiAgYXNzZXJ0Lm9rKG91dHB1dC5pbmNsdWRlcyhcIjEgdmFsaWRcIikpO1xuICBhc3NlcnQub2sob3V0cHV0LmluY2x1ZGVzKFwiMSBpbnZhbGlkXCIpKTtcbiAgYXNzZXJ0Lm9rKG91dHB1dC5pbmNsdWRlcyhcIjEgc2tpcHBlZFwiKSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHJ1bktleURvY3RvciBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcInJ1bktleURvY3RvciByZXBvcnRzIGVtcHR5IGtleXNcIiwgKCkgPT4ge1xuICBjb25zdCBhdXRoID0gbWFrZUF1dGgoeyBncm9xOiB7IHR5cGU6IFwiYXBpX2tleVwiLCBrZXk6IFwiXCIgfSB9KTtcbiAgY29uc3QgZmluZGluZ3MgPSBydW5LZXlEb2N0b3IoYXV0aCk7XG4gIGNvbnN0IGVtcHR5RmluZGluZyA9IGZpbmRpbmdzLmZpbmQoKGYpID0+IGYubWVzc2FnZS5pbmNsdWRlcyhcImVtcHR5IGtleVwiKSk7XG4gIGFzc2VydC5vayhlbXB0eUZpbmRpbmcsIFwic2hvdWxkIGZpbmQgZW1wdHkga2V5IHdhcm5pbmdcIik7XG4gIGFzc2VydC5lcXVhbChlbXB0eUZpbmRpbmc/LnNldmVyaXR5LCBcIndhcm5pbmdcIik7XG59KTtcblxudGVzdChcInJ1bktleURvY3RvciByZXBvcnRzIGV4cGlyZWQgT0F1dGhcIiwgKCkgPT4ge1xuICBjb25zdCBhdXRoID0gbWFrZUF1dGgoe1xuICAgIGFudGhyb3BpYzogeyB0eXBlOiBcIm9hdXRoXCIsIGFjY2VzczogXCJ0XCIsIHJlZnJlc2g6IFwiclwiLCBleHBpcmVzOiBEYXRlLm5vdygpIC0gMTBfMDAwIH0sXG4gIH0pO1xuICBjb25zdCBmaW5kaW5ncyA9IHJ1bktleURvY3RvcihhdXRoKTtcbiAgY29uc3Qgb2F1dGhGaW5kaW5nID0gZmluZGluZ3MuZmluZCgoZikgPT4gZi5tZXNzYWdlLmluY2x1ZGVzKFwiZXhwaXJlZFwiKSk7XG4gIGFzc2VydC5vayhvYXV0aEZpbmRpbmcsIFwic2hvdWxkIGZpbmQgZXhwaXJlZCBPQXV0aCB3YXJuaW5nXCIpO1xuICBhc3NlcnQuZXF1YWwob2F1dGhGaW5kaW5nPy5zZXZlcml0eSwgXCJ3YXJuaW5nXCIpO1xufSk7XG5cbnRlc3QoXCJydW5LZXlEb2N0b3IgcmVwb3J0cyBzb29uLXRvLWV4cGlyZSBPQXV0aCBhcyBpbmZvXCIsICgpID0+IHtcbiAgY29uc3QgYXV0aCA9IG1ha2VBdXRoKHtcbiAgICBhbnRocm9waWM6IHsgdHlwZTogXCJvYXV0aFwiLCBhY2Nlc3M6IFwidFwiLCByZWZyZXNoOiBcInJcIiwgZXhwaXJlczogRGF0ZS5ub3coKSArIDIgKiA2MF8wMDAgfSxcbiAgfSk7XG4gIGNvbnN0IGZpbmRpbmdzID0gcnVuS2V5RG9jdG9yKGF1dGgpO1xuICBjb25zdCBvYXV0aEZpbmRpbmcgPSBmaW5kaW5ncy5maW5kKChmKSA9PiBmLm1lc3NhZ2UuaW5jbHVkZXMoXCJleHBpcmVzIGluXCIpKTtcbiAgYXNzZXJ0Lm9rKG9hdXRoRmluZGluZywgXCJzaG91bGQgZmluZCBleHBpcmluZyBPQXV0aCBpbmZvXCIpO1xuICBhc3NlcnQuZXF1YWwob2F1dGhGaW5kaW5nPy5zZXZlcml0eSwgXCJpbmZvXCIpO1xufSk7XG5cbnRlc3QoXCJydW5LZXlEb2N0b3IgcmVwb3J0cyBtaXNzaW5nIExMTSBwcm92aWRlclwiLCAoKSA9PiB7XG4gIGNvbnN0IGxsbUVudlZhcnMgPSBbXG4gICAgXCJBTlRIUk9QSUNfQVBJX0tFWVwiLCBcIkFOVEhST1BJQ19PQVVUSF9UT0tFTlwiLCBcIk9QRU5BSV9BUElfS0VZXCIsXG4gICAgXCJHRU1JTklfQVBJX0tFWVwiLCBcIkdST1FfQVBJX0tFWVwiLCBcIlhBSV9BUElfS0VZXCIsIFwiT1BFTlJPVVRFUl9BUElfS0VZXCIsXG4gICAgXCJNSVNUUkFMX0FQSV9LRVlcIiwgXCJHSVRIVUJfVE9LRU5cIiwgXCJHSF9UT0tFTlwiLCBcIkNPUElMT1RfR0lUSFVCX1RPS0VOXCIsXG4gICAgXCJPTExBTUFfQVBJX0tFWVwiLCBcIkNVU1RPTV9PUEVOQUlfQVBJX0tFWVwiLCBcIkNFUkVCUkFTX0FQSV9LRVlcIixcbiAgICBcIkFaVVJFX09QRU5BSV9BUElfS0VZXCIsXG4gIF07XG4gIGNvbnN0IHNhdmVkOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCB1bmRlZmluZWQ+ID0ge307XG4gIGZvciAoY29uc3QgdiBvZiBsbG1FbnZWYXJzKSB7XG4gICAgc2F2ZWRbdl0gPSBwcm9jZXNzLmVudlt2XTtcbiAgICBkZWxldGUgcHJvY2Vzcy5lbnZbdl07XG4gIH1cbiAgdHJ5IHtcbiAgICBjb25zdCBhdXRoID0gbWFrZUF1dGgoKTtcbiAgICBjb25zdCBmaW5kaW5ncyA9IHJ1bktleURvY3RvcihhdXRoKTtcbiAgICBjb25zdCBtaXNzaW5nTGxtID0gZmluZGluZ3MuZmluZCgoZikgPT4gZi5tZXNzYWdlLmluY2x1ZGVzKFwiTm8gTExNIHByb3ZpZGVyXCIpKTtcbiAgICBhc3NlcnQub2sobWlzc2luZ0xsbSwgXCJzaG91bGQgZmluZCBtaXNzaW5nIExMTSBlcnJvclwiKTtcbiAgICBhc3NlcnQuZXF1YWwobWlzc2luZ0xsbT8uc2V2ZXJpdHksIFwiZXJyb3JcIik7XG4gIH0gZmluYWxseSB7XG4gICAgZm9yIChjb25zdCBbaywgdl0gb2YgT2JqZWN0LmVudHJpZXMoc2F2ZWQpKSB7XG4gICAgICBpZiAodiAhPT0gdW5kZWZpbmVkKSBwcm9jZXNzLmVudltrXSA9IHY7XG4gICAgICBlbHNlIGRlbGV0ZSBwcm9jZXNzLmVudltrXTtcbiAgICB9XG4gIH1cbn0pO1xuXG50ZXN0KFwicnVuS2V5RG9jdG9yIGRvZXMgbm90IHJlcG9ydCBtaXNzaW5nIExMTSB3aGVuIG9uZSBpcyBjb25maWd1cmVkXCIsICgpID0+IHtcbiAgY29uc3QgYXV0aCA9IG1ha2VBdXRoKHsgYW50aHJvcGljOiB7IHR5cGU6IFwiYXBpX2tleVwiLCBrZXk6IFwic2stYW50LXRlc3RcIiB9IH0pO1xuICBjb25zdCBmaW5kaW5ncyA9IHJ1bktleURvY3RvcihhdXRoKTtcbiAgY29uc3QgbWlzc2luZ0xsbSA9IGZpbmRpbmdzLmZpbmQoKGYpID0+IGYubWVzc2FnZS5pbmNsdWRlcyhcIk5vIExMTSBwcm92aWRlclwiKSk7XG4gIGFzc2VydC5lcXVhbChtaXNzaW5nTGxtLCB1bmRlZmluZWQpO1xufSk7XG5cbnRlc3QoXCJydW5LZXlEb2N0b3IgcmVwb3J0cyBkdXBsaWNhdGUga2V5cyBhY3Jvc3MgcHJvdmlkZXJzXCIsICgpID0+IHtcbiAgY29uc3QgYXV0aCA9IG1ha2VBdXRoKHtcbiAgICBvcGVuYWk6IHsgdHlwZTogXCJhcGlfa2V5XCIsIGtleTogXCJzaGFyZWQta2V5LTEyM1wiIH0sXG4gICAgZ3JvcTogeyB0eXBlOiBcImFwaV9rZXlcIiwga2V5OiBcInNoYXJlZC1rZXktMTIzXCIgfSxcbiAgfSk7XG4gIGNvbnN0IGZpbmRpbmdzID0gcnVuS2V5RG9jdG9yKGF1dGgpO1xuICBjb25zdCBkdXBGaW5kaW5nID0gZmluZGluZ3MuZmluZCgoZikgPT4gZi5tZXNzYWdlLmluY2x1ZGVzKFwiU2FtZSBrZXkgdXNlZFwiKSk7XG4gIGFzc2VydC5vayhkdXBGaW5kaW5nLCBcInNob3VsZCBmaW5kIGR1cGxpY2F0ZSBrZXkgd2FybmluZ1wiKTtcbiAgYXNzZXJ0LmVxdWFsKGR1cEZpbmRpbmc/LnNldmVyaXR5LCBcIndhcm5pbmdcIik7XG59KTtcblxudGVzdChcInJ1bktleURvY3RvciByZXBvcnRzIGVudiB2YXIgY29uZmxpY3RzXCIsICgpID0+IHtcbiAgY29uc3Qgb3JpZ2luYWwgPSBwcm9jZXNzLmVudi5PUEVOQUlfQVBJX0tFWTtcbiAgcHJvY2Vzcy5lbnYuT1BFTkFJX0FQSV9LRVkgPSBcImVudi1rZXlcIjtcbiAgdHJ5IHtcbiAgICBjb25zdCBhdXRoID0gbWFrZUF1dGgoeyBvcGVuYWk6IHsgdHlwZTogXCJhcGlfa2V5XCIsIGtleTogXCJkaWZmZXJlbnQta2V5XCIgfSB9KTtcbiAgICBjb25zdCBmaW5kaW5ncyA9IHJ1bktleURvY3RvcihhdXRoKTtcbiAgICBjb25zdCBjb25mbGljdCA9IGZpbmRpbmdzLmZpbmQoKGYpID0+IGYubWVzc2FnZS5pbmNsdWRlcyhcImRpZmZlcnMgZnJvbSBhdXRoLmpzb25cIikpO1xuICAgIGFzc2VydC5vayhjb25mbGljdCwgXCJzaG91bGQgZmluZCBlbnYgdmFyIGNvbmZsaWN0XCIpO1xuICAgIGFzc2VydC5lcXVhbChjb25mbGljdD8uc2V2ZXJpdHksIFwid2FybmluZ1wiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBpZiAob3JpZ2luYWwgPT09IHVuZGVmaW5lZCkge1xuICAgICAgZGVsZXRlIHByb2Nlc3MuZW52Lk9QRU5BSV9BUElfS0VZO1xuICAgIH0gZWxzZSB7XG4gICAgICBwcm9jZXNzLmVudi5PUEVOQUlfQVBJX0tFWSA9IG9yaWdpbmFsO1xuICAgIH1cbiAgfVxufSk7XG5cbnRlc3QoXCJydW5LZXlEb2N0b3IgcmV0dXJucyBubyBpc3N1ZXMgd2hlbiBldmVyeXRoaW5nIGlzIGhlYWx0aHlcIiwgKCkgPT4ge1xuICBjb25zdCBhdXRoID0gbWFrZUF1dGgoeyBhbnRocm9waWM6IHsgdHlwZTogXCJhcGlfa2V5XCIsIGtleTogXCJzay1hbnQtaGVhbHRoeVwiIH0gfSk7XG4gIGNvbnN0IGZpbmRpbmdzID0gcnVuS2V5RG9jdG9yKGF1dGgpO1xuICBjb25zdCBub25GaWxlRmluZGluZ3MgPSBmaW5kaW5ncy5maWx0ZXIoKGYpID0+ICFmLm1lc3NhZ2UuaW5jbHVkZXMoXCJhdXRoLmpzb24gcGVybWlzc2lvbnNcIikpO1xuICBhc3NlcnQuZXF1YWwobm9uRmlsZUZpbmRpbmdzLmxlbmd0aCwgMCk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGZvcm1hdERvY3RvckZpbmRpbmdzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiZm9ybWF0RG9jdG9yRmluZGluZ3Mgc2hvd3MgYWxsLWNsZWFyIGZvciBubyBmaW5kaW5nc1wiLCAoKSA9PiB7XG4gIGNvbnN0IG91dHB1dCA9IGZvcm1hdERvY3RvckZpbmRpbmdzKFtdKTtcbiAgYXNzZXJ0Lm9rKG91dHB1dC5pbmNsdWRlcyhcIkFsbCBjaGVja3MgcGFzc2VkXCIpKTtcbn0pO1xuXG50ZXN0KFwiZm9ybWF0RG9jdG9yRmluZGluZ3Mgc2hvd3MgZmluZGluZ3Mgd2l0aCBhcHByb3ByaWF0ZSBpY29uc1wiLCAoKSA9PiB7XG4gIGNvbnN0IG91dHB1dCA9IGZvcm1hdERvY3RvckZpbmRpbmdzKFtcbiAgICB7IHNldmVyaXR5OiBcImVycm9yXCIsIG1lc3NhZ2U6IFwiTm8gTExNIHByb3ZpZGVyIGNvbmZpZ3VyZWRcIiB9LFxuICAgIHsgc2V2ZXJpdHk6IFwid2FybmluZ1wiLCBwcm92aWRlcjogXCJncm9xXCIsIG1lc3NhZ2U6IFwiRW1wdHkga2V5XCIgfSxcbiAgICB7IHNldmVyaXR5OiBcImZpeGVkXCIsIG1lc3NhZ2U6IFwiUGVybWlzc2lvbnMgZml4ZWRcIiB9LFxuICBdKTtcbiAgYXNzZXJ0Lm9rKG91dHB1dC5pbmNsdWRlcyhcIlx1MjcxN1wiKSk7XG4gIGFzc2VydC5vayhvdXRwdXQuaW5jbHVkZXMoXCJcdTI2QTBcIikpO1xuICBhc3NlcnQub2sob3V0cHV0LmluY2x1ZGVzKFwiXHUyNzEzXCIpKTtcbiAgYXNzZXJ0Lm9rKG91dHB1dC5pbmNsdWRlcyhcIjEgZXJyb3JcIikpO1xuICBhc3NlcnQub2sob3V0cHV0LmluY2x1ZGVzKFwiMSB3YXJuaW5nXCIpKTtcbiAgYXNzZXJ0Lm9rKG91dHB1dC5pbmNsdWRlcyhcIjEgZml4ZWRcIikpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBSZWdyZXNzaW9uICMzODkxIFx1MjAxNCBhbGliYWJhLWNvZGluZy1wbGFuIG1pc3NpbmcgZnJvbSBQUk9WSURFUl9SRUdJU1RSWSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbi8vXG4vLyBCZWZvcmUgdGhpcyBmaXgsIGBhbGliYWJhLWNvZGluZy1wbGFuYCB3YXMgbm90IGluIFBST1ZJREVSX1JFR0lTVFJZLCBjYXVzaW5nXG4vLyBgL2dzZCBrZXlzIGFkZCBhbGliYWJhLWNvZGluZy1wbGFuYCB0byBzaWxlbnRseSBmYWlsIChwcm92aWRlciBub3QgZm91bmQpLlxuLy8gYWxpYmFiYS1kYXNoc2NvcGUgaXMgdGhlIG5ldyBzdGFuZGFsb25lIHByb3ZpZGVyIGFkZGVkIGluIHRoZSBzYW1lIFBSLlxuXG50ZXN0KFwicmVncmVzc2lvbiAjMzg5MSBcdTIwMTQgYWxpYmFiYS1jb2RpbmctcGxhbiBpcyBpbiBQUk9WSURFUl9SRUdJU1RSWVwiLCAoKSA9PiB7XG4gIGNvbnN0IHByb3ZpZGVyID0gZmluZFByb3ZpZGVyKFwiYWxpYmFiYS1jb2RpbmctcGxhblwiKTtcbiAgYXNzZXJ0Lm9rKHByb3ZpZGVyLCBcImFsaWJhYmEtY29kaW5nLXBsYW4gbXVzdCBiZSBpbiBQUk9WSURFUl9SRUdJU1RSWSBmb3IgL2dzZCBrZXlzIGFkZCB0byB3b3JrXCIpO1xuICBhc3NlcnQuZXF1YWwocHJvdmlkZXIuaWQsIFwiYWxpYmFiYS1jb2RpbmctcGxhblwiKTtcbiAgYXNzZXJ0LmVxdWFsKHByb3ZpZGVyLmNhdGVnb3J5LCBcImxsbVwiKTtcbiAgYXNzZXJ0LmVxdWFsKHByb3ZpZGVyLmVudlZhciwgXCJBTElCQUJBX0FQSV9LRVlcIik7XG59KTtcblxudGVzdChcImFsaWJhYmEtZGFzaHNjb3BlIGlzIGluIFBST1ZJREVSX1JFR0lTVFJZXCIsICgpID0+IHtcbiAgY29uc3QgcHJvdmlkZXIgPSBmaW5kUHJvdmlkZXIoXCJhbGliYWJhLWRhc2hzY29wZVwiKTtcbiAgYXNzZXJ0Lm9rKHByb3ZpZGVyLCBcImFsaWJhYmEtZGFzaHNjb3BlIG11c3QgYmUgaW4gUFJPVklERVJfUkVHSVNUUlkgZm9yIC9nc2Qga2V5cyBhZGQgdG8gd29ya1wiKTtcbiAgYXNzZXJ0LmVxdWFsKHByb3ZpZGVyLmlkLCBcImFsaWJhYmEtZGFzaHNjb3BlXCIpO1xuICBhc3NlcnQuZXF1YWwocHJvdmlkZXIuY2F0ZWdvcnksIFwibGxtXCIpO1xuICBhc3NlcnQuZXF1YWwocHJvdmlkZXIuZW52VmFyLCBcIkRBU0hTQ09QRV9BUElfS0VZXCIpO1xufSk7XG5cbnRlc3QoXCJhbGliYWJhLWNvZGluZy1wbGFuIGFuZCBhbGliYWJhLWRhc2hzY29wZSBhcmUgc2VwYXJhdGUgcHJvdmlkZXJzIChkaWZmZXJlbnQgZW52IHZhcnMpXCIsICgpID0+IHtcbiAgY29uc3QgY29kaW5nUGxhbiA9IGZpbmRQcm92aWRlcihcImFsaWJhYmEtY29kaW5nLXBsYW5cIik7XG4gIGNvbnN0IGRhc2hzY29wZSA9IGZpbmRQcm92aWRlcihcImFsaWJhYmEtZGFzaHNjb3BlXCIpO1xuICBhc3NlcnQub2soY29kaW5nUGxhbiwgXCJhbGliYWJhLWNvZGluZy1wbGFuIG11c3QgZXhpc3RcIik7XG4gIGFzc2VydC5vayhkYXNoc2NvcGUsIFwiYWxpYmFiYS1kYXNoc2NvcGUgbXVzdCBleGlzdFwiKTtcbiAgYXNzZXJ0Lm5vdEVxdWFsKFxuICAgIGNvZGluZ1BsYW4uZW52VmFyLFxuICAgIGRhc2hzY29wZS5lbnZWYXIsXG4gICAgXCJhbGliYWJhLWNvZGluZy1wbGFuIGFuZCBhbGliYWJhLWRhc2hzY29wZSBtdXN0IHVzZSBkaWZmZXJlbnQgZW52IHZhcnNcIixcbiAgKTtcbn0pO1xuXG50ZXN0KFwiZ2V0QWxsS2V5U3RhdHVzZXMgaW5jbHVkZXMgYWxpYmFiYS1jb2RpbmctcGxhblwiLCAoKSA9PiB7XG4gIGNvbnN0IGF1dGggPSBtYWtlQXV0aCgpO1xuICBjb25zdCBzdGF0dXNlcyA9IGdldEFsbEtleVN0YXR1c2VzKGF1dGgpO1xuICBjb25zdCBmb3VuZCA9IHN0YXR1c2VzLmZpbmQoKHMpID0+IHMucHJvdmlkZXIuaWQgPT09IFwiYWxpYmFiYS1jb2RpbmctcGxhblwiKTtcbiAgYXNzZXJ0Lm9rKGZvdW5kLCBcImdldEFsbEtleVN0YXR1c2VzIG11c3QgaW5jbHVkZSBhbGliYWJhLWNvZGluZy1wbGFuXCIpO1xufSk7XG5cbnRlc3QoXCJnZXRBbGxLZXlTdGF0dXNlcyBpbmNsdWRlcyBhbGliYWJhLWRhc2hzY29wZVwiLCAoKSA9PiB7XG4gIGNvbnN0IGF1dGggPSBtYWtlQXV0aCgpO1xuICBjb25zdCBzdGF0dXNlcyA9IGdldEFsbEtleVN0YXR1c2VzKGF1dGgpO1xuICBjb25zdCBmb3VuZCA9IHN0YXR1c2VzLmZpbmQoKHMpID0+IHMucHJvdmlkZXIuaWQgPT09IFwiYWxpYmFiYS1kYXNoc2NvcGVcIik7XG4gIGFzc2VydC5vayhmb3VuZCwgXCJnZXRBbGxLZXlTdGF0dXNlcyBtdXN0IGluY2x1ZGUgYWxpYmFiYS1kYXNoc2NvcGVcIik7XG59KTtcblxudGVzdChcImdldEFsbEtleVN0YXR1c2VzIGRldGVjdHMgREFTSFNDT1BFX0FQSV9LRVkgZm9yIGFsaWJhYmEtZGFzaHNjb3BlIChmYWlsdXJlIHBhdGg6IG1pc3Npbmcga2V5IHNob3dzIG5vdCBjb25maWd1cmVkKVwiLCAoKSA9PiB7XG4gIGNvbnN0IHNhdmVkID0gcHJvY2Vzcy5lbnYuREFTSFNDT1BFX0FQSV9LRVk7XG4gIGRlbGV0ZSBwcm9jZXNzLmVudi5EQVNIU0NPUEVfQVBJX0tFWTtcbiAgdHJ5IHtcbiAgICBjb25zdCBhdXRoID0gbWFrZUF1dGgoKTtcbiAgICBjb25zdCBzdGF0dXNlcyA9IGdldEFsbEtleVN0YXR1c2VzKGF1dGgpO1xuICAgIGNvbnN0IGZvdW5kID0gc3RhdHVzZXMuZmluZCgocykgPT4gcy5wcm92aWRlci5pZCA9PT0gXCJhbGliYWJhLWRhc2hzY29wZVwiKTtcbiAgICBhc3NlcnQub2soZm91bmQpO1xuICAgIGFzc2VydC5lcXVhbChmb3VuZC5jb25maWd1cmVkLCBmYWxzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKGZvdW5kLnNvdXJjZSwgXCJub25lXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIGlmIChzYXZlZCAhPT0gdW5kZWZpbmVkKSBwcm9jZXNzLmVudi5EQVNIU0NPUEVfQVBJX0tFWSA9IHNhdmVkO1xuICB9XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxtQkFBbUI7QUFDNUI7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUVQLFNBQVMsU0FBUyxPQUE0QixDQUFDLEdBQWdCO0FBQzdELFNBQU8sWUFBWSxTQUFTLElBQUk7QUFDbEM7QUFJQSxLQUFLLDZEQUE2RCxNQUFNO0FBQ3RFLFNBQU8sTUFBTSxRQUFRLCtCQUErQixHQUFHLGFBQWE7QUFDdEUsQ0FBQztBQUVELEtBQUssd0RBQXdELE1BQU07QUFDakUsU0FBTyxNQUFNLFFBQVEsVUFBVSxHQUFHLFNBQVM7QUFDN0MsQ0FBQztBQUVELEtBQUssNENBQTRDLE1BQU07QUFDckQsU0FBTyxNQUFNLFFBQVEsRUFBRSxHQUFHLFNBQVM7QUFDckMsQ0FBQztBQUVELEtBQUssOENBQThDLE1BQU07QUFDdkQsU0FBTyxNQUFNLFFBQVEsSUFBSSxHQUFHLFNBQVM7QUFDdkMsQ0FBQztBQUVELEtBQUssb0NBQW9DLE1BQU07QUFDN0MsU0FBTyxNQUFNLFFBQVEsY0FBYyxHQUFHLGFBQWE7QUFDckQsQ0FBQztBQUlELEtBQUssa0NBQWtDLE1BQU07QUFDM0MsU0FBTyxNQUFNLGVBQWUsR0FBTSxHQUFHLEtBQUs7QUFDNUMsQ0FBQztB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
