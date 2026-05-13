import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { formatDiscoveryForTool, formatDiscoveryForCommand } from "../format.js";
const emptyResult = {
  tools: [],
  allItems: [],
  summary: {
    mcpServers: 0,
    rules: 0,
    contextFiles: 0,
    settings: 0,
    claudeSkills: 0,
    claudePlugins: 0,
    totalItems: 0,
    toolsScanned: 8,
    toolsWithConfig: 0
  },
  warnings: [],
  durationMs: 42
};
const populatedResult = {
  tools: [
    {
      tool: { id: "cursor", name: "Cursor", userDir: ".cursor", projectDir: ".cursor" },
      items: [
        {
          type: "mcp-server",
          name: "test-mcp",
          command: "node",
          args: ["server.js"],
          transport: "stdio",
          source: { tool: "cursor", toolName: "Cursor", path: "/project/.cursor/mcp.json", level: "project" }
        },
        {
          type: "claude-skill",
          name: "cursor-mdc-editor",
          path: "/home/user/.claude/skills/cursor-mdc-editor",
          source: { tool: "claude", toolName: "Claude Code", path: "/home/user/.claude/skills/cursor-mdc-editor/SKILL.md", level: "user" }
        },
        {
          type: "claude-plugin",
          name: "context-mode",
          packageName: "context-mode",
          path: "/home/user/.claude/plugins/marketplaces/context-mode",
          source: { tool: "claude", toolName: "Claude Code", path: "/home/user/.claude/plugins/marketplaces/context-mode/package.json", level: "user" }
        }
      ],
      warnings: []
    },
    {
      tool: { id: "github-copilot", name: "GitHub Copilot", userDir: null, projectDir: ".github" },
      items: [
        {
          type: "context-file",
          name: "copilot-instructions.md",
          content: "Be helpful.",
          source: { tool: "github-copilot", toolName: "GitHub Copilot", path: "/project/.github/copilot-instructions.md", level: "project" }
        }
      ],
      warnings: []
    }
  ],
  allItems: [],
  summary: {
    mcpServers: 1,
    rules: 1,
    contextFiles: 1,
    settings: 0,
    claudeSkills: 1,
    claudePlugins: 1,
    totalItems: 5,
    toolsScanned: 8,
    toolsWithConfig: 2
  },
  warnings: [],
  durationMs: 15
};
populatedResult.allItems = populatedResult.tools.flatMap((t) => t.items);
describe("formatDiscoveryForTool", () => {
  test("formats empty result", () => {
    const text = formatDiscoveryForTool(emptyResult);
    assert.ok(text.includes("0/8 tools with config"));
    assert.ok(text.includes("No configuration found"));
  });
  test("formats populated result with sections", () => {
    const text = formatDiscoveryForTool(populatedResult);
    assert.ok(text.includes("2/8 tools with config"));
    assert.ok(text.includes("1 MCP server(s)"));
    assert.ok(text.includes("1 Claude skill(s)"));
    assert.ok(text.includes("1 Claude plugin(s)"));
    assert.ok(text.includes("Cursor"));
    assert.ok(text.includes("test-mcp"));
    assert.ok(text.includes("GitHub Copilot"));
    assert.ok(text.includes("copilot-instructions.md"));
    assert.ok(text.includes("cursor-mdc-editor"));
    assert.ok(text.includes("context-mode"));
  });
});
describe("formatDiscoveryForCommand", () => {
  test("formats empty result", () => {
    const lines = formatDiscoveryForCommand(emptyResult);
    const text = lines.join("\n");
    assert.ok(text.includes("0 of 8"));
    assert.ok(text.includes("No configuration found"));
  });
  test("formats populated result as summary", () => {
    const lines = formatDiscoveryForCommand(populatedResult);
    const text = lines.join("\n");
    assert.ok(text.includes("2 of 8"));
    assert.ok(text.includes("Cursor"));
    assert.ok(text.includes("MCP: test-mcp"));
    assert.ok(text.includes("Skill: cursor-mdc-editor"));
    assert.ok(text.includes("Plugin: context-mode"));
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL3VuaXZlcnNhbC1jb25maWcvdGVzdHMvZm9ybWF0LnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogVGVzdHMgZm9yIG91dHB1dCBmb3JtYXR0aW5nLlxuICogUnVucyB3aXRoOiBub2RlIC0tZXhwZXJpbWVudGFsLXN0cmlwLXR5cGVzIC0tdGVzdFxuICovXG5cbmltcG9ydCB7IGRlc2NyaWJlLCB0ZXN0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IHsgc3RyaWN0IGFzIGFzc2VydCB9IGZyb20gXCJub2RlOmFzc2VydFwiO1xuaW1wb3J0IHsgZm9ybWF0RGlzY292ZXJ5Rm9yVG9vbCwgZm9ybWF0RGlzY292ZXJ5Rm9yQ29tbWFuZCB9IGZyb20gXCIuLi9mb3JtYXQudHNcIjtcbmltcG9ydCB0eXBlIHsgRGlzY292ZXJ5UmVzdWx0IH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5cbmNvbnN0IGVtcHR5UmVzdWx0OiBEaXNjb3ZlcnlSZXN1bHQgPSB7XG4gIHRvb2xzOiBbXSxcbiAgYWxsSXRlbXM6IFtdLFxuICBzdW1tYXJ5OiB7XG4gICAgbWNwU2VydmVyczogMCxcbiAgICBydWxlczogMCxcbiAgICBjb250ZXh0RmlsZXM6IDAsXG4gICAgc2V0dGluZ3M6IDAsXG4gICAgY2xhdWRlU2tpbGxzOiAwLFxuICAgIGNsYXVkZVBsdWdpbnM6IDAsXG4gICAgdG90YWxJdGVtczogMCxcbiAgICB0b29sc1NjYW5uZWQ6IDgsXG4gICAgdG9vbHNXaXRoQ29uZmlnOiAwLFxuICB9LFxuICB3YXJuaW5nczogW10sXG4gIGR1cmF0aW9uTXM6IDQyLFxufTtcblxuY29uc3QgcG9wdWxhdGVkUmVzdWx0OiBEaXNjb3ZlcnlSZXN1bHQgPSB7XG4gIHRvb2xzOiBbXG4gICAge1xuICAgICAgdG9vbDogeyBpZDogXCJjdXJzb3JcIiwgbmFtZTogXCJDdXJzb3JcIiwgdXNlckRpcjogXCIuY3Vyc29yXCIsIHByb2plY3REaXI6IFwiLmN1cnNvclwiIH0sXG4gICAgICBpdGVtczogW1xuICAgICAgICB7XG4gICAgICAgICAgdHlwZTogXCJtY3Atc2VydmVyXCIsXG4gICAgICAgICAgbmFtZTogXCJ0ZXN0LW1jcFwiLFxuICAgICAgICAgIGNvbW1hbmQ6IFwibm9kZVwiLFxuICAgICAgICAgIGFyZ3M6IFtcInNlcnZlci5qc1wiXSxcbiAgICAgICAgICB0cmFuc3BvcnQ6IFwic3RkaW9cIixcbiAgICAgICAgICBzb3VyY2U6IHsgdG9vbDogXCJjdXJzb3JcIiwgdG9vbE5hbWU6IFwiQ3Vyc29yXCIsIHBhdGg6IFwiL3Byb2plY3QvLmN1cnNvci9tY3AuanNvblwiLCBsZXZlbDogXCJwcm9qZWN0XCIgfSxcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIHR5cGU6IFwiY2xhdWRlLXNraWxsXCIsXG4gICAgICAgICAgbmFtZTogXCJjdXJzb3ItbWRjLWVkaXRvclwiLFxuICAgICAgICAgIHBhdGg6IFwiL2hvbWUvdXNlci8uY2xhdWRlL3NraWxscy9jdXJzb3ItbWRjLWVkaXRvclwiLFxuICAgICAgICAgIHNvdXJjZTogeyB0b29sOiBcImNsYXVkZVwiLCB0b29sTmFtZTogXCJDbGF1ZGUgQ29kZVwiLCBwYXRoOiBcIi9ob21lL3VzZXIvLmNsYXVkZS9za2lsbHMvY3Vyc29yLW1kYy1lZGl0b3IvU0tJTEwubWRcIiwgbGV2ZWw6IFwidXNlclwiIH0sXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICB0eXBlOiBcImNsYXVkZS1wbHVnaW5cIixcbiAgICAgICAgICBuYW1lOiBcImNvbnRleHQtbW9kZVwiLFxuICAgICAgICAgIHBhY2thZ2VOYW1lOiBcImNvbnRleHQtbW9kZVwiLFxuICAgICAgICAgIHBhdGg6IFwiL2hvbWUvdXNlci8uY2xhdWRlL3BsdWdpbnMvbWFya2V0cGxhY2VzL2NvbnRleHQtbW9kZVwiLFxuICAgICAgICAgIHNvdXJjZTogeyB0b29sOiBcImNsYXVkZVwiLCB0b29sTmFtZTogXCJDbGF1ZGUgQ29kZVwiLCBwYXRoOiBcIi9ob21lL3VzZXIvLmNsYXVkZS9wbHVnaW5zL21hcmtldHBsYWNlcy9jb250ZXh0LW1vZGUvcGFja2FnZS5qc29uXCIsIGxldmVsOiBcInVzZXJcIiB9LFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICAgIHdhcm5pbmdzOiBbXSxcbiAgICB9LFxuICAgIHtcbiAgICAgIHRvb2w6IHsgaWQ6IFwiZ2l0aHViLWNvcGlsb3RcIiwgbmFtZTogXCJHaXRIdWIgQ29waWxvdFwiLCB1c2VyRGlyOiBudWxsLCBwcm9qZWN0RGlyOiBcIi5naXRodWJcIiB9LFxuICAgICAgaXRlbXM6IFtcbiAgICAgICAge1xuICAgICAgICAgIHR5cGU6IFwiY29udGV4dC1maWxlXCIsXG4gICAgICAgICAgbmFtZTogXCJjb3BpbG90LWluc3RydWN0aW9ucy5tZFwiLFxuICAgICAgICAgIGNvbnRlbnQ6IFwiQmUgaGVscGZ1bC5cIixcbiAgICAgICAgICBzb3VyY2U6IHsgdG9vbDogXCJnaXRodWItY29waWxvdFwiLCB0b29sTmFtZTogXCJHaXRIdWIgQ29waWxvdFwiLCBwYXRoOiBcIi9wcm9qZWN0Ly5naXRodWIvY29waWxvdC1pbnN0cnVjdGlvbnMubWRcIiwgbGV2ZWw6IFwicHJvamVjdFwiIH0sXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgICAgd2FybmluZ3M6IFtdLFxuICAgIH0sXG4gIF0sXG4gIGFsbEl0ZW1zOiBbXSxcbiAgc3VtbWFyeToge1xuICAgIG1jcFNlcnZlcnM6IDEsXG4gICAgcnVsZXM6IDEsXG4gICAgY29udGV4dEZpbGVzOiAxLFxuICAgIHNldHRpbmdzOiAwLFxuICAgIGNsYXVkZVNraWxsczogMSxcbiAgICBjbGF1ZGVQbHVnaW5zOiAxLFxuICAgIHRvdGFsSXRlbXM6IDUsXG4gICAgdG9vbHNTY2FubmVkOiA4LFxuICAgIHRvb2xzV2l0aENvbmZpZzogMixcbiAgfSxcbiAgd2FybmluZ3M6IFtdLFxuICBkdXJhdGlvbk1zOiAxNSxcbn07XG5wb3B1bGF0ZWRSZXN1bHQuYWxsSXRlbXMgPSBwb3B1bGF0ZWRSZXN1bHQudG9vbHMuZmxhdE1hcCgodCkgPT4gdC5pdGVtcyk7XG5cbmRlc2NyaWJlKFwiZm9ybWF0RGlzY292ZXJ5Rm9yVG9vbFwiLCAoKSA9PiB7XG4gIHRlc3QoXCJmb3JtYXRzIGVtcHR5IHJlc3VsdFwiLCAoKSA9PiB7XG4gICAgY29uc3QgdGV4dCA9IGZvcm1hdERpc2NvdmVyeUZvclRvb2woZW1wdHlSZXN1bHQpO1xuICAgIGFzc2VydC5vayh0ZXh0LmluY2x1ZGVzKFwiMC84IHRvb2xzIHdpdGggY29uZmlnXCIpKTtcbiAgICBhc3NlcnQub2sodGV4dC5pbmNsdWRlcyhcIk5vIGNvbmZpZ3VyYXRpb24gZm91bmRcIikpO1xuICB9KTtcblxuICB0ZXN0KFwiZm9ybWF0cyBwb3B1bGF0ZWQgcmVzdWx0IHdpdGggc2VjdGlvbnNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHRleHQgPSBmb3JtYXREaXNjb3ZlcnlGb3JUb29sKHBvcHVsYXRlZFJlc3VsdCk7XG4gICAgYXNzZXJ0Lm9rKHRleHQuaW5jbHVkZXMoXCIyLzggdG9vbHMgd2l0aCBjb25maWdcIikpO1xuICAgIGFzc2VydC5vayh0ZXh0LmluY2x1ZGVzKFwiMSBNQ1Agc2VydmVyKHMpXCIpKTtcbiAgICBhc3NlcnQub2sodGV4dC5pbmNsdWRlcyhcIjEgQ2xhdWRlIHNraWxsKHMpXCIpKTtcbiAgICBhc3NlcnQub2sodGV4dC5pbmNsdWRlcyhcIjEgQ2xhdWRlIHBsdWdpbihzKVwiKSk7XG4gICAgYXNzZXJ0Lm9rKHRleHQuaW5jbHVkZXMoXCJDdXJzb3JcIikpO1xuICAgIGFzc2VydC5vayh0ZXh0LmluY2x1ZGVzKFwidGVzdC1tY3BcIikpO1xuICAgIGFzc2VydC5vayh0ZXh0LmluY2x1ZGVzKFwiR2l0SHViIENvcGlsb3RcIikpO1xuICAgIGFzc2VydC5vayh0ZXh0LmluY2x1ZGVzKFwiY29waWxvdC1pbnN0cnVjdGlvbnMubWRcIikpO1xuICAgIGFzc2VydC5vayh0ZXh0LmluY2x1ZGVzKFwiY3Vyc29yLW1kYy1lZGl0b3JcIikpO1xuICAgIGFzc2VydC5vayh0ZXh0LmluY2x1ZGVzKFwiY29udGV4dC1tb2RlXCIpKTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoXCJmb3JtYXREaXNjb3ZlcnlGb3JDb21tYW5kXCIsICgpID0+IHtcbiAgdGVzdChcImZvcm1hdHMgZW1wdHkgcmVzdWx0XCIsICgpID0+IHtcbiAgICBjb25zdCBsaW5lcyA9IGZvcm1hdERpc2NvdmVyeUZvckNvbW1hbmQoZW1wdHlSZXN1bHQpO1xuICAgIGNvbnN0IHRleHQgPSBsaW5lcy5qb2luKFwiXFxuXCIpO1xuICAgIGFzc2VydC5vayh0ZXh0LmluY2x1ZGVzKFwiMCBvZiA4XCIpKTtcbiAgICBhc3NlcnQub2sodGV4dC5pbmNsdWRlcyhcIk5vIGNvbmZpZ3VyYXRpb24gZm91bmRcIikpO1xuICB9KTtcblxuICB0ZXN0KFwiZm9ybWF0cyBwb3B1bGF0ZWQgcmVzdWx0IGFzIHN1bW1hcnlcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGxpbmVzID0gZm9ybWF0RGlzY292ZXJ5Rm9yQ29tbWFuZChwb3B1bGF0ZWRSZXN1bHQpO1xuICAgIGNvbnN0IHRleHQgPSBsaW5lcy5qb2luKFwiXFxuXCIpO1xuICAgIGFzc2VydC5vayh0ZXh0LmluY2x1ZGVzKFwiMiBvZiA4XCIpKTtcbiAgICBhc3NlcnQub2sodGV4dC5pbmNsdWRlcyhcIkN1cnNvclwiKSk7XG4gICAgYXNzZXJ0Lm9rKHRleHQuaW5jbHVkZXMoXCJNQ1A6IHRlc3QtbWNwXCIpKTtcbiAgICBhc3NlcnQub2sodGV4dC5pbmNsdWRlcyhcIlNraWxsOiBjdXJzb3ItbWRjLWVkaXRvclwiKSk7XG4gICAgYXNzZXJ0Lm9rKHRleHQuaW5jbHVkZXMoXCJQbHVnaW46IGNvbnRleHQtbW9kZVwiKSk7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFLQSxTQUFTLFVBQVUsWUFBWTtB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
