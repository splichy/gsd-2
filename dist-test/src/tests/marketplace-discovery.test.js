import { describe, it } from "node:test";
import assert from "node:assert";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  parseMarketplaceJson,
  inspectPlugin,
  discoverMarketplace,
  resolvePluginRoot
} from "../resources/extensions/gsd/marketplace-discovery.js";
import { getMarketplaceFixtures } from "../resources/extensions/gsd/tests/marketplace-test-fixtures.js";
const fixtureSetup = getMarketplaceFixtures(import.meta.dirname);
const fixtures = fixtureSetup.fixtures;
const CLAUDE_SKILLS_PATH = fixtures?.claudeSkillsPath;
const CLAUDE_PLUGINS_OFFICIAL_PATH = fixtures?.claudePluginsOfficialPath;
const skipReason = !fixtureSetup.available ? fixtureSetup.skipReason ?? "Marketplace repos not found" : void 0;
describe("Marketplace Discovery Contract Tests", { skip: skipReason }, () => {
  describe("claude_skills marketplace (jamie-style)", () => {
    it("should discover at least 15 plugins", () => {
      const result = discoverMarketplace(CLAUDE_SKILLS_PATH);
      assert.strictEqual(result.status, "ok", `Expected ok status, got error: ${result.error}`);
      assert.ok(
        result.plugins.length >= 15,
        `Expected at least 15 plugins, found ${result.plugins.length}`
      );
    });
    it("should detect jamie-style format", () => {
      const result = discoverMarketplace(CLAUDE_SKILLS_PATH);
      assert.strictEqual(result.pluginFormat, "jamie-style");
    });
    it("should verify python3-development has skills and agents", () => {
      const result = discoverMarketplace(CLAUDE_SKILLS_PATH);
      const pythonPlugin = result.plugins.find((p) => p.name === "python3-development");
      assert.ok(pythonPlugin, "python3-development plugin should exist");
      assert.strictEqual(
        pythonPlugin.status,
        "ok",
        `Plugin should have ok status, got error: ${pythonPlugin.error}`
      );
      assert.ok(
        pythonPlugin.inventory.skills.length > 0,
        `python3-development should have skills, found: ${pythonPlugin.inventory.skills.length}`
      );
      assert.ok(
        pythonPlugin.inventory.skills.length >= 10,
        `python3-development should have at least 10 skills, found ${pythonPlugin.inventory.skills.length}`
      );
      assert.ok(
        pythonPlugin.inventory.agents.length > 0,
        `python3-development should have agents, found: ${pythonPlugin.inventory.agents.length}`
      );
      assert.ok(
        pythonPlugin.inventory.agents.length >= 5,
        `python3-development should have at least 5 agents, found ${pythonPlugin.inventory.agents.length}`
      );
    });
    it("should verify all resolved paths exist on disk", () => {
      const result = discoverMarketplace(CLAUDE_SKILLS_PATH);
      const localPlugins = result.plugins.filter((p) => p.resolvedPath !== null);
      assert.ok(localPlugins.length > 0, "Should have at least one local plugin");
      for (const plugin of localPlugins) {
        assert.ok(
          fs.existsSync(plugin.resolvedPath),
          `Plugin ${plugin.name} resolved path should exist: ${plugin.resolvedPath}`
        );
      }
    });
    it("should preserve canonical names for known plugins", () => {
      const result = discoverMarketplace(CLAUDE_SKILLS_PATH);
      const knownPluginNames = [
        "python3-development",
        "bash-development",
        "gitlab-skill",
        "commitlint",
        "conventional-commits",
        "fastmcp-creator"
      ];
      for (const expectedName of knownPluginNames) {
        const plugin = result.plugins.find((p) => p.name === expectedName);
        assert.ok(plugin, `Plugin ${expectedName} should exist`);
        assert.strictEqual(
          plugin.canonicalName,
          expectedName,
          `Canonical name should match for ${expectedName}`
        );
      }
    });
    it("should have consistent summary counts", () => {
      const result = discoverMarketplace(CLAUDE_SKILLS_PATH);
      assert.strictEqual(
        result.summary.total,
        result.plugins.length,
        "Total count should match plugins array length"
      );
      assert.strictEqual(
        result.summary.ok,
        result.plugins.filter((p) => p.status === "ok").length,
        "Ok count should match plugins with ok status"
      );
      assert.strictEqual(
        result.summary.error,
        result.plugins.filter((p) => p.status === "error").length,
        "Error count should match plugins with error status"
      );
    });
  });
  describe("claude-plugins-official marketplace (official-style)", () => {
    it("should discover at least 10 plugins", () => {
      const result = discoverMarketplace(CLAUDE_PLUGINS_OFFICIAL_PATH);
      assert.strictEqual(result.status, "ok", `Expected ok status, got error: ${result.error}`);
      assert.ok(
        result.plugins.length >= 10,
        `Expected at least 10 plugins, found ${result.plugins.length}`
      );
    });
    it("should detect official-style format", () => {
      const result = discoverMarketplace(CLAUDE_PLUGINS_OFFICIAL_PATH);
      assert.strictEqual(result.pluginFormat, "official-style");
    });
    it("should extract LSP servers from inline marketplace metadata", () => {
      const result = discoverMarketplace(CLAUDE_PLUGINS_OFFICIAL_PATH);
      const tsPlugin = result.plugins.find((p) => p.name === "typescript-lsp");
      assert.ok(tsPlugin, "typescript-lsp plugin should exist");
      assert.ok(
        Object.keys(tsPlugin.inventory.lspServers).length > 0,
        "typescript-lsp should have LSP servers from inline metadata"
      );
      assert.ok(
        "typescript" in tsPlugin.inventory.lspServers,
        "typescript-lsp should have typescript LSP server"
      );
      const tsLspConfig = tsPlugin.inventory.lspServers.typescript;
      assert.strictEqual(
        tsLspConfig.command,
        "typescript-language-server",
        "TypeScript LSP should use typescript-language-server command"
      );
    });
    it("should have description from inline metadata", () => {
      const result = discoverMarketplace(CLAUDE_PLUGINS_OFFICIAL_PATH);
      const tsPlugin = result.plugins.find((p) => p.name === "typescript-lsp");
      assert.ok(tsPlugin, "typescript-lsp plugin should exist");
      assert.ok(tsPlugin.description, "typescript-lsp should have description");
      assert.ok(
        tsPlugin.description.includes("TypeScript"),
        "Description should mention TypeScript"
      );
    });
    it("should handle external plugins (URL sources) correctly", () => {
      const result = discoverMarketplace(CLAUDE_PLUGINS_OFFICIAL_PATH);
      const externalPlugins = result.plugins.filter((p) => p.resolvedPath === null);
      assert.ok(
        externalPlugins.length > 0,
        "Should have at least one external plugin with null resolvedPath"
      );
      const atlassian = externalPlugins.find((p) => p.name === "atlassian");
      assert.ok(atlassian, "atlassian plugin should exist as external");
      assert.strictEqual(
        atlassian.status,
        "ok",
        "External plugins should have ok status"
      );
    });
    it("should preserve canonical names for known official plugins", () => {
      const result = discoverMarketplace(CLAUDE_PLUGINS_OFFICIAL_PATH);
      const knownPluginNames = [
        "typescript-lsp",
        "pyright-lsp",
        "gopls-lsp",
        "rust-analyzer-lsp",
        "feature-dev",
        "pr-review-toolkit"
      ];
      for (const expectedName of knownPluginNames) {
        const plugin = result.plugins.find((p) => p.name === expectedName);
        assert.ok(plugin, `Plugin ${expectedName} should exist in official marketplace`);
        assert.strictEqual(
          plugin.canonicalName,
          expectedName,
          `Canonical name should match for ${expectedName}`
        );
      }
    });
    it("should extract multiple LSP server types", () => {
      const result = discoverMarketplace(CLAUDE_PLUGINS_OFFICIAL_PATH);
      const lspPlugins = [
        { name: "pyright-lsp", server: "pyright" },
        { name: "gopls-lsp", server: "gopls" },
        { name: "rust-analyzer-lsp", server: "rust-analyzer" },
        { name: "clangd-lsp", server: "clangd" }
      ];
      for (const { name, server } of lspPlugins) {
        const plugin = result.plugins.find((p) => p.name === name);
        assert.ok(plugin, `${name} plugin should exist`);
        assert.ok(
          server in plugin.inventory.lspServers,
          `${name} should have ${server} LSP server`
        );
      }
    });
  });
  describe("resolvePluginRoot", () => {
    it("should resolve relative paths correctly", () => {
      const result = resolvePluginRoot(CLAUDE_SKILLS_PATH, "./plugins/python3-development");
      assert.strictEqual(result, path.join(CLAUDE_SKILLS_PATH, "plugins/python3-development"));
    });
    it("should handle paths without ./ prefix", () => {
      const result = resolvePluginRoot(CLAUDE_SKILLS_PATH, "plugins/python3-development");
      assert.strictEqual(result, path.join(CLAUDE_SKILLS_PATH, "plugins/python3-development"));
    });
    it("should return null for external sources", () => {
      const result = resolvePluginRoot(CLAUDE_SKILLS_PATH, "https://github.com/example/plugin");
      assert.strictEqual(result, null);
    });
    it("should return null for git sources", () => {
      const result = resolvePluginRoot(CLAUDE_SKILLS_PATH, { source: "github", repo: "example/plugin" });
      assert.strictEqual(result, null);
    });
  });
  describe("inspectPlugin", () => {
    it("should return error for non-existent plugin directory", () => {
      const result = inspectPlugin("/tmp/nonexistent-plugin");
      assert.strictEqual(result.status, "error");
      assert.ok(result.error !== void 0, "error should be defined");
      assert.ok(result.error.includes("not found"));
    });
  });
  describe("Error handling", () => {
    it("should return structured error for non-existent repo path", () => {
      const result = discoverMarketplace("/tmp/nonexistent-marketplace-" + Date.now());
      assert.strictEqual(result.status, "error");
      assert.ok(result.error, "Error message should be present");
      assert.ok(
        result.error.includes("not found"),
        `Error should mention 'not found', got: ${result.error}`
      );
      assert.deepStrictEqual(result.plugins, []);
      assert.strictEqual(result.summary.total, 0);
      assert.strictEqual(result.summary.ok, 0);
      assert.strictEqual(result.summary.error, 0);
    });
    it("should return error for directory without marketplace.json", (t) => {
      const tmpDir = "/tmp/test-no-marketplace-" + Date.now();
      fs.mkdirSync(tmpDir, { recursive: true });
      t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
      const result = discoverMarketplace(tmpDir);
      assert.strictEqual(result.status, "error");
      assert.ok(result.error, "Error message should be present");
      assert.ok(
        result.error.includes("not found"),
        `Error should mention 'not found', got: ${result.error}`
      );
    });
    it("should return error for malformed marketplace.json", (t) => {
      const tmpDir = "/tmp/test-malformed-marketplace-" + Date.now();
      fs.mkdirSync(tmpDir + "/.claude-plugin", { recursive: true });
      fs.writeFileSync(tmpDir + "/.claude-plugin/marketplace.json", "{ this is not valid json }");
      t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
      const result = discoverMarketplace(tmpDir);
      assert.strictEqual(result.status, "error");
      assert.ok(result.error, "Error message should be present");
      assert.ok(
        result.error.includes("Failed to parse"),
        `Error should mention 'Failed to parse', got: ${result.error}`
      );
    });
    it("should return error for marketplace.json missing required fields", (t) => {
      const tmpDir = "/tmp/test-invalid-marketplace-" + Date.now();
      fs.mkdirSync(tmpDir + "/.claude-plugin", { recursive: true });
      fs.writeFileSync(tmpDir + "/.claude-plugin/marketplace.json", JSON.stringify({ description: "test" }));
      t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
      const parseResult = parseMarketplaceJson(tmpDir);
      assert.strictEqual(parseResult.success, false);
      if (!parseResult.success) {
        assert.ok(
          parseResult.error.includes("missing"),
          `Error should mention missing field, got: ${parseResult.error}`
        );
      }
    });
    it("should handle missing plugin directory gracefully", (t) => {
      const tmpDir = "/tmp/test-missing-plugin-" + Date.now();
      fs.mkdirSync(tmpDir + "/.claude-plugin", { recursive: true });
      fs.writeFileSync(tmpDir + "/.claude-plugin/marketplace.json", JSON.stringify({
        name: "test-marketplace",
        plugins: [
          { name: "missing-plugin", source: "./plugins/nonexistent" }
        ]
      }));
      t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
      const result = discoverMarketplace(tmpDir);
      assert.strictEqual(result.status, "error");
      const missingPlugin = result.plugins.find((p) => p.name === "missing-plugin");
      assert.ok(missingPlugin, "Missing plugin should be in results");
      assert.strictEqual(missingPlugin.status, "error");
      assert.ok(missingPlugin.error, "Missing plugin should have error message");
      assert.ok(
        missingPlugin.error.includes("not found"),
        `Error should mention 'not found', got: ${missingPlugin.error}`
      );
    });
  });
  describe("Component inventory accuracy", () => {
    it("should accurately count skills in python3-development", () => {
      const result = discoverMarketplace(CLAUDE_SKILLS_PATH);
      const pythonPlugin = result.plugins.find((p) => p.name === "python3-development");
      assert.ok(pythonPlugin, "python3-development should exist");
      const skillsDir = path.join(pythonPlugin.resolvedPath, "skills");
      if (fs.existsSync(skillsDir)) {
        const actualSkills = fs.readdirSync(skillsDir).filter((item) => {
          const itemPath = path.join(skillsDir, item);
          return fs.statSync(itemPath).isDirectory() || item.endsWith(".md");
        });
        assert.ok(
          Math.abs(pythonPlugin.inventory.skills.length - actualSkills.length) <= 2,
          `Skills count should be close to actual: reported ${pythonPlugin.inventory.skills.length}, actual ${actualSkills.length}`
        );
      }
    });
    it("should discover MCP servers from plugin.json", () => {
      const result = discoverMarketplace(CLAUDE_SKILLS_PATH);
      const pythonPlugin = result.plugins.find((p) => p.name === "python3-development");
      assert.ok(pythonPlugin, "python3-development should exist");
      assert.ok(
        Object.keys(pythonPlugin.inventory.mcpServers).length > 0,
        "python3-development should have MCP servers from plugin.json"
      );
    });
    it("should include commands in inventory when present", () => {
      const result = discoverMarketplace(CLAUDE_SKILLS_PATH);
      const pythonPlugin = result.plugins.find((p) => p.name === "python3-development");
      assert.ok(pythonPlugin, "python3-development should exist");
      assert.ok(
        pythonPlugin.inventory.commands.length > 0,
        "python3-development should have commands"
      );
    });
    it("should detect hooks when present", () => {
      const result = discoverMarketplace(CLAUDE_SKILLS_PATH);
      const pluginWithHooks = result.plugins.find(
        (p) => p.inventory.hooks && p.inventory.hooks.length > 0
      );
      assert.ok(
        pluginWithHooks !== void 0,
        "At least one plugin should have hooks"
      );
    });
  });
  describe("Cross-marketplace consistency", () => {
    it("should return consistent type structure for both marketplaces", () => {
      const jamie = discoverMarketplace(CLAUDE_SKILLS_PATH);
      const official = discoverMarketplace(CLAUDE_PLUGINS_OFFICIAL_PATH);
      const requiredKeys = [
        "status",
        "marketplacePath",
        "marketplaceName",
        "pluginFormat",
        "plugins",
        "summary"
      ];
      for (const key of requiredKeys) {
        assert.ok(key in jamie, `jamie result should have ${key}`);
        assert.ok(key in official, `official result should have ${key}`);
      }
      const summaryKeys = ["total", "ok", "error"];
      for (const key of summaryKeys) {
        assert.ok(key in jamie.summary, `jamie summary should have ${key}`);
        assert.ok(key in official.summary, `official summary should have ${key}`);
      }
    });
    it("should return consistent plugin structure", () => {
      const jamie = discoverMarketplace(CLAUDE_SKILLS_PATH);
      const official = discoverMarketplace(CLAUDE_PLUGINS_OFFICIAL_PATH);
      const jamiePlugin = jamie.plugins[0];
      const officialPlugin = official.plugins[0];
      const requiredKeys = [
        "name",
        "canonicalName",
        "source",
        "resolvedPath",
        "status",
        "manifestSource",
        "inventory"
      ];
      for (const key of requiredKeys) {
        assert.ok(key in jamiePlugin, `jamie plugin should have ${key}`);
        assert.ok(key in officialPlugin, `official plugin should have ${key}`);
      }
      const inventoryKeys = ["skills", "agents", "commands", "mcpServers", "lspServers"];
      for (const key of inventoryKeys) {
        assert.ok(key in jamiePlugin.inventory, `jamie inventory should have ${key}`);
        assert.ok(key in officialPlugin.inventory, `official inventory should have ${key}`);
      }
    });
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3Rlc3RzL21hcmtldHBsYWNlLWRpc2NvdmVyeS50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIE1hcmtldHBsYWNlIERpc2NvdmVyeSBDb250cmFjdCBUZXN0c1xuICogXG4gKiBDb250cmFjdCB0ZXN0cyB0aGF0IGV4ZXJjaXNlIGRpc2NvdmVyTWFya2V0cGxhY2UgYWdhaW5zdCByZWFsIG1hcmtldHBsYWNlIHJlcG9zXG4gKiAoLi4vY2xhdWRlX3NraWxscyBhbmQgLi4vY2xhdWRlLXBsdWdpbnMtb2ZmaWNpYWwpLiBUaGVzZSB0ZXN0cyB2YWxpZGF0ZTpcbiAqIC0gUjAwMTogbWFya2V0cGxhY2UgcGFyc2luZ1xuICogLSBSMDAyOiBwYXRoIHJlc29sdXRpb24gIFxuICogLSBSMDAzOiBtYW5pZmVzdCBpbnNwZWN0aW9uXG4gKiBcbiAqIFRlc3RzIHJ1biBhZ2FpbnN0IHJlYWwgZGF0YSwgbm90IHN5bnRoZXRpYyBmaXh0dXJlcy5cbiAqL1xuXG5pbXBvcnQgeyBkZXNjcmliZSwgaXQgfSBmcm9tICdub2RlOnRlc3QnO1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydCc7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gJ25vZGU6cGF0aCc7XG5pbXBvcnQgKiBhcyBmcyBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7XG4gIHBhcnNlTWFya2V0cGxhY2VKc29uLFxuICBpbnNwZWN0UGx1Z2luLFxuICBkaXNjb3Zlck1hcmtldHBsYWNlLFxuICByZXNvbHZlUGx1Z2luUm9vdFxufSBmcm9tICcuLi9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvbWFya2V0cGxhY2UtZGlzY292ZXJ5LmpzJztcbmltcG9ydCB7IGdldE1hcmtldHBsYWNlRml4dHVyZXMgfSBmcm9tICcuLi9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvdGVzdHMvbWFya2V0cGxhY2UtdGVzdC1maXh0dXJlcy5qcyc7XG5cbmNvbnN0IGZpeHR1cmVTZXR1cCA9IGdldE1hcmtldHBsYWNlRml4dHVyZXMoaW1wb3J0Lm1ldGEuZGlybmFtZSk7XG5jb25zdCBmaXh0dXJlcyA9IGZpeHR1cmVTZXR1cC5maXh0dXJlcztcbmNvbnN0IENMQVVERV9TS0lMTFNfUEFUSCA9IGZpeHR1cmVzPy5jbGF1ZGVTa2lsbHNQYXRoO1xuY29uc3QgQ0xBVURFX1BMVUdJTlNfT0ZGSUNJQUxfUEFUSCA9IGZpeHR1cmVzPy5jbGF1ZGVQbHVnaW5zT2ZmaWNpYWxQYXRoO1xuXG5jb25zdCBza2lwUmVhc29uID0gIWZpeHR1cmVTZXR1cC5hdmFpbGFibGVcbiAgPyBmaXh0dXJlU2V0dXAuc2tpcFJlYXNvbiA/PyAnTWFya2V0cGxhY2UgcmVwb3Mgbm90IGZvdW5kJ1xuICA6IHVuZGVmaW5lZDtcblxuZGVzY3JpYmUoJ01hcmtldHBsYWNlIERpc2NvdmVyeSBDb250cmFjdCBUZXN0cycsIHsgc2tpcDogc2tpcFJlYXNvbiB9LCAoKSA9PiB7XG4gIGRlc2NyaWJlKCdjbGF1ZGVfc2tpbGxzIG1hcmtldHBsYWNlIChqYW1pZS1zdHlsZSknLCAoKSA9PiB7XG4gICAgaXQoJ3Nob3VsZCBkaXNjb3ZlciBhdCBsZWFzdCAxNSBwbHVnaW5zJywgKCkgPT4ge1xuICAgICAgY29uc3QgcmVzdWx0ID0gZGlzY292ZXJNYXJrZXRwbGFjZShDTEFVREVfU0tJTExTX1BBVEghKTtcbiAgICAgIFxuICAgICAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5zdGF0dXMsICdvaycsIGBFeHBlY3RlZCBvayBzdGF0dXMsIGdvdCBlcnJvcjogJHtyZXN1bHQuZXJyb3J9YCk7XG4gICAgICBhc3NlcnQub2socmVzdWx0LnBsdWdpbnMubGVuZ3RoID49IDE1LCBcbiAgICAgICAgYEV4cGVjdGVkIGF0IGxlYXN0IDE1IHBsdWdpbnMsIGZvdW5kICR7cmVzdWx0LnBsdWdpbnMubGVuZ3RofWApO1xuICAgIH0pO1xuXG4gICAgaXQoJ3Nob3VsZCBkZXRlY3QgamFtaWUtc3R5bGUgZm9ybWF0JywgKCkgPT4ge1xuICAgICAgY29uc3QgcmVzdWx0ID0gZGlzY292ZXJNYXJrZXRwbGFjZShDTEFVREVfU0tJTExTX1BBVEghKTtcbiAgICAgIFxuICAgICAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5wbHVnaW5Gb3JtYXQsICdqYW1pZS1zdHlsZScpO1xuICAgIH0pO1xuXG4gICAgaXQoJ3Nob3VsZCB2ZXJpZnkgcHl0aG9uMy1kZXZlbG9wbWVudCBoYXMgc2tpbGxzIGFuZCBhZ2VudHMnLCAoKSA9PiB7XG4gICAgICBjb25zdCByZXN1bHQgPSBkaXNjb3Zlck1hcmtldHBsYWNlKENMQVVERV9TS0lMTFNfUEFUSCEpO1xuICAgICAgY29uc3QgcHl0aG9uUGx1Z2luID0gcmVzdWx0LnBsdWdpbnMuZmluZChwID0+IHAubmFtZSA9PT0gJ3B5dGhvbjMtZGV2ZWxvcG1lbnQnKTtcbiAgICAgIFxuICAgICAgYXNzZXJ0Lm9rKHB5dGhvblBsdWdpbiwgJ3B5dGhvbjMtZGV2ZWxvcG1lbnQgcGx1Z2luIHNob3VsZCBleGlzdCcpO1xuICAgICAgYXNzZXJ0LnN0cmljdEVxdWFsKHB5dGhvblBsdWdpbi5zdGF0dXMsICdvaycsIFxuICAgICAgICBgUGx1Z2luIHNob3VsZCBoYXZlIG9rIHN0YXR1cywgZ290IGVycm9yOiAke3B5dGhvblBsdWdpbi5lcnJvcn1gKTtcbiAgICAgIFxuICAgICAgLy8gVmVyaWZ5IHNraWxscyBpbnZlbnRvcnlcbiAgICAgIGFzc2VydC5vayhweXRob25QbHVnaW4uaW52ZW50b3J5LnNraWxscy5sZW5ndGggPiAwLFxuICAgICAgICBgcHl0aG9uMy1kZXZlbG9wbWVudCBzaG91bGQgaGF2ZSBza2lsbHMsIGZvdW5kOiAke3B5dGhvblBsdWdpbi5pbnZlbnRvcnkuc2tpbGxzLmxlbmd0aH1gKTtcbiAgICAgIGFzc2VydC5vayhweXRob25QbHVnaW4uaW52ZW50b3J5LnNraWxscy5sZW5ndGggPj0gMTAsXG4gICAgICAgIGBweXRob24zLWRldmVsb3BtZW50IHNob3VsZCBoYXZlIGF0IGxlYXN0IDEwIHNraWxscywgZm91bmQgJHtweXRob25QbHVnaW4uaW52ZW50b3J5LnNraWxscy5sZW5ndGh9YCk7XG4gICAgICBcbiAgICAgIC8vIFZlcmlmeSBhZ2VudHMgaW52ZW50b3J5XG4gICAgICBhc3NlcnQub2socHl0aG9uUGx1Z2luLmludmVudG9yeS5hZ2VudHMubGVuZ3RoID4gMCxcbiAgICAgICAgYHB5dGhvbjMtZGV2ZWxvcG1lbnQgc2hvdWxkIGhhdmUgYWdlbnRzLCBmb3VuZDogJHtweXRob25QbHVnaW4uaW52ZW50b3J5LmFnZW50cy5sZW5ndGh9YCk7XG4gICAgICBhc3NlcnQub2socHl0aG9uUGx1Z2luLmludmVudG9yeS5hZ2VudHMubGVuZ3RoID49IDUsXG4gICAgICAgIGBweXRob24zLWRldmVsb3BtZW50IHNob3VsZCBoYXZlIGF0IGxlYXN0IDUgYWdlbnRzLCBmb3VuZCAke3B5dGhvblBsdWdpbi5pbnZlbnRvcnkuYWdlbnRzLmxlbmd0aH1gKTtcbiAgICB9KTtcblxuICAgIGl0KCdzaG91bGQgdmVyaWZ5IGFsbCByZXNvbHZlZCBwYXRocyBleGlzdCBvbiBkaXNrJywgKCkgPT4ge1xuICAgICAgY29uc3QgcmVzdWx0ID0gZGlzY292ZXJNYXJrZXRwbGFjZShDTEFVREVfU0tJTExTX1BBVEghKTtcbiAgICAgIFxuICAgICAgLy8gRmlsdGVyIHBsdWdpbnMgd2l0aCByZXNvbHZlZCBwYXRocyAobG9jYWwgcGx1Z2lucywgbm90IGV4dGVybmFsKVxuICAgICAgY29uc3QgbG9jYWxQbHVnaW5zID0gcmVzdWx0LnBsdWdpbnMuZmlsdGVyKHAgPT4gcC5yZXNvbHZlZFBhdGggIT09IG51bGwpO1xuICAgICAgXG4gICAgICBhc3NlcnQub2sobG9jYWxQbHVnaW5zLmxlbmd0aCA+IDAsICdTaG91bGQgaGF2ZSBhdCBsZWFzdCBvbmUgbG9jYWwgcGx1Z2luJyk7XG4gICAgICBcbiAgICAgIGZvciAoY29uc3QgcGx1Z2luIG9mIGxvY2FsUGx1Z2lucykge1xuICAgICAgICBhc3NlcnQub2soZnMuZXhpc3RzU3luYyhwbHVnaW4ucmVzb2x2ZWRQYXRoISksIFxuICAgICAgICAgIGBQbHVnaW4gJHtwbHVnaW4ubmFtZX0gcmVzb2x2ZWQgcGF0aCBzaG91bGQgZXhpc3Q6ICR7cGx1Z2luLnJlc29sdmVkUGF0aH1gKTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIGl0KCdzaG91bGQgcHJlc2VydmUgY2Fub25pY2FsIG5hbWVzIGZvciBrbm93biBwbHVnaW5zJywgKCkgPT4ge1xuICAgICAgY29uc3QgcmVzdWx0ID0gZGlzY292ZXJNYXJrZXRwbGFjZShDTEFVREVfU0tJTExTX1BBVEghKTtcbiAgICAgIGNvbnN0IGtub3duUGx1Z2luTmFtZXMgPSBbXG4gICAgICAgICdweXRob24zLWRldmVsb3BtZW50JyxcbiAgICAgICAgJ2Jhc2gtZGV2ZWxvcG1lbnQnLFxuICAgICAgICAnZ2l0bGFiLXNraWxsJyxcbiAgICAgICAgJ2NvbW1pdGxpbnQnLFxuICAgICAgICAnY29udmVudGlvbmFsLWNvbW1pdHMnLFxuICAgICAgICAnZmFzdG1jcC1jcmVhdG9yJ1xuICAgICAgXTtcbiAgICAgIFxuICAgICAgZm9yIChjb25zdCBleHBlY3RlZE5hbWUgb2Yga25vd25QbHVnaW5OYW1lcykge1xuICAgICAgICBjb25zdCBwbHVnaW4gPSByZXN1bHQucGx1Z2lucy5maW5kKHAgPT4gcC5uYW1lID09PSBleHBlY3RlZE5hbWUpO1xuICAgICAgICBhc3NlcnQub2socGx1Z2luLCBgUGx1Z2luICR7ZXhwZWN0ZWROYW1lfSBzaG91bGQgZXhpc3RgKTtcbiAgICAgICAgYXNzZXJ0LnN0cmljdEVxdWFsKHBsdWdpbi5jYW5vbmljYWxOYW1lLCBleHBlY3RlZE5hbWUsXG4gICAgICAgICAgYENhbm9uaWNhbCBuYW1lIHNob3VsZCBtYXRjaCBmb3IgJHtleHBlY3RlZE5hbWV9YCk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBpdCgnc2hvdWxkIGhhdmUgY29uc2lzdGVudCBzdW1tYXJ5IGNvdW50cycsICgpID0+IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGRpc2NvdmVyTWFya2V0cGxhY2UoQ0xBVURFX1NLSUxMU19QQVRIISk7XG4gICAgICBcbiAgICAgIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuc3VtbWFyeS50b3RhbCwgcmVzdWx0LnBsdWdpbnMubGVuZ3RoLFxuICAgICAgICAnVG90YWwgY291bnQgc2hvdWxkIG1hdGNoIHBsdWdpbnMgYXJyYXkgbGVuZ3RoJyk7XG4gICAgICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LnN1bW1hcnkub2ssIFxuICAgICAgICByZXN1bHQucGx1Z2lucy5maWx0ZXIocCA9PiBwLnN0YXR1cyA9PT0gJ29rJykubGVuZ3RoLFxuICAgICAgICAnT2sgY291bnQgc2hvdWxkIG1hdGNoIHBsdWdpbnMgd2l0aCBvayBzdGF0dXMnKTtcbiAgICAgIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuc3VtbWFyeS5lcnJvcixcbiAgICAgICAgcmVzdWx0LnBsdWdpbnMuZmlsdGVyKHAgPT4gcC5zdGF0dXMgPT09ICdlcnJvcicpLmxlbmd0aCxcbiAgICAgICAgJ0Vycm9yIGNvdW50IHNob3VsZCBtYXRjaCBwbHVnaW5zIHdpdGggZXJyb3Igc3RhdHVzJyk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKCdjbGF1ZGUtcGx1Z2lucy1vZmZpY2lhbCBtYXJrZXRwbGFjZSAob2ZmaWNpYWwtc3R5bGUpJywgKCkgPT4ge1xuICAgIGl0KCdzaG91bGQgZGlzY292ZXIgYXQgbGVhc3QgMTAgcGx1Z2lucycsICgpID0+IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGRpc2NvdmVyTWFya2V0cGxhY2UoQ0xBVURFX1BMVUdJTlNfT0ZGSUNJQUxfUEFUSCEpO1xuICAgICAgXG4gICAgICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LnN0YXR1cywgJ29rJywgYEV4cGVjdGVkIG9rIHN0YXR1cywgZ290IGVycm9yOiAke3Jlc3VsdC5lcnJvcn1gKTtcbiAgICAgIGFzc2VydC5vayhyZXN1bHQucGx1Z2lucy5sZW5ndGggPj0gMTAsXG4gICAgICAgIGBFeHBlY3RlZCBhdCBsZWFzdCAxMCBwbHVnaW5zLCBmb3VuZCAke3Jlc3VsdC5wbHVnaW5zLmxlbmd0aH1gKTtcbiAgICB9KTtcblxuICAgIGl0KCdzaG91bGQgZGV0ZWN0IG9mZmljaWFsLXN0eWxlIGZvcm1hdCcsICgpID0+IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGRpc2NvdmVyTWFya2V0cGxhY2UoQ0xBVURFX1BMVUdJTlNfT0ZGSUNJQUxfUEFUSCEpO1xuICAgICAgXG4gICAgICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LnBsdWdpbkZvcm1hdCwgJ29mZmljaWFsLXN0eWxlJyk7XG4gICAgfSk7XG5cbiAgICBpdCgnc2hvdWxkIGV4dHJhY3QgTFNQIHNlcnZlcnMgZnJvbSBpbmxpbmUgbWFya2V0cGxhY2UgbWV0YWRhdGEnLCAoKSA9PiB7XG4gICAgICBjb25zdCByZXN1bHQgPSBkaXNjb3Zlck1hcmtldHBsYWNlKENMQVVERV9QTFVHSU5TX09GRklDSUFMX1BBVEghKTtcbiAgICAgIFxuICAgICAgLy8gVHlwZVNjcmlwdCBMU1AgcGx1Z2luIHNob3VsZCBoYXZlIGxzcFNlcnZlcnMgZnJvbSBtYXJrZXRwbGFjZS5qc29uXG4gICAgICBjb25zdCB0c1BsdWdpbiA9IHJlc3VsdC5wbHVnaW5zLmZpbmQocCA9PiBwLm5hbWUgPT09ICd0eXBlc2NyaXB0LWxzcCcpO1xuICAgICAgYXNzZXJ0Lm9rKHRzUGx1Z2luLCAndHlwZXNjcmlwdC1sc3AgcGx1Z2luIHNob3VsZCBleGlzdCcpO1xuICAgICAgYXNzZXJ0Lm9rKE9iamVjdC5rZXlzKHRzUGx1Z2luLmludmVudG9yeS5sc3BTZXJ2ZXJzKS5sZW5ndGggPiAwLFxuICAgICAgICAndHlwZXNjcmlwdC1sc3Agc2hvdWxkIGhhdmUgTFNQIHNlcnZlcnMgZnJvbSBpbmxpbmUgbWV0YWRhdGEnKTtcbiAgICAgIGFzc2VydC5vaygndHlwZXNjcmlwdCcgaW4gdHNQbHVnaW4uaW52ZW50b3J5LmxzcFNlcnZlcnMsXG4gICAgICAgICd0eXBlc2NyaXB0LWxzcCBzaG91bGQgaGF2ZSB0eXBlc2NyaXB0IExTUCBzZXJ2ZXInKTtcbiAgICAgIFxuICAgICAgLy8gVmVyaWZ5IExTUCBzZXJ2ZXIgY29uZmlnIHN0cnVjdHVyZVxuICAgICAgY29uc3QgdHNMc3BDb25maWcgPSB0c1BsdWdpbi5pbnZlbnRvcnkubHNwU2VydmVycy50eXBlc2NyaXB0IGFzIHsgY29tbWFuZD86IHN0cmluZyB9O1xuICAgICAgYXNzZXJ0LnN0cmljdEVxdWFsKHRzTHNwQ29uZmlnLmNvbW1hbmQsICd0eXBlc2NyaXB0LWxhbmd1YWdlLXNlcnZlcicsXG4gICAgICAgICdUeXBlU2NyaXB0IExTUCBzaG91bGQgdXNlIHR5cGVzY3JpcHQtbGFuZ3VhZ2Utc2VydmVyIGNvbW1hbmQnKTtcbiAgICB9KTtcblxuICAgIGl0KCdzaG91bGQgaGF2ZSBkZXNjcmlwdGlvbiBmcm9tIGlubGluZSBtZXRhZGF0YScsICgpID0+IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGRpc2NvdmVyTWFya2V0cGxhY2UoQ0xBVURFX1BMVUdJTlNfT0ZGSUNJQUxfUEFUSCEpO1xuICAgICAgXG4gICAgICBjb25zdCB0c1BsdWdpbiA9IHJlc3VsdC5wbHVnaW5zLmZpbmQocCA9PiBwLm5hbWUgPT09ICd0eXBlc2NyaXB0LWxzcCcpO1xuICAgICAgYXNzZXJ0Lm9rKHRzUGx1Z2luLCAndHlwZXNjcmlwdC1sc3AgcGx1Z2luIHNob3VsZCBleGlzdCcpO1xuICAgICAgYXNzZXJ0Lm9rKHRzUGx1Z2luLmRlc2NyaXB0aW9uLCAndHlwZXNjcmlwdC1sc3Agc2hvdWxkIGhhdmUgZGVzY3JpcHRpb24nKTtcbiAgICAgIGFzc2VydC5vayh0c1BsdWdpbi5kZXNjcmlwdGlvbi5pbmNsdWRlcygnVHlwZVNjcmlwdCcpLFxuICAgICAgICAnRGVzY3JpcHRpb24gc2hvdWxkIG1lbnRpb24gVHlwZVNjcmlwdCcpO1xuICAgIH0pO1xuXG4gICAgaXQoJ3Nob3VsZCBoYW5kbGUgZXh0ZXJuYWwgcGx1Z2lucyAoVVJMIHNvdXJjZXMpIGNvcnJlY3RseScsICgpID0+IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGRpc2NvdmVyTWFya2V0cGxhY2UoQ0xBVURFX1BMVUdJTlNfT0ZGSUNJQUxfUEFUSCEpO1xuICAgICAgXG4gICAgICAvLyBGaW5kIHBsdWdpbnMgd2l0aCBVUkwgc291cmNlcyAoZXh0ZXJuYWwpXG4gICAgICBjb25zdCBleHRlcm5hbFBsdWdpbnMgPSByZXN1bHQucGx1Z2lucy5maWx0ZXIocCA9PiBwLnJlc29sdmVkUGF0aCA9PT0gbnVsbCk7XG4gICAgICBcbiAgICAgIGFzc2VydC5vayhleHRlcm5hbFBsdWdpbnMubGVuZ3RoID4gMCwgXG4gICAgICAgICdTaG91bGQgaGF2ZSBhdCBsZWFzdCBvbmUgZXh0ZXJuYWwgcGx1Z2luIHdpdGggbnVsbCByZXNvbHZlZFBhdGgnKTtcbiAgICAgIFxuICAgICAgLy8gRXh0ZXJuYWwgcGx1Z2lucyBzaG91bGQgc3RpbGwgaGF2ZSBvayBzdGF0dXMgKHRoZXkncmUgdmFsaWQsIGp1c3Qgbm90IGxvY2FsKVxuICAgICAgY29uc3QgYXRsYXNzaWFuID0gZXh0ZXJuYWxQbHVnaW5zLmZpbmQocCA9PiBwLm5hbWUgPT09ICdhdGxhc3NpYW4nKTtcbiAgICAgIGFzc2VydC5vayhhdGxhc3NpYW4sICdhdGxhc3NpYW4gcGx1Z2luIHNob3VsZCBleGlzdCBhcyBleHRlcm5hbCcpO1xuICAgICAgYXNzZXJ0LnN0cmljdEVxdWFsKGF0bGFzc2lhbi5zdGF0dXMsICdvaycsXG4gICAgICAgICdFeHRlcm5hbCBwbHVnaW5zIHNob3VsZCBoYXZlIG9rIHN0YXR1cycpO1xuICAgIH0pO1xuXG4gICAgaXQoJ3Nob3VsZCBwcmVzZXJ2ZSBjYW5vbmljYWwgbmFtZXMgZm9yIGtub3duIG9mZmljaWFsIHBsdWdpbnMnLCAoKSA9PiB7XG4gICAgICBjb25zdCByZXN1bHQgPSBkaXNjb3Zlck1hcmtldHBsYWNlKENMQVVERV9QTFVHSU5TX09GRklDSUFMX1BBVEghKTtcbiAgICAgIGNvbnN0IGtub3duUGx1Z2luTmFtZXMgPSBbXG4gICAgICAgICd0eXBlc2NyaXB0LWxzcCcsXG4gICAgICAgICdweXJpZ2h0LWxzcCcsXG4gICAgICAgICdnb3Bscy1sc3AnLFxuICAgICAgICAncnVzdC1hbmFseXplci1sc3AnLFxuICAgICAgICAnZmVhdHVyZS1kZXYnLFxuICAgICAgICAncHItcmV2aWV3LXRvb2xraXQnXG4gICAgICBdO1xuICAgICAgXG4gICAgICBmb3IgKGNvbnN0IGV4cGVjdGVkTmFtZSBvZiBrbm93blBsdWdpbk5hbWVzKSB7XG4gICAgICAgIGNvbnN0IHBsdWdpbiA9IHJlc3VsdC5wbHVnaW5zLmZpbmQocCA9PiBwLm5hbWUgPT09IGV4cGVjdGVkTmFtZSk7XG4gICAgICAgIGFzc2VydC5vayhwbHVnaW4sIGBQbHVnaW4gJHtleHBlY3RlZE5hbWV9IHNob3VsZCBleGlzdCBpbiBvZmZpY2lhbCBtYXJrZXRwbGFjZWApO1xuICAgICAgICBhc3NlcnQuc3RyaWN0RXF1YWwocGx1Z2luLmNhbm9uaWNhbE5hbWUsIGV4cGVjdGVkTmFtZSxcbiAgICAgICAgICBgQ2Fub25pY2FsIG5hbWUgc2hvdWxkIG1hdGNoIGZvciAke2V4cGVjdGVkTmFtZX1gKTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIGl0KCdzaG91bGQgZXh0cmFjdCBtdWx0aXBsZSBMU1Agc2VydmVyIHR5cGVzJywgKCkgPT4ge1xuICAgICAgY29uc3QgcmVzdWx0ID0gZGlzY292ZXJNYXJrZXRwbGFjZShDTEFVREVfUExVR0lOU19PRkZJQ0lBTF9QQVRIISk7XG4gICAgICBcbiAgICAgIC8vIENoZWNrIHRoYXQgbXVsdGlwbGUgTFNQIHBsdWdpbnMgaGF2ZSB0aGVpciBzZXJ2ZXJzIGV4dHJhY3RlZFxuICAgICAgY29uc3QgbHNwUGx1Z2lucyA9IFtcbiAgICAgICAgeyBuYW1lOiAncHlyaWdodC1sc3AnLCBzZXJ2ZXI6ICdweXJpZ2h0JyB9LFxuICAgICAgICB7IG5hbWU6ICdnb3Bscy1sc3AnLCBzZXJ2ZXI6ICdnb3BscycgfSxcbiAgICAgICAgeyBuYW1lOiAncnVzdC1hbmFseXplci1sc3AnLCBzZXJ2ZXI6ICdydXN0LWFuYWx5emVyJyB9LFxuICAgICAgICB7IG5hbWU6ICdjbGFuZ2QtbHNwJywgc2VydmVyOiAnY2xhbmdkJyB9XG4gICAgICBdO1xuICAgICAgXG4gICAgICBmb3IgKGNvbnN0IHsgbmFtZSwgc2VydmVyIH0gb2YgbHNwUGx1Z2lucykge1xuICAgICAgICBjb25zdCBwbHVnaW4gPSByZXN1bHQucGx1Z2lucy5maW5kKHAgPT4gcC5uYW1lID09PSBuYW1lKTtcbiAgICAgICAgYXNzZXJ0Lm9rKHBsdWdpbiwgYCR7bmFtZX0gcGx1Z2luIHNob3VsZCBleGlzdGApO1xuICAgICAgICBhc3NlcnQub2soc2VydmVyIGluIHBsdWdpbi5pbnZlbnRvcnkubHNwU2VydmVycyxcbiAgICAgICAgICBgJHtuYW1lfSBzaG91bGQgaGF2ZSAke3NlcnZlcn0gTFNQIHNlcnZlcmApO1xuICAgICAgfVxuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgncmVzb2x2ZVBsdWdpblJvb3QnLCAoKSA9PiB7XG4gICAgaXQoJ3Nob3VsZCByZXNvbHZlIHJlbGF0aXZlIHBhdGhzIGNvcnJlY3RseScsICgpID0+IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVQbHVnaW5Sb290KENMQVVERV9TS0lMTFNfUEFUSCEsICcuL3BsdWdpbnMvcHl0aG9uMy1kZXZlbG9wbWVudCcpO1xuICAgICAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdCwgcGF0aC5qb2luKENMQVVERV9TS0lMTFNfUEFUSCEsICdwbHVnaW5zL3B5dGhvbjMtZGV2ZWxvcG1lbnQnKSk7XG4gICAgfSk7XG5cbiAgICBpdCgnc2hvdWxkIGhhbmRsZSBwYXRocyB3aXRob3V0IC4vIHByZWZpeCcsICgpID0+IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVQbHVnaW5Sb290KENMQVVERV9TS0lMTFNfUEFUSCEsICdwbHVnaW5zL3B5dGhvbjMtZGV2ZWxvcG1lbnQnKTtcbiAgICAgIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQsIHBhdGguam9pbihDTEFVREVfU0tJTExTX1BBVEghLCAncGx1Z2lucy9weXRob24zLWRldmVsb3BtZW50JykpO1xuICAgIH0pO1xuXG4gICAgaXQoJ3Nob3VsZCByZXR1cm4gbnVsbCBmb3IgZXh0ZXJuYWwgc291cmNlcycsICgpID0+IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVQbHVnaW5Sb290KENMQVVERV9TS0lMTFNfUEFUSCEsICdodHRwczovL2dpdGh1Yi5jb20vZXhhbXBsZS9wbHVnaW4nKTtcbiAgICAgIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQsIG51bGwpO1xuICAgIH0pO1xuXG4gICAgaXQoJ3Nob3VsZCByZXR1cm4gbnVsbCBmb3IgZ2l0IHNvdXJjZXMnLCAoKSA9PiB7XG4gICAgICBjb25zdCByZXN1bHQgPSByZXNvbHZlUGx1Z2luUm9vdChDTEFVREVfU0tJTExTX1BBVEghLCB7IHNvdXJjZTogJ2dpdGh1YicsIHJlcG86ICdleGFtcGxlL3BsdWdpbicgfSk7XG4gICAgICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LCBudWxsKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ2luc3BlY3RQbHVnaW4nLCAoKSA9PiB7XG4gICAgaXQoJ3Nob3VsZCByZXR1cm4gZXJyb3IgZm9yIG5vbi1leGlzdGVudCBwbHVnaW4gZGlyZWN0b3J5JywgKCkgPT4ge1xuICAgICAgY29uc3QgcmVzdWx0ID0gaW5zcGVjdFBsdWdpbignL3RtcC9ub25leGlzdGVudC1wbHVnaW4nKTtcbiAgICAgIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuc3RhdHVzLCAnZXJyb3InKTtcbiAgICAgIGFzc2VydC5vayhyZXN1bHQuZXJyb3IgIT09IHVuZGVmaW5lZCwgJ2Vycm9yIHNob3VsZCBiZSBkZWZpbmVkJyk7XG4gICAgICBhc3NlcnQub2socmVzdWx0LmVycm9yLmluY2x1ZGVzKCdub3QgZm91bmQnKSk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKCdFcnJvciBoYW5kbGluZycsICgpID0+IHtcbiAgICBpdCgnc2hvdWxkIHJldHVybiBzdHJ1Y3R1cmVkIGVycm9yIGZvciBub24tZXhpc3RlbnQgcmVwbyBwYXRoJywgKCkgPT4ge1xuICAgICAgY29uc3QgcmVzdWx0ID0gZGlzY292ZXJNYXJrZXRwbGFjZSgnL3RtcC9ub25leGlzdGVudC1tYXJrZXRwbGFjZS0nICsgRGF0ZS5ub3coKSk7XG4gICAgICBcbiAgICAgIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuc3RhdHVzLCAnZXJyb3InKTtcbiAgICAgIGFzc2VydC5vayhyZXN1bHQuZXJyb3IsICdFcnJvciBtZXNzYWdlIHNob3VsZCBiZSBwcmVzZW50Jyk7XG4gICAgICBhc3NlcnQub2socmVzdWx0LmVycm9yLmluY2x1ZGVzKCdub3QgZm91bmQnKSxcbiAgICAgICAgYEVycm9yIHNob3VsZCBtZW50aW9uICdub3QgZm91bmQnLCBnb3Q6ICR7cmVzdWx0LmVycm9yfWApO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQucGx1Z2lucywgW10pO1xuICAgICAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5zdW1tYXJ5LnRvdGFsLCAwKTtcbiAgICAgIGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuc3VtbWFyeS5vaywgMCk7XG4gICAgICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LnN1bW1hcnkuZXJyb3IsIDApO1xuICAgIH0pO1xuXG4gICAgaXQoJ3Nob3VsZCByZXR1cm4gZXJyb3IgZm9yIGRpcmVjdG9yeSB3aXRob3V0IG1hcmtldHBsYWNlLmpzb24nLCAodCkgPT4ge1xuICAgICAgLy8gQ3JlYXRlIGEgdGVtcCBkaXJlY3Rvcnkgd2l0aG91dCBtYXJrZXRwbGFjZS5qc29uXG4gICAgICBjb25zdCB0bXBEaXIgPSAnL3RtcC90ZXN0LW5vLW1hcmtldHBsYWNlLScgKyBEYXRlLm5vdygpO1xuICAgICAgZnMubWtkaXJTeW5jKHRtcERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICBcbiAgICAgIHQuYWZ0ZXIoKCkgPT4gZnMucm1TeW5jKHRtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGRpc2NvdmVyTWFya2V0cGxhY2UodG1wRGlyKTtcbiAgICAgIFxuICAgICAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5zdGF0dXMsICdlcnJvcicpO1xuICAgICAgYXNzZXJ0Lm9rKHJlc3VsdC5lcnJvciwgJ0Vycm9yIG1lc3NhZ2Ugc2hvdWxkIGJlIHByZXNlbnQnKTtcbiAgICAgIGFzc2VydC5vayhyZXN1bHQuZXJyb3IuaW5jbHVkZXMoJ25vdCBmb3VuZCcpLFxuICAgICAgICBgRXJyb3Igc2hvdWxkIG1lbnRpb24gJ25vdCBmb3VuZCcsIGdvdDogJHtyZXN1bHQuZXJyb3J9YCk7XG4gICAgfSk7XG5cbiAgICBpdCgnc2hvdWxkIHJldHVybiBlcnJvciBmb3IgbWFsZm9ybWVkIG1hcmtldHBsYWNlLmpzb24nLCAodCkgPT4ge1xuICAgICAgY29uc3QgdG1wRGlyID0gJy90bXAvdGVzdC1tYWxmb3JtZWQtbWFya2V0cGxhY2UtJyArIERhdGUubm93KCk7XG4gICAgICBmcy5ta2RpclN5bmModG1wRGlyICsgJy8uY2xhdWRlLXBsdWdpbicsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgZnMud3JpdGVGaWxlU3luYyh0bXBEaXIgKyAnLy5jbGF1ZGUtcGx1Z2luL21hcmtldHBsYWNlLmpzb24nLCAneyB0aGlzIGlzIG5vdCB2YWxpZCBqc29uIH0nKTtcbiAgICAgIFxuICAgICAgdC5hZnRlcigoKSA9PiBmcy5ybVN5bmModG1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuICAgICAgY29uc3QgcmVzdWx0ID0gZGlzY292ZXJNYXJrZXRwbGFjZSh0bXBEaXIpO1xuICAgICAgXG4gICAgICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LnN0YXR1cywgJ2Vycm9yJyk7XG4gICAgICBhc3NlcnQub2socmVzdWx0LmVycm9yLCAnRXJyb3IgbWVzc2FnZSBzaG91bGQgYmUgcHJlc2VudCcpO1xuICAgICAgYXNzZXJ0Lm9rKHJlc3VsdC5lcnJvci5pbmNsdWRlcygnRmFpbGVkIHRvIHBhcnNlJyksXG4gICAgICAgIGBFcnJvciBzaG91bGQgbWVudGlvbiAnRmFpbGVkIHRvIHBhcnNlJywgZ290OiAke3Jlc3VsdC5lcnJvcn1gKTtcbiAgICB9KTtcblxuICAgIGl0KCdzaG91bGQgcmV0dXJuIGVycm9yIGZvciBtYXJrZXRwbGFjZS5qc29uIG1pc3NpbmcgcmVxdWlyZWQgZmllbGRzJywgKHQpID0+IHtcbiAgICAgIGNvbnN0IHRtcERpciA9ICcvdG1wL3Rlc3QtaW52YWxpZC1tYXJrZXRwbGFjZS0nICsgRGF0ZS5ub3coKTtcbiAgICAgIGZzLm1rZGlyU3luYyh0bXBEaXIgKyAnLy5jbGF1ZGUtcGx1Z2luJywgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICAvLyBWYWxpZCBKU09OIGJ1dCBtaXNzaW5nIHJlcXVpcmVkICduYW1lJyBhbmQgJ3BsdWdpbnMnIGZpZWxkc1xuICAgICAgZnMud3JpdGVGaWxlU3luYyh0bXBEaXIgKyAnLy5jbGF1ZGUtcGx1Z2luL21hcmtldHBsYWNlLmpzb24nLCBKU09OLnN0cmluZ2lmeSh7IGRlc2NyaXB0aW9uOiAndGVzdCcgfSkpO1xuICAgICAgXG4gICAgICB0LmFmdGVyKCgpID0+IGZzLnJtU3luYyh0bXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG4gICAgICBjb25zdCBwYXJzZVJlc3VsdCA9IHBhcnNlTWFya2V0cGxhY2VKc29uKHRtcERpcik7XG4gICAgICBcbiAgICAgIGFzc2VydC5zdHJpY3RFcXVhbChwYXJzZVJlc3VsdC5zdWNjZXNzLCBmYWxzZSk7XG4gICAgICBpZiAoIXBhcnNlUmVzdWx0LnN1Y2Nlc3MpIHtcbiAgICAgICAgYXNzZXJ0Lm9rKHBhcnNlUmVzdWx0LmVycm9yLmluY2x1ZGVzKCdtaXNzaW5nJyksXG4gICAgICAgICAgYEVycm9yIHNob3VsZCBtZW50aW9uIG1pc3NpbmcgZmllbGQsIGdvdDogJHtwYXJzZVJlc3VsdC5lcnJvcn1gKTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIGl0KCdzaG91bGQgaGFuZGxlIG1pc3NpbmcgcGx1Z2luIGRpcmVjdG9yeSBncmFjZWZ1bGx5JywgKHQpID0+IHtcbiAgICAgIGNvbnN0IHRtcERpciA9ICcvdG1wL3Rlc3QtbWlzc2luZy1wbHVnaW4tJyArIERhdGUubm93KCk7XG4gICAgICBmcy5ta2RpclN5bmModG1wRGlyICsgJy8uY2xhdWRlLXBsdWdpbicsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgZnMud3JpdGVGaWxlU3luYyh0bXBEaXIgKyAnLy5jbGF1ZGUtcGx1Z2luL21hcmtldHBsYWNlLmpzb24nLCBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIG5hbWU6ICd0ZXN0LW1hcmtldHBsYWNlJyxcbiAgICAgICAgcGx1Z2luczogW1xuICAgICAgICAgIHsgbmFtZTogJ21pc3NpbmctcGx1Z2luJywgc291cmNlOiAnLi9wbHVnaW5zL25vbmV4aXN0ZW50JyB9XG4gICAgICAgIF1cbiAgICAgIH0pKTtcbiAgICAgIFxuICAgICAgdC5hZnRlcigoKSA9PiBmcy5ybVN5bmModG1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuICAgICAgY29uc3QgcmVzdWx0ID0gZGlzY292ZXJNYXJrZXRwbGFjZSh0bXBEaXIpO1xuICAgICAgXG4gICAgICAvLyBNYXJrZXRwbGFjZSBzaG91bGQgcGFyc2Ugb2ssIGJ1dCB0aGUgbWlzc2luZyBwbHVnaW4gc2hvdWxkIGhhdmUgZXJyb3Igc3RhdHVzXG4gICAgICBhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LnN0YXR1cywgJ2Vycm9yJyk7IC8vIEJlY2F1c2Ugb25lIHBsdWdpbiBoYXMgZXJyb3JcbiAgICAgIFxuICAgICAgY29uc3QgbWlzc2luZ1BsdWdpbiA9IHJlc3VsdC5wbHVnaW5zLmZpbmQocCA9PiBwLm5hbWUgPT09ICdtaXNzaW5nLXBsdWdpbicpO1xuICAgICAgYXNzZXJ0Lm9rKG1pc3NpbmdQbHVnaW4sICdNaXNzaW5nIHBsdWdpbiBzaG91bGQgYmUgaW4gcmVzdWx0cycpO1xuICAgICAgYXNzZXJ0LnN0cmljdEVxdWFsKG1pc3NpbmdQbHVnaW4uc3RhdHVzLCAnZXJyb3InKTtcbiAgICAgIGFzc2VydC5vayhtaXNzaW5nUGx1Z2luLmVycm9yLCAnTWlzc2luZyBwbHVnaW4gc2hvdWxkIGhhdmUgZXJyb3IgbWVzc2FnZScpO1xuICAgICAgYXNzZXJ0Lm9rKG1pc3NpbmdQbHVnaW4uZXJyb3IuaW5jbHVkZXMoJ25vdCBmb3VuZCcpLFxuICAgICAgICBgRXJyb3Igc2hvdWxkIG1lbnRpb24gJ25vdCBmb3VuZCcsIGdvdDogJHttaXNzaW5nUGx1Z2luLmVycm9yfWApO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnQ29tcG9uZW50IGludmVudG9yeSBhY2N1cmFjeScsICgpID0+IHtcbiAgICBpdCgnc2hvdWxkIGFjY3VyYXRlbHkgY291bnQgc2tpbGxzIGluIHB5dGhvbjMtZGV2ZWxvcG1lbnQnLCAoKSA9PiB7XG4gICAgICBjb25zdCByZXN1bHQgPSBkaXNjb3Zlck1hcmtldHBsYWNlKENMQVVERV9TS0lMTFNfUEFUSCEpO1xuICAgICAgY29uc3QgcHl0aG9uUGx1Z2luID0gcmVzdWx0LnBsdWdpbnMuZmluZChwID0+IHAubmFtZSA9PT0gJ3B5dGhvbjMtZGV2ZWxvcG1lbnQnKTtcbiAgICAgIFxuICAgICAgYXNzZXJ0Lm9rKHB5dGhvblBsdWdpbiwgJ3B5dGhvbjMtZGV2ZWxvcG1lbnQgc2hvdWxkIGV4aXN0Jyk7XG4gICAgICBcbiAgICAgIC8vIFZlcmlmeSBieSBkaXJlY3RseSBjb3VudGluZyB0aGUgc2tpbGxzIGRpcmVjdG9yeVxuICAgICAgY29uc3Qgc2tpbGxzRGlyID0gcGF0aC5qb2luKHB5dGhvblBsdWdpbi5yZXNvbHZlZFBhdGghLCAnc2tpbGxzJyk7XG4gICAgICBpZiAoZnMuZXhpc3RzU3luYyhza2lsbHNEaXIpKSB7XG4gICAgICAgIGNvbnN0IGFjdHVhbFNraWxscyA9IGZzLnJlYWRkaXJTeW5jKHNraWxsc0RpcilcbiAgICAgICAgICAuZmlsdGVyKGl0ZW0gPT4ge1xuICAgICAgICAgICAgY29uc3QgaXRlbVBhdGggPSBwYXRoLmpvaW4oc2tpbGxzRGlyLCBpdGVtKTtcbiAgICAgICAgICAgIHJldHVybiBmcy5zdGF0U3luYyhpdGVtUGF0aCkuaXNEaXJlY3RvcnkoKSB8fCBpdGVtLmVuZHNXaXRoKCcubWQnKTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgXG4gICAgICAgIC8vIEFsbG93IGZvciBzb21lIHZhcmlhbmNlIGR1ZSB0byBmaWx0ZXJpbmcgZGlmZmVyZW5jZXNcbiAgICAgICAgYXNzZXJ0Lm9rKE1hdGguYWJzKHB5dGhvblBsdWdpbi5pbnZlbnRvcnkuc2tpbGxzLmxlbmd0aCAtIGFjdHVhbFNraWxscy5sZW5ndGgpIDw9IDIsXG4gICAgICAgICAgYFNraWxscyBjb3VudCBzaG91bGQgYmUgY2xvc2UgdG8gYWN0dWFsOiByZXBvcnRlZCAke3B5dGhvblBsdWdpbi5pbnZlbnRvcnkuc2tpbGxzLmxlbmd0aH0sIGFjdHVhbCAke2FjdHVhbFNraWxscy5sZW5ndGh9YCk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBpdCgnc2hvdWxkIGRpc2NvdmVyIE1DUCBzZXJ2ZXJzIGZyb20gcGx1Z2luLmpzb24nLCAoKSA9PiB7XG4gICAgICBjb25zdCByZXN1bHQgPSBkaXNjb3Zlck1hcmtldHBsYWNlKENMQVVERV9TS0lMTFNfUEFUSCEpO1xuICAgICAgY29uc3QgcHl0aG9uUGx1Z2luID0gcmVzdWx0LnBsdWdpbnMuZmluZChwID0+IHAubmFtZSA9PT0gJ3B5dGhvbjMtZGV2ZWxvcG1lbnQnKTtcbiAgICAgIFxuICAgICAgYXNzZXJ0Lm9rKHB5dGhvblBsdWdpbiwgJ3B5dGhvbjMtZGV2ZWxvcG1lbnQgc2hvdWxkIGV4aXN0Jyk7XG4gICAgICBhc3NlcnQub2soT2JqZWN0LmtleXMocHl0aG9uUGx1Z2luLmludmVudG9yeS5tY3BTZXJ2ZXJzKS5sZW5ndGggPiAwLFxuICAgICAgICAncHl0aG9uMy1kZXZlbG9wbWVudCBzaG91bGQgaGF2ZSBNQ1Agc2VydmVycyBmcm9tIHBsdWdpbi5qc29uJyk7XG4gICAgfSk7XG5cbiAgICBpdCgnc2hvdWxkIGluY2x1ZGUgY29tbWFuZHMgaW4gaW52ZW50b3J5IHdoZW4gcHJlc2VudCcsICgpID0+IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGRpc2NvdmVyTWFya2V0cGxhY2UoQ0xBVURFX1NLSUxMU19QQVRIISk7XG4gICAgICBjb25zdCBweXRob25QbHVnaW4gPSByZXN1bHQucGx1Z2lucy5maW5kKHAgPT4gcC5uYW1lID09PSAncHl0aG9uMy1kZXZlbG9wbWVudCcpO1xuICAgICAgXG4gICAgICBhc3NlcnQub2socHl0aG9uUGx1Z2luLCAncHl0aG9uMy1kZXZlbG9wbWVudCBzaG91bGQgZXhpc3QnKTtcbiAgICAgIGFzc2VydC5vayhweXRob25QbHVnaW4uaW52ZW50b3J5LmNvbW1hbmRzLmxlbmd0aCA+IDAsXG4gICAgICAgICdweXRob24zLWRldmVsb3BtZW50IHNob3VsZCBoYXZlIGNvbW1hbmRzJyk7XG4gICAgfSk7XG5cbiAgICBpdCgnc2hvdWxkIGRldGVjdCBob29rcyB3aGVuIHByZXNlbnQnLCAoKSA9PiB7XG4gICAgICBjb25zdCByZXN1bHQgPSBkaXNjb3Zlck1hcmtldHBsYWNlKENMQVVERV9TS0lMTFNfUEFUSCEpO1xuICAgICAgXG4gICAgICAvLyBGaW5kIGFueSBwbHVnaW4gd2l0aCBob29rc1xuICAgICAgY29uc3QgcGx1Z2luV2l0aEhvb2tzID0gcmVzdWx0LnBsdWdpbnMuZmluZChwID0+IFxuICAgICAgICBwLmludmVudG9yeS5ob29rcyAmJiBwLmludmVudG9yeS5ob29rcy5sZW5ndGggPiAwXG4gICAgICApO1xuICAgICAgXG4gICAgICAvLyBBdCBsZWFzdCBzb21lIHBsdWdpbnMgc2hvdWxkIGhhdmUgaG9va3NcbiAgICAgIGFzc2VydC5vayhwbHVnaW5XaXRoSG9va3MgIT09IHVuZGVmaW5lZCwgXG4gICAgICAgICdBdCBsZWFzdCBvbmUgcGx1Z2luIHNob3VsZCBoYXZlIGhvb2tzJyk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKCdDcm9zcy1tYXJrZXRwbGFjZSBjb25zaXN0ZW5jeScsICgpID0+IHtcbiAgICBpdCgnc2hvdWxkIHJldHVybiBjb25zaXN0ZW50IHR5cGUgc3RydWN0dXJlIGZvciBib3RoIG1hcmtldHBsYWNlcycsICgpID0+IHtcbiAgICAgIGNvbnN0IGphbWllID0gZGlzY292ZXJNYXJrZXRwbGFjZShDTEFVREVfU0tJTExTX1BBVEghKTtcbiAgICAgIGNvbnN0IG9mZmljaWFsID0gZGlzY292ZXJNYXJrZXRwbGFjZShDTEFVREVfUExVR0lOU19PRkZJQ0lBTF9QQVRIISk7XG4gICAgICBcbiAgICAgIC8vIEJvdGggc2hvdWxkIGhhdmUgdGhlIHNhbWUgdG9wLWxldmVsIHN0cnVjdHVyZVxuICAgICAgY29uc3QgcmVxdWlyZWRLZXlzID0gWydzdGF0dXMnLCAnbWFya2V0cGxhY2VQYXRoJywgJ21hcmtldHBsYWNlTmFtZScsIFxuICAgICAgICAncGx1Z2luRm9ybWF0JywgJ3BsdWdpbnMnLCAnc3VtbWFyeSddO1xuICAgICAgXG4gICAgICBmb3IgKGNvbnN0IGtleSBvZiByZXF1aXJlZEtleXMpIHtcbiAgICAgICAgYXNzZXJ0Lm9rKGtleSBpbiBqYW1pZSwgYGphbWllIHJlc3VsdCBzaG91bGQgaGF2ZSAke2tleX1gKTtcbiAgICAgICAgYXNzZXJ0Lm9rKGtleSBpbiBvZmZpY2lhbCwgYG9mZmljaWFsIHJlc3VsdCBzaG91bGQgaGF2ZSAke2tleX1gKTtcbiAgICAgIH1cbiAgICAgIFxuICAgICAgLy8gQm90aCBzdW1tYXJpZXMgc2hvdWxkIGhhdmUgc2FtZSBzdHJ1Y3R1cmVcbiAgICAgIGNvbnN0IHN1bW1hcnlLZXlzID0gWyd0b3RhbCcsICdvaycsICdlcnJvciddO1xuICAgICAgZm9yIChjb25zdCBrZXkgb2Ygc3VtbWFyeUtleXMpIHtcbiAgICAgICAgYXNzZXJ0Lm9rKGtleSBpbiBqYW1pZS5zdW1tYXJ5LCBgamFtaWUgc3VtbWFyeSBzaG91bGQgaGF2ZSAke2tleX1gKTtcbiAgICAgICAgYXNzZXJ0Lm9rKGtleSBpbiBvZmZpY2lhbC5zdW1tYXJ5LCBgb2ZmaWNpYWwgc3VtbWFyeSBzaG91bGQgaGF2ZSAke2tleX1gKTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIGl0KCdzaG91bGQgcmV0dXJuIGNvbnNpc3RlbnQgcGx1Z2luIHN0cnVjdHVyZScsICgpID0+IHtcbiAgICAgIGNvbnN0IGphbWllID0gZGlzY292ZXJNYXJrZXRwbGFjZShDTEFVREVfU0tJTExTX1BBVEghKTtcbiAgICAgIGNvbnN0IG9mZmljaWFsID0gZGlzY292ZXJNYXJrZXRwbGFjZShDTEFVREVfUExVR0lOU19PRkZJQ0lBTF9QQVRIISk7XG4gICAgICBcbiAgICAgIGNvbnN0IGphbWllUGx1Z2luID0gamFtaWUucGx1Z2luc1swXTtcbiAgICAgIGNvbnN0IG9mZmljaWFsUGx1Z2luID0gb2ZmaWNpYWwucGx1Z2luc1swXTtcbiAgICAgIFxuICAgICAgY29uc3QgcmVxdWlyZWRLZXlzID0gWyduYW1lJywgJ2Nhbm9uaWNhbE5hbWUnLCAnc291cmNlJywgJ3Jlc29sdmVkUGF0aCcsIFxuICAgICAgICAnc3RhdHVzJywgJ21hbmlmZXN0U291cmNlJywgJ2ludmVudG9yeSddO1xuICAgICAgXG4gICAgICBmb3IgKGNvbnN0IGtleSBvZiByZXF1aXJlZEtleXMpIHtcbiAgICAgICAgYXNzZXJ0Lm9rKGtleSBpbiBqYW1pZVBsdWdpbiwgYGphbWllIHBsdWdpbiBzaG91bGQgaGF2ZSAke2tleX1gKTtcbiAgICAgICAgYXNzZXJ0Lm9rKGtleSBpbiBvZmZpY2lhbFBsdWdpbiwgYG9mZmljaWFsIHBsdWdpbiBzaG91bGQgaGF2ZSAke2tleX1gKTtcbiAgICAgIH1cbiAgICAgIFxuICAgICAgLy8gSW52ZW50b3J5IHN0cnVjdHVyZSBzaG91bGQgYmUgY29uc2lzdGVudFxuICAgICAgY29uc3QgaW52ZW50b3J5S2V5cyA9IFsnc2tpbGxzJywgJ2FnZW50cycsICdjb21tYW5kcycsICdtY3BTZXJ2ZXJzJywgJ2xzcFNlcnZlcnMnXTtcbiAgICAgIGZvciAoY29uc3Qga2V5IG9mIGludmVudG9yeUtleXMpIHtcbiAgICAgICAgYXNzZXJ0Lm9rKGtleSBpbiBqYW1pZVBsdWdpbi5pbnZlbnRvcnksIGBqYW1pZSBpbnZlbnRvcnkgc2hvdWxkIGhhdmUgJHtrZXl9YCk7XG4gICAgICAgIGFzc2VydC5vayhrZXkgaW4gb2ZmaWNpYWxQbHVnaW4uaW52ZW50b3J5LCBgb2ZmaWNpYWwgaW52ZW50b3J5IHNob3VsZCBoYXZlICR7a2V5fWApO1xuICAgICAgfVxuICAgIH0pO1xuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBWUEsU0FBUyxVQUFVLFVBQVU7QUFDN0IsT0FBTyxZQUFZO0FBQ25CLFlBQVksVUFBVTtBQUN0QixZQUFZLFFBQVE7QUFDcEI7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUNQLFNBQVMsOEJBQThCO0FBRXZDLE1BQU0sZUFBZSx1QkFBdUIsWUFBWSxPQUFPO0FBQy9ELE1BQU0sV0FBVyxhQUFhO0FBQzlCLE1BQU0scUJBQXFCLFVBQVU7QUFDckMsTUFBTSwrQkFBK0IsVUFBVTtBQUUvQyxNQUFNLGFBQWEsQ0FBQyxhQUFhLFlBQzdCLGFBQWEsY0FBYyxnQ0FDM0I7QUFFSixTQUFTLHdDQUF3QyxFQUFFLE1BQU0sV0FBVyxHQUFHLE1BQU07QUFDM0UsV0FBUywyQ0FBMkMsTUFBTTtBQUN4RCxPQUFHLHVDQUF1QyxNQUFNO0FBQzlDLFlBQU0sU0FB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LGlFQUFpRSxNQUFNO0FBQ3hFLFlBQU0sUUFBUSxvQkFBb0Isa0JBQW1CO0FBQ3JELFlBQU0sV0FBVyxvQkFBb0IsNEJBQTZCO0FBR2xFLFlBQU0sZUFBZTtBQUFBLFFBQUM7QUFBQSxRQUFVO0FBQUEsUUFBbUI7QUFBQSxRQUNqRDtBQUFBLFFBQWdCO0FBQUEsUUFBVztBQUFBLE1BQVM7QUFFdEMsaUJBQVcsT0FBTyxjQUFjO0FBQzlCLGVBQU8sR0FBRyxPQUFPLE9BQU8sNEJBQTRCLEdBQUcsRUFBRTtBQUN6RCxlQUFPLEdBQUcsT0FBTyxVQUFVLCtCQUErQixHQUFHLEVBQUU7QUFBQSxNQUNqRTtBQUdBLFlBQU0sY0FBYyxDQUFDLFNBQVMsTUFBTSxPQUFPO0FBQzNDLGlCQUFXLE9BQU8sYUFBYTtBQUM3QixlQUFPLEdBQUcsT0FBTyxNQUFNLFNBQVMsNkJBQTZCLEdBQUcsRUFBRTtBQUNsRSxlQUFPLEdBQUcsT0FBTyxTQUFTLFNBQVMsZ0NBQWdDLEdBQUcsRUFBRTtBQUFBLE1BQzFFO0FBQUEsSUFDRixDQUFDO0FBRUQsT0FBRyw2Q0FBNkMsTUFBTTtBQUNwRCxZQUFNLFFBQVEsb0JBQW9CLGtCQUFtQjtBQUNyRCxZQUFNLFdBQVcsb0JBQW9CLDRCQUE2QjtBQUVsRSxZQUFNLGNBQWMsTUFBTSxRQUFRLENBQUM7QUFDbkMsWUFBTSxpQkFBaUIsU0FBUyxRQUFRLENBQUM7QUFFekMsWUFBTSxlQUFlO0FBQUEsUUFBQztBQUFBLFFBQVE7QUFBQSxRQUFpQjtBQUFBLFFBQVU7QUFBQSxRQUN2RDtBQUFBLFFBQVU7QUFBQSxRQUFrQjtBQUFBLE1BQVc7QUFFekMsaUJBQVcsT0FBTyxjQUFjO0FBQzlCLGVBQU8sR0FBRyxPQUFPLGFBQWEsNEJBQTRCLEdBQUcsRUFBRTtBQUMvRCxlQUFPLEdBQUcsT0FBTyxnQkFBZ0IsK0JBQStCLEdBQUcsRUFBRTtBQUFBLE1BQ3ZFO0FBR0EsWUFBTSxnQkFBZ0IsQ0FBQyxVQUFVLFVBQVUsWUFBWSxjQUFjLFlBQVk7QUFDakYsaUJBQVcsT0FBTyxlQUFlO0FBQy9CLGVBQU8sR0FBRyxPQUFPLFlBQVksV0FBVywrQkFBK0IsR0FBRyxFQUFFO0FBQzVFLGVBQU8sR0FBRyxPQUFPLGVBQWUsV0FBVyxrQ0FBa0MsR0FBRyxFQUFFO0FBQUEsTUFDcEY7QUFBQSxJQUNGLENBQUM7QUFBQSxFQUNILENBQUM7QUFDSCxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
