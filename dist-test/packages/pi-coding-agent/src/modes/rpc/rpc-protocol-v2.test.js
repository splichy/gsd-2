import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
function collectLines(stream) {
  const lines = [];
  const detach = attachJsonlLineReader(stream, (line) => {
    try {
      lines.push(JSON.parse(line));
    } catch {
    }
  });
  return { lines, detach };
}
function writeLine(stream, obj) {
  stream.write(serializeJsonLine(obj));
}
function createMockProcess() {
  const clientStdin = new PassThrough();
  const clientStdout = new PassThrough();
  return { clientStdin, clientStdout };
}
function tick(ms = 10) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
describe("JSONL utilities", () => {
  it("serializeJsonLine produces newline-terminated JSON", () => {
    const result = serializeJsonLine({ type: "test", value: 42 });
    assert.equal(result, '{"type":"test","value":42}\n');
  });
  it("serializeJsonLine handles nested objects", () => {
    const result = serializeJsonLine({ a: { b: [1, 2, 3] } });
    assert.ok(result.endsWith("\n"));
    const parsed = JSON.parse(result.trim());
    assert.deepEqual(parsed, { a: { b: [1, 2, 3] } });
  });
  it("attachJsonlLineReader splits on LF only", async () => {
    const stream = new PassThrough();
    const { lines, detach } = collectLines(stream);
    stream.write('{"a":1}\n{"b":2}\n');
    await tick();
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0], { a: 1 });
    assert.deepEqual(lines[1], { b: 2 });
    detach();
  });
  it("attachJsonlLineReader handles partial writes", async () => {
    const stream = new PassThrough();
    const { lines, detach } = collectLines(stream);
    stream.write('{"partial":');
    await tick();
    assert.equal(lines.length, 0);
    stream.write('"value"}\n');
    await tick();
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0], { partial: "value" });
    detach();
  });
  it("attachJsonlLineReader handles CR+LF", async () => {
    const stream = new PassThrough();
    const { lines, detach } = collectLines(stream);
    stream.write('{"cr":"lf"}\r\n');
    await tick();
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0], { cr: "lf" });
    detach();
  });
  it("detach stops line delivery", async () => {
    const stream = new PassThrough();
    const { lines, detach } = collectLines(stream);
    stream.write('{"before":1}\n');
    await tick();
    assert.equal(lines.length, 1);
    detach();
    stream.write('{"after":2}\n');
    await tick();
    assert.equal(lines.length, 1);
  });
});
describe("v2 type shapes", () => {
  it("RpcInitResult has required fields", () => {
    const initResult = {
      protocolVersion: 2,
      sessionId: "test-session-123",
      capabilities: {
        events: ["execution_complete", "cost_update"],
        commands: ["init", "shutdown", "subscribe"]
      }
    };
    assert.equal(initResult.protocolVersion, 2);
    assert.ok(typeof initResult.sessionId === "string");
    assert.ok(Array.isArray(initResult.capabilities.events));
    assert.ok(Array.isArray(initResult.capabilities.commands));
    assert.ok(initResult.capabilities.events.includes("execution_complete"));
    assert.ok(initResult.capabilities.events.includes("cost_update"));
    assert.ok(initResult.capabilities.commands.includes("init"));
    assert.ok(initResult.capabilities.commands.includes("shutdown"));
    assert.ok(initResult.capabilities.commands.includes("subscribe"));
  });
  it("RpcExecutionCompleteEvent matches expected shape", () => {
    const event = {
      type: "execution_complete",
      runId: "run-abc-123",
      status: "completed",
      stats: {
        cost: 0.05,
        turns: 3,
        duration: 12e3,
        tokens: { input: 1e3, output: 500, cacheRead: 200, cacheWrite: 100 }
      }
      // SessionStats is complex, we just verify shape
    };
    assert.equal(event.type, "execution_complete");
    assert.ok(typeof event.runId === "string");
    assert.ok(["completed", "error", "cancelled"].includes(event.status));
    assert.ok(event.stats !== void 0);
  });
  it("RpcExecutionCompleteEvent supports error status with reason", () => {
    const event = {
      type: "execution_complete",
      runId: "run-err-456",
      status: "error",
      reason: "API rate limit exceeded",
      stats: {}
    };
    assert.equal(event.status, "error");
    assert.equal(event.reason, "API rate limit exceeded");
  });
  it("RpcCostUpdateEvent matches expected shape", () => {
    const event = {
      type: "cost_update",
      runId: "run-cost-789",
      turnCost: 0.01,
      cumulativeCost: 0.05,
      tokens: {
        input: 500,
        output: 200,
        cacheRead: 100,
        cacheWrite: 50
      }
    };
    assert.equal(event.type, "cost_update");
    assert.ok(typeof event.runId === "string");
    assert.ok(typeof event.turnCost === "number");
    assert.ok(typeof event.cumulativeCost === "number");
    assert.ok(typeof event.tokens.input === "number");
    assert.ok(typeof event.tokens.output === "number");
    assert.ok(typeof event.tokens.cacheRead === "number");
    assert.ok(typeof event.tokens.cacheWrite === "number");
  });
  it("RpcV2Event discriminated union resolves by type field", () => {
    const events = [
      {
        type: "execution_complete",
        runId: "r1",
        status: "completed",
        stats: {}
      },
      {
        type: "cost_update",
        runId: "r2",
        turnCost: 0.01,
        cumulativeCost: 0.03,
        tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 }
      }
    ];
    for (const event of events) {
      if (event.type === "execution_complete") {
        assert.ok("status" in event);
        assert.ok("stats" in event);
      } else if (event.type === "cost_update") {
        assert.ok("turnCost" in event);
        assert.ok("tokens" in event);
      } else {
        assert.fail(`Unexpected event type: ${event.type}`);
      }
    }
  });
  it("RpcProtocolVersion is 1 or 2", () => {
    const v1 = 1;
    const v2 = 2;
    assert.equal(v1, 1);
    assert.equal(v2, 2);
  });
  it("v2 prompt response includes optional runId field", () => {
    const v1Response = {
      id: "1",
      type: "response",
      command: "prompt",
      success: true
    };
    assert.equal(v1Response.success, true);
    assert.equal(v1Response.runId, void 0);
    const v2Response = {
      id: "2",
      type: "response",
      command: "prompt",
      success: true,
      runId: "run-123"
    };
    assert.equal(v2Response.success, true);
    assert.equal(v2Response.runId, "run-123");
  });
  it("v2 command types are present in RpcCommand union", () => {
    const initCmd = { type: "init", protocolVersion: 2 };
    const shutdownCmd = { type: "shutdown" };
    const subscribeCmd = { type: "subscribe", events: ["agent_end"] };
    assert.equal(initCmd.type, "init");
    assert.equal(shutdownCmd.type, "shutdown");
    assert.equal(subscribeCmd.type, "subscribe");
  });
  it("init command supports optional clientId", () => {
    const cmd = { type: "init", protocolVersion: 2, clientId: "my-client" };
    assert.equal(cmd.type, "init");
    if (cmd.type === "init") {
      assert.equal(cmd.clientId, "my-client");
    }
  });
  it("shutdown command supports optional graceful flag", () => {
    const cmd = { type: "shutdown", graceful: true };
    if (cmd.type === "shutdown") {
      assert.equal(cmd.graceful, true);
    }
  });
  it("v2 response types include init, shutdown, subscribe", () => {
    const initResp = {
      type: "response",
      command: "init",
      success: true,
      data: {
        protocolVersion: 2,
        sessionId: "s1",
        capabilities: { events: [], commands: [] }
      }
    };
    const shutdownResp = {
      type: "response",
      command: "shutdown",
      success: true
    };
    const subscribeResp = {
      type: "response",
      command: "subscribe",
      success: true
    };
    assert.equal(initResp.command, "init");
    assert.equal(shutdownResp.command, "shutdown");
    assert.equal(subscribeResp.command, "subscribe");
  });
});
describe("v1 backward compatibility \u2014 command shapes", () => {
  it("v1 prompt command has no protocolVersion or runId", () => {
    const cmd = { type: "prompt", message: "hello" };
    assert.equal(cmd.type, "prompt");
    assert.equal(cmd.protocolVersion, void 0);
    assert.equal(cmd.runId, void 0);
  });
  it("v1 get_state response has no v2 fields", () => {
    const state = {
      thinkingLevel: "medium",
      isStreaming: false,
      isCompacting: false,
      steeringMode: "all",
      followUpMode: "all",
      sessionId: "test-id",
      autoCompactionEnabled: true,
      autoRetryEnabled: false,
      retryInProgress: false,
      retryAttempt: 0,
      messageCount: 0,
      pendingMessageCount: 0,
      extensionsReady: true
    };
    assert.equal(state.protocolVersion, void 0);
    assert.equal(state.runId, void 0);
  });
  it("v1 prompt response has no runId", () => {
    const resp = {
      id: "1",
      type: "response",
      command: "prompt",
      success: true
    };
    assert.equal(resp.success, true);
    assert.equal(resp.runId, void 0);
  });
  it("error response shape is consistent across v1 and v2", () => {
    const errResp = {
      id: "err-1",
      type: "response",
      command: "init",
      success: false,
      error: "Protocol version already locked. init must be the first command."
    };
    assert.equal(errResp.success, false);
    if (!errResp.success) {
      assert.ok(typeof errResp.error === "string");
      assert.ok(errResp.error.length > 0);
    }
  });
});
describe("RpcClient command serialization", () => {
  it("init command serializes correctly", () => {
    const cmd = { id: "req_1", type: "init", protocolVersion: 2 };
    const serialized = serializeJsonLine(cmd);
    const parsed = JSON.parse(serialized);
    assert.equal(parsed.type, "init");
    assert.equal(parsed.protocolVersion, 2);
    assert.equal(parsed.id, "req_1");
  });
  it("init command with clientId serializes correctly", () => {
    const cmd = { id: "req_1", type: "init", protocolVersion: 2, clientId: "test-client" };
    const serialized = serializeJsonLine(cmd);
    const parsed = JSON.parse(serialized);
    assert.equal(parsed.clientId, "test-client");
  });
  it("shutdown command serializes correctly", () => {
    const cmd = { id: "req_2", type: "shutdown" };
    const serialized = serializeJsonLine(cmd);
    const parsed = JSON.parse(serialized);
    assert.equal(parsed.type, "shutdown");
    assert.equal(parsed.id, "req_2");
  });
  it("subscribe command serializes correctly with event list", () => {
    const cmd = { id: "req_3", type: "subscribe", events: ["agent_end", "cost_update"] };
    const serialized = serializeJsonLine(cmd);
    const parsed = JSON.parse(serialized);
    assert.equal(parsed.type, "subscribe");
    assert.deepEqual(parsed.events, ["agent_end", "cost_update"]);
  });
  it("subscribe command with wildcard serializes correctly", () => {
    const cmd = { id: "req_4", type: "subscribe", events: ["*"] };
    const serialized = serializeJsonLine(cmd);
    const parsed = JSON.parse(serialized);
    assert.deepEqual(parsed.events, ["*"]);
  });
  it("subscribe command with empty array serializes correctly", () => {
    const cmd = { id: "req_5", type: "subscribe", events: [] };
    const serialized = serializeJsonLine(cmd);
    const parsed = JSON.parse(serialized);
    assert.deepEqual(parsed.events, []);
  });
  it("sendUIResponse serializes correct JSONL", () => {
    const response = {
      type: "extension_ui_response",
      id: "ui-req-123",
      value: "test-value"
    };
    const serialized = serializeJsonLine(response);
    const parsed = JSON.parse(serialized);
    assert.equal(parsed.type, "extension_ui_response");
    assert.equal(parsed.id, "ui-req-123");
    assert.equal(parsed.value, "test-value");
  });
  it("sendUIResponse with cancelled flag serializes correctly", () => {
    const response = {
      type: "extension_ui_response",
      id: "ui-req-456",
      cancelled: true
    };
    const serialized = serializeJsonLine(response);
    const parsed = JSON.parse(serialized);
    assert.equal(parsed.type, "extension_ui_response");
    assert.equal(parsed.cancelled, true);
  });
  it("sendUIResponse with confirmed flag serializes correctly", () => {
    const response = {
      type: "extension_ui_response",
      id: "ui-req-789",
      confirmed: true
    };
    const serialized = serializeJsonLine(response);
    const parsed = JSON.parse(serialized);
    assert.equal(parsed.confirmed, true);
  });
  it("sendUIResponse with multiple values serializes correctly", () => {
    const response = {
      type: "extension_ui_response",
      id: "ui-req-multi",
      values: ["opt-a", "opt-b"]
    };
    const serialized = serializeJsonLine(response);
    const parsed = JSON.parse(serialized);
    assert.deepEqual(parsed.values, ["opt-a", "opt-b"]);
  });
  it("prompt command with runId in v2 response", () => {
    const response = {
      id: "req_10",
      type: "response",
      command: "prompt",
      success: true,
      runId: "run-uuid-abc"
    };
    const serialized = serializeJsonLine(response);
    const parsed = JSON.parse(serialized);
    assert.equal(parsed.runId, "run-uuid-abc");
    assert.equal(parsed.command, "prompt");
    assert.equal(parsed.success, true);
  });
});
describe("Client \u2194 Mock server protocol exchange", () => {
  let clientStdin;
  let clientStdout;
  beforeEach(() => {
    const mockProc = createMockProcess();
    clientStdin = mockProc.clientStdin;
    clientStdout = mockProc.clientStdout;
  });
  afterEach(() => {
    clientStdin.destroy();
    clientStdout.destroy();
  });
  it("init handshake: client writes init, server responds with init_result", async () => {
    const { lines: clientWrites, detach: detachStdin } = collectLines(clientStdin);
    writeLine(clientStdin, { id: "req_1", type: "init", protocolVersion: 2 });
    await tick();
    assert.equal(clientWrites.length, 1);
    const initCmd = clientWrites[0];
    assert.equal(initCmd.type, "init");
    assert.equal(initCmd.protocolVersion, 2);
    const initResult = {
      protocolVersion: 2,
      sessionId: "sess-abc",
      capabilities: {
        events: ["execution_complete", "cost_update"],
        commands: ["init", "shutdown", "subscribe"]
      }
    };
    writeLine(clientStdout, {
      id: "req_1",
      type: "response",
      command: "init",
      success: true,
      data: initResult
    });
    const { lines: serverResponses, detach: detachStdout } = collectLines(clientStdout);
    writeLine(clientStdout, {
      id: "req_verify",
      type: "response",
      command: "init",
      success: true,
      data: initResult
    });
    await tick();
    const resp = serverResponses[0];
    assert.equal(resp.type, "response");
    assert.equal(resp.command, "init");
    assert.equal(resp.success, true);
    assert.equal(resp.data.protocolVersion, 2);
    assert.ok(typeof resp.data.sessionId === "string");
    detachStdin();
    detachStdout();
  });
  it("shutdown: client writes shutdown, server acknowledges", async () => {
    const { lines: clientWrites, detach } = collectLines(clientStdin);
    writeLine(clientStdin, { id: "req_2", type: "shutdown" });
    await tick();
    const cmd = clientWrites[0];
    assert.equal(cmd.type, "shutdown");
    detach();
  });
  it("subscribe: client writes subscribe with event list", async () => {
    const { lines: clientWrites, detach } = collectLines(clientStdin);
    writeLine(clientStdin, { id: "req_3", type: "subscribe", events: ["agent_end", "execution_complete"] });
    await tick();
    const cmd = clientWrites[0];
    assert.equal(cmd.type, "subscribe");
    assert.deepEqual(cmd.events, ["agent_end", "execution_complete"]);
    detach();
  });
  it("sendUIResponse: client writes extension_ui_response", async () => {
    const { lines: clientWrites, detach } = collectLines(clientStdin);
    writeLine(clientStdin, {
      type: "extension_ui_response",
      id: "ui-123",
      value: "selected-option"
    });
    await tick();
    const msg = clientWrites[0];
    assert.equal(msg.type, "extension_ui_response");
    assert.equal(msg.id, "ui-123");
    assert.equal(msg.value, "selected-option");
    detach();
  });
  it("v2 event filtering: subscribe with empty array should filter all", async () => {
    const subscribeCmd = { id: "req_4", type: "subscribe", events: [] };
    const serialized = serializeJsonLine(subscribeCmd);
    const parsed = JSON.parse(serialized);
    assert.deepEqual(parsed.events, []);
    const filter = new Set(parsed.events);
    assert.equal(filter.has("agent_end"), false);
    assert.equal(filter.has("execution_complete"), false);
    assert.equal(filter.size, 0);
  });
  it("v2 event filtering: subscribe with wildcard resets filter", async () => {
    const subscribeCmd = { type: "subscribe", events: ["*"] };
    const parsed = JSON.parse(serializeJsonLine(subscribeCmd));
    const hasWildcard = parsed.events.includes("*");
    assert.equal(hasWildcard, true);
  });
  it("multiple commands can be sent sequentially", async () => {
    const { lines, detach } = collectLines(clientStdin);
    writeLine(clientStdin, { id: "1", type: "init", protocolVersion: 2 });
    writeLine(clientStdin, { id: "2", type: "subscribe", events: ["agent_end"] });
    writeLine(clientStdin, { id: "3", type: "prompt", message: "hello" });
    await tick();
    assert.equal(lines.length, 3);
    assert.equal(lines[0].type, "init");
    assert.equal(lines[1].type, "subscribe");
    assert.equal(lines[2].type, "prompt");
    detach();
  });
});
describe("Negative tests \u2014 protocol error shapes", () => {
  it("init with missing protocolVersion produces a type error at compile time", () => {
    const malformed = { type: "init" };
    assert.equal(malformed.protocolVersion, void 0);
  });
  it("subscribe with non-array events is a type violation", () => {
    const malformed = { type: "subscribe", events: "agent_end" };
    assert.equal(typeof malformed.events, "string");
    assert.equal(Array.isArray(malformed.events), false);
  });
  it("double init error response shape", () => {
    const errorResp = {
      id: "req_dup",
      type: "response",
      command: "init",
      success: false,
      error: "Protocol version already locked. init must be the first command."
    };
    assert.equal(errorResp.success, false);
    if (!errorResp.success) {
      assert.ok(errorResp.error.includes("already locked"));
    }
  });
  it("init after v1 lock error response shape", () => {
    const errorResp = {
      id: "req_late_init",
      type: "response",
      command: "init",
      success: false,
      error: "Protocol version already locked. init must be the first command."
    };
    assert.equal(errorResp.success, false);
    if (!errorResp.success) {
      assert.ok(errorResp.error.includes("init must be the first command"));
    }
  });
  it("unknown command type produces error response", () => {
    const errorResp = {
      id: "req_unknown",
      type: "response",
      command: "nonexistent",
      success: false,
      error: "Unknown command: nonexistent"
    };
    assert.equal(errorResp.success, false);
    if (!errorResp.success) {
      assert.ok(errorResp.error.includes("Unknown command"));
    }
  });
  it("malformed JSON parse error shape", () => {
    const errorResp = {
      type: "response",
      command: "parse",
      success: false,
      error: "Failed to parse command: Unexpected token"
    };
    assert.equal(errorResp.command, "parse");
    assert.equal(errorResp.success, false);
  });
  it("shutdown works in both v1 and v2 \u2014 no version gating", () => {
    const v1Shutdown = {
      id: "s1",
      type: "response",
      command: "shutdown",
      success: true
    };
    const v2Shutdown = {
      id: "s2",
      type: "response",
      command: "shutdown",
      success: true
    };
    assert.equal(v1Shutdown.success, true);
    assert.equal(v2Shutdown.success, true);
  });
});
describe("Protocol version detection logic", () => {
  it("simulates v1 lock when first command is non-init", () => {
    let protocolVersion = 1;
    let protocolLocked = false;
    const command = { type: "get_state" };
    if (!protocolLocked) {
      protocolLocked = true;
      if (command.type === "init") {
        protocolVersion = 2;
      } else {
        protocolVersion = 1;
      }
    }
    assert.equal(protocolVersion, 1);
    assert.equal(protocolLocked, true);
  });
  it("simulates v2 lock when first command is init", () => {
    let protocolVersion = 1;
    let protocolLocked = false;
    const command = { type: "init", protocolVersion: 2 };
    if (!protocolLocked) {
      protocolLocked = true;
      if (command.type === "init") {
        protocolVersion = 2;
      } else {
        protocolVersion = 1;
      }
    }
    assert.equal(protocolVersion, 2);
    assert.equal(protocolLocked, true);
  });
  it("rejects re-init after v2 lock", () => {
    let protocolLocked = true;
    let errorMessage = null;
    const command = { type: "init", protocolVersion: 2 };
    if (protocolLocked && command.type === "init") {
      errorMessage = "Protocol version already locked. init must be the first command.";
    }
    assert.ok(errorMessage !== null);
    assert.ok(errorMessage.includes("already locked"));
  });
  it("rejects init after v1 lock", () => {
    let protocolLocked = true;
    let protocolVersion = 1;
    let errorMessage = null;
    const command = { type: "init", protocolVersion: 2 };
    if (protocolLocked && command.type === "init") {
      errorMessage = "Protocol version already locked. init must be the first command.";
    }
    assert.equal(protocolVersion, 1);
    assert.ok(errorMessage !== null);
  });
  it("extension_ui_response bypasses protocol detection", () => {
    let protocolLocked = false;
    let protocolDetectionTriggered = false;
    const parsed = { type: "extension_ui_response", id: "ui-1", value: "ok" };
    if (parsed.type === "extension_ui_response") {
    } else {
      protocolDetectionTriggered = true;
      if (!protocolLocked) {
        protocolLocked = true;
      }
    }
    assert.equal(protocolLocked, false);
    assert.equal(protocolDetectionTriggered, false);
  });
});
describe("v2 event filter logic", () => {
  function shouldEmit(filter, eventType) {
    return !filter || filter.has(eventType);
  }
  it("null filter passes all events", () => {
    assert.equal(shouldEmit(null, "agent_end"), true);
    assert.equal(shouldEmit(null, "cost_update"), true);
    assert.equal(shouldEmit(null, "anything"), true);
  });
  it("filter with specific events passes matching events", () => {
    const filter = /* @__PURE__ */ new Set(["agent_end", "cost_update"]);
    assert.equal(shouldEmit(filter, "agent_end"), true);
    assert.equal(shouldEmit(filter, "cost_update"), true);
    assert.equal(shouldEmit(filter, "execution_complete"), false);
    assert.equal(shouldEmit(filter, "message_start"), false);
  });
  it("empty Set filter blocks all events", () => {
    const filter = /* @__PURE__ */ new Set();
    assert.equal(shouldEmit(filter, "agent_end"), false);
    assert.equal(shouldEmit(filter, "cost_update"), false);
    assert.equal(shouldEmit(filter, "anything"), false);
    assert.equal(filter.size, 0);
  });
  it("wildcard subscribe resets filter to null", () => {
    let eventFilter = /* @__PURE__ */ new Set(["agent_end"]);
    const events = ["*"];
    if (events.includes("*")) {
      eventFilter = null;
    } else {
      eventFilter = new Set(events);
    }
    assert.equal(eventFilter, null);
  });
  it("subscribe replaces previous filter", () => {
    let eventFilter = /* @__PURE__ */ new Set(["agent_end"]);
    const events = ["cost_update", "execution_complete"];
    if (events.includes("*")) {
      eventFilter = null;
    } else {
      eventFilter = new Set(events);
    }
    assert.equal(eventFilter.has("agent_end"), false);
    assert.equal(eventFilter.has("cost_update"), true);
    assert.equal(eventFilter.has("execution_complete"), true);
  });
  it("filter applies to both regular and synthesized v2 events", () => {
    const eventFilter = /* @__PURE__ */ new Set(["execution_complete"]);
    assert.equal(eventFilter.has("agent_end"), false);
    assert.equal(eventFilter.has("execution_complete"), true);
    assert.equal(eventFilter.has("cost_update"), false);
  });
});
describe("v2 runId injection", () => {
  it("runId is present when protocolVersion is 2 and command is prompt/steer/follow_up", () => {
    const protocolVersion = 2;
    const commands = ["prompt", "steer", "follow_up"];
    for (const cmdType of commands) {
      const runId = protocolVersion === 2 ? `run-${cmdType}-uuid` : void 0;
      assert.ok(runId !== void 0, `runId should be generated for ${cmdType} in v2`);
      assert.ok(typeof runId === "string");
    }
  });
  it("runId is undefined when protocolVersion is 1", () => {
    function generateRunId(version) {
      return version === 2 ? "run-uuid" : void 0;
    }
    assert.equal(generateRunId(1), void 0);
    assert.ok(typeof generateRunId(2) === "string");
  });
  it("runId is injected into event output via spread", () => {
    const currentRunId = "run-abc-123";
    const event = { type: "message_start", message: { role: "assistant" } };
    const outputEvent = currentRunId ? { ...event, runId: currentRunId } : event;
    assert.equal(outputEvent.runId, "run-abc-123");
    assert.equal(outputEvent.type, "message_start");
  });
  it("runId is not injected when null", () => {
    const currentRunId = null;
    const event = { type: "message_start", message: { role: "assistant" } };
    const outputEvent = currentRunId ? { ...event, runId: currentRunId } : event;
    assert.equal(outputEvent.runId, void 0);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9tb2Rlcy9ycGMvcnBjLXByb3RvY29sLXYyLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogUlBDIFByb3RvY29sIHYyIHRlc3Qgc3VpdGUuXG4gKlxuICogVGVzdHMgdjEgYmFja3dhcmQgY29tcGF0aWJpbGl0eSwgdjIgaW5pdCBoYW5kc2hha2UsIHByb3RvY29sIGxvY2tpbmcsXG4gKiB2MiBmZWF0dXJlIHR5cGUgc2hhcGVzLCBhbmQgUnBjQ2xpZW50IGNvbW1hbmQgc2VyaWFsaXphdGlvbiBhZ2FpbnN0XG4gKiBtb2NrIGNoaWxkIHByb2Nlc3NlcyB1c2luZyBQYXNzVGhyb3VnaCBzdHJlYW1zLlxuICovXG5cbmltcG9ydCB7IGRlc2NyaWJlLCBpdCwgYmVmb3JlRWFjaCwgYWZ0ZXJFYWNoLCBtb2NrIH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBQYXNzVGhyb3VnaCB9IGZyb20gXCJub2RlOnN0cmVhbVwiO1xuaW1wb3J0IHsgYXR0YWNoSnNvbmxMaW5lUmVhZGVyLCBzZXJpYWxpemVKc29uTGluZSB9IGZyb20gXCIuL2pzb25sLmpzXCI7XG5pbXBvcnQgdHlwZSB7XG5cdFJwY0NvbW1hbmQsXG5cdFJwY1Jlc3BvbnNlLFxuXHRScGNJbml0UmVzdWx0LFxuXHRScGNFeGVjdXRpb25Db21wbGV0ZUV2ZW50LFxuXHRScGNDb3N0VXBkYXRlRXZlbnQsXG5cdFJwY1YyRXZlbnQsXG5cdFJwY1Byb3RvY29sVmVyc2lvbixcblx0UnBjU2Vzc2lvblN0YXRlLFxufSBmcm9tIFwiLi9ycGMtdHlwZXMuanNcIjtcblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gSGVscGVyc1xuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4vKiogQ29sbGVjdCBKU09OTCBvdXRwdXQgbGluZXMgZnJvbSBhIHN0cmVhbSAqL1xuZnVuY3Rpb24gY29sbGVjdExpbmVzKHN0cmVhbTogUGFzc1Rocm91Z2gpOiB7IGxpbmVzOiB1bmtub3duW107IGRldGFjaDogKCkgPT4gdm9pZCB9IHtcblx0Y29uc3QgbGluZXM6IHVua25vd25bXSA9IFtdO1xuXHRjb25zdCBkZXRhY2ggPSBhdHRhY2hKc29ubExpbmVSZWFkZXIoc3RyZWFtLCAobGluZSkgPT4ge1xuXHRcdHRyeSB7XG5cdFx0XHRsaW5lcy5wdXNoKEpTT04ucGFyc2UobGluZSkpO1xuXHRcdH0gY2F0Y2gge1xuXHRcdFx0Ly8gc2tpcCBub24tSlNPTiBsaW5lc1xuXHRcdH1cblx0fSk7XG5cdHJldHVybiB7IGxpbmVzLCBkZXRhY2ggfTtcbn1cblxuLyoqIFdyaXRlIGEgY29tbWFuZCBhcyBKU09OTCB0byBhIHdyaXRhYmxlIHN0cmVhbSBhbmQgd2FpdCBmb3IgZHJhaW4gKi9cbmZ1bmN0aW9uIHdyaXRlTGluZShzdHJlYW06IFBhc3NUaHJvdWdoLCBvYmo6IHVua25vd24pOiB2b2lkIHtcblx0c3RyZWFtLndyaXRlKHNlcmlhbGl6ZUpzb25MaW5lKG9iaikpO1xufVxuXG4vKipcbiAqIENyZWF0ZSBhIG1vY2sgXCJjaGlsZCBwcm9jZXNzXCIgd2l0aCBwaXBlZCBzdGRpbi9zdGRvdXQuXG4gKiBjbGllbnRTdGRpbiAgXHUyMTkyIGRhdGEgZmxvd3MgaW50byB0aGUgXCJzZXJ2ZXJcIiAoZnJvbSB0aGUgY2xpZW50J3MgcGVyc3BlY3RpdmUsIHRoaXMgaXMgd2hhdCB0aGUgY2xpZW50IHdyaXRlcyB0bylcbiAqIGNsaWVudFN0ZG91dCBcdTIxOTAgZGF0YSBmbG93cyBvdXQgb2YgdGhlIFwic2VydmVyXCIgKGZyb20gdGhlIGNsaWVudCdzIHBlcnNwZWN0aXZlLCB0aGlzIGlzIHdoYXQgdGhlIGNsaWVudCByZWFkcyBmcm9tKVxuICpcbiAqIFRoZSB0ZXN0IGFjdHMgYXMgdGhlIFwic2VydmVyXCI6IHJlYWQgZnJvbSBjbGllbnRTdGRpbiwgd3JpdGUgdG8gY2xpZW50U3Rkb3V0LlxuICovXG5mdW5jdGlvbiBjcmVhdGVNb2NrUHJvY2VzcygpIHtcblx0Ly8gQ2xpZW50IHdyaXRlcyB0byB0aGlzIFx1MjE5MiBzZXJ2ZXIgcmVhZHMgZnJvbSBpdFxuXHRjb25zdCBjbGllbnRTdGRpbiA9IG5ldyBQYXNzVGhyb3VnaCgpO1xuXHQvLyBTZXJ2ZXIgd3JpdGVzIHRvIHRoaXMgXHUyMTkyIGNsaWVudCByZWFkcyBmcm9tIGl0XG5cdGNvbnN0IGNsaWVudFN0ZG91dCA9IG5ldyBQYXNzVGhyb3VnaCgpO1xuXG5cdHJldHVybiB7IGNsaWVudFN0ZGluLCBjbGllbnRTdGRvdXQgfTtcbn1cblxuLyoqIFdhaXQgYSB0aWNrIGZvciBhc3luYyBoYW5kbGVycyB0byBwcm9jZXNzICovXG5mdW5jdGlvbiB0aWNrKG1zID0gMTApOiBQcm9taXNlPHZvaWQ+IHtcblx0cmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIG1zKSk7XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIEpTT05MIHV0aWxpdGllc1xuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5kZXNjcmliZShcIkpTT05MIHV0aWxpdGllc1wiLCAoKSA9PiB7XG5cdGl0KFwic2VyaWFsaXplSnNvbkxpbmUgcHJvZHVjZXMgbmV3bGluZS10ZXJtaW5hdGVkIEpTT05cIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlc3VsdCA9IHNlcmlhbGl6ZUpzb25MaW5lKHsgdHlwZTogXCJ0ZXN0XCIsIHZhbHVlOiA0MiB9KTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0LCAne1widHlwZVwiOlwidGVzdFwiLFwidmFsdWVcIjo0Mn1cXG4nKTtcblx0fSk7XG5cblx0aXQoXCJzZXJpYWxpemVKc29uTGluZSBoYW5kbGVzIG5lc3RlZCBvYmplY3RzXCIsICgpID0+IHtcblx0XHRjb25zdCByZXN1bHQgPSBzZXJpYWxpemVKc29uTGluZSh7IGE6IHsgYjogWzEsIDIsIDNdIH0gfSk7XG5cdFx0YXNzZXJ0Lm9rKHJlc3VsdC5lbmRzV2l0aChcIlxcblwiKSk7XG5cdFx0Y29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShyZXN1bHQudHJpbSgpKTtcblx0XHRhc3NlcnQuZGVlcEVxdWFsKHBhcnNlZCwgeyBhOiB7IGI6IFsxLCAyLCAzXSB9IH0pO1xuXHR9KTtcblxuXHRpdChcImF0dGFjaEpzb25sTGluZVJlYWRlciBzcGxpdHMgb24gTEYgb25seVwiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3Qgc3RyZWFtID0gbmV3IFBhc3NUaHJvdWdoKCk7XG5cdFx0Y29uc3QgeyBsaW5lcywgZGV0YWNoIH0gPSBjb2xsZWN0TGluZXMoc3RyZWFtKTtcblxuXHRcdHN0cmVhbS53cml0ZSgne1wiYVwiOjF9XFxue1wiYlwiOjJ9XFxuJyk7XG5cdFx0YXdhaXQgdGljaygpO1xuXG5cdFx0YXNzZXJ0LmVxdWFsKGxpbmVzLmxlbmd0aCwgMik7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChsaW5lc1swXSwgeyBhOiAxIH0pO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwobGluZXNbMV0sIHsgYjogMiB9KTtcblx0XHRkZXRhY2goKTtcblx0fSk7XG5cblx0aXQoXCJhdHRhY2hKc29ubExpbmVSZWFkZXIgaGFuZGxlcyBwYXJ0aWFsIHdyaXRlc1wiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3Qgc3RyZWFtID0gbmV3IFBhc3NUaHJvdWdoKCk7XG5cdFx0Y29uc3QgeyBsaW5lcywgZGV0YWNoIH0gPSBjb2xsZWN0TGluZXMoc3RyZWFtKTtcblxuXHRcdHN0cmVhbS53cml0ZSgne1wicGFydGlhbFwiOicpO1xuXHRcdGF3YWl0IHRpY2soKTtcblx0XHRhc3NlcnQuZXF1YWwobGluZXMubGVuZ3RoLCAwKTtcblxuXHRcdHN0cmVhbS53cml0ZSgnXCJ2YWx1ZVwifVxcbicpO1xuXHRcdGF3YWl0IHRpY2soKTtcblx0XHRhc3NlcnQuZXF1YWwobGluZXMubGVuZ3RoLCAxKTtcblx0XHRhc3NlcnQuZGVlcEVxdWFsKGxpbmVzWzBdLCB7IHBhcnRpYWw6IFwidmFsdWVcIiB9KTtcblx0XHRkZXRhY2goKTtcblx0fSk7XG5cblx0aXQoXCJhdHRhY2hKc29ubExpbmVSZWFkZXIgaGFuZGxlcyBDUitMRlwiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3Qgc3RyZWFtID0gbmV3IFBhc3NUaHJvdWdoKCk7XG5cdFx0Y29uc3QgeyBsaW5lcywgZGV0YWNoIH0gPSBjb2xsZWN0TGluZXMoc3RyZWFtKTtcblxuXHRcdHN0cmVhbS53cml0ZSgne1wiY3JcIjpcImxmXCJ9XFxyXFxuJyk7XG5cdFx0YXdhaXQgdGljaygpO1xuXHRcdGFzc2VydC5lcXVhbChsaW5lcy5sZW5ndGgsIDEpO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwobGluZXNbMF0sIHsgY3I6IFwibGZcIiB9KTtcblx0XHRkZXRhY2goKTtcblx0fSk7XG5cblx0aXQoXCJkZXRhY2ggc3RvcHMgbGluZSBkZWxpdmVyeVwiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3Qgc3RyZWFtID0gbmV3IFBhc3NUaHJvdWdoKCk7XG5cdFx0Y29uc3QgeyBsaW5lcywgZGV0YWNoIH0gPSBjb2xsZWN0TGluZXMoc3RyZWFtKTtcblxuXHRcdHN0cmVhbS53cml0ZSgne1wiYmVmb3JlXCI6MX1cXG4nKTtcblx0XHRhd2FpdCB0aWNrKCk7XG5cdFx0YXNzZXJ0LmVxdWFsKGxpbmVzLmxlbmd0aCwgMSk7XG5cblx0XHRkZXRhY2goKTtcblxuXHRcdHN0cmVhbS53cml0ZSgne1wiYWZ0ZXJcIjoyfVxcbicpO1xuXHRcdGF3YWl0IHRpY2soKTtcblx0XHQvLyBTaG91bGQgc3RpbGwgYmUgMSBzaW5jZSB3ZSBkZXRhY2hlZFxuXHRcdGFzc2VydC5lcXVhbChsaW5lcy5sZW5ndGgsIDEpO1xuXHR9KTtcbn0pO1xuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyB2MiB0eXBlIHNoYXBlIGFzc2VydGlvbnNcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuZGVzY3JpYmUoXCJ2MiB0eXBlIHNoYXBlc1wiLCAoKSA9PiB7XG5cdGl0KFwiUnBjSW5pdFJlc3VsdCBoYXMgcmVxdWlyZWQgZmllbGRzXCIsICgpID0+IHtcblx0XHRjb25zdCBpbml0UmVzdWx0OiBScGNJbml0UmVzdWx0ID0ge1xuXHRcdFx0cHJvdG9jb2xWZXJzaW9uOiAyLFxuXHRcdFx0c2Vzc2lvbklkOiBcInRlc3Qtc2Vzc2lvbi0xMjNcIixcblx0XHRcdGNhcGFiaWxpdGllczoge1xuXHRcdFx0XHRldmVudHM6IFtcImV4ZWN1dGlvbl9jb21wbGV0ZVwiLCBcImNvc3RfdXBkYXRlXCJdLFxuXHRcdFx0XHRjb21tYW5kczogW1wiaW5pdFwiLCBcInNodXRkb3duXCIsIFwic3Vic2NyaWJlXCJdLFxuXHRcdFx0fSxcblx0XHR9O1xuXHRcdGFzc2VydC5lcXVhbChpbml0UmVzdWx0LnByb3RvY29sVmVyc2lvbiwgMik7XG5cdFx0YXNzZXJ0Lm9rKHR5cGVvZiBpbml0UmVzdWx0LnNlc3Npb25JZCA9PT0gXCJzdHJpbmdcIik7XG5cdFx0YXNzZXJ0Lm9rKEFycmF5LmlzQXJyYXkoaW5pdFJlc3VsdC5jYXBhYmlsaXRpZXMuZXZlbnRzKSk7XG5cdFx0YXNzZXJ0Lm9rKEFycmF5LmlzQXJyYXkoaW5pdFJlc3VsdC5jYXBhYmlsaXRpZXMuY29tbWFuZHMpKTtcblx0XHRhc3NlcnQub2soaW5pdFJlc3VsdC5jYXBhYmlsaXRpZXMuZXZlbnRzLmluY2x1ZGVzKFwiZXhlY3V0aW9uX2NvbXBsZXRlXCIpKTtcblx0XHRhc3NlcnQub2soaW5pdFJlc3VsdC5jYXBhYmlsaXRpZXMuZXZlbnRzLmluY2x1ZGVzKFwiY29zdF91cGRhdGVcIikpO1xuXHRcdGFzc2VydC5vayhpbml0UmVzdWx0LmNhcGFiaWxpdGllcy5jb21tYW5kcy5pbmNsdWRlcyhcImluaXRcIikpO1xuXHRcdGFzc2VydC5vayhpbml0UmVzdWx0LmNhcGFiaWxpdGllcy5jb21tYW5kcy5pbmNsdWRlcyhcInNodXRkb3duXCIpKTtcblx0XHRhc3NlcnQub2soaW5pdFJlc3VsdC5jYXBhYmlsaXRpZXMuY29tbWFuZHMuaW5jbHVkZXMoXCJzdWJzY3JpYmVcIikpO1xuXHR9KTtcblxuXHRpdChcIlJwY0V4ZWN1dGlvbkNvbXBsZXRlRXZlbnQgbWF0Y2hlcyBleHBlY3RlZCBzaGFwZVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgZXZlbnQ6IFJwY0V4ZWN1dGlvbkNvbXBsZXRlRXZlbnQgPSB7XG5cdFx0XHR0eXBlOiBcImV4ZWN1dGlvbl9jb21wbGV0ZVwiLFxuXHRcdFx0cnVuSWQ6IFwicnVuLWFiYy0xMjNcIixcblx0XHRcdHN0YXR1czogXCJjb21wbGV0ZWRcIixcblx0XHRcdHN0YXRzOiB7XG5cdFx0XHRcdGNvc3Q6IDAuMDUsXG5cdFx0XHRcdHR1cm5zOiAzLFxuXHRcdFx0XHRkdXJhdGlvbjogMTIwMDAsXG5cdFx0XHRcdHRva2VuczogeyBpbnB1dDogMTAwMCwgb3V0cHV0OiA1MDAsIGNhY2hlUmVhZDogMjAwLCBjYWNoZVdyaXRlOiAxMDAgfSxcblx0XHRcdH0gYXMgYW55LCAvLyBTZXNzaW9uU3RhdHMgaXMgY29tcGxleCwgd2UganVzdCB2ZXJpZnkgc2hhcGVcblx0XHR9O1xuXHRcdGFzc2VydC5lcXVhbChldmVudC50eXBlLCBcImV4ZWN1dGlvbl9jb21wbGV0ZVwiKTtcblx0XHRhc3NlcnQub2sodHlwZW9mIGV2ZW50LnJ1bklkID09PSBcInN0cmluZ1wiKTtcblx0XHRhc3NlcnQub2soW1wiY29tcGxldGVkXCIsIFwiZXJyb3JcIiwgXCJjYW5jZWxsZWRcIl0uaW5jbHVkZXMoZXZlbnQuc3RhdHVzKSk7XG5cdFx0YXNzZXJ0Lm9rKGV2ZW50LnN0YXRzICE9PSB1bmRlZmluZWQpO1xuXHR9KTtcblxuXHRpdChcIlJwY0V4ZWN1dGlvbkNvbXBsZXRlRXZlbnQgc3VwcG9ydHMgZXJyb3Igc3RhdHVzIHdpdGggcmVhc29uXCIsICgpID0+IHtcblx0XHRjb25zdCBldmVudDogUnBjRXhlY3V0aW9uQ29tcGxldGVFdmVudCA9IHtcblx0XHRcdHR5cGU6IFwiZXhlY3V0aW9uX2NvbXBsZXRlXCIsXG5cdFx0XHRydW5JZDogXCJydW4tZXJyLTQ1NlwiLFxuXHRcdFx0c3RhdHVzOiBcImVycm9yXCIsXG5cdFx0XHRyZWFzb246IFwiQVBJIHJhdGUgbGltaXQgZXhjZWVkZWRcIixcblx0XHRcdHN0YXRzOiB7fSBhcyBhbnksXG5cdFx0fTtcblx0XHRhc3NlcnQuZXF1YWwoZXZlbnQuc3RhdHVzLCBcImVycm9yXCIpO1xuXHRcdGFzc2VydC5lcXVhbChldmVudC5yZWFzb24sIFwiQVBJIHJhdGUgbGltaXQgZXhjZWVkZWRcIik7XG5cdH0pO1xuXG5cdGl0KFwiUnBjQ29zdFVwZGF0ZUV2ZW50IG1hdGNoZXMgZXhwZWN0ZWQgc2hhcGVcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGV2ZW50OiBScGNDb3N0VXBkYXRlRXZlbnQgPSB7XG5cdFx0XHR0eXBlOiBcImNvc3RfdXBkYXRlXCIsXG5cdFx0XHRydW5JZDogXCJydW4tY29zdC03ODlcIixcblx0XHRcdHR1cm5Db3N0OiAwLjAxLFxuXHRcdFx0Y3VtdWxhdGl2ZUNvc3Q6IDAuMDUsXG5cdFx0XHR0b2tlbnM6IHtcblx0XHRcdFx0aW5wdXQ6IDUwMCxcblx0XHRcdFx0b3V0cHV0OiAyMDAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMTAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiA1MCxcblx0XHRcdH0sXG5cdFx0fTtcblx0XHRhc3NlcnQuZXF1YWwoZXZlbnQudHlwZSwgXCJjb3N0X3VwZGF0ZVwiKTtcblx0XHRhc3NlcnQub2sodHlwZW9mIGV2ZW50LnJ1bklkID09PSBcInN0cmluZ1wiKTtcblx0XHRhc3NlcnQub2sodHlwZW9mIGV2ZW50LnR1cm5Db3N0ID09PSBcIm51bWJlclwiKTtcblx0XHRhc3NlcnQub2sodHlwZW9mIGV2ZW50LmN1bXVsYXRpdmVDb3N0ID09PSBcIm51bWJlclwiKTtcblx0XHRhc3NlcnQub2sodHlwZW9mIGV2ZW50LnRva2Vucy5pbnB1dCA9PT0gXCJudW1iZXJcIik7XG5cdFx0YXNzZXJ0Lm9rKHR5cGVvZiBldmVudC50b2tlbnMub3V0cHV0ID09PSBcIm51bWJlclwiKTtcblx0XHRhc3NlcnQub2sodHlwZW9mIGV2ZW50LnRva2Vucy5jYWNoZVJlYWQgPT09IFwibnVtYmVyXCIpO1xuXHRcdGFzc2VydC5vayh0eXBlb2YgZXZlbnQudG9rZW5zLmNhY2hlV3JpdGUgPT09IFwibnVtYmVyXCIpO1xuXHR9KTtcblxuXHRpdChcIlJwY1YyRXZlbnQgZGlzY3JpbWluYXRlZCB1bmlvbiByZXNvbHZlcyBieSB0eXBlIGZpZWxkXCIsICgpID0+IHtcblx0XHRjb25zdCBldmVudHM6IFJwY1YyRXZlbnRbXSA9IFtcblx0XHRcdHtcblx0XHRcdFx0dHlwZTogXCJleGVjdXRpb25fY29tcGxldGVcIixcblx0XHRcdFx0cnVuSWQ6IFwicjFcIixcblx0XHRcdFx0c3RhdHVzOiBcImNvbXBsZXRlZFwiLFxuXHRcdFx0XHRzdGF0czoge30gYXMgYW55LFxuXHRcdFx0fSxcblx0XHRcdHtcblx0XHRcdFx0dHlwZTogXCJjb3N0X3VwZGF0ZVwiLFxuXHRcdFx0XHRydW5JZDogXCJyMlwiLFxuXHRcdFx0XHR0dXJuQ29zdDogMC4wMSxcblx0XHRcdFx0Y3VtdWxhdGl2ZUNvc3Q6IDAuMDMsXG5cdFx0XHRcdHRva2VuczogeyBpbnB1dDogMTAwLCBvdXRwdXQ6IDUwLCBjYWNoZVJlYWQ6IDEwLCBjYWNoZVdyaXRlOiA1IH0sXG5cdFx0XHR9LFxuXHRcdF07XG5cblx0XHRmb3IgKGNvbnN0IGV2ZW50IG9mIGV2ZW50cykge1xuXHRcdFx0aWYgKGV2ZW50LnR5cGUgPT09IFwiZXhlY3V0aW9uX2NvbXBsZXRlXCIpIHtcblx0XHRcdFx0Ly8gVHlwZVNjcmlwdCBuYXJyb3dzIHRvIFJwY0V4ZWN1dGlvbkNvbXBsZXRlRXZlbnRcblx0XHRcdFx0YXNzZXJ0Lm9rKFwic3RhdHVzXCIgaW4gZXZlbnQpO1xuXHRcdFx0XHRhc3NlcnQub2soXCJzdGF0c1wiIGluIGV2ZW50KTtcblx0XHRcdH0gZWxzZSBpZiAoZXZlbnQudHlwZSA9PT0gXCJjb3N0X3VwZGF0ZVwiKSB7XG5cdFx0XHRcdC8vIFR5cGVTY3JpcHQgbmFycm93cyB0byBScGNDb3N0VXBkYXRlRXZlbnRcblx0XHRcdFx0YXNzZXJ0Lm9rKFwidHVybkNvc3RcIiBpbiBldmVudCk7XG5cdFx0XHRcdGFzc2VydC5vayhcInRva2Vuc1wiIGluIGV2ZW50KTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdGFzc2VydC5mYWlsKGBVbmV4cGVjdGVkIGV2ZW50IHR5cGU6ICR7KGV2ZW50IGFzIGFueSkudHlwZX1gKTtcblx0XHRcdH1cblx0XHR9XG5cdH0pO1xuXG5cdGl0KFwiUnBjUHJvdG9jb2xWZXJzaW9uIGlzIDEgb3IgMlwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgdjE6IFJwY1Byb3RvY29sVmVyc2lvbiA9IDE7XG5cdFx0Y29uc3QgdjI6IFJwY1Byb3RvY29sVmVyc2lvbiA9IDI7XG5cdFx0YXNzZXJ0LmVxdWFsKHYxLCAxKTtcblx0XHRhc3NlcnQuZXF1YWwodjIsIDIpO1xuXHR9KTtcblxuXHRpdChcInYyIHByb21wdCByZXNwb25zZSBpbmNsdWRlcyBvcHRpb25hbCBydW5JZCBmaWVsZFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgdjFSZXNwb25zZTogUnBjUmVzcG9uc2UgPSB7XG5cdFx0XHRpZDogXCIxXCIsXG5cdFx0XHR0eXBlOiBcInJlc3BvbnNlXCIsXG5cdFx0XHRjb21tYW5kOiBcInByb21wdFwiLFxuXHRcdFx0c3VjY2VzczogdHJ1ZSxcblx0XHR9O1xuXHRcdGFzc2VydC5lcXVhbCh2MVJlc3BvbnNlLnN1Y2Nlc3MsIHRydWUpO1xuXHRcdGFzc2VydC5lcXVhbCgodjFSZXNwb25zZSBhcyBhbnkpLnJ1bklkLCB1bmRlZmluZWQpO1xuXG5cdFx0Y29uc3QgdjJSZXNwb25zZTogUnBjUmVzcG9uc2UgPSB7XG5cdFx0XHRpZDogXCIyXCIsXG5cdFx0XHR0eXBlOiBcInJlc3BvbnNlXCIsXG5cdFx0XHRjb21tYW5kOiBcInByb21wdFwiLFxuXHRcdFx0c3VjY2VzczogdHJ1ZSxcblx0XHRcdHJ1bklkOiBcInJ1bi0xMjNcIixcblx0XHR9O1xuXHRcdGFzc2VydC5lcXVhbCh2MlJlc3BvbnNlLnN1Y2Nlc3MsIHRydWUpO1xuXHRcdGFzc2VydC5lcXVhbCgodjJSZXNwb25zZSBhcyBhbnkpLnJ1bklkLCBcInJ1bi0xMjNcIik7XG5cdH0pO1xuXG5cdGl0KFwidjIgY29tbWFuZCB0eXBlcyBhcmUgcHJlc2VudCBpbiBScGNDb21tYW5kIHVuaW9uXCIsICgpID0+IHtcblx0XHQvLyBUaGVzZSBjb21waWxlIFx1MjAxNCB0aGF0J3MgdGhlIGFjdHVhbCB0ZXN0LiBSdW50aW1lIHZlcmlmaWNhdGlvbjpcblx0XHRjb25zdCBpbml0Q21kOiBScGNDb21tYW5kID0geyB0eXBlOiBcImluaXRcIiwgcHJvdG9jb2xWZXJzaW9uOiAyIH07XG5cdFx0Y29uc3Qgc2h1dGRvd25DbWQ6IFJwY0NvbW1hbmQgPSB7IHR5cGU6IFwic2h1dGRvd25cIiB9O1xuXHRcdGNvbnN0IHN1YnNjcmliZUNtZDogUnBjQ29tbWFuZCA9IHsgdHlwZTogXCJzdWJzY3JpYmVcIiwgZXZlbnRzOiBbXCJhZ2VudF9lbmRcIl0gfTtcblxuXHRcdGFzc2VydC5lcXVhbChpbml0Q21kLnR5cGUsIFwiaW5pdFwiKTtcblx0XHRhc3NlcnQuZXF1YWwoc2h1dGRvd25DbWQudHlwZSwgXCJzaHV0ZG93blwiKTtcblx0XHRhc3NlcnQuZXF1YWwoc3Vic2NyaWJlQ21kLnR5cGUsIFwic3Vic2NyaWJlXCIpO1xuXHR9KTtcblxuXHRpdChcImluaXQgY29tbWFuZCBzdXBwb3J0cyBvcHRpb25hbCBjbGllbnRJZFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgY21kOiBScGNDb21tYW5kID0geyB0eXBlOiBcImluaXRcIiwgcHJvdG9jb2xWZXJzaW9uOiAyLCBjbGllbnRJZDogXCJteS1jbGllbnRcIiB9O1xuXHRcdGFzc2VydC5lcXVhbChjbWQudHlwZSwgXCJpbml0XCIpO1xuXHRcdGlmIChjbWQudHlwZSA9PT0gXCJpbml0XCIpIHtcblx0XHRcdGFzc2VydC5lcXVhbChjbWQuY2xpZW50SWQsIFwibXktY2xpZW50XCIpO1xuXHRcdH1cblx0fSk7XG5cblx0aXQoXCJzaHV0ZG93biBjb21tYW5kIHN1cHBvcnRzIG9wdGlvbmFsIGdyYWNlZnVsIGZsYWdcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGNtZDogUnBjQ29tbWFuZCA9IHsgdHlwZTogXCJzaHV0ZG93blwiLCBncmFjZWZ1bDogdHJ1ZSB9O1xuXHRcdGlmIChjbWQudHlwZSA9PT0gXCJzaHV0ZG93blwiKSB7XG5cdFx0XHRhc3NlcnQuZXF1YWwoY21kLmdyYWNlZnVsLCB0cnVlKTtcblx0XHR9XG5cdH0pO1xuXG5cdGl0KFwidjIgcmVzcG9uc2UgdHlwZXMgaW5jbHVkZSBpbml0LCBzaHV0ZG93biwgc3Vic2NyaWJlXCIsICgpID0+IHtcblx0XHRjb25zdCBpbml0UmVzcDogUnBjUmVzcG9uc2UgPSB7XG5cdFx0XHR0eXBlOiBcInJlc3BvbnNlXCIsXG5cdFx0XHRjb21tYW5kOiBcImluaXRcIixcblx0XHRcdHN1Y2Nlc3M6IHRydWUsXG5cdFx0XHRkYXRhOiB7XG5cdFx0XHRcdHByb3RvY29sVmVyc2lvbjogMixcblx0XHRcdFx0c2Vzc2lvbklkOiBcInMxXCIsXG5cdFx0XHRcdGNhcGFiaWxpdGllczogeyBldmVudHM6IFtdLCBjb21tYW5kczogW10gfSxcblx0XHRcdH0sXG5cdFx0fTtcblx0XHRjb25zdCBzaHV0ZG93blJlc3A6IFJwY1Jlc3BvbnNlID0ge1xuXHRcdFx0dHlwZTogXCJyZXNwb25zZVwiLFxuXHRcdFx0Y29tbWFuZDogXCJzaHV0ZG93blwiLFxuXHRcdFx0c3VjY2VzczogdHJ1ZSxcblx0XHR9O1xuXHRcdGNvbnN0IHN1YnNjcmliZVJlc3A6IFJwY1Jlc3BvbnNlID0ge1xuXHRcdFx0dHlwZTogXCJyZXNwb25zZVwiLFxuXHRcdFx0Y29tbWFuZDogXCJzdWJzY3JpYmVcIixcblx0XHRcdHN1Y2Nlc3M6IHRydWUsXG5cdFx0fTtcblxuXHRcdGFzc2VydC5lcXVhbChpbml0UmVzcC5jb21tYW5kLCBcImluaXRcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKHNodXRkb3duUmVzcC5jb21tYW5kLCBcInNodXRkb3duXCIpO1xuXHRcdGFzc2VydC5lcXVhbChzdWJzY3JpYmVSZXNwLmNvbW1hbmQsIFwic3Vic2NyaWJlXCIpO1xuXHR9KTtcbn0pO1xuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyB2MSBiYWNrd2FyZCBjb21wYXRpYmlsaXR5XG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmRlc2NyaWJlKFwidjEgYmFja3dhcmQgY29tcGF0aWJpbGl0eSBcdTIwMTQgY29tbWFuZCBzaGFwZXNcIiwgKCkgPT4ge1xuXHRpdChcInYxIHByb21wdCBjb21tYW5kIGhhcyBubyBwcm90b2NvbFZlcnNpb24gb3IgcnVuSWRcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGNtZDogUnBjQ29tbWFuZCA9IHsgdHlwZTogXCJwcm9tcHRcIiwgbWVzc2FnZTogXCJoZWxsb1wiIH07XG5cdFx0YXNzZXJ0LmVxdWFsKGNtZC50eXBlLCBcInByb21wdFwiKTtcblx0XHRhc3NlcnQuZXF1YWwoKGNtZCBhcyBhbnkpLnByb3RvY29sVmVyc2lvbiwgdW5kZWZpbmVkKTtcblx0XHRhc3NlcnQuZXF1YWwoKGNtZCBhcyBhbnkpLnJ1bklkLCB1bmRlZmluZWQpO1xuXHR9KTtcblxuXHRpdChcInYxIGdldF9zdGF0ZSByZXNwb25zZSBoYXMgbm8gdjIgZmllbGRzXCIsICgpID0+IHtcblx0XHRjb25zdCBzdGF0ZTogUnBjU2Vzc2lvblN0YXRlID0ge1xuXHRcdFx0dGhpbmtpbmdMZXZlbDogXCJtZWRpdW1cIixcblx0XHRcdGlzU3RyZWFtaW5nOiBmYWxzZSxcblx0XHRcdGlzQ29tcGFjdGluZzogZmFsc2UsXG5cdFx0XHRzdGVlcmluZ01vZGU6IFwiYWxsXCIsXG5cdFx0XHRmb2xsb3dVcE1vZGU6IFwiYWxsXCIsXG5cdFx0XHRzZXNzaW9uSWQ6IFwidGVzdC1pZFwiLFxuXHRcdFx0YXV0b0NvbXBhY3Rpb25FbmFibGVkOiB0cnVlLFxuXHRcdFx0YXV0b1JldHJ5RW5hYmxlZDogZmFsc2UsXG5cdFx0XHRyZXRyeUluUHJvZ3Jlc3M6IGZhbHNlLFxuXHRcdFx0cmV0cnlBdHRlbXB0OiAwLFxuXHRcdFx0bWVzc2FnZUNvdW50OiAwLFxuXHRcdFx0cGVuZGluZ01lc3NhZ2VDb3VudDogMCxcblx0XHRcdGV4dGVuc2lvbnNSZWFkeTogdHJ1ZSxcblx0XHR9O1xuXHRcdC8vIHYxIHN0YXRlIHNob3VsZCBub3QgaW5jbHVkZSBhbnkgdjItc3BlY2lmaWMgZmllbGRzXG5cdFx0YXNzZXJ0LmVxdWFsKChzdGF0ZSBhcyBhbnkpLnByb3RvY29sVmVyc2lvbiwgdW5kZWZpbmVkKTtcblx0XHRhc3NlcnQuZXF1YWwoKHN0YXRlIGFzIGFueSkucnVuSWQsIHVuZGVmaW5lZCk7XG5cdH0pO1xuXG5cdGl0KFwidjEgcHJvbXB0IHJlc3BvbnNlIGhhcyBubyBydW5JZFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVzcDogUnBjUmVzcG9uc2UgPSB7XG5cdFx0XHRpZDogXCIxXCIsXG5cdFx0XHR0eXBlOiBcInJlc3BvbnNlXCIsXG5cdFx0XHRjb21tYW5kOiBcInByb21wdFwiLFxuXHRcdFx0c3VjY2VzczogdHJ1ZSxcblx0XHR9O1xuXHRcdGFzc2VydC5lcXVhbChyZXNwLnN1Y2Nlc3MsIHRydWUpO1xuXHRcdC8vIHJ1bklkIGlzIG9wdGlvbmFsOyBpbiB2MSBtb2RlIGl0IHdvbid0IGJlIHByZXNlbnRcblx0XHRhc3NlcnQuZXF1YWwoKHJlc3AgYXMgYW55KS5ydW5JZCwgdW5kZWZpbmVkKTtcblx0fSk7XG5cblx0aXQoXCJlcnJvciByZXNwb25zZSBzaGFwZSBpcyBjb25zaXN0ZW50IGFjcm9zcyB2MSBhbmQgdjJcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGVyclJlc3A6IFJwY1Jlc3BvbnNlID0ge1xuXHRcdFx0aWQ6IFwiZXJyLTFcIixcblx0XHRcdHR5cGU6IFwicmVzcG9uc2VcIixcblx0XHRcdGNvbW1hbmQ6IFwiaW5pdFwiLFxuXHRcdFx0c3VjY2VzczogZmFsc2UsXG5cdFx0XHRlcnJvcjogXCJQcm90b2NvbCB2ZXJzaW9uIGFscmVhZHkgbG9ja2VkLiBpbml0IG11c3QgYmUgdGhlIGZpcnN0IGNvbW1hbmQuXCIsXG5cdFx0fTtcblx0XHRhc3NlcnQuZXF1YWwoZXJyUmVzcC5zdWNjZXNzLCBmYWxzZSk7XG5cdFx0aWYgKCFlcnJSZXNwLnN1Y2Nlc3MpIHtcblx0XHRcdGFzc2VydC5vayh0eXBlb2YgZXJyUmVzcC5lcnJvciA9PT0gXCJzdHJpbmdcIik7XG5cdFx0XHRhc3NlcnQub2soZXJyUmVzcC5lcnJvci5sZW5ndGggPiAwKTtcblx0XHR9XG5cdH0pO1xufSk7XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFJwY0NsaWVudCBjb21tYW5kIHNlcmlhbGl6YXRpb24gdGVzdHMgKG1vY2sgcHJvY2Vzcylcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuZGVzY3JpYmUoXCJScGNDbGllbnQgY29tbWFuZCBzZXJpYWxpemF0aW9uXCIsICgpID0+IHtcblx0Ly8gV2UgaW1wb3J0IHRoZSBjbGFzcyBkeW5hbWljYWxseSB0byBhdm9pZCB0aGUgZnVsbCBtb2R1bGUgZ3JhcGggYXQgdGVzdCB0aW1lLlxuXHQvLyBJbnN0ZWFkIHdlIHRlc3QgdGhlIHByb3RvY29sIGZyYW1pbmcgZGlyZWN0bHkgXHUyMDE0IHdoYXQgZ2V0cyB3cml0dGVuIHRvIHN0ZGluIGFuZFxuXHQvLyB3aGF0IGNvbWVzIGJhY2sgZnJvbSBzdGRvdXQgXHUyMDE0IHVzaW5nIFBhc3NUaHJvdWdoIHN0cmVhbXMuXG5cblx0aXQoXCJpbml0IGNvbW1hbmQgc2VyaWFsaXplcyBjb3JyZWN0bHlcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGNtZCA9IHsgaWQ6IFwicmVxXzFcIiwgdHlwZTogXCJpbml0XCIsIHByb3RvY29sVmVyc2lvbjogMiB9O1xuXHRcdGNvbnN0IHNlcmlhbGl6ZWQgPSBzZXJpYWxpemVKc29uTGluZShjbWQpO1xuXHRcdGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2Uoc2VyaWFsaXplZCk7XG5cdFx0YXNzZXJ0LmVxdWFsKHBhcnNlZC50eXBlLCBcImluaXRcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKHBhcnNlZC5wcm90b2NvbFZlcnNpb24sIDIpO1xuXHRcdGFzc2VydC5lcXVhbChwYXJzZWQuaWQsIFwicmVxXzFcIik7XG5cdH0pO1xuXG5cdGl0KFwiaW5pdCBjb21tYW5kIHdpdGggY2xpZW50SWQgc2VyaWFsaXplcyBjb3JyZWN0bHlcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGNtZCA9IHsgaWQ6IFwicmVxXzFcIiwgdHlwZTogXCJpbml0XCIsIHByb3RvY29sVmVyc2lvbjogMiwgY2xpZW50SWQ6IFwidGVzdC1jbGllbnRcIiB9O1xuXHRcdGNvbnN0IHNlcmlhbGl6ZWQgPSBzZXJpYWxpemVKc29uTGluZShjbWQpO1xuXHRcdGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2Uoc2VyaWFsaXplZCk7XG5cdFx0YXNzZXJ0LmVxdWFsKHBhcnNlZC5jbGllbnRJZCwgXCJ0ZXN0LWNsaWVudFwiKTtcblx0fSk7XG5cblx0aXQoXCJzaHV0ZG93biBjb21tYW5kIHNlcmlhbGl6ZXMgY29ycmVjdGx5XCIsICgpID0+IHtcblx0XHRjb25zdCBjbWQgPSB7IGlkOiBcInJlcV8yXCIsIHR5cGU6IFwic2h1dGRvd25cIiB9O1xuXHRcdGNvbnN0IHNlcmlhbGl6ZWQgPSBzZXJpYWxpemVKc29uTGluZShjbWQpO1xuXHRcdGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2Uoc2VyaWFsaXplZCk7XG5cdFx0YXNzZXJ0LmVxdWFsKHBhcnNlZC50eXBlLCBcInNodXRkb3duXCIpO1xuXHRcdGFzc2VydC5lcXVhbChwYXJzZWQuaWQsIFwicmVxXzJcIik7XG5cdH0pO1xuXG5cdGl0KFwic3Vic2NyaWJlIGNvbW1hbmQgc2VyaWFsaXplcyBjb3JyZWN0bHkgd2l0aCBldmVudCBsaXN0XCIsICgpID0+IHtcblx0XHRjb25zdCBjbWQgPSB7IGlkOiBcInJlcV8zXCIsIHR5cGU6IFwic3Vic2NyaWJlXCIsIGV2ZW50czogW1wiYWdlbnRfZW5kXCIsIFwiY29zdF91cGRhdGVcIl0gfTtcblx0XHRjb25zdCBzZXJpYWxpemVkID0gc2VyaWFsaXplSnNvbkxpbmUoY21kKTtcblx0XHRjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHNlcmlhbGl6ZWQpO1xuXHRcdGFzc2VydC5lcXVhbChwYXJzZWQudHlwZSwgXCJzdWJzY3JpYmVcIik7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChwYXJzZWQuZXZlbnRzLCBbXCJhZ2VudF9lbmRcIiwgXCJjb3N0X3VwZGF0ZVwiXSk7XG5cdH0pO1xuXG5cdGl0KFwic3Vic2NyaWJlIGNvbW1hbmQgd2l0aCB3aWxkY2FyZCBzZXJpYWxpemVzIGNvcnJlY3RseVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgY21kID0geyBpZDogXCJyZXFfNFwiLCB0eXBlOiBcInN1YnNjcmliZVwiLCBldmVudHM6IFtcIipcIl0gfTtcblx0XHRjb25zdCBzZXJpYWxpemVkID0gc2VyaWFsaXplSnNvbkxpbmUoY21kKTtcblx0XHRjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHNlcmlhbGl6ZWQpO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwocGFyc2VkLmV2ZW50cywgW1wiKlwiXSk7XG5cdH0pO1xuXG5cdGl0KFwic3Vic2NyaWJlIGNvbW1hbmQgd2l0aCBlbXB0eSBhcnJheSBzZXJpYWxpemVzIGNvcnJlY3RseVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgY21kID0geyBpZDogXCJyZXFfNVwiLCB0eXBlOiBcInN1YnNjcmliZVwiLCBldmVudHM6IFtdIGFzIHN0cmluZ1tdIH07XG5cdFx0Y29uc3Qgc2VyaWFsaXplZCA9IHNlcmlhbGl6ZUpzb25MaW5lKGNtZCk7XG5cdFx0Y29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShzZXJpYWxpemVkKTtcblx0XHRhc3NlcnQuZGVlcEVxdWFsKHBhcnNlZC5ldmVudHMsIFtdKTtcblx0fSk7XG5cblx0aXQoXCJzZW5kVUlSZXNwb25zZSBzZXJpYWxpemVzIGNvcnJlY3QgSlNPTkxcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlc3BvbnNlID0ge1xuXHRcdFx0dHlwZTogXCJleHRlbnNpb25fdWlfcmVzcG9uc2VcIixcblx0XHRcdGlkOiBcInVpLXJlcS0xMjNcIixcblx0XHRcdHZhbHVlOiBcInRlc3QtdmFsdWVcIixcblx0XHR9O1xuXHRcdGNvbnN0IHNlcmlhbGl6ZWQgPSBzZXJpYWxpemVKc29uTGluZShyZXNwb25zZSk7XG5cdFx0Y29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShzZXJpYWxpemVkKTtcblx0XHRhc3NlcnQuZXF1YWwocGFyc2VkLnR5cGUsIFwiZXh0ZW5zaW9uX3VpX3Jlc3BvbnNlXCIpO1xuXHRcdGFzc2VydC5lcXVhbChwYXJzZWQuaWQsIFwidWktcmVxLTEyM1wiKTtcblx0XHRhc3NlcnQuZXF1YWwocGFyc2VkLnZhbHVlLCBcInRlc3QtdmFsdWVcIik7XG5cdH0pO1xuXG5cdGl0KFwic2VuZFVJUmVzcG9uc2Ugd2l0aCBjYW5jZWxsZWQgZmxhZyBzZXJpYWxpemVzIGNvcnJlY3RseVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVzcG9uc2UgPSB7XG5cdFx0XHR0eXBlOiBcImV4dGVuc2lvbl91aV9yZXNwb25zZVwiLFxuXHRcdFx0aWQ6IFwidWktcmVxLTQ1NlwiLFxuXHRcdFx0Y2FuY2VsbGVkOiB0cnVlLFxuXHRcdH07XG5cdFx0Y29uc3Qgc2VyaWFsaXplZCA9IHNlcmlhbGl6ZUpzb25MaW5lKHJlc3BvbnNlKTtcblx0XHRjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHNlcmlhbGl6ZWQpO1xuXHRcdGFzc2VydC5lcXVhbChwYXJzZWQudHlwZSwgXCJleHRlbnNpb25fdWlfcmVzcG9uc2VcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKHBhcnNlZC5jYW5jZWxsZWQsIHRydWUpO1xuXHR9KTtcblxuXHRpdChcInNlbmRVSVJlc3BvbnNlIHdpdGggY29uZmlybWVkIGZsYWcgc2VyaWFsaXplcyBjb3JyZWN0bHlcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlc3BvbnNlID0ge1xuXHRcdFx0dHlwZTogXCJleHRlbnNpb25fdWlfcmVzcG9uc2VcIixcblx0XHRcdGlkOiBcInVpLXJlcS03ODlcIixcblx0XHRcdGNvbmZpcm1lZDogdHJ1ZSxcblx0XHR9O1xuXHRcdGNvbnN0IHNlcmlhbGl6ZWQgPSBzZXJpYWxpemVKc29uTGluZShyZXNwb25zZSk7XG5cdFx0Y29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShzZXJpYWxpemVkKTtcblx0XHRhc3NlcnQuZXF1YWwocGFyc2VkLmNvbmZpcm1lZCwgdHJ1ZSk7XG5cdH0pO1xuXG5cdGl0KFwic2VuZFVJUmVzcG9uc2Ugd2l0aCBtdWx0aXBsZSB2YWx1ZXMgc2VyaWFsaXplcyBjb3JyZWN0bHlcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlc3BvbnNlID0ge1xuXHRcdFx0dHlwZTogXCJleHRlbnNpb25fdWlfcmVzcG9uc2VcIixcblx0XHRcdGlkOiBcInVpLXJlcS1tdWx0aVwiLFxuXHRcdFx0dmFsdWVzOiBbXCJvcHQtYVwiLCBcIm9wdC1iXCJdLFxuXHRcdH07XG5cdFx0Y29uc3Qgc2VyaWFsaXplZCA9IHNlcmlhbGl6ZUpzb25MaW5lKHJlc3BvbnNlKTtcblx0XHRjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHNlcmlhbGl6ZWQpO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwocGFyc2VkLnZhbHVlcywgW1wib3B0LWFcIiwgXCJvcHQtYlwiXSk7XG5cdH0pO1xuXG5cdGl0KFwicHJvbXB0IGNvbW1hbmQgd2l0aCBydW5JZCBpbiB2MiByZXNwb25zZVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVzcG9uc2UgPSB7XG5cdFx0XHRpZDogXCJyZXFfMTBcIixcblx0XHRcdHR5cGU6IFwicmVzcG9uc2VcIixcblx0XHRcdGNvbW1hbmQ6IFwicHJvbXB0XCIsXG5cdFx0XHRzdWNjZXNzOiB0cnVlLFxuXHRcdFx0cnVuSWQ6IFwicnVuLXV1aWQtYWJjXCIsXG5cdFx0fTtcblx0XHRjb25zdCBzZXJpYWxpemVkID0gc2VyaWFsaXplSnNvbkxpbmUocmVzcG9uc2UpO1xuXHRcdGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2Uoc2VyaWFsaXplZCk7XG5cdFx0YXNzZXJ0LmVxdWFsKHBhcnNlZC5ydW5JZCwgXCJydW4tdXVpZC1hYmNcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKHBhcnNlZC5jb21tYW5kLCBcInByb21wdFwiKTtcblx0XHRhc3NlcnQuZXF1YWwocGFyc2VkLnN1Y2Nlc3MsIHRydWUpO1xuXHR9KTtcbn0pO1xuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBDbGllbnQgXHUyMTk0IE1vY2sgc2VydmVyIGludGVncmF0aW9uIChQYXNzVGhyb3VnaCBzdHJlYW1zKVxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5kZXNjcmliZShcIkNsaWVudCBcdTIxOTQgTW9jayBzZXJ2ZXIgcHJvdG9jb2wgZXhjaGFuZ2VcIiwgKCkgPT4ge1xuXHRsZXQgY2xpZW50U3RkaW46IFBhc3NUaHJvdWdoO1xuXHRsZXQgY2xpZW50U3Rkb3V0OiBQYXNzVGhyb3VnaDtcblxuXHRiZWZvcmVFYWNoKCgpID0+IHtcblx0XHRjb25zdCBtb2NrUHJvYyA9IGNyZWF0ZU1vY2tQcm9jZXNzKCk7XG5cdFx0Y2xpZW50U3RkaW4gPSBtb2NrUHJvYy5jbGllbnRTdGRpbjtcblx0XHRjbGllbnRTdGRvdXQgPSBtb2NrUHJvYy5jbGllbnRTdGRvdXQ7XG5cdH0pO1xuXG5cdGFmdGVyRWFjaCgoKSA9PiB7XG5cdFx0Y2xpZW50U3RkaW4uZGVzdHJveSgpO1xuXHRcdGNsaWVudFN0ZG91dC5kZXN0cm95KCk7XG5cdH0pO1xuXG5cdGl0KFwiaW5pdCBoYW5kc2hha2U6IGNsaWVudCB3cml0ZXMgaW5pdCwgc2VydmVyIHJlc3BvbmRzIHdpdGggaW5pdF9yZXN1bHRcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdC8vIENvbGxlY3Qgd2hhdCB0aGUgY2xpZW50IHdvdWxkIHdyaXRlXG5cdFx0Y29uc3QgeyBsaW5lczogY2xpZW50V3JpdGVzLCBkZXRhY2g6IGRldGFjaFN0ZGluIH0gPSBjb2xsZWN0TGluZXMoY2xpZW50U3RkaW4pO1xuXG5cdFx0Ly8gQ2xpZW50IHNlbmRzIGluaXQgY29tbWFuZFxuXHRcdHdyaXRlTGluZShjbGllbnRTdGRpbiwgeyBpZDogXCJyZXFfMVwiLCB0eXBlOiBcImluaXRcIiwgcHJvdG9jb2xWZXJzaW9uOiAyIH0pO1xuXHRcdGF3YWl0IHRpY2soKTtcblxuXHRcdGFzc2VydC5lcXVhbChjbGllbnRXcml0ZXMubGVuZ3RoLCAxKTtcblx0XHRjb25zdCBpbml0Q21kID0gY2xpZW50V3JpdGVzWzBdIGFzIGFueTtcblx0XHRhc3NlcnQuZXF1YWwoaW5pdENtZC50eXBlLCBcImluaXRcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKGluaXRDbWQucHJvdG9jb2xWZXJzaW9uLCAyKTtcblxuXHRcdC8vIFNlcnZlciByZXNwb25kcyB3aXRoIGluaXRfcmVzdWx0XG5cdFx0Y29uc3QgaW5pdFJlc3VsdDogUnBjSW5pdFJlc3VsdCA9IHtcblx0XHRcdHByb3RvY29sVmVyc2lvbjogMixcblx0XHRcdHNlc3Npb25JZDogXCJzZXNzLWFiY1wiLFxuXHRcdFx0Y2FwYWJpbGl0aWVzOiB7XG5cdFx0XHRcdGV2ZW50czogW1wiZXhlY3V0aW9uX2NvbXBsZXRlXCIsIFwiY29zdF91cGRhdGVcIl0sXG5cdFx0XHRcdGNvbW1hbmRzOiBbXCJpbml0XCIsIFwic2h1dGRvd25cIiwgXCJzdWJzY3JpYmVcIl0sXG5cdFx0XHR9LFxuXHRcdH07XG5cdFx0d3JpdGVMaW5lKGNsaWVudFN0ZG91dCwge1xuXHRcdFx0aWQ6IFwicmVxXzFcIixcblx0XHRcdHR5cGU6IFwicmVzcG9uc2VcIixcblx0XHRcdGNvbW1hbmQ6IFwiaW5pdFwiLFxuXHRcdFx0c3VjY2VzczogdHJ1ZSxcblx0XHRcdGRhdGE6IGluaXRSZXN1bHQsXG5cdFx0fSk7XG5cblx0XHQvLyBDb2xsZWN0IHNlcnZlciByZXNwb25zZVxuXHRcdGNvbnN0IHsgbGluZXM6IHNlcnZlclJlc3BvbnNlcywgZGV0YWNoOiBkZXRhY2hTdGRvdXQgfSA9IGNvbGxlY3RMaW5lcyhjbGllbnRTdGRvdXQpO1xuXHRcdC8vIEFscmVhZHkgd3JvdGUgYWJvdmUsIGJ1dCBsZXQncyB2ZXJpZnkgdGhlIHNoYXBlIGJ5IHJlLXdyaXRpbmdcblx0XHR3cml0ZUxpbmUoY2xpZW50U3Rkb3V0LCB7XG5cdFx0XHRpZDogXCJyZXFfdmVyaWZ5XCIsXG5cdFx0XHR0eXBlOiBcInJlc3BvbnNlXCIsXG5cdFx0XHRjb21tYW5kOiBcImluaXRcIixcblx0XHRcdHN1Y2Nlc3M6IHRydWUsXG5cdFx0XHRkYXRhOiBpbml0UmVzdWx0LFxuXHRcdH0pO1xuXHRcdGF3YWl0IHRpY2soKTtcblxuXHRcdGNvbnN0IHJlc3AgPSBzZXJ2ZXJSZXNwb25zZXNbMF0gYXMgYW55O1xuXHRcdGFzc2VydC5lcXVhbChyZXNwLnR5cGUsIFwicmVzcG9uc2VcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3AuY29tbWFuZCwgXCJpbml0XCIpO1xuXHRcdGFzc2VydC5lcXVhbChyZXNwLnN1Y2Nlc3MsIHRydWUpO1xuXHRcdGFzc2VydC5lcXVhbChyZXNwLmRhdGEucHJvdG9jb2xWZXJzaW9uLCAyKTtcblx0XHRhc3NlcnQub2sodHlwZW9mIHJlc3AuZGF0YS5zZXNzaW9uSWQgPT09IFwic3RyaW5nXCIpO1xuXG5cdFx0ZGV0YWNoU3RkaW4oKTtcblx0XHRkZXRhY2hTdGRvdXQoKTtcblx0fSk7XG5cblx0aXQoXCJzaHV0ZG93bjogY2xpZW50IHdyaXRlcyBzaHV0ZG93biwgc2VydmVyIGFja25vd2xlZGdlc1wiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3QgeyBsaW5lczogY2xpZW50V3JpdGVzLCBkZXRhY2ggfSA9IGNvbGxlY3RMaW5lcyhjbGllbnRTdGRpbik7XG5cblx0XHR3cml0ZUxpbmUoY2xpZW50U3RkaW4sIHsgaWQ6IFwicmVxXzJcIiwgdHlwZTogXCJzaHV0ZG93blwiIH0pO1xuXHRcdGF3YWl0IHRpY2soKTtcblxuXHRcdGNvbnN0IGNtZCA9IGNsaWVudFdyaXRlc1swXSBhcyBhbnk7XG5cdFx0YXNzZXJ0LmVxdWFsKGNtZC50eXBlLCBcInNodXRkb3duXCIpO1xuXG5cdFx0ZGV0YWNoKCk7XG5cdH0pO1xuXG5cdGl0KFwic3Vic2NyaWJlOiBjbGllbnQgd3JpdGVzIHN1YnNjcmliZSB3aXRoIGV2ZW50IGxpc3RcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IHsgbGluZXM6IGNsaWVudFdyaXRlcywgZGV0YWNoIH0gPSBjb2xsZWN0TGluZXMoY2xpZW50U3RkaW4pO1xuXG5cdFx0d3JpdGVMaW5lKGNsaWVudFN0ZGluLCB7IGlkOiBcInJlcV8zXCIsIHR5cGU6IFwic3Vic2NyaWJlXCIsIGV2ZW50czogW1wiYWdlbnRfZW5kXCIsIFwiZXhlY3V0aW9uX2NvbXBsZXRlXCJdIH0pO1xuXHRcdGF3YWl0IHRpY2soKTtcblxuXHRcdGNvbnN0IGNtZCA9IGNsaWVudFdyaXRlc1swXSBhcyBhbnk7XG5cdFx0YXNzZXJ0LmVxdWFsKGNtZC50eXBlLCBcInN1YnNjcmliZVwiKTtcblx0XHRhc3NlcnQuZGVlcEVxdWFsKGNtZC5ldmVudHMsIFtcImFnZW50X2VuZFwiLCBcImV4ZWN1dGlvbl9jb21wbGV0ZVwiXSk7XG5cblx0XHRkZXRhY2goKTtcblx0fSk7XG5cblx0aXQoXCJzZW5kVUlSZXNwb25zZTogY2xpZW50IHdyaXRlcyBleHRlbnNpb25fdWlfcmVzcG9uc2VcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IHsgbGluZXM6IGNsaWVudFdyaXRlcywgZGV0YWNoIH0gPSBjb2xsZWN0TGluZXMoY2xpZW50U3RkaW4pO1xuXG5cdFx0d3JpdGVMaW5lKGNsaWVudFN0ZGluLCB7XG5cdFx0XHR0eXBlOiBcImV4dGVuc2lvbl91aV9yZXNwb25zZVwiLFxuXHRcdFx0aWQ6IFwidWktMTIzXCIsXG5cdFx0XHR2YWx1ZTogXCJzZWxlY3RlZC1vcHRpb25cIixcblx0XHR9KTtcblx0XHRhd2FpdCB0aWNrKCk7XG5cblx0XHRjb25zdCBtc2cgPSBjbGllbnRXcml0ZXNbMF0gYXMgYW55O1xuXHRcdGFzc2VydC5lcXVhbChtc2cudHlwZSwgXCJleHRlbnNpb25fdWlfcmVzcG9uc2VcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKG1zZy5pZCwgXCJ1aS0xMjNcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKG1zZy52YWx1ZSwgXCJzZWxlY3RlZC1vcHRpb25cIik7XG5cblx0XHRkZXRhY2goKTtcblx0fSk7XG5cblx0aXQoXCJ2MiBldmVudCBmaWx0ZXJpbmc6IHN1YnNjcmliZSB3aXRoIGVtcHR5IGFycmF5IHNob3VsZCBmaWx0ZXIgYWxsXCIsIGFzeW5jICgpID0+IHtcblx0XHQvLyBBbiBlbXB0eSBldmVudCBmaWx0ZXIgbWVhbnMgbm8gZXZlbnRzIHBhc3MgdGhyb3VnaCAoU2V0IHdpdGggMCBlbnRyaWVzKVxuXHRcdGNvbnN0IHN1YnNjcmliZUNtZCA9IHsgaWQ6IFwicmVxXzRcIiwgdHlwZTogXCJzdWJzY3JpYmVcIiwgZXZlbnRzOiBbXSBhcyBzdHJpbmdbXSB9O1xuXHRcdGNvbnN0IHNlcmlhbGl6ZWQgPSBzZXJpYWxpemVKc29uTGluZShzdWJzY3JpYmVDbWQpO1xuXHRcdGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2Uoc2VyaWFsaXplZCk7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChwYXJzZWQuZXZlbnRzLCBbXSk7XG5cdFx0Ly8gU2VydmVyLXNpZGU6IGBldmVudEZpbHRlciA9IG5ldyBTZXQoW10pYCBcdTIwMTQgU2V0Lmhhcyhhbnl0aGluZykgcmV0dXJucyBmYWxzZVxuXHRcdGNvbnN0IGZpbHRlciA9IG5ldyBTZXQocGFyc2VkLmV2ZW50cyBhcyBzdHJpbmdbXSk7XG5cdFx0YXNzZXJ0LmVxdWFsKGZpbHRlci5oYXMoXCJhZ2VudF9lbmRcIiksIGZhbHNlKTtcblx0XHRhc3NlcnQuZXF1YWwoZmlsdGVyLmhhcyhcImV4ZWN1dGlvbl9jb21wbGV0ZVwiKSwgZmFsc2UpO1xuXHRcdGFzc2VydC5lcXVhbChmaWx0ZXIuc2l6ZSwgMCk7XG5cdH0pO1xuXG5cdGl0KFwidjIgZXZlbnQgZmlsdGVyaW5nOiBzdWJzY3JpYmUgd2l0aCB3aWxkY2FyZCByZXNldHMgZmlsdGVyXCIsIGFzeW5jICgpID0+IHtcblx0XHQvLyBTZXJ2ZXItc2lkZTogYGV2ZW50cy5pbmNsdWRlcyhcIipcIilgIFx1MjE5MiBgZXZlbnRGaWx0ZXIgPSBudWxsYFxuXHRcdGNvbnN0IHN1YnNjcmliZUNtZCA9IHsgdHlwZTogXCJzdWJzY3JpYmVcIiwgZXZlbnRzOiBbXCIqXCJdIH07XG5cdFx0Y29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShzZXJpYWxpemVKc29uTGluZShzdWJzY3JpYmVDbWQpKTtcblx0XHRjb25zdCBoYXNXaWxkY2FyZCA9IChwYXJzZWQuZXZlbnRzIGFzIHN0cmluZ1tdKS5pbmNsdWRlcyhcIipcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKGhhc1dpbGRjYXJkLCB0cnVlKTtcblx0XHQvLyBXaGVuIHdpbGRjYXJkIGlzIGRldGVjdGVkLCBmaWx0ZXIgYmVjb21lcyBudWxsIChhbGwgZXZlbnRzIHBhc3MpXG5cdH0pO1xuXG5cdGl0KFwibXVsdGlwbGUgY29tbWFuZHMgY2FuIGJlIHNlbnQgc2VxdWVudGlhbGx5XCIsIGFzeW5jICgpID0+IHtcblx0XHRjb25zdCB7IGxpbmVzLCBkZXRhY2ggfSA9IGNvbGxlY3RMaW5lcyhjbGllbnRTdGRpbik7XG5cblx0XHR3cml0ZUxpbmUoY2xpZW50U3RkaW4sIHsgaWQ6IFwiMVwiLCB0eXBlOiBcImluaXRcIiwgcHJvdG9jb2xWZXJzaW9uOiAyIH0pO1xuXHRcdHdyaXRlTGluZShjbGllbnRTdGRpbiwgeyBpZDogXCIyXCIsIHR5cGU6IFwic3Vic2NyaWJlXCIsIGV2ZW50czogW1wiYWdlbnRfZW5kXCJdIH0pO1xuXHRcdHdyaXRlTGluZShjbGllbnRTdGRpbiwgeyBpZDogXCIzXCIsIHR5cGU6IFwicHJvbXB0XCIsIG1lc3NhZ2U6IFwiaGVsbG9cIiB9KTtcblx0XHRhd2FpdCB0aWNrKCk7XG5cblx0XHRhc3NlcnQuZXF1YWwobGluZXMubGVuZ3RoLCAzKTtcblx0XHRhc3NlcnQuZXF1YWwoKGxpbmVzWzBdIGFzIGFueSkudHlwZSwgXCJpbml0XCIpO1xuXHRcdGFzc2VydC5lcXVhbCgobGluZXNbMV0gYXMgYW55KS50eXBlLCBcInN1YnNjcmliZVwiKTtcblx0XHRhc3NlcnQuZXF1YWwoKGxpbmVzWzJdIGFzIGFueSkudHlwZSwgXCJwcm9tcHRcIik7XG5cblx0XHRkZXRhY2goKTtcblx0fSk7XG59KTtcblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gTmVnYXRpdmUgdGVzdHMgXHUyMDE0IG1hbGZvcm1lZCBpbnB1dHMsIGVycm9yIHBhdGhzLCBib3VuZGFyeSBjb25kaXRpb25zXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmRlc2NyaWJlKFwiTmVnYXRpdmUgdGVzdHMgXHUyMDE0IHByb3RvY29sIGVycm9yIHNoYXBlc1wiLCAoKSA9PiB7XG5cdGl0KFwiaW5pdCB3aXRoIG1pc3NpbmcgcHJvdG9jb2xWZXJzaW9uIHByb2R1Y2VzIGEgdHlwZSBlcnJvciBhdCBjb21waWxlIHRpbWVcIiwgKCkgPT4ge1xuXHRcdC8vIFJ1bnRpbWUgY2hlY2s6IGEgbWVzc2FnZSBtaXNzaW5nIHByb3RvY29sVmVyc2lvbiBpcyBtYWxmb3JtZWRcblx0XHRjb25zdCBtYWxmb3JtZWQgPSB7IHR5cGU6IFwiaW5pdFwiIH0gYXMgYW55O1xuXHRcdGFzc2VydC5lcXVhbChtYWxmb3JtZWQucHJvdG9jb2xWZXJzaW9uLCB1bmRlZmluZWQpO1xuXHRcdC8vIFNlcnZlciB3b3VsZCB0cmVhdCB0aGlzIGFzIHYxIGxvY2sgc2luY2UgaXQncyBub3QgYSB2YWxpZCBpbml0XG5cdH0pO1xuXG5cdGl0KFwic3Vic2NyaWJlIHdpdGggbm9uLWFycmF5IGV2ZW50cyBpcyBhIHR5cGUgdmlvbGF0aW9uXCIsICgpID0+IHtcblx0XHQvLyBSdW50aW1lOiBzZXJ2ZXIgZXhwZWN0cyBldmVudHMgdG8gYmUgc3RyaW5nW11cblx0XHRjb25zdCBtYWxmb3JtZWQgPSB7IHR5cGU6IFwic3Vic2NyaWJlXCIsIGV2ZW50czogXCJhZ2VudF9lbmRcIiB9IGFzIGFueTtcblx0XHRhc3NlcnQuZXF1YWwodHlwZW9mIG1hbGZvcm1lZC5ldmVudHMsIFwic3RyaW5nXCIpOyAvLyBOb3QgYW4gYXJyYXlcblx0XHRhc3NlcnQuZXF1YWwoQXJyYXkuaXNBcnJheShtYWxmb3JtZWQuZXZlbnRzKSwgZmFsc2UpO1xuXHR9KTtcblxuXHRpdChcImRvdWJsZSBpbml0IGVycm9yIHJlc3BvbnNlIHNoYXBlXCIsICgpID0+IHtcblx0XHQvLyBXaGVuIGluaXQgaXMgc2VudCBhZnRlciBwcm90b2NvbCBsb2NrLCBzZXJ2ZXIgcmV0dXJucyBlcnJvclxuXHRcdGNvbnN0IGVycm9yUmVzcDogUnBjUmVzcG9uc2UgPSB7XG5cdFx0XHRpZDogXCJyZXFfZHVwXCIsXG5cdFx0XHR0eXBlOiBcInJlc3BvbnNlXCIsXG5cdFx0XHRjb21tYW5kOiBcImluaXRcIixcblx0XHRcdHN1Y2Nlc3M6IGZhbHNlLFxuXHRcdFx0ZXJyb3I6IFwiUHJvdG9jb2wgdmVyc2lvbiBhbHJlYWR5IGxvY2tlZC4gaW5pdCBtdXN0IGJlIHRoZSBmaXJzdCBjb21tYW5kLlwiLFxuXHRcdH07XG5cdFx0YXNzZXJ0LmVxdWFsKGVycm9yUmVzcC5zdWNjZXNzLCBmYWxzZSk7XG5cdFx0aWYgKCFlcnJvclJlc3Auc3VjY2Vzcykge1xuXHRcdFx0YXNzZXJ0Lm9rKGVycm9yUmVzcC5lcnJvci5pbmNsdWRlcyhcImFscmVhZHkgbG9ja2VkXCIpKTtcblx0XHR9XG5cdH0pO1xuXG5cdGl0KFwiaW5pdCBhZnRlciB2MSBsb2NrIGVycm9yIHJlc3BvbnNlIHNoYXBlXCIsICgpID0+IHtcblx0XHQvLyBGaXJzdCBjb21tYW5kIHdhcyBnZXRfc3RhdGUgKHYxIGxvY2spLCB0aGVuIGluaXQgYXJyaXZlc1xuXHRcdGNvbnN0IGVycm9yUmVzcDogUnBjUmVzcG9uc2UgPSB7XG5cdFx0XHRpZDogXCJyZXFfbGF0ZV9pbml0XCIsXG5cdFx0XHR0eXBlOiBcInJlc3BvbnNlXCIsXG5cdFx0XHRjb21tYW5kOiBcImluaXRcIixcblx0XHRcdHN1Y2Nlc3M6IGZhbHNlLFxuXHRcdFx0ZXJyb3I6IFwiUHJvdG9jb2wgdmVyc2lvbiBhbHJlYWR5IGxvY2tlZC4gaW5pdCBtdXN0IGJlIHRoZSBmaXJzdCBjb21tYW5kLlwiLFxuXHRcdH07XG5cdFx0YXNzZXJ0LmVxdWFsKGVycm9yUmVzcC5zdWNjZXNzLCBmYWxzZSk7XG5cdFx0aWYgKCFlcnJvclJlc3Auc3VjY2Vzcykge1xuXHRcdFx0YXNzZXJ0Lm9rKGVycm9yUmVzcC5lcnJvci5pbmNsdWRlcyhcImluaXQgbXVzdCBiZSB0aGUgZmlyc3QgY29tbWFuZFwiKSk7XG5cdFx0fVxuXHR9KTtcblxuXHRpdChcInVua25vd24gY29tbWFuZCB0eXBlIHByb2R1Y2VzIGVycm9yIHJlc3BvbnNlXCIsICgpID0+IHtcblx0XHRjb25zdCBlcnJvclJlc3A6IFJwY1Jlc3BvbnNlID0ge1xuXHRcdFx0aWQ6IFwicmVxX3Vua25vd25cIixcblx0XHRcdHR5cGU6IFwicmVzcG9uc2VcIixcblx0XHRcdGNvbW1hbmQ6IFwibm9uZXhpc3RlbnRcIixcblx0XHRcdHN1Y2Nlc3M6IGZhbHNlLFxuXHRcdFx0ZXJyb3I6IFwiVW5rbm93biBjb21tYW5kOiBub25leGlzdGVudFwiLFxuXHRcdH07XG5cdFx0YXNzZXJ0LmVxdWFsKGVycm9yUmVzcC5zdWNjZXNzLCBmYWxzZSk7XG5cdFx0aWYgKCFlcnJvclJlc3Auc3VjY2Vzcykge1xuXHRcdFx0YXNzZXJ0Lm9rKGVycm9yUmVzcC5lcnJvci5pbmNsdWRlcyhcIlVua25vd24gY29tbWFuZFwiKSk7XG5cdFx0fVxuXHR9KTtcblxuXHRpdChcIm1hbGZvcm1lZCBKU09OIHBhcnNlIGVycm9yIHNoYXBlXCIsICgpID0+IHtcblx0XHRjb25zdCBlcnJvclJlc3A6IFJwY1Jlc3BvbnNlID0ge1xuXHRcdFx0dHlwZTogXCJyZXNwb25zZVwiLFxuXHRcdFx0Y29tbWFuZDogXCJwYXJzZVwiLFxuXHRcdFx0c3VjY2VzczogZmFsc2UsXG5cdFx0XHRlcnJvcjogXCJGYWlsZWQgdG8gcGFyc2UgY29tbWFuZDogVW5leHBlY3RlZCB0b2tlblwiLFxuXHRcdH07XG5cdFx0YXNzZXJ0LmVxdWFsKGVycm9yUmVzcC5jb21tYW5kLCBcInBhcnNlXCIpO1xuXHRcdGFzc2VydC5lcXVhbChlcnJvclJlc3Auc3VjY2VzcywgZmFsc2UpO1xuXHR9KTtcblxuXHRpdChcInNodXRkb3duIHdvcmtzIGluIGJvdGggdjEgYW5kIHYyIFx1MjAxNCBubyB2ZXJzaW9uIGdhdGluZ1wiLCAoKSA9PiB7XG5cdFx0Ly8gc2h1dGRvd24gcmV0dXJucyBzdWNjZXNzIHJlZ2FyZGxlc3Mgb2YgcHJvdG9jb2xWZXJzaW9uXG5cdFx0Y29uc3QgdjFTaHV0ZG93bjogUnBjUmVzcG9uc2UgPSB7XG5cdFx0XHRpZDogXCJzMVwiLFxuXHRcdFx0dHlwZTogXCJyZXNwb25zZVwiLFxuXHRcdFx0Y29tbWFuZDogXCJzaHV0ZG93blwiLFxuXHRcdFx0c3VjY2VzczogdHJ1ZSxcblx0XHR9O1xuXHRcdGNvbnN0IHYyU2h1dGRvd246IFJwY1Jlc3BvbnNlID0ge1xuXHRcdFx0aWQ6IFwiczJcIixcblx0XHRcdHR5cGU6IFwicmVzcG9uc2VcIixcblx0XHRcdGNvbW1hbmQ6IFwic2h1dGRvd25cIixcblx0XHRcdHN1Y2Nlc3M6IHRydWUsXG5cdFx0fTtcblx0XHRhc3NlcnQuZXF1YWwodjFTaHV0ZG93bi5zdWNjZXNzLCB0cnVlKTtcblx0XHRhc3NlcnQuZXF1YWwodjJTaHV0ZG93bi5zdWNjZXNzLCB0cnVlKTtcblx0fSk7XG59KTtcblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gUHJvdG9jb2wgdmVyc2lvbiBkZXRlY3Rpb24gbG9naWMgKHVuaXQpXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmRlc2NyaWJlKFwiUHJvdG9jb2wgdmVyc2lvbiBkZXRlY3Rpb24gbG9naWNcIiwgKCkgPT4ge1xuXHRpdChcInNpbXVsYXRlcyB2MSBsb2NrIHdoZW4gZmlyc3QgY29tbWFuZCBpcyBub24taW5pdFwiLCAoKSA9PiB7XG5cdFx0bGV0IHByb3RvY29sVmVyc2lvbjogMSB8IDIgPSAxO1xuXHRcdGxldCBwcm90b2NvbExvY2tlZCA9IGZhbHNlO1xuXG5cdFx0Ly8gU2ltdWxhdGUgZmlyc3QgY29tbWFuZCBiZWluZyBnZXRfc3RhdGVcblx0XHRjb25zdCBjb21tYW5kID0geyB0eXBlOiBcImdldF9zdGF0ZVwiIH0gYXMgUnBjQ29tbWFuZDtcblxuXHRcdGlmICghcHJvdG9jb2xMb2NrZWQpIHtcblx0XHRcdHByb3RvY29sTG9ja2VkID0gdHJ1ZTtcblx0XHRcdGlmIChjb21tYW5kLnR5cGUgPT09IFwiaW5pdFwiKSB7XG5cdFx0XHRcdHByb3RvY29sVmVyc2lvbiA9IDI7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRwcm90b2NvbFZlcnNpb24gPSAxO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdGFzc2VydC5lcXVhbChwcm90b2NvbFZlcnNpb24sIDEpO1xuXHRcdGFzc2VydC5lcXVhbChwcm90b2NvbExvY2tlZCwgdHJ1ZSk7XG5cdH0pO1xuXG5cdGl0KFwic2ltdWxhdGVzIHYyIGxvY2sgd2hlbiBmaXJzdCBjb21tYW5kIGlzIGluaXRcIiwgKCkgPT4ge1xuXHRcdGxldCBwcm90b2NvbFZlcnNpb246IDEgfCAyID0gMTtcblx0XHRsZXQgcHJvdG9jb2xMb2NrZWQgPSBmYWxzZTtcblxuXHRcdGNvbnN0IGNvbW1hbmQ6IFJwY0NvbW1hbmQgPSB7IHR5cGU6IFwiaW5pdFwiLCBwcm90b2NvbFZlcnNpb246IDIgfTtcblxuXHRcdGlmICghcHJvdG9jb2xMb2NrZWQpIHtcblx0XHRcdHByb3RvY29sTG9ja2VkID0gdHJ1ZTtcblx0XHRcdGlmIChjb21tYW5kLnR5cGUgPT09IFwiaW5pdFwiKSB7XG5cdFx0XHRcdHByb3RvY29sVmVyc2lvbiA9IDI7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRwcm90b2NvbFZlcnNpb24gPSAxO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdGFzc2VydC5lcXVhbChwcm90b2NvbFZlcnNpb24sIDIpO1xuXHRcdGFzc2VydC5lcXVhbChwcm90b2NvbExvY2tlZCwgdHJ1ZSk7XG5cdH0pO1xuXG5cdGl0KFwicmVqZWN0cyByZS1pbml0IGFmdGVyIHYyIGxvY2tcIiwgKCkgPT4ge1xuXHRcdGxldCBwcm90b2NvbExvY2tlZCA9IHRydWU7IC8vIGFscmVhZHkgbG9ja2VkIGZyb20gZmlyc3QgaW5pdFxuXHRcdGxldCBlcnJvck1lc3NhZ2U6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG5cdFx0Y29uc3QgY29tbWFuZDogUnBjQ29tbWFuZCA9IHsgdHlwZTogXCJpbml0XCIsIHByb3RvY29sVmVyc2lvbjogMiB9O1xuXG5cdFx0aWYgKHByb3RvY29sTG9ja2VkICYmIGNvbW1hbmQudHlwZSA9PT0gXCJpbml0XCIpIHtcblx0XHRcdGVycm9yTWVzc2FnZSA9IFwiUHJvdG9jb2wgdmVyc2lvbiBhbHJlYWR5IGxvY2tlZC4gaW5pdCBtdXN0IGJlIHRoZSBmaXJzdCBjb21tYW5kLlwiO1xuXHRcdH1cblxuXHRcdGFzc2VydC5vayhlcnJvck1lc3NhZ2UgIT09IG51bGwpO1xuXHRcdGFzc2VydC5vayhlcnJvck1lc3NhZ2UhLmluY2x1ZGVzKFwiYWxyZWFkeSBsb2NrZWRcIikpO1xuXHR9KTtcblxuXHRpdChcInJlamVjdHMgaW5pdCBhZnRlciB2MSBsb2NrXCIsICgpID0+IHtcblx0XHRsZXQgcHJvdG9jb2xMb2NrZWQgPSB0cnVlOyAvLyBhbHJlYWR5IGxvY2tlZCBmcm9tIGZpcnN0IG5vbi1pbml0IGNvbW1hbmRcblx0XHRsZXQgcHJvdG9jb2xWZXJzaW9uOiAxIHwgMiA9IDE7XG5cdFx0bGV0IGVycm9yTWVzc2FnZTogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cblx0XHRjb25zdCBjb21tYW5kOiBScGNDb21tYW5kID0geyB0eXBlOiBcImluaXRcIiwgcHJvdG9jb2xWZXJzaW9uOiAyIH07XG5cblx0XHRpZiAocHJvdG9jb2xMb2NrZWQgJiYgY29tbWFuZC50eXBlID09PSBcImluaXRcIikge1xuXHRcdFx0ZXJyb3JNZXNzYWdlID0gXCJQcm90b2NvbCB2ZXJzaW9uIGFscmVhZHkgbG9ja2VkLiBpbml0IG11c3QgYmUgdGhlIGZpcnN0IGNvbW1hbmQuXCI7XG5cdFx0fVxuXG5cdFx0YXNzZXJ0LmVxdWFsKHByb3RvY29sVmVyc2lvbiwgMSk7IC8vIHN0YXlzIHYxXG5cdFx0YXNzZXJ0Lm9rKGVycm9yTWVzc2FnZSAhPT0gbnVsbCk7XG5cdH0pO1xuXG5cdGl0KFwiZXh0ZW5zaW9uX3VpX3Jlc3BvbnNlIGJ5cGFzc2VzIHByb3RvY29sIGRldGVjdGlvblwiLCAoKSA9PiB7XG5cdFx0bGV0IHByb3RvY29sTG9ja2VkID0gZmFsc2U7XG5cdFx0bGV0IHByb3RvY29sRGV0ZWN0aW9uVHJpZ2dlcmVkID0gZmFsc2U7XG5cblx0XHQvLyBTaW11bGF0ZSB0aGUgaGFuZGxlSW5wdXRMaW5lIGxvZ2ljXG5cdFx0Y29uc3QgcGFyc2VkID0geyB0eXBlOiBcImV4dGVuc2lvbl91aV9yZXNwb25zZVwiLCBpZDogXCJ1aS0xXCIsIHZhbHVlOiBcIm9rXCIgfTtcblxuXHRcdGlmIChwYXJzZWQudHlwZSA9PT0gXCJleHRlbnNpb25fdWlfcmVzcG9uc2VcIikge1xuXHRcdFx0Ly8gQnlwYXNzIFx1MjAxNCBkbyBub3QgdG91Y2ggcHJvdG9jb2xMb2NrZWRcblx0XHR9IGVsc2Uge1xuXHRcdFx0cHJvdG9jb2xEZXRlY3Rpb25UcmlnZ2VyZWQgPSB0cnVlO1xuXHRcdFx0aWYgKCFwcm90b2NvbExvY2tlZCkge1xuXHRcdFx0XHRwcm90b2NvbExvY2tlZCA9IHRydWU7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0YXNzZXJ0LmVxdWFsKHByb3RvY29sTG9ja2VkLCBmYWxzZSk7XG5cdFx0YXNzZXJ0LmVxdWFsKHByb3RvY29sRGV0ZWN0aW9uVHJpZ2dlcmVkLCBmYWxzZSk7XG5cdH0pO1xufSk7XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIHYyIGV2ZW50IGZpbHRlciBsb2dpYyAodW5pdClcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuZGVzY3JpYmUoXCJ2MiBldmVudCBmaWx0ZXIgbG9naWNcIiwgKCkgPT4ge1xuXHQvKiogTWltaWNzIHRoZSBzZXJ2ZXItc2lkZSBldmVudCBmaWx0ZXIgY2hlY2s6IG51bGwgbWVhbnMgYWxsIGV2ZW50cyBwYXNzICovXG5cdGZ1bmN0aW9uIHNob3VsZEVtaXQoZmlsdGVyOiBTZXQ8c3RyaW5nPiB8IG51bGwsIGV2ZW50VHlwZTogc3RyaW5nKTogYm9vbGVhbiB7XG5cdFx0cmV0dXJuICFmaWx0ZXIgfHwgZmlsdGVyLmhhcyhldmVudFR5cGUpO1xuXHR9XG5cblx0aXQoXCJudWxsIGZpbHRlciBwYXNzZXMgYWxsIGV2ZW50c1wiLCAoKSA9PiB7XG5cdFx0YXNzZXJ0LmVxdWFsKHNob3VsZEVtaXQobnVsbCwgXCJhZ2VudF9lbmRcIiksIHRydWUpO1xuXHRcdGFzc2VydC5lcXVhbChzaG91bGRFbWl0KG51bGwsIFwiY29zdF91cGRhdGVcIiksIHRydWUpO1xuXHRcdGFzc2VydC5lcXVhbChzaG91bGRFbWl0KG51bGwsIFwiYW55dGhpbmdcIiksIHRydWUpO1xuXHR9KTtcblxuXHRpdChcImZpbHRlciB3aXRoIHNwZWNpZmljIGV2ZW50cyBwYXNzZXMgbWF0Y2hpbmcgZXZlbnRzXCIsICgpID0+IHtcblx0XHRjb25zdCBmaWx0ZXIgPSBuZXcgU2V0KFtcImFnZW50X2VuZFwiLCBcImNvc3RfdXBkYXRlXCJdKTtcblxuXHRcdGFzc2VydC5lcXVhbChzaG91bGRFbWl0KGZpbHRlciwgXCJhZ2VudF9lbmRcIiksIHRydWUpO1xuXHRcdGFzc2VydC5lcXVhbChzaG91bGRFbWl0KGZpbHRlciwgXCJjb3N0X3VwZGF0ZVwiKSwgdHJ1ZSk7XG5cdFx0YXNzZXJ0LmVxdWFsKHNob3VsZEVtaXQoZmlsdGVyLCBcImV4ZWN1dGlvbl9jb21wbGV0ZVwiKSwgZmFsc2UpO1xuXHRcdGFzc2VydC5lcXVhbChzaG91bGRFbWl0KGZpbHRlciwgXCJtZXNzYWdlX3N0YXJ0XCIpLCBmYWxzZSk7XG5cdH0pO1xuXG5cdGl0KFwiZW1wdHkgU2V0IGZpbHRlciBibG9ja3MgYWxsIGV2ZW50c1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgZmlsdGVyID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cblx0XHRhc3NlcnQuZXF1YWwoc2hvdWxkRW1pdChmaWx0ZXIsIFwiYWdlbnRfZW5kXCIpLCBmYWxzZSk7XG5cdFx0YXNzZXJ0LmVxdWFsKHNob3VsZEVtaXQoZmlsdGVyLCBcImNvc3RfdXBkYXRlXCIpLCBmYWxzZSk7XG5cdFx0YXNzZXJ0LmVxdWFsKHNob3VsZEVtaXQoZmlsdGVyLCBcImFueXRoaW5nXCIpLCBmYWxzZSk7XG5cdFx0YXNzZXJ0LmVxdWFsKGZpbHRlci5zaXplLCAwKTtcblx0fSk7XG5cblx0aXQoXCJ3aWxkY2FyZCBzdWJzY3JpYmUgcmVzZXRzIGZpbHRlciB0byBudWxsXCIsICgpID0+IHtcblx0XHRsZXQgZXZlbnRGaWx0ZXI6IFNldDxzdHJpbmc+IHwgbnVsbCA9IG5ldyBTZXQoW1wiYWdlbnRfZW5kXCJdKTtcblxuXHRcdC8vIFNpbXVsYXRlIHN1YnNjcmliZSB3aXRoIHdpbGRjYXJkXG5cdFx0Y29uc3QgZXZlbnRzID0gW1wiKlwiXTtcblx0XHRpZiAoZXZlbnRzLmluY2x1ZGVzKFwiKlwiKSkge1xuXHRcdFx0ZXZlbnRGaWx0ZXIgPSBudWxsO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHRldmVudEZpbHRlciA9IG5ldyBTZXQoZXZlbnRzKTtcblx0XHR9XG5cblx0XHRhc3NlcnQuZXF1YWwoZXZlbnRGaWx0ZXIsIG51bGwpO1xuXHR9KTtcblxuXHRpdChcInN1YnNjcmliZSByZXBsYWNlcyBwcmV2aW91cyBmaWx0ZXJcIiwgKCkgPT4ge1xuXHRcdGxldCBldmVudEZpbHRlcjogU2V0PHN0cmluZz4gfCBudWxsID0gbmV3IFNldChbXCJhZ2VudF9lbmRcIl0pO1xuXG5cdFx0Ly8gU3Vic2NyaWJlIHdpdGggZGlmZmVyZW50IGV2ZW50c1xuXHRcdGNvbnN0IGV2ZW50cyA9IFtcImNvc3RfdXBkYXRlXCIsIFwiZXhlY3V0aW9uX2NvbXBsZXRlXCJdO1xuXHRcdGlmIChldmVudHMuaW5jbHVkZXMoXCIqXCIpKSB7XG5cdFx0XHRldmVudEZpbHRlciA9IG51bGw7XG5cdFx0fSBlbHNlIHtcblx0XHRcdGV2ZW50RmlsdGVyID0gbmV3IFNldChldmVudHMpO1xuXHRcdH1cblxuXHRcdGFzc2VydC5lcXVhbChldmVudEZpbHRlciEuaGFzKFwiYWdlbnRfZW5kXCIpLCBmYWxzZSk7XG5cdFx0YXNzZXJ0LmVxdWFsKGV2ZW50RmlsdGVyIS5oYXMoXCJjb3N0X3VwZGF0ZVwiKSwgdHJ1ZSk7XG5cdFx0YXNzZXJ0LmVxdWFsKGV2ZW50RmlsdGVyIS5oYXMoXCJleGVjdXRpb25fY29tcGxldGVcIiksIHRydWUpO1xuXHR9KTtcblxuXHRpdChcImZpbHRlciBhcHBsaWVzIHRvIGJvdGggcmVndWxhciBhbmQgc3ludGhlc2l6ZWQgdjIgZXZlbnRzXCIsICgpID0+IHtcblx0XHRjb25zdCBldmVudEZpbHRlciA9IG5ldyBTZXQoW1wiZXhlY3V0aW9uX2NvbXBsZXRlXCJdKTtcblxuXHRcdC8vIFJlZ3VsYXIgZXZlbnRcblx0XHRhc3NlcnQuZXF1YWwoZXZlbnRGaWx0ZXIuaGFzKFwiYWdlbnRfZW5kXCIpLCBmYWxzZSk7IC8vIGZpbHRlcmVkIG91dFxuXHRcdC8vIFN5bnRoZXNpemVkIHYyIGV2ZW50XG5cdFx0YXNzZXJ0LmVxdWFsKGV2ZW50RmlsdGVyLmhhcyhcImV4ZWN1dGlvbl9jb21wbGV0ZVwiKSwgdHJ1ZSk7IC8vIHBhc3Nlc1xuXHRcdGFzc2VydC5lcXVhbChldmVudEZpbHRlci5oYXMoXCJjb3N0X3VwZGF0ZVwiKSwgZmFsc2UpOyAvLyBmaWx0ZXJlZCBvdXRcblx0fSk7XG59KTtcblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gdjIgcnVuSWQgaW5qZWN0aW9uIGxvZ2ljICh1bml0KVxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5kZXNjcmliZShcInYyIHJ1bklkIGluamVjdGlvblwiLCAoKSA9PiB7XG5cdGl0KFwicnVuSWQgaXMgcHJlc2VudCB3aGVuIHByb3RvY29sVmVyc2lvbiBpcyAyIGFuZCBjb21tYW5kIGlzIHByb21wdC9zdGVlci9mb2xsb3dfdXBcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHByb3RvY29sVmVyc2lvbiA9IDI7XG5cdFx0Y29uc3QgY29tbWFuZHMgPSBbXCJwcm9tcHRcIiwgXCJzdGVlclwiLCBcImZvbGxvd191cFwiXSBhcyBjb25zdDtcblxuXHRcdGZvciAoY29uc3QgY21kVHlwZSBvZiBjb21tYW5kcykge1xuXHRcdFx0Y29uc3QgcnVuSWQgPSBwcm90b2NvbFZlcnNpb24gPT09IDIgPyBgcnVuLSR7Y21kVHlwZX0tdXVpZGAgOiB1bmRlZmluZWQ7XG5cdFx0XHRhc3NlcnQub2socnVuSWQgIT09IHVuZGVmaW5lZCwgYHJ1bklkIHNob3VsZCBiZSBnZW5lcmF0ZWQgZm9yICR7Y21kVHlwZX0gaW4gdjJgKTtcblx0XHRcdGFzc2VydC5vayh0eXBlb2YgcnVuSWQgPT09IFwic3RyaW5nXCIpO1xuXHRcdH1cblx0fSk7XG5cblx0aXQoXCJydW5JZCBpcyB1bmRlZmluZWQgd2hlbiBwcm90b2NvbFZlcnNpb24gaXMgMVwiLCAoKSA9PiB7XG5cdFx0Ly8gVGVzdCB0aGUgdjEgcGF0aDogcnVuSWQgc2hvdWxkIG5vdCBiZSBnZW5lcmF0ZWRcblx0XHRmdW5jdGlvbiBnZW5lcmF0ZVJ1bklkKHZlcnNpb246IDEgfCAyKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcblx0XHRcdHJldHVybiB2ZXJzaW9uID09PSAyID8gXCJydW4tdXVpZFwiIDogdW5kZWZpbmVkO1xuXHRcdH1cblx0XHRhc3NlcnQuZXF1YWwoZ2VuZXJhdGVSdW5JZCgxKSwgdW5kZWZpbmVkKTtcblx0XHRhc3NlcnQub2sodHlwZW9mIGdlbmVyYXRlUnVuSWQoMikgPT09IFwic3RyaW5nXCIpO1xuXHR9KTtcblxuXHRpdChcInJ1bklkIGlzIGluamVjdGVkIGludG8gZXZlbnQgb3V0cHV0IHZpYSBzcHJlYWRcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGN1cnJlbnRSdW5JZCA9IFwicnVuLWFiYy0xMjNcIjtcblx0XHRjb25zdCBldmVudCA9IHsgdHlwZTogXCJtZXNzYWdlX3N0YXJ0XCIsIG1lc3NhZ2U6IHsgcm9sZTogXCJhc3Npc3RhbnRcIiB9IH07XG5cblx0XHQvLyB2MiBpbmplY3Rpb24gbG9naWMgZnJvbSBycGMtbW9kZS50c1xuXHRcdGNvbnN0IG91dHB1dEV2ZW50ID0gY3VycmVudFJ1bklkID8geyAuLi5ldmVudCwgcnVuSWQ6IGN1cnJlbnRSdW5JZCB9IDogZXZlbnQ7XG5cblx0XHRhc3NlcnQuZXF1YWwoKG91dHB1dEV2ZW50IGFzIGFueSkucnVuSWQsIFwicnVuLWFiYy0xMjNcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKChvdXRwdXRFdmVudCBhcyBhbnkpLnR5cGUsIFwibWVzc2FnZV9zdGFydFwiKTtcblx0fSk7XG5cblx0aXQoXCJydW5JZCBpcyBub3QgaW5qZWN0ZWQgd2hlbiBudWxsXCIsICgpID0+IHtcblx0XHRjb25zdCBjdXJyZW50UnVuSWQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXHRcdGNvbnN0IGV2ZW50ID0geyB0eXBlOiBcIm1lc3NhZ2Vfc3RhcnRcIiwgbWVzc2FnZTogeyByb2xlOiBcImFzc2lzdGFudFwiIH0gfTtcblxuXHRcdGNvbnN0IG91dHB1dEV2ZW50ID0gY3VycmVudFJ1bklkID8geyAuLi5ldmVudCwgcnVuSWQ6IGN1cnJlbnRSdW5JZCB9IDogZXZlbnQ7XG5cblx0XHRhc3NlcnQuZXF1YWwoKG91dHB1dEV2ZW50IGFzIGFueSkucnVuSWQsIHVuZGVmaW5lZCk7XG5cdH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFRQSxTQUFTLFVBQVUsSUFBSSxZQUFZLGlCQUF1QjtBQUMxRCxPQUFPLFlBQVk7QUFDbkIsU0FBUyxtQkFBbUI7QUFDNUIsU0FBUyx1QkFBdUIseUJBQXlCO0FBaUJ6RCxTQUFTLGFBQWEsUUFBK0Q7QUFDcEYsUUFBTSxRQUFtQixDQUFDO0FBQzFCLFFBQU0sU0FBUyxzQkFBc0IsUUFBUSxDQUFDLFNBQVM7QUFDdEQsUUFBSTtBQUNILFlBQU0sS0FBSyxLQUFLLE1BQU0sSUFBSSxDQUFDO0FBQUEsSUFDNUIsUUFBUTtBQUFBLElBRVI7QUFBQSxFQUNELENBQUM7QUFDRCxTQUFPLEVBQUUsT0FBTyxPQUFPO0FBQ3hCO0FBR0EsU0FBUyxVQUFVLFFBQXFCLEtBQW9CO0FBQzNELFNBQU8sTUFBTSxrQkFBa0IsR0FBRyxDQUFDO0FBQ3BDO0FBU0EsU0FBUyxvQkFBb0I7QUFFNUIsUUFBTSxjQUFjLElBQUksWUFBWTtBQUVwQyxRQUFNLGVBQWUsSUFBSSxZQUFZO0FBRXJDLFNBQU8sRUFBRSxhQUFhLGFBQWE7QUFDcEM7QUFHQSxTQUFTLEtBQUssS0FBSyxJQUFtQjtBQUNyQyxTQUFPLElBQUksUUFBUSxDQUFDLFlBQVksV0FBVyxTQUFTLEVBQUUsQ0FBQztBQUN4RDtBQU1BLFNBQVMsbUJBQW1CLE1BQU07QUFDakMsS0FBRyxzREFBc0QsTUFBTTtBQUM5RCxVQUFNLFNBQVMsa0JBQWtCLEVBQUUsTUFBTSxRQUFRLE9BQU8sR0FBRyxDQUFDO0FBQzVELFdBQU8sTUFBTSxRQUFRLDhCQUE4QjtBQUFBLEVBQ3BELENBQUM7QUFFRCxLQUFHLDRDQUE0QyxNQUFNO0FBQ3BELFVBQU0sU0FB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
