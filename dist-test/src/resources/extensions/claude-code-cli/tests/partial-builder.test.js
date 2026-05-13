import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mapContentBlock, mapUsage, parseMcpToolName, PartialMessageBuilder } from "../partial-builder.js";
describe("mapUsage", () => {
  test("excludes cumulative cache reads from context-sized totalTokens (#5243)", () => {
    const usage = {
      input_tokens: 15e4,
      output_tokens: 2e3,
      cache_read_input_tokens: 9e5,
      cache_creation_input_tokens: 3e3
    };
    const mapped = mapUsage(usage, 1.23);
    assert.equal(mapped.cacheRead, 9e5);
    assert.equal(mapped.totalTokens, 155e3);
    assert.equal(mapped.cost.total, 1.23);
  });
});
describe("PartialMessageBuilder \u2014 malformed tool arguments (#2574)", () => {
  function feedToolCall(builder, jsonFragments) {
    builder.handleEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "tool_1", name: "gsd_plan_slice", input: {} }
    });
    for (const fragment of jsonFragments) {
      builder.handleEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: fragment }
      });
    }
    return builder.handleEvent({
      type: "content_block_stop",
      index: 0
    });
  }
  test("valid JSON \u2192 toolcall_end without malformedArguments", () => {
    const builder = new PartialMessageBuilder("claude-sonnet-4-20250514");
    const event = feedToolCall(builder, ['{"milestone', 'Id": "M001"}']);
    assert.ok(event, "event should not be null");
    assert.equal(event.type, "toolcall_end");
    assert.equal(
      event.malformedArguments,
      void 0,
      "valid JSON should not set malformedArguments"
    );
    if (event.type === "toolcall_end") {
      assert.deepEqual(event.toolCall.arguments, { milestoneId: "M001" });
    }
  });
  test("truncated JSON \u2192 toolcall_end WITH malformedArguments: true", () => {
    const builder = new PartialMessageBuilder("claude-sonnet-4-20250514");
    const event = feedToolCall(builder, ['{"milestone', 'Id": "M00']);
    assert.ok(event, "event should not be null");
    assert.equal(event.type, "toolcall_end");
    assert.equal(
      event.malformedArguments,
      true,
      "truncated JSON should set malformedArguments: true"
    );
    if (event.type === "toolcall_end") {
      assert.equal(
        event.toolCall.arguments._raw,
        '{"milestoneId": "M00',
        "_raw should contain the truncated JSON string"
      );
    }
  });
  test("no JSON deltas \u2192 malformedArguments: true (empty accumulator is not valid JSON)", () => {
    const builder = new PartialMessageBuilder("claude-sonnet-4-20250514");
    const event = feedToolCall(builder, []);
    assert.ok(event, "event should not be null");
    assert.equal(event.type, "toolcall_end");
    assert.equal(
      event.malformedArguments,
      true,
      "empty accumulator (no JSON deltas) is not valid JSON \u2192 malformed"
    );
  });
  test("garbage input (non-JSON) \u2192 malformedArguments: true", () => {
    const builder = new PartialMessageBuilder("claude-sonnet-4-20250514");
    const event = feedToolCall(builder, ["not json at all <html>"]);
    assert.ok(event, "event should not be null");
    assert.equal(event.type, "toolcall_end");
    assert.equal(
      event.malformedArguments,
      true,
      "non-JSON content should set malformedArguments: true"
    );
  });
  test("YAML bullet lists repaired to JSON arrays (#2660)", () => {
    const builder = new PartialMessageBuilder("claude-sonnet-4-20250514");
    const malformedJson = '{"milestoneId": "M005", "keyDecisions": - Used Web Notification API, "keyFiles": - src/lib.rs, "title": "done"}';
    const event = feedToolCall(builder, [malformedJson]);
    assert.ok(event, "event should not be null");
    assert.equal(event.type, "toolcall_end");
    assert.equal(
      event.malformedArguments,
      void 0,
      "repaired YAML bullets should not set malformedArguments"
    );
    if (event.type === "toolcall_end") {
      assert.equal(event.toolCall.arguments.milestoneId, "M005");
      assert.ok(
        Array.isArray(event.toolCall.arguments.keyDecisions),
        "keyDecisions should be repaired to an array"
      );
      assert.ok(
        Array.isArray(event.toolCall.arguments.keyFiles),
        "keyFiles should be repaired to an array"
      );
      assert.equal(event.toolCall.arguments.title, "done");
    }
  });
  test("XML parameter tags trapped inside valid JSON strings are promoted (#3751)", () => {
    const builder = new PartialMessageBuilder("claude-sonnet-4-20250514");
    const malformedJson = '{"narrative":"text.</narrative>\\n<parameter name=\\"verification\\">all tests pass</parameter>\\n<parameter name=\\"verificationEvidence\\">[\\"npm test\\"]</parameter>","oneLiner":"done"}';
    const event = feedToolCall(builder, [malformedJson]);
    assert.ok(event, "event should not be null");
    assert.equal(event.type, "toolcall_end");
    assert.equal(event.malformedArguments, void 0);
    if (event.type === "toolcall_end") {
      assert.equal(event.toolCall.arguments.narrative, "text.");
      assert.equal(event.toolCall.arguments.verification, "all tests pass");
      assert.deepEqual(event.toolCall.arguments.verificationEvidence, ["npm test"]);
      assert.equal(event.toolCall.arguments.oneLiner, "done");
    }
  });
});
describe("parseMcpToolName", () => {
  test("splits mcp__<server>__<tool> into parts", () => {
    assert.deepEqual(
      parseMcpToolName("mcp__gsd-workflow__gsd_plan_milestone"),
      { server: "gsd-workflow", tool: "gsd_plan_milestone" }
    );
  });
  test("preserves server names containing hyphens", () => {
    assert.deepEqual(
      parseMcpToolName("mcp__my-cool-server__do_thing"),
      { server: "my-cool-server", tool: "do_thing" }
    );
  });
  test("preserves tool names containing underscores", () => {
    assert.deepEqual(
      parseMcpToolName("mcp__srv__a_b_c_d"),
      { server: "srv", tool: "a_b_c_d" }
    );
  });
  test("returns null for non-prefixed names", () => {
    assert.equal(parseMcpToolName("Bash"), null);
    assert.equal(parseMcpToolName("gsd_plan_milestone"), null);
  });
  test("returns null for malformed prefixes", () => {
    assert.equal(parseMcpToolName("mcp__"), null);
    assert.equal(parseMcpToolName("mcp__server"), null);
    assert.equal(parseMcpToolName("mcp__server__"), null);
    assert.equal(parseMcpToolName("mcp____tool"), null);
  });
});
describe("PartialMessageBuilder \u2014 MCP tool name normalization", () => {
  test("strips mcp__<server>__ prefix on content_block_start", () => {
    const builder = new PartialMessageBuilder("claude-sonnet-4-20250514");
    const event = builder.handleEvent({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "tool_1",
        name: "mcp__gsd-workflow__gsd_plan_milestone",
        input: {}
      }
    });
    assert.ok(event, "event should not be null");
    assert.equal(event.type, "toolcall_start");
    if (event.type === "toolcall_start") {
      const toolCall = event.partial.content[event.contentIndex];
      assert.equal(toolCall.name, "gsd_plan_milestone");
      assert.equal(toolCall.mcpServer, "gsd-workflow");
    }
  });
  test("leaves non-MCP tool names untouched", () => {
    const builder = new PartialMessageBuilder("claude-sonnet-4-20250514");
    const event = builder.handleEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "tool_1", name: "Bash", input: {} }
    });
    assert.ok(event);
    if (event.type === "toolcall_start") {
      const toolCall = event.partial.content[event.contentIndex];
      assert.equal(toolCall.name, "Bash");
      assert.equal(toolCall.mcpServer, void 0);
    }
  });
  test("mapContentBlock strips MCP prefix on full tool_use blocks", () => {
    const block = {
      type: "tool_use",
      id: "tool_2",
      name: "mcp__gsd-workflow__gsd_task_complete",
      input: { taskId: "T001" }
    };
    const mapped = mapContentBlock(block);
    assert.equal(mapped.type, "toolCall");
    assert.equal(mapped.name, "gsd_task_complete");
    assert.equal(mapped.mcpServer, "gsd-workflow");
    assert.deepEqual(mapped.arguments, { taskId: "T001" });
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2NsYXVkZS1jb2RlLWNsaS90ZXN0cy9wYXJ0aWFsLWJ1aWxkZXIudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1hcENvbnRlbnRCbG9jaywgbWFwVXNhZ2UsIHBhcnNlTWNwVG9vbE5hbWUsIFBhcnRpYWxNZXNzYWdlQnVpbGRlciB9IGZyb20gXCIuLi9wYXJ0aWFsLWJ1aWxkZXIudHNcIjtcbmltcG9ydCB0eXBlIHsgQmV0YUNvbnRlbnRCbG9jaywgQmV0YVJhd01lc3NhZ2VTdHJlYW1FdmVudCwgTm9uTnVsbGFibGVVc2FnZSB9IGZyb20gXCIuLi9zZGstdHlwZXMudHNcIjtcblxuZGVzY3JpYmUoXCJtYXBVc2FnZVwiLCAoKSA9PiB7XG5cdHRlc3QoXCJleGNsdWRlcyBjdW11bGF0aXZlIGNhY2hlIHJlYWRzIGZyb20gY29udGV4dC1zaXplZCB0b3RhbFRva2VucyAoIzUyNDMpXCIsICgpID0+IHtcblx0XHRjb25zdCB1c2FnZTogTm9uTnVsbGFibGVVc2FnZSA9IHtcblx0XHRcdGlucHV0X3Rva2VuczogMTUwXzAwMCxcblx0XHRcdG91dHB1dF90b2tlbnM6IDJfMDAwLFxuXHRcdFx0Y2FjaGVfcmVhZF9pbnB1dF90b2tlbnM6IDkwMF8wMDAsXG5cdFx0XHRjYWNoZV9jcmVhdGlvbl9pbnB1dF90b2tlbnM6IDNfMDAwLFxuXHRcdH07XG5cblx0XHRjb25zdCBtYXBwZWQgPSBtYXBVc2FnZSh1c2FnZSwgMS4yMyk7XG5cblx0XHRhc3NlcnQuZXF1YWwobWFwcGVkLmNhY2hlUmVhZCwgOTAwXzAwMCk7XG5cdFx0YXNzZXJ0LmVxdWFsKG1hcHBlZC50b3RhbFRva2VucywgMTU1XzAwMCk7XG5cdFx0YXNzZXJ0LmVxdWFsKG1hcHBlZC5jb3N0LnRvdGFsLCAxLjIzKTtcblx0fSk7XG59KTtcblxuZGVzY3JpYmUoXCJQYXJ0aWFsTWVzc2FnZUJ1aWxkZXIgXHUyMDE0IG1hbGZvcm1lZCB0b29sIGFyZ3VtZW50cyAoIzI1NzQpXCIsICgpID0+IHtcblx0LyoqXG5cdCAqIEhlbHBlcjogZmVlZCBhIHRvb2xfdXNlIGJsb2NrIHRocm91Z2ggdGhlIGJ1aWxkZXIgbGlmZWN5Y2xlIGFuZCByZXR1cm5cblx0ICogdGhlIHRvb2xjYWxsX2VuZCBldmVudC4gU2ltdWxhdGVzOiBjb250ZW50X2Jsb2NrX3N0YXJ0IFx1MjE5MiBOIGRlbHRhcyBcdTIxOTIgY29udGVudF9ibG9ja19zdG9wLlxuXHQgKi9cblx0ZnVuY3Rpb24gZmVlZFRvb2xDYWxsKFxuXHRcdGJ1aWxkZXI6IFBhcnRpYWxNZXNzYWdlQnVpbGRlcixcblx0XHRqc29uRnJhZ21lbnRzOiBzdHJpbmdbXSxcblx0KSB7XG5cdFx0Ly8gU3RhcnQgdGhlIHRvb2xfdXNlIGJsb2NrIGF0IHN0cmVhbSBpbmRleCAwXG5cdFx0YnVpbGRlci5oYW5kbGVFdmVudCh7XG5cdFx0XHR0eXBlOiBcImNvbnRlbnRfYmxvY2tfc3RhcnRcIixcblx0XHRcdGluZGV4OiAwLFxuXHRcdFx0Y29udGVudF9ibG9jazogeyB0eXBlOiBcInRvb2xfdXNlXCIsIGlkOiBcInRvb2xfMVwiLCBuYW1lOiBcImdzZF9wbGFuX3NsaWNlXCIsIGlucHV0OiB7fSB9LFxuXHRcdH0gYXMgQmV0YVJhd01lc3NhZ2VTdHJlYW1FdmVudCk7XG5cblx0XHQvLyBGZWVkIEpTT04gZnJhZ21lbnRzIGFzIGlucHV0X2pzb25fZGVsdGFcblx0XHRmb3IgKGNvbnN0IGZyYWdtZW50IG9mIGpzb25GcmFnbWVudHMpIHtcblx0XHRcdGJ1aWxkZXIuaGFuZGxlRXZlbnQoe1xuXHRcdFx0XHR0eXBlOiBcImNvbnRlbnRfYmxvY2tfZGVsdGFcIixcblx0XHRcdFx0aW5kZXg6IDAsXG5cdFx0XHRcdGRlbHRhOiB7IHR5cGU6IFwiaW5wdXRfanNvbl9kZWx0YVwiLCBwYXJ0aWFsX2pzb246IGZyYWdtZW50IH0sXG5cdFx0XHR9IGFzIEJldGFSYXdNZXNzYWdlU3RyZWFtRXZlbnQpO1xuXHRcdH1cblxuXHRcdC8vIFN0b3AgdGhlIGJsb2NrIFx1MjAxNCB0aGlzIGlzIHdoZXJlIEpTT04gcGFyc2UgaGFwcGVuc1xuXHRcdHJldHVybiBidWlsZGVyLmhhbmRsZUV2ZW50KHtcblx0XHRcdHR5cGU6IFwiY29udGVudF9ibG9ja19zdG9wXCIsXG5cdFx0XHRpbmRleDogMCxcblx0XHR9IGFzIEJldGFSYXdNZXNzYWdlU3RyZWFtRXZlbnQpO1xuXHR9XG5cblx0dGVzdChcInZhbGlkIEpTT04gXHUyMTkyIHRvb2xjYWxsX2VuZCB3aXRob3V0IG1hbGZvcm1lZEFyZ3VtZW50c1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgYnVpbGRlciA9IG5ldyBQYXJ0aWFsTWVzc2FnZUJ1aWxkZXIoXCJjbGF1ZGUtc29ubmV0LTQtMjAyNTA1MTRcIik7XG5cdFx0Y29uc3QgZXZlbnQgPSBmZWVkVG9vbENhbGwoYnVpbGRlciwgWyd7XCJtaWxlc3RvbmUnLCAnSWRcIjogXCJNMDAxXCJ9J10pO1xuXG5cdFx0YXNzZXJ0Lm9rKGV2ZW50LCBcImV2ZW50IHNob3VsZCBub3QgYmUgbnVsbFwiKTtcblx0XHRhc3NlcnQuZXF1YWwoZXZlbnQhLnR5cGUsIFwidG9vbGNhbGxfZW5kXCIpO1xuXHRcdC8vIFZhbGlkIEpTT04gc2hvdWxkIE5PVCBoYXZlIHRoZSBtYWxmb3JtZWRBcmd1bWVudHMgZmxhZ1xuXHRcdGFzc2VydC5lcXVhbChcblx0XHRcdChldmVudCBhcyBhbnkpLm1hbGZvcm1lZEFyZ3VtZW50cyxcblx0XHRcdHVuZGVmaW5lZCxcblx0XHRcdFwidmFsaWQgSlNPTiBzaG91bGQgbm90IHNldCBtYWxmb3JtZWRBcmd1bWVudHNcIixcblx0XHQpO1xuXHRcdC8vIEFyZ3VtZW50cyBzaG91bGQgYmUgcGFyc2VkIGNvcnJlY3RseVxuXHRcdGlmIChldmVudCEudHlwZSA9PT0gXCJ0b29sY2FsbF9lbmRcIikge1xuXHRcdFx0YXNzZXJ0LmRlZXBFcXVhbChldmVudCEudG9vbENhbGwuYXJndW1lbnRzLCB7IG1pbGVzdG9uZUlkOiBcIk0wMDFcIiB9KTtcblx0XHR9XG5cdH0pO1xuXG5cdHRlc3QoXCJ0cnVuY2F0ZWQgSlNPTiBcdTIxOTIgdG9vbGNhbGxfZW5kIFdJVEggbWFsZm9ybWVkQXJndW1lbnRzOiB0cnVlXCIsICgpID0+IHtcblx0XHRjb25zdCBidWlsZGVyID0gbmV3IFBhcnRpYWxNZXNzYWdlQnVpbGRlcihcImNsYXVkZS1zb25uZXQtNC0yMDI1MDUxNFwiKTtcblx0XHQvLyBTaW11bGF0ZSBhIHN0cmVhbSB0cnVuY2F0aW9uOiBKU09OIGlzIGN1dCBvZmYgbWlkLXZhbHVlXG5cdFx0Y29uc3QgZXZlbnQgPSBmZWVkVG9vbENhbGwoYnVpbGRlciwgWyd7XCJtaWxlc3RvbmUnLCAnSWRcIjogXCJNMDAnXSk7XG5cblx0XHRhc3NlcnQub2soZXZlbnQsIFwiZXZlbnQgc2hvdWxkIG5vdCBiZSBudWxsXCIpO1xuXHRcdGFzc2VydC5lcXVhbChldmVudCEudHlwZSwgXCJ0b29sY2FsbF9lbmRcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKFxuXHRcdFx0KGV2ZW50IGFzIGFueSkubWFsZm9ybWVkQXJndW1lbnRzLFxuXHRcdFx0dHJ1ZSxcblx0XHRcdFwidHJ1bmNhdGVkIEpTT04gc2hvdWxkIHNldCBtYWxmb3JtZWRBcmd1bWVudHM6IHRydWVcIixcblx0XHQpO1xuXHRcdC8vIFRoZSBfcmF3IGZpZWxkIHNob3VsZCBjb250YWluIHRoZSBvcmlnaW5hbCBicm9rZW4gSlNPTlxuXHRcdGlmIChldmVudCEudHlwZSA9PT0gXCJ0b29sY2FsbF9lbmRcIikge1xuXHRcdFx0YXNzZXJ0LmVxdWFsKFxuXHRcdFx0XHRldmVudCEudG9vbENhbGwuYXJndW1lbnRzLl9yYXcsXG5cdFx0XHRcdCd7XCJtaWxlc3RvbmVJZFwiOiBcIk0wMCcsXG5cdFx0XHRcdFwiX3JhdyBzaG91bGQgY29udGFpbiB0aGUgdHJ1bmNhdGVkIEpTT04gc3RyaW5nXCIsXG5cdFx0XHQpO1xuXHRcdH1cblx0fSk7XG5cblx0dGVzdChcIm5vIEpTT04gZGVsdGFzIFx1MjE5MiBtYWxmb3JtZWRBcmd1bWVudHM6IHRydWUgKGVtcHR5IGFjY3VtdWxhdG9yIGlzIG5vdCB2YWxpZCBKU09OKVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgYnVpbGRlciA9IG5ldyBQYXJ0aWFsTWVzc2FnZUJ1aWxkZXIoXCJjbGF1ZGUtc29ubmV0LTQtMjAyNTA1MTRcIik7XG5cdFx0Ly8gTm8gZGVsdGFzIFx1MjAxNCB0aGUgYWNjdW11bGF0b3IgaXMgaW5pdGlhbGl6ZWQgdG8gXCJcIiBieSBjb250ZW50X2Jsb2NrX3N0YXJ0LFxuXHRcdC8vIGFuZCBcIlwiIGlzIG5vdCB2YWxpZCBKU09OLCBzbyB0aGlzIGNvcnJlY3RseSBzaWduYWxzIG1hbGZvcm1lZC5cblx0XHRjb25zdCBldmVudCA9IGZlZWRUb29sQ2FsbChidWlsZGVyLCBbXSk7XG5cblx0XHRhc3NlcnQub2soZXZlbnQsIFwiZXZlbnQgc2hvdWxkIG5vdCBiZSBudWxsXCIpO1xuXHRcdGFzc2VydC5lcXVhbChldmVudCEudHlwZSwgXCJ0b29sY2FsbF9lbmRcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKFxuXHRcdFx0KGV2ZW50IGFzIGFueSkubWFsZm9ybWVkQXJndW1lbnRzLFxuXHRcdFx0dHJ1ZSxcblx0XHRcdFwiZW1wdHkgYWNjdW11bGF0b3IgKG5vIEpTT04gZGVsdGFzKSBpcyBub3QgdmFsaWQgSlNPTiBcdTIxOTIgbWFsZm9ybWVkXCIsXG5cdFx0KTtcblx0fSk7XG5cblx0dGVzdChcImdhcmJhZ2UgaW5wdXQgKG5vbi1KU09OKSBcdTIxOTIgbWFsZm9ybWVkQXJndW1lbnRzOiB0cnVlXCIsICgpID0+IHtcblx0XHRjb25zdCBidWlsZGVyID0gbmV3IFBhcnRpYWxNZXNzYWdlQnVpbGRlcihcImNsYXVkZS1zb25uZXQtNC0yMDI1MDUxNFwiKTtcblx0XHRjb25zdCBldmVudCA9IGZlZWRUb29sQ2FsbChidWlsZGVyLCBbXCJub3QganNvbiBhdCBhbGwgPGh0bWw+XCJdKTtcblxuXHRcdGFzc2VydC5vayhldmVudCwgXCJldmVudCBzaG91bGQgbm90IGJlIG51bGxcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKGV2ZW50IS50eXBlLCBcInRvb2xjYWxsX2VuZFwiKTtcblx0XHRhc3NlcnQuZXF1YWwoXG5cdFx0XHQoZXZlbnQgYXMgYW55KS5tYWxmb3JtZWRBcmd1bWVudHMsXG5cdFx0XHR0cnVlLFxuXHRcdFx0XCJub24tSlNPTiBjb250ZW50IHNob3VsZCBzZXQgbWFsZm9ybWVkQXJndW1lbnRzOiB0cnVlXCIsXG5cdFx0KTtcblx0fSk7XG5cblx0dGVzdChcIllBTUwgYnVsbGV0IGxpc3RzIHJlcGFpcmVkIHRvIEpTT04gYXJyYXlzICgjMjY2MClcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGJ1aWxkZXIgPSBuZXcgUGFydGlhbE1lc3NhZ2VCdWlsZGVyKFwiY2xhdWRlLXNvbm5ldC00LTIwMjUwNTE0XCIpO1xuXHRcdGNvbnN0IG1hbGZvcm1lZEpzb24gPVxuXHRcdFx0J3tcIm1pbGVzdG9uZUlkXCI6IFwiTTAwNVwiLCBcImtleURlY2lzaW9uc1wiOiAtIFVzZWQgV2ViIE5vdGlmaWNhdGlvbiBBUEksIFwia2V5RmlsZXNcIjogLSBzcmMvbGliLnJzLCBcInRpdGxlXCI6IFwiZG9uZVwifSc7XG5cdFx0Y29uc3QgZXZlbnQgPSBmZWVkVG9vbENhbGwoYnVpbGRlciwgW21hbGZvcm1lZEpzb25dKTtcblxuXHRcdGFzc2VydC5vayhldmVudCwgXCJldmVudCBzaG91bGQgbm90IGJlIG51bGxcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKGV2ZW50IS50eXBlLCBcInRvb2xjYWxsX2VuZFwiKTtcblx0XHQvLyBSZXBhaXJlZCBZQU1MIGJ1bGxldHMgc2hvdWxkIE5PVCBzZXQgbWFsZm9ybWVkQXJndW1lbnRzXG5cdFx0YXNzZXJ0LmVxdWFsKFxuXHRcdFx0KGV2ZW50IGFzIGFueSkubWFsZm9ybWVkQXJndW1lbnRzLFxuXHRcdFx0dW5kZWZpbmVkLFxuXHRcdFx0XCJyZXBhaXJlZCBZQU1MIGJ1bGxldHMgc2hvdWxkIG5vdCBzZXQgbWFsZm9ybWVkQXJndW1lbnRzXCIsXG5cdFx0KTtcblx0XHRpZiAoZXZlbnQhLnR5cGUgPT09IFwidG9vbGNhbGxfZW5kXCIpIHtcblx0XHRcdGFzc2VydC5lcXVhbChldmVudCEudG9vbENhbGwuYXJndW1lbnRzLm1pbGVzdG9uZUlkLCBcIk0wMDVcIik7XG5cdFx0XHRhc3NlcnQub2soXG5cdFx0XHRcdEFycmF5LmlzQXJyYXkoZXZlbnQhLnRvb2xDYWxsLmFyZ3VtZW50cy5rZXlEZWNpc2lvbnMpLFxuXHRcdFx0XHRcImtleURlY2lzaW9ucyBzaG91bGQgYmUgcmVwYWlyZWQgdG8gYW4gYXJyYXlcIixcblx0XHRcdCk7XG5cdFx0XHRhc3NlcnQub2soXG5cdFx0XHRcdEFycmF5LmlzQXJyYXkoZXZlbnQhLnRvb2xDYWxsLmFyZ3VtZW50cy5rZXlGaWxlcyksXG5cdFx0XHRcdFwia2V5RmlsZXMgc2hvdWxkIGJlIHJlcGFpcmVkIHRvIGFuIGFycmF5XCIsXG5cdFx0XHQpO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKGV2ZW50IS50b29sQ2FsbC5hcmd1bWVudHMudGl0bGUsIFwiZG9uZVwiKTtcblx0XHR9XG5cdH0pO1xuXG5cdHRlc3QoXCJYTUwgcGFyYW1ldGVyIHRhZ3MgdHJhcHBlZCBpbnNpZGUgdmFsaWQgSlNPTiBzdHJpbmdzIGFyZSBwcm9tb3RlZCAoIzM3NTEpXCIsICgpID0+IHtcblx0XHRjb25zdCBidWlsZGVyID0gbmV3IFBhcnRpYWxNZXNzYWdlQnVpbGRlcihcImNsYXVkZS1zb25uZXQtNC0yMDI1MDUxNFwiKTtcblx0XHRjb25zdCBtYWxmb3JtZWRKc29uID1cblx0XHRcdCd7XCJuYXJyYXRpdmVcIjpcInRleHQuPC9uYXJyYXRpdmU+XFxcXG48cGFyYW1ldGVyIG5hbWU9XFxcXFwidmVyaWZpY2F0aW9uXFxcXFwiPmFsbCB0ZXN0cyBwYXNzPC9wYXJhbWV0ZXI+XFxcXG48cGFyYW1ldGVyIG5hbWU9XFxcXFwidmVyaWZpY2F0aW9uRXZpZGVuY2VcXFxcXCI+W1xcXFxcIm5wbSB0ZXN0XFxcXFwiXTwvcGFyYW1ldGVyPlwiLFwib25lTGluZXJcIjpcImRvbmVcIn0nO1xuXHRcdGNvbnN0IGV2ZW50ID0gZmVlZFRvb2xDYWxsKGJ1aWxkZXIsIFttYWxmb3JtZWRKc29uXSk7XG5cblx0XHRhc3NlcnQub2soZXZlbnQsIFwiZXZlbnQgc2hvdWxkIG5vdCBiZSBudWxsXCIpO1xuXHRcdGFzc2VydC5lcXVhbChldmVudCEudHlwZSwgXCJ0b29sY2FsbF9lbmRcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKChldmVudCBhcyBhbnkpLm1hbGZvcm1lZEFyZ3VtZW50cywgdW5kZWZpbmVkKTtcblx0XHRpZiAoZXZlbnQhLnR5cGUgPT09IFwidG9vbGNhbGxfZW5kXCIpIHtcblx0XHRcdGFzc2VydC5lcXVhbChldmVudC50b29sQ2FsbC5hcmd1bWVudHMubmFycmF0aXZlLCBcInRleHQuXCIpO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKGV2ZW50LnRvb2xDYWxsLmFyZ3VtZW50cy52ZXJpZmljYXRpb24sIFwiYWxsIHRlc3RzIHBhc3NcIik7XG5cdFx0XHRhc3NlcnQuZGVlcEVxdWFsKGV2ZW50LnRvb2xDYWxsLmFyZ3VtZW50cy52ZXJpZmljYXRpb25FdmlkZW5jZSwgW1wibnBtIHRlc3RcIl0pO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKGV2ZW50LnRvb2xDYWxsLmFyZ3VtZW50cy5vbmVMaW5lciwgXCJkb25lXCIpO1xuXHRcdH1cblx0fSk7XG59KTtcblxuZGVzY3JpYmUoXCJwYXJzZU1jcFRvb2xOYW1lXCIsICgpID0+IHtcblx0dGVzdChcInNwbGl0cyBtY3BfXzxzZXJ2ZXI+X188dG9vbD4gaW50byBwYXJ0c1wiLCAoKSA9PiB7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChcblx0XHRcdHBhcnNlTWNwVG9vbE5hbWUoXCJtY3BfX2dzZC13b3JrZmxvd19fZ3NkX3BsYW5fbWlsZXN0b25lXCIpLFxuXHRcdFx0eyBzZXJ2ZXI6IFwiZ3NkLXdvcmtmbG93XCIsIHRvb2w6IFwiZ3NkX3BsYW5fbWlsZXN0b25lXCIgfSxcblx0XHQpO1xuXHR9KTtcblxuXHR0ZXN0KFwicHJlc2VydmVzIHNlcnZlciBuYW1lcyBjb250YWluaW5nIGh5cGhlbnNcIiwgKCkgPT4ge1xuXHRcdGFzc2VydC5kZWVwRXF1YWwoXG5cdFx0XHRwYXJzZU1jcFRvb2xOYW1lKFwibWNwX19teS1jb29sLXNlcnZlcl9fZG9fdGhpbmdcIiksXG5cdFx0XHR7IHNlcnZlcjogXCJteS1jb29sLXNlcnZlclwiLCB0b29sOiBcImRvX3RoaW5nXCIgfSxcblx0XHQpO1xuXHR9KTtcblxuXHR0ZXN0KFwicHJlc2VydmVzIHRvb2wgbmFtZXMgY29udGFpbmluZyB1bmRlcnNjb3Jlc1wiLCAoKSA9PiB7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChcblx0XHRcdHBhcnNlTWNwVG9vbE5hbWUoXCJtY3BfX3Nydl9fYV9iX2NfZFwiKSxcblx0XHRcdHsgc2VydmVyOiBcInNydlwiLCB0b29sOiBcImFfYl9jX2RcIiB9LFxuXHRcdCk7XG5cdH0pO1xuXG5cdHRlc3QoXCJyZXR1cm5zIG51bGwgZm9yIG5vbi1wcmVmaXhlZCBuYW1lc1wiLCAoKSA9PiB7XG5cdFx0YXNzZXJ0LmVxdWFsKHBhcnNlTWNwVG9vbE5hbWUoXCJCYXNoXCIpLCBudWxsKTtcblx0XHRhc3NlcnQuZXF1YWwocGFyc2VNY3BUb29sTmFtZShcImdzZF9wbGFuX21pbGVzdG9uZVwiKSwgbnVsbCk7XG5cdH0pO1xuXG5cdHRlc3QoXCJyZXR1cm5zIG51bGwgZm9yIG1hbGZvcm1lZCBwcmVmaXhlc1wiLCAoKSA9PiB7XG5cdFx0YXNzZXJ0LmVxdWFsKHBhcnNlTWNwVG9vbE5hbWUoXCJtY3BfX1wiKSwgbnVsbCk7XG5cdFx0YXNzZXJ0LmVxdWFsKHBhcnNlTWNwVG9vbE5hbWUoXCJtY3BfX3NlcnZlclwiKSwgbnVsbCk7XG5cdFx0YXNzZXJ0LmVxdWFsKHBhcnNlTWNwVG9vbE5hbWUoXCJtY3BfX3NlcnZlcl9fXCIpLCBudWxsKTtcblx0XHRhc3NlcnQuZXF1YWwocGFyc2VNY3BUb29sTmFtZShcIm1jcF9fX190b29sXCIpLCBudWxsKTtcblx0fSk7XG59KTtcblxuZGVzY3JpYmUoXCJQYXJ0aWFsTWVzc2FnZUJ1aWxkZXIgXHUyMDE0IE1DUCB0b29sIG5hbWUgbm9ybWFsaXphdGlvblwiLCAoKSA9PiB7XG5cdHRlc3QoXCJzdHJpcHMgbWNwX188c2VydmVyPl9fIHByZWZpeCBvbiBjb250ZW50X2Jsb2NrX3N0YXJ0XCIsICgpID0+IHtcblx0XHRjb25zdCBidWlsZGVyID0gbmV3IFBhcnRpYWxNZXNzYWdlQnVpbGRlcihcImNsYXVkZS1zb25uZXQtNC0yMDI1MDUxNFwiKTtcblx0XHRjb25zdCBldmVudCA9IGJ1aWxkZXIuaGFuZGxlRXZlbnQoe1xuXHRcdFx0dHlwZTogXCJjb250ZW50X2Jsb2NrX3N0YXJ0XCIsXG5cdFx0XHRpbmRleDogMCxcblx0XHRcdGNvbnRlbnRfYmxvY2s6IHtcblx0XHRcdFx0dHlwZTogXCJ0b29sX3VzZVwiLFxuXHRcdFx0XHRpZDogXCJ0b29sXzFcIixcblx0XHRcdFx0bmFtZTogXCJtY3BfX2dzZC13b3JrZmxvd19fZ3NkX3BsYW5fbWlsZXN0b25lXCIsXG5cdFx0XHRcdGlucHV0OiB7fSxcblx0XHRcdH0sXG5cdFx0fSBhcyBCZXRhUmF3TWVzc2FnZVN0cmVhbUV2ZW50KTtcblxuXHRcdGFzc2VydC5vayhldmVudCwgXCJldmVudCBzaG91bGQgbm90IGJlIG51bGxcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKGV2ZW50IS50eXBlLCBcInRvb2xjYWxsX3N0YXJ0XCIpO1xuXHRcdGlmIChldmVudCEudHlwZSA9PT0gXCJ0b29sY2FsbF9zdGFydFwiKSB7XG5cdFx0XHRjb25zdCB0b29sQ2FsbCA9IChldmVudC5wYXJ0aWFsLmNvbnRlbnRbZXZlbnQuY29udGVudEluZGV4XSBhcyBhbnkpO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKHRvb2xDYWxsLm5hbWUsIFwiZ3NkX3BsYW5fbWlsZXN0b25lXCIpO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKHRvb2xDYWxsLm1jcFNlcnZlciwgXCJnc2Qtd29ya2Zsb3dcIik7XG5cdFx0fVxuXHR9KTtcblxuXHR0ZXN0KFwibGVhdmVzIG5vbi1NQ1AgdG9vbCBuYW1lcyB1bnRvdWNoZWRcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGJ1aWxkZXIgPSBuZXcgUGFydGlhbE1lc3NhZ2VCdWlsZGVyKFwiY2xhdWRlLXNvbm5ldC00LTIwMjUwNTE0XCIpO1xuXHRcdGNvbnN0IGV2ZW50ID0gYnVpbGRlci5oYW5kbGVFdmVudCh7XG5cdFx0XHR0eXBlOiBcImNvbnRlbnRfYmxvY2tfc3RhcnRcIixcblx0XHRcdGluZGV4OiAwLFxuXHRcdFx0Y29udGVudF9ibG9jazogeyB0eXBlOiBcInRvb2xfdXNlXCIsIGlkOiBcInRvb2xfMVwiLCBuYW1lOiBcIkJhc2hcIiwgaW5wdXQ6IHt9IH0sXG5cdFx0fSBhcyBCZXRhUmF3TWVzc2FnZVN0cmVhbUV2ZW50KTtcblxuXHRcdGFzc2VydC5vayhldmVudCk7XG5cdFx0aWYgKGV2ZW50IS50eXBlID09PSBcInRvb2xjYWxsX3N0YXJ0XCIpIHtcblx0XHRcdGNvbnN0IHRvb2xDYWxsID0gKGV2ZW50LnBhcnRpYWwuY29udGVudFtldmVudC5jb250ZW50SW5kZXhdIGFzIGFueSk7XG5cdFx0XHRhc3NlcnQuZXF1YWwodG9vbENhbGwubmFtZSwgXCJCYXNoXCIpO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKHRvb2xDYWxsLm1jcFNlcnZlciwgdW5kZWZpbmVkKTtcblx0XHR9XG5cdH0pO1xuXG5cdHRlc3QoXCJtYXBDb250ZW50QmxvY2sgc3RyaXBzIE1DUCBwcmVmaXggb24gZnVsbCB0b29sX3VzZSBibG9ja3NcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGJsb2NrOiBCZXRhQ29udGVudEJsb2NrID0ge1xuXHRcdFx0dHlwZTogXCJ0b29sX3VzZVwiLFxuXHRcdFx0aWQ6IFwidG9vbF8yXCIsXG5cdFx0XHRuYW1lOiBcIm1jcF9fZ3NkLXdvcmtmbG93X19nc2RfdGFza19jb21wbGV0ZVwiLFxuXHRcdFx0aW5wdXQ6IHsgdGFza0lkOiBcIlQwMDFcIiB9LFxuXHRcdH07XG5cdFx0Y29uc3QgbWFwcGVkID0gbWFwQ29udGVudEJsb2NrKGJsb2NrKSBhcyBhbnk7XG5cdFx0YXNzZXJ0LmVxdWFsKG1hcHBlZC50eXBlLCBcInRvb2xDYWxsXCIpO1xuXHRcdGFzc2VydC5lcXVhbChtYXBwZWQubmFtZSwgXCJnc2RfdGFza19jb21wbGV0ZVwiKTtcblx0XHRhc3NlcnQuZXF1YWwobWFwcGVkLm1jcFNlcnZlciwgXCJnc2Qtd29ya2Zsb3dcIik7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChtYXBwZWQuYXJndW1lbnRzLCB7IHRhc2tJZDogXCJUMDAxXCIgfSk7XG5cdH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxTQUFTLFVBQVUsWUFBWTtBQUMvQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxpQkFBaUIsVUFBVSxrQkFBa0IsNkJBQTZCO0FBR25GLFNBQVMsWUFBWSxNQUFNO0FBQzFCLE9BQUssMEVBQTBFLE1BQU07QUFDcEYsVUFBTSxRQUEwQjtBQUFBLE1BQy9CLGNBQWM7QUFBQSxNQUNkLGVBQWU7QUFBQSxNQUNmLHlCQUF5QjtBQUFBLE1BQ3pCLDZCQUE2QjtBQUFBLElBQzlCO0FBRUEsVUFBTSxTQUFTLFNBQVMsT0FBTyxJQUFJO0FBRW5DLFdBQU8sTUFBTSxPQUFPLFdBQVcsR0FBTztBQUN0QyxXQUFPLE1BQU0sT0FBTyxhQUFhLEtBQU87QUFDeEMsV0FBTyxNQUFNLE9BQU8sS0FBSyxPQUFPLElBQUk7QUFBQSxFQUNyQyxDQUFDO0FBQ0YsQ0FBQztBQUVELFNBQVMsaUVBQTRELE1BQU07QUFLMUUsV0FBUyxhQUNSLFNBQ0EsZUFDQztBQUVELFlBQVEsWUFBWTtBQUFBLE1BQ25CLE1BQU07QUFBQSxNQUNOLE9BQU87QUFB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
