import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
import { resolvePreferredModelConfig, resolveModelId, selectAndApplyModel } from "../auto-model-selection.js";
function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}
test("resolvePreferredModelConfig synthesizes heavy routing ceiling when models section is absent", () => {
  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;
  const tempProject = makeTempDir("gsd-routing-project-");
  const tempGsdHome = makeTempDir("gsd-routing-home-");
  try {
    mkdirSync(join(tempProject, ".gsd"), { recursive: true });
    writeFileSync(
      join(tempProject, ".gsd", "PREFERENCES.md"),
      [
        "---",
        "dynamic_routing:",
        "  enabled: true",
        "  tier_models:",
        "    light: claude-haiku-4-5",
        "    standard: claude-sonnet-4-6",
        "    heavy: claude-opus-4-6",
        "---"
      ].join("\n"),
      "utf-8"
    );
    process.env.GSD_HOME = tempGsdHome;
    process.chdir(tempProject);
    const config = resolvePreferredModelConfig("plan-slice", {
      provider: "anthropic",
      id: "claude-sonnet-4-6"
    });
    assert.deepEqual(config, {
      primary: "claude-opus-4-6",
      fallbacks: [],
      source: "synthesized"
    });
  } finally {
    process.chdir(originalCwd);
    if (originalGsdHome === void 0) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempGsdHome, { recursive: true, force: true });
  }
});
test("resolvePreferredModelConfig falls back to auto start model when heavy tier is absent", () => {
  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;
  const tempProject = makeTempDir("gsd-routing-project-");
  const tempGsdHome = makeTempDir("gsd-routing-home-");
  try {
    mkdirSync(join(tempProject, ".gsd"), { recursive: true });
    writeFileSync(
      join(tempProject, ".gsd", "PREFERENCES.md"),
      [
        "---",
        "dynamic_routing:",
        "  enabled: true",
        "  tier_models:",
        "    light: claude-haiku-4-5",
        "    standard: claude-sonnet-4-6",
        "---"
      ].join("\n"),
      "utf-8"
    );
    process.env.GSD_HOME = tempGsdHome;
    process.chdir(tempProject);
    const config = resolvePreferredModelConfig("execute-task", {
      provider: "openai",
      id: "gpt-5.4"
    });
    assert.deepEqual(config, {
      primary: "openai/gpt-5.4",
      fallbacks: [],
      source: "synthesized"
    });
  } finally {
    process.chdir(originalCwd);
    if (originalGsdHome === void 0) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempGsdHome, { recursive: true, force: true });
  }
});
test("resolvePreferredModelConfig keeps explicit phase models as the ceiling", () => {
  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;
  const tempProject = makeTempDir("gsd-routing-project-");
  const tempGsdHome = makeTempDir("gsd-routing-home-");
  try {
    mkdirSync(join(tempProject, ".gsd"), { recursive: true });
    writeFileSync(
      join(tempProject, ".gsd", "PREFERENCES.md"),
      [
        "---",
        "models:",
        "  planning: claude-sonnet-4-6",
        "dynamic_routing:",
        "  enabled: true",
        "  tier_models:",
        "    heavy: claude-opus-4-6",
        "---"
      ].join("\n"),
      "utf-8"
    );
    process.env.GSD_HOME = tempGsdHome;
    process.chdir(tempProject);
    const config = resolvePreferredModelConfig("plan-slice", {
      provider: "anthropic",
      id: "claude-opus-4-6"
    });
    assert.deepEqual(config, {
      primary: "claude-sonnet-4-6",
      fallbacks: [],
      source: "explicit"
    });
  } finally {
    process.chdir(originalCwd);
    if (originalGsdHome === void 0) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempGsdHome, { recursive: true, force: true });
  }
});
test("selectAndApplyModel honors explicit phase models without downgrading (#3617)", async () => {
  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;
  const tempProject = makeTempDir("gsd-routing-project-");
  const tempGsdHome = makeTempDir("gsd-routing-home-");
  const setModelCalls = [];
  let beforeModelSelectCalled = false;
  try {
    mkdirSync(join(tempProject, ".gsd"), { recursive: true });
    writeFileSync(
      join(tempProject, ".gsd", "PREFERENCES.md"),
      [
        "---",
        "models:",
        "  planning: claude-opus-4-6",
        "dynamic_routing:",
        "  enabled: true",
        "  tier_models:",
        "    light: gpt-4o-mini",
        "    standard: claude-sonnet-4-6",
        "    heavy: claude-opus-4-6",
        "---"
      ].join("\n"),
      "utf-8"
    );
    process.env.GSD_HOME = tempGsdHome;
    process.chdir(tempProject);
    const availableModels = [
      { id: "claude-opus-4-6", provider: "anthropic", api: "anthropic-messages" },
      { id: "claude-sonnet-4-6", provider: "anthropic", api: "anthropic-messages" },
      { id: "gpt-4o-mini", provider: "openai", api: "responses" }
    ];
    const result = await selectAndApplyModel(
      {
        modelRegistry: { getAvailable: () => availableModels },
        sessionManager: { getSessionId: () => "test-session" },
        ui: { notify: () => {
        } },
        model: { provider: "anthropic", id: "claude-opus-4-6", api: "anthropic-messages" }
      },
      {
        setModel: async (model) => {
          setModelCalls.push(`${model.provider}/${model.id}`);
          return true;
        },
        emitBeforeModelSelect: async () => {
          beforeModelSelectCalled = true;
          return void 0;
        },
        getActiveTools: () => [],
        emitAdjustToolSet: async () => void 0,
        setActiveTools: () => {
        }
      },
      "plan-slice",
      "slice-1",
      tempProject,
      void 0,
      false,
      { provider: "anthropic", id: "claude-opus-4-6" },
      void 0,
      true
    );
    assert.equal(beforeModelSelectCalled, false, "explicit phase models should skip dynamic routing hooks");
    assert.deepEqual(setModelCalls, ["anthropic/claude-opus-4-6"]);
    assert.equal(result.routing, null, "explicit phase models should not record a routing downgrade");
    assert.equal(result.appliedModel?.provider, "anthropic");
    assert.equal(result.appliedModel?.id, "claude-opus-4-6");
  } finally {
    process.chdir(originalCwd);
    if (originalGsdHome === void 0) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempGsdHome, { recursive: true, force: true });
  }
});
test("selectAndApplyModel escalates dynamic routing tier when retry metadata is provided", async (t) => {
  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;
  const tempProject = makeTempDir("gsd-routing-retry-project-");
  const tempGsdHome = makeTempDir("gsd-routing-retry-home-");
  const setModelCalls = [];
  const notifications = [];
  t.after(() => {
    process.chdir(originalCwd);
    if (originalGsdHome === void 0) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempGsdHome, { recursive: true, force: true });
  });
  mkdirSync(join(tempProject, ".gsd"), { recursive: true });
  writeFileSync(
    join(tempProject, ".gsd", "PREFERENCES.md"),
    [
      "---",
      "dynamic_routing:",
      "  enabled: true",
      "  hooks: false",
      "  budget_pressure: false",
      "  tier_models:",
      "    light: claude-haiku-4-5",
      "    standard: claude-sonnet-4-6",
      "    heavy: claude-opus-4-6",
      "---"
    ].join("\n"),
    "utf-8"
  );
  process.env.GSD_HOME = tempGsdHome;
  process.chdir(tempProject);
  const availableModels = [
    { id: "claude-haiku-4-5", provider: "anthropic", api: "anthropic-messages" },
    { id: "claude-sonnet-4-6", provider: "anthropic", api: "anthropic-messages" },
    { id: "claude-opus-4-6", provider: "anthropic", api: "anthropic-messages" }
  ];
  const result = await selectAndApplyModel(
    {
      modelRegistry: { getAvailable: () => availableModels },
      sessionManager: { getSessionId: () => "test-session" },
      ui: { notify: (message, level) => notifications.push({ message, level }) },
      model: { provider: "anthropic", id: "claude-opus-4-6", api: "anthropic-messages" }
    },
    {
      setModel: async (model) => {
        setModelCalls.push(`${model.provider}/${model.id}`);
        return true;
      },
      emitBeforeModelSelect: async () => void 0,
      getActiveTools: () => [],
      emitAdjustToolSet: async () => void 0,
      setActiveTools: () => {
      }
    },
    "execute-task",
    "M001/S01/T01",
    tempProject,
    void 0,
    false,
    { provider: "anthropic", id: "claude-opus-4-6" },
    { isRetry: true, previousTier: "light" },
    true
  );
  assert.deepEqual(setModelCalls, ["anthropic/claude-sonnet-4-6"]);
  assert.deepEqual(result.routing, { tier: "standard", modelDowngraded: true });
  assert.equal(result.appliedModel?.id, "claude-sonnet-4-6");
  assert.ok(
    notifications.some((n) => n.message.includes("Tier escalation: light") && n.message.includes("standard")),
    "retry metadata should produce a visible tier escalation notification"
  );
});
test("resolveModelId: bare ID resolves to claude-code when session is claude-code (#3772)", () => {
  const availableModels = [
    { id: "claude-sonnet-4-6", provider: "anthropic" },
    { id: "claude-sonnet-4-6", provider: "claude-code" }
  ];
  const result = resolveModelId("claude-sonnet-4-6", availableModels, "claude-code");
  assert.ok(result, "should resolve a model");
  assert.equal(result.provider, "claude-code", "bare ID must resolve to claude-code when session provider is claude-code");
});
test("resolveModelId: bare ID still prefers current provider when it is a first-class API provider", () => {
  const availableModels = [
    { id: "claude-sonnet-4-6", provider: "anthropic" },
    { id: "claude-sonnet-4-6", provider: "bedrock" }
  ];
  const result = resolveModelId("claude-sonnet-4-6", availableModels, "bedrock");
  assert.ok(result, "should resolve a model");
  assert.equal(result.provider, "bedrock", "bare ID should prefer current provider when it is a real API provider");
});
test("resolveModelId: explicit provider/model format still resolves to claude-code when specified", () => {
  const availableModels = [
    { id: "claude-sonnet-4-6", provider: "anthropic" },
    { id: "claude-sonnet-4-6", provider: "claude-code" }
  ];
  const result = resolveModelId("claude-code/claude-sonnet-4-6", availableModels, "anthropic");
  assert.ok(result, "should resolve a model");
  assert.equal(result.provider, "claude-code", "explicit provider prefix must be respected");
});
test("resolveModelId: bare ID with only one provider works normally", () => {
  const availableModels = [
    { id: "claude-sonnet-4-6", provider: "anthropic" }
  ];
  const result = resolveModelId("claude-sonnet-4-6", availableModels, "anthropic");
  assert.ok(result, "should resolve a model");
  assert.equal(result.provider, "anthropic");
});
test("resolveModelId: bare ID with claude-code as only provider still resolves", () => {
  const availableModels = [
    { id: "claude-sonnet-4-6", provider: "claude-code" }
  ];
  const result = resolveModelId("claude-sonnet-4-6", availableModels, "claude-code");
  assert.ok(result, "should resolve even when only available via claude-code");
  assert.equal(result.provider, "claude-code");
});
test("model change notify in selectAndApplyModel is gated behind verbose flag", async (t) => {
  const originalCwd = process.cwd();
  const tempProject = makeTempDir("gsd-routing-verbose-project-");
  const notifications = [];
  t.after(() => {
    process.chdir(originalCwd);
    rmSync(tempProject, { recursive: true, force: true });
  });
  mkdirSync(join(tempProject, ".gsd"), { recursive: true });
  writeFileSync(
    join(tempProject, ".gsd", "PREFERENCES.md"),
    ["---", "models:", "  planning: claude-sonnet-4-6", "---"].join("\n"),
    "utf-8"
  );
  process.chdir(tempProject);
  await selectAndApplyModel(
    {
      modelRegistry: { getAvailable: () => [{ id: "claude-sonnet-4-6", provider: "anthropic", api: "anthropic-messages" }] },
      sessionManager: { getSessionId: () => "test-session" },
      ui: { notify: (message, level) => notifications.push({ message, level }) },
      model: { provider: "anthropic", id: "claude-sonnet-4-6", api: "anthropic-messages" }
    },
    {
      setModel: async () => true,
      emitBeforeModelSelect: async () => void 0,
      getActiveTools: () => [],
      emitAdjustToolSet: async () => void 0,
      setActiveTools: () => {
      }
    },
    "plan-slice",
    "M001/S01",
    tempProject,
    void 0,
    false,
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    void 0,
    true
  );
  assert.deepEqual(notifications, []);
});
test("selectAndApplyModel re-applies captured thinking level after setModel success", async (t) => {
  const originalCwd = process.cwd();
  const tempProject = makeTempDir("gsd-routing-thinking-project-");
  const thinkingLevels = [];
  t.after(() => {
    process.chdir(originalCwd);
    rmSync(tempProject, { recursive: true, force: true });
  });
  mkdirSync(join(tempProject, ".gsd"), { recursive: true });
  writeFileSync(
    join(tempProject, ".gsd", "PREFERENCES.md"),
    ["---", "models:", "  planning: claude-sonnet-4-6", "---"].join("\n"),
    "utf-8"
  );
  process.chdir(tempProject);
  await selectAndApplyModel(
    {
      modelRegistry: { getAvailable: () => [{ id: "claude-sonnet-4-6", provider: "anthropic", api: "anthropic-messages" }] },
      sessionManager: { getSessionId: () => "test-session" },
      ui: { notify: () => {
      } },
      model: { provider: "anthropic", id: "claude-sonnet-4-6", api: "anthropic-messages" }
    },
    {
      setModel: async () => true,
      setThinkingLevel: (level) => {
        thinkingLevels.push(level);
      },
      emitBeforeModelSelect: async () => void 0,
      getActiveTools: () => [],
      emitAdjustToolSet: async () => void 0,
      setActiveTools: () => {
      }
    },
    "plan-slice",
    "M001/S01",
    tempProject,
    void 0,
    false,
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    void 0,
    true,
    void 0,
    { effort: "high" }
  );
  assert.deepEqual(thinkingLevels, [{ effort: "high" }]);
});
test("resolveModelId: anthropic wins over claude-code when session provider is not claude-code", () => {
  const availableModels = [
    { id: "claude-sonnet-4-6", provider: "claude-code" },
    { id: "claude-sonnet-4-6", provider: "anthropic" }
  ];
  const result = resolveModelId("claude-sonnet-4-6", availableModels, void 0);
  assert.ok(result, "should resolve a model");
  assert.equal(result.provider, "anthropic", "anthropic must win when session is not claude-code");
});
test("resolveModelId: claude-code wins when session is claude-code regardless of list order", () => {
  const availableModels = [
    { id: "claude-sonnet-4-6", provider: "claude-code" },
    { id: "claude-sonnet-4-6", provider: "anthropic" }
  ];
  const result = resolveModelId("claude-sonnet-4-6", availableModels, "claude-code");
  assert.ok(result, "should resolve a model");
  assert.equal(result.provider, "claude-code", "claude-code must win when it is the session provider");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9hdXRvLW1vZGVsLXNlbGVjdGlvbi50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBta2RpclN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBkaXJuYW1lLCBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcblxuY29uc3QgX19kaXJuYW1lID0gZGlybmFtZShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuXG5pbXBvcnQgeyByZXNvbHZlUHJlZmVycmVkTW9kZWxDb25maWcsIHJlc29sdmVNb2RlbElkLCBzZWxlY3RBbmRBcHBseU1vZGVsIH0gZnJvbSBcIi4uL2F1dG8tbW9kZWwtc2VsZWN0aW9uLmpzXCI7XG5cbmZ1bmN0aW9uIG1ha2VUZW1wRGlyKHByZWZpeDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIHByZWZpeCkpO1xufVxuXG50ZXN0KFwicmVzb2x2ZVByZWZlcnJlZE1vZGVsQ29uZmlnIHN5bnRoZXNpemVzIGhlYXZ5IHJvdXRpbmcgY2VpbGluZyB3aGVuIG1vZGVscyBzZWN0aW9uIGlzIGFic2VudFwiLCAoKSA9PiB7XG4gIGNvbnN0IG9yaWdpbmFsQ3dkID0gcHJvY2Vzcy5jd2QoKTtcbiAgY29uc3Qgb3JpZ2luYWxHc2RIb21lID0gcHJvY2Vzcy5lbnYuR1NEX0hPTUU7XG4gIGNvbnN0IHRlbXBQcm9qZWN0ID0gbWFrZVRlbXBEaXIoXCJnc2Qtcm91dGluZy1wcm9qZWN0LVwiKTtcbiAgY29uc3QgdGVtcEdzZEhvbWUgPSBtYWtlVGVtcERpcihcImdzZC1yb3V0aW5nLWhvbWUtXCIpO1xuXG4gIHRyeSB7XG4gICAgbWtkaXJTeW5jKGpvaW4odGVtcFByb2plY3QsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4odGVtcFByb2plY3QsIFwiLmdzZFwiLCBcIlBSRUZFUkVOQ0VTLm1kXCIpLFxuICAgICAgW1xuICAgICAgICBcIi0tLVwiLFxuICAgICAgICBcImR5bmFtaWNfcm91dGluZzpcIixcbiAgICAgICAgXCIgIGVuYWJsZWQ6IHRydWVcIixcbiAgICAgICAgXCIgIHRpZXJfbW9kZWxzOlwiLFxuICAgICAgICBcIiAgICBsaWdodDogY2xhdWRlLWhhaWt1LTQtNVwiLFxuICAgICAgICBcIiAgICBzdGFuZGFyZDogY2xhdWRlLXNvbm5ldC00LTZcIixcbiAgICAgICAgXCIgICAgaGVhdnk6IGNsYXVkZS1vcHVzLTQtNlwiLFxuICAgICAgICBcIi0tLVwiLFxuICAgICAgXS5qb2luKFwiXFxuXCIpLFxuICAgICAgXCJ1dGYtOFwiLFxuICAgICk7XG4gICAgcHJvY2Vzcy5lbnYuR1NEX0hPTUUgPSB0ZW1wR3NkSG9tZTtcbiAgICBwcm9jZXNzLmNoZGlyKHRlbXBQcm9qZWN0KTtcblxuICAgIGNvbnN0IGNvbmZpZyA9IHJlc29sdmVQcmVmZXJyZWRNb2RlbENvbmZpZyhcInBsYW4tc2xpY2VcIiwge1xuICAgICAgcHJvdmlkZXI6IFwiYW50aHJvcGljXCIsXG4gICAgICBpZDogXCJjbGF1ZGUtc29ubmV0LTQtNlwiLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmRlZXBFcXVhbChjb25maWcsIHtcbiAgICAgIHByaW1hcnk6IFwiY2xhdWRlLW9wdXMtNC02XCIsXG4gICAgICBmYWxsYmFja3M6IFtdLFxuICAgICAgc291cmNlOiBcInN5bnRoZXNpemVkXCIsXG4gICAgfSk7XG4gIH0gZmluYWxseSB7XG4gICAgcHJvY2Vzcy5jaGRpcihvcmlnaW5hbEN3ZCk7XG4gICAgaWYgKG9yaWdpbmFsR3NkSG9tZSA9PT0gdW5kZWZpbmVkKSBkZWxldGUgcHJvY2Vzcy5lbnYuR1NEX0hPTUU7XG4gICAgZWxzZSBwcm9jZXNzLmVudi5HU0RfSE9NRSA9IG9yaWdpbmFsR3NkSG9tZTtcbiAgICBybVN5bmModGVtcFByb2plY3QsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICBybVN5bmModGVtcEdzZEhvbWUsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJyZXNvbHZlUHJlZmVycmVkTW9kZWxDb25maWcgZmFsbHMgYmFjayB0byBhdXRvIHN0YXJ0IG1vZGVsIHdoZW4gaGVhdnkgdGllciBpcyBhYnNlbnRcIiwgKCkgPT4ge1xuICBjb25zdCBvcmlnaW5hbEN3ZCA9IHByb2Nlc3MuY3dkKCk7XG4gIGNvbnN0IG9yaWdpbmFsR3NkSG9tZSA9IHByb2Nlc3MuZW52LkdTRF9IT01FO1xuICBjb25zdCB0ZW1wUHJvamVjdCA9IG1ha2VUZW1wRGlyKFwiZ3NkLXJvdXRpbmctcHJvamVjdC1cIik7XG4gIGNvbnN0IHRlbXBHc2RIb21lID0gbWFrZVRlbXBEaXIoXCJnc2Qtcm91dGluZy1ob21lLVwiKTtcblxuICB0cnkge1xuICAgIG1rZGlyU3luYyhqb2luKHRlbXBQcm9qZWN0LCBcIi5nc2RcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKHRlbXBQcm9qZWN0LCBcIi5nc2RcIiwgXCJQUkVGRVJFTkNFUy5tZFwiKSxcbiAgICAgIFtcbiAgICAgICAgXCItLS1cIixcbiAgICAgICAgXCJkeW5hbWljX3JvdXRpbmc6XCIsXG4gICAgICAgIFwiICBlbmFibGVkOiB0cnVlXCIsXG4gICAgICAgIFwiICB0aWVyX21vZGVsczpcIixcbiAgICAgICAgXCIgICAgbGlnaHQ6IGNsYXVkZS1oYWlrdS00LTVcIixcbiAgICAgICAgXCIgICAgc3RhbmRhcmQ6IGNsYXVkZS1zb25uZXQtNC02XCIsXG4gICAgICAgIFwiLS0tXCIsXG4gICAgICBdLmpvaW4oXCJcXG5cIiksXG4gICAgICBcInV0Zi04XCIsXG4gICAgKTtcbiAgICBwcm9jZXNzLmVudi5HU0RfSE9NRSA9IHRlbXBHc2RIb21lO1xuICAgIHByb2Nlc3MuY2hkaXIodGVtcFByb2plY3QpO1xuXG4gICAgY29uc3QgY29uZmlnID0gcmVzb2x2ZVByZWZlcnJlZE1vZGVsQ29uZmlnKFwiZXhlY3V0ZS10YXNrXCIsIHtcbiAgICAgIHByb3ZpZGVyOiBcIm9wZW5haVwiLFxuICAgICAgaWQ6IFwiZ3B0LTUuNFwiLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmRlZXBFcXVhbChjb25maWcsIHtcbiAgICAgIHByaW1hcnk6IFwib3BlbmFpL2dwdC01LjRcIixcbiAgICAgIGZhbGxiYWNrczogW10sXG4gICAgICBzb3VyY2U6IFwic3ludGhlc2l6ZWRcIixcbiAgICB9KTtcbiAgfSBmaW5hbGx5IHtcbiAgICBwcm9jZXNzLmNoZGlyKG9yaWdpbmFsQ3dkKTtcbiAgICBpZiAob3JpZ2luYWxHc2RIb21lID09PSB1bmRlZmluZWQpIGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfSE9NRTtcbiAgICBlbHNlIHByb2Nlc3MuZW52LkdTRF9IT01FID0gb3JpZ2luYWxHc2RIb21lO1xuICAgIHJtU3luYyh0ZW1wUHJvamVjdCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIHJtU3luYyh0ZW1wR3NkSG9tZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcInJlc29sdmVQcmVmZXJyZWRNb2RlbENvbmZpZyBrZWVwcyBleHBsaWNpdCBwaGFzZSBtb2RlbHMgYXMgdGhlIGNlaWxpbmdcIiwgKCkgPT4ge1xuICBjb25zdCBvcmlnaW5hbEN3ZCA9IHByb2Nlc3MuY3dkKCk7XG4gIGNvbnN0IG9yaWdpbmFsR3NkSG9tZSA9IHByb2Nlc3MuZW52LkdTRF9IT01FO1xuICBjb25zdCB0ZW1wUHJvamVjdCA9IG1ha2VUZW1wRGlyKFwiZ3NkLXJvdXRpbmctcHJvamVjdC1cIik7XG4gIGNvbnN0IHRlbXBHc2RIb21lID0gbWFrZVRlbXBEaXIoXCJnc2Qtcm91dGluZy1ob21lLVwiKTtcblxuICB0cnkge1xuICAgIG1rZGlyU3luYyhqb2luKHRlbXBQcm9qZWN0LCBcIi5nc2RcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKHRlbXBQcm9qZWN0LCBcIi5nc2RcIiwgXCJQUkVGRVJFTkNFUy5tZFwiKSxcbiAgICAgIFtcbiAgICAgICAgXCItLS1cIixcbiAgICAgICAgXCJtb2RlbHM6XCIsXG4gICAgICAgIFwiICBwbGFubmluZzogY2xhdWRlLXNvbm5ldC00LTZcIixcbiAgICAgICAgXCJkeW5hbWljX3JvdXRpbmc6XCIsXG4gICAgICAgIFwiICBlbmFibGVkOiB0cnVlXCIsXG4gICAgICAgIFwiICB0aWVyX21vZGVsczpcIixcbiAgICAgICAgXCIgICAgaGVhdnk6IGNsYXVkZS1vcHVzLTQtNlwiLFxuICAgICAgICBcIi0tLVwiLFxuICAgICAgXS5qb2luKFwiXFxuXCIpLFxuICAgICAgXCJ1dGYtOFwiLFxuICAgICk7XG4gICAgcHJvY2Vzcy5lbnYuR1NEX0hPTUUgPSB0ZW1wR3NkSG9tZTtcbiAgICBwcm9jZXNzLmNoZGlyKHRlbXBQcm9qZWN0KTtcblxuICAgIGNvbnN0IGNvbmZpZyA9IHJlc29sdmVQcmVmZXJyZWRNb2RlbENvbmZpZyhcInBsYW4tc2xpY2VcIiwge1xuICAgICAgcHJvdmlkZXI6IFwiYW50aHJvcGljXCIsXG4gICAgICBpZDogXCJjbGF1ZGUtb3B1cy00LTZcIixcbiAgICB9KTtcblxuICAgIGFzc2VydC5kZWVwRXF1YWwoY29uZmlnLCB7XG4gICAgICBwcmltYXJ5OiBcImNsYXVkZS1zb25uZXQtNC02XCIsXG4gICAgICBmYWxsYmFja3M6IFtdLFxuICAgICAgc291cmNlOiBcImV4cGxpY2l0XCIsXG4gICAgfSk7XG4gIH0gZmluYWxseSB7XG4gICAgcHJvY2Vzcy5jaGRpcihvcmlnaW5hbEN3ZCk7XG4gICAgaWYgKG9yaWdpbmFsR3NkSG9tZSA9PT0gdW5kZWZpbmVkKSBkZWxldGUgcHJvY2Vzcy5lbnYuR1NEX0hPTUU7XG4gICAgZWxzZSBwcm9jZXNzLmVudi5HU0RfSE9NRSA9IG9yaWdpbmFsR3NkSG9tZTtcbiAgICBybVN5bmModGVtcFByb2plY3QsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICBybVN5bmModGVtcEdzZEhvbWUsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJzZWxlY3RBbmRBcHBseU1vZGVsIGhvbm9ycyBleHBsaWNpdCBwaGFzZSBtb2RlbHMgd2l0aG91dCBkb3duZ3JhZGluZyAoIzM2MTcpXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3Qgb3JpZ2luYWxDd2QgPSBwcm9jZXNzLmN3ZCgpO1xuICBjb25zdCBvcmlnaW5hbEdzZEhvbWUgPSBwcm9jZXNzLmVudi5HU0RfSE9NRTtcbiAgY29uc3QgdGVtcFByb2plY3QgPSBtYWtlVGVtcERpcihcImdzZC1yb3V0aW5nLXByb2plY3QtXCIpO1xuICBjb25zdCB0ZW1wR3NkSG9tZSA9IG1ha2VUZW1wRGlyKFwiZ3NkLXJvdXRpbmctaG9tZS1cIik7XG4gIGNvbnN0IHNldE1vZGVsQ2FsbHM6IHN0cmluZ1tdID0gW107XG4gIGxldCBiZWZvcmVNb2RlbFNlbGVjdENhbGxlZCA9IGZhbHNlO1xuXG4gIHRyeSB7XG4gICAgbWtkaXJTeW5jKGpvaW4odGVtcFByb2plY3QsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4odGVtcFByb2plY3QsIFwiLmdzZFwiLCBcIlBSRUZFUkVOQ0VTLm1kXCIpLFxuICAgICAgW1xuICAgICAgICBcIi0tLVwiLFxuICAgICAgICBcIm1vZGVsczpcIixcbiAgICAgICAgXCIgIHBsYW5uaW5nOiBjbGF1ZGUtb3B1cy00LTZcIixcbiAgICAgICAgXCJkeW5hbWljX3JvdXRpbmc6XCIsXG4gICAgICAgIFwiICBlbmFibGVkOiB0cnVlXCIsXG4gICAgICAgIFwiICB0aWVyX21vZGVsczpcIixcbiAgICAgICAgXCIgICAgbGlnaHQ6IGdwdC00by1taW5pXCIsXG4gICAgICAgIFwiICAgIHN0YW5kYXJkOiBjbGF1ZGUtc29ubmV0LTQtNlwiLFxuICAgICAgICBcIiAgICBoZWF2eTogY2xhdWRlLW9wdXMtNC02XCIsXG4gICAgICAgIFwiLS0tXCIsXG4gICAgICBdLmpvaW4oXCJcXG5cIiksXG4gICAgICBcInV0Zi04XCIsXG4gICAgKTtcbiAgICBwcm9jZXNzLmVudi5HU0RfSE9NRSA9IHRlbXBHc2RIb21lO1xuICAgIHByb2Nlc3MuY2hkaXIodGVtcFByb2plY3QpO1xuXG4gICAgY29uc3QgYXZhaWxhYmxlTW9kZWxzID0gW1xuICAgICAgeyBpZDogXCJjbGF1ZGUtb3B1cy00LTZcIiwgcHJvdmlkZXI6IFwiYW50aHJvcGljXCIsIGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIiB9LFxuICAgICAgeyBpZDogXCJjbGF1ZGUtc29ubmV0LTQtNlwiLCBwcm92aWRlcjogXCJhbnRocm9waWNcIiwgYXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiIH0sXG4gICAgICB7IGlkOiBcImdwdC00by1taW5pXCIsIHByb3ZpZGVyOiBcIm9wZW5haVwiLCBhcGk6IFwicmVzcG9uc2VzXCIgfSxcbiAgICBdO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgc2VsZWN0QW5kQXBwbHlNb2RlbChcbiAgICAgIHtcbiAgICAgICAgbW9kZWxSZWdpc3RyeTogeyBnZXRBdmFpbGFibGU6ICgpID0+IGF2YWlsYWJsZU1vZGVscyB9LFxuICAgICAgICBzZXNzaW9uTWFuYWdlcjogeyBnZXRTZXNzaW9uSWQ6ICgpID0+IFwidGVzdC1zZXNzaW9uXCIgfSxcbiAgICAgICAgdWk6IHsgbm90aWZ5OiAoKSA9PiB7fSB9LFxuICAgICAgICBtb2RlbDogeyBwcm92aWRlcjogXCJhbnRocm9waWNcIiwgaWQ6IFwiY2xhdWRlLW9wdXMtNC02XCIsIGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIiB9LFxuICAgICAgfSBhcyBhbnksXG4gICAgICB7XG4gICAgICAgIHNldE1vZGVsOiBhc3luYyAobW9kZWw6IHsgcHJvdmlkZXI6IHN0cmluZzsgaWQ6IHN0cmluZyB9KSA9PiB7XG4gICAgICAgICAgc2V0TW9kZWxDYWxscy5wdXNoKGAke21vZGVsLnByb3ZpZGVyfS8ke21vZGVsLmlkfWApO1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LFxuICAgICAgICBlbWl0QmVmb3JlTW9kZWxTZWxlY3Q6IGFzeW5jICgpID0+IHtcbiAgICAgICAgICBiZWZvcmVNb2RlbFNlbGVjdENhbGxlZCA9IHRydWU7XG4gICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfSxcbiAgICAgICAgZ2V0QWN0aXZlVG9vbHM6ICgpID0+IFtdLFxuICAgICAgICBlbWl0QWRqdXN0VG9vbFNldDogYXN5bmMgKCkgPT4gdW5kZWZpbmVkLFxuICAgICAgICBzZXRBY3RpdmVUb29sczogKCkgPT4ge30sXG4gICAgICB9IGFzIGFueSxcbiAgICAgIFwicGxhbi1zbGljZVwiLFxuICAgICAgXCJzbGljZS0xXCIsXG4gICAgICB0ZW1wUHJvamVjdCxcbiAgICAgIHVuZGVmaW5lZCxcbiAgICAgIGZhbHNlLFxuICAgICAgeyBwcm92aWRlcjogXCJhbnRocm9waWNcIiwgaWQ6IFwiY2xhdWRlLW9wdXMtNC02XCIgfSxcbiAgICAgIHVuZGVmaW5lZCxcbiAgICAgIHRydWUsXG4gICAgKTtcblxuICAgIGFzc2VydC5lcXVhbChiZWZvcmVNb2RlbFNlbGVjdENhbGxlZCwgZmFsc2UsIFwiZXhwbGljaXQgcGhhc2UgbW9kZWxzIHNob3VsZCBza2lwIGR5bmFtaWMgcm91dGluZyBob29rc1wiKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHNldE1vZGVsQ2FsbHMsIFtcImFudGhyb3BpYy9jbGF1ZGUtb3B1cy00LTZcIl0pO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQucm91dGluZywgbnVsbCwgXCJleHBsaWNpdCBwaGFzZSBtb2RlbHMgc2hvdWxkIG5vdCByZWNvcmQgYSByb3V0aW5nIGRvd25ncmFkZVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmFwcGxpZWRNb2RlbD8ucHJvdmlkZXIsIFwiYW50aHJvcGljXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuYXBwbGllZE1vZGVsPy5pZCwgXCJjbGF1ZGUtb3B1cy00LTZcIik7XG4gIH0gZmluYWxseSB7XG4gICAgcHJvY2Vzcy5jaGRpcihvcmlnaW5hbEN3ZCk7XG4gICAgaWYgKG9yaWdpbmFsR3NkSG9tZSA9PT0gdW5kZWZpbmVkKSBkZWxldGUgcHJvY2Vzcy5lbnYuR1NEX0hPTUU7XG4gICAgZWxzZSBwcm9jZXNzLmVudi5HU0RfSE9NRSA9IG9yaWdpbmFsR3NkSG9tZTtcbiAgICBybVN5bmModGVtcFByb2plY3QsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICBybVN5bmModGVtcEdzZEhvbWUsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJzZWxlY3RBbmRBcHBseU1vZGVsIGVzY2FsYXRlcyBkeW5hbWljIHJvdXRpbmcgdGllciB3aGVuIHJldHJ5IG1ldGFkYXRhIGlzIHByb3ZpZGVkXCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IG9yaWdpbmFsQ3dkID0gcHJvY2Vzcy5jd2QoKTtcbiAgY29uc3Qgb3JpZ2luYWxHc2RIb21lID0gcHJvY2Vzcy5lbnYuR1NEX0hPTUU7XG4gIGNvbnN0IHRlbXBQcm9qZWN0ID0gbWFrZVRlbXBEaXIoXCJnc2Qtcm91dGluZy1yZXRyeS1wcm9qZWN0LVwiKTtcbiAgY29uc3QgdGVtcEdzZEhvbWUgPSBtYWtlVGVtcERpcihcImdzZC1yb3V0aW5nLXJldHJ5LWhvbWUtXCIpO1xuICBjb25zdCBzZXRNb2RlbENhbGxzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBub3RpZmljYXRpb25zOiBBcnJheTx7IG1lc3NhZ2U6IHN0cmluZzsgbGV2ZWw6IHN0cmluZyB9PiA9IFtdO1xuXG4gIHQuYWZ0ZXIoKCkgPT4ge1xuICAgIHByb2Nlc3MuY2hkaXIob3JpZ2luYWxDd2QpO1xuICAgIGlmIChvcmlnaW5hbEdzZEhvbWUgPT09IHVuZGVmaW5lZCkgZGVsZXRlIHByb2Nlc3MuZW52LkdTRF9IT01FO1xuICAgIGVsc2UgcHJvY2Vzcy5lbnYuR1NEX0hPTUUgPSBvcmlnaW5hbEdzZEhvbWU7XG4gICAgcm1TeW5jKHRlbXBQcm9qZWN0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgcm1TeW5jKHRlbXBHc2RIb21lLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH0pO1xuXG4gIG1rZGlyU3luYyhqb2luKHRlbXBQcm9qZWN0LCBcIi5nc2RcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4odGVtcFByb2plY3QsIFwiLmdzZFwiLCBcIlBSRUZFUkVOQ0VTLm1kXCIpLFxuICAgIFtcbiAgICAgIFwiLS0tXCIsXG4gICAgICBcImR5bmFtaWNfcm91dGluZzpcIixcbiAgICAgIFwiICBlbmFibGVkOiB0cnVlXCIsXG4gICAgICBcIiAgaG9va3M6IGZhbHNlXCIsXG4gICAgICBcIiAgYnVkZ2V0X3ByZXNzdXJlOiBmYWxzZVwiLFxuICAgICAgXCIgIHRpZXJfbW9kZWxzOlwiLFxuICAgICAgXCIgICAgbGlnaHQ6IGNsYXVkZS1oYWlrdS00LTVcIixcbiAgICAgIFwiICAgIHN0YW5kYXJkOiBjbGF1ZGUtc29ubmV0LTQtNlwiLFxuICAgICAgXCIgICAgaGVhdnk6IGNsYXVkZS1vcHVzLTQtNlwiLFxuICAgICAgXCItLS1cIixcbiAgICBdLmpvaW4oXCJcXG5cIiksXG4gICAgXCJ1dGYtOFwiLFxuICApO1xuICBwcm9jZXNzLmVudi5HU0RfSE9NRSA9IHRlbXBHc2RIb21lO1xuICBwcm9jZXNzLmNoZGlyKHRlbXBQcm9qZWN0KTtcblxuICBjb25zdCBhdmFpbGFibGVNb2RlbHMgPSBbXG4gICAgeyBpZDogXCJjbGF1ZGUtaGFpa3UtNC01XCIsIHByb3ZpZGVyOiBcImFudGhyb3BpY1wiLCBhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIgfSxcbiAgICB7IGlkOiBcImNsYXVkZS1zb25uZXQtNC02XCIsIHByb3ZpZGVyOiBcImFudGhyb3BpY1wiLCBhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIgfSxcbiAgICB7IGlkOiBcImNsYXVkZS1vcHVzLTQtNlwiLCBwcm92aWRlcjogXCJhbnRocm9waWNcIiwgYXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiIH0sXG4gIF07XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgc2VsZWN0QW5kQXBwbHlNb2RlbChcbiAgICB7XG4gICAgICBtb2RlbFJlZ2lzdHJ5OiB7IGdldEF2YWlsYWJsZTogKCkgPT4gYXZhaWxhYmxlTW9kZWxzIH0sXG4gICAgICBzZXNzaW9uTWFuYWdlcjogeyBnZXRTZXNzaW9uSWQ6ICgpID0+IFwidGVzdC1zZXNzaW9uXCIgfSxcbiAgICAgIHVpOiB7IG5vdGlmeTogKG1lc3NhZ2U6IHN0cmluZywgbGV2ZWw6IHN0cmluZykgPT4gbm90aWZpY2F0aW9ucy5wdXNoKHsgbWVzc2FnZSwgbGV2ZWwgfSkgfSxcbiAgICAgIG1vZGVsOiB7IHByb3ZpZGVyOiBcImFudGhyb3BpY1wiLCBpZDogXCJjbGF1ZGUtb3B1cy00LTZcIiwgYXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiIH0sXG4gICAgfSBhcyBhbnksXG4gICAge1xuICAgICAgc2V0TW9kZWw6IGFzeW5jIChtb2RlbDogeyBwcm92aWRlcjogc3RyaW5nOyBpZDogc3RyaW5nIH0pID0+IHtcbiAgICAgICAgc2V0TW9kZWxDYWxscy5wdXNoKGAke21vZGVsLnByb3ZpZGVyfS8ke21vZGVsLmlkfWApO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH0sXG4gICAgICBlbWl0QmVmb3JlTW9kZWxTZWxlY3Q6IGFzeW5jICgpID0+IHVuZGVmaW5lZCxcbiAgICAgIGdldEFjdGl2ZVRvb2xzOiAoKSA9PiBbXSxcbiAgICAgIGVtaXRBZGp1c3RUb29sU2V0OiBhc3luYyAoKSA9PiB1bmRlZmluZWQsXG4gICAgICBzZXRBY3RpdmVUb29sczogKCkgPT4ge30sXG4gICAgfSBhcyBhbnksXG4gICAgXCJleGVjdXRlLXRhc2tcIixcbiAgICBcIk0wMDEvUzAxL1QwMVwiLFxuICAgIHRlbXBQcm9qZWN0LFxuICAgIHVuZGVmaW5lZCxcbiAgICBmYWxzZSxcbiAgICB7IHByb3ZpZGVyOiBcImFudGhyb3BpY1wiLCBpZDogXCJjbGF1ZGUtb3B1cy00LTZcIiB9LFxuICAgIHsgaXNSZXRyeTogdHJ1ZSwgcHJldmlvdXNUaWVyOiBcImxpZ2h0XCIgfSxcbiAgICB0cnVlLFxuICApO1xuXG4gIGFzc2VydC5kZWVwRXF1YWwoc2V0TW9kZWxDYWxscywgW1wiYW50aHJvcGljL2NsYXVkZS1zb25uZXQtNC02XCJdKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQucm91dGluZywgeyB0aWVyOiBcInN0YW5kYXJkXCIsIG1vZGVsRG93bmdyYWRlZDogdHJ1ZSB9KTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5hcHBsaWVkTW9kZWw/LmlkLCBcImNsYXVkZS1zb25uZXQtNC02XCIpO1xuICBhc3NlcnQub2soXG4gICAgbm90aWZpY2F0aW9ucy5zb21lKG4gPT4gbi5tZXNzYWdlLmluY2x1ZGVzKFwiVGllciBlc2NhbGF0aW9uOiBsaWdodFwiKSAmJiBuLm1lc3NhZ2UuaW5jbHVkZXMoXCJzdGFuZGFyZFwiKSksXG4gICAgXCJyZXRyeSBtZXRhZGF0YSBzaG91bGQgcHJvZHVjZSBhIHZpc2libGUgdGllciBlc2NhbGF0aW9uIG5vdGlmaWNhdGlvblwiLFxuICApO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCByZXNvbHZlTW9kZWxJZCB0ZXN0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcInJlc29sdmVNb2RlbElkOiBiYXJlIElEIHJlc29sdmVzIHRvIGNsYXVkZS1jb2RlIHdoZW4gc2Vzc2lvbiBpcyBjbGF1ZGUtY29kZSAoIzM3NzIpXCIsICgpID0+IHtcbiAgY29uc3QgYXZhaWxhYmxlTW9kZWxzID0gW1xuICAgIHsgaWQ6IFwiY2xhdWRlLXNvbm5ldC00LTZcIiwgcHJvdmlkZXI6IFwiYW50aHJvcGljXCIgfSxcbiAgICB7IGlkOiBcImNsYXVkZS1zb25uZXQtNC02XCIsIHByb3ZpZGVyOiBcImNsYXVkZS1jb2RlXCIgfSxcbiAgXTtcblxuICAvLyBXaGVuIGN1cnJlbnRQcm92aWRlciBpcyBcImNsYXVkZS1jb2RlXCIgKHNldCBieSBzdGFydHVwIG1pZ3JhdGlvbiBmb3Igc3Vic2NyaXB0aW9uXG4gIC8vIHVzZXJzKSwgYmFyZSBJRHMgbXVzdCByZXNvbHZlIHRvIGNsYXVkZS1jb2RlIHRvIGF2b2lkIHRoZSB0aGlyZC1wYXJ0eSBibG9jayAoIzM3NzIpLlxuICBjb25zdCByZXN1bHQgPSByZXNvbHZlTW9kZWxJZChcImNsYXVkZS1zb25uZXQtNC02XCIsIGF2YWlsYWJsZU1vZGVscywgXCJjbGF1ZGUtY29kZVwiKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdCwgXCJzaG91bGQgcmVzb2x2ZSBhIG1vZGVsXCIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnByb3ZpZGVyLCBcImNsYXVkZS1jb2RlXCIsIFwiYmFyZSBJRCBtdXN0IHJlc29sdmUgdG8gY2xhdWRlLWNvZGUgd2hlbiBzZXNzaW9uIHByb3ZpZGVyIGlzIGNsYXVkZS1jb2RlXCIpO1xufSk7XG5cbnRlc3QoXCJyZXNvbHZlTW9kZWxJZDogYmFyZSBJRCBzdGlsbCBwcmVmZXJzIGN1cnJlbnQgcHJvdmlkZXIgd2hlbiBpdCBpcyBhIGZpcnN0LWNsYXNzIEFQSSBwcm92aWRlclwiLCAoKSA9PiB7XG4gIGNvbnN0IGF2YWlsYWJsZU1vZGVscyA9IFtcbiAgICB7IGlkOiBcImNsYXVkZS1zb25uZXQtNC02XCIsIHByb3ZpZGVyOiBcImFudGhyb3BpY1wiIH0sXG4gICAgeyBpZDogXCJjbGF1ZGUtc29ubmV0LTQtNlwiLCBwcm92aWRlcjogXCJiZWRyb2NrXCIgfSxcbiAgXTtcblxuICBjb25zdCByZXN1bHQgPSByZXNvbHZlTW9kZWxJZChcImNsYXVkZS1zb25uZXQtNC02XCIsIGF2YWlsYWJsZU1vZGVscywgXCJiZWRyb2NrXCIpO1xuICBhc3NlcnQub2socmVzdWx0LCBcInNob3VsZCByZXNvbHZlIGEgbW9kZWxcIik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQucHJvdmlkZXIsIFwiYmVkcm9ja1wiLCBcImJhcmUgSUQgc2hvdWxkIHByZWZlciBjdXJyZW50IHByb3ZpZGVyIHdoZW4gaXQgaXMgYSByZWFsIEFQSSBwcm92aWRlclwiKTtcbn0pO1xuXG50ZXN0KFwicmVzb2x2ZU1vZGVsSWQ6IGV4cGxpY2l0IHByb3ZpZGVyL21vZGVsIGZvcm1hdCBzdGlsbCByZXNvbHZlcyB0byBjbGF1ZGUtY29kZSB3aGVuIHNwZWNpZmllZFwiLCAoKSA9PiB7XG4gIGNvbnN0IGF2YWlsYWJsZU1vZGVscyA9IFtcbiAgICB7IGlkOiBcImNsYXVkZS1zb25uZXQtNC02XCIsIHByb3ZpZGVyOiBcImFudGhyb3BpY1wiIH0sXG4gICAgeyBpZDogXCJjbGF1ZGUtc29ubmV0LTQtNlwiLCBwcm92aWRlcjogXCJjbGF1ZGUtY29kZVwiIH0sXG4gIF07XG5cbiAgY29uc3QgcmVzdWx0ID0gcmVzb2x2ZU1vZGVsSWQoXCJjbGF1ZGUtY29kZS9jbGF1ZGUtc29ubmV0LTQtNlwiLCBhdmFpbGFibGVNb2RlbHMsIFwiYW50aHJvcGljXCIpO1xuICBhc3NlcnQub2socmVzdWx0LCBcInNob3VsZCByZXNvbHZlIGEgbW9kZWxcIik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQucHJvdmlkZXIsIFwiY2xhdWRlLWNvZGVcIiwgXCJleHBsaWNpdCBwcm92aWRlciBwcmVmaXggbXVzdCBiZSByZXNwZWN0ZWRcIik7XG59KTtcblxudGVzdChcInJlc29sdmVNb2RlbElkOiBiYXJlIElEIHdpdGggb25seSBvbmUgcHJvdmlkZXIgd29ya3Mgbm9ybWFsbHlcIiwgKCkgPT4ge1xuICBjb25zdCBhdmFpbGFibGVNb2RlbHMgPSBbXG4gICAgeyBpZDogXCJjbGF1ZGUtc29ubmV0LTQtNlwiLCBwcm92aWRlcjogXCJhbnRocm9waWNcIiB9LFxuICBdO1xuXG4gIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVNb2RlbElkKFwiY2xhdWRlLXNvbm5ldC00LTZcIiwgYXZhaWxhYmxlTW9kZWxzLCBcImFudGhyb3BpY1wiKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdCwgXCJzaG91bGQgcmVzb2x2ZSBhIG1vZGVsXCIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnByb3ZpZGVyLCBcImFudGhyb3BpY1wiKTtcbn0pO1xuXG50ZXN0KFwicmVzb2x2ZU1vZGVsSWQ6IGJhcmUgSUQgd2l0aCBjbGF1ZGUtY29kZSBhcyBvbmx5IHByb3ZpZGVyIHN0aWxsIHJlc29sdmVzXCIsICgpID0+IHtcbiAgY29uc3QgYXZhaWxhYmxlTW9kZWxzID0gW1xuICAgIHsgaWQ6IFwiY2xhdWRlLXNvbm5ldC00LTZcIiwgcHJvdmlkZXI6IFwiY2xhdWRlLWNvZGVcIiB9LFxuICBdO1xuXG4gIC8vIElmIGNsYXVkZS1jb2RlIGlzIHRoZSBPTkxZIHByb3ZpZGVyIGZvciB0aGlzIG1vZGVsLCBpdCBzaG91bGQgc3RpbGwgcmVzb2x2ZVxuICBjb25zdCByZXN1bHQgPSByZXNvbHZlTW9kZWxJZChcImNsYXVkZS1zb25uZXQtNC02XCIsIGF2YWlsYWJsZU1vZGVscywgXCJjbGF1ZGUtY29kZVwiKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdCwgXCJzaG91bGQgcmVzb2x2ZSBldmVuIHdoZW4gb25seSBhdmFpbGFibGUgdmlhIGNsYXVkZS1jb2RlXCIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnByb3ZpZGVyLCBcImNsYXVkZS1jb2RlXCIpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBzZWxlY3RBbmRBcHBseU1vZGVsIHZlcmJvc2UtZ2F0aW5nIHRlc3RzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwibW9kZWwgY2hhbmdlIG5vdGlmeSBpbiBzZWxlY3RBbmRBcHBseU1vZGVsIGlzIGdhdGVkIGJlaGluZCB2ZXJib3NlIGZsYWdcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3Qgb3JpZ2luYWxDd2QgPSBwcm9jZXNzLmN3ZCgpO1xuICBjb25zdCB0ZW1wUHJvamVjdCA9IG1ha2VUZW1wRGlyKFwiZ3NkLXJvdXRpbmctdmVyYm9zZS1wcm9qZWN0LVwiKTtcbiAgY29uc3Qgbm90aWZpY2F0aW9uczogQXJyYXk8eyBtZXNzYWdlOiBzdHJpbmc7IGxldmVsOiBzdHJpbmcgfT4gPSBbXTtcbiAgdC5hZnRlcigoKSA9PiB7XG4gICAgcHJvY2Vzcy5jaGRpcihvcmlnaW5hbEN3ZCk7XG4gICAgcm1TeW5jKHRlbXBQcm9qZWN0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH0pO1xuXG4gIG1rZGlyU3luYyhqb2luKHRlbXBQcm9qZWN0LCBcIi5nc2RcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4odGVtcFByb2plY3QsIFwiLmdzZFwiLCBcIlBSRUZFUkVOQ0VTLm1kXCIpLFxuICAgIFtcIi0tLVwiLCBcIm1vZGVsczpcIiwgXCIgIHBsYW5uaW5nOiBjbGF1ZGUtc29ubmV0LTQtNlwiLCBcIi0tLVwiXS5qb2luKFwiXFxuXCIpLFxuICAgIFwidXRmLThcIixcbiAgKTtcbiAgcHJvY2Vzcy5jaGRpcih0ZW1wUHJvamVjdCk7XG5cbiAgYXdhaXQgc2VsZWN0QW5kQXBwbHlNb2RlbChcbiAgICB7XG4gICAgICBtb2RlbFJlZ2lzdHJ5OiB7IGdldEF2YWlsYWJsZTogKCkgPT4gW3sgaWQ6IFwiY2xhdWRlLXNvbm5ldC00LTZcIiwgcHJvdmlkZXI6IFwiYW50aHJvcGljXCIsIGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIiB9XSB9LFxuICAgICAgc2Vzc2lvbk1hbmFnZXI6IHsgZ2V0U2Vzc2lvbklkOiAoKSA9PiBcInRlc3Qtc2Vzc2lvblwiIH0sXG4gICAgICB1aTogeyBub3RpZnk6IChtZXNzYWdlOiBzdHJpbmcsIGxldmVsOiBzdHJpbmcpID0+IG5vdGlmaWNhdGlvbnMucHVzaCh7IG1lc3NhZ2UsIGxldmVsIH0pIH0sXG4gICAgICBtb2RlbDogeyBwcm92aWRlcjogXCJhbnRocm9waWNcIiwgaWQ6IFwiY2xhdWRlLXNvbm5ldC00LTZcIiwgYXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiIH0sXG4gICAgfSBhcyBhbnksXG4gICAge1xuICAgICAgc2V0TW9kZWw6IGFzeW5jICgpID0+IHRydWUsXG4gICAgICBlbWl0QmVmb3JlTW9kZWxTZWxlY3Q6IGFzeW5jICgpID0+IHVuZGVmaW5lZCxcbiAgICAgIGdldEFjdGl2ZVRvb2xzOiAoKSA9PiBbXSxcbiAgICAgIGVtaXRBZGp1c3RUb29sU2V0OiBhc3luYyAoKSA9PiB1bmRlZmluZWQsXG4gICAgICBzZXRBY3RpdmVUb29sczogKCkgPT4ge30sXG4gICAgfSBhcyBhbnksXG4gICAgXCJwbGFuLXNsaWNlXCIsXG4gICAgXCJNMDAxL1MwMVwiLFxuICAgIHRlbXBQcm9qZWN0LFxuICAgIHVuZGVmaW5lZCxcbiAgICBmYWxzZSxcbiAgICB7IHByb3ZpZGVyOiBcImFudGhyb3BpY1wiLCBpZDogXCJjbGF1ZGUtc29ubmV0LTQtNlwiIH0sXG4gICAgdW5kZWZpbmVkLFxuICAgIHRydWUsXG4gICk7XG5cbiAgYXNzZXJ0LmRlZXBFcXVhbChub3RpZmljYXRpb25zLCBbXSk7XG59KTtcblxudGVzdChcInNlbGVjdEFuZEFwcGx5TW9kZWwgcmUtYXBwbGllcyBjYXB0dXJlZCB0aGlua2luZyBsZXZlbCBhZnRlciBzZXRNb2RlbCBzdWNjZXNzXCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IG9yaWdpbmFsQ3dkID0gcHJvY2Vzcy5jd2QoKTtcbiAgY29uc3QgdGVtcFByb2plY3QgPSBtYWtlVGVtcERpcihcImdzZC1yb3V0aW5nLXRoaW5raW5nLXByb2plY3QtXCIpO1xuICBjb25zdCB0aGlua2luZ0xldmVsczogdW5rbm93bltdID0gW107XG4gIHQuYWZ0ZXIoKCkgPT4ge1xuICAgIHByb2Nlc3MuY2hkaXIob3JpZ2luYWxDd2QpO1xuICAgIHJtU3luYyh0ZW1wUHJvamVjdCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcblxuICBta2RpclN5bmMoam9pbih0ZW1wUHJvamVjdCwgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKHRlbXBQcm9qZWN0LCBcIi5nc2RcIiwgXCJQUkVGRVJFTkNFUy5tZFwiKSxcbiAgICBbXCItLS1cIiwgXCJtb2RlbHM6XCIsIFwiICBwbGFubmluZzogY2xhdWRlLXNvbm5ldC00LTZcIiwgXCItLS1cIl0uam9pbihcIlxcblwiKSxcbiAgICBcInV0Zi04XCIsXG4gICk7XG4gIHByb2Nlc3MuY2hkaXIodGVtcFByb2plY3QpO1xuXG4gIGF3YWl0IHNlbGVjdEFuZEFwcGx5TW9kZWwoXG4gICAge1xuICAgICAgbW9kZWxSZWdpc3RyeTogeyBnZXRBdmFpbGFibGU6ICgpID0+IFt7IGlkOiBcImNsYXVkZS1zb25uZXQtNC02XCIsIHByb3ZpZGVyOiBcImFudGhyb3BpY1wiLCBhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIgfV0gfSxcbiAgICAgIHNlc3Npb25NYW5hZ2VyOiB7IGdldFNlc3Npb25JZDogKCkgPT4gXCJ0ZXN0LXNlc3Npb25cIiB9LFxuICAgICAgdWk6IHsgbm90aWZ5OiAoKSA9PiB7fSB9LFxuICAgICAgbW9kZWw6IHsgcHJvdmlkZXI6IFwiYW50aHJvcGljXCIsIGlkOiBcImNsYXVkZS1zb25uZXQtNC02XCIsIGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIiB9LFxuICAgIH0gYXMgYW55LFxuICAgIHtcbiAgICAgIHNldE1vZGVsOiBhc3luYyAoKSA9PiB0cnVlLFxuICAgICAgc2V0VGhpbmtpbmdMZXZlbDogKGxldmVsOiB1bmtub3duKSA9PiB7IHRoaW5raW5nTGV2ZWxzLnB1c2gobGV2ZWwpOyB9LFxuICAgICAgZW1pdEJlZm9yZU1vZGVsU2VsZWN0OiBhc3luYyAoKSA9PiB1bmRlZmluZWQsXG4gICAgICBnZXRBY3RpdmVUb29sczogKCkgPT4gW10sXG4gICAgICBlbWl0QWRqdXN0VG9vbFNldDogYXN5bmMgKCkgPT4gdW5kZWZpbmVkLFxuICAgICAgc2V0QWN0aXZlVG9vbHM6ICgpID0+IHt9LFxuICAgIH0gYXMgYW55LFxuICAgIFwicGxhbi1zbGljZVwiLFxuICAgIFwiTTAwMS9TMDFcIixcbiAgICB0ZW1wUHJvamVjdCxcbiAgICB1bmRlZmluZWQsXG4gICAgZmFsc2UsXG4gICAgeyBwcm92aWRlcjogXCJhbnRocm9waWNcIiwgaWQ6IFwiY2xhdWRlLXNvbm5ldC00LTZcIiB9LFxuICAgIHVuZGVmaW5lZCxcbiAgICB0cnVlLFxuICAgIHVuZGVmaW5lZCxcbiAgICB7IGVmZm9ydDogXCJoaWdoXCIgfSBhcyBhbnksXG4gICk7XG5cbiAgYXNzZXJ0LmRlZXBFcXVhbCh0aGlua2luZ0xldmVscywgW3sgZWZmb3J0OiBcImhpZ2hcIiB9XSk7XG59KTtcblxudGVzdChcInJlc29sdmVNb2RlbElkOiBhbnRocm9waWMgd2lucyBvdmVyIGNsYXVkZS1jb2RlIHdoZW4gc2Vzc2lvbiBwcm92aWRlciBpcyBub3QgY2xhdWRlLWNvZGVcIiwgKCkgPT4ge1xuICBjb25zdCBhdmFpbGFibGVNb2RlbHMgPSBbXG4gICAgeyBpZDogXCJjbGF1ZGUtc29ubmV0LTQtNlwiLCBwcm92aWRlcjogXCJjbGF1ZGUtY29kZVwiIH0sXG4gICAgeyBpZDogXCJjbGF1ZGUtc29ubmV0LTQtNlwiLCBwcm92aWRlcjogXCJhbnRocm9waWNcIiB9LFxuICBdO1xuXG4gIC8vIFdoZW4gdGhlIHNlc3Npb24gaXMgTk9UIG9uIGNsYXVkZS1jb2RlLCBiYXJlIElEcyBzaG91bGQgcmVzb2x2ZSB0b1xuICAvLyB0aGUgY2Fub25pY2FsIGFudGhyb3BpYyBwcm92aWRlciAob3JpZ2luYWwgIzI5MDUgYmVoYXZpb3IgcHJlc2VydmVkKS5cbiAgY29uc3QgcmVzdWx0ID0gcmVzb2x2ZU1vZGVsSWQoXCJjbGF1ZGUtc29ubmV0LTQtNlwiLCBhdmFpbGFibGVNb2RlbHMsIHVuZGVmaW5lZCk7XG4gIGFzc2VydC5vayhyZXN1bHQsIFwic2hvdWxkIHJlc29sdmUgYSBtb2RlbFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5wcm92aWRlciwgXCJhbnRocm9waWNcIiwgXCJhbnRocm9waWMgbXVzdCB3aW4gd2hlbiBzZXNzaW9uIGlzIG5vdCBjbGF1ZGUtY29kZVwiKTtcbn0pO1xuXG50ZXN0KFwicmVzb2x2ZU1vZGVsSWQ6IGNsYXVkZS1jb2RlIHdpbnMgd2hlbiBzZXNzaW9uIGlzIGNsYXVkZS1jb2RlIHJlZ2FyZGxlc3Mgb2YgbGlzdCBvcmRlclwiLCAoKSA9PiB7XG4gIGNvbnN0IGF2YWlsYWJsZU1vZGVscyA9IFtcbiAgICB7IGlkOiBcImNsYXVkZS1zb25uZXQtNC02XCIsIHByb3ZpZGVyOiBcImNsYXVkZS1jb2RlXCIgfSxcbiAgICB7IGlkOiBcImNsYXVkZS1zb25uZXQtNC02XCIsIHByb3ZpZGVyOiBcImFudGhyb3BpY1wiIH0sXG4gIF07XG5cbiAgLy8gV2hlbiBzZXNzaW9uIHByb3ZpZGVyIGlzIGNsYXVkZS1jb2RlIChzdWJzY3JpcHRpb24gdXNlciBtaWdyYXRpb24pLCBpdCBtdXN0XG4gIC8vIHdpbiByZWdhcmRsZXNzIG9mIGNhbmRpZGF0ZSBvcmRlcmluZyB0byBhdm9pZCB0aGUgdGhpcmQtcGFydHkgYmxvY2sgKCMzNzcyKS5cbiAgY29uc3QgcmVzdWx0ID0gcmVzb2x2ZU1vZGVsSWQoXCJjbGF1ZGUtc29ubmV0LTQtNlwiLCBhdmFpbGFibGVNb2RlbHMsIFwiY2xhdWRlLWNvZGVcIik7XG4gIGFzc2VydC5vayhyZXN1bHQsIFwic2hvdWxkIHJlc29sdmUgYSBtb2RlbFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5wcm92aWRlciwgXCJjbGF1ZGUtY29kZVwiLCBcImNsYXVkZS1jb2RlIG11c3Qgd2luIHdoZW4gaXQgaXMgdGhlIHNlc3Npb24gcHJvdmlkZXJcIik7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhLFdBQVcsUUFBUSxxQkFBcUI7QUFDOUQsU0FBUyxTQUFTLFlBQVk7QUFDOUIsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMscUJBQXFCO0FBRTlCLE1BQU0sWUFBWSxRQUFRLGNBQWMsWUFBWSxHQUFHLENBQUM7QUFFeEQsU0FBUyw2QkFBNkIs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
