import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFlatRateContext, isFlatRateProvider, resolvePreferredModelConfig } from "../auto-model-selection.js";
describe("flat-rate provider routing guard (#3453)", () => {
  test("isFlatRateProvider returns true for github-copilot", () => {
    assert.equal(isFlatRateProvider("github-copilot"), true);
  });
  test("isFlatRateProvider returns true for copilot alias", () => {
    assert.equal(isFlatRateProvider("copilot"), true);
  });
  test("isFlatRateProvider is case-insensitive", () => {
    assert.equal(isFlatRateProvider("GitHub-Copilot"), true);
    assert.equal(isFlatRateProvider("GITHUB-COPILOT"), true);
    assert.equal(isFlatRateProvider("Copilot"), true);
  });
  test("isFlatRateProvider returns false for anthropic", () => {
    assert.equal(isFlatRateProvider("anthropic"), false);
  });
  test("isFlatRateProvider returns false for openai", () => {
    assert.equal(isFlatRateProvider("openai"), false);
  });
  test("resolvePreferredModelConfig returns undefined for copilot start model", () => {
    const originalCwd = process.cwd();
    const originalGsdHome = process.env.GSD_HOME;
    const tempProject = mkdtempSync(join(tmpdir(), "gsd-flat-rate-project-"));
    const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-flat-rate-home-"));
    try {
      mkdirSync(join(tempProject, ".gsd"), { recursive: true });
      writeFileSync(
        join(tempProject, ".gsd", "PREFERENCES.md"),
        [
          "---",
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
      const result = resolvePreferredModelConfig("execute-task", {
        provider: "github-copilot",
        id: "claude-sonnet-4"
      });
      assert.equal(result, void 0, "Should not create routing config for copilot");
    } finally {
      process.chdir(originalCwd);
      if (originalGsdHome === void 0) delete process.env.GSD_HOME;
      else process.env.GSD_HOME = originalGsdHome;
      rmSync(tempProject, { recursive: true, force: true });
      rmSync(tempGsdHome, { recursive: true, force: true });
    }
  });
});
describe("flat-rate provider extensibility (any/all/custom)", () => {
  test("regression: built-in providers still flat-rate with no context", () => {
    assert.equal(isFlatRateProvider("github-copilot"), true);
    assert.equal(isFlatRateProvider("copilot"), true);
    assert.equal(isFlatRateProvider("claude-code"), true);
  });
  test("regression: non-flat-rate API providers return false with no context", () => {
    assert.equal(isFlatRateProvider("anthropic"), false);
    assert.equal(isFlatRateProvider("openai"), false);
    assert.equal(isFlatRateProvider("google-vertex"), false);
  });
  test("auto-detection: externalCli auth mode marks provider flat-rate", () => {
    assert.equal(
      isFlatRateProvider("my-private-cli", { authMode: "externalCli" }),
      true
    );
  });
  test("auto-detection: non-externalCli auth modes do not mark provider flat-rate", () => {
    assert.equal(
      isFlatRateProvider("my-http-proxy", { authMode: "apiKey" }),
      false
    );
    assert.equal(
      isFlatRateProvider("my-http-proxy", { authMode: "oauth" }),
      false
    );
    assert.equal(
      isFlatRateProvider("my-http-proxy", { authMode: "none" }),
      false
    );
  });
  test("user preference: custom provider listed in userFlatRate is flat-rate", () => {
    assert.equal(
      isFlatRateProvider("my-ollama-proxy", { userFlatRate: ["my-ollama-proxy"] }),
      true
    );
  });
  test("user preference: case-insensitive match against userFlatRate list", () => {
    assert.equal(
      isFlatRateProvider("My-Proxy", { userFlatRate: ["my-proxy"] }),
      true
    );
    assert.equal(
      isFlatRateProvider("my-proxy", { userFlatRate: ["MY-PROXY"] }),
      true
    );
  });
  test("user preference: provider not in userFlatRate list is not flat-rate", () => {
    assert.equal(
      isFlatRateProvider("other-proxy", { userFlatRate: ["my-proxy"] }),
      false
    );
  });
  test("combined signals: built-in list wins even when context is empty", () => {
    assert.equal(
      isFlatRateProvider("claude-code", { authMode: "apiKey", userFlatRate: [] }),
      true
    );
  });
  test("combined signals: externalCli auto-detection wins alongside userFlatRate miss", () => {
    assert.equal(
      isFlatRateProvider("my-cli", {
        authMode: "externalCli",
        userFlatRate: ["a-different-cli"]
      }),
      true
    );
  });
});
describe("buildFlatRateContext()", () => {
  test("builds a context from ctx.modelRegistry.getProviderAuthMode + prefs", () => {
    const ctx = {
      modelRegistry: {
        getProviderAuthMode: (p) => p === "my-cli" ? "externalCli" : "apiKey"
      }
    };
    const prefs = { flat_rate_providers: ["my-proxy"] };
    const ctxForCli = buildFlatRateContext("my-cli", ctx, prefs);
    assert.equal(ctxForCli.authMode, "externalCli");
    assert.deepEqual(ctxForCli.userFlatRate, ["my-proxy"]);
    assert.equal(isFlatRateProvider("my-cli", ctxForCli), true);
    const ctxForProxy = buildFlatRateContext("my-proxy", ctx, prefs);
    assert.equal(ctxForProxy.authMode, "apiKey");
    assert.equal(isFlatRateProvider("my-proxy", ctxForProxy), true);
    const ctxForOther = buildFlatRateContext("anthropic", ctx, prefs);
    assert.equal(ctxForOther.authMode, "apiKey");
    assert.equal(isFlatRateProvider("anthropic", ctxForOther), false);
  });
  test("survives missing ctx and missing prefs", () => {
    const empty = buildFlatRateContext("anything");
    assert.equal(empty.authMode, void 0);
    assert.equal(empty.userFlatRate, void 0);
    assert.equal(isFlatRateProvider("anything", empty), false);
  });
  test("survives a registry lookup that throws", () => {
    const ctx = {
      modelRegistry: {
        getProviderAuthMode: () => {
          throw new Error("registry boom");
        }
      }
    };
    const result = buildFlatRateContext("anything", ctx);
    assert.equal(result.authMode, void 0);
  });
  test("registry returning a non-canonical auth mode is ignored", () => {
    const ctx = {
      modelRegistry: {
        getProviderAuthMode: () => "weird-mode"
      }
    };
    const result = buildFlatRateContext("anything", ctx);
    assert.equal(result.authMode, void 0);
  });
});
describe("flat-rate routing opt-in (#4386)", () => {
  function withPrefs(prefsYaml, fn) {
    const originalCwd = process.cwd();
    const originalGsdHome = process.env.GSD_HOME;
    const tempProject = mkdtempSync(join(tmpdir(), "gsd-4386-project-"));
    const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-4386-home-"));
    try {
      mkdirSync(join(tempProject, ".gsd"), { recursive: true });
      writeFileSync(
        join(tempProject, ".gsd", "PREFERENCES.md"),
        ["---", "version: 1", prefsYaml, "---"].join("\n"),
        "utf-8"
      );
      process.env.GSD_HOME = tempGsdHome;
      process.chdir(tempProject);
      fn();
    } finally {
      process.chdir(originalCwd);
      if (originalGsdHome === void 0) delete process.env.GSD_HOME;
      else process.env.GSD_HOME = originalGsdHome;
      rmSync(tempProject, { recursive: true, force: true });
      rmSync(tempGsdHome, { recursive: true, force: true });
    }
  }
  test("default (opt-in absent): flat-rate start model still returns undefined", () => {
    withPrefs(
      [
        "dynamic_routing:",
        "  enabled: true",
        "  tier_models:",
        "    heavy: claude-opus-4-6"
      ].join("\n"),
      () => {
        const result = resolvePreferredModelConfig("execute-task", {
          provider: "claude-code",
          id: "claude-opus-4-6"
        });
        assert.equal(result, void 0, "default must preserve #3453 bypass");
      }
    );
  });
  test("opt-in: synthesizes a routing config for flat-rate start model", () => {
    withPrefs(
      [
        "dynamic_routing:",
        "  enabled: true",
        "  allow_flat_rate_providers: true",
        "  tier_models:",
        "    heavy: claude-opus-4-6"
      ].join("\n"),
      () => {
        const result = resolvePreferredModelConfig("execute-task", {
          provider: "claude-code",
          id: "claude-opus-4-6"
        });
        assert.ok(result, "routing config should be synthesized");
        assert.equal(result.primary, "claude-opus-4-6");
      }
    );
  });
  test("explicit opt-out: flat-rate bypass still fires", () => {
    withPrefs(
      [
        "dynamic_routing:",
        "  enabled: true",
        "  allow_flat_rate_providers: false",
        "  tier_models:",
        "    heavy: claude-opus-4-6"
      ].join("\n"),
      () => {
        const result = resolvePreferredModelConfig("execute-task", {
          provider: "claude-code",
          id: "claude-opus-4-6"
        });
        assert.equal(result, void 0, "explicit opt-out behaves like default");
      }
    );
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9mbGF0LXJhdGUtcm91dGluZy1ndWFyZC50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFJlZ3Jlc3Npb24gdGVzdCBmb3IgIzM0NTM6IGR5bmFtaWMgbW9kZWwgcm91dGluZyBtdXN0IGJlIGRpc2FibGVkIGZvclxuICogZmxhdC1yYXRlIHByb3ZpZGVycyBsaWtlIEdpdEh1YiBDb3BpbG90IHdoZXJlIGFsbCBtb2RlbHMgY29zdCB0aGUgc2FtZVxuICogcGVyIHJlcXVlc3QgXHUyMDE0IHJvdXRpbmcgb25seSBkZWdyYWRlcyBxdWFsaXR5IHdpdGggbm8gY29zdCBiZW5lZml0LlxuICovXG5cbmltcG9ydCB7IGRlc2NyaWJlLCB0ZXN0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCB3cml0ZUZpbGVTeW5jLCBybVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBidWlsZEZsYXRSYXRlQ29udGV4dCwgaXNGbGF0UmF0ZVByb3ZpZGVyLCByZXNvbHZlUHJlZmVycmVkTW9kZWxDb25maWcgfSBmcm9tIFwiLi4vYXV0by1tb2RlbC1zZWxlY3Rpb24udHNcIjtcblxuZGVzY3JpYmUoXCJmbGF0LXJhdGUgcHJvdmlkZXIgcm91dGluZyBndWFyZCAoIzM0NTMpXCIsICgpID0+IHtcblxuICB0ZXN0KFwiaXNGbGF0UmF0ZVByb3ZpZGVyIHJldHVybnMgdHJ1ZSBmb3IgZ2l0aHViLWNvcGlsb3RcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChpc0ZsYXRSYXRlUHJvdmlkZXIoXCJnaXRodWItY29waWxvdFwiKSwgdHJ1ZSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJpc0ZsYXRSYXRlUHJvdmlkZXIgcmV0dXJucyB0cnVlIGZvciBjb3BpbG90IGFsaWFzXCIsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoaXNGbGF0UmF0ZVByb3ZpZGVyKFwiY29waWxvdFwiKSwgdHJ1ZSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJpc0ZsYXRSYXRlUHJvdmlkZXIgaXMgY2FzZS1pbnNlbnNpdGl2ZVwiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKGlzRmxhdFJhdGVQcm92aWRlcihcIkdpdEh1Yi1Db3BpbG90XCIpLCB0cnVlKTtcbiAgICBhc3NlcnQuZXF1YWwoaXNGbGF0UmF0ZVByb3ZpZGVyKFwiR0lUSFVCLUNPUElMT1RcIiksIHRydWUpO1xuICAgIGFzc2VydC5lcXVhbChpc0ZsYXRSYXRlUHJvdmlkZXIoXCJDb3BpbG90XCIpLCB0cnVlKTtcbiAgfSk7XG5cbiAgdGVzdChcImlzRmxhdFJhdGVQcm92aWRlciByZXR1cm5zIGZhbHNlIGZvciBhbnRocm9waWNcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChpc0ZsYXRSYXRlUHJvdmlkZXIoXCJhbnRocm9waWNcIiksIGZhbHNlKTtcbiAgfSk7XG5cbiAgdGVzdChcImlzRmxhdFJhdGVQcm92aWRlciByZXR1cm5zIGZhbHNlIGZvciBvcGVuYWlcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChpc0ZsYXRSYXRlUHJvdmlkZXIoXCJvcGVuYWlcIiksIGZhbHNlKTtcbiAgfSk7XG5cbiAgdGVzdChcInJlc29sdmVQcmVmZXJyZWRNb2RlbENvbmZpZyByZXR1cm5zIHVuZGVmaW5lZCBmb3IgY29waWxvdCBzdGFydCBtb2RlbFwiLCAoKSA9PiB7XG4gICAgY29uc3Qgb3JpZ2luYWxDd2QgPSBwcm9jZXNzLmN3ZCgpO1xuICAgIGNvbnN0IG9yaWdpbmFsR3NkSG9tZSA9IHByb2Nlc3MuZW52LkdTRF9IT01FO1xuICAgIGNvbnN0IHRlbXBQcm9qZWN0ID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtZmxhdC1yYXRlLXByb2plY3QtXCIpKTtcbiAgICBjb25zdCB0ZW1wR3NkSG9tZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLWZsYXQtcmF0ZS1ob21lLVwiKSk7XG5cbiAgICAvLyBXaGVuIHRoZSB1c2VyJ3Mgc3RhcnQgbW9kZWwgaXMgb24gYSBmbGF0LXJhdGUgcHJvdmlkZXIsXG4gICAgLy8gcmVzb2x2ZVByZWZlcnJlZE1vZGVsQ29uZmlnIHNob3VsZCBub3Qgc3ludGhlc2l6ZSBhIHJvdXRpbmdcbiAgICAvLyBjb25maWcgZnJvbSB0aWVyX21vZGVscyBcdTIwMTQgaXQgc2hvdWxkIHJldHVybiB1bmRlZmluZWQgc28gdGhlXG4gICAgLy8gdXNlcidzIHNlbGVjdGVkIG1vZGVsIGlzIHByZXNlcnZlZC5cbiAgICB0cnkge1xuICAgICAgbWtkaXJTeW5jKGpvaW4odGVtcFByb2plY3QsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgICBqb2luKHRlbXBQcm9qZWN0LCBcIi5nc2RcIiwgXCJQUkVGRVJFTkNFUy5tZFwiKSxcbiAgICAgICAgW1xuICAgICAgICAgIFwiLS0tXCIsXG4gICAgICAgICAgXCJkeW5hbWljX3JvdXRpbmc6XCIsXG4gICAgICAgICAgXCIgIGVuYWJsZWQ6IHRydWVcIixcbiAgICAgICAgICBcIiAgdGllcl9tb2RlbHM6XCIsXG4gICAgICAgICAgXCIgICAgbGlnaHQ6IGdwdC00by1taW5pXCIsXG4gICAgICAgICAgXCIgICAgc3RhbmRhcmQ6IGNsYXVkZS1zb25uZXQtNC02XCIsXG4gICAgICAgICAgXCIgICAgaGVhdnk6IGNsYXVkZS1vcHVzLTQtNlwiLFxuICAgICAgICAgIFwiLS0tXCIsXG4gICAgICAgIF0uam9pbihcIlxcblwiKSxcbiAgICAgICAgXCJ1dGYtOFwiLFxuICAgICAgKTtcbiAgICAgIHByb2Nlc3MuZW52LkdTRF9IT01FID0gdGVtcEdzZEhvbWU7XG4gICAgICBwcm9jZXNzLmNoZGlyKHRlbXBQcm9qZWN0KTtcblxuICAgICAgY29uc3QgcmVzdWx0ID0gcmVzb2x2ZVByZWZlcnJlZE1vZGVsQ29uZmlnKFwiZXhlY3V0ZS10YXNrXCIsIHtcbiAgICAgICAgcHJvdmlkZXI6IFwiZ2l0aHViLWNvcGlsb3RcIixcbiAgICAgICAgaWQ6IFwiY2xhdWRlLXNvbm5ldC00XCIsXG4gICAgICB9KTtcblxuICAgICAgLy8gU2hvdWxkIGJlIHVuZGVmaW5lZCAobm8gcm91dGluZyBjb25maWcgY3JlYXRlZCBmb3IgZmxhdC1yYXRlKVxuICAgICAgLy8gTm90ZTogdGhpcyBvbmx5IHRlc3RzIHRoZSBzeW50aGVzaXMgZ3VhcmQgXHUyMDE0IGV4cGxpY2l0IHBlci11bml0IGNvbmZpZ1xuICAgICAgLy8gc3RpbGwgdGFrZXMgcHJlY2VkZW5jZSB3aGVuIHRoZSB1c2VyIGNvbmZpZ3VyZWQgb25lLlxuICAgICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgdW5kZWZpbmVkLCBcIlNob3VsZCBub3QgY3JlYXRlIHJvdXRpbmcgY29uZmlnIGZvciBjb3BpbG90XCIpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBwcm9jZXNzLmNoZGlyKG9yaWdpbmFsQ3dkKTtcbiAgICAgIGlmIChvcmlnaW5hbEdzZEhvbWUgPT09IHVuZGVmaW5lZCkgZGVsZXRlIHByb2Nlc3MuZW52LkdTRF9IT01FO1xuICAgICAgZWxzZSBwcm9jZXNzLmVudi5HU0RfSE9NRSA9IG9yaWdpbmFsR3NkSG9tZTtcbiAgICAgIHJtU3luYyh0ZW1wUHJvamVjdCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgICAgcm1TeW5jKHRlbXBHc2RIb21lLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcbn0pO1xuXG5kZXNjcmliZShcImZsYXQtcmF0ZSBwcm92aWRlciBleHRlbnNpYmlsaXR5IChhbnkvYWxsL2N1c3RvbSlcIiwgKCkgPT4ge1xuICB0ZXN0KFwicmVncmVzc2lvbjogYnVpbHQtaW4gcHJvdmlkZXJzIHN0aWxsIGZsYXQtcmF0ZSB3aXRoIG5vIGNvbnRleHRcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChpc0ZsYXRSYXRlUHJvdmlkZXIoXCJnaXRodWItY29waWxvdFwiKSwgdHJ1ZSk7XG4gICAgYXNzZXJ0LmVxdWFsKGlzRmxhdFJhdGVQcm92aWRlcihcImNvcGlsb3RcIiksIHRydWUpO1xuICAgIGFzc2VydC5lcXVhbChpc0ZsYXRSYXRlUHJvdmlkZXIoXCJjbGF1ZGUtY29kZVwiKSwgdHJ1ZSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJyZWdyZXNzaW9uOiBub24tZmxhdC1yYXRlIEFQSSBwcm92aWRlcnMgcmV0dXJuIGZhbHNlIHdpdGggbm8gY29udGV4dFwiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKGlzRmxhdFJhdGVQcm92aWRlcihcImFudGhyb3BpY1wiKSwgZmFsc2UpO1xuICAgIGFzc2VydC5lcXVhbChpc0ZsYXRSYXRlUHJvdmlkZXIoXCJvcGVuYWlcIiksIGZhbHNlKTtcbiAgICBhc3NlcnQuZXF1YWwoaXNGbGF0UmF0ZVByb3ZpZGVyKFwiZ29vZ2xlLXZlcnRleFwiKSwgZmFsc2UpO1xuICB9KTtcblxuICB0ZXN0KFwiYXV0by1kZXRlY3Rpb246IGV4dGVybmFsQ2xpIGF1dGggbW9kZSBtYXJrcyBwcm92aWRlciBmbGF0LXJhdGVcIiwgKCkgPT4ge1xuICAgIC8vIEFueSBwcm92aWRlciByZWdpc3RlcmVkIHdpdGggYXV0aE1vZGU6IFwiZXh0ZXJuYWxDbGlcIiBpcyBhIGxvY2FsXG4gICAgLy8gQ0xJIHdyYXBwZXIgYXJvdW5kIHRoZSB1c2VyJ3Mgc3Vic2NyaXB0aW9uIFx1MjAxNCBldmVyeSByZXF1ZXN0IGNvc3RzXG4gICAgLy8gdGhlIHNhbWUgcmVnYXJkbGVzcyBvZiBtb2RlbCwgc28gZHluYW1pYyByb3V0aW5nIHByb3ZpZGVzIG5vIGJlbmVmaXQuXG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgaXNGbGF0UmF0ZVByb3ZpZGVyKFwibXktcHJpdmF0ZS1jbGlcIiwgeyBhdXRoTW9kZTogXCJleHRlcm5hbENsaVwiIH0pLFxuICAgICAgdHJ1ZSxcbiAgICApO1xuICB9KTtcblxuICB0ZXN0KFwiYXV0by1kZXRlY3Rpb246IG5vbi1leHRlcm5hbENsaSBhdXRoIG1vZGVzIGRvIG5vdCBtYXJrIHByb3ZpZGVyIGZsYXQtcmF0ZVwiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgaXNGbGF0UmF0ZVByb3ZpZGVyKFwibXktaHR0cC1wcm94eVwiLCB7IGF1dGhNb2RlOiBcImFwaUtleVwiIH0pLFxuICAgICAgZmFsc2UsXG4gICAgKTtcbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICBpc0ZsYXRSYXRlUHJvdmlkZXIoXCJteS1odHRwLXByb3h5XCIsIHsgYXV0aE1vZGU6IFwib2F1dGhcIiB9KSxcbiAgICAgIGZhbHNlLFxuICAgICk7XG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgaXNGbGF0UmF0ZVByb3ZpZGVyKFwibXktaHR0cC1wcm94eVwiLCB7IGF1dGhNb2RlOiBcIm5vbmVcIiB9KSxcbiAgICAgIGZhbHNlLFxuICAgICk7XG4gIH0pO1xuXG4gIHRlc3QoXCJ1c2VyIHByZWZlcmVuY2U6IGN1c3RvbSBwcm92aWRlciBsaXN0ZWQgaW4gdXNlckZsYXRSYXRlIGlzIGZsYXQtcmF0ZVwiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgaXNGbGF0UmF0ZVByb3ZpZGVyKFwibXktb2xsYW1hLXByb3h5XCIsIHsgdXNlckZsYXRSYXRlOiBbXCJteS1vbGxhbWEtcHJveHlcIl0gfSksXG4gICAgICB0cnVlLFxuICAgICk7XG4gIH0pO1xuXG4gIHRlc3QoXCJ1c2VyIHByZWZlcmVuY2U6IGNhc2UtaW5zZW5zaXRpdmUgbWF0Y2ggYWdhaW5zdCB1c2VyRmxhdFJhdGUgbGlzdFwiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgaXNGbGF0UmF0ZVByb3ZpZGVyKFwiTXktUHJveHlcIiwgeyB1c2VyRmxhdFJhdGU6IFtcIm15LXByb3h5XCJdIH0pLFxuICAgICAgdHJ1ZSxcbiAgICApO1xuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIGlzRmxhdFJhdGVQcm92aWRlcihcIm15LXByb3h5XCIsIHsgdXNlckZsYXRSYXRlOiBbXCJNWS1QUk9YWVwiXSB9KSxcbiAgICAgIHRydWUsXG4gICAgKTtcbiAgfSk7XG5cbiAgdGVzdChcInVzZXIgcHJlZmVyZW5jZTogcHJvdmlkZXIgbm90IGluIHVzZXJGbGF0UmF0ZSBsaXN0IGlzIG5vdCBmbGF0LXJhdGVcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIGlzRmxhdFJhdGVQcm92aWRlcihcIm90aGVyLXByb3h5XCIsIHsgdXNlckZsYXRSYXRlOiBbXCJteS1wcm94eVwiXSB9KSxcbiAgICAgIGZhbHNlLFxuICAgICk7XG4gIH0pO1xuXG4gIHRlc3QoXCJjb21iaW5lZCBzaWduYWxzOiBidWlsdC1pbiBsaXN0IHdpbnMgZXZlbiB3aGVuIGNvbnRleHQgaXMgZW1wdHlcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIGlzRmxhdFJhdGVQcm92aWRlcihcImNsYXVkZS1jb2RlXCIsIHsgYXV0aE1vZGU6IFwiYXBpS2V5XCIsIHVzZXJGbGF0UmF0ZTogW10gfSksXG4gICAgICB0cnVlLFxuICAgICk7XG4gIH0pO1xuXG4gIHRlc3QoXCJjb21iaW5lZCBzaWduYWxzOiBleHRlcm5hbENsaSBhdXRvLWRldGVjdGlvbiB3aW5zIGFsb25nc2lkZSB1c2VyRmxhdFJhdGUgbWlzc1wiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgaXNGbGF0UmF0ZVByb3ZpZGVyKFwibXktY2xpXCIsIHtcbiAgICAgICAgYXV0aE1vZGU6IFwiZXh0ZXJuYWxDbGlcIixcbiAgICAgICAgdXNlckZsYXRSYXRlOiBbXCJhLWRpZmZlcmVudC1jbGlcIl0sXG4gICAgICB9KSxcbiAgICAgIHRydWUsXG4gICAgKTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoXCJidWlsZEZsYXRSYXRlQ29udGV4dCgpXCIsICgpID0+IHtcbiAgdGVzdChcImJ1aWxkcyBhIGNvbnRleHQgZnJvbSBjdHgubW9kZWxSZWdpc3RyeS5nZXRQcm92aWRlckF1dGhNb2RlICsgcHJlZnNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGN0eCA9IHtcbiAgICAgIG1vZGVsUmVnaXN0cnk6IHtcbiAgICAgICAgZ2V0UHJvdmlkZXJBdXRoTW9kZTogKHA6IHN0cmluZykgPT5cbiAgICAgICAgICBwID09PSBcIm15LWNsaVwiID8gXCJleHRlcm5hbENsaVwiIDogXCJhcGlLZXlcIixcbiAgICAgIH0sXG4gICAgfTtcbiAgICBjb25zdCBwcmVmcyA9IHsgZmxhdF9yYXRlX3Byb3ZpZGVyczogW1wibXktcHJveHlcIl0gfTtcblxuICAgIGNvbnN0IGN0eEZvckNsaSA9IGJ1aWxkRmxhdFJhdGVDb250ZXh0KFwibXktY2xpXCIsIGN0eCwgcHJlZnMpO1xuICAgIGFzc2VydC5lcXVhbChjdHhGb3JDbGkuYXV0aE1vZGUsIFwiZXh0ZXJuYWxDbGlcIik7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChjdHhGb3JDbGkudXNlckZsYXRSYXRlLCBbXCJteS1wcm94eVwiXSk7XG4gICAgYXNzZXJ0LmVxdWFsKGlzRmxhdFJhdGVQcm92aWRlcihcIm15LWNsaVwiLCBjdHhGb3JDbGkpLCB0cnVlKTtcblxuICAgIGNvbnN0IGN0eEZvclByb3h5ID0gYnVpbGRGbGF0UmF0ZUNvbnRleHQoXCJteS1wcm94eVwiLCBjdHgsIHByZWZzKTtcbiAgICBhc3NlcnQuZXF1YWwoY3R4Rm9yUHJveHkuYXV0aE1vZGUsIFwiYXBpS2V5XCIpO1xuICAgIGFzc2VydC5lcXVhbChpc0ZsYXRSYXRlUHJvdmlkZXIoXCJteS1wcm94eVwiLCBjdHhGb3JQcm94eSksIHRydWUpO1xuXG4gICAgY29uc3QgY3R4Rm9yT3RoZXIgPSBidWlsZEZsYXRSYXRlQ29udGV4dChcImFudGhyb3BpY1wiLCBjdHgsIHByZWZzKTtcbiAgICBhc3NlcnQuZXF1YWwoY3R4Rm9yT3RoZXIuYXV0aE1vZGUsIFwiYXBpS2V5XCIpO1xuICAgIGFzc2VydC5lcXVhbChpc0ZsYXRSYXRlUHJvdmlkZXIoXCJhbnRocm9waWNcIiwgY3R4Rm9yT3RoZXIpLCBmYWxzZSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJzdXJ2aXZlcyBtaXNzaW5nIGN0eCBhbmQgbWlzc2luZyBwcmVmc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgZW1wdHkgPSBidWlsZEZsYXRSYXRlQ29udGV4dChcImFueXRoaW5nXCIpO1xuICAgIGFzc2VydC5lcXVhbChlbXB0eS5hdXRoTW9kZSwgdW5kZWZpbmVkKTtcbiAgICBhc3NlcnQuZXF1YWwoZW1wdHkudXNlckZsYXRSYXRlLCB1bmRlZmluZWQpO1xuICAgIGFzc2VydC5lcXVhbChpc0ZsYXRSYXRlUHJvdmlkZXIoXCJhbnl0aGluZ1wiLCBlbXB0eSksIGZhbHNlKTtcbiAgfSk7XG5cbiAgdGVzdChcInN1cnZpdmVzIGEgcmVnaXN0cnkgbG9va3VwIHRoYXQgdGhyb3dzXCIsICgpID0+IHtcbiAgICBjb25zdCBjdHggPSB7XG4gICAgICBtb2RlbFJlZ2lzdHJ5OiB7XG4gICAgICAgIGdldFByb3ZpZGVyQXV0aE1vZGU6ICgpID0+IHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJyZWdpc3RyeSBib29tXCIpO1xuICAgICAgICB9LFxuICAgICAgfSxcbiAgICB9O1xuICAgIGNvbnN0IHJlc3VsdCA9IGJ1aWxkRmxhdFJhdGVDb250ZXh0KFwiYW55dGhpbmdcIiwgY3R4KTtcbiAgICAvLyBFcnJvciBtdXN0IGJlIHN3YWxsb3dlZCBcdTIwMTQgYXV0aE1vZGUgbGVmdCB1bmRlZmluZWQsIGZ1bmN0aW9uIHJldHVybnMuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5hdXRoTW9kZSwgdW5kZWZpbmVkKTtcbiAgfSk7XG5cbiAgdGVzdChcInJlZ2lzdHJ5IHJldHVybmluZyBhIG5vbi1jYW5vbmljYWwgYXV0aCBtb2RlIGlzIGlnbm9yZWRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGN0eCA9IHtcbiAgICAgIG1vZGVsUmVnaXN0cnk6IHtcbiAgICAgICAgZ2V0UHJvdmlkZXJBdXRoTW9kZTogKCkgPT4gXCJ3ZWlyZC1tb2RlXCIsXG4gICAgICB9LFxuICAgIH07XG4gICAgY29uc3QgcmVzdWx0ID0gYnVpbGRGbGF0UmF0ZUNvbnRleHQoXCJhbnl0aGluZ1wiLCBjdHgpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuYXV0aE1vZGUsIHVuZGVmaW5lZCk7XG4gIH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCAjNDM4NjogYWxsb3dfZmxhdF9yYXRlX3Byb3ZpZGVycyBvcHQtaW4gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiZmxhdC1yYXRlIHJvdXRpbmcgb3B0LWluICgjNDM4NilcIiwgKCkgPT4ge1xuICBmdW5jdGlvbiB3aXRoUHJlZnMocHJlZnNZYW1sOiBzdHJpbmcsIGZuOiAoKSA9PiB2b2lkKTogdm9pZCB7XG4gICAgY29uc3Qgb3JpZ2luYWxDd2QgPSBwcm9jZXNzLmN3ZCgpO1xuICAgIGNvbnN0IG9yaWdpbmFsR3NkSG9tZSA9IHByb2Nlc3MuZW52LkdTRF9IT01FO1xuICAgIGNvbnN0IHRlbXBQcm9qZWN0ID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtNDM4Ni1wcm9qZWN0LVwiKSk7XG4gICAgY29uc3QgdGVtcEdzZEhvbWUgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC00Mzg2LWhvbWUtXCIpKTtcbiAgICB0cnkge1xuICAgICAgbWtkaXJTeW5jKGpvaW4odGVtcFByb2plY3QsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgICBqb2luKHRlbXBQcm9qZWN0LCBcIi5nc2RcIiwgXCJQUkVGRVJFTkNFUy5tZFwiKSxcbiAgICAgICAgW1wiLS0tXCIsIFwidmVyc2lvbjogMVwiLCBwcmVmc1lhbWwsIFwiLS0tXCJdLmpvaW4oXCJcXG5cIiksXG4gICAgICAgIFwidXRmLThcIixcbiAgICAgICk7XG4gICAgICBwcm9jZXNzLmVudi5HU0RfSE9NRSA9IHRlbXBHc2RIb21lO1xuICAgICAgcHJvY2Vzcy5jaGRpcih0ZW1wUHJvamVjdCk7XG4gICAgICBmbigpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBwcm9jZXNzLmNoZGlyKG9yaWdpbmFsQ3dkKTtcbiAgICAgIGlmIChvcmlnaW5hbEdzZEhvbWUgPT09IHVuZGVmaW5lZCkgZGVsZXRlIHByb2Nlc3MuZW52LkdTRF9IT01FO1xuICAgICAgZWxzZSBwcm9jZXNzLmVudi5HU0RfSE9NRSA9IG9yaWdpbmFsR3NkSG9tZTtcbiAgICAgIHJtU3luYyh0ZW1wUHJvamVjdCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgICAgcm1TeW5jKHRlbXBHc2RIb21lLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9XG5cbiAgdGVzdChcImRlZmF1bHQgKG9wdC1pbiBhYnNlbnQpOiBmbGF0LXJhdGUgc3RhcnQgbW9kZWwgc3RpbGwgcmV0dXJucyB1bmRlZmluZWRcIiwgKCkgPT4ge1xuICAgIHdpdGhQcmVmcyhcbiAgICAgIFtcbiAgICAgICAgXCJkeW5hbWljX3JvdXRpbmc6XCIsXG4gICAgICAgIFwiICBlbmFibGVkOiB0cnVlXCIsXG4gICAgICAgIFwiICB0aWVyX21vZGVsczpcIixcbiAgICAgICAgXCIgICAgaGVhdnk6IGNsYXVkZS1vcHVzLTQtNlwiLFxuICAgICAgXS5qb2luKFwiXFxuXCIpLFxuICAgICAgKCkgPT4ge1xuICAgICAgICBjb25zdCByZXN1bHQgPSByZXNvbHZlUHJlZmVycmVkTW9kZWxDb25maWcoXCJleGVjdXRlLXRhc2tcIiwge1xuICAgICAgICAgIHByb3ZpZGVyOiBcImNsYXVkZS1jb2RlXCIsXG4gICAgICAgICAgaWQ6IFwiY2xhdWRlLW9wdXMtNC02XCIsXG4gICAgICAgIH0pO1xuICAgICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCB1bmRlZmluZWQsIFwiZGVmYXVsdCBtdXN0IHByZXNlcnZlICMzNDUzIGJ5cGFzc1wiKTtcbiAgICAgIH0sXG4gICAgKTtcbiAgfSk7XG5cbiAgdGVzdChcIm9wdC1pbjogc3ludGhlc2l6ZXMgYSByb3V0aW5nIGNvbmZpZyBmb3IgZmxhdC1yYXRlIHN0YXJ0IG1vZGVsXCIsICgpID0+IHtcbiAgICB3aXRoUHJlZnMoXG4gICAgICBbXG4gICAgICAgIFwiZHluYW1pY19yb3V0aW5nOlwiLFxuICAgICAgICBcIiAgZW5hYmxlZDogdHJ1ZVwiLFxuICAgICAgICBcIiAgYWxsb3dfZmxhdF9yYXRlX3Byb3ZpZGVyczogdHJ1ZVwiLFxuICAgICAgICBcIiAgdGllcl9tb2RlbHM6XCIsXG4gICAgICAgIFwiICAgIGhlYXZ5OiBjbGF1ZGUtb3B1cy00LTZcIixcbiAgICAgIF0uam9pbihcIlxcblwiKSxcbiAgICAgICgpID0+IHtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gcmVzb2x2ZVByZWZlcnJlZE1vZGVsQ29uZmlnKFwiZXhlY3V0ZS10YXNrXCIsIHtcbiAgICAgICAgICBwcm92aWRlcjogXCJjbGF1ZGUtY29kZVwiLFxuICAgICAgICAgIGlkOiBcImNsYXVkZS1vcHVzLTQtNlwiLFxuICAgICAgICB9KTtcbiAgICAgICAgYXNzZXJ0Lm9rKHJlc3VsdCwgXCJyb3V0aW5nIGNvbmZpZyBzaG91bGQgYmUgc3ludGhlc2l6ZWRcIik7XG4gICAgICAgIGFzc2VydC5lcXVhbChyZXN1bHQhLnByaW1hcnksIFwiY2xhdWRlLW9wdXMtNC02XCIpO1xuICAgICAgfSxcbiAgICApO1xuICB9KTtcblxuICB0ZXN0KFwiZXhwbGljaXQgb3B0LW91dDogZmxhdC1yYXRlIGJ5cGFzcyBzdGlsbCBmaXJlc1wiLCAoKSA9PiB7XG4gICAgd2l0aFByZWZzKFxuICAgICAgW1xuICAgICAgICBcImR5bmFtaWNfcm91dGluZzpcIixcbiAgICAgICAgXCIgIGVuYWJsZWQ6IHRydWVcIixcbiAgICAgICAgXCIgIGFsbG93X2ZsYXRfcmF0ZV9wcm92aWRlcnM6IGZhbHNlXCIsXG4gICAgICAgIFwiICB0aWVyX21vZGVsczpcIixcbiAgICAgICAgXCIgICAgaGVhdnk6IGNsYXVkZS1vcHVzLTQtNlwiLFxuICAgICAgXS5qb2luKFwiXFxuXCIpLFxuICAgICAgKCkgPT4ge1xuICAgICAgICBjb25zdCByZXN1bHQgPSByZXNvbHZlUHJlZmVycmVkTW9kZWxDb25maWcoXCJleGVjdXRlLXRhc2tcIiwge1xuICAgICAgICAgIHByb3ZpZGVyOiBcImNsYXVkZS1jb2RlXCIsXG4gICAgICAgICAgaWQ6IFwiY2xhdWRlLW9wdXMtNC02XCIsXG4gICAgICAgIH0pO1xuICAgICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCB1bmRlZmluZWQsIFwiZXhwbGljaXQgb3B0LW91dCBiZWhhdmVzIGxpa2UgZGVmYXVsdFwiKTtcbiAgICAgIH0sXG4gICAgKTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQU1BLFNBQVMsVUFBVSxZQUFZO0FBQy9CLE9BQU8sWUFBWTtBQUNuQixTQUFTLGFBQWEsV0FBVyxlQUFlLGNBQWM7QUFDOUQsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsWUFBWTtBQUNyQixTQUFTLHNCQUFzQixvQkFBb0IsbUNBQW1DO0FBRXRGLFNBQVMsNENBQTRDLE1BQU07QUFFekQsT0FBSyxzREFBc0QsTUFBTTtBQUMvRCxXQUFPLE1BQU0sbUJBQW1CLGdC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
