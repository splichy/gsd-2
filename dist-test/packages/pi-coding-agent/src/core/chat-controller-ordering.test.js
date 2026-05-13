import assert from "node:assert/strict";
import { test } from "node:test";
import { handleAgentEvent } from "../modes/interactive/controllers/chat-controller.js";
function makeUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  };
}
function makeAssistant(content) {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "claude-code",
    model: "claude-sonnet-4",
    usage: makeUsage(),
    stopReason: "stop",
    timestamp: Date.now()
  };
}
function createHost() {
  const chatContainer = {
    children: [],
    addChild(component) {
      this.children.push(component);
    },
    removeChild(component) {
      const idx = this.children.indexOf(component);
      if (idx !== -1) this.children.splice(idx, 1);
    },
    clear() {
      this.children = [];
    }
  };
  const pinnedMessageContainer = {
    children: [],
    addChild(component) {
      this.children.push(component);
    },
    removeChild(component) {
      const idx = this.children.indexOf(component);
      if (idx !== -1) this.children.splice(idx, 1);
    },
    clear() {
      this.children = [];
    }
  };
  const host = {
    isInitialized: true,
    init: async () => {
    },
    defaultEditor: { onEscape: void 0 },
    editor: {},
    session: { retryAttempt: 0, abortCompaction: () => {
    }, abortRetry: () => {
    } },
    // rows:1 keeps the pinned-zone off-screen-threshold at its floor (1) so
    // any rendered segment after a pinnable text block triggers the pin.
    // Real terminals are larger; see chat-controller rowsRenderedAfterContentIndex.
    ui: { requestRender: () => {
    }, terminal: { rows: 1, columns: 80 } },
    footer: { invalidate: () => {
    } },
    keybindings: {},
    statusContainer: { clear: () => {
    }, addChild: () => {
    } },
    chatContainer,
    settingsManager: { getTimestampFormat: () => "date-time-iso", getShowImages: () => false },
    pendingTools: /* @__PURE__ */ new Map(),
    toolOutputExpanded: false,
    hideThinkingBlock: false,
    isBashMode: false,
    defaultWorkingMessage: "Working...",
    compactionQueuedMessages: [],
    editorContainer: {},
    pendingMessagesContainer: { clear: () => {
    } },
    pinnedMessageContainer,
    addMessageToChat: () => {
    },
    getMarkdownThemeWithSettings: () => ({}),
    formatWebSearchResult: () => "",
    getRegisteredToolDefinition: () => void 0,
    checkShutdownRequested: async () => {
    },
    rebuildChatFromMessages: () => {
    },
    flushCompactionQueue: async () => {
    },
    showStatus: () => {
    },
    showError: () => {
    },
    updatePendingMessagesDisplay: () => {
    },
    updateTerminalTitle: () => {
    },
    updateEditorBorderColor: () => {
    }
  };
  return host;
}
test("chat-controller renders content blocks in content[] index order (tool-first stream)", async () => {
  globalThis[Symbol.for("@gsd/pi-coding-agent:theme")] = {
    fg: (_key, text) => text,
    bg: (_key, text) => text,
    bold: (text) => text,
    italic: (text) => text,
    truncate: (text) => text
  };
  const host = createHost();
  const toolId = "mcp-tool-1";
  const toolCall = {
    type: "toolCall",
    id: toolId,
    name: "exec_command",
    arguments: { cmd: "echo hi" }
  };
  await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) });
  assert.equal(host.chatContainer.children.length, 0, "nothing should render before content arrives");
  await handleAgentEvent(
    host,
    {
      type: "message_update",
      message: makeAssistant([toolCall]),
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: {
          ...toolCall,
          externalResult: {
            content: [{ type: "text", text: "tool output" }],
            details: {},
            isError: false
          }
        },
        partial: makeAssistant([toolCall])
      }
    }
  );
  assert.equal(host.chatContainer.children.length, 1, "tool execution block should render immediately");
  assert.equal(host.chatContainer.children[0]?.constructor?.name, "ToolExecutionComponent");
  host.getMarkdownThemeWithSettings = () => ({});
  await handleAgentEvent(
    host,
    {
      type: "message_update",
      message: makeAssistant([toolCall, { type: "text", text: "done" }]),
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 1,
        delta: "done",
        partial: makeAssistant([toolCall, { type: "text", text: "done" }])
      }
    }
  );
  assert.equal(host.chatContainer.children.length, 2, "text run should render after tool in content[] order");
  assert.equal(host.chatContainer.children[0]?.constructor?.name, "ToolExecutionComponent");
  assert.equal(host.chatContainer.children[1]?.constructor?.name, "AssistantMessageComponent");
});
test("chat-controller renders serverToolUse before trailing text matching content[] index order", async () => {
  globalThis[Symbol.for("@gsd/pi-coding-agent:theme")] = {
    fg: (_key, text) => text,
    bg: (_key, text) => text,
    bold: (text) => text,
    italic: (text) => text,
    truncate: (text) => text
  };
  const host = createHost();
  const toolId = "mcp-secure-1";
  const serverToolUse = {
    type: "serverToolUse",
    id: toolId,
    name: "mcp__gsd-workflow__secure_env_collect",
    input: { projectDir: "/tmp/project", keys: [{ key: "SECURE_PASSWORD" }], destination: "dotenv" }
  };
  await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) });
  await handleAgentEvent(
    host,
    {
      type: "message_update",
      message: makeAssistant([serverToolUse]),
      assistantMessageEvent: {
        type: "server_tool_use",
        contentIndex: 0,
        partial: makeAssistant([serverToolUse])
      }
    }
  );
  assert.equal(host.chatContainer.children.length, 1, "server tool block should render immediately");
  assert.equal(host.chatContainer.children[0]?.constructor?.name, "ToolExecutionComponent");
  host.getMarkdownThemeWithSettings = () => ({});
  const resultMessage = makeAssistant([
    {
      ...serverToolUse,
      externalResult: {
        content: [{ type: "text", text: "secure_env_collect was cancelled by user." }],
        details: {},
        isError: true
      }
    },
    { type: "text", text: "The secure password collection was cancelled." }
  ]);
  await handleAgentEvent(
    host,
    {
      type: "message_update",
      message: resultMessage,
      assistantMessageEvent: {
        type: "server_tool_use",
        contentIndex: 0,
        partial: resultMessage
      }
    }
  );
  assert.equal(host.chatContainer.children.length, 2, "text run should render after server tool in content[] order");
  assert.equal(host.chatContainer.children[0]?.constructor?.name, "ToolExecutionComponent");
  assert.equal(host.chatContainer.children[1]?.constructor?.name, "AssistantMessageComponent");
});
test("chat-controller replays final message_end content when result adds unstreamed trailing text", async () => {
  globalThis[Symbol.for("@gsd/pi-coding-agent:theme")] = {
    fg: (_key, text) => text,
    bg: (_key, text) => text,
    bold: (text) => text,
    italic: (text) => text,
    truncate: (text) => text
  };
  const host = createHost();
  host.getMarkdownThemeWithSettings = () => ({});
  const tool = {
    type: "toolCall",
    id: "mcp-end-replay-1",
    name: "read",
    mcpServer: "filesystem",
    arguments: { filePath: "/tmp/demo.txt" }
  };
  await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) });
  const streamedContent = [
    tool,
    { type: "thinking", thinking: "I am analyzing tool output..." }
  ];
  await handleAgentEvent(
    host,
    {
      type: "message_update",
      message: makeAssistant(streamedContent),
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 1,
        delta: "I am analyzing tool output...",
        partial: makeAssistant(streamedContent)
      }
    }
  );
  assert.equal(host.chatContainer.children.length, 2, "streaming shows tool + thinking only");
  assert.equal(host.chatContainer.children[0]?.constructor?.name, "ToolExecutionComponent");
  assert.equal(host.chatContainer.children[1]?.constructor?.name, "AssistantMessageComponent");
  const finalContent = [
    tool,
    { type: "thinking", thinking: "I am analyzing tool output..." },
    { type: "text", text: "Correct anything important I missed?" }
  ];
  await handleAgentEvent(host, { type: "message_end", message: makeAssistant(finalContent) });
  assert.equal(host.chatContainer.children.length, 3, "message_end should replay and include trailing text segment");
  assert.equal(host.chatContainer.children[0]?.constructor?.name, "ToolExecutionComponent");
  assert.equal(host.chatContainer.children[1]?.constructor?.name, "AssistantMessageComponent");
  assert.equal(host.chatContainer.children[2]?.constructor?.name, "AssistantMessageComponent");
});
test("chat-controller keeps pre-tool prose visible until post-tool prose arrives, then prunes it", async () => {
  globalThis[Symbol.for("@gsd/pi-coding-agent:theme")] = {
    fg: (_key, text) => text,
    bg: (_key, text) => text,
    bold: (text) => text,
    italic: (text) => text,
    truncate: (text) => text
  };
  const host = createHost();
  host.getMarkdownThemeWithSettings = () => ({});
  const mcpTool = {
    type: "toolCall",
    id: "mcp-tool-1",
    name: "read",
    mcpServer: "filesystem",
    arguments: { filePath: "/tmp/demo.txt" }
  };
  await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) });
  await handleAgentEvent(
    host,
    {
      type: "message_update",
      message: makeAssistant([{ type: "text", text: "Let me inspect the workspace first." }]),
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "Let me inspect the workspace first.",
        partial: makeAssistant([{ type: "text", text: "Let me inspect the workspace first." }])
      }
    }
  );
  assert.equal(host.chatContainer.children.length, 1);
  assert.equal(host.chatContainer.children[0]?.constructor?.name, "AssistantMessageComponent");
  await handleAgentEvent(
    host,
    {
      type: "message_update",
      message: makeAssistant([{ type: "text", text: "Let me inspect the workspace first." }, mcpTool]),
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: {
          ...mcpTool,
          externalResult: {
            content: [{ type: "text", text: "file preview" }],
            details: {},
            isError: false
          }
        },
        partial: makeAssistant([{ type: "text", text: "Let me inspect the workspace first." }, mcpTool])
      }
    }
  );
  assert.equal(host.chatContainer.children.length, 2, "pre-tool prose should remain during tool-only window");
  assert.equal(host.chatContainer.children[0]?.constructor?.name, "AssistantMessageComponent");
  assert.equal(host.chatContainer.children[1]?.constructor?.name, "ToolExecutionComponent");
  const finalContent = [
    { type: "text", text: "Let me inspect the workspace first." },
    mcpTool,
    { type: "text", text: "Which missing feature matters most to you?" }
  ];
  await handleAgentEvent(
    host,
    {
      type: "message_update",
      message: makeAssistant(finalContent),
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 2,
        delta: "Which missing feature matters most to you?",
        partial: makeAssistant(finalContent)
      }
    }
  );
  assert.equal(host.chatContainer.children.length, 2);
  assert.equal(host.chatContainer.children[0]?.constructor?.name, "ToolExecutionComponent");
  assert.equal(host.chatContainer.children[1]?.constructor?.name, "AssistantMessageComponent");
  await handleAgentEvent(host, { type: "message_end", message: makeAssistant(finalContent) });
});
test("chat-controller keeps pre-tool thinking visible for claude-code MCP turns without post-tool prose", async () => {
  globalThis[Symbol.for("@gsd/pi-coding-agent:theme")] = {
    fg: (_key, text) => text,
    bg: (_key, text) => text,
    bold: (text) => text,
    italic: (text) => text,
    truncate: (text) => text
  };
  const host = createHost();
  host.getMarkdownThemeWithSettings = () => ({});
  const mcpTool = {
    type: "toolCall",
    id: "mcp-tool-thinking-1",
    name: "read",
    mcpServer: "filesystem",
    arguments: { filePath: "/tmp/demo.txt" }
  };
  await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) });
  const thinkingOnly = [{ type: "thinking", thinking: "I should inspect the workspace." }];
  await handleAgentEvent(
    host,
    {
      type: "message_update",
      message: makeAssistant(thinkingOnly),
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "I should inspect the workspace.",
        partial: makeAssistant(thinkingOnly)
      }
    }
  );
  assert.equal(host.chatContainer.children.length, 1);
  assert.equal(host.chatContainer.children[0]?.constructor?.name, "AssistantMessageComponent");
  await handleAgentEvent(
    host,
    {
      type: "message_update",
      message: makeAssistant([thinkingOnly[0], mcpTool]),
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: {
          ...mcpTool,
          externalResult: {
            content: [{ type: "text", text: "file preview" }],
            details: {},
            isError: false
          }
        },
        partial: makeAssistant([thinkingOnly[0], mcpTool])
      }
    }
  );
  assert.equal(host.chatContainer.children.length, 2, "thinking should remain visible while only tool output is present");
  assert.equal(host.chatContainer.children[0]?.constructor?.name, "AssistantMessageComponent");
  assert.equal(host.chatContainer.children[1]?.constructor?.name, "ToolExecutionComponent");
  await handleAgentEvent(host, { type: "message_end", message: makeAssistant([thinkingOnly[0], mcpTool]) });
});
test("chat-controller keeps pre-tool question text for claude-code MCP when post-tool prose exists", async () => {
  globalThis[Symbol.for("@gsd/pi-coding-agent:theme")] = {
    fg: (_key, text) => text,
    bg: (_key, text) => text,
    bold: (text) => text,
    italic: (text) => text,
    truncate: (text) => text
  };
  const host = createHost();
  host.getMarkdownThemeWithSettings = () => ({});
  const mcpTool = {
    type: "toolCall",
    id: "mcp-tool-question-1",
    name: "glob",
    mcpServer: "filesystem",
    arguments: { pattern: "**/*" }
  };
  await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) });
  const questionText = { type: "text", text: "Which file should I inspect?" };
  await handleAgentEvent(
    host,
    {
      type: "message_update",
      message: makeAssistant([questionText]),
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: questionText.text,
        partial: makeAssistant([questionText])
      }
    }
  );
  await handleAgentEvent(
    host,
    {
      type: "message_update",
      message: makeAssistant([questionText, mcpTool]),
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: {
          ...mcpTool,
          externalResult: {
            content: [{ type: "text", text: "glob output" }],
            details: {},
            isError: false
          }
        },
        partial: makeAssistant([questionText, mcpTool])
      }
    }
  );
  const postTool = { type: "text", text: "I'll review that next." };
  const finalContent = [questionText, mcpTool, postTool];
  await handleAgentEvent(
    host,
    {
      type: "message_update",
      message: makeAssistant(finalContent),
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 2,
        delta: postTool.text,
        partial: makeAssistant(finalContent)
      }
    }
  );
  assert.equal(host.chatContainer.children.length, 3, "question text should remain alongside MCP tool and post-tool prose");
  assert.equal(host.chatContainer.children[0]?.constructor?.name, "AssistantMessageComponent", "pre-tool question stays visible");
  assert.equal(host.chatContainer.children[1]?.constructor?.name, "ToolExecutionComponent", "tool renders in the middle");
  assert.equal(host.chatContainer.children[2]?.constructor?.name, "AssistantMessageComponent", "post-tool prose renders last");
  await handleAgentEvent(host, { type: "message_end", message: makeAssistant(finalContent) });
});
test("chat-controller prunes orphaned provisional text after claude-code sub-turn shrink when MCP tools appear", async () => {
  globalThis[Symbol.for("@gsd/pi-coding-agent:theme")] = {
    fg: (_key, text) => text,
    bg: (_key, text) => text,
    bold: (text) => text,
    italic: (text) => text,
    truncate: (text) => text
  };
  const host = createHost();
  host.getMarkdownThemeWithSettings = () => ({});
  const mcpTool = {
    type: "toolCall",
    id: "mcp-tool-shrink-1",
    name: "glob",
    mcpServer: "filesystem",
    arguments: { pattern: "**/*" }
  };
  await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) });
  await handleAgentEvent(
    host,
    {
      type: "message_update",
      message: makeAssistant([{ type: "text", text: "Old provisional preface." }, { type: "text", text: "More old text." }]),
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 1,
        delta: "More old text.",
        partial: makeAssistant([{ type: "text", text: "Old provisional preface." }, { type: "text", text: "More old text." }])
      }
    }
  );
  assert.equal(host.chatContainer.children.length, 1, "first sub-turn text run should render");
  await handleAgentEvent(
    host,
    {
      type: "message_update",
      message: makeAssistant([{ type: "text", text: "New provisional text before tool." }]),
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "New provisional text before tool.",
        partial: makeAssistant([{ type: "text", text: "New provisional text before tool." }])
      }
    }
  );
  assert.equal(host.chatContainer.children.length, 2, "shrink keeps prior text until MCP tool context appears");
  await handleAgentEvent(
    host,
    {
      type: "message_update",
      message: makeAssistant([{ type: "text", text: "New provisional text before tool." }, mcpTool]),
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: {
          ...mcpTool,
          externalResult: {
            content: [{ type: "text", text: "glob output" }],
            details: {},
            isError: false
          }
        },
        partial: makeAssistant([{ type: "text", text: "New provisional text before tool." }, mcpTool])
      }
    }
  );
  assert.equal(host.chatContainer.children.length, 3, "stale text runs are deferred until post-tool prose arrives");
  assert.equal(host.chatContainer.children[0]?.constructor?.name, "AssistantMessageComponent");
  assert.equal(host.chatContainer.children[1]?.constructor?.name, "AssistantMessageComponent");
  assert.equal(host.chatContainer.children[2]?.constructor?.name, "ToolExecutionComponent");
  const finalContent = [mcpTool, { type: "text", text: "Final visible question?" }];
  await handleAgentEvent(
    host,
    {
      type: "message_update",
      message: makeAssistant(finalContent),
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 1,
        delta: "Final visible question?",
        partial: makeAssistant(finalContent)
      }
    }
  );
  assert.equal(host.chatContainer.children.length, 2);
  assert.equal(host.chatContainer.children[0]?.constructor?.name, "ToolExecutionComponent");
  assert.equal(host.chatContainer.children[1]?.constructor?.name, "AssistantMessageComponent");
  await handleAgentEvent(host, { type: "message_end", message: makeAssistant(finalContent) });
});
test("chat-controller prunes orphans from multiple sub-turn shrinks before MCP post-tool prose", async () => {
  globalThis[Symbol.for("@gsd/pi-coding-agent:theme")] = {
    fg: (_key, text) => text,
    bg: (_key, text) => text,
    bold: (text) => text,
    italic: (text) => text,
    truncate: (text) => text
  };
  const host = createHost();
  host.getMarkdownThemeWithSettings = () => ({});
  const mcpTool = {
    type: "toolCall",
    id: "mcp-tool-multi-shrink-1",
    name: "glob",
    mcpServer: "filesystem",
    arguments: { pattern: "**/*" }
  };
  await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) });
  const subTurn1 = [
    { type: "text", text: "First provisional A." },
    { type: "text", text: "First provisional B." },
    { type: "text", text: "First provisional C." }
  ];
  await handleAgentEvent(
    host,
    {
      type: "message_update",
      message: makeAssistant(subTurn1),
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 2,
        delta: "First provisional C.",
        partial: makeAssistant(subTurn1)
      }
    }
  );
  assert.equal(host.chatContainer.children.length, 1, "first sub-turn renders 1 text-run");
  const subTurn2 = [
    { type: "text", text: "Second provisional A." },
    { type: "text", text: "Second provisional B." }
  ];
  await handleAgentEvent(
    host,
    {
      type: "message_update",
      message: makeAssistant(subTurn2),
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 1,
        delta: "Second provisional B.",
        partial: makeAssistant(subTurn2)
      }
    }
  );
  assert.equal(host.chatContainer.children.length, 2, "first shrink appends, keeps prior text as frozen history");
  const subTurn3 = [{ type: "text", text: "Third provisional." }];
  await handleAgentEvent(
    host,
    {
      type: "message_update",
      message: makeAssistant(subTurn3),
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "Third provisional.",
        partial: makeAssistant(subTurn3)
      }
    }
  );
  assert.equal(host.chatContainer.children.length, 3, "second shrink appends again, still no prune (no post-tool text)");
  await handleAgentEvent(
    host,
    {
      type: "message_update",
      message: makeAssistant([{ type: "text", text: "Third provisional." }, mcpTool]),
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: {
          ...mcpTool,
          externalResult: {
            content: [{ type: "text", text: "glob output" }],
            details: {},
            isError: false
          }
        },
        partial: makeAssistant([{ type: "text", text: "Third provisional." }, mcpTool])
      }
    }
  );
  assert.equal(host.chatContainer.children.length, 4, "tool-only window keeps all three provisional text-runs");
  const finalContent = [mcpTool, { type: "text", text: "Final answer." }];
  await handleAgentEvent(
    host,
    {
      type: "message_update",
      message: makeAssistant(finalContent),
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 1,
        delta: "Final answer.",
        partial: makeAssistant(finalContent)
      }
    }
  );
  assert.equal(
    host.chatContainer.children.length,
    2,
    "all pre-tool provisional segments from every shrink must be pruned once post-tool prose arrives"
  );
  assert.equal(host.chatContainer.children[0]?.constructor?.name, "ToolExecutionComponent");
  assert.equal(host.chatContainer.children[1]?.constructor?.name, "AssistantMessageComponent");
  await handleAgentEvent(host, { type: "message_end", message: makeAssistant(finalContent) });
});
test("chat-controller pins latest assistant text above editor when tool calls are present", async () => {
  globalThis[Symbol.for("@gsd/pi-coding-agent:theme")] = {
    fg: (_key, text) => text,
    bg: (_key, text) => text,
    bold: (text) => text,
    italic: (text) => text,
    truncate: (text) => text
  };
  const host = createHost();
  const toolId = "tool-pin-1";
  const toolCall = {
    type: "toolCall",
    id: toolId,
    name: "exec_command",
    arguments: { cmd: "echo hi" }
  };
  await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) });
  assert.equal(host.pinnedMessageContainer.children.length, 0, "pinned zone should be empty at message_start");
  host.getMarkdownThemeWithSettings = () => ({});
  await handleAgentEvent(
    host,
    {
      type: "message_update",
      message: makeAssistant([
        { type: "text", text: "Looking at the files now." },
        toolCall
      ]),
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: {
          ...toolCall,
          externalResult: {
            content: [{ type: "text", text: "file contents" }],
            details: {},
            isError: false
          }
        },
        partial: makeAssistant([{ type: "text", text: "Looking at the files now." }, toolCall])
      }
    }
  );
  assert.equal(host.pinnedMessageContainer.children.length, 2, "pinned zone should have border + markdown");
  assert.equal(host.pinnedMessageContainer.children[0]?.constructor?.name, "DynamicBorder");
  assert.equal(host.pinnedMessageContainer.children[1]?.constructor?.name, "Markdown");
});
test("chat-controller clears pinned zone when a new assistant message starts", async () => {
  globalThis[Symbol.for("@gsd/pi-coding-agent:theme")] = {
    fg: (_key, text) => text,
    bg: (_key, text) => text,
    bold: (text) => text,
    italic: (text) => text,
    truncate: (text) => text
  };
  const host = createHost();
  const toolCall = {
    type: "toolCall",
    id: "tool-clear-1",
    name: "exec_command",
    arguments: { cmd: "echo hi" }
  };
  await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) });
  host.getMarkdownThemeWithSettings = () => ({});
  await handleAgentEvent(
    host,
    {
      type: "message_update",
      message: makeAssistant([{ type: "text", text: "Working on it." }, toolCall]),
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: {
          ...toolCall,
          externalResult: {
            content: [{ type: "text", text: "ok" }],
            details: {},
            isError: false
          }
        },
        partial: makeAssistant([{ type: "text", text: "Working on it." }, toolCall])
      }
    }
  );
  assert.ok(host.pinnedMessageContainer.children.length > 0, "pinned zone should be populated");
  await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) });
  assert.equal(host.pinnedMessageContainer.children.length, 0, "pinned zone should clear on new assistant message");
});
test("chat-controller clears pinned zone when the agent turn ends", async () => {
  globalThis[Symbol.for("@gsd/pi-coding-agent:theme")] = {
    fg: (_key, text) => text,
    bg: (_key, text) => text,
    bold: (text) => text,
    italic: (text) => text,
    truncate: (text) => text
  };
  const host = createHost();
  const toolCall = {
    type: "toolCall",
    id: "tool-clear-on-end-1",
    name: "exec_command",
    arguments: { cmd: "echo hi" }
  };
  await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) });
  host.getMarkdownThemeWithSettings = () => ({});
  await handleAgentEvent(
    host,
    {
      type: "message_update",
      message: makeAssistant([{ type: "text", text: "Working on it." }, toolCall]),
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: {
          ...toolCall,
          externalResult: {
            content: [{ type: "text", text: "ok" }],
            details: {},
            isError: false
          }
        },
        partial: makeAssistant([{ type: "text", text: "Working on it." }, toolCall])
      }
    }
  );
  assert.ok(host.pinnedMessageContainer.children.length > 0, "pinned zone should be populated before agent_end");
  await handleAgentEvent(host, { type: "agent_end" });
  assert.equal(host.pinnedMessageContainer.children.length, 0, "pinned zone should clear on agent_end");
});
test("chat-controller clears pinned zone when assistant message ends", async () => {
  globalThis[Symbol.for("@gsd/pi-coding-agent:theme")] = {
    fg: (_key, text) => text,
    bg: (_key, text) => text,
    bold: (text) => text,
    italic: (text) => text,
    truncate: (text) => text
  };
  const host = createHost();
  const toolCall = {
    type: "toolCall",
    id: "tool-msg-end-1",
    name: "exec_command",
    arguments: { cmd: "echo hi" }
  };
  await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) });
  host.getMarkdownThemeWithSettings = () => ({});
  const msgContent = [{ type: "text", text: "Summary after tools." }, toolCall];
  await handleAgentEvent(
    host,
    {
      type: "message_update",
      message: makeAssistant(msgContent),
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: {
          ...toolCall,
          externalResult: {
            content: [{ type: "text", text: "ok" }],
            details: {},
            isError: false
          }
        },
        partial: makeAssistant(msgContent)
      }
    }
  );
  assert.ok(host.pinnedMessageContainer.children.length > 0, "pinned zone should be populated during streaming");
  await handleAgentEvent(host, { type: "message_end", message: makeAssistant(msgContent) });
  assert.equal(host.pinnedMessageContainer.children.length, 0, "pinned zone should clear on message_end to prevent duplicate display");
});
test("chat-controller does not pin when there are no tool calls", async () => {
  globalThis[Symbol.for("@gsd/pi-coding-agent:theme")] = {
    fg: (_key, text) => text,
    bg: (_key, text) => text,
    bold: (text) => text,
    italic: (text) => text,
    truncate: (text) => text
  };
  const host = createHost();
  await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) });
  host.getMarkdownThemeWithSettings = () => ({});
  await handleAgentEvent(
    host,
    {
      type: "message_update",
      message: makeAssistant([{ type: "text", text: "Just some text, no tools." }]),
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "Just some text, no tools.",
        partial: makeAssistant([{ type: "text", text: "Just some text, no tools." }])
      }
    }
  );
  assert.equal(host.pinnedMessageContainer.children.length, 0, "pinned zone should stay empty without tool calls");
});
test("chat-controller rolls up only contiguous low-signal tool runs on message_end", async () => {
  globalThis[Symbol.for("@gsd/pi-coding-agent:theme")] = {
    fg: (_key, text2) => text2,
    bg: (_key, text2) => text2,
    bold: (text2) => text2,
    italic: (text2) => text2,
    truncate: (text2) => text2
  };
  const host = createHost();
  host.getMarkdownThemeWithSettings = () => ({});
  const t1 = { type: "toolCall", id: "t1", name: "bash", arguments: { command: "true" } };
  const t2 = { type: "toolCall", id: "t2", name: "bash", arguments: { command: "true" } };
  const text = { type: "text", text: "middle output" };
  const t3 = { type: "toolCall", id: "t3", name: "read", arguments: { path: "/tmp/a" } };
  const t4 = { type: "toolCall", id: "t4", name: "read", arguments: { path: "/tmp/b" } };
  const content = [t1, t2, text, t3, t4];
  await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) });
  await handleAgentEvent(host, {
    type: "message_update",
    message: makeAssistant(content),
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 2,
      delta: text.text,
      partial: makeAssistant(content)
    }
  });
  for (const tool of [t1, t2, t3, t4]) {
    await handleAgentEvent(host, {
      type: "tool_execution_end",
      toolCallId: tool.id,
      isError: false,
      result: { content: [], details: {} }
    });
  }
  await handleAgentEvent(host, { type: "message_end", message: makeAssistant(content) });
  assert.equal(host.chatContainer.children.length, 3, "two separated tool runs should become two summaries around text");
  assert.equal(host.chatContainer.children[0]?.constructor?.name, "ToolPhaseSummaryComponent");
  assert.equal(host.chatContainer.children[1]?.constructor?.name, "AssistantMessageComponent");
  assert.equal(host.chatContainer.children[2]?.constructor?.name, "ToolPhaseSummaryComponent");
  assert.match(host.chatContainer.children[0].render(120).join("\n"), /Setup \/ shell 2 actions/);
  const readSummary = host.chatContainer.children[2].render(120).join("\n");
  assert.match(readSummary, /Context reads · 2 files/);
  assert.match(readSummary, /\/tmp\/a · \/tmp\/b/);
  assert.equal(host.chatContainer._prevRender, null, "summary reposition must invalidate the chat container render cache");
});
test("chat-controller rolls up low-signal direct tool execution events on agent_end", async () => {
  globalThis[Symbol.for("@gsd/pi-coding-agent:theme")] = {
    fg: (_key, text) => text,
    bg: (_key, text) => text,
    bold: (text) => text,
    italic: (text) => text,
    truncate: (text) => text
  };
  const host = createHost();
  host.getMarkdownThemeWithSettings = () => ({});
  for (const toolCallId of ["bash-1", "bash-2", "bash-3"]) {
    await handleAgentEvent(host, {
      type: "tool_execution_start",
      toolCallId,
      toolName: "bash",
      args: { command: "true" }
    });
    await handleAgentEvent(host, {
      type: "tool_execution_end",
      toolCallId,
      isError: false,
      result: { content: [], details: {} }
    });
  }
  assert.equal(host.chatContainer.children.length, 1, "direct tool events roll up as they finish");
  assert.equal(host.chatContainer.children[0]?.constructor?.name, "ToolPhaseSummaryComponent");
  assert.match(host.chatContainer.children[0].render(120).join("\n"), /Setup \/ shell 3 actions/);
  await handleAgentEvent(host, { type: "agent_end" });
  assert.equal(host.chatContainer.children.length, 1, "direct low-signal tool rows should roll up on agent_end");
  assert.equal(host.chatContainer.children[0]?.constructor?.name, "ToolPhaseSummaryComponent");
  assert.match(host.chatContainer.children[0].render(120).join("\n"), /Setup \/ shell 3 actions/);
});
test("chat-controller renders interleaved text and tool blocks in content[] index order (#4144)", async () => {
  globalThis[Symbol.for("@gsd/pi-coding-agent:theme")] = {
    fg: (_key, text) => text,
    bg: (_key, text) => text,
    bold: (text) => text,
    italic: (text) => text,
    truncate: (text) => text
  };
  const host = createHost();
  host.getMarkdownThemeWithSettings = () => ({});
  const t1 = { type: "toolCall", id: "t1", name: "tool_one", arguments: {} };
  const t2 = { type: "toolCall", id: "t2", name: "tool_two", arguments: {} };
  await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) });
  await handleAgentEvent(host, {
    type: "message_update",
    message: makeAssistant([{ type: "text", text: "A" }]),
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "A",
      partial: makeAssistant([{ type: "text", text: "A" }])
    }
  });
  await handleAgentEvent(host, {
    type: "message_update",
    message: makeAssistant([{ type: "text", text: "A" }, t1]),
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 1,
      toolCall: {
        ...t1,
        externalResult: { content: [{ type: "text", text: "result1" }], details: {}, isError: false }
      },
      partial: makeAssistant([{ type: "text", text: "A" }, t1])
    }
  });
  await handleAgentEvent(host, {
    type: "message_update",
    message: makeAssistant([{ type: "text", text: "A" }, t1, { type: "text", text: "B" }]),
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 2,
      delta: "B",
      partial: makeAssistant([{ type: "text", text: "A" }, t1, { type: "text", text: "B" }])
    }
  });
  await handleAgentEvent(host, {
    type: "message_update",
    message: makeAssistant([{ type: "text", text: "A" }, t1, { type: "text", text: "B" }, t2]),
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 3,
      toolCall: {
        ...t2,
        externalResult: { content: [{ type: "text", text: "result2" }], details: {}, isError: false }
      },
      partial: makeAssistant([{ type: "text", text: "A" }, t1, { type: "text", text: "B" }, t2])
    }
  });
  const finalContent = [
    { type: "text", text: "A" },
    t1,
    { type: "text", text: "B" },
    t2,
    { type: "text", text: "C" }
  ];
  await handleAgentEvent(host, {
    type: "message_update",
    message: makeAssistant(finalContent),
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 4,
      delta: "C",
      partial: makeAssistant(finalContent)
    }
  });
  await handleAgentEvent(host, { type: "message_end", message: makeAssistant(finalContent) });
  assert.equal(host.chatContainer.children.length, 5, "should have 5 children in interleaved order");
  assert.equal(host.chatContainer.children[0]?.constructor?.name, "AssistantMessageComponent", "index 0: text run A");
  assert.equal(host.chatContainer.children[1]?.constructor?.name, "ToolExecutionComponent", "index 1: tool T1");
  assert.equal(host.chatContainer.children[2]?.constructor?.name, "AssistantMessageComponent", "index 2: text run B");
  assert.equal(host.chatContainer.children[3]?.constructor?.name, "ToolExecutionComponent", "index 3: tool T2");
  assert.equal(host.chatContainer.children[4]?.constructor?.name, "AssistantMessageComponent", "index 4: text run C");
  function getRenderedTexts(comp) {
    const contentContainer = comp.children?.[0];
    if (!contentContainer) return [];
    return (contentContainer.children ?? []).filter((c) => c.constructor?.name === "Markdown").map((c) => c.text);
  }
  assert.deepEqual(getRenderedTexts(host.chatContainer.children[0]), ["A"], "text run A must contain only 'A'");
  assert.deepEqual(getRenderedTexts(host.chatContainer.children[2]), ["B"], "text run B must contain only 'B'");
  assert.deepEqual(getRenderedTexts(host.chatContainer.children[4]), ["C"], "text run C must contain only 'C'");
});
test("chat-controller does not duplicate text when content is [text, tool, text] (interleaved stream)", async () => {
  globalThis[Symbol.for("@gsd/pi-coding-agent:theme")] = {
    fg: (_key, text) => text,
    bg: (_key, text) => text,
    bold: (text) => text,
    italic: (text) => text,
    truncate: (text) => text
  };
  const host = createHost();
  host.getMarkdownThemeWithSettings = () => ({});
  const t1 = { type: "toolCall", id: "t1", name: "tool_one", arguments: {} };
  await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) });
  await handleAgentEvent(host, {
    type: "message_update",
    message: makeAssistant([{ type: "text", text: "A" }]),
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "A",
      partial: makeAssistant([{ type: "text", text: "A" }])
    }
  });
  await handleAgentEvent(host, {
    type: "message_update",
    message: makeAssistant([{ type: "text", text: "A" }, t1]),
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 1,
      toolCall: {
        ...t1,
        externalResult: { content: [{ type: "text", text: "result1" }], details: {}, isError: false }
      },
      partial: makeAssistant([{ type: "text", text: "A" }, t1])
    }
  });
  const finalContent = [{ type: "text", text: "A" }, t1, { type: "text", text: "B" }];
  await handleAgentEvent(host, {
    type: "message_update",
    message: makeAssistant(finalContent),
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 2,
      delta: "B",
      partial: makeAssistant(finalContent)
    }
  });
  assert.equal(host.chatContainer.children.length, 3);
  assert.equal(host.chatContainer.children[0]?.constructor?.name, "AssistantMessageComponent");
  assert.equal(host.chatContainer.children[1]?.constructor?.name, "ToolExecutionComponent");
  assert.equal(host.chatContainer.children[2]?.constructor?.name, "AssistantMessageComponent");
  const firstText = host.chatContainer.children[0];
  const secondText = host.chatContainer.children[2];
  assert.notEqual(firstText, secondText, "text-before-tool and text-after-tool must be separate component instances");
  assert.deepEqual(firstText.range, { startIndex: 0, endIndex: 0 }, "first text-run covers only content[0]");
  assert.deepEqual(secondText.range, { startIndex: 2, endIndex: 2 }, "second text-run covers only content[2]");
  await handleAgentEvent(host, { type: "message_end", message: makeAssistant(finalContent) });
  assert.deepEqual(secondText.range, { startIndex: 2, endIndex: 2 }, "range must not be cleared on message_end (would cause duplication)");
});
test("chat-controller freezes prior sub-turn and appends new segments when content shrinks", async () => {
  globalThis[Symbol.for("@gsd/pi-coding-agent:theme")] = {
    fg: (_key, text) => text,
    bg: (_key, text) => text,
    bold: (text) => text,
    italic: (text) => text,
    truncate: (text) => text
  };
  const host = createHost();
  host.getMarkdownThemeWithSettings = () => ({});
  const t1 = { type: "toolCall", id: "t1", name: "tool_one", arguments: {} };
  const t2 = { type: "toolCall", id: "t2", name: "tool_two", arguments: {} };
  await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) });
  await handleAgentEvent(host, {
    type: "message_update",
    message: makeAssistant([{ type: "text", text: "A" }]),
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "A",
      partial: makeAssistant([{ type: "text", text: "A" }])
    }
  });
  await handleAgentEvent(host, {
    type: "message_update",
    message: makeAssistant([{ type: "text", text: "A" }, t1]),
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 1,
      toolCall: { ...t1, externalResult: { content: [{ type: "text", text: "r1" }], details: {}, isError: false } },
      partial: makeAssistant([{ type: "text", text: "A" }, t1])
    }
  });
  await handleAgentEvent(host, {
    type: "message_update",
    message: makeAssistant([{ type: "text", text: "A" }, t1, { type: "text", text: "B" }]),
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 2,
      delta: "B",
      partial: makeAssistant([{ type: "text", text: "A" }, t1, { type: "text", text: "B" }])
    }
  });
  assert.equal(host.chatContainer.children.length, 3, "sub-turn 1 renders 3 children");
  const priorA = host.chatContainer.children[0];
  const priorT1 = host.chatContainer.children[1];
  const priorB = host.chatContainer.children[2];
  await handleAgentEvent(host, {
    type: "message_update",
    message: makeAssistant([{ type: "text", text: "C" }]),
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "C",
      partial: makeAssistant([{ type: "text", text: "C" }])
    }
  });
  assert.equal(host.chatContainer.children.length, 4, "shrink must append new segment, not replace prior history");
  assert.equal(host.chatContainer.children[0], priorA, "prior A component stays at index 0");
  assert.equal(host.chatContainer.children[1], priorT1, "prior T1 component stays at index 1");
  assert.equal(host.chatContainer.children[2], priorB, "prior B component stays at index 2");
  assert.notEqual(host.chatContainer.children[3], priorA, "new C text-run must be a different component from prior A");
  assert.equal(host.chatContainer.children[3]?.constructor?.name, "AssistantMessageComponent");
  function getRenderedTexts(comp) {
    const contentContainer = comp.children?.[0];
    if (!contentContainer) return [];
    return (contentContainer.children ?? []).filter((c) => c.constructor?.name === "Markdown").map((c) => c.text);
  }
  assert.deepEqual(getRenderedTexts(priorA), ["A"], "prior A text-run must still contain 'A' after shrink");
  assert.deepEqual(getRenderedTexts(priorB), ["B"], "prior B text-run must still contain 'B' after shrink");
  assert.deepEqual(getRenderedTexts(host.chatContainer.children[3]), ["C"], "new text-run must contain only 'C'");
  await handleAgentEvent(host, {
    type: "message_update",
    message: makeAssistant([{ type: "text", text: "C" }, t2]),
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 1,
      toolCall: { ...t2, externalResult: { content: [{ type: "text", text: "r2" }], details: {}, isError: false } },
      partial: makeAssistant([{ type: "text", text: "C" }, t2])
    }
  });
  assert.equal(host.chatContainer.children.length, 5, "new tool appends after new text-run");
  assert.equal(host.chatContainer.children[4]?.constructor?.name, "ToolExecutionComponent");
  assert.notEqual(host.chatContainer.children[4], priorT1, "new T2 must be a different component from prior T1");
  await handleAgentEvent(host, { type: "message_end", message: makeAssistant([{ type: "text", text: "C" }, t2]) });
});
test("chat-controller updates pinned zone after sub-turn shrink", async () => {
  globalThis[Symbol.for("@gsd/pi-coding-agent:theme")] = {
    fg: (_key, text) => text,
    bg: (_key, text) => text,
    bold: (text) => text,
    italic: (text) => text,
    truncate: (text) => text
  };
  const host = createHost();
  host.getMarkdownThemeWithSettings = () => ({});
  const t1 = { type: "toolCall", id: "t1", name: "tool_one", arguments: {} };
  const t2 = { type: "toolCall", id: "t2", name: "tool_two", arguments: {} };
  await handleAgentEvent(host, { type: "message_start", message: makeAssistant([]) });
  await handleAgentEvent(host, {
    type: "message_update",
    message: makeAssistant([{ type: "text", text: "first" }, t1]),
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 1,
      toolCall: { ...t1, externalResult: { content: [{ type: "text", text: "r1" }], details: {}, isError: false } },
      partial: makeAssistant([{ type: "text", text: "first" }, t1])
    }
  });
  const pinnedMarkdown = host.pinnedMessageContainer.children[1];
  assert.equal(pinnedMarkdown?.text, "first", "pinned zone seeded with sub-turn 1 text");
  await handleAgentEvent(host, {
    type: "message_update",
    message: makeAssistant([{ type: "text", text: "second" }, t2]),
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 1,
      toolCall: { ...t2, externalResult: { content: [{ type: "text", text: "r2" }], details: {}, isError: false } },
      partial: makeAssistant([{ type: "text", text: "second" }, t2])
    }
  });
  assert.equal(pinnedMarkdown?.text, "second", "pinned zone must update after sub-turn shrink (#4144 regression)");
  await handleAgentEvent(host, { type: "message_end", message: makeAssistant([{ type: "text", text: "second" }, t2]) });
});
test("chat-controller: agent_end without message_end must not remove streaming component from DOM (regression #4197)", async () => {
  const host = createHost();
  await handleAgentEvent(host, {
    type: "message_start",
    message: makeAssistant([])
  });
  await handleAgentEvent(host, {
    type: "message_update",
    message: makeAssistant([{ type: "text", text: "partial answer" }]),
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "partial answer",
      partial: makeAssistant([{ type: "text", text: "partial answer" }])
    }
  });
  assert.equal(
    host.chatContainer.children.length,
    1,
    "streaming component must be in DOM after message_update"
  );
  const comp = host.chatContainer.children[0];
  await handleAgentEvent(host, { type: "agent_end" });
  assert.equal(
    host.chatContainer.children.length,
    1,
    "agent_end must NOT remove the streaming component from the DOM (issue #4197)"
  );
  assert.equal(
    host.chatContainer.children[0],
    comp,
    "the same component instance must remain in the DOM after agent_end"
  );
});
test("chat-controller: agent_end after message_end must not alter DOM", async () => {
  const host = createHost();
  const content = [{ type: "text", text: "complete answer" }];
  await handleAgentEvent(host, {
    type: "message_start",
    message: makeAssistant([])
  });
  await handleAgentEvent(host, {
    type: "message_update",
    message: makeAssistant(content),
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "complete answer",
      partial: makeAssistant(content)
    }
  });
  await handleAgentEvent(host, {
    type: "message_end",
    message: makeAssistant(content)
  });
  const countAfterMessageEnd = host.chatContainer.children.length;
  assert.ok(countAfterMessageEnd > 0, "component must be present after message_end");
  await handleAgentEvent(host, { type: "agent_end" });
  assert.equal(
    host.chatContainer.children.length,
    countAfterMessageEnd,
    "agent_end after message_end must not add or remove DOM nodes"
  );
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL2NoYXQtY29udHJvbGxlci1vcmRlcmluZy50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IHRlc3QgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5cbmltcG9ydCB7IGhhbmRsZUFnZW50RXZlbnQgfSBmcm9tIFwiLi4vbW9kZXMvaW50ZXJhY3RpdmUvY29udHJvbGxlcnMvY2hhdC1jb250cm9sbGVyLmpzXCI7XG5cbmZ1bmN0aW9uIG1ha2VVc2FnZSgpIHtcblx0cmV0dXJuIHtcblx0XHRpbnB1dDogMCxcblx0XHRvdXRwdXQ6IDAsXG5cdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0dG90YWxUb2tlbnM6IDAsXG5cdFx0Y29zdDogeyBpbnB1dDogMCwgb3V0cHV0OiAwLCBjYWNoZVJlYWQ6IDAsIGNhY2hlV3JpdGU6IDAsIHRvdGFsOiAwIH0sXG5cdH07XG59XG5cbmZ1bmN0aW9uIG1ha2VBc3Npc3RhbnQoY29udGVudDogYW55W10pIHtcblx0cmV0dXJuIHtcblx0XHRyb2xlOiBcImFzc2lzdGFudFwiLFxuXHRcdGNvbnRlbnQsXG5cdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdHByb3ZpZGVyOiBcImNsYXVkZS1jb2RlXCIsXG5cdFx0bW9kZWw6IFwiY2xhdWRlLXNvbm5ldC00XCIsXG5cdFx0dXNhZ2U6IG1ha2VVc2FnZSgpLFxuXHRcdHN0b3BSZWFzb246IFwic3RvcFwiLFxuXHRcdHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcblx0fTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlSG9zdCgpIHtcblx0Y29uc3QgY2hhdENvbnRhaW5lciA9IHtcblx0XHRjaGlsZHJlbjogW10gYXMgYW55W10sXG5cdFx0YWRkQ2hpbGQoY29tcG9uZW50OiBhbnkpIHtcblx0XHRcdHRoaXMuY2hpbGRyZW4ucHVzaChjb21wb25lbnQpO1xuXHRcdH0sXG5cdFx0cmVtb3ZlQ2hpbGQoY29tcG9uZW50OiBhbnkpIHtcblx0XHRcdGNvbnN0IGlkeCA9IHRoaXMuY2hpbGRyZW4uaW5kZXhPZihjb21wb25lbnQpO1xuXHRcdFx0aWYgKGlkeCAhPT0gLTEpIHRoaXMuY2hpbGRyZW4uc3BsaWNlKGlkeCwgMSk7XG5cdFx0fSxcblx0XHRjbGVhcigpIHtcblx0XHRcdHRoaXMuY2hpbGRyZW4gPSBbXTtcblx0XHR9LFxuXHR9O1xuXG5cdGNvbnN0IHBpbm5lZE1lc3NhZ2VDb250YWluZXIgPSB7XG5cdFx0Y2hpbGRyZW46IFtdIGFzIGFueVtdLFxuXHRcdGFkZENoaWxkKGNvbXBvbmVudDogYW55KSB7XG5cdFx0XHR0aGlzLmNoaWxkcmVuLnB1c2goY29tcG9uZW50KTtcblx0XHR9LFxuXHRcdHJlbW92ZUNoaWxkKGNvbXBvbmVudDogYW55KSB7XG5cdFx0XHRjb25zdCBpZHggPSB0aGlzLmNoaWxkcmVuLmluZGV4T2YoY29tcG9uZW50KTtcblx0XHRcdGlmIChpZHggIT09IC0xKSB0aGlzLmNoaWxkcmVuLnNwbGljZShpZHgsIDEpO1xuXHRcdH0sXG5cdFx0Y2xlYXIoKSB7XG5cdFx0XHR0aGlzLmNoaWxkcmVuID0gW107XG5cdFx0fSxcblx0fTtcblxuXHRjb25zdCBob3N0OiBhbnkgPSB7XG5cdFx0aXNJbml0aWFsaXplZDogdHJ1ZSxcblx0XHRpbml0OiBhc3luYyAoKSA9PiB7fSxcblx0XHRkZWZhdWx0RWRpdG9yOiB7IG9uRXNjYXBlOiB1bmRlZmluZWQgfSxcblx0XHRlZGl0b3I6IHt9LFxuXHRcdHNlc3Npb246IHsgcmV0cnlBdHRlbXB0OiAwLCBhYm9ydENvbXBhY3Rpb246ICgpID0+IHt9LCBhYm9ydFJldHJ5OiAoKSA9PiB7fSB9LFxuXHRcdC8vIHJvd3M6MSBrZWVwcyB0aGUgcGlubmVkLXpvbmUgb2ZmLXNjcmVlbi10aHJlc2hvbGQgYXQgaXRzIGZsb29yICgxKSBzb1xuXHRcdC8vIGFueSByZW5kZXJlZCBzZWdtZW50IGFmdGVyIGEgcGlubmFibGUgdGV4dCBibG9jayB0cmlnZ2VycyB0aGUgcGluLlxuXHRcdC8vIFJlYWwgdGVybWluYWxzIGFyZSBsYXJnZXI7IHNlZSBjaGF0LWNvbnRyb2xsZXIgcm93c1JlbmRlcmVkQWZ0ZXJDb250ZW50SW5kZXguXG5cdFx0dWk6IHsgcmVxdWVzdFJlbmRlcjogKCkgPT4ge30sIHRlcm1pbmFsOiB7IHJvd3M6IDEsIGNvbHVtbnM6IDgwIH0gfSxcblx0XHRmb290ZXI6IHsgaW52YWxpZGF0ZTogKCkgPT4ge30gfSxcblx0XHRrZXliaW5kaW5nczoge30sXG5cdFx0c3RhdHVzQ29udGFpbmVyOiB7IGNsZWFyOiAoKSA9PiB7fSwgYWRkQ2hpbGQ6ICgpID0+IHt9IH0sXG5cdFx0Y2hhdENvbnRhaW5lcixcblx0XHRzZXR0aW5nc01hbmFnZXI6IHsgZ2V0VGltZXN0YW1wRm9ybWF0OiAoKSA9PiBcImRhdGUtdGltZS1pc29cIiwgZ2V0U2hvd0ltYWdlczogKCkgPT4gZmFsc2UgfSxcblx0XHRwZW5kaW5nVG9vbHM6IG5ldyBNYXAoKSxcblx0XHR0b29sT3V0cHV0RXhwYW5kZWQ6IGZhbHNlLFxuXHRcdGhpZGVUaGlua2luZ0Jsb2NrOiBmYWxzZSxcblx0XHRpc0Jhc2hNb2RlOiBmYWxzZSxcblx0XHRkZWZhdWx0V29ya2luZ01lc3NhZ2U6IFwiV29ya2luZy4uLlwiLFxuXHRcdGNvbXBhY3Rpb25RdWV1ZWRNZXNzYWdlczogW10sXG5cdFx0ZWRpdG9yQ29udGFpbmVyOiB7fSxcblx0XHRwZW5kaW5nTWVzc2FnZXNDb250YWluZXI6IHsgY2xlYXI6ICgpID0+IHt9IH0sXG5cdFx0cGlubmVkTWVzc2FnZUNvbnRhaW5lcixcblx0XHRhZGRNZXNzYWdlVG9DaGF0OiAoKSA9PiB7fSxcblx0XHRnZXRNYXJrZG93blRoZW1lV2l0aFNldHRpbmdzOiAoKSA9PiAoe30pLFxuXHRcdGZvcm1hdFdlYlNlYXJjaFJlc3VsdDogKCkgPT4gXCJcIixcblx0XHRnZXRSZWdpc3RlcmVkVG9vbERlZmluaXRpb246ICgpID0+IHVuZGVmaW5lZCxcblx0XHRjaGVja1NodXRkb3duUmVxdWVzdGVkOiBhc3luYyAoKSA9PiB7fSxcblx0XHRyZWJ1aWxkQ2hhdEZyb21NZXNzYWdlczogKCkgPT4ge30sXG5cdFx0Zmx1c2hDb21wYWN0aW9uUXVldWU6IGFzeW5jICgpID0+IHt9LFxuXHRcdHNob3dTdGF0dXM6ICgpID0+IHt9LFxuXHRcdHNob3dFcnJvcjogKCkgPT4ge30sXG5cdFx0dXBkYXRlUGVuZGluZ01lc3NhZ2VzRGlzcGxheTogKCkgPT4ge30sXG5cdFx0dXBkYXRlVGVybWluYWxUaXRsZTogKCkgPT4ge30sXG5cdFx0dXBkYXRlRWRpdG9yQm9yZGVyQ29sb3I6ICgpID0+IHt9LFxuXHR9O1xuXG5cdHJldHVybiBob3N0O1xufVxuXG50ZXN0KFwiY2hhdC1jb250cm9sbGVyIHJlbmRlcnMgY29udGVudCBibG9ja3MgaW4gY29udGVudFtdIGluZGV4IG9yZGVyICh0b29sLWZpcnN0IHN0cmVhbSlcIiwgYXN5bmMgKCkgPT4ge1xuXHQvLyBUb29sRXhlY3V0aW9uQ29tcG9uZW50IHVzZXMgdGhlIGdsb2JhbCB0aGVtZSBzaW5nbGV0b24uXG5cdC8vIEluc3RhbGwgYSBtaW5pbWFsIG5vLW9wIHRoZW1lIGltcGxlbWVudGF0aW9uIGZvciB0aGlzIHVuaXQgdGVzdC5cblx0KGdsb2JhbFRoaXMgYXMgYW55KVtTeW1ib2wuZm9yKFwiQGdzZC9waS1jb2RpbmctYWdlbnQ6dGhlbWVcIildID0ge1xuXHRcdGZnOiAoX2tleTogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG5cdFx0Ymc6IChfa2V5OiBzdHJpbmcsIHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0XHRib2xkOiAodGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuXHRcdGl0YWxpYzogKHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0XHR0cnVuY2F0ZTogKHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0fTtcblxuXHRjb25zdCBob3N0ID0gY3JlYXRlSG9zdCgpO1xuXHRjb25zdCB0b29sSWQgPSBcIm1jcC10b29sLTFcIjtcblx0Y29uc3QgdG9vbENhbGwgPSB7XG5cdFx0dHlwZTogXCJ0b29sQ2FsbFwiLFxuXHRcdGlkOiB0b29sSWQsXG5cdFx0bmFtZTogXCJleGVjX2NvbW1hbmRcIixcblx0XHRhcmd1bWVudHM6IHsgY21kOiBcImVjaG8gaGlcIiB9LFxuXHR9O1xuXG5cdGF3YWl0IGhhbmRsZUFnZW50RXZlbnQoaG9zdCwgeyB0eXBlOiBcIm1lc3NhZ2Vfc3RhcnRcIiwgbWVzc2FnZTogbWFrZUFzc2lzdGFudChbXSkgfSBhcyBhbnkpO1xuXG5cdGFzc2VydC5lcXVhbChob3N0LmNoYXRDb250YWluZXIuY2hpbGRyZW4ubGVuZ3RoLCAwLCBcIm5vdGhpbmcgc2hvdWxkIHJlbmRlciBiZWZvcmUgY29udGVudCBhcnJpdmVzXCIpO1xuXG5cdGF3YWl0IGhhbmRsZUFnZW50RXZlbnQoXG5cdFx0aG9zdCxcblx0XHR7XG5cdFx0XHR0eXBlOiBcIm1lc3NhZ2VfdXBkYXRlXCIsXG5cdFx0XHRtZXNzYWdlOiBtYWtlQXNzaXN0YW50KFt0b29sQ2FsbF0pLFxuXHRcdFx0YXNzaXN0YW50TWVzc2FnZUV2ZW50OiB7XG5cdFx0XHRcdHR5cGU6IFwidG9vbGNhbGxfZW5kXCIsXG5cdFx0XHRcdGNvbnRlbnRJbmRleDogMCxcblx0XHRcdFx0dG9vbENhbGw6IHtcblx0XHRcdFx0XHQuLi50b29sQ2FsbCxcblx0XHRcdFx0XHRleHRlcm5hbFJlc3VsdDoge1xuXHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwidG9vbCBvdXRwdXRcIiB9XSxcblx0XHRcdFx0XHRcdGRldGFpbHM6IHt9LFxuXHRcdFx0XHRcdFx0aXNFcnJvcjogZmFsc2UsXG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0fSxcblx0XHRcdFx0cGFydGlhbDogbWFrZUFzc2lzdGFudChbdG9vbENhbGxdKSxcblx0XHRcdH0sXG5cdFx0fSBhcyBhbnksXG5cdCk7XG5cblx0Ly8gY29udGVudFswXSA9IHRvb2xDYWxsIFx1MjE5MiBUb29sRXhlY3V0aW9uQ29tcG9uZW50IHJlbmRlcnMgZmlyc3Rcblx0YXNzZXJ0LmVxdWFsKGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlbi5sZW5ndGgsIDEsIFwidG9vbCBleGVjdXRpb24gYmxvY2sgc2hvdWxkIHJlbmRlciBpbW1lZGlhdGVseVwiKTtcblx0YXNzZXJ0LmVxdWFsKGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlblswXT8uY29uc3RydWN0b3I/Lm5hbWUsIFwiVG9vbEV4ZWN1dGlvbkNvbXBvbmVudFwiKTtcblxuXHRob3N0LmdldE1hcmtkb3duVGhlbWVXaXRoU2V0dGluZ3MgPSAoKSA9PiAoe30pO1xuXG5cdGF3YWl0IGhhbmRsZUFnZW50RXZlbnQoXG5cdFx0aG9zdCxcblx0XHR7XG5cdFx0XHR0eXBlOiBcIm1lc3NhZ2VfdXBkYXRlXCIsXG5cdFx0XHRtZXNzYWdlOiBtYWtlQXNzaXN0YW50KFt0b29sQ2FsbCwgeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJkb25lXCIgfV0pLFxuXHRcdFx0YXNzaXN0YW50TWVzc2FnZUV2ZW50OiB7XG5cdFx0XHRcdHR5cGU6IFwidGV4dF9kZWx0YVwiLFxuXHRcdFx0XHRjb250ZW50SW5kZXg6IDEsXG5cdFx0XHRcdGRlbHRhOiBcImRvbmVcIixcblx0XHRcdFx0cGFydGlhbDogbWFrZUFzc2lzdGFudChbdG9vbENhbGwsIHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiZG9uZVwiIH1dKSxcblx0XHRcdH0sXG5cdFx0fSBhcyBhbnksXG5cdCk7XG5cblx0Ly8gY29udGVudFswXT10b29sQ2FsbCwgY29udGVudFsxXT10ZXh0IFx1MjE5MiBvcmRlcjogdG9vbCwgdGhlbiB0ZXh0XG5cdGFzc2VydC5lcXVhbChob3N0LmNoYXRDb250YWluZXIuY2hpbGRyZW4ubGVuZ3RoLCAyLCBcInRleHQgcnVuIHNob3VsZCByZW5kZXIgYWZ0ZXIgdG9vbCBpbiBjb250ZW50W10gb3JkZXJcIik7XG5cdGFzc2VydC5lcXVhbChob3N0LmNoYXRDb250YWluZXIuY2hpbGRyZW5bMF0/LmNvbnN0cnVjdG9yPy5uYW1lLCBcIlRvb2xFeGVjdXRpb25Db21wb25lbnRcIik7XG5cdGFzc2VydC5lcXVhbChob3N0LmNoYXRDb250YWluZXIuY2hpbGRyZW5bMV0/LmNvbnN0cnVjdG9yPy5uYW1lLCBcIkFzc2lzdGFudE1lc3NhZ2VDb21wb25lbnRcIik7XG59KTtcblxudGVzdChcImNoYXQtY29udHJvbGxlciByZW5kZXJzIHNlcnZlclRvb2xVc2UgYmVmb3JlIHRyYWlsaW5nIHRleHQgbWF0Y2hpbmcgY29udGVudFtdIGluZGV4IG9yZGVyXCIsIGFzeW5jICgpID0+IHtcblx0KGdsb2JhbFRoaXMgYXMgYW55KVtTeW1ib2wuZm9yKFwiQGdzZC9waS1jb2RpbmctYWdlbnQ6dGhlbWVcIildID0ge1xuXHRcdGZnOiAoX2tleTogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG5cdFx0Ymc6IChfa2V5OiBzdHJpbmcsIHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0XHRib2xkOiAodGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuXHRcdGl0YWxpYzogKHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0XHR0cnVuY2F0ZTogKHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0fTtcblxuXHRjb25zdCBob3N0ID0gY3JlYXRlSG9zdCgpO1xuXHRjb25zdCB0b29sSWQgPSBcIm1jcC1zZWN1cmUtMVwiO1xuXHRjb25zdCBzZXJ2ZXJUb29sVXNlID0ge1xuXHRcdHR5cGU6IFwic2VydmVyVG9vbFVzZVwiLFxuXHRcdGlkOiB0b29sSWQsXG5cdFx0bmFtZTogXCJtY3BfX2dzZC13b3JrZmxvd19fc2VjdXJlX2Vudl9jb2xsZWN0XCIsXG5cdFx0aW5wdXQ6IHsgcHJvamVjdERpcjogXCIvdG1wL3Byb2plY3RcIiwga2V5czogW3sga2V5OiBcIlNFQ1VSRV9QQVNTV09SRFwiIH1dLCBkZXN0aW5hdGlvbjogXCJkb3RlbnZcIiB9LFxuXHR9O1xuXG5cdGF3YWl0IGhhbmRsZUFnZW50RXZlbnQoaG9zdCwgeyB0eXBlOiBcIm1lc3NhZ2Vfc3RhcnRcIiwgbWVzc2FnZTogbWFrZUFzc2lzdGFudChbXSkgfSBhcyBhbnkpO1xuXG5cdGF3YWl0IGhhbmRsZUFnZW50RXZlbnQoXG5cdFx0aG9zdCxcblx0XHR7XG5cdFx0XHR0eXBlOiBcIm1lc3NhZ2VfdXBkYXRlXCIsXG5cdFx0XHRtZXNzYWdlOiBtYWtlQXNzaXN0YW50KFtzZXJ2ZXJUb29sVXNlXSksXG5cdFx0XHRhc3Npc3RhbnRNZXNzYWdlRXZlbnQ6IHtcblx0XHRcdFx0dHlwZTogXCJzZXJ2ZXJfdG9vbF91c2VcIixcblx0XHRcdFx0Y29udGVudEluZGV4OiAwLFxuXHRcdFx0XHRwYXJ0aWFsOiBtYWtlQXNzaXN0YW50KFtzZXJ2ZXJUb29sVXNlXSksXG5cdFx0XHR9LFxuXHRcdH0gYXMgYW55LFxuXHQpO1xuXG5cdC8vIGNvbnRlbnRbMF0gPSBzZXJ2ZXJUb29sVXNlIFx1MjE5MiBUb29sRXhlY3V0aW9uQ29tcG9uZW50IHJlbmRlcnMgZmlyc3Rcblx0YXNzZXJ0LmVxdWFsKGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlbi5sZW5ndGgsIDEsIFwic2VydmVyIHRvb2wgYmxvY2sgc2hvdWxkIHJlbmRlciBpbW1lZGlhdGVseVwiKTtcblx0YXNzZXJ0LmVxdWFsKGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlblswXT8uY29uc3RydWN0b3I/Lm5hbWUsIFwiVG9vbEV4ZWN1dGlvbkNvbXBvbmVudFwiKTtcblxuXHRob3N0LmdldE1hcmtkb3duVGhlbWVXaXRoU2V0dGluZ3MgPSAoKSA9PiAoe30pO1xuXHRjb25zdCByZXN1bHRNZXNzYWdlID0gbWFrZUFzc2lzdGFudChbXG5cdFx0e1xuXHRcdFx0Li4uc2VydmVyVG9vbFVzZSxcblx0XHRcdGV4dGVybmFsUmVzdWx0OiB7XG5cdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcInNlY3VyZV9lbnZfY29sbGVjdCB3YXMgY2FuY2VsbGVkIGJ5IHVzZXIuXCIgfV0sXG5cdFx0XHRcdGRldGFpbHM6IHt9LFxuXHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0fSxcblx0XHR9LFxuXHRcdHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiVGhlIHNlY3VyZSBwYXNzd29yZCBjb2xsZWN0aW9uIHdhcyBjYW5jZWxsZWQuXCIgfSxcblx0XSk7XG5cblx0YXdhaXQgaGFuZGxlQWdlbnRFdmVudChcblx0XHRob3N0LFxuXHRcdHtcblx0XHRcdHR5cGU6IFwibWVzc2FnZV91cGRhdGVcIixcblx0XHRcdG1lc3NhZ2U6IHJlc3VsdE1lc3NhZ2UsXG5cdFx0XHRhc3Npc3RhbnRNZXNzYWdlRXZlbnQ6IHtcblx0XHRcdFx0dHlwZTogXCJzZXJ2ZXJfdG9vbF91c2VcIixcblx0XHRcdFx0Y29udGVudEluZGV4OiAwLFxuXHRcdFx0XHRwYXJ0aWFsOiByZXN1bHRNZXNzYWdlLFxuXHRcdFx0fSxcblx0XHR9IGFzIGFueSxcblx0KTtcblxuXHQvLyBjb250ZW50WzBdPXNlcnZlclRvb2xVc2UsIGNvbnRlbnRbMV09dGV4dCBcdTIxOTIgb3JkZXI6IHRvb2wsIHRoZW4gdGV4dFxuXHRhc3NlcnQuZXF1YWwoaG9zdC5jaGF0Q29udGFpbmVyLmNoaWxkcmVuLmxlbmd0aCwgMiwgXCJ0ZXh0IHJ1biBzaG91bGQgcmVuZGVyIGFmdGVyIHNlcnZlciB0b29sIGluIGNvbnRlbnRbXSBvcmRlclwiKTtcblx0YXNzZXJ0LmVxdWFsKGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlblswXT8uY29uc3RydWN0b3I/Lm5hbWUsIFwiVG9vbEV4ZWN1dGlvbkNvbXBvbmVudFwiKTtcblx0YXNzZXJ0LmVxdWFsKGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlblsxXT8uY29uc3RydWN0b3I/Lm5hbWUsIFwiQXNzaXN0YW50TWVzc2FnZUNvbXBvbmVudFwiKTtcbn0pO1xuXG50ZXN0KFwiY2hhdC1jb250cm9sbGVyIHJlcGxheXMgZmluYWwgbWVzc2FnZV9lbmQgY29udGVudCB3aGVuIHJlc3VsdCBhZGRzIHVuc3RyZWFtZWQgdHJhaWxpbmcgdGV4dFwiLCBhc3luYyAoKSA9PiB7XG5cdChnbG9iYWxUaGlzIGFzIGFueSlbU3ltYm9sLmZvcihcIkBnc2QvcGktY29kaW5nLWFnZW50OnRoZW1lXCIpXSA9IHtcblx0XHRmZzogKF9rZXk6IHN0cmluZywgdGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuXHRcdGJnOiAoX2tleTogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG5cdFx0Ym9sZDogKHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0XHRpdGFsaWM6ICh0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG5cdFx0dHJ1bmNhdGU6ICh0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG5cdH07XG5cblx0Y29uc3QgaG9zdCA9IGNyZWF0ZUhvc3QoKTtcblx0aG9zdC5nZXRNYXJrZG93blRoZW1lV2l0aFNldHRpbmdzID0gKCkgPT4gKHt9KTtcblxuXHRjb25zdCB0b29sID0ge1xuXHRcdHR5cGU6IFwidG9vbENhbGxcIixcblx0XHRpZDogXCJtY3AtZW5kLXJlcGxheS0xXCIsXG5cdFx0bmFtZTogXCJyZWFkXCIsXG5cdFx0bWNwU2VydmVyOiBcImZpbGVzeXN0ZW1cIixcblx0XHRhcmd1bWVudHM6IHsgZmlsZVBhdGg6IFwiL3RtcC9kZW1vLnR4dFwiIH0sXG5cdH07XG5cblx0YXdhaXQgaGFuZGxlQWdlbnRFdmVudChob3N0LCB7IHR5cGU6IFwibWVzc2FnZV9zdGFydFwiLCBtZXNzYWdlOiBtYWtlQXNzaXN0YW50KFtdKSB9IGFzIGFueSk7XG5cblx0Y29uc3Qgc3RyZWFtZWRDb250ZW50ID0gW1xuXHRcdHRvb2wsXG5cdFx0eyB0eXBlOiBcInRoaW5raW5nXCIsIHRoaW5raW5nOiBcIkkgYW0gYW5hbHl6aW5nIHRvb2wgb3V0cHV0Li4uXCIgfSxcblx0XTtcblx0YXdhaXQgaGFuZGxlQWdlbnRFdmVudChcblx0XHRob3N0LFxuXHRcdHtcblx0XHRcdHR5cGU6IFwibWVzc2FnZV91cGRhdGVcIixcblx0XHRcdG1lc3NhZ2U6IG1ha2VBc3Npc3RhbnQoc3RyZWFtZWRDb250ZW50KSxcblx0XHRcdGFzc2lzdGFudE1lc3NhZ2VFdmVudDoge1xuXHRcdFx0XHR0eXBlOiBcInRoaW5raW5nX2RlbHRhXCIsXG5cdFx0XHRcdGNvbnRlbnRJbmRleDogMSxcblx0XHRcdFx0ZGVsdGE6IFwiSSBhbSBhbmFseXppbmcgdG9vbCBvdXRwdXQuLi5cIixcblx0XHRcdFx0cGFydGlhbDogbWFrZUFzc2lzdGFudChzdHJlYW1lZENvbnRlbnQpLFxuXHRcdFx0fSxcblx0XHR9IGFzIGFueSxcblx0KTtcblxuXHRhc3NlcnQuZXF1YWwoaG9zdC5jaGF0Q29udGFpbmVyLmNoaWxkcmVuLmxlbmd0aCwgMiwgXCJzdHJlYW1pbmcgc2hvd3MgdG9vbCArIHRoaW5raW5nIG9ubHlcIik7XG5cdGFzc2VydC5lcXVhbChob3N0LmNoYXRDb250YWluZXIuY2hpbGRyZW5bMF0/LmNvbnN0cnVjdG9yPy5uYW1lLCBcIlRvb2xFeGVjdXRpb25Db21wb25lbnRcIik7XG5cdGFzc2VydC5lcXVhbChob3N0LmNoYXRDb250YWluZXIuY2hpbGRyZW5bMV0/LmNvbnN0cnVjdG9yPy5uYW1lLCBcIkFzc2lzdGFudE1lc3NhZ2VDb21wb25lbnRcIik7XG5cblx0Ly8gRmluYWwgcGF5bG9hZCBpbmNsdWRlcyB0cmFpbGluZyB0ZXh0IHRoYXQgbmV2ZXIgYXJyaXZlZCBhcyBtZXNzYWdlX3VwZGF0ZS5cblx0Y29uc3QgZmluYWxDb250ZW50ID0gW1xuXHRcdHRvb2wsXG5cdFx0eyB0eXBlOiBcInRoaW5raW5nXCIsIHRoaW5raW5nOiBcIkkgYW0gYW5hbHl6aW5nIHRvb2wgb3V0cHV0Li4uXCIgfSxcblx0XHR7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkNvcnJlY3QgYW55dGhpbmcgaW1wb3J0YW50IEkgbWlzc2VkP1wiIH0sXG5cdF07XG5cdGF3YWl0IGhhbmRsZUFnZW50RXZlbnQoaG9zdCwgeyB0eXBlOiBcIm1lc3NhZ2VfZW5kXCIsIG1lc3NhZ2U6IG1ha2VBc3Npc3RhbnQoZmluYWxDb250ZW50KSB9IGFzIGFueSk7XG5cblx0YXNzZXJ0LmVxdWFsKGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlbi5sZW5ndGgsIDMsIFwibWVzc2FnZV9lbmQgc2hvdWxkIHJlcGxheSBhbmQgaW5jbHVkZSB0cmFpbGluZyB0ZXh0IHNlZ21lbnRcIik7XG5cdGFzc2VydC5lcXVhbChob3N0LmNoYXRDb250YWluZXIuY2hpbGRyZW5bMF0/LmNvbnN0cnVjdG9yPy5uYW1lLCBcIlRvb2xFeGVjdXRpb25Db21wb25lbnRcIik7XG5cdGFzc2VydC5lcXVhbChob3N0LmNoYXRDb250YWluZXIuY2hpbGRyZW5bMV0/LmNvbnN0cnVjdG9yPy5uYW1lLCBcIkFzc2lzdGFudE1lc3NhZ2VDb21wb25lbnRcIik7XG5cdGFzc2VydC5lcXVhbChob3N0LmNoYXRDb250YWluZXIuY2hpbGRyZW5bMl0/LmNvbnN0cnVjdG9yPy5uYW1lLCBcIkFzc2lzdGFudE1lc3NhZ2VDb21wb25lbnRcIik7XG59KTtcblxudGVzdChcImNoYXQtY29udHJvbGxlciBrZWVwcyBwcmUtdG9vbCBwcm9zZSB2aXNpYmxlIHVudGlsIHBvc3QtdG9vbCBwcm9zZSBhcnJpdmVzLCB0aGVuIHBydW5lcyBpdFwiLCBhc3luYyAoKSA9PiB7XG5cdChnbG9iYWxUaGlzIGFzIGFueSlbU3ltYm9sLmZvcihcIkBnc2QvcGktY29kaW5nLWFnZW50OnRoZW1lXCIpXSA9IHtcblx0XHRmZzogKF9rZXk6IHN0cmluZywgdGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuXHRcdGJnOiAoX2tleTogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG5cdFx0Ym9sZDogKHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0XHRpdGFsaWM6ICh0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG5cdFx0dHJ1bmNhdGU6ICh0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG5cdH07XG5cblx0Y29uc3QgaG9zdCA9IGNyZWF0ZUhvc3QoKTtcblx0aG9zdC5nZXRNYXJrZG93blRoZW1lV2l0aFNldHRpbmdzID0gKCkgPT4gKHt9KTtcblxuXHRjb25zdCBtY3BUb29sID0ge1xuXHRcdHR5cGU6IFwidG9vbENhbGxcIixcblx0XHRpZDogXCJtY3AtdG9vbC0xXCIsXG5cdFx0bmFtZTogXCJyZWFkXCIsXG5cdFx0bWNwU2VydmVyOiBcImZpbGVzeXN0ZW1cIixcblx0XHRhcmd1bWVudHM6IHsgZmlsZVBhdGg6IFwiL3RtcC9kZW1vLnR4dFwiIH0sXG5cdH07XG5cblx0YXdhaXQgaGFuZGxlQWdlbnRFdmVudChob3N0LCB7IHR5cGU6IFwibWVzc2FnZV9zdGFydFwiLCBtZXNzYWdlOiBtYWtlQXNzaXN0YW50KFtdKSB9IGFzIGFueSk7XG5cblx0Ly8gUHJvdmlzaW9uYWwgYXNzaXN0YW50IHRleHQgYXJyaXZlcyBmaXJzdC5cblx0YXdhaXQgaGFuZGxlQWdlbnRFdmVudChcblx0XHRob3N0LFxuXHRcdHtcblx0XHRcdHR5cGU6IFwibWVzc2FnZV91cGRhdGVcIixcblx0XHRcdG1lc3NhZ2U6IG1ha2VBc3Npc3RhbnQoW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiTGV0IG1lIGluc3BlY3QgdGhlIHdvcmtzcGFjZSBmaXJzdC5cIiB9XSksXG5cdFx0XHRhc3Npc3RhbnRNZXNzYWdlRXZlbnQ6IHtcblx0XHRcdFx0dHlwZTogXCJ0ZXh0X2RlbHRhXCIsXG5cdFx0XHRcdGNvbnRlbnRJbmRleDogMCxcblx0XHRcdFx0ZGVsdGE6IFwiTGV0IG1lIGluc3BlY3QgdGhlIHdvcmtzcGFjZSBmaXJzdC5cIixcblx0XHRcdFx0cGFydGlhbDogbWFrZUFzc2lzdGFudChbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJMZXQgbWUgaW5zcGVjdCB0aGUgd29ya3NwYWNlIGZpcnN0LlwiIH1dKSxcblx0XHRcdH0sXG5cdFx0fSBhcyBhbnksXG5cdCk7XG5cdGFzc2VydC5lcXVhbChob3N0LmNoYXRDb250YWluZXIuY2hpbGRyZW4ubGVuZ3RoLCAxKTtcblx0YXNzZXJ0LmVxdWFsKGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlblswXT8uY29uc3RydWN0b3I/Lm5hbWUsIFwiQXNzaXN0YW50TWVzc2FnZUNvbXBvbmVudFwiKTtcblxuXHQvLyBNQ1AgdG9vbCBhcHBlYXJzOyBwcm92aXNpb25hbCB0ZXh0IHNob3VsZCByZW1haW4gdmlzaWJsZSB1bnRpbCBwb3N0LXRvb2wgcHJvc2UgZXhpc3RzLlxuXHRhd2FpdCBoYW5kbGVBZ2VudEV2ZW50KFxuXHRcdGhvc3QsXG5cdFx0e1xuXHRcdFx0dHlwZTogXCJtZXNzYWdlX3VwZGF0ZVwiLFxuXHRcdFx0bWVzc2FnZTogbWFrZUFzc2lzdGFudChbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJMZXQgbWUgaW5zcGVjdCB0aGUgd29ya3NwYWNlIGZpcnN0LlwiIH0sIG1jcFRvb2xdKSxcblx0XHRcdGFzc2lzdGFudE1lc3NhZ2VFdmVudDoge1xuXHRcdFx0XHR0eXBlOiBcInRvb2xjYWxsX2VuZFwiLFxuXHRcdFx0XHRjb250ZW50SW5kZXg6IDEsXG5cdFx0XHRcdHRvb2xDYWxsOiB7XG5cdFx0XHRcdFx0Li4ubWNwVG9vbCxcblx0XHRcdFx0XHRleHRlcm5hbFJlc3VsdDoge1xuXHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiZmlsZSBwcmV2aWV3XCIgfV0sXG5cdFx0XHRcdFx0XHRkZXRhaWxzOiB7fSxcblx0XHRcdFx0XHRcdGlzRXJyb3I6IGZhbHNlLFxuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdH0sXG5cdFx0XHRcdHBhcnRpYWw6IG1ha2VBc3Npc3RhbnQoW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiTGV0IG1lIGluc3BlY3QgdGhlIHdvcmtzcGFjZSBmaXJzdC5cIiB9LCBtY3BUb29sXSksXG5cdFx0XHR9LFxuXHRcdH0gYXMgYW55LFxuXHQpO1xuXHRhc3NlcnQuZXF1YWwoaG9zdC5jaGF0Q29udGFpbmVyLmNoaWxkcmVuLmxlbmd0aCwgMiwgXCJwcmUtdG9vbCBwcm9zZSBzaG91bGQgcmVtYWluIGR1cmluZyB0b29sLW9ubHkgd2luZG93XCIpO1xuXHRhc3NlcnQuZXF1YWwoaG9zdC5jaGF0Q29udGFpbmVyLmNoaWxkcmVuWzBdPy5jb25zdHJ1Y3Rvcj8ubmFtZSwgXCJBc3Npc3RhbnRNZXNzYWdlQ29tcG9uZW50XCIpO1xuXHRhc3NlcnQuZXF1YWwoaG9zdC5jaGF0Q29udGFpbmVyLmNoaWxkcmVuWzFdPy5jb25zdHJ1Y3Rvcj8ubmFtZSwgXCJUb29sRXhlY3V0aW9uQ29tcG9uZW50XCIpO1xuXG5cdC8vIFBvc3QtdG9vbCBwcm9zZSBhcnJpdmVzOiBwcmUtdG9vbCBwcm9zZSBzaG91bGQgbm93IGJlIHBydW5lZC5cblx0Y29uc3QgZmluYWxDb250ZW50ID0gW1xuXHRcdHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiTGV0IG1lIGluc3BlY3QgdGhlIHdvcmtzcGFjZSBmaXJzdC5cIiB9LFxuXHRcdG1jcFRvb2wsXG5cdFx0eyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJXaGljaCBtaXNzaW5nIGZlYXR1cmUgbWF0dGVycyBtb3N0IHRvIHlvdT9cIiB9LFxuXHRdO1xuXHRhd2FpdCBoYW5kbGVBZ2VudEV2ZW50KFxuXHRcdGhvc3QsXG5cdFx0e1xuXHRcdFx0dHlwZTogXCJtZXNzYWdlX3VwZGF0ZVwiLFxuXHRcdFx0bWVzc2FnZTogbWFrZUFzc2lzdGFudChmaW5hbENvbnRlbnQpLFxuXHRcdFx0YXNzaXN0YW50TWVzc2FnZUV2ZW50OiB7XG5cdFx0XHRcdHR5cGU6IFwidGV4dF9kZWx0YVwiLFxuXHRcdFx0XHRjb250ZW50SW5kZXg6IDIsXG5cdFx0XHRcdGRlbHRhOiBcIldoaWNoIG1pc3NpbmcgZmVhdHVyZSBtYXR0ZXJzIG1vc3QgdG8geW91P1wiLFxuXHRcdFx0XHRwYXJ0aWFsOiBtYWtlQXNzaXN0YW50KGZpbmFsQ29udGVudCksXG5cdFx0XHR9LFxuXHRcdH0gYXMgYW55LFxuXHQpO1xuXHRhc3NlcnQuZXF1YWwoaG9zdC5jaGF0Q29udGFpbmVyLmNoaWxkcmVuLmxlbmd0aCwgMik7XG5cdGFzc2VydC5lcXVhbChob3N0LmNoYXRDb250YWluZXIuY2hpbGRyZW5bMF0/LmNvbnN0cnVjdG9yPy5uYW1lLCBcIlRvb2xFeGVjdXRpb25Db21wb25lbnRcIik7XG5cdGFzc2VydC5lcXVhbChob3N0LmNoYXRDb250YWluZXIuY2hpbGRyZW5bMV0/LmNvbnN0cnVjdG9yPy5uYW1lLCBcIkFzc2lzdGFudE1lc3NhZ2VDb21wb25lbnRcIik7XG5cblx0Ly8gRmluYWxpemUgdG8gdGVhciBkb3duIGFueSBwaW5uZWQgc3Bpbm5lciBzdGF0ZS5cblx0YXdhaXQgaGFuZGxlQWdlbnRFdmVudChob3N0LCB7IHR5cGU6IFwibWVzc2FnZV9lbmRcIiwgbWVzc2FnZTogbWFrZUFzc2lzdGFudChmaW5hbENvbnRlbnQpIH0gYXMgYW55KTtcbn0pO1xuXG50ZXN0KFwiY2hhdC1jb250cm9sbGVyIGtlZXBzIHByZS10b29sIHRoaW5raW5nIHZpc2libGUgZm9yIGNsYXVkZS1jb2RlIE1DUCB0dXJucyB3aXRob3V0IHBvc3QtdG9vbCBwcm9zZVwiLCBhc3luYyAoKSA9PiB7XG5cdChnbG9iYWxUaGlzIGFzIGFueSlbU3ltYm9sLmZvcihcIkBnc2QvcGktY29kaW5nLWFnZW50OnRoZW1lXCIpXSA9IHtcblx0XHRmZzogKF9rZXk6IHN0cmluZywgdGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuXHRcdGJnOiAoX2tleTogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG5cdFx0Ym9sZDogKHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0XHRpdGFsaWM6ICh0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG5cdFx0dHJ1bmNhdGU6ICh0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG5cdH07XG5cblx0Y29uc3QgaG9zdCA9IGNyZWF0ZUhvc3QoKTtcblx0aG9zdC5nZXRNYXJrZG93blRoZW1lV2l0aFNldHRpbmdzID0gKCkgPT4gKHt9KTtcblxuXHRjb25zdCBtY3BUb29sID0ge1xuXHRcdHR5cGU6IFwidG9vbENhbGxcIixcblx0XHRpZDogXCJtY3AtdG9vbC10aGlua2luZy0xXCIsXG5cdFx0bmFtZTogXCJyZWFkXCIsXG5cdFx0bWNwU2VydmVyOiBcImZpbGVzeXN0ZW1cIixcblx0XHRhcmd1bWVudHM6IHsgZmlsZVBhdGg6IFwiL3RtcC9kZW1vLnR4dFwiIH0sXG5cdH07XG5cblx0YXdhaXQgaGFuZGxlQWdlbnRFdmVudChob3N0LCB7IHR5cGU6IFwibWVzc2FnZV9zdGFydFwiLCBtZXNzYWdlOiBtYWtlQXNzaXN0YW50KFtdKSB9IGFzIGFueSk7XG5cblx0Y29uc3QgdGhpbmtpbmdPbmx5ID0gW3sgdHlwZTogXCJ0aGlua2luZ1wiLCB0aGlua2luZzogXCJJIHNob3VsZCBpbnNwZWN0IHRoZSB3b3Jrc3BhY2UuXCIgfV07XG5cdGF3YWl0IGhhbmRsZUFnZW50RXZlbnQoXG5cdFx0aG9zdCxcblx0XHR7XG5cdFx0XHR0eXBlOiBcIm1lc3NhZ2VfdXBkYXRlXCIsXG5cdFx0XHRtZXNzYWdlOiBtYWtlQXNzaXN0YW50KHRoaW5raW5nT25seSksXG5cdFx0XHRhc3Npc3RhbnRNZXNzYWdlRXZlbnQ6IHtcblx0XHRcdFx0dHlwZTogXCJ0aGlua2luZ19kZWx0YVwiLFxuXHRcdFx0XHRjb250ZW50SW5kZXg6IDAsXG5cdFx0XHRcdGRlbHRhOiBcIkkgc2hvdWxkIGluc3BlY3QgdGhlIHdvcmtzcGFjZS5cIixcblx0XHRcdFx0cGFydGlhbDogbWFrZUFzc2lzdGFudCh0aGlua2luZ09ubHkpLFxuXHRcdFx0fSxcblx0XHR9IGFzIGFueSxcblx0KTtcblx0YXNzZXJ0LmVxdWFsKGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlbi5sZW5ndGgsIDEpO1xuXHRhc3NlcnQuZXF1YWwoaG9zdC5jaGF0Q29udGFpbmVyLmNoaWxkcmVuWzBdPy5jb25zdHJ1Y3Rvcj8ubmFtZSwgXCJBc3Npc3RhbnRNZXNzYWdlQ29tcG9uZW50XCIpO1xuXG5cdGF3YWl0IGhhbmRsZUFnZW50RXZlbnQoXG5cdFx0aG9zdCxcblx0XHR7XG5cdFx0XHR0eXBlOiBcIm1lc3NhZ2VfdXBkYXRlXCIsXG5cdFx0XHRtZXNzYWdlOiBtYWtlQXNzaXN0YW50KFt0aGlua2luZ09ubHlbMF0sIG1jcFRvb2xdKSxcblx0XHRcdGFzc2lzdGFudE1lc3NhZ2VFdmVudDoge1xuXHRcdFx0XHR0eXBlOiBcInRvb2xjYWxsX2VuZFwiLFxuXHRcdFx0XHRjb250ZW50SW5kZXg6IDEsXG5cdFx0XHRcdHRvb2xDYWxsOiB7XG5cdFx0XHRcdFx0Li4ubWNwVG9vbCxcblx0XHRcdFx0XHRleHRlcm5hbFJlc3VsdDoge1xuXHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiZmlsZSBwcmV2aWV3XCIgfV0sXG5cdFx0XHRcdFx0XHRkZXRhaWxzOiB7fSxcblx0XHRcdFx0XHRcdGlzRXJyb3I6IGZhbHNlLFxuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdH0sXG5cdFx0XHRcdHBhcnRpYWw6IG1ha2VBc3Npc3RhbnQoW3RoaW5raW5nT25seVswXSwgbWNwVG9vbF0pLFxuXHRcdFx0fSxcblx0XHR9IGFzIGFueSxcblx0KTtcblxuXHRhc3NlcnQuZXF1YWwoaG9zdC5jaGF0Q29udGFpbmVyLmNoaWxkcmVuLmxlbmd0aCwgMiwgXCJ0aGlua2luZyBzaG91bGQgcmVtYWluIHZpc2libGUgd2hpbGUgb25seSB0b29sIG91dHB1dCBpcyBwcmVzZW50XCIpO1xuXHRhc3NlcnQuZXF1YWwoaG9zdC5jaGF0Q29udGFpbmVyLmNoaWxkcmVuWzBdPy5jb25zdHJ1Y3Rvcj8ubmFtZSwgXCJBc3Npc3RhbnRNZXNzYWdlQ29tcG9uZW50XCIpO1xuXHRhc3NlcnQuZXF1YWwoaG9zdC5jaGF0Q29udGFpbmVyLmNoaWxkcmVuWzFdPy5jb25zdHJ1Y3Rvcj8ubmFtZSwgXCJUb29sRXhlY3V0aW9uQ29tcG9uZW50XCIpO1xuXG5cdGF3YWl0IGhhbmRsZUFnZW50RXZlbnQoaG9zdCwgeyB0eXBlOiBcIm1lc3NhZ2VfZW5kXCIsIG1lc3NhZ2U6IG1ha2VBc3Npc3RhbnQoW3RoaW5raW5nT25seVswXSwgbWNwVG9vbF0pIH0gYXMgYW55KTtcbn0pO1xuXG50ZXN0KFwiY2hhdC1jb250cm9sbGVyIGtlZXBzIHByZS10b29sIHF1ZXN0aW9uIHRleHQgZm9yIGNsYXVkZS1jb2RlIE1DUCB3aGVuIHBvc3QtdG9vbCBwcm9zZSBleGlzdHNcIiwgYXN5bmMgKCkgPT4ge1xuXHQoZ2xvYmFsVGhpcyBhcyBhbnkpW1N5bWJvbC5mb3IoXCJAZ3NkL3BpLWNvZGluZy1hZ2VudDp0aGVtZVwiKV0gPSB7XG5cdFx0Zmc6IChfa2V5OiBzdHJpbmcsIHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0XHRiZzogKF9rZXk6IHN0cmluZywgdGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuXHRcdGJvbGQ6ICh0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG5cdFx0aXRhbGljOiAodGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuXHRcdHRydW5jYXRlOiAodGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuXHR9O1xuXG5cdGNvbnN0IGhvc3QgPSBjcmVhdGVIb3N0KCk7XG5cdGhvc3QuZ2V0TWFya2Rvd25UaGVtZVdpdGhTZXR0aW5ncyA9ICgpID0+ICh7fSk7XG5cblx0Y29uc3QgbWNwVG9vbCA9IHtcblx0XHR0eXBlOiBcInRvb2xDYWxsXCIsXG5cdFx0aWQ6IFwibWNwLXRvb2wtcXVlc3Rpb24tMVwiLFxuXHRcdG5hbWU6IFwiZ2xvYlwiLFxuXHRcdG1jcFNlcnZlcjogXCJmaWxlc3lzdGVtXCIsXG5cdFx0YXJndW1lbnRzOiB7IHBhdHRlcm46IFwiKiovKlwiIH0sXG5cdH07XG5cblx0YXdhaXQgaGFuZGxlQWdlbnRFdmVudChob3N0LCB7IHR5cGU6IFwibWVzc2FnZV9zdGFydFwiLCBtZXNzYWdlOiBtYWtlQXNzaXN0YW50KFtdKSB9IGFzIGFueSk7XG5cblx0Y29uc3QgcXVlc3Rpb25UZXh0ID0geyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJXaGljaCBmaWxlIHNob3VsZCBJIGluc3BlY3Q/XCIgfTtcblxuXHRhd2FpdCBoYW5kbGVBZ2VudEV2ZW50KFxuXHRcdGhvc3QsXG5cdFx0e1xuXHRcdFx0dHlwZTogXCJtZXNzYWdlX3VwZGF0ZVwiLFxuXHRcdFx0bWVzc2FnZTogbWFrZUFzc2lzdGFudChbcXVlc3Rpb25UZXh0XSksXG5cdFx0XHRhc3Npc3RhbnRNZXNzYWdlRXZlbnQ6IHtcblx0XHRcdFx0dHlwZTogXCJ0ZXh0X2RlbHRhXCIsXG5cdFx0XHRcdGNvbnRlbnRJbmRleDogMCxcblx0XHRcdFx0ZGVsdGE6IHF1ZXN0aW9uVGV4dC50ZXh0LFxuXHRcdFx0XHRwYXJ0aWFsOiBtYWtlQXNzaXN0YW50KFtxdWVzdGlvblRleHRdKSxcblx0XHRcdH0sXG5cdFx0fSBhcyBhbnksXG5cdCk7XG5cblx0YXdhaXQgaGFuZGxlQWdlbnRFdmVudChcblx0XHRob3N0LFxuXHRcdHtcblx0XHRcdHR5cGU6IFwibWVzc2FnZV91cGRhdGVcIixcblx0XHRcdG1lc3NhZ2U6IG1ha2VBc3Npc3RhbnQoW3F1ZXN0aW9uVGV4dCwgbWNwVG9vbF0pLFxuXHRcdFx0YXNzaXN0YW50TWVzc2FnZUV2ZW50OiB7XG5cdFx0XHRcdHR5cGU6IFwidG9vbGNhbGxfZW5kXCIsXG5cdFx0XHRcdGNvbnRlbnRJbmRleDogMSxcblx0XHRcdFx0dG9vbENhbGw6IHtcblx0XHRcdFx0XHQuLi5tY3BUb29sLFxuXHRcdFx0XHRcdGV4dGVybmFsUmVzdWx0OiB7XG5cdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJnbG9iIG91dHB1dFwiIH1dLFxuXHRcdFx0XHRcdFx0ZGV0YWlsczoge30sXG5cdFx0XHRcdFx0XHRpc0Vycm9yOiBmYWxzZSxcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHR9LFxuXHRcdFx0XHRwYXJ0aWFsOiBtYWtlQXNzaXN0YW50KFtxdWVzdGlvblRleHQsIG1jcFRvb2xdKSxcblx0XHRcdH0sXG5cdFx0fSBhcyBhbnksXG5cdCk7XG5cblx0Y29uc3QgcG9zdFRvb2wgPSB7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkknbGwgcmV2aWV3IHRoYXQgbmV4dC5cIiB9O1xuXHRjb25zdCBmaW5hbENvbnRlbnQgPSBbcXVlc3Rpb25UZXh0LCBtY3BUb29sLCBwb3N0VG9vbF07XG5cdGF3YWl0IGhhbmRsZUFnZW50RXZlbnQoXG5cdFx0aG9zdCxcblx0XHR7XG5cdFx0XHR0eXBlOiBcIm1lc3NhZ2VfdXBkYXRlXCIsXG5cdFx0XHRtZXNzYWdlOiBtYWtlQXNzaXN0YW50KGZpbmFsQ29udGVudCksXG5cdFx0XHRhc3Npc3RhbnRNZXNzYWdlRXZlbnQ6IHtcblx0XHRcdFx0dHlwZTogXCJ0ZXh0X2RlbHRhXCIsXG5cdFx0XHRcdGNvbnRlbnRJbmRleDogMixcblx0XHRcdFx0ZGVsdGE6IHBvc3RUb29sLnRleHQsXG5cdFx0XHRcdHBhcnRpYWw6IG1ha2VBc3Npc3RhbnQoZmluYWxDb250ZW50KSxcblx0XHRcdH0sXG5cdFx0fSBhcyBhbnksXG5cdCk7XG5cblx0YXNzZXJ0LmVxdWFsKGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlbi5sZW5ndGgsIDMsIFwicXVlc3Rpb24gdGV4dCBzaG91bGQgcmVtYWluIGFsb25nc2lkZSBNQ1AgdG9vbCBhbmQgcG9zdC10b29sIHByb3NlXCIpO1xuXHRhc3NlcnQuZXF1YWwoaG9zdC5jaGF0Q29udGFpbmVyLmNoaWxkcmVuWzBdPy5jb25zdHJ1Y3Rvcj8ubmFtZSwgXCJBc3Npc3RhbnRNZXNzYWdlQ29tcG9uZW50XCIsIFwicHJlLXRvb2wgcXVlc3Rpb24gc3RheXMgdmlzaWJsZVwiKTtcblx0YXNzZXJ0LmVxdWFsKGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlblsxXT8uY29uc3RydWN0b3I/Lm5hbWUsIFwiVG9vbEV4ZWN1dGlvbkNvbXBvbmVudFwiLCBcInRvb2wgcmVuZGVycyBpbiB0aGUgbWlkZGxlXCIpO1xuXHRhc3NlcnQuZXF1YWwoaG9zdC5jaGF0Q29udGFpbmVyLmNoaWxkcmVuWzJdPy5jb25zdHJ1Y3Rvcj8ubmFtZSwgXCJBc3Npc3RhbnRNZXNzYWdlQ29tcG9uZW50XCIsIFwicG9zdC10b29sIHByb3NlIHJlbmRlcnMgbGFzdFwiKTtcblxuXHRhd2FpdCBoYW5kbGVBZ2VudEV2ZW50KGhvc3QsIHsgdHlwZTogXCJtZXNzYWdlX2VuZFwiLCBtZXNzYWdlOiBtYWtlQXNzaXN0YW50KGZpbmFsQ29udGVudCkgfSBhcyBhbnkpO1xufSk7XG5cbnRlc3QoXCJjaGF0LWNvbnRyb2xsZXIgcHJ1bmVzIG9ycGhhbmVkIHByb3Zpc2lvbmFsIHRleHQgYWZ0ZXIgY2xhdWRlLWNvZGUgc3ViLXR1cm4gc2hyaW5rIHdoZW4gTUNQIHRvb2xzIGFwcGVhclwiLCBhc3luYyAoKSA9PiB7XG5cdChnbG9iYWxUaGlzIGFzIGFueSlbU3ltYm9sLmZvcihcIkBnc2QvcGktY29kaW5nLWFnZW50OnRoZW1lXCIpXSA9IHtcblx0XHRmZzogKF9rZXk6IHN0cmluZywgdGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuXHRcdGJnOiAoX2tleTogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG5cdFx0Ym9sZDogKHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0XHRpdGFsaWM6ICh0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG5cdFx0dHJ1bmNhdGU6ICh0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG5cdH07XG5cblx0Y29uc3QgaG9zdCA9IGNyZWF0ZUhvc3QoKTtcblx0aG9zdC5nZXRNYXJrZG93blRoZW1lV2l0aFNldHRpbmdzID0gKCkgPT4gKHt9KTtcblxuXHRjb25zdCBtY3BUb29sID0ge1xuXHRcdHR5cGU6IFwidG9vbENhbGxcIixcblx0XHRpZDogXCJtY3AtdG9vbC1zaHJpbmstMVwiLFxuXHRcdG5hbWU6IFwiZ2xvYlwiLFxuXHRcdG1jcFNlcnZlcjogXCJmaWxlc3lzdGVtXCIsXG5cdFx0YXJndW1lbnRzOiB7IHBhdHRlcm46IFwiKiovKlwiIH0sXG5cdH07XG5cblx0YXdhaXQgaGFuZGxlQWdlbnRFdmVudChob3N0LCB7IHR5cGU6IFwibWVzc2FnZV9zdGFydFwiLCBtZXNzYWdlOiBtYWtlQXNzaXN0YW50KFtdKSB9IGFzIGFueSk7XG5cblx0Ly8gU3ViLXR1cm4gMTogZ2VuZXJhdGUgbG9uZ2VyIHByb3Zpc2lvbmFsIHRleHQgY29udGVudC5cblx0YXdhaXQgaGFuZGxlQWdlbnRFdmVudChcblx0XHRob3N0LFxuXHRcdHtcblx0XHRcdHR5cGU6IFwibWVzc2FnZV91cGRhdGVcIixcblx0XHRcdG1lc3NhZ2U6IG1ha2VBc3Npc3RhbnQoW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiT2xkIHByb3Zpc2lvbmFsIHByZWZhY2UuXCIgfSwgeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJNb3JlIG9sZCB0ZXh0LlwiIH1dKSxcblx0XHRcdGFzc2lzdGFudE1lc3NhZ2VFdmVudDoge1xuXHRcdFx0XHR0eXBlOiBcInRleHRfZGVsdGFcIixcblx0XHRcdFx0Y29udGVudEluZGV4OiAxLFxuXHRcdFx0XHRkZWx0YTogXCJNb3JlIG9sZCB0ZXh0LlwiLFxuXHRcdFx0XHRwYXJ0aWFsOiBtYWtlQXNzaXN0YW50KFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIk9sZCBwcm92aXNpb25hbCBwcmVmYWNlLlwiIH0sIHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiTW9yZSBvbGQgdGV4dC5cIiB9XSksXG5cdFx0XHR9LFxuXHRcdH0gYXMgYW55LFxuXHQpO1xuXHRhc3NlcnQuZXF1YWwoaG9zdC5jaGF0Q29udGFpbmVyLmNoaWxkcmVuLmxlbmd0aCwgMSwgXCJmaXJzdCBzdWItdHVybiB0ZXh0IHJ1biBzaG91bGQgcmVuZGVyXCIpO1xuXG5cdC8vIFN1Yi10dXJuIDIgc3RhcnRzIChjb250ZW50IHNocmluayk6IG9sZCBjb21wb25lbnQgaXMgb3JwaGFuZWQgYnkgZGVzaWduLlxuXHRhd2FpdCBoYW5kbGVBZ2VudEV2ZW50KFxuXHRcdGhvc3QsXG5cdFx0e1xuXHRcdFx0dHlwZTogXCJtZXNzYWdlX3VwZGF0ZVwiLFxuXHRcdFx0bWVzc2FnZTogbWFrZUFzc2lzdGFudChbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJOZXcgcHJvdmlzaW9uYWwgdGV4dCBiZWZvcmUgdG9vbC5cIiB9XSksXG5cdFx0XHRhc3Npc3RhbnRNZXNzYWdlRXZlbnQ6IHtcblx0XHRcdFx0dHlwZTogXCJ0ZXh0X2RlbHRhXCIsXG5cdFx0XHRcdGNvbnRlbnRJbmRleDogMCxcblx0XHRcdFx0ZGVsdGE6IFwiTmV3IHByb3Zpc2lvbmFsIHRleHQgYmVmb3JlIHRvb2wuXCIsXG5cdFx0XHRcdHBhcnRpYWw6IG1ha2VBc3Npc3RhbnQoW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiTmV3IHByb3Zpc2lvbmFsIHRleHQgYmVmb3JlIHRvb2wuXCIgfV0pLFxuXHRcdFx0fSxcblx0XHR9IGFzIGFueSxcblx0KTtcblx0YXNzZXJ0LmVxdWFsKGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlbi5sZW5ndGgsIDIsIFwic2hyaW5rIGtlZXBzIHByaW9yIHRleHQgdW50aWwgTUNQIHRvb2wgY29udGV4dCBhcHBlYXJzXCIpO1xuXG5cdC8vIE1DUCB0b29sIGFwcGVhcnMgaW4gc3ViLXR1cm4gMjogdG9vbC1vbmx5IHdpbmRvd3Mga2VlcCBwcm92aXNpb25hbCBwcm9zZSB2aXNpYmxlLlxuXHRhd2FpdCBoYW5kbGVBZ2VudEV2ZW50KFxuXHRcdGhvc3QsXG5cdFx0e1xuXHRcdFx0dHlwZTogXCJtZXNzYWdlX3VwZGF0ZVwiLFxuXHRcdFx0bWVzc2FnZTogbWFrZUFzc2lzdGFudChbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJOZXcgcHJvdmlzaW9uYWwgdGV4dCBiZWZvcmUgdG9vbC5cIiB9LCBtY3BUb29sXSksXG5cdFx0XHRhc3Npc3RhbnRNZXNzYWdlRXZlbnQ6IHtcblx0XHRcdFx0dHlwZTogXCJ0b29sY2FsbF9lbmRcIixcblx0XHRcdFx0Y29udGVudEluZGV4OiAxLFxuXHRcdFx0XHR0b29sQ2FsbDoge1xuXHRcdFx0XHRcdC4uLm1jcFRvb2wsXG5cdFx0XHRcdFx0ZXh0ZXJuYWxSZXN1bHQ6IHtcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcImdsb2Igb3V0cHV0XCIgfV0sXG5cdFx0XHRcdFx0XHRkZXRhaWxzOiB7fSxcblx0XHRcdFx0XHRcdGlzRXJyb3I6IGZhbHNlLFxuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdH0sXG5cdFx0XHRcdHBhcnRpYWw6IG1ha2VBc3Npc3RhbnQoW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiTmV3IHByb3Zpc2lvbmFsIHRleHQgYmVmb3JlIHRvb2wuXCIgfSwgbWNwVG9vbF0pLFxuXHRcdFx0fSxcblx0XHR9IGFzIGFueSxcblx0KTtcblx0YXNzZXJ0LmVxdWFsKGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlbi5sZW5ndGgsIDMsIFwic3RhbGUgdGV4dCBydW5zIGFyZSBkZWZlcnJlZCB1bnRpbCBwb3N0LXRvb2wgcHJvc2UgYXJyaXZlc1wiKTtcblx0YXNzZXJ0LmVxdWFsKGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlblswXT8uY29uc3RydWN0b3I/Lm5hbWUsIFwiQXNzaXN0YW50TWVzc2FnZUNvbXBvbmVudFwiKTtcblx0YXNzZXJ0LmVxdWFsKGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlblsxXT8uY29uc3RydWN0b3I/Lm5hbWUsIFwiQXNzaXN0YW50TWVzc2FnZUNvbXBvbmVudFwiKTtcblx0YXNzZXJ0LmVxdWFsKGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlblsyXT8uY29uc3RydWN0b3I/Lm5hbWUsIFwiVG9vbEV4ZWN1dGlvbkNvbXBvbmVudFwiKTtcblxuXHRjb25zdCBmaW5hbENvbnRlbnQgPSBbbWNwVG9vbCwgeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJGaW5hbCB2aXNpYmxlIHF1ZXN0aW9uP1wiIH1dO1xuXHRhd2FpdCBoYW5kbGVBZ2VudEV2ZW50KFxuXHRcdGhvc3QsXG5cdFx0e1xuXHRcdFx0dHlwZTogXCJtZXNzYWdlX3VwZGF0ZVwiLFxuXHRcdFx0bWVzc2FnZTogbWFrZUFzc2lzdGFudChmaW5hbENvbnRlbnQpLFxuXHRcdFx0YXNzaXN0YW50TWVzc2FnZUV2ZW50OiB7XG5cdFx0XHRcdHR5cGU6IFwidGV4dF9kZWx0YVwiLFxuXHRcdFx0XHRjb250ZW50SW5kZXg6IDEsXG5cdFx0XHRcdGRlbHRhOiBcIkZpbmFsIHZpc2libGUgcXVlc3Rpb24/XCIsXG5cdFx0XHRcdHBhcnRpYWw6IG1ha2VBc3Npc3RhbnQoZmluYWxDb250ZW50KSxcblx0XHRcdH0sXG5cdFx0fSBhcyBhbnksXG5cdCk7XG5cdGFzc2VydC5lcXVhbChob3N0LmNoYXRDb250YWluZXIuY2hpbGRyZW4ubGVuZ3RoLCAyKTtcblx0YXNzZXJ0LmVxdWFsKGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlblswXT8uY29uc3RydWN0b3I/Lm5hbWUsIFwiVG9vbEV4ZWN1dGlvbkNvbXBvbmVudFwiKTtcblx0YXNzZXJ0LmVxdWFsKGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlblsxXT8uY29uc3RydWN0b3I/Lm5hbWUsIFwiQXNzaXN0YW50TWVzc2FnZUNvbXBvbmVudFwiKTtcblxuXHRhd2FpdCBoYW5kbGVBZ2VudEV2ZW50KGhvc3QsIHsgdHlwZTogXCJtZXNzYWdlX2VuZFwiLCBtZXNzYWdlOiBtYWtlQXNzaXN0YW50KGZpbmFsQ29udGVudCkgfSBhcyBhbnkpO1xufSk7XG5cbnRlc3QoXCJjaGF0LWNvbnRyb2xsZXIgcHJ1bmVzIG9ycGhhbnMgZnJvbSBtdWx0aXBsZSBzdWItdHVybiBzaHJpbmtzIGJlZm9yZSBNQ1AgcG9zdC10b29sIHByb3NlXCIsIGFzeW5jICgpID0+IHtcblx0KGdsb2JhbFRoaXMgYXMgYW55KVtTeW1ib2wuZm9yKFwiQGdzZC9waS1jb2RpbmctYWdlbnQ6dGhlbWVcIildID0ge1xuXHRcdGZnOiAoX2tleTogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG5cdFx0Ymc6IChfa2V5OiBzdHJpbmcsIHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0XHRib2xkOiAodGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuXHRcdGl0YWxpYzogKHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0XHR0cnVuY2F0ZTogKHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0fTtcblxuXHRjb25zdCBob3N0ID0gY3JlYXRlSG9zdCgpO1xuXHRob3N0LmdldE1hcmtkb3duVGhlbWVXaXRoU2V0dGluZ3MgPSAoKSA9PiAoe30pO1xuXG5cdGNvbnN0IG1jcFRvb2wgPSB7XG5cdFx0dHlwZTogXCJ0b29sQ2FsbFwiLFxuXHRcdGlkOiBcIm1jcC10b29sLW11bHRpLXNocmluay0xXCIsXG5cdFx0bmFtZTogXCJnbG9iXCIsXG5cdFx0bWNwU2VydmVyOiBcImZpbGVzeXN0ZW1cIixcblx0XHRhcmd1bWVudHM6IHsgcGF0dGVybjogXCIqKi8qXCIgfSxcblx0fTtcblxuXHRhd2FpdCBoYW5kbGVBZ2VudEV2ZW50KGhvc3QsIHsgdHlwZTogXCJtZXNzYWdlX3N0YXJ0XCIsIG1lc3NhZ2U6IG1ha2VBc3Npc3RhbnQoW10pIH0gYXMgYW55KTtcblxuXHQvLyBTdWItdHVybiAxOiAzIHRleHQgYmxvY2tzIChtZXJnZWQgaW50byBvbmUgdGV4dC1ydW4pLlxuXHRjb25zdCBzdWJUdXJuMSA9IFtcblx0XHR7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkZpcnN0IHByb3Zpc2lvbmFsIEEuXCIgfSxcblx0XHR7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkZpcnN0IHByb3Zpc2lvbmFsIEIuXCIgfSxcblx0XHR7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkZpcnN0IHByb3Zpc2lvbmFsIEMuXCIgfSxcblx0XTtcblx0YXdhaXQgaGFuZGxlQWdlbnRFdmVudChcblx0XHRob3N0LFxuXHRcdHtcblx0XHRcdHR5cGU6IFwibWVzc2FnZV91cGRhdGVcIixcblx0XHRcdG1lc3NhZ2U6IG1ha2VBc3Npc3RhbnQoc3ViVHVybjEpLFxuXHRcdFx0YXNzaXN0YW50TWVzc2FnZUV2ZW50OiB7XG5cdFx0XHRcdHR5cGU6IFwidGV4dF9kZWx0YVwiLFxuXHRcdFx0XHRjb250ZW50SW5kZXg6IDIsXG5cdFx0XHRcdGRlbHRhOiBcIkZpcnN0IHByb3Zpc2lvbmFsIEMuXCIsXG5cdFx0XHRcdHBhcnRpYWw6IG1ha2VBc3Npc3RhbnQoc3ViVHVybjEpLFxuXHRcdFx0fSxcblx0XHR9IGFzIGFueSxcblx0KTtcblx0YXNzZXJ0LmVxdWFsKGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlbi5sZW5ndGgsIDEsIFwiZmlyc3Qgc3ViLXR1cm4gcmVuZGVycyAxIHRleHQtcnVuXCIpO1xuXG5cdC8vIFN1Yi10dXJuIDIgKGZpcnN0IHNocmluayAzIFx1MjE5MiAyIGJsb2NrcykuXG5cdGNvbnN0IHN1YlR1cm4yID0gW1xuXHRcdHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiU2Vjb25kIHByb3Zpc2lvbmFsIEEuXCIgfSxcblx0XHR7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIlNlY29uZCBwcm92aXNpb25hbCBCLlwiIH0sXG5cdF07XG5cdGF3YWl0IGhhbmRsZUFnZW50RXZlbnQoXG5cdFx0aG9zdCxcblx0XHR7XG5cdFx0XHR0eXBlOiBcIm1lc3NhZ2VfdXBkYXRlXCIsXG5cdFx0XHRtZXNzYWdlOiBtYWtlQXNzaXN0YW50KHN1YlR1cm4yKSxcblx0XHRcdGFzc2lzdGFudE1lc3NhZ2VFdmVudDoge1xuXHRcdFx0XHR0eXBlOiBcInRleHRfZGVsdGFcIixcblx0XHRcdFx0Y29udGVudEluZGV4OiAxLFxuXHRcdFx0XHRkZWx0YTogXCJTZWNvbmQgcHJvdmlzaW9uYWwgQi5cIixcblx0XHRcdFx0cGFydGlhbDogbWFrZUFzc2lzdGFudChzdWJUdXJuMiksXG5cdFx0XHR9LFxuXHRcdH0gYXMgYW55LFxuXHQpO1xuXHRhc3NlcnQuZXF1YWwoaG9zdC5jaGF0Q29udGFpbmVyLmNoaWxkcmVuLmxlbmd0aCwgMiwgXCJmaXJzdCBzaHJpbmsgYXBwZW5kcywga2VlcHMgcHJpb3IgdGV4dCBhcyBmcm96ZW4gaGlzdG9yeVwiKTtcblxuXHQvLyBTdWItdHVybiAzIChzZWNvbmQgc2hyaW5rIDIgXHUyMTkyIDEgYmxvY2spLiBUaGlzIGlzIHRoZSBjcml0aWNhbCBzdGVwIFx1MjAxNFxuXHQvLyB3aXRob3V0IG9ycGhhbiBhY2N1bXVsYXRpb24sIHN1Yi10dXJuIDEncyBvcnBoYW5lZCBzZWdtZW50IHdvdWxkIGJlXG5cdC8vIGRyb3BwZWQgZnJvbSB0cmFja2luZyBoZXJlIGFuZCBsYXRlciBzdHJhbmQgaW4gdGhlIGNvbnRhaW5lci5cblx0Y29uc3Qgc3ViVHVybjMgPSBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJUaGlyZCBwcm92aXNpb25hbC5cIiB9XTtcblx0YXdhaXQgaGFuZGxlQWdlbnRFdmVudChcblx0XHRob3N0LFxuXHRcdHtcblx0XHRcdHR5cGU6IFwibWVzc2FnZV91cGRhdGVcIixcblx0XHRcdG1lc3NhZ2U6IG1ha2VBc3Npc3RhbnQoc3ViVHVybjMpLFxuXHRcdFx0YXNzaXN0YW50TWVzc2FnZUV2ZW50OiB7XG5cdFx0XHRcdHR5cGU6IFwidGV4dF9kZWx0YVwiLFxuXHRcdFx0XHRjb250ZW50SW5kZXg6IDAsXG5cdFx0XHRcdGRlbHRhOiBcIlRoaXJkIHByb3Zpc2lvbmFsLlwiLFxuXHRcdFx0XHRwYXJ0aWFsOiBtYWtlQXNzaXN0YW50KHN1YlR1cm4zKSxcblx0XHRcdH0sXG5cdFx0fSBhcyBhbnksXG5cdCk7XG5cdGFzc2VydC5lcXVhbChob3N0LmNoYXRDb250YWluZXIuY2hpbGRyZW4ubGVuZ3RoLCAzLCBcInNlY29uZCBzaHJpbmsgYXBwZW5kcyBhZ2Fpbiwgc3RpbGwgbm8gcHJ1bmUgKG5vIHBvc3QtdG9vbCB0ZXh0KVwiKTtcblxuXHQvLyBNQ1AgdG9vbCBhcHBlYXJzIFx1MjAxNCB0b29sLW9ubHkgd2luZG93IHN0aWxsIGtlZXBzIHByb3Zpc2lvbmFsIHByb3NlIHZpc2libGUuXG5cdGF3YWl0IGhhbmRsZUFnZW50RXZlbnQoXG5cdFx0aG9zdCxcblx0XHR7XG5cdFx0XHR0eXBlOiBcIm1lc3NhZ2VfdXBkYXRlXCIsXG5cdFx0XHRtZXNzYWdlOiBtYWtlQXNzaXN0YW50KFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIlRoaXJkIHByb3Zpc2lvbmFsLlwiIH0sIG1jcFRvb2xdKSxcblx0XHRcdGFzc2lzdGFudE1lc3NhZ2VFdmVudDoge1xuXHRcdFx0XHR0eXBlOiBcInRvb2xjYWxsX2VuZFwiLFxuXHRcdFx0XHRjb250ZW50SW5kZXg6IDEsXG5cdFx0XHRcdHRvb2xDYWxsOiB7XG5cdFx0XHRcdFx0Li4ubWNwVG9vbCxcblx0XHRcdFx0XHRleHRlcm5hbFJlc3VsdDoge1xuXHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiZ2xvYiBvdXRwdXRcIiB9XSxcblx0XHRcdFx0XHRcdGRldGFpbHM6IHt9LFxuXHRcdFx0XHRcdFx0aXNFcnJvcjogZmFsc2UsXG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0fSxcblx0XHRcdFx0cGFydGlhbDogbWFrZUFzc2lzdGFudChbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJUaGlyZCBwcm92aXNpb25hbC5cIiB9LCBtY3BUb29sXSksXG5cdFx0XHR9LFxuXHRcdH0gYXMgYW55LFxuXHQpO1xuXHRhc3NlcnQuZXF1YWwoaG9zdC5jaGF0Q29udGFpbmVyLmNoaWxkcmVuLmxlbmd0aCwgNCwgXCJ0b29sLW9ubHkgd2luZG93IGtlZXBzIGFsbCB0aHJlZSBwcm92aXNpb25hbCB0ZXh0LXJ1bnNcIik7XG5cblx0Ly8gRmluYWwgcG9zdC10b29sIHRleHQgYXJyaXZlcyBcdTIwMTQgcHJ1bmUgbXVzdCBkcm9wIEFMTCB0aHJlZSBwcmUtdG9vbFxuXHQvLyBwcm92aXNpb25hbCB0ZXh0LXJ1bnMgYWNyb3NzIGJvdGggc2hyaW5rcywgbGVhdmluZyBvbmx5IHRvb2wgKyBmaW5hbCB0ZXh0LlxuXHRjb25zdCBmaW5hbENvbnRlbnQgPSBbbWNwVG9vbCwgeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJGaW5hbCBhbnN3ZXIuXCIgfV07XG5cdGF3YWl0IGhhbmRsZUFnZW50RXZlbnQoXG5cdFx0aG9zdCxcblx0XHR7XG5cdFx0XHR0eXBlOiBcIm1lc3NhZ2VfdXBkYXRlXCIsXG5cdFx0XHRtZXNzYWdlOiBtYWtlQXNzaXN0YW50KGZpbmFsQ29udGVudCksXG5cdFx0XHRhc3Npc3RhbnRNZXNzYWdlRXZlbnQ6IHtcblx0XHRcdFx0dHlwZTogXCJ0ZXh0X2RlbHRhXCIsXG5cdFx0XHRcdGNvbnRlbnRJbmRleDogMSxcblx0XHRcdFx0ZGVsdGE6IFwiRmluYWwgYW5zd2VyLlwiLFxuXHRcdFx0XHRwYXJ0aWFsOiBtYWtlQXNzaXN0YW50KGZpbmFsQ29udGVudCksXG5cdFx0XHR9LFxuXHRcdH0gYXMgYW55LFxuXHQpO1xuXHRhc3NlcnQuZXF1YWwoXG5cdFx0aG9zdC5jaGF0Q29udGFpbmVyLmNoaWxkcmVuLmxlbmd0aCxcblx0XHQyLFxuXHRcdFwiYWxsIHByZS10b29sIHByb3Zpc2lvbmFsIHNlZ21lbnRzIGZyb20gZXZlcnkgc2hyaW5rIG11c3QgYmUgcHJ1bmVkIG9uY2UgcG9zdC10b29sIHByb3NlIGFycml2ZXNcIixcblx0KTtcblx0YXNzZXJ0LmVxdWFsKGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlblswXT8uY29uc3RydWN0b3I/Lm5hbWUsIFwiVG9vbEV4ZWN1dGlvbkNvbXBvbmVudFwiKTtcblx0YXNzZXJ0LmVxdWFsKGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlblsxXT8uY29uc3RydWN0b3I/Lm5hbWUsIFwiQXNzaXN0YW50TWVzc2FnZUNvbXBvbmVudFwiKTtcblxuXHRhd2FpdCBoYW5kbGVBZ2VudEV2ZW50KGhvc3QsIHsgdHlwZTogXCJtZXNzYWdlX2VuZFwiLCBtZXNzYWdlOiBtYWtlQXNzaXN0YW50KGZpbmFsQ29udGVudCkgfSBhcyBhbnkpO1xufSk7XG5cbnRlc3QoXCJjaGF0LWNvbnRyb2xsZXIgcGlucyBsYXRlc3QgYXNzaXN0YW50IHRleHQgYWJvdmUgZWRpdG9yIHdoZW4gdG9vbCBjYWxscyBhcmUgcHJlc2VudFwiLCBhc3luYyAoKSA9PiB7XG5cdChnbG9iYWxUaGlzIGFzIGFueSlbU3ltYm9sLmZvcihcIkBnc2QvcGktY29kaW5nLWFnZW50OnRoZW1lXCIpXSA9IHtcblx0XHRmZzogKF9rZXk6IHN0cmluZywgdGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuXHRcdGJnOiAoX2tleTogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG5cdFx0Ym9sZDogKHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0XHRpdGFsaWM6ICh0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG5cdFx0dHJ1bmNhdGU6ICh0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG5cdH07XG5cblx0Y29uc3QgaG9zdCA9IGNyZWF0ZUhvc3QoKTtcblx0Y29uc3QgdG9vbElkID0gXCJ0b29sLXBpbi0xXCI7XG5cdGNvbnN0IHRvb2xDYWxsID0ge1xuXHRcdHR5cGU6IFwidG9vbENhbGxcIixcblx0XHRpZDogdG9vbElkLFxuXHRcdG5hbWU6IFwiZXhlY19jb21tYW5kXCIsXG5cdFx0YXJndW1lbnRzOiB7IGNtZDogXCJlY2hvIGhpXCIgfSxcblx0fTtcblxuXHRhd2FpdCBoYW5kbGVBZ2VudEV2ZW50KGhvc3QsIHsgdHlwZTogXCJtZXNzYWdlX3N0YXJ0XCIsIG1lc3NhZ2U6IG1ha2VBc3Npc3RhbnQoW10pIH0gYXMgYW55KTtcblxuXHRhc3NlcnQuZXF1YWwoaG9zdC5waW5uZWRNZXNzYWdlQ29udGFpbmVyLmNoaWxkcmVuLmxlbmd0aCwgMCwgXCJwaW5uZWQgem9uZSBzaG91bGQgYmUgZW1wdHkgYXQgbWVzc2FnZV9zdGFydFwiKTtcblxuXHQvLyBTZW5kIGEgbWVzc2FnZSB3aXRoIHRleHQgZm9sbG93ZWQgYnkgYSB0b29sIGNhbGxcblx0aG9zdC5nZXRNYXJrZG93blRoZW1lV2l0aFNldHRpbmdzID0gKCkgPT4gKHt9KTtcblx0YXdhaXQgaGFuZGxlQWdlbnRFdmVudChcblx0XHRob3N0LFxuXHRcdHtcblx0XHRcdHR5cGU6IFwibWVzc2FnZV91cGRhdGVcIixcblx0XHRcdG1lc3NhZ2U6IG1ha2VBc3Npc3RhbnQoW1xuXHRcdFx0XHR7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkxvb2tpbmcgYXQgdGhlIGZpbGVzIG5vdy5cIiB9LFxuXHRcdFx0XHR0b29sQ2FsbCxcblx0XHRcdF0pLFxuXHRcdFx0YXNzaXN0YW50TWVzc2FnZUV2ZW50OiB7XG5cdFx0XHRcdHR5cGU6IFwidG9vbGNhbGxfZW5kXCIsXG5cdFx0XHRcdGNvbnRlbnRJbmRleDogMSxcblx0XHRcdFx0dG9vbENhbGw6IHtcblx0XHRcdFx0XHQuLi50b29sQ2FsbCxcblx0XHRcdFx0XHRleHRlcm5hbFJlc3VsdDoge1xuXHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiZmlsZSBjb250ZW50c1wiIH1dLFxuXHRcdFx0XHRcdFx0ZGV0YWlsczoge30sXG5cdFx0XHRcdFx0XHRpc0Vycm9yOiBmYWxzZSxcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHR9LFxuXHRcdFx0XHRwYXJ0aWFsOiBtYWtlQXNzaXN0YW50KFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkxvb2tpbmcgYXQgdGhlIGZpbGVzIG5vdy5cIiB9LCB0b29sQ2FsbF0pLFxuXHRcdFx0fSxcblx0XHR9IGFzIGFueSxcblx0KTtcblxuXHQvLyBQaW5uZWQgem9uZSBzaG91bGQgbm93IGhhdmUgYSBEeW5hbWljQm9yZGVyIGFuZCBhIE1hcmtkb3duIGNvbXBvbmVudFxuXHRhc3NlcnQuZXF1YWwoaG9zdC5waW5uZWRNZXNzYWdlQ29udGFpbmVyLmNoaWxkcmVuLmxlbmd0aCwgMiwgXCJwaW5uZWQgem9uZSBzaG91bGQgaGF2ZSBib3JkZXIgKyBtYXJrZG93blwiKTtcblx0YXNzZXJ0LmVxdWFsKGhvc3QucGlubmVkTWVzc2FnZUNvbnRhaW5lci5jaGlsZHJlblswXT8uY29uc3RydWN0b3I/Lm5hbWUsIFwiRHluYW1pY0JvcmRlclwiKTtcblx0YXNzZXJ0LmVxdWFsKGhvc3QucGlubmVkTWVzc2FnZUNvbnRhaW5lci5jaGlsZHJlblsxXT8uY29uc3RydWN0b3I/Lm5hbWUsIFwiTWFya2Rvd25cIik7XG59KTtcblxudGVzdChcImNoYXQtY29udHJvbGxlciBjbGVhcnMgcGlubmVkIHpvbmUgd2hlbiBhIG5ldyBhc3Npc3RhbnQgbWVzc2FnZSBzdGFydHNcIiwgYXN5bmMgKCkgPT4ge1xuXHQoZ2xvYmFsVGhpcyBhcyBhbnkpW1N5bWJvbC5mb3IoXCJAZ3NkL3BpLWNvZGluZy1hZ2VudDp0aGVtZVwiKV0gPSB7XG5cdFx0Zmc6IChfa2V5OiBzdHJpbmcsIHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0XHRiZzogKF9rZXk6IHN0cmluZywgdGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuXHRcdGJvbGQ6ICh0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG5cdFx0aXRhbGljOiAodGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuXHRcdHRydW5jYXRlOiAodGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuXHR9O1xuXG5cdGNvbnN0IGhvc3QgPSBjcmVhdGVIb3N0KCk7XG5cdGNvbnN0IHRvb2xDYWxsID0ge1xuXHRcdHR5cGU6IFwidG9vbENhbGxcIixcblx0XHRpZDogXCJ0b29sLWNsZWFyLTFcIixcblx0XHRuYW1lOiBcImV4ZWNfY29tbWFuZFwiLFxuXHRcdGFyZ3VtZW50czogeyBjbWQ6IFwiZWNobyBoaVwiIH0sXG5cdH07XG5cblx0YXdhaXQgaGFuZGxlQWdlbnRFdmVudChob3N0LCB7IHR5cGU6IFwibWVzc2FnZV9zdGFydFwiLCBtZXNzYWdlOiBtYWtlQXNzaXN0YW50KFtdKSB9IGFzIGFueSk7XG5cblx0Ly8gUG9wdWxhdGUgdGhlIHBpbm5lZCB6b25lXG5cdGhvc3QuZ2V0TWFya2Rvd25UaGVtZVdpdGhTZXR0aW5ncyA9ICgpID0+ICh7fSk7XG5cdGF3YWl0IGhhbmRsZUFnZW50RXZlbnQoXG5cdFx0aG9zdCxcblx0XHR7XG5cdFx0XHR0eXBlOiBcIm1lc3NhZ2VfdXBkYXRlXCIsXG5cdFx0XHRtZXNzYWdlOiBtYWtlQXNzaXN0YW50KFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIldvcmtpbmcgb24gaXQuXCIgfSwgdG9vbENhbGxdKSxcblx0XHRcdGFzc2lzdGFudE1lc3NhZ2VFdmVudDoge1xuXHRcdFx0XHR0eXBlOiBcInRvb2xjYWxsX2VuZFwiLFxuXHRcdFx0XHRjb250ZW50SW5kZXg6IDEsXG5cdFx0XHRcdHRvb2xDYWxsOiB7XG5cdFx0XHRcdFx0Li4udG9vbENhbGwsXG5cdFx0XHRcdFx0ZXh0ZXJuYWxSZXN1bHQ6IHtcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIm9rXCIgfV0sXG5cdFx0XHRcdFx0XHRkZXRhaWxzOiB7fSxcblx0XHRcdFx0XHRcdGlzRXJyb3I6IGZhbHNlLFxuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdH0sXG5cdFx0XHRcdHBhcnRpYWw6IG1ha2VBc3Npc3RhbnQoW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiV29ya2luZyBvbiBpdC5cIiB9LCB0b29sQ2FsbF0pLFxuXHRcdFx0fSxcblx0XHR9IGFzIGFueSxcblx0KTtcblxuXHRhc3NlcnQub2soaG9zdC5waW5uZWRNZXNzYWdlQ29udGFpbmVyLmNoaWxkcmVuLmxlbmd0aCA+IDAsIFwicGlubmVkIHpvbmUgc2hvdWxkIGJlIHBvcHVsYXRlZFwiKTtcblxuXHQvLyBTdGFydCBhIG5ldyBhc3Npc3RhbnQgbWVzc2FnZSBcdTIwMTQgcGlubmVkIHpvbmUgc2hvdWxkIGNsZWFyXG5cdGF3YWl0IGhhbmRsZUFnZW50RXZlbnQoaG9zdCwgeyB0eXBlOiBcIm1lc3NhZ2Vfc3RhcnRcIiwgbWVzc2FnZTogbWFrZUFzc2lzdGFudChbXSkgfSBhcyBhbnkpO1xuXG5cdGFzc2VydC5lcXVhbChob3N0LnBpbm5lZE1lc3NhZ2VDb250YWluZXIuY2hpbGRyZW4ubGVuZ3RoLCAwLCBcInBpbm5lZCB6b25lIHNob3VsZCBjbGVhciBvbiBuZXcgYXNzaXN0YW50IG1lc3NhZ2VcIik7XG59KTtcblxudGVzdChcImNoYXQtY29udHJvbGxlciBjbGVhcnMgcGlubmVkIHpvbmUgd2hlbiB0aGUgYWdlbnQgdHVybiBlbmRzXCIsIGFzeW5jICgpID0+IHtcblx0KGdsb2JhbFRoaXMgYXMgYW55KVtTeW1ib2wuZm9yKFwiQGdzZC9waS1jb2RpbmctYWdlbnQ6dGhlbWVcIildID0ge1xuXHRcdGZnOiAoX2tleTogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG5cdFx0Ymc6IChfa2V5OiBzdHJpbmcsIHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0XHRib2xkOiAodGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuXHRcdGl0YWxpYzogKHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0XHR0cnVuY2F0ZTogKHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0fTtcblxuXHRjb25zdCBob3N0ID0gY3JlYXRlSG9zdCgpO1xuXHRjb25zdCB0b29sQ2FsbCA9IHtcblx0XHR0eXBlOiBcInRvb2xDYWxsXCIsXG5cdFx0aWQ6IFwidG9vbC1jbGVhci1vbi1lbmQtMVwiLFxuXHRcdG5hbWU6IFwiZXhlY19jb21tYW5kXCIsXG5cdFx0YXJndW1lbnRzOiB7IGNtZDogXCJlY2hvIGhpXCIgfSxcblx0fTtcblxuXHRhd2FpdCBoYW5kbGVBZ2VudEV2ZW50KGhvc3QsIHsgdHlwZTogXCJtZXNzYWdlX3N0YXJ0XCIsIG1lc3NhZ2U6IG1ha2VBc3Npc3RhbnQoW10pIH0gYXMgYW55KTtcblxuXHRob3N0LmdldE1hcmtkb3duVGhlbWVXaXRoU2V0dGluZ3MgPSAoKSA9PiAoe30pO1xuXHRhd2FpdCBoYW5kbGVBZ2VudEV2ZW50KFxuXHRcdGhvc3QsXG5cdFx0e1xuXHRcdFx0dHlwZTogXCJtZXNzYWdlX3VwZGF0ZVwiLFxuXHRcdFx0bWVzc2FnZTogbWFrZUFzc2lzdGFudChbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJXb3JraW5nIG9uIGl0LlwiIH0sIHRvb2xDYWxsXSksXG5cdFx0XHRhc3Npc3RhbnRNZXNzYWdlRXZlbnQ6IHtcblx0XHRcdFx0dHlwZTogXCJ0b29sY2FsbF9lbmRcIixcblx0XHRcdFx0Y29udGVudEluZGV4OiAxLFxuXHRcdFx0XHR0b29sQ2FsbDoge1xuXHRcdFx0XHRcdC4uLnRvb2xDYWxsLFxuXHRcdFx0XHRcdGV4dGVybmFsUmVzdWx0OiB7XG5cdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJva1wiIH1dLFxuXHRcdFx0XHRcdFx0ZGV0YWlsczoge30sXG5cdFx0XHRcdFx0XHRpc0Vycm9yOiBmYWxzZSxcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHR9LFxuXHRcdFx0XHRwYXJ0aWFsOiBtYWtlQXNzaXN0YW50KFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIldvcmtpbmcgb24gaXQuXCIgfSwgdG9vbENhbGxdKSxcblx0XHRcdH0sXG5cdFx0fSBhcyBhbnksXG5cdCk7XG5cblx0YXNzZXJ0Lm9rKGhvc3QucGlubmVkTWVzc2FnZUNvbnRhaW5lci5jaGlsZHJlbi5sZW5ndGggPiAwLCBcInBpbm5lZCB6b25lIHNob3VsZCBiZSBwb3B1bGF0ZWQgYmVmb3JlIGFnZW50X2VuZFwiKTtcblxuXHRhd2FpdCBoYW5kbGVBZ2VudEV2ZW50KGhvc3QsIHsgdHlwZTogXCJhZ2VudF9lbmRcIiB9IGFzIGFueSk7XG5cblx0YXNzZXJ0LmVxdWFsKGhvc3QucGlubmVkTWVzc2FnZUNvbnRhaW5lci5jaGlsZHJlbi5sZW5ndGgsIDAsIFwicGlubmVkIHpvbmUgc2hvdWxkIGNsZWFyIG9uIGFnZW50X2VuZFwiKTtcbn0pO1xuXG50ZXN0KFwiY2hhdC1jb250cm9sbGVyIGNsZWFycyBwaW5uZWQgem9uZSB3aGVuIGFzc2lzdGFudCBtZXNzYWdlIGVuZHNcIiwgYXN5bmMgKCkgPT4ge1xuXHQoZ2xvYmFsVGhpcyBhcyBhbnkpW1N5bWJvbC5mb3IoXCJAZ3NkL3BpLWNvZGluZy1hZ2VudDp0aGVtZVwiKV0gPSB7XG5cdFx0Zmc6IChfa2V5OiBzdHJpbmcsIHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0XHRiZzogKF9rZXk6IHN0cmluZywgdGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuXHRcdGJvbGQ6ICh0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG5cdFx0aXRhbGljOiAodGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuXHRcdHRydW5jYXRlOiAodGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuXHR9O1xuXG5cdGNvbnN0IGhvc3QgPSBjcmVhdGVIb3N0KCk7XG5cdGNvbnN0IHRvb2xDYWxsID0ge1xuXHRcdHR5cGU6IFwidG9vbENhbGxcIixcblx0XHRpZDogXCJ0b29sLW1zZy1lbmQtMVwiLFxuXHRcdG5hbWU6IFwiZXhlY19jb21tYW5kXCIsXG5cdFx0YXJndW1lbnRzOiB7IGNtZDogXCJlY2hvIGhpXCIgfSxcblx0fTtcblxuXHRhd2FpdCBoYW5kbGVBZ2VudEV2ZW50KGhvc3QsIHsgdHlwZTogXCJtZXNzYWdlX3N0YXJ0XCIsIG1lc3NhZ2U6IG1ha2VBc3Npc3RhbnQoW10pIH0gYXMgYW55KTtcblxuXHRob3N0LmdldE1hcmtkb3duVGhlbWVXaXRoU2V0dGluZ3MgPSAoKSA9PiAoe30pO1xuXHRjb25zdCBtc2dDb250ZW50ID0gW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiU3VtbWFyeSBhZnRlciB0b29scy5cIiB9LCB0b29sQ2FsbF07XG5cdGF3YWl0IGhhbmRsZUFnZW50RXZlbnQoXG5cdFx0aG9zdCxcblx0XHR7XG5cdFx0XHR0eXBlOiBcIm1lc3NhZ2VfdXBkYXRlXCIsXG5cdFx0XHRtZXNzYWdlOiBtYWtlQXNzaXN0YW50KG1zZ0NvbnRlbnQpLFxuXHRcdFx0YXNzaXN0YW50TWVzc2FnZUV2ZW50OiB7XG5cdFx0XHRcdHR5cGU6IFwidG9vbGNhbGxfZW5kXCIsXG5cdFx0XHRcdGNvbnRlbnRJbmRleDogMSxcblx0XHRcdFx0dG9vbENhbGw6IHtcblx0XHRcdFx0XHQuLi50b29sQ2FsbCxcblx0XHRcdFx0XHRleHRlcm5hbFJlc3VsdDoge1xuXHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwib2tcIiB9XSxcblx0XHRcdFx0XHRcdGRldGFpbHM6IHt9LFxuXHRcdFx0XHRcdFx0aXNFcnJvcjogZmFsc2UsXG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0fSxcblx0XHRcdFx0cGFydGlhbDogbWFrZUFzc2lzdGFudChtc2dDb250ZW50KSxcblx0XHRcdH0sXG5cdFx0fSBhcyBhbnksXG5cdCk7XG5cblx0YXNzZXJ0Lm9rKGhvc3QucGlubmVkTWVzc2FnZUNvbnRhaW5lci5jaGlsZHJlbi5sZW5ndGggPiAwLCBcInBpbm5lZCB6b25lIHNob3VsZCBiZSBwb3B1bGF0ZWQgZHVyaW5nIHN0cmVhbWluZ1wiKTtcblxuXHQvLyBFbmQgdGhlIGFzc2lzdGFudCBtZXNzYWdlIChlLmcuIGJlZm9yZSBmb3JtIGVsaWNpdGF0aW9uKSBcdTIwMTQgcGlubmVkIHpvbmUgc2hvdWxkIGNsZWFyXG5cdGF3YWl0IGhhbmRsZUFnZW50RXZlbnQoaG9zdCwgeyB0eXBlOiBcIm1lc3NhZ2VfZW5kXCIsIG1lc3NhZ2U6IG1ha2VBc3Npc3RhbnQobXNnQ29udGVudCkgfSBhcyBhbnkpO1xuXG5cdGFzc2VydC5lcXVhbChob3N0LnBpbm5lZE1lc3NhZ2VDb250YWluZXIuY2hpbGRyZW4ubGVuZ3RoLCAwLCBcInBpbm5lZCB6b25lIHNob3VsZCBjbGVhciBvbiBtZXNzYWdlX2VuZCB0byBwcmV2ZW50IGR1cGxpY2F0ZSBkaXNwbGF5XCIpO1xufSk7XG5cbnRlc3QoXCJjaGF0LWNvbnRyb2xsZXIgZG9lcyBub3QgcGluIHdoZW4gdGhlcmUgYXJlIG5vIHRvb2wgY2FsbHNcIiwgYXN5bmMgKCkgPT4ge1xuXHQoZ2xvYmFsVGhpcyBhcyBhbnkpW1N5bWJvbC5mb3IoXCJAZ3NkL3BpLWNvZGluZy1hZ2VudDp0aGVtZVwiKV0gPSB7XG5cdFx0Zmc6IChfa2V5OiBzdHJpbmcsIHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0XHRiZzogKF9rZXk6IHN0cmluZywgdGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuXHRcdGJvbGQ6ICh0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG5cdFx0aXRhbGljOiAodGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuXHRcdHRydW5jYXRlOiAodGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuXHR9O1xuXG5cdGNvbnN0IGhvc3QgPSBjcmVhdGVIb3N0KCk7XG5cblx0YXdhaXQgaGFuZGxlQWdlbnRFdmVudChob3N0LCB7IHR5cGU6IFwibWVzc2FnZV9zdGFydFwiLCBtZXNzYWdlOiBtYWtlQXNzaXN0YW50KFtdKSB9IGFzIGFueSk7XG5cblx0aG9zdC5nZXRNYXJrZG93blRoZW1lV2l0aFNldHRpbmdzID0gKCkgPT4gKHt9KTtcblx0YXdhaXQgaGFuZGxlQWdlbnRFdmVudChcblx0XHRob3N0LFxuXHRcdHtcblx0XHRcdHR5cGU6IFwibWVzc2FnZV91cGRhdGVcIixcblx0XHRcdG1lc3NhZ2U6IG1ha2VBc3Npc3RhbnQoW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiSnVzdCBzb21lIHRleHQsIG5vIHRvb2xzLlwiIH1dKSxcblx0XHRcdGFzc2lzdGFudE1lc3NhZ2VFdmVudDoge1xuXHRcdFx0XHR0eXBlOiBcInRleHRfZGVsdGFcIixcblx0XHRcdFx0Y29udGVudEluZGV4OiAwLFxuXHRcdFx0XHRkZWx0YTogXCJKdXN0IHNvbWUgdGV4dCwgbm8gdG9vbHMuXCIsXG5cdFx0XHRcdHBhcnRpYWw6IG1ha2VBc3Npc3RhbnQoW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiSnVzdCBzb21lIHRleHQsIG5vIHRvb2xzLlwiIH1dKSxcblx0XHRcdH0sXG5cdFx0fSBhcyBhbnksXG5cdCk7XG5cblx0YXNzZXJ0LmVxdWFsKGhvc3QucGlubmVkTWVzc2FnZUNvbnRhaW5lci5jaGlsZHJlbi5sZW5ndGgsIDAsIFwicGlubmVkIHpvbmUgc2hvdWxkIHN0YXkgZW1wdHkgd2l0aG91dCB0b29sIGNhbGxzXCIpO1xufSk7XG5cbnRlc3QoXCJjaGF0LWNvbnRyb2xsZXIgcm9sbHMgdXAgb25seSBjb250aWd1b3VzIGxvdy1zaWduYWwgdG9vbCBydW5zIG9uIG1lc3NhZ2VfZW5kXCIsIGFzeW5jICgpID0+IHtcblx0KGdsb2JhbFRoaXMgYXMgYW55KVtTeW1ib2wuZm9yKFwiQGdzZC9waS1jb2RpbmctYWdlbnQ6dGhlbWVcIildID0ge1xuXHRcdGZnOiAoX2tleTogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG5cdFx0Ymc6IChfa2V5OiBzdHJpbmcsIHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0XHRib2xkOiAodGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuXHRcdGl0YWxpYzogKHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0XHR0cnVuY2F0ZTogKHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0fTtcblxuXHRjb25zdCBob3N0ID0gY3JlYXRlSG9zdCgpO1xuXHRob3N0LmdldE1hcmtkb3duVGhlbWVXaXRoU2V0dGluZ3MgPSAoKSA9PiAoe30pO1xuXG5cdGNvbnN0IHQxID0geyB0eXBlOiBcInRvb2xDYWxsXCIsIGlkOiBcInQxXCIsIG5hbWU6IFwiYmFzaFwiLCBhcmd1bWVudHM6IHsgY29tbWFuZDogXCJ0cnVlXCIgfSB9O1xuXHRjb25zdCB0MiA9IHsgdHlwZTogXCJ0b29sQ2FsbFwiLCBpZDogXCJ0MlwiLCBuYW1lOiBcImJhc2hcIiwgYXJndW1lbnRzOiB7IGNvbW1hbmQ6IFwidHJ1ZVwiIH0gfTtcblx0Y29uc3QgdGV4dCA9IHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwibWlkZGxlIG91dHB1dFwiIH07XG5cdGNvbnN0IHQzID0geyB0eXBlOiBcInRvb2xDYWxsXCIsIGlkOiBcInQzXCIsIG5hbWU6IFwicmVhZFwiLCBhcmd1bWVudHM6IHsgcGF0aDogXCIvdG1wL2FcIiB9IH07XG5cdGNvbnN0IHQ0ID0geyB0eXBlOiBcInRvb2xDYWxsXCIsIGlkOiBcInQ0XCIsIG5hbWU6IFwicmVhZFwiLCBhcmd1bWVudHM6IHsgcGF0aDogXCIvdG1wL2JcIiB9IH07XG5cdGNvbnN0IGNvbnRlbnQgPSBbdDEsIHQyLCB0ZXh0LCB0MywgdDRdO1xuXG5cdGF3YWl0IGhhbmRsZUFnZW50RXZlbnQoaG9zdCwgeyB0eXBlOiBcIm1lc3NhZ2Vfc3RhcnRcIiwgbWVzc2FnZTogbWFrZUFzc2lzdGFudChbXSkgfSBhcyBhbnkpO1xuXHRhd2FpdCBoYW5kbGVBZ2VudEV2ZW50KGhvc3QsIHtcblx0XHR0eXBlOiBcIm1lc3NhZ2VfdXBkYXRlXCIsXG5cdFx0bWVzc2FnZTogbWFrZUFzc2lzdGFudChjb250ZW50KSxcblx0XHRhc3Npc3RhbnRNZXNzYWdlRXZlbnQ6IHtcblx0XHRcdHR5cGU6IFwidGV4dF9kZWx0YVwiLFxuXHRcdFx0Y29udGVudEluZGV4OiAyLFxuXHRcdFx0ZGVsdGE6IHRleHQudGV4dCxcblx0XHRcdHBhcnRpYWw6IG1ha2VBc3Npc3RhbnQoY29udGVudCksXG5cdFx0fSxcblx0fSBhcyBhbnkpO1xuXG5cdGZvciAoY29uc3QgdG9vbCBvZiBbdDEsIHQyLCB0MywgdDRdKSB7XG5cdFx0YXdhaXQgaGFuZGxlQWdlbnRFdmVudChob3N0LCB7XG5cdFx0XHR0eXBlOiBcInRvb2xfZXhlY3V0aW9uX2VuZFwiLFxuXHRcdFx0dG9vbENhbGxJZDogdG9vbC5pZCxcblx0XHRcdGlzRXJyb3I6IGZhbHNlLFxuXHRcdFx0cmVzdWx0OiB7IGNvbnRlbnQ6IFtdLCBkZXRhaWxzOiB7fSB9LFxuXHRcdH0gYXMgYW55KTtcblx0fVxuXG5cdGF3YWl0IGhhbmRsZUFnZW50RXZlbnQoaG9zdCwgeyB0eXBlOiBcIm1lc3NhZ2VfZW5kXCIsIG1lc3NhZ2U6IG1ha2VBc3Npc3RhbnQoY29udGVudCkgfSBhcyBhbnkpO1xuXG5cdGFzc2VydC5lcXVhbChob3N0LmNoYXRDb250YWluZXIuY2hpbGRyZW4ubGVuZ3RoLCAzLCBcInR3byBzZXBhcmF0ZWQgdG9vbCBydW5zIHNob3VsZCBiZWNvbWUgdHdvIHN1bW1hcmllcyBhcm91bmQgdGV4dFwiKTtcblx0YXNzZXJ0LmVxdWFsKGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlblswXT8uY29uc3RydWN0b3I/Lm5hbWUsIFwiVG9vbFBoYXNlU3VtbWFyeUNvbXBvbmVudFwiKTtcblx0YXNzZXJ0LmVxdWFsKGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlblsxXT8uY29uc3RydWN0b3I/Lm5hbWUsIFwiQXNzaXN0YW50TWVzc2FnZUNvbXBvbmVudFwiKTtcblx0YXNzZXJ0LmVxdWFsKGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlblsyXT8uY29uc3RydWN0b3I/Lm5hbWUsIFwiVG9vbFBoYXNlU3VtbWFyeUNvbXBvbmVudFwiKTtcblx0YXNzZXJ0Lm1hdGNoKGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlblswXS5yZW5kZXIoMTIwKS5qb2luKFwiXFxuXCIpLCAvU2V0dXAgXFwvIHNoZWxsIDIgYWN0aW9ucy8pO1xuXHRjb25zdCByZWFkU3VtbWFyeSA9IGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlblsyXS5yZW5kZXIoMTIwKS5qb2luKFwiXFxuXCIpO1xuXHRhc3NlcnQubWF0Y2gocmVhZFN1bW1hcnksIC9Db250ZXh0IHJlYWRzIFx1MDBCNyAyIGZpbGVzLyk7XG5cdGFzc2VydC5tYXRjaChyZWFkU3VtbWFyeSwgL1xcL3RtcFxcL2EgXHUwMEI3IFxcL3RtcFxcL2IvKTtcblx0YXNzZXJ0LmVxdWFsKGhvc3QuY2hhdENvbnRhaW5lci5fcHJldlJlbmRlciwgbnVsbCwgXCJzdW1tYXJ5IHJlcG9zaXRpb24gbXVzdCBpbnZhbGlkYXRlIHRoZSBjaGF0IGNvbnRhaW5lciByZW5kZXIgY2FjaGVcIik7XG59KTtcblxudGVzdChcImNoYXQtY29udHJvbGxlciByb2xscyB1cCBsb3ctc2lnbmFsIGRpcmVjdCB0b29sIGV4ZWN1dGlvbiBldmVudHMgb24gYWdlbnRfZW5kXCIsIGFzeW5jICgpID0+IHtcblx0KGdsb2JhbFRoaXMgYXMgYW55KVtTeW1ib2wuZm9yKFwiQGdzZC9waS1jb2RpbmctYWdlbnQ6dGhlbWVcIildID0ge1xuXHRcdGZnOiAoX2tleTogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG5cdFx0Ymc6IChfa2V5OiBzdHJpbmcsIHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0XHRib2xkOiAodGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuXHRcdGl0YWxpYzogKHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0XHR0cnVuY2F0ZTogKHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0fTtcblxuXHRjb25zdCBob3N0ID0gY3JlYXRlSG9zdCgpO1xuXHRob3N0LmdldE1hcmtkb3duVGhlbWVXaXRoU2V0dGluZ3MgPSAoKSA9PiAoe30pO1xuXG5cdGZvciAoY29uc3QgdG9vbENhbGxJZCBvZiBbXCJiYXNoLTFcIiwgXCJiYXNoLTJcIiwgXCJiYXNoLTNcIl0pIHtcblx0XHRhd2FpdCBoYW5kbGVBZ2VudEV2ZW50KGhvc3QsIHtcblx0XHRcdHR5cGU6IFwidG9vbF9leGVjdXRpb25fc3RhcnRcIixcblx0XHRcdHRvb2xDYWxsSWQsXG5cdFx0XHR0b29sTmFtZTogXCJiYXNoXCIsXG5cdFx0XHRhcmdzOiB7IGNvbW1hbmQ6IFwidHJ1ZVwiIH0sXG5cdFx0fSBhcyBhbnkpO1xuXHRcdGF3YWl0IGhhbmRsZUFnZW50RXZlbnQoaG9zdCwge1xuXHRcdFx0dHlwZTogXCJ0b29sX2V4ZWN1dGlvbl9lbmRcIixcblx0XHRcdHRvb2xDYWxsSWQsXG5cdFx0XHRpc0Vycm9yOiBmYWxzZSxcblx0XHRcdHJlc3VsdDogeyBjb250ZW50OiBbXSwgZGV0YWlsczoge30gfSxcblx0XHR9IGFzIGFueSk7XG5cdH1cblxuXHRhc3NlcnQuZXF1YWwoaG9zdC5jaGF0Q29udGFpbmVyLmNoaWxkcmVuLmxlbmd0aCwgMSwgXCJkaXJlY3QgdG9vbCBldmVudHMgcm9sbCB1cCBhcyB0aGV5IGZpbmlzaFwiKTtcblx0YXNzZXJ0LmVxdWFsKGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlblswXT8uY29uc3RydWN0b3I/Lm5hbWUsIFwiVG9vbFBoYXNlU3VtbWFyeUNvbXBvbmVudFwiKTtcblx0YXNzZXJ0Lm1hdGNoKGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlblswXS5yZW5kZXIoMTIwKS5qb2luKFwiXFxuXCIpLCAvU2V0dXAgXFwvIHNoZWxsIDMgYWN0aW9ucy8pO1xuXG5cdGF3YWl0IGhhbmRsZUFnZW50RXZlbnQoaG9zdCwgeyB0eXBlOiBcImFnZW50X2VuZFwiIH0gYXMgYW55KTtcblxuXHRhc3NlcnQuZXF1YWwoaG9zdC5jaGF0Q29udGFpbmVyLmNoaWxkcmVuLmxlbmd0aCwgMSwgXCJkaXJlY3QgbG93LXNpZ25hbCB0b29sIHJvd3Mgc2hvdWxkIHJvbGwgdXAgb24gYWdlbnRfZW5kXCIpO1xuXHRhc3NlcnQuZXF1YWwoaG9zdC5jaGF0Q29udGFpbmVyLmNoaWxkcmVuWzBdPy5jb25zdHJ1Y3Rvcj8ubmFtZSwgXCJUb29sUGhhc2VTdW1tYXJ5Q29tcG9uZW50XCIpO1xuXHRhc3NlcnQubWF0Y2goaG9zdC5jaGF0Q29udGFpbmVyLmNoaWxkcmVuWzBdLnJlbmRlcigxMjApLmpvaW4oXCJcXG5cIiksIC9TZXR1cCBcXC8gc2hlbGwgMyBhY3Rpb25zLyk7XG59KTtcblxuLy8gUmVncmVzc2lvbiB0ZXN0IGZvciBpc3N1ZSAjNDE0NDogaW50ZXJsZWF2ZWQgdGV4dC90b29sIGNvbnRlbnQgbXVzdCByZW5kZXIgaW4gY29udGVudFtdIGluZGV4IG9yZGVyLlxuLy8gU3RyZWFtOiBbdGV4dCBcIkFcIiwgdG9vbENhbGwgVDEsIHRleHQgXCJCXCIsIHRvb2xDYWxsIFQyLCB0ZXh0IFwiQ1wiXVxuLy8gRXhwZWN0ZWQgY2hhdENvbnRhaW5lciBvcmRlcjogdGV4dFJ1bihBKSwgdG9vbEV4ZWMoVDEpLCB0ZXh0UnVuKEIpLCB0b29sRXhlYyhUMiksIHRleHRSdW4oQylcbi8vIEVhY2ggQXNzaXN0YW50TWVzc2FnZUNvbXBvbmVudCBtdXN0IHJlbmRlciBPTkxZIGl0cyBvd24gdGV4dCBcdTIwMTQgbm8gZHVwbGljYXRpb24gYWZ0ZXIgbWVzc2FnZV9lbmQuXG50ZXN0KFwiY2hhdC1jb250cm9sbGVyIHJlbmRlcnMgaW50ZXJsZWF2ZWQgdGV4dCBhbmQgdG9vbCBibG9ja3MgaW4gY29udGVudFtdIGluZGV4IG9yZGVyICgjNDE0NClcIiwgYXN5bmMgKCkgPT4ge1xuXHQoZ2xvYmFsVGhpcyBhcyBhbnkpW1N5bWJvbC5mb3IoXCJAZ3NkL3BpLWNvZGluZy1hZ2VudDp0aGVtZVwiKV0gPSB7XG5cdFx0Zmc6IChfa2V5OiBzdHJpbmcsIHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0XHRiZzogKF9rZXk6IHN0cmluZywgdGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuXHRcdGJvbGQ6ICh0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG5cdFx0aXRhbGljOiAodGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuXHRcdHRydW5jYXRlOiAodGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuXHR9O1xuXG5cdGNvbnN0IGhvc3QgPSBjcmVhdGVIb3N0KCk7XG5cdGhvc3QuZ2V0TWFya2Rvd25UaGVtZVdpdGhTZXR0aW5ncyA9ICgpID0+ICh7fSk7XG5cblx0Y29uc3QgdDEgPSB7IHR5cGU6IFwidG9vbENhbGxcIiwgaWQ6IFwidDFcIiwgbmFtZTogXCJ0b29sX29uZVwiLCBhcmd1bWVudHM6IHt9IH07XG5cdGNvbnN0IHQyID0geyB0eXBlOiBcInRvb2xDYWxsXCIsIGlkOiBcInQyXCIsIG5hbWU6IFwidG9vbF90d29cIiwgYXJndW1lbnRzOiB7fSB9O1xuXG5cdGF3YWl0IGhhbmRsZUFnZW50RXZlbnQoaG9zdCwgeyB0eXBlOiBcIm1lc3NhZ2Vfc3RhcnRcIiwgbWVzc2FnZTogbWFrZUFzc2lzdGFudChbXSkgfSBhcyBhbnkpO1xuXG5cdC8vIFN0cmVhbSB0ZXh0IFwiQVwiIGF0IGluZGV4IDBcblx0YXdhaXQgaGFuZGxlQWdlbnRFdmVudChob3N0LCB7XG5cdFx0dHlwZTogXCJtZXNzYWdlX3VwZGF0ZVwiLFxuXHRcdG1lc3NhZ2U6IG1ha2VBc3Npc3RhbnQoW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiQVwiIH1dKSxcblx0XHRhc3Npc3RhbnRNZXNzYWdlRXZlbnQ6IHtcblx0XHRcdHR5cGU6IFwidGV4dF9kZWx0YVwiLFxuXHRcdFx0Y29udGVudEluZGV4OiAwLFxuXHRcdFx0ZGVsdGE6IFwiQVwiLFxuXHRcdFx0cGFydGlhbDogbWFrZUFzc2lzdGFudChbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJBXCIgfV0pLFxuXHRcdH0sXG5cdH0gYXMgYW55KTtcblxuXHQvLyBTdHJlYW0gdG9vbENhbGwgVDEgYXQgaW5kZXggMVxuXHRhd2FpdCBoYW5kbGVBZ2VudEV2ZW50KGhvc3QsIHtcblx0XHR0eXBlOiBcIm1lc3NhZ2VfdXBkYXRlXCIsXG5cdFx0bWVzc2FnZTogbWFrZUFzc2lzdGFudChbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJBXCIgfSwgdDFdKSxcblx0XHRhc3Npc3RhbnRNZXNzYWdlRXZlbnQ6IHtcblx0XHRcdHR5cGU6IFwidG9vbGNhbGxfZW5kXCIsXG5cdFx0XHRjb250ZW50SW5kZXg6IDEsXG5cdFx0XHR0b29sQ2FsbDoge1xuXHRcdFx0XHQuLi50MSxcblx0XHRcdFx0ZXh0ZXJuYWxSZXN1bHQ6IHsgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwicmVzdWx0MVwiIH1dLCBkZXRhaWxzOiB7fSwgaXNFcnJvcjogZmFsc2UgfSxcblx0XHRcdH0sXG5cdFx0XHRwYXJ0aWFsOiBtYWtlQXNzaXN0YW50KFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkFcIiB9LCB0MV0pLFxuXHRcdH0sXG5cdH0gYXMgYW55KTtcblxuXHQvLyBTdHJlYW0gdGV4dCBcIkJcIiBhdCBpbmRleCAyXG5cdGF3YWl0IGhhbmRsZUFnZW50RXZlbnQoaG9zdCwge1xuXHRcdHR5cGU6IFwibWVzc2FnZV91cGRhdGVcIixcblx0XHRtZXNzYWdlOiBtYWtlQXNzaXN0YW50KFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkFcIiB9LCB0MSwgeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJCXCIgfV0pLFxuXHRcdGFzc2lzdGFudE1lc3NhZ2VFdmVudDoge1xuXHRcdFx0dHlwZTogXCJ0ZXh0X2RlbHRhXCIsXG5cdFx0XHRjb250ZW50SW5kZXg6IDIsXG5cdFx0XHRkZWx0YTogXCJCXCIsXG5cdFx0XHRwYXJ0aWFsOiBtYWtlQXNzaXN0YW50KFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkFcIiB9LCB0MSwgeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJCXCIgfV0pLFxuXHRcdH0sXG5cdH0gYXMgYW55KTtcblxuXHQvLyBTdHJlYW0gdG9vbENhbGwgVDIgYXQgaW5kZXggM1xuXHRhd2FpdCBoYW5kbGVBZ2VudEV2ZW50KGhvc3QsIHtcblx0XHR0eXBlOiBcIm1lc3NhZ2VfdXBkYXRlXCIsXG5cdFx0bWVzc2FnZTogbWFrZUFzc2lzdGFudChbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJBXCIgfSwgdDEsIHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiQlwiIH0sIHQyXSksXG5cdFx0YXNzaXN0YW50TWVzc2FnZUV2ZW50OiB7XG5cdFx0XHR0eXBlOiBcInRvb2xjYWxsX2VuZFwiLFxuXHRcdFx0Y29udGVudEluZGV4OiAzLFxuXHRcdFx0dG9vbENhbGw6IHtcblx0XHRcdFx0Li4udDIsXG5cdFx0XHRcdGV4dGVybmFsUmVzdWx0OiB7IGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcInJlc3VsdDJcIiB9XSwgZGV0YWlsczoge30sIGlzRXJyb3I6IGZhbHNlIH0sXG5cdFx0XHR9LFxuXHRcdFx0cGFydGlhbDogbWFrZUFzc2lzdGFudChbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJBXCIgfSwgdDEsIHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiQlwiIH0sIHQyXSksXG5cdFx0fSxcblx0fSBhcyBhbnkpO1xuXG5cdC8vIFN0cmVhbSB0ZXh0IFwiQ1wiIGF0IGluZGV4IDRcblx0Y29uc3QgZmluYWxDb250ZW50ID0gW1xuXHRcdHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiQVwiIH0sIHQxLCB7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkJcIiB9LCB0MiwgeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJDXCIgfSxcblx0XTtcblx0YXdhaXQgaGFuZGxlQWdlbnRFdmVudChob3N0LCB7XG5cdFx0dHlwZTogXCJtZXNzYWdlX3VwZGF0ZVwiLFxuXHRcdG1lc3NhZ2U6IG1ha2VBc3Npc3RhbnQoZmluYWxDb250ZW50KSxcblx0XHRhc3Npc3RhbnRNZXNzYWdlRXZlbnQ6IHtcblx0XHRcdHR5cGU6IFwidGV4dF9kZWx0YVwiLFxuXHRcdFx0Y29udGVudEluZGV4OiA0LFxuXHRcdFx0ZGVsdGE6IFwiQ1wiLFxuXHRcdFx0cGFydGlhbDogbWFrZUFzc2lzdGFudChmaW5hbENvbnRlbnQpLFxuXHRcdH0sXG5cdH0gYXMgYW55KTtcblxuXHQvLyBGaW5hbGl6ZSBcdTIwMTQgZXhlcmNpc2VzIHRoZSBtZXNzYWdlX2VuZCBwYXRoIHdoZXJlIGEgYnVnZ3kgc2V0UmFuZ2UodW5kZWZpbmVkKSB3b3VsZCBjYXVzZSBkdXBsaWNhdGlvblxuXHRhd2FpdCBoYW5kbGVBZ2VudEV2ZW50KGhvc3QsIHsgdHlwZTogXCJtZXNzYWdlX2VuZFwiLCBtZXNzYWdlOiBtYWtlQXNzaXN0YW50KGZpbmFsQ29udGVudCkgfSBhcyBhbnkpO1xuXG5cdC8vIEFzc2VydCBpbnRlcmxlYXZlZCBvcmRlcjogdGV4dFJ1bihBKSwgdG9vbEV4ZWMoVDEpLCB0ZXh0UnVuKEIpLCB0b29sRXhlYyhUMiksIHRleHRSdW4oQylcblx0YXNzZXJ0LmVxdWFsKGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlbi5sZW5ndGgsIDUsIFwic2hvdWxkIGhhdmUgNSBjaGlsZHJlbiBpbiBpbnRlcmxlYXZlZCBvcmRlclwiKTtcblx0YXNzZXJ0LmVxdWFsKGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlblswXT8uY29uc3RydWN0b3I/Lm5hbWUsIFwiQXNzaXN0YW50TWVzc2FnZUNvbXBvbmVudFwiLCBcImluZGV4IDA6IHRleHQgcnVuIEFcIik7XG5cdGFzc2VydC5lcXVhbChob3N0LmNoYXRDb250YWluZXIuY2hpbGRyZW5bMV0/LmNvbnN0cnVjdG9yPy5uYW1lLCBcIlRvb2xFeGVjdXRpb25Db21wb25lbnRcIiwgXCJpbmRleCAxOiB0b29sIFQxXCIpO1xuXHRhc3NlcnQuZXF1YWwoaG9zdC5jaGF0Q29udGFpbmVyLmNoaWxkcmVuWzJdPy5jb25zdHJ1Y3Rvcj8ubmFtZSwgXCJBc3Npc3RhbnRNZXNzYWdlQ29tcG9uZW50XCIsIFwiaW5kZXggMjogdGV4dCBydW4gQlwiKTtcblx0YXNzZXJ0LmVxdWFsKGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlblszXT8uY29uc3RydWN0b3I/Lm5hbWUsIFwiVG9vbEV4ZWN1dGlvbkNvbXBvbmVudFwiLCBcImluZGV4IDM6IHRvb2wgVDJcIik7XG5cdGFzc2VydC5lcXVhbChob3N0LmNoYXRDb250YWluZXIuY2hpbGRyZW5bNF0/LmNvbnN0cnVjdG9yPy5uYW1lLCBcIkFzc2lzdGFudE1lc3NhZ2VDb21wb25lbnRcIiwgXCJpbmRleCA0OiB0ZXh0IHJ1biBDXCIpO1xuXG5cdC8vIEhlbHBlcjogY29sbGVjdCB0aGUgdGV4dCBvZiBhbGwgTWFya2Rvd24gY2hpbGRyZW4gaW5zaWRlIGFuIEFzc2lzdGFudE1lc3NhZ2VDb21wb25lbnQuXG5cdC8vIFN0cnVjdHVyZTogQXNzaXN0YW50TWVzc2FnZUNvbXBvbmVudCAoQ29udGFpbmVyKSAtPiBjb250ZW50Q29udGFpbmVyIChjaGlsZHJlblswXSkgLT4gTWFya2Rvd24gbm9kZXMuXG5cdGZ1bmN0aW9uIGdldFJlbmRlcmVkVGV4dHMoY29tcDogYW55KTogc3RyaW5nW10ge1xuXHRcdGNvbnN0IGNvbnRlbnRDb250YWluZXIgPSBjb21wLmNoaWxkcmVuPy5bMF07XG5cdFx0aWYgKCFjb250ZW50Q29udGFpbmVyKSByZXR1cm4gW107XG5cdFx0cmV0dXJuIChjb250ZW50Q29udGFpbmVyLmNoaWxkcmVuID8/IFtdKVxuXHRcdFx0LmZpbHRlcigoYzogYW55KSA9PiBjLmNvbnN0cnVjdG9yPy5uYW1lID09PSBcIk1hcmtkb3duXCIpXG5cdFx0XHQubWFwKChjOiBhbnkpID0+IChjIGFzIGFueSkudGV4dCBhcyBzdHJpbmcpO1xuXHR9XG5cblx0Ly8gRWFjaCB0ZXh0LXJ1biBjb21wb25lbnQgbXVzdCBjb250YWluIG9ubHkgaXRzIG93biB0ZXh0IFx1MjAxNCBubyBjcm9zcy1jb250YW1pbmF0aW9uIGFmdGVyIG1lc3NhZ2VfZW5kXG5cdGFzc2VydC5kZWVwRXF1YWwoZ2V0UmVuZGVyZWRUZXh0cyhob3N0LmNoYXRDb250YWluZXIuY2hpbGRyZW5bMF0pLCBbXCJBXCJdLCBcInRleHQgcnVuIEEgbXVzdCBjb250YWluIG9ubHkgJ0EnXCIpO1xuXHRhc3NlcnQuZGVlcEVxdWFsKGdldFJlbmRlcmVkVGV4dHMoaG9zdC5jaGF0Q29udGFpbmVyLmNoaWxkcmVuWzJdKSwgW1wiQlwiXSwgXCJ0ZXh0IHJ1biBCIG11c3QgY29udGFpbiBvbmx5ICdCJ1wiKTtcblx0YXNzZXJ0LmRlZXBFcXVhbChnZXRSZW5kZXJlZFRleHRzKGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlbls0XSksIFtcIkNcIl0sIFwidGV4dCBydW4gQyBtdXN0IGNvbnRhaW4gb25seSAnQydcIik7XG59KTtcblxudGVzdChcImNoYXQtY29udHJvbGxlciBkb2VzIG5vdCBkdXBsaWNhdGUgdGV4dCB3aGVuIGNvbnRlbnQgaXMgW3RleHQsIHRvb2wsIHRleHRdIChpbnRlcmxlYXZlZCBzdHJlYW0pXCIsIGFzeW5jICgpID0+IHtcblx0KGdsb2JhbFRoaXMgYXMgYW55KVtTeW1ib2wuZm9yKFwiQGdzZC9waS1jb2RpbmctYWdlbnQ6dGhlbWVcIildID0ge1xuXHRcdGZnOiAoX2tleTogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG5cdFx0Ymc6IChfa2V5OiBzdHJpbmcsIHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0XHRib2xkOiAodGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuXHRcdGl0YWxpYzogKHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0XHR0cnVuY2F0ZTogKHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0fTtcblxuXHRjb25zdCBob3N0ID0gY3JlYXRlSG9zdCgpO1xuXHRob3N0LmdldE1hcmtkb3duVGhlbWVXaXRoU2V0dGluZ3MgPSAoKSA9PiAoe30pO1xuXG5cdGNvbnN0IHQxID0geyB0eXBlOiBcInRvb2xDYWxsXCIsIGlkOiBcInQxXCIsIG5hbWU6IFwidG9vbF9vbmVcIiwgYXJndW1lbnRzOiB7fSB9O1xuXG5cdGF3YWl0IGhhbmRsZUFnZW50RXZlbnQoaG9zdCwgeyB0eXBlOiBcIm1lc3NhZ2Vfc3RhcnRcIiwgbWVzc2FnZTogbWFrZUFzc2lzdGFudChbXSkgfSBhcyBhbnkpO1xuXG5cdC8vIFN0ZXAgMTogdGV4dCBcIkFcIiBhdCBpbmRleCAwXG5cdGF3YWl0IGhhbmRsZUFnZW50RXZlbnQoaG9zdCwge1xuXHRcdHR5cGU6IFwibWVzc2FnZV91cGRhdGVcIixcblx0XHRtZXNzYWdlOiBtYWtlQXNzaXN0YW50KFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkFcIiB9XSksXG5cdFx0YXNzaXN0YW50TWVzc2FnZUV2ZW50OiB7XG5cdFx0XHR0eXBlOiBcInRleHRfZGVsdGFcIixcblx0XHRcdGNvbnRlbnRJbmRleDogMCxcblx0XHRcdGRlbHRhOiBcIkFcIixcblx0XHRcdHBhcnRpYWw6IG1ha2VBc3Npc3RhbnQoW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiQVwiIH1dKSxcblx0XHR9LFxuXHR9IGFzIGFueSk7XG5cblx0Ly8gU3RlcCAyOiB0b29sQ2FsbCBhdCBpbmRleCAxXG5cdGF3YWl0IGhhbmRsZUFnZW50RXZlbnQoaG9zdCwge1xuXHRcdHR5cGU6IFwibWVzc2FnZV91cGRhdGVcIixcblx0XHRtZXNzYWdlOiBtYWtlQXNzaXN0YW50KFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkFcIiB9LCB0MV0pLFxuXHRcdGFzc2lzdGFudE1lc3NhZ2VFdmVudDoge1xuXHRcdFx0dHlwZTogXCJ0b29sY2FsbF9lbmRcIixcblx0XHRcdGNvbnRlbnRJbmRleDogMSxcblx0XHRcdHRvb2xDYWxsOiB7XG5cdFx0XHRcdC4uLnQxLFxuXHRcdFx0XHRleHRlcm5hbFJlc3VsdDogeyBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJyZXN1bHQxXCIgfV0sIGRldGFpbHM6IHt9LCBpc0Vycm9yOiBmYWxzZSB9LFxuXHRcdFx0fSxcblx0XHRcdHBhcnRpYWw6IG1ha2VBc3Npc3RhbnQoW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiQVwiIH0sIHQxXSksXG5cdFx0fSxcblx0fSBhcyBhbnkpO1xuXG5cdC8vIFN0ZXAgMzogdGV4dCBcIkJcIiBhdCBpbmRleCAyXG5cdGNvbnN0IGZpbmFsQ29udGVudCA9IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkFcIiB9LCB0MSwgeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJCXCIgfV07XG5cdGF3YWl0IGhhbmRsZUFnZW50RXZlbnQoaG9zdCwge1xuXHRcdHR5cGU6IFwibWVzc2FnZV91cGRhdGVcIixcblx0XHRtZXNzYWdlOiBtYWtlQXNzaXN0YW50KGZpbmFsQ29udGVudCksXG5cdFx0YXNzaXN0YW50TWVzc2FnZUV2ZW50OiB7XG5cdFx0XHR0eXBlOiBcInRleHRfZGVsdGFcIixcblx0XHRcdGNvbnRlbnRJbmRleDogMixcblx0XHRcdGRlbHRhOiBcIkJcIixcblx0XHRcdHBhcnRpYWw6IG1ha2VBc3Npc3RhbnQoZmluYWxDb250ZW50KSxcblx0XHR9LFxuXHR9IGFzIGFueSk7XG5cblx0YXNzZXJ0LmVxdWFsKGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlbi5sZW5ndGgsIDMpO1xuXHRhc3NlcnQuZXF1YWwoaG9zdC5jaGF0Q29udGFpbmVyLmNoaWxkcmVuWzBdPy5jb25zdHJ1Y3Rvcj8ubmFtZSwgXCJBc3Npc3RhbnRNZXNzYWdlQ29tcG9uZW50XCIpO1xuXHRhc3NlcnQuZXF1YWwoaG9zdC5jaGF0Q29udGFpbmVyLmNoaWxkcmVuWzFdPy5jb25zdHJ1Y3Rvcj8ubmFtZSwgXCJUb29sRXhlY3V0aW9uQ29tcG9uZW50XCIpO1xuXHRhc3NlcnQuZXF1YWwoaG9zdC5jaGF0Q29udGFpbmVyLmNoaWxkcmVuWzJdPy5jb25zdHJ1Y3Rvcj8ubmFtZSwgXCJBc3Npc3RhbnRNZXNzYWdlQ29tcG9uZW50XCIpO1xuXG5cdGNvbnN0IGZpcnN0VGV4dCA9IGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlblswXTtcblx0Y29uc3Qgc2Vjb25kVGV4dCA9IGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlblsyXTtcblx0YXNzZXJ0Lm5vdEVxdWFsKGZpcnN0VGV4dCwgc2Vjb25kVGV4dCwgXCJ0ZXh0LWJlZm9yZS10b29sIGFuZCB0ZXh0LWFmdGVyLXRvb2wgbXVzdCBiZSBzZXBhcmF0ZSBjb21wb25lbnQgaW5zdGFuY2VzXCIpO1xuXHRhc3NlcnQuZGVlcEVxdWFsKChmaXJzdFRleHQgYXMgYW55KS5yYW5nZSwgeyBzdGFydEluZGV4OiAwLCBlbmRJbmRleDogMCB9LCBcImZpcnN0IHRleHQtcnVuIGNvdmVycyBvbmx5IGNvbnRlbnRbMF1cIik7XG5cdGFzc2VydC5kZWVwRXF1YWwoKHNlY29uZFRleHQgYXMgYW55KS5yYW5nZSwgeyBzdGFydEluZGV4OiAyLCBlbmRJbmRleDogMiB9LCBcInNlY29uZCB0ZXh0LXJ1biBjb3ZlcnMgb25seSBjb250ZW50WzJdXCIpO1xuXG5cdC8vIEZpbmFsaXplIFx1MjAxNCByZWdyZXNzaW9uIGd1YXJkOiByYW5nZSBtdXN0IE5PVCBiZSBjbGVhcmVkIG9uIG1lc3NhZ2VfZW5kICh3b3VsZCBjYXVzZSBkdXBsaWNhdGlvbilcblx0YXdhaXQgaGFuZGxlQWdlbnRFdmVudChob3N0LCB7IHR5cGU6IFwibWVzc2FnZV9lbmRcIiwgbWVzc2FnZTogbWFrZUFzc2lzdGFudChmaW5hbENvbnRlbnQpIH0gYXMgYW55KTtcblxuXHRhc3NlcnQuZGVlcEVxdWFsKChzZWNvbmRUZXh0IGFzIGFueSkucmFuZ2UsIHsgc3RhcnRJbmRleDogMiwgZW5kSW5kZXg6IDIgfSwgXCJyYW5nZSBtdXN0IG5vdCBiZSBjbGVhcmVkIG9uIG1lc3NhZ2VfZW5kICh3b3VsZCBjYXVzZSBkdXBsaWNhdGlvbilcIik7XG59KTtcblxuLy8gUmVncmVzc2lvbiBmb3IgdGhlIGNsYXVkZS1jb2RlIHN1Yi10dXJuIGJ1ZyB0aGF0IGZvbGxvd2VkICM0MTQ0OlxuLy8gYW4gYWRhcHRlciBjYW4gcmVzZXQgY29udGVudFtdIGJhY2sgdG8gMC8xIG1pZC1saWZlY3ljbGUgd2hlbiBhIG5ldyBwcm92aWRlclxuLy8gc3ViLXR1cm4gYmVnaW5zLiBUaGUgc2VnbWVudCB3YWxrZXIgbXVzdCBOT1QgdXBkYXRlIHByaW9yLXN1Yi10dXJuIHRleHQtcnVuXG4vLyBjb21wb25lbnRzIGluIHBsYWNlICh3aGljaCB3b3VsZCBkZXN0cm95IGVhcmxpZXIgaGlzdG9yeSkgYW5kIG11c3QgTk9UIHJldXNlXG4vLyBzdGFsZSB0b29sIHJlZ2lzdHJhdGlvbnMgZm9yIGEgbmV3IHRvb2wgYXQgdGhlIHNhbWUgY29udGVudEluZGV4LiBQcmlvclxuLy8gc3ViLXR1cm4gY2hpbGRyZW4gbXVzdCBzdGF5IGZyb3plbjsgbmV3IHN1Yi10dXJuIHNlZ21lbnRzIG11c3QgYXBwZW5kIGFmdGVyXG4vLyB0aGVtLCBhbmQgdGhlIHBpbm5lZCBcIkxhdGVzdCBPdXRwdXRcIiBtaXJyb3IgbXVzdCByZS1ldmFsdWF0ZSBmb3IgdGhlIG5ldyBzdWItdHVybi5cbnRlc3QoXCJjaGF0LWNvbnRyb2xsZXIgZnJlZXplcyBwcmlvciBzdWItdHVybiBhbmQgYXBwZW5kcyBuZXcgc2VnbWVudHMgd2hlbiBjb250ZW50IHNocmlua3NcIiwgYXN5bmMgKCkgPT4ge1xuXHQoZ2xvYmFsVGhpcyBhcyBhbnkpW1N5bWJvbC5mb3IoXCJAZ3NkL3BpLWNvZGluZy1hZ2VudDp0aGVtZVwiKV0gPSB7XG5cdFx0Zmc6IChfa2V5OiBzdHJpbmcsIHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0XHRiZzogKF9rZXk6IHN0cmluZywgdGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuXHRcdGJvbGQ6ICh0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG5cdFx0aXRhbGljOiAodGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuXHRcdHRydW5jYXRlOiAodGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuXHR9O1xuXG5cdGNvbnN0IGhvc3QgPSBjcmVhdGVIb3N0KCk7XG5cdGhvc3QuZ2V0TWFya2Rvd25UaGVtZVdpdGhTZXR0aW5ncyA9ICgpID0+ICh7fSk7XG5cblx0Y29uc3QgdDEgPSB7IHR5cGU6IFwidG9vbENhbGxcIiwgaWQ6IFwidDFcIiwgbmFtZTogXCJ0b29sX29uZVwiLCBhcmd1bWVudHM6IHt9IH07XG5cdGNvbnN0IHQyID0geyB0eXBlOiBcInRvb2xDYWxsXCIsIGlkOiBcInQyXCIsIG5hbWU6IFwidG9vbF90d29cIiwgYXJndW1lbnRzOiB7fSB9O1xuXG5cdGF3YWl0IGhhbmRsZUFnZW50RXZlbnQoaG9zdCwgeyB0eXBlOiBcIm1lc3NhZ2Vfc3RhcnRcIiwgbWVzc2FnZTogbWFrZUFzc2lzdGFudChbXSkgfSBhcyBhbnkpO1xuXG5cdC8vIFN1Yi10dXJuIDE6IGdyb3cgdG8gW0EsIFQxLCBCXVxuXHRhd2FpdCBoYW5kbGVBZ2VudEV2ZW50KGhvc3QsIHtcblx0XHR0eXBlOiBcIm1lc3NhZ2VfdXBkYXRlXCIsXG5cdFx0bWVzc2FnZTogbWFrZUFzc2lzdGFudChbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJBXCIgfV0pLFxuXHRcdGFzc2lzdGFudE1lc3NhZ2VFdmVudDoge1xuXHRcdFx0dHlwZTogXCJ0ZXh0X2RlbHRhXCIsIGNvbnRlbnRJbmRleDogMCwgZGVsdGE6IFwiQVwiLFxuXHRcdFx0cGFydGlhbDogbWFrZUFzc2lzdGFudChbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJBXCIgfV0pLFxuXHRcdH0sXG5cdH0gYXMgYW55KTtcblx0YXdhaXQgaGFuZGxlQWdlbnRFdmVudChob3N0LCB7XG5cdFx0dHlwZTogXCJtZXNzYWdlX3VwZGF0ZVwiLFxuXHRcdG1lc3NhZ2U6IG1ha2VBc3Npc3RhbnQoW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiQVwiIH0sIHQxXSksXG5cdFx0YXNzaXN0YW50TWVzc2FnZUV2ZW50OiB7XG5cdFx0XHR0eXBlOiBcInRvb2xjYWxsX2VuZFwiLCBjb250ZW50SW5kZXg6IDEsXG5cdFx0XHR0b29sQ2FsbDogeyAuLi50MSwgZXh0ZXJuYWxSZXN1bHQ6IHsgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwicjFcIiB9XSwgZGV0YWlsczoge30sIGlzRXJyb3I6IGZhbHNlIH0gfSxcblx0XHRcdHBhcnRpYWw6IG1ha2VBc3Npc3RhbnQoW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiQVwiIH0sIHQxXSksXG5cdFx0fSxcblx0fSBhcyBhbnkpO1xuXHRhd2FpdCBoYW5kbGVBZ2VudEV2ZW50KGhvc3QsIHtcblx0XHR0eXBlOiBcIm1lc3NhZ2VfdXBkYXRlXCIsXG5cdFx0bWVzc2FnZTogbWFrZUFzc2lzdGFudChbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJBXCIgfSwgdDEsIHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiQlwiIH1dKSxcblx0XHRhc3Npc3RhbnRNZXNzYWdlRXZlbnQ6IHtcblx0XHRcdHR5cGU6IFwidGV4dF9kZWx0YVwiLCBjb250ZW50SW5kZXg6IDIsIGRlbHRhOiBcIkJcIixcblx0XHRcdHBhcnRpYWw6IG1ha2VBc3Npc3RhbnQoW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiQVwiIH0sIHQxLCB7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkJcIiB9XSksXG5cdFx0fSxcblx0fSBhcyBhbnkpO1xuXG5cdGFzc2VydC5lcXVhbChob3N0LmNoYXRDb250YWluZXIuY2hpbGRyZW4ubGVuZ3RoLCAzLCBcInN1Yi10dXJuIDEgcmVuZGVycyAzIGNoaWxkcmVuXCIpO1xuXHRjb25zdCBwcmlvckEgPSBob3N0LmNoYXRDb250YWluZXIuY2hpbGRyZW5bMF07XG5cdGNvbnN0IHByaW9yVDEgPSBob3N0LmNoYXRDb250YWluZXIuY2hpbGRyZW5bMV07XG5cdGNvbnN0IHByaW9yQiA9IGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlblsyXTtcblxuXHQvLyBTdWItdHVybiBib3VuZGFyeTogYWRhcHRlciByZXNldHMgY29udGVudFtdIHRvIFtDXVxuXHRhd2FpdCBoYW5kbGVBZ2VudEV2ZW50KGhvc3QsIHtcblx0XHR0eXBlOiBcIm1lc3NhZ2VfdXBkYXRlXCIsXG5cdFx0bWVzc2FnZTogbWFrZUFzc2lzdGFudChbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJDXCIgfV0pLFxuXHRcdGFzc2lzdGFudE1lc3NhZ2VFdmVudDoge1xuXHRcdFx0dHlwZTogXCJ0ZXh0X2RlbHRhXCIsIGNvbnRlbnRJbmRleDogMCwgZGVsdGE6IFwiQ1wiLFxuXHRcdFx0cGFydGlhbDogbWFrZUFzc2lzdGFudChbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJDXCIgfV0pLFxuXHRcdH0sXG5cdH0gYXMgYW55KTtcblxuXHQvLyBQcmlvciAzIGNoaWxkcmVuIG11c3Qgc3RpbGwgZXhpc3QgaW4gRE9NIFx1MjAxNCBhbmQgYSBORVcgdGV4dC1ydW4gZm9yIFwiQ1wiIGFwcGVuZGVkIGFmdGVyIHRoZW0uXG5cdGFzc2VydC5lcXVhbChob3N0LmNoYXRDb250YWluZXIuY2hpbGRyZW4ubGVuZ3RoLCA0LCBcInNocmluayBtdXN0IGFwcGVuZCBuZXcgc2VnbWVudCwgbm90IHJlcGxhY2UgcHJpb3IgaGlzdG9yeVwiKTtcblx0YXNzZXJ0LmVxdWFsKGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlblswXSwgcHJpb3JBLCBcInByaW9yIEEgY29tcG9uZW50IHN0YXlzIGF0IGluZGV4IDBcIik7XG5cdGFzc2VydC5lcXVhbChob3N0LmNoYXRDb250YWluZXIuY2hpbGRyZW5bMV0sIHByaW9yVDEsIFwicHJpb3IgVDEgY29tcG9uZW50IHN0YXlzIGF0IGluZGV4IDFcIik7XG5cdGFzc2VydC5lcXVhbChob3N0LmNoYXRDb250YWluZXIuY2hpbGRyZW5bMl0sIHByaW9yQiwgXCJwcmlvciBCIGNvbXBvbmVudCBzdGF5cyBhdCBpbmRleCAyXCIpO1xuXHRhc3NlcnQubm90RXF1YWwoaG9zdC5jaGF0Q29udGFpbmVyLmNoaWxkcmVuWzNdLCBwcmlvckEsIFwibmV3IEMgdGV4dC1ydW4gbXVzdCBiZSBhIGRpZmZlcmVudCBjb21wb25lbnQgZnJvbSBwcmlvciBBXCIpO1xuXHRhc3NlcnQuZXF1YWwoaG9zdC5jaGF0Q29udGFpbmVyLmNoaWxkcmVuWzNdPy5jb25zdHJ1Y3Rvcj8ubmFtZSwgXCJBc3Npc3RhbnRNZXNzYWdlQ29tcG9uZW50XCIpO1xuXG5cdC8vIFByaW9yIEEgY29tcG9uZW50IG11c3Qgc3RpbGwgcmVuZGVyIFwiQVwiLCBub3QgYmUgb3ZlcndyaXR0ZW4gd2l0aCBcIkNcIi5cblx0ZnVuY3Rpb24gZ2V0UmVuZGVyZWRUZXh0cyhjb21wOiBhbnkpOiBzdHJpbmdbXSB7XG5cdFx0Y29uc3QgY29udGVudENvbnRhaW5lciA9IGNvbXAuY2hpbGRyZW4/LlswXTtcblx0XHRpZiAoIWNvbnRlbnRDb250YWluZXIpIHJldHVybiBbXTtcblx0XHRyZXR1cm4gKGNvbnRlbnRDb250YWluZXIuY2hpbGRyZW4gPz8gW10pXG5cdFx0XHQuZmlsdGVyKChjOiBhbnkpID0+IGMuY29uc3RydWN0b3I/Lm5hbWUgPT09IFwiTWFya2Rvd25cIilcblx0XHRcdC5tYXAoKGM6IGFueSkgPT4gKGMgYXMgYW55KS50ZXh0IGFzIHN0cmluZyk7XG5cdH1cblx0YXNzZXJ0LmRlZXBFcXVhbChnZXRSZW5kZXJlZFRleHRzKHByaW9yQSksIFtcIkFcIl0sIFwicHJpb3IgQSB0ZXh0LXJ1biBtdXN0IHN0aWxsIGNvbnRhaW4gJ0EnIGFmdGVyIHNocmlua1wiKTtcblx0YXNzZXJ0LmRlZXBFcXVhbChnZXRSZW5kZXJlZFRleHRzKHByaW9yQiksIFtcIkJcIl0sIFwicHJpb3IgQiB0ZXh0LXJ1biBtdXN0IHN0aWxsIGNvbnRhaW4gJ0InIGFmdGVyIHNocmlua1wiKTtcblx0YXNzZXJ0LmRlZXBFcXVhbChnZXRSZW5kZXJlZFRleHRzKGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlblszXSksIFtcIkNcIl0sIFwibmV3IHRleHQtcnVuIG11c3QgY29udGFpbiBvbmx5ICdDJ1wiKTtcblxuXHQvLyBTdWItdHVybiAyIGdyb3dzIHdpdGggYSBuZXcgdG9vbCBUMiBhdCBjb250ZW50SW5kZXg9MS5cblx0YXdhaXQgaGFuZGxlQWdlbnRFdmVudChob3N0LCB7XG5cdFx0dHlwZTogXCJtZXNzYWdlX3VwZGF0ZVwiLFxuXHRcdG1lc3NhZ2U6IG1ha2VBc3Npc3RhbnQoW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiQ1wiIH0sIHQyXSksXG5cdFx0YXNzaXN0YW50TWVzc2FnZUV2ZW50OiB7XG5cdFx0XHR0eXBlOiBcInRvb2xjYWxsX2VuZFwiLCBjb250ZW50SW5kZXg6IDEsXG5cdFx0XHR0b29sQ2FsbDogeyAuLi50MiwgZXh0ZXJuYWxSZXN1bHQ6IHsgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwicjJcIiB9XSwgZGV0YWlsczoge30sIGlzRXJyb3I6IGZhbHNlIH0gfSxcblx0XHRcdHBhcnRpYWw6IG1ha2VBc3Npc3RhbnQoW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiQ1wiIH0sIHQyXSksXG5cdFx0fSxcblx0fSBhcyBhbnkpO1xuXG5cdC8vIFQyIG11c3QgYmUgYXBwZW5kZWQgYWZ0ZXIgdGhlIG5ldyBDIHRleHQtcnVuLCBub3QgY29uZmxhdGVkIHdpdGggdGhlIHN0YWxlIFQxIHJlZ2lzdHJhdGlvbi5cblx0YXNzZXJ0LmVxdWFsKGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlbi5sZW5ndGgsIDUsIFwibmV3IHRvb2wgYXBwZW5kcyBhZnRlciBuZXcgdGV4dC1ydW5cIik7XG5cdGFzc2VydC5lcXVhbChob3N0LmNoYXRDb250YWluZXIuY2hpbGRyZW5bNF0/LmNvbnN0cnVjdG9yPy5uYW1lLCBcIlRvb2xFeGVjdXRpb25Db21wb25lbnRcIik7XG5cdGFzc2VydC5ub3RFcXVhbChob3N0LmNoYXRDb250YWluZXIuY2hpbGRyZW5bNF0sIHByaW9yVDEsIFwibmV3IFQyIG11c3QgYmUgYSBkaWZmZXJlbnQgY29tcG9uZW50IGZyb20gcHJpb3IgVDFcIik7XG5cblx0Ly8gRmluYWxpemUgc28gdGhlIG1vZHVsZS1sZXZlbCBwaW5uZWQgc3Bpbm5lciAoc2V0SW50ZXJ2YWwpIGlzIHRvcm4gZG93biBhbmQgdGhlIHRlc3QgcHJvY2VzcyBjYW4gZXhpdC5cblx0YXdhaXQgaGFuZGxlQWdlbnRFdmVudChob3N0LCB7IHR5cGU6IFwibWVzc2FnZV9lbmRcIiwgbWVzc2FnZTogbWFrZUFzc2lzdGFudChbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJDXCIgfSwgdDJdKSB9IGFzIGFueSk7XG59KTtcblxuLy8gUmVncmVzc2lvbjogYWZ0ZXIgYSBzdWItdHVybiBzaHJpbmssIGxhc3RQaW5uZWRUZXh0IG11c3QgYmUgY2xlYXJlZCBzbyB0aGVcbi8vIHBpbm5lZCBcIkxhdGVzdCBPdXRwdXRcIiBtaXJyb3IgY2FuIGRpc3BsYXkgdGV4dCBmcm9tIHRoZSBuZXcgc3ViLXR1cm4gaW5zdGVhZFxuLy8gb2Ygc3RheWluZyBmcm96ZW4gb24gYSBzdGFsZSBzbmFwc2hvdCAodGhlIFwiYm90dG9tIGdyZWVuIHN0YXlzXCIgc3ltcHRvbSkuXG50ZXN0KFwiY2hhdC1jb250cm9sbGVyIHVwZGF0ZXMgcGlubmVkIHpvbmUgYWZ0ZXIgc3ViLXR1cm4gc2hyaW5rXCIsIGFzeW5jICgpID0+IHtcblx0KGdsb2JhbFRoaXMgYXMgYW55KVtTeW1ib2wuZm9yKFwiQGdzZC9waS1jb2RpbmctYWdlbnQ6dGhlbWVcIildID0ge1xuXHRcdGZnOiAoX2tleTogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG5cdFx0Ymc6IChfa2V5OiBzdHJpbmcsIHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0XHRib2xkOiAodGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuXHRcdGl0YWxpYzogKHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0XHR0cnVuY2F0ZTogKHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0fTtcblxuXHRjb25zdCBob3N0ID0gY3JlYXRlSG9zdCgpO1xuXHRob3N0LmdldE1hcmtkb3duVGhlbWVXaXRoU2V0dGluZ3MgPSAoKSA9PiAoe30pO1xuXG5cdGNvbnN0IHQxID0geyB0eXBlOiBcInRvb2xDYWxsXCIsIGlkOiBcInQxXCIsIG5hbWU6IFwidG9vbF9vbmVcIiwgYXJndW1lbnRzOiB7fSB9O1xuXHRjb25zdCB0MiA9IHsgdHlwZTogXCJ0b29sQ2FsbFwiLCBpZDogXCJ0MlwiLCBuYW1lOiBcInRvb2xfdHdvXCIsIGFyZ3VtZW50czoge30gfTtcblxuXHRhd2FpdCBoYW5kbGVBZ2VudEV2ZW50KGhvc3QsIHsgdHlwZTogXCJtZXNzYWdlX3N0YXJ0XCIsIG1lc3NhZ2U6IG1ha2VBc3Npc3RhbnQoW10pIH0gYXMgYW55KTtcblxuXHQvLyBTdWItdHVybiAxIHdpdGggcGlubmFibGUgdGV4dCBiZWZvcmUgYSB0b29sIFx1MjE5MiBwb3B1bGF0ZXMgcGlubmVkIHpvbmUgd2l0aCBcImZpcnN0XCIuXG5cdGF3YWl0IGhhbmRsZUFnZW50RXZlbnQoaG9zdCwge1xuXHRcdHR5cGU6IFwibWVzc2FnZV91cGRhdGVcIixcblx0XHRtZXNzYWdlOiBtYWtlQXNzaXN0YW50KFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcImZpcnN0XCIgfSwgdDFdKSxcblx0XHRhc3Npc3RhbnRNZXNzYWdlRXZlbnQ6IHtcblx0XHRcdHR5cGU6IFwidG9vbGNhbGxfZW5kXCIsIGNvbnRlbnRJbmRleDogMSxcblx0XHRcdHRvb2xDYWxsOiB7IC4uLnQxLCBleHRlcm5hbFJlc3VsdDogeyBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJyMVwiIH1dLCBkZXRhaWxzOiB7fSwgaXNFcnJvcjogZmFsc2UgfSB9LFxuXHRcdFx0cGFydGlhbDogbWFrZUFzc2lzdGFudChbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJmaXJzdFwiIH0sIHQxXSksXG5cdFx0fSxcblx0fSBhcyBhbnkpO1xuXHRjb25zdCBwaW5uZWRNYXJrZG93biA9IGhvc3QucGlubmVkTWVzc2FnZUNvbnRhaW5lci5jaGlsZHJlblsxXTtcblx0YXNzZXJ0LmVxdWFsKChwaW5uZWRNYXJrZG93biBhcyBhbnkpPy50ZXh0LCBcImZpcnN0XCIsIFwicGlubmVkIHpvbmUgc2VlZGVkIHdpdGggc3ViLXR1cm4gMSB0ZXh0XCIpO1xuXG5cdC8vIFN1Yi10dXJuIGJvdW5kYXJ5OiBjb250ZW50IHJlc2V0cyB0byBbc2Vjb25kLCB0Ml0uXG5cdGF3YWl0IGhhbmRsZUFnZW50RXZlbnQoaG9zdCwge1xuXHRcdHR5cGU6IFwibWVzc2FnZV91cGRhdGVcIixcblx0XHRtZXNzYWdlOiBtYWtlQXNzaXN0YW50KFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcInNlY29uZFwiIH0sIHQyXSksXG5cdFx0YXNzaXN0YW50TWVzc2FnZUV2ZW50OiB7XG5cdFx0XHR0eXBlOiBcInRvb2xjYWxsX2VuZFwiLCBjb250ZW50SW5kZXg6IDEsXG5cdFx0XHR0b29sQ2FsbDogeyAuLi50MiwgZXh0ZXJuYWxSZXN1bHQ6IHsgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwicjJcIiB9XSwgZGV0YWlsczoge30sIGlzRXJyb3I6IGZhbHNlIH0gfSxcblx0XHRcdHBhcnRpYWw6IG1ha2VBc3Npc3RhbnQoW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwic2Vjb25kXCIgfSwgdDJdKSxcblx0XHR9LFxuXHR9IGFzIGFueSk7XG5cblx0Ly8gUGlubmVkIG1hcmtkb3duIG11c3Qgbm93IHJlZmxlY3QgdGhlIG5ldyBzdWItdHVybidzIHRleHQsIG5vdCBzdGF5IGZyb3plbiBvbiBcImZpcnN0XCIuXG5cdGFzc2VydC5lcXVhbCgocGlubmVkTWFya2Rvd24gYXMgYW55KT8udGV4dCwgXCJzZWNvbmRcIiwgXCJwaW5uZWQgem9uZSBtdXN0IHVwZGF0ZSBhZnRlciBzdWItdHVybiBzaHJpbmsgKCM0MTQ0IHJlZ3Jlc3Npb24pXCIpO1xuXG5cdC8vIEZpbmFsaXplIHNvIHRoZSBtb2R1bGUtbGV2ZWwgcGlubmVkIHNwaW5uZXIgKHNldEludGVydmFsKSBpcyB0b3JuIGRvd24gYW5kIHRoZSB0ZXN0IHByb2Nlc3MgY2FuIGV4aXQuXG5cdGF3YWl0IGhhbmRsZUFnZW50RXZlbnQoaG9zdCwgeyB0eXBlOiBcIm1lc3NhZ2VfZW5kXCIsIG1lc3NhZ2U6IG1ha2VBc3Npc3RhbnQoW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwic2Vjb25kXCIgfSwgdDJdKSB9IGFzIGFueSk7XG59KTtcblxudGVzdChcImNoYXQtY29udHJvbGxlcjogYWdlbnRfZW5kIHdpdGhvdXQgbWVzc2FnZV9lbmQgbXVzdCBub3QgcmVtb3ZlIHN0cmVhbWluZyBjb21wb25lbnQgZnJvbSBET00gKHJlZ3Jlc3Npb24gIzQxOTcpXCIsIGFzeW5jICgpID0+IHtcblx0Y29uc3QgaG9zdCA9IGNyZWF0ZUhvc3QoKTtcblxuXHRhd2FpdCBoYW5kbGVBZ2VudEV2ZW50KGhvc3QsIHtcblx0XHR0eXBlOiBcIm1lc3NhZ2Vfc3RhcnRcIixcblx0XHRtZXNzYWdlOiBtYWtlQXNzaXN0YW50KFtdKSxcblx0fSBhcyBhbnkpO1xuXG5cdC8vIFNpbXVsYXRlIHBhcnRpYWwgc3RyZWFtaW5nIHRoYXQgY3JlYXRlcyBhbiBBc3Npc3RhbnRNZXNzYWdlQ29tcG9uZW50XG5cdGF3YWl0IGhhbmRsZUFnZW50RXZlbnQoaG9zdCwge1xuXHRcdHR5cGU6IFwibWVzc2FnZV91cGRhdGVcIixcblx0XHRtZXNzYWdlOiBtYWtlQXNzaXN0YW50KFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcInBhcnRpYWwgYW5zd2VyXCIgfV0pLFxuXHRcdGFzc2lzdGFudE1lc3NhZ2VFdmVudDoge1xuXHRcdFx0dHlwZTogXCJ0ZXh0X2RlbHRhXCIsXG5cdFx0XHRjb250ZW50SW5kZXg6IDAsXG5cdFx0XHRkZWx0YTogXCJwYXJ0aWFsIGFuc3dlclwiLFxuXHRcdFx0cGFydGlhbDogbWFrZUFzc2lzdGFudChbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJwYXJ0aWFsIGFuc3dlclwiIH1dKSxcblx0XHR9LFxuXHR9IGFzIGFueSk7XG5cblx0Ly8gUHJlY29uZGl0aW9uOiBjb21wb25lbnQgaXMgaW4gRE9NXG5cdGFzc2VydC5lcXVhbChcblx0XHRob3N0LmNoYXRDb250YWluZXIuY2hpbGRyZW4ubGVuZ3RoLFxuXHRcdDEsXG5cdFx0XCJzdHJlYW1pbmcgY29tcG9uZW50IG11c3QgYmUgaW4gRE9NIGFmdGVyIG1lc3NhZ2VfdXBkYXRlXCIsXG5cdCk7XG5cdGNvbnN0IGNvbXAgPSBob3N0LmNoYXRDb250YWluZXIuY2hpbGRyZW5bMF07XG5cblx0Ly8gU2ltdWxhdGUgYWJvcnQ6IGFnZW50X2VuZCBmaXJlcyBXSVRIT1VUIG1lc3NhZ2VfZW5kXG5cdGF3YWl0IGhhbmRsZUFnZW50RXZlbnQoaG9zdCwgeyB0eXBlOiBcImFnZW50X2VuZFwiIH0gYXMgYW55KTtcblxuXHRhc3NlcnQuZXF1YWwoXG5cdFx0aG9zdC5jaGF0Q29udGFpbmVyLmNoaWxkcmVuLmxlbmd0aCxcblx0XHQxLFxuXHRcdFwiYWdlbnRfZW5kIG11c3QgTk9UIHJlbW92ZSB0aGUgc3RyZWFtaW5nIGNvbXBvbmVudCBmcm9tIHRoZSBET00gKGlzc3VlICM0MTk3KVwiLFxuXHQpO1xuXHRhc3NlcnQuZXF1YWwoXG5cdFx0aG9zdC5jaGF0Q29udGFpbmVyLmNoaWxkcmVuWzBdLFxuXHRcdGNvbXAsXG5cdFx0XCJ0aGUgc2FtZSBjb21wb25lbnQgaW5zdGFuY2UgbXVzdCByZW1haW4gaW4gdGhlIERPTSBhZnRlciBhZ2VudF9lbmRcIixcblx0KTtcbn0pO1xuXG50ZXN0KFwiY2hhdC1jb250cm9sbGVyOiBhZ2VudF9lbmQgYWZ0ZXIgbWVzc2FnZV9lbmQgbXVzdCBub3QgYWx0ZXIgRE9NXCIsIGFzeW5jICgpID0+IHtcblx0Y29uc3QgaG9zdCA9IGNyZWF0ZUhvc3QoKTtcblx0Y29uc3QgY29udGVudCA9IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcImNvbXBsZXRlIGFuc3dlclwiIH1dO1xuXG5cdGF3YWl0IGhhbmRsZUFnZW50RXZlbnQoaG9zdCwge1xuXHRcdHR5cGU6IFwibWVzc2FnZV9zdGFydFwiLFxuXHRcdG1lc3NhZ2U6IG1ha2VBc3Npc3RhbnQoW10pLFxuXHR9IGFzIGFueSk7XG5cblx0YXdhaXQgaGFuZGxlQWdlbnRFdmVudChob3N0LCB7XG5cdFx0dHlwZTogXCJtZXNzYWdlX3VwZGF0ZVwiLFxuXHRcdG1lc3NhZ2U6IG1ha2VBc3Npc3RhbnQoY29udGVudCksXG5cdFx0YXNzaXN0YW50TWVzc2FnZUV2ZW50OiB7XG5cdFx0XHR0eXBlOiBcInRleHRfZGVsdGFcIixcblx0XHRcdGNvbnRlbnRJbmRleDogMCxcblx0XHRcdGRlbHRhOiBcImNvbXBsZXRlIGFuc3dlclwiLFxuXHRcdFx0cGFydGlhbDogbWFrZUFzc2lzdGFudChjb250ZW50KSxcblx0XHR9LFxuXHR9IGFzIGFueSk7XG5cblx0YXdhaXQgaGFuZGxlQWdlbnRFdmVudChob3N0LCB7XG5cdFx0dHlwZTogXCJtZXNzYWdlX2VuZFwiLFxuXHRcdG1lc3NhZ2U6IG1ha2VBc3Npc3RhbnQoY29udGVudCksXG5cdH0gYXMgYW55KTtcblxuXHRjb25zdCBjb3VudEFmdGVyTWVzc2FnZUVuZCA9IGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlbi5sZW5ndGg7XG5cdGFzc2VydC5vayhjb3VudEFmdGVyTWVzc2FnZUVuZCA+IDAsIFwiY29tcG9uZW50IG11c3QgYmUgcHJlc2VudCBhZnRlciBtZXNzYWdlX2VuZFwiKTtcblxuXHRhd2FpdCBoYW5kbGVBZ2VudEV2ZW50KGhvc3QsIHsgdHlwZTogXCJhZ2VudF9lbmRcIiB9IGFzIGFueSk7XG5cblx0YXNzZXJ0LmVxdWFsKFxuXHRcdGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlbi5sZW5ndGgsXG5cdFx0Y291bnRBZnRlck1lc3NhZ2VFbmQsXG5cdFx0XCJhZ2VudF9lbmQgYWZ0ZXIgbWVzc2FnZV9lbmQgbXVzdCBub3QgYWRkIG9yIHJlbW92ZSBET00gbm9kZXNcIixcblx0KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsT0FBTyxZQUFZO0FBQ25CLFNBQVMsWUFBWTtBQUVyQixTQUFTLHdCQUF3QjtBQUVqQyxTQUFTLFlBQVk7QUFDcEIsU0FBTztBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsUUFBUTtBQUFBLElBQ1IsV0FBVztBQUFBLElBQ1gsWUFBWTtBQUFBLElBQ1osYUFBYTtBQUFBLElBQ2IsTUFBTSxFQUFFLE9BQU8sR0FBRyxRQUFRLEdBQUcsV0FBVyxHQUFHLFlBQVksR0FBRyxPQUFPLEVBQUU7QUFBQSxFQUNwRTtBQUNEO0FBRUEsU0FBUyxjQUFjLFNBQWdCO0FBQ3RDLFNBQU87QUFBQSxJQUNOLE1BQU07QUFBQSxJQUNOO0FBQUEsSUFDQSxLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixPQUFPO0FBQUEsSUFDUCxPQUFPLFVBQVU7QUFBQSxJQUNqQixZQUFZO0FBQUEsSUFDWixXQUFXLEtBQUssSUFBSTtBQUFBLEVBQ3JCO0FBQ0Q7QUFFQSxTQUFTLGFBQWE7QUFDckIsUUFBTSxnQkFBZ0I7QUFBQSxJQUNyQixVQUFVLENBQUM7QUFBQSxJQUNYLFNBQVMsV0FBZ0I7QUFDeEIsV0FBSyxTQUFTLEtBQUssU0FBUztBQUFBLElBQzdCO0FBQUEsSUFDQSxZQUFZLFdBQWdCO0FBQzNCLFlBQU0sTUFBTSxLQUFLLFNBQVMsUUFBUSxTQUFTO0FBQzNDLFVBQUksUUFBUSxHQUFJLE1BQUssU0FBUyxPQUFPLEtBQUssQ0FBQztBQUFBLElBQzVDO0FBQUEsSUFDQSxRQUFRO0FBQ1AsV0FBSyxXQUFXLENBQUM7QUFBQSxJQUNsQjtBQUFBLEVBQ0Q7QUFFQSxR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
