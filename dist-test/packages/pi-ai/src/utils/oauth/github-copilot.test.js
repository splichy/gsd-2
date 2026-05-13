import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  getGitHubCopilotBaseUrl,
  githubCopilotOAuthProvider,
  loginGitHubCopilot,
  normalizeDomain
} from "./github-copilot.js";
function createModel(overrides = {}) {
  return {
    id: "test-model",
    name: "Test Model",
    api: "openai-completions",
    provider: "test-provider",
    baseUrl: "https://example.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128e3,
    maxTokens: 8192,
    ...overrides
  };
}
function makeCredentials(overrides = {}) {
  return {
    access: "copilot-token",
    refresh: "refresh-token",
    expires: Date.now() + 6e4,
    ...overrides
  };
}
describe("GitHub Copilot OAuth \u2014 normalizeDomain", () => {
  test("returns null for empty input", () => {
    assert.equal(normalizeDomain(""), null);
    assert.equal(normalizeDomain("   "), null);
  });
  test("returns null for invalid domain", () => {
    assert.equal(normalizeDomain("not a domain!@#"), null);
  });
  test("extracts hostname from full URL", () => {
    assert.equal(normalizeDomain("https://github.com"), "github.com");
    assert.equal(normalizeDomain("https://company.ghe.com"), "company.ghe.com");
    assert.equal(normalizeDomain("http://example.com/path"), "example.com");
  });
  test("returns domain as-is when no protocol", () => {
    assert.equal(normalizeDomain("github.com"), "github.com");
    assert.equal(normalizeDomain("company.ghe.com"), "company.ghe.com");
  });
  test("trims whitespace", () => {
    assert.equal(normalizeDomain("  github.com  "), "github.com");
  });
});
describe("GitHub Copilot OAuth \u2014 getBaseUrlFromToken", () => {
  test("extracts API URL from token with proxy-ep", () => {
    const token = "tid=123;exp=1234567890;proxy-ep=proxy.individual.githubcopilot.com;other=value";
    const baseUrl = getGitHubCopilotBaseUrl(token);
    assert.equal(baseUrl, "https://api.individual.githubcopilot.com");
  });
  test("extracts API URL from enterprise proxy-ep", () => {
    const token = "tid=123;exp=1234567890;proxy-ep=proxy.company.ghe.com;other=value";
    const baseUrl = getGitHubCopilotBaseUrl(token);
    assert.equal(baseUrl, "https://api.company.ghe.com");
  });
  test("falls back to default when no token provided", () => {
    const baseUrl = getGitHubCopilotBaseUrl();
    assert.equal(baseUrl, "https://api.individual.githubcopilot.com");
  });
  test("falls back to default when token has no proxy-ep", () => {
    const token = "tid=123;exp=1234567890;other=value";
    const baseUrl = getGitHubCopilotBaseUrl(token);
    assert.equal(baseUrl, "https://api.individual.githubcopilot.com");
  });
  test("uses enterprise domain when provided", () => {
    const baseUrl = getGitHubCopilotBaseUrl(void 0, "company.ghe.com");
    assert.equal(baseUrl, "https://copilot-api.company.ghe.com");
  });
  test("prioritizes token proxy-ep over enterprise domain", () => {
    const token = "tid=123;exp=1234567890;proxy-ep=proxy.individual.githubcopilot.com;other=value";
    const baseUrl = getGitHubCopilotBaseUrl(token, "company.ghe.com");
    assert.equal(baseUrl, "https://api.individual.githubcopilot.com");
  });
});
describe("GitHub Copilot OAuth \u2014 provider structure", () => {
  test("has correct id and name", () => {
    assert.equal(githubCopilotOAuthProvider.id, "github-copilot");
    assert.equal(githubCopilotOAuthProvider.name, "GitHub Copilot");
  });
  test("has required methods", () => {
    assert.equal(typeof githubCopilotOAuthProvider.login, "function");
    assert.equal(typeof githubCopilotOAuthProvider.refreshToken, "function");
    assert.equal(typeof githubCopilotOAuthProvider.getApiKey, "function");
    assert.equal(typeof githubCopilotOAuthProvider.modifyModels, "function");
  });
  test("getApiKey returns access token", () => {
    const credentials = {
      access: "test-access-token",
      refresh: "test-refresh-token",
      expires: Date.now() + 36e5
    };
    const apiKey = githubCopilotOAuthProvider.getApiKey(credentials);
    assert.equal(apiKey, "test-access-token");
  });
  test("modifyModels preserves non-Copilot models", () => {
    if (!githubCopilotOAuthProvider.modifyModels) return;
    const models = [createModel({ id: "gpt-4", provider: "openai" })];
    const credentials = {
      access: "test-token",
      refresh: "test-refresh",
      expires: Date.now() + 36e5
    };
    const result = githubCopilotOAuthProvider.modifyModels(models, credentials);
    assert.deepEqual(result, models);
  });
  test("modifyModels updates Copilot model baseUrl when token has proxy-ep", () => {
    if (!githubCopilotOAuthProvider.modifyModels) return;
    const models = [
      createModel({
        id: "claude-3.5-sonnet",
        provider: "github-copilot",
        baseUrl: "https://api.default.com"
      })
    ];
    const credentials = {
      access: "tid=123;exp=1234567890;proxy-ep=proxy.individual.githubcopilot.com;",
      refresh: "test-refresh",
      expires: Date.now() + 36e5
    };
    const result = githubCopilotOAuthProvider.modifyModels(models, credentials);
    assert.equal(result[0].baseUrl, "https://api.individual.githubcopilot.com");
  });
  test("modifyModels applies model limits when available", () => {
    if (!githubCopilotOAuthProvider.modifyModels) return;
    const models = [
      createModel({
        id: "claude-3.5-sonnet",
        provider: "github-copilot",
        baseUrl: "https://api.default.com"
      })
    ];
    const credentials = {
      access: "test-token",
      refresh: "test-refresh",
      expires: Date.now() + 36e5,
      modelLimits: {
        "claude-3.5-sonnet": { contextWindow: 123456, maxTokens: 4096 }
      }
    };
    const result = githubCopilotOAuthProvider.modifyModels(models, credentials);
    assert.equal(result[0].contextWindow, 123456);
    assert.equal(result[0].maxTokens, 4096);
  });
});
describe("GitHub Copilot OAuth \u2014 credential regression", () => {
  test("module imports successfully", () => {
    assert.ok(githubCopilotOAuthProvider);
  });
  test("device login sends the public OAuth client id without a client secret", async (t) => {
    const calls = [];
    const originalFetch = globalThis.fetch;
    t.after(() => {
      globalThis.fetch = originalFetch;
    });
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (url.endsWith("/login/device/code")) {
        return Response.json({
          device_code: "device-code",
          user_code: "ABCD-EFGH",
          verification_uri: "https://github.com/login/device",
          interval: 1,
          expires_in: 600
        });
      }
      if (url.endsWith("/login/oauth/access_token")) {
        return Response.json({ access_token: "github-access-token" });
      }
      if (url.endsWith("/copilot_internal/v2/token")) {
        return Response.json({
          token: "tid=123;exp=1234567890;proxy-ep=proxy.individual.githubcopilot.com;",
          expires_at: Math.floor(Date.now() / 1e3) + 3600
        });
      }
      if (url.endsWith("/models")) {
        return Response.json({ data: [] });
      }
      if (url.includes("/models/") && url.endsWith("/policy")) {
        return Response.json({ ok: true });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };
    const credentials = await loginGitHubCopilot({
      onPrompt: async () => "",
      onAuth: () => {
      }
    });
    assert.equal(credentials.access, "tid=123;exp=1234567890;proxy-ep=proxy.individual.githubcopilot.com;");
    const deviceCodeCall = calls.find((call) => call.url.endsWith("/login/device/code"));
    assert.ok(deviceCodeCall, "device-code request should be sent");
    const requestBody = deviceCodeCall.init.body;
    assert.equal(typeof requestBody, "string");
    const body = JSON.parse(requestBody);
    assert.equal(body.client_id, "Iv1.b507a08c87ecfe98");
    assert.equal("client_secret" in body, false, "GitHub device flow must not send a client secret");
  });
});
test("githubCopilotOAuthProvider.modifyModels filters unavailable copilot models (#3849)", () => {
  const models = [
    createModel({ provider: "github-copilot", id: "gpt-5", name: "gpt-5", baseUrl: "github-copilot:" }),
    createModel({ provider: "github-copilot", id: "claude-sonnet-4", name: "claude-sonnet-4", baseUrl: "github-copilot:" }),
    createModel({ provider: "openai", id: "gpt-4.1", name: "gpt-4.1", baseUrl: "openai:" })
  ];
  assert.ok(githubCopilotOAuthProvider.modifyModels, "github copilot provider should expose modifyModels");
  const modified = githubCopilotOAuthProvider.modifyModels(
    models,
    makeCredentials({
      modelLimits: {
        "gpt-5": { contextWindow: 256e3, maxTokens: 32e3 }
      }
    })
  );
  assert.deepEqual(
    modified.map((model) => `${model.provider}/${model.id}`),
    ["github-copilot/gpt-5", "openai/gpt-4.1"]
  );
  const copilotModel = modified.find((model) => model.provider === "github-copilot" && model.id === "gpt-5");
  assert.ok(copilotModel, "available copilot model should remain");
  assert.equal(copilotModel.contextWindow, 256e3);
  assert.equal(copilotModel.maxTokens, 32e3);
  assert.match(copilotModel.baseUrl, /githubcopilot\.com/);
});
test("githubCopilotOAuthProvider.modifyModels keeps all copilot models when limits are unavailable", () => {
  const models = [
    createModel({ provider: "github-copilot", id: "gpt-5", name: "gpt-5", baseUrl: "github-copilot:" }),
    createModel({ provider: "github-copilot", id: "claude-sonnet-4", name: "claude-sonnet-4", baseUrl: "github-copilot:" })
  ];
  assert.ok(githubCopilotOAuthProvider.modifyModels, "github copilot provider should expose modifyModels");
  const modified = githubCopilotOAuthProvider.modifyModels(models, makeCredentials());
  assert.equal(modified.length, 2, "lack of limits should not hide every copilot model");
  assert.ok(modified.every((model) => model.provider === "github-copilot"));
  assert.ok(modified.every((model) => model.baseUrl.includes("githubcopilot.com")));
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWkvc3JjL3V0aWxzL29hdXRoL2dpdGh1Yi1jb3BpbG90LnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IGRlc2NyaWJlLCB0ZXN0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgdHlwZSB7IEFwaSwgTW9kZWwgfSBmcm9tIFwiLi4vLi4vdHlwZXMuanNcIjtcbmltcG9ydCB0eXBlIHsgT0F1dGhDcmVkZW50aWFscyB9IGZyb20gXCIuL3R5cGVzLmpzXCI7XG5pbXBvcnQge1xuXHRnZXRHaXRIdWJDb3BpbG90QmFzZVVybCxcblx0Z2l0aHViQ29waWxvdE9BdXRoUHJvdmlkZXIsXG5cdGxvZ2luR2l0SHViQ29waWxvdCxcblx0bm9ybWFsaXplRG9tYWluLFxufSBmcm9tIFwiLi9naXRodWItY29waWxvdC5qc1wiO1xuXG5mdW5jdGlvbiBjcmVhdGVNb2RlbChvdmVycmlkZXM6IFBhcnRpYWw8TW9kZWw8QXBpPj4gPSB7fSk6IE1vZGVsPEFwaT4ge1xuXHRyZXR1cm4ge1xuXHRcdGlkOiBcInRlc3QtbW9kZWxcIixcblx0XHRuYW1lOiBcIlRlc3QgTW9kZWxcIixcblx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0cHJvdmlkZXI6IFwidGVzdC1wcm92aWRlclwiLFxuXHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9leGFtcGxlLmNvbVwiLFxuXHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0Y29zdDogeyBpbnB1dDogMCwgb3V0cHV0OiAwLCBjYWNoZVJlYWQ6IDAsIGNhY2hlV3JpdGU6IDAgfSxcblx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0bWF4VG9rZW5zOiA4MTkyLFxuXHRcdC4uLm92ZXJyaWRlcyxcblx0fSBhcyBNb2RlbDxBcGk+O1xufVxuXG5mdW5jdGlvbiBtYWtlQ3JlZGVudGlhbHMoXG5cdG92ZXJyaWRlczogUGFydGlhbDxPQXV0aENyZWRlbnRpYWxzICYgeyBtb2RlbExpbWl0cz86IFJlY29yZDxzdHJpbmcsIHsgY29udGV4dFdpbmRvdzogbnVtYmVyOyBtYXhUb2tlbnM6IG51bWJlciB9PiB9PiA9IHt9LFxuKSB7XG5cdHJldHVybiB7XG5cdFx0YWNjZXNzOiBcImNvcGlsb3QtdG9rZW5cIixcblx0XHRyZWZyZXNoOiBcInJlZnJlc2gtdG9rZW5cIixcblx0XHRleHBpcmVzOiBEYXRlLm5vdygpICsgNjBfMDAwLFxuXHRcdC4uLm92ZXJyaWRlcyxcblx0fTtcbn1cblxuZGVzY3JpYmUoXCJHaXRIdWIgQ29waWxvdCBPQXV0aCBcdTIwMTQgbm9ybWFsaXplRG9tYWluXCIsICgpID0+IHtcblx0dGVzdChcInJldHVybnMgbnVsbCBmb3IgZW1wdHkgaW5wdXRcIiwgKCkgPT4ge1xuXHRcdGFzc2VydC5lcXVhbChub3JtYWxpemVEb21haW4oXCJcIiksIG51bGwpO1xuXHRcdGFzc2VydC5lcXVhbChub3JtYWxpemVEb21haW4oXCIgICBcIiksIG51bGwpO1xuXHR9KTtcblxuXHR0ZXN0KFwicmV0dXJucyBudWxsIGZvciBpbnZhbGlkIGRvbWFpblwiLCAoKSA9PiB7XG5cdFx0YXNzZXJ0LmVxdWFsKG5vcm1hbGl6ZURvbWFpbihcIm5vdCBhIGRvbWFpbiFAI1wiKSwgbnVsbCk7XG5cdH0pO1xuXG5cdHRlc3QoXCJleHRyYWN0cyBob3N0bmFtZSBmcm9tIGZ1bGwgVVJMXCIsICgpID0+IHtcblx0XHRhc3NlcnQuZXF1YWwobm9ybWFsaXplRG9tYWluKFwiaHR0cHM6Ly9naXRodWIuY29tXCIpLCBcImdpdGh1Yi5jb21cIik7XG5cdFx0YXNzZXJ0LmVxdWFsKG5vcm1hbGl6ZURvbWFpbihcImh0dHBzOi8vY29tcGFueS5naGUuY29tXCIpLCBcImNvbXBhbnkuZ2hlLmNvbVwiKTtcblx0XHRhc3NlcnQuZXF1YWwobm9ybWFsaXplRG9tYWluKFwiaHR0cDovL2V4YW1wbGUuY29tL3BhdGhcIiksIFwiZXhhbXBsZS5jb21cIik7XG5cdH0pO1xuXG5cdHRlc3QoXCJyZXR1cm5zIGRvbWFpbiBhcy1pcyB3aGVuIG5vIHByb3RvY29sXCIsICgpID0+IHtcblx0XHRhc3NlcnQuZXF1YWwobm9ybWFsaXplRG9tYWluKFwiZ2l0aHViLmNvbVwiKSwgXCJnaXRodWIuY29tXCIpO1xuXHRcdGFzc2VydC5lcXVhbChub3JtYWxpemVEb21haW4oXCJjb21wYW55LmdoZS5jb21cIiksIFwiY29tcGFueS5naGUuY29tXCIpO1xuXHR9KTtcblxuXHR0ZXN0KFwidHJpbXMgd2hpdGVzcGFjZVwiLCAoKSA9PiB7XG5cdFx0YXNzZXJ0LmVxdWFsKG5vcm1hbGl6ZURvbWFpbihcIiAgZ2l0aHViLmNvbSAgXCIpLCBcImdpdGh1Yi5jb21cIik7XG5cdH0pO1xufSk7XG5cbmRlc2NyaWJlKFwiR2l0SHViIENvcGlsb3QgT0F1dGggXHUyMDE0IGdldEJhc2VVcmxGcm9tVG9rZW5cIiwgKCkgPT4ge1xuXHR0ZXN0KFwiZXh0cmFjdHMgQVBJIFVSTCBmcm9tIHRva2VuIHdpdGggcHJveHktZXBcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHRva2VuID0gXCJ0aWQ9MTIzO2V4cD0xMjM0NTY3ODkwO3Byb3h5LWVwPXByb3h5LmluZGl2aWR1YWwuZ2l0aHViY29waWxvdC5jb207b3RoZXI9dmFsdWVcIjtcblx0XHRjb25zdCBiYXNlVXJsID0gZ2V0R2l0SHViQ29waWxvdEJhc2VVcmwodG9rZW4pO1xuXHRcdGFzc2VydC5lcXVhbChiYXNlVXJsLCBcImh0dHBzOi8vYXBpLmluZGl2aWR1YWwuZ2l0aHViY29waWxvdC5jb21cIik7XG5cdH0pO1xuXG5cdHRlc3QoXCJleHRyYWN0cyBBUEkgVVJMIGZyb20gZW50ZXJwcmlzZSBwcm94eS1lcFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgdG9rZW4gPSBcInRpZD0xMjM7ZXhwPTEyMzQ1Njc4OTA7cHJveHktZXA9cHJveHkuY29tcGFueS5naGUuY29tO290aGVyPXZhbHVlXCI7XG5cdFx0Y29uc3QgYmFzZVVybCA9IGdldEdpdEh1YkNvcGlsb3RCYXNlVXJsKHRva2VuKTtcblx0XHRhc3NlcnQuZXF1YWwoYmFzZVVybCwgXCJodHRwczovL2FwaS5jb21wYW55LmdoZS5jb21cIik7XG5cdH0pO1xuXG5cdHRlc3QoXCJmYWxscyBiYWNrIHRvIGRlZmF1bHQgd2hlbiBubyB0b2tlbiBwcm92aWRlZFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgYmFzZVVybCA9IGdldEdpdEh1YkNvcGlsb3RCYXNlVXJsKCk7XG5cdFx0YXNzZXJ0LmVxdWFsKGJhc2VVcmwsIFwiaHR0cHM6Ly9hcGkuaW5kaXZpZHVhbC5naXRodWJjb3BpbG90LmNvbVwiKTtcblx0fSk7XG5cblx0dGVzdChcImZhbGxzIGJhY2sgdG8gZGVmYXVsdCB3aGVuIHRva2VuIGhhcyBubyBwcm94eS1lcFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgdG9rZW4gPSBcInRpZD0xMjM7ZXhwPTEyMzQ1Njc4OTA7b3RoZXI9dmFsdWVcIjtcblx0XHRjb25zdCBiYXNlVXJsID0gZ2V0R2l0SHViQ29waWxvdEJhc2VVcmwodG9rZW4pO1xuXHRcdGFzc2VydC5lcXVhbChiYXNlVXJsLCBcImh0dHBzOi8vYXBpLmluZGl2aWR1YWwuZ2l0aHViY29waWxvdC5jb21cIik7XG5cdH0pO1xuXG5cdHRlc3QoXCJ1c2VzIGVudGVycHJpc2UgZG9tYWluIHdoZW4gcHJvdmlkZWRcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGJhc2VVcmwgPSBnZXRHaXRIdWJDb3BpbG90QmFzZVVybCh1bmRlZmluZWQsIFwiY29tcGFueS5naGUuY29tXCIpO1xuXHRcdGFzc2VydC5lcXVhbChiYXNlVXJsLCBcImh0dHBzOi8vY29waWxvdC1hcGkuY29tcGFueS5naGUuY29tXCIpO1xuXHR9KTtcblxuXHR0ZXN0KFwicHJpb3JpdGl6ZXMgdG9rZW4gcHJveHktZXAgb3ZlciBlbnRlcnByaXNlIGRvbWFpblwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgdG9rZW4gPSBcInRpZD0xMjM7ZXhwPTEyMzQ1Njc4OTA7cHJveHktZXA9cHJveHkuaW5kaXZpZHVhbC5naXRodWJjb3BpbG90LmNvbTtvdGhlcj12YWx1ZVwiO1xuXHRcdGNvbnN0IGJhc2VVcmwgPSBnZXRHaXRIdWJDb3BpbG90QmFzZVVybCh0b2tlbiwgXCJjb21wYW55LmdoZS5jb21cIik7XG5cdFx0YXNzZXJ0LmVxdWFsKGJhc2VVcmwsIFwiaHR0cHM6Ly9hcGkuaW5kaXZpZHVhbC5naXRodWJjb3BpbG90LmNvbVwiKTtcblx0fSk7XG59KTtcblxuZGVzY3JpYmUoXCJHaXRIdWIgQ29waWxvdCBPQXV0aCBcdTIwMTQgcHJvdmlkZXIgc3RydWN0dXJlXCIsICgpID0+IHtcblx0dGVzdChcImhhcyBjb3JyZWN0IGlkIGFuZCBuYW1lXCIsICgpID0+IHtcblx0XHRhc3NlcnQuZXF1YWwoZ2l0aHViQ29waWxvdE9BdXRoUHJvdmlkZXIuaWQsIFwiZ2l0aHViLWNvcGlsb3RcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKGdpdGh1YkNvcGlsb3RPQXV0aFByb3ZpZGVyLm5hbWUsIFwiR2l0SHViIENvcGlsb3RcIik7XG5cdH0pO1xuXG5cdHRlc3QoXCJoYXMgcmVxdWlyZWQgbWV0aG9kc1wiLCAoKSA9PiB7XG5cdFx0YXNzZXJ0LmVxdWFsKHR5cGVvZiBnaXRodWJDb3BpbG90T0F1dGhQcm92aWRlci5sb2dpbiwgXCJmdW5jdGlvblwiKTtcblx0XHRhc3NlcnQuZXF1YWwodHlwZW9mIGdpdGh1YkNvcGlsb3RPQXV0aFByb3ZpZGVyLnJlZnJlc2hUb2tlbiwgXCJmdW5jdGlvblwiKTtcblx0XHRhc3NlcnQuZXF1YWwodHlwZW9mIGdpdGh1YkNvcGlsb3RPQXV0aFByb3ZpZGVyLmdldEFwaUtleSwgXCJmdW5jdGlvblwiKTtcblx0XHRhc3NlcnQuZXF1YWwodHlwZW9mIGdpdGh1YkNvcGlsb3RPQXV0aFByb3ZpZGVyLm1vZGlmeU1vZGVscywgXCJmdW5jdGlvblwiKTtcblx0fSk7XG5cblx0dGVzdChcImdldEFwaUtleSByZXR1cm5zIGFjY2VzcyB0b2tlblwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgY3JlZGVudGlhbHM6IE9BdXRoQ3JlZGVudGlhbHMgPSB7XG5cdFx0XHRhY2Nlc3M6IFwidGVzdC1hY2Nlc3MtdG9rZW5cIixcblx0XHRcdHJlZnJlc2g6IFwidGVzdC1yZWZyZXNoLXRva2VuXCIsXG5cdFx0XHRleHBpcmVzOiBEYXRlLm5vdygpICsgMzYwMDAwMCxcblx0XHR9O1xuXHRcdGNvbnN0IGFwaUtleSA9IGdpdGh1YkNvcGlsb3RPQXV0aFByb3ZpZGVyLmdldEFwaUtleShjcmVkZW50aWFscyk7XG5cdFx0YXNzZXJ0LmVxdWFsKGFwaUtleSwgXCJ0ZXN0LWFjY2Vzcy10b2tlblwiKTtcblx0fSk7XG5cblx0dGVzdChcIm1vZGlmeU1vZGVscyBwcmVzZXJ2ZXMgbm9uLUNvcGlsb3QgbW9kZWxzXCIsICgpID0+IHtcblx0XHRpZiAoIWdpdGh1YkNvcGlsb3RPQXV0aFByb3ZpZGVyLm1vZGlmeU1vZGVscykgcmV0dXJuO1xuXHRcdGNvbnN0IG1vZGVscyA9IFtjcmVhdGVNb2RlbCh7IGlkOiBcImdwdC00XCIsIHByb3ZpZGVyOiBcIm9wZW5haVwiIH0pXTtcblx0XHRjb25zdCBjcmVkZW50aWFsczogT0F1dGhDcmVkZW50aWFscyA9IHtcblx0XHRcdGFjY2VzczogXCJ0ZXN0LXRva2VuXCIsXG5cdFx0XHRyZWZyZXNoOiBcInRlc3QtcmVmcmVzaFwiLFxuXHRcdFx0ZXhwaXJlczogRGF0ZS5ub3coKSArIDM2MDAwMDAsXG5cdFx0fTtcblx0XHRjb25zdCByZXN1bHQgPSBnaXRodWJDb3BpbG90T0F1dGhQcm92aWRlci5tb2RpZnlNb2RlbHMobW9kZWxzLCBjcmVkZW50aWFscyk7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQsIG1vZGVscyk7XG5cdH0pO1xuXG5cdHRlc3QoXCJtb2RpZnlNb2RlbHMgdXBkYXRlcyBDb3BpbG90IG1vZGVsIGJhc2VVcmwgd2hlbiB0b2tlbiBoYXMgcHJveHktZXBcIiwgKCkgPT4ge1xuXHRcdGlmICghZ2l0aHViQ29waWxvdE9BdXRoUHJvdmlkZXIubW9kaWZ5TW9kZWxzKSByZXR1cm47XG5cdFx0Y29uc3QgbW9kZWxzID0gW1xuXHRcdFx0Y3JlYXRlTW9kZWwoe1xuXHRcdFx0XHRpZDogXCJjbGF1ZGUtMy41LXNvbm5ldFwiLFxuXHRcdFx0XHRwcm92aWRlcjogXCJnaXRodWItY29waWxvdFwiLFxuXHRcdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYXBpLmRlZmF1bHQuY29tXCIsXG5cdFx0XHR9KSxcblx0XHRdO1xuXHRcdGNvbnN0IGNyZWRlbnRpYWxzOiBPQXV0aENyZWRlbnRpYWxzID0ge1xuXHRcdFx0YWNjZXNzOiBcInRpZD0xMjM7ZXhwPTEyMzQ1Njc4OTA7cHJveHktZXA9cHJveHkuaW5kaXZpZHVhbC5naXRodWJjb3BpbG90LmNvbTtcIixcblx0XHRcdHJlZnJlc2g6IFwidGVzdC1yZWZyZXNoXCIsXG5cdFx0XHRleHBpcmVzOiBEYXRlLm5vdygpICsgMzYwMDAwMCxcblx0XHR9O1xuXHRcdGNvbnN0IHJlc3VsdCA9IGdpdGh1YkNvcGlsb3RPQXV0aFByb3ZpZGVyLm1vZGlmeU1vZGVscyhtb2RlbHMsIGNyZWRlbnRpYWxzKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0WzBdLmJhc2VVcmwsIFwiaHR0cHM6Ly9hcGkuaW5kaXZpZHVhbC5naXRodWJjb3BpbG90LmNvbVwiKTtcblx0fSk7XG5cblx0dGVzdChcIm1vZGlmeU1vZGVscyBhcHBsaWVzIG1vZGVsIGxpbWl0cyB3aGVuIGF2YWlsYWJsZVwiLCAoKSA9PiB7XG5cdFx0aWYgKCFnaXRodWJDb3BpbG90T0F1dGhQcm92aWRlci5tb2RpZnlNb2RlbHMpIHJldHVybjtcblx0XHRjb25zdCBtb2RlbHMgPSBbXG5cdFx0XHRjcmVhdGVNb2RlbCh7XG5cdFx0XHRcdGlkOiBcImNsYXVkZS0zLjUtc29ubmV0XCIsXG5cdFx0XHRcdHByb3ZpZGVyOiBcImdpdGh1Yi1jb3BpbG90XCIsXG5cdFx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9hcGkuZGVmYXVsdC5jb21cIixcblx0XHRcdH0pLFxuXHRcdF07XG5cdFx0Y29uc3QgY3JlZGVudGlhbHMgPSB7XG5cdFx0XHRhY2Nlc3M6IFwidGVzdC10b2tlblwiLFxuXHRcdFx0cmVmcmVzaDogXCJ0ZXN0LXJlZnJlc2hcIixcblx0XHRcdGV4cGlyZXM6IERhdGUubm93KCkgKyAzNjAwMDAwLFxuXHRcdFx0bW9kZWxMaW1pdHM6IHtcblx0XHRcdFx0XCJjbGF1ZGUtMy41LXNvbm5ldFwiOiB7IGNvbnRleHRXaW5kb3c6IDEyMzQ1NiwgbWF4VG9rZW5zOiA0MDk2IH0sXG5cdFx0XHR9LFxuXHRcdH07XG5cdFx0Y29uc3QgcmVzdWx0ID0gZ2l0aHViQ29waWxvdE9BdXRoUHJvdmlkZXIubW9kaWZ5TW9kZWxzKG1vZGVscywgY3JlZGVudGlhbHMpO1xuXHRcdGFzc2VydC5lcXVhbChyZXN1bHRbMF0uY29udGV4dFdpbmRvdywgMTIzNDU2KTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0WzBdLm1heFRva2VucywgNDA5Nik7XG5cdH0pO1xufSk7XG5cbmRlc2NyaWJlKFwiR2l0SHViIENvcGlsb3QgT0F1dGggXHUyMDE0IGNyZWRlbnRpYWwgcmVncmVzc2lvblwiLCAoKSA9PiB7XG5cdHRlc3QoXCJtb2R1bGUgaW1wb3J0cyBzdWNjZXNzZnVsbHlcIiwgKCkgPT4ge1xuXHRcdGFzc2VydC5vayhnaXRodWJDb3BpbG90T0F1dGhQcm92aWRlcik7XG5cdH0pO1xuXG5cdHRlc3QoXCJkZXZpY2UgbG9naW4gc2VuZHMgdGhlIHB1YmxpYyBPQXV0aCBjbGllbnQgaWQgd2l0aG91dCBhIGNsaWVudCBzZWNyZXRcIiwgYXN5bmMgKHQpID0+IHtcblx0XHRjb25zdCBjYWxsczogQXJyYXk8eyB1cmw6IHN0cmluZzsgaW5pdDogUmVxdWVzdEluaXQgfT4gPSBbXTtcblx0XHRjb25zdCBvcmlnaW5hbEZldGNoID0gZ2xvYmFsVGhpcy5mZXRjaDtcblx0XHR0LmFmdGVyKCgpID0+IHtcblx0XHRcdGdsb2JhbFRoaXMuZmV0Y2ggPSBvcmlnaW5hbEZldGNoO1xuXHRcdH0pO1xuXG5cdFx0Z2xvYmFsVGhpcy5mZXRjaCA9IGFzeW5jIChpbnB1dDogc3RyaW5nIHwgVVJMIHwgUmVxdWVzdCwgaW5pdD86IFJlcXVlc3RJbml0KSA9PiB7XG5cdFx0XHRjb25zdCB1cmwgPSBTdHJpbmcoaW5wdXQpO1xuXHRcdFx0Y2FsbHMucHVzaCh7IHVybCwgaW5pdDogaW5pdCA/PyB7fSB9KTtcblxuXHRcdFx0aWYgKHVybC5lbmRzV2l0aChcIi9sb2dpbi9kZXZpY2UvY29kZVwiKSkge1xuXHRcdFx0XHRyZXR1cm4gUmVzcG9uc2UuanNvbih7XG5cdFx0XHRcdFx0ZGV2aWNlX2NvZGU6IFwiZGV2aWNlLWNvZGVcIixcblx0XHRcdFx0XHR1c2VyX2NvZGU6IFwiQUJDRC1FRkdIXCIsXG5cdFx0XHRcdFx0dmVyaWZpY2F0aW9uX3VyaTogXCJodHRwczovL2dpdGh1Yi5jb20vbG9naW4vZGV2aWNlXCIsXG5cdFx0XHRcdFx0aW50ZXJ2YWw6IDEsXG5cdFx0XHRcdFx0ZXhwaXJlc19pbjogNjAwLFxuXHRcdFx0XHR9KTtcblx0XHRcdH1cblxuXHRcdFx0aWYgKHVybC5lbmRzV2l0aChcIi9sb2dpbi9vYXV0aC9hY2Nlc3NfdG9rZW5cIikpIHtcblx0XHRcdFx0cmV0dXJuIFJlc3BvbnNlLmpzb24oeyBhY2Nlc3NfdG9rZW46IFwiZ2l0aHViLWFjY2Vzcy10b2tlblwiIH0pO1xuXHRcdFx0fVxuXG5cdFx0XHRpZiAodXJsLmVuZHNXaXRoKFwiL2NvcGlsb3RfaW50ZXJuYWwvdjIvdG9rZW5cIikpIHtcblx0XHRcdFx0cmV0dXJuIFJlc3BvbnNlLmpzb24oe1xuXHRcdFx0XHRcdHRva2VuOiBcInRpZD0xMjM7ZXhwPTEyMzQ1Njc4OTA7cHJveHktZXA9cHJveHkuaW5kaXZpZHVhbC5naXRodWJjb3BpbG90LmNvbTtcIixcblx0XHRcdFx0XHRleHBpcmVzX2F0OiBNYXRoLmZsb29yKERhdGUubm93KCkgLyAxMDAwKSArIDM2MDAsXG5cdFx0XHRcdH0pO1xuXHRcdFx0fVxuXG5cdFx0XHRpZiAodXJsLmVuZHNXaXRoKFwiL21vZGVsc1wiKSkge1xuXHRcdFx0XHRyZXR1cm4gUmVzcG9uc2UuanNvbih7IGRhdGE6IFtdIH0pO1xuXHRcdFx0fVxuXG5cdFx0XHRpZiAodXJsLmluY2x1ZGVzKFwiL21vZGVscy9cIikgJiYgdXJsLmVuZHNXaXRoKFwiL3BvbGljeVwiKSkge1xuXHRcdFx0XHRyZXR1cm4gUmVzcG9uc2UuanNvbih7IG9rOiB0cnVlIH0pO1xuXHRcdFx0fVxuXG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoYFVuZXhwZWN0ZWQgZmV0Y2g6ICR7dXJsfWApO1xuXHRcdH07XG5cblx0XHRjb25zdCBjcmVkZW50aWFscyA9IGF3YWl0IGxvZ2luR2l0SHViQ29waWxvdCh7XG5cdFx0XHRvblByb21wdDogYXN5bmMgKCkgPT4gXCJcIixcblx0XHRcdG9uQXV0aDogKCkgPT4ge30sXG5cdFx0fSk7XG5cblx0XHRhc3NlcnQuZXF1YWwoY3JlZGVudGlhbHMuYWNjZXNzLCBcInRpZD0xMjM7ZXhwPTEyMzQ1Njc4OTA7cHJveHktZXA9cHJveHkuaW5kaXZpZHVhbC5naXRodWJjb3BpbG90LmNvbTtcIik7XG5cdFx0Y29uc3QgZGV2aWNlQ29kZUNhbGwgPSBjYWxscy5maW5kKChjYWxsKSA9PiBjYWxsLnVybC5lbmRzV2l0aChcIi9sb2dpbi9kZXZpY2UvY29kZVwiKSk7XG5cdFx0YXNzZXJ0Lm9rKGRldmljZUNvZGVDYWxsLCBcImRldmljZS1jb2RlIHJlcXVlc3Qgc2hvdWxkIGJlIHNlbnRcIik7XG5cdFx0Y29uc3QgcmVxdWVzdEJvZHkgPSBkZXZpY2VDb2RlQ2FsbC5pbml0LmJvZHk7XG5cdFx0YXNzZXJ0LmVxdWFsKHR5cGVvZiByZXF1ZXN0Qm9keSwgXCJzdHJpbmdcIik7XG5cdFx0Y29uc3QgYm9keSA9IEpTT04ucGFyc2UocmVxdWVzdEJvZHkgYXMgc3RyaW5nKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcblx0XHRhc3NlcnQuZXF1YWwoYm9keS5jbGllbnRfaWQsIFwiSXYxLmI1MDdhMDhjODdlY2ZlOThcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKFwiY2xpZW50X3NlY3JldFwiIGluIGJvZHksIGZhbHNlLCBcIkdpdEh1YiBkZXZpY2UgZmxvdyBtdXN0IG5vdCBzZW5kIGEgY2xpZW50IHNlY3JldFwiKTtcblx0fSk7XG59KTtcblxudGVzdChcImdpdGh1YkNvcGlsb3RPQXV0aFByb3ZpZGVyLm1vZGlmeU1vZGVscyBmaWx0ZXJzIHVuYXZhaWxhYmxlIGNvcGlsb3QgbW9kZWxzICgjMzg0OSlcIiwgKCkgPT4ge1xuXHRjb25zdCBtb2RlbHMgPSBbXG5cdFx0Y3JlYXRlTW9kZWwoeyBwcm92aWRlcjogXCJnaXRodWItY29waWxvdFwiLCBpZDogXCJncHQtNVwiLCBuYW1lOiBcImdwdC01XCIsIGJhc2VVcmw6IFwiZ2l0aHViLWNvcGlsb3Q6XCIgfSksXG5cdFx0Y3JlYXRlTW9kZWwoeyBwcm92aWRlcjogXCJnaXRodWItY29waWxvdFwiLCBpZDogXCJjbGF1ZGUtc29ubmV0LTRcIiwgbmFtZTogXCJjbGF1ZGUtc29ubmV0LTRcIiwgYmFzZVVybDogXCJnaXRodWItY29waWxvdDpcIiB9KSxcblx0XHRjcmVhdGVNb2RlbCh7IHByb3ZpZGVyOiBcIm9wZW5haVwiLCBpZDogXCJncHQtNC4xXCIsIG5hbWU6IFwiZ3B0LTQuMVwiLCBiYXNlVXJsOiBcIm9wZW5haTpcIiB9KSxcblx0XTtcblxuXHRhc3NlcnQub2soZ2l0aHViQ29waWxvdE9BdXRoUHJvdmlkZXIubW9kaWZ5TW9kZWxzLCBcImdpdGh1YiBjb3BpbG90IHByb3ZpZGVyIHNob3VsZCBleHBvc2UgbW9kaWZ5TW9kZWxzXCIpO1xuXHRjb25zdCBtb2RpZmllZCA9IGdpdGh1YkNvcGlsb3RPQXV0aFByb3ZpZGVyLm1vZGlmeU1vZGVscyhcblx0XHRtb2RlbHMsXG5cdFx0bWFrZUNyZWRlbnRpYWxzKHtcblx0XHRcdG1vZGVsTGltaXRzOiB7XG5cdFx0XHRcdFwiZ3B0LTVcIjogeyBjb250ZXh0V2luZG93OiAyNTYwMDAsIG1heFRva2VuczogMzIwMDAgfSxcblx0XHRcdH0sXG5cdFx0fSksXG5cdCk7XG5cblx0YXNzZXJ0LmRlZXBFcXVhbChcblx0XHRtb2RpZmllZC5tYXAoKG1vZGVsKSA9PiBgJHttb2RlbC5wcm92aWRlcn0vJHttb2RlbC5pZH1gKSxcblx0XHRbXCJnaXRodWItY29waWxvdC9ncHQtNVwiLCBcIm9wZW5haS9ncHQtNC4xXCJdLFxuXHQpO1xuXG5cdGNvbnN0IGNvcGlsb3RNb2RlbCA9IG1vZGlmaWVkLmZpbmQoKG1vZGVsKSA9PiBtb2RlbC5wcm92aWRlciA9PT0gXCJnaXRodWItY29waWxvdFwiICYmIG1vZGVsLmlkID09PSBcImdwdC01XCIpO1xuXHRhc3NlcnQub2soY29waWxvdE1vZGVsLCBcImF2YWlsYWJsZSBjb3BpbG90IG1vZGVsIHNob3VsZCByZW1haW5cIik7XG5cdGFzc2VydC5lcXVhbChjb3BpbG90TW9kZWwuY29udGV4dFdpbmRvdywgMjU2MDAwKTtcblx0YXNzZXJ0LmVxdWFsKGNvcGlsb3RNb2RlbC5tYXhUb2tlbnMsIDMyMDAwKTtcblx0YXNzZXJ0Lm1hdGNoKGNvcGlsb3RNb2RlbC5iYXNlVXJsLCAvZ2l0aHViY29waWxvdFxcLmNvbS8pO1xufSk7XG5cbnRlc3QoXCJnaXRodWJDb3BpbG90T0F1dGhQcm92aWRlci5tb2RpZnlNb2RlbHMga2VlcHMgYWxsIGNvcGlsb3QgbW9kZWxzIHdoZW4gbGltaXRzIGFyZSB1bmF2YWlsYWJsZVwiLCAoKSA9PiB7XG5cdGNvbnN0IG1vZGVscyA9IFtcblx0XHRjcmVhdGVNb2RlbCh7IHByb3ZpZGVyOiBcImdpdGh1Yi1jb3BpbG90XCIsIGlkOiBcImdwdC01XCIsIG5hbWU6IFwiZ3B0LTVcIiwgYmFzZVVybDogXCJnaXRodWItY29waWxvdDpcIiB9KSxcblx0XHRjcmVhdGVNb2RlbCh7IHByb3ZpZGVyOiBcImdpdGh1Yi1jb3BpbG90XCIsIGlkOiBcImNsYXVkZS1zb25uZXQtNFwiLCBuYW1lOiBcImNsYXVkZS1zb25uZXQtNFwiLCBiYXNlVXJsOiBcImdpdGh1Yi1jb3BpbG90OlwiIH0pLFxuXHRdO1xuXG5cdGFzc2VydC5vayhnaXRodWJDb3BpbG90T0F1dGhQcm92aWRlci5tb2RpZnlNb2RlbHMsIFwiZ2l0aHViIGNvcGlsb3QgcHJvdmlkZXIgc2hvdWxkIGV4cG9zZSBtb2RpZnlNb2RlbHNcIik7XG5cdGNvbnN0IG1vZGlmaWVkID0gZ2l0aHViQ29waWxvdE9BdXRoUHJvdmlkZXIubW9kaWZ5TW9kZWxzKG1vZGVscywgbWFrZUNyZWRlbnRpYWxzKCkpO1xuXG5cdGFzc2VydC5lcXVhbChtb2RpZmllZC5sZW5ndGgsIDIsIFwibGFjayBvZiBsaW1pdHMgc2hvdWxkIG5vdCBoaWRlIGV2ZXJ5IGNvcGlsb3QgbW9kZWxcIik7XG5cdGFzc2VydC5vayhtb2RpZmllZC5ldmVyeSgobW9kZWwpID0+IG1vZGVsLnByb3ZpZGVyID09PSBcImdpdGh1Yi1jb3BpbG90XCIpKTtcblx0YXNzZXJ0Lm9rKG1vZGlmaWVkLmV2ZXJ5KChtb2RlbCkgPT4gbW9kZWwuYmFzZVVybC5pbmNsdWRlcyhcImdpdGh1YmNvcGlsb3QuY29tXCIpKSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsVUFBVSxZQUFZO0FBQy9CLE9BQU8sWUFBWTtBQUduQjtBQUFBLEVBQ0M7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNNO0FBRVAsU0FBUyxZQUFZLFlBQWlDLENBQUMsR0FBZTtBQUNyRSxTQUFPO0FBQUEsSUFDTixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTSxFQUFFLE9BQU8sR0FBRyxRQUFRLEdBQUcsV0FBVyxHQUFHLFlBQVksRUFBRTtBQUFBLElB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QixJQUFJLG1CQUFtQixNQUFNLG1CQUFtQixTQUFTLGtCQUFrQixDQUFDO0FBQUEsSUFDdEgsWUFBWSxFQUFFLFVBQVUsVUFBVSxJQUFJLFdBQVcsTUFBTSxXQUFXLFNBQVMsVUFBVSxDQUFDO0FBQUEsRUFDdkY7QUFFQSxTQUFPLEdBQUcsMkJBQTJCLGNBQWMsb0RBQW9EO0FBQ3ZHLFFBQU0sV0FBVywyQkFBMkI7QUFBQSxJQUMzQztBQUFBLElBQ0EsZ0JBQWdCO0FBQUEsTUFDZixhQUFhO0FBQUEsUUFDWixTQUFTLEVBQUUsZUFBZSxPQUFRLFdBQVcsS0FBTTtBQUFBLE1BQ3BEO0FBQUEsSUFDRCxDQUFDO0FBQUEsRUFDRjtBQUVBLFNBQU87QUFBQSxJQUNOLFNBQVMsSUFBSSxDQUFDLFVBQVUsR0FBRyxNQUFNLFFBQVEsSUFBSSxNQUFNLEVBQUUsRUFBRTtBQUFBLElBQ3ZELENBQUMsd0JBQXdCLGdCQUFnQjtBQUFBLEVBQzFDO0FBRUEsUUFBTSxlQUFlLFNBQVMsS0FBSyxDQUFDLFVBQVUsTUFBTSxhQUFhLG9CQUFvQixNQUFNLE9BQU8sT0FBTztBQUN6RyxTQUFPLEdBQUcsY0FBYyx1Q0FBdUM7QUFDL0QsU0FBTyxNQUFNLGFBQWEsZUFBZSxLQUFNO0FBQy9DLFNBQU8sTUFBTSxhQUFhLFdBQVcsSUFBSztBQUMxQyxTQUFPLE1BQU0sYUFBYSxTQUFTLG9CQUFvQjtBQUN4RCxDQUFDO0FBRUQsS0FBSyxnR0FBZ0csTUFBTTtBQUMxRyxRQUFNLFNBQVM7QUFBQSxJQUNkLFlBQVksRUFBRSxVQUFVLGtCQUFrQixJQUFJLFNBQVMsTUFBTSxTQUFTLFNBQVMsa0JBQWtCLENBQUM7QUFBQSxJQUNsRyxZQUFZLEVBQUUsVUFBVSxrQkFBa0IsSUFBSSxtQkFBbUIsTUFBTSxtQkFBbUIsU0FBUyxrQkFBa0IsQ0FBQztBQUFBLEVBQ3ZIO0FBRUEsU0FBTyxHQUFHLDJCQUEyQixjQUFjLG9EQUFvRDtBQUN2RyxRQUFNLFdBQVcsMkJBQTJCLGFBQWEsUUFBUSxnQkFBZ0IsQ0FBQztBQUVsRixTQUFPLE1BQU0sU0FBUyxRQUFRLEdBQUcsb0RBQW9EO0FBQ3JGLFNBQU8sR0FBRyxTQUFTLE1BQU0sQ0FBQyxVQUFVLE1BQU0sYUFBYSxnQkFBZ0IsQ0FBQztBQUN4RSxTQUFPLEdBQUcsU0FBUyxNQUFNLENBQUMsVUFBVSxNQUFNLFFBQVEsU0FBUyxtQkFBbUIsQ0FBQyxDQUFDO0FBQ2pGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
