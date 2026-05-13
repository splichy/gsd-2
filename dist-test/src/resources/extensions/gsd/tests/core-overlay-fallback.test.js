import test from "node:test";
import assert from "node:assert/strict";
import { handleCoreCommand } from "../commands/handlers/core.js";
function makeCtx(customResult) {
  const notices = [];
  return {
    hasUI: true,
    ui: {
      custom: async () => customResult,
      notify: (message, type) => {
        notices.push({ message, type });
      }
    },
    notices
  };
}
test("visualize only falls back when ctx.ui.custom() is unavailable", async () => {
  const successCtx = makeCtx(true);
  const success = await handleCoreCommand("visualize", successCtx);
  assert.equal(success, true);
  assert.equal(successCtx.notices.length, 0, "successful overlay close does not trigger fallback");
  const fallbackCtx = makeCtx(void 0);
  const fallback = await handleCoreCommand("visualize", fallbackCtx);
  assert.equal(fallback, true);
  assert.equal(fallbackCtx.notices.length, 1, "unavailable overlay triggers fallback warning");
  assert.match(fallbackCtx.notices[0].message, /interactive terminal/i);
});
test("show-config only falls back when ctx.ui.custom() is unavailable", async () => {
  const successCtx = makeCtx(true);
  const success = await handleCoreCommand("show-config", successCtx);
  assert.equal(success, true);
  assert.equal(successCtx.notices.length, 0, "successful overlay close does not trigger fallback");
  const fallbackCtx = makeCtx(void 0);
  const fallback = await handleCoreCommand("show-config", fallbackCtx);
  assert.equal(fallback, true);
  assert.equal(fallbackCtx.notices.length, 1, "unavailable overlay triggers text fallback");
  assert.match(fallbackCtx.notices[0].message, /GSD Configuration/);
});
test("model command resolves and persists exact provider-qualified selection", async () => {
  const selectedModel = { provider: "openai", id: "gpt-5.4" };
  let applied = null;
  const ctx = {
    hasUI: true,
    model: { provider: "anthropic", id: "claude-sonnet-4-6" },
    modelRegistry: {
      getAvailable: () => [
        { provider: "anthropic", id: "claude-sonnet-4-6" },
        selectedModel
      ]
    },
    ui: {
      notify: (message, type) => {
        notices.push({ message, type });
      }
    }
  };
  const notices = [];
  const pi = {
    setModel: async (model) => {
      applied = model;
      return true;
    }
  };
  const handled = await handleCoreCommand("model openai/gpt-5.4", ctx, pi);
  assert.equal(handled, true);
  assert.deepEqual(applied, selectedModel);
  assert.match(notices[0].message, /openai\/gpt-5\.4/);
});
test("interactive model picker chooses provider first, then model", async () => {
  const selectedModel = { provider: "openai", id: "gpt-5.4" };
  let applied = null;
  const selects = [];
  const notices = [];
  const ctx = {
    hasUI: true,
    model: { provider: "anthropic", id: "claude-sonnet-4-6" },
    modelRegistry: {
      getAvailable: () => [
        { provider: "openai", id: "gpt-5.4" },
        { provider: "anthropic", id: "claude-opus-4-6" },
        { provider: "openai", id: "gpt-5.3-mini" },
        { provider: "anthropic", id: "claude-sonnet-4-6" }
      ]
    },
    ui: {
      select: async (title, options) => {
        selects.push({ title, options });
        return selects.length === 1 ? "openai (2 models)" : "gpt-5.4";
      },
      notify: (message, type) => {
        notices.push({ message, type });
      }
    }
  };
  const pi = {
    setModel: async (model) => {
      applied = model;
      return true;
    }
  };
  const handled = await handleCoreCommand("model", ctx, pi);
  assert.equal(handled, true);
  assert.deepEqual(selects, [
    {
      title: "Select session model: \u2014 choose provider:",
      options: ["anthropic (2 models)", "openai (2 models)", "(cancel)"]
    },
    {
      title: "Select session model: \u2014 openai:",
      options: ["gpt-5.3-mini", "gpt-5.4", "(cancel)"]
    }
  ]);
  assert.deepEqual(applied, selectedModel);
  assert.match(notices[0].message, /openai\/gpt-5\.4/);
});
test("ambiguous typed model selection chooses provider first, then model", async () => {
  const selectedModel = { provider: "github-copilot", id: "gpt-5" };
  let applied = null;
  const selects = [];
  const notices = [];
  const ctx = {
    hasUI: true,
    model: { provider: "anthropic", id: "claude-sonnet-4-6" },
    modelRegistry: {
      getAvailable: () => [
        { provider: "openai", id: "gpt-5" },
        { provider: "github-copilot", id: "gpt-5" },
        { provider: "openai", id: "gpt-5-mini" }
      ]
    },
    ui: {
      select: async (title, options) => {
        selects.push({ title, options });
        return selects.length === 1 ? "github-copilot (1 model)" : "gpt-5";
      },
      notify: (message, type) => {
        notices.push({ message, type });
      }
    }
  };
  const pi = {
    setModel: async (model) => {
      applied = model;
      return true;
    }
  };
  const handled = await handleCoreCommand("model gpt", ctx, pi);
  assert.equal(handled, true);
  assert.deepEqual(selects, [
    {
      title: 'Multiple models match "gpt" \u2014 choose provider:',
      options: ["github-copilot (1 model)", "openai (2 models)", "(cancel)"]
    },
    {
      title: 'Multiple models match "gpt" \u2014 github-copilot:',
      options: ["gpt-5", "(cancel)"]
    }
  ]);
  assert.deepEqual(applied, selectedModel);
  assert.match(notices[0].message, /github-copilot\/gpt-5/);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jb3JlLW92ZXJsYXktZmFsbGJhY2sudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5cbmltcG9ydCB7IGhhbmRsZUNvcmVDb21tYW5kIH0gZnJvbSBcIi4uL2NvbW1hbmRzL2hhbmRsZXJzL2NvcmUudHNcIjtcblxuZnVuY3Rpb24gbWFrZUN0eChjdXN0b21SZXN1bHQ6IHVua25vd24pIHtcbiAgY29uc3Qgbm90aWNlczogQXJyYXk8eyBtZXNzYWdlOiBzdHJpbmc7IHR5cGU/OiBzdHJpbmcgfT4gPSBbXTtcbiAgcmV0dXJuIHtcbiAgICBoYXNVSTogdHJ1ZSxcbiAgICB1aToge1xuICAgICAgY3VzdG9tOiBhc3luYyAoKSA9PiBjdXN0b21SZXN1bHQsXG4gICAgICBub3RpZnk6IChtZXNzYWdlOiBzdHJpbmcsIHR5cGU/OiBzdHJpbmcpID0+IHtcbiAgICAgICAgbm90aWNlcy5wdXNoKHsgbWVzc2FnZSwgdHlwZSB9KTtcbiAgICAgIH0sXG4gICAgfSxcbiAgICBub3RpY2VzLFxuICB9O1xufVxuXG50ZXN0KFwidmlzdWFsaXplIG9ubHkgZmFsbHMgYmFjayB3aGVuIGN0eC51aS5jdXN0b20oKSBpcyB1bmF2YWlsYWJsZVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHN1Y2Nlc3NDdHggPSBtYWtlQ3R4KHRydWUpO1xuICBjb25zdCBzdWNjZXNzID0gYXdhaXQgaGFuZGxlQ29yZUNvbW1hbmQoXCJ2aXN1YWxpemVcIiwgc3VjY2Vzc0N0eCBhcyBhbnkpO1xuICBhc3NlcnQuZXF1YWwoc3VjY2VzcywgdHJ1ZSk7XG4gIGFzc2VydC5lcXVhbChzdWNjZXNzQ3R4Lm5vdGljZXMubGVuZ3RoLCAwLCBcInN1Y2Nlc3NmdWwgb3ZlcmxheSBjbG9zZSBkb2VzIG5vdCB0cmlnZ2VyIGZhbGxiYWNrXCIpO1xuXG4gIGNvbnN0IGZhbGxiYWNrQ3R4ID0gbWFrZUN0eCh1bmRlZmluZWQpO1xuICBjb25zdCBmYWxsYmFjayA9IGF3YWl0IGhhbmRsZUNvcmVDb21tYW5kKFwidmlzdWFsaXplXCIsIGZhbGxiYWNrQ3R4IGFzIGFueSk7XG4gIGFzc2VydC5lcXVhbChmYWxsYmFjaywgdHJ1ZSk7XG4gIGFzc2VydC5lcXVhbChmYWxsYmFja0N0eC5ub3RpY2VzLmxlbmd0aCwgMSwgXCJ1bmF2YWlsYWJsZSBvdmVybGF5IHRyaWdnZXJzIGZhbGxiYWNrIHdhcm5pbmdcIik7XG4gIGFzc2VydC5tYXRjaChmYWxsYmFja0N0eC5ub3RpY2VzWzBdIS5tZXNzYWdlLCAvaW50ZXJhY3RpdmUgdGVybWluYWwvaSk7XG59KTtcblxudGVzdChcInNob3ctY29uZmlnIG9ubHkgZmFsbHMgYmFjayB3aGVuIGN0eC51aS5jdXN0b20oKSBpcyB1bmF2YWlsYWJsZVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHN1Y2Nlc3NDdHggPSBtYWtlQ3R4KHRydWUpO1xuICBjb25zdCBzdWNjZXNzID0gYXdhaXQgaGFuZGxlQ29yZUNvbW1hbmQoXCJzaG93LWNvbmZpZ1wiLCBzdWNjZXNzQ3R4IGFzIGFueSk7XG4gIGFzc2VydC5lcXVhbChzdWNjZXNzLCB0cnVlKTtcbiAgYXNzZXJ0LmVxdWFsKHN1Y2Nlc3NDdHgubm90aWNlcy5sZW5ndGgsIDAsIFwic3VjY2Vzc2Z1bCBvdmVybGF5IGNsb3NlIGRvZXMgbm90IHRyaWdnZXIgZmFsbGJhY2tcIik7XG5cbiAgY29uc3QgZmFsbGJhY2tDdHggPSBtYWtlQ3R4KHVuZGVmaW5lZCk7XG4gIGNvbnN0IGZhbGxiYWNrID0gYXdhaXQgaGFuZGxlQ29yZUNvbW1hbmQoXCJzaG93LWNvbmZpZ1wiLCBmYWxsYmFja0N0eCBhcyBhbnkpO1xuICBhc3NlcnQuZXF1YWwoZmFsbGJhY2ssIHRydWUpO1xuICBhc3NlcnQuZXF1YWwoZmFsbGJhY2tDdHgubm90aWNlcy5sZW5ndGgsIDEsIFwidW5hdmFpbGFibGUgb3ZlcmxheSB0cmlnZ2VycyB0ZXh0IGZhbGxiYWNrXCIpO1xuICBhc3NlcnQubWF0Y2goZmFsbGJhY2tDdHgubm90aWNlc1swXSEubWVzc2FnZSwgL0dTRCBDb25maWd1cmF0aW9uLyk7XG59KTtcblxudGVzdChcIm1vZGVsIGNvbW1hbmQgcmVzb2x2ZXMgYW5kIHBlcnNpc3RzIGV4YWN0IHByb3ZpZGVyLXF1YWxpZmllZCBzZWxlY3Rpb25cIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBzZWxlY3RlZE1vZGVsID0geyBwcm92aWRlcjogXCJvcGVuYWlcIiwgaWQ6IFwiZ3B0LTUuNFwiIH07XG4gIGxldCBhcHBsaWVkOiB0eXBlb2Ygc2VsZWN0ZWRNb2RlbCB8IG51bGwgPSBudWxsO1xuICBjb25zdCBjdHggPSB7XG4gICAgaGFzVUk6IHRydWUsXG4gICAgbW9kZWw6IHsgcHJvdmlkZXI6IFwiYW50aHJvcGljXCIsIGlkOiBcImNsYXVkZS1zb25uZXQtNC02XCIgfSxcbiAgICBtb2RlbFJlZ2lzdHJ5OiB7XG4gICAgICBnZXRBdmFpbGFibGU6ICgpID0+IFtcbiAgICAgICAgeyBwcm92aWRlcjogXCJhbnRocm9waWNcIiwgaWQ6IFwiY2xhdWRlLXNvbm5ldC00LTZcIiB9LFxuICAgICAgICBzZWxlY3RlZE1vZGVsLFxuICAgICAgXSxcbiAgICB9LFxuICAgIHVpOiB7XG4gICAgICBub3RpZnk6IChtZXNzYWdlOiBzdHJpbmcsIHR5cGU/OiBzdHJpbmcpID0+IHtcbiAgICAgICAgbm90aWNlcy5wdXNoKHsgbWVzc2FnZSwgdHlwZSB9KTtcbiAgICAgIH0sXG4gICAgfSxcbiAgfSBhcyBhbnk7XG4gIGNvbnN0IG5vdGljZXM6IEFycmF5PHsgbWVzc2FnZTogc3RyaW5nOyB0eXBlPzogc3RyaW5nIH0+ID0gW107XG4gIGNvbnN0IHBpID0ge1xuICAgIHNldE1vZGVsOiBhc3luYyAobW9kZWw6IHR5cGVvZiBzZWxlY3RlZE1vZGVsKSA9PiB7XG4gICAgICBhcHBsaWVkID0gbW9kZWw7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9LFxuICB9IGFzIGFueTtcblxuICBjb25zdCBoYW5kbGVkID0gYXdhaXQgaGFuZGxlQ29yZUNvbW1hbmQoXCJtb2RlbCBvcGVuYWkvZ3B0LTUuNFwiLCBjdHgsIHBpKTtcbiAgYXNzZXJ0LmVxdWFsKGhhbmRsZWQsIHRydWUpO1xuICBhc3NlcnQuZGVlcEVxdWFsKGFwcGxpZWQsIHNlbGVjdGVkTW9kZWwpO1xuICBhc3NlcnQubWF0Y2gobm90aWNlc1swXSEubWVzc2FnZSwgL29wZW5haVxcL2dwdC01XFwuNC8pO1xufSk7XG5cbnRlc3QoXCJpbnRlcmFjdGl2ZSBtb2RlbCBwaWNrZXIgY2hvb3NlcyBwcm92aWRlciBmaXJzdCwgdGhlbiBtb2RlbFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHNlbGVjdGVkTW9kZWwgPSB7IHByb3ZpZGVyOiBcIm9wZW5haVwiLCBpZDogXCJncHQtNS40XCIgfTtcbiAgbGV0IGFwcGxpZWQ6IHR5cGVvZiBzZWxlY3RlZE1vZGVsIHwgbnVsbCA9IG51bGw7XG4gIGNvbnN0IHNlbGVjdHM6IEFycmF5PHsgdGl0bGU6IHN0cmluZzsgb3B0aW9uczogc3RyaW5nW10gfT4gPSBbXTtcbiAgY29uc3Qgbm90aWNlczogQXJyYXk8eyBtZXNzYWdlOiBzdHJpbmc7IHR5cGU/OiBzdHJpbmcgfT4gPSBbXTtcblxuICBjb25zdCBjdHggPSB7XG4gICAgaGFzVUk6IHRydWUsXG4gICAgbW9kZWw6IHsgcHJvdmlkZXI6IFwiYW50aHJvcGljXCIsIGlkOiBcImNsYXVkZS1zb25uZXQtNC02XCIgfSxcbiAgICBtb2RlbFJlZ2lzdHJ5OiB7XG4gICAgICBnZXRBdmFpbGFibGU6ICgpID0+IFtcbiAgICAgICAgeyBwcm92aWRlcjogXCJvcGVuYWlcIiwgaWQ6IFwiZ3B0LTUuNFwiIH0sXG4gICAgICAgIHsgcHJvdmlkZXI6IFwiYW50aHJvcGljXCIsIGlkOiBcImNsYXVkZS1vcHVzLTQtNlwiIH0sXG4gICAgICAgIHsgcHJvdmlkZXI6IFwib3BlbmFpXCIsIGlkOiBcImdwdC01LjMtbWluaVwiIH0sXG4gICAgICAgIHsgcHJvdmlkZXI6IFwiYW50aHJvcGljXCIsIGlkOiBcImNsYXVkZS1zb25uZXQtNC02XCIgfSxcbiAgICAgIF0sXG4gICAgfSxcbiAgICB1aToge1xuICAgICAgc2VsZWN0OiBhc3luYyAodGl0bGU6IHN0cmluZywgb3B0aW9uczogc3RyaW5nW10pID0+IHtcbiAgICAgICAgc2VsZWN0cy5wdXNoKHsgdGl0bGUsIG9wdGlvbnMgfSk7XG4gICAgICAgIHJldHVybiBzZWxlY3RzLmxlbmd0aCA9PT0gMSA/IFwib3BlbmFpICgyIG1vZGVscylcIiA6IFwiZ3B0LTUuNFwiO1xuICAgICAgfSxcbiAgICAgIG5vdGlmeTogKG1lc3NhZ2U6IHN0cmluZywgdHlwZT86IHN0cmluZykgPT4ge1xuICAgICAgICBub3RpY2VzLnB1c2goeyBtZXNzYWdlLCB0eXBlIH0pO1xuICAgICAgfSxcbiAgICB9LFxuICB9IGFzIGFueTtcblxuICBjb25zdCBwaSA9IHtcbiAgICBzZXRNb2RlbDogYXN5bmMgKG1vZGVsOiB0eXBlb2Ygc2VsZWN0ZWRNb2RlbCkgPT4ge1xuICAgICAgYXBwbGllZCA9IG1vZGVsO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfSxcbiAgfSBhcyBhbnk7XG5cbiAgY29uc3QgaGFuZGxlZCA9IGF3YWl0IGhhbmRsZUNvcmVDb21tYW5kKFwibW9kZWxcIiwgY3R4LCBwaSk7XG4gIGFzc2VydC5lcXVhbChoYW5kbGVkLCB0cnVlKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChzZWxlY3RzLCBbXG4gICAge1xuICAgICAgdGl0bGU6IFwiU2VsZWN0IHNlc3Npb24gbW9kZWw6IFx1MjAxNCBjaG9vc2UgcHJvdmlkZXI6XCIsXG4gICAgICBvcHRpb25zOiBbXCJhbnRocm9waWMgKDIgbW9kZWxzKVwiLCBcIm9wZW5haSAoMiBtb2RlbHMpXCIsIFwiKGNhbmNlbClcIl0sXG4gICAgfSxcbiAgICB7XG4gICAgICB0aXRsZTogXCJTZWxlY3Qgc2Vzc2lvbiBtb2RlbDogXHUyMDE0IG9wZW5haTpcIixcbiAgICAgIG9wdGlvbnM6IFtcImdwdC01LjMtbWluaVwiLCBcImdwdC01LjRcIiwgXCIoY2FuY2VsKVwiXSxcbiAgICB9LFxuICBdKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChhcHBsaWVkLCBzZWxlY3RlZE1vZGVsKTtcbiAgYXNzZXJ0Lm1hdGNoKG5vdGljZXNbMF0hLm1lc3NhZ2UsIC9vcGVuYWlcXC9ncHQtNVxcLjQvKTtcbn0pO1xuXG50ZXN0KFwiYW1iaWd1b3VzIHR5cGVkIG1vZGVsIHNlbGVjdGlvbiBjaG9vc2VzIHByb3ZpZGVyIGZpcnN0LCB0aGVuIG1vZGVsXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3Qgc2VsZWN0ZWRNb2RlbCA9IHsgcHJvdmlkZXI6IFwiZ2l0aHViLWNvcGlsb3RcIiwgaWQ6IFwiZ3B0LTVcIiB9O1xuICBsZXQgYXBwbGllZDogdHlwZW9mIHNlbGVjdGVkTW9kZWwgfCBudWxsID0gbnVsbDtcbiAgY29uc3Qgc2VsZWN0czogQXJyYXk8eyB0aXRsZTogc3RyaW5nOyBvcHRpb25zOiBzdHJpbmdbXSB9PiA9IFtdO1xuICBjb25zdCBub3RpY2VzOiBBcnJheTx7IG1lc3NhZ2U6IHN0cmluZzsgdHlwZT86IHN0cmluZyB9PiA9IFtdO1xuXG4gIGNvbnN0IGN0eCA9IHtcbiAgICBoYXNVSTogdHJ1ZSxcbiAgICBtb2RlbDogeyBwcm92aWRlcjogXCJhbnRocm9waWNcIiwgaWQ6IFwiY2xhdWRlLXNvbm5ldC00LTZcIiB9LFxuICAgIG1vZGVsUmVnaXN0cnk6IHtcbiAgICAgIGdldEF2YWlsYWJsZTogKCkgPT4gW1xuICAgICAgICB7IHByb3ZpZGVyOiBcIm9wZW5haVwiLCBpZDogXCJncHQtNVwiIH0sXG4gICAgICAgIHsgcHJvdmlkZXI6IFwiZ2l0aHViLWNvcGlsb3RcIiwgaWQ6IFwiZ3B0LTVcIiB9LFxuICAgICAgICB7IHByb3ZpZGVyOiBcIm9wZW5haVwiLCBpZDogXCJncHQtNS1taW5pXCIgfSxcbiAgICAgIF0sXG4gICAgfSxcbiAgICB1aToge1xuICAgICAgc2VsZWN0OiBhc3luYyAodGl0bGU6IHN0cmluZywgb3B0aW9uczogc3RyaW5nW10pID0+IHtcbiAgICAgICAgc2VsZWN0cy5wdXNoKHsgdGl0bGUsIG9wdGlvbnMgfSk7XG4gICAgICAgIHJldHVybiBzZWxlY3RzLmxlbmd0aCA9PT0gMSA/IFwiZ2l0aHViLWNvcGlsb3QgKDEgbW9kZWwpXCIgOiBcImdwdC01XCI7XG4gICAgICB9LFxuICAgICAgbm90aWZ5OiAobWVzc2FnZTogc3RyaW5nLCB0eXBlPzogc3RyaW5nKSA9PiB7XG4gICAgICAgIG5vdGljZXMucHVzaCh7IG1lc3NhZ2UsIHR5cGUgfSk7XG4gICAgICB9LFxuICAgIH0sXG4gIH0gYXMgYW55O1xuXG4gIGNvbnN0IHBpID0ge1xuICAgIHNldE1vZGVsOiBhc3luYyAobW9kZWw6IHR5cGVvZiBzZWxlY3RlZE1vZGVsKSA9PiB7XG4gICAgICBhcHBsaWVkID0gbW9kZWw7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9LFxuICB9IGFzIGFueTtcblxuICBjb25zdCBoYW5kbGVkID0gYXdhaXQgaGFuZGxlQ29yZUNvbW1hbmQoXCJtb2RlbCBncHRcIiwgY3R4LCBwaSk7XG4gIGFzc2VydC5lcXVhbChoYW5kbGVkLCB0cnVlKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChzZWxlY3RzLCBbXG4gICAge1xuICAgICAgdGl0bGU6IFwiTXVsdGlwbGUgbW9kZWxzIG1hdGNoIFxcXCJncHRcXFwiIFx1MjAxNCBjaG9vc2UgcHJvdmlkZXI6XCIsXG4gICAgICBvcHRpb25zOiBbXCJnaXRodWItY29waWxvdCAoMSBtb2RlbClcIiwgXCJvcGVuYWkgKDIgbW9kZWxzKVwiLCBcIihjYW5jZWwpXCJdLFxuICAgIH0sXG4gICAge1xuICAgICAgdGl0bGU6IFwiTXVsdGlwbGUgbW9kZWxzIG1hdGNoIFxcXCJncHRcXFwiIFx1MjAxNCBnaXRodWItY29waWxvdDpcIixcbiAgICAgIG9wdGlvbnM6IFtcImdwdC01XCIsIFwiKGNhbmNlbClcIl0sXG4gICAgfSxcbiAgXSk7XG4gIGFzc2VydC5kZWVwRXF1YWwoYXBwbGllZCwgc2VsZWN0ZWRNb2RlbCk7XG4gIGFzc2VydC5tYXRjaChub3RpY2VzWzBdIS5tZXNzYWdlLCAvZ2l0aHViLWNvcGlsb3RcXC9ncHQtNS8pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBRW5CLFNBQVMseUJBQXlCO0FBRWxDLFNBQVMsUUFBUSxjQUF1QjtBQUN0QyxRQUFNLFVBQXFELENBQUM7QUFDNUQsU0FBTztBQUFBLElBQ0wsT0FBTztBQUFBLElBQ1AsSUFBSTtBQUFBLE1BQ0YsUUFBUSxZQUFZO0FBQUEsTUFDcEIsUUFBUSxDQUFDLFNBQWlCLFNBQWtCO0FBQzFDLGdCQUFRLEtBQUssRUFBRSxTQUFTLEtBQUssQ0FBQztBQUFBLE1BQ2hDO0FBQUEsSUFDRjtBQUFBLElBQ0E7QUFBQSxFQUNGO0FBQ0Y7QUFFQSxLQUFLLGlFQUFpRSxZQUFZO0FBQ2hGLFFBQU0sYUFBYSxRQUFRLElBQUk7QUFDL0IsUUFBTSxVQUFVLE1BQU0sa0JBQWtCLGFBQWEsVUFBaUI7QUFDdEUsU0FBTyxNQUFNLFNBQVMsSUFBSTtBQUMxQixTQUFPLE1BQU0sV0FBVyxRQUFRLFFBQVEsR0FBRyxvREFBb0Q7QUFFL0YsUUFBTSxjQUFjLFFBQVEsTUFBUztBQUNyQyxRQUFNLFdBQVcsTUFBTSxrQkFBa0IsYUFBYSxXQUFrQjtBQUN4RSxTQUFPLE1BQU0sVUFBVSxJQUFJO0FBQzNCLFNBQU8sTUFBTSxZQUFZLFFBQVEsUUFBUSxHQUFHLCtDQUErQztBQUMzRixTQUFPLE1BQU0sWUFBWSxRQUFRLENBQUMsRUFBRyxTQUFTLHVCQUF1QjtBQUN2RSxDQUFDO0FBRUQsS0FBSyxtRUFBbUUsWUFBWTtBQUNsRixRQUFNLGFBQWEsUUFBUSxJQUFJO0FBQy9CLFFBQU0sVUFBVSxN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
