import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";
let testDir;
beforeEach(() => {
  testDir = join(
    tmpdir(),
    `model-registry-custom-caps-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(testDir, { recursive: true });
});
afterEach(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
  }
});
function createRegistry(modelsJson) {
  const path = join(testDir, "models.json");
  writeFileSync(path, JSON.stringify(modelsJson));
  return new ModelRegistry(AuthStorage.inMemory(), path);
}
function writeModelsJson(obj) {
  const path = join(testDir, "models.json");
  writeFileSync(path, JSON.stringify(obj));
  return path;
}
describe("Bug 1 \u2014 maxTokens cap (#4563)", () => {
  it("custom openai-completions model with maxTokens > 32 k is not capped", () => {
    const registry = createRegistry({
      providers: {
        "kimi-custom": {
          baseUrl: "https://api.example.com/v1",
          apiKey: "sk-test",
          api: "openai-completions",
          models: [
            {
              id: "kimi-k2.6-code-preview",
              name: "Kimi K2.6 Code Preview",
              maxTokens: 131072,
              contextWindow: 262144
            }
          ]
        }
      }
    });
    const model = registry.getAll().find((m) => m.id === "kimi-k2.6-code-preview");
    assert.ok(model, "model should be registered");
    assert.equal(
      model.maxTokens,
      131072,
      "maxTokens must be preserved as declared \u2014 not capped to 32 000"
    );
  });
  it("custom model with maxTokens exactly 32 k is not affected", () => {
    const registry = createRegistry({
      providers: {
        "custom-provider": {
          baseUrl: "https://api.example.com/v1",
          apiKey: "sk-test",
          api: "openai-completions",
          models: [{ id: "model-32k", maxTokens: 32e3, contextWindow: 128e3 }]
        }
      }
    });
    const model = registry.getAll().find((m) => m.id === "model-32k");
    assert.ok(model);
    assert.equal(model.maxTokens, 32e3);
  });
  it("custom model with maxTokens 65 k is stored at full value", () => {
    const registry = createRegistry({
      providers: {
        "dashscope-custom": {
          baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
          apiKey: "sk-test",
          api: "openai-completions",
          models: [
            {
              id: "qwen3.5-plus",
              name: "Qwen3.5 Plus",
              maxTokens: 65536,
              contextWindow: 1e6
            }
          ]
        }
      }
    });
    const model = registry.getAll().find((m) => m.id === "qwen3.5-plus" && m.provider === "dashscope-custom");
    assert.ok(model);
    assert.equal(model.maxTokens, 65536);
  });
});
describe("Bug 2 \u2014 capabilities.supportsXhigh in models.json (#4563)", () => {
  it("model with capabilities.supportsXhigh: true surfaces the flag", () => {
    const registry = createRegistry({
      providers: {
        "kimi-custom": {
          baseUrl: "https://api.example.com/v1",
          apiKey: "sk-test",
          api: "anthropic-messages",
          models: [
            {
              id: "kimi-k2.6-code-preview",
              name: "Kimi K2.6 Code Preview",
              maxTokens: 131072,
              contextWindow: 262144,
              capabilities: { supportsXhigh: true }
            }
          ]
        }
      }
    });
    const model = registry.getAll().find((m) => m.id === "kimi-k2.6-code-preview");
    assert.ok(model, "model should be registered");
    assert.equal(
      model.capabilities?.supportsXhigh,
      true,
      "supportsXhigh must be true as declared in models.json"
    );
  });
  it("model without capabilities declaration has no supportsXhigh", () => {
    const registry = createRegistry({
      providers: {
        "plain-provider": {
          baseUrl: "https://api.example.com/v1",
          apiKey: "sk-test",
          api: "openai-completions",
          models: [{ id: "plain-model", maxTokens: 16384, contextWindow: 128e3 }]
        }
      }
    });
    const model = registry.getAll().find((m) => m.id === "plain-model");
    assert.ok(model);
    assert.ok(
      !model.capabilities?.supportsXhigh,
      "supportsXhigh must not be set for models that don't declare it"
    );
  });
  it("capabilities.supportsXhigh: false is respected", () => {
    const registry = createRegistry({
      providers: {
        "explicit-provider": {
          baseUrl: "https://api.example.com/v1",
          apiKey: "sk-test",
          api: "openai-completions",
          models: [
            {
              id: "no-xhigh-model",
              capabilities: { supportsXhigh: false }
            }
          ]
        }
      }
    });
    const model = registry.getAll().find((m) => m.id === "no-xhigh-model");
    assert.ok(model);
    assert.equal(model.capabilities?.supportsXhigh, false);
  });
  it("supportsXhigh declared in models.json is not overwritten by capability patches", () => {
    const registry = createRegistry({
      providers: {
        "compat-provider": {
          baseUrl: "https://api.example.com/v1",
          apiKey: "sk-test",
          api: "openai-completions",
          models: [
            {
              id: "custom-xhigh-model",
              capabilities: { supportsXhigh: true }
            }
          ]
        }
      }
    });
    const model = registry.getAll().find((m) => m.id === "custom-xhigh-model");
    assert.ok(model);
    assert.equal(model.capabilities?.supportsXhigh, true);
  });
  it("modelOverrides can set capabilities.supportsXhigh on built-in models", () => {
    const path = writeModelsJson({
      providers: {
        anthropic: {
          modelOverrides: {
            "claude-3-5-haiku-20241022": {
              capabilities: { supportsXhigh: true }
            }
          }
        }
      }
    });
    const registry = new ModelRegistry(AuthStorage.inMemory(), path);
    const model = registry.getAll().find(
      (m) => m.provider === "anthropic" && m.id === "claude-3-5-haiku-20241022"
    );
    assert.ok(model, "built-in model must still be present");
    assert.equal(
      model.capabilities?.supportsXhigh,
      true,
      "modelOverrides must be able to set capabilities.supportsXhigh"
    );
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL21vZGVsLXJlZ2lzdHJ5LWN1c3RvbS1jYXBzLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogUmVncmVzc2lvbiB0ZXN0cyBmb3IgIzQ1NjM6XG4gKiAgIEJ1ZyAxIFx1MjAxNCBjdXN0b20vQW50aHJvcGljLWNvbXBhdGlibGUgbW9kZWxzIHdlcmUgaGFyZC1jYXBwZWQgdG8gMzIgayBvdXRwdXQgdG9rZW5zXG4gKiAgIEJ1ZyAyIFx1MjAxNCBjdXN0b20gbW9kZWxzIGluIG1vZGVscy5qc29uIGNvdWxkIG5vdCBkZWNsYXJlIGNhcGFiaWxpdGllcy5zdXBwb3J0c1hoaWdoXG4gKi9cbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkaXJTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBhZnRlckVhY2gsIGJlZm9yZUVhY2gsIGRlc2NyaWJlLCBpdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCB7IEF1dGhTdG9yYWdlIH0gZnJvbSBcIi4vYXV0aC1zdG9yYWdlLmpzXCI7XG5pbXBvcnQgeyBNb2RlbFJlZ2lzdHJ5IH0gZnJvbSBcIi4vbW9kZWwtcmVnaXN0cnkuanNcIjtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEhlbHBlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmxldCB0ZXN0RGlyOiBzdHJpbmc7XG5cbmJlZm9yZUVhY2goKCkgPT4ge1xuXHR0ZXN0RGlyID0gam9pbihcblx0XHR0bXBkaXIoKSxcblx0XHRgbW9kZWwtcmVnaXN0cnktY3VzdG9tLWNhcHMtJHtEYXRlLm5vdygpfS0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIpfWAsXG5cdCk7XG5cdG1rZGlyU3luYyh0ZXN0RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbn0pO1xuXG5hZnRlckVhY2goKCkgPT4ge1xuXHR0cnkge1xuXHRcdHJtU3luYyh0ZXN0RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG5cdH0gY2F0Y2gge1xuXHRcdC8vIGJlc3QtZWZmb3J0IGNsZWFudXBcblx0fVxufSk7XG5cbmZ1bmN0aW9uIGNyZWF0ZVJlZ2lzdHJ5KG1vZGVsc0pzb246IG9iamVjdCk6IE1vZGVsUmVnaXN0cnkge1xuXHRjb25zdCBwYXRoID0gam9pbih0ZXN0RGlyLCBcIm1vZGVscy5qc29uXCIpO1xuXHR3cml0ZUZpbGVTeW5jKHBhdGgsIEpTT04uc3RyaW5naWZ5KG1vZGVsc0pzb24pKTtcblx0cmV0dXJuIG5ldyBNb2RlbFJlZ2lzdHJ5KEF1dGhTdG9yYWdlLmluTWVtb3J5KCksIHBhdGgpO1xufVxuXG5mdW5jdGlvbiB3cml0ZU1vZGVsc0pzb24ob2JqOiBvYmplY3QpOiBzdHJpbmcge1xuXHRjb25zdCBwYXRoID0gam9pbih0ZXN0RGlyLCBcIm1vZGVscy5qc29uXCIpO1xuXHR3cml0ZUZpbGVTeW5jKHBhdGgsIEpTT04uc3RyaW5naWZ5KG9iaikpO1xuXHRyZXR1cm4gcGF0aDtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEJ1ZyAxOiAzMiBrIGNhcCBtdXN0IG5vdCBhcHBseSB0byBjdXN0b20vT3BlbkFJLWNvbXBhdGlibGUgbW9kZWxzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcIkJ1ZyAxIFx1MjAxNCBtYXhUb2tlbnMgY2FwICgjNDU2MylcIiwgKCkgPT4ge1xuXHRpdChcImN1c3RvbSBvcGVuYWktY29tcGxldGlvbnMgbW9kZWwgd2l0aCBtYXhUb2tlbnMgPiAzMiBrIGlzIG5vdCBjYXBwZWRcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlZ2lzdHJ5ID0gY3JlYXRlUmVnaXN0cnkoe1xuXHRcdFx0cHJvdmlkZXJzOiB7XG5cdFx0XHRcdFwia2ltaS1jdXN0b21cIjoge1xuXHRcdFx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9hcGkuZXhhbXBsZS5jb20vdjFcIixcblx0XHRcdFx0XHRhcGlLZXk6IFwic2stdGVzdFwiLFxuXHRcdFx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdFx0XHRtb2RlbHM6IFtcblx0XHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdFx0aWQ6IFwia2ltaS1rMi42LWNvZGUtcHJldmlld1wiLFxuXHRcdFx0XHRcdFx0XHRuYW1lOiBcIktpbWkgSzIuNiBDb2RlIFByZXZpZXdcIixcblx0XHRcdFx0XHRcdFx0bWF4VG9rZW5zOiAxMzEwNzIsXG5cdFx0XHRcdFx0XHRcdGNvbnRleHRXaW5kb3c6IDI2MjE0NCxcblx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XSxcblx0XHRcdFx0fSxcblx0XHRcdH0sXG5cdFx0fSk7XG5cblx0XHRjb25zdCBtb2RlbCA9IHJlZ2lzdHJ5LmdldEFsbCgpLmZpbmQoKG0pID0+IG0uaWQgPT09IFwia2ltaS1rMi42LWNvZGUtcHJldmlld1wiKTtcblx0XHRhc3NlcnQub2sobW9kZWwsIFwibW9kZWwgc2hvdWxkIGJlIHJlZ2lzdGVyZWRcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKFxuXHRcdFx0bW9kZWwubWF4VG9rZW5zLFxuXHRcdFx0MTMxMDcyLFxuXHRcdFx0XCJtYXhUb2tlbnMgbXVzdCBiZSBwcmVzZXJ2ZWQgYXMgZGVjbGFyZWQgXHUyMDE0IG5vdCBjYXBwZWQgdG8gMzIgMDAwXCIsXG5cdFx0KTtcblx0fSk7XG5cblx0aXQoXCJjdXN0b20gbW9kZWwgd2l0aCBtYXhUb2tlbnMgZXhhY3RseSAzMiBrIGlzIG5vdCBhZmZlY3RlZFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVnaXN0cnkgPSBjcmVhdGVSZWdpc3RyeSh7XG5cdFx0XHRwcm92aWRlcnM6IHtcblx0XHRcdFx0XCJjdXN0b20tcHJvdmlkZXJcIjoge1xuXHRcdFx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9hcGkuZXhhbXBsZS5jb20vdjFcIixcblx0XHRcdFx0XHRhcGlLZXk6IFwic2stdGVzdFwiLFxuXHRcdFx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdFx0XHRtb2RlbHM6IFt7IGlkOiBcIm1vZGVsLTMya1wiLCBtYXhUb2tlbnM6IDMyMDAwLCBjb250ZXh0V2luZG93OiAxMjgwMDAgfV0sXG5cdFx0XHRcdH0sXG5cdFx0XHR9LFxuXHRcdH0pO1xuXG5cdFx0Y29uc3QgbW9kZWwgPSByZWdpc3RyeS5nZXRBbGwoKS5maW5kKChtKSA9PiBtLmlkID09PSBcIm1vZGVsLTMya1wiKTtcblx0XHRhc3NlcnQub2sobW9kZWwpO1xuXHRcdGFzc2VydC5lcXVhbChtb2RlbC5tYXhUb2tlbnMsIDMyMDAwKTtcblx0fSk7XG5cblx0aXQoXCJjdXN0b20gbW9kZWwgd2l0aCBtYXhUb2tlbnMgNjUgayBpcyBzdG9yZWQgYXQgZnVsbCB2YWx1ZVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVnaXN0cnkgPSBjcmVhdGVSZWdpc3RyeSh7XG5cdFx0XHRwcm92aWRlcnM6IHtcblx0XHRcdFx0XCJkYXNoc2NvcGUtY3VzdG9tXCI6IHtcblx0XHRcdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vZGFzaHNjb3BlLWludGwuYWxpeXVuY3MuY29tL2NvbXBhdGlibGUtbW9kZS92MVwiLFxuXHRcdFx0XHRcdGFwaUtleTogXCJzay10ZXN0XCIsXG5cdFx0XHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0XHRcdG1vZGVsczogW1xuXHRcdFx0XHRcdFx0e1xuXHRcdFx0XHRcdFx0XHRpZDogXCJxd2VuMy41LXBsdXNcIixcblx0XHRcdFx0XHRcdFx0bmFtZTogXCJRd2VuMy41IFBsdXNcIixcblx0XHRcdFx0XHRcdFx0bWF4VG9rZW5zOiA2NTUzNixcblx0XHRcdFx0XHRcdFx0Y29udGV4dFdpbmRvdzogMTAwMDAwMCxcblx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XSxcblx0XHRcdFx0fSxcblx0XHRcdH0sXG5cdFx0fSk7XG5cblx0XHRjb25zdCBtb2RlbCA9IHJlZ2lzdHJ5LmdldEFsbCgpLmZpbmQoKG0pID0+IG0uaWQgPT09IFwicXdlbjMuNS1wbHVzXCIgJiYgbS5wcm92aWRlciA9PT0gXCJkYXNoc2NvcGUtY3VzdG9tXCIpO1xuXHRcdGFzc2VydC5vayhtb2RlbCk7XG5cdFx0YXNzZXJ0LmVxdWFsKG1vZGVsLm1heFRva2VucywgNjU1MzYpO1xuXHR9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQnVnIDI6IGNhcGFiaWxpdGllcy5zdXBwb3J0c1hoaWdoIG11c3QgYmUgZGVjbGFyYWJsZSBpbiBtb2RlbHMuanNvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJCdWcgMiBcdTIwMTQgY2FwYWJpbGl0aWVzLnN1cHBvcnRzWGhpZ2ggaW4gbW9kZWxzLmpzb24gKCM0NTYzKVwiLCAoKSA9PiB7XG5cdGl0KFwibW9kZWwgd2l0aCBjYXBhYmlsaXRpZXMuc3VwcG9ydHNYaGlnaDogdHJ1ZSBzdXJmYWNlcyB0aGUgZmxhZ1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVnaXN0cnkgPSBjcmVhdGVSZWdpc3RyeSh7XG5cdFx0XHRwcm92aWRlcnM6IHtcblx0XHRcdFx0XCJraW1pLWN1c3RvbVwiOiB7XG5cdFx0XHRcdFx0YmFzZVVybDogXCJodHRwczovL2FwaS5leGFtcGxlLmNvbS92MVwiLFxuXHRcdFx0XHRcdGFwaUtleTogXCJzay10ZXN0XCIsXG5cdFx0XHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0XHRcdG1vZGVsczogW1xuXHRcdFx0XHRcdFx0e1xuXHRcdFx0XHRcdFx0XHRpZDogXCJraW1pLWsyLjYtY29kZS1wcmV2aWV3XCIsXG5cdFx0XHRcdFx0XHRcdG5hbWU6IFwiS2ltaSBLMi42IENvZGUgUHJldmlld1wiLFxuXHRcdFx0XHRcdFx0XHRtYXhUb2tlbnM6IDEzMTA3Mixcblx0XHRcdFx0XHRcdFx0Y29udGV4dFdpbmRvdzogMjYyMTQ0LFxuXHRcdFx0XHRcdFx0XHRjYXBhYmlsaXRpZXM6IHsgc3VwcG9ydHNYaGlnaDogdHJ1ZSB9LFxuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRdLFxuXHRcdFx0XHR9LFxuXHRcdFx0fSxcblx0XHR9KTtcblxuXHRcdGNvbnN0IG1vZGVsID0gcmVnaXN0cnkuZ2V0QWxsKCkuZmluZCgobSkgPT4gbS5pZCA9PT0gXCJraW1pLWsyLjYtY29kZS1wcmV2aWV3XCIpO1xuXHRcdGFzc2VydC5vayhtb2RlbCwgXCJtb2RlbCBzaG91bGQgYmUgcmVnaXN0ZXJlZFwiKTtcblx0XHRhc3NlcnQuZXF1YWwoXG5cdFx0XHRtb2RlbC5jYXBhYmlsaXRpZXM/LnN1cHBvcnRzWGhpZ2gsXG5cdFx0XHR0cnVlLFxuXHRcdFx0XCJzdXBwb3J0c1hoaWdoIG11c3QgYmUgdHJ1ZSBhcyBkZWNsYXJlZCBpbiBtb2RlbHMuanNvblwiLFxuXHRcdCk7XG5cdH0pO1xuXG5cdGl0KFwibW9kZWwgd2l0aG91dCBjYXBhYmlsaXRpZXMgZGVjbGFyYXRpb24gaGFzIG5vIHN1cHBvcnRzWGhpZ2hcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlZ2lzdHJ5ID0gY3JlYXRlUmVnaXN0cnkoe1xuXHRcdFx0cHJvdmlkZXJzOiB7XG5cdFx0XHRcdFwicGxhaW4tcHJvdmlkZXJcIjoge1xuXHRcdFx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9hcGkuZXhhbXBsZS5jb20vdjFcIixcblx0XHRcdFx0XHRhcGlLZXk6IFwic2stdGVzdFwiLFxuXHRcdFx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdFx0XHRtb2RlbHM6IFt7IGlkOiBcInBsYWluLW1vZGVsXCIsIG1heFRva2VuczogMTYzODQsIGNvbnRleHRXaW5kb3c6IDEyODAwMCB9XSxcblx0XHRcdFx0fSxcblx0XHRcdH0sXG5cdFx0fSk7XG5cblx0XHRjb25zdCBtb2RlbCA9IHJlZ2lzdHJ5LmdldEFsbCgpLmZpbmQoKG0pID0+IG0uaWQgPT09IFwicGxhaW4tbW9kZWxcIik7XG5cdFx0YXNzZXJ0Lm9rKG1vZGVsKTtcblx0XHQvLyBzdXBwb3J0c1hoaWdoIHNob3VsZCBiZSBhYnNlbnQgb3IgZXhwbGljaXRseSBmYWxzZSBcdTIwMTQgbmV2ZXIgaW1wbGljaXRseSB0cnVlXG5cdFx0YXNzZXJ0Lm9rKFxuXHRcdFx0IW1vZGVsLmNhcGFiaWxpdGllcz8uc3VwcG9ydHNYaGlnaCxcblx0XHRcdFwic3VwcG9ydHNYaGlnaCBtdXN0IG5vdCBiZSBzZXQgZm9yIG1vZGVscyB0aGF0IGRvbid0IGRlY2xhcmUgaXRcIixcblx0XHQpO1xuXHR9KTtcblxuXHRpdChcImNhcGFiaWxpdGllcy5zdXBwb3J0c1hoaWdoOiBmYWxzZSBpcyByZXNwZWN0ZWRcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlZ2lzdHJ5ID0gY3JlYXRlUmVnaXN0cnkoe1xuXHRcdFx0cHJvdmlkZXJzOiB7XG5cdFx0XHRcdFwiZXhwbGljaXQtcHJvdmlkZXJcIjoge1xuXHRcdFx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9hcGkuZXhhbXBsZS5jb20vdjFcIixcblx0XHRcdFx0XHRhcGlLZXk6IFwic2stdGVzdFwiLFxuXHRcdFx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdFx0XHRtb2RlbHM6IFtcblx0XHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdFx0aWQ6IFwibm8teGhpZ2gtbW9kZWxcIixcblx0XHRcdFx0XHRcdFx0Y2FwYWJpbGl0aWVzOiB7IHN1cHBvcnRzWGhpZ2g6IGZhbHNlIH0sXG5cdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdF0sXG5cdFx0XHRcdH0sXG5cdFx0XHR9LFxuXHRcdH0pO1xuXG5cdFx0Y29uc3QgbW9kZWwgPSByZWdpc3RyeS5nZXRBbGwoKS5maW5kKChtKSA9PiBtLmlkID09PSBcIm5vLXhoaWdoLW1vZGVsXCIpO1xuXHRcdGFzc2VydC5vayhtb2RlbCk7XG5cdFx0YXNzZXJ0LmVxdWFsKG1vZGVsLmNhcGFiaWxpdGllcz8uc3VwcG9ydHNYaGlnaCwgZmFsc2UpO1xuXHR9KTtcblxuXHRpdChcInN1cHBvcnRzWGhpZ2ggZGVjbGFyZWQgaW4gbW9kZWxzLmpzb24gaXMgbm90IG92ZXJ3cml0dGVuIGJ5IGNhcGFiaWxpdHkgcGF0Y2hlc1wiLCAoKSA9PiB7XG5cdFx0Ly8gVGhlIGNhcGFiaWxpdHktcGF0Y2hlcyBzeXN0ZW0gbXVzdCBub3Qgb3ZlcndyaXRlIGFuIGV4cGxpY2l0IGRlY2xhcmF0aW9uIGluIG1vZGVscy5qc29uLlxuXHRcdC8vIGFwcGx5Q2FwYWJpbGl0eVBhdGNoZXMgdXNlcyBzcHJlYWQ6IHsgLi4ucGF0Y2guY2FwcywgLi4ubW9kZWwuY2FwYWJpbGl0aWVzIH1cblx0XHQvLyBzbyBtb2RlbC5jYXBhYmlsaXRpZXMgd2lucy4gVGhpcyB0ZXN0IHZlcmlmaWVzIHRoZSBwcmVjZWRlbmNlIGVuZC10by1lbmQuXG5cdFx0Y29uc3QgcmVnaXN0cnkgPSBjcmVhdGVSZWdpc3RyeSh7XG5cdFx0XHRwcm92aWRlcnM6IHtcblx0XHRcdFx0XCJjb21wYXQtcHJvdmlkZXJcIjoge1xuXHRcdFx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9hcGkuZXhhbXBsZS5jb20vdjFcIixcblx0XHRcdFx0XHRhcGlLZXk6IFwic2stdGVzdFwiLFxuXHRcdFx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdFx0XHRtb2RlbHM6IFtcblx0XHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdFx0aWQ6IFwiY3VzdG9tLXhoaWdoLW1vZGVsXCIsXG5cdFx0XHRcdFx0XHRcdGNhcGFiaWxpdGllczogeyBzdXBwb3J0c1hoaWdoOiB0cnVlIH0sXG5cdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdF0sXG5cdFx0XHRcdH0sXG5cdFx0XHR9LFxuXHRcdH0pO1xuXG5cdFx0Y29uc3QgbW9kZWwgPSByZWdpc3RyeS5nZXRBbGwoKS5maW5kKChtKSA9PiBtLmlkID09PSBcImN1c3RvbS14aGlnaC1tb2RlbFwiKTtcblx0XHRhc3NlcnQub2sobW9kZWwpO1xuXHRcdGFzc2VydC5lcXVhbChtb2RlbC5jYXBhYmlsaXRpZXM/LnN1cHBvcnRzWGhpZ2gsIHRydWUpO1xuXHR9KTtcblxuXHRpdChcIm1vZGVsT3ZlcnJpZGVzIGNhbiBzZXQgY2FwYWJpbGl0aWVzLnN1cHBvcnRzWGhpZ2ggb24gYnVpbHQtaW4gbW9kZWxzXCIsICgpID0+IHtcblx0XHQvLyBBIHVzZXItZmFjaW5nIG92ZXJyaWRlIGluIG1vZGVscy5qc29uIHNob3VsZCBiZSBhYmxlIHRvIGFkZCBzdXBwb3J0c1hoaWdoXG5cdFx0Ly8gdG8gYSBidWlsdC1pbiBtb2RlbCB0aGF0IGRvZXNuJ3QgZGVjbGFyZSBpdC5cblx0XHRjb25zdCBwYXRoID0gd3JpdGVNb2RlbHNKc29uKHtcblx0XHRcdHByb3ZpZGVyczoge1xuXHRcdFx0XHRhbnRocm9waWM6IHtcblx0XHRcdFx0XHRtb2RlbE92ZXJyaWRlczoge1xuXHRcdFx0XHRcdFx0XCJjbGF1ZGUtMy01LWhhaWt1LTIwMjQxMDIyXCI6IHtcblx0XHRcdFx0XHRcdFx0Y2FwYWJpbGl0aWVzOiB7IHN1cHBvcnRzWGhpZ2g6IHRydWUgfSxcblx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0fSxcblx0XHRcdH0sXG5cdFx0fSk7XG5cblx0XHRjb25zdCByZWdpc3RyeSA9IG5ldyBNb2RlbFJlZ2lzdHJ5KEF1dGhTdG9yYWdlLmluTWVtb3J5KCksIHBhdGgpO1xuXHRcdGNvbnN0IG1vZGVsID0gcmVnaXN0cnkuZ2V0QWxsKCkuZmluZChcblx0XHRcdChtKSA9PiBtLnByb3ZpZGVyID09PSBcImFudGhyb3BpY1wiICYmIG0uaWQgPT09IFwiY2xhdWRlLTMtNS1oYWlrdS0yMDI0MTAyMlwiLFxuXHRcdCk7XG5cdFx0YXNzZXJ0Lm9rKG1vZGVsLCBcImJ1aWx0LWluIG1vZGVsIG11c3Qgc3RpbGwgYmUgcHJlc2VudFwiKTtcblx0XHRhc3NlcnQuZXF1YWwoXG5cdFx0XHRtb2RlbC5jYXBhYmlsaXRpZXM/LnN1cHBvcnRzWGhpZ2gsXG5cdFx0XHR0cnVlLFxuXHRcdFx0XCJtb2RlbE92ZXJyaWRlcyBtdXN0IGJlIGFibGUgdG8gc2V0IGNhcGFiaWxpdGllcy5zdXBwb3J0c1hoaWdoXCIsXG5cdFx0KTtcblx0fSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUtBLE9BQU8sWUFBWTtBQUNuQixTQUFTLFdBQVcsUUFBUSxxQkFBcUI7QUFDakQsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsWUFBWTtBQUNyQixTQUFTLFdBQVcsWUFBWSxVQUFVLFVBQVU7QUFDcEQsU0FBUyxtQkFBbUI7QUFDNUIsU0FBUyxxQkFBcUI7QUFJOUIsSUFBSTtBQUVKLFdBQVcsTUFBTTtBQUNoQixZQUFVO0FBQUEsSUFDVCxPQUFPO0FBQUEsSUFDUCw4QkFBOEIsS0FBSyxJQUFJLENBQUMsSUFBSSxLQUFLLE9BQU8sRUFBRSxTQUFTLEVBQUUsRUFBRSxNQUFNLENBQUMsQ0FBQztBQUFBLEVBQ2hGO0FBQ0EsWUFBVSxTQUFTLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDdkMsQ0FBQztBQUVELFVBQVUsTUFBTTtBQUNmLE1BQUk7QUFDSCxXQUFPLFNBQVMsRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUNqRCxRQUFRO0FBQUEsRUFFUjtBQUNELENBQUM7QUFFRCxTQUFTLGVBQWUsWUFBbUM7QUFDMUQsUUFBTSxPQUFPLEtBQUssU0FBUyxhQUFhO0FBQ3hDLGdCQUFjLE1BQU0sS0FBSyxVQUFVLFVBQVUsQ0FBQztBQUM5QyxTQUFPLElBQUksY0FBYyxZQUFZLFNBQVMsR0FBRyxJQUFJO0FBQ3REO0FBRUEsU0FBUyxnQkFBZ0IsS0FBcUI7QUFDN0MsUUFBTSxPQUFPLEtBQUssU0FBUyxhQUFhO0FBQ3hDLGdCQUFjLE1BQU0sS0FBSyxVQUFVLEdBQUcsQ0FBQztBQUN2QyxTQUFPO0FBQ1I7QUFJQSxTQUFTLHNDQUFpQyxNQUFNO0FBQy9DLEtBQUcsdUVBQXVFLE1BQU07QUFDL0UsVUFBTSxXQUFXLGVBQWU7QUFBQSxNQUMvQixXQUFXO0FBQUEsUUFDVixlQUFlO0FBQUEsVUFDZCxTQUFTO0FBQUEsVUFDVCxRQUFRO0FBQUEsVUFDUixLQUFLO0FBQUEsVUFDTCxRQUFRO0FBQUEsWUFDUDtBQUFBLGNBQ0MsSUFBSTtBQUFBLGNBQ0osTUFBTTtBQUFBLGNBQ04sV0FBVztBQUFBLGNBQ1gsZUFBZTtBQUFBLFlBQ2hCO0FBQUEsVUFDRDtBQUFBLFFBQ0Q7QUFBQSxNQUNEO0FBQUEsSUFDRCxDQUFDO0FBRUQsVUFBTSxRQUFRLFNBQVMsT0FBTyxFQUFFLEtBQUssQ0FBQyxNQUFNLEVBQUUsT0FBTyx3QkFBd0I7QUFDN0UsV0FBTyxHQUFHLE9BQU8sNEJBQTRCO0FBQzdDLFdBQU87QUFBQSxNQUNOLE1BQU07QUFBQSxNQUNOO0FBQUEsTUFDQTtBQUFBLElBQ0Q7QUFBQSxFQUNELENBQUM7QUFFRCxLQUFHLDREQUE0RCxNQUFNO0FBQ3BFLFVBQU0sV0FBVyxlQUFlO0FBQUEsTUFDL0IsV0FBVztBQUFBLFFBQ1YsbUJBQW1CO0FBQUEsVUFDbEIsU0FBUztBQUFBLFVBQ1QsUUFBUTtBQUFBLFVBQ1IsS0FBSztBQUFBLFVBQ0wsUUFBUSxDQUFDLEVBQUUsSUFBSSxhQUFhLFdBQVcsTUFBTyxlQUFlLE1BQU8sQ0FBQztBQUFBLFFBQ3RFO0FBQUEsTUFDRDtBQUFBLElBQ0QsQ0FBQztBQUVELFVBQU0sUUFBUSxTQUFTLE9BQU8sRUFBRSxLQUFLLENBQUMsTUFBTSxFQUFFLE9BQU8sV0FBVztBQUNoRSxXQUFPLEdBQUcsS0FBSztBQUNmLFdBQU8sTUFBTSxNQUFNLFdBQVcsSUFBSztBQUFBLEVBQ3BDLENBQUM7QUFFRCxLQUFHLDREQUE0RCxNQUFNO0FBQ3BFLFVBQU0sV0FBVyxlQUFlO0FBQUEsTUFDL0IsV0FBVztBQUFBLFFBQ1Ysb0JBQW9CO0FBQUEsVUFDbkIsU0FBUztBQUFBLFVBQ1QsUUFBUTtBQUFBLFVBQ1IsS0FBSztBQUFBLFVBQ0wsUUFBUTtBQUFBLFlBQ1A7QUFBQSxjQUNDLElBQUk7QUFBQSxjQUNKLE1BQU07QUFBQSxjQUNOLFdBQVc7QUFBQSxjQUNYLGVBQWU7QUFBQSxZQUNoQjtBQUFBLFVBQ0Q7QUFBQSxRQUNEO0FBQUEsTUFDRDtBQUFBLElBQ0QsQ0FBQztBQUVELFVBQU0sUUFBUSxTQUFTLE9BQU8sRUFBRSxLQUFLLENBQUMsTUFBTSxFQUFFLE9BQU8sa0JBQWtCLEVBQUUsYUFBYSxrQkFBa0I7QUFDeEcsV0FBTyxHQUFHLEtBQUs7QUFDZixXQUFPLE1BQU0sTUFBTSxXQUFXLEtBQUs7QUFBQSxFQUNwQyxDQUFDO0FBQ0YsQ0FBQztBQUlELFNBQVMsa0VBQTZELE1BQU07QUFDM0UsS0FBRyxpRUFBaUUsTUFBTTtBQUN6RSxVQUFNLFdBQVcsZUFBZTtBQUFBLE1BQy9CLFdBQVc7QUFBQSxRQUNWLGVBQWU7QUFBQSxVQUNkLFNBQVM7QUFBQSxVQUNULFFBQVE7QUFBQSxVQUNSLEtBQUs7QUFBQSxVQUNMLFFBQVE7QUFBQSxZQUNQO0FBQUEsY0FDQyxJQUFJO0FBQUEsY0FDSixNQUFNO0FBQUEsY0FDTixXQUFXO0FBQUEsY0FDWCxlQUFlO0FBQUEsY0FDZixjQUFjLEVBQUUsZUFBZSxLQUFLO0FBQUEsWUFDckM7QUFBQSxVQUNEO0FBQUEsUUFDRDtBQUFBLE1BQ0Q7QUFBQSxJQUNELENBQUM7QUFFRCxVQUFNLFFBQVEsU0FBUyxPQUFPLEVBQUUsS0FBSyxDQUFDLE1BQU0sRUFBRSxPQUFPLHdCQUF3QjtBQUM3RSxXQUFPLEdBQUcsT0FBTyw0QkFBNEI7QUFDN0MsV0FBTztBQUFBLE1BQ04sTUFBTSxjQUFjO0FBQUEsTUFDcEI7QUFBQSxNQUNBO0FBQUEsSUFDRDtBQUFBLEVBQ0QsQ0FBQztBQUVELEtBQUcsK0RBQStELE1BQU07QUFDdkUsVUFBTSxXQUFXLGVBQWU7QUFBQSxNQUMvQixXQUFXO0FBQUEsUUFDVixrQkFBa0I7QUFBQSxVQUNqQixTQUFTO0FBQUEsVUFDVCxRQUFRO0FBQUEsVUFDUixLQUFLO0FBQUEsVUFDTCxRQUFRLENBQUMsRUFBRSxJQUFJLGVBQWUsV0FBVyxPQUFPLGVBQWUsTUFBTyxDQUFDO0FBQUEsUUFDeEU7QUFBQSxNQUNEO0FBQUEsSUFDRCxDQUFDO0FBRUQsVUFBTSxRQUFRLFNBQVMsT0FBTyxFQUFFLEtBQUssQ0FBQyxNQUFNLEVBQUUsT0FBTyxhQUFhO0FBQ2xFLFdBQU8sR0FBRyxLQUFLO0FBRWYsV0FBTztBQUFBLE1BQ04sQ0FBQyxNQUFNLGNBQWM7QUFBQSxNQUNyQjtBQUFBLElBQ0Q7QUFBQSxFQUNELENBQUM7QUFFRCxLQUFHLGtEQUFrRCxNQUFNO0FBQzFELFVBQU0sV0FBVyxlQUFlO0FBQUEsTUFDL0IsV0FBVztBQUFBLFFBQ1YscUJBQXFCO0FBQUEsVUFDcEIsU0FBUztBQUFBLFVBQ1QsUUFBUTtBQUFBLFVBQ1IsS0FBSztBQUFBLFVBQ0wsUUFBUTtBQUFBLFlBQ1A7QUFBQSxjQUNDLElBQUk7QUFBQSxjQUNKLGNBQWMsRUFBRSxlQUFlLE1BQU07QUFBQSxZQUN0QztBQUFBLFVBQ0Q7QUFBQSxRQUNEO0FBQUEsTUFDRDtBQUFBLElBQ0QsQ0FBQztBQUVELFVBQU0sUUFBUSxTQUFTLE9BQU8sRUFBRSxLQUFLLENBQUMsTUFBTSxFQUFFLE9BQU8sZ0JBQWdCO0FBQ3JFLFdBQU8sR0FBRyxLQUFLO0FBQ2YsV0FBTyxNQUFNLE1BQU0sY0FBYyxlQUFlLEtBQUs7QUFBQSxFQUN0RCxDQUFDO0FBRUQsS0FBRyxrRkFBa0YsTUFBTTtBQUkxRixVQUFNLFdBQVcsZUFBZTtBQUFBLE1BQy9CLFdBQVc7QUFBQSxRQUNWLG1CQUFtQjtBQUFBLFVBQ2xCLFNBQVM7QUFBQSxVQUNULFFBQVE7QUFBQSxVQUNSLEtBQUs7QUFBQSxVQUNMLFFBQVE7QUFBQSxZQUNQO0FBQUEsY0FDQyxJQUFJO0FBQUEsY0FDSixjQUFjLEVBQUUsZUFBZSxLQUFLO0FBQUEsWUFDckM7QUFBQSxVQUNEO0FBQUEsUUFDRDtBQUFBLE1BQ0Q7QUFBQSxJQUNELENBQUM7QUFFRCxVQUFNLFFBQVEsU0FBUyxPQUFPLEVBQUUsS0FBSyxDQUFDLE1BQU0sRUFBRSxPQUFPLG9CQUFvQjtBQUN6RSxXQUFPLEdBQUcsS0FBSztBQUNmLFdBQU8sTUFBTSxNQUFNLGNBQWMsZUFBZSxJQUFJO0FBQUEsRUFDckQsQ0FBQztBQUVELEtBQUcsd0VBQXdFLE1BQU07QUFHaEYsVUFBTSxPQUFPLGdCQUFnQjtBQUFBLE1BQzVCLFdBQVc7QUFBQSxRQUNWLFdBQVc7QUFBQSxVQUNWLGdCQUFnQjtBQUFBLFlBQ2YsNkJBQTZCO0FBQUEsY0FDNUIsY0FBYyxFQUFFLGVBQWUsS0FBSztBQUFBLFlBQ3JDO0FBQUEsVUFDRDtBQUFBLFFBQ0Q7QUFBQSxNQUNEO0FBQUEsSUFDRCxDQUFDO0FBRUQsVUFBTSxXQUFXLElBQUksY0FBYyxZQUFZLFNBQVMsR0FBRyxJQUFJO0FBQy9ELFVBQU0sUUFBUSxTQUFTLE9BQU8sRUFBRTtBQUFBLE1BQy9CLENBQUMsTUFBTSxFQUFFLGFBQWEsZUFBZSxFQUFFLE9BQU87QUFBQSxJQUMvQztBQUNBLFdBQU8sR0FBRyxPQUFPLHNDQUFzQztBQUN2RCxXQUFPO0FBQUEsTUFDTixNQUFNLGNBQWM7QUFBQSxNQUNwQjtBQUFBLE1BQ0E7QUFBQSxJQUNEO0FBQUEsRUFDRCxDQUFDO0FBQ0YsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
