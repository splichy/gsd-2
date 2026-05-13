import { describe, test } from "node:test";
import assert from "node:assert/strict";
import stripAnsi from "strip-ansi";
import { ToolExecutionComponent, ToolPhaseSummaryComponent } from "../tool-execution.js";
import { initTheme } from "../../theme/theme.js";
initTheme("dark", false);
function renderTool(toolName, args, result, toolDefinition) {
  const component = new ToolExecutionComponent(
    toolName,
    args,
    {},
    toolDefinition,
    { requestRender() {
    } }
  );
  component.setExpanded(true);
  if (result) component.updateResult(result);
  return stripAnsi(component.render(120).join("\n"));
}
function renderToolCollapsed(toolName, args, result, toolDefinition) {
  const component = new ToolExecutionComponent(
    toolName,
    args,
    {},
    toolDefinition,
    { requestRender() {
    } }
  );
  if (result) component.updateResult(result);
  return stripAnsi(component.render(120).join("\n"));
}
describe("ToolExecutionComponent", () => {
  test("renders framed header with running status while tool is partial", () => {
    const rendered = renderToolCollapsed("mcp__demo__do_thing", { ok: true });
    assert.match(rendered, /demo\u00b7do_thing/);
    assert.doesNotMatch(rendered, /Tool demo\u00b7do_thing/);
    assert.match(rendered, /running/);
    assert.match(rendered, /running · \d+(ms|s)/);
  });
  test("does not duplicate running generic tool labels before args", () => {
    const rendered = renderToolCollapsed(
      "Agent",
      {
        description: "Scout habit tracker codebase",
        subagent_type: "Explore",
        prompt: "Read these files and give me a concise summary of each."
      }
    );
    const labelMatches = rendered.match(/Agent/g) ?? [];
    assert.equal(labelMatches.length, 1, `expected only the card title to contain Agent:
${rendered}`);
    assert.doesNotMatch(rendered, /description="Scout habit tracker codebase"/);
    assert.doesNotMatch(rendered, /subagent_type="Explore"/);
    assert.match(rendered, /running · \d+(ms|s)/);
  });
  test("renders framed header with failed status for failed tool result", () => {
    const rendered = renderTool(
      "mcp__demo__do_thing",
      { ok: true },
      { content: [{ type: "text", text: "boom" }], isError: true }
    );
    assert.match(rendered, /demo\u00b7do_thing/);
    assert.doesNotMatch(rendered, /Tool demo\u00b7do_thing/);
    assert.match(rendered, /failed/);
    assert.match(rendered, /failed · \d+(ms|s)/);
    assert.match(rendered, /boom/);
  });
  test("collapses successful low-signal tool cards by default", () => {
    const rendered = renderToolCollapsed(
      "mcp__demo__noop",
      { ok: true },
      { content: [], isError: false }
    );
    assert.match(rendered, /success · \d+(ms|s)/);
    assert.match(rendered, /demo\u00b7noop/);
    assert.doesNotMatch(rendered, /Completed/);
    assert.doesNotMatch(rendered, /ok=true/);
  });
  test("does not duplicate generic tool labels in collapsed cards", () => {
    const rendered = renderToolCollapsed(
      "TodoWrite",
      { todos: [{ content: "Ship it", status: "pending" }] },
      { content: [{ type: "text", text: "TodoWrite" }], isError: false }
    );
    const labelMatches = rendered.match(/TodoWrite/g) ?? [];
    assert.equal(labelMatches.length, 1, `expected only the card title to contain TodoWrite:
${rendered}`);
    assert.match(rendered, /output hidden/);
    assert.match(rendered, /ctrl\+o expand/);
  });
  test("exposes phase metadata for successful low-signal tool rows", () => {
    const component = new ToolExecutionComponent(
      "gsd_requirement_update",
      { id: "R001" },
      {},
      { label: "Update Requirement" },
      { requestRender() {
      } }
    );
    component.updateResult({ content: [], isError: false });
    assert.deepEqual(component.getRollupPhase()?.label, "Requirement writes");
  });
  test("exposes phase metadata for collapsed output-bearing generic tools", () => {
    const component = new ToolExecutionComponent(
      "mcp__demo__do_thing",
      { ok: true },
      {},
      void 0,
      { requestRender() {
      } }
    );
    component.updateResult({ content: [{ type: "text", text: "important output" }], isError: false });
    assert.deepEqual(component.getRollupPhase()?.label, "Other tool actions");
  });
  test("renders compact read rows with target metadata", () => {
    const rendered = renderToolCollapsed(
      "read",
      { path: "src/Inspector.tsx" },
      {
        content: [{ type: "text", text: "source" }],
        isError: false,
        details: {
          target: {
            kind: "file",
            action: "read",
            inputPath: "src/Inspector.tsx",
            resolvedPath: "/tmp/project/src/Inspector.tsx",
            range: { start: 4, end: 12 }
          }
        }
      }
    );
    assert.match(rendered, /Read/);
    assert.match(rendered, /src\/Inspector\.tsx:4-12/);
    assert.doesNotMatch(rendered, /source/);
    assert.doesNotMatch(rendered, /output hidden\n\s*│\s*ctrl\+o expand/);
  });
  test("renders compact capitalized read rows from file_path args", () => {
    const rendered = renderToolCollapsed(
      "Read",
      { file_path: "~/Github/gsd-2/src/resources/extensions/gsd/health-widget-core.ts" },
      { content: [{ type: "text", text: "hidden body output" }], isError: false }
    );
    assert.match(rendered, /Read/);
    assert.match(rendered, /health-widget-core\.ts/);
    assert.doesNotMatch(rendered, /hidden body output/);
  });
  test("renders compact read rows from direct result details path", () => {
    const rendered = renderToolCollapsed(
      "read",
      {},
      {
        content: [{ type: "text", text: "hidden body output" }],
        isError: false,
        details: {
          path: "/tmp/project/src/resources/extensions/gsd/health-widget-core.ts",
          range: { start: 1, end: 12 }
        }
      }
    );
    assert.match(rendered, /Read/);
    assert.match(rendered, /health-widget-core\.ts:1-12/);
    assert.doesNotMatch(rendered, /hidden body output/);
  });
  test("renders compact edit rows with target metadata", () => {
    const rendered = renderToolCollapsed(
      "edit",
      { path: "src/Inspector.tsx" },
      {
        content: [{ type: "text", text: "Updated src/Inspector.tsx" }],
        isError: false,
        details: {
          target: {
            kind: "file",
            action: "edit",
            inputPath: "src/Inspector.tsx",
            resolvedPath: "/tmp/project/src/Inspector.tsx",
            line: 42
          }
        }
      }
    );
    assert.match(rendered, /Edit/);
    assert.match(rendered, /src\/Inspector\.tsx:42/);
    assert.doesNotMatch(rendered, /Updated src\/Inspector\.tsx/);
  });
  test("renders running edit rows with title and target on the top line", () => {
    const rendered = renderToolCollapsed("edit", { path: "src/Inspector.tsx" });
    const labelMatches = rendered.match(/Edit/g) ?? [];
    assert.equal(labelMatches.length, 1, `expected tool name only in the card title:
${rendered}`);
    assert.match(rendered, /src\/Inspector\.tsx/);
    assert.match(rendered, /Edit src\/Inspector\.tsx/);
    assert.match(rendered, /running · \d+(ms|s)/);
  });
  test("renders compact write rows with target metadata", () => {
    const rendered = renderToolCollapsed(
      "write",
      { path: "src/output.ts", content: "ok" },
      {
        content: [{ type: "text", text: "Successfully wrote 2 bytes to src/output.ts" }],
        isError: false,
        details: {
          target: {
            kind: "file",
            action: "write",
            inputPath: "src/output.ts",
            resolvedPath: "/tmp/project/src/output.ts"
          }
        }
      }
    );
    assert.match(rendered, /Write/);
    assert.match(rendered, /src\/output\.ts/);
    assert.doesNotMatch(rendered, /Successfully wrote/);
  });
  test("omits default cwd placeholders for collapsed search tools", () => {
    const rendered = renderToolCollapsed(
      "Grep",
      {},
      { content: [{ type: "text", text: "hidden body output" }], isError: false }
    );
    assert.match(rendered, /Grep/);
    assert.doesNotMatch(rendered, /^│\.\s+│/m, `expected no placeholder cwd body:
${rendered}`);
    assert.match(rendered, /output hidden/);
    assert.doesNotMatch(rendered, /hidden body output/);
    assert.doesNotMatch(rendered, /^│\s+output hidden/m, `expected compact footer text on the top row:
${rendered}`);
  });
  test("keeps meaningful collapsed search targets", () => {
    const rendered = renderToolCollapsed(
      "Grep",
      { pattern: "Project Initialized", path: "src/resources/extensions/gsd", glob: "*.ts" },
      { content: [{ type: "text", text: "hidden body output" }], isError: false }
    );
    assert.match(rendered, /Project Initialized in src\/resources\/extensions\/gsd \(\*\.ts\)/);
    assert.doesNotMatch(rendered, /hidden body output/);
  });
  test("renders compact bash rows with command preview", () => {
    const rendered = renderToolCollapsed(
      "bash",
      { command: "npm run typecheck -- --watch false" },
      { content: [{ type: "text", text: "ok" }], isError: false, details: { cwd: "/tmp/project" } }
    );
    assert.match(rendered, /\$ npm run typecheck -- --watch false/);
    assert.doesNotMatch(rendered, /├/, "collapsed command cards should not include internal divider lines");
    assert.doesNotMatch(rendered, /\bok\b/);
  });
  test("keeps failed tools expanded and error visible", () => {
    const rendered = renderToolCollapsed(
      "edit",
      { path: "src/Inspector.tsx" },
      {
        content: [{ type: "text", text: "Could not find target text" }],
        isError: true,
        details: {
          target: {
            kind: "file",
            action: "edit",
            inputPath: "src/Inspector.tsx",
            resolvedPath: "/tmp/project/src/Inspector.tsx"
          }
        }
      }
    );
    assert.match(rendered, /Could not find target text/);
    assert.match(rendered, /edit/);
  });
  test("renders phase-based summaries for rolled-up tool executions", () => {
    const phases = [
      { label: "Setup / shell", count: 6, durationMs: 12 },
      {
        label: "Context reads",
        count: 4,
        durationMs: 6,
        actionLabel: "read",
        targets: ["/tmp/project/src/a.ts", "/tmp/project/src/b.ts"]
      },
      {
        label: "File changes",
        count: 3,
        durationMs: 5,
        actionLabel: "edit",
        targets: ["/tmp/project/src/Inspector.tsx:42", "/tmp/project/src/CompareView.tsx:8"]
      },
      { label: "Requirement writes", count: 4, durationMs: 4 },
      { label: "Memory lookups", count: 4, durationMs: 4 },
      { label: "Finalization", count: 1, durationMs: 1 }
    ];
    const rendered = stripAnsi(new ToolPhaseSummaryComponent(phases).render(120).join("\n"));
    assert.match(rendered, /Setup \/ shell 6 actions\s+success · 12ms/);
    assert.match(rendered, /Context reads · 2 files\s+success · 6ms/);
    assert.match(rendered, /src\/a\.ts/);
    assert.match(rendered, /File changes · 2 files, 3 edits\s+success · 5ms/);
    assert.match(rendered, /src\/Inspector\.tsx:42/);
    assert.match(rendered, /Requirement writes 4 actions\s+success · 4ms/);
    assert.match(rendered, /Memory lookups 4 actions\s+success · 4ms/);
    assert.match(rendered, /Finalization 1 action\s+success · 1ms/);
  });
  test("passes failed result status to custom result renderers", () => {
    const rendered = renderTool(
      "gsd_requirement_save",
      { id: "R001" },
      { content: [{ type: "text", text: "saved" }], isError: true },
      {
        label: "Save Requirement",
        renderResult(result) {
          return {
            render: () => [result.isError ? "custom saw error" : "custom saw success"],
            invalidate() {
            }
          };
        }
      }
    );
    assert.match(rendered, /failed/);
    assert.match(rendered, /custom saw error/);
    assert.doesNotMatch(rendered, /custom saw success/);
  });
  test("renders capitalized Claude Code Bash tool names with bash output instead of generic args JSON", () => {
    const rendered = renderTool(
      "Bash",
      { command: "pwd" },
      { content: [{ type: "text", text: "/tmp/gsd-pr-fix" }], isError: false }
    );
    assert.match(rendered, /\$ pwd/);
    assert.match(rendered, /\/tmp\/gsd-pr-fix/);
    assert.doesNotMatch(rendered, /^\{\s*\}$/m);
  });
  test("renders capitalized Claude Code Read tool names with read output", () => {
    const rendered = renderTool(
      "Read",
      { path: "/tmp/demo.txt" },
      { content: [{ type: "text", text: "hello\nworld" }], isError: false }
    );
    assert.match(rendered, /read .*demo\.txt/);
    assert.match(rendered, /hello/);
    assert.match(rendered, /world/);
  });
  test("generic fallback strips mcp__<server>__ prefix and shows server\xB7tool title", () => {
    const rendered = renderTool(
      "mcp__context7__resolve_library_id",
      { name: "react" },
      { content: [{ type: "text", text: "react@18.3.1" }], isError: false }
    );
    assert.match(rendered, /context7\u00b7resolve_library_id/);
    assert.doesNotMatch(rendered, /mcp__/);
    assert.match(rendered, /name="react"/);
    assert.match(rendered, /react@18\.3\.1/);
  });
  test("generic fallback renders compact key=value args for primitive args", () => {
    const rendered = renderTool(
      "some_unknown_tool",
      { count: 3, enabled: true, label: "hello" }
    );
    assert.match(rendered, /Some Unknown Tool/);
    assert.match(rendered, /count=3/);
    assert.match(rendered, /enabled=true/);
    assert.match(rendered, /label="hello"/);
    assert.doesNotMatch(rendered, /^\{$/m);
  });
  test("frame header prefers toolDefinition.label over raw tool name", () => {
    const rendered = renderToolCollapsed(
      "gsd_slice_complete",
      { sliceId: "S03" },
      void 0,
      { label: "Complete Slice" }
    );
    assert.match(rendered, /Complete Slice/);
    assert.doesNotMatch(rendered, /Tool Complete Slice/);
    assert.doesNotMatch(rendered, /gsd_slice_complete/);
  });
  test("frame header strips gsd_ prefix and title-cases when no label is registered", () => {
    const rendered = renderToolCollapsed("gsd_requirement_update", { id: "R005" });
    assert.match(rendered, /Requirement Update/);
    assert.doesNotMatch(rendered, /Tool Requirement Update/);
    assert.doesNotMatch(rendered, /gsd_requirement_update/);
  });
  test("collapsed generic running tools hide primitive args", () => {
    const longPath = "/Users/alice/.gsd/projects/4dce7b775013/worktrees/slice-S03-some-long-path-that-exceeds-limit";
    const rendered = renderToolCollapsed("gsd_slice_complete", {
      sliceId: "S03",
      milestoneId: "M001",
      worktree: longPath
    });
    assert.match(rendered, /Slice Complete/);
    assert.match(rendered, /running · \d+(ms|s)/);
    assert.doesNotMatch(rendered, /sliceId="S03"/);
    assert.doesNotMatch(rendered, /milestoneId="M001"/);
    assert.doesNotMatch(rendered, /worktree=/);
    assert.doesNotMatch(rendered, /"sliceId":\s*"S03"/);
  });
  test("formatCompactArgs shows full string values when expanded", () => {
    const longPath = "/Users/alice/.gsd/projects/4dce7b775013/worktrees/slice-S03-some-long-path-that-exceeds-limit";
    const rendered = renderTool("gsd_slice_complete", {
      sliceId: "S03",
      worktree: longPath
    });
    assert.match(rendered, new RegExp(longPath.replace(/\//g, "\\/")));
    assert.doesNotMatch(rendered, /…/);
  });
  test("generic fallback collapses successful output rows until expanded", () => {
    const longOutput = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join("\n");
    const rendered = renderToolCollapsed(
      "mcp__demo__do_thing",
      { ok: true },
      { content: [{ type: "text", text: longOutput }], isError: false }
    );
    assert.match(rendered, /demo\u00b7do_thing/);
    assert.match(rendered, /success · \d+(ms|s)/);
    assert.doesNotMatch(rendered, /line 1\b/);
    assert.doesNotMatch(rendered, /\(15 more lines/);
  });
  test("generic fallback falls back to truncated JSON for complex args", () => {
    const rendered = renderTool(
      "mcp__demo__nested",
      { payload: { nested: { deeply: ["a", "b", "c"] } }, name: "x" }
    );
    assert.match(rendered, /demo\u00b7nested/);
    assert.match(rendered, /"payload"/);
    assert.match(rendered, /"nested"/);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9tb2Rlcy9pbnRlcmFjdGl2ZS9jb21wb25lbnRzL19fdGVzdHNfXy90b29sLWV4ZWN1dGlvbi50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBQcm9qZWN0L0FwcDogR1NELTJcbi8vIEZpbGUgUHVycG9zZTogVGVzdHMgZm9yIGludGVyYWN0aXZlIHRlcm1pbmFsIHRvb2wgZXhlY3V0aW9uIHJlbmRlcmluZy5cbmltcG9ydCB7IGRlc2NyaWJlLCB0ZXN0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgc3RyaXBBbnNpIGZyb20gXCJzdHJpcC1hbnNpXCI7XG5pbXBvcnQgeyBUb29sRXhlY3V0aW9uQ29tcG9uZW50LCBUb29sUGhhc2VTdW1tYXJ5Q29tcG9uZW50LCB0eXBlIFRvb2xFeGVjdXRpb25QaGFzZSB9IGZyb20gXCIuLi90b29sLWV4ZWN1dGlvbi5qc1wiO1xuaW1wb3J0IHsgaW5pdFRoZW1lIH0gZnJvbSBcIi4uLy4uL3RoZW1lL3RoZW1lLmpzXCI7XG5cbmluaXRUaGVtZShcImRhcmtcIiwgZmFsc2UpO1xuXG5mdW5jdGlvbiByZW5kZXJUb29sKFxuXHR0b29sTmFtZTogc3RyaW5nLFxuXHRhcmdzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcblx0cmVzdWx0Pzoge1xuXHRcdGNvbnRlbnQ6IEFycmF5PHsgdHlwZTogc3RyaW5nOyB0ZXh0Pzogc3RyaW5nIH0+O1xuXHRcdGlzRXJyb3I6IGJvb2xlYW47XG5cdFx0ZGV0YWlscz86IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuXHR9LFxuXHR0b29sRGVmaW5pdGlvbj86IHsgbGFiZWw/OiBzdHJpbmc7IHJlbmRlckNhbGw/OiAoLi4uYXJnczogYW55W10pID0+IGFueTsgcmVuZGVyUmVzdWx0PzogKC4uLmFyZ3M6IGFueVtdKSA9PiBhbnkgfSxcbik6IHN0cmluZyB7XG5cdGNvbnN0IGNvbXBvbmVudCA9IG5ldyBUb29sRXhlY3V0aW9uQ29tcG9uZW50KFxuXHRcdHRvb2xOYW1lLFxuXHRcdGFyZ3MsXG5cdFx0e30sXG5cdFx0dG9vbERlZmluaXRpb24gYXMgYW55LFxuXHRcdHsgcmVxdWVzdFJlbmRlcigpIHt9IH0gYXMgYW55LFxuXHQpO1xuXHRjb21wb25lbnQuc2V0RXhwYW5kZWQodHJ1ZSk7XG5cdGlmIChyZXN1bHQpIGNvbXBvbmVudC51cGRhdGVSZXN1bHQocmVzdWx0KTtcblx0cmV0dXJuIHN0cmlwQW5zaShjb21wb25lbnQucmVuZGVyKDEyMCkuam9pbihcIlxcblwiKSk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlclRvb2xDb2xsYXBzZWQoXG5cdHRvb2xOYW1lOiBzdHJpbmcsXG5cdGFyZ3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuXHRyZXN1bHQ/OiB7XG5cdFx0Y29udGVudDogQXJyYXk8eyB0eXBlOiBzdHJpbmc7IHRleHQ/OiBzdHJpbmcgfT47XG5cdFx0aXNFcnJvcjogYm9vbGVhbjtcblx0XHRkZXRhaWxzPzogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG5cdH0sXG5cdHRvb2xEZWZpbml0aW9uPzogeyBsYWJlbD86IHN0cmluZzsgcmVuZGVyQ2FsbD86ICguLi5hcmdzOiBhbnlbXSkgPT4gYW55OyByZW5kZXJSZXN1bHQ/OiAoLi4uYXJnczogYW55W10pID0+IGFueSB9LFxuKTogc3RyaW5nIHtcblx0Y29uc3QgY29tcG9uZW50ID0gbmV3IFRvb2xFeGVjdXRpb25Db21wb25lbnQoXG5cdFx0dG9vbE5hbWUsXG5cdFx0YXJncyxcblx0XHR7fSxcblx0XHR0b29sRGVmaW5pdGlvbiBhcyBhbnksXG5cdFx0eyByZXF1ZXN0UmVuZGVyKCkge30gfSBhcyBhbnksXG5cdCk7XG5cdGlmIChyZXN1bHQpIGNvbXBvbmVudC51cGRhdGVSZXN1bHQocmVzdWx0KTtcblx0cmV0dXJuIHN0cmlwQW5zaShjb21wb25lbnQucmVuZGVyKDEyMCkuam9pbihcIlxcblwiKSk7XG59XG5cbmRlc2NyaWJlKFwiVG9vbEV4ZWN1dGlvbkNvbXBvbmVudFwiLCAoKSA9PiB7XG5cdHRlc3QoXCJyZW5kZXJzIGZyYW1lZCBoZWFkZXIgd2l0aCBydW5uaW5nIHN0YXR1cyB3aGlsZSB0b29sIGlzIHBhcnRpYWxcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlbmRlcmVkID0gcmVuZGVyVG9vbENvbGxhcHNlZChcIm1jcF9fZGVtb19fZG9fdGhpbmdcIiwgeyBvazogdHJ1ZSB9KTtcblxuXHRcdGFzc2VydC5tYXRjaChyZW5kZXJlZCwgL2RlbW9cXHUwMGI3ZG9fdGhpbmcvKTtcblx0XHRhc3NlcnQuZG9lc05vdE1hdGNoKHJlbmRlcmVkLCAvVG9vbCBkZW1vXFx1MDBiN2RvX3RoaW5nLyk7XG5cdFx0YXNzZXJ0Lm1hdGNoKHJlbmRlcmVkLCAvcnVubmluZy8pO1xuXHRcdGFzc2VydC5tYXRjaChyZW5kZXJlZCwgL3J1bm5pbmcgXHUwMEI3IFxcZCsobXN8cykvKTtcblx0fSk7XG5cblx0dGVzdChcImRvZXMgbm90IGR1cGxpY2F0ZSBydW5uaW5nIGdlbmVyaWMgdG9vbCBsYWJlbHMgYmVmb3JlIGFyZ3NcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlbmRlcmVkID0gcmVuZGVyVG9vbENvbGxhcHNlZChcblx0XHRcdFwiQWdlbnRcIixcblx0XHRcdHtcblx0XHRcdFx0ZGVzY3JpcHRpb246IFwiU2NvdXQgaGFiaXQgdHJhY2tlciBjb2RlYmFzZVwiLFxuXHRcdFx0XHRzdWJhZ2VudF90eXBlOiBcIkV4cGxvcmVcIixcblx0XHRcdFx0cHJvbXB0OiBcIlJlYWQgdGhlc2UgZmlsZXMgYW5kIGdpdmUgbWUgYSBjb25jaXNlIHN1bW1hcnkgb2YgZWFjaC5cIixcblx0XHRcdH0sXG5cdFx0KTtcblxuXHRcdGNvbnN0IGxhYmVsTWF0Y2hlcyA9IHJlbmRlcmVkLm1hdGNoKC9BZ2VudC9nKSA/PyBbXTtcblx0XHRhc3NlcnQuZXF1YWwobGFiZWxNYXRjaGVzLmxlbmd0aCwgMSwgYGV4cGVjdGVkIG9ubHkgdGhlIGNhcmQgdGl0bGUgdG8gY29udGFpbiBBZ2VudDpcXG4ke3JlbmRlcmVkfWApO1xuXHRcdGFzc2VydC5kb2VzTm90TWF0Y2gocmVuZGVyZWQsIC9kZXNjcmlwdGlvbj1cIlNjb3V0IGhhYml0IHRyYWNrZXIgY29kZWJhc2VcIi8pO1xuXHRcdGFzc2VydC5kb2VzTm90TWF0Y2gocmVuZGVyZWQsIC9zdWJhZ2VudF90eXBlPVwiRXhwbG9yZVwiLyk7XG5cdFx0YXNzZXJ0Lm1hdGNoKHJlbmRlcmVkLCAvcnVubmluZyBcdTAwQjcgXFxkKyhtc3xzKS8pO1xuXHR9KTtcblxuXHR0ZXN0KFwicmVuZGVycyBmcmFtZWQgaGVhZGVyIHdpdGggZmFpbGVkIHN0YXR1cyBmb3IgZmFpbGVkIHRvb2wgcmVzdWx0XCIsICgpID0+IHtcblx0XHRjb25zdCByZW5kZXJlZCA9IHJlbmRlclRvb2woXG5cdFx0XHRcIm1jcF9fZGVtb19fZG9fdGhpbmdcIixcblx0XHRcdHsgb2s6IHRydWUgfSxcblx0XHRcdHsgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiYm9vbVwiIH1dLCBpc0Vycm9yOiB0cnVlIH0sXG5cdFx0KTtcblxuXHRcdGFzc2VydC5tYXRjaChyZW5kZXJlZCwgL2RlbW9cXHUwMGI3ZG9fdGhpbmcvKTtcblx0XHRhc3NlcnQuZG9lc05vdE1hdGNoKHJlbmRlcmVkLCAvVG9vbCBkZW1vXFx1MDBiN2RvX3RoaW5nLyk7XG5cdFx0YXNzZXJ0Lm1hdGNoKHJlbmRlcmVkLCAvZmFpbGVkLyk7XG5cdFx0YXNzZXJ0Lm1hdGNoKHJlbmRlcmVkLCAvZmFpbGVkIFx1MDBCNyBcXGQrKG1zfHMpLyk7XG5cdFx0YXNzZXJ0Lm1hdGNoKHJlbmRlcmVkLCAvYm9vbS8pO1xuXHR9KTtcblxuXHR0ZXN0KFwiY29sbGFwc2VzIHN1Y2Nlc3NmdWwgbG93LXNpZ25hbCB0b29sIGNhcmRzIGJ5IGRlZmF1bHRcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlbmRlcmVkID0gcmVuZGVyVG9vbENvbGxhcHNlZChcblx0XHRcdFwibWNwX19kZW1vX19ub29wXCIsXG5cdFx0XHR7IG9rOiB0cnVlIH0sXG5cdFx0XHR7IGNvbnRlbnQ6IFtdLCBpc0Vycm9yOiBmYWxzZSB9LFxuXHRcdCk7XG5cblx0XHRhc3NlcnQubWF0Y2gocmVuZGVyZWQsIC9zdWNjZXNzIFx1MDBCNyBcXGQrKG1zfHMpLyk7XG5cdFx0YXNzZXJ0Lm1hdGNoKHJlbmRlcmVkLCAvZGVtb1xcdTAwYjdub29wLyk7XG5cdFx0YXNzZXJ0LmRvZXNOb3RNYXRjaChyZW5kZXJlZCwgL0NvbXBsZXRlZC8pO1xuXHRcdGFzc2VydC5kb2VzTm90TWF0Y2gocmVuZGVyZWQsIC9vaz10cnVlLyk7XG5cdH0pO1xuXG5cdHRlc3QoXCJkb2VzIG5vdCBkdXBsaWNhdGUgZ2VuZXJpYyB0b29sIGxhYmVscyBpbiBjb2xsYXBzZWQgY2FyZHNcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlbmRlcmVkID0gcmVuZGVyVG9vbENvbGxhcHNlZChcblx0XHRcdFwiVG9kb1dyaXRlXCIsXG5cdFx0XHR7IHRvZG9zOiBbeyBjb250ZW50OiBcIlNoaXAgaXRcIiwgc3RhdHVzOiBcInBlbmRpbmdcIiB9XSB9LFxuXHRcdFx0eyBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJUb2RvV3JpdGVcIiB9XSwgaXNFcnJvcjogZmFsc2UgfSxcblx0XHQpO1xuXG5cdFx0Y29uc3QgbGFiZWxNYXRjaGVzID0gcmVuZGVyZWQubWF0Y2goL1RvZG9Xcml0ZS9nKSA/PyBbXTtcblx0XHRhc3NlcnQuZXF1YWwobGFiZWxNYXRjaGVzLmxlbmd0aCwgMSwgYGV4cGVjdGVkIG9ubHkgdGhlIGNhcmQgdGl0bGUgdG8gY29udGFpbiBUb2RvV3JpdGU6XFxuJHtyZW5kZXJlZH1gKTtcblx0XHRhc3NlcnQubWF0Y2gocmVuZGVyZWQsIC9vdXRwdXQgaGlkZGVuLyk7XG5cdFx0YXNzZXJ0Lm1hdGNoKHJlbmRlcmVkLCAvY3RybFxcK28gZXhwYW5kLyk7XG5cdH0pO1xuXG5cdHRlc3QoXCJleHBvc2VzIHBoYXNlIG1ldGFkYXRhIGZvciBzdWNjZXNzZnVsIGxvdy1zaWduYWwgdG9vbCByb3dzXCIsICgpID0+IHtcblx0XHRjb25zdCBjb21wb25lbnQgPSBuZXcgVG9vbEV4ZWN1dGlvbkNvbXBvbmVudChcblx0XHRcdFwiZ3NkX3JlcXVpcmVtZW50X3VwZGF0ZVwiLFxuXHRcdFx0eyBpZDogXCJSMDAxXCIgfSxcblx0XHRcdHt9LFxuXHRcdFx0eyBsYWJlbDogXCJVcGRhdGUgUmVxdWlyZW1lbnRcIiB9IGFzIGFueSxcblx0XHRcdHsgcmVxdWVzdFJlbmRlcigpIHt9IH0gYXMgYW55LFxuXHRcdCk7XG5cdFx0Y29tcG9uZW50LnVwZGF0ZVJlc3VsdCh7IGNvbnRlbnQ6IFtdLCBpc0Vycm9yOiBmYWxzZSB9KTtcblxuXHRcdGFzc2VydC5kZWVwRXF1YWwoY29tcG9uZW50LmdldFJvbGx1cFBoYXNlKCk/LmxhYmVsLCBcIlJlcXVpcmVtZW50IHdyaXRlc1wiKTtcblx0fSk7XG5cblx0dGVzdChcImV4cG9zZXMgcGhhc2UgbWV0YWRhdGEgZm9yIGNvbGxhcHNlZCBvdXRwdXQtYmVhcmluZyBnZW5lcmljIHRvb2xzXCIsICgpID0+IHtcblx0XHRjb25zdCBjb21wb25lbnQgPSBuZXcgVG9vbEV4ZWN1dGlvbkNvbXBvbmVudChcblx0XHRcdFwibWNwX19kZW1vX19kb190aGluZ1wiLFxuXHRcdFx0eyBvazogdHJ1ZSB9LFxuXHRcdFx0e30sXG5cdFx0XHR1bmRlZmluZWQsXG5cdFx0XHR7IHJlcXVlc3RSZW5kZXIoKSB7fSB9IGFzIGFueSxcblx0XHQpO1xuXHRcdGNvbXBvbmVudC51cGRhdGVSZXN1bHQoeyBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJpbXBvcnRhbnQgb3V0cHV0XCIgfV0sIGlzRXJyb3I6IGZhbHNlIH0pO1xuXG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChjb21wb25lbnQuZ2V0Um9sbHVwUGhhc2UoKT8ubGFiZWwsIFwiT3RoZXIgdG9vbCBhY3Rpb25zXCIpO1xuXHR9KTtcblxuXHR0ZXN0KFwicmVuZGVycyBjb21wYWN0IHJlYWQgcm93cyB3aXRoIHRhcmdldCBtZXRhZGF0YVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVuZGVyZWQgPSByZW5kZXJUb29sQ29sbGFwc2VkKFxuXHRcdFx0XCJyZWFkXCIsXG5cdFx0XHR7IHBhdGg6IFwic3JjL0luc3BlY3Rvci50c3hcIiB9LFxuXHRcdFx0e1xuXHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJzb3VyY2VcIiB9XSxcblx0XHRcdFx0aXNFcnJvcjogZmFsc2UsXG5cdFx0XHRcdGRldGFpbHM6IHtcblx0XHRcdFx0XHR0YXJnZXQ6IHtcblx0XHRcdFx0XHRcdGtpbmQ6IFwiZmlsZVwiLFxuXHRcdFx0XHRcdFx0YWN0aW9uOiBcInJlYWRcIixcblx0XHRcdFx0XHRcdGlucHV0UGF0aDogXCJzcmMvSW5zcGVjdG9yLnRzeFwiLFxuXHRcdFx0XHRcdFx0cmVzb2x2ZWRQYXRoOiBcIi90bXAvcHJvamVjdC9zcmMvSW5zcGVjdG9yLnRzeFwiLFxuXHRcdFx0XHRcdFx0cmFuZ2U6IHsgc3RhcnQ6IDQsIGVuZDogMTIgfSxcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHR9LFxuXHRcdFx0fSxcblx0XHQpO1xuXG5cdFx0YXNzZXJ0Lm1hdGNoKHJlbmRlcmVkLCAvUmVhZC8pO1xuXHRcdGFzc2VydC5tYXRjaChyZW5kZXJlZCwgL3NyY1xcL0luc3BlY3RvclxcLnRzeDo0LTEyLyk7XG5cdFx0YXNzZXJ0LmRvZXNOb3RNYXRjaChyZW5kZXJlZCwgL3NvdXJjZS8pO1xuXHRcdGFzc2VydC5kb2VzTm90TWF0Y2gocmVuZGVyZWQsIC9vdXRwdXQgaGlkZGVuXFxuXFxzKlx1MjUwMlxccypjdHJsXFwrbyBleHBhbmQvKTtcblx0fSk7XG5cblx0dGVzdChcInJlbmRlcnMgY29tcGFjdCBjYXBpdGFsaXplZCByZWFkIHJvd3MgZnJvbSBmaWxlX3BhdGggYXJnc1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVuZGVyZWQgPSByZW5kZXJUb29sQ29sbGFwc2VkKFxuXHRcdFx0XCJSZWFkXCIsXG5cdFx0XHR7IGZpbGVfcGF0aDogXCJ+L0dpdGh1Yi9nc2QtMi9zcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL2hlYWx0aC13aWRnZXQtY29yZS50c1wiIH0sXG5cdFx0XHR7IGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcImhpZGRlbiBib2R5IG91dHB1dFwiIH1dLCBpc0Vycm9yOiBmYWxzZSB9LFxuXHRcdCk7XG5cblx0XHRhc3NlcnQubWF0Y2gocmVuZGVyZWQsIC9SZWFkLyk7XG5cdFx0YXNzZXJ0Lm1hdGNoKHJlbmRlcmVkLCAvaGVhbHRoLXdpZGdldC1jb3JlXFwudHMvKTtcblx0XHRhc3NlcnQuZG9lc05vdE1hdGNoKHJlbmRlcmVkLCAvaGlkZGVuIGJvZHkgb3V0cHV0Lyk7XG5cdH0pO1xuXG5cdHRlc3QoXCJyZW5kZXJzIGNvbXBhY3QgcmVhZCByb3dzIGZyb20gZGlyZWN0IHJlc3VsdCBkZXRhaWxzIHBhdGhcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlbmRlcmVkID0gcmVuZGVyVG9vbENvbGxhcHNlZChcblx0XHRcdFwicmVhZFwiLFxuXHRcdFx0e30sXG5cdFx0XHR7XG5cdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcImhpZGRlbiBib2R5IG91dHB1dFwiIH1dLFxuXHRcdFx0XHRpc0Vycm9yOiBmYWxzZSxcblx0XHRcdFx0ZGV0YWlsczoge1xuXHRcdFx0XHRcdHBhdGg6IFwiL3RtcC9wcm9qZWN0L3NyYy9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvaGVhbHRoLXdpZGdldC1jb3JlLnRzXCIsXG5cdFx0XHRcdFx0cmFuZ2U6IHsgc3RhcnQ6IDEsIGVuZDogMTIgfSxcblx0XHRcdFx0fSxcblx0XHRcdH0sXG5cdFx0KTtcblxuXHRcdGFzc2VydC5tYXRjaChyZW5kZXJlZCwgL1JlYWQvKTtcblx0XHRhc3NlcnQubWF0Y2gocmVuZGVyZWQsIC9oZWFsdGgtd2lkZ2V0LWNvcmVcXC50czoxLTEyLyk7XG5cdFx0YXNzZXJ0LmRvZXNOb3RNYXRjaChyZW5kZXJlZCwgL2hpZGRlbiBib2R5IG91dHB1dC8pO1xuXHR9KTtcblxuXHR0ZXN0KFwicmVuZGVycyBjb21wYWN0IGVkaXQgcm93cyB3aXRoIHRhcmdldCBtZXRhZGF0YVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVuZGVyZWQgPSByZW5kZXJUb29sQ29sbGFwc2VkKFxuXHRcdFx0XCJlZGl0XCIsXG5cdFx0XHR7IHBhdGg6IFwic3JjL0luc3BlY3Rvci50c3hcIiB9LFxuXHRcdFx0e1xuXHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJVcGRhdGVkIHNyYy9JbnNwZWN0b3IudHN4XCIgfV0sXG5cdFx0XHRcdGlzRXJyb3I6IGZhbHNlLFxuXHRcdFx0XHRkZXRhaWxzOiB7XG5cdFx0XHRcdFx0dGFyZ2V0OiB7XG5cdFx0XHRcdFx0XHRraW5kOiBcImZpbGVcIixcblx0XHRcdFx0XHRcdGFjdGlvbjogXCJlZGl0XCIsXG5cdFx0XHRcdFx0XHRpbnB1dFBhdGg6IFwic3JjL0luc3BlY3Rvci50c3hcIixcblx0XHRcdFx0XHRcdHJlc29sdmVkUGF0aDogXCIvdG1wL3Byb2plY3Qvc3JjL0luc3BlY3Rvci50c3hcIixcblx0XHRcdFx0XHRcdGxpbmU6IDQyLFxuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdH0sXG5cdFx0XHR9LFxuXHRcdCk7XG5cblx0XHRhc3NlcnQubWF0Y2gocmVuZGVyZWQsIC9FZGl0Lyk7XG5cdFx0YXNzZXJ0Lm1hdGNoKHJlbmRlcmVkLCAvc3JjXFwvSW5zcGVjdG9yXFwudHN4OjQyLyk7XG5cdFx0YXNzZXJ0LmRvZXNOb3RNYXRjaChyZW5kZXJlZCwgL1VwZGF0ZWQgc3JjXFwvSW5zcGVjdG9yXFwudHN4Lyk7XG5cdH0pO1xuXG5cdHRlc3QoXCJyZW5kZXJzIHJ1bm5pbmcgZWRpdCByb3dzIHdpdGggdGl0bGUgYW5kIHRhcmdldCBvbiB0aGUgdG9wIGxpbmVcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlbmRlcmVkID0gcmVuZGVyVG9vbENvbGxhcHNlZChcImVkaXRcIiwgeyBwYXRoOiBcInNyYy9JbnNwZWN0b3IudHN4XCIgfSk7XG5cblx0XHRjb25zdCBsYWJlbE1hdGNoZXMgPSByZW5kZXJlZC5tYXRjaCgvRWRpdC9nKSA/PyBbXTtcblx0XHRhc3NlcnQuZXF1YWwobGFiZWxNYXRjaGVzLmxlbmd0aCwgMSwgYGV4cGVjdGVkIHRvb2wgbmFtZSBvbmx5IGluIHRoZSBjYXJkIHRpdGxlOlxcbiR7cmVuZGVyZWR9YCk7XG5cdFx0YXNzZXJ0Lm1hdGNoKHJlbmRlcmVkLCAvc3JjXFwvSW5zcGVjdG9yXFwudHN4Lyk7XG5cdFx0YXNzZXJ0Lm1hdGNoKHJlbmRlcmVkLCAvRWRpdCBzcmNcXC9JbnNwZWN0b3JcXC50c3gvKTtcblx0XHRhc3NlcnQubWF0Y2gocmVuZGVyZWQsIC9ydW5uaW5nIFx1MDBCNyBcXGQrKG1zfHMpLyk7XG5cdH0pO1xuXG5cdHRlc3QoXCJyZW5kZXJzIGNvbXBhY3Qgd3JpdGUgcm93cyB3aXRoIHRhcmdldCBtZXRhZGF0YVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVuZGVyZWQgPSByZW5kZXJUb29sQ29sbGFwc2VkKFxuXHRcdFx0XCJ3cml0ZVwiLFxuXHRcdFx0eyBwYXRoOiBcInNyYy9vdXRwdXQudHNcIiwgY29udGVudDogXCJva1wiIH0sXG5cdFx0XHR7XG5cdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIlN1Y2Nlc3NmdWxseSB3cm90ZSAyIGJ5dGVzIHRvIHNyYy9vdXRwdXQudHNcIiB9XSxcblx0XHRcdFx0aXNFcnJvcjogZmFsc2UsXG5cdFx0XHRcdGRldGFpbHM6IHtcblx0XHRcdFx0XHR0YXJnZXQ6IHtcblx0XHRcdFx0XHRcdGtpbmQ6IFwiZmlsZVwiLFxuXHRcdFx0XHRcdFx0YWN0aW9uOiBcIndyaXRlXCIsXG5cdFx0XHRcdFx0XHRpbnB1dFBhdGg6IFwic3JjL291dHB1dC50c1wiLFxuXHRcdFx0XHRcdFx0cmVzb2x2ZWRQYXRoOiBcIi90bXAvcHJvamVjdC9zcmMvb3V0cHV0LnRzXCIsXG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0fSxcblx0XHRcdH0sXG5cdFx0KTtcblxuXHRcdGFzc2VydC5tYXRjaChyZW5kZXJlZCwgL1dyaXRlLyk7XG5cdFx0YXNzZXJ0Lm1hdGNoKHJlbmRlcmVkLCAvc3JjXFwvb3V0cHV0XFwudHMvKTtcblx0XHRhc3NlcnQuZG9lc05vdE1hdGNoKHJlbmRlcmVkLCAvU3VjY2Vzc2Z1bGx5IHdyb3RlLyk7XG5cdH0pO1xuXG5cdHRlc3QoXCJvbWl0cyBkZWZhdWx0IGN3ZCBwbGFjZWhvbGRlcnMgZm9yIGNvbGxhcHNlZCBzZWFyY2ggdG9vbHNcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlbmRlcmVkID0gcmVuZGVyVG9vbENvbGxhcHNlZChcblx0XHRcdFwiR3JlcFwiLFxuXHRcdFx0e30sXG5cdFx0XHR7IGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcImhpZGRlbiBib2R5IG91dHB1dFwiIH1dLCBpc0Vycm9yOiBmYWxzZSB9LFxuXHRcdCk7XG5cblx0XHRhc3NlcnQubWF0Y2gocmVuZGVyZWQsIC9HcmVwLyk7XG5cdFx0YXNzZXJ0LmRvZXNOb3RNYXRjaChyZW5kZXJlZCwgL15cdTI1MDJcXC5cXHMrXHUyNTAyL20sIGBleHBlY3RlZCBubyBwbGFjZWhvbGRlciBjd2QgYm9keTpcXG4ke3JlbmRlcmVkfWApO1xuXHRcdGFzc2VydC5tYXRjaChyZW5kZXJlZCwgL291dHB1dCBoaWRkZW4vKTtcblx0XHRhc3NlcnQuZG9lc05vdE1hdGNoKHJlbmRlcmVkLCAvaGlkZGVuIGJvZHkgb3V0cHV0Lyk7XG5cdFx0YXNzZXJ0LmRvZXNOb3RNYXRjaChyZW5kZXJlZCwgL15cdTI1MDJcXHMrb3V0cHV0IGhpZGRlbi9tLCBgZXhwZWN0ZWQgY29tcGFjdCBmb290ZXIgdGV4dCBvbiB0aGUgdG9wIHJvdzpcXG4ke3JlbmRlcmVkfWApO1xuXHR9KTtcblxuXHR0ZXN0KFwia2VlcHMgbWVhbmluZ2Z1bCBjb2xsYXBzZWQgc2VhcmNoIHRhcmdldHNcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlbmRlcmVkID0gcmVuZGVyVG9vbENvbGxhcHNlZChcblx0XHRcdFwiR3JlcFwiLFxuXHRcdFx0eyBwYXR0ZXJuOiBcIlByb2plY3QgSW5pdGlhbGl6ZWRcIiwgcGF0aDogXCJzcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkXCIsIGdsb2I6IFwiKi50c1wiIH0sXG5cdFx0XHR7IGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcImhpZGRlbiBib2R5IG91dHB1dFwiIH1dLCBpc0Vycm9yOiBmYWxzZSB9LFxuXHRcdCk7XG5cblx0XHRhc3NlcnQubWF0Y2gocmVuZGVyZWQsIC9Qcm9qZWN0IEluaXRpYWxpemVkIGluIHNyY1xcL3Jlc291cmNlc1xcL2V4dGVuc2lvbnNcXC9nc2QgXFwoXFwqXFwudHNcXCkvKTtcblx0XHRhc3NlcnQuZG9lc05vdE1hdGNoKHJlbmRlcmVkLCAvaGlkZGVuIGJvZHkgb3V0cHV0Lyk7XG5cdH0pO1xuXG5cdHRlc3QoXCJyZW5kZXJzIGNvbXBhY3QgYmFzaCByb3dzIHdpdGggY29tbWFuZCBwcmV2aWV3XCIsICgpID0+IHtcblx0XHRjb25zdCByZW5kZXJlZCA9IHJlbmRlclRvb2xDb2xsYXBzZWQoXG5cdFx0XHRcImJhc2hcIixcblx0XHRcdHsgY29tbWFuZDogXCJucG0gcnVuIHR5cGVjaGVjayAtLSAtLXdhdGNoIGZhbHNlXCIgfSxcblx0XHRcdHsgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwib2tcIiB9XSwgaXNFcnJvcjogZmFsc2UsIGRldGFpbHM6IHsgY3dkOiBcIi90bXAvcHJvamVjdFwiIH0gfSxcblx0XHQpO1xuXG5cdFx0YXNzZXJ0Lm1hdGNoKHJlbmRlcmVkLCAvXFwkIG5wbSBydW4gdHlwZWNoZWNrIC0tIC0td2F0Y2ggZmFsc2UvKTtcblx0XHRhc3NlcnQuZG9lc05vdE1hdGNoKHJlbmRlcmVkLCAvXHUyNTFDLywgXCJjb2xsYXBzZWQgY29tbWFuZCBjYXJkcyBzaG91bGQgbm90IGluY2x1ZGUgaW50ZXJuYWwgZGl2aWRlciBsaW5lc1wiKTtcblx0XHRhc3NlcnQuZG9lc05vdE1hdGNoKHJlbmRlcmVkLCAvXFxib2tcXGIvKTtcblx0fSk7XG5cblx0dGVzdChcImtlZXBzIGZhaWxlZCB0b29scyBleHBhbmRlZCBhbmQgZXJyb3IgdmlzaWJsZVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVuZGVyZWQgPSByZW5kZXJUb29sQ29sbGFwc2VkKFxuXHRcdFx0XCJlZGl0XCIsXG5cdFx0XHR7IHBhdGg6IFwic3JjL0luc3BlY3Rvci50c3hcIiB9LFxuXHRcdFx0e1xuXHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJDb3VsZCBub3QgZmluZCB0YXJnZXQgdGV4dFwiIH1dLFxuXHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHRkZXRhaWxzOiB7XG5cdFx0XHRcdFx0dGFyZ2V0OiB7XG5cdFx0XHRcdFx0XHRraW5kOiBcImZpbGVcIixcblx0XHRcdFx0XHRcdGFjdGlvbjogXCJlZGl0XCIsXG5cdFx0XHRcdFx0XHRpbnB1dFBhdGg6IFwic3JjL0luc3BlY3Rvci50c3hcIixcblx0XHRcdFx0XHRcdHJlc29sdmVkUGF0aDogXCIvdG1wL3Byb2plY3Qvc3JjL0luc3BlY3Rvci50c3hcIixcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHR9LFxuXHRcdFx0fSxcblx0XHQpO1xuXG5cdFx0YXNzZXJ0Lm1hdGNoKHJlbmRlcmVkLCAvQ291bGQgbm90IGZpbmQgdGFyZ2V0IHRleHQvKTtcblx0XHRhc3NlcnQubWF0Y2gocmVuZGVyZWQsIC9lZGl0Lyk7XG5cdH0pO1xuXG5cdHRlc3QoXCJyZW5kZXJzIHBoYXNlLWJhc2VkIHN1bW1hcmllcyBmb3Igcm9sbGVkLXVwIHRvb2wgZXhlY3V0aW9uc1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcGhhc2VzOiBUb29sRXhlY3V0aW9uUGhhc2VbXSA9IFtcblx0XHRcdHsgbGFiZWw6IFwiU2V0dXAgLyBzaGVsbFwiLCBjb3VudDogNiwgZHVyYXRpb25NczogMTIgfSxcblx0XHRcdHtcblx0XHRcdFx0bGFiZWw6IFwiQ29udGV4dCByZWFkc1wiLFxuXHRcdFx0XHRjb3VudDogNCxcblx0XHRcdFx0ZHVyYXRpb25NczogNixcblx0XHRcdFx0YWN0aW9uTGFiZWw6IFwicmVhZFwiLFxuXHRcdFx0XHR0YXJnZXRzOiBbXCIvdG1wL3Byb2plY3Qvc3JjL2EudHNcIiwgXCIvdG1wL3Byb2plY3Qvc3JjL2IudHNcIl0sXG5cdFx0XHR9LFxuXHRcdFx0e1xuXHRcdFx0XHRsYWJlbDogXCJGaWxlIGNoYW5nZXNcIixcblx0XHRcdFx0Y291bnQ6IDMsXG5cdFx0XHRcdGR1cmF0aW9uTXM6IDUsXG5cdFx0XHRcdGFjdGlvbkxhYmVsOiBcImVkaXRcIixcblx0XHRcdFx0dGFyZ2V0czogW1wiL3RtcC9wcm9qZWN0L3NyYy9JbnNwZWN0b3IudHN4OjQyXCIsIFwiL3RtcC9wcm9qZWN0L3NyYy9Db21wYXJlVmlldy50c3g6OFwiXSxcblx0XHRcdH0sXG5cdFx0XHR7IGxhYmVsOiBcIlJlcXVpcmVtZW50IHdyaXRlc1wiLCBjb3VudDogNCwgZHVyYXRpb25NczogNCB9LFxuXHRcdFx0eyBsYWJlbDogXCJNZW1vcnkgbG9va3Vwc1wiLCBjb3VudDogNCwgZHVyYXRpb25NczogNCB9LFxuXHRcdFx0eyBsYWJlbDogXCJGaW5hbGl6YXRpb25cIiwgY291bnQ6IDEsIGR1cmF0aW9uTXM6IDEgfSxcblx0XHRdO1xuXHRcdGNvbnN0IHJlbmRlcmVkID0gc3RyaXBBbnNpKG5ldyBUb29sUGhhc2VTdW1tYXJ5Q29tcG9uZW50KHBoYXNlcykucmVuZGVyKDEyMCkuam9pbihcIlxcblwiKSk7XG5cblx0XHRhc3NlcnQubWF0Y2gocmVuZGVyZWQsIC9TZXR1cCBcXC8gc2hlbGwgNiBhY3Rpb25zXFxzK3N1Y2Nlc3MgXHUwMEI3IDEybXMvKTtcblx0XHRhc3NlcnQubWF0Y2gocmVuZGVyZWQsIC9Db250ZXh0IHJlYWRzIFx1MDBCNyAyIGZpbGVzXFxzK3N1Y2Nlc3MgXHUwMEI3IDZtcy8pO1xuXHRcdGFzc2VydC5tYXRjaChyZW5kZXJlZCwgL3NyY1xcL2FcXC50cy8pO1xuXHRcdGFzc2VydC5tYXRjaChyZW5kZXJlZCwgL0ZpbGUgY2hhbmdlcyBcdTAwQjcgMiBmaWxlcywgMyBlZGl0c1xccytzdWNjZXNzIFx1MDBCNyA1bXMvKTtcblx0XHRhc3NlcnQubWF0Y2gocmVuZGVyZWQsIC9zcmNcXC9JbnNwZWN0b3JcXC50c3g6NDIvKTtcblx0XHRhc3NlcnQubWF0Y2gocmVuZGVyZWQsIC9SZXF1aXJlbWVudCB3cml0ZXMgNCBhY3Rpb25zXFxzK3N1Y2Nlc3MgXHUwMEI3IDRtcy8pO1xuXHRcdGFzc2VydC5tYXRjaChyZW5kZXJlZCwgL01lbW9yeSBsb29rdXBzIDQgYWN0aW9uc1xccytzdWNjZXNzIFx1MDBCNyA0bXMvKTtcblx0XHRhc3NlcnQubWF0Y2gocmVuZGVyZWQsIC9GaW5hbGl6YXRpb24gMSBhY3Rpb25cXHMrc3VjY2VzcyBcdTAwQjcgMW1zLyk7XG5cdH0pO1xuXG5cdHRlc3QoXCJwYXNzZXMgZmFpbGVkIHJlc3VsdCBzdGF0dXMgdG8gY3VzdG9tIHJlc3VsdCByZW5kZXJlcnNcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlbmRlcmVkID0gcmVuZGVyVG9vbChcblx0XHRcdFwiZ3NkX3JlcXVpcmVtZW50X3NhdmVcIixcblx0XHRcdHsgaWQ6IFwiUjAwMVwiIH0sXG5cdFx0XHR7IGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcInNhdmVkXCIgfV0sIGlzRXJyb3I6IHRydWUgfSxcblx0XHRcdHtcblx0XHRcdFx0bGFiZWw6IFwiU2F2ZSBSZXF1aXJlbWVudFwiLFxuXHRcdFx0XHRyZW5kZXJSZXN1bHQocmVzdWx0OiB7IGlzRXJyb3I/OiBib29sZWFuIH0pIHtcblx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0cmVuZGVyOiAoKSA9PiBbcmVzdWx0LmlzRXJyb3IgPyBcImN1c3RvbSBzYXcgZXJyb3JcIiA6IFwiY3VzdG9tIHNhdyBzdWNjZXNzXCJdLFxuXHRcdFx0XHRcdFx0aW52YWxpZGF0ZSgpIHt9LFxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdH0sXG5cdFx0XHR9LFxuXHRcdCk7XG5cblx0XHRhc3NlcnQubWF0Y2gocmVuZGVyZWQsIC9mYWlsZWQvKTtcblx0XHRhc3NlcnQubWF0Y2gocmVuZGVyZWQsIC9jdXN0b20gc2F3IGVycm9yLyk7XG5cdFx0YXNzZXJ0LmRvZXNOb3RNYXRjaChyZW5kZXJlZCwgL2N1c3RvbSBzYXcgc3VjY2Vzcy8pO1xuXHR9KTtcblxuXHR0ZXN0KFwicmVuZGVycyBjYXBpdGFsaXplZCBDbGF1ZGUgQ29kZSBCYXNoIHRvb2wgbmFtZXMgd2l0aCBiYXNoIG91dHB1dCBpbnN0ZWFkIG9mIGdlbmVyaWMgYXJncyBKU09OXCIsICgpID0+IHtcblx0XHRjb25zdCByZW5kZXJlZCA9IHJlbmRlclRvb2woXG5cdFx0XHRcIkJhc2hcIixcblx0XHRcdHsgY29tbWFuZDogXCJwd2RcIiB9LFxuXHRcdFx0eyBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCIvdG1wL2dzZC1wci1maXhcIiB9XSwgaXNFcnJvcjogZmFsc2UgfSxcblx0XHQpO1xuXG5cdFx0YXNzZXJ0Lm1hdGNoKHJlbmRlcmVkLCAvXFwkIHB3ZC8pO1xuXHRcdGFzc2VydC5tYXRjaChyZW5kZXJlZCwgL1xcL3RtcFxcL2dzZC1wci1maXgvKTtcblx0XHRhc3NlcnQuZG9lc05vdE1hdGNoKHJlbmRlcmVkLCAvXlxce1xccypcXH0kL20pO1xuXHR9KTtcblxuXHR0ZXN0KFwicmVuZGVycyBjYXBpdGFsaXplZCBDbGF1ZGUgQ29kZSBSZWFkIHRvb2wgbmFtZXMgd2l0aCByZWFkIG91dHB1dFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVuZGVyZWQgPSByZW5kZXJUb29sKFxuXHRcdFx0XCJSZWFkXCIsXG5cdFx0XHR7IHBhdGg6IFwiL3RtcC9kZW1vLnR4dFwiIH0sXG5cdFx0XHR7IGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcImhlbGxvXFxud29ybGRcIiB9XSwgaXNFcnJvcjogZmFsc2UgfSxcblx0XHQpO1xuXG5cdFx0YXNzZXJ0Lm1hdGNoKHJlbmRlcmVkLCAvcmVhZCAuKmRlbW9cXC50eHQvKTtcblx0XHRhc3NlcnQubWF0Y2gocmVuZGVyZWQsIC9oZWxsby8pO1xuXHRcdGFzc2VydC5tYXRjaChyZW5kZXJlZCwgL3dvcmxkLyk7XG5cdH0pO1xuXG5cdHRlc3QoXCJnZW5lcmljIGZhbGxiYWNrIHN0cmlwcyBtY3BfXzxzZXJ2ZXI+X18gcHJlZml4IGFuZCBzaG93cyBzZXJ2ZXJcdTAwQjd0b29sIHRpdGxlXCIsICgpID0+IHtcblx0XHRjb25zdCByZW5kZXJlZCA9IHJlbmRlclRvb2woXG5cdFx0XHRcIm1jcF9fY29udGV4dDdfX3Jlc29sdmVfbGlicmFyeV9pZFwiLFxuXHRcdFx0eyBuYW1lOiBcInJlYWN0XCIgfSxcblx0XHRcdHsgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwicmVhY3RAMTguMy4xXCIgfV0sIGlzRXJyb3I6IGZhbHNlIH0sXG5cdFx0KTtcblxuXHRcdGFzc2VydC5tYXRjaChyZW5kZXJlZCwgL2NvbnRleHQ3XFx1MDBiN3Jlc29sdmVfbGlicmFyeV9pZC8pO1xuXHRcdGFzc2VydC5kb2VzTm90TWF0Y2gocmVuZGVyZWQsIC9tY3BfXy8pO1xuXHRcdGFzc2VydC5tYXRjaChyZW5kZXJlZCwgL25hbWU9XCJyZWFjdFwiLyk7XG5cdFx0YXNzZXJ0Lm1hdGNoKHJlbmRlcmVkLCAvcmVhY3RAMThcXC4zXFwuMS8pO1xuXHR9KTtcblxuXHR0ZXN0KFwiZ2VuZXJpYyBmYWxsYmFjayByZW5kZXJzIGNvbXBhY3Qga2V5PXZhbHVlIGFyZ3MgZm9yIHByaW1pdGl2ZSBhcmdzXCIsICgpID0+IHtcblx0XHRjb25zdCByZW5kZXJlZCA9IHJlbmRlclRvb2woXG5cdFx0XHRcInNvbWVfdW5rbm93bl90b29sXCIsXG5cdFx0XHR7IGNvdW50OiAzLCBlbmFibGVkOiB0cnVlLCBsYWJlbDogXCJoZWxsb1wiIH0sXG5cdFx0KTtcblxuXHRcdGFzc2VydC5tYXRjaChyZW5kZXJlZCwgL1NvbWUgVW5rbm93biBUb29sLyk7XG5cdFx0YXNzZXJ0Lm1hdGNoKHJlbmRlcmVkLCAvY291bnQ9My8pO1xuXHRcdGFzc2VydC5tYXRjaChyZW5kZXJlZCwgL2VuYWJsZWQ9dHJ1ZS8pO1xuXHRcdGFzc2VydC5tYXRjaChyZW5kZXJlZCwgL2xhYmVsPVwiaGVsbG9cIi8pO1xuXHRcdGFzc2VydC5kb2VzTm90TWF0Y2gocmVuZGVyZWQsIC9eXFx7JC9tKTtcblx0fSk7XG5cblx0dGVzdChcImZyYW1lIGhlYWRlciBwcmVmZXJzIHRvb2xEZWZpbml0aW9uLmxhYmVsIG92ZXIgcmF3IHRvb2wgbmFtZVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVuZGVyZWQgPSByZW5kZXJUb29sQ29sbGFwc2VkKFxuXHRcdFx0XCJnc2Rfc2xpY2VfY29tcGxldGVcIixcblx0XHRcdHsgc2xpY2VJZDogXCJTMDNcIiB9LFxuXHRcdFx0dW5kZWZpbmVkLFxuXHRcdFx0eyBsYWJlbDogXCJDb21wbGV0ZSBTbGljZVwiIH0sXG5cdFx0KTtcblxuXHRcdGFzc2VydC5tYXRjaChyZW5kZXJlZCwgL0NvbXBsZXRlIFNsaWNlLyk7XG5cdFx0YXNzZXJ0LmRvZXNOb3RNYXRjaChyZW5kZXJlZCwgL1Rvb2wgQ29tcGxldGUgU2xpY2UvKTtcblx0XHRhc3NlcnQuZG9lc05vdE1hdGNoKHJlbmRlcmVkLCAvZ3NkX3NsaWNlX2NvbXBsZXRlLyk7XG5cdH0pO1xuXG5cdHRlc3QoXCJmcmFtZSBoZWFkZXIgc3RyaXBzIGdzZF8gcHJlZml4IGFuZCB0aXRsZS1jYXNlcyB3aGVuIG5vIGxhYmVsIGlzIHJlZ2lzdGVyZWRcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlbmRlcmVkID0gcmVuZGVyVG9vbENvbGxhcHNlZChcImdzZF9yZXF1aXJlbWVudF91cGRhdGVcIiwgeyBpZDogXCJSMDA1XCIgfSk7XG5cblx0XHRhc3NlcnQubWF0Y2gocmVuZGVyZWQsIC9SZXF1aXJlbWVudCBVcGRhdGUvKTtcblx0XHRhc3NlcnQuZG9lc05vdE1hdGNoKHJlbmRlcmVkLCAvVG9vbCBSZXF1aXJlbWVudCBVcGRhdGUvKTtcblx0XHRhc3NlcnQuZG9lc05vdE1hdGNoKHJlbmRlcmVkLCAvZ3NkX3JlcXVpcmVtZW50X3VwZGF0ZS8pO1xuXHR9KTtcblxuXHR0ZXN0KFwiY29sbGFwc2VkIGdlbmVyaWMgcnVubmluZyB0b29scyBoaWRlIHByaW1pdGl2ZSBhcmdzXCIsICgpID0+IHtcblx0XHRjb25zdCBsb25nUGF0aCA9IFwiL1VzZXJzL2FsaWNlLy5nc2QvcHJvamVjdHMvNGRjZTdiNzc1MDEzL3dvcmt0cmVlcy9zbGljZS1TMDMtc29tZS1sb25nLXBhdGgtdGhhdC1leGNlZWRzLWxpbWl0XCI7XG5cdFx0Y29uc3QgcmVuZGVyZWQgPSByZW5kZXJUb29sQ29sbGFwc2VkKFwiZ3NkX3NsaWNlX2NvbXBsZXRlXCIsIHtcblx0XHRcdHNsaWNlSWQ6IFwiUzAzXCIsXG5cdFx0XHRtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG5cdFx0XHR3b3JrdHJlZTogbG9uZ1BhdGgsXG5cdFx0fSk7XG5cblx0XHRhc3NlcnQubWF0Y2gocmVuZGVyZWQsIC9TbGljZSBDb21wbGV0ZS8pO1xuXHRcdGFzc2VydC5tYXRjaChyZW5kZXJlZCwgL3J1bm5pbmcgXHUwMEI3IFxcZCsobXN8cykvKTtcblx0XHRhc3NlcnQuZG9lc05vdE1hdGNoKHJlbmRlcmVkLCAvc2xpY2VJZD1cIlMwM1wiLyk7XG5cdFx0YXNzZXJ0LmRvZXNOb3RNYXRjaChyZW5kZXJlZCwgL21pbGVzdG9uZUlkPVwiTTAwMVwiLyk7XG5cdFx0YXNzZXJ0LmRvZXNOb3RNYXRjaChyZW5kZXJlZCwgL3dvcmt0cmVlPS8pO1xuXHRcdGFzc2VydC5kb2VzTm90TWF0Y2gocmVuZGVyZWQsIC9cInNsaWNlSWRcIjpcXHMqXCJTMDNcIi8pO1xuXHR9KTtcblxuXHR0ZXN0KFwiZm9ybWF0Q29tcGFjdEFyZ3Mgc2hvd3MgZnVsbCBzdHJpbmcgdmFsdWVzIHdoZW4gZXhwYW5kZWRcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGxvbmdQYXRoID0gXCIvVXNlcnMvYWxpY2UvLmdzZC9wcm9qZWN0cy80ZGNlN2I3NzUwMTMvd29ya3RyZWVzL3NsaWNlLVMwMy1zb21lLWxvbmctcGF0aC10aGF0LWV4Y2VlZHMtbGltaXRcIjtcblx0XHRjb25zdCByZW5kZXJlZCA9IHJlbmRlclRvb2woXCJnc2Rfc2xpY2VfY29tcGxldGVcIiwge1xuXHRcdFx0c2xpY2VJZDogXCJTMDNcIixcblx0XHRcdHdvcmt0cmVlOiBsb25nUGF0aCxcblx0XHR9KTtcblxuXHRcdGFzc2VydC5tYXRjaChyZW5kZXJlZCwgbmV3IFJlZ0V4cChsb25nUGF0aC5yZXBsYWNlKC9cXC8vZywgXCJcXFxcL1wiKSkpO1xuXHRcdGFzc2VydC5kb2VzTm90TWF0Y2gocmVuZGVyZWQsIC9cdTIwMjYvKTtcblx0fSk7XG5cblx0dGVzdChcImdlbmVyaWMgZmFsbGJhY2sgY29sbGFwc2VzIHN1Y2Nlc3NmdWwgb3V0cHV0IHJvd3MgdW50aWwgZXhwYW5kZWRcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGxvbmdPdXRwdXQgPSBBcnJheS5mcm9tKHsgbGVuZ3RoOiAyNSB9LCAoXywgaSkgPT4gYGxpbmUgJHtpICsgMX1gKS5qb2luKFwiXFxuXCIpO1xuXHRcdGNvbnN0IHJlbmRlcmVkID0gcmVuZGVyVG9vbENvbGxhcHNlZChcblx0XHRcdFwibWNwX19kZW1vX19kb190aGluZ1wiLFxuXHRcdFx0eyBvazogdHJ1ZSB9LFxuXHRcdFx0eyBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogbG9uZ091dHB1dCB9XSwgaXNFcnJvcjogZmFsc2UgfSxcblx0XHQpO1xuXG5cdFx0YXNzZXJ0Lm1hdGNoKHJlbmRlcmVkLCAvZGVtb1xcdTAwYjdkb190aGluZy8pO1xuXHRcdGFzc2VydC5tYXRjaChyZW5kZXJlZCwgL3N1Y2Nlc3MgXHUwMEI3IFxcZCsobXN8cykvKTtcblx0XHRhc3NlcnQuZG9lc05vdE1hdGNoKHJlbmRlcmVkLCAvbGluZSAxXFxiLyk7XG5cdFx0YXNzZXJ0LmRvZXNOb3RNYXRjaChyZW5kZXJlZCwgL1xcKDE1IG1vcmUgbGluZXMvKTtcblx0fSk7XG5cblx0dGVzdChcImdlbmVyaWMgZmFsbGJhY2sgZmFsbHMgYmFjayB0byB0cnVuY2F0ZWQgSlNPTiBmb3IgY29tcGxleCBhcmdzXCIsICgpID0+IHtcblx0XHRjb25zdCByZW5kZXJlZCA9IHJlbmRlclRvb2woXG5cdFx0XHRcIm1jcF9fZGVtb19fbmVzdGVkXCIsXG5cdFx0XHR7IHBheWxvYWQ6IHsgbmVzdGVkOiB7IGRlZXBseTogW1wiYVwiLCBcImJcIiwgXCJjXCJdIH0gfSwgbmFtZTogXCJ4XCIgfSxcblx0XHQpO1xuXG5cdFx0YXNzZXJ0Lm1hdGNoKHJlbmRlcmVkLCAvZGVtb1xcdTAwYjduZXN0ZWQvKTtcblx0XHQvLyBNdWx0aS1saW5lIEpTT04gZHVtcCBmb3IgdGhlIGNvbXBsZXggcGF5bG9hZFxuXHRcdGFzc2VydC5tYXRjaChyZW5kZXJlZCwgL1wicGF5bG9hZFwiLyk7XG5cdFx0YXNzZXJ0Lm1hdGNoKHJlbmRlcmVkLCAvXCJuZXN0ZWRcIi8pO1xuXHR9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBRUEsU0FBUyxVQUFVLFlBQVk7QUFDL0IsT0FBTyxZQUFZO0FBQ25CLE9BQU8sZUFBZTtBQUN0QixTQUFTLHdCQUF3QixpQ0FBMEQ7QUFDM0YsU0FBUyxpQkFBaUI7QUFFMUIsVUFBVSxRQUFRLEtBQUs7QUFFdkIsU0FBUyxXQUNSLFVBQ0EsTUFDQSxRQUtBLGdCQUNTO0FBQ1QsUUFBTSxZQUFZLElBQUk7QUFBQSxJQUNyQjtBQUFBLElBQ0E7QUFBQSxJQUNBLENBQUM7QUFBQSxJQUNEO0FBQUEsSUFDQSxFQUFFLGdCQUFnQjtBQUFBLElBQUMsRUFBRTtB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
