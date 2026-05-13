import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  makeStreamExhaustedErrorMessage,
  isClaudeCodeAbortErrorMessage,
  resolveClaudeCodeAbortedMessageText,
  getResultErrorMessage,
  makeAbortedMessage,
  mergePendingToolCalls,
  buildFinalAssistantContent,
  resolveClaudePermissionMode,
  buildPromptFromContext,
  buildSdkQueryPrompt,
  buildSdkOptions,
  resolveClaudeCodeCwd,
  createClaudeCodeCanUseToolHandler,
  buildBashPermissionPattern,
  buildBashPermissionPatternOptions,
  bashCommandMatchesSavedRules,
  createClaudeCodeElicitationHandler,
  extractImageBlocksFromContext,
  extractToolResultsFromSdkUserMessage,
  getClaudeLookupCommand,
  parseAskUserQuestionsElicitation,
  parseTextInputElicitation,
  parseClaudeLookupOutput,
  resolveBundledClaudeCliPath,
  normalizeClaudePathForSdk,
  roundResultToElicitationContent
} from "../stream-adapter.js";
const WORKFLOW_MCP_ENV_KEYS = [
  "GSD_WORKFLOW_MCP_COMMAND",
  "GSD_WORKFLOW_MCP_NAME",
  "GSD_WORKFLOW_MCP_ARGS",
  "GSD_WORKFLOW_MCP_ENV",
  "GSD_WORKFLOW_MCP_CWD",
  "GSD_PROJECT_ROOT",
  "GSD_WORKFLOW_PROJECT_ROOT"
];
function setWorkflowMcpEnv(values) {
  const prev = {};
  for (const key of WORKFLOW_MCP_ENV_KEYS) {
    prev[key] = process.env[key];
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }
  return function restore() {
    for (const key of WORKFLOW_MCP_ENV_KEYS) {
      const previous = prev[key];
      if (previous === void 0) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  };
}
describe("stream-adapter \u2014 exhausted stream fallback (#2575)", () => {
  test("generator exhaustion becomes an error message instead of clean completion", () => {
    const message = makeStreamExhaustedErrorMessage("claude-sonnet-4-20250514", "partial answer");
    assert.equal(message.stopReason, "error");
    assert.equal(message.errorMessage, "stream_exhausted_without_result");
    assert.deepEqual(message.content, [{ type: "text", text: "partial answer" }]);
  });
  test("generator exhaustion without prior text still exposes a classifiable error", () => {
    const message = makeStreamExhaustedErrorMessage("claude-sonnet-4-20250514", "");
    assert.equal(message.stopReason, "error");
    assert.equal(message.errorMessage, "stream_exhausted_without_result");
    assert.match(String(message.content[0]?.text ?? ""), /Claude Code error: stream_exhausted_without_result/);
  });
});
describe("stream-adapter \u2014 result error text (#3776)", () => {
  test("prefers SDK result text when an error arrives with subtype success", () => {
    const message = getResultErrorMessage({
      type: "result",
      subtype: "success",
      uuid: "uuid-1",
      session_id: "session-1",
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: true,
      num_turns: 1,
      result: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      stop_reason: null,
      total_cost_usd: 0,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0
      }
    });
    assert.match(message, /API Error: 529/);
    assert.doesNotMatch(message, /^success$/i);
  });
  test("falls back to a stable classifier when success errors have no text", () => {
    const message = getResultErrorMessage({
      type: "result",
      subtype: "success",
      uuid: "uuid-2",
      session_id: "session-2",
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: true,
      num_turns: 1,
      result: "   ",
      stop_reason: null,
      total_cost_usd: 0,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0
      }
    });
    assert.equal(message, "claude_code_request_failed");
  });
});
describe("stream-adapter \u2014 full context prompt (#2859)", () => {
  test("buildPromptFromContext includes all user and assistant messages, not just the last user message", () => {
    const context = {
      systemPrompt: "You are a helpful assistant.",
      messages: [
        { role: "user", content: "What is 2+2?" },
        {
          role: "assistant",
          content: [{ type: "text", text: "4" }],
          api: "anthropic-messages",
          provider: "claude-code",
          model: "claude-sonnet-4-20250514",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: Date.now()
        },
        { role: "user", content: "Now multiply that by 3" }
      ]
    };
    const prompt = buildPromptFromContext(context);
    assert.ok(prompt.includes("2+2"), "prompt must include first user message");
    assert.ok(prompt.includes("multiply"), "prompt must include second user message");
    assert.ok(prompt.includes("4"), "prompt must include assistant reply for context");
  });
  test("buildPromptFromContext includes system prompt when present", () => {
    const context = {
      systemPrompt: "You are a coding assistant.",
      messages: [
        { role: "user", content: "Write a function" }
      ]
    };
    const prompt = buildPromptFromContext(context);
    assert.ok(prompt.includes("coding assistant"), "prompt must include system prompt");
  });
  test("buildPromptFromContext handles array content parts in user messages", () => {
    const context = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "First part" },
            { type: "text", text: "Second part" }
          ]
        },
        { role: "user", content: "Follow-up" }
      ]
    };
    const prompt = buildPromptFromContext(context);
    assert.ok(prompt.includes("First part"), "prompt must include array content parts");
    assert.ok(prompt.includes("Second part"), "prompt must include all text parts");
    assert.ok(prompt.includes("Follow-up"), "prompt must include follow-up message");
  });
  test("buildPromptFromContext returns empty string for empty messages", () => {
    const context = { messages: [] };
    const prompt = buildPromptFromContext(context);
    assert.equal(prompt, "");
  });
});
describe("stream-adapter \u2014 image prompt forwarding (#4183)", () => {
  test("extractImageBlocksFromContext maps user image parts to Anthropic base64 image blocks", () => {
    const context = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            {
              type: "image",
              data: "data:image/png;base64,abc123",
              mimeType: "image/png"
            }
          ]
        }
      ]
    };
    const imageBlocks = extractImageBlocksFromContext(context);
    assert.deepEqual(imageBlocks, [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "abc123"
        }
      }
    ]);
  });
  test("buildSdkQueryPrompt returns plain string when no images exist in context", () => {
    const context = {
      messages: [{ role: "user", content: "hello" }]
    };
    const textPrompt = buildPromptFromContext(context);
    const prompt = buildSdkQueryPrompt(context, textPrompt);
    assert.equal(typeof prompt, "string");
    assert.equal(prompt, textPrompt);
  });
  test("buildSdkQueryPrompt wraps images and prompt text in an SDK user message iterable", async () => {
    const context = {
      messages: [
        {
          role: "user",
          content: [
            { type: "image", data: "ZmFrZQ==", mimeType: "image/jpeg" },
            { type: "text", text: "What is in this image?" }
          ]
        }
      ]
    };
    const textPrompt = buildPromptFromContext(context);
    const prompt = buildSdkQueryPrompt(context, textPrompt);
    assert.notEqual(typeof prompt, "string");
    assert.ok(prompt && typeof prompt[Symbol.asyncIterator] === "function");
    const messages = [];
    for await (const item of prompt) {
      messages.push(item);
    }
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0], {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: "ZmFrZQ=="
            }
          },
          { type: "text", text: textPrompt }
        ]
      },
      parent_tool_use_id: null
    });
  });
});
describe("stream-adapter \u2014 no transcript fabrication (#4102)", () => {
  test("buildPromptFromContext never emits forbidden [User]/[Assistant] bracket headers", () => {
    const context = {
      systemPrompt: "You are a helpful assistant.",
      messages: [
        { role: "user", content: "First" },
        {
          role: "assistant",
          content: [{ type: "text", text: "Second" }],
          api: "anthropic-messages",
          provider: "claude-code",
          model: "claude-sonnet-4-20250514",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: Date.now()
        },
        { role: "user", content: "Third" }
      ]
    };
    const prompt = buildPromptFromContext(context);
    assert.ok(!prompt.includes("[User]"), "prompt must not include literal [User] bracket header");
    assert.ok(!prompt.includes("[Assistant]"), "prompt must not include literal [Assistant] bracket header");
    assert.ok(!prompt.includes("[System]"), "prompt must not include literal [System] bracket header");
  });
  test("buildPromptFromContext wraps history in XML-tag structure", () => {
    const context = {
      systemPrompt: "You are helpful.",
      messages: [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: [{ type: "text", text: "Hi there" }],
          api: "anthropic-messages",
          provider: "claude-code",
          model: "claude-sonnet-4-20250514",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: Date.now()
        }
      ]
    };
    const prompt = buildPromptFromContext(context);
    assert.ok(prompt.includes("<conversation_history>"), "prompt must wrap history in <conversation_history>");
    assert.ok(prompt.includes("</conversation_history>"), "prompt must close <conversation_history>");
    assert.ok(prompt.includes("<user_message>\nHello\n</user_message>"), "user turn must use <user_message> tags");
    assert.ok(prompt.includes("<assistant_message>\nHi there\n</assistant_message>"), "assistant turn must use <assistant_message> tags");
    assert.ok(prompt.includes("<prior_system_context>\nYou are helpful.\n</prior_system_context>"), "system prompt must use <prior_system_context> tags");
  });
  test("buildPromptFromContext includes a do-not-echo-tags directive as primary instruction", () => {
    const context = {
      messages: [{ role: "user", content: "Anything" }]
    };
    const prompt = buildPromptFromContext(context);
    assert.ok(
      prompt.startsWith("Respond only to the final user message"),
      "primary directive must lead the prompt"
    );
    assert.ok(prompt.includes("Do not emit <user_message>"), "directive must forbid emitting user_message tag");
    assert.ok(prompt.includes("<assistant_message>"), "directive must mention assistant_message tag");
  });
  test("buildPromptFromContext omits <conversation_history> when there are no messages but a system prompt", () => {
    const context = {
      systemPrompt: "Seed",
      messages: []
    };
    const prompt = buildPromptFromContext(context);
    assert.ok(prompt.includes("<prior_system_context>"), "system prompt must still render");
    assert.ok(!prompt.includes("<conversation_history>"), "no history wrapper when messages are empty");
  });
  test("buildPromptFromContext still returns empty string when context is entirely empty", () => {
    const context = { messages: [] };
    const prompt = buildPromptFromContext(context);
    assert.equal(prompt, "", "empty context must not emit a bare directive");
  });
});
describe("stream-adapter \u2014 Claude Code external tool results", () => {
  test("extractToolResultsFromSdkUserMessage maps tool_result content to tool payloads", () => {
    const message = {
      type: "user",
      session_id: "sess-1",
      parent_tool_use_id: "tool-bash-1",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-bash-1",
            content: "line 1\nline 2",
            is_error: false
          }
        ]
      }
    };
    const results = extractToolResultsFromSdkUserMessage(message);
    assert.deepEqual(results, [
      {
        toolUseId: "tool-bash-1",
        result: {
          content: [{ type: "text", text: "line 1\nline 2" }],
          // extractStructuredDetailsFromBlock returns undefined when no
          // structured payload exists, restoring the pre-#4477 nullable
          // contract (#4477 review feedback).
          details: void 0,
          isError: false
        }
      }
    ]);
  });
  test("extractToolResultsFromSdkUserMessage reads structuredContent as a sibling field (#4472)", () => {
    const message = {
      type: "user",
      session_id: "sess-1",
      parent_tool_use_id: "tool-mcp-1",
      message: {
        role: "user",
        content: [
          {
            type: "mcp_tool_result",
            tool_use_id: "tool-mcp-1",
            content: [{ type: "text", text: "Gate Q3 result saved: verdict=pass" }],
            is_error: false,
            structuredContent: { gateId: "Q3", verdict: "pass" }
          }
        ]
      }
    };
    const results = extractToolResultsFromSdkUserMessage(message);
    assert.deepEqual(results[0].result.details, { gateId: "Q3", verdict: "pass" });
  });
  test("extractToolResultsFromSdkUserMessage reads structuredContent from a content sub-block (#4472)", () => {
    const message = {
      type: "user",
      session_id: "sess-1",
      parent_tool_use_id: "tool-mcp-2",
      message: {
        role: "user",
        content: [
          {
            type: "mcp_tool_result",
            tool_use_id: "tool-mcp-2",
            content: [
              { type: "text", text: "Gate Q4 result saved: verdict=flag" },
              { type: "structuredContent", structuredContent: { gateId: "Q4", verdict: "flag" } }
            ],
            is_error: false
          }
        ]
      }
    };
    const results = extractToolResultsFromSdkUserMessage(message);
    assert.deepEqual(results[0].result.details, { gateId: "Q4", verdict: "flag" });
  });
  test("#4477 extractToolResultsFromSdkUserMessage does NOT leak structuredContent pseudo-blocks into visible content", () => {
    const message = {
      type: "user",
      session_id: "sess-1",
      parent_tool_use_id: "tool-mcp-strip",
      message: {
        role: "user",
        content: [
          {
            type: "mcp_tool_result",
            tool_use_id: "tool-mcp-strip",
            content: [
              { type: "text", text: "Gate Q5 result saved: verdict=pass" },
              { type: "structuredContent", structuredContent: { gateId: "Q5", verdict: "pass" } },
              { type: "text", text: "second visible line" },
              // snake_case variant — also a pseudo-block; also must be stripped
              { type: "structured_content", structured_content: { extra: "data" } }
            ],
            is_error: false
          }
        ]
      }
    };
    const results = extractToolResultsFromSdkUserMessage(message);
    assert.equal(results.length, 1, "should extract one result");
    const result = results[0].result;
    assert.deepEqual(result.details, { gateId: "Q5", verdict: "pass" });
    const visibleTexts = result.content.map((c) => c.text);
    assert.deepEqual(
      visibleTexts,
      ["Gate Q5 result saved: verdict=pass", "second visible line"],
      "visible content must include only the two text blocks; both structuredContent variants must be stripped"
    );
    const allText = visibleTexts.join("\n");
    assert.ok(
      !allText.includes('"structuredContent"'),
      "rendered content must not include the pseudo-block type marker as JSON text"
    );
    assert.ok(
      !allText.includes('"structured_content"'),
      "rendered content must not include the snake_case pseudo-block type marker as JSON text"
    );
  });
  test("extractToolResultsFromSdkUserMessage accepts snake_case structured_content defensively (#4472)", () => {
    const message = {
      type: "user",
      session_id: "sess-1",
      parent_tool_use_id: "tool-mcp-3",
      message: {
        role: "user",
        content: [
          {
            type: "mcp_tool_result",
            tool_use_id: "tool-mcp-3",
            content: [{ type: "text", text: "ok" }],
            structured_content: { operation: "save_gate_result" }
          }
        ]
      }
    };
    const results = extractToolResultsFromSdkUserMessage(message);
    assert.deepEqual(results[0].result.details, { operation: "save_gate_result" });
  });
  test("extractToolResultsFromSdkUserMessage falls back to tool_use_result", () => {
    const message = {
      type: "user",
      session_id: "sess-1",
      parent_tool_use_id: "tool-read-1",
      message: { role: "user", content: [] },
      tool_use_result: {
        tool_use_id: "tool-read-1",
        content: "file contents",
        is_error: true
      }
    };
    const results = extractToolResultsFromSdkUserMessage(message);
    assert.deepEqual(results, [
      {
        toolUseId: "tool-read-1",
        result: {
          content: [{ type: "text", text: "file contents" }],
          // undefined (not {}) per the restored nullable contract — see
          // the analogous assertion in the tool_result test above.
          details: void 0,
          isError: true
        }
      }
    ]);
  });
  test("buildFinalAssistantContent preserves intermediate tool calls with attached external results", () => {
    const finalContent = buildFinalAssistantContent({
      intermediateToolBlocks: [
        {
          type: "toolCall",
          id: "tool-bash-1",
          name: "bash",
          arguments: { command: "echo hi" }
        }
      ],
      pendingContent: [{ type: "text", text: "All done." }],
      toolResultsById: /* @__PURE__ */ new Map([
        [
          "tool-bash-1",
          {
            content: [{ type: "text", text: "hi\n" }],
            details: { source: "claude-code" },
            isError: false
          }
        ]
      ])
    });
    assert.equal(finalContent[0]?.type, "toolCall");
    assert.deepEqual(finalContent[0].externalResult, {
      content: [{ type: "text", text: "hi\n" }],
      details: { source: "claude-code" },
      isError: false
    });
    assert.deepEqual(finalContent[1], { type: "text", text: "All done." });
  });
  test("buildFinalAssistantContent keeps final-turn tool calls when result arrives without a synthetic user boundary", () => {
    const finalContent = buildFinalAssistantContent({
      intermediateToolBlocks: [],
      pendingContent: [
        {
          type: "toolCall",
          id: "tool-read-1",
          name: "read",
          arguments: { path: "README.md" }
        },
        { type: "text", text: "Read complete." }
      ],
      toolResultsById: /* @__PURE__ */ new Map([
        [
          "tool-read-1",
          {
            content: [{ type: "text", text: "file contents" }],
            details: { path: "README.md" },
            isError: false
          }
        ]
      ])
    });
    assert.equal(finalContent[0]?.type, "toolCall");
    assert.deepEqual(finalContent[0].externalResult, {
      content: [{ type: "text", text: "file contents" }],
      details: { path: "README.md" },
      isError: false
    });
    assert.deepEqual(finalContent[1], { type: "text", text: "Read complete." });
  });
});
describe("stream-adapter \u2014 session persistence (#2859)", () => {
  test("buildSdkOptions enables persistSession by default", () => {
    const options = buildSdkOptions("claude-sonnet-4-20250514", "test prompt");
    assert.equal(options.persistSession, true, "persistSession must default to true");
  });
  test("buildSdkOptions sets model and prompt correctly", () => {
    const options = buildSdkOptions("claude-sonnet-4-20250514", "hello world");
    assert.equal(options.model, "claude-sonnet-4-20250514");
  });
  test("buildSdkOptions prefers explicit cwd over process cwd for local SDK execution", () => {
    const explicitCwd = "/tmp/gsd-session-root";
    const options = buildSdkOptions("claude-sonnet-4-20250514", "hello world", void 0, { cwd: explicitCwd });
    assert.equal(options.cwd, explicitCwd);
  });
  test("buildSdkOptions uses explicit cwd when auto-detecting workflow MCP launch config", () => {
    const explicitCwd = realpathSync(mkdtempSync(join(tmpdir(), "claude-sdk-cwd-")));
    const restore = setWorkflowMcpEnv({});
    try {
      delete process.env.GSD_WORKFLOW_MCP_COMMAND;
      delete process.env.GSD_WORKFLOW_MCP_NAME;
      delete process.env.GSD_WORKFLOW_MCP_ARGS;
      delete process.env.GSD_WORKFLOW_MCP_ENV;
      delete process.env.GSD_WORKFLOW_MCP_CWD;
      const distDir = join(explicitCwd, "packages", "mcp-server", "dist");
      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(distDir, "cli.js"), "#!/usr/bin/env node\n");
      const options = buildSdkOptions("claude-sonnet-4-20250514", "hello world", void 0, { cwd: explicitCwd });
      const mcpServers = options.mcpServers;
      assert.equal(mcpServers["gsd-workflow"].cwd, explicitCwd);
      assert.equal(mcpServers["gsd-workflow"].env.GSD_WORKFLOW_PROJECT_ROOT, explicitCwd);
    } finally {
      restore();
      rmSync(explicitCwd, { recursive: true, force: true });
    }
  });
  test("resolveClaudeCodeCwd falls back to process cwd when no stream cwd is provided", () => {
    assert.equal(resolveClaudeCodeCwd(), process.cwd());
    assert.equal(resolveClaudeCodeCwd({ cwd: "   " }), process.cwd());
  });
  test("resolveClaudeCodeCwd returns stream cwd when provided", () => {
    assert.equal(resolveClaudeCodeCwd({ cwd: "/tmp/current-session" }), "/tmp/current-session");
  });
  test("buildSdkOptions enables betas for sonnet models", () => {
    const sonnetOpts = buildSdkOptions("claude-sonnet-4-20250514", "test");
    assert.ok(
      Array.isArray(sonnetOpts.betas) && sonnetOpts.betas.length > 0,
      "sonnet models should have betas enabled"
    );
    const opusOpts = buildSdkOptions("claude-opus-4-20250514", "test");
    assert.ok(
      Array.isArray(opusOpts.betas) && opusOpts.betas.length === 0,
      "non-sonnet models should have empty betas"
    );
  });
  test("buildSdkOptions enables context-1m beta for opus-4-7 (#4348)", () => {
    const opts = buildSdkOptions("claude-opus-4-7", "test");
    assert.ok(
      Array.isArray(opts.betas) && opts.betas.includes("context-1m-2025-08-07"),
      "claude-opus-4-7 should have context-1m beta enabled for 1M token context window"
    );
  });
  test("buildSdkOptions maps reasoning to effort for adaptive Claude Code models (#3917)", () => {
    const options = buildSdkOptions("claude-sonnet-4-6", "test", void 0, { reasoning: "high" });
    assert.equal(options.effort, "high");
  });
  test("buildSdkOptions upgrades xhigh reasoning to max for opus 4.6 (#3917)", () => {
    const options = buildSdkOptions("claude-opus-4-6", "test", void 0, { reasoning: "xhigh" });
    assert.equal(options.effort, "max");
  });
  test("buildSdkOptions maps reasoning to effort for opus-4-7 (#4348)", () => {
    const options = buildSdkOptions("claude-opus-4-7", "test", void 0, { reasoning: "high" });
    assert.equal(options.effort, "high");
  });
  test("buildSdkOptions passes xhigh reasoning natively for opus-4-7 (#4348)", () => {
    const options = buildSdkOptions("claude-opus-4-7", "test", void 0, { reasoning: "xhigh" });
    assert.equal(options.effort, "xhigh");
  });
  test("buildSdkOptions omits effort when reasoning is undefined (#3917)", () => {
    const options = buildSdkOptions("claude-sonnet-4-6", "test");
    assert.equal("effort" in options, false);
  });
  test("buildSdkOptions omits effort for non-adaptive Claude models (#3917)", () => {
    const options = buildSdkOptions("claude-sonnet-4-20250514", "test", void 0, { reasoning: "high" });
    assert.equal("effort" in options, false);
  });
  test("buildSdkOptions sets thinking disabled when reasoning is undefined on adaptive model (#4392)", () => {
    const options = buildSdkOptions("claude-sonnet-4-6", "test", void 0, {});
    assert.deepEqual(
      options.thinking,
      { type: "disabled" },
      "thinking must be {type:'disabled'} when reasoning is undefined so SDK stops adaptive thinking"
    );
  });
  test("buildSdkOptions omits effort when reasoning is undefined (thinking disabled) (#4392)", () => {
    const options = buildSdkOptions("claude-sonnet-4-6", "test", void 0, {});
    assert.equal("effort" in options, false, "effort must not be set when reasoning is undefined");
  });
  test("buildSdkOptions sets thinking adaptive when reasoning is provided (#4392)", () => {
    const options = buildSdkOptions("claude-opus-4-6", "test", void 0, { reasoning: "high" });
    assert.deepEqual(
      options.thinking,
      { type: "adaptive" },
      "thinking must be {type:'adaptive'} alongside effort when reasoning is set"
    );
  });
  test("buildSdkOptions includes both effort and thinking.type=adaptive when reasoning is set (#4392)", () => {
    const options = buildSdkOptions("claude-opus-4-6", "test", void 0, { reasoning: "high" });
    assert.equal(options.effort, "high", "effort must be set");
    assert.deepEqual(options.thinking, { type: "adaptive" }, "thinking must be adaptive");
  });
  test("buildSdkOptions maps reasoning to effort for sonnet-4-7 (modelSupportsAdaptiveThinking #4392)", () => {
    const options = buildSdkOptions("claude-sonnet-4-7", "test", void 0, { reasoning: "high" });
    assert.equal(options.effort, "high", "sonnet-4-7 must support adaptive thinking and map effort");
  });
  test("buildSdkOptions maps reasoning to effort for haiku-4-5 (modelSupportsAdaptiveThinking #4392)", () => {
    const options = buildSdkOptions("claude-haiku-4-5", "test", void 0, { reasoning: "high" });
    assert.equal(options.effort, "high", "haiku-4-5 must support adaptive thinking and map effort");
  });
  test("buildSdkOptions maps reasoning to effort for sonnet-4.7 dot-form (modelSupportsAdaptiveThinking #4392)", () => {
    const options = buildSdkOptions("claude-sonnet-4.7", "test", void 0, { reasoning: "high" });
    assert.equal(options.effort, "high", "claude-sonnet-4.7 must support adaptive thinking and map effort");
  });
  test("buildSdkOptions maps reasoning to effort for haiku-4.5 dot-form (modelSupportsAdaptiveThinking #4392)", () => {
    const options = buildSdkOptions("claude-haiku-4.5", "test", void 0, { reasoning: "high" });
    assert.equal(options.effort, "high", "claude-haiku-4.5 must support adaptive thinking and map effort");
  });
  test("buildSdkOptions does not set thinking field for non-adaptive model when reasoning is undefined (#4392)", () => {
    const options = buildSdkOptions("claude-sonnet-4-20250514", "test", void 0, {});
    assert.equal("thinking" in options, false, "non-adaptive models must not receive a thinking field");
  });
  test("buildSdkOptions prefers workflow MCP question tools over native AskUserQuestion", () => {
    const restore = setWorkflowMcpEnv({
      GSD_WORKFLOW_MCP_COMMAND: "node",
      GSD_WORKFLOW_MCP_NAME: "gsd-workflow",
      GSD_WORKFLOW_MCP_ARGS: JSON.stringify(["packages/mcp-server/dist/cli.js"]),
      GSD_WORKFLOW_MCP_ENV: JSON.stringify({ GSD_CLI_PATH: "/tmp/gsd" }),
      GSD_WORKFLOW_MCP_CWD: "/tmp/project"
    });
    try {
      const options = buildSdkOptions("claude-sonnet-4-20250514", "test");
      const mcpServers = options.mcpServers;
      assert.ok(mcpServers?.["gsd-workflow"], "expected gsd-workflow server config");
      const srv = mcpServers["gsd-workflow"];
      assert.equal(srv.command, "node");
      assert.deepEqual(srv.args, ["packages/mcp-server/dist/cli.js"]);
      assert.equal(srv.cwd, "/tmp/project");
      assert.equal(srv.env.GSD_CLI_PATH, "/tmp/gsd");
      assert.equal(srv.env.GSD_PERSIST_WRITE_GATE_STATE, "1");
      assert.equal(srv.env.GSD_WORKFLOW_PROJECT_ROOT, "/tmp/project");
      assert.deepEqual(options.disallowedTools, ["AskUserQuestion"]);
      assert.deepEqual(options.allowedTools, [
        "Read",
        "Write",
        "Edit",
        "Glob",
        "Grep",
        "Bash",
        "Agent",
        "WebFetch",
        "WebSearch",
        "mcp__gsd-workflow__*"
      ]);
    } finally {
      restore();
    }
  });
  test("buildSdkOptions prefers custom workflow MCP question tools over native AskUserQuestion", () => {
    const restore = setWorkflowMcpEnv({
      GSD_WORKFLOW_MCP_COMMAND: "node",
      GSD_WORKFLOW_MCP_NAME: "custom-workflow",
      GSD_WORKFLOW_MCP_ARGS: JSON.stringify(["packages/mcp-server/dist/cli.js"]),
      GSD_WORKFLOW_MCP_ENV: JSON.stringify({ GSD_CLI_PATH: "/tmp/gsd" }),
      GSD_WORKFLOW_MCP_CWD: "/tmp/project"
    });
    try {
      const options = buildSdkOptions("claude-sonnet-4-20250514", "test");
      const mcpServers = options.mcpServers;
      assert.ok(mcpServers?.["custom-workflow"], "expected custom workflow server config");
      assert.deepEqual(options.disallowedTools, ["AskUserQuestion"]);
      assert.deepEqual(options.allowedTools, [
        "Read",
        "Write",
        "Edit",
        "Glob",
        "Grep",
        "Bash",
        "Agent",
        "WebFetch",
        "WebSearch",
        "mcp__custom-workflow__*"
      ]);
    } finally {
      restore();
    }
  });
  test("buildSdkOptions auto-discovers bundled MCP server even without env hints", () => {
    const restore = setWorkflowMcpEnv({});
    try {
      delete process.env.GSD_WORKFLOW_MCP_COMMAND;
      delete process.env.GSD_WORKFLOW_MCP_NAME;
      delete process.env.GSD_WORKFLOW_MCP_ARGS;
      delete process.env.GSD_WORKFLOW_MCP_ENV;
      delete process.env.GSD_WORKFLOW_MCP_CWD;
      const originalCwd = process.cwd();
      const emptyDir = mkdtempSync(join(tmpdir(), "claude-mcp-none-"));
      process.chdir(emptyDir);
      const options = buildSdkOptions("claude-sonnet-4-20250514", "test");
      process.chdir(originalCwd);
      const mcpServers = options.mcpServers;
      if (mcpServers) {
        assert.ok(mcpServers["gsd-workflow"], "if present, must be gsd-workflow");
        assert.deepEqual(options.disallowedTools, ["AskUserQuestion"]);
      } else {
        assert.deepEqual(options.disallowedTools, []);
      }
      rmSync(emptyDir, { recursive: true, force: true });
    } finally {
      restore();
    }
  });
  test("buildSdkOptions auto-detects local workflow MCP dist CLI when present", () => {
    const prevCliPath = process.env.GSD_CLI_PATH;
    const restore = setWorkflowMcpEnv({});
    const originalCwd = process.cwd();
    const repoDir = mkdtempSync(join(tmpdir(), "claude-mcp-detect-"));
    try {
      delete process.env.GSD_WORKFLOW_MCP_COMMAND;
      delete process.env.GSD_WORKFLOW_MCP_NAME;
      delete process.env.GSD_WORKFLOW_MCP_ARGS;
      delete process.env.GSD_WORKFLOW_MCP_ENV;
      delete process.env.GSD_WORKFLOW_MCP_CWD;
      process.env.GSD_CLI_PATH = "/tmp/gsd";
      const distDir = join(repoDir, "packages", "mcp-server", "dist");
      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(distDir, "cli.js"), "#!/usr/bin/env node\n");
      process.chdir(repoDir);
      const resolvedRepoDir = realpathSync(repoDir);
      const options = buildSdkOptions("claude-sonnet-4-20250514", "test");
      const mcpServers = options.mcpServers;
      assert.ok(mcpServers?.["gsd-workflow"], "expected gsd-workflow server config");
      const srv = mcpServers["gsd-workflow"];
      assert.equal(srv.command, process.execPath);
      assert.deepEqual(srv.args, [realpathSync(resolve(repoDir, "packages", "mcp-server", "dist", "cli.js"))]);
      assert.equal(srv.cwd, resolvedRepoDir);
      assert.equal(srv.env.GSD_CLI_PATH, "/tmp/gsd");
      assert.equal(srv.env.GSD_PERSIST_WRITE_GATE_STATE, "1");
      assert.equal(srv.env.GSD_WORKFLOW_PROJECT_ROOT, resolvedRepoDir);
      assert.deepEqual(options.disallowedTools, ["AskUserQuestion"]);
    } finally {
      process.chdir(originalCwd);
      rmSync(repoDir, { recursive: true, force: true });
      restore();
      if (prevCliPath === void 0) {
        delete process.env.GSD_CLI_PATH;
      } else {
        process.env.GSD_CLI_PATH = prevCliPath;
      }
    }
  });
  test("buildSdkOptions preserves runtime callbacks such as onElicitation", () => {
    const restore = setWorkflowMcpEnv({});
    const onElicitation = async () => ({ action: "decline" });
    try {
      delete process.env.GSD_WORKFLOW_MCP_COMMAND;
      delete process.env.GSD_WORKFLOW_MCP_NAME;
      delete process.env.GSD_WORKFLOW_MCP_ARGS;
      delete process.env.GSD_WORKFLOW_MCP_ENV;
      delete process.env.GSD_WORKFLOW_MCP_CWD;
      const options = buildSdkOptions("claude-sonnet-4-20250514", "test", void 0, { onElicitation });
      assert.equal(options.onElicitation, onElicitation);
    } finally {
      restore();
    }
  });
});
describe("stream-adapter \u2014 MCP elicitation bridge", () => {
  const askUserQuestionsRequest = {
    serverName: "gsd-workflow",
    message: "Please answer the following question(s).",
    mode: "form",
    requestedSchema: {
      type: "object",
      properties: {
        storage_scope: {
          type: "string",
          title: "Storage",
          description: "Does this app need to sync across devices?",
          oneOf: [
            { const: "Local-only (Recommended)", title: "Local-only (Recommended)" },
            { const: "Cloud-synced", title: "Cloud-synced" },
            { const: "None of the above", title: "None of the above" }
          ]
        },
        storage_scope__note: {
          type: "string",
          title: "Storage Note",
          description: "Optional note for None of the above."
        },
        platform: {
          type: "array",
          title: "Platform",
          description: "Where should it run?",
          items: {
            anyOf: [
              { const: "Web", title: "Web" },
              { const: "Desktop", title: "Desktop" },
              { const: "Mobile", title: "Mobile" }
            ]
          }
        }
      }
    }
  };
  test("parseAskUserQuestionsElicitation rebuilds interview questions from the MCP schema", () => {
    const questions = parseAskUserQuestionsElicitation(askUserQuestionsRequest);
    assert.deepEqual(questions, [
      {
        id: "storage_scope",
        header: "Storage",
        question: "Does this app need to sync across devices?",
        options: [
          { label: "Local-only (Recommended)", description: "" },
          { label: "Cloud-synced", description: "" }
        ],
        noteFieldId: "storage_scope__note"
      },
      {
        id: "platform",
        header: "Platform",
        question: "Where should it run?",
        options: [
          { label: "Web", description: "" },
          { label: "Desktop", description: "" },
          { label: "Mobile", description: "" }
        ],
        allowMultiple: true
      }
    ]);
  });
  test("roundResultToElicitationContent preserves notes for None of the above", () => {
    const questions = parseAskUserQuestionsElicitation(askUserQuestionsRequest);
    assert.ok(questions);
    const content = roundResultToElicitationContent(questions, {
      endInterview: false,
      answers: {
        storage_scope: {
          selected: "None of the above",
          notes: "Needs selective sync later"
        },
        platform: {
          selected: ["Web", "Desktop"],
          notes: ""
        }
      }
    });
    assert.deepEqual(content, {
      storage_scope: "None of the above",
      storage_scope__note: "Needs selective sync later",
      platform: ["Web", "Desktop"]
    });
  });
  test("createClaudeCodeElicitationHandler accepts interview-style answers from custom UI", async () => {
    const handler = createClaudeCodeElicitationHandler({
      custom: async (_factory) => ({
        endInterview: false,
        answers: {
          storage_scope: {
            selected: "Cloud-synced",
            notes: ""
          },
          platform: {
            selected: ["Web", "Mobile"],
            notes: ""
          }
        }
      })
    });
    assert.ok(handler);
    const result = await handler(askUserQuestionsRequest, { signal: new AbortController().signal });
    assert.deepEqual(result, {
      action: "accept",
      content: {
        storage_scope: "Cloud-synced",
        platform: ["Web", "Mobile"]
      }
    });
  });
  test("createClaudeCodeElicitationHandler falls back to dialog prompts when custom UI is unavailable", async () => {
    const ui = {
      custom: async () => void 0,
      select: async (_title, options, opts) => {
        if (opts?.allowMultiple) return ["Desktop", "Mobile"];
        return options.includes("None of the above") ? "None of the above" : options[0];
      },
      input: async () => "CLI-only deployment target"
    };
    const handler = createClaudeCodeElicitationHandler(ui);
    assert.ok(handler);
    const result = await handler(askUserQuestionsRequest, { signal: new AbortController().signal });
    assert.deepEqual(result, {
      action: "accept",
      content: {
        storage_scope: "None of the above",
        storage_scope__note: "CLI-only deployment target",
        platform: ["Desktop", "Mobile"]
      }
    });
  });
  test("parseTextInputElicitation recognizes secure free-text MCP forms", () => {
    const request = {
      serverName: "gsd-workflow",
      message: "Enter values for environment variables.",
      mode: "form",
      requestedSchema: {
        type: "object",
        properties: {
          TEST_PASSWORD: {
            type: "string",
            title: "TEST_PASSWORD",
            description: "Format: min 8 characters\nLeave empty to skip."
          },
          PROJECT_NAME: {
            type: "string",
            title: "PROJECT_NAME",
            description: "Human-readable project name."
          }
        }
      }
    };
    const parsed = parseTextInputElicitation(request);
    assert.deepEqual(parsed, [
      {
        id: "TEST_PASSWORD",
        title: "TEST_PASSWORD",
        description: "Format: min 8 characters\nLeave empty to skip.",
        required: false,
        secure: true
      },
      {
        id: "PROJECT_NAME",
        title: "PROJECT_NAME",
        description: "Human-readable project name.",
        required: false,
        secure: false
      }
    ]);
  });
  test("parseTextInputElicitation accepts legacy keys schema and skips unsupported fields", () => {
    const request = {
      serverName: "gsd-workflow",
      message: "Enter secure values",
      mode: "form",
      requestedSchema: {
        type: "object",
        keys: {
          API_TOKEN: {
            type: "string",
            title: "API_TOKEN",
            description: "Leave empty to skip."
          },
          META: {
            type: "object",
            title: "metadata"
          }
        }
      }
    };
    const parsed = parseTextInputElicitation(request);
    assert.deepEqual(parsed, [
      {
        id: "API_TOKEN",
        title: "API_TOKEN",
        description: "Leave empty to skip.",
        required: false,
        secure: true
      }
    ]);
  });
  test("createClaudeCodeElicitationHandler collects secure_env_collect fields through input dialogs", async () => {
    const secureRequest = {
      serverName: "gsd-workflow",
      message: "Enter values for environment variables.",
      mode: "form",
      requestedSchema: {
        type: "object",
        properties: {
          TEST_SECURE_FIELD: {
            type: "string",
            title: "TEST_SECURE_FIELD",
            description: "Format: Your secure testing password\nLeave empty to skip."
          }
        }
      }
    };
    const secureValue = "ui-collected-value";
    const inputCalls = [];
    const handler = createClaudeCodeElicitationHandler({
      input: async (_title, _placeholder, opts) => {
        inputCalls.push({ opts });
        return secureValue;
      }
    });
    assert.ok(handler);
    const result = await handler(secureRequest, { signal: new AbortController().signal });
    assert.deepEqual(result, {
      action: "accept",
      content: {
        TEST_SECURE_FIELD: secureValue
      }
    });
    assert.equal(inputCalls.length, 1);
    assert.equal(inputCalls[0]?.opts?.secure, true, "secure_env_collect fields should request secure input");
  });
});
describe("stream-adapter \u2014 abort classification (F2)", () => {
  test("recognizes Claude Code SDK abort exceptions", () => {
    assert.equal(isClaudeCodeAbortErrorMessage("Claude Code process aborted by user"), true);
    assert.equal(isClaudeCodeAbortErrorMessage("Request aborted by user"), true);
    assert.equal(isClaudeCodeAbortErrorMessage("rate limit exceeded"), false);
  });
  test("makeAbortedMessage sets stopReason to 'aborted', not 'error'", () => {
    const message = makeAbortedMessage("claude-sonnet-4-6", "");
    assert.equal(message.stopReason, "aborted");
    assert.equal(message.errorMessage, void 0);
  });
  test("makeAbortedMessage preserves last-seen text content", () => {
    const message = makeAbortedMessage("claude-sonnet-4-6", "partial mid-stream text");
    assert.deepEqual(message.content, [{ type: "text", text: "partial mid-stream text" }]);
  });
  test("aborted message is distinguishable from stream-exhausted error", () => {
    const aborted = makeAbortedMessage("claude-sonnet-4-6", "");
    const exhausted = makeStreamExhaustedErrorMessage("claude-sonnet-4-6", "");
    assert.notEqual(aborted.stopReason, exhausted.stopReason);
    assert.equal(exhausted.errorMessage, "stream_exhausted_without_result");
  });
  test("abort catch preserves SDK diagnostic text instead of partial output", () => {
    const text = resolveClaudeCodeAbortedMessageText(
      "Request aborted by user\nAPI Error: 529 overloaded",
      "partial mid-stream text"
    );
    assert.equal(text, "Request aborted by user\nAPI Error: 529 overloaded");
  });
  test("abort catch falls back to partial output for bare abort markers", () => {
    const text = resolveClaudeCodeAbortedMessageText(
      "Request aborted by user",
      "partial mid-stream text"
    );
    assert.equal(text, "partial mid-stream text");
  });
});
describe("stream-adapter \u2014 final-turn tool-call merge (F3)", () => {
  function toolCall(id, name = "bash") {
    return { type: "toolCall", id, name, arguments: {} };
  }
  test("mergePendingToolCalls appends tool calls not already in intermediate", () => {
    const intermediate = [toolCall("tool-1")];
    const pending = [
      toolCall("tool-2"),
      { type: "text", text: "trailing text" }
    ];
    const merged = mergePendingToolCalls(intermediate, pending);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].id, "tool-1");
    assert.equal(merged[1].id, "tool-2");
  });
  test("mergePendingToolCalls is idempotent across duplicate ids", () => {
    const intermediate = [toolCall("tool-1")];
    const pending = [toolCall("tool-1"), toolCall("tool-2")];
    const merged = mergePendingToolCalls(intermediate, pending);
    assert.equal(merged.length, 2);
    assert.deepEqual(
      merged.map((b) => b.id),
      ["tool-1", "tool-2"]
    );
  });
  test("mergePendingToolCalls ignores non-toolCall blocks from pending", () => {
    const intermediate = [];
    const pending = [
      { type: "text", text: "hello" },
      { type: "thinking", thinking: "pondering" },
      toolCall("tool-1")
    ];
    const merged = mergePendingToolCalls(intermediate, pending);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, "tool-1");
  });
});
describe("stream-adapter \u2014 permission mode (F10)", () => {
  function clearWorkflowMcpEnv() {
    for (const key of [
      "GSD_WORKFLOW_MCP_COMMAND",
      "GSD_WORKFLOW_MCP_NAME",
      "GSD_WORKFLOW_MCP_ARGS",
      "GSD_WORKFLOW_MCP_ENV",
      "GSD_WORKFLOW_MCP_CWD"
    ]) {
      if (process.env[key] === void 0 || process.env[key] === "undefined") {
        delete process.env[key];
      }
    }
  }
  test("buildSdkOptions defaults to bypassPermissions (globally unblocks all tools)", () => {
    clearWorkflowMcpEnv();
    const opts = buildSdkOptions("claude-sonnet-4-6", "test");
    assert.equal(opts.permissionMode, "bypassPermissions");
    assert.equal(
      opts.allowDangerouslySkipPermissions,
      true,
      "allowDangerouslySkipPermissions must be true when permissionMode is bypassPermissions"
    );
  });
  test("buildSdkOptions respects explicit acceptEdits override", () => {
    clearWorkflowMcpEnv();
    const opts = buildSdkOptions("claude-sonnet-4-6", "test", { permissionMode: "acceptEdits" });
    assert.equal(opts.permissionMode, "acceptEdits");
    assert.equal(
      opts.allowDangerouslySkipPermissions,
      false,
      "allowDangerouslySkipPermissions must be false for non-bypass modes"
    );
  });
  test("resolveClaudePermissionMode defaults to bypassPermissions when no env var is set (globally unblocks all tools)", async () => {
    const mode = await resolveClaudePermissionMode({});
    assert.equal(mode, "bypassPermissions");
  });
  test("resolveClaudePermissionMode honours the GSD_CLAUDE_CODE_PERMISSION_MODE env override", async () => {
    const env = { GSD_CLAUDE_CODE_PERMISSION_MODE: "acceptEdits" };
    const mode = await resolveClaudePermissionMode(env);
    assert.equal(mode, "acceptEdits");
  });
  test("resolveClaudePermissionMode rejects unknown override values (fallback path)", async () => {
    const env = { GSD_CLAUDE_CODE_PERMISSION_MODE: "nonsense" };
    const mode = await resolveClaudePermissionMode(env);
    assert.ok(
      mode === "bypassPermissions" || mode === "acceptEdits",
      `expected bypass or acceptEdits, got ${mode}`
    );
  });
  test("resolveClaudePermissionMode flips to bypassPermissions when GSD_HEADLESS=1 (#4657)", async () => {
    const originalWarn = console.warn;
    console.warn = () => {
    };
    try {
      const env = { GSD_HEADLESS: "1" };
      const mode = await resolveClaudePermissionMode(env);
      assert.equal(mode, "bypassPermissions");
    } finally {
      console.warn = originalWarn;
    }
  });
  test("resolveClaudePermissionMode: explicit override wins over GSD_HEADLESS=1", async () => {
    const env = {
      GSD_HEADLESS: "1",
      GSD_CLAUDE_CODE_PERMISSION_MODE: "acceptEdits"
    };
    const mode = await resolveClaudePermissionMode(env);
    assert.equal(mode, "acceptEdits");
  });
});
describe("stream-adapter \u2014 Windows Claude path lookup (#3770)", () => {
  test("getClaudeLookupCommand uses where on Windows", () => {
    assert.equal(getClaudeLookupCommand("win32"), "where claude");
  });
  test("getClaudeLookupCommand uses which on non-Windows platforms", () => {
    assert.equal(getClaudeLookupCommand("darwin"), "which claude");
    assert.equal(getClaudeLookupCommand("linux"), "which claude");
  });
  test("parseClaudeLookupOutput prefers .exe on win32 when where output includes shims", () => {
    const output = [
      "C:\\Users\\djeff\\AppData\\Roaming\\npm\\claude",
      "C:\\Users\\djeff\\AppData\\Roaming\\npm\\claude.cmd",
      "C:\\Program Files\\Claude\\claude.exe"
    ].join("\r\n");
    assert.equal(parseClaudeLookupOutput(output, "win32"), "C:\\Program Files\\Claude\\claude.exe");
  });
  test("parseClaudeLookupOutput keeps first line on non-win32 platforms", () => {
    const output = "/usr/local/bin/claude\n/opt/homebrew/bin/claude\n";
    assert.equal(parseClaudeLookupOutput(output, "darwin"), "/usr/local/bin/claude");
  });
  test("normalizeClaudePathForSdk swaps Windows shim paths to bundled cli.js", () => {
    const shimPath = "C:\\Users\\djeff\\AppData\\Roaming\\npm\\claude";
    const bundled = "C:\\repo\\node_modules\\@anthropic-ai\\claude-agent-sdk\\cli.js";
    assert.equal(normalizeClaudePathForSdk(shimPath, "win32", bundled), bundled);
    assert.equal(normalizeClaudePathForSdk("C:\\Program Files\\Claude\\claude.exe", "win32", bundled), "C:\\Program Files\\Claude\\claude.exe");
  });
  test("resolveBundledClaudeCliPath returns a .js path when SDK package is present", () => {
    const resolved = resolveBundledClaudeCliPath();
    assert.ok(resolved, "expected sdk cli.js to be resolvable in test workspace");
    assert.match(resolved, /[\\/]@anthropic-ai[\\/]claude-agent-sdk[\\/]cli\.js$/);
  });
});
describe("stream-adapter \u2014 canUseTool handler", () => {
  function makeOptions(overrides = {}) {
    return {
      signal: overrides.signal ?? new AbortController().signal,
      toolUseID: overrides.toolUseID ?? "toolu_test123",
      ...overrides.title !== void 0 ? { title: overrides.title } : {},
      ...overrides.description !== void 0 ? { description: overrides.description } : {},
      ...overrides.suggestions !== void 0 ? { suggestions: overrides.suggestions } : {}
    };
  }
  function withIsolatedCwd() {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-canusetool-")));
    const orig = process.cwd;
    process.cwd = () => dir;
    return () => {
      process.cwd = orig;
      rmSync(dir, { recursive: true, force: true });
    };
  }
  test("returns undefined when no UI context is provided", () => {
    const handler = createClaudeCodeCanUseToolHandler(void 0);
    assert.equal(handler, void 0);
  });
  test("shows select dialog with Allow/Always Allow/Deny and returns allow", async () => {
    let selectPrompt = "";
    let selectOptions = [];
    const ui = {
      select: async (prompt, options) => {
        selectPrompt = prompt;
        selectOptions = options;
        return "Allow";
      }
    };
    const handler = createClaudeCodeCanUseToolHandler(ui);
    assert.ok(handler);
    const input = { command: "ls -la" };
    const result = await handler("Bash", input, makeOptions({
      title: "Claude wants to run: ls -la",
      description: "List directory contents"
    }));
    assert.equal(result.behavior, "allow");
    assert.deepEqual(result.updatedInput, input);
    assert.equal(result.toolUseID, "toolu_test123");
    assert.equal(result.updatedPermissions, void 0);
    assert.deepEqual(selectOptions, ["Allow", "Always Allow", "Deny"]);
    assert.ok(selectPrompt.includes("Claude wants to run: ls -la"));
    assert.ok(selectPrompt.includes("ls -la"));
  });
  test("returns deny when user selects Deny", async () => {
    const ui = {
      select: async () => "Deny"
    };
    const handler = createClaudeCodeCanUseToolHandler(ui);
    const result = await handler("Bash", { command: "rm -rf /" }, makeOptions());
    assert.equal(result.behavior, "deny");
    assert.equal(result.message, "User denied");
    assert.equal(result.toolUseID, "toolu_test123");
  });
  test("returns deny when user dismisses dialog (undefined)", async () => {
    const ui = {
      select: async () => void 0
    };
    const handler = createClaudeCodeCanUseToolHandler(ui);
    const result = await handler("Bash", { command: "echo hi" }, makeOptions());
    assert.equal(result.behavior, "deny");
    assert.equal(result.message, "User denied");
  });
  test("Always Allow for Bash patches SDK suggestions with smart ruleContent", async () => {
    const notified = [];
    const ui = { select: async (_p, opts) => opts.find((o) => o.startsWith("Always Allow")), notify: (msg) => notified.push(msg) };
    const suggestions = [{
      type: "addRules",
      rules: [{ toolName: "Bash", ruleContent: "ls -la /tmp" }],
      behavior: "allow",
      destination: "localSettings"
    }];
    const handler = createClaudeCodeCanUseToolHandler(ui);
    const result = await handler("Bash", { command: "ls -la /tmp" }, makeOptions({ suggestions }));
    assert.equal(result.behavior, "allow");
    assert.deepEqual(result.updatedPermissions, [{
      type: "addRules",
      rules: [{ toolName: "Bash", ruleContent: "ls:*" }],
      behavior: "allow",
      destination: "localSettings"
    }]);
    assert.equal(notified.length, 1);
    assert.ok(notified[0].includes("Saved:") && notified[0].includes("Bash(ls:*)"));
  });
  test("Always Allow for Bash with subcommand-sensitive CLI captures verb", async () => {
    const cleanup = withIsolatedCwd();
    try {
      const notified = [];
      let selectCall = 0;
      const ui = {
        select: async (_p, opts) => {
          selectCall++;
          if (selectCall === 1) return opts.find((o) => o.startsWith("Always Allow"));
          return "Bash(git push:*)";
        },
        notify: (msg) => notified.push(msg)
      };
      const suggestions = [{
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "git push origin main" }],
        behavior: "allow",
        destination: "localSettings"
      }];
      const handler = createClaudeCodeCanUseToolHandler(ui);
      const result = await handler("Bash", { command: "git push origin main" }, makeOptions({ suggestions }));
      assert.equal(result.behavior, "allow");
      assert.deepEqual(result.updatedPermissions, [{
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "git push:*" }],
        behavior: "allow",
        destination: "localSettings"
      }]);
      assert.ok(notified[0].includes("Saved:") && notified[0].includes("Bash(git push:*)"));
    } finally {
      cleanup();
    }
  });
  test("Always Allow for Bash without suggestions builds proper PermissionUpdate", async () => {
    const cleanup = withIsolatedCwd();
    try {
      const notified = [];
      let selectCall = 0;
      const ui = {
        select: async (_p, opts) => {
          selectCall++;
          if (selectCall === 1) return opts.find((o) => o.startsWith("Always Allow"));
          return "Bash(gh pr list:*)";
        },
        notify: (msg) => notified.push(msg)
      };
      const handler = createClaudeCodeCanUseToolHandler(ui);
      const result = await handler("Bash", { command: "gh pr list" }, makeOptions());
      assert.equal(result.behavior, "allow");
      assert.deepEqual(result.updatedPermissions, [{
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "gh pr list:*" }],
        behavior: "allow",
        destination: "localSettings"
      }]);
      assert.ok(notified[0].includes("Saved:") && notified[0].includes("Bash(gh pr list:*)"));
    } finally {
      cleanup();
    }
  });
  test("Always Allow for non-Bash tools passes SDK suggestions through", async () => {
    const notified = [];
    const ui = { select: async (_p, opts) => opts.find((o) => o.startsWith("Always Allow")), notify: (msg) => notified.push(msg) };
    const suggestions = [{
      type: "addRules",
      rules: [{ toolName: "Write" }],
      behavior: "allow",
      destination: "localSettings"
    }];
    const handler = createClaudeCodeCanUseToolHandler(ui);
    const result = await handler("Write", { file_path: "/tmp/test.txt" }, makeOptions({ suggestions }));
    assert.equal(result.behavior, "allow");
    assert.deepEqual(result.updatedPermissions, suggestions);
    assert.equal(notified.length, 0);
  });
  test("Always Allow for non-Bash without suggestions builds tool-name-only fallback rule", async () => {
    const notified = [];
    const ui = { select: async (_p, opts) => opts.find((o) => o.startsWith("Always Allow")), notify: (msg) => notified.push(msg) };
    const handler = createClaudeCodeCanUseToolHandler(ui);
    const result = await handler("AskUserQuestion", { questions: [{ question: "?", header: "h", multiSelect: false, options: [] }] }, makeOptions());
    assert.equal(result.behavior, "allow");
    assert.deepEqual(result.updatedPermissions, [{
      type: "addRules",
      rules: [{ toolName: "AskUserQuestion" }],
      behavior: "allow",
      destination: "localSettings"
    }]);
    assert.equal(notified.length, 1);
    assert.match(notified[0], /AskUserQuestion/);
  });
  test("Always Allow for non-Bash with empty suggestions array builds tool-name-only fallback rule", async () => {
    const notified = [];
    const ui = { select: async (_p, opts) => opts.find((o) => o.startsWith("Always Allow")), notify: (msg) => notified.push(msg) };
    const handler = createClaudeCodeCanUseToolHandler(ui);
    const result = await handler("AskUserQuestion", { questions: [{ question: "?", header: "h", multiSelect: false, options: [] }] }, makeOptions({ suggestions: [] }));
    assert.equal(result.behavior, "allow");
    assert.deepEqual(result.updatedPermissions, [{
      type: "addRules",
      rules: [{ toolName: "AskUserQuestion" }],
      behavior: "allow",
      destination: "localSettings"
    }]);
    assert.equal(notified.length, 1);
    assert.match(notified[0], /AskUserQuestion/);
  });
  test("prompt includes command text for Bash tools", async () => {
    let selectPrompt = "";
    const ui = {
      select: async (prompt) => {
        selectPrompt = prompt;
        return "Allow";
      }
    };
    const handler = createClaudeCodeCanUseToolHandler(ui);
    await handler("Bash", { command: "git status" }, makeOptions());
    assert.ok(selectPrompt.includes("git status"), `prompt should include command: ${selectPrompt}`);
  });
  test("prompt includes file_path for file tools", async () => {
    let selectPrompt = "";
    const ui = {
      select: async (prompt) => {
        selectPrompt = prompt;
        return "Allow";
      }
    };
    const handler = createClaudeCodeCanUseToolHandler(ui);
    await handler("Write", { file_path: "/tmp/test.txt", content: "hello" }, makeOptions());
    assert.ok(selectPrompt.includes("/tmp/test.txt"), `prompt should include file path: ${selectPrompt}`);
  });
  test("uses title from options when available", async () => {
    let selectPrompt = "";
    const ui = {
      select: async (prompt) => {
        selectPrompt = prompt;
        return "Allow";
      }
    };
    const handler = createClaudeCodeCanUseToolHandler(ui);
    await handler("WebFetch", {}, makeOptions({ title: "Claude wants to fetch: https://example.com" }));
    assert.ok(selectPrompt.includes("Claude wants to fetch: https://example.com"));
  });
  test("falls back to default title when options.title is missing", async () => {
    let selectPrompt = "";
    const ui = {
      select: async (prompt) => {
        selectPrompt = prompt;
        return "Allow";
      }
    };
    const handler = createClaudeCodeCanUseToolHandler(ui);
    await handler("WebFetch", { url: "https://example.com" }, makeOptions());
    assert.ok(selectPrompt.includes("Allow Claude Code to use: WebFetch?"));
  });
  test("returns deny when signal is already aborted", async () => {
    const ui = {
      select: async () => {
        throw new Error("should not be called");
      }
    };
    const controller = new AbortController();
    controller.abort();
    const handler = createClaudeCodeCanUseToolHandler(ui);
    const result = await handler("Bash", {}, makeOptions({ signal: controller.signal }));
    assert.equal(result.behavior, "deny");
    assert.equal(result.message, "Aborted");
  });
  test("returns deny when ui.select throws", async () => {
    const ui = {
      select: async () => {
        throw new Error("dialog crashed");
      }
    };
    const handler = createClaudeCodeCanUseToolHandler(ui);
    const result = await handler("Bash", {}, makeOptions());
    assert.equal(result.behavior, "deny");
    assert.equal(result.message, "Aborted");
  });
  test("buildSdkOptions passes canUseTool through extraOptions", () => {
    const canUseTool = async () => ({ behavior: "allow", updatedInput: {}, toolUseID: "test" });
    const opts = buildSdkOptions("claude-sonnet-4-6", "test", void 0, { canUseTool });
    assert.equal(opts.canUseTool, canUseTool);
  });
  test("Always Allow shows level picker and user broadens to base command", async () => {
    const cleanup = withIsolatedCwd();
    try {
      const prompts = [];
      const levelOpts = [];
      let selectCall = 0;
      const ui = {
        select: async (prompt, opts) => {
          prompts.push(prompt);
          selectCall++;
          if (selectCall === 1) return opts.find((o) => o.startsWith("Always Allow"));
          levelOpts.push(opts);
          return "Bash(gh:*)";
        },
        notify: () => {
        }
      };
      const handler = createClaudeCodeCanUseToolHandler(ui);
      const result = await handler("Bash", { command: "gh pr list" }, makeOptions());
      assert.equal(result.behavior, "allow");
      assert.deepEqual(result.updatedPermissions, [{
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "gh:*" }],
        behavior: "allow",
        destination: "localSettings"
      }]);
      assert.deepEqual(levelOpts[0], [
        "Bash(gh:*)",
        "Bash(gh pr:*)",
        "Bash(gh pr list:*)"
      ]);
      assert.ok(prompts[1].includes("Save permission at which level?"));
    } finally {
      cleanup();
    }
  });
  test("Always Allow narrows to mid-level pattern when user picks Bash(gh pr:*)", async () => {
    const cleanup = withIsolatedCwd();
    try {
      let selectCall = 0;
      const ui = {
        select: async (_p, opts) => {
          selectCall++;
          if (selectCall === 1) return opts.find((o) => o.startsWith("Always Allow"));
          return "Bash(gh pr:*)";
        },
        notify: () => {
        }
      };
      const handler = createClaudeCodeCanUseToolHandler(ui);
      const result = await handler("Bash", { command: "gh pr list --limit 5" }, makeOptions());
      assert.equal(result.behavior, "allow");
      assert.deepEqual(result.updatedPermissions, [{
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "gh pr:*" }],
        behavior: "allow",
        destination: "localSettings"
      }]);
    } finally {
      cleanup();
    }
  });
  test("Always Allow skips level picker when only one pattern is available", async () => {
    const cleanup = withIsolatedCwd();
    try {
      const prompts = [];
      const ui = {
        select: async (prompt, opts) => {
          prompts.push(prompt);
          return opts.find((o) => o.startsWith("Always Allow"));
        },
        notify: () => {
        }
      };
      const handler = createClaudeCodeCanUseToolHandler(ui);
      const result = await handler("Bash", { command: "ls -la /tmp" }, makeOptions());
      assert.equal(result.behavior, "allow");
      assert.equal(prompts.length, 1, "should not show a second dialog");
      assert.deepEqual(result.updatedPermissions, [{
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "ls:*" }],
        behavior: "allow",
        destination: "localSettings"
      }]);
    } finally {
      cleanup();
    }
  });
  test("Always Allow denies the tool when level picker is dismissed", async () => {
    const cleanup = withIsolatedCwd();
    try {
      const notified = [];
      let selectCall = 0;
      const ui = {
        select: async (_p, opts) => {
          selectCall++;
          if (selectCall === 1) return opts.find((o) => o.startsWith("Always Allow"));
          return void 0;
        },
        notify: (msg) => notified.push(msg)
      };
      const handler = createClaudeCodeCanUseToolHandler(ui);
      const result = await handler("Bash", { command: "gh pr list" }, makeOptions());
      assert.equal(result.behavior, "deny");
      assert.equal(result.updatedPermissions, void 0);
      assert.equal(notified.length, 0, "no 'Saved:' notification when nothing was saved");
    } finally {
      cleanup();
    }
  });
});
describe("buildBashPermissionPattern", () => {
  test("simple command wildcards all args", () => {
    assert.equal(buildBashPermissionPattern("ping -n 4 localhost"), "Bash(ping:*)");
    assert.equal(buildBashPermissionPattern("echo hello world"), "Bash(echo:*)");
    assert.equal(buildBashPermissionPattern("ls -la /tmp"), "Bash(ls:*)");
    assert.equal(buildBashPermissionPattern("node server.js"), "Bash(node:*)");
  });
  test("git captures one subcommand", () => {
    assert.equal(buildBashPermissionPattern("git push origin main"), "Bash(git push:*)");
    assert.equal(buildBashPermissionPattern("git log --oneline"), "Bash(git log:*)");
    assert.equal(buildBashPermissionPattern("git status"), "Bash(git status:*)");
  });
  test("gh captures two subcommands", () => {
    assert.equal(buildBashPermissionPattern("gh pr list"), "Bash(gh pr list:*)");
    assert.equal(buildBashPermissionPattern("gh pr create --title foo"), "Bash(gh pr create:*)");
    assert.equal(buildBashPermissionPattern("gh issue view 123"), "Bash(gh issue view:*)");
  });
  test("npm captures one subcommand", () => {
    assert.equal(buildBashPermissionPattern("npm install lodash"), "Bash(npm install:*)");
    assert.equal(buildBashPermissionPattern("npm publish"), "Bash(npm publish:*)");
    assert.equal(buildBashPermissionPattern("npm run test"), "Bash(npm run:*)");
  });
  test("npx captures package name", () => {
    assert.equal(buildBashPermissionPattern("npx vitest run"), "Bash(npx vitest:*)");
    assert.equal(buildBashPermissionPattern("npx --version"), "Bash(npx --version:*)");
  });
  test("docker captures one subcommand", () => {
    assert.equal(buildBashPermissionPattern("docker ps -a"), "Bash(docker ps:*)");
    assert.equal(buildBashPermissionPattern("docker rm container1"), "Bash(docker rm:*)");
  });
  test("aws captures two subcommands", () => {
    assert.equal(buildBashPermissionPattern("aws s3 cp file.txt s3://bucket/"), "Bash(aws s3 cp:*)");
    assert.equal(buildBashPermissionPattern("aws ec2 describe-instances"), "Bash(aws ec2 describe-instances:*)");
  });
  test("skips sudo wrapper", () => {
    assert.equal(buildBashPermissionPattern("sudo ping localhost"), "Bash(ping:*)");
    assert.equal(buildBashPermissionPattern("sudo git push"), "Bash(git push:*)");
  });
  test("skips env wrapper and VAR=val assignments", () => {
    assert.equal(buildBashPermissionPattern("env NODE_ENV=prod node server.js"), "Bash(node:*)");
    assert.equal(buildBashPermissionPattern("NODE_ENV=prod node server.js"), "Bash(node:*)");
    assert.equal(buildBashPermissionPattern("FOO=bar BAZ=qux git push"), "Bash(git push:*)");
  });
  test("strips path from executable", () => {
    assert.equal(buildBashPermissionPattern("/usr/bin/git push"), "Bash(git push:*)");
    assert.equal(buildBashPermissionPattern("C:\\Windows\\ping.exe localhost"), "Bash(ping:*)");
  });
  test("empty or whitespace-only command", () => {
    assert.equal(buildBashPermissionPattern(""), "Bash(*)");
    assert.equal(buildBashPermissionPattern("   "), "Bash(*)");
  });
  test("chained commands \u2014 extracts pattern from the meaningful segment", () => {
    assert.equal(buildBashPermissionPattern("cd /foo && gh pr list --limit 5"), "Bash(gh pr list:*)");
    assert.equal(buildBashPermissionPattern("cd C:/Users/djeff/repos/gsd-2 && gh pr list --limit 5"), "Bash(gh pr list:*)");
    assert.equal(buildBashPermissionPattern("cd /tmp && git push origin main"), "Bash(git push:*)");
    assert.equal(buildBashPermissionPattern("export FOO=1 && npm install lodash"), "Bash(npm install:*)");
    assert.equal(buildBashPermissionPattern("mkdir -p out; docker ps -a"), "Bash(docker ps:*)");
    assert.equal(buildBashPermissionPattern("echo start || ping localhost"), "Bash(ping:*)");
  });
  test("skips trailing || true / || : error suppressors", () => {
    assert.equal(
      buildBashPermissionPattern('cd C:/Users/djeff/repos/gsd-2 && gh pr create --dry-run --title "test" --body "test" 2>&1 || true'),
      "Bash(gh pr create:*)"
    );
    assert.equal(buildBashPermissionPattern("gh pr list || true"), "Bash(gh pr list:*)");
    assert.equal(buildBashPermissionPattern("git push || :"), "Bash(git push:*)");
    assert.equal(buildBashPermissionPattern("cd /tmp && npm install || echo failed"), "Bash(npm install:*)");
  });
  test("single command is unaffected by chain extraction", () => {
    assert.equal(buildBashPermissionPattern("gh pr list"), "Bash(gh pr list:*)");
    assert.equal(buildBashPermissionPattern("git push origin main"), "Bash(git push:*)");
  });
});
describe("buildBashPermissionPatternOptions", () => {
  test("offers every prefix from base to full subcommand chain", () => {
    assert.deepEqual(buildBashPermissionPatternOptions("gh pr list"), [
      "Bash(gh:*)",
      "Bash(gh pr:*)",
      "Bash(gh pr list:*)"
    ]);
    assert.deepEqual(buildBashPermissionPatternOptions("git push origin main"), [
      "Bash(git:*)",
      "Bash(git push:*)",
      "Bash(git push origin:*)",
      "Bash(git push origin main:*)"
    ]);
  });
  test("stops at first flag \u2014 flags are args, not verbs", () => {
    assert.deepEqual(buildBashPermissionPatternOptions("gh pr create --title foo"), [
      "Bash(gh:*)",
      "Bash(gh pr:*)",
      "Bash(gh pr create:*)"
    ]);
    assert.deepEqual(buildBashPermissionPatternOptions("git log --oneline"), [
      "Bash(git:*)",
      "Bash(git log:*)"
    ]);
  });
  test("single-option when there is no subcommand to choose from", () => {
    assert.deepEqual(buildBashPermissionPatternOptions("ls -la /tmp"), ["Bash(ls:*)"]);
    assert.deepEqual(buildBashPermissionPatternOptions("ping -n 4 localhost"), ["Bash(ping:*)"]);
    assert.deepEqual(buildBashPermissionPatternOptions("node"), ["Bash(node:*)"]);
  });
  test("extracts meaningful segment from compound commands", () => {
    assert.deepEqual(buildBashPermissionPatternOptions("cd /foo && gh pr list"), [
      "Bash(gh:*)",
      "Bash(gh pr:*)",
      "Bash(gh pr list:*)"
    ]);
    assert.deepEqual(buildBashPermissionPatternOptions("gh pr create --dry-run || true"), [
      "Bash(gh:*)",
      "Bash(gh pr:*)",
      "Bash(gh pr create:*)"
    ]);
  });
  test("caps at three subcommand tokens to keep the menu short", () => {
    const result = buildBashPermissionPatternOptions("foo bar baz qux quux corge");
    assert.equal(result.length, 4);
    assert.deepEqual(result, [
      "Bash(foo:*)",
      "Bash(foo bar:*)",
      "Bash(foo bar baz:*)",
      "Bash(foo bar baz qux:*)"
    ]);
  });
  test("skips sudo/env wrappers like the single-pattern variant", () => {
    assert.deepEqual(buildBashPermissionPatternOptions("sudo git push origin"), [
      "Bash(git:*)",
      "Bash(git push:*)",
      "Bash(git push origin:*)"
    ]);
    assert.deepEqual(buildBashPermissionPatternOptions("NODE_ENV=prod node server.js"), [
      "Bash(node:*)",
      "Bash(node server.js:*)"
    ]);
  });
  test("empty command returns the catch-all pattern", () => {
    assert.deepEqual(buildBashPermissionPatternOptions(""), ["Bash(*)"]);
    assert.deepEqual(buildBashPermissionPatternOptions("   "), ["Bash(*)"]);
  });
});
describe("bashCommandMatchesSavedRules \u2014 compound command bypass", () => {
  let tempDir;
  let originalCwd;
  function setupSettings(allow) {
    const claudeDir = join(tempDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "settings.local.json"),
      JSON.stringify({ permissions: { allow } })
    );
  }
  let origCwd;
  function setCwd(dir) {
    origCwd = process.cwd;
    process.cwd = () => dir;
  }
  function restoreCwd() {
    if (origCwd) process.cwd = origCwd;
  }
  test("matches cd-prefixed compound command against saved prefix rule", () => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rules-")));
    try {
      setupSettings(["Bash(gh pr list:*)"]);
      setCwd(tempDir);
      assert.equal(
        bashCommandMatchesSavedRules("cd /some/path && gh pr list --limit 5"),
        true
      );
    } finally {
      restoreCwd();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("matches cd-prefixed compound command with exact subcommand", () => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rules-")));
    try {
      setupSettings(["Bash(gh pr list:*)"]);
      setCwd(tempDir);
      assert.equal(
        bashCommandMatchesSavedRules("cd C:/Users/foo/repos/bar && gh pr list"),
        true
      );
    } finally {
      restoreCwd();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("rejects when leading segment is not cd", () => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rules-")));
    try {
      setupSettings(["Bash(gh pr list:*)"]);
      setCwd(tempDir);
      assert.equal(
        bashCommandMatchesSavedRules("rm -rf /tmp && gh pr list"),
        false
      );
    } finally {
      restoreCwd();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("rejects when meaningful segment does not match any rule", () => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rules-")));
    try {
      setupSettings(["Bash(gh pr list:*)"]);
      setCwd(tempDir);
      assert.equal(
        bashCommandMatchesSavedRules("cd /path && gh issue create --title foo"),
        false
      );
    } finally {
      restoreCwd();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("matches simple (non-compound) commands against on-disk rules", () => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rules-")));
    try {
      setupSettings(["Bash(gh pr list:*)"]);
      setCwd(tempDir);
      assert.equal(bashCommandMatchesSavedRules("gh pr list --limit 5"), true);
      assert.equal(bashCommandMatchesSavedRules("gh pr list"), true);
    } finally {
      restoreCwd();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("returns false for simple commands with no matching rule", () => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rules-")));
    try {
      setupSettings(["Bash(gh pr list:*)"]);
      setCwd(tempDir);
      assert.equal(bashCommandMatchesSavedRules("gh issue list --limit 5"), false);
    } finally {
      restoreCwd();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("returns false when no settings file exists", () => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rules-")));
    try {
      setCwd(tempDir);
      assert.equal(
        bashCommandMatchesSavedRules("cd /path && gh pr list"),
        false
      );
    } finally {
      restoreCwd();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("matches exact rule (non-prefix)", () => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rules-")));
    try {
      setupSettings(["Bash(ping -n 4 localhost)"]);
      setCwd(tempDir);
      assert.equal(
        bashCommandMatchesSavedRules("cd /path && ping -n 4 localhost"),
        true
      );
    } finally {
      restoreCwd();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("handles multiple cd segments before the meaningful command", () => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rules-")));
    try {
      setupSettings(["Bash(npm install:*)"]);
      setCwd(tempDir);
      assert.equal(
        bashCommandMatchesSavedRules("cd /home && cd project && npm install lodash"),
        true
      );
    } finally {
      restoreCwd();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("matches compound command with trailing || true suppressor", () => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rules-")));
    try {
      setupSettings(["Bash(gh pr create:*)"]);
      setCwd(tempDir);
      assert.equal(
        bashCommandMatchesSavedRules('cd C:/Users/djeff/repos/gsd-2 && gh pr create --dry-run --title "test" --body "test" 2>&1 || true'),
        true
      );
      assert.equal(
        bashCommandMatchesSavedRules("gh pr create --dry-run || true"),
        true
      );
      assert.equal(
        bashCommandMatchesSavedRules("cd /tmp && git push || :"),
        false
        // rule is for gh pr create, not git push
      );
    } finally {
      restoreCwd();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("reads rules from settings.json as well as settings.local.json", () => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-rules-")));
    try {
      const claudeDir = join(tempDir, ".claude");
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        join(claudeDir, "settings.json"),
        JSON.stringify({ permissions: { allow: ["Bash(git push:*)"] } })
      );
      setCwd(tempDir);
      assert.equal(
        bashCommandMatchesSavedRules("cd /repo && git push origin main"),
        true
      );
    } finally {
      restoreCwd();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2NsYXVkZS1jb2RlLWNsaS90ZXN0cy9zdHJlYW0tYWRhcHRlci50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBHU0QyIC0gQ2xhdWRlIENvZGUgc3RyZWFtIGFkYXB0ZXIgcmVncmVzc2lvbiB0ZXN0c1xuaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZGlyU3luYywgbWtkdGVtcFN5bmMsIHJlYWxwYXRoU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4sIHJlc29sdmUgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHtcblx0bWFrZVN0cmVhbUV4aGF1c3RlZEVycm9yTWVzc2FnZSxcblx0aXNDbGF1ZGVDb2RlQWJvcnRFcnJvck1lc3NhZ2UsXG5cdHJlc29sdmVDbGF1ZGVDb2RlQWJvcnRlZE1lc3NhZ2VUZXh0LFxuXHRnZXRSZXN1bHRFcnJvck1lc3NhZ2UsXG5cdG1ha2VBYm9ydGVkTWVzc2FnZSxcblx0bWVyZ2VQZW5kaW5nVG9vbENhbGxzLFxuXHRidWlsZEZpbmFsQXNzaXN0YW50Q29udGVudCxcblx0cmVzb2x2ZUNsYXVkZVBlcm1pc3Npb25Nb2RlLFxuXHRidWlsZFByb21wdEZyb21Db250ZXh0LFxuXHRidWlsZFNka1F1ZXJ5UHJvbXB0LFxuXHRidWlsZFNka09wdGlvbnMsXG5cdHJlc29sdmVDbGF1ZGVDb2RlQ3dkLFxuXHRjcmVhdGVDbGF1ZGVDb2RlQ2FuVXNlVG9vbEhhbmRsZXIsXG5cdGJ1aWxkQmFzaFBlcm1pc3Npb25QYXR0ZXJuLFxuXHRidWlsZEJhc2hQZXJtaXNzaW9uUGF0dGVybk9wdGlvbnMsXG5cdGJhc2hDb21tYW5kTWF0Y2hlc1NhdmVkUnVsZXMsXG5cdGNyZWF0ZUNsYXVkZUNvZGVFbGljaXRhdGlvbkhhbmRsZXIsXG5cdGV4dHJhY3RJbWFnZUJsb2Nrc0Zyb21Db250ZXh0LFxuXHRleHRyYWN0VG9vbFJlc3VsdHNGcm9tU2RrVXNlck1lc3NhZ2UsXG5cdGdldENsYXVkZUxvb2t1cENvbW1hbmQsXG5cdHBhcnNlQXNrVXNlclF1ZXN0aW9uc0VsaWNpdGF0aW9uLFxuXHRwYXJzZVRleHRJbnB1dEVsaWNpdGF0aW9uLFxuXHRwYXJzZUNsYXVkZUxvb2t1cE91dHB1dCxcblx0cmVzb2x2ZUJ1bmRsZWRDbGF1ZGVDbGlQYXRoLFxuXHRub3JtYWxpemVDbGF1ZGVQYXRoRm9yU2RrLFxuXHRyb3VuZFJlc3VsdFRvRWxpY2l0YXRpb25Db250ZW50LFxufSBmcm9tIFwiLi4vc3RyZWFtLWFkYXB0ZXIudHNcIjtcbmltcG9ydCB0eXBlIHsgQXNzaXN0YW50TWVzc2FnZSwgQ29udGV4dCwgTWVzc2FnZSB9IGZyb20gXCJAZ3NkL3BpLWFpXCI7XG5pbXBvcnQgdHlwZSB7IFNES1VzZXJNZXNzYWdlIH0gZnJvbSBcIi4uL3Nkay10eXBlcy50c1wiO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIEVudiBoZWxwZXJzIFx1MjAxNCBgR1NEX1dPUktGTE9XX01DUF8qYCBzYXZlL3Jlc3RvcmVcbi8vXG4vLyBUaGUgbmFpdmUgcGF0dGVybiBgcHJvY2Vzcy5lbnYuWCA9IHByZXYuWGAgYnJlYWtzIHdoZW4gYHByZXYuWGAgaXNcbi8vIHVuZGVmaW5lZDogTm9kZSBjb2VyY2VzIHRoZSBhc3NpZ25tZW50IHRvIHRoZSBsaXRlcmFsIHN0cmluZ1xuLy8gXCJ1bmRlZmluZWRcIiwgd2hpY2ggdGhlbiBwb2xsdXRlcyBzdWJzZXF1ZW50IHRlc3RzIHRoYXQgcmVhZCB0aGUgdmFyXG4vLyBhbmQgYXNzdW1lIGl0J3MgYWJzZW50LiBJc3N1ZSAjNDgwOCBkb2N1bWVudHMgdGhlIHJlc3VsdGluZyBibGVlZC5cbi8vXG4vLyBgc2V0V29ya2Zsb3dNY3BFbnZgIHJldHVybnMgYSBgcmVzdG9yZSgpYCBjbG9zdXJlIHRoYXQgZWl0aGVyXG4vLyByZS1hc3NpZ25zIHRoZSBwcmV2aW91cyBzdHJpbmcgdmFsdWUgT1IgYGRlbGV0ZWBzIHRoZSBrZXkgd2hlbiB0aGVcbi8vIG9yaWdpbmFsIHdhcyBhYnNlbnQuIENhbGwgaW4gYSB0cnkvZmluYWxseTsgcmVzdG9yZSBpbiB0aGUgZmluYWxseS5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5jb25zdCBXT1JLRkxPV19NQ1BfRU5WX0tFWVMgPSBbXG5cdFwiR1NEX1dPUktGTE9XX01DUF9DT01NQU5EXCIsXG5cdFwiR1NEX1dPUktGTE9XX01DUF9OQU1FXCIsXG5cdFwiR1NEX1dPUktGTE9XX01DUF9BUkdTXCIsXG5cdFwiR1NEX1dPUktGTE9XX01DUF9FTlZcIixcblx0XCJHU0RfV09SS0ZMT1dfTUNQX0NXRFwiLFxuXHRcIkdTRF9QUk9KRUNUX1JPT1RcIixcblx0XCJHU0RfV09SS0ZMT1dfUFJPSkVDVF9ST09UXCIsXG5dIGFzIGNvbnN0O1xuXG50eXBlIFdvcmtmbG93TWNwRW52S2V5ID0gKHR5cGVvZiBXT1JLRkxPV19NQ1BfRU5WX0tFWVMpW251bWJlcl07XG5cbmZ1bmN0aW9uIHNldFdvcmtmbG93TWNwRW52KFxuXHR2YWx1ZXM6IFBhcnRpYWw8UmVjb3JkPFdvcmtmbG93TWNwRW52S2V5LCBzdHJpbmc+Pixcbik6ICgpID0+IHZvaWQge1xuXHRjb25zdCBwcmV2OiBQYXJ0aWFsPFJlY29yZDxXb3JrZmxvd01jcEVudktleSwgc3RyaW5nIHwgdW5kZWZpbmVkPj4gPSB7fTtcblx0Zm9yIChjb25zdCBrZXkgb2YgV09SS0ZMT1dfTUNQX0VOVl9LRVlTKSB7XG5cdFx0cHJldltrZXldID0gcHJvY2Vzcy5lbnZba2V5XTtcblx0XHQvLyBDbGVhciBhbGwgbWFuYWdlZCBrZXlzIHNvIHRlc3RzIHJ1biBpbiBhIGNsZWFuIGVudiBzdGF0ZS5cblx0XHQvLyBLZXlzIHByZXNlbnQgaW4gYHZhbHVlc2AgYXJlIHNldCB0byB0aGUgZGVzaXJlZCB0ZXN0IHZhbHVlIGJlbG93LlxuXHRcdGRlbGV0ZSBwcm9jZXNzLmVudltrZXldO1xuXHR9XG5cdGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHZhbHVlcykpIHtcblx0XHRwcm9jZXNzLmVudltrZXldID0gdmFsdWU7XG5cdH1cblx0cmV0dXJuIGZ1bmN0aW9uIHJlc3RvcmUoKSB7XG5cdFx0Zm9yIChjb25zdCBrZXkgb2YgV09SS0ZMT1dfTUNQX0VOVl9LRVlTKSB7XG5cdFx0XHRjb25zdCBwcmV2aW91cyA9IHByZXZba2V5XTtcblx0XHRcdGlmIChwcmV2aW91cyA9PT0gdW5kZWZpbmVkKSB7XG5cdFx0XHRcdGRlbGV0ZSBwcm9jZXNzLmVudltrZXldO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0cHJvY2Vzcy5lbnZba2V5XSA9IHByZXZpb3VzO1xuXHRcdFx0fVxuXHRcdH1cblx0fTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBFeGlzdGluZyB0ZXN0cyBcdTIwMTQgZXhoYXVzdGVkIHN0cmVhbSBmYWxsYmFjayAoIzI1NzUpXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZGVzY3JpYmUoXCJzdHJlYW0tYWRhcHRlciBcdTIwMTQgZXhoYXVzdGVkIHN0cmVhbSBmYWxsYmFjayAoIzI1NzUpXCIsICgpID0+IHtcblx0dGVzdChcImdlbmVyYXRvciBleGhhdXN0aW9uIGJlY29tZXMgYW4gZXJyb3IgbWVzc2FnZSBpbnN0ZWFkIG9mIGNsZWFuIGNvbXBsZXRpb25cIiwgKCkgPT4ge1xuXHRcdGNvbnN0IG1lc3NhZ2UgPSBtYWtlU3RyZWFtRXhoYXVzdGVkRXJyb3JNZXNzYWdlKFwiY2xhdWRlLXNvbm5ldC00LTIwMjUwNTE0XCIsIFwicGFydGlhbCBhbnN3ZXJcIik7XG5cblx0XHRhc3NlcnQuZXF1YWwobWVzc2FnZS5zdG9wUmVhc29uLCBcImVycm9yXCIpO1xuXHRcdGFzc2VydC5lcXVhbChtZXNzYWdlLmVycm9yTWVzc2FnZSwgXCJzdHJlYW1fZXhoYXVzdGVkX3dpdGhvdXRfcmVzdWx0XCIpO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwobWVzc2FnZS5jb250ZW50LCBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJwYXJ0aWFsIGFuc3dlclwiIH1dKTtcblx0fSk7XG5cblx0dGVzdChcImdlbmVyYXRvciBleGhhdXN0aW9uIHdpdGhvdXQgcHJpb3IgdGV4dCBzdGlsbCBleHBvc2VzIGEgY2xhc3NpZmlhYmxlIGVycm9yXCIsICgpID0+IHtcblx0XHRjb25zdCBtZXNzYWdlID0gbWFrZVN0cmVhbUV4aGF1c3RlZEVycm9yTWVzc2FnZShcImNsYXVkZS1zb25uZXQtNC0yMDI1MDUxNFwiLCBcIlwiKTtcblxuXHRcdGFzc2VydC5lcXVhbChtZXNzYWdlLnN0b3BSZWFzb24sIFwiZXJyb3JcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKG1lc3NhZ2UuZXJyb3JNZXNzYWdlLCBcInN0cmVhbV9leGhhdXN0ZWRfd2l0aG91dF9yZXN1bHRcIik7XG5cdFx0YXNzZXJ0Lm1hdGNoKFN0cmluZygobWVzc2FnZS5jb250ZW50WzBdIGFzIGFueSk/LnRleHQgPz8gXCJcIiksIC9DbGF1ZGUgQ29kZSBlcnJvcjogc3RyZWFtX2V4aGF1c3RlZF93aXRob3V0X3Jlc3VsdC8pO1xuXHR9KTtcbn0pO1xuXG5kZXNjcmliZShcInN0cmVhbS1hZGFwdGVyIFx1MjAxNCByZXN1bHQgZXJyb3IgdGV4dCAoIzM3NzYpXCIsICgpID0+IHtcblx0dGVzdChcInByZWZlcnMgU0RLIHJlc3VsdCB0ZXh0IHdoZW4gYW4gZXJyb3IgYXJyaXZlcyB3aXRoIHN1YnR5cGUgc3VjY2Vzc1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgbWVzc2FnZSA9IGdldFJlc3VsdEVycm9yTWVzc2FnZSh7XG5cdFx0XHR0eXBlOiBcInJlc3VsdFwiLFxuXHRcdFx0c3VidHlwZTogXCJzdWNjZXNzXCIsXG5cdFx0XHR1dWlkOiBcInV1aWQtMVwiLFxuXHRcdFx0c2Vzc2lvbl9pZDogXCJzZXNzaW9uLTFcIixcblx0XHRcdGR1cmF0aW9uX21zOiAxLFxuXHRcdFx0ZHVyYXRpb25fYXBpX21zOiAxLFxuXHRcdFx0aXNfZXJyb3I6IHRydWUsXG5cdFx0XHRudW1fdHVybnM6IDEsXG5cdFx0XHRyZXN1bHQ6ICdBUEkgRXJyb3I6IDUyOSB7XCJ0eXBlXCI6XCJlcnJvclwiLFwiZXJyb3JcIjp7XCJ0eXBlXCI6XCJvdmVybG9hZGVkX2Vycm9yXCIsXCJtZXNzYWdlXCI6XCJPdmVybG9hZGVkXCJ9fScsXG5cdFx0XHRzdG9wX3JlYXNvbjogbnVsbCxcblx0XHRcdHRvdGFsX2Nvc3RfdXNkOiAwLFxuXHRcdFx0dXNhZ2U6IHtcblx0XHRcdFx0aW5wdXRfdG9rZW5zOiAwLFxuXHRcdFx0XHRvdXRwdXRfdG9rZW5zOiAwLFxuXHRcdFx0XHRjYWNoZV9yZWFkX2lucHV0X3Rva2VuczogMCxcblx0XHRcdFx0Y2FjaGVfY3JlYXRpb25faW5wdXRfdG9rZW5zOiAwLFxuXHRcdFx0fSxcblx0XHR9KTtcblxuXHRcdGFzc2VydC5tYXRjaChtZXNzYWdlLCAvQVBJIEVycm9yOiA1MjkvKTtcblx0XHRhc3NlcnQuZG9lc05vdE1hdGNoKG1lc3NhZ2UsIC9ec3VjY2VzcyQvaSk7XG5cdH0pO1xuXG5cdHRlc3QoXCJmYWxscyBiYWNrIHRvIGEgc3RhYmxlIGNsYXNzaWZpZXIgd2hlbiBzdWNjZXNzIGVycm9ycyBoYXZlIG5vIHRleHRcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IG1lc3NhZ2UgPSBnZXRSZXN1bHRFcnJvck1lc3NhZ2Uoe1xuXHRcdFx0dHlwZTogXCJyZXN1bHRcIixcblx0XHRcdHN1YnR5cGU6IFwic3VjY2Vzc1wiLFxuXHRcdFx0dXVpZDogXCJ1dWlkLTJcIixcblx0XHRcdHNlc3Npb25faWQ6IFwic2Vzc2lvbi0yXCIsXG5cdFx0XHRkdXJhdGlvbl9tczogMSxcblx0XHRcdGR1cmF0aW9uX2FwaV9tczogMSxcblx0XHRcdGlzX2Vycm9yOiB0cnVlLFxuXHRcdFx0bnVtX3R1cm5zOiAxLFxuXHRcdFx0cmVzdWx0OiBcIiAgIFwiLFxuXHRcdFx0c3RvcF9yZWFzb246IG51bGwsXG5cdFx0XHR0b3RhbF9jb3N0X3VzZDogMCxcblx0XHRcdHVzYWdlOiB7XG5cdFx0XHRcdGlucHV0X3Rva2VuczogMCxcblx0XHRcdFx0b3V0cHV0X3Rva2VuczogMCxcblx0XHRcdFx0Y2FjaGVfcmVhZF9pbnB1dF90b2tlbnM6IDAsXG5cdFx0XHRcdGNhY2hlX2NyZWF0aW9uX2lucHV0X3Rva2VuczogMCxcblx0XHRcdH0sXG5cdFx0fSk7XG5cblx0XHRhc3NlcnQuZXF1YWwobWVzc2FnZSwgXCJjbGF1ZGVfY29kZV9yZXF1ZXN0X2ZhaWxlZFwiKTtcblx0fSk7XG59KTtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBCdWcgIzI4NTkgXHUyMDE0IHN0YXRlbGVzcyBwcm92aWRlciByZWdyZXNzaW9uIHRlc3RzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZGVzY3JpYmUoXCJzdHJlYW0tYWRhcHRlciBcdTIwMTQgZnVsbCBjb250ZXh0IHByb21wdCAoIzI4NTkpXCIsICgpID0+IHtcblx0dGVzdChcImJ1aWxkUHJvbXB0RnJvbUNvbnRleHQgaW5jbHVkZXMgYWxsIHVzZXIgYW5kIGFzc2lzdGFudCBtZXNzYWdlcywgbm90IGp1c3QgdGhlIGxhc3QgdXNlciBtZXNzYWdlXCIsICgpID0+IHtcblx0XHRjb25zdCBjb250ZXh0OiBDb250ZXh0ID0ge1xuXHRcdFx0c3lzdGVtUHJvbXB0OiBcIllvdSBhcmUgYSBoZWxwZnVsIGFzc2lzdGFudC5cIixcblx0XHRcdG1lc3NhZ2VzOiBbXG5cdFx0XHRcdHsgcm9sZTogXCJ1c2VyXCIsIGNvbnRlbnQ6IFwiV2hhdCBpcyAyKzI/XCIgfSBhcyBNZXNzYWdlLFxuXHRcdFx0XHR7XG5cdFx0XHRcdFx0cm9sZTogXCJhc3Npc3RhbnRcIixcblx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCI0XCIgfV0sXG5cdFx0XHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0XHRcdHByb3ZpZGVyOiBcImNsYXVkZS1jb2RlXCIsXG5cdFx0XHRcdFx0bW9kZWw6IFwiY2xhdWRlLXNvbm5ldC00LTIwMjUwNTE0XCIsXG5cdFx0XHRcdFx0dXNhZ2U6IHsgaW5wdXQ6IDAsIG91dHB1dDogMCwgY2FjaGVSZWFkOiAwLCBjYWNoZVdyaXRlOiAwLCB0b3RhbFRva2VuczogMCwgY29zdDogeyBpbnB1dDogMCwgb3V0cHV0OiAwLCBjYWNoZVJlYWQ6IDAsIGNhY2hlV3JpdGU6IDAsIHRvdGFsOiAwIH0gfSxcblx0XHRcdFx0XHRzdG9wUmVhc29uOiBcInN0b3BcIixcblx0XHRcdFx0XHR0aW1lc3RhbXA6IERhdGUubm93KCksXG5cdFx0XHRcdH0gYXMgTWVzc2FnZSxcblx0XHRcdFx0eyByb2xlOiBcInVzZXJcIiwgY29udGVudDogXCJOb3cgbXVsdGlwbHkgdGhhdCBieSAzXCIgfSBhcyBNZXNzYWdlLFxuXHRcdFx0XSxcblx0XHR9O1xuXG5cdFx0Y29uc3QgcHJvbXB0ID0gYnVpbGRQcm9tcHRGcm9tQ29udGV4dChjb250ZXh0KTtcblxuXHRcdC8vIE11c3QgY29udGFpbiBjb250ZW50IGZyb20gQk9USCB1c2VyIG1lc3NhZ2VzLCBub3QganVzdCB0aGUgbGFzdFxuXHRcdGFzc2VydC5vayhwcm9tcHQuaW5jbHVkZXMoXCIyKzJcIiksIFwicHJvbXB0IG11c3QgaW5jbHVkZSBmaXJzdCB1c2VyIG1lc3NhZ2VcIik7XG5cdFx0YXNzZXJ0Lm9rKHByb21wdC5pbmNsdWRlcyhcIm11bHRpcGx5XCIpLCBcInByb21wdCBtdXN0IGluY2x1ZGUgc2Vjb25kIHVzZXIgbWVzc2FnZVwiKTtcblx0XHQvLyBNdXN0IGNvbnRhaW4gYXNzaXN0YW50IHJlc3BvbnNlIGZvciBjb250aW51aXR5XG5cdFx0YXNzZXJ0Lm9rKHByb21wdC5pbmNsdWRlcyhcIjRcIiksIFwicHJvbXB0IG11c3QgaW5jbHVkZSBhc3Npc3RhbnQgcmVwbHkgZm9yIGNvbnRleHRcIik7XG5cdH0pO1xuXG5cdHRlc3QoXCJidWlsZFByb21wdEZyb21Db250ZXh0IGluY2x1ZGVzIHN5c3RlbSBwcm9tcHQgd2hlbiBwcmVzZW50XCIsICgpID0+IHtcblx0XHRjb25zdCBjb250ZXh0OiBDb250ZXh0ID0ge1xuXHRcdFx0c3lzdGVtUHJvbXB0OiBcIllvdSBhcmUgYSBjb2RpbmcgYXNzaXN0YW50LlwiLFxuXHRcdFx0bWVzc2FnZXM6IFtcblx0XHRcdFx0eyByb2xlOiBcInVzZXJcIiwgY29udGVudDogXCJXcml0ZSBhIGZ1bmN0aW9uXCIgfSBhcyBNZXNzYWdlLFxuXHRcdFx0XSxcblx0XHR9O1xuXG5cdFx0Y29uc3QgcHJvbXB0ID0gYnVpbGRQcm9tcHRGcm9tQ29udGV4dChjb250ZXh0KTtcblx0XHRhc3NlcnQub2socHJvbXB0LmluY2x1ZGVzKFwiY29kaW5nIGFzc2lzdGFudFwiKSwgXCJwcm9tcHQgbXVzdCBpbmNsdWRlIHN5c3RlbSBwcm9tcHRcIik7XG5cdH0pO1xuXG5cdHRlc3QoXCJidWlsZFByb21wdEZyb21Db250ZXh0IGhhbmRsZXMgYXJyYXkgY29udGVudCBwYXJ0cyBpbiB1c2VyIG1lc3NhZ2VzXCIsICgpID0+IHtcblx0XHRjb25zdCBjb250ZXh0OiBDb250ZXh0ID0ge1xuXHRcdFx0bWVzc2FnZXM6IFtcblx0XHRcdFx0e1xuXHRcdFx0XHRcdHJvbGU6IFwidXNlclwiLFxuXHRcdFx0XHRcdGNvbnRlbnQ6IFtcblx0XHRcdFx0XHRcdHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiRmlyc3QgcGFydFwiIH0sXG5cdFx0XHRcdFx0XHR7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIlNlY29uZCBwYXJ0XCIgfSxcblx0XHRcdFx0XHRdLFxuXHRcdFx0XHR9IGFzIE1lc3NhZ2UsXG5cdFx0XHRcdHsgcm9sZTogXCJ1c2VyXCIsIGNvbnRlbnQ6IFwiRm9sbG93LXVwXCIgfSBhcyBNZXNzYWdlLFxuXHRcdFx0XSxcblx0XHR9O1xuXG5cdFx0Y29uc3QgcHJvbXB0ID0gYnVpbGRQcm9tcHRGcm9tQ29udGV4dChjb250ZXh0KTtcblx0XHRhc3NlcnQub2socHJvbXB0LmluY2x1ZGVzKFwiRmlyc3QgcGFydFwiKSwgXCJwcm9tcHQgbXVzdCBpbmNsdWRlIGFycmF5IGNvbnRlbnQgcGFydHNcIik7XG5cdFx0YXNzZXJ0Lm9rKHByb21wdC5pbmNsdWRlcyhcIlNlY29uZCBwYXJ0XCIpLCBcInByb21wdCBtdXN0IGluY2x1ZGUgYWxsIHRleHQgcGFydHNcIik7XG5cdFx0YXNzZXJ0Lm9rKHByb21wdC5pbmNsdWRlcyhcIkZvbGxvdy11cFwiKSwgXCJwcm9tcHQgbXVzdCBpbmNsdWRlIGZvbGxvdy11cCBtZXNzYWdlXCIpO1xuXHR9KTtcblxuXHR0ZXN0KFwiYnVpbGRQcm9tcHRGcm9tQ29udGV4dCByZXR1cm5zIGVtcHR5IHN0cmluZyBmb3IgZW1wdHkgbWVzc2FnZXNcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGNvbnRleHQ6IENvbnRleHQgPSB7IG1lc3NhZ2VzOiBbXSB9O1xuXHRcdGNvbnN0IHByb21wdCA9IGJ1aWxkUHJvbXB0RnJvbUNvbnRleHQoY29udGV4dCk7XG5cdFx0YXNzZXJ0LmVxdWFsKHByb21wdCwgXCJcIik7XG5cdH0pO1xufSk7XG5cbmRlc2NyaWJlKFwic3RyZWFtLWFkYXB0ZXIgXHUyMDE0IGltYWdlIHByb21wdCBmb3J3YXJkaW5nICgjNDE4MylcIiwgKCkgPT4ge1xuXHR0ZXN0KFwiZXh0cmFjdEltYWdlQmxvY2tzRnJvbUNvbnRleHQgbWFwcyB1c2VyIGltYWdlIHBhcnRzIHRvIEFudGhyb3BpYyBiYXNlNjQgaW1hZ2UgYmxvY2tzXCIsICgpID0+IHtcblx0XHRjb25zdCBjb250ZXh0OiBDb250ZXh0ID0ge1xuXHRcdFx0bWVzc2FnZXM6IFtcblx0XHRcdFx0e1xuXHRcdFx0XHRcdHJvbGU6IFwidXNlclwiLFxuXHRcdFx0XHRcdGNvbnRlbnQ6IFtcblx0XHRcdFx0XHRcdHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwibG9va1wiIH0sXG5cdFx0XHRcdFx0XHR7XG5cdFx0XHRcdFx0XHRcdHR5cGU6IFwiaW1hZ2VcIixcblx0XHRcdFx0XHRcdFx0ZGF0YTogXCJkYXRhOmltYWdlL3BuZztiYXNlNjQsYWJjMTIzXCIsXG5cdFx0XHRcdFx0XHRcdG1pbWVUeXBlOiBcImltYWdlL3BuZ1wiLFxuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRdLFxuXHRcdFx0XHR9IGFzIE1lc3NhZ2UsXG5cdFx0XHRdLFxuXHRcdH07XG5cblx0XHRjb25zdCBpbWFnZUJsb2NrcyA9IGV4dHJhY3RJbWFnZUJsb2Nrc0Zyb21Db250ZXh0KGNvbnRleHQpO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwoaW1hZ2VCbG9ja3MsIFtcblx0XHRcdHtcblx0XHRcdFx0dHlwZTogXCJpbWFnZVwiLFxuXHRcdFx0XHRzb3VyY2U6IHtcblx0XHRcdFx0XHR0eXBlOiBcImJhc2U2NFwiLFxuXHRcdFx0XHRcdG1lZGlhX3R5cGU6IFwiaW1hZ2UvcG5nXCIsXG5cdFx0XHRcdFx0ZGF0YTogXCJhYmMxMjNcIixcblx0XHRcdFx0fSxcblx0XHRcdH0sXG5cdFx0XSk7XG5cdH0pO1xuXG5cdHRlc3QoXCJidWlsZFNka1F1ZXJ5UHJvbXB0IHJldHVybnMgcGxhaW4gc3RyaW5nIHdoZW4gbm8gaW1hZ2VzIGV4aXN0IGluIGNvbnRleHRcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGNvbnRleHQ6IENvbnRleHQgPSB7XG5cdFx0XHRtZXNzYWdlczogW3sgcm9sZTogXCJ1c2VyXCIsIGNvbnRlbnQ6IFwiaGVsbG9cIiB9IGFzIE1lc3NhZ2VdLFxuXHRcdH07XG5cdFx0Y29uc3QgdGV4dFByb21wdCA9IGJ1aWxkUHJvbXB0RnJvbUNvbnRleHQoY29udGV4dCk7XG5cblx0XHRjb25zdCBwcm9tcHQgPSBidWlsZFNka1F1ZXJ5UHJvbXB0KGNvbnRleHQsIHRleHRQcm9tcHQpO1xuXHRcdGFzc2VydC5lcXVhbCh0eXBlb2YgcHJvbXB0LCBcInN0cmluZ1wiKTtcblx0XHRhc3NlcnQuZXF1YWwocHJvbXB0LCB0ZXh0UHJvbXB0KTtcblx0fSk7XG5cblx0dGVzdChcImJ1aWxkU2RrUXVlcnlQcm9tcHQgd3JhcHMgaW1hZ2VzIGFuZCBwcm9tcHQgdGV4dCBpbiBhbiBTREsgdXNlciBtZXNzYWdlIGl0ZXJhYmxlXCIsIGFzeW5jICgpID0+IHtcblx0XHRjb25zdCBjb250ZXh0OiBDb250ZXh0ID0ge1xuXHRcdFx0bWVzc2FnZXM6IFtcblx0XHRcdFx0e1xuXHRcdFx0XHRcdHJvbGU6IFwidXNlclwiLFxuXHRcdFx0XHRcdGNvbnRlbnQ6IFtcblx0XHRcdFx0XHRcdHsgdHlwZTogXCJpbWFnZVwiLCBkYXRhOiBcIlptRnJaUT09XCIsIG1pbWVUeXBlOiBcImltYWdlL2pwZWdcIiB9LFxuXHRcdFx0XHRcdFx0eyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJXaGF0IGlzIGluIHRoaXMgaW1hZ2U/XCIgfSxcblx0XHRcdFx0XHRdLFxuXHRcdFx0XHR9IGFzIE1lc3NhZ2UsXG5cdFx0XHRdLFxuXHRcdH07XG5cdFx0Y29uc3QgdGV4dFByb21wdCA9IGJ1aWxkUHJvbXB0RnJvbUNvbnRleHQoY29udGV4dCk7XG5cblx0XHRjb25zdCBwcm9tcHQgPSBidWlsZFNka1F1ZXJ5UHJvbXB0KGNvbnRleHQsIHRleHRQcm9tcHQpO1xuXHRcdGFzc2VydC5ub3RFcXVhbCh0eXBlb2YgcHJvbXB0LCBcInN0cmluZ1wiKTtcblx0XHRhc3NlcnQub2socHJvbXB0ICYmIHR5cGVvZiAocHJvbXB0IGFzIGFueSlbU3ltYm9sLmFzeW5jSXRlcmF0b3JdID09PSBcImZ1bmN0aW9uXCIpO1xuXG5cdFx0Y29uc3QgbWVzc2FnZXM6IGFueVtdID0gW107XG5cdFx0Zm9yIGF3YWl0IChjb25zdCBpdGVtIG9mIHByb21wdCBhcyBBc3luY0l0ZXJhYmxlPGFueT4pIHtcblx0XHRcdG1lc3NhZ2VzLnB1c2goaXRlbSk7XG5cdFx0fVxuXHRcdGFzc2VydC5lcXVhbChtZXNzYWdlcy5sZW5ndGgsIDEpO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwobWVzc2FnZXNbMF0sIHtcblx0XHRcdHR5cGU6IFwidXNlclwiLFxuXHRcdFx0bWVzc2FnZToge1xuXHRcdFx0XHRyb2xlOiBcInVzZXJcIixcblx0XHRcdFx0Y29udGVudDogW1xuXHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdHR5cGU6IFwiaW1hZ2VcIixcblx0XHRcdFx0XHRcdHNvdXJjZToge1xuXHRcdFx0XHRcdFx0XHR0eXBlOiBcImJhc2U2NFwiLFxuXHRcdFx0XHRcdFx0XHRtZWRpYV90eXBlOiBcImltYWdlL2pwZWdcIixcblx0XHRcdFx0XHRcdFx0ZGF0YTogXCJabUZyWlE9PVwiLFxuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IHRleHRQcm9tcHQgfSxcblx0XHRcdFx0XSxcblx0XHRcdH0sXG5cdFx0XHRwYXJlbnRfdG9vbF91c2VfaWQ6IG51bGwsXG5cdFx0fSk7XG5cdH0pO1xufSk7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gQnVnICM0MTAyIFx1MjAxNCB0cmFuc2NyaXB0IGZhYnJpY2F0aW9uIHJlZ3Jlc3Npb24gdGVzdHNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5kZXNjcmliZShcInN0cmVhbS1hZGFwdGVyIFx1MjAxNCBubyB0cmFuc2NyaXB0IGZhYnJpY2F0aW9uICgjNDEwMilcIiwgKCkgPT4ge1xuXHR0ZXN0KFwiYnVpbGRQcm9tcHRGcm9tQ29udGV4dCBuZXZlciBlbWl0cyBmb3JiaWRkZW4gW1VzZXJdL1tBc3Npc3RhbnRdIGJyYWNrZXQgaGVhZGVyc1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgY29udGV4dDogQ29udGV4dCA9IHtcblx0XHRcdHN5c3RlbVByb21wdDogXCJZb3UgYXJlIGEgaGVscGZ1bCBhc3Npc3RhbnQuXCIsXG5cdFx0XHRtZXNzYWdlczogW1xuXHRcdFx0XHR7IHJvbGU6IFwidXNlclwiLCBjb250ZW50OiBcIkZpcnN0XCIgfSBhcyBNZXNzYWdlLFxuXHRcdFx0XHR7XG5cdFx0XHRcdFx0cm9sZTogXCJhc3Npc3RhbnRcIixcblx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJTZWNvbmRcIiB9XSxcblx0XHRcdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRcdFx0cHJvdmlkZXI6IFwiY2xhdWRlLWNvZGVcIixcblx0XHRcdFx0XHRtb2RlbDogXCJjbGF1ZGUtc29ubmV0LTQtMjAyNTA1MTRcIixcblx0XHRcdFx0XHR1c2FnZTogeyBpbnB1dDogMCwgb3V0cHV0OiAwLCBjYWNoZVJlYWQ6IDAsIGNhY2hlV3JpdGU6IDAsIHRvdGFsVG9rZW5zOiAwLCBjb3N0OiB7IGlucHV0OiAwLCBvdXRwdXQ6IDAsIGNhY2hlUmVhZDogMCwgY2FjaGVXcml0ZTogMCwgdG90YWw6IDAgfSB9LFxuXHRcdFx0XHRcdHN0b3BSZWFzb246IFwic3RvcFwiLFxuXHRcdFx0XHRcdHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcblx0XHRcdFx0fSBhcyBNZXNzYWdlLFxuXHRcdFx0XHR7IHJvbGU6IFwidXNlclwiLCBjb250ZW50OiBcIlRoaXJkXCIgfSBhcyBNZXNzYWdlLFxuXHRcdFx0XSxcblx0XHR9O1xuXG5cdFx0Y29uc3QgcHJvbXB0ID0gYnVpbGRQcm9tcHRGcm9tQ29udGV4dChjb250ZXh0KTtcblxuXHRcdGFzc2VydC5vayghcHJvbXB0LmluY2x1ZGVzKFwiW1VzZXJdXCIpLCBcInByb21wdCBtdXN0IG5vdCBpbmNsdWRlIGxpdGVyYWwgW1VzZXJdIGJyYWNrZXQgaGVhZGVyXCIpO1xuXHRcdGFzc2VydC5vayghcHJvbXB0LmluY2x1ZGVzKFwiW0Fzc2lzdGFudF1cIiksIFwicHJvbXB0IG11c3Qgbm90IGluY2x1ZGUgbGl0ZXJhbCBbQXNzaXN0YW50XSBicmFja2V0IGhlYWRlclwiKTtcblx0XHRhc3NlcnQub2soIXByb21wdC5pbmNsdWRlcyhcIltTeXN0ZW1dXCIpLCBcInByb21wdCBtdXN0IG5vdCBpbmNsdWRlIGxpdGVyYWwgW1N5c3RlbV0gYnJhY2tldCBoZWFkZXJcIik7XG5cdH0pO1xuXG5cdHRlc3QoXCJidWlsZFByb21wdEZyb21Db250ZXh0IHdyYXBzIGhpc3RvcnkgaW4gWE1MLXRhZyBzdHJ1Y3R1cmVcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGNvbnRleHQ6IENvbnRleHQgPSB7XG5cdFx0XHRzeXN0ZW1Qcm9tcHQ6IFwiWW91IGFyZSBoZWxwZnVsLlwiLFxuXHRcdFx0bWVzc2FnZXM6IFtcblx0XHRcdFx0eyByb2xlOiBcInVzZXJcIiwgY29udGVudDogXCJIZWxsb1wiIH0gYXMgTWVzc2FnZSxcblx0XHRcdFx0e1xuXHRcdFx0XHRcdHJvbGU6IFwiYXNzaXN0YW50XCIsXG5cdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiSGkgdGhlcmVcIiB9XSxcblx0XHRcdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRcdFx0cHJvdmlkZXI6IFwiY2xhdWRlLWNvZGVcIixcblx0XHRcdFx0XHRtb2RlbDogXCJjbGF1ZGUtc29ubmV0LTQtMjAyNTA1MTRcIixcblx0XHRcdFx0XHR1c2FnZTogeyBpbnB1dDogMCwgb3V0cHV0OiAwLCBjYWNoZVJlYWQ6IDAsIGNhY2hlV3JpdGU6IDAsIHRvdGFsVG9rZW5zOiAwLCBjb3N0OiB7IGlucHV0OiAwLCBvdXRwdXQ6IDAsIGNhY2hlUmVhZDogMCwgY2FjaGVXcml0ZTogMCwgdG90YWw6IDAgfSB9LFxuXHRcdFx0XHRcdHN0b3BSZWFzb246IFwic3RvcFwiLFxuXHRcdFx0XHRcdHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcblx0XHRcdFx0fSBhcyBNZXNzYWdlLFxuXHRcdFx0XSxcblx0XHR9O1xuXG5cdFx0Y29uc3QgcHJvbXB0ID0gYnVpbGRQcm9tcHRGcm9tQ29udGV4dChjb250ZXh0KTtcblxuXHRcdGFzc2VydC5vayhwcm9tcHQuaW5jbHVkZXMoXCI8Y29udmVyc2F0aW9uX2hpc3Rvcnk+XCIpLCBcInByb21wdCBtdXN0IHdyYXAgaGlzdG9yeSBpbiA8Y29udmVyc2F0aW9uX2hpc3Rvcnk+XCIpO1xuXHRcdGFzc2VydC5vayhwcm9tcHQuaW5jbHVkZXMoXCI8L2NvbnZlcnNhdGlvbl9oaXN0b3J5PlwiKSwgXCJwcm9tcHQgbXVzdCBjbG9zZSA8Y29udmVyc2F0aW9uX2hpc3Rvcnk+XCIpO1xuXHRcdGFzc2VydC5vayhwcm9tcHQuaW5jbHVkZXMoXCI8dXNlcl9tZXNzYWdlPlxcbkhlbGxvXFxuPC91c2VyX21lc3NhZ2U+XCIpLCBcInVzZXIgdHVybiBtdXN0IHVzZSA8dXNlcl9tZXNzYWdlPiB0YWdzXCIpO1xuXHRcdGFzc2VydC5vayhwcm9tcHQuaW5jbHVkZXMoXCI8YXNzaXN0YW50X21lc3NhZ2U+XFxuSGkgdGhlcmVcXG48L2Fzc2lzdGFudF9tZXNzYWdlPlwiKSwgXCJhc3Npc3RhbnQgdHVybiBtdXN0IHVzZSA8YXNzaXN0YW50X21lc3NhZ2U+IHRhZ3NcIik7XG5cdFx0YXNzZXJ0Lm9rKHByb21wdC5pbmNsdWRlcyhcIjxwcmlvcl9zeXN0ZW1fY29udGV4dD5cXG5Zb3UgYXJlIGhlbHBmdWwuXFxuPC9wcmlvcl9zeXN0ZW1fY29udGV4dD5cIiksIFwic3lzdGVtIHByb21wdCBtdXN0IHVzZSA8cHJpb3Jfc3lzdGVtX2NvbnRleHQ+IHRhZ3NcIik7XG5cdH0pO1xuXG5cdHRlc3QoXCJidWlsZFByb21wdEZyb21Db250ZXh0IGluY2x1ZGVzIGEgZG8tbm90LWVjaG8tdGFncyBkaXJlY3RpdmUgYXMgcHJpbWFyeSBpbnN0cnVjdGlvblwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgY29udGV4dDogQ29udGV4dCA9IHtcblx0XHRcdG1lc3NhZ2VzOiBbeyByb2xlOiBcInVzZXJcIiwgY29udGVudDogXCJBbnl0aGluZ1wiIH0gYXMgTWVzc2FnZV0sXG5cdFx0fTtcblxuXHRcdGNvbnN0IHByb21wdCA9IGJ1aWxkUHJvbXB0RnJvbUNvbnRleHQoY29udGV4dCk7XG5cblx0XHRhc3NlcnQub2soXG5cdFx0XHRwcm9tcHQuc3RhcnRzV2l0aChcIlJlc3BvbmQgb25seSB0byB0aGUgZmluYWwgdXNlciBtZXNzYWdlXCIpLFxuXHRcdFx0XCJwcmltYXJ5IGRpcmVjdGl2ZSBtdXN0IGxlYWQgdGhlIHByb21wdFwiLFxuXHRcdCk7XG5cdFx0YXNzZXJ0Lm9rKHByb21wdC5pbmNsdWRlcyhcIkRvIG5vdCBlbWl0IDx1c2VyX21lc3NhZ2U+XCIpLCBcImRpcmVjdGl2ZSBtdXN0IGZvcmJpZCBlbWl0dGluZyB1c2VyX21lc3NhZ2UgdGFnXCIpO1xuXHRcdGFzc2VydC5vayhwcm9tcHQuaW5jbHVkZXMoXCI8YXNzaXN0YW50X21lc3NhZ2U+XCIpLCBcImRpcmVjdGl2ZSBtdXN0IG1lbnRpb24gYXNzaXN0YW50X21lc3NhZ2UgdGFnXCIpO1xuXHR9KTtcblxuXHR0ZXN0KFwiYnVpbGRQcm9tcHRGcm9tQ29udGV4dCBvbWl0cyA8Y29udmVyc2F0aW9uX2hpc3Rvcnk+IHdoZW4gdGhlcmUgYXJlIG5vIG1lc3NhZ2VzIGJ1dCBhIHN5c3RlbSBwcm9tcHRcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGNvbnRleHQ6IENvbnRleHQgPSB7XG5cdFx0XHRzeXN0ZW1Qcm9tcHQ6IFwiU2VlZFwiLFxuXHRcdFx0bWVzc2FnZXM6IFtdLFxuXHRcdH07XG5cblx0XHRjb25zdCBwcm9tcHQgPSBidWlsZFByb21wdEZyb21Db250ZXh0KGNvbnRleHQpO1xuXG5cdFx0YXNzZXJ0Lm9rKHByb21wdC5pbmNsdWRlcyhcIjxwcmlvcl9zeXN0ZW1fY29udGV4dD5cIiksIFwic3lzdGVtIHByb21wdCBtdXN0IHN0aWxsIHJlbmRlclwiKTtcblx0XHRhc3NlcnQub2soIXByb21wdC5pbmNsdWRlcyhcIjxjb252ZXJzYXRpb25faGlzdG9yeT5cIiksIFwibm8gaGlzdG9yeSB3cmFwcGVyIHdoZW4gbWVzc2FnZXMgYXJlIGVtcHR5XCIpO1xuXHR9KTtcblxuXHR0ZXN0KFwiYnVpbGRQcm9tcHRGcm9tQ29udGV4dCBzdGlsbCByZXR1cm5zIGVtcHR5IHN0cmluZyB3aGVuIGNvbnRleHQgaXMgZW50aXJlbHkgZW1wdHlcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGNvbnRleHQ6IENvbnRleHQgPSB7IG1lc3NhZ2VzOiBbXSB9O1xuXHRcdGNvbnN0IHByb21wdCA9IGJ1aWxkUHJvbXB0RnJvbUNvbnRleHQoY29udGV4dCk7XG5cdFx0YXNzZXJ0LmVxdWFsKHByb21wdCwgXCJcIiwgXCJlbXB0eSBjb250ZXh0IG11c3Qgbm90IGVtaXQgYSBiYXJlIGRpcmVjdGl2ZVwiKTtcblx0fSk7XG59KTtcblxuZGVzY3JpYmUoXCJzdHJlYW0tYWRhcHRlciBcdTIwMTQgQ2xhdWRlIENvZGUgZXh0ZXJuYWwgdG9vbCByZXN1bHRzXCIsICgpID0+IHtcblx0dGVzdChcImV4dHJhY3RUb29sUmVzdWx0c0Zyb21TZGtVc2VyTWVzc2FnZSBtYXBzIHRvb2xfcmVzdWx0IGNvbnRlbnQgdG8gdG9vbCBwYXlsb2Fkc1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgbWVzc2FnZTogU0RLVXNlck1lc3NhZ2UgPSB7XG5cdFx0XHR0eXBlOiBcInVzZXJcIixcblx0XHRcdHNlc3Npb25faWQ6IFwic2Vzcy0xXCIsXG5cdFx0XHRwYXJlbnRfdG9vbF91c2VfaWQ6IFwidG9vbC1iYXNoLTFcIixcblx0XHRcdG1lc3NhZ2U6IHtcblx0XHRcdFx0cm9sZTogXCJ1c2VyXCIsXG5cdFx0XHRcdGNvbnRlbnQ6IFtcblx0XHRcdFx0XHR7XG5cdFx0XHRcdFx0XHR0eXBlOiBcInRvb2xfcmVzdWx0XCIsXG5cdFx0XHRcdFx0XHR0b29sX3VzZV9pZDogXCJ0b29sLWJhc2gtMVwiLFxuXHRcdFx0XHRcdFx0Y29udGVudDogXCJsaW5lIDFcXG5saW5lIDJcIixcblx0XHRcdFx0XHRcdGlzX2Vycm9yOiBmYWxzZSxcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHRdLFxuXHRcdFx0fSxcblx0XHR9O1xuXG5cdFx0Y29uc3QgcmVzdWx0cyA9IGV4dHJhY3RUb29sUmVzdWx0c0Zyb21TZGtVc2VyTWVzc2FnZShtZXNzYWdlKTtcblx0XHRhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdHMsIFtcblx0XHRcdHtcblx0XHRcdFx0dG9vbFVzZUlkOiBcInRvb2wtYmFzaC0xXCIsXG5cdFx0XHRcdHJlc3VsdDoge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcImxpbmUgMVxcbmxpbmUgMlwiIH1dLFxuXHRcdFx0XHRcdC8vIGV4dHJhY3RTdHJ1Y3R1cmVkRGV0YWlsc0Zyb21CbG9jayByZXR1cm5zIHVuZGVmaW5lZCB3aGVuIG5vXG5cdFx0XHRcdFx0Ly8gc3RydWN0dXJlZCBwYXlsb2FkIGV4aXN0cywgcmVzdG9yaW5nIHRoZSBwcmUtIzQ0NzcgbnVsbGFibGVcblx0XHRcdFx0XHQvLyBjb250cmFjdCAoIzQ0NzcgcmV2aWV3IGZlZWRiYWNrKS5cblx0XHRcdFx0XHRkZXRhaWxzOiB1bmRlZmluZWQsXG5cdFx0XHRcdFx0aXNFcnJvcjogZmFsc2UsXG5cdFx0XHRcdH0sXG5cdFx0XHR9LFxuXHRcdF0pO1xuXHR9KTtcblxuXHR0ZXN0KFwiZXh0cmFjdFRvb2xSZXN1bHRzRnJvbVNka1VzZXJNZXNzYWdlIHJlYWRzIHN0cnVjdHVyZWRDb250ZW50IGFzIGEgc2libGluZyBmaWVsZCAoIzQ0NzIpXCIsICgpID0+IHtcblx0XHRjb25zdCBtZXNzYWdlOiBTREtVc2VyTWVzc2FnZSA9IHtcblx0XHRcdHR5cGU6IFwidXNlclwiLFxuXHRcdFx0c2Vzc2lvbl9pZDogXCJzZXNzLTFcIixcblx0XHRcdHBhcmVudF90b29sX3VzZV9pZDogXCJ0b29sLW1jcC0xXCIsXG5cdFx0XHRtZXNzYWdlOiB7XG5cdFx0XHRcdHJvbGU6IFwidXNlclwiLFxuXHRcdFx0XHRjb250ZW50OiBbXG5cdFx0XHRcdFx0e1xuXHRcdFx0XHRcdFx0dHlwZTogXCJtY3BfdG9vbF9yZXN1bHRcIixcblx0XHRcdFx0XHRcdHRvb2xfdXNlX2lkOiBcInRvb2wtbWNwLTFcIixcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkdhdGUgUTMgcmVzdWx0IHNhdmVkOiB2ZXJkaWN0PXBhc3NcIiB9XSxcblx0XHRcdFx0XHRcdGlzX2Vycm9yOiBmYWxzZSxcblx0XHRcdFx0XHRcdHN0cnVjdHVyZWRDb250ZW50OiB7IGdhdGVJZDogXCJRM1wiLCB2ZXJkaWN0OiBcInBhc3NcIiB9LFxuXHRcdFx0XHRcdH0gYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcblx0XHRcdFx0XSxcblx0XHRcdH0sXG5cdFx0fTtcblxuXHRcdGNvbnN0IHJlc3VsdHMgPSBleHRyYWN0VG9vbFJlc3VsdHNGcm9tU2RrVXNlck1lc3NhZ2UobWVzc2FnZSk7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChyZXN1bHRzWzBdLnJlc3VsdC5kZXRhaWxzLCB7IGdhdGVJZDogXCJRM1wiLCB2ZXJkaWN0OiBcInBhc3NcIiB9KTtcblx0fSk7XG5cblx0dGVzdChcImV4dHJhY3RUb29sUmVzdWx0c0Zyb21TZGtVc2VyTWVzc2FnZSByZWFkcyBzdHJ1Y3R1cmVkQ29udGVudCBmcm9tIGEgY29udGVudCBzdWItYmxvY2sgKCM0NDcyKVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgbWVzc2FnZTogU0RLVXNlck1lc3NhZ2UgPSB7XG5cdFx0XHR0eXBlOiBcInVzZXJcIixcblx0XHRcdHNlc3Npb25faWQ6IFwic2Vzcy0xXCIsXG5cdFx0XHRwYXJlbnRfdG9vbF91c2VfaWQ6IFwidG9vbC1tY3AtMlwiLFxuXHRcdFx0bWVzc2FnZToge1xuXHRcdFx0XHRyb2xlOiBcInVzZXJcIixcblx0XHRcdFx0Y29udGVudDogW1xuXHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdHR5cGU6IFwibWNwX3Rvb2xfcmVzdWx0XCIsXG5cdFx0XHRcdFx0XHR0b29sX3VzZV9pZDogXCJ0b29sLW1jcC0yXCIsXG5cdFx0XHRcdFx0XHRjb250ZW50OiBbXG5cdFx0XHRcdFx0XHRcdHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiR2F0ZSBRNCByZXN1bHQgc2F2ZWQ6IHZlcmRpY3Q9ZmxhZ1wiIH0sXG5cdFx0XHRcdFx0XHRcdHsgdHlwZTogXCJzdHJ1Y3R1cmVkQ29udGVudFwiLCBzdHJ1Y3R1cmVkQ29udGVudDogeyBnYXRlSWQ6IFwiUTRcIiwgdmVyZGljdDogXCJmbGFnXCIgfSB9LFxuXHRcdFx0XHRcdFx0XSxcblx0XHRcdFx0XHRcdGlzX2Vycm9yOiBmYWxzZSxcblx0XHRcdFx0XHR9IGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG5cdFx0XHRcdF0sXG5cdFx0XHR9LFxuXHRcdH07XG5cblx0XHRjb25zdCByZXN1bHRzID0gZXh0cmFjdFRvb2xSZXN1bHRzRnJvbVNka1VzZXJNZXNzYWdlKG1lc3NhZ2UpO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwocmVzdWx0c1swXS5yZXN1bHQuZGV0YWlscywgeyBnYXRlSWQ6IFwiUTRcIiwgdmVyZGljdDogXCJmbGFnXCIgfSk7XG5cdH0pO1xuXG5cdHRlc3QoXCIjNDQ3NyBleHRyYWN0VG9vbFJlc3VsdHNGcm9tU2RrVXNlck1lc3NhZ2UgZG9lcyBOT1QgbGVhayBzdHJ1Y3R1cmVkQ29udGVudCBwc2V1ZG8tYmxvY2tzIGludG8gdmlzaWJsZSBjb250ZW50XCIsICgpID0+IHtcblx0XHQvLyBSZWdyZXNzaW9uOiB3aGVuIGEgY29udGVudCBzdWItYmxvY2sgY2FycmllcyBgdHlwZTogXCJzdHJ1Y3R1cmVkQ29udGVudFwiYCxcblx0XHQvLyBpdCBjYXJyaWVzIHRoZSBzdHJ1Y3R1cmVkIHBheWxvYWQgKGV4dHJhY3RlZCBzZXBhcmF0ZWx5IGludG8gYGRldGFpbHNgKVxuXHRcdC8vIGFuZCBtdXN0IE5PVCBhcHBlYXIgaW4gdGhlIHZpc2libGUgYGNvbnRlbnRgIGFycmF5IFx1MjAxNCBvdGhlcndpc2UgdGhlXG5cdFx0Ly8gcmVuZGVyZXIgc3RyaW5naWZpZXMgdGhlIEpTT04gcHNldWRvLWJsb2NrIGFuZCBzaG93cyBpdCBuZXh0IHRvIHRoZVxuXHRcdC8vIGFjdHVhbCB0b29sIG91dHB1dC4gU2VlIFBSICM0NDc3IHJldmlldyAoQ29kZVJhYmJpdCwgcG9zdC1maXgtcm91bmQpLlxuXHRcdGNvbnN0IG1lc3NhZ2U6IFNES1VzZXJNZXNzYWdlID0ge1xuXHRcdFx0dHlwZTogXCJ1c2VyXCIsXG5cdFx0XHRzZXNzaW9uX2lkOiBcInNlc3MtMVwiLFxuXHRcdFx0cGFyZW50X3Rvb2xfdXNlX2lkOiBcInRvb2wtbWNwLXN0cmlwXCIsXG5cdFx0XHRtZXNzYWdlOiB7XG5cdFx0XHRcdHJvbGU6IFwidXNlclwiLFxuXHRcdFx0XHRjb250ZW50OiBbXG5cdFx0XHRcdFx0e1xuXHRcdFx0XHRcdFx0dHlwZTogXCJtY3BfdG9vbF9yZXN1bHRcIixcblx0XHRcdFx0XHRcdHRvb2xfdXNlX2lkOiBcInRvb2wtbWNwLXN0cmlwXCIsXG5cdFx0XHRcdFx0XHRjb250ZW50OiBbXG5cdFx0XHRcdFx0XHRcdHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiR2F0ZSBRNSByZXN1bHQgc2F2ZWQ6IHZlcmRpY3Q9cGFzc1wiIH0sXG5cdFx0XHRcdFx0XHRcdHsgdHlwZTogXCJzdHJ1Y3R1cmVkQ29udGVudFwiLCBzdHJ1Y3R1cmVkQ29udGVudDogeyBnYXRlSWQ6IFwiUTVcIiwgdmVyZGljdDogXCJwYXNzXCIgfSB9LFxuXHRcdFx0XHRcdFx0XHR7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcInNlY29uZCB2aXNpYmxlIGxpbmVcIiB9LFxuXHRcdFx0XHRcdFx0XHQvLyBzbmFrZV9jYXNlIHZhcmlhbnQgXHUyMDE0IGFsc28gYSBwc2V1ZG8tYmxvY2s7IGFsc28gbXVzdCBiZSBzdHJpcHBlZFxuXHRcdFx0XHRcdFx0XHR7IHR5cGU6IFwic3RydWN0dXJlZF9jb250ZW50XCIsIHN0cnVjdHVyZWRfY29udGVudDogeyBleHRyYTogXCJkYXRhXCIgfSB9LFxuXHRcdFx0XHRcdFx0XSxcblx0XHRcdFx0XHRcdGlzX2Vycm9yOiBmYWxzZSxcblx0XHRcdFx0XHR9IGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG5cdFx0XHRcdF0sXG5cdFx0XHR9LFxuXHRcdH07XG5cblx0XHRjb25zdCByZXN1bHRzID0gZXh0cmFjdFRvb2xSZXN1bHRzRnJvbVNka1VzZXJNZXNzYWdlKG1lc3NhZ2UpO1xuXHRcdGFzc2VydC5lcXVhbChyZXN1bHRzLmxlbmd0aCwgMSwgXCJzaG91bGQgZXh0cmFjdCBvbmUgcmVzdWx0XCIpO1xuXHRcdGNvbnN0IHJlc3VsdCA9IHJlc3VsdHNbMF0ucmVzdWx0O1xuXG5cdFx0Ly8gVGhlIHN0cnVjdHVyZWQgcGF5bG9hZCBJUyBleHRyYWN0ZWQgdG8gYGRldGFpbHNgLlxuXHRcdGFzc2VydC5kZWVwRXF1YWwocmVzdWx0LmRldGFpbHMsIHsgZ2F0ZUlkOiBcIlE1XCIsIHZlcmRpY3Q6IFwicGFzc1wiIH0pO1xuXG5cdFx0Ly8gVGhlIHZpc2libGUgY29udGVudCBoYXMgdGhlIHR3byB0ZXh0IGJsb2NrcyBidXQgTkVJVEhFUiBwc2V1ZG8tYmxvY2suXG5cdFx0Y29uc3QgdmlzaWJsZVRleHRzID0gcmVzdWx0LmNvbnRlbnQubWFwKChjOiBhbnkpID0+IGMudGV4dCk7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChcblx0XHRcdHZpc2libGVUZXh0cyxcblx0XHRcdFtcIkdhdGUgUTUgcmVzdWx0IHNhdmVkOiB2ZXJkaWN0PXBhc3NcIiwgXCJzZWNvbmQgdmlzaWJsZSBsaW5lXCJdLFxuXHRcdFx0XCJ2aXNpYmxlIGNvbnRlbnQgbXVzdCBpbmNsdWRlIG9ubHkgdGhlIHR3byB0ZXh0IGJsb2NrczsgYm90aCBzdHJ1Y3R1cmVkQ29udGVudCB2YXJpYW50cyBtdXN0IGJlIHN0cmlwcGVkXCIsXG5cdFx0KTtcblxuXHRcdC8vIEJlbHQtYW5kLXN1c3BlbmRlcnM6IGFzc2VydCBubyByZW5kZXJlZCB0ZXh0IHNob3dzIHRoZSBKU09OIHNlcmlhbGl6YXRpb25cblx0XHQvLyBvZiBhIHBzZXVkby1ibG9jay4gV2UgZG9uJ3QgY2hlY2sgZm9yIGJhcmUga2V5cyBsaWtlIFwiZ2F0ZUlkXCIgb3IgXCJ2ZXJkaWN0XCJcblx0XHQvLyBiZWNhdXNlIHRob3NlIGFyZSBsZWdpdGltYXRlIHdvcmRzIGluIHRoZSBnYXRlLXJlc3VsdCBtZXNzYWdlIHRleHQuIFRoZVxuXHRcdC8vIHJlZ3Jlc3Npb24gc2lnbmF0dXJlIHdvdWxkIGJlIGEgSlNPTi1zaGFwZWQgc3Vic3RyaW5nIHRoYXQgY291bGQgb25seVxuXHRcdC8vIGFwcGVhciB2aWEgc3RyaW5naWZpY2F0aW9uLlxuXHRcdGNvbnN0IGFsbFRleHQgPSB2aXNpYmxlVGV4dHMuam9pbihcIlxcblwiKTtcblx0XHRhc3NlcnQub2soXG5cdFx0XHQhYWxsVGV4dC5pbmNsdWRlcygnXCJzdHJ1Y3R1cmVkQ29udGVudFwiJyksXG5cdFx0XHRcInJlbmRlcmVkIGNvbnRlbnQgbXVzdCBub3QgaW5jbHVkZSB0aGUgcHNldWRvLWJsb2NrIHR5cGUgbWFya2VyIGFzIEpTT04gdGV4dFwiLFxuXHRcdCk7XG5cdFx0YXNzZXJ0Lm9rKFxuXHRcdFx0IWFsbFRleHQuaW5jbHVkZXMoJ1wic3RydWN0dXJlZF9jb250ZW50XCInKSxcblx0XHRcdFwicmVuZGVyZWQgY29udGVudCBtdXN0IG5vdCBpbmNsdWRlIHRoZSBzbmFrZV9jYXNlIHBzZXVkby1ibG9jayB0eXBlIG1hcmtlciBhcyBKU09OIHRleHRcIixcblx0XHQpO1xuXHR9KTtcblxuXHR0ZXN0KFwiZXh0cmFjdFRvb2xSZXN1bHRzRnJvbVNka1VzZXJNZXNzYWdlIGFjY2VwdHMgc25ha2VfY2FzZSBzdHJ1Y3R1cmVkX2NvbnRlbnQgZGVmZW5zaXZlbHkgKCM0NDcyKVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgbWVzc2FnZTogU0RLVXNlck1lc3NhZ2UgPSB7XG5cdFx0XHR0eXBlOiBcInVzZXJcIixcblx0XHRcdHNlc3Npb25faWQ6IFwic2Vzcy0xXCIsXG5cdFx0XHRwYXJlbnRfdG9vbF91c2VfaWQ6IFwidG9vbC1tY3AtM1wiLFxuXHRcdFx0bWVzc2FnZToge1xuXHRcdFx0XHRyb2xlOiBcInVzZXJcIixcblx0XHRcdFx0Y29udGVudDogW1xuXHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdHR5cGU6IFwibWNwX3Rvb2xfcmVzdWx0XCIsXG5cdFx0XHRcdFx0XHR0b29sX3VzZV9pZDogXCJ0b29sLW1jcC0zXCIsXG5cdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJva1wiIH1dLFxuXHRcdFx0XHRcdFx0c3RydWN0dXJlZF9jb250ZW50OiB7IG9wZXJhdGlvbjogXCJzYXZlX2dhdGVfcmVzdWx0XCIgfSxcblx0XHRcdFx0XHR9IGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG5cdFx0XHRcdF0sXG5cdFx0XHR9LFxuXHRcdH07XG5cblx0XHRjb25zdCByZXN1bHRzID0gZXh0cmFjdFRvb2xSZXN1bHRzRnJvbVNka1VzZXJNZXNzYWdlKG1lc3NhZ2UpO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwocmVzdWx0c1swXS5yZXN1bHQuZGV0YWlscywgeyBvcGVyYXRpb246IFwic2F2ZV9nYXRlX3Jlc3VsdFwiIH0pO1xuXHR9KTtcblxuXHR0ZXN0KFwiZXh0cmFjdFRvb2xSZXN1bHRzRnJvbVNka1VzZXJNZXNzYWdlIGZhbGxzIGJhY2sgdG8gdG9vbF91c2VfcmVzdWx0XCIsICgpID0+IHtcblx0XHRjb25zdCBtZXNzYWdlOiBTREtVc2VyTWVzc2FnZSA9IHtcblx0XHRcdHR5cGU6IFwidXNlclwiLFxuXHRcdFx0c2Vzc2lvbl9pZDogXCJzZXNzLTFcIixcblx0XHRcdHBhcmVudF90b29sX3VzZV9pZDogXCJ0b29sLXJlYWQtMVwiLFxuXHRcdFx0bWVzc2FnZTogeyByb2xlOiBcInVzZXJcIiwgY29udGVudDogW10gfSxcblx0XHRcdHRvb2xfdXNlX3Jlc3VsdDoge1xuXHRcdFx0XHR0b29sX3VzZV9pZDogXCJ0b29sLXJlYWQtMVwiLFxuXHRcdFx0XHRjb250ZW50OiBcImZpbGUgY29udGVudHNcIixcblx0XHRcdFx0aXNfZXJyb3I6IHRydWUsXG5cdFx0XHR9LFxuXHRcdH07XG5cblx0XHRjb25zdCByZXN1bHRzID0gZXh0cmFjdFRvb2xSZXN1bHRzRnJvbVNka1VzZXJNZXNzYWdlKG1lc3NhZ2UpO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwocmVzdWx0cywgW1xuXHRcdFx0e1xuXHRcdFx0XHR0b29sVXNlSWQ6IFwidG9vbC1yZWFkLTFcIixcblx0XHRcdFx0cmVzdWx0OiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiZmlsZSBjb250ZW50c1wiIH1dLFxuXHRcdFx0XHRcdC8vIHVuZGVmaW5lZCAobm90IHt9KSBwZXIgdGhlIHJlc3RvcmVkIG51bGxhYmxlIGNvbnRyYWN0IFx1MjAxNCBzZWVcblx0XHRcdFx0XHQvLyB0aGUgYW5hbG9nb3VzIGFzc2VydGlvbiBpbiB0aGUgdG9vbF9yZXN1bHQgdGVzdCBhYm92ZS5cblx0XHRcdFx0XHRkZXRhaWxzOiB1bmRlZmluZWQsXG5cdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0fSxcblx0XHRcdH0sXG5cdFx0XSk7XG5cdH0pO1xuXG5cdHRlc3QoXCJidWlsZEZpbmFsQXNzaXN0YW50Q29udGVudCBwcmVzZXJ2ZXMgaW50ZXJtZWRpYXRlIHRvb2wgY2FsbHMgd2l0aCBhdHRhY2hlZCBleHRlcm5hbCByZXN1bHRzXCIsICgpID0+IHtcblx0XHRjb25zdCBmaW5hbENvbnRlbnQgPSBidWlsZEZpbmFsQXNzaXN0YW50Q29udGVudCh7XG5cdFx0XHRpbnRlcm1lZGlhdGVUb29sQmxvY2tzOiBbXG5cdFx0XHRcdHtcblx0XHRcdFx0XHR0eXBlOiBcInRvb2xDYWxsXCIsXG5cdFx0XHRcdFx0aWQ6IFwidG9vbC1iYXNoLTFcIixcblx0XHRcdFx0XHRuYW1lOiBcImJhc2hcIixcblx0XHRcdFx0XHRhcmd1bWVudHM6IHsgY29tbWFuZDogXCJlY2hvIGhpXCIgfSxcblx0XHRcdFx0fSBhcyBhbnksXG5cdFx0XHRdLFxuXHRcdFx0cGVuZGluZ0NvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkFsbCBkb25lLlwiIH1dLFxuXHRcdFx0dG9vbFJlc3VsdHNCeUlkOiBuZXcgTWFwKFtcblx0XHRcdFx0W1xuXHRcdFx0XHRcdFwidG9vbC1iYXNoLTFcIixcblx0XHRcdFx0XHR7XG5cdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJoaVxcblwiIH1dLFxuXHRcdFx0XHRcdFx0ZGV0YWlsczogeyBzb3VyY2U6IFwiY2xhdWRlLWNvZGVcIiB9LFxuXHRcdFx0XHRcdFx0aXNFcnJvcjogZmFsc2UsXG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0XSxcblx0XHRcdF0pLFxuXHRcdH0pO1xuXG5cdFx0YXNzZXJ0LmVxdWFsKGZpbmFsQ29udGVudFswXT8udHlwZSwgXCJ0b29sQ2FsbFwiKTtcblx0XHRhc3NlcnQuZGVlcEVxdWFsKChmaW5hbENvbnRlbnRbMF0gYXMgYW55KS5leHRlcm5hbFJlc3VsdCwge1xuXHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiaGlcXG5cIiB9XSxcblx0XHRcdGRldGFpbHM6IHsgc291cmNlOiBcImNsYXVkZS1jb2RlXCIgfSxcblx0XHRcdGlzRXJyb3I6IGZhbHNlLFxuXHRcdH0pO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwoZmluYWxDb250ZW50WzFdLCB7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkFsbCBkb25lLlwiIH0pO1xuXHR9KTtcblxuXHR0ZXN0KFwiYnVpbGRGaW5hbEFzc2lzdGFudENvbnRlbnQga2VlcHMgZmluYWwtdHVybiB0b29sIGNhbGxzIHdoZW4gcmVzdWx0IGFycml2ZXMgd2l0aG91dCBhIHN5bnRoZXRpYyB1c2VyIGJvdW5kYXJ5XCIsICgpID0+IHtcblx0XHRjb25zdCBmaW5hbENvbnRlbnQgPSBidWlsZEZpbmFsQXNzaXN0YW50Q29udGVudCh7XG5cdFx0XHRpbnRlcm1lZGlhdGVUb29sQmxvY2tzOiBbXSxcblx0XHRcdHBlbmRpbmdDb250ZW50OiBbXG5cdFx0XHRcdHtcblx0XHRcdFx0XHR0eXBlOiBcInRvb2xDYWxsXCIsXG5cdFx0XHRcdFx0aWQ6IFwidG9vbC1yZWFkLTFcIixcblx0XHRcdFx0XHRuYW1lOiBcInJlYWRcIixcblx0XHRcdFx0XHRhcmd1bWVudHM6IHsgcGF0aDogXCJSRUFETUUubWRcIiB9LFxuXHRcdFx0XHR9IGFzIGFueSxcblx0XHRcdFx0eyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJSZWFkIGNvbXBsZXRlLlwiIH0sXG5cdFx0XHRdLFxuXHRcdFx0dG9vbFJlc3VsdHNCeUlkOiBuZXcgTWFwKFtcblx0XHRcdFx0W1xuXHRcdFx0XHRcdFwidG9vbC1yZWFkLTFcIixcblx0XHRcdFx0XHR7XG5cdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJmaWxlIGNvbnRlbnRzXCIgfV0sXG5cdFx0XHRcdFx0XHRkZXRhaWxzOiB7IHBhdGg6IFwiUkVBRE1FLm1kXCIgfSxcblx0XHRcdFx0XHRcdGlzRXJyb3I6IGZhbHNlLFxuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdF0sXG5cdFx0XHRdKSxcblx0XHR9KTtcblxuXHRcdGFzc2VydC5lcXVhbChmaW5hbENvbnRlbnRbMF0/LnR5cGUsIFwidG9vbENhbGxcIik7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbCgoZmluYWxDb250ZW50WzBdIGFzIGFueSkuZXh0ZXJuYWxSZXN1bHQsIHtcblx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcImZpbGUgY29udGVudHNcIiB9XSxcblx0XHRcdGRldGFpbHM6IHsgcGF0aDogXCJSRUFETUUubWRcIiB9LFxuXHRcdFx0aXNFcnJvcjogZmFsc2UsXG5cdFx0fSk7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChmaW5hbENvbnRlbnRbMV0sIHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiUmVhZCBjb21wbGV0ZS5cIiB9KTtcblx0fSk7XG59KTtcblxuZGVzY3JpYmUoXCJzdHJlYW0tYWRhcHRlciBcdTIwMTQgc2Vzc2lvbiBwZXJzaXN0ZW5jZSAoIzI4NTkpXCIsICgpID0+IHtcblx0dGVzdChcImJ1aWxkU2RrT3B0aW9ucyBlbmFibGVzIHBlcnNpc3RTZXNzaW9uIGJ5IGRlZmF1bHRcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IG9wdGlvbnMgPSBidWlsZFNka09wdGlvbnMoXCJjbGF1ZGUtc29ubmV0LTQtMjAyNTA1MTRcIiwgXCJ0ZXN0IHByb21wdFwiKTtcblx0XHRhc3NlcnQuZXF1YWwob3B0aW9ucy5wZXJzaXN0U2Vzc2lvbiwgdHJ1ZSwgXCJwZXJzaXN0U2Vzc2lvbiBtdXN0IGRlZmF1bHQgdG8gdHJ1ZVwiKTtcblx0fSk7XG5cblx0dGVzdChcImJ1aWxkU2RrT3B0aW9ucyBzZXRzIG1vZGVsIGFuZCBwcm9tcHQgY29ycmVjdGx5XCIsICgpID0+IHtcblx0XHRjb25zdCBvcHRpb25zID0gYnVpbGRTZGtPcHRpb25zKFwiY2xhdWRlLXNvbm5ldC00LTIwMjUwNTE0XCIsIFwiaGVsbG8gd29ybGRcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKG9wdGlvbnMubW9kZWwsIFwiY2xhdWRlLXNvbm5ldC00LTIwMjUwNTE0XCIpO1xuXHR9KTtcblxuXHR0ZXN0KFwiYnVpbGRTZGtPcHRpb25zIHByZWZlcnMgZXhwbGljaXQgY3dkIG92ZXIgcHJvY2VzcyBjd2QgZm9yIGxvY2FsIFNESyBleGVjdXRpb25cIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGV4cGxpY2l0Q3dkID0gXCIvdG1wL2dzZC1zZXNzaW9uLXJvb3RcIjtcblx0XHRjb25zdCBvcHRpb25zID0gYnVpbGRTZGtPcHRpb25zKFwiY2xhdWRlLXNvbm5ldC00LTIwMjUwNTE0XCIsIFwiaGVsbG8gd29ybGRcIiwgdW5kZWZpbmVkLCB7IGN3ZDogZXhwbGljaXRDd2QgfSk7XG5cdFx0YXNzZXJ0LmVxdWFsKG9wdGlvbnMuY3dkLCBleHBsaWNpdEN3ZCk7XG5cdH0pO1xuXG5cdHRlc3QoXCJidWlsZFNka09wdGlvbnMgdXNlcyBleHBsaWNpdCBjd2Qgd2hlbiBhdXRvLWRldGVjdGluZyB3b3JrZmxvdyBNQ1AgbGF1bmNoIGNvbmZpZ1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgZXhwbGljaXRDd2QgPSByZWFscGF0aFN5bmMobWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJjbGF1ZGUtc2RrLWN3ZC1cIikpKTtcblx0XHRjb25zdCByZXN0b3JlID0gc2V0V29ya2Zsb3dNY3BFbnYoe30pO1xuXHRcdHRyeSB7XG5cdFx0XHRkZWxldGUgcHJvY2Vzcy5lbnYuR1NEX1dPUktGTE9XX01DUF9DT01NQU5EO1xuXHRcdFx0ZGVsZXRlIHByb2Nlc3MuZW52LkdTRF9XT1JLRkxPV19NQ1BfTkFNRTtcblx0XHRcdGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfTUNQX0FSR1M7XG5cdFx0XHRkZWxldGUgcHJvY2Vzcy5lbnYuR1NEX1dPUktGTE9XX01DUF9FTlY7XG5cdFx0XHRkZWxldGUgcHJvY2Vzcy5lbnYuR1NEX1dPUktGTE9XX01DUF9DV0Q7XG5cblx0XHRcdGNvbnN0IGRpc3REaXIgPSBqb2luKGV4cGxpY2l0Q3dkLCBcInBhY2thZ2VzXCIsIFwibWNwLXNlcnZlclwiLCBcImRpc3RcIik7XG5cdFx0XHRta2RpclN5bmMoZGlzdERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cdFx0XHR3cml0ZUZpbGVTeW5jKGpvaW4oZGlzdERpciwgXCJjbGkuanNcIiksIFwiIyEvdXNyL2Jpbi9lbnYgbm9kZVxcblwiKTtcblxuXHRcdFx0Y29uc3Qgb3B0aW9ucyA9IGJ1aWxkU2RrT3B0aW9ucyhcImNsYXVkZS1zb25uZXQtNC0yMDI1MDUxNFwiLCBcImhlbGxvIHdvcmxkXCIsIHVuZGVmaW5lZCwgeyBjd2Q6IGV4cGxpY2l0Q3dkIH0pO1xuXHRcdFx0Y29uc3QgbWNwU2VydmVycyA9IG9wdGlvbnMubWNwU2VydmVycyBhcyBSZWNvcmQ8c3RyaW5nLCBhbnk+O1xuXHRcdFx0YXNzZXJ0LmVxdWFsKG1jcFNlcnZlcnNbXCJnc2Qtd29ya2Zsb3dcIl0uY3dkLCBleHBsaWNpdEN3ZCk7XG5cdFx0XHRhc3NlcnQuZXF1YWwobWNwU2VydmVyc1tcImdzZC13b3JrZmxvd1wiXS5lbnYuR1NEX1dPUktGTE9XX1BST0pFQ1RfUk9PVCwgZXhwbGljaXRDd2QpO1xuXHRcdH0gZmluYWxseSB7XG5cdFx0XHRyZXN0b3JlKCk7XG5cdFx0XHRybVN5bmMoZXhwbGljaXRDd2QsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcblx0XHR9XG5cdH0pO1xuXG5cdHRlc3QoXCJyZXNvbHZlQ2xhdWRlQ29kZUN3ZCBmYWxscyBiYWNrIHRvIHByb2Nlc3MgY3dkIHdoZW4gbm8gc3RyZWFtIGN3ZCBpcyBwcm92aWRlZFwiLCAoKSA9PiB7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc29sdmVDbGF1ZGVDb2RlQ3dkKCksIHByb2Nlc3MuY3dkKCkpO1xuXHRcdGFzc2VydC5lcXVhbChyZXNvbHZlQ2xhdWRlQ29kZUN3ZCh7IGN3ZDogXCIgICBcIiB9KSwgcHJvY2Vzcy5jd2QoKSk7XG5cdH0pO1xuXG5cdHRlc3QoXCJyZXNvbHZlQ2xhdWRlQ29kZUN3ZCByZXR1cm5zIHN0cmVhbSBjd2Qgd2hlbiBwcm92aWRlZFwiLCAoKSA9PiB7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc29sdmVDbGF1ZGVDb2RlQ3dkKHsgY3dkOiBcIi90bXAvY3VycmVudC1zZXNzaW9uXCIgfSksIFwiL3RtcC9jdXJyZW50LXNlc3Npb25cIik7XG5cdH0pO1xuXG5cdHRlc3QoXCJidWlsZFNka09wdGlvbnMgZW5hYmxlcyBiZXRhcyBmb3Igc29ubmV0IG1vZGVsc1wiLCAoKSA9PiB7XG5cdFx0Y29uc3Qgc29ubmV0T3B0cyA9IGJ1aWxkU2RrT3B0aW9ucyhcImNsYXVkZS1zb25uZXQtNC0yMDI1MDUxNFwiLCBcInRlc3RcIik7XG5cdFx0YXNzZXJ0Lm9rKFxuXHRcdFx0QXJyYXkuaXNBcnJheShzb25uZXRPcHRzLmJldGFzKSAmJiBzb25uZXRPcHRzLmJldGFzLmxlbmd0aCA+IDAsXG5cdFx0XHRcInNvbm5ldCBtb2RlbHMgc2hvdWxkIGhhdmUgYmV0YXMgZW5hYmxlZFwiLFxuXHRcdCk7XG5cblx0XHRjb25zdCBvcHVzT3B0cyA9IGJ1aWxkU2RrT3B0aW9ucyhcImNsYXVkZS1vcHVzLTQtMjAyNTA1MTRcIiwgXCJ0ZXN0XCIpO1xuXHRcdGFzc2VydC5vayhcblx0XHRcdEFycmF5LmlzQXJyYXkob3B1c09wdHMuYmV0YXMpICYmIG9wdXNPcHRzLmJldGFzLmxlbmd0aCA9PT0gMCxcblx0XHRcdFwibm9uLXNvbm5ldCBtb2RlbHMgc2hvdWxkIGhhdmUgZW1wdHkgYmV0YXNcIixcblx0XHQpO1xuXHR9KTtcblxuXHR0ZXN0KFwiYnVpbGRTZGtPcHRpb25zIGVuYWJsZXMgY29udGV4dC0xbSBiZXRhIGZvciBvcHVzLTQtNyAoIzQzNDgpXCIsICgpID0+IHtcblx0XHRjb25zdCBvcHRzID0gYnVpbGRTZGtPcHRpb25zKFwiY2xhdWRlLW9wdXMtNC03XCIsIFwidGVzdFwiKTtcblx0XHRhc3NlcnQub2soXG5cdFx0XHRBcnJheS5pc0FycmF5KG9wdHMuYmV0YXMpICYmIG9wdHMuYmV0YXMuaW5jbHVkZXMoXCJjb250ZXh0LTFtLTIwMjUtMDgtMDdcIiksXG5cdFx0XHRcImNsYXVkZS1vcHVzLTQtNyBzaG91bGQgaGF2ZSBjb250ZXh0LTFtIGJldGEgZW5hYmxlZCBmb3IgMU0gdG9rZW4gY29udGV4dCB3aW5kb3dcIixcblx0XHQpO1xuXHR9KTtcblxuXHR0ZXN0KFwiYnVpbGRTZGtPcHRpb25zIG1hcHMgcmVhc29uaW5nIHRvIGVmZm9ydCBmb3IgYWRhcHRpdmUgQ2xhdWRlIENvZGUgbW9kZWxzICgjMzkxNylcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IG9wdGlvbnMgPSBidWlsZFNka09wdGlvbnMoXCJjbGF1ZGUtc29ubmV0LTQtNlwiLCBcInRlc3RcIiwgdW5kZWZpbmVkLCB7IHJlYXNvbmluZzogXCJoaWdoXCIgfSk7XG5cdFx0YXNzZXJ0LmVxdWFsKG9wdGlvbnMuZWZmb3J0LCBcImhpZ2hcIik7XG5cdH0pO1xuXG5cdHRlc3QoXCJidWlsZFNka09wdGlvbnMgdXBncmFkZXMgeGhpZ2ggcmVhc29uaW5nIHRvIG1heCBmb3Igb3B1cyA0LjYgKCMzOTE3KVwiLCAoKSA9PiB7XG5cdFx0Y29uc3Qgb3B0aW9ucyA9IGJ1aWxkU2RrT3B0aW9ucyhcImNsYXVkZS1vcHVzLTQtNlwiLCBcInRlc3RcIiwgdW5kZWZpbmVkLCB7IHJlYXNvbmluZzogXCJ4aGlnaFwiIH0pO1xuXHRcdGFzc2VydC5lcXVhbChvcHRpb25zLmVmZm9ydCwgXCJtYXhcIik7XG5cdH0pO1xuXG5cdHRlc3QoXCJidWlsZFNka09wdGlvbnMgbWFwcyByZWFzb25pbmcgdG8gZWZmb3J0IGZvciBvcHVzLTQtNyAoIzQzNDgpXCIsICgpID0+IHtcblx0XHRjb25zdCBvcHRpb25zID0gYnVpbGRTZGtPcHRpb25zKFwiY2xhdWRlLW9wdXMtNC03XCIsIFwidGVzdFwiLCB1bmRlZmluZWQsIHsgcmVhc29uaW5nOiBcImhpZ2hcIiB9KTtcblx0XHRhc3NlcnQuZXF1YWwob3B0aW9ucy5lZmZvcnQsIFwiaGlnaFwiKTtcblx0fSk7XG5cblx0dGVzdChcImJ1aWxkU2RrT3B0aW9ucyBwYXNzZXMgeGhpZ2ggcmVhc29uaW5nIG5hdGl2ZWx5IGZvciBvcHVzLTQtNyAoIzQzNDgpXCIsICgpID0+IHtcblx0XHRjb25zdCBvcHRpb25zID0gYnVpbGRTZGtPcHRpb25zKFwiY2xhdWRlLW9wdXMtNC03XCIsIFwidGVzdFwiLCB1bmRlZmluZWQsIHsgcmVhc29uaW5nOiBcInhoaWdoXCIgfSk7XG5cdFx0YXNzZXJ0LmVxdWFsKG9wdGlvbnMuZWZmb3J0LCBcInhoaWdoXCIpO1xuXHR9KTtcblxuXHR0ZXN0KFwiYnVpbGRTZGtPcHRpb25zIG9taXRzIGVmZm9ydCB3aGVuIHJlYXNvbmluZyBpcyB1bmRlZmluZWQgKCMzOTE3KVwiLCAoKSA9PiB7XG5cdFx0Y29uc3Qgb3B0aW9ucyA9IGJ1aWxkU2RrT3B0aW9ucyhcImNsYXVkZS1zb25uZXQtNC02XCIsIFwidGVzdFwiKTtcblx0XHRhc3NlcnQuZXF1YWwoXCJlZmZvcnRcIiBpbiBvcHRpb25zLCBmYWxzZSk7XG5cdH0pO1xuXG5cdHRlc3QoXCJidWlsZFNka09wdGlvbnMgb21pdHMgZWZmb3J0IGZvciBub24tYWRhcHRpdmUgQ2xhdWRlIG1vZGVscyAoIzM5MTcpXCIsICgpID0+IHtcblx0XHRjb25zdCBvcHRpb25zID0gYnVpbGRTZGtPcHRpb25zKFwiY2xhdWRlLXNvbm5ldC00LTIwMjUwNTE0XCIsIFwidGVzdFwiLCB1bmRlZmluZWQsIHsgcmVhc29uaW5nOiBcImhpZ2hcIiB9KTtcblx0XHRhc3NlcnQuZXF1YWwoXCJlZmZvcnRcIiBpbiBvcHRpb25zLCBmYWxzZSk7XG5cdH0pO1xuXG5cdC8vIC0tLSBCdWcgZml4ZXMgIzQzOTI6IHRoaW5raW5nIGZpZWxkICYgbW9kZWwgY292ZXJhZ2UgLS0tXG5cblx0dGVzdChcImJ1aWxkU2RrT3B0aW9ucyBzZXRzIHRoaW5raW5nIGRpc2FibGVkIHdoZW4gcmVhc29uaW5nIGlzIHVuZGVmaW5lZCBvbiBhZGFwdGl2ZSBtb2RlbCAoIzQzOTIpXCIsICgpID0+IHtcblx0XHQvLyBCdWcgQzogdGhpbmtpbmdMZXZlbD1cIm9mZlwiIG1lYW5zIHJlYXNvbmluZz09PXVuZGVmaW5lZDsgU0RLIG5lZWRzIHRoaW5raW5nOnt0eXBlOlwiZGlzYWJsZWRcIn1cblx0XHRjb25zdCBvcHRpb25zID0gYnVpbGRTZGtPcHRpb25zKFwiY2xhdWRlLXNvbm5ldC00LTZcIiwgXCJ0ZXN0XCIsIHVuZGVmaW5lZCwge30pO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwoXG5cdFx0XHQob3B0aW9ucyBhcyBhbnkpLnRoaW5raW5nLFxuXHRcdFx0eyB0eXBlOiBcImRpc2FibGVkXCIgfSxcblx0XHRcdFwidGhpbmtpbmcgbXVzdCBiZSB7dHlwZTonZGlzYWJsZWQnfSB3aGVuIHJlYXNvbmluZyBpcyB1bmRlZmluZWQgc28gU0RLIHN0b3BzIGFkYXB0aXZlIHRoaW5raW5nXCIsXG5cdFx0KTtcblx0fSk7XG5cblx0dGVzdChcImJ1aWxkU2RrT3B0aW9ucyBvbWl0cyBlZmZvcnQgd2hlbiByZWFzb25pbmcgaXMgdW5kZWZpbmVkICh0aGlua2luZyBkaXNhYmxlZCkgKCM0MzkyKVwiLCAoKSA9PiB7XG5cdFx0Ly8gQnVnIEMgY29yb2xsYXJ5OiBubyBlZmZvcnQgd2hlbiB0aGlua2luZyBpcyBvZmZcblx0XHRjb25zdCBvcHRpb25zID0gYnVpbGRTZGtPcHRpb25zKFwiY2xhdWRlLXNvbm5ldC00LTZcIiwgXCJ0ZXN0XCIsIHVuZGVmaW5lZCwge30pO1xuXHRcdGFzc2VydC5lcXVhbChcImVmZm9ydFwiIGluIG9wdGlvbnMsIGZhbHNlLCBcImVmZm9ydCBtdXN0IG5vdCBiZSBzZXQgd2hlbiByZWFzb25pbmcgaXMgdW5kZWZpbmVkXCIpO1xuXHR9KTtcblxuXHR0ZXN0KFwiYnVpbGRTZGtPcHRpb25zIHNldHMgdGhpbmtpbmcgYWRhcHRpdmUgd2hlbiByZWFzb25pbmcgaXMgcHJvdmlkZWQgKCM0MzkyKVwiLCAoKSA9PiB7XG5cdFx0Ly8gQnVnIEI6IHdoZW4gZWZmb3J0IGlzIHNldCwgdGhpbmtpbmc6e3R5cGU6XCJhZGFwdGl2ZVwifSBtdXN0IGFsc28gYmUgcHJlc2VudFxuXHRcdGNvbnN0IG9wdGlvbnMgPSBidWlsZFNka09wdGlvbnMoXCJjbGF1ZGUtb3B1cy00LTZcIiwgXCJ0ZXN0XCIsIHVuZGVmaW5lZCwgeyByZWFzb25pbmc6IFwiaGlnaFwiIH0pO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwoXG5cdFx0XHQob3B0aW9ucyBhcyBhbnkpLnRoaW5raW5nLFxuXHRcdFx0eyB0eXBlOiBcImFkYXB0aXZlXCIgfSxcblx0XHRcdFwidGhpbmtpbmcgbXVzdCBiZSB7dHlwZTonYWRhcHRpdmUnfSBhbG9uZ3NpZGUgZWZmb3J0IHdoZW4gcmVhc29uaW5nIGlzIHNldFwiLFxuXHRcdCk7XG5cdH0pO1xuXG5cdHRlc3QoXCJidWlsZFNka09wdGlvbnMgaW5jbHVkZXMgYm90aCBlZmZvcnQgYW5kIHRoaW5raW5nLnR5cGU9YWRhcHRpdmUgd2hlbiByZWFzb25pbmcgaXMgc2V0ICgjNDM5MilcIiwgKCkgPT4ge1xuXHRcdC8vIEJ1ZyBCOiBib3RoIGZpZWxkcyBtdXN0IGJlIHByZXNlbnQgdG9nZXRoZXJcblx0XHRjb25zdCBvcHRpb25zID0gYnVpbGRTZGtPcHRpb25zKFwiY2xhdWRlLW9wdXMtNC02XCIsIFwidGVzdFwiLCB1bmRlZmluZWQsIHsgcmVhc29uaW5nOiBcImhpZ2hcIiB9KTtcblx0XHRhc3NlcnQuZXF1YWwob3B0aW9ucy5lZmZvcnQsIFwiaGlnaFwiLCBcImVmZm9ydCBtdXN0IGJlIHNldFwiKTtcblx0XHRhc3NlcnQuZGVlcEVxdWFsKChvcHRpb25zIGFzIGFueSkudGhpbmtpbmcsIHsgdHlwZTogXCJhZGFwdGl2ZVwiIH0sIFwidGhpbmtpbmcgbXVzdCBiZSBhZGFwdGl2ZVwiKTtcblx0fSk7XG5cblx0dGVzdChcImJ1aWxkU2RrT3B0aW9ucyBtYXBzIHJlYXNvbmluZyB0byBlZmZvcnQgZm9yIHNvbm5ldC00LTcgKG1vZGVsU3VwcG9ydHNBZGFwdGl2ZVRoaW5raW5nICM0MzkyKVwiLCAoKSA9PiB7XG5cdFx0Ly8gQnVnIEQ6IHNvbm5ldC00LTcgd2FzIG1pc3NpbmcgZnJvbSBtb2RlbFN1cHBvcnRzQWRhcHRpdmVUaGlua2luZ1xuXHRcdGNvbnN0IG9wdGlvbnMgPSBidWlsZFNka09wdGlvbnMoXCJjbGF1ZGUtc29ubmV0LTQtN1wiLCBcInRlc3RcIiwgdW5kZWZpbmVkLCB7IHJlYXNvbmluZzogXCJoaWdoXCIgfSk7XG5cdFx0YXNzZXJ0LmVxdWFsKG9wdGlvbnMuZWZmb3J0LCBcImhpZ2hcIiwgXCJzb25uZXQtNC03IG11c3Qgc3VwcG9ydCBhZGFwdGl2ZSB0aGlua2luZyBhbmQgbWFwIGVmZm9ydFwiKTtcblx0fSk7XG5cblx0dGVzdChcImJ1aWxkU2RrT3B0aW9ucyBtYXBzIHJlYXNvbmluZyB0byBlZmZvcnQgZm9yIGhhaWt1LTQtNSAobW9kZWxTdXBwb3J0c0FkYXB0aXZlVGhpbmtpbmcgIzQzOTIpXCIsICgpID0+IHtcblx0XHQvLyBCdWcgRDogaGFpa3UtNC01IHdhcyBtaXNzaW5nIGZyb20gbW9kZWxTdXBwb3J0c0FkYXB0aXZlVGhpbmtpbmdcblx0XHRjb25zdCBvcHRpb25zID0gYnVpbGRTZGtPcHRpb25zKFwiY2xhdWRlLWhhaWt1LTQtNVwiLCBcInRlc3RcIiwgdW5kZWZpbmVkLCB7IHJlYXNvbmluZzogXCJoaWdoXCIgfSk7XG5cdFx0YXNzZXJ0LmVxdWFsKG9wdGlvbnMuZWZmb3J0LCBcImhpZ2hcIiwgXCJoYWlrdS00LTUgbXVzdCBzdXBwb3J0IGFkYXB0aXZlIHRoaW5raW5nIGFuZCBtYXAgZWZmb3J0XCIpO1xuXHR9KTtcblxuXHR0ZXN0KFwiYnVpbGRTZGtPcHRpb25zIG1hcHMgcmVhc29uaW5nIHRvIGVmZm9ydCBmb3Igc29ubmV0LTQuNyBkb3QtZm9ybSAobW9kZWxTdXBwb3J0c0FkYXB0aXZlVGhpbmtpbmcgIzQzOTIpXCIsICgpID0+IHtcblx0XHQvLyBEb3QtZm9ybSBhbGlhc2VzIChlLmcuIGNsYXVkZS1zb25uZXQtNC43KSBtdXN0IGFsc28gYmUgcmVjb2duaXNlZFxuXHRcdGNvbnN0IG9wdGlvbnMgPSBidWlsZFNka09wdGlvbnMoXCJjbGF1ZGUtc29ubmV0LTQuN1wiLCBcInRlc3RcIiwgdW5kZWZpbmVkLCB7IHJlYXNvbmluZzogXCJoaWdoXCIgfSk7XG5cdFx0YXNzZXJ0LmVxdWFsKG9wdGlvbnMuZWZmb3J0LCBcImhpZ2hcIiwgXCJjbGF1ZGUtc29ubmV0LTQuNyBtdXN0IHN1cHBvcnQgYWRhcHRpdmUgdGhpbmtpbmcgYW5kIG1hcCBlZmZvcnRcIik7XG5cdH0pO1xuXG5cdHRlc3QoXCJidWlsZFNka09wdGlvbnMgbWFwcyByZWFzb25pbmcgdG8gZWZmb3J0IGZvciBoYWlrdS00LjUgZG90LWZvcm0gKG1vZGVsU3VwcG9ydHNBZGFwdGl2ZVRoaW5raW5nICM0MzkyKVwiLCAoKSA9PiB7XG5cdFx0Ly8gRG90LWZvcm0gYWxpYXNlcyAoZS5nLiBjbGF1ZGUtaGFpa3UtNC41KSBtdXN0IGFsc28gYmUgcmVjb2duaXNlZFxuXHRcdGNvbnN0IG9wdGlvbnMgPSBidWlsZFNka09wdGlvbnMoXCJjbGF1ZGUtaGFpa3UtNC41XCIsIFwidGVzdFwiLCB1bmRlZmluZWQsIHsgcmVhc29uaW5nOiBcImhpZ2hcIiB9KTtcblx0XHRhc3NlcnQuZXF1YWwob3B0aW9ucy5lZmZvcnQsIFwiaGlnaFwiLCBcImNsYXVkZS1oYWlrdS00LjUgbXVzdCBzdXBwb3J0IGFkYXB0aXZlIHRoaW5raW5nIGFuZCBtYXAgZWZmb3J0XCIpO1xuXHR9KTtcblxuXHR0ZXN0KFwiYnVpbGRTZGtPcHRpb25zIGRvZXMgbm90IHNldCB0aGlua2luZyBmaWVsZCBmb3Igbm9uLWFkYXB0aXZlIG1vZGVsIHdoZW4gcmVhc29uaW5nIGlzIHVuZGVmaW5lZCAoIzQzOTIpXCIsICgpID0+IHtcblx0XHQvLyBOb24tYWRhcHRpdmUgbW9kZWxzIChlLmcuIGNsYXVkZS1zb25uZXQtNC0yMDI1MDUxNCkgZG9uJ3QgdXNlIHRoZSB0aGlua2luZyBBUEkgYXQgYWxsO1xuXHRcdC8vIG5vIHRoaW5raW5nIGZpZWxkIHNob3VsZCBiZSBzZXQgd2hlbiByZWFzb25pbmcgaXMgdW5kZWZpbmVkXG5cdFx0Y29uc3Qgb3B0aW9ucyA9IGJ1aWxkU2RrT3B0aW9ucyhcImNsYXVkZS1zb25uZXQtNC0yMDI1MDUxNFwiLCBcInRlc3RcIiwgdW5kZWZpbmVkLCB7fSk7XG5cdFx0YXNzZXJ0LmVxdWFsKFwidGhpbmtpbmdcIiBpbiBvcHRpb25zLCBmYWxzZSwgXCJub24tYWRhcHRpdmUgbW9kZWxzIG11c3Qgbm90IHJlY2VpdmUgYSB0aGlua2luZyBmaWVsZFwiKTtcblx0fSk7XG5cblx0dGVzdChcImJ1aWxkU2RrT3B0aW9ucyBwcmVmZXJzIHdvcmtmbG93IE1DUCBxdWVzdGlvbiB0b29scyBvdmVyIG5hdGl2ZSBBc2tVc2VyUXVlc3Rpb25cIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlc3RvcmUgPSBzZXRXb3JrZmxvd01jcEVudih7XG5cdFx0XHRHU0RfV09SS0ZMT1dfTUNQX0NPTU1BTkQ6IFwibm9kZVwiLFxuXHRcdFx0R1NEX1dPUktGTE9XX01DUF9OQU1FOiBcImdzZC13b3JrZmxvd1wiLFxuXHRcdFx0R1NEX1dPUktGTE9XX01DUF9BUkdTOiBKU09OLnN0cmluZ2lmeShbXCJwYWNrYWdlcy9tY3Atc2VydmVyL2Rpc3QvY2xpLmpzXCJdKSxcblx0XHRcdEdTRF9XT1JLRkxPV19NQ1BfRU5WOiBKU09OLnN0cmluZ2lmeSh7IEdTRF9DTElfUEFUSDogXCIvdG1wL2dzZFwiIH0pLFxuXHRcdFx0R1NEX1dPUktGTE9XX01DUF9DV0Q6IFwiL3RtcC9wcm9qZWN0XCIsXG5cdFx0fSk7XG5cdFx0dHJ5IHtcblxuXHRcdFx0Y29uc3Qgb3B0aW9ucyA9IGJ1aWxkU2RrT3B0aW9ucyhcImNsYXVkZS1zb25uZXQtNC0yMDI1MDUxNFwiLCBcInRlc3RcIik7XG5cdFx0XHRjb25zdCBtY3BTZXJ2ZXJzID0gb3B0aW9ucy5tY3BTZXJ2ZXJzIGFzIFJlY29yZDxzdHJpbmcsIGFueT47XG5cdFx0XHRhc3NlcnQub2sobWNwU2VydmVycz8uW1wiZ3NkLXdvcmtmbG93XCJdLCBcImV4cGVjdGVkIGdzZC13b3JrZmxvdyBzZXJ2ZXIgY29uZmlnXCIpO1xuXHRcdFx0Y29uc3Qgc3J2ID0gbWNwU2VydmVyc1tcImdzZC13b3JrZmxvd1wiXTtcblx0XHRcdGFzc2VydC5lcXVhbChzcnYuY29tbWFuZCwgXCJub2RlXCIpO1xuXHRcdFx0YXNzZXJ0LmRlZXBFcXVhbChzcnYuYXJncywgW1wicGFja2FnZXMvbWNwLXNlcnZlci9kaXN0L2NsaS5qc1wiXSk7XG5cdFx0XHRhc3NlcnQuZXF1YWwoc3J2LmN3ZCwgXCIvdG1wL3Byb2plY3RcIik7XG5cdFx0XHRhc3NlcnQuZXF1YWwoc3J2LmVudi5HU0RfQ0xJX1BBVEgsIFwiL3RtcC9nc2RcIik7XG5cdFx0XHRhc3NlcnQuZXF1YWwoc3J2LmVudi5HU0RfUEVSU0lTVF9XUklURV9HQVRFX1NUQVRFLCBcIjFcIik7XG5cdFx0XHRhc3NlcnQuZXF1YWwoc3J2LmVudi5HU0RfV09SS0ZMT1dfUFJPSkVDVF9ST09ULCBcIi90bXAvcHJvamVjdFwiKTtcblx0XHRcdGFzc2VydC5kZWVwRXF1YWwob3B0aW9ucy5kaXNhbGxvd2VkVG9vbHMsIFtcIkFza1VzZXJRdWVzdGlvblwiXSk7XG5cdFx0XHRhc3NlcnQuZGVlcEVxdWFsKG9wdGlvbnMuYWxsb3dlZFRvb2xzLCBbXG5cdFx0XHRcdFwiUmVhZFwiLFxuXHRcdFx0XHRcIldyaXRlXCIsXG5cdFx0XHRcdFwiRWRpdFwiLFxuXHRcdFx0XHRcIkdsb2JcIixcblx0XHRcdFx0XCJHcmVwXCIsXG5cdFx0XHRcdFwiQmFzaFwiLFxuXHRcdFx0XHRcIkFnZW50XCIsXG5cdFx0XHRcdFwiV2ViRmV0Y2hcIixcblx0XHRcdFx0XCJXZWJTZWFyY2hcIixcblx0XHRcdFx0XCJtY3BfX2dzZC13b3JrZmxvd19fKlwiLFxuXHRcdFx0XSk7XG5cdFx0fSBmaW5hbGx5IHtcblx0XHRcdHJlc3RvcmUoKTtcblx0XHR9XG5cdH0pO1xuXG5cdHRlc3QoXCJidWlsZFNka09wdGlvbnMgcHJlZmVycyBjdXN0b20gd29ya2Zsb3cgTUNQIHF1ZXN0aW9uIHRvb2xzIG92ZXIgbmF0aXZlIEFza1VzZXJRdWVzdGlvblwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVzdG9yZSA9IHNldFdvcmtmbG93TWNwRW52KHtcblx0XHRcdEdTRF9XT1JLRkxPV19NQ1BfQ09NTUFORDogXCJub2RlXCIsXG5cdFx0XHRHU0RfV09SS0ZMT1dfTUNQX05BTUU6IFwiY3VzdG9tLXdvcmtmbG93XCIsXG5cdFx0XHRHU0RfV09SS0ZMT1dfTUNQX0FSR1M6IEpTT04uc3RyaW5naWZ5KFtcInBhY2thZ2VzL21jcC1zZXJ2ZXIvZGlzdC9jbGkuanNcIl0pLFxuXHRcdFx0R1NEX1dPUktGTE9XX01DUF9FTlY6IEpTT04uc3RyaW5naWZ5KHsgR1NEX0NMSV9QQVRIOiBcIi90bXAvZ3NkXCIgfSksXG5cdFx0XHRHU0RfV09SS0ZMT1dfTUNQX0NXRDogXCIvdG1wL3Byb2plY3RcIixcblx0XHR9KTtcblx0XHR0cnkge1xuXG5cdFx0XHRjb25zdCBvcHRpb25zID0gYnVpbGRTZGtPcHRpb25zKFwiY2xhdWRlLXNvbm5ldC00LTIwMjUwNTE0XCIsIFwidGVzdFwiKTtcblx0XHRcdGNvbnN0IG1jcFNlcnZlcnMgPSBvcHRpb25zLm1jcFNlcnZlcnMgYXMgUmVjb3JkPHN0cmluZywgYW55Pjtcblx0XHRcdGFzc2VydC5vayhtY3BTZXJ2ZXJzPy5bXCJjdXN0b20td29ya2Zsb3dcIl0sIFwiZXhwZWN0ZWQgY3VzdG9tIHdvcmtmbG93IHNlcnZlciBjb25maWdcIik7XG5cdFx0XHRhc3NlcnQuZGVlcEVxdWFsKG9wdGlvbnMuZGlzYWxsb3dlZFRvb2xzLCBbXCJBc2tVc2VyUXVlc3Rpb25cIl0pO1xuXHRcdFx0YXNzZXJ0LmRlZXBFcXVhbChvcHRpb25zLmFsbG93ZWRUb29scywgW1xuXHRcdFx0XHRcIlJlYWRcIixcblx0XHRcdFx0XCJXcml0ZVwiLFxuXHRcdFx0XHRcIkVkaXRcIixcblx0XHRcdFx0XCJHbG9iXCIsXG5cdFx0XHRcdFwiR3JlcFwiLFxuXHRcdFx0XHRcIkJhc2hcIixcblx0XHRcdFx0XCJBZ2VudFwiLFxuXHRcdFx0XHRcIldlYkZldGNoXCIsXG5cdFx0XHRcdFwiV2ViU2VhcmNoXCIsXG5cdFx0XHRcdFwibWNwX19jdXN0b20td29ya2Zsb3dfXypcIixcblx0XHRcdF0pO1xuXHRcdH0gZmluYWxseSB7XG5cdFx0XHRyZXN0b3JlKCk7XG5cdFx0fVxuXHR9KTtcblxuXHR0ZXN0KFwiYnVpbGRTZGtPcHRpb25zIGF1dG8tZGlzY292ZXJzIGJ1bmRsZWQgTUNQIHNlcnZlciBldmVuIHdpdGhvdXQgZW52IGhpbnRzXCIsICgpID0+IHtcblx0XHQvLyBVc2Ugc2V0V29ya2Zsb3dNY3BFbnYgd2l0aCBubyB2YWx1ZXMgdG8gc2F2ZSBjdXJyZW50IHN0YXRlO1xuXHRcdC8vIHJlc3RvcmUoKSBpbiBmaW5hbGx5IHdpbGwgcHV0IGl0IGJhY2sgY29ycmVjdGx5IChpbmNsdWRpbmdcblx0XHQvLyBkZWxldGluZyBhbnkga2V5cyB0aGF0IHN0YXJ0ZWQgYXMgdW5kZWZpbmVkIFx1MjAxNCB0aGUgIzQ4MDggYnVnXG5cdFx0Ly8gdGhlIG5haXZlIGBwcm9jZXNzLmVudi5YID0gcHJldi5YYCBwYXR0ZXJuIGludHJvZHVjZWQpLlxuXHRcdGNvbnN0IHJlc3RvcmUgPSBzZXRXb3JrZmxvd01jcEVudih7fSk7XG5cdFx0dHJ5IHtcblx0XHRcdGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfTUNQX0NPTU1BTkQ7XG5cdFx0XHRkZWxldGUgcHJvY2Vzcy5lbnYuR1NEX1dPUktGTE9XX01DUF9OQU1FO1xuXHRcdFx0ZGVsZXRlIHByb2Nlc3MuZW52LkdTRF9XT1JLRkxPV19NQ1BfQVJHUztcblx0XHRcdGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfTUNQX0VOVjtcblx0XHRcdGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfTUNQX0NXRDtcblxuXHRcdFx0Y29uc3Qgb3JpZ2luYWxDd2QgPSBwcm9jZXNzLmN3ZCgpO1xuXHRcdFx0Y29uc3QgZW1wdHlEaXIgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImNsYXVkZS1tY3Atbm9uZS1cIikpO1xuXHRcdFx0cHJvY2Vzcy5jaGRpcihlbXB0eURpcik7XG5cdFx0XHRjb25zdCBvcHRpb25zID0gYnVpbGRTZGtPcHRpb25zKFwiY2xhdWRlLXNvbm5ldC00LTIwMjUwNTE0XCIsIFwidGVzdFwiKTtcblx0XHRcdHByb2Nlc3MuY2hkaXIob3JpZ2luYWxDd2QpO1xuXHRcdFx0Ly8gVGhlIGJ1bmRsZWQgQ0xJIG1heSBvciBtYXkgbm90IGJlIGRpc2NvdmVyYWJsZSBkZXBlbmRpbmcgb25cblx0XHRcdC8vIHdoZXRoZXIgdGhlIGJ1aWxkIG91dHB1dCBleGlzdHMgcmVsYXRpdmUgdG8gaW1wb3J0Lm1ldGEudXJsLlxuXHRcdFx0Ly8gRWl0aGVyIG91dGNvbWUgaXMgdmFsaWQgXHUyMDE0IHRoZSBrZXkgaW52YXJpYW50IGlzIG5vIGNyYXNoLlxuXHRcdFx0Y29uc3QgbWNwU2VydmVycyA9IChvcHRpb25zIGFzIGFueSkubWNwU2VydmVycztcblx0XHRcdGlmIChtY3BTZXJ2ZXJzKSB7XG5cdFx0XHRcdGFzc2VydC5vayhtY3BTZXJ2ZXJzW1wiZ3NkLXdvcmtmbG93XCJdLCBcImlmIHByZXNlbnQsIG11c3QgYmUgZ3NkLXdvcmtmbG93XCIpO1xuXHRcdFx0XHRhc3NlcnQuZGVlcEVxdWFsKChvcHRpb25zIGFzIGFueSkuZGlzYWxsb3dlZFRvb2xzLCBbXCJBc2tVc2VyUXVlc3Rpb25cIl0pO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0YXNzZXJ0LmRlZXBFcXVhbCgob3B0aW9ucyBhcyBhbnkpLmRpc2FsbG93ZWRUb29scywgW10pO1xuXHRcdFx0fVxuXHRcdFx0cm1TeW5jKGVtcHR5RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG5cdFx0fSBmaW5hbGx5IHtcblx0XHRcdHJlc3RvcmUoKTtcblx0XHR9XG5cdH0pO1xuXG5cdHRlc3QoXCJidWlsZFNka09wdGlvbnMgYXV0by1kZXRlY3RzIGxvY2FsIHdvcmtmbG93IE1DUCBkaXN0IENMSSB3aGVuIHByZXNlbnRcIiwgKCkgPT4ge1xuXHRcdC8vIEdTRF9DTElfUEFUSCBpc24ndCBpbiBXT1JLRkxPV19NQ1BfRU5WX0tFWVMsIHNvIHNhdmUrcmVzdG9yZSBpdFxuXHRcdC8vIG1hbnVhbGx5IGFyb3VuZCBzZXRXb3JrZmxvd01jcEVudiB3aGljaCBoYW5kbGVzIHRoZSBNQ1Aga2V5cy5cblx0XHRjb25zdCBwcmV2Q2xpUGF0aCA9IHByb2Nlc3MuZW52LkdTRF9DTElfUEFUSDtcblx0XHRjb25zdCByZXN0b3JlID0gc2V0V29ya2Zsb3dNY3BFbnYoe30pO1xuXHRcdGNvbnN0IG9yaWdpbmFsQ3dkID0gcHJvY2Vzcy5jd2QoKTtcblx0XHRjb25zdCByZXBvRGlyID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJjbGF1ZGUtbWNwLWRldGVjdC1cIikpO1xuXHRcdHRyeSB7XG5cdFx0XHRkZWxldGUgcHJvY2Vzcy5lbnYuR1NEX1dPUktGTE9XX01DUF9DT01NQU5EO1xuXHRcdFx0ZGVsZXRlIHByb2Nlc3MuZW52LkdTRF9XT1JLRkxPV19NQ1BfTkFNRTtcblx0XHRcdGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfTUNQX0FSR1M7XG5cdFx0XHRkZWxldGUgcHJvY2Vzcy5lbnYuR1NEX1dPUktGTE9XX01DUF9FTlY7XG5cdFx0XHRkZWxldGUgcHJvY2Vzcy5lbnYuR1NEX1dPUktGTE9XX01DUF9DV0Q7XG5cdFx0XHRwcm9jZXNzLmVudi5HU0RfQ0xJX1BBVEggPSBcIi90bXAvZ3NkXCI7XG5cblx0XHRcdGNvbnN0IGRpc3REaXIgPSBqb2luKHJlcG9EaXIsIFwicGFja2FnZXNcIiwgXCJtY3Atc2VydmVyXCIsIFwiZGlzdFwiKTtcblx0XHRcdG1rZGlyU3luYyhkaXN0RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblx0XHRcdHdyaXRlRmlsZVN5bmMoam9pbihkaXN0RGlyLCBcImNsaS5qc1wiKSwgXCIjIS91c3IvYmluL2VudiBub2RlXFxuXCIpO1xuXHRcdFx0cHJvY2Vzcy5jaGRpcihyZXBvRGlyKTtcblx0XHRcdGNvbnN0IHJlc29sdmVkUmVwb0RpciA9IHJlYWxwYXRoU3luYyhyZXBvRGlyKTtcblxuXHRcdFx0Y29uc3Qgb3B0aW9ucyA9IGJ1aWxkU2RrT3B0aW9ucyhcImNsYXVkZS1zb25uZXQtNC0yMDI1MDUxNFwiLCBcInRlc3RcIik7XG5cdFx0XHRjb25zdCBtY3BTZXJ2ZXJzID0gb3B0aW9ucy5tY3BTZXJ2ZXJzIGFzIFJlY29yZDxzdHJpbmcsIGFueT47XG5cdFx0XHRhc3NlcnQub2sobWNwU2VydmVycz8uW1wiZ3NkLXdvcmtmbG93XCJdLCBcImV4cGVjdGVkIGdzZC13b3JrZmxvdyBzZXJ2ZXIgY29uZmlnXCIpO1xuXHRcdFx0Y29uc3Qgc3J2ID0gbWNwU2VydmVyc1tcImdzZC13b3JrZmxvd1wiXTtcblx0XHRcdGFzc2VydC5lcXVhbChzcnYuY29tbWFuZCwgcHJvY2Vzcy5leGVjUGF0aCk7XG5cdFx0XHRhc3NlcnQuZGVlcEVxdWFsKHNydi5hcmdzLCBbcmVhbHBhdGhTeW5jKHJlc29sdmUocmVwb0RpciwgXCJwYWNrYWdlc1wiLCBcIm1jcC1zZXJ2ZXJcIiwgXCJkaXN0XCIsIFwiY2xpLmpzXCIpKV0pO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKHNydi5jd2QsIHJlc29sdmVkUmVwb0Rpcik7XG5cdFx0XHRhc3NlcnQuZXF1YWwoc3J2LmVudi5HU0RfQ0xJX1BBVEgsIFwiL3RtcC9nc2RcIik7XG5cdFx0XHRhc3NlcnQuZXF1YWwoc3J2LmVudi5HU0RfUEVSU0lTVF9XUklURV9HQVRFX1NUQVRFLCBcIjFcIik7XG5cdFx0XHRhc3NlcnQuZXF1YWwoc3J2LmVudi5HU0RfV09SS0ZMT1dfUFJPSkVDVF9ST09ULCByZXNvbHZlZFJlcG9EaXIpO1xuXHRcdFx0YXNzZXJ0LmRlZXBFcXVhbChvcHRpb25zLmRpc2FsbG93ZWRUb29scywgW1wiQXNrVXNlclF1ZXN0aW9uXCJdKTtcblx0XHR9IGZpbmFsbHkge1xuXHRcdFx0cHJvY2Vzcy5jaGRpcihvcmlnaW5hbEN3ZCk7XG5cdFx0XHRybVN5bmMocmVwb0RpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuXHRcdFx0cmVzdG9yZSgpO1xuXHRcdFx0Ly8gR1NEX0NMSV9QQVRIIGlzbid0IGluIHNldFdvcmtmbG93TWNwRW52J3Mgc2NvcGUgXHUyMDE0IHJlc3RvcmUgaXQgaGVyZS5cblx0XHRcdGlmIChwcmV2Q2xpUGF0aCA9PT0gdW5kZWZpbmVkKSB7XG5cdFx0XHRcdGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfQ0xJX1BBVEg7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRwcm9jZXNzLmVudi5HU0RfQ0xJX1BBVEggPSBwcmV2Q2xpUGF0aDtcblx0XHRcdH1cblx0XHR9XG5cdH0pO1xuXG5cdHRlc3QoXCJidWlsZFNka09wdGlvbnMgcHJlc2VydmVzIHJ1bnRpbWUgY2FsbGJhY2tzIHN1Y2ggYXMgb25FbGljaXRhdGlvblwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVzdG9yZSA9IHNldFdvcmtmbG93TWNwRW52KHt9KTtcblx0XHRjb25zdCBvbkVsaWNpdGF0aW9uID0gYXN5bmMgKCkgPT4gKHsgYWN0aW9uOiBcImRlY2xpbmVcIiBhcyBjb25zdCB9KTtcblx0XHR0cnkge1xuXHRcdFx0ZGVsZXRlIHByb2Nlc3MuZW52LkdTRF9XT1JLRkxPV19NQ1BfQ09NTUFORDtcblx0XHRcdGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfTUNQX05BTUU7XG5cdFx0XHRkZWxldGUgcHJvY2Vzcy5lbnYuR1NEX1dPUktGTE9XX01DUF9BUkdTO1xuXHRcdFx0ZGVsZXRlIHByb2Nlc3MuZW52LkdTRF9XT1JLRkxPV19NQ1BfRU5WO1xuXHRcdFx0ZGVsZXRlIHByb2Nlc3MuZW52LkdTRF9XT1JLRkxPV19NQ1BfQ1dEO1xuXHRcdFx0Y29uc3Qgb3B0aW9ucyA9IGJ1aWxkU2RrT3B0aW9ucyhcImNsYXVkZS1zb25uZXQtNC0yMDI1MDUxNFwiLCBcInRlc3RcIiwgdW5kZWZpbmVkLCB7IG9uRWxpY2l0YXRpb24gfSk7XG5cdFx0XHRhc3NlcnQuZXF1YWwob3B0aW9ucy5vbkVsaWNpdGF0aW9uLCBvbkVsaWNpdGF0aW9uKTtcblx0XHR9IGZpbmFsbHkge1xuXHRcdFx0cmVzdG9yZSgpO1xuXHRcdH1cblx0fSk7XG59KTtcblxuZGVzY3JpYmUoXCJzdHJlYW0tYWRhcHRlciBcdTIwMTQgTUNQIGVsaWNpdGF0aW9uIGJyaWRnZVwiLCAoKSA9PiB7XG5cdGNvbnN0IGFza1VzZXJRdWVzdGlvbnNSZXF1ZXN0ID0ge1xuXHRcdHNlcnZlck5hbWU6IFwiZ3NkLXdvcmtmbG93XCIsXG5cdFx0bWVzc2FnZTogXCJQbGVhc2UgYW5zd2VyIHRoZSBmb2xsb3dpbmcgcXVlc3Rpb24ocykuXCIsXG5cdFx0bW9kZTogXCJmb3JtXCIgYXMgY29uc3QsXG5cdFx0cmVxdWVzdGVkU2NoZW1hOiB7XG5cdFx0XHR0eXBlOiBcIm9iamVjdFwiIGFzIGNvbnN0LFxuXHRcdFx0cHJvcGVydGllczoge1xuXHRcdFx0XHRzdG9yYWdlX3Njb3BlOiB7XG5cdFx0XHRcdFx0dHlwZTogXCJzdHJpbmdcIixcblx0XHRcdFx0XHR0aXRsZTogXCJTdG9yYWdlXCIsXG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246IFwiRG9lcyB0aGlzIGFwcCBuZWVkIHRvIHN5bmMgYWNyb3NzIGRldmljZXM/XCIsXG5cdFx0XHRcdFx0b25lT2Y6IFtcblx0XHRcdFx0XHRcdHsgY29uc3Q6IFwiTG9jYWwtb25seSAoUmVjb21tZW5kZWQpXCIsIHRpdGxlOiBcIkxvY2FsLW9ubHkgKFJlY29tbWVuZGVkKVwiIH0sXG5cdFx0XHRcdFx0XHR7IGNvbnN0OiBcIkNsb3VkLXN5bmNlZFwiLCB0aXRsZTogXCJDbG91ZC1zeW5jZWRcIiB9LFxuXHRcdFx0XHRcdFx0eyBjb25zdDogXCJOb25lIG9mIHRoZSBhYm92ZVwiLCB0aXRsZTogXCJOb25lIG9mIHRoZSBhYm92ZVwiIH0sXG5cdFx0XHRcdFx0XSxcblx0XHRcdFx0fSxcblx0XHRcdFx0c3RvcmFnZV9zY29wZV9fbm90ZToge1xuXHRcdFx0XHRcdHR5cGU6IFwic3RyaW5nXCIsXG5cdFx0XHRcdFx0dGl0bGU6IFwiU3RvcmFnZSBOb3RlXCIsXG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246IFwiT3B0aW9uYWwgbm90ZSBmb3IgTm9uZSBvZiB0aGUgYWJvdmUuXCIsXG5cdFx0XHRcdH0sXG5cdFx0XHRcdHBsYXRmb3JtOiB7XG5cdFx0XHRcdFx0dHlwZTogXCJhcnJheVwiLFxuXHRcdFx0XHRcdHRpdGxlOiBcIlBsYXRmb3JtXCIsXG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246IFwiV2hlcmUgc2hvdWxkIGl0IHJ1bj9cIixcblx0XHRcdFx0XHRpdGVtczoge1xuXHRcdFx0XHRcdFx0YW55T2Y6IFtcblx0XHRcdFx0XHRcdFx0eyBjb25zdDogXCJXZWJcIiwgdGl0bGU6IFwiV2ViXCIgfSxcblx0XHRcdFx0XHRcdFx0eyBjb25zdDogXCJEZXNrdG9wXCIsIHRpdGxlOiBcIkRlc2t0b3BcIiB9LFxuXHRcdFx0XHRcdFx0XHR7IGNvbnN0OiBcIk1vYmlsZVwiLCB0aXRsZTogXCJNb2JpbGVcIiB9LFxuXHRcdFx0XHRcdFx0XSxcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHR9LFxuXHRcdFx0fSxcblx0XHR9LFxuXHR9O1xuXG5cdHRlc3QoXCJwYXJzZUFza1VzZXJRdWVzdGlvbnNFbGljaXRhdGlvbiByZWJ1aWxkcyBpbnRlcnZpZXcgcXVlc3Rpb25zIGZyb20gdGhlIE1DUCBzY2hlbWFcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHF1ZXN0aW9ucyA9IHBhcnNlQXNrVXNlclF1ZXN0aW9uc0VsaWNpdGF0aW9uKGFza1VzZXJRdWVzdGlvbnNSZXF1ZXN0KTtcblx0XHRhc3NlcnQuZGVlcEVxdWFsKHF1ZXN0aW9ucywgW1xuXHRcdFx0e1xuXHRcdFx0XHRpZDogXCJzdG9yYWdlX3Njb3BlXCIsXG5cdFx0XHRcdGhlYWRlcjogXCJTdG9yYWdlXCIsXG5cdFx0XHRcdHF1ZXN0aW9uOiBcIkRvZXMgdGhpcyBhcHAgbmVlZCB0byBzeW5jIGFjcm9zcyBkZXZpY2VzP1wiLFxuXHRcdFx0XHRvcHRpb25zOiBbXG5cdFx0XHRcdFx0eyBsYWJlbDogXCJMb2NhbC1vbmx5IChSZWNvbW1lbmRlZClcIiwgZGVzY3JpcHRpb246IFwiXCIgfSxcblx0XHRcdFx0XHR7IGxhYmVsOiBcIkNsb3VkLXN5bmNlZFwiLCBkZXNjcmlwdGlvbjogXCJcIiB9LFxuXHRcdFx0XHRdLFxuXHRcdFx0XHRub3RlRmllbGRJZDogXCJzdG9yYWdlX3Njb3BlX19ub3RlXCIsXG5cdFx0XHR9LFxuXHRcdFx0e1xuXHRcdFx0XHRpZDogXCJwbGF0Zm9ybVwiLFxuXHRcdFx0XHRoZWFkZXI6IFwiUGxhdGZvcm1cIixcblx0XHRcdFx0cXVlc3Rpb246IFwiV2hlcmUgc2hvdWxkIGl0IHJ1bj9cIixcblx0XHRcdFx0b3B0aW9uczogW1xuXHRcdFx0XHRcdHsgbGFiZWw6IFwiV2ViXCIsIGRlc2NyaXB0aW9uOiBcIlwiIH0sXG5cdFx0XHRcdFx0eyBsYWJlbDogXCJEZXNrdG9wXCIsIGRlc2NyaXB0aW9uOiBcIlwiIH0sXG5cdFx0XHRcdFx0eyBsYWJlbDogXCJNb2JpbGVcIiwgZGVzY3JpcHRpb246IFwiXCIgfSxcblx0XHRcdFx0XSxcblx0XHRcdFx0YWxsb3dNdWx0aXBsZTogdHJ1ZSxcblx0XHRcdH0sXG5cdFx0XSk7XG5cdH0pO1xuXG5cdHRlc3QoXCJyb3VuZFJlc3VsdFRvRWxpY2l0YXRpb25Db250ZW50IHByZXNlcnZlcyBub3RlcyBmb3IgTm9uZSBvZiB0aGUgYWJvdmVcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHF1ZXN0aW9ucyA9IHBhcnNlQXNrVXNlclF1ZXN0aW9uc0VsaWNpdGF0aW9uKGFza1VzZXJRdWVzdGlvbnNSZXF1ZXN0KTtcblx0XHRhc3NlcnQub2socXVlc3Rpb25zKTtcblxuXHRcdGNvbnN0IGNvbnRlbnQgPSByb3VuZFJlc3VsdFRvRWxpY2l0YXRpb25Db250ZW50KHF1ZXN0aW9ucywge1xuXHRcdFx0ZW5kSW50ZXJ2aWV3OiBmYWxzZSxcblx0XHRcdGFuc3dlcnM6IHtcblx0XHRcdFx0c3RvcmFnZV9zY29wZToge1xuXHRcdFx0XHRcdHNlbGVjdGVkOiBcIk5vbmUgb2YgdGhlIGFib3ZlXCIsXG5cdFx0XHRcdFx0bm90ZXM6IFwiTmVlZHMgc2VsZWN0aXZlIHN5bmMgbGF0ZXJcIixcblx0XHRcdFx0fSxcblx0XHRcdFx0cGxhdGZvcm06IHtcblx0XHRcdFx0XHRzZWxlY3RlZDogW1wiV2ViXCIsIFwiRGVza3RvcFwiXSxcblx0XHRcdFx0XHRub3RlczogXCJcIixcblx0XHRcdFx0fSxcblx0XHRcdH0sXG5cdFx0fSk7XG5cblx0XHRhc3NlcnQuZGVlcEVxdWFsKGNvbnRlbnQsIHtcblx0XHRcdHN0b3JhZ2Vfc2NvcGU6IFwiTm9uZSBvZiB0aGUgYWJvdmVcIixcblx0XHRcdHN0b3JhZ2Vfc2NvcGVfX25vdGU6IFwiTmVlZHMgc2VsZWN0aXZlIHN5bmMgbGF0ZXJcIixcblx0XHRcdHBsYXRmb3JtOiBbXCJXZWJcIiwgXCJEZXNrdG9wXCJdLFxuXHRcdH0pO1xuXHR9KTtcblxuXHR0ZXN0KFwiY3JlYXRlQ2xhdWRlQ29kZUVsaWNpdGF0aW9uSGFuZGxlciBhY2NlcHRzIGludGVydmlldy1zdHlsZSBhbnN3ZXJzIGZyb20gY3VzdG9tIFVJXCIsIGFzeW5jICgpID0+IHtcblx0XHRjb25zdCBoYW5kbGVyID0gY3JlYXRlQ2xhdWRlQ29kZUVsaWNpdGF0aW9uSGFuZGxlcih7XG5cdFx0XHRjdXN0b206IGFzeW5jIChfZmFjdG9yeTogYW55KSA9PiAoe1xuXHRcdFx0XHRlbmRJbnRlcnZpZXc6IGZhbHNlLFxuXHRcdFx0XHRhbnN3ZXJzOiB7XG5cdFx0XHRcdFx0c3RvcmFnZV9zY29wZToge1xuXHRcdFx0XHRcdFx0c2VsZWN0ZWQ6IFwiQ2xvdWQtc3luY2VkXCIsXG5cdFx0XHRcdFx0XHRub3RlczogXCJcIixcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdHBsYXRmb3JtOiB7XG5cdFx0XHRcdFx0XHRzZWxlY3RlZDogW1wiV2ViXCIsIFwiTW9iaWxlXCJdLFxuXHRcdFx0XHRcdFx0bm90ZXM6IFwiXCIsXG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0fSxcblx0XHRcdH0pLFxuXHRcdH0gYXMgYW55KTtcblxuXHRcdGFzc2VydC5vayhoYW5kbGVyKTtcblx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVyIShhc2tVc2VyUXVlc3Rpb25zUmVxdWVzdCwgeyBzaWduYWw6IG5ldyBBYm9ydENvbnRyb2xsZXIoKS5zaWduYWwgfSk7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQsIHtcblx0XHRcdGFjdGlvbjogXCJhY2NlcHRcIixcblx0XHRcdGNvbnRlbnQ6IHtcblx0XHRcdFx0c3RvcmFnZV9zY29wZTogXCJDbG91ZC1zeW5jZWRcIixcblx0XHRcdFx0cGxhdGZvcm06IFtcIldlYlwiLCBcIk1vYmlsZVwiXSxcblx0XHRcdH0sXG5cdFx0fSk7XG5cdH0pO1xuXG5cdHRlc3QoXCJjcmVhdGVDbGF1ZGVDb2RlRWxpY2l0YXRpb25IYW5kbGVyIGZhbGxzIGJhY2sgdG8gZGlhbG9nIHByb21wdHMgd2hlbiBjdXN0b20gVUkgaXMgdW5hdmFpbGFibGVcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IHVpID0ge1xuXHRcdFx0Y3VzdG9tOiBhc3luYyAoKSA9PiB1bmRlZmluZWQsXG5cdFx0XHRzZWxlY3Q6IGFzeW5jIChfdGl0bGU6IHN0cmluZywgb3B0aW9uczogc3RyaW5nW10sIG9wdHM/OiB7IGFsbG93TXVsdGlwbGU/OiBib29sZWFuIH0pID0+IHtcblx0XHRcdFx0aWYgKG9wdHM/LmFsbG93TXVsdGlwbGUpIHJldHVybiBbXCJEZXNrdG9wXCIsIFwiTW9iaWxlXCJdO1xuXHRcdFx0XHRyZXR1cm4gb3B0aW9ucy5pbmNsdWRlcyhcIk5vbmUgb2YgdGhlIGFib3ZlXCIpID8gXCJOb25lIG9mIHRoZSBhYm92ZVwiIDogb3B0aW9uc1swXTtcblx0XHRcdH0sXG5cdFx0XHRpbnB1dDogYXN5bmMgKCkgPT4gXCJDTEktb25seSBkZXBsb3ltZW50IHRhcmdldFwiLFxuXHRcdH07XG5cdFx0Y29uc3QgaGFuZGxlciA9IGNyZWF0ZUNsYXVkZUNvZGVFbGljaXRhdGlvbkhhbmRsZXIodWkgYXMgYW55KTtcblx0XHRhc3NlcnQub2soaGFuZGxlcik7XG5cblx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVyIShhc2tVc2VyUXVlc3Rpb25zUmVxdWVzdCwgeyBzaWduYWw6IG5ldyBBYm9ydENvbnRyb2xsZXIoKS5zaWduYWwgfSk7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQsIHtcblx0XHRcdGFjdGlvbjogXCJhY2NlcHRcIixcblx0XHRcdGNvbnRlbnQ6IHtcblx0XHRcdFx0c3RvcmFnZV9zY29wZTogXCJOb25lIG9mIHRoZSBhYm92ZVwiLFxuXHRcdFx0XHRzdG9yYWdlX3Njb3BlX19ub3RlOiBcIkNMSS1vbmx5IGRlcGxveW1lbnQgdGFyZ2V0XCIsXG5cdFx0XHRcdHBsYXRmb3JtOiBbXCJEZXNrdG9wXCIsIFwiTW9iaWxlXCJdLFxuXHRcdFx0fSxcblx0XHR9KTtcblx0fSk7XG5cblx0dGVzdChcInBhcnNlVGV4dElucHV0RWxpY2l0YXRpb24gcmVjb2duaXplcyBzZWN1cmUgZnJlZS10ZXh0IE1DUCBmb3Jtc1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVxdWVzdCA9IHtcblx0XHRcdHNlcnZlck5hbWU6IFwiZ3NkLXdvcmtmbG93XCIsXG5cdFx0XHRtZXNzYWdlOiBcIkVudGVyIHZhbHVlcyBmb3IgZW52aXJvbm1lbnQgdmFyaWFibGVzLlwiLFxuXHRcdFx0bW9kZTogXCJmb3JtXCIgYXMgY29uc3QsXG5cdFx0XHRyZXF1ZXN0ZWRTY2hlbWE6IHtcblx0XHRcdFx0dHlwZTogXCJvYmplY3RcIiBhcyBjb25zdCxcblx0XHRcdFx0cHJvcGVydGllczoge1xuXHRcdFx0XHRcdFRFU1RfUEFTU1dPUkQ6IHtcblx0XHRcdFx0XHRcdHR5cGU6IFwic3RyaW5nXCIsXG5cdFx0XHRcdFx0XHR0aXRsZTogXCJURVNUX1BBU1NXT1JEXCIsXG5cdFx0XHRcdFx0XHRkZXNjcmlwdGlvbjogXCJGb3JtYXQ6IG1pbiA4IGNoYXJhY3RlcnNcXG5MZWF2ZSBlbXB0eSB0byBza2lwLlwiLFxuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0UFJPSkVDVF9OQU1FOiB7XG5cdFx0XHRcdFx0XHR0eXBlOiBcInN0cmluZ1wiLFxuXHRcdFx0XHRcdFx0dGl0bGU6IFwiUFJPSkVDVF9OQU1FXCIsXG5cdFx0XHRcdFx0XHRkZXNjcmlwdGlvbjogXCJIdW1hbi1yZWFkYWJsZSBwcm9qZWN0IG5hbWUuXCIsXG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0fSxcblx0XHRcdH0sXG5cdFx0fTtcblxuXHRcdGNvbnN0IHBhcnNlZCA9IHBhcnNlVGV4dElucHV0RWxpY2l0YXRpb24ocmVxdWVzdCBhcyBhbnkpO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwocGFyc2VkLCBbXG5cdFx0XHR7XG5cdFx0XHRcdGlkOiBcIlRFU1RfUEFTU1dPUkRcIixcblx0XHRcdFx0dGl0bGU6IFwiVEVTVF9QQVNTV09SRFwiLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogXCJGb3JtYXQ6IG1pbiA4IGNoYXJhY3RlcnNcXG5MZWF2ZSBlbXB0eSB0byBza2lwLlwiLFxuXHRcdFx0XHRyZXF1aXJlZDogZmFsc2UsXG5cdFx0XHRcdHNlY3VyZTogdHJ1ZSxcblx0XHRcdH0sXG5cdFx0XHR7XG5cdFx0XHRcdGlkOiBcIlBST0pFQ1RfTkFNRVwiLFxuXHRcdFx0XHR0aXRsZTogXCJQUk9KRUNUX05BTUVcIixcblx0XHRcdFx0ZGVzY3JpcHRpb246IFwiSHVtYW4tcmVhZGFibGUgcHJvamVjdCBuYW1lLlwiLFxuXHRcdFx0XHRyZXF1aXJlZDogZmFsc2UsXG5cdFx0XHRcdHNlY3VyZTogZmFsc2UsXG5cdFx0XHR9LFxuXHRcdF0pO1xuXHR9KTtcblxuXHR0ZXN0KFwicGFyc2VUZXh0SW5wdXRFbGljaXRhdGlvbiBhY2NlcHRzIGxlZ2FjeSBrZXlzIHNjaGVtYSBhbmQgc2tpcHMgdW5zdXBwb3J0ZWQgZmllbGRzXCIsICgpID0+IHtcblx0XHRjb25zdCByZXF1ZXN0ID0ge1xuXHRcdFx0c2VydmVyTmFtZTogXCJnc2Qtd29ya2Zsb3dcIixcblx0XHRcdG1lc3NhZ2U6IFwiRW50ZXIgc2VjdXJlIHZhbHVlc1wiLFxuXHRcdFx0bW9kZTogXCJmb3JtXCIgYXMgY29uc3QsXG5cdFx0XHRyZXF1ZXN0ZWRTY2hlbWE6IHtcblx0XHRcdFx0dHlwZTogXCJvYmplY3RcIiBhcyBjb25zdCxcblx0XHRcdFx0a2V5czoge1xuXHRcdFx0XHRcdEFQSV9UT0tFTjoge1xuXHRcdFx0XHRcdFx0dHlwZTogXCJzdHJpbmdcIixcblx0XHRcdFx0XHRcdHRpdGxlOiBcIkFQSV9UT0tFTlwiLFxuXHRcdFx0XHRcdFx0ZGVzY3JpcHRpb246IFwiTGVhdmUgZW1wdHkgdG8gc2tpcC5cIixcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdE1FVEE6IHtcblx0XHRcdFx0XHRcdHR5cGU6IFwib2JqZWN0XCIsXG5cdFx0XHRcdFx0XHR0aXRsZTogXCJtZXRhZGF0YVwiLFxuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdH0sXG5cdFx0XHR9LFxuXHRcdH07XG5cblx0XHRjb25zdCBwYXJzZWQgPSBwYXJzZVRleHRJbnB1dEVsaWNpdGF0aW9uKHJlcXVlc3QgYXMgYW55KTtcblx0XHRhc3NlcnQuZGVlcEVxdWFsKHBhcnNlZCwgW1xuXHRcdFx0e1xuXHRcdFx0XHRpZDogXCJBUElfVE9LRU5cIixcblx0XHRcdFx0dGl0bGU6IFwiQVBJX1RPS0VOXCIsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiBcIkxlYXZlIGVtcHR5IHRvIHNraXAuXCIsXG5cdFx0XHRcdHJlcXVpcmVkOiBmYWxzZSxcblx0XHRcdFx0c2VjdXJlOiB0cnVlLFxuXHRcdFx0fSxcblx0XHRdKTtcblx0fSk7XG5cblx0dGVzdChcImNyZWF0ZUNsYXVkZUNvZGVFbGljaXRhdGlvbkhhbmRsZXIgY29sbGVjdHMgc2VjdXJlX2Vudl9jb2xsZWN0IGZpZWxkcyB0aHJvdWdoIGlucHV0IGRpYWxvZ3NcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IHNlY3VyZVJlcXVlc3QgPSB7XG5cdFx0XHRzZXJ2ZXJOYW1lOiBcImdzZC13b3JrZmxvd1wiLFxuXHRcdFx0bWVzc2FnZTogXCJFbnRlciB2YWx1ZXMgZm9yIGVudmlyb25tZW50IHZhcmlhYmxlcy5cIixcblx0XHRcdG1vZGU6IFwiZm9ybVwiIGFzIGNvbnN0LFxuXHRcdFx0cmVxdWVzdGVkU2NoZW1hOiB7XG5cdFx0XHRcdHR5cGU6IFwib2JqZWN0XCIgYXMgY29uc3QsXG5cdFx0XHRcdHByb3BlcnRpZXM6IHtcblx0XHRcdFx0XHRURVNUX1NFQ1VSRV9GSUVMRDoge1xuXHRcdFx0XHRcdFx0dHlwZTogXCJzdHJpbmdcIixcblx0XHRcdFx0XHRcdHRpdGxlOiBcIlRFU1RfU0VDVVJFX0ZJRUxEXCIsXG5cdFx0XHRcdFx0XHRkZXNjcmlwdGlvbjogXCJGb3JtYXQ6IFlvdXIgc2VjdXJlIHRlc3RpbmcgcGFzc3dvcmRcXG5MZWF2ZSBlbXB0eSB0byBza2lwLlwiLFxuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdH0sXG5cdFx0XHR9LFxuXHRcdH07XG5cblx0XHRjb25zdCBzZWN1cmVWYWx1ZSA9IFwidWktY29sbGVjdGVkLXZhbHVlXCI7XG5cdFx0Y29uc3QgaW5wdXRDYWxsczogQXJyYXk8eyBvcHRzPzogeyBzZWN1cmU/OiBib29sZWFuIH0gfT4gPSBbXTtcblx0XHRjb25zdCBoYW5kbGVyID0gY3JlYXRlQ2xhdWRlQ29kZUVsaWNpdGF0aW9uSGFuZGxlcih7XG5cdFx0XHRpbnB1dDogYXN5bmMgKF90aXRsZTogc3RyaW5nLCBfcGxhY2Vob2xkZXI/OiBzdHJpbmcsIG9wdHM/OiB7IHNlY3VyZT86IGJvb2xlYW4gfSkgPT4ge1xuXHRcdFx0XHRpbnB1dENhbGxzLnB1c2goeyBvcHRzIH0pO1xuXHRcdFx0XHRyZXR1cm4gc2VjdXJlVmFsdWU7XG5cdFx0XHR9LFxuXHRcdH0gYXMgYW55KTtcblx0XHRhc3NlcnQub2soaGFuZGxlcik7XG5cblx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVyIShzZWN1cmVSZXF1ZXN0IGFzIGFueSwgeyBzaWduYWw6IG5ldyBBYm9ydENvbnRyb2xsZXIoKS5zaWduYWwgfSk7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQsIHtcblx0XHRcdGFjdGlvbjogXCJhY2NlcHRcIixcblx0XHRcdGNvbnRlbnQ6IHtcblx0XHRcdFx0VEVTVF9TRUNVUkVfRklFTEQ6IHNlY3VyZVZhbHVlLFxuXHRcdFx0fSxcblx0XHR9KTtcblx0XHRhc3NlcnQuZXF1YWwoaW5wdXRDYWxscy5sZW5ndGgsIDEpO1xuXHRcdGFzc2VydC5lcXVhbChpbnB1dENhbGxzWzBdPy5vcHRzPy5zZWN1cmUsIHRydWUsIFwic2VjdXJlX2Vudl9jb2xsZWN0IGZpZWxkcyBzaG91bGQgcmVxdWVzdCBzZWN1cmUgaW5wdXRcIik7XG5cdH0pO1xufSk7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gRjIgXHUyMDE0IGFib3J0IHZzIHN0cmVhbS1leGhhdXN0ZWQgY2xhc3NpZmljYXRpb25cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5kZXNjcmliZShcInN0cmVhbS1hZGFwdGVyIFx1MjAxNCBhYm9ydCBjbGFzc2lmaWNhdGlvbiAoRjIpXCIsICgpID0+IHtcblx0dGVzdChcInJlY29nbml6ZXMgQ2xhdWRlIENvZGUgU0RLIGFib3J0IGV4Y2VwdGlvbnNcIiwgKCkgPT4ge1xuXHRcdGFzc2VydC5lcXVhbChpc0NsYXVkZUNvZGVBYm9ydEVycm9yTWVzc2FnZShcIkNsYXVkZSBDb2RlIHByb2Nlc3MgYWJvcnRlZCBieSB1c2VyXCIpLCB0cnVlKTtcblx0XHRhc3NlcnQuZXF1YWwoaXNDbGF1ZGVDb2RlQWJvcnRFcnJvck1lc3NhZ2UoXCJSZXF1ZXN0IGFib3J0ZWQgYnkgdXNlclwiKSwgdHJ1ZSk7XG5cdFx0YXNzZXJ0LmVxdWFsKGlzQ2xhdWRlQ29kZUFib3J0RXJyb3JNZXNzYWdlKFwicmF0ZSBsaW1pdCBleGNlZWRlZFwiKSwgZmFsc2UpO1xuXHR9KTtcblxuXHR0ZXN0KFwibWFrZUFib3J0ZWRNZXNzYWdlIHNldHMgc3RvcFJlYXNvbiB0byAnYWJvcnRlZCcsIG5vdCAnZXJyb3InXCIsICgpID0+IHtcblx0XHRjb25zdCBtZXNzYWdlID0gbWFrZUFib3J0ZWRNZXNzYWdlKFwiY2xhdWRlLXNvbm5ldC00LTZcIiwgXCJcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKG1lc3NhZ2Uuc3RvcFJlYXNvbiwgXCJhYm9ydGVkXCIpO1xuXHRcdGFzc2VydC5lcXVhbChtZXNzYWdlLmVycm9yTWVzc2FnZSwgdW5kZWZpbmVkKTtcblx0fSk7XG5cblx0dGVzdChcIm1ha2VBYm9ydGVkTWVzc2FnZSBwcmVzZXJ2ZXMgbGFzdC1zZWVuIHRleHQgY29udGVudFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgbWVzc2FnZSA9IG1ha2VBYm9ydGVkTWVzc2FnZShcImNsYXVkZS1zb25uZXQtNC02XCIsIFwicGFydGlhbCBtaWQtc3RyZWFtIHRleHRcIik7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChtZXNzYWdlLmNvbnRlbnQsIFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcInBhcnRpYWwgbWlkLXN0cmVhbSB0ZXh0XCIgfV0pO1xuXHR9KTtcblxuXHR0ZXN0KFwiYWJvcnRlZCBtZXNzYWdlIGlzIGRpc3Rpbmd1aXNoYWJsZSBmcm9tIHN0cmVhbS1leGhhdXN0ZWQgZXJyb3JcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGFib3J0ZWQgPSBtYWtlQWJvcnRlZE1lc3NhZ2UoXCJjbGF1ZGUtc29ubmV0LTQtNlwiLCBcIlwiKTtcblx0XHRjb25zdCBleGhhdXN0ZWQgPSBtYWtlU3RyZWFtRXhoYXVzdGVkRXJyb3JNZXNzYWdlKFwiY2xhdWRlLXNvbm5ldC00LTZcIiwgXCJcIik7XG5cdFx0YXNzZXJ0Lm5vdEVxdWFsKGFib3J0ZWQuc3RvcFJlYXNvbiwgZXhoYXVzdGVkLnN0b3BSZWFzb24pO1xuXHRcdGFzc2VydC5lcXVhbChleGhhdXN0ZWQuZXJyb3JNZXNzYWdlLCBcInN0cmVhbV9leGhhdXN0ZWRfd2l0aG91dF9yZXN1bHRcIik7XG5cdH0pO1xuXG5cdHRlc3QoXCJhYm9ydCBjYXRjaCBwcmVzZXJ2ZXMgU0RLIGRpYWdub3N0aWMgdGV4dCBpbnN0ZWFkIG9mIHBhcnRpYWwgb3V0cHV0XCIsICgpID0+IHtcblx0XHRjb25zdCB0ZXh0ID0gcmVzb2x2ZUNsYXVkZUNvZGVBYm9ydGVkTWVzc2FnZVRleHQoXG5cdFx0XHRcIlJlcXVlc3QgYWJvcnRlZCBieSB1c2VyXFxuQVBJIEVycm9yOiA1Mjkgb3ZlcmxvYWRlZFwiLFxuXHRcdFx0XCJwYXJ0aWFsIG1pZC1zdHJlYW0gdGV4dFwiLFxuXHRcdCk7XG5cblx0XHRhc3NlcnQuZXF1YWwodGV4dCwgXCJSZXF1ZXN0IGFib3J0ZWQgYnkgdXNlclxcbkFQSSBFcnJvcjogNTI5IG92ZXJsb2FkZWRcIik7XG5cdH0pO1xuXG5cdHRlc3QoXCJhYm9ydCBjYXRjaCBmYWxscyBiYWNrIHRvIHBhcnRpYWwgb3V0cHV0IGZvciBiYXJlIGFib3J0IG1hcmtlcnNcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHRleHQgPSByZXNvbHZlQ2xhdWRlQ29kZUFib3J0ZWRNZXNzYWdlVGV4dChcblx0XHRcdFwiUmVxdWVzdCBhYm9ydGVkIGJ5IHVzZXJcIixcblx0XHRcdFwicGFydGlhbCBtaWQtc3RyZWFtIHRleHRcIixcblx0XHQpO1xuXG5cdFx0YXNzZXJ0LmVxdWFsKHRleHQsIFwicGFydGlhbCBtaWQtc3RyZWFtIHRleHRcIik7XG5cdH0pO1xufSk7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gRjMgXHUyMDE0IGZpbmFsLXR1cm4gdG9vbCBjYWxscyBub3QgZHJvcHBlZFxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmRlc2NyaWJlKFwic3RyZWFtLWFkYXB0ZXIgXHUyMDE0IGZpbmFsLXR1cm4gdG9vbC1jYWxsIG1lcmdlIChGMylcIiwgKCkgPT4ge1xuXHRmdW5jdGlvbiB0b29sQ2FsbChpZDogc3RyaW5nLCBuYW1lID0gXCJiYXNoXCIpOiBBc3Npc3RhbnRNZXNzYWdlW1wiY29udGVudFwiXVtudW1iZXJdIHtcblx0XHRyZXR1cm4geyB0eXBlOiBcInRvb2xDYWxsXCIsIGlkLCBuYW1lLCBhcmd1bWVudHM6IHt9IH07XG5cdH1cblxuXHR0ZXN0KFwibWVyZ2VQZW5kaW5nVG9vbENhbGxzIGFwcGVuZHMgdG9vbCBjYWxscyBub3QgYWxyZWFkeSBpbiBpbnRlcm1lZGlhdGVcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGludGVybWVkaWF0ZTogQXNzaXN0YW50TWVzc2FnZVtcImNvbnRlbnRcIl0gPSBbdG9vbENhbGwoXCJ0b29sLTFcIildO1xuXHRcdGNvbnN0IHBlbmRpbmc6IEFzc2lzdGFudE1lc3NhZ2VbXCJjb250ZW50XCJdID0gW1xuXHRcdFx0dG9vbENhbGwoXCJ0b29sLTJcIiksXG5cdFx0XHR7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcInRyYWlsaW5nIHRleHRcIiB9LFxuXHRcdF07XG5cdFx0Y29uc3QgbWVyZ2VkID0gbWVyZ2VQZW5kaW5nVG9vbENhbGxzKGludGVybWVkaWF0ZSwgcGVuZGluZyk7XG5cdFx0YXNzZXJ0LmVxdWFsKG1lcmdlZC5sZW5ndGgsIDIpO1xuXHRcdGFzc2VydC5lcXVhbCgobWVyZ2VkWzBdIGFzIGFueSkuaWQsIFwidG9vbC0xXCIpO1xuXHRcdGFzc2VydC5lcXVhbCgobWVyZ2VkWzFdIGFzIGFueSkuaWQsIFwidG9vbC0yXCIpO1xuXHR9KTtcblxuXHR0ZXN0KFwibWVyZ2VQZW5kaW5nVG9vbENhbGxzIGlzIGlkZW1wb3RlbnQgYWNyb3NzIGR1cGxpY2F0ZSBpZHNcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGludGVybWVkaWF0ZTogQXNzaXN0YW50TWVzc2FnZVtcImNvbnRlbnRcIl0gPSBbdG9vbENhbGwoXCJ0b29sLTFcIildO1xuXHRcdGNvbnN0IHBlbmRpbmc6IEFzc2lzdGFudE1lc3NhZ2VbXCJjb250ZW50XCJdID0gW3Rvb2xDYWxsKFwidG9vbC0xXCIpLCB0b29sQ2FsbChcInRvb2wtMlwiKV07XG5cdFx0Y29uc3QgbWVyZ2VkID0gbWVyZ2VQZW5kaW5nVG9vbENhbGxzKGludGVybWVkaWF0ZSwgcGVuZGluZyk7XG5cdFx0YXNzZXJ0LmVxdWFsKG1lcmdlZC5sZW5ndGgsIDIpO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwoXG5cdFx0XHRtZXJnZWQubWFwKChiKSA9PiAoYiBhcyBhbnkpLmlkKSxcblx0XHRcdFtcInRvb2wtMVwiLCBcInRvb2wtMlwiXSxcblx0XHQpO1xuXHR9KTtcblxuXHR0ZXN0KFwibWVyZ2VQZW5kaW5nVG9vbENhbGxzIGlnbm9yZXMgbm9uLXRvb2xDYWxsIGJsb2NrcyBmcm9tIHBlbmRpbmdcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGludGVybWVkaWF0ZTogQXNzaXN0YW50TWVzc2FnZVtcImNvbnRlbnRcIl0gPSBbXTtcblx0XHRjb25zdCBwZW5kaW5nOiBBc3Npc3RhbnRNZXNzYWdlW1wiY29udGVudFwiXSA9IFtcblx0XHRcdHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiaGVsbG9cIiB9LFxuXHRcdFx0eyB0eXBlOiBcInRoaW5raW5nXCIsIHRoaW5raW5nOiBcInBvbmRlcmluZ1wiIH0sXG5cdFx0XHR0b29sQ2FsbChcInRvb2wtMVwiKSxcblx0XHRdO1xuXHRcdGNvbnN0IG1lcmdlZCA9IG1lcmdlUGVuZGluZ1Rvb2xDYWxscyhpbnRlcm1lZGlhdGUsIHBlbmRpbmcpO1xuXHRcdGFzc2VydC5lcXVhbChtZXJnZWQubGVuZ3RoLCAxKTtcblx0XHRhc3NlcnQuZXF1YWwoKG1lcmdlZFswXSBhcyBhbnkpLmlkLCBcInRvb2wtMVwiKTtcblx0fSk7XG59KTtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBGMTAgXHUyMDE0IHBlcm1pc3Npb24gbW9kZSBpcyBjb25maWd1cmFibGVcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5kZXNjcmliZShcInN0cmVhbS1hZGFwdGVyIFx1MjAxNCBwZXJtaXNzaW9uIG1vZGUgKEYxMClcIiwgKCkgPT4ge1xuXHQvLyBFYXJsaWVyIHRlc3RzIGluIHRoaXMgZmlsZSBzZXQgR1NEX1dPUktGTE9XX01DUF8qIGVudiB2YXJzIGFuZCByZXN0b3JlXG5cdC8vIHRoZW0gYnkgcmVhc3NpZ25pbmcgZnJvbSBgcHJldi4qYC4gV2hlbiBgcHJldi4qYCB3YXMgdW5kZWZpbmVkLCBub2RlXG5cdC8vIGNvZXJjZXMgdGhlIGFzc2lnbm1lbnQgdG8gdGhlIGxpdGVyYWwgc3RyaW5nIFwidW5kZWZpbmVkXCIsIHdoaWNoIHRoZW5cblx0Ly8gZmFpbHMgSlNPTi5wYXJzZSBpbnNpZGUgYnVpbGRXb3JrZmxvd01jcFNlcnZlcnMuIENsZWFyIHRoZSByZWxldmFudFxuXHQvLyBzbG90cyBiZWZvcmUgZWFjaCBwZXJtaXNzaW9uLW1vZGUgdGVzdCBzbyBidWlsZFNka09wdGlvbnMgZG9lc24ndCB0aHJvdy5cblx0ZnVuY3Rpb24gY2xlYXJXb3JrZmxvd01jcEVudigpOiB2b2lkIHtcblx0XHRmb3IgKGNvbnN0IGtleSBvZiBbXG5cdFx0XHRcIkdTRF9XT1JLRkxPV19NQ1BfQ09NTUFORFwiLFxuXHRcdFx0XCJHU0RfV09SS0ZMT1dfTUNQX05BTUVcIixcblx0XHRcdFwiR1NEX1dPUktGTE9XX01DUF9BUkdTXCIsXG5cdFx0XHRcIkdTRF9XT1JLRkxPV19NQ1BfRU5WXCIsXG5cdFx0XHRcIkdTRF9XT1JLRkxPV19NQ1BfQ1dEXCIsXG5cdFx0XSkge1xuXHRcdFx0aWYgKHByb2Nlc3MuZW52W2tleV0gPT09IHVuZGVmaW5lZCB8fCBwcm9jZXNzLmVudltrZXldID09PSBcInVuZGVmaW5lZFwiKSB7XG5cdFx0XHRcdGRlbGV0ZSBwcm9jZXNzLmVudltrZXldO1xuXHRcdFx0fVxuXHRcdH1cblx0fVxuXG5cdHRlc3QoXCJidWlsZFNka09wdGlvbnMgZGVmYXVsdHMgdG8gYnlwYXNzUGVybWlzc2lvbnMgKGdsb2JhbGx5IHVuYmxvY2tzIGFsbCB0b29scylcIiwgKCkgPT4ge1xuXHRcdGNsZWFyV29ya2Zsb3dNY3BFbnYoKTtcblx0XHRjb25zdCBvcHRzID0gYnVpbGRTZGtPcHRpb25zKFwiY2xhdWRlLXNvbm5ldC00LTZcIiwgXCJ0ZXN0XCIpO1xuXHRcdGFzc2VydC5lcXVhbChvcHRzLnBlcm1pc3Npb25Nb2RlLCBcImJ5cGFzc1Blcm1pc3Npb25zXCIpO1xuXHRcdGFzc2VydC5lcXVhbChcblx0XHRcdG9wdHMuYWxsb3dEYW5nZXJvdXNseVNraXBQZXJtaXNzaW9ucyxcblx0XHRcdHRydWUsXG5cdFx0XHRcImFsbG93RGFuZ2Vyb3VzbHlTa2lwUGVybWlzc2lvbnMgbXVzdCBiZSB0cnVlIHdoZW4gcGVybWlzc2lvbk1vZGUgaXMgYnlwYXNzUGVybWlzc2lvbnNcIixcblx0XHQpO1xuXHR9KTtcblxuXHR0ZXN0KFwiYnVpbGRTZGtPcHRpb25zIHJlc3BlY3RzIGV4cGxpY2l0IGFjY2VwdEVkaXRzIG92ZXJyaWRlXCIsICgpID0+IHtcblx0XHRjbGVhcldvcmtmbG93TWNwRW52KCk7XG5cdFx0Y29uc3Qgb3B0cyA9IGJ1aWxkU2RrT3B0aW9ucyhcImNsYXVkZS1zb25uZXQtNC02XCIsIFwidGVzdFwiLCB7IHBlcm1pc3Npb25Nb2RlOiBcImFjY2VwdEVkaXRzXCIgfSk7XG5cdFx0YXNzZXJ0LmVxdWFsKG9wdHMucGVybWlzc2lvbk1vZGUsIFwiYWNjZXB0RWRpdHNcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKFxuXHRcdFx0b3B0cy5hbGxvd0Rhbmdlcm91c2x5U2tpcFBlcm1pc3Npb25zLFxuXHRcdFx0ZmFsc2UsXG5cdFx0XHRcImFsbG93RGFuZ2Vyb3VzbHlTa2lwUGVybWlzc2lvbnMgbXVzdCBiZSBmYWxzZSBmb3Igbm9uLWJ5cGFzcyBtb2Rlc1wiLFxuXHRcdCk7XG5cdH0pO1xuXG5cdHRlc3QoXCJyZXNvbHZlQ2xhdWRlUGVybWlzc2lvbk1vZGUgZGVmYXVsdHMgdG8gYnlwYXNzUGVybWlzc2lvbnMgd2hlbiBubyBlbnYgdmFyIGlzIHNldCAoZ2xvYmFsbHkgdW5ibG9ja3MgYWxsIHRvb2xzKVwiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3QgbW9kZSA9IGF3YWl0IHJlc29sdmVDbGF1ZGVQZXJtaXNzaW9uTW9kZSh7fSk7XG5cdFx0YXNzZXJ0LmVxdWFsKG1vZGUsIFwiYnlwYXNzUGVybWlzc2lvbnNcIik7XG5cdH0pO1xuXG5cdHRlc3QoXCJyZXNvbHZlQ2xhdWRlUGVybWlzc2lvbk1vZGUgaG9ub3VycyB0aGUgR1NEX0NMQVVERV9DT0RFX1BFUk1JU1NJT05fTU9ERSBlbnYgb3ZlcnJpZGVcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IGVudiA9IHsgR1NEX0NMQVVERV9DT0RFX1BFUk1JU1NJT05fTU9ERTogXCJhY2NlcHRFZGl0c1wiIH0gYXMgTm9kZUpTLlByb2Nlc3NFbnY7XG5cdFx0Y29uc3QgbW9kZSA9IGF3YWl0IHJlc29sdmVDbGF1ZGVQZXJtaXNzaW9uTW9kZShlbnYpO1xuXHRcdGFzc2VydC5lcXVhbChtb2RlLCBcImFjY2VwdEVkaXRzXCIpO1xuXHR9KTtcblxuXHR0ZXN0KFwicmVzb2x2ZUNsYXVkZVBlcm1pc3Npb25Nb2RlIHJlamVjdHMgdW5rbm93biBvdmVycmlkZSB2YWx1ZXMgKGZhbGxiYWNrIHBhdGgpXCIsIGFzeW5jICgpID0+IHtcblx0XHRjb25zdCBlbnYgPSB7IEdTRF9DTEFVREVfQ09ERV9QRVJNSVNTSU9OX01PREU6IFwibm9uc2Vuc2VcIiB9IGFzIE5vZGVKUy5Qcm9jZXNzRW52O1xuXHRcdGNvbnN0IG1vZGUgPSBhd2FpdCByZXNvbHZlQ2xhdWRlUGVybWlzc2lvbk1vZGUoZW52KTtcblx0XHQvLyBVbmtub3duIG92ZXJyaWRlIGZhbGxzIGJhY2sgdG8gYXV0by1kZXRlY3QgXHUyMTkyIGVpdGhlciBieXBhc3Mgb3IgYWNjZXB0RWRpdHNcblx0XHRhc3NlcnQub2soXG5cdFx0XHRtb2RlID09PSBcImJ5cGFzc1Blcm1pc3Npb25zXCIgfHwgbW9kZSA9PT0gXCJhY2NlcHRFZGl0c1wiLFxuXHRcdFx0YGV4cGVjdGVkIGJ5cGFzcyBvciBhY2NlcHRFZGl0cywgZ290ICR7bW9kZX1gLFxuXHRcdCk7XG5cdH0pO1xuXG5cdHRlc3QoXCJyZXNvbHZlQ2xhdWRlUGVybWlzc2lvbk1vZGUgZmxpcHMgdG8gYnlwYXNzUGVybWlzc2lvbnMgd2hlbiBHU0RfSEVBRExFU1M9MSAoIzQ2NTcpXCIsIGFzeW5jICgpID0+IHtcblx0XHRjb25zdCBvcmlnaW5hbFdhcm4gPSBjb25zb2xlLndhcm47XG5cdFx0Y29uc29sZS53YXJuID0gKCkgPT4ge307XG5cdFx0dHJ5IHtcblx0XHRcdGNvbnN0IGVudiA9IHsgR1NEX0hFQURMRVNTOiBcIjFcIiB9IGFzIE5vZGVKUy5Qcm9jZXNzRW52O1xuXHRcdFx0Y29uc3QgbW9kZSA9IGF3YWl0IHJlc29sdmVDbGF1ZGVQZXJtaXNzaW9uTW9kZShlbnYpO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKG1vZGUsIFwiYnlwYXNzUGVybWlzc2lvbnNcIik7XG5cdFx0fSBmaW5hbGx5IHtcblx0XHRcdGNvbnNvbGUud2FybiA9IG9yaWdpbmFsV2Fybjtcblx0XHR9XG5cdH0pO1xuXG5cdHRlc3QoXCJyZXNvbHZlQ2xhdWRlUGVybWlzc2lvbk1vZGU6IGV4cGxpY2l0IG92ZXJyaWRlIHdpbnMgb3ZlciBHU0RfSEVBRExFU1M9MVwiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3QgZW52ID0ge1xuXHRcdFx0R1NEX0hFQURMRVNTOiBcIjFcIixcblx0XHRcdEdTRF9DTEFVREVfQ09ERV9QRVJNSVNTSU9OX01PREU6IFwiYWNjZXB0RWRpdHNcIixcblx0XHR9IGFzIE5vZGVKUy5Qcm9jZXNzRW52O1xuXHRcdGNvbnN0IG1vZGUgPSBhd2FpdCByZXNvbHZlQ2xhdWRlUGVybWlzc2lvbk1vZGUoZW52KTtcblx0XHRhc3NlcnQuZXF1YWwobW9kZSwgXCJhY2NlcHRFZGl0c1wiKTtcblx0fSk7XG59KTtcblxuZGVzY3JpYmUoXCJzdHJlYW0tYWRhcHRlciBcdTIwMTQgV2luZG93cyBDbGF1ZGUgcGF0aCBsb29rdXAgKCMzNzcwKVwiLCAoKSA9PiB7XG5cdHRlc3QoXCJnZXRDbGF1ZGVMb29rdXBDb21tYW5kIHVzZXMgd2hlcmUgb24gV2luZG93c1wiLCAoKSA9PiB7XG5cdFx0YXNzZXJ0LmVxdWFsKGdldENsYXVkZUxvb2t1cENvbW1hbmQoXCJ3aW4zMlwiKSwgXCJ3aGVyZSBjbGF1ZGVcIik7XG5cdH0pO1xuXG5cdHRlc3QoXCJnZXRDbGF1ZGVMb29rdXBDb21tYW5kIHVzZXMgd2hpY2ggb24gbm9uLVdpbmRvd3MgcGxhdGZvcm1zXCIsICgpID0+IHtcblx0XHRhc3NlcnQuZXF1YWwoZ2V0Q2xhdWRlTG9va3VwQ29tbWFuZChcImRhcndpblwiKSwgXCJ3aGljaCBjbGF1ZGVcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKGdldENsYXVkZUxvb2t1cENvbW1hbmQoXCJsaW51eFwiKSwgXCJ3aGljaCBjbGF1ZGVcIik7XG5cdH0pO1xuXG5cdHRlc3QoXCJwYXJzZUNsYXVkZUxvb2t1cE91dHB1dCBwcmVmZXJzIC5leGUgb24gd2luMzIgd2hlbiB3aGVyZSBvdXRwdXQgaW5jbHVkZXMgc2hpbXNcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IG91dHB1dCA9IFtcblx0XHRcdFwiQzpcXFxcVXNlcnNcXFxcZGplZmZcXFxcQXBwRGF0YVxcXFxSb2FtaW5nXFxcXG5wbVxcXFxjbGF1ZGVcIixcblx0XHRcdFwiQzpcXFxcVXNlcnNcXFxcZGplZmZcXFxcQXBwRGF0YVxcXFxSb2FtaW5nXFxcXG5wbVxcXFxjbGF1ZGUuY21kXCIsXG5cdFx0XHRcIkM6XFxcXFByb2dyYW0gRmlsZXNcXFxcQ2xhdWRlXFxcXGNsYXVkZS5leGVcIixcblx0XHRdLmpvaW4oXCJcXHJcXG5cIik7XG5cdFx0YXNzZXJ0LmVxdWFsKHBhcnNlQ2xhdWRlTG9va3VwT3V0cHV0KG91dHB1dCwgXCJ3aW4zMlwiKSwgXCJDOlxcXFxQcm9ncmFtIEZpbGVzXFxcXENsYXVkZVxcXFxjbGF1ZGUuZXhlXCIpO1xuXHR9KTtcblxuXHR0ZXN0KFwicGFyc2VDbGF1ZGVMb29rdXBPdXRwdXQga2VlcHMgZmlyc3QgbGluZSBvbiBub24td2luMzIgcGxhdGZvcm1zXCIsICgpID0+IHtcblx0XHRjb25zdCBvdXRwdXQgPSBcIi91c3IvbG9jYWwvYmluL2NsYXVkZVxcbi9vcHQvaG9tZWJyZXcvYmluL2NsYXVkZVxcblwiO1xuXHRcdGFzc2VydC5lcXVhbChwYXJzZUNsYXVkZUxvb2t1cE91dHB1dChvdXRwdXQsIFwiZGFyd2luXCIpLCBcIi91c3IvbG9jYWwvYmluL2NsYXVkZVwiKTtcblx0fSk7XG5cblx0dGVzdChcIm5vcm1hbGl6ZUNsYXVkZVBhdGhGb3JTZGsgc3dhcHMgV2luZG93cyBzaGltIHBhdGhzIHRvIGJ1bmRsZWQgY2xpLmpzXCIsICgpID0+IHtcblx0XHRjb25zdCBzaGltUGF0aCA9IFwiQzpcXFxcVXNlcnNcXFxcZGplZmZcXFxcQXBwRGF0YVxcXFxSb2FtaW5nXFxcXG5wbVxcXFxjbGF1ZGVcIjtcblx0XHRjb25zdCBidW5kbGVkID0gXCJDOlxcXFxyZXBvXFxcXG5vZGVfbW9kdWxlc1xcXFxAYW50aHJvcGljLWFpXFxcXGNsYXVkZS1hZ2VudC1zZGtcXFxcY2xpLmpzXCI7XG5cdFx0YXNzZXJ0LmVxdWFsKG5vcm1hbGl6ZUNsYXVkZVBhdGhGb3JTZGsoc2hpbVBhdGgsIFwid2luMzJcIiwgYnVuZGxlZCksIGJ1bmRsZWQpO1xuXHRcdGFzc2VydC5lcXVhbChub3JtYWxpemVDbGF1ZGVQYXRoRm9yU2RrKFwiQzpcXFxcUHJvZ3JhbSBGaWxlc1xcXFxDbGF1ZGVcXFxcY2xhdWRlLmV4ZVwiLCBcIndpbjMyXCIsIGJ1bmRsZWQpLCBcIkM6XFxcXFByb2dyYW0gRmlsZXNcXFxcQ2xhdWRlXFxcXGNsYXVkZS5leGVcIik7XG5cdH0pO1xuXG5cdHRlc3QoXCJyZXNvbHZlQnVuZGxlZENsYXVkZUNsaVBhdGggcmV0dXJucyBhIC5qcyBwYXRoIHdoZW4gU0RLIHBhY2thZ2UgaXMgcHJlc2VudFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVzb2x2ZWQgPSByZXNvbHZlQnVuZGxlZENsYXVkZUNsaVBhdGgoKTtcblx0XHRhc3NlcnQub2socmVzb2x2ZWQsIFwiZXhwZWN0ZWQgc2RrIGNsaS5qcyB0byBiZSByZXNvbHZhYmxlIGluIHRlc3Qgd29ya3NwYWNlXCIpO1xuXHRcdGFzc2VydC5tYXRjaChyZXNvbHZlZCEsIC9bXFxcXC9dQGFudGhyb3BpYy1haVtcXFxcL11jbGF1ZGUtYWdlbnQtc2RrW1xcXFwvXWNsaVxcLmpzJC8pO1xuXHR9KTtcbn0pO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIGNhblVzZVRvb2wgaGFuZGxlciAoIzQzODMpXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZGVzY3JpYmUoXCJzdHJlYW0tYWRhcHRlciBcdTIwMTQgY2FuVXNlVG9vbCBoYW5kbGVyXCIsICgpID0+IHtcblx0ZnVuY3Rpb24gbWFrZU9wdGlvbnMob3ZlcnJpZGVzOiBQYXJ0aWFsPHsgc2lnbmFsOiBBYm9ydFNpZ25hbDsgc3VnZ2VzdGlvbnM6IEFycmF5PFJlY29yZDxzdHJpbmcsIHVua25vd24+PjsgdGl0bGU6IHN0cmluZzsgZGVzY3JpcHRpb246IHN0cmluZzsgdG9vbFVzZUlEOiBzdHJpbmcgfT4gPSB7fSkge1xuXHRcdHJldHVybiB7XG5cdFx0XHRzaWduYWw6IG92ZXJyaWRlcy5zaWduYWwgPz8gbmV3IEFib3J0Q29udHJvbGxlcigpLnNpZ25hbCxcblx0XHRcdHRvb2xVc2VJRDogb3ZlcnJpZGVzLnRvb2xVc2VJRCA/PyBcInRvb2x1X3Rlc3QxMjNcIixcblx0XHRcdC4uLihvdmVycmlkZXMudGl0bGUgIT09IHVuZGVmaW5lZCA/IHsgdGl0bGU6IG92ZXJyaWRlcy50aXRsZSB9IDoge30pLFxuXHRcdFx0Li4uKG92ZXJyaWRlcy5kZXNjcmlwdGlvbiAhPT0gdW5kZWZpbmVkID8geyBkZXNjcmlwdGlvbjogb3ZlcnJpZGVzLmRlc2NyaXB0aW9uIH0gOiB7fSksXG5cdFx0XHQuLi4ob3ZlcnJpZGVzLnN1Z2dlc3Rpb25zICE9PSB1bmRlZmluZWQgPyB7IHN1Z2dlc3Rpb25zOiBvdmVycmlkZXMuc3VnZ2VzdGlvbnMgfSA6IHt9KSxcblx0XHR9O1xuXHR9XG5cblx0Ly8gUG9pbnQgcHJvY2Vzcy5jd2QoKSBhdCBhbiBlbXB0eSB0ZW1wIGRpciBzbyB0aGUgcmVhbCByZXBvJ3Ncblx0Ly8gLmNsYXVkZS9zZXR0aW5ncy5sb2NhbC5qc29uICh3aGljaCBtYXkgYWxyZWFkeSBjb250YWluIHJ1bGVzIGxpa2Vcblx0Ly8gXCJCYXNoKGdoIHByIGxpc3Q6KilcIikgZG9lcyBub3Qgc2hvcnQtY2lyY3VpdCB0aGUgcGVybWlzc2lvbiBmbG93LlxuXHQvLyBSZXR1cm5zIGEgY2xlYW51cCBmdW5jdGlvbiB0aGF0IHJlc3RvcmVzIGN3ZCBhbmQgcmVtb3ZlcyB0aGUgdGVtcCBkaXIuXG5cdC8vIGJpb21lLWlnbm9yZSBsaW50L3N1c3BpY2lvdXMvbm9FeHBsaWNpdEFueTogdGVzdC1vbmx5IG1vbmtleS1wYXRjaFxuXHRmdW5jdGlvbiB3aXRoSXNvbGF0ZWRDd2QoKTogKCkgPT4gdm9pZCB7XG5cdFx0Y29uc3QgZGlyID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLWNhbnVzZXRvb2wtXCIpKSk7XG5cdFx0Y29uc3Qgb3JpZyA9IHByb2Nlc3MuY3dkO1xuXHRcdHByb2Nlc3MuY3dkID0gKCkgPT4gZGlyO1xuXHRcdHJldHVybiAoKSA9PiB7XG5cdFx0XHRwcm9jZXNzLmN3ZCA9IG9yaWc7XG5cdFx0XHRybVN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG5cdFx0fTtcblx0fVxuXG5cdHRlc3QoXCJyZXR1cm5zIHVuZGVmaW5lZCB3aGVuIG5vIFVJIGNvbnRleHQgaXMgcHJvdmlkZWRcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGhhbmRsZXIgPSBjcmVhdGVDbGF1ZGVDb2RlQ2FuVXNlVG9vbEhhbmRsZXIodW5kZWZpbmVkKTtcblx0XHRhc3NlcnQuZXF1YWwoaGFuZGxlciwgdW5kZWZpbmVkKTtcblx0fSk7XG5cblx0dGVzdChcInNob3dzIHNlbGVjdCBkaWFsb2cgd2l0aCBBbGxvdy9BbHdheXMgQWxsb3cvRGVueSBhbmQgcmV0dXJucyBhbGxvd1wiLCBhc3luYyAoKSA9PiB7XG5cdFx0bGV0IHNlbGVjdFByb21wdCA9IFwiXCI7XG5cdFx0bGV0IHNlbGVjdE9wdGlvbnM6IHN0cmluZ1tdID0gW107XG5cdFx0Y29uc3QgdWkgPSB7XG5cdFx0XHRzZWxlY3Q6IGFzeW5jIChwcm9tcHQ6IHN0cmluZywgb3B0aW9uczogc3RyaW5nW10pID0+IHtcblx0XHRcdFx0c2VsZWN0UHJvbXB0ID0gcHJvbXB0O1xuXHRcdFx0XHRzZWxlY3RPcHRpb25zID0gb3B0aW9ucztcblx0XHRcdFx0cmV0dXJuIFwiQWxsb3dcIjtcblx0XHRcdH0sXG5cdFx0fTtcblxuXHRcdGNvbnN0IGhhbmRsZXIgPSBjcmVhdGVDbGF1ZGVDb2RlQ2FuVXNlVG9vbEhhbmRsZXIodWkgYXMgYW55KTtcblx0XHRhc3NlcnQub2soaGFuZGxlcik7XG5cblx0XHRjb25zdCBpbnB1dCA9IHsgY29tbWFuZDogXCJscyAtbGFcIiB9O1xuXHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZXIhKFwiQmFzaFwiLCBpbnB1dCwgbWFrZU9wdGlvbnMoe1xuXHRcdFx0dGl0bGU6IFwiQ2xhdWRlIHdhbnRzIHRvIHJ1bjogbHMgLWxhXCIsXG5cdFx0XHRkZXNjcmlwdGlvbjogXCJMaXN0IGRpcmVjdG9yeSBjb250ZW50c1wiLFxuXHRcdH0pKTtcblxuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQuYmVoYXZpb3IsIFwiYWxsb3dcIik7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbCgocmVzdWx0IGFzIGFueSkudXBkYXRlZElucHV0LCBpbnB1dCk7XG5cdFx0YXNzZXJ0LmVxdWFsKChyZXN1bHQgYXMgYW55KS50b29sVXNlSUQsIFwidG9vbHVfdGVzdDEyM1wiKTtcblx0XHQvLyBBbGxvdyAob25lLXRpbWUpIHNob3VsZCBOT1QgaW5jbHVkZSB1cGRhdGVkUGVybWlzc2lvbnNcblx0XHRhc3NlcnQuZXF1YWwoKHJlc3VsdCBhcyBhbnkpLnVwZGF0ZWRQZXJtaXNzaW9ucywgdW5kZWZpbmVkKTtcblx0XHRhc3NlcnQuZGVlcEVxdWFsKHNlbGVjdE9wdGlvbnMsIFtcIkFsbG93XCIsIFwiQWx3YXlzIEFsbG93XCIsIFwiRGVueVwiXSk7XG5cdFx0Ly8gUHJvbXB0IGluY2x1ZGVzIHRpdGxlIGFuZCBpbnB1dCBzdW1tYXJ5XG5cdFx0YXNzZXJ0Lm9rKHNlbGVjdFByb21wdC5pbmNsdWRlcyhcIkNsYXVkZSB3YW50cyB0byBydW46IGxzIC1sYVwiKSk7XG5cdFx0YXNzZXJ0Lm9rKHNlbGVjdFByb21wdC5pbmNsdWRlcyhcImxzIC1sYVwiKSk7XG5cdH0pO1xuXG5cdHRlc3QoXCJyZXR1cm5zIGRlbnkgd2hlbiB1c2VyIHNlbGVjdHMgRGVueVwiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3QgdWkgPSB7XG5cdFx0XHRzZWxlY3Q6IGFzeW5jICgpID0+IFwiRGVueVwiLFxuXHRcdH07XG5cblx0XHRjb25zdCBoYW5kbGVyID0gY3JlYXRlQ2xhdWRlQ29kZUNhblVzZVRvb2xIYW5kbGVyKHVpIGFzIGFueSk7XG5cdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlciEoXCJCYXNoXCIsIHsgY29tbWFuZDogXCJybSAtcmYgL1wiIH0sIG1ha2VPcHRpb25zKCkpO1xuXG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5iZWhhdmlvciwgXCJkZW55XCIpO1xuXHRcdGFzc2VydC5lcXVhbCgocmVzdWx0IGFzIGFueSkubWVzc2FnZSwgXCJVc2VyIGRlbmllZFwiKTtcblx0XHRhc3NlcnQuZXF1YWwoKHJlc3VsdCBhcyBhbnkpLnRvb2xVc2VJRCwgXCJ0b29sdV90ZXN0MTIzXCIpO1xuXHR9KTtcblxuXHR0ZXN0KFwicmV0dXJucyBkZW55IHdoZW4gdXNlciBkaXNtaXNzZXMgZGlhbG9nICh1bmRlZmluZWQpXCIsIGFzeW5jICgpID0+IHtcblx0XHRjb25zdCB1aSA9IHtcblx0XHRcdHNlbGVjdDogYXN5bmMgKCkgPT4gdW5kZWZpbmVkLFxuXHRcdH07XG5cblx0XHRjb25zdCBoYW5kbGVyID0gY3JlYXRlQ2xhdWRlQ29kZUNhblVzZVRvb2xIYW5kbGVyKHVpIGFzIGFueSk7XG5cdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlciEoXCJCYXNoXCIsIHsgY29tbWFuZDogXCJlY2hvIGhpXCIgfSwgbWFrZU9wdGlvbnMoKSk7XG5cblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0LmJlaGF2aW9yLCBcImRlbnlcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKChyZXN1bHQgYXMgYW55KS5tZXNzYWdlLCBcIlVzZXIgZGVuaWVkXCIpO1xuXHR9KTtcblxuXHR0ZXN0KFwiQWx3YXlzIEFsbG93IGZvciBCYXNoIHBhdGNoZXMgU0RLIHN1Z2dlc3Rpb25zIHdpdGggc21hcnQgcnVsZUNvbnRlbnRcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IG5vdGlmaWVkOiBzdHJpbmdbXSA9IFtdO1xuXHRcdGNvbnN0IHVpID0geyBzZWxlY3Q6IGFzeW5jIChfcDogc3RyaW5nLCBvcHRzOiBzdHJpbmdbXSkgPT4gb3B0cy5maW5kKChvKSA9PiBvLnN0YXJ0c1dpdGgoXCJBbHdheXMgQWxsb3dcIikpISwgbm90aWZ5OiAobXNnOiBzdHJpbmcpID0+IG5vdGlmaWVkLnB1c2gobXNnKSB9O1xuXHRcdGNvbnN0IHN1Z2dlc3Rpb25zID0gW3tcblx0XHRcdHR5cGU6IFwiYWRkUnVsZXNcIixcblx0XHRcdHJ1bGVzOiBbeyB0b29sTmFtZTogXCJCYXNoXCIsIHJ1bGVDb250ZW50OiBcImxzIC1sYSAvdG1wXCIgfV0sXG5cdFx0XHRiZWhhdmlvcjogXCJhbGxvd1wiLFxuXHRcdFx0ZGVzdGluYXRpb246IFwibG9jYWxTZXR0aW5nc1wiLFxuXHRcdH1dO1xuXG5cdFx0Y29uc3QgaGFuZGxlciA9IGNyZWF0ZUNsYXVkZUNvZGVDYW5Vc2VUb29sSGFuZGxlcih1aSBhcyBhbnkpO1xuXHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZXIhKFwiQmFzaFwiLCB7IGNvbW1hbmQ6IFwibHMgLWxhIC90bXBcIiB9LCBtYWtlT3B0aW9ucyh7IHN1Z2dlc3Rpb25zIH0pKTtcblxuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQuYmVoYXZpb3IsIFwiYWxsb3dcIik7XG5cdFx0Ly8gU2hvdWxkIHBhdGNoIHJ1bGVDb250ZW50IHdpdGggb3VyIHNtYXJ0IHBhdHRlcm4sIHByZXNlcnZpbmcgU0RLIHN0cnVjdHVyZVxuXHRcdGFzc2VydC5kZWVwRXF1YWwoKHJlc3VsdCBhcyBhbnkpLnVwZGF0ZWRQZXJtaXNzaW9ucywgW3tcblx0XHRcdHR5cGU6IFwiYWRkUnVsZXNcIixcblx0XHRcdHJ1bGVzOiBbeyB0b29sTmFtZTogXCJCYXNoXCIsIHJ1bGVDb250ZW50OiBcImxzOipcIiB9XSxcblx0XHRcdGJlaGF2aW9yOiBcImFsbG93XCIsXG5cdFx0XHRkZXN0aW5hdGlvbjogXCJsb2NhbFNldHRpbmdzXCIsXG5cdFx0fV0pO1xuXHRcdGFzc2VydC5lcXVhbChub3RpZmllZC5sZW5ndGgsIDEpO1xuXHRcdGFzc2VydC5vayhub3RpZmllZFswXS5pbmNsdWRlcyhcIlNhdmVkOlwiKSAmJiBub3RpZmllZFswXS5pbmNsdWRlcyhcIkJhc2gobHM6KilcIikpO1xuXHR9KTtcblxuXHR0ZXN0KFwiQWx3YXlzIEFsbG93IGZvciBCYXNoIHdpdGggc3ViY29tbWFuZC1zZW5zaXRpdmUgQ0xJIGNhcHR1cmVzIHZlcmJcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IGNsZWFudXAgPSB3aXRoSXNvbGF0ZWRDd2QoKTtcblx0XHR0cnkge1xuXHRcdFx0Y29uc3Qgbm90aWZpZWQ6IHN0cmluZ1tdID0gW107XG5cdFx0XHQvLyBGaXJzdCBzZWxlY3QgY2FsbDogcGljayBcIkFsd2F5cyBBbGxvdyAuLi5cIjsgc2Vjb25kIGNhbGwgKGxldmVsXG5cdFx0XHQvLyBwaWNrZXIpOiBwaWNrIHRoZSBcImdpdCBwdXNoXCIgZ3JhbnVsYXJpdHkgZXhwbGljaXRseS5cblx0XHRcdGxldCBzZWxlY3RDYWxsID0gMDtcblx0XHRcdGNvbnN0IHVpID0ge1xuXHRcdFx0XHRzZWxlY3Q6IGFzeW5jIChfcDogc3RyaW5nLCBvcHRzOiBzdHJpbmdbXSkgPT4ge1xuXHRcdFx0XHRcdHNlbGVjdENhbGwrKztcblx0XHRcdFx0XHRpZiAoc2VsZWN0Q2FsbCA9PT0gMSkgcmV0dXJuIG9wdHMuZmluZCgobykgPT4gby5zdGFydHNXaXRoKFwiQWx3YXlzIEFsbG93XCIpKSE7XG5cdFx0XHRcdFx0cmV0dXJuIFwiQmFzaChnaXQgcHVzaDoqKVwiO1xuXHRcdFx0XHR9LFxuXHRcdFx0XHRub3RpZnk6IChtc2c6IHN0cmluZykgPT4gbm90aWZpZWQucHVzaChtc2cpLFxuXHRcdFx0fTtcblx0XHRcdGNvbnN0IHN1Z2dlc3Rpb25zID0gW3tcblx0XHRcdFx0dHlwZTogXCJhZGRSdWxlc1wiLFxuXHRcdFx0XHRydWxlczogW3sgdG9vbE5hbWU6IFwiQmFzaFwiLCBydWxlQ29udGVudDogXCJnaXQgcHVzaCBvcmlnaW4gbWFpblwiIH1dLFxuXHRcdFx0XHRiZWhhdmlvcjogXCJhbGxvd1wiLFxuXHRcdFx0XHRkZXN0aW5hdGlvbjogXCJsb2NhbFNldHRpbmdzXCIsXG5cdFx0XHR9XTtcblxuXHRcdFx0Y29uc3QgaGFuZGxlciA9IGNyZWF0ZUNsYXVkZUNvZGVDYW5Vc2VUb29sSGFuZGxlcih1aSBhcyBhbnkpO1xuXHRcdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlciEoXCJCYXNoXCIsIHsgY29tbWFuZDogXCJnaXQgcHVzaCBvcmlnaW4gbWFpblwiIH0sIG1ha2VPcHRpb25zKHsgc3VnZ2VzdGlvbnMgfSkpO1xuXG5cdFx0XHRhc3NlcnQuZXF1YWwocmVzdWx0LmJlaGF2aW9yLCBcImFsbG93XCIpO1xuXHRcdFx0YXNzZXJ0LmRlZXBFcXVhbCgocmVzdWx0IGFzIGFueSkudXBkYXRlZFBlcm1pc3Npb25zLCBbe1xuXHRcdFx0XHR0eXBlOiBcImFkZFJ1bGVzXCIsXG5cdFx0XHRcdHJ1bGVzOiBbeyB0b29sTmFtZTogXCJCYXNoXCIsIHJ1bGVDb250ZW50OiBcImdpdCBwdXNoOipcIiB9XSxcblx0XHRcdFx0YmVoYXZpb3I6IFwiYWxsb3dcIixcblx0XHRcdFx0ZGVzdGluYXRpb246IFwibG9jYWxTZXR0aW5nc1wiLFxuXHRcdFx0fV0pO1xuXHRcdFx0YXNzZXJ0Lm9rKG5vdGlmaWVkWzBdLmluY2x1ZGVzKFwiU2F2ZWQ6XCIpICYmIG5vdGlmaWVkWzBdLmluY2x1ZGVzKFwiQmFzaChnaXQgcHVzaDoqKVwiKSk7XG5cdFx0fSBmaW5hbGx5IHtcblx0XHRcdGNsZWFudXAoKTtcblx0XHR9XG5cdH0pO1xuXG5cdHRlc3QoXCJBbHdheXMgQWxsb3cgZm9yIEJhc2ggd2l0aG91dCBzdWdnZXN0aW9ucyBidWlsZHMgcHJvcGVyIFBlcm1pc3Npb25VcGRhdGVcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IGNsZWFudXAgPSB3aXRoSXNvbGF0ZWRDd2QoKTtcblx0XHR0cnkge1xuXHRcdFx0Y29uc3Qgbm90aWZpZWQ6IHN0cmluZ1tdID0gW107XG5cdFx0XHRsZXQgc2VsZWN0Q2FsbCA9IDA7XG5cdFx0XHRjb25zdCB1aSA9IHtcblx0XHRcdFx0c2VsZWN0OiBhc3luYyAoX3A6IHN0cmluZywgb3B0czogc3RyaW5nW10pID0+IHtcblx0XHRcdFx0XHRzZWxlY3RDYWxsKys7XG5cdFx0XHRcdFx0aWYgKHNlbGVjdENhbGwgPT09IDEpIHJldHVybiBvcHRzLmZpbmQoKG8pID0+IG8uc3RhcnRzV2l0aChcIkFsd2F5cyBBbGxvd1wiKSkhO1xuXHRcdFx0XHRcdHJldHVybiBcIkJhc2goZ2ggcHIgbGlzdDoqKVwiO1xuXHRcdFx0XHR9LFxuXHRcdFx0XHRub3RpZnk6IChtc2c6IHN0cmluZykgPT4gbm90aWZpZWQucHVzaChtc2cpLFxuXHRcdFx0fTtcblxuXHRcdFx0Y29uc3QgaGFuZGxlciA9IGNyZWF0ZUNsYXVkZUNvZGVDYW5Vc2VUb29sSGFuZGxlcih1aSBhcyBhbnkpO1xuXHRcdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlciEoXCJCYXNoXCIsIHsgY29tbWFuZDogXCJnaCBwciBsaXN0XCIgfSwgbWFrZU9wdGlvbnMoKSk7XG5cblx0XHRcdGFzc2VydC5lcXVhbChyZXN1bHQuYmVoYXZpb3IsIFwiYWxsb3dcIik7XG5cdFx0XHQvLyBObyBTREsgc3VnZ2VzdGlvbnMgXHUyMTkyIGJ1aWxkcyBQZXJtaXNzaW9uVXBkYXRlIGZyb20gc2NyYXRjaFxuXHRcdFx0YXNzZXJ0LmRlZXBFcXVhbCgocmVzdWx0IGFzIGFueSkudXBkYXRlZFBlcm1pc3Npb25zLCBbe1xuXHRcdFx0XHR0eXBlOiBcImFkZFJ1bGVzXCIsXG5cdFx0XHRcdHJ1bGVzOiBbeyB0b29sTmFtZTogXCJCYXNoXCIsIHJ1bGVDb250ZW50OiBcImdoIHByIGxpc3Q6KlwiIH1dLFxuXHRcdFx0XHRiZWhhdmlvcjogXCJhbGxvd1wiLFxuXHRcdFx0XHRkZXN0aW5hdGlvbjogXCJsb2NhbFNldHRpbmdzXCIsXG5cdFx0XHR9XSk7XG5cdFx0XHRhc3NlcnQub2sobm90aWZpZWRbMF0uaW5jbHVkZXMoXCJTYXZlZDpcIikgJiYgbm90aWZpZWRbMF0uaW5jbHVkZXMoXCJCYXNoKGdoIHByIGxpc3Q6KilcIikpO1xuXHRcdH0gZmluYWxseSB7XG5cdFx0XHRjbGVhbnVwKCk7XG5cdFx0fVxuXHR9KTtcblxuXHR0ZXN0KFwiQWx3YXlzIEFsbG93IGZvciBub24tQmFzaCB0b29scyBwYXNzZXMgU0RLIHN1Z2dlc3Rpb25zIHRocm91Z2hcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IG5vdGlmaWVkOiBzdHJpbmdbXSA9IFtdO1xuXHRcdGNvbnN0IHVpID0geyBzZWxlY3Q6IGFzeW5jIChfcDogc3RyaW5nLCBvcHRzOiBzdHJpbmdbXSkgPT4gb3B0cy5maW5kKChvKSA9PiBvLnN0YXJ0c1dpdGgoXCJBbHdheXMgQWxsb3dcIikpISwgbm90aWZ5OiAobXNnOiBzdHJpbmcpID0+IG5vdGlmaWVkLnB1c2gobXNnKSB9O1xuXHRcdGNvbnN0IHN1Z2dlc3Rpb25zID0gW3tcblx0XHRcdHR5cGU6IFwiYWRkUnVsZXNcIixcblx0XHRcdHJ1bGVzOiBbeyB0b29sTmFtZTogXCJXcml0ZVwiIH1dLFxuXHRcdFx0YmVoYXZpb3I6IFwiYWxsb3dcIixcblx0XHRcdGRlc3RpbmF0aW9uOiBcImxvY2FsU2V0dGluZ3NcIixcblx0XHR9XTtcblxuXHRcdGNvbnN0IGhhbmRsZXIgPSBjcmVhdGVDbGF1ZGVDb2RlQ2FuVXNlVG9vbEhhbmRsZXIodWkgYXMgYW55KTtcblx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVyIShcIldyaXRlXCIsIHsgZmlsZV9wYXRoOiBcIi90bXAvdGVzdC50eHRcIiB9LCBtYWtlT3B0aW9ucyh7IHN1Z2dlc3Rpb25zIH0pKTtcblxuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQuYmVoYXZpb3IsIFwiYWxsb3dcIik7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbCgocmVzdWx0IGFzIGFueSkudXBkYXRlZFBlcm1pc3Npb25zLCBzdWdnZXN0aW9ucyk7XG5cdFx0Ly8gTm9uLUJhc2ggdG9vbHMgZG9uJ3QgZW1pdCBhIHBvc3Qtc2VsZWN0aW9uIG5vdGlmaWNhdGlvbiAob25seSBCYXNoIHJ1bnMgdGhlIGxldmVsIHBpY2tlcilcblx0XHRhc3NlcnQuZXF1YWwobm90aWZpZWQubGVuZ3RoLCAwKTtcblx0fSk7XG5cblx0dGVzdChcIkFsd2F5cyBBbGxvdyBmb3Igbm9uLUJhc2ggd2l0aG91dCBzdWdnZXN0aW9ucyBidWlsZHMgdG9vbC1uYW1lLW9ubHkgZmFsbGJhY2sgcnVsZVwiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3Qgbm90aWZpZWQ6IHN0cmluZ1tdID0gW107XG5cdFx0Y29uc3QgdWkgPSB7IHNlbGVjdDogYXN5bmMgKF9wOiBzdHJpbmcsIG9wdHM6IHN0cmluZ1tdKSA9PiBvcHRzLmZpbmQoKG8pID0+IG8uc3RhcnRzV2l0aChcIkFsd2F5cyBBbGxvd1wiKSkhLCBub3RpZnk6IChtc2c6IHN0cmluZykgPT4gbm90aWZpZWQucHVzaChtc2cpIH07XG5cblx0XHRjb25zdCBoYW5kbGVyID0gY3JlYXRlQ2xhdWRlQ29kZUNhblVzZVRvb2xIYW5kbGVyKHVpIGFzIGFueSk7XG5cdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlciEoXCJBc2tVc2VyUXVlc3Rpb25cIiwgeyBxdWVzdGlvbnM6IFt7IHF1ZXN0aW9uOiBcIj9cIiwgaGVhZGVyOiBcImhcIiwgbXVsdGlTZWxlY3Q6IGZhbHNlLCBvcHRpb25zOiBbXSB9XSB9LCBtYWtlT3B0aW9ucygpKTtcblxuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQuYmVoYXZpb3IsIFwiYWxsb3dcIik7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbCgocmVzdWx0IGFzIGFueSkudXBkYXRlZFBlcm1pc3Npb25zLCBbe1xuXHRcdFx0dHlwZTogXCJhZGRSdWxlc1wiLFxuXHRcdFx0cnVsZXM6IFt7IHRvb2xOYW1lOiBcIkFza1VzZXJRdWVzdGlvblwiIH1dLFxuXHRcdFx0YmVoYXZpb3I6IFwiYWxsb3dcIixcblx0XHRcdGRlc3RpbmF0aW9uOiBcImxvY2FsU2V0dGluZ3NcIixcblx0XHR9XSk7XG5cdFx0YXNzZXJ0LmVxdWFsKG5vdGlmaWVkLmxlbmd0aCwgMSk7XG5cdFx0YXNzZXJ0Lm1hdGNoKG5vdGlmaWVkWzBdLCAvQXNrVXNlclF1ZXN0aW9uLyk7XG5cdH0pO1xuXG5cdHRlc3QoXCJBbHdheXMgQWxsb3cgZm9yIG5vbi1CYXNoIHdpdGggZW1wdHkgc3VnZ2VzdGlvbnMgYXJyYXkgYnVpbGRzIHRvb2wtbmFtZS1vbmx5IGZhbGxiYWNrIHJ1bGVcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IG5vdGlmaWVkOiBzdHJpbmdbXSA9IFtdO1xuXHRcdGNvbnN0IHVpID0geyBzZWxlY3Q6IGFzeW5jIChfcDogc3RyaW5nLCBvcHRzOiBzdHJpbmdbXSkgPT4gb3B0cy5maW5kKChvKSA9PiBvLnN0YXJ0c1dpdGgoXCJBbHdheXMgQWxsb3dcIikpISwgbm90aWZ5OiAobXNnOiBzdHJpbmcpID0+IG5vdGlmaWVkLnB1c2gobXNnKSB9O1xuXG5cdFx0Y29uc3QgaGFuZGxlciA9IGNyZWF0ZUNsYXVkZUNvZGVDYW5Vc2VUb29sSGFuZGxlcih1aSBhcyBhbnkpO1xuXHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZXIhKFwiQXNrVXNlclF1ZXN0aW9uXCIsIHsgcXVlc3Rpb25zOiBbeyBxdWVzdGlvbjogXCI/XCIsIGhlYWRlcjogXCJoXCIsIG11bHRpU2VsZWN0OiBmYWxzZSwgb3B0aW9uczogW10gfV0gfSwgbWFrZU9wdGlvbnMoeyBzdWdnZXN0aW9uczogW10gfSkpO1xuXG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5iZWhhdmlvciwgXCJhbGxvd1wiKTtcblx0XHRhc3NlcnQuZGVlcEVxdWFsKChyZXN1bHQgYXMgYW55KS51cGRhdGVkUGVybWlzc2lvbnMsIFt7XG5cdFx0XHR0eXBlOiBcImFkZFJ1bGVzXCIsXG5cdFx0XHRydWxlczogW3sgdG9vbE5hbWU6IFwiQXNrVXNlclF1ZXN0aW9uXCIgfV0sXG5cdFx0XHRiZWhhdmlvcjogXCJhbGxvd1wiLFxuXHRcdFx0ZGVzdGluYXRpb246IFwibG9jYWxTZXR0aW5nc1wiLFxuXHRcdH1dKTtcblx0XHRhc3NlcnQuZXF1YWwobm90aWZpZWQubGVuZ3RoLCAxKTtcblx0XHRhc3NlcnQubWF0Y2gobm90aWZpZWRbMF0sIC9Bc2tVc2VyUXVlc3Rpb24vKTtcblx0fSk7XG5cblx0dGVzdChcInByb21wdCBpbmNsdWRlcyBjb21tYW5kIHRleHQgZm9yIEJhc2ggdG9vbHNcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGxldCBzZWxlY3RQcm9tcHQgPSBcIlwiO1xuXHRcdGNvbnN0IHVpID0ge1xuXHRcdFx0c2VsZWN0OiBhc3luYyAocHJvbXB0OiBzdHJpbmcpID0+IHtcblx0XHRcdFx0c2VsZWN0UHJvbXB0ID0gcHJvbXB0O1xuXHRcdFx0XHRyZXR1cm4gXCJBbGxvd1wiO1xuXHRcdFx0fSxcblx0XHR9O1xuXG5cdFx0Y29uc3QgaGFuZGxlciA9IGNyZWF0ZUNsYXVkZUNvZGVDYW5Vc2VUb29sSGFuZGxlcih1aSBhcyBhbnkpO1xuXHRcdGF3YWl0IGhhbmRsZXIhKFwiQmFzaFwiLCB7IGNvbW1hbmQ6IFwiZ2l0IHN0YXR1c1wiIH0sIG1ha2VPcHRpb25zKCkpO1xuXHRcdGFzc2VydC5vayhzZWxlY3RQcm9tcHQuaW5jbHVkZXMoXCJnaXQgc3RhdHVzXCIpLCBgcHJvbXB0IHNob3VsZCBpbmNsdWRlIGNvbW1hbmQ6ICR7c2VsZWN0UHJvbXB0fWApO1xuXHR9KTtcblxuXHR0ZXN0KFwicHJvbXB0IGluY2x1ZGVzIGZpbGVfcGF0aCBmb3IgZmlsZSB0b29sc1wiLCBhc3luYyAoKSA9PiB7XG5cdFx0bGV0IHNlbGVjdFByb21wdCA9IFwiXCI7XG5cdFx0Y29uc3QgdWkgPSB7XG5cdFx0XHRzZWxlY3Q6IGFzeW5jIChwcm9tcHQ6IHN0cmluZykgPT4ge1xuXHRcdFx0XHRzZWxlY3RQcm9tcHQgPSBwcm9tcHQ7XG5cdFx0XHRcdHJldHVybiBcIkFsbG93XCI7XG5cdFx0XHR9LFxuXHRcdH07XG5cblx0XHRjb25zdCBoYW5kbGVyID0gY3JlYXRlQ2xhdWRlQ29kZUNhblVzZVRvb2xIYW5kbGVyKHVpIGFzIGFueSk7XG5cdFx0YXdhaXQgaGFuZGxlciEoXCJXcml0ZVwiLCB7IGZpbGVfcGF0aDogXCIvdG1wL3Rlc3QudHh0XCIsIGNvbnRlbnQ6IFwiaGVsbG9cIiB9LCBtYWtlT3B0aW9ucygpKTtcblx0XHRhc3NlcnQub2soc2VsZWN0UHJvbXB0LmluY2x1ZGVzKFwiL3RtcC90ZXN0LnR4dFwiKSwgYHByb21wdCBzaG91bGQgaW5jbHVkZSBmaWxlIHBhdGg6ICR7c2VsZWN0UHJvbXB0fWApO1xuXHR9KTtcblxuXHR0ZXN0KFwidXNlcyB0aXRsZSBmcm9tIG9wdGlvbnMgd2hlbiBhdmFpbGFibGVcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGxldCBzZWxlY3RQcm9tcHQgPSBcIlwiO1xuXHRcdGNvbnN0IHVpID0ge1xuXHRcdFx0c2VsZWN0OiBhc3luYyAocHJvbXB0OiBzdHJpbmcpID0+IHtcblx0XHRcdFx0c2VsZWN0UHJvbXB0ID0gcHJvbXB0O1xuXHRcdFx0XHRyZXR1cm4gXCJBbGxvd1wiO1xuXHRcdFx0fSxcblx0XHR9O1xuXG5cdFx0Y29uc3QgaGFuZGxlciA9IGNyZWF0ZUNsYXVkZUNvZGVDYW5Vc2VUb29sSGFuZGxlcih1aSBhcyBhbnkpO1xuXHRcdGF3YWl0IGhhbmRsZXIhKFwiV2ViRmV0Y2hcIiwge30sIG1ha2VPcHRpb25zKHsgdGl0bGU6IFwiQ2xhdWRlIHdhbnRzIHRvIGZldGNoOiBodHRwczovL2V4YW1wbGUuY29tXCIgfSkpO1xuXHRcdGFzc2VydC5vayhzZWxlY3RQcm9tcHQuaW5jbHVkZXMoXCJDbGF1ZGUgd2FudHMgdG8gZmV0Y2g6IGh0dHBzOi8vZXhhbXBsZS5jb21cIikpO1xuXHR9KTtcblxuXHR0ZXN0KFwiZmFsbHMgYmFjayB0byBkZWZhdWx0IHRpdGxlIHdoZW4gb3B0aW9ucy50aXRsZSBpcyBtaXNzaW5nXCIsIGFzeW5jICgpID0+IHtcblx0XHRsZXQgc2VsZWN0UHJvbXB0ID0gXCJcIjtcblx0XHRjb25zdCB1aSA9IHtcblx0XHRcdHNlbGVjdDogYXN5bmMgKHByb21wdDogc3RyaW5nKSA9PiB7XG5cdFx0XHRcdHNlbGVjdFByb21wdCA9IHByb21wdDtcblx0XHRcdFx0cmV0dXJuIFwiQWxsb3dcIjtcblx0XHRcdH0sXG5cdFx0fTtcblxuXHRcdGNvbnN0IGhhbmRsZXIgPSBjcmVhdGVDbGF1ZGVDb2RlQ2FuVXNlVG9vbEhhbmRsZXIodWkgYXMgYW55KTtcblx0XHRhd2FpdCBoYW5kbGVyIShcIldlYkZldGNoXCIsIHsgdXJsOiBcImh0dHBzOi8vZXhhbXBsZS5jb21cIiB9LCBtYWtlT3B0aW9ucygpKTtcblx0XHRhc3NlcnQub2soc2VsZWN0UHJvbXB0LmluY2x1ZGVzKFwiQWxsb3cgQ2xhdWRlIENvZGUgdG8gdXNlOiBXZWJGZXRjaD9cIikpO1xuXHR9KTtcblxuXHR0ZXN0KFwicmV0dXJucyBkZW55IHdoZW4gc2lnbmFsIGlzIGFscmVhZHkgYWJvcnRlZFwiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3QgdWkgPSB7XG5cdFx0XHRzZWxlY3Q6IGFzeW5jICgpID0+IHsgdGhyb3cgbmV3IEVycm9yKFwic2hvdWxkIG5vdCBiZSBjYWxsZWRcIik7IH0sXG5cdFx0fTtcblxuXHRcdGNvbnN0IGNvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG5cdFx0Y29udHJvbGxlci5hYm9ydCgpO1xuXG5cdFx0Y29uc3QgaGFuZGxlciA9IGNyZWF0ZUNsYXVkZUNvZGVDYW5Vc2VUb29sSGFuZGxlcih1aSBhcyBhbnkpO1xuXHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZXIhKFwiQmFzaFwiLCB7fSwgbWFrZU9wdGlvbnMoeyBzaWduYWw6IGNvbnRyb2xsZXIuc2lnbmFsIH0pKTtcblxuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQuYmVoYXZpb3IsIFwiZGVueVwiKTtcblx0XHRhc3NlcnQuZXF1YWwoKHJlc3VsdCBhcyBhbnkpLm1lc3NhZ2UsIFwiQWJvcnRlZFwiKTtcblx0fSk7XG5cblx0dGVzdChcInJldHVybnMgZGVueSB3aGVuIHVpLnNlbGVjdCB0aHJvd3NcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IHVpID0ge1xuXHRcdFx0c2VsZWN0OiBhc3luYyAoKSA9PiB7IHRocm93IG5ldyBFcnJvcihcImRpYWxvZyBjcmFzaGVkXCIpOyB9LFxuXHRcdH07XG5cblx0XHRjb25zdCBoYW5kbGVyID0gY3JlYXRlQ2xhdWRlQ29kZUNhblVzZVRvb2xIYW5kbGVyKHVpIGFzIGFueSk7XG5cdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlciEoXCJCYXNoXCIsIHt9LCBtYWtlT3B0aW9ucygpKTtcblxuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQuYmVoYXZpb3IsIFwiZGVueVwiKTtcblx0XHRhc3NlcnQuZXF1YWwoKHJlc3VsdCBhcyBhbnkpLm1lc3NhZ2UsIFwiQWJvcnRlZFwiKTtcblx0fSk7XG5cblx0dGVzdChcImJ1aWxkU2RrT3B0aW9ucyBwYXNzZXMgY2FuVXNlVG9vbCB0aHJvdWdoIGV4dHJhT3B0aW9uc1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgY2FuVXNlVG9vbCA9IGFzeW5jICgpID0+ICh7IGJlaGF2aW9yOiBcImFsbG93XCIgYXMgY29uc3QsIHVwZGF0ZWRJbnB1dDoge30sIHRvb2xVc2VJRDogXCJ0ZXN0XCIgfSk7XG5cdFx0Y29uc3Qgb3B0cyA9IGJ1aWxkU2RrT3B0aW9ucyhcImNsYXVkZS1zb25uZXQtNC02XCIsIFwidGVzdFwiLCB1bmRlZmluZWQsIHsgY2FuVXNlVG9vbCB9KTtcblx0XHRhc3NlcnQuZXF1YWwob3B0cy5jYW5Vc2VUb29sLCBjYW5Vc2VUb29sKTtcblx0fSk7XG5cblx0dGVzdChcIkFsd2F5cyBBbGxvdyBzaG93cyBsZXZlbCBwaWNrZXIgYW5kIHVzZXIgYnJvYWRlbnMgdG8gYmFzZSBjb21tYW5kXCIsIGFzeW5jICgpID0+IHtcblx0XHRjb25zdCBjbGVhbnVwID0gd2l0aElzb2xhdGVkQ3dkKCk7XG5cdFx0dHJ5IHtcblx0XHRcdGNvbnN0IHByb21wdHM6IHN0cmluZ1tdID0gW107XG5cdFx0XHRjb25zdCBsZXZlbE9wdHM6IHN0cmluZ1tdW10gPSBbXTtcblx0XHRcdGxldCBzZWxlY3RDYWxsID0gMDtcblx0XHRcdGNvbnN0IHVpID0ge1xuXHRcdFx0XHRzZWxlY3Q6IGFzeW5jIChwcm9tcHQ6IHN0cmluZywgb3B0czogc3RyaW5nW10pID0+IHtcblx0XHRcdFx0XHRwcm9tcHRzLnB1c2gocHJvbXB0KTtcblx0XHRcdFx0XHRzZWxlY3RDYWxsKys7XG5cdFx0XHRcdFx0aWYgKHNlbGVjdENhbGwgPT09IDEpIHJldHVybiBvcHRzLmZpbmQoKG8pID0+IG8uc3RhcnRzV2l0aChcIkFsd2F5cyBBbGxvd1wiKSkhO1xuXHRcdFx0XHRcdGxldmVsT3B0cy5wdXNoKG9wdHMpO1xuXHRcdFx0XHRcdHJldHVybiBcIkJhc2goZ2g6KilcIjtcblx0XHRcdFx0fSxcblx0XHRcdFx0bm90aWZ5OiAoKSA9PiB7fSxcblx0XHRcdH07XG5cblx0XHRcdGNvbnN0IGhhbmRsZXIgPSBjcmVhdGVDbGF1ZGVDb2RlQ2FuVXNlVG9vbEhhbmRsZXIodWkgYXMgYW55KTtcblx0XHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZXIhKFwiQmFzaFwiLCB7IGNvbW1hbmQ6IFwiZ2ggcHIgbGlzdFwiIH0sIG1ha2VPcHRpb25zKCkpO1xuXG5cdFx0XHRhc3NlcnQuZXF1YWwocmVzdWx0LmJlaGF2aW9yLCBcImFsbG93XCIpO1xuXHRcdFx0YXNzZXJ0LmRlZXBFcXVhbCgocmVzdWx0IGFzIGFueSkudXBkYXRlZFBlcm1pc3Npb25zLCBbe1xuXHRcdFx0XHR0eXBlOiBcImFkZFJ1bGVzXCIsXG5cdFx0XHRcdHJ1bGVzOiBbeyB0b29sTmFtZTogXCJCYXNoXCIsIHJ1bGVDb250ZW50OiBcImdoOipcIiB9XSxcblx0XHRcdFx0YmVoYXZpb3I6IFwiYWxsb3dcIixcblx0XHRcdFx0ZGVzdGluYXRpb246IFwibG9jYWxTZXR0aW5nc1wiLFxuXHRcdFx0fV0pO1xuXHRcdFx0Ly8gU2Vjb25kIGRpYWxvZyBvZmZlcmVkIGV2ZXJ5IGdyYW51bGFyaXR5IGxldmVsXG5cdFx0XHRhc3NlcnQuZGVlcEVxdWFsKGxldmVsT3B0c1swXSwgW1xuXHRcdFx0XHRcIkJhc2goZ2g6KilcIixcblx0XHRcdFx0XCJCYXNoKGdoIHByOiopXCIsXG5cdFx0XHRcdFwiQmFzaChnaCBwciBsaXN0OiopXCIsXG5cdFx0XHRdKTtcblx0XHRcdGFzc2VydC5vayhwcm9tcHRzWzFdLmluY2x1ZGVzKFwiU2F2ZSBwZXJtaXNzaW9uIGF0IHdoaWNoIGxldmVsP1wiKSk7XG5cdFx0fSBmaW5hbGx5IHtcblx0XHRcdGNsZWFudXAoKTtcblx0XHR9XG5cdH0pO1xuXG5cdHRlc3QoXCJBbHdheXMgQWxsb3cgbmFycm93cyB0byBtaWQtbGV2ZWwgcGF0dGVybiB3aGVuIHVzZXIgcGlja3MgQmFzaChnaCBwcjoqKVwiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3QgY2xlYW51cCA9IHdpdGhJc29sYXRlZEN3ZCgpO1xuXHRcdHRyeSB7XG5cdFx0XHRsZXQgc2VsZWN0Q2FsbCA9IDA7XG5cdFx0XHRjb25zdCB1aSA9IHtcblx0XHRcdFx0c2VsZWN0OiBhc3luYyAoX3A6IHN0cmluZywgb3B0czogc3RyaW5nW10pID0+IHtcblx0XHRcdFx0XHRzZWxlY3RDYWxsKys7XG5cdFx0XHRcdFx0aWYgKHNlbGVjdENhbGwgPT09IDEpIHJldHVybiBvcHRzLmZpbmQoKG8pID0+IG8uc3RhcnRzV2l0aChcIkFsd2F5cyBBbGxvd1wiKSkhO1xuXHRcdFx0XHRcdHJldHVybiBcIkJhc2goZ2ggcHI6KilcIjtcblx0XHRcdFx0fSxcblx0XHRcdFx0bm90aWZ5OiAoKSA9PiB7fSxcblx0XHRcdH07XG5cblx0XHRcdGNvbnN0IGhhbmRsZXIgPSBjcmVhdGVDbGF1ZGVDb2RlQ2FuVXNlVG9vbEhhbmRsZXIodWkgYXMgYW55KTtcblx0XHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZXIhKFwiQmFzaFwiLCB7IGNvbW1hbmQ6IFwiZ2ggcHIgbGlzdCAtLWxpbWl0IDVcIiB9LCBtYWtlT3B0aW9ucygpKTtcblxuXHRcdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5iZWhhdmlvciwgXCJhbGxvd1wiKTtcblx0XHRcdGFzc2VydC5kZWVwRXF1YWwoKHJlc3VsdCBhcyBhbnkpLnVwZGF0ZWRQZXJtaXNzaW9ucywgW3tcblx0XHRcdFx0dHlwZTogXCJhZGRSdWxlc1wiLFxuXHRcdFx0XHRydWxlczogW3sgdG9vbE5hbWU6IFwiQmFzaFwiLCBydWxlQ29udGVudDogXCJnaCBwcjoqXCIgfV0sXG5cdFx0XHRcdGJlaGF2aW9yOiBcImFsbG93XCIsXG5cdFx0XHRcdGRlc3RpbmF0aW9uOiBcImxvY2FsU2V0dGluZ3NcIixcblx0XHRcdH1dKTtcblx0XHR9IGZpbmFsbHkge1xuXHRcdFx0Y2xlYW51cCgpO1xuXHRcdH1cblx0fSk7XG5cblx0dGVzdChcIkFsd2F5cyBBbGxvdyBza2lwcyBsZXZlbCBwaWNrZXIgd2hlbiBvbmx5IG9uZSBwYXR0ZXJuIGlzIGF2YWlsYWJsZVwiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3QgY2xlYW51cCA9IHdpdGhJc29sYXRlZEN3ZCgpO1xuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBwcm9tcHRzOiBzdHJpbmdbXSA9IFtdO1xuXHRcdFx0Y29uc3QgdWkgPSB7XG5cdFx0XHRcdHNlbGVjdDogYXN5bmMgKHByb21wdDogc3RyaW5nLCBvcHRzOiBzdHJpbmdbXSkgPT4ge1xuXHRcdFx0XHRcdHByb21wdHMucHVzaChwcm9tcHQpO1xuXHRcdFx0XHRcdHJldHVybiBvcHRzLmZpbmQoKG8pID0+IG8uc3RhcnRzV2l0aChcIkFsd2F5cyBBbGxvd1wiKSkhO1xuXHRcdFx0XHR9LFxuXHRcdFx0XHRub3RpZnk6ICgpID0+IHt9LFxuXHRcdFx0fTtcblxuXHRcdFx0Y29uc3QgaGFuZGxlciA9IGNyZWF0ZUNsYXVkZUNvZGVDYW5Vc2VUb29sSGFuZGxlcih1aSBhcyBhbnkpO1xuXHRcdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlciEoXCJCYXNoXCIsIHsgY29tbWFuZDogXCJscyAtbGEgL3RtcFwiIH0sIG1ha2VPcHRpb25zKCkpO1xuXG5cdFx0XHRhc3NlcnQuZXF1YWwocmVzdWx0LmJlaGF2aW9yLCBcImFsbG93XCIpO1xuXHRcdFx0Ly8gXCJsc1wiIGhhcyBubyBzdWJjb21tYW5kIHRva2VucyBiZWZvcmUgdGhlIGZsYWcgXHUyMTkyIHNpbmdsZS1vcHRpb24gcGF0aFxuXHRcdFx0YXNzZXJ0LmVxdWFsKHByb21wdHMubGVuZ3RoLCAxLCBcInNob3VsZCBub3Qgc2hvdyBhIHNlY29uZCBkaWFsb2dcIik7XG5cdFx0XHRhc3NlcnQuZGVlcEVxdWFsKChyZXN1bHQgYXMgYW55KS51cGRhdGVkUGVybWlzc2lvbnMsIFt7XG5cdFx0XHRcdHR5cGU6IFwiYWRkUnVsZXNcIixcblx0XHRcdFx0cnVsZXM6IFt7IHRvb2xOYW1lOiBcIkJhc2hcIiwgcnVsZUNvbnRlbnQ6IFwibHM6KlwiIH1dLFxuXHRcdFx0XHRiZWhhdmlvcjogXCJhbGxvd1wiLFxuXHRcdFx0XHRkZXN0aW5hdGlvbjogXCJsb2NhbFNldHRpbmdzXCIsXG5cdFx0XHR9XSk7XG5cdFx0fSBmaW5hbGx5IHtcblx0XHRcdGNsZWFudXAoKTtcblx0XHR9XG5cdH0pO1xuXG5cdHRlc3QoXCJBbHdheXMgQWxsb3cgZGVuaWVzIHRoZSB0b29sIHdoZW4gbGV2ZWwgcGlja2VyIGlzIGRpc21pc3NlZFwiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3QgY2xlYW51cCA9IHdpdGhJc29sYXRlZEN3ZCgpO1xuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBub3RpZmllZDogc3RyaW5nW10gPSBbXTtcblx0XHRcdGxldCBzZWxlY3RDYWxsID0gMDtcblx0XHRcdGNvbnN0IHVpID0ge1xuXHRcdFx0XHRzZWxlY3Q6IGFzeW5jIChfcDogc3RyaW5nLCBvcHRzOiBzdHJpbmdbXSkgPT4ge1xuXHRcdFx0XHRcdHNlbGVjdENhbGwrKztcblx0XHRcdFx0XHRpZiAoc2VsZWN0Q2FsbCA9PT0gMSkgcmV0dXJuIG9wdHMuZmluZCgobykgPT4gby5zdGFydHNXaXRoKFwiQWx3YXlzIEFsbG93XCIpKSE7XG5cdFx0XHRcdFx0cmV0dXJuIHVuZGVmaW5lZDsgLy8gdXNlciBkaXNtaXNzZWQgbGV2ZWwgcGlja2VyXG5cdFx0XHRcdH0sXG5cdFx0XHRcdG5vdGlmeTogKG1zZzogc3RyaW5nKSA9PiBub3RpZmllZC5wdXNoKG1zZyksXG5cdFx0XHR9O1xuXG5cdFx0XHRjb25zdCBoYW5kbGVyID0gY3JlYXRlQ2xhdWRlQ29kZUNhblVzZVRvb2xIYW5kbGVyKHVpIGFzIGFueSk7XG5cdFx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVyIShcIkJhc2hcIiwgeyBjb21tYW5kOiBcImdoIHByIGxpc3RcIiB9LCBtYWtlT3B0aW9ucygpKTtcblxuXHRcdFx0Ly8gRGlzbWlzc2luZyB0aGUgbGV2ZWwgcGlja2VyIGNhbmNlbHMgdGhlIHRvb2wgdXNlIFx1MjAxNCBhIG9uZS10aW1lIGFsbG93XG5cdFx0XHQvLyB3b3VsZCBsZWF2ZSB0aGUgc3Bhd25lZCBhZ2VudCBydW5uaW5nIGV2ZW4gdGhvdWdoIHRoZSB1c2VyIGJhaWxlZC5cblx0XHRcdGFzc2VydC5lcXVhbChyZXN1bHQuYmVoYXZpb3IsIFwiZGVueVwiKTtcblx0XHRcdGFzc2VydC5lcXVhbCgocmVzdWx0IGFzIGFueSkudXBkYXRlZFBlcm1pc3Npb25zLCB1bmRlZmluZWQpO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKG5vdGlmaWVkLmxlbmd0aCwgMCwgXCJubyAnU2F2ZWQ6JyBub3RpZmljYXRpb24gd2hlbiBub3RoaW5nIHdhcyBzYXZlZFwiKTtcblx0XHR9IGZpbmFsbHkge1xuXHRcdFx0Y2xlYW51cCgpO1xuXHRcdH1cblx0fSk7XG59KTtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBidWlsZEJhc2hQZXJtaXNzaW9uUGF0dGVybiBcdTIwMTQgc21hcnQgcGVybWlzc2lvbiBncmFudWxhcml0eVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmRlc2NyaWJlKFwiYnVpbGRCYXNoUGVybWlzc2lvblBhdHRlcm5cIiwgKCkgPT4ge1xuXHR0ZXN0KFwic2ltcGxlIGNvbW1hbmQgd2lsZGNhcmRzIGFsbCBhcmdzXCIsICgpID0+IHtcblx0XHRhc3NlcnQuZXF1YWwoYnVpbGRCYXNoUGVybWlzc2lvblBhdHRlcm4oXCJwaW5nIC1uIDQgbG9jYWxob3N0XCIpLCBcIkJhc2gocGluZzoqKVwiKTtcblx0XHRhc3NlcnQuZXF1YWwoYnVpbGRCYXNoUGVybWlzc2lvblBhdHRlcm4oXCJlY2hvIGhlbGxvIHdvcmxkXCIpLCBcIkJhc2goZWNobzoqKVwiKTtcblx0XHRhc3NlcnQuZXF1YWwoYnVpbGRCYXNoUGVybWlzc2lvblBhdHRlcm4oXCJscyAtbGEgL3RtcFwiKSwgXCJCYXNoKGxzOiopXCIpO1xuXHRcdGFzc2VydC5lcXVhbChidWlsZEJhc2hQZXJtaXNzaW9uUGF0dGVybihcIm5vZGUgc2VydmVyLmpzXCIpLCBcIkJhc2gobm9kZToqKVwiKTtcblx0fSk7XG5cblx0dGVzdChcImdpdCBjYXB0dXJlcyBvbmUgc3ViY29tbWFuZFwiLCAoKSA9PiB7XG5cdFx0YXNzZXJ0LmVxdWFsKGJ1aWxkQmFzaFBlcm1pc3Npb25QYXR0ZXJuKFwiZ2l0IHB1c2ggb3JpZ2luIG1haW5cIiksIFwiQmFzaChnaXQgcHVzaDoqKVwiKTtcblx0XHRhc3NlcnQuZXF1YWwoYnVpbGRCYXNoUGVybWlzc2lvblBhdHRlcm4oXCJnaXQgbG9nIC0tb25lbGluZVwiKSwgXCJCYXNoKGdpdCBsb2c6KilcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKGJ1aWxkQmFzaFBlcm1pc3Npb25QYXR0ZXJuKFwiZ2l0IHN0YXR1c1wiKSwgXCJCYXNoKGdpdCBzdGF0dXM6KilcIik7XG5cdH0pO1xuXG5cdHRlc3QoXCJnaCBjYXB0dXJlcyB0d28gc3ViY29tbWFuZHNcIiwgKCkgPT4ge1xuXHRcdGFzc2VydC5lcXVhbChidWlsZEJhc2hQZXJtaXNzaW9uUGF0dGVybihcImdoIHByIGxpc3RcIiksIFwiQmFzaChnaCBwciBsaXN0OiopXCIpO1xuXHRcdGFzc2VydC5lcXVhbChidWlsZEJhc2hQZXJtaXNzaW9uUGF0dGVybihcImdoIHByIGNyZWF0ZSAtLXRpdGxlIGZvb1wiKSwgXCJCYXNoKGdoIHByIGNyZWF0ZToqKVwiKTtcblx0XHRhc3NlcnQuZXF1YWwoYnVpbGRCYXNoUGVybWlzc2lvblBhdHRlcm4oXCJnaCBpc3N1ZSB2aWV3IDEyM1wiKSwgXCJCYXNoKGdoIGlzc3VlIHZpZXc6KilcIik7XG5cdH0pO1xuXG5cdHRlc3QoXCJucG0gY2FwdHVyZXMgb25lIHN1YmNvbW1hbmRcIiwgKCkgPT4ge1xuXHRcdGFzc2VydC5lcXVhbChidWlsZEJhc2hQZXJtaXNzaW9uUGF0dGVybihcIm5wbSBpbnN0YWxsIGxvZGFzaFwiKSwgXCJCYXNoKG5wbSBpbnN0YWxsOiopXCIpO1xuXHRcdGFzc2VydC5lcXVhbChidWlsZEJhc2hQZXJtaXNzaW9uUGF0dGVybihcIm5wbSBwdWJsaXNoXCIpLCBcIkJhc2gobnBtIHB1Ymxpc2g6KilcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKGJ1aWxkQmFzaFBlcm1pc3Npb25QYXR0ZXJuKFwibnBtIHJ1biB0ZXN0XCIpLCBcIkJhc2gobnBtIHJ1bjoqKVwiKTtcblx0fSk7XG5cblx0dGVzdChcIm5weCBjYXB0dXJlcyBwYWNrYWdlIG5hbWVcIiwgKCkgPT4ge1xuXHRcdGFzc2VydC5lcXVhbChidWlsZEJhc2hQZXJtaXNzaW9uUGF0dGVybihcIm5weCB2aXRlc3QgcnVuXCIpLCBcIkJhc2gobnB4IHZpdGVzdDoqKVwiKTtcblx0XHRhc3NlcnQuZXF1YWwoYnVpbGRCYXNoUGVybWlzc2lvblBhdHRlcm4oXCJucHggLS12ZXJzaW9uXCIpLCBcIkJhc2gobnB4IC0tdmVyc2lvbjoqKVwiKTtcblx0fSk7XG5cblx0dGVzdChcImRvY2tlciBjYXB0dXJlcyBvbmUgc3ViY29tbWFuZFwiLCAoKSA9PiB7XG5cdFx0YXNzZXJ0LmVxdWFsKGJ1aWxkQmFzaFBlcm1pc3Npb25QYXR0ZXJuKFwiZG9ja2VyIHBzIC1hXCIpLCBcIkJhc2goZG9ja2VyIHBzOiopXCIpO1xuXHRcdGFzc2VydC5lcXVhbChidWlsZEJhc2hQZXJtaXNzaW9uUGF0dGVybihcImRvY2tlciBybSBjb250YWluZXIxXCIpLCBcIkJhc2goZG9ja2VyIHJtOiopXCIpO1xuXHR9KTtcblxuXHR0ZXN0KFwiYXdzIGNhcHR1cmVzIHR3byBzdWJjb21tYW5kc1wiLCAoKSA9PiB7XG5cdFx0YXNzZXJ0LmVxdWFsKGJ1aWxkQmFzaFBlcm1pc3Npb25QYXR0ZXJuKFwiYXdzIHMzIGNwIGZpbGUudHh0IHMzOi8vYnVja2V0L1wiKSwgXCJCYXNoKGF3cyBzMyBjcDoqKVwiKTtcblx0XHRhc3NlcnQuZXF1YWwoYnVpbGRCYXNoUGVybWlzc2lvblBhdHRlcm4oXCJhd3MgZWMyIGRlc2NyaWJlLWluc3RhbmNlc1wiKSwgXCJCYXNoKGF3cyBlYzIgZGVzY3JpYmUtaW5zdGFuY2VzOiopXCIpO1xuXHR9KTtcblxuXHR0ZXN0KFwic2tpcHMgc3VkbyB3cmFwcGVyXCIsICgpID0+IHtcblx0XHRhc3NlcnQuZXF1YWwoYnVpbGRCYXNoUGVybWlzc2lvblBhdHRlcm4oXCJzdWRvIHBpbmcgbG9jYWxob3N0XCIpLCBcIkJhc2gocGluZzoqKVwiKTtcblx0XHRhc3NlcnQuZXF1YWwoYnVpbGRCYXNoUGVybWlzc2lvblBhdHRlcm4oXCJzdWRvIGdpdCBwdXNoXCIpLCBcIkJhc2goZ2l0IHB1c2g6KilcIik7XG5cdH0pO1xuXG5cdHRlc3QoXCJza2lwcyBlbnYgd3JhcHBlciBhbmQgVkFSPXZhbCBhc3NpZ25tZW50c1wiLCAoKSA9PiB7XG5cdFx0YXNzZXJ0LmVxdWFsKGJ1aWxkQmFzaFBlcm1pc3Npb25QYXR0ZXJuKFwiZW52IE5PREVfRU5WPXByb2Qgbm9kZSBzZXJ2ZXIuanNcIiksIFwiQmFzaChub2RlOiopXCIpO1xuXHRcdGFzc2VydC5lcXVhbChidWlsZEJhc2hQZXJtaXNzaW9uUGF0dGVybihcIk5PREVfRU5WPXByb2Qgbm9kZSBzZXJ2ZXIuanNcIiksIFwiQmFzaChub2RlOiopXCIpO1xuXHRcdGFzc2VydC5lcXVhbChidWlsZEJhc2hQZXJtaXNzaW9uUGF0dGVybihcIkZPTz1iYXIgQkFaPXF1eCBnaXQgcHVzaFwiKSwgXCJCYXNoKGdpdCBwdXNoOiopXCIpO1xuXHR9KTtcblxuXHR0ZXN0KFwic3RyaXBzIHBhdGggZnJvbSBleGVjdXRhYmxlXCIsICgpID0+IHtcblx0XHRhc3NlcnQuZXF1YWwoYnVpbGRCYXNoUGVybWlzc2lvblBhdHRlcm4oXCIvdXNyL2Jpbi9naXQgcHVzaFwiKSwgXCJCYXNoKGdpdCBwdXNoOiopXCIpO1xuXHRcdGFzc2VydC5lcXVhbChidWlsZEJhc2hQZXJtaXNzaW9uUGF0dGVybihcIkM6XFxcXFdpbmRvd3NcXFxccGluZy5leGUgbG9jYWxob3N0XCIpLCBcIkJhc2gocGluZzoqKVwiKTtcblx0fSk7XG5cblx0dGVzdChcImVtcHR5IG9yIHdoaXRlc3BhY2Utb25seSBjb21tYW5kXCIsICgpID0+IHtcblx0XHRhc3NlcnQuZXF1YWwoYnVpbGRCYXNoUGVybWlzc2lvblBhdHRlcm4oXCJcIiksIFwiQmFzaCgqKVwiKTtcblx0XHRhc3NlcnQuZXF1YWwoYnVpbGRCYXNoUGVybWlzc2lvblBhdHRlcm4oXCIgICBcIiksIFwiQmFzaCgqKVwiKTtcblx0fSk7XG5cblx0dGVzdChcImNoYWluZWQgY29tbWFuZHMgXHUyMDE0IGV4dHJhY3RzIHBhdHRlcm4gZnJvbSB0aGUgbWVhbmluZ2Z1bCBzZWdtZW50XCIsICgpID0+IHtcblx0XHRhc3NlcnQuZXF1YWwoYnVpbGRCYXNoUGVybWlzc2lvblBhdHRlcm4oXCJjZCAvZm9vICYmIGdoIHByIGxpc3QgLS1saW1pdCA1XCIpLCBcIkJhc2goZ2ggcHIgbGlzdDoqKVwiKTtcblx0XHRhc3NlcnQuZXF1YWwoYnVpbGRCYXNoUGVybWlzc2lvblBhdHRlcm4oXCJjZCBDOi9Vc2Vycy9kamVmZi9yZXBvcy9nc2QtMiAmJiBnaCBwciBsaXN0IC0tbGltaXQgNVwiKSwgXCJCYXNoKGdoIHByIGxpc3Q6KilcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKGJ1aWxkQmFzaFBlcm1pc3Npb25QYXR0ZXJuKFwiY2QgL3RtcCAmJiBnaXQgcHVzaCBvcmlnaW4gbWFpblwiKSwgXCJCYXNoKGdpdCBwdXNoOiopXCIpO1xuXHRcdGFzc2VydC5lcXVhbChidWlsZEJhc2hQZXJtaXNzaW9uUGF0dGVybihcImV4cG9ydCBGT089MSAmJiBucG0gaW5zdGFsbCBsb2Rhc2hcIiksIFwiQmFzaChucG0gaW5zdGFsbDoqKVwiKTtcblx0XHRhc3NlcnQuZXF1YWwoYnVpbGRCYXNoUGVybWlzc2lvblBhdHRlcm4oXCJta2RpciAtcCBvdXQ7IGRvY2tlciBwcyAtYVwiKSwgXCJCYXNoKGRvY2tlciBwczoqKVwiKTtcblx0XHRhc3NlcnQuZXF1YWwoYnVpbGRCYXNoUGVybWlzc2lvblBhdHRlcm4oXCJlY2hvIHN0YXJ0IHx8IHBpbmcgbG9jYWxob3N0XCIpLCBcIkJhc2gocGluZzoqKVwiKTtcblx0fSk7XG5cblx0dGVzdChcInNraXBzIHRyYWlsaW5nIHx8IHRydWUgLyB8fCA6IGVycm9yIHN1cHByZXNzb3JzXCIsICgpID0+IHtcblx0XHRhc3NlcnQuZXF1YWwoXG5cdFx0XHRidWlsZEJhc2hQZXJtaXNzaW9uUGF0dGVybihcImNkIEM6L1VzZXJzL2RqZWZmL3JlcG9zL2dzZC0yICYmIGdoIHByIGNyZWF0ZSAtLWRyeS1ydW4gLS10aXRsZSBcXFwidGVzdFxcXCIgLS1ib2R5IFxcXCJ0ZXN0XFxcIiAyPiYxIHx8IHRydWVcIiksXG5cdFx0XHRcIkJhc2goZ2ggcHIgY3JlYXRlOiopXCIsXG5cdFx0KTtcblx0XHRhc3NlcnQuZXF1YWwoYnVpbGRCYXNoUGVybWlzc2lvblBhdHRlcm4oXCJnaCBwciBsaXN0IHx8IHRydWVcIiksIFwiQmFzaChnaCBwciBsaXN0OiopXCIpO1xuXHRcdGFzc2VydC5lcXVhbChidWlsZEJhc2hQZXJtaXNzaW9uUGF0dGVybihcImdpdCBwdXNoIHx8IDpcIiksIFwiQmFzaChnaXQgcHVzaDoqKVwiKTtcblx0XHRhc3NlcnQuZXF1YWwoYnVpbGRCYXNoUGVybWlzc2lvblBhdHRlcm4oXCJjZCAvdG1wICYmIG5wbSBpbnN0YWxsIHx8IGVjaG8gZmFpbGVkXCIpLCBcIkJhc2gobnBtIGluc3RhbGw6KilcIik7XG5cdH0pO1xuXG5cdHRlc3QoXCJzaW5nbGUgY29tbWFuZCBpcyB1bmFmZmVjdGVkIGJ5IGNoYWluIGV4dHJhY3Rpb25cIiwgKCkgPT4ge1xuXHRcdGFzc2VydC5lcXVhbChidWlsZEJhc2hQZXJtaXNzaW9uUGF0dGVybihcImdoIHByIGxpc3RcIiksIFwiQmFzaChnaCBwciBsaXN0OiopXCIpO1xuXHRcdGFzc2VydC5lcXVhbChidWlsZEJhc2hQZXJtaXNzaW9uUGF0dGVybihcImdpdCBwdXNoIG9yaWdpbiBtYWluXCIpLCBcIkJhc2goZ2l0IHB1c2g6KilcIik7XG5cdH0pO1xufSk7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gYnVpbGRCYXNoUGVybWlzc2lvblBhdHRlcm5PcHRpb25zIFx1MjAxNCBncmFudWxhcml0eSBsZXZlbCBtZW51XG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZGVzY3JpYmUoXCJidWlsZEJhc2hQZXJtaXNzaW9uUGF0dGVybk9wdGlvbnNcIiwgKCkgPT4ge1xuXHR0ZXN0KFwib2ZmZXJzIGV2ZXJ5IHByZWZpeCBmcm9tIGJhc2UgdG8gZnVsbCBzdWJjb21tYW5kIGNoYWluXCIsICgpID0+IHtcblx0XHRhc3NlcnQuZGVlcEVxdWFsKGJ1aWxkQmFzaFBlcm1pc3Npb25QYXR0ZXJuT3B0aW9ucyhcImdoIHByIGxpc3RcIiksIFtcblx0XHRcdFwiQmFzaChnaDoqKVwiLFxuXHRcdFx0XCJCYXNoKGdoIHByOiopXCIsXG5cdFx0XHRcIkJhc2goZ2ggcHIgbGlzdDoqKVwiLFxuXHRcdF0pO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwoYnVpbGRCYXNoUGVybWlzc2lvblBhdHRlcm5PcHRpb25zKFwiZ2l0IHB1c2ggb3JpZ2luIG1haW5cIiksIFtcblx0XHRcdFwiQmFzaChnaXQ6KilcIixcblx0XHRcdFwiQmFzaChnaXQgcHVzaDoqKVwiLFxuXHRcdFx0XCJCYXNoKGdpdCBwdXNoIG9yaWdpbjoqKVwiLFxuXHRcdFx0XCJCYXNoKGdpdCBwdXNoIG9yaWdpbiBtYWluOiopXCIsXG5cdFx0XSk7XG5cdH0pO1xuXG5cdHRlc3QoXCJzdG9wcyBhdCBmaXJzdCBmbGFnIFx1MjAxNCBmbGFncyBhcmUgYXJncywgbm90IHZlcmJzXCIsICgpID0+IHtcblx0XHRhc3NlcnQuZGVlcEVxdWFsKGJ1aWxkQmFzaFBlcm1pc3Npb25QYXR0ZXJuT3B0aW9ucyhcImdoIHByIGNyZWF0ZSAtLXRpdGxlIGZvb1wiKSwgW1xuXHRcdFx0XCJCYXNoKGdoOiopXCIsXG5cdFx0XHRcIkJhc2goZ2ggcHI6KilcIixcblx0XHRcdFwiQmFzaChnaCBwciBjcmVhdGU6KilcIixcblx0XHRdKTtcblx0XHRhc3NlcnQuZGVlcEVxdWFsKGJ1aWxkQmFzaFBlcm1pc3Npb25QYXR0ZXJuT3B0aW9ucyhcImdpdCBsb2cgLS1vbmVsaW5lXCIpLCBbXG5cdFx0XHRcIkJhc2goZ2l0OiopXCIsXG5cdFx0XHRcIkJhc2goZ2l0IGxvZzoqKVwiLFxuXHRcdF0pO1xuXHR9KTtcblxuXHR0ZXN0KFwic2luZ2xlLW9wdGlvbiB3aGVuIHRoZXJlIGlzIG5vIHN1YmNvbW1hbmQgdG8gY2hvb3NlIGZyb21cIiwgKCkgPT4ge1xuXHRcdGFzc2VydC5kZWVwRXF1YWwoYnVpbGRCYXNoUGVybWlzc2lvblBhdHRlcm5PcHRpb25zKFwibHMgLWxhIC90bXBcIiksIFtcIkJhc2gobHM6KilcIl0pO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwoYnVpbGRCYXNoUGVybWlzc2lvblBhdHRlcm5PcHRpb25zKFwicGluZyAtbiA0IGxvY2FsaG9zdFwiKSwgW1wiQmFzaChwaW5nOiopXCJdKTtcblx0XHRhc3NlcnQuZGVlcEVxdWFsKGJ1aWxkQmFzaFBlcm1pc3Npb25QYXR0ZXJuT3B0aW9ucyhcIm5vZGVcIiksIFtcIkJhc2gobm9kZToqKVwiXSk7XG5cdH0pO1xuXG5cdHRlc3QoXCJleHRyYWN0cyBtZWFuaW5nZnVsIHNlZ21lbnQgZnJvbSBjb21wb3VuZCBjb21tYW5kc1wiLCAoKSA9PiB7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChidWlsZEJhc2hQZXJtaXNzaW9uUGF0dGVybk9wdGlvbnMoXCJjZCAvZm9vICYmIGdoIHByIGxpc3RcIiksIFtcblx0XHRcdFwiQmFzaChnaDoqKVwiLFxuXHRcdFx0XCJCYXNoKGdoIHByOiopXCIsXG5cdFx0XHRcIkJhc2goZ2ggcHIgbGlzdDoqKVwiLFxuXHRcdF0pO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwoYnVpbGRCYXNoUGVybWlzc2lvblBhdHRlcm5PcHRpb25zKFwiZ2ggcHIgY3JlYXRlIC0tZHJ5LXJ1biB8fCB0cnVlXCIpLCBbXG5cdFx0XHRcIkJhc2goZ2g6KilcIixcblx0XHRcdFwiQmFzaChnaCBwcjoqKVwiLFxuXHRcdFx0XCJCYXNoKGdoIHByIGNyZWF0ZToqKVwiLFxuXHRcdF0pO1xuXHR9KTtcblxuXHR0ZXN0KFwiY2FwcyBhdCB0aHJlZSBzdWJjb21tYW5kIHRva2VucyB0byBrZWVwIHRoZSBtZW51IHNob3J0XCIsICgpID0+IHtcblx0XHRjb25zdCByZXN1bHQgPSBidWlsZEJhc2hQZXJtaXNzaW9uUGF0dGVybk9wdGlvbnMoXCJmb28gYmFyIGJheiBxdXggcXV1eCBjb3JnZVwiKTtcblx0XHQvLyBiYXNlICsgMyBzdWIgdG9rZW5zID0gNCBwYXR0ZXJucyBtYXhcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0Lmxlbmd0aCwgNCk7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQsIFtcblx0XHRcdFwiQmFzaChmb286KilcIixcblx0XHRcdFwiQmFzaChmb28gYmFyOiopXCIsXG5cdFx0XHRcIkJhc2goZm9vIGJhciBiYXo6KilcIixcblx0XHRcdFwiQmFzaChmb28gYmFyIGJheiBxdXg6KilcIixcblx0XHRdKTtcblx0fSk7XG5cblx0dGVzdChcInNraXBzIHN1ZG8vZW52IHdyYXBwZXJzIGxpa2UgdGhlIHNpbmdsZS1wYXR0ZXJuIHZhcmlhbnRcIiwgKCkgPT4ge1xuXHRcdGFzc2VydC5kZWVwRXF1YWwoYnVpbGRCYXNoUGVybWlzc2lvblBhdHRlcm5PcHRpb25zKFwic3VkbyBnaXQgcHVzaCBvcmlnaW5cIiksIFtcblx0XHRcdFwiQmFzaChnaXQ6KilcIixcblx0XHRcdFwiQmFzaChnaXQgcHVzaDoqKVwiLFxuXHRcdFx0XCJCYXNoKGdpdCBwdXNoIG9yaWdpbjoqKVwiLFxuXHRcdF0pO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwoYnVpbGRCYXNoUGVybWlzc2lvblBhdHRlcm5PcHRpb25zKFwiTk9ERV9FTlY9cHJvZCBub2RlIHNlcnZlci5qc1wiKSwgW1xuXHRcdFx0XCJCYXNoKG5vZGU6KilcIixcblx0XHRcdFwiQmFzaChub2RlIHNlcnZlci5qczoqKVwiLFxuXHRcdF0pO1xuXHR9KTtcblxuXHR0ZXN0KFwiZW1wdHkgY29tbWFuZCByZXR1cm5zIHRoZSBjYXRjaC1hbGwgcGF0dGVyblwiLCAoKSA9PiB7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChidWlsZEJhc2hQZXJtaXNzaW9uUGF0dGVybk9wdGlvbnMoXCJcIiksIFtcIkJhc2goKilcIl0pO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwoYnVpbGRCYXNoUGVybWlzc2lvblBhdHRlcm5PcHRpb25zKFwiICAgXCIpLCBbXCJCYXNoKCopXCJdKTtcblx0fSk7XG59KTtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBiYXNoQ29tbWFuZE1hdGNoZXNTYXZlZFJ1bGVzIFx1MjAxNCBjb21wb3VuZCBjb21tYW5kIGJ5cGFzcyBmb3Igc2F2ZWQgcnVsZXNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5kZXNjcmliZShcImJhc2hDb21tYW5kTWF0Y2hlc1NhdmVkUnVsZXMgXHUyMDE0IGNvbXBvdW5kIGNvbW1hbmQgYnlwYXNzXCIsICgpID0+IHtcblx0bGV0IHRlbXBEaXI6IHN0cmluZztcblx0bGV0IG9yaWdpbmFsQ3dkOiBzdHJpbmc7XG5cblx0Ly8gQ3JlYXRlIGEgdGVtcCBwcm9qZWN0IGRpcmVjdG9yeSB3aXRoIC5jbGF1ZGUvc2V0dGluZ3MubG9jYWwuanNvblxuXHRmdW5jdGlvbiBzZXR1cFNldHRpbmdzKGFsbG93OiBzdHJpbmdbXSk6IHZvaWQge1xuXHRcdGNvbnN0IGNsYXVkZURpciA9IGpvaW4odGVtcERpciwgXCIuY2xhdWRlXCIpO1xuXHRcdG1rZGlyU3luYyhjbGF1ZGVEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXHRcdHdyaXRlRmlsZVN5bmMoXG5cdFx0XHRqb2luKGNsYXVkZURpciwgXCJzZXR0aW5ncy5sb2NhbC5qc29uXCIpLFxuXHRcdFx0SlNPTi5zdHJpbmdpZnkoeyBwZXJtaXNzaW9uczogeyBhbGxvdyB9IH0pLFxuXHRcdCk7XG5cdH1cblxuXHQvLyBiaW9tZS1pZ25vcmUgbGludC9zdXNwaWNpb3VzL25vRXhwbGljaXRBbnk6IHRlc3Qtb25seSBtb25rZXktcGF0Y2hcblx0bGV0IG9yaWdDd2Q6IGFueTtcblxuXHQvLyBNb25rZXktcGF0Y2ggcHJvY2Vzcy5jd2QoKSB0byBwb2ludCBhdCBvdXIgdGVtcCBkaXJcblx0ZnVuY3Rpb24gc2V0Q3dkKGRpcjogc3RyaW5nKTogdm9pZCB7XG5cdFx0b3JpZ0N3ZCA9IHByb2Nlc3MuY3dkO1xuXHRcdHByb2Nlc3MuY3dkID0gKCkgPT4gZGlyO1xuXHR9XG5cdGZ1bmN0aW9uIHJlc3RvcmVDd2QoKTogdm9pZCB7XG5cdFx0aWYgKG9yaWdDd2QpIHByb2Nlc3MuY3dkID0gb3JpZ0N3ZDtcblx0fVxuXG5cdHRlc3QoXCJtYXRjaGVzIGNkLXByZWZpeGVkIGNvbXBvdW5kIGNvbW1hbmQgYWdhaW5zdCBzYXZlZCBwcmVmaXggcnVsZVwiLCAoKSA9PiB7XG5cdFx0dGVtcERpciA9IHJlYWxwYXRoU3luYyhta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1ydWxlcy1cIikpKTtcblx0XHR0cnkge1xuXHRcdFx0c2V0dXBTZXR0aW5ncyhbXCJCYXNoKGdoIHByIGxpc3Q6KilcIl0pO1xuXHRcdFx0c2V0Q3dkKHRlbXBEaXIpO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKFxuXHRcdFx0XHRiYXNoQ29tbWFuZE1hdGNoZXNTYXZlZFJ1bGVzKFwiY2QgL3NvbWUvcGF0aCAmJiBnaCBwciBsaXN0IC0tbGltaXQgNVwiKSxcblx0XHRcdFx0dHJ1ZSxcblx0XHRcdCk7XG5cdFx0fSBmaW5hbGx5IHtcblx0XHRcdHJlc3RvcmVDd2QoKTtcblx0XHRcdHJtU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG5cdFx0fVxuXHR9KTtcblxuXHR0ZXN0KFwibWF0Y2hlcyBjZC1wcmVmaXhlZCBjb21wb3VuZCBjb21tYW5kIHdpdGggZXhhY3Qgc3ViY29tbWFuZFwiLCAoKSA9PiB7XG5cdFx0dGVtcERpciA9IHJlYWxwYXRoU3luYyhta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1ydWxlcy1cIikpKTtcblx0XHR0cnkge1xuXHRcdFx0c2V0dXBTZXR0aW5ncyhbXCJCYXNoKGdoIHByIGxpc3Q6KilcIl0pO1xuXHRcdFx0c2V0Q3dkKHRlbXBEaXIpO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKFxuXHRcdFx0XHRiYXNoQ29tbWFuZE1hdGNoZXNTYXZlZFJ1bGVzKFwiY2QgQzovVXNlcnMvZm9vL3JlcG9zL2JhciAmJiBnaCBwciBsaXN0XCIpLFxuXHRcdFx0XHR0cnVlLFxuXHRcdFx0KTtcblx0XHR9IGZpbmFsbHkge1xuXHRcdFx0cmVzdG9yZUN3ZCgpO1xuXHRcdFx0cm1TeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcblx0XHR9XG5cdH0pO1xuXG5cdHRlc3QoXCJyZWplY3RzIHdoZW4gbGVhZGluZyBzZWdtZW50IGlzIG5vdCBjZFwiLCAoKSA9PiB7XG5cdFx0dGVtcERpciA9IHJlYWxwYXRoU3luYyhta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1ydWxlcy1cIikpKTtcblx0XHR0cnkge1xuXHRcdFx0c2V0dXBTZXR0aW5ncyhbXCJCYXNoKGdoIHByIGxpc3Q6KilcIl0pO1xuXHRcdFx0c2V0Q3dkKHRlbXBEaXIpO1xuXHRcdFx0Ly8gXCJybSAtcmYgL3RtcFwiIGlzIG5vdCBhIGNkIGNvbW1hbmQgXHUyMDE0IHNob3VsZCBub3QgYXV0by1hcHByb3ZlXG5cdFx0XHRhc3NlcnQuZXF1YWwoXG5cdFx0XHRcdGJhc2hDb21tYW5kTWF0Y2hlc1NhdmVkUnVsZXMoXCJybSAtcmYgL3RtcCAmJiBnaCBwciBsaXN0XCIpLFxuXHRcdFx0XHRmYWxzZSxcblx0XHRcdCk7XG5cdFx0fSBmaW5hbGx5IHtcblx0XHRcdHJlc3RvcmVDd2QoKTtcblx0XHRcdHJtU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG5cdFx0fVxuXHR9KTtcblxuXHR0ZXN0KFwicmVqZWN0cyB3aGVuIG1lYW5pbmdmdWwgc2VnbWVudCBkb2VzIG5vdCBtYXRjaCBhbnkgcnVsZVwiLCAoKSA9PiB7XG5cdFx0dGVtcERpciA9IHJlYWxwYXRoU3luYyhta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1ydWxlcy1cIikpKTtcblx0XHR0cnkge1xuXHRcdFx0c2V0dXBTZXR0aW5ncyhbXCJCYXNoKGdoIHByIGxpc3Q6KilcIl0pO1xuXHRcdFx0c2V0Q3dkKHRlbXBEaXIpO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKFxuXHRcdFx0XHRiYXNoQ29tbWFuZE1hdGNoZXNTYXZlZFJ1bGVzKFwiY2QgL3BhdGggJiYgZ2ggaXNzdWUgY3JlYXRlIC0tdGl0bGUgZm9vXCIpLFxuXHRcdFx0XHRmYWxzZSxcblx0XHRcdCk7XG5cdFx0fSBmaW5hbGx5IHtcblx0XHRcdHJlc3RvcmVDd2QoKTtcblx0XHRcdHJtU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG5cdFx0fVxuXHR9KTtcblxuXHR0ZXN0KFwibWF0Y2hlcyBzaW1wbGUgKG5vbi1jb21wb3VuZCkgY29tbWFuZHMgYWdhaW5zdCBvbi1kaXNrIHJ1bGVzXCIsICgpID0+IHtcblx0XHR0ZW1wRGlyID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXJ1bGVzLVwiKSkpO1xuXHRcdHRyeSB7XG5cdFx0XHRzZXR1cFNldHRpbmdzKFtcIkJhc2goZ2ggcHIgbGlzdDoqKVwiXSk7XG5cdFx0XHRzZXRDd2QodGVtcERpcik7XG5cdFx0XHQvLyBTaW1wbGUgY29tbWFuZHMgbXVzdCBhbHNvIGJlIGNoZWNrZWQgXHUyMDE0IHRoZSBTREsncyBpbi1tZW1vcnkgY2FjaGVcblx0XHRcdC8vIG1heSBiZSBzdGFsZSBpZiB0aGUgcnVsZSB3YXMgYWRkZWQgbWlkLXNlc3Npb24gdmlhIFwiQWx3YXlzIEFsbG93XCJcblx0XHRcdGFzc2VydC5lcXVhbChiYXNoQ29tbWFuZE1hdGNoZXNTYXZlZFJ1bGVzKFwiZ2ggcHIgbGlzdCAtLWxpbWl0IDVcIiksIHRydWUpO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKGJhc2hDb21tYW5kTWF0Y2hlc1NhdmVkUnVsZXMoXCJnaCBwciBsaXN0XCIpLCB0cnVlKTtcblx0XHR9IGZpbmFsbHkge1xuXHRcdFx0cmVzdG9yZUN3ZCgpO1xuXHRcdFx0cm1TeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcblx0XHR9XG5cdH0pO1xuXG5cdHRlc3QoXCJyZXR1cm5zIGZhbHNlIGZvciBzaW1wbGUgY29tbWFuZHMgd2l0aCBubyBtYXRjaGluZyBydWxlXCIsICgpID0+IHtcblx0XHR0ZW1wRGlyID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXJ1bGVzLVwiKSkpO1xuXHRcdHRyeSB7XG5cdFx0XHRzZXR1cFNldHRpbmdzKFtcIkJhc2goZ2ggcHIgbGlzdDoqKVwiXSk7XG5cdFx0XHRzZXRDd2QodGVtcERpcik7XG5cdFx0XHRhc3NlcnQuZXF1YWwoYmFzaENvbW1hbmRNYXRjaGVzU2F2ZWRSdWxlcyhcImdoIGlzc3VlIGxpc3QgLS1saW1pdCA1XCIpLCBmYWxzZSk7XG5cdFx0fSBmaW5hbGx5IHtcblx0XHRcdHJlc3RvcmVDd2QoKTtcblx0XHRcdHJtU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG5cdFx0fVxuXHR9KTtcblxuXHR0ZXN0KFwicmV0dXJucyBmYWxzZSB3aGVuIG5vIHNldHRpbmdzIGZpbGUgZXhpc3RzXCIsICgpID0+IHtcblx0XHR0ZW1wRGlyID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXJ1bGVzLVwiKSkpO1xuXHRcdHRyeSB7XG5cdFx0XHQvLyBObyAuY2xhdWRlL3NldHRpbmdzLmxvY2FsLmpzb24gY3JlYXRlZFxuXHRcdFx0c2V0Q3dkKHRlbXBEaXIpO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKFxuXHRcdFx0XHRiYXNoQ29tbWFuZE1hdGNoZXNTYXZlZFJ1bGVzKFwiY2QgL3BhdGggJiYgZ2ggcHIgbGlzdFwiKSxcblx0XHRcdFx0ZmFsc2UsXG5cdFx0XHQpO1xuXHRcdH0gZmluYWxseSB7XG5cdFx0XHRyZXN0b3JlQ3dkKCk7XG5cdFx0XHRybVN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuXHRcdH1cblx0fSk7XG5cblx0dGVzdChcIm1hdGNoZXMgZXhhY3QgcnVsZSAobm9uLXByZWZpeClcIiwgKCkgPT4ge1xuXHRcdHRlbXBEaXIgPSByZWFscGF0aFN5bmMobWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtcnVsZXMtXCIpKSk7XG5cdFx0dHJ5IHtcblx0XHRcdHNldHVwU2V0dGluZ3MoW1wiQmFzaChwaW5nIC1uIDQgbG9jYWxob3N0KVwiXSk7XG5cdFx0XHRzZXRDd2QodGVtcERpcik7XG5cdFx0XHRhc3NlcnQuZXF1YWwoXG5cdFx0XHRcdGJhc2hDb21tYW5kTWF0Y2hlc1NhdmVkUnVsZXMoXCJjZCAvcGF0aCAmJiBwaW5nIC1uIDQgbG9jYWxob3N0XCIpLFxuXHRcdFx0XHR0cnVlLFxuXHRcdFx0KTtcblx0XHR9IGZpbmFsbHkge1xuXHRcdFx0cmVzdG9yZUN3ZCgpO1xuXHRcdFx0cm1TeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcblx0XHR9XG5cdH0pO1xuXG5cdHRlc3QoXCJoYW5kbGVzIG11bHRpcGxlIGNkIHNlZ21lbnRzIGJlZm9yZSB0aGUgbWVhbmluZ2Z1bCBjb21tYW5kXCIsICgpID0+IHtcblx0XHR0ZW1wRGlyID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXJ1bGVzLVwiKSkpO1xuXHRcdHRyeSB7XG5cdFx0XHRzZXR1cFNldHRpbmdzKFtcIkJhc2gobnBtIGluc3RhbGw6KilcIl0pO1xuXHRcdFx0c2V0Q3dkKHRlbXBEaXIpO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKFxuXHRcdFx0XHRiYXNoQ29tbWFuZE1hdGNoZXNTYXZlZFJ1bGVzKFwiY2QgL2hvbWUgJiYgY2QgcHJvamVjdCAmJiBucG0gaW5zdGFsbCBsb2Rhc2hcIiksXG5cdFx0XHRcdHRydWUsXG5cdFx0XHQpO1xuXHRcdH0gZmluYWxseSB7XG5cdFx0XHRyZXN0b3JlQ3dkKCk7XG5cdFx0XHRybVN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuXHRcdH1cblx0fSk7XG5cblx0dGVzdChcIm1hdGNoZXMgY29tcG91bmQgY29tbWFuZCB3aXRoIHRyYWlsaW5nIHx8IHRydWUgc3VwcHJlc3NvclwiLCAoKSA9PiB7XG5cdFx0dGVtcERpciA9IHJlYWxwYXRoU3luYyhta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1ydWxlcy1cIikpKTtcblx0XHR0cnkge1xuXHRcdFx0c2V0dXBTZXR0aW5ncyhbXCJCYXNoKGdoIHByIGNyZWF0ZToqKVwiXSk7XG5cdFx0XHRzZXRDd2QodGVtcERpcik7XG5cdFx0XHRhc3NlcnQuZXF1YWwoXG5cdFx0XHRcdGJhc2hDb21tYW5kTWF0Y2hlc1NhdmVkUnVsZXMoJ2NkIEM6L1VzZXJzL2RqZWZmL3JlcG9zL2dzZC0yICYmIGdoIHByIGNyZWF0ZSAtLWRyeS1ydW4gLS10aXRsZSBcInRlc3RcIiAtLWJvZHkgXCJ0ZXN0XCIgMj4mMSB8fCB0cnVlJyksXG5cdFx0XHRcdHRydWUsXG5cdFx0XHQpO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKFxuXHRcdFx0XHRiYXNoQ29tbWFuZE1hdGNoZXNTYXZlZFJ1bGVzKFwiZ2ggcHIgY3JlYXRlIC0tZHJ5LXJ1biB8fCB0cnVlXCIpLFxuXHRcdFx0XHR0cnVlLFxuXHRcdFx0KTtcblx0XHRcdGFzc2VydC5lcXVhbChcblx0XHRcdFx0YmFzaENvbW1hbmRNYXRjaGVzU2F2ZWRSdWxlcyhcImNkIC90bXAgJiYgZ2l0IHB1c2ggfHwgOlwiKSxcblx0XHRcdFx0ZmFsc2UsIC8vIHJ1bGUgaXMgZm9yIGdoIHByIGNyZWF0ZSwgbm90IGdpdCBwdXNoXG5cdFx0XHQpO1xuXHRcdH0gZmluYWxseSB7XG5cdFx0XHRyZXN0b3JlQ3dkKCk7XG5cdFx0XHRybVN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuXHRcdH1cblx0fSk7XG5cblx0dGVzdChcInJlYWRzIHJ1bGVzIGZyb20gc2V0dGluZ3MuanNvbiBhcyB3ZWxsIGFzIHNldHRpbmdzLmxvY2FsLmpzb25cIiwgKCkgPT4ge1xuXHRcdHRlbXBEaXIgPSByZWFscGF0aFN5bmMobWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtcnVsZXMtXCIpKSk7XG5cdFx0dHJ5IHtcblx0XHRcdGNvbnN0IGNsYXVkZURpciA9IGpvaW4odGVtcERpciwgXCIuY2xhdWRlXCIpO1xuXHRcdFx0bWtkaXJTeW5jKGNsYXVkZURpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cdFx0XHR3cml0ZUZpbGVTeW5jKFxuXHRcdFx0XHRqb2luKGNsYXVkZURpciwgXCJzZXR0aW5ncy5qc29uXCIpLFxuXHRcdFx0XHRKU09OLnN0cmluZ2lmeSh7IHBlcm1pc3Npb25zOiB7IGFsbG93OiBbXCJCYXNoKGdpdCBwdXNoOiopXCJdIH0gfSksXG5cdFx0XHQpO1xuXHRcdFx0c2V0Q3dkKHRlbXBEaXIpO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKFxuXHRcdFx0XHRiYXNoQ29tbWFuZE1hdGNoZXNTYXZlZFJ1bGVzKFwiY2QgL3JlcG8gJiYgZ2l0IHB1c2ggb3JpZ2luIG1haW5cIiksXG5cdFx0XHRcdHRydWUsXG5cdFx0XHQpO1xuXHRcdH0gZmluYWxseSB7XG5cdFx0XHRyZXN0b3JlQ3dkKCk7XG5cdFx0XHRybVN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuXHRcdH1cblx0fSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUNBLFNBQVMsVUFBVSxZQUFZO0FBQy9CLE9BQU8sWUFBWTtBQUNuQixTQUFTLFdBQVcsYUFBYSxjQUFjLFFBQVEscUJBQXFCO0FBQzVFLFNBQVMsTUFBTSxl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QUM7QUFDaEUsUUFBSTtBQUNILG9CQUFjLENBQUMscUJBQXFCLENBQUM7QUFDckMsYUFBTyxPQUFPO0FBQ2QsYUFBTztBQUFBLFFBQ04sNkJBQTZCLDhDQUE4QztBQUFBLFFBQzNFO0FBQUEsTUFDRDtBQUFBLElBQ0QsVUFBRTtBQUNELGlCQUFXO0FBQ1gsYUFBTyxTQUFTLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDakQ7QUFBQSxFQUNELENBQUM7QUFFRCxPQUFLLDZEQUE2RCxNQUFNO0FBQ3ZFLGNBQVUsYUFBYSxZQUFZLEtBQUssT0FBTyxHQUFHLFlBQVksQ0FBQyxDQUFDO0FBQ2hFLFFBQUk7QUFDSCxvQkFBYyxDQUFDLHNCQUFzQixDQUFDO0FBQ3RDLGFBQU8sT0FBTztBQUNkLGFBQU87QUFBQSxRQUNOLDZCQUE2QixtR0FBbUc7QUFBQSxRQUNoSTtBQUFBLE1BQ0Q7QUFDQSxhQUFPO0FBQUEsUUFDTiw2QkFBNkIsZ0NBQWdDO0FBQUEsUUFDN0Q7QUFBQSxNQUNEO0FBQ0EsYUFBTztBQUFBLFFBQ04sNkJBQTZCLDBCQUEwQjtBQUFBLFFBQ3ZEO0FBQUE7QUFBQSxNQUNEO0FBQUEsSUFDRCxVQUFFO0FBQ0QsaUJBQVc7QUFDWCxhQUFPLFNBQVMsRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUNqRDtBQUFBLEVBQ0QsQ0FBQztBQUVELE9BQUssaUVBQWlFLE1BQU07QUFDM0UsY0FBVSxhQUFhLFlBQVksS0FBSyxPQUFPLEdBQUcsWUFBWSxDQUFDLENBQUM7QUFDaEUsUUFBSTtBQUNILFlBQU0sWUFBWSxLQUFLLFNBQVMsU0FBUztBQUN6QyxnQkFBVSxXQUFXLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDeEM7QUFBQSxRQUNDLEtBQUssV0FBVyxlQUFlO0FBQUEsUUFDL0IsS0FBSyxVQUFVLEVBQUUsYUFBYSxFQUFFLE9BQU8sQ0FBQyxrQkFBa0IsRUFBRSxFQUFFLENBQUM7QUFBQSxNQUNoRTtBQUNBLGFBQU8sT0FBTztBQUNkLGFBQU87QUFBQSxRQUNOLDZCQUE2QixrQ0FBa0M7QUFBQSxRQUMvRDtBQUFBLE1BQ0Q7QUFBQSxJQUNELFVBQUU7QUFDRCxpQkFBVztBQUNYLGFBQU8sU0FBUyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQ2pEO0FBQUEsRUFDRCxDQUFDO0FBQ0YsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
