import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatProgress, formatThinkingLine, formatCostLine, summarizeToolArgs } from "../headless-ui.js";
function ctx(overrides = {}) {
  return { verbose: true, ...overrides };
}
describe("formatProgress", () => {
  describe("tool_execution_start", () => {
    it("shows tool name and summarized args in verbose mode", () => {
      const result = formatProgress({
        type: "tool_execution_start",
        toolName: "bash",
        args: { command: "npm run build" }
      }, ctx());
      assert.ok(result);
      assert.ok(result.includes("bash"));
      assert.ok(result.includes("npm run build"));
    });
    it("shows Read with file path", () => {
      const result = formatProgress({
        type: "tool_execution_start",
        toolName: "Read",
        args: { path: "src/main.ts" }
      }, ctx());
      assert.ok(result);
      assert.ok(result.includes("Read"));
      assert.ok(result.includes("src/main.ts"));
    });
    it("returns null in non-verbose mode", () => {
      const result = formatProgress({
        type: "tool_execution_start",
        toolName: "bash",
        args: { command: "npm run build" }
      }, ctx({ verbose: false }));
      assert.equal(result, null);
    });
    it("shows tool name alone when no args", () => {
      const result = formatProgress({
        type: "tool_execution_start",
        toolName: "unknown_tool"
      }, ctx());
      assert.ok(result);
      assert.ok(result.includes("unknown_tool"));
    });
  });
  describe("tool_execution_end", () => {
    it("shows error with duration in verbose mode", () => {
      const result = formatProgress({
        type: "tool_execution_end",
        toolName: "bash"
      }, ctx({ isError: true, toolDuration: 1500 }));
      assert.ok(result);
      assert.ok(result.includes("bash"));
      assert.ok(result.includes("error"));
      assert.ok(result.includes("1.5s"));
    });
    it("shows done with duration in verbose mode", () => {
      const result = formatProgress({
        type: "tool_execution_end",
        toolName: "read"
      }, ctx({ toolDuration: 50 }));
      assert.ok(result);
      assert.ok(result.includes("done"));
      assert.ok(result.includes("50ms"));
    });
    it("returns null in non-verbose mode", () => {
      const result = formatProgress({
        type: "tool_execution_end",
        toolName: "bash",
        isError: false
      }, ctx({ verbose: false }));
      assert.equal(result, null);
    });
  });
  describe("agent lifecycle", () => {
    it("shows agent_start", () => {
      const result = formatProgress({ type: "agent_start" }, ctx());
      assert.ok(result);
      assert.ok(result.includes("Session started"));
    });
    it("shows agent_end", () => {
      const result = formatProgress({ type: "agent_end" }, ctx());
      assert.ok(result);
      assert.ok(result.includes("Session ended"));
    });
    it("shows agent_end with cost", () => {
      const result = formatProgress({ type: "agent_end" }, ctx({
        lastCost: { costUsd: 0.42, inputTokens: 1e4, outputTokens: 500 }
      }));
      assert.ok(result);
      assert.ok(result.includes("Session ended"));
      assert.ok(result.includes("$0.42"));
      assert.ok(result.includes("10500 tokens"));
    });
  });
  describe("extension_ui_request", () => {
    it("shows notify with message", () => {
      const result = formatProgress({
        type: "extension_ui_request",
        method: "notify",
        message: "Auto-mode started"
      }, ctx());
      assert.ok(result);
      assert.ok(result.includes("Auto-mode started"));
    });
    it("bolds important notifications", () => {
      const result = formatProgress({
        type: "extension_ui_request",
        method: "notify",
        message: "Committed: fix auth flow"
      }, ctx());
      assert.ok(result);
      assert.ok(result.includes("Committed: fix auth flow"));
    });
    it("suppresses empty notify", () => {
      const result = formatProgress({
        type: "extension_ui_request",
        method: "notify",
        message: ""
      }, ctx());
      assert.equal(result, null);
    });
    it("suppresses empty setStatus", () => {
      const result = formatProgress({
        type: "extension_ui_request",
        method: "setStatus",
        statusKey: "",
        message: ""
      }, ctx());
      assert.equal(result, null);
    });
    it("shows setStatus with statusKey as phase", () => {
      const result = formatProgress({
        type: "extension_ui_request",
        method: "setStatus",
        statusKey: "milestone:M001",
        message: "Hello World CLI"
      }, ctx());
      assert.ok(result);
      assert.ok(result.includes("Milestone"));
      assert.ok(result.includes("M001"));
    });
    it("suppresses setWidget (TUI-only)", () => {
      const result = formatProgress({
        type: "extension_ui_request",
        method: "setWidget",
        widgetKey: "progress"
      }, ctx());
      assert.equal(result, null);
    });
  });
  describe("unknown events", () => {
    it("returns null", () => {
      assert.equal(formatProgress({ type: "some_random_event" }, ctx()), null);
    });
  });
});
describe("summarizeToolArgs", () => {
  it("extracts path for Read", () => {
    assert.equal(summarizeToolArgs("Read", { path: "src/index.ts" }), "src/index.ts");
  });
  it("extracts path for write", () => {
    assert.equal(summarizeToolArgs("write", { path: "/tmp/out.json" }), "/tmp/out.json");
  });
  it("extracts file_path for legacy compatibility", () => {
    assert.equal(summarizeToolArgs("read", { file_path: "src/foo.ts" }), "src/foo.ts");
  });
  it("prefers path over file_path when both present", () => {
    assert.equal(summarizeToolArgs("read", { path: "real.ts", file_path: "legacy.ts" }), "real.ts");
  });
  it("extracts command for bash", () => {
    assert.equal(summarizeToolArgs("bash", { command: "ls -la" }), "ls -la");
  });
  it("truncates long bash commands", () => {
    const longCmd = "a".repeat(100);
    const result = summarizeToolArgs("bash", { command: longCmd });
    assert.ok(result.endsWith("..."));
    assert.ok(result.length < 100);
  });
  it("extracts command for async_bash", () => {
    assert.equal(summarizeToolArgs("async_bash", { command: "npm run build" }), "npm run build");
  });
  it("extracts jobs for await_job", () => {
    assert.equal(summarizeToolArgs("await_job", { jobs: ["bg_abc", "bg_def"] }), "bg_abc, bg_def");
  });
  it("extracts pattern for grep", () => {
    const result = summarizeToolArgs("grep", { pattern: "TODO", glob: "*.ts" });
    assert.equal(result, "TODO *.ts");
  });
  it("extracts pattern and path for find", () => {
    assert.equal(summarizeToolArgs("find", { pattern: "*.ts", path: "src" }), "*.ts in src");
  });
  it("extracts action and file for lsp", () => {
    const result = summarizeToolArgs("lsp", { action: "definition", file: "src/main.ts", symbol: "foo" });
    assert.equal(result, "definition src/main.ts foo");
  });
  it("extracts path for ls", () => {
    assert.equal(summarizeToolArgs("ls", { path: "src/utils" }), "src/utils");
  });
  it("summarizes gsd tool with milestone/slice/task IDs", () => {
    assert.equal(summarizeToolArgs("gsd_task_complete", {
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      oneLiner: "Built the thing"
    }), "M001/S01/T01 Built the thing");
  });
  it("summarizes gsd_plan_milestone with milestone ID", () => {
    assert.equal(summarizeToolArgs("gsd_plan_milestone", { milestoneId: "M002" }), "M002");
  });
  it("summarizes gsd_decision_save with decision text", () => {
    const result = summarizeToolArgs("gsd_decision_save", { decision: "Use SQLite for persistence" });
    assert.equal(result, "Use SQLite for persistence");
  });
  it("returns first string value for unknown tools", () => {
    assert.equal(summarizeToolArgs("custom_tool", { someKey: "hello" }), "hello");
  });
  it("returns empty string for no args", () => {
    assert.equal(summarizeToolArgs("unknown", {}), "");
  });
  it("extracts path for edit", () => {
    assert.equal(summarizeToolArgs("edit", { path: "src/config.ts" }), "src/config.ts");
  });
  it("extracts path for hashline_edit", () => {
    assert.equal(summarizeToolArgs("hashline_edit", { path: "src/main.ts" }), "src/main.ts");
  });
  it("extracts agent and task for subagent", () => {
    assert.equal(summarizeToolArgs("subagent", { agent: "scout", task: "Find auth patterns" }), "scout: Find auth patterns");
  });
  it("extracts url for browser_navigate", () => {
    assert.equal(summarizeToolArgs("browser_navigate", { url: "http://localhost:3000" }), "http://localhost:3000");
  });
});
describe("formatThinkingLine", () => {
  it("formats short text", () => {
    const result = formatThinkingLine("Analyzing the codebase");
    assert.ok(result.includes("[thinking]"));
    assert.ok(result.includes("Analyzing the codebase"));
  });
  it("truncates long text to ~120 chars", () => {
    const longText = "word ".repeat(50);
    const result = formatThinkingLine(longText);
    assert.ok(result.includes("..."));
  });
  it("collapses whitespace", () => {
    const result = formatThinkingLine("line one\n\nline   two	tab");
    assert.ok(result.includes("line one line two tab"));
  });
});
describe("formatCostLine", () => {
  it("formats cost with token count", () => {
    const result = formatCostLine(0.0523, 4200, 1100);
    assert.ok(result.includes("$0.0523"));
    assert.ok(result.includes("5300 tokens"));
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3Rlc3RzL2hlYWRsZXNzLXByb2dyZXNzLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IGRlc2NyaWJlLCBpdCB9IGZyb20gJ25vZGU6dGVzdCdcbmltcG9ydCBhc3NlcnQgZnJvbSAnbm9kZTphc3NlcnQvc3RyaWN0J1xuaW1wb3J0IHsgZm9ybWF0UHJvZ3Jlc3MsIGZvcm1hdFRoaW5raW5nTGluZSwgZm9ybWF0Q29zdExpbmUsIHN1bW1hcml6ZVRvb2xBcmdzIH0gZnJvbSAnLi4vaGVhZGxlc3MtdWkuanMnXG5pbXBvcnQgdHlwZSB7IFByb2dyZXNzQ29udGV4dCB9IGZyb20gJy4uL2hlYWRsZXNzLXVpLmpzJ1xuXG4vLyBUZXN0cyBydW4gd2l0aCBOT19DT0xPUiBvciBub24tVFRZIHN0ZGVyciwgc28gQU5TSSBjb2RlcyBhcmUgZW1wdHkgc3RyaW5ncy5cbi8vIFdlIHRlc3QgY29udGVudCwgbm90IGVzY2FwZSBzZXF1ZW5jZXMuXG5cbmZ1bmN0aW9uIGN0eChvdmVycmlkZXM6IFBhcnRpYWw8UHJvZ3Jlc3NDb250ZXh0PiA9IHt9KTogUHJvZ3Jlc3NDb250ZXh0IHtcbiAgcmV0dXJuIHsgdmVyYm9zZTogdHJ1ZSwgLi4ub3ZlcnJpZGVzIH1cbn1cblxuZGVzY3JpYmUoJ2Zvcm1hdFByb2dyZXNzJywgKCkgPT4ge1xuICBkZXNjcmliZSgndG9vbF9leGVjdXRpb25fc3RhcnQnLCAoKSA9PiB7XG4gICAgaXQoJ3Nob3dzIHRvb2wgbmFtZSBhbmQgc3VtbWFyaXplZCBhcmdzIGluIHZlcmJvc2UgbW9kZScsICgpID0+IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGZvcm1hdFByb2dyZXNzKHtcbiAgICAgICAgdHlwZTogJ3Rvb2xfZXhlY3V0aW9uX3N0YXJ0JyxcbiAgICAgICAgdG9vbE5hbWU6ICdiYXNoJyxcbiAgICAgICAgYXJnczogeyBjb21tYW5kOiAnbnBtIHJ1biBidWlsZCcgfSxcbiAgICAgIH0sIGN0eCgpKVxuICAgICAgYXNzZXJ0Lm9rKHJlc3VsdClcbiAgICAgIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoJ2Jhc2gnKSlcbiAgICAgIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoJ25wbSBydW4gYnVpbGQnKSlcbiAgICB9KVxuXG4gICAgaXQoJ3Nob3dzIFJlYWQgd2l0aCBmaWxlIHBhdGgnLCAoKSA9PiB7XG4gICAgICBjb25zdCByZXN1bHQgPSBmb3JtYXRQcm9ncmVzcyh7XG4gICAgICAgIHR5cGU6ICd0b29sX2V4ZWN1dGlvbl9zdGFydCcsXG4gICAgICAgIHRvb2xOYW1lOiAnUmVhZCcsXG4gICAgICAgIGFyZ3M6IHsgcGF0aDogJ3NyYy9tYWluLnRzJyB9LFxuICAgICAgfSwgY3R4KCkpXG4gICAgICBhc3NlcnQub2socmVzdWx0KVxuICAgICAgYXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcygnUmVhZCcpKVxuICAgICAgYXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcygnc3JjL21haW4udHMnKSlcbiAgICB9KVxuXG4gICAgaXQoJ3JldHVybnMgbnVsbCBpbiBub24tdmVyYm9zZSBtb2RlJywgKCkgPT4ge1xuICAgICAgY29uc3QgcmVzdWx0ID0gZm9ybWF0UHJvZ3Jlc3Moe1xuICAgICAgICB0eXBlOiAndG9vbF9leGVjdXRpb25fc3RhcnQnLFxuICAgICAgICB0b29sTmFtZTogJ2Jhc2gnLFxuICAgICAgICBhcmdzOiB7IGNvbW1hbmQ6ICducG0gcnVuIGJ1aWxkJyB9LFxuICAgICAgfSwgY3R4KHsgdmVyYm9zZTogZmFsc2UgfSkpXG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCBudWxsKVxuICAgIH0pXG5cbiAgICBpdCgnc2hvd3MgdG9vbCBuYW1lIGFsb25lIHdoZW4gbm8gYXJncycsICgpID0+IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGZvcm1hdFByb2dyZXNzKHtcbiAgICAgICAgdHlwZTogJ3Rvb2xfZXhlY3V0aW9uX3N0YXJ0JyxcbiAgICAgICAgdG9vbE5hbWU6ICd1bmtub3duX3Rvb2wnLFxuICAgICAgfSwgY3R4KCkpXG4gICAgICBhc3NlcnQub2socmVzdWx0KVxuICAgICAgYXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcygndW5rbm93bl90b29sJykpXG4gICAgfSlcbiAgfSlcblxuICBkZXNjcmliZSgndG9vbF9leGVjdXRpb25fZW5kJywgKCkgPT4ge1xuICAgIGl0KCdzaG93cyBlcnJvciB3aXRoIGR1cmF0aW9uIGluIHZlcmJvc2UgbW9kZScsICgpID0+IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGZvcm1hdFByb2dyZXNzKHtcbiAgICAgICAgdHlwZTogJ3Rvb2xfZXhlY3V0aW9uX2VuZCcsXG4gICAgICAgIHRvb2xOYW1lOiAnYmFzaCcsXG4gICAgICB9LCBjdHgoeyBpc0Vycm9yOiB0cnVlLCB0b29sRHVyYXRpb246IDE1MDAgfSkpXG4gICAgICBhc3NlcnQub2socmVzdWx0KVxuICAgICAgYXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcygnYmFzaCcpKVxuICAgICAgYXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcygnZXJyb3InKSlcbiAgICAgIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoJzEuNXMnKSlcbiAgICB9KVxuXG4gICAgaXQoJ3Nob3dzIGRvbmUgd2l0aCBkdXJhdGlvbiBpbiB2ZXJib3NlIG1vZGUnLCAoKSA9PiB7XG4gICAgICBjb25zdCByZXN1bHQgPSBmb3JtYXRQcm9ncmVzcyh7XG4gICAgICAgIHR5cGU6ICd0b29sX2V4ZWN1dGlvbl9lbmQnLFxuICAgICAgICB0b29sTmFtZTogJ3JlYWQnLFxuICAgICAgfSwgY3R4KHsgdG9vbER1cmF0aW9uOiA1MCB9KSlcbiAgICAgIGFzc2VydC5vayhyZXN1bHQpXG4gICAgICBhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKCdkb25lJykpXG4gICAgICBhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKCc1MG1zJykpXG4gICAgfSlcblxuICAgIGl0KCdyZXR1cm5zIG51bGwgaW4gbm9uLXZlcmJvc2UgbW9kZScsICgpID0+IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGZvcm1hdFByb2dyZXNzKHtcbiAgICAgICAgdHlwZTogJ3Rvb2xfZXhlY3V0aW9uX2VuZCcsXG4gICAgICAgIHRvb2xOYW1lOiAnYmFzaCcsXG4gICAgICAgIGlzRXJyb3I6IGZhbHNlLFxuICAgICAgfSwgY3R4KHsgdmVyYm9zZTogZmFsc2UgfSkpXG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCBudWxsKVxuICAgIH0pXG4gIH0pXG5cbiAgZGVzY3JpYmUoJ2FnZW50IGxpZmVjeWNsZScsICgpID0+IHtcbiAgICBpdCgnc2hvd3MgYWdlbnRfc3RhcnQnLCAoKSA9PiB7XG4gICAgICBjb25zdCByZXN1bHQgPSBmb3JtYXRQcm9ncmVzcyh7IHR5cGU6ICdhZ2VudF9zdGFydCcgfSwgY3R4KCkpXG4gICAgICBhc3NlcnQub2socmVzdWx0KVxuICAgICAgYXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcygnU2Vzc2lvbiBzdGFydGVkJykpXG4gICAgfSlcblxuICAgIGl0KCdzaG93cyBhZ2VudF9lbmQnLCAoKSA9PiB7XG4gICAgICBjb25zdCByZXN1bHQgPSBmb3JtYXRQcm9ncmVzcyh7IHR5cGU6ICdhZ2VudF9lbmQnIH0sIGN0eCgpKVxuICAgICAgYXNzZXJ0Lm9rKHJlc3VsdClcbiAgICAgIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoJ1Nlc3Npb24gZW5kZWQnKSlcbiAgICB9KVxuXG4gICAgaXQoJ3Nob3dzIGFnZW50X2VuZCB3aXRoIGNvc3QnLCAoKSA9PiB7XG4gICAgICBjb25zdCByZXN1bHQgPSBmb3JtYXRQcm9ncmVzcyh7IHR5cGU6ICdhZ2VudF9lbmQnIH0sIGN0eCh7XG4gICAgICAgIGxhc3RDb3N0OiB7IGNvc3RVc2Q6IDAuNDIsIGlucHV0VG9rZW5zOiAxMDAwMCwgb3V0cHV0VG9rZW5zOiA1MDAgfSxcbiAgICAgIH0pKVxuICAgICAgYXNzZXJ0Lm9rKHJlc3VsdClcbiAgICAgIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoJ1Nlc3Npb24gZW5kZWQnKSlcbiAgICAgIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoJyQwLjQyJykpXG4gICAgICBhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKCcxMDUwMCB0b2tlbnMnKSlcbiAgICB9KVxuICB9KVxuXG4gIGRlc2NyaWJlKCdleHRlbnNpb25fdWlfcmVxdWVzdCcsICgpID0+IHtcbiAgICBpdCgnc2hvd3Mgbm90aWZ5IHdpdGggbWVzc2FnZScsICgpID0+IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGZvcm1hdFByb2dyZXNzKHtcbiAgICAgICAgdHlwZTogJ2V4dGVuc2lvbl91aV9yZXF1ZXN0JyxcbiAgICAgICAgbWV0aG9kOiAnbm90aWZ5JyxcbiAgICAgICAgbWVzc2FnZTogJ0F1dG8tbW9kZSBzdGFydGVkJyxcbiAgICAgIH0sIGN0eCgpKVxuICAgICAgYXNzZXJ0Lm9rKHJlc3VsdClcbiAgICAgIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoJ0F1dG8tbW9kZSBzdGFydGVkJykpXG4gICAgfSlcblxuICAgIGl0KCdib2xkcyBpbXBvcnRhbnQgbm90aWZpY2F0aW9ucycsICgpID0+IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGZvcm1hdFByb2dyZXNzKHtcbiAgICAgICAgdHlwZTogJ2V4dGVuc2lvbl91aV9yZXF1ZXN0JyxcbiAgICAgICAgbWV0aG9kOiAnbm90aWZ5JyxcbiAgICAgICAgbWVzc2FnZTogJ0NvbW1pdHRlZDogZml4IGF1dGggZmxvdycsXG4gICAgICB9LCBjdHgoKSlcbiAgICAgIGFzc2VydC5vayhyZXN1bHQpXG4gICAgICBhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKCdDb21taXR0ZWQ6IGZpeCBhdXRoIGZsb3cnKSlcbiAgICB9KVxuXG4gICAgaXQoJ3N1cHByZXNzZXMgZW1wdHkgbm90aWZ5JywgKCkgPT4ge1xuICAgICAgY29uc3QgcmVzdWx0ID0gZm9ybWF0UHJvZ3Jlc3Moe1xuICAgICAgICB0eXBlOiAnZXh0ZW5zaW9uX3VpX3JlcXVlc3QnLFxuICAgICAgICBtZXRob2Q6ICdub3RpZnknLFxuICAgICAgICBtZXNzYWdlOiAnJyxcbiAgICAgIH0sIGN0eCgpKVxuICAgICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgbnVsbClcbiAgICB9KVxuXG4gICAgaXQoJ3N1cHByZXNzZXMgZW1wdHkgc2V0U3RhdHVzJywgKCkgPT4ge1xuICAgICAgY29uc3QgcmVzdWx0ID0gZm9ybWF0UHJvZ3Jlc3Moe1xuICAgICAgICB0eXBlOiAnZXh0ZW5zaW9uX3VpX3JlcXVlc3QnLFxuICAgICAgICBtZXRob2Q6ICdzZXRTdGF0dXMnLFxuICAgICAgICBzdGF0dXNLZXk6ICcnLFxuICAgICAgICBtZXNzYWdlOiAnJyxcbiAgICAgIH0sIGN0eCgpKVxuICAgICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgbnVsbClcbiAgICB9KVxuXG4gICAgaXQoJ3Nob3dzIHNldFN0YXR1cyB3aXRoIHN0YXR1c0tleSBhcyBwaGFzZScsICgpID0+IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGZvcm1hdFByb2dyZXNzKHtcbiAgICAgICAgdHlwZTogJ2V4dGVuc2lvbl91aV9yZXF1ZXN0JyxcbiAgICAgICAgbWV0aG9kOiAnc2V0U3RhdHVzJyxcbiAgICAgICAgc3RhdHVzS2V5OiAnbWlsZXN0b25lOk0wMDEnLFxuICAgICAgICBtZXNzYWdlOiAnSGVsbG8gV29ybGQgQ0xJJyxcbiAgICAgIH0sIGN0eCgpKVxuICAgICAgYXNzZXJ0Lm9rKHJlc3VsdClcbiAgICAgIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoJ01pbGVzdG9uZScpKVxuICAgICAgYXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcygnTTAwMScpKVxuICAgIH0pXG5cbiAgICBpdCgnc3VwcHJlc3NlcyBzZXRXaWRnZXQgKFRVSS1vbmx5KScsICgpID0+IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGZvcm1hdFByb2dyZXNzKHtcbiAgICAgICAgdHlwZTogJ2V4dGVuc2lvbl91aV9yZXF1ZXN0JyxcbiAgICAgICAgbWV0aG9kOiAnc2V0V2lkZ2V0JyxcbiAgICAgICAgd2lkZ2V0S2V5OiAncHJvZ3Jlc3MnLFxuICAgICAgfSwgY3R4KCkpXG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCBudWxsKVxuICAgIH0pXG4gIH0pXG5cbiAgZGVzY3JpYmUoJ3Vua25vd24gZXZlbnRzJywgKCkgPT4ge1xuICAgIGl0KCdyZXR1cm5zIG51bGwnLCAoKSA9PiB7XG4gICAgICBhc3NlcnQuZXF1YWwoZm9ybWF0UHJvZ3Jlc3MoeyB0eXBlOiAnc29tZV9yYW5kb21fZXZlbnQnIH0sIGN0eCgpKSwgbnVsbClcbiAgICB9KVxuICB9KVxufSlcblxuZGVzY3JpYmUoJ3N1bW1hcml6ZVRvb2xBcmdzJywgKCkgPT4ge1xuICBpdCgnZXh0cmFjdHMgcGF0aCBmb3IgUmVhZCcsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoc3VtbWFyaXplVG9vbEFyZ3MoJ1JlYWQnLCB7IHBhdGg6ICdzcmMvaW5kZXgudHMnIH0pLCAnc3JjL2luZGV4LnRzJylcbiAgfSlcblxuICBpdCgnZXh0cmFjdHMgcGF0aCBmb3Igd3JpdGUnLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKHN1bW1hcml6ZVRvb2xBcmdzKCd3cml0ZScsIHsgcGF0aDogJy90bXAvb3V0Lmpzb24nIH0pLCAnL3RtcC9vdXQuanNvbicpXG4gIH0pXG5cbiAgaXQoJ2V4dHJhY3RzIGZpbGVfcGF0aCBmb3IgbGVnYWN5IGNvbXBhdGliaWxpdHknLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKHN1bW1hcml6ZVRvb2xBcmdzKCdyZWFkJywgeyBmaWxlX3BhdGg6ICdzcmMvZm9vLnRzJyB9KSwgJ3NyYy9mb28udHMnKVxuICB9KVxuXG4gIGl0KCdwcmVmZXJzIHBhdGggb3ZlciBmaWxlX3BhdGggd2hlbiBib3RoIHByZXNlbnQnLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKHN1bW1hcml6ZVRvb2xBcmdzKCdyZWFkJywgeyBwYXRoOiAncmVhbC50cycsIGZpbGVfcGF0aDogJ2xlZ2FjeS50cycgfSksICdyZWFsLnRzJylcbiAgfSlcblxuICBpdCgnZXh0cmFjdHMgY29tbWFuZCBmb3IgYmFzaCcsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoc3VtbWFyaXplVG9vbEFyZ3MoJ2Jhc2gnLCB7IGNvbW1hbmQ6ICdscyAtbGEnIH0pLCAnbHMgLWxhJylcbiAgfSlcblxuICBpdCgndHJ1bmNhdGVzIGxvbmcgYmFzaCBjb21tYW5kcycsICgpID0+IHtcbiAgICBjb25zdCBsb25nQ21kID0gJ2EnLnJlcGVhdCgxMDApXG4gICAgY29uc3QgcmVzdWx0ID0gc3VtbWFyaXplVG9vbEFyZ3MoJ2Jhc2gnLCB7IGNvbW1hbmQ6IGxvbmdDbWQgfSlcbiAgICBhc3NlcnQub2socmVzdWx0LmVuZHNXaXRoKCcuLi4nKSlcbiAgICBhc3NlcnQub2socmVzdWx0Lmxlbmd0aCA8IDEwMClcbiAgfSlcblxuICBpdCgnZXh0cmFjdHMgY29tbWFuZCBmb3IgYXN5bmNfYmFzaCcsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoc3VtbWFyaXplVG9vbEFyZ3MoJ2FzeW5jX2Jhc2gnLCB7IGNvbW1hbmQ6ICducG0gcnVuIGJ1aWxkJyB9KSwgJ25wbSBydW4gYnVpbGQnKVxuICB9KVxuXG4gIGl0KCdleHRyYWN0cyBqb2JzIGZvciBhd2FpdF9qb2InLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKHN1bW1hcml6ZVRvb2xBcmdzKCdhd2FpdF9qb2InLCB7IGpvYnM6IFsnYmdfYWJjJywgJ2JnX2RlZiddIH0pLCAnYmdfYWJjLCBiZ19kZWYnKVxuICB9KVxuXG4gIGl0KCdleHRyYWN0cyBwYXR0ZXJuIGZvciBncmVwJywgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IHN1bW1hcml6ZVRvb2xBcmdzKCdncmVwJywgeyBwYXR0ZXJuOiAnVE9ETycsIGdsb2I6ICcqLnRzJyB9KVxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsICdUT0RPICoudHMnKVxuICB9KVxuXG4gIGl0KCdleHRyYWN0cyBwYXR0ZXJuIGFuZCBwYXRoIGZvciBmaW5kJywgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChzdW1tYXJpemVUb29sQXJncygnZmluZCcsIHsgcGF0dGVybjogJyoudHMnLCBwYXRoOiAnc3JjJyB9KSwgJyoudHMgaW4gc3JjJylcbiAgfSlcblxuICBpdCgnZXh0cmFjdHMgYWN0aW9uIGFuZCBmaWxlIGZvciBsc3AnLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gc3VtbWFyaXplVG9vbEFyZ3MoJ2xzcCcsIHsgYWN0aW9uOiAnZGVmaW5pdGlvbicsIGZpbGU6ICdzcmMvbWFpbi50cycsIHN5bWJvbDogJ2ZvbycgfSlcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCAnZGVmaW5pdGlvbiBzcmMvbWFpbi50cyBmb28nKVxuICB9KVxuXG4gIGl0KCdleHRyYWN0cyBwYXRoIGZvciBscycsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoc3VtbWFyaXplVG9vbEFyZ3MoJ2xzJywgeyBwYXRoOiAnc3JjL3V0aWxzJyB9KSwgJ3NyYy91dGlscycpXG4gIH0pXG5cbiAgaXQoJ3N1bW1hcml6ZXMgZ3NkIHRvb2wgd2l0aCBtaWxlc3RvbmUvc2xpY2UvdGFzayBJRHMnLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKHN1bW1hcml6ZVRvb2xBcmdzKCdnc2RfdGFza19jb21wbGV0ZScsIHtcbiAgICAgIG1pbGVzdG9uZUlkOiAnTTAwMScsIHNsaWNlSWQ6ICdTMDEnLCB0YXNrSWQ6ICdUMDEnLCBvbmVMaW5lcjogJ0J1aWx0IHRoZSB0aGluZycsXG4gICAgfSksICdNMDAxL1MwMS9UMDEgQnVpbHQgdGhlIHRoaW5nJylcbiAgfSlcblxuICBpdCgnc3VtbWFyaXplcyBnc2RfcGxhbl9taWxlc3RvbmUgd2l0aCBtaWxlc3RvbmUgSUQnLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKHN1bW1hcml6ZVRvb2xBcmdzKCdnc2RfcGxhbl9taWxlc3RvbmUnLCB7IG1pbGVzdG9uZUlkOiAnTTAwMicgfSksICdNMDAyJylcbiAgfSlcblxuICBpdCgnc3VtbWFyaXplcyBnc2RfZGVjaXNpb25fc2F2ZSB3aXRoIGRlY2lzaW9uIHRleHQnLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gc3VtbWFyaXplVG9vbEFyZ3MoJ2dzZF9kZWNpc2lvbl9zYXZlJywgeyBkZWNpc2lvbjogJ1VzZSBTUUxpdGUgZm9yIHBlcnNpc3RlbmNlJyB9KVxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsICdVc2UgU1FMaXRlIGZvciBwZXJzaXN0ZW5jZScpXG4gIH0pXG5cbiAgaXQoJ3JldHVybnMgZmlyc3Qgc3RyaW5nIHZhbHVlIGZvciB1bmtub3duIHRvb2xzJywgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChzdW1tYXJpemVUb29sQXJncygnY3VzdG9tX3Rvb2wnLCB7IHNvbWVLZXk6ICdoZWxsbycgfSksICdoZWxsbycpXG4gIH0pXG5cbiAgaXQoJ3JldHVybnMgZW1wdHkgc3RyaW5nIGZvciBubyBhcmdzJywgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChzdW1tYXJpemVUb29sQXJncygndW5rbm93bicsIHt9KSwgJycpXG4gIH0pXG5cbiAgaXQoJ2V4dHJhY3RzIHBhdGggZm9yIGVkaXQnLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKHN1bW1hcml6ZVRvb2xBcmdzKCdlZGl0JywgeyBwYXRoOiAnc3JjL2NvbmZpZy50cycgfSksICdzcmMvY29uZmlnLnRzJylcbiAgfSlcblxuICBpdCgnZXh0cmFjdHMgcGF0aCBmb3IgaGFzaGxpbmVfZWRpdCcsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoc3VtbWFyaXplVG9vbEFyZ3MoJ2hhc2hsaW5lX2VkaXQnLCB7IHBhdGg6ICdzcmMvbWFpbi50cycgfSksICdzcmMvbWFpbi50cycpXG4gIH0pXG5cbiAgaXQoJ2V4dHJhY3RzIGFnZW50IGFuZCB0YXNrIGZvciBzdWJhZ2VudCcsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoc3VtbWFyaXplVG9vbEFyZ3MoJ3N1YmFnZW50JywgeyBhZ2VudDogJ3Njb3V0JywgdGFzazogJ0ZpbmQgYXV0aCBwYXR0ZXJucycgfSksICdzY291dDogRmluZCBhdXRoIHBhdHRlcm5zJylcbiAgfSlcblxuICBpdCgnZXh0cmFjdHMgdXJsIGZvciBicm93c2VyX25hdmlnYXRlJywgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChzdW1tYXJpemVUb29sQXJncygnYnJvd3Nlcl9uYXZpZ2F0ZScsIHsgdXJsOiAnaHR0cDovL2xvY2FsaG9zdDozMDAwJyB9KSwgJ2h0dHA6Ly9sb2NhbGhvc3Q6MzAwMCcpXG4gIH0pXG59KVxuXG5kZXNjcmliZSgnZm9ybWF0VGhpbmtpbmdMaW5lJywgKCkgPT4ge1xuICBpdCgnZm9ybWF0cyBzaG9ydCB0ZXh0JywgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGZvcm1hdFRoaW5raW5nTGluZSgnQW5hbHl6aW5nIHRoZSBjb2RlYmFzZScpXG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcygnW3RoaW5raW5nXScpKVxuICAgIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoJ0FuYWx5emluZyB0aGUgY29kZWJhc2UnKSlcbiAgfSlcblxuICBpdCgndHJ1bmNhdGVzIGxvbmcgdGV4dCB0byB+MTIwIGNoYXJzJywgKCkgPT4ge1xuICAgIGNvbnN0IGxvbmdUZXh0ID0gJ3dvcmQgJy5yZXBlYXQoNTApIC8vIDI1MCBjaGFyc1xuICAgIGNvbnN0IHJlc3VsdCA9IGZvcm1hdFRoaW5raW5nTGluZShsb25nVGV4dClcbiAgICBhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKCcuLi4nKSlcbiAgfSlcblxuICBpdCgnY29sbGFwc2VzIHdoaXRlc3BhY2UnLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gZm9ybWF0VGhpbmtpbmdMaW5lKCdsaW5lIG9uZVxcblxcbmxpbmUgICB0d29cXHR0YWInKVxuICAgIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoJ2xpbmUgb25lIGxpbmUgdHdvIHRhYicpKVxuICB9KVxufSlcblxuZGVzY3JpYmUoJ2Zvcm1hdENvc3RMaW5lJywgKCkgPT4ge1xuICBpdCgnZm9ybWF0cyBjb3N0IHdpdGggdG9rZW4gY291bnQnLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gZm9ybWF0Q29zdExpbmUoMC4wNTIzLCA0MjAwLCAxMTAwKVxuICAgIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoJyQwLjA1MjMnKSlcbiAgICBhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKCc1MzAwIHRva2VucycpKVxuICB9KVxufSlcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsVUFBVSxVQUFVO0FBQzdCLE9BQU8sWUFBWTtBQUNuQixTQUFTLGdCQUFnQixvQkFBb0IsZ0JBQWdCLHlCQUF5QjtBQU10RixTQUFTLElBQUksWUFBc0MsQ0FBQyxHQUFvQjtBQUN0RSxTQUFPLEVBQUUsU0FBUyxNQUFNLEdBQUcsVUFBVTtBQUN2QztBQUVBLFNBQVMsa0JBQWtCLE1BQU07QUFDL0IsV0FBUyx3QkFBd0IsTUFBTTtBQUNyQyxPQUFHLHVEQUF1RCxNQUFNO0FBQzlELFlBQU0sU0FBUyxlQUFlO0FBQUEsUUFDNUIsTUFBTTtBQUFBLFFBQ04sVUFBVTtBQUFBLFFBQ1YsTUFBTSxFQUFFLFNBQVMsZ0JBQWdCO0FBQUEsTUFDbkMsR0FBRyxJQUFJLENBQUM7QUFDUixhQUFPLEdBQUcsTUFBTTtBQUNoQixhQUFPLEdBQUcsT0FBTyxTQUFTLE1BQU0sQ0FBQztBQUNqQyxhQUFPLEdBQUcsT0FBTyxTQUFTLGVBQWUsQ0FBQztBQUFBLElBQzVDLENBQUM7QUFFRCxPQUFHLDZCQUE2QixNQUFNO0FBQ3BDLFlBQU0sU0FBUyxlQUFlO0FBQUEsUUFDNUIsTUFBTTtBQUFBLFFBQ04sVUFBVTtBQUFBLFFBQ1YsTUFBTSxFQUFFLE1BQU0sY0FBYztBQUFBLE1BQzlCLEdBQUcsSUFBSSxDQUFDO0FBQ1IsYUFBTyxHQUFHLE1BQU07QUFDaEIsYUFBTyxHQUFHLE9BQU8sU0FBUyxNQUFNLENBQUM7QUFDakMsYUFBTyxHQUFHLE9B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
