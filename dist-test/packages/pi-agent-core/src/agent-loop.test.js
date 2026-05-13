import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Type } from "@sinclair/typebox";
import { agentLoop, MAX_CONSECUTIVE_VALIDATION_FAILURES } from "./agent-loop.js";
import { AssistantMessageEventStream } from "@gsd/pi-ai";
describe("agent-loop \u2014 pauseTurn handling (#2869)", () => {
  it("emits token audit after context transforms when opted in", async () => {
    const finalStop = makeAssistantMessage({
      content: [{ type: "text", text: "Done." }],
      stopReason: "stop"
    });
    const original = process.env.PI_TOKEN_AUDIT;
    const originalWrite = process.stderr.write;
    let written = "";
    process.env.PI_TOKEN_AUDIT = "1";
    process.stderr.write = ((chunk) => {
      written += chunk.toString();
      return true;
    });
    try {
      let filteredMessages;
      const streamFn = (_model, llmContext) => {
        assert.equal(llmContext.messages.length, 1, "audit boundary must use transformed context");
        assert.equal(llmContext.messages[0].content[0].text, "transformed");
        const stream2 = new AssistantMessageEventStream();
        queueMicrotask(() => {
          stream2.push({ type: "start", partial: finalStop });
          stream2.push({ type: "done", message: finalStop });
          stream2.end(finalStop);
        });
        return stream2;
      };
      const context = {
        systemPrompt: "sensitive system",
        messages: [{ role: "user", content: [{ type: "text", text: "original" }], timestamp: Date.now() }],
        tools: []
      };
      const config = {
        model: TEST_MODEL,
        transformContext: async () => [
          { role: "user", content: [{ type: "text", text: "transformed" }], timestamp: Date.now() }
        ],
        convertToLlm: (msgs) => msgs.filter((m) => m.role !== "custom"),
        filterTools: (tools, _signal, messages) => {
          filteredMessages = messages;
          return tools;
        },
        toolExecution: "sequential"
      };
      const stream = agentLoop(
        [{ role: "user", content: [{ type: "text", text: "new prompt" }], timestamp: Date.now() }],
        context,
        config,
        void 0,
        streamFn
      );
      await collectEvents(stream);
      assert.match(written, /"type":"token_audit"/);
      assert.match(written, /"messageCount":1/);
      assert.equal(filteredMessages?.[0]?.content?.[0]?.text, "transformed");
      assert.doesNotMatch(written, /transformed|original|new prompt|sensitive system/);
    } finally {
      process.stderr.write = originalWrite;
      if (original === void 0) delete process.env.PI_TOKEN_AUDIT;
      else process.env.PI_TOKEN_AUDIT = original;
    }
  });
  it("applies final tool filtering before token audit and provider streaming", async () => {
    const finalStop = makeAssistantMessage({
      content: [{ type: "text", text: "Done." }],
      stopReason: "stop"
    });
    const original = process.env.PI_TOKEN_AUDIT;
    const originalWrite = process.stderr.write;
    let written = "";
    process.env.PI_TOKEN_AUDIT = "1";
    process.stderr.write = ((chunk) => {
      written += chunk.toString();
      return true;
    });
    try {
      const streamFn = (_model, llmContext) => {
        assert.deepEqual(llmContext.tools?.map((tool) => tool.name), ["write_file"]);
        const stream2 = new AssistantMessageEventStream();
        queueMicrotask(() => {
          stream2.push({ type: "start", partial: finalStop });
          stream2.push({ type: "done", message: finalStop });
          stream2.end(finalStop);
        });
        return stream2;
      };
      const context = {
        systemPrompt: "You are a test agent.",
        messages: [{ role: "user", content: [{ type: "text", text: "Use a tool" }], timestamp: Date.now() }],
        tools: [
          makeToolWithSchema(),
          {
            ...makeToolWithSchema(),
            name: "drop_tool",
            label: "Drop Tool"
          }
        ]
      };
      const config = {
        model: TEST_MODEL,
        convertToLlm: (msgs) => msgs.filter((m) => m.role !== "custom"),
        filterTools: async (tools) => tools.filter((tool) => tool.name === "write_file"),
        toolExecution: "sequential"
      };
      const stream = agentLoop(
        [{ role: "user", content: [{ type: "text", text: "Use a tool" }], timestamp: Date.now() }],
        context,
        config,
        void 0,
        streamFn
      );
      await collectEvents(stream);
      assert.match(written, /"toolCount":1/);
      assert.match(written, /"name":"write_file"/);
      assert.doesNotMatch(written, /drop_tool/);
    } finally {
      process.stderr.write = originalWrite;
      if (original === void 0) delete process.env.PI_TOKEN_AUDIT;
      else process.env.PI_TOKEN_AUDIT = original;
    }
  });
  it("continues to a second assistant turn when stopReason is pauseTurn", async () => {
    const pauseTurn = makeAssistantMessage({
      content: [{ type: "text", text: "Still working..." }],
      stopReason: "pauseTurn"
    });
    const finalStop = makeAssistantMessage({
      content: [{ type: "text", text: "Done." }],
      stopReason: "stop"
    });
    let streamCallCount = 0;
    const seenLastRoles = [];
    const streamFn = (_model, llmContext) => {
      streamCallCount++;
      seenLastRoles.push(llmContext.messages.at(-1)?.role ?? "none");
      const message = streamCallCount === 1 ? pauseTurn : finalStop;
      const stream2 = new AssistantMessageEventStream();
      queueMicrotask(() => {
        stream2.push({ type: "start", partial: message });
        stream2.push({ type: "done", message });
        stream2.end(message);
      });
      return stream2;
    };
    const context = {
      systemPrompt: "You are a test agent.",
      messages: [{ role: "user", content: [{ type: "text", text: "Keep going" }], timestamp: Date.now() }],
      tools: []
    };
    const config = {
      model: TEST_MODEL,
      convertToLlm: (msgs) => msgs.filter((m) => m.role !== "custom"),
      toolExecution: "sequential"
    };
    const stream = agentLoop(
      [{ role: "user", content: [{ type: "text", text: "Keep going" }], timestamp: Date.now() }],
      context,
      config,
      void 0,
      streamFn
    );
    const events = await collectEvents(stream);
    const assistantMessages = events.filter(
      (event) => event.type === "message_end" && event.message.role === "assistant"
    );
    const turnStarts = events.filter((event) => event.type === "turn_start");
    assert.equal(streamCallCount, 2, "pauseTurn must cause a second provider call");
    assert.equal(assistantMessages.length, 2, "expected two assistant turns");
    assert.equal(assistantMessages[0].message.stopReason, "pauseTurn");
    assert.equal(assistantMessages[1].message.stopReason, "stop");
    assert.equal(turnStarts.length, 2, "expected a second turn_start after pauseTurn");
    assert.deepEqual(seenLastRoles, ["user", "assistant"], "second turn must continue from the paused assistant state");
  });
  it("uses provider-supplied external tool results instead of the placeholder", async () => {
    const externalMessage = makeAssistantMessage({
      content: [
        {
          type: "toolCall",
          id: "tc-external-1",
          name: "bash",
          arguments: { command: "echo hi" },
          externalResult: {
            content: [{ type: "text", text: "hi\n" }],
            details: { source: "claude-code" },
            isError: false
          }
        }
      ],
      stopReason: "toolUse",
      provider: "claude-code"
    });
    const mockStream = createMockStreamFn([externalMessage]);
    const context = {
      systemPrompt: "You are a test agent.",
      messages: [{ role: "user", content: [{ type: "text", text: "Run the command" }], timestamp: Date.now() }],
      tools: []
    };
    const config = {
      model: { ...TEST_MODEL, provider: "claude-code" },
      convertToLlm: (msgs) => msgs.filter((m) => m.role !== "custom"),
      toolExecution: "sequential",
      externalToolExecution: true
    };
    const stream = agentLoop(
      [{ role: "user", content: [{ type: "text", text: "Run the command" }], timestamp: Date.now() }],
      context,
      config,
      void 0,
      mockStream
    );
    const events = await collectEvents(stream);
    const toolEnd = events.find(
      (event) => event.type === "tool_execution_end"
    );
    assert.ok(toolEnd, "expected tool_execution_end event");
    assert.deepEqual(toolEnd.result.content, [{ type: "text", text: "hi\n" }]);
    assert.deepEqual(toolEnd.result.details, { source: "claude-code" });
    assert.equal(toolEnd.isError, false);
  });
  it("injects queued steering messages before the next assistant turn and skips remaining tools", async () => {
    const tool = makeToolWithSchema();
    const steeringMessage = {
      role: "user",
      content: [{ type: "text", text: "Stop after the first tool." }],
      timestamp: Date.now()
    };
    const toolTurn = makeAssistantMessage({
      content: [
        {
          type: "toolCall",
          id: "write-1",
          name: "write_file",
          arguments: { path: "/tmp/one", content: "first" }
        },
        {
          type: "toolCall",
          id: "write-2",
          name: "write_file",
          arguments: { path: "/tmp/two", content: "second" }
        }
      ],
      stopReason: "toolUse"
    });
    const finalStop = makeAssistantMessage({
      content: [{ type: "text", text: "Stopped after the first tool." }],
      stopReason: "stop"
    });
    let steeringPollCount = 0;
    const seenLastMessages = [];
    const streamFn = (_model, llmContext) => {
      seenLastMessages.push(llmContext.messages.at(-1));
      const message = seenLastMessages.length === 1 ? toolTurn : finalStop;
      const stream2 = new AssistantMessageEventStream();
      queueMicrotask(() => {
        stream2.push({ type: "start", partial: message });
        stream2.push({ type: "done", message });
        stream2.end(message);
      });
      return stream2;
    };
    const context = {
      systemPrompt: "You are a test agent.",
      messages: [{ role: "user", content: [{ type: "text", text: "Write both files" }], timestamp: Date.now() }],
      tools: [tool]
    };
    const config = {
      model: TEST_MODEL,
      convertToLlm: (msgs) => msgs.filter((m) => m.role !== "custom"),
      toolExecution: "sequential",
      getSteeringMessages: async () => {
        steeringPollCount++;
        return steeringPollCount === 2 ? [steeringMessage] : [];
      }
    };
    const stream = agentLoop(
      [{ role: "user", content: [{ type: "text", text: "Write both files" }], timestamp: Date.now() }],
      context,
      config,
      void 0,
      streamFn
    );
    const events = await collectEvents(stream);
    const toolEnds = events.filter(
      (event) => event.type === "tool_execution_end"
    );
    const steeringEnd = events.find(
      (event) => event.type === "message_end" && event.message.role === "user" && event.message.content[0]?.text === "Stop after the first tool."
    );
    assert.equal(toolEnds.length, 2, "expected one executed tool and one skipped tool");
    assert.ok(
      toolEnds.some((event) => JSON.stringify(event.result.content) === JSON.stringify([{ type: "text", text: "done" }])),
      "expected one completed tool result"
    );
    assert.ok(
      toolEnds.some(
        (event) => JSON.stringify(event.result.content) === JSON.stringify([{ type: "text", text: "Skipped due to queued user message." }])
      ),
      "expected one skipped tool result after steering interruption"
    );
    assert.ok(steeringEnd, "queued steering message should be emitted before the next assistant turn");
    assert.equal(seenLastMessages[1]?.content?.[0]?.text, "Stop after the first tool.");
  });
  it("restarts the outer loop when follow-up messages arrive after a stop", async () => {
    const initialStop = makeAssistantMessage({
      content: [{ type: "text", text: "First answer." }],
      stopReason: "stop"
    });
    const followUpStop = makeAssistantMessage({
      content: [{ type: "text", text: "Follow-up answer." }],
      stopReason: "stop"
    });
    const followUpMessage = {
      role: "user",
      content: [{ type: "text", text: "One more thing." }],
      timestamp: Date.now()
    };
    let followUpPollCount = 0;
    const seenLastMessages = [];
    const streamFn = (_model, llmContext) => {
      seenLastMessages.push(llmContext.messages.at(-1));
      const message = seenLastMessages.length === 1 ? initialStop : followUpStop;
      const stream2 = new AssistantMessageEventStream();
      queueMicrotask(() => {
        stream2.push({ type: "start", partial: message });
        stream2.push({ type: "done", message });
        stream2.end(message);
      });
      return stream2;
    };
    const context = {
      systemPrompt: "You are a test agent.",
      messages: [{ role: "user", content: [{ type: "text", text: "Initial prompt" }], timestamp: Date.now() }],
      tools: []
    };
    const config = {
      model: TEST_MODEL,
      convertToLlm: (msgs) => msgs.filter((m) => m.role !== "custom"),
      toolExecution: "sequential",
      getFollowUpMessages: async () => {
        followUpPollCount++;
        return followUpPollCount === 1 ? [followUpMessage] : [];
      }
    };
    const stream = agentLoop(
      [{ role: "user", content: [{ type: "text", text: "Initial prompt" }], timestamp: Date.now() }],
      context,
      config,
      void 0,
      streamFn
    );
    const events = await collectEvents(stream);
    const assistantEnds = events.filter(
      (event) => event.type === "message_end" && event.message.role === "assistant"
    );
    const followUpEnd = events.find(
      (event) => event.type === "message_end" && event.message.role === "user" && event.message.content[0]?.text === "One more thing."
    );
    assert.equal(assistantEnds.length, 2, "expected the agent loop to restart for the follow-up turn");
    assert.ok(followUpEnd, "follow-up message should be emitted before the restarted assistant turn");
    assert.equal(seenLastMessages[1]?.content?.[0]?.text, "One more thing.");
  });
});
const TEST_MODEL = {
  id: "claude-test",
  name: "Test Model",
  api: "anthropic-messages",
  provider: "anthropic",
  contextWindow: 2e5,
  maxOutput: 4096,
  supportsImages: false,
  supportsPromptCache: false,
  thinkingLevel: void 0
};
function makeToolWithSchema() {
  return {
    name: "write_file",
    label: "Write File",
    description: "Write content to a file",
    parameters: Type.Object({
      path: Type.String(),
      content: Type.String()
    }),
    execute: async () => ({
      content: [{ type: "text", text: "done" }],
      details: {}
    })
  };
}
function createMockStreamFn(responses) {
  let callIndex = 0;
  return function mockStreamFn() {
    const message = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    const stream = new AssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", message });
      stream.end(message);
    });
    return stream;
  };
}
function makeAssistantMessage(overrides = {}) {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-test",
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides
  };
}
function makeToolCallMessage(toolCallArgs) {
  return makeAssistantMessage({
    content: [
      {
        type: "toolCall",
        id: `tc_${Date.now()}_${Math.random()}`,
        name: "write_file",
        arguments: toolCallArgs
      }
    ],
    stopReason: "toolUse"
  });
}
function collectEvents(stream) {
  return new Promise(async (resolve) => {
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }
    resolve(events);
  });
}
describe("agent-loop \u2014 schema overload retry cap (#2783)", () => {
  it("terminates after MAX_CONSECUTIVE_VALIDATION_FAILURES consecutive schema failures", async () => {
    const tool = makeToolWithSchema();
    const badToolCall = makeToolCallMessage({ path: "/tmp/test" });
    const finalStop = makeAssistantMessage({ content: [{ type: "text", text: "I give up." }], stopReason: "stop" });
    const responses = [];
    for (let i = 0; i < MAX_CONSECUTIVE_VALIDATION_FAILURES + 5; i++) {
      responses.push(badToolCall);
    }
    responses.push(finalStop);
    const mockStream = createMockStreamFn(responses);
    const context = {
      systemPrompt: "You are a test agent.",
      messages: [{ role: "user", content: [{ type: "text", text: "Write a file" }], timestamp: Date.now() }],
      tools: [tool]
    };
    const config = {
      model: TEST_MODEL,
      convertToLlm: (msgs) => msgs.filter((m) => m.role !== "custom"),
      toolExecution: "sequential"
    };
    const stream = agentLoop(
      [{ role: "user", content: [{ type: "text", text: "Write a file" }], timestamp: Date.now() }],
      context,
      config,
      void 0,
      mockStream
    );
    const events = await collectEvents(stream);
    const agentEnd = events.find((e) => e.type === "agent_end");
    assert.ok(agentEnd, "agent loop must emit agent_end after hitting retry cap");
    const toolErrors = events.filter(
      (e) => e.type === "tool_execution_end" && e.isError === true
    );
    assert.ok(
      toolErrors.length <= MAX_CONSECUTIVE_VALIDATION_FAILURES,
      `Expected at most ${MAX_CONSECUTIVE_VALIDATION_FAILURES} validation error tool results, got ${toolErrors.length}`
    );
  });
  it("resets the failure counter when a tool call succeeds", async () => {
    const tool = makeToolWithSchema();
    const badCall = makeToolCallMessage({ path: "/tmp/test" });
    const goodCall = makeToolCallMessage({ path: "/tmp/test", content: "hello" });
    const finalStop = makeAssistantMessage({ content: [{ type: "text", text: "Done." }], stopReason: "stop" });
    const responses = [badCall, badCall, goodCall, badCall, badCall, goodCall, finalStop];
    const mockStream = createMockStreamFn(responses);
    const context = {
      systemPrompt: "You are a test agent.",
      messages: [{ role: "user", content: [{ type: "text", text: "Write a file" }], timestamp: Date.now() }],
      tools: [tool]
    };
    const config = {
      model: TEST_MODEL,
      convertToLlm: (msgs) => msgs.filter((m) => m.role !== "custom"),
      toolExecution: "sequential"
    };
    const stream = agentLoop(
      [{ role: "user", content: [{ type: "text", text: "Write a file" }], timestamp: Date.now() }],
      context,
      config,
      void 0,
      mockStream
    );
    const events = await collectEvents(stream);
    const agentEnd = events.find((e) => e.type === "agent_end");
    assert.ok(agentEnd, "agent loop must complete normally when failures are interspersed with successes");
    const toolExecEnds = events.filter((e) => e.type === "tool_execution_end");
    assert.ok(toolExecEnds.length >= 4, `Expected at least 4 tool executions (2 bad + 1 good + 2 bad + 1 good), got ${toolExecEnds.length}`);
  });
  it("exports MAX_CONSECUTIVE_VALIDATION_FAILURES as a configurable constant", () => {
    assert.equal(typeof MAX_CONSECUTIVE_VALIDATION_FAILURES, "number");
    assert.ok(MAX_CONSECUTIVE_VALIDATION_FAILURES >= 2, "Cap must be at least 2 to allow one retry");
    assert.ok(MAX_CONSECUTIVE_VALIDATION_FAILURES <= 10, "Cap must not be unreasonably high");
  });
  it("does NOT trip schema overload cap on tool execution errors like bash exit code 1 (#3618)", async () => {
    const bashTool = {
      name: "bash",
      label: "Bash",
      description: "Run a bash command",
      parameters: Type.Object({
        command: Type.String()
      }),
      execute: async () => {
        throw new Error("(no output)\n\nCommand exited with code 1");
      }
    };
    const validBashCall = makeAssistantMessage({
      content: [
        {
          type: "toolCall",
          id: `tc_bash_${Date.now()}_${Math.random()}`,
          name: "bash",
          arguments: { command: "rg -l 'nonexistent' src/" }
        }
      ],
      stopReason: "toolUse"
    });
    const finalStop = makeAssistantMessage({
      content: [{ type: "text", text: "No references found." }],
      stopReason: "stop"
    });
    const responses = [];
    for (let i = 0; i < MAX_CONSECUTIVE_VALIDATION_FAILURES + 2; i++) {
      responses.push(validBashCall);
    }
    responses.push(finalStop);
    const mockStream = createMockStreamFn(responses);
    const context = {
      systemPrompt: "You are a test agent.",
      messages: [{ role: "user", content: [{ type: "text", text: "Search for references" }], timestamp: Date.now() }],
      tools: [bashTool]
    };
    const config = {
      model: TEST_MODEL,
      convertToLlm: (msgs) => msgs.filter((m) => m.role !== "custom"),
      toolExecution: "sequential"
    };
    const stream = agentLoop(
      [{ role: "user", content: [{ type: "text", text: "Search for references" }], timestamp: Date.now() }],
      context,
      config,
      void 0,
      mockStream
    );
    const events = await collectEvents(stream);
    const agentEnd = events.find((e) => e.type === "agent_end");
    assert.ok(agentEnd, "agent loop must emit agent_end");
    const toolErrors = events.filter(
      (e) => e.type === "tool_execution_end" && e.isError === true
    );
    assert.ok(
      toolErrors.length >= MAX_CONSECUTIVE_VALIDATION_FAILURES + 2,
      `Expected all ${MAX_CONSECUTIVE_VALIDATION_FAILURES + 2} bash execution errors to be processed (not capped), got ${toolErrors.length}`
    );
    const allMessages = agentEnd.messages;
    const lastMessage = allMessages[allMessages.length - 1];
    const lastText = lastMessage.role === "assistant" ? lastMessage.content.find((c) => c.type === "text") : void 0;
    if (lastText && lastText.type === "text") {
      assert.ok(
        !lastText.text.includes("consecutive turns with all tool calls failing"),
        "Final message must NOT contain schema overload stop text for execution-only errors"
      );
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWdlbnQtY29yZS9zcmMvYWdlbnQtbG9vcC50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBhZ2VudC1sb29wIHRlc3RzXG4vLyBDb3ZlcnM6IHBhdXNlVHVybiBoYW5kbGluZyAoIzI4NjkpLCBzY2hlbWEgb3ZlcmxvYWQgcmV0cnkgY2FwICgjMjc4MylcblxuaW1wb3J0IHsgZGVzY3JpYmUsIGl0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBUeXBlIH0gZnJvbSBcIkBzaW5jbGFpci90eXBlYm94XCI7XG5pbXBvcnQgeyBhZ2VudExvb3AsIE1BWF9DT05TRUNVVElWRV9WQUxJREFUSU9OX0ZBSUxVUkVTIH0gZnJvbSBcIi4vYWdlbnQtbG9vcC5qc1wiO1xuaW1wb3J0IHR5cGUgeyBBZ2VudENvbnRleHQsIEFnZW50TG9vcENvbmZpZywgQWdlbnRUb29sLCBBZ2VudEV2ZW50LCBBZ2VudE1lc3NhZ2UgfSBmcm9tIFwiLi90eXBlcy5qc1wiO1xuaW1wb3J0IHsgQXNzaXN0YW50TWVzc2FnZUV2ZW50U3RyZWFtLCBFdmVudFN0cmVhbSB9IGZyb20gXCJAZ3NkL3BpLWFpXCI7XG5pbXBvcnQgdHlwZSB7IEFzc2lzdGFudE1lc3NhZ2UsIEFzc2lzdGFudE1lc3NhZ2VFdmVudCwgTW9kZWwgfSBmcm9tIFwiQGdzZC9waS1haVwiO1xuXG5kZXNjcmliZShcImFnZW50LWxvb3AgXHUyMDE0IHBhdXNlVHVybiBoYW5kbGluZyAoIzI4NjkpXCIsICgpID0+IHtcblx0aXQoXCJlbWl0cyB0b2tlbiBhdWRpdCBhZnRlciBjb250ZXh0IHRyYW5zZm9ybXMgd2hlbiBvcHRlZCBpblwiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3QgZmluYWxTdG9wID0gbWFrZUFzc2lzdGFudE1lc3NhZ2Uoe1xuXHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiRG9uZS5cIiB9XSxcblx0XHRcdHN0b3BSZWFzb246IFwic3RvcFwiLFxuXHRcdH0pO1xuXHRcdGNvbnN0IG9yaWdpbmFsID0gcHJvY2Vzcy5lbnYuUElfVE9LRU5fQVVESVQ7XG5cdFx0Y29uc3Qgb3JpZ2luYWxXcml0ZSA9IHByb2Nlc3Muc3RkZXJyLndyaXRlO1xuXHRcdGxldCB3cml0dGVuID0gXCJcIjtcblx0XHRwcm9jZXNzLmVudi5QSV9UT0tFTl9BVURJVCA9IFwiMVwiO1xuXHRcdHByb2Nlc3Muc3RkZXJyLndyaXRlID0gKChjaHVuazogc3RyaW5nIHwgVWludDhBcnJheSkgPT4ge1xuXHRcdFx0d3JpdHRlbiArPSBjaHVuay50b1N0cmluZygpO1xuXHRcdFx0cmV0dXJuIHRydWU7XG5cdFx0fSkgYXMgdHlwZW9mIHByb2Nlc3Muc3RkZXJyLndyaXRlO1xuXG5cdFx0dHJ5IHtcblx0XHRcdGxldCBmaWx0ZXJlZE1lc3NhZ2VzOiBBZ2VudE1lc3NhZ2VbXSB8IHVuZGVmaW5lZDtcblx0XHRcdGNvbnN0IHN0cmVhbUZuID0gKF9tb2RlbDogTW9kZWw8YW55PiwgbGxtQ29udGV4dDogYW55KTogQXNzaXN0YW50TWVzc2FnZUV2ZW50U3RyZWFtID0+IHtcblx0XHRcdFx0YXNzZXJ0LmVxdWFsKGxsbUNvbnRleHQubWVzc2FnZXMubGVuZ3RoLCAxLCBcImF1ZGl0IGJvdW5kYXJ5IG11c3QgdXNlIHRyYW5zZm9ybWVkIGNvbnRleHRcIik7XG5cdFx0XHRcdGFzc2VydC5lcXVhbChsbG1Db250ZXh0Lm1lc3NhZ2VzWzBdLmNvbnRlbnRbMF0udGV4dCwgXCJ0cmFuc2Zvcm1lZFwiKTtcblx0XHRcdFx0Y29uc3Qgc3RyZWFtID0gbmV3IEFzc2lzdGFudE1lc3NhZ2VFdmVudFN0cmVhbSgpO1xuXHRcdFx0XHRxdWV1ZU1pY3JvdGFzaygoKSA9PiB7XG5cdFx0XHRcdFx0c3RyZWFtLnB1c2goeyB0eXBlOiBcInN0YXJ0XCIsIHBhcnRpYWw6IGZpbmFsU3RvcCB9KTtcblx0XHRcdFx0XHRzdHJlYW0ucHVzaCh7IHR5cGU6IFwiZG9uZVwiLCBtZXNzYWdlOiBmaW5hbFN0b3AgfSk7XG5cdFx0XHRcdFx0c3RyZWFtLmVuZChmaW5hbFN0b3ApO1xuXHRcdFx0XHR9KTtcblx0XHRcdFx0cmV0dXJuIHN0cmVhbTtcblx0XHRcdH07XG5cdFx0XHRjb25zdCBjb250ZXh0OiBBZ2VudENvbnRleHQgPSB7XG5cdFx0XHRcdHN5c3RlbVByb21wdDogXCJzZW5zaXRpdmUgc3lzdGVtXCIsXG5cdFx0XHRcdG1lc3NhZ2VzOiBbeyByb2xlOiBcInVzZXJcIiwgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwib3JpZ2luYWxcIiB9XSwgdGltZXN0YW1wOiBEYXRlLm5vdygpIH1dLFxuXHRcdFx0XHR0b29sczogW10sXG5cdFx0XHR9O1xuXHRcdFx0Y29uc3QgY29uZmlnOiBBZ2VudExvb3BDb25maWcgPSB7XG5cdFx0XHRcdG1vZGVsOiBURVNUX01PREVMLFxuXHRcdFx0XHR0cmFuc2Zvcm1Db250ZXh0OiBhc3luYyAoKSA9PiBbXG5cdFx0XHRcdFx0eyByb2xlOiBcInVzZXJcIiwgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwidHJhbnNmb3JtZWRcIiB9XSwgdGltZXN0YW1wOiBEYXRlLm5vdygpIH0sXG5cdFx0XHRcdF0sXG5cdFx0XHRcdGNvbnZlcnRUb0xsbTogKG1zZ3MpID0+IG1zZ3MuZmlsdGVyKChtKTogbSBpcyBhbnkgPT4gbS5yb2xlICE9PSBcImN1c3RvbVwiKSxcblx0XHRcdFx0ZmlsdGVyVG9vbHM6ICh0b29scywgX3NpZ25hbCwgbWVzc2FnZXMpID0+IHtcblx0XHRcdFx0XHRmaWx0ZXJlZE1lc3NhZ2VzID0gbWVzc2FnZXM7XG5cdFx0XHRcdFx0cmV0dXJuIHRvb2xzO1xuXHRcdFx0XHR9LFxuXHRcdFx0XHR0b29sRXhlY3V0aW9uOiBcInNlcXVlbnRpYWxcIixcblx0XHRcdH07XG5cblx0XHRcdGNvbnN0IHN0cmVhbSA9IGFnZW50TG9vcChcblx0XHRcdFx0W3sgcm9sZTogXCJ1c2VyXCIsIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIm5ldyBwcm9tcHRcIiB9XSwgdGltZXN0YW1wOiBEYXRlLm5vdygpIH1dLFxuXHRcdFx0XHRjb250ZXh0LFxuXHRcdFx0XHRjb25maWcsXG5cdFx0XHRcdHVuZGVmaW5lZCxcblx0XHRcdFx0c3RyZWFtRm4gYXMgYW55LFxuXHRcdFx0KTtcblx0XHRcdGF3YWl0IGNvbGxlY3RFdmVudHMoc3RyZWFtKTtcblxuXHRcdFx0YXNzZXJ0Lm1hdGNoKHdyaXR0ZW4sIC9cInR5cGVcIjpcInRva2VuX2F1ZGl0XCIvKTtcblx0XHRcdGFzc2VydC5tYXRjaCh3cml0dGVuLCAvXCJtZXNzYWdlQ291bnRcIjoxLyk7XG5cdFx0XHRhc3NlcnQuZXF1YWwoKGZpbHRlcmVkTWVzc2FnZXM/LlswXSBhcyBhbnkpPy5jb250ZW50Py5bMF0/LnRleHQsIFwidHJhbnNmb3JtZWRcIik7XG5cdFx0XHRhc3NlcnQuZG9lc05vdE1hdGNoKHdyaXR0ZW4sIC90cmFuc2Zvcm1lZHxvcmlnaW5hbHxuZXcgcHJvbXB0fHNlbnNpdGl2ZSBzeXN0ZW0vKTtcblx0XHR9IGZpbmFsbHkge1xuXHRcdFx0cHJvY2Vzcy5zdGRlcnIud3JpdGUgPSBvcmlnaW5hbFdyaXRlO1xuXHRcdFx0aWYgKG9yaWdpbmFsID09PSB1bmRlZmluZWQpIGRlbGV0ZSBwcm9jZXNzLmVudi5QSV9UT0tFTl9BVURJVDtcblx0XHRcdGVsc2UgcHJvY2Vzcy5lbnYuUElfVE9LRU5fQVVESVQgPSBvcmlnaW5hbDtcblx0XHR9XG5cdH0pO1xuXG5cdGl0KFwiYXBwbGllcyBmaW5hbCB0b29sIGZpbHRlcmluZyBiZWZvcmUgdG9rZW4gYXVkaXQgYW5kIHByb3ZpZGVyIHN0cmVhbWluZ1wiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3QgZmluYWxTdG9wID0gbWFrZUFzc2lzdGFudE1lc3NhZ2Uoe1xuXHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiRG9uZS5cIiB9XSxcblx0XHRcdHN0b3BSZWFzb246IFwic3RvcFwiLFxuXHRcdH0pO1xuXHRcdGNvbnN0IG9yaWdpbmFsID0gcHJvY2Vzcy5lbnYuUElfVE9LRU5fQVVESVQ7XG5cdFx0Y29uc3Qgb3JpZ2luYWxXcml0ZSA9IHByb2Nlc3Muc3RkZXJyLndyaXRlO1xuXHRcdGxldCB3cml0dGVuID0gXCJcIjtcblx0XHRwcm9jZXNzLmVudi5QSV9UT0tFTl9BVURJVCA9IFwiMVwiO1xuXHRcdHByb2Nlc3Muc3RkZXJyLndyaXRlID0gKChjaHVuazogc3RyaW5nIHwgVWludDhBcnJheSkgPT4ge1xuXHRcdFx0d3JpdHRlbiArPSBjaHVuay50b1N0cmluZygpO1xuXHRcdFx0cmV0dXJuIHRydWU7XG5cdFx0fSkgYXMgdHlwZW9mIHByb2Nlc3Muc3RkZXJyLndyaXRlO1xuXG5cdFx0dHJ5IHtcblx0XHRcdGNvbnN0IHN0cmVhbUZuID0gKF9tb2RlbDogTW9kZWw8YW55PiwgbGxtQ29udGV4dDogYW55KTogQXNzaXN0YW50TWVzc2FnZUV2ZW50U3RyZWFtID0+IHtcblx0XHRcdFx0YXNzZXJ0LmRlZXBFcXVhbChsbG1Db250ZXh0LnRvb2xzPy5tYXAoKHRvb2w6IEFnZW50VG9vbCkgPT4gdG9vbC5uYW1lKSwgW1wid3JpdGVfZmlsZVwiXSk7XG5cdFx0XHRcdGNvbnN0IHN0cmVhbSA9IG5ldyBBc3Npc3RhbnRNZXNzYWdlRXZlbnRTdHJlYW0oKTtcblx0XHRcdFx0cXVldWVNaWNyb3Rhc2soKCkgPT4ge1xuXHRcdFx0XHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJzdGFydFwiLCBwYXJ0aWFsOiBmaW5hbFN0b3AgfSk7XG5cdFx0XHRcdFx0c3RyZWFtLnB1c2goeyB0eXBlOiBcImRvbmVcIiwgbWVzc2FnZTogZmluYWxTdG9wIH0pO1xuXHRcdFx0XHRcdHN0cmVhbS5lbmQoZmluYWxTdG9wKTtcblx0XHRcdFx0fSk7XG5cdFx0XHRcdHJldHVybiBzdHJlYW07XG5cdFx0XHR9O1xuXHRcdFx0Y29uc3QgY29udGV4dDogQWdlbnRDb250ZXh0ID0ge1xuXHRcdFx0XHRzeXN0ZW1Qcm9tcHQ6IFwiWW91IGFyZSBhIHRlc3QgYWdlbnQuXCIsXG5cdFx0XHRcdG1lc3NhZ2VzOiBbeyByb2xlOiBcInVzZXJcIiwgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiVXNlIGEgdG9vbFwiIH1dLCB0aW1lc3RhbXA6IERhdGUubm93KCkgfV0sXG5cdFx0XHRcdHRvb2xzOiBbXG5cdFx0XHRcdFx0bWFrZVRvb2xXaXRoU2NoZW1hKCksXG5cdFx0XHRcdFx0e1xuXHRcdFx0XHRcdFx0Li4ubWFrZVRvb2xXaXRoU2NoZW1hKCksXG5cdFx0XHRcdFx0XHRuYW1lOiBcImRyb3BfdG9vbFwiLFxuXHRcdFx0XHRcdFx0bGFiZWw6IFwiRHJvcCBUb29sXCIsXG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0XSxcblx0XHRcdH07XG5cdFx0XHRjb25zdCBjb25maWc6IEFnZW50TG9vcENvbmZpZyA9IHtcblx0XHRcdFx0bW9kZWw6IFRFU1RfTU9ERUwsXG5cdFx0XHRcdGNvbnZlcnRUb0xsbTogKG1zZ3MpID0+IG1zZ3MuZmlsdGVyKChtKTogbSBpcyBhbnkgPT4gbS5yb2xlICE9PSBcImN1c3RvbVwiKSxcblx0XHRcdFx0ZmlsdGVyVG9vbHM6IGFzeW5jICh0b29scykgPT4gdG9vbHMuZmlsdGVyKCh0b29sKSA9PiB0b29sLm5hbWUgPT09IFwid3JpdGVfZmlsZVwiKSxcblx0XHRcdFx0dG9vbEV4ZWN1dGlvbjogXCJzZXF1ZW50aWFsXCIsXG5cdFx0XHR9O1xuXG5cdFx0XHRjb25zdCBzdHJlYW0gPSBhZ2VudExvb3AoXG5cdFx0XHRcdFt7IHJvbGU6IFwidXNlclwiLCBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJVc2UgYSB0b29sXCIgfV0sIHRpbWVzdGFtcDogRGF0ZS5ub3coKSB9XSxcblx0XHRcdFx0Y29udGV4dCxcblx0XHRcdFx0Y29uZmlnLFxuXHRcdFx0XHR1bmRlZmluZWQsXG5cdFx0XHRcdHN0cmVhbUZuIGFzIGFueSxcblx0XHRcdCk7XG5cdFx0XHRhd2FpdCBjb2xsZWN0RXZlbnRzKHN0cmVhbSk7XG5cblx0XHRcdGFzc2VydC5tYXRjaCh3cml0dGVuLCAvXCJ0b29sQ291bnRcIjoxLyk7XG5cdFx0XHRhc3NlcnQubWF0Y2god3JpdHRlbiwgL1wibmFtZVwiOlwid3JpdGVfZmlsZVwiLyk7XG5cdFx0XHRhc3NlcnQuZG9lc05vdE1hdGNoKHdyaXR0ZW4sIC9kcm9wX3Rvb2wvKTtcblx0XHR9IGZpbmFsbHkge1xuXHRcdFx0cHJvY2Vzcy5zdGRlcnIud3JpdGUgPSBvcmlnaW5hbFdyaXRlO1xuXHRcdFx0aWYgKG9yaWdpbmFsID09PSB1bmRlZmluZWQpIGRlbGV0ZSBwcm9jZXNzLmVudi5QSV9UT0tFTl9BVURJVDtcblx0XHRcdGVsc2UgcHJvY2Vzcy5lbnYuUElfVE9LRU5fQVVESVQgPSBvcmlnaW5hbDtcblx0XHR9XG5cdH0pO1xuXG5cdGl0KFwiY29udGludWVzIHRvIGEgc2Vjb25kIGFzc2lzdGFudCB0dXJuIHdoZW4gc3RvcFJlYXNvbiBpcyBwYXVzZVR1cm5cIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IHBhdXNlVHVybiA9IG1ha2VBc3Npc3RhbnRNZXNzYWdlKHtcblx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIlN0aWxsIHdvcmtpbmcuLi5cIiB9XSxcblx0XHRcdHN0b3BSZWFzb246IFwicGF1c2VUdXJuXCIsXG5cdFx0fSk7XG5cdFx0Y29uc3QgZmluYWxTdG9wID0gbWFrZUFzc2lzdGFudE1lc3NhZ2Uoe1xuXHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiRG9uZS5cIiB9XSxcblx0XHRcdHN0b3BSZWFzb246IFwic3RvcFwiLFxuXHRcdH0pO1xuXG5cdFx0bGV0IHN0cmVhbUNhbGxDb3VudCA9IDA7XG5cdFx0Y29uc3Qgc2Vlbkxhc3RSb2xlczogc3RyaW5nW10gPSBbXTtcblx0XHRjb25zdCBzdHJlYW1GbiA9IChfbW9kZWw6IE1vZGVsPGFueT4sIGxsbUNvbnRleHQ6IGFueSk6IEFzc2lzdGFudE1lc3NhZ2VFdmVudFN0cmVhbSA9PiB7XG5cdFx0XHRzdHJlYW1DYWxsQ291bnQrKztcblx0XHRcdHNlZW5MYXN0Um9sZXMucHVzaChsbG1Db250ZXh0Lm1lc3NhZ2VzLmF0KC0xKT8ucm9sZSA/PyBcIm5vbmVcIik7XG5cdFx0XHRjb25zdCBtZXNzYWdlID0gc3RyZWFtQ2FsbENvdW50ID09PSAxID8gcGF1c2VUdXJuIDogZmluYWxTdG9wO1xuXHRcdFx0Y29uc3Qgc3RyZWFtID0gbmV3IEFzc2lzdGFudE1lc3NhZ2VFdmVudFN0cmVhbSgpO1xuXHRcdFx0cXVldWVNaWNyb3Rhc2soKCkgPT4ge1xuXHRcdFx0XHRzdHJlYW0ucHVzaCh7IHR5cGU6IFwic3RhcnRcIiwgcGFydGlhbDogbWVzc2FnZSB9KTtcblx0XHRcdFx0c3RyZWFtLnB1c2goeyB0eXBlOiBcImRvbmVcIiwgbWVzc2FnZSB9KTtcblx0XHRcdFx0c3RyZWFtLmVuZChtZXNzYWdlKTtcblx0XHRcdH0pO1xuXHRcdFx0cmV0dXJuIHN0cmVhbTtcblx0XHR9O1xuXG5cdFx0Y29uc3QgY29udGV4dDogQWdlbnRDb250ZXh0ID0ge1xuXHRcdFx0c3lzdGVtUHJvbXB0OiBcIllvdSBhcmUgYSB0ZXN0IGFnZW50LlwiLFxuXHRcdFx0bWVzc2FnZXM6IFt7IHJvbGU6IFwidXNlclwiLCBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJLZWVwIGdvaW5nXCIgfV0sIHRpbWVzdGFtcDogRGF0ZS5ub3coKSB9XSxcblx0XHRcdHRvb2xzOiBbXSxcblx0XHR9O1xuXG5cdFx0Y29uc3QgY29uZmlnOiBBZ2VudExvb3BDb25maWcgPSB7XG5cdFx0XHRtb2RlbDogVEVTVF9NT0RFTCxcblx0XHRcdGNvbnZlcnRUb0xsbTogKG1zZ3MpID0+IG1zZ3MuZmlsdGVyKChtKTogbSBpcyBhbnkgPT4gbS5yb2xlICE9PSBcImN1c3RvbVwiKSxcblx0XHRcdHRvb2xFeGVjdXRpb246IFwic2VxdWVudGlhbFwiLFxuXHRcdH07XG5cblx0XHRjb25zdCBzdHJlYW0gPSBhZ2VudExvb3AoXG5cdFx0XHRbeyByb2xlOiBcInVzZXJcIiwgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiS2VlcCBnb2luZ1wiIH1dLCB0aW1lc3RhbXA6IERhdGUubm93KCkgfV0sXG5cdFx0XHRjb250ZXh0LFxuXHRcdFx0Y29uZmlnLFxuXHRcdFx0dW5kZWZpbmVkLFxuXHRcdFx0c3RyZWFtRm4gYXMgYW55LFxuXHRcdCk7XG5cblx0XHRjb25zdCBldmVudHMgPSBhd2FpdCBjb2xsZWN0RXZlbnRzKHN0cmVhbSk7XG5cdFx0Y29uc3QgYXNzaXN0YW50TWVzc2FnZXMgPSBldmVudHMuZmlsdGVyKFxuXHRcdFx0KGV2ZW50KTogZXZlbnQgaXMgRXh0cmFjdDxBZ2VudEV2ZW50LCB7IHR5cGU6IFwibWVzc2FnZV9lbmRcIiB9PiA9PlxuXHRcdFx0XHRldmVudC50eXBlID09PSBcIm1lc3NhZ2VfZW5kXCIgJiYgZXZlbnQubWVzc2FnZS5yb2xlID09PSBcImFzc2lzdGFudFwiLFxuXHRcdCk7XG5cdFx0Y29uc3QgdHVyblN0YXJ0cyA9IGV2ZW50cy5maWx0ZXIoKGV2ZW50KSA9PiBldmVudC50eXBlID09PSBcInR1cm5fc3RhcnRcIik7XG5cblx0XHRhc3NlcnQuZXF1YWwoc3RyZWFtQ2FsbENvdW50LCAyLCBcInBhdXNlVHVybiBtdXN0IGNhdXNlIGEgc2Vjb25kIHByb3ZpZGVyIGNhbGxcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKGFzc2lzdGFudE1lc3NhZ2VzLmxlbmd0aCwgMiwgXCJleHBlY3RlZCB0d28gYXNzaXN0YW50IHR1cm5zXCIpO1xuXHRcdGFzc2VydC5lcXVhbChhc3Npc3RhbnRNZXNzYWdlc1swXS5tZXNzYWdlLnN0b3BSZWFzb24sIFwicGF1c2VUdXJuXCIpO1xuXHRcdGFzc2VydC5lcXVhbChhc3Npc3RhbnRNZXNzYWdlc1sxXS5tZXNzYWdlLnN0b3BSZWFzb24sIFwic3RvcFwiKTtcblx0XHRhc3NlcnQuZXF1YWwodHVyblN0YXJ0cy5sZW5ndGgsIDIsIFwiZXhwZWN0ZWQgYSBzZWNvbmQgdHVybl9zdGFydCBhZnRlciBwYXVzZVR1cm5cIik7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChzZWVuTGFzdFJvbGVzLCBbXCJ1c2VyXCIsIFwiYXNzaXN0YW50XCJdLCBcInNlY29uZCB0dXJuIG11c3QgY29udGludWUgZnJvbSB0aGUgcGF1c2VkIGFzc2lzdGFudCBzdGF0ZVwiKTtcblx0fSk7XG5cblx0Ly8gVGhlIGJlaGF2aW91cmFsIHRlc3QgYWJvdmUgKFwiY29udGludWVzIHRvIGEgc2Vjb25kIGFzc2lzdGFudCB0dXJuIFx1MjAyNlwiKVxuXHQvLyBhbHJlYWR5IGV4ZXJjaXNlcyBgc3RvcFJlYXNvbjogXCJwYXVzZVR1cm5cImAgYXQgdGhlIHR5cGUgbGV2ZWwgKFRTIHdvbid0XG5cdC8vIGNvbXBpbGUgd2l0aG91dCB0aGUgdW5pb24gbWVtYmVyKSBhbmQgYXQgcnVudGltZSAodGhlIHN0cmVhbSBlbWl0cyBpdFxuXHQvLyBhbmQgdGhlIGxvb3AgYWN0cyBvbiBpdCkuIEEgc2VwYXJhdGUgc291cmNlLXRleHQgZ3JlcCBhZGRlZCBub3RoaW5nLlxuXHQvLyBEZWxldGVkIHBlciAjNDc5Ny5cblxuXHRpdChcInVzZXMgcHJvdmlkZXItc3VwcGxpZWQgZXh0ZXJuYWwgdG9vbCByZXN1bHRzIGluc3RlYWQgb2YgdGhlIHBsYWNlaG9sZGVyXCIsIGFzeW5jICgpID0+IHtcblx0XHRjb25zdCBleHRlcm5hbE1lc3NhZ2UgPSBtYWtlQXNzaXN0YW50TWVzc2FnZSh7XG5cdFx0XHRjb250ZW50OiBbXG5cdFx0XHRcdHtcblx0XHRcdFx0XHR0eXBlOiBcInRvb2xDYWxsXCIsXG5cdFx0XHRcdFx0aWQ6IFwidGMtZXh0ZXJuYWwtMVwiLFxuXHRcdFx0XHRcdG5hbWU6IFwiYmFzaFwiLFxuXHRcdFx0XHRcdGFyZ3VtZW50czogeyBjb21tYW5kOiBcImVjaG8gaGlcIiB9LFxuXHRcdFx0XHRcdGV4dGVybmFsUmVzdWx0OiB7XG5cdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJoaVxcblwiIH1dLFxuXHRcdFx0XHRcdFx0ZGV0YWlsczogeyBzb3VyY2U6IFwiY2xhdWRlLWNvZGVcIiB9LFxuXHRcdFx0XHRcdFx0aXNFcnJvcjogZmFsc2UsXG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0fSBhcyBhbnksXG5cdFx0XHRdLFxuXHRcdFx0c3RvcFJlYXNvbjogXCJ0b29sVXNlXCIsXG5cdFx0XHRwcm92aWRlcjogXCJjbGF1ZGUtY29kZVwiLFxuXHRcdH0pO1xuXG5cdFx0Y29uc3QgbW9ja1N0cmVhbSA9IGNyZWF0ZU1vY2tTdHJlYW1GbihbZXh0ZXJuYWxNZXNzYWdlXSk7XG5cblx0XHRjb25zdCBjb250ZXh0OiBBZ2VudENvbnRleHQgPSB7XG5cdFx0XHRzeXN0ZW1Qcm9tcHQ6IFwiWW91IGFyZSBhIHRlc3QgYWdlbnQuXCIsXG5cdFx0XHRtZXNzYWdlczogW3sgcm9sZTogXCJ1c2VyXCIsIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIlJ1biB0aGUgY29tbWFuZFwiIH1dLCB0aW1lc3RhbXA6IERhdGUubm93KCkgfV0sXG5cdFx0XHR0b29sczogW10sXG5cdFx0fTtcblxuXHRcdGNvbnN0IGNvbmZpZzogQWdlbnRMb29wQ29uZmlnID0ge1xuXHRcdFx0bW9kZWw6IHsgLi4uVEVTVF9NT0RFTCwgcHJvdmlkZXI6IFwiY2xhdWRlLWNvZGVcIiB9LFxuXHRcdFx0Y29udmVydFRvTGxtOiAobXNncykgPT4gbXNncy5maWx0ZXIoKG0pOiBtIGlzIGFueSA9PiBtLnJvbGUgIT09IFwiY3VzdG9tXCIpLFxuXHRcdFx0dG9vbEV4ZWN1dGlvbjogXCJzZXF1ZW50aWFsXCIsXG5cdFx0XHRleHRlcm5hbFRvb2xFeGVjdXRpb246IHRydWUsXG5cdFx0fTtcblxuXHRcdGNvbnN0IHN0cmVhbSA9IGFnZW50TG9vcChcblx0XHRcdFt7IHJvbGU6IFwidXNlclwiLCBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJSdW4gdGhlIGNvbW1hbmRcIiB9XSwgdGltZXN0YW1wOiBEYXRlLm5vdygpIH1dLFxuXHRcdFx0Y29udGV4dCxcblx0XHRcdGNvbmZpZyxcblx0XHRcdHVuZGVmaW5lZCxcblx0XHRcdG1vY2tTdHJlYW0gYXMgYW55LFxuXHRcdCk7XG5cblx0XHRjb25zdCBldmVudHMgPSBhd2FpdCBjb2xsZWN0RXZlbnRzKHN0cmVhbSk7XG5cdFx0Y29uc3QgdG9vbEVuZCA9IGV2ZW50cy5maW5kKFxuXHRcdFx0KGV2ZW50KTogZXZlbnQgaXMgRXh0cmFjdDxBZ2VudEV2ZW50LCB7IHR5cGU6IFwidG9vbF9leGVjdXRpb25fZW5kXCIgfT4gPT4gZXZlbnQudHlwZSA9PT0gXCJ0b29sX2V4ZWN1dGlvbl9lbmRcIixcblx0XHQpO1xuXG5cdFx0YXNzZXJ0Lm9rKHRvb2xFbmQsIFwiZXhwZWN0ZWQgdG9vbF9leGVjdXRpb25fZW5kIGV2ZW50XCIpO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwodG9vbEVuZC5yZXN1bHQuY29udGVudCwgW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiaGlcXG5cIiB9XSk7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbCh0b29sRW5kLnJlc3VsdC5kZXRhaWxzLCB7IHNvdXJjZTogXCJjbGF1ZGUtY29kZVwiIH0pO1xuXHRcdGFzc2VydC5lcXVhbCh0b29sRW5kLmlzRXJyb3IsIGZhbHNlKTtcblx0fSk7XG5cblx0aXQoXCJpbmplY3RzIHF1ZXVlZCBzdGVlcmluZyBtZXNzYWdlcyBiZWZvcmUgdGhlIG5leHQgYXNzaXN0YW50IHR1cm4gYW5kIHNraXBzIHJlbWFpbmluZyB0b29sc1wiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3QgdG9vbCA9IG1ha2VUb29sV2l0aFNjaGVtYSgpO1xuXHRcdGNvbnN0IHN0ZWVyaW5nTWVzc2FnZTogQWdlbnRNZXNzYWdlID0ge1xuXHRcdFx0cm9sZTogXCJ1c2VyXCIsXG5cdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJTdG9wIGFmdGVyIHRoZSBmaXJzdCB0b29sLlwiIH1dLFxuXHRcdFx0dGltZXN0YW1wOiBEYXRlLm5vdygpLFxuXHRcdH07XG5cdFx0Y29uc3QgdG9vbFR1cm4gPSBtYWtlQXNzaXN0YW50TWVzc2FnZSh7XG5cdFx0XHRjb250ZW50OiBbXG5cdFx0XHRcdHtcblx0XHRcdFx0XHR0eXBlOiBcInRvb2xDYWxsXCIsXG5cdFx0XHRcdFx0aWQ6IFwid3JpdGUtMVwiLFxuXHRcdFx0XHRcdG5hbWU6IFwid3JpdGVfZmlsZVwiLFxuXHRcdFx0XHRcdGFyZ3VtZW50czogeyBwYXRoOiBcIi90bXAvb25lXCIsIGNvbnRlbnQ6IFwiZmlyc3RcIiB9LFxuXHRcdFx0XHR9LFxuXHRcdFx0XHR7XG5cdFx0XHRcdFx0dHlwZTogXCJ0b29sQ2FsbFwiLFxuXHRcdFx0XHRcdGlkOiBcIndyaXRlLTJcIixcblx0XHRcdFx0XHRuYW1lOiBcIndyaXRlX2ZpbGVcIixcblx0XHRcdFx0XHRhcmd1bWVudHM6IHsgcGF0aDogXCIvdG1wL3R3b1wiLCBjb250ZW50OiBcInNlY29uZFwiIH0sXG5cdFx0XHRcdH0sXG5cdFx0XHRdLFxuXHRcdFx0c3RvcFJlYXNvbjogXCJ0b29sVXNlXCIsXG5cdFx0fSk7XG5cdFx0Y29uc3QgZmluYWxTdG9wID0gbWFrZUFzc2lzdGFudE1lc3NhZ2Uoe1xuXHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiU3RvcHBlZCBhZnRlciB0aGUgZmlyc3QgdG9vbC5cIiB9XSxcblx0XHRcdHN0b3BSZWFzb246IFwic3RvcFwiLFxuXHRcdH0pO1xuXG5cdFx0bGV0IHN0ZWVyaW5nUG9sbENvdW50ID0gMDtcblx0XHRjb25zdCBzZWVuTGFzdE1lc3NhZ2VzOiB1bmtub3duW10gPSBbXTtcblx0XHRjb25zdCBzdHJlYW1GbiA9IChfbW9kZWw6IE1vZGVsPGFueT4sIGxsbUNvbnRleHQ6IGFueSk6IEFzc2lzdGFudE1lc3NhZ2VFdmVudFN0cmVhbSA9PiB7XG5cdFx0XHRzZWVuTGFzdE1lc3NhZ2VzLnB1c2gobGxtQ29udGV4dC5tZXNzYWdlcy5hdCgtMSkpO1xuXHRcdFx0Y29uc3QgbWVzc2FnZSA9IHNlZW5MYXN0TWVzc2FnZXMubGVuZ3RoID09PSAxID8gdG9vbFR1cm4gOiBmaW5hbFN0b3A7XG5cdFx0XHRjb25zdCBzdHJlYW0gPSBuZXcgQXNzaXN0YW50TWVzc2FnZUV2ZW50U3RyZWFtKCk7XG5cdFx0XHRxdWV1ZU1pY3JvdGFzaygoKSA9PiB7XG5cdFx0XHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJzdGFydFwiLCBwYXJ0aWFsOiBtZXNzYWdlIH0pO1xuXHRcdFx0XHRzdHJlYW0ucHVzaCh7IHR5cGU6IFwiZG9uZVwiLCBtZXNzYWdlIH0pO1xuXHRcdFx0XHRzdHJlYW0uZW5kKG1lc3NhZ2UpO1xuXHRcdFx0fSk7XG5cdFx0XHRyZXR1cm4gc3RyZWFtO1xuXHRcdH07XG5cblx0XHRjb25zdCBjb250ZXh0OiBBZ2VudENvbnRleHQgPSB7XG5cdFx0XHRzeXN0ZW1Qcm9tcHQ6IFwiWW91IGFyZSBhIHRlc3QgYWdlbnQuXCIsXG5cdFx0XHRtZXNzYWdlczogW3sgcm9sZTogXCJ1c2VyXCIsIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIldyaXRlIGJvdGggZmlsZXNcIiB9XSwgdGltZXN0YW1wOiBEYXRlLm5vdygpIH1dLFxuXHRcdFx0dG9vbHM6IFt0b29sXSxcblx0XHR9O1xuXG5cdFx0Y29uc3QgY29uZmlnOiBBZ2VudExvb3BDb25maWcgPSB7XG5cdFx0XHRtb2RlbDogVEVTVF9NT0RFTCxcblx0XHRcdGNvbnZlcnRUb0xsbTogKG1zZ3MpID0+IG1zZ3MuZmlsdGVyKChtKTogbSBpcyBhbnkgPT4gbS5yb2xlICE9PSBcImN1c3RvbVwiKSxcblx0XHRcdHRvb2xFeGVjdXRpb246IFwic2VxdWVudGlhbFwiLFxuXHRcdFx0Z2V0U3RlZXJpbmdNZXNzYWdlczogYXN5bmMgKCkgPT4ge1xuXHRcdFx0XHRzdGVlcmluZ1BvbGxDb3VudCsrO1xuXHRcdFx0XHRyZXR1cm4gc3RlZXJpbmdQb2xsQ291bnQgPT09IDIgPyBbc3RlZXJpbmdNZXNzYWdlXSA6IFtdO1xuXHRcdFx0fSxcblx0XHR9O1xuXG5cdFx0Y29uc3Qgc3RyZWFtID0gYWdlbnRMb29wKFxuXHRcdFx0W3sgcm9sZTogXCJ1c2VyXCIsIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIldyaXRlIGJvdGggZmlsZXNcIiB9XSwgdGltZXN0YW1wOiBEYXRlLm5vdygpIH1dLFxuXHRcdFx0Y29udGV4dCxcblx0XHRcdGNvbmZpZyxcblx0XHRcdHVuZGVmaW5lZCxcblx0XHRcdHN0cmVhbUZuIGFzIGFueSxcblx0XHQpO1xuXG5cdFx0Y29uc3QgZXZlbnRzID0gYXdhaXQgY29sbGVjdEV2ZW50cyhzdHJlYW0pO1xuXHRcdGNvbnN0IHRvb2xFbmRzID0gZXZlbnRzLmZpbHRlcihcblx0XHRcdChldmVudCk6IGV2ZW50IGlzIEV4dHJhY3Q8QWdlbnRFdmVudCwgeyB0eXBlOiBcInRvb2xfZXhlY3V0aW9uX2VuZFwiIH0+ID0+IGV2ZW50LnR5cGUgPT09IFwidG9vbF9leGVjdXRpb25fZW5kXCIsXG5cdFx0KTtcblx0XHRjb25zdCBzdGVlcmluZ0VuZCA9IGV2ZW50cy5maW5kKFxuXHRcdFx0KGV2ZW50KTogZXZlbnQgaXMgRXh0cmFjdDxBZ2VudEV2ZW50LCB7IHR5cGU6IFwibWVzc2FnZV9lbmRcIiB9PiA9PlxuXHRcdFx0XHRldmVudC50eXBlID09PSBcIm1lc3NhZ2VfZW5kXCIgJiZcblx0XHRcdFx0ZXZlbnQubWVzc2FnZS5yb2xlID09PSBcInVzZXJcIiAmJlxuXHRcdFx0XHQoZXZlbnQubWVzc2FnZS5jb250ZW50WzBdIGFzIGFueSk/LnRleHQgPT09IFwiU3RvcCBhZnRlciB0aGUgZmlyc3QgdG9vbC5cIixcblx0XHQpO1xuXG5cdFx0YXNzZXJ0LmVxdWFsKHRvb2xFbmRzLmxlbmd0aCwgMiwgXCJleHBlY3RlZCBvbmUgZXhlY3V0ZWQgdG9vbCBhbmQgb25lIHNraXBwZWQgdG9vbFwiKTtcblx0XHRhc3NlcnQub2soXG5cdFx0XHR0b29sRW5kcy5zb21lKChldmVudCkgPT4gSlNPTi5zdHJpbmdpZnkoZXZlbnQucmVzdWx0LmNvbnRlbnQpID09PSBKU09OLnN0cmluZ2lmeShbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJkb25lXCIgfV0pKSxcblx0XHRcdFwiZXhwZWN0ZWQgb25lIGNvbXBsZXRlZCB0b29sIHJlc3VsdFwiLFxuXHRcdCk7XG5cdFx0YXNzZXJ0Lm9rKFxuXHRcdFx0dG9vbEVuZHMuc29tZShcblx0XHRcdFx0KGV2ZW50KSA9PlxuXHRcdFx0XHRcdEpTT04uc3RyaW5naWZ5KGV2ZW50LnJlc3VsdC5jb250ZW50KSA9PT1cblx0XHRcdFx0XHRKU09OLnN0cmluZ2lmeShbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJTa2lwcGVkIGR1ZSB0byBxdWV1ZWQgdXNlciBtZXNzYWdlLlwiIH1dKSxcblx0XHRcdCksXG5cdFx0XHRcImV4cGVjdGVkIG9uZSBza2lwcGVkIHRvb2wgcmVzdWx0IGFmdGVyIHN0ZWVyaW5nIGludGVycnVwdGlvblwiLFxuXHRcdCk7XG5cdFx0YXNzZXJ0Lm9rKHN0ZWVyaW5nRW5kLCBcInF1ZXVlZCBzdGVlcmluZyBtZXNzYWdlIHNob3VsZCBiZSBlbWl0dGVkIGJlZm9yZSB0aGUgbmV4dCBhc3Npc3RhbnQgdHVyblwiKTtcblx0XHRhc3NlcnQuZXF1YWwoKHNlZW5MYXN0TWVzc2FnZXNbMV0gYXMgYW55KT8uY29udGVudD8uWzBdPy50ZXh0LCBcIlN0b3AgYWZ0ZXIgdGhlIGZpcnN0IHRvb2wuXCIpO1xuXHR9KTtcblxuXHRpdChcInJlc3RhcnRzIHRoZSBvdXRlciBsb29wIHdoZW4gZm9sbG93LXVwIG1lc3NhZ2VzIGFycml2ZSBhZnRlciBhIHN0b3BcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IGluaXRpYWxTdG9wID0gbWFrZUFzc2lzdGFudE1lc3NhZ2Uoe1xuXHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiRmlyc3QgYW5zd2VyLlwiIH1dLFxuXHRcdFx0c3RvcFJlYXNvbjogXCJzdG9wXCIsXG5cdFx0fSk7XG5cdFx0Y29uc3QgZm9sbG93VXBTdG9wID0gbWFrZUFzc2lzdGFudE1lc3NhZ2Uoe1xuXHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiRm9sbG93LXVwIGFuc3dlci5cIiB9XSxcblx0XHRcdHN0b3BSZWFzb246IFwic3RvcFwiLFxuXHRcdH0pO1xuXHRcdGNvbnN0IGZvbGxvd1VwTWVzc2FnZTogQWdlbnRNZXNzYWdlID0ge1xuXHRcdFx0cm9sZTogXCJ1c2VyXCIsXG5cdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJPbmUgbW9yZSB0aGluZy5cIiB9XSxcblx0XHRcdHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcblx0XHR9O1xuXG5cdFx0bGV0IGZvbGxvd1VwUG9sbENvdW50ID0gMDtcblx0XHRjb25zdCBzZWVuTGFzdE1lc3NhZ2VzOiB1bmtub3duW10gPSBbXTtcblx0XHRjb25zdCBzdHJlYW1GbiA9IChfbW9kZWw6IE1vZGVsPGFueT4sIGxsbUNvbnRleHQ6IGFueSk6IEFzc2lzdGFudE1lc3NhZ2VFdmVudFN0cmVhbSA9PiB7XG5cdFx0XHRzZWVuTGFzdE1lc3NhZ2VzLnB1c2gobGxtQ29udGV4dC5tZXNzYWdlcy5hdCgtMSkpO1xuXHRcdFx0Y29uc3QgbWVzc2FnZSA9IHNlZW5MYXN0TWVzc2FnZXMubGVuZ3RoID09PSAxID8gaW5pdGlhbFN0b3AgOiBmb2xsb3dVcFN0b3A7XG5cdFx0XHRjb25zdCBzdHJlYW0gPSBuZXcgQXNzaXN0YW50TWVzc2FnZUV2ZW50U3RyZWFtKCk7XG5cdFx0XHRxdWV1ZU1pY3JvdGFzaygoKSA9PiB7XG5cdFx0XHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJzdGFydFwiLCBwYXJ0aWFsOiBtZXNzYWdlIH0pO1xuXHRcdFx0XHRzdHJlYW0ucHVzaCh7IHR5cGU6IFwiZG9uZVwiLCBtZXNzYWdlIH0pO1xuXHRcdFx0XHRzdHJlYW0uZW5kKG1lc3NhZ2UpO1xuXHRcdFx0fSk7XG5cdFx0XHRyZXR1cm4gc3RyZWFtO1xuXHRcdH07XG5cblx0XHRjb25zdCBjb250ZXh0OiBBZ2VudENvbnRleHQgPSB7XG5cdFx0XHRzeXN0ZW1Qcm9tcHQ6IFwiWW91IGFyZSBhIHRlc3QgYWdlbnQuXCIsXG5cdFx0XHRtZXNzYWdlczogW3sgcm9sZTogXCJ1c2VyXCIsIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkluaXRpYWwgcHJvbXB0XCIgfV0sIHRpbWVzdGFtcDogRGF0ZS5ub3coKSB9XSxcblx0XHRcdHRvb2xzOiBbXSxcblx0XHR9O1xuXG5cdFx0Y29uc3QgY29uZmlnOiBBZ2VudExvb3BDb25maWcgPSB7XG5cdFx0XHRtb2RlbDogVEVTVF9NT0RFTCxcblx0XHRcdGNvbnZlcnRUb0xsbTogKG1zZ3MpID0+IG1zZ3MuZmlsdGVyKChtKTogbSBpcyBhbnkgPT4gbS5yb2xlICE9PSBcImN1c3RvbVwiKSxcblx0XHRcdHRvb2xFeGVjdXRpb246IFwic2VxdWVudGlhbFwiLFxuXHRcdFx0Z2V0Rm9sbG93VXBNZXNzYWdlczogYXN5bmMgKCkgPT4ge1xuXHRcdFx0XHRmb2xsb3dVcFBvbGxDb3VudCsrO1xuXHRcdFx0XHRyZXR1cm4gZm9sbG93VXBQb2xsQ291bnQgPT09IDEgPyBbZm9sbG93VXBNZXNzYWdlXSA6IFtdO1xuXHRcdFx0fSxcblx0XHR9O1xuXG5cdFx0Y29uc3Qgc3RyZWFtID0gYWdlbnRMb29wKFxuXHRcdFx0W3sgcm9sZTogXCJ1c2VyXCIsIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkluaXRpYWwgcHJvbXB0XCIgfV0sIHRpbWVzdGFtcDogRGF0ZS5ub3coKSB9XSxcblx0XHRcdGNvbnRleHQsXG5cdFx0XHRjb25maWcsXG5cdFx0XHR1bmRlZmluZWQsXG5cdFx0XHRzdHJlYW1GbiBhcyBhbnksXG5cdFx0KTtcblxuXHRcdGNvbnN0IGV2ZW50cyA9IGF3YWl0IGNvbGxlY3RFdmVudHMoc3RyZWFtKTtcblx0XHRjb25zdCBhc3Npc3RhbnRFbmRzID0gZXZlbnRzLmZpbHRlcihcblx0XHRcdChldmVudCk6IGV2ZW50IGlzIEV4dHJhY3Q8QWdlbnRFdmVudCwgeyB0eXBlOiBcIm1lc3NhZ2VfZW5kXCIgfT4gPT5cblx0XHRcdFx0ZXZlbnQudHlwZSA9PT0gXCJtZXNzYWdlX2VuZFwiICYmIGV2ZW50Lm1lc3NhZ2Uucm9sZSA9PT0gXCJhc3Npc3RhbnRcIixcblx0XHQpO1xuXHRcdGNvbnN0IGZvbGxvd1VwRW5kID0gZXZlbnRzLmZpbmQoXG5cdFx0XHQoZXZlbnQpOiBldmVudCBpcyBFeHRyYWN0PEFnZW50RXZlbnQsIHsgdHlwZTogXCJtZXNzYWdlX2VuZFwiIH0+ID0+XG5cdFx0XHRcdGV2ZW50LnR5cGUgPT09IFwibWVzc2FnZV9lbmRcIiAmJlxuXHRcdFx0XHRldmVudC5tZXNzYWdlLnJvbGUgPT09IFwidXNlclwiICYmXG5cdFx0XHRcdChldmVudC5tZXNzYWdlLmNvbnRlbnRbMF0gYXMgYW55KT8udGV4dCA9PT0gXCJPbmUgbW9yZSB0aGluZy5cIixcblx0XHQpO1xuXG5cdFx0YXNzZXJ0LmVxdWFsKGFzc2lzdGFudEVuZHMubGVuZ3RoLCAyLCBcImV4cGVjdGVkIHRoZSBhZ2VudCBsb29wIHRvIHJlc3RhcnQgZm9yIHRoZSBmb2xsb3ctdXAgdHVyblwiKTtcblx0XHRhc3NlcnQub2soZm9sbG93VXBFbmQsIFwiZm9sbG93LXVwIG1lc3NhZ2Ugc2hvdWxkIGJlIGVtaXR0ZWQgYmVmb3JlIHRoZSByZXN0YXJ0ZWQgYXNzaXN0YW50IHR1cm5cIik7XG5cdFx0YXNzZXJ0LmVxdWFsKChzZWVuTGFzdE1lc3NhZ2VzWzFdIGFzIGFueSk/LmNvbnRlbnQ/LlswXT8udGV4dCwgXCJPbmUgbW9yZSB0aGluZy5cIik7XG5cdH0pO1xufSk7XG5cbi8qKlxuICogUmVncmVzc2lvbiB0ZXN0cyBmb3IgIzI3ODM6IFN0dWNrLWxvb3Agb24gZXhlY3V0ZS10YXNrIFx1MjAxNCB0b29sLWNhbGwgc2NoZW1hXG4gKiBvdmVybG9hZCBjYXVzZXMgdW5ib3VuZGVkIHJldHJ5ICsgYnVkZ2V0IGJ1cm4uXG4gKlxuICogV2hlbiB0aGUgTExNIHJlcGVhdGVkbHkgZW1pdHMgdG9vbCBjYWxscyB3aXRoIGFyZ3VtZW50cyB0aGF0IGZhaWwgc2NoZW1hXG4gKiB2YWxpZGF0aW9uLCB0aGUgYWdlbnQgbG9vcCByZXRyaWVzIGluZGVmaW5pdGVseS4gRWFjaCBmYWlsZWQgdmFsaWRhdGlvblxuICogcmV0dXJucyBhbiBlcnJvciB0b29sIHJlc3VsdCwgdGhlIExMTSByZXRyaWVzIHdpdGggdGhlIHNhbWUgYnJva2VuIGFyZ3MsXG4gKiBhbmQgdGhlIGN5Y2xlIG5ldmVyIGJyZWFrcyBcdTIwMTQgYnVybmluZyBidWRnZXQgd2l0aCBubyBwcm9ncmVzcy5cbiAqXG4gKiBUaGUgZml4IGNhcHMgY29uc2VjdXRpdmUgdmFsaWRhdGlvbiBmYWlsdXJlcyBwZXIgdHVybiBhdFxuICogTUFYX0NPTlNFQ1VUSVZFX1ZBTElEQVRJT05fRkFJTFVSRVMgKGRlZmF1bHQgMykuIE9uY2UgdGhlIGNhcCBpcyBoaXQsIHRoZVxuICogbG9vcCBpbmplY3RzIGEgc3ludGhldGljIHN0b3Agc28gdGhlIGFnZW50IHRlcm1pbmF0ZXMgY2xlYW5seSBpbnN0ZWFkIG9mXG4gKiBzcGlubmluZyBmb3JldmVyLlxuICovXG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBIZWxwZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5jb25zdCBURVNUX01PREVMOiBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPiA9IHtcblx0aWQ6IFwiY2xhdWRlLXRlc3RcIixcblx0bmFtZTogXCJUZXN0IE1vZGVsXCIsXG5cdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0cHJvdmlkZXI6IFwiYW50aHJvcGljXCIsXG5cdGNvbnRleHRXaW5kb3c6IDIwMF8wMDAsXG5cdG1heE91dHB1dDogNDA5Nixcblx0c3VwcG9ydHNJbWFnZXM6IGZhbHNlLFxuXHRzdXBwb3J0c1Byb21wdENhY2hlOiBmYWxzZSxcblx0dGhpbmtpbmdMZXZlbDogdW5kZWZpbmVkLFxufTtcblxuZnVuY3Rpb24gbWFrZVRvb2xXaXRoU2NoZW1hKCk6IEFnZW50VG9vbDxhbnk+IHtcblx0cmV0dXJuIHtcblx0XHRuYW1lOiBcIndyaXRlX2ZpbGVcIixcblx0XHRsYWJlbDogXCJXcml0ZSBGaWxlXCIsXG5cdFx0ZGVzY3JpcHRpb246IFwiV3JpdGUgY29udGVudCB0byBhIGZpbGVcIixcblx0XHRwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG5cdFx0XHRwYXRoOiBUeXBlLlN0cmluZygpLFxuXHRcdFx0Y29udGVudDogVHlwZS5TdHJpbmcoKSxcblx0XHR9KSxcblx0XHRleGVjdXRlOiBhc3luYyAoKSA9PiAoe1xuXHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IFwiZG9uZVwiIH1dLFxuXHRcdFx0ZGV0YWlsczoge30sXG5cdFx0fSksXG5cdH07XG59XG5cbi8qKlxuICogQ3JlYXRlcyBhIG1vY2sgc3RyZWFtRm4gdGhhdCByZXR1cm5zIGFzc2lzdGFudCBtZXNzYWdlcyBmcm9tIGEgcXVldWUuXG4gKiBFYWNoIGNhbGwgcG9wcyB0aGUgbmV4dCBtZXNzYWdlLiBUaGUgbWVzc2FnZXMgc2ltdWxhdGUgdGhlIExMTSByZXBlYXRlZGx5XG4gKiBlbWl0dGluZyB0aGUgc2FtZSB0b29sIGNhbGwgd2l0aCBicm9rZW4gYXJndW1lbnRzLlxuICovXG5mdW5jdGlvbiBjcmVhdGVNb2NrU3RyZWFtRm4ocmVzcG9uc2VzOiBBc3Npc3RhbnRNZXNzYWdlW10pIHtcblx0bGV0IGNhbGxJbmRleCA9IDA7XG5cblx0cmV0dXJuIGZ1bmN0aW9uIG1vY2tTdHJlYW1GbigpOiBBc3Npc3RhbnRNZXNzYWdlRXZlbnRTdHJlYW0ge1xuXHRcdGNvbnN0IG1lc3NhZ2UgPSByZXNwb25zZXNbY2FsbEluZGV4XSA/PyByZXNwb25zZXNbcmVzcG9uc2VzLmxlbmd0aCAtIDFdO1xuXHRcdGNhbGxJbmRleCsrO1xuXG5cdFx0Y29uc3Qgc3RyZWFtID0gbmV3IEFzc2lzdGFudE1lc3NhZ2VFdmVudFN0cmVhbSgpO1xuXHRcdC8vIFNpbXVsYXRlIGFzeW5jIGRlbGl2ZXJ5XG5cdFx0cXVldWVNaWNyb3Rhc2soKCkgPT4ge1xuXHRcdFx0c3RyZWFtLnB1c2goeyB0eXBlOiBcInN0YXJ0XCIsIHBhcnRpYWw6IG1lc3NhZ2UgfSk7XG5cdFx0XHRzdHJlYW0ucHVzaCh7IHR5cGU6IFwiZG9uZVwiLCBtZXNzYWdlIH0pO1xuXHRcdFx0c3RyZWFtLmVuZChtZXNzYWdlKTtcblx0XHR9KTtcblx0XHRyZXR1cm4gc3RyZWFtO1xuXHR9O1xufVxuXG5mdW5jdGlvbiBtYWtlQXNzaXN0YW50TWVzc2FnZShvdmVycmlkZXM6IFBhcnRpYWw8QXNzaXN0YW50TWVzc2FnZT4gPSB7fSk6IEFzc2lzdGFudE1lc3NhZ2Uge1xuXHRyZXR1cm4ge1xuXHRcdHJvbGU6IFwiYXNzaXN0YW50XCIsXG5cdFx0Y29udGVudDogW10sXG5cdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdHByb3ZpZGVyOiBcImFudGhyb3BpY1wiLFxuXHRcdG1vZGVsOiBcImNsYXVkZS10ZXN0XCIsXG5cdFx0dXNhZ2U6IHsgaW5wdXQ6IDEwMCwgb3V0cHV0OiA1MCwgY2FjaGVSZWFkOiAwLCBjYWNoZVdyaXRlOiAwLCB0b3RhbFRva2VuczogMTUwLCBjb3N0OiB7IGlucHV0OiAwLCBvdXRwdXQ6IDAsIGNhY2hlUmVhZDogMCwgY2FjaGVXcml0ZTogMCwgdG90YWw6IDAgfSB9LFxuXHRcdHN0b3BSZWFzb246IFwic3RvcFwiLFxuXHRcdHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcblx0XHQuLi5vdmVycmlkZXMsXG5cdH07XG59XG5cbmZ1bmN0aW9uIG1ha2VUb29sQ2FsbE1lc3NhZ2UodG9vbENhbGxBcmdzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IEFzc2lzdGFudE1lc3NhZ2Uge1xuXHRyZXR1cm4gbWFrZUFzc2lzdGFudE1lc3NhZ2Uoe1xuXHRcdGNvbnRlbnQ6IFtcblx0XHRcdHtcblx0XHRcdFx0dHlwZTogXCJ0b29sQ2FsbFwiLFxuXHRcdFx0XHRpZDogYHRjXyR7RGF0ZS5ub3coKX1fJHtNYXRoLnJhbmRvbSgpfWAsXG5cdFx0XHRcdG5hbWU6IFwid3JpdGVfZmlsZVwiLFxuXHRcdFx0XHRhcmd1bWVudHM6IHRvb2xDYWxsQXJncyxcblx0XHRcdH0sXG5cdFx0XSxcblx0XHRzdG9wUmVhc29uOiBcInRvb2xVc2VcIixcblx0fSk7XG59XG5cbmZ1bmN0aW9uIGNvbGxlY3RFdmVudHMoc3RyZWFtOiBFdmVudFN0cmVhbTxBZ2VudEV2ZW50LCBBZ2VudE1lc3NhZ2VbXT4pOiBQcm9taXNlPEFnZW50RXZlbnRbXT4ge1xuXHRyZXR1cm4gbmV3IFByb21pc2UoYXN5bmMgKHJlc29sdmUpID0+IHtcblx0XHRjb25zdCBldmVudHM6IEFnZW50RXZlbnRbXSA9IFtdO1xuXHRcdGZvciBhd2FpdCAoY29uc3QgZXZlbnQgb2Ygc3RyZWFtKSB7XG5cdFx0XHRldmVudHMucHVzaChldmVudCk7XG5cdFx0fVxuXHRcdHJlc29sdmUoZXZlbnRzKTtcblx0fSk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJhZ2VudC1sb29wIFx1MjAxNCBzY2hlbWEgb3ZlcmxvYWQgcmV0cnkgY2FwICgjMjc4MylcIiwgKCkgPT4ge1xuXG5cdGl0KFwidGVybWluYXRlcyBhZnRlciBNQVhfQ09OU0VDVVRJVkVfVkFMSURBVElPTl9GQUlMVVJFUyBjb25zZWN1dGl2ZSBzY2hlbWEgZmFpbHVyZXNcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IHRvb2wgPSBtYWtlVG9vbFdpdGhTY2hlbWEoKTtcblxuXHRcdC8vIExMTSBrZWVwcyBzZW5kaW5nIHRvb2wgY2FsbHMgd2l0aCBpbnZhbGlkIGFyZ3MgKG1pc3NpbmcgcmVxdWlyZWQgJ2NvbnRlbnQnIGZpZWxkKVxuXHRcdGNvbnN0IGJhZFRvb2xDYWxsID0gbWFrZVRvb2xDYWxsTWVzc2FnZSh7IHBhdGg6IFwiL3RtcC90ZXN0XCIgfSk7IC8vIG1pc3NpbmcgJ2NvbnRlbnQnXG5cdFx0Y29uc3QgZmluYWxTdG9wID0gbWFrZUFzc2lzdGFudE1lc3NhZ2UoeyBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJJIGdpdmUgdXAuXCIgfV0sIHN0b3BSZWFzb246IFwic3RvcFwiIH0pO1xuXG5cdFx0Ly8gQ3JlYXRlIGVub3VnaCBiYWQgcmVzcG9uc2VzIHRvIGV4Y2VlZCB0aGUgY2FwLCBwbHVzIGEgZmluYWwgc3RvcFxuXHRcdGNvbnN0IHJlc3BvbnNlczogQXNzaXN0YW50TWVzc2FnZVtdID0gW107XG5cdFx0Zm9yIChsZXQgaSA9IDA7IGkgPCBNQVhfQ09OU0VDVVRJVkVfVkFMSURBVElPTl9GQUlMVVJFUyArIDU7IGkrKykge1xuXHRcdFx0cmVzcG9uc2VzLnB1c2goYmFkVG9vbENhbGwpO1xuXHRcdH1cblx0XHRyZXNwb25zZXMucHVzaChmaW5hbFN0b3ApO1xuXG5cdFx0Y29uc3QgbW9ja1N0cmVhbSA9IGNyZWF0ZU1vY2tTdHJlYW1GbihyZXNwb25zZXMpO1xuXG5cdFx0Y29uc3QgY29udGV4dDogQWdlbnRDb250ZXh0ID0ge1xuXHRcdFx0c3lzdGVtUHJvbXB0OiBcIllvdSBhcmUgYSB0ZXN0IGFnZW50LlwiLFxuXHRcdFx0bWVzc2FnZXM6IFt7IHJvbGU6IFwidXNlclwiLCBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJXcml0ZSBhIGZpbGVcIiB9XSwgdGltZXN0YW1wOiBEYXRlLm5vdygpIH1dLFxuXHRcdFx0dG9vbHM6IFt0b29sXSxcblx0XHR9O1xuXG5cdFx0Y29uc3QgY29uZmlnOiBBZ2VudExvb3BDb25maWcgPSB7XG5cdFx0XHRtb2RlbDogVEVTVF9NT0RFTCxcblx0XHRcdGNvbnZlcnRUb0xsbTogKG1zZ3MpID0+IG1zZ3MuZmlsdGVyKChtKTogbSBpcyBhbnkgPT4gbS5yb2xlICE9PSBcImN1c3RvbVwiKSxcblx0XHRcdHRvb2xFeGVjdXRpb246IFwic2VxdWVudGlhbFwiLFxuXHRcdH07XG5cblx0XHRjb25zdCBzdHJlYW0gPSBhZ2VudExvb3AoXG5cdFx0XHRbeyByb2xlOiBcInVzZXJcIiwgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiV3JpdGUgYSBmaWxlXCIgfV0sIHRpbWVzdGFtcDogRGF0ZS5ub3coKSB9XSxcblx0XHRcdGNvbnRleHQsXG5cdFx0XHRjb25maWcsXG5cdFx0XHR1bmRlZmluZWQsXG5cdFx0XHRtb2NrU3RyZWFtIGFzIGFueSxcblx0XHQpO1xuXG5cdFx0Y29uc3QgZXZlbnRzID0gYXdhaXQgY29sbGVjdEV2ZW50cyhzdHJlYW0pO1xuXG5cdFx0Ly8gTXVzdCBoYXZlIHRlcm1pbmF0ZWQgKGFnZW50X2VuZCBldmVudCBwcmVzZW50KVxuXHRcdGNvbnN0IGFnZW50RW5kID0gZXZlbnRzLmZpbmQoKGUpID0+IGUudHlwZSA9PT0gXCJhZ2VudF9lbmRcIik7XG5cdFx0YXNzZXJ0Lm9rKGFnZW50RW5kLCBcImFnZW50IGxvb3AgbXVzdCBlbWl0IGFnZW50X2VuZCBhZnRlciBoaXR0aW5nIHJldHJ5IGNhcFwiKTtcblxuXHRcdC8vIENvdW50IGhvdyBtYW55IHR1cm5zIGhhZCB2YWxpZGF0aW9uIGVycm9ycyAodG9vbF9leGVjdXRpb25fZW5kIHdpdGggaXNFcnJvcjogdHJ1ZSlcblx0XHRjb25zdCB0b29sRXJyb3JzID0gZXZlbnRzLmZpbHRlcihcblx0XHRcdChlKSA9PiBlLnR5cGUgPT09IFwidG9vbF9leGVjdXRpb25fZW5kXCIgJiYgZS5pc0Vycm9yID09PSB0cnVlLFxuXHRcdCk7XG5cblx0XHQvLyBNdXN0IG5vdCBleGNlZWQgdGhlIGNhcFxuXHRcdGFzc2VydC5vayhcblx0XHRcdHRvb2xFcnJvcnMubGVuZ3RoIDw9IE1BWF9DT05TRUNVVElWRV9WQUxJREFUSU9OX0ZBSUxVUkVTLFxuXHRcdFx0YEV4cGVjdGVkIGF0IG1vc3QgJHtNQVhfQ09OU0VDVVRJVkVfVkFMSURBVElPTl9GQUlMVVJFU30gdmFsaWRhdGlvbiBlcnJvciB0b29sIHJlc3VsdHMsIGdvdCAke3Rvb2xFcnJvcnMubGVuZ3RofWAsXG5cdFx0KTtcblx0fSk7XG5cblx0aXQoXCJyZXNldHMgdGhlIGZhaWx1cmUgY291bnRlciB3aGVuIGEgdG9vbCBjYWxsIHN1Y2NlZWRzXCIsIGFzeW5jICgpID0+IHtcblx0XHRjb25zdCB0b29sID0gbWFrZVRvb2xXaXRoU2NoZW1hKCk7XG5cblx0XHQvLyBQYXR0ZXJuOiAyIGZhaWx1cmVzLCAxIHN1Y2Nlc3MsIDIgZmFpbHVyZXMsIDEgc3VjY2VzcywgdGhlbiBzdG9wXG5cdFx0Y29uc3QgYmFkQ2FsbCA9IG1ha2VUb29sQ2FsbE1lc3NhZ2UoeyBwYXRoOiBcIi90bXAvdGVzdFwiIH0pOyAvLyBtaXNzaW5nICdjb250ZW50J1xuXHRcdGNvbnN0IGdvb2RDYWxsID0gbWFrZVRvb2xDYWxsTWVzc2FnZSh7IHBhdGg6IFwiL3RtcC90ZXN0XCIsIGNvbnRlbnQ6IFwiaGVsbG9cIiB9KTtcblx0XHRjb25zdCBmaW5hbFN0b3AgPSBtYWtlQXNzaXN0YW50TWVzc2FnZSh7IGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkRvbmUuXCIgfV0sIHN0b3BSZWFzb246IFwic3RvcFwiIH0pO1xuXG5cdFx0Y29uc3QgcmVzcG9uc2VzID0gW2JhZENhbGwsIGJhZENhbGwsIGdvb2RDYWxsLCBiYWRDYWxsLCBiYWRDYWxsLCBnb29kQ2FsbCwgZmluYWxTdG9wXTtcblx0XHRjb25zdCBtb2NrU3RyZWFtID0gY3JlYXRlTW9ja1N0cmVhbUZuKHJlc3BvbnNlcyk7XG5cblx0XHRjb25zdCBjb250ZXh0OiBBZ2VudENvbnRleHQgPSB7XG5cdFx0XHRzeXN0ZW1Qcm9tcHQ6IFwiWW91IGFyZSBhIHRlc3QgYWdlbnQuXCIsXG5cdFx0XHRtZXNzYWdlczogW3sgcm9sZTogXCJ1c2VyXCIsIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIldyaXRlIGEgZmlsZVwiIH1dLCB0aW1lc3RhbXA6IERhdGUubm93KCkgfV0sXG5cdFx0XHR0b29sczogW3Rvb2xdLFxuXHRcdH07XG5cblx0XHRjb25zdCBjb25maWc6IEFnZW50TG9vcENvbmZpZyA9IHtcblx0XHRcdG1vZGVsOiBURVNUX01PREVMLFxuXHRcdFx0Y29udmVydFRvTGxtOiAobXNncykgPT4gbXNncy5maWx0ZXIoKG0pOiBtIGlzIGFueSA9PiBtLnJvbGUgIT09IFwiY3VzdG9tXCIpLFxuXHRcdFx0dG9vbEV4ZWN1dGlvbjogXCJzZXF1ZW50aWFsXCIsXG5cdFx0fTtcblxuXHRcdGNvbnN0IHN0cmVhbSA9IGFnZW50TG9vcChcblx0XHRcdFt7IHJvbGU6IFwidXNlclwiLCBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJXcml0ZSBhIGZpbGVcIiB9XSwgdGltZXN0YW1wOiBEYXRlLm5vdygpIH1dLFxuXHRcdFx0Y29udGV4dCxcblx0XHRcdGNvbmZpZyxcblx0XHRcdHVuZGVmaW5lZCxcblx0XHRcdG1vY2tTdHJlYW0gYXMgYW55LFxuXHRcdCk7XG5cblx0XHRjb25zdCBldmVudHMgPSBhd2FpdCBjb2xsZWN0RXZlbnRzKHN0cmVhbSk7XG5cblx0XHQvLyBNdXN0IGNvbXBsZXRlIHN1Y2Nlc3NmdWxseSBzaW5jZSBmYWlsdXJlcyBuZXZlciByZWFjaGVkIGNhcCBjb25zZWN1dGl2ZWx5XG5cdFx0Y29uc3QgYWdlbnRFbmQgPSBldmVudHMuZmluZCgoZSkgPT4gZS50eXBlID09PSBcImFnZW50X2VuZFwiKTtcblx0XHRhc3NlcnQub2soYWdlbnRFbmQsIFwiYWdlbnQgbG9vcCBtdXN0IGNvbXBsZXRlIG5vcm1hbGx5IHdoZW4gZmFpbHVyZXMgYXJlIGludGVyc3BlcnNlZCB3aXRoIHN1Y2Nlc3Nlc1wiKTtcblxuXHRcdC8vIFNob3VsZCBoYXZlIHByb2Nlc3NlZCBhbGwgNiB0b29sLWJlYXJpbmcgdHVybnNcblx0XHRjb25zdCB0b29sRXhlY0VuZHMgPSBldmVudHMuZmlsdGVyKChlKSA9PiBlLnR5cGUgPT09IFwidG9vbF9leGVjdXRpb25fZW5kXCIpO1xuXHRcdGFzc2VydC5vayh0b29sRXhlY0VuZHMubGVuZ3RoID49IDQsIGBFeHBlY3RlZCBhdCBsZWFzdCA0IHRvb2wgZXhlY3V0aW9ucyAoMiBiYWQgKyAxIGdvb2QgKyAyIGJhZCArIDEgZ29vZCksIGdvdCAke3Rvb2xFeGVjRW5kcy5sZW5ndGh9YCk7XG5cdH0pO1xuXG5cdGl0KFwiZXhwb3J0cyBNQVhfQ09OU0VDVVRJVkVfVkFMSURBVElPTl9GQUlMVVJFUyBhcyBhIGNvbmZpZ3VyYWJsZSBjb25zdGFudFwiLCAoKSA9PiB7XG5cdFx0YXNzZXJ0LmVxdWFsKHR5cGVvZiBNQVhfQ09OU0VDVVRJVkVfVkFMSURBVElPTl9GQUlMVVJFUywgXCJudW1iZXJcIik7XG5cdFx0YXNzZXJ0Lm9rKE1BWF9DT05TRUNVVElWRV9WQUxJREFUSU9OX0ZBSUxVUkVTID49IDIsIFwiQ2FwIG11c3QgYmUgYXQgbGVhc3QgMiB0byBhbGxvdyBvbmUgcmV0cnlcIik7XG5cdFx0YXNzZXJ0Lm9rKE1BWF9DT05TRUNVVElWRV9WQUxJREFUSU9OX0ZBSUxVUkVTIDw9IDEwLCBcIkNhcCBtdXN0IG5vdCBiZSB1bnJlYXNvbmFibHkgaGlnaFwiKTtcblx0fSk7XG5cblx0aXQoXCJkb2VzIE5PVCB0cmlwIHNjaGVtYSBvdmVybG9hZCBjYXAgb24gdG9vbCBleGVjdXRpb24gZXJyb3JzIGxpa2UgYmFzaCBleGl0IGNvZGUgMSAoIzM2MTgpXCIsIGFzeW5jICgpID0+IHtcblx0XHQvLyBTaW11bGF0ZXMgdGhlIHJlYWwgc2NlbmFyaW86IGEgdG9vbCAoYmFzaCkgdGhhdCBwYXNzZXMgdmFsaWRhdGlvbiBidXRcblx0XHQvLyB0aHJvd3MgZHVyaW5nIGV4ZWN1dGlvbiAoZS5nLiByZy9ncmVwIHJldHVybmluZyBleGl0IGNvZGUgMSA9IG5vIG1hdGNoZXMpLlxuXHRcdC8vIFRoZXNlIGFyZSB2YWxpZCB0b29sIGludm9jYXRpb25zIFx1MjAxNCB0aGUgc2NoZW1hIHdhcyBjb3JyZWN0LCB0aGUgdG9vbCByYW4sXG5cdFx0Ly8gaXQganVzdCByZXR1cm5lZCBhIG5vbi16ZXJvIGV4aXQgY29kZS4gVGhlIGNhcCBzaG91bGQgb25seSB0cmlnZ2VyIGZvclxuXHRcdC8vIHByZXBhcmF0aW9uL3NjaGVtYSBmYWlsdXJlcywgbm90IGV4ZWN1dGlvbiBmYWlsdXJlcy5cblx0XHRjb25zdCBiYXNoVG9vbDogQWdlbnRUb29sPGFueT4gPSB7XG5cdFx0XHRuYW1lOiBcImJhc2hcIixcblx0XHRcdGxhYmVsOiBcIkJhc2hcIixcblx0XHRcdGRlc2NyaXB0aW9uOiBcIlJ1biBhIGJhc2ggY29tbWFuZFwiLFxuXHRcdFx0cGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe1xuXHRcdFx0XHRjb21tYW5kOiBUeXBlLlN0cmluZygpLFxuXHRcdFx0fSksXG5cdFx0XHRleGVjdXRlOiBhc3luYyAoKSA9PiB7XG5cdFx0XHRcdC8vIFNpbXVsYXRlIGJhc2ggdG9vbCByZWplY3Rpbmcgb24gbm9uLXplcm8gZXhpdCBjb2RlXG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihcIihubyBvdXRwdXQpXFxuXFxuQ29tbWFuZCBleGl0ZWQgd2l0aCBjb2RlIDFcIik7XG5cdFx0XHR9LFxuXHRcdH07XG5cblx0XHQvLyBMTE0gc2VuZHMgdmFsaWQgdG9vbCBjYWxscyAoc2NoZW1hIGlzIGNvcnJlY3QpIHRoYXQgZmFpbCBhdCBleGVjdXRpb25cblx0XHRjb25zdCB2YWxpZEJhc2hDYWxsID0gbWFrZUFzc2lzdGFudE1lc3NhZ2Uoe1xuXHRcdFx0Y29udGVudDogW1xuXHRcdFx0XHR7XG5cdFx0XHRcdFx0dHlwZTogXCJ0b29sQ2FsbFwiLFxuXHRcdFx0XHRcdGlkOiBgdGNfYmFzaF8ke0RhdGUubm93KCl9XyR7TWF0aC5yYW5kb20oKX1gLFxuXHRcdFx0XHRcdG5hbWU6IFwiYmFzaFwiLFxuXHRcdFx0XHRcdGFyZ3VtZW50czogeyBjb21tYW5kOiBcInJnIC1sICdub25leGlzdGVudCcgc3JjL1wiIH0sXG5cdFx0XHRcdH0sXG5cdFx0XHRdLFxuXHRcdFx0c3RvcFJlYXNvbjogXCJ0b29sVXNlXCIsXG5cdFx0fSk7XG5cdFx0Y29uc3QgZmluYWxTdG9wID0gbWFrZUFzc2lzdGFudE1lc3NhZ2Uoe1xuXHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiTm8gcmVmZXJlbmNlcyBmb3VuZC5cIiB9XSxcblx0XHRcdHN0b3BSZWFzb246IFwic3RvcFwiLFxuXHRcdH0pO1xuXG5cdFx0Ly8gU2VuZCBtb3JlIHRoYW4gTUFYX0NPTlNFQ1VUSVZFX1ZBTElEQVRJT05fRkFJTFVSRVMgYmFzaCBjYWxscyB0aGF0IHRocm93XG5cdFx0Y29uc3QgcmVzcG9uc2VzOiBBc3Npc3RhbnRNZXNzYWdlW10gPSBbXTtcblx0XHRmb3IgKGxldCBpID0gMDsgaSA8IE1BWF9DT05TRUNVVElWRV9WQUxJREFUSU9OX0ZBSUxVUkVTICsgMjsgaSsrKSB7XG5cdFx0XHRyZXNwb25zZXMucHVzaCh2YWxpZEJhc2hDYWxsKTtcblx0XHR9XG5cdFx0cmVzcG9uc2VzLnB1c2goZmluYWxTdG9wKTtcblxuXHRcdGNvbnN0IG1vY2tTdHJlYW0gPSBjcmVhdGVNb2NrU3RyZWFtRm4ocmVzcG9uc2VzKTtcblxuXHRcdGNvbnN0IGNvbnRleHQ6IEFnZW50Q29udGV4dCA9IHtcblx0XHRcdHN5c3RlbVByb21wdDogXCJZb3UgYXJlIGEgdGVzdCBhZ2VudC5cIixcblx0XHRcdG1lc3NhZ2VzOiBbeyByb2xlOiBcInVzZXJcIiwgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiU2VhcmNoIGZvciByZWZlcmVuY2VzXCIgfV0sIHRpbWVzdGFtcDogRGF0ZS5ub3coKSB9XSxcblx0XHRcdHRvb2xzOiBbYmFzaFRvb2xdLFxuXHRcdH07XG5cblx0XHRjb25zdCBjb25maWc6IEFnZW50TG9vcENvbmZpZyA9IHtcblx0XHRcdG1vZGVsOiBURVNUX01PREVMLFxuXHRcdFx0Y29udmVydFRvTGxtOiAobXNncykgPT4gbXNncy5maWx0ZXIoKG0pOiBtIGlzIGFueSA9PiBtLnJvbGUgIT09IFwiY3VzdG9tXCIpLFxuXHRcdFx0dG9vbEV4ZWN1dGlvbjogXCJzZXF1ZW50aWFsXCIsXG5cdFx0fTtcblxuXHRcdGNvbnN0IHN0cmVhbSA9IGFnZW50TG9vcChcblx0XHRcdFt7IHJvbGU6IFwidXNlclwiLCBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJTZWFyY2ggZm9yIHJlZmVyZW5jZXNcIiB9XSwgdGltZXN0YW1wOiBEYXRlLm5vdygpIH1dLFxuXHRcdFx0Y29udGV4dCxcblx0XHRcdGNvbmZpZyxcblx0XHRcdHVuZGVmaW5lZCxcblx0XHRcdG1vY2tTdHJlYW0gYXMgYW55LFxuXHRcdCk7XG5cblx0XHRjb25zdCBldmVudHMgPSBhd2FpdCBjb2xsZWN0RXZlbnRzKHN0cmVhbSk7XG5cblx0XHQvLyBNdXN0IGNvbXBsZXRlIG5vcm1hbGx5IFx1MjAxNCBleGVjdXRpb24gZXJyb3JzIHNob3VsZCBOT1QgdHJpZ2dlciB0aGUgY2FwXG5cdFx0Y29uc3QgYWdlbnRFbmQgPSBldmVudHMuZmluZCgoZSkgPT4gZS50eXBlID09PSBcImFnZW50X2VuZFwiKTtcblx0XHRhc3NlcnQub2soYWdlbnRFbmQsIFwiYWdlbnQgbG9vcCBtdXN0IGVtaXQgYWdlbnRfZW5kXCIpO1xuXG5cdFx0Ly8gQ291bnQgdG9vbCBleGVjdXRpb24gZXJyb3JzXG5cdFx0Y29uc3QgdG9vbEVycm9ycyA9IGV2ZW50cy5maWx0ZXIoXG5cdFx0XHQoZSkgPT4gZS50eXBlID09PSBcInRvb2xfZXhlY3V0aW9uX2VuZFwiICYmIGUuaXNFcnJvciA9PT0gdHJ1ZSxcblx0XHQpO1xuXG5cdFx0Ly8gQWxsIGJhc2ggY2FsbHMgc2hvdWxkIGhhdmUgYmVlbiBhdHRlbXB0ZWQgKG5vdCBjYXBwZWQgZWFybHkpXG5cdFx0YXNzZXJ0Lm9rKFxuXHRcdFx0dG9vbEVycm9ycy5sZW5ndGggPj0gTUFYX0NPTlNFQ1VUSVZFX1ZBTElEQVRJT05fRkFJTFVSRVMgKyAyLFxuXHRcdFx0YEV4cGVjdGVkIGFsbCAke01BWF9DT05TRUNVVElWRV9WQUxJREFUSU9OX0ZBSUxVUkVTICsgMn0gYmFzaCBleGVjdXRpb24gZXJyb3JzIHRvIGJlIHByb2Nlc3NlZCAobm90IGNhcHBlZCksIGdvdCAke3Rvb2xFcnJvcnMubGVuZ3RofWAsXG5cdFx0KTtcblxuXHRcdC8vIFRoZSBzdG9wIG1lc3NhZ2Ugc2hvdWxkIE5PVCBjb250YWluIHRoZSBzY2hlbWEgb3ZlcmxvYWQgdGV4dFxuXHRcdGNvbnN0IGFsbE1lc3NhZ2VzID0gKGFnZW50RW5kIGFzIGFueSkubWVzc2FnZXMgYXMgQWdlbnRNZXNzYWdlW107XG5cdFx0Y29uc3QgbGFzdE1lc3NhZ2UgPSBhbGxNZXNzYWdlc1thbGxNZXNzYWdlcy5sZW5ndGggLSAxXTtcblx0XHRjb25zdCBsYXN0VGV4dCA9IGxhc3RNZXNzYWdlLnJvbGUgPT09IFwiYXNzaXN0YW50XCJcblx0XHRcdD8gKGxhc3RNZXNzYWdlIGFzIEFzc2lzdGFudE1lc3NhZ2UpLmNvbnRlbnQuZmluZCgoYykgPT4gYy50eXBlID09PSBcInRleHRcIilcblx0XHRcdDogdW5kZWZpbmVkO1xuXHRcdGlmIChsYXN0VGV4dCAmJiBsYXN0VGV4dC50eXBlID09PSBcInRleHRcIikge1xuXHRcdFx0YXNzZXJ0Lm9rKFxuXHRcdFx0XHQhbGFzdFRleHQudGV4dC5pbmNsdWRlcyhcImNvbnNlY3V0aXZlIHR1cm5zIHdpdGggYWxsIHRvb2wgY2FsbHMgZmFpbGluZ1wiKSxcblx0XHRcdFx0XCJGaW5hbCBtZXNzYWdlIG11c3QgTk9UIGNvbnRhaW4gc2NoZW1hIG92ZXJsb2FkIHN0b3AgdGV4dCBmb3IgZXhlY3V0aW9uLW9ubHkgZXJyb3JzXCIsXG5cdFx0XHQpO1xuXHRcdH1cblx0fSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUdBLFNBQVMsVUFBVSxVQUFVO0FBQzdCLE9BQU8sWUFBWTtBQUNuQixTQUFTLFlBQVk7QUFDckIsU0FBUyxXQUFXLDJDQUEyQztBQUUvRCxTQUFTLG1DQUFnRDtBQUd6RCxTQUFTLGdEQUEyQyxNQUFNO0FBQ3pELEtBQUcsNERBQTRELFlBQVk7QUFDMUUsVUFBTSxZQUFZLHFCQUFxQjtBQUFBLE1BQ3RDLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBUSxNQUFNLFFBQVEsQ0FBQztBQUFBLE1BQ3pDLFlBQVk7QUFBQSxJQUNiLENBQUM7QUFDRCxVQUFNLFdBQVcsUUFBUSxJQUFJO0FBQzdCLFVBQU0sZ0JBQWdCLFFBQVEsT0FBTztBQUNyQyxRQUFJLFVBQVU7QUFDZCxZQUFRLElBQUksaUJBQWlCO0FBQzdCLFlBQVEsT0FBTyxTQUFTLENBQUMsVUFBK0I7QUFDdkQsaUJBQVcsTUFBTSxTQUFTO0FBQzFCLGFBQU87QUFBQSxJQUNSO0FBRUEsUUFBSTtBQUNILFVBQUk7QUFDSixZQUFNLFdBQVcsQ0FBQyxRQUFvQixlQUFpRDtBQUN0RixlQUFPLE1BQU0sV0FBVyxTQUFTLFFBQVEsR0FBRyw2Q0FBNkM7QUFDekYsZUFBTyxNQUFNLFdBQVcsU0FBUyxDQUFDLEVBQUUsUUFBUSxDQUFDLEVBQUUsTUFBTSxhQUFhO0FBQ2xFLGNBQU1BLFVBQVMsSUFBSSw0QkFBNEI7QUFDL0MsdUJBQWUsTUFBTTtBQUNwQixVQUFBQSxRQUFPLEtBQUssRUFBRSxNQUFNLFNBQVMsU0FBUyxVQUFVLENBQUM7QUFDakQsVUFBQUEsUUFBTyxLQUFLLEVBQUUsTUFBTSxRQUFRLFNBQVMsVUFBVSxDQUFDO0FBQ2hELFVBQUFBLFFBQU8sSUFBSSxTQUFTO0FBQUEsUUFDckIsQ0FBQztBQUNELGVBQU9BO0FBQUEsTUFDUjtBQUNBLFlBQU0sVUFBd0I7QUFBQSxRQUM3QixjQUFjO0FBQUEsUUFDZCxVQUFVLENBQUMsRUFBRSxNQUFNLFFBQVEsU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFRLE1BQU0sV0FBVyxDQUFDLEdBQUcsV0FBVyxLQUFLLElBQUksRUFBRSxDQUFDO0FBQUEsUUFDakcsT0FBTyxDQUFDO0FBQUEsTUFDVDtBQUNBLFlBQU0sU0FBMEI7QUFBQSxRQUMvQixPQUFPO0FBQUEsUUFDUCxrQkFBa0IsWUFBWTtBQUFBLFVBQzdCLEVBQUUsTUFBTSxRQUFRLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBUSxNQUFNLGNBQWMsQ0FBQyxHQUFHLFdBQVcsS0FBSyxJQUFJLEVBQUU7QUFBQSxRQUN6RjtBQUFBLFFBQ0EsY0FBYyxDQUFDLFNBQVMsS0FBSyxPQUFPLENBQUMsTUFBZ0IsRUFBRSxTQUFTLFFBQVE7QUFBQSxRQUN4RSxhQUFhLENBQUMsT0FBTyxTQUFTLGFBQWE7QUFDMUMsNkJBQW1CO0FBQ25CLGlCQUFPO0FBQUEsUUFDUjtBQUFBLFFBQ0EsZUFBZTtBQUFBLE1BQ2hCO0FBRUEsWUFBTSxTQUFTO0FBQUEsUUFDZCxDQUFDLEVBQUUsTUFBTSxRQUFRLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBUSxNQUFNLGFBQWEsQ0FBQyxHQUFHLFdBQVcsS0FBSyxJQUFJLEVBQUUsQ0FBQztBQUFBLFFBQ3pGO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsTUFDRDtBQUNBLFlBQU0sY0FBYyxNQUFNO0FBRTFCLGFBQU8sTUFBTSxTQUFTLHNCQUFzQjtBQUM1QyxhQUFPLE1BQU0sU0FBUyxrQkFBa0I7QUFDeEMsYUFBTyxNQUFPLG1CQUFtQixDQUFDLEdBQVcsVUFBVSxDQUFDLEdBQUcsTUFBTSxhQUFhO0FBQzlFLGFBQU8sYUFBYSxTQUFTLGtEQUFrRDtBQUFBLElBQ2hGLFVBQUU7QUFDRCxjQUFRLE9BQU8sUUFBUTtBQUN2QixVQUFJLGFBQWEsT0FBVyxRQUFPLFFBQVEsSUFBSTtBQUFBLFVBQzFDLFNBQVEsSUFBSSxpQkFBaUI7QUFBQSxJQUNuQztBQUFBLEVBQ0QsQ0FBQztBQUVELEtBQUcsMEVBQTBFLFlBQVk7QUFDeEYsVUFBTSxZQUFZLHFCQUFxQjtBQUFBLE1BQ3RDLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBUSxNQUFNLFFBQVEsQ0FBQztBQUFBLE1BQ3pDLFlBQVk7QUFBQSxJQUNiLENBQUM7QUFDRCxVQUFNLFdBQVcsUUFBUSxJQUFJO0FBQzdCLFVBQU0sZ0JBQWdCLFFBQVEsT0FBTztBQUNyQyxRQUFJLFVBQVU7QUFDZCxZQUFRLElBQUksaUJBQWlCO0FBQzdCLFlBQVEsT0FBTyxTQUFTLENBQUMsVUFBK0I7QUFDdkQsaUJBQVcsTUFBTSxTQUFTO0FBQzFCLGFBQU87QUFBQSxJQUNSO0FBRUEsUUFBSTtBQUNILFlBQU0sV0FBVyxDQUFDLFFBQW9CLGVBQWlEO0FBQ3RGLGVBQU8sVUFBVSxXQUFXLE9BQU8sSUFBSSxDQUFDLFNBQW9CLEtBQUssSUFBSSxHQUFHLENBQUMsWUFBWSxDQUFDO0FBQ3RGLGNBQU1BLFVBQVMsSUFBSSw0QkFBNEI7QUFDL0MsdUJBQWUsTUFBTTtBQUNwQixVQUFBQSxRQUFPLEtBQUssRUFBRSxNQUFNLFNBQVMsU0FBUyxVQUFVLENBQUM7QUFDakQsVUFBQUEsUUFBTyxLQUFLLEVBQUUsTUFBTSxRQUFRLFNBQVMsVUFBVSxDQUFDO0FBQ2hELFVBQUFBLFFBQU8sSUFBSSxTQUFTO0FBQUEsUUFDckIsQ0FBQztBQUNELGVBQU9BO0FBQUEsTUFDUjtBQUNBLFlBQU0sVUFBd0I7QUFBQSxRQUM3QixjQUFjO0FBQUEsUUFDZCxVQUFVLENBQUMsRUFBRSxNQUFNLFFBQVEsU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFRLE1BQU0sYUFBYSxDQUFDLEdBQUcsV0FBVyxLQUFLLElBQUksRUFBRSxDQUFDO0FBQUEsUUFDbkcsT0FBTztBQUFBLFVBQ04sbUJBQW1CO0FBQUEsVUFDbkI7QUFBQSxZQUNDLEdBQUcsbUJBQW1CO0FBQUEsWUFDdEIsTUFBTTtBQUFBLFlBQ04sT0FBTztBQUFBLFVBQ1I7QUFBQSxRQUNEO0FBQUEsTUFDRDtBQUNBLFlBQU0sU0FBMEI7QUFBQSxRQUMvQixPQUFPO0FBQUEsUUFDUCxjQUFjLENBQUMsU0FBUyxLQUFLLE9BQU8sQ0FBQyxNQUFnQixFQUFFLFNBQVMsUUFBUTtBQUFBLFFBQ3hFLGFBQWEsT0FBTyxVQUFVLE1BQU0sT0FBTyxDQUFDLFNBQVMsS0FBSyxTQUFTLFlBQVk7QUFBQSxRQUMvRSxlQUFlO0FBQUEsTUFDaEI7QUFFQSxZQUFNLFNBQVM7QUFBQSxRQUNkLENBQUMsRUFBRSxNQUFNLFFBQVEsU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFRLE1BQU0sYUFBYSxDQUFDLEdBQUcsV0FBVyxLQUFLLElBQUksRUFBRSxDQUFDO0FBQUEsUUFDekY7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxNQUNEO0FBQ0EsWUFBTSxjQUFjLE1BQU07QUFFMUIsYUFBTyxNQUFNLFNBQVMsZUFBZTtBQUNyQyxhQUFPLE1BQU0sU0FBUyxxQkFBcUI7QUFDM0MsYUFBTyxhQUFhLFNBQVMsV0FBVztBQUFBLElBQ3pDLFVBQUU7QUFDRCxjQUFRLE9BQU8sUUFBUTtBQUN2QixVQUFJLGFBQWEsT0FBVyxRQUFPLFFBQVEsSUFBSTtBQUFBLFVBQzFDLFNBQVEsSUFBSSxpQkFBaUI7QUFBQSxJQUNuQztBQUFBLEVBQ0QsQ0FBQztBQUVELEtBQUcscUVBQXFFLFlBQVk7QUFDbkYsVUFBTSxZQUFZLHFCQUFxQjtBQUFBLE1BQ3RDLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBUSxNQUFNLG1CQUFtQixDQUFDO0FBQUEsTUFDcEQsWUFBWTtBQUFBLElBQ2IsQ0FBQztBQUNELFVBQU0sWUFBWSxxQkFBcUI7QUFBQSxNQUN0QyxTQUFTLENBQUMsRUFBRSxNQUFNLFFBQVEsTUFBTSxRQUFRLENBQUM7QUFBQSxNQUN6QyxZQUFZO0FBQUEsSUFDYixDQUFDO0FBRUQsUUFBSSxrQkFBa0I7QUFDdEIsVUFBTSxnQkFBMEIsQ0FBQztBQUNqQyxVQUFNLFdBQVcsQ0FBQyxRQUFvQixlQUFpRDtBQUN0RjtBQUNBLG9CQUFjLEtBQUssV0FBVyxTQUFTLEdBQUcsRUFBRSxHQUFHLFFBQVEsTUFBTTtBQUM3RCxZQUFNLFVBQVUsb0JBQW9CLElBQUksWUFBWTtBQUNwRCxZQUFNQSxVQUFTLElBQUksNEJBQTRCO0FBQy9DLHFCQUFlLE1BQU07QUFDcEIsUUFBQUEsUUFBTyxLQUFLLEVBQUUsTUFBTSxTQUFTLFNBQVMsUUFBUSxDQUFDO0FBQy9DLFFBQUFBLFFBQU8sS0FBSyxFQUFFLE1BQU0sUUFBUSxRQUFRLENBQUM7QUFDckMsUUFBQUEsUUFBTyxJQUFJLE9BQU87QUFBQSxNQUNuQixDQUFDO0FBQ0QsYUFBT0E7QUFBQSxJQUNSO0FBRUEsVUFBTSxVQUF3QjtBQUFBLE1BQzdCLGNBQWM7QUFBQSxNQUNkLFVBQVUsQ0FBQyxFQUFFLE1BQU0sUUFBUSxTQUFTLENBQUMsRUFBRSxNQUFNLFFBQVEsTUFBTSxhQUFhLENBQUMsR0FBRyxXQUFXLEtBQUssSUFBSSxFQUFFLENBQUM7QUFBQSxNQUNuRyxPQUFPLENBQUM7QUFBQSxJQUNUO0FBRUEsVUFBTSxTQUEwQjtBQUFBLE1BQy9CLE9BQU87QUFBQSxNQUNQLGNBQWMsQ0FBQyxTQUFTLEtBQUssT0FBTyxDQUFDLE1BQWdCLEVBQUUsU0FBUyxRQUFRO0FBQUEsTUFDeEUsZUFBZTtBQUFBLElBQ2hCO0FBRUEsVUFBTSxTQUFTO0FBQUEsTUFDZCxDQUFDLEVBQUUsTUFBTSxRQUFRLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBUSxNQUFNLGFBQWEsQ0FBQyxHQUFHLFdBQVcsS0FBSyxJQUFJLEVBQUUsQ0FBQztBQUFBLE1BQ3pGO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRDtBQUVBLFVBQU0sU0FBUyxNQUFNLGNBQWMsTUFBTTtBQUN6QyxVQUFNLG9CQUFvQixPQUFPO0FBQUEsTUFDaEMsQ0FBQyxVQUNBLE1BQU0sU0FBUyxpQkFBaUIsTUFBTSxRQUFRLFNBQVM7QUFBQSxJQUN6RDtBQUNBLFVBQU0sYUFBYSxPQUFPLE9BQU8sQ0FBQyxVQUFVLE1BQU0sU0FBUyxZQUFZO0FBRXZFLFdBQU8sTUFBTSxpQkFBaUIsR0FBRyw2Q0FBNkM7QUFDOUUsV0FBTyxNQUFNLGtCQUFrQixRQUFRLEdBQUcsOEJBQThCO0FBQ3hFLFdBQU8sTUFBTSxrQkFBa0IsQ0FBQyxFQUFFLFFBQVEsWUFBWSxXQUFXO0FBQ2pFLFdBQU8sTUFBTSxrQkFBa0IsQ0FBQyxFQUFFLFFBQVEsWUFBWSxNQUFNO0FBQzVELFdBQU8sTUFBTSxXQUFXLFFBQVEsR0FBRyw4Q0FBOEM7QUFDakYsV0FBTyxVQUFVLGVBQWUsQ0FBQyxRQUFRLFdBQVcsR0FBRywyREFBMkQ7QUFBQSxFQUNuSCxDQUFDO0FBUUQsS0FBRywyRUFBMkUsWUFBWTtBQUN6RixVQUFNLGtCQUFrQixxQkFBcUI7QUFBQSxNQUM1QyxTQUFTO0FBQUEsUUFDUjtBQUFBLFVBQ0MsTUFBTTtBQUFBLFVBQ04sSUFBSTtBQUFBLFVBQ0osTUFBTTtBQUFBLFVBQ04sV0FBVyxFQUFFLFNBQVMsVUFBVTtBQUFBLFVBQ2hDLGdCQUFnQjtBQUFBLFlBQ2YsU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFRLE1BQU0sT0FBTyxDQUFDO0FBQUEsWUFDeEMsU0FBUyxFQUFFLFFBQVEsY0FBYztBQUFBLFlBQ2pDLFNBQVM7QUFBQSxVQUNWO0FBQUEsUUFDRDtBQUFBLE1BQ0Q7QUFBQSxNQUNBLFlBQVk7QUFBQSxNQUNaLFVBQVU7QUFBQSxJQUNYLENBQUM7QUFFRCxVQUFNLGFBQWEsbUJBQW1CLENBQUMsZUFBZSxDQUFDO0FBRXZELFVBQU0sVUFBd0I7QUFBQSxNQUM3QixjQUFjO0FBQUEsTUFDZCxVQUFVLENBQUMsRUFBRSxNQUFNLFFBQVEsU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFRLE1BQU0sa0JBQWtCLENBQUMsR0FBRyxXQUFXLEtBQUssSUFBSSxFQUFFLENBQUM7QUFBQSxNQUN4RyxPQUFPLENBQUM7QUFBQSxJQUNUO0FBRUEsVUFBTSxTQUEwQjtBQUFBLE1BQy9CLE9BQU8sRUFBRSxHQUFHLFlBQVksVUFBVSxjQUFjO0FBQUEsTUFDaEQsY0FBYyxDQUFDLFNBQVMsS0FBSyxPQUFPLENBQUMsTUFBZ0IsRUFBRSxTQUFTLFFBQVE7QUFBQSxNQUN4RSxlQUFlO0FBQUEsTUFDZix1QkFBdUI7QUFBQSxJQUN4QjtBQUVBLFVBQU0sU0FBUztBQUFBLE1BQ2QsQ0FBQyxFQUFFLE1BQU0sUUFBUSxTQUFTLENBQUMsRUFBRSxNQUFNLFFBQVEsTUFBTSxrQkFBa0IsQ0FBQyxHQUFHLFdBQVcsS0FBSyxJQUFJLEVBQUUsQ0FBQztBQUFBLE1BQzlGO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRDtBQUVBLFVBQU0sU0FBUyxNQUFNLGNBQWMsTUFBTTtBQUN6QyxVQUFNLFVBQVUsT0FBTztBQUFBLE1BQ3RCLENBQUMsVUFBd0UsTUFBTSxTQUFTO0FBQUEsSUFDekY7QUFFQSxXQUFPLEdBQUcsU0FBUyxtQ0FBbUM7QUFDdEQsV0FBTyxVQUFVLFFBQVEsT0FBTyxTQUFTLENBQUMsRUFBRSxNQUFNLFFBQVEsTUFBTSxPQUFPLENBQUMsQ0FBQztBQUN6RSxXQUFPLFVBQVUsUUFBUSxPQUFPLFNBQVMsRUFBRSxRQUFRLGNBQWMsQ0FBQztBQUNsRSxXQUFPLE1BQU0sUUFBUSxTQUFTLEtBQUs7QUFBQSxFQUNwQyxDQUFDO0FBRUQsS0FBRyw2RkFBNkYsWUFBWTtBQUMzRyxVQUFNLE9BQU8sbUJBQW1CO0FBQ2hDLFVBQU0sa0JBQWdDO0FBQUEsTUFDckMsTUFBTTtBQUFBLE1BQ04sU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFRLE1BQU0sNkJBQTZCLENBQUM7QUFBQSxNQUM5RCxXQUFXLEtBQUssSUFBSTtBQUFBLElBQ3JCO0FBQ0EsVUFBTSxXQUFXLHFCQUFxQjtBQUFBLE1BQ3JDLFNBQVM7QUFBQSxRQUNSO0FBQUEsVUFDQyxNQUFNO0FBQUEsVUFDTixJQUFJO0FBQUEsVUFDSixNQUFNO0FBQUEsVUFDTixXQUFXLEVBQUUsTUFBTSxZQUFZLFNBQVMsUUFBUTtBQUFBLFFBQ2pEO0FBQUEsUUFDQTtBQUFBLFVBQ0MsTUFBTTtBQUFBLFVBQ04sSUFBSTtBQUFBLFVBQ0osTUFBTTtBQUFBLFVBQ04sV0FBVyxFQUFFLE1BQU0sWUFBWSxTQUFTLFNBQVM7QUFBQSxRQUNsRDtBQUFBLE1BQ0Q7QUFBQSxNQUNBLFlBQVk7QUFBQSxJQUNiLENBQUM7QUFDRCxVQUFNLFlBQVkscUJBQXFCO0FBQUEsTUFDdEMsU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFRLE1BQU0sZ0NBQWdDLENBQUM7QUFBQSxNQUNqRSxZQUFZO0FBQUEsSUFDYixDQUFDO0FBRUQsUUFBSSxvQkFBb0I7QUFDeEIsVUFBTSxtQkFBOEIsQ0FBQztBQUNyQyxVQUFNLFdBQVcsQ0FBQyxRQUFvQixlQUFpRDtBQUN0Rix1QkFBaUIsS0FBSyxXQUFXLFNBQVMsR0FBRyxFQUFFLENBQUM7QUFDaEQsWUFBTSxVQUFVLGlCQUFpQixXQUFXLElBQUksV0FBVztBQUMzRCxZQUFNQSxVQUFTLElBQUksNEJBQTRCO0FBQy9DLHFCQUFlLE1BQU07QUFDcEIsUUFBQUEsUUFBTyxLQUFLLEVBQUUsTUFBTSxTQUFTLFNBQVMsUUFBUSxDQUFDO0FBQy9DLFFBQUFBLFFBQU8sS0FBSyxFQUFFLE1BQU0sUUFBUSxRQUFRLENBQUM7QUFDckMsUUFBQUEsUUFBTyxJQUFJLE9BQU87QUFBQSxNQUNuQixDQUFDO0FBQ0QsYUFBT0E7QUFBQSxJQUNSO0FBRUEsVUFBTSxVQUF3QjtBQUFBLE1BQzdCLGNBQWM7QUFBQSxNQUNkLFVBQVUsQ0FBQyxFQUFFLE1BQU0sUUFBUSxTQUFTLENBQUMsRUFBRSxNQUFNLFFBQVEsTUFBTSxtQkFBbUIsQ0FBQyxHQUFHLFdBQVcsS0FBSyxJQUFJLEVBQUUsQ0FBQztBQUFBLE1BQ3pHLE9BQU8sQ0FBQyxJQUFJO0FBQUEsSUFDYjtBQUVBLFVBQU0sU0FBMEI7QUFBQSxNQUMvQixPQUFPO0FBQUEsTUFDUCxjQUFjLENBQUMsU0FBUyxLQUFLLE9BQU8sQ0FBQyxNQUFnQixFQUFFLFNBQVMsUUFBUTtBQUFBLE1BQ3hFLGVBQWU7QUFBQSxNQUNmLHFCQUFxQixZQUFZO0FBQ2hDO0FBQ0EsZUFBTyxzQkFBc0IsSUFBSSxDQUFDLGVBQWUsSUFBSSxDQUFDO0FBQUEsTUFDdkQ7QUFBQSxJQUNEO0FBRUEsVUFBTSxTQUFTO0FBQUEsTUFDZCxDQUFDLEVBQUUsTUFBTSxRQUFRLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBUSxNQUFNLG1CQUFtQixDQUFDLEdBQUcsV0FBVyxLQUFLLElBQUksRUFBRSxDQUFDO0FBQUEsTUFDL0Y7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxJQUNEO0FBRUEsVUFBTSxTQUFTLE1BQU0sY0FBYyxNQUFNO0FBQ3pDLFVBQU0sV0FBVyxPQUFPO0FBQUEsTUFDdkIsQ0FBQyxVQUF3RSxNQUFNLFNBQVM7QUFBQSxJQUN6RjtBQUNBLFVBQU0sY0FBYyxPQUFPO0FBQUEsTUFDMUIsQ0FBQyxVQUNBLE1BQU0sU0FBUyxpQkFDZixNQUFNLFFBQVEsU0FBUyxVQUN0QixNQUFNLFFBQVEsUUFBUSxDQUFDLEdBQVcsU0FBUztBQUFBLElBQzlDO0FBRUEsV0FBTyxNQUFNLFNBQVMsUUFBUSxHQUFHLGlEQUFpRDtBQUNsRixXQUFPO0FBQUEsTUFDTixTQUFTLEtBQUssQ0FBQyxVQUFVLEtBQUssVUFBVSxNQUFNLE9BQU8sT0FBTyxNQUFNLEtBQUssVUFBVSxDQUFDLEVBQUUsTUFBTSxRQUFRLE1BQU0sT0FBTyxDQUFDLENBQUMsQ0FBQztBQUFBLE1BQ2xIO0FBQUEsSUFDRDtBQUNBLFdBQU87QUFBQSxNQUNOLFNBQVM7QUFBQSxRQUNSLENBQUMsVUFDQSxLQUFLLFVBQVUsTUFBTSxPQUFPLE9BQU8sTUFDbkMsS0FBSyxVQUFVLENBQUMsRUFBRSxNQUFNLFFBQVEsTUFBTSxzQ0FBc0MsQ0FBQyxDQUFDO0FBQUEsTUFDaEY7QUFBQSxNQUNBO0FBQUEsSUFDRDtBQUNBLFdBQU8sR0FBRyxhQUFhLDBFQUEwRTtBQUNqRyxXQUFPLE1BQU8saUJBQWlCLENBQUMsR0FBVyxVQUFVLENBQUMsR0FBRyxNQUFNLDRCQUE0QjtBQUFBLEVBQzVGLENBQUM7QUFFRCxLQUFHLHVFQUF1RSxZQUFZO0FBQ3JGLFVBQU0sY0FBYyxxQkFBcUI7QUFBQSxNQUN4QyxTQUFTLENBQUMsRUFBRSxNQUFNLFFBQVEsTUFBTSxnQkFBZ0IsQ0FBQztBQUFBLE1BQ2pELFlBQVk7QUFBQSxJQUNiLENBQUM7QUFDRCxVQUFNLGVBQWUscUJBQXFCO0FBQUEsTUFDekMsU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFRLE1BQU0sb0JBQW9CLENBQUM7QUFBQSxNQUNyRCxZQUFZO0FBQUEsSUFDYixDQUFDO0FBQ0QsVUFBTSxrQkFBZ0M7QUFBQSxNQUNyQyxNQUFNO0FBQUEsTUFDTixTQUFTLENBQUMsRUFBRSxNQUFNLFFBQVEsTUFBTSxrQkFBa0IsQ0FBQztBQUFBLE1BQ25ELFdBQVcsS0FBSyxJQUFJO0FBQUEsSUFDckI7QUFFQSxRQUFJLG9CQUFvQjtBQUN4QixVQUFNLG1CQUE4QixDQUFDO0FBQ3JDLFVBQU0sV0FBVyxDQUFDLFFBQW9CLGVBQWlEO0FBQ3RGLHVCQUFpQixLQUFLLFdBQVcsU0FBUyxHQUFHLEVBQUUsQ0FBQztBQUNoRCxZQUFNLFVBQVUsaUJBQWlCLFdBQVcsSUFBSSxjQUFjO0FBQzlELFlBQU1BLFVBQVMsSUFBSSw0QkFBNEI7QUFDL0MscUJBQWUsTUFBTTtBQUNwQixRQUFBQSxRQUFPLEtBQUssRUFBRSxNQUFNLFNBQVMsU0FBUyxRQUFRLENBQUM7QUFDL0MsUUFBQUEsUUFBTyxLQUFLLEVBQUUsTUFBTSxRQUFRLFFBQVEsQ0FBQztBQUNyQyxRQUFBQSxRQUFPLElBQUksT0FBTztBQUFBLE1BQ25CLENBQUM7QUFDRCxhQUFPQTtBQUFBLElBQ1I7QUFFQSxVQUFNLFVBQXdCO0FBQUEsTUFDN0IsY0FBYztBQUFBLE1BQ2QsVUFBVSxDQUFDLEVBQUUsTUFBTSxRQUFRLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBUSxNQUFNLGlCQUFpQixDQUFDLEdBQUcsV0FBVyxLQUFLLElBQUksRUFBRSxDQUFDO0FBQUEsTUFDdkcsT0FBTyxDQUFDO0FBQUEsSUFDVDtBQUVBLFVBQU0sU0FBMEI7QUFBQSxNQUMvQixPQUFPO0FBQUEsTUFDUCxjQUFjLENBQUMsU0FBUyxLQUFLLE9BQU8sQ0FBQyxNQUFnQixFQUFFLFNBQVMsUUFBUTtBQUFBLE1BQ3hFLGVBQWU7QUFBQSxNQUNmLHFCQUFxQixZQUFZO0FBQ2hDO0FBQ0EsZUFBTyxzQkFBc0IsSUFBSSxDQUFDLGVBQWUsSUFBSSxDQUFDO0FBQUEsTUFDdkQ7QUFBQSxJQUNEO0FBRUEsVUFBTSxTQUFTO0FBQUEsTUFDZCxDQUFDLEVBQUUsTUFBTSxRQUFRLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBUSxNQUFNLGlCQUFpQixDQUFDLEdBQUcsV0FBVyxLQUFLLElBQUksRUFBRSxDQUFDO0FBQUEsTUFDN0Y7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxJQUNEO0FBRUEsVUFBTSxTQUFTLE1BQU0sY0FBYyxNQUFNO0FBQ3pDLFVBQU0sZ0JBQWdCLE9BQU87QUFBQSxNQUM1QixDQUFDLFVBQ0EsTUFBTSxTQUFTLGlCQUFpQixNQUFNLFFBQVEsU0FBUztBQUFBLElBQ3pEO0FBQ0EsVUFBTSxjQUFjLE9BQU87QUFBQSxNQUMxQixDQUFDLFVBQ0EsTUFBTSxTQUFTLGlCQUNmLE1BQU0sUUFBUSxTQUFTLFVBQ3RCLE1BQU0sUUFBUSxRQUFRLENBQUMsR0FBVyxTQUFTO0FBQUEsSUFDOUM7QUFFQSxXQUFPLE1BQU0sY0FBYyxRQUFRLEdBQUcsMkRBQTJEO0FBQ2pHLFdBQU8sR0FBRyxhQUFhLHlFQUF5RTtBQUNoRyxXQUFPLE1BQU8saUJBQWlCLENBQUMsR0FBVyxVQUFVLENBQUMsR0FBRyxNQUFNLGlCQUFpQjtBQUFBLEVBQ2pGLENBQUM7QUFDRixDQUFDO0FBbUJELE1BQU0sYUFBMEM7QUFBQSxFQUMvQyxJQUFJO0FBQUEsRUFDSixNQUFNO0FBQUEsRUFDTixLQUFLO0FBQUEsRUFDTCxVQUFVO0FBQUEsRUFDVixlQUFlO0FBQUEsRUFDZixXQUFXO0FBQUEsRUFDWCxnQkFBZ0I7QUFBQSxFQUNoQixxQkFBcUI7QUFBQSxFQUNyQixlQUFlO0FBQ2hCO0FBRUEsU0FBUyxxQkFBcUM7QUFDN0MsU0FBTztBQUFBLElBQ04sTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsYUFBYTtBQUFBLElBQ2IsWUFBWSxLQUFLLE9BQU87QUFBQSxNQUN2QixNQUFNLEtBQUssT0FBTztBQUFBLE1BQ2xCLFNBQVMsS0FBSyxPQUFPO0FBQUEsSUFDdEIsQ0FBQztBQUFBLElBQ0QsU0FBUyxhQUFhO0FBQUEsTUFDckIsU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFpQixNQUFNLE9BQU8sQ0FBQztBQUFBLE1BQ2pELFNBQVMsQ0FBQztBQUFBLElBQ1g7QUFBQSxFQUNEO0FBQ0Q7QUFPQSxTQUFTLG1CQUFtQixXQUErQjtBQUMxRCxNQUFJLFlBQVk7QUFFaEIsU0FBTyxTQUFTLGVBQTRDO0FBQzNELFVBQU0sVUFBVSxVQUFVLFNBQVMsS0FBSyxVQUFVLFVBQVUsU0FBUyxDQUFDO0FBQ3RFO0FBRUEsVUFBTSxTQUFTLElBQUksNEJBQTRCO0FBRS9DLG1CQUFlLE1BQU07QUFDcEIsYUFBTyxLQUFLLEVBQUUsTUFBTSxTQUFTLFNBQVMsUUFBUSxDQUFDO0FBQy9DLGFBQU8sS0FBSyxFQUFFLE1BQU0sUUFBUSxRQUFRLENBQUM7QUFDckMsYUFBTyxJQUFJLE9BQU87QUFBQSxJQUNuQixDQUFDO0FBQ0QsV0FBTztBQUFBLEVBQ1I7QUFDRDtBQUVBLFNBQVMscUJBQXFCLFlBQXVDLENBQUMsR0FBcUI7QUFDMUYsU0FBTztBQUFBLElBQ04sTUFBTTtBQUFBLElBQ04sU0FBUyxDQUFDO0FBQUEsSUFDVixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixPQUFPO0FBQUEsSUFDUCxPQUFPLEVBQUUsT0FBTyxLQUFLLFFBQVEsSUFBSSxXQUFXLEdBQUcsWUFBWSxHQUFHLGFBQWEsS0FBSyxNQUFNLEVBQUUsT0FBTyxHQUFHLFFBQVEsR0FBRyxXQUFXLEdBQUcsWUFBWSxHQUFHLE9BQU8sRUFBRSxFQUFFO0FBQUEsSUFDckosWUFBWTtBQUFBLElBQ1osV0FBVyxLQUFLLElBQUk7QUFBQSxJQUNwQixHQUFHO0FBQUEsRUFDSjtBQUNEO0FBRUEsU0FBUyxvQkFBb0IsY0FBeUQ7QUFDckYsU0FBTyxxQkFBcUI7QUFBQSxJQUMzQixTQUFTO0FBQUEsTUFDUjtBQUFBLFFBQ0MsTUFBTTtBQUFBLFFBQ04sSUFBSSxNQUFNLEtBQUssSUFBSSxDQUFDLElBQUksS0FBSyxPQUFPLENBQUM7QUFBQSxRQUNyQyxNQUFNO0FBQUEsUUFDTixXQUFXO0FBQUEsTUFDWjtBQUFBLElBQ0Q7QUFBQSxJQUNBLFlBQVk7QUFBQSxFQUNiLENBQUM7QUFDRjtBQUVBLFNBQVMsY0FBYyxRQUF3RTtBQUM5RixTQUFPLElBQUksUUFBUSxPQUFPLFlBQVk7QUFDckMsVUFBTSxTQUF1QixDQUFDO0FBQzlCLHFCQUFpQixTQUFTLFFBQVE7QUFDakMsYUFBTyxLQUFLLEtBQUs7QUFBQSxJQUNsQjtBQUNBLFlBQVEsTUFBTTtBQUFBLEVBQ2YsQ0FBQztBQUNGO0FBSUEsU0FBUyx1REFBa0QsTUFBTTtBQUVoRSxLQUFHLG9GQUFvRixZQUFZO0FBQ2xHLFVBQU0sT0FBTyxtQkFBbUI7QUFHaEMsVUFBTSxjQUFjLG9CQUFvQixFQUFFLE1BQU0sWUFBWSxDQUFDO0FBQzdELFVBQU0sWUFBWSxxQkFBcUIsRUFBRSxTQUFTLENBQUMsRUFBRSxNQUFNLFFBQVEsTUFBTSxhQUFhLENBQUMsR0FBRyxZQUFZLE9BQU8sQ0FBQztBQUc5RyxVQUFNLFlBQWdDLENBQUM7QUFDdkMsYUFBUyxJQUFJLEdBQUcsSUFBSSxzQ0FBc0MsR0FBRyxLQUFLO0FBQ2pFLGdCQUFVLEtBQUssV0FBVztBQUFBLElBQzNCO0FBQ0EsY0FBVSxLQUFLLFNBQVM7QUFFeEIsVUFBTSxhQUFhLG1CQUFtQixTQUFTO0FBRS9DLFVBQU0sVUFBd0I7QUFBQSxNQUM3QixjQUFjO0FBQUEsTUFDZCxVQUFVLENBQUMsRUFBRSxNQUFNLFFBQVEsU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFRLE1BQU0sZUFBZSxDQUFDLEdBQUcsV0FBVyxLQUFLLElBQUksRUFBRSxDQUFDO0FBQUEsTUFDckcsT0FBTyxDQUFDLElBQUk7QUFBQSxJQUNiO0FBRUEsVUFBTSxTQUEwQjtBQUFBLE1BQy9CLE9BQU87QUFBQSxNQUNQLGNBQWMsQ0FBQyxTQUFTLEtBQUssT0FBTyxDQUFDLE1BQWdCLEVBQUUsU0FBUyxRQUFRO0FBQUEsTUFDeEUsZUFBZTtBQUFBLElBQ2hCO0FBRUEsVUFBTSxTQUFTO0FBQUEsTUFDZCxDQUFDLEVBQUUsTUFBTSxRQUFRLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBUSxNQUFNLGVBQWUsQ0FBQyxHQUFHLFdBQVcsS0FBSyxJQUFJLEVBQUUsQ0FBQztBQUFBLE1BQzNGO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRDtBQUVBLFVBQU0sU0FBUyxNQUFNLGNBQWMsTUFBTTtBQUd6QyxVQUFNLFdBQVcsT0FBTyxLQUFLLENBQUMsTUFBTSxFQUFFLFNBQVMsV0FBVztBQUMxRCxXQUFPLEdBQUcsVUFBVSx3REFBd0Q7QUFHNUUsVUFBTSxhQUFhLE9BQU87QUFBQSxNQUN6QixDQUFDLE1BQU0sRUFBRSxTQUFTLHdCQUF3QixFQUFFLFlBQVk7QUFBQSxJQUN6RDtBQUdBLFdBQU87QUFBQSxNQUNOLFdBQVcsVUFBVTtBQUFBLE1BQ3JCLG9CQUFvQixtQ0FBbUMsdUNBQXVDLFdBQVcsTUFBTTtBQUFBLElBQ2hIO0FBQUEsRUFDRCxDQUFDO0FBRUQsS0FBRyx3REFBd0QsWUFBWTtBQUN0RSxVQUFNLE9BQU8sbUJBQW1CO0FBR2hDLFVBQU0sVUFBVSxvQkFBb0IsRUFBRSxNQUFNLFlBQVksQ0FBQztBQUN6RCxVQUFNLFdBQVcsb0JBQW9CLEVBQUUsTUFBTSxhQUFhLFNBQVMsUUFBUSxDQUFDO0FBQzVFLFVBQU0sWUFBWSxxQkFBcUIsRUFBRSxTQUFTLENBQUMsRUFBRSxNQUFNLFFBQVEsTUFBTSxRQUFRLENBQUMsR0FBRyxZQUFZLE9BQU8sQ0FBQztBQUV6RyxVQUFNLFlBQVksQ0FBQyxTQUFTLFNBQVMsVUFBVSxTQUFTLFNBQVMsVUFBVSxTQUFTO0FBQ3BGLFVBQU0sYUFBYSxtQkFBbUIsU0FBUztBQUUvQyxVQUFNLFVBQXdCO0FBQUEsTUFDN0IsY0FBYztBQUFBLE1BQ2QsVUFBVSxDQUFDLEVBQUUsTUFBTSxRQUFRLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBUSxNQUFNLGVBQWUsQ0FBQyxHQUFHLFdBQVcsS0FBSyxJQUFJLEVBQUUsQ0FBQztBQUFBLE1BQ3JHLE9BQU8sQ0FBQyxJQUFJO0FBQUEsSUFDYjtBQUVBLFVBQU0sU0FBMEI7QUFBQSxNQUMvQixPQUFPO0FBQUEsTUFDUCxjQUFjLENBQUMsU0FBUyxLQUFLLE9BQU8sQ0FBQyxNQUFnQixFQUFFLFNBQVMsUUFBUTtBQUFBLE1BQ3hFLGVBQWU7QUFBQSxJQUNoQjtBQUVBLFVBQU0sU0FBUztBQUFBLE1BQ2QsQ0FBQyxFQUFFLE1BQU0sUUFBUSxTQUFTLENBQUMsRUFBRSxNQUFNLFFBQVEsTUFBTSxlQUFlLENBQUMsR0FBRyxXQUFXLEtBQUssSUFBSSxFQUFFLENBQUM7QUFBQSxNQUMzRjtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLElBQ0Q7QUFFQSxVQUFNLFNBQVMsTUFBTSxjQUFjLE1BQU07QUFHekMsVUFBTSxXQUFXLE9BQU8sS0FBSyxDQUFDLE1BQU0sRUFBRSxTQUFTLFdBQVc7QUFDMUQsV0FBTyxHQUFHLFVBQVUsaUZBQWlGO0FBR3JHLFVBQU0sZUFBZSxPQUFPLE9BQU8sQ0FBQyxNQUFNLEVBQUUsU0FBUyxvQkFBb0I7QUFDekUsV0FBTyxHQUFHLGFBQWEsVUFBVSxHQUFHLDhFQUE4RSxhQUFhLE1BQU0sRUFBRTtBQUFBLEVBQ3hJLENBQUM7QUFFRCxLQUFHLDBFQUEwRSxNQUFNO0FBQ2xGLFdBQU8sTUFBTSxPQUFPLHFDQUFxQyxRQUFRO0FBQ2pFLFdBQU8sR0FBRyx1Q0FBdUMsR0FBRywyQ0FBMkM7QUFDL0YsV0FBTyxHQUFHLHVDQUF1QyxJQUFJLG1DQUFtQztBQUFBLEVBQ3pGLENBQUM7QUFFRCxLQUFHLDRGQUE0RixZQUFZO0FBTTFHLFVBQU0sV0FBMkI7QUFBQSxNQUNoQyxNQUFNO0FBQUEsTUFDTixPQUFPO0FBQUEsTUFDUCxhQUFhO0FBQUEsTUFDYixZQUFZLEtBQUssT0FBTztBQUFBLFFBQ3ZCLFNBQVMsS0FBSyxPQUFPO0FBQUEsTUFDdEIsQ0FBQztBQUFBLE1BQ0QsU0FBUyxZQUFZO0FBRXBCLGNBQU0sSUFBSSxNQUFNLDJDQUEyQztBQUFBLE1BQzVEO0FBQUEsSUFDRDtBQUdBLFVBQU0sZ0JBQWdCLHFCQUFxQjtBQUFBLE1BQzFDLFNBQVM7QUFBQSxRQUNSO0FBQUEsVUFDQyxNQUFNO0FBQUEsVUFDTixJQUFJLFdBQVcsS0FBSyxJQUFJLENBQUMsSUFBSSxLQUFLLE9BQU8sQ0FBQztBQUFBLFVBQzFDLE1BQU07QUFBQSxVQUNOLFdBQVcsRUFBRSxTQUFTLDJCQUEyQjtBQUFBLFFBQ2xEO0FBQUEsTUFDRDtBQUFBLE1BQ0EsWUFBWTtBQUFBLElBQ2IsQ0FBQztBQUNELFVBQU0sWUFBWSxxQkFBcUI7QUFBQSxNQUN0QyxTQUFTLENBQUMsRUFBRSxNQUFNLFFBQVEsTUFBTSx1QkFBdUIsQ0FBQztBQUFBLE1BQ3hELFlBQVk7QUFBQSxJQUNiLENBQUM7QUFHRCxVQUFNLFlBQWdDLENBQUM7QUFDdkMsYUFBUyxJQUFJLEdBQUcsSUFBSSxzQ0FBc0MsR0FBRyxLQUFLO0FBQ2pFLGdCQUFVLEtBQUssYUFBYTtBQUFBLElBQzdCO0FBQ0EsY0FBVSxLQUFLLFNBQVM7QUFFeEIsVUFBTSxhQUFhLG1CQUFtQixTQUFTO0FBRS9DLFVBQU0sVUFBd0I7QUFBQSxNQUM3QixjQUFjO0FBQUEsTUFDZCxVQUFVLENBQUMsRUFBRSxNQUFNLFFBQVEsU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFRLE1BQU0sd0JBQXdCLENBQUMsR0FBRyxXQUFXLEtBQUssSUFBSSxFQUFFLENBQUM7QUFBQSxNQUM5RyxPQUFPLENBQUMsUUFBUTtBQUFBLElBQ2pCO0FBRUEsVUFBTSxTQUEwQjtBQUFBLE1BQy9CLE9BQU87QUFBQSxNQUNQLGNBQWMsQ0FBQyxTQUFTLEtBQUssT0FBTyxDQUFDLE1BQWdCLEVBQUUsU0FBUyxRQUFRO0FBQUEsTUFDeEUsZUFBZTtBQUFBLElBQ2hCO0FBRUEsVUFBTSxTQUFTO0FBQUEsTUFDZCxDQUFDLEVBQUUsTUFBTSxRQUFRLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBUSxNQUFNLHdCQUF3QixDQUFDLEdBQUcsV0FBVyxLQUFLLElBQUksRUFBRSxDQUFDO0FBQUEsTUFDcEc7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxJQUNEO0FBRUEsVUFBTSxTQUFTLE1BQU0sY0FBYyxNQUFNO0FBR3pDLFVBQU0sV0FBVyxPQUFPLEtBQUssQ0FBQyxNQUFNLEVBQUUsU0FBUyxXQUFXO0FBQzFELFdBQU8sR0FBRyxVQUFVLGdDQUFnQztBQUdwRCxVQUFNLGFBQWEsT0FBTztBQUFBLE1BQ3pCLENBQUMsTUFBTSxFQUFFLFNBQVMsd0JBQXdCLEVBQUUsWUFBWTtBQUFBLElBQ3pEO0FBR0EsV0FBTztBQUFBLE1BQ04sV0FBVyxVQUFVLHNDQUFzQztBQUFBLE1BQzNELGdCQUFnQixzQ0FBc0MsQ0FBQyw0REFBNEQsV0FBVyxNQUFNO0FBQUEsSUFDckk7QUFHQSxVQUFNLGNBQWUsU0FBaUI7QUFDdEMsVUFBTSxjQUFjLFlBQVksWUFBWSxTQUFTLENBQUM7QUFDdEQsVUFBTSxXQUFXLFlBQVksU0FBUyxjQUNsQyxZQUFpQyxRQUFRLEtBQUssQ0FBQyxNQUFNLEVBQUUsU0FBUyxNQUFNLElBQ3ZFO0FBQ0gsUUFBSSxZQUFZLFNBQVMsU0FBUyxRQUFRO0FBQ3pDLGFBQU87QUFBQSxRQUNOLENBQUMsU0FBUyxLQUFLLFNBQVMsK0NBQStDO0FBQUEsUUFDdkU7QUFBQSxNQUNEO0FBQUEsSUFDRDtBQUFBLEVBQ0QsQ0FBQztBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbInN0cmVhbSJdCn0K
