import test from "node:test";
import assert from "node:assert/strict";
import googleSearchExtension from "../../extensions/google-search/index.js";
function createMockPI() {
  const handlers = [];
  let registeredTool = null;
  return {
    handlers,
    registeredTool,
    on(event, handler) {
      handlers.push({ event, handler });
    },
    registerTool(tool) {
      this.registeredTool = tool;
    },
    async fire(event, eventData, ctx) {
      for (const h of handlers) {
        if (h.event === event) {
          await h.handler(eventData, ctx);
        }
      }
    }
  };
}
function mockModelRegistry(oauthJson) {
  return {
    authStorage: {
      hasAuth: async (_id) => !!oauthJson
    },
    getApiKeyForProvider: async (_provider) => oauthJson
  };
}
test("fix: google-search uses OAuth if GEMINI_API_KEY is missing", async (t) => {
  const originalKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.ok(url.includes("cloudcode-pa.googleapis.com"), "Should use Cloud Code Assist endpoint");
    assert.equal(options.headers.Authorization, "Bearer mock-token", "Should use correct bearer token");
    return {
      ok: true,
      json: async () => ({
        response: {
          candidates: [{ content: { parts: [{ text: "Mocked AI Answer" }] } }]
        }
      }),
      text: async () => JSON.stringify({
        response: {
          candidates: [{ content: { parts: [{ text: "Mocked AI Answer" }] } }]
        }
      })
    };
  };
  t.after(() => {
    global.fetch = originalFetch;
    process.env.GEMINI_API_KEY = originalKey;
  });
  const pi = createMockPI();
  googleSearchExtension(pi);
  const oauthJson = JSON.stringify({ token: "mock-token", projectId: "mock-project" });
  const mockCtx = {
    ui: { notify() {
    } },
    modelRegistry: mockModelRegistry(oauthJson)
  };
  await pi.fire("session_start", {}, mockCtx);
  const registeredTool = pi.registeredTool;
  const result = await registeredTool.execute("call-1", { query: "test" }, new AbortController().signal, () => {
  }, mockCtx);
  assert.equal(result.isError, void 0);
  assert.ok(result.content[0].text.includes("Mocked AI Answer"));
});
test("google-search warns if NO authentication is present", async (t) => {
  const originalKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  t.after(() => process.env.GEMINI_API_KEY = originalKey);
  const pi = createMockPI();
  googleSearchExtension(pi);
  const notifications = [];
  const mockCtx = {
    ui: { notify(msg, level) {
      notifications.push({ msg, level });
    } },
    modelRegistry: mockModelRegistry(void 0)
  };
  await pi.fire("session_start", {}, mockCtx);
  assert.equal(notifications.length, 1);
  assert.ok(notifications[0].msg.includes("No authentication set"));
  const registeredTool = pi.registeredTool;
  const result = await registeredTool.execute("call-2", { query: "test" }, new AbortController().signal, () => {
  }, mockCtx);
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes("No authentication found"));
});
test("google-search uses GEMINI_API_KEY if present (precedence)", async (t) => {
  process.env.GEMINI_API_KEY = "mock-api-key";
  t.after(() => delete process.env.GEMINI_API_KEY);
  const pi = createMockPI();
  googleSearchExtension(pi);
  const notifications = [];
  const mockCtx = {
    ui: { notify(msg, level) {
      notifications.push({ msg, level });
    } },
    modelRegistry: mockModelRegistry(JSON.stringify({ token: "should-not-be-used", projectId: "mock-project" }))
  };
  await pi.fire("session_start", {}, mockCtx);
  assert.equal(notifications.length, 0, "Should NOT notify if API Key is present");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3Rlc3RzL2dvb2dsZS1zZWFyY2gtYXV0aC5yZXByby50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCBnb29nbGVTZWFyY2hFeHRlbnNpb24gZnJvbSBcIi4uLy4uL2V4dGVuc2lvbnMvZ29vZ2xlLXNlYXJjaC9pbmRleC50c1wiO1xuXG5mdW5jdGlvbiBjcmVhdGVNb2NrUEkoKSB7XG4gIGNvbnN0IGhhbmRsZXJzOiBhbnlbXSA9IFtdO1xuICBsZXQgcmVnaXN0ZXJlZFRvb2w6IGFueSA9IG51bGw7XG5cbiAgcmV0dXJuIHtcbiAgICBoYW5kbGVycyxcbiAgICByZWdpc3RlcmVkVG9vbCxcbiAgICBvbihldmVudDogc3RyaW5nLCBoYW5kbGVyOiBhbnkpIHtcbiAgICAgIGhhbmRsZXJzLnB1c2goeyBldmVudCwgaGFuZGxlciB9KTtcbiAgICB9LFxuICAgIHJlZ2lzdGVyVG9vbCh0b29sOiBhbnkpIHtcbiAgICAgIHRoaXMucmVnaXN0ZXJlZFRvb2wgPSB0b29sO1xuICAgIH0sXG4gICAgYXN5bmMgZmlyZShldmVudDogc3RyaW5nLCBldmVudERhdGE6IGFueSwgY3R4OiBhbnkpIHtcbiAgICAgIGZvciAoY29uc3QgaCBvZiBoYW5kbGVycykge1xuICAgICAgICBpZiAoaC5ldmVudCA9PT0gZXZlbnQpIHtcbiAgICAgICAgICBhd2FpdCBoLmhhbmRsZXIoZXZlbnREYXRhLCBjdHgpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9O1xufVxuXG4vKipcbiAqIEJ1aWxkIGEgbW9jayBtb2RlbFJlZ2lzdHJ5IHdob3NlIGdldEFwaUtleUZvclByb3ZpZGVyIHJldHVybnMgdGhlIGdpdmVuXG4gKiBKU09OIHN0cmluZyAobWF0Y2hpbmcgd2hhdCB0aGUgcmVhbCBPQXV0aCBwcm92aWRlcidzIGdldEFwaUtleSBwcm9kdWNlcykuXG4gKi9cbmZ1bmN0aW9uIG1vY2tNb2RlbFJlZ2lzdHJ5KG9hdXRoSnNvbj86IHN0cmluZykge1xuICByZXR1cm4ge1xuICAgIGF1dGhTdG9yYWdlOiB7XG4gICAgICBoYXNBdXRoOiBhc3luYyAoX2lkOiBzdHJpbmcpID0+ICEhb2F1dGhKc29uLFxuICAgIH0sXG4gICAgZ2V0QXBpS2V5Rm9yUHJvdmlkZXI6IGFzeW5jIChfcHJvdmlkZXI6IHN0cmluZykgPT4gb2F1dGhKc29uLFxuICB9O1xufVxuXG50ZXN0KFwiZml4OiBnb29nbGUtc2VhcmNoIHVzZXMgT0F1dGggaWYgR0VNSU5JX0FQSV9LRVkgaXMgbWlzc2luZ1wiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBvcmlnaW5hbEtleSA9IHByb2Nlc3MuZW52LkdFTUlOSV9BUElfS0VZO1xuICBkZWxldGUgcHJvY2Vzcy5lbnYuR0VNSU5JX0FQSV9LRVk7XG5cbiAgY29uc3Qgb3JpZ2luYWxGZXRjaCA9IGdsb2JhbC5mZXRjaDtcbiAgKGdsb2JhbCBhcyBhbnkpLmZldGNoID0gYXN5bmMgKHVybDogc3RyaW5nLCBvcHRpb25zOiBhbnkpID0+IHtcbiAgICBhc3NlcnQub2sodXJsLmluY2x1ZGVzKFwiY2xvdWRjb2RlLXBhLmdvb2dsZWFwaXMuY29tXCIpLCBcIlNob3VsZCB1c2UgQ2xvdWQgQ29kZSBBc3Npc3QgZW5kcG9pbnRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKG9wdGlvbnMuaGVhZGVycy5BdXRob3JpemF0aW9uLCBcIkJlYXJlciBtb2NrLXRva2VuXCIsIFwiU2hvdWxkIHVzZSBjb3JyZWN0IGJlYXJlciB0b2tlblwiKTtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IHRydWUsXG4gICAgICBqc29uOiBhc3luYyAoKSA9PiAoe1xuICAgICAgICByZXNwb25zZToge1xuICAgICAgICAgIGNhbmRpZGF0ZXM6IFt7IGNvbnRlbnQ6IHsgcGFydHM6IFt7IHRleHQ6IFwiTW9ja2VkIEFJIEFuc3dlclwiIH1dIH0gfV1cbiAgICAgICAgfVxuICAgICAgfSksXG4gICAgICB0ZXh0OiBhc3luYyAoKSA9PiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIHJlc3BvbnNlOiB7XG4gICAgICAgICAgY2FuZGlkYXRlczogW3sgY29udGVudDogeyBwYXJ0czogW3sgdGV4dDogXCJNb2NrZWQgQUkgQW5zd2VyXCIgfV0gfSB9XVxuICAgICAgICB9XG4gICAgICB9KSxcbiAgICB9O1xuICB9O1xuXG4gIHQuYWZ0ZXIoKCkgPT4ge1xuICAgIGdsb2JhbC5mZXRjaCA9IG9yaWdpbmFsRmV0Y2g7XG4gICAgcHJvY2Vzcy5lbnYuR0VNSU5JX0FQSV9LRVkgPSBvcmlnaW5hbEtleTtcbiAgfSk7XG4gIGNvbnN0IHBpID0gY3JlYXRlTW9ja1BJKCk7XG4gIGdvb2dsZVNlYXJjaEV4dGVuc2lvbihwaSBhcyBhbnkpO1xuXG4gIGNvbnN0IG9hdXRoSnNvbiA9IEpTT04uc3RyaW5naWZ5KHsgdG9rZW46IFwibW9jay10b2tlblwiLCBwcm9qZWN0SWQ6IFwibW9jay1wcm9qZWN0XCIgfSk7XG4gIGNvbnN0IG1vY2tDdHggPSB7XG4gICAgdWk6IHsgbm90aWZ5KCkge30gfSxcbiAgICBtb2RlbFJlZ2lzdHJ5OiBtb2NrTW9kZWxSZWdpc3RyeShvYXV0aEpzb24pLFxuICB9O1xuXG4gIGF3YWl0IHBpLmZpcmUoXCJzZXNzaW9uX3N0YXJ0XCIsIHt9LCBtb2NrQ3R4KTtcbiAgY29uc3QgcmVnaXN0ZXJlZFRvb2wgPSAocGkgYXMgYW55KS5yZWdpc3RlcmVkVG9vbDtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVnaXN0ZXJlZFRvb2wuZXhlY3V0ZShcImNhbGwtMVwiLCB7IHF1ZXJ5OiBcInRlc3RcIiB9LCBuZXcgQWJvcnRDb250cm9sbGVyKCkuc2lnbmFsLCAoKSA9PiB7fSwgbW9ja0N0eCk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5pc0Vycm9yLCB1bmRlZmluZWQpO1xuICBhc3NlcnQub2socmVzdWx0LmNvbnRlbnRbMF0udGV4dC5pbmNsdWRlcyhcIk1vY2tlZCBBSSBBbnN3ZXJcIikpO1xufSk7XG5cbnRlc3QoXCJnb29nbGUtc2VhcmNoIHdhcm5zIGlmIE5PIGF1dGhlbnRpY2F0aW9uIGlzIHByZXNlbnRcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3Qgb3JpZ2luYWxLZXkgPSBwcm9jZXNzLmVudi5HRU1JTklfQVBJX0tFWTtcbiAgZGVsZXRlIHByb2Nlc3MuZW52LkdFTUlOSV9BUElfS0VZO1xuXG4gIHQuYWZ0ZXIoKCkgPT4gcHJvY2Vzcy5lbnYuR0VNSU5JX0FQSV9LRVkgPSBvcmlnaW5hbEtleSk7XG4gIGNvbnN0IHBpID0gY3JlYXRlTW9ja1BJKCk7XG4gIGdvb2dsZVNlYXJjaEV4dGVuc2lvbihwaSBhcyBhbnkpO1xuXG4gIGNvbnN0IG5vdGlmaWNhdGlvbnM6IGFueVtdID0gW107XG4gIGNvbnN0IG1vY2tDdHggPSB7XG4gICAgdWk6IHsgbm90aWZ5KG1zZzogc3RyaW5nLCBsZXZlbDogc3RyaW5nKSB7IG5vdGlmaWNhdGlvbnMucHVzaCh7IG1zZywgbGV2ZWwgfSk7IH0gfSxcbiAgICBtb2RlbFJlZ2lzdHJ5OiBtb2NrTW9kZWxSZWdpc3RyeSh1bmRlZmluZWQpLFxuICB9O1xuXG4gIGF3YWl0IHBpLmZpcmUoXCJzZXNzaW9uX3N0YXJ0XCIsIHt9LCBtb2NrQ3R4KTtcbiAgYXNzZXJ0LmVxdWFsKG5vdGlmaWNhdGlvbnMubGVuZ3RoLCAxKTtcbiAgYXNzZXJ0Lm9rKG5vdGlmaWNhdGlvbnNbMF0ubXNnLmluY2x1ZGVzKFwiTm8gYXV0aGVudGljYXRpb24gc2V0XCIpKTtcblxuICBjb25zdCByZWdpc3RlcmVkVG9vbCA9IChwaSBhcyBhbnkpLnJlZ2lzdGVyZWRUb29sO1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCByZWdpc3RlcmVkVG9vbC5leGVjdXRlKFwiY2FsbC0yXCIsIHsgcXVlcnk6IFwidGVzdFwiIH0sIG5ldyBBYm9ydENvbnRyb2xsZXIoKS5zaWduYWwsICgpID0+IHt9LCBtb2NrQ3R4KTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5pc0Vycm9yLCB0cnVlKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdC5jb250ZW50WzBdLnRleHQuaW5jbHVkZXMoXCJObyBhdXRoZW50aWNhdGlvbiBmb3VuZFwiKSk7XG59KTtcblxudGVzdChcImdvb2dsZS1zZWFyY2ggdXNlcyBHRU1JTklfQVBJX0tFWSBpZiBwcmVzZW50IChwcmVjZWRlbmNlKVwiLCBhc3luYyAodCkgPT4ge1xuICBwcm9jZXNzLmVudi5HRU1JTklfQVBJX0tFWSA9IFwibW9jay1hcGkta2V5XCI7XG5cbiAgdC5hZnRlcigoKSA9PiBkZWxldGUgcHJvY2Vzcy5lbnYuR0VNSU5JX0FQSV9LRVkpO1xuICBjb25zdCBwaSA9IGNyZWF0ZU1vY2tQSSgpO1xuICBnb29nbGVTZWFyY2hFeHRlbnNpb24ocGkgYXMgYW55KTtcblxuICBjb25zdCBub3RpZmljYXRpb25zOiBhbnlbXSA9IFtdO1xuICBjb25zdCBtb2NrQ3R4ID0ge1xuICAgIHVpOiB7IG5vdGlmeShtc2c6IHN0cmluZywgbGV2ZWw6IHN0cmluZykgeyBub3RpZmljYXRpb25zLnB1c2goeyBtc2csIGxldmVsIH0pOyB9IH0sXG4gICAgbW9kZWxSZWdpc3RyeTogbW9ja01vZGVsUmVnaXN0cnkoSlNPTi5zdHJpbmdpZnkoeyB0b2tlbjogXCJzaG91bGQtbm90LWJlLXVzZWRcIiwgcHJvamVjdElkOiBcIm1vY2stcHJvamVjdFwiIH0pKSxcbiAgfTtcblxuICBhd2FpdCBwaS5maXJlKFwic2Vzc2lvbl9zdGFydFwiLCB7fSwgbW9ja0N0eCk7XG4gIGFzc2VydC5lcXVhbChub3RpZmljYXRpb25zLmxlbmd0aCwgMCwgXCJTaG91bGQgTk9UIG5vdGlmeSBpZiBBUEkgS2V5IGlzIHByZXNlbnRcIik7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7QUFDbkIsT0FBTywyQkFBMkI7QUFFbEMsU0FBUyxlQUFlO0FBQ3RC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
