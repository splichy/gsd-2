import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { EventBridge } from "./event-bridge.js";
function createMockLogger() {
  return {
    debug: mock.fn(() => {
    }),
    info: mock.fn(() => {
    }),
    warn: mock.fn(() => {
    }),
    error: mock.fn(() => {
    })
  };
}
function createMockChannelManager() {
  const sentMessages = [];
  const mockChannel = {
    id: "ch-123",
    send: mock.fn(async (_payload) => {
      sentMessages.push(_payload);
      return { id: "msg-1" };
    }),
    createMessageComponentCollector: mock.fn((_opts) => {
      const collector = new EventEmitter();
      collector.stop = (reason) => collector.emit("end", [], reason ?? "manual");
      return collector;
    })
  };
  return {
    createProjectChannel: mock.fn(async (_dir) => mockChannel),
    _channel: mockChannel,
    _sentMessages: sentMessages
  };
}
function createMockClient() {
  const emitter = new EventEmitter();
  const dmSendFn = mock.fn(async () => ({}));
  const fetchFn = mock.fn(async (_id) => ({ send: dmSendFn }));
  emitter.users = { fetch: fetchFn };
  return Object.assign(emitter, {
    users: { fetch: fetchFn },
    _dmSend: dmSendFn
  });
}
function createMockSessionManager() {
  const sm = new EventEmitter();
  sm.getSession = mock.fn((_id) => void 0);
  sm.resolveBlocker = mock.fn(async (_sid, _resp) => {
  });
  return sm;
}
function createMockSession(overrides) {
  return {
    sessionId: "sess-1",
    projectDir: "/test/project",
    projectName: "project",
    status: "running",
    client: {
      steer: mock.fn(async (_msg) => {
      }),
      prompt: mock.fn(async () => ({}))
    },
    events: [],
    pendingBlocker: null,
    cost: { totalCost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    startTime: Date.now(),
    ...overrides
  };
}
const DEFAULT_CONFIG = {
  discord: {
    token: "test-token",
    guild_id: "guild-1",
    owner_id: "owner-1",
    dm_on_blocker: false
  },
  projects: { scan_roots: [] },
  log: { file: "/tmp/test.log", level: "debug", max_size_mb: 10 }
};
function buildBridge(overrides) {
  const sessionManager = createMockSessionManager();
  const channelManager = createMockChannelManager();
  const client = createMockClient();
  const logger = createMockLogger();
  const opts = {
    sessionManager,
    channelManager,
    client,
    config: DEFAULT_CONFIG,
    logger,
    ownerId: "owner-1",
    ...overrides
  };
  const bridge = new EventBridge(opts);
  return { bridge, sessionManager, channelManager, client, logger };
}
const tick = () => new Promise((r) => setTimeout(r, 30));
function mockFn(obj) {
  return obj;
}
describe("EventBridge", () => {
  describe("lifecycle", () => {
    it("start() subscribes to session manager events and messageCreate", () => {
      const { bridge, sessionManager, client } = buildBridge();
      bridge.start();
      assert.ok(sessionManager.listenerCount("session:started") > 0);
      assert.ok(sessionManager.listenerCount("session:event") > 0);
      assert.ok(sessionManager.listenerCount("session:blocked") > 0);
      assert.ok(sessionManager.listenerCount("session:completed") > 0);
      assert.ok(sessionManager.listenerCount("session:error") > 0);
      assert.ok(client.listenerCount("messageCreate") > 0);
    });
    it("stop() unsubscribes from all events and clears mappings", async () => {
      const { bridge, sessionManager, client } = buildBridge();
      bridge.start();
      await bridge.stop();
      assert.equal(sessionManager.listenerCount("session:started"), 0);
      assert.equal(sessionManager.listenerCount("session:event"), 0);
      assert.equal(sessionManager.listenerCount("session:blocked"), 0);
      assert.equal(sessionManager.listenerCount("session:completed"), 0);
      assert.equal(sessionManager.listenerCount("session:error"), 0);
      assert.equal(client.listenerCount("messageCreate"), 0);
    });
    it("start() is idempotent", () => {
      const { bridge, sessionManager } = buildBridge();
      bridge.start();
      bridge.start();
      assert.equal(sessionManager.listenerCount("session:started"), 1);
    });
    it("getVerbosityManager() returns a VerbosityManager", () => {
      const { bridge } = buildBridge();
      const vm = bridge.getVerbosityManager();
      assert.ok(vm);
      assert.equal(typeof vm.shouldShow, "function");
    });
  });
  describe("session:started \u2192 channel creation + welcome embed", () => {
    it("creates channel and batcher", async () => {
      const { bridge, sessionManager, channelManager } = buildBridge();
      bridge.start();
      sessionManager.emit("session:started", {
        sessionId: "sess-1",
        projectDir: "/test/project",
        projectName: "my-project"
      });
      await tick();
      assert.equal(mockFn(channelManager.createProjectChannel).mock.callCount(), 1);
    });
    it("logs error and skips when channel creation fails", async () => {
      const failingCm = {
        createProjectChannel: mock.fn(async () => {
          throw new Error("API error");
        })
      };
      const { bridge, sessionManager, logger } = buildBridge({
        channelManager: failingCm
      });
      bridge.start();
      sessionManager.emit("session:started", {
        sessionId: "sess-1",
        projectDir: "/test/project",
        projectName: "my-project"
      });
      await tick();
      assert.ok(mockFn(logger.error).mock.callCount() > 0);
    });
  });
  describe("session:event \u2192 format + verbosity filter + enqueue", () => {
    it("formats event and enqueues to batcher (no errors)", async () => {
      const { bridge, sessionManager, logger } = buildBridge();
      bridge.start();
      sessionManager.emit("session:started", {
        sessionId: "sess-1",
        projectDir: "/test/project",
        projectName: "my-project"
      });
      await tick();
      sessionManager.emit("session:event", {
        sessionId: "sess-1",
        projectDir: "/test/project",
        event: { type: "tool_execution_start", name: "read" }
      });
      await tick();
      assert.equal(mockFn(logger.error).mock.callCount(), 0);
    });
    it("filters events based on verbosity", async () => {
      const { bridge, sessionManager, channelManager, logger } = buildBridge();
      bridge.start();
      sessionManager.emit("session:started", {
        sessionId: "sess-1",
        projectDir: "/test/project",
        projectName: "my-project"
      });
      await tick();
      bridge.getVerbosityManager().setLevel("ch-123", "quiet");
      sessionManager.emit("session:event", {
        sessionId: "sess-1",
        projectDir: "/test/project",
        event: { type: "cost_update", cumulativeCost: 1.5 }
      });
      await tick();
      sessionManager.emit("session:event", {
        sessionId: "sess-1",
        projectDir: "/test/project",
        event: { type: "tool_execution_start", name: "read" }
      });
      await tick();
      assert.equal(mockFn(logger.error).mock.callCount(), 0);
    });
  });
  describe("session:blocked \u2192 blocker embed + buttons + optional DM", () => {
    it("sends blocker embed and creates collector for confirm", async () => {
      const { bridge, sessionManager, channelManager } = buildBridge();
      bridge.start();
      sessionManager.emit("session:started", {
        sessionId: "sess-1",
        projectDir: "/test/project",
        projectName: "my-project"
      });
      await tick();
      const blocker = {
        id: "blocker-1",
        method: "confirm",
        message: "Continue?",
        event: { id: "blocker-1", method: "confirm", message: "Continue?" }
      };
      sessionManager.emit("session:blocked", {
        sessionId: "sess-1",
        projectDir: "/test/project",
        projectName: "my-project",
        blocker
      });
      await tick();
      assert.ok(mockFn(channelManager._channel.createMessageComponentCollector).mock.callCount() > 0);
    });
    it("sends DM when dm_on_blocker is configured", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        discord: { ...DEFAULT_CONFIG.discord, dm_on_blocker: true }
      };
      const client = createMockClient();
      const { bridge, sessionManager } = buildBridge({ config, client });
      bridge.start();
      sessionManager.emit("session:started", {
        sessionId: "sess-1",
        projectDir: "/test/project",
        projectName: "my-project"
      });
      await tick();
      const blocker = {
        id: "blocker-1",
        method: "input",
        message: "Enter API key",
        event: { id: "blocker-1", method: "input" }
      };
      sessionManager.emit("session:blocked", {
        sessionId: "sess-1",
        projectDir: "/test/project",
        projectName: "my-project",
        blocker
      });
      await tick();
      const usersFetch = client.users.fetch;
      assert.equal(mockFn(usersFetch).mock.callCount(), 1);
    });
    it("does not send DM when dm_on_blocker is false", async () => {
      const client = createMockClient();
      const { bridge, sessionManager } = buildBridge({ client });
      bridge.start();
      sessionManager.emit("session:started", {
        sessionId: "sess-1",
        projectDir: "/test/project",
        projectName: "my-project"
      });
      await tick();
      const blocker = {
        id: "blocker-1",
        method: "input",
        message: "Enter value",
        event: { id: "blocker-1", method: "input" }
      };
      sessionManager.emit("session:blocked", {
        sessionId: "sess-1",
        projectDir: "/test/project",
        projectName: "my-project",
        blocker
      });
      await tick();
      const usersFetch = client.users.fetch;
      assert.equal(mockFn(usersFetch).mock.callCount(), 0);
    });
  });
  describe("button collector \u2192 resolveBlocker", () => {
    it("resolves blocker on button click from authorized user", async () => {
      const { bridge, sessionManager, channelManager } = buildBridge();
      bridge.start();
      sessionManager.emit("session:started", {
        sessionId: "sess-1",
        projectDir: "/test/project",
        projectName: "my-project"
      });
      await tick();
      const blocker = {
        id: "blocker-1",
        method: "confirm",
        message: "Confirm?",
        event: { id: "blocker-1", method: "confirm" }
      };
      sessionManager.emit("session:blocked", {
        sessionId: "sess-1",
        projectDir: "/test/project",
        projectName: "my-project",
        blocker
      });
      await tick();
      const collectorCalls = mockFn(channelManager._channel.createMessageComponentCollector).mock.calls;
      assert.ok(collectorCalls.length > 0);
      const collector = collectorCalls[0].result;
      const mockInteraction = {
        customId: "blocker:blocker-1:confirm:true",
        user: { id: "owner-1" },
        update: mock.fn(async () => {
        }),
        reply: mock.fn(async () => {
        })
      };
      collector.emit("collect", mockInteraction);
      await tick();
      assert.equal(mockFn(sessionManager.resolveBlocker).mock.callCount(), 1);
      const args = mockFn(sessionManager.resolveBlocker).mock.calls[0].arguments;
      assert.equal(args[0], "sess-1");
      assert.equal(args[1], "true");
    });
    it("rejects button click from unauthorized user", async () => {
      const { bridge, sessionManager, channelManager } = buildBridge();
      bridge.start();
      sessionManager.emit("session:started", {
        sessionId: "sess-1",
        projectDir: "/test/project",
        projectName: "my-project"
      });
      await tick();
      const blocker = {
        id: "blocker-1",
        method: "confirm",
        message: "Confirm?",
        event: { id: "blocker-1", method: "confirm" }
      };
      sessionManager.emit("session:blocked", {
        sessionId: "sess-1",
        projectDir: "/test/project",
        projectName: "my-project",
        blocker
      });
      await tick();
      const collectorCalls = mockFn(channelManager._channel.createMessageComponentCollector).mock.calls;
      const collector = collectorCalls[0].result;
      const mockInteraction = {
        customId: "blocker:blocker-1:confirm:true",
        user: { id: "stranger-99" },
        update: mock.fn(async () => {
        }),
        reply: mock.fn(async () => {
        })
      };
      collector.emit("collect", mockInteraction);
      await tick();
      assert.equal(mockFn(sessionManager.resolveBlocker).mock.callCount(), 0);
      assert.equal(mockFn(mockInteraction.reply).mock.callCount(), 1);
    });
    it("posts error when resolveBlocker throws", async () => {
      const { bridge, sessionManager, channelManager } = buildBridge();
      sessionManager.resolveBlocker = mock.fn(async () => {
        throw new Error("No pending blocker");
      });
      bridge.start();
      sessionManager.emit("session:started", {
        sessionId: "sess-1",
        projectDir: "/test/project",
        projectName: "my-project"
      });
      await tick();
      const blocker = {
        id: "blocker-1",
        method: "confirm",
        message: "Confirm?",
        event: { id: "blocker-1", method: "confirm" }
      };
      sessionManager.emit("session:blocked", {
        sessionId: "sess-1",
        projectDir: "/test/project",
        projectName: "my-project",
        blocker
      });
      await tick();
      const collectorCalls = mockFn(channelManager._channel.createMessageComponentCollector).mock.calls;
      const collector = collectorCalls[0].result;
      const mockInteraction = {
        customId: "blocker:blocker-1:confirm:true",
        user: { id: "owner-1" },
        update: mock.fn(async () => {
        }),
        reply: mock.fn(async () => {
        })
      };
      collector.emit("collect", mockInteraction);
      await tick();
      assert.equal(mockFn(mockInteraction.reply).mock.callCount(), 1);
      const replyArg = mockFn(mockInteraction.reply).mock.calls[0].arguments[0];
      assert.ok(String(replyArg.content).includes("Failed to resolve"));
    });
  });
  describe("messageCreate relay", () => {
    it("relays message to session steer when no pending blocker", async () => {
      const session = createMockSession();
      const { bridge, sessionManager, client } = buildBridge();
      sessionManager.getSession = mock.fn(() => session);
      bridge.start();
      sessionManager.emit("session:started", {
        sessionId: "sess-1",
        projectDir: "/test/project",
        projectName: "my-project"
      });
      await tick();
      const msg = {
        author: { id: "owner-1", bot: false },
        channelId: "ch-123",
        content: "check the test results",
        react: mock.fn(async () => {
        }),
        reply: mock.fn(async () => {
        })
      };
      client.emit("messageCreate", msg);
      await tick();
      assert.equal(mockFn(session.client.steer).mock.callCount(), 1);
      assert.equal(mockFn(session.client.steer).mock.calls[0].arguments[0], "check the test results");
    });
    it("resolves blocker via relay for input method", async () => {
      const blocker = {
        id: "blocker-2",
        method: "input",
        message: "Enter value",
        event: { id: "blocker-2", method: "input" }
      };
      const session = createMockSession({ pendingBlocker: blocker, status: "blocked" });
      const { bridge, sessionManager, client } = buildBridge();
      sessionManager.getSession = mock.fn(() => session);
      bridge.start();
      sessionManager.emit("session:started", {
        sessionId: "sess-1",
        projectDir: "/test/project",
        projectName: "my-project"
      });
      await tick();
      const msg = {
        author: { id: "owner-1", bot: false },
        channelId: "ch-123",
        content: "my-api-key-value",
        react: mock.fn(async () => {
        }),
        reply: mock.fn(async () => {
        })
      };
      client.emit("messageCreate", msg);
      await tick();
      assert.equal(mockFn(sessionManager.resolveBlocker).mock.callCount(), 1);
      assert.equal(mockFn(sessionManager.resolveBlocker).mock.calls[0].arguments[1], "my-api-key-value");
    });
    it("ignores bot messages", async () => {
      const session = createMockSession();
      const { bridge, sessionManager, client } = buildBridge();
      sessionManager.getSession = mock.fn(() => session);
      bridge.start();
      sessionManager.emit("session:started", {
        sessionId: "sess-1",
        projectDir: "/test/project",
        projectName: "my-project"
      });
      await tick();
      client.emit("messageCreate", {
        author: { id: "bot-1", bot: true },
        channelId: "ch-123",
        content: "automated",
        react: mock.fn(async () => {
        }),
        reply: mock.fn(async () => {
        })
      });
      await tick();
      assert.equal(mockFn(session.client.steer).mock.callCount(), 0);
    });
    it("ignores messages in non-project channels", async () => {
      const session = createMockSession();
      const { bridge, sessionManager, client } = buildBridge();
      sessionManager.getSession = mock.fn(() => session);
      bridge.start();
      client.emit("messageCreate", {
        author: { id: "owner-1", bot: false },
        channelId: "random-ch-999",
        content: "hello",
        react: mock.fn(async () => {
        }),
        reply: mock.fn(async () => {
        })
      });
      await tick();
      assert.equal(mockFn(session.client.steer).mock.callCount(), 0);
    });
    it("ignores messages from unauthorized users", async () => {
      const session = createMockSession();
      const { bridge, sessionManager, client } = buildBridge();
      sessionManager.getSession = mock.fn(() => session);
      bridge.start();
      sessionManager.emit("session:started", {
        sessionId: "sess-1",
        projectDir: "/test/project",
        projectName: "my-project"
      });
      await tick();
      client.emit("messageCreate", {
        author: { id: "stranger-99", bot: false },
        channelId: "ch-123",
        content: "hack the planet",
        react: mock.fn(async () => {
        }),
        reply: mock.fn(async () => {
        })
      });
      await tick();
      assert.equal(mockFn(session.client.steer).mock.callCount(), 0);
    });
    it("posts error when steer fails", async () => {
      const session = createMockSession();
      session.client.steer = mock.fn(async () => {
        throw new Error("session dead");
      });
      const { bridge, sessionManager, client } = buildBridge();
      sessionManager.getSession = mock.fn(() => session);
      bridge.start();
      sessionManager.emit("session:started", {
        sessionId: "sess-1",
        projectDir: "/test/project",
        projectName: "my-project"
      });
      await tick();
      const msg = {
        author: { id: "owner-1", bot: false },
        channelId: "ch-123",
        content: "try this",
        react: mock.fn(async () => {
        }),
        reply: mock.fn(async () => {
        })
      };
      client.emit("messageCreate", msg);
      await tick();
      assert.equal(mockFn(msg.reply).mock.callCount(), 1);
    });
  });
  describe("session:completed \u2192 cleanup", () => {
    it("posts completion embed and cleans up", async () => {
      const { bridge, sessionManager, logger } = buildBridge();
      bridge.start();
      sessionManager.emit("session:started", {
        sessionId: "sess-1",
        projectDir: "/test/project",
        projectName: "my-project"
      });
      await tick();
      sessionManager.emit("session:completed", {
        sessionId: "sess-1",
        projectDir: "/test/project",
        projectName: "my-project"
      });
      await tick();
      sessionManager.emit("session:event", {
        sessionId: "sess-1",
        projectDir: "/test/project",
        event: { type: "tool_execution_start", name: "read" }
      });
      await tick();
      assert.equal(mockFn(logger.error).mock.callCount(), 0);
    });
  });
  describe("session:error \u2192 cleanup", () => {
    it("posts error embed and cleans up", async () => {
      const { bridge, sessionManager, logger } = buildBridge();
      bridge.start();
      sessionManager.emit("session:started", {
        sessionId: "sess-1",
        projectDir: "/test/project",
        projectName: "my-project"
      });
      await tick();
      sessionManager.emit("session:error", {
        sessionId: "sess-1",
        projectDir: "/test/project",
        projectName: "my-project",
        error: "Process crashed"
      });
      await tick();
      const infoCalls = mockFn(logger.info).mock.calls;
      assert.ok(
        infoCalls.some((c) => String(c.arguments[0]).includes("session error"))
      );
    });
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvZGFlbW9uL3NyYy9ldmVudC1icmlkZ2UudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBldmVudC1icmlkZ2UudGVzdC50cyBcdTIwMTQgVGVzdHMgZm9yIEV2ZW50QnJpZGdlIG9yY2hlc3RyYXRvci5cbiAqXG4gKiBVc2VzIG1vY2sgU2Vzc2lvbk1hbmFnZXIgKEV2ZW50RW1pdHRlciksIG1vY2sgQ2hhbm5lbE1hbmFnZXIsXG4gKiBtb2NrIERpc2NvcmQgQ2xpZW50LCBhbmQgbW9jayBMb2dnZXIgdG8gdGVzdCBldmVudCB3aXJpbmcsXG4gKiBibG9ja2VyIGhhbmRsaW5nLCBjb252ZXJzYXRpb24gcmVsYXksIGFuZCBjbGVhbnVwLlxuICovXG5cbmltcG9ydCB7IGRlc2NyaWJlLCBpdCwgbW9jayB9IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG5pbXBvcnQgeyBFdmVudEVtaXR0ZXIgfSBmcm9tICdub2RlOmV2ZW50cyc7XG5pbXBvcnQgeyBFdmVudEJyaWRnZSB9IGZyb20gJy4vZXZlbnQtYnJpZGdlLmpzJztcbmltcG9ydCB0eXBlIHsgRXZlbnRCcmlkZ2VPcHRpb25zLCBCcmlkZ2VDbGllbnQgfSBmcm9tICcuL2V2ZW50LWJyaWRnZS5qcyc7XG5pbXBvcnQgdHlwZSB7IFBlbmRpbmdCbG9ja2VyLCBNYW5hZ2VkU2Vzc2lvbiwgRGFlbW9uQ29uZmlnLCBTZXNzaW9uU3RhdHVzIH0gZnJvbSAnLi90eXBlcy5qcyc7XG5pbXBvcnQgdHlwZSB7IFJwY0NsaWVudCB9IGZyb20gJ0Bnc2QtYnVpbGQvcnBjLWNsaWVudCc7XG5pbXBvcnQgdHlwZSB7IFJwY0V4dGVuc2lvblVJUmVxdWVzdCwgU2RrQWdlbnRFdmVudCB9IGZyb20gJ0Bnc2QtYnVpbGQvY29udHJhY3RzJztcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBNb2NrIGZhY3Rvcmllc1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmZ1bmN0aW9uIGNyZWF0ZU1vY2tMb2dnZXIoKSB7XG4gIHJldHVybiB7XG4gICAgZGVidWc6IG1vY2suZm4oKCkgPT4ge30pLFxuICAgIGluZm86IG1vY2suZm4oKCkgPT4ge30pLFxuICAgIHdhcm46IG1vY2suZm4oKCkgPT4ge30pLFxuICAgIGVycm9yOiBtb2NrLmZuKCgpID0+IHt9KSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlTW9ja0NoYW5uZWxNYW5hZ2VyKCkge1xuICBjb25zdCBzZW50TWVzc2FnZXM6IHVua25vd25bXSA9IFtdO1xuICBjb25zdCBtb2NrQ2hhbm5lbCA9IHtcbiAgICBpZDogJ2NoLTEyMycsXG4gICAgc2VuZDogbW9jay5mbihhc3luYyAoX3BheWxvYWQ6IHVua25vd24pID0+IHtcbiAgICAgIHNlbnRNZXNzYWdlcy5wdXNoKF9wYXlsb2FkKTtcbiAgICAgIHJldHVybiB7IGlkOiAnbXNnLTEnIH07XG4gICAgfSksXG4gICAgY3JlYXRlTWVzc2FnZUNvbXBvbmVudENvbGxlY3RvcjogbW9jay5mbigoX29wdHM/OiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCBjb2xsZWN0b3IgPSBuZXcgRXZlbnRFbWl0dGVyKCkgYXMgRXZlbnRFbWl0dGVyICYgeyBzdG9wOiAocmVhc29uPzogc3RyaW5nKSA9PiB2b2lkIH07XG4gICAgICBjb2xsZWN0b3Iuc3RvcCA9IChyZWFzb24/OiBzdHJpbmcpID0+IGNvbGxlY3Rvci5lbWl0KCdlbmQnLCBbXSwgcmVhc29uID8/ICdtYW51YWwnKTtcbiAgICAgIHJldHVybiBjb2xsZWN0b3I7XG4gICAgfSksXG4gIH07XG4gIHJldHVybiB7XG4gICAgY3JlYXRlUHJvamVjdENoYW5uZWw6IG1vY2suZm4oYXN5bmMgKF9kaXI6IHN0cmluZykgPT4gbW9ja0NoYW5uZWwpLFxuICAgIF9jaGFubmVsOiBtb2NrQ2hhbm5lbCxcbiAgICBfc2VudE1lc3NhZ2VzOiBzZW50TWVzc2FnZXMsXG4gIH07XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZU1vY2tDbGllbnQoKTogQnJpZGdlQ2xpZW50ICYgRXZlbnRFbWl0dGVyIHtcbiAgY29uc3QgZW1pdHRlciA9IG5ldyBFdmVudEVtaXR0ZXIoKTtcbiAgY29uc3QgZG1TZW5kRm4gPSBtb2NrLmZuKGFzeW5jICgpID0+ICh7fSkpO1xuICBjb25zdCBmZXRjaEZuID0gbW9jay5mbihhc3luYyAoX2lkOiBzdHJpbmcpID0+ICh7IHNlbmQ6IGRtU2VuZEZuIH0pKTtcbiAgKGVtaXR0ZXIgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikudXNlcnMgPSB7IGZldGNoOiBmZXRjaEZuIH07XG4gIHJldHVybiBPYmplY3QuYXNzaWduKGVtaXR0ZXIsIHtcbiAgICB1c2VyczogeyBmZXRjaDogZmV0Y2hGbiB9LFxuICAgIF9kbVNlbmQ6IGRtU2VuZEZuLFxuICB9KSBhcyB1bmtub3duIGFzIEJyaWRnZUNsaWVudCAmIEV2ZW50RW1pdHRlcjtcbn1cblxuZnVuY3Rpb24gY3JlYXRlTW9ja1Nlc3Npb25NYW5hZ2VyKCkge1xuICBjb25zdCBzbSA9IG5ldyBFdmVudEVtaXR0ZXIoKSBhcyBFdmVudEVtaXR0ZXIgJiB7XG4gICAgZ2V0U2Vzc2lvbjogUmV0dXJuVHlwZTx0eXBlb2YgbW9jay5mbj47XG4gICAgcmVzb2x2ZUJsb2NrZXI6IFJldHVyblR5cGU8dHlwZW9mIG1vY2suZm4+O1xuICB9O1xuICBzbS5nZXRTZXNzaW9uID0gbW9jay5mbigoX2lkOiBzdHJpbmcpID0+IHVuZGVmaW5lZCBhcyBNYW5hZ2VkU2Vzc2lvbiB8IHVuZGVmaW5lZCk7XG4gIHNtLnJlc29sdmVCbG9ja2VyID0gbW9jay5mbihhc3luYyAoX3NpZDogc3RyaW5nLCBfcmVzcDogc3RyaW5nKSA9PiB7fSk7XG4gIHJldHVybiBzbTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlTW9ja1Nlc3Npb24ob3ZlcnJpZGVzPzogUGFydGlhbDxNYW5hZ2VkU2Vzc2lvbj4pOiBNYW5hZ2VkU2Vzc2lvbiB7XG4gIHJldHVybiB7XG4gICAgc2Vzc2lvbklkOiAnc2Vzcy0xJyxcbiAgICBwcm9qZWN0RGlyOiAnL3Rlc3QvcHJvamVjdCcsXG4gICAgcHJvamVjdE5hbWU6ICdwcm9qZWN0JyxcbiAgICBzdGF0dXM6ICdydW5uaW5nJyBhcyBTZXNzaW9uU3RhdHVzLFxuICAgIGNsaWVudDoge1xuICAgICAgc3RlZXI6IG1vY2suZm4oYXN5bmMgKF9tc2c6IHN0cmluZykgPT4ge30pLFxuICAgICAgcHJvbXB0OiBtb2NrLmZuKGFzeW5jICgpID0+ICh7fSkpLFxuICAgIH0gYXMgdW5rbm93biBhcyBScGNDbGllbnQsXG4gICAgZXZlbnRzOiBbXSxcbiAgICBwZW5kaW5nQmxvY2tlcjogbnVsbCxcbiAgICBjb3N0OiB7IHRvdGFsQ29zdDogMCwgdG9rZW5zOiB7IGlucHV0OiAwLCBvdXRwdXQ6IDAsIGNhY2hlUmVhZDogMCwgY2FjaGVXcml0ZTogMCB9IH0sXG4gICAgc3RhcnRUaW1lOiBEYXRlLm5vdygpLFxuICAgIC4uLm92ZXJyaWRlcyxcbiAgfTtcbn1cblxuY29uc3QgREVGQVVMVF9DT05GSUc6IERhZW1vbkNvbmZpZyA9IHtcbiAgZGlzY29yZDoge1xuICAgIHRva2VuOiAndGVzdC10b2tlbicsXG4gICAgZ3VpbGRfaWQ6ICdndWlsZC0xJyxcbiAgICBvd25lcl9pZDogJ293bmVyLTEnLFxuICAgIGRtX29uX2Jsb2NrZXI6IGZhbHNlLFxuICB9LFxuICBwcm9qZWN0czogeyBzY2FuX3Jvb3RzOiBbXSB9LFxuICBsb2c6IHsgZmlsZTogJy90bXAvdGVzdC5sb2cnLCBsZXZlbDogJ2RlYnVnJywgbWF4X3NpemVfbWI6IDEwIH0sXG59O1xuXG5mdW5jdGlvbiBidWlsZEJyaWRnZShvdmVycmlkZXM/OiBQYXJ0aWFsPEV2ZW50QnJpZGdlT3B0aW9ucz4pIHtcbiAgY29uc3Qgc2Vzc2lvbk1hbmFnZXIgPSBjcmVhdGVNb2NrU2Vzc2lvbk1hbmFnZXIoKTtcbiAgY29uc3QgY2hhbm5lbE1hbmFnZXIgPSBjcmVhdGVNb2NrQ2hhbm5lbE1hbmFnZXIoKTtcbiAgY29uc3QgY2xpZW50ID0gY3JlYXRlTW9ja0NsaWVudCgpO1xuICBjb25zdCBsb2dnZXIgPSBjcmVhdGVNb2NrTG9nZ2VyKCk7XG5cbiAgY29uc3Qgb3B0czogRXZlbnRCcmlkZ2VPcHRpb25zID0ge1xuICAgIHNlc3Npb25NYW5hZ2VyOiBzZXNzaW9uTWFuYWdlciBhcyB1bmtub3duIGFzIEV2ZW50QnJpZGdlT3B0aW9uc1snc2Vzc2lvbk1hbmFnZXInXSxcbiAgICBjaGFubmVsTWFuYWdlcjogY2hhbm5lbE1hbmFnZXIgYXMgdW5rbm93biBhcyBFdmVudEJyaWRnZU9wdGlvbnNbJ2NoYW5uZWxNYW5hZ2VyJ10sXG4gICAgY2xpZW50LFxuICAgIGNvbmZpZzogREVGQVVMVF9DT05GSUcsXG4gICAgbG9nZ2VyOiBsb2dnZXIgYXMgdW5rbm93biBhcyBFdmVudEJyaWRnZU9wdGlvbnNbJ2xvZ2dlciddLFxuICAgIG93bmVySWQ6ICdvd25lci0xJyxcbiAgICAuLi5vdmVycmlkZXMsXG4gIH07XG5cbiAgY29uc3QgYnJpZGdlID0gbmV3IEV2ZW50QnJpZGdlKG9wdHMpO1xuICByZXR1cm4geyBicmlkZ2UsIHNlc3Npb25NYW5hZ2VyLCBjaGFubmVsTWFuYWdlciwgY2xpZW50LCBsb2dnZXIgfTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBIZWxwZXJzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbmNvbnN0IHRpY2sgPSAoKSA9PiBuZXcgUHJvbWlzZTx2b2lkPigocikgPT4gc2V0VGltZW91dChyLCAzMCkpO1xuXG5mdW5jdGlvbiBtb2NrRm4ob2JqOiB1bmtub3duKTogeyBtb2NrOiB7IGNhbGxDb3VudCgpOiBudW1iZXI7IGNhbGxzOiBBcnJheTx7IGFyZ3VtZW50czogdW5rbm93bltdOyByZXN1bHQ/OiB1bmtub3duIH0+IH0gfSB7XG4gIHJldHVybiBvYmogYXMgeyBtb2NrOiB7IGNhbGxDb3VudCgpOiBudW1iZXI7IGNhbGxzOiBBcnJheTx7IGFyZ3VtZW50czogdW5rbm93bltdOyByZXN1bHQ/OiB1bmtub3duIH0+IH0gfTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBUZXN0c1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmRlc2NyaWJlKCdFdmVudEJyaWRnZScsICgpID0+IHtcbiAgZGVzY3JpYmUoJ2xpZmVjeWNsZScsICgpID0+IHtcbiAgICBpdCgnc3RhcnQoKSBzdWJzY3JpYmVzIHRvIHNlc3Npb24gbWFuYWdlciBldmVudHMgYW5kIG1lc3NhZ2VDcmVhdGUnLCAoKSA9PiB7XG4gICAgICBjb25zdCB7IGJyaWRnZSwgc2Vzc2lvbk1hbmFnZXIsIGNsaWVudCB9ID0gYnVpbGRCcmlkZ2UoKTtcbiAgICAgIGJyaWRnZS5zdGFydCgpO1xuICAgICAgYXNzZXJ0Lm9rKHNlc3Npb25NYW5hZ2VyLmxpc3RlbmVyQ291bnQoJ3Nlc3Npb246c3RhcnRlZCcpID4gMCk7XG4gICAgICBhc3NlcnQub2soc2Vzc2lvbk1hbmFnZXIubGlzdGVuZXJDb3VudCgnc2Vzc2lvbjpldmVudCcpID4gMCk7XG4gICAgICBhc3NlcnQub2soc2Vzc2lvbk1hbmFnZXIubGlzdGVuZXJDb3VudCgnc2Vzc2lvbjpibG9ja2VkJykgPiAwKTtcbiAgICAgIGFzc2VydC5vayhzZXNzaW9uTWFuYWdlci5saXN0ZW5lckNvdW50KCdzZXNzaW9uOmNvbXBsZXRlZCcpID4gMCk7XG4gICAgICBhc3NlcnQub2soc2Vzc2lvbk1hbmFnZXIubGlzdGVuZXJDb3VudCgnc2Vzc2lvbjplcnJvcicpID4gMCk7XG4gICAgICBhc3NlcnQub2soY2xpZW50Lmxpc3RlbmVyQ291bnQoJ21lc3NhZ2VDcmVhdGUnKSA+IDApO1xuICAgIH0pO1xuXG4gICAgaXQoJ3N0b3AoKSB1bnN1YnNjcmliZXMgZnJvbSBhbGwgZXZlbnRzIGFuZCBjbGVhcnMgbWFwcGluZ3MnLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCB7IGJyaWRnZSwgc2Vzc2lvbk1hbmFnZXIsIGNsaWVudCB9ID0gYnVpbGRCcmlkZ2UoKTtcbiAgICAgIGJyaWRnZS5zdGFydCgpO1xuICAgICAgYXdhaXQgYnJpZGdlLnN0b3AoKTtcbiAgICAgIGFzc2VydC5lcXVhbChzZXNzaW9uTWFuYWdlci5saXN0ZW5lckNvdW50KCdzZXNzaW9uOnN0YXJ0ZWQnKSwgMCk7XG4gICAgICBhc3NlcnQuZXF1YWwoc2Vzc2lvbk1hbmFnZXIubGlzdGVuZXJDb3VudCgnc2Vzc2lvbjpldmVudCcpLCAwKTtcbiAgICAgIGFzc2VydC5lcXVhbChzZXNzaW9uTWFuYWdlci5saXN0ZW5lckNvdW50KCdzZXNzaW9uOmJsb2NrZWQnKSwgMCk7XG4gICAgICBhc3NlcnQuZXF1YWwoc2Vzc2lvbk1hbmFnZXIubGlzdGVuZXJDb3VudCgnc2Vzc2lvbjpjb21wbGV0ZWQnKSwgMCk7XG4gICAgICBhc3NlcnQuZXF1YWwoc2Vzc2lvbk1hbmFnZXIubGlzdGVuZXJDb3VudCgnc2Vzc2lvbjplcnJvcicpLCAwKTtcbiAgICAgIGFzc2VydC5lcXVhbChjbGllbnQubGlzdGVuZXJDb3VudCgnbWVzc2FnZUNyZWF0ZScpLCAwKTtcbiAgICB9KTtcblxuICAgIGl0KCdzdGFydCgpIGlzIGlkZW1wb3RlbnQnLCAoKSA9PiB7XG4gICAgICBjb25zdCB7IGJyaWRnZSwgc2Vzc2lvbk1hbmFnZXIgfSA9IGJ1aWxkQnJpZGdlKCk7XG4gICAgICBicmlkZ2Uuc3RhcnQoKTtcbiAgICAgIGJyaWRnZS5zdGFydCgpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHNlc3Npb25NYW5hZ2VyLmxpc3RlbmVyQ291bnQoJ3Nlc3Npb246c3RhcnRlZCcpLCAxKTtcbiAgICB9KTtcblxuICAgIGl0KCdnZXRWZXJib3NpdHlNYW5hZ2VyKCkgcmV0dXJucyBhIFZlcmJvc2l0eU1hbmFnZXInLCAoKSA9PiB7XG4gICAgICBjb25zdCB7IGJyaWRnZSB9ID0gYnVpbGRCcmlkZ2UoKTtcbiAgICAgIGNvbnN0IHZtID0gYnJpZGdlLmdldFZlcmJvc2l0eU1hbmFnZXIoKTtcbiAgICAgIGFzc2VydC5vayh2bSk7XG4gICAgICBhc3NlcnQuZXF1YWwodHlwZW9mIHZtLnNob3VsZFNob3csICdmdW5jdGlvbicpO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnc2Vzc2lvbjpzdGFydGVkIFx1MjE5MiBjaGFubmVsIGNyZWF0aW9uICsgd2VsY29tZSBlbWJlZCcsICgpID0+IHtcbiAgICBpdCgnY3JlYXRlcyBjaGFubmVsIGFuZCBiYXRjaGVyJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgeyBicmlkZ2UsIHNlc3Npb25NYW5hZ2VyLCBjaGFubmVsTWFuYWdlciB9ID0gYnVpbGRCcmlkZ2UoKTtcbiAgICAgIGJyaWRnZS5zdGFydCgpO1xuICAgICAgc2Vzc2lvbk1hbmFnZXIuZW1pdCgnc2Vzc2lvbjpzdGFydGVkJywge1xuICAgICAgICBzZXNzaW9uSWQ6ICdzZXNzLTEnLCBwcm9qZWN0RGlyOiAnL3Rlc3QvcHJvamVjdCcsIHByb2plY3ROYW1lOiAnbXktcHJvamVjdCcsXG4gICAgICB9KTtcbiAgICAgIGF3YWl0IHRpY2soKTtcbiAgICAgIGFzc2VydC5lcXVhbChtb2NrRm4oY2hhbm5lbE1hbmFnZXIuY3JlYXRlUHJvamVjdENoYW5uZWwpLm1vY2suY2FsbENvdW50KCksIDEpO1xuICAgIH0pO1xuXG4gICAgaXQoJ2xvZ3MgZXJyb3IgYW5kIHNraXBzIHdoZW4gY2hhbm5lbCBjcmVhdGlvbiBmYWlscycsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IGZhaWxpbmdDbSA9IHtcbiAgICAgICAgY3JlYXRlUHJvamVjdENoYW5uZWw6IG1vY2suZm4oYXN5bmMgKCkgPT4geyB0aHJvdyBuZXcgRXJyb3IoJ0FQSSBlcnJvcicpOyB9KSxcbiAgICAgIH07XG4gICAgICBjb25zdCB7IGJyaWRnZSwgc2Vzc2lvbk1hbmFnZXIsIGxvZ2dlciB9ID0gYnVpbGRCcmlkZ2Uoe1xuICAgICAgICBjaGFubmVsTWFuYWdlcjogZmFpbGluZ0NtIGFzIHVua25vd24gYXMgRXZlbnRCcmlkZ2VPcHRpb25zWydjaGFubmVsTWFuYWdlciddLFxuICAgICAgfSk7XG4gICAgICBicmlkZ2Uuc3RhcnQoKTtcbiAgICAgIHNlc3Npb25NYW5hZ2VyLmVtaXQoJ3Nlc3Npb246c3RhcnRlZCcsIHtcbiAgICAgICAgc2Vzc2lvbklkOiAnc2Vzcy0xJywgcHJvamVjdERpcjogJy90ZXN0L3Byb2plY3QnLCBwcm9qZWN0TmFtZTogJ215LXByb2plY3QnLFxuICAgICAgfSk7XG4gICAgICBhd2FpdCB0aWNrKCk7XG4gICAgICBhc3NlcnQub2sobW9ja0ZuKGxvZ2dlci5lcnJvcikubW9jay5jYWxsQ291bnQoKSA+IDApO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnc2Vzc2lvbjpldmVudCBcdTIxOTIgZm9ybWF0ICsgdmVyYm9zaXR5IGZpbHRlciArIGVucXVldWUnLCAoKSA9PiB7XG4gICAgaXQoJ2Zvcm1hdHMgZXZlbnQgYW5kIGVucXVldWVzIHRvIGJhdGNoZXIgKG5vIGVycm9ycyknLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCB7IGJyaWRnZSwgc2Vzc2lvbk1hbmFnZXIsIGxvZ2dlciB9ID0gYnVpbGRCcmlkZ2UoKTtcbiAgICAgIGJyaWRnZS5zdGFydCgpO1xuICAgICAgc2Vzc2lvbk1hbmFnZXIuZW1pdCgnc2Vzc2lvbjpzdGFydGVkJywge1xuICAgICAgICBzZXNzaW9uSWQ6ICdzZXNzLTEnLCBwcm9qZWN0RGlyOiAnL3Rlc3QvcHJvamVjdCcsIHByb2plY3ROYW1lOiAnbXktcHJvamVjdCcsXG4gICAgICB9KTtcbiAgICAgIGF3YWl0IHRpY2soKTtcblxuICAgICAgc2Vzc2lvbk1hbmFnZXIuZW1pdCgnc2Vzc2lvbjpldmVudCcsIHtcbiAgICAgICAgc2Vzc2lvbklkOiAnc2Vzcy0xJywgcHJvamVjdERpcjogJy90ZXN0L3Byb2plY3QnLFxuICAgICAgICBldmVudDogeyB0eXBlOiAndG9vbF9leGVjdXRpb25fc3RhcnQnLCBuYW1lOiAncmVhZCcgfSBhcyBTZGtBZ2VudEV2ZW50LFxuICAgICAgfSk7XG4gICAgICBhd2FpdCB0aWNrKCk7XG4gICAgICAvLyBObyBlcnJvcnNcbiAgICAgIGFzc2VydC5lcXVhbChtb2NrRm4obG9nZ2VyLmVycm9yKS5tb2NrLmNhbGxDb3VudCgpLCAwKTtcbiAgICB9KTtcblxuICAgIGl0KCdmaWx0ZXJzIGV2ZW50cyBiYXNlZCBvbiB2ZXJib3NpdHknLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCB7IGJyaWRnZSwgc2Vzc2lvbk1hbmFnZXIsIGNoYW5uZWxNYW5hZ2VyLCBsb2dnZXIgfSA9IGJ1aWxkQnJpZGdlKCk7XG4gICAgICBicmlkZ2Uuc3RhcnQoKTtcbiAgICAgIHNlc3Npb25NYW5hZ2VyLmVtaXQoJ3Nlc3Npb246c3RhcnRlZCcsIHtcbiAgICAgICAgc2Vzc2lvbklkOiAnc2Vzcy0xJywgcHJvamVjdERpcjogJy90ZXN0L3Byb2plY3QnLCBwcm9qZWN0TmFtZTogJ215LXByb2plY3QnLFxuICAgICAgfSk7XG4gICAgICBhd2FpdCB0aWNrKCk7XG5cbiAgICAgIC8vIFNldCBxdWlldCBtb2RlXG4gICAgICBicmlkZ2UuZ2V0VmVyYm9zaXR5TWFuYWdlcigpLnNldExldmVsKCdjaC0xMjMnLCAncXVpZXQnKTtcblxuICAgICAgLy8gY29zdF91cGRhdGUgZmlsdGVyZWQgaW4gcXVpZXRcbiAgICAgIHNlc3Npb25NYW5hZ2VyLmVtaXQoJ3Nlc3Npb246ZXZlbnQnLCB7XG4gICAgICAgIHNlc3Npb25JZDogJ3Nlc3MtMScsIHByb2plY3REaXI6ICcvdGVzdC9wcm9qZWN0JyxcbiAgICAgICAgZXZlbnQ6IHsgdHlwZTogJ2Nvc3RfdXBkYXRlJywgY3VtdWxhdGl2ZUNvc3Q6IDEuNSB9IGFzIFNka0FnZW50RXZlbnQsXG4gICAgICB9KTtcbiAgICAgIGF3YWl0IHRpY2soKTtcbiAgICAgIC8vIHRvb2xfZXhlY3V0aW9uX3N0YXJ0IGZpbHRlcmVkIGluIHF1aWV0XG4gICAgICBzZXNzaW9uTWFuYWdlci5lbWl0KCdzZXNzaW9uOmV2ZW50Jywge1xuICAgICAgICBzZXNzaW9uSWQ6ICdzZXNzLTEnLCBwcm9qZWN0RGlyOiAnL3Rlc3QvcHJvamVjdCcsXG4gICAgICAgIGV2ZW50OiB7IHR5cGU6ICd0b29sX2V4ZWN1dGlvbl9zdGFydCcsIG5hbWU6ICdyZWFkJyB9IGFzIFNka0FnZW50RXZlbnQsXG4gICAgICB9KTtcbiAgICAgIGF3YWl0IHRpY2soKTtcbiAgICAgIGFzc2VydC5lcXVhbChtb2NrRm4obG9nZ2VyLmVycm9yKS5tb2NrLmNhbGxDb3VudCgpLCAwKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ3Nlc3Npb246YmxvY2tlZCBcdTIxOTIgYmxvY2tlciBlbWJlZCArIGJ1dHRvbnMgKyBvcHRpb25hbCBETScsICgpID0+IHtcbiAgICBpdCgnc2VuZHMgYmxvY2tlciBlbWJlZCBhbmQgY3JlYXRlcyBjb2xsZWN0b3IgZm9yIGNvbmZpcm0nLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCB7IGJyaWRnZSwgc2Vzc2lvbk1hbmFnZXIsIGNoYW5uZWxNYW5hZ2VyIH0gPSBidWlsZEJyaWRnZSgpO1xuICAgICAgYnJpZGdlLnN0YXJ0KCk7XG4gICAgICBzZXNzaW9uTWFuYWdlci5lbWl0KCdzZXNzaW9uOnN0YXJ0ZWQnLCB7XG4gICAgICAgIHNlc3Npb25JZDogJ3Nlc3MtMScsIHByb2plY3REaXI6ICcvdGVzdC9wcm9qZWN0JywgcHJvamVjdE5hbWU6ICdteS1wcm9qZWN0JyxcbiAgICAgIH0pO1xuICAgICAgYXdhaXQgdGljaygpO1xuXG4gICAgICBjb25zdCBibG9ja2VyOiBQZW5kaW5nQmxvY2tlciA9IHtcbiAgICAgICAgaWQ6ICdibG9ja2VyLTEnLCBtZXRob2Q6ICdjb25maXJtJywgbWVzc2FnZTogJ0NvbnRpbnVlPycsXG4gICAgICAgIGV2ZW50OiB7IGlkOiAnYmxvY2tlci0xJywgbWV0aG9kOiAnY29uZmlybScsIG1lc3NhZ2U6ICdDb250aW51ZT8nIH0gYXMgUnBjRXh0ZW5zaW9uVUlSZXF1ZXN0LFxuICAgICAgfTtcbiAgICAgIHNlc3Npb25NYW5hZ2VyLmVtaXQoJ3Nlc3Npb246YmxvY2tlZCcsIHtcbiAgICAgICAgc2Vzc2lvbklkOiAnc2Vzcy0xJywgcHJvamVjdERpcjogJy90ZXN0L3Byb2plY3QnLCBwcm9qZWN0TmFtZTogJ215LXByb2plY3QnLCBibG9ja2VyLFxuICAgICAgfSk7XG4gICAgICBhd2FpdCB0aWNrKCk7XG4gICAgICBhc3NlcnQub2sobW9ja0ZuKGNoYW5uZWxNYW5hZ2VyLl9jaGFubmVsLmNyZWF0ZU1lc3NhZ2VDb21wb25lbnRDb2xsZWN0b3IpLm1vY2suY2FsbENvdW50KCkgPiAwKTtcbiAgICB9KTtcblxuICAgIGl0KCdzZW5kcyBETSB3aGVuIGRtX29uX2Jsb2NrZXIgaXMgY29uZmlndXJlZCcsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IGNvbmZpZzogRGFlbW9uQ29uZmlnID0ge1xuICAgICAgICAuLi5ERUZBVUxUX0NPTkZJRyxcbiAgICAgICAgZGlzY29yZDogeyAuLi5ERUZBVUxUX0NPTkZJRy5kaXNjb3JkISwgZG1fb25fYmxvY2tlcjogdHJ1ZSB9LFxuICAgICAgfTtcbiAgICAgIGNvbnN0IGNsaWVudCA9IGNyZWF0ZU1vY2tDbGllbnQoKTtcbiAgICAgIGNvbnN0IHsgYnJpZGdlLCBzZXNzaW9uTWFuYWdlciB9ID0gYnVpbGRCcmlkZ2UoeyBjb25maWcsIGNsaWVudCB9KTtcbiAgICAgIGJyaWRnZS5zdGFydCgpO1xuXG4gICAgICBzZXNzaW9uTWFuYWdlci5lbWl0KCdzZXNzaW9uOnN0YXJ0ZWQnLCB7XG4gICAgICAgIHNlc3Npb25JZDogJ3Nlc3MtMScsIHByb2plY3REaXI6ICcvdGVzdC9wcm9qZWN0JywgcHJvamVjdE5hbWU6ICdteS1wcm9qZWN0JyxcbiAgICAgIH0pO1xuICAgICAgYXdhaXQgdGljaygpO1xuXG4gICAgICBjb25zdCBibG9ja2VyOiBQZW5kaW5nQmxvY2tlciA9IHtcbiAgICAgICAgaWQ6ICdibG9ja2VyLTEnLCBtZXRob2Q6ICdpbnB1dCcsIG1lc3NhZ2U6ICdFbnRlciBBUEkga2V5JyxcbiAgICAgICAgZXZlbnQ6IHsgaWQ6ICdibG9ja2VyLTEnLCBtZXRob2Q6ICdpbnB1dCcgfSBhcyBScGNFeHRlbnNpb25VSVJlcXVlc3QsXG4gICAgICB9O1xuICAgICAgc2Vzc2lvbk1hbmFnZXIuZW1pdCgnc2Vzc2lvbjpibG9ja2VkJywge1xuICAgICAgICBzZXNzaW9uSWQ6ICdzZXNzLTEnLCBwcm9qZWN0RGlyOiAnL3Rlc3QvcHJvamVjdCcsIHByb2plY3ROYW1lOiAnbXktcHJvamVjdCcsIGJsb2NrZXIsXG4gICAgICB9KTtcbiAgICAgIGF3YWl0IHRpY2soKTtcblxuICAgICAgY29uc3QgdXNlcnNGZXRjaCA9IChjbGllbnQgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB7IGZldGNoOiB1bmtub3duIH0+KS51c2Vycy5mZXRjaDtcbiAgICAgIGFzc2VydC5lcXVhbChtb2NrRm4odXNlcnNGZXRjaCkubW9jay5jYWxsQ291bnQoKSwgMSk7XG4gICAgfSk7XG5cbiAgICBpdCgnZG9lcyBub3Qgc2VuZCBETSB3aGVuIGRtX29uX2Jsb2NrZXIgaXMgZmFsc2UnLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBjbGllbnQgPSBjcmVhdGVNb2NrQ2xpZW50KCk7XG4gICAgICBjb25zdCB7IGJyaWRnZSwgc2Vzc2lvbk1hbmFnZXIgfSA9IGJ1aWxkQnJpZGdlKHsgY2xpZW50IH0pO1xuICAgICAgYnJpZGdlLnN0YXJ0KCk7XG5cbiAgICAgIHNlc3Npb25NYW5hZ2VyLmVtaXQoJ3Nlc3Npb246c3RhcnRlZCcsIHtcbiAgICAgICAgc2Vzc2lvbklkOiAnc2Vzcy0xJywgcHJvamVjdERpcjogJy90ZXN0L3Byb2plY3QnLCBwcm9qZWN0TmFtZTogJ215LXByb2plY3QnLFxuICAgICAgfSk7XG4gICAgICBhd2FpdCB0aWNrKCk7XG5cbiAgICAgIGNvbnN0IGJsb2NrZXI6IFBlbmRpbmdCbG9ja2VyID0ge1xuICAgICAgICBpZDogJ2Jsb2NrZXItMScsIG1ldGhvZDogJ2lucHV0JywgbWVzc2FnZTogJ0VudGVyIHZhbHVlJyxcbiAgICAgICAgZXZlbnQ6IHsgaWQ6ICdibG9ja2VyLTEnLCBtZXRob2Q6ICdpbnB1dCcgfSBhcyBScGNFeHRlbnNpb25VSVJlcXVlc3QsXG4gICAgICB9O1xuICAgICAgc2Vzc2lvbk1hbmFnZXIuZW1pdCgnc2Vzc2lvbjpibG9ja2VkJywge1xuICAgICAgICBzZXNzaW9uSWQ6ICdzZXNzLTEnLCBwcm9qZWN0RGlyOiAnL3Rlc3QvcHJvamVjdCcsIHByb2plY3ROYW1lOiAnbXktcHJvamVjdCcsIGJsb2NrZXIsXG4gICAgICB9KTtcbiAgICAgIGF3YWl0IHRpY2soKTtcblxuICAgICAgY29uc3QgdXNlcnNGZXRjaCA9IChjbGllbnQgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB7IGZldGNoOiB1bmtub3duIH0+KS51c2Vycy5mZXRjaDtcbiAgICAgIGFzc2VydC5lcXVhbChtb2NrRm4odXNlcnNGZXRjaCkubW9jay5jYWxsQ291bnQoKSwgMCk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKCdidXR0b24gY29sbGVjdG9yIFx1MjE5MiByZXNvbHZlQmxvY2tlcicsICgpID0+IHtcbiAgICBpdCgncmVzb2x2ZXMgYmxvY2tlciBvbiBidXR0b24gY2xpY2sgZnJvbSBhdXRob3JpemVkIHVzZXInLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCB7IGJyaWRnZSwgc2Vzc2lvbk1hbmFnZXIsIGNoYW5uZWxNYW5hZ2VyIH0gPSBidWlsZEJyaWRnZSgpO1xuICAgICAgYnJpZGdlLnN0YXJ0KCk7XG5cbiAgICAgIHNlc3Npb25NYW5hZ2VyLmVtaXQoJ3Nlc3Npb246c3RhcnRlZCcsIHtcbiAgICAgICAgc2Vzc2lvbklkOiAnc2Vzcy0xJywgcHJvamVjdERpcjogJy90ZXN0L3Byb2plY3QnLCBwcm9qZWN0TmFtZTogJ215LXByb2plY3QnLFxuICAgICAgfSk7XG4gICAgICBhd2FpdCB0aWNrKCk7XG5cbiAgICAgIGNvbnN0IGJsb2NrZXI6IFBlbmRpbmdCbG9ja2VyID0ge1xuICAgICAgICBpZDogJ2Jsb2NrZXItMScsIG1ldGhvZDogJ2NvbmZpcm0nLCBtZXNzYWdlOiAnQ29uZmlybT8nLFxuICAgICAgICBldmVudDogeyBpZDogJ2Jsb2NrZXItMScsIG1ldGhvZDogJ2NvbmZpcm0nIH0gYXMgUnBjRXh0ZW5zaW9uVUlSZXF1ZXN0LFxuICAgICAgfTtcbiAgICAgIHNlc3Npb25NYW5hZ2VyLmVtaXQoJ3Nlc3Npb246YmxvY2tlZCcsIHtcbiAgICAgICAgc2Vzc2lvbklkOiAnc2Vzcy0xJywgcHJvamVjdERpcjogJy90ZXN0L3Byb2plY3QnLCBwcm9qZWN0TmFtZTogJ215LXByb2plY3QnLCBibG9ja2VyLFxuICAgICAgfSk7XG4gICAgICBhd2FpdCB0aWNrKCk7XG5cbiAgICAgIGNvbnN0IGNvbGxlY3RvckNhbGxzID0gbW9ja0ZuKGNoYW5uZWxNYW5hZ2VyLl9jaGFubmVsLmNyZWF0ZU1lc3NhZ2VDb21wb25lbnRDb2xsZWN0b3IpLm1vY2suY2FsbHM7XG4gICAgICBhc3NlcnQub2soY29sbGVjdG9yQ2FsbHMubGVuZ3RoID4gMCk7XG4gICAgICBjb25zdCBjb2xsZWN0b3IgPSBjb2xsZWN0b3JDYWxsc1swXSEucmVzdWx0IGFzIEV2ZW50RW1pdHRlcjtcblxuICAgICAgY29uc3QgbW9ja0ludGVyYWN0aW9uID0ge1xuICAgICAgICBjdXN0b21JZDogJ2Jsb2NrZXI6YmxvY2tlci0xOmNvbmZpcm06dHJ1ZScsXG4gICAgICAgIHVzZXI6IHsgaWQ6ICdvd25lci0xJyB9LFxuICAgICAgICB1cGRhdGU6IG1vY2suZm4oYXN5bmMgKCkgPT4ge30pLFxuICAgICAgICByZXBseTogbW9jay5mbihhc3luYyAoKSA9PiB7fSksXG4gICAgICB9O1xuICAgICAgY29sbGVjdG9yLmVtaXQoJ2NvbGxlY3QnLCBtb2NrSW50ZXJhY3Rpb24pO1xuICAgICAgYXdhaXQgdGljaygpO1xuXG4gICAgICBhc3NlcnQuZXF1YWwobW9ja0ZuKHNlc3Npb25NYW5hZ2VyLnJlc29sdmVCbG9ja2VyKS5tb2NrLmNhbGxDb3VudCgpLCAxKTtcbiAgICAgIGNvbnN0IGFyZ3MgPSBtb2NrRm4oc2Vzc2lvbk1hbmFnZXIucmVzb2x2ZUJsb2NrZXIpLm1vY2suY2FsbHNbMF0hLmFyZ3VtZW50cztcbiAgICAgIGFzc2VydC5lcXVhbChhcmdzWzBdLCAnc2Vzcy0xJyk7XG4gICAgICBhc3NlcnQuZXF1YWwoYXJnc1sxXSwgJ3RydWUnKTtcbiAgICB9KTtcblxuICAgIGl0KCdyZWplY3RzIGJ1dHRvbiBjbGljayBmcm9tIHVuYXV0aG9yaXplZCB1c2VyJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgeyBicmlkZ2UsIHNlc3Npb25NYW5hZ2VyLCBjaGFubmVsTWFuYWdlciB9ID0gYnVpbGRCcmlkZ2UoKTtcbiAgICAgIGJyaWRnZS5zdGFydCgpO1xuXG4gICAgICBzZXNzaW9uTWFuYWdlci5lbWl0KCdzZXNzaW9uOnN0YXJ0ZWQnLCB7XG4gICAgICAgIHNlc3Npb25JZDogJ3Nlc3MtMScsIHByb2plY3REaXI6ICcvdGVzdC9wcm9qZWN0JywgcHJvamVjdE5hbWU6ICdteS1wcm9qZWN0JyxcbiAgICAgIH0pO1xuICAgICAgYXdhaXQgdGljaygpO1xuXG4gICAgICBjb25zdCBibG9ja2VyOiBQZW5kaW5nQmxvY2tlciA9IHtcbiAgICAgICAgaWQ6ICdibG9ja2VyLTEnLCBtZXRob2Q6ICdjb25maXJtJywgbWVzc2FnZTogJ0NvbmZpcm0/JyxcbiAgICAgICAgZXZlbnQ6IHsgaWQ6ICdibG9ja2VyLTEnLCBtZXRob2Q6ICdjb25maXJtJyB9IGFzIFJwY0V4dGVuc2lvblVJUmVxdWVzdCxcbiAgICAgIH07XG4gICAgICBzZXNzaW9uTWFuYWdlci5lbWl0KCdzZXNzaW9uOmJsb2NrZWQnLCB7XG4gICAgICAgIHNlc3Npb25JZDogJ3Nlc3MtMScsIHByb2plY3REaXI6ICcvdGVzdC9wcm9qZWN0JywgcHJvamVjdE5hbWU6ICdteS1wcm9qZWN0JywgYmxvY2tlcixcbiAgICAgIH0pO1xuICAgICAgYXdhaXQgdGljaygpO1xuXG4gICAgICBjb25zdCBjb2xsZWN0b3JDYWxscyA9IG1vY2tGbihjaGFubmVsTWFuYWdlci5fY2hhbm5lbC5jcmVhdGVNZXNzYWdlQ29tcG9uZW50Q29sbGVjdG9yKS5tb2NrLmNhbGxzO1xuICAgICAgY29uc3QgY29sbGVjdG9yID0gY29sbGVjdG9yQ2FsbHNbMF0hLnJlc3VsdCBhcyBFdmVudEVtaXR0ZXI7XG5cbiAgICAgIGNvbnN0IG1vY2tJbnRlcmFjdGlvbiA9IHtcbiAgICAgICAgY3VzdG9tSWQ6ICdibG9ja2VyOmJsb2NrZXItMTpjb25maXJtOnRydWUnLFxuICAgICAgICB1c2VyOiB7IGlkOiAnc3RyYW5nZXItOTknIH0sXG4gICAgICAgIHVwZGF0ZTogbW9jay5mbihhc3luYyAoKSA9PiB7fSksXG4gICAgICAgIHJlcGx5OiBtb2NrLmZuKGFzeW5jICgpID0+IHt9KSxcbiAgICAgIH07XG4gICAgICBjb2xsZWN0b3IuZW1pdCgnY29sbGVjdCcsIG1vY2tJbnRlcmFjdGlvbik7XG4gICAgICBhd2FpdCB0aWNrKCk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChtb2NrRm4oc2Vzc2lvbk1hbmFnZXIucmVzb2x2ZUJsb2NrZXIpLm1vY2suY2FsbENvdW50KCksIDApO1xuICAgICAgYXNzZXJ0LmVxdWFsKG1vY2tGbihtb2NrSW50ZXJhY3Rpb24ucmVwbHkpLm1vY2suY2FsbENvdW50KCksIDEpO1xuICAgIH0pO1xuXG4gICAgaXQoJ3Bvc3RzIGVycm9yIHdoZW4gcmVzb2x2ZUJsb2NrZXIgdGhyb3dzJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgeyBicmlkZ2UsIHNlc3Npb25NYW5hZ2VyLCBjaGFubmVsTWFuYWdlciB9ID0gYnVpbGRCcmlkZ2UoKTtcbiAgICAgIHNlc3Npb25NYW5hZ2VyLnJlc29sdmVCbG9ja2VyID0gbW9jay5mbihhc3luYyAoKSA9PiB7IHRocm93IG5ldyBFcnJvcignTm8gcGVuZGluZyBibG9ja2VyJyk7IH0pO1xuICAgICAgYnJpZGdlLnN0YXJ0KCk7XG5cbiAgICAgIHNlc3Npb25NYW5hZ2VyLmVtaXQoJ3Nlc3Npb246c3RhcnRlZCcsIHtcbiAgICAgICAgc2Vzc2lvbklkOiAnc2Vzcy0xJywgcHJvamVjdERpcjogJy90ZXN0L3Byb2plY3QnLCBwcm9qZWN0TmFtZTogJ215LXByb2plY3QnLFxuICAgICAgfSk7XG4gICAgICBhd2FpdCB0aWNrKCk7XG5cbiAgICAgIGNvbnN0IGJsb2NrZXI6IFBlbmRpbmdCbG9ja2VyID0ge1xuICAgICAgICBpZDogJ2Jsb2NrZXItMScsIG1ldGhvZDogJ2NvbmZpcm0nLCBtZXNzYWdlOiAnQ29uZmlybT8nLFxuICAgICAgICBldmVudDogeyBpZDogJ2Jsb2NrZXItMScsIG1ldGhvZDogJ2NvbmZpcm0nIH0gYXMgUnBjRXh0ZW5zaW9uVUlSZXF1ZXN0LFxuICAgICAgfTtcbiAgICAgIHNlc3Npb25NYW5hZ2VyLmVtaXQoJ3Nlc3Npb246YmxvY2tlZCcsIHtcbiAgICAgICAgc2Vzc2lvbklkOiAnc2Vzcy0xJywgcHJvamVjdERpcjogJy90ZXN0L3Byb2plY3QnLCBwcm9qZWN0TmFtZTogJ215LXByb2plY3QnLCBibG9ja2VyLFxuICAgICAgfSk7XG4gICAgICBhd2FpdCB0aWNrKCk7XG5cbiAgICAgIGNvbnN0IGNvbGxlY3RvckNhbGxzID0gbW9ja0ZuKGNoYW5uZWxNYW5hZ2VyLl9jaGFubmVsLmNyZWF0ZU1lc3NhZ2VDb21wb25lbnRDb2xsZWN0b3IpLm1vY2suY2FsbHM7XG4gICAgICBjb25zdCBjb2xsZWN0b3IgPSBjb2xsZWN0b3JDYWxsc1swXSEucmVzdWx0IGFzIEV2ZW50RW1pdHRlcjtcblxuICAgICAgY29uc3QgbW9ja0ludGVyYWN0aW9uID0ge1xuICAgICAgICBjdXN0b21JZDogJ2Jsb2NrZXI6YmxvY2tlci0xOmNvbmZpcm06dHJ1ZScsXG4gICAgICAgIHVzZXI6IHsgaWQ6ICdvd25lci0xJyB9LFxuICAgICAgICB1cGRhdGU6IG1vY2suZm4oYXN5bmMgKCkgPT4ge30pLFxuICAgICAgICByZXBseTogbW9jay5mbihhc3luYyAoKSA9PiB7fSksXG4gICAgICB9O1xuICAgICAgY29sbGVjdG9yLmVtaXQoJ2NvbGxlY3QnLCBtb2NrSW50ZXJhY3Rpb24pO1xuICAgICAgYXdhaXQgdGljaygpO1xuXG4gICAgICBhc3NlcnQuZXF1YWwobW9ja0ZuKG1vY2tJbnRlcmFjdGlvbi5yZXBseSkubW9jay5jYWxsQ291bnQoKSwgMSk7XG4gICAgICBjb25zdCByZXBseUFyZyA9IG1vY2tGbihtb2NrSW50ZXJhY3Rpb24ucmVwbHkpLm1vY2suY2FsbHNbMF0hLmFyZ3VtZW50c1swXSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgIGFzc2VydC5vayhTdHJpbmcocmVwbHlBcmcuY29udGVudCkuaW5jbHVkZXMoJ0ZhaWxlZCB0byByZXNvbHZlJykpO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnbWVzc2FnZUNyZWF0ZSByZWxheScsICgpID0+IHtcbiAgICBpdCgncmVsYXlzIG1lc3NhZ2UgdG8gc2Vzc2lvbiBzdGVlciB3aGVuIG5vIHBlbmRpbmcgYmxvY2tlcicsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHNlc3Npb24gPSBjcmVhdGVNb2NrU2Vzc2lvbigpO1xuICAgICAgY29uc3QgeyBicmlkZ2UsIHNlc3Npb25NYW5hZ2VyLCBjbGllbnQgfSA9IGJ1aWxkQnJpZGdlKCk7XG4gICAgICBzZXNzaW9uTWFuYWdlci5nZXRTZXNzaW9uID0gbW9jay5mbigoKSA9PiBzZXNzaW9uKTtcbiAgICAgIGJyaWRnZS5zdGFydCgpO1xuXG4gICAgICBzZXNzaW9uTWFuYWdlci5lbWl0KCdzZXNzaW9uOnN0YXJ0ZWQnLCB7XG4gICAgICAgIHNlc3Npb25JZDogJ3Nlc3MtMScsIHByb2plY3REaXI6ICcvdGVzdC9wcm9qZWN0JywgcHJvamVjdE5hbWU6ICdteS1wcm9qZWN0JyxcbiAgICAgIH0pO1xuICAgICAgYXdhaXQgdGljaygpO1xuXG4gICAgICBjb25zdCBtc2cgPSB7XG4gICAgICAgIGF1dGhvcjogeyBpZDogJ293bmVyLTEnLCBib3Q6IGZhbHNlIH0sXG4gICAgICAgIGNoYW5uZWxJZDogJ2NoLTEyMycsXG4gICAgICAgIGNvbnRlbnQ6ICdjaGVjayB0aGUgdGVzdCByZXN1bHRzJyxcbiAgICAgICAgcmVhY3Q6IG1vY2suZm4oYXN5bmMgKCkgPT4ge30pLFxuICAgICAgICByZXBseTogbW9jay5mbihhc3luYyAoKSA9PiB7fSksXG4gICAgICB9O1xuICAgICAgY2xpZW50LmVtaXQoJ21lc3NhZ2VDcmVhdGUnLCBtc2cpO1xuICAgICAgYXdhaXQgdGljaygpO1xuXG4gICAgICBhc3NlcnQuZXF1YWwobW9ja0ZuKHNlc3Npb24uY2xpZW50LnN0ZWVyKS5tb2NrLmNhbGxDb3VudCgpLCAxKTtcbiAgICAgIGFzc2VydC5lcXVhbChtb2NrRm4oc2Vzc2lvbi5jbGllbnQuc3RlZXIpLm1vY2suY2FsbHNbMF0hLmFyZ3VtZW50c1swXSwgJ2NoZWNrIHRoZSB0ZXN0IHJlc3VsdHMnKTtcbiAgICB9KTtcblxuICAgIGl0KCdyZXNvbHZlcyBibG9ja2VyIHZpYSByZWxheSBmb3IgaW5wdXQgbWV0aG9kJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgYmxvY2tlcjogUGVuZGluZ0Jsb2NrZXIgPSB7XG4gICAgICAgIGlkOiAnYmxvY2tlci0yJywgbWV0aG9kOiAnaW5wdXQnLCBtZXNzYWdlOiAnRW50ZXIgdmFsdWUnLFxuICAgICAgICBldmVudDogeyBpZDogJ2Jsb2NrZXItMicsIG1ldGhvZDogJ2lucHV0JyB9IGFzIFJwY0V4dGVuc2lvblVJUmVxdWVzdCxcbiAgICAgIH07XG4gICAgICBjb25zdCBzZXNzaW9uID0gY3JlYXRlTW9ja1Nlc3Npb24oeyBwZW5kaW5nQmxvY2tlcjogYmxvY2tlciwgc3RhdHVzOiAnYmxvY2tlZCcgfSk7XG4gICAgICBjb25zdCB7IGJyaWRnZSwgc2Vzc2lvbk1hbmFnZXIsIGNsaWVudCB9ID0gYnVpbGRCcmlkZ2UoKTtcbiAgICAgIHNlc3Npb25NYW5hZ2VyLmdldFNlc3Npb24gPSBtb2NrLmZuKCgpID0+IHNlc3Npb24pO1xuICAgICAgYnJpZGdlLnN0YXJ0KCk7XG5cbiAgICAgIHNlc3Npb25NYW5hZ2VyLmVtaXQoJ3Nlc3Npb246c3RhcnRlZCcsIHtcbiAgICAgICAgc2Vzc2lvbklkOiAnc2Vzcy0xJywgcHJvamVjdERpcjogJy90ZXN0L3Byb2plY3QnLCBwcm9qZWN0TmFtZTogJ215LXByb2plY3QnLFxuICAgICAgfSk7XG4gICAgICBhd2FpdCB0aWNrKCk7XG5cbiAgICAgIGNvbnN0IG1zZyA9IHtcbiAgICAgICAgYXV0aG9yOiB7IGlkOiAnb3duZXItMScsIGJvdDogZmFsc2UgfSxcbiAgICAgICAgY2hhbm5lbElkOiAnY2gtMTIzJyxcbiAgICAgICAgY29udGVudDogJ215LWFwaS1rZXktdmFsdWUnLFxuICAgICAgICByZWFjdDogbW9jay5mbihhc3luYyAoKSA9PiB7fSksXG4gICAgICAgIHJlcGx5OiBtb2NrLmZuKGFzeW5jICgpID0+IHt9KSxcbiAgICAgIH07XG4gICAgICBjbGllbnQuZW1pdCgnbWVzc2FnZUNyZWF0ZScsIG1zZyk7XG4gICAgICBhd2FpdCB0aWNrKCk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChtb2NrRm4oc2Vzc2lvbk1hbmFnZXIucmVzb2x2ZUJsb2NrZXIpLm1vY2suY2FsbENvdW50KCksIDEpO1xuICAgICAgYXNzZXJ0LmVxdWFsKG1vY2tGbihzZXNzaW9uTWFuYWdlci5yZXNvbHZlQmxvY2tlcikubW9jay5jYWxsc1swXSEuYXJndW1lbnRzWzFdLCAnbXktYXBpLWtleS12YWx1ZScpO1xuICAgIH0pO1xuXG4gICAgaXQoJ2lnbm9yZXMgYm90IG1lc3NhZ2VzJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3Qgc2Vzc2lvbiA9IGNyZWF0ZU1vY2tTZXNzaW9uKCk7XG4gICAgICBjb25zdCB7IGJyaWRnZSwgc2Vzc2lvbk1hbmFnZXIsIGNsaWVudCB9ID0gYnVpbGRCcmlkZ2UoKTtcbiAgICAgIHNlc3Npb25NYW5hZ2VyLmdldFNlc3Npb24gPSBtb2NrLmZuKCgpID0+IHNlc3Npb24pO1xuICAgICAgYnJpZGdlLnN0YXJ0KCk7XG5cbiAgICAgIHNlc3Npb25NYW5hZ2VyLmVtaXQoJ3Nlc3Npb246c3RhcnRlZCcsIHtcbiAgICAgICAgc2Vzc2lvbklkOiAnc2Vzcy0xJywgcHJvamVjdERpcjogJy90ZXN0L3Byb2plY3QnLCBwcm9qZWN0TmFtZTogJ215LXByb2plY3QnLFxuICAgICAgfSk7XG4gICAgICBhd2FpdCB0aWNrKCk7XG5cbiAgICAgIGNsaWVudC5lbWl0KCdtZXNzYWdlQ3JlYXRlJywge1xuICAgICAgICBhdXRob3I6IHsgaWQ6ICdib3QtMScsIGJvdDogdHJ1ZSB9LFxuICAgICAgICBjaGFubmVsSWQ6ICdjaC0xMjMnLFxuICAgICAgICBjb250ZW50OiAnYXV0b21hdGVkJyxcbiAgICAgICAgcmVhY3Q6IG1vY2suZm4oYXN5bmMgKCkgPT4ge30pLFxuICAgICAgICByZXBseTogbW9jay5mbihhc3luYyAoKSA9PiB7fSksXG4gICAgICB9KTtcbiAgICAgIGF3YWl0IHRpY2soKTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKG1vY2tGbihzZXNzaW9uLmNsaWVudC5zdGVlcikubW9jay5jYWxsQ291bnQoKSwgMCk7XG4gICAgfSk7XG5cbiAgICBpdCgnaWdub3JlcyBtZXNzYWdlcyBpbiBub24tcHJvamVjdCBjaGFubmVscycsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHNlc3Npb24gPSBjcmVhdGVNb2NrU2Vzc2lvbigpO1xuICAgICAgY29uc3QgeyBicmlkZ2UsIHNlc3Npb25NYW5hZ2VyLCBjbGllbnQgfSA9IGJ1aWxkQnJpZGdlKCk7XG4gICAgICBzZXNzaW9uTWFuYWdlci5nZXRTZXNzaW9uID0gbW9jay5mbigoKSA9PiBzZXNzaW9uKTtcbiAgICAgIGJyaWRnZS5zdGFydCgpO1xuXG4gICAgICBjbGllbnQuZW1pdCgnbWVzc2FnZUNyZWF0ZScsIHtcbiAgICAgICAgYXV0aG9yOiB7IGlkOiAnb3duZXItMScsIGJvdDogZmFsc2UgfSxcbiAgICAgICAgY2hhbm5lbElkOiAncmFuZG9tLWNoLTk5OScsXG4gICAgICAgIGNvbnRlbnQ6ICdoZWxsbycsXG4gICAgICAgIHJlYWN0OiBtb2NrLmZuKGFzeW5jICgpID0+IHt9KSxcbiAgICAgICAgcmVwbHk6IG1vY2suZm4oYXN5bmMgKCkgPT4ge30pLFxuICAgICAgfSk7XG4gICAgICBhd2FpdCB0aWNrKCk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChtb2NrRm4oc2Vzc2lvbi5jbGllbnQuc3RlZXIpLm1vY2suY2FsbENvdW50KCksIDApO1xuICAgIH0pO1xuXG4gICAgaXQoJ2lnbm9yZXMgbWVzc2FnZXMgZnJvbSB1bmF1dGhvcml6ZWQgdXNlcnMnLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBzZXNzaW9uID0gY3JlYXRlTW9ja1Nlc3Npb24oKTtcbiAgICAgIGNvbnN0IHsgYnJpZGdlLCBzZXNzaW9uTWFuYWdlciwgY2xpZW50IH0gPSBidWlsZEJyaWRnZSgpO1xuICAgICAgc2Vzc2lvbk1hbmFnZXIuZ2V0U2Vzc2lvbiA9IG1vY2suZm4oKCkgPT4gc2Vzc2lvbik7XG4gICAgICBicmlkZ2Uuc3RhcnQoKTtcblxuICAgICAgc2Vzc2lvbk1hbmFnZXIuZW1pdCgnc2Vzc2lvbjpzdGFydGVkJywge1xuICAgICAgICBzZXNzaW9uSWQ6ICdzZXNzLTEnLCBwcm9qZWN0RGlyOiAnL3Rlc3QvcHJvamVjdCcsIHByb2plY3ROYW1lOiAnbXktcHJvamVjdCcsXG4gICAgICB9KTtcbiAgICAgIGF3YWl0IHRpY2soKTtcblxuICAgICAgY2xpZW50LmVtaXQoJ21lc3NhZ2VDcmVhdGUnLCB7XG4gICAgICAgIGF1dGhvcjogeyBpZDogJ3N0cmFuZ2VyLTk5JywgYm90OiBmYWxzZSB9LFxuICAgICAgICBjaGFubmVsSWQ6ICdjaC0xMjMnLFxuICAgICAgICBjb250ZW50OiAnaGFjayB0aGUgcGxhbmV0JyxcbiAgICAgICAgcmVhY3Q6IG1vY2suZm4oYXN5bmMgKCkgPT4ge30pLFxuICAgICAgICByZXBseTogbW9jay5mbihhc3luYyAoKSA9PiB7fSksXG4gICAgICB9KTtcbiAgICAgIGF3YWl0IHRpY2soKTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKG1vY2tGbihzZXNzaW9uLmNsaWVudC5zdGVlcikubW9jay5jYWxsQ291bnQoKSwgMCk7XG4gICAgfSk7XG5cbiAgICBpdCgncG9zdHMgZXJyb3Igd2hlbiBzdGVlciBmYWlscycsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHNlc3Npb24gPSBjcmVhdGVNb2NrU2Vzc2lvbigpO1xuICAgICAgKHNlc3Npb24uY2xpZW50IGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pLnN0ZWVyID0gbW9jay5mbihhc3luYyAoKSA9PiB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignc2Vzc2lvbiBkZWFkJyk7XG4gICAgICB9KTtcbiAgICAgIGNvbnN0IHsgYnJpZGdlLCBzZXNzaW9uTWFuYWdlciwgY2xpZW50IH0gPSBidWlsZEJyaWRnZSgpO1xuICAgICAgc2Vzc2lvbk1hbmFnZXIuZ2V0U2Vzc2lvbiA9IG1vY2suZm4oKCkgPT4gc2Vzc2lvbik7XG4gICAgICBicmlkZ2Uuc3RhcnQoKTtcblxuICAgICAgc2Vzc2lvbk1hbmFnZXIuZW1pdCgnc2Vzc2lvbjpzdGFydGVkJywge1xuICAgICAgICBzZXNzaW9uSWQ6ICdzZXNzLTEnLCBwcm9qZWN0RGlyOiAnL3Rlc3QvcHJvamVjdCcsIHByb2plY3ROYW1lOiAnbXktcHJvamVjdCcsXG4gICAgICB9KTtcbiAgICAgIGF3YWl0IHRpY2soKTtcblxuICAgICAgY29uc3QgbXNnID0ge1xuICAgICAgICBhdXRob3I6IHsgaWQ6ICdvd25lci0xJywgYm90OiBmYWxzZSB9LFxuICAgICAgICBjaGFubmVsSWQ6ICdjaC0xMjMnLFxuICAgICAgICBjb250ZW50OiAndHJ5IHRoaXMnLFxuICAgICAgICByZWFjdDogbW9jay5mbihhc3luYyAoKSA9PiB7fSksXG4gICAgICAgIHJlcGx5OiBtb2NrLmZuKGFzeW5jICgpID0+IHt9KSxcbiAgICAgIH07XG4gICAgICBjbGllbnQuZW1pdCgnbWVzc2FnZUNyZWF0ZScsIG1zZyk7XG4gICAgICBhd2FpdCB0aWNrKCk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChtb2NrRm4obXNnLnJlcGx5KS5tb2NrLmNhbGxDb3VudCgpLCAxKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ3Nlc3Npb246Y29tcGxldGVkIFx1MjE5MiBjbGVhbnVwJywgKCkgPT4ge1xuICAgIGl0KCdwb3N0cyBjb21wbGV0aW9uIGVtYmVkIGFuZCBjbGVhbnMgdXAnLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCB7IGJyaWRnZSwgc2Vzc2lvbk1hbmFnZXIsIGxvZ2dlciB9ID0gYnVpbGRCcmlkZ2UoKTtcbiAgICAgIGJyaWRnZS5zdGFydCgpO1xuXG4gICAgICBzZXNzaW9uTWFuYWdlci5lbWl0KCdzZXNzaW9uOnN0YXJ0ZWQnLCB7XG4gICAgICAgIHNlc3Npb25JZDogJ3Nlc3MtMScsIHByb2plY3REaXI6ICcvdGVzdC9wcm9qZWN0JywgcHJvamVjdE5hbWU6ICdteS1wcm9qZWN0JyxcbiAgICAgIH0pO1xuICAgICAgYXdhaXQgdGljaygpO1xuXG4gICAgICBzZXNzaW9uTWFuYWdlci5lbWl0KCdzZXNzaW9uOmNvbXBsZXRlZCcsIHtcbiAgICAgICAgc2Vzc2lvbklkOiAnc2Vzcy0xJywgcHJvamVjdERpcjogJy90ZXN0L3Byb2plY3QnLCBwcm9qZWN0TmFtZTogJ215LXByb2plY3QnLFxuICAgICAgfSk7XG4gICAgICBhd2FpdCB0aWNrKCk7XG5cbiAgICAgIC8vIEFmdGVyIGNsZWFudXAsIGV2ZW50cyBmb3IgdGhpcyBzZXNzaW9uIGFyZSBzaWxlbnRseSBpZ25vcmVkXG4gICAgICBzZXNzaW9uTWFuYWdlci5lbWl0KCdzZXNzaW9uOmV2ZW50Jywge1xuICAgICAgICBzZXNzaW9uSWQ6ICdzZXNzLTEnLCBwcm9qZWN0RGlyOiAnL3Rlc3QvcHJvamVjdCcsXG4gICAgICAgIGV2ZW50OiB7IHR5cGU6ICd0b29sX2V4ZWN1dGlvbl9zdGFydCcsIG5hbWU6ICdyZWFkJyB9IGFzIFNka0FnZW50RXZlbnQsXG4gICAgICB9KTtcbiAgICAgIGF3YWl0IHRpY2soKTtcbiAgICAgIGFzc2VydC5lcXVhbChtb2NrRm4obG9nZ2VyLmVycm9yKS5tb2NrLmNhbGxDb3VudCgpLCAwKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ3Nlc3Npb246ZXJyb3IgXHUyMTkyIGNsZWFudXAnLCAoKSA9PiB7XG4gICAgaXQoJ3Bvc3RzIGVycm9yIGVtYmVkIGFuZCBjbGVhbnMgdXAnLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCB7IGJyaWRnZSwgc2Vzc2lvbk1hbmFnZXIsIGxvZ2dlciB9ID0gYnVpbGRCcmlkZ2UoKTtcbiAgICAgIGJyaWRnZS5zdGFydCgpO1xuXG4gICAgICBzZXNzaW9uTWFuYWdlci5lbWl0KCdzZXNzaW9uOnN0YXJ0ZWQnLCB7XG4gICAgICAgIHNlc3Npb25JZDogJ3Nlc3MtMScsIHByb2plY3REaXI6ICcvdGVzdC9wcm9qZWN0JywgcHJvamVjdE5hbWU6ICdteS1wcm9qZWN0JyxcbiAgICAgIH0pO1xuICAgICAgYXdhaXQgdGljaygpO1xuXG4gICAgICBzZXNzaW9uTWFuYWdlci5lbWl0KCdzZXNzaW9uOmVycm9yJywge1xuICAgICAgICBzZXNzaW9uSWQ6ICdzZXNzLTEnLCBwcm9qZWN0RGlyOiAnL3Rlc3QvcHJvamVjdCcsIHByb2plY3ROYW1lOiAnbXktcHJvamVjdCcsIGVycm9yOiAnUHJvY2VzcyBjcmFzaGVkJyxcbiAgICAgIH0pO1xuICAgICAgYXdhaXQgdGljaygpO1xuXG4gICAgICBjb25zdCBpbmZvQ2FsbHMgPSBtb2NrRm4obG9nZ2VyLmluZm8pLm1vY2suY2FsbHM7XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgIGluZm9DYWxscy5zb21lKChjKSA9PiBTdHJpbmcoYy5hcmd1bWVudHNbMF0pLmluY2x1ZGVzKCdzZXNzaW9uIGVycm9yJykpLFxuICAgICAgKTtcbiAgICB9KTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQVFBLFNBQVMsVUFBVSxJQUFJLFlBQVk7QUFDbkMsT0FBTyxZQUFZO0FBQ25CLFNBQVMsb0JBQW9CO0FBQzdCLFNBQVMsbUJBQW1CO0FBVTVCLFNBQVMsbUJBQW1CO0FBQzFCLFNBQU87QUFBQSxJQUNMLE9BQU8sS0FBSyxHQUFHLE1BQU07QUFBQSxJQUFDLENBQUM7QUFBQSxJQUN2QixNQUFNLEtBQUssR0FBRyxNQUFNO0FBQUEsSUFBQyxDQUFDO0FBQUEsSUFDdEIsTUFBTSxLQUFLLEdBQUcsTUFBTTtBQUFBLElBQUMsQ0FBQztBQUFBLElBQ3RCLE9BQU8sS0FBSyxHQUFHLE1BQU07QUFBQSxJQUFDLENBQUM7QUFBQSxFQUN6QjtBQUNGO0FBRUEsU0FBUywyQkFBMkI7QUFDbEMsUUFBTSxlQUEwQixDQUFDO0FBQ2pDLFFBQU0sY0FBYztBQUFBLElBQ2xCLElBQUk7QUFBQSxJQUNKLE1BQU0sS0FBSyxHQUFHLE9BQU8sYUFBc0I7QUFDekMsbUJBQWEsS0FBSyxRQUFRO0FBQzFC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
