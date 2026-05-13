import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { SessionManager } from "./session-manager.js";
import {
  askUserQuestionsHandler,
  buildAskUserQuestionsElicitRequest,
  createMcpServer,
  formatAskUserQuestionsElicitResult,
  withElicitTimeout
} from "./server.js";
import { MAX_EVENTS } from "./types.js";
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
  /** The last mock client created */
  lastClient = null;
  /** All mock clients */
  allClients = [];
  /** Counter for unique session IDs across multiple sessions */
  sessionCounter = 0;
  /** Control: set to make startSession fail during init */
  nextInitError = null;
  /** Control: set to make startSession fail during start */
  nextStartError = null;
  async startSession(projectDir, options = {}) {
    if (!projectDir || projectDir.trim() === "") {
      throw new Error("projectDir is required and cannot be empty");
    }
    const resolvedDir = resolve(projectDir);
    const existing = this.getSessionByDir(resolvedDir);
    if (existing) {
      if (existing.status === "starting" || existing.status === "running" || existing.status === "blocked") {
        throw new Error(
          `Session already active for ${resolvedDir} (sessionId: ${existing.sessionId}, status: ${existing.status})`
        );
      }
      existing.unsubscribe?.();
      this.sessions.delete(resolvedDir);
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
      status: "starting",
      client,
      // duck-typed mock
      events: [],
      pendingBlocker: null,
      cost: { totalCost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      startTime: Date.now()
    };
    this._putSession(resolvedDir, session);
    try {
      await client.start();
      const initResult = await client.init();
      session.sessionId = initResult.sessionId;
      session.status = "running";
      session.unsubscribe = client.onEvent((event) => {
        this._handleEvent(session, event);
      });
      const command = options.command ?? "/gsd auto";
      await client.prompt(command);
      return session.sessionId;
    } catch (err) {
      session.status = "error";
      session.error = err instanceof Error ? err.message : String(err);
      try {
        await client.stop();
      } catch {
      }
      throw new Error(`Failed to start session for ${resolvedDir}: ${session.error}`);
    }
  }
  /** Expose internal session map insertion for testing */
  _putSession(key, session) {
    this.sessions.set(key, session);
  }
  /** Expose handleEvent for testing */
  _handleEvent(session, event) {
    this.handleEvent(session, event);
  }
}
let allManagers = [];
function createManager() {
  const mgr = new TestableSessionManager();
  allManagers.push(mgr);
  return mgr;
}
describe("SessionManager", () => {
  let sm;
  beforeEach(() => {
    sm = createManager();
  });
  afterEach(async () => {
    for (const mgr of allManagers) {
      await mgr.cleanup();
    }
    allManagers = [];
  });
  it("startSession creates session and returns sessionId", async () => {
    const sessionId = await sm.startSession("/tmp/test-project", { cliPath: "/usr/bin/gsd" });
    assert.equal(sessionId, "mock-session-001");
    const session = sm.getSession(sessionId);
    assert.ok(session);
    assert.equal(session.status, "running");
    assert.equal(session.projectDir, resolve("/tmp/test-project"));
  });
  it("startSession sends /gsd auto by default", async () => {
    await sm.startSession("/tmp/test-prompt", { cliPath: "/usr/bin/gsd" });
    assert.ok(sm.lastClient);
    assert.deepEqual(sm.lastClient.prompted, ["/gsd auto"]);
  });
  it("startSession sends custom command when provided", async () => {
    await sm.startSession("/tmp/test-cmd", { cliPath: "/usr/bin/gsd", command: "/gsd auto --resume" });
    assert.ok(sm.lastClient);
    assert.deepEqual(sm.lastClient.prompted, ["/gsd auto --resume"]);
  });
  it("startSession rejects duplicate projectDir", async () => {
    await sm.startSession("/tmp/dup-test", { cliPath: "/usr/bin/gsd" });
    await assert.rejects(
      () => sm.startSession("/tmp/dup-test", { cliPath: "/usr/bin/gsd" }),
      (err) => {
        assert.ok(err.message.includes("Session already active"));
        return true;
      }
    );
  });
  for (const terminalStatus of ["completed", "error", "cancelled"]) {
    it(`startSession evicts a prior '${terminalStatus}' session for the same projectDir`, async () => {
      const dir = `/tmp/evict-${terminalStatus}`;
      const firstSessionId = await sm.startSession(dir, { cliPath: "/usr/bin/gsd" });
      const first = sm.getSession(firstSessionId);
      first.status = terminalStatus;
      const secondSessionId = await sm.startSession(dir, { cliPath: "/usr/bin/gsd" });
      assert.notEqual(secondSessionId, firstSessionId);
      const second = sm.getSession(secondSessionId);
      assert.equal(second.status, "running");
      assert.equal(sm.getSessionByDir(dir).sessionId, secondSessionId);
    });
  }
  for (const activeStatus of ["starting", "running", "blocked"]) {
    it(`startSession still rejects a prior '${activeStatus}' session`, async () => {
      const dir = `/tmp/keep-${activeStatus}`;
      const sid = await sm.startSession(dir, { cliPath: "/usr/bin/gsd" });
      sm.getSession(sid).status = activeStatus;
      await assert.rejects(
        () => sm.startSession(dir, { cliPath: "/usr/bin/gsd" }),
        /Session already active/
      );
    });
  }
  it("startSession rejects empty projectDir", async () => {
    await assert.rejects(
      () => sm.startSession("", { cliPath: "/usr/bin/gsd" }),
      (err) => {
        assert.ok(err.message.includes("projectDir is required"));
        return true;
      }
    );
  });
  it("startSession sets error status on start() failure", async () => {
    sm.nextStartError = new Error("spawn failed");
    await assert.rejects(
      () => sm.startSession("/tmp/fail-start", { cliPath: "/usr/bin/gsd" }),
      (err) => {
        assert.ok(err.message.includes("Failed to start session"));
        assert.ok(err.message.includes("spawn failed"));
        return true;
      }
    );
  });
  it("startSession sets error status on init() failure", async () => {
    sm.nextInitError = new Error("handshake failed");
    await assert.rejects(
      () => sm.startSession("/tmp/fail-init", { cliPath: "/usr/bin/gsd" }),
      (err) => {
        assert.ok(err.message.includes("Failed to start session"));
        assert.ok(err.message.includes("handshake failed"));
        return true;
      }
    );
  });
  it("getSession returns undefined for unknown sessionId", () => {
    const result = sm.getSession("nonexistent-id");
    assert.equal(result, void 0);
  });
  it("getSessionByDir returns session for known dir", async () => {
    await sm.startSession("/tmp/by-dir", { cliPath: "/usr/bin/gsd" });
    const session = sm.getSessionByDir("/tmp/by-dir");
    assert.ok(session);
    assert.equal(session.sessionId, "mock-session-001");
  });
  it("resolveBlocker errors when no pending blocker", async () => {
    const sessionId = await sm.startSession("/tmp/no-blocker", { cliPath: "/usr/bin/gsd" });
    await assert.rejects(
      () => sm.resolveBlocker(sessionId, "some response"),
      (err) => {
        assert.ok(err.message.includes("No pending blocker"));
        return true;
      }
    );
  });
  it("resolveBlocker errors for unknown session", async () => {
    await assert.rejects(
      () => sm.resolveBlocker("unknown-session", "some response"),
      (err) => {
        assert.ok(err.message.includes("Session not found"));
        return true;
      }
    );
  });
  it("resolveBlocker clears pendingBlocker and sends UI response", async () => {
    const sessionId = await sm.startSession("/tmp/blocker-resolve", { cliPath: "/usr/bin/gsd" });
    const client = sm.lastClient;
    client.emitEvent({
      type: "extension_ui_request",
      id: "req-42",
      method: "select",
      title: "Pick an option"
    });
    const session = sm.getSession(sessionId);
    assert.ok(session.pendingBlocker);
    assert.equal(session.status, "blocked");
    await sm.resolveBlocker(sessionId, "option-a");
    assert.equal(session.pendingBlocker, null);
    assert.equal(session.status, "running");
    assert.equal(client.uiResponses.length, 1);
    assert.equal(client.uiResponses[0].requestId, "req-42");
  });
  it("cancelSession calls abort + stop on client", async () => {
    const sessionId = await sm.startSession("/tmp/cancel-test", { cliPath: "/usr/bin/gsd" });
    const client = sm.lastClient;
    await sm.cancelSession(sessionId);
    assert.ok(client.aborted);
    assert.ok(client.stopped);
    const session = sm.getSession(sessionId);
    assert.equal(session.status, "cancelled");
  });
  it("cancelSession errors for unknown session", async () => {
    await assert.rejects(
      () => sm.cancelSession("unknown"),
      (err) => {
        assert.ok(err.message.includes("Session not found"));
        return true;
      }
    );
  });
  it("cleanup stops all active sessions", async () => {
    await sm.startSession("/tmp/cleanup-1", { cliPath: "/usr/bin/gsd" });
    await sm.startSession("/tmp/cleanup-2", { cliPath: "/usr/bin/gsd" });
    assert.equal(sm.allClients.length, 2);
    await sm.cleanup();
    for (const client of sm.allClients) {
      assert.ok(client.stopped, "Client should be stopped after cleanup");
    }
  });
  it("event ring buffer caps at MAX_EVENTS", async () => {
    const sessionId = await sm.startSession("/tmp/ring-buffer", { cliPath: "/usr/bin/gsd" });
    const client = sm.lastClient;
    for (let i = 0; i < MAX_EVENTS + 20; i++) {
      client.emitEvent({ type: "tool_use", index: i });
    }
    const session = sm.getSession(sessionId);
    assert.equal(session.events.length, MAX_EVENTS);
    assert.equal(session.events[0].index, 20);
  });
  it("blocker detection: non-fire-and-forget extension_ui_request sets pendingBlocker", async () => {
    const sessionId = await sm.startSession("/tmp/blocker-detect", { cliPath: "/usr/bin/gsd" });
    const client = sm.lastClient;
    client.emitEvent({
      type: "extension_ui_request",
      id: "req-99",
      method: "select",
      title: "Choose wisely"
    });
    const session = sm.getSession(sessionId);
    assert.equal(session.status, "blocked");
    assert.ok(session.pendingBlocker);
    assert.equal(session.pendingBlocker.id, "req-99");
    assert.equal(session.pendingBlocker.method, "select");
  });
  it("fire-and-forget methods do not set pendingBlocker", async () => {
    const sessionId = await sm.startSession("/tmp/fire-forget", { cliPath: "/usr/bin/gsd" });
    const client = sm.lastClient;
    client.emitEvent({
      type: "extension_ui_request",
      id: "req-100",
      method: "notify",
      message: "Just a notification"
    });
    const session = sm.getSession(sessionId);
    assert.equal(session.status, "running");
    assert.equal(session.pendingBlocker, null);
  });
  it("terminal detection: auto-mode stopped sets status to completed", async () => {
    const sessionId = await sm.startSession("/tmp/terminal", { cliPath: "/usr/bin/gsd" });
    const client = sm.lastClient;
    client.emitEvent({
      type: "extension_ui_request",
      method: "notify",
      message: "Auto-mode stopped \u2014 all tasks complete",
      id: "term-1"
    });
    const session = sm.getSession(sessionId);
    assert.equal(session.status, "completed");
  });
  it("terminal detection with blocked: message sets status to blocked", async () => {
    const sessionId = await sm.startSession("/tmp/terminal-blocked", { cliPath: "/usr/bin/gsd" });
    const client = sm.lastClient;
    client.emitEvent({
      type: "extension_ui_request",
      method: "notify",
      message: "Auto-mode stopped \u2014 blocked: needs user input",
      id: "block-1"
    });
    const session = sm.getSession(sessionId);
    assert.equal(session.status, "blocked");
    assert.ok(session.pendingBlocker);
  });
  it("cost tracking: cumulative-max from cost_update events", async () => {
    const sessionId = await sm.startSession("/tmp/cost-track", { cliPath: "/usr/bin/gsd" });
    const client = sm.lastClient;
    client.emitEvent({
      type: "cost_update",
      cumulativeCost: 0.05,
      tokens: { input: 1e3, output: 500, cacheRead: 200, cacheWrite: 100 }
    });
    client.emitEvent({
      type: "cost_update",
      cumulativeCost: 0.12,
      tokens: { input: 2500, output: 800, cacheRead: 150, cacheWrite: 300 }
    });
    const session = sm.getSession(sessionId);
    assert.equal(session.cost.totalCost, 0.12);
    assert.equal(session.cost.tokens.input, 2500);
    assert.equal(session.cost.tokens.output, 800);
    assert.equal(session.cost.tokens.cacheRead, 200);
    assert.equal(session.cost.tokens.cacheWrite, 300);
  });
  it("getResult returns HeadlessJsonResult-shaped object", async () => {
    const sessionId = await sm.startSession("/tmp/result-shape", { cliPath: "/usr/bin/gsd" });
    const result = sm.getResult(sessionId);
    assert.equal(result.sessionId, sessionId);
    assert.equal(result.projectDir, resolve("/tmp/result-shape"));
    assert.equal(result.status, "running");
    assert.equal(typeof result.durationMs, "number");
    assert.ok(result.cost);
    assert.ok(Array.isArray(result.recentEvents));
    assert.equal(result.pendingBlocker, null);
    assert.equal(result.error, null);
  });
  it("getResult errors for unknown session", () => {
    assert.throws(
      () => sm.getResult("unknown"),
      (err) => {
        assert.ok(err.message.includes("Session not found"));
        return true;
      }
    );
  });
});
describe("SessionManager.resolveCLIPath", () => {
  const originalGsdPath = process.env["GSD_CLI_PATH"];
  const originalPath = process.env["PATH"];
  const originalPathTitle = process.env["Path"];
  afterEach(() => {
    if (originalGsdPath !== void 0) {
      process.env["GSD_CLI_PATH"] = originalGsdPath;
    } else {
      delete process.env["GSD_CLI_PATH"];
    }
    if (originalPath !== void 0) {
      process.env["PATH"] = originalPath;
    } else {
      delete process.env["PATH"];
    }
    if (originalPathTitle !== void 0) {
      process.env["Path"] = originalPathTitle;
    } else {
      delete process.env["Path"];
    }
  });
  it("GSD_CLI_PATH env var takes precedence", () => {
    process.env["GSD_CLI_PATH"] = "/custom/path/to/gsd";
    const result = SessionManager.resolveCLIPath();
    assert.equal(result, resolve("/custom/path/to/gsd"));
  });
  it("finds gsd on PATH without shelling out to which", () => {
    delete process.env["GSD_CLI_PATH"];
    const tmp = mkdtempSync(join(tmpdir(), "gsd-cli-path-"));
    try {
      const shimName = process.platform === "win32" ? "gsd.cmd" : "gsd";
      const shimPath = join(tmp, shimName);
      writeFileSync(shimPath, "", "utf8");
      process.env["PATH"] = [tmp, originalPath].filter(Boolean).join(delimiter);
      const resolvedPath = SessionManager.resolveCLIPath();
      if (process.platform === "win32") {
        assert.equal(resolvedPath.toLowerCase(), resolve(shimPath).toLowerCase());
      } else {
        assert.equal(resolvedPath, resolve(shimPath));
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("finds gsd when Windows exposes Path instead of PATH", () => {
    delete process.env["GSD_CLI_PATH"];
    delete process.env["PATH"];
    const tmp = mkdtempSync(join(tmpdir(), "gsd-cli-path-title-"));
    try {
      const shimName = process.platform === "win32" ? "gsd.cmd" : "gsd";
      const shimPath = join(tmp, shimName);
      writeFileSync(shimPath, "", "utf8");
      process.env["Path"] = tmp;
      const resolvedPath = SessionManager.resolveCLIPath();
      if (process.platform === "win32") {
        assert.equal(resolvedPath.toLowerCase(), resolve(shimPath).toLowerCase());
      } else {
        assert.equal(resolvedPath, resolve(shimPath));
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("throws when GSD_CLI_PATH not set and PATH lookup fails", () => {
    delete process.env["GSD_CLI_PATH"];
    delete process.env["Path"];
    process.env["PATH"] = "/nonexistent";
    assert.throws(
      () => SessionManager.resolveCLIPath(),
      (err) => {
        assert.ok(err.message.includes("Cannot find GSD CLI"));
        return true;
      }
    );
  });
});
describe("createMcpServer tool registration", () => {
  let sm;
  beforeEach(() => {
    sm = createManager();
  });
  afterEach(async () => {
    for (const mgr of allManagers) {
      await mgr.cleanup();
    }
    allManagers = [];
  });
  it("creates server successfully with all required methods", async () => {
    const { server } = await createMcpServer(sm);
    assert.ok(server);
    assert.ok(server.server);
    assert.equal(typeof server.server.elicitInput, "function");
    assert.ok(typeof server.connect === "function");
    assert.ok(typeof server.close === "function");
  });
  it("gsd_execute flow returns sessionId on success", async () => {
    const sessionId = await sm.startSession("/tmp/tool-exec", { cliPath: "/usr/bin/gsd" });
    assert.equal(typeof sessionId, "string");
    assert.ok(sessionId.length > 0);
  });
  it("gsd_status flow returns correct shape", async () => {
    const sessionId = await sm.startSession("/tmp/tool-status", { cliPath: "/usr/bin/gsd" });
    const session = sm.getSession(sessionId);
    assert.equal(typeof session.status, "string");
    assert.ok(Array.isArray(session.events));
    assert.ok(session.cost);
    assert.equal(typeof session.startTime, "number");
  });
  it("gsd_resolve_blocker flow returns error when no blocker", async () => {
    const sessionId = await sm.startSession("/tmp/tool-resolve", { cliPath: "/usr/bin/gsd" });
    await assert.rejects(
      () => sm.resolveBlocker(sessionId, "fix"),
      (err) => {
        assert.ok(err.message.includes("No pending blocker"));
        return true;
      }
    );
  });
  it("gsd_result flow returns HeadlessJsonResult shape", async () => {
    const sessionId = await sm.startSession("/tmp/tool-result", { cliPath: "/usr/bin/gsd" });
    const result = sm.getResult(sessionId);
    assert.ok("sessionId" in result);
    assert.ok("projectDir" in result);
    assert.ok("status" in result);
    assert.ok("durationMs" in result);
    assert.ok("cost" in result);
    assert.ok("recentEvents" in result);
    assert.ok("pendingBlocker" in result);
    assert.ok("error" in result);
  });
  it("gsd_cancel flow marks session as cancelled", async () => {
    const sessionId = await sm.startSession("/tmp/tool-cancel", { cliPath: "/usr/bin/gsd" });
    await sm.cancelSession(sessionId);
    const session = sm.getSession(sessionId);
    assert.equal(session.status, "cancelled");
  });
  it("gsd_cancel can cancel an interactive session (no sessionId) via projectDir fallback", async () => {
    const projectDir = resolve("/tmp/interactive-session");
    const mockClient = new MockRpcClient({ cwd: projectDir, args: [] });
    const interactiveSession = {
      sessionId: "",
      // no sessionId — interactive/restarted scenario
      projectDir,
      status: "running",
      client: mockClient,
      events: [],
      pendingBlocker: null,
      cost: { totalCost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      startTime: Date.now()
    };
    sm._putSession(projectDir, interactiveSession);
    await sm.cancelSessionByDir(projectDir);
    const session = sm.getSessionByDir(projectDir);
    assert.equal(session.status, "cancelled");
    assert.ok(mockClient.aborted, "client.abort() should have been called");
  });
  it("gsd_cancel via projectDir works even when sessionId lookup returns undefined", async () => {
    const sessionId = await sm.startSession("/tmp/cancel-by-dir", { cliPath: "/usr/bin/gsd" });
    const session = sm.getSession(sessionId);
    const { projectDir } = session;
    await sm.cancelSessionByDir(projectDir);
    assert.equal(session.status, "cancelled");
  });
  it("buildAskUserQuestionsElicitRequest adds None of the above note field for single-select questions", () => {
    const request = buildAskUserQuestionsElicitRequest([
      {
        id: "depth_verification_M001",
        header: "Depth Check",
        question: "Did I capture the depth right?",
        options: [
          { label: "Yes, you got it (Recommended)", description: "Continue with the current summary." },
          { label: "Not quite", description: "I need to clarify the depth further." }
        ]
      },
      {
        id: "focus_areas",
        header: "Focus",
        question: "Which areas matter most?",
        allowMultiple: true,
        options: [
          { label: "Frontend", description: "Prioritize the UI." },
          { label: "Backend", description: "Prioritize server logic." }
        ]
      }
    ]);
    assert.equal(request.mode, "form");
    assert.deepEqual(request.requestedSchema.required, ["depth_verification_M001", "focus_areas"]);
    assert.ok(request.requestedSchema.properties["depth_verification_M001"]);
    assert.ok(request.requestedSchema.properties["depth_verification_M001__note"]);
    assert.ok(!request.requestedSchema.properties["focus_areas__note"]);
  });
  it("formatAskUserQuestionsElicitResult preserves the existing answers JSON shape", () => {
    const result = formatAskUserQuestionsElicitResult(
      [
        {
          id: "depth_verification_M001",
          header: "Depth Check",
          question: "Did I capture the depth right?",
          options: [
            { label: "Yes, you got it (Recommended)", description: "Continue with the current summary." },
            { label: "Not quite", description: "I need to clarify the depth further." }
          ]
        },
        {
          id: "focus_areas",
          header: "Focus",
          question: "Which areas matter most?",
          allowMultiple: true,
          options: [
            { label: "Frontend", description: "Prioritize the UI." },
            { label: "Backend", description: "Prioritize server logic." }
          ]
        }
      ],
      {
        action: "accept",
        content: {
          depth_verification_M001: "None of the above",
          depth_verification_M001__note: "Need more implementation detail.",
          focus_areas: ["Frontend", "Backend"]
        }
      }
    );
    assert.equal(
      result,
      JSON.stringify({
        answers: {
          depth_verification_M001: {
            answers: ["None of the above", "user_note: Need more implementation detail."]
          },
          focus_areas: {
            answers: ["Frontend", "Backend"]
          }
        }
      })
    );
  });
  it("ask_user_questions returns local elicitation answers before trying remote", async () => {
    const questions = [
      {
        id: "depth_verification_M001",
        header: "Depth Check",
        question: "Did I capture the depth right?",
        options: [
          { label: "Yes, you got it (Recommended)", description: "Continue with the current summary." },
          { label: "Not quite", description: "I need to clarify the depth further." }
        ]
      }
    ];
    let remoteCalls = 0;
    const result = await askUserQuestionsHandler(questions, void 0, {
      async elicitInput() {
        return {
          action: "accept",
          content: {
            depth_verification_M001: "Yes, you got it (Recommended)"
          }
        };
      },
      isRemoteConfigured() {
        return true;
      },
      async tryRemoteQuestions() {
        remoteCalls++;
        return { content: [{ type: "text", text: "remote response" }] };
      }
    });
    assert.equal(remoteCalls, 0);
    assert.equal(
      result.content[0]?.text,
      JSON.stringify({
        answers: {
          depth_verification_M001: {
            answers: ["Yes, you got it (Recommended)"]
          }
        }
      })
    );
  });
  it("ask_user_questions persists confirmed depth gates for local answers", async () => {
    const questions = [
      {
        id: "depth_verification_M003_confirm",
        header: "Depth Check",
        question: "Did I capture the depth right?",
        options: [
          { label: "Yes, you got it (Recommended)", description: "Continue with the current summary." },
          { label: "Not quite", description: "I need to clarify the depth further." }
        ]
      }
    ];
    const calls = [];
    const writeGate = {
      isGateQuestionId(questionId) {
        return questionId.startsWith("depth_verification_");
      },
      isDepthConfirmationAnswer(selected, options) {
        return selected === options?.[0]?.label;
      },
      setPendingGate(gateId, basePath) {
        calls.push(`pending:${gateId}:${basePath}`);
      },
      markApprovalGateVerified(gateId, basePath) {
        calls.push(`approval:${gateId}:${basePath}`);
      },
      markDepthVerified(milestoneId, basePath) {
        calls.push(`depth:${milestoneId}:${basePath}`);
      },
      clearPendingGate(basePath) {
        calls.push(`clear:${basePath}`);
      },
      extractDepthVerificationMilestoneId(questionId) {
        return questionId.match(/_(M\d+)_/)?.[1] ?? null;
      }
    };
    const result = await askUserQuestionsHandler(questions, void 0, {
      async elicitInput() {
        return {
          action: "accept",
          content: {
            depth_verification_M003_confirm: "Yes, you got it (Recommended)"
          }
        };
      },
      isRemoteConfigured() {
        return false;
      },
      async tryRemoteQuestions() {
        throw new Error("should not be called");
      },
      writeGate,
      writeGateBasePath: "/tmp/gsd-project"
    });
    assert.equal("isError" in result && result.isError, false);
    assert.deepEqual(calls, [
      "pending:depth_verification_M003_confirm:/tmp/gsd-project",
      "approval:depth_verification_M003_confirm:/tmp/gsd-project",
      "depth:M003:/tmp/gsd-project",
      "clear:/tmp/gsd-project"
    ]);
  });
  it("ask_user_questions persists confirmed depth gates for remote answers", async () => {
    const questions = [
      {
        id: "depth_verification_M003_confirm",
        header: "Depth Check",
        question: "Did I capture the depth right?",
        options: [
          { label: "Yes, you got it (Recommended)", description: "Continue with the current summary." },
          { label: "Not quite", description: "I need to clarify the depth further." }
        ]
      }
    ];
    const calls = [];
    const writeGate = {
      isGateQuestionId(questionId) {
        return questionId.startsWith("depth_verification_");
      },
      isDepthConfirmationAnswer(selected, options) {
        return selected === options?.[0]?.label;
      },
      setPendingGate(gateId, basePath) {
        calls.push(`pending:${gateId}:${basePath}`);
      },
      markApprovalGateVerified(gateId, basePath) {
        calls.push(`approval:${gateId}:${basePath}`);
      },
      markDepthVerified(milestoneId, basePath) {
        calls.push(`depth:${milestoneId}:${basePath}`);
      },
      clearPendingGate(basePath) {
        calls.push(`clear:${basePath}`);
      },
      extractDepthVerificationMilestoneId(questionId) {
        return questionId.match(/_(M\d+)_/)?.[1] ?? null;
      }
    };
    const result = await askUserQuestionsHandler(questions, void 0, {
      async elicitInput() {
        return { action: "cancel" };
      },
      isRemoteConfigured() {
        return true;
      },
      async tryRemoteQuestions() {
        return {
          content: [{ type: "text", text: "remote response" }],
          details: {
            response: {
              endInterview: false,
              answers: {
                depth_verification_M003_confirm: {
                  selected: "Yes, you got it (Recommended)",
                  notes: ""
                }
              }
            }
          }
        };
      },
      writeGate,
      writeGateBasePath: "/tmp/gsd-project"
    });
    assert.equal("isError" in result && result.isError, false);
    assert.deepEqual(calls, [
      "pending:depth_verification_M003_confirm:/tmp/gsd-project",
      "approval:depth_verification_M003_confirm:/tmp/gsd-project",
      "depth:M003:/tmp/gsd-project",
      "clear:/tmp/gsd-project"
    ]);
  });
  it("ask_user_questions falls back to remote when local elicitation is cancelled", async () => {
    const questions = [
      {
        id: "depth_verification_M001",
        header: "Depth Check",
        question: "Did I capture the depth right?",
        options: [
          { label: "Yes, you got it (Recommended)", description: "Continue with the current summary." },
          { label: "Not quite", description: "I need to clarify the depth further." }
        ]
      }
    ];
    let remoteCalls = 0;
    const signal = AbortSignal.abort();
    const result = await askUserQuestionsHandler(questions, { signal }, {
      async elicitInput() {
        return { action: "cancel" };
      },
      isRemoteConfigured() {
        return true;
      },
      async tryRemoteQuestions(remoteQuestions, receivedSignal) {
        remoteCalls++;
        assert.equal(remoteQuestions, questions);
        assert.equal(receivedSignal, signal);
        return { content: [{ type: "text", text: "remote response" }] };
      }
    });
    assert.equal(remoteCalls, 1);
    assert.equal(result.content[0]?.text, "remote response");
  });
  it("ask_user_questions falls back to remote when local elicitation is unavailable", async () => {
    const questions = [
      {
        id: "depth_verification_M001",
        header: "Depth Check",
        question: "Did I capture the depth right?",
        options: [
          { label: "Yes, you got it (Recommended)", description: "Continue with the current summary." },
          { label: "Not quite", description: "I need to clarify the depth further." }
        ]
      }
    ];
    let remoteCalls = 0;
    const result = await askUserQuestionsHandler(questions, void 0, {
      async elicitInput() {
        throw new Error("MCP host does not support elicitation");
      },
      isRemoteConfigured() {
        return true;
      },
      async tryRemoteQuestions(remoteQuestions) {
        remoteCalls++;
        assert.equal(remoteQuestions, questions);
        return { content: [{ type: "text", text: "remote response" }] };
      }
    });
    assert.equal(remoteCalls, 1);
    assert.equal(result.content[0]?.text, "remote response");
  });
  it("ask_user_questions surfaces remote success answers as structuredContent (regression #5267)", async () => {
    const questions = [
      {
        id: "depth_verification_M001",
        header: "Depth Check",
        question: "Did I capture the depth right?",
        options: [
          { label: "Yes, you got it (Recommended)", description: "Continue." },
          { label: "Not quite", description: "Clarify." }
        ]
      }
    ];
    const result = await askUserQuestionsHandler(questions, void 0, {
      async elicitInput() {
        throw new Error("MCP host does not support elicitation");
      },
      isRemoteConfigured() {
        return true;
      },
      async tryRemoteQuestions() {
        return {
          content: [{ type: "text", text: '{"answers":{"depth_verification_M001":{"answers":["Yes, you got it (Recommended)"]}}}' }],
          details: {
            remote: true,
            channel: "discord",
            timed_out: false,
            promptId: "p1",
            threadUrl: null,
            questions,
            response: {
              endInterview: false,
              answers: {
                depth_verification_M001: { selected: "Yes, you got it (Recommended)", notes: "" }
              }
            },
            status: "answered"
          }
        };
      }
    });
    assert.deepEqual(
      result.structuredContent,
      {
        questions,
        response: {
          // endInterview mirrors the local RoundResult shape so register-hooks
          // sees identical payloads on both code paths.
          endInterview: false,
          answers: {
            depth_verification_M001: { selected: "Yes, you got it (Recommended)", notes: "" }
          }
        },
        cancelled: false
      }
    );
  });
  it("ask_user_questions surfaces remote timeout as cancelled structuredContent (regression #5267)", async () => {
    const questions = [
      {
        id: "depth_verification_M001",
        header: "Depth Check",
        question: "Did I capture the depth right?",
        options: [
          { label: "Yes, you got it (Recommended)", description: "Continue." },
          { label: "Not quite", description: "Clarify." }
        ]
      }
    ];
    const result = await askUserQuestionsHandler(questions, void 0, {
      async elicitInput() {
        throw new Error("MCP host does not support elicitation");
      },
      isRemoteConfigured() {
        return true;
      },
      async tryRemoteQuestions() {
        return {
          content: [{ type: "text", text: '{"timed_out":true,"channel":"discord","message":"User did not respond within 5 minutes."}' }],
          details: { remote: true, channel: "discord", timed_out: true, status: "timed_out" }
        };
      }
    });
    assert.deepEqual(
      result.structuredContent,
      { questions, response: null, cancelled: true }
    );
  });
  it("ask_user_questions reports a malformed remote response as cancelled, not silent success (regression #5267)", async () => {
    const questions = [
      {
        id: "depth_verification_M001",
        header: "Depth Check",
        question: "Did I capture the depth right?",
        options: [
          { label: "Yes, you got it (Recommended)", description: "Continue." },
          { label: "Not quite", description: "Clarify." }
        ]
      }
    ];
    const result = await askUserQuestionsHandler(questions, void 0, {
      async elicitInput() {
        throw new Error("MCP host does not support elicitation");
      },
      isRemoteConfigured() {
        return true;
      },
      async tryRemoteQuestions() {
        return {
          content: [{ type: "text", text: "{}" }],
          details: { remote: true, channel: "discord", timed_out: false, response: "not-an-object" }
        };
      }
    });
    assert.deepEqual(
      result.structuredContent,
      { questions, response: null, cancelled: true }
    );
  });
  it("ask_user_questions returns cancelled structuredContent when remote is unconfigured and local declines (regression #5267)", async () => {
    const questions = [
      {
        id: "depth_verification_M001",
        header: "Depth Check",
        question: "Did I capture the depth right?",
        options: [
          { label: "Yes, you got it (Recommended)", description: "Continue." },
          { label: "Not quite", description: "Clarify." }
        ]
      }
    ];
    const result = await askUserQuestionsHandler(questions, void 0, {
      async elicitInput() {
        return { action: "decline" };
      },
      isRemoteConfigured() {
        return false;
      },
      async tryRemoteQuestions() {
        throw new Error("should not be called when remote is unconfigured");
      }
    });
    assert.deepEqual(
      result.structuredContent,
      { questions, response: null, cancelled: true }
    );
    assert.equal(result.content[0]?.text, "ask_user_questions was cancelled before receiving a response");
  });
  it("ask_user_questions returns cancelled structuredContent when configured remote returns null (regression #5267)", async () => {
    const questions = [
      {
        id: "depth_verification_M001",
        header: "Depth Check",
        question: "Did I capture the depth right?",
        options: [
          { label: "Yes, you got it (Recommended)", description: "Continue." },
          { label: "Not quite", description: "Clarify." }
        ]
      }
    ];
    const result = await askUserQuestionsHandler(questions, void 0, {
      async elicitInput() {
        return { action: "cancel" };
      },
      isRemoteConfigured() {
        return true;
      },
      async tryRemoteQuestions() {
        return null;
      }
    });
    assert.deepEqual(
      result.structuredContent,
      { questions, response: null, cancelled: true }
    );
  });
  it("ask_user_questions re-throws non-fallback local errors (regression #5267)", async () => {
    const questions = [
      {
        id: "depth_verification_M001",
        header: "Depth Check",
        question: "Did I capture the depth right?",
        options: [
          { label: "Yes, you got it (Recommended)", description: "Continue." },
          { label: "Not quite", description: "Clarify." }
        ]
      }
    ];
    const result = await askUserQuestionsHandler(questions, void 0, {
      async elicitInput() {
        throw new TypeError("schema validation blew up");
      },
      isRemoteConfigured() {
        return false;
      },
      async tryRemoteQuestions() {
        throw new Error("should not be called");
      }
    });
    assert.equal("isError" in result && result.isError, true);
    assert.match(result.content[0]?.text ?? "", /schema validation blew up/);
  });
  it("ask_user_questions reports both local and remote errors when both paths fail", async () => {
    const questions = [
      {
        id: "depth_verification_M001",
        header: "Depth Check",
        question: "Did I capture the depth right?",
        options: [
          { label: "Yes, you got it (Recommended)", description: "Continue with the current summary." },
          { label: "Not quite", description: "I need to clarify the depth further." }
        ]
      }
    ];
    const result = await askUserQuestionsHandler(questions, void 0, {
      async elicitInput() {
        throw new Error("ask_user_questions timed out after 10 minutes");
      },
      isRemoteConfigured() {
        return true;
      },
      async tryRemoteQuestions() {
        throw new Error("remote transport failed");
      }
    });
    assert.equal("isError" in result && result.isError, true);
    assert.match(result.content[0]?.text ?? "", /Local elicitation failed/);
    assert.match(result.content[0]?.text ?? "", /remote transport failed/);
  });
});
describe("withElicitTimeout", () => {
  it("resolves with the promise value when it settles before the timeout", async () => {
    const result = await withElicitTimeout(Promise.resolve(42), "test", 5e3);
    assert.equal(result, 42);
  });
  it("rejects with a timeout error when the promise does not settle in time", async () => {
    const never = new Promise(() => {
    });
    await assert.rejects(
      () => withElicitTimeout(never, "ask_user_questions", 1),
      (err) => {
        assert.ok(err.message.includes("ask_user_questions"));
        assert.ok(err.message.includes("timed out"));
        return true;
      }
    );
  });
  it("clears the timer when the promise resolves (no dangling timer)", async () => {
    const originalClearTimeout = globalThis.clearTimeout;
    let clearCalls = 0;
    let lastClearedId = void 0;
    globalThis.clearTimeout = ((id) => {
      clearCalls++;
      lastClearedId = id;
      return originalClearTimeout(id);
    });
    try {
      const value = await withElicitTimeout(Promise.resolve("done"), "test", 5e4);
      assert.equal(value, "done");
      assert.ok(
        clearCalls >= 1,
        `clearTimeout should run on resolve path; calls=${clearCalls}`
      );
      assert.ok(lastClearedId !== void 0, "clearTimeout should be called with the timer id");
    } finally {
      globalThis.clearTimeout = originalClearTimeout;
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvbWNwLXNlcnZlci9zcmMvbWNwLXNlcnZlci50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIEBnc2QtYnVpbGQvbWNwLXNlcnZlciBcdTIwMTQgSW50ZWdyYXRpb24gYW5kIHVuaXQgdGVzdHMuXG4gKlxuICogU3RyYXRlZ3k6IFdlIGNhbm5vdCBtb2NrIEBnc2QtYnVpbGQvcnBjLWNsaWVudCBhdCB0aGUgbW9kdWxlIGxldmVsIHdpdGhvdXRcbiAqIC0tZXhwZXJpbWVudGFsLXRlc3QtbW9kdWxlLW1vY2tzLiBJbnN0ZWFkIHdlIHRlc3QgYnk6XG4gKlxuICogMS4gU3ViY2xhc3NpbmcgU2Vzc2lvbk1hbmFnZXIgdG8gaW5qZWN0IGEgbW9jayBjbGllbnQgZmFjdG9yeVxuICogMi4gVGVzdGluZyBldmVudCBoYW5kbGluZywgc3RhdGUgdHJhbnNpdGlvbnMsIGFuZCBlcnJvciBwYXRoc1xuICogMy4gVGVzdGluZyB0b29sIHJlZ2lzdHJhdGlvbiB2aWEgY3JlYXRlTWNwU2VydmVyXG4gKiA0LiBUZXN0aW5nIENMSSBwYXRoIHJlc29sdXRpb24gdmlhIHN0YXRpYyBtZXRob2RcbiAqL1xuXG5pbXBvcnQgeyBkZXNjcmliZSwgaXQsIGJlZm9yZUVhY2gsIGFmdGVyRWFjaCB9IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSAnbm9kZTpmcyc7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tICdub2RlOm9zJztcbmltcG9ydCB7IGRlbGltaXRlciwgam9pbiwgcmVzb2x2ZSB9IGZyb20gJ25vZGU6cGF0aCc7XG5pbXBvcnQgeyBFdmVudEVtaXR0ZXIgfSBmcm9tICdub2RlOmV2ZW50cyc7XG5cbmltcG9ydCB7IFNlc3Npb25NYW5hZ2VyIH0gZnJvbSAnLi9zZXNzaW9uLW1hbmFnZXIuanMnO1xuaW1wb3J0IHtcbiAgYXNrVXNlclF1ZXN0aW9uc0hhbmRsZXIsXG4gIGJ1aWxkQXNrVXNlclF1ZXN0aW9uc0VsaWNpdFJlcXVlc3QsXG4gIGNyZWF0ZU1jcFNlcnZlcixcbiAgZm9ybWF0QXNrVXNlclF1ZXN0aW9uc0VsaWNpdFJlc3VsdCxcbiAgd2l0aEVsaWNpdFRpbWVvdXQsXG59IGZyb20gJy4vc2VydmVyLmpzJztcbmltcG9ydCB7IE1BWF9FVkVOVFMgfSBmcm9tICcuL3R5cGVzLmpzJztcbmltcG9ydCB0eXBlIHsgTWFuYWdlZFNlc3Npb24sIENvc3RBY2N1bXVsYXRvciwgUGVuZGluZ0Jsb2NrZXIgfSBmcm9tICcuL3R5cGVzLmpzJztcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBNb2NrIFJwY0NsaWVudCAoZHVjay10eXBlZCB0byBtYXRjaCBScGNDbGllbnQgaW50ZXJmYWNlKVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmNsYXNzIE1vY2tScGNDbGllbnQge1xuICBzdGFydGVkID0gZmFsc2U7XG4gIHN0b3BwZWQgPSBmYWxzZTtcbiAgYWJvcnRlZCA9IGZhbHNlO1xuICBwcm9tcHRlZDogc3RyaW5nW10gPSBbXTtcbiAgcHJpdmF0ZSBldmVudExpc3RlbmVyczogQXJyYXk8KGV2ZW50OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4gdm9pZD4gPSBbXTtcbiAgdWlSZXNwb25zZXM6IEFycmF5PHsgcmVxdWVzdElkOiBzdHJpbmc7IHJlc3BvbnNlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB9PiA9IFtdO1xuXG4gIC8qKiBDb250cm9sIFx1MjAxNCBzZXQgdG8gbWFrZSBzdGFydCgpIHJlamVjdCAqL1xuICBzdGFydEVycm9yOiBFcnJvciB8IG51bGwgPSBudWxsO1xuICAvKiogQ29udHJvbCBcdTIwMTQgc2V0IHRvIG1ha2UgaW5pdCgpIHJlamVjdCAqL1xuICBpbml0RXJyb3I6IEVycm9yIHwgbnVsbCA9IG51bGw7XG4gIC8qKiBDb250cm9sIFx1MjAxNCBvdmVycmlkZSBzZXNzaW9uSWQgZnJvbSBpbml0ICovXG4gIGluaXRTZXNzaW9uSWQgPSAnbW9jay1zZXNzaW9uLTAwMSc7XG5cbiAgY3dkOiBzdHJpbmc7XG4gIGFyZ3M6IHN0cmluZ1tdO1xuXG4gIGNvbnN0cnVjdG9yKG9wdGlvbnM/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikge1xuICAgIHRoaXMuY3dkID0gKG9wdGlvbnM/LmN3ZCBhcyBzdHJpbmcpID8/ICcnO1xuICAgIHRoaXMuYXJncyA9IChvcHRpb25zPy5hcmdzIGFzIHN0cmluZ1tdKSA/PyBbXTtcbiAgfVxuXG4gIGFzeW5jIHN0YXJ0KCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICh0aGlzLnN0YXJ0RXJyb3IpIHRocm93IHRoaXMuc3RhcnRFcnJvcjtcbiAgICB0aGlzLnN0YXJ0ZWQgPSB0cnVlO1xuICB9XG5cbiAgYXN5bmMgc3RvcCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICB0aGlzLnN0b3BwZWQgPSB0cnVlO1xuICB9XG5cbiAgYXN5bmMgaW5pdCgpOiBQcm9taXNlPHsgc2Vzc2lvbklkOiBzdHJpbmc7IHZlcnNpb246IHN0cmluZyB9PiB7XG4gICAgaWYgKHRoaXMuaW5pdEVycm9yKSB0aHJvdyB0aGlzLmluaXRFcnJvcjtcbiAgICByZXR1cm4geyBzZXNzaW9uSWQ6IHRoaXMuaW5pdFNlc3Npb25JZCwgdmVyc2lvbjogJzIuNTEuMCcgfTtcbiAgfVxuXG4gIG9uRXZlbnQobGlzdGVuZXI6IChldmVudDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHZvaWQpOiAoKSA9PiB2b2lkIHtcbiAgICB0aGlzLmV2ZW50TGlzdGVuZXJzLnB1c2gobGlzdGVuZXIpO1xuICAgIHJldHVybiAoKSA9PiB7XG4gICAgICBjb25zdCBpZHggPSB0aGlzLmV2ZW50TGlzdGVuZXJzLmluZGV4T2YobGlzdGVuZXIpO1xuICAgICAgaWYgKGlkeCA+PSAwKSB0aGlzLmV2ZW50TGlzdGVuZXJzLnNwbGljZShpZHgsIDEpO1xuICAgIH07XG4gIH1cblxuICBhc3luYyBwcm9tcHQobWVzc2FnZTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgdGhpcy5wcm9tcHRlZC5wdXNoKG1lc3NhZ2UpO1xuICB9XG5cbiAgYXN5bmMgYWJvcnQoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgdGhpcy5hYm9ydGVkID0gdHJ1ZTtcbiAgfVxuXG4gIHNlbmRVSVJlc3BvbnNlKHJlcXVlc3RJZDogc3RyaW5nLCByZXNwb25zZTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiB2b2lkIHtcbiAgICB0aGlzLnVpUmVzcG9uc2VzLnB1c2goeyByZXF1ZXN0SWQsIHJlc3BvbnNlIH0pO1xuICB9XG5cbiAgLyoqIFRlc3QgaGVscGVyIFx1MjAxNCBlbWl0IGFuIGV2ZW50IHRvIGFsbCBsaXN0ZW5lcnMgKi9cbiAgZW1pdEV2ZW50KGV2ZW50OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IHZvaWQge1xuICAgIGZvciAoY29uc3QgbGlzdGVuZXIgb2YgdGhpcy5ldmVudExpc3RlbmVycykge1xuICAgICAgbGlzdGVuZXIoZXZlbnQpO1xuICAgIH1cbiAgfVxufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFRlc3RhYmxlU2Vzc2lvbk1hbmFnZXIgXHUyMDE0IGluamVjdHMgbW9jayBjbGllbnRzIHdpdGhvdXQgbW9kdWxlIG1vY2tpbmdcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKipcbiAqIFN1YmNsYXNzIHRoYXQgb3ZlcnJpZGVzIHN0YXJ0U2Vzc2lvbiB0byB1c2UgTW9ja1JwY0NsaWVudCBpbnN0ZWFkIG9mIHRoZVxuICogcmVhbCBScGNDbGllbnQuIFdlIGRpcmVjdGx5IGNvbnN0cnVjdCB0aGUgc2Vzc2lvbiBvYmplY3QsIG1pcnJvcmluZyB0aGVcbiAqIHBhcmVudCdzIGxvZ2ljIGJ1dCB3aXRoIG91ciBtb2NrLlxuICovXG5jbGFzcyBUZXN0YWJsZVNlc3Npb25NYW5hZ2VyIGV4dGVuZHMgU2Vzc2lvbk1hbmFnZXIge1xuICAvKiogVGhlIGxhc3QgbW9jayBjbGllbnQgY3JlYXRlZCAqL1xuICBsYXN0Q2xpZW50OiBNb2NrUnBjQ2xpZW50IHwgbnVsbCA9IG51bGw7XG4gIC8qKiBBbGwgbW9jayBjbGllbnRzICovXG4gIGFsbENsaWVudHM6IE1vY2tScGNDbGllbnRbXSA9IFtdO1xuICAvKiogQ291bnRlciBmb3IgdW5pcXVlIHNlc3Npb24gSURzIGFjcm9zcyBtdWx0aXBsZSBzZXNzaW9ucyAqL1xuICBwcml2YXRlIHNlc3Npb25Db3VudGVyID0gMDtcbiAgLyoqIENvbnRyb2w6IHNldCB0byBtYWtlIHN0YXJ0U2Vzc2lvbiBmYWlsIGR1cmluZyBpbml0ICovXG4gIG5leHRJbml0RXJyb3I6IEVycm9yIHwgbnVsbCA9IG51bGw7XG4gIC8qKiBDb250cm9sOiBzZXQgdG8gbWFrZSBzdGFydFNlc3Npb24gZmFpbCBkdXJpbmcgc3RhcnQgKi9cbiAgbmV4dFN0YXJ0RXJyb3I6IEVycm9yIHwgbnVsbCA9IG51bGw7XG5cbiAgb3ZlcnJpZGUgYXN5bmMgc3RhcnRTZXNzaW9uKHByb2plY3REaXI6IHN0cmluZywgb3B0aW9uczogeyBjbGlQYXRoPzogc3RyaW5nOyBjb21tYW5kPzogc3RyaW5nOyBtb2RlbD86IHN0cmluZzsgYmFyZT86IGJvb2xlYW4gfSA9IHt9KTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgICBpZiAoIXByb2plY3REaXIgfHwgcHJvamVjdERpci50cmltKCkgPT09ICcnKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ3Byb2plY3REaXIgaXMgcmVxdWlyZWQgYW5kIGNhbm5vdCBiZSBlbXB0eScpO1xuICAgIH1cblxuICAgIGNvbnN0IHJlc29sdmVkRGlyID0gcmVzb2x2ZShwcm9qZWN0RGlyKTtcblxuICAgIC8vIE1pcnJvciB0aGUgcmVhbCBTZXNzaW9uTWFuYWdlciAoIzQ0NzYpOiBvbmx5IGJsb2NrIHdoZW4gYSBnZW51aW5lbHlcbiAgICAvLyBhY3RpdmUgc2Vzc2lvbiBpcyBydW5uaW5nLiBUZXJtaW5hbCBzdGF0ZXMgYXJlIGV2aWN0ZWQuXG4gICAgY29uc3QgZXhpc3RpbmcgPSB0aGlzLmdldFNlc3Npb25CeURpcihyZXNvbHZlZERpcik7XG4gICAgaWYgKGV4aXN0aW5nKSB7XG4gICAgICBpZiAoZXhpc3Rpbmcuc3RhdHVzID09PSAnc3RhcnRpbmcnIHx8IGV4aXN0aW5nLnN0YXR1cyA9PT0gJ3J1bm5pbmcnIHx8IGV4aXN0aW5nLnN0YXR1cyA9PT0gJ2Jsb2NrZWQnKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBgU2Vzc2lvbiBhbHJlYWR5IGFjdGl2ZSBmb3IgJHtyZXNvbHZlZERpcn0gKHNlc3Npb25JZDogJHtleGlzdGluZy5zZXNzaW9uSWR9LCBzdGF0dXM6ICR7ZXhpc3Rpbmcuc3RhdHVzfSlgXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBleGlzdGluZy51bnN1YnNjcmliZT8uKCk7XG4gICAgICAodGhpcyBhcyBhbnkpLnNlc3Npb25zLmRlbGV0ZShyZXNvbHZlZERpcik7XG4gICAgfVxuXG4gICAgY29uc3QgY2xpZW50ID0gbmV3IE1vY2tScGNDbGllbnQoeyBjd2Q6IHJlc29sdmVkRGlyLCBhcmdzOiBbXSB9KTtcbiAgICBpZiAodGhpcy5uZXh0U3RhcnRFcnJvcikge1xuICAgICAgY2xpZW50LnN0YXJ0RXJyb3IgPSB0aGlzLm5leHRTdGFydEVycm9yO1xuICAgICAgdGhpcy5uZXh0U3RhcnRFcnJvciA9IG51bGw7XG4gICAgfVxuICAgIGlmICh0aGlzLm5leHRJbml0RXJyb3IpIHtcbiAgICAgIGNsaWVudC5pbml0RXJyb3IgPSB0aGlzLm5leHRJbml0RXJyb3I7XG4gICAgICB0aGlzLm5leHRJbml0RXJyb3IgPSBudWxsO1xuICAgIH1cblxuICAgIHRoaXMuc2Vzc2lvbkNvdW50ZXIrKztcbiAgICBjbGllbnQuaW5pdFNlc3Npb25JZCA9IGBtb2NrLXNlc3Npb24tJHtTdHJpbmcodGhpcy5zZXNzaW9uQ291bnRlcikucGFkU3RhcnQoMywgJzAnKX1gO1xuICAgIHRoaXMubGFzdENsaWVudCA9IGNsaWVudDtcbiAgICB0aGlzLmFsbENsaWVudHMucHVzaChjbGllbnQpO1xuXG4gICAgLy8gQ3JlYXRlIHRoZSBzZXNzaW9uIHNoZWxsXG4gICAgY29uc3Qgc2Vzc2lvbjogTWFuYWdlZFNlc3Npb24gPSB7XG4gICAgICBzZXNzaW9uSWQ6ICcnLFxuICAgICAgcHJvamVjdERpcjogcmVzb2x2ZWREaXIsXG4gICAgICBzdGF0dXM6ICdzdGFydGluZycsXG4gICAgICBjbGllbnQ6IGNsaWVudCBhcyBhbnksIC8vIGR1Y2stdHlwZWQgbW9ja1xuICAgICAgZXZlbnRzOiBbXSxcbiAgICAgIHBlbmRpbmdCbG9ja2VyOiBudWxsLFxuICAgICAgY29zdDogeyB0b3RhbENvc3Q6IDAsIHRva2VuczogeyBpbnB1dDogMCwgb3V0cHV0OiAwLCBjYWNoZVJlYWQ6IDAsIGNhY2hlV3JpdGU6IDAgfSB9LFxuICAgICAgc3RhcnRUaW1lOiBEYXRlLm5vdygpLFxuICAgIH07XG5cbiAgICAvLyBJbnNlcnQgaW50byBpbnRlcm5hbCBzZXNzaW9ucyBtYXAgXHUyMDE0IGFjY2VzcyB2aWEgcHJvdGVjdGVkIG1ldGhvZFxuICAgIHRoaXMuX3B1dFNlc3Npb24ocmVzb2x2ZWREaXIsIHNlc3Npb24pO1xuXG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IGNsaWVudC5zdGFydCgpO1xuXG4gICAgICBjb25zdCBpbml0UmVzdWx0ID0gYXdhaXQgY2xpZW50LmluaXQoKTtcbiAgICAgIHNlc3Npb24uc2Vzc2lvbklkID0gaW5pdFJlc3VsdC5zZXNzaW9uSWQ7XG4gICAgICBzZXNzaW9uLnN0YXR1cyA9ICdydW5uaW5nJztcblxuICAgICAgLy8gV2lyZSBldmVudCB0cmFja2luZyB1c2luZyB0aGUgc2FtZSBoYW5kbGVFdmVudCBsb2dpYyBhcyBwYXJlbnRcbiAgICAgIHNlc3Npb24udW5zdWJzY3JpYmUgPSBjbGllbnQub25FdmVudCgoZXZlbnQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB7XG4gICAgICAgIHRoaXMuX2hhbmRsZUV2ZW50KHNlc3Npb24sIGV2ZW50KTtcbiAgICAgIH0pO1xuXG4gICAgICAvLyBLaWNrIG9mZiBhdXRvLW1vZGVcbiAgICAgIGNvbnN0IGNvbW1hbmQgPSBvcHRpb25zLmNvbW1hbmQgPz8gJy9nc2QgYXV0byc7XG4gICAgICBhd2FpdCBjbGllbnQucHJvbXB0KGNvbW1hbmQpO1xuXG4gICAgICByZXR1cm4gc2Vzc2lvbi5zZXNzaW9uSWQ7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBzZXNzaW9uLnN0YXR1cyA9ICdlcnJvcic7XG4gICAgICBzZXNzaW9uLmVycm9yID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgICAgdHJ5IHsgYXdhaXQgY2xpZW50LnN0b3AoKTsgfSBjYXRjaCB7IC8qIHN3YWxsb3cgKi8gfVxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBGYWlsZWQgdG8gc3RhcnQgc2Vzc2lvbiBmb3IgJHtyZXNvbHZlZERpcn06ICR7c2Vzc2lvbi5lcnJvcn1gKTtcbiAgICB9XG4gIH1cblxuICAvKiogRXhwb3NlIGludGVybmFsIHNlc3Npb24gbWFwIGluc2VydGlvbiBmb3IgdGVzdGluZyAqL1xuICBfcHV0U2Vzc2lvbihrZXk6IHN0cmluZywgc2Vzc2lvbjogTWFuYWdlZFNlc3Npb24pOiB2b2lkIHtcbiAgICAvLyBBY2Nlc3MgdGhlIHByaXZhdGUgc2Vzc2lvbnMgbWFwIHZpYSBhbnkgY2FzdFxuICAgICh0aGlzIGFzIGFueSkuc2Vzc2lvbnMuc2V0KGtleSwgc2Vzc2lvbik7XG4gIH1cblxuICAvKiogRXhwb3NlIGhhbmRsZUV2ZW50IGZvciB0ZXN0aW5nICovXG4gIF9oYW5kbGVFdmVudChzZXNzaW9uOiBNYW5hZ2VkU2Vzc2lvbiwgZXZlbnQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogdm9pZCB7XG4gICAgKHRoaXMgYXMgYW55KS5oYW5kbGVFdmVudChzZXNzaW9uLCBldmVudCk7XG4gIH1cbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBUZXN0IGhlbHBlcnNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5sZXQgYWxsTWFuYWdlcnM6IFRlc3RhYmxlU2Vzc2lvbk1hbmFnZXJbXSA9IFtdO1xuXG5mdW5jdGlvbiBjcmVhdGVNYW5hZ2VyKCk6IFRlc3RhYmxlU2Vzc2lvbk1hbmFnZXIge1xuICBjb25zdCBtZ3IgPSBuZXcgVGVzdGFibGVTZXNzaW9uTWFuYWdlcigpO1xuICBhbGxNYW5hZ2Vycy5wdXNoKG1ncik7XG4gIHJldHVybiBtZ3I7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gU2Vzc2lvbk1hbmFnZXIgdW5pdCB0ZXN0c1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmRlc2NyaWJlKCdTZXNzaW9uTWFuYWdlcicsICgpID0+IHtcbiAgbGV0IHNtOiBUZXN0YWJsZVNlc3Npb25NYW5hZ2VyO1xuXG4gIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgIHNtID0gY3JlYXRlTWFuYWdlcigpO1xuICB9KTtcblxuICBhZnRlckVhY2goYXN5bmMgKCkgPT4ge1xuICAgIGZvciAoY29uc3QgbWdyIG9mIGFsbE1hbmFnZXJzKSB7XG4gICAgICBhd2FpdCBtZ3IuY2xlYW51cCgpO1xuICAgIH1cbiAgICBhbGxNYW5hZ2VycyA9IFtdO1xuICB9KTtcblxuICBpdCgnc3RhcnRTZXNzaW9uIGNyZWF0ZXMgc2Vzc2lvbiBhbmQgcmV0dXJucyBzZXNzaW9uSWQnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3Qgc2Vzc2lvbklkID0gYXdhaXQgc20uc3RhcnRTZXNzaW9uKCcvdG1wL3Rlc3QtcHJvamVjdCcsIHsgY2xpUGF0aDogJy91c3IvYmluL2dzZCcgfSk7XG4gICAgYXNzZXJ0LmVxdWFsKHNlc3Npb25JZCwgJ21vY2stc2Vzc2lvbi0wMDEnKTtcblxuICAgIGNvbnN0IHNlc3Npb24gPSBzbS5nZXRTZXNzaW9uKHNlc3Npb25JZCk7XG4gICAgYXNzZXJ0Lm9rKHNlc3Npb24pO1xuICAgIGFzc2VydC5lcXVhbChzZXNzaW9uLnN0YXR1cywgJ3J1bm5pbmcnKTtcbiAgICBhc3NlcnQuZXF1YWwoc2Vzc2lvbi5wcm9qZWN0RGlyLCByZXNvbHZlKCcvdG1wL3Rlc3QtcHJvamVjdCcpKTtcbiAgfSk7XG5cbiAgaXQoJ3N0YXJ0U2Vzc2lvbiBzZW5kcyAvZ3NkIGF1dG8gYnkgZGVmYXVsdCcsIGFzeW5jICgpID0+IHtcbiAgICBhd2FpdCBzbS5zdGFydFNlc3Npb24oJy90bXAvdGVzdC1wcm9tcHQnLCB7IGNsaVBhdGg6ICcvdXNyL2Jpbi9nc2QnIH0pO1xuICAgIGFzc2VydC5vayhzbS5sYXN0Q2xpZW50KTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHNtLmxhc3RDbGllbnQucHJvbXB0ZWQsIFsnL2dzZCBhdXRvJ10pO1xuICB9KTtcblxuICBpdCgnc3RhcnRTZXNzaW9uIHNlbmRzIGN1c3RvbSBjb21tYW5kIHdoZW4gcHJvdmlkZWQnLCBhc3luYyAoKSA9PiB7XG4gICAgYXdhaXQgc20uc3RhcnRTZXNzaW9uKCcvdG1wL3Rlc3QtY21kJywgeyBjbGlQYXRoOiAnL3Vzci9iaW4vZ3NkJywgY29tbWFuZDogJy9nc2QgYXV0byAtLXJlc3VtZScgfSk7XG4gICAgYXNzZXJ0Lm9rKHNtLmxhc3RDbGllbnQpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwoc20ubGFzdENsaWVudC5wcm9tcHRlZCwgWycvZ3NkIGF1dG8gLS1yZXN1bWUnXSk7XG4gIH0pO1xuXG4gIGl0KCdzdGFydFNlc3Npb24gcmVqZWN0cyBkdXBsaWNhdGUgcHJvamVjdERpcicsIGFzeW5jICgpID0+IHtcbiAgICBhd2FpdCBzbS5zdGFydFNlc3Npb24oJy90bXAvZHVwLXRlc3QnLCB7IGNsaVBhdGg6ICcvdXNyL2Jpbi9nc2QnIH0pO1xuICAgIGF3YWl0IGFzc2VydC5yZWplY3RzKFxuICAgICAgKCkgPT4gc20uc3RhcnRTZXNzaW9uKCcvdG1wL2R1cC10ZXN0JywgeyBjbGlQYXRoOiAnL3Vzci9iaW4vZ3NkJyB9KSxcbiAgICAgIChlcnI6IEVycm9yKSA9PiB7XG4gICAgICAgIGFzc2VydC5vayhlcnIubWVzc2FnZS5pbmNsdWRlcygnU2Vzc2lvbiBhbHJlYWR5IGFjdGl2ZScpKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9LFxuICAgICk7XG4gIH0pO1xuXG4gIC8vICM0NDc2OiB0ZXJtaW5hbC1zdGF0ZSBzZXNzaW9ucyAoY29tcGxldGVkL2Vycm9yL2NhbmNlbGxlZCkgYXJlIGV2aWN0ZWQgc29cbiAgLy8gdGhlIHNhbWUgcHJvamVjdERpciBjYW4gaG9zdCBhIGZyZXNoIHNlc3Npb24gXHUyMDE0IG9ubHkgc3RhcnRpbmcvcnVubmluZy9ibG9ja2VkXG4gIC8vIHNlc3Npb25zIGJsb2NrIHJlLWVudHJ5LlxuICBmb3IgKGNvbnN0IHRlcm1pbmFsU3RhdHVzIG9mIFsnY29tcGxldGVkJywgJ2Vycm9yJywgJ2NhbmNlbGxlZCddIGFzIGNvbnN0KSB7XG4gICAgaXQoYHN0YXJ0U2Vzc2lvbiBldmljdHMgYSBwcmlvciAnJHt0ZXJtaW5hbFN0YXR1c30nIHNlc3Npb24gZm9yIHRoZSBzYW1lIHByb2plY3REaXJgLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBkaXIgPSBgL3RtcC9ldmljdC0ke3Rlcm1pbmFsU3RhdHVzfWA7XG4gICAgICBjb25zdCBmaXJzdFNlc3Npb25JZCA9IGF3YWl0IHNtLnN0YXJ0U2Vzc2lvbihkaXIsIHsgY2xpUGF0aDogJy91c3IvYmluL2dzZCcgfSk7XG4gICAgICBjb25zdCBmaXJzdCA9IHNtLmdldFNlc3Npb24oZmlyc3RTZXNzaW9uSWQpITtcbiAgICAgIGZpcnN0LnN0YXR1cyA9IHRlcm1pbmFsU3RhdHVzO1xuXG4gICAgICAvLyBTaG91bGQgbm90IHRocm93IFx1MjAxNCB0ZXJtaW5hbCBzZXNzaW9uIGlzIGV2aWN0ZWQsIGZyZXNoIG9uZSBzdGFydHMuXG4gICAgICBjb25zdCBzZWNvbmRTZXNzaW9uSWQgPSBhd2FpdCBzbS5zdGFydFNlc3Npb24oZGlyLCB7IGNsaVBhdGg6ICcvdXNyL2Jpbi9nc2QnIH0pO1xuICAgICAgYXNzZXJ0Lm5vdEVxdWFsKHNlY29uZFNlc3Npb25JZCwgZmlyc3RTZXNzaW9uSWQpO1xuICAgICAgY29uc3Qgc2Vjb25kID0gc20uZ2V0U2Vzc2lvbihzZWNvbmRTZXNzaW9uSWQpITtcbiAgICAgIGFzc2VydC5lcXVhbChzZWNvbmQuc3RhdHVzLCAncnVubmluZycpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHNtLmdldFNlc3Npb25CeURpcihkaXIpIS5zZXNzaW9uSWQsIHNlY29uZFNlc3Npb25JZCk7XG4gICAgfSk7XG4gIH1cblxuICBmb3IgKGNvbnN0IGFjdGl2ZVN0YXR1cyBvZiBbJ3N0YXJ0aW5nJywgJ3J1bm5pbmcnLCAnYmxvY2tlZCddIGFzIGNvbnN0KSB7XG4gICAgaXQoYHN0YXJ0U2Vzc2lvbiBzdGlsbCByZWplY3RzIGEgcHJpb3IgJyR7YWN0aXZlU3RhdHVzfScgc2Vzc2lvbmAsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IGRpciA9IGAvdG1wL2tlZXAtJHthY3RpdmVTdGF0dXN9YDtcbiAgICAgIGNvbnN0IHNpZCA9IGF3YWl0IHNtLnN0YXJ0U2Vzc2lvbihkaXIsIHsgY2xpUGF0aDogJy91c3IvYmluL2dzZCcgfSk7XG4gICAgICBzbS5nZXRTZXNzaW9uKHNpZCkhLnN0YXR1cyA9IGFjdGl2ZVN0YXR1cztcbiAgICAgIGF3YWl0IGFzc2VydC5yZWplY3RzKFxuICAgICAgICAoKSA9PiBzbS5zdGFydFNlc3Npb24oZGlyLCB7IGNsaVBhdGg6ICcvdXNyL2Jpbi9nc2QnIH0pLFxuICAgICAgICAvU2Vzc2lvbiBhbHJlYWR5IGFjdGl2ZS8sXG4gICAgICApO1xuICAgIH0pO1xuICB9XG5cbiAgaXQoJ3N0YXJ0U2Vzc2lvbiByZWplY3RzIGVtcHR5IHByb2plY3REaXInLCBhc3luYyAoKSA9PiB7XG4gICAgYXdhaXQgYXNzZXJ0LnJlamVjdHMoXG4gICAgICAoKSA9PiBzbS5zdGFydFNlc3Npb24oJycsIHsgY2xpUGF0aDogJy91c3IvYmluL2dzZCcgfSksXG4gICAgICAoZXJyOiBFcnJvcikgPT4ge1xuICAgICAgICBhc3NlcnQub2soZXJyLm1lc3NhZ2UuaW5jbHVkZXMoJ3Byb2plY3REaXIgaXMgcmVxdWlyZWQnKSk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfSxcbiAgICApO1xuICB9KTtcblxuICBpdCgnc3RhcnRTZXNzaW9uIHNldHMgZXJyb3Igc3RhdHVzIG9uIHN0YXJ0KCkgZmFpbHVyZScsIGFzeW5jICgpID0+IHtcbiAgICBzbS5uZXh0U3RhcnRFcnJvciA9IG5ldyBFcnJvcignc3Bhd24gZmFpbGVkJyk7XG5cbiAgICBhd2FpdCBhc3NlcnQucmVqZWN0cyhcbiAgICAgICgpID0+IHNtLnN0YXJ0U2Vzc2lvbignL3RtcC9mYWlsLXN0YXJ0JywgeyBjbGlQYXRoOiAnL3Vzci9iaW4vZ3NkJyB9KSxcbiAgICAgIChlcnI6IEVycm9yKSA9PiB7XG4gICAgICAgIGFzc2VydC5vayhlcnIubWVzc2FnZS5pbmNsdWRlcygnRmFpbGVkIHRvIHN0YXJ0IHNlc3Npb24nKSk7XG4gICAgICAgIGFzc2VydC5vayhlcnIubWVzc2FnZS5pbmNsdWRlcygnc3Bhd24gZmFpbGVkJykpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH0sXG4gICAgKTtcbiAgfSk7XG5cbiAgaXQoJ3N0YXJ0U2Vzc2lvbiBzZXRzIGVycm9yIHN0YXR1cyBvbiBpbml0KCkgZmFpbHVyZScsIGFzeW5jICgpID0+IHtcbiAgICBzbS5uZXh0SW5pdEVycm9yID0gbmV3IEVycm9yKCdoYW5kc2hha2UgZmFpbGVkJyk7XG5cbiAgICBhd2FpdCBhc3NlcnQucmVqZWN0cyhcbiAgICAgICgpID0+IHNtLnN0YXJ0U2Vzc2lvbignL3RtcC9mYWlsLWluaXQnLCB7IGNsaVBhdGg6ICcvdXNyL2Jpbi9nc2QnIH0pLFxuICAgICAgKGVycjogRXJyb3IpID0+IHtcbiAgICAgICAgYXNzZXJ0Lm9rKGVyci5tZXNzYWdlLmluY2x1ZGVzKCdGYWlsZWQgdG8gc3RhcnQgc2Vzc2lvbicpKTtcbiAgICAgICAgYXNzZXJ0Lm9rKGVyci5tZXNzYWdlLmluY2x1ZGVzKCdoYW5kc2hha2UgZmFpbGVkJykpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH0sXG4gICAgKTtcbiAgfSk7XG5cbiAgaXQoJ2dldFNlc3Npb24gcmV0dXJucyB1bmRlZmluZWQgZm9yIHVua25vd24gc2Vzc2lvbklkJywgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IHNtLmdldFNlc3Npb24oJ25vbmV4aXN0ZW50LWlkJyk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgdW5kZWZpbmVkKTtcbiAgfSk7XG5cbiAgaXQoJ2dldFNlc3Npb25CeURpciByZXR1cm5zIHNlc3Npb24gZm9yIGtub3duIGRpcicsIGFzeW5jICgpID0+IHtcbiAgICBhd2FpdCBzbS5zdGFydFNlc3Npb24oJy90bXAvYnktZGlyJywgeyBjbGlQYXRoOiAnL3Vzci9iaW4vZ3NkJyB9KTtcbiAgICBjb25zdCBzZXNzaW9uID0gc20uZ2V0U2Vzc2lvbkJ5RGlyKCcvdG1wL2J5LWRpcicpO1xuICAgIGFzc2VydC5vayhzZXNzaW9uKTtcbiAgICBhc3NlcnQuZXF1YWwoc2Vzc2lvbi5zZXNzaW9uSWQsICdtb2NrLXNlc3Npb24tMDAxJyk7XG4gIH0pO1xuXG4gIGl0KCdyZXNvbHZlQmxvY2tlciBlcnJvcnMgd2hlbiBubyBwZW5kaW5nIGJsb2NrZXInLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3Qgc2Vzc2lvbklkID0gYXdhaXQgc20uc3RhcnRTZXNzaW9uKCcvdG1wL25vLWJsb2NrZXInLCB7IGNsaVBhdGg6ICcvdXNyL2Jpbi9nc2QnIH0pO1xuICAgIGF3YWl0IGFzc2VydC5yZWplY3RzKFxuICAgICAgKCkgPT4gc20ucmVzb2x2ZUJsb2NrZXIoc2Vzc2lvbklkLCAnc29tZSByZXNwb25zZScpLFxuICAgICAgKGVycjogRXJyb3IpID0+IHtcbiAgICAgICAgYXNzZXJ0Lm9rKGVyci5tZXNzYWdlLmluY2x1ZGVzKCdObyBwZW5kaW5nIGJsb2NrZXInKSk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfSxcbiAgICApO1xuICB9KTtcblxuICBpdCgncmVzb2x2ZUJsb2NrZXIgZXJyb3JzIGZvciB1bmtub3duIHNlc3Npb24nLCBhc3luYyAoKSA9PiB7XG4gICAgYXdhaXQgYXNzZXJ0LnJlamVjdHMoXG4gICAgICAoKSA9PiBzbS5yZXNvbHZlQmxvY2tlcigndW5rbm93bi1zZXNzaW9uJywgJ3NvbWUgcmVzcG9uc2UnKSxcbiAgICAgIChlcnI6IEVycm9yKSA9PiB7XG4gICAgICAgIGFzc2VydC5vayhlcnIubWVzc2FnZS5pbmNsdWRlcygnU2Vzc2lvbiBub3QgZm91bmQnKSk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfSxcbiAgICApO1xuICB9KTtcblxuICBpdCgncmVzb2x2ZUJsb2NrZXIgY2xlYXJzIHBlbmRpbmdCbG9ja2VyIGFuZCBzZW5kcyBVSSByZXNwb25zZScsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBzZXNzaW9uSWQgPSBhd2FpdCBzbS5zdGFydFNlc3Npb24oJy90bXAvYmxvY2tlci1yZXNvbHZlJywgeyBjbGlQYXRoOiAnL3Vzci9iaW4vZ3NkJyB9KTtcbiAgICBjb25zdCBjbGllbnQgPSBzbS5sYXN0Q2xpZW50ITtcblxuICAgIC8vIFNpbXVsYXRlIGEgYmxvY2tpbmcgVUkgcmVxdWVzdCBldmVudFxuICAgIGNsaWVudC5lbWl0RXZlbnQoe1xuICAgICAgdHlwZTogJ2V4dGVuc2lvbl91aV9yZXF1ZXN0JyxcbiAgICAgIGlkOiAncmVxLTQyJyxcbiAgICAgIG1ldGhvZDogJ3NlbGVjdCcsXG4gICAgICB0aXRsZTogJ1BpY2sgYW4gb3B0aW9uJyxcbiAgICB9KTtcblxuICAgIGNvbnN0IHNlc3Npb24gPSBzbS5nZXRTZXNzaW9uKHNlc3Npb25JZCkhO1xuICAgIGFzc2VydC5vayhzZXNzaW9uLnBlbmRpbmdCbG9ja2VyKTtcbiAgICBhc3NlcnQuZXF1YWwoc2Vzc2lvbi5zdGF0dXMsICdibG9ja2VkJyk7XG5cbiAgICAvLyBSZXNvbHZlIHRoZSBibG9ja2VyXG4gICAgYXdhaXQgc20ucmVzb2x2ZUJsb2NrZXIoc2Vzc2lvbklkLCAnb3B0aW9uLWEnKTtcblxuICAgIGFzc2VydC5lcXVhbChzZXNzaW9uLnBlbmRpbmdCbG9ja2VyLCBudWxsKTtcbiAgICBhc3NlcnQuZXF1YWwoc2Vzc2lvbi5zdGF0dXMsICdydW5uaW5nJyk7XG4gICAgYXNzZXJ0LmVxdWFsKGNsaWVudC51aVJlc3BvbnNlcy5sZW5ndGgsIDEpO1xuICAgIGFzc2VydC5lcXVhbChjbGllbnQudWlSZXNwb25zZXNbMF0ucmVxdWVzdElkLCAncmVxLTQyJyk7XG4gIH0pO1xuXG4gIGl0KCdjYW5jZWxTZXNzaW9uIGNhbGxzIGFib3J0ICsgc3RvcCBvbiBjbGllbnQnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3Qgc2Vzc2lvbklkID0gYXdhaXQgc20uc3RhcnRTZXNzaW9uKCcvdG1wL2NhbmNlbC10ZXN0JywgeyBjbGlQYXRoOiAnL3Vzci9iaW4vZ3NkJyB9KTtcbiAgICBjb25zdCBjbGllbnQgPSBzbS5sYXN0Q2xpZW50ITtcblxuICAgIGF3YWl0IHNtLmNhbmNlbFNlc3Npb24oc2Vzc2lvbklkKTtcblxuICAgIGFzc2VydC5vayhjbGllbnQuYWJvcnRlZCk7XG4gICAgYXNzZXJ0Lm9rKGNsaWVudC5zdG9wcGVkKTtcblxuICAgIGNvbnN0IHNlc3Npb24gPSBzbS5nZXRTZXNzaW9uKHNlc3Npb25JZCkhO1xuICAgIGFzc2VydC5lcXVhbChzZXNzaW9uLnN0YXR1cywgJ2NhbmNlbGxlZCcpO1xuICB9KTtcblxuICBpdCgnY2FuY2VsU2Vzc2lvbiBlcnJvcnMgZm9yIHVua25vd24gc2Vzc2lvbicsIGFzeW5jICgpID0+IHtcbiAgICBhd2FpdCBhc3NlcnQucmVqZWN0cyhcbiAgICAgICgpID0+IHNtLmNhbmNlbFNlc3Npb24oJ3Vua25vd24nKSxcbiAgICAgIChlcnI6IEVycm9yKSA9PiB7XG4gICAgICAgIGFzc2VydC5vayhlcnIubWVzc2FnZS5pbmNsdWRlcygnU2Vzc2lvbiBub3QgZm91bmQnKSk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfSxcbiAgICApO1xuICB9KTtcblxuICBpdCgnY2xlYW51cCBzdG9wcyBhbGwgYWN0aXZlIHNlc3Npb25zJywgYXN5bmMgKCkgPT4ge1xuICAgIGF3YWl0IHNtLnN0YXJ0U2Vzc2lvbignL3RtcC9jbGVhbnVwLTEnLCB7IGNsaVBhdGg6ICcvdXNyL2Jpbi9nc2QnIH0pO1xuICAgIGF3YWl0IHNtLnN0YXJ0U2Vzc2lvbignL3RtcC9jbGVhbnVwLTInLCB7IGNsaVBhdGg6ICcvdXNyL2Jpbi9nc2QnIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHNtLmFsbENsaWVudHMubGVuZ3RoLCAyKTtcblxuICAgIGF3YWl0IHNtLmNsZWFudXAoKTtcblxuICAgIGZvciAoY29uc3QgY2xpZW50IG9mIHNtLmFsbENsaWVudHMpIHtcbiAgICAgIGFzc2VydC5vayhjbGllbnQuc3RvcHBlZCwgJ0NsaWVudCBzaG91bGQgYmUgc3RvcHBlZCBhZnRlciBjbGVhbnVwJyk7XG4gICAgfVxuICB9KTtcblxuICBpdCgnZXZlbnQgcmluZyBidWZmZXIgY2FwcyBhdCBNQVhfRVZFTlRTJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHNlc3Npb25JZCA9IGF3YWl0IHNtLnN0YXJ0U2Vzc2lvbignL3RtcC9yaW5nLWJ1ZmZlcicsIHsgY2xpUGF0aDogJy91c3IvYmluL2dzZCcgfSk7XG4gICAgY29uc3QgY2xpZW50ID0gc20ubGFzdENsaWVudCE7XG5cbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IE1BWF9FVkVOVFMgKyAyMDsgaSsrKSB7XG4gICAgICBjbGllbnQuZW1pdEV2ZW50KHsgdHlwZTogJ3Rvb2xfdXNlJywgaW5kZXg6IGkgfSk7XG4gICAgfVxuXG4gICAgY29uc3Qgc2Vzc2lvbiA9IHNtLmdldFNlc3Npb24oc2Vzc2lvbklkKSE7XG4gICAgYXNzZXJ0LmVxdWFsKHNlc3Npb24uZXZlbnRzLmxlbmd0aCwgTUFYX0VWRU5UUyk7XG4gICAgLy8gT2xkZXN0IGV2ZW50cyB0cmltbWVkIFx1MjAxNCBmaXJzdCBldmVudCBpbmRleCBzaG91bGQgYmUgMjBcbiAgICBhc3NlcnQuZXF1YWwoKHNlc3Npb24uZXZlbnRzWzBdIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KS5pbmRleCwgMjApO1xuICB9KTtcblxuICBpdCgnYmxvY2tlciBkZXRlY3Rpb246IG5vbi1maXJlLWFuZC1mb3JnZXQgZXh0ZW5zaW9uX3VpX3JlcXVlc3Qgc2V0cyBwZW5kaW5nQmxvY2tlcicsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBzZXNzaW9uSWQgPSBhd2FpdCBzbS5zdGFydFNlc3Npb24oJy90bXAvYmxvY2tlci1kZXRlY3QnLCB7IGNsaVBhdGg6ICcvdXNyL2Jpbi9nc2QnIH0pO1xuICAgIGNvbnN0IGNsaWVudCA9IHNtLmxhc3RDbGllbnQhO1xuXG4gICAgLy8gJ3NlbGVjdCcgaXMgbm90IGluIEZJUkVfQU5EX0ZPUkdFVF9NRVRIT0RTXG4gICAgY2xpZW50LmVtaXRFdmVudCh7XG4gICAgICB0eXBlOiAnZXh0ZW5zaW9uX3VpX3JlcXVlc3QnLFxuICAgICAgaWQ6ICdyZXEtOTknLFxuICAgICAgbWV0aG9kOiAnc2VsZWN0JyxcbiAgICAgIHRpdGxlOiAnQ2hvb3NlIHdpc2VseScsXG4gICAgfSk7XG5cbiAgICBjb25zdCBzZXNzaW9uID0gc20uZ2V0U2Vzc2lvbihzZXNzaW9uSWQpITtcbiAgICBhc3NlcnQuZXF1YWwoc2Vzc2lvbi5zdGF0dXMsICdibG9ja2VkJyk7XG4gICAgYXNzZXJ0Lm9rKHNlc3Npb24ucGVuZGluZ0Jsb2NrZXIpO1xuICAgIGFzc2VydC5lcXVhbChzZXNzaW9uLnBlbmRpbmdCbG9ja2VyLmlkLCAncmVxLTk5Jyk7XG4gICAgYXNzZXJ0LmVxdWFsKHNlc3Npb24ucGVuZGluZ0Jsb2NrZXIubWV0aG9kLCAnc2VsZWN0Jyk7XG4gIH0pO1xuXG4gIGl0KCdmaXJlLWFuZC1mb3JnZXQgbWV0aG9kcyBkbyBub3Qgc2V0IHBlbmRpbmdCbG9ja2VyJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHNlc3Npb25JZCA9IGF3YWl0IHNtLnN0YXJ0U2Vzc2lvbignL3RtcC9maXJlLWZvcmdldCcsIHsgY2xpUGF0aDogJy91c3IvYmluL2dzZCcgfSk7XG4gICAgY29uc3QgY2xpZW50ID0gc20ubGFzdENsaWVudCE7XG5cbiAgICAvLyAnbm90aWZ5JyBpcyBmaXJlLWFuZC1mb3JnZXQgXHUyMDE0IG9uIGl0cyBvd24gKG5vIHRlcm1pbmFsIHByZWZpeCkgc2hvdWxkIG5vdCBibG9ja1xuICAgIGNsaWVudC5lbWl0RXZlbnQoe1xuICAgICAgdHlwZTogJ2V4dGVuc2lvbl91aV9yZXF1ZXN0JyxcbiAgICAgIGlkOiAncmVxLTEwMCcsXG4gICAgICBtZXRob2Q6ICdub3RpZnknLFxuICAgICAgbWVzc2FnZTogJ0p1c3QgYSBub3RpZmljYXRpb24nLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgc2Vzc2lvbiA9IHNtLmdldFNlc3Npb24oc2Vzc2lvbklkKSE7XG4gICAgYXNzZXJ0LmVxdWFsKHNlc3Npb24uc3RhdHVzLCAncnVubmluZycpO1xuICAgIGFzc2VydC5lcXVhbChzZXNzaW9uLnBlbmRpbmdCbG9ja2VyLCBudWxsKTtcbiAgfSk7XG5cbiAgaXQoJ3Rlcm1pbmFsIGRldGVjdGlvbjogYXV0by1tb2RlIHN0b3BwZWQgc2V0cyBzdGF0dXMgdG8gY29tcGxldGVkJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHNlc3Npb25JZCA9IGF3YWl0IHNtLnN0YXJ0U2Vzc2lvbignL3RtcC90ZXJtaW5hbCcsIHsgY2xpUGF0aDogJy91c3IvYmluL2dzZCcgfSk7XG4gICAgY29uc3QgY2xpZW50ID0gc20ubGFzdENsaWVudCE7XG5cbiAgICBjbGllbnQuZW1pdEV2ZW50KHtcbiAgICAgIHR5cGU6ICdleHRlbnNpb25fdWlfcmVxdWVzdCcsXG4gICAgICBtZXRob2Q6ICdub3RpZnknLFxuICAgICAgbWVzc2FnZTogJ0F1dG8tbW9kZSBzdG9wcGVkIFx1MjAxNCBhbGwgdGFza3MgY29tcGxldGUnLFxuICAgICAgaWQ6ICd0ZXJtLTEnLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgc2Vzc2lvbiA9IHNtLmdldFNlc3Npb24oc2Vzc2lvbklkKSE7XG4gICAgYXNzZXJ0LmVxdWFsKHNlc3Npb24uc3RhdHVzLCAnY29tcGxldGVkJyk7XG4gIH0pO1xuXG4gIGl0KCd0ZXJtaW5hbCBkZXRlY3Rpb24gd2l0aCBibG9ja2VkOiBtZXNzYWdlIHNldHMgc3RhdHVzIHRvIGJsb2NrZWQnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3Qgc2Vzc2lvbklkID0gYXdhaXQgc20uc3RhcnRTZXNzaW9uKCcvdG1wL3Rlcm1pbmFsLWJsb2NrZWQnLCB7IGNsaVBhdGg6ICcvdXNyL2Jpbi9nc2QnIH0pO1xuICAgIGNvbnN0IGNsaWVudCA9IHNtLmxhc3RDbGllbnQhO1xuXG4gICAgY2xpZW50LmVtaXRFdmVudCh7XG4gICAgICB0eXBlOiAnZXh0ZW5zaW9uX3VpX3JlcXVlc3QnLFxuICAgICAgbWV0aG9kOiAnbm90aWZ5JyxcbiAgICAgIG1lc3NhZ2U6ICdBdXRvLW1vZGUgc3RvcHBlZCBcdTIwMTQgYmxvY2tlZDogbmVlZHMgdXNlciBpbnB1dCcsXG4gICAgICBpZDogJ2Jsb2NrLTEnLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgc2Vzc2lvbiA9IHNtLmdldFNlc3Npb24oc2Vzc2lvbklkKSE7XG4gICAgYXNzZXJ0LmVxdWFsKHNlc3Npb24uc3RhdHVzLCAnYmxvY2tlZCcpO1xuICAgIGFzc2VydC5vayhzZXNzaW9uLnBlbmRpbmdCbG9ja2VyKTtcbiAgfSk7XG5cbiAgaXQoJ2Nvc3QgdHJhY2tpbmc6IGN1bXVsYXRpdmUtbWF4IGZyb20gY29zdF91cGRhdGUgZXZlbnRzJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHNlc3Npb25JZCA9IGF3YWl0IHNtLnN0YXJ0U2Vzc2lvbignL3RtcC9jb3N0LXRyYWNrJywgeyBjbGlQYXRoOiAnL3Vzci9iaW4vZ3NkJyB9KTtcbiAgICBjb25zdCBjbGllbnQgPSBzbS5sYXN0Q2xpZW50ITtcblxuICAgIGNsaWVudC5lbWl0RXZlbnQoe1xuICAgICAgdHlwZTogJ2Nvc3RfdXBkYXRlJyxcbiAgICAgIGN1bXVsYXRpdmVDb3N0OiAwLjA1LFxuICAgICAgdG9rZW5zOiB7IGlucHV0OiAxMDAwLCBvdXRwdXQ6IDUwMCwgY2FjaGVSZWFkOiAyMDAsIGNhY2hlV3JpdGU6IDEwMCB9LFxuICAgIH0pO1xuXG4gICAgY2xpZW50LmVtaXRFdmVudCh7XG4gICAgICB0eXBlOiAnY29zdF91cGRhdGUnLFxuICAgICAgY3VtdWxhdGl2ZUNvc3Q6IDAuMTIsXG4gICAgICB0b2tlbnM6IHsgaW5wdXQ6IDI1MDAsIG91dHB1dDogODAwLCBjYWNoZVJlYWQ6IDE1MCwgY2FjaGVXcml0ZTogMzAwIH0sXG4gICAgfSk7XG5cbiAgICBjb25zdCBzZXNzaW9uID0gc20uZ2V0U2Vzc2lvbihzZXNzaW9uSWQpITtcbiAgICBhc3NlcnQuZXF1YWwoc2Vzc2lvbi5jb3N0LnRvdGFsQ29zdCwgMC4xMik7XG4gICAgYXNzZXJ0LmVxdWFsKHNlc3Npb24uY29zdC50b2tlbnMuaW5wdXQsIDI1MDApO1xuICAgIGFzc2VydC5lcXVhbChzZXNzaW9uLmNvc3QudG9rZW5zLm91dHB1dCwgODAwKTtcbiAgICBhc3NlcnQuZXF1YWwoc2Vzc2lvbi5jb3N0LnRva2Vucy5jYWNoZVJlYWQsIDIwMCk7IC8vIEZpcnN0IHdhcyBoaWdoZXJcbiAgICBhc3NlcnQuZXF1YWwoc2Vzc2lvbi5jb3N0LnRva2Vucy5jYWNoZVdyaXRlLCAzMDApOyAvLyBTZWNvbmQgd2FzIGhpZ2hlclxuICB9KTtcblxuICBpdCgnZ2V0UmVzdWx0IHJldHVybnMgSGVhZGxlc3NKc29uUmVzdWx0LXNoYXBlZCBvYmplY3QnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3Qgc2Vzc2lvbklkID0gYXdhaXQgc20uc3RhcnRTZXNzaW9uKCcvdG1wL3Jlc3VsdC1zaGFwZScsIHsgY2xpUGF0aDogJy91c3IvYmluL2dzZCcgfSk7XG4gICAgY29uc3QgcmVzdWx0ID0gc20uZ2V0UmVzdWx0KHNlc3Npb25JZCk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnNlc3Npb25JZCwgc2Vzc2lvbklkKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnByb2plY3REaXIsIHJlc29sdmUoJy90bXAvcmVzdWx0LXNoYXBlJykpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc3RhdHVzLCAncnVubmluZycpO1xuICAgIGFzc2VydC5lcXVhbCh0eXBlb2YgcmVzdWx0LmR1cmF0aW9uTXMsICdudW1iZXInKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmNvc3QpO1xuICAgIGFzc2VydC5vayhBcnJheS5pc0FycmF5KHJlc3VsdC5yZWNlbnRFdmVudHMpKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnBlbmRpbmdCbG9ja2VyLCBudWxsKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmVycm9yLCBudWxsKTtcbiAgfSk7XG5cbiAgaXQoJ2dldFJlc3VsdCBlcnJvcnMgZm9yIHVua25vd24gc2Vzc2lvbicsICgpID0+IHtcbiAgICBhc3NlcnQudGhyb3dzKFxuICAgICAgKCkgPT4gc20uZ2V0UmVzdWx0KCd1bmtub3duJyksXG4gICAgICAoZXJyOiBFcnJvcikgPT4ge1xuICAgICAgICBhc3NlcnQub2soZXJyLm1lc3NhZ2UuaW5jbHVkZXMoJ1Nlc3Npb24gbm90IGZvdW5kJykpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH0sXG4gICAgKTtcbiAgfSk7XG59KTtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBDTEkgcGF0aCByZXNvbHV0aW9uIHRlc3RzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZGVzY3JpYmUoJ1Nlc3Npb25NYW5hZ2VyLnJlc29sdmVDTElQYXRoJywgKCkgPT4ge1xuICBjb25zdCBvcmlnaW5hbEdzZFBhdGggPSBwcm9jZXNzLmVudlsnR1NEX0NMSV9QQVRIJ107XG4gIGNvbnN0IG9yaWdpbmFsUGF0aCA9IHByb2Nlc3MuZW52WydQQVRIJ107XG4gIGNvbnN0IG9yaWdpbmFsUGF0aFRpdGxlID0gcHJvY2Vzcy5lbnZbJ1BhdGgnXTtcblxuICBhZnRlckVhY2goKCkgPT4ge1xuICAgIGlmIChvcmlnaW5hbEdzZFBhdGggIT09IHVuZGVmaW5lZCkge1xuICAgICAgcHJvY2Vzcy5lbnZbJ0dTRF9DTElfUEFUSCddID0gb3JpZ2luYWxHc2RQYXRoO1xuICAgIH0gZWxzZSB7XG4gICAgICBkZWxldGUgcHJvY2Vzcy5lbnZbJ0dTRF9DTElfUEFUSCddO1xuICAgIH1cbiAgICBpZiAob3JpZ2luYWxQYXRoICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHByb2Nlc3MuZW52WydQQVRIJ10gPSBvcmlnaW5hbFBhdGg7XG4gICAgfSBlbHNlIHtcbiAgICAgIGRlbGV0ZSBwcm9jZXNzLmVudlsnUEFUSCddO1xuICAgIH1cbiAgICBpZiAob3JpZ2luYWxQYXRoVGl0bGUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgcHJvY2Vzcy5lbnZbJ1BhdGgnXSA9IG9yaWdpbmFsUGF0aFRpdGxlO1xuICAgIH0gZWxzZSB7XG4gICAgICBkZWxldGUgcHJvY2Vzcy5lbnZbJ1BhdGgnXTtcbiAgICB9XG4gIH0pO1xuXG4gIGl0KCdHU0RfQ0xJX1BBVEggZW52IHZhciB0YWtlcyBwcmVjZWRlbmNlJywgKCkgPT4ge1xuICAgIHByb2Nlc3MuZW52WydHU0RfQ0xJX1BBVEgnXSA9ICcvY3VzdG9tL3BhdGgvdG8vZ3NkJztcbiAgICBjb25zdCByZXN1bHQgPSBTZXNzaW9uTWFuYWdlci5yZXNvbHZlQ0xJUGF0aCgpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIHJlc29sdmUoJy9jdXN0b20vcGF0aC90by9nc2QnKSk7XG4gIH0pO1xuXG4gIGl0KCdmaW5kcyBnc2Qgb24gUEFUSCB3aXRob3V0IHNoZWxsaW5nIG91dCB0byB3aGljaCcsICgpID0+IHtcbiAgICBkZWxldGUgcHJvY2Vzcy5lbnZbJ0dTRF9DTElfUEFUSCddO1xuICAgIGNvbnN0IHRtcCA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksICdnc2QtY2xpLXBhdGgtJykpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzaGltTmFtZSA9IHByb2Nlc3MucGxhdGZvcm0gPT09ICd3aW4zMicgPyAnZ3NkLmNtZCcgOiAnZ3NkJztcbiAgICAgIGNvbnN0IHNoaW1QYXRoID0gam9pbih0bXAsIHNoaW1OYW1lKTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoc2hpbVBhdGgsICcnLCAndXRmOCcpO1xuICAgICAgcHJvY2Vzcy5lbnZbJ1BBVEgnXSA9IFt0bXAsIG9yaWdpbmFsUGF0aF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oZGVsaW1pdGVyKTtcblxuICAgICAgY29uc3QgcmVzb2x2ZWRQYXRoID0gU2Vzc2lvbk1hbmFnZXIucmVzb2x2ZUNMSVBhdGgoKTtcbiAgICAgIGlmIChwcm9jZXNzLnBsYXRmb3JtID09PSAnd2luMzInKSB7XG4gICAgICAgIGFzc2VydC5lcXVhbChyZXNvbHZlZFBhdGgudG9Mb3dlckNhc2UoKSwgcmVzb2x2ZShzaGltUGF0aCkudG9Mb3dlckNhc2UoKSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBhc3NlcnQuZXF1YWwocmVzb2x2ZWRQYXRoLCByZXNvbHZlKHNoaW1QYXRoKSk7XG4gICAgICB9XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIGl0KCdmaW5kcyBnc2Qgd2hlbiBXaW5kb3dzIGV4cG9zZXMgUGF0aCBpbnN0ZWFkIG9mIFBBVEgnLCAoKSA9PiB7XG4gICAgZGVsZXRlIHByb2Nlc3MuZW52WydHU0RfQ0xJX1BBVEgnXTtcbiAgICBkZWxldGUgcHJvY2Vzcy5lbnZbJ1BBVEgnXTtcbiAgICBjb25zdCB0bXAgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCAnZ3NkLWNsaS1wYXRoLXRpdGxlLScpKTtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc2hpbU5hbWUgPSBwcm9jZXNzLnBsYXRmb3JtID09PSAnd2luMzInID8gJ2dzZC5jbWQnIDogJ2dzZCc7XG4gICAgICBjb25zdCBzaGltUGF0aCA9IGpvaW4odG1wLCBzaGltTmFtZSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKHNoaW1QYXRoLCAnJywgJ3V0ZjgnKTtcbiAgICAgIHByb2Nlc3MuZW52WydQYXRoJ10gPSB0bXA7XG5cbiAgICAgIGNvbnN0IHJlc29sdmVkUGF0aCA9IFNlc3Npb25NYW5hZ2VyLnJlc29sdmVDTElQYXRoKCk7XG4gICAgICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gJ3dpbjMyJykge1xuICAgICAgICBhc3NlcnQuZXF1YWwocmVzb2x2ZWRQYXRoLnRvTG93ZXJDYXNlKCksIHJlc29sdmUoc2hpbVBhdGgpLnRvTG93ZXJDYXNlKCkpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgYXNzZXJ0LmVxdWFsKHJlc29sdmVkUGF0aCwgcmVzb2x2ZShzaGltUGF0aCkpO1xuICAgICAgfVxuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICBpdCgndGhyb3dzIHdoZW4gR1NEX0NMSV9QQVRIIG5vdCBzZXQgYW5kIFBBVEggbG9va3VwIGZhaWxzJywgKCkgPT4ge1xuICAgIGRlbGV0ZSBwcm9jZXNzLmVudlsnR1NEX0NMSV9QQVRIJ107XG4gICAgZGVsZXRlIHByb2Nlc3MuZW52WydQYXRoJ107XG4gICAgcHJvY2Vzcy5lbnZbJ1BBVEgnXSA9ICcvbm9uZXhpc3RlbnQnO1xuICAgIGFzc2VydC50aHJvd3MoXG4gICAgICAoKSA9PiBTZXNzaW9uTWFuYWdlci5yZXNvbHZlQ0xJUGF0aCgpLFxuICAgICAgKGVycjogRXJyb3IpID0+IHtcbiAgICAgICAgYXNzZXJ0Lm9rKGVyci5tZXNzYWdlLmluY2x1ZGVzKCdDYW5ub3QgZmluZCBHU0QgQ0xJJykpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH0sXG4gICAgKTtcbiAgfSk7XG59KTtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBUb29sIHJlZ2lzdHJhdGlvbiB0ZXN0cyAodmlhIGNyZWF0ZU1jcFNlcnZlcilcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5kZXNjcmliZSgnY3JlYXRlTWNwU2VydmVyIHRvb2wgcmVnaXN0cmF0aW9uJywgKCkgPT4ge1xuICBsZXQgc206IFRlc3RhYmxlU2Vzc2lvbk1hbmFnZXI7XG5cbiAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgc20gPSBjcmVhdGVNYW5hZ2VyKCk7XG4gIH0pO1xuXG4gIGFmdGVyRWFjaChhc3luYyAoKSA9PiB7XG4gICAgZm9yIChjb25zdCBtZ3Igb2YgYWxsTWFuYWdlcnMpIHtcbiAgICAgIGF3YWl0IG1nci5jbGVhbnVwKCk7XG4gICAgfVxuICAgIGFsbE1hbmFnZXJzID0gW107XG4gIH0pO1xuXG4gIGl0KCdjcmVhdGVzIHNlcnZlciBzdWNjZXNzZnVsbHkgd2l0aCBhbGwgcmVxdWlyZWQgbWV0aG9kcycsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB7IHNlcnZlciB9ID0gYXdhaXQgY3JlYXRlTWNwU2VydmVyKHNtKTtcbiAgICBhc3NlcnQub2soc2VydmVyKTtcbiAgICBhc3NlcnQub2soc2VydmVyLnNlcnZlcik7XG4gICAgYXNzZXJ0LmVxdWFsKHR5cGVvZiBzZXJ2ZXIuc2VydmVyLmVsaWNpdElucHV0LCAnZnVuY3Rpb24nKTtcbiAgICBhc3NlcnQub2sodHlwZW9mIHNlcnZlci5jb25uZWN0ID09PSAnZnVuY3Rpb24nKTtcbiAgICBhc3NlcnQub2sodHlwZW9mIHNlcnZlci5jbG9zZSA9PT0gJ2Z1bmN0aW9uJyk7XG4gIH0pO1xuXG4gIGl0KCdnc2RfZXhlY3V0ZSBmbG93IHJldHVybnMgc2Vzc2lvbklkIG9uIHN1Y2Nlc3MnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3Qgc2Vzc2lvbklkID0gYXdhaXQgc20uc3RhcnRTZXNzaW9uKCcvdG1wL3Rvb2wtZXhlYycsIHsgY2xpUGF0aDogJy91c3IvYmluL2dzZCcgfSk7XG4gICAgYXNzZXJ0LmVxdWFsKHR5cGVvZiBzZXNzaW9uSWQsICdzdHJpbmcnKTtcbiAgICBhc3NlcnQub2soc2Vzc2lvbklkLmxlbmd0aCA+IDApO1xuICB9KTtcblxuICBpdCgnZ3NkX3N0YXR1cyBmbG93IHJldHVybnMgY29ycmVjdCBzaGFwZScsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBzZXNzaW9uSWQgPSBhd2FpdCBzbS5zdGFydFNlc3Npb24oJy90bXAvdG9vbC1zdGF0dXMnLCB7IGNsaVBhdGg6ICcvdXNyL2Jpbi9nc2QnIH0pO1xuICAgIGNvbnN0IHNlc3Npb24gPSBzbS5nZXRTZXNzaW9uKHNlc3Npb25JZCkhO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHR5cGVvZiBzZXNzaW9uLnN0YXR1cywgJ3N0cmluZycpO1xuICAgIGFzc2VydC5vayhBcnJheS5pc0FycmF5KHNlc3Npb24uZXZlbnRzKSk7XG4gICAgYXNzZXJ0Lm9rKHNlc3Npb24uY29zdCk7XG4gICAgYXNzZXJ0LmVxdWFsKHR5cGVvZiBzZXNzaW9uLnN0YXJ0VGltZSwgJ251bWJlcicpO1xuICB9KTtcblxuICBpdCgnZ3NkX3Jlc29sdmVfYmxvY2tlciBmbG93IHJldHVybnMgZXJyb3Igd2hlbiBubyBibG9ja2VyJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHNlc3Npb25JZCA9IGF3YWl0IHNtLnN0YXJ0U2Vzc2lvbignL3RtcC90b29sLXJlc29sdmUnLCB7IGNsaVBhdGg6ICcvdXNyL2Jpbi9nc2QnIH0pO1xuICAgIGF3YWl0IGFzc2VydC5yZWplY3RzKFxuICAgICAgKCkgPT4gc20ucmVzb2x2ZUJsb2NrZXIoc2Vzc2lvbklkLCAnZml4JyksXG4gICAgICAoZXJyOiBFcnJvcikgPT4ge1xuICAgICAgICBhc3NlcnQub2soZXJyLm1lc3NhZ2UuaW5jbHVkZXMoJ05vIHBlbmRpbmcgYmxvY2tlcicpKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9LFxuICAgICk7XG4gIH0pO1xuXG4gIGl0KCdnc2RfcmVzdWx0IGZsb3cgcmV0dXJucyBIZWFkbGVzc0pzb25SZXN1bHQgc2hhcGUnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3Qgc2Vzc2lvbklkID0gYXdhaXQgc20uc3RhcnRTZXNzaW9uKCcvdG1wL3Rvb2wtcmVzdWx0JywgeyBjbGlQYXRoOiAnL3Vzci9iaW4vZ3NkJyB9KTtcbiAgICBjb25zdCByZXN1bHQgPSBzbS5nZXRSZXN1bHQoc2Vzc2lvbklkKTtcblxuICAgIGFzc2VydC5vaygnc2Vzc2lvbklkJyBpbiByZXN1bHQpO1xuICAgIGFzc2VydC5vaygncHJvamVjdERpcicgaW4gcmVzdWx0KTtcbiAgICBhc3NlcnQub2soJ3N0YXR1cycgaW4gcmVzdWx0KTtcbiAgICBhc3NlcnQub2soJ2R1cmF0aW9uTXMnIGluIHJlc3VsdCk7XG4gICAgYXNzZXJ0Lm9rKCdjb3N0JyBpbiByZXN1bHQpO1xuICAgIGFzc2VydC5vaygncmVjZW50RXZlbnRzJyBpbiByZXN1bHQpO1xuICAgIGFzc2VydC5vaygncGVuZGluZ0Jsb2NrZXInIGluIHJlc3VsdCk7XG4gICAgYXNzZXJ0Lm9rKCdlcnJvcicgaW4gcmVzdWx0KTtcbiAgfSk7XG5cbiAgaXQoJ2dzZF9jYW5jZWwgZmxvdyBtYXJrcyBzZXNzaW9uIGFzIGNhbmNlbGxlZCcsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBzZXNzaW9uSWQgPSBhd2FpdCBzbS5zdGFydFNlc3Npb24oJy90bXAvdG9vbC1jYW5jZWwnLCB7IGNsaVBhdGg6ICcvdXNyL2Jpbi9nc2QnIH0pO1xuICAgIGF3YWl0IHNtLmNhbmNlbFNlc3Npb24oc2Vzc2lvbklkKTtcbiAgICBjb25zdCBzZXNzaW9uID0gc20uZ2V0U2Vzc2lvbihzZXNzaW9uSWQpITtcbiAgICBhc3NlcnQuZXF1YWwoc2Vzc2lvbi5zdGF0dXMsICdjYW5jZWxsZWQnKTtcbiAgfSk7XG5cbiAgaXQoJ2dzZF9jYW5jZWwgY2FuIGNhbmNlbCBhbiBpbnRlcmFjdGl2ZSBzZXNzaW9uIChubyBzZXNzaW9uSWQpIHZpYSBwcm9qZWN0RGlyIGZhbGxiYWNrJywgYXN5bmMgKCkgPT4ge1xuICAgIC8vIFNpbXVsYXRlIGFuIGludGVyYWN0aXZlIHNlc3Npb246IHJlZ2lzdGVyZWQgYnkgcHJvamVjdERpciBidXQgd2l0aCBhbiBlbXB0eSBzZXNzaW9uSWRcbiAgICAvLyAoZS5nLiBzdGFydGVkIHZpYSBgL2dzZCBhdXRvYCBpbiB0ZXJtaW5hbCBvciBmcm9tIGEgcmVzdGFydGVkIE1DUCBzZXJ2ZXIgdGhhdCBsb3N0IGl0cyBzZXNzaW9uIHJlZ2lzdHJ5KVxuICAgIGNvbnN0IHByb2plY3REaXIgPSByZXNvbHZlKCcvdG1wL2ludGVyYWN0aXZlLXNlc3Npb24nKTtcbiAgICBjb25zdCBtb2NrQ2xpZW50ID0gbmV3IE1vY2tScGNDbGllbnQoeyBjd2Q6IHByb2plY3REaXIsIGFyZ3M6IFtdIH0pO1xuICAgIGNvbnN0IGludGVyYWN0aXZlU2Vzc2lvbjogTWFuYWdlZFNlc3Npb24gPSB7XG4gICAgICBzZXNzaW9uSWQ6ICcnLCAvLyBubyBzZXNzaW9uSWQgXHUyMDE0IGludGVyYWN0aXZlL3Jlc3RhcnRlZCBzY2VuYXJpb1xuICAgICAgcHJvamVjdERpcixcbiAgICAgIHN0YXR1czogJ3J1bm5pbmcnLFxuICAgICAgY2xpZW50OiBtb2NrQ2xpZW50IGFzIGFueSxcbiAgICAgIGV2ZW50czogW10sXG4gICAgICBwZW5kaW5nQmxvY2tlcjogbnVsbCxcbiAgICAgIGNvc3Q6IHsgdG90YWxDb3N0OiAwLCB0b2tlbnM6IHsgaW5wdXQ6IDAsIG91dHB1dDogMCwgY2FjaGVSZWFkOiAwLCBjYWNoZVdyaXRlOiAwIH0gfSxcbiAgICAgIHN0YXJ0VGltZTogRGF0ZS5ub3coKSxcbiAgICB9O1xuICAgIHNtLl9wdXRTZXNzaW9uKHByb2plY3REaXIsIGludGVyYWN0aXZlU2Vzc2lvbik7XG5cbiAgICAvLyBjYW5jZWxTZXNzaW9uKCcnKSBzaG91bGQgZmFpbCBcdTIwMTQgbm8gc2Vzc2lvbiBmb3VuZCBieSBlbXB0eSBzZXNzaW9uSWRcbiAgICAvLyBjYW5jZWxTZXNzaW9uQnlEaXIgc2hvdWxkIHN1Y2NlZWQgXHUyMDE0IGZpbmRzIHNlc3Npb24gYnkgcHJvamVjdERpclxuICAgIGF3YWl0IHNtLmNhbmNlbFNlc3Npb25CeURpcihwcm9qZWN0RGlyKTtcblxuICAgIGNvbnN0IHNlc3Npb24gPSBzbS5nZXRTZXNzaW9uQnlEaXIocHJvamVjdERpcikhO1xuICAgIGFzc2VydC5lcXVhbChzZXNzaW9uLnN0YXR1cywgJ2NhbmNlbGxlZCcpO1xuICAgIGFzc2VydC5vayhtb2NrQ2xpZW50LmFib3J0ZWQsICdjbGllbnQuYWJvcnQoKSBzaG91bGQgaGF2ZSBiZWVuIGNhbGxlZCcpO1xuICB9KTtcblxuICBpdCgnZ3NkX2NhbmNlbCB2aWEgcHJvamVjdERpciB3b3JrcyBldmVuIHdoZW4gc2Vzc2lvbklkIGxvb2t1cCByZXR1cm5zIHVuZGVmaW5lZCcsIGFzeW5jICgpID0+IHtcbiAgICAvLyBTdGFydCBhIG5vcm1hbCBzZXNzaW9uIHRvIGdldCBpdHMgcHJvamVjdERpclxuICAgIGNvbnN0IHNlc3Npb25JZCA9IGF3YWl0IHNtLnN0YXJ0U2Vzc2lvbignL3RtcC9jYW5jZWwtYnktZGlyJywgeyBjbGlQYXRoOiAnL3Vzci9iaW4vZ3NkJyB9KTtcbiAgICBjb25zdCBzZXNzaW9uID0gc20uZ2V0U2Vzc2lvbihzZXNzaW9uSWQpITtcbiAgICBjb25zdCB7IHByb2plY3REaXIgfSA9IHNlc3Npb247XG5cbiAgICAvLyBjYW5jZWxTZXNzaW9uQnlEaXIgc2hvdWxkIGZpbmQgaXQgYnkgZGlyIGFuZCBjYW5jZWwgaXRcbiAgICBhd2FpdCBzbS5jYW5jZWxTZXNzaW9uQnlEaXIocHJvamVjdERpcik7XG4gICAgYXNzZXJ0LmVxdWFsKHNlc3Npb24uc3RhdHVzLCAnY2FuY2VsbGVkJyk7XG4gIH0pO1xuXG4gIGl0KCdidWlsZEFza1VzZXJRdWVzdGlvbnNFbGljaXRSZXF1ZXN0IGFkZHMgTm9uZSBvZiB0aGUgYWJvdmUgbm90ZSBmaWVsZCBmb3Igc2luZ2xlLXNlbGVjdCBxdWVzdGlvbnMnLCAoKSA9PiB7XG4gICAgY29uc3QgcmVxdWVzdCA9IGJ1aWxkQXNrVXNlclF1ZXN0aW9uc0VsaWNpdFJlcXVlc3QoW1xuICAgICAge1xuICAgICAgICBpZDogJ2RlcHRoX3ZlcmlmaWNhdGlvbl9NMDAxJyxcbiAgICAgICAgaGVhZGVyOiAnRGVwdGggQ2hlY2snLFxuICAgICAgICBxdWVzdGlvbjogJ0RpZCBJIGNhcHR1cmUgdGhlIGRlcHRoIHJpZ2h0PycsXG4gICAgICAgIG9wdGlvbnM6IFtcbiAgICAgICAgICB7IGxhYmVsOiAnWWVzLCB5b3UgZ290IGl0IChSZWNvbW1lbmRlZCknLCBkZXNjcmlwdGlvbjogJ0NvbnRpbnVlIHdpdGggdGhlIGN1cnJlbnQgc3VtbWFyeS4nIH0sXG4gICAgICAgICAgeyBsYWJlbDogJ05vdCBxdWl0ZScsIGRlc2NyaXB0aW9uOiAnSSBuZWVkIHRvIGNsYXJpZnkgdGhlIGRlcHRoIGZ1cnRoZXIuJyB9LFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdmb2N1c19hcmVhcycsXG4gICAgICAgIGhlYWRlcjogJ0ZvY3VzJyxcbiAgICAgICAgcXVlc3Rpb246ICdXaGljaCBhcmVhcyBtYXR0ZXIgbW9zdD8nLFxuICAgICAgICBhbGxvd011bHRpcGxlOiB0cnVlLFxuICAgICAgICBvcHRpb25zOiBbXG4gICAgICAgICAgeyBsYWJlbDogJ0Zyb250ZW5kJywgZGVzY3JpcHRpb246ICdQcmlvcml0aXplIHRoZSBVSS4nIH0sXG4gICAgICAgICAgeyBsYWJlbDogJ0JhY2tlbmQnLCBkZXNjcmlwdGlvbjogJ1ByaW9yaXRpemUgc2VydmVyIGxvZ2ljLicgfSxcbiAgICAgICAgXSxcbiAgICAgIH0sXG4gICAgXSk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVxdWVzdC5tb2RlLCAnZm9ybScpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwocmVxdWVzdC5yZXF1ZXN0ZWRTY2hlbWEucmVxdWlyZWQsIFsnZGVwdGhfdmVyaWZpY2F0aW9uX00wMDEnLCAnZm9jdXNfYXJlYXMnXSk7XG4gICAgYXNzZXJ0Lm9rKHJlcXVlc3QucmVxdWVzdGVkU2NoZW1hLnByb3BlcnRpZXNbJ2RlcHRoX3ZlcmlmaWNhdGlvbl9NMDAxJ10pO1xuICAgIGFzc2VydC5vayhyZXF1ZXN0LnJlcXVlc3RlZFNjaGVtYS5wcm9wZXJ0aWVzWydkZXB0aF92ZXJpZmljYXRpb25fTTAwMV9fbm90ZSddKTtcbiAgICBhc3NlcnQub2soIXJlcXVlc3QucmVxdWVzdGVkU2NoZW1hLnByb3BlcnRpZXNbJ2ZvY3VzX2FyZWFzX19ub3RlJ10pO1xuICB9KTtcblxuICBpdCgnZm9ybWF0QXNrVXNlclF1ZXN0aW9uc0VsaWNpdFJlc3VsdCBwcmVzZXJ2ZXMgdGhlIGV4aXN0aW5nIGFuc3dlcnMgSlNPTiBzaGFwZScsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBmb3JtYXRBc2tVc2VyUXVlc3Rpb25zRWxpY2l0UmVzdWx0KFxuICAgICAgW1xuICAgICAgICB7XG4gICAgICAgICAgaWQ6ICdkZXB0aF92ZXJpZmljYXRpb25fTTAwMScsXG4gICAgICAgICAgaGVhZGVyOiAnRGVwdGggQ2hlY2snLFxuICAgICAgICAgIHF1ZXN0aW9uOiAnRGlkIEkgY2FwdHVyZSB0aGUgZGVwdGggcmlnaHQ/JyxcbiAgICAgICAgICBvcHRpb25zOiBbXG4gICAgICAgICAgICB7IGxhYmVsOiAnWWVzLCB5b3UgZ290IGl0IChSZWNvbW1lbmRlZCknLCBkZXNjcmlwdGlvbjogJ0NvbnRpbnVlIHdpdGggdGhlIGN1cnJlbnQgc3VtbWFyeS4nIH0sXG4gICAgICAgICAgICB7IGxhYmVsOiAnTm90IHF1aXRlJywgZGVzY3JpcHRpb246ICdJIG5lZWQgdG8gY2xhcmlmeSB0aGUgZGVwdGggZnVydGhlci4nIH0sXG4gICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIGlkOiAnZm9jdXNfYXJlYXMnLFxuICAgICAgICAgIGhlYWRlcjogJ0ZvY3VzJyxcbiAgICAgICAgICBxdWVzdGlvbjogJ1doaWNoIGFyZWFzIG1hdHRlciBtb3N0PycsXG4gICAgICAgICAgYWxsb3dNdWx0aXBsZTogdHJ1ZSxcbiAgICAgICAgICBvcHRpb25zOiBbXG4gICAgICAgICAgICB7IGxhYmVsOiAnRnJvbnRlbmQnLCBkZXNjcmlwdGlvbjogJ1ByaW9yaXRpemUgdGhlIFVJLicgfSxcbiAgICAgICAgICAgIHsgbGFiZWw6ICdCYWNrZW5kJywgZGVzY3JpcHRpb246ICdQcmlvcml0aXplIHNlcnZlciBsb2dpYy4nIH0sXG4gICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgICB7XG4gICAgICAgIGFjdGlvbjogJ2FjY2VwdCcsXG4gICAgICAgIGNvbnRlbnQ6IHtcbiAgICAgICAgICBkZXB0aF92ZXJpZmljYXRpb25fTTAwMTogJ05vbmUgb2YgdGhlIGFib3ZlJyxcbiAgICAgICAgICBkZXB0aF92ZXJpZmljYXRpb25fTTAwMV9fbm90ZTogJ05lZWQgbW9yZSBpbXBsZW1lbnRhdGlvbiBkZXRhaWwuJyxcbiAgICAgICAgICBmb2N1c19hcmVhczogWydGcm9udGVuZCcsICdCYWNrZW5kJ10sXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICk7XG5cbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICByZXN1bHQsXG4gICAgICBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIGFuc3dlcnM6IHtcbiAgICAgICAgICBkZXB0aF92ZXJpZmljYXRpb25fTTAwMToge1xuICAgICAgICAgICAgYW5zd2VyczogWydOb25lIG9mIHRoZSBhYm92ZScsICd1c2VyX25vdGU6IE5lZWQgbW9yZSBpbXBsZW1lbnRhdGlvbiBkZXRhaWwuJ10sXG4gICAgICAgICAgfSxcbiAgICAgICAgICBmb2N1c19hcmVhczoge1xuICAgICAgICAgICAgYW5zd2VyczogWydGcm9udGVuZCcsICdCYWNrZW5kJ10sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0pLFxuICAgICk7XG4gIH0pO1xuXG4gIGl0KCdhc2tfdXNlcl9xdWVzdGlvbnMgcmV0dXJucyBsb2NhbCBlbGljaXRhdGlvbiBhbnN3ZXJzIGJlZm9yZSB0cnlpbmcgcmVtb3RlJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHF1ZXN0aW9ucyA9IFtcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdkZXB0aF92ZXJpZmljYXRpb25fTTAwMScsXG4gICAgICAgIGhlYWRlcjogJ0RlcHRoIENoZWNrJyxcbiAgICAgICAgcXVlc3Rpb246ICdEaWQgSSBjYXB0dXJlIHRoZSBkZXB0aCByaWdodD8nLFxuICAgICAgICBvcHRpb25zOiBbXG4gICAgICAgICAgeyBsYWJlbDogJ1llcywgeW91IGdvdCBpdCAoUmVjb21tZW5kZWQpJywgZGVzY3JpcHRpb246ICdDb250aW51ZSB3aXRoIHRoZSBjdXJyZW50IHN1bW1hcnkuJyB9LFxuICAgICAgICAgIHsgbGFiZWw6ICdOb3QgcXVpdGUnLCBkZXNjcmlwdGlvbjogJ0kgbmVlZCB0byBjbGFyaWZ5IHRoZSBkZXB0aCBmdXJ0aGVyLicgfSxcbiAgICAgICAgXSxcbiAgICAgIH0sXG4gICAgXTtcbiAgICBsZXQgcmVtb3RlQ2FsbHMgPSAwO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgYXNrVXNlclF1ZXN0aW9uc0hhbmRsZXIocXVlc3Rpb25zLCB1bmRlZmluZWQsIHtcbiAgICAgIGFzeW5jIGVsaWNpdElucHV0KCkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGFjdGlvbjogJ2FjY2VwdCcsXG4gICAgICAgICAgY29udGVudDoge1xuICAgICAgICAgICAgZGVwdGhfdmVyaWZpY2F0aW9uX00wMDE6ICdZZXMsIHlvdSBnb3QgaXQgKFJlY29tbWVuZGVkKScsXG4gICAgICAgICAgfSxcbiAgICAgICAgfTtcbiAgICAgIH0sXG4gICAgICBpc1JlbW90ZUNvbmZpZ3VyZWQoKSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfSxcbiAgICAgIGFzeW5jIHRyeVJlbW90ZVF1ZXN0aW9ucygpIHtcbiAgICAgICAgcmVtb3RlQ2FsbHMrKztcbiAgICAgICAgcmV0dXJuIHsgY29udGVudDogW3sgdHlwZTogJ3RleHQnLCB0ZXh0OiAncmVtb3RlIHJlc3BvbnNlJyB9XSB9O1xuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGFzc2VydC5lcXVhbChyZW1vdGVDYWxscywgMCk7XG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgcmVzdWx0LmNvbnRlbnRbMF0/LnRleHQsXG4gICAgICBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIGFuc3dlcnM6IHtcbiAgICAgICAgICBkZXB0aF92ZXJpZmljYXRpb25fTTAwMToge1xuICAgICAgICAgICAgYW5zd2VyczogWydZZXMsIHlvdSBnb3QgaXQgKFJlY29tbWVuZGVkKSddLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICB9KSxcbiAgICApO1xuICB9KTtcblxuICBpdCgnYXNrX3VzZXJfcXVlc3Rpb25zIHBlcnNpc3RzIGNvbmZpcm1lZCBkZXB0aCBnYXRlcyBmb3IgbG9jYWwgYW5zd2VycycsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBxdWVzdGlvbnMgPSBbXG4gICAgICB7XG4gICAgICAgIGlkOiAnZGVwdGhfdmVyaWZpY2F0aW9uX00wMDNfY29uZmlybScsXG4gICAgICAgIGhlYWRlcjogJ0RlcHRoIENoZWNrJyxcbiAgICAgICAgcXVlc3Rpb246ICdEaWQgSSBjYXB0dXJlIHRoZSBkZXB0aCByaWdodD8nLFxuICAgICAgICBvcHRpb25zOiBbXG4gICAgICAgICAgeyBsYWJlbDogJ1llcywgeW91IGdvdCBpdCAoUmVjb21tZW5kZWQpJywgZGVzY3JpcHRpb246ICdDb250aW51ZSB3aXRoIHRoZSBjdXJyZW50IHN1bW1hcnkuJyB9LFxuICAgICAgICAgIHsgbGFiZWw6ICdOb3QgcXVpdGUnLCBkZXNjcmlwdGlvbjogJ0kgbmVlZCB0byBjbGFyaWZ5IHRoZSBkZXB0aCBmdXJ0aGVyLicgfSxcbiAgICAgICAgXSxcbiAgICAgIH0sXG4gICAgXTtcbiAgICBjb25zdCBjYWxsczogc3RyaW5nW10gPSBbXTtcbiAgICBjb25zdCB3cml0ZUdhdGUgPSB7XG4gICAgICBpc0dhdGVRdWVzdGlvbklkKHF1ZXN0aW9uSWQ6IHN0cmluZykge1xuICAgICAgICByZXR1cm4gcXVlc3Rpb25JZC5zdGFydHNXaXRoKCdkZXB0aF92ZXJpZmljYXRpb25fJyk7XG4gICAgICB9LFxuICAgICAgaXNEZXB0aENvbmZpcm1hdGlvbkFuc3dlcihzZWxlY3RlZDogdW5rbm93biwgb3B0aW9ucz86IEFycmF5PHsgbGFiZWw/OiBzdHJpbmcgfT4pIHtcbiAgICAgICAgcmV0dXJuIHNlbGVjdGVkID09PSBvcHRpb25zPy5bMF0/LmxhYmVsO1xuICAgICAgfSxcbiAgICAgIHNldFBlbmRpbmdHYXRlKGdhdGVJZDogc3RyaW5nLCBiYXNlUGF0aDogc3RyaW5nKSB7XG4gICAgICAgIGNhbGxzLnB1c2goYHBlbmRpbmc6JHtnYXRlSWR9OiR7YmFzZVBhdGh9YCk7XG4gICAgICB9LFxuICAgICAgbWFya0FwcHJvdmFsR2F0ZVZlcmlmaWVkKGdhdGVJZD86IHN0cmluZyB8IG51bGwsIGJhc2VQYXRoPzogc3RyaW5nKSB7XG4gICAgICAgIGNhbGxzLnB1c2goYGFwcHJvdmFsOiR7Z2F0ZUlkfToke2Jhc2VQYXRofWApO1xuICAgICAgfSxcbiAgICAgIG1hcmtEZXB0aFZlcmlmaWVkKG1pbGVzdG9uZUlkPzogc3RyaW5nIHwgbnVsbCwgYmFzZVBhdGg/OiBzdHJpbmcpIHtcbiAgICAgICAgY2FsbHMucHVzaChgZGVwdGg6JHttaWxlc3RvbmVJZH06JHtiYXNlUGF0aH1gKTtcbiAgICAgIH0sXG4gICAgICBjbGVhclBlbmRpbmdHYXRlKGJhc2VQYXRoOiBzdHJpbmcpIHtcbiAgICAgICAgY2FsbHMucHVzaChgY2xlYXI6JHtiYXNlUGF0aH1gKTtcbiAgICAgIH0sXG4gICAgICBleHRyYWN0RGVwdGhWZXJpZmljYXRpb25NaWxlc3RvbmVJZChxdWVzdGlvbklkOiBzdHJpbmcpIHtcbiAgICAgICAgcmV0dXJuIHF1ZXN0aW9uSWQubWF0Y2goL18oTVxcZCspXy8pPy5bMV0gPz8gbnVsbDtcbiAgICAgIH0sXG4gICAgfTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGFza1VzZXJRdWVzdGlvbnNIYW5kbGVyKHF1ZXN0aW9ucywgdW5kZWZpbmVkLCB7XG4gICAgICBhc3luYyBlbGljaXRJbnB1dCgpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBhY3Rpb246ICdhY2NlcHQnLFxuICAgICAgICAgIGNvbnRlbnQ6IHtcbiAgICAgICAgICAgIGRlcHRoX3ZlcmlmaWNhdGlvbl9NMDAzX2NvbmZpcm06ICdZZXMsIHlvdSBnb3QgaXQgKFJlY29tbWVuZGVkKScsXG4gICAgICAgICAgfSxcbiAgICAgICAgfTtcbiAgICAgIH0sXG4gICAgICBpc1JlbW90ZUNvbmZpZ3VyZWQoKSB7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgIH0sXG4gICAgICBhc3luYyB0cnlSZW1vdGVRdWVzdGlvbnMoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignc2hvdWxkIG5vdCBiZSBjYWxsZWQnKTtcbiAgICAgIH0sXG4gICAgICB3cml0ZUdhdGUsXG4gICAgICB3cml0ZUdhdGVCYXNlUGF0aDogJy90bXAvZ3NkLXByb2plY3QnLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKCdpc0Vycm9yJyBpbiByZXN1bHQgJiYgcmVzdWx0LmlzRXJyb3IsIGZhbHNlKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKGNhbGxzLCBbXG4gICAgICAncGVuZGluZzpkZXB0aF92ZXJpZmljYXRpb25fTTAwM19jb25maXJtOi90bXAvZ3NkLXByb2plY3QnLFxuICAgICAgJ2FwcHJvdmFsOmRlcHRoX3ZlcmlmaWNhdGlvbl9NMDAzX2NvbmZpcm06L3RtcC9nc2QtcHJvamVjdCcsXG4gICAgICAnZGVwdGg6TTAwMzovdG1wL2dzZC1wcm9qZWN0JyxcbiAgICAgICdjbGVhcjovdG1wL2dzZC1wcm9qZWN0JyxcbiAgICBdKTtcbiAgfSk7XG5cbiAgaXQoJ2Fza191c2VyX3F1ZXN0aW9ucyBwZXJzaXN0cyBjb25maXJtZWQgZGVwdGggZ2F0ZXMgZm9yIHJlbW90ZSBhbnN3ZXJzJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHF1ZXN0aW9ucyA9IFtcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdkZXB0aF92ZXJpZmljYXRpb25fTTAwM19jb25maXJtJyxcbiAgICAgICAgaGVhZGVyOiAnRGVwdGggQ2hlY2snLFxuICAgICAgICBxdWVzdGlvbjogJ0RpZCBJIGNhcHR1cmUgdGhlIGRlcHRoIHJpZ2h0PycsXG4gICAgICAgIG9wdGlvbnM6IFtcbiAgICAgICAgICB7IGxhYmVsOiAnWWVzLCB5b3UgZ290IGl0IChSZWNvbW1lbmRlZCknLCBkZXNjcmlwdGlvbjogJ0NvbnRpbnVlIHdpdGggdGhlIGN1cnJlbnQgc3VtbWFyeS4nIH0sXG4gICAgICAgICAgeyBsYWJlbDogJ05vdCBxdWl0ZScsIGRlc2NyaXB0aW9uOiAnSSBuZWVkIHRvIGNsYXJpZnkgdGhlIGRlcHRoIGZ1cnRoZXIuJyB9LFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICBdO1xuICAgIGNvbnN0IGNhbGxzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGNvbnN0IHdyaXRlR2F0ZSA9IHtcbiAgICAgIGlzR2F0ZVF1ZXN0aW9uSWQocXVlc3Rpb25JZDogc3RyaW5nKSB7XG4gICAgICAgIHJldHVybiBxdWVzdGlvbklkLnN0YXJ0c1dpdGgoJ2RlcHRoX3ZlcmlmaWNhdGlvbl8nKTtcbiAgICAgIH0sXG4gICAgICBpc0RlcHRoQ29uZmlybWF0aW9uQW5zd2VyKHNlbGVjdGVkOiB1bmtub3duLCBvcHRpb25zPzogQXJyYXk8eyBsYWJlbD86IHN0cmluZyB9Pikge1xuICAgICAgICByZXR1cm4gc2VsZWN0ZWQgPT09IG9wdGlvbnM/LlswXT8ubGFiZWw7XG4gICAgICB9LFxuICAgICAgc2V0UGVuZGluZ0dhdGUoZ2F0ZUlkOiBzdHJpbmcsIGJhc2VQYXRoOiBzdHJpbmcpIHtcbiAgICAgICAgY2FsbHMucHVzaChgcGVuZGluZzoke2dhdGVJZH06JHtiYXNlUGF0aH1gKTtcbiAgICAgIH0sXG4gICAgICBtYXJrQXBwcm92YWxHYXRlVmVyaWZpZWQoZ2F0ZUlkPzogc3RyaW5nIHwgbnVsbCwgYmFzZVBhdGg/OiBzdHJpbmcpIHtcbiAgICAgICAgY2FsbHMucHVzaChgYXBwcm92YWw6JHtnYXRlSWR9OiR7YmFzZVBhdGh9YCk7XG4gICAgICB9LFxuICAgICAgbWFya0RlcHRoVmVyaWZpZWQobWlsZXN0b25lSWQ/OiBzdHJpbmcgfCBudWxsLCBiYXNlUGF0aD86IHN0cmluZykge1xuICAgICAgICBjYWxscy5wdXNoKGBkZXB0aDoke21pbGVzdG9uZUlkfToke2Jhc2VQYXRofWApO1xuICAgICAgfSxcbiAgICAgIGNsZWFyUGVuZGluZ0dhdGUoYmFzZVBhdGg6IHN0cmluZykge1xuICAgICAgICBjYWxscy5wdXNoKGBjbGVhcjoke2Jhc2VQYXRofWApO1xuICAgICAgfSxcbiAgICAgIGV4dHJhY3REZXB0aFZlcmlmaWNhdGlvbk1pbGVzdG9uZUlkKHF1ZXN0aW9uSWQ6IHN0cmluZykge1xuICAgICAgICByZXR1cm4gcXVlc3Rpb25JZC5tYXRjaCgvXyhNXFxkKylfLyk/LlsxXSA/PyBudWxsO1xuICAgICAgfSxcbiAgICB9O1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgYXNrVXNlclF1ZXN0aW9uc0hhbmRsZXIocXVlc3Rpb25zLCB1bmRlZmluZWQsIHtcbiAgICAgIGFzeW5jIGVsaWNpdElucHV0KCkge1xuICAgICAgICByZXR1cm4geyBhY3Rpb246ICdjYW5jZWwnIH07XG4gICAgICB9LFxuICAgICAgaXNSZW1vdGVDb25maWd1cmVkKCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH0sXG4gICAgICBhc3luYyB0cnlSZW1vdGVRdWVzdGlvbnMoKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgY29udGVudDogW3sgdHlwZTogJ3RleHQnLCB0ZXh0OiAncmVtb3RlIHJlc3BvbnNlJyB9XSxcbiAgICAgICAgICBkZXRhaWxzOiB7XG4gICAgICAgICAgICByZXNwb25zZToge1xuICAgICAgICAgICAgICBlbmRJbnRlcnZpZXc6IGZhbHNlLFxuICAgICAgICAgICAgICBhbnN3ZXJzOiB7XG4gICAgICAgICAgICAgICAgZGVwdGhfdmVyaWZpY2F0aW9uX00wMDNfY29uZmlybToge1xuICAgICAgICAgICAgICAgICAgc2VsZWN0ZWQ6ICdZZXMsIHlvdSBnb3QgaXQgKFJlY29tbWVuZGVkKScsXG4gICAgICAgICAgICAgICAgICBub3RlczogJycsXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfTtcbiAgICAgIH0sXG4gICAgICB3cml0ZUdhdGUsXG4gICAgICB3cml0ZUdhdGVCYXNlUGF0aDogJy90bXAvZ3NkLXByb2plY3QnLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKCdpc0Vycm9yJyBpbiByZXN1bHQgJiYgcmVzdWx0LmlzRXJyb3IsIGZhbHNlKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKGNhbGxzLCBbXG4gICAgICAncGVuZGluZzpkZXB0aF92ZXJpZmljYXRpb25fTTAwM19jb25maXJtOi90bXAvZ3NkLXByb2plY3QnLFxuICAgICAgJ2FwcHJvdmFsOmRlcHRoX3ZlcmlmaWNhdGlvbl9NMDAzX2NvbmZpcm06L3RtcC9nc2QtcHJvamVjdCcsXG4gICAgICAnZGVwdGg6TTAwMzovdG1wL2dzZC1wcm9qZWN0JyxcbiAgICAgICdjbGVhcjovdG1wL2dzZC1wcm9qZWN0JyxcbiAgICBdKTtcbiAgfSk7XG5cbiAgaXQoJ2Fza191c2VyX3F1ZXN0aW9ucyBmYWxscyBiYWNrIHRvIHJlbW90ZSB3aGVuIGxvY2FsIGVsaWNpdGF0aW9uIGlzIGNhbmNlbGxlZCcsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBxdWVzdGlvbnMgPSBbXG4gICAgICB7XG4gICAgICAgIGlkOiAnZGVwdGhfdmVyaWZpY2F0aW9uX00wMDEnLFxuICAgICAgICBoZWFkZXI6ICdEZXB0aCBDaGVjaycsXG4gICAgICAgIHF1ZXN0aW9uOiAnRGlkIEkgY2FwdHVyZSB0aGUgZGVwdGggcmlnaHQ/JyxcbiAgICAgICAgb3B0aW9uczogW1xuICAgICAgICAgIHsgbGFiZWw6ICdZZXMsIHlvdSBnb3QgaXQgKFJlY29tbWVuZGVkKScsIGRlc2NyaXB0aW9uOiAnQ29udGludWUgd2l0aCB0aGUgY3VycmVudCBzdW1tYXJ5LicgfSxcbiAgICAgICAgICB7IGxhYmVsOiAnTm90IHF1aXRlJywgZGVzY3JpcHRpb246ICdJIG5lZWQgdG8gY2xhcmlmeSB0aGUgZGVwdGggZnVydGhlci4nIH0sXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgIF07XG4gICAgbGV0IHJlbW90ZUNhbGxzID0gMDtcbiAgICBjb25zdCBzaWduYWwgPSBBYm9ydFNpZ25hbC5hYm9ydCgpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgYXNrVXNlclF1ZXN0aW9uc0hhbmRsZXIocXVlc3Rpb25zLCB7IHNpZ25hbCB9LCB7XG4gICAgICBhc3luYyBlbGljaXRJbnB1dCgpIHtcbiAgICAgICAgcmV0dXJuIHsgYWN0aW9uOiAnY2FuY2VsJyB9O1xuICAgICAgfSxcbiAgICAgIGlzUmVtb3RlQ29uZmlndXJlZCgpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9LFxuICAgICAgYXN5bmMgdHJ5UmVtb3RlUXVlc3Rpb25zKHJlbW90ZVF1ZXN0aW9ucywgcmVjZWl2ZWRTaWduYWwpIHtcbiAgICAgICAgcmVtb3RlQ2FsbHMrKztcbiAgICAgICAgYXNzZXJ0LmVxdWFsKHJlbW90ZVF1ZXN0aW9ucywgcXVlc3Rpb25zKTtcbiAgICAgICAgYXNzZXJ0LmVxdWFsKHJlY2VpdmVkU2lnbmFsLCBzaWduYWwpO1xuICAgICAgICByZXR1cm4geyBjb250ZW50OiBbeyB0eXBlOiAndGV4dCcsIHRleHQ6ICdyZW1vdGUgcmVzcG9uc2UnIH1dIH07XG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlbW90ZUNhbGxzLCAxKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmNvbnRlbnRbMF0/LnRleHQsICdyZW1vdGUgcmVzcG9uc2UnKTtcbiAgfSk7XG5cbiAgaXQoJ2Fza191c2VyX3F1ZXN0aW9ucyBmYWxscyBiYWNrIHRvIHJlbW90ZSB3aGVuIGxvY2FsIGVsaWNpdGF0aW9uIGlzIHVuYXZhaWxhYmxlJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHF1ZXN0aW9ucyA9IFtcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdkZXB0aF92ZXJpZmljYXRpb25fTTAwMScsXG4gICAgICAgIGhlYWRlcjogJ0RlcHRoIENoZWNrJyxcbiAgICAgICAgcXVlc3Rpb246ICdEaWQgSSBjYXB0dXJlIHRoZSBkZXB0aCByaWdodD8nLFxuICAgICAgICBvcHRpb25zOiBbXG4gICAgICAgICAgeyBsYWJlbDogJ1llcywgeW91IGdvdCBpdCAoUmVjb21tZW5kZWQpJywgZGVzY3JpcHRpb246ICdDb250aW51ZSB3aXRoIHRoZSBjdXJyZW50IHN1bW1hcnkuJyB9LFxuICAgICAgICAgIHsgbGFiZWw6ICdOb3QgcXVpdGUnLCBkZXNjcmlwdGlvbjogJ0kgbmVlZCB0byBjbGFyaWZ5IHRoZSBkZXB0aCBmdXJ0aGVyLicgfSxcbiAgICAgICAgXSxcbiAgICAgIH0sXG4gICAgXTtcbiAgICBsZXQgcmVtb3RlQ2FsbHMgPSAwO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgYXNrVXNlclF1ZXN0aW9uc0hhbmRsZXIocXVlc3Rpb25zLCB1bmRlZmluZWQsIHtcbiAgICAgIGFzeW5jIGVsaWNpdElucHV0KCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ01DUCBob3N0IGRvZXMgbm90IHN1cHBvcnQgZWxpY2l0YXRpb24nKTtcbiAgICAgIH0sXG4gICAgICBpc1JlbW90ZUNvbmZpZ3VyZWQoKSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfSxcbiAgICAgIGFzeW5jIHRyeVJlbW90ZVF1ZXN0aW9ucyhyZW1vdGVRdWVzdGlvbnMpIHtcbiAgICAgICAgcmVtb3RlQ2FsbHMrKztcbiAgICAgICAgYXNzZXJ0LmVxdWFsKHJlbW90ZVF1ZXN0aW9ucywgcXVlc3Rpb25zKTtcbiAgICAgICAgcmV0dXJuIHsgY29udGVudDogW3sgdHlwZTogJ3RleHQnLCB0ZXh0OiAncmVtb3RlIHJlc3BvbnNlJyB9XSB9O1xuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGFzc2VydC5lcXVhbChyZW1vdGVDYWxscywgMSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5jb250ZW50WzBdPy50ZXh0LCAncmVtb3RlIHJlc3BvbnNlJyk7XG4gIH0pO1xuXG4gIGl0KCdhc2tfdXNlcl9xdWVzdGlvbnMgc3VyZmFjZXMgcmVtb3RlIHN1Y2Nlc3MgYW5zd2VycyBhcyBzdHJ1Y3R1cmVkQ29udGVudCAocmVncmVzc2lvbiAjNTI2NyknLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgcXVlc3Rpb25zID0gW1xuICAgICAge1xuICAgICAgICBpZDogJ2RlcHRoX3ZlcmlmaWNhdGlvbl9NMDAxJyxcbiAgICAgICAgaGVhZGVyOiAnRGVwdGggQ2hlY2snLFxuICAgICAgICBxdWVzdGlvbjogJ0RpZCBJIGNhcHR1cmUgdGhlIGRlcHRoIHJpZ2h0PycsXG4gICAgICAgIG9wdGlvbnM6IFtcbiAgICAgICAgICB7IGxhYmVsOiAnWWVzLCB5b3UgZ290IGl0IChSZWNvbW1lbmRlZCknLCBkZXNjcmlwdGlvbjogJ0NvbnRpbnVlLicgfSxcbiAgICAgICAgICB7IGxhYmVsOiAnTm90IHF1aXRlJywgZGVzY3JpcHRpb246ICdDbGFyaWZ5LicgfSxcbiAgICAgICAgXSxcbiAgICAgIH0sXG4gICAgXTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGFza1VzZXJRdWVzdGlvbnNIYW5kbGVyKHF1ZXN0aW9ucywgdW5kZWZpbmVkLCB7XG4gICAgICBhc3luYyBlbGljaXRJbnB1dCgpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdNQ1AgaG9zdCBkb2VzIG5vdCBzdXBwb3J0IGVsaWNpdGF0aW9uJyk7XG4gICAgICB9LFxuICAgICAgaXNSZW1vdGVDb25maWd1cmVkKCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH0sXG4gICAgICBhc3luYyB0cnlSZW1vdGVRdWVzdGlvbnMoKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgY29udGVudDogW3sgdHlwZTogJ3RleHQnLCB0ZXh0OiAne1wiYW5zd2Vyc1wiOntcImRlcHRoX3ZlcmlmaWNhdGlvbl9NMDAxXCI6e1wiYW5zd2Vyc1wiOltcIlllcywgeW91IGdvdCBpdCAoUmVjb21tZW5kZWQpXCJdfX19JyB9XSxcbiAgICAgICAgICBkZXRhaWxzOiB7XG4gICAgICAgICAgICByZW1vdGU6IHRydWUsXG4gICAgICAgICAgICBjaGFubmVsOiAnZGlzY29yZCcsXG4gICAgICAgICAgICB0aW1lZF9vdXQ6IGZhbHNlLFxuICAgICAgICAgICAgcHJvbXB0SWQ6ICdwMScsXG4gICAgICAgICAgICB0aHJlYWRVcmw6IG51bGwsXG4gICAgICAgICAgICBxdWVzdGlvbnMsXG4gICAgICAgICAgICByZXNwb25zZToge1xuICAgICAgICAgICAgICBlbmRJbnRlcnZpZXc6IGZhbHNlLFxuICAgICAgICAgICAgICBhbnN3ZXJzOiB7XG4gICAgICAgICAgICAgICAgZGVwdGhfdmVyaWZpY2F0aW9uX00wMDE6IHsgc2VsZWN0ZWQ6ICdZZXMsIHlvdSBnb3QgaXQgKFJlY29tbWVuZGVkKScsIG5vdGVzOiAnJyB9LFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHN0YXR1czogJ2Fuc3dlcmVkJyxcbiAgICAgICAgICB9LFxuICAgICAgICB9O1xuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGFzc2VydC5kZWVwRXF1YWwoXG4gICAgICAocmVzdWx0IGFzIHsgc3RydWN0dXJlZENvbnRlbnQ/OiB1bmtub3duIH0pLnN0cnVjdHVyZWRDb250ZW50LFxuICAgICAge1xuICAgICAgICBxdWVzdGlvbnMsXG4gICAgICAgIHJlc3BvbnNlOiB7XG4gICAgICAgICAgLy8gZW5kSW50ZXJ2aWV3IG1pcnJvcnMgdGhlIGxvY2FsIFJvdW5kUmVzdWx0IHNoYXBlIHNvIHJlZ2lzdGVyLWhvb2tzXG4gICAgICAgICAgLy8gc2VlcyBpZGVudGljYWwgcGF5bG9hZHMgb24gYm90aCBjb2RlIHBhdGhzLlxuICAgICAgICAgIGVuZEludGVydmlldzogZmFsc2UsXG4gICAgICAgICAgYW5zd2Vyczoge1xuICAgICAgICAgICAgZGVwdGhfdmVyaWZpY2F0aW9uX00wMDE6IHsgc2VsZWN0ZWQ6ICdZZXMsIHlvdSBnb3QgaXQgKFJlY29tbWVuZGVkKScsIG5vdGVzOiAnJyB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIGNhbmNlbGxlZDogZmFsc2UsXG4gICAgICB9LFxuICAgICk7XG4gIH0pO1xuXG4gIGl0KCdhc2tfdXNlcl9xdWVzdGlvbnMgc3VyZmFjZXMgcmVtb3RlIHRpbWVvdXQgYXMgY2FuY2VsbGVkIHN0cnVjdHVyZWRDb250ZW50IChyZWdyZXNzaW9uICM1MjY3KScsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBxdWVzdGlvbnMgPSBbXG4gICAgICB7XG4gICAgICAgIGlkOiAnZGVwdGhfdmVyaWZpY2F0aW9uX00wMDEnLFxuICAgICAgICBoZWFkZXI6ICdEZXB0aCBDaGVjaycsXG4gICAgICAgIHF1ZXN0aW9uOiAnRGlkIEkgY2FwdHVyZSB0aGUgZGVwdGggcmlnaHQ/JyxcbiAgICAgICAgb3B0aW9uczogW1xuICAgICAgICAgIHsgbGFiZWw6ICdZZXMsIHlvdSBnb3QgaXQgKFJlY29tbWVuZGVkKScsIGRlc2NyaXB0aW9uOiAnQ29udGludWUuJyB9LFxuICAgICAgICAgIHsgbGFiZWw6ICdOb3QgcXVpdGUnLCBkZXNjcmlwdGlvbjogJ0NsYXJpZnkuJyB9LFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICBdO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgYXNrVXNlclF1ZXN0aW9uc0hhbmRsZXIocXVlc3Rpb25zLCB1bmRlZmluZWQsIHtcbiAgICAgIGFzeW5jIGVsaWNpdElucHV0KCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ01DUCBob3N0IGRvZXMgbm90IHN1cHBvcnQgZWxpY2l0YXRpb24nKTtcbiAgICAgIH0sXG4gICAgICBpc1JlbW90ZUNvbmZpZ3VyZWQoKSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfSxcbiAgICAgIGFzeW5jIHRyeVJlbW90ZVF1ZXN0aW9ucygpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBjb250ZW50OiBbeyB0eXBlOiAndGV4dCcsIHRleHQ6ICd7XCJ0aW1lZF9vdXRcIjp0cnVlLFwiY2hhbm5lbFwiOlwiZGlzY29yZFwiLFwibWVzc2FnZVwiOlwiVXNlciBkaWQgbm90IHJlc3BvbmQgd2l0aGluIDUgbWludXRlcy5cIn0nIH1dLFxuICAgICAgICAgIGRldGFpbHM6IHsgcmVtb3RlOiB0cnVlLCBjaGFubmVsOiAnZGlzY29yZCcsIHRpbWVkX291dDogdHJ1ZSwgc3RhdHVzOiAndGltZWRfb3V0JyB9LFxuICAgICAgICB9O1xuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGFzc2VydC5kZWVwRXF1YWwoXG4gICAgICAocmVzdWx0IGFzIHsgc3RydWN0dXJlZENvbnRlbnQ/OiB1bmtub3duIH0pLnN0cnVjdHVyZWRDb250ZW50LFxuICAgICAgeyBxdWVzdGlvbnMsIHJlc3BvbnNlOiBudWxsLCBjYW5jZWxsZWQ6IHRydWUgfSxcbiAgICApO1xuICB9KTtcblxuICBpdCgnYXNrX3VzZXJfcXVlc3Rpb25zIHJlcG9ydHMgYSBtYWxmb3JtZWQgcmVtb3RlIHJlc3BvbnNlIGFzIGNhbmNlbGxlZCwgbm90IHNpbGVudCBzdWNjZXNzIChyZWdyZXNzaW9uICM1MjY3KScsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBxdWVzdGlvbnMgPSBbXG4gICAgICB7XG4gICAgICAgIGlkOiAnZGVwdGhfdmVyaWZpY2F0aW9uX00wMDEnLFxuICAgICAgICBoZWFkZXI6ICdEZXB0aCBDaGVjaycsXG4gICAgICAgIHF1ZXN0aW9uOiAnRGlkIEkgY2FwdHVyZSB0aGUgZGVwdGggcmlnaHQ/JyxcbiAgICAgICAgb3B0aW9uczogW1xuICAgICAgICAgIHsgbGFiZWw6ICdZZXMsIHlvdSBnb3QgaXQgKFJlY29tbWVuZGVkKScsIGRlc2NyaXB0aW9uOiAnQ29udGludWUuJyB9LFxuICAgICAgICAgIHsgbGFiZWw6ICdOb3QgcXVpdGUnLCBkZXNjcmlwdGlvbjogJ0NsYXJpZnkuJyB9LFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICBdO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgYXNrVXNlclF1ZXN0aW9uc0hhbmRsZXIocXVlc3Rpb25zLCB1bmRlZmluZWQsIHtcbiAgICAgIGFzeW5jIGVsaWNpdElucHV0KCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ01DUCBob3N0IGRvZXMgbm90IHN1cHBvcnQgZWxpY2l0YXRpb24nKTtcbiAgICAgIH0sXG4gICAgICBpc1JlbW90ZUNvbmZpZ3VyZWQoKSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfSxcbiAgICAgIGFzeW5jIHRyeVJlbW90ZVF1ZXN0aW9ucygpIHtcbiAgICAgICAgLy8gU2ltdWxhdGVzIGEgcmVtb3RlIG1vZHVsZSByZXR1cm5pbmcgYSBub24tY29uZm9ybWluZyBgZGV0YWlscy5yZXNwb25zZWBcbiAgICAgICAgLy8gKGUuZy4gYSBzdGFsZSBidWlsZCwgYSB3aXJlIG1pc21hdGNoKS4gVGhlIGhhbmRsZXIgbXVzdCBub3Qgc3VyZmFjZVxuICAgICAgICAvLyB0aGlzIGFzIGBjYW5jZWxsZWQ6IGZhbHNlLCByZXNwb25zZTogbnVsbGAgXHUyMDE0IHRoYXQgd291bGQgbGllIHRvIGFueVxuICAgICAgICAvLyBjb25zdW1lciByZWFkaW5nIGBzdHJ1Y3R1cmVkQ29udGVudC5jYW5jZWxsZWRgLlxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6ICd0ZXh0JywgdGV4dDogJ3t9JyB9XSxcbiAgICAgICAgICBkZXRhaWxzOiB7IHJlbW90ZTogdHJ1ZSwgY2hhbm5lbDogJ2Rpc2NvcmQnLCB0aW1lZF9vdXQ6IGZhbHNlLCByZXNwb25zZTogJ25vdC1hbi1vYmplY3QnIH0sXG4gICAgICAgIH07XG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICAgIChyZXN1bHQgYXMgeyBzdHJ1Y3R1cmVkQ29udGVudD86IHVua25vd24gfSkuc3RydWN0dXJlZENvbnRlbnQsXG4gICAgICB7IHF1ZXN0aW9ucywgcmVzcG9uc2U6IG51bGwsIGNhbmNlbGxlZDogdHJ1ZSB9LFxuICAgICk7XG4gIH0pO1xuXG4gIGl0KCdhc2tfdXNlcl9xdWVzdGlvbnMgcmV0dXJucyBjYW5jZWxsZWQgc3RydWN0dXJlZENvbnRlbnQgd2hlbiByZW1vdGUgaXMgdW5jb25maWd1cmVkIGFuZCBsb2NhbCBkZWNsaW5lcyAocmVncmVzc2lvbiAjNTI2NyknLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgcXVlc3Rpb25zID0gW1xuICAgICAge1xuICAgICAgICBpZDogJ2RlcHRoX3ZlcmlmaWNhdGlvbl9NMDAxJyxcbiAgICAgICAgaGVhZGVyOiAnRGVwdGggQ2hlY2snLFxuICAgICAgICBxdWVzdGlvbjogJ0RpZCBJIGNhcHR1cmUgdGhlIGRlcHRoIHJpZ2h0PycsXG4gICAgICAgIG9wdGlvbnM6IFtcbiAgICAgICAgICB7IGxhYmVsOiAnWWVzLCB5b3UgZ290IGl0IChSZWNvbW1lbmRlZCknLCBkZXNjcmlwdGlvbjogJ0NvbnRpbnVlLicgfSxcbiAgICAgICAgICB7IGxhYmVsOiAnTm90IHF1aXRlJywgZGVzY3JpcHRpb246ICdDbGFyaWZ5LicgfSxcbiAgICAgICAgXSxcbiAgICAgIH0sXG4gICAgXTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGFza1VzZXJRdWVzdGlvbnNIYW5kbGVyKHF1ZXN0aW9ucywgdW5kZWZpbmVkLCB7XG4gICAgICBhc3luYyBlbGljaXRJbnB1dCgpIHtcbiAgICAgICAgcmV0dXJuIHsgYWN0aW9uOiAnZGVjbGluZScgfTtcbiAgICAgIH0sXG4gICAgICBpc1JlbW90ZUNvbmZpZ3VyZWQoKSB7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgIH0sXG4gICAgICBhc3luYyB0cnlSZW1vdGVRdWVzdGlvbnMoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignc2hvdWxkIG5vdCBiZSBjYWxsZWQgd2hlbiByZW1vdGUgaXMgdW5jb25maWd1cmVkJyk7XG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICAgIChyZXN1bHQgYXMgeyBzdHJ1Y3R1cmVkQ29udGVudD86IHVua25vd24gfSkuc3RydWN0dXJlZENvbnRlbnQsXG4gICAgICB7IHF1ZXN0aW9ucywgcmVzcG9uc2U6IG51bGwsIGNhbmNlbGxlZDogdHJ1ZSB9LFxuICAgICk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5jb250ZW50WzBdPy50ZXh0LCAnYXNrX3VzZXJfcXVlc3Rpb25zIHdhcyBjYW5jZWxsZWQgYmVmb3JlIHJlY2VpdmluZyBhIHJlc3BvbnNlJyk7XG4gIH0pO1xuXG4gIGl0KCdhc2tfdXNlcl9xdWVzdGlvbnMgcmV0dXJucyBjYW5jZWxsZWQgc3RydWN0dXJlZENvbnRlbnQgd2hlbiBjb25maWd1cmVkIHJlbW90ZSByZXR1cm5zIG51bGwgKHJlZ3Jlc3Npb24gIzUyNjcpJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHF1ZXN0aW9ucyA9IFtcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdkZXB0aF92ZXJpZmljYXRpb25fTTAwMScsXG4gICAgICAgIGhlYWRlcjogJ0RlcHRoIENoZWNrJyxcbiAgICAgICAgcXVlc3Rpb246ICdEaWQgSSBjYXB0dXJlIHRoZSBkZXB0aCByaWdodD8nLFxuICAgICAgICBvcHRpb25zOiBbXG4gICAgICAgICAgeyBsYWJlbDogJ1llcywgeW91IGdvdCBpdCAoUmVjb21tZW5kZWQpJywgZGVzY3JpcHRpb246ICdDb250aW51ZS4nIH0sXG4gICAgICAgICAgeyBsYWJlbDogJ05vdCBxdWl0ZScsIGRlc2NyaXB0aW9uOiAnQ2xhcmlmeS4nIH0sXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgIF07XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBhc2tVc2VyUXVlc3Rpb25zSGFuZGxlcihxdWVzdGlvbnMsIHVuZGVmaW5lZCwge1xuICAgICAgYXN5bmMgZWxpY2l0SW5wdXQoKSB7XG4gICAgICAgIHJldHVybiB7IGFjdGlvbjogJ2NhbmNlbCcgfTtcbiAgICAgIH0sXG4gICAgICBpc1JlbW90ZUNvbmZpZ3VyZWQoKSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfSxcbiAgICAgIGFzeW5jIHRyeVJlbW90ZVF1ZXN0aW9ucygpIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICAgIChyZXN1bHQgYXMgeyBzdHJ1Y3R1cmVkQ29udGVudD86IHVua25vd24gfSkuc3RydWN0dXJlZENvbnRlbnQsXG4gICAgICB7IHF1ZXN0aW9ucywgcmVzcG9uc2U6IG51bGwsIGNhbmNlbGxlZDogdHJ1ZSB9LFxuICAgICk7XG4gIH0pO1xuXG4gIGl0KCdhc2tfdXNlcl9xdWVzdGlvbnMgcmUtdGhyb3dzIG5vbi1mYWxsYmFjayBsb2NhbCBlcnJvcnMgKHJlZ3Jlc3Npb24gIzUyNjcpJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHF1ZXN0aW9ucyA9IFtcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdkZXB0aF92ZXJpZmljYXRpb25fTTAwMScsXG4gICAgICAgIGhlYWRlcjogJ0RlcHRoIENoZWNrJyxcbiAgICAgICAgcXVlc3Rpb246ICdEaWQgSSBjYXB0dXJlIHRoZSBkZXB0aCByaWdodD8nLFxuICAgICAgICBvcHRpb25zOiBbXG4gICAgICAgICAgeyBsYWJlbDogJ1llcywgeW91IGdvdCBpdCAoUmVjb21tZW5kZWQpJywgZGVzY3JpcHRpb246ICdDb250aW51ZS4nIH0sXG4gICAgICAgICAgeyBsYWJlbDogJ05vdCBxdWl0ZScsIGRlc2NyaXB0aW9uOiAnQ2xhcmlmeS4nIH0sXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgIF07XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBhc2tVc2VyUXVlc3Rpb25zSGFuZGxlcihxdWVzdGlvbnMsIHVuZGVmaW5lZCwge1xuICAgICAgYXN5bmMgZWxpY2l0SW5wdXQoKSB7XG4gICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ3NjaGVtYSB2YWxpZGF0aW9uIGJsZXcgdXAnKTtcbiAgICAgIH0sXG4gICAgICBpc1JlbW90ZUNvbmZpZ3VyZWQoKSB7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgIH0sXG4gICAgICBhc3luYyB0cnlSZW1vdGVRdWVzdGlvbnMoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignc2hvdWxkIG5vdCBiZSBjYWxsZWQnKTtcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBOb24tZmFsbGJhY2sgZXJyb3JzIHByb3BhZ2F0ZSB0byB0aGUgb3V0ZXIgdHJ5L2NhdGNoIGFuZCBzdXJmYWNlIGFzIGFuXG4gICAgLy8gTUNQIGBpc0Vycm9yYCByZXN1bHQgXHUyMDE0IG5vIGBzdHJ1Y3R1cmVkQ29udGVudGAgaXMgYXR0YWNoZWQgYmVjYXVzZSB0aGVcbiAgICAvLyBlcnJvciBwYXRoIHByZWRhdGVzIHRoZSBzdHJ1Y3R1cmVkIHN1Y2Nlc3MvY2FuY2VsIGJyYW5jaGVzLlxuICAgIGFzc2VydC5lcXVhbCgnaXNFcnJvcicgaW4gcmVzdWx0ICYmIHJlc3VsdC5pc0Vycm9yLCB0cnVlKTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LmNvbnRlbnRbMF0/LnRleHQgPz8gJycsIC9zY2hlbWEgdmFsaWRhdGlvbiBibGV3IHVwLyk7XG4gIH0pO1xuXG4gIGl0KCdhc2tfdXNlcl9xdWVzdGlvbnMgcmVwb3J0cyBib3RoIGxvY2FsIGFuZCByZW1vdGUgZXJyb3JzIHdoZW4gYm90aCBwYXRocyBmYWlsJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHF1ZXN0aW9ucyA9IFtcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdkZXB0aF92ZXJpZmljYXRpb25fTTAwMScsXG4gICAgICAgIGhlYWRlcjogJ0RlcHRoIENoZWNrJyxcbiAgICAgICAgcXVlc3Rpb246ICdEaWQgSSBjYXB0dXJlIHRoZSBkZXB0aCByaWdodD8nLFxuICAgICAgICBvcHRpb25zOiBbXG4gICAgICAgICAgeyBsYWJlbDogJ1llcywgeW91IGdvdCBpdCAoUmVjb21tZW5kZWQpJywgZGVzY3JpcHRpb246ICdDb250aW51ZSB3aXRoIHRoZSBjdXJyZW50IHN1bW1hcnkuJyB9LFxuICAgICAgICAgIHsgbGFiZWw6ICdOb3QgcXVpdGUnLCBkZXNjcmlwdGlvbjogJ0kgbmVlZCB0byBjbGFyaWZ5IHRoZSBkZXB0aCBmdXJ0aGVyLicgfSxcbiAgICAgICAgXSxcbiAgICAgIH0sXG4gICAgXTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGFza1VzZXJRdWVzdGlvbnNIYW5kbGVyKHF1ZXN0aW9ucywgdW5kZWZpbmVkLCB7XG4gICAgICBhc3luYyBlbGljaXRJbnB1dCgpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdhc2tfdXNlcl9xdWVzdGlvbnMgdGltZWQgb3V0IGFmdGVyIDEwIG1pbnV0ZXMnKTtcbiAgICAgIH0sXG4gICAgICBpc1JlbW90ZUNvbmZpZ3VyZWQoKSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfSxcbiAgICAgIGFzeW5jIHRyeVJlbW90ZVF1ZXN0aW9ucygpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdyZW1vdGUgdHJhbnNwb3J0IGZhaWxlZCcpO1xuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGFzc2VydC5lcXVhbCgnaXNFcnJvcicgaW4gcmVzdWx0ICYmIHJlc3VsdC5pc0Vycm9yLCB0cnVlKTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LmNvbnRlbnRbMF0/LnRleHQgPz8gJycsIC9Mb2NhbCBlbGljaXRhdGlvbiBmYWlsZWQvKTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LmNvbnRlbnRbMF0/LnRleHQgPz8gJycsIC9yZW1vdGUgdHJhbnNwb3J0IGZhaWxlZC8pO1xuICB9KTtcbn0pO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIHdpdGhFbGljaXRUaW1lb3V0XG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZGVzY3JpYmUoJ3dpdGhFbGljaXRUaW1lb3V0JywgKCkgPT4ge1xuICBpdCgncmVzb2x2ZXMgd2l0aCB0aGUgcHJvbWlzZSB2YWx1ZSB3aGVuIGl0IHNldHRsZXMgYmVmb3JlIHRoZSB0aW1lb3V0JywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHdpdGhFbGljaXRUaW1lb3V0KFByb21pc2UucmVzb2x2ZSg0MiksICd0ZXN0JywgNTAwMCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgNDIpO1xuICB9KTtcblxuICBpdCgncmVqZWN0cyB3aXRoIGEgdGltZW91dCBlcnJvciB3aGVuIHRoZSBwcm9taXNlIGRvZXMgbm90IHNldHRsZSBpbiB0aW1lJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IG5ldmVyID0gbmV3IFByb21pc2U8bmV2ZXI+KCgpID0+IHt9KTtcbiAgICBhd2FpdCBhc3NlcnQucmVqZWN0cyhcbiAgICAgICgpID0+IHdpdGhFbGljaXRUaW1lb3V0KG5ldmVyLCAnYXNrX3VzZXJfcXVlc3Rpb25zJywgMSksXG4gICAgICAoZXJyOiBFcnJvcikgPT4ge1xuICAgICAgICBhc3NlcnQub2soZXJyLm1lc3NhZ2UuaW5jbHVkZXMoJ2Fza191c2VyX3F1ZXN0aW9ucycpKTtcbiAgICAgICAgYXNzZXJ0Lm9rKGVyci5tZXNzYWdlLmluY2x1ZGVzKCd0aW1lZCBvdXQnKSk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfSxcbiAgICApO1xuICB9KTtcblxuICBpdCgnY2xlYXJzIHRoZSB0aW1lciB3aGVuIHRoZSBwcm9taXNlIHJlc29sdmVzIChubyBkYW5nbGluZyB0aW1lciknLCBhc3luYyAoKSA9PiB7XG4gICAgLy8gU3B5IG9uIGNsZWFyVGltZW91dCBkaXJlY3RseS4gYHVuaGFuZGxlZFJlamVjdGlvbmAgaXMgbm90IGEgcmVsaWFibGVcbiAgICAvLyBwcm94eTogTm9kZSBkb2VzIG5vdCBmbGFnIGxvc2luZy1wcm9taXNlIHJlamVjdGlvbnMgZnJvbSBhIHNldHRsZWRcbiAgICAvLyBQcm9taXNlLnJhY2UgYXMgdW5oYW5kbGVkLCBzbyB0aGUgYWJzZW5jZSBvZiBhIHN0cmF5IHJlamVjdGlvbiBkb2VzXG4gICAgLy8gbm90IGFjdHVhbGx5IHByb3ZlIGNsZWFyVGltZW91dCByYW4uIEFzc2VydGluZyB0aGUgc3B5IHdhcyBpbnZva2VkXG4gICAgLy8gdGVzdHMgdGhlIGNsZWFudXAgY29udHJhY3QgZGlyZWN0bHkuXG4gICAgY29uc3Qgb3JpZ2luYWxDbGVhclRpbWVvdXQgPSBnbG9iYWxUaGlzLmNsZWFyVGltZW91dDtcbiAgICBsZXQgY2xlYXJDYWxscyA9IDA7XG4gICAgbGV0IGxhc3RDbGVhcmVkSWQ6IHVua25vd24gPSB1bmRlZmluZWQ7XG4gICAgZ2xvYmFsVGhpcy5jbGVhclRpbWVvdXQgPSAoKGlkOiBQYXJhbWV0ZXJzPHR5cGVvZiBvcmlnaW5hbENsZWFyVGltZW91dD5bMF0pID0+IHtcbiAgICAgIGNsZWFyQ2FsbHMrKztcbiAgICAgIGxhc3RDbGVhcmVkSWQgPSBpZDtcbiAgICAgIHJldHVybiBvcmlnaW5hbENsZWFyVGltZW91dChpZCk7XG4gICAgfSkgYXMgdHlwZW9mIGNsZWFyVGltZW91dDtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCB2YWx1ZSA9IGF3YWl0IHdpdGhFbGljaXRUaW1lb3V0KFByb21pc2UucmVzb2x2ZSgnZG9uZScpLCAndGVzdCcsIDUwXzAwMCk7XG4gICAgICBhc3NlcnQuZXF1YWwodmFsdWUsICdkb25lJyk7XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgIGNsZWFyQ2FsbHMgPj0gMSxcbiAgICAgICAgYGNsZWFyVGltZW91dCBzaG91bGQgcnVuIG9uIHJlc29sdmUgcGF0aDsgY2FsbHM9JHtjbGVhckNhbGxzfWAsXG4gICAgICApO1xuICAgICAgYXNzZXJ0Lm9rKGxhc3RDbGVhcmVkSWQgIT09IHVuZGVmaW5lZCwgJ2NsZWFyVGltZW91dCBzaG91bGQgYmUgY2FsbGVkIHdpdGggdGhlIHRpbWVyIGlkJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGdsb2JhbFRoaXMuY2xlYXJUaW1lb3V0ID0gb3JpZ2luYWxDbGVhclRpbWVvdXQ7XG4gICAgfVxuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBWUEsU0FBUyxVQUFVLElBQUksWUFBWSxpQkFBaUI7QUFDcEQsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxRQUFRLHFCQUFxQjtBQUNuRCxTQUFTLGNBQWM7QUFDdkIsU0FBUyxXQUFXLE1BQU0sZUFBZTtBQUd6QyxTQUFTLHNCQUFzQjtBQUMvQjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUNQLFNBQVMsa0JBQWtCO0FBTzNCLE1BQU0sY0FBYztBQUFBLEVBQ2xCLFVBQVU7QUFBQSxFQUNWLFVBQVU7QUFBQSxFQUNWLFVBQVU7QUFBQSxFQUNWLFdBQXFCLENBQUM7QUFBQSxFQUNkLGlCQUFrRSxDQUFDO0FBQUEsRUFDM0UsY0FBK0UsQ0FBQztBQUFBO0FBQUEsRUFHaEYsYUFBMkI7QUFBQTtBQUFBLEVBRTNCLFlBQTBCO0FBQUE7QUFBQSxFQUUxQixnQkFBZ0I7QUFBQSxFQUVoQjtBQUFBLEVBQ0E7QUFBQSxFQUVBLFlBQVksU0FBbUM7QUFDN0MsU0FBSyxNQUFPLFNBQVMsT0FBa0I7QUFDdkMsU0FBSyxPQUFRLFNBQVMsUUFBcUIsQ0FBQztBQUFBLEVBQzlDO0FBQUEsRUFFQSxNQUFNLFFBQXVCO0FBQzNCLFFBQUksS0FBSyxXQUFZLE9BQU0sS0FBSztBQUNoQyxTQUFLLFVBQVU7QUFBQSxFQUNqQjtBQUFBLEVBRUEsTUFBTSxPQUFzQjtBQUMxQixTQUFLLFVBQVU7QUFBQSxFQUNqQjtBQUFBLEVBRUEsTUFBTSxPQUF3RDtBQUM1RCxRQUFJLEtBQUssVUFBVyxPQUFNLEtBQUs7QUFDL0IsV0FBTyxFQUFFLFdBQVcsS0FBSyxlQUFlLFNBQVMsU0FBUztBQUFBLEVBQzVEO0FBQUEsRUFFQSxRQUFRLFVBQWdFO0FBQ3RFLFNBQUssZUFBZSxLQUFLLFFBQVE7QUFDakMsV0FBTyxNQUFNO0FBQ1gsWUFBTSxNQUFNLEtBQUssZUFBZSxRQUFRLFFBQVE7QUFDaEQsVUFBSSxPQUFPLEVBQUcsTUFBSyxlQUFlLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDakQ7QUFBQSxFQUNGO0FBQUEsRUFFQSxNQUFNLE9BQU8sU0FBZ0M7QUFDM0MsU0FBSyxTQUFTLEtBQUssT0FBTztBQUFBLEVBQzVCO0FBQUEsRUFFQSxNQUFNLFFBQXVCO0FBQzNCLFNBQUssVUFBVTtBQUFBLEVBQ2pCO0FBQUEsRUFFQSxlQUFlLFdBQW1CLFVBQXlDO0FBQ3pFLFNBQUssWUFBWSxLQUFLLEVBQUUsV0FBVyxTQUFTLENBQUM7QUFBQSxFQUMvQztBQUFBO0FBQUEsRUFHQSxVQUFVLE9BQXNDO0FBQzlDLGVBQVcsWUFBWSxLQUFLLGdCQUFnQjtBQUMxQyxlQUFTLEtBQUs7QUFBQSxJQUNoQjtBQUFBLEVBQ0Y7QUFDRjtBQVdBLE1BQU0sK0JBQStCLGVBQWU7QUFBQTtBQUFBLEVBRWxELGFBQW1DO0FBQUE7QUFBQSxFQUVuQyxhQUE4QixDQUFDO0FBQUE7QUFBQSxFQUV2QixpQkFBaUI7QUFBQTtBQUFBLEVBRXpCLGdCQUE4QjtBQUFBO0FBQUEsRUFFOUIsaUJBQStCO0FBQUEsRUFFL0IsTUFBZSxhQUFhLFlBQW9CLFVBQWtGLENBQUMsR0FBb0I7QUFDckosUUFBSSxDQUFDLGNBQWMsV0FBVyxLQUFLLE1BQU0sSUFBSTtBQUMzQyxZQUFNLElBQUksTUFBTSw0Q0FBNEM7QUFBQSxJQUM5RDtBQUVBLFVBQU0sY0FBYyxRQUFRLFVBQVU7QUFJdEMsVUFBTSxXQUFXLEtBQUssZ0JBQWdCLFdBQVc7QUFDakQsUUFBSSxVQUFVO0FBQ1osVUFBSSxTQUFTLFdBQVcsY0FBYyxTQUFTLFdBQVcsYUFBYSxTQUFTLFdBQVcsV0FBVztBQUNwRyxjQUFNLElBQUk7QUFBQSxVQUNSLDhCQUE4QixXQUFXLGdCQUFnQixTQUFTLFNBQVMsYUFBYSxTQUFTLE1BQU07QUFBQSxRQUN6RztBQUFBLE1BQ0Y7QUFDQSxlQUFTLGNBQWM7QUFDdkIsTUFBQyxLQUFhLFNBQVMsT0FBTyxXQUFXO0FBQUEsSUFDM0M7QUFFQSxVQUFNLFNBQVMsSUFBSSxjQUFjLEVBQUUsS0FBSyxhQUFhLE1BQU0sQ0FBQyxFQUFFLENBQUM7QUFDL0QsUUFBSSxLQUFLLGdCQUFnQjtBQUN2QixhQUFPLGFBQWEsS0FBSztBQUN6QixXQUFLLGlCQUFpQjtBQUFBLElBQ3hCO0FBQ0EsUUFBSSxLQUFLLGVBQWU7QUFDdEIsYUFBTyxZQUFZLEtBQUs7QUFDeEIsV0FBSyxnQkFBZ0I7QUFBQSxJQUN2QjtBQUVBLFNBQUs7QUFDTCxXQUFPLGdCQUFnQixnQkFBZ0IsT0FBTyxLQUFLLGNBQWMsRUFBRSxTQUFTLEdBQUcsR0FBRyxDQUFDO0FBQ25GLFNBQUssYUFBYTtBQUNsQixTQUFLLFdBQVcsS0FBSyxNQUFNO0FBRzNCLFVBQU0sVUFBMEI7QUFBQSxNQUM5QixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsTUFDWixRQUFRO0FBQUEsTUFDUjtBQUFBO0FBQUEsTUFDQSxRQUFRLENBQUM7QUFBQSxNQUNULGdCQUFnQjtBQUFBLE1BQ2hCLE1BQU0sRUFBRSxXQUFXLEdBQUcsUUFBUSxFQUFFLE9BQU8sR0FBRyxRQUFRLEdBQUcsV0FBVyxHQUFHLFlBQVksRUFBRSxFQUFFO0FBQUEsTUFDbkYsV0FBVyxLQUFLLElBQUk7QUFBQSxJQUN0QjtBQUdBLFNBQUssWUFBWSxhQUFhLE9BQU87QUFFckMsUUFBSTtBQUNGLFlBQU0sT0FBTyxNQUFNO0FBRW5CLFlBQU0sYUFBYSxNQUFNLE9BQU8sS0FBSztBQUNyQyxjQUFRLFlBQVksV0FBVztBQUMvQixjQUFRLFNBQVM7QUFHakIsY0FBUSxjQUFjLE9BQU8sUUFBUSxDQUFDLFVBQW1DO0FBQ3ZFLGFBQUssYUFBYSxTQUFTLEtBQUs7QUFBQSxNQUNsQyxDQUFDO0FBR0QsWUFBTSxVQUFVLFFBQVEsV0FBVztBQUNuQyxZQUFNLE9BQU8sT0FBTyxPQUFPO0FBRTNCLGFBQU8sUUFBUTtBQUFBLElBQ2pCLFNBQVMsS0FBSztBQUNaLGNBQVEsU0FBUztBQUNqQixjQUFRLFFBQVEsZUFBZSxRQUFRLElBQUksVUFBVSxPQUFPLEdBQUc7QUFDL0QsVUFBSTtBQUFFLGNBQU0sT0FBTyxLQUFLO0FBQUEsTUFBRyxRQUFRO0FBQUEsTUFBZ0I7QUFDbkQsWUFBTSxJQUFJLE1BQU0sK0JBQStCLFdBQVcsS0FBSyxRQUFRLEtBQUssRUFBRTtBQUFBLElBQ2hGO0FBQUEsRUFDRjtBQUFBO0FBQUEsRUFHQSxZQUFZLEtBQWEsU0FBK0I7QUFFdEQsSUFBQyxLQUFhLFNBQVMsSUFBSSxLQUFLLE9BQU87QUFBQSxFQUN6QztBQUFBO0FBQUEsRUFHQSxhQUFhLFNBQXlCLE9BQXNDO0FBQzFFLElBQUMsS0FBYSxZQUFZLFNBQVMsS0FBSztBQUFBLEVBQzFDO0FBQ0Y7QUFNQSxJQUFJLGNBQXdDLENBQUM7QUFFN0MsU0FBUyxnQkFBd0M7QUFDL0MsUUFBTSxNQUFNLElBQUksdUJBQXVCO0FBQ3ZDLGNBQVksS0FBSyxHQUFHO0FBQ3BCLFNBQU87QUFDVDtBQU1BLFNBQVMsa0JBQWtCLE1BQU07QUFDL0IsTUFBSTtBQUVKLGFBQVcsTUFBTTtBQUNmLFNBQUssY0FBYztBQUFBLEVBQ3JCLENBQUM7QUFFRCxZQUFVLFlBQVk7QUFDcEIsZUFBVyxPQUFPLGFBQWE7QUFDN0IsWUFBTSxJQUFJLFFBQVE7QUFBQSxJQUNwQjtBQUNBLGtCQUFjLENBQUM7QUFBQSxFQUNqQixDQUFDO0FBRUQsS0FBRyxzREFBc0QsWUFBWTtBQUNuRSxVQUFNLFlBQVksTUFBTSxHQUFHLGFBQWEscUJBQXFCLEVBQUUsU0FBUyxlQUFlLENBQUM7QUFDeEYsV0FBTyxNQUFNLFdBQVcsa0JBQWtCO0FBRTFDLFVBQU0sVUFBVSxHQUFHLFdBQVcsU0FBUztBQUN2QyxXQUFPLEdBQUcsT0FBTztBQUNqQixXQUFPLE1BQU0sUUFBUSxRQUFRLFNBQVM7QUFDdEMsV0FBTyxNQUFNLFFBQVEsWUFBWSxRQUFRLG1CQUFtQixDQUFDO0FBQUEsRUFDL0QsQ0FBQztBQUVELEtBQUcsMkNBQTJDLFlBQVk7QUFDeEQsVUFBTSxHQUFHLGFBQWEsb0JBQW9CLEVBQUUsU0FBUyxlQUFlLENBQUM7QUFDckUsV0FBTyxHQUFHLEdBQUcsVUFBVTtBQUN2QixXQUFPLFVBQVUsR0FBRyxXQUFXLFVBQVUsQ0FBQyxXQUFXLENBQUM7QUFBQSxFQUN4RCxDQUFDO0FBRUQsS0FBRyxtREFBbUQsWUFBWTtBQUNoRSxVQUFNLEdBQUcsYUFBYSxpQkFBaUIsRUFBRSxTQUFTLGdCQUFnQixTQUFTLHFCQUFxQixDQUFDO0FBQ2pHLFdBQU8sR0FBRyxHQUFHLFVBQVU7QUFDdkIsV0FBTyxVQUFVLEdBQUcsV0FBVyxVQUFVLENBQUMsb0JBQW9CLENBQUM7QUFBQSxFQUNqRSxDQUFDO0FBRUQsS0FBRyw2Q0FBNkMsWUFBWTtBQUMxRCxVQUFNLEdBQUcsYUFBYSxpQkFBaUIsRUFBRSxTQUFTLGVBQWUsQ0FBQztBQUNsRSxVQUFNLE9BQU87QUFBQSxNQUNYLE1BQU0sR0FBRyxhQUFhLGlCQUFpQixFQUFFLFNBQVMsZUFBZSxDQUFDO0FBQUEsTUFDbEUsQ0FBQyxRQUFlO0FBQ2QsZUFBTyxHQUFHLElBQUksUUFBUSxTQUFTLHdCQUF3QixDQUFDO0FBQ3hELGVBQU87QUFBQSxNQUNUO0FBQUEsSUFDRjtBQUFBLEVBQ0YsQ0FBQztBQUtELGFBQVcsa0JBQWtCLENBQUMsYUFBYSxTQUFTLFdBQVcsR0FBWTtBQUN6RSxPQUFHLGdDQUFnQyxjQUFjLHFDQUFxQyxZQUFZO0FBQ2hHLFlBQU0sTUFBTSxjQUFjLGNBQWM7QUFDeEMsWUFBTSxpQkFBaUIsTUFBTSxHQUFHLGFBQWEsS0FBSyxFQUFFLFNBQVMsZUFBZSxDQUFDO0FBQzdFLFlBQU0sUUFBUSxHQUFHLFdBQVcsY0FBYztBQUMxQyxZQUFNLFNBQVM7QUFHZixZQUFNLGtCQUFrQixNQUFNLEdBQUcsYUFBYSxLQUFLLEVBQUUsU0FBUyxlQUFlLENBQUM7QUFDOUUsYUFBTyxTQUFTLGlCQUFpQixjQUFjO0FBQy9DLFlBQU0sU0FBUyxHQUFHLFdBQVcsZUFBZTtBQUM1QyxhQUFPLE1BQU0sT0FBTyxRQUFRLFNBQVM7QUFDckMsYUFBTyxNQUFNLEdBQUcsZ0JBQWdCLEdBQUcsRUFBRyxXQUFXLGVBQWU7QUFBQSxJQUNsRSxDQUFDO0FBQUEsRUFDSDtBQUVBLGFBQVcsZ0JBQWdCLENBQUMsWUFBWSxXQUFXLFNBQVMsR0FBWTtBQUN0RSxPQUFHLHVDQUF1QyxZQUFZLGFBQWEsWUFBWTtBQUM3RSxZQUFNLE1BQU0sYUFBYSxZQUFZO0FBQ3JDLFlBQU0sTUFBTSxNQUFNLEdBQUcsYUFBYSxLQUFLLEVBQUUsU0FBUyxlQUFlLENBQUM7QUFDbEUsU0FBRyxXQUFXLEdBQUcsRUFBRyxTQUFTO0FBQzdCLFlBQU0sT0FBTztBQUFBLFFBQ1gsTUFBTSxHQUFHLGFBQWEsS0FBSyxFQUFFLFNBQVMsZUFBZSxDQUFDO0FBQUEsUUFDdEQ7QUFBQSxNQUNGO0FBQUEsSUFDRixDQUFDO0FBQUEsRUFDSDtBQUVBLEtBQUcseUNBQXlDLFlBQVk7QUFDdEQsVUFBTSxPQUFPO0FBQUEsTUFDWCxNQUFNLEdBQUcsYUFBYSxJQUFJLEVBQUUsU0FBUyxlQUFlLENBQUM7QUFBQSxNQUNyRCxDQUFDLFFBQWU7QUFDZCxlQUFPLEdBQUcsSUFBSSxRQUFRLFNBQVMsd0JBQXdCLENBQUM7QUFDeEQsZUFBTztBQUFBLE1BQ1Q7QUFBQSxJQUNGO0FBQUEsRUFDRixDQUFDO0FBRUQsS0FBRyxxREFBcUQsWUFBWTtBQUNsRSxPQUFHLGlCQUFpQixJQUFJLE1BQU0sY0FBYztBQUU1QyxVQUFNLE9BQU87QUFBQSxNQUNYLE1BQU0sR0FBRyxhQUFhLG1CQUFtQixFQUFFLFNBQVMsZUFBZSxDQUFDO0FBQUEsTUFDcEUsQ0FBQyxRQUFlO0FBQ2QsZUFBTyxHQUFHLElBQUksUUFBUSxTQUFTLHlCQUF5QixDQUFDO0FBQ3pELGVBQU8sR0FBRyxJQUFJLFFBQVEsU0FBUyxjQUFjLENBQUM7QUFDOUMsZUFBTztBQUFBLE1BQ1Q7QUFBQSxJQUNGO0FBQUEsRUFDRixDQUFDO0FBRUQsS0FBRyxvREFBb0QsWUFBWTtBQUNqRSxPQUFHLGdCQUFnQixJQUFJLE1BQU0sa0JBQWtCO0FBRS9DLFVBQU0sT0FBTztBQUFBLE1BQ1gsTUFBTSxHQUFHLGFBQWEsa0JBQWtCLEVBQUUsU0FBUyxlQUFlLENBQUM7QUFBQSxNQUNuRSxDQUFDLFFBQWU7QUFDZCxlQUFPLEdBQUcsSUFBSSxRQUFRLFNBQVMseUJBQXlCLENBQUM7QUFDekQsZUFBTyxHQUFHLElBQUksUUFBUSxTQUFTLGtCQUFrQixDQUFDO0FBQ2xELGVBQU87QUFBQSxNQUNUO0FBQUEsSUFDRjtBQUFBLEVBQ0YsQ0FBQztBQUVELEtBQUcsc0RBQXNELE1BQU07QUFDN0QsVUFBTSxTQUFTLEdBQUcsV0FBVyxnQkFBZ0I7QUFDN0MsV0FBTyxNQUFNLFFBQVEsTUFBUztBQUFBLEVBQ2hDLENBQUM7QUFFRCxLQUFHLGlEQUFpRCxZQUFZO0FBQzlELFVBQU0sR0FBRyxhQUFhLGVBQWUsRUFBRSxTQUFTLGVBQWUsQ0FBQztBQUNoRSxVQUFNLFVBQVUsR0FBRyxnQkFBZ0IsYUFBYTtBQUNoRCxXQUFPLEdBQUcsT0FBTztBQUNqQixXQUFPLE1BQU0sUUFBUSxXQUFXLGtCQUFrQjtBQUFBLEVBQ3BELENBQUM7QUFFRCxLQUFHLGlEQUFpRCxZQUFZO0FBQzlELFVBQU0sWUFBWSxNQUFNLEdBQUcsYUFBYSxtQkFBbUIsRUFBRSxTQUFTLGVBQWUsQ0FBQztBQUN0RixVQUFNLE9BQU87QUFBQSxNQUNYLE1BQU0sR0FBRyxlQUFlLFdBQVcsZUFBZTtBQUFBLE1BQ2xELENBQUMsUUFBZTtBQUNkLGVBQU8sR0FBRyxJQUFJLFFBQVEsU0FBUyxvQkFBb0IsQ0FBQztBQUNwRCxlQUFPO0FBQUEsTUFDVDtBQUFBLElBQ0Y7QUFBQSxFQUNGLENBQUM7QUFFRCxLQUFHLDZDQUE2QyxZQUFZO0FBQzFELFVBQU0sT0FBTztBQUFBLE1BQ1gsTUFBTSxHQUFHLGVBQWUsbUJBQW1CLGVBQWU7QUFBQSxNQUMxRCxDQUFDLFFBQWU7QUFDZCxlQUFPLEdBQUcsSUFBSSxRQUFRLFNBQVMsbUJBQW1CLENBQUM7QUFDbkQsZUFBTztBQUFBLE1BQ1Q7QUFBQSxJQUNGO0FBQUEsRUFDRixDQUFDO0FBRUQsS0FBRyw4REFBOEQsWUFBWTtBQUMzRSxVQUFNLFlBQVksTUFBTSxHQUFHLGFBQWEsd0JBQXdCLEVBQUUsU0FBUyxlQUFlLENBQUM7QUFDM0YsVUFBTSxTQUFTLEdBQUc7QUFHbEIsV0FBTyxVQUFVO0FBQUEsTUFDZixNQUFNO0FBQUEsTUFDTixJQUFJO0FBQUEsTUFDSixRQUFRO0FBQUEsTUFDUixPQUFPO0FBQUEsSUFDVCxDQUFDO0FBRUQsVUFBTSxVQUFVLEdBQUcsV0FBVyxTQUFTO0FBQ3ZDLFdBQU8sR0FBRyxRQUFRLGNBQWM7QUFDaEMsV0FBTyxNQUFNLFFBQVEsUUFBUSxTQUFTO0FBR3RDLFVBQU0sR0FBRyxlQUFlLFdBQVcsVUFBVTtBQUU3QyxXQUFPLE1BQU0sUUFBUSxnQkFBZ0IsSUFBSTtBQUN6QyxXQUFPLE1BQU0sUUFBUSxRQUFRLFNBQVM7QUFDdEMsV0FBTyxNQUFNLE9BQU8sWUFBWSxRQUFRLENBQUM7QUFDekMsV0FBTyxNQUFNLE9BQU8sWUFBWSxDQUFDLEVBQUUsV0FBVyxRQUFRO0FBQUEsRUFDeEQsQ0FBQztBQUVELEtBQUcsOENBQThDLFlBQVk7QUFDM0QsVUFBTSxZQUFZLE1BQU0sR0FBRyxhQUFhLG9CQUFvQixFQUFFLFNBQVMsZUFBZSxDQUFDO0FBQ3ZGLFVBQU0sU0FBUyxHQUFHO0FBRWxCLFVBQU0sR0FBRyxjQUFjLFNBQVM7QUFFaEMsV0FBTyxHQUFHLE9BQU8sT0FBTztBQUN4QixXQUFPLEdBQUcsT0FBTyxPQUFPO0FBRXhCLFVBQU0sVUFBVSxHQUFHLFdBQVcsU0FBUztBQUN2QyxXQUFPLE1BQU0sUUFBUSxRQUFRLFdBQVc7QUFBQSxFQUMxQyxDQUFDO0FBRUQsS0FBRyw0Q0FBNEMsWUFBWTtBQUN6RCxVQUFNLE9BQU87QUFBQSxNQUNYLE1BQU0sR0FBRyxjQUFjLFNBQVM7QUFBQSxNQUNoQyxDQUFDLFFBQWU7QUFDZCxlQUFPLEdBQUcsSUFBSSxRQUFRLFNBQVMsbUJBQW1CLENBQUM7QUFDbkQsZUFBTztBQUFBLE1BQ1Q7QUFBQSxJQUNGO0FBQUEsRUFDRixDQUFDO0FBRUQsS0FBRyxxQ0FBcUMsWUFBWTtBQUNsRCxVQUFNLEdBQUcsYUFBYSxrQkFBa0IsRUFBRSxTQUFTLGVBQWUsQ0FBQztBQUNuRSxVQUFNLEdBQUcsYUFBYSxrQkFBa0IsRUFBRSxTQUFTLGVBQWUsQ0FBQztBQUVuRSxXQUFPLE1BQU0sR0FBRyxXQUFXLFFBQVEsQ0FBQztBQUVwQyxVQUFNLEdBQUcsUUFBUTtBQUVqQixlQUFXLFVBQVUsR0FBRyxZQUFZO0FBQ2xDLGFBQU8sR0FBRyxPQUFPLFNBQVMsd0NBQXdDO0FBQUEsSUFDcEU7QUFBQSxFQUNGLENBQUM7QUFFRCxLQUFHLHdDQUF3QyxZQUFZO0FBQ3JELFVBQU0sWUFBWSxNQUFNLEdBQUcsYUFBYSxvQkFBb0IsRUFBRSxTQUFTLGVBQWUsQ0FBQztBQUN2RixVQUFNLFNBQVMsR0FBRztBQUVsQixhQUFTLElBQUksR0FBRyxJQUFJLGFBQWEsSUFBSSxLQUFLO0FBQ3hDLGFBQU8sVUFBVSxFQUFFLE1BQU0sWUFBWSxPQUFPLEVBQUUsQ0FBQztBQUFBLElBQ2pEO0FBRUEsVUFBTSxVQUFVLEdBQUcsV0FBVyxTQUFTO0FBQ3ZDLFdBQU8sTUFBTSxRQUFRLE9BQU8sUUFBUSxVQUFVO0FBRTlDLFdBQU8sTUFBTyxRQUFRLE9BQU8sQ0FBQyxFQUE4QixPQUFPLEVBQUU7QUFBQSxFQUN2RSxDQUFDO0FBRUQsS0FBRyxtRkFBbUYsWUFBWTtBQUNoRyxVQUFNLFlBQVksTUFBTSxHQUFHLGFBQWEsdUJBQXVCLEVBQUUsU0FBUyxlQUFlLENBQUM7QUFDMUYsVUFBTSxTQUFTLEdBQUc7QUFHbEIsV0FBTyxVQUFVO0FBQUEsTUFDZixNQUFNO0FBQUEsTUFDTixJQUFJO0FBQUEsTUFDSixRQUFRO0FBQUEsTUFDUixPQUFPO0FBQUEsSUFDVCxDQUFDO0FBRUQsVUFBTSxVQUFVLEdBQUcsV0FBVyxTQUFTO0FBQ3ZDLFdBQU8sTUFBTSxRQUFRLFFBQVEsU0FBUztBQUN0QyxXQUFPLEdBQUcsUUFBUSxjQUFjO0FBQ2hDLFdBQU8sTUFBTSxRQUFRLGVBQWUsSUFBSSxRQUFRO0FBQ2hELFdBQU8sTUFBTSxRQUFRLGVBQWUsUUFBUSxRQUFRO0FBQUEsRUFDdEQsQ0FBQztBQUVELEtBQUcscURBQXFELFlBQVk7QUFDbEUsVUFBTSxZQUFZLE1BQU0sR0FBRyxhQUFhLG9CQUFvQixFQUFFLFNBQVMsZUFBZSxDQUFDO0FBQ3ZGLFVBQU0sU0FBUyxHQUFHO0FBR2xCLFdBQU8sVUFBVTtBQUFBLE1BQ2YsTUFBTTtBQUFBLE1BQ04sSUFBSTtBQUFBLE1BQ0osUUFBUTtBQUFBLE1BQ1IsU0FBUztBQUFBLElBQ1gsQ0FBQztBQUVELFVBQU0sVUFBVSxHQUFHLFdBQVcsU0FBUztBQUN2QyxXQUFPLE1BQU0sUUFBUSxRQUFRLFNBQVM7QUFDdEMsV0FBTyxNQUFNLFFBQVEsZ0JBQWdCLElBQUk7QUFBQSxFQUMzQyxDQUFDO0FBRUQsS0FBRyxrRUFBa0UsWUFBWTtBQUMvRSxVQUFNLFlBQVksTUFBTSxHQUFHLGFBQWEsaUJBQWlCLEVBQUUsU0FBUyxlQUFlLENBQUM7QUFDcEYsVUFBTSxTQUFTLEdBQUc7QUFFbEIsV0FBTyxVQUFVO0FBQUEsTUFDZixNQUFNO0FBQUEsTUFDTixRQUFRO0FBQUEsTUFDUixTQUFTO0FBQUEsTUFDVCxJQUFJO0FBQUEsSUFDTixDQUFDO0FBRUQsVUFBTSxVQUFVLEdBQUcsV0FBVyxTQUFTO0FBQ3ZDLFdBQU8sTUFBTSxRQUFRLFFBQVEsV0FBVztBQUFBLEVBQzFDLENBQUM7QUFFRCxLQUFHLG1FQUFtRSxZQUFZO0FBQ2hGLFVBQU0sWUFBWSxNQUFNLEdBQUcsYUFBYSx5QkFBeUIsRUFBRSxTQUFTLGVBQWUsQ0FBQztBQUM1RixVQUFNLFNBQVMsR0FBRztBQUVsQixXQUFPLFVBQVU7QUFBQSxNQUNmLE1BQU07QUFBQSxNQUNOLFFBQVE7QUFBQSxNQUNSLFNBQVM7QUFBQSxNQUNULElBQUk7QUFBQSxJQUNOLENBQUM7QUFFRCxVQUFNLFVBQVUsR0FBRyxXQUFXLFNBQVM7QUFDdkMsV0FBTyxNQUFNLFFBQVEsUUFBUSxTQUFTO0FBQ3RDLFdBQU8sR0FBRyxRQUFRLGNBQWM7QUFBQSxFQUNsQyxDQUFDO0FBRUQsS0FBRyx5REFBeUQsWUFBWTtBQUN0RSxVQUFNLFlBQVksTUFBTSxHQUFHLGFBQWEsbUJBQW1CLEVBQUUsU0FBUyxlQUFlLENBQUM7QUFDdEYsVUFBTSxTQUFTLEdBQUc7QUFFbEIsV0FBTyxVQUFVO0FBQUEsTUFDZixNQUFNO0FBQUEsTUFDTixnQkFBZ0I7QUFBQSxNQUNoQixRQUFRLEVBQUUsT0FBTyxLQUFNLFFBQVEsS0FBSyxXQUFXLEtBQUssWUFBWSxJQUFJO0FBQUEsSUFDdEUsQ0FBQztBQUVELFdBQU8sVUFBVTtBQUFBLE1BQ2YsTUFBTTtBQUFBLE1BQ04sZ0JBQWdCO0FBQUEsTUFDaEIsUUFBUSxFQUFFLE9BQU8sTUFBTSxRQUFRLEtBQUssV0FBVyxLQUFLLFlBQVksSUFBSTtBQUFBLElBQ3RFLENBQUM7QUFFRCxVQUFNLFVBQVUsR0FBRyxXQUFXLFNBQVM7QUFDdkMsV0FBTyxNQUFNLFFBQVEsS0FBSyxXQUFXLElBQUk7QUFDekMsV0FBTyxNQUFNLFFBQVEsS0FBSyxPQUFPLE9BQU8sSUFBSTtBQUM1QyxXQUFPLE1BQU0sUUFBUSxLQUFLLE9BQU8sUUFBUSxHQUFHO0FBQzVDLFdBQU8sTUFBTSxRQUFRLEtBQUssT0FBTyxXQUFXLEdBQUc7QUFDL0MsV0FBTyxNQUFNLFFBQVEsS0FBSyxPQUFPLFlBQVksR0FBRztBQUFBLEVBQ2xELENBQUM7QUFFRCxLQUFHLHNEQUFzRCxZQUFZO0FBQ25FLFVBQU0sWUFBWSxNQUFNLEdBQUcsYUFBYSxxQkFBcUIsRUFBRSxTQUFTLGVBQWUsQ0FBQztBQUN4RixVQUFNLFNBQVMsR0FBRyxVQUFVLFNBQVM7QUFFckMsV0FBTyxNQUFNLE9BQU8sV0FBVyxTQUFTO0FBQ3hDLFdBQU8sTUFBTSxPQUFPLFlBQVksUUFBUSxtQkFBbUIsQ0FBQztBQUM1RCxXQUFPLE1BQU0sT0FBTyxRQUFRLFNBQVM7QUFDckMsV0FBTyxNQUFNLE9BQU8sT0FBTyxZQUFZLFFBQVE7QUFDL0MsV0FBTyxHQUFHLE9BQU8sSUFBSTtBQUNyQixXQUFPLEdBQUcsTUFBTSxRQUFRLE9BQU8sWUFBWSxDQUFDO0FBQzVDLFdBQU8sTUFBTSxPQUFPLGdCQUFnQixJQUFJO0FBQ3hDLFdBQU8sTUFBTSxPQUFPLE9BQU8sSUFBSTtBQUFBLEVBQ2pDLENBQUM7QUFFRCxLQUFHLHdDQUF3QyxNQUFNO0FBQy9DLFdBQU87QUFBQSxNQUNMLE1BQU0sR0FBRyxVQUFVLFNBQVM7QUFBQSxNQUM1QixDQUFDLFFBQWU7QUFDZCxlQUFPLEdBQUcsSUFBSSxRQUFRLFNBQVMsbUJBQW1CLENBQUM7QUFDbkQsZUFBTztBQUFBLE1BQ1Q7QUFBQSxJQUNGO0FBQUEsRUFDRixDQUFDO0FBQ0gsQ0FBQztBQU1ELFNBQVMsaUNBQWlDLE1BQU07QUFDOUMsUUFBTSxrQkFBa0IsUUFBUSxJQUFJLGNBQWM7QUFDbEQsUUFBTSxlQUFlLFFBQVEsSUFBSSxNQUFNO0FBQ3ZDLFFBQU0sb0JBQW9CLFFBQVEsSUFBSSxNQUFNO0FBRTVDLFlBQVUsTUFBTTtBQUNkLFFBQUksb0JBQW9CLFFBQVc7QUFDakMsY0FBUSxJQUFJLGNBQWMsSUFBSTtBQUFBLElBQ2hDLE9BQU87QUFDTCxhQUFPLFFBQVEsSUFBSSxjQUFjO0FBQUEsSUFDbkM7QUFDQSxRQUFJLGlCQUFpQixRQUFXO0FBQzlCLGNBQVEsSUFBSSxNQUFNLElBQUk7QUFBQSxJQUN4QixPQUFPO0FBQ0wsYUFBTyxRQUFRLElBQUksTUFBTTtBQUFBLElBQzNCO0FBQ0EsUUFBSSxzQkFBc0IsUUFBVztBQUNuQyxjQUFRLElBQUksTUFBTSxJQUFJO0FBQUEsSUFDeEIsT0FBTztBQUNMLGFBQU8sUUFBUSxJQUFJLE1BQU07QUFBQSxJQUMzQjtBQUFBLEVBQ0YsQ0FBQztBQUVELEtBQUcseUNBQXlDLE1BQU07QUFDaEQsWUFBUSxJQUFJLGNBQWMsSUFBSTtBQUM5QixVQUFNLFNBQVMsZUFBZSxlQUFlO0FBQzdDLFdBQU8sTUFBTSxRQUFRLFFBQVEscUJBQXFCLENBQUM7QUFBQSxFQUNyRCxDQUFDO0FBRUQsS0FBRyxtREFBbUQsTUFBTTtBQUMxRCxXQUFPLFFBQVEsSUFBSSxjQUFjO0FBQ2pDLFVBQU0sTUFBTSxZQUFZLEtBQUssT0FBTyxHQUFHLGVBQWUsQ0FBQztBQUN2RCxRQUFJO0FBQ0YsWUFBTSxXQUFXLFFBQVEsYUFBYSxVQUFVLFlBQVk7QUFDNUQsWUFBTSxXQUFXLEtBQUssS0FBSyxRQUFRO0FBQ25DLG9CQUFjLFVBQVUsSUFBSSxNQUFNO0FBQ2xDLGNBQVEsSUFBSSxNQUFNLElBQUksQ0FBQyxLQUFLLFlBQVksRUFBRSxPQUFPLE9BQU8sRUFBRSxLQUFLLFNBQVM7QUFFeEUsWUFBTSxlQUFlLGVBQWUsZUFBZTtBQUNuRCxVQUFJLFFBQVEsYUFBYSxTQUFTO0FBQ2hDLGVBQU8sTUFBTSxhQUFhLFlBQVksR0FBRyxRQUFRLFFBQVEsRUFBRSxZQUFZLENBQUM7QUFBQSxNQUMxRSxPQUFPO0FBQ0wsZUFBTyxNQUFNLGNBQWMsUUFBUSxRQUFRLENBQUM7QUFBQSxNQUM5QztBQUFBLElBQ0YsVUFBRTtBQUNBLGFBQU8sS0FBSyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQzlDO0FBQUEsRUFDRixDQUFDO0FBRUQsS0FBRyx1REFBdUQsTUFBTTtBQUM5RCxXQUFPLFFBQVEsSUFBSSxjQUFjO0FBQ2pDLFdBQU8sUUFBUSxJQUFJLE1BQU07QUFDekIsVUFBTSxNQUFNLFlBQVksS0FBSyxPQUFPLEdBQUcscUJBQXFCLENBQUM7QUFDN0QsUUFBSTtBQUNGLFlBQU0sV0FBVyxRQUFRLGFBQWEsVUFBVSxZQUFZO0FBQzVELFlBQU0sV0FBVyxLQUFLLEtBQUssUUFBUTtBQUNuQyxvQkFBYyxVQUFVLElBQUksTUFBTTtBQUNsQyxjQUFRLElBQUksTUFBTSxJQUFJO0FBRXRCLFlBQU0sZUFBZSxlQUFlLGVBQWU7QUFDbkQsVUFBSSxRQUFRLGFBQWEsU0FBUztBQUNoQyxlQUFPLE1BQU0sYUFBYSxZQUFZLEdBQUcsUUFBUSxRQUFRLEVBQUUsWUFBWSxDQUFDO0FBQUEsTUFDMUUsT0FBTztBQUNMLGVBQU8sTUFBTSxjQUFjLFFBQVEsUUFBUSxDQUFDO0FBQUEsTUFDOUM7QUFBQSxJQUNGLFVBQUU7QUFDQSxhQUFPLEtBQUssRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUM5QztBQUFBLEVBQ0YsQ0FBQztBQUVELEtBQUcsMERBQTBELE1BQU07QUFDakUsV0FBTyxRQUFRLElBQUksY0FBYztBQUNqQyxXQUFPLFFBQVEsSUFBSSxNQUFNO0FBQ3pCLFlBQVEsSUFBSSxNQUFNLElBQUk7QUFDdEIsV0FBTztBQUFBLE1BQ0wsTUFBTSxlQUFlLGVBQWU7QUFBQSxNQUNwQyxDQUFDLFFBQWU7QUFDZCxlQUFPLEdBQUcsSUFBSSxRQUFRLFNBQVMscUJBQXFCLENBQUM7QUFDckQsZUFBTztBQUFBLE1BQ1Q7QUFBQSxJQUNGO0FBQUEsRUFDRixDQUFDO0FBQ0gsQ0FBQztBQU1ELFNBQVMscUNBQXFDLE1BQU07QUFDbEQsTUFBSTtBQUVKLGFBQVcsTUFBTTtBQUNmLFNBQUssY0FBYztBQUFBLEVBQ3JCLENBQUM7QUFFRCxZQUFVLFlBQVk7QUFDcEIsZUFBVyxPQUFPLGFBQWE7QUFDN0IsWUFBTSxJQUFJLFFBQVE7QUFBQSxJQUNwQjtBQUNBLGtCQUFjLENBQUM7QUFBQSxFQUNqQixDQUFDO0FBRUQsS0FBRyx5REFBeUQsWUFBWTtBQUN0RSxVQUFNLEVBQUUsT0FBTyxJQUFJLE1BQU0sZ0JBQWdCLEVBQUU7QUFDM0MsV0FBTyxHQUFHLE1BQU07QUFDaEIsV0FBTyxHQUFHLE9BQU8sTUFBTTtBQUN2QixXQUFPLE1BQU0sT0FBTyxPQUFPLE9BQU8sYUFBYSxVQUFVO0FBQ3pELFdBQU8sR0FBRyxPQUFPLE9BQU8sWUFBWSxVQUFVO0FBQzlDLFdBQU8sR0FBRyxPQUFPLE9BQU8sVUFBVSxVQUFVO0FBQUEsRUFDOUMsQ0FBQztBQUVELEtBQUcsaURBQWlELFlBQVk7QUFDOUQsVUFBTSxZQUFZLE1BQU0sR0FBRyxhQUFhLGtCQUFrQixFQUFFLFNBQVMsZUFBZSxDQUFDO0FBQ3JGLFdBQU8sTUFBTSxPQUFPLFdBQVcsUUFBUTtBQUN2QyxXQUFPLEdBQUcsVUFBVSxTQUFTLENBQUM7QUFBQSxFQUNoQyxDQUFDO0FBRUQsS0FBRyx5Q0FBeUMsWUFBWTtBQUN0RCxVQUFNLFlBQVksTUFBTSxHQUFHLGFBQWEsb0JBQW9CLEVBQUUsU0FBUyxlQUFlLENBQUM7QUFDdkYsVUFBTSxVQUFVLEdBQUcsV0FBVyxTQUFTO0FBRXZDLFdBQU8sTUFBTSxPQUFPLFFBQVEsUUFBUSxRQUFRO0FBQzVDLFdBQU8sR0FBRyxNQUFNLFFBQVEsUUFBUSxNQUFNLENBQUM7QUFDdkMsV0FBTyxHQUFHLFFBQVEsSUFBSTtBQUN0QixXQUFPLE1BQU0sT0FBTyxRQUFRLFdBQVcsUUFBUTtBQUFBLEVBQ2pELENBQUM7QUFFRCxLQUFHLDBEQUEwRCxZQUFZO0FBQ3ZFLFVBQU0sWUFBWSxNQUFNLEdBQUcsYUFBYSxxQkFBcUIsRUFBRSxTQUFTLGVBQWUsQ0FBQztBQUN4RixVQUFNLE9BQU87QUFBQSxNQUNYLE1BQU0sR0FBRyxlQUFlLFdBQVcsS0FBSztBQUFBLE1BQ3hDLENBQUMsUUFBZTtBQUNkLGVBQU8sR0FBRyxJQUFJLFFBQVEsU0FBUyxvQkFBb0IsQ0FBQztBQUNwRCxlQUFPO0FBQUEsTUFDVDtBQUFBLElBQ0Y7QUFBQSxFQUNGLENBQUM7QUFFRCxLQUFHLG9EQUFvRCxZQUFZO0FBQ2pFLFVBQU0sWUFBWSxNQUFNLEdBQUcsYUFBYSxvQkFBb0IsRUFBRSxTQUFTLGVBQWUsQ0FBQztBQUN2RixVQUFNLFNBQVMsR0FBRyxVQUFVLFNBQVM7QUFFckMsV0FBTyxHQUFHLGVBQWUsTUFBTTtBQUMvQixXQUFPLEdBQUcsZ0JBQWdCLE1BQU07QUFDaEMsV0FBTyxHQUFHLFlBQVksTUFBTTtBQUM1QixXQUFPLEdBQUcsZ0JBQWdCLE1BQU07QUFDaEMsV0FBTyxHQUFHLFVBQVUsTUFBTTtBQUMxQixXQUFPLEdBQUcsa0JBQWtCLE1BQU07QUFDbEMsV0FBTyxHQUFHLG9CQUFvQixNQUFNO0FBQ3BDLFdBQU8sR0FBRyxXQUFXLE1BQU07QUFBQSxFQUM3QixDQUFDO0FBRUQsS0FBRyw4Q0FBOEMsWUFBWTtBQUMzRCxVQUFNLFlBQVksTUFBTSxHQUFHLGFBQWEsb0JBQW9CLEVBQUUsU0FBUyxlQUFlLENBQUM7QUFDdkYsVUFBTSxHQUFHLGNBQWMsU0FBUztBQUNoQyxVQUFNLFVBQVUsR0FBRyxXQUFXLFNBQVM7QUFDdkMsV0FBTyxNQUFNLFFBQVEsUUFBUSxXQUFXO0FBQUEsRUFDMUMsQ0FBQztBQUVELEtBQUcsdUZBQXVGLFlBQVk7QUFHcEcsVUFBTSxhQUFhLFFBQVEsMEJBQTBCO0FBQ3JELFVBQU0sYUFBYSxJQUFJLGNBQWMsRUFBRSxLQUFLLFlBQVksTUFBTSxDQUFDLEVBQUUsQ0FBQztBQUNsRSxVQUFNLHFCQUFxQztBQUFBLE1BQ3pDLFdBQVc7QUFBQTtBQUFBLE1BQ1g7QUFBQSxNQUNBLFFBQVE7QUFBQSxNQUNSLFFBQVE7QUFBQSxNQUNSLFFBQVEsQ0FBQztBQUFBLE1BQ1QsZ0JBQWdCO0FBQUEsTUFDaEIsTUFBTSxFQUFFLFdBQVcsR0FBRyxRQUFRLEVBQUUsT0FBTyxHQUFHLFFBQVEsR0FBRyxXQUFXLEdBQUcsWUFBWSxFQUFFLEVBQUU7QUFBQSxNQUNuRixXQUFXLEtBQUssSUFBSTtBQUFBLElBQ3RCO0FBQ0EsT0FBRyxZQUFZLFlBQVksa0JBQWtCO0FBSTdDLFVBQU0sR0FBRyxtQkFBbUIsVUFBVTtBQUV0QyxVQUFNLFVBQVUsR0FBRyxnQkFBZ0IsVUFBVTtBQUM3QyxXQUFPLE1BQU0sUUFBUSxRQUFRLFdBQVc7QUFDeEMsV0FBTyxHQUFHLFdBQVcsU0FBUyx3Q0FBd0M7QUFBQSxFQUN4RSxDQUFDO0FBRUQsS0FBRyxnRkFBZ0YsWUFBWTtBQUU3RixVQUFNLFlBQVksTUFBTSxHQUFHLGFBQWEsc0JBQXNCLEVBQUUsU0FBUyxlQUFlLENBQUM7QUFDekYsVUFBTSxVQUFVLEdBQUcsV0FBVyxTQUFTO0FBQ3ZDLFVBQU0sRUFBRSxXQUFXLElBQUk7QUFHdkIsVUFBTSxHQUFHLG1CQUFtQixVQUFVO0FBQ3RDLFdBQU8sTUFBTSxRQUFRLFFBQVEsV0FBVztBQUFBLEVBQzFDLENBQUM7QUFFRCxLQUFHLG9HQUFvRyxNQUFNO0FBQzNHLFVBQU0sVUFBVSxtQ0FBbUM7QUFBQSxNQUNqRDtBQUFBLFFBQ0UsSUFBSTtBQUFBLFFBQ0osUUFBUTtBQUFBLFFBQ1IsVUFBVTtBQUFBLFFBQ1YsU0FBUztBQUFBLFVBQ1AsRUFBRSxPQUFPLGlDQUFpQyxhQUFhLHFDQUFxQztBQUFBLFVBQzVGLEVBQUUsT0FBTyxhQUFhLGFBQWEsdUNBQXVDO0FBQUEsUUFDNUU7QUFBQSxNQUNGO0FBQUEsTUFDQTtBQUFBLFFBQ0UsSUFBSTtBQUFBLFFBQ0osUUFBUTtBQUFBLFFBQ1IsVUFBVTtBQUFBLFFBQ1YsZUFBZTtBQUFBLFFBQ2YsU0FBUztBQUFBLFVBQ1AsRUFBRSxPQUFPLFlBQVksYUFBYSxxQkFBcUI7QUFBQSxVQUN2RCxFQUFFLE9BQU8sV0FBVyxhQUFhLDJCQUEyQjtBQUFBLFFBQzlEO0FBQUEsTUFDRjtBQUFBLElBQ0YsQ0FBQztBQUVELFdBQU8sTUFBTSxRQUFRLE1BQU0sTUFBTTtBQUNqQyxXQUFPLFVBQVUsUUFBUSxnQkFBZ0IsVUFBVSxDQUFDLDJCQUEyQixhQUFhLENBQUM7QUFDN0YsV0FBTyxHQUFHLFFBQVEsZ0JBQWdCLFdBQVcseUJBQXlCLENBQUM7QUFDdkUsV0FBTyxHQUFHLFFBQVEsZ0JBQWdCLFdBQVcsK0JBQStCLENBQUM7QUFDN0UsV0FBTyxHQUFHLENBQUMsUUFBUSxnQkFBZ0IsV0FBVyxtQkFBbUIsQ0FBQztBQUFBLEVBQ3BFLENBQUM7QUFFRCxLQUFHLGdGQUFnRixNQUFNO0FBQ3ZGLFVBQU0sU0FBUztBQUFBLE1BQ2I7QUFBQSxRQUNFO0FBQUEsVUFDRSxJQUFJO0FBQUEsVUFDSixRQUFRO0FBQUEsVUFDUixVQUFVO0FBQUEsVUFDVixTQUFTO0FBQUEsWUFDUCxFQUFFLE9BQU8saUNBQWlDLGFBQWEscUNBQXFDO0FBQUEsWUFDNUYsRUFBRSxPQUFPLGFBQWEsYUFBYSx1Q0FBdUM7QUFBQSxVQUM1RTtBQUFBLFFBQ0Y7QUFBQSxRQUNBO0FBQUEsVUFDRSxJQUFJO0FBQUEsVUFDSixRQUFRO0FBQUEsVUFDUixVQUFVO0FBQUEsVUFDVixlQUFlO0FBQUEsVUFDZixTQUFTO0FBQUEsWUFDUCxFQUFFLE9BQU8sWUFBWSxhQUFhLHFCQUFxQjtBQUFBLFlBQ3ZELEVBQUUsT0FBTyxXQUFXLGFBQWEsMkJBQTJCO0FBQUEsVUFDOUQ7QUFBQSxRQUNGO0FBQUEsTUFDRjtBQUFBLE1BQ0E7QUFBQSxRQUNFLFFBQVE7QUFBQSxRQUNSLFNBQVM7QUFBQSxVQUNQLHlCQUF5QjtBQUFBLFVBQ3pCLCtCQUErQjtBQUFBLFVBQy9CLGFBQWEsQ0FBQyxZQUFZLFNBQVM7QUFBQSxRQUNyQztBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBRUEsV0FBTztBQUFBLE1BQ0w7QUFBQSxNQUNBLEtBQUssVUFBVTtBQUFBLFFBQ2IsU0FBUztBQUFBLFVBQ1AseUJBQXlCO0FBQUEsWUFDdkIsU0FBUyxDQUFDLHFCQUFxQiw2Q0FBNkM7QUFBQSxVQUM5RTtBQUFBLFVBQ0EsYUFBYTtBQUFBLFlBQ1gsU0FBUyxDQUFDLFlBQVksU0FBUztBQUFBLFVBQ2pDO0FBQUEsUUFDRjtBQUFBLE1BQ0YsQ0FBQztBQUFBLElBQ0g7QUFBQSxFQUNGLENBQUM7QUFFRCxLQUFHLDZFQUE2RSxZQUFZO0FBQzFGLFVBQU0sWUFBWTtBQUFBLE1BQ2hCO0FBQUEsUUFDRSxJQUFJO0FBQUEsUUFDSixRQUFRO0FBQUEsUUFDUixVQUFVO0FBQUEsUUFDVixTQUFTO0FBQUEsVUFDUCxFQUFFLE9BQU8saUNBQWlDLGFBQWEscUNBQXFDO0FBQUEsVUFDNUYsRUFBRSxPQUFPLGFBQWEsYUFBYSx1Q0FBdUM7QUFBQSxRQUM1RTtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBQ0EsUUFBSSxjQUFjO0FBRWxCLFVBQU0sU0FBUyxNQUFNLHdCQUF3QixXQUFXLFFBQVc7QUFBQSxNQUNqRSxNQUFNLGNBQWM7QUFDbEIsZUFBTztBQUFBLFVBQ0wsUUFBUTtBQUFBLFVBQ1IsU0FBUztBQUFBLFlBQ1AseUJBQXlCO0FBQUEsVUFDM0I7QUFBQSxRQUNGO0FBQUEsTUFDRjtBQUFBLE1BQ0EscUJBQXFCO0FBQ25CLGVBQU87QUFBQSxNQUNUO0FBQUEsTUFDQSxNQUFNLHFCQUFxQjtBQUN6QjtBQUNBLGVBQU8sRUFBRSxTQUFTLENBQUMsRUFBRSxNQUFNLFFBQVEsTUFBTSxrQkFBa0IsQ0FBQyxFQUFFO0FBQUEsTUFDaEU7QUFBQSxJQUNGLENBQUM7QUFFRCxXQUFPLE1BQU0sYUFBYSxDQUFDO0FBQzNCLFdBQU87QUFBQSxNQUNMLE9BQU8sUUFBUSxDQUFDLEdBQUc7QUFBQSxNQUNuQixLQUFLLFVBQVU7QUFBQSxRQUNiLFNBQVM7QUFBQSxVQUNQLHlCQUF5QjtBQUFBLFlBQ3ZCLFNBQVMsQ0FBQywrQkFBK0I7QUFBQSxVQUMzQztBQUFBLFFBQ0Y7QUFBQSxNQUNGLENBQUM7QUFBQSxJQUNIO0FBQUEsRUFDRixDQUFDO0FBRUQsS0FBRyx1RUFBdUUsWUFBWTtBQUNwRixVQUFNLFlBQVk7QUFBQSxNQUNoQjtBQUFBLFFBQ0UsSUFBSTtBQUFBLFFBQ0osUUFBUTtBQUFBLFFBQ1IsVUFBVTtBQUFBLFFBQ1YsU0FBUztBQUFBLFVBQ1AsRUFBRSxPQUFPLGlDQUFpQyxhQUFhLHFDQUFxQztBQUFBLFVBQzVGLEVBQUUsT0FBTyxhQUFhLGFBQWEsdUNBQXVDO0FBQUEsUUFDNUU7QUFBQSxNQUNGO0FBQUEsSUFDRjtBQUNBLFVBQU0sUUFBa0IsQ0FBQztBQUN6QixVQUFNLFlBQVk7QUFBQSxNQUNoQixpQkFBaUIsWUFBb0I7QUFDbkMsZUFBTyxXQUFXLFdBQVcscUJBQXFCO0FBQUEsTUFDcEQ7QUFBQSxNQUNBLDBCQUEwQixVQUFtQixTQUFxQztBQUNoRixlQUFPLGFBQWEsVUFBVSxDQUFDLEdBQUc7QUFBQSxNQUNwQztBQUFBLE1BQ0EsZUFBZSxRQUFnQixVQUFrQjtBQUMvQyxjQUFNLEtBQUssV0FBVyxNQUFNLElBQUksUUFBUSxFQUFFO0FBQUEsTUFDNUM7QUFBQSxNQUNBLHlCQUF5QixRQUF3QixVQUFtQjtBQUNsRSxjQUFNLEtBQUssWUFBWSxNQUFNLElBQUksUUFBUSxFQUFFO0FBQUEsTUFDN0M7QUFBQSxNQUNBLGtCQUFrQixhQUE2QixVQUFtQjtBQUNoRSxjQUFNLEtBQUssU0FBUyxXQUFXLElBQUksUUFBUSxFQUFFO0FBQUEsTUFDL0M7QUFBQSxNQUNBLGlCQUFpQixVQUFrQjtBQUNqQyxjQUFNLEtBQUssU0FBUyxRQUFRLEVBQUU7QUFBQSxNQUNoQztBQUFBLE1BQ0Esb0NBQW9DLFlBQW9CO0FBQ3RELGVBQU8sV0FBVyxNQUFNLFVBQVUsSUFBSSxDQUFDLEtBQUs7QUFBQSxNQUM5QztBQUFBLElBQ0Y7QUFFQSxVQUFNLFNBQVMsTUFBTSx3QkFBd0IsV0FBVyxRQUFXO0FBQUEsTUFDakUsTUFBTSxjQUFjO0FBQ2xCLGVBQU87QUFBQSxVQUNMLFFBQVE7QUFBQSxVQUNSLFNBQVM7QUFBQSxZQUNQLGlDQUFpQztBQUFBLFVBQ25DO0FBQUEsUUFDRjtBQUFBLE1BQ0Y7QUFBQSxNQUNBLHFCQUFxQjtBQUNuQixlQUFPO0FBQUEsTUFDVDtBQUFBLE1BQ0EsTUFBTSxxQkFBcUI7QUFDekIsY0FBTSxJQUFJLE1BQU0sc0JBQXNCO0FBQUEsTUFDeEM7QUFBQSxNQUNBO0FBQUEsTUFDQSxtQkFBbUI7QUFBQSxJQUNyQixDQUFDO0FBRUQsV0FBTyxNQUFNLGFBQWEsVUFBVSxPQUFPLFNBQVMsS0FBSztBQUN6RCxXQUFPLFVBQVUsT0FBTztBQUFBLE1BQ3RCO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRixDQUFDO0FBQUEsRUFDSCxDQUFDO0FBRUQsS0FBRyx3RUFBd0UsWUFBWTtBQUNyRixVQUFNLFlBQVk7QUFBQSxNQUNoQjtBQUFBLFFBQ0UsSUFBSTtBQUFBLFFBQ0osUUFBUTtBQUFBLFFBQ1IsVUFBVTtBQUFBLFFBQ1YsU0FBUztBQUFBLFVBQ1AsRUFBRSxPQUFPLGlDQUFpQyxhQUFhLHFDQUFxQztBQUFBLFVBQzVGLEVBQUUsT0FBTyxhQUFhLGFBQWEsdUNBQXVDO0FBQUEsUUFDNUU7QUFBQSxNQUNGO0FBQUEsSUFDRjtBQUNBLFVBQU0sUUFBa0IsQ0FBQztBQUN6QixVQUFNLFlBQVk7QUFBQSxNQUNoQixpQkFBaUIsWUFBb0I7QUFDbkMsZUFBTyxXQUFXLFdBQVcscUJBQXFCO0FBQUEsTUFDcEQ7QUFBQSxNQUNBLDBCQUEwQixVQUFtQixTQUFxQztBQUNoRixlQUFPLGFBQWEsVUFBVSxDQUFDLEdBQUc7QUFBQSxNQUNwQztBQUFBLE1BQ0EsZUFBZSxRQUFnQixVQUFrQjtBQUMvQyxjQUFNLEtBQUssV0FBVyxNQUFNLElBQUksUUFBUSxFQUFFO0FBQUEsTUFDNUM7QUFBQSxNQUNBLHlCQUF5QixRQUF3QixVQUFtQjtBQUNsRSxjQUFNLEtBQUssWUFBWSxNQUFNLElBQUksUUFBUSxFQUFFO0FBQUEsTUFDN0M7QUFBQSxNQUNBLGtCQUFrQixhQUE2QixVQUFtQjtBQUNoRSxjQUFNLEtBQUssU0FBUyxXQUFXLElBQUksUUFBUSxFQUFFO0FBQUEsTUFDL0M7QUFBQSxNQUNBLGlCQUFpQixVQUFrQjtBQUNqQyxjQUFNLEtBQUssU0FBUyxRQUFRLEVBQUU7QUFBQSxNQUNoQztBQUFBLE1BQ0Esb0NBQW9DLFlBQW9CO0FBQ3RELGVBQU8sV0FBVyxNQUFNLFVBQVUsSUFBSSxDQUFDLEtBQUs7QUFBQSxNQUM5QztBQUFBLElBQ0Y7QUFFQSxVQUFNLFNBQVMsTUFBTSx3QkFBd0IsV0FBVyxRQUFXO0FBQUEsTUFDakUsTUFBTSxjQUFjO0FBQ2xCLGVBQU8sRUFBRSxRQUFRLFNBQVM7QUFBQSxNQUM1QjtBQUFBLE1BQ0EscUJBQXFCO0FBQ25CLGVBQU87QUFBQSxNQUNUO0FBQUEsTUFDQSxNQUFNLHFCQUFxQjtBQUN6QixlQUFPO0FBQUEsVUFDTCxTQUFTLENBQUMsRUFBRSxNQUFNLFFBQVEsTUFBTSxrQkFBa0IsQ0FBQztBQUFBLFVBQ25ELFNBQVM7QUFBQSxZQUNQLFVBQVU7QUFBQSxjQUNSLGNBQWM7QUFBQSxjQUNkLFNBQVM7QUFBQSxnQkFDUCxpQ0FBaUM7QUFBQSxrQkFDL0IsVUFBVTtBQUFBLGtCQUNWLE9BQU87QUFBQSxnQkFDVDtBQUFBLGNBQ0Y7QUFBQSxZQUNGO0FBQUEsVUFDRjtBQUFBLFFBQ0Y7QUFBQSxNQUNGO0FBQUEsTUFDQTtBQUFBLE1BQ0EsbUJBQW1CO0FBQUEsSUFDckIsQ0FBQztBQUVELFdBQU8sTUFBTSxhQUFhLFVBQVUsT0FBTyxTQUFTLEtBQUs7QUFDekQsV0FBTyxVQUFVLE9BQU87QUFBQSxNQUN0QjtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLElBQ0YsQ0FBQztBQUFBLEVBQ0gsQ0FBQztBQUVELEtBQUcsK0VBQStFLFlBQVk7QUFDNUYsVUFBTSxZQUFZO0FBQUEsTUFDaEI7QUFBQSxRQUNFLElBQUk7QUFBQSxRQUNKLFFBQVE7QUFBQSxRQUNSLFVBQVU7QUFBQSxRQUNWLFNBQVM7QUFBQSxVQUNQLEVBQUUsT0FBTyxpQ0FBaUMsYUFBYSxxQ0FBcUM7QUFBQSxVQUM1RixFQUFFLE9BQU8sYUFBYSxhQUFhLHVDQUF1QztBQUFBLFFBQzVFO0FBQUEsTUFDRjtBQUFBLElBQ0Y7QUFDQSxRQUFJLGNBQWM7QUFDbEIsVUFBTSxTQUFTLFlBQVksTUFBTTtBQUVqQyxVQUFNLFNBQVMsTUFBTSx3QkFBd0IsV0FBVyxFQUFFLE9BQU8sR0FBRztBQUFBLE1BQ2xFLE1BQU0sY0FBYztBQUNsQixlQUFPLEVBQUUsUUFBUSxTQUFTO0FBQUEsTUFDNUI7QUFBQSxNQUNBLHFCQUFxQjtBQUNuQixlQUFPO0FBQUEsTUFDVDtBQUFBLE1BQ0EsTUFBTSxtQkFBbUIsaUJBQWlCLGdCQUFnQjtBQUN4RDtBQUNBLGVBQU8sTUFBTSxpQkFBaUIsU0FBUztBQUN2QyxlQUFPLE1BQU0sZ0JBQWdCLE1BQU07QUFDbkMsZUFBTyxFQUFFLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBUSxNQUFNLGtCQUFrQixDQUFDLEVBQUU7QUFBQSxNQUNoRTtBQUFBLElBQ0YsQ0FBQztBQUVELFdBQU8sTUFBTSxhQUFhLENBQUM7QUFDM0IsV0FBTyxNQUFNLE9BQU8sUUFBUSxDQUFDLEdBQUcsTUFBTSxpQkFBaUI7QUFBQSxFQUN6RCxDQUFDO0FBRUQsS0FBRyxpRkFBaUYsWUFBWTtBQUM5RixVQUFNLFlBQVk7QUFBQSxNQUNoQjtBQUFBLFFBQ0UsSUFBSTtBQUFBLFFBQ0osUUFBUTtBQUFBLFFBQ1IsVUFBVTtBQUFBLFFBQ1YsU0FBUztBQUFBLFVBQ1AsRUFBRSxPQUFPLGlDQUFpQyxhQUFhLHFDQUFxQztBQUFBLFVBQzVGLEVBQUUsT0FBTyxhQUFhLGFBQWEsdUNBQXVDO0FBQUEsUUFDNUU7QUFBQSxNQUNGO0FBQUEsSUFDRjtBQUNBLFFBQUksY0FBYztBQUVsQixVQUFNLFNBQVMsTUFBTSx3QkFBd0IsV0FBVyxRQUFXO0FBQUEsTUFDakUsTUFBTSxjQUFjO0FBQ2xCLGNBQU0sSUFBSSxNQUFNLHVDQUF1QztBQUFBLE1BQ3pEO0FBQUEsTUFDQSxxQkFBcUI7QUFDbkIsZUFBTztBQUFBLE1BQ1Q7QUFBQSxNQUNBLE1BQU0sbUJBQW1CLGlCQUFpQjtBQUN4QztBQUNBLGVBQU8sTUFBTSxpQkFBaUIsU0FBUztBQUN2QyxlQUFPLEVBQUUsU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFRLE1BQU0sa0JBQWtCLENBQUMsRUFBRTtBQUFBLE1BQ2hFO0FBQUEsSUFDRixDQUFDO0FBRUQsV0FBTyxNQUFNLGFBQWEsQ0FBQztBQUMzQixXQUFPLE1BQU0sT0FBTyxRQUFRLENBQUMsR0FBRyxNQUFNLGlCQUFpQjtBQUFBLEVBQ3pELENBQUM7QUFFRCxLQUFHLDhGQUE4RixZQUFZO0FBQzNHLFVBQU0sWUFBWTtBQUFBLE1BQ2hCO0FBQUEsUUFDRSxJQUFJO0FBQUEsUUFDSixRQUFRO0FBQUEsUUFDUixVQUFVO0FBQUEsUUFDVixTQUFTO0FBQUEsVUFDUCxFQUFFLE9BQU8saUNBQWlDLGFBQWEsWUFBWTtBQUFBLFVBQ25FLEVBQUUsT0FBTyxhQUFhLGFBQWEsV0FBVztBQUFBLFFBQ2hEO0FBQUEsTUFDRjtBQUFBLElBQ0Y7QUFFQSxVQUFNLFNBQVMsTUFBTSx3QkFBd0IsV0FBVyxRQUFXO0FBQUEsTUFDakUsTUFBTSxjQUFjO0FBQ2xCLGNBQU0sSUFBSSxNQUFNLHVDQUF1QztBQUFBLE1BQ3pEO0FBQUEsTUFDQSxxQkFBcUI7QUFDbkIsZUFBTztBQUFBLE1BQ1Q7QUFBQSxNQUNBLE1BQU0scUJBQXFCO0FBQ3pCLGVBQU87QUFBQSxVQUNMLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBUSxNQUFNLHdGQUF3RixDQUFDO0FBQUEsVUFDekgsU0FBUztBQUFBLFlBQ1AsUUFBUTtBQUFBLFlBQ1IsU0FBUztBQUFBLFlBQ1QsV0FBVztBQUFBLFlBQ1gsVUFBVTtBQUFBLFlBQ1YsV0FBVztBQUFBLFlBQ1g7QUFBQSxZQUNBLFVBQVU7QUFBQSxjQUNSLGNBQWM7QUFBQSxjQUNkLFNBQVM7QUFBQSxnQkFDUCx5QkFBeUIsRUFBRSxVQUFVLGlDQUFpQyxPQUFPLEdBQUc7QUFBQSxjQUNsRjtBQUFBLFlBQ0Y7QUFBQSxZQUNBLFFBQVE7QUFBQSxVQUNWO0FBQUEsUUFDRjtBQUFBLE1BQ0Y7QUFBQSxJQUNGLENBQUM7QUFFRCxXQUFPO0FBQUEsTUFDSixPQUEyQztBQUFBLE1BQzVDO0FBQUEsUUFDRTtBQUFBLFFBQ0EsVUFBVTtBQUFBO0FBQUE7QUFBQSxVQUdSLGNBQWM7QUFBQSxVQUNkLFNBQVM7QUFBQSxZQUNQLHlCQUF5QixFQUFFLFVBQVUsaUNBQWlDLE9BQU8sR0FBRztBQUFBLFVBQ2xGO0FBQUEsUUFDRjtBQUFBLFFBQ0EsV0FBVztBQUFBLE1BQ2I7QUFBQSxJQUNGO0FBQUEsRUFDRixDQUFDO0FBRUQsS0FBRyxnR0FBZ0csWUFBWTtBQUM3RyxVQUFNLFlBQVk7QUFBQSxNQUNoQjtBQUFBLFFBQ0UsSUFBSTtBQUFBLFFBQ0osUUFBUTtBQUFBLFFBQ1IsVUFBVTtBQUFBLFFBQ1YsU0FBUztBQUFBLFVBQ1AsRUFBRSxPQUFPLGlDQUFpQyxhQUFhLFlBQVk7QUFBQSxVQUNuRSxFQUFFLE9BQU8sYUFBYSxhQUFhLFdBQVc7QUFBQSxRQUNoRDtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBRUEsVUFBTSxTQUFTLE1BQU0sd0JBQXdCLFdBQVcsUUFBVztBQUFBLE1BQ2pFLE1BQU0sY0FBYztBQUNsQixjQUFNLElBQUksTUFBTSx1Q0FBdUM7QUFBQSxNQUN6RDtBQUFBLE1BQ0EscUJBQXFCO0FBQ25CLGVBQU87QUFBQSxNQUNUO0FBQUEsTUFDQSxNQUFNLHFCQUFxQjtBQUN6QixlQUFPO0FBQUEsVUFDTCxTQUFTLENBQUMsRUFBRSxNQUFNLFFBQVEsTUFBTSw0RkFBNEYsQ0FBQztBQUFBLFVBQzdILFNBQVMsRUFBRSxRQUFRLE1BQU0sU0FBUyxXQUFXLFdBQVcsTUFBTSxRQUFRLFlBQVk7QUFBQSxRQUNwRjtBQUFBLE1BQ0Y7QUFBQSxJQUNGLENBQUM7QUFFRCxXQUFPO0FBQUEsTUFDSixPQUEyQztBQUFBLE1BQzVDLEVBQUUsV0FBVyxVQUFVLE1BQU0sV0FBVyxLQUFLO0FBQUEsSUFDL0M7QUFBQSxFQUNGLENBQUM7QUFFRCxLQUFHLDhHQUE4RyxZQUFZO0FBQzNILFVBQU0sWUFBWTtBQUFBLE1BQ2hCO0FBQUEsUUFDRSxJQUFJO0FBQUEsUUFDSixRQUFRO0FBQUEsUUFDUixVQUFVO0FBQUEsUUFDVixTQUFTO0FBQUEsVUFDUCxFQUFFLE9BQU8saUNBQWlDLGFBQWEsWUFBWTtBQUFBLFVBQ25FLEVBQUUsT0FBTyxhQUFhLGFBQWEsV0FBVztBQUFBLFFBQ2hEO0FBQUEsTUFDRjtBQUFBLElBQ0Y7QUFFQSxVQUFNLFNBQVMsTUFBTSx3QkFBd0IsV0FBVyxRQUFXO0FBQUEsTUFDakUsTUFBTSxjQUFjO0FBQ2xCLGNBQU0sSUFBSSxNQUFNLHVDQUF1QztBQUFBLE1BQ3pEO0FBQUEsTUFDQSxxQkFBcUI7QUFDbkIsZUFBTztBQUFBLE1BQ1Q7QUFBQSxNQUNBLE1BQU0scUJBQXFCO0FBS3pCLGVBQU87QUFBQSxVQUNMLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBUSxNQUFNLEtBQUssQ0FBQztBQUFBLFVBQ3RDLFNBQVMsRUFBRSxRQUFRLE1BQU0sU0FBUyxXQUFXLFdBQVcsT0FBTyxVQUFVLGdCQUFnQjtBQUFBLFFBQzNGO0FBQUEsTUFDRjtBQUFBLElBQ0YsQ0FBQztBQUVELFdBQU87QUFBQSxNQUNKLE9BQTJDO0FBQUEsTUFDNUMsRUFBRSxXQUFXLFVBQVUsTUFBTSxXQUFXLEtBQUs7QUFBQSxJQUMvQztBQUFBLEVBQ0YsQ0FBQztBQUVELEtBQUcsNEhBQTRILFlBQVk7QUFDekksVUFBTSxZQUFZO0FBQUEsTUFDaEI7QUFBQSxRQUNFLElBQUk7QUFBQSxRQUNKLFFBQVE7QUFBQSxRQUNSLFVBQVU7QUFBQSxRQUNWLFNBQVM7QUFBQSxVQUNQLEVBQUUsT0FBTyxpQ0FBaUMsYUFBYSxZQUFZO0FBQUEsVUFDbkUsRUFBRSxPQUFPLGFBQWEsYUFBYSxXQUFXO0FBQUEsUUFDaEQ7QUFBQSxNQUNGO0FBQUEsSUFDRjtBQUVBLFVBQU0sU0FBUyxNQUFNLHdCQUF3QixXQUFXLFFBQVc7QUFBQSxNQUNqRSxNQUFNLGNBQWM7QUFDbEIsZUFBTyxFQUFFLFFBQVEsVUFBVTtBQUFBLE1BQzdCO0FBQUEsTUFDQSxxQkFBcUI7QUFDbkIsZUFBTztBQUFBLE1BQ1Q7QUFBQSxNQUNBLE1BQU0scUJBQXFCO0FBQ3pCLGNBQU0sSUFBSSxNQUFNLGtEQUFrRDtBQUFBLE1BQ3BFO0FBQUEsSUFDRixDQUFDO0FBRUQsV0FBTztBQUFBLE1BQ0osT0FBMkM7QUFBQSxNQUM1QyxFQUFFLFdBQVcsVUFBVSxNQUFNLFdBQVcsS0FBSztBQUFBLElBQy9DO0FBQ0EsV0FBTyxNQUFNLE9BQU8sUUFBUSxDQUFDLEdBQUcsTUFBTSw4REFBOEQ7QUFBQSxFQUN0RyxDQUFDO0FBRUQsS0FBRyxpSEFBaUgsWUFBWTtBQUM5SCxVQUFNLFlBQVk7QUFBQSxNQUNoQjtBQUFBLFFBQ0UsSUFBSTtBQUFBLFFBQ0osUUFBUTtBQUFBLFFBQ1IsVUFBVTtBQUFBLFFBQ1YsU0FBUztBQUFBLFVBQ1AsRUFBRSxPQUFPLGlDQUFpQyxhQUFhLFlBQVk7QUFBQSxVQUNuRSxFQUFFLE9BQU8sYUFBYSxhQUFhLFdBQVc7QUFBQSxRQUNoRDtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBRUEsVUFBTSxTQUFTLE1BQU0sd0JBQXdCLFdBQVcsUUFBVztBQUFBLE1BQ2pFLE1BQU0sY0FBYztBQUNsQixlQUFPLEVBQUUsUUFBUSxTQUFTO0FBQUEsTUFDNUI7QUFBQSxNQUNBLHFCQUFxQjtBQUNuQixlQUFPO0FBQUEsTUFDVDtBQUFBLE1BQ0EsTUFBTSxxQkFBcUI7QUFDekIsZUFBTztBQUFBLE1BQ1Q7QUFBQSxJQUNGLENBQUM7QUFFRCxXQUFPO0FBQUEsTUFDSixPQUEyQztBQUFBLE1BQzVDLEVBQUUsV0FBVyxVQUFVLE1BQU0sV0FBVyxLQUFLO0FBQUEsSUFDL0M7QUFBQSxFQUNGLENBQUM7QUFFRCxLQUFHLDZFQUE2RSxZQUFZO0FBQzFGLFVBQU0sWUFBWTtBQUFBLE1BQ2hCO0FBQUEsUUFDRSxJQUFJO0FBQUEsUUFDSixRQUFRO0FBQUEsUUFDUixVQUFVO0FBQUEsUUFDVixTQUFTO0FBQUEsVUFDUCxFQUFFLE9BQU8saUNBQWlDLGFBQWEsWUFBWTtBQUFBLFVBQ25FLEVBQUUsT0FBTyxhQUFhLGFBQWEsV0FBVztBQUFBLFFBQ2hEO0FBQUEsTUFDRjtBQUFBLElBQ0Y7QUFFQSxVQUFNLFNBQVMsTUFBTSx3QkFBd0IsV0FBVyxRQUFXO0FBQUEsTUFDakUsTUFBTSxjQUFjO0FBQ2xCLGNBQU0sSUFBSSxVQUFVLDJCQUEyQjtBQUFBLE1BQ2pEO0FBQUEsTUFDQSxxQkFBcUI7QUFDbkIsZUFBTztBQUFBLE1BQ1Q7QUFBQSxNQUNBLE1BQU0scUJBQXFCO0FBQ3pCLGNBQU0sSUFBSSxNQUFNLHNCQUFzQjtBQUFBLE1BQ3hDO0FBQUEsSUFDRixDQUFDO0FBS0QsV0FBTyxNQUFNLGFBQWEsVUFBVSxPQUFPLFNBQVMsSUFBSTtBQUN4RCxXQUFPLE1BQU0sT0FBTyxRQUFRLENBQUMsR0FBRyxRQUFRLElBQUksMkJBQTJCO0FBQUEsRUFDekUsQ0FBQztBQUVELEtBQUcsZ0ZBQWdGLFlBQVk7QUFDN0YsVUFBTSxZQUFZO0FBQUEsTUFDaEI7QUFBQSxRQUNFLElBQUk7QUFBQSxRQUNKLFFBQVE7QUFBQSxRQUNSLFVBQVU7QUFBQSxRQUNWLFNBQVM7QUFBQSxVQUNQLEVBQUUsT0FBTyxpQ0FBaUMsYUFBYSxxQ0FBcUM7QUFBQSxVQUM1RixFQUFFLE9BQU8sYUFBYSxhQUFhLHVDQUF1QztBQUFBLFFBQzVFO0FBQUEsTUFDRjtBQUFBLElBQ0Y7QUFFQSxVQUFNLFNBQVMsTUFBTSx3QkFBd0IsV0FBVyxRQUFXO0FBQUEsTUFDakUsTUFBTSxjQUFjO0FBQ2xCLGNBQU0sSUFBSSxNQUFNLCtDQUErQztBQUFBLE1BQ2pFO0FBQUEsTUFDQSxxQkFBcUI7QUFDbkIsZUFBTztBQUFBLE1BQ1Q7QUFBQSxNQUNBLE1BQU0scUJBQXFCO0FBQ3pCLGNBQU0sSUFBSSxNQUFNLHlCQUF5QjtBQUFBLE1BQzNDO0FBQUEsSUFDRixDQUFDO0FBRUQsV0FBTyxNQUFNLGFBQWEsVUFBVSxPQUFPLFNBQVMsSUFBSTtBQUN4RCxXQUFPLE1BQU0sT0FBTyxRQUFRLENBQUMsR0FBRyxRQUFRLElBQUksMEJBQTBCO0FBQ3RFLFdBQU8sTUFBTSxPQUFPLFFBQVEsQ0FBQyxHQUFHLFFBQVEsSUFBSSx5QkFBeUI7QUFBQSxFQUN2RSxDQUFDO0FBQ0gsQ0FBQztBQU1ELFNBQVMscUJBQXFCLE1BQU07QUFDbEMsS0FBRyxzRUFBc0UsWUFBWTtBQUNuRixVQUFNLFNBQVMsTUFBTSxrQkFBa0IsUUFBUSxRQUFRLEVBQUUsR0FBRyxRQUFRLEdBQUk7QUFDeEUsV0FBTyxNQUFNLFFBQVEsRUFBRTtBQUFBLEVBQ3pCLENBQUM7QUFFRCxLQUFHLHlFQUF5RSxZQUFZO0FBQ3RGLFVBQU0sUUFBUSxJQUFJLFFBQWUsTUFBTTtBQUFBLElBQUMsQ0FBQztBQUN6QyxVQUFNLE9BQU87QUFBQSxNQUNYLE1BQU0sa0JBQWtCLE9BQU8sc0JBQXNCLENBQUM7QUFBQSxNQUN0RCxDQUFDLFFBQWU7QUFDZCxlQUFPLEdBQUcsSUFBSSxRQUFRLFNBQVMsb0JBQW9CLENBQUM7QUFDcEQsZUFBTyxHQUFHLElBQUksUUFBUSxTQUFTLFdBQVcsQ0FBQztBQUMzQyxlQUFPO0FBQUEsTUFDVDtBQUFBLElBQ0Y7QUFBQSxFQUNGLENBQUM7QUFFRCxLQUFHLGtFQUFrRSxZQUFZO0FBTS9FLFVBQU0sdUJBQXVCLFdBQVc7QUFDeEMsUUFBSSxhQUFhO0FBQ2pCLFFBQUksZ0JBQXlCO0FBQzdCLGVBQVcsZ0JBQWdCLENBQUMsT0FBbUQ7QUFDN0U7QUFDQSxzQkFBZ0I7QUFDaEIsYUFBTyxxQkFBcUIsRUFBRTtBQUFBLElBQ2hDO0FBRUEsUUFBSTtBQUNGLFlBQU0sUUFBUSxNQUFNLGtCQUFrQixRQUFRLFFBQVEsTUFBTSxHQUFHLFFBQVEsR0FBTTtBQUM3RSxhQUFPLE1BQU0sT0FBTyxNQUFNO0FBQzFCLGFBQU87QUFBQSxRQUNMLGNBQWM7QUFBQSxRQUNkLGtEQUFrRCxVQUFVO0FBQUEsTUFDOUQ7QUFDQSxhQUFPLEdBQUcsa0JBQWtCLFFBQVcsaURBQWlEO0FBQUEsSUFDMUYsVUFBRTtBQUNBLGlCQUFXLGVBQWU7QUFBQSxJQUM1QjtBQUFBLEVBQ0YsQ0FBQztBQUNILENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
