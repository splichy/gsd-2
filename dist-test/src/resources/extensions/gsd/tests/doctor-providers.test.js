import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, chmodSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import {
  runProviderChecks,
  formatProviderReport,
  summariseProviderIssues
} from "../doctor-providers.js";
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === void 0) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === void 0) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
function withCwd(nextCwd, fn) {
  const saved = process.cwd();
  process.chdir(nextCwd);
  try {
    fn();
  } finally {
    process.chdir(saved);
  }
}
const PRESENT_TEST_VALUE = "configured";
test("formatProviderReport returns fallback for empty results", () => {
  const out = formatProviderReport([]);
  assert.equal(out, "No provider checks run.");
});
test("formatProviderReport shows ok icon for ok status", () => {
  const results = [{
    name: "anthropic",
    label: "Anthropic (Claude)",
    category: "llm",
    status: "ok",
    message: "Anthropic (Claude) \u2014 key present (env)",
    required: true
  }];
  const out = formatProviderReport(results);
  assert.ok(out.includes("\u2713"), "should include checkmark for ok");
  assert.ok(out.includes("Anthropic"), "should include provider name");
});
test("formatProviderReport shows error icon and detail for error status", () => {
  const results = [{
    name: "anthropic",
    label: "Anthropic (Claude)",
    category: "llm",
    status: "error",
    message: "Anthropic (Claude) \u2014 no API key found",
    detail: "Set ANTHROPIC_API_KEY or run /gsd keys",
    required: true
  }];
  const out = formatProviderReport(results);
  assert.ok(out.includes("\u2717"), "should include cross for error");
  assert.ok(out.includes("ANTHROPIC_API_KEY"), "should include detail");
});
test("formatProviderReport shows warning icon for warning status", () => {
  const results = [{
    name: "slack_bot",
    label: "Slack Bot",
    category: "remote",
    status: "warning",
    message: "Slack Bot \u2014 channel configured but token not found",
    required: true
  }];
  const out = formatProviderReport(results);
  assert.ok(out.includes("\u26A0"), "should include warning icon");
});
test("formatProviderReport groups by category", () => {
  const results = [
    { name: "anthropic", label: "Anthropic", category: "llm", status: "ok", message: "ok", required: true },
    { name: "brave", label: "Brave Search", category: "search", status: "unconfigured", message: "not configured", required: false }
  ];
  const out = formatProviderReport(results);
  assert.ok(out.includes("LLM Providers"), "should have LLM section");
  assert.ok(out.includes("Search"), "should have Search section");
});
test("formatProviderReport omits detail for ok status", () => {
  const results = [{
    name: "openai",
    label: "OpenAI",
    category: "llm",
    status: "ok",
    message: "OpenAI \u2014 key present (env)",
    detail: "should not appear",
    required: true
  }];
  const out = formatProviderReport(results);
  assert.ok(!out.includes("should not appear"), "detail should not show for ok");
});
test("summariseProviderIssues returns null when no required issues", () => {
  const results = [
    { name: "anthropic", label: "Anthropic", category: "llm", status: "ok", message: "ok", required: true },
    { name: "brave", label: "Brave", category: "search", status: "unconfigured", message: "not configured", required: false }
  ];
  assert.equal(summariseProviderIssues(results), null);
});
test("summariseProviderIssues returns error summary for missing required key", () => {
  const results = [{
    name: "anthropic",
    label: "Anthropic (Claude)",
    category: "llm",
    status: "error",
    message: "no key",
    required: true
  }];
  const summary = summariseProviderIssues(results);
  assert.ok(summary !== null, "should return a summary");
  assert.ok(summary.includes("Anthropic"), "should name the provider");
  assert.ok(summary.includes("\u2717"), "should use error icon");
});
test("summariseProviderIssues returns warning for backed-off required provider", () => {
  const results = [{
    name: "anthropic",
    label: "Anthropic (Claude)",
    category: "llm",
    status: "warning",
    message: "backed off",
    required: true
  }];
  const summary = summariseProviderIssues(results);
  assert.ok(summary !== null, "should return summary");
  assert.ok(summary.includes("\u26A0"), "should use warning icon");
});
test("summariseProviderIssues appends count when multiple issues", () => {
  const results = [
    { name: "anthropic", label: "Anthropic", category: "llm", status: "error", message: "err", required: true },
    { name: "openai", label: "OpenAI", category: "llm", status: "error", message: "err", required: true },
    { name: "google", label: "Google", category: "llm", status: "error", message: "err", required: true }
  ];
  const summary = summariseProviderIssues(results);
  assert.ok(summary.includes("+2 more"), "should show overflow count");
});
test("summariseProviderIssues ignores unconfigured optional providers", () => {
  const results = [
    { name: "anthropic", label: "Anthropic", category: "llm", status: "ok", message: "ok", required: true },
    { name: "brave", label: "Brave", category: "search", status: "unconfigured", message: "nc", required: false },
    { name: "tavily", label: "Tavily", category: "search", status: "unconfigured", message: "nc", required: false }
  ];
  assert.equal(summariseProviderIssues(results), null, "optional missing providers should not raise issue");
});
test("runProviderChecks detects Anthropic key from ANTHROPIC_API_KEY env var", () => {
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-env-test-")));
  withEnv({ ANTHROPIC_API_KEY: "sk-ant-test-key", ANTHROPIC_OAUTH_TOKEN: void 0, HOME: tmpHome }, () => {
    try {
      const results = runProviderChecks();
      const anthropic = results.find((r) => r.name === "anthropic");
      assert.ok(anthropic, "anthropic result should exist");
      assert.equal(anthropic.status, "ok", "should be ok when env var set");
      assert.ok(anthropic.message.includes("env"), "should report env source");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
test("runProviderChecks returns error for Anthropic when no key present", () => {
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-test-")));
  withEnv({
    ANTHROPIC_API_KEY: void 0,
    ANTHROPIC_OAUTH_TOKEN: void 0,
    // Clear cross-provider routing env vars (GitHub Copilot can serve Claude models)
    COPILOT_GITHUB_TOKEN: void 0,
    GH_TOKEN: void 0,
    GITHUB_TOKEN: void 0,
    HOME: tmpHome,
    // Use a PATH that contains no AI CLI binaries (claude, codex, gemini, etc.)
    // so the claude-code route is not considered available
    PATH: tmpHome
  }, () => {
    try {
      const results = runProviderChecks();
      const anthropic = results.find((r) => r.name === "anthropic");
      assert.ok(anthropic, "anthropic should be present (default required)");
      assert.equal(anthropic.status, "error", "should be error when no key");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
test("runProviderChecks optional providers have required=false", () => {
  const results = runProviderChecks();
  const optional = results.filter((r) => ["brave", "tavily", "jina", "context7"].includes(r.name));
  for (const r of optional) {
    assert.equal(r.required, false, `${r.name} should not be required`);
  }
});
test("runProviderChecks optional providers show unconfigured when no key", () => {
  withEnv(
    { BRAVE_API_KEY: void 0, TAVILY_API_KEY: void 0, JINA_API_KEY: void 0, CONTEXT7_API_KEY: void 0 },
    () => {
      const origHome = process.env.HOME;
      process.env.HOME = mkdtempSync(join(tmpdir(), "gsd-providers-test-"));
      try {
        const results = runProviderChecks();
        const brave = results.find((r) => r.name === "brave");
        assert.ok(brave, "brave should be present");
        assert.equal(brave.status, "unconfigured", "should be unconfigured");
      } finally {
        rmSync(process.env.HOME, { recursive: true, force: true });
        process.env.HOME = origHome;
      }
    }
  );
});
test("runProviderChecks optional providers show ok when key set", () => {
  withEnv({ BRAVE_API_KEY: "test-brave-key" }, () => {
    const results = runProviderChecks();
    const brave = results.find((r) => r.name === "brave");
    assert.ok(brave, "brave should be present");
    assert.equal(brave.status, "ok", "should be ok when env var set");
  });
});
test("runProviderChecks detects key from auth.json", () => {
  withEnv({ ANTHROPIC_API_KEY: void 0 }, () => {
    const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-test-")));
    const agentDir = join(tmpHome, ".gsd", "agent");
    mkdirSync(agentDir, { recursive: true });
    const authData = {
      anthropic: { type: "api_key", key: "sk-ant-from-auth-json" }
    };
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify(authData));
    withEnv({ HOME: tmpHome }, () => {
      const results = runProviderChecks();
      const anthropic = results.find((r) => r.name === "anthropic");
      assert.ok(anthropic, "anthropic should be present");
      assert.equal(anthropic.status, "ok", "should be ok with auth.json key");
      assert.ok(anthropic.message.includes("auth.json"), "should report auth.json source");
    });
    rmSync(tmpHome, { recursive: true, force: true });
  });
});
test("runProviderChecks ignores empty placeholder keys in auth.json", () => {
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-test-")));
  const agentDir = join(tmpHome, ".gsd", "agent");
  mkdirSync(agentDir, { recursive: true });
  const authData = {
    anthropic: { type: "api_key", key: "" }
  };
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify(authData));
  withEnv({
    ANTHROPIC_API_KEY: void 0,
    ANTHROPIC_OAUTH_TOKEN: void 0,
    COPILOT_GITHUB_TOKEN: void 0,
    GH_TOKEN: void 0,
    GITHUB_TOKEN: void 0,
    HOME: tmpHome,
    // Exclude AI CLI binaries so the claude-code route is not considered available
    PATH: tmpHome
  }, () => {
    const results = runProviderChecks();
    const anthropic = results.find((r) => r.name === "anthropic");
    assert.ok(anthropic, "anthropic should be present");
    assert.equal(anthropic.status, "error", "empty placeholder key should count as not configured");
  });
  rmSync(tmpHome, { recursive: true, force: true });
});
test("runProviderChecks detects custom provider keys from models.json", () => {
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-custom-home-")));
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-custom-repo-")));
  const agentDir = join(tmpHome, ".gsd", "agent");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(repo, ".gsd"), { recursive: true });
  writeFileSync(
    join(repo, ".gsd", "PREFERENCES.md"),
    [
      "---",
      "models:",
      "  execution:",
      "    model: custom-model",
      "    provider: custom-provider",
      "---",
      ""
    ].join("\n")
  );
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "custom-provider": {
        api: "openai-completions",
        apiKey: "x",
        baseUrl: "https://example.invalid/v1",
        models: [{ id: "custom-model", name: "Custom Model" }]
      }
    }
  }));
  withEnv({
    HOME: tmpHome,
    CUSTOM_PROVIDER_API_KEY: void 0,
    PATH: tmpHome
  }, () => {
    withCwd(repo, () => {
      const results = runProviderChecks();
      const custom = results.find((r) => r.name === "custom-provider");
      assert.ok(custom, "custom provider result should exist");
      assert.equal(custom.status, "ok", "models.json apiKey should satisfy custom provider auth");
      assert.ok(custom.message.includes("models.json"), "should report models.json source");
      assert.equal(summariseProviderIssues(results), null, "custom models.json key should not raise dashboard warning");
    });
  });
  rmSync(repo, { recursive: true, force: true });
  rmSync(tmpHome, { recursive: true, force: true });
});
test("runProviderChecks reports missing custom provider key without models.json apiKey", () => {
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-custom-missing-home-")));
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-custom-missing-repo-")));
  mkdirSync(join(repo, ".gsd"), { recursive: true });
  writeFileSync(
    join(repo, ".gsd", "PREFERENCES.md"),
    [
      "---",
      "models:",
      "  execution: custom-provider/custom-model",
      "---",
      ""
    ].join("\n")
  );
  withEnv({
    HOME: tmpHome,
    CUSTOM_PROVIDER_API_KEY: void 0,
    PATH: tmpHome
  }, () => {
    withCwd(repo, () => {
      const results = runProviderChecks();
      const custom = results.find((r) => r.name === "custom-provider");
      assert.ok(custom, "provider-qualified custom model should be checked");
      assert.equal(custom.status, "error", "missing custom provider key should still be reported");
    });
  });
  rmSync(repo, { recursive: true, force: true });
  rmSync(tmpHome, { recursive: true, force: true });
});
test("runProviderChecks reports ok for Anthropic when GitHub Copilot env var is set", () => {
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-copilot-test-")));
  withEnv({
    ANTHROPIC_API_KEY: void 0,
    ANTHROPIC_OAUTH_TOKEN: void 0,
    COPILOT_GITHUB_TOKEN: PRESENT_TEST_VALUE,
    GH_TOKEN: void 0,
    GITHUB_TOKEN: void 0,
    HOME: tmpHome
  }, () => {
    try {
      const results = runProviderChecks();
      const anthropic = results.find((r) => r.name === "anthropic");
      assert.ok(anthropic, "anthropic result should exist");
      assert.equal(anthropic.status, "ok", "should be ok when Copilot auth is available");
      assert.ok(anthropic.message.includes("GitHub Copilot"), "should mention cross-provider source");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
test("runProviderChecks reports ok for Anthropic via GITHUB_TOKEN cross-provider routing", () => {
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-ghtoken-test-")));
  withEnv({
    ANTHROPIC_API_KEY: void 0,
    ANTHROPIC_OAUTH_TOKEN: void 0,
    COPILOT_GITHUB_TOKEN: void 0,
    GH_TOKEN: void 0,
    GITHUB_TOKEN: PRESENT_TEST_VALUE,
    HOME: tmpHome
  }, () => {
    try {
      const results = runProviderChecks();
      const anthropic = results.find((r) => r.name === "anthropic");
      assert.ok(anthropic, "anthropic result should exist");
      assert.equal(anthropic.status, "ok", "should be ok when GITHUB_TOKEN provides Copilot access");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
test("runProviderChecks detects ANTHROPIC_OAUTH_TOKEN as valid Anthropic auth", () => {
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-oauth-test-")));
  withEnv({
    ANTHROPIC_API_KEY: void 0,
    ANTHROPIC_OAUTH_TOKEN: PRESENT_TEST_VALUE,
    COPILOT_GITHUB_TOKEN: void 0,
    GH_TOKEN: void 0,
    GITHUB_TOKEN: void 0,
    HOME: tmpHome
  }, () => {
    try {
      const results = runProviderChecks();
      const anthropic = results.find((r) => r.name === "anthropic");
      assert.ok(anthropic, "anthropic result should exist");
      assert.equal(anthropic.status, "ok", "should be ok when ANTHROPIC_OAUTH_TOKEN is set");
      assert.ok(anthropic.message.includes("env"), "should report env source");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
test("runProviderChecks reports ok via Copilot auth.json for Anthropic", () => {
  withEnv({
    ANTHROPIC_API_KEY: void 0,
    ANTHROPIC_OAUTH_TOKEN: void 0,
    COPILOT_GITHUB_TOKEN: void 0,
    GH_TOKEN: void 0,
    GITHUB_TOKEN: void 0
  }, () => {
    const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-copilot-auth-test-")));
    const agentDir = join(tmpHome, ".gsd", "agent");
    mkdirSync(agentDir, { recursive: true });
    const authData = {
      "github-copilot": { type: "oauth", apiKey: "ghu_copilot-key", expires: Date.now() + 36e5 }
    };
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify(authData));
    withEnv({ HOME: tmpHome }, () => {
      const results = runProviderChecks();
      const anthropic = results.find((r) => r.name === "anthropic");
      assert.ok(anthropic, "anthropic result should exist");
      assert.equal(anthropic.status, "ok", "should be ok when Copilot is authenticated in auth.json");
      assert.ok(anthropic.message.includes("GitHub Copilot"), "should mention Copilot as source");
    });
    rmSync(tmpHome, { recursive: true, force: true });
  });
});
test("runProviderChecks uses provider-qualified anthropic-vertex model IDs", () => {
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-vertex-prefix-home-")));
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-vertex-prefix-repo-")));
  mkdirSync(join(repo, ".gsd"), { recursive: true });
  writeFileSync(
    join(repo, ".gsd", "PREFERENCES.md"),
    [
      "---",
      "models:",
      "  execution: anthropic-vertex/claude-sonnet-4-6",
      "---",
      ""
    ].join("\n")
  );
  withEnv({
    HOME: tmpHome,
    ANTHROPIC_API_KEY: void 0,
    ANTHROPIC_OAUTH_TOKEN: void 0,
    ANTHROPIC_VERTEX_PROJECT_ID: "vertex-project"
  }, () => {
    withCwd(repo, () => {
      const results = runProviderChecks();
      const vertex = results.find((r) => r.name === "anthropic-vertex");
      const anthropic = results.find((r) => r.name === "anthropic");
      assert.ok(vertex, "anthropic-vertex result should exist");
      assert.equal(vertex.status, "ok", "should accept ANTHROPIC_VERTEX_PROJECT_ID as configured");
      assert.ok(!anthropic || !anthropic.required, "plain anthropic should not be required for anthropic-vertex config");
    });
  });
  rmSync(repo, { recursive: true, force: true });
  rmSync(tmpHome, { recursive: true, force: true });
});
test("runProviderChecks uses object provider field for anthropic-vertex models", () => {
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-vertex-provider-home-")));
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-vertex-provider-repo-")));
  mkdirSync(join(repo, ".gsd"), { recursive: true });
  writeFileSync(
    join(repo, ".gsd", "PREFERENCES.md"),
    [
      "---",
      "models:",
      "  execution:",
      "    model: claude-sonnet-4-6",
      "    provider: anthropic-vertex",
      "---",
      ""
    ].join("\n")
  );
  withEnv({
    HOME: tmpHome,
    ANTHROPIC_API_KEY: void 0,
    ANTHROPIC_OAUTH_TOKEN: void 0,
    ANTHROPIC_VERTEX_PROJECT_ID: void 0
  }, () => {
    withCwd(repo, () => {
      const results = runProviderChecks();
      const vertex = results.find((r) => r.name === "anthropic-vertex");
      assert.ok(vertex, "anthropic-vertex result should exist");
      assert.equal(vertex.status, "error", "missing vertex config should be reported against anthropic-vertex");
      assert.ok(vertex.detail?.includes("ANTHROPIC_VERTEX_PROJECT_ID"), "should point to vertex setup");
    });
  });
  rmSync(repo, { recursive: true, force: true });
  rmSync(tmpHome, { recursive: true, force: true });
});
test("runProviderChecks reports ok for Google via google-gemini-cli auth.json (#2922)", () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-gemini-cli-repo-")));
  mkdirSync(join(repo, ".gsd"), { recursive: true });
  writeFileSync(
    join(repo, ".gsd", "PREFERENCES.md"),
    [
      "---",
      "models:",
      "  execution: gemini-2.5-pro",
      "---",
      ""
    ].join("\n")
  );
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-gemini-cli-home-")));
  const agentDir = join(tmpHome, ".gsd", "agent");
  mkdirSync(agentDir, { recursive: true });
  const authData = {
    "google-gemini-cli": { type: "oauth", expires: Date.now() + 36e5 }
  };
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify(authData));
  withEnv({
    HOME: tmpHome,
    GEMINI_API_KEY: void 0,
    GOOGLE_API_KEY: void 0
  }, () => {
    withCwd(repo, () => {
      const results = runProviderChecks();
      const google = results.find((r) => r.name === "google");
      assert.ok(google, "google result should exist");
      assert.equal(google.status, "ok", "should be ok when google-gemini-cli auth is available (#2922)");
      assert.ok(google.message.includes("Google Gemini CLI"), "should mention Gemini CLI as the source (#2922)");
    });
  });
  rmSync(repo, { recursive: true, force: true });
  rmSync(tmpHome, { recursive: true, force: true });
});
test("runProviderChecks reports ok for OpenAI via openai-codex auth.json (#2922)", () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-codex-repo-")));
  mkdirSync(join(repo, ".gsd"), { recursive: true });
  writeFileSync(
    join(repo, ".gsd", "PREFERENCES.md"),
    [
      "---",
      "models:",
      "  execution: gpt-4o",
      "---",
      ""
    ].join("\n")
  );
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-codex-home-")));
  const agentDir = join(tmpHome, ".gsd", "agent");
  mkdirSync(agentDir, { recursive: true });
  const authData = {
    "openai-codex": { type: "oauth", apiKey: "codex-token", expires: Date.now() + 36e5 }
  };
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify(authData));
  withEnv({
    HOME: tmpHome,
    OPENAI_API_KEY: void 0,
    // Clear Copilot env vars so it doesn't route through Copilot
    COPILOT_GITHUB_TOKEN: void 0,
    GH_TOKEN: void 0,
    GITHUB_TOKEN: void 0
  }, () => {
    withCwd(repo, () => {
      const results = runProviderChecks();
      const openai = results.find((r) => r.name === "openai");
      assert.ok(openai, "openai result should exist");
      assert.equal(openai.status, "ok", "should be ok when openai-codex auth is available (#2922)");
      assert.ok(openai.message.includes("Codex"), "should mention Codex as the source (#2922)");
    });
  });
  rmSync(repo, { recursive: true, force: true });
  rmSync(tmpHome, { recursive: true, force: true });
});
test("runProviderChecks reports ok for claude-code without any API key", () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-cc-repo-")));
  mkdirSync(join(repo, ".gsd"), { recursive: true });
  writeFileSync(
    join(repo, ".gsd", "PREFERENCES.md"),
    [
      "---",
      "models:",
      "  execution:",
      "    model: claude-sonnet-4-6",
      "    provider: claude-code",
      "---",
      ""
    ].join("\n")
  );
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-cc-home-")));
  withEnv({
    HOME: tmpHome,
    ANTHROPIC_API_KEY: void 0,
    ANTHROPIC_OAUTH_TOKEN: void 0
  }, () => {
    withCwd(repo, () => {
      const results = runProviderChecks();
      const cc = results.find((r) => r.name === "claude-code");
      assert.ok(cc, "claude-code result should exist");
      assert.equal(cc.status, "ok", "claude-code uses CLI auth \u2014 must be ok without API keys");
      assert.ok(cc.message.includes("CLI auth"), "should indicate CLI auth");
    });
  });
  rmSync(repo, { recursive: true, force: true });
  rmSync(tmpHome, { recursive: true, force: true });
});
test("runProviderChecks reports ok for Anthropic via claude-code binary in PATH", () => {
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-cc-route-home-")));
  const binDir = join(tmpHome, "bin");
  mkdirSync(binDir, { recursive: true });
  const fakeClaude = join(binDir, "claude");
  writeFileSync(fakeClaude, "#!/bin/sh\necho mock\n");
  chmodSync(fakeClaude, 493);
  withEnv({
    HOME: tmpHome,
    ANTHROPIC_API_KEY: void 0,
    ANTHROPIC_OAUTH_TOKEN: void 0,
    COPILOT_GITHUB_TOKEN: void 0,
    GH_TOKEN: void 0,
    GITHUB_TOKEN: void 0,
    PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`
  }, () => {
    try {
      const results = runProviderChecks();
      const anthropic = results.find((r) => r.name === "anthropic");
      assert.ok(anthropic, "anthropic result should exist");
      assert.equal(anthropic.status, "ok", "should be ok when claude CLI binary is in PATH");
      assert.ok(anthropic.message.toLowerCase().includes("claude"), "should mention claude-code as source");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
test("runProviderChecks detects claude.cmd in PATH on Windows (#4503)", { skip: process.platform !== "win32" }, () => {
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-cc-win-route-home-")));
  const binDir = join(tmpHome, "bin");
  mkdirSync(binDir, { recursive: true });
  const fakeClaudeCmd = join(binDir, "claude.cmd");
  writeFileSync(fakeClaudeCmd, "@echo off\r\necho mock\r\n");
  withEnv({
    HOME: tmpHome,
    ANTHROPIC_API_KEY: void 0,
    ANTHROPIC_OAUTH_TOKEN: void 0,
    COPILOT_GITHUB_TOKEN: void 0,
    GH_TOKEN: void 0,
    GITHUB_TOKEN: void 0,
    // Explicitly use ';' to mirror Windows PATH entries.
    PATH: `${binDir};${process.env.PATH ?? ""}`,
    PATHEXT: ".COM;.EXE;.BAT;.CMD"
  }, () => {
    try {
      const results = runProviderChecks();
      const anthropic = results.find((r) => r.name === "anthropic");
      assert.ok(anthropic, "anthropic result should exist");
      assert.equal(anthropic.status, "ok", "should be ok when claude.cmd is in PATH");
      assert.ok(anthropic.message.toLowerCase().includes("claude"), "should mention claude-code as source");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
test("runProviderChecks detects claude.exe in PATH on Windows (#4548)", { skip: process.platform !== "win32" }, () => {
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "gsd-providers-cc-exe-home-")));
  const binDir = join(tmpHome, "bin");
  mkdirSync(binDir, { recursive: true });
  const fakeClaudeExe = join(binDir, "claude.exe");
  writeFileSync(fakeClaudeExe, "");
  withEnv({
    HOME: tmpHome,
    ANTHROPIC_API_KEY: void 0,
    ANTHROPIC_OAUTH_TOKEN: void 0,
    COPILOT_GITHUB_TOKEN: void 0,
    GH_TOKEN: void 0,
    GITHUB_TOKEN: void 0,
    PATH: `${binDir};${process.env.PATH ?? ""}`,
    PATHEXT: ".COM;.EXE;.BAT;.CMD"
  }, () => {
    try {
      const results = runProviderChecks();
      const anthropic = results.find((r) => r.name === "anthropic");
      assert.ok(anthropic, "anthropic result should exist");
      assert.equal(anthropic.status, "ok", "should be ok when claude.exe is in PATH (#4548)");
      assert.ok(anthropic.message.toLowerCase().includes("claude"), "should mention claude-code as source");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
test("PROVIDER_ROUTES includes google-gemini-cli as route for google (#2922)", async () => {
  const { readFileSync: readFS } = await import("node:fs");
  const { dirname: dirn, join: joinPath } = await import("node:path");
  const { fileURLToPath: fileUrl } = await import("node:url");
  const __dir = dirn(fileUrl(import.meta.url));
  const src = readFS(joinPath(__dir, "..", "doctor-providers.ts"), "utf-8");
  assert.ok(
    src.includes('"google-gemini-cli"'),
    'PROVIDER_ROUTES must include "google-gemini-cli" as a route (#2922)'
  );
});
test("PROVIDER_ROUTES includes openai-codex as route for openai (#2922)", async () => {
  const { readFileSync: readFS } = await import("node:fs");
  const { dirname: dirn, join: joinPath } = await import("node:path");
  const { fileURLToPath: fileUrl } = await import("node:url");
  const __dir = dirn(fileUrl(import.meta.url));
  const src = readFS(joinPath(__dir, "..", "doctor-providers.ts"), "utf-8");
  assert.ok(
    src.includes('"openai-codex"'),
    'PROVIDER_ROUTES must include "openai-codex" as a route (#2922)'
  );
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9kb2N0b3ItcHJvdmlkZXJzLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogZG9jdG9yLXByb3ZpZGVycy50ZXN0LnRzIFx1MjAxNCBUZXN0cyBmb3IgcHJvdmlkZXIgJiBpbnRlZ3JhdGlvbiBoZWFsdGggY2hlY2tzLlxuICpcbiAqIFRlc3RzOlxuICogICAtIExMTSBwcm92aWRlciBrZXkgZGV0ZWN0aW9uIGZyb20gZW52IHZhcnNcbiAqICAgLSBMTE0gcHJvdmlkZXIga2V5IGRldGVjdGlvbiBmcm9tIGF1dGguanNvblxuICogICAtIE1pc3NpbmcgcmVxdWlyZWQgcHJvdmlkZXIgXHUyMTkyIGVycm9yIHN0YXR1c1xuICogICAtIEJhY2tlZC1vZmYgY3JlZGVudGlhbHMgXHUyMTkyIHdhcm5pbmcgc3RhdHVzXG4gKiAgIC0gUmVtb3RlIHF1ZXN0aW9ucyBjaGFubmVsIGNoZWNrIChjb25maWd1cmVkIHZzIG1pc3NpbmcgdG9rZW4pXG4gKiAgIC0gT3B0aW9uYWwgcHJvdmlkZXIgdW5jb25maWd1cmVkIHN0YXR1c1xuICogICAtIGZvcm1hdFByb3ZpZGVyUmVwb3J0IG91dHB1dFxuICogICAtIHN1bW1hcmlzZVByb3ZpZGVySXNzdWVzIGNvbXBhY3Rpb25cbiAqL1xuXG5pbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBta2RpclN5bmMsIHdyaXRlRmlsZVN5bmMsIHJtU3luYywgcmVhbHBhdGhTeW5jLCBjaG1vZFN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgZGVsaW1pdGVyLCBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcblxuaW1wb3J0IHtcbiAgcnVuUHJvdmlkZXJDaGVja3MsXG4gIGZvcm1hdFByb3ZpZGVyUmVwb3J0LFxuICBzdW1tYXJpc2VQcm92aWRlcklzc3VlcyxcbiAgdHlwZSBQcm92aWRlckNoZWNrUmVzdWx0LFxufSBmcm9tIFwiLi4vZG9jdG9yLXByb3ZpZGVycy50c1wiO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgSGVscGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gd2l0aEVudih2YXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCB1bmRlZmluZWQ+LCBmbjogKCkgPT4gdm9pZCk6IHZvaWQge1xuICBjb25zdCBzYXZlZDogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgdW5kZWZpbmVkPiA9IHt9O1xuICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBPYmplY3QuZW50cmllcyh2YXJzKSkge1xuICAgIHNhdmVkW2tdID0gcHJvY2Vzcy5lbnZba107XG4gICAgaWYgKHYgPT09IHVuZGVmaW5lZCkge1xuICAgICAgZGVsZXRlIHByb2Nlc3MuZW52W2tdO1xuICAgIH0gZWxzZSB7XG4gICAgICBwcm9jZXNzLmVudltrXSA9IHY7XG4gICAgfVxuICB9XG4gIHRyeSB7XG4gICAgZm4oKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBPYmplY3QuZW50cmllcyhzYXZlZCkpIHtcbiAgICAgIGlmICh2ID09PSB1bmRlZmluZWQpIGRlbGV0ZSBwcm9jZXNzLmVudltrXTtcbiAgICAgIGVsc2UgcHJvY2Vzcy5lbnZba10gPSB2O1xuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiB3aXRoQ3dkKG5leHRDd2Q6IHN0cmluZywgZm46ICgpID0+IHZvaWQpOiB2b2lkIHtcbiAgY29uc3Qgc2F2ZWQgPSBwcm9jZXNzLmN3ZCgpO1xuICBwcm9jZXNzLmNoZGlyKG5leHRDd2QpO1xuICB0cnkge1xuICAgIGZuKCk7XG4gIH0gZmluYWxseSB7XG4gICAgcHJvY2Vzcy5jaGRpcihzYXZlZCk7XG4gIH1cbn1cblxuY29uc3QgUFJFU0VOVF9URVNUX1ZBTFVFID0gXCJjb25maWd1cmVkXCI7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBmb3JtYXRQcm92aWRlclJlcG9ydCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcImZvcm1hdFByb3ZpZGVyUmVwb3J0IHJldHVybnMgZmFsbGJhY2sgZm9yIGVtcHR5IHJlc3VsdHNcIiwgKCkgPT4ge1xuICBjb25zdCBvdXQgPSBmb3JtYXRQcm92aWRlclJlcG9ydChbXSk7XG4gIGFzc2VydC5lcXVhbChvdXQsIFwiTm8gcHJvdmlkZXIgY2hlY2tzIHJ1bi5cIik7XG59KTtcblxudGVzdChcImZvcm1hdFByb3ZpZGVyUmVwb3J0IHNob3dzIG9rIGljb24gZm9yIG9rIHN0YXR1c1wiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdHM6IFByb3ZpZGVyQ2hlY2tSZXN1bHRbXSA9IFt7XG4gICAgbmFtZTogXCJhbnRocm9waWNcIixcbiAgICBsYWJlbDogXCJBbnRocm9waWMgKENsYXVkZSlcIixcbiAgICBjYXRlZ29yeTogXCJsbG1cIixcbiAgICBzdGF0dXM6IFwib2tcIixcbiAgICBtZXNzYWdlOiBcIkFudGhyb3BpYyAoQ2xhdWRlKSBcdTIwMTQga2V5IHByZXNlbnQgKGVudilcIixcbiAgICByZXF1aXJlZDogdHJ1ZSxcbiAgfV07XG4gIGNvbnN0IG91dCA9IGZvcm1hdFByb3ZpZGVyUmVwb3J0KHJlc3VsdHMpO1xuICBhc3NlcnQub2sob3V0LmluY2x1ZGVzKFwiXHUyNzEzXCIpLCBcInNob3VsZCBpbmNsdWRlIGNoZWNrbWFyayBmb3Igb2tcIik7XG4gIGFzc2VydC5vayhvdXQuaW5jbHVkZXMoXCJBbnRocm9waWNcIiksIFwic2hvdWxkIGluY2x1ZGUgcHJvdmlkZXIgbmFtZVwiKTtcbn0pO1xuXG50ZXN0KFwiZm9ybWF0UHJvdmlkZXJSZXBvcnQgc2hvd3MgZXJyb3IgaWNvbiBhbmQgZGV0YWlsIGZvciBlcnJvciBzdGF0dXNcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHRzOiBQcm92aWRlckNoZWNrUmVzdWx0W10gPSBbe1xuICAgIG5hbWU6IFwiYW50aHJvcGljXCIsXG4gICAgbGFiZWw6IFwiQW50aHJvcGljIChDbGF1ZGUpXCIsXG4gICAgY2F0ZWdvcnk6IFwibGxtXCIsXG4gICAgc3RhdHVzOiBcImVycm9yXCIsXG4gICAgbWVzc2FnZTogXCJBbnRocm9waWMgKENsYXVkZSkgXHUyMDE0IG5vIEFQSSBrZXkgZm91bmRcIixcbiAgICBkZXRhaWw6IFwiU2V0IEFOVEhST1BJQ19BUElfS0VZIG9yIHJ1biAvZ3NkIGtleXNcIixcbiAgICByZXF1aXJlZDogdHJ1ZSxcbiAgfV07XG4gIGNvbnN0IG91dCA9IGZvcm1hdFByb3ZpZGVyUmVwb3J0KHJlc3VsdHMpO1xuICBhc3NlcnQub2sob3V0LmluY2x1ZGVzKFwiXHUyNzE3XCIpLCBcInNob3VsZCBpbmNsdWRlIGNyb3NzIGZvciBlcnJvclwiKTtcbiAgYXNzZXJ0Lm9rKG91dC5pbmNsdWRlcyhcIkFOVEhST1BJQ19BUElfS0VZXCIpLCBcInNob3VsZCBpbmNsdWRlIGRldGFpbFwiKTtcbn0pO1xuXG50ZXN0KFwiZm9ybWF0UHJvdmlkZXJSZXBvcnQgc2hvd3Mgd2FybmluZyBpY29uIGZvciB3YXJuaW5nIHN0YXR1c1wiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdHM6IFByb3ZpZGVyQ2hlY2tSZXN1bHRbXSA9IFt7XG4gICAgbmFtZTogXCJzbGFja19ib3RcIixcbiAgICBsYWJlbDogXCJTbGFjayBCb3RcIixcbiAgICBjYXRlZ29yeTogXCJyZW1vdGVcIixcbiAgICBzdGF0dXM6IFwid2FybmluZ1wiLFxuICAgIG1lc3NhZ2U6IFwiU2xhY2sgQm90IFx1MjAxNCBjaGFubmVsIGNvbmZpZ3VyZWQgYnV0IHRva2VuIG5vdCBmb3VuZFwiLFxuICAgIHJlcXVpcmVkOiB0cnVlLFxuICB9XTtcbiAgY29uc3Qgb3V0ID0gZm9ybWF0UHJvdmlkZXJSZXBvcnQocmVzdWx0cyk7XG4gIGFzc2VydC5vayhvdXQuaW5jbHVkZXMoXCJcdTI2QTBcIiksIFwic2hvdWxkIGluY2x1ZGUgd2FybmluZyBpY29uXCIpO1xufSk7XG5cbnRlc3QoXCJmb3JtYXRQcm92aWRlclJlcG9ydCBncm91cHMgYnkgY2F0ZWdvcnlcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHRzOiBQcm92aWRlckNoZWNrUmVzdWx0W10gPSBbXG4gICAgeyBuYW1lOiBcImFudGhyb3BpY1wiLCBsYWJlbDogXCJBbnRocm9waWNcIiwgY2F0ZWdvcnk6IFwibGxtXCIsIHN0YXR1czogXCJva1wiLCBtZXNzYWdlOiBcIm9rXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgeyBuYW1lOiBcImJyYXZlXCIsIGxhYmVsOiBcIkJyYXZlIFNlYXJjaFwiLCBjYXRlZ29yeTogXCJzZWFyY2hcIiwgc3RhdHVzOiBcInVuY29uZmlndXJlZFwiLCBtZXNzYWdlOiBcIm5vdCBjb25maWd1cmVkXCIsIHJlcXVpcmVkOiBmYWxzZSB9LFxuICBdO1xuICBjb25zdCBvdXQgPSBmb3JtYXRQcm92aWRlclJlcG9ydChyZXN1bHRzKTtcbiAgYXNzZXJ0Lm9rKG91dC5pbmNsdWRlcyhcIkxMTSBQcm92aWRlcnNcIiksIFwic2hvdWxkIGhhdmUgTExNIHNlY3Rpb25cIik7XG4gIGFzc2VydC5vayhvdXQuaW5jbHVkZXMoXCJTZWFyY2hcIiksIFwic2hvdWxkIGhhdmUgU2VhcmNoIHNlY3Rpb25cIik7XG59KTtcblxudGVzdChcImZvcm1hdFByb3ZpZGVyUmVwb3J0IG9taXRzIGRldGFpbCBmb3Igb2sgc3RhdHVzXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0czogUHJvdmlkZXJDaGVja1Jlc3VsdFtdID0gW3tcbiAgICBuYW1lOiBcIm9wZW5haVwiLFxuICAgIGxhYmVsOiBcIk9wZW5BSVwiLFxuICAgIGNhdGVnb3J5OiBcImxsbVwiLFxuICAgIHN0YXR1czogXCJva1wiLFxuICAgIG1lc3NhZ2U6IFwiT3BlbkFJIFx1MjAxNCBrZXkgcHJlc2VudCAoZW52KVwiLFxuICAgIGRldGFpbDogXCJzaG91bGQgbm90IGFwcGVhclwiLFxuICAgIHJlcXVpcmVkOiB0cnVlLFxuICB9XTtcbiAgY29uc3Qgb3V0ID0gZm9ybWF0UHJvdmlkZXJSZXBvcnQocmVzdWx0cyk7XG4gIGFzc2VydC5vayghb3V0LmluY2x1ZGVzKFwic2hvdWxkIG5vdCBhcHBlYXJcIiksIFwiZGV0YWlsIHNob3VsZCBub3Qgc2hvdyBmb3Igb2tcIik7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHN1bW1hcmlzZVByb3ZpZGVySXNzdWVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwic3VtbWFyaXNlUHJvdmlkZXJJc3N1ZXMgcmV0dXJucyBudWxsIHdoZW4gbm8gcmVxdWlyZWQgaXNzdWVzXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0czogUHJvdmlkZXJDaGVja1Jlc3VsdFtdID0gW1xuICAgIHsgbmFtZTogXCJhbnRocm9waWNcIiwgbGFiZWw6IFwiQW50aHJvcGljXCIsIGNhdGVnb3J5OiBcImxsbVwiLCBzdGF0dXM6IFwib2tcIiwgbWVzc2FnZTogXCJva1wiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIHsgbmFtZTogXCJicmF2ZVwiLCBsYWJlbDogXCJCcmF2ZVwiLCBjYXRlZ29yeTogXCJzZWFyY2hcIiwgc3RhdHVzOiBcInVuY29uZmlndXJlZFwiLCBtZXNzYWdlOiBcIm5vdCBjb25maWd1cmVkXCIsIHJlcXVpcmVkOiBmYWxzZSB9LFxuICBdO1xuICBhc3NlcnQuZXF1YWwoc3VtbWFyaXNlUHJvdmlkZXJJc3N1ZXMocmVzdWx0cyksIG51bGwpO1xufSk7XG5cbnRlc3QoXCJzdW1tYXJpc2VQcm92aWRlcklzc3VlcyByZXR1cm5zIGVycm9yIHN1bW1hcnkgZm9yIG1pc3NpbmcgcmVxdWlyZWQga2V5XCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0czogUHJvdmlkZXJDaGVja1Jlc3VsdFtdID0gW3tcbiAgICBuYW1lOiBcImFudGhyb3BpY1wiLFxuICAgIGxhYmVsOiBcIkFudGhyb3BpYyAoQ2xhdWRlKVwiLFxuICAgIGNhdGVnb3J5OiBcImxsbVwiLFxuICAgIHN0YXR1czogXCJlcnJvclwiLFxuICAgIG1lc3NhZ2U6IFwibm8ga2V5XCIsXG4gICAgcmVxdWlyZWQ6IHRydWUsXG4gIH1dO1xuICBjb25zdCBzdW1tYXJ5ID0gc3VtbWFyaXNlUHJvdmlkZXJJc3N1ZXMocmVzdWx0cyk7XG4gIGFzc2VydC5vayhzdW1tYXJ5ICE9PSBudWxsLCBcInNob3VsZCByZXR1cm4gYSBzdW1tYXJ5XCIpO1xuICBhc3NlcnQub2soc3VtbWFyeSEuaW5jbHVkZXMoXCJBbnRocm9waWNcIiksIFwic2hvdWxkIG5hbWUgdGhlIHByb3ZpZGVyXCIpO1xuICBhc3NlcnQub2soc3VtbWFyeSEuaW5jbHVkZXMoXCJcdTI3MTdcIiksIFwic2hvdWxkIHVzZSBlcnJvciBpY29uXCIpO1xufSk7XG5cbnRlc3QoXCJzdW1tYXJpc2VQcm92aWRlcklzc3VlcyByZXR1cm5zIHdhcm5pbmcgZm9yIGJhY2tlZC1vZmYgcmVxdWlyZWQgcHJvdmlkZXJcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHRzOiBQcm92aWRlckNoZWNrUmVzdWx0W10gPSBbe1xuICAgIG5hbWU6IFwiYW50aHJvcGljXCIsXG4gICAgbGFiZWw6IFwiQW50aHJvcGljIChDbGF1ZGUpXCIsXG4gICAgY2F0ZWdvcnk6IFwibGxtXCIsXG4gICAgc3RhdHVzOiBcIndhcm5pbmdcIixcbiAgICBtZXNzYWdlOiBcImJhY2tlZCBvZmZcIixcbiAgICByZXF1aXJlZDogdHJ1ZSxcbiAgfV07XG4gIGNvbnN0IHN1bW1hcnkgPSBzdW1tYXJpc2VQcm92aWRlcklzc3VlcyhyZXN1bHRzKTtcbiAgYXNzZXJ0Lm9rKHN1bW1hcnkgIT09IG51bGwsIFwic2hvdWxkIHJldHVybiBzdW1tYXJ5XCIpO1xuICBhc3NlcnQub2soc3VtbWFyeSEuaW5jbHVkZXMoXCJcdTI2QTBcIiksIFwic2hvdWxkIHVzZSB3YXJuaW5nIGljb25cIik7XG59KTtcblxudGVzdChcInN1bW1hcmlzZVByb3ZpZGVySXNzdWVzIGFwcGVuZHMgY291bnQgd2hlbiBtdWx0aXBsZSBpc3N1ZXNcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHRzOiBQcm92aWRlckNoZWNrUmVzdWx0W10gPSBbXG4gICAgeyBuYW1lOiBcImFudGhyb3BpY1wiLCBsYWJlbDogXCJBbnRocm9waWNcIiwgY2F0ZWdvcnk6IFwibGxtXCIsIHN0YXR1czogXCJlcnJvclwiLCBtZXNzYWdlOiBcImVyclwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIHsgbmFtZTogXCJvcGVuYWlcIiwgICAgbGFiZWw6IFwiT3BlbkFJXCIsICAgIGNhdGVnb3J5OiBcImxsbVwiLCBzdGF0dXM6IFwiZXJyb3JcIiwgbWVzc2FnZTogXCJlcnJcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICB7IG5hbWU6IFwiZ29vZ2xlXCIsICAgIGxhYmVsOiBcIkdvb2dsZVwiLCAgICBjYXRlZ29yeTogXCJsbG1cIiwgc3RhdHVzOiBcImVycm9yXCIsIG1lc3NhZ2U6IFwiZXJyXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gIF07XG4gIGNvbnN0IHN1bW1hcnkgPSBzdW1tYXJpc2VQcm92aWRlcklzc3VlcyhyZXN1bHRzKTtcbiAgYXNzZXJ0Lm9rKHN1bW1hcnkhLmluY2x1ZGVzKFwiKzIgbW9yZVwiKSwgXCJzaG91bGQgc2hvdyBvdmVyZmxvdyBjb3VudFwiKTtcbn0pO1xuXG50ZXN0KFwic3VtbWFyaXNlUHJvdmlkZXJJc3N1ZXMgaWdub3JlcyB1bmNvbmZpZ3VyZWQgb3B0aW9uYWwgcHJvdmlkZXJzXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0czogUHJvdmlkZXJDaGVja1Jlc3VsdFtdID0gW1xuICAgIHsgbmFtZTogXCJhbnRocm9waWNcIiwgbGFiZWw6IFwiQW50aHJvcGljXCIsIGNhdGVnb3J5OiBcImxsbVwiLCAgICBzdGF0dXM6IFwib2tcIiwgICAgICAgICAgIG1lc3NhZ2U6IFwib2tcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICB7IG5hbWU6IFwiYnJhdmVcIiwgICAgIGxhYmVsOiBcIkJyYXZlXCIsICAgICBjYXRlZ29yeTogXCJzZWFyY2hcIiwgc3RhdHVzOiBcInVuY29uZmlndXJlZFwiLCBtZXNzYWdlOiBcIm5jXCIsIHJlcXVpcmVkOiBmYWxzZSB9LFxuICAgIHsgbmFtZTogXCJ0YXZpbHlcIiwgICAgbGFiZWw6IFwiVGF2aWx5XCIsICAgIGNhdGVnb3J5OiBcInNlYXJjaFwiLCBzdGF0dXM6IFwidW5jb25maWd1cmVkXCIsIG1lc3NhZ2U6IFwibmNcIiwgcmVxdWlyZWQ6IGZhbHNlIH0sXG4gIF07XG4gIGFzc2VydC5lcXVhbChzdW1tYXJpc2VQcm92aWRlcklzc3VlcyhyZXN1bHRzKSwgbnVsbCwgXCJvcHRpb25hbCBtaXNzaW5nIHByb3ZpZGVycyBzaG91bGQgbm90IHJhaXNlIGlzc3VlXCIpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBydW5Qcm92aWRlckNoZWNrcyBcdTIwMTQgZW52IHZhciBkZXRlY3Rpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJydW5Qcm92aWRlckNoZWNrcyBkZXRlY3RzIEFudGhyb3BpYyBrZXkgZnJvbSBBTlRIUk9QSUNfQVBJX0tFWSBlbnYgdmFyXCIsICgpID0+IHtcbiAgLy8gSXNvbGF0ZSBmcm9tIHJlYWwgSE9NRSBzbyBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMgcmV0dXJucyBudWxsIChkZWZhdWx0IFx1MjE5MiBhbnRocm9waWMpXG4gIC8vIGFuZCBhdXRoLmpzb24gbG9va3VwcyBoaXQgYW4gZW1wdHkgZGlyZWN0b3J5LlxuICBjb25zdCB0bXBIb21lID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXByb3ZpZGVycy1lbnYtdGVzdC1cIikpKTtcbiAgd2l0aEVudih7IEFOVEhST1BJQ19BUElfS0VZOiBcInNrLWFudC10ZXN0LWtleVwiLCBBTlRIUk9QSUNfT0FVVEhfVE9LRU46IHVuZGVmaW5lZCwgSE9NRTogdG1wSG9tZSB9LCAoKSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlc3VsdHMgPSBydW5Qcm92aWRlckNoZWNrcygpO1xuICAgICAgY29uc3QgYW50aHJvcGljID0gcmVzdWx0cy5maW5kKHIgPT4gci5uYW1lID09PSBcImFudGhyb3BpY1wiKTtcbiAgICAgIGFzc2VydC5vayhhbnRocm9waWMsIFwiYW50aHJvcGljIHJlc3VsdCBzaG91bGQgZXhpc3RcIik7XG4gICAgICBhc3NlcnQuZXF1YWwoYW50aHJvcGljIS5zdGF0dXMsIFwib2tcIiwgXCJzaG91bGQgYmUgb2sgd2hlbiBlbnYgdmFyIHNldFwiKTtcbiAgICAgIGFzc2VydC5vayhhbnRocm9waWMhLm1lc3NhZ2UuaW5jbHVkZXMoXCJlbnZcIiksIFwic2hvdWxkIHJlcG9ydCBlbnYgc291cmNlXCIpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModG1wSG9tZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG59KTtcblxudGVzdChcInJ1blByb3ZpZGVyQ2hlY2tzIHJldHVybnMgZXJyb3IgZm9yIEFudGhyb3BpYyB3aGVuIG5vIGtleSBwcmVzZW50XCIsICgpID0+IHtcbiAgY29uc3QgdG1wSG9tZSA9IHJlYWxwYXRoU3luYyhta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1wcm92aWRlcnMtdGVzdC1cIikpKTtcbiAgd2l0aEVudih7XG4gICAgQU5USFJPUElDX0FQSV9LRVk6IHVuZGVmaW5lZCxcbiAgICBBTlRIUk9QSUNfT0FVVEhfVE9LRU46IHVuZGVmaW5lZCxcbiAgICAvLyBDbGVhciBjcm9zcy1wcm92aWRlciByb3V0aW5nIGVudiB2YXJzIChHaXRIdWIgQ29waWxvdCBjYW4gc2VydmUgQ2xhdWRlIG1vZGVscylcbiAgICBDT1BJTE9UX0dJVEhVQl9UT0tFTjogdW5kZWZpbmVkLFxuICAgIEdIX1RPS0VOOiB1bmRlZmluZWQsXG4gICAgR0lUSFVCX1RPS0VOOiB1bmRlZmluZWQsXG4gICAgSE9NRTogdG1wSG9tZSxcbiAgICAvLyBVc2UgYSBQQVRIIHRoYXQgY29udGFpbnMgbm8gQUkgQ0xJIGJpbmFyaWVzIChjbGF1ZGUsIGNvZGV4LCBnZW1pbmksIGV0Yy4pXG4gICAgLy8gc28gdGhlIGNsYXVkZS1jb2RlIHJvdXRlIGlzIG5vdCBjb25zaWRlcmVkIGF2YWlsYWJsZVxuICAgIFBBVEg6IHRtcEhvbWUsXG4gIH0sICgpID0+IHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVzdWx0cyA9IHJ1blByb3ZpZGVyQ2hlY2tzKCk7XG4gICAgICBjb25zdCBhbnRocm9waWMgPSByZXN1bHRzLmZpbmQociA9PiByLm5hbWUgPT09IFwiYW50aHJvcGljXCIpO1xuICAgICAgYXNzZXJ0Lm9rKGFudGhyb3BpYywgXCJhbnRocm9waWMgc2hvdWxkIGJlIHByZXNlbnQgKGRlZmF1bHQgcmVxdWlyZWQpXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGFudGhyb3BpYyEuc3RhdHVzLCBcImVycm9yXCIsIFwic2hvdWxkIGJlIGVycm9yIHdoZW4gbm8ga2V5XCIpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModG1wSG9tZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG59KTtcblxudGVzdChcInJ1blByb3ZpZGVyQ2hlY2tzIG9wdGlvbmFsIHByb3ZpZGVycyBoYXZlIHJlcXVpcmVkPWZhbHNlXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0cyA9IHJ1blByb3ZpZGVyQ2hlY2tzKCk7XG4gIGNvbnN0IG9wdGlvbmFsID0gcmVzdWx0cy5maWx0ZXIociA9PiBbXCJicmF2ZVwiLCBcInRhdmlseVwiLCBcImppbmFcIiwgXCJjb250ZXh0N1wiXS5pbmNsdWRlcyhyLm5hbWUpKTtcbiAgZm9yIChjb25zdCByIG9mIG9wdGlvbmFsKSB7XG4gICAgYXNzZXJ0LmVxdWFsKHIucmVxdWlyZWQsIGZhbHNlLCBgJHtyLm5hbWV9IHNob3VsZCBub3QgYmUgcmVxdWlyZWRgKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJydW5Qcm92aWRlckNoZWNrcyBvcHRpb25hbCBwcm92aWRlcnMgc2hvdyB1bmNvbmZpZ3VyZWQgd2hlbiBubyBrZXlcIiwgKCkgPT4ge1xuICB3aXRoRW52KFxuICAgIHsgQlJBVkVfQVBJX0tFWTogdW5kZWZpbmVkLCBUQVZJTFlfQVBJX0tFWTogdW5kZWZpbmVkLCBKSU5BX0FQSV9LRVk6IHVuZGVmaW5lZCwgQ09OVEVYVDdfQVBJX0tFWTogdW5kZWZpbmVkIH0sXG4gICAgKCkgPT4ge1xuICAgICAgY29uc3Qgb3JpZ0hvbWUgPSBwcm9jZXNzLmVudi5IT01FO1xuICAgICAgcHJvY2Vzcy5lbnYuSE9NRSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXByb3ZpZGVycy10ZXN0LVwiKSk7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCByZXN1bHRzID0gcnVuUHJvdmlkZXJDaGVja3MoKTtcbiAgICAgICAgY29uc3QgYnJhdmUgPSByZXN1bHRzLmZpbmQociA9PiByLm5hbWUgPT09IFwiYnJhdmVcIik7XG4gICAgICAgIGFzc2VydC5vayhicmF2ZSwgXCJicmF2ZSBzaG91bGQgYmUgcHJlc2VudFwiKTtcbiAgICAgICAgYXNzZXJ0LmVxdWFsKGJyYXZlIS5zdGF0dXMsIFwidW5jb25maWd1cmVkXCIsIFwic2hvdWxkIGJlIHVuY29uZmlndXJlZFwiKTtcbiAgICAgIH0gZmluYWxseSB7XG4gICAgICAgIHJtU3luYyhwcm9jZXNzLmVudi5IT01FISwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgICAgICBwcm9jZXNzLmVudi5IT01FID0gb3JpZ0hvbWU7XG4gICAgICB9XG4gICAgfVxuICApO1xufSk7XG5cbnRlc3QoXCJydW5Qcm92aWRlckNoZWNrcyBvcHRpb25hbCBwcm92aWRlcnMgc2hvdyBvayB3aGVuIGtleSBzZXRcIiwgKCkgPT4ge1xuICB3aXRoRW52KHsgQlJBVkVfQVBJX0tFWTogXCJ0ZXN0LWJyYXZlLWtleVwiIH0sICgpID0+IHtcbiAgICBjb25zdCByZXN1bHRzID0gcnVuUHJvdmlkZXJDaGVja3MoKTtcbiAgICBjb25zdCBicmF2ZSA9IHJlc3VsdHMuZmluZChyID0+IHIubmFtZSA9PT0gXCJicmF2ZVwiKTtcbiAgICBhc3NlcnQub2soYnJhdmUsIFwiYnJhdmUgc2hvdWxkIGJlIHByZXNlbnRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGJyYXZlIS5zdGF0dXMsIFwib2tcIiwgXCJzaG91bGQgYmUgb2sgd2hlbiBlbnYgdmFyIHNldFwiKTtcbiAgfSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHJ1blByb3ZpZGVyQ2hlY2tzIFx1MjAxNCBhdXRoLmpzb24gZGV0ZWN0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwicnVuUHJvdmlkZXJDaGVja3MgZGV0ZWN0cyBrZXkgZnJvbSBhdXRoLmpzb25cIiwgKCkgPT4ge1xuICB3aXRoRW52KHsgQU5USFJPUElDX0FQSV9LRVk6IHVuZGVmaW5lZCB9LCAoKSA9PiB7XG4gICAgY29uc3QgdG1wSG9tZSA9IHJlYWxwYXRoU3luYyhta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1wcm92aWRlcnMtdGVzdC1cIikpKTtcbiAgICBjb25zdCBhZ2VudERpciA9IGpvaW4odG1wSG9tZSwgXCIuZ3NkXCIsIFwiYWdlbnRcIik7XG4gICAgbWtkaXJTeW5jKGFnZW50RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAgIC8vIEF1dGhTdG9yYWdlIHBlcnNpc3RzIGNyZWRlbnRpYWxzIHdpdGggcHJvdmlkZXIgSUQgYXMgdGhlIHRvcC1sZXZlbCBrZXk6XG4gICAgLy8geyBcImFudGhyb3BpY1wiOiB7IFwidHlwZVwiOiBcImFwaV9rZXlcIiwgXCJrZXlcIjogXCIuLi5cIiB9IH1cbiAgICBjb25zdCBhdXRoRGF0YSA9IHtcbiAgICAgIGFudGhyb3BpYzogeyB0eXBlOiBcImFwaV9rZXlcIiwga2V5OiBcInNrLWFudC1mcm9tLWF1dGgtanNvblwiIH0sXG4gICAgfTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oYWdlbnREaXIsIFwiYXV0aC5qc29uXCIpLCBKU09OLnN0cmluZ2lmeShhdXRoRGF0YSkpO1xuXG4gICAgd2l0aEVudih7IEhPTUU6IHRtcEhvbWUgfSwgKCkgPT4ge1xuICAgICAgY29uc3QgcmVzdWx0cyA9IHJ1blByb3ZpZGVyQ2hlY2tzKCk7XG4gICAgICBjb25zdCBhbnRocm9waWMgPSByZXN1bHRzLmZpbmQociA9PiByLm5hbWUgPT09IFwiYW50aHJvcGljXCIpO1xuICAgICAgYXNzZXJ0Lm9rKGFudGhyb3BpYywgXCJhbnRocm9waWMgc2hvdWxkIGJlIHByZXNlbnRcIik7XG4gICAgICBhc3NlcnQuZXF1YWwoYW50aHJvcGljIS5zdGF0dXMsIFwib2tcIiwgXCJzaG91bGQgYmUgb2sgd2l0aCBhdXRoLmpzb24ga2V5XCIpO1xuICAgICAgYXNzZXJ0Lm9rKGFudGhyb3BpYyEubWVzc2FnZS5pbmNsdWRlcyhcImF1dGguanNvblwiKSwgXCJzaG91bGQgcmVwb3J0IGF1dGguanNvbiBzb3VyY2VcIik7XG4gICAgfSk7XG5cbiAgICBybVN5bmModG1wSG9tZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcbn0pO1xuXG50ZXN0KFwicnVuUHJvdmlkZXJDaGVja3MgaWdub3JlcyBlbXB0eSBwbGFjZWhvbGRlciBrZXlzIGluIGF1dGguanNvblwiLCAoKSA9PiB7XG4gIGNvbnN0IHRtcEhvbWUgPSByZWFscGF0aFN5bmMobWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtcHJvdmlkZXJzLXRlc3QtXCIpKSk7XG4gIGNvbnN0IGFnZW50RGlyID0gam9pbih0bXBIb21lLCBcIi5nc2RcIiwgXCJhZ2VudFwiKTtcbiAgbWtkaXJTeW5jKGFnZW50RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAvLyBFbXB0eSBrZXkgXHUyMDE0IHdoYXQgb25ib2FyZGluZyB3cml0ZXMgd2hlbiB1c2VyIHNraXBzXG4gIGNvbnN0IGF1dGhEYXRhID0ge1xuICAgIGFudGhyb3BpYzogeyB0eXBlOiBcImFwaV9rZXlcIiwga2V5OiBcIlwiIH0sXG4gIH07XG4gIHdyaXRlRmlsZVN5bmMoam9pbihhZ2VudERpciwgXCJhdXRoLmpzb25cIiksIEpTT04uc3RyaW5naWZ5KGF1dGhEYXRhKSk7XG5cbiAgd2l0aEVudih7XG4gICAgQU5USFJPUElDX0FQSV9LRVk6IHVuZGVmaW5lZCxcbiAgICBBTlRIUk9QSUNfT0FVVEhfVE9LRU46IHVuZGVmaW5lZCxcbiAgICBDT1BJTE9UX0dJVEhVQl9UT0tFTjogdW5kZWZpbmVkLFxuICAgIEdIX1RPS0VOOiB1bmRlZmluZWQsXG4gICAgR0lUSFVCX1RPS0VOOiB1bmRlZmluZWQsXG4gICAgSE9NRTogdG1wSG9tZSxcbiAgICAvLyBFeGNsdWRlIEFJIENMSSBiaW5hcmllcyBzbyB0aGUgY2xhdWRlLWNvZGUgcm91dGUgaXMgbm90IGNvbnNpZGVyZWQgYXZhaWxhYmxlXG4gICAgUEFUSDogdG1wSG9tZSxcbiAgfSwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdHMgPSBydW5Qcm92aWRlckNoZWNrcygpO1xuICAgIGNvbnN0IGFudGhyb3BpYyA9IHJlc3VsdHMuZmluZChyID0+IHIubmFtZSA9PT0gXCJhbnRocm9waWNcIik7XG4gICAgYXNzZXJ0Lm9rKGFudGhyb3BpYywgXCJhbnRocm9waWMgc2hvdWxkIGJlIHByZXNlbnRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGFudGhyb3BpYyEuc3RhdHVzLCBcImVycm9yXCIsIFwiZW1wdHkgcGxhY2Vob2xkZXIga2V5IHNob3VsZCBjb3VudCBhcyBub3QgY29uZmlndXJlZFwiKTtcbiAgfSk7XG5cbiAgcm1TeW5jKHRtcEhvbWUsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbn0pO1xuXG50ZXN0KFwicnVuUHJvdmlkZXJDaGVja3MgZGV0ZWN0cyBjdXN0b20gcHJvdmlkZXIga2V5cyBmcm9tIG1vZGVscy5qc29uXCIsICgpID0+IHtcbiAgY29uc3QgdG1wSG9tZSA9IHJlYWxwYXRoU3luYyhta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1wcm92aWRlcnMtY3VzdG9tLWhvbWUtXCIpKSk7XG4gIGNvbnN0IHJlcG8gPSByZWFscGF0aFN5bmMobWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtcHJvdmlkZXJzLWN1c3RvbS1yZXBvLVwiKSkpO1xuICBjb25zdCBhZ2VudERpciA9IGpvaW4odG1wSG9tZSwgXCIuZ3NkXCIsIFwiYWdlbnRcIik7XG4gIG1rZGlyU3luYyhhZ2VudERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIG1rZGlyU3luYyhqb2luKHJlcG8sIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKHJlcG8sIFwiLmdzZFwiLCBcIlBSRUZFUkVOQ0VTLm1kXCIpLFxuICAgIFtcbiAgICAgIFwiLS0tXCIsXG4gICAgICBcIm1vZGVsczpcIixcbiAgICAgIFwiICBleGVjdXRpb246XCIsXG4gICAgICBcIiAgICBtb2RlbDogY3VzdG9tLW1vZGVsXCIsXG4gICAgICBcIiAgICBwcm92aWRlcjogY3VzdG9tLXByb3ZpZGVyXCIsXG4gICAgICBcIi0tLVwiLFxuICAgICAgXCJcIixcbiAgICBdLmpvaW4oXCJcXG5cIiksXG4gICk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihhZ2VudERpciwgXCJtb2RlbHMuanNvblwiKSwgSlNPTi5zdHJpbmdpZnkoe1xuICAgIHByb3ZpZGVyczoge1xuICAgICAgXCJjdXN0b20tcHJvdmlkZXJcIjoge1xuICAgICAgICBhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG4gICAgICAgIGFwaUtleTogXCJ4XCIsXG4gICAgICAgIGJhc2VVcmw6IFwiaHR0cHM6Ly9leGFtcGxlLmludmFsaWQvdjFcIixcbiAgICAgICAgbW9kZWxzOiBbeyBpZDogXCJjdXN0b20tbW9kZWxcIiwgbmFtZTogXCJDdXN0b20gTW9kZWxcIiB9XSxcbiAgICAgIH0sXG4gICAgfSxcbiAgfSkpO1xuXG4gIHdpdGhFbnYoe1xuICAgIEhPTUU6IHRtcEhvbWUsXG4gICAgQ1VTVE9NX1BST1ZJREVSX0FQSV9LRVk6IHVuZGVmaW5lZCxcbiAgICBQQVRIOiB0bXBIb21lLFxuICB9LCAoKSA9PiB7XG4gICAgd2l0aEN3ZChyZXBvLCAoKSA9PiB7XG4gICAgICBjb25zdCByZXN1bHRzID0gcnVuUHJvdmlkZXJDaGVja3MoKTtcbiAgICAgIGNvbnN0IGN1c3RvbSA9IHJlc3VsdHMuZmluZChyID0+IHIubmFtZSA9PT0gXCJjdXN0b20tcHJvdmlkZXJcIik7XG4gICAgICBhc3NlcnQub2soY3VzdG9tLCBcImN1c3RvbSBwcm92aWRlciByZXN1bHQgc2hvdWxkIGV4aXN0XCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGN1c3RvbSEuc3RhdHVzLCBcIm9rXCIsIFwibW9kZWxzLmpzb24gYXBpS2V5IHNob3VsZCBzYXRpc2Z5IGN1c3RvbSBwcm92aWRlciBhdXRoXCIpO1xuICAgICAgYXNzZXJ0Lm9rKGN1c3RvbSEubWVzc2FnZS5pbmNsdWRlcyhcIm1vZGVscy5qc29uXCIpLCBcInNob3VsZCByZXBvcnQgbW9kZWxzLmpzb24gc291cmNlXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHN1bW1hcmlzZVByb3ZpZGVySXNzdWVzKHJlc3VsdHMpLCBudWxsLCBcImN1c3RvbSBtb2RlbHMuanNvbiBrZXkgc2hvdWxkIG5vdCByYWlzZSBkYXNoYm9hcmQgd2FybmluZ1wiKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgcm1TeW5jKHJlcG8sIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgcm1TeW5jKHRtcEhvbWUsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbn0pO1xuXG50ZXN0KFwicnVuUHJvdmlkZXJDaGVja3MgcmVwb3J0cyBtaXNzaW5nIGN1c3RvbSBwcm92aWRlciBrZXkgd2l0aG91dCBtb2RlbHMuanNvbiBhcGlLZXlcIiwgKCkgPT4ge1xuICBjb25zdCB0bXBIb21lID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXByb3ZpZGVycy1jdXN0b20tbWlzc2luZy1ob21lLVwiKSkpO1xuICBjb25zdCByZXBvID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXByb3ZpZGVycy1jdXN0b20tbWlzc2luZy1yZXBvLVwiKSkpO1xuICBta2RpclN5bmMoam9pbihyZXBvLCBcIi5nc2RcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihyZXBvLCBcIi5nc2RcIiwgXCJQUkVGRVJFTkNFUy5tZFwiKSxcbiAgICBbXG4gICAgICBcIi0tLVwiLFxuICAgICAgXCJtb2RlbHM6XCIsXG4gICAgICBcIiAgZXhlY3V0aW9uOiBjdXN0b20tcHJvdmlkZXIvY3VzdG9tLW1vZGVsXCIsXG4gICAgICBcIi0tLVwiLFxuICAgICAgXCJcIixcbiAgICBdLmpvaW4oXCJcXG5cIiksXG4gICk7XG5cbiAgd2l0aEVudih7XG4gICAgSE9NRTogdG1wSG9tZSxcbiAgICBDVVNUT01fUFJPVklERVJfQVBJX0tFWTogdW5kZWZpbmVkLFxuICAgIFBBVEg6IHRtcEhvbWUsXG4gIH0sICgpID0+IHtcbiAgICB3aXRoQ3dkKHJlcG8sICgpID0+IHtcbiAgICAgIGNvbnN0IHJlc3VsdHMgPSBydW5Qcm92aWRlckNoZWNrcygpO1xuICAgICAgY29uc3QgY3VzdG9tID0gcmVzdWx0cy5maW5kKHIgPT4gci5uYW1lID09PSBcImN1c3RvbS1wcm92aWRlclwiKTtcbiAgICAgIGFzc2VydC5vayhjdXN0b20sIFwicHJvdmlkZXItcXVhbGlmaWVkIGN1c3RvbSBtb2RlbCBzaG91bGQgYmUgY2hlY2tlZFwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChjdXN0b20hLnN0YXR1cywgXCJlcnJvclwiLCBcIm1pc3NpbmcgY3VzdG9tIHByb3ZpZGVyIGtleSBzaG91bGQgc3RpbGwgYmUgcmVwb3J0ZWRcIik7XG4gICAgfSk7XG4gIH0pO1xuXG4gIHJtU3luYyhyZXBvLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIHJtU3luYyh0bXBIb21lLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHJ1blByb3ZpZGVyQ2hlY2tzIFx1MjAxNCBjcm9zcy1wcm92aWRlciByb3V0aW5nIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwicnVuUHJvdmlkZXJDaGVja3MgcmVwb3J0cyBvayBmb3IgQW50aHJvcGljIHdoZW4gR2l0SHViIENvcGlsb3QgZW52IHZhciBpcyBzZXRcIiwgKCkgPT4ge1xuICBjb25zdCB0bXBIb21lID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXByb3ZpZGVycy1jb3BpbG90LXRlc3QtXCIpKSk7XG4gIHdpdGhFbnYoe1xuICAgIEFOVEhST1BJQ19BUElfS0VZOiB1bmRlZmluZWQsXG4gICAgQU5USFJPUElDX09BVVRIX1RPS0VOOiB1bmRlZmluZWQsXG4gICAgQ09QSUxPVF9HSVRIVUJfVE9LRU46IFBSRVNFTlRfVEVTVF9WQUxVRSxcbiAgICBHSF9UT0tFTjogdW5kZWZpbmVkLFxuICAgIEdJVEhVQl9UT0tFTjogdW5kZWZpbmVkLFxuICAgIEhPTUU6IHRtcEhvbWUsXG4gIH0sICgpID0+IHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVzdWx0cyA9IHJ1blByb3ZpZGVyQ2hlY2tzKCk7XG4gICAgICBjb25zdCBhbnRocm9waWMgPSByZXN1bHRzLmZpbmQociA9PiByLm5hbWUgPT09IFwiYW50aHJvcGljXCIpO1xuICAgICAgYXNzZXJ0Lm9rKGFudGhyb3BpYywgXCJhbnRocm9waWMgcmVzdWx0IHNob3VsZCBleGlzdFwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChhbnRocm9waWMhLnN0YXR1cywgXCJva1wiLCBcInNob3VsZCBiZSBvayB3aGVuIENvcGlsb3QgYXV0aCBpcyBhdmFpbGFibGVcIik7XG4gICAgICBhc3NlcnQub2soYW50aHJvcGljIS5tZXNzYWdlLmluY2x1ZGVzKFwiR2l0SHViIENvcGlsb3RcIiksIFwic2hvdWxkIG1lbnRpb24gY3Jvc3MtcHJvdmlkZXIgc291cmNlXCIpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModG1wSG9tZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG59KTtcblxudGVzdChcInJ1blByb3ZpZGVyQ2hlY2tzIHJlcG9ydHMgb2sgZm9yIEFudGhyb3BpYyB2aWEgR0lUSFVCX1RPS0VOIGNyb3NzLXByb3ZpZGVyIHJvdXRpbmdcIiwgKCkgPT4ge1xuICBjb25zdCB0bXBIb21lID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXByb3ZpZGVycy1naHRva2VuLXRlc3QtXCIpKSk7XG4gIHdpdGhFbnYoe1xuICAgIEFOVEhST1BJQ19BUElfS0VZOiB1bmRlZmluZWQsXG4gICAgQU5USFJPUElDX09BVVRIX1RPS0VOOiB1bmRlZmluZWQsXG4gICAgQ09QSUxPVF9HSVRIVUJfVE9LRU46IHVuZGVmaW5lZCxcbiAgICBHSF9UT0tFTjogdW5kZWZpbmVkLFxuICAgIEdJVEhVQl9UT0tFTjogUFJFU0VOVF9URVNUX1ZBTFVFLFxuICAgIEhPTUU6IHRtcEhvbWUsXG4gIH0sICgpID0+IHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVzdWx0cyA9IHJ1blByb3ZpZGVyQ2hlY2tzKCk7XG4gICAgICBjb25zdCBhbnRocm9waWMgPSByZXN1bHRzLmZpbmQociA9PiByLm5hbWUgPT09IFwiYW50aHJvcGljXCIpO1xuICAgICAgYXNzZXJ0Lm9rKGFudGhyb3BpYywgXCJhbnRocm9waWMgcmVzdWx0IHNob3VsZCBleGlzdFwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChhbnRocm9waWMhLnN0YXR1cywgXCJva1wiLCBcInNob3VsZCBiZSBvayB3aGVuIEdJVEhVQl9UT0tFTiBwcm92aWRlcyBDb3BpbG90IGFjY2Vzc1wiKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKHRtcEhvbWUsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xufSk7XG5cbnRlc3QoXCJydW5Qcm92aWRlckNoZWNrcyBkZXRlY3RzIEFOVEhST1BJQ19PQVVUSF9UT0tFTiBhcyB2YWxpZCBBbnRocm9waWMgYXV0aFwiLCAoKSA9PiB7XG4gIGNvbnN0IHRtcEhvbWUgPSByZWFscGF0aFN5bmMobWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtcHJvdmlkZXJzLW9hdXRoLXRlc3QtXCIpKSk7XG4gIHdpdGhFbnYoe1xuICAgIEFOVEhST1BJQ19BUElfS0VZOiB1bmRlZmluZWQsXG4gICAgQU5USFJPUElDX09BVVRIX1RPS0VOOiBQUkVTRU5UX1RFU1RfVkFMVUUsXG4gICAgQ09QSUxPVF9HSVRIVUJfVE9LRU46IHVuZGVmaW5lZCxcbiAgICBHSF9UT0tFTjogdW5kZWZpbmVkLFxuICAgIEdJVEhVQl9UT0tFTjogdW5kZWZpbmVkLFxuICAgIEhPTUU6IHRtcEhvbWUsXG4gIH0sICgpID0+IHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVzdWx0cyA9IHJ1blByb3ZpZGVyQ2hlY2tzKCk7XG4gICAgICBjb25zdCBhbnRocm9waWMgPSByZXN1bHRzLmZpbmQociA9PiByLm5hbWUgPT09IFwiYW50aHJvcGljXCIpO1xuICAgICAgYXNzZXJ0Lm9rKGFudGhyb3BpYywgXCJhbnRocm9waWMgcmVzdWx0IHNob3VsZCBleGlzdFwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChhbnRocm9waWMhLnN0YXR1cywgXCJva1wiLCBcInNob3VsZCBiZSBvayB3aGVuIEFOVEhST1BJQ19PQVVUSF9UT0tFTiBpcyBzZXRcIik7XG4gICAgICBhc3NlcnQub2soYW50aHJvcGljIS5tZXNzYWdlLmluY2x1ZGVzKFwiZW52XCIpLCBcInNob3VsZCByZXBvcnQgZW52IHNvdXJjZVwiKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKHRtcEhvbWUsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xufSk7XG5cbnRlc3QoXCJydW5Qcm92aWRlckNoZWNrcyByZXBvcnRzIG9rIHZpYSBDb3BpbG90IGF1dGguanNvbiBmb3IgQW50aHJvcGljXCIsICgpID0+IHtcbiAgd2l0aEVudih7XG4gICAgQU5USFJPUElDX0FQSV9LRVk6IHVuZGVmaW5lZCxcbiAgICBBTlRIUk9QSUNfT0FVVEhfVE9LRU46IHVuZGVmaW5lZCxcbiAgICBDT1BJTE9UX0dJVEhVQl9UT0tFTjogdW5kZWZpbmVkLFxuICAgIEdIX1RPS0VOOiB1bmRlZmluZWQsXG4gICAgR0lUSFVCX1RPS0VOOiB1bmRlZmluZWQsXG4gIH0sICgpID0+IHtcbiAgICBjb25zdCB0bXBIb21lID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXByb3ZpZGVycy1jb3BpbG90LWF1dGgtdGVzdC1cIikpKTtcbiAgICBjb25zdCBhZ2VudERpciA9IGpvaW4odG1wSG9tZSwgXCIuZ3NkXCIsIFwiYWdlbnRcIik7XG4gICAgbWtkaXJTeW5jKGFnZW50RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAgIC8vIEdpdEh1YiBDb3BpbG90IE9BdXRoIGluIGF1dGguanNvblxuICAgIGNvbnN0IGF1dGhEYXRhID0ge1xuICAgICAgXCJnaXRodWItY29waWxvdFwiOiB7IHR5cGU6IFwib2F1dGhcIiwgYXBpS2V5OiBcImdodV9jb3BpbG90LWtleVwiLCBleHBpcmVzOiBEYXRlLm5vdygpICsgM182MDBfMDAwIH0sXG4gICAgfTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oYWdlbnREaXIsIFwiYXV0aC5qc29uXCIpLCBKU09OLnN0cmluZ2lmeShhdXRoRGF0YSkpO1xuXG4gICAgd2l0aEVudih7IEhPTUU6IHRtcEhvbWUgfSwgKCkgPT4ge1xuICAgICAgY29uc3QgcmVzdWx0cyA9IHJ1blByb3ZpZGVyQ2hlY2tzKCk7XG4gICAgICBjb25zdCBhbnRocm9waWMgPSByZXN1bHRzLmZpbmQociA9PiByLm5hbWUgPT09IFwiYW50aHJvcGljXCIpO1xuICAgICAgYXNzZXJ0Lm9rKGFudGhyb3BpYywgXCJhbnRocm9waWMgcmVzdWx0IHNob3VsZCBleGlzdFwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChhbnRocm9waWMhLnN0YXR1cywgXCJva1wiLCBcInNob3VsZCBiZSBvayB3aGVuIENvcGlsb3QgaXMgYXV0aGVudGljYXRlZCBpbiBhdXRoLmpzb25cIik7XG4gICAgICBhc3NlcnQub2soYW50aHJvcGljIS5tZXNzYWdlLmluY2x1ZGVzKFwiR2l0SHViIENvcGlsb3RcIiksIFwic2hvdWxkIG1lbnRpb24gQ29waWxvdCBhcyBzb3VyY2VcIik7XG4gICAgfSk7XG5cbiAgICBybVN5bmModG1wSG9tZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcbn0pO1xuXG50ZXN0KFwicnVuUHJvdmlkZXJDaGVja3MgdXNlcyBwcm92aWRlci1xdWFsaWZpZWQgYW50aHJvcGljLXZlcnRleCBtb2RlbCBJRHNcIiwgKCkgPT4ge1xuICBjb25zdCB0bXBIb21lID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXByb3ZpZGVycy12ZXJ0ZXgtcHJlZml4LWhvbWUtXCIpKSk7XG4gIGNvbnN0IHJlcG8gPSByZWFscGF0aFN5bmMobWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtcHJvdmlkZXJzLXZlcnRleC1wcmVmaXgtcmVwby1cIikpKTtcbiAgbWtkaXJTeW5jKGpvaW4ocmVwbywgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKHJlcG8sIFwiLmdzZFwiLCBcIlBSRUZFUkVOQ0VTLm1kXCIpLFxuICAgIFtcbiAgICAgIFwiLS0tXCIsXG4gICAgICBcIm1vZGVsczpcIixcbiAgICAgIFwiICBleGVjdXRpb246IGFudGhyb3BpYy12ZXJ0ZXgvY2xhdWRlLXNvbm5ldC00LTZcIixcbiAgICAgIFwiLS0tXCIsXG4gICAgICBcIlwiLFxuICAgIF0uam9pbihcIlxcblwiKSxcbiAgKTtcblxuICB3aXRoRW52KHtcbiAgICBIT01FOiB0bXBIb21lLFxuICAgIEFOVEhST1BJQ19BUElfS0VZOiB1bmRlZmluZWQsXG4gICAgQU5USFJPUElDX09BVVRIX1RPS0VOOiB1bmRlZmluZWQsXG4gICAgQU5USFJPUElDX1ZFUlRFWF9QUk9KRUNUX0lEOiBcInZlcnRleC1wcm9qZWN0XCIsXG4gIH0sICgpID0+IHtcbiAgICB3aXRoQ3dkKHJlcG8sICgpID0+IHtcbiAgICAgIGNvbnN0IHJlc3VsdHMgPSBydW5Qcm92aWRlckNoZWNrcygpO1xuICAgICAgY29uc3QgdmVydGV4ID0gcmVzdWx0cy5maW5kKHIgPT4gci5uYW1lID09PSBcImFudGhyb3BpYy12ZXJ0ZXhcIik7XG4gICAgICBjb25zdCBhbnRocm9waWMgPSByZXN1bHRzLmZpbmQociA9PiByLm5hbWUgPT09IFwiYW50aHJvcGljXCIpO1xuICAgICAgYXNzZXJ0Lm9rKHZlcnRleCwgXCJhbnRocm9waWMtdmVydGV4IHJlc3VsdCBzaG91bGQgZXhpc3RcIik7XG4gICAgICBhc3NlcnQuZXF1YWwodmVydGV4IS5zdGF0dXMsIFwib2tcIiwgXCJzaG91bGQgYWNjZXB0IEFOVEhST1BJQ19WRVJURVhfUFJPSkVDVF9JRCBhcyBjb25maWd1cmVkXCIpO1xuICAgICAgYXNzZXJ0Lm9rKCFhbnRocm9waWMgfHwgIWFudGhyb3BpYy5yZXF1aXJlZCwgXCJwbGFpbiBhbnRocm9waWMgc2hvdWxkIG5vdCBiZSByZXF1aXJlZCBmb3IgYW50aHJvcGljLXZlcnRleCBjb25maWdcIik7XG4gICAgfSk7XG4gIH0pO1xuXG4gIHJtU3luYyhyZXBvLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIHJtU3luYyh0bXBIb21lLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG59KTtcblxudGVzdChcInJ1blByb3ZpZGVyQ2hlY2tzIHVzZXMgb2JqZWN0IHByb3ZpZGVyIGZpZWxkIGZvciBhbnRocm9waWMtdmVydGV4IG1vZGVsc1wiLCAoKSA9PiB7XG4gIGNvbnN0IHRtcEhvbWUgPSByZWFscGF0aFN5bmMobWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtcHJvdmlkZXJzLXZlcnRleC1wcm92aWRlci1ob21lLVwiKSkpO1xuICBjb25zdCByZXBvID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXByb3ZpZGVycy12ZXJ0ZXgtcHJvdmlkZXItcmVwby1cIikpKTtcbiAgbWtkaXJTeW5jKGpvaW4ocmVwbywgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKHJlcG8sIFwiLmdzZFwiLCBcIlBSRUZFUkVOQ0VTLm1kXCIpLFxuICAgIFtcbiAgICAgIFwiLS0tXCIsXG4gICAgICBcIm1vZGVsczpcIixcbiAgICAgIFwiICBleGVjdXRpb246XCIsXG4gICAgICBcIiAgICBtb2RlbDogY2xhdWRlLXNvbm5ldC00LTZcIixcbiAgICAgIFwiICAgIHByb3ZpZGVyOiBhbnRocm9waWMtdmVydGV4XCIsXG4gICAgICBcIi0tLVwiLFxuICAgICAgXCJcIixcbiAgICBdLmpvaW4oXCJcXG5cIiksXG4gICk7XG5cbiAgd2l0aEVudih7XG4gICAgSE9NRTogdG1wSG9tZSxcbiAgICBBTlRIUk9QSUNfQVBJX0tFWTogdW5kZWZpbmVkLFxuICAgIEFOVEhST1BJQ19PQVVUSF9UT0tFTjogdW5kZWZpbmVkLFxuICAgIEFOVEhST1BJQ19WRVJURVhfUFJPSkVDVF9JRDogdW5kZWZpbmVkLFxuICB9LCAoKSA9PiB7XG4gICAgd2l0aEN3ZChyZXBvLCAoKSA9PiB7XG4gICAgICBjb25zdCByZXN1bHRzID0gcnVuUHJvdmlkZXJDaGVja3MoKTtcbiAgICAgIGNvbnN0IHZlcnRleCA9IHJlc3VsdHMuZmluZChyID0+IHIubmFtZSA9PT0gXCJhbnRocm9waWMtdmVydGV4XCIpO1xuICAgICAgYXNzZXJ0Lm9rKHZlcnRleCwgXCJhbnRocm9waWMtdmVydGV4IHJlc3VsdCBzaG91bGQgZXhpc3RcIik7XG4gICAgICBhc3NlcnQuZXF1YWwodmVydGV4IS5zdGF0dXMsIFwiZXJyb3JcIiwgXCJtaXNzaW5nIHZlcnRleCBjb25maWcgc2hvdWxkIGJlIHJlcG9ydGVkIGFnYWluc3QgYW50aHJvcGljLXZlcnRleFwiKTtcbiAgICAgIGFzc2VydC5vayh2ZXJ0ZXghLmRldGFpbD8uaW5jbHVkZXMoXCJBTlRIUk9QSUNfVkVSVEVYX1BST0pFQ1RfSURcIiksIFwic2hvdWxkIHBvaW50IHRvIHZlcnRleCBzZXR1cFwiKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgcm1TeW5jKHJlcG8sIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgcm1TeW5jKHRtcEhvbWUsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQ3Jvc3MtcHJvdmlkZXIgcm91dGluZzogQ29kZXggJiBHZW1pbmkgQ0xJICgjMjkyMikgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJydW5Qcm92aWRlckNoZWNrcyByZXBvcnRzIG9rIGZvciBHb29nbGUgdmlhIGdvb2dsZS1nZW1pbmktY2xpIGF1dGguanNvbiAoIzI5MjIpXCIsICgpID0+IHtcbiAgY29uc3QgcmVwbyA9IHJlYWxwYXRoU3luYyhta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1wcm92aWRlcnMtZ2VtaW5pLWNsaS1yZXBvLVwiKSkpO1xuICBta2RpclN5bmMoam9pbihyZXBvLCBcIi5nc2RcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4ocmVwbywgXCIuZ3NkXCIsIFwiUFJFRkVSRU5DRVMubWRcIiksXG4gICAgW1xuICAgICAgXCItLS1cIixcbiAgICAgIFwibW9kZWxzOlwiLFxuICAgICAgXCIgIGV4ZWN1dGlvbjogZ2VtaW5pLTIuNS1wcm9cIixcbiAgICAgIFwiLS0tXCIsXG4gICAgICBcIlwiLFxuICAgIF0uam9pbihcIlxcblwiKSxcbiAgKTtcblxuICBjb25zdCB0bXBIb21lID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXByb3ZpZGVycy1nZW1pbmktY2xpLWhvbWUtXCIpKSk7XG4gIGNvbnN0IGFnZW50RGlyID0gam9pbih0bXBIb21lLCBcIi5nc2RcIiwgXCJhZ2VudFwiKTtcbiAgbWtkaXJTeW5jKGFnZW50RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAvLyBnb29nbGUtZ2VtaW5pLWNsaSBPQXV0aCBpbiBhdXRoLmpzb24gKG5vIGdvb2dsZSBBUEkga2V5KVxuICBjb25zdCBhdXRoRGF0YSA9IHtcbiAgICBcImdvb2dsZS1nZW1pbmktY2xpXCI6IHsgdHlwZTogXCJvYXV0aFwiLCBleHBpcmVzOiBEYXRlLm5vdygpICsgM182MDBfMDAwIH0sXG4gIH07XG4gIHdyaXRlRmlsZVN5bmMoam9pbihhZ2VudERpciwgXCJhdXRoLmpzb25cIiksIEpTT04uc3RyaW5naWZ5KGF1dGhEYXRhKSk7XG5cbiAgd2l0aEVudih7XG4gICAgSE9NRTogdG1wSG9tZSxcbiAgICBHRU1JTklfQVBJX0tFWTogdW5kZWZpbmVkLFxuICAgIEdPT0dMRV9BUElfS0VZOiB1bmRlZmluZWQsXG4gIH0sICgpID0+IHtcbiAgICB3aXRoQ3dkKHJlcG8sICgpID0+IHtcbiAgICAgIGNvbnN0IHJlc3VsdHMgPSBydW5Qcm92aWRlckNoZWNrcygpO1xuICAgICAgY29uc3QgZ29vZ2xlID0gcmVzdWx0cy5maW5kKHIgPT4gci5uYW1lID09PSBcImdvb2dsZVwiKTtcbiAgICAgIGFzc2VydC5vayhnb29nbGUsIFwiZ29vZ2xlIHJlc3VsdCBzaG91bGQgZXhpc3RcIik7XG4gICAgICBhc3NlcnQuZXF1YWwoZ29vZ2xlIS5zdGF0dXMsIFwib2tcIiwgXCJzaG91bGQgYmUgb2sgd2hlbiBnb29nbGUtZ2VtaW5pLWNsaSBhdXRoIGlzIGF2YWlsYWJsZSAoIzI5MjIpXCIpO1xuICAgICAgYXNzZXJ0Lm9rKGdvb2dsZSEubWVzc2FnZS5pbmNsdWRlcyhcIkdvb2dsZSBHZW1pbmkgQ0xJXCIpLCBcInNob3VsZCBtZW50aW9uIEdlbWluaSBDTEkgYXMgdGhlIHNvdXJjZSAoIzI5MjIpXCIpO1xuICAgIH0pO1xuICB9KTtcblxuICBybVN5bmMocmVwbywgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICBybVN5bmModG1wSG9tZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xufSk7XG5cbnRlc3QoXCJydW5Qcm92aWRlckNoZWNrcyByZXBvcnRzIG9rIGZvciBPcGVuQUkgdmlhIG9wZW5haS1jb2RleCBhdXRoLmpzb24gKCMyOTIyKVwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlcG8gPSByZWFscGF0aFN5bmMobWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtcHJvdmlkZXJzLWNvZGV4LXJlcG8tXCIpKSk7XG4gIG1rZGlyU3luYyhqb2luKHJlcG8sIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihyZXBvLCBcIi5nc2RcIiwgXCJQUkVGRVJFTkNFUy5tZFwiKSxcbiAgICBbXG4gICAgICBcIi0tLVwiLFxuICAgICAgXCJtb2RlbHM6XCIsXG4gICAgICBcIiAgZXhlY3V0aW9uOiBncHQtNG9cIixcbiAgICAgIFwiLS0tXCIsXG4gICAgICBcIlwiLFxuICAgIF0uam9pbihcIlxcblwiKSxcbiAgKTtcblxuICBjb25zdCB0bXBIb21lID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXByb3ZpZGVycy1jb2RleC1ob21lLVwiKSkpO1xuICBjb25zdCBhZ2VudERpciA9IGpvaW4odG1wSG9tZSwgXCIuZ3NkXCIsIFwiYWdlbnRcIik7XG4gIG1rZGlyU3luYyhhZ2VudERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgLy8gb3BlbmFpLWNvZGV4IE9BdXRoIGluIGF1dGguanNvbiAobm8gb3BlbmFpIEFQSSBrZXkpXG4gIGNvbnN0IGF1dGhEYXRhID0ge1xuICAgIFwib3BlbmFpLWNvZGV4XCI6IHsgdHlwZTogXCJvYXV0aFwiLCBhcGlLZXk6IFwiY29kZXgtdG9rZW5cIiwgZXhwaXJlczogRGF0ZS5ub3coKSArIDNfNjAwXzAwMCB9LFxuICB9O1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oYWdlbnREaXIsIFwiYXV0aC5qc29uXCIpLCBKU09OLnN0cmluZ2lmeShhdXRoRGF0YSkpO1xuXG4gIHdpdGhFbnYoe1xuICAgIEhPTUU6IHRtcEhvbWUsXG4gICAgT1BFTkFJX0FQSV9LRVk6IHVuZGVmaW5lZCxcbiAgICAvLyBDbGVhciBDb3BpbG90IGVudiB2YXJzIHNvIGl0IGRvZXNuJ3Qgcm91dGUgdGhyb3VnaCBDb3BpbG90XG4gICAgQ09QSUxPVF9HSVRIVUJfVE9LRU46IHVuZGVmaW5lZCxcbiAgICBHSF9UT0tFTjogdW5kZWZpbmVkLFxuICAgIEdJVEhVQl9UT0tFTjogdW5kZWZpbmVkLFxuICB9LCAoKSA9PiB7XG4gICAgd2l0aEN3ZChyZXBvLCAoKSA9PiB7XG4gICAgICBjb25zdCByZXN1bHRzID0gcnVuUHJvdmlkZXJDaGVja3MoKTtcbiAgICAgIGNvbnN0IG9wZW5haSA9IHJlc3VsdHMuZmluZChyID0+IHIubmFtZSA9PT0gXCJvcGVuYWlcIik7XG4gICAgICBhc3NlcnQub2sob3BlbmFpLCBcIm9wZW5haSByZXN1bHQgc2hvdWxkIGV4aXN0XCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKG9wZW5haSEuc3RhdHVzLCBcIm9rXCIsIFwic2hvdWxkIGJlIG9rIHdoZW4gb3BlbmFpLWNvZGV4IGF1dGggaXMgYXZhaWxhYmxlICgjMjkyMilcIik7XG4gICAgICBhc3NlcnQub2sob3BlbmFpIS5tZXNzYWdlLmluY2x1ZGVzKFwiQ29kZXhcIiksIFwic2hvdWxkIG1lbnRpb24gQ29kZXggYXMgdGhlIHNvdXJjZSAoIzI5MjIpXCIpO1xuICAgIH0pO1xuICB9KTtcblxuICBybVN5bmMocmVwbywgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICBybVN5bmModG1wSG9tZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xufSk7XG5cbnRlc3QoXCJydW5Qcm92aWRlckNoZWNrcyByZXBvcnRzIG9rIGZvciBjbGF1ZGUtY29kZSB3aXRob3V0IGFueSBBUEkga2V5XCIsICgpID0+IHtcbiAgY29uc3QgcmVwbyA9IHJlYWxwYXRoU3luYyhta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1wcm92aWRlcnMtY2MtcmVwby1cIikpKTtcbiAgbWtkaXJTeW5jKGpvaW4ocmVwbywgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKHJlcG8sIFwiLmdzZFwiLCBcIlBSRUZFUkVOQ0VTLm1kXCIpLFxuICAgIFtcbiAgICAgIFwiLS0tXCIsXG4gICAgICBcIm1vZGVsczpcIixcbiAgICAgIFwiICBleGVjdXRpb246XCIsXG4gICAgICBcIiAgICBtb2RlbDogY2xhdWRlLXNvbm5ldC00LTZcIixcbiAgICAgIFwiICAgIHByb3ZpZGVyOiBjbGF1ZGUtY29kZVwiLFxuICAgICAgXCItLS1cIixcbiAgICAgIFwiXCIsXG4gICAgXS5qb2luKFwiXFxuXCIpLFxuICApO1xuXG4gIGNvbnN0IHRtcEhvbWUgPSByZWFscGF0aFN5bmMobWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtcHJvdmlkZXJzLWNjLWhvbWUtXCIpKSk7XG5cbiAgd2l0aEVudih7XG4gICAgSE9NRTogdG1wSG9tZSxcbiAgICBBTlRIUk9QSUNfQVBJX0tFWTogdW5kZWZpbmVkLFxuICAgIEFOVEhST1BJQ19PQVVUSF9UT0tFTjogdW5kZWZpbmVkLFxuICB9LCAoKSA9PiB7XG4gICAgd2l0aEN3ZChyZXBvLCAoKSA9PiB7XG4gICAgICBjb25zdCByZXN1bHRzID0gcnVuUHJvdmlkZXJDaGVja3MoKTtcbiAgICAgIGNvbnN0IGNjID0gcmVzdWx0cy5maW5kKHIgPT4gci5uYW1lID09PSBcImNsYXVkZS1jb2RlXCIpO1xuICAgICAgYXNzZXJ0Lm9rKGNjLCBcImNsYXVkZS1jb2RlIHJlc3VsdCBzaG91bGQgZXhpc3RcIik7XG4gICAgICBhc3NlcnQuZXF1YWwoY2MhLnN0YXR1cywgXCJva1wiLCBcImNsYXVkZS1jb2RlIHVzZXMgQ0xJIGF1dGggXHUyMDE0IG11c3QgYmUgb2sgd2l0aG91dCBBUEkga2V5c1wiKTtcbiAgICAgIGFzc2VydC5vayhjYyEubWVzc2FnZS5pbmNsdWRlcyhcIkNMSSBhdXRoXCIpLCBcInNob3VsZCBpbmRpY2F0ZSBDTEkgYXV0aFwiKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgcm1TeW5jKHJlcG8sIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgcm1TeW5jKHRtcEhvbWUsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbn0pO1xuXG50ZXN0KFwicnVuUHJvdmlkZXJDaGVja3MgcmVwb3J0cyBvayBmb3IgQW50aHJvcGljIHZpYSBjbGF1ZGUtY29kZSBiaW5hcnkgaW4gUEFUSFwiLCAoKSA9PiB7XG4gIC8vIFNpbXVsYXRlIGEgdXNlciB3aG8gaGFzIG5vIEFudGhyb3BpYyBBUEkga2V5IGJ1dCBoYXMgdGhlIGNsYXVkZSBDTEkgaW5zdGFsbGVkLlxuICAvLyBUaGVpciBQUkVGRVJFTkNFUyB1c2UgYSBjbGF1ZGUgbW9kZWwgd2l0aG91dCBhbiBleHBsaWNpdCBwcm92aWRlciwgc28gdGhlIGRvY3RvclxuICAvLyBpbmZlcnMgXCJhbnRocm9waWNcIiBcdTIwMTQgYnV0IHRoZSBjbGF1ZGUtY29kZSByb3V0ZSBzaG91bGQgc2F0aXNmeSBpdC5cbiAgY29uc3QgdG1wSG9tZSA9IHJlYWxwYXRoU3luYyhta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1wcm92aWRlcnMtY2Mtcm91dGUtaG9tZS1cIikpKTtcbiAgY29uc3QgYmluRGlyID0gam9pbih0bXBIb21lLCBcImJpblwiKTtcbiAgbWtkaXJTeW5jKGJpbkRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgLy8gQ3JlYXRlIGEgZmFrZSBgY2xhdWRlYCBiaW5hcnkgc28gdGhlIFBBVEggc2NhbiBmaW5kcyBpdFxuICBjb25zdCBmYWtlQ2xhdWRlID0gam9pbihiaW5EaXIsIFwiY2xhdWRlXCIpO1xuICB3cml0ZUZpbGVTeW5jKGZha2VDbGF1ZGUsIFwiIyEvYmluL3NoXFxuZWNobyBtb2NrXFxuXCIpO1xuICBjaG1vZFN5bmMoZmFrZUNsYXVkZSwgMG83NTUpO1xuXG4gIHdpdGhFbnYoe1xuICAgIEhPTUU6IHRtcEhvbWUsXG4gICAgQU5USFJPUElDX0FQSV9LRVk6IHVuZGVmaW5lZCxcbiAgICBBTlRIUk9QSUNfT0FVVEhfVE9LRU46IHVuZGVmaW5lZCxcbiAgICBDT1BJTE9UX0dJVEhVQl9UT0tFTjogdW5kZWZpbmVkLFxuICAgIEdIX1RPS0VOOiB1bmRlZmluZWQsXG4gICAgR0lUSFVCX1RPS0VOOiB1bmRlZmluZWQsXG4gICAgUEFUSDogYCR7YmluRGlyfSR7ZGVsaW1pdGVyfSR7cHJvY2Vzcy5lbnYuUEFUSCA/PyBcIlwifWAsXG4gIH0sICgpID0+IHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVzdWx0cyA9IHJ1blByb3ZpZGVyQ2hlY2tzKCk7XG4gICAgICBjb25zdCBhbnRocm9waWMgPSByZXN1bHRzLmZpbmQociA9PiByLm5hbWUgPT09IFwiYW50aHJvcGljXCIpO1xuICAgICAgYXNzZXJ0Lm9rKGFudGhyb3BpYywgXCJhbnRocm9waWMgcmVzdWx0IHNob3VsZCBleGlzdFwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChhbnRocm9waWMhLnN0YXR1cywgXCJva1wiLCBcInNob3VsZCBiZSBvayB3aGVuIGNsYXVkZSBDTEkgYmluYXJ5IGlzIGluIFBBVEhcIik7XG4gICAgICBhc3NlcnQub2soYW50aHJvcGljIS5tZXNzYWdlLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoXCJjbGF1ZGVcIiksIFwic2hvdWxkIG1lbnRpb24gY2xhdWRlLWNvZGUgYXMgc291cmNlXCIpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModG1wSG9tZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG59KTtcblxudGVzdChcInJ1blByb3ZpZGVyQ2hlY2tzIGRldGVjdHMgY2xhdWRlLmNtZCBpbiBQQVRIIG9uIFdpbmRvd3MgKCM0NTAzKVwiLCB7IHNraXA6IHByb2Nlc3MucGxhdGZvcm0gIT09IFwid2luMzJcIiB9LCAoKSA9PiB7XG4gIGNvbnN0IHRtcEhvbWUgPSByZWFscGF0aFN5bmMobWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtcHJvdmlkZXJzLWNjLXdpbi1yb3V0ZS1ob21lLVwiKSkpO1xuICBjb25zdCBiaW5EaXIgPSBqb2luKHRtcEhvbWUsIFwiYmluXCIpO1xuICBta2RpclN5bmMoYmluRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAvLyBPbiBXaW5kb3dzLCB1c2VycyBjb21tb25seSBpbnN0YWxsIENsYXVkZSB2aWEgYSAuY21kIHNoaW0uXG4gIGNvbnN0IGZha2VDbGF1ZGVDbWQgPSBqb2luKGJpbkRpciwgXCJjbGF1ZGUuY21kXCIpO1xuICB3cml0ZUZpbGVTeW5jKGZha2VDbGF1ZGVDbWQsIFwiQGVjaG8gb2ZmXFxyXFxuZWNobyBtb2NrXFxyXFxuXCIpO1xuXG4gIHdpdGhFbnYoe1xuICAgIEhPTUU6IHRtcEhvbWUsXG4gICAgQU5USFJPUElDX0FQSV9LRVk6IHVuZGVmaW5lZCxcbiAgICBBTlRIUk9QSUNfT0FVVEhfVE9LRU46IHVuZGVmaW5lZCxcbiAgICBDT1BJTE9UX0dJVEhVQl9UT0tFTjogdW5kZWZpbmVkLFxuICAgIEdIX1RPS0VOOiB1bmRlZmluZWQsXG4gICAgR0lUSFVCX1RPS0VOOiB1bmRlZmluZWQsXG4gICAgLy8gRXhwbGljaXRseSB1c2UgJzsnIHRvIG1pcnJvciBXaW5kb3dzIFBBVEggZW50cmllcy5cbiAgICBQQVRIOiBgJHtiaW5EaXJ9OyR7cHJvY2Vzcy5lbnYuUEFUSCA/PyBcIlwifWAsXG4gICAgUEFUSEVYVDogXCIuQ09NOy5FWEU7LkJBVDsuQ01EXCIsXG4gIH0sICgpID0+IHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVzdWx0cyA9IHJ1blByb3ZpZGVyQ2hlY2tzKCk7XG4gICAgICBjb25zdCBhbnRocm9waWMgPSByZXN1bHRzLmZpbmQociA9PiByLm5hbWUgPT09IFwiYW50aHJvcGljXCIpO1xuICAgICAgYXNzZXJ0Lm9rKGFudGhyb3BpYywgXCJhbnRocm9waWMgcmVzdWx0IHNob3VsZCBleGlzdFwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChhbnRocm9waWMhLnN0YXR1cywgXCJva1wiLCBcInNob3VsZCBiZSBvayB3aGVuIGNsYXVkZS5jbWQgaXMgaW4gUEFUSFwiKTtcbiAgICAgIGFzc2VydC5vayhhbnRocm9waWMhLm1lc3NhZ2UudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhcImNsYXVkZVwiKSwgXCJzaG91bGQgbWVudGlvbiBjbGF1ZGUtY29kZSBhcyBzb3VyY2VcIik7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0bXBIb21lLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcbn0pO1xuXG50ZXN0KFwicnVuUHJvdmlkZXJDaGVja3MgZGV0ZWN0cyBjbGF1ZGUuZXhlIGluIFBBVEggb24gV2luZG93cyAoIzQ1NDgpXCIsIHsgc2tpcDogcHJvY2Vzcy5wbGF0Zm9ybSAhPT0gXCJ3aW4zMlwiIH0sICgpID0+IHtcbiAgY29uc3QgdG1wSG9tZSA9IHJlYWxwYXRoU3luYyhta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1wcm92aWRlcnMtY2MtZXhlLWhvbWUtXCIpKSk7XG4gIGNvbnN0IGJpbkRpciA9IGpvaW4odG1wSG9tZSwgXCJiaW5cIik7XG4gIG1rZGlyU3luYyhiaW5EaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gIC8vIFNvbWUgV2luZG93cyBpbnN0YWxscyBzaGlwIGEgZGlyZWN0IGNsYXVkZS5leGUgYmluYXJ5IChub3QgYSAuY21kIHNoaW0pLlxuICBjb25zdCBmYWtlQ2xhdWRlRXhlID0gam9pbihiaW5EaXIsIFwiY2xhdWRlLmV4ZVwiKTtcbiAgd3JpdGVGaWxlU3luYyhmYWtlQ2xhdWRlRXhlLCBcIlwiKTtcblxuICB3aXRoRW52KHtcbiAgICBIT01FOiB0bXBIb21lLFxuICAgIEFOVEhST1BJQ19BUElfS0VZOiB1bmRlZmluZWQsXG4gICAgQU5USFJPUElDX09BVVRIX1RPS0VOOiB1bmRlZmluZWQsXG4gICAgQ09QSUxPVF9HSVRIVUJfVE9LRU46IHVuZGVmaW5lZCxcbiAgICBHSF9UT0tFTjogdW5kZWZpbmVkLFxuICAgIEdJVEhVQl9UT0tFTjogdW5kZWZpbmVkLFxuICAgIFBBVEg6IGAke2JpbkRpcn07JHtwcm9jZXNzLmVudi5QQVRIID8/IFwiXCJ9YCxcbiAgICBQQVRIRVhUOiBcIi5DT007LkVYRTsuQkFUOy5DTURcIixcbiAgfSwgKCkgPT4ge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCByZXN1bHRzID0gcnVuUHJvdmlkZXJDaGVja3MoKTtcbiAgICAgIGNvbnN0IGFudGhyb3BpYyA9IHJlc3VsdHMuZmluZChyID0+IHIubmFtZSA9PT0gXCJhbnRocm9waWNcIik7XG4gICAgICBhc3NlcnQub2soYW50aHJvcGljLCBcImFudGhyb3BpYyByZXN1bHQgc2hvdWxkIGV4aXN0XCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGFudGhyb3BpYyEuc3RhdHVzLCBcIm9rXCIsIFwic2hvdWxkIGJlIG9rIHdoZW4gY2xhdWRlLmV4ZSBpcyBpbiBQQVRIICgjNDU0OClcIik7XG4gICAgICBhc3NlcnQub2soYW50aHJvcGljIS5tZXNzYWdlLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoXCJjbGF1ZGVcIiksIFwic2hvdWxkIG1lbnRpb24gY2xhdWRlLWNvZGUgYXMgc291cmNlXCIpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModG1wSG9tZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG59KTtcblxudGVzdChcIlBST1ZJREVSX1JPVVRFUyBpbmNsdWRlcyBnb29nbGUtZ2VtaW5pLWNsaSBhcyByb3V0ZSBmb3IgZ29vZ2xlICgjMjkyMilcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IHJlYWRGaWxlU3luYzogcmVhZEZTIH0gPSBhd2FpdCBpbXBvcnQoXCJub2RlOmZzXCIpO1xuICBjb25zdCB7IGRpcm5hbWU6IGRpcm4sIGpvaW46IGpvaW5QYXRoIH0gPSBhd2FpdCBpbXBvcnQoXCJub2RlOnBhdGhcIik7XG4gIGNvbnN0IHsgZmlsZVVSTFRvUGF0aDogZmlsZVVybCB9ID0gYXdhaXQgaW1wb3J0KFwibm9kZTp1cmxcIik7XG4gIGNvbnN0IF9fZGlyID0gZGlybihmaWxlVXJsKGltcG9ydC5tZXRhLnVybCkpO1xuICBjb25zdCBzcmMgPSByZWFkRlMoam9pblBhdGgoX19kaXIsIFwiLi5cIiwgXCJkb2N0b3ItcHJvdmlkZXJzLnRzXCIpLCBcInV0Zi04XCIpO1xuXG4gIC8vIFBST1ZJREVSX1JPVVRFUyBtdXN0IG1hcCBnb29nbGUgLT4gWy4uLiwgXCJnb29nbGUtZ2VtaW5pLWNsaVwiXVxuICBhc3NlcnQub2soXG4gICAgc3JjLmluY2x1ZGVzKCdcImdvb2dsZS1nZW1pbmktY2xpXCInKSxcbiAgICAnUFJPVklERVJfUk9VVEVTIG11c3QgaW5jbHVkZSBcImdvb2dsZS1nZW1pbmktY2xpXCIgYXMgYSByb3V0ZSAoIzI5MjIpJyxcbiAgKTtcbn0pO1xuXG50ZXN0KFwiUFJPVklERVJfUk9VVEVTIGluY2x1ZGVzIG9wZW5haS1jb2RleCBhcyByb3V0ZSBmb3Igb3BlbmFpICgjMjkyMilcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IHJlYWRGaWxlU3luYzogcmVhZEZTIH0gPSBhd2FpdCBpbXBvcnQoXCJub2RlOmZzXCIpO1xuICBjb25zdCB7IGRpcm5hbWU6IGRpcm4sIGpvaW46IGpvaW5QYXRoIH0gPSBhd2FpdCBpbXBvcnQoXCJub2RlOnBhdGhcIik7XG4gIGNvbnN0IHsgZmlsZVVSTFRvUGF0aDogZmlsZVVybCB9ID0gYXdhaXQgaW1wb3J0KFwibm9kZTp1cmxcIik7XG4gIGNvbnN0IF9fZGlyID0gZGlybihmaWxlVXJsKGltcG9ydC5tZXRhLnVybCkpO1xuICBjb25zdCBzcmMgPSByZWFkRlMoam9pblBhdGgoX19kaXIsIFwiLi5cIiwgXCJkb2N0b3ItcHJvdmlkZXJzLnRzXCIpLCBcInV0Zi04XCIpO1xuXG4gIC8vIFBST1ZJREVSX1JPVVRFUyBtdXN0IG1hcCBvcGVuYWkgLT4gWy4uLiwgXCJvcGVuYWktY29kZXhcIl1cbiAgYXNzZXJ0Lm9rKFxuICAgIHNyYy5pbmNsdWRlcygnXCJvcGVuYWktY29kZXhcIicpLFxuICAgICdQUk9WSURFUl9ST1VURVMgbXVzdCBpbmNsdWRlIFwib3BlbmFpLWNvZGV4XCIgYXMgYSByb3V0ZSAoIzI5MjIpJyxcbiAgKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBY0EsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUNuQixTQUFTLGFBQWEsV0FBVyxlQUFlLFFBQVEsY0FBYyxpQkFBaUI7QUFDdkYsU0FBUyxXQUFXLFlBQVk7QUFDaEMsU0FBUyxjQUFjO0FBRXZCO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FFSztBQUlQLFNBQVMsUUFBUSxNQUEwQyxJQUFzQjtBQUMvRSxRQUFNLFFBQTRDLENBQUM7QUFDbkQsYUFBVyxDQUFDLEdBQUcsQ0FBQyxLQUFLLE9BQU8sUUFBUSxJQUFJLEdBQUc7QUFDekMsVUFBTSxDQUFDLElBQUksUUFBUSxJQUFJLENBQUM7QUFDeEIsUUFBSSxNQUFNLFFBQVc7QUFDbkIsYUFBTyxRQUFRLElBQUksQ0FBQztB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
