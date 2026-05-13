import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Agent } from "@gsd/pi-agent-core";
import { AgentSession } from "./agent-session.js";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
let testDir;
async function createSession(opts = {}) {
  const agentDir = join(testDir, "agent-home");
  const authStorage = AuthStorage.inMemory({});
  const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.json"));
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: testDir,
    agentDir,
    settingsManager,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true
  });
  await resourceLoader.reload();
  const sessionManager = opts.persistSessions ? SessionManager.create(testDir, join(testDir, "sessions")) : SessionManager.inMemory(testDir);
  return new AgentSession({
    agent: new Agent(),
    sessionManager,
    settingsManager,
    cwd: testDir,
    resourceLoader,
    modelRegistry
  });
}
function recordCallOrder(target, methods) {
  const order = [];
  for (const method of methods) {
    const name = String(method);
    const original = target[name];
    if (typeof original !== "function") {
      throw new Error(`recordCallOrder: ${name} is not a function on target`);
    }
    target[name] = function(...args) {
      order.push(name);
      return original.apply(this, args);
    };
  }
  return order;
}
function makeAssistantMessage(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      total: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "stop",
    timestamp: Date.now()
  };
}
function installAgentEndSessionTransition(session, transition) {
  session._extensionRunner = {
    hasHandlers: () => false,
    emit: async (event) => {
      if (event.type === "agent_end") {
        await transition();
      }
    },
    emitStop: async () => {
    }
  };
}
describe("#4243 \u2014 abort() must run before _disconnectFromAgent()", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "agent-session-abort-"));
  });
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });
  it("newSession() invokes abort() before _disconnectFromAgent()", async () => {
    const session = await createSession();
    session.agent.state.isStreaming = true;
    const order = recordCallOrder(session, ["abort", "_disconnectFromAgent"]);
    const ok = await session.newSession();
    assert.equal(ok, true);
    const abortIdx = order.indexOf("abort");
    const disconnectIdx = order.indexOf("_disconnectFromAgent");
    assert.ok(abortIdx >= 0, `newSession should call abort(); order=${order.join(",")}`);
    assert.ok(
      disconnectIdx >= 0,
      `newSession should call _disconnectFromAgent(); order=${order.join(",")}`
    );
    assert.ok(
      abortIdx < disconnectIdx,
      `abort() must run before _disconnectFromAgent(); order=${order.join(",")}`
    );
  });
  it("newSession() waits instead of aborting when the prior turn is idle but not settled", async () => {
    const session = await createSession();
    const order = [];
    let releaseIdle;
    const idle = new Promise((resolve) => {
      releaseIdle = resolve;
    });
    session.agent.state.isStreaming = false;
    session.agent.waitForIdle = () => {
      order.push("waitForIdle");
      return idle;
    };
    session.abort = async () => {
      order.push("abort");
    };
    const originalDisconnect = session._disconnectFromAgent.bind(session);
    session._disconnectFromAgent = () => {
      order.push("_disconnectFromAgent");
      originalDisconnect();
    };
    const pendingNewSession = session.newSession();
    await Promise.resolve();
    assert.deepEqual(order, ["waitForIdle"]);
    assert.equal(order.includes("abort"), false);
    releaseIdle();
    const ok = await pendingNewSession;
    assert.equal(ok, true);
    assert.deepEqual(order, ["waitForIdle", "_disconnectFromAgent"]);
    assert.equal(order.includes("abort"), false);
  });
  it("newSession() waits instead of aborting while agent_end processing is still streaming", async () => {
    const session = await createSession();
    const order = [];
    let releaseIdle;
    const idle = new Promise((resolve) => {
      releaseIdle = resolve;
    });
    session._processingAgentEnd = true;
    session.agent.state.isStreaming = true;
    session.agent.waitForIdle = () => {
      order.push("waitForIdle");
      return idle;
    };
    session.abort = async () => {
      order.push("abort");
    };
    const originalDisconnect = session._disconnectFromAgent.bind(session);
    session._disconnectFromAgent = () => {
      order.push("_disconnectFromAgent");
      originalDisconnect();
    };
    const pendingNewSession = session.newSession();
    await Promise.resolve();
    assert.deepEqual(order, ["waitForIdle"]);
    assert.equal(order.includes("abort"), false);
    releaseIdle();
    const ok = await pendingNewSession;
    assert.equal(ok, true);
    assert.deepEqual(order, ["waitForIdle", "_disconnectFromAgent"]);
    assert.equal(order.includes("abort"), false);
  });
  it("newSession() waits during agent_end processing even once already idle", async () => {
    const session = await createSession();
    const order = [];
    session._processingAgentEnd = true;
    session.agent.state.isStreaming = false;
    session.agent.waitForIdle = async () => {
      order.push("waitForIdle");
    };
    session.abort = async () => {
      order.push("abort");
    };
    const originalDisconnect = session._disconnectFromAgent.bind(session);
    session._disconnectFromAgent = () => {
      order.push("_disconnectFromAgent");
      originalDisconnect();
    };
    const ok = await session.newSession();
    assert.equal(ok, true);
    assert.deepEqual(order, ["waitForIdle", "_disconnectFromAgent"]);
    assert.equal(order.includes("abort"), false);
  });
  it("abort() marks synthetic agent_end processing while extension handlers run", async () => {
    const session = await createSession();
    const observedProcessingStates = [];
    const observedOrigins = [];
    session.agent.abort = () => {
    };
    session.agent.waitForIdle = async () => {
    };
    session._extensionRunner = {
      emit: async (event) => {
        if (event.type === "agent_end") {
          observedProcessingStates.push(session._processingAgentEnd);
          observedOrigins.push(event.abortOrigin);
        }
      },
      emitStop: async () => {
        observedProcessingStates.push(session._processingAgentEnd);
      }
    };
    await session.abort({ origin: "session-transition" });
    assert.deepEqual(observedProcessingStates, [true, true]);
    assert.deepEqual(observedOrigins, ["session-transition"]);
    assert.equal(session._processingAgentEnd, false);
  });
  it("newSession() during agent_end preserves the previous session for resume", async () => {
    const session = await createSession({ persistSessions: true });
    const previousSessionFile = session.sessionFile;
    assert.ok(previousSessionFile, "need a persisted session file");
    session.sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "persisted prompt" }]
    });
    session.sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "persisted response" }],
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        total: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: "stop",
      timestamp: Date.now()
    });
    session.agent.replaceMessages(session.sessionManager.buildSessionContext().messages);
    session._processingAgentEnd = true;
    session.agent.waitForIdle = async () => {
    };
    const ok = await session.newSession();
    assert.equal(ok, true);
    assert.notEqual(session.sessionFile, previousSessionFile);
    assert.deepEqual(session.messages, []);
    session._processingAgentEnd = false;
    const switched = await session.switchSession(previousSessionFile);
    assert.equal(switched, true);
    const restoredText = session.messages.flatMap((message) => message.content ?? []).filter((part) => part.type === "text").map((part) => part.text);
    assert.deepEqual(restoredText, ["persisted prompt", "persisted response"]);
  });
  it("switchSession() waits instead of aborting while agent_end processing is still streaming", async () => {
    const session = await createSession({ persistSessions: true });
    const previousSessionFile = session.sessionFile;
    assert.ok(previousSessionFile, "need a persisted session file");
    session.sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "switch persisted prompt" }]
    });
    session.sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "switch persisted response" }],
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        total: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: "stop",
      timestamp: Date.now()
    });
    session.agent.replaceMessages(session.sessionManager.buildSessionContext().messages);
    const ok = await session.newSession();
    assert.equal(ok, true);
    const activeSessionFile = session.sessionFile;
    assert.ok(activeSessionFile, "need an active session file");
    assert.notEqual(activeSessionFile, previousSessionFile);
    assert.deepEqual(session.messages, []);
    const order = [];
    let releaseIdle;
    const idle = new Promise((resolve) => {
      releaseIdle = resolve;
    });
    session._processingAgentEnd = true;
    session.agent.state.isStreaming = true;
    session.agent.waitForIdle = () => {
      order.push("waitForIdle");
      return idle;
    };
    session.abort = async () => {
      order.push("abort");
    };
    const originalDisconnect = session._disconnectFromAgent.bind(session);
    session._disconnectFromAgent = () => {
      order.push("_disconnectFromAgent");
      originalDisconnect();
    };
    const pendingSwitch = session.switchSession(previousSessionFile);
    await Promise.resolve();
    assert.deepEqual(order, ["waitForIdle"]);
    assert.equal(order.includes("abort"), false);
    assert.equal(session.sessionFile, activeSessionFile);
    assert.deepEqual(session.messages, []);
    releaseIdle();
    const switched = await pendingSwitch;
    assert.equal(switched, true);
    assert.deepEqual(order, ["waitForIdle", "_disconnectFromAgent"]);
    assert.equal(order.includes("abort"), false);
    assert.equal(session.sessionFile, previousSessionFile);
    const restoredText = session.messages.flatMap((message) => message.content ?? []).filter((part) => part.type === "text").map((part) => part.text);
    assert.deepEqual(restoredText, ["switch persisted prompt", "switch persisted response"]);
  });
  it("newSession() during agent_end skips stale post-handlers after the transition starts", async () => {
    const session = await createSession();
    const assistantMessage = makeAssistantMessage("old response");
    let compactionChecks = 0;
    let listenerAgentEnds = 0;
    session._lastAssistantMessage = assistantMessage;
    session._compactionOrchestrator.checkCompaction = async () => {
      compactionChecks++;
    };
    session.subscribe((event) => {
      if (event.type === "agent_end") listenerAgentEnds++;
    });
    installAgentEndSessionTransition(session, () => session.newSession());
    await session._processAgentEvent({
      type: "agent_end",
      messages: [assistantMessage]
    });
    assert.equal(compactionChecks, 0);
    assert.equal(listenerAgentEnds, 0);
    assert.equal(session._lastAssistantMessage, void 0);
    assert.equal(session._sessionSwitchPending, false);
    assert.equal(session._sessionTransitionStartedDuringAgentEnd, false);
  });
  it("switchSession() during agent_end skips stale post-handlers after the transition starts", async () => {
    const session = await createSession({ persistSessions: true });
    const previousSessionFile = session.sessionFile;
    assert.ok(previousSessionFile, "need a persisted session file");
    const ok = await session.newSession();
    assert.equal(ok, true);
    assert.notEqual(session.sessionFile, previousSessionFile);
    const assistantMessage = makeAssistantMessage("old switch response");
    let compactionChecks = 0;
    let listenerAgentEnds = 0;
    session._lastAssistantMessage = assistantMessage;
    session._compactionOrchestrator.checkCompaction = async () => {
      compactionChecks++;
    };
    session.subscribe((event) => {
      if (event.type === "agent_end") listenerAgentEnds++;
    });
    installAgentEndSessionTransition(session, () => session.switchSession(previousSessionFile));
    await session._processAgentEvent({
      type: "agent_end",
      messages: [assistantMessage]
    });
    assert.equal(session.sessionFile, previousSessionFile);
    assert.equal(compactionChecks, 0);
    assert.equal(listenerAgentEnds, 0);
    assert.equal(session._lastAssistantMessage, void 0);
    assert.equal(session._sessionSwitchPending, false);
    assert.equal(session._sessionTransitionStartedDuringAgentEnd, false);
  });
  it("agent_end post-handlers bail while a session switch is pending", async () => {
    const session = await createSession();
    const assistantMessage = makeAssistantMessage("old pending response");
    let compactionChecks = 0;
    let listenerAgentEnds = 0;
    session._lastAssistantMessage = assistantMessage;
    session._sessionSwitchPending = true;
    session._compactionOrchestrator.checkCompaction = async () => {
      compactionChecks++;
    };
    session.subscribe((event) => {
      if (event.type === "agent_end") listenerAgentEnds++;
    });
    await session._processAgentEvent({
      type: "agent_end",
      messages: [assistantMessage]
    });
    assert.equal(compactionChecks, 0);
    assert.equal(listenerAgentEnds, 1);
    assert.equal(session._lastAssistantMessage, void 0);
  });
  it("switchSession() invokes abort() before _disconnectFromAgent()", async () => {
    const session = await createSession({ persistSessions: true });
    await session.newSession();
    const sessionFile = session.sessionFile;
    assert.ok(typeof sessionFile === "string" && sessionFile.length > 0, "need a session file to switch to");
    session.agent.state.isStreaming = true;
    const order = recordCallOrder(session, ["abort", "_disconnectFromAgent"]);
    const ok = await session.switchSession(sessionFile);
    assert.equal(ok, true);
    const abortIdx = order.indexOf("abort");
    const disconnectIdx = order.indexOf("_disconnectFromAgent");
    assert.ok(abortIdx >= 0, `switchSession should call abort(); order=${order.join(",")}`);
    assert.ok(
      disconnectIdx >= 0,
      `switchSession should call _disconnectFromAgent(); order=${order.join(",")}`
    );
    assert.ok(
      abortIdx < disconnectIdx,
      `abort() must run before _disconnectFromAgent() in switchSession; order=${order.join(",")}`
    );
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL2FnZW50LXNlc3Npb24tYWJvcnQtb3JkZXIudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUmVncmVzc2lvbiB0ZXN0IGZvciAjNDI0MyBcdTIwMTQgYWJvcnQoKSBtdXN0IGJlIGNhbGxlZCBCRUZPUkVcbi8vIF9kaXNjb25uZWN0RnJvbUFnZW50KCkgaW5zaWRlIG5ld1Nlc3Npb24oKSBhbmQgc3dpdGNoU2Vzc2lvbigpIHNvIHRoYXRcbi8vIG1lc3NhZ2VfZW5kL2FnZW50X2VuZCBldmVudHMgKGFuZCB0aGUgIzQyMTYgZmluYWxpemF0aW9uIGNvZGUpIGZpcmVcbi8vIGJlZm9yZSB3ZSB1bnN1YnNjcmliZSBmcm9tIHRoZSBldmVudCBidXMuXG4vL1xuLy8gVmVyaWZpZWQgYmVoYXZpb3VyYWxseTogd2UgY29uc3RydWN0IGEgcmVhbCBBZ2VudFNlc3Npb24sIHdyYXAgYGFib3J0YFxuLy8gYW5kIGBfZGlzY29ubmVjdEZyb21BZ2VudGAgd2l0aCBjYWxsLW9yZGVyIHJlY29yZGluZywgdHJpZ2dlciBlYWNoXG4vLyBzZXNzaW9uLXRyYW5zaXRpb24gbWV0aG9kLCBhbmQgYXNzZXJ0IHRoZSBvYnNlcnZlZCBjYWxsIG9yZGVyLlxuXG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBybVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBhZnRlckVhY2gsIGJlZm9yZUVhY2gsIGRlc2NyaWJlLCBpdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcblxuaW1wb3J0IHsgQWdlbnQgfSBmcm9tIFwiQGdzZC9waS1hZ2VudC1jb3JlXCI7XG5pbXBvcnQgeyBBZ2VudFNlc3Npb24gfSBmcm9tIFwiLi9hZ2VudC1zZXNzaW9uLmpzXCI7XG5pbXBvcnQgeyBBdXRoU3RvcmFnZSB9IGZyb20gXCIuL2F1dGgtc3RvcmFnZS5qc1wiO1xuaW1wb3J0IHsgTW9kZWxSZWdpc3RyeSB9IGZyb20gXCIuL21vZGVsLXJlZ2lzdHJ5LmpzXCI7XG5pbXBvcnQgeyBEZWZhdWx0UmVzb3VyY2VMb2FkZXIgfSBmcm9tIFwiLi9yZXNvdXJjZS1sb2FkZXIuanNcIjtcbmltcG9ydCB7IFNlc3Npb25NYW5hZ2VyIH0gZnJvbSBcIi4vc2Vzc2lvbi1tYW5hZ2VyLmpzXCI7XG5pbXBvcnQgeyBTZXR0aW5nc01hbmFnZXIgfSBmcm9tIFwiLi9zZXR0aW5ncy1tYW5hZ2VyLmpzXCI7XG5cbmxldCB0ZXN0RGlyOiBzdHJpbmc7XG5cbmFzeW5jIGZ1bmN0aW9uIGNyZWF0ZVNlc3Npb24ob3B0czogeyBwZXJzaXN0U2Vzc2lvbnM/OiBib29sZWFuIH0gPSB7fSk6IFByb21pc2U8QWdlbnRTZXNzaW9uPiB7XG5cdGNvbnN0IGFnZW50RGlyID0gam9pbih0ZXN0RGlyLCBcImFnZW50LWhvbWVcIik7XG5cdGNvbnN0IGF1dGhTdG9yYWdlID0gQXV0aFN0b3JhZ2UuaW5NZW1vcnkoe30pO1xuXHRjb25zdCBtb2RlbFJlZ2lzdHJ5ID0gbmV3IE1vZGVsUmVnaXN0cnkoYXV0aFN0b3JhZ2UsIGpvaW4oYWdlbnREaXIsIFwibW9kZWxzLmpzb25cIikpO1xuXHRjb25zdCBzZXR0aW5nc01hbmFnZXIgPSBTZXR0aW5nc01hbmFnZXIuaW5NZW1vcnkoKTtcblx0Y29uc3QgcmVzb3VyY2VMb2FkZXIgPSBuZXcgRGVmYXVsdFJlc291cmNlTG9hZGVyKHtcblx0XHRjd2Q6IHRlc3REaXIsXG5cdFx0YWdlbnREaXIsXG5cdFx0c2V0dGluZ3NNYW5hZ2VyLFxuXHRcdG5vRXh0ZW5zaW9uczogdHJ1ZSxcblx0XHRub1Byb21wdFRlbXBsYXRlczogdHJ1ZSxcblx0XHRub1RoZW1lczogdHJ1ZSxcblx0fSk7XG5cdGF3YWl0IHJlc291cmNlTG9hZGVyLnJlbG9hZCgpO1xuXG5cdC8vIHN3aXRjaFNlc3Npb24oKSBuZWVkcyBhIHNlc3Npb25GaWxlOyBpbi1tZW1vcnkgbWFuYWdlciByZXR1cm5zIHVuZGVmaW5lZC5cblx0Ly8gVXNlIGZpbGUtYmFja2VkIG1hbmFnZXIgd2hlbiB0aGUgdGVzdCBuZWVkcyB0byByZXN1bWUuXG5cdGNvbnN0IHNlc3Npb25NYW5hZ2VyID0gb3B0cy5wZXJzaXN0U2Vzc2lvbnNcblx0XHQ/IFNlc3Npb25NYW5hZ2VyLmNyZWF0ZSh0ZXN0RGlyLCBqb2luKHRlc3REaXIsIFwic2Vzc2lvbnNcIikpXG5cdFx0OiBTZXNzaW9uTWFuYWdlci5pbk1lbW9yeSh0ZXN0RGlyKTtcblxuXHRyZXR1cm4gbmV3IEFnZW50U2Vzc2lvbih7XG5cdFx0YWdlbnQ6IG5ldyBBZ2VudCgpLFxuXHRcdHNlc3Npb25NYW5hZ2VyLFxuXHRcdHNldHRpbmdzTWFuYWdlcixcblx0XHRjd2Q6IHRlc3REaXIsXG5cdFx0cmVzb3VyY2VMb2FkZXIsXG5cdFx0bW9kZWxSZWdpc3RyeSxcblx0fSk7XG59XG5cbi8qKlxuICogV3JhcCB0d28gbWV0aG9kcyBvbiB0aGUgc2FtZSBvYmplY3Qgc28gdGhlaXIgY2FsbCBvcmRlciBpcyByZWNvcmRlZC5cbiAqIFJldHVybnMgdGhlIHJlY29yZGluZyBhcnJheSBcdTIwMTQgYXNzZXJ0aW9ucyB1c2UgaW5kZXggbG9va3Vwcy5cbiAqL1xuZnVuY3Rpb24gcmVjb3JkQ2FsbE9yZGVyPE8gZXh0ZW5kcyBvYmplY3Q+KFxuXHR0YXJnZXQ6IE8sXG5cdG1ldGhvZHM6IEFycmF5PGtleW9mIE8+LFxuKTogc3RyaW5nW10ge1xuXHRjb25zdCBvcmRlcjogc3RyaW5nW10gPSBbXTtcblx0Zm9yIChjb25zdCBtZXRob2Qgb2YgbWV0aG9kcykge1xuXHRcdGNvbnN0IG5hbWUgPSBTdHJpbmcobWV0aG9kKTtcblx0XHRjb25zdCBvcmlnaW5hbCA9ICh0YXJnZXQgYXMgYW55KVtuYW1lXSBhcyAoLi4uYXJnczogdW5rbm93bltdKSA9PiB1bmtub3duO1xuXHRcdGlmICh0eXBlb2Ygb3JpZ2luYWwgIT09IFwiZnVuY3Rpb25cIikge1xuXHRcdFx0dGhyb3cgbmV3IEVycm9yKGByZWNvcmRDYWxsT3JkZXI6ICR7bmFtZX0gaXMgbm90IGEgZnVuY3Rpb24gb24gdGFyZ2V0YCk7XG5cdFx0fVxuXHRcdCh0YXJnZXQgYXMgYW55KVtuYW1lXSA9IGZ1bmN0aW9uICh0aGlzOiBPLCAuLi5hcmdzOiB1bmtub3duW10pIHtcblx0XHRcdG9yZGVyLnB1c2gobmFtZSk7XG5cdFx0XHRyZXR1cm4gb3JpZ2luYWwuYXBwbHkodGhpcywgYXJncyk7XG5cdFx0fTtcblx0fVxuXHRyZXR1cm4gb3JkZXI7XG59XG5cbmZ1bmN0aW9uIG1ha2VBc3Npc3RhbnRNZXNzYWdlKHRleHQ6IHN0cmluZykge1xuXHRyZXR1cm4ge1xuXHRcdHJvbGU6IFwiYXNzaXN0YW50XCIsXG5cdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQgfV0sXG5cdFx0dXNhZ2U6IHtcblx0XHRcdGlucHV0OiAxLFxuXHRcdFx0b3V0cHV0OiAxLFxuXHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdHRvdGFsOiAyLFxuXHRcdFx0Y29zdDogeyBpbnB1dDogMCwgb3V0cHV0OiAwLCBjYWNoZVJlYWQ6IDAsIGNhY2hlV3JpdGU6IDAsIHRvdGFsOiAwIH0sXG5cdFx0fSxcblx0XHRzdG9wUmVhc29uOiBcInN0b3BcIixcblx0XHR0aW1lc3RhbXA6IERhdGUubm93KCksXG5cdH0gYXMgYW55O1xufVxuXG5mdW5jdGlvbiBpbnN0YWxsQWdlbnRFbmRTZXNzaW9uVHJhbnNpdGlvbihcblx0c2Vzc2lvbjogQWdlbnRTZXNzaW9uLFxuXHR0cmFuc2l0aW9uOiAoKSA9PiBQcm9taXNlPHVua25vd24+LFxuKTogdm9pZCB7XG5cdChzZXNzaW9uIGFzIGFueSkuX2V4dGVuc2lvblJ1bm5lciA9IHtcblx0XHRoYXNIYW5kbGVyczogKCkgPT4gZmFsc2UsXG5cdFx0ZW1pdDogYXN5bmMgKGV2ZW50OiBhbnkpID0+IHtcblx0XHRcdGlmIChldmVudC50eXBlID09PSBcImFnZW50X2VuZFwiKSB7XG5cdFx0XHRcdGF3YWl0IHRyYW5zaXRpb24oKTtcblx0XHRcdH1cblx0XHR9LFxuXHRcdGVtaXRTdG9wOiBhc3luYyAoKSA9PiB7fSxcblx0fTtcbn1cblxuZGVzY3JpYmUoXCIjNDI0MyBcdTIwMTQgYWJvcnQoKSBtdXN0IHJ1biBiZWZvcmUgX2Rpc2Nvbm5lY3RGcm9tQWdlbnQoKVwiLCAoKSA9PiB7XG5cdGJlZm9yZUVhY2goKCkgPT4ge1xuXHRcdHRlc3REaXIgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImFnZW50LXNlc3Npb24tYWJvcnQtXCIpKTtcblx0fSk7XG5cblx0YWZ0ZXJFYWNoKCgpID0+IHtcblx0XHRybVN5bmModGVzdERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuXHR9KTtcblxuXHRpdChcIm5ld1Nlc3Npb24oKSBpbnZva2VzIGFib3J0KCkgYmVmb3JlIF9kaXNjb25uZWN0RnJvbUFnZW50KClcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IHNlc3Npb24gPSBhd2FpdCBjcmVhdGVTZXNzaW9uKCk7XG5cdFx0KHNlc3Npb24gYXMgYW55KS5hZ2VudC5zdGF0ZS5pc1N0cmVhbWluZyA9IHRydWU7XG5cdFx0Y29uc3Qgb3JkZXIgPSByZWNvcmRDYWxsT3JkZXIoc2Vzc2lvbiBhcyBhbnksIFtcImFib3J0XCIsIFwiX2Rpc2Nvbm5lY3RGcm9tQWdlbnRcIl0pO1xuXG5cdFx0Y29uc3Qgb2sgPSBhd2FpdCBzZXNzaW9uLm5ld1Nlc3Npb24oKTtcblx0XHRhc3NlcnQuZXF1YWwob2ssIHRydWUpO1xuXG5cdFx0Y29uc3QgYWJvcnRJZHggPSBvcmRlci5pbmRleE9mKFwiYWJvcnRcIik7XG5cdFx0Y29uc3QgZGlzY29ubmVjdElkeCA9IG9yZGVyLmluZGV4T2YoXCJfZGlzY29ubmVjdEZyb21BZ2VudFwiKTtcblx0XHRhc3NlcnQub2soYWJvcnRJZHggPj0gMCwgYG5ld1Nlc3Npb24gc2hvdWxkIGNhbGwgYWJvcnQoKTsgb3JkZXI9JHtvcmRlci5qb2luKFwiLFwiKX1gKTtcblx0XHRhc3NlcnQub2soXG5cdFx0XHRkaXNjb25uZWN0SWR4ID49IDAsXG5cdFx0XHRgbmV3U2Vzc2lvbiBzaG91bGQgY2FsbCBfZGlzY29ubmVjdEZyb21BZ2VudCgpOyBvcmRlcj0ke29yZGVyLmpvaW4oXCIsXCIpfWAsXG5cdFx0KTtcblx0XHRhc3NlcnQub2soXG5cdFx0XHRhYm9ydElkeCA8IGRpc2Nvbm5lY3RJZHgsXG5cdFx0XHRgYWJvcnQoKSBtdXN0IHJ1biBiZWZvcmUgX2Rpc2Nvbm5lY3RGcm9tQWdlbnQoKTsgb3JkZXI9JHtvcmRlci5qb2luKFwiLFwiKX1gLFxuXHRcdCk7XG5cdH0pO1xuXG5cdGl0KFwibmV3U2Vzc2lvbigpIHdhaXRzIGluc3RlYWQgb2YgYWJvcnRpbmcgd2hlbiB0aGUgcHJpb3IgdHVybiBpcyBpZGxlIGJ1dCBub3Qgc2V0dGxlZFwiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3Qgc2Vzc2lvbiA9IGF3YWl0IGNyZWF0ZVNlc3Npb24oKTtcblx0XHRjb25zdCBvcmRlcjogc3RyaW5nW10gPSBbXTtcblx0XHRsZXQgcmVsZWFzZUlkbGUhOiAoKSA9PiB2b2lkO1xuXHRcdGNvbnN0IGlkbGUgPSBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4ge1xuXHRcdFx0cmVsZWFzZUlkbGUgPSByZXNvbHZlO1xuXHRcdH0pO1xuXG5cdFx0KHNlc3Npb24gYXMgYW55KS5hZ2VudC5zdGF0ZS5pc1N0cmVhbWluZyA9IGZhbHNlO1xuXHRcdChzZXNzaW9uIGFzIGFueSkuYWdlbnQud2FpdEZvcklkbGUgPSAoKSA9PiB7XG5cdFx0XHRvcmRlci5wdXNoKFwid2FpdEZvcklkbGVcIik7XG5cdFx0XHRyZXR1cm4gaWRsZTtcblx0XHR9O1xuXHRcdChzZXNzaW9uIGFzIGFueSkuYWJvcnQgPSBhc3luYyAoKSA9PiB7XG5cdFx0XHRvcmRlci5wdXNoKFwiYWJvcnRcIik7XG5cdFx0fTtcblx0XHRjb25zdCBvcmlnaW5hbERpc2Nvbm5lY3QgPSAoc2Vzc2lvbiBhcyBhbnkpLl9kaXNjb25uZWN0RnJvbUFnZW50LmJpbmQoc2Vzc2lvbik7XG5cdFx0KHNlc3Npb24gYXMgYW55KS5fZGlzY29ubmVjdEZyb21BZ2VudCA9ICgpID0+IHtcblx0XHRcdG9yZGVyLnB1c2goXCJfZGlzY29ubmVjdEZyb21BZ2VudFwiKTtcblx0XHRcdG9yaWdpbmFsRGlzY29ubmVjdCgpO1xuXHRcdH07XG5cblx0XHRjb25zdCBwZW5kaW5nTmV3U2Vzc2lvbiA9IHNlc3Npb24ubmV3U2Vzc2lvbigpO1xuXHRcdGF3YWl0IFByb21pc2UucmVzb2x2ZSgpO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwob3JkZXIsIFtcIndhaXRGb3JJZGxlXCJdKTtcblx0XHRhc3NlcnQuZXF1YWwob3JkZXIuaW5jbHVkZXMoXCJhYm9ydFwiKSwgZmFsc2UpO1xuXG5cdFx0cmVsZWFzZUlkbGUoKTtcblx0XHRjb25zdCBvayA9IGF3YWl0IHBlbmRpbmdOZXdTZXNzaW9uO1xuXHRcdGFzc2VydC5lcXVhbChvaywgdHJ1ZSk7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChvcmRlciwgW1wid2FpdEZvcklkbGVcIiwgXCJfZGlzY29ubmVjdEZyb21BZ2VudFwiXSk7XG5cdFx0YXNzZXJ0LmVxdWFsKG9yZGVyLmluY2x1ZGVzKFwiYWJvcnRcIiksIGZhbHNlKTtcblx0fSk7XG5cblx0aXQoXCJuZXdTZXNzaW9uKCkgd2FpdHMgaW5zdGVhZCBvZiBhYm9ydGluZyB3aGlsZSBhZ2VudF9lbmQgcHJvY2Vzc2luZyBpcyBzdGlsbCBzdHJlYW1pbmdcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IHNlc3Npb24gPSBhd2FpdCBjcmVhdGVTZXNzaW9uKCk7XG5cdFx0Y29uc3Qgb3JkZXI6IHN0cmluZ1tdID0gW107XG5cdFx0bGV0IHJlbGVhc2VJZGxlITogKCkgPT4gdm9pZDtcblx0XHRjb25zdCBpZGxlID0gbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUpID0+IHtcblx0XHRcdHJlbGVhc2VJZGxlID0gcmVzb2x2ZTtcblx0XHR9KTtcblxuXHRcdChzZXNzaW9uIGFzIGFueSkuX3Byb2Nlc3NpbmdBZ2VudEVuZCA9IHRydWU7XG5cdFx0KHNlc3Npb24gYXMgYW55KS5hZ2VudC5zdGF0ZS5pc1N0cmVhbWluZyA9IHRydWU7XG5cdFx0KHNlc3Npb24gYXMgYW55KS5hZ2VudC53YWl0Rm9ySWRsZSA9ICgpID0+IHtcblx0XHRcdG9yZGVyLnB1c2goXCJ3YWl0Rm9ySWRsZVwiKTtcblx0XHRcdHJldHVybiBpZGxlO1xuXHRcdH07XG5cdFx0KHNlc3Npb24gYXMgYW55KS5hYm9ydCA9IGFzeW5jICgpID0+IHtcblx0XHRcdG9yZGVyLnB1c2goXCJhYm9ydFwiKTtcblx0XHR9O1xuXHRcdGNvbnN0IG9yaWdpbmFsRGlzY29ubmVjdCA9IChzZXNzaW9uIGFzIGFueSkuX2Rpc2Nvbm5lY3RGcm9tQWdlbnQuYmluZChzZXNzaW9uKTtcblx0XHQoc2Vzc2lvbiBhcyBhbnkpLl9kaXNjb25uZWN0RnJvbUFnZW50ID0gKCkgPT4ge1xuXHRcdFx0b3JkZXIucHVzaChcIl9kaXNjb25uZWN0RnJvbUFnZW50XCIpO1xuXHRcdFx0b3JpZ2luYWxEaXNjb25uZWN0KCk7XG5cdFx0fTtcblxuXHRcdGNvbnN0IHBlbmRpbmdOZXdTZXNzaW9uID0gc2Vzc2lvbi5uZXdTZXNzaW9uKCk7XG5cdFx0YXdhaXQgUHJvbWlzZS5yZXNvbHZlKCk7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChvcmRlciwgW1wid2FpdEZvcklkbGVcIl0pO1xuXHRcdGFzc2VydC5lcXVhbChvcmRlci5pbmNsdWRlcyhcImFib3J0XCIpLCBmYWxzZSk7XG5cblx0XHRyZWxlYXNlSWRsZSgpO1xuXHRcdGNvbnN0IG9rID0gYXdhaXQgcGVuZGluZ05ld1Nlc3Npb247XG5cdFx0YXNzZXJ0LmVxdWFsKG9rLCB0cnVlKTtcblx0XHRhc3NlcnQuZGVlcEVxdWFsKG9yZGVyLCBbXCJ3YWl0Rm9ySWRsZVwiLCBcIl9kaXNjb25uZWN0RnJvbUFnZW50XCJdKTtcblx0XHRhc3NlcnQuZXF1YWwob3JkZXIuaW5jbHVkZXMoXCJhYm9ydFwiKSwgZmFsc2UpO1xuXHR9KTtcblxuXHRpdChcIm5ld1Nlc3Npb24oKSB3YWl0cyBkdXJpbmcgYWdlbnRfZW5kIHByb2Nlc3NpbmcgZXZlbiBvbmNlIGFscmVhZHkgaWRsZVwiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3Qgc2Vzc2lvbiA9IGF3YWl0IGNyZWF0ZVNlc3Npb24oKTtcblx0XHRjb25zdCBvcmRlcjogc3RyaW5nW10gPSBbXTtcblxuXHRcdChzZXNzaW9uIGFzIGFueSkuX3Byb2Nlc3NpbmdBZ2VudEVuZCA9IHRydWU7XG5cdFx0KHNlc3Npb24gYXMgYW55KS5hZ2VudC5zdGF0ZS5pc1N0cmVhbWluZyA9IGZhbHNlO1xuXHRcdChzZXNzaW9uIGFzIGFueSkuYWdlbnQud2FpdEZvcklkbGUgPSBhc3luYyAoKSA9PiB7XG5cdFx0XHRvcmRlci5wdXNoKFwid2FpdEZvcklkbGVcIik7XG5cdFx0fTtcblx0XHQoc2Vzc2lvbiBhcyBhbnkpLmFib3J0ID0gYXN5bmMgKCkgPT4ge1xuXHRcdFx0b3JkZXIucHVzaChcImFib3J0XCIpO1xuXHRcdH07XG5cdFx0Y29uc3Qgb3JpZ2luYWxEaXNjb25uZWN0ID0gKHNlc3Npb24gYXMgYW55KS5fZGlzY29ubmVjdEZyb21BZ2VudC5iaW5kKHNlc3Npb24pO1xuXHRcdChzZXNzaW9uIGFzIGFueSkuX2Rpc2Nvbm5lY3RGcm9tQWdlbnQgPSAoKSA9PiB7XG5cdFx0XHRvcmRlci5wdXNoKFwiX2Rpc2Nvbm5lY3RGcm9tQWdlbnRcIik7XG5cdFx0XHRvcmlnaW5hbERpc2Nvbm5lY3QoKTtcblx0XHR9O1xuXG5cdFx0Y29uc3Qgb2sgPSBhd2FpdCBzZXNzaW9uLm5ld1Nlc3Npb24oKTtcblx0XHRhc3NlcnQuZXF1YWwob2ssIHRydWUpO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwob3JkZXIsIFtcIndhaXRGb3JJZGxlXCIsIFwiX2Rpc2Nvbm5lY3RGcm9tQWdlbnRcIl0pO1xuXHRcdGFzc2VydC5lcXVhbChvcmRlci5pbmNsdWRlcyhcImFib3J0XCIpLCBmYWxzZSk7XG5cdH0pO1xuXG5cdGl0KFwiYWJvcnQoKSBtYXJrcyBzeW50aGV0aWMgYWdlbnRfZW5kIHByb2Nlc3Npbmcgd2hpbGUgZXh0ZW5zaW9uIGhhbmRsZXJzIHJ1blwiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3Qgc2Vzc2lvbiA9IGF3YWl0IGNyZWF0ZVNlc3Npb24oKTtcblx0XHRjb25zdCBvYnNlcnZlZFByb2Nlc3NpbmdTdGF0ZXM6IGJvb2xlYW5bXSA9IFtdO1xuXHRcdGNvbnN0IG9ic2VydmVkT3JpZ2luczogdW5rbm93bltdID0gW107XG5cblx0XHQoc2Vzc2lvbiBhcyBhbnkpLmFnZW50LmFib3J0ID0gKCkgPT4ge307XG5cdFx0KHNlc3Npb24gYXMgYW55KS5hZ2VudC53YWl0Rm9ySWRsZSA9IGFzeW5jICgpID0+IHt9O1xuXHRcdChzZXNzaW9uIGFzIGFueSkuX2V4dGVuc2lvblJ1bm5lciA9IHtcblx0XHRcdGVtaXQ6IGFzeW5jIChldmVudDogYW55KSA9PiB7XG5cdFx0XHRcdGlmIChldmVudC50eXBlID09PSBcImFnZW50X2VuZFwiKSB7XG5cdFx0XHRcdFx0b2JzZXJ2ZWRQcm9jZXNzaW5nU3RhdGVzLnB1c2goKHNlc3Npb24gYXMgYW55KS5fcHJvY2Vzc2luZ0FnZW50RW5kKTtcblx0XHRcdFx0XHRvYnNlcnZlZE9yaWdpbnMucHVzaChldmVudC5hYm9ydE9yaWdpbik7XG5cdFx0XHRcdH1cblx0XHRcdH0sXG5cdFx0XHRlbWl0U3RvcDogYXN5bmMgKCkgPT4ge1xuXHRcdFx0XHRvYnNlcnZlZFByb2Nlc3NpbmdTdGF0ZXMucHVzaCgoc2Vzc2lvbiBhcyBhbnkpLl9wcm9jZXNzaW5nQWdlbnRFbmQpO1xuXHRcdFx0fSxcblx0XHR9O1xuXG5cdFx0YXdhaXQgc2Vzc2lvbi5hYm9ydCh7IG9yaWdpbjogXCJzZXNzaW9uLXRyYW5zaXRpb25cIiB9KTtcblxuXHRcdGFzc2VydC5kZWVwRXF1YWwob2JzZXJ2ZWRQcm9jZXNzaW5nU3RhdGVzLCBbdHJ1ZSwgdHJ1ZV0pO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwob2JzZXJ2ZWRPcmlnaW5zLCBbXCJzZXNzaW9uLXRyYW5zaXRpb25cIl0pO1xuXHRcdGFzc2VydC5lcXVhbCgoc2Vzc2lvbiBhcyBhbnkpLl9wcm9jZXNzaW5nQWdlbnRFbmQsIGZhbHNlKTtcblx0fSk7XG5cblx0aXQoXCJuZXdTZXNzaW9uKCkgZHVyaW5nIGFnZW50X2VuZCBwcmVzZXJ2ZXMgdGhlIHByZXZpb3VzIHNlc3Npb24gZm9yIHJlc3VtZVwiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3Qgc2Vzc2lvbiA9IGF3YWl0IGNyZWF0ZVNlc3Npb24oeyBwZXJzaXN0U2Vzc2lvbnM6IHRydWUgfSk7XG5cdFx0Y29uc3QgcHJldmlvdXNTZXNzaW9uRmlsZSA9IHNlc3Npb24uc2Vzc2lvbkZpbGU7XG5cdFx0YXNzZXJ0Lm9rKHByZXZpb3VzU2Vzc2lvbkZpbGUsIFwibmVlZCBhIHBlcnNpc3RlZCBzZXNzaW9uIGZpbGVcIik7XG5cblx0XHRzZXNzaW9uLnNlc3Npb25NYW5hZ2VyLmFwcGVuZE1lc3NhZ2Uoe1xuXHRcdFx0cm9sZTogXCJ1c2VyXCIsXG5cdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJwZXJzaXN0ZWQgcHJvbXB0XCIgfV0sXG5cdFx0fSBhcyBhbnkpO1xuXHRcdHNlc3Npb24uc2Vzc2lvbk1hbmFnZXIuYXBwZW5kTWVzc2FnZSh7XG5cdFx0XHRyb2xlOiBcImFzc2lzdGFudFwiLFxuXHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwicGVyc2lzdGVkIHJlc3BvbnNlXCIgfV0sXG5cdFx0XHR1c2FnZToge1xuXHRcdFx0XHRpbnB1dDogMSxcblx0XHRcdFx0b3V0cHV0OiAxLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHRcdHRvdGFsOiAyLFxuXHRcdFx0XHRjb3N0OiB7IGlucHV0OiAwLCBvdXRwdXQ6IDAsIGNhY2hlUmVhZDogMCwgY2FjaGVXcml0ZTogMCwgdG90YWw6IDAgfSxcblx0XHRcdH0sXG5cdFx0XHRzdG9wUmVhc29uOiBcInN0b3BcIixcblx0XHRcdHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcblx0XHR9IGFzIGFueSk7XG5cdFx0c2Vzc2lvbi5hZ2VudC5yZXBsYWNlTWVzc2FnZXMoc2Vzc2lvbi5zZXNzaW9uTWFuYWdlci5idWlsZFNlc3Npb25Db250ZXh0KCkubWVzc2FnZXMpO1xuXG5cdFx0KHNlc3Npb24gYXMgYW55KS5fcHJvY2Vzc2luZ0FnZW50RW5kID0gdHJ1ZTtcblx0XHQoc2Vzc2lvbiBhcyBhbnkpLmFnZW50LndhaXRGb3JJZGxlID0gYXN5bmMgKCkgPT4ge307XG5cblx0XHRjb25zdCBvayA9IGF3YWl0IHNlc3Npb24ubmV3U2Vzc2lvbigpO1xuXHRcdGFzc2VydC5lcXVhbChvaywgdHJ1ZSk7XG5cdFx0YXNzZXJ0Lm5vdEVxdWFsKHNlc3Npb24uc2Vzc2lvbkZpbGUsIHByZXZpb3VzU2Vzc2lvbkZpbGUpO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwoc2Vzc2lvbi5tZXNzYWdlcywgW10pO1xuXG5cdFx0KHNlc3Npb24gYXMgYW55KS5fcHJvY2Vzc2luZ0FnZW50RW5kID0gZmFsc2U7XG5cdFx0Y29uc3Qgc3dpdGNoZWQgPSBhd2FpdCBzZXNzaW9uLnN3aXRjaFNlc3Npb24ocHJldmlvdXNTZXNzaW9uRmlsZSk7XG5cdFx0YXNzZXJ0LmVxdWFsKHN3aXRjaGVkLCB0cnVlKTtcblxuXHRcdGNvbnN0IHJlc3RvcmVkVGV4dCA9IHNlc3Npb24ubWVzc2FnZXNcblx0XHRcdC5mbGF0TWFwKChtZXNzYWdlOiBhbnkpID0+IG1lc3NhZ2UuY29udGVudCA/PyBbXSlcblx0XHRcdC5maWx0ZXIoKHBhcnQ6IGFueSkgPT4gcGFydC50eXBlID09PSBcInRleHRcIilcblx0XHRcdC5tYXAoKHBhcnQ6IGFueSkgPT4gcGFydC50ZXh0KTtcblx0XHRhc3NlcnQuZGVlcEVxdWFsKHJlc3RvcmVkVGV4dCwgW1wicGVyc2lzdGVkIHByb21wdFwiLCBcInBlcnNpc3RlZCByZXNwb25zZVwiXSk7XG5cdH0pO1xuXG5cdGl0KFwic3dpdGNoU2Vzc2lvbigpIHdhaXRzIGluc3RlYWQgb2YgYWJvcnRpbmcgd2hpbGUgYWdlbnRfZW5kIHByb2Nlc3NpbmcgaXMgc3RpbGwgc3RyZWFtaW5nXCIsIGFzeW5jICgpID0+IHtcblx0XHRjb25zdCBzZXNzaW9uID0gYXdhaXQgY3JlYXRlU2Vzc2lvbih7IHBlcnNpc3RTZXNzaW9uczogdHJ1ZSB9KTtcblx0XHRjb25zdCBwcmV2aW91c1Nlc3Npb25GaWxlID0gc2Vzc2lvbi5zZXNzaW9uRmlsZTtcblx0XHRhc3NlcnQub2socHJldmlvdXNTZXNzaW9uRmlsZSwgXCJuZWVkIGEgcGVyc2lzdGVkIHNlc3Npb24gZmlsZVwiKTtcblxuXHRcdHNlc3Npb24uc2Vzc2lvbk1hbmFnZXIuYXBwZW5kTWVzc2FnZSh7XG5cdFx0XHRyb2xlOiBcInVzZXJcIixcblx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcInN3aXRjaCBwZXJzaXN0ZWQgcHJvbXB0XCIgfV0sXG5cdFx0fSBhcyBhbnkpO1xuXHRcdHNlc3Npb24uc2Vzc2lvbk1hbmFnZXIuYXBwZW5kTWVzc2FnZSh7XG5cdFx0XHRyb2xlOiBcImFzc2lzdGFudFwiLFxuXHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwic3dpdGNoIHBlcnNpc3RlZCByZXNwb25zZVwiIH1dLFxuXHRcdFx0dXNhZ2U6IHtcblx0XHRcdFx0aW5wdXQ6IDEsXG5cdFx0XHRcdG91dHB1dDogMSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0XHR0b3RhbDogMixcblx0XHRcdFx0Y29zdDogeyBpbnB1dDogMCwgb3V0cHV0OiAwLCBjYWNoZVJlYWQ6IDAsIGNhY2hlV3JpdGU6IDAsIHRvdGFsOiAwIH0sXG5cdFx0XHR9LFxuXHRcdFx0c3RvcFJlYXNvbjogXCJzdG9wXCIsXG5cdFx0XHR0aW1lc3RhbXA6IERhdGUubm93KCksXG5cdFx0fSBhcyBhbnkpO1xuXHRcdHNlc3Npb24uYWdlbnQucmVwbGFjZU1lc3NhZ2VzKHNlc3Npb24uc2Vzc2lvbk1hbmFnZXIuYnVpbGRTZXNzaW9uQ29udGV4dCgpLm1lc3NhZ2VzKTtcblxuXHRcdGNvbnN0IG9rID0gYXdhaXQgc2Vzc2lvbi5uZXdTZXNzaW9uKCk7XG5cdFx0YXNzZXJ0LmVxdWFsKG9rLCB0cnVlKTtcblx0XHRjb25zdCBhY3RpdmVTZXNzaW9uRmlsZSA9IHNlc3Npb24uc2Vzc2lvbkZpbGU7XG5cdFx0YXNzZXJ0Lm9rKGFjdGl2ZVNlc3Npb25GaWxlLCBcIm5lZWQgYW4gYWN0aXZlIHNlc3Npb24gZmlsZVwiKTtcblx0XHRhc3NlcnQubm90RXF1YWwoYWN0aXZlU2Vzc2lvbkZpbGUsIHByZXZpb3VzU2Vzc2lvbkZpbGUpO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwoc2Vzc2lvbi5tZXNzYWdlcywgW10pO1xuXG5cdFx0Y29uc3Qgb3JkZXI6IHN0cmluZ1tdID0gW107XG5cdFx0bGV0IHJlbGVhc2VJZGxlITogKCkgPT4gdm9pZDtcblx0XHRjb25zdCBpZGxlID0gbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUpID0+IHtcblx0XHRcdHJlbGVhc2VJZGxlID0gcmVzb2x2ZTtcblx0XHR9KTtcblxuXHRcdChzZXNzaW9uIGFzIGFueSkuX3Byb2Nlc3NpbmdBZ2VudEVuZCA9IHRydWU7XG5cdFx0KHNlc3Npb24gYXMgYW55KS5hZ2VudC5zdGF0ZS5pc1N0cmVhbWluZyA9IHRydWU7XG5cdFx0KHNlc3Npb24gYXMgYW55KS5hZ2VudC53YWl0Rm9ySWRsZSA9ICgpID0+IHtcblx0XHRcdG9yZGVyLnB1c2goXCJ3YWl0Rm9ySWRsZVwiKTtcblx0XHRcdHJldHVybiBpZGxlO1xuXHRcdH07XG5cdFx0KHNlc3Npb24gYXMgYW55KS5hYm9ydCA9IGFzeW5jICgpID0+IHtcblx0XHRcdG9yZGVyLnB1c2goXCJhYm9ydFwiKTtcblx0XHR9O1xuXHRcdGNvbnN0IG9yaWdpbmFsRGlzY29ubmVjdCA9IChzZXNzaW9uIGFzIGFueSkuX2Rpc2Nvbm5lY3RGcm9tQWdlbnQuYmluZChzZXNzaW9uKTtcblx0XHQoc2Vzc2lvbiBhcyBhbnkpLl9kaXNjb25uZWN0RnJvbUFnZW50ID0gKCkgPT4ge1xuXHRcdFx0b3JkZXIucHVzaChcIl9kaXNjb25uZWN0RnJvbUFnZW50XCIpO1xuXHRcdFx0b3JpZ2luYWxEaXNjb25uZWN0KCk7XG5cdFx0fTtcblxuXHRcdGNvbnN0IHBlbmRpbmdTd2l0Y2ggPSBzZXNzaW9uLnN3aXRjaFNlc3Npb24ocHJldmlvdXNTZXNzaW9uRmlsZSk7XG5cdFx0YXdhaXQgUHJvbWlzZS5yZXNvbHZlKCk7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChvcmRlciwgW1wid2FpdEZvcklkbGVcIl0pO1xuXHRcdGFzc2VydC5lcXVhbChvcmRlci5pbmNsdWRlcyhcImFib3J0XCIpLCBmYWxzZSk7XG5cdFx0YXNzZXJ0LmVxdWFsKHNlc3Npb24uc2Vzc2lvbkZpbGUsIGFjdGl2ZVNlc3Npb25GaWxlKTtcblx0XHRhc3NlcnQuZGVlcEVxdWFsKHNlc3Npb24ubWVzc2FnZXMsIFtdKTtcblxuXHRcdHJlbGVhc2VJZGxlKCk7XG5cdFx0Y29uc3Qgc3dpdGNoZWQgPSBhd2FpdCBwZW5kaW5nU3dpdGNoO1xuXHRcdGFzc2VydC5lcXVhbChzd2l0Y2hlZCwgdHJ1ZSk7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChvcmRlciwgW1wid2FpdEZvcklkbGVcIiwgXCJfZGlzY29ubmVjdEZyb21BZ2VudFwiXSk7XG5cdFx0YXNzZXJ0LmVxdWFsKG9yZGVyLmluY2x1ZGVzKFwiYWJvcnRcIiksIGZhbHNlKTtcblx0XHRhc3NlcnQuZXF1YWwoc2Vzc2lvbi5zZXNzaW9uRmlsZSwgcHJldmlvdXNTZXNzaW9uRmlsZSk7XG5cblx0XHRjb25zdCByZXN0b3JlZFRleHQgPSBzZXNzaW9uLm1lc3NhZ2VzXG5cdFx0XHQuZmxhdE1hcCgobWVzc2FnZTogYW55KSA9PiBtZXNzYWdlLmNvbnRlbnQgPz8gW10pXG5cdFx0XHQuZmlsdGVyKChwYXJ0OiBhbnkpID0+IHBhcnQudHlwZSA9PT0gXCJ0ZXh0XCIpXG5cdFx0XHQubWFwKChwYXJ0OiBhbnkpID0+IHBhcnQudGV4dCk7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChyZXN0b3JlZFRleHQsIFtcInN3aXRjaCBwZXJzaXN0ZWQgcHJvbXB0XCIsIFwic3dpdGNoIHBlcnNpc3RlZCByZXNwb25zZVwiXSk7XG5cdH0pO1xuXG5cdGl0KFwibmV3U2Vzc2lvbigpIGR1cmluZyBhZ2VudF9lbmQgc2tpcHMgc3RhbGUgcG9zdC1oYW5kbGVycyBhZnRlciB0aGUgdHJhbnNpdGlvbiBzdGFydHNcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IHNlc3Npb24gPSBhd2FpdCBjcmVhdGVTZXNzaW9uKCk7XG5cdFx0Y29uc3QgYXNzaXN0YW50TWVzc2FnZSA9IG1ha2VBc3Npc3RhbnRNZXNzYWdlKFwib2xkIHJlc3BvbnNlXCIpO1xuXHRcdGxldCBjb21wYWN0aW9uQ2hlY2tzID0gMDtcblx0XHRsZXQgbGlzdGVuZXJBZ2VudEVuZHMgPSAwO1xuXG5cdFx0KHNlc3Npb24gYXMgYW55KS5fbGFzdEFzc2lzdGFudE1lc3NhZ2UgPSBhc3Npc3RhbnRNZXNzYWdlO1xuXHRcdChzZXNzaW9uIGFzIGFueSkuX2NvbXBhY3Rpb25PcmNoZXN0cmF0b3IuY2hlY2tDb21wYWN0aW9uID0gYXN5bmMgKCkgPT4ge1xuXHRcdFx0Y29tcGFjdGlvbkNoZWNrcysrO1xuXHRcdH07XG5cdFx0c2Vzc2lvbi5zdWJzY3JpYmUoKGV2ZW50OiBhbnkpID0+IHtcblx0XHRcdGlmIChldmVudC50eXBlID09PSBcImFnZW50X2VuZFwiKSBsaXN0ZW5lckFnZW50RW5kcysrO1xuXHRcdH0pO1xuXHRcdGluc3RhbGxBZ2VudEVuZFNlc3Npb25UcmFuc2l0aW9uKHNlc3Npb24sICgpID0+IHNlc3Npb24ubmV3U2Vzc2lvbigpKTtcblxuXHRcdGF3YWl0IChzZXNzaW9uIGFzIGFueSkuX3Byb2Nlc3NBZ2VudEV2ZW50KHtcblx0XHRcdHR5cGU6IFwiYWdlbnRfZW5kXCIsXG5cdFx0XHRtZXNzYWdlczogW2Fzc2lzdGFudE1lc3NhZ2VdLFxuXHRcdH0pO1xuXG5cdFx0YXNzZXJ0LmVxdWFsKGNvbXBhY3Rpb25DaGVja3MsIDApO1xuXHRcdGFzc2VydC5lcXVhbChsaXN0ZW5lckFnZW50RW5kcywgMCk7XG5cdFx0YXNzZXJ0LmVxdWFsKChzZXNzaW9uIGFzIGFueSkuX2xhc3RBc3Npc3RhbnRNZXNzYWdlLCB1bmRlZmluZWQpO1xuXHRcdGFzc2VydC5lcXVhbCgoc2Vzc2lvbiBhcyBhbnkpLl9zZXNzaW9uU3dpdGNoUGVuZGluZywgZmFsc2UpO1xuXHRcdGFzc2VydC5lcXVhbCgoc2Vzc2lvbiBhcyBhbnkpLl9zZXNzaW9uVHJhbnNpdGlvblN0YXJ0ZWREdXJpbmdBZ2VudEVuZCwgZmFsc2UpO1xuXHR9KTtcblxuXHRpdChcInN3aXRjaFNlc3Npb24oKSBkdXJpbmcgYWdlbnRfZW5kIHNraXBzIHN0YWxlIHBvc3QtaGFuZGxlcnMgYWZ0ZXIgdGhlIHRyYW5zaXRpb24gc3RhcnRzXCIsIGFzeW5jICgpID0+IHtcblx0XHRjb25zdCBzZXNzaW9uID0gYXdhaXQgY3JlYXRlU2Vzc2lvbih7IHBlcnNpc3RTZXNzaW9uczogdHJ1ZSB9KTtcblx0XHRjb25zdCBwcmV2aW91c1Nlc3Npb25GaWxlID0gc2Vzc2lvbi5zZXNzaW9uRmlsZTtcblx0XHRhc3NlcnQub2socHJldmlvdXNTZXNzaW9uRmlsZSwgXCJuZWVkIGEgcGVyc2lzdGVkIHNlc3Npb24gZmlsZVwiKTtcblxuXHRcdGNvbnN0IG9rID0gYXdhaXQgc2Vzc2lvbi5uZXdTZXNzaW9uKCk7XG5cdFx0YXNzZXJ0LmVxdWFsKG9rLCB0cnVlKTtcblx0XHRhc3NlcnQubm90RXF1YWwoc2Vzc2lvbi5zZXNzaW9uRmlsZSwgcHJldmlvdXNTZXNzaW9uRmlsZSk7XG5cblx0XHRjb25zdCBhc3Npc3RhbnRNZXNzYWdlID0gbWFrZUFzc2lzdGFudE1lc3NhZ2UoXCJvbGQgc3dpdGNoIHJlc3BvbnNlXCIpO1xuXHRcdGxldCBjb21wYWN0aW9uQ2hlY2tzID0gMDtcblx0XHRsZXQgbGlzdGVuZXJBZ2VudEVuZHMgPSAwO1xuXG5cdFx0KHNlc3Npb24gYXMgYW55KS5fbGFzdEFzc2lzdGFudE1lc3NhZ2UgPSBhc3Npc3RhbnRNZXNzYWdlO1xuXHRcdChzZXNzaW9uIGFzIGFueSkuX2NvbXBhY3Rpb25PcmNoZXN0cmF0b3IuY2hlY2tDb21wYWN0aW9uID0gYXN5bmMgKCkgPT4ge1xuXHRcdFx0Y29tcGFjdGlvbkNoZWNrcysrO1xuXHRcdH07XG5cdFx0c2Vzc2lvbi5zdWJzY3JpYmUoKGV2ZW50OiBhbnkpID0+IHtcblx0XHRcdGlmIChldmVudC50eXBlID09PSBcImFnZW50X2VuZFwiKSBsaXN0ZW5lckFnZW50RW5kcysrO1xuXHRcdH0pO1xuXHRcdGluc3RhbGxBZ2VudEVuZFNlc3Npb25UcmFuc2l0aW9uKHNlc3Npb24sICgpID0+IHNlc3Npb24uc3dpdGNoU2Vzc2lvbihwcmV2aW91c1Nlc3Npb25GaWxlKSk7XG5cblx0XHRhd2FpdCAoc2Vzc2lvbiBhcyBhbnkpLl9wcm9jZXNzQWdlbnRFdmVudCh7XG5cdFx0XHR0eXBlOiBcImFnZW50X2VuZFwiLFxuXHRcdFx0bWVzc2FnZXM6IFthc3Npc3RhbnRNZXNzYWdlXSxcblx0XHR9KTtcblxuXHRcdGFzc2VydC5lcXVhbChzZXNzaW9uLnNlc3Npb25GaWxlLCBwcmV2aW91c1Nlc3Npb25GaWxlKTtcblx0XHRhc3NlcnQuZXF1YWwoY29tcGFjdGlvbkNoZWNrcywgMCk7XG5cdFx0YXNzZXJ0LmVxdWFsKGxpc3RlbmVyQWdlbnRFbmRzLCAwKTtcblx0XHRhc3NlcnQuZXF1YWwoKHNlc3Npb24gYXMgYW55KS5fbGFzdEFzc2lzdGFudE1lc3NhZ2UsIHVuZGVmaW5lZCk7XG5cdFx0YXNzZXJ0LmVxdWFsKChzZXNzaW9uIGFzIGFueSkuX3Nlc3Npb25Td2l0Y2hQZW5kaW5nLCBmYWxzZSk7XG5cdFx0YXNzZXJ0LmVxdWFsKChzZXNzaW9uIGFzIGFueSkuX3Nlc3Npb25UcmFuc2l0aW9uU3RhcnRlZER1cmluZ0FnZW50RW5kLCBmYWxzZSk7XG5cdH0pO1xuXG5cdGl0KFwiYWdlbnRfZW5kIHBvc3QtaGFuZGxlcnMgYmFpbCB3aGlsZSBhIHNlc3Npb24gc3dpdGNoIGlzIHBlbmRpbmdcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IHNlc3Npb24gPSBhd2FpdCBjcmVhdGVTZXNzaW9uKCk7XG5cdFx0Y29uc3QgYXNzaXN0YW50TWVzc2FnZSA9IG1ha2VBc3Npc3RhbnRNZXNzYWdlKFwib2xkIHBlbmRpbmcgcmVzcG9uc2VcIik7XG5cdFx0bGV0IGNvbXBhY3Rpb25DaGVja3MgPSAwO1xuXHRcdGxldCBsaXN0ZW5lckFnZW50RW5kcyA9IDA7XG5cblx0XHQoc2Vzc2lvbiBhcyBhbnkpLl9sYXN0QXNzaXN0YW50TWVzc2FnZSA9IGFzc2lzdGFudE1lc3NhZ2U7XG5cdFx0KHNlc3Npb24gYXMgYW55KS5fc2Vzc2lvblN3aXRjaFBlbmRpbmcgPSB0cnVlO1xuXHRcdChzZXNzaW9uIGFzIGFueSkuX2NvbXBhY3Rpb25PcmNoZXN0cmF0b3IuY2hlY2tDb21wYWN0aW9uID0gYXN5bmMgKCkgPT4ge1xuXHRcdFx0Y29tcGFjdGlvbkNoZWNrcysrO1xuXHRcdH07XG5cdFx0c2Vzc2lvbi5zdWJzY3JpYmUoKGV2ZW50OiBhbnkpID0+IHtcblx0XHRcdGlmIChldmVudC50eXBlID09PSBcImFnZW50X2VuZFwiKSBsaXN0ZW5lckFnZW50RW5kcysrO1xuXHRcdH0pO1xuXG5cdFx0YXdhaXQgKHNlc3Npb24gYXMgYW55KS5fcHJvY2Vzc0FnZW50RXZlbnQoe1xuXHRcdFx0dHlwZTogXCJhZ2VudF9lbmRcIixcblx0XHRcdG1lc3NhZ2VzOiBbYXNzaXN0YW50TWVzc2FnZV0sXG5cdFx0fSk7XG5cblx0XHRhc3NlcnQuZXF1YWwoY29tcGFjdGlvbkNoZWNrcywgMCk7XG5cdFx0YXNzZXJ0LmVxdWFsKGxpc3RlbmVyQWdlbnRFbmRzLCAxKTtcblx0XHRhc3NlcnQuZXF1YWwoKHNlc3Npb24gYXMgYW55KS5fbGFzdEFzc2lzdGFudE1lc3NhZ2UsIHVuZGVmaW5lZCk7XG5cdH0pO1xuXG5cdGl0KFwic3dpdGNoU2Vzc2lvbigpIGludm9rZXMgYWJvcnQoKSBiZWZvcmUgX2Rpc2Nvbm5lY3RGcm9tQWdlbnQoKVwiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3Qgc2Vzc2lvbiA9IGF3YWl0IGNyZWF0ZVNlc3Npb24oeyBwZXJzaXN0U2Vzc2lvbnM6IHRydWUgfSk7XG5cdFx0Ly8gU2VlZCBhIHNlc3Npb24gZmlsZSB0byBzd2l0Y2ggdG8gKHN3aXRjaFNlc3Npb24gcmVhZHMgZnJvbSB0aGUgc2Vzc2lvbiBtYW5hZ2VyKS5cblx0XHRhd2FpdCBzZXNzaW9uLm5ld1Nlc3Npb24oKTtcblx0XHRjb25zdCBzZXNzaW9uRmlsZSA9IHNlc3Npb24uc2Vzc2lvbkZpbGU7XG5cdFx0YXNzZXJ0Lm9rKHR5cGVvZiBzZXNzaW9uRmlsZSA9PT0gXCJzdHJpbmdcIiAmJiBzZXNzaW9uRmlsZS5sZW5ndGggPiAwLCBcIm5lZWQgYSBzZXNzaW9uIGZpbGUgdG8gc3dpdGNoIHRvXCIpO1xuXG5cdFx0KHNlc3Npb24gYXMgYW55KS5hZ2VudC5zdGF0ZS5pc1N0cmVhbWluZyA9IHRydWU7XG5cdFx0Y29uc3Qgb3JkZXIgPSByZWNvcmRDYWxsT3JkZXIoc2Vzc2lvbiBhcyBhbnksIFtcImFib3J0XCIsIFwiX2Rpc2Nvbm5lY3RGcm9tQWdlbnRcIl0pO1xuXG5cdFx0Y29uc3Qgb2sgPSBhd2FpdCBzZXNzaW9uLnN3aXRjaFNlc3Npb24oc2Vzc2lvbkZpbGUpO1xuXHRcdGFzc2VydC5lcXVhbChvaywgdHJ1ZSk7XG5cblx0XHRjb25zdCBhYm9ydElkeCA9IG9yZGVyLmluZGV4T2YoXCJhYm9ydFwiKTtcblx0XHRjb25zdCBkaXNjb25uZWN0SWR4ID0gb3JkZXIuaW5kZXhPZihcIl9kaXNjb25uZWN0RnJvbUFnZW50XCIpO1xuXHRcdGFzc2VydC5vayhhYm9ydElkeCA+PSAwLCBgc3dpdGNoU2Vzc2lvbiBzaG91bGQgY2FsbCBhYm9ydCgpOyBvcmRlcj0ke29yZGVyLmpvaW4oXCIsXCIpfWApO1xuXHRcdGFzc2VydC5vayhcblx0XHRcdGRpc2Nvbm5lY3RJZHggPj0gMCxcblx0XHRcdGBzd2l0Y2hTZXNzaW9uIHNob3VsZCBjYWxsIF9kaXNjb25uZWN0RnJvbUFnZW50KCk7IG9yZGVyPSR7b3JkZXIuam9pbihcIixcIil9YCxcblx0XHQpO1xuXHRcdGFzc2VydC5vayhcblx0XHRcdGFib3J0SWR4IDwgZGlzY29ubmVjdElkeCxcblx0XHRcdGBhYm9ydCgpIG11c3QgcnVuIGJlZm9yZSBfZGlzY29ubmVjdEZyb21BZ2VudCgpIGluIHN3aXRjaFNlc3Npb247IG9yZGVyPSR7b3JkZXIuam9pbihcIixcIil9YCxcblx0XHQpO1xuXHR9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBU0EsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxjQUFjO0FBQ3BDLFNBQVMsY0FBYztBQUN2QixTQUFTLFlBQVk7QUFDckIsU0FBUyxXQUFXLFlBQVksVUFBVSxVQUFVO0FBRXBELFNBQVMsYUFBYTtBQUN0QixTQUFTLG9CQUFvQjtBQUM3QixTQUFTLG1CQUFtQjtBQUM1QixTQUFTLHFCQUFxQjtBQUM5QixTQUFTLDZCQUE2QjtBQUN0QyxTQUFTLHNCQUFzQjtBQUMvQixTQUFTLHVCQUF1QjtBQUVoQyxJQUFJO0FBRUosZUFBZSxjQUFjLE9BQXNDLENBQUMsR0FBMEI7QUFDN0YsUUFBTSxXQUFXLEtBQUssU0FBUyxZQUFZO0FBQzNDLFFBQU0sY0FBYyxZQUFZLFNBQVMsQ0FBQyxDQUFDO0FBQzNDLFFBQU0sZ0JBQWdCLElBQUksY0FB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
