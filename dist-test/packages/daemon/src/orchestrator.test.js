import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Orchestrator } from "./orchestrator.js";
import { Logger } from "./logger.js";
function tmpDir() {
  return mkdtempSync(join(tmpdir(), `orch-test-${randomUUID().slice(0, 8)}-`));
}
const cleanupDirs = [];
const activeLoggers = [];
async function cleanupAll() {
  for (const logger of activeLoggers) {
    try {
      await logger.close();
    } catch {
    }
  }
  activeLoggers.length = 0;
  while (cleanupDirs.length) {
    const d = cleanupDirs.pop();
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
}
class MockAnthropicClient {
  createCallCount = 0;
  lastCreateParams = null;
  createHandler;
  constructor(handler) {
    this.createHandler = handler ?? MockAnthropicClient.defaultHandler;
  }
  /** Default handler: returns a simple text response */
  static defaultHandler() {
    return {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Mock LLM response" }]
    };
  }
  /** Handler that simulates a tool call then end_turn */
  static toolThenTextHandler(toolName, toolInput, finalText) {
    let callCount = 0;
    return () => {
      callCount++;
      if (callCount === 1) {
        return {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: `toolu_${randomUUID().slice(0, 8)}`,
              name: toolName,
              input: toolInput
            }
          ]
        };
      }
      return {
        stop_reason: "end_turn",
        content: [{ type: "text", text: finalText }]
      };
    };
  }
  /** Handler that throws an error */
  static errorHandler(message) {
    return () => {
      throw new Error(message);
    };
  }
  messages = {
    create: async (params) => {
      this.createCallCount++;
      this.lastCreateParams = params;
      return this.createHandler(params);
    }
  };
}
function makeMockSession(overrides = {}) {
  return {
    sessionId: overrides.sessionId ?? "sess-123",
    projectDir: overrides.projectDir ?? "/home/user/project",
    projectName: overrides.projectName ?? "my-project",
    status: overrides.status ?? "running",
    client: {},
    events: [],
    pendingBlocker: null,
    cost: overrides.cost ?? { totalCost: 0.1234, tokens: { input: 1e3, output: 500, cacheRead: 0, cacheWrite: 0 } },
    startTime: overrides.startTime ?? Date.now() - 3e5,
    // 5 min ago
    ...overrides
  };
}
class MockSessionManager {
  sessions = [];
  startSessionCalls = [];
  cancelSessionCalls = [];
  getResultCalls = [];
  async startSession(opts) {
    this.startSessionCalls.push(opts);
    return "sess-new-123";
  }
  getSession(sessionId) {
    return this.sessions.find((s) => s.sessionId === sessionId);
  }
  getAllSessions() {
    return this.sessions;
  }
  async cancelSession(sessionId) {
    this.cancelSessionCalls.push(sessionId);
  }
  getResult(sessionId) {
    const session = this.sessions.find((s) => s.sessionId === sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return {
      sessionId: session.sessionId,
      projectDir: session.projectDir,
      projectName: session.projectName,
      status: session.status,
      durationMs: 3e5,
      cost: session.cost,
      recentEvents: [],
      pendingBlocker: null,
      error: null
    };
  }
}
class MockChannelManager {
}
function makeMessage(overrides) {
  const sentMessages = [];
  return {
    author: {
      id: overrides.authorId ?? "owner-123",
      bot: overrides.bot ?? false
    },
    channelId: overrides.channelId ?? "control-channel-1",
    content: overrides.content ?? "hello",
    channel: {
      send: async (content) => {
        sentMessages.push(content);
      },
      sendTyping: async () => {
      }
    },
    sentMessages
  };
}
function makeOrchestrator(opts) {
  const dir = tmpDir();
  cleanupDirs.push(dir);
  const logPath = join(dir, "test.log");
  const logger = new Logger({ filePath: logPath, level: "debug" });
  activeLoggers.push(logger);
  const sessionManager = new MockSessionManager();
  if (opts?.sessions) sessionManager.sessions = opts.sessions;
  const projects = opts?.projects ?? [
    { name: "alpha", path: "/home/user/alpha", markers: ["git", "node", "gsd"], lastModified: Date.now() },
    { name: "bravo", path: "/home/user/bravo", markers: ["git", "rust"], lastModified: Date.now() }
  ];
  const config = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    control_channel_id: "control-channel-1"
  };
  const deps = {
    sessionManager,
    channelManager: new MockChannelManager(),
    scanProjects: async () => projects,
    config,
    logger,
    ownerId: "owner-123"
  };
  const mockClient = opts?.client ?? new MockAnthropicClient();
  const orchestrator = new Orchestrator(deps, mockClient);
  return { orchestrator, mockClient, sessionManager, logger, logPath };
}
describe("Orchestrator", () => {
  afterEach(async () => {
    await cleanupAll();
  });
  describe("tool definitions", () => {
    it("passes 5 tools to the Anthropic API", async () => {
      const { orchestrator, mockClient } = makeOrchestrator();
      const msg = makeMessage({ content: "what can you do?" });
      await orchestrator.handleMessage(msg);
      assert.ok(mockClient.lastCreateParams);
      const tools = mockClient.lastCreateParams.tools;
      assert.equal(tools.length, 5);
      const names = tools.map((t) => t.name).sort();
      assert.deepEqual(names, [
        "get_session_detail",
        "get_status",
        "list_projects",
        "start_session",
        "stop_session"
      ]);
    });
  });
  describe("list_projects tool", () => {
    it("returns project list from scanProjects", async () => {
      const mockClient = new MockAnthropicClient(
        MockAnthropicClient.toolThenTextHandler("list_projects", {}, "Here are your projects")
      );
      const { orchestrator } = makeOrchestrator({ client: mockClient });
      const msg = makeMessage({ content: "list my projects" });
      await orchestrator.handleMessage(msg);
      assert.equal(msg.sentMessages.length, 1);
      assert.equal(msg.sentMessages[0], "Here are your projects");
      assert.equal(mockClient.createCallCount, 2);
    });
  });
  describe("start_session tool", () => {
    it("calls sessionManager.startSession and returns confirmation", async () => {
      const mockClient = new MockAnthropicClient(
        MockAnthropicClient.toolThenTextHandler(
          "start_session",
          { projectPath: "/home/user/alpha" },
          "Started session for alpha"
        )
      );
      const { orchestrator, sessionManager } = makeOrchestrator({ client: mockClient });
      const msg = makeMessage({ content: "start alpha" });
      await orchestrator.handleMessage(msg);
      assert.equal(sessionManager.startSessionCalls.length, 1);
      assert.equal(sessionManager.startSessionCalls[0].projectDir, "/home/user/alpha");
      assert.equal(msg.sentMessages[0], "Started session for alpha");
    });
  });
  describe("get_status tool", () => {
    it("returns formatted session status", async () => {
      const session = makeMockSession({ projectName: "alpha", status: "running" });
      const mockClient = new MockAnthropicClient(
        MockAnthropicClient.toolThenTextHandler("get_status", {}, "Status: alpha is running")
      );
      const { orchestrator } = makeOrchestrator({ client: mockClient, sessions: [session] });
      const msg = makeMessage({ content: "status" });
      await orchestrator.handleMessage(msg);
      assert.equal(msg.sentMessages[0], "Status: alpha is running");
    });
    it("handles empty session list", async () => {
      const mockClient = new MockAnthropicClient(
        MockAnthropicClient.toolThenTextHandler("get_status", {}, "No sessions running")
      );
      const { orchestrator } = makeOrchestrator({ client: mockClient, sessions: [] });
      const msg = makeMessage({ content: "status" });
      await orchestrator.handleMessage(msg);
      assert.equal(msg.sentMessages[0], "No sessions running");
    });
  });
  describe("stop_session tool", () => {
    it("stops session matched by sessionId", async () => {
      const session = makeMockSession({ sessionId: "sess-abc", projectName: "alpha" });
      const mockClient = new MockAnthropicClient(
        MockAnthropicClient.toolThenTextHandler(
          "stop_session",
          { identifier: "sess-abc" },
          "Stopped alpha"
        )
      );
      const { orchestrator, sessionManager } = makeOrchestrator({ client: mockClient, sessions: [session] });
      const msg = makeMessage({ content: "stop sess-abc" });
      await orchestrator.handleMessage(msg);
      assert.equal(sessionManager.cancelSessionCalls.length, 1);
      assert.equal(sessionManager.cancelSessionCalls[0], "sess-abc");
    });
    it("fuzzy matches by project name", async () => {
      const session = makeMockSession({ sessionId: "sess-xyz", projectName: "my-big-project" });
      const mockClient = new MockAnthropicClient(
        MockAnthropicClient.toolThenTextHandler(
          "stop_session",
          { identifier: "big-project" },
          "Stopped my-big-project"
        )
      );
      const { orchestrator, sessionManager } = makeOrchestrator({ client: mockClient, sessions: [session] });
      const msg = makeMessage({ content: "stop big project" });
      await orchestrator.handleMessage(msg);
      assert.equal(sessionManager.cancelSessionCalls.length, 1);
      assert.equal(sessionManager.cancelSessionCalls[0], "sess-xyz");
    });
    it("returns not-found for unmatched identifier", async () => {
      const mockClient = new MockAnthropicClient(
        MockAnthropicClient.toolThenTextHandler(
          "stop_session",
          { identifier: "nonexistent" },
          "No session found"
        )
      );
      const { orchestrator, sessionManager } = makeOrchestrator({ client: mockClient, sessions: [] });
      const msg = makeMessage({ content: "stop nonexistent" });
      await orchestrator.handleMessage(msg);
      assert.equal(sessionManager.cancelSessionCalls.length, 0);
    });
  });
  describe("get_session_detail tool", () => {
    it("returns formatted session detail", async () => {
      const session = makeMockSession({ sessionId: "sess-detail" });
      const mockClient = new MockAnthropicClient(
        MockAnthropicClient.toolThenTextHandler(
          "get_session_detail",
          { sessionId: "sess-detail" },
          "Session details for my-project"
        )
      );
      const { orchestrator } = makeOrchestrator({ client: mockClient, sessions: [session] });
      const msg = makeMessage({ content: "detail sess-detail" });
      await orchestrator.handleMessage(msg);
      assert.equal(msg.sentMessages[0], "Session details for my-project");
    });
  });
  describe("handleMessage routing", () => {
    it("ignores bot messages", async () => {
      const { orchestrator, mockClient } = makeOrchestrator();
      const msg = makeMessage({ bot: true, content: "hello from bot" });
      await orchestrator.handleMessage(msg);
      assert.equal(mockClient.createCallCount, 0);
      assert.equal(msg.sentMessages.length, 0);
    });
    it("ignores non-owner messages", async () => {
      const { orchestrator, mockClient } = makeOrchestrator();
      const msg = makeMessage({ authorId: "stranger-456", content: "hack the planet" });
      await orchestrator.handleMessage(msg);
      assert.equal(mockClient.createCallCount, 0);
      assert.equal(msg.sentMessages.length, 0);
    });
    it("ignores messages from non-control channels", async () => {
      const { orchestrator, mockClient } = makeOrchestrator();
      const msg = makeMessage({ channelId: "random-channel", content: "hello" });
      await orchestrator.handleMessage(msg);
      assert.equal(mockClient.createCallCount, 0);
      assert.equal(msg.sentMessages.length, 0);
    });
    it("ignores empty message content", async () => {
      const { orchestrator, mockClient } = makeOrchestrator();
      const msg = makeMessage({ content: "   " });
      await orchestrator.handleMessage(msg);
      assert.equal(mockClient.createCallCount, 0);
    });
    it("routes valid message through LLM and sends response", async () => {
      const { orchestrator, mockClient } = makeOrchestrator();
      const msg = makeMessage({ content: "hello orchestrator" });
      await orchestrator.handleMessage(msg);
      assert.equal(mockClient.createCallCount, 1);
      assert.equal(msg.sentMessages.length, 1);
      assert.equal(msg.sentMessages[0], "Mock LLM response");
    });
  });
  describe("conversation history", () => {
    it("accumulates user and assistant entries", async () => {
      const { orchestrator } = makeOrchestrator();
      await orchestrator.handleMessage(makeMessage({ content: "first" }));
      await orchestrator.handleMessage(makeMessage({ content: "second" }));
      const history = orchestrator.getHistory();
      assert.equal(history.length, 4);
      assert.equal(history[0].role, "user");
      assert.equal(history[1].role, "assistant");
      assert.equal(history[2].role, "user");
      assert.equal(history[3].role, "assistant");
    });
    it("trims to MAX_HISTORY (30) by removing oldest pairs", async () => {
      const { orchestrator } = makeOrchestrator();
      for (let i = 0; i < 17; i++) {
        await orchestrator.handleMessage(makeMessage({ content: `msg-${i}` }));
      }
      const history = orchestrator.getHistory();
      assert.ok(history.length <= 30, `History length ${history.length} exceeds 30`);
      assert.equal(history.length, 30);
    });
  });
  describe("error handling", () => {
    it("sends error message to Discord when LLM API throws", async () => {
      const mockClient = new MockAnthropicClient(
        MockAnthropicClient.errorHandler("API rate limit exceeded")
      );
      const { orchestrator } = makeOrchestrator({ client: mockClient });
      const msg = makeMessage({ content: "hello" });
      await orchestrator.handleMessage(msg);
      assert.equal(msg.sentMessages.length, 1);
      assert.ok(msg.sentMessages[0].includes("Something went wrong"));
    });
    it("appends error placeholder to history on LLM failure", async () => {
      const mockClient = new MockAnthropicClient(
        MockAnthropicClient.errorHandler("Network error")
      );
      const { orchestrator } = makeOrchestrator({ client: mockClient });
      await orchestrator.handleMessage(makeMessage({ content: "fail" }));
      const history = orchestrator.getHistory();
      assert.equal(history.length, 2);
      assert.equal(history[1].role, "assistant");
      assert.equal(history[1].content, "[error \u2014 see logs]");
    });
  });
  describe("stop()", () => {
    it("clears conversation history and nulls client", async () => {
      const { orchestrator } = makeOrchestrator();
      await orchestrator.handleMessage(makeMessage({ content: "hello" }));
      assert.ok(orchestrator.getHistory().length > 0);
      orchestrator.stop();
      assert.equal(orchestrator.getHistory().length, 0);
    });
  });
  describe("tool execution (via agent loop)", () => {
    it("list_projects returns empty message when no projects", async () => {
      const mockClient = new MockAnthropicClient(
        MockAnthropicClient.toolThenTextHandler("list_projects", {}, "No projects")
      );
      const { orchestrator } = makeOrchestrator({ client: mockClient, projects: [] });
      const msg = makeMessage({ content: "list" });
      await orchestrator.handleMessage(msg);
      assert.equal(mockClient.createCallCount, 2);
    });
    it("start_session with optional command passes through", async () => {
      const mockClient = new MockAnthropicClient(
        MockAnthropicClient.toolThenTextHandler(
          "start_session",
          { projectPath: "/p", command: "/gsd quick fix tests" },
          "Started"
        )
      );
      const { orchestrator, sessionManager } = makeOrchestrator({ client: mockClient });
      const msg = makeMessage({ content: "start with custom command" });
      await orchestrator.handleMessage(msg);
      assert.equal(sessionManager.startSessionCalls.length, 1);
      assert.equal(sessionManager.startSessionCalls[0].command, "/gsd quick fix tests");
    });
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvZGFlbW9uL3NyYy9vcmNoZXN0cmF0b3IudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBUZXN0cyBmb3IgT3JjaGVzdHJhdG9yIFx1MjAxNCBMTE0gYWdlbnQgZm9yICNnc2QtY29udHJvbCBjaGFubmVsLlxuICpcbiAqIFVzZXMgYSBNb2NrQW50aHJvcGljQ2xpZW50IHRoYXQgc2ltdWxhdGVzIG1lc3NhZ2VzLmNyZWF0ZSgpIHJlc3BvbnNlcyxcbiAqIGFsbG93aW5nIHRvb2wgZXhlY3V0aW9uIGFuZCBjb252ZXJzYXRpb24gZmxvdyB0ZXN0aW5nIHdpdGhvdXQgcmVhbCBBUEkgY2FsbHMuXG4gKi9cblxuaW1wb3J0IHsgZGVzY3JpYmUsIGl0LCBhZnRlckVhY2ggfSBmcm9tICdub2RlOnRlc3QnO1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIHJtU3luYywgZXhpc3RzU3luYyB9IGZyb20gJ25vZGU6ZnMnO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gJ25vZGU6cGF0aCc7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tICdub2RlOm9zJztcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tICdub2RlOmNyeXB0byc7XG5pbXBvcnQgeyBPcmNoZXN0cmF0b3IsIHR5cGUgT3JjaGVzdHJhdG9yQ29uZmlnLCB0eXBlIE9yY2hlc3RyYXRvckRlcHMsIHR5cGUgRGlzY29yZE1lc3NhZ2VMaWtlIH0gZnJvbSAnLi9vcmNoZXN0cmF0b3IuanMnO1xuaW1wb3J0IHsgTG9nZ2VyIH0gZnJvbSAnLi9sb2dnZXIuanMnO1xuaW1wb3J0IHR5cGUgeyBNYW5hZ2VkU2Vzc2lvbiwgUHJvamVjdEluZm8sIFNlc3Npb25TdGF0dXMsIENvc3RBY2N1bXVsYXRvciB9IGZyb20gJy4vdHlwZXMuanMnO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIEhlbHBlcnNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5mdW5jdGlvbiB0bXBEaXIoKTogc3RyaW5nIHtcbiAgcmV0dXJuIG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIGBvcmNoLXRlc3QtJHtyYW5kb21VVUlEKCkuc2xpY2UoMCwgOCl9LWApKTtcbn1cblxuY29uc3QgY2xlYW51cERpcnM6IHN0cmluZ1tdID0gW107XG5jb25zdCBhY3RpdmVMb2dnZXJzOiBMb2dnZXJbXSA9IFtdO1xuXG5hc3luYyBmdW5jdGlvbiBjbGVhbnVwQWxsKCk6IFByb21pc2U8dm9pZD4ge1xuICAvLyBDbG9zZSBhbGwgbG9nZ2VycyBmaXJzdCBzbyB3cml0ZSBzdHJlYW1zIGZsdXNoIGJlZm9yZSBkaXJzIGFyZSByZW1vdmVkXG4gIGZvciAoY29uc3QgbG9nZ2VyIG9mIGFjdGl2ZUxvZ2dlcnMpIHtcbiAgICB0cnkgeyBhd2FpdCBsb2dnZXIuY2xvc2UoKTsgfSBjYXRjaCB7IC8qIGlnbm9yZSAqLyB9XG4gIH1cbiAgYWN0aXZlTG9nZ2Vycy5sZW5ndGggPSAwO1xuXG4gIHdoaWxlIChjbGVhbnVwRGlycy5sZW5ndGgpIHtcbiAgICBjb25zdCBkID0gY2xlYW51cERpcnMucG9wKCkhO1xuICAgIGlmIChleGlzdHNTeW5jKGQpKSBybVN5bmMoZCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gTW9jayBBbnRocm9waWMgQ2xpZW50XG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuaW50ZXJmYWNlIE1vY2tDcmVhdGVQYXJhbXMge1xuICBtb2RlbDogc3RyaW5nO1xuICBtYXhfdG9rZW5zOiBudW1iZXI7XG4gIHN5c3RlbTogc3RyaW5nO1xuICB0b29sczogdW5rbm93bltdO1xuICBtZXNzYWdlczogdW5rbm93bltdO1xufVxuXG50eXBlIENyZWF0ZUhhbmRsZXIgPSAocGFyYW1zOiBNb2NrQ3JlYXRlUGFyYW1zKSA9PiB7XG4gIHN0b3BfcmVhc29uOiBzdHJpbmc7XG4gIGNvbnRlbnQ6IEFycmF5PHsgdHlwZTogc3RyaW5nOyB0ZXh0Pzogc3RyaW5nOyBpZD86IHN0cmluZzsgbmFtZT86IHN0cmluZzsgaW5wdXQ/OiB1bmtub3duIH0+O1xufTtcblxuY2xhc3MgTW9ja0FudGhyb3BpY0NsaWVudCB7XG4gIHB1YmxpYyBjcmVhdGVDYWxsQ291bnQgPSAwO1xuICBwdWJsaWMgbGFzdENyZWF0ZVBhcmFtczogTW9ja0NyZWF0ZVBhcmFtcyB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIGNyZWF0ZUhhbmRsZXI6IENyZWF0ZUhhbmRsZXI7XG5cbiAgY29uc3RydWN0b3IoaGFuZGxlcj86IENyZWF0ZUhhbmRsZXIpIHtcbiAgICB0aGlzLmNyZWF0ZUhhbmRsZXIgPSBoYW5kbGVyID8/IE1vY2tBbnRocm9waWNDbGllbnQuZGVmYXVsdEhhbmRsZXI7XG4gIH1cblxuICAvKiogRGVmYXVsdCBoYW5kbGVyOiByZXR1cm5zIGEgc2ltcGxlIHRleHQgcmVzcG9uc2UgKi9cbiAgc3RhdGljIGRlZmF1bHRIYW5kbGVyKCk6IFJldHVyblR5cGU8Q3JlYXRlSGFuZGxlcj4ge1xuICAgIHJldHVybiB7XG4gICAgICBzdG9wX3JlYXNvbjogJ2VuZF90dXJuJyxcbiAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6ICd0ZXh0JywgdGV4dDogJ01vY2sgTExNIHJlc3BvbnNlJyB9XSxcbiAgICB9O1xuICB9XG5cbiAgLyoqIEhhbmRsZXIgdGhhdCBzaW11bGF0ZXMgYSB0b29sIGNhbGwgdGhlbiBlbmRfdHVybiAqL1xuICBzdGF0aWMgdG9vbFRoZW5UZXh0SGFuZGxlcih0b29sTmFtZTogc3RyaW5nLCB0b29sSW5wdXQ6IHVua25vd24sIGZpbmFsVGV4dDogc3RyaW5nKTogQ3JlYXRlSGFuZGxlciB7XG4gICAgbGV0IGNhbGxDb3VudCA9IDA7XG4gICAgcmV0dXJuICgpID0+IHtcbiAgICAgIGNhbGxDb3VudCsrO1xuICAgICAgaWYgKGNhbGxDb3VudCA9PT0gMSkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHN0b3BfcmVhc29uOiAndG9vbF91c2UnLFxuICAgICAgICAgIGNvbnRlbnQ6IFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgdHlwZTogJ3Rvb2xfdXNlJyxcbiAgICAgICAgICAgICAgaWQ6IGB0b29sdV8ke3JhbmRvbVVVSUQoKS5zbGljZSgwLCA4KX1gLFxuICAgICAgICAgICAgICBuYW1lOiB0b29sTmFtZSxcbiAgICAgICAgICAgICAgaW5wdXQ6IHRvb2xJbnB1dCxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgXSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN0b3BfcmVhc29uOiAnZW5kX3R1cm4nLFxuICAgICAgICBjb250ZW50OiBbeyB0eXBlOiAndGV4dCcsIHRleHQ6IGZpbmFsVGV4dCB9XSxcbiAgICAgIH07XG4gICAgfTtcbiAgfVxuXG4gIC8qKiBIYW5kbGVyIHRoYXQgdGhyb3dzIGFuIGVycm9yICovXG4gIHN0YXRpYyBlcnJvckhhbmRsZXIobWVzc2FnZTogc3RyaW5nKTogQ3JlYXRlSGFuZGxlciB7XG4gICAgcmV0dXJuICgpID0+IHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihtZXNzYWdlKTtcbiAgICB9O1xuICB9XG5cbiAgbWVzc2FnZXMgPSB7XG4gICAgY3JlYXRlOiBhc3luYyAocGFyYW1zOiBNb2NrQ3JlYXRlUGFyYW1zKSA9PiB7XG4gICAgICB0aGlzLmNyZWF0ZUNhbGxDb3VudCsrO1xuICAgICAgdGhpcy5sYXN0Q3JlYXRlUGFyYW1zID0gcGFyYW1zO1xuICAgICAgcmV0dXJuIHRoaXMuY3JlYXRlSGFuZGxlcihwYXJhbXMpO1xuICAgIH0sXG4gIH07XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gTW9jayBTZXNzaW9uTWFuYWdlclxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmZ1bmN0aW9uIG1ha2VNb2NrU2Vzc2lvbihvdmVycmlkZXM6IFBhcnRpYWw8TWFuYWdlZFNlc3Npb24+ID0ge30pOiBNYW5hZ2VkU2Vzc2lvbiB7XG4gIHJldHVybiB7XG4gICAgc2Vzc2lvbklkOiBvdmVycmlkZXMuc2Vzc2lvbklkID8/ICdzZXNzLTEyMycsXG4gICAgcHJvamVjdERpcjogb3ZlcnJpZGVzLnByb2plY3REaXIgPz8gJy9ob21lL3VzZXIvcHJvamVjdCcsXG4gICAgcHJvamVjdE5hbWU6IG92ZXJyaWRlcy5wcm9qZWN0TmFtZSA/PyAnbXktcHJvamVjdCcsXG4gICAgc3RhdHVzOiBvdmVycmlkZXMuc3RhdHVzID8/ICgncnVubmluZycgYXMgU2Vzc2lvblN0YXR1cyksXG4gICAgY2xpZW50OiB7fSBhcyBNYW5hZ2VkU2Vzc2lvblsnY2xpZW50J10sXG4gICAgZXZlbnRzOiBbXSxcbiAgICBwZW5kaW5nQmxvY2tlcjogbnVsbCxcbiAgICBjb3N0OiBvdmVycmlkZXMuY29zdCA/PyB7IHRvdGFsQ29zdDogMC4xMjM0LCB0b2tlbnM6IHsgaW5wdXQ6IDEwMDAsIG91dHB1dDogNTAwLCBjYWNoZVJlYWQ6IDAsIGNhY2hlV3JpdGU6IDAgfSB9LFxuICAgIHN0YXJ0VGltZTogb3ZlcnJpZGVzLnN0YXJ0VGltZSA/PyBEYXRlLm5vdygpIC0gMzAwXzAwMCwgLy8gNSBtaW4gYWdvXG4gICAgLi4ub3ZlcnJpZGVzLFxuICB9O1xufVxuXG5jbGFzcyBNb2NrU2Vzc2lvbk1hbmFnZXIge1xuICBwdWJsaWMgc2Vzc2lvbnM6IE1hbmFnZWRTZXNzaW9uW10gPSBbXTtcbiAgcHVibGljIHN0YXJ0U2Vzc2lvbkNhbGxzOiBBcnJheTx7IHByb2plY3REaXI6IHN0cmluZzsgY29tbWFuZD86IHN0cmluZyB9PiA9IFtdO1xuICBwdWJsaWMgY2FuY2VsU2Vzc2lvbkNhbGxzOiBzdHJpbmdbXSA9IFtdO1xuICBwdWJsaWMgZ2V0UmVzdWx0Q2FsbHM6IHN0cmluZ1tdID0gW107XG5cbiAgYXN5bmMgc3RhcnRTZXNzaW9uKG9wdHM6IHsgcHJvamVjdERpcjogc3RyaW5nOyBjb21tYW5kPzogc3RyaW5nIH0pOiBQcm9taXNlPHN0cmluZz4ge1xuICAgIHRoaXMuc3RhcnRTZXNzaW9uQ2FsbHMucHVzaChvcHRzKTtcbiAgICByZXR1cm4gJ3Nlc3MtbmV3LTEyMyc7XG4gIH1cblxuICBnZXRTZXNzaW9uKHNlc3Npb25JZDogc3RyaW5nKTogTWFuYWdlZFNlc3Npb24gfCB1bmRlZmluZWQge1xuICAgIHJldHVybiB0aGlzLnNlc3Npb25zLmZpbmQoKHMpID0+IHMuc2Vzc2lvbklkID09PSBzZXNzaW9uSWQpO1xuICB9XG5cbiAgZ2V0QWxsU2Vzc2lvbnMoKTogTWFuYWdlZFNlc3Npb25bXSB7XG4gICAgcmV0dXJuIHRoaXMuc2Vzc2lvbnM7XG4gIH1cblxuICBhc3luYyBjYW5jZWxTZXNzaW9uKHNlc3Npb25JZDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgdGhpcy5jYW5jZWxTZXNzaW9uQ2FsbHMucHVzaChzZXNzaW9uSWQpO1xuICB9XG5cbiAgZ2V0UmVzdWx0KHNlc3Npb25JZDogc3RyaW5nKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIGNvbnN0IHNlc3Npb24gPSB0aGlzLnNlc3Npb25zLmZpbmQoKHMpID0+IHMuc2Vzc2lvbklkID09PSBzZXNzaW9uSWQpO1xuICAgIGlmICghc2Vzc2lvbikgdGhyb3cgbmV3IEVycm9yKGBTZXNzaW9uIG5vdCBmb3VuZDogJHtzZXNzaW9uSWR9YCk7XG4gICAgcmV0dXJuIHtcbiAgICAgIHNlc3Npb25JZDogc2Vzc2lvbi5zZXNzaW9uSWQsXG4gICAgICBwcm9qZWN0RGlyOiBzZXNzaW9uLnByb2plY3REaXIsXG4gICAgICBwcm9qZWN0TmFtZTogc2Vzc2lvbi5wcm9qZWN0TmFtZSxcbiAgICAgIHN0YXR1czogc2Vzc2lvbi5zdGF0dXMsXG4gICAgICBkdXJhdGlvbk1zOiAzMDBfMDAwLFxuICAgICAgY29zdDogc2Vzc2lvbi5jb3N0LFxuICAgICAgcmVjZW50RXZlbnRzOiBbXSxcbiAgICAgIHBlbmRpbmdCbG9ja2VyOiBudWxsLFxuICAgICAgZXJyb3I6IG51bGwsXG4gICAgfTtcbiAgfVxufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIE1vY2sgQ2hhbm5lbE1hbmFnZXIgKHVudXNlZCBieSBvcmNoZXN0cmF0b3IgZGlyZWN0bHksIGJ1dCByZXF1aXJlZCBieSBkZXBzKVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmNsYXNzIE1vY2tDaGFubmVsTWFuYWdlciB7fVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIE1vY2sgRGlzY29yZCBNZXNzYWdlXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZnVuY3Rpb24gbWFrZU1lc3NhZ2Uob3ZlcnJpZGVzOiBQYXJ0aWFsPHtcbiAgYXV0aG9ySWQ6IHN0cmluZztcbiAgYm90OiBib29sZWFuO1xuICBjaGFubmVsSWQ6IHN0cmluZztcbiAgY29udGVudDogc3RyaW5nO1xufT4pOiBEaXNjb3JkTWVzc2FnZUxpa2UgJiB7IHNlbnRNZXNzYWdlczogc3RyaW5nW10gfSB7XG4gIGNvbnN0IHNlbnRNZXNzYWdlczogc3RyaW5nW10gPSBbXTtcbiAgcmV0dXJuIHtcbiAgICBhdXRob3I6IHtcbiAgICAgIGlkOiBvdmVycmlkZXMuYXV0aG9ySWQgPz8gJ293bmVyLTEyMycsXG4gICAgICBib3Q6IG92ZXJyaWRlcy5ib3QgPz8gZmFsc2UsXG4gICAgfSxcbiAgICBjaGFubmVsSWQ6IG92ZXJyaWRlcy5jaGFubmVsSWQgPz8gJ2NvbnRyb2wtY2hhbm5lbC0xJyxcbiAgICBjb250ZW50OiBvdmVycmlkZXMuY29udGVudCA/PyAnaGVsbG8nLFxuICAgIGNoYW5uZWw6IHtcbiAgICAgIHNlbmQ6IGFzeW5jIChjb250ZW50OiBzdHJpbmcpID0+IHtcbiAgICAgICAgc2VudE1lc3NhZ2VzLnB1c2goY29udGVudCk7XG4gICAgICB9LFxuICAgICAgc2VuZFR5cGluZzogYXN5bmMgKCkgPT4ge30sXG4gICAgfSxcbiAgICBzZW50TWVzc2FnZXMsXG4gIH07XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gVGVzdCBTZXR1cCBGYWN0b3J5XG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZnVuY3Rpb24gbWFrZU9yY2hlc3RyYXRvcihvcHRzPzoge1xuICBjbGllbnQ/OiBNb2NrQW50aHJvcGljQ2xpZW50O1xuICBzZXNzaW9ucz86IE1hbmFnZWRTZXNzaW9uW107XG4gIHByb2plY3RzPzogUHJvamVjdEluZm9bXTtcbn0pIHtcbiAgY29uc3QgZGlyID0gdG1wRGlyKCk7XG4gIGNsZWFudXBEaXJzLnB1c2goZGlyKTtcbiAgY29uc3QgbG9nUGF0aCA9IGpvaW4oZGlyLCAndGVzdC5sb2cnKTtcbiAgY29uc3QgbG9nZ2VyID0gbmV3IExvZ2dlcih7IGZpbGVQYXRoOiBsb2dQYXRoLCBsZXZlbDogJ2RlYnVnJyB9KTtcbiAgYWN0aXZlTG9nZ2Vycy5wdXNoKGxvZ2dlcik7XG5cbiAgY29uc3Qgc2Vzc2lvbk1hbmFnZXIgPSBuZXcgTW9ja1Nlc3Npb25NYW5hZ2VyKCk7XG4gIGlmIChvcHRzPy5zZXNzaW9ucykgc2Vzc2lvbk1hbmFnZXIuc2Vzc2lvbnMgPSBvcHRzLnNlc3Npb25zO1xuXG4gIGNvbnN0IHByb2plY3RzOiBQcm9qZWN0SW5mb1tdID0gb3B0cz8ucHJvamVjdHMgPz8gW1xuICAgIHsgbmFtZTogJ2FscGhhJywgcGF0aDogJy9ob21lL3VzZXIvYWxwaGEnLCBtYXJrZXJzOiBbJ2dpdCcsICdub2RlJywgJ2dzZCddLCBsYXN0TW9kaWZpZWQ6IERhdGUubm93KCkgfSxcbiAgICB7IG5hbWU6ICdicmF2bycsIHBhdGg6ICcvaG9tZS91c2VyL2JyYXZvJywgbWFya2VyczogWydnaXQnLCAncnVzdCddLCBsYXN0TW9kaWZpZWQ6IERhdGUubm93KCkgfSxcbiAgXTtcblxuICBjb25zdCBjb25maWc6IE9yY2hlc3RyYXRvckNvbmZpZyA9IHtcbiAgICBtb2RlbDogJ2NsYXVkZS1zb25uZXQtNC0yMDI1MDUxNCcsXG4gICAgbWF4X3Rva2VuczogNDA5NixcbiAgICBjb250cm9sX2NoYW5uZWxfaWQ6ICdjb250cm9sLWNoYW5uZWwtMScsXG4gIH07XG5cbiAgY29uc3QgZGVwczogT3JjaGVzdHJhdG9yRGVwcyA9IHtcbiAgICBzZXNzaW9uTWFuYWdlcjogc2Vzc2lvbk1hbmFnZXIgYXMgdW5rbm93biBhcyBPcmNoZXN0cmF0b3JEZXBzWydzZXNzaW9uTWFuYWdlciddLFxuICAgIGNoYW5uZWxNYW5hZ2VyOiBuZXcgTW9ja0NoYW5uZWxNYW5hZ2VyKCkgYXMgdW5rbm93biBhcyBPcmNoZXN0cmF0b3JEZXBzWydjaGFubmVsTWFuYWdlciddLFxuICAgIHNjYW5Qcm9qZWN0czogYXN5bmMgKCkgPT4gcHJvamVjdHMsXG4gICAgY29uZmlnLFxuICAgIGxvZ2dlcixcbiAgICBvd25lcklkOiAnb3duZXItMTIzJyxcbiAgfTtcblxuICBjb25zdCBtb2NrQ2xpZW50ID0gb3B0cz8uY2xpZW50ID8/IG5ldyBNb2NrQW50aHJvcGljQ2xpZW50KCk7XG4gIGNvbnN0IG9yY2hlc3RyYXRvciA9IG5ldyBPcmNoZXN0cmF0b3IoZGVwcywgbW9ja0NsaWVudCBhcyB1bmtub3duIGFzIGltcG9ydCgnQGFudGhyb3BpYy1haS9zZGsnKS5kZWZhdWx0KTtcblxuICByZXR1cm4geyBvcmNoZXN0cmF0b3IsIG1vY2tDbGllbnQsIHNlc3Npb25NYW5hZ2VyLCBsb2dnZXIsIGxvZ1BhdGggfTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBUZXN0c1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmRlc2NyaWJlKCdPcmNoZXN0cmF0b3InLCAoKSA9PiB7XG4gIC8vIENsZWFuIHVwIGFmdGVyIGVhY2ggdGVzdCBzbyBsb2dnZXIgc3RyZWFtcyBhcmUgZmx1c2hlZCBiZWZvcmUgZGlycyByZW1vdmVkXG4gIGFmdGVyRWFjaChhc3luYyAoKSA9PiB7XG4gICAgYXdhaXQgY2xlYW51cEFsbCgpO1xuICB9KTtcblxuICAvLyAtLS0tIFRvb2wgZGVmaW5pdGlvbnMgLS0tLVxuXG4gIGRlc2NyaWJlKCd0b29sIGRlZmluaXRpb25zJywgKCkgPT4ge1xuICAgIGl0KCdwYXNzZXMgNSB0b29scyB0byB0aGUgQW50aHJvcGljIEFQSScsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHsgb3JjaGVzdHJhdG9yLCBtb2NrQ2xpZW50IH0gPSBtYWtlT3JjaGVzdHJhdG9yKCk7XG4gICAgICBjb25zdCBtc2cgPSBtYWtlTWVzc2FnZSh7IGNvbnRlbnQ6ICd3aGF0IGNhbiB5b3UgZG8/JyB9KTtcbiAgICAgIGF3YWl0IG9yY2hlc3RyYXRvci5oYW5kbGVNZXNzYWdlKG1zZyk7XG5cbiAgICAgIGFzc2VydC5vayhtb2NrQ2xpZW50Lmxhc3RDcmVhdGVQYXJhbXMpO1xuICAgICAgY29uc3QgdG9vbHMgPSBtb2NrQ2xpZW50Lmxhc3RDcmVhdGVQYXJhbXMudG9vbHMgYXMgQXJyYXk8eyBuYW1lOiBzdHJpbmcgfT47XG4gICAgICBhc3NlcnQuZXF1YWwodG9vbHMubGVuZ3RoLCA1KTtcblxuICAgICAgY29uc3QgbmFtZXMgPSB0b29scy5tYXAoKHQpID0+IHQubmFtZSkuc29ydCgpO1xuICAgICAgYXNzZXJ0LmRlZXBFcXVhbChuYW1lcywgW1xuICAgICAgICAnZ2V0X3Nlc3Npb25fZGV0YWlsJyxcbiAgICAgICAgJ2dldF9zdGF0dXMnLFxuICAgICAgICAnbGlzdF9wcm9qZWN0cycsXG4gICAgICAgICdzdGFydF9zZXNzaW9uJyxcbiAgICAgICAgJ3N0b3Bfc2Vzc2lvbicsXG4gICAgICBdKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgLy8gLS0tLSBsaXN0X3Byb2plY3RzIHRvb2wgLS0tLVxuXG4gIGRlc2NyaWJlKCdsaXN0X3Byb2plY3RzIHRvb2wnLCAoKSA9PiB7XG4gICAgaXQoJ3JldHVybnMgcHJvamVjdCBsaXN0IGZyb20gc2NhblByb2plY3RzJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgbW9ja0NsaWVudCA9IG5ldyBNb2NrQW50aHJvcGljQ2xpZW50KFxuICAgICAgICBNb2NrQW50aHJvcGljQ2xpZW50LnRvb2xUaGVuVGV4dEhhbmRsZXIoJ2xpc3RfcHJvamVjdHMnLCB7fSwgJ0hlcmUgYXJlIHlvdXIgcHJvamVjdHMnKSxcbiAgICAgICk7XG4gICAgICBjb25zdCB7IG9yY2hlc3RyYXRvciB9ID0gbWFrZU9yY2hlc3RyYXRvcih7IGNsaWVudDogbW9ja0NsaWVudCB9KTtcbiAgICAgIGNvbnN0IG1zZyA9IG1ha2VNZXNzYWdlKHsgY29udGVudDogJ2xpc3QgbXkgcHJvamVjdHMnIH0pO1xuICAgICAgYXdhaXQgb3JjaGVzdHJhdG9yLmhhbmRsZU1lc3NhZ2UobXNnKTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKG1zZy5zZW50TWVzc2FnZXMubGVuZ3RoLCAxKTtcbiAgICAgIGFzc2VydC5lcXVhbChtc2cuc2VudE1lc3NhZ2VzWzBdLCAnSGVyZSBhcmUgeW91ciBwcm9qZWN0cycpO1xuICAgICAgLy8gVGhlIHRvb2wgd2FzIGNhbGxlZCAoMiBjcmVhdGUgY2FsbHM6IHRvb2xfdXNlICsgZW5kX3R1cm4pXG4gICAgICBhc3NlcnQuZXF1YWwobW9ja0NsaWVudC5jcmVhdGVDYWxsQ291bnQsIDIpO1xuICAgIH0pO1xuICB9KTtcblxuICAvLyAtLS0tIHN0YXJ0X3Nlc3Npb24gdG9vbCAtLS0tXG5cbiAgZGVzY3JpYmUoJ3N0YXJ0X3Nlc3Npb24gdG9vbCcsICgpID0+IHtcbiAgICBpdCgnY2FsbHMgc2Vzc2lvbk1hbmFnZXIuc3RhcnRTZXNzaW9uIGFuZCByZXR1cm5zIGNvbmZpcm1hdGlvbicsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IG1vY2tDbGllbnQgPSBuZXcgTW9ja0FudGhyb3BpY0NsaWVudChcbiAgICAgICAgTW9ja0FudGhyb3BpY0NsaWVudC50b29sVGhlblRleHRIYW5kbGVyKFxuICAgICAgICAgICdzdGFydF9zZXNzaW9uJyxcbiAgICAgICAgICB7IHByb2plY3RQYXRoOiAnL2hvbWUvdXNlci9hbHBoYScgfSxcbiAgICAgICAgICAnU3RhcnRlZCBzZXNzaW9uIGZvciBhbHBoYScsXG4gICAgICAgICksXG4gICAgICApO1xuICAgICAgY29uc3QgeyBvcmNoZXN0cmF0b3IsIHNlc3Npb25NYW5hZ2VyIH0gPSBtYWtlT3JjaGVzdHJhdG9yKHsgY2xpZW50OiBtb2NrQ2xpZW50IH0pO1xuICAgICAgY29uc3QgbXNnID0gbWFrZU1lc3NhZ2UoeyBjb250ZW50OiAnc3RhcnQgYWxwaGEnIH0pO1xuICAgICAgYXdhaXQgb3JjaGVzdHJhdG9yLmhhbmRsZU1lc3NhZ2UobXNnKTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKHNlc3Npb25NYW5hZ2VyLnN0YXJ0U2Vzc2lvbkNhbGxzLmxlbmd0aCwgMSk7XG4gICAgICBhc3NlcnQuZXF1YWwoc2Vzc2lvbk1hbmFnZXIuc3RhcnRTZXNzaW9uQ2FsbHNbMF0hLnByb2plY3REaXIsICcvaG9tZS91c2VyL2FscGhhJyk7XG4gICAgICBhc3NlcnQuZXF1YWwobXNnLnNlbnRNZXNzYWdlc1swXSwgJ1N0YXJ0ZWQgc2Vzc2lvbiBmb3IgYWxwaGEnKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgLy8gLS0tLSBnZXRfc3RhdHVzIHRvb2wgLS0tLVxuXG4gIGRlc2NyaWJlKCdnZXRfc3RhdHVzIHRvb2wnLCAoKSA9PiB7XG4gICAgaXQoJ3JldHVybnMgZm9ybWF0dGVkIHNlc3Npb24gc3RhdHVzJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3Qgc2Vzc2lvbiA9IG1ha2VNb2NrU2Vzc2lvbih7IHByb2plY3ROYW1lOiAnYWxwaGEnLCBzdGF0dXM6ICdydW5uaW5nJyBhcyBTZXNzaW9uU3RhdHVzIH0pO1xuICAgICAgY29uc3QgbW9ja0NsaWVudCA9IG5ldyBNb2NrQW50aHJvcGljQ2xpZW50KFxuICAgICAgICBNb2NrQW50aHJvcGljQ2xpZW50LnRvb2xUaGVuVGV4dEhhbmRsZXIoJ2dldF9zdGF0dXMnLCB7fSwgJ1N0YXR1czogYWxwaGEgaXMgcnVubmluZycpLFxuICAgICAgKTtcbiAgICAgIGNvbnN0IHsgb3JjaGVzdHJhdG9yIH0gPSBtYWtlT3JjaGVzdHJhdG9yKHsgY2xpZW50OiBtb2NrQ2xpZW50LCBzZXNzaW9uczogW3Nlc3Npb25dIH0pO1xuICAgICAgY29uc3QgbXNnID0gbWFrZU1lc3NhZ2UoeyBjb250ZW50OiAnc3RhdHVzJyB9KTtcbiAgICAgIGF3YWl0IG9yY2hlc3RyYXRvci5oYW5kbGVNZXNzYWdlKG1zZyk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChtc2cuc2VudE1lc3NhZ2VzWzBdLCAnU3RhdHVzOiBhbHBoYSBpcyBydW5uaW5nJyk7XG4gICAgfSk7XG5cbiAgICBpdCgnaGFuZGxlcyBlbXB0eSBzZXNzaW9uIGxpc3QnLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBtb2NrQ2xpZW50ID0gbmV3IE1vY2tBbnRocm9waWNDbGllbnQoXG4gICAgICAgIE1vY2tBbnRocm9waWNDbGllbnQudG9vbFRoZW5UZXh0SGFuZGxlcignZ2V0X3N0YXR1cycsIHt9LCAnTm8gc2Vzc2lvbnMgcnVubmluZycpLFxuICAgICAgKTtcbiAgICAgIGNvbnN0IHsgb3JjaGVzdHJhdG9yIH0gPSBtYWtlT3JjaGVzdHJhdG9yKHsgY2xpZW50OiBtb2NrQ2xpZW50LCBzZXNzaW9uczogW10gfSk7XG4gICAgICBjb25zdCBtc2cgPSBtYWtlTWVzc2FnZSh7IGNvbnRlbnQ6ICdzdGF0dXMnIH0pO1xuICAgICAgYXdhaXQgb3JjaGVzdHJhdG9yLmhhbmRsZU1lc3NhZ2UobXNnKTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKG1zZy5zZW50TWVzc2FnZXNbMF0sICdObyBzZXNzaW9ucyBydW5uaW5nJyk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIC8vIC0tLS0gc3RvcF9zZXNzaW9uIHRvb2wgLS0tLVxuXG4gIGRlc2NyaWJlKCdzdG9wX3Nlc3Npb24gdG9vbCcsICgpID0+IHtcbiAgICBpdCgnc3RvcHMgc2Vzc2lvbiBtYXRjaGVkIGJ5IHNlc3Npb25JZCcsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHNlc3Npb24gPSBtYWtlTW9ja1Nlc3Npb24oeyBzZXNzaW9uSWQ6ICdzZXNzLWFiYycsIHByb2plY3ROYW1lOiAnYWxwaGEnIH0pO1xuICAgICAgY29uc3QgbW9ja0NsaWVudCA9IG5ldyBNb2NrQW50aHJvcGljQ2xpZW50KFxuICAgICAgICBNb2NrQW50aHJvcGljQ2xpZW50LnRvb2xUaGVuVGV4dEhhbmRsZXIoXG4gICAgICAgICAgJ3N0b3Bfc2Vzc2lvbicsXG4gICAgICAgICAgeyBpZGVudGlmaWVyOiAnc2Vzcy1hYmMnIH0sXG4gICAgICAgICAgJ1N0b3BwZWQgYWxwaGEnLFxuICAgICAgICApLFxuICAgICAgKTtcbiAgICAgIGNvbnN0IHsgb3JjaGVzdHJhdG9yLCBzZXNzaW9uTWFuYWdlciB9ID0gbWFrZU9yY2hlc3RyYXRvcih7IGNsaWVudDogbW9ja0NsaWVudCwgc2Vzc2lvbnM6IFtzZXNzaW9uXSB9KTtcbiAgICAgIGNvbnN0IG1zZyA9IG1ha2VNZXNzYWdlKHsgY29udGVudDogJ3N0b3Agc2Vzcy1hYmMnIH0pO1xuICAgICAgYXdhaXQgb3JjaGVzdHJhdG9yLmhhbmRsZU1lc3NhZ2UobXNnKTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKHNlc3Npb25NYW5hZ2VyLmNhbmNlbFNlc3Npb25DYWxscy5sZW5ndGgsIDEpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHNlc3Npb25NYW5hZ2VyLmNhbmNlbFNlc3Npb25DYWxsc1swXSwgJ3Nlc3MtYWJjJyk7XG4gICAgfSk7XG5cbiAgICBpdCgnZnV6enkgbWF0Y2hlcyBieSBwcm9qZWN0IG5hbWUnLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBzZXNzaW9uID0gbWFrZU1vY2tTZXNzaW9uKHsgc2Vzc2lvbklkOiAnc2Vzcy14eXonLCBwcm9qZWN0TmFtZTogJ215LWJpZy1wcm9qZWN0JyB9KTtcbiAgICAgIGNvbnN0IG1vY2tDbGllbnQgPSBuZXcgTW9ja0FudGhyb3BpY0NsaWVudChcbiAgICAgICAgTW9ja0FudGhyb3BpY0NsaWVudC50b29sVGhlblRleHRIYW5kbGVyKFxuICAgICAgICAgICdzdG9wX3Nlc3Npb24nLFxuICAgICAgICAgIHsgaWRlbnRpZmllcjogJ2JpZy1wcm9qZWN0JyB9LFxuICAgICAgICAgICdTdG9wcGVkIG15LWJpZy1wcm9qZWN0JyxcbiAgICAgICAgKSxcbiAgICAgICk7XG4gICAgICBjb25zdCB7IG9yY2hlc3RyYXRvciwgc2Vzc2lvbk1hbmFnZXIgfSA9IG1ha2VPcmNoZXN0cmF0b3IoeyBjbGllbnQ6IG1vY2tDbGllbnQsIHNlc3Npb25zOiBbc2Vzc2lvbl0gfSk7XG4gICAgICBjb25zdCBtc2cgPSBtYWtlTWVzc2FnZSh7IGNvbnRlbnQ6ICdzdG9wIGJpZyBwcm9qZWN0JyB9KTtcbiAgICAgIGF3YWl0IG9yY2hlc3RyYXRvci5oYW5kbGVNZXNzYWdlKG1zZyk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChzZXNzaW9uTWFuYWdlci5jYW5jZWxTZXNzaW9uQ2FsbHMubGVuZ3RoLCAxKTtcbiAgICAgIGFzc2VydC5lcXVhbChzZXNzaW9uTWFuYWdlci5jYW5jZWxTZXNzaW9uQ2FsbHNbMF0sICdzZXNzLXh5eicpO1xuICAgIH0pO1xuXG4gICAgaXQoJ3JldHVybnMgbm90LWZvdW5kIGZvciB1bm1hdGNoZWQgaWRlbnRpZmllcicsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IG1vY2tDbGllbnQgPSBuZXcgTW9ja0FudGhyb3BpY0NsaWVudChcbiAgICAgICAgTW9ja0FudGhyb3BpY0NsaWVudC50b29sVGhlblRleHRIYW5kbGVyKFxuICAgICAgICAgICdzdG9wX3Nlc3Npb24nLFxuICAgICAgICAgIHsgaWRlbnRpZmllcjogJ25vbmV4aXN0ZW50JyB9LFxuICAgICAgICAgICdObyBzZXNzaW9uIGZvdW5kJyxcbiAgICAgICAgKSxcbiAgICAgICk7XG4gICAgICBjb25zdCB7IG9yY2hlc3RyYXRvciwgc2Vzc2lvbk1hbmFnZXIgfSA9IG1ha2VPcmNoZXN0cmF0b3IoeyBjbGllbnQ6IG1vY2tDbGllbnQsIHNlc3Npb25zOiBbXSB9KTtcbiAgICAgIGNvbnN0IG1zZyA9IG1ha2VNZXNzYWdlKHsgY29udGVudDogJ3N0b3Agbm9uZXhpc3RlbnQnIH0pO1xuICAgICAgYXdhaXQgb3JjaGVzdHJhdG9yLmhhbmRsZU1lc3NhZ2UobXNnKTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKHNlc3Npb25NYW5hZ2VyLmNhbmNlbFNlc3Npb25DYWxscy5sZW5ndGgsIDApO1xuICAgIH0pO1xuICB9KTtcblxuICAvLyAtLS0tIGdldF9zZXNzaW9uX2RldGFpbCB0b29sIC0tLS1cblxuICBkZXNjcmliZSgnZ2V0X3Nlc3Npb25fZGV0YWlsIHRvb2wnLCAoKSA9PiB7XG4gICAgaXQoJ3JldHVybnMgZm9ybWF0dGVkIHNlc3Npb24gZGV0YWlsJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3Qgc2Vzc2lvbiA9IG1ha2VNb2NrU2Vzc2lvbih7IHNlc3Npb25JZDogJ3Nlc3MtZGV0YWlsJyB9KTtcbiAgICAgIGNvbnN0IG1vY2tDbGllbnQgPSBuZXcgTW9ja0FudGhyb3BpY0NsaWVudChcbiAgICAgICAgTW9ja0FudGhyb3BpY0NsaWVudC50b29sVGhlblRleHRIYW5kbGVyKFxuICAgICAgICAgICdnZXRfc2Vzc2lvbl9kZXRhaWwnLFxuICAgICAgICAgIHsgc2Vzc2lvbklkOiAnc2Vzcy1kZXRhaWwnIH0sXG4gICAgICAgICAgJ1Nlc3Npb24gZGV0YWlscyBmb3IgbXktcHJvamVjdCcsXG4gICAgICAgICksXG4gICAgICApO1xuICAgICAgY29uc3QgeyBvcmNoZXN0cmF0b3IgfSA9IG1ha2VPcmNoZXN0cmF0b3IoeyBjbGllbnQ6IG1vY2tDbGllbnQsIHNlc3Npb25zOiBbc2Vzc2lvbl0gfSk7XG4gICAgICBjb25zdCBtc2cgPSBtYWtlTWVzc2FnZSh7IGNvbnRlbnQ6ICdkZXRhaWwgc2Vzcy1kZXRhaWwnIH0pO1xuICAgICAgYXdhaXQgb3JjaGVzdHJhdG9yLmhhbmRsZU1lc3NhZ2UobXNnKTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKG1zZy5zZW50TWVzc2FnZXNbMF0sICdTZXNzaW9uIGRldGFpbHMgZm9yIG15LXByb2plY3QnKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgLy8gLS0tLSBNZXNzYWdlIHJvdXRpbmcgLyBhdXRoIGd1YXJkcyAtLS0tXG5cbiAgZGVzY3JpYmUoJ2hhbmRsZU1lc3NhZ2Ugcm91dGluZycsICgpID0+IHtcbiAgICBpdCgnaWdub3JlcyBib3QgbWVzc2FnZXMnLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCB7IG9yY2hlc3RyYXRvciwgbW9ja0NsaWVudCB9ID0gbWFrZU9yY2hlc3RyYXRvcigpO1xuICAgICAgY29uc3QgbXNnID0gbWFrZU1lc3NhZ2UoeyBib3Q6IHRydWUsIGNvbnRlbnQ6ICdoZWxsbyBmcm9tIGJvdCcgfSk7XG4gICAgICBhd2FpdCBvcmNoZXN0cmF0b3IuaGFuZGxlTWVzc2FnZShtc2cpO1xuXG4gICAgICBhc3NlcnQuZXF1YWwobW9ja0NsaWVudC5jcmVhdGVDYWxsQ291bnQsIDApO1xuICAgICAgYXNzZXJ0LmVxdWFsKG1zZy5zZW50TWVzc2FnZXMubGVuZ3RoLCAwKTtcbiAgICB9KTtcblxuICAgIGl0KCdpZ25vcmVzIG5vbi1vd25lciBtZXNzYWdlcycsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHsgb3JjaGVzdHJhdG9yLCBtb2NrQ2xpZW50IH0gPSBtYWtlT3JjaGVzdHJhdG9yKCk7XG4gICAgICBjb25zdCBtc2cgPSBtYWtlTWVzc2FnZSh7IGF1dGhvcklkOiAnc3RyYW5nZXItNDU2JywgY29udGVudDogJ2hhY2sgdGhlIHBsYW5ldCcgfSk7XG4gICAgICBhd2FpdCBvcmNoZXN0cmF0b3IuaGFuZGxlTWVzc2FnZShtc2cpO1xuXG4gICAgICBhc3NlcnQuZXF1YWwobW9ja0NsaWVudC5jcmVhdGVDYWxsQ291bnQsIDApO1xuICAgICAgYXNzZXJ0LmVxdWFsKG1zZy5zZW50TWVzc2FnZXMubGVuZ3RoLCAwKTtcbiAgICB9KTtcblxuICAgIGl0KCdpZ25vcmVzIG1lc3NhZ2VzIGZyb20gbm9uLWNvbnRyb2wgY2hhbm5lbHMnLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCB7IG9yY2hlc3RyYXRvciwgbW9ja0NsaWVudCB9ID0gbWFrZU9yY2hlc3RyYXRvcigpO1xuICAgICAgY29uc3QgbXNnID0gbWFrZU1lc3NhZ2UoeyBjaGFubmVsSWQ6ICdyYW5kb20tY2hhbm5lbCcsIGNvbnRlbnQ6ICdoZWxsbycgfSk7XG4gICAgICBhd2FpdCBvcmNoZXN0cmF0b3IuaGFuZGxlTWVzc2FnZShtc2cpO1xuXG4gICAgICBhc3NlcnQuZXF1YWwobW9ja0NsaWVudC5jcmVhdGVDYWxsQ291bnQsIDApO1xuICAgICAgYXNzZXJ0LmVxdWFsKG1zZy5zZW50TWVzc2FnZXMubGVuZ3RoLCAwKTtcbiAgICB9KTtcblxuICAgIGl0KCdpZ25vcmVzIGVtcHR5IG1lc3NhZ2UgY29udGVudCcsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHsgb3JjaGVzdHJhdG9yLCBtb2NrQ2xpZW50IH0gPSBtYWtlT3JjaGVzdHJhdG9yKCk7XG4gICAgICBjb25zdCBtc2cgPSBtYWtlTWVzc2FnZSh7IGNvbnRlbnQ6ICcgICAnIH0pO1xuICAgICAgYXdhaXQgb3JjaGVzdHJhdG9yLmhhbmRsZU1lc3NhZ2UobXNnKTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKG1vY2tDbGllbnQuY3JlYXRlQ2FsbENvdW50LCAwKTtcbiAgICB9KTtcblxuICAgIGl0KCdyb3V0ZXMgdmFsaWQgbWVzc2FnZSB0aHJvdWdoIExMTSBhbmQgc2VuZHMgcmVzcG9uc2UnLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCB7IG9yY2hlc3RyYXRvciwgbW9ja0NsaWVudCB9ID0gbWFrZU9yY2hlc3RyYXRvcigpO1xuICAgICAgY29uc3QgbXNnID0gbWFrZU1lc3NhZ2UoeyBjb250ZW50OiAnaGVsbG8gb3JjaGVzdHJhdG9yJyB9KTtcbiAgICAgIGF3YWl0IG9yY2hlc3RyYXRvci5oYW5kbGVNZXNzYWdlKG1zZyk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChtb2NrQ2xpZW50LmNyZWF0ZUNhbGxDb3VudCwgMSk7XG4gICAgICBhc3NlcnQuZXF1YWwobXNnLnNlbnRNZXNzYWdlcy5sZW5ndGgsIDEpO1xuICAgICAgYXNzZXJ0LmVxdWFsKG1zZy5zZW50TWVzc2FnZXNbMF0sICdNb2NrIExMTSByZXNwb25zZScpO1xuICAgIH0pO1xuICB9KTtcblxuICAvLyAtLS0tIENvbnZlcnNhdGlvbiBoaXN0b3J5IC0tLS1cblxuICBkZXNjcmliZSgnY29udmVyc2F0aW9uIGhpc3RvcnknLCAoKSA9PiB7XG4gICAgaXQoJ2FjY3VtdWxhdGVzIHVzZXIgYW5kIGFzc2lzdGFudCBlbnRyaWVzJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgeyBvcmNoZXN0cmF0b3IgfSA9IG1ha2VPcmNoZXN0cmF0b3IoKTtcblxuICAgICAgYXdhaXQgb3JjaGVzdHJhdG9yLmhhbmRsZU1lc3NhZ2UobWFrZU1lc3NhZ2UoeyBjb250ZW50OiAnZmlyc3QnIH0pKTtcbiAgICAgIGF3YWl0IG9yY2hlc3RyYXRvci5oYW5kbGVNZXNzYWdlKG1ha2VNZXNzYWdlKHsgY29udGVudDogJ3NlY29uZCcgfSkpO1xuXG4gICAgICBjb25zdCBoaXN0b3J5ID0gb3JjaGVzdHJhdG9yLmdldEhpc3RvcnkoKTtcbiAgICAgIGFzc2VydC5lcXVhbChoaXN0b3J5Lmxlbmd0aCwgNCk7IC8vIDIgdXNlciArIDIgYXNzaXN0YW50XG4gICAgICBhc3NlcnQuZXF1YWwoaGlzdG9yeVswXSEucm9sZSwgJ3VzZXInKTtcbiAgICAgIGFzc2VydC5lcXVhbChoaXN0b3J5WzFdIS5yb2xlLCAnYXNzaXN0YW50Jyk7XG4gICAgICBhc3NlcnQuZXF1YWwoaGlzdG9yeVsyXSEucm9sZSwgJ3VzZXInKTtcbiAgICAgIGFzc2VydC5lcXVhbChoaXN0b3J5WzNdIS5yb2xlLCAnYXNzaXN0YW50Jyk7XG4gICAgfSk7XG5cbiAgICBpdCgndHJpbXMgdG8gTUFYX0hJU1RPUlkgKDMwKSBieSByZW1vdmluZyBvbGRlc3QgcGFpcnMnLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCB7IG9yY2hlc3RyYXRvciB9ID0gbWFrZU9yY2hlc3RyYXRvcigpO1xuXG4gICAgICAvLyBTZW5kIDE3IG1lc3NhZ2VzIFx1MjE5MiAzNCBoaXN0b3J5IGVudHJpZXMgKDE3IHVzZXIgKyAxNyBhc3Npc3RhbnQpXG4gICAgICAvLyBBZnRlciB0cmltbWluZzogc2hvdWxkIGJlIFx1MjI2NDMwXG4gICAgICBmb3IgKGxldCBpID0gMDsgaSA8IDE3OyBpKyspIHtcbiAgICAgICAgYXdhaXQgb3JjaGVzdHJhdG9yLmhhbmRsZU1lc3NhZ2UobWFrZU1lc3NhZ2UoeyBjb250ZW50OiBgbXNnLSR7aX1gIH0pKTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgaGlzdG9yeSA9IG9yY2hlc3RyYXRvci5nZXRIaXN0b3J5KCk7XG4gICAgICBhc3NlcnQub2soaGlzdG9yeS5sZW5ndGggPD0gMzAsIGBIaXN0b3J5IGxlbmd0aCAke2hpc3RvcnkubGVuZ3RofSBleGNlZWRzIDMwYCk7XG4gICAgICAvLyBTaG91bGQgaGF2ZSB0cmltbWVkIGZyb20gdGhlIGZyb250IFx1MjAxNCBvbGRlc3QgZW50cmllcyBnb25lXG4gICAgICAvLyAzNCBlbnRyaWVzIFx1MjE5MiB0cmltIDIgYXQgYSB0aW1lIHVudGlsIFx1MjI2NDMwIFx1MjE5MiAzMCBlbnRyaWVzICh0cmltbWVkIDQpXG4gICAgICBhc3NlcnQuZXF1YWwoaGlzdG9yeS5sZW5ndGgsIDMwKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgLy8gLS0tLSBFcnJvciBoYW5kbGluZyAtLS0tXG5cbiAgZGVzY3JpYmUoJ2Vycm9yIGhhbmRsaW5nJywgKCkgPT4ge1xuICAgIGl0KCdzZW5kcyBlcnJvciBtZXNzYWdlIHRvIERpc2NvcmQgd2hlbiBMTE0gQVBJIHRocm93cycsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IG1vY2tDbGllbnQgPSBuZXcgTW9ja0FudGhyb3BpY0NsaWVudChcbiAgICAgICAgTW9ja0FudGhyb3BpY0NsaWVudC5lcnJvckhhbmRsZXIoJ0FQSSByYXRlIGxpbWl0IGV4Y2VlZGVkJyksXG4gICAgICApO1xuICAgICAgY29uc3QgeyBvcmNoZXN0cmF0b3IgfSA9IG1ha2VPcmNoZXN0cmF0b3IoeyBjbGllbnQ6IG1vY2tDbGllbnQgfSk7XG4gICAgICBjb25zdCBtc2cgPSBtYWtlTWVzc2FnZSh7IGNvbnRlbnQ6ICdoZWxsbycgfSk7XG4gICAgICBhd2FpdCBvcmNoZXN0cmF0b3IuaGFuZGxlTWVzc2FnZShtc2cpO1xuXG4gICAgICBhc3NlcnQuZXF1YWwobXNnLnNlbnRNZXNzYWdlcy5sZW5ndGgsIDEpO1xuICAgICAgYXNzZXJ0Lm9rKG1zZy5zZW50TWVzc2FnZXNbMF0hLmluY2x1ZGVzKCdTb21ldGhpbmcgd2VudCB3cm9uZycpKTtcbiAgICB9KTtcblxuICAgIGl0KCdhcHBlbmRzIGVycm9yIHBsYWNlaG9sZGVyIHRvIGhpc3Rvcnkgb24gTExNIGZhaWx1cmUnLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBtb2NrQ2xpZW50ID0gbmV3IE1vY2tBbnRocm9waWNDbGllbnQoXG4gICAgICAgIE1vY2tBbnRocm9waWNDbGllbnQuZXJyb3JIYW5kbGVyKCdOZXR3b3JrIGVycm9yJyksXG4gICAgICApO1xuICAgICAgY29uc3QgeyBvcmNoZXN0cmF0b3IgfSA9IG1ha2VPcmNoZXN0cmF0b3IoeyBjbGllbnQ6IG1vY2tDbGllbnQgfSk7XG4gICAgICBhd2FpdCBvcmNoZXN0cmF0b3IuaGFuZGxlTWVzc2FnZShtYWtlTWVzc2FnZSh7IGNvbnRlbnQ6ICdmYWlsJyB9KSk7XG5cbiAgICAgIGNvbnN0IGhpc3RvcnkgPSBvcmNoZXN0cmF0b3IuZ2V0SGlzdG9yeSgpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGhpc3RvcnkubGVuZ3RoLCAyKTsgLy8gdXNlciArIGVycm9yIGFzc2lzdGFudFxuICAgICAgYXNzZXJ0LmVxdWFsKGhpc3RvcnlbMV0hLnJvbGUsICdhc3Npc3RhbnQnKTtcbiAgICAgIGFzc2VydC5lcXVhbChoaXN0b3J5WzFdIS5jb250ZW50LCAnW2Vycm9yIFx1MjAxNCBzZWUgbG9nc10nKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgLy8gLS0tLSBzdG9wKCkgLS0tLVxuXG4gIGRlc2NyaWJlKCdzdG9wKCknLCAoKSA9PiB7XG4gICAgaXQoJ2NsZWFycyBjb252ZXJzYXRpb24gaGlzdG9yeSBhbmQgbnVsbHMgY2xpZW50JywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgeyBvcmNoZXN0cmF0b3IgfSA9IG1ha2VPcmNoZXN0cmF0b3IoKTtcblxuICAgICAgYXdhaXQgb3JjaGVzdHJhdG9yLmhhbmRsZU1lc3NhZ2UobWFrZU1lc3NhZ2UoeyBjb250ZW50OiAnaGVsbG8nIH0pKTtcbiAgICAgIGFzc2VydC5vayhvcmNoZXN0cmF0b3IuZ2V0SGlzdG9yeSgpLmxlbmd0aCA+IDApO1xuXG4gICAgICBvcmNoZXN0cmF0b3Iuc3RvcCgpO1xuICAgICAgYXNzZXJ0LmVxdWFsKG9yY2hlc3RyYXRvci5nZXRIaXN0b3J5KCkubGVuZ3RoLCAwKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgLy8gLS0tLSBUb29sIGV4ZWN1dGlvbiBkaXJlY3QgdGVzdHMgLS0tLVxuXG4gIGRlc2NyaWJlKCd0b29sIGV4ZWN1dGlvbiAodmlhIGFnZW50IGxvb3ApJywgKCkgPT4ge1xuICAgIGl0KCdsaXN0X3Byb2plY3RzIHJldHVybnMgZW1wdHkgbWVzc2FnZSB3aGVuIG5vIHByb2plY3RzJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgbW9ja0NsaWVudCA9IG5ldyBNb2NrQW50aHJvcGljQ2xpZW50KFxuICAgICAgICBNb2NrQW50aHJvcGljQ2xpZW50LnRvb2xUaGVuVGV4dEhhbmRsZXIoJ2xpc3RfcHJvamVjdHMnLCB7fSwgJ05vIHByb2plY3RzJyksXG4gICAgICApO1xuICAgICAgY29uc3QgeyBvcmNoZXN0cmF0b3IgfSA9IG1ha2VPcmNoZXN0cmF0b3IoeyBjbGllbnQ6IG1vY2tDbGllbnQsIHByb2plY3RzOiBbXSB9KTtcbiAgICAgIGNvbnN0IG1zZyA9IG1ha2VNZXNzYWdlKHsgY29udGVudDogJ2xpc3QnIH0pO1xuICAgICAgYXdhaXQgb3JjaGVzdHJhdG9yLmhhbmRsZU1lc3NhZ2UobXNnKTtcblxuICAgICAgLy8gVGhlIHNlY29uZCBjcmVhdGUgY2FsbCByZWNlaXZlcyB0aGUgdG9vbCByZXN1bHRcbiAgICAgIGFzc2VydC5lcXVhbChtb2NrQ2xpZW50LmNyZWF0ZUNhbGxDb3VudCwgMik7XG4gICAgfSk7XG5cbiAgICBpdCgnc3RhcnRfc2Vzc2lvbiB3aXRoIG9wdGlvbmFsIGNvbW1hbmQgcGFzc2VzIHRocm91Z2gnLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBtb2NrQ2xpZW50ID0gbmV3IE1vY2tBbnRocm9waWNDbGllbnQoXG4gICAgICAgIE1vY2tBbnRocm9waWNDbGllbnQudG9vbFRoZW5UZXh0SGFuZGxlcihcbiAgICAgICAgICAnc3RhcnRfc2Vzc2lvbicsXG4gICAgICAgICAgeyBwcm9qZWN0UGF0aDogJy9wJywgY29tbWFuZDogJy9nc2QgcXVpY2sgZml4IHRlc3RzJyB9LFxuICAgICAgICAgICdTdGFydGVkJyxcbiAgICAgICAgKSxcbiAgICAgICk7XG4gICAgICBjb25zdCB7IG9yY2hlc3RyYXRvciwgc2Vzc2lvbk1hbmFnZXIgfSA9IG1ha2VPcmNoZXN0cmF0b3IoeyBjbGllbnQ6IG1vY2tDbGllbnQgfSk7XG4gICAgICBjb25zdCBtc2cgPSBtYWtlTWVzc2FnZSh7IGNvbnRlbnQ6ICdzdGFydCB3aXRoIGN1c3RvbSBjb21tYW5kJyB9KTtcbiAgICAgIGF3YWl0IG9yY2hlc3RyYXRvci5oYW5kbGVNZXNzYWdlKG1zZyk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChzZXNzaW9uTWFuYWdlci5zdGFydFNlc3Npb25DYWxscy5sZW5ndGgsIDEpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHNlc3Npb25NYW5hZ2VyLnN0YXJ0U2Vzc2lvbkNhbGxzWzBdIS5jb21tYW5kLCAnL2dzZCBxdWljayBmaXggdGVzdHMnKTtcbiAgICB9KTtcbiAgfSk7XG5cbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBT0EsU0FBUyxVQUFVLElBQUksaUJBQWlCO0FBQ3hDLE9BQU8sWUFBWTtBQUNuQixTQUFTLGFBQWEsUUFBUSxr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
