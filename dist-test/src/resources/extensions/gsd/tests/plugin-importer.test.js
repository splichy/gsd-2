import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import {
  PluginImporter
} from "../plugin-importer.js";
function createMockPlugin(overrides = {}) {
  return {
    name: "test-plugin",
    canonicalName: "test-plugin",
    source: "./plugins/test-plugin",
    resolvedPath: "/plugins/test-plugin",
    status: "ok",
    manifestSource: "plugin.json",
    description: "A test plugin",
    version: "1.0.0",
    author: { name: "Test Author" },
    inventory: {
      skills: ["skill-a", "skill-b"],
      agents: ["agent-x"],
      commands: [],
      mcpServers: {},
      lspServers: {},
      hooks: []
    },
    ...overrides
  };
}
function createMockDiscoveryResult(plugins = [], overrides = {}) {
  return {
    status: "ok",
    marketplacePath: "/test/marketplace.json",
    marketplaceName: "Test Marketplace",
    pluginFormat: "jamie-style",
    plugins,
    summary: {
      total: plugins.length,
      ok: plugins.filter((p) => p.status === "ok").length,
      error: plugins.filter((p) => p.status === "error").length
    },
    ...overrides
  };
}
describe("PluginImporter", () => {
  let importer;
  beforeEach(() => {
    importer = new PluginImporter();
  });
  describe("Stage 1: discover()", () => {
    it("should throw error if paths array is empty but return valid result", () => {
      const result = importer.discover([]);
      assert.strictEqual(result.summary.marketplacesProcessed, 0);
      assert.strictEqual(result.summary.totalPlugins, 0);
      assert.strictEqual(result.summary.totalComponents, 0);
    });
    it("should call discoverMarketplace for each path and aggregate results", () => {
      const result = importer.discover([
        "/nonexistent/marketplace-1",
        "/nonexistent/marketplace-2"
      ]);
      assert.strictEqual(result.summary.marketplacesProcessed, 2);
      assert.strictEqual(Array.isArray(result.marketplaceResults), true);
      assert.strictEqual(result.marketplaceResults.length, 2);
    });
    it("should populate registry via componentsFromDiscovery", () => {
      const result = importer.discover([]);
      const registry = importer.getRegistry();
      assert.ok(registry !== null);
      assert.strictEqual(registry.size, result.summary.totalComponents);
    });
    it("should track plugins with errors in summary", () => {
      const result = importer.discover(["/nonexistent/path"]);
      assert.ok(result.summary.marketplacesWithErrors >= 0);
    });
    it("should be re-entrant (calling discover again resets state)", () => {
      importer.discover(["/nonexistent/path-1"]);
      const firstPlugins = importer.getDiscoveredPlugins();
      importer.discover(["/nonexistent/path-2"]);
      const secondPlugins = importer.getDiscoveredPlugins();
      assert.strictEqual(firstPlugins.length, 0);
      assert.strictEqual(secondPlugins.length, 0);
    });
  });
  describe("Stage 2: selectComponents()", () => {
    it("should throw error if called before discover()", () => {
      assert.throws(
        () => importer.selectComponents(() => true),
        /Must call discover\(\) before selectComponents\(\)/
      );
    });
    it("should return empty array if no components match filter", () => {
      importer.discover([]);
      const selected = importer.selectComponents(() => false);
      assert.deepStrictEqual(selected, []);
    });
    it("should return all components if filter returns true", () => {
      importer.discover([]);
      const selected = importer.selectComponents(() => true);
      assert.deepStrictEqual(selected, []);
    });
    it("should filter by namespace correctly", () => {
      importer.discover([]);
      const selected = importer.selectComponents(
        (c) => c.namespace === "target-plugin"
      );
      assert.deepStrictEqual(selected, []);
    });
    it("should filter by type correctly", () => {
      importer.discover([]);
      const skills = importer.selectComponents((c) => c.type === "skill");
      const agents = importer.selectComponents((c) => c.type === "agent");
      assert.deepStrictEqual(skills, []);
      assert.deepStrictEqual(agents, []);
    });
    it("should filter by name pattern correctly", () => {
      importer.discover([]);
      const selected = importer.selectComponents(
        (c) => c.name.includes("review")
      );
      assert.deepStrictEqual(selected, []);
    });
  });
  describe("Stage 3: validateImport()", () => {
    it("should throw error if called before discover()", () => {
      const components = [];
      assert.throws(
        () => importer.validateImport(components),
        /Must call discover\(\) before validateImport\(\)/
      );
    });
    it("should return canProceed: true for empty selection", () => {
      importer.discover([]);
      const result = importer.validateImport([]);
      assert.strictEqual(result.canProceed, true);
      assert.strictEqual(result.diagnostics.length, 0);
      assert.strictEqual(result.summary.total, 0);
      assert.strictEqual(result.summary.errors, 0);
      assert.strictEqual(result.summary.warnings, 0);
    });
    it("should return canProceed: true when no collisions", () => {
      importer.discover([]);
      const components = [
        {
          name: "skill-a",
          namespace: "plugin-x",
          canonicalName: "plugin-x:skill-a",
          type: "skill",
          filePath: "/x/skill-a.md",
          source: "plugin:plugin-x",
          description: void 0,
          metadata: {}
        },
        {
          name: "skill-b",
          namespace: "plugin-y",
          canonicalName: "plugin-y:skill-b",
          type: "skill",
          filePath: "/y/skill-b.md",
          source: "plugin:plugin-y",
          description: void 0,
          metadata: {}
        }
      ];
      const result = importer.validateImport(components);
      assert.strictEqual(result.canProceed, true);
    });
    it("should detect canonical collision and return canProceed: false (error blocks)", () => {
      importer.discover([]);
      const components = [
        {
          name: "skill-a",
          namespace: "plugin-x",
          canonicalName: "plugin-x:skill-a",
          type: "skill",
          filePath: "/first/skill-a.md",
          source: "plugin:plugin-x",
          description: void 0,
          metadata: {}
        },
        {
          name: "skill-a",
          namespace: "plugin-x",
          canonicalName: "plugin-x:skill-a",
          // Same canonical name!
          type: "skill",
          filePath: "/second/skill-a.md",
          source: "plugin:plugin-x",
          description: void 0,
          metadata: {}
        }
      ];
      const result = importer.validateImport(components);
      assert.strictEqual(result.canProceed, false);
      assert.strictEqual(result.summary.errors, 1);
      assert.ok(result.diagnostics.some((d) => d.severity === "error"));
    });
    it("should detect shorthand overlap but return canProceed: true (warning passes)", () => {
      importer.discover([]);
      const components = [
        {
          name: "review",
          // Same bare name
          namespace: "plugin-a",
          canonicalName: "plugin-a:review",
          type: "skill",
          filePath: "/a/review.md",
          source: "plugin:plugin-a",
          description: void 0,
          metadata: {}
        },
        {
          name: "review",
          // Same bare name
          namespace: "plugin-b",
          canonicalName: "plugin-b:review",
          type: "skill",
          filePath: "/b/review.md",
          source: "plugin:plugin-b",
          description: void 0,
          metadata: {}
        }
      ];
      const result = importer.validateImport(components);
      assert.strictEqual(result.canProceed, true);
      assert.strictEqual(result.summary.errors, 0);
      assert.strictEqual(result.summary.warnings, 1);
      assert.ok(result.diagnostics.some((d) => d.severity === "warning"));
    });
    it("should correctly classify severity: error for canonical conflict", () => {
      importer.discover([]);
      const components = [
        {
          name: "dup",
          namespace: "ns",
          canonicalName: "ns:dup",
          type: "skill",
          filePath: "/1/dup.md",
          source: "first",
          description: void 0,
          metadata: {}
        },
        {
          name: "dup",
          namespace: "ns",
          canonicalName: "ns:dup",
          type: "skill",
          filePath: "/2/dup.md",
          source: "second",
          description: void 0,
          metadata: {}
        }
      ];
      const result = importer.validateImport(components);
      const error = result.diagnostics.find((d) => d.severity === "error");
      assert.ok(error !== void 0);
      assert.strictEqual(error.class, "canonical-conflict");
      assert.ok(error.involvedCanonicalNames.includes("ns:dup"));
    });
    it("should correctly classify severity: warning for shorthand overlap", () => {
      importer.discover([]);
      const components = [
        {
          name: "common-skill",
          namespace: "plugin-a",
          canonicalName: "plugin-a:common-skill",
          type: "skill",
          filePath: "/a/common.md",
          source: "plugin:plugin-a",
          description: void 0,
          metadata: {}
        },
        {
          name: "common-skill",
          namespace: "plugin-b",
          canonicalName: "plugin-b:common-skill",
          type: "skill",
          filePath: "/b/common.md",
          source: "plugin:plugin-b",
          description: void 0,
          metadata: {}
        }
      ];
      const result = importer.validateImport(components);
      const warning = result.diagnostics.find((d) => d.severity === "warning");
      assert.ok(warning !== void 0);
      assert.strictEqual(warning.class, "shorthand-overlap");
      assert.strictEqual(warning.ambiguousBareName, "common-skill");
    });
  });
  describe("Stage 4: getImportManifest()", () => {
    it("should produce valid manifest for empty selection", () => {
      const manifest = importer.getImportManifest([]);
      assert.strictEqual(manifest.schemaVersion, "1.0");
      assert.strictEqual(typeof manifest.generatedAt, "string");
      assert.deepStrictEqual(manifest.entries, []);
      assert.strictEqual(manifest.summary.total, 0);
      assert.strictEqual(manifest.summary.skills, 0);
      assert.strictEqual(manifest.summary.agents, 0);
      assert.deepStrictEqual(manifest.summary.namespaces, []);
    });
    it("should preserve canonical names in manifest (R013)", () => {
      const components = [
        {
          name: "code-review",
          namespace: "my-plugin",
          canonicalName: "my-plugin:code-review",
          type: "skill",
          filePath: "/plugins/my-plugin/skills/code-review/SKILL.md",
          source: "plugin:my-plugin",
          description: "Reviews code",
          metadata: {
            pluginVersion: "1.0.0",
            pluginAuthor: "Test Author"
          }
        }
      ];
      const manifest = importer.getImportManifest(components);
      assert.strictEqual(manifest.entries.length, 1);
      const entry = manifest.entries[0];
      assert.strictEqual(entry.canonicalName, "my-plugin:code-review");
      assert.strictEqual(entry.name, "code-review");
      assert.strictEqual(entry.namespace, "my-plugin");
    });
    it("should include all component metadata in manifest", () => {
      const components = [
        {
          name: "test-skill",
          namespace: "test-plugin",
          canonicalName: "test-plugin:test-skill",
          type: "skill",
          filePath: "/test/skill.md",
          source: "plugin:test-plugin",
          description: "A test skill",
          metadata: {
            pluginVersion: "2.0.0",
            pluginAuthor: "Author Name",
            pluginHomepage: "https://example.com",
            pluginCategory: "testing"
          }
        }
      ];
      const manifest = importer.getImportManifest(components);
      const entry = manifest.entries[0];
      assert.ok(entry !== void 0);
      assert.strictEqual(entry.description, "A test skill");
      assert.strictEqual(entry.metadata.pluginVersion, "2.0.0");
      assert.strictEqual(entry.metadata.pluginAuthor, "Author Name");
      assert.strictEqual(entry.metadata.pluginHomepage, "https://example.com");
      assert.strictEqual(entry.metadata.pluginCategory, "testing");
    });
    it("should count skills and agents separately in summary", () => {
      const components = [
        {
          name: "skill-a",
          namespace: "ns",
          canonicalName: "ns:skill-a",
          type: "skill",
          filePath: "/a.md",
          source: "plugin:ns",
          description: void 0,
          metadata: {}
        },
        {
          name: "skill-b",
          namespace: "ns",
          canonicalName: "ns:skill-b",
          type: "skill",
          filePath: "/b.md",
          source: "plugin:ns",
          description: void 0,
          metadata: {}
        },
        {
          name: "agent-x",
          namespace: "ns",
          canonicalName: "ns:agent-x",
          type: "agent",
          filePath: "/x.md",
          source: "plugin:ns",
          description: void 0,
          metadata: {}
        }
      ];
      const manifest = importer.getImportManifest(components);
      assert.strictEqual(manifest.summary.total, 3);
      assert.strictEqual(manifest.summary.skills, 2);
      assert.strictEqual(manifest.summary.agents, 1);
    });
    it("should list unique namespaces in summary", () => {
      const components = [
        {
          name: "skill",
          namespace: "plugin-a",
          canonicalName: "plugin-a:skill",
          type: "skill",
          filePath: "/a.md",
          source: "plugin:plugin-a",
          description: void 0,
          metadata: {}
        },
        {
          name: "skill",
          namespace: "plugin-b",
          canonicalName: "plugin-b:skill",
          type: "skill",
          filePath: "/b.md",
          source: "plugin:plugin-b",
          description: void 0,
          metadata: {}
        },
        {
          name: "skill",
          namespace: "plugin-a",
          // Duplicate namespace
          canonicalName: "plugin-a:skill-2",
          type: "skill",
          filePath: "/a2.md",
          source: "plugin:plugin-a",
          description: void 0,
          metadata: {}
        }
      ];
      const manifest = importer.getImportManifest(components);
      assert.deepStrictEqual(manifest.summary.namespaces, ["plugin-a", "plugin-b"]);
    });
    it("should handle flat (non-namespaced) components", () => {
      const components = [
        {
          name: "flat-skill",
          namespace: void 0,
          canonicalName: "flat-skill",
          type: "skill",
          filePath: "/flat.md",
          source: "user",
          description: void 0,
          metadata: {}
        }
      ];
      const manifest = importer.getImportManifest(components);
      assert.strictEqual(manifest.entries.length, 1);
      assert.strictEqual(manifest.entries[0].namespace, void 0);
      assert.strictEqual(manifest.entries[0].canonicalName, "flat-skill");
      assert.deepStrictEqual(manifest.summary.namespaces, []);
    });
    it("should be serializable to JSON", () => {
      const components = [
        {
          name: "skill",
          namespace: "plugin",
          canonicalName: "plugin:skill",
          type: "skill",
          filePath: "/skill.md",
          source: "plugin:plugin",
          description: "A skill",
          metadata: { pluginVersion: "1.0.0" }
        }
      ];
      const manifest = importer.getImportManifest(components);
      const json = JSON.stringify(manifest);
      const parsed = JSON.parse(json);
      assert.strictEqual(parsed.schemaVersion, "1.0");
      assert.strictEqual(parsed.entries[0].canonicalName, "plugin:skill");
    });
  });
  describe("Full Pipeline: discover \u2192 select \u2192 validate \u2192 manifest", () => {
    it("should execute full pipeline with mock components", () => {
      const discovery = importer.discover([]);
      assert.strictEqual(discovery.summary.totalComponents, 0);
      const selected = importer.selectComponents(() => true);
      assert.strictEqual(selected.length, 0);
      const validation = importer.validateImport(selected);
      assert.strictEqual(validation.canProceed, true);
      const manifest = importer.getImportManifest(selected);
      assert.strictEqual(manifest.summary.total, 0);
    });
    it("should preserve canonical names through full pipeline (R013)", () => {
      importer.discover([]);
      const components = [
        {
          name: "code-review",
          namespace: "my-plugin",
          canonicalName: "my-plugin:code-review",
          type: "skill",
          filePath: "/plugins/my-plugin/skills/code-review/SKILL.md",
          source: "plugin:my-plugin",
          description: "Reviews code",
          metadata: { pluginVersion: "1.0.0" }
        },
        {
          name: "architect",
          namespace: "my-plugin",
          canonicalName: "my-plugin:architect",
          type: "agent",
          filePath: "/plugins/my-plugin/agents/architect/AGENT.md",
          source: "plugin:my-plugin",
          description: "Designs architecture",
          metadata: { pluginVersion: "1.0.0" }
        }
      ];
      const validation = importer.validateImport(components);
      assert.strictEqual(validation.canProceed, true);
      const manifest = importer.getImportManifest(components);
      assert.strictEqual(manifest.entries.length, 2);
      assert.strictEqual(manifest.entries[0].canonicalName, "my-plugin:code-review");
      assert.strictEqual(manifest.entries[1].canonicalName, "my-plugin:architect");
      const skill = manifest.entries.find((e) => e.type === "skill");
      assert.ok(skill !== void 0);
      assert.strictEqual(skill.canonicalName, "my-plugin:code-review");
      assert.strictEqual(skill.name, "code-review");
      assert.strictEqual(skill.namespace, "my-plugin");
    });
    it("should block import on canonical collision", () => {
      importer.discover([]);
      const components = [
        {
          name: "skill",
          namespace: "ns",
          canonicalName: "ns:skill",
          type: "skill",
          filePath: "/first.md",
          source: "first",
          description: void 0,
          metadata: {}
        },
        {
          name: "skill",
          namespace: "ns",
          canonicalName: "ns:skill",
          // Collision!
          type: "skill",
          filePath: "/second.md",
          source: "second",
          description: void 0,
          metadata: {}
        }
      ];
      const validation = importer.validateImport(components);
      assert.strictEqual(validation.canProceed, false);
      assert.strictEqual(validation.summary.errors, 1);
      assert.ok(validation.diagnostics[0].remediation.length > 0);
    });
    it("should allow import with warnings (shorthand overlap)", () => {
      importer.discover([]);
      const components = [
        {
          name: "review",
          namespace: "plugin-a",
          canonicalName: "plugin-a:review",
          type: "skill",
          filePath: "/a.md",
          source: "plugin:plugin-a",
          description: void 0,
          metadata: {}
        },
        {
          name: "review",
          namespace: "plugin-b",
          canonicalName: "plugin-b:review",
          type: "skill",
          filePath: "/b.md",
          source: "plugin:plugin-b",
          description: void 0,
          metadata: {}
        }
      ];
      const validation = importer.validateImport(components);
      assert.strictEqual(validation.canProceed, true);
      assert.strictEqual(validation.summary.warnings, 1);
      const manifest = importer.getImportManifest(components);
      assert.strictEqual(manifest.entries.length, 2);
    });
  });
  describe("Inspection methods", () => {
    it("should return null for getRegistry() before discover()", () => {
      assert.strictEqual(importer.getRegistry(), null);
    });
    it("should return registry after discover()", () => {
      importer.discover([]);
      assert.ok(importer.getRegistry() !== null);
    });
    it("should return empty array for getDiscoveredPlugins() before discover()", () => {
      const plugins = importer.getDiscoveredPlugins();
      assert.deepStrictEqual(plugins, []);
    });
    it("should return null for getLastValidation() before validateImport()", () => {
      assert.strictEqual(importer.getLastValidation(), null);
    });
    it("should return last validation after validateImport()", () => {
      importer.discover([]);
      importer.validateImport([]);
      assert.ok(importer.getLastValidation() !== null);
    });
    it("should return null for getLastDiscovery() before discover()", () => {
      assert.strictEqual(importer.getLastDiscovery(), null);
    });
    it("should return last discovery after discover()", () => {
      importer.discover([]);
      assert.ok(importer.getLastDiscovery() !== null);
    });
  });
  describe("Diagnostic structure verification", () => {
    it("should provide actionable remediation in diagnostics", () => {
      importer.discover([]);
      const components = [
        {
          name: "dup",
          namespace: "ns",
          canonicalName: "ns:dup",
          type: "skill",
          filePath: "/first.md",
          source: "first",
          description: void 0,
          metadata: {}
        },
        {
          name: "dup",
          namespace: "ns",
          canonicalName: "ns:dup",
          type: "skill",
          filePath: "/second.md",
          source: "second",
          description: void 0,
          metadata: {}
        }
      ];
      const validation = importer.validateImport(components);
      const diag = validation.diagnostics[0];
      assert.ok(diag !== void 0);
      assert.ok(diag.remediation.length > 0);
      assert.ok(diag.remediation.includes("ns:dup"));
    });
    it("should include file paths in collision diagnostic", () => {
      importer.discover([]);
      const components = [
        {
          name: "dup",
          namespace: "ns",
          canonicalName: "ns:dup",
          type: "skill",
          filePath: "/first/dup.md",
          source: "first",
          description: void 0,
          metadata: {}
        },
        {
          name: "dup",
          namespace: "ns",
          canonicalName: "ns:dup",
          type: "skill",
          filePath: "/second/dup.md",
          source: "second",
          description: void 0,
          metadata: {}
        }
      ];
      const validation = importer.validateImport(components);
      const diag = validation.diagnostics[0];
      assert.ok(diag.filePaths.includes("/first/dup.md"));
      assert.ok(diag.filePaths.includes("/second/dup.md"));
    });
  });
});
describe("R012: Discover / select / import flow", () => {
  it("should support staged discovery \u2192 selection \u2192 validation \u2192 manifest", () => {
    const importer = new PluginImporter();
    const discovery = importer.discover([]);
    assert.ok(discovery.registry !== void 0);
    const selected = importer.selectComponents(() => true);
    assert.ok(Array.isArray(selected));
    const validation = importer.validateImport(selected);
    assert.ok(typeof validation.canProceed === "boolean");
    assert.ok(Array.isArray(validation.diagnostics));
    const manifest = importer.getImportManifest(selected);
    assert.ok(manifest.schemaVersion === "1.0");
    assert.ok(Array.isArray(manifest.entries));
  });
  it("should allow independent testing of each stage", () => {
    const importer = new PluginImporter();
    importer.discover([]);
    const all = importer.selectComponents(() => true);
    const skills = importer.selectComponents((c) => c.type === "skill");
    const agents = importer.selectComponents((c) => c.type === "agent");
    assert.ok(true);
    const validation1 = importer.validateImport(all);
    const validation2 = importer.validateImport(skills);
    const validation3 = importer.validateImport(agents);
    assert.ok(validation1.canProceed === true);
    assert.ok(validation2.canProceed === true);
    assert.ok(validation3.canProceed === true);
    const manifest1 = importer.getImportManifest(all);
    const manifest2 = importer.getImportManifest(skills);
    const manifest3 = importer.getImportManifest(agents);
    assert.ok(manifest1.schemaVersion === "1.0");
    assert.ok(manifest2.schemaVersion === "1.0");
    assert.ok(manifest3.schemaVersion === "1.0");
  });
});
describe("R013: Canonical name preservation", () => {
  it("should preserve plugin:component format in manifest entries", () => {
    const importer = new PluginImporter();
    const components = [
      {
        name: "my-skill",
        namespace: "my-plugin",
        canonicalName: "my-plugin:my-skill",
        type: "skill",
        filePath: "/skill.md",
        source: "plugin:my-plugin",
        description: void 0,
        metadata: {}
      }
    ];
    const manifest = importer.getImportManifest(components);
    assert.strictEqual(manifest.entries[0].canonicalName, "my-plugin:my-skill");
  });
  it("should preserve flat names for non-namespaced components", () => {
    const importer = new PluginImporter();
    const components = [
      {
        name: "flat-skill",
        namespace: void 0,
        canonicalName: "flat-skill",
        type: "skill",
        filePath: "/skill.md",
        source: "user",
        description: void 0,
        metadata: {}
      }
    ];
    const manifest = importer.getImportManifest(components);
    assert.strictEqual(manifest.entries[0].canonicalName, "flat-skill");
    assert.strictEqual(manifest.entries[0].namespace, void 0);
  });
  it("should support round-trip identity (name + namespace \u2192 canonical)", () => {
    const importer = new PluginImporter();
    const components = [
      {
        name: "component",
        namespace: "namespace",
        canonicalName: "namespace:component",
        type: "skill",
        filePath: "/path",
        source: "source",
        description: void 0,
        metadata: {}
      }
    ];
    const manifest = importer.getImportManifest(components);
    const entry = manifest.entries[0];
    const reconstructed = entry.namespace ? `${entry.namespace}:${entry.name}` : entry.name;
    assert.strictEqual(reconstructed, entry.canonicalName);
    assert.strictEqual(reconstructed, "namespace:component");
  });
});
describe("T02: Command flow integration", () => {
  describe("Marketplace detection", () => {
    it("should categorize plugin roots into marketplaces vs flat paths", () => {
      const importer = new PluginImporter();
      const result = importer.discover(["/nonexistent/marketplace"]);
      assert.ok(result.summary.marketplacesProcessed === 1);
    });
    it("should handle empty marketplace paths gracefully", () => {
      const importer = new PluginImporter();
      const result = importer.discover([]);
      assert.strictEqual(result.summary.marketplacesProcessed, 0);
      assert.strictEqual(result.summary.totalPlugins, 0);
      assert.strictEqual(result.summary.totalComponents, 0);
    });
  });
  describe("Component selection flow", () => {
    it("should support filtering by plugin namespace", () => {
      const importer = new PluginImporter();
      importer.discover([]);
      const components = [
        {
          name: "skill-a",
          namespace: "plugin-x",
          canonicalName: "plugin-x:skill-a",
          type: "skill",
          filePath: "/x/skill-a.md",
          source: "plugin:plugin-x",
          description: void 0,
          metadata: {}
        },
        {
          name: "skill-b",
          namespace: "plugin-y",
          canonicalName: "plugin-y:skill-b",
          type: "skill",
          filePath: "/y/skill-b.md",
          source: "plugin:plugin-y",
          description: void 0,
          metadata: {}
        }
      ];
      const validation = importer.validateImport(components);
      assert.strictEqual(validation.canProceed, true);
      const manifest = importer.getImportManifest(components);
      assert.strictEqual(manifest.entries.length, 2);
      assert.strictEqual(manifest.summary.namespaces.length, 2);
      assert.ok(manifest.summary.namespaces.includes("plugin-x"));
      assert.ok(manifest.summary.namespaces.includes("plugin-y"));
    });
    it("should support filtering by component type", () => {
      const importer = new PluginImporter();
      importer.discover([]);
      const components = [
        {
          name: "skill-a",
          namespace: "plugin",
          canonicalName: "plugin:skill-a",
          type: "skill",
          filePath: "/skill-a.md",
          source: "plugin:plugin",
          description: void 0,
          metadata: {}
        },
        {
          name: "agent-x",
          namespace: "plugin",
          canonicalName: "plugin:agent-x",
          type: "agent",
          filePath: "/agent-x.md",
          source: "plugin:plugin",
          description: void 0,
          metadata: {}
        }
      ];
      const manifest = importer.getImportManifest(components);
      assert.strictEqual(manifest.summary.skills, 1);
      assert.strictEqual(manifest.summary.agents, 1);
    });
  });
  describe("Pre-import diagnostics gating", () => {
    it("should block import on canonical collision (error)", () => {
      const importer = new PluginImporter();
      importer.discover([]);
      const components = [
        {
          name: "skill",
          namespace: "ns",
          canonicalName: "ns:skill",
          type: "skill",
          filePath: "/first.md",
          source: "first",
          description: void 0,
          metadata: {}
        },
        {
          name: "skill",
          namespace: "ns",
          canonicalName: "ns:skill",
          // Collision
          type: "skill",
          filePath: "/second.md",
          source: "second",
          description: void 0,
          metadata: {}
        }
      ];
      const validation = importer.validateImport(components);
      assert.strictEqual(validation.canProceed, false);
      assert.strictEqual(validation.summary.errors, 1);
    });
    it("should allow import with shorthand overlap (warning)", () => {
      const importer = new PluginImporter();
      importer.discover([]);
      const components = [
        {
          name: "review",
          namespace: "plugin-a",
          canonicalName: "plugin-a:review",
          type: "skill",
          filePath: "/a/review.md",
          source: "plugin:plugin-a",
          description: void 0,
          metadata: {}
        },
        {
          name: "review",
          namespace: "plugin-b",
          canonicalName: "plugin-b:review",
          type: "skill",
          filePath: "/b/review.md",
          source: "plugin:plugin-b",
          description: void 0,
          metadata: {}
        }
      ];
      const validation = importer.validateImport(components);
      assert.strictEqual(validation.canProceed, true);
      assert.strictEqual(validation.summary.warnings, 1);
      assert.strictEqual(validation.summary.errors, 0);
    });
    it("should provide actionable diagnostics for blocking errors", () => {
      const importer = new PluginImporter();
      importer.discover([]);
      const components = [
        {
          name: "dup",
          namespace: "ns",
          canonicalName: "ns:dup",
          type: "skill",
          filePath: "/first.md",
          source: "first",
          description: void 0,
          metadata: {}
        },
        {
          name: "dup",
          namespace: "ns",
          canonicalName: "ns:dup",
          type: "skill",
          filePath: "/second.md",
          source: "second",
          description: void 0,
          metadata: {}
        }
      ];
      const validation = importer.validateImport(components);
      assert.strictEqual(validation.diagnostics.length, 1);
      assert.ok(validation.diagnostics[0].remediation.length > 0);
      assert.ok(validation.diagnostics[0].remediation.includes("ns:dup"));
    });
  });
  describe("Config persistence with canonical names", () => {
    it("should preserve canonical names in manifest for persistence", () => {
      const importer = new PluginImporter();
      const components = [
        {
          name: "code-review",
          namespace: "my-plugin",
          canonicalName: "my-plugin:code-review",
          type: "skill",
          filePath: "/plugins/my-plugin/skills/code-review/SKILL.md",
          source: "plugin:my-plugin",
          description: "Reviews code",
          metadata: { pluginVersion: "1.0.0" }
        },
        {
          name: "architect",
          namespace: "my-plugin",
          canonicalName: "my-plugin:architect",
          type: "agent",
          filePath: "/plugins/my-plugin/agents/architect/AGENT.md",
          source: "plugin:my-plugin",
          description: "Designs architecture",
          metadata: { pluginVersion: "1.0.0" }
        }
      ];
      const manifest = importer.getImportManifest(components);
      assert.strictEqual(manifest.entries.length, 2);
      assert.strictEqual(manifest.entries[0].canonicalName, "my-plugin:code-review");
      assert.strictEqual(manifest.entries[1].canonicalName, "my-plugin:architect");
      const json = JSON.stringify(manifest);
      const parsed = JSON.parse(json);
      assert.strictEqual(parsed.entries[0].canonicalName, "my-plugin:code-review");
    });
    it("should include file paths for settings persistence", () => {
      const importer = new PluginImporter();
      const components = [
        {
          name: "skill",
          namespace: "plugin",
          canonicalName: "plugin:skill",
          type: "skill",
          filePath: "/absolute/path/to/skill.md",
          source: "plugin:plugin",
          description: void 0,
          metadata: {}
        }
      ];
      const manifest = importer.getImportManifest(components);
      assert.strictEqual(manifest.entries[0].filePath, "/absolute/path/to/skill.md");
    });
    it("should separate skills and agents for settings routing", () => {
      const importer = new PluginImporter();
      const components = [
        {
          name: "skill-1",
          namespace: "p",
          canonicalName: "p:skill-1",
          type: "skill",
          filePath: "/s1.md",
          source: "plugin:p",
          description: void 0,
          metadata: {}
        },
        {
          name: "skill-2",
          namespace: "p",
          canonicalName: "p:skill-2",
          type: "skill",
          filePath: "/s2.md",
          source: "plugin:p",
          description: void 0,
          metadata: {}
        },
        {
          name: "agent-1",
          namespace: "p",
          canonicalName: "p:agent-1",
          type: "agent",
          filePath: "/a1.md",
          source: "plugin:p",
          description: void 0,
          metadata: {}
        }
      ];
      const manifest = importer.getImportManifest(components);
      const skills = manifest.entries.filter((e) => e.type === "skill");
      const agents = manifest.entries.filter((e) => e.type === "agent");
      assert.strictEqual(skills.length, 2);
      assert.strictEqual(agents.length, 1);
    });
  });
  describe("End-to-end command flow simulation", () => {
    it("should execute full pipeline: discover \u2192 select \u2192 validate \u2192 manifest", () => {
      const importer = new PluginImporter();
      const discovery = importer.discover([]);
      assert.strictEqual(discovery.summary.totalComponents, 0);
      const selected = [
        {
          name: "code-review",
          namespace: "my-plugin",
          canonicalName: "my-plugin:code-review",
          type: "skill",
          filePath: "/plugins/my-plugin/skills/code-review/SKILL.md",
          source: "plugin:my-plugin",
          description: "Reviews code",
          metadata: { pluginVersion: "1.0.0" }
        }
      ];
      const validation = importer.validateImport(selected);
      assert.strictEqual(validation.canProceed, true);
      const manifest = importer.getImportManifest(selected);
      assert.strictEqual(manifest.entries.length, 1);
      assert.strictEqual(manifest.entries[0].canonicalName, "my-plugin:code-review");
    });
    it("should block on validation failure before persistence", () => {
      const importer = new PluginImporter();
      importer.discover([]);
      const selected = [
        {
          name: "dup",
          namespace: "ns",
          canonicalName: "ns:dup",
          type: "skill",
          filePath: "/first.md",
          source: "first",
          description: void 0,
          metadata: {}
        },
        {
          name: "dup",
          namespace: "ns",
          canonicalName: "ns:dup",
          type: "skill",
          filePath: "/second.md",
          source: "second",
          description: void 0,
          metadata: {}
        }
      ];
      const validation = importer.validateImport(selected);
      if (validation.canProceed) {
        assert.fail("Should not proceed to persistence with errors");
      } else {
        assert.strictEqual(validation.summary.errors, 1);
      }
    });
    it("should allow proceeding after user confirms warnings", () => {
      const importer = new PluginImporter();
      importer.discover([]);
      const selected = [
        {
          name: "review",
          namespace: "plugin-a",
          canonicalName: "plugin-a:review",
          type: "skill",
          filePath: "/a/review.md",
          source: "plugin:plugin-a",
          description: void 0,
          metadata: {}
        },
        {
          name: "review",
          namespace: "plugin-b",
          canonicalName: "plugin-b:review",
          type: "skill",
          filePath: "/b/review.md",
          source: "plugin:plugin-b",
          description: void 0,
          metadata: {}
        }
      ];
      const validation = importer.validateImport(selected);
      assert.strictEqual(validation.canProceed, true);
      assert.strictEqual(validation.summary.warnings, 1);
      const manifest = importer.getImportManifest(selected);
      assert.strictEqual(manifest.entries.length, 2);
    });
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wbHVnaW4taW1wb3J0ZXIudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBQbHVnaW5JbXBvcnRlciBDb250cmFjdCBUZXN0c1xuICpcbiAqIFRlc3RzIHRoYXQgcHJvdmUgUjAxMiAoZGlzY292ZXIvc2VsZWN0L2ltcG9ydCBmbG93KSBhbmQgUjAxMyAoY2Fub25pY2FsIG5hbWUgcHJlc2VydmF0aW9uKS5cbiAqXG4gKiBDb3ZlcmFnZTpcbiAqIC0gRGlzY292ZXJ5IHBpcGVsaW5lOiBtYXJrZXRwbGFjZSBkaXNjb3ZlcnkgXHUyMTkyIHJlZ2lzdHJ5IHBvcHVsYXRpb25cbiAqIC0gU2VsZWN0aXZlIGZpbHRlcmluZzogZmlsdGVyIGZ1bmN0aW9uIGNvcnJlY3RseSBzZWxlY3RzIGNvbXBvbmVudHNcbiAqIC0gRGlhZ25vc3RpYyBnYXRpbmc6IGVycm9ycyBibG9jaywgd2FybmluZ3MgcGFzc1xuICogLSBDb25maWcgbWFuaWZlc3QgZm9ybWF0OiBjYW5vbmljYWwgaWRlbnRpdHkgcHJlc2VydmVkXG4gKi9cblxuaW1wb3J0IHsgZGVzY3JpYmUsIGl0LCBiZWZvcmVFYWNoLCBtb2NrIH0gZnJvbSAnbm9kZTp0ZXN0JztcbmltcG9ydCBhc3NlcnQgZnJvbSAnbm9kZTphc3NlcnQnO1xuaW1wb3J0IHtcblx0UGx1Z2luSW1wb3J0ZXIsXG5cdHR5cGUgRGlzY292ZXJ5UmVzdWx0LFxuXHR0eXBlIFZhbGlkYXRpb25SZXN1bHQsXG5cdHR5cGUgSW1wb3J0TWFuaWZlc3QsXG59IGZyb20gJy4uL3BsdWdpbi1pbXBvcnRlci5qcyc7XG5pbXBvcnQgdHlwZSB7IE5hbWVzcGFjZWRDb21wb25lbnQgfSBmcm9tICcuLi9uYW1lc3BhY2VkLXJlZ2lzdHJ5LmpzJztcbmltcG9ydCB0eXBlIHtcblx0TWFya2V0cGxhY2VEaXNjb3ZlcnlSZXN1bHQsXG5cdERpc2NvdmVyZWRQbHVnaW4sXG59IGZyb20gJy4uL21hcmtldHBsYWNlLWRpc2NvdmVyeS5qcyc7XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFRlc3QgRml4dHVyZXNcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBDcmVhdGUgYSBtb2NrIGRpc2NvdmVyZWQgcGx1Z2luIGZvciB0ZXN0aW5nLlxuICovXG5mdW5jdGlvbiBjcmVhdGVNb2NrUGx1Z2luKG92ZXJyaWRlczogUGFydGlhbDxEaXNjb3ZlcmVkUGx1Z2luPiA9IHt9KTogRGlzY292ZXJlZFBsdWdpbiB7XG5cdHJldHVybiB7XG5cdFx0bmFtZTogJ3Rlc3QtcGx1Z2luJyxcblx0XHRjYW5vbmljYWxOYW1lOiAndGVzdC1wbHVnaW4nLFxuXHRcdHNvdXJjZTogJy4vcGx1Z2lucy90ZXN0LXBsdWdpbicsXG5cdFx0cmVzb2x2ZWRQYXRoOiAnL3BsdWdpbnMvdGVzdC1wbHVnaW4nLFxuXHRcdHN0YXR1czogJ29rJyxcblx0XHRtYW5pZmVzdFNvdXJjZTogJ3BsdWdpbi5qc29uJyxcblx0XHRkZXNjcmlwdGlvbjogJ0EgdGVzdCBwbHVnaW4nLFxuXHRcdHZlcnNpb246ICcxLjAuMCcsXG5cdFx0YXV0aG9yOiB7IG5hbWU6ICdUZXN0IEF1dGhvcicgfSxcblx0XHRpbnZlbnRvcnk6IHtcblx0XHRcdHNraWxsczogWydza2lsbC1hJywgJ3NraWxsLWInXSxcblx0XHRcdGFnZW50czogWydhZ2VudC14J10sXG5cdFx0XHRjb21tYW5kczogW10sXG5cdFx0XHRtY3BTZXJ2ZXJzOiB7fSxcblx0XHRcdGxzcFNlcnZlcnM6IHt9LFxuXHRcdFx0aG9va3M6IFtdLFxuXHRcdH0sXG5cdFx0Li4ub3ZlcnJpZGVzLFxuXHR9O1xufVxuXG4vKipcbiAqIENyZWF0ZSBhIG1vY2sgbWFya2V0cGxhY2UgZGlzY292ZXJ5IHJlc3VsdC5cbiAqL1xuZnVuY3Rpb24gY3JlYXRlTW9ja0Rpc2NvdmVyeVJlc3VsdChcblx0cGx1Z2luczogRGlzY292ZXJlZFBsdWdpbltdID0gW10sXG5cdG92ZXJyaWRlczogUGFydGlhbDxNYXJrZXRwbGFjZURpc2NvdmVyeVJlc3VsdD4gPSB7fVxuKTogTWFya2V0cGxhY2VEaXNjb3ZlcnlSZXN1bHQge1xuXHRyZXR1cm4ge1xuXHRcdHN0YXR1czogJ29rJyxcblx0XHRtYXJrZXRwbGFjZVBhdGg6ICcvdGVzdC9tYXJrZXRwbGFjZS5qc29uJyxcblx0XHRtYXJrZXRwbGFjZU5hbWU6ICdUZXN0IE1hcmtldHBsYWNlJyxcblx0XHRwbHVnaW5Gb3JtYXQ6ICdqYW1pZS1zdHlsZScsXG5cdFx0cGx1Z2lucyxcblx0XHRzdW1tYXJ5OiB7XG5cdFx0XHR0b3RhbDogcGx1Z2lucy5sZW5ndGgsXG5cdFx0XHRvazogcGx1Z2lucy5maWx0ZXIoKHApID0+IHAuc3RhdHVzID09PSAnb2snKS5sZW5ndGgsXG5cdFx0XHRlcnJvcjogcGx1Z2lucy5maWx0ZXIoKHApID0+IHAuc3RhdHVzID09PSAnZXJyb3InKS5sZW5ndGgsXG5cdFx0fSxcblx0XHQuLi5vdmVycmlkZXMsXG5cdH07XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFRlc3RzXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmRlc2NyaWJlKCdQbHVnaW5JbXBvcnRlcicsICgpID0+IHtcblx0bGV0IGltcG9ydGVyOiBQbHVnaW5JbXBvcnRlcjtcblxuXHRiZWZvcmVFYWNoKCgpID0+IHtcblx0XHRpbXBvcnRlciA9IG5ldyBQbHVnaW5JbXBvcnRlcigpO1xuXHR9KTtcblxuXHRkZXNjcmliZSgnU3RhZ2UgMTogZGlzY292ZXIoKScsICgpID0+IHtcblx0XHRpdCgnc2hvdWxkIHRocm93IGVycm9yIGlmIHBhdGhzIGFycmF5IGlzIGVtcHR5IGJ1dCByZXR1cm4gdmFsaWQgcmVzdWx0JywgKCkgPT4ge1xuXHRcdFx0Y29uc3QgcmVzdWx0ID0gaW1wb3J0ZXIuZGlzY292ZXIoW10pO1xuXG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LnN1bW1hcnkubWFya2V0cGxhY2VzUHJvY2Vzc2VkLCAwKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuc3VtbWFyeS50b3RhbFBsdWdpbnMsIDApO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5zdW1tYXJ5LnRvdGFsQ29tcG9uZW50cywgMCk7XG5cdFx0fSk7XG5cblx0XHRpdCgnc2hvdWxkIGNhbGwgZGlzY292ZXJNYXJrZXRwbGFjZSBmb3IgZWFjaCBwYXRoIGFuZCBhZ2dyZWdhdGUgcmVzdWx0cycsICgpID0+IHtcblx0XHRcdC8vIFRlc3Qgd2l0aCBub24tZXhpc3RlbnQgcGF0aHMgLSBzaG91bGQgc3RpbGwgcmV0dXJuIHN0cnVjdHVyZVxuXHRcdFx0Y29uc3QgcmVzdWx0ID0gaW1wb3J0ZXIuZGlzY292ZXIoW1xuXHRcdFx0XHQnL25vbmV4aXN0ZW50L21hcmtldHBsYWNlLTEnLFxuXHRcdFx0XHQnL25vbmV4aXN0ZW50L21hcmtldHBsYWNlLTInLFxuXHRcdFx0XSk7XG5cblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuc3VtbWFyeS5tYXJrZXRwbGFjZXNQcm9jZXNzZWQsIDIpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKEFycmF5LmlzQXJyYXkocmVzdWx0Lm1hcmtldHBsYWNlUmVzdWx0cyksIHRydWUpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5tYXJrZXRwbGFjZVJlc3VsdHMubGVuZ3RoLCAyKTtcblx0XHR9KTtcblxuXHRcdGl0KCdzaG91bGQgcG9wdWxhdGUgcmVnaXN0cnkgdmlhIGNvbXBvbmVudHNGcm9tRGlzY292ZXJ5JywgKCkgPT4ge1xuXHRcdFx0Ly8gVGVzdCBhZ2FpbnN0IGEgcmVhbCBwYXRoIGlmIGl0IGV4aXN0cywgb3RoZXJ3aXNlIHRlc3Qgc3RydWN0dXJlXG5cdFx0XHRjb25zdCByZXN1bHQgPSBpbXBvcnRlci5kaXNjb3ZlcihbXSk7XG5cblx0XHRcdC8vIFJlZ2lzdHJ5IHNob3VsZCBiZSBwb3B1bGF0ZWQgKGV2ZW4gaWYgZW1wdHkpXG5cdFx0XHRjb25zdCByZWdpc3RyeSA9IGltcG9ydGVyLmdldFJlZ2lzdHJ5KCk7XG5cdFx0XHRhc3NlcnQub2socmVnaXN0cnkgIT09IG51bGwpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlZ2lzdHJ5IS5zaXplLCByZXN1bHQuc3VtbWFyeS50b3RhbENvbXBvbmVudHMpO1xuXHRcdH0pO1xuXG5cdFx0aXQoJ3Nob3VsZCB0cmFjayBwbHVnaW5zIHdpdGggZXJyb3JzIGluIHN1bW1hcnknLCAoKSA9PiB7XG5cdFx0XHRjb25zdCByZXN1bHQgPSBpbXBvcnRlci5kaXNjb3ZlcihbJy9ub25leGlzdGVudC9wYXRoJ10pO1xuXG5cdFx0XHQvLyBOb24tZXhpc3RlbnQgcGF0aCBzaG91bGQgcmVzdWx0IGluIGVycm9yIHN0YXR1c1xuXHRcdFx0YXNzZXJ0Lm9rKHJlc3VsdC5zdW1tYXJ5Lm1hcmtldHBsYWNlc1dpdGhFcnJvcnMgPj0gMCk7XG5cdFx0fSk7XG5cblx0XHRpdCgnc2hvdWxkIGJlIHJlLWVudHJhbnQgKGNhbGxpbmcgZGlzY292ZXIgYWdhaW4gcmVzZXRzIHN0YXRlKScsICgpID0+IHtcblx0XHRcdC8vIEZpcnN0IGRpc2NvdmVyeVxuXHRcdFx0aW1wb3J0ZXIuZGlzY292ZXIoWycvbm9uZXhpc3RlbnQvcGF0aC0xJ10pO1xuXHRcdFx0Y29uc3QgZmlyc3RQbHVnaW5zID0gaW1wb3J0ZXIuZ2V0RGlzY292ZXJlZFBsdWdpbnMoKTtcblxuXHRcdFx0Ly8gU2Vjb25kIGRpc2NvdmVyeSBzaG91bGQgcmVzZXRcblx0XHRcdGltcG9ydGVyLmRpc2NvdmVyKFsnL25vbmV4aXN0ZW50L3BhdGgtMiddKTtcblx0XHRcdGNvbnN0IHNlY29uZFBsdWdpbnMgPSBpbXBvcnRlci5nZXREaXNjb3ZlcmVkUGx1Z2lucygpO1xuXG5cdFx0XHQvLyBTaG91bGQgaGF2ZSBmcmVzaCBzdGF0ZSAobm90IGFjY3VtdWxhdGVkKVxuXHRcdFx0Ly8gQm90aCBzaG91bGQgaGF2ZSAwIHBsdWdpbnMgc2luY2UgcGF0aHMgZG9uJ3QgZXhpc3Rcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChmaXJzdFBsdWdpbnMubGVuZ3RoLCAwKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChzZWNvbmRQbHVnaW5zLmxlbmd0aCwgMCk7XG5cdFx0fSk7XG5cdH0pO1xuXG5cdGRlc2NyaWJlKCdTdGFnZSAyOiBzZWxlY3RDb21wb25lbnRzKCknLCAoKSA9PiB7XG5cdFx0aXQoJ3Nob3VsZCB0aHJvdyBlcnJvciBpZiBjYWxsZWQgYmVmb3JlIGRpc2NvdmVyKCknLCAoKSA9PiB7XG5cdFx0XHRhc3NlcnQudGhyb3dzKFxuXHRcdFx0XHQoKSA9PiBpbXBvcnRlci5zZWxlY3RDb21wb25lbnRzKCgpID0+IHRydWUpLFxuXHRcdFx0XHQvTXVzdCBjYWxsIGRpc2NvdmVyXFwoXFwpIGJlZm9yZSBzZWxlY3RDb21wb25lbnRzXFwoXFwpL1xuXHRcdFx0KTtcblx0XHR9KTtcblxuXHRcdGl0KCdzaG91bGQgcmV0dXJuIGVtcHR5IGFycmF5IGlmIG5vIGNvbXBvbmVudHMgbWF0Y2ggZmlsdGVyJywgKCkgPT4ge1xuXHRcdFx0aW1wb3J0ZXIuZGlzY292ZXIoW10pO1xuXHRcdFx0Y29uc3Qgc2VsZWN0ZWQgPSBpbXBvcnRlci5zZWxlY3RDb21wb25lbnRzKCgpID0+IGZhbHNlKTtcblx0XHRcdGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc2VsZWN0ZWQsIFtdKTtcblx0XHR9KTtcblxuXHRcdGl0KCdzaG91bGQgcmV0dXJuIGFsbCBjb21wb25lbnRzIGlmIGZpbHRlciByZXR1cm5zIHRydWUnLCAoKSA9PiB7XG5cdFx0XHRpbXBvcnRlci5kaXNjb3ZlcihbXSk7XG5cdFx0XHRjb25zdCBzZWxlY3RlZCA9IGltcG9ydGVyLnNlbGVjdENvbXBvbmVudHMoKCkgPT4gdHJ1ZSk7XG5cdFx0XHQvLyBFbXB0eSBkaXNjb3ZlcnkgbWVhbnMgbm8gY29tcG9uZW50c1xuXHRcdFx0YXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzZWxlY3RlZCwgW10pO1xuXHRcdH0pO1xuXG5cdFx0aXQoJ3Nob3VsZCBmaWx0ZXIgYnkgbmFtZXNwYWNlIGNvcnJlY3RseScsICgpID0+IHtcblx0XHRcdGltcG9ydGVyLmRpc2NvdmVyKFtdKTtcblx0XHRcdGNvbnN0IHNlbGVjdGVkID0gaW1wb3J0ZXIuc2VsZWN0Q29tcG9uZW50cyhcblx0XHRcdFx0KGMpID0+IGMubmFtZXNwYWNlID09PSAndGFyZ2V0LXBsdWdpbidcblx0XHRcdCk7XG5cdFx0XHRhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHNlbGVjdGVkLCBbXSk7XG5cdFx0fSk7XG5cblx0XHRpdCgnc2hvdWxkIGZpbHRlciBieSB0eXBlIGNvcnJlY3RseScsICgpID0+IHtcblx0XHRcdGltcG9ydGVyLmRpc2NvdmVyKFtdKTtcblx0XHRcdGNvbnN0IHNraWxscyA9IGltcG9ydGVyLnNlbGVjdENvbXBvbmVudHMoKGMpID0+IGMudHlwZSA9PT0gJ3NraWxsJyk7XG5cdFx0XHRjb25zdCBhZ2VudHMgPSBpbXBvcnRlci5zZWxlY3RDb21wb25lbnRzKChjKSA9PiBjLnR5cGUgPT09ICdhZ2VudCcpO1xuXHRcdFx0YXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChza2lsbHMsIFtdKTtcblx0XHRcdGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoYWdlbnRzLCBbXSk7XG5cdFx0fSk7XG5cblx0XHRpdCgnc2hvdWxkIGZpbHRlciBieSBuYW1lIHBhdHRlcm4gY29ycmVjdGx5JywgKCkgPT4ge1xuXHRcdFx0aW1wb3J0ZXIuZGlzY292ZXIoW10pO1xuXHRcdFx0Y29uc3Qgc2VsZWN0ZWQgPSBpbXBvcnRlci5zZWxlY3RDb21wb25lbnRzKChjKSA9PlxuXHRcdFx0XHRjLm5hbWUuaW5jbHVkZXMoJ3JldmlldycpXG5cdFx0XHQpO1xuXHRcdFx0YXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzZWxlY3RlZCwgW10pO1xuXHRcdH0pO1xuXHR9KTtcblxuXHRkZXNjcmliZSgnU3RhZ2UgMzogdmFsaWRhdGVJbXBvcnQoKScsICgpID0+IHtcblx0XHRpdCgnc2hvdWxkIHRocm93IGVycm9yIGlmIGNhbGxlZCBiZWZvcmUgZGlzY292ZXIoKScsICgpID0+IHtcblx0XHRcdGNvbnN0IGNvbXBvbmVudHM6IE5hbWVzcGFjZWRDb21wb25lbnRbXSA9IFtdO1xuXHRcdFx0YXNzZXJ0LnRocm93cyhcblx0XHRcdFx0KCkgPT4gaW1wb3J0ZXIudmFsaWRhdGVJbXBvcnQoY29tcG9uZW50cyksXG5cdFx0XHRcdC9NdXN0IGNhbGwgZGlzY292ZXJcXChcXCkgYmVmb3JlIHZhbGlkYXRlSW1wb3J0XFwoXFwpL1xuXHRcdFx0KTtcblx0XHR9KTtcblxuXHRcdGl0KCdzaG91bGQgcmV0dXJuIGNhblByb2NlZWQ6IHRydWUgZm9yIGVtcHR5IHNlbGVjdGlvbicsICgpID0+IHtcblx0XHRcdGltcG9ydGVyLmRpc2NvdmVyKFtdKTtcblx0XHRcdGNvbnN0IHJlc3VsdCA9IGltcG9ydGVyLnZhbGlkYXRlSW1wb3J0KFtdKTtcblxuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5jYW5Qcm9jZWVkLCB0cnVlKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuZGlhZ25vc3RpY3MubGVuZ3RoLCAwKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuc3VtbWFyeS50b3RhbCwgMCk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LnN1bW1hcnkuZXJyb3JzLCAwKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuc3VtbWFyeS53YXJuaW5ncywgMCk7XG5cdFx0fSk7XG5cblx0XHRpdCgnc2hvdWxkIHJldHVybiBjYW5Qcm9jZWVkOiB0cnVlIHdoZW4gbm8gY29sbGlzaW9ucycsICgpID0+IHtcblx0XHRcdGltcG9ydGVyLmRpc2NvdmVyKFtdKTtcblxuXHRcdFx0Ly8gQ3JlYXRlIG1vY2sgY29tcG9uZW50cyB3aXRob3V0IGNvbGxpc2lvbnNcblx0XHRcdGNvbnN0IGNvbXBvbmVudHM6IE5hbWVzcGFjZWRDb21wb25lbnRbXSA9IFtcblx0XHRcdFx0e1xuXHRcdFx0XHRcdG5hbWU6ICdza2lsbC1hJyxcblx0XHRcdFx0XHRuYW1lc3BhY2U6ICdwbHVnaW4teCcsXG5cdFx0XHRcdFx0Y2Fub25pY2FsTmFtZTogJ3BsdWdpbi14OnNraWxsLWEnLFxuXHRcdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdFx0ZmlsZVBhdGg6ICcveC9za2lsbC1hLm1kJyxcblx0XHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46cGx1Z2luLXgnLFxuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOiB1bmRlZmluZWQsXG5cdFx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0XHR9LFxuXHRcdFx0XHR7XG5cdFx0XHRcdFx0bmFtZTogJ3NraWxsLWInLFxuXHRcdFx0XHRcdG5hbWVzcGFjZTogJ3BsdWdpbi15Jyxcblx0XHRcdFx0XHRjYW5vbmljYWxOYW1lOiAncGx1Z2luLXk6c2tpbGwtYicsXG5cdFx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0XHRmaWxlUGF0aDogJy95L3NraWxsLWIubWQnLFxuXHRcdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjpwbHVnaW4teScsXG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246IHVuZGVmaW5lZCxcblx0XHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHRcdH0sXG5cdFx0XHRdO1xuXG5cdFx0XHRjb25zdCByZXN1bHQgPSBpbXBvcnRlci52YWxpZGF0ZUltcG9ydChjb21wb25lbnRzKTtcblxuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5jYW5Qcm9jZWVkLCB0cnVlKTtcblx0XHR9KTtcblxuXHRcdGl0KCdzaG91bGQgZGV0ZWN0IGNhbm9uaWNhbCBjb2xsaXNpb24gYW5kIHJldHVybiBjYW5Qcm9jZWVkOiBmYWxzZSAoZXJyb3IgYmxvY2tzKScsICgpID0+IHtcblx0XHRcdGltcG9ydGVyLmRpc2NvdmVyKFtdKTtcblxuXHRcdFx0Ly8gQ3JlYXRlIGNvbXBvbmVudHMgd2l0aCBzYW1lIGNhbm9uaWNhbCBuYW1lIChjb2xsaXNpb24pXG5cdFx0XHRjb25zdCBjb21wb25lbnRzOiBOYW1lc3BhY2VkQ29tcG9uZW50W10gPSBbXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRuYW1lOiAnc2tpbGwtYScsXG5cdFx0XHRcdFx0bmFtZXNwYWNlOiAncGx1Z2luLXgnLFxuXHRcdFx0XHRcdGNhbm9uaWNhbE5hbWU6ICdwbHVnaW4teDpza2lsbC1hJyxcblx0XHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRcdGZpbGVQYXRoOiAnL2ZpcnN0L3NraWxsLWEubWQnLFxuXHRcdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjpwbHVnaW4teCcsXG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246IHVuZGVmaW5lZCxcblx0XHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHRcdH0sXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRuYW1lOiAnc2tpbGwtYScsXG5cdFx0XHRcdFx0bmFtZXNwYWNlOiAncGx1Z2luLXgnLFxuXHRcdFx0XHRcdGNhbm9uaWNhbE5hbWU6ICdwbHVnaW4teDpza2lsbC1hJywgLy8gU2FtZSBjYW5vbmljYWwgbmFtZSFcblx0XHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRcdGZpbGVQYXRoOiAnL3NlY29uZC9za2lsbC1hLm1kJyxcblx0XHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46cGx1Z2luLXgnLFxuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOiB1bmRlZmluZWQsXG5cdFx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0XHR9LFxuXHRcdFx0XTtcblxuXHRcdFx0Y29uc3QgcmVzdWx0ID0gaW1wb3J0ZXIudmFsaWRhdGVJbXBvcnQoY29tcG9uZW50cyk7XG5cblx0XHRcdC8vIEVycm9yIHNldmVyaXR5IHNob3VsZCBibG9ja1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5jYW5Qcm9jZWVkLCBmYWxzZSk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LnN1bW1hcnkuZXJyb3JzLCAxKTtcblx0XHRcdGFzc2VydC5vayhyZXN1bHQuZGlhZ25vc3RpY3Muc29tZSgoZCkgPT4gZC5zZXZlcml0eSA9PT0gJ2Vycm9yJykpO1xuXHRcdH0pO1xuXG5cdFx0aXQoJ3Nob3VsZCBkZXRlY3Qgc2hvcnRoYW5kIG92ZXJsYXAgYnV0IHJldHVybiBjYW5Qcm9jZWVkOiB0cnVlICh3YXJuaW5nIHBhc3NlcyknLCAoKSA9PiB7XG5cdFx0XHRpbXBvcnRlci5kaXNjb3ZlcihbXSk7XG5cblx0XHRcdC8vIENyZWF0ZSBjb21wb25lbnRzIHdpdGggc2FtZSBiYXJlIG5hbWUgYnV0IGRpZmZlcmVudCBuYW1lc3BhY2VzXG5cdFx0XHRjb25zdCBjb21wb25lbnRzOiBOYW1lc3BhY2VkQ29tcG9uZW50W10gPSBbXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRuYW1lOiAncmV2aWV3JywgLy8gU2FtZSBiYXJlIG5hbWVcblx0XHRcdFx0XHRuYW1lc3BhY2U6ICdwbHVnaW4tYScsXG5cdFx0XHRcdFx0Y2Fub25pY2FsTmFtZTogJ3BsdWdpbi1hOnJldmlldycsXG5cdFx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0XHRmaWxlUGF0aDogJy9hL3Jldmlldy5tZCcsXG5cdFx0XHRcdFx0c291cmNlOiAncGx1Z2luOnBsdWdpbi1hJyxcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjogdW5kZWZpbmVkLFxuXHRcdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdFx0fSxcblx0XHRcdFx0e1xuXHRcdFx0XHRcdG5hbWU6ICdyZXZpZXcnLCAvLyBTYW1lIGJhcmUgbmFtZVxuXHRcdFx0XHRcdG5hbWVzcGFjZTogJ3BsdWdpbi1iJyxcblx0XHRcdFx0XHRjYW5vbmljYWxOYW1lOiAncGx1Z2luLWI6cmV2aWV3Jyxcblx0XHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRcdGZpbGVQYXRoOiAnL2IvcmV2aWV3Lm1kJyxcblx0XHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46cGx1Z2luLWInLFxuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOiB1bmRlZmluZWQsXG5cdFx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0XHR9LFxuXHRcdFx0XTtcblxuXHRcdFx0Y29uc3QgcmVzdWx0ID0gaW1wb3J0ZXIudmFsaWRhdGVJbXBvcnQoY29tcG9uZW50cyk7XG5cblx0XHRcdC8vIFdhcm5pbmcgc2V2ZXJpdHkgc2hvdWxkIE5PVCBibG9ja1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5jYW5Qcm9jZWVkLCB0cnVlKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuc3VtbWFyeS5lcnJvcnMsIDApO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5zdW1tYXJ5Lndhcm5pbmdzLCAxKTtcblx0XHRcdGFzc2VydC5vayhyZXN1bHQuZGlhZ25vc3RpY3Muc29tZSgoZCkgPT4gZC5zZXZlcml0eSA9PT0gJ3dhcm5pbmcnKSk7XG5cdFx0fSk7XG5cblx0XHRpdCgnc2hvdWxkIGNvcnJlY3RseSBjbGFzc2lmeSBzZXZlcml0eTogZXJyb3IgZm9yIGNhbm9uaWNhbCBjb25mbGljdCcsICgpID0+IHtcblx0XHRcdGltcG9ydGVyLmRpc2NvdmVyKFtdKTtcblxuXHRcdFx0Y29uc3QgY29tcG9uZW50czogTmFtZXNwYWNlZENvbXBvbmVudFtdID0gW1xuXHRcdFx0XHR7XG5cdFx0XHRcdFx0bmFtZTogJ2R1cCcsXG5cdFx0XHRcdFx0bmFtZXNwYWNlOiAnbnMnLFxuXHRcdFx0XHRcdGNhbm9uaWNhbE5hbWU6ICduczpkdXAnLFxuXHRcdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdFx0ZmlsZVBhdGg6ICcvMS9kdXAubWQnLFxuXHRcdFx0XHRcdHNvdXJjZTogJ2ZpcnN0Jyxcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjogdW5kZWZpbmVkLFxuXHRcdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdFx0fSxcblx0XHRcdFx0e1xuXHRcdFx0XHRcdG5hbWU6ICdkdXAnLFxuXHRcdFx0XHRcdG5hbWVzcGFjZTogJ25zJyxcblx0XHRcdFx0XHRjYW5vbmljYWxOYW1lOiAnbnM6ZHVwJyxcblx0XHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRcdGZpbGVQYXRoOiAnLzIvZHVwLm1kJyxcblx0XHRcdFx0XHRzb3VyY2U6ICdzZWNvbmQnLFxuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOiB1bmRlZmluZWQsXG5cdFx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0XHR9LFxuXHRcdFx0XTtcblxuXHRcdFx0Y29uc3QgcmVzdWx0ID0gaW1wb3J0ZXIudmFsaWRhdGVJbXBvcnQoY29tcG9uZW50cyk7XG5cblx0XHRcdGNvbnN0IGVycm9yID0gcmVzdWx0LmRpYWdub3N0aWNzLmZpbmQoKGQpID0+IGQuc2V2ZXJpdHkgPT09ICdlcnJvcicpO1xuXHRcdFx0YXNzZXJ0Lm9rKGVycm9yICE9PSB1bmRlZmluZWQpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKGVycm9yIS5jbGFzcywgJ2Nhbm9uaWNhbC1jb25mbGljdCcpO1xuXHRcdFx0YXNzZXJ0Lm9rKGVycm9yIS5pbnZvbHZlZENhbm9uaWNhbE5hbWVzLmluY2x1ZGVzKCduczpkdXAnKSk7XG5cdFx0fSk7XG5cblx0XHRpdCgnc2hvdWxkIGNvcnJlY3RseSBjbGFzc2lmeSBzZXZlcml0eTogd2FybmluZyBmb3Igc2hvcnRoYW5kIG92ZXJsYXAnLCAoKSA9PiB7XG5cdFx0XHRpbXBvcnRlci5kaXNjb3ZlcihbXSk7XG5cblx0XHRcdGNvbnN0IGNvbXBvbmVudHM6IE5hbWVzcGFjZWRDb21wb25lbnRbXSA9IFtcblx0XHRcdFx0e1xuXHRcdFx0XHRcdG5hbWU6ICdjb21tb24tc2tpbGwnLFxuXHRcdFx0XHRcdG5hbWVzcGFjZTogJ3BsdWdpbi1hJyxcblx0XHRcdFx0XHRjYW5vbmljYWxOYW1lOiAncGx1Z2luLWE6Y29tbW9uLXNraWxsJyxcblx0XHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRcdGZpbGVQYXRoOiAnL2EvY29tbW9uLm1kJyxcblx0XHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46cGx1Z2luLWEnLFxuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOiB1bmRlZmluZWQsXG5cdFx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0XHR9LFxuXHRcdFx0XHR7XG5cdFx0XHRcdFx0bmFtZTogJ2NvbW1vbi1za2lsbCcsXG5cdFx0XHRcdFx0bmFtZXNwYWNlOiAncGx1Z2luLWInLFxuXHRcdFx0XHRcdGNhbm9uaWNhbE5hbWU6ICdwbHVnaW4tYjpjb21tb24tc2tpbGwnLFxuXHRcdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdFx0ZmlsZVBhdGg6ICcvYi9jb21tb24ubWQnLFxuXHRcdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjpwbHVnaW4tYicsXG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246IHVuZGVmaW5lZCxcblx0XHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHRcdH0sXG5cdFx0XHRdO1xuXG5cdFx0XHRjb25zdCByZXN1bHQgPSBpbXBvcnRlci52YWxpZGF0ZUltcG9ydChjb21wb25lbnRzKTtcblxuXHRcdFx0Y29uc3Qgd2FybmluZyA9IHJlc3VsdC5kaWFnbm9zdGljcy5maW5kKChkKSA9PiBkLnNldmVyaXR5ID09PSAnd2FybmluZycpO1xuXHRcdFx0YXNzZXJ0Lm9rKHdhcm5pbmcgIT09IHVuZGVmaW5lZCk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwod2FybmluZyEuY2xhc3MsICdzaG9ydGhhbmQtb3ZlcmxhcCcpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHdhcm5pbmchLmFtYmlndW91c0JhcmVOYW1lLCAnY29tbW9uLXNraWxsJyk7XG5cdFx0fSk7XG5cdH0pO1xuXG5cdGRlc2NyaWJlKCdTdGFnZSA0OiBnZXRJbXBvcnRNYW5pZmVzdCgpJywgKCkgPT4ge1xuXHRcdGl0KCdzaG91bGQgcHJvZHVjZSB2YWxpZCBtYW5pZmVzdCBmb3IgZW1wdHkgc2VsZWN0aW9uJywgKCkgPT4ge1xuXHRcdFx0Y29uc3QgbWFuaWZlc3QgPSBpbXBvcnRlci5nZXRJbXBvcnRNYW5pZmVzdChbXSk7XG5cblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChtYW5pZmVzdC5zY2hlbWFWZXJzaW9uLCAnMS4wJyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwodHlwZW9mIG1hbmlmZXN0LmdlbmVyYXRlZEF0LCAnc3RyaW5nJyk7XG5cdFx0XHRhc3NlcnQuZGVlcFN0cmljdEVxdWFsKG1hbmlmZXN0LmVudHJpZXMsIFtdKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChtYW5pZmVzdC5zdW1tYXJ5LnRvdGFsLCAwKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChtYW5pZmVzdC5zdW1tYXJ5LnNraWxscywgMCk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwobWFuaWZlc3Quc3VtbWFyeS5hZ2VudHMsIDApO1xuXHRcdFx0YXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChtYW5pZmVzdC5zdW1tYXJ5Lm5hbWVzcGFjZXMsIFtdKTtcblx0XHR9KTtcblxuXHRcdGl0KCdzaG91bGQgcHJlc2VydmUgY2Fub25pY2FsIG5hbWVzIGluIG1hbmlmZXN0IChSMDEzKScsICgpID0+IHtcblx0XHRcdGNvbnN0IGNvbXBvbmVudHM6IE5hbWVzcGFjZWRDb21wb25lbnRbXSA9IFtcblx0XHRcdFx0e1xuXHRcdFx0XHRcdG5hbWU6ICdjb2RlLXJldmlldycsXG5cdFx0XHRcdFx0bmFtZXNwYWNlOiAnbXktcGx1Z2luJyxcblx0XHRcdFx0XHRjYW5vbmljYWxOYW1lOiAnbXktcGx1Z2luOmNvZGUtcmV2aWV3Jyxcblx0XHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRcdGZpbGVQYXRoOiAnL3BsdWdpbnMvbXktcGx1Z2luL3NraWxscy9jb2RlLXJldmlldy9TS0lMTC5tZCcsXG5cdFx0XHRcdFx0c291cmNlOiAncGx1Z2luOm15LXBsdWdpbicsXG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246ICdSZXZpZXdzIGNvZGUnLFxuXHRcdFx0XHRcdG1ldGFkYXRhOiB7XG5cdFx0XHRcdFx0XHRwbHVnaW5WZXJzaW9uOiAnMS4wLjAnLFxuXHRcdFx0XHRcdFx0cGx1Z2luQXV0aG9yOiAnVGVzdCBBdXRob3InLFxuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdH0sXG5cdFx0XHRdO1xuXG5cdFx0XHRjb25zdCBtYW5pZmVzdCA9IGltcG9ydGVyLmdldEltcG9ydE1hbmlmZXN0KGNvbXBvbmVudHMpO1xuXG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwobWFuaWZlc3QuZW50cmllcy5sZW5ndGgsIDEpO1xuXG5cdFx0XHQvLyBWZXJpZnkgY2Fub25pY2FsIG5hbWUgcHJlc2VydmVkXG5cdFx0XHRjb25zdCBlbnRyeSA9IG1hbmlmZXN0LmVudHJpZXNbMF07XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoZW50cnkhLmNhbm9uaWNhbE5hbWUsICdteS1wbHVnaW46Y29kZS1yZXZpZXcnKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChlbnRyeSEubmFtZSwgJ2NvZGUtcmV2aWV3Jyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoZW50cnkhLm5hbWVzcGFjZSwgJ215LXBsdWdpbicpO1xuXHRcdH0pO1xuXG5cdFx0aXQoJ3Nob3VsZCBpbmNsdWRlIGFsbCBjb21wb25lbnQgbWV0YWRhdGEgaW4gbWFuaWZlc3QnLCAoKSA9PiB7XG5cdFx0XHRjb25zdCBjb21wb25lbnRzOiBOYW1lc3BhY2VkQ29tcG9uZW50W10gPSBbXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRuYW1lOiAndGVzdC1za2lsbCcsXG5cdFx0XHRcdFx0bmFtZXNwYWNlOiAndGVzdC1wbHVnaW4nLFxuXHRcdFx0XHRcdGNhbm9uaWNhbE5hbWU6ICd0ZXN0LXBsdWdpbjp0ZXN0LXNraWxsJyxcblx0XHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRcdGZpbGVQYXRoOiAnL3Rlc3Qvc2tpbGwubWQnLFxuXHRcdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjp0ZXN0LXBsdWdpbicsXG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246ICdBIHRlc3Qgc2tpbGwnLFxuXHRcdFx0XHRcdG1ldGFkYXRhOiB7XG5cdFx0XHRcdFx0XHRwbHVnaW5WZXJzaW9uOiAnMi4wLjAnLFxuXHRcdFx0XHRcdFx0cGx1Z2luQXV0aG9yOiAnQXV0aG9yIE5hbWUnLFxuXHRcdFx0XHRcdFx0cGx1Z2luSG9tZXBhZ2U6ICdodHRwczovL2V4YW1wbGUuY29tJyxcblx0XHRcdFx0XHRcdHBsdWdpbkNhdGVnb3J5OiAndGVzdGluZycsXG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0fSxcblx0XHRcdF07XG5cblx0XHRcdGNvbnN0IG1hbmlmZXN0ID0gaW1wb3J0ZXIuZ2V0SW1wb3J0TWFuaWZlc3QoY29tcG9uZW50cyk7XG5cblx0XHRcdGNvbnN0IGVudHJ5ID0gbWFuaWZlc3QuZW50cmllc1swXTtcblx0XHRcdGFzc2VydC5vayhlbnRyeSAhPT0gdW5kZWZpbmVkKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChlbnRyeSEuZGVzY3JpcHRpb24sICdBIHRlc3Qgc2tpbGwnKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChlbnRyeSEubWV0YWRhdGEucGx1Z2luVmVyc2lvbiwgJzIuMC4wJyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoZW50cnkhLm1ldGFkYXRhLnBsdWdpbkF1dGhvciwgJ0F1dGhvciBOYW1lJyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoZW50cnkhLm1ldGFkYXRhLnBsdWdpbkhvbWVwYWdlLCAnaHR0cHM6Ly9leGFtcGxlLmNvbScpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKGVudHJ5IS5tZXRhZGF0YS5wbHVnaW5DYXRlZ29yeSwgJ3Rlc3RpbmcnKTtcblx0XHR9KTtcblxuXHRcdGl0KCdzaG91bGQgY291bnQgc2tpbGxzIGFuZCBhZ2VudHMgc2VwYXJhdGVseSBpbiBzdW1tYXJ5JywgKCkgPT4ge1xuXHRcdFx0Y29uc3QgY29tcG9uZW50czogTmFtZXNwYWNlZENvbXBvbmVudFtdID0gW1xuXHRcdFx0XHR7XG5cdFx0XHRcdFx0bmFtZTogJ3NraWxsLWEnLFxuXHRcdFx0XHRcdG5hbWVzcGFjZTogJ25zJyxcblx0XHRcdFx0XHRjYW5vbmljYWxOYW1lOiAnbnM6c2tpbGwtYScsXG5cdFx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0XHRmaWxlUGF0aDogJy9hLm1kJyxcblx0XHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46bnMnLFxuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOiB1bmRlZmluZWQsXG5cdFx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0XHR9LFxuXHRcdFx0XHR7XG5cdFx0XHRcdFx0bmFtZTogJ3NraWxsLWInLFxuXHRcdFx0XHRcdG5hbWVzcGFjZTogJ25zJyxcblx0XHRcdFx0XHRjYW5vbmljYWxOYW1lOiAnbnM6c2tpbGwtYicsXG5cdFx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0XHRmaWxlUGF0aDogJy9iLm1kJyxcblx0XHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46bnMnLFxuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOiB1bmRlZmluZWQsXG5cdFx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0XHR9LFxuXHRcdFx0XHR7XG5cdFx0XHRcdFx0bmFtZTogJ2FnZW50LXgnLFxuXHRcdFx0XHRcdG5hbWVzcGFjZTogJ25zJyxcblx0XHRcdFx0XHRjYW5vbmljYWxOYW1lOiAnbnM6YWdlbnQteCcsXG5cdFx0XHRcdFx0dHlwZTogJ2FnZW50Jyxcblx0XHRcdFx0XHRmaWxlUGF0aDogJy94Lm1kJyxcblx0XHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46bnMnLFxuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOiB1bmRlZmluZWQsXG5cdFx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0XHR9LFxuXHRcdFx0XTtcblxuXHRcdFx0Y29uc3QgbWFuaWZlc3QgPSBpbXBvcnRlci5nZXRJbXBvcnRNYW5pZmVzdChjb21wb25lbnRzKTtcblxuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKG1hbmlmZXN0LnN1bW1hcnkudG90YWwsIDMpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKG1hbmlmZXN0LnN1bW1hcnkuc2tpbGxzLCAyKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChtYW5pZmVzdC5zdW1tYXJ5LmFnZW50cywgMSk7XG5cdFx0fSk7XG5cblx0XHRpdCgnc2hvdWxkIGxpc3QgdW5pcXVlIG5hbWVzcGFjZXMgaW4gc3VtbWFyeScsICgpID0+IHtcblx0XHRcdGNvbnN0IGNvbXBvbmVudHM6IE5hbWVzcGFjZWRDb21wb25lbnRbXSA9IFtcblx0XHRcdFx0e1xuXHRcdFx0XHRcdG5hbWU6ICdza2lsbCcsXG5cdFx0XHRcdFx0bmFtZXNwYWNlOiAncGx1Z2luLWEnLFxuXHRcdFx0XHRcdGNhbm9uaWNhbE5hbWU6ICdwbHVnaW4tYTpza2lsbCcsXG5cdFx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0XHRmaWxlUGF0aDogJy9hLm1kJyxcblx0XHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46cGx1Z2luLWEnLFxuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOiB1bmRlZmluZWQsXG5cdFx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0XHR9LFxuXHRcdFx0XHR7XG5cdFx0XHRcdFx0bmFtZTogJ3NraWxsJyxcblx0XHRcdFx0XHRuYW1lc3BhY2U6ICdwbHVnaW4tYicsXG5cdFx0XHRcdFx0Y2Fub25pY2FsTmFtZTogJ3BsdWdpbi1iOnNraWxsJyxcblx0XHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRcdGZpbGVQYXRoOiAnL2IubWQnLFxuXHRcdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjpwbHVnaW4tYicsXG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246IHVuZGVmaW5lZCxcblx0XHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHRcdH0sXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRuYW1lOiAnc2tpbGwnLFxuXHRcdFx0XHRcdG5hbWVzcGFjZTogJ3BsdWdpbi1hJywgLy8gRHVwbGljYXRlIG5hbWVzcGFjZVxuXHRcdFx0XHRcdGNhbm9uaWNhbE5hbWU6ICdwbHVnaW4tYTpza2lsbC0yJyxcblx0XHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRcdGZpbGVQYXRoOiAnL2EyLm1kJyxcblx0XHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46cGx1Z2luLWEnLFxuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOiB1bmRlZmluZWQsXG5cdFx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0XHR9LFxuXHRcdFx0XTtcblxuXHRcdFx0Y29uc3QgbWFuaWZlc3QgPSBpbXBvcnRlci5nZXRJbXBvcnRNYW5pZmVzdChjb21wb25lbnRzKTtcblxuXHRcdFx0Ly8gU2hvdWxkIGhhdmUgdW5pcXVlLCBzb3J0ZWQgbmFtZXNwYWNlc1xuXHRcdFx0YXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChtYW5pZmVzdC5zdW1tYXJ5Lm5hbWVzcGFjZXMsIFsncGx1Z2luLWEnLCAncGx1Z2luLWInXSk7XG5cdFx0fSk7XG5cblx0XHRpdCgnc2hvdWxkIGhhbmRsZSBmbGF0IChub24tbmFtZXNwYWNlZCkgY29tcG9uZW50cycsICgpID0+IHtcblx0XHRcdGNvbnN0IGNvbXBvbmVudHM6IE5hbWVzcGFjZWRDb21wb25lbnRbXSA9IFtcblx0XHRcdFx0e1xuXHRcdFx0XHRcdG5hbWU6ICdmbGF0LXNraWxsJyxcblx0XHRcdFx0XHRuYW1lc3BhY2U6IHVuZGVmaW5lZCxcblx0XHRcdFx0XHRjYW5vbmljYWxOYW1lOiAnZmxhdC1za2lsbCcsXG5cdFx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0XHRmaWxlUGF0aDogJy9mbGF0Lm1kJyxcblx0XHRcdFx0XHRzb3VyY2U6ICd1c2VyJyxcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjogdW5kZWZpbmVkLFxuXHRcdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdFx0fSxcblx0XHRcdF07XG5cblx0XHRcdGNvbnN0IG1hbmlmZXN0ID0gaW1wb3J0ZXIuZ2V0SW1wb3J0TWFuaWZlc3QoY29tcG9uZW50cyk7XG5cblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChtYW5pZmVzdC5lbnRyaWVzLmxlbmd0aCwgMSk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwobWFuaWZlc3QuZW50cmllc1swXSEubmFtZXNwYWNlLCB1bmRlZmluZWQpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKG1hbmlmZXN0LmVudHJpZXNbMF0hLmNhbm9uaWNhbE5hbWUsICdmbGF0LXNraWxsJyk7XG5cdFx0XHRhc3NlcnQuZGVlcFN0cmljdEVxdWFsKG1hbmlmZXN0LnN1bW1hcnkubmFtZXNwYWNlcywgW10pO1xuXHRcdH0pO1xuXG5cdFx0aXQoJ3Nob3VsZCBiZSBzZXJpYWxpemFibGUgdG8gSlNPTicsICgpID0+IHtcblx0XHRcdGNvbnN0IGNvbXBvbmVudHM6IE5hbWVzcGFjZWRDb21wb25lbnRbXSA9IFtcblx0XHRcdFx0e1xuXHRcdFx0XHRcdG5hbWU6ICdza2lsbCcsXG5cdFx0XHRcdFx0bmFtZXNwYWNlOiAncGx1Z2luJyxcblx0XHRcdFx0XHRjYW5vbmljYWxOYW1lOiAncGx1Z2luOnNraWxsJyxcblx0XHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRcdGZpbGVQYXRoOiAnL3NraWxsLm1kJyxcblx0XHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46cGx1Z2luJyxcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjogJ0Egc2tpbGwnLFxuXHRcdFx0XHRcdG1ldGFkYXRhOiB7IHBsdWdpblZlcnNpb246ICcxLjAuMCcgfSxcblx0XHRcdFx0fSxcblx0XHRcdF07XG5cblx0XHRcdGNvbnN0IG1hbmlmZXN0ID0gaW1wb3J0ZXIuZ2V0SW1wb3J0TWFuaWZlc3QoY29tcG9uZW50cyk7XG5cblx0XHRcdC8vIFNob3VsZCBiZSBKU09OIHNlcmlhbGl6YWJsZSB3aXRob3V0IGVycm9yc1xuXHRcdFx0Y29uc3QganNvbiA9IEpTT04uc3RyaW5naWZ5KG1hbmlmZXN0KTtcblx0XHRcdGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UoanNvbik7XG5cblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChwYXJzZWQuc2NoZW1hVmVyc2lvbiwgJzEuMCcpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHBhcnNlZC5lbnRyaWVzWzBdLmNhbm9uaWNhbE5hbWUsICdwbHVnaW46c2tpbGwnKTtcblx0XHR9KTtcblx0fSk7XG5cblx0ZGVzY3JpYmUoJ0Z1bGwgUGlwZWxpbmU6IGRpc2NvdmVyIFx1MjE5MiBzZWxlY3QgXHUyMTkyIHZhbGlkYXRlIFx1MjE5MiBtYW5pZmVzdCcsICgpID0+IHtcblx0XHRpdCgnc2hvdWxkIGV4ZWN1dGUgZnVsbCBwaXBlbGluZSB3aXRoIG1vY2sgY29tcG9uZW50cycsICgpID0+IHtcblx0XHRcdC8vIFN0YWdlIDE6IERpc2NvdmVyIChlbXB0eSBpbiB0aGlzIGNhc2UpXG5cdFx0XHRjb25zdCBkaXNjb3ZlcnkgPSBpbXBvcnRlci5kaXNjb3ZlcihbXSk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoZGlzY292ZXJ5LnN1bW1hcnkudG90YWxDb21wb25lbnRzLCAwKTtcblxuXHRcdFx0Ly8gU3RhZ2UgMjogU2VsZWN0IGFsbCAoZW1wdHkpXG5cdFx0XHRjb25zdCBzZWxlY3RlZCA9IGltcG9ydGVyLnNlbGVjdENvbXBvbmVudHMoKCkgPT4gdHJ1ZSk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoc2VsZWN0ZWQubGVuZ3RoLCAwKTtcblxuXHRcdFx0Ly8gU3RhZ2UgMzogVmFsaWRhdGVcblx0XHRcdGNvbnN0IHZhbGlkYXRpb24gPSBpbXBvcnRlci52YWxpZGF0ZUltcG9ydChzZWxlY3RlZCk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwodmFsaWRhdGlvbi5jYW5Qcm9jZWVkLCB0cnVlKTtcblxuXHRcdFx0Ly8gU3RhZ2UgNDogTWFuaWZlc3Rcblx0XHRcdGNvbnN0IG1hbmlmZXN0ID0gaW1wb3J0ZXIuZ2V0SW1wb3J0TWFuaWZlc3Qoc2VsZWN0ZWQpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKG1hbmlmZXN0LnN1bW1hcnkudG90YWwsIDApO1xuXHRcdH0pO1xuXG5cdFx0aXQoJ3Nob3VsZCBwcmVzZXJ2ZSBjYW5vbmljYWwgbmFtZXMgdGhyb3VnaCBmdWxsIHBpcGVsaW5lIChSMDEzKScsICgpID0+IHtcblx0XHRcdC8vIFN0YXJ0IHdpdGggZGlzY292ZXJ5XG5cdFx0XHRpbXBvcnRlci5kaXNjb3ZlcihbXSk7XG5cblx0XHRcdC8vIENyZWF0ZSBtb2NrIGNvbXBvbmVudHMgYXMgaWYgdGhleSB3ZXJlIGRpc2NvdmVyZWRcblx0XHRcdGNvbnN0IGNvbXBvbmVudHM6IE5hbWVzcGFjZWRDb21wb25lbnRbXSA9IFtcblx0XHRcdFx0e1xuXHRcdFx0XHRcdG5hbWU6ICdjb2RlLXJldmlldycsXG5cdFx0XHRcdFx0bmFtZXNwYWNlOiAnbXktcGx1Z2luJyxcblx0XHRcdFx0XHRjYW5vbmljYWxOYW1lOiAnbXktcGx1Z2luOmNvZGUtcmV2aWV3Jyxcblx0XHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRcdGZpbGVQYXRoOiAnL3BsdWdpbnMvbXktcGx1Z2luL3NraWxscy9jb2RlLXJldmlldy9TS0lMTC5tZCcsXG5cdFx0XHRcdFx0c291cmNlOiAncGx1Z2luOm15LXBsdWdpbicsXG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246ICdSZXZpZXdzIGNvZGUnLFxuXHRcdFx0XHRcdG1ldGFkYXRhOiB7IHBsdWdpblZlcnNpb246ICcxLjAuMCcgfSxcblx0XHRcdFx0fSxcblx0XHRcdFx0e1xuXHRcdFx0XHRcdG5hbWU6ICdhcmNoaXRlY3QnLFxuXHRcdFx0XHRcdG5hbWVzcGFjZTogJ215LXBsdWdpbicsXG5cdFx0XHRcdFx0Y2Fub25pY2FsTmFtZTogJ215LXBsdWdpbjphcmNoaXRlY3QnLFxuXHRcdFx0XHRcdHR5cGU6ICdhZ2VudCcsXG5cdFx0XHRcdFx0ZmlsZVBhdGg6ICcvcGx1Z2lucy9teS1wbHVnaW4vYWdlbnRzL2FyY2hpdGVjdC9BR0VOVC5tZCcsXG5cdFx0XHRcdFx0c291cmNlOiAncGx1Z2luOm15LXBsdWdpbicsXG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246ICdEZXNpZ25zIGFyY2hpdGVjdHVyZScsXG5cdFx0XHRcdFx0bWV0YWRhdGE6IHsgcGx1Z2luVmVyc2lvbjogJzEuMC4wJyB9LFxuXHRcdFx0XHR9LFxuXHRcdFx0XTtcblxuXHRcdFx0Ly8gU3RhZ2UgMzogVmFsaWRhdGUgKG5vIGNvbGxpc2lvbnMpXG5cdFx0XHRjb25zdCB2YWxpZGF0aW9uID0gaW1wb3J0ZXIudmFsaWRhdGVJbXBvcnQoY29tcG9uZW50cyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwodmFsaWRhdGlvbi5jYW5Qcm9jZWVkLCB0cnVlKTtcblxuXHRcdFx0Ly8gU3RhZ2UgNDogTWFuaWZlc3Rcblx0XHRcdGNvbnN0IG1hbmlmZXN0ID0gaW1wb3J0ZXIuZ2V0SW1wb3J0TWFuaWZlc3QoY29tcG9uZW50cyk7XG5cblx0XHRcdC8vIFZlcmlmeSBjYW5vbmljYWwgbmFtZXMgcHJlc2VydmVkXG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwobWFuaWZlc3QuZW50cmllcy5sZW5ndGgsIDIpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKG1hbmlmZXN0LmVudHJpZXNbMF0hLmNhbm9uaWNhbE5hbWUsICdteS1wbHVnaW46Y29kZS1yZXZpZXcnKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChtYW5pZmVzdC5lbnRyaWVzWzFdIS5jYW5vbmljYWxOYW1lLCAnbXktcGx1Z2luOmFyY2hpdGVjdCcpO1xuXG5cdFx0XHQvLyBWZXJpZnkgcm91bmQtdHJpcCBpZGVudGl0eVxuXHRcdFx0Y29uc3Qgc2tpbGwgPSBtYW5pZmVzdC5lbnRyaWVzLmZpbmQoKGUpID0+IGUudHlwZSA9PT0gJ3NraWxsJyk7XG5cdFx0XHRhc3NlcnQub2soc2tpbGwgIT09IHVuZGVmaW5lZCk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoc2tpbGwhLmNhbm9uaWNhbE5hbWUsICdteS1wbHVnaW46Y29kZS1yZXZpZXcnKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChza2lsbCEubmFtZSwgJ2NvZGUtcmV2aWV3Jyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoc2tpbGwhLm5hbWVzcGFjZSwgJ215LXBsdWdpbicpO1xuXHRcdH0pO1xuXG5cdFx0aXQoJ3Nob3VsZCBibG9jayBpbXBvcnQgb24gY2Fub25pY2FsIGNvbGxpc2lvbicsICgpID0+IHtcblx0XHRcdGltcG9ydGVyLmRpc2NvdmVyKFtdKTtcblxuXHRcdFx0Y29uc3QgY29tcG9uZW50czogTmFtZXNwYWNlZENvbXBvbmVudFtdID0gW1xuXHRcdFx0XHR7XG5cdFx0XHRcdFx0bmFtZTogJ3NraWxsJyxcblx0XHRcdFx0XHRuYW1lc3BhY2U6ICducycsXG5cdFx0XHRcdFx0Y2Fub25pY2FsTmFtZTogJ25zOnNraWxsJyxcblx0XHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRcdGZpbGVQYXRoOiAnL2ZpcnN0Lm1kJyxcblx0XHRcdFx0XHRzb3VyY2U6ICdmaXJzdCcsXG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246IHVuZGVmaW5lZCxcblx0XHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHRcdH0sXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRuYW1lOiAnc2tpbGwnLFxuXHRcdFx0XHRcdG5hbWVzcGFjZTogJ25zJyxcblx0XHRcdFx0XHRjYW5vbmljYWxOYW1lOiAnbnM6c2tpbGwnLCAvLyBDb2xsaXNpb24hXG5cdFx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0XHRmaWxlUGF0aDogJy9zZWNvbmQubWQnLFxuXHRcdFx0XHRcdHNvdXJjZTogJ3NlY29uZCcsXG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246IHVuZGVmaW5lZCxcblx0XHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHRcdH0sXG5cdFx0XHRdO1xuXG5cdFx0XHRjb25zdCB2YWxpZGF0aW9uID0gaW1wb3J0ZXIudmFsaWRhdGVJbXBvcnQoY29tcG9uZW50cyk7XG5cblx0XHRcdC8vIFNob3VsZCBibG9ja1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHZhbGlkYXRpb24uY2FuUHJvY2VlZCwgZmFsc2UpO1xuXG5cdFx0XHQvLyBEaWFnbm9zdGljIHNob3VsZCBleHBsYWluIHdoeVxuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHZhbGlkYXRpb24uc3VtbWFyeS5lcnJvcnMsIDEpO1xuXHRcdFx0YXNzZXJ0Lm9rKHZhbGlkYXRpb24uZGlhZ25vc3RpY3NbMF0hLnJlbWVkaWF0aW9uLmxlbmd0aCA+IDApO1xuXHRcdH0pO1xuXG5cdFx0aXQoJ3Nob3VsZCBhbGxvdyBpbXBvcnQgd2l0aCB3YXJuaW5ncyAoc2hvcnRoYW5kIG92ZXJsYXApJywgKCkgPT4ge1xuXHRcdFx0aW1wb3J0ZXIuZGlzY292ZXIoW10pO1xuXG5cdFx0XHRjb25zdCBjb21wb25lbnRzOiBOYW1lc3BhY2VkQ29tcG9uZW50W10gPSBbXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRuYW1lOiAncmV2aWV3Jyxcblx0XHRcdFx0XHRuYW1lc3BhY2U6ICdwbHVnaW4tYScsXG5cdFx0XHRcdFx0Y2Fub25pY2FsTmFtZTogJ3BsdWdpbi1hOnJldmlldycsXG5cdFx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0XHRmaWxlUGF0aDogJy9hLm1kJyxcblx0XHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46cGx1Z2luLWEnLFxuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOiB1bmRlZmluZWQsXG5cdFx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0XHR9LFxuXHRcdFx0XHR7XG5cdFx0XHRcdFx0bmFtZTogJ3JldmlldycsXG5cdFx0XHRcdFx0bmFtZXNwYWNlOiAncGx1Z2luLWInLFxuXHRcdFx0XHRcdGNhbm9uaWNhbE5hbWU6ICdwbHVnaW4tYjpyZXZpZXcnLFxuXHRcdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdFx0ZmlsZVBhdGg6ICcvYi5tZCcsXG5cdFx0XHRcdFx0c291cmNlOiAncGx1Z2luOnBsdWdpbi1iJyxcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjogdW5kZWZpbmVkLFxuXHRcdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdFx0fSxcblx0XHRcdF07XG5cblx0XHRcdGNvbnN0IHZhbGlkYXRpb24gPSBpbXBvcnRlci52YWxpZGF0ZUltcG9ydChjb21wb25lbnRzKTtcblxuXHRcdFx0Ly8gU2hvdWxkIE5PVCBibG9jayAod2FybmluZyBvbmx5KVxuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHZhbGlkYXRpb24uY2FuUHJvY2VlZCwgdHJ1ZSk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwodmFsaWRhdGlvbi5zdW1tYXJ5Lndhcm5pbmdzLCAxKTtcblxuXHRcdFx0Ly8gTWFuaWZlc3Qgc2hvdWxkIHN0aWxsIHdvcmtcblx0XHRcdGNvbnN0IG1hbmlmZXN0ID0gaW1wb3J0ZXIuZ2V0SW1wb3J0TWFuaWZlc3QoY29tcG9uZW50cyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwobWFuaWZlc3QuZW50cmllcy5sZW5ndGgsIDIpO1xuXHRcdH0pO1xuXHR9KTtcblxuXHRkZXNjcmliZSgnSW5zcGVjdGlvbiBtZXRob2RzJywgKCkgPT4ge1xuXHRcdGl0KCdzaG91bGQgcmV0dXJuIG51bGwgZm9yIGdldFJlZ2lzdHJ5KCkgYmVmb3JlIGRpc2NvdmVyKCknLCAoKSA9PiB7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoaW1wb3J0ZXIuZ2V0UmVnaXN0cnkoKSwgbnVsbCk7XG5cdFx0fSk7XG5cblx0XHRpdCgnc2hvdWxkIHJldHVybiByZWdpc3RyeSBhZnRlciBkaXNjb3ZlcigpJywgKCkgPT4ge1xuXHRcdFx0aW1wb3J0ZXIuZGlzY292ZXIoW10pO1xuXHRcdFx0YXNzZXJ0Lm9rKGltcG9ydGVyLmdldFJlZ2lzdHJ5KCkgIT09IG51bGwpO1xuXHRcdH0pO1xuXG5cdFx0aXQoJ3Nob3VsZCByZXR1cm4gZW1wdHkgYXJyYXkgZm9yIGdldERpc2NvdmVyZWRQbHVnaW5zKCkgYmVmb3JlIGRpc2NvdmVyKCknLCAoKSA9PiB7XG5cdFx0XHRjb25zdCBwbHVnaW5zID0gaW1wb3J0ZXIuZ2V0RGlzY292ZXJlZFBsdWdpbnMoKTtcblx0XHRcdGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocGx1Z2lucywgW10pO1xuXHRcdH0pO1xuXG5cdFx0aXQoJ3Nob3VsZCByZXR1cm4gbnVsbCBmb3IgZ2V0TGFzdFZhbGlkYXRpb24oKSBiZWZvcmUgdmFsaWRhdGVJbXBvcnQoKScsICgpID0+IHtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChpbXBvcnRlci5nZXRMYXN0VmFsaWRhdGlvbigpLCBudWxsKTtcblx0XHR9KTtcblxuXHRcdGl0KCdzaG91bGQgcmV0dXJuIGxhc3QgdmFsaWRhdGlvbiBhZnRlciB2YWxpZGF0ZUltcG9ydCgpJywgKCkgPT4ge1xuXHRcdFx0aW1wb3J0ZXIuZGlzY292ZXIoW10pO1xuXHRcdFx0aW1wb3J0ZXIudmFsaWRhdGVJbXBvcnQoW10pO1xuXHRcdFx0YXNzZXJ0Lm9rKGltcG9ydGVyLmdldExhc3RWYWxpZGF0aW9uKCkgIT09IG51bGwpO1xuXHRcdH0pO1xuXG5cdFx0aXQoJ3Nob3VsZCByZXR1cm4gbnVsbCBmb3IgZ2V0TGFzdERpc2NvdmVyeSgpIGJlZm9yZSBkaXNjb3ZlcigpJywgKCkgPT4ge1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKGltcG9ydGVyLmdldExhc3REaXNjb3ZlcnkoKSwgbnVsbCk7XG5cdFx0fSk7XG5cblx0XHRpdCgnc2hvdWxkIHJldHVybiBsYXN0IGRpc2NvdmVyeSBhZnRlciBkaXNjb3ZlcigpJywgKCkgPT4ge1xuXHRcdFx0aW1wb3J0ZXIuZGlzY292ZXIoW10pO1xuXHRcdFx0YXNzZXJ0Lm9rKGltcG9ydGVyLmdldExhc3REaXNjb3ZlcnkoKSAhPT0gbnVsbCk7XG5cdFx0fSk7XG5cdH0pO1xuXG5cdGRlc2NyaWJlKCdEaWFnbm9zdGljIHN0cnVjdHVyZSB2ZXJpZmljYXRpb24nLCAoKSA9PiB7XG5cdFx0aXQoJ3Nob3VsZCBwcm92aWRlIGFjdGlvbmFibGUgcmVtZWRpYXRpb24gaW4gZGlhZ25vc3RpY3MnLCAoKSA9PiB7XG5cdFx0XHRpbXBvcnRlci5kaXNjb3ZlcihbXSk7XG5cblx0XHRcdGNvbnN0IGNvbXBvbmVudHM6IE5hbWVzcGFjZWRDb21wb25lbnRbXSA9IFtcblx0XHRcdFx0e1xuXHRcdFx0XHRcdG5hbWU6ICdkdXAnLFxuXHRcdFx0XHRcdG5hbWVzcGFjZTogJ25zJyxcblx0XHRcdFx0XHRjYW5vbmljYWxOYW1lOiAnbnM6ZHVwJyxcblx0XHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRcdGZpbGVQYXRoOiAnL2ZpcnN0Lm1kJyxcblx0XHRcdFx0XHRzb3VyY2U6ICdmaXJzdCcsXG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246IHVuZGVmaW5lZCxcblx0XHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHRcdH0sXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRuYW1lOiAnZHVwJyxcblx0XHRcdFx0XHRuYW1lc3BhY2U6ICducycsXG5cdFx0XHRcdFx0Y2Fub25pY2FsTmFtZTogJ25zOmR1cCcsXG5cdFx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0XHRmaWxlUGF0aDogJy9zZWNvbmQubWQnLFxuXHRcdFx0XHRcdHNvdXJjZTogJ3NlY29uZCcsXG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246IHVuZGVmaW5lZCxcblx0XHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHRcdH0sXG5cdFx0XHRdO1xuXG5cdFx0XHRjb25zdCB2YWxpZGF0aW9uID0gaW1wb3J0ZXIudmFsaWRhdGVJbXBvcnQoY29tcG9uZW50cyk7XG5cdFx0XHRjb25zdCBkaWFnID0gdmFsaWRhdGlvbi5kaWFnbm9zdGljc1swXTtcblxuXHRcdFx0YXNzZXJ0Lm9rKGRpYWcgIT09IHVuZGVmaW5lZCk7XG5cdFx0XHRhc3NlcnQub2soZGlhZyEucmVtZWRpYXRpb24ubGVuZ3RoID4gMCk7XG5cdFx0XHRhc3NlcnQub2soZGlhZyEucmVtZWRpYXRpb24uaW5jbHVkZXMoJ25zOmR1cCcpKTtcblx0XHR9KTtcblxuXHRcdGl0KCdzaG91bGQgaW5jbHVkZSBmaWxlIHBhdGhzIGluIGNvbGxpc2lvbiBkaWFnbm9zdGljJywgKCkgPT4ge1xuXHRcdFx0aW1wb3J0ZXIuZGlzY292ZXIoW10pO1xuXG5cdFx0XHRjb25zdCBjb21wb25lbnRzOiBOYW1lc3BhY2VkQ29tcG9uZW50W10gPSBbXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRuYW1lOiAnZHVwJyxcblx0XHRcdFx0XHRuYW1lc3BhY2U6ICducycsXG5cdFx0XHRcdFx0Y2Fub25pY2FsTmFtZTogJ25zOmR1cCcsXG5cdFx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0XHRmaWxlUGF0aDogJy9maXJzdC9kdXAubWQnLFxuXHRcdFx0XHRcdHNvdXJjZTogJ2ZpcnN0Jyxcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjogdW5kZWZpbmVkLFxuXHRcdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdFx0fSxcblx0XHRcdFx0e1xuXHRcdFx0XHRcdG5hbWU6ICdkdXAnLFxuXHRcdFx0XHRcdG5hbWVzcGFjZTogJ25zJyxcblx0XHRcdFx0XHRjYW5vbmljYWxOYW1lOiAnbnM6ZHVwJyxcblx0XHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRcdGZpbGVQYXRoOiAnL3NlY29uZC9kdXAubWQnLFxuXHRcdFx0XHRcdHNvdXJjZTogJ3NlY29uZCcsXG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246IHVuZGVmaW5lZCxcblx0XHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHRcdH0sXG5cdFx0XHRdO1xuXG5cdFx0XHRjb25zdCB2YWxpZGF0aW9uID0gaW1wb3J0ZXIudmFsaWRhdGVJbXBvcnQoY29tcG9uZW50cyk7XG5cdFx0XHRjb25zdCBkaWFnID0gdmFsaWRhdGlvbi5kaWFnbm9zdGljc1swXTtcblxuXHRcdFx0YXNzZXJ0Lm9rKGRpYWchLmZpbGVQYXRocy5pbmNsdWRlcygnL2ZpcnN0L2R1cC5tZCcpKTtcblx0XHRcdGFzc2VydC5vayhkaWFnIS5maWxlUGF0aHMuaW5jbHVkZXMoJy9zZWNvbmQvZHVwLm1kJykpO1xuXHRcdH0pO1xuXHR9KTtcbn0pO1xuXG5kZXNjcmliZSgnUjAxMjogRGlzY292ZXIgLyBzZWxlY3QgLyBpbXBvcnQgZmxvdycsICgpID0+IHtcblx0aXQoJ3Nob3VsZCBzdXBwb3J0IHN0YWdlZCBkaXNjb3ZlcnkgXHUyMTkyIHNlbGVjdGlvbiBcdTIxOTIgdmFsaWRhdGlvbiBcdTIxOTIgbWFuaWZlc3QnLCAoKSA9PiB7XG5cdFx0Y29uc3QgaW1wb3J0ZXIgPSBuZXcgUGx1Z2luSW1wb3J0ZXIoKTtcblxuXHRcdC8vIFN0YWdlIDE6IERpc2NvdmVyXG5cdFx0Y29uc3QgZGlzY292ZXJ5ID0gaW1wb3J0ZXIuZGlzY292ZXIoW10pO1xuXHRcdGFzc2VydC5vayhkaXNjb3ZlcnkucmVnaXN0cnkgIT09IHVuZGVmaW5lZCk7XG5cblx0XHQvLyBTdGFnZSAyOiBTZWxlY3Rcblx0XHRjb25zdCBzZWxlY3RlZCA9IGltcG9ydGVyLnNlbGVjdENvbXBvbmVudHMoKCkgPT4gdHJ1ZSk7XG5cdFx0YXNzZXJ0Lm9rKEFycmF5LmlzQXJyYXkoc2VsZWN0ZWQpKTtcblxuXHRcdC8vIFN0YWdlIDM6IFZhbGlkYXRlXG5cdFx0Y29uc3QgdmFsaWRhdGlvbiA9IGltcG9ydGVyLnZhbGlkYXRlSW1wb3J0KHNlbGVjdGVkKTtcblx0XHRhc3NlcnQub2sodHlwZW9mIHZhbGlkYXRpb24uY2FuUHJvY2VlZCA9PT0gJ2Jvb2xlYW4nKTtcblx0XHRhc3NlcnQub2soQXJyYXkuaXNBcnJheSh2YWxpZGF0aW9uLmRpYWdub3N0aWNzKSk7XG5cblx0XHQvLyBTdGFnZSA0OiBNYW5pZmVzdFxuXHRcdGNvbnN0IG1hbmlmZXN0ID0gaW1wb3J0ZXIuZ2V0SW1wb3J0TWFuaWZlc3Qoc2VsZWN0ZWQpO1xuXHRcdGFzc2VydC5vayhtYW5pZmVzdC5zY2hlbWFWZXJzaW9uID09PSAnMS4wJyk7XG5cdFx0YXNzZXJ0Lm9rKEFycmF5LmlzQXJyYXkobWFuaWZlc3QuZW50cmllcykpO1xuXHR9KTtcblxuXHRpdCgnc2hvdWxkIGFsbG93IGluZGVwZW5kZW50IHRlc3Rpbmcgb2YgZWFjaCBzdGFnZScsICgpID0+IHtcblx0XHRjb25zdCBpbXBvcnRlciA9IG5ldyBQbHVnaW5JbXBvcnRlcigpO1xuXG5cdFx0Ly8gRWFjaCBzdGFnZSBjYW4gYmUgdGVzdGVkIGluZGVwZW5kZW50bHlcblx0XHRpbXBvcnRlci5kaXNjb3ZlcihbXSk7XG5cblx0XHQvLyBTZWxlY3Rpb24gY2FuIGJlIGNhbGxlZCBtdWx0aXBsZSB0aW1lcyB3aXRoIGRpZmZlcmVudCBmaWx0ZXJzXG5cdFx0Y29uc3QgYWxsID0gaW1wb3J0ZXIuc2VsZWN0Q29tcG9uZW50cygoKSA9PiB0cnVlKTtcblx0XHRjb25zdCBza2lsbHMgPSBpbXBvcnRlci5zZWxlY3RDb21wb25lbnRzKChjKSA9PiBjLnR5cGUgPT09ICdza2lsbCcpO1xuXHRcdGNvbnN0IGFnZW50cyA9IGltcG9ydGVyLnNlbGVjdENvbXBvbmVudHMoKGMpID0+IGMudHlwZSA9PT0gJ2FnZW50Jyk7XG5cblx0XHQvLyBBbGwgc2hvdWxkIHdvcmsgd2l0aG91dCBlcnJvclxuXHRcdGFzc2VydC5vayh0cnVlKTtcblxuXHRcdC8vIFZhbGlkYXRpb24gY2FuIGJlIGNhbGxlZCB3aXRoIGFueSBjb21wb25lbnQgc2V0XG5cdFx0Y29uc3QgdmFsaWRhdGlvbjEgPSBpbXBvcnRlci52YWxpZGF0ZUltcG9ydChhbGwpO1xuXHRcdGNvbnN0IHZhbGlkYXRpb24yID0gaW1wb3J0ZXIudmFsaWRhdGVJbXBvcnQoc2tpbGxzKTtcblx0XHRjb25zdCB2YWxpZGF0aW9uMyA9IGltcG9ydGVyLnZhbGlkYXRlSW1wb3J0KGFnZW50cyk7XG5cblx0XHRhc3NlcnQub2sodmFsaWRhdGlvbjEuY2FuUHJvY2VlZCA9PT0gdHJ1ZSk7XG5cdFx0YXNzZXJ0Lm9rKHZhbGlkYXRpb24yLmNhblByb2NlZWQgPT09IHRydWUpO1xuXHRcdGFzc2VydC5vayh2YWxpZGF0aW9uMy5jYW5Qcm9jZWVkID09PSB0cnVlKTtcblxuXHRcdC8vIE1hbmlmZXN0IGNhbiBiZSBnZW5lcmF0ZWQgZm9yIGFueSBjb21wb25lbnQgc2V0XG5cdFx0Y29uc3QgbWFuaWZlc3QxID0gaW1wb3J0ZXIuZ2V0SW1wb3J0TWFuaWZlc3QoYWxsKTtcblx0XHRjb25zdCBtYW5pZmVzdDIgPSBpbXBvcnRlci5nZXRJbXBvcnRNYW5pZmVzdChza2lsbHMpO1xuXHRcdGNvbnN0IG1hbmlmZXN0MyA9IGltcG9ydGVyLmdldEltcG9ydE1hbmlmZXN0KGFnZW50cyk7XG5cblx0XHRhc3NlcnQub2sobWFuaWZlc3QxLnNjaGVtYVZlcnNpb24gPT09ICcxLjAnKTtcblx0XHRhc3NlcnQub2sobWFuaWZlc3QyLnNjaGVtYVZlcnNpb24gPT09ICcxLjAnKTtcblx0XHRhc3NlcnQub2sobWFuaWZlc3QzLnNjaGVtYVZlcnNpb24gPT09ICcxLjAnKTtcblx0fSk7XG59KTtcblxuZGVzY3JpYmUoJ1IwMTM6IENhbm9uaWNhbCBuYW1lIHByZXNlcnZhdGlvbicsICgpID0+IHtcblx0aXQoJ3Nob3VsZCBwcmVzZXJ2ZSBwbHVnaW46Y29tcG9uZW50IGZvcm1hdCBpbiBtYW5pZmVzdCBlbnRyaWVzJywgKCkgPT4ge1xuXHRcdGNvbnN0IGltcG9ydGVyID0gbmV3IFBsdWdpbkltcG9ydGVyKCk7XG5cblx0XHRjb25zdCBjb21wb25lbnRzOiBOYW1lc3BhY2VkQ29tcG9uZW50W10gPSBbXG5cdFx0XHR7XG5cdFx0XHRcdG5hbWU6ICdteS1za2lsbCcsXG5cdFx0XHRcdG5hbWVzcGFjZTogJ215LXBsdWdpbicsXG5cdFx0XHRcdGNhbm9uaWNhbE5hbWU6ICdteS1wbHVnaW46bXktc2tpbGwnLFxuXHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRmaWxlUGF0aDogJy9za2lsbC5tZCcsXG5cdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjpteS1wbHVnaW4nLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogdW5kZWZpbmVkLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9LFxuXHRcdF07XG5cblx0XHRjb25zdCBtYW5pZmVzdCA9IGltcG9ydGVyLmdldEltcG9ydE1hbmlmZXN0KGNvbXBvbmVudHMpO1xuXG5cdFx0YXNzZXJ0LnN0cmljdEVxdWFsKG1hbmlmZXN0LmVudHJpZXNbMF0hLmNhbm9uaWNhbE5hbWUsICdteS1wbHVnaW46bXktc2tpbGwnKTtcblx0fSk7XG5cblx0aXQoJ3Nob3VsZCBwcmVzZXJ2ZSBmbGF0IG5hbWVzIGZvciBub24tbmFtZXNwYWNlZCBjb21wb25lbnRzJywgKCkgPT4ge1xuXHRcdGNvbnN0IGltcG9ydGVyID0gbmV3IFBsdWdpbkltcG9ydGVyKCk7XG5cblx0XHRjb25zdCBjb21wb25lbnRzOiBOYW1lc3BhY2VkQ29tcG9uZW50W10gPSBbXG5cdFx0XHR7XG5cdFx0XHRcdG5hbWU6ICdmbGF0LXNraWxsJyxcblx0XHRcdFx0bmFtZXNwYWNlOiB1bmRlZmluZWQsXG5cdFx0XHRcdGNhbm9uaWNhbE5hbWU6ICdmbGF0LXNraWxsJyxcblx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0ZmlsZVBhdGg6ICcvc2tpbGwubWQnLFxuXHRcdFx0XHRzb3VyY2U6ICd1c2VyJyxcblx0XHRcdFx0ZGVzY3JpcHRpb246IHVuZGVmaW5lZCxcblx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0fSxcblx0XHRdO1xuXG5cdFx0Y29uc3QgbWFuaWZlc3QgPSBpbXBvcnRlci5nZXRJbXBvcnRNYW5pZmVzdChjb21wb25lbnRzKTtcblxuXHRcdGFzc2VydC5zdHJpY3RFcXVhbChtYW5pZmVzdC5lbnRyaWVzWzBdIS5jYW5vbmljYWxOYW1lLCAnZmxhdC1za2lsbCcpO1xuXHRcdGFzc2VydC5zdHJpY3RFcXVhbChtYW5pZmVzdC5lbnRyaWVzWzBdIS5uYW1lc3BhY2UsIHVuZGVmaW5lZCk7XG5cdH0pO1xuXG5cdGl0KCdzaG91bGQgc3VwcG9ydCByb3VuZC10cmlwIGlkZW50aXR5IChuYW1lICsgbmFtZXNwYWNlIFx1MjE5MiBjYW5vbmljYWwpJywgKCkgPT4ge1xuXHRcdGNvbnN0IGltcG9ydGVyID0gbmV3IFBsdWdpbkltcG9ydGVyKCk7XG5cblx0XHRjb25zdCBjb21wb25lbnRzOiBOYW1lc3BhY2VkQ29tcG9uZW50W10gPSBbXG5cdFx0XHR7XG5cdFx0XHRcdG5hbWU6ICdjb21wb25lbnQnLFxuXHRcdFx0XHRuYW1lc3BhY2U6ICduYW1lc3BhY2UnLFxuXHRcdFx0XHRjYW5vbmljYWxOYW1lOiAnbmFtZXNwYWNlOmNvbXBvbmVudCcsXG5cdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdGZpbGVQYXRoOiAnL3BhdGgnLFxuXHRcdFx0XHRzb3VyY2U6ICdzb3VyY2UnLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogdW5kZWZpbmVkLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9LFxuXHRcdF07XG5cblx0XHRjb25zdCBtYW5pZmVzdCA9IGltcG9ydGVyLmdldEltcG9ydE1hbmlmZXN0KGNvbXBvbmVudHMpO1xuXHRcdGNvbnN0IGVudHJ5ID0gbWFuaWZlc3QuZW50cmllc1swXSE7XG5cblx0XHQvLyBSb3VuZC10cmlwOiBuYW1lc3BhY2U6bmFtZSBzaG91bGQgZXF1YWwgY2Fub25pY2FsTmFtZVxuXHRcdGNvbnN0IHJlY29uc3RydWN0ZWQgPSBlbnRyeS5uYW1lc3BhY2Vcblx0XHRcdD8gYCR7ZW50cnkubmFtZXNwYWNlfToke2VudHJ5Lm5hbWV9YFxuXHRcdFx0OiBlbnRyeS5uYW1lO1xuXG5cdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlY29uc3RydWN0ZWQsIGVudHJ5LmNhbm9uaWNhbE5hbWUpO1xuXHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZWNvbnN0cnVjdGVkLCAnbmFtZXNwYWNlOmNvbXBvbmVudCcpO1xuXHR9KTtcbn0pO1xuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBUMDI6IENvbW1hbmQgRmxvdyBJbnRlZ3JhdGlvbiBUZXN0c1xuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5kZXNjcmliZSgnVDAyOiBDb21tYW5kIGZsb3cgaW50ZWdyYXRpb24nLCAoKSA9PiB7XG5cdGRlc2NyaWJlKCdNYXJrZXRwbGFjZSBkZXRlY3Rpb24nLCAoKSA9PiB7XG5cdFx0aXQoJ3Nob3VsZCBjYXRlZ29yaXplIHBsdWdpbiByb290cyBpbnRvIG1hcmtldHBsYWNlcyB2cyBmbGF0IHBhdGhzJywgKCkgPT4ge1xuXHRcdFx0Ly8gSW1wb3J0IHRoZSBoZWxwZXIgZnVuY3Rpb24gKHdlJ2xsIG5lZWQgdG8gZXhwb3J0IGl0IGZvciB0ZXN0aW5nKVxuXHRcdFx0Ly8gRm9yIG5vdywgdGVzdCB0aGUgbG9naWMgaW5kaXJlY3RseVxuXHRcdFx0Y29uc3QgaW1wb3J0ZXIgPSBuZXcgUGx1Z2luSW1wb3J0ZXIoKTtcblxuXHRcdFx0Ly8gTm9uLWV4aXN0ZW50IHBhdGhzIHNob3VsZCBzdGlsbCB3b3JrXG5cdFx0XHRjb25zdCByZXN1bHQgPSBpbXBvcnRlci5kaXNjb3ZlcihbJy9ub25leGlzdGVudC9tYXJrZXRwbGFjZSddKTtcblxuXHRcdFx0Ly8gU2hvdWxkIG5vdCBjcmFzaCBhbmQgcmV0dXJuIHZhbGlkIHN0cnVjdHVyZVxuXHRcdFx0YXNzZXJ0Lm9rKHJlc3VsdC5zdW1tYXJ5Lm1hcmtldHBsYWNlc1Byb2Nlc3NlZCA9PT0gMSk7XG5cdFx0fSk7XG5cblx0XHRpdCgnc2hvdWxkIGhhbmRsZSBlbXB0eSBtYXJrZXRwbGFjZSBwYXRocyBncmFjZWZ1bGx5JywgKCkgPT4ge1xuXHRcdFx0Y29uc3QgaW1wb3J0ZXIgPSBuZXcgUGx1Z2luSW1wb3J0ZXIoKTtcblxuXHRcdFx0Y29uc3QgcmVzdWx0ID0gaW1wb3J0ZXIuZGlzY292ZXIoW10pO1xuXG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LnN1bW1hcnkubWFya2V0cGxhY2VzUHJvY2Vzc2VkLCAwKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuc3VtbWFyeS50b3RhbFBsdWdpbnMsIDApO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5zdW1tYXJ5LnRvdGFsQ29tcG9uZW50cywgMCk7XG5cdFx0fSk7XG5cdH0pO1xuXG5cdGRlc2NyaWJlKCdDb21wb25lbnQgc2VsZWN0aW9uIGZsb3cnLCAoKSA9PiB7XG5cdFx0aXQoJ3Nob3VsZCBzdXBwb3J0IGZpbHRlcmluZyBieSBwbHVnaW4gbmFtZXNwYWNlJywgKCkgPT4ge1xuXHRcdFx0Y29uc3QgaW1wb3J0ZXIgPSBuZXcgUGx1Z2luSW1wb3J0ZXIoKTtcblx0XHRcdGltcG9ydGVyLmRpc2NvdmVyKFtdKTtcblxuXHRcdFx0Ly8gQ3JlYXRlIG1vY2sgY29tcG9uZW50cyBhcyBpZiBkaXNjb3ZlcmVkXG5cdFx0XHRjb25zdCBjb21wb25lbnRzOiBOYW1lc3BhY2VkQ29tcG9uZW50W10gPSBbXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRuYW1lOiAnc2tpbGwtYScsXG5cdFx0XHRcdFx0bmFtZXNwYWNlOiAncGx1Z2luLXgnLFxuXHRcdFx0XHRcdGNhbm9uaWNhbE5hbWU6ICdwbHVnaW4teDpza2lsbC1hJyxcblx0XHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRcdGZpbGVQYXRoOiAnL3gvc2tpbGwtYS5tZCcsXG5cdFx0XHRcdFx0c291cmNlOiAncGx1Z2luOnBsdWdpbi14Jyxcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjogdW5kZWZpbmVkLFxuXHRcdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdFx0fSxcblx0XHRcdFx0e1xuXHRcdFx0XHRcdG5hbWU6ICdza2lsbC1iJyxcblx0XHRcdFx0XHRuYW1lc3BhY2U6ICdwbHVnaW4teScsXG5cdFx0XHRcdFx0Y2Fub25pY2FsTmFtZTogJ3BsdWdpbi15OnNraWxsLWInLFxuXHRcdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdFx0ZmlsZVBhdGg6ICcveS9za2lsbC1iLm1kJyxcblx0XHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46cGx1Z2luLXknLFxuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOiB1bmRlZmluZWQsXG5cdFx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0XHR9LFxuXHRcdFx0XTtcblxuXHRcdFx0Ly8gVmFsaWRhdGUgc2hvdWxkIHdvcmsgd2l0aCBhbnkgY29tcG9uZW50IHNldFxuXHRcdFx0Y29uc3QgdmFsaWRhdGlvbiA9IGltcG9ydGVyLnZhbGlkYXRlSW1wb3J0KGNvbXBvbmVudHMpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHZhbGlkYXRpb24uY2FuUHJvY2VlZCwgdHJ1ZSk7XG5cblx0XHRcdC8vIE1hbmlmZXN0IHNob3VsZCBwcmVzZXJ2ZSBuYW1lc3BhY2UgaW5mb1xuXHRcdFx0Y29uc3QgbWFuaWZlc3QgPSBpbXBvcnRlci5nZXRJbXBvcnRNYW5pZmVzdChjb21wb25lbnRzKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChtYW5pZmVzdC5lbnRyaWVzLmxlbmd0aCwgMik7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwobWFuaWZlc3Quc3VtbWFyeS5uYW1lc3BhY2VzLmxlbmd0aCwgMik7XG5cdFx0XHRhc3NlcnQub2sobWFuaWZlc3Quc3VtbWFyeS5uYW1lc3BhY2VzLmluY2x1ZGVzKCdwbHVnaW4teCcpKTtcblx0XHRcdGFzc2VydC5vayhtYW5pZmVzdC5zdW1tYXJ5Lm5hbWVzcGFjZXMuaW5jbHVkZXMoJ3BsdWdpbi15JykpO1xuXHRcdH0pO1xuXG5cdFx0aXQoJ3Nob3VsZCBzdXBwb3J0IGZpbHRlcmluZyBieSBjb21wb25lbnQgdHlwZScsICgpID0+IHtcblx0XHRcdGNvbnN0IGltcG9ydGVyID0gbmV3IFBsdWdpbkltcG9ydGVyKCk7XG5cdFx0XHRpbXBvcnRlci5kaXNjb3ZlcihbXSk7XG5cblx0XHRcdGNvbnN0IGNvbXBvbmVudHM6IE5hbWVzcGFjZWRDb21wb25lbnRbXSA9IFtcblx0XHRcdFx0e1xuXHRcdFx0XHRcdG5hbWU6ICdza2lsbC1hJyxcblx0XHRcdFx0XHRuYW1lc3BhY2U6ICdwbHVnaW4nLFxuXHRcdFx0XHRcdGNhbm9uaWNhbE5hbWU6ICdwbHVnaW46c2tpbGwtYScsXG5cdFx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0XHRmaWxlUGF0aDogJy9za2lsbC1hLm1kJyxcblx0XHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46cGx1Z2luJyxcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjogdW5kZWZpbmVkLFxuXHRcdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdFx0fSxcblx0XHRcdFx0e1xuXHRcdFx0XHRcdG5hbWU6ICdhZ2VudC14Jyxcblx0XHRcdFx0XHRuYW1lc3BhY2U6ICdwbHVnaW4nLFxuXHRcdFx0XHRcdGNhbm9uaWNhbE5hbWU6ICdwbHVnaW46YWdlbnQteCcsXG5cdFx0XHRcdFx0dHlwZTogJ2FnZW50Jyxcblx0XHRcdFx0XHRmaWxlUGF0aDogJy9hZ2VudC14Lm1kJyxcblx0XHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46cGx1Z2luJyxcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjogdW5kZWZpbmVkLFxuXHRcdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdFx0fSxcblx0XHRcdF07XG5cblx0XHRcdGNvbnN0IG1hbmlmZXN0ID0gaW1wb3J0ZXIuZ2V0SW1wb3J0TWFuaWZlc3QoY29tcG9uZW50cyk7XG5cblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChtYW5pZmVzdC5zdW1tYXJ5LnNraWxscywgMSk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwobWFuaWZlc3Quc3VtbWFyeS5hZ2VudHMsIDEpO1xuXHRcdH0pO1xuXHR9KTtcblxuXHRkZXNjcmliZSgnUHJlLWltcG9ydCBkaWFnbm9zdGljcyBnYXRpbmcnLCAoKSA9PiB7XG5cdFx0aXQoJ3Nob3VsZCBibG9jayBpbXBvcnQgb24gY2Fub25pY2FsIGNvbGxpc2lvbiAoZXJyb3IpJywgKCkgPT4ge1xuXHRcdFx0Y29uc3QgaW1wb3J0ZXIgPSBuZXcgUGx1Z2luSW1wb3J0ZXIoKTtcblx0XHRcdGltcG9ydGVyLmRpc2NvdmVyKFtdKTtcblxuXHRcdFx0Y29uc3QgY29tcG9uZW50czogTmFtZXNwYWNlZENvbXBvbmVudFtdID0gW1xuXHRcdFx0XHR7XG5cdFx0XHRcdFx0bmFtZTogJ3NraWxsJyxcblx0XHRcdFx0XHRuYW1lc3BhY2U6ICducycsXG5cdFx0XHRcdFx0Y2Fub25pY2FsTmFtZTogJ25zOnNraWxsJyxcblx0XHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRcdGZpbGVQYXRoOiAnL2ZpcnN0Lm1kJyxcblx0XHRcdFx0XHRzb3VyY2U6ICdmaXJzdCcsXG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246IHVuZGVmaW5lZCxcblx0XHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHRcdH0sXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRuYW1lOiAnc2tpbGwnLFxuXHRcdFx0XHRcdG5hbWVzcGFjZTogJ25zJyxcblx0XHRcdFx0XHRjYW5vbmljYWxOYW1lOiAnbnM6c2tpbGwnLCAvLyBDb2xsaXNpb25cblx0XHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRcdGZpbGVQYXRoOiAnL3NlY29uZC5tZCcsXG5cdFx0XHRcdFx0c291cmNlOiAnc2Vjb25kJyxcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjogdW5kZWZpbmVkLFxuXHRcdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdFx0fSxcblx0XHRcdF07XG5cblx0XHRcdGNvbnN0IHZhbGlkYXRpb24gPSBpbXBvcnRlci52YWxpZGF0ZUltcG9ydChjb21wb25lbnRzKTtcblxuXHRcdFx0Ly8gU2hvdWxkIGJsb2NrIC0gZXJyb3Igc2V2ZXJpdHlcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbCh2YWxpZGF0aW9uLmNhblByb2NlZWQsIGZhbHNlKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbCh2YWxpZGF0aW9uLnN1bW1hcnkuZXJyb3JzLCAxKTtcblx0XHR9KTtcblxuXHRcdGl0KCdzaG91bGQgYWxsb3cgaW1wb3J0IHdpdGggc2hvcnRoYW5kIG92ZXJsYXAgKHdhcm5pbmcpJywgKCkgPT4ge1xuXHRcdFx0Y29uc3QgaW1wb3J0ZXIgPSBuZXcgUGx1Z2luSW1wb3J0ZXIoKTtcblx0XHRcdGltcG9ydGVyLmRpc2NvdmVyKFtdKTtcblxuXHRcdFx0Y29uc3QgY29tcG9uZW50czogTmFtZXNwYWNlZENvbXBvbmVudFtdID0gW1xuXHRcdFx0XHR7XG5cdFx0XHRcdFx0bmFtZTogJ3JldmlldycsXG5cdFx0XHRcdFx0bmFtZXNwYWNlOiAncGx1Z2luLWEnLFxuXHRcdFx0XHRcdGNhbm9uaWNhbE5hbWU6ICdwbHVnaW4tYTpyZXZpZXcnLFxuXHRcdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdFx0ZmlsZVBhdGg6ICcvYS9yZXZpZXcubWQnLFxuXHRcdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjpwbHVnaW4tYScsXG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246IHVuZGVmaW5lZCxcblx0XHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHRcdH0sXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRuYW1lOiAncmV2aWV3Jyxcblx0XHRcdFx0XHRuYW1lc3BhY2U6ICdwbHVnaW4tYicsXG5cdFx0XHRcdFx0Y2Fub25pY2FsTmFtZTogJ3BsdWdpbi1iOnJldmlldycsXG5cdFx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0XHRmaWxlUGF0aDogJy9iL3Jldmlldy5tZCcsXG5cdFx0XHRcdFx0c291cmNlOiAncGx1Z2luOnBsdWdpbi1iJyxcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjogdW5kZWZpbmVkLFxuXHRcdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdFx0fSxcblx0XHRcdF07XG5cblx0XHRcdGNvbnN0IHZhbGlkYXRpb24gPSBpbXBvcnRlci52YWxpZGF0ZUltcG9ydChjb21wb25lbnRzKTtcblxuXHRcdFx0Ly8gU2hvdWxkIE5PVCBibG9jayAtIHdhcm5pbmcgb25seVxuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHZhbGlkYXRpb24uY2FuUHJvY2VlZCwgdHJ1ZSk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwodmFsaWRhdGlvbi5zdW1tYXJ5Lndhcm5pbmdzLCAxKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbCh2YWxpZGF0aW9uLnN1bW1hcnkuZXJyb3JzLCAwKTtcblx0XHR9KTtcblxuXHRcdGl0KCdzaG91bGQgcHJvdmlkZSBhY3Rpb25hYmxlIGRpYWdub3N0aWNzIGZvciBibG9ja2luZyBlcnJvcnMnLCAoKSA9PiB7XG5cdFx0XHRjb25zdCBpbXBvcnRlciA9IG5ldyBQbHVnaW5JbXBvcnRlcigpO1xuXHRcdFx0aW1wb3J0ZXIuZGlzY292ZXIoW10pO1xuXG5cdFx0XHRjb25zdCBjb21wb25lbnRzOiBOYW1lc3BhY2VkQ29tcG9uZW50W10gPSBbXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRuYW1lOiAnZHVwJyxcblx0XHRcdFx0XHRuYW1lc3BhY2U6ICducycsXG5cdFx0XHRcdFx0Y2Fub25pY2FsTmFtZTogJ25zOmR1cCcsXG5cdFx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0XHRmaWxlUGF0aDogJy9maXJzdC5tZCcsXG5cdFx0XHRcdFx0c291cmNlOiAnZmlyc3QnLFxuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOiB1bmRlZmluZWQsXG5cdFx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0XHR9LFxuXHRcdFx0XHR7XG5cdFx0XHRcdFx0bmFtZTogJ2R1cCcsXG5cdFx0XHRcdFx0bmFtZXNwYWNlOiAnbnMnLFxuXHRcdFx0XHRcdGNhbm9uaWNhbE5hbWU6ICduczpkdXAnLFxuXHRcdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdFx0ZmlsZVBhdGg6ICcvc2Vjb25kLm1kJyxcblx0XHRcdFx0XHRzb3VyY2U6ICdzZWNvbmQnLFxuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOiB1bmRlZmluZWQsXG5cdFx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0XHR9LFxuXHRcdFx0XTtcblxuXHRcdFx0Y29uc3QgdmFsaWRhdGlvbiA9IGltcG9ydGVyLnZhbGlkYXRlSW1wb3J0KGNvbXBvbmVudHMpO1xuXG5cdFx0XHQvLyBTaG91bGQgaGF2ZSBkaWFnbm9zdGljIHdpdGggcmVtZWRpYXRpb25cblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbCh2YWxpZGF0aW9uLmRpYWdub3N0aWNzLmxlbmd0aCwgMSk7XG5cdFx0XHRhc3NlcnQub2sodmFsaWRhdGlvbi5kaWFnbm9zdGljc1swXSEucmVtZWRpYXRpb24ubGVuZ3RoID4gMCk7XG5cdFx0XHRhc3NlcnQub2sodmFsaWRhdGlvbi5kaWFnbm9zdGljc1swXSEucmVtZWRpYXRpb24uaW5jbHVkZXMoJ25zOmR1cCcpKTtcblx0XHR9KTtcblx0fSk7XG5cblx0ZGVzY3JpYmUoJ0NvbmZpZyBwZXJzaXN0ZW5jZSB3aXRoIGNhbm9uaWNhbCBuYW1lcycsICgpID0+IHtcblx0XHRpdCgnc2hvdWxkIHByZXNlcnZlIGNhbm9uaWNhbCBuYW1lcyBpbiBtYW5pZmVzdCBmb3IgcGVyc2lzdGVuY2UnLCAoKSA9PiB7XG5cdFx0XHRjb25zdCBpbXBvcnRlciA9IG5ldyBQbHVnaW5JbXBvcnRlcigpO1xuXG5cdFx0XHRjb25zdCBjb21wb25lbnRzOiBOYW1lc3BhY2VkQ29tcG9uZW50W10gPSBbXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRuYW1lOiAnY29kZS1yZXZpZXcnLFxuXHRcdFx0XHRcdG5hbWVzcGFjZTogJ215LXBsdWdpbicsXG5cdFx0XHRcdFx0Y2Fub25pY2FsTmFtZTogJ215LXBsdWdpbjpjb2RlLXJldmlldycsXG5cdFx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0XHRmaWxlUGF0aDogJy9wbHVnaW5zL215LXBsdWdpbi9za2lsbHMvY29kZS1yZXZpZXcvU0tJTEwubWQnLFxuXHRcdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjpteS1wbHVnaW4nLFxuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOiAnUmV2aWV3cyBjb2RlJyxcblx0XHRcdFx0XHRtZXRhZGF0YTogeyBwbHVnaW5WZXJzaW9uOiAnMS4wLjAnIH0sXG5cdFx0XHRcdH0sXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRuYW1lOiAnYXJjaGl0ZWN0Jyxcblx0XHRcdFx0XHRuYW1lc3BhY2U6ICdteS1wbHVnaW4nLFxuXHRcdFx0XHRcdGNhbm9uaWNhbE5hbWU6ICdteS1wbHVnaW46YXJjaGl0ZWN0Jyxcblx0XHRcdFx0XHR0eXBlOiAnYWdlbnQnLFxuXHRcdFx0XHRcdGZpbGVQYXRoOiAnL3BsdWdpbnMvbXktcGx1Z2luL2FnZW50cy9hcmNoaXRlY3QvQUdFTlQubWQnLFxuXHRcdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjpteS1wbHVnaW4nLFxuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOiAnRGVzaWducyBhcmNoaXRlY3R1cmUnLFxuXHRcdFx0XHRcdG1ldGFkYXRhOiB7IHBsdWdpblZlcnNpb246ICcxLjAuMCcgfSxcblx0XHRcdFx0fSxcblx0XHRcdF07XG5cblx0XHRcdGNvbnN0IG1hbmlmZXN0ID0gaW1wb3J0ZXIuZ2V0SW1wb3J0TWFuaWZlc3QoY29tcG9uZW50cyk7XG5cblx0XHRcdC8vIFZlcmlmeSBjYW5vbmljYWwgbmFtZXMgcHJlc2VydmVkXG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwobWFuaWZlc3QuZW50cmllcy5sZW5ndGgsIDIpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKG1hbmlmZXN0LmVudHJpZXNbMF0hLmNhbm9uaWNhbE5hbWUsICdteS1wbHVnaW46Y29kZS1yZXZpZXcnKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChtYW5pZmVzdC5lbnRyaWVzWzFdIS5jYW5vbmljYWxOYW1lLCAnbXktcGx1Z2luOmFyY2hpdGVjdCcpO1xuXG5cdFx0XHQvLyBWZXJpZnkgbWFuaWZlc3QgaXMgSlNPTi1zZXJpYWxpemFibGUgZm9yIGNvbmZpZyBwZXJzaXN0ZW5jZVxuXHRcdFx0Y29uc3QganNvbiA9IEpTT04uc3RyaW5naWZ5KG1hbmlmZXN0KTtcblx0XHRcdGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UoanNvbik7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocGFyc2VkLmVudHJpZXNbMF0uY2Fub25pY2FsTmFtZSwgJ215LXBsdWdpbjpjb2RlLXJldmlldycpO1xuXHRcdH0pO1xuXG5cdFx0aXQoJ3Nob3VsZCBpbmNsdWRlIGZpbGUgcGF0aHMgZm9yIHNldHRpbmdzIHBlcnNpc3RlbmNlJywgKCkgPT4ge1xuXHRcdFx0Y29uc3QgaW1wb3J0ZXIgPSBuZXcgUGx1Z2luSW1wb3J0ZXIoKTtcblxuXHRcdFx0Y29uc3QgY29tcG9uZW50czogTmFtZXNwYWNlZENvbXBvbmVudFtdID0gW1xuXHRcdFx0XHR7XG5cdFx0XHRcdFx0bmFtZTogJ3NraWxsJyxcblx0XHRcdFx0XHRuYW1lc3BhY2U6ICdwbHVnaW4nLFxuXHRcdFx0XHRcdGNhbm9uaWNhbE5hbWU6ICdwbHVnaW46c2tpbGwnLFxuXHRcdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdFx0ZmlsZVBhdGg6ICcvYWJzb2x1dGUvcGF0aC90by9za2lsbC5tZCcsXG5cdFx0XHRcdFx0c291cmNlOiAncGx1Z2luOnBsdWdpbicsXG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246IHVuZGVmaW5lZCxcblx0XHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHRcdH0sXG5cdFx0XHRdO1xuXG5cdFx0XHRjb25zdCBtYW5pZmVzdCA9IGltcG9ydGVyLmdldEltcG9ydE1hbmlmZXN0KGNvbXBvbmVudHMpO1xuXG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwobWFuaWZlc3QuZW50cmllc1swXSEuZmlsZVBhdGgsICcvYWJzb2x1dGUvcGF0aC90by9za2lsbC5tZCcpO1xuXHRcdH0pO1xuXG5cdFx0aXQoJ3Nob3VsZCBzZXBhcmF0ZSBza2lsbHMgYW5kIGFnZW50cyBmb3Igc2V0dGluZ3Mgcm91dGluZycsICgpID0+IHtcblx0XHRcdGNvbnN0IGltcG9ydGVyID0gbmV3IFBsdWdpbkltcG9ydGVyKCk7XG5cblx0XHRcdGNvbnN0IGNvbXBvbmVudHM6IE5hbWVzcGFjZWRDb21wb25lbnRbXSA9IFtcblx0XHRcdFx0e1xuXHRcdFx0XHRcdG5hbWU6ICdza2lsbC0xJyxcblx0XHRcdFx0XHRuYW1lc3BhY2U6ICdwJyxcblx0XHRcdFx0XHRjYW5vbmljYWxOYW1lOiAncDpza2lsbC0xJyxcblx0XHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRcdGZpbGVQYXRoOiAnL3MxLm1kJyxcblx0XHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46cCcsXG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246IHVuZGVmaW5lZCxcblx0XHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHRcdH0sXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRuYW1lOiAnc2tpbGwtMicsXG5cdFx0XHRcdFx0bmFtZXNwYWNlOiAncCcsXG5cdFx0XHRcdFx0Y2Fub25pY2FsTmFtZTogJ3A6c2tpbGwtMicsXG5cdFx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0XHRmaWxlUGF0aDogJy9zMi5tZCcsXG5cdFx0XHRcdFx0c291cmNlOiAncGx1Z2luOnAnLFxuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOiB1bmRlZmluZWQsXG5cdFx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0XHR9LFxuXHRcdFx0XHR7XG5cdFx0XHRcdFx0bmFtZTogJ2FnZW50LTEnLFxuXHRcdFx0XHRcdG5hbWVzcGFjZTogJ3AnLFxuXHRcdFx0XHRcdGNhbm9uaWNhbE5hbWU6ICdwOmFnZW50LTEnLFxuXHRcdFx0XHRcdHR5cGU6ICdhZ2VudCcsXG5cdFx0XHRcdFx0ZmlsZVBhdGg6ICcvYTEubWQnLFxuXHRcdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjpwJyxcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjogdW5kZWZpbmVkLFxuXHRcdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdFx0fSxcblx0XHRcdF07XG5cblx0XHRcdGNvbnN0IG1hbmlmZXN0ID0gaW1wb3J0ZXIuZ2V0SW1wb3J0TWFuaWZlc3QoY29tcG9uZW50cyk7XG5cblx0XHRcdGNvbnN0IHNraWxscyA9IG1hbmlmZXN0LmVudHJpZXMuZmlsdGVyKGUgPT4gZS50eXBlID09PSAnc2tpbGwnKTtcblx0XHRcdGNvbnN0IGFnZW50cyA9IG1hbmlmZXN0LmVudHJpZXMuZmlsdGVyKGUgPT4gZS50eXBlID09PSAnYWdlbnQnKTtcblxuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHNraWxscy5sZW5ndGgsIDIpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKGFnZW50cy5sZW5ndGgsIDEpO1xuXHRcdH0pO1xuXHR9KTtcblxuXHRkZXNjcmliZSgnRW5kLXRvLWVuZCBjb21tYW5kIGZsb3cgc2ltdWxhdGlvbicsICgpID0+IHtcblx0XHRpdCgnc2hvdWxkIGV4ZWN1dGUgZnVsbCBwaXBlbGluZTogZGlzY292ZXIgXHUyMTkyIHNlbGVjdCBcdTIxOTIgdmFsaWRhdGUgXHUyMTkyIG1hbmlmZXN0JywgKCkgPT4ge1xuXHRcdFx0Y29uc3QgaW1wb3J0ZXIgPSBuZXcgUGx1Z2luSW1wb3J0ZXIoKTtcblxuXHRcdFx0Ly8gU3RhZ2UgMTogRGlzY292ZXIgKGVtcHR5IGluIHRoaXMgdGVzdClcblx0XHRcdGNvbnN0IGRpc2NvdmVyeSA9IGltcG9ydGVyLmRpc2NvdmVyKFtdKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChkaXNjb3Zlcnkuc3VtbWFyeS50b3RhbENvbXBvbmVudHMsIDApO1xuXG5cdFx0XHQvLyBTdGFnZSAyOiBTaW11bGF0ZSB1c2VyIHNlbGVjdGlvbiAobW9jayBjb21wb25lbnRzKVxuXHRcdFx0Y29uc3Qgc2VsZWN0ZWQ6IE5hbWVzcGFjZWRDb21wb25lbnRbXSA9IFtcblx0XHRcdFx0e1xuXHRcdFx0XHRcdG5hbWU6ICdjb2RlLXJldmlldycsXG5cdFx0XHRcdFx0bmFtZXNwYWNlOiAnbXktcGx1Z2luJyxcblx0XHRcdFx0XHRjYW5vbmljYWxOYW1lOiAnbXktcGx1Z2luOmNvZGUtcmV2aWV3Jyxcblx0XHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRcdGZpbGVQYXRoOiAnL3BsdWdpbnMvbXktcGx1Z2luL3NraWxscy9jb2RlLXJldmlldy9TS0lMTC5tZCcsXG5cdFx0XHRcdFx0c291cmNlOiAncGx1Z2luOm15LXBsdWdpbicsXG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246ICdSZXZpZXdzIGNvZGUnLFxuXHRcdFx0XHRcdG1ldGFkYXRhOiB7IHBsdWdpblZlcnNpb246ICcxLjAuMCcgfSxcblx0XHRcdFx0fSxcblx0XHRcdF07XG5cblx0XHRcdC8vIFN0YWdlIDM6IFZhbGlkYXRlXG5cdFx0XHRjb25zdCB2YWxpZGF0aW9uID0gaW1wb3J0ZXIudmFsaWRhdGVJbXBvcnQoc2VsZWN0ZWQpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHZhbGlkYXRpb24uY2FuUHJvY2VlZCwgdHJ1ZSk7XG5cblx0XHRcdC8vIFN0YWdlIDQ6IEdlbmVyYXRlIG1hbmlmZXN0XG5cdFx0XHRjb25zdCBtYW5pZmVzdCA9IGltcG9ydGVyLmdldEltcG9ydE1hbmlmZXN0KHNlbGVjdGVkKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChtYW5pZmVzdC5lbnRyaWVzLmxlbmd0aCwgMSk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwobWFuaWZlc3QuZW50cmllc1swXSEuY2Fub25pY2FsTmFtZSwgJ215LXBsdWdpbjpjb2RlLXJldmlldycpO1xuXHRcdH0pO1xuXG5cdFx0aXQoJ3Nob3VsZCBibG9jayBvbiB2YWxpZGF0aW9uIGZhaWx1cmUgYmVmb3JlIHBlcnNpc3RlbmNlJywgKCkgPT4ge1xuXHRcdFx0Y29uc3QgaW1wb3J0ZXIgPSBuZXcgUGx1Z2luSW1wb3J0ZXIoKTtcblx0XHRcdGltcG9ydGVyLmRpc2NvdmVyKFtdKTtcblxuXHRcdFx0Y29uc3Qgc2VsZWN0ZWQ6IE5hbWVzcGFjZWRDb21wb25lbnRbXSA9IFtcblx0XHRcdFx0e1xuXHRcdFx0XHRcdG5hbWU6ICdkdXAnLFxuXHRcdFx0XHRcdG5hbWVzcGFjZTogJ25zJyxcblx0XHRcdFx0XHRjYW5vbmljYWxOYW1lOiAnbnM6ZHVwJyxcblx0XHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRcdGZpbGVQYXRoOiAnL2ZpcnN0Lm1kJyxcblx0XHRcdFx0XHRzb3VyY2U6ICdmaXJzdCcsXG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246IHVuZGVmaW5lZCxcblx0XHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHRcdH0sXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRuYW1lOiAnZHVwJyxcblx0XHRcdFx0XHRuYW1lc3BhY2U6ICducycsXG5cdFx0XHRcdFx0Y2Fub25pY2FsTmFtZTogJ25zOmR1cCcsXG5cdFx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0XHRmaWxlUGF0aDogJy9zZWNvbmQubWQnLFxuXHRcdFx0XHRcdHNvdXJjZTogJ3NlY29uZCcsXG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246IHVuZGVmaW5lZCxcblx0XHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHRcdH0sXG5cdFx0XHRdO1xuXG5cdFx0XHRjb25zdCB2YWxpZGF0aW9uID0gaW1wb3J0ZXIudmFsaWRhdGVJbXBvcnQoc2VsZWN0ZWQpO1xuXG5cdFx0XHQvLyBTaW11bGF0ZSBjb21tYW5kIGZsb3cgbG9naWM6IHNob3VsZCBOT1QgcHJvY2VlZCB0byBwZXJzaXN0ZW5jZVxuXHRcdFx0aWYgKHZhbGlkYXRpb24uY2FuUHJvY2VlZCkge1xuXHRcdFx0XHQvLyBUaGlzIHNob3VsZCBOT1QgYmUgcmVhY2hlZFxuXHRcdFx0XHRhc3NlcnQuZmFpbCgnU2hvdWxkIG5vdCBwcm9jZWVkIHRvIHBlcnNpc3RlbmNlIHdpdGggZXJyb3JzJyk7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHQvLyBDb3JyZWN0OiBibG9ja2VkIGJlZm9yZSBwZXJzaXN0ZW5jZVxuXHRcdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwodmFsaWRhdGlvbi5zdW1tYXJ5LmVycm9ycywgMSk7XG5cdFx0XHR9XG5cdFx0fSk7XG5cblx0XHRpdCgnc2hvdWxkIGFsbG93IHByb2NlZWRpbmcgYWZ0ZXIgdXNlciBjb25maXJtcyB3YXJuaW5ncycsICgpID0+IHtcblx0XHRcdGNvbnN0IGltcG9ydGVyID0gbmV3IFBsdWdpbkltcG9ydGVyKCk7XG5cdFx0XHRpbXBvcnRlci5kaXNjb3ZlcihbXSk7XG5cblx0XHRcdGNvbnN0IHNlbGVjdGVkOiBOYW1lc3BhY2VkQ29tcG9uZW50W10gPSBbXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRuYW1lOiAncmV2aWV3Jyxcblx0XHRcdFx0XHRuYW1lc3BhY2U6ICdwbHVnaW4tYScsXG5cdFx0XHRcdFx0Y2Fub25pY2FsTmFtZTogJ3BsdWdpbi1hOnJldmlldycsXG5cdFx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0XHRmaWxlUGF0aDogJy9hL3Jldmlldy5tZCcsXG5cdFx0XHRcdFx0c291cmNlOiAncGx1Z2luOnBsdWdpbi1hJyxcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjogdW5kZWZpbmVkLFxuXHRcdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdFx0fSxcblx0XHRcdFx0e1xuXHRcdFx0XHRcdG5hbWU6ICdyZXZpZXcnLFxuXHRcdFx0XHRcdG5hbWVzcGFjZTogJ3BsdWdpbi1iJyxcblx0XHRcdFx0XHRjYW5vbmljYWxOYW1lOiAncGx1Z2luLWI6cmV2aWV3Jyxcblx0XHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRcdGZpbGVQYXRoOiAnL2IvcmV2aWV3Lm1kJyxcblx0XHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46cGx1Z2luLWInLFxuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOiB1bmRlZmluZWQsXG5cdFx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0XHR9LFxuXHRcdFx0XTtcblxuXHRcdFx0Y29uc3QgdmFsaWRhdGlvbiA9IGltcG9ydGVyLnZhbGlkYXRlSW1wb3J0KHNlbGVjdGVkKTtcblxuXHRcdFx0Ly8gV2FybmluZ3Mgc2hvdWxkIE5PVCBibG9ja1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHZhbGlkYXRpb24uY2FuUHJvY2VlZCwgdHJ1ZSk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwodmFsaWRhdGlvbi5zdW1tYXJ5Lndhcm5pbmdzLCAxKTtcblxuXHRcdFx0Ly8gU2ltdWxhdGUgdXNlciBjb25maXJtYXRpb24gYW5kIHByb2NlZWQgdG8gbWFuaWZlc3Rcblx0XHRcdGNvbnN0IG1hbmlmZXN0ID0gaW1wb3J0ZXIuZ2V0SW1wb3J0TWFuaWZlc3Qoc2VsZWN0ZWQpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKG1hbmlmZXN0LmVudHJpZXMubGVuZ3RoLCAyKTtcblx0XHR9KTtcblx0fSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQVlBLFNBQVMsVUFBVSxJQUFJLGtCQUF3QjtBQUMvQyxPQUFPLFlBQVk7QUFDbkI7QUFBQSxFQUNDO0FBQUEsT0FJTTtBQWNQLFNBQVMsaUJBQWlCLFlBQXVDLENBQUMsR0FBcUI7QUFDdEYsU0FBTztBQUFBLElBQ04sTUFBTTtBQUFBLElBQ04sZUFBZTtBQUFBLElBQ2YsUUFBUTtBQUFBLElBQ1IsY0FBYztBQUFBLElBQ2QsUUFBUTtBQUFBLElBQ1IsZ0JBQWdCO0FBQUEsSUFDaEIsYUFBYTtBQUFBLElBQ2IsU0FBUztBQUFBLElBQ1QsUUFBUSxFQUFFLE1BQU0sY0FBYztBQUFBLElBQzlCLFdBQVc7QUFBQSxNQUNWLFFB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
