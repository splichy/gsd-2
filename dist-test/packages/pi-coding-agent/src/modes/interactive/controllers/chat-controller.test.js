import assert from "node:assert/strict";
import test from "node:test";
import { Container } from "@gsd/pi-tui";
import stripAnsi from "strip-ansi";
import { findLatestPinnableText, handleAgentEvent } from "./chat-controller.js";
import { initTheme } from "../theme/theme.js";
test("findLatestPinnableText: empty content returns empty string", () => {
  assert.equal(findLatestPinnableText([]), "");
});
test("findLatestPinnableText: no tool calls returns empty string", () => {
  const blocks = [
    { type: "text", text: "hello" },
    { type: "text", text: "world" }
  ];
  assert.equal(findLatestPinnableText(blocks), "");
});
test("findLatestPinnableText: returns text preceding a tool call", () => {
  const blocks = [
    { type: "text", text: "doing the thing" },
    { type: "toolCall", id: "1", name: "Read" }
  ];
  assert.equal(findLatestPinnableText(blocks), "doing the thing");
});
test("findLatestPinnableText: ignores trailing streaming text after the last tool call (regression: pinned mirror duplicated chat-container tokens)", () => {
  const blocks = [
    { type: "text", text: "first prose" },
    { type: "toolCall", id: "1", name: "Read" },
    { type: "text", text: "second prose still streaming" }
  ];
  assert.equal(findLatestPinnableText(blocks), "first prose");
});
test("findLatestPinnableText: with multiple tools, picks text before the most recent tool call", () => {
  const blocks = [
    { type: "text", text: "first" },
    { type: "toolCall", id: "1", name: "Read" },
    { type: "text", text: "second" },
    { type: "toolCall", id: "2", name: "Grep" },
    { type: "text", text: "third streaming" }
  ];
  assert.equal(findLatestPinnableText(blocks), "second");
});
test("findLatestPinnableText: treats serverToolUse the same as toolCall", () => {
  const blocks = [
    { type: "text", text: "before web search" },
    { type: "serverToolUse", id: "ws1", name: "web_search" },
    { type: "text", text: "answer streaming" }
  ];
  assert.equal(findLatestPinnableText(blocks), "before web search");
});
test("findLatestPinnableText: skips empty/whitespace-only text blocks", () => {
  const blocks = [
    { type: "text", text: "real prose" },
    { type: "text", text: "   " },
    { type: "text", text: "" },
    { type: "toolCall", id: "1", name: "Read" }
  ];
  assert.equal(findLatestPinnableText(blocks), "real prose");
});
test("findLatestPinnableText: thinking blocks are not pinnable", () => {
  const blocks = [
    { type: "thinking", thinking: "internal" },
    { type: "toolCall", id: "1", name: "Read" }
  ];
  assert.equal(findLatestPinnableText(blocks), "");
});
test("handleAgentEvent: agent_start clears stale adaptive blocking error", async () => {
  initTheme("dark", false);
  let cleared = false;
  let requestedRender = false;
  const host = {
    isInitialized: true,
    clearBlockingError: () => {
      cleared = true;
    },
    retryEscapeHandler: void 0,
    retryLoader: void 0,
    loadingAnimation: void 0,
    statusContainer: {
      clear() {
      },
      addChild() {
      }
    },
    ui: {
      requestRender() {
        requestedRender = true;
      }
    },
    defaultEditor: {},
    footer: {
      invalidate() {
      }
    },
    settingsManager: {
      getTimestampFormat() {
        return "date-time-iso";
      }
    },
    defaultWorkingMessage: "Working...",
    pendingWorkingMessage: void 0
  };
  await handleAgentEvent(host, { type: "agent_start" });
  host.loadingAnimation?.stop();
  assert.equal(cleared, true);
  assert.equal(requestedRender, true);
});
test("handleAgentEvent: standalone completed tool events roll up incrementally", async () => {
  initTheme("dark", false);
  const chatContainer = new Container();
  let renderCount = 0;
  const host = {
    isInitialized: true,
    footer: { invalidate() {
    } },
    settingsManager: {
      getTimestampFormat() {
        return "date-time-iso";
      },
      getShowImages() {
        return false;
      }
    },
    getRegisteredToolDefinition() {
      return void 0;
    },
    chatContainer,
    pendingTools: /* @__PURE__ */ new Map(),
    ui: {
      requestRender() {
        renderCount++;
      }
    }
  };
  for (const [toolCallId, toolName] of [
    ["read-1", "read"],
    ["read-2", "read"],
    ["edit-1", "edit"]
  ]) {
    const target = toolName === "edit" ? {
      kind: "file",
      action: "edit",
      inputPath: `src/${toolCallId}.txt`,
      resolvedPath: `/tmp/project/src/${toolCallId}.txt`,
      line: 10
    } : {
      kind: "file",
      action: "read",
      inputPath: `src/${toolCallId}.txt`,
      resolvedPath: `/tmp/project/src/${toolCallId}.txt`
    };
    await handleAgentEvent(host, {
      type: "tool_execution_start",
      toolCallId,
      toolName,
      args: { path: `src/${toolCallId}.txt` }
    });
    await handleAgentEvent(host, {
      type: "tool_execution_end",
      toolCallId,
      toolName,
      result: { content: [], details: { target }, isError: false },
      isError: false
    });
  }
  const rendered = stripAnsi(chatContainer.render(100).join("\n"));
  assert.match(rendered, /Context reads · 2 files\s+success · \d+(ms|s)/);
  assert.match(rendered, /src\/read-1\.txt/);
  assert.match(rendered, /src\/read-2\.txt/);
  assert.match(rendered, /File changes · 1 file, 1 edit\s+success · \d+(ms|s)/);
  assert.match(rendered, /src\/edit-1\.txt:10/);
  assert.doesNotMatch(rendered, /^\s*│?\s*read\s+success ·/m);
  assert.doesNotMatch(rendered, /^\s*│?\s*edit\s+success ·/m);
  assert.ok(renderCount > 0);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9tb2Rlcy9pbnRlcmFjdGl2ZS9jb250cm9sbGVycy9jaGF0LWNvbnRyb2xsZXIudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgeyBDb250YWluZXIgfSBmcm9tIFwiQGdzZC9waS10dWlcIjtcbmltcG9ydCBzdHJpcEFuc2kgZnJvbSBcInN0cmlwLWFuc2lcIjtcblxuaW1wb3J0IHsgZmluZExhdGVzdFBpbm5hYmxlVGV4dCwgaGFuZGxlQWdlbnRFdmVudCB9IGZyb20gXCIuL2NoYXQtY29udHJvbGxlci5qc1wiO1xuaW1wb3J0IHsgaW5pdFRoZW1lIH0gZnJvbSBcIi4uL3RoZW1lL3RoZW1lLmpzXCI7XG5cbnRlc3QoXCJmaW5kTGF0ZXN0UGlubmFibGVUZXh0OiBlbXB0eSBjb250ZW50IHJldHVybnMgZW1wdHkgc3RyaW5nXCIsICgpID0+IHtcblx0YXNzZXJ0LmVxdWFsKGZpbmRMYXRlc3RQaW5uYWJsZVRleHQoW10pLCBcIlwiKTtcbn0pO1xuXG50ZXN0KFwiZmluZExhdGVzdFBpbm5hYmxlVGV4dDogbm8gdG9vbCBjYWxscyByZXR1cm5zIGVtcHR5IHN0cmluZ1wiLCAoKSA9PiB7XG5cdGNvbnN0IGJsb2NrcyA9IFtcblx0XHR7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcImhlbGxvXCIgfSxcblx0XHR7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIndvcmxkXCIgfSxcblx0XTtcblx0YXNzZXJ0LmVxdWFsKGZpbmRMYXRlc3RQaW5uYWJsZVRleHQoYmxvY2tzKSwgXCJcIik7XG59KTtcblxudGVzdChcImZpbmRMYXRlc3RQaW5uYWJsZVRleHQ6IHJldHVybnMgdGV4dCBwcmVjZWRpbmcgYSB0b29sIGNhbGxcIiwgKCkgPT4ge1xuXHRjb25zdCBibG9ja3MgPSBbXG5cdFx0eyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJkb2luZyB0aGUgdGhpbmdcIiB9LFxuXHRcdHsgdHlwZTogXCJ0b29sQ2FsbFwiLCBpZDogXCIxXCIsIG5hbWU6IFwiUmVhZFwiIH0sXG5cdF07XG5cdGFzc2VydC5lcXVhbChmaW5kTGF0ZXN0UGlubmFibGVUZXh0KGJsb2NrcyksIFwiZG9pbmcgdGhlIHRoaW5nXCIpO1xufSk7XG5cbnRlc3QoXCJmaW5kTGF0ZXN0UGlubmFibGVUZXh0OiBpZ25vcmVzIHRyYWlsaW5nIHN0cmVhbWluZyB0ZXh0IGFmdGVyIHRoZSBsYXN0IHRvb2wgY2FsbCAocmVncmVzc2lvbjogcGlubmVkIG1pcnJvciBkdXBsaWNhdGVkIGNoYXQtY29udGFpbmVyIHRva2VucylcIiwgKCkgPT4ge1xuXHRjb25zdCBibG9ja3MgPSBbXG5cdFx0eyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJmaXJzdCBwcm9zZVwiIH0sXG5cdFx0eyB0eXBlOiBcInRvb2xDYWxsXCIsIGlkOiBcIjFcIiwgbmFtZTogXCJSZWFkXCIgfSxcblx0XHR7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcInNlY29uZCBwcm9zZSBzdGlsbCBzdHJlYW1pbmdcIiB9LFxuXHRdO1xuXHRhc3NlcnQuZXF1YWwoZmluZExhdGVzdFBpbm5hYmxlVGV4dChibG9ja3MpLCBcImZpcnN0IHByb3NlXCIpO1xufSk7XG5cbnRlc3QoXCJmaW5kTGF0ZXN0UGlubmFibGVUZXh0OiB3aXRoIG11bHRpcGxlIHRvb2xzLCBwaWNrcyB0ZXh0IGJlZm9yZSB0aGUgbW9zdCByZWNlbnQgdG9vbCBjYWxsXCIsICgpID0+IHtcblx0Y29uc3QgYmxvY2tzID0gW1xuXHRcdHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiZmlyc3RcIiB9LFxuXHRcdHsgdHlwZTogXCJ0b29sQ2FsbFwiLCBpZDogXCIxXCIsIG5hbWU6IFwiUmVhZFwiIH0sXG5cdFx0eyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJzZWNvbmRcIiB9LFxuXHRcdHsgdHlwZTogXCJ0b29sQ2FsbFwiLCBpZDogXCIyXCIsIG5hbWU6IFwiR3JlcFwiIH0sXG5cdFx0eyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJ0aGlyZCBzdHJlYW1pbmdcIiB9LFxuXHRdO1xuXHRhc3NlcnQuZXF1YWwoZmluZExhdGVzdFBpbm5hYmxlVGV4dChibG9ja3MpLCBcInNlY29uZFwiKTtcbn0pO1xuXG50ZXN0KFwiZmluZExhdGVzdFBpbm5hYmxlVGV4dDogdHJlYXRzIHNlcnZlclRvb2xVc2UgdGhlIHNhbWUgYXMgdG9vbENhbGxcIiwgKCkgPT4ge1xuXHRjb25zdCBibG9ja3MgPSBbXG5cdFx0eyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJiZWZvcmUgd2ViIHNlYXJjaFwiIH0sXG5cdFx0eyB0eXBlOiBcInNlcnZlclRvb2xVc2VcIiwgaWQ6IFwid3MxXCIsIG5hbWU6IFwid2ViX3NlYXJjaFwiIH0sXG5cdFx0eyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJhbnN3ZXIgc3RyZWFtaW5nXCIgfSxcblx0XTtcblx0YXNzZXJ0LmVxdWFsKGZpbmRMYXRlc3RQaW5uYWJsZVRleHQoYmxvY2tzKSwgXCJiZWZvcmUgd2ViIHNlYXJjaFwiKTtcbn0pO1xuXG50ZXN0KFwiZmluZExhdGVzdFBpbm5hYmxlVGV4dDogc2tpcHMgZW1wdHkvd2hpdGVzcGFjZS1vbmx5IHRleHQgYmxvY2tzXCIsICgpID0+IHtcblx0Y29uc3QgYmxvY2tzID0gW1xuXHRcdHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwicmVhbCBwcm9zZVwiIH0sXG5cdFx0eyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCIgICBcIiB9LFxuXHRcdHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiXCIgfSxcblx0XHR7IHR5cGU6IFwidG9vbENhbGxcIiwgaWQ6IFwiMVwiLCBuYW1lOiBcIlJlYWRcIiB9LFxuXHRdO1xuXHRhc3NlcnQuZXF1YWwoZmluZExhdGVzdFBpbm5hYmxlVGV4dChibG9ja3MpLCBcInJlYWwgcHJvc2VcIik7XG59KTtcblxudGVzdChcImZpbmRMYXRlc3RQaW5uYWJsZVRleHQ6IHRoaW5raW5nIGJsb2NrcyBhcmUgbm90IHBpbm5hYmxlXCIsICgpID0+IHtcblx0Y29uc3QgYmxvY2tzID0gW1xuXHRcdHsgdHlwZTogXCJ0aGlua2luZ1wiLCB0aGlua2luZzogXCJpbnRlcm5hbFwiIH0sXG5cdFx0eyB0eXBlOiBcInRvb2xDYWxsXCIsIGlkOiBcIjFcIiwgbmFtZTogXCJSZWFkXCIgfSxcblx0XTtcblx0YXNzZXJ0LmVxdWFsKGZpbmRMYXRlc3RQaW5uYWJsZVRleHQoYmxvY2tzKSwgXCJcIik7XG59KTtcblxudGVzdChcImhhbmRsZUFnZW50RXZlbnQ6IGFnZW50X3N0YXJ0IGNsZWFycyBzdGFsZSBhZGFwdGl2ZSBibG9ja2luZyBlcnJvclwiLCBhc3luYyAoKSA9PiB7XG5cdGluaXRUaGVtZShcImRhcmtcIiwgZmFsc2UpO1xuXHRsZXQgY2xlYXJlZCA9IGZhbHNlO1xuXHRsZXQgcmVxdWVzdGVkUmVuZGVyID0gZmFsc2U7XG5cdGNvbnN0IGhvc3QgPSB7XG5cdFx0aXNJbml0aWFsaXplZDogdHJ1ZSxcblx0XHRjbGVhckJsb2NraW5nRXJyb3I6ICgpID0+IHtcblx0XHRcdGNsZWFyZWQgPSB0cnVlO1xuXHRcdH0sXG5cdFx0cmV0cnlFc2NhcGVIYW5kbGVyOiB1bmRlZmluZWQsXG5cdFx0cmV0cnlMb2FkZXI6IHVuZGVmaW5lZCxcblx0XHRsb2FkaW5nQW5pbWF0aW9uOiB1bmRlZmluZWQsXG5cdFx0c3RhdHVzQ29udGFpbmVyOiB7XG5cdFx0XHRjbGVhcigpIHt9LFxuXHRcdFx0YWRkQ2hpbGQoKSB7fSxcblx0XHR9LFxuXHRcdHVpOiB7XG5cdFx0XHRyZXF1ZXN0UmVuZGVyKCkge1xuXHRcdFx0XHRyZXF1ZXN0ZWRSZW5kZXIgPSB0cnVlO1xuXHRcdFx0fSxcblx0XHR9LFxuXHRcdGRlZmF1bHRFZGl0b3I6IHt9LFxuXHRcdGZvb3Rlcjoge1xuXHRcdFx0aW52YWxpZGF0ZSgpIHt9LFxuXHRcdH0sXG5cdFx0c2V0dGluZ3NNYW5hZ2VyOiB7XG5cdFx0XHRnZXRUaW1lc3RhbXBGb3JtYXQoKSB7XG5cdFx0XHRcdHJldHVybiBcImRhdGUtdGltZS1pc29cIjtcblx0XHRcdH0sXG5cdFx0fSxcblx0XHRkZWZhdWx0V29ya2luZ01lc3NhZ2U6IFwiV29ya2luZy4uLlwiLFxuXHRcdHBlbmRpbmdXb3JraW5nTWVzc2FnZTogdW5kZWZpbmVkLFxuXHR9IGFzIGFueTtcblxuXHRhd2FpdCBoYW5kbGVBZ2VudEV2ZW50KGhvc3QsIHsgdHlwZTogXCJhZ2VudF9zdGFydFwiIH0gYXMgYW55KTtcblx0aG9zdC5sb2FkaW5nQW5pbWF0aW9uPy5zdG9wKCk7XG5cblx0YXNzZXJ0LmVxdWFsKGNsZWFyZWQsIHRydWUpO1xuXHRhc3NlcnQuZXF1YWwocmVxdWVzdGVkUmVuZGVyLCB0cnVlKTtcbn0pO1xuXG50ZXN0KFwiaGFuZGxlQWdlbnRFdmVudDogc3RhbmRhbG9uZSBjb21wbGV0ZWQgdG9vbCBldmVudHMgcm9sbCB1cCBpbmNyZW1lbnRhbGx5XCIsIGFzeW5jICgpID0+IHtcblx0aW5pdFRoZW1lKFwiZGFya1wiLCBmYWxzZSk7XG5cdGNvbnN0IGNoYXRDb250YWluZXIgPSBuZXcgQ29udGFpbmVyKCk7XG5cdGxldCByZW5kZXJDb3VudCA9IDA7XG5cdGNvbnN0IGhvc3QgPSB7XG5cdFx0aXNJbml0aWFsaXplZDogdHJ1ZSxcblx0XHRmb290ZXI6IHsgaW52YWxpZGF0ZSgpIHt9IH0sXG5cdFx0c2V0dGluZ3NNYW5hZ2VyOiB7XG5cdFx0XHRnZXRUaW1lc3RhbXBGb3JtYXQoKSB7XG5cdFx0XHRcdHJldHVybiBcImRhdGUtdGltZS1pc29cIjtcblx0XHRcdH0sXG5cdFx0XHRnZXRTaG93SW1hZ2VzKCkge1xuXHRcdFx0XHRyZXR1cm4gZmFsc2U7XG5cdFx0XHR9LFxuXHRcdH0sXG5cdFx0Z2V0UmVnaXN0ZXJlZFRvb2xEZWZpbml0aW9uKCkge1xuXHRcdFx0cmV0dXJuIHVuZGVmaW5lZDtcblx0XHR9LFxuXHRcdGNoYXRDb250YWluZXIsXG5cdFx0cGVuZGluZ1Rvb2xzOiBuZXcgTWFwKCksXG5cdFx0dWk6IHtcblx0XHRcdHJlcXVlc3RSZW5kZXIoKSB7XG5cdFx0XHRcdHJlbmRlckNvdW50Kys7XG5cdFx0XHR9LFxuXHRcdH0sXG5cdH0gYXMgYW55O1xuXG5cdGZvciAoY29uc3QgW3Rvb2xDYWxsSWQsIHRvb2xOYW1lXSBvZiBbXG5cdFx0W1wicmVhZC0xXCIsIFwicmVhZFwiXSxcblx0XHRbXCJyZWFkLTJcIiwgXCJyZWFkXCJdLFxuXHRcdFtcImVkaXQtMVwiLCBcImVkaXRcIl0sXG5cdF0gYXMgY29uc3QpIHtcblx0XHRjb25zdCB0YXJnZXQgPVxuXHRcdFx0dG9vbE5hbWUgPT09IFwiZWRpdFwiXG5cdFx0XHRcdD8ge1xuXHRcdFx0XHRcdFx0a2luZDogXCJmaWxlXCIsXG5cdFx0XHRcdFx0XHRhY3Rpb246IFwiZWRpdFwiLFxuXHRcdFx0XHRcdFx0aW5wdXRQYXRoOiBgc3JjLyR7dG9vbENhbGxJZH0udHh0YCxcblx0XHRcdFx0XHRcdHJlc29sdmVkUGF0aDogYC90bXAvcHJvamVjdC9zcmMvJHt0b29sQ2FsbElkfS50eHRgLFxuXHRcdFx0XHRcdFx0bGluZTogMTAsXG5cdFx0XHRcdFx0fVxuXHRcdFx0XHQ6IHtcblx0XHRcdFx0XHRcdGtpbmQ6IFwiZmlsZVwiLFxuXHRcdFx0XHRcdFx0YWN0aW9uOiBcInJlYWRcIixcblx0XHRcdFx0XHRcdGlucHV0UGF0aDogYHNyYy8ke3Rvb2xDYWxsSWR9LnR4dGAsXG5cdFx0XHRcdFx0XHRyZXNvbHZlZFBhdGg6IGAvdG1wL3Byb2plY3Qvc3JjLyR7dG9vbENhbGxJZH0udHh0YCxcblx0XHRcdFx0XHR9O1xuXHRcdGF3YWl0IGhhbmRsZUFnZW50RXZlbnQoaG9zdCwge1xuXHRcdFx0dHlwZTogXCJ0b29sX2V4ZWN1dGlvbl9zdGFydFwiLFxuXHRcdFx0dG9vbENhbGxJZCxcblx0XHRcdHRvb2xOYW1lLFxuXHRcdFx0YXJnczogeyBwYXRoOiBgc3JjLyR7dG9vbENhbGxJZH0udHh0YCB9LFxuXHRcdH0gYXMgYW55KTtcblx0XHRhd2FpdCBoYW5kbGVBZ2VudEV2ZW50KGhvc3QsIHtcblx0XHRcdHR5cGU6IFwidG9vbF9leGVjdXRpb25fZW5kXCIsXG5cdFx0XHR0b29sQ2FsbElkLFxuXHRcdFx0dG9vbE5hbWUsXG5cdFx0XHRyZXN1bHQ6IHsgY29udGVudDogW10sIGRldGFpbHM6IHsgdGFyZ2V0IH0sIGlzRXJyb3I6IGZhbHNlIH0sXG5cdFx0XHRpc0Vycm9yOiBmYWxzZSxcblx0XHR9IGFzIGFueSk7XG5cdH1cblxuXHRjb25zdCByZW5kZXJlZCA9IHN0cmlwQW5zaShjaGF0Q29udGFpbmVyLnJlbmRlcigxMDApLmpvaW4oXCJcXG5cIikpO1xuXHRhc3NlcnQubWF0Y2gocmVuZGVyZWQsIC9Db250ZXh0IHJlYWRzIFx1MDBCNyAyIGZpbGVzXFxzK3N1Y2Nlc3MgXHUwMEI3IFxcZCsobXN8cykvKTtcblx0YXNzZXJ0Lm1hdGNoKHJlbmRlcmVkLCAvc3JjXFwvcmVhZC0xXFwudHh0Lyk7XG5cdGFzc2VydC5tYXRjaChyZW5kZXJlZCwgL3NyY1xcL3JlYWQtMlxcLnR4dC8pO1xuXHRhc3NlcnQubWF0Y2gocmVuZGVyZWQsIC9GaWxlIGNoYW5nZXMgXHUwMEI3IDEgZmlsZSwgMSBlZGl0XFxzK3N1Y2Nlc3MgXHUwMEI3IFxcZCsobXN8cykvKTtcblx0YXNzZXJ0Lm1hdGNoKHJlbmRlcmVkLCAvc3JjXFwvZWRpdC0xXFwudHh0OjEwLyk7XG5cdGFzc2VydC5kb2VzTm90TWF0Y2gocmVuZGVyZWQsIC9eXFxzKlx1MjUwMj9cXHMqcmVhZFxccytzdWNjZXNzIFx1MDBCNy9tKTtcblx0YXNzZXJ0LmRvZXNOb3RNYXRjaChyZW5kZXJlZCwgL15cXHMqXHUyNTAyP1xccyplZGl0XFxzK3N1Y2Nlc3MgXHUwMEI3L20pO1xuXHRhc3NlcnQub2socmVuZGVyQ291bnQgPiAwKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjog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
