import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SCANNERS } from "../scanners.js";
import { TOOLS } from "../tools.js";
function getTool(id) {
  const tool = TOOLS.find((t) => t.id === id);
  if (!tool) throw new Error(`Unknown tool: ${id}`);
  return tool;
}
function mkdirp(path) {
  mkdirSync(path, { recursive: true });
}
function writeJson(path, data) {
  mkdirp(join(path, ".."));
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}
function writeText(path, content) {
  mkdirp(join(path, ".."));
  writeFileSync(path, content, "utf8");
}
function makeTempDirs() {
  const base = join(tmpdir(), `ucd-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const testRoot = join(base, "project");
  const testHome = join(base, "home");
  mkdirp(testRoot);
  mkdirp(testHome);
  return {
    testRoot,
    testHome,
    cleanup: () => rmSync(base, { recursive: true, force: true })
  };
}
describe("Claude Code scanner", () => {
  test("discovers MCP servers from ~/.claude.json", async () => {
    const { testRoot, testHome, cleanup } = makeTempDirs();
    try {
      writeJson(join(testHome, ".claude.json"), {
        mcpServers: {
          "test-server": { command: "npx", args: ["-y", "test-mcp"], type: "stdio" }
        }
      });
      const { items } = await SCANNERS.claude(testRoot, testHome, getTool("claude"));
      const servers = items.filter((i) => i.type === "mcp-server");
      assert.equal(servers.length, 1);
      assert.equal(servers[0].type, "mcp-server");
      if (servers[0].type === "mcp-server") {
        assert.equal(servers[0].name, "test-server");
        assert.equal(servers[0].command, "npx");
        assert.equal(servers[0].transport, "stdio");
        assert.equal(servers[0].source.level, "user");
      }
    } finally {
      cleanup();
    }
  });
  test("discovers project MCP from .claude/.mcp.json", async () => {
    const { testRoot, testHome, cleanup } = makeTempDirs();
    try {
      writeJson(join(testRoot, ".claude/.mcp.json"), {
        mcpServers: { "project-server": { command: "node", args: ["server.js"] } }
      });
      const { items } = await SCANNERS.claude(testRoot, testHome, getTool("claude"));
      const servers = items.filter((i) => i.type === "mcp-server");
      assert.equal(servers.length, 1);
      assert.equal(servers[0].source.level, "project");
    } finally {
      cleanup();
    }
  });
  test("discovers CLAUDE.md context files", async () => {
    const { testRoot, testHome, cleanup } = makeTempDirs();
    try {
      writeText(join(testHome, ".claude/CLAUDE.md"), "# User instructions");
      writeText(join(testRoot, "CLAUDE.md"), "# Project root instructions");
      writeText(join(testRoot, ".claude/CLAUDE.md"), "# Project .claude instructions");
      const { items } = await SCANNERS.claude(testRoot, testHome, getTool("claude"));
      const contexts = items.filter((i) => i.type === "context-file");
      assert.equal(contexts.length, 3);
    } finally {
      cleanup();
    }
  });
  test("discovers Claude Code skills and plugins", async () => {
    const { testRoot, testHome, cleanup } = makeTempDirs();
    try {
      writeText(join(testHome, ".claude/skills/test-skill/SKILL.md"), "# test skill");
      writeJson(join(testHome, ".claude/plugins/test-plugin/package.json"), { name: "test-plugin" });
      const { items } = await SCANNERS.claude(testRoot, testHome, getTool("claude"));
      const skills = items.filter((i) => i.type === "claude-skill");
      const plugins = items.filter((i) => i.type === "claude-plugin");
      assert.equal(skills.length, 1);
      assert.equal(plugins.length, 1);
      if (skills[0]?.type === "claude-skill") assert.equal(skills[0].name, "test-skill");
      if (plugins[0]?.type === "claude-plugin") assert.equal(plugins[0].name, "test-plugin");
    } finally {
      cleanup();
    }
  });
  test("discovers settings.json", async () => {
    const { testRoot, testHome, cleanup } = makeTempDirs();
    try {
      writeJson(join(testHome, ".claude/settings.json"), { theme: "dark" });
      const { items } = await SCANNERS.claude(testRoot, testHome, getTool("claude"));
      const settings = items.filter((i) => i.type === "settings");
      assert.equal(settings.length, 1);
    } finally {
      cleanup();
    }
  });
  test("handles missing files gracefully", async () => {
    const { testRoot, testHome, cleanup } = makeTempDirs();
    try {
      const { items, warnings } = await SCANNERS.claude(testRoot, testHome, getTool("claude"));
      assert.equal(items.length, 0);
      assert.equal(warnings.length, 0);
    } finally {
      cleanup();
    }
  });
});
describe("Cursor scanner", () => {
  test("discovers MCP servers from .cursor/mcp.json", async () => {
    const { testRoot, testHome, cleanup } = makeTempDirs();
    try {
      writeJson(join(testRoot, ".cursor/mcp.json"), {
        mcpServers: { "cursor-mcp": { command: "python", args: ["mcp.py"], type: "stdio" } }
      });
      const { items } = await SCANNERS.cursor(testRoot, testHome, getTool("cursor"));
      const servers = items.filter((i) => i.type === "mcp-server");
      assert.equal(servers.length, 1);
      if (servers[0].type === "mcp-server") {
        assert.equal(servers[0].name, "cursor-mcp");
        assert.equal(servers[0].command, "python");
      }
    } finally {
      cleanup();
    }
  });
  test("discovers rules from .cursor/rules/*.mdc", async () => {
    const { testRoot, testHome, cleanup } = makeTempDirs();
    try {
      writeText(
        join(testRoot, ".cursor/rules/coding-style.mdc"),
        "---\ndescription: Coding style rules\nalwaysApply: true\n---\nUse TypeScript strict mode."
      );
      const { items } = await SCANNERS.cursor(testRoot, testHome, getTool("cursor"));
      const rules = items.filter((i) => i.type === "rule");
      assert.equal(rules.length, 1);
      if (rules[0].type === "rule") {
        assert.equal(rules[0].name, "coding-style");
        assert.equal(rules[0].alwaysApply, true);
        assert.equal(rules[0].description, "Coding style rules");
      }
    } finally {
      cleanup();
    }
  });
  test("discovers legacy .cursorrules", async () => {
    const { testRoot, testHome, cleanup } = makeTempDirs();
    try {
      writeText(join(testRoot, ".cursorrules"), "Always use semicolons.");
      const { items } = await SCANNERS.cursor(testRoot, testHome, getTool("cursor"));
      const rules = items.filter((i) => i.type === "rule");
      assert.equal(rules.length, 1);
      if (rules[0].type === "rule") {
        assert.equal(rules[0].content, "Always use semicolons.");
      }
    } finally {
      cleanup();
    }
  });
});
describe("Windsurf scanner", () => {
  test("discovers MCP servers from mcp_config.json", async () => {
    const { testRoot, testHome, cleanup } = makeTempDirs();
    try {
      writeJson(join(testRoot, ".windsurf/mcp_config.json"), {
        mcpServers: { "ws-server": { command: "node", args: ["ws.js"] } }
      });
      const { items } = await SCANNERS.windsurf(testRoot, testHome, getTool("windsurf"));
      const servers = items.filter((i) => i.type === "mcp-server");
      assert.equal(servers.length, 1);
    } finally {
      cleanup();
    }
  });
  test("discovers global rules from user dir", async () => {
    const { testRoot, testHome, cleanup } = makeTempDirs();
    try {
      writeText(join(testHome, ".codeium/windsurf/memories/global_rules.md"), "Be concise.");
      const { items } = await SCANNERS.windsurf(testRoot, testHome, getTool("windsurf"));
      const rules = items.filter((i) => i.type === "rule");
      assert.equal(rules.length, 1);
      if (rules[0].type === "rule") {
        assert.equal(rules[0].name, "global_rules");
        assert.equal(rules[0].alwaysApply, true);
      }
    } finally {
      cleanup();
    }
  });
});
describe("Gemini CLI scanner", () => {
  test("discovers MCP servers from settings.json", async () => {
    const { testRoot, testHome, cleanup } = makeTempDirs();
    try {
      writeJson(join(testRoot, ".gemini/settings.json"), {
        mcpServers: { "gemini-mcp": { command: "deno", args: ["run", "mcp.ts"] } }
      });
      const { items } = await SCANNERS.gemini(testRoot, testHome, getTool("gemini"));
      const servers = items.filter((i) => i.type === "mcp-server");
      assert.equal(servers.length, 1);
    } finally {
      cleanup();
    }
  });
  test("discovers GEMINI.md context files", async () => {
    const { testRoot, testHome, cleanup } = makeTempDirs();
    try {
      writeText(join(testHome, ".gemini/GEMINI.md"), "User gemini instructions");
      writeText(join(testRoot, ".gemini/GEMINI.md"), "Project gemini instructions");
      const { items } = await SCANNERS.gemini(testRoot, testHome, getTool("gemini"));
      const contexts = items.filter((i) => i.type === "context-file");
      assert.equal(contexts.length, 2);
    } finally {
      cleanup();
    }
  });
});
describe("Codex scanner", () => {
  test("discovers AGENTS.md from user dir", async () => {
    const { testRoot, testHome, cleanup } = makeTempDirs();
    try {
      writeText(join(testHome, ".codex/AGENTS.md"), "Codex user instructions");
      const { items } = await SCANNERS.codex(testRoot, testHome, getTool("codex"));
      const contexts = items.filter((i) => i.type === "context-file");
      assert.equal(contexts.length, 1);
      if (contexts[0].type === "context-file") {
        assert.equal(contexts[0].name, "AGENTS.md (user)");
      }
    } finally {
      cleanup();
    }
  });
  test("warns about TOML config", async () => {
    const { testRoot, testHome, cleanup } = makeTempDirs();
    try {
      writeText(join(testHome, ".codex/config.toml"), "[mcp_servers.test]\ncommand = 'node'");
      const { warnings } = await SCANNERS.codex(testRoot, testHome, getTool("codex"));
      assert.ok(warnings.length > 0);
      assert.ok(warnings[0].includes("TOML"));
    } finally {
      cleanup();
    }
  });
});
describe("Cline scanner", () => {
  test("discovers .clinerules as single file", async () => {
    const { testRoot, testHome, cleanup } = makeTempDirs();
    try {
      writeText(join(testRoot, ".clinerules"), "Follow TDD.");
      const { items } = await SCANNERS.cline(testRoot, testHome, getTool("cline"));
      const rules = items.filter((i) => i.type === "rule");
      assert.equal(rules.length, 1);
      if (rules[0].type === "rule") {
        assert.equal(rules[0].name, "clinerules");
        assert.equal(rules[0].alwaysApply, true);
      }
    } finally {
      cleanup();
    }
  });
  test("discovers .clinerules as directory", async () => {
    const { testRoot, testHome, cleanup } = makeTempDirs();
    try {
      mkdirp(join(testRoot, ".clinerules"));
      writeText(join(testRoot, ".clinerules/style.md"), "Use 2-space indent.");
      writeText(join(testRoot, ".clinerules/testing.md"), "Write tests first.");
      const { items } = await SCANNERS.cline(testRoot, testHome, getTool("cline"));
      const rules = items.filter((i) => i.type === "rule");
      assert.equal(rules.length, 2);
    } finally {
      cleanup();
    }
  });
  test("handles missing .clinerules", async () => {
    const { testRoot, testHome, cleanup } = makeTempDirs();
    try {
      const { items } = await SCANNERS.cline(testRoot, testHome, getTool("cline"));
      assert.equal(items.length, 0);
    } finally {
      cleanup();
    }
  });
});
describe("GitHub Copilot scanner", () => {
  test("discovers copilot-instructions.md", async () => {
    const { testRoot, testHome, cleanup } = makeTempDirs();
    try {
      writeText(join(testRoot, ".github/copilot-instructions.md"), "Use TypeScript.");
      const { items } = await SCANNERS["github-copilot"](testRoot, testHome, getTool("github-copilot"));
      const contexts = items.filter((i) => i.type === "context-file");
      assert.equal(contexts.length, 1);
      if (contexts[0].type === "context-file") {
        assert.equal(contexts[0].name, "copilot-instructions.md");
      }
    } finally {
      cleanup();
    }
  });
  test("discovers .instructions.md files with frontmatter", async () => {
    const { testRoot, testHome, cleanup } = makeTempDirs();
    try {
      writeText(
        join(testRoot, ".github/instructions/react.instructions.md"),
        '---\napplyTo: "**/*.tsx"\n---\nUse React functional components.'
      );
      const { items } = await SCANNERS["github-copilot"](testRoot, testHome, getTool("github-copilot"));
      const rules = items.filter((i) => i.type === "rule");
      assert.equal(rules.length, 1);
      if (rules[0].type === "rule") {
        assert.equal(rules[0].name, "react");
        assert.deepEqual(rules[0].globs, ["**/*.tsx"]);
      }
    } finally {
      cleanup();
    }
  });
});
describe("VS Code scanner", () => {
  test("discovers settings.json", async () => {
    const { testRoot, testHome, cleanup } = makeTempDirs();
    try {
      writeJson(join(testRoot, ".vscode/settings.json"), {
        "editor.fontSize": 14
      });
      const { items } = await SCANNERS.vscode(testRoot, testHome, getTool("vscode"));
      const settings = items.filter((i) => i.type === "settings");
      assert.equal(settings.length, 1);
    } finally {
      cleanup();
    }
  });
  test("discovers MCP servers from .vscode/mcp.json", async () => {
    const { testRoot, testHome, cleanup } = makeTempDirs();
    try {
      writeJson(join(testRoot, ".vscode/mcp.json"), {
        servers: { "vscode-mcp": { command: "node", args: ["mcp.js"] } }
      });
      const { items } = await SCANNERS.vscode(testRoot, testHome, getTool("vscode"));
      const servers = items.filter((i) => i.type === "mcp-server");
      assert.equal(servers.length, 1);
      if (servers[0].type === "mcp-server") {
        assert.equal(servers[0].name, "vscode-mcp");
      }
    } finally {
      cleanup();
    }
  });
  test("discovers MCP servers embedded in settings.json", async () => {
    const { testRoot, testHome, cleanup } = makeTempDirs();
    try {
      writeJson(join(testRoot, ".vscode/settings.json"), {
        "mcp.servers": {
          "embedded-mcp": { command: "python", args: ["-m", "mcp_server"] }
        }
      });
      const { items } = await SCANNERS.vscode(testRoot, testHome, getTool("vscode"));
      const servers = items.filter((i) => i.type === "mcp-server");
      assert.equal(servers.length, 1);
      if (servers[0].type === "mcp-server") {
        assert.equal(servers[0].name, "embedded-mcp");
      }
    } finally {
      cleanup();
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL3VuaXZlcnNhbC1jb25maWcvdGVzdHMvc2Nhbm5lcnMudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBUZXN0cyBmb3IgdW5pdmVyc2FsIGNvbmZpZyBkaXNjb3Zlcnkgc2Nhbm5lcnMuXG4gKlxuICogVXNlcyB0ZW1wb3JhcnkgZGlyZWN0b3JpZXMgdG8gc2ltdWxhdGUgY29uZmlnIGxheW91dHMgZnJvbSBlYWNoIHRvb2wuXG4gKiBSdW5zIHdpdGg6IG5vZGUgLS1leHBlcmltZW50YWwtc3RyaXAtdHlwZXMgLS10ZXN0XG4gKi9cblxuaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgeyBzdHJpY3QgYXMgYXNzZXJ0IH0gZnJvbSBcIm5vZGU6YXNzZXJ0XCI7XG5pbXBvcnQgeyBta2RpclN5bmMsIHdyaXRlRmlsZVN5bmMsIHJtU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IFNDQU5ORVJTIH0gZnJvbSBcIi4uL3NjYW5uZXJzLnRzXCI7XG5pbXBvcnQgeyBUT09MUyB9IGZyb20gXCIuLi90b29scy50c1wiO1xuaW1wb3J0IHR5cGUgeyBUb29sSW5mbywgRGlzY292ZXJlZEl0ZW0gfSBmcm9tIFwiLi4vdHlwZXMudHNcIjtcblxuLy8gXHUyNTAwXHUyNTAwIEhlbHBlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIGdldFRvb2woaWQ6IHN0cmluZyk6IFRvb2xJbmZvIHtcbiAgY29uc3QgdG9vbCA9IFRPT0xTLmZpbmQoKHQpID0+IHQuaWQgPT09IGlkKTtcbiAgaWYgKCF0b29sKSB0aHJvdyBuZXcgRXJyb3IoYFVua25vd24gdG9vbDogJHtpZH1gKTtcbiAgcmV0dXJuIHRvb2w7XG59XG5cbmZ1bmN0aW9uIG1rZGlycChwYXRoOiBzdHJpbmcpIHtcbiAgbWtkaXJTeW5jKHBhdGgsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xufVxuXG5mdW5jdGlvbiB3cml0ZUpzb24ocGF0aDogc3RyaW5nLCBkYXRhOiB1bmtub3duKSB7XG4gIG1rZGlycChqb2luKHBhdGgsIFwiLi5cIikpO1xuICB3cml0ZUZpbGVTeW5jKHBhdGgsIEpTT04uc3RyaW5naWZ5KGRhdGEsIG51bGwsIDIpLCBcInV0ZjhcIik7XG59XG5cbmZ1bmN0aW9uIHdyaXRlVGV4dChwYXRoOiBzdHJpbmcsIGNvbnRlbnQ6IHN0cmluZykge1xuICBta2RpcnAoam9pbihwYXRoLCBcIi4uXCIpKTtcbiAgd3JpdGVGaWxlU3luYyhwYXRoLCBjb250ZW50LCBcInV0ZjhcIik7XG59XG5cbmZ1bmN0aW9uIG1ha2VUZW1wRGlycygpOiB7IHRlc3RSb290OiBzdHJpbmc7IHRlc3RIb21lOiBzdHJpbmc7IGNsZWFudXA6ICgpID0+IHZvaWQgfSB7XG4gIGNvbnN0IGJhc2UgPSBqb2luKHRtcGRpcigpLCBgdWNkLXRlc3QtJHtEYXRlLm5vdygpfS0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDgpfWApO1xuICBjb25zdCB0ZXN0Um9vdCA9IGpvaW4oYmFzZSwgXCJwcm9qZWN0XCIpO1xuICBjb25zdCB0ZXN0SG9tZSA9IGpvaW4oYmFzZSwgXCJob21lXCIpO1xuICBta2RpcnAodGVzdFJvb3QpO1xuICBta2RpcnAodGVzdEhvbWUpO1xuICByZXR1cm4ge1xuICAgIHRlc3RSb290LFxuICAgIHRlc3RIb21lLFxuICAgIGNsZWFudXA6ICgpID0+IHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSksXG4gIH07XG59XG5cbi8vIFx1MjUwMFx1MjUwMCBDbGF1ZGUgQ29kZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJDbGF1ZGUgQ29kZSBzY2FubmVyXCIsICgpID0+IHtcbiAgdGVzdChcImRpc2NvdmVycyBNQ1Agc2VydmVycyBmcm9tIH4vLmNsYXVkZS5qc29uXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB7IHRlc3RSb290LCB0ZXN0SG9tZSwgY2xlYW51cCB9ID0gbWFrZVRlbXBEaXJzKCk7XG4gICAgdHJ5IHtcbiAgICAgIHdyaXRlSnNvbihqb2luKHRlc3RIb21lLCBcIi5jbGF1ZGUuanNvblwiKSwge1xuICAgICAgICBtY3BTZXJ2ZXJzOiB7XG4gICAgICAgICAgXCJ0ZXN0LXNlcnZlclwiOiB7IGNvbW1hbmQ6IFwibnB4XCIsIGFyZ3M6IFtcIi15XCIsIFwidGVzdC1tY3BcIl0sIHR5cGU6IFwic3RkaW9cIiB9LFxuICAgICAgICB9LFxuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IHsgaXRlbXMgfSA9IGF3YWl0IFNDQU5ORVJTLmNsYXVkZSh0ZXN0Um9vdCwgdGVzdEhvbWUsIGdldFRvb2woXCJjbGF1ZGVcIikpO1xuICAgICAgY29uc3Qgc2VydmVycyA9IGl0ZW1zLmZpbHRlcigoaSkgPT4gaS50eXBlID09PSBcIm1jcC1zZXJ2ZXJcIik7XG4gICAgICBhc3NlcnQuZXF1YWwoc2VydmVycy5sZW5ndGgsIDEpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHNlcnZlcnNbMF0hLnR5cGUsIFwibWNwLXNlcnZlclwiKTtcbiAgICAgIGlmIChzZXJ2ZXJzWzBdIS50eXBlID09PSBcIm1jcC1zZXJ2ZXJcIikge1xuICAgICAgICBhc3NlcnQuZXF1YWwoc2VydmVyc1swXSEubmFtZSwgXCJ0ZXN0LXNlcnZlclwiKTtcbiAgICAgICAgYXNzZXJ0LmVxdWFsKHNlcnZlcnNbMF0hLmNvbW1hbmQsIFwibnB4XCIpO1xuICAgICAgICBhc3NlcnQuZXF1YWwoc2VydmVyc1swXSEudHJhbnNwb3J0LCBcInN0ZGlvXCIpO1xuICAgICAgICBhc3NlcnQuZXF1YWwoc2VydmVyc1swXSEuc291cmNlLmxldmVsLCBcInVzZXJcIik7XG4gICAgICB9XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoKTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJkaXNjb3ZlcnMgcHJvamVjdCBNQ1AgZnJvbSAuY2xhdWRlLy5tY3AuanNvblwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyB0ZXN0Um9vdCwgdGVzdEhvbWUsIGNsZWFudXAgfSA9IG1ha2VUZW1wRGlycygpO1xuICAgIHRyeSB7XG4gICAgICB3cml0ZUpzb24oam9pbih0ZXN0Um9vdCwgXCIuY2xhdWRlLy5tY3AuanNvblwiKSwge1xuICAgICAgICBtY3BTZXJ2ZXJzOiB7IFwicHJvamVjdC1zZXJ2ZXJcIjogeyBjb21tYW5kOiBcIm5vZGVcIiwgYXJnczogW1wic2VydmVyLmpzXCJdIH0gfSxcbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCB7IGl0ZW1zIH0gPSBhd2FpdCBTQ0FOTkVSUy5jbGF1ZGUodGVzdFJvb3QsIHRlc3RIb21lLCBnZXRUb29sKFwiY2xhdWRlXCIpKTtcbiAgICAgIGNvbnN0IHNlcnZlcnMgPSBpdGVtcy5maWx0ZXIoKGkpID0+IGkudHlwZSA9PT0gXCJtY3Atc2VydmVyXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHNlcnZlcnMubGVuZ3RoLCAxKTtcbiAgICAgIGFzc2VydC5lcXVhbChzZXJ2ZXJzWzBdIS5zb3VyY2UubGV2ZWwsIFwicHJvamVjdFwiKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cCgpO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcImRpc2NvdmVycyBDTEFVREUubWQgY29udGV4dCBmaWxlc1wiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyB0ZXN0Um9vdCwgdGVzdEhvbWUsIGNsZWFudXAgfSA9IG1ha2VUZW1wRGlycygpO1xuICAgIHRyeSB7XG4gICAgICB3cml0ZVRleHQoam9pbih0ZXN0SG9tZSwgXCIuY2xhdWRlL0NMQVVERS5tZFwiKSwgXCIjIFVzZXIgaW5zdHJ1Y3Rpb25zXCIpO1xuICAgICAgd3JpdGVUZXh0KGpvaW4odGVzdFJvb3QsIFwiQ0xBVURFLm1kXCIpLCBcIiMgUHJvamVjdCByb290IGluc3RydWN0aW9uc1wiKTtcbiAgICAgIHdyaXRlVGV4dChqb2luKHRlc3RSb290LCBcIi5jbGF1ZGUvQ0xBVURFLm1kXCIpLCBcIiMgUHJvamVjdCAuY2xhdWRlIGluc3RydWN0aW9uc1wiKTtcblxuICAgICAgY29uc3QgeyBpdGVtcyB9ID0gYXdhaXQgU0NBTk5FUlMuY2xhdWRlKHRlc3RSb290LCB0ZXN0SG9tZSwgZ2V0VG9vbChcImNsYXVkZVwiKSk7XG4gICAgICBjb25zdCBjb250ZXh0cyA9IGl0ZW1zLmZpbHRlcigoaSkgPT4gaS50eXBlID09PSBcImNvbnRleHQtZmlsZVwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChjb250ZXh0cy5sZW5ndGgsIDMpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKCk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwiZGlzY292ZXJzIENsYXVkZSBDb2RlIHNraWxscyBhbmQgcGx1Z2luc1wiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyB0ZXN0Um9vdCwgdGVzdEhvbWUsIGNsZWFudXAgfSA9IG1ha2VUZW1wRGlycygpO1xuICAgIHRyeSB7XG4gICAgICB3cml0ZVRleHQoam9pbih0ZXN0SG9tZSwgXCIuY2xhdWRlL3NraWxscy90ZXN0LXNraWxsL1NLSUxMLm1kXCIpLCBcIiMgdGVzdCBza2lsbFwiKTtcbiAgICAgIHdyaXRlSnNvbihqb2luKHRlc3RIb21lLCBcIi5jbGF1ZGUvcGx1Z2lucy90ZXN0LXBsdWdpbi9wYWNrYWdlLmpzb25cIiksIHsgbmFtZTogXCJ0ZXN0LXBsdWdpblwiIH0pO1xuXG4gICAgICBjb25zdCB7IGl0ZW1zIH0gPSBhd2FpdCBTQ0FOTkVSUy5jbGF1ZGUodGVzdFJvb3QsIHRlc3RIb21lLCBnZXRUb29sKFwiY2xhdWRlXCIpKTtcbiAgICAgIGNvbnN0IHNraWxscyA9IGl0ZW1zLmZpbHRlcigoaSkgPT4gaS50eXBlID09PSBcImNsYXVkZS1za2lsbFwiKTtcbiAgICAgIGNvbnN0IHBsdWdpbnMgPSBpdGVtcy5maWx0ZXIoKGkpID0+IGkudHlwZSA9PT0gXCJjbGF1ZGUtcGx1Z2luXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHNraWxscy5sZW5ndGgsIDEpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHBsdWdpbnMubGVuZ3RoLCAxKTtcbiAgICAgIGlmIChza2lsbHNbMF0/LnR5cGUgPT09IFwiY2xhdWRlLXNraWxsXCIpIGFzc2VydC5lcXVhbChza2lsbHNbMF0ubmFtZSwgXCJ0ZXN0LXNraWxsXCIpO1xuICAgICAgaWYgKHBsdWdpbnNbMF0/LnR5cGUgPT09IFwiY2xhdWRlLXBsdWdpblwiKSBhc3NlcnQuZXF1YWwocGx1Z2luc1swXS5uYW1lLCBcInRlc3QtcGx1Z2luXCIpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKCk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwiZGlzY292ZXJzIHNldHRpbmdzLmpzb25cIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHsgdGVzdFJvb3QsIHRlc3RIb21lLCBjbGVhbnVwIH0gPSBtYWtlVGVtcERpcnMoKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVKc29uKGpvaW4odGVzdEhvbWUsIFwiLmNsYXVkZS9zZXR0aW5ncy5qc29uXCIpLCB7IHRoZW1lOiBcImRhcmtcIiB9KTtcblxuICAgICAgY29uc3QgeyBpdGVtcyB9ID0gYXdhaXQgU0NBTk5FUlMuY2xhdWRlKHRlc3RSb290LCB0ZXN0SG9tZSwgZ2V0VG9vbChcImNsYXVkZVwiKSk7XG4gICAgICBjb25zdCBzZXR0aW5ncyA9IGl0ZW1zLmZpbHRlcigoaSkgPT4gaS50eXBlID09PSBcInNldHRpbmdzXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHNldHRpbmdzLmxlbmd0aCwgMSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoKTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJoYW5kbGVzIG1pc3NpbmcgZmlsZXMgZ3JhY2VmdWxseVwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyB0ZXN0Um9vdCwgdGVzdEhvbWUsIGNsZWFudXAgfSA9IG1ha2VUZW1wRGlycygpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB7IGl0ZW1zLCB3YXJuaW5ncyB9ID0gYXdhaXQgU0NBTk5FUlMuY2xhdWRlKHRlc3RSb290LCB0ZXN0SG9tZSwgZ2V0VG9vbChcImNsYXVkZVwiKSk7XG4gICAgICBhc3NlcnQuZXF1YWwoaXRlbXMubGVuZ3RoLCAwKTtcbiAgICAgIGFzc2VydC5lcXVhbCh3YXJuaW5ncy5sZW5ndGgsIDApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKCk7XG4gICAgfVxuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDAgQ3Vyc29yIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcIkN1cnNvciBzY2FubmVyXCIsICgpID0+IHtcbiAgdGVzdChcImRpc2NvdmVycyBNQ1Agc2VydmVycyBmcm9tIC5jdXJzb3IvbWNwLmpzb25cIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHsgdGVzdFJvb3QsIHRlc3RIb21lLCBjbGVhbnVwIH0gPSBtYWtlVGVtcERpcnMoKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVKc29uKGpvaW4odGVzdFJvb3QsIFwiLmN1cnNvci9tY3AuanNvblwiKSwge1xuICAgICAgICBtY3BTZXJ2ZXJzOiB7IFwiY3Vyc29yLW1jcFwiOiB7IGNvbW1hbmQ6IFwicHl0aG9uXCIsIGFyZ3M6IFtcIm1jcC5weVwiXSwgdHlwZTogXCJzdGRpb1wiIH0gfSxcbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCB7IGl0ZW1zIH0gPSBhd2FpdCBTQ0FOTkVSUy5jdXJzb3IodGVzdFJvb3QsIHRlc3RIb21lLCBnZXRUb29sKFwiY3Vyc29yXCIpKTtcbiAgICAgIGNvbnN0IHNlcnZlcnMgPSBpdGVtcy5maWx0ZXIoKGkpID0+IGkudHlwZSA9PT0gXCJtY3Atc2VydmVyXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHNlcnZlcnMubGVuZ3RoLCAxKTtcbiAgICAgIGlmIChzZXJ2ZXJzWzBdIS50eXBlID09PSBcIm1jcC1zZXJ2ZXJcIikge1xuICAgICAgICBhc3NlcnQuZXF1YWwoc2VydmVyc1swXSEubmFtZSwgXCJjdXJzb3ItbWNwXCIpO1xuICAgICAgICBhc3NlcnQuZXF1YWwoc2VydmVyc1swXSEuY29tbWFuZCwgXCJweXRob25cIik7XG4gICAgICB9XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoKTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJkaXNjb3ZlcnMgcnVsZXMgZnJvbSAuY3Vyc29yL3J1bGVzLyoubWRjXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB7IHRlc3RSb290LCB0ZXN0SG9tZSwgY2xlYW51cCB9ID0gbWFrZVRlbXBEaXJzKCk7XG4gICAgdHJ5IHtcbiAgICAgIHdyaXRlVGV4dChcbiAgICAgICAgam9pbih0ZXN0Um9vdCwgXCIuY3Vyc29yL3J1bGVzL2NvZGluZy1zdHlsZS5tZGNcIiksXG4gICAgICAgIFwiLS0tXFxuZGVzY3JpcHRpb246IENvZGluZyBzdHlsZSBydWxlc1xcbmFsd2F5c0FwcGx5OiB0cnVlXFxuLS0tXFxuVXNlIFR5cGVTY3JpcHQgc3RyaWN0IG1vZGUuXCIsXG4gICAgICApO1xuXG4gICAgICBjb25zdCB7IGl0ZW1zIH0gPSBhd2FpdCBTQ0FOTkVSUy5jdXJzb3IodGVzdFJvb3QsIHRlc3RIb21lLCBnZXRUb29sKFwiY3Vyc29yXCIpKTtcbiAgICAgIGNvbnN0IHJ1bGVzID0gaXRlbXMuZmlsdGVyKChpKSA9PiBpLnR5cGUgPT09IFwicnVsZVwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChydWxlcy5sZW5ndGgsIDEpO1xuICAgICAgaWYgKHJ1bGVzWzBdIS50eXBlID09PSBcInJ1bGVcIikge1xuICAgICAgICBhc3NlcnQuZXF1YWwocnVsZXNbMF0hLm5hbWUsIFwiY29kaW5nLXN0eWxlXCIpO1xuICAgICAgICBhc3NlcnQuZXF1YWwocnVsZXNbMF0hLmFsd2F5c0FwcGx5LCB0cnVlKTtcbiAgICAgICAgYXNzZXJ0LmVxdWFsKHJ1bGVzWzBdIS5kZXNjcmlwdGlvbiwgXCJDb2Rpbmcgc3R5bGUgcnVsZXNcIik7XG4gICAgICB9XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoKTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJkaXNjb3ZlcnMgbGVnYWN5IC5jdXJzb3JydWxlc1wiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyB0ZXN0Um9vdCwgdGVzdEhvbWUsIGNsZWFudXAgfSA9IG1ha2VUZW1wRGlycygpO1xuICAgIHRyeSB7XG4gICAgICB3cml0ZVRleHQoam9pbih0ZXN0Um9vdCwgXCIuY3Vyc29ycnVsZXNcIiksIFwiQWx3YXlzIHVzZSBzZW1pY29sb25zLlwiKTtcblxuICAgICAgY29uc3QgeyBpdGVtcyB9ID0gYXdhaXQgU0NBTk5FUlMuY3Vyc29yKHRlc3RSb290LCB0ZXN0SG9tZSwgZ2V0VG9vbChcImN1cnNvclwiKSk7XG4gICAgICBjb25zdCBydWxlcyA9IGl0ZW1zLmZpbHRlcigoaSkgPT4gaS50eXBlID09PSBcInJ1bGVcIik7XG4gICAgICBhc3NlcnQuZXF1YWwocnVsZXMubGVuZ3RoLCAxKTtcbiAgICAgIGlmIChydWxlc1swXSEudHlwZSA9PT0gXCJydWxlXCIpIHtcbiAgICAgICAgYXNzZXJ0LmVxdWFsKHJ1bGVzWzBdIS5jb250ZW50LCBcIkFsd2F5cyB1c2Ugc2VtaWNvbG9ucy5cIik7XG4gICAgICB9XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoKTtcbiAgICB9XG4gIH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMCBXaW5kc3VyZiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJXaW5kc3VyZiBzY2FubmVyXCIsICgpID0+IHtcbiAgdGVzdChcImRpc2NvdmVycyBNQ1Agc2VydmVycyBmcm9tIG1jcF9jb25maWcuanNvblwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyB0ZXN0Um9vdCwgdGVzdEhvbWUsIGNsZWFudXAgfSA9IG1ha2VUZW1wRGlycygpO1xuICAgIHRyeSB7XG4gICAgICB3cml0ZUpzb24oam9pbih0ZXN0Um9vdCwgXCIud2luZHN1cmYvbWNwX2NvbmZpZy5qc29uXCIpLCB7XG4gICAgICAgIG1jcFNlcnZlcnM6IHsgXCJ3cy1zZXJ2ZXJcIjogeyBjb21tYW5kOiBcIm5vZGVcIiwgYXJnczogW1wid3MuanNcIl0gfSB9LFxuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IHsgaXRlbXMgfSA9IGF3YWl0IFNDQU5ORVJTLndpbmRzdXJmKHRlc3RSb290LCB0ZXN0SG9tZSwgZ2V0VG9vbChcIndpbmRzdXJmXCIpKTtcbiAgICAgIGNvbnN0IHNlcnZlcnMgPSBpdGVtcy5maWx0ZXIoKGkpID0+IGkudHlwZSA9PT0gXCJtY3Atc2VydmVyXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHNlcnZlcnMubGVuZ3RoLCAxKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cCgpO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcImRpc2NvdmVycyBnbG9iYWwgcnVsZXMgZnJvbSB1c2VyIGRpclwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyB0ZXN0Um9vdCwgdGVzdEhvbWUsIGNsZWFudXAgfSA9IG1ha2VUZW1wRGlycygpO1xuICAgIHRyeSB7XG4gICAgICB3cml0ZVRleHQoam9pbih0ZXN0SG9tZSwgXCIuY29kZWl1bS93aW5kc3VyZi9tZW1vcmllcy9nbG9iYWxfcnVsZXMubWRcIiksIFwiQmUgY29uY2lzZS5cIik7XG5cbiAgICAgIGNvbnN0IHsgaXRlbXMgfSA9IGF3YWl0IFNDQU5ORVJTLndpbmRzdXJmKHRlc3RSb290LCB0ZXN0SG9tZSwgZ2V0VG9vbChcIndpbmRzdXJmXCIpKTtcbiAgICAgIGNvbnN0IHJ1bGVzID0gaXRlbXMuZmlsdGVyKChpKSA9PiBpLnR5cGUgPT09IFwicnVsZVwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChydWxlcy5sZW5ndGgsIDEpO1xuICAgICAgaWYgKHJ1bGVzWzBdIS50eXBlID09PSBcInJ1bGVcIikge1xuICAgICAgICBhc3NlcnQuZXF1YWwocnVsZXNbMF0hLm5hbWUsIFwiZ2xvYmFsX3J1bGVzXCIpO1xuICAgICAgICBhc3NlcnQuZXF1YWwocnVsZXNbMF0hLmFsd2F5c0FwcGx5LCB0cnVlKTtcbiAgICAgIH1cbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cCgpO1xuICAgIH1cbiAgfSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwIEdlbWluaSBDTEkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiR2VtaW5pIENMSSBzY2FubmVyXCIsICgpID0+IHtcbiAgdGVzdChcImRpc2NvdmVycyBNQ1Agc2VydmVycyBmcm9tIHNldHRpbmdzLmpzb25cIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHsgdGVzdFJvb3QsIHRlc3RIb21lLCBjbGVhbnVwIH0gPSBtYWtlVGVtcERpcnMoKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVKc29uKGpvaW4odGVzdFJvb3QsIFwiLmdlbWluaS9zZXR0aW5ncy5qc29uXCIpLCB7XG4gICAgICAgIG1jcFNlcnZlcnM6IHsgXCJnZW1pbmktbWNwXCI6IHsgY29tbWFuZDogXCJkZW5vXCIsIGFyZ3M6IFtcInJ1blwiLCBcIm1jcC50c1wiXSB9IH0sXG4gICAgICB9KTtcblxuICAgICAgY29uc3QgeyBpdGVtcyB9ID0gYXdhaXQgU0NBTk5FUlMuZ2VtaW5pKHRlc3RSb290LCB0ZXN0SG9tZSwgZ2V0VG9vbChcImdlbWluaVwiKSk7XG4gICAgICBjb25zdCBzZXJ2ZXJzID0gaXRlbXMuZmlsdGVyKChpKSA9PiBpLnR5cGUgPT09IFwibWNwLXNlcnZlclwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChzZXJ2ZXJzLmxlbmd0aCwgMSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoKTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJkaXNjb3ZlcnMgR0VNSU5JLm1kIGNvbnRleHQgZmlsZXNcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHsgdGVzdFJvb3QsIHRlc3RIb21lLCBjbGVhbnVwIH0gPSBtYWtlVGVtcERpcnMoKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVUZXh0KGpvaW4odGVzdEhvbWUsIFwiLmdlbWluaS9HRU1JTkkubWRcIiksIFwiVXNlciBnZW1pbmkgaW5zdHJ1Y3Rpb25zXCIpO1xuICAgICAgd3JpdGVUZXh0KGpvaW4odGVzdFJvb3QsIFwiLmdlbWluaS9HRU1JTkkubWRcIiksIFwiUHJvamVjdCBnZW1pbmkgaW5zdHJ1Y3Rpb25zXCIpO1xuXG4gICAgICBjb25zdCB7IGl0ZW1zIH0gPSBhd2FpdCBTQ0FOTkVSUy5nZW1pbmkodGVzdFJvb3QsIHRlc3RIb21lLCBnZXRUb29sKFwiZ2VtaW5pXCIpKTtcbiAgICAgIGNvbnN0IGNvbnRleHRzID0gaXRlbXMuZmlsdGVyKChpKSA9PiBpLnR5cGUgPT09IFwiY29udGV4dC1maWxlXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGNvbnRleHRzLmxlbmd0aCwgMik7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoKTtcbiAgICB9XG4gIH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMCBDb2RleCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJDb2RleCBzY2FubmVyXCIsICgpID0+IHtcbiAgdGVzdChcImRpc2NvdmVycyBBR0VOVFMubWQgZnJvbSB1c2VyIGRpclwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyB0ZXN0Um9vdCwgdGVzdEhvbWUsIGNsZWFudXAgfSA9IG1ha2VUZW1wRGlycygpO1xuICAgIHRyeSB7XG4gICAgICB3cml0ZVRleHQoam9pbih0ZXN0SG9tZSwgXCIuY29kZXgvQUdFTlRTLm1kXCIpLCBcIkNvZGV4IHVzZXIgaW5zdHJ1Y3Rpb25zXCIpO1xuXG4gICAgICBjb25zdCB7IGl0ZW1zIH0gPSBhd2FpdCBTQ0FOTkVSUy5jb2RleCh0ZXN0Um9vdCwgdGVzdEhvbWUsIGdldFRvb2woXCJjb2RleFwiKSk7XG4gICAgICBjb25zdCBjb250ZXh0cyA9IGl0ZW1zLmZpbHRlcigoaSkgPT4gaS50eXBlID09PSBcImNvbnRleHQtZmlsZVwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChjb250ZXh0cy5sZW5ndGgsIDEpO1xuICAgICAgaWYgKGNvbnRleHRzWzBdIS50eXBlID09PSBcImNvbnRleHQtZmlsZVwiKSB7XG4gICAgICAgIGFzc2VydC5lcXVhbChjb250ZXh0c1swXSEubmFtZSwgXCJBR0VOVFMubWQgKHVzZXIpXCIpO1xuICAgICAgfVxuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKCk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwid2FybnMgYWJvdXQgVE9NTCBjb25maWdcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHsgdGVzdFJvb3QsIHRlc3RIb21lLCBjbGVhbnVwIH0gPSBtYWtlVGVtcERpcnMoKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVUZXh0KGpvaW4odGVzdEhvbWUsIFwiLmNvZGV4L2NvbmZpZy50b21sXCIpLCBcIlttY3Bfc2VydmVycy50ZXN0XVxcbmNvbW1hbmQgPSAnbm9kZSdcIik7XG5cbiAgICAgIGNvbnN0IHsgd2FybmluZ3MgfSA9IGF3YWl0IFNDQU5ORVJTLmNvZGV4KHRlc3RSb290LCB0ZXN0SG9tZSwgZ2V0VG9vbChcImNvZGV4XCIpKTtcbiAgICAgIGFzc2VydC5vayh3YXJuaW5ncy5sZW5ndGggPiAwKTtcbiAgICAgIGFzc2VydC5vayh3YXJuaW5nc1swXSEuaW5jbHVkZXMoXCJUT01MXCIpKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cCgpO1xuICAgIH1cbiAgfSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwIENsaW5lIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcIkNsaW5lIHNjYW5uZXJcIiwgKCkgPT4ge1xuICB0ZXN0KFwiZGlzY292ZXJzIC5jbGluZXJ1bGVzIGFzIHNpbmdsZSBmaWxlXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB7IHRlc3RSb290LCB0ZXN0SG9tZSwgY2xlYW51cCB9ID0gbWFrZVRlbXBEaXJzKCk7XG4gICAgdHJ5IHtcbiAgICAgIHdyaXRlVGV4dChqb2luKHRlc3RSb290LCBcIi5jbGluZXJ1bGVzXCIpLCBcIkZvbGxvdyBUREQuXCIpO1xuXG4gICAgICBjb25zdCB7IGl0ZW1zIH0gPSBhd2FpdCBTQ0FOTkVSUy5jbGluZSh0ZXN0Um9vdCwgdGVzdEhvbWUsIGdldFRvb2woXCJjbGluZVwiKSk7XG4gICAgICBjb25zdCBydWxlcyA9IGl0ZW1zLmZpbHRlcigoaSkgPT4gaS50eXBlID09PSBcInJ1bGVcIik7XG4gICAgICBhc3NlcnQuZXF1YWwocnVsZXMubGVuZ3RoLCAxKTtcbiAgICAgIGlmIChydWxlc1swXSEudHlwZSA9PT0gXCJydWxlXCIpIHtcbiAgICAgICAgYXNzZXJ0LmVxdWFsKHJ1bGVzWzBdIS5uYW1lLCBcImNsaW5lcnVsZXNcIik7XG4gICAgICAgIGFzc2VydC5lcXVhbChydWxlc1swXSEuYWx3YXlzQXBwbHksIHRydWUpO1xuICAgICAgfVxuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKCk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwiZGlzY292ZXJzIC5jbGluZXJ1bGVzIGFzIGRpcmVjdG9yeVwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyB0ZXN0Um9vdCwgdGVzdEhvbWUsIGNsZWFudXAgfSA9IG1ha2VUZW1wRGlycygpO1xuICAgIHRyeSB7XG4gICAgICBta2RpcnAoam9pbih0ZXN0Um9vdCwgXCIuY2xpbmVydWxlc1wiKSk7XG4gICAgICB3cml0ZVRleHQoam9pbih0ZXN0Um9vdCwgXCIuY2xpbmVydWxlcy9zdHlsZS5tZFwiKSwgXCJVc2UgMi1zcGFjZSBpbmRlbnQuXCIpO1xuICAgICAgd3JpdGVUZXh0KGpvaW4odGVzdFJvb3QsIFwiLmNsaW5lcnVsZXMvdGVzdGluZy5tZFwiKSwgXCJXcml0ZSB0ZXN0cyBmaXJzdC5cIik7XG5cbiAgICAgIGNvbnN0IHsgaXRlbXMgfSA9IGF3YWl0IFNDQU5ORVJTLmNsaW5lKHRlc3RSb290LCB0ZXN0SG9tZSwgZ2V0VG9vbChcImNsaW5lXCIpKTtcbiAgICAgIGNvbnN0IHJ1bGVzID0gaXRlbXMuZmlsdGVyKChpKSA9PiBpLnR5cGUgPT09IFwicnVsZVwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChydWxlcy5sZW5ndGgsIDIpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKCk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwiaGFuZGxlcyBtaXNzaW5nIC5jbGluZXJ1bGVzXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB7IHRlc3RSb290LCB0ZXN0SG9tZSwgY2xlYW51cCB9ID0gbWFrZVRlbXBEaXJzKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHsgaXRlbXMgfSA9IGF3YWl0IFNDQU5ORVJTLmNsaW5lKHRlc3RSb290LCB0ZXN0SG9tZSwgZ2V0VG9vbChcImNsaW5lXCIpKTtcbiAgICAgIGFzc2VydC5lcXVhbChpdGVtcy5sZW5ndGgsIDApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKCk7XG4gICAgfVxuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDAgR2l0SHViIENvcGlsb3QgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiR2l0SHViIENvcGlsb3Qgc2Nhbm5lclwiLCAoKSA9PiB7XG4gIHRlc3QoXCJkaXNjb3ZlcnMgY29waWxvdC1pbnN0cnVjdGlvbnMubWRcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHsgdGVzdFJvb3QsIHRlc3RIb21lLCBjbGVhbnVwIH0gPSBtYWtlVGVtcERpcnMoKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVUZXh0KGpvaW4odGVzdFJvb3QsIFwiLmdpdGh1Yi9jb3BpbG90LWluc3RydWN0aW9ucy5tZFwiKSwgXCJVc2UgVHlwZVNjcmlwdC5cIik7XG5cbiAgICAgIGNvbnN0IHsgaXRlbXMgfSA9IGF3YWl0IFNDQU5ORVJTW1wiZ2l0aHViLWNvcGlsb3RcIl0odGVzdFJvb3QsIHRlc3RIb21lLCBnZXRUb29sKFwiZ2l0aHViLWNvcGlsb3RcIikpO1xuICAgICAgY29uc3QgY29udGV4dHMgPSBpdGVtcy5maWx0ZXIoKGkpID0+IGkudHlwZSA9PT0gXCJjb250ZXh0LWZpbGVcIik7XG4gICAgICBhc3NlcnQuZXF1YWwoY29udGV4dHMubGVuZ3RoLCAxKTtcbiAgICAgIGlmIChjb250ZXh0c1swXSEudHlwZSA9PT0gXCJjb250ZXh0LWZpbGVcIikge1xuICAgICAgICBhc3NlcnQuZXF1YWwoY29udGV4dHNbMF0hLm5hbWUsIFwiY29waWxvdC1pbnN0cnVjdGlvbnMubWRcIik7XG4gICAgICB9XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoKTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJkaXNjb3ZlcnMgLmluc3RydWN0aW9ucy5tZCBmaWxlcyB3aXRoIGZyb250bWF0dGVyXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB7IHRlc3RSb290LCB0ZXN0SG9tZSwgY2xlYW51cCB9ID0gbWFrZVRlbXBEaXJzKCk7XG4gICAgdHJ5IHtcbiAgICAgIHdyaXRlVGV4dChcbiAgICAgICAgam9pbih0ZXN0Um9vdCwgXCIuZ2l0aHViL2luc3RydWN0aW9ucy9yZWFjdC5pbnN0cnVjdGlvbnMubWRcIiksXG4gICAgICAgICctLS1cXG5hcHBseVRvOiBcIioqLyoudHN4XCJcXG4tLS1cXG5Vc2UgUmVhY3QgZnVuY3Rpb25hbCBjb21wb25lbnRzLicsXG4gICAgICApO1xuXG4gICAgICBjb25zdCB7IGl0ZW1zIH0gPSBhd2FpdCBTQ0FOTkVSU1tcImdpdGh1Yi1jb3BpbG90XCJdKHRlc3RSb290LCB0ZXN0SG9tZSwgZ2V0VG9vbChcImdpdGh1Yi1jb3BpbG90XCIpKTtcbiAgICAgIGNvbnN0IHJ1bGVzID0gaXRlbXMuZmlsdGVyKChpKSA9PiBpLnR5cGUgPT09IFwicnVsZVwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChydWxlcy5sZW5ndGgsIDEpO1xuICAgICAgaWYgKHJ1bGVzWzBdIS50eXBlID09PSBcInJ1bGVcIikge1xuICAgICAgICBhc3NlcnQuZXF1YWwocnVsZXNbMF0hLm5hbWUsIFwicmVhY3RcIik7XG4gICAgICAgIGFzc2VydC5kZWVwRXF1YWwocnVsZXNbMF0hLmdsb2JzLCBbXCIqKi8qLnRzeFwiXSk7XG4gICAgICB9XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoKTtcbiAgICB9XG4gIH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMCBWUyBDb2RlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcIlZTIENvZGUgc2Nhbm5lclwiLCAoKSA9PiB7XG4gIHRlc3QoXCJkaXNjb3ZlcnMgc2V0dGluZ3MuanNvblwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyB0ZXN0Um9vdCwgdGVzdEhvbWUsIGNsZWFudXAgfSA9IG1ha2VUZW1wRGlycygpO1xuICAgIHRyeSB7XG4gICAgICB3cml0ZUpzb24oam9pbih0ZXN0Um9vdCwgXCIudnNjb2RlL3NldHRpbmdzLmpzb25cIiksIHtcbiAgICAgICAgXCJlZGl0b3IuZm9udFNpemVcIjogMTQsXG4gICAgICB9KTtcblxuICAgICAgY29uc3QgeyBpdGVtcyB9ID0gYXdhaXQgU0NBTk5FUlMudnNjb2RlKHRlc3RSb290LCB0ZXN0SG9tZSwgZ2V0VG9vbChcInZzY29kZVwiKSk7XG4gICAgICBjb25zdCBzZXR0aW5ncyA9IGl0ZW1zLmZpbHRlcigoaSkgPT4gaS50eXBlID09PSBcInNldHRpbmdzXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHNldHRpbmdzLmxlbmd0aCwgMSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoKTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJkaXNjb3ZlcnMgTUNQIHNlcnZlcnMgZnJvbSAudnNjb2RlL21jcC5qc29uXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB7IHRlc3RSb290LCB0ZXN0SG9tZSwgY2xlYW51cCB9ID0gbWFrZVRlbXBEaXJzKCk7XG4gICAgdHJ5IHtcbiAgICAgIHdyaXRlSnNvbihqb2luKHRlc3RSb290LCBcIi52c2NvZGUvbWNwLmpzb25cIiksIHtcbiAgICAgICAgc2VydmVyczogeyBcInZzY29kZS1tY3BcIjogeyBjb21tYW5kOiBcIm5vZGVcIiwgYXJnczogW1wibWNwLmpzXCJdIH0gfSxcbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCB7IGl0ZW1zIH0gPSBhd2FpdCBTQ0FOTkVSUy52c2NvZGUodGVzdFJvb3QsIHRlc3RIb21lLCBnZXRUb29sKFwidnNjb2RlXCIpKTtcbiAgICAgIGNvbnN0IHNlcnZlcnMgPSBpdGVtcy5maWx0ZXIoKGkpID0+IGkudHlwZSA9PT0gXCJtY3Atc2VydmVyXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHNlcnZlcnMubGVuZ3RoLCAxKTtcbiAgICAgIGlmIChzZXJ2ZXJzWzBdIS50eXBlID09PSBcIm1jcC1zZXJ2ZXJcIikge1xuICAgICAgICBhc3NlcnQuZXF1YWwoc2VydmVyc1swXSEubmFtZSwgXCJ2c2NvZGUtbWNwXCIpO1xuICAgICAgfVxuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKCk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwiZGlzY292ZXJzIE1DUCBzZXJ2ZXJzIGVtYmVkZGVkIGluIHNldHRpbmdzLmpzb25cIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHsgdGVzdFJvb3QsIHRlc3RIb21lLCBjbGVhbnVwIH0gPSBtYWtlVGVtcERpcnMoKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVKc29uKGpvaW4odGVzdFJvb3QsIFwiLnZzY29kZS9zZXR0aW5ncy5qc29uXCIpLCB7XG4gICAgICAgIFwibWNwLnNlcnZlcnNcIjoge1xuICAgICAgICAgIFwiZW1iZWRkZWQtbWNwXCI6IHsgY29tbWFuZDogXCJweXRob25cIiwgYXJnczogW1wiLW1cIiwgXCJtY3Bfc2VydmVyXCJdIH0sXG4gICAgICAgIH0sXG4gICAgICB9KTtcblxuICAgICAgY29uc3QgeyBpdGVtcyB9ID0gYXdhaXQgU0NBTk5FUlMudnNjb2RlKHRlc3RSb290LCB0ZXN0SG9tZSwgZ2V0VG9vbChcInZzY29kZVwiKSk7XG4gICAgICBjb25zdCBzZXJ2ZXJzID0gaXRlbXMuZmlsdGVyKChpKSA9PiBpLnR5cGUgPT09IFwibWNwLXNlcnZlclwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChzZXJ2ZXJzLmxlbmd0aCwgMSk7XG4gICAgICBpZiAoc2VydmVyc1swXSEudHlwZSA9PT0gXCJtY3Atc2VydmVyXCIpIHtcbiAgICAgICAgYXNzZXJ0LmVxdWFsKHNlcnZlcnNbMF0hLm5hbWUsIFwiZW1iZWRkZWQtbWNwXCIpO1xuICAgICAgfVxuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKCk7XG4gICAgfVxuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBT0EsU0FBUyxVQUFVLFlBQVk7QUFDL0IsU0FBUyxVQUFVLGNBQWM7QUFDakMsU0FBUyxXQUFXLGVBQWUsY0FBYztBQUNqRCxTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsZ0JBQWdCO0FBQ3pCLFNBQVMsYUFBYTtBQUt0QixTQUFTLFFBQVEsSUFBc0I7QUFDckMsUUFBTSxPQUFPLE1BQU0sS0FBSyxDQUFDLE1BQU0sRUFBRSxPQUFPLEVBQUU7QUFDMUMsTUFBSSxDQUFDLEtBQU0sT0FBTSxJQUFJLE1BQU0saUJBQWlCLEVBQUUsRUFBRTtBQUNoRCxTQUFPO0FBQ1Q7QUFFQSxTQUFTLE9BQU8sTUFBYztBQUM1QixZQUFVLE1BQU0sRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNyQztBQUVBLFNBQVMsVUFBVSxNQUFjLE1BQWU7QUFDOUMsU0FBTyxLQUFLLE1BQU0sSUFBSSxDQUFDO0FBQ3ZCLGdCQUFjLE1BQU0sS0FBSyxVQUFVLE1BQU0sTUFBTSxDQUFDLEdBQUcsTUFBTTtBQUMzRDtBQUVBLFNBQVMsVUFBVSxNQUFjLFNBQWlCO0FBQ2hELFNBQU8sS0FBSyxNQUFNLElBQUksQ0FBQztBQUN2QixnQkFBYyxNQUFNLFNBQVMsTUFBTTtBQUNyQztBQUVBLFNBQVMsZUFBNEU7QUFDbkYsUUFBTSxPQUFPLEtBQUssT0FBTyxHQUFHLFlBQVksS0FBSyxJQUFJLENBQUMsSUFBSSxLQUFLLE9BQU8sRUFBRSxTQUFTLEVBQUUsRUFB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
