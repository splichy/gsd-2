import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolve, basename } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.js";
import { MAX_EVENTS } from "./types.js";
import { Logger } from "./logger.js";
class MockRpcClient {
  started = false;
  stopped = false;
  aborted = false;
  prompted = [];
  eventListeners = [];
  uiResponses = [];
  /** Control — set to make start() reject */
  startError = null;
  /** Control — set to make init() reject */
  initError = null;
  /** Control — override sessionId from init */
  initSessionId = "mock-session-001";
  cwd;
  args;
  constructor(options) {
    this.cwd = options?.cwd ?? "";
    this.args = options?.args ?? [];
  }
  async start() {
    if (this.startError) throw this.startError;
    this.started = true;
  }
  async stop() {
    this.stopped = true;
  }
  async init() {
    if (this.initError) throw this.initError;
    return { sessionId: this.initSessionId, version: "2.51.0" };
  }
  onEvent(listener) {
    this.eventListeners.push(listener);
    return () => {
      const idx = this.eventListeners.indexOf(listener);
      if (idx >= 0) this.eventListeners.splice(idx, 1);
    };
  }
  async prompt(message) {
    this.prompted.push(message);
  }
  async abort() {
    this.aborted = true;
  }
  sendUIResponse(requestId, response) {
    this.uiResponses.push({ requestId, response });
  }
  /** Test helper — emit an event to all listeners */
  emitEvent(event) {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }
}
class TestableSessionManager extends SessionManager {
  lastClient = null;
  allClients = [];
  sessionCounter = 0;
  nextInitError = null;
  nextStartError = null;
  async startSession(options) {
    const { projectDir } = options;
    if (!projectDir || projectDir.trim() === "") {
      throw new Error("projectDir is required and cannot be empty");
    }
    const resolvedDir = resolve(projectDir);
    const projectName = basename(resolvedDir);
    const existing = this.getSessionByDir(resolvedDir);
    if (existing) {
      throw new Error(
        `Session already active for ${resolvedDir} (sessionId: ${existing.sessionId}, status: ${existing.status})`
      );
    }
    const client = new MockRpcClient({ cwd: resolvedDir, args: [] });
    if (this.nextStartError) {
      client.startError = this.nextStartError;
      this.nextStartError = null;
    }
    if (this.nextInitError) {
      client.initError = this.nextInitError;
      this.nextInitError = null;
    }
    this.sessionCounter++;
    client.initSessionId = `mock-session-${String(this.sessionCounter).padStart(3, "0")}`;
    this.lastClient = client;
    this.allClients.push(client);
    const session = {
      sessionId: "",
      projectDir: resolvedDir,
      projectName,
      status: "starting",
      client,
      // duck-typed mock
      events: [],
      pendingBlocker: null,
      cost: { totalCost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      startTime: Date.now()
    };
    this.sessions.set(resolvedDir, session);
    try {
      await client.start();
      const initResult = await client.init();
      session.sessionId = initResult.sessionId;
      session.status = "running";
      session.unsubscribe = client.onEvent((event) => {
        this.handleEvent(session, event);
      });
      const command = options.command ?? "/gsd auto";
      await client.prompt(command);
      this.logger.info("session started", { sessionId: session.sessionId, projectDir: resolvedDir });
      this.emit("session:started", { sessionId: session.sessionId, projectDir: resolvedDir, projectName });
      return session.sessionId;
    } catch (err) {
      session.status = "error";
      session.error = err instanceof Error ? err.message : String(err);
      try {
        await client.stop();
      } catch {
      }
      this.logger.error("session error", { sessionId: session.sessionId, projectDir: resolvedDir, error: session.error });
      this.emit("session:error", { sessionId: session.sessionId, projectDir: resolvedDir, projectName, error: session.error });
      throw new Error(`Failed to start session for ${resolvedDir}: ${session.error}`);
    }
  }
}
class SpyLogger {
  calls = [];
  tmpDir;
  logger;
  constructor() {
    this.tmpDir = mkdtempSync(join(tmpdir(), "sm-test-"));
    this.logger = new Logger({
      filePath: join(this.tmpDir, "test.log"),
      level: "debug"
    });
    const original = {
      debug: this.logger.debug.bind(this.logger),
      info: this.logger.info.bind(this.logger),
      warn: this.logger.warn.bind(this.logger),
      error: this.logger.error.bind(this.logger)
    };
    this.logger.debug = (msg, data) => {
      this.calls.push({ level: "debug", msg, data });
      original.debug(msg, data);
    };
    this.logger.info = (msg, data) => {
      this.calls.push({ level: "info", msg, data });
      original.info(msg, data);
    };
    this.logger.warn = (msg, data) => {
      this.calls.push({ level: "warn", msg, data });
      original.warn(msg, data);
    };
    this.logger.error = (msg, data) => {
      this.calls.push({ level: "error", msg, data });
      original.error(msg, data);
    };
  }
  async cleanup() {
    await this.logger.close();
    try {
      rmSync(this.tmpDir, { recursive: true, force: true });
    } catch {
    }
  }
  findCalls(level, msgSubstring) {
    return this.calls.filter((c) => c.level === level && c.msg.includes(msgSubstring));
  }
}
let allManagers = [];
let allSpyLoggers = [];
function createManager() {
  const spy = new SpyLogger();
  const manager = new TestableSessionManager(spy.logger);
  allManagers.push(manager);
  allSpyLoggers.push(spy);
  return { manager, spy };
}
describe("SessionManager", () => {
  afterEach(async () => {
    for (const m of allManagers) {
      try {
        await m.cleanup();
      } catch {
      }
    }
    allManagers = [];
    for (const s of allSpyLoggers) {
      await s.cleanup();
    }
    allSpyLoggers = [];
  });
  it("start \u2192 running \u2192 completed lifecycle", async () => {
    const { manager, spy } = createManager();
    const sessionId = await manager.startSession({ projectDir: "/tmp/test-project" });
    assert.ok(sessionId);
    const session = manager.getSession(sessionId);
    assert.ok(session);
    assert.equal(session.status, "running");
    assert.equal(session.projectName, "test-project");
    manager.lastClient.emitEvent({
      type: "extension_ui_request",
      id: "n1",
      method: "notify",
      message: "Auto-mode stopped: completed all tasks"
    });
    assert.equal(session.status, "completed");
    const startedLogs = spy.findCalls("info", "session started");
    assert.equal(startedLogs.length, 1);
    const completedLogs = spy.findCalls("info", "session completed");
    assert.equal(completedLogs.length, 1);
  });
  it("start \u2192 blocked \u2192 resolve \u2192 running \u2192 completed lifecycle", async () => {
    const { manager } = createManager();
    const sessionId = await manager.startSession({ projectDir: "/tmp/test-project-2" });
    const session = manager.getSession(sessionId);
    manager.lastClient.emitEvent({
      type: "extension_ui_request",
      id: "blocker-1",
      method: "confirm",
      title: "Merge PR?",
      message: "Should I merge this PR?"
    });
    assert.equal(session.status, "blocked");
    assert.ok(session.pendingBlocker);
    assert.equal(session.pendingBlocker.id, "blocker-1");
    assert.equal(session.pendingBlocker.method, "confirm");
    await manager.resolveBlocker(sessionId, "yes");
    assert.equal(session.status, "running");
    assert.equal(session.pendingBlocker, null);
    const client = manager.lastClient;
    assert.equal(client.uiResponses.length, 1);
    assert.equal(client.uiResponses[0].requestId, "blocker-1");
    manager.lastClient.emitEvent({
      type: "extension_ui_request",
      id: "n2",
      method: "notify",
      message: "Auto-mode stopped: all done"
    });
    assert.equal(session.status, "completed");
  });
  it("start \u2192 error when init fails", async () => {
    const { manager, spy } = createManager();
    manager.nextInitError = new Error("Connection refused");
    await assert.rejects(
      () => manager.startSession({ projectDir: "/tmp/test-error-project" }),
      (err) => {
        assert.ok(err.message.includes("Connection refused"));
        return true;
      }
    );
    const session = manager.getSessionByDir("/tmp/test-error-project");
    assert.ok(session);
    assert.equal(session.status, "error");
    assert.ok(session.error?.includes("Connection refused"));
    const errorLogs = spy.findCalls("error", "session error");
    assert.equal(errorLogs.length, 1);
  });
  it("rejects duplicate session for same projectDir", async () => {
    const { manager } = createManager();
    await manager.startSession({ projectDir: "/tmp/dup-test" });
    await assert.rejects(
      () => manager.startSession({ projectDir: "/tmp/dup-test" }),
      (err) => {
        assert.ok(err.message.includes("Session already active"));
        return true;
      }
    );
  });
  it("cancels a running session", async () => {
    const { manager, spy } = createManager();
    const sessionId = await manager.startSession({ projectDir: "/tmp/cancel-test" });
    const session = manager.getSession(sessionId);
    const client = manager.lastClient;
    await manager.cancelSession(sessionId);
    assert.equal(session.status, "cancelled");
    assert.ok(client.aborted);
    assert.ok(client.stopped);
    const cancelLogs = spy.findCalls("info", "session cancelled");
    assert.equal(cancelLogs.length, 1);
  });
  it("accumulates cost using cumulative-max pattern (K004)", async () => {
    const { manager } = createManager();
    const sessionId = await manager.startSession({ projectDir: "/tmp/cost-test" });
    const session = manager.getSession(sessionId);
    const client = manager.lastClient;
    client.emitEvent({
      type: "cost_update",
      runId: "run-1",
      turnCost: 0.01,
      cumulativeCost: 0.01,
      tokens: { input: 100, output: 50, cacheRead: 20, cacheWrite: 10 }
    });
    assert.equal(session.cost.totalCost, 0.01);
    assert.equal(session.cost.tokens.input, 100);
    client.emitEvent({
      type: "cost_update",
      runId: "run-1",
      turnCost: 0.02,
      cumulativeCost: 0.03,
      tokens: { input: 250, output: 120, cacheRead: 40, cacheWrite: 20 }
    });
    assert.equal(session.cost.totalCost, 0.03);
    assert.equal(session.cost.tokens.input, 250);
    assert.equal(session.cost.tokens.output, 120);
    client.emitEvent({
      type: "cost_update",
      runId: "run-2",
      turnCost: 5e-3,
      cumulativeCost: 0.02,
      // lower than 0.03 — should NOT replace
      tokens: { input: 50, output: 30, cacheRead: 5, cacheWrite: 2 }
    });
    assert.equal(session.cost.totalCost, 0.03);
    assert.equal(session.cost.tokens.input, 250);
  });
  it("trims events when exceeding MAX_EVENTS", async () => {
    const { manager } = createManager();
    const sessionId = await manager.startSession({ projectDir: "/tmp/ringbuf-test" });
    const session = manager.getSession(sessionId);
    const client = manager.lastClient;
    for (let i = 0; i < MAX_EVENTS + 20; i++) {
      client.emitEvent({
        type: "assistant_message",
        id: `msg-${i}`,
        content: `Event ${i}`
      });
    }
    assert.equal(session.events.length, MAX_EVENTS);
    const firstEvent = session.events[0];
    assert.equal(firstEvent.id, "msg-20");
  });
  it("detects blocker from non-fire-and-forget extension_ui_request", async () => {
    const { manager, spy } = createManager();
    const sessionId = await manager.startSession({ projectDir: "/tmp/blocker-test" });
    const session = manager.getSession(sessionId);
    manager.lastClient.emitEvent({
      type: "extension_ui_request",
      id: "sel-1",
      method: "select",
      title: "Choose deployment target",
      options: ["staging", "production"]
    });
    assert.equal(session.status, "blocked");
    assert.ok(session.pendingBlocker);
    assert.equal(session.pendingBlocker.method, "select");
    const blockedLogs = spy.findCalls("info", "session blocked");
    assert.equal(blockedLogs.length, 1);
  });
  it("fire-and-forget methods do not trigger blocker", async () => {
    const { manager } = createManager();
    const sessionId = await manager.startSession({ projectDir: "/tmp/faf-test" });
    const session = manager.getSession(sessionId);
    manager.lastClient.emitEvent({
      type: "extension_ui_request",
      id: "st-1",
      method: "setStatus",
      statusKey: "build",
      statusText: "Building..."
    });
    assert.equal(session.status, "running");
    assert.equal(session.pendingBlocker, null);
  });
  it("detects terminal from auto-mode stopped notification", async () => {
    const { manager } = createManager();
    const sessionId = await manager.startSession({ projectDir: "/tmp/terminal-test" });
    const session = manager.getSession(sessionId);
    manager.lastClient.emitEvent({
      type: "extension_ui_request",
      id: "n1",
      method: "notify",
      message: "Step-mode stopped: user requested"
    });
    assert.equal(session.status, "completed");
  });
  it("getAllSessions returns all tracked sessions", async () => {
    const { manager } = createManager();
    await manager.startSession({ projectDir: "/tmp/proj-a" });
    await manager.startSession({ projectDir: "/tmp/proj-b" });
    await manager.startSession({ projectDir: "/tmp/proj-c" });
    const all = manager.getAllSessions();
    assert.equal(all.length, 3);
    const dirs = all.map((s) => s.projectDir).sort();
    assert.ok(dirs[0].endsWith("proj-a"));
    assert.ok(dirs[1].endsWith("proj-b"));
    assert.ok(dirs[2].endsWith("proj-c"));
  });
  it("cleanup stops all active sessions", async () => {
    const { manager } = createManager();
    await manager.startSession({ projectDir: "/tmp/cleanup-a" });
    await manager.startSession({ projectDir: "/tmp/cleanup-b" });
    const clients = [...manager.allClients];
    assert.equal(clients.length, 2);
    await manager.cleanup();
    const all = manager.getAllSessions();
    for (const s of all) {
      assert.equal(s.status, "cancelled");
    }
    for (const c of clients) {
      assert.ok(c.stopped);
    }
  });
  it("emits session:started event", async () => {
    const { manager } = createManager();
    let emittedData;
    manager.on("session:started", (data) => {
      emittedData = data;
    });
    const sessionId = await manager.startSession({ projectDir: "/tmp/emit-start" });
    assert.ok(emittedData);
    assert.equal(emittedData.sessionId, sessionId);
    assert.equal(emittedData.projectName, "emit-start");
  });
  it("emits session:blocked event", async () => {
    const { manager } = createManager();
    let emittedData;
    manager.on("session:blocked", (data) => {
      emittedData = data;
    });
    await manager.startSession({ projectDir: "/tmp/emit-blocked" });
    manager.lastClient.emitEvent({
      type: "extension_ui_request",
      id: "b-1",
      method: "input",
      title: "Enter API key"
    });
    assert.ok(emittedData);
    assert.equal(emittedData.blocker.id, "b-1");
  });
  it("emits session:completed event", async () => {
    const { manager } = createManager();
    let emittedData;
    manager.on("session:completed", (data) => {
      emittedData = data;
    });
    await manager.startSession({ projectDir: "/tmp/emit-completed" });
    manager.lastClient.emitEvent({
      type: "extension_ui_request",
      id: "n1",
      method: "notify",
      message: "Auto-mode stopped: success"
    });
    assert.ok(emittedData);
    assert.equal(emittedData.projectName, "emit-completed");
  });
  it("emits session:error event on init failure", async () => {
    const { manager } = createManager();
    let emittedData;
    manager.on("session:error", (data) => {
      emittedData = data;
    });
    manager.nextInitError = new Error("Process crashed");
    try {
      await manager.startSession({ projectDir: "/tmp/emit-error" });
    } catch {
    }
    assert.ok(emittedData);
    assert.ok(emittedData.error.includes("Process crashed"));
  });
  it("emits session:event for every forwarded event", async () => {
    const { manager } = createManager();
    const events = [];
    manager.on("session:event", (data) => {
      events.push(data);
    });
    await manager.startSession({ projectDir: "/tmp/emit-event" });
    manager.lastClient.emitEvent({ type: "assistant_message", id: "a1", content: "Hello" });
    manager.lastClient.emitEvent({ type: "tool_use", id: "t1", name: "read" });
    assert.equal(events.length, 2);
  });
  it("rejects empty projectDir", async () => {
    const { manager } = createManager();
    await assert.rejects(
      () => manager.startSession({ projectDir: "" }),
      (err) => {
        assert.ok(err.message.includes("projectDir is required"));
        return true;
      }
    );
    await assert.rejects(
      () => manager.startSession({ projectDir: "   " }),
      (err) => {
        assert.ok(err.message.includes("projectDir is required"));
        return true;
      }
    );
  });
  it("logger receives structured calls during lifecycle", async () => {
    const { manager, spy } = createManager();
    const sessionId = await manager.startSession({ projectDir: "/tmp/log-test" });
    const started = spy.findCalls("info", "session started");
    assert.equal(started.length, 1);
    assert.ok(started[0].data?.sessionId);
    assert.ok(started[0].data?.projectDir);
    manager.lastClient.emitEvent({ type: "assistant_message", id: "a1", content: "hi" });
    const debugLogs = spy.findCalls("debug", "session event");
    assert.ok(debugLogs.length >= 1);
    assert.ok(debugLogs[0].data?.type);
  });
  it("getResult returns structured status", async () => {
    const { manager } = createManager();
    const sessionId = await manager.startSession({ projectDir: "/tmp/result-test" });
    const result = manager.getResult(sessionId);
    assert.equal(result.sessionId, sessionId);
    assert.equal(result.status, "running");
    assert.equal(result.projectName, "result-test");
    assert.equal(result.error, null);
    assert.equal(result.pendingBlocker, null);
    assert.ok(typeof result.durationMs === "number");
    assert.ok(result.cost);
    assert.ok(Array.isArray(result.recentEvents));
  });
  it("getResult throws for unknown sessionId", () => {
    const { manager } = createManager();
    assert.throws(
      () => manager.getResult("nonexistent"),
      (err) => err.message.includes("Session not found")
    );
  });
  it("resolveBlocker throws when no blocker pending", async () => {
    const { manager } = createManager();
    const sessionId = await manager.startSession({ projectDir: "/tmp/no-blocker" });
    await assert.rejects(
      () => manager.resolveBlocker(sessionId, "yes"),
      (err) => err.message.includes("No pending blocker")
    );
  });
  it("cancelSession throws for unknown sessionId", async () => {
    const { manager } = createManager();
    await assert.rejects(
      () => manager.cancelSession("nonexistent"),
      (err) => err.message.includes("Session not found")
    );
  });
  it("blocked notification sets status to blocked, not completed", async () => {
    const { manager } = createManager();
    const sessionId = await manager.startSession({ projectDir: "/tmp/blocked-notify" });
    const session = manager.getSession(sessionId);
    manager.lastClient.emitEvent({
      type: "extension_ui_request",
      id: "bn-1",
      method: "notify",
      message: "Auto-mode stopped: Blocked: waiting for approval"
    });
    assert.equal(session.status, "blocked");
    assert.ok(session.pendingBlocker);
  });
  it("projectName is basename of projectDir", async () => {
    const { manager } = createManager();
    const sessionId = await manager.startSession({ projectDir: "/home/user/projects/my-app" });
    const session = manager.getSession(sessionId);
    assert.equal(session.projectName, "my-app");
  });
  it("sends custom command when provided", async () => {
    const { manager } = createManager();
    await manager.startSession({ projectDir: "/tmp/custom-cmd", command: "/gsd quick fix-typo" });
    const client = manager.lastClient;
    assert.ok(client.prompted.includes("/gsd quick fix-typo"));
    assert.ok(!client.prompted.includes("/gsd auto"));
  });
  it("getSessionByDir returns session by directory", async () => {
    const { manager } = createManager();
    await manager.startSession({ projectDir: "/tmp/dir-lookup" });
    const session = manager.getSessionByDir("/tmp/dir-lookup");
    assert.ok(session);
    assert.equal(session.projectName, "dir-lookup");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvZGFlbW9uL3NyYy9zZXNzaW9uLW1hbmFnZXIudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBTZXNzaW9uTWFuYWdlciB1bml0IHRlc3RzLlxuICpcbiAqIFVzZXMgdGhlIE1vY2tScGNDbGllbnQgKyBUZXN0YWJsZVNlc3Npb25NYW5hZ2VyIHBhdHRlcm4gKEswMDgpIHRvIHRlc3RcbiAqIHNlc3Npb24gbGlmZWN5Y2xlLCBldmVudCBoYW5kbGluZywgY29zdCB0cmFja2luZywgYmxvY2tlciBkZXRlY3Rpb24sXG4gKiBhbmQgY2xlYW51cCB3aXRob3V0IHNwYXduaW5nIHJlYWwgR1NEIHByb2Nlc3Nlcy5cbiAqL1xuXG5pbXBvcnQgeyBkZXNjcmliZSwgaXQsIGJlZm9yZUVhY2gsIGFmdGVyRWFjaCB9IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG5pbXBvcnQgeyByZXNvbHZlLCBiYXNlbmFtZSB9IGZyb20gJ25vZGU6cGF0aCc7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgd3JpdGVGaWxlU3luYywgbWtkaXJTeW5jLCBybVN5bmMgfSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gJ25vZGU6b3MnO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gJ25vZGU6cGF0aCc7XG5cbmltcG9ydCB7IFNlc3Npb25NYW5hZ2VyIH0gZnJvbSAnLi9zZXNzaW9uLW1hbmFnZXIuanMnO1xuaW1wb3J0IHsgTUFYX0VWRU5UUyB9IGZyb20gJy4vdHlwZXMuanMnO1xuaW1wb3J0IHR5cGUgeyBNYW5hZ2VkU2Vzc2lvbiwgUGVuZGluZ0Jsb2NrZXIgfSBmcm9tICcuL3R5cGVzLmpzJztcbmltcG9ydCB7IExvZ2dlciB9IGZyb20gJy4vbG9nZ2VyLmpzJztcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBNb2NrIFJwY0NsaWVudCAoZHVjay10eXBlZCB0byBtYXRjaCBScGNDbGllbnQgaW50ZXJmYWNlKVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmNsYXNzIE1vY2tScGNDbGllbnQge1xuICBzdGFydGVkID0gZmFsc2U7XG4gIHN0b3BwZWQgPSBmYWxzZTtcbiAgYWJvcnRlZCA9IGZhbHNlO1xuICBwcm9tcHRlZDogc3RyaW5nW10gPSBbXTtcbiAgcHJpdmF0ZSBldmVudExpc3RlbmVyczogQXJyYXk8KGV2ZW50OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4gdm9pZD4gPSBbXTtcbiAgdWlSZXNwb25zZXM6IEFycmF5PHsgcmVxdWVzdElkOiBzdHJpbmc7IHJlc3BvbnNlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB9PiA9IFtdO1xuXG4gIC8qKiBDb250cm9sIFx1MjAxNCBzZXQgdG8gbWFrZSBzdGFydCgpIHJlamVjdCAqL1xuICBzdGFydEVycm9yOiBFcnJvciB8IG51bGwgPSBudWxsO1xuICAvKiogQ29udHJvbCBcdTIwMTQgc2V0IHRvIG1ha2UgaW5pdCgpIHJlamVjdCAqL1xuICBpbml0RXJyb3I6IEVycm9yIHwgbnVsbCA9IG51bGw7XG4gIC8qKiBDb250cm9sIFx1MjAxNCBvdmVycmlkZSBzZXNzaW9uSWQgZnJvbSBpbml0ICovXG4gIGluaXRTZXNzaW9uSWQgPSAnbW9jay1zZXNzaW9uLTAwMSc7XG5cbiAgY3dkOiBzdHJpbmc7XG4gIGFyZ3M6IHN0cmluZ1tdO1xuXG4gIGNvbnN0cnVjdG9yKG9wdGlvbnM/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikge1xuICAgIHRoaXMuY3dkID0gKG9wdGlvbnM/LmN3ZCBhcyBzdHJpbmcpID8/ICcnO1xuICAgIHRoaXMuYXJncyA9IChvcHRpb25zPy5hcmdzIGFzIHN0cmluZ1tdKSA/PyBbXTtcbiAgfVxuXG4gIGFzeW5jIHN0YXJ0KCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICh0aGlzLnN0YXJ0RXJyb3IpIHRocm93IHRoaXMuc3RhcnRFcnJvcjtcbiAgICB0aGlzLnN0YXJ0ZWQgPSB0cnVlO1xuICB9XG5cbiAgYXN5bmMgc3RvcCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICB0aGlzLnN0b3BwZWQgPSB0cnVlO1xuICB9XG5cbiAgYXN5bmMgaW5pdCgpOiBQcm9taXNlPHsgc2Vzc2lvbklkOiBzdHJpbmc7IHZlcnNpb246IHN0cmluZyB9PiB7XG4gICAgaWYgKHRoaXMuaW5pdEVycm9yKSB0aHJvdyB0aGlzLmluaXRFcnJvcjtcbiAgICByZXR1cm4geyBzZXNzaW9uSWQ6IHRoaXMuaW5pdFNlc3Npb25JZCwgdmVyc2lvbjogJzIuNTEuMCcgfTtcbiAgfVxuXG4gIG9uRXZlbnQobGlzdGVuZXI6IChldmVudDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHZvaWQpOiAoKSA9PiB2b2lkIHtcbiAgICB0aGlzLmV2ZW50TGlzdGVuZXJzLnB1c2gobGlzdGVuZXIpO1xuICAgIHJldHVybiAoKSA9PiB7XG4gICAgICBjb25zdCBpZHggPSB0aGlzLmV2ZW50TGlzdGVuZXJzLmluZGV4T2YobGlzdGVuZXIpO1xuICAgICAgaWYgKGlkeCA+PSAwKSB0aGlzLmV2ZW50TGlzdGVuZXJzLnNwbGljZShpZHgsIDEpO1xuICAgIH07XG4gIH1cblxuICBhc3luYyBwcm9tcHQobWVzc2FnZTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgdGhpcy5wcm9tcHRlZC5wdXNoKG1lc3NhZ2UpO1xuICB9XG5cbiAgYXN5bmMgYWJvcnQoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgdGhpcy5hYm9ydGVkID0gdHJ1ZTtcbiAgfVxuXG4gIHNlbmRVSVJlc3BvbnNlKHJlcXVlc3RJZDogc3RyaW5nLCByZXNwb25zZTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiB2b2lkIHtcbiAgICB0aGlzLnVpUmVzcG9uc2VzLnB1c2goeyByZXF1ZXN0SWQsIHJlc3BvbnNlIH0pO1xuICB9XG5cbiAgLyoqIFRlc3QgaGVscGVyIFx1MjAxNCBlbWl0IGFuIGV2ZW50IHRvIGFsbCBsaXN0ZW5lcnMgKi9cbiAgZW1pdEV2ZW50KGV2ZW50OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IHZvaWQge1xuICAgIGZvciAoY29uc3QgbGlzdGVuZXIgb2YgdGhpcy5ldmVudExpc3RlbmVycykge1xuICAgICAgbGlzdGVuZXIoZXZlbnQpO1xuICAgIH1cbiAgfVxufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFRlc3RhYmxlU2Vzc2lvbk1hbmFnZXIgXHUyMDE0IGluamVjdHMgbW9jayBjbGllbnRzIHdpdGhvdXQgbW9kdWxlIG1vY2tpbmcgKEswMDgpXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuY2xhc3MgVGVzdGFibGVTZXNzaW9uTWFuYWdlciBleHRlbmRzIFNlc3Npb25NYW5hZ2VyIHtcbiAgbGFzdENsaWVudDogTW9ja1JwY0NsaWVudCB8IG51bGwgPSBudWxsO1xuICBhbGxDbGllbnRzOiBNb2NrUnBjQ2xpZW50W10gPSBbXTtcbiAgcHJpdmF0ZSBzZXNzaW9uQ291bnRlciA9IDA7XG4gIG5leHRJbml0RXJyb3I6IEVycm9yIHwgbnVsbCA9IG51bGw7XG4gIG5leHRTdGFydEVycm9yOiBFcnJvciB8IG51bGwgPSBudWxsO1xuXG4gIG92ZXJyaWRlIGFzeW5jIHN0YXJ0U2Vzc2lvbihvcHRpb25zOiB7IHByb2plY3REaXI6IHN0cmluZzsgY29tbWFuZD86IHN0cmluZzsgbW9kZWw/OiBzdHJpbmc7IGJhcmU/OiBib29sZWFuOyBjbGlQYXRoPzogc3RyaW5nIH0pOiBQcm9taXNlPHN0cmluZz4ge1xuICAgIGNvbnN0IHsgcHJvamVjdERpciB9ID0gb3B0aW9ucztcblxuICAgIGlmICghcHJvamVjdERpciB8fCBwcm9qZWN0RGlyLnRyaW0oKSA9PT0gJycpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcigncHJvamVjdERpciBpcyByZXF1aXJlZCBhbmQgY2Fubm90IGJlIGVtcHR5Jyk7XG4gICAgfVxuXG4gICAgY29uc3QgcmVzb2x2ZWREaXIgPSByZXNvbHZlKHByb2plY3REaXIpO1xuICAgIGNvbnN0IHByb2plY3ROYW1lID0gYmFzZW5hbWUocmVzb2x2ZWREaXIpO1xuXG4gICAgLy8gQ2hlY2sgZHVwbGljYXRlIHZpYSBnZXRTZXNzaW9uQnlEaXJcbiAgICBjb25zdCBleGlzdGluZyA9IHRoaXMuZ2V0U2Vzc2lvbkJ5RGlyKHJlc29sdmVkRGlyKTtcbiAgICBpZiAoZXhpc3RpbmcpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYFNlc3Npb24gYWxyZWFkeSBhY3RpdmUgZm9yICR7cmVzb2x2ZWREaXJ9IChzZXNzaW9uSWQ6ICR7ZXhpc3Rpbmcuc2Vzc2lvbklkfSwgc3RhdHVzOiAke2V4aXN0aW5nLnN0YXR1c30pYFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCBjbGllbnQgPSBuZXcgTW9ja1JwY0NsaWVudCh7IGN3ZDogcmVzb2x2ZWREaXIsIGFyZ3M6IFtdIH0pO1xuICAgIGlmICh0aGlzLm5leHRTdGFydEVycm9yKSB7XG4gICAgICBjbGllbnQuc3RhcnRFcnJvciA9IHRoaXMubmV4dFN0YXJ0RXJyb3I7XG4gICAgICB0aGlzLm5leHRTdGFydEVycm9yID0gbnVsbDtcbiAgICB9XG4gICAgaWYgKHRoaXMubmV4dEluaXRFcnJvcikge1xuICAgICAgY2xpZW50LmluaXRFcnJvciA9IHRoaXMubmV4dEluaXRFcnJvcjtcbiAgICAgIHRoaXMubmV4dEluaXRFcnJvciA9IG51bGw7XG4gICAgfVxuXG4gICAgdGhpcy5zZXNzaW9uQ291bnRlcisrO1xuICAgIGNsaWVudC5pbml0U2Vzc2lvbklkID0gYG1vY2stc2Vzc2lvbi0ke1N0cmluZyh0aGlzLnNlc3Npb25Db3VudGVyKS5wYWRTdGFydCgzLCAnMCcpfWA7XG4gICAgdGhpcy5sYXN0Q2xpZW50ID0gY2xpZW50O1xuICAgIHRoaXMuYWxsQ2xpZW50cy5wdXNoKGNsaWVudCk7XG5cbiAgICAvLyBCdWlsZCBzZXNzaW9uIHNoZWxsXG4gICAgY29uc3Qgc2Vzc2lvbjogTWFuYWdlZFNlc3Npb24gPSB7XG4gICAgICBzZXNzaW9uSWQ6ICcnLFxuICAgICAgcHJvamVjdERpcjogcmVzb2x2ZWREaXIsXG4gICAgICBwcm9qZWN0TmFtZSxcbiAgICAgIHN0YXR1czogJ3N0YXJ0aW5nJyxcbiAgICAgIGNsaWVudDogY2xpZW50IGFzIGFueSwgLy8gZHVjay10eXBlZCBtb2NrXG4gICAgICBldmVudHM6IFtdLFxuICAgICAgcGVuZGluZ0Jsb2NrZXI6IG51bGwsXG4gICAgICBjb3N0OiB7IHRvdGFsQ29zdDogMCwgdG9rZW5zOiB7IGlucHV0OiAwLCBvdXRwdXQ6IDAsIGNhY2hlUmVhZDogMCwgY2FjaGVXcml0ZTogMCB9IH0sXG4gICAgICBzdGFydFRpbWU6IERhdGUubm93KCksXG4gICAgfTtcblxuICAgIC8vIEluc2VydCBpbnRvIGludGVybmFsIHNlc3Npb25zIG1hcFxuICAgICh0aGlzIGFzIGFueSkuc2Vzc2lvbnMuc2V0KHJlc29sdmVkRGlyLCBzZXNzaW9uKTtcblxuICAgIHRyeSB7XG4gICAgICBhd2FpdCBjbGllbnQuc3RhcnQoKTtcblxuICAgICAgY29uc3QgaW5pdFJlc3VsdCA9IGF3YWl0IGNsaWVudC5pbml0KCk7XG4gICAgICBzZXNzaW9uLnNlc3Npb25JZCA9IGluaXRSZXN1bHQuc2Vzc2lvbklkO1xuICAgICAgc2Vzc2lvbi5zdGF0dXMgPSAncnVubmluZyc7XG5cbiAgICAgIC8vIFdpcmUgZXZlbnQgdHJhY2tpbmcgdXNpbmcgcGFyZW50J3MgaGFuZGxlRXZlbnRcbiAgICAgIHNlc3Npb24udW5zdWJzY3JpYmUgPSBjbGllbnQub25FdmVudCgoZXZlbnQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB7XG4gICAgICAgICh0aGlzIGFzIGFueSkuaGFuZGxlRXZlbnQoc2Vzc2lvbiwgZXZlbnQpO1xuICAgICAgfSk7XG5cbiAgICAgIC8vIEtpY2sgb2ZmIGF1dG8tbW9kZVxuICAgICAgY29uc3QgY29tbWFuZCA9IG9wdGlvbnMuY29tbWFuZCA/PyAnL2dzZCBhdXRvJztcbiAgICAgIGF3YWl0IGNsaWVudC5wcm9tcHQoY29tbWFuZCk7XG5cbiAgICAgIC8vIEVtaXQgbGlmZWN5Y2xlIGV2ZW50cyAobWF0Y2hpbmcgcGFyZW50IGJlaGF2aW9yKVxuICAgICAgKHRoaXMgYXMgYW55KS5sb2dnZXIuaW5mbygnc2Vzc2lvbiBzdGFydGVkJywgeyBzZXNzaW9uSWQ6IHNlc3Npb24uc2Vzc2lvbklkLCBwcm9qZWN0RGlyOiByZXNvbHZlZERpciB9KTtcbiAgICAgIHRoaXMuZW1pdCgnc2Vzc2lvbjpzdGFydGVkJywgeyBzZXNzaW9uSWQ6IHNlc3Npb24uc2Vzc2lvbklkLCBwcm9qZWN0RGlyOiByZXNvbHZlZERpciwgcHJvamVjdE5hbWUgfSk7XG5cbiAgICAgIHJldHVybiBzZXNzaW9uLnNlc3Npb25JZDtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHNlc3Npb24uc3RhdHVzID0gJ2Vycm9yJztcbiAgICAgIHNlc3Npb24uZXJyb3IgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgICB0cnkgeyBhd2FpdCBjbGllbnQuc3RvcCgpOyB9IGNhdGNoIHsgLyogc3dhbGxvdyAqLyB9XG5cbiAgICAgICh0aGlzIGFzIGFueSkubG9nZ2VyLmVycm9yKCdzZXNzaW9uIGVycm9yJywgeyBzZXNzaW9uSWQ6IHNlc3Npb24uc2Vzc2lvbklkLCBwcm9qZWN0RGlyOiByZXNvbHZlZERpciwgZXJyb3I6IHNlc3Npb24uZXJyb3IgfSk7XG4gICAgICB0aGlzLmVtaXQoJ3Nlc3Npb246ZXJyb3InLCB7IHNlc3Npb25JZDogc2Vzc2lvbi5zZXNzaW9uSWQsIHByb2plY3REaXI6IHJlc29sdmVkRGlyLCBwcm9qZWN0TmFtZSwgZXJyb3I6IHNlc3Npb24uZXJyb3IgfSk7XG5cbiAgICAgIHRocm93IG5ldyBFcnJvcihgRmFpbGVkIHRvIHN0YXJ0IHNlc3Npb24gZm9yICR7cmVzb2x2ZWREaXJ9OiAke3Nlc3Npb24uZXJyb3J9YCk7XG4gICAgfVxuICB9XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gTG9nZ2VyIHNweSBoZWxwZXJcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5pbnRlcmZhY2UgTG9nQ2FsbCB7XG4gIGxldmVsOiBzdHJpbmc7XG4gIG1zZzogc3RyaW5nO1xuICBkYXRhPzogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG59XG5cbmNsYXNzIFNweUxvZ2dlciB7XG4gIGNhbGxzOiBMb2dDYWxsW10gPSBbXTtcbiAgcHJpdmF0ZSB0bXBEaXI6IHN0cmluZztcbiAgbG9nZ2VyOiBMb2dnZXI7XG5cbiAgY29uc3RydWN0b3IoKSB7XG4gICAgdGhpcy50bXBEaXIgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCAnc20tdGVzdC0nKSk7XG4gICAgdGhpcy5sb2dnZXIgPSBuZXcgTG9nZ2VyKHtcbiAgICAgIGZpbGVQYXRoOiBqb2luKHRoaXMudG1wRGlyLCAndGVzdC5sb2cnKSxcbiAgICAgIGxldmVsOiAnZGVidWcnLFxuICAgIH0pO1xuXG4gICAgLy8gSW50ZXJjZXB0IHdyaXRlIGNhbGxzIGJ5IHdyYXBwaW5nIHRoZSBsb2dnZXIgbWV0aG9kc1xuICAgIGNvbnN0IG9yaWdpbmFsID0ge1xuICAgICAgZGVidWc6IHRoaXMubG9nZ2VyLmRlYnVnLmJpbmQodGhpcy5sb2dnZXIpLFxuICAgICAgaW5mbzogdGhpcy5sb2dnZXIuaW5mby5iaW5kKHRoaXMubG9nZ2VyKSxcbiAgICAgIHdhcm46IHRoaXMubG9nZ2VyLndhcm4uYmluZCh0aGlzLmxvZ2dlciksXG4gICAgICBlcnJvcjogdGhpcy5sb2dnZXIuZXJyb3IuYmluZCh0aGlzLmxvZ2dlciksXG4gICAgfTtcblxuICAgIHRoaXMubG9nZ2VyLmRlYnVnID0gKG1zZzogc3RyaW5nLCBkYXRhPzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHtcbiAgICAgIHRoaXMuY2FsbHMucHVzaCh7IGxldmVsOiAnZGVidWcnLCBtc2csIGRhdGEgfSk7XG4gICAgICBvcmlnaW5hbC5kZWJ1Zyhtc2csIGRhdGEpO1xuICAgIH07XG4gICAgdGhpcy5sb2dnZXIuaW5mbyA9IChtc2c6IHN0cmluZywgZGF0YT86IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB7XG4gICAgICB0aGlzLmNhbGxzLnB1c2goeyBsZXZlbDogJ2luZm8nLCBtc2csIGRhdGEgfSk7XG4gICAgICBvcmlnaW5hbC5pbmZvKG1zZywgZGF0YSk7XG4gICAgfTtcbiAgICB0aGlzLmxvZ2dlci53YXJuID0gKG1zZzogc3RyaW5nLCBkYXRhPzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHtcbiAgICAgIHRoaXMuY2FsbHMucHVzaCh7IGxldmVsOiAnd2FybicsIG1zZywgZGF0YSB9KTtcbiAgICAgIG9yaWdpbmFsLndhcm4obXNnLCBkYXRhKTtcbiAgICB9O1xuICAgIHRoaXMubG9nZ2VyLmVycm9yID0gKG1zZzogc3RyaW5nLCBkYXRhPzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHtcbiAgICAgIHRoaXMuY2FsbHMucHVzaCh7IGxldmVsOiAnZXJyb3InLCBtc2csIGRhdGEgfSk7XG4gICAgICBvcmlnaW5hbC5lcnJvcihtc2csIGRhdGEpO1xuICAgIH07XG4gIH1cblxuICBhc3luYyBjbGVhbnVwKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGF3YWl0IHRoaXMubG9nZ2VyLmNsb3NlKCk7XG4gICAgdHJ5IHsgcm1TeW5jKHRoaXMudG1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0gY2F0Y2ggeyAvKiBpZ25vcmUgKi8gfVxuICB9XG5cbiAgZmluZENhbGxzKGxldmVsOiBzdHJpbmcsIG1zZ1N1YnN0cmluZzogc3RyaW5nKTogTG9nQ2FsbFtdIHtcbiAgICByZXR1cm4gdGhpcy5jYWxscy5maWx0ZXIoYyA9PiBjLmxldmVsID09PSBsZXZlbCAmJiBjLm1zZy5pbmNsdWRlcyhtc2dTdWJzdHJpbmcpKTtcbiAgfVxufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFRlc3QgSGVscGVyc1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmxldCBhbGxNYW5hZ2VyczogVGVzdGFibGVTZXNzaW9uTWFuYWdlcltdID0gW107XG5sZXQgYWxsU3B5TG9nZ2VyczogU3B5TG9nZ2VyW10gPSBbXTtcblxuZnVuY3Rpb24gY3JlYXRlTWFuYWdlcigpOiB7IG1hbmFnZXI6IFRlc3RhYmxlU2Vzc2lvbk1hbmFnZXI7IHNweTogU3B5TG9nZ2VyIH0ge1xuICBjb25zdCBzcHkgPSBuZXcgU3B5TG9nZ2VyKCk7XG4gIGNvbnN0IG1hbmFnZXIgPSBuZXcgVGVzdGFibGVTZXNzaW9uTWFuYWdlcihzcHkubG9nZ2VyKTtcbiAgYWxsTWFuYWdlcnMucHVzaChtYW5hZ2VyKTtcbiAgYWxsU3B5TG9nZ2Vycy5wdXNoKHNweSk7XG4gIHJldHVybiB7IG1hbmFnZXIsIHNweSB9O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFRlc3RzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZGVzY3JpYmUoJ1Nlc3Npb25NYW5hZ2VyJywgKCkgPT4ge1xuICBhZnRlckVhY2goYXN5bmMgKCkgPT4ge1xuICAgIGZvciAoY29uc3QgbSBvZiBhbGxNYW5hZ2Vycykge1xuICAgICAgdHJ5IHsgYXdhaXQgbS5jbGVhbnVwKCk7IH0gY2F0Y2ggeyAvKiBzd2FsbG93ICovIH1cbiAgICB9XG4gICAgYWxsTWFuYWdlcnMgPSBbXTtcbiAgICBmb3IgKGNvbnN0IHMgb2YgYWxsU3B5TG9nZ2Vycykge1xuICAgICAgYXdhaXQgcy5jbGVhbnVwKCk7XG4gICAgfVxuICAgIGFsbFNweUxvZ2dlcnMgPSBbXTtcbiAgfSk7XG5cbiAgLy8gLS0tLSBMaWZlY3ljbGU6IHN0YXJ0IFx1MjE5MiBydW5uaW5nIFx1MjE5MiBjb21wbGV0ZWQgLS0tLVxuXG4gIGl0KCdzdGFydCBcdTIxOTIgcnVubmluZyBcdTIxOTIgY29tcGxldGVkIGxpZmVjeWNsZScsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB7IG1hbmFnZXIsIHNweSB9ID0gY3JlYXRlTWFuYWdlcigpO1xuXG4gICAgY29uc3Qgc2Vzc2lvbklkID0gYXdhaXQgbWFuYWdlci5zdGFydFNlc3Npb24oeyBwcm9qZWN0RGlyOiAnL3RtcC90ZXN0LXByb2plY3QnIH0pO1xuICAgIGFzc2VydC5vayhzZXNzaW9uSWQpO1xuXG4gICAgY29uc3Qgc2Vzc2lvbiA9IG1hbmFnZXIuZ2V0U2Vzc2lvbihzZXNzaW9uSWQpO1xuICAgIGFzc2VydC5vayhzZXNzaW9uKTtcbiAgICBhc3NlcnQuZXF1YWwoc2Vzc2lvbi5zdGF0dXMsICdydW5uaW5nJyk7XG4gICAgYXNzZXJ0LmVxdWFsKHNlc3Npb24ucHJvamVjdE5hbWUsICd0ZXN0LXByb2plY3QnKTtcblxuICAgIC8vIFNpbXVsYXRlIHRlcm1pbmFsIG5vdGlmaWNhdGlvblxuICAgIG1hbmFnZXIubGFzdENsaWVudCEuZW1pdEV2ZW50KHtcbiAgICAgIHR5cGU6ICdleHRlbnNpb25fdWlfcmVxdWVzdCcsXG4gICAgICBpZDogJ24xJyxcbiAgICAgIG1ldGhvZDogJ25vdGlmeScsXG4gICAgICBtZXNzYWdlOiAnQXV0by1tb2RlIHN0b3BwZWQ6IGNvbXBsZXRlZCBhbGwgdGFza3MnLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHNlc3Npb24uc3RhdHVzLCAnY29tcGxldGVkJyk7XG5cbiAgICAvLyBWZXJpZnkgbG9nZ2VyIGNhbGxzXG4gICAgY29uc3Qgc3RhcnRlZExvZ3MgPSBzcHkuZmluZENhbGxzKCdpbmZvJywgJ3Nlc3Npb24gc3RhcnRlZCcpO1xuICAgIGFzc2VydC5lcXVhbChzdGFydGVkTG9ncy5sZW5ndGgsIDEpO1xuICAgIGNvbnN0IGNvbXBsZXRlZExvZ3MgPSBzcHkuZmluZENhbGxzKCdpbmZvJywgJ3Nlc3Npb24gY29tcGxldGVkJyk7XG4gICAgYXNzZXJ0LmVxdWFsKGNvbXBsZXRlZExvZ3MubGVuZ3RoLCAxKTtcbiAgfSk7XG5cbiAgLy8gLS0tLSBMaWZlY3ljbGU6IHN0YXJ0IFx1MjE5MiBydW5uaW5nIFx1MjE5MiBibG9ja2VkIFx1MjE5MiByZXNvbHZlIFx1MjE5MiBydW5uaW5nIFx1MjE5MiBjb21wbGV0ZWQgLS0tLVxuXG4gIGl0KCdzdGFydCBcdTIxOTIgYmxvY2tlZCBcdTIxOTIgcmVzb2x2ZSBcdTIxOTIgcnVubmluZyBcdTIxOTIgY29tcGxldGVkIGxpZmVjeWNsZScsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB7IG1hbmFnZXIgfSA9IGNyZWF0ZU1hbmFnZXIoKTtcblxuICAgIGNvbnN0IHNlc3Npb25JZCA9IGF3YWl0IG1hbmFnZXIuc3RhcnRTZXNzaW9uKHsgcHJvamVjdERpcjogJy90bXAvdGVzdC1wcm9qZWN0LTInIH0pO1xuICAgIGNvbnN0IHNlc3Npb24gPSBtYW5hZ2VyLmdldFNlc3Npb24oc2Vzc2lvbklkKSE7XG5cbiAgICAvLyBTaW11bGF0ZSBibG9ja2luZyBVSSByZXF1ZXN0IChub24tZmlyZS1hbmQtZm9yZ2V0IG1ldGhvZClcbiAgICBtYW5hZ2VyLmxhc3RDbGllbnQhLmVtaXRFdmVudCh7XG4gICAgICB0eXBlOiAnZXh0ZW5zaW9uX3VpX3JlcXVlc3QnLFxuICAgICAgaWQ6ICdibG9ja2VyLTEnLFxuICAgICAgbWV0aG9kOiAnY29uZmlybScsXG4gICAgICB0aXRsZTogJ01lcmdlIFBSPycsXG4gICAgICBtZXNzYWdlOiAnU2hvdWxkIEkgbWVyZ2UgdGhpcyBQUj8nLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHNlc3Npb24uc3RhdHVzLCAnYmxvY2tlZCcpO1xuICAgIGFzc2VydC5vayhzZXNzaW9uLnBlbmRpbmdCbG9ja2VyKTtcbiAgICBhc3NlcnQuZXF1YWwoc2Vzc2lvbi5wZW5kaW5nQmxvY2tlciEuaWQsICdibG9ja2VyLTEnKTtcbiAgICBhc3NlcnQuZXF1YWwoc2Vzc2lvbi5wZW5kaW5nQmxvY2tlciEubWV0aG9kLCAnY29uZmlybScpO1xuXG4gICAgLy8gUmVzb2x2ZSB0aGUgYmxvY2tlclxuICAgIGF3YWl0IG1hbmFnZXIucmVzb2x2ZUJsb2NrZXIoc2Vzc2lvbklkLCAneWVzJyk7XG5cbiAgICBhc3NlcnQuZXF1YWwoc2Vzc2lvbi5zdGF0dXMsICdydW5uaW5nJyk7XG4gICAgYXNzZXJ0LmVxdWFsKHNlc3Npb24ucGVuZGluZ0Jsb2NrZXIsIG51bGwpO1xuXG4gICAgLy8gVmVyaWZ5IFVJIHJlc3BvbnNlIHdhcyBzZW50XG4gICAgY29uc3QgY2xpZW50ID0gbWFuYWdlci5sYXN0Q2xpZW50ITtcbiAgICBhc3NlcnQuZXF1YWwoY2xpZW50LnVpUmVzcG9uc2VzLmxlbmd0aCwgMSk7XG4gICAgYXNzZXJ0LmVxdWFsKGNsaWVudC51aVJlc3BvbnNlc1swXS5yZXF1ZXN0SWQsICdibG9ja2VyLTEnKTtcblxuICAgIC8vIENvbXBsZXRlIHRoZSBzZXNzaW9uXG4gICAgbWFuYWdlci5sYXN0Q2xpZW50IS5lbWl0RXZlbnQoe1xuICAgICAgdHlwZTogJ2V4dGVuc2lvbl91aV9yZXF1ZXN0JyxcbiAgICAgIGlkOiAnbjInLFxuICAgICAgbWV0aG9kOiAnbm90aWZ5JyxcbiAgICAgIG1lc3NhZ2U6ICdBdXRvLW1vZGUgc3RvcHBlZDogYWxsIGRvbmUnLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHNlc3Npb24uc3RhdHVzLCAnY29tcGxldGVkJyk7XG4gIH0pO1xuXG4gIC8vIC0tLS0gTGlmZWN5Y2xlOiBzdGFydCBcdTIxOTIgZXJyb3IgKGluaXQgZmFpbHVyZSkgLS0tLVxuXG4gIGl0KCdzdGFydCBcdTIxOTIgZXJyb3Igd2hlbiBpbml0IGZhaWxzJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHsgbWFuYWdlciwgc3B5IH0gPSBjcmVhdGVNYW5hZ2VyKCk7XG5cbiAgICBtYW5hZ2VyLm5leHRJbml0RXJyb3IgPSBuZXcgRXJyb3IoJ0Nvbm5lY3Rpb24gcmVmdXNlZCcpO1xuXG4gICAgYXdhaXQgYXNzZXJ0LnJlamVjdHMoXG4gICAgICAoKSA9PiBtYW5hZ2VyLnN0YXJ0U2Vzc2lvbih7IHByb2plY3REaXI6ICcvdG1wL3Rlc3QtZXJyb3ItcHJvamVjdCcgfSksXG4gICAgICAoZXJyOiBFcnJvcikgPT4ge1xuICAgICAgICBhc3NlcnQub2soZXJyLm1lc3NhZ2UuaW5jbHVkZXMoJ0Nvbm5lY3Rpb24gcmVmdXNlZCcpKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9XG4gICAgKTtcblxuICAgIC8vIFNlc3Npb24gc2hvdWxkIHN0aWxsIGV4aXN0IGluIG1hcCB3aXRoIGVycm9yIHN0YXR1c1xuICAgIGNvbnN0IHNlc3Npb24gPSBtYW5hZ2VyLmdldFNlc3Npb25CeURpcignL3RtcC90ZXN0LWVycm9yLXByb2plY3QnKTtcbiAgICBhc3NlcnQub2soc2Vzc2lvbik7XG4gICAgYXNzZXJ0LmVxdWFsKHNlc3Npb24uc3RhdHVzLCAnZXJyb3InKTtcbiAgICBhc3NlcnQub2soc2Vzc2lvbi5lcnJvcj8uaW5jbHVkZXMoJ0Nvbm5lY3Rpb24gcmVmdXNlZCcpKTtcblxuICAgIC8vIExvZ2dlciBzaG91bGQgaGF2ZSBlcnJvciBjYWxsXG4gICAgY29uc3QgZXJyb3JMb2dzID0gc3B5LmZpbmRDYWxscygnZXJyb3InLCAnc2Vzc2lvbiBlcnJvcicpO1xuICAgIGFzc2VydC5lcXVhbChlcnJvckxvZ3MubGVuZ3RoLCAxKTtcbiAgfSk7XG5cbiAgLy8gLS0tLSBEdXBsaWNhdGUgc2Vzc2lvbiBwcmV2ZW50aW9uIC0tLS1cblxuICBpdCgncmVqZWN0cyBkdXBsaWNhdGUgc2Vzc2lvbiBmb3Igc2FtZSBwcm9qZWN0RGlyJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHsgbWFuYWdlciB9ID0gY3JlYXRlTWFuYWdlcigpO1xuXG4gICAgYXdhaXQgbWFuYWdlci5zdGFydFNlc3Npb24oeyBwcm9qZWN0RGlyOiAnL3RtcC9kdXAtdGVzdCcgfSk7XG5cbiAgICBhd2FpdCBhc3NlcnQucmVqZWN0cyhcbiAgICAgICgpID0+IG1hbmFnZXIuc3RhcnRTZXNzaW9uKHsgcHJvamVjdERpcjogJy90bXAvZHVwLXRlc3QnIH0pLFxuICAgICAgKGVycjogRXJyb3IpID0+IHtcbiAgICAgICAgYXNzZXJ0Lm9rKGVyci5tZXNzYWdlLmluY2x1ZGVzKCdTZXNzaW9uIGFscmVhZHkgYWN0aXZlJykpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICApO1xuICB9KTtcblxuICAvLyAtLS0tIENhbmNlbCBzZXNzaW9uIC0tLS1cblxuICBpdCgnY2FuY2VscyBhIHJ1bm5pbmcgc2Vzc2lvbicsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB7IG1hbmFnZXIsIHNweSB9ID0gY3JlYXRlTWFuYWdlcigpO1xuXG4gICAgY29uc3Qgc2Vzc2lvbklkID0gYXdhaXQgbWFuYWdlci5zdGFydFNlc3Npb24oeyBwcm9qZWN0RGlyOiAnL3RtcC9jYW5jZWwtdGVzdCcgfSk7XG4gICAgY29uc3Qgc2Vzc2lvbiA9IG1hbmFnZXIuZ2V0U2Vzc2lvbihzZXNzaW9uSWQpITtcbiAgICBjb25zdCBjbGllbnQgPSBtYW5hZ2VyLmxhc3RDbGllbnQhO1xuXG4gICAgYXdhaXQgbWFuYWdlci5jYW5jZWxTZXNzaW9uKHNlc3Npb25JZCk7XG5cbiAgICBhc3NlcnQuZXF1YWwoc2Vzc2lvbi5zdGF0dXMsICdjYW5jZWxsZWQnKTtcbiAgICBhc3NlcnQub2soY2xpZW50LmFib3J0ZWQpO1xuICAgIGFzc2VydC5vayhjbGllbnQuc3RvcHBlZCk7XG5cbiAgICBjb25zdCBjYW5jZWxMb2dzID0gc3B5LmZpbmRDYWxscygnaW5mbycsICdzZXNzaW9uIGNhbmNlbGxlZCcpO1xuICAgIGFzc2VydC5lcXVhbChjYW5jZWxMb2dzLmxlbmd0aCwgMSk7XG4gIH0pO1xuXG4gIC8vIC0tLS0gQ29zdCBhY2N1bXVsYXRpb24gKEswMDQgY3VtdWxhdGl2ZS1tYXgpIC0tLS1cblxuICBpdCgnYWNjdW11bGF0ZXMgY29zdCB1c2luZyBjdW11bGF0aXZlLW1heCBwYXR0ZXJuIChLMDA0KScsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB7IG1hbmFnZXIgfSA9IGNyZWF0ZU1hbmFnZXIoKTtcblxuICAgIGNvbnN0IHNlc3Npb25JZCA9IGF3YWl0IG1hbmFnZXIuc3RhcnRTZXNzaW9uKHsgcHJvamVjdERpcjogJy90bXAvY29zdC10ZXN0JyB9KTtcbiAgICBjb25zdCBzZXNzaW9uID0gbWFuYWdlci5nZXRTZXNzaW9uKHNlc3Npb25JZCkhO1xuICAgIGNvbnN0IGNsaWVudCA9IG1hbmFnZXIubGFzdENsaWVudCE7XG5cbiAgICAvLyBGaXJzdCBjb3N0IHVwZGF0ZVxuICAgIGNsaWVudC5lbWl0RXZlbnQoe1xuICAgICAgdHlwZTogJ2Nvc3RfdXBkYXRlJyxcbiAgICAgIHJ1bklkOiAncnVuLTEnLFxuICAgICAgdHVybkNvc3Q6IDAuMDEsXG4gICAgICBjdW11bGF0aXZlQ29zdDogMC4wMSxcbiAgICAgIHRva2VuczogeyBpbnB1dDogMTAwLCBvdXRwdXQ6IDUwLCBjYWNoZVJlYWQ6IDIwLCBjYWNoZVdyaXRlOiAxMCB9LFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHNlc3Npb24uY29zdC50b3RhbENvc3QsIDAuMDEpO1xuICAgIGFzc2VydC5lcXVhbChzZXNzaW9uLmNvc3QudG9rZW5zLmlucHV0LCAxMDApO1xuXG4gICAgLy8gU2Vjb25kIGNvc3QgdXBkYXRlIFx1MjAxNCBjdW11bGF0aXZlIHZhbHVlcyBzaG91bGQgaW5jcmVhc2VcbiAgICBjbGllbnQuZW1pdEV2ZW50KHtcbiAgICAgIHR5cGU6ICdjb3N0X3VwZGF0ZScsXG4gICAgICBydW5JZDogJ3J1bi0xJyxcbiAgICAgIHR1cm5Db3N0OiAwLjAyLFxuICAgICAgY3VtdWxhdGl2ZUNvc3Q6IDAuMDMsXG4gICAgICB0b2tlbnM6IHsgaW5wdXQ6IDI1MCwgb3V0cHV0OiAxMjAsIGNhY2hlUmVhZDogNDAsIGNhY2hlV3JpdGU6IDIwIH0sXG4gICAgfSk7XG5cbiAgICBhc3NlcnQuZXF1YWwoc2Vzc2lvbi5jb3N0LnRvdGFsQ29zdCwgMC4wMyk7XG4gICAgYXNzZXJ0LmVxdWFsKHNlc3Npb24uY29zdC50b2tlbnMuaW5wdXQsIDI1MCk7XG4gICAgYXNzZXJ0LmVxdWFsKHNlc3Npb24uY29zdC50b2tlbnMub3V0cHV0LCAxMjApO1xuXG4gICAgLy8gVGhpcmQgdXBkYXRlIHdpdGggbG93ZXIgdmFsdWVzIFx1MjAxNCBtYXggc2hvdWxkIGhvbGRcbiAgICBjbGllbnQuZW1pdEV2ZW50KHtcbiAgICAgIHR5cGU6ICdjb3N0X3VwZGF0ZScsXG4gICAgICBydW5JZDogJ3J1bi0yJyxcbiAgICAgIHR1cm5Db3N0OiAwLjAwNSxcbiAgICAgIGN1bXVsYXRpdmVDb3N0OiAwLjAyLCAvLyBsb3dlciB0aGFuIDAuMDMgXHUyMDE0IHNob3VsZCBOT1QgcmVwbGFjZVxuICAgICAgdG9rZW5zOiB7IGlucHV0OiA1MCwgb3V0cHV0OiAzMCwgY2FjaGVSZWFkOiA1LCBjYWNoZVdyaXRlOiAyIH0sXG4gICAgfSk7XG5cbiAgICBhc3NlcnQuZXF1YWwoc2Vzc2lvbi5jb3N0LnRvdGFsQ29zdCwgMC4wMyk7IC8vIG1heCBoZWxkXG4gICAgYXNzZXJ0LmVxdWFsKHNlc3Npb24uY29zdC50b2tlbnMuaW5wdXQsIDI1MCk7IC8vIG1heCBoZWxkXG4gIH0pO1xuXG4gIC8vIC0tLS0gUmluZyBidWZmZXIgZXZlbnQgdHJpbW1pbmcgLS0tLVxuXG4gIGl0KCd0cmltcyBldmVudHMgd2hlbiBleGNlZWRpbmcgTUFYX0VWRU5UUycsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB7IG1hbmFnZXIgfSA9IGNyZWF0ZU1hbmFnZXIoKTtcblxuICAgIGNvbnN0IHNlc3Npb25JZCA9IGF3YWl0IG1hbmFnZXIuc3RhcnRTZXNzaW9uKHsgcHJvamVjdERpcjogJy90bXAvcmluZ2J1Zi10ZXN0JyB9KTtcbiAgICBjb25zdCBzZXNzaW9uID0gbWFuYWdlci5nZXRTZXNzaW9uKHNlc3Npb25JZCkhO1xuICAgIGNvbnN0IGNsaWVudCA9IG1hbmFnZXIubGFzdENsaWVudCE7XG5cbiAgICAvLyBQdXNoIE1BWF9FVkVOVFMgKyAyMCBldmVudHNcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IE1BWF9FVkVOVFMgKyAyMDsgaSsrKSB7XG4gICAgICBjbGllbnQuZW1pdEV2ZW50KHtcbiAgICAgICAgdHlwZTogJ2Fzc2lzdGFudF9tZXNzYWdlJyxcbiAgICAgICAgaWQ6IGBtc2ctJHtpfWAsXG4gICAgICAgIGNvbnRlbnQ6IGBFdmVudCAke2l9YCxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGFzc2VydC5lcXVhbChzZXNzaW9uLmV2ZW50cy5sZW5ndGgsIE1BWF9FVkVOVFMpO1xuICAgIC8vIE9sZGVzdCBldmVudHMgc2hvdWxkIGJlIHRyaW1tZWQgXHUyMDE0IGZpcnN0IGV2ZW50IHNob3VsZCBiZSAjMjBcbiAgICBjb25zdCBmaXJzdEV2ZW50ID0gc2Vzc2lvbi5ldmVudHNbMF0gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgYXNzZXJ0LmVxdWFsKGZpcnN0RXZlbnQuaWQsICdtc2ctMjAnKTtcbiAgfSk7XG5cbiAgLy8gLS0tLSBCbG9ja2VyIGRldGVjdGlvbiAobm9uLWZpcmUtYW5kLWZvcmdldCBleHRlbnNpb25fdWlfcmVxdWVzdCkgLS0tLVxuXG4gIGl0KCdkZXRlY3RzIGJsb2NrZXIgZnJvbSBub24tZmlyZS1hbmQtZm9yZ2V0IGV4dGVuc2lvbl91aV9yZXF1ZXN0JywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHsgbWFuYWdlciwgc3B5IH0gPSBjcmVhdGVNYW5hZ2VyKCk7XG5cbiAgICBjb25zdCBzZXNzaW9uSWQgPSBhd2FpdCBtYW5hZ2VyLnN0YXJ0U2Vzc2lvbih7IHByb2plY3REaXI6ICcvdG1wL2Jsb2NrZXItdGVzdCcgfSk7XG4gICAgY29uc3Qgc2Vzc2lvbiA9IG1hbmFnZXIuZ2V0U2Vzc2lvbihzZXNzaW9uSWQpITtcblxuICAgIG1hbmFnZXIubGFzdENsaWVudCEuZW1pdEV2ZW50KHtcbiAgICAgIHR5cGU6ICdleHRlbnNpb25fdWlfcmVxdWVzdCcsXG4gICAgICBpZDogJ3NlbC0xJyxcbiAgICAgIG1ldGhvZDogJ3NlbGVjdCcsXG4gICAgICB0aXRsZTogJ0Nob29zZSBkZXBsb3ltZW50IHRhcmdldCcsXG4gICAgICBvcHRpb25zOiBbJ3N0YWdpbmcnLCAncHJvZHVjdGlvbiddLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHNlc3Npb24uc3RhdHVzLCAnYmxvY2tlZCcpO1xuICAgIGFzc2VydC5vayhzZXNzaW9uLnBlbmRpbmdCbG9ja2VyKTtcbiAgICBhc3NlcnQuZXF1YWwoc2Vzc2lvbi5wZW5kaW5nQmxvY2tlciEubWV0aG9kLCAnc2VsZWN0Jyk7XG5cbiAgICBjb25zdCBibG9ja2VkTG9ncyA9IHNweS5maW5kQ2FsbHMoJ2luZm8nLCAnc2Vzc2lvbiBibG9ja2VkJyk7XG4gICAgYXNzZXJ0LmVxdWFsKGJsb2NrZWRMb2dzLmxlbmd0aCwgMSk7XG4gIH0pO1xuXG4gIC8vIC0tLS0gRmlyZS1hbmQtZm9yZ2V0IG1ldGhvZHMgZG8gTk9UIGJsb2NrIC0tLS1cblxuICBpdCgnZmlyZS1hbmQtZm9yZ2V0IG1ldGhvZHMgZG8gbm90IHRyaWdnZXIgYmxvY2tlcicsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB7IG1hbmFnZXIgfSA9IGNyZWF0ZU1hbmFnZXIoKTtcblxuICAgIGNvbnN0IHNlc3Npb25JZCA9IGF3YWl0IG1hbmFnZXIuc3RhcnRTZXNzaW9uKHsgcHJvamVjdERpcjogJy90bXAvZmFmLXRlc3QnIH0pO1xuICAgIGNvbnN0IHNlc3Npb24gPSBtYW5hZ2VyLmdldFNlc3Npb24oc2Vzc2lvbklkKSE7XG5cbiAgICAvLyBzZXRTdGF0dXMgaXMgZmlyZS1hbmQtZm9yZ2V0XG4gICAgbWFuYWdlci5sYXN0Q2xpZW50IS5lbWl0RXZlbnQoe1xuICAgICAgdHlwZTogJ2V4dGVuc2lvbl91aV9yZXF1ZXN0JyxcbiAgICAgIGlkOiAnc3QtMScsXG4gICAgICBtZXRob2Q6ICdzZXRTdGF0dXMnLFxuICAgICAgc3RhdHVzS2V5OiAnYnVpbGQnLFxuICAgICAgc3RhdHVzVGV4dDogJ0J1aWxkaW5nLi4uJyxcbiAgICB9KTtcblxuICAgIGFzc2VydC5lcXVhbChzZXNzaW9uLnN0YXR1cywgJ3J1bm5pbmcnKTtcbiAgICBhc3NlcnQuZXF1YWwoc2Vzc2lvbi5wZW5kaW5nQmxvY2tlciwgbnVsbCk7XG4gIH0pO1xuXG4gIC8vIC0tLS0gVGVybWluYWwgZGV0ZWN0aW9uIChhdXRvLW1vZGUgc3RvcHBlZCBub3RpZmljYXRpb24pIC0tLS1cblxuICBpdCgnZGV0ZWN0cyB0ZXJtaW5hbCBmcm9tIGF1dG8tbW9kZSBzdG9wcGVkIG5vdGlmaWNhdGlvbicsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB7IG1hbmFnZXIgfSA9IGNyZWF0ZU1hbmFnZXIoKTtcblxuICAgIGNvbnN0IHNlc3Npb25JZCA9IGF3YWl0IG1hbmFnZXIuc3RhcnRTZXNzaW9uKHsgcHJvamVjdERpcjogJy90bXAvdGVybWluYWwtdGVzdCcgfSk7XG4gICAgY29uc3Qgc2Vzc2lvbiA9IG1hbmFnZXIuZ2V0U2Vzc2lvbihzZXNzaW9uSWQpITtcblxuICAgIG1hbmFnZXIubGFzdENsaWVudCEuZW1pdEV2ZW50KHtcbiAgICAgIHR5cGU6ICdleHRlbnNpb25fdWlfcmVxdWVzdCcsXG4gICAgICBpZDogJ24xJyxcbiAgICAgIG1ldGhvZDogJ25vdGlmeScsXG4gICAgICBtZXNzYWdlOiAnU3RlcC1tb2RlIHN0b3BwZWQ6IHVzZXIgcmVxdWVzdGVkJyxcbiAgICB9KTtcblxuICAgIGFzc2VydC5lcXVhbChzZXNzaW9uLnN0YXR1cywgJ2NvbXBsZXRlZCcpO1xuICB9KTtcblxuICAvLyAtLS0tIGdldEFsbFNlc3Npb25zIHJldHVybnMgYWxsIHRyYWNrZWQgc2Vzc2lvbnMgLS0tLVxuXG4gIGl0KCdnZXRBbGxTZXNzaW9ucyByZXR1cm5zIGFsbCB0cmFja2VkIHNlc3Npb25zJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHsgbWFuYWdlciB9ID0gY3JlYXRlTWFuYWdlcigpO1xuXG4gICAgYXdhaXQgbWFuYWdlci5zdGFydFNlc3Npb24oeyBwcm9qZWN0RGlyOiAnL3RtcC9wcm9qLWEnIH0pO1xuICAgIGF3YWl0IG1hbmFnZXIuc3RhcnRTZXNzaW9uKHsgcHJvamVjdERpcjogJy90bXAvcHJvai1iJyB9KTtcbiAgICBhd2FpdCBtYW5hZ2VyLnN0YXJ0U2Vzc2lvbih7IHByb2plY3REaXI6ICcvdG1wL3Byb2otYycgfSk7XG5cbiAgICBjb25zdCBhbGwgPSBtYW5hZ2VyLmdldEFsbFNlc3Npb25zKCk7XG4gICAgYXNzZXJ0LmVxdWFsKGFsbC5sZW5ndGgsIDMpO1xuXG4gICAgY29uc3QgZGlycyA9IGFsbC5tYXAocyA9PiBzLnByb2plY3REaXIpLnNvcnQoKTtcbiAgICBhc3NlcnQub2soZGlyc1swXS5lbmRzV2l0aCgncHJvai1hJykpO1xuICAgIGFzc2VydC5vayhkaXJzWzFdLmVuZHNXaXRoKCdwcm9qLWInKSk7XG4gICAgYXNzZXJ0Lm9rKGRpcnNbMl0uZW5kc1dpdGgoJ3Byb2otYycpKTtcbiAgfSk7XG5cbiAgLy8gLS0tLSBjbGVhbnVwIHN0b3BzIGFsbCBhY3RpdmUgc2Vzc2lvbnMgLS0tLVxuXG4gIGl0KCdjbGVhbnVwIHN0b3BzIGFsbCBhY3RpdmUgc2Vzc2lvbnMnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyBtYW5hZ2VyIH0gPSBjcmVhdGVNYW5hZ2VyKCk7XG5cbiAgICBhd2FpdCBtYW5hZ2VyLnN0YXJ0U2Vzc2lvbih7IHByb2plY3REaXI6ICcvdG1wL2NsZWFudXAtYScgfSk7XG4gICAgYXdhaXQgbWFuYWdlci5zdGFydFNlc3Npb24oeyBwcm9qZWN0RGlyOiAnL3RtcC9jbGVhbnVwLWInIH0pO1xuXG4gICAgY29uc3QgY2xpZW50cyA9IFsuLi5tYW5hZ2VyLmFsbENsaWVudHNdO1xuICAgIGFzc2VydC5lcXVhbChjbGllbnRzLmxlbmd0aCwgMik7XG5cbiAgICBhd2FpdCBtYW5hZ2VyLmNsZWFudXAoKTtcblxuICAgIGNvbnN0IGFsbCA9IG1hbmFnZXIuZ2V0QWxsU2Vzc2lvbnMoKTtcbiAgICBmb3IgKGNvbnN0IHMgb2YgYWxsKSB7XG4gICAgICBhc3NlcnQuZXF1YWwocy5zdGF0dXMsICdjYW5jZWxsZWQnKTtcbiAgICB9XG4gICAgLy8gQm90aCBjbGllbnRzIHNob3VsZCBoYXZlIGJlZW4gc3RvcHBlZFxuICAgIGZvciAoY29uc3QgYyBvZiBjbGllbnRzKSB7XG4gICAgICBhc3NlcnQub2soYy5zdG9wcGVkKTtcbiAgICB9XG4gIH0pO1xuXG4gIC8vIC0tLS0gRXZlbnRFbWl0dGVyOiBzZXNzaW9uOnN0YXJ0ZWQgLS0tLVxuXG4gIGl0KCdlbWl0cyBzZXNzaW9uOnN0YXJ0ZWQgZXZlbnQnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyBtYW5hZ2VyIH0gPSBjcmVhdGVNYW5hZ2VyKCk7XG5cbiAgICBsZXQgZW1pdHRlZERhdGE6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkO1xuICAgIG1hbmFnZXIub24oJ3Nlc3Npb246c3RhcnRlZCcsIChkYXRhOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4geyBlbWl0dGVkRGF0YSA9IGRhdGE7IH0pO1xuXG4gICAgY29uc3Qgc2Vzc2lvbklkID0gYXdhaXQgbWFuYWdlci5zdGFydFNlc3Npb24oeyBwcm9qZWN0RGlyOiAnL3RtcC9lbWl0LXN0YXJ0JyB9KTtcblxuICAgIGFzc2VydC5vayhlbWl0dGVkRGF0YSk7XG4gICAgYXNzZXJ0LmVxdWFsKGVtaXR0ZWREYXRhLnNlc3Npb25JZCwgc2Vzc2lvbklkKTtcbiAgICBhc3NlcnQuZXF1YWwoZW1pdHRlZERhdGEucHJvamVjdE5hbWUsICdlbWl0LXN0YXJ0Jyk7XG4gIH0pO1xuXG4gIC8vIC0tLS0gRXZlbnRFbWl0dGVyOiBzZXNzaW9uOmJsb2NrZWQgLS0tLVxuXG4gIGl0KCdlbWl0cyBzZXNzaW9uOmJsb2NrZWQgZXZlbnQnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyBtYW5hZ2VyIH0gPSBjcmVhdGVNYW5hZ2VyKCk7XG5cbiAgICBsZXQgZW1pdHRlZERhdGE6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkO1xuICAgIG1hbmFnZXIub24oJ3Nlc3Npb246YmxvY2tlZCcsIChkYXRhOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4geyBlbWl0dGVkRGF0YSA9IGRhdGE7IH0pO1xuXG4gICAgYXdhaXQgbWFuYWdlci5zdGFydFNlc3Npb24oeyBwcm9qZWN0RGlyOiAnL3RtcC9lbWl0LWJsb2NrZWQnIH0pO1xuXG4gICAgbWFuYWdlci5sYXN0Q2xpZW50IS5lbWl0RXZlbnQoe1xuICAgICAgdHlwZTogJ2V4dGVuc2lvbl91aV9yZXF1ZXN0JyxcbiAgICAgIGlkOiAnYi0xJyxcbiAgICAgIG1ldGhvZDogJ2lucHV0JyxcbiAgICAgIHRpdGxlOiAnRW50ZXIgQVBJIGtleScsXG4gICAgfSk7XG5cbiAgICBhc3NlcnQub2soZW1pdHRlZERhdGEpO1xuICAgIGFzc2VydC5lcXVhbCgoZW1pdHRlZERhdGEuYmxvY2tlciBhcyBQZW5kaW5nQmxvY2tlcikuaWQsICdiLTEnKTtcbiAgfSk7XG5cbiAgLy8gLS0tLSBFdmVudEVtaXR0ZXI6IHNlc3Npb246Y29tcGxldGVkIC0tLS1cblxuICBpdCgnZW1pdHMgc2Vzc2lvbjpjb21wbGV0ZWQgZXZlbnQnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyBtYW5hZ2VyIH0gPSBjcmVhdGVNYW5hZ2VyKCk7XG5cbiAgICBsZXQgZW1pdHRlZERhdGE6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkO1xuICAgIG1hbmFnZXIub24oJ3Nlc3Npb246Y29tcGxldGVkJywgKGRhdGE6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB7IGVtaXR0ZWREYXRhID0gZGF0YTsgfSk7XG5cbiAgICBhd2FpdCBtYW5hZ2VyLnN0YXJ0U2Vzc2lvbih7IHByb2plY3REaXI6ICcvdG1wL2VtaXQtY29tcGxldGVkJyB9KTtcblxuICAgIG1hbmFnZXIubGFzdENsaWVudCEuZW1pdEV2ZW50KHtcbiAgICAgIHR5cGU6ICdleHRlbnNpb25fdWlfcmVxdWVzdCcsXG4gICAgICBpZDogJ24xJyxcbiAgICAgIG1ldGhvZDogJ25vdGlmeScsXG4gICAgICBtZXNzYWdlOiAnQXV0by1tb2RlIHN0b3BwZWQ6IHN1Y2Nlc3MnLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0Lm9rKGVtaXR0ZWREYXRhKTtcbiAgICBhc3NlcnQuZXF1YWwoZW1pdHRlZERhdGEucHJvamVjdE5hbWUsICdlbWl0LWNvbXBsZXRlZCcpO1xuICB9KTtcblxuICAvLyAtLS0tIEV2ZW50RW1pdHRlcjogc2Vzc2lvbjplcnJvciAtLS0tXG5cbiAgaXQoJ2VtaXRzIHNlc3Npb246ZXJyb3IgZXZlbnQgb24gaW5pdCBmYWlsdXJlJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHsgbWFuYWdlciB9ID0gY3JlYXRlTWFuYWdlcigpO1xuXG4gICAgbGV0IGVtaXR0ZWREYXRhOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZDtcbiAgICBtYW5hZ2VyLm9uKCdzZXNzaW9uOmVycm9yJywgKGRhdGE6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB7IGVtaXR0ZWREYXRhID0gZGF0YTsgfSk7XG5cbiAgICBtYW5hZ2VyLm5leHRJbml0RXJyb3IgPSBuZXcgRXJyb3IoJ1Byb2Nlc3MgY3Jhc2hlZCcpO1xuXG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IG1hbmFnZXIuc3RhcnRTZXNzaW9uKHsgcHJvamVjdERpcjogJy90bXAvZW1pdC1lcnJvcicgfSk7XG4gICAgfSBjYXRjaCB7IC8qIGV4cGVjdGVkICovIH1cblxuICAgIGFzc2VydC5vayhlbWl0dGVkRGF0YSk7XG4gICAgYXNzZXJ0Lm9rKChlbWl0dGVkRGF0YS5lcnJvciBhcyBzdHJpbmcpLmluY2x1ZGVzKCdQcm9jZXNzIGNyYXNoZWQnKSk7XG4gIH0pO1xuXG4gIC8vIC0tLS0gRXZlbnRFbWl0dGVyOiBzZXNzaW9uOmV2ZW50IC0tLS1cblxuICBpdCgnZW1pdHMgc2Vzc2lvbjpldmVudCBmb3IgZXZlcnkgZm9yd2FyZGVkIGV2ZW50JywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHsgbWFuYWdlciB9ID0gY3JlYXRlTWFuYWdlcigpO1xuXG4gICAgY29uc3QgZXZlbnRzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPltdID0gW107XG4gICAgbWFuYWdlci5vbignc2Vzc2lvbjpldmVudCcsIChkYXRhKSA9PiB7IGV2ZW50cy5wdXNoKGRhdGEpOyB9KTtcblxuICAgIGF3YWl0IG1hbmFnZXIuc3RhcnRTZXNzaW9uKHsgcHJvamVjdERpcjogJy90bXAvZW1pdC1ldmVudCcgfSk7XG5cbiAgICBtYW5hZ2VyLmxhc3RDbGllbnQhLmVtaXRFdmVudCh7IHR5cGU6ICdhc3Npc3RhbnRfbWVzc2FnZScsIGlkOiAnYTEnLCBjb250ZW50OiAnSGVsbG8nIH0pO1xuICAgIG1hbmFnZXIubGFzdENsaWVudCEuZW1pdEV2ZW50KHsgdHlwZTogJ3Rvb2xfdXNlJywgaWQ6ICd0MScsIG5hbWU6ICdyZWFkJyB9KTtcblxuICAgIGFzc2VydC5lcXVhbChldmVudHMubGVuZ3RoLCAyKTtcbiAgfSk7XG5cbiAgLy8gLS0tLSBFbXB0eSBwcm9qZWN0RGlyIHJlamVjdGlvbiAtLS0tXG5cbiAgaXQoJ3JlamVjdHMgZW1wdHkgcHJvamVjdERpcicsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB7IG1hbmFnZXIgfSA9IGNyZWF0ZU1hbmFnZXIoKTtcblxuICAgIGF3YWl0IGFzc2VydC5yZWplY3RzKFxuICAgICAgKCkgPT4gbWFuYWdlci5zdGFydFNlc3Npb24oeyBwcm9qZWN0RGlyOiAnJyB9KSxcbiAgICAgIChlcnI6IEVycm9yKSA9PiB7XG4gICAgICAgIGFzc2VydC5vayhlcnIubWVzc2FnZS5pbmNsdWRlcygncHJvamVjdERpciBpcyByZXF1aXJlZCcpKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9XG4gICAgKTtcblxuICAgIGF3YWl0IGFzc2VydC5yZWplY3RzKFxuICAgICAgKCkgPT4gbWFuYWdlci5zdGFydFNlc3Npb24oeyBwcm9qZWN0RGlyOiAnICAgJyB9KSxcbiAgICAgIChlcnI6IEVycm9yKSA9PiB7XG4gICAgICAgIGFzc2VydC5vayhlcnIubWVzc2FnZS5pbmNsdWRlcygncHJvamVjdERpciBpcyByZXF1aXJlZCcpKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9XG4gICAgKTtcbiAgfSk7XG5cbiAgLy8gLS0tLSBMb2dnZXIgcmVjZWl2ZXMgc3RydWN0dXJlZCBjYWxscyAtLS0tXG5cbiAgaXQoJ2xvZ2dlciByZWNlaXZlcyBzdHJ1Y3R1cmVkIGNhbGxzIGR1cmluZyBsaWZlY3ljbGUnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyBtYW5hZ2VyLCBzcHkgfSA9IGNyZWF0ZU1hbmFnZXIoKTtcblxuICAgIGNvbnN0IHNlc3Npb25JZCA9IGF3YWl0IG1hbmFnZXIuc3RhcnRTZXNzaW9uKHsgcHJvamVjdERpcjogJy90bXAvbG9nLXRlc3QnIH0pO1xuXG4gICAgLy8gU2hvdWxkIGhhdmUgJ3Nlc3Npb24gc3RhcnRlZCcgaW5mbyBsb2dcbiAgICBjb25zdCBzdGFydGVkID0gc3B5LmZpbmRDYWxscygnaW5mbycsICdzZXNzaW9uIHN0YXJ0ZWQnKTtcbiAgICBhc3NlcnQuZXF1YWwoc3RhcnRlZC5sZW5ndGgsIDEpO1xuICAgIGFzc2VydC5vayhzdGFydGVkWzBdLmRhdGE/LnNlc3Npb25JZCk7XG4gICAgYXNzZXJ0Lm9rKHN0YXJ0ZWRbMF0uZGF0YT8ucHJvamVjdERpcik7XG5cbiAgICAvLyBFbWl0IGFuIGV2ZW50IFx1MjAxNCBzaG91bGQgcHJvZHVjZSBkZWJ1ZyBsb2dcbiAgICBtYW5hZ2VyLmxhc3RDbGllbnQhLmVtaXRFdmVudCh7IHR5cGU6ICdhc3Npc3RhbnRfbWVzc2FnZScsIGlkOiAnYTEnLCBjb250ZW50OiAnaGknIH0pO1xuICAgIGNvbnN0IGRlYnVnTG9ncyA9IHNweS5maW5kQ2FsbHMoJ2RlYnVnJywgJ3Nlc3Npb24gZXZlbnQnKTtcbiAgICBhc3NlcnQub2soZGVidWdMb2dzLmxlbmd0aCA+PSAxKTtcbiAgICBhc3NlcnQub2soZGVidWdMb2dzWzBdLmRhdGE/LnR5cGUpO1xuICB9KTtcblxuICAvLyAtLS0tIGdldFJlc3VsdCByZXR1cm5zIHN0cnVjdHVyZWQgc3RhdHVzIC0tLS1cblxuICBpdCgnZ2V0UmVzdWx0IHJldHVybnMgc3RydWN0dXJlZCBzdGF0dXMnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyBtYW5hZ2VyIH0gPSBjcmVhdGVNYW5hZ2VyKCk7XG5cbiAgICBjb25zdCBzZXNzaW9uSWQgPSBhd2FpdCBtYW5hZ2VyLnN0YXJ0U2Vzc2lvbih7IHByb2plY3REaXI6ICcvdG1wL3Jlc3VsdC10ZXN0JyB9KTtcbiAgICBjb25zdCByZXN1bHQgPSBtYW5hZ2VyLmdldFJlc3VsdChzZXNzaW9uSWQpO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uSWQsIHNlc3Npb25JZCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zdGF0dXMsICdydW5uaW5nJyk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5wcm9qZWN0TmFtZSwgJ3Jlc3VsdC10ZXN0Jyk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5lcnJvciwgbnVsbCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5wZW5kaW5nQmxvY2tlciwgbnVsbCk7XG4gICAgYXNzZXJ0Lm9rKHR5cGVvZiByZXN1bHQuZHVyYXRpb25NcyA9PT0gJ251bWJlcicpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuY29zdCk7XG4gICAgYXNzZXJ0Lm9rKEFycmF5LmlzQXJyYXkocmVzdWx0LnJlY2VudEV2ZW50cykpO1xuICB9KTtcblxuICAvLyAtLS0tIGdldFJlc3VsdCB0aHJvd3MgZm9yIHVua25vd24gc2Vzc2lvbiAtLS0tXG5cbiAgaXQoJ2dldFJlc3VsdCB0aHJvd3MgZm9yIHVua25vd24gc2Vzc2lvbklkJywgKCkgPT4ge1xuICAgIGNvbnN0IHsgbWFuYWdlciB9ID0gY3JlYXRlTWFuYWdlcigpO1xuXG4gICAgYXNzZXJ0LnRocm93cyhcbiAgICAgICgpID0+IG1hbmFnZXIuZ2V0UmVzdWx0KCdub25leGlzdGVudCcpLFxuICAgICAgKGVycjogRXJyb3IpID0+IGVyci5tZXNzYWdlLmluY2x1ZGVzKCdTZXNzaW9uIG5vdCBmb3VuZCcpXG4gICAgKTtcbiAgfSk7XG5cbiAgLy8gLS0tLSByZXNvbHZlQmxvY2tlciB0aHJvd3Mgd2hlbiBubyBibG9ja2VyIHBlbmRpbmcgLS0tLVxuXG4gIGl0KCdyZXNvbHZlQmxvY2tlciB0aHJvd3Mgd2hlbiBubyBibG9ja2VyIHBlbmRpbmcnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyBtYW5hZ2VyIH0gPSBjcmVhdGVNYW5hZ2VyKCk7XG5cbiAgICBjb25zdCBzZXNzaW9uSWQgPSBhd2FpdCBtYW5hZ2VyLnN0YXJ0U2Vzc2lvbih7IHByb2plY3REaXI6ICcvdG1wL25vLWJsb2NrZXInIH0pO1xuXG4gICAgYXdhaXQgYXNzZXJ0LnJlamVjdHMoXG4gICAgICAoKSA9PiBtYW5hZ2VyLnJlc29sdmVCbG9ja2VyKHNlc3Npb25JZCwgJ3llcycpLFxuICAgICAgKGVycjogRXJyb3IpID0+IGVyci5tZXNzYWdlLmluY2x1ZGVzKCdObyBwZW5kaW5nIGJsb2NrZXInKVxuICAgICk7XG4gIH0pO1xuXG4gIC8vIC0tLS0gY2FuY2VsU2Vzc2lvbiB0aHJvd3MgZm9yIHVua25vd24gc2Vzc2lvbiAtLS0tXG5cbiAgaXQoJ2NhbmNlbFNlc3Npb24gdGhyb3dzIGZvciB1bmtub3duIHNlc3Npb25JZCcsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB7IG1hbmFnZXIgfSA9IGNyZWF0ZU1hbmFnZXIoKTtcblxuICAgIGF3YWl0IGFzc2VydC5yZWplY3RzKFxuICAgICAgKCkgPT4gbWFuYWdlci5jYW5jZWxTZXNzaW9uKCdub25leGlzdGVudCcpLFxuICAgICAgKGVycjogRXJyb3IpID0+IGVyci5tZXNzYWdlLmluY2x1ZGVzKCdTZXNzaW9uIG5vdCBmb3VuZCcpXG4gICAgKTtcbiAgfSk7XG5cbiAgLy8gLS0tLSBCbG9ja2VkIG5vdGlmaWNhdGlvbiBkZXRlY3RlZCBhcyBibG9ja2VyLCBub3QgdGVybWluYWwgLS0tLVxuXG4gIGl0KCdibG9ja2VkIG5vdGlmaWNhdGlvbiBzZXRzIHN0YXR1cyB0byBibG9ja2VkLCBub3QgY29tcGxldGVkJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHsgbWFuYWdlciB9ID0gY3JlYXRlTWFuYWdlcigpO1xuXG4gICAgY29uc3Qgc2Vzc2lvbklkID0gYXdhaXQgbWFuYWdlci5zdGFydFNlc3Npb24oeyBwcm9qZWN0RGlyOiAnL3RtcC9ibG9ja2VkLW5vdGlmeScgfSk7XG4gICAgY29uc3Qgc2Vzc2lvbiA9IG1hbmFnZXIuZ2V0U2Vzc2lvbihzZXNzaW9uSWQpITtcblxuICAgIG1hbmFnZXIubGFzdENsaWVudCEuZW1pdEV2ZW50KHtcbiAgICAgIHR5cGU6ICdleHRlbnNpb25fdWlfcmVxdWVzdCcsXG4gICAgICBpZDogJ2JuLTEnLFxuICAgICAgbWV0aG9kOiAnbm90aWZ5JyxcbiAgICAgIG1lc3NhZ2U6ICdBdXRvLW1vZGUgc3RvcHBlZDogQmxvY2tlZDogd2FpdGluZyBmb3IgYXBwcm92YWwnLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHNlc3Npb24uc3RhdHVzLCAnYmxvY2tlZCcpO1xuICAgIGFzc2VydC5vayhzZXNzaW9uLnBlbmRpbmdCbG9ja2VyKTtcbiAgfSk7XG5cbiAgLy8gLS0tLSBwcm9qZWN0TmFtZSBpcyBiYXNlbmFtZSBvZiByZXNvbHZlZCBwcm9qZWN0RGlyIC0tLS1cblxuICBpdCgncHJvamVjdE5hbWUgaXMgYmFzZW5hbWUgb2YgcHJvamVjdERpcicsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB7IG1hbmFnZXIgfSA9IGNyZWF0ZU1hbmFnZXIoKTtcblxuICAgIGNvbnN0IHNlc3Npb25JZCA9IGF3YWl0IG1hbmFnZXIuc3RhcnRTZXNzaW9uKHsgcHJvamVjdERpcjogJy9ob21lL3VzZXIvcHJvamVjdHMvbXktYXBwJyB9KTtcbiAgICBjb25zdCBzZXNzaW9uID0gbWFuYWdlci5nZXRTZXNzaW9uKHNlc3Npb25JZCkhO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHNlc3Npb24ucHJvamVjdE5hbWUsICdteS1hcHAnKTtcbiAgfSk7XG5cbiAgLy8gLS0tLSBDdXN0b20gY29tbWFuZCBpcyBzZW50IGluc3RlYWQgb2YgZGVmYXVsdCAtLS0tXG5cbiAgaXQoJ3NlbmRzIGN1c3RvbSBjb21tYW5kIHdoZW4gcHJvdmlkZWQnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyBtYW5hZ2VyIH0gPSBjcmVhdGVNYW5hZ2VyKCk7XG5cbiAgICBhd2FpdCBtYW5hZ2VyLnN0YXJ0U2Vzc2lvbih7IHByb2plY3REaXI6ICcvdG1wL2N1c3RvbS1jbWQnLCBjb21tYW5kOiAnL2dzZCBxdWljayBmaXgtdHlwbycgfSk7XG4gICAgY29uc3QgY2xpZW50ID0gbWFuYWdlci5sYXN0Q2xpZW50ITtcblxuICAgIGFzc2VydC5vayhjbGllbnQucHJvbXB0ZWQuaW5jbHVkZXMoJy9nc2QgcXVpY2sgZml4LXR5cG8nKSk7XG4gICAgYXNzZXJ0Lm9rKCFjbGllbnQucHJvbXB0ZWQuaW5jbHVkZXMoJy9nc2QgYXV0bycpKTtcbiAgfSk7XG5cbiAgLy8gLS0tLSBnZXRTZXNzaW9uQnlEaXIgcmV0dXJucyBzZXNzaW9uIGJ5IGRpcmVjdG9yeSBsb29rdXAgLS0tLVxuXG4gIGl0KCdnZXRTZXNzaW9uQnlEaXIgcmV0dXJucyBzZXNzaW9uIGJ5IGRpcmVjdG9yeScsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB7IG1hbmFnZXIgfSA9IGNyZWF0ZU1hbmFnZXIoKTtcblxuICAgIGF3YWl0IG1hbmFnZXIuc3RhcnRTZXNzaW9uKHsgcHJvamVjdERpcjogJy90bXAvZGlyLWxvb2t1cCcgfSk7XG4gICAgY29uc3Qgc2Vzc2lvbiA9IG1hbmFnZXIuZ2V0U2Vzc2lvbkJ5RGlyKCcvdG1wL2Rpci1sb29rdXAnKTtcblxuICAgIGFzc2VydC5vayhzZXNzaW9uKTtcbiAgICBhc3NlcnQuZXF1YWwoc2Vzc2lvbi5wcm9qZWN0TmFtZSwgJ2Rpci1sb29rdXAnKTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQVFBLFNBQVMsVUFBVSxJQUFnQixpQkFBaUI7QUFDcEQsT0FBTyxZQUFZO0FBQ25CLFNBQVMsU0FBUyxnQkFBZ0I7QUFDbEMsU0FBUyxhQUF1QyxjQUFjO0FBQzlELFNBQVMsY0FBYztBQUN2QixTQUFTLFlBQVk7QUFFckIsU0FBUyxzQkFBc0I7QUFDL0IsU0FBUyxrQkFBa0I7QUFFM0IsU0FBUyxjQUFjO0FBTXZCLE1BQU0sY0FBYztBQUFBLEVBQ2xCLFVBQVU7QUFBQSxFQUNWLFVBQVU7QUFBQSxFQUNWLFVBQVU7QUFBQSxFQUNWLFdBQXFCLENBQUM7QUFBQSxFQUNkLGlCQUFr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
