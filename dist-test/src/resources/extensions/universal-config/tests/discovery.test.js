import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverAllConfigs } from "../discovery.js";
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
  const base = join(tmpdir(), `ucd-disc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const testRoot = join(base, "project");
  const testHome = join(base, "home");
  mkdirp(testRoot);
  mkdirp(testHome);
  return { testRoot, testHome, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
describe("discoverAllConfigs", () => {
  test("returns empty result for clean directories", async () => {
    const { testRoot, testHome, cleanup } = makeTempDirs();
    try {
      const result = await discoverAllConfigs(testRoot, testHome);
      assert.equal(result.summary.totalItems, 0);
      assert.equal(result.summary.toolsScanned, 8);
      assert.equal(result.summary.toolsWithConfig, 0);
      assert.equal(result.summary.claudeSkills, 0);
      assert.equal(result.summary.claudePlugins, 0);
      assert.ok(result.durationMs >= 0);
    } finally {
      cleanup();
    }
  });
  test("discovers config from multiple tools", async () => {
    const { testRoot, testHome, cleanup } = makeTempDirs();
    try {
      writeJson(join(testHome, ".claude.json"), {
        mcpServers: { "claude-mcp": { command: "node", args: ["server.js"] } }
      });
      writeText(join(testHome, ".claude/skills/test-skill/SKILL.md"), "# Test skill");
      writeJson(join(testHome, ".claude/plugins/test-plugin/package.json"), { name: "test-plugin" });
      writeText(join(testRoot, ".cursorrules"), "Use semicolons.");
      writeText(join(testRoot, ".github/copilot-instructions.md"), "Be helpful.");
      const result = await discoverAllConfigs(testRoot, testHome);
      assert.equal(result.summary.toolsWithConfig, 3);
      assert.equal(result.summary.mcpServers, 1);
      assert.equal(result.summary.rules, 1);
      assert.equal(result.summary.contextFiles, 1);
      assert.equal(result.summary.claudeSkills, 1);
      assert.equal(result.summary.claudePlugins, 1);
      assert.equal(result.allItems.length, 5);
    } finally {
      cleanup();
    }
  });
  test("handles nonexistent paths gracefully", async () => {
    const result = await discoverAllConfigs("/nonexistent/path", "/nonexistent/home");
    assert.equal(result.summary.totalItems, 0);
    assert.ok(result.warnings.length >= 0);
  });
  test("groups items by tool", async () => {
    const { testRoot, testHome, cleanup } = makeTempDirs();
    try {
      writeJson(join(testRoot, ".cursor/mcp.json"), {
        mcpServers: { s1: { command: "a" }, s2: { command: "b" } }
      });
      const result = await discoverAllConfigs(testRoot, testHome);
      const cursorResult = result.tools.find((t) => t.tool.id === "cursor");
      assert.ok(cursorResult);
      assert.equal(cursorResult.items.length, 2);
    } finally {
      cleanup();
    }
  });
  test("summary counts are accurate", async () => {
    const { testRoot, testHome, cleanup } = makeTempDirs();
    try {
      writeJson(join(testRoot, ".cursor/mcp.json"), { mcpServers: { s1: { command: "a" } } });
      writeText(join(testRoot, ".cursorrules"), "Rule 1");
      writeText(join(testRoot, ".clinerules"), "Rule 2");
      writeText(join(testRoot, ".github/copilot-instructions.md"), "Instructions");
      writeJson(join(testRoot, ".vscode/settings.json"), { "editor.tabSize": 2 });
      const result = await discoverAllConfigs(testRoot, testHome);
      assert.equal(result.summary.mcpServers, 1);
      assert.equal(result.summary.rules, 2);
      assert.equal(result.summary.contextFiles, 1);
      assert.equal(result.summary.settings, 1);
      assert.equal(result.summary.claudeSkills, 0);
      assert.equal(result.summary.claudePlugins, 0);
      assert.equal(result.summary.totalItems, 5);
    } finally {
      cleanup();
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL3VuaXZlcnNhbC1jb25maWcvdGVzdHMvZGlzY292ZXJ5LnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogVGVzdHMgZm9yIHRoZSBkaXNjb3Zlcnkgb3JjaGVzdHJhdG9yLlxuICogUnVucyB3aXRoOiBub2RlIC0tZXhwZXJpbWVudGFsLXN0cmlwLXR5cGVzIC0tdGVzdFxuICovXG5cbmltcG9ydCB7IGRlc2NyaWJlLCB0ZXN0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IHsgc3RyaWN0IGFzIGFzc2VydCB9IGZyb20gXCJub2RlOmFzc2VydFwiO1xuaW1wb3J0IHsgbWtkaXJTeW5jLCB3cml0ZUZpbGVTeW5jLCBybVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBkaXNjb3ZlckFsbENvbmZpZ3MgfSBmcm9tIFwiLi4vZGlzY292ZXJ5LnRzXCI7XG5cbmZ1bmN0aW9uIG1rZGlycChwYXRoOiBzdHJpbmcpIHtcbiAgbWtkaXJTeW5jKHBhdGgsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xufVxuXG5mdW5jdGlvbiB3cml0ZUpzb24ocGF0aDogc3RyaW5nLCBkYXRhOiB1bmtub3duKSB7XG4gIG1rZGlycChqb2luKHBhdGgsIFwiLi5cIikpO1xuICB3cml0ZUZpbGVTeW5jKHBhdGgsIEpTT04uc3RyaW5naWZ5KGRhdGEsIG51bGwsIDIpLCBcInV0ZjhcIik7XG59XG5cbmZ1bmN0aW9uIHdyaXRlVGV4dChwYXRoOiBzdHJpbmcsIGNvbnRlbnQ6IHN0cmluZykge1xuICBta2RpcnAoam9pbihwYXRoLCBcIi4uXCIpKTtcbiAgd3JpdGVGaWxlU3luYyhwYXRoLCBjb250ZW50LCBcInV0ZjhcIik7XG59XG5cbmZ1bmN0aW9uIG1ha2VUZW1wRGlycygpIHtcbiAgY29uc3QgYmFzZSA9IGpvaW4odG1wZGlyKCksIGB1Y2QtZGlzYy0ke0RhdGUubm93KCl9LSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgOCl9YCk7XG4gIGNvbnN0IHRlc3RSb290ID0gam9pbihiYXNlLCBcInByb2plY3RcIik7XG4gIGNvbnN0IHRlc3RIb21lID0gam9pbihiYXNlLCBcImhvbWVcIik7XG4gIG1rZGlycCh0ZXN0Um9vdCk7XG4gIG1rZGlycCh0ZXN0SG9tZSk7XG4gIHJldHVybiB7IHRlc3RSb290LCB0ZXN0SG9tZSwgY2xlYW51cDogKCkgPT4gcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSB9O1xufVxuXG5kZXNjcmliZShcImRpc2NvdmVyQWxsQ29uZmlnc1wiLCAoKSA9PiB7XG4gIHRlc3QoXCJyZXR1cm5zIGVtcHR5IHJlc3VsdCBmb3IgY2xlYW4gZGlyZWN0b3JpZXNcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHsgdGVzdFJvb3QsIHRlc3RIb21lLCBjbGVhbnVwIH0gPSBtYWtlVGVtcERpcnMoKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZGlzY292ZXJBbGxDb25maWdzKHRlc3RSb290LCB0ZXN0SG9tZSk7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnN1bW1hcnkudG90YWxJdGVtcywgMCk7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnN1bW1hcnkudG9vbHNTY2FubmVkLCA4KTtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc3VtbWFyeS50b29sc1dpdGhDb25maWcsIDApO1xuICAgICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zdW1tYXJ5LmNsYXVkZVNraWxscywgMCk7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnN1bW1hcnkuY2xhdWRlUGx1Z2lucywgMCk7XG4gICAgICBhc3NlcnQub2socmVzdWx0LmR1cmF0aW9uTXMgPj0gMCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoKTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJkaXNjb3ZlcnMgY29uZmlnIGZyb20gbXVsdGlwbGUgdG9vbHNcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHsgdGVzdFJvb3QsIHRlc3RIb21lLCBjbGVhbnVwIH0gPSBtYWtlVGVtcERpcnMoKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVKc29uKGpvaW4odGVzdEhvbWUsIFwiLmNsYXVkZS5qc29uXCIpLCB7XG4gICAgICAgIG1jcFNlcnZlcnM6IHsgXCJjbGF1ZGUtbWNwXCI6IHsgY29tbWFuZDogXCJub2RlXCIsIGFyZ3M6IFtcInNlcnZlci5qc1wiXSB9IH0sXG4gICAgICB9KTtcbiAgICAgIHdyaXRlVGV4dChqb2luKHRlc3RIb21lLCBcIi5jbGF1ZGUvc2tpbGxzL3Rlc3Qtc2tpbGwvU0tJTEwubWRcIiksIFwiIyBUZXN0IHNraWxsXCIpO1xuICAgICAgd3JpdGVKc29uKGpvaW4odGVzdEhvbWUsIFwiLmNsYXVkZS9wbHVnaW5zL3Rlc3QtcGx1Z2luL3BhY2thZ2UuanNvblwiKSwgeyBuYW1lOiBcInRlc3QtcGx1Z2luXCIgfSk7XG4gICAgICB3cml0ZVRleHQoam9pbih0ZXN0Um9vdCwgXCIuY3Vyc29ycnVsZXNcIiksIFwiVXNlIHNlbWljb2xvbnMuXCIpO1xuICAgICAgd3JpdGVUZXh0KGpvaW4odGVzdFJvb3QsIFwiLmdpdGh1Yi9jb3BpbG90LWluc3RydWN0aW9ucy5tZFwiKSwgXCJCZSBoZWxwZnVsLlwiKTtcblxuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZGlzY292ZXJBbGxDb25maWdzKHRlc3RSb290LCB0ZXN0SG9tZSk7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnN1bW1hcnkudG9vbHNXaXRoQ29uZmlnLCAzKTtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc3VtbWFyeS5tY3BTZXJ2ZXJzLCAxKTtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc3VtbWFyeS5ydWxlcywgMSk7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnN1bW1hcnkuY29udGV4dEZpbGVzLCAxKTtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc3VtbWFyeS5jbGF1ZGVTa2lsbHMsIDEpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zdW1tYXJ5LmNsYXVkZVBsdWdpbnMsIDEpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5hbGxJdGVtcy5sZW5ndGgsIDUpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhbnVwKCk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwiaGFuZGxlcyBub25leGlzdGVudCBwYXRocyBncmFjZWZ1bGx5XCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBkaXNjb3ZlckFsbENvbmZpZ3MoXCIvbm9uZXhpc3RlbnQvcGF0aFwiLCBcIi9ub25leGlzdGVudC9ob21lXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc3VtbWFyeS50b3RhbEl0ZW1zLCAwKTtcbiAgICBhc3NlcnQub2socmVzdWx0Lndhcm5pbmdzLmxlbmd0aCA+PSAwKTtcbiAgfSk7XG5cbiAgdGVzdChcImdyb3VwcyBpdGVtcyBieSB0b29sXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB7IHRlc3RSb290LCB0ZXN0SG9tZSwgY2xlYW51cCB9ID0gbWFrZVRlbXBEaXJzKCk7XG4gICAgdHJ5IHtcbiAgICAgIHdyaXRlSnNvbihqb2luKHRlc3RSb290LCBcIi5jdXJzb3IvbWNwLmpzb25cIiksIHtcbiAgICAgICAgbWNwU2VydmVyczogeyBzMTogeyBjb21tYW5kOiBcImFcIiB9LCBzMjogeyBjb21tYW5kOiBcImJcIiB9IH0sXG4gICAgICB9KTtcblxuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZGlzY292ZXJBbGxDb25maWdzKHRlc3RSb290LCB0ZXN0SG9tZSk7XG4gICAgICBjb25zdCBjdXJzb3JSZXN1bHQgPSByZXN1bHQudG9vbHMuZmluZCgodCkgPT4gdC50b29sLmlkID09PSBcImN1cnNvclwiKTtcbiAgICAgIGFzc2VydC5vayhjdXJzb3JSZXN1bHQpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGN1cnNvclJlc3VsdCEuaXRlbXMubGVuZ3RoLCAyKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cCgpO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcInN1bW1hcnkgY291bnRzIGFyZSBhY2N1cmF0ZVwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyB0ZXN0Um9vdCwgdGVzdEhvbWUsIGNsZWFudXAgfSA9IG1ha2VUZW1wRGlycygpO1xuICAgIHRyeSB7XG4gICAgICB3cml0ZUpzb24oam9pbih0ZXN0Um9vdCwgXCIuY3Vyc29yL21jcC5qc29uXCIpLCB7IG1jcFNlcnZlcnM6IHsgczE6IHsgY29tbWFuZDogXCJhXCIgfSB9IH0pO1xuICAgICAgd3JpdGVUZXh0KGpvaW4odGVzdFJvb3QsIFwiLmN1cnNvcnJ1bGVzXCIpLCBcIlJ1bGUgMVwiKTtcbiAgICAgIHdyaXRlVGV4dChqb2luKHRlc3RSb290LCBcIi5jbGluZXJ1bGVzXCIpLCBcIlJ1bGUgMlwiKTtcbiAgICAgIHdyaXRlVGV4dChqb2luKHRlc3RSb290LCBcIi5naXRodWIvY29waWxvdC1pbnN0cnVjdGlvbnMubWRcIiksIFwiSW5zdHJ1Y3Rpb25zXCIpO1xuICAgICAgd3JpdGVKc29uKGpvaW4odGVzdFJvb3QsIFwiLnZzY29kZS9zZXR0aW5ncy5qc29uXCIpLCB7IFwiZWRpdG9yLnRhYlNpemVcIjogMiB9KTtcblxuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZGlzY292ZXJBbGxDb25maWdzKHRlc3RSb290LCB0ZXN0SG9tZSk7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnN1bW1hcnkubWNwU2VydmVycywgMSk7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnN1bW1hcnkucnVsZXMsIDIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zdW1tYXJ5LmNvbnRleHRGaWxlcywgMSk7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnN1bW1hcnkuc2V0dGluZ3MsIDEpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zdW1tYXJ5LmNsYXVkZVNraWxscywgMCk7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnN1bW1hcnkuY2xhdWRlUGx1Z2lucywgMCk7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnN1bW1hcnkudG90YWxJdGVtcywgNSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFudXAoKTtcbiAgICB9XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFLQSxTQUFTLFVBQVUsWUFBWTtBQUMvQixTQUFTLFVBQVUsY0FBYztBQUNqQyxTQUFTLFdBQVcsZUFBZSxjQUFjO0FBQ2pELFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFDdkIsU0FBUywwQkFBMEI7QUFFbkMsU0FBUyxPQUFPLE1BQWM7QUFDNUIsWUFBVSxNQUFNLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDckM7QUFFQSxTQUFTLFVBQVUsTUFBYyxNQUFlO0FBQzlDLFNBQU8sS0FBSyxNQUFNLElBQUksQ0FBQztBQUN2QixnQkFBYyxNQUFNLEtBQUssVUFBVSxNQUFNLE1BQU0sQ0FBQyxHQUFHLE1BQU07QUFDM0Q7QUFFQSxTQUFTLFVBQVUsTUFBYyxTQUFpQjtBQUNoRCxTQUFPLEtBQUssTUFBTSxJQUFJLENBQUM7QUFDdkIsZ0JBQWMsTUFBTSxTQUFTLE1BQU07QUFDckM7QUFFQSxTQUFTLGVBQWU7QUFDdEIsUUFBTSxPQUFPLEtBQUssT0FBTyxHQUFHLFlBQVksS0FBSyxJQUFJLENBQUMsSUFBSSxLQUFLLE9BQU8sRUFBRSxTQUFTLEVBQUUsRUFBRSxNQUFNLEdBQUcsQ0FBQyxDQUFDLEVBQUU7QUFDOUYsUUFBTSxXQUFXLEtBQUssTUFBTSxTQUFTO0FBQ3JDLFFBQU0sV0FBVyxL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
