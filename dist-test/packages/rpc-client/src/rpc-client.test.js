import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { serializeJsonLine, attachJsonlLineReader } from "./jsonl.js";
import { RpcClient } from "./rpc-client.js";
function flushIO() {
  return new Promise((resolve) => setImmediate(resolve));
}
describe("serializeJsonLine", () => {
  it("produces valid JSON terminated with LF", () => {
    const result = serializeJsonLine({ type: "test", value: 42 });
    assert.ok(result.endsWith("\n"), "must end with LF");
    const parsed = JSON.parse(result.trim());
    assert.equal(parsed.type, "test");
    assert.equal(parsed.value, 42);
  });
  it("serializes strings with special characters", () => {
    const result = serializeJsonLine({ msg: "hello\nworld" });
    assert.ok(result.endsWith("\n"));
    const lines = result.split("\n");
    assert.equal(lines.length, 2);
    assert.equal(lines[1], "");
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.msg, "hello\nworld");
  });
  it("handles empty objects", () => {
    const result = serializeJsonLine({});
    assert.equal(result, "{}\n");
  });
});
describe("attachJsonlLineReader", () => {
  it("splits on LF correctly", async () => {
    const stream = new PassThrough();
    const lines = [];
    attachJsonlLineReader(stream, (line) => lines.push(line));
    stream.write('{"a":1}\n{"b":2}\n');
    stream.end();
    await once(stream, "end");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).a, 1);
    assert.equal(JSON.parse(lines[1]).b, 2);
  });
  it("handles chunked data across boundaries", async () => {
    const stream = new PassThrough();
    const lines = [];
    attachJsonlLineReader(stream, (line) => lines.push(line));
    stream.write('{"type":"hel');
    stream.write('lo"}\n{"type":"w');
    stream.write('orld"}\n');
    stream.end();
    await once(stream, "end");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).type, "hello");
    assert.equal(JSON.parse(lines[1]).type, "world");
  });
  it("emits trailing data on stream end", async () => {
    const stream = new PassThrough();
    const lines = [];
    attachJsonlLineReader(stream, (line) => lines.push(line));
    stream.write('{"final":true}');
    stream.end();
    await once(stream, "end");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).final, true);
  });
  it("returns a detach function that stops reading", async () => {
    const stream = new PassThrough();
    const lines = [];
    let signalFirstLine;
    const firstLineSeen = new Promise((resolve) => {
      signalFirstLine = resolve;
    });
    const detach = attachJsonlLineReader(stream, (line) => {
      lines.push(line);
      if (lines.length === 1) signalFirstLine();
    });
    stream.write('{"a":1}\n');
    await firstLineSeen;
    assert.equal(lines.length, 1);
    detach();
    stream.write('{"b":2}\n');
    stream.end();
    await flushIO();
    assert.equal(lines.length, 1);
  });
  it("strips CR from CRLF line endings", async () => {
    const stream = new PassThrough();
    const lines = [];
    attachJsonlLineReader(stream, (line) => lines.push(line));
    stream.write('{"v":1}\r\n');
    stream.end();
    await once(stream, "end");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).v, 1);
  });
});
describe("JSONL round-trip of v2 payloads", () => {
  function roundTrip(value) {
    const serialized = serializeJsonLine(value);
    assert.ok(serialized.endsWith("\n"), "wire format must terminate with LF");
    assert.equal(serialized.indexOf("\n"), serialized.length - 1, "no unescaped LF inside payload");
    return JSON.parse(serialized.trim());
  }
  it("RpcInitResult round-trips through serializeJsonLine", () => {
    const init = {
      protocolVersion: 2,
      sessionId: "sess_123",
      capabilities: {
        events: ["execution_complete", "cost_update"],
        commands: ["prompt", "steer"]
      }
    };
    const parsed = roundTrip(init);
    assert.deepEqual(parsed, init);
  });
  it("RpcExecutionCompleteEvent round-trips preserving nested stats", () => {
    const event = {
      type: "execution_complete",
      runId: "run_abc",
      status: "completed",
      stats: {
        sessionFile: "/tmp/session.json",
        sessionId: "sess_123",
        userMessages: 5,
        assistantMessages: 5,
        toolCalls: 3,
        toolResults: 3,
        totalMessages: 10,
        tokens: { input: 1e3, output: 500, cacheRead: 200, cacheWrite: 100, total: 1800 },
        cost: 0.05
      }
    };
    const parsed = roundTrip(event);
    assert.deepEqual(parsed, event);
  });
  it("RpcCostUpdateEvent round-trips with numeric precision intact", () => {
    const event = {
      type: "cost_update",
      runId: "run_abc",
      turnCost: 0.01,
      cumulativeCost: 0.05,
      tokens: { input: 500, output: 200, cacheRead: 100, cacheWrite: 50 }
    };
    const parsed = roundTrip(event);
    assert.deepEqual(parsed, event);
  });
  it("SessionStats round-trips preserving totals", () => {
    const stats = {
      sessionFile: "/tmp/session.json",
      sessionId: "s1",
      userMessages: 10,
      assistantMessages: 10,
      toolCalls: 5,
      toolResults: 5,
      totalMessages: 20,
      tokens: { input: 2e3, output: 1e3, cacheRead: 500, cacheWrite: 200, total: 3700 },
      cost: 0.1
    };
    const parsed = roundTrip(stats);
    assert.deepEqual(parsed, stats);
    assert.equal(
      parsed.tokens.input + parsed.tokens.output + parsed.tokens.cacheRead + parsed.tokens.cacheWrite,
      parsed.tokens.total,
      "tokens.total should equal the sum of components after round-trip"
    );
  });
  it("RpcProtocolVersion values 1 and 2 survive round-trip", () => {
    const v1 = 1;
    const v2 = 2;
    assert.strictEqual(roundTrip({ v: v1 }).v, 1);
    assert.strictEqual(roundTrip({ v: v2 }).v, 2);
  });
  it("RpcV2Event discriminated union survives round-trip for each arm", () => {
    const events = [
      {
        type: "execution_complete",
        runId: "r1",
        status: "completed",
        stats: {
          sessionFile: void 0,
          sessionId: "s1",
          userMessages: 1,
          assistantMessages: 1,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: 2,
          tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
          cost: 1e-3
        }
      },
      {
        type: "cost_update",
        runId: "r1",
        turnCost: 1e-3,
        cumulativeCost: 1e-3,
        tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }
      }
    ];
    for (const evt of events) {
      const parsed = roundTrip(evt);
      assert.equal(parsed.type, evt.type, "discriminator must round-trip");
      if (parsed.type === "execution_complete" && evt.type === "execution_complete") {
        assert.equal(parsed.runId, evt.runId);
        assert.equal(parsed.status, evt.status);
        assert.deepEqual(parsed.stats.tokens, evt.stats.tokens);
      }
      if (parsed.type === "cost_update" && evt.type === "cost_update") {
        assert.deepEqual(parsed, evt);
      }
    }
  });
});
describe("RpcClient construction", () => {
  it("creates with default options", () => {
    const client = new RpcClient();
    assert.ok(client);
  });
  it("creates with custom options", () => {
    const client = new RpcClient({
      cliPath: "/usr/local/bin/gsd",
      cwd: "/tmp",
      env: { NODE_ENV: "test" },
      provider: "anthropic",
      model: "claude-sonnet",
      args: ["--verbose"]
    });
    assert.ok(client);
  });
});
describe("events() async generator", () => {
  it("yields events from a mock stream in order", async () => {
    const client = new RpcClient();
    const mockStdout = new PassThrough();
    const mockStderr = new PassThrough();
    const mockStdin = new PassThrough();
    const clientAny = client;
    clientAny.process = {
      stdout: mockStdout,
      stderr: mockStderr,
      stdin: mockStdin,
      exitCode: null,
      kill: () => {
      },
      on: (event, handler) => {
        if (event === "exit") {
          clientAny._testExitHandler = handler;
        }
      },
      removeListener: () => {
      }
    };
    clientAny.stopReadingStdout = attachJsonlLineReader(mockStdout, (line) => {
      clientAny.handleLine(line);
    });
    const received = [];
    const genPromise = (async () => {
      for await (const event of client.events()) {
        received.push(event);
        if (event.type === "done") break;
      }
    })();
    mockStdout.write(serializeJsonLine({ type: "agent_start", runId: "r1" }));
    await flushIO();
    mockStdout.write(serializeJsonLine({ type: "token", text: "hello" }));
    await flushIO();
    mockStdout.write(serializeJsonLine({ type: "done" }));
    await genPromise;
    assert.equal(received.length, 3);
    assert.equal(received[0].type, "agent_start");
    assert.equal(received[1].type, "token");
    assert.equal(received[2].type, "done");
  });
  it("terminates when process exits", async () => {
    const client = new RpcClient();
    const mockStdout = new PassThrough();
    const mockStderr = new PassThrough();
    const mockStdin = new PassThrough();
    const exitHandlers = [];
    const clientAny = client;
    clientAny.process = {
      stdout: mockStdout,
      stderr: mockStderr,
      stdin: mockStdin,
      exitCode: null,
      kill: () => {
      },
      on: (event, handler) => {
        if (event === "exit") exitHandlers.push(handler);
      },
      removeListener: (event, handler) => {
        const idx = exitHandlers.indexOf(handler);
        if (idx !== -1) exitHandlers.splice(idx, 1);
      }
    };
    clientAny.stopReadingStdout = attachJsonlLineReader(mockStdout, (line) => {
      clientAny.handleLine(line);
    });
    const received = [];
    const genPromise = (async () => {
      for await (const event of client.events()) {
        received.push(event);
      }
    })();
    mockStdout.write(serializeJsonLine({ type: "agent_start" }));
    await flushIO();
    for (const h of exitHandlers) h();
    await genPromise;
    assert.equal(received.length, 1);
    assert.equal(received[0].type, "agent_start");
  });
  it("throws if client not started", async () => {
    const client = new RpcClient();
    await assert.rejects(async () => {
      for await (const _event of client.events()) {
      }
    }, /Client not started/);
  });
});
describe("sendUIResponse serialization", () => {
  it("writes correct JSONL to stdin", () => {
    const client = new RpcClient();
    const chunks = [];
    const mockStdin = {
      write: (data) => {
        chunks.push(data);
        return true;
      }
    };
    const clientAny = client;
    clientAny.process = { stdin: mockStdin };
    client.sendUIResponse("ui_1", { value: "hello" });
    assert.equal(chunks.length, 1);
    const parsed = JSON.parse(chunks[0].trim());
    assert.equal(parsed.type, "extension_ui_response");
    assert.equal(parsed.id, "ui_1");
    assert.equal(parsed.value, "hello");
  });
  it("serializes confirmed response", () => {
    const client = new RpcClient();
    const chunks = [];
    const mockStdin = {
      write: (data) => {
        chunks.push(data);
        return true;
      }
    };
    const clientAny = client;
    clientAny.process = { stdin: mockStdin };
    client.sendUIResponse("ui_2", { confirmed: true });
    const parsed = JSON.parse(chunks[0].trim());
    assert.equal(parsed.confirmed, true);
    assert.equal(parsed.id, "ui_2");
  });
  it("serializes cancelled response", () => {
    const client = new RpcClient();
    const chunks = [];
    const mockStdin = {
      write: (data) => {
        chunks.push(data);
        return true;
      }
    };
    const clientAny = client;
    clientAny.process = { stdin: mockStdin };
    client.sendUIResponse("ui_3", { cancelled: true });
    const parsed = JSON.parse(chunks[0].trim());
    assert.equal(parsed.cancelled, true);
  });
});
describe("v2 command serialization", () => {
  function createMockClient() {
    const client = new RpcClient();
    const sent = [];
    let respondFn = null;
    const clientAny = client;
    clientAny.process = {
      stdin: {
        write: (data) => {
          const parsed = JSON.parse(data.trim());
          sent.push(parsed);
          if (respondFn) {
            queueMicrotask(() => respondFn(parsed));
          }
          return true;
        }
      },
      stderr: new PassThrough(),
      exitCode: null,
      kill: () => {
      },
      on: () => {
      },
      removeListener: () => {
      }
    };
    const respondNext = (overrides = {}) => {
      respondFn = (parsed) => {
        const response = {
          type: "response",
          id: parsed.id,
          command: parsed.type,
          success: true,
          data: {},
          ...overrides
        };
        clientAny.handleLine(JSON.stringify(response));
      };
    };
    return { client, sent, respondNext };
  }
  it("init sends correct v2 init command", async () => {
    const { client, sent, respondNext } = createMockClient();
    respondNext({ data: { protocolVersion: 2, sessionId: "s1", capabilities: { events: [], commands: [] } } });
    const result = await client.init({ clientId: "test-app" });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, "init");
    assert.equal(sent[0].protocolVersion, 2);
    assert.equal(sent[0].clientId, "test-app");
    assert.equal(result.protocolVersion, 2);
    assert.equal(result.sessionId, "s1");
  });
  it("shutdown sends shutdown command", async () => {
    const { client, sent, respondNext } = createMockClient();
    const clientAny = client;
    const originalProcess = clientAny.process;
    const exitHandlers = [];
    clientAny.process = {
      ...originalProcess,
      on: (event, handler) => {
        if (event === "exit") exitHandlers.push(handler);
      }
    };
    respondNext();
    const shutdownPromise = client.shutdown();
    await flushIO();
    await flushIO();
    for (const h of exitHandlers) h(0);
    await shutdownPromise;
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, "shutdown");
  });
  it("subscribe sends subscribe command with event list", async () => {
    const { client, sent, respondNext } = createMockClient();
    respondNext();
    await client.subscribe(["execution_complete", "cost_update"]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, "subscribe");
    assert.deepEqual(sent[0].events, ["execution_complete", "cost_update"]);
  });
  it("subscribe with wildcard", async () => {
    const { client, sent, respondNext } = createMockClient();
    respondNext();
    await client.subscribe(["*"]);
    assert.equal(sent[0].events.length, 1);
    assert.equal(sent[0].events[0], "*");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvcnBjLWNsaWVudC9zcmMvcnBjLWNsaWVudC50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBkZXNjcmliZSwgaXQgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IFBhc3NUaHJvdWdoIH0gZnJvbSBcIm5vZGU6c3RyZWFtXCI7XG5pbXBvcnQgeyBvbmNlIH0gZnJvbSBcIm5vZGU6ZXZlbnRzXCI7XG5pbXBvcnQgeyBzZXJpYWxpemVKc29uTGluZSwgYXR0YWNoSnNvbmxMaW5lUmVhZGVyIH0gZnJvbSBcIi4vanNvbmwuanNcIjtcbmltcG9ydCB0eXBlIHtcblx0UnBjSW5pdFJlc3VsdCxcblx0UnBjRXhlY3V0aW9uQ29tcGxldGVFdmVudCxcblx0UnBjQ29zdFVwZGF0ZUV2ZW50LFxuXHRScGNQcm90b2NvbFZlcnNpb24sXG5cdFNlc3Npb25TdGF0cyxcblx0UnBjVjJFdmVudCxcbn0gZnJvbSBcIi4vcnBjLXR5cGVzLmpzXCI7XG5pbXBvcnQgeyBScGNDbGllbnQgfSBmcm9tIFwiLi9ycGMtY2xpZW50LmpzXCI7XG5pbXBvcnQgdHlwZSB7IFNka0FnZW50RXZlbnQgfSBmcm9tIFwiLi9ycGMtY2xpZW50LmpzXCI7XG5cbi8qKlxuICogRmx1c2ggcGVuZGluZyBtaWNyb3Rhc2tzIGFuZCBvbmUgdHVybiBvZiB0aGUgbWFjcm90YXNrIHF1ZXVlLlxuICpcbiAqIFVzZWQgaW4gcGxhY2VzIHdoZXJlIHRoZSB0ZXN0IG5lZWRzIFwiZXZlcnkgYWxyZWFkeS1xdWV1ZWQgc3RyZWFtIGV2ZW50IGhhc1xuICogYmVlbiBkZWxpdmVyZWRcIiBcdTIwMTQgY2hlYXBlciB0aGFuIGEgd2FsbC1jbG9jayBzbGVlcCBhbmQgZGV0ZXJtaW5pc3RpYyBiZWNhdXNlXG4gKiBgc2V0SW1tZWRpYXRlYCBydW5zIHN0cmljdGx5IGFmdGVyIGFueSBJL08gY2FsbGJhY2tzIGFscmVhZHkgcXVldWVkIGJ5IGFcbiAqIHN5bmNocm9ub3VzIGBzdHJlYW0ud3JpdGUoLi4uKWAuXG4gKi9cbmZ1bmN0aW9uIGZsdXNoSU8oKTogUHJvbWlzZTx2b2lkPiB7XG5cdHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4gc2V0SW1tZWRpYXRlKHJlc29sdmUpKTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gSlNPTkwgVGVzdHNcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuZGVzY3JpYmUoXCJzZXJpYWxpemVKc29uTGluZVwiLCAoKSA9PiB7XG5cdGl0KFwicHJvZHVjZXMgdmFsaWQgSlNPTiB0ZXJtaW5hdGVkIHdpdGggTEZcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlc3VsdCA9IHNlcmlhbGl6ZUpzb25MaW5lKHsgdHlwZTogXCJ0ZXN0XCIsIHZhbHVlOiA0MiB9KTtcblx0XHRhc3NlcnQub2socmVzdWx0LmVuZHNXaXRoKFwiXFxuXCIpLCBcIm11c3QgZW5kIHdpdGggTEZcIik7XG5cdFx0Y29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShyZXN1bHQudHJpbSgpKTtcblx0XHRhc3NlcnQuZXF1YWwocGFyc2VkLnR5cGUsIFwidGVzdFwiKTtcblx0XHRhc3NlcnQuZXF1YWwocGFyc2VkLnZhbHVlLCA0Mik7XG5cdH0pO1xuXG5cdGl0KFwic2VyaWFsaXplcyBzdHJpbmdzIHdpdGggc3BlY2lhbCBjaGFyYWN0ZXJzXCIsICgpID0+IHtcblx0XHRjb25zdCByZXN1bHQgPSBzZXJpYWxpemVKc29uTGluZSh7IG1zZzogXCJoZWxsb1xcbndvcmxkXCIgfSk7XG5cdFx0YXNzZXJ0Lm9rKHJlc3VsdC5lbmRzV2l0aChcIlxcblwiKSk7XG5cdFx0Ly8gVGhlIGVtYmVkZGVkIFxcbiBtdXN0IGJlIGVzY2FwZWQgaW5zaWRlIHRoZSBKU09OIFx1MjAxNCBvbmx5IHRoZSB0cmFpbGluZyBMRiBpcyB0aGUgZnJhbWluZyBkZWxpbWl0ZXJcblx0XHRjb25zdCBsaW5lcyA9IHJlc3VsdC5zcGxpdChcIlxcblwiKTtcblx0XHQvLyBTaG91bGQgYmUgZXhhY3RseSAyIHBhcnRzOiB0aGUgSlNPTiBsaW5lIGFuZCB0aGUgZW1wdHkgc3RyaW5nIGFmdGVyIHRyYWlsaW5nIExGXG5cdFx0YXNzZXJ0LmVxdWFsKGxpbmVzLmxlbmd0aCwgMik7XG5cdFx0YXNzZXJ0LmVxdWFsKGxpbmVzWzFdLCBcIlwiKTtcblx0XHRjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKGxpbmVzWzBdKTtcblx0XHRhc3NlcnQuZXF1YWwocGFyc2VkLm1zZywgXCJoZWxsb1xcbndvcmxkXCIpO1xuXHR9KTtcblxuXHRpdChcImhhbmRsZXMgZW1wdHkgb2JqZWN0c1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVzdWx0ID0gc2VyaWFsaXplSnNvbkxpbmUoe30pO1xuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQsIFwie31cXG5cIik7XG5cdH0pO1xufSk7XG5cbmRlc2NyaWJlKFwiYXR0YWNoSnNvbmxMaW5lUmVhZGVyXCIsICgpID0+IHtcblx0aXQoXCJzcGxpdHMgb24gTEYgY29ycmVjdGx5XCIsIGFzeW5jICgpID0+IHtcblx0XHRjb25zdCBzdHJlYW0gPSBuZXcgUGFzc1Rocm91Z2goKTtcblx0XHRjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcblxuXHRcdGF0dGFjaEpzb25sTGluZVJlYWRlcihzdHJlYW0sIChsaW5lKSA9PiBsaW5lcy5wdXNoKGxpbmUpKTtcblxuXHRcdHN0cmVhbS53cml0ZSgne1wiYVwiOjF9XFxue1wiYlwiOjJ9XFxuJyk7XG5cdFx0c3RyZWFtLmVuZCgpO1xuXG5cdFx0Ly8gVGhlIHJlYWRlciByZWdpc3RlcnMgaXRzIGBlbmRgIGxpc3RlbmVyIGZpcnN0OyBhd2FpdGluZyBgZW5kYCBoZXJlXG5cdFx0Ly8gcnVucyBzdHJpY3RseSBhZnRlciB0aGUgcmVhZGVyIGhhcyBkcmFpbmVkIGFueSB0cmFpbGluZyBidWZmZXIuXG5cdFx0YXdhaXQgb25jZShzdHJlYW0sIFwiZW5kXCIpO1xuXG5cdFx0YXNzZXJ0LmVxdWFsKGxpbmVzLmxlbmd0aCwgMik7XG5cdFx0YXNzZXJ0LmVxdWFsKEpTT04ucGFyc2UobGluZXNbMF0pLmEsIDEpO1xuXHRcdGFzc2VydC5lcXVhbChKU09OLnBhcnNlKGxpbmVzWzFdKS5iLCAyKTtcblx0fSk7XG5cblx0aXQoXCJoYW5kbGVzIGNodW5rZWQgZGF0YSBhY3Jvc3MgYm91bmRhcmllc1wiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3Qgc3RyZWFtID0gbmV3IFBhc3NUaHJvdWdoKCk7XG5cdFx0Y29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG5cblx0XHRhdHRhY2hKc29ubExpbmVSZWFkZXIoc3RyZWFtLCAobGluZSkgPT4gbGluZXMucHVzaChsaW5lKSk7XG5cblx0XHQvLyBXcml0ZSBpbiBmcmFnbWVudHMgdGhhdCBzcGxpdCBtaWQtbGluZVxuXHRcdHN0cmVhbS53cml0ZSgne1widHlwZVwiOlwiaGVsJyk7XG5cdFx0c3RyZWFtLndyaXRlKCdsb1wifVxcbntcInR5cGVcIjpcIncnKTtcblx0XHRzdHJlYW0ud3JpdGUoJ29ybGRcIn1cXG4nKTtcblx0XHRzdHJlYW0uZW5kKCk7XG5cblx0XHRhd2FpdCBvbmNlKHN0cmVhbSwgXCJlbmRcIik7XG5cblx0XHRhc3NlcnQuZXF1YWwobGluZXMubGVuZ3RoLCAyKTtcblx0XHRhc3NlcnQuZXF1YWwoSlNPTi5wYXJzZShsaW5lc1swXSkudHlwZSwgXCJoZWxsb1wiKTtcblx0XHRhc3NlcnQuZXF1YWwoSlNPTi5wYXJzZShsaW5lc1sxXSkudHlwZSwgXCJ3b3JsZFwiKTtcblx0fSk7XG5cblx0aXQoXCJlbWl0cyB0cmFpbGluZyBkYXRhIG9uIHN0cmVhbSBlbmRcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IHN0cmVhbSA9IG5ldyBQYXNzVGhyb3VnaCgpO1xuXHRcdGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuXG5cdFx0YXR0YWNoSnNvbmxMaW5lUmVhZGVyKHN0cmVhbSwgKGxpbmUpID0+IGxpbmVzLnB1c2gobGluZSkpO1xuXG5cdFx0c3RyZWFtLndyaXRlKCd7XCJmaW5hbFwiOnRydWV9Jyk7XG5cdFx0c3RyZWFtLmVuZCgpO1xuXG5cdFx0YXdhaXQgb25jZShzdHJlYW0sIFwiZW5kXCIpO1xuXG5cdFx0YXNzZXJ0LmVxdWFsKGxpbmVzLmxlbmd0aCwgMSk7XG5cdFx0YXNzZXJ0LmVxdWFsKEpTT04ucGFyc2UobGluZXNbMF0pLmZpbmFsLCB0cnVlKTtcblx0fSk7XG5cblx0aXQoXCJyZXR1cm5zIGEgZGV0YWNoIGZ1bmN0aW9uIHRoYXQgc3RvcHMgcmVhZGluZ1wiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3Qgc3RyZWFtID0gbmV3IFBhc3NUaHJvdWdoKCk7XG5cdFx0Y29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG5cblx0XHQvLyBVc2UgYW4gZXhwbGljaXQgcHJvbWlzZSB0byBzaWduYWwgXCJmaXJzdCBsaW5lIGhhcyBiZWVuIG9ic2VydmVkXCIuXG5cdFx0Ly8gVGhpcyBpcyBkZXRlcm1pbmlzdGljIFx1MjAxNCB3ZSByZXN1bWUgZXhhY3RseSB3aGVuIHRoZSByZWFkZXIgZmlyZXMgdGhlXG5cdFx0Ly8gY2FsbGJhY2ssIG5vdCBhZnRlciBhbiBhcmJpdHJhcnkgd2FsbC1jbG9jayBkZWxheS5cblx0XHRsZXQgc2lnbmFsRmlyc3RMaW5lITogKCkgPT4gdm9pZDtcblx0XHRjb25zdCBmaXJzdExpbmVTZWVuID0gbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUpID0+IHtcblx0XHRcdHNpZ25hbEZpcnN0TGluZSA9IHJlc29sdmU7XG5cdFx0fSk7XG5cblx0XHRjb25zdCBkZXRhY2ggPSBhdHRhY2hKc29ubExpbmVSZWFkZXIoc3RyZWFtLCAobGluZSkgPT4ge1xuXHRcdFx0bGluZXMucHVzaChsaW5lKTtcblx0XHRcdGlmIChsaW5lcy5sZW5ndGggPT09IDEpIHNpZ25hbEZpcnN0TGluZSgpO1xuXHRcdH0pO1xuXG5cdFx0c3RyZWFtLndyaXRlKCd7XCJhXCI6MX1cXG4nKTtcblx0XHRhd2FpdCBmaXJzdExpbmVTZWVuO1xuXHRcdGFzc2VydC5lcXVhbChsaW5lcy5sZW5ndGgsIDEpO1xuXG5cdFx0ZGV0YWNoKCk7XG5cblx0XHRzdHJlYW0ud3JpdGUoJ3tcImJcIjoyfVxcbicpO1xuXHRcdHN0cmVhbS5lbmQoKTtcblx0XHQvLyBEcmFpbiBhbnkgcXVldWVkIGRhdGEgZXZlbnRzIHBvc3QtZGV0YWNoLiBgc2V0SW1tZWRpYXRlYCBydW5zIHN0cmljdGx5XG5cdFx0Ly8gYWZ0ZXIgYW55ICdkYXRhJyBldmVudHMgdGhhdCB3ZXJlIGFscmVhZHkgcXVldWVkIGJ5IHRoZSB3cml0ZSBhYm92ZS5cblx0XHRhd2FpdCBmbHVzaElPKCk7XG5cblx0XHQvLyBTaG91bGQgc3RpbGwgYmUgMSBcdTIwMTQgZGV0YWNoIHJlbW92ZWQgbGlzdGVuZXJzXG5cdFx0YXNzZXJ0LmVxdWFsKGxpbmVzLmxlbmd0aCwgMSk7XG5cdH0pO1xuXG5cdGl0KFwic3RyaXBzIENSIGZyb20gQ1JMRiBsaW5lIGVuZGluZ3NcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IHN0cmVhbSA9IG5ldyBQYXNzVGhyb3VnaCgpO1xuXHRcdGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuXG5cdFx0YXR0YWNoSnNvbmxMaW5lUmVhZGVyKHN0cmVhbSwgKGxpbmUpID0+IGxpbmVzLnB1c2gobGluZSkpO1xuXG5cdFx0c3RyZWFtLndyaXRlKCd7XCJ2XCI6MX1cXHJcXG4nKTtcblx0XHRzdHJlYW0uZW5kKCk7XG5cblx0XHRhd2FpdCBvbmNlKHN0cmVhbSwgXCJlbmRcIik7XG5cblx0XHRhc3NlcnQuZXF1YWwobGluZXMubGVuZ3RoLCAxKTtcblx0XHRhc3NlcnQuZXF1YWwoSlNPTi5wYXJzZShsaW5lc1swXSkudiwgMSk7XG5cdH0pO1xufSk7XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIEpTT05MIFJvdW5kLVRyaXAgVGVzdHNcbi8vXG4vLyBUaGVzZSBwcmV2aW91c2x5IGxpdmVkIHVuZGVyIGEgXCJ0eXBlIHNoYXBlc1wiIGJsb2NrIHRoYXQgb25seSBhc3NlcnRlZCB0aGF0XG4vLyBhIHR5cGVkIGxpdGVyYWwgcmV0YWluZWQgaXRzIG93biBmaWVsZCB2YWx1ZXMgXHUyMDE0IHB1cmUgdHlwZS1zeXN0ZW1cbi8vIHRhdXRvbG9naWVzLiBUaGV5IGFyZSBub3cgcmVwbGFjZWQgd2l0aCByb3VuZC10cmlwcyB0aHJvdWdoXG4vLyBgc2VyaWFsaXplSnNvbkxpbmVgICsgYEpTT04ucGFyc2VgLCB3aGljaCBleGVyY2lzZXMgdGhlIGFjdHVhbCBmcmFtaW5nXG4vLyBwaXBlbGluZSB0aGUgd2lyZSBwcm90b2NvbCB1c2VzLiBBIHJlZ3Jlc3Npb24gd2hlcmUgYHNlcmlhbGl6ZUpzb25MaW5lYFxuLy8gbWFuZ2xlcyBwYXlsb2FkcyBvciB0aGUgTEYgdGVybWluYXRvciB3aWxsIG5vdyBmYWlsIHRoZXNlIHRlc3RzLlxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5kZXNjcmliZShcIkpTT05MIHJvdW5kLXRyaXAgb2YgdjIgcGF5bG9hZHNcIiwgKCkgPT4ge1xuXHRmdW5jdGlvbiByb3VuZFRyaXA8VD4odmFsdWU6IFQpOiBUIHtcblx0XHRjb25zdCBzZXJpYWxpemVkID0gc2VyaWFsaXplSnNvbkxpbmUodmFsdWUpO1xuXHRcdGFzc2VydC5vayhzZXJpYWxpemVkLmVuZHNXaXRoKFwiXFxuXCIpLCBcIndpcmUgZm9ybWF0IG11c3QgdGVybWluYXRlIHdpdGggTEZcIik7XG5cdFx0Ly8gRW5zdXJlIHdlIGRpZCBub3QgZW1pdCBlbWJlZGRlZCB1bmVzY2FwZWQgTEZzIHRoYXQgd291bGQgY29ycnVwdCBmcmFtaW5nXG5cdFx0YXNzZXJ0LmVxdWFsKHNlcmlhbGl6ZWQuaW5kZXhPZihcIlxcblwiKSwgc2VyaWFsaXplZC5sZW5ndGggLSAxLCBcIm5vIHVuZXNjYXBlZCBMRiBpbnNpZGUgcGF5bG9hZFwiKTtcblx0XHRyZXR1cm4gSlNPTi5wYXJzZShzZXJpYWxpemVkLnRyaW0oKSkgYXMgVDtcblx0fVxuXG5cdGl0KFwiUnBjSW5pdFJlc3VsdCByb3VuZC10cmlwcyB0aHJvdWdoIHNlcmlhbGl6ZUpzb25MaW5lXCIsICgpID0+IHtcblx0XHRjb25zdCBpbml0OiBScGNJbml0UmVzdWx0ID0ge1xuXHRcdFx0cHJvdG9jb2xWZXJzaW9uOiAyLFxuXHRcdFx0c2Vzc2lvbklkOiBcInNlc3NfMTIzXCIsXG5cdFx0XHRjYXBhYmlsaXRpZXM6IHtcblx0XHRcdFx0ZXZlbnRzOiBbXCJleGVjdXRpb25fY29tcGxldGVcIiwgXCJjb3N0X3VwZGF0ZVwiXSxcblx0XHRcdFx0Y29tbWFuZHM6IFtcInByb21wdFwiLCBcInN0ZWVyXCJdLFxuXHRcdFx0fSxcblx0XHR9O1xuXHRcdGNvbnN0IHBhcnNlZCA9IHJvdW5kVHJpcChpbml0KTtcblx0XHRhc3NlcnQuZGVlcEVxdWFsKHBhcnNlZCwgaW5pdCk7XG5cdH0pO1xuXG5cdGl0KFwiUnBjRXhlY3V0aW9uQ29tcGxldGVFdmVudCByb3VuZC10cmlwcyBwcmVzZXJ2aW5nIG5lc3RlZCBzdGF0c1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgZXZlbnQ6IFJwY0V4ZWN1dGlvbkNvbXBsZXRlRXZlbnQgPSB7XG5cdFx0XHR0eXBlOiBcImV4ZWN1dGlvbl9jb21wbGV0ZVwiLFxuXHRcdFx0cnVuSWQ6IFwicnVuX2FiY1wiLFxuXHRcdFx0c3RhdHVzOiBcImNvbXBsZXRlZFwiLFxuXHRcdFx0c3RhdHM6IHtcblx0XHRcdFx0c2Vzc2lvbkZpbGU6IFwiL3RtcC9zZXNzaW9uLmpzb25cIixcblx0XHRcdFx0c2Vzc2lvbklkOiBcInNlc3NfMTIzXCIsXG5cdFx0XHRcdHVzZXJNZXNzYWdlczogNSxcblx0XHRcdFx0YXNzaXN0YW50TWVzc2FnZXM6IDUsXG5cdFx0XHRcdHRvb2xDYWxsczogMyxcblx0XHRcdFx0dG9vbFJlc3VsdHM6IDMsXG5cdFx0XHRcdHRvdGFsTWVzc2FnZXM6IDEwLFxuXHRcdFx0XHR0b2tlbnM6IHsgaW5wdXQ6IDEwMDAsIG91dHB1dDogNTAwLCBjYWNoZVJlYWQ6IDIwMCwgY2FjaGVXcml0ZTogMTAwLCB0b3RhbDogMTgwMCB9LFxuXHRcdFx0XHRjb3N0OiAwLjA1LFxuXHRcdFx0fSxcblx0XHR9O1xuXHRcdGNvbnN0IHBhcnNlZCA9IHJvdW5kVHJpcChldmVudCk7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChwYXJzZWQsIGV2ZW50KTtcblx0fSk7XG5cblx0aXQoXCJScGNDb3N0VXBkYXRlRXZlbnQgcm91bmQtdHJpcHMgd2l0aCBudW1lcmljIHByZWNpc2lvbiBpbnRhY3RcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGV2ZW50OiBScGNDb3N0VXBkYXRlRXZlbnQgPSB7XG5cdFx0XHR0eXBlOiBcImNvc3RfdXBkYXRlXCIsXG5cdFx0XHRydW5JZDogXCJydW5fYWJjXCIsXG5cdFx0XHR0dXJuQ29zdDogMC4wMSxcblx0XHRcdGN1bXVsYXRpdmVDb3N0OiAwLjA1LFxuXHRcdFx0dG9rZW5zOiB7IGlucHV0OiA1MDAsIG91dHB1dDogMjAwLCBjYWNoZVJlYWQ6IDEwMCwgY2FjaGVXcml0ZTogNTAgfSxcblx0XHR9O1xuXHRcdGNvbnN0IHBhcnNlZCA9IHJvdW5kVHJpcChldmVudCk7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChwYXJzZWQsIGV2ZW50KTtcblx0fSk7XG5cblx0aXQoXCJTZXNzaW9uU3RhdHMgcm91bmQtdHJpcHMgcHJlc2VydmluZyB0b3RhbHNcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHN0YXRzOiBTZXNzaW9uU3RhdHMgPSB7XG5cdFx0XHRzZXNzaW9uRmlsZTogXCIvdG1wL3Nlc3Npb24uanNvblwiLFxuXHRcdFx0c2Vzc2lvbklkOiBcInMxXCIsXG5cdFx0XHR1c2VyTWVzc2FnZXM6IDEwLFxuXHRcdFx0YXNzaXN0YW50TWVzc2FnZXM6IDEwLFxuXHRcdFx0dG9vbENhbGxzOiA1LFxuXHRcdFx0dG9vbFJlc3VsdHM6IDUsXG5cdFx0XHR0b3RhbE1lc3NhZ2VzOiAyMCxcblx0XHRcdHRva2VuczogeyBpbnB1dDogMjAwMCwgb3V0cHV0OiAxMDAwLCBjYWNoZVJlYWQ6IDUwMCwgY2FjaGVXcml0ZTogMjAwLCB0b3RhbDogMzcwMCB9LFxuXHRcdFx0Y29zdDogMC4xLFxuXHRcdH07XG5cdFx0Y29uc3QgcGFyc2VkID0gcm91bmRUcmlwKHN0YXRzKTtcblx0XHRhc3NlcnQuZGVlcEVxdWFsKHBhcnNlZCwgc3RhdHMpO1xuXHRcdGFzc2VydC5lcXVhbChcblx0XHRcdHBhcnNlZC50b2tlbnMuaW5wdXQgKyBwYXJzZWQudG9rZW5zLm91dHB1dCArIHBhcnNlZC50b2tlbnMuY2FjaGVSZWFkICsgcGFyc2VkLnRva2Vucy5jYWNoZVdyaXRlLFxuXHRcdFx0cGFyc2VkLnRva2Vucy50b3RhbCxcblx0XHRcdFwidG9rZW5zLnRvdGFsIHNob3VsZCBlcXVhbCB0aGUgc3VtIG9mIGNvbXBvbmVudHMgYWZ0ZXIgcm91bmQtdHJpcFwiLFxuXHRcdCk7XG5cdH0pO1xuXG5cdGl0KFwiUnBjUHJvdG9jb2xWZXJzaW9uIHZhbHVlcyAxIGFuZCAyIHN1cnZpdmUgcm91bmQtdHJpcFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgdjE6IFJwY1Byb3RvY29sVmVyc2lvbiA9IDE7XG5cdFx0Y29uc3QgdjI6IFJwY1Byb3RvY29sVmVyc2lvbiA9IDI7XG5cdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJvdW5kVHJpcCh7IHY6IHYxIH0pLnYsIDEpO1xuXHRcdGFzc2VydC5zdHJpY3RFcXVhbChyb3VuZFRyaXAoeyB2OiB2MiB9KS52LCAyKTtcblx0fSk7XG5cblx0aXQoXCJScGNWMkV2ZW50IGRpc2NyaW1pbmF0ZWQgdW5pb24gc3Vydml2ZXMgcm91bmQtdHJpcCBmb3IgZWFjaCBhcm1cIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGV2ZW50czogUnBjVjJFdmVudFtdID0gW1xuXHRcdFx0e1xuXHRcdFx0XHR0eXBlOiBcImV4ZWN1dGlvbl9jb21wbGV0ZVwiLFxuXHRcdFx0XHRydW5JZDogXCJyMVwiLFxuXHRcdFx0XHRzdGF0dXM6IFwiY29tcGxldGVkXCIsXG5cdFx0XHRcdHN0YXRzOiB7XG5cdFx0XHRcdFx0c2Vzc2lvbkZpbGU6IHVuZGVmaW5lZCxcblx0XHRcdFx0XHRzZXNzaW9uSWQ6IFwiczFcIixcblx0XHRcdFx0XHR1c2VyTWVzc2FnZXM6IDEsXG5cdFx0XHRcdFx0YXNzaXN0YW50TWVzc2FnZXM6IDEsXG5cdFx0XHRcdFx0dG9vbENhbGxzOiAwLFxuXHRcdFx0XHRcdHRvb2xSZXN1bHRzOiAwLFxuXHRcdFx0XHRcdHRvdGFsTWVzc2FnZXM6IDIsXG5cdFx0XHRcdFx0dG9rZW5zOiB7IGlucHV0OiAxMDAsIG91dHB1dDogNTAsIGNhY2hlUmVhZDogMCwgY2FjaGVXcml0ZTogMCwgdG90YWw6IDE1MCB9LFxuXHRcdFx0XHRcdGNvc3Q6IDAuMDAxLFxuXHRcdFx0XHR9LFxuXHRcdFx0fSxcblx0XHRcdHtcblx0XHRcdFx0dHlwZTogXCJjb3N0X3VwZGF0ZVwiLFxuXHRcdFx0XHRydW5JZDogXCJyMVwiLFxuXHRcdFx0XHR0dXJuQ29zdDogMC4wMDEsXG5cdFx0XHRcdGN1bXVsYXRpdmVDb3N0OiAwLjAwMSxcblx0XHRcdFx0dG9rZW5zOiB7IGlucHV0OiAxMDAsIG91dHB1dDogNTAsIGNhY2hlUmVhZDogMCwgY2FjaGVXcml0ZTogMCB9LFxuXHRcdFx0fSxcblx0XHRdO1xuXG5cdFx0Zm9yIChjb25zdCBldnQgb2YgZXZlbnRzKSB7XG5cdFx0XHRjb25zdCBwYXJzZWQgPSByb3VuZFRyaXAoZXZ0KTtcblx0XHRcdGFzc2VydC5lcXVhbChwYXJzZWQudHlwZSwgZXZ0LnR5cGUsIFwiZGlzY3JpbWluYXRvciBtdXN0IHJvdW5kLXRyaXBcIik7XG5cdFx0XHRpZiAocGFyc2VkLnR5cGUgPT09IFwiZXhlY3V0aW9uX2NvbXBsZXRlXCIgJiYgZXZ0LnR5cGUgPT09IFwiZXhlY3V0aW9uX2NvbXBsZXRlXCIpIHtcblx0XHRcdFx0Ly8gYHNlc3Npb25GaWxlOiB1bmRlZmluZWRgIGlzIGRyb3BwZWQgYnkgSlNPTi5zdHJpbmdpZnkgYnkgZGVzaWduO1xuXHRcdFx0XHQvLyBjb21wYXJlIHRoZSByZW1haW5pbmcgb2JzZXJ2YWJsZSBmaWVsZHMuXG5cdFx0XHRcdGFzc2VydC5lcXVhbChwYXJzZWQucnVuSWQsIGV2dC5ydW5JZCk7XG5cdFx0XHRcdGFzc2VydC5lcXVhbChwYXJzZWQuc3RhdHVzLCBldnQuc3RhdHVzKTtcblx0XHRcdFx0YXNzZXJ0LmRlZXBFcXVhbChwYXJzZWQuc3RhdHMudG9rZW5zLCBldnQuc3RhdHMudG9rZW5zKTtcblx0XHRcdH1cblx0XHRcdGlmIChwYXJzZWQudHlwZSA9PT0gXCJjb3N0X3VwZGF0ZVwiICYmIGV2dC50eXBlID09PSBcImNvc3RfdXBkYXRlXCIpIHtcblx0XHRcdFx0YXNzZXJ0LmRlZXBFcXVhbChwYXJzZWQsIGV2dCk7XG5cdFx0XHR9XG5cdFx0fVxuXHR9KTtcbn0pO1xuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBScGNDbGllbnQgQ29uc3RydWN0aW9uIFRlc3RzXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmRlc2NyaWJlKFwiUnBjQ2xpZW50IGNvbnN0cnVjdGlvblwiLCAoKSA9PiB7XG5cdGl0KFwiY3JlYXRlcyB3aXRoIGRlZmF1bHQgb3B0aW9uc1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgY2xpZW50ID0gbmV3IFJwY0NsaWVudCgpO1xuXHRcdGFzc2VydC5vayhjbGllbnQpO1xuXHR9KTtcblxuXHRpdChcImNyZWF0ZXMgd2l0aCBjdXN0b20gb3B0aW9uc1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgY2xpZW50ID0gbmV3IFJwY0NsaWVudCh7XG5cdFx0XHRjbGlQYXRoOiBcIi91c3IvbG9jYWwvYmluL2dzZFwiLFxuXHRcdFx0Y3dkOiBcIi90bXBcIixcblx0XHRcdGVudjogeyBOT0RFX0VOVjogXCJ0ZXN0XCIgfSxcblx0XHRcdHByb3ZpZGVyOiBcImFudGhyb3BpY1wiLFxuXHRcdFx0bW9kZWw6IFwiY2xhdWRlLXNvbm5ldFwiLFxuXHRcdFx0YXJnczogW1wiLS12ZXJib3NlXCJdLFxuXHRcdH0pO1xuXHRcdGFzc2VydC5vayhjbGllbnQpO1xuXHR9KTtcbn0pO1xuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBldmVudHMoKSBHZW5lcmF0b3IgVGVzdHNcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuZGVzY3JpYmUoXCJldmVudHMoKSBhc3luYyBnZW5lcmF0b3JcIiwgKCkgPT4ge1xuXHRpdChcInlpZWxkcyBldmVudHMgZnJvbSBhIG1vY2sgc3RyZWFtIGluIG9yZGVyXCIsIGFzeW5jICgpID0+IHtcblx0XHRjb25zdCBjbGllbnQgPSBuZXcgUnBjQ2xpZW50KCk7XG5cblx0XHQvLyBSZWFjaCBpbnRvIHRoZSBjbGllbnQgdG8gc2V0IHVwIGEgbW9jayBwcm9jZXNzIHdpdGggYSBQYXNzVGhyb3VnaCBzdGRvdXRcblx0XHRjb25zdCBtb2NrU3Rkb3V0ID0gbmV3IFBhc3NUaHJvdWdoKCk7XG5cdFx0Y29uc3QgbW9ja1N0ZGVyciA9IG5ldyBQYXNzVGhyb3VnaCgpO1xuXHRcdGNvbnN0IG1vY2tTdGRpbiA9IG5ldyBQYXNzVGhyb3VnaCgpO1xuXG5cdFx0Ly8gU2ltdWxhdGUgYSBzdGFydGVkIHByb2Nlc3MgYnkgc2V0dGluZyBpbnRlcm5hbCBzdGF0ZVxuXHRcdC8vIFdlIHVzZSBPYmplY3QuYXNzaWduIHRvIHNldCBwcml2YXRlIGZpZWxkcyBmb3IgdGVzdGluZ1xuXHRcdGNvbnN0IGNsaWVudEFueSA9IGNsaWVudCBhcyBhbnk7XG5cdFx0Y2xpZW50QW55LnByb2Nlc3MgPSB7XG5cdFx0XHRzdGRvdXQ6IG1vY2tTdGRvdXQsXG5cdFx0XHRzdGRlcnI6IG1vY2tTdGRlcnIsXG5cdFx0XHRzdGRpbjogbW9ja1N0ZGluLFxuXHRcdFx0ZXhpdENvZGU6IG51bGwsXG5cdFx0XHRraWxsOiAoKSA9PiB7fSxcblx0XHRcdG9uOiAoZXZlbnQ6IHN0cmluZywgaGFuZGxlcjogKC4uLmFyZ3M6IGFueVtdKSA9PiB2b2lkKSA9PiB7XG5cdFx0XHRcdGlmIChldmVudCA9PT0gXCJleGl0XCIpIHtcblx0XHRcdFx0XHQvLyBTdG9yZSBleGl0IGhhbmRsZXIgc28gd2UgY2FuIHRyaWdnZXIgaXRcblx0XHRcdFx0XHRjbGllbnRBbnkuX3Rlc3RFeGl0SGFuZGxlciA9IGhhbmRsZXI7XG5cdFx0XHRcdH1cblx0XHRcdH0sXG5cdFx0XHRyZW1vdmVMaXN0ZW5lcjogKCkgPT4ge30sXG5cdFx0fTtcblxuXHRcdC8vIEF0dGFjaCB0aGUgSlNPTkwgcmVhZGVyIGxpa2Ugc3RhcnQoKSBkb2VzXG5cdFx0Y2xpZW50QW55LnN0b3BSZWFkaW5nU3Rkb3V0ID0gYXR0YWNoSnNvbmxMaW5lUmVhZGVyKG1vY2tTdGRvdXQsIChsaW5lOiBzdHJpbmcpID0+IHtcblx0XHRcdGNsaWVudEFueS5oYW5kbGVMaW5lKGxpbmUpO1xuXHRcdH0pO1xuXG5cdFx0Ly8gQ29sbGVjdCBldmVudHMgZnJvbSB0aGUgZ2VuZXJhdG9yXG5cdFx0Y29uc3QgcmVjZWl2ZWQ6IFNka0FnZW50RXZlbnRbXSA9IFtdO1xuXHRcdGNvbnN0IGdlblByb21pc2UgPSAoYXN5bmMgKCkgPT4ge1xuXHRcdFx0Zm9yIGF3YWl0IChjb25zdCBldmVudCBvZiBjbGllbnQuZXZlbnRzKCkpIHtcblx0XHRcdFx0cmVjZWl2ZWQucHVzaChldmVudCk7XG5cdFx0XHRcdGlmIChldmVudC50eXBlID09PSBcImRvbmVcIikgYnJlYWs7XG5cdFx0XHR9XG5cdFx0fSkoKTtcblxuXHRcdC8vIERyaXZlIHRoZSBtb2NrIHN0cmVhbS4gVGhlIFBhc3NUaHJvdWdoIHBpcGVsaW5lIGRlbGl2ZXJzICdkYXRhJ1xuXHRcdC8vIHN5bmNocm9ub3VzbHkgb2ZmIHRoZSB3cml0ZTsgeWllbGRpbmcgb25lIG1hY3JvdGFzayBiZXR3ZWVuIHdyaXRlc1xuXHRcdC8vIGxldHMgdGhlIGdlbmVyYXRvcidzIGF3YWl0aW5nIHByb21pc2UgcmVzb2x2ZSBiZWZvcmUgd2UgcXVldWUgdGhlXG5cdFx0Ly8gbmV4dCBldmVudCwgcHJlc2VydmluZyB0aGUgb2JzZXJ2YWJsZSBvcmRlcmluZy5cblx0XHRtb2NrU3Rkb3V0LndyaXRlKHNlcmlhbGl6ZUpzb25MaW5lKHsgdHlwZTogXCJhZ2VudF9zdGFydFwiLCBydW5JZDogXCJyMVwiIH0pKTtcblx0XHRhd2FpdCBmbHVzaElPKCk7XG5cdFx0bW9ja1N0ZG91dC53cml0ZShzZXJpYWxpemVKc29uTGluZSh7IHR5cGU6IFwidG9rZW5cIiwgdGV4dDogXCJoZWxsb1wiIH0pKTtcblx0XHRhd2FpdCBmbHVzaElPKCk7XG5cdFx0bW9ja1N0ZG91dC53cml0ZShzZXJpYWxpemVKc29uTGluZSh7IHR5cGU6IFwiZG9uZVwiIH0pKTtcblxuXHRcdGF3YWl0IGdlblByb21pc2U7XG5cblx0XHRhc3NlcnQuZXF1YWwocmVjZWl2ZWQubGVuZ3RoLCAzKTtcblx0XHRhc3NlcnQuZXF1YWwocmVjZWl2ZWRbMF0udHlwZSwgXCJhZ2VudF9zdGFydFwiKTtcblx0XHRhc3NlcnQuZXF1YWwocmVjZWl2ZWRbMV0udHlwZSwgXCJ0b2tlblwiKTtcblx0XHRhc3NlcnQuZXF1YWwocmVjZWl2ZWRbMl0udHlwZSwgXCJkb25lXCIpO1xuXHR9KTtcblxuXHRpdChcInRlcm1pbmF0ZXMgd2hlbiBwcm9jZXNzIGV4aXRzXCIsIGFzeW5jICgpID0+IHtcblx0XHRjb25zdCBjbGllbnQgPSBuZXcgUnBjQ2xpZW50KCk7XG5cdFx0Y29uc3QgbW9ja1N0ZG91dCA9IG5ldyBQYXNzVGhyb3VnaCgpO1xuXHRcdGNvbnN0IG1vY2tTdGRlcnIgPSBuZXcgUGFzc1Rocm91Z2goKTtcblx0XHRjb25zdCBtb2NrU3RkaW4gPSBuZXcgUGFzc1Rocm91Z2goKTtcblxuXHRcdGNvbnN0IGV4aXRIYW5kbGVyczogQXJyYXk8KCkgPT4gdm9pZD4gPSBbXTtcblx0XHRjb25zdCBjbGllbnRBbnkgPSBjbGllbnQgYXMgYW55O1xuXHRcdGNsaWVudEFueS5wcm9jZXNzID0ge1xuXHRcdFx0c3Rkb3V0OiBtb2NrU3Rkb3V0LFxuXHRcdFx0c3RkZXJyOiBtb2NrU3RkZXJyLFxuXHRcdFx0c3RkaW46IG1vY2tTdGRpbixcblx0XHRcdGV4aXRDb2RlOiBudWxsLFxuXHRcdFx0a2lsbDogKCkgPT4ge30sXG5cdFx0XHRvbjogKGV2ZW50OiBzdHJpbmcsIGhhbmRsZXI6ICgpID0+IHZvaWQpID0+IHtcblx0XHRcdFx0aWYgKGV2ZW50ID09PSBcImV4aXRcIikgZXhpdEhhbmRsZXJzLnB1c2goaGFuZGxlcik7XG5cdFx0XHR9LFxuXHRcdFx0cmVtb3ZlTGlzdGVuZXI6IChldmVudDogc3RyaW5nLCBoYW5kbGVyOiAoKSA9PiB2b2lkKSA9PiB7XG5cdFx0XHRcdGNvbnN0IGlkeCA9IGV4aXRIYW5kbGVycy5pbmRleE9mKGhhbmRsZXIpO1xuXHRcdFx0XHRpZiAoaWR4ICE9PSAtMSkgZXhpdEhhbmRsZXJzLnNwbGljZShpZHgsIDEpO1xuXHRcdFx0fSxcblx0XHR9O1xuXG5cdFx0Y2xpZW50QW55LnN0b3BSZWFkaW5nU3Rkb3V0ID0gYXR0YWNoSnNvbmxMaW5lUmVhZGVyKG1vY2tTdGRvdXQsIChsaW5lOiBzdHJpbmcpID0+IHtcblx0XHRcdGNsaWVudEFueS5oYW5kbGVMaW5lKGxpbmUpO1xuXHRcdH0pO1xuXG5cdFx0Y29uc3QgcmVjZWl2ZWQ6IFNka0FnZW50RXZlbnRbXSA9IFtdO1xuXHRcdGNvbnN0IGdlblByb21pc2UgPSAoYXN5bmMgKCkgPT4ge1xuXHRcdFx0Zm9yIGF3YWl0IChjb25zdCBldmVudCBvZiBjbGllbnQuZXZlbnRzKCkpIHtcblx0XHRcdFx0cmVjZWl2ZWQucHVzaChldmVudCk7XG5cdFx0XHR9XG5cdFx0fSkoKTtcblxuXHRcdC8vIFNlbmQgb25lIGV2ZW50LCBsZXQgaXQgcHJvcGFnYXRlLCB0aGVuIHNpbXVsYXRlIHByb2Nlc3MgZXhpdC5cblx0XHRtb2NrU3Rkb3V0LndyaXRlKHNlcmlhbGl6ZUpzb25MaW5lKHsgdHlwZTogXCJhZ2VudF9zdGFydFwiIH0pKTtcblx0XHRhd2FpdCBmbHVzaElPKCk7XG5cblx0XHQvLyBGaXJlIGV4aXQgaGFuZGxlcnNcblx0XHRmb3IgKGNvbnN0IGggb2YgZXhpdEhhbmRsZXJzKSBoKCk7XG5cblx0XHRhd2FpdCBnZW5Qcm9taXNlO1xuXG5cdFx0YXNzZXJ0LmVxdWFsKHJlY2VpdmVkLmxlbmd0aCwgMSk7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlY2VpdmVkWzBdLnR5cGUsIFwiYWdlbnRfc3RhcnRcIik7XG5cdH0pO1xuXG5cdGl0KFwidGhyb3dzIGlmIGNsaWVudCBub3Qgc3RhcnRlZFwiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3QgY2xpZW50ID0gbmV3IFJwY0NsaWVudCgpO1xuXHRcdGF3YWl0IGFzc2VydC5yZWplY3RzKGFzeW5jICgpID0+IHtcblx0XHRcdC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8tdW51c2VkLXZhcnNcblx0XHRcdGZvciBhd2FpdCAoY29uc3QgX2V2ZW50IG9mIGNsaWVudC5ldmVudHMoKSkge1xuXHRcdFx0XHQvLyBzaG91bGQgbm90IHJlYWNoXG5cdFx0XHR9XG5cdFx0fSwgL0NsaWVudCBub3Qgc3RhcnRlZC8pO1xuXHR9KTtcbn0pO1xuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBzZW5kVUlSZXNwb25zZSBTZXJpYWxpemF0aW9uIFRlc3Rcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuZGVzY3JpYmUoXCJzZW5kVUlSZXNwb25zZSBzZXJpYWxpemF0aW9uXCIsICgpID0+IHtcblx0aXQoXCJ3cml0ZXMgY29ycmVjdCBKU09OTCB0byBzdGRpblwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgY2xpZW50ID0gbmV3IFJwY0NsaWVudCgpO1xuXHRcdGNvbnN0IGNodW5rczogc3RyaW5nW10gPSBbXTtcblx0XHRjb25zdCBtb2NrU3RkaW4gPSB7XG5cdFx0XHR3cml0ZTogKGRhdGE6IHN0cmluZykgPT4ge1xuXHRcdFx0XHRjaHVua3MucHVzaChkYXRhKTtcblx0XHRcdFx0cmV0dXJuIHRydWU7XG5cdFx0XHR9LFxuXHRcdH07XG5cblx0XHRjb25zdCBjbGllbnRBbnkgPSBjbGllbnQgYXMgYW55O1xuXHRcdGNsaWVudEFueS5wcm9jZXNzID0geyBzdGRpbjogbW9ja1N0ZGluIH07XG5cblx0XHRjbGllbnQuc2VuZFVJUmVzcG9uc2UoXCJ1aV8xXCIsIHsgdmFsdWU6IFwiaGVsbG9cIiB9KTtcblxuXHRcdGFzc2VydC5lcXVhbChjaHVua3MubGVuZ3RoLCAxKTtcblx0XHRjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKGNodW5rc1swXS50cmltKCkpO1xuXHRcdGFzc2VydC5lcXVhbChwYXJzZWQudHlwZSwgXCJleHRlbnNpb25fdWlfcmVzcG9uc2VcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKHBhcnNlZC5pZCwgXCJ1aV8xXCIpO1xuXHRcdGFzc2VydC5lcXVhbChwYXJzZWQudmFsdWUsIFwiaGVsbG9cIik7XG5cdH0pO1xuXG5cdGl0KFwic2VyaWFsaXplcyBjb25maXJtZWQgcmVzcG9uc2VcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGNsaWVudCA9IG5ldyBScGNDbGllbnQoKTtcblx0XHRjb25zdCBjaHVua3M6IHN0cmluZ1tdID0gW107XG5cdFx0Y29uc3QgbW9ja1N0ZGluID0ge1xuXHRcdFx0d3JpdGU6IChkYXRhOiBzdHJpbmcpID0+IHtcblx0XHRcdFx0Y2h1bmtzLnB1c2goZGF0YSk7XG5cdFx0XHRcdHJldHVybiB0cnVlO1xuXHRcdFx0fSxcblx0XHR9O1xuXHRcdGNvbnN0IGNsaWVudEFueSA9IGNsaWVudCBhcyBhbnk7XG5cdFx0Y2xpZW50QW55LnByb2Nlc3MgPSB7IHN0ZGluOiBtb2NrU3RkaW4gfTtcblxuXHRcdGNsaWVudC5zZW5kVUlSZXNwb25zZShcInVpXzJcIiwgeyBjb25maXJtZWQ6IHRydWUgfSk7XG5cblx0XHRjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKGNodW5rc1swXS50cmltKCkpO1xuXHRcdGFzc2VydC5lcXVhbChwYXJzZWQuY29uZmlybWVkLCB0cnVlKTtcblx0XHRhc3NlcnQuZXF1YWwocGFyc2VkLmlkLCBcInVpXzJcIik7XG5cdH0pO1xuXG5cdGl0KFwic2VyaWFsaXplcyBjYW5jZWxsZWQgcmVzcG9uc2VcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGNsaWVudCA9IG5ldyBScGNDbGllbnQoKTtcblx0XHRjb25zdCBjaHVua3M6IHN0cmluZ1tdID0gW107XG5cdFx0Y29uc3QgbW9ja1N0ZGluID0ge1xuXHRcdFx0d3JpdGU6IChkYXRhOiBzdHJpbmcpID0+IHtcblx0XHRcdFx0Y2h1bmtzLnB1c2goZGF0YSk7XG5cdFx0XHRcdHJldHVybiB0cnVlO1xuXHRcdFx0fSxcblx0XHR9O1xuXHRcdGNvbnN0IGNsaWVudEFueSA9IGNsaWVudCBhcyBhbnk7XG5cdFx0Y2xpZW50QW55LnByb2Nlc3MgPSB7IHN0ZGluOiBtb2NrU3RkaW4gfTtcblxuXHRcdGNsaWVudC5zZW5kVUlSZXNwb25zZShcInVpXzNcIiwgeyBjYW5jZWxsZWQ6IHRydWUgfSk7XG5cblx0XHRjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKGNodW5rc1swXS50cmltKCkpO1xuXHRcdGFzc2VydC5lcXVhbChwYXJzZWQuY2FuY2VsbGVkLCB0cnVlKTtcblx0fSk7XG59KTtcblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gaW5pdC9zaHV0ZG93bi9zdWJzY3JpYmUgU2VyaWFsaXphdGlvbiBUZXN0c1xuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5kZXNjcmliZShcInYyIGNvbW1hbmQgc2VyaWFsaXphdGlvblwiLCAoKSA9PiB7XG5cdC8vIEhlbHBlcjogY2FwdHVyZSB3aGF0IHRoZSBjbGllbnQgc2VuZHMgdG8gc3RkaW5cblx0ZnVuY3Rpb24gY3JlYXRlTW9ja0NsaWVudCgpOiB7IGNsaWVudDogUnBjQ2xpZW50OyBzZW50OiBhbnlbXTsgcmVzcG9uZE5leHQ6IChkYXRhPzogYW55KSA9PiB2b2lkIH0ge1xuXHRcdGNvbnN0IGNsaWVudCA9IG5ldyBScGNDbGllbnQoKTtcblx0XHRjb25zdCBzZW50OiBhbnlbXSA9IFtdO1xuXHRcdGxldCByZXNwb25kRm46ICgoZGF0YTogYW55KSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuXG5cdFx0Y29uc3QgY2xpZW50QW55ID0gY2xpZW50IGFzIGFueTtcblx0XHRjbGllbnRBbnkucHJvY2VzcyA9IHtcblx0XHRcdHN0ZGluOiB7XG5cdFx0XHRcdHdyaXRlOiAoZGF0YTogc3RyaW5nKSA9PiB7XG5cdFx0XHRcdFx0Y29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShkYXRhLnRyaW0oKSk7XG5cdFx0XHRcdFx0c2VudC5wdXNoKHBhcnNlZCk7XG5cdFx0XHRcdFx0Ly8gQXV0by1yZXNwb25kIG9uIHRoZSBtaWNyb3Rhc2sgcXVldWUuIFRoaXMgaXMgZGV0ZXJtaW5pc3RpYyBcdTIwMTRcblx0XHRcdFx0XHQvLyBhbnkgYGF3YWl0YCBpbiB0aGUgY2FsbGVyIHlpZWxkcyBiZWZvcmUgdGhlIGNhbGxiYWNrIHJ1bnMsXG5cdFx0XHRcdFx0Ly8gc28gdGhlIGNhbGxlcidzIGBwZW5kaW5nUmVxdWVzdHNgIGVudHJ5IGlzIGluc3RhbGxlZCBiZWZvcmVcblx0XHRcdFx0XHQvLyBgaGFuZGxlTGluZWAgdHJpZXMgdG8gcmVzb2x2ZSBpdC5cblx0XHRcdFx0XHRpZiAocmVzcG9uZEZuKSB7XG5cdFx0XHRcdFx0XHRxdWV1ZU1pY3JvdGFzaygoKSA9PiByZXNwb25kRm4hKHBhcnNlZCkpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRyZXR1cm4gdHJ1ZTtcblx0XHRcdFx0fSxcblx0XHRcdH0sXG5cdFx0XHRzdGRlcnI6IG5ldyBQYXNzVGhyb3VnaCgpLFxuXHRcdFx0ZXhpdENvZGU6IG51bGwsXG5cdFx0XHRraWxsOiAoKSA9PiB7fSxcblx0XHRcdG9uOiAoKSA9PiB7fSxcblx0XHRcdHJlbW92ZUxpc3RlbmVyOiAoKSA9PiB7fSxcblx0XHR9O1xuXG5cdFx0Y29uc3QgcmVzcG9uZE5leHQgPSAob3ZlcnJpZGVzOiBhbnkgPSB7fSkgPT4ge1xuXHRcdFx0cmVzcG9uZEZuID0gKHBhcnNlZCkgPT4ge1xuXHRcdFx0XHRjb25zdCByZXNwb25zZSA9IHtcblx0XHRcdFx0XHR0eXBlOiBcInJlc3BvbnNlXCIsXG5cdFx0XHRcdFx0aWQ6IHBhcnNlZC5pZCxcblx0XHRcdFx0XHRjb21tYW5kOiBwYXJzZWQudHlwZSxcblx0XHRcdFx0XHRzdWNjZXNzOiB0cnVlLFxuXHRcdFx0XHRcdGRhdGE6IHt9LFxuXHRcdFx0XHRcdC4uLm92ZXJyaWRlcyxcblx0XHRcdFx0fTtcblx0XHRcdFx0Y2xpZW50QW55LmhhbmRsZUxpbmUoSlNPTi5zdHJpbmdpZnkocmVzcG9uc2UpKTtcblx0XHRcdH07XG5cdFx0fTtcblxuXHRcdHJldHVybiB7IGNsaWVudCwgc2VudCwgcmVzcG9uZE5leHQgfTtcblx0fVxuXG5cdGl0KFwiaW5pdCBzZW5kcyBjb3JyZWN0IHYyIGluaXQgY29tbWFuZFwiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3QgeyBjbGllbnQsIHNlbnQsIHJlc3BvbmROZXh0IH0gPSBjcmVhdGVNb2NrQ2xpZW50KCk7XG5cdFx0cmVzcG9uZE5leHQoeyBkYXRhOiB7IHByb3RvY29sVmVyc2lvbjogMiwgc2Vzc2lvbklkOiBcInMxXCIsIGNhcGFiaWxpdGllczogeyBldmVudHM6IFtdLCBjb21tYW5kczogW10gfSB9IH0pO1xuXG5cdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgY2xpZW50LmluaXQoeyBjbGllbnRJZDogXCJ0ZXN0LWFwcFwiIH0pO1xuXG5cdFx0YXNzZXJ0LmVxdWFsKHNlbnQubGVuZ3RoLCAxKTtcblx0XHRhc3NlcnQuZXF1YWwoc2VudFswXS50eXBlLCBcImluaXRcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKHNlbnRbMF0ucHJvdG9jb2xWZXJzaW9uLCAyKTtcblx0XHRhc3NlcnQuZXF1YWwoc2VudFswXS5jbGllbnRJZCwgXCJ0ZXN0LWFwcFwiKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0LnByb3RvY29sVmVyc2lvbiwgMik7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uSWQsIFwiczFcIik7XG5cdH0pO1xuXG5cdGl0KFwic2h1dGRvd24gc2VuZHMgc2h1dGRvd24gY29tbWFuZFwiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3QgeyBjbGllbnQsIHNlbnQsIHJlc3BvbmROZXh0IH0gPSBjcmVhdGVNb2NrQ2xpZW50KCk7XG5cblx0XHQvLyBPdmVycmlkZSB0aGUgcHJvY2VzcyBleGl0IHdhaXRcblx0XHRjb25zdCBjbGllbnRBbnkgPSBjbGllbnQgYXMgYW55O1xuXHRcdGNvbnN0IG9yaWdpbmFsUHJvY2VzcyA9IGNsaWVudEFueS5wcm9jZXNzO1xuXHRcdGNvbnN0IGV4aXRIYW5kbGVyczogQXJyYXk8KGNvZGU6IG51bWJlcikgPT4gdm9pZD4gPSBbXTtcblx0XHRjbGllbnRBbnkucHJvY2VzcyA9IHtcblx0XHRcdC4uLm9yaWdpbmFsUHJvY2Vzcyxcblx0XHRcdG9uOiAoZXZlbnQ6IHN0cmluZywgaGFuZGxlcjogKGNvZGU6IG51bWJlcikgPT4gdm9pZCkgPT4ge1xuXHRcdFx0XHRpZiAoZXZlbnQgPT09IFwiZXhpdFwiKSBleGl0SGFuZGxlcnMucHVzaChoYW5kbGVyKTtcblx0XHRcdH0sXG5cdFx0fTtcblxuXHRcdHJlc3BvbmROZXh0KCk7XG5cblx0XHQvLyBDYWxsIHNodXRkb3duIGFuZCBzaW11bGF0ZSBwcm9jZXNzIGV4aXQuIGBmbHVzaElPYCBkcmFpbnMgdGhlXG5cdFx0Ly8gcXVldWVkIHN0ZGluIHdyaXRlIC0+IGF1dG8tcmVzcG9uZCAtPiBoYW5kbGVMaW5lIGNoYWluIHRoYXQgb3VyXG5cdFx0Ly8gbW9jayB0cmlnZ2VycyBvbiBldmVyeSBgc2VuZGAsIHNvIGJ5IHRoZSB0aW1lIHdlIGZpcmUgdGhlIGV4aXRcblx0XHQvLyBoYW5kbGVycyB0aGUgc2h1dGRvd24gYWNrIGhhcyBiZWVuIG9ic2VydmVkLlxuXHRcdGNvbnN0IHNodXRkb3duUHJvbWlzZSA9IGNsaWVudC5zaHV0ZG93bigpO1xuXHRcdGF3YWl0IGZsdXNoSU8oKTtcblx0XHRhd2FpdCBmbHVzaElPKCk7XG5cdFx0Zm9yIChjb25zdCBoIG9mIGV4aXRIYW5kbGVycykgaCgwKTtcblxuXHRcdGF3YWl0IHNodXRkb3duUHJvbWlzZTtcblxuXHRcdGFzc2VydC5lcXVhbChzZW50Lmxlbmd0aCwgMSk7XG5cdFx0YXNzZXJ0LmVxdWFsKHNlbnRbMF0udHlwZSwgXCJzaHV0ZG93blwiKTtcblx0fSk7XG5cblx0aXQoXCJzdWJzY3JpYmUgc2VuZHMgc3Vic2NyaWJlIGNvbW1hbmQgd2l0aCBldmVudCBsaXN0XCIsIGFzeW5jICgpID0+IHtcblx0XHRjb25zdCB7IGNsaWVudCwgc2VudCwgcmVzcG9uZE5leHQgfSA9IGNyZWF0ZU1vY2tDbGllbnQoKTtcblx0XHRyZXNwb25kTmV4dCgpO1xuXG5cdFx0YXdhaXQgY2xpZW50LnN1YnNjcmliZShbXCJleGVjdXRpb25fY29tcGxldGVcIiwgXCJjb3N0X3VwZGF0ZVwiXSk7XG5cblx0XHRhc3NlcnQuZXF1YWwoc2VudC5sZW5ndGgsIDEpO1xuXHRcdGFzc2VydC5lcXVhbChzZW50WzBdLnR5cGUsIFwic3Vic2NyaWJlXCIpO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwoc2VudFswXS5ldmVudHMsIFtcImV4ZWN1dGlvbl9jb21wbGV0ZVwiLCBcImNvc3RfdXBkYXRlXCJdKTtcblx0fSk7XG5cblx0aXQoXCJzdWJzY3JpYmUgd2l0aCB3aWxkY2FyZFwiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3QgeyBjbGllbnQsIHNlbnQsIHJlc3BvbmROZXh0IH0gPSBjcmVhdGVNb2NrQ2xpZW50KCk7XG5cdFx0cmVzcG9uZE5leHQoKTtcblxuXHRcdGF3YWl0IGNsaWVudC5zdWJzY3JpYmUoW1wiKlwiXSk7XG5cblx0XHRhc3NlcnQuZXF1YWwoc2VudFswXS5ldmVudHMubGVuZ3RoLCAxKTtcblx0XHRhc3NlcnQuZXF1YWwoc2VudFswXS5ldmVudHNbMF0sIFwiKlwiKTtcblx0fSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsVUFBVSxVQUFVO0FBQzdCLE9BQU8sWUFBWTtBQUNuQixTQUFTLG1CQUFtQjtBQUM1QixTQUFTLFlBQVk7QUFDckIsU0FBUyxtQkFBbUIsNkJBQTZCO0FBU3pELFNBQVMsaUJBQWlCO0FBVzFCLFNBQVMsVUFBeUI7QUFDakMsU0FBTyxJQUFJLFFBQVEsQ0FBQyxZQUFZLGFBQWEsT0FBTyxDQUFDO0FBQ3REO0FBTUEsU0FBUyxxQkFBcUIsTUFBTTtBQUNuQyxLQUFHLDBDQUEwQyxNQUFNO0FBQ2xELFVBQU0sU0FBUyxrQkFBa0IsRUFBRSxNQUFN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
