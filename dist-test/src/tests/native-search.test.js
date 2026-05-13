import test from "node:test";
import assert from "node:assert/strict";
import {
  registerNativeSearchHooks,
  stripThinkingFromHistory,
  BRAVE_TOOL_NAMES,
  CUSTOM_SEARCH_TOOL_NAMES,
  MAX_NATIVE_SEARCHES_PER_SESSION
} from "../resources/extensions/search-the-web/native-search.js";
function createMockPI() {
  const handlers = [];
  let activeTools = ["search-the-web", "search_and_read", "google_search", "fetch_page", "bash", "read"];
  const notifications = [];
  const mockCtx = {
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      }
    }
  };
  const pi = {
    handlers,
    notifications,
    mockCtx,
    on(event, handler) {
      handlers.push({ event, handler });
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(tools) {
      activeTools = tools;
    },
    async fire(event, eventData, ctx) {
      let lastResult;
      for (const h of handlers) {
        if (h.event === event) {
          const result = await h.handler(eventData, ctx ?? mockCtx);
          if (result !== void 0) lastResult = result;
        }
      }
      return lastResult;
    }
  };
  return pi;
}
test("before_provider_request injects web_search for claude models", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);
  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic", api: "anthropic-messages", name: "claude-sonnet-4-6" },
    previousModel: void 0,
    source: "set"
  });
  const payload = {
    model: "claude-sonnet-4-6-20250514",
    tools: [{ name: "bash", type: "custom" }]
  };
  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload
  });
  const tools = result?.tools ?? payload.tools;
  const nativeTool = tools.find(
    (t) => t.type === "web_search_20250305"
  );
  assert.ok(nativeTool, "Should inject web_search_20250305 tool");
  assert.equal(tools.length, 2, "Should have original + injected tool");
  assert.equal(nativeTool.max_uses, 5, "Should set max_uses to 5 to prevent search loops (#817)");
});
test("before_provider_request injects web_search for claude models even without model_select", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);
  const payload = {
    model: "claude-opus-4-6",
    tools: [
      { name: "bash", type: "custom" },
      { name: "search-the-web", type: "function" },
      { name: "google_search", type: "function" }
    ]
  };
  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload
  });
  const tools = result?.tools ?? payload.tools;
  const names = tools.map((t) => t.name ?? t.type);
  assert.ok(names.includes("web_search"), "Should inject native web_search based on model name");
  assert.ok(!names.includes("search-the-web"), "Should remove search-the-web");
  assert.ok(!names.includes("google_search"), "Should remove google_search");
  assert.ok(names.includes("bash"), "Should keep non-search tools");
});
test("before_provider_request does NOT inject for non-claude models", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);
  const payload = {
    model: "gpt-4o",
    tools: [{ name: "bash", type: "custom" }]
  };
  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload
  });
  assert.equal(result, void 0, "Should not modify non-claude payload");
  const tools = payload.tools;
  assert.equal(tools.length, 1, "Should not add tools to non-claude payload");
});
test("before_provider_request does NOT inject for claude model on non-Anthropic provider", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);
  await pi.fire("model_select", {
    type: "model_select",
    model: {
      provider: "github-copilot",
      api: "anthropic-messages",
      name: "claude-sonnet-4-6"
    },
    previousModel: void 0,
    source: "set"
  });
  const payload = {
    model: "claude-sonnet-4-6-20250514",
    tools: [{ name: "bash", type: "custom" }]
  };
  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload
  });
  assert.equal(result, void 0, "Should not modify payload for non-Anthropic provider");
  const tools = payload.tools;
  assert.equal(tools.length, 1, "Should not inject web_search for non-Anthropic provider");
  assert.ok(
    !tools.some((t) => t.type === "web_search_20250305"),
    "web_search_20250305 must NOT be present for non-Anthropic providers"
  );
});
test("before_provider_request does NOT inject when event.model indicates non-Anthropic provider (no model_select)", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);
  const payload = {
    model: "claude-sonnet-4-6-20250514",
    tools: [{ name: "bash", type: "custom" }]
  };
  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload,
    // Copilot-served claude carries api: "anthropic-messages" at runtime —
    // include it so the test actually exercises the #4492 code path.
    model: {
      provider: "github-copilot",
      api: "anthropic-messages",
      id: "claude-sonnet-4-6"
    }
  });
  assert.equal(result, void 0, "Should not modify payload when event.model says non-Anthropic");
  const tools = payload.tools;
  assert.equal(tools.length, 1, "Should not inject web_search for Copilot provider");
  assert.ok(
    !tools.some((t) => t.type === "web_search_20250305"),
    "web_search_20250305 must NOT be present for Copilot"
  );
});
test("before_provider_request does NOT inject for github-copilot + claude-haiku-4.5 (#4492 regression)", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);
  await pi.fire("model_select", {
    type: "model_select",
    model: {
      provider: "github-copilot",
      api: "anthropic-messages",
      name: "claude-haiku-4.5"
    },
    previousModel: void 0,
    source: "set"
  });
  const payload = {
    model: "claude-haiku-4.5",
    tools: [{ name: "bash", type: "custom" }]
  };
  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload,
    model: {
      provider: "github-copilot",
      api: "anthropic-messages",
      id: "claude-haiku-4.5"
    }
  });
  assert.equal(result, void 0, "Should not modify payload for github-copilot + claude-haiku-4.5");
  const tools = payload.tools;
  assert.ok(
    !tools.some((t) => t.type === "web_search_20250305"),
    "web_search_20250305 must NOT be injected for github-copilot \u2014 endpoint rejects it"
  );
});
test("before_provider_request does NOT inject for minimax (anthropic-shaped, no native search)", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);
  const payload = {
    model: "MiniMax-M2.5",
    tools: [{ name: "bash", type: "custom" }]
  };
  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload,
    model: { provider: "minimax", api: "anthropic-messages", id: "MiniMax-M2.5" }
  });
  assert.equal(result, void 0, "Should not modify payload for minimax");
  const tools = payload.tools;
  assert.ok(
    !tools.some((t) => t.type === "web_search_20250305"),
    "web_search_20250305 must NOT be injected for minimax"
  );
});
test("before_provider_request DOES inject when event.model indicates Anthropic provider (no model_select)", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);
  const payload = {
    model: "claude-sonnet-4-6-20250514",
    tools: [{ name: "bash", type: "custom" }]
  };
  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload,
    model: { provider: "anthropic", id: "claude-sonnet-4-6", api: "anthropic-messages" }
  });
  const tools = result?.tools ?? payload.tools;
  assert.ok(
    tools.some((t) => t.type === "web_search_20250305"),
    "Should inject web_search when event.model confirms Anthropic"
  );
});
test("before_provider_request does not double-inject", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);
  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic", api: "anthropic-messages", name: "claude-opus-4-6" },
    previousModel: void 0,
    source: "set"
  });
  const payload = {
    model: "claude-opus-4-6-20250514",
    tools: [{ type: "web_search_20250305", name: "web_search" }]
  };
  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload
  });
  assert.equal(result, void 0, "Should not modify when already injected");
  const tools = payload.tools;
  assert.equal(tools.length, 1, "Should not duplicate web_search tool");
});
test("before_provider_request creates tools array if missing", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);
  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic", api: "anthropic-messages", name: "claude-haiku-4-5" },
    previousModel: void 0,
    source: "set"
  });
  const payload = {
    model: "claude-haiku-4-5-20251001"
  };
  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload
  });
  const tools = result?.tools ?? payload.tools;
  assert.ok(Array.isArray(tools), "Should create tools array");
  assert.equal(tools.length, 1, "Should have exactly 1 tool");
  assert.equal(tools[0].type, "web_search_20250305");
  assert.equal(tools[0].max_uses, 5, "Should include max_uses limit");
});
test("before_provider_request skips when payload is falsy", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);
  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload: null
  });
  assert.equal(result, void 0, "Should return undefined for null payload");
});
test("model_select disables Brave tools when Anthropic + no BRAVE_API_KEY", async (t) => {
  const originalKey = process.env.BRAVE_API_KEY;
  delete process.env.BRAVE_API_KEY;
  t.after(() => {
    if (originalKey) process.env.BRAVE_API_KEY = originalKey;
    else delete process.env.BRAVE_API_KEY;
  });
  const pi = createMockPI();
  registerNativeSearchHooks(pi);
  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic", api: "anthropic-messages", name: "claude-sonnet-4-6" },
    previousModel: void 0,
    source: "set"
  });
  const active = pi.getActiveTools();
  assert.ok(!active.includes("search-the-web"), "search-the-web should be disabled");
  assert.ok(!active.includes("search_and_read"), "search_and_read should be disabled");
  assert.ok(!active.includes("google_search"), "google_search should be disabled");
  assert.ok(active.includes("fetch_page"), "fetch_page should remain active");
  assert.ok(active.includes("bash"), "Other tools should remain active");
});
test("model_select disables all custom search tools when Anthropic even with BRAVE_API_KEY", async (t) => {
  const originalKey = process.env.BRAVE_API_KEY;
  process.env.BRAVE_API_KEY = "test-key";
  t.after(() => {
    if (originalKey) process.env.BRAVE_API_KEY = originalKey;
    else delete process.env.BRAVE_API_KEY;
  });
  const pi = createMockPI();
  registerNativeSearchHooks(pi);
  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic", api: "anthropic-messages", name: "claude-sonnet-4-6" },
    previousModel: void 0,
    source: "set"
  });
  const active = pi.getActiveTools();
  assert.ok(!active.includes("search-the-web"), "search-the-web should be disabled for Anthropic");
  assert.ok(!active.includes("search_and_read"), "search_and_read should be disabled for Anthropic");
  assert.ok(!active.includes("google_search"), "google_search should be disabled for Anthropic");
  assert.ok(active.includes("fetch_page"), "fetch_page should remain active");
});
test("model_select re-enables Brave tools when switching away from Anthropic", async (t) => {
  const originalKey = process.env.BRAVE_API_KEY;
  delete process.env.BRAVE_API_KEY;
  t.after(() => {
    if (originalKey) process.env.BRAVE_API_KEY = originalKey;
    else delete process.env.BRAVE_API_KEY;
  });
  const pi = createMockPI();
  registerNativeSearchHooks(pi);
  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic", api: "anthropic-messages", name: "claude-sonnet-4-6" },
    previousModel: void 0,
    source: "set"
  });
  let active = pi.getActiveTools();
  assert.ok(!active.includes("search-the-web"), "Should disable after Anthropic select");
  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "openai", name: "gpt-4o" },
    previousModel: { provider: "anthropic", name: "claude-sonnet-4-6" },
    source: "set"
  });
  active = pi.getActiveTools();
  assert.ok(active.includes("search-the-web"), "search-the-web should be re-enabled");
  assert.ok(active.includes("search_and_read"), "search_and_read should be re-enabled");
  assert.ok(active.includes("google_search"), "google_search should be re-enabled");
});
test("model_select shows 'Native Anthropic web search active' for Anthropic provider", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);
  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic", api: "anthropic-messages", name: "claude-sonnet-4-6" },
    previousModel: void 0,
    source: "set"
  });
  const infoNotif = pi.notifications.find(
    (n) => n.level === "info" && n.message.includes("Native")
  );
  assert.ok(infoNotif, "Should notify about native search on Anthropic model_select");
  assert.ok(
    infoNotif.message.includes("Native Anthropic web search active"),
    `Should say 'Native Anthropic web search active' \u2014 got: ${infoNotif.message}`
  );
});
test("model_select shows warning for non-Anthropic without Brave key", async (t) => {
  const originalKey = process.env.BRAVE_API_KEY;
  delete process.env.BRAVE_API_KEY;
  t.after(() => {
    if (originalKey) process.env.BRAVE_API_KEY = originalKey;
    else delete process.env.BRAVE_API_KEY;
  });
  const pi = createMockPI();
  registerNativeSearchHooks(pi);
  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "openai", name: "gpt-4o" },
    previousModel: void 0,
    source: "set"
  });
  const warning = pi.notifications.find((n) => n.level === "warning");
  assert.ok(warning, "Should show warning for non-Anthropic without Brave key");
  assert.ok(
    warning.message.includes("Anthropic"),
    `Warning should mention Anthropic \u2014 got: ${warning.message}`
  );
});
test("session_start resets search count and shows no startup notification", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);
  await pi.fire("session_start", { type: "session_start" });
  const infoNotif = pi.notifications.find(
    (n) => n.level === "info" && n.message.includes("v4")
  );
  assert.equal(infoNotif, void 0, "Should NOT emit a v4 startup notification (welcome screen handles this)");
});
test("BRAVE_TOOL_NAMES contains expected tool names", () => {
  assert.deepEqual(BRAVE_TOOL_NAMES, ["search-the-web", "search_and_read"]);
});
test("CUSTOM_SEARCH_TOOL_NAMES contains all custom search tools", () => {
  assert.deepEqual(CUSTOM_SEARCH_TOOL_NAMES, ["search-the-web", "search_and_read", "google_search"]);
});
test("before_provider_request removes Brave tools from payload when no BRAVE_API_KEY", async (t) => {
  const originalKey = process.env.BRAVE_API_KEY;
  delete process.env.BRAVE_API_KEY;
  t.after(() => {
    if (originalKey) process.env.BRAVE_API_KEY = originalKey;
    else delete process.env.BRAVE_API_KEY;
  });
  const pi = createMockPI();
  registerNativeSearchHooks(pi);
  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic", api: "anthropic-messages", name: "claude-sonnet-4-6" },
    previousModel: void 0,
    source: "set"
  });
  const payload = {
    model: "claude-sonnet-4-6-20250514",
    tools: [
      { name: "bash", type: "function" },
      { name: "search-the-web", type: "function" },
      { name: "search_and_read", type: "function" },
      { name: "google_search", type: "function" },
      { name: "fetch_page", type: "function" }
    ]
  };
  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload
  });
  const tools = result?.tools ?? payload.tools;
  const names = tools.map((t2) => t2.name);
  assert.ok(!names.includes("search-the-web"), "search-the-web should be removed from payload");
  assert.ok(!names.includes("search_and_read"), "search_and_read should be removed from payload");
  assert.ok(!names.includes("google_search"), "google_search should be removed from payload");
  assert.ok(names.includes("bash"), "bash should remain");
  assert.ok(names.includes("fetch_page"), "fetch_page should remain");
  assert.ok(names.includes("web_search"), "native web_search should be injected");
});
test("before_provider_request removes all custom search tools from payload even with BRAVE_API_KEY", async (t) => {
  const originalKey = process.env.BRAVE_API_KEY;
  process.env.BRAVE_API_KEY = "test-key";
  t.after(() => {
    if (originalKey) process.env.BRAVE_API_KEY = originalKey;
    else delete process.env.BRAVE_API_KEY;
  });
  const pi = createMockPI();
  registerNativeSearchHooks(pi);
  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic", api: "anthropic-messages", name: "claude-sonnet-4-6" },
    previousModel: void 0,
    source: "set"
  });
  const payload = {
    model: "claude-sonnet-4-6-20250514",
    tools: [
      { name: "search-the-web", type: "function" },
      { name: "search_and_read", type: "function" },
      { name: "google_search", type: "function" },
      { name: "fetch_page", type: "function" }
    ]
  };
  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload
  });
  const tools = result?.tools ?? payload.tools;
  const names = tools.map((t2) => t2.name);
  assert.ok(!names.includes("search-the-web"), "search-the-web should be removed for Anthropic");
  assert.ok(!names.includes("search_and_read"), "search_and_read should be removed for Anthropic");
  assert.ok(!names.includes("google_search"), "google_search should be removed for Anthropic");
  assert.ok(names.includes("fetch_page"), "fetch_page should remain");
  assert.ok(names.includes("web_search"), "native web_search should be injected");
});
test("model_select re-enable does not duplicate Brave tools across toggle cycles", async (t) => {
  const originalKey = process.env.BRAVE_API_KEY;
  delete process.env.BRAVE_API_KEY;
  t.after(() => {
    if (originalKey) process.env.BRAVE_API_KEY = originalKey;
    else delete process.env.BRAVE_API_KEY;
  });
  const pi = createMockPI();
  registerNativeSearchHooks(pi);
  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic", api: "anthropic-messages", name: "claude-sonnet-4-6" },
    previousModel: void 0,
    source: "set"
  });
  assert.ok(!pi.getActiveTools().includes("search-the-web"), "Disabled after 1st Anthropic select");
  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "openai", name: "gpt-4o" },
    previousModel: { provider: "anthropic", name: "claude-sonnet-4-6" },
    source: "set"
  });
  let active = pi.getActiveTools();
  assert.equal(
    active.filter((t2) => t2 === "search-the-web").length,
    1,
    "search-the-web exactly once after first re-enable"
  );
  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic", api: "anthropic-messages", name: "claude-sonnet-4-6" },
    previousModel: { provider: "openai", name: "gpt-4o" },
    source: "set"
  });
  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "openai", name: "gpt-4o" },
    previousModel: { provider: "anthropic", name: "claude-sonnet-4-6" },
    source: "set"
  });
  active = pi.getActiveTools();
  assert.equal(
    active.filter((t2) => t2 === "search-the-web").length,
    1,
    "search-the-web exactly once after second re-enable (no duplicates)"
  );
  assert.equal(
    active.filter((t2) => t2 === "search_and_read").length,
    1,
    "search_and_read exactly once (no duplicates)"
  );
  assert.equal(
    active.filter((t2) => t2 === "google_search").length,
    1,
    "google_search exactly once (no duplicates)"
  );
});
test("mock fire() calls all handlers for the same event", async () => {
  const pi = createMockPI();
  const callOrder = [];
  pi.on("test_event", async () => {
    callOrder.push(1);
    return "first";
  });
  pi.on("test_event", async () => {
    callOrder.push(2);
    return "second";
  });
  const result = await pi.fire("test_event", {});
  assert.deepEqual(callOrder, [1, 2], "Both handlers should be called");
  assert.equal(result, "second", "Should return last non-undefined result");
});
test("model_select suppresses 'Native search active' notification on session restore", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);
  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic", api: "anthropic-messages", name: "claude-sonnet-4-6" },
    previousModel: void 0,
    source: "restore"
    // session restore, not user action
  });
  const nativeNotif = pi.notifications.find(
    (n) => n.message.includes("Native Anthropic web search active")
  );
  assert.equal(
    nativeNotif,
    void 0,
    "Should NOT show 'Native search active' on session restore"
  );
});
test("model_select DOES show notification on explicit user set", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);
  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic", api: "anthropic-messages", name: "claude-sonnet-4-6" },
    previousModel: void 0,
    source: "set"
  });
  const nativeNotif = pi.notifications.find(
    (n) => n.message.includes("Native Anthropic web search active")
  );
  assert.ok(nativeNotif, "Should show notification on explicit 'set' source");
});
test("session search budget: max_uses decreases as history accumulates search results", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);
  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic", api: "anthropic-messages", name: "claude-sonnet-4-6" },
    previousModel: void 0,
    source: "set"
  });
  const messages = [
    { role: "user", content: "research this topic" },
    {
      role: "assistant",
      content: [
        { type: "web_search_tool_result", tool_use_id: "ws1", content: [] },
        { type: "web_search_tool_result", tool_use_id: "ws2", content: [] },
        { type: "web_search_tool_result", tool_use_id: "ws3", content: [] },
        { type: "web_search_tool_result", tool_use_id: "ws4", content: [] },
        { type: "web_search_tool_result", tool_use_id: "ws5", content: [] },
        { type: "text", text: "Here are some results..." }
      ]
    },
    { role: "user", content: "continue" },
    {
      role: "assistant",
      content: [
        { type: "web_search_tool_result", tool_use_id: "ws6", content: [] },
        { type: "web_search_tool_result", tool_use_id: "ws7", content: [] },
        { type: "web_search_tool_result", tool_use_id: "ws8", content: [] },
        { type: "web_search_tool_result", tool_use_id: "ws9", content: [] },
        { type: "web_search_tool_result", tool_use_id: "ws10", content: [] },
        { type: "text", text: "More results..." }
      ]
    },
    { role: "user", content: "keep going" }
  ];
  const payload = {
    model: "claude-sonnet-4-6-20250514",
    tools: [{ name: "bash", type: "custom" }],
    messages
  };
  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload
  });
  const tools = result?.tools ?? payload.tools;
  const nativeTool = tools.find((t) => t.type === "web_search_20250305");
  assert.ok(nativeTool, "Should still inject web_search when budget remaining");
  assert.equal(nativeTool.max_uses, 5, "Should cap at min(5, remaining)");
});
test("session search budget: reduces max_uses when close to limit", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);
  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic", api: "anthropic-messages", name: "claude-sonnet-4-6" },
    previousModel: void 0,
    source: "set"
  });
  const searchBlocks = Array.from({ length: 13 }, (_, i) => ({
    type: "web_search_tool_result",
    tool_use_id: `ws${i}`,
    content: []
  }));
  const messages = [
    { role: "user", content: "research" },
    { role: "assistant", content: [...searchBlocks, { type: "text", text: "results" }] },
    { role: "user", content: "more" }
  ];
  const payload = {
    model: "claude-sonnet-4-6-20250514",
    tools: [{ name: "bash", type: "custom" }],
    messages
  };
  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload
  });
  const tools = result?.tools ?? payload.tools;
  const nativeTool = tools.find((t) => t.type === "web_search_20250305");
  assert.ok(nativeTool, "Should still inject when budget > 0");
  assert.equal(nativeTool.max_uses, 2, "Should reduce max_uses to remaining budget");
});
test("session search budget: omits web_search tool when budget exhausted", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);
  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic", api: "anthropic-messages", name: "claude-sonnet-4-6" },
    previousModel: void 0,
    source: "set"
  });
  const searchBlocks = Array.from({ length: MAX_NATIVE_SEARCHES_PER_SESSION }, (_, i) => ({
    type: "web_search_tool_result",
    tool_use_id: `ws${i}`,
    content: []
  }));
  const messages = [
    { role: "user", content: "research" },
    { role: "assistant", content: [...searchBlocks, { type: "text", text: "results" }] },
    { role: "user", content: "more" }
  ];
  const payload = {
    model: "claude-sonnet-4-6-20250514",
    tools: [{ name: "bash", type: "custom" }],
    messages
  };
  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload
  });
  const tools = result?.tools ?? payload.tools;
  const nativeTool = tools.find((t) => t.type === "web_search_20250305");
  assert.equal(nativeTool, void 0, "Should NOT inject web_search when budget exhausted (#1309)");
  assert.ok(tools.some((t) => t.name === "bash"), "Non-search tools should remain");
});
test("session search budget: resets on session_start", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);
  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic", api: "anthropic-messages", name: "claude-sonnet-4-6" },
    previousModel: void 0,
    source: "set"
  });
  const searchBlocks = Array.from({ length: MAX_NATIVE_SEARCHES_PER_SESSION }, (_, i) => ({
    type: "web_search_tool_result",
    tool_use_id: `ws${i}`,
    content: []
  }));
  let payload = {
    model: "claude-sonnet-4-6-20250514",
    tools: [{ name: "bash", type: "custom" }],
    messages: [
      { role: "user", content: "research" },
      { role: "assistant", content: [...searchBlocks] },
      { role: "user", content: "more" }
    ]
  };
  await pi.fire("before_provider_request", { type: "before_provider_request", payload });
  let tools = payload.tools;
  assert.ok(!tools.some((t) => t.type === "web_search_20250305"), "Budget should be exhausted");
  await pi.fire("session_start", { type: "session_start" });
  payload = {
    model: "claude-sonnet-4-6-20250514",
    tools: [{ name: "bash", type: "custom" }],
    messages: [{ role: "user", content: "new research" }]
  };
  const result = await pi.fire("before_provider_request", { type: "before_provider_request", payload });
  tools = result?.tools ?? payload.tools;
  const nativeTool = tools.find((t) => t.type === "web_search_20250305");
  assert.ok(nativeTool, "Should inject web_search after session reset");
  assert.equal(nativeTool.max_uses, 5, "Should have full per-turn budget after reset");
});
test("MAX_NATIVE_SEARCHES_PER_SESSION is exported and equals 15", () => {
  assert.equal(MAX_NATIVE_SEARCHES_PER_SESSION, 15, "Session budget should be 15 (#1309)");
});
test("session search budget: survives context compaction (high-water mark)", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);
  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic", api: "anthropic-messages", name: "claude-sonnet-4-6" },
    previousModel: void 0,
    source: "set"
  });
  const searchBlocks = Array.from({ length: 12 }, (_, i) => ({
    type: "web_search_tool_result",
    tool_use_id: `ws${i}`,
    content: []
  }));
  let payload = {
    model: "claude-sonnet-4-6-20250514",
    tools: [{ name: "bash", type: "custom" }],
    messages: [{ role: "user", content: [{ type: "text", text: "search" }, ...searchBlocks] }]
  };
  await pi.fire("before_provider_request", { type: "before_provider_request", payload });
  let tools = payload.tools;
  let nativeTool = tools.find((t) => t.type === "web_search_20250305");
  assert.ok(nativeTool, "Should still inject web_search with 12/15 used");
  assert.equal(nativeTool.max_uses, 3, "Should have 3 remaining (15 - 12)");
  payload = {
    model: "claude-sonnet-4-6-20250514",
    tools: [{ name: "bash", type: "custom" }],
    messages: [{ role: "user", content: "compacted context \u2014 no search blocks" }]
  };
  await pi.fire("before_provider_request", { type: "before_provider_request", payload });
  tools = payload.tools;
  nativeTool = tools.find((t) => t.type === "web_search_20250305");
  assert.ok(nativeTool, "Should still inject web_search with 12/15 used (high-water mark)");
  assert.equal(nativeTool.max_uses, 3, "High-water mark should preserve 12 \u2014 only 3 remaining");
});
test("stripThinkingFromHistory removes thinking from earlier assistant messages", () => {
  const messages = [
    { role: "user", content: "hello" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm", signature: "sig1" },
        { type: "text", text: "Hi there" }
      ]
    },
    { role: "user", content: "search something" }
  ];
  stripThinkingFromHistory(messages);
  assert.equal(messages[1].content.length, 1);
  assert.equal(messages[1].content[0].type, "text");
});
test("stripThinkingFromHistory strips thinking from all assistant messages", () => {
  const messages = [
    { role: "user", content: "hello" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "first thought", signature: "sig1" },
        { type: "text", text: "response 1" }
      ]
    },
    { role: "user", content: "follow up" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "second thought", signature: "sig2" },
        { type: "text", text: "response 2" }
      ]
    },
    { role: "user", content: "another question" }
  ];
  stripThinkingFromHistory(messages);
  assert.equal(messages[1].content.length, 1);
  assert.equal(messages[1].content[0].type, "text");
  assert.equal(messages[3].content.length, 1);
  assert.equal(messages[3].content[0].type, "text");
});
test("stripThinkingFromHistory removes redacted_thinking too", () => {
  const messages = [
    { role: "user", content: "hello" },
    {
      role: "assistant",
      content: [
        { type: "redacted_thinking", data: "opaque" },
        { type: "text", text: "response" }
      ]
    },
    { role: "user", content: "next" }
  ];
  stripThinkingFromHistory(messages);
  assert.equal(messages[1].content.length, 1);
  assert.equal(messages[1].content[0].type, "text");
});
test("stripThinkingFromHistory strips even single assistant message", () => {
  const messages = [
    { role: "user", content: "hello" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "thought", signature: "sig" },
        { type: "text", text: "response" }
      ]
    },
    { role: "user", content: "follow up" }
  ];
  stripThinkingFromHistory(messages);
  assert.equal(messages[1].content.length, 1);
  assert.equal(messages[1].content[0].type, "text");
});
test("stripThinkingFromHistory handles no assistant messages", () => {
  const messages = [
    { role: "user", content: "hello" }
  ];
  stripThinkingFromHistory(messages);
  assert.equal(messages.length, 1);
});
test("stripThinkingFromHistory handles string content (no array)", () => {
  const messages = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "just a string" },
    { role: "user", content: "next" }
  ];
  stripThinkingFromHistory(messages);
  assert.equal(messages[1].content, "just a string");
});
test("#4478 claude-code session restore with model_select suppressed still injects native search", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);
  const payload = {
    model: "claude-sonnet-4-6",
    tools: [{ name: "bash", type: "custom" }]
  };
  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload,
    // Full Model object carrying `api` — matches what the runner forwards at runtime.
    model: { provider: "claude-code", id: "claude-sonnet-4-6", api: "anthropic-messages" }
  });
  const tools = result?.tools ?? payload.tools;
  assert.ok(
    tools.some((t) => t.type === "web_search_20250305"),
    "Should inject native web_search on claude-code restore even with model_select suppressed"
  );
});
test("#4478 claude-code OAuth provider injects native web_search", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);
  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "claude-code", api: "anthropic-messages", name: "claude-sonnet-4-6" },
    previousModel: void 0,
    source: "set"
  });
  const warning = pi.notifications.find((n) => n.level === "warning");
  assert.equal(warning, void 0, "Should not emit Brave warning for claude-code provider");
  assert.ok(!pi.getActiveTools().includes("search-the-web"), "Brave tools disabled on claude-code");
  const payload = {
    model: "claude-sonnet-4-6-20250514",
    tools: [{ name: "bash", type: "custom" }]
  };
  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload,
    model: { provider: "claude-code", id: "claude-sonnet-4-6", api: "anthropic-messages" }
  });
  const tools = result?.tools ?? payload.tools;
  assert.ok(
    tools.some((t) => t.type === "web_search_20250305"),
    "Should inject native web_search for claude-code"
  );
});
test("#4478 anthropic-vertex provider injects native web_search", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);
  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "anthropic-vertex", api: "anthropic-vertex", name: "claude-sonnet-4-6" },
    previousModel: void 0,
    source: "set"
  });
  const payload = {
    model: "claude-sonnet-4-6",
    tools: [{ name: "bash", type: "custom" }]
  };
  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload,
    model: { provider: "anthropic-vertex", id: "claude-sonnet-4-6", api: "anthropic-vertex" }
  });
  const tools = result?.tools ?? payload.tools;
  assert.ok(
    tools.some((t) => t.type === "web_search_20250305"),
    "Should inject native web_search for anthropic-vertex"
  );
});
test("#4478 vercel-ai-gateway with anthropic-messages api injects native web_search", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);
  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "vercel-ai-gateway", api: "anthropic-messages", name: "anthropic/claude-sonnet-4-6" },
    previousModel: void 0,
    source: "set"
  });
  const payload = {
    model: "anthropic/claude-sonnet-4-6",
    tools: [{ name: "bash", type: "custom" }]
  };
  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload,
    model: { provider: "vercel-ai-gateway", id: "anthropic/claude-sonnet-4-6", api: "anthropic-messages" }
  });
  const tools = result?.tools ?? payload.tools;
  assert.ok(
    tools.some((t) => t.type === "web_search_20250305"),
    "Vercel-gateway Anthropic route should inject native web_search (same wire protocol)"
  );
});
test("#4478 amazon-bedrock provider does NOT inject (different tool schema)", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);
  await pi.fire("model_select", {
    type: "model_select",
    model: { provider: "amazon-bedrock", api: "bedrock-converse-stream", name: "claude-sonnet-4-6" },
    previousModel: void 0,
    source: "set"
  });
  const payload = {
    model: "anthropic.claude-sonnet-4-6",
    tools: [{ name: "bash", type: "custom" }]
  };
  const result = await pi.fire("before_provider_request", {
    type: "before_provider_request",
    payload,
    model: { provider: "amazon-bedrock", id: "claude-sonnet-4-6", api: "bedrock-converse-stream" }
  });
  assert.equal(result, void 0, "Should not modify payload for Bedrock (different tool schema)");
  const tools = payload.tools;
  assert.ok(
    !tools.some((t) => t.type === "web_search_20250305"),
    "web_search_20250305 must NOT be injected into Bedrock requests"
  );
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3Rlc3RzL25hdGl2ZS1zZWFyY2gudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQge1xuICByZWdpc3Rlck5hdGl2ZVNlYXJjaEhvb2tzLFxuICBzdHJpcFRoaW5raW5nRnJvbUhpc3RvcnksXG4gIEJSQVZFX1RPT0xfTkFNRVMsXG4gIENVU1RPTV9TRUFSQ0hfVE9PTF9OQU1FUyxcbiAgTUFYX05BVElWRV9TRUFSQ0hFU19QRVJfU0VTU0lPTixcbiAgdHlwZSBOYXRpdmVTZWFyY2hQSSxcbn0gZnJvbSBcIi4uL3Jlc291cmNlcy9leHRlbnNpb25zL3NlYXJjaC10aGUtd2ViL25hdGl2ZS1zZWFyY2gudHNcIjtcblxuLyoqXG4gKiBUZXN0cyBmb3IgbmF0aXZlIEFudGhyb3BpYyB3ZWIgc2VhcmNoIGluamVjdGlvbi5cbiAqXG4gKiBUZXN0cyB0aGUgaG9vayBsb2dpYyBpbiBuYXRpdmUtc2VhcmNoLnRzIGRpcmVjdGx5IChubyBoZWF2eSB0b29sIGRlcHMpLlxuICovXG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBNb2NrIEV4dGVuc2lvbkFQSSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuaW50ZXJmYWNlIE1vY2tIYW5kbGVyIHtcbiAgZXZlbnQ6IHN0cmluZztcbiAgaGFuZGxlcjogKC4uLmFyZ3M6IGFueVtdKSA9PiBhbnk7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZU1vY2tQSSgpIHtcbiAgY29uc3QgaGFuZGxlcnM6IE1vY2tIYW5kbGVyW10gPSBbXTtcbiAgbGV0IGFjdGl2ZVRvb2xzID0gW1wic2VhcmNoLXRoZS13ZWJcIiwgXCJzZWFyY2hfYW5kX3JlYWRcIiwgXCJnb29nbGVfc2VhcmNoXCIsIFwiZmV0Y2hfcGFnZVwiLCBcImJhc2hcIiwgXCJyZWFkXCJdO1xuICBjb25zdCBub3RpZmljYXRpb25zOiBBcnJheTx7IG1lc3NhZ2U6IHN0cmluZzsgbGV2ZWw6IHN0cmluZyB9PiA9IFtdO1xuXG4gIGNvbnN0IG1vY2tDdHggPSB7XG4gICAgdWk6IHtcbiAgICAgIG5vdGlmeShtZXNzYWdlOiBzdHJpbmcsIGxldmVsOiBzdHJpbmcpIHtcbiAgICAgICAgbm90aWZpY2F0aW9ucy5wdXNoKHsgbWVzc2FnZSwgbGV2ZWwgfSk7XG4gICAgICB9LFxuICAgIH0sXG4gIH07XG5cbiAgY29uc3QgcGk6IE5hdGl2ZVNlYXJjaFBJICYge1xuICAgIGhhbmRsZXJzOiBNb2NrSGFuZGxlcltdO1xuICAgIG5vdGlmaWNhdGlvbnM6IHR5cGVvZiBub3RpZmljYXRpb25zO1xuICAgIG1vY2tDdHg6IHR5cGVvZiBtb2NrQ3R4O1xuICAgIGZpcmUoZXZlbnQ6IHN0cmluZywgZXZlbnREYXRhOiBhbnksIGN0eD86IGFueSk6IFByb21pc2U8YW55PjtcbiAgfSA9IHtcbiAgICBoYW5kbGVycyxcbiAgICBub3RpZmljYXRpb25zLFxuICAgIG1vY2tDdHgsXG4gICAgb24oZXZlbnQ6IHN0cmluZywgaGFuZGxlcjogKC4uLmFyZ3M6IGFueVtdKSA9PiBhbnkpIHtcbiAgICAgIGhhbmRsZXJzLnB1c2goeyBldmVudCwgaGFuZGxlciB9KTtcbiAgICB9LFxuICAgIGdldEFjdGl2ZVRvb2xzKCkge1xuICAgICAgcmV0dXJuIFsuLi5hY3RpdmVUb29sc107XG4gICAgfSxcbiAgICBzZXRBY3RpdmVUb29scyh0b29sczogc3RyaW5nW10pIHtcbiAgICAgIGFjdGl2ZVRvb2xzID0gdG9vbHM7XG4gICAgfSxcbiAgICBhc3luYyBmaXJlKGV2ZW50OiBzdHJpbmcsIGV2ZW50RGF0YTogYW55LCBjdHg/OiBhbnkpIHtcbiAgICAgIGxldCBsYXN0UmVzdWx0OiBhbnk7XG4gICAgICBmb3IgKGNvbnN0IGggb2YgaGFuZGxlcnMpIHtcbiAgICAgICAgaWYgKGguZXZlbnQgPT09IGV2ZW50KSB7XG4gICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaC5oYW5kbGVyKGV2ZW50RGF0YSwgY3R4ID8/IG1vY2tDdHgpO1xuICAgICAgICAgIGlmIChyZXN1bHQgIT09IHVuZGVmaW5lZCkgbGFzdFJlc3VsdCA9IHJlc3VsdDtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmV0dXJuIGxhc3RSZXN1bHQ7XG4gICAgfSxcbiAgfTtcblxuICByZXR1cm4gcGk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcImJlZm9yZV9wcm92aWRlcl9yZXF1ZXN0IGluamVjdHMgd2ViX3NlYXJjaCBmb3IgY2xhdWRlIG1vZGVsc1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHBpID0gY3JlYXRlTW9ja1BJKCk7XG4gIHJlZ2lzdGVyTmF0aXZlU2VhcmNoSG9va3MocGkpO1xuXG4gIC8vIENvbmZpcm0gQW50aHJvcGljIHByb3ZpZGVyIHZpYSBtb2RlbF9zZWxlY3QgYmVmb3JlIHJlcXVlc3RcbiAgYXdhaXQgcGkuZmlyZShcIm1vZGVsX3NlbGVjdFwiLCB7XG4gICAgdHlwZTogXCJtb2RlbF9zZWxlY3RcIixcbiAgICBtb2RlbDogeyBwcm92aWRlcjogXCJhbnRocm9waWNcIiwgYXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLCBuYW1lOiBcImNsYXVkZS1zb25uZXQtNC02XCIgfSxcbiAgICBwcmV2aW91c01vZGVsOiB1bmRlZmluZWQsXG4gICAgc291cmNlOiBcInNldFwiLFxuICB9KTtcblxuICBjb25zdCBwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICBtb2RlbDogXCJjbGF1ZGUtc29ubmV0LTQtNi0yMDI1MDUxNFwiLFxuICAgIHRvb2xzOiBbeyBuYW1lOiBcImJhc2hcIiwgdHlwZTogXCJjdXN0b21cIiB9XSxcbiAgfTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBwaS5maXJlKFwiYmVmb3JlX3Byb3ZpZGVyX3JlcXVlc3RcIiwge1xuICAgIHR5cGU6IFwiYmVmb3JlX3Byb3ZpZGVyX3JlcXVlc3RcIixcbiAgICBwYXlsb2FkLFxuICB9KTtcblxuICBjb25zdCB0b29scyA9IChyZXN1bHQgYXMgYW55KT8udG9vbHMgPz8gcGF5bG9hZC50b29scztcbiAgY29uc3QgbmF0aXZlVG9vbCA9ICh0b29scyBhcyBhbnlbXSkuZmluZChcbiAgICAodDogYW55KSA9PiB0LnR5cGUgPT09IFwid2ViX3NlYXJjaF8yMDI1MDMwNVwiXG4gICk7XG4gIGFzc2VydC5vayhuYXRpdmVUb29sLCBcIlNob3VsZCBpbmplY3Qgd2ViX3NlYXJjaF8yMDI1MDMwNSB0b29sXCIpO1xuICBhc3NlcnQuZXF1YWwoKHRvb2xzIGFzIGFueVtdKS5sZW5ndGgsIDIsIFwiU2hvdWxkIGhhdmUgb3JpZ2luYWwgKyBpbmplY3RlZCB0b29sXCIpO1xuICBhc3NlcnQuZXF1YWwobmF0aXZlVG9vbC5tYXhfdXNlcywgNSwgXCJTaG91bGQgc2V0IG1heF91c2VzIHRvIDUgdG8gcHJldmVudCBzZWFyY2ggbG9vcHMgKCM4MTcpXCIpO1xufSk7XG5cbnRlc3QoXCJiZWZvcmVfcHJvdmlkZXJfcmVxdWVzdCBpbmplY3RzIHdlYl9zZWFyY2ggZm9yIGNsYXVkZSBtb2RlbHMgZXZlbiB3aXRob3V0IG1vZGVsX3NlbGVjdFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHBpID0gY3JlYXRlTW9ja1BJKCk7XG4gIHJlZ2lzdGVyTmF0aXZlU2VhcmNoSG9va3MocGkpO1xuXG4gIC8vIE5PIG1vZGVsX3NlbGVjdCBmaXJlZCBcdTIwMTQgc2ltdWxhdGVzIHNlc3Npb24gcmVzdG9yZSB3aGVyZSBtb2RlbHNBcmVFcXVhbCBzdXBwcmVzc2VzIHRoZSBldmVudFxuICBjb25zdCBwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICBtb2RlbDogXCJjbGF1ZGUtb3B1cy00LTZcIixcbiAgICB0b29sczogW1xuICAgICAgeyBuYW1lOiBcImJhc2hcIiwgdHlwZTogXCJjdXN0b21cIiB9LFxuICAgICAgeyBuYW1lOiBcInNlYXJjaC10aGUtd2ViXCIsIHR5cGU6IFwiZnVuY3Rpb25cIiB9LFxuICAgICAgeyBuYW1lOiBcImdvb2dsZV9zZWFyY2hcIiwgdHlwZTogXCJmdW5jdGlvblwiIH0sXG4gICAgXSxcbiAgfTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBwaS5maXJlKFwiYmVmb3JlX3Byb3ZpZGVyX3JlcXVlc3RcIiwge1xuICAgIHR5cGU6IFwiYmVmb3JlX3Byb3ZpZGVyX3JlcXVlc3RcIixcbiAgICBwYXlsb2FkLFxuICB9KTtcblxuICBjb25zdCB0b29scyA9ICgocmVzdWx0IGFzIGFueSk/LnRvb2xzID8/IHBheWxvYWQudG9vbHMpIGFzIGFueVtdO1xuICBjb25zdCBuYW1lcyA9IHRvb2xzLm1hcCgodDogYW55KSA9PiB0Lm5hbWUgPz8gdC50eXBlKTtcblxuICBhc3NlcnQub2sobmFtZXMuaW5jbHVkZXMoXCJ3ZWJfc2VhcmNoXCIpLCBcIlNob3VsZCBpbmplY3QgbmF0aXZlIHdlYl9zZWFyY2ggYmFzZWQgb24gbW9kZWwgbmFtZVwiKTtcbiAgYXNzZXJ0Lm9rKCFuYW1lcy5pbmNsdWRlcyhcInNlYXJjaC10aGUtd2ViXCIpLCBcIlNob3VsZCByZW1vdmUgc2VhcmNoLXRoZS13ZWJcIik7XG4gIGFzc2VydC5vayghbmFtZXMuaW5jbHVkZXMoXCJnb29nbGVfc2VhcmNoXCIpLCBcIlNob3VsZCByZW1vdmUgZ29vZ2xlX3NlYXJjaFwiKTtcbiAgYXNzZXJ0Lm9rKG5hbWVzLmluY2x1ZGVzKFwiYmFzaFwiKSwgXCJTaG91bGQga2VlcCBub24tc2VhcmNoIHRvb2xzXCIpO1xufSk7XG5cbnRlc3QoXCJiZWZvcmVfcHJvdmlkZXJfcmVxdWVzdCBkb2VzIE5PVCBpbmplY3QgZm9yIG5vbi1jbGF1ZGUgbW9kZWxzXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgcGkgPSBjcmVhdGVNb2NrUEkoKTtcbiAgcmVnaXN0ZXJOYXRpdmVTZWFyY2hIb29rcyhwaSk7XG5cbiAgY29uc3QgcGF5bG9hZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgbW9kZWw6IFwiZ3B0LTRvXCIsXG4gICAgdG9vbHM6IFt7IG5hbWU6IFwiYmFzaFwiLCB0eXBlOiBcImN1c3RvbVwiIH1dLFxuICB9O1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHBpLmZpcmUoXCJiZWZvcmVfcHJvdmlkZXJfcmVxdWVzdFwiLCB7XG4gICAgdHlwZTogXCJiZWZvcmVfcHJvdmlkZXJfcmVxdWVzdFwiLFxuICAgIHBheWxvYWQsXG4gIH0pO1xuXG4gIGFzc2VydC5lcXVhbChyZXN1bHQsIHVuZGVmaW5lZCwgXCJTaG91bGQgbm90IG1vZGlmeSBub24tY2xhdWRlIHBheWxvYWRcIik7XG4gIGNvbnN0IHRvb2xzID0gcGF5bG9hZC50b29scyBhcyBhbnlbXTtcbiAgYXNzZXJ0LmVxdWFsKHRvb2xzLmxlbmd0aCwgMSwgXCJTaG91bGQgbm90IGFkZCB0b29scyB0byBub24tY2xhdWRlIHBheWxvYWRcIik7XG59KTtcblxudGVzdChcImJlZm9yZV9wcm92aWRlcl9yZXF1ZXN0IGRvZXMgTk9UIGluamVjdCBmb3IgY2xhdWRlIG1vZGVsIG9uIG5vbi1BbnRocm9waWMgcHJvdmlkZXJcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBwaSA9IGNyZWF0ZU1vY2tQSSgpO1xuICByZWdpc3Rlck5hdGl2ZVNlYXJjaEhvb2tzKHBpKTtcblxuICAvLyBHaXRIdWIgQ29waWxvdCAob3IgQmVkcm9jaywgZXRjLikgc2VydmluZyBhIGNsYXVkZSBtb2RlbC5cbiAgLy8gQ3JpdGljYWw6IHJ1bnRpbWUgbW9kZWwgb2JqZWN0cyBmcm9tIGNvcGlsb3QgY2FycnkgYXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiXG4gIC8vIGJlY2F1c2UgY29waWxvdCByb3V0ZXMgdGhyb3VnaCBwYWNrYWdlcy9waS1haS9zcmMvcHJvdmlkZXJzL2FudGhyb3BpYy50cy5cbiAgLy8gVGhlIGVhcmxpZXIgZml4dHVyZSBvbWl0dGVkIGBhcGlgIGFuZCBtYXNrZWQgdGhlICM0NDkyIHJlZ3Jlc3Npb24uXG4gIGF3YWl0IHBpLmZpcmUoXCJtb2RlbF9zZWxlY3RcIiwge1xuICAgIHR5cGU6IFwibW9kZWxfc2VsZWN0XCIsXG4gICAgbW9kZWw6IHtcbiAgICAgIHByb3ZpZGVyOiBcImdpdGh1Yi1jb3BpbG90XCIsXG4gICAgICBhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG4gICAgICBuYW1lOiBcImNsYXVkZS1zb25uZXQtNC02XCIsXG4gICAgfSxcbiAgICBwcmV2aW91c01vZGVsOiB1bmRlZmluZWQsXG4gICAgc291cmNlOiBcInNldFwiLFxuICB9KTtcblxuICBjb25zdCBwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICBtb2RlbDogXCJjbGF1ZGUtc29ubmV0LTQtNi0yMDI1MDUxNFwiLFxuICAgIHRvb2xzOiBbeyBuYW1lOiBcImJhc2hcIiwgdHlwZTogXCJjdXN0b21cIiB9XSxcbiAgfTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBwaS5maXJlKFwiYmVmb3JlX3Byb3ZpZGVyX3JlcXVlc3RcIiwge1xuICAgIHR5cGU6IFwiYmVmb3JlX3Byb3ZpZGVyX3JlcXVlc3RcIixcbiAgICBwYXlsb2FkLFxuICB9KTtcblxuICBhc3NlcnQuZXF1YWwocmVzdWx0LCB1bmRlZmluZWQsIFwiU2hvdWxkIG5vdCBtb2RpZnkgcGF5bG9hZCBmb3Igbm9uLUFudGhyb3BpYyBwcm92aWRlclwiKTtcbiAgY29uc3QgdG9vbHMgPSBwYXlsb2FkLnRvb2xzIGFzIGFueVtdO1xuICBhc3NlcnQuZXF1YWwodG9vbHMubGVuZ3RoLCAxLCBcIlNob3VsZCBub3QgaW5qZWN0IHdlYl9zZWFyY2ggZm9yIG5vbi1BbnRocm9waWMgcHJvdmlkZXJcIik7XG4gIGFzc2VydC5vayhcbiAgICAhdG9vbHMuc29tZSgodDogYW55KSA9PiB0LnR5cGUgPT09IFwid2ViX3NlYXJjaF8yMDI1MDMwNVwiKSxcbiAgICBcIndlYl9zZWFyY2hfMjAyNTAzMDUgbXVzdCBOT1QgYmUgcHJlc2VudCBmb3Igbm9uLUFudGhyb3BpYyBwcm92aWRlcnNcIlxuICApO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBJc3N1ZSAjNDQ0IHJlZ3Jlc3Npb246IENvcGlsb3QgY2xhdWRlLSogbW9kZWwgd2l0aG91dCBtb2RlbF9zZWxlY3QgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJiZWZvcmVfcHJvdmlkZXJfcmVxdWVzdCBkb2VzIE5PVCBpbmplY3Qgd2hlbiBldmVudC5tb2RlbCBpbmRpY2F0ZXMgbm9uLUFudGhyb3BpYyBwcm92aWRlciAobm8gbW9kZWxfc2VsZWN0KVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHBpID0gY3JlYXRlTW9ja1BJKCk7XG4gIHJlZ2lzdGVyTmF0aXZlU2VhcmNoSG9va3MocGkpO1xuXG4gIC8vIE5PIG1vZGVsX3NlbGVjdCBmaXJlZCBcdTIwMTQgc2ltdWxhdGVzIGEgbmV3IHNlc3Npb24gd2hlcmUgbW9kZWwgd2FzIHNldCBiZWZvcmVcbiAgLy8gZXh0ZW5zaW9ucyB3ZXJlIGJvdW5kLiBUaGUgZXZlbnQubW9kZWwgZmllbGQgZnJvbSB0aGUgU0RLIHJldmVhbHMgdGhlIHRydWUgcHJvdmlkZXIuXG4gIGNvbnN0IHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgIG1vZGVsOiBcImNsYXVkZS1zb25uZXQtNC02LTIwMjUwNTE0XCIsXG4gICAgdG9vbHM6IFt7IG5hbWU6IFwiYmFzaFwiLCB0eXBlOiBcImN1c3RvbVwiIH1dLFxuICB9O1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHBpLmZpcmUoXCJiZWZvcmVfcHJvdmlkZXJfcmVxdWVzdFwiLCB7XG4gICAgdHlwZTogXCJiZWZvcmVfcHJvdmlkZXJfcmVxdWVzdFwiLFxuICAgIHBheWxvYWQsXG4gICAgLy8gQ29waWxvdC1zZXJ2ZWQgY2xhdWRlIGNhcnJpZXMgYXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiIGF0IHJ1bnRpbWUgXHUyMDE0XG4gICAgLy8gaW5jbHVkZSBpdCBzbyB0aGUgdGVzdCBhY3R1YWxseSBleGVyY2lzZXMgdGhlICM0NDkyIGNvZGUgcGF0aC5cbiAgICBtb2RlbDoge1xuICAgICAgcHJvdmlkZXI6IFwiZ2l0aHViLWNvcGlsb3RcIixcbiAgICAgIGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcbiAgICAgIGlkOiBcImNsYXVkZS1zb25uZXQtNC02XCIsXG4gICAgfSxcbiAgfSk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgdW5kZWZpbmVkLCBcIlNob3VsZCBub3QgbW9kaWZ5IHBheWxvYWQgd2hlbiBldmVudC5tb2RlbCBzYXlzIG5vbi1BbnRocm9waWNcIik7XG4gIGNvbnN0IHRvb2xzID0gcGF5bG9hZC50b29scyBhcyBhbnlbXTtcbiAgYXNzZXJ0LmVxdWFsKHRvb2xzLmxlbmd0aCwgMSwgXCJTaG91bGQgbm90IGluamVjdCB3ZWJfc2VhcmNoIGZvciBDb3BpbG90IHByb3ZpZGVyXCIpO1xuICBhc3NlcnQub2soXG4gICAgIXRvb2xzLnNvbWUoKHQ6IGFueSkgPT4gdC50eXBlID09PSBcIndlYl9zZWFyY2hfMjAyNTAzMDVcIiksXG4gICAgXCJ3ZWJfc2VhcmNoXzIwMjUwMzA1IG11c3QgTk9UIGJlIHByZXNlbnQgZm9yIENvcGlsb3RcIlxuICApO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBJc3N1ZSAjNDQ5MiByZWdyZXNzaW9uOiBhbnRocm9waWMtc2hhcGVkIHRyYW5zcG9ydHMgd2l0aG91dCBuYXRpdmUgc2VhcmNoIFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiYmVmb3JlX3Byb3ZpZGVyX3JlcXVlc3QgZG9lcyBOT1QgaW5qZWN0IGZvciBnaXRodWItY29waWxvdCArIGNsYXVkZS1oYWlrdS00LjUgKCM0NDkyIHJlZ3Jlc3Npb24pXCIsIGFzeW5jICgpID0+IHtcbiAgLy8gUmVwcm9kdWNlcyB0aGUgb3JpZ2luYWwgcmVwb3J0OiBwcm92aWRlcj1naXRodWItY29waWxvdCwgbW9kZWw9Y2xhdWRlLWhhaWt1LTQuNVxuICAvLyBjYXJyaWVzIGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIiBhdCBydW50aW1lIChjb3BpbG90IHJvdXRlcyB0aHJvdWdoXG4gIC8vIHBhY2thZ2VzL3BpLWFpL3NyYy9wcm92aWRlcnMvYW50aHJvcGljLnRzKS4gVGhlICM0NDkyIGNoYW5nZSB0byBnYXRlIG9uIGFwaVxuICAvLyBzaGFwZSBhbG9uZSByZWdyZXNzZWQgdGhpcyBhbmQgY2F1c2VkIGV2ZXJ5IHJlcXVlc3QgdG8gZmFpbCB3aXRoXG4gIC8vIDQwMCBcIlRoZSB1c2Ugb2YgdGhlIHdlYiBzZWFyY2ggdG9vbCBpcyBub3Qgc3VwcG9ydGVkLlwiLlxuICBjb25zdCBwaSA9IGNyZWF0ZU1vY2tQSSgpO1xuICByZWdpc3Rlck5hdGl2ZVNlYXJjaEhvb2tzKHBpKTtcblxuICBhd2FpdCBwaS5maXJlKFwibW9kZWxfc2VsZWN0XCIsIHtcbiAgICB0eXBlOiBcIm1vZGVsX3NlbGVjdFwiLFxuICAgIG1vZGVsOiB7XG4gICAgICBwcm92aWRlcjogXCJnaXRodWItY29waWxvdFwiLFxuICAgICAgYXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuICAgICAgbmFtZTogXCJjbGF1ZGUtaGFpa3UtNC41XCIsXG4gICAgfSxcbiAgICBwcmV2aW91c01vZGVsOiB1bmRlZmluZWQsXG4gICAgc291cmNlOiBcInNldFwiLFxuICB9KTtcblxuICBjb25zdCBwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICBtb2RlbDogXCJjbGF1ZGUtaGFpa3UtNC41XCIsXG4gICAgdG9vbHM6IFt7IG5hbWU6IFwiYmFzaFwiLCB0eXBlOiBcImN1c3RvbVwiIH1dLFxuICB9O1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHBpLmZpcmUoXCJiZWZvcmVfcHJvdmlkZXJfcmVxdWVzdFwiLCB7XG4gICAgdHlwZTogXCJiZWZvcmVfcHJvdmlkZXJfcmVxdWVzdFwiLFxuICAgIHBheWxvYWQsXG4gICAgbW9kZWw6IHtcbiAgICAgIHByb3ZpZGVyOiBcImdpdGh1Yi1jb3BpbG90XCIsXG4gICAgICBhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG4gICAgICBpZDogXCJjbGF1ZGUtaGFpa3UtNC41XCIsXG4gICAgfSxcbiAgfSk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgdW5kZWZpbmVkLCBcIlNob3VsZCBub3QgbW9kaWZ5IHBheWxvYWQgZm9yIGdpdGh1Yi1jb3BpbG90ICsgY2xhdWRlLWhhaWt1LTQuNVwiKTtcbiAgY29uc3QgdG9vbHMgPSBwYXlsb2FkLnRvb2xzIGFzIGFueVtdO1xuICBhc3NlcnQub2soXG4gICAgIXRvb2xzLnNvbWUoKHQ6IGFueSkgPT4gdC50eXBlID09PSBcIndlYl9zZWFyY2hfMjAyNTAzMDVcIiksXG4gICAgXCJ3ZWJfc2VhcmNoXzIwMjUwMzA1IG11c3QgTk9UIGJlIGluamVjdGVkIGZvciBnaXRodWItY29waWxvdCBcdTIwMTQgZW5kcG9pbnQgcmVqZWN0cyBpdFwiXG4gICk7XG59KTtcblxudGVzdChcImJlZm9yZV9wcm92aWRlcl9yZXF1ZXN0IGRvZXMgTk9UIGluamVjdCBmb3IgbWluaW1heCAoYW50aHJvcGljLXNoYXBlZCwgbm8gbmF0aXZlIHNlYXJjaClcIiwgYXN5bmMgKCkgPT4ge1xuICAvLyBNaW5pTWF4IE0yLnggZGVjbGFyZXMgYXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiIGJ1dCBpdHMgZW5kcG9pbnQgZG9lcyBub3RcbiAgLy8gYWNjZXB0IHdlYl9zZWFyY2hfMjAyNTAzMDUgXHUyMDE0IHNhbWUgcmVncmVzc2lvbiBjbGFzcyBhcyBnaXRodWItY29waWxvdC5cbiAgY29uc3QgcGkgPSBjcmVhdGVNb2NrUEkoKTtcbiAgcmVnaXN0ZXJOYXRpdmVTZWFyY2hIb29rcyhwaSk7XG5cbiAgY29uc3QgcGF5bG9hZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgbW9kZWw6IFwiTWluaU1heC1NMi41XCIsXG4gICAgdG9vbHM6IFt7IG5hbWU6IFwiYmFzaFwiLCB0eXBlOiBcImN1c3RvbVwiIH1dLFxuICB9O1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHBpLmZpcmUoXCJiZWZvcmVfcHJvdmlkZXJfcmVxdWVzdFwiLCB7XG4gICAgdHlwZTogXCJiZWZvcmVfcHJvdmlkZXJfcmVxdWVzdFwiLFxuICAgIHBheWxvYWQsXG4gICAgbW9kZWw6IHsgcHJvdmlkZXI6IFwibWluaW1heFwiLCBhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsIGlkOiBcIk1pbmlNYXgtTTIuNVwiIH0sXG4gIH0pO1xuXG4gIGFzc2VydC5lcXVhbChyZXN1bHQsIHVuZGVmaW5lZCwgXCJTaG91bGQgbm90IG1vZGlmeSBwYXlsb2FkIGZvciBtaW5pbWF4XCIpO1xuICBjb25zdCB0b29scyA9IHBheWxvYWQudG9vbHMgYXMgYW55W107XG4gIGFzc2VydC5vayhcbiAgICAhdG9vbHMuc29tZSgodDogYW55KSA9PiB0LnR5cGUgPT09IFwid2ViX3NlYXJjaF8yMDI1MDMwNVwiKSxcbiAgICBcIndlYl9zZWFyY2hfMjAyNTAzMDUgbXVzdCBOT1QgYmUgaW5qZWN0ZWQgZm9yIG1pbmltYXhcIlxuICApO1xufSk7XG5cbnRlc3QoXCJiZWZvcmVfcHJvdmlkZXJfcmVxdWVzdCBET0VTIGluamVjdCB3aGVuIGV2ZW50Lm1vZGVsIGluZGljYXRlcyBBbnRocm9waWMgcHJvdmlkZXIgKG5vIG1vZGVsX3NlbGVjdClcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBwaSA9IGNyZWF0ZU1vY2tQSSgpO1xuICByZWdpc3Rlck5hdGl2ZVNlYXJjaEhvb2tzKHBpKTtcblxuICAvLyBOTyBtb2RlbF9zZWxlY3QgZmlyZWQsIGJ1dCBldmVudC5tb2RlbCBjb25maXJtcyBBbnRocm9waWMgcHJvdmlkZXJcbiAgY29uc3QgcGF5bG9hZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgbW9kZWw6IFwiY2xhdWRlLXNvbm5ldC00LTYtMjAyNTA1MTRcIixcbiAgICB0b29sczogW3sgbmFtZTogXCJiYXNoXCIsIHR5cGU6IFwiY3VzdG9tXCIgfV0sXG4gIH07XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcGkuZmlyZShcImJlZm9yZV9wcm92aWRlcl9yZXF1ZXN0XCIsIHtcbiAgICB0eXBlOiBcImJlZm9yZV9wcm92aWRlcl9yZXF1ZXN0XCIsXG4gICAgcGF5bG9hZCxcbiAgICBtb2RlbDogeyBwcm92aWRlcjogXCJhbnRocm9waWNcIiwgaWQ6IFwiY2xhdWRlLXNvbm5ldC00LTZcIiwgYXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiIH0sXG4gIH0pO1xuXG4gIGNvbnN0IHRvb2xzID0gKChyZXN1bHQgYXMgYW55KT8udG9vbHMgPz8gcGF5bG9hZC50b29scykgYXMgYW55W107XG4gIGFzc2VydC5vayhcbiAgICB0b29scy5zb21lKCh0OiBhbnkpID0+IHQudHlwZSA9PT0gXCJ3ZWJfc2VhcmNoXzIwMjUwMzA1XCIpLFxuICAgIFwiU2hvdWxkIGluamVjdCB3ZWJfc2VhcmNoIHdoZW4gZXZlbnQubW9kZWwgY29uZmlybXMgQW50aHJvcGljXCJcbiAgKTtcbn0pO1xuXG50ZXN0KFwiYmVmb3JlX3Byb3ZpZGVyX3JlcXVlc3QgZG9lcyBub3QgZG91YmxlLWluamVjdFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHBpID0gY3JlYXRlTW9ja1BJKCk7XG4gIHJlZ2lzdGVyTmF0aXZlU2VhcmNoSG9va3MocGkpO1xuXG4gIGF3YWl0IHBpLmZpcmUoXCJtb2RlbF9zZWxlY3RcIiwge1xuICAgIHR5cGU6IFwibW9kZWxfc2VsZWN0XCIsXG4gICAgbW9kZWw6IHsgcHJvdmlkZXI6IFwiYW50aHJvcGljXCIsIGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIiwgbmFtZTogXCJjbGF1ZGUtb3B1cy00LTZcIiB9LFxuICAgIHByZXZpb3VzTW9kZWw6IHVuZGVmaW5lZCxcbiAgICBzb3VyY2U6IFwic2V0XCIsXG4gIH0pO1xuXG4gIGNvbnN0IHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgIG1vZGVsOiBcImNsYXVkZS1vcHVzLTQtNi0yMDI1MDUxNFwiLFxuICAgIHRvb2xzOiBbeyB0eXBlOiBcIndlYl9zZWFyY2hfMjAyNTAzMDVcIiwgbmFtZTogXCJ3ZWJfc2VhcmNoXCIgfV0sXG4gIH07XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcGkuZmlyZShcImJlZm9yZV9wcm92aWRlcl9yZXF1ZXN0XCIsIHtcbiAgICB0eXBlOiBcImJlZm9yZV9wcm92aWRlcl9yZXF1ZXN0XCIsXG4gICAgcGF5bG9hZCxcbiAgfSk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgdW5kZWZpbmVkLCBcIlNob3VsZCBub3QgbW9kaWZ5IHdoZW4gYWxyZWFkeSBpbmplY3RlZFwiKTtcbiAgY29uc3QgdG9vbHMgPSBwYXlsb2FkLnRvb2xzIGFzIGFueVtdO1xuICBhc3NlcnQuZXF1YWwodG9vbHMubGVuZ3RoLCAxLCBcIlNob3VsZCBub3QgZHVwbGljYXRlIHdlYl9zZWFyY2ggdG9vbFwiKTtcbn0pO1xuXG50ZXN0KFwiYmVmb3JlX3Byb3ZpZGVyX3JlcXVlc3QgY3JlYXRlcyB0b29scyBhcnJheSBpZiBtaXNzaW5nXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgcGkgPSBjcmVhdGVNb2NrUEkoKTtcbiAgcmVnaXN0ZXJOYXRpdmVTZWFyY2hIb29rcyhwaSk7XG5cbiAgYXdhaXQgcGkuZmlyZShcIm1vZGVsX3NlbGVjdFwiLCB7XG4gICAgdHlwZTogXCJtb2RlbF9zZWxlY3RcIixcbiAgICBtb2RlbDogeyBwcm92aWRlcjogXCJhbnRocm9waWNcIiwgYXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLCBuYW1lOiBcImNsYXVkZS1oYWlrdS00LTVcIiB9LFxuICAgIHByZXZpb3VzTW9kZWw6IHVuZGVmaW5lZCxcbiAgICBzb3VyY2U6IFwic2V0XCIsXG4gIH0pO1xuXG4gIGNvbnN0IHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgIG1vZGVsOiBcImNsYXVkZS1oYWlrdS00LTUtMjAyNTEwMDFcIixcbiAgfTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBwaS5maXJlKFwiYmVmb3JlX3Byb3ZpZGVyX3JlcXVlc3RcIiwge1xuICAgIHR5cGU6IFwiYmVmb3JlX3Byb3ZpZGVyX3JlcXVlc3RcIixcbiAgICBwYXlsb2FkLFxuICB9KTtcblxuICBjb25zdCB0b29scyA9IChyZXN1bHQgYXMgYW55KT8udG9vbHMgPz8gcGF5bG9hZC50b29scztcbiAgYXNzZXJ0Lm9rKEFycmF5LmlzQXJyYXkodG9vbHMpLCBcIlNob3VsZCBjcmVhdGUgdG9vbHMgYXJyYXlcIik7XG4gIGFzc2VydC5lcXVhbCgodG9vbHMgYXMgYW55W10pLmxlbmd0aCwgMSwgXCJTaG91bGQgaGF2ZSBleGFjdGx5IDEgdG9vbFwiKTtcbiAgYXNzZXJ0LmVxdWFsKCh0b29scyBhcyBhbnlbXSlbMF0udHlwZSwgXCJ3ZWJfc2VhcmNoXzIwMjUwMzA1XCIpO1xuICBhc3NlcnQuZXF1YWwoKHRvb2xzIGFzIGFueVtdKVswXS5tYXhfdXNlcywgNSwgXCJTaG91bGQgaW5jbHVkZSBtYXhfdXNlcyBsaW1pdFwiKTtcbn0pO1xuXG50ZXN0KFwiYmVmb3JlX3Byb3ZpZGVyX3JlcXVlc3Qgc2tpcHMgd2hlbiBwYXlsb2FkIGlzIGZhbHN5XCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgcGkgPSBjcmVhdGVNb2NrUEkoKTtcbiAgcmVnaXN0ZXJOYXRpdmVTZWFyY2hIb29rcyhwaSk7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcGkuZmlyZShcImJlZm9yZV9wcm92aWRlcl9yZXF1ZXN0XCIsIHtcbiAgICB0eXBlOiBcImJlZm9yZV9wcm92aWRlcl9yZXF1ZXN0XCIsXG4gICAgcGF5bG9hZDogbnVsbCxcbiAgfSk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgdW5kZWZpbmVkLCBcIlNob3VsZCByZXR1cm4gdW5kZWZpbmVkIGZvciBudWxsIHBheWxvYWRcIik7XG59KTtcblxudGVzdChcIm1vZGVsX3NlbGVjdCBkaXNhYmxlcyBCcmF2ZSB0b29scyB3aGVuIEFudGhyb3BpYyArIG5vIEJSQVZFX0FQSV9LRVlcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3Qgb3JpZ2luYWxLZXkgPSBwcm9jZXNzLmVudi5CUkFWRV9BUElfS0VZO1xuICBkZWxldGUgcHJvY2Vzcy5lbnYuQlJBVkVfQVBJX0tFWTtcblxuICB0LmFmdGVyKCgpID0+IHtcbiAgICBpZiAob3JpZ2luYWxLZXkpIHByb2Nlc3MuZW52LkJSQVZFX0FQSV9LRVkgPSBvcmlnaW5hbEtleTtcbiAgICBlbHNlIGRlbGV0ZSBwcm9jZXNzLmVudi5CUkFWRV9BUElfS0VZO1xuICB9KTtcbiAgY29uc3QgcGkgPSBjcmVhdGVNb2NrUEkoKTtcbiAgcmVnaXN0ZXJOYXRpdmVTZWFyY2hIb29rcyhwaSk7XG5cbiAgYXdhaXQgcGkuZmlyZShcIm1vZGVsX3NlbGVjdFwiLCB7XG4gICAgdHlwZTogXCJtb2RlbF9zZWxlY3RcIixcbiAgICBtb2RlbDogeyBwcm92aWRlcjogXCJhbnRocm9waWNcIiwgYXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLCBuYW1lOiBcImNsYXVkZS1zb25uZXQtNC02XCIgfSxcbiAgICBwcmV2aW91c01vZGVsOiB1bmRlZmluZWQsXG4gICAgc291cmNlOiBcInNldFwiLFxuICB9KTtcblxuICBjb25zdCBhY3RpdmUgPSBwaS5nZXRBY3RpdmVUb29scygpO1xuICBhc3NlcnQub2soIWFjdGl2ZS5pbmNsdWRlcyhcInNlYXJjaC10aGUtd2ViXCIpLCBcInNlYXJjaC10aGUtd2ViIHNob3VsZCBiZSBkaXNhYmxlZFwiKTtcbiAgYXNzZXJ0Lm9rKCFhY3RpdmUuaW5jbHVkZXMoXCJzZWFyY2hfYW5kX3JlYWRcIiksIFwic2VhcmNoX2FuZF9yZWFkIHNob3VsZCBiZSBkaXNhYmxlZFwiKTtcbiAgYXNzZXJ0Lm9rKCFhY3RpdmUuaW5jbHVkZXMoXCJnb29nbGVfc2VhcmNoXCIpLCBcImdvb2dsZV9zZWFyY2ggc2hvdWxkIGJlIGRpc2FibGVkXCIpO1xuICBhc3NlcnQub2soYWN0aXZlLmluY2x1ZGVzKFwiZmV0Y2hfcGFnZVwiKSwgXCJmZXRjaF9wYWdlIHNob3VsZCByZW1haW4gYWN0aXZlXCIpO1xuICBhc3NlcnQub2soYWN0aXZlLmluY2x1ZGVzKFwiYmFzaFwiKSwgXCJPdGhlciB0b29scyBzaG91bGQgcmVtYWluIGFjdGl2ZVwiKTtcbn0pO1xuXG50ZXN0KFwibW9kZWxfc2VsZWN0IGRpc2FibGVzIGFsbCBjdXN0b20gc2VhcmNoIHRvb2xzIHdoZW4gQW50aHJvcGljIGV2ZW4gd2l0aCBCUkFWRV9BUElfS0VZXCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IG9yaWdpbmFsS2V5ID0gcHJvY2Vzcy5lbnYuQlJBVkVfQVBJX0tFWTtcbiAgcHJvY2Vzcy5lbnYuQlJBVkVfQVBJX0tFWSA9IFwidGVzdC1rZXlcIjtcblxuICB0LmFmdGVyKCgpID0+IHtcbiAgICBpZiAob3JpZ2luYWxLZXkpIHByb2Nlc3MuZW52LkJSQVZFX0FQSV9LRVkgPSBvcmlnaW5hbEtleTtcbiAgICBlbHNlIGRlbGV0ZSBwcm9jZXNzLmVudi5CUkFWRV9BUElfS0VZO1xuICB9KTtcbiAgY29uc3QgcGkgPSBjcmVhdGVNb2NrUEkoKTtcbiAgcmVnaXN0ZXJOYXRpdmVTZWFyY2hIb29rcyhwaSk7XG5cbiAgYXdhaXQgcGkuZmlyZShcIm1vZGVsX3NlbGVjdFwiLCB7XG4gICAgdHlwZTogXCJtb2RlbF9zZWxlY3RcIixcbiAgICBtb2RlbDogeyBwcm92aWRlcjogXCJhbnRocm9waWNcIiwgYXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLCBuYW1lOiBcImNsYXVkZS1zb25uZXQtNC02XCIgfSxcbiAgICBwcmV2aW91c01vZGVsOiB1bmRlZmluZWQsXG4gICAgc291cmNlOiBcInNldFwiLFxuICB9KTtcblxuICBjb25zdCBhY3RpdmUgPSBwaS5nZXRBY3RpdmVUb29scygpO1xuICBhc3NlcnQub2soIWFjdGl2ZS5pbmNsdWRlcyhcInNlYXJjaC10aGUtd2ViXCIpLCBcInNlYXJjaC10aGUtd2ViIHNob3VsZCBiZSBkaXNhYmxlZCBmb3IgQW50aHJvcGljXCIpO1xuICBhc3NlcnQub2soIWFjdGl2ZS5pbmNsdWRlcyhcInNlYXJjaF9hbmRfcmVhZFwiKSwgXCJzZWFyY2hfYW5kX3JlYWQgc2hvdWxkIGJlIGRpc2FibGVkIGZvciBBbnRocm9waWNcIik7XG4gIGFzc2VydC5vayghYWN0aXZlLmluY2x1ZGVzKFwiZ29vZ2xlX3NlYXJjaFwiKSwgXCJnb29nbGVfc2VhcmNoIHNob3VsZCBiZSBkaXNhYmxlZCBmb3IgQW50aHJvcGljXCIpO1xuICBhc3NlcnQub2soYWN0aXZlLmluY2x1ZGVzKFwiZmV0Y2hfcGFnZVwiKSwgXCJmZXRjaF9wYWdlIHNob3VsZCByZW1haW4gYWN0aXZlXCIpO1xufSk7XG5cbnRlc3QoXCJtb2RlbF9zZWxlY3QgcmUtZW5hYmxlcyBCcmF2ZSB0b29scyB3aGVuIHN3aXRjaGluZyBhd2F5IGZyb20gQW50aHJvcGljXCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IG9yaWdpbmFsS2V5ID0gcHJvY2Vzcy5lbnYuQlJBVkVfQVBJX0tFWTtcbiAgZGVsZXRlIHByb2Nlc3MuZW52LkJSQVZFX0FQSV9LRVk7XG5cbiAgdC5hZnRlcigoKSA9PiB7XG4gICAgaWYgKG9yaWdpbmFsS2V5KSBwcm9jZXNzLmVudi5CUkFWRV9BUElfS0VZID0gb3JpZ2luYWxLZXk7XG4gICAgZWxzZSBkZWxldGUgcHJvY2Vzcy5lbnYuQlJBVkVfQVBJX0tFWTtcbiAgfSk7XG4gIGNvbnN0IHBpID0gY3JlYXRlTW9ja1BJKCk7XG4gIHJlZ2lzdGVyTmF0aXZlU2VhcmNoSG9va3MocGkpO1xuXG4gIC8vIEZpcnN0OiBzZWxlY3QgQW50aHJvcGljIFx1MjAxNCBkaXNhYmxlcyBCcmF2ZSB0b29sc1xuICBhd2FpdCBwaS5maXJlKFwibW9kZWxfc2VsZWN0XCIsIHtcbiAgICB0eXBlOiBcIm1vZGVsX3NlbGVjdFwiLFxuICAgIG1vZGVsOiB7IHByb3ZpZGVyOiBcImFudGhyb3BpY1wiLCBhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsIG5hbWU6IFwiY2xhdWRlLXNvbm5ldC00LTZcIiB9LFxuICAgIHByZXZpb3VzTW9kZWw6IHVuZGVmaW5lZCxcbiAgICBzb3VyY2U6IFwic2V0XCIsXG4gIH0pO1xuXG4gIGxldCBhY3RpdmUgPSBwaS5nZXRBY3RpdmVUb29scygpO1xuICBhc3NlcnQub2soIWFjdGl2ZS5pbmNsdWRlcyhcInNlYXJjaC10aGUtd2ViXCIpLCBcIlNob3VsZCBkaXNhYmxlIGFmdGVyIEFudGhyb3BpYyBzZWxlY3RcIik7XG5cbiAgLy8gU2Vjb25kOiBzd2l0Y2ggdG8gbm9uLUFudGhyb3BpYyBcdTIwMTQgcmUtZW5hYmxlc1xuICBhd2FpdCBwaS5maXJlKFwibW9kZWxfc2VsZWN0XCIsIHtcbiAgICB0eXBlOiBcIm1vZGVsX3NlbGVjdFwiLFxuICAgIG1vZGVsOiB7IHByb3ZpZGVyOiBcIm9wZW5haVwiLCBuYW1lOiBcImdwdC00b1wiIH0sXG4gICAgcHJldmlvdXNNb2RlbDogeyBwcm92aWRlcjogXCJhbnRocm9waWNcIiwgbmFtZTogXCJjbGF1ZGUtc29ubmV0LTQtNlwiIH0sXG4gICAgc291cmNlOiBcInNldFwiLFxuICB9KTtcblxuICBhY3RpdmUgPSBwaS5nZXRBY3RpdmVUb29scygpO1xuICBhc3NlcnQub2soYWN0aXZlLmluY2x1ZGVzKFwic2VhcmNoLXRoZS13ZWJcIiksIFwic2VhcmNoLXRoZS13ZWIgc2hvdWxkIGJlIHJlLWVuYWJsZWRcIik7XG4gIGFzc2VydC5vayhhY3RpdmUuaW5jbHVkZXMoXCJzZWFyY2hfYW5kX3JlYWRcIiksIFwic2VhcmNoX2FuZF9yZWFkIHNob3VsZCBiZSByZS1lbmFibGVkXCIpO1xuICBhc3NlcnQub2soYWN0aXZlLmluY2x1ZGVzKFwiZ29vZ2xlX3NlYXJjaFwiKSwgXCJnb29nbGVfc2VhcmNoIHNob3VsZCBiZSByZS1lbmFibGVkXCIpO1xufSk7XG5cbnRlc3QoXCJtb2RlbF9zZWxlY3Qgc2hvd3MgJ05hdGl2ZSBBbnRocm9waWMgd2ViIHNlYXJjaCBhY3RpdmUnIGZvciBBbnRocm9waWMgcHJvdmlkZXJcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBwaSA9IGNyZWF0ZU1vY2tQSSgpO1xuICByZWdpc3Rlck5hdGl2ZVNlYXJjaEhvb2tzKHBpKTtcblxuICBhd2FpdCBwaS5maXJlKFwibW9kZWxfc2VsZWN0XCIsIHtcbiAgICB0eXBlOiBcIm1vZGVsX3NlbGVjdFwiLFxuICAgIG1vZGVsOiB7IHByb3ZpZGVyOiBcImFudGhyb3BpY1wiLCBhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsIG5hbWU6IFwiY2xhdWRlLXNvbm5ldC00LTZcIiB9LFxuICAgIHByZXZpb3VzTW9kZWw6IHVuZGVmaW5lZCxcbiAgICBzb3VyY2U6IFwic2V0XCIsXG4gIH0pO1xuXG4gIGNvbnN0IGluZm9Ob3RpZiA9IHBpLm5vdGlmaWNhdGlvbnMuZmluZChcbiAgICAobikgPT4gbi5sZXZlbCA9PT0gXCJpbmZvXCIgJiYgbi5tZXNzYWdlLmluY2x1ZGVzKFwiTmF0aXZlXCIpXG4gICk7XG4gIGFzc2VydC5vayhpbmZvTm90aWYsIFwiU2hvdWxkIG5vdGlmeSBhYm91dCBuYXRpdmUgc2VhcmNoIG9uIEFudGhyb3BpYyBtb2RlbF9zZWxlY3RcIik7XG4gIGFzc2VydC5vayhcbiAgICBpbmZvTm90aWYhLm1lc3NhZ2UuaW5jbHVkZXMoXCJOYXRpdmUgQW50aHJvcGljIHdlYiBzZWFyY2ggYWN0aXZlXCIpLFxuICAgIGBTaG91bGQgc2F5ICdOYXRpdmUgQW50aHJvcGljIHdlYiBzZWFyY2ggYWN0aXZlJyBcdTIwMTQgZ290OiAke2luZm9Ob3RpZiEubWVzc2FnZX1gXG4gICk7XG59KTtcblxudGVzdChcIm1vZGVsX3NlbGVjdCBzaG93cyB3YXJuaW5nIGZvciBub24tQW50aHJvcGljIHdpdGhvdXQgQnJhdmUga2V5XCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IG9yaWdpbmFsS2V5ID0gcHJvY2Vzcy5lbnYuQlJBVkVfQVBJX0tFWTtcbiAgZGVsZXRlIHByb2Nlc3MuZW52LkJSQVZFX0FQSV9LRVk7XG5cbiAgdC5hZnRlcigoKSA9PiB7XG4gICAgaWYgKG9yaWdpbmFsS2V5KSBwcm9jZXNzLmVudi5CUkFWRV9BUElfS0VZID0gb3JpZ2luYWxLZXk7XG4gICAgZWxzZSBkZWxldGUgcHJvY2Vzcy5lbnYuQlJBVkVfQVBJX0tFWTtcbiAgfSk7XG4gIGNvbnN0IHBpID0gY3JlYXRlTW9ja1BJKCk7XG4gIHJlZ2lzdGVyTmF0aXZlU2VhcmNoSG9va3MocGkpO1xuXG4gIGF3YWl0IHBpLmZpcmUoXCJtb2RlbF9zZWxlY3RcIiwge1xuICAgIHR5cGU6IFwibW9kZWxfc2VsZWN0XCIsXG4gICAgbW9kZWw6IHsgcHJvdmlkZXI6IFwib3BlbmFpXCIsIG5hbWU6IFwiZ3B0LTRvXCIgfSxcbiAgICBwcmV2aW91c01vZGVsOiB1bmRlZmluZWQsXG4gICAgc291cmNlOiBcInNldFwiLFxuICB9KTtcblxuICBjb25zdCB3YXJuaW5nID0gcGkubm90aWZpY2F0aW9ucy5maW5kKChuKSA9PiBuLmxldmVsID09PSBcIndhcm5pbmdcIik7XG4gIGFzc2VydC5vayh3YXJuaW5nLCBcIlNob3VsZCBzaG93IHdhcm5pbmcgZm9yIG5vbi1BbnRocm9waWMgd2l0aG91dCBCcmF2ZSBrZXlcIik7XG4gIGFzc2VydC5vayhcbiAgICB3YXJuaW5nIS5tZXNzYWdlLmluY2x1ZGVzKFwiQW50aHJvcGljXCIpLFxuICAgIGBXYXJuaW5nIHNob3VsZCBtZW50aW9uIEFudGhyb3BpYyBcdTIwMTQgZ290OiAke3dhcm5pbmchLm1lc3NhZ2V9YFxuICApO1xufSk7XG5cbnRlc3QoXCJzZXNzaW9uX3N0YXJ0IHJlc2V0cyBzZWFyY2ggY291bnQgYW5kIHNob3dzIG5vIHN0YXJ0dXAgbm90aWZpY2F0aW9uXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgcGkgPSBjcmVhdGVNb2NrUEkoKTtcbiAgcmVnaXN0ZXJOYXRpdmVTZWFyY2hIb29rcyhwaSk7XG5cbiAgYXdhaXQgcGkuZmlyZShcInNlc3Npb25fc3RhcnRcIiwgeyB0eXBlOiBcInNlc3Npb25fc3RhcnRcIiB9KTtcblxuICAvLyBUb29sIHN0YXR1cyBpcyBub3cgc2hvd24gaW4gdGhlIHdlbGNvbWUgc2NyZWVuIGJhciBsYXlvdXQgXHUyMDE0IG5vIG5vdGlmaWNhdGlvbiBvbiBzZXNzaW9uX3N0YXJ0XG4gIGNvbnN0IGluZm9Ob3RpZiA9IHBpLm5vdGlmaWNhdGlvbnMuZmluZChcbiAgICAobikgPT4gbi5sZXZlbCA9PT0gXCJpbmZvXCIgJiYgbi5tZXNzYWdlLmluY2x1ZGVzKFwidjRcIilcbiAgKTtcbiAgYXNzZXJ0LmVxdWFsKGluZm9Ob3RpZiwgdW5kZWZpbmVkLCBcIlNob3VsZCBOT1QgZW1pdCBhIHY0IHN0YXJ0dXAgbm90aWZpY2F0aW9uICh3ZWxjb21lIHNjcmVlbiBoYW5kbGVzIHRoaXMpXCIpO1xufSk7XG5cbnRlc3QoXCJCUkFWRV9UT09MX05BTUVTIGNvbnRhaW5zIGV4cGVjdGVkIHRvb2wgbmFtZXNcIiwgKCkgPT4ge1xuICBhc3NlcnQuZGVlcEVxdWFsKEJSQVZFX1RPT0xfTkFNRVMsIFtcInNlYXJjaC10aGUtd2ViXCIsIFwic2VhcmNoX2FuZF9yZWFkXCJdKTtcbn0pO1xuXG50ZXN0KFwiQ1VTVE9NX1NFQVJDSF9UT09MX05BTUVTIGNvbnRhaW5zIGFsbCBjdXN0b20gc2VhcmNoIHRvb2xzXCIsICgpID0+IHtcbiAgYXNzZXJ0LmRlZXBFcXVhbChDVVNUT01fU0VBUkNIX1RPT0xfTkFNRVMsIFtcInNlYXJjaC10aGUtd2ViXCIsIFwic2VhcmNoX2FuZF9yZWFkXCIsIFwiZ29vZ2xlX3NlYXJjaFwiXSk7XG59KTtcblxudGVzdChcImJlZm9yZV9wcm92aWRlcl9yZXF1ZXN0IHJlbW92ZXMgQnJhdmUgdG9vbHMgZnJvbSBwYXlsb2FkIHdoZW4gbm8gQlJBVkVfQVBJX0tFWVwiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBvcmlnaW5hbEtleSA9IHByb2Nlc3MuZW52LkJSQVZFX0FQSV9LRVk7XG4gIGRlbGV0ZSBwcm9jZXNzLmVudi5CUkFWRV9BUElfS0VZO1xuXG4gIHQuYWZ0ZXIoKCkgPT4ge1xuICAgIGlmIChvcmlnaW5hbEtleSkgcHJvY2Vzcy5lbnYuQlJBVkVfQVBJX0tFWSA9IG9yaWdpbmFsS2V5O1xuICAgIGVsc2UgZGVsZXRlIHByb2Nlc3MuZW52LkJSQVZFX0FQSV9LRVk7XG4gIH0pO1xuICBjb25zdCBwaSA9IGNyZWF0ZU1vY2tQSSgpO1xuICByZWdpc3Rlck5hdGl2ZVNlYXJjaEhvb2tzKHBpKTtcblxuICBhd2FpdCBwaS5maXJlKFwibW9kZWxfc2VsZWN0XCIsIHtcbiAgICB0eXBlOiBcIm1vZGVsX3NlbGVjdFwiLFxuICAgIG1vZGVsOiB7IHByb3ZpZGVyOiBcImFudGhyb3BpY1wiLCBhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsIG5hbWU6IFwiY2xhdWRlLXNvbm5ldC00LTZcIiB9LFxuICAgIHByZXZpb3VzTW9kZWw6IHVuZGVmaW5lZCxcbiAgICBzb3VyY2U6IFwic2V0XCIsXG4gIH0pO1xuXG4gIGNvbnN0IHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgIG1vZGVsOiBcImNsYXVkZS1zb25uZXQtNC02LTIwMjUwNTE0XCIsXG4gICAgdG9vbHM6IFtcbiAgICAgIHsgbmFtZTogXCJiYXNoXCIsIHR5cGU6IFwiZnVuY3Rpb25cIiB9LFxuICAgICAgeyBuYW1lOiBcInNlYXJjaC10aGUtd2ViXCIsIHR5cGU6IFwiZnVuY3Rpb25cIiB9LFxuICAgICAgeyBuYW1lOiBcInNlYXJjaF9hbmRfcmVhZFwiLCB0eXBlOiBcImZ1bmN0aW9uXCIgfSxcbiAgICAgIHsgbmFtZTogXCJnb29nbGVfc2VhcmNoXCIsIHR5cGU6IFwiZnVuY3Rpb25cIiB9LFxuICAgICAgeyBuYW1lOiBcImZldGNoX3BhZ2VcIiwgdHlwZTogXCJmdW5jdGlvblwiIH0sXG4gICAgXSxcbiAgfTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBwaS5maXJlKFwiYmVmb3JlX3Byb3ZpZGVyX3JlcXVlc3RcIiwge1xuICAgIHR5cGU6IFwiYmVmb3JlX3Byb3ZpZGVyX3JlcXVlc3RcIixcbiAgICBwYXlsb2FkLFxuICB9KTtcblxuICBjb25zdCB0b29scyA9ICgocmVzdWx0IGFzIGFueSk/LnRvb2xzID8/IHBheWxvYWQudG9vbHMpIGFzIGFueVtdO1xuICBjb25zdCBuYW1lcyA9IHRvb2xzLm1hcCgodDogYW55KSA9PiB0Lm5hbWUpO1xuXG4gIGFzc2VydC5vayghbmFtZXMuaW5jbHVkZXMoXCJzZWFyY2gtdGhlLXdlYlwiKSwgXCJzZWFyY2gtdGhlLXdlYiBzaG91bGQgYmUgcmVtb3ZlZCBmcm9tIHBheWxvYWRcIik7XG4gIGFzc2VydC5vayghbmFtZXMuaW5jbHVkZXMoXCJzZWFyY2hfYW5kX3JlYWRcIiksIFwic2VhcmNoX2FuZF9yZWFkIHNob3VsZCBiZSByZW1vdmVkIGZyb20gcGF5bG9hZFwiKTtcbiAgYXNzZXJ0Lm9rKCFuYW1lcy5pbmNsdWRlcyhcImdvb2dsZV9zZWFyY2hcIiksIFwiZ29vZ2xlX3NlYXJjaCBzaG91bGQgYmUgcmVtb3ZlZCBmcm9tIHBheWxvYWRcIik7XG4gIGFzc2VydC5vayhuYW1lcy5pbmNsdWRlcyhcImJhc2hcIiksIFwiYmFzaCBzaG91bGQgcmVtYWluXCIpO1xuICBhc3NlcnQub2sobmFtZXMuaW5jbHVkZXMoXCJmZXRjaF9wYWdlXCIpLCBcImZldGNoX3BhZ2Ugc2hvdWxkIHJlbWFpblwiKTtcbiAgYXNzZXJ0Lm9rKG5hbWVzLmluY2x1ZGVzKFwid2ViX3NlYXJjaFwiKSwgXCJuYXRpdmUgd2ViX3NlYXJjaCBzaG91bGQgYmUgaW5qZWN0ZWRcIik7XG59KTtcblxudGVzdChcImJlZm9yZV9wcm92aWRlcl9yZXF1ZXN0IHJlbW92ZXMgYWxsIGN1c3RvbSBzZWFyY2ggdG9vbHMgZnJvbSBwYXlsb2FkIGV2ZW4gd2l0aCBCUkFWRV9BUElfS0VZXCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IG9yaWdpbmFsS2V5ID0gcHJvY2Vzcy5lbnYuQlJBVkVfQVBJX0tFWTtcbiAgcHJvY2Vzcy5lbnYuQlJBVkVfQVBJX0tFWSA9IFwidGVzdC1rZXlcIjtcblxuICB0LmFmdGVyKCgpID0+IHtcbiAgICBpZiAob3JpZ2luYWxLZXkpIHByb2Nlc3MuZW52LkJSQVZFX0FQSV9LRVkgPSBvcmlnaW5hbEtleTtcbiAgICBlbHNlIGRlbGV0ZSBwcm9jZXNzLmVudi5CUkFWRV9BUElfS0VZO1xuICB9KTtcbiAgY29uc3QgcGkgPSBjcmVhdGVNb2NrUEkoKTtcbiAgcmVnaXN0ZXJOYXRpdmVTZWFyY2hIb29rcyhwaSk7XG5cbiAgYXdhaXQgcGkuZmlyZShcIm1vZGVsX3NlbGVjdFwiLCB7XG4gICAgdHlwZTogXCJtb2RlbF9zZWxlY3RcIixcbiAgICBtb2RlbDogeyBwcm92aWRlcjogXCJhbnRocm9waWNcIiwgYXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLCBuYW1lOiBcImNsYXVkZS1zb25uZXQtNC02XCIgfSxcbiAgICBwcmV2aW91c01vZGVsOiB1bmRlZmluZWQsXG4gICAgc291cmNlOiBcInNldFwiLFxuICB9KTtcblxuICBjb25zdCBwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICBtb2RlbDogXCJjbGF1ZGUtc29ubmV0LTQtNi0yMDI1MDUxNFwiLFxuICAgIHRvb2xzOiBbXG4gICAgICB7IG5hbWU6IFwic2VhcmNoLXRoZS13ZWJcIiwgdHlwZTogXCJmdW5jdGlvblwiIH0sXG4gICAgICB7IG5hbWU6IFwic2VhcmNoX2FuZF9yZWFkXCIsIHR5cGU6IFwiZnVuY3Rpb25cIiB9LFxuICAgICAgeyBuYW1lOiBcImdvb2dsZV9zZWFyY2hcIiwgdHlwZTogXCJmdW5jdGlvblwiIH0sXG4gICAgICB7IG5hbWU6IFwiZmV0Y2hfcGFnZVwiLCB0eXBlOiBcImZ1bmN0aW9uXCIgfSxcbiAgICBdLFxuICB9O1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHBpLmZpcmUoXCJiZWZvcmVfcHJvdmlkZXJfcmVxdWVzdFwiLCB7XG4gICAgdHlwZTogXCJiZWZvcmVfcHJvdmlkZXJfcmVxdWVzdFwiLFxuICAgIHBheWxvYWQsXG4gIH0pO1xuXG4gIGNvbnN0IHRvb2xzID0gKChyZXN1bHQgYXMgYW55KT8udG9vbHMgPz8gcGF5bG9hZC50b29scykgYXMgYW55W107XG4gIGNvbnN0IG5hbWVzID0gdG9vbHMubWFwKCh0OiBhbnkpID0+IHQubmFtZSk7XG5cbiAgYXNzZXJ0Lm9rKCFuYW1lcy5pbmNsdWRlcyhcInNlYXJjaC10aGUtd2ViXCIpLCBcInNlYXJjaC10aGUtd2ViIHNob3VsZCBiZSByZW1vdmVkIGZvciBBbnRocm9waWNcIik7XG4gIGFzc2VydC5vayghbmFtZXMuaW5jbHVkZXMoXCJzZWFyY2hfYW5kX3JlYWRcIiksIFwic2VhcmNoX2FuZF9yZWFkIHNob3VsZCBiZSByZW1vdmVkIGZvciBBbnRocm9waWNcIik7XG4gIGFzc2VydC5vayghbmFtZXMuaW5jbHVkZXMoXCJnb29nbGVfc2VhcmNoXCIpLCBcImdvb2dsZV9zZWFyY2ggc2hvdWxkIGJlIHJlbW92ZWQgZm9yIEFudGhyb3BpY1wiKTtcbiAgYXNzZXJ0Lm9rKG5hbWVzLmluY2x1ZGVzKFwiZmV0Y2hfcGFnZVwiKSwgXCJmZXRjaF9wYWdlIHNob3VsZCByZW1haW5cIik7XG4gIGFzc2VydC5vayhuYW1lcy5pbmNsdWRlcyhcIndlYl9zZWFyY2hcIiksIFwibmF0aXZlIHdlYl9zZWFyY2ggc2hvdWxkIGJlIGluamVjdGVkXCIpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBCVUctMSByZWdyZXNzaW9uOiBkdXBsaWNhdGUgQnJhdmUgdG9vbHMgb24gcmVwZWF0ZWQgcHJvdmlkZXIgdG9nZ2xlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwibW9kZWxfc2VsZWN0IHJlLWVuYWJsZSBkb2VzIG5vdCBkdXBsaWNhdGUgQnJhdmUgdG9vbHMgYWNyb3NzIHRvZ2dsZSBjeWNsZXNcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3Qgb3JpZ2luYWxLZXkgPSBwcm9jZXNzLmVudi5CUkFWRV9BUElfS0VZO1xuICBkZWxldGUgcHJvY2Vzcy5lbnYuQlJBVkVfQVBJX0tFWTtcblxuICB0LmFmdGVyKCgpID0+IHtcbiAgICBpZiAob3JpZ2luYWxLZXkpIHByb2Nlc3MuZW52LkJSQVZFX0FQSV9LRVkgPSBvcmlnaW5hbEtleTtcbiAgICBlbHNlIGRlbGV0ZSBwcm9jZXNzLmVudi5CUkFWRV9BUElfS0VZO1xuICB9KTtcbiAgY29uc3QgcGkgPSBjcmVhdGVNb2NrUEkoKTtcbiAgcmVnaXN0ZXJOYXRpdmVTZWFyY2hIb29rcyhwaSk7XG5cbiAgLy8gQ3ljbGUgMTogQW50aHJvcGljIGRpc2FibGVzIEJyYXZlIHRvb2xzXG4gIGF3YWl0IHBpLmZpcmUoXCJtb2RlbF9zZWxlY3RcIiwge1xuICAgIHR5cGU6IFwibW9kZWxfc2VsZWN0XCIsXG4gICAgbW9kZWw6IHsgcHJvdmlkZXI6IFwiYW50aHJvcGljXCIsIGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIiwgbmFtZTogXCJjbGF1ZGUtc29ubmV0LTQtNlwiIH0sXG4gICAgcHJldmlvdXNNb2RlbDogdW5kZWZpbmVkLFxuICAgIHNvdXJjZTogXCJzZXRcIixcbiAgfSk7XG4gIGFzc2VydC5vayghcGkuZ2V0QWN0aXZlVG9vbHMoKS5pbmNsdWRlcyhcInNlYXJjaC10aGUtd2ViXCIpLCBcIkRpc2FibGVkIGFmdGVyIDFzdCBBbnRocm9waWMgc2VsZWN0XCIpO1xuXG4gIC8vIEN5Y2xlIDE6IHN3aXRjaCBhd2F5IHJlLWVuYWJsZXNcbiAgYXdhaXQgcGkuZmlyZShcIm1vZGVsX3NlbGVjdFwiLCB7XG4gICAgdHlwZTogXCJtb2RlbF9zZWxlY3RcIixcbiAgICBtb2RlbDogeyBwcm92aWRlcjogXCJvcGVuYWlcIiwgbmFtZTogXCJncHQtNG9cIiB9LFxuICAgIHByZXZpb3VzTW9kZWw6IHsgcHJvdmlkZXI6IFwiYW50aHJvcGljXCIsIG5hbWU6IFwiY2xhdWRlLXNvbm5ldC00LTZcIiB9LFxuICAgIHNvdXJjZTogXCJzZXRcIixcbiAgfSk7XG4gIGxldCBhY3RpdmUgPSBwaS5nZXRBY3RpdmVUb29scygpO1xuICBhc3NlcnQuZXF1YWwoXG4gICAgYWN0aXZlLmZpbHRlcigodCkgPT4gdCA9PT0gXCJzZWFyY2gtdGhlLXdlYlwiKS5sZW5ndGgsIDEsXG4gICAgXCJzZWFyY2gtdGhlLXdlYiBleGFjdGx5IG9uY2UgYWZ0ZXIgZmlyc3QgcmUtZW5hYmxlXCJcbiAgKTtcblxuICAvLyBDeWNsZSAyOiBBbnRocm9waWMgYWdhaW5cbiAgYXdhaXQgcGkuZmlyZShcIm1vZGVsX3NlbGVjdFwiLCB7XG4gICAgdHlwZTogXCJtb2RlbF9zZWxlY3RcIixcbiAgICBtb2RlbDogeyBwcm92aWRlcjogXCJhbnRocm9waWNcIiwgYXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLCBuYW1lOiBcImNsYXVkZS1zb25uZXQtNC02XCIgfSxcbiAgICBwcmV2aW91c01vZGVsOiB7IHByb3ZpZGVyOiBcIm9wZW5haVwiLCBuYW1lOiBcImdwdC00b1wiIH0sXG4gICAgc291cmNlOiBcInNldFwiLFxuICB9KTtcblxuICAvLyBDeWNsZSAyOiBzd2l0Y2ggYXdheSBhZ2FpbiBcdTIwMTQgbXVzdCBOT1QgYWNjdW11bGF0ZSBkdXBsaWNhdGVzXG4gIGF3YWl0IHBpLmZpcmUoXCJtb2RlbF9zZWxlY3RcIiwge1xuICAgIHR5cGU6IFwibW9kZWxfc2VsZWN0XCIsXG4gICAgbW9kZWw6IHsgcHJvdmlkZXI6IFwib3BlbmFpXCIsIG5hbWU6IFwiZ3B0LTRvXCIgfSxcbiAgICBwcmV2aW91c01vZGVsOiB7IHByb3ZpZGVyOiBcImFudGhyb3BpY1wiLCBuYW1lOiBcImNsYXVkZS1zb25uZXQtNC02XCIgfSxcbiAgICBzb3VyY2U6IFwic2V0XCIsXG4gIH0pO1xuICBhY3RpdmUgPSBwaS5nZXRBY3RpdmVUb29scygpO1xuICBhc3NlcnQuZXF1YWwoXG4gICAgYWN0aXZlLmZpbHRlcigodCkgPT4gdCA9PT0gXCJzZWFyY2gtdGhlLXdlYlwiKS5sZW5ndGgsIDEsXG4gICAgXCJzZWFyY2gtdGhlLXdlYiBleGFjdGx5IG9uY2UgYWZ0ZXIgc2Vjb25kIHJlLWVuYWJsZSAobm8gZHVwbGljYXRlcylcIlxuICApO1xuICBhc3NlcnQuZXF1YWwoXG4gICAgYWN0aXZlLmZpbHRlcigodCkgPT4gdCA9PT0gXCJzZWFyY2hfYW5kX3JlYWRcIikubGVuZ3RoLCAxLFxuICAgIFwic2VhcmNoX2FuZF9yZWFkIGV4YWN0bHkgb25jZSAobm8gZHVwbGljYXRlcylcIlxuICApO1xuICBhc3NlcnQuZXF1YWwoXG4gICAgYWN0aXZlLmZpbHRlcigodCkgPT4gdCA9PT0gXCJnb29nbGVfc2VhcmNoXCIpLmxlbmd0aCwgMSxcbiAgICBcImdvb2dsZV9zZWFyY2ggZXhhY3RseSBvbmNlIChubyBkdXBsaWNhdGVzKVwiXG4gICk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEJVRy0zIHJlZ3Jlc3Npb246IG1vY2sgZmlyZSgpIG11c3QgY2FsbCBhbGwgaGFuZGxlcnMsIG5vdCBqdXN0IGZpcnN0IFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwibW9jayBmaXJlKCkgY2FsbHMgYWxsIGhhbmRsZXJzIGZvciB0aGUgc2FtZSBldmVudFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHBpID0gY3JlYXRlTW9ja1BJKCk7XG4gIGNvbnN0IGNhbGxPcmRlcjogbnVtYmVyW10gPSBbXTtcblxuICAvLyBSZWdpc3RlciB0d28gaGFuZGxlcnMgZm9yIHRoZSBzYW1lIGV2ZW50XG4gIHBpLm9uKFwidGVzdF9ldmVudFwiLCBhc3luYyAoKSA9PiB7IGNhbGxPcmRlci5wdXNoKDEpOyByZXR1cm4gXCJmaXJzdFwiOyB9KTtcbiAgcGkub24oXCJ0ZXN0X2V2ZW50XCIsIGFzeW5jICgpID0+IHsgY2FsbE9yZGVyLnB1c2goMik7IHJldHVybiBcInNlY29uZFwiOyB9KTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBwaS5maXJlKFwidGVzdF9ldmVudFwiLCB7fSk7XG5cbiAgYXNzZXJ0LmRlZXBFcXVhbChjYWxsT3JkZXIsIFsxLCAyXSwgXCJCb3RoIGhhbmRsZXJzIHNob3VsZCBiZSBjYWxsZWRcIik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQsIFwic2Vjb25kXCIsIFwiU2hvdWxkIHJldHVybiBsYXN0IG5vbi11bmRlZmluZWQgcmVzdWx0XCIpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBCVUctNCByZWdyZXNzaW9uOiBubyBub3RpZmljYXRpb24gbm9pc2Ugb24gc2Vzc2lvbiByZXN0b3JlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwibW9kZWxfc2VsZWN0IHN1cHByZXNzZXMgJ05hdGl2ZSBzZWFyY2ggYWN0aXZlJyBub3RpZmljYXRpb24gb24gc2Vzc2lvbiByZXN0b3JlXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgcGkgPSBjcmVhdGVNb2NrUEkoKTtcbiAgcmVnaXN0ZXJOYXRpdmVTZWFyY2hIb29rcyhwaSk7XG5cbiAgYXdhaXQgcGkuZmlyZShcIm1vZGVsX3NlbGVjdFwiLCB7XG4gICAgdHlwZTogXCJtb2RlbF9zZWxlY3RcIixcbiAgICBtb2RlbDogeyBwcm92aWRlcjogXCJhbnRocm9waWNcIiwgYXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLCBuYW1lOiBcImNsYXVkZS1zb25uZXQtNC02XCIgfSxcbiAgICBwcmV2aW91c01vZGVsOiB1bmRlZmluZWQsXG4gICAgc291cmNlOiBcInJlc3RvcmVcIiwgIC8vIHNlc3Npb24gcmVzdG9yZSwgbm90IHVzZXIgYWN0aW9uXG4gIH0pO1xuXG4gIGNvbnN0IG5hdGl2ZU5vdGlmID0gcGkubm90aWZpY2F0aW9ucy5maW5kKFxuICAgIChuKSA9PiBuLm1lc3NhZ2UuaW5jbHVkZXMoXCJOYXRpdmUgQW50aHJvcGljIHdlYiBzZWFyY2ggYWN0aXZlXCIpXG4gICk7XG4gIGFzc2VydC5lcXVhbChcbiAgICBuYXRpdmVOb3RpZiwgdW5kZWZpbmVkLFxuICAgIFwiU2hvdWxkIE5PVCBzaG93ICdOYXRpdmUgc2VhcmNoIGFjdGl2ZScgb24gc2Vzc2lvbiByZXN0b3JlXCJcbiAgKTtcbn0pO1xuXG50ZXN0KFwibW9kZWxfc2VsZWN0IERPRVMgc2hvdyBub3RpZmljYXRpb24gb24gZXhwbGljaXQgdXNlciBzZXRcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBwaSA9IGNyZWF0ZU1vY2tQSSgpO1xuICByZWdpc3Rlck5hdGl2ZVNlYXJjaEhvb2tzKHBpKTtcblxuICBhd2FpdCBwaS5maXJlKFwibW9kZWxfc2VsZWN0XCIsIHtcbiAgICB0eXBlOiBcIm1vZGVsX3NlbGVjdFwiLFxuICAgIG1vZGVsOiB7IHByb3ZpZGVyOiBcImFudGhyb3BpY1wiLCBhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsIG5hbWU6IFwiY2xhdWRlLXNvbm5ldC00LTZcIiB9LFxuICAgIHByZXZpb3VzTW9kZWw6IHVuZGVmaW5lZCxcbiAgICBzb3VyY2U6IFwic2V0XCIsXG4gIH0pO1xuXG4gIGNvbnN0IG5hdGl2ZU5vdGlmID0gcGkubm90aWZpY2F0aW9ucy5maW5kKFxuICAgIChuKSA9PiBuLm1lc3NhZ2UuaW5jbHVkZXMoXCJOYXRpdmUgQW50aHJvcGljIHdlYiBzZWFyY2ggYWN0aXZlXCIpXG4gICk7XG4gIGFzc2VydC5vayhuYXRpdmVOb3RpZiwgXCJTaG91bGQgc2hvdyBub3RpZmljYXRpb24gb24gZXhwbGljaXQgJ3NldCcgc291cmNlXCIpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTZXNzaW9uLWxldmVsIHNlYXJjaCBidWRnZXQgKCMxMzA5KSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcInNlc3Npb24gc2VhcmNoIGJ1ZGdldDogbWF4X3VzZXMgZGVjcmVhc2VzIGFzIGhpc3RvcnkgYWNjdW11bGF0ZXMgc2VhcmNoIHJlc3VsdHNcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBwaSA9IGNyZWF0ZU1vY2tQSSgpO1xuICByZWdpc3Rlck5hdGl2ZVNlYXJjaEhvb2tzKHBpKTtcblxuICBhd2FpdCBwaS5maXJlKFwibW9kZWxfc2VsZWN0XCIsIHtcbiAgICB0eXBlOiBcIm1vZGVsX3NlbGVjdFwiLFxuICAgIG1vZGVsOiB7IHByb3ZpZGVyOiBcImFudGhyb3BpY1wiLCBhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsIG5hbWU6IFwiY2xhdWRlLXNvbm5ldC00LTZcIiB9LFxuICAgIHByZXZpb3VzTW9kZWw6IHVuZGVmaW5lZCxcbiAgICBzb3VyY2U6IFwic2V0XCIsXG4gIH0pO1xuXG4gIC8vIFNpbXVsYXRlIGEgY29udmVyc2F0aW9uIHdpdGggMTAgd2ViX3NlYXJjaF90b29sX3Jlc3VsdCBibG9ja3MgaW4gaGlzdG9yeVxuICBjb25zdCBtZXNzYWdlczogYW55W10gPSBbXG4gICAgeyByb2xlOiBcInVzZXJcIiwgY29udGVudDogXCJyZXNlYXJjaCB0aGlzIHRvcGljXCIgfSxcbiAgICB7XG4gICAgICByb2xlOiBcImFzc2lzdGFudFwiLFxuICAgICAgY29udGVudDogW1xuICAgICAgICB7IHR5cGU6IFwid2ViX3NlYXJjaF90b29sX3Jlc3VsdFwiLCB0b29sX3VzZV9pZDogXCJ3czFcIiwgY29udGVudDogW10gfSxcbiAgICAgICAgeyB0eXBlOiBcIndlYl9zZWFyY2hfdG9vbF9yZXN1bHRcIiwgdG9vbF91c2VfaWQ6IFwid3MyXCIsIGNvbnRlbnQ6IFtdIH0sXG4gICAgICAgIHsgdHlwZTogXCJ3ZWJfc2VhcmNoX3Rvb2xfcmVzdWx0XCIsIHRvb2xfdXNlX2lkOiBcIndzM1wiLCBjb250ZW50OiBbXSB9LFxuICAgICAgICB7IHR5cGU6IFwid2ViX3NlYXJjaF90b29sX3Jlc3VsdFwiLCB0b29sX3VzZV9pZDogXCJ3czRcIiwgY29udGVudDogW10gfSxcbiAgICAgICAgeyB0eXBlOiBcIndlYl9zZWFyY2hfdG9vbF9yZXN1bHRcIiwgdG9vbF91c2VfaWQ6IFwid3M1XCIsIGNvbnRlbnQ6IFtdIH0sXG4gICAgICAgIHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiSGVyZSBhcmUgc29tZSByZXN1bHRzLi4uXCIgfSxcbiAgICAgIF0sXG4gICAgfSxcbiAgICB7IHJvbGU6IFwidXNlclwiLCBjb250ZW50OiBcImNvbnRpbnVlXCIgfSxcbiAgICB7XG4gICAgICByb2xlOiBcImFzc2lzdGFudFwiLFxuICAgICAgY29udGVudDogW1xuICAgICAgICB7IHR5cGU6IFwid2ViX3NlYXJjaF90b29sX3Jlc3VsdFwiLCB0b29sX3VzZV9pZDogXCJ3czZcIiwgY29udGVudDogW10gfSxcbiAgICAgICAgeyB0eXBlOiBcIndlYl9zZWFyY2hfdG9vbF9yZXN1bHRcIiwgdG9vbF91c2VfaWQ6IFwid3M3XCIsIGNvbnRlbnQ6IFtdIH0sXG4gICAgICAgIHsgdHlwZTogXCJ3ZWJfc2VhcmNoX3Rvb2xfcmVzdWx0XCIsIHRvb2xfdXNlX2lkOiBcIndzOFwiLCBjb250ZW50OiBbXSB9LFxuICAgICAgICB7IHR5cGU6IFwid2ViX3NlYXJjaF90b29sX3Jlc3VsdFwiLCB0b29sX3VzZV9pZDogXCJ3czlcIiwgY29udGVudDogW10gfSxcbiAgICAgICAgeyB0eXBlOiBcIndlYl9zZWFyY2hfdG9vbF9yZXN1bHRcIiwgdG9vbF91c2VfaWQ6IFwid3MxMFwiLCBjb250ZW50OiBbXSB9LFxuICAgICAgICB7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIk1vcmUgcmVzdWx0cy4uLlwiIH0sXG4gICAgICBdLFxuICAgIH0sXG4gICAgeyByb2xlOiBcInVzZXJcIiwgY29udGVudDogXCJrZWVwIGdvaW5nXCIgfSxcbiAgXTtcblxuICBjb25zdCBwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICBtb2RlbDogXCJjbGF1ZGUtc29ubmV0LTQtNi0yMDI1MDUxNFwiLFxuICAgIHRvb2xzOiBbeyBuYW1lOiBcImJhc2hcIiwgdHlwZTogXCJjdXN0b21cIiB9XSxcbiAgICBtZXNzYWdlcyxcbiAgfTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBwaS5maXJlKFwiYmVmb3JlX3Byb3ZpZGVyX3JlcXVlc3RcIiwge1xuICAgIHR5cGU6IFwiYmVmb3JlX3Byb3ZpZGVyX3JlcXVlc3RcIixcbiAgICBwYXlsb2FkLFxuICB9KTtcblxuICBjb25zdCB0b29scyA9ICgocmVzdWx0IGFzIGFueSk/LnRvb2xzID8/IHBheWxvYWQudG9vbHMpIGFzIGFueVtdO1xuICBjb25zdCBuYXRpdmVUb29sID0gdG9vbHMuZmluZCgodDogYW55KSA9PiB0LnR5cGUgPT09IFwid2ViX3NlYXJjaF8yMDI1MDMwNVwiKTtcbiAgYXNzZXJ0Lm9rKG5hdGl2ZVRvb2wsIFwiU2hvdWxkIHN0aWxsIGluamVjdCB3ZWJfc2VhcmNoIHdoZW4gYnVkZ2V0IHJlbWFpbmluZ1wiKTtcbiAgLy8gMTUgLSAxMCA9IDUgcmVtYWluaW5nLCBtaW4oNSwgNSkgPSA1XG4gIGFzc2VydC5lcXVhbChuYXRpdmVUb29sLm1heF91c2VzLCA1LCBcIlNob3VsZCBjYXAgYXQgbWluKDUsIHJlbWFpbmluZylcIik7XG59KTtcblxudGVzdChcInNlc3Npb24gc2VhcmNoIGJ1ZGdldDogcmVkdWNlcyBtYXhfdXNlcyB3aGVuIGNsb3NlIHRvIGxpbWl0XCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgcGkgPSBjcmVhdGVNb2NrUEkoKTtcbiAgcmVnaXN0ZXJOYXRpdmVTZWFyY2hIb29rcyhwaSk7XG5cbiAgYXdhaXQgcGkuZmlyZShcIm1vZGVsX3NlbGVjdFwiLCB7XG4gICAgdHlwZTogXCJtb2RlbF9zZWxlY3RcIixcbiAgICBtb2RlbDogeyBwcm92aWRlcjogXCJhbnRocm9waWNcIiwgYXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLCBuYW1lOiBcImNsYXVkZS1zb25uZXQtNC02XCIgfSxcbiAgICBwcmV2aW91c01vZGVsOiB1bmRlZmluZWQsXG4gICAgc291cmNlOiBcInNldFwiLFxuICB9KTtcblxuICAvLyAxMyBzZWFyY2ggcmVzdWx0cyBpbiBoaXN0b3J5IFx1MjE5MiBvbmx5IDIgcmVtYWluaW5nXG4gIGNvbnN0IHNlYXJjaEJsb2NrcyA9IEFycmF5LmZyb20oeyBsZW5ndGg6IDEzIH0sIChfLCBpKSA9PiAoe1xuICAgIHR5cGU6IFwid2ViX3NlYXJjaF90b29sX3Jlc3VsdFwiLFxuICAgIHRvb2xfdXNlX2lkOiBgd3Mke2l9YCxcbiAgICBjb250ZW50OiBbXSxcbiAgfSkpO1xuXG4gIGNvbnN0IG1lc3NhZ2VzOiBhbnlbXSA9IFtcbiAgICB7IHJvbGU6IFwidXNlclwiLCBjb250ZW50OiBcInJlc2VhcmNoXCIgfSxcbiAgICB7IHJvbGU6IFwiYXNzaXN0YW50XCIsIGNvbnRlbnQ6IFsuLi5zZWFyY2hCbG9ja3MsIHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwicmVzdWx0c1wiIH1dIH0sXG4gICAgeyByb2xlOiBcInVzZXJcIiwgY29udGVudDogXCJtb3JlXCIgfSxcbiAgXTtcblxuICBjb25zdCBwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICBtb2RlbDogXCJjbGF1ZGUtc29ubmV0LTQtNi0yMDI1MDUxNFwiLFxuICAgIHRvb2xzOiBbeyBuYW1lOiBcImJhc2hcIiwgdHlwZTogXCJjdXN0b21cIiB9XSxcbiAgICBtZXNzYWdlcyxcbiAgfTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBwaS5maXJlKFwiYmVmb3JlX3Byb3ZpZGVyX3JlcXVlc3RcIiwge1xuICAgIHR5cGU6IFwiYmVmb3JlX3Byb3ZpZGVyX3JlcXVlc3RcIixcbiAgICBwYXlsb2FkLFxuICB9KTtcblxuICBjb25zdCB0b29scyA9ICgocmVzdWx0IGFzIGFueSk/LnRvb2xzID8/IHBheWxvYWQudG9vbHMpIGFzIGFueVtdO1xuICBjb25zdCBuYXRpdmVUb29sID0gdG9vbHMuZmluZCgodDogYW55KSA9PiB0LnR5cGUgPT09IFwid2ViX3NlYXJjaF8yMDI1MDMwNVwiKTtcbiAgYXNzZXJ0Lm9rKG5hdGl2ZVRvb2wsIFwiU2hvdWxkIHN0aWxsIGluamVjdCB3aGVuIGJ1ZGdldCA+IDBcIik7XG4gIC8vIDE1IC0gMTMgPSAyIHJlbWFpbmluZ1xuICBhc3NlcnQuZXF1YWwobmF0aXZlVG9vbC5tYXhfdXNlcywgMiwgXCJTaG91bGQgcmVkdWNlIG1heF91c2VzIHRvIHJlbWFpbmluZyBidWRnZXRcIik7XG59KTtcblxudGVzdChcInNlc3Npb24gc2VhcmNoIGJ1ZGdldDogb21pdHMgd2ViX3NlYXJjaCB0b29sIHdoZW4gYnVkZ2V0IGV4aGF1c3RlZFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHBpID0gY3JlYXRlTW9ja1BJKCk7XG4gIHJlZ2lzdGVyTmF0aXZlU2VhcmNoSG9va3MocGkpO1xuXG4gIGF3YWl0IHBpLmZpcmUoXCJtb2RlbF9zZWxlY3RcIiwge1xuICAgIHR5cGU6IFwibW9kZWxfc2VsZWN0XCIsXG4gICAgbW9kZWw6IHsgcHJvdmlkZXI6IFwiYW50aHJvcGljXCIsIGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIiwgbmFtZTogXCJjbGF1ZGUtc29ubmV0LTQtNlwiIH0sXG4gICAgcHJldmlvdXNNb2RlbDogdW5kZWZpbmVkLFxuICAgIHNvdXJjZTogXCJzZXRcIixcbiAgfSk7XG5cbiAgLy8gMTUrIHNlYXJjaCByZXN1bHRzIGluIGhpc3RvcnkgXHUyMTkyIGJ1ZGdldCBleGhhdXN0ZWRcbiAgY29uc3Qgc2VhcmNoQmxvY2tzID0gQXJyYXkuZnJvbSh7IGxlbmd0aDogTUFYX05BVElWRV9TRUFSQ0hFU19QRVJfU0VTU0lPTiB9LCAoXywgaSkgPT4gKHtcbiAgICB0eXBlOiBcIndlYl9zZWFyY2hfdG9vbF9yZXN1bHRcIixcbiAgICB0b29sX3VzZV9pZDogYHdzJHtpfWAsXG4gICAgY29udGVudDogW10sXG4gIH0pKTtcblxuICBjb25zdCBtZXNzYWdlczogYW55W10gPSBbXG4gICAgeyByb2xlOiBcInVzZXJcIiwgY29udGVudDogXCJyZXNlYXJjaFwiIH0sXG4gICAgeyByb2xlOiBcImFzc2lzdGFudFwiLCBjb250ZW50OiBbLi4uc2VhcmNoQmxvY2tzLCB7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcInJlc3VsdHNcIiB9XSB9LFxuICAgIHsgcm9sZTogXCJ1c2VyXCIsIGNvbnRlbnQ6IFwibW9yZVwiIH0sXG4gIF07XG5cbiAgY29uc3QgcGF5bG9hZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgbW9kZWw6IFwiY2xhdWRlLXNvbm5ldC00LTYtMjAyNTA1MTRcIixcbiAgICB0b29sczogW3sgbmFtZTogXCJiYXNoXCIsIHR5cGU6IFwiY3VzdG9tXCIgfV0sXG4gICAgbWVzc2FnZXMsXG4gIH07XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcGkuZmlyZShcImJlZm9yZV9wcm92aWRlcl9yZXF1ZXN0XCIsIHtcbiAgICB0eXBlOiBcImJlZm9yZV9wcm92aWRlcl9yZXF1ZXN0XCIsXG4gICAgcGF5bG9hZCxcbiAgfSk7XG5cbiAgY29uc3QgdG9vbHMgPSAoKHJlc3VsdCBhcyBhbnkpPy50b29scyA/PyBwYXlsb2FkLnRvb2xzKSBhcyBhbnlbXTtcbiAgY29uc3QgbmF0aXZlVG9vbCA9IHRvb2xzLmZpbmQoKHQ6IGFueSkgPT4gdC50eXBlID09PSBcIndlYl9zZWFyY2hfMjAyNTAzMDVcIik7XG4gIGFzc2VydC5lcXVhbChuYXRpdmVUb29sLCB1bmRlZmluZWQsIFwiU2hvdWxkIE5PVCBpbmplY3Qgd2ViX3NlYXJjaCB3aGVuIGJ1ZGdldCBleGhhdXN0ZWQgKCMxMzA5KVwiKTtcbiAgLy8gT3RoZXIgdG9vbHMgc2hvdWxkIHJlbWFpblxuICBhc3NlcnQub2sodG9vbHMuc29tZSgodDogYW55KSA9PiB0Lm5hbWUgPT09IFwiYmFzaFwiKSwgXCJOb24tc2VhcmNoIHRvb2xzIHNob3VsZCByZW1haW5cIik7XG59KTtcblxudGVzdChcInNlc3Npb24gc2VhcmNoIGJ1ZGdldDogcmVzZXRzIG9uIHNlc3Npb25fc3RhcnRcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBwaSA9IGNyZWF0ZU1vY2tQSSgpO1xuICByZWdpc3Rlck5hdGl2ZVNlYXJjaEhvb2tzKHBpKTtcblxuICBhd2FpdCBwaS5maXJlKFwibW9kZWxfc2VsZWN0XCIsIHtcbiAgICB0eXBlOiBcIm1vZGVsX3NlbGVjdFwiLFxuICAgIG1vZGVsOiB7IHByb3ZpZGVyOiBcImFudGhyb3BpY1wiLCBhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsIG5hbWU6IFwiY2xhdWRlLXNvbm5ldC00LTZcIiB9LFxuICAgIHByZXZpb3VzTW9kZWw6IHVuZGVmaW5lZCxcbiAgICBzb3VyY2U6IFwic2V0XCIsXG4gIH0pO1xuXG4gIC8vIEZpcnN0IHNlc3Npb246IGV4aGF1c3QgYnVkZ2V0XG4gIGNvbnN0IHNlYXJjaEJsb2NrcyA9IEFycmF5LmZyb20oeyBsZW5ndGg6IE1BWF9OQVRJVkVfU0VBUkNIRVNfUEVSX1NFU1NJT04gfSwgKF8sIGkpID0+ICh7XG4gICAgdHlwZTogXCJ3ZWJfc2VhcmNoX3Rvb2xfcmVzdWx0XCIsXG4gICAgdG9vbF91c2VfaWQ6IGB3cyR7aX1gLFxuICAgIGNvbnRlbnQ6IFtdLFxuICB9KSk7XG5cbiAgbGV0IHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgIG1vZGVsOiBcImNsYXVkZS1zb25uZXQtNC02LTIwMjUwNTE0XCIsXG4gICAgdG9vbHM6IFt7IG5hbWU6IFwiYmFzaFwiLCB0eXBlOiBcImN1c3RvbVwiIH1dLFxuICAgIG1lc3NhZ2VzOiBbXG4gICAgICB7IHJvbGU6IFwidXNlclwiLCBjb250ZW50OiBcInJlc2VhcmNoXCIgfSxcbiAgICAgIHsgcm9sZTogXCJhc3Npc3RhbnRcIiwgY29udGVudDogWy4uLnNlYXJjaEJsb2Nrc10gfSxcbiAgICAgIHsgcm9sZTogXCJ1c2VyXCIsIGNvbnRlbnQ6IFwibW9yZVwiIH0sXG4gICAgXSxcbiAgfTtcblxuICBhd2FpdCBwaS5maXJlKFwiYmVmb3JlX3Byb3ZpZGVyX3JlcXVlc3RcIiwgeyB0eXBlOiBcImJlZm9yZV9wcm92aWRlcl9yZXF1ZXN0XCIsIHBheWxvYWQgfSk7XG4gIGxldCB0b29scyA9IChwYXlsb2FkLnRvb2xzIGFzIGFueVtdKTtcbiAgYXNzZXJ0Lm9rKCF0b29scy5zb21lKCh0OiBhbnkpID0+IHQudHlwZSA9PT0gXCJ3ZWJfc2VhcmNoXzIwMjUwMzA1XCIpLCBcIkJ1ZGdldCBzaG91bGQgYmUgZXhoYXVzdGVkXCIpO1xuXG4gIC8vIE5ldyBzZXNzaW9uIHN0YXJ0cyBcdTIwMTQgY291bnRlciByZXNldHNcbiAgYXdhaXQgcGkuZmlyZShcInNlc3Npb25fc3RhcnRcIiwgeyB0eXBlOiBcInNlc3Npb25fc3RhcnRcIiB9KTtcblxuICAvLyBOZXcgcmVxdWVzdCB3aXRoIG5vIGhpc3RvcnkgXHUyMDE0IGZ1bGwgYnVkZ2V0IGF2YWlsYWJsZVxuICBwYXlsb2FkID0ge1xuICAgIG1vZGVsOiBcImNsYXVkZS1zb25uZXQtNC02LTIwMjUwNTE0XCIsXG4gICAgdG9vbHM6IFt7IG5hbWU6IFwiYmFzaFwiLCB0eXBlOiBcImN1c3RvbVwiIH1dLFxuICAgIG1lc3NhZ2VzOiBbeyByb2xlOiBcInVzZXJcIiwgY29udGVudDogXCJuZXcgcmVzZWFyY2hcIiB9XSxcbiAgfTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBwaS5maXJlKFwiYmVmb3JlX3Byb3ZpZGVyX3JlcXVlc3RcIiwgeyB0eXBlOiBcImJlZm9yZV9wcm92aWRlcl9yZXF1ZXN0XCIsIHBheWxvYWQgfSk7XG4gIHRvb2xzID0gKChyZXN1bHQgYXMgYW55KT8udG9vbHMgPz8gcGF5bG9hZC50b29scykgYXMgYW55W107XG4gIGNvbnN0IG5hdGl2ZVRvb2wgPSB0b29scy5maW5kKCh0OiBhbnkpID0+IHQudHlwZSA9PT0gXCJ3ZWJfc2VhcmNoXzIwMjUwMzA1XCIpO1xuICBhc3NlcnQub2sobmF0aXZlVG9vbCwgXCJTaG91bGQgaW5qZWN0IHdlYl9zZWFyY2ggYWZ0ZXIgc2Vzc2lvbiByZXNldFwiKTtcbiAgYXNzZXJ0LmVxdWFsKG5hdGl2ZVRvb2wubWF4X3VzZXMsIDUsIFwiU2hvdWxkIGhhdmUgZnVsbCBwZXItdHVybiBidWRnZXQgYWZ0ZXIgcmVzZXRcIik7XG59KTtcblxudGVzdChcIk1BWF9OQVRJVkVfU0VBUkNIRVNfUEVSX1NFU1NJT04gaXMgZXhwb3J0ZWQgYW5kIGVxdWFscyAxNVwiLCAoKSA9PiB7XG4gIGFzc2VydC5lcXVhbChNQVhfTkFUSVZFX1NFQVJDSEVTX1BFUl9TRVNTSU9OLCAxNSwgXCJTZXNzaW9uIGJ1ZGdldCBzaG91bGQgYmUgMTUgKCMxMzA5KVwiKTtcbn0pO1xuXG50ZXN0KFwic2Vzc2lvbiBzZWFyY2ggYnVkZ2V0OiBzdXJ2aXZlcyBjb250ZXh0IGNvbXBhY3Rpb24gKGhpZ2gtd2F0ZXIgbWFyaylcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBwaSA9IGNyZWF0ZU1vY2tQSSgpO1xuICByZWdpc3Rlck5hdGl2ZVNlYXJjaEhvb2tzKHBpKTtcblxuICBhd2FpdCBwaS5maXJlKFwibW9kZWxfc2VsZWN0XCIsIHtcbiAgICB0eXBlOiBcIm1vZGVsX3NlbGVjdFwiLFxuICAgIG1vZGVsOiB7IHByb3ZpZGVyOiBcImFudGhyb3BpY1wiLCBhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsIG5hbWU6IFwiY2xhdWRlLXNvbm5ldC00LTZcIiB9LFxuICAgIHByZXZpb3VzTW9kZWw6IHVuZGVmaW5lZCxcbiAgICBzb3VyY2U6IFwic2V0XCIsXG4gIH0pO1xuXG4gIC8vIEZpcnN0IHJlcXVlc3Q6IGhpc3RvcnkgaGFzIDEyIHdlYl9zZWFyY2hfdG9vbF9yZXN1bHQgYmxvY2tzXG4gIGNvbnN0IHNlYXJjaEJsb2NrcyA9IEFycmF5LmZyb20oeyBsZW5ndGg6IDEyIH0sIChfLCBpKSA9PiAoe1xuICAgIHR5cGU6IFwid2ViX3NlYXJjaF90b29sX3Jlc3VsdFwiLFxuICAgIHRvb2xfdXNlX2lkOiBgd3Mke2l9YCxcbiAgICBjb250ZW50OiBbXSxcbiAgfSkpO1xuXG4gIGxldCBwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICBtb2RlbDogXCJjbGF1ZGUtc29ubmV0LTQtNi0yMDI1MDUxNFwiLFxuICAgIHRvb2xzOiBbeyBuYW1lOiBcImJhc2hcIiwgdHlwZTogXCJjdXN0b21cIiB9XSxcbiAgICBtZXNzYWdlczogW3sgcm9sZTogXCJ1c2VyXCIsIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcInNlYXJjaFwiIH0sIC4uLnNlYXJjaEJsb2Nrc10gfV0sXG4gIH07XG5cbiAgYXdhaXQgcGkuZmlyZShcImJlZm9yZV9wcm92aWRlcl9yZXF1ZXN0XCIsIHsgdHlwZTogXCJiZWZvcmVfcHJvdmlkZXJfcmVxdWVzdFwiLCBwYXlsb2FkIH0pO1xuICBsZXQgdG9vbHMgPSBwYXlsb2FkLnRvb2xzIGFzIGFueVtdO1xuICBsZXQgbmF0aXZlVG9vbCA9IHRvb2xzLmZpbmQoKHQ6IGFueSkgPT4gdC50eXBlID09PSBcIndlYl9zZWFyY2hfMjAyNTAzMDVcIik7XG4gIGFzc2VydC5vayhuYXRpdmVUb29sLCBcIlNob3VsZCBzdGlsbCBpbmplY3Qgd2ViX3NlYXJjaCB3aXRoIDEyLzE1IHVzZWRcIik7XG4gIGFzc2VydC5lcXVhbChuYXRpdmVUb29sLm1heF91c2VzLCAzLCBcIlNob3VsZCBoYXZlIDMgcmVtYWluaW5nICgxNSAtIDEyKVwiKTtcblxuICAvLyBTZWNvbmQgcmVxdWVzdDogY29udGV4dCB3YXMgY29tcGFjdGVkIFx1MjAxNCBzZWFyY2ggYmxvY2tzIGdvbmUgZnJvbSBoaXN0b3J5LlxuICAvLyBXaXRob3V0IGhpZ2gtd2F0ZXIgbWFyaywgdGhlIGJ1ZGdldCB3b3VsZCByZXNldCB0byAxNS5cbiAgcGF5bG9hZCA9IHtcbiAgICBtb2RlbDogXCJjbGF1ZGUtc29ubmV0LTQtNi0yMDI1MDUxNFwiLFxuICAgIHRvb2xzOiBbeyBuYW1lOiBcImJhc2hcIiwgdHlwZTogXCJjdXN0b21cIiB9XSxcbiAgICBtZXNzYWdlczogW3sgcm9sZTogXCJ1c2VyXCIsIGNvbnRlbnQ6IFwiY29tcGFjdGVkIGNvbnRleHQgXHUyMDE0IG5vIHNlYXJjaCBibG9ja3NcIiB9XSxcbiAgfTtcblxuICBhd2FpdCBwaS5maXJlKFwiYmVmb3JlX3Byb3ZpZGVyX3JlcXVlc3RcIiwgeyB0eXBlOiBcImJlZm9yZV9wcm92aWRlcl9yZXF1ZXN0XCIsIHBheWxvYWQgfSk7XG4gIHRvb2xzID0gcGF5bG9hZC50b29scyBhcyBhbnlbXTtcbiAgbmF0aXZlVG9vbCA9IHRvb2xzLmZpbmQoKHQ6IGFueSkgPT4gdC50eXBlID09PSBcIndlYl9zZWFyY2hfMjAyNTAzMDVcIik7XG4gIGFzc2VydC5vayhuYXRpdmVUb29sLCBcIlNob3VsZCBzdGlsbCBpbmplY3Qgd2ViX3NlYXJjaCB3aXRoIDEyLzE1IHVzZWQgKGhpZ2gtd2F0ZXIgbWFyaylcIik7XG4gIGFzc2VydC5lcXVhbChuYXRpdmVUb29sLm1heF91c2VzLCAzLCBcIkhpZ2gtd2F0ZXIgbWFyayBzaG91bGQgcHJlc2VydmUgMTIgXHUyMDE0IG9ubHkgMyByZW1haW5pbmdcIik7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHN0cmlwVGhpbmtpbmdGcm9tSGlzdG9yeSB0ZXN0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcInN0cmlwVGhpbmtpbmdGcm9tSGlzdG9yeSByZW1vdmVzIHRoaW5raW5nIGZyb20gZWFybGllciBhc3Npc3RhbnQgbWVzc2FnZXNcIiwgKCkgPT4ge1xuICBjb25zdCBtZXNzYWdlczogYW55W10gPSBbXG4gICAgeyByb2xlOiBcInVzZXJcIiwgY29udGVudDogXCJoZWxsb1wiIH0sXG4gICAge1xuICAgICAgcm9sZTogXCJhc3Npc3RhbnRcIixcbiAgICAgIGNvbnRlbnQ6IFtcbiAgICAgICAgeyB0eXBlOiBcInRoaW5raW5nXCIsIHRoaW5raW5nOiBcImhtbVwiLCBzaWduYXR1cmU6IFwic2lnMVwiIH0sXG4gICAgICAgIHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiSGkgdGhlcmVcIiB9LFxuICAgICAgXSxcbiAgICB9LFxuICAgIHsgcm9sZTogXCJ1c2VyXCIsIGNvbnRlbnQ6IFwic2VhcmNoIHNvbWV0aGluZ1wiIH0sXG4gIF07XG5cbiAgc3RyaXBUaGlua2luZ0Zyb21IaXN0b3J5KG1lc3NhZ2VzKTtcblxuICAvLyBGaXJzdCBhc3Npc3RhbnQgbWVzc2FnZSAobm90IGxhdGVzdCkgXHUyMDE0IHRoaW5raW5nIHN0cmlwcGVkXG4gIGFzc2VydC5lcXVhbChtZXNzYWdlc1sxXS5jb250ZW50Lmxlbmd0aCwgMSk7XG4gIGFzc2VydC5lcXVhbChtZXNzYWdlc1sxXS5jb250ZW50WzBdLnR5cGUsIFwidGV4dFwiKTtcbn0pO1xuXG50ZXN0KFwic3RyaXBUaGlua2luZ0Zyb21IaXN0b3J5IHN0cmlwcyB0aGlua2luZyBmcm9tIGFsbCBhc3Npc3RhbnQgbWVzc2FnZXNcIiwgKCkgPT4ge1xuICBjb25zdCBtZXNzYWdlczogYW55W10gPSBbXG4gICAgeyByb2xlOiBcInVzZXJcIiwgY29udGVudDogXCJoZWxsb1wiIH0sXG4gICAge1xuICAgICAgcm9sZTogXCJhc3Npc3RhbnRcIixcbiAgICAgIGNvbnRlbnQ6IFtcbiAgICAgICAgeyB0eXBlOiBcInRoaW5raW5nXCIsIHRoaW5raW5nOiBcImZpcnN0IHRob3VnaHRcIiwgc2lnbmF0dXJlOiBcInNpZzFcIiB9LFxuICAgICAgICB7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcInJlc3BvbnNlIDFcIiB9LFxuICAgICAgXSxcbiAgICB9LFxuICAgIHsgcm9sZTogXCJ1c2VyXCIsIGNvbnRlbnQ6IFwiZm9sbG93IHVwXCIgfSxcbiAgICB7XG4gICAgICByb2xlOiBcImFzc2lzdGFudFwiLFxuICAgICAgY29udGVudDogW1xuICAgICAgICB7IHR5cGU6IFwidGhpbmtpbmdcIiwgdGhpbmtpbmc6IFwic2Vjb25kIHRob3VnaHRcIiwgc2lnbmF0dXJlOiBcInNpZzJcIiB9LFxuICAgICAgICB7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcInJlc3BvbnNlIDJcIiB9LFxuICAgICAgXSxcbiAgICB9LFxuICAgIHsgcm9sZTogXCJ1c2VyXCIsIGNvbnRlbnQ6IFwiYW5vdGhlciBxdWVzdGlvblwiIH0sXG4gIF07XG5cbiAgc3RyaXBUaGlua2luZ0Zyb21IaXN0b3J5KG1lc3NhZ2VzKTtcblxuICAvLyBCb3RoIGFzc2lzdGFudCBtZXNzYWdlcyBcdTIwMTQgdGhpbmtpbmcgc3RyaXBwZWRcbiAgYXNzZXJ0LmVxdWFsKG1lc3NhZ2VzWzFdLmNvbnRlbnQubGVuZ3RoLCAxKTtcbiAgYXNzZXJ0LmVxdWFsKG1lc3NhZ2VzWzFdLmNvbnRlbnRbMF0udHlwZSwgXCJ0ZXh0XCIpO1xuXG4gIGFzc2VydC5lcXVhbChtZXNzYWdlc1szXS5jb250ZW50Lmxlbmd0aCwgMSk7XG4gIGFzc2VydC5lcXVhbChtZXNzYWdlc1szXS5jb250ZW50WzBdLnR5cGUsIFwidGV4dFwiKTtcbn0pO1xuXG50ZXN0KFwic3RyaXBUaGlua2luZ0Zyb21IaXN0b3J5IHJlbW92ZXMgcmVkYWN0ZWRfdGhpbmtpbmcgdG9vXCIsICgpID0+IHtcbiAgY29uc3QgbWVzc2FnZXM6IGFueVtdID0gW1xuICAgIHsgcm9sZTogXCJ1c2VyXCIsIGNvbnRlbnQ6IFwiaGVsbG9cIiB9LFxuICAgIHtcbiAgICAgIHJvbGU6IFwiYXNzaXN0YW50XCIsXG4gICAgICBjb250ZW50OiBbXG4gICAgICAgIHsgdHlwZTogXCJyZWRhY3RlZF90aGlua2luZ1wiLCBkYXRhOiBcIm9wYXF1ZVwiIH0sXG4gICAgICAgIHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwicmVzcG9uc2VcIiB9LFxuICAgICAgXSxcbiAgICB9LFxuICAgIHsgcm9sZTogXCJ1c2VyXCIsIGNvbnRlbnQ6IFwibmV4dFwiIH0sXG4gIF07XG5cbiAgc3RyaXBUaGlua2luZ0Zyb21IaXN0b3J5KG1lc3NhZ2VzKTtcblxuICBhc3NlcnQuZXF1YWwobWVzc2FnZXNbMV0uY29udGVudC5sZW5ndGgsIDEpO1xuICBhc3NlcnQuZXF1YWwobWVzc2FnZXNbMV0uY29udGVudFswXS50eXBlLCBcInRleHRcIik7XG59KTtcblxudGVzdChcInN0cmlwVGhpbmtpbmdGcm9tSGlzdG9yeSBzdHJpcHMgZXZlbiBzaW5nbGUgYXNzaXN0YW50IG1lc3NhZ2VcIiwgKCkgPT4ge1xuICBjb25zdCBtZXNzYWdlczogYW55W10gPSBbXG4gICAgeyByb2xlOiBcInVzZXJcIiwgY29udGVudDogXCJoZWxsb1wiIH0sXG4gICAge1xuICAgICAgcm9sZTogXCJhc3Npc3RhbnRcIixcbiAgICAgIGNvbnRlbnQ6IFtcbiAgICAgICAgeyB0eXBlOiBcInRoaW5raW5nXCIsIHRoaW5raW5nOiBcInRob3VnaHRcIiwgc2lnbmF0dXJlOiBcInNpZ1wiIH0sXG4gICAgICAgIHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwicmVzcG9uc2VcIiB9LFxuICAgICAgXSxcbiAgICB9LFxuICAgIHsgcm9sZTogXCJ1c2VyXCIsIGNvbnRlbnQ6IFwiZm9sbG93IHVwXCIgfSxcbiAgXTtcblxuICBzdHJpcFRoaW5raW5nRnJvbUhpc3RvcnkobWVzc2FnZXMpO1xuXG4gIC8vIFRoaW5raW5nIHN0cmlwcGVkIFx1MjAxNCBhbGwgYXNzaXN0YW50IG1lc3NhZ2VzIGFyZSBmcm9tIHN0b3JlZCBoaXN0b3J5XG4gIGFzc2VydC5lcXVhbChtZXNzYWdlc1sxXS5jb250ZW50Lmxlbmd0aCwgMSk7XG4gIGFzc2VydC5lcXVhbChtZXNzYWdlc1sxXS5jb250ZW50WzBdLnR5cGUsIFwidGV4dFwiKTtcbn0pO1xuXG50ZXN0KFwic3RyaXBUaGlua2luZ0Zyb21IaXN0b3J5IGhhbmRsZXMgbm8gYXNzaXN0YW50IG1lc3NhZ2VzXCIsICgpID0+IHtcbiAgY29uc3QgbWVzc2FnZXM6IGFueVtdID0gW1xuICAgIHsgcm9sZTogXCJ1c2VyXCIsIGNvbnRlbnQ6IFwiaGVsbG9cIiB9LFxuICBdO1xuXG4gIC8vIFNob3VsZCBub3QgdGhyb3dcbiAgc3RyaXBUaGlua2luZ0Zyb21IaXN0b3J5KG1lc3NhZ2VzKTtcbiAgYXNzZXJ0LmVxdWFsKG1lc3NhZ2VzLmxlbmd0aCwgMSk7XG59KTtcblxudGVzdChcInN0cmlwVGhpbmtpbmdGcm9tSGlzdG9yeSBoYW5kbGVzIHN0cmluZyBjb250ZW50IChubyBhcnJheSlcIiwgKCkgPT4ge1xuICBjb25zdCBtZXNzYWdlczogYW55W10gPSBbXG4gICAgeyByb2xlOiBcInVzZXJcIiwgY29udGVudDogXCJoZWxsb1wiIH0sXG4gICAgeyByb2xlOiBcImFzc2lzdGFudFwiLCBjb250ZW50OiBcImp1c3QgYSBzdHJpbmdcIiB9LFxuICAgIHsgcm9sZTogXCJ1c2VyXCIsIGNvbnRlbnQ6IFwibmV4dFwiIH0sXG4gIF07XG5cbiAgLy8gU2hvdWxkIG5vdCB0aHJvdyBcdTIwMTQgc3RyaW5nIGNvbnRlbnQgaXMgc2tpcHBlZFxuICBzdHJpcFRoaW5raW5nRnJvbUhpc3RvcnkobWVzc2FnZXMpO1xuICBhc3NlcnQuZXF1YWwobWVzc2FnZXNbMV0uY29udGVudCwgXCJqdXN0IGEgc3RyaW5nXCIpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCAjNDQ3OCBzZXNzaW9uLXJlc3RvcmUgZWRnZTogbW9kZWxfc2VsZWN0IHN1cHByZXNzZWQgKHNhbWUgbW9kZWwpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiIzQ0NzggY2xhdWRlLWNvZGUgc2Vzc2lvbiByZXN0b3JlIHdpdGggbW9kZWxfc2VsZWN0IHN1cHByZXNzZWQgc3RpbGwgaW5qZWN0cyBuYXRpdmUgc2VhcmNoXCIsIGFzeW5jICgpID0+IHtcbiAgLy8gUmVncmVzc2lvbjogd2hlbiBhIHNlc3Npb24gaXMgcmVzdG9yZWQgYW5kIHRoZSByZXN0b3JlZCBtb2RlbCBlcXVhbHMgdGhlXG4gIC8vIGFjdGl2ZSBtb2RlbCwgYG1vZGVsc0FyZUVxdWFsYCBzdXBwcmVzc2VzIGBtb2RlbF9zZWxlY3RgLiBUaGVcbiAgLy8gYmVmb3JlX3Byb3ZpZGVyX3JlcXVlc3QgaGFuZGxlciBtdXN0IHN0aWxsIGRldGVjdCBBbnRocm9waWMgdmlhIHRoZVxuICAvLyBldmVudC5tb2RlbCBvYmplY3QncyBgYXBpYCBmaWVsZCBcdTIwMTQgbm90IGZhbGwgdGhyb3VnaCB0byB0aGUgbmFycm93ZXJcbiAgLy8gYHByb3ZpZGVyID09PSBcImFudGhyb3BpY1wiYCBmYWxsYmFjayB3aGljaCBtaXNzZXMgY2xhdWRlLWNvZGUuXG4gIGNvbnN0IHBpID0gY3JlYXRlTW9ja1BJKCk7XG4gIHJlZ2lzdGVyTmF0aXZlU2VhcmNoSG9va3MocGkpO1xuXG4gIC8vIE5PIG1vZGVsX3NlbGVjdCBmaXJlZCBcdTIwMTQgc2ltdWxhdGVzIHJlc3RvcmUtd2l0aC1zYW1lLW1vZGVsLlxuICBjb25zdCBwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICBtb2RlbDogXCJjbGF1ZGUtc29ubmV0LTQtNlwiLFxuICAgIHRvb2xzOiBbeyBuYW1lOiBcImJhc2hcIiwgdHlwZTogXCJjdXN0b21cIiB9XSxcbiAgfTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBwaS5maXJlKFwiYmVmb3JlX3Byb3ZpZGVyX3JlcXVlc3RcIiwge1xuICAgIHR5cGU6IFwiYmVmb3JlX3Byb3ZpZGVyX3JlcXVlc3RcIixcbiAgICBwYXlsb2FkLFxuICAgIC8vIEZ1bGwgTW9kZWwgb2JqZWN0IGNhcnJ5aW5nIGBhcGlgIFx1MjAxNCBtYXRjaGVzIHdoYXQgdGhlIHJ1bm5lciBmb3J3YXJkcyBhdCBydW50aW1lLlxuICAgIG1vZGVsOiB7IHByb3ZpZGVyOiBcImNsYXVkZS1jb2RlXCIsIGlkOiBcImNsYXVkZS1zb25uZXQtNC02XCIsIGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIiB9LFxuICB9KTtcblxuICBjb25zdCB0b29scyA9ICgocmVzdWx0IGFzIGFueSk/LnRvb2xzID8/IHBheWxvYWQudG9vbHMpIGFzIGFueVtdO1xuICBhc3NlcnQub2soXG4gICAgdG9vbHMuc29tZSgodCkgPT4gdC50eXBlID09PSBcIndlYl9zZWFyY2hfMjAyNTAzMDVcIiksXG4gICAgXCJTaG91bGQgaW5qZWN0IG5hdGl2ZSB3ZWJfc2VhcmNoIG9uIGNsYXVkZS1jb2RlIHJlc3RvcmUgZXZlbiB3aXRoIG1vZGVsX3NlbGVjdCBzdXBwcmVzc2VkXCIsXG4gICk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwICM0NDc4IHJlZ3Jlc3Npb246IEFudGhyb3BpYy1mcm9udGluZyB0cmFuc3BvcnRzIGluamVjdCBuYXRpdmUgc2VhcmNoIFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiIzQ0NzggY2xhdWRlLWNvZGUgT0F1dGggcHJvdmlkZXIgaW5qZWN0cyBuYXRpdmUgd2ViX3NlYXJjaFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHBpID0gY3JlYXRlTW9ja1BJKCk7XG4gIHJlZ2lzdGVyTmF0aXZlU2VhcmNoSG9va3MocGkpO1xuXG4gIGF3YWl0IHBpLmZpcmUoXCJtb2RlbF9zZWxlY3RcIiwge1xuICAgIHR5cGU6IFwibW9kZWxfc2VsZWN0XCIsXG4gICAgbW9kZWw6IHsgcHJvdmlkZXI6IFwiY2xhdWRlLWNvZGVcIiwgYXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLCBuYW1lOiBcImNsYXVkZS1zb25uZXQtNC02XCIgfSxcbiAgICBwcmV2aW91c01vZGVsOiB1bmRlZmluZWQsXG4gICAgc291cmNlOiBcInNldFwiLFxuICB9KTtcblxuICAvLyBNdXN0IE5PVCBlbWl0IHRoZSBzcGFtbXkgQnJhdmUgd2FybmluZ1xuICBjb25zdCB3YXJuaW5nID0gcGkubm90aWZpY2F0aW9ucy5maW5kKChuKSA9PiBuLmxldmVsID09PSBcIndhcm5pbmdcIik7XG4gIGFzc2VydC5lcXVhbCh3YXJuaW5nLCB1bmRlZmluZWQsIFwiU2hvdWxkIG5vdCBlbWl0IEJyYXZlIHdhcm5pbmcgZm9yIGNsYXVkZS1jb2RlIHByb3ZpZGVyXCIpO1xuXG4gIC8vIE11c3QgZGlzYWJsZSBjdXN0b20gc2VhcmNoIHRvb2xzXG4gIGFzc2VydC5vayghcGkuZ2V0QWN0aXZlVG9vbHMoKS5pbmNsdWRlcyhcInNlYXJjaC10aGUtd2ViXCIpLCBcIkJyYXZlIHRvb2xzIGRpc2FibGVkIG9uIGNsYXVkZS1jb2RlXCIpO1xuXG4gIGNvbnN0IHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgIG1vZGVsOiBcImNsYXVkZS1zb25uZXQtNC02LTIwMjUwNTE0XCIsXG4gICAgdG9vbHM6IFt7IG5hbWU6IFwiYmFzaFwiLCB0eXBlOiBcImN1c3RvbVwiIH1dLFxuICB9O1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBwaS5maXJlKFwiYmVmb3JlX3Byb3ZpZGVyX3JlcXVlc3RcIiwge1xuICAgIHR5cGU6IFwiYmVmb3JlX3Byb3ZpZGVyX3JlcXVlc3RcIixcbiAgICBwYXlsb2FkLFxuICAgIG1vZGVsOiB7IHByb3ZpZGVyOiBcImNsYXVkZS1jb2RlXCIsIGlkOiBcImNsYXVkZS1zb25uZXQtNC02XCIsIGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIiB9LFxuICB9KTtcbiAgY29uc3QgdG9vbHMgPSAoKHJlc3VsdCBhcyBhbnkpPy50b29scyA/PyBwYXlsb2FkLnRvb2xzKSBhcyBhbnlbXTtcbiAgYXNzZXJ0Lm9rKFxuICAgIHRvb2xzLnNvbWUoKHQpID0+IHQudHlwZSA9PT0gXCJ3ZWJfc2VhcmNoXzIwMjUwMzA1XCIpLFxuICAgIFwiU2hvdWxkIGluamVjdCBuYXRpdmUgd2ViX3NlYXJjaCBmb3IgY2xhdWRlLWNvZGVcIixcbiAgKTtcbn0pO1xuXG50ZXN0KFwiIzQ0NzggYW50aHJvcGljLXZlcnRleCBwcm92aWRlciBpbmplY3RzIG5hdGl2ZSB3ZWJfc2VhcmNoXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgcGkgPSBjcmVhdGVNb2NrUEkoKTtcbiAgcmVnaXN0ZXJOYXRpdmVTZWFyY2hIb29rcyhwaSk7XG5cbiAgYXdhaXQgcGkuZmlyZShcIm1vZGVsX3NlbGVjdFwiLCB7XG4gICAgdHlwZTogXCJtb2RlbF9zZWxlY3RcIixcbiAgICBtb2RlbDogeyBwcm92aWRlcjogXCJhbnRocm9waWMtdmVydGV4XCIsIGFwaTogXCJhbnRocm9waWMtdmVydGV4XCIsIG5hbWU6IFwiY2xhdWRlLXNvbm5ldC00LTZcIiB9LFxuICAgIHByZXZpb3VzTW9kZWw6IHVuZGVmaW5lZCxcbiAgICBzb3VyY2U6IFwic2V0XCIsXG4gIH0pO1xuXG4gIGNvbnN0IHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgIG1vZGVsOiBcImNsYXVkZS1zb25uZXQtNC02XCIsXG4gICAgdG9vbHM6IFt7IG5hbWU6IFwiYmFzaFwiLCB0eXBlOiBcImN1c3RvbVwiIH1dLFxuICB9O1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBwaS5maXJlKFwiYmVmb3JlX3Byb3ZpZGVyX3JlcXVlc3RcIiwge1xuICAgIHR5cGU6IFwiYmVmb3JlX3Byb3ZpZGVyX3JlcXVlc3RcIixcbiAgICBwYXlsb2FkLFxuICAgIG1vZGVsOiB7IHByb3ZpZGVyOiBcImFudGhyb3BpYy12ZXJ0ZXhcIiwgaWQ6IFwiY2xhdWRlLXNvbm5ldC00LTZcIiwgYXBpOiBcImFudGhyb3BpYy12ZXJ0ZXhcIiB9LFxuICB9KTtcbiAgY29uc3QgdG9vbHMgPSAoKHJlc3VsdCBhcyBhbnkpPy50b29scyA/PyBwYXlsb2FkLnRvb2xzKSBhcyBhbnlbXTtcbiAgYXNzZXJ0Lm9rKFxuICAgIHRvb2xzLnNvbWUoKHQpID0+IHQudHlwZSA9PT0gXCJ3ZWJfc2VhcmNoXzIwMjUwMzA1XCIpLFxuICAgIFwiU2hvdWxkIGluamVjdCBuYXRpdmUgd2ViX3NlYXJjaCBmb3IgYW50aHJvcGljLXZlcnRleFwiLFxuICApO1xufSk7XG5cbnRlc3QoXCIjNDQ3OCB2ZXJjZWwtYWktZ2F0ZXdheSB3aXRoIGFudGhyb3BpYy1tZXNzYWdlcyBhcGkgaW5qZWN0cyBuYXRpdmUgd2ViX3NlYXJjaFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHBpID0gY3JlYXRlTW9ja1BJKCk7XG4gIHJlZ2lzdGVyTmF0aXZlU2VhcmNoSG9va3MocGkpO1xuXG4gIGF3YWl0IHBpLmZpcmUoXCJtb2RlbF9zZWxlY3RcIiwge1xuICAgIHR5cGU6IFwibW9kZWxfc2VsZWN0XCIsXG4gICAgbW9kZWw6IHsgcHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIiwgYXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLCBuYW1lOiBcImFudGhyb3BpYy9jbGF1ZGUtc29ubmV0LTQtNlwiIH0sXG4gICAgcHJldmlvdXNNb2RlbDogdW5kZWZpbmVkLFxuICAgIHNvdXJjZTogXCJzZXRcIixcbiAgfSk7XG5cbiAgY29uc3QgcGF5bG9hZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgbW9kZWw6IFwiYW50aHJvcGljL2NsYXVkZS1zb25uZXQtNC02XCIsXG4gICAgdG9vbHM6IFt7IG5hbWU6IFwiYmFzaFwiLCB0eXBlOiBcImN1c3RvbVwiIH1dLFxuICB9O1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBwaS5maXJlKFwiYmVmb3JlX3Byb3ZpZGVyX3JlcXVlc3RcIiwge1xuICAgIHR5cGU6IFwiYmVmb3JlX3Byb3ZpZGVyX3JlcXVlc3RcIixcbiAgICBwYXlsb2FkLFxuICAgIG1vZGVsOiB7IHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsIGlkOiBcImFudGhyb3BpYy9jbGF1ZGUtc29ubmV0LTQtNlwiLCBhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIgfSxcbiAgfSk7XG4gIGNvbnN0IHRvb2xzID0gKChyZXN1bHQgYXMgYW55KT8udG9vbHMgPz8gcGF5bG9hZC50b29scykgYXMgYW55W107XG4gIGFzc2VydC5vayhcbiAgICB0b29scy5zb21lKCh0KSA9PiB0LnR5cGUgPT09IFwid2ViX3NlYXJjaF8yMDI1MDMwNVwiKSxcbiAgICBcIlZlcmNlbC1nYXRld2F5IEFudGhyb3BpYyByb3V0ZSBzaG91bGQgaW5qZWN0IG5hdGl2ZSB3ZWJfc2VhcmNoIChzYW1lIHdpcmUgcHJvdG9jb2wpXCIsXG4gICk7XG59KTtcblxudGVzdChcIiM0NDc4IGFtYXpvbi1iZWRyb2NrIHByb3ZpZGVyIGRvZXMgTk9UIGluamVjdCAoZGlmZmVyZW50IHRvb2wgc2NoZW1hKVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHBpID0gY3JlYXRlTW9ja1BJKCk7XG4gIHJlZ2lzdGVyTmF0aXZlU2VhcmNoSG9va3MocGkpO1xuXG4gIGF3YWl0IHBpLmZpcmUoXCJtb2RlbF9zZWxlY3RcIiwge1xuICAgIHR5cGU6IFwibW9kZWxfc2VsZWN0XCIsXG4gICAgbW9kZWw6IHsgcHJvdmlkZXI6IFwiYW1hem9uLWJlZHJvY2tcIiwgYXBpOiBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIsIG5hbWU6IFwiY2xhdWRlLXNvbm5ldC00LTZcIiB9LFxuICAgIHByZXZpb3VzTW9kZWw6IHVuZGVmaW5lZCxcbiAgICBzb3VyY2U6IFwic2V0XCIsXG4gIH0pO1xuXG4gIGNvbnN0IHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgIG1vZGVsOiBcImFudGhyb3BpYy5jbGF1ZGUtc29ubmV0LTQtNlwiLFxuICAgIHRvb2xzOiBbeyBuYW1lOiBcImJhc2hcIiwgdHlwZTogXCJjdXN0b21cIiB9XSxcbiAgfTtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcGkuZmlyZShcImJlZm9yZV9wcm92aWRlcl9yZXF1ZXN0XCIsIHtcbiAgICB0eXBlOiBcImJlZm9yZV9wcm92aWRlcl9yZXF1ZXN0XCIsXG4gICAgcGF5bG9hZCxcbiAgICBtb2RlbDogeyBwcm92aWRlcjogXCJhbWF6b24tYmVkcm9ja1wiLCBpZDogXCJjbGF1ZGUtc29ubmV0LTQtNlwiLCBhcGk6IFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIiB9LFxuICB9KTtcblxuICBhc3NlcnQuZXF1YWwocmVzdWx0LCB1bmRlZmluZWQsIFwiU2hvdWxkIG5vdCBtb2RpZnkgcGF5bG9hZCBmb3IgQmVkcm9jayAoZGlmZmVyZW50IHRvb2wgc2NoZW1hKVwiKTtcbiAgY29uc3QgdG9vbHMgPSBwYXlsb2FkLnRvb2xzIGFzIGFueVtdO1xuICBhc3NlcnQub2soXG4gICAgIXRvb2xzLnNvbWUoKHQpID0+IHQudHlwZSA9PT0gXCJ3ZWJfc2VhcmNoXzIwMjUwMzA1XCIpLFxuICAgIFwid2ViX3NlYXJjaF8yMDI1MDMwNSBtdXN0IE5PVCBiZSBpbmplY3RlZCBpbnRvIEJlZHJvY2sgcmVxdWVzdHNcIixcbiAgKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUNuQjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FFSztBQWVQLFNBQVMsZUFBZTtBQUN0QixRQUFNLFdBQTBCLENBQUM7QUFDakMsTUFBSSxjQUFjLENBQUMsa0JBQWtCLG1CQUFtQixpQkFBaUIsY0FBYyxRQUFRLE1BQU07QUFDckcsUUFBTSxnQkFBMkQsQ0FBQztBQUVsRSxRQUFNLFVBQVU7QUFBQSxJQUNkLElBQUk7QUFBQSxNQUNGLE9BQU8sU0FBaUIsT0FBZTtBQUNyQyxzQkFBYyxLQUFLLEVBQUUsU0FBUyxNQUFNLENBQUM7QUFBQSxNQUN2QztBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBRUEsUUFBTSxLQUtGO0FBQUEsSUFDRjtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQSxHQUFHLE9BQWUsU0FBa0M7QUFDbEQsZUFBUyxLQUFLLEVBQUUsT0FBTyxRQUFRLENBQUM7QUFBQSxJQUNsQztBQUFBLElBQ0EsaUJBQWlCO0FBQ2YsYUFBTyxDQUFDLEdBQUcsV0FBVztBQUFBLElBQ3hCO0FBQUEsSUFDQSxlQUFlLE9BQWlCO0FBQzlCLG9CQUFjO0FBQUEsSUFDaEI7QUFBQSxJ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QkFBMEIsRUFBRTtBQUU1QixRQUFNLEdBQUcsS0FBSyxnQkFBZ0I7QUFBQSxJQUM1QixNQUFNO0FBQUEsSUFDTixPQUFPLEVBQUUsVUFBVSxxQkFBcUIsS0FBSyxzQkFBc0IsTUFBTSw4QkFBOEI7QUFBQSxJQUN2RyxlQUFlO0FBQUEsSUFDZixRQUFRO0FBQUEsRUFDVixDQUFDO0FBRUQsUUFBTSxVQUFtQztBQUFBLElBQ3ZDLE9BQU87QUFBQSxJQUNQLE9BQU8sQ0FBQyxFQUFFLE1BQU0sUUFBUSxNQUFNLFNBQVMsQ0FBQztBQUFBLEVBQzFDO0FBQ0EsUUFBTSxTQUFTLE1BQU0sR0FBRyxLQUFLLDJCQUEyQjtBQUFBLElBQ3RELE1BQU07QUFBQSxJQUNOO0FBQUEsSUFDQSxPQUFPLEVBQUUsVUFBVSxxQkFBcUIsSUFBSSwrQkFBK0IsS0FBSyxxQkFBcUI7QUFBQSxFQUN2RyxDQUFDO0FBQ0QsUUFBTSxRQUFVLFFBQWdCLFNBQVMsUUFBUTtBQUNqRCxTQUFPO0FBQUEsSUFDTCxNQUFNLEtBQUssQ0FBQyxNQUFNLEVBQUUsU0FBUyxxQkFBcUI7QUFBQSxJQUNsRDtBQUFBLEVBQ0Y7QUFDRixDQUFDO0FBRUQsS0FBSyx5RUFBeUUsWUFBWTtBQUN4RixRQUFNLEtBQUssYUFBYTtBQUN4Qiw0QkFBMEIsRUFBRTtBQUU1QixRQUFNLEdBQUcsS0FBSyxnQkFBZ0I7QUFBQSxJQUM1QixNQUFNO0FBQUEsSUFDTixPQUFPLEVBQUUsVUFBVSxrQkFBa0IsS0FBSywyQkFBMkIsTUFBTSxvQkFBb0I7QUFBQSxJQUMvRixlQUFlO0FBQUEsSUFDZixRQUFRO0FBQUEsRUFDVixDQUFDO0FBRUQsUUFBTSxVQUFtQztBQUFBLElBQ3ZDLE9BQU87QUFBQSxJQUNQLE9BQU8sQ0FBQyxFQUFFLE1BQU0sUUFBUSxNQUFNLFNBQVMsQ0FBQztBQUFBLEVBQzFDO0FBQ0EsUUFBTSxTQUFTLE1BQU0sR0FBRyxLQUFLLDJCQUEyQjtBQUFBLElBQ3RELE1BQU07QUFBQSxJQUNOO0FBQUEsSUFDQSxPQUFPLEVBQUUsVUFBVSxrQkFBa0IsSUFBSSxxQkFBcUIsS0FBSywwQkFBMEI7QUFBQSxFQUMvRixDQUFDO0FBRUQsU0FBTyxNQUFNLFFBQVEsUUFBVywrREFBK0Q7QUFDL0YsUUFBTSxRQUFRLFFBQVE7QUFDdEIsU0FBTztBQUFBLElBQ0wsQ0FBQyxNQUFNLEtBQUssQ0FBQyxNQUFNLEVBQUUsU0FBUyxxQkFBcUI7QUFBQSxJQUNuRDtBQUFBLEVBQ0Y7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogWyJ0Il0KfQo=
