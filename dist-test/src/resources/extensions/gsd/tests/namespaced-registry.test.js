import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import {
  NamespacedRegistry,
  componentsFromDiscovery
} from "../namespaced-registry.js";
describe("NamespacedRegistry", () => {
  let registry;
  beforeEach(() => {
    registry = new NamespacedRegistry();
  });
  describe("canonical registration and lookup", () => {
    it("should register a namespaced skill and compute canonical name (R004, R005)", () => {
      const diagnostic = registry.register({
        name: "my-skill",
        namespace: "my-plugin",
        type: "skill",
        filePath: "/plugins/my-plugin/skills/my-skill/SKILL.md",
        source: "plugin:my-plugin",
        description: "A test skill",
        metadata: { pluginVersion: "1.0.0" }
      });
      assert.strictEqual(diagnostic, void 0);
      assert.strictEqual(registry.size, 1);
      assert.strictEqual(registry.has("my-plugin:my-skill"), true);
      const component = registry.getByCanonical("my-plugin:my-skill");
      assert.ok(component !== void 0);
      assert.strictEqual(component.name, "my-skill");
      assert.strictEqual(component.namespace, "my-plugin");
      assert.strictEqual(component.canonicalName, "my-plugin:my-skill");
      assert.strictEqual(component.type, "skill");
      assert.strictEqual(component.filePath, "/plugins/my-plugin/skills/my-skill/SKILL.md");
      assert.strictEqual(component.source, "plugin:my-plugin");
      assert.strictEqual(component.description, "A test skill");
      assert.strictEqual(component.metadata.pluginVersion, "1.0.0");
    });
    it("should register a namespaced agent and compute canonical name (R006)", () => {
      const diagnostic = registry.register({
        name: "abby",
        namespace: "farm",
        type: "agent",
        filePath: "/plugins/farm/agents/abby/AGENT.md",
        source: "plugin:farm",
        description: "A farm agent",
        metadata: { pluginAuthor: "farm-team" }
      });
      assert.strictEqual(diagnostic, void 0);
      assert.strictEqual(registry.size, 1);
      const agent = registry.getByCanonical("farm:abby");
      assert.ok(agent !== void 0);
      assert.strictEqual(agent.name, "abby");
      assert.strictEqual(agent.namespace, "farm");
      assert.strictEqual(agent.canonicalName, "farm:abby");
      assert.strictEqual(agent.type, "agent");
    });
    it("should return undefined for non-existent canonical name", () => {
      const result = registry.getByCanonical("nonexistent:skill");
      assert.strictEqual(result, void 0);
    });
  });
  describe("flat (non-namespaced) compatibility", () => {
    it("should register flat component with bare name as canonical", () => {
      const diagnostic = registry.register({
        name: "code-review",
        namespace: void 0,
        type: "skill",
        filePath: "/skills/code-review/SKILL.md",
        source: "user",
        description: "A flat skill",
        metadata: {}
      });
      assert.strictEqual(diagnostic, void 0);
      const skill = registry.getByCanonical("code-review");
      assert.ok(skill !== void 0);
      assert.strictEqual(skill.name, "code-review");
      assert.strictEqual(skill.namespace, void 0);
      assert.strictEqual(skill.canonicalName, "code-review");
    });
    it("should retrieve flat component by bare name", () => {
      registry.register({
        name: "test-skill",
        namespace: void 0,
        type: "skill",
        filePath: "/skills/test-skill/SKILL.md",
        source: "project",
        description: void 0,
        metadata: {}
      });
      const skill = registry.getByCanonical("test-skill");
      assert.ok(skill !== void 0);
      assert.strictEqual(skill.canonicalName, "test-skill");
    });
  });
  describe("collision detection", () => {
    it("should detect collision on duplicate canonical name and emit diagnostic", () => {
      const first = registry.register({
        name: "code-review",
        namespace: "my-plugin",
        type: "skill",
        filePath: "/plugins/my-plugin/skills/code-review/SKILL.md",
        source: "plugin:my-plugin",
        description: "First skill",
        metadata: {}
      });
      assert.strictEqual(first, void 0);
      const second = registry.register({
        name: "code-review",
        namespace: "my-plugin",
        type: "skill",
        filePath: "/plugins/other-plugin/skills/code-review/SKILL.md",
        source: "plugin:other-plugin",
        description: "Second skill",
        metadata: {}
      });
      assert.ok(second !== void 0);
      assert.strictEqual(second.type, "collision");
      assert.strictEqual(second.message, 'canonical name "my-plugin:code-review" collision');
      assert.strictEqual(second.collision.canonicalName, "my-plugin:code-review");
      assert.strictEqual(second.collision.winnerPath, "/plugins/my-plugin/skills/code-review/SKILL.md");
      assert.strictEqual(second.collision.loserPath, "/plugins/other-plugin/skills/code-review/SKILL.md");
      assert.strictEqual(second.collision.winnerSource, "plugin:my-plugin");
      assert.strictEqual(second.collision.loserSource, "plugin:other-plugin");
    });
    it("should preserve first-wins behavior on collision", () => {
      registry.register({
        name: "skill",
        namespace: "ns",
        type: "skill",
        filePath: "/first/SKILL.md",
        source: "first",
        description: "First description",
        metadata: { key: "first-value" }
      });
      registry.register({
        name: "skill",
        namespace: "ns",
        type: "skill",
        filePath: "/second/SKILL.md",
        source: "second",
        description: "Second description",
        metadata: { key: "second-value" }
      });
      const component = registry.getByCanonical("ns:skill");
      assert.ok(component !== void 0);
      assert.strictEqual(component.filePath, "/first/SKILL.md");
      assert.strictEqual(component.source, "first");
      assert.strictEqual(component.description, "First description");
      assert.strictEqual(component.metadata.key, "first-value");
    });
    it("should collect multiple collision diagnostics", () => {
      registry.register({
        name: "skill-a",
        namespace: "plugin-x",
        type: "skill",
        filePath: "/x/a.md",
        source: "x",
        description: void 0,
        metadata: {}
      });
      registry.register({
        name: "skill-b",
        namespace: "plugin-y",
        type: "skill",
        filePath: "/y/b.md",
        source: "y",
        description: void 0,
        metadata: {}
      });
      registry.register({
        name: "skill-a",
        namespace: "plugin-x",
        type: "skill",
        filePath: "/z/a.md",
        source: "z",
        description: void 0,
        metadata: {}
      });
      registry.register({
        name: "skill-b",
        namespace: "plugin-y",
        type: "skill",
        filePath: "/w/b.md",
        source: "w",
        description: void 0,
        metadata: {}
      });
      const diagnostics = registry.getDiagnostics();
      assert.strictEqual(diagnostics.length, 2);
      assert.strictEqual(diagnostics[0].collision.canonicalName, "plugin-x:skill-a");
      assert.strictEqual(diagnostics[1].collision.canonicalName, "plugin-y:skill-b");
    });
    it("should allow same name in different namespaces", () => {
      registry.register({
        name: "code-review",
        namespace: "plugin-a",
        type: "skill",
        filePath: "/a/code-review.md",
        source: "plugin:plugin-a",
        description: void 0,
        metadata: {}
      });
      registry.register({
        name: "code-review",
        namespace: "plugin-b",
        type: "skill",
        filePath: "/b/code-review.md",
        source: "plugin:plugin-b",
        description: void 0,
        metadata: {}
      });
      assert.strictEqual(registry.size, 2);
      const a = registry.getByCanonical("plugin-a:code-review");
      const b = registry.getByCanonical("plugin-b:code-review");
      assert.ok(a !== void 0);
      assert.ok(b !== void 0);
      assert.strictEqual(a.filePath, "/a/code-review.md");
      assert.strictEqual(b.filePath, "/b/code-review.md");
      assert.strictEqual(registry.getDiagnostics().length, 0);
    });
    it("should allow flat and namespaced components with same local name", () => {
      registry.register({
        name: "code-review",
        namespace: void 0,
        type: "skill",
        filePath: "/flat/code-review.md",
        source: "user",
        description: void 0,
        metadata: {}
      });
      registry.register({
        name: "code-review",
        namespace: "plugin",
        type: "skill",
        filePath: "/plugin/code-review.md",
        source: "plugin:plugin",
        description: void 0,
        metadata: {}
      });
      const flat = registry.getByCanonical("code-review");
      const namespaced = registry.getByCanonical("plugin:code-review");
      assert.ok(flat !== void 0);
      assert.ok(namespaced !== void 0);
      assert.strictEqual(flat.namespace, void 0);
      assert.strictEqual(namespaced.namespace, "plugin");
      assert.strictEqual(registry.getDiagnostics().length, 0);
    });
  });
  describe("namespace listing", () => {
    it("should list all components in a namespace via getByNamespace", () => {
      registry.register({
        name: "skill-1",
        namespace: "plugin-a",
        type: "skill",
        filePath: "/a/skill-1.md",
        source: "plugin:plugin-a",
        description: void 0,
        metadata: {}
      });
      registry.register({
        name: "skill-2",
        namespace: "plugin-a",
        type: "skill",
        filePath: "/a/skill-2.md",
        source: "plugin:plugin-a",
        description: void 0,
        metadata: {}
      });
      registry.register({
        name: "agent-1",
        namespace: "plugin-a",
        type: "agent",
        filePath: "/a/agent-1.md",
        source: "plugin:plugin-a",
        description: void 0,
        metadata: {}
      });
      registry.register({
        name: "skill-3",
        namespace: "plugin-b",
        type: "skill",
        filePath: "/b/skill-3.md",
        source: "plugin:plugin-b",
        description: void 0,
        metadata: {}
      });
      const pluginAComponents = registry.getByNamespace("plugin-a");
      assert.strictEqual(pluginAComponents.length, 3);
      const names = pluginAComponents.map((c) => c.name).sort();
      assert.deepStrictEqual(names, ["agent-1", "skill-1", "skill-2"]);
      assert.ok(pluginAComponents.every((c) => c.namespace === "plugin-a"));
    });
    it("should return empty array for non-existent namespace", () => {
      const result = registry.getByNamespace("nonexistent");
      assert.deepStrictEqual(result, []);
    });
    it("should not include flat components in namespace listing", () => {
      registry.register({
        name: "flat-skill",
        namespace: void 0,
        type: "skill",
        filePath: "/flat.md",
        source: "user",
        description: void 0,
        metadata: {}
      });
      registry.register({
        name: "ns-skill",
        namespace: "plugin",
        type: "skill",
        filePath: "/plugin/ns-skill.md",
        source: "plugin:plugin",
        description: void 0,
        metadata: {}
      });
      const pluginComponents = registry.getByNamespace("plugin");
      assert.strictEqual(pluginComponents.length, 1);
      assert.strictEqual(pluginComponents[0].name, "ns-skill");
    });
  });
  describe("mixed coexistence", () => {
    it("should allow both namespaced and flat components without interference", () => {
      registry.register({
        name: "review",
        namespace: void 0,
        type: "skill",
        filePath: "/skills/review/SKILL.md",
        source: "user",
        description: "User skill",
        metadata: {}
      });
      registry.register({
        name: "review",
        namespace: "my-plugin",
        type: "skill",
        filePath: "/plugins/my-plugin/skills/review/SKILL.md",
        source: "plugin:my-plugin",
        description: "Plugin skill",
        metadata: { pluginVersion: "1.0.0" }
      });
      registry.register({
        name: "builder",
        namespace: "my-plugin",
        type: "agent",
        filePath: "/plugins/my-plugin/agents/builder/AGENT.md",
        source: "plugin:my-plugin",
        description: "Plugin agent",
        metadata: {}
      });
      registry.register({
        name: "assistant",
        namespace: void 0,
        type: "agent",
        filePath: "/agents/assistant/AGENT.md",
        source: "project",
        description: "Project agent",
        metadata: {}
      });
      assert.strictEqual(registry.size, 4);
      const flatSkill = registry.getByCanonical("review");
      assert.ok(flatSkill !== void 0);
      assert.strictEqual(flatSkill.namespace, void 0);
      assert.strictEqual(flatSkill.type, "skill");
      const nsSkill = registry.getByCanonical("my-plugin:review");
      assert.ok(nsSkill !== void 0);
      assert.strictEqual(nsSkill.namespace, "my-plugin");
      assert.strictEqual(nsSkill.type, "skill");
      const nsAgent = registry.getByCanonical("my-plugin:builder");
      assert.ok(nsAgent !== void 0);
      assert.strictEqual(nsAgent.namespace, "my-plugin");
      assert.strictEqual(nsAgent.type, "agent");
      const flatAgent = registry.getByCanonical("assistant");
      assert.ok(flatAgent !== void 0);
      assert.strictEqual(flatAgent.namespace, void 0);
      assert.strictEqual(flatAgent.type, "agent");
      const myPluginComponents = registry.getByNamespace("my-plugin");
      assert.strictEqual(myPluginComponents.length, 2);
      assert.strictEqual(registry.getDiagnostics().length, 0);
    });
  });
  describe("getAll and has", () => {
    it("should return all components via getAll", () => {
      registry.register({
        name: "skill-1",
        namespace: "plugin-a",
        type: "skill",
        filePath: "/a/s1.md",
        source: "a",
        description: void 0,
        metadata: {}
      });
      registry.register({
        name: "skill-2",
        namespace: void 0,
        type: "skill",
        filePath: "/s2.md",
        source: "user",
        description: void 0,
        metadata: {}
      });
      const all = registry.getAll();
      assert.strictEqual(all.length, 2);
      const canonicalNames = all.map((c) => c.canonicalName).sort();
      assert.deepStrictEqual(canonicalNames, ["plugin-a:skill-1", "skill-2"]);
    });
    it("should check existence via has", () => {
      registry.register({
        name: "test",
        namespace: "ns",
        type: "skill",
        filePath: "/test.md",
        source: "test",
        description: void 0,
        metadata: {}
      });
      assert.strictEqual(registry.has("ns:test"), true);
      assert.strictEqual(registry.has("ns:other"), false);
      assert.strictEqual(registry.has("test"), false);
    });
  });
});
describe("componentsFromDiscovery", () => {
  it("should convert DiscoveredPlugin to registerable components", () => {
    const mockPlugin = {
      name: "test-plugin",
      canonicalName: "test-plugin",
      source: "./plugins/test-plugin",
      resolvedPath: "/plugins/test-plugin",
      status: "ok",
      manifestSource: "plugin.json",
      description: "A test plugin",
      version: "1.0.0",
      author: { name: "Test Author" },
      category: "testing",
      homepage: "https://example.com/test-plugin",
      inventory: {
        skills: ["skill-a", "skill-b"],
        agents: ["agent-x"],
        commands: [],
        mcpServers: {},
        lspServers: {},
        hooks: []
      }
    };
    const components = componentsFromDiscovery(mockPlugin);
    assert.strictEqual(components.length, 3);
    assert.ok(components.every((c) => c.namespace === "test-plugin"));
    const skills = components.filter((c) => c.type === "skill");
    assert.strictEqual(skills.length, 2);
    const skillNames = skills.map((c) => c.name).sort();
    assert.deepStrictEqual(skillNames, ["skill-a", "skill-b"]);
    const agents = components.filter((c) => c.type === "agent");
    assert.strictEqual(agents.length, 1);
    assert.strictEqual(agents[0].name, "agent-x");
    assert.strictEqual(skills[0].metadata.pluginVersion, "1.0.0");
    assert.strictEqual(skills[0].metadata.pluginAuthor, "Test Author");
    assert.strictEqual(skills[0].metadata.pluginHomepage, "https://example.com/test-plugin");
    assert.strictEqual(skills[0].metadata.pluginCategory, "testing");
    assert.strictEqual(skills[0].source, "plugin:test-plugin");
  });
  it("should handle plugin without resolvedPath (external plugin)", () => {
    const externalPlugin = {
      name: "external-plugin",
      canonicalName: "external-plugin",
      source: { source: "github", repo: "example/plugin" },
      resolvedPath: null,
      // External - not locally resolved
      status: "ok",
      manifestSource: "marketplace-inline",
      description: "An external plugin",
      inventory: {
        skills: ["remote-skill"],
        agents: [],
        commands: [],
        mcpServers: {},
        lspServers: {},
        hooks: []
      }
    };
    const components = componentsFromDiscovery(externalPlugin);
    assert.strictEqual(components.length, 1);
    assert.strictEqual(components[0].name, "remote-skill");
    assert.strictEqual(components[0].namespace, "external-plugin");
    assert.ok(components[0].filePath.includes("<external>"));
  });
  it("should produce components that can be registered in NamespacedRegistry", () => {
    const mockPlugin = {
      name: "integration-plugin",
      canonicalName: "integration-plugin",
      source: "./plugins/integration",
      resolvedPath: "/plugins/integration",
      status: "ok",
      manifestSource: "plugin.json",
      inventory: {
        skills: ["int-skill"],
        agents: ["int-agent"],
        commands: [],
        mcpServers: {},
        lspServers: {},
        hooks: []
      }
    };
    const registry = new NamespacedRegistry();
    const components = componentsFromDiscovery(mockPlugin);
    for (const component of components) {
      const diag = registry.register(component);
      assert.strictEqual(diag, void 0, "No collision expected");
    }
    assert.strictEqual(registry.size, 2);
    assert.ok(registry.has("integration-plugin:int-skill"));
    assert.ok(registry.has("integration-plugin:int-agent"));
    const skill = registry.getByCanonical("integration-plugin:int-skill");
    assert.ok(skill !== void 0);
    assert.strictEqual(skill.type, "skill");
    const agent = registry.getByCanonical("integration-plugin:int-agent");
    assert.ok(agent !== void 0);
    assert.strictEqual(agent.type, "agent");
  });
  it("should strip .md extension from skill/agent names if present", () => {
    const pluginWithMd = {
      name: "md-plugin",
      canonicalName: "md-plugin",
      source: "./plugins/md",
      resolvedPath: "/plugins/md",
      status: "ok",
      manifestSource: "derived",
      inventory: {
        skills: ["skill.md"],
        // .md extension in inventory
        agents: ["agent.md"],
        commands: [],
        mcpServers: {},
        lspServers: {},
        hooks: []
      }
    };
    const components = componentsFromDiscovery(pluginWithMd);
    const skill = components.find((c) => c.type === "skill");
    const agent = components.find((c) => c.type === "agent");
    assert.ok(skill !== void 0);
    assert.ok(agent !== void 0);
    assert.strictEqual(skill.name, "skill");
    assert.strictEqual(agent.name, "agent");
  });
});
describe("diagnostic structure verification", () => {
  it("should emit diagnostic with correct RegistryCollision shape", () => {
    const registry = new NamespacedRegistry();
    registry.register({
      name: "dup",
      namespace: "ns",
      type: "skill",
      filePath: "/first/dup.md",
      source: "first-source",
      description: void 0,
      metadata: {}
    });
    const diag = registry.register({
      name: "dup",
      namespace: "ns",
      type: "skill",
      filePath: "/second/dup.md",
      source: "second-source",
      description: void 0,
      metadata: {}
    });
    assert.ok(diag !== void 0);
    assert.strictEqual(diag.type, "collision");
    assert.ok(diag.message.includes("ns:dup"));
    assert.ok(diag.message.includes("collision"));
    assert.strictEqual(diag.collision.canonicalName, "ns:dup");
    assert.strictEqual(diag.collision.winnerPath, "/first/dup.md");
    assert.strictEqual(diag.collision.loserPath, "/second/dup.md");
    assert.strictEqual(diag.collision.winnerSource, "first-source");
    assert.strictEqual(diag.collision.loserSource, "second-source");
  });
  it("should provide inspectable diagnostics via getDiagnostics", () => {
    const registry = new NamespacedRegistry();
    registry.register({
      name: "skill",
      namespace: "plugin",
      type: "skill",
      filePath: "/a/skill.md",
      source: "a",
      description: void 0,
      metadata: {}
    });
    registry.register({
      name: "skill",
      namespace: "plugin",
      type: "skill",
      filePath: "/b/skill.md",
      source: "b",
      description: void 0,
      metadata: {}
    });
    const diagnostics = registry.getDiagnostics();
    assert.strictEqual(diagnostics.length, 1);
    diagnostics[0].message = "modified";
    const freshDiagnostics = registry.getDiagnostics();
    assert.strictEqual(freshDiagnostics[0].message, 'canonical name "plugin:skill" collision');
  });
});
describe("alias management", () => {
  let registry;
  beforeEach(() => {
    registry = new NamespacedRegistry();
  });
  describe("registerAlias", () => {
    it("should register an alias for an existing canonical name", () => {
      registry.register({
        name: "3d-visualizer",
        namespace: "python-tools",
        type: "skill",
        filePath: "/python-tools/3d-visualizer/SKILL.md",
        source: "plugin:python-tools",
        description: "3D visualization",
        metadata: {}
      });
      const result = registry.registerAlias("py3d", "python-tools:3d-visualizer");
      assert.strictEqual(result.success, true);
      assert.strictEqual(registry.hasAlias("py3d"), true);
      assert.strictEqual(registry.resolveAlias("py3d"), "python-tools:3d-visualizer");
    });
    it("should reject alias if target canonical name does not exist", () => {
      const result = registry.registerAlias("py3d", "nonexistent:skill");
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.reason, "canonical-not-found");
      assert.ok(result.message?.includes("does not exist"));
    });
    it("should reject alias that shadows an existing canonical name", () => {
      registry.register({
        name: "existing",
        namespace: "plugin",
        type: "skill",
        filePath: "/plugin/existing/SKILL.md",
        source: "plugin:plugin",
        description: "Existing skill",
        metadata: {}
      });
      registry.register({
        name: "other",
        namespace: "plugin",
        type: "skill",
        filePath: "/plugin/other/SKILL.md",
        source: "plugin:plugin",
        description: "Other skill",
        metadata: {}
      });
      const result = registry.registerAlias("plugin:existing", "plugin:other");
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.reason, "shadows-canonical");
      assert.ok(result.message?.includes("shadows an existing canonical name"));
    });
    it("should reject duplicate alias pointing to different target", () => {
      registry.register({
        name: "skill-a",
        namespace: "plugin",
        type: "skill",
        filePath: "/plugin/skill-a/SKILL.md",
        source: "plugin:plugin",
        description: "Skill A",
        metadata: {}
      });
      registry.register({
        name: "skill-b",
        namespace: "plugin",
        type: "skill",
        filePath: "/plugin/skill-b/SKILL.md",
        source: "plugin:plugin",
        description: "Skill B",
        metadata: {}
      });
      const first = registry.registerAlias("shortcut", "plugin:skill-a");
      assert.strictEqual(first.success, true);
      const second = registry.registerAlias("shortcut", "plugin:skill-b");
      assert.strictEqual(second.success, false);
      assert.strictEqual(second.reason, "duplicate-alias");
      assert.ok(second.message?.includes("already exists"));
    });
    it("should be idempotent for same alias and target", () => {
      registry.register({
        name: "skill",
        namespace: "plugin",
        type: "skill",
        filePath: "/plugin/skill/SKILL.md",
        source: "plugin:plugin",
        description: "Skill",
        metadata: {}
      });
      const first = registry.registerAlias("s", "plugin:skill");
      assert.strictEqual(first.success, true);
      const second = registry.registerAlias("s", "plugin:skill");
      assert.strictEqual(second.success, true);
    });
    it("should allow multiple aliases for same canonical name", () => {
      registry.register({
        name: "visualizer",
        namespace: "python-tools",
        type: "skill",
        filePath: "/python-tools/visualizer/SKILL.md",
        source: "plugin:python-tools",
        description: "Visualizer",
        metadata: {}
      });
      const r1 = registry.registerAlias("pyviz", "python-tools:visualizer");
      const r2 = registry.registerAlias("viz", "python-tools:visualizer");
      const r3 = registry.registerAlias("py3d", "python-tools:visualizer");
      assert.strictEqual(r1.success, true);
      assert.strictEqual(r2.success, true);
      assert.strictEqual(r3.success, true);
      assert.strictEqual(registry.resolveAlias("pyviz"), "python-tools:visualizer");
      assert.strictEqual(registry.resolveAlias("viz"), "python-tools:visualizer");
      assert.strictEqual(registry.resolveAlias("py3d"), "python-tools:visualizer");
    });
  });
  describe("resolveAlias", () => {
    it("should resolve registered alias to canonical name", () => {
      registry.register({
        name: "skill",
        namespace: "ns",
        type: "skill",
        filePath: "/ns/skill/SKILL.md",
        source: "plugin:ns",
        description: "Skill",
        metadata: {}
      });
      registry.registerAlias("s", "ns:skill");
      assert.strictEqual(registry.resolveAlias("s"), "ns:skill");
    });
    it("should return undefined for non-existent alias", () => {
      assert.strictEqual(registry.resolveAlias("nonexistent"), void 0);
    });
  });
  describe("removeAlias", () => {
    it("should remove an existing alias", () => {
      registry.register({
        name: "skill",
        namespace: "ns",
        type: "skill",
        filePath: "/ns/skill/SKILL.md",
        source: "plugin:ns",
        description: "Skill",
        metadata: {}
      });
      registry.registerAlias("s", "ns:skill");
      assert.strictEqual(registry.hasAlias("s"), true);
      const removed = registry.removeAlias("s");
      assert.strictEqual(removed, true);
      assert.strictEqual(registry.hasAlias("s"), false);
      assert.strictEqual(registry.resolveAlias("s"), void 0);
    });
    it("should return false for non-existent alias", () => {
      const removed = registry.removeAlias("nonexistent");
      assert.strictEqual(removed, false);
    });
  });
  describe("getAliases", () => {
    it("should return empty map when no aliases registered", () => {
      const aliases = registry.getAliases();
      assert.strictEqual(aliases.size, 0);
    });
    it("should return copy of alias map", () => {
      registry.register({
        name: "skill",
        namespace: "ns",
        type: "skill",
        filePath: "/ns/skill/SKILL.md",
        source: "plugin:ns",
        description: "Skill",
        metadata: {}
      });
      registry.registerAlias("s", "ns:skill");
      const aliases = registry.getAliases();
      assert.strictEqual(aliases.size, 1);
      assert.strictEqual(aliases.get("s"), "ns:skill");
      aliases.set("other", "ns:other");
      assert.strictEqual(registry.hasAlias("other"), false);
    });
    it("should include all registered aliases", () => {
      registry.register({
        name: "skill-a",
        namespace: "ns",
        type: "skill",
        filePath: "/ns/a/SKILL.md",
        source: "plugin:ns",
        description: "A",
        metadata: {}
      });
      registry.register({
        name: "skill-b",
        namespace: "ns",
        type: "skill",
        filePath: "/ns/b/SKILL.md",
        source: "plugin:ns",
        description: "B",
        metadata: {}
      });
      registry.registerAlias("sa", "ns:skill-a");
      registry.registerAlias("sb", "ns:skill-b");
      const aliases = registry.getAliases();
      assert.strictEqual(aliases.size, 2);
      assert.strictEqual(aliases.get("sa"), "ns:skill-a");
      assert.strictEqual(aliases.get("sb"), "ns:skill-b");
    });
  });
  describe("hasAlias", () => {
    it("should return true for registered alias", () => {
      registry.register({
        name: "skill",
        namespace: "ns",
        type: "skill",
        filePath: "/ns/skill/SKILL.md",
        source: "plugin:ns",
        description: "Skill",
        metadata: {}
      });
      registry.registerAlias("s", "ns:skill");
      assert.strictEqual(registry.hasAlias("s"), true);
    });
    it("should return false for non-existent alias", () => {
      assert.strictEqual(registry.hasAlias("nonexistent"), false);
    });
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9uYW1lc3BhY2VkLXJlZ2lzdHJ5LnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogTmFtZXNwYWNlZCBSZWdpc3RyeSBDb250cmFjdCBUZXN0c1xuICpcbiAqIFRlc3RzIHRoYXQgcHJvdmUgdGhlIG5hbWVzcGFjZWQgcmVnaXN0cnkgY29ycmVjdGx5IGhhbmRsZXM6XG4gKiAtIENhbm9uaWNhbCBpZGVudGl0eSAoUjAwNClcbiAqIC0gQ2Fub25pY2FsIHNraWxsIGxvb2t1cCAoUjAwNSlcbiAqIC0gQ2Fub25pY2FsIGFnZW50IGxvb2t1cCAoUjAwNilcbiAqIC0gRmxhdCBjb21wYXRpYmlsaXR5XG4gKiAtIENvbGxpc2lvbiBkZXRlY3Rpb25cbiAqIC0gTmFtZXNwYWNlIGxpc3RpbmdcbiAqIC0gSW50ZWdyYXRpb24gd2l0aCBTMDEgZGlzY292ZXJ5IHR5cGVzXG4gKi9cblxuaW1wb3J0IHsgZGVzY3JpYmUsIGl0LCBiZWZvcmVFYWNoIH0gZnJvbSAnbm9kZTp0ZXN0JztcbmltcG9ydCBhc3NlcnQgZnJvbSAnbm9kZTphc3NlcnQnO1xuaW1wb3J0IHtcblx0TmFtZXNwYWNlZFJlZ2lzdHJ5LFxuXHRjb21wb25lbnRzRnJvbURpc2NvdmVyeSxcbn0gZnJvbSAnLi4vbmFtZXNwYWNlZC1yZWdpc3RyeS5qcyc7XG5pbXBvcnQgdHlwZSB7IERpc2NvdmVyZWRQbHVnaW4gfSBmcm9tICcuLi9tYXJrZXRwbGFjZS1kaXNjb3ZlcnkuanMnO1xuXG5kZXNjcmliZSgnTmFtZXNwYWNlZFJlZ2lzdHJ5JywgKCkgPT4ge1xuXHRsZXQgcmVnaXN0cnk6IE5hbWVzcGFjZWRSZWdpc3RyeTtcblxuXHRiZWZvcmVFYWNoKCgpID0+IHtcblx0XHRyZWdpc3RyeSA9IG5ldyBOYW1lc3BhY2VkUmVnaXN0cnkoKTtcblx0fSk7XG5cblx0ZGVzY3JpYmUoJ2Nhbm9uaWNhbCByZWdpc3RyYXRpb24gYW5kIGxvb2t1cCcsICgpID0+IHtcblx0XHRpdCgnc2hvdWxkIHJlZ2lzdGVyIGEgbmFtZXNwYWNlZCBza2lsbCBhbmQgY29tcHV0ZSBjYW5vbmljYWwgbmFtZSAoUjAwNCwgUjAwNSknLCAoKSA9PiB7XG5cdFx0XHRjb25zdCBkaWFnbm9zdGljID0gcmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRuYW1lOiAnbXktc2tpbGwnLFxuXHRcdFx0XHRuYW1lc3BhY2U6ICdteS1wbHVnaW4nLFxuXHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRmaWxlUGF0aDogJy9wbHVnaW5zL215LXBsdWdpbi9za2lsbHMvbXktc2tpbGwvU0tJTEwubWQnLFxuXHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46bXktcGx1Z2luJyxcblx0XHRcdFx0ZGVzY3JpcHRpb246ICdBIHRlc3Qgc2tpbGwnLFxuXHRcdFx0XHRtZXRhZGF0YTogeyBwbHVnaW5WZXJzaW9uOiAnMS4wLjAnIH0sXG5cdFx0XHR9KTtcblxuXHRcdFx0Ly8gTm8gY29sbGlzaW9uIGRpYWdub3N0aWMgZXhwZWN0ZWRcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChkaWFnbm9zdGljLCB1bmRlZmluZWQpO1xuXG5cdFx0XHQvLyBWZXJpZnkgcmVnaXN0cmF0aW9uIHN1Y2NlZWRlZFxuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlZ2lzdHJ5LnNpemUsIDEpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlZ2lzdHJ5LmhhcygnbXktcGx1Z2luOm15LXNraWxsJyksIHRydWUpO1xuXG5cdFx0XHQvLyBMb29rdXAgYnkgY2Fub25pY2FsIG5hbWVcblx0XHRcdGNvbnN0IGNvbXBvbmVudCA9IHJlZ2lzdHJ5LmdldEJ5Q2Fub25pY2FsKCdteS1wbHVnaW46bXktc2tpbGwnKTtcblx0XHRcdGFzc2VydC5vayhjb21wb25lbnQgIT09IHVuZGVmaW5lZCk7XG5cblx0XHRcdC8vIFZlcmlmeSBjYW5vbmljYWwgaWRlbnRpdHkgcHJlc2VydmVkIChSMDA0KVxuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKGNvbXBvbmVudC5uYW1lLCAnbXktc2tpbGwnKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChjb21wb25lbnQubmFtZXNwYWNlLCAnbXktcGx1Z2luJyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoY29tcG9uZW50LmNhbm9uaWNhbE5hbWUsICdteS1wbHVnaW46bXktc2tpbGwnKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChjb21wb25lbnQudHlwZSwgJ3NraWxsJyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoY29tcG9uZW50LmZpbGVQYXRoLCAnL3BsdWdpbnMvbXktcGx1Z2luL3NraWxscy9teS1za2lsbC9TS0lMTC5tZCcpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKGNvbXBvbmVudC5zb3VyY2UsICdwbHVnaW46bXktcGx1Z2luJyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoY29tcG9uZW50LmRlc2NyaXB0aW9uLCAnQSB0ZXN0IHNraWxsJyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoY29tcG9uZW50Lm1ldGFkYXRhLnBsdWdpblZlcnNpb24sICcxLjAuMCcpO1xuXHRcdH0pO1xuXG5cdFx0aXQoJ3Nob3VsZCByZWdpc3RlciBhIG5hbWVzcGFjZWQgYWdlbnQgYW5kIGNvbXB1dGUgY2Fub25pY2FsIG5hbWUgKFIwMDYpJywgKCkgPT4ge1xuXHRcdFx0Y29uc3QgZGlhZ25vc3RpYyA9IHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0bmFtZTogJ2FiYnknLFxuXHRcdFx0XHRuYW1lc3BhY2U6ICdmYXJtJyxcblx0XHRcdFx0dHlwZTogJ2FnZW50Jyxcblx0XHRcdFx0ZmlsZVBhdGg6ICcvcGx1Z2lucy9mYXJtL2FnZW50cy9hYmJ5L0FHRU5ULm1kJyxcblx0XHRcdFx0c291cmNlOiAncGx1Z2luOmZhcm0nLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogJ0EgZmFybSBhZ2VudCcsXG5cdFx0XHRcdG1ldGFkYXRhOiB7IHBsdWdpbkF1dGhvcjogJ2Zhcm0tdGVhbScgfSxcblx0XHRcdH0pO1xuXG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoZGlhZ25vc3RpYywgdW5kZWZpbmVkKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZWdpc3RyeS5zaXplLCAxKTtcblxuXHRcdFx0Ly8gTG9va3VwIGJ5IGNhbm9uaWNhbCBuYW1lIChSMDA2KVxuXHRcdFx0Y29uc3QgYWdlbnQgPSByZWdpc3RyeS5nZXRCeUNhbm9uaWNhbCgnZmFybTphYmJ5Jyk7XG5cdFx0XHRhc3NlcnQub2soYWdlbnQgIT09IHVuZGVmaW5lZCk7XG5cblx0XHRcdC8vIFZlcmlmeSBjYW5vbmljYWwgaWRlbnRpdHkgKFIwMDQpXG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoYWdlbnQubmFtZSwgJ2FiYnknKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChhZ2VudC5uYW1lc3BhY2UsICdmYXJtJyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoYWdlbnQuY2Fub25pY2FsTmFtZSwgJ2Zhcm06YWJieScpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKGFnZW50LnR5cGUsICdhZ2VudCcpO1xuXHRcdH0pO1xuXG5cdFx0aXQoJ3Nob3VsZCByZXR1cm4gdW5kZWZpbmVkIGZvciBub24tZXhpc3RlbnQgY2Fub25pY2FsIG5hbWUnLCAoKSA9PiB7XG5cdFx0XHRjb25zdCByZXN1bHQgPSByZWdpc3RyeS5nZXRCeUNhbm9uaWNhbCgnbm9uZXhpc3RlbnQ6c2tpbGwnKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQsIHVuZGVmaW5lZCk7XG5cdFx0fSk7XG5cdH0pO1xuXG5cdGRlc2NyaWJlKCdmbGF0IChub24tbmFtZXNwYWNlZCkgY29tcGF0aWJpbGl0eScsICgpID0+IHtcblx0XHRpdCgnc2hvdWxkIHJlZ2lzdGVyIGZsYXQgY29tcG9uZW50IHdpdGggYmFyZSBuYW1lIGFzIGNhbm9uaWNhbCcsICgpID0+IHtcblx0XHRcdGNvbnN0IGRpYWdub3N0aWMgPSByZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRcdG5hbWU6ICdjb2RlLXJldmlldycsXG5cdFx0XHRcdG5hbWVzcGFjZTogdW5kZWZpbmVkLFxuXHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRmaWxlUGF0aDogJy9za2lsbHMvY29kZS1yZXZpZXcvU0tJTEwubWQnLFxuXHRcdFx0XHRzb3VyY2U6ICd1c2VyJyxcblx0XHRcdFx0ZGVzY3JpcHRpb246ICdBIGZsYXQgc2tpbGwnLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblxuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKGRpYWdub3N0aWMsIHVuZGVmaW5lZCk7XG5cblx0XHRcdC8vIExvb2t1cCBieSBiYXJlIG5hbWUgKG5vIG5hbWVzcGFjZSBwcmVmaXgpXG5cdFx0XHRjb25zdCBza2lsbCA9IHJlZ2lzdHJ5LmdldEJ5Q2Fub25pY2FsKCdjb2RlLXJldmlldycpO1xuXHRcdFx0YXNzZXJ0Lm9rKHNraWxsICE9PSB1bmRlZmluZWQpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHNraWxsLm5hbWUsICdjb2RlLXJldmlldycpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHNraWxsLm5hbWVzcGFjZSwgdW5kZWZpbmVkKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChza2lsbC5jYW5vbmljYWxOYW1lLCAnY29kZS1yZXZpZXcnKTtcblx0XHR9KTtcblxuXHRcdGl0KCdzaG91bGQgcmV0cmlldmUgZmxhdCBjb21wb25lbnQgYnkgYmFyZSBuYW1lJywgKCkgPT4ge1xuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRuYW1lOiAndGVzdC1za2lsbCcsXG5cdFx0XHRcdG5hbWVzcGFjZTogdW5kZWZpbmVkLFxuXHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRmaWxlUGF0aDogJy9za2lsbHMvdGVzdC1za2lsbC9TS0lMTC5tZCcsXG5cdFx0XHRcdHNvdXJjZTogJ3Byb2plY3QnLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogdW5kZWZpbmVkLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblxuXHRcdFx0Y29uc3Qgc2tpbGwgPSByZWdpc3RyeS5nZXRCeUNhbm9uaWNhbCgndGVzdC1za2lsbCcpO1xuXHRcdFx0YXNzZXJ0Lm9rKHNraWxsICE9PSB1bmRlZmluZWQpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHNraWxsLmNhbm9uaWNhbE5hbWUsICd0ZXN0LXNraWxsJyk7XG5cdFx0fSk7XG5cdH0pO1xuXG5cdGRlc2NyaWJlKCdjb2xsaXNpb24gZGV0ZWN0aW9uJywgKCkgPT4ge1xuXHRcdGl0KCdzaG91bGQgZGV0ZWN0IGNvbGxpc2lvbiBvbiBkdXBsaWNhdGUgY2Fub25pY2FsIG5hbWUgYW5kIGVtaXQgZGlhZ25vc3RpYycsICgpID0+IHtcblx0XHRcdC8vIEZpcnN0IHJlZ2lzdHJhdGlvbiB3aW5zXG5cdFx0XHRjb25zdCBmaXJzdCA9IHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0bmFtZTogJ2NvZGUtcmV2aWV3Jyxcblx0XHRcdFx0bmFtZXNwYWNlOiAnbXktcGx1Z2luJyxcblx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0ZmlsZVBhdGg6ICcvcGx1Z2lucy9teS1wbHVnaW4vc2tpbGxzL2NvZGUtcmV2aWV3L1NLSUxMLm1kJyxcblx0XHRcdFx0c291cmNlOiAncGx1Z2luOm15LXBsdWdpbicsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiAnRmlyc3Qgc2tpbGwnLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChmaXJzdCwgdW5kZWZpbmVkKTtcblxuXHRcdFx0Ly8gU2Vjb25kIHJlZ2lzdHJhdGlvbiBjb2xsaWRlc1xuXHRcdFx0Y29uc3Qgc2Vjb25kID0gcmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRuYW1lOiAnY29kZS1yZXZpZXcnLFxuXHRcdFx0XHRuYW1lc3BhY2U6ICdteS1wbHVnaW4nLFxuXHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRmaWxlUGF0aDogJy9wbHVnaW5zL290aGVyLXBsdWdpbi9za2lsbHMvY29kZS1yZXZpZXcvU0tJTEwubWQnLFxuXHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46b3RoZXItcGx1Z2luJyxcblx0XHRcdFx0ZGVzY3JpcHRpb246ICdTZWNvbmQgc2tpbGwnLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblxuXHRcdFx0Ly8gU2hvdWxkIHJldHVybiBjb2xsaXNpb24gZGlhZ25vc3RpY1xuXHRcdFx0YXNzZXJ0Lm9rKHNlY29uZCAhPT0gdW5kZWZpbmVkKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChzZWNvbmQudHlwZSwgJ2NvbGxpc2lvbicpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHNlY29uZC5tZXNzYWdlLCAnY2Fub25pY2FsIG5hbWUgXCJteS1wbHVnaW46Y29kZS1yZXZpZXdcIiBjb2xsaXNpb24nKTtcblxuXHRcdFx0Ly8gVmVyaWZ5IGNvbGxpc2lvbiBkZXRhaWxzXG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoc2Vjb25kLmNvbGxpc2lvbi5jYW5vbmljYWxOYW1lLCAnbXktcGx1Z2luOmNvZGUtcmV2aWV3Jyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoc2Vjb25kLmNvbGxpc2lvbi53aW5uZXJQYXRoLCAnL3BsdWdpbnMvbXktcGx1Z2luL3NraWxscy9jb2RlLXJldmlldy9TS0lMTC5tZCcpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHNlY29uZC5jb2xsaXNpb24ubG9zZXJQYXRoLCAnL3BsdWdpbnMvb3RoZXItcGx1Z2luL3NraWxscy9jb2RlLXJldmlldy9TS0lMTC5tZCcpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHNlY29uZC5jb2xsaXNpb24ud2lubmVyU291cmNlLCAncGx1Z2luOm15LXBsdWdpbicpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHNlY29uZC5jb2xsaXNpb24ubG9zZXJTb3VyY2UsICdwbHVnaW46b3RoZXItcGx1Z2luJyk7XG5cdFx0fSk7XG5cblx0XHRpdCgnc2hvdWxkIHByZXNlcnZlIGZpcnN0LXdpbnMgYmVoYXZpb3Igb24gY29sbGlzaW9uJywgKCkgPT4ge1xuXHRcdFx0Ly8gUmVnaXN0ZXIgZmlyc3Rcblx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0bmFtZTogJ3NraWxsJyxcblx0XHRcdFx0bmFtZXNwYWNlOiAnbnMnLFxuXHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRmaWxlUGF0aDogJy9maXJzdC9TS0lMTC5tZCcsXG5cdFx0XHRcdHNvdXJjZTogJ2ZpcnN0Jyxcblx0XHRcdFx0ZGVzY3JpcHRpb246ICdGaXJzdCBkZXNjcmlwdGlvbicsXG5cdFx0XHRcdG1ldGFkYXRhOiB7IGtleTogJ2ZpcnN0LXZhbHVlJyB9LFxuXHRcdFx0fSk7XG5cblx0XHRcdC8vIEF0dGVtcHQgZHVwbGljYXRlXG5cdFx0XHRyZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRcdG5hbWU6ICdza2lsbCcsXG5cdFx0XHRcdG5hbWVzcGFjZTogJ25zJyxcblx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0ZmlsZVBhdGg6ICcvc2Vjb25kL1NLSUxMLm1kJyxcblx0XHRcdFx0c291cmNlOiAnc2Vjb25kJyxcblx0XHRcdFx0ZGVzY3JpcHRpb246ICdTZWNvbmQgZGVzY3JpcHRpb24nLFxuXHRcdFx0XHRtZXRhZGF0YTogeyBrZXk6ICdzZWNvbmQtdmFsdWUnIH0sXG5cdFx0XHR9KTtcblxuXHRcdFx0Ly8gRmlyc3QgcmVnaXN0cmF0aW9uIHdpbnNcblx0XHRcdGNvbnN0IGNvbXBvbmVudCA9IHJlZ2lzdHJ5LmdldEJ5Q2Fub25pY2FsKCduczpza2lsbCcpO1xuXHRcdFx0YXNzZXJ0Lm9rKGNvbXBvbmVudCAhPT0gdW5kZWZpbmVkKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChjb21wb25lbnQuZmlsZVBhdGgsICcvZmlyc3QvU0tJTEwubWQnKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChjb21wb25lbnQuc291cmNlLCAnZmlyc3QnKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChjb21wb25lbnQuZGVzY3JpcHRpb24sICdGaXJzdCBkZXNjcmlwdGlvbicpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKGNvbXBvbmVudC5tZXRhZGF0YS5rZXksICdmaXJzdC12YWx1ZScpO1xuXHRcdH0pO1xuXG5cdFx0aXQoJ3Nob3VsZCBjb2xsZWN0IG11bHRpcGxlIGNvbGxpc2lvbiBkaWFnbm9zdGljcycsICgpID0+IHtcblx0XHRcdC8vIEZpcnN0IHJlZ2lzdHJhdGlvbnNcblx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0bmFtZTogJ3NraWxsLWEnLFxuXHRcdFx0XHRuYW1lc3BhY2U6ICdwbHVnaW4teCcsXG5cdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdGZpbGVQYXRoOiAnL3gvYS5tZCcsXG5cdFx0XHRcdHNvdXJjZTogJ3gnLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogdW5kZWZpbmVkLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0bmFtZTogJ3NraWxsLWInLFxuXHRcdFx0XHRuYW1lc3BhY2U6ICdwbHVnaW4teScsXG5cdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdGZpbGVQYXRoOiAnL3kvYi5tZCcsXG5cdFx0XHRcdHNvdXJjZTogJ3knLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogdW5kZWZpbmVkLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblxuXHRcdFx0Ly8gQ29sbGlzaW9uc1xuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRuYW1lOiAnc2tpbGwtYScsXG5cdFx0XHRcdG5hbWVzcGFjZTogJ3BsdWdpbi14Jyxcblx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0ZmlsZVBhdGg6ICcvei9hLm1kJyxcblx0XHRcdFx0c291cmNlOiAneicsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiB1bmRlZmluZWQsXG5cdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdH0pO1xuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRuYW1lOiAnc2tpbGwtYicsXG5cdFx0XHRcdG5hbWVzcGFjZTogJ3BsdWdpbi15Jyxcblx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0ZmlsZVBhdGg6ICcvdy9iLm1kJyxcblx0XHRcdFx0c291cmNlOiAndycsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiB1bmRlZmluZWQsXG5cdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdH0pO1xuXG5cdFx0XHRjb25zdCBkaWFnbm9zdGljcyA9IHJlZ2lzdHJ5LmdldERpYWdub3N0aWNzKCk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoZGlhZ25vc3RpY3MubGVuZ3RoLCAyKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChkaWFnbm9zdGljc1swXS5jb2xsaXNpb24uY2Fub25pY2FsTmFtZSwgJ3BsdWdpbi14OnNraWxsLWEnKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChkaWFnbm9zdGljc1sxXS5jb2xsaXNpb24uY2Fub25pY2FsTmFtZSwgJ3BsdWdpbi15OnNraWxsLWInKTtcblx0XHR9KTtcblxuXHRcdGl0KCdzaG91bGQgYWxsb3cgc2FtZSBuYW1lIGluIGRpZmZlcmVudCBuYW1lc3BhY2VzJywgKCkgPT4ge1xuXHRcdFx0Ly8gU2FtZSBuYW1lLCBkaWZmZXJlbnQgbmFtZXNwYWNlXG5cdFx0XHRyZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRcdG5hbWU6ICdjb2RlLXJldmlldycsXG5cdFx0XHRcdG5hbWVzcGFjZTogJ3BsdWdpbi1hJyxcblx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0ZmlsZVBhdGg6ICcvYS9jb2RlLXJldmlldy5tZCcsXG5cdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjpwbHVnaW4tYScsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiB1bmRlZmluZWQsXG5cdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdH0pO1xuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRuYW1lOiAnY29kZS1yZXZpZXcnLFxuXHRcdFx0XHRuYW1lc3BhY2U6ICdwbHVnaW4tYicsXG5cdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdGZpbGVQYXRoOiAnL2IvY29kZS1yZXZpZXcubWQnLFxuXHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46cGx1Z2luLWInLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogdW5kZWZpbmVkLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblxuXHRcdFx0Ly8gQm90aCBzaG91bGQgYmUgcmVnaXN0ZXJlZFxuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlZ2lzdHJ5LnNpemUsIDIpO1xuXG5cdFx0XHRjb25zdCBhID0gcmVnaXN0cnkuZ2V0QnlDYW5vbmljYWwoJ3BsdWdpbi1hOmNvZGUtcmV2aWV3Jyk7XG5cdFx0XHRjb25zdCBiID0gcmVnaXN0cnkuZ2V0QnlDYW5vbmljYWwoJ3BsdWdpbi1iOmNvZGUtcmV2aWV3Jyk7XG5cblx0XHRcdGFzc2VydC5vayhhICE9PSB1bmRlZmluZWQpO1xuXHRcdFx0YXNzZXJ0Lm9rKGIgIT09IHVuZGVmaW5lZCk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoYS5maWxlUGF0aCwgJy9hL2NvZGUtcmV2aWV3Lm1kJyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoYi5maWxlUGF0aCwgJy9iL2NvZGUtcmV2aWV3Lm1kJyk7XG5cblx0XHRcdC8vIE5vIGNvbGxpc2lvbnNcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZWdpc3RyeS5nZXREaWFnbm9zdGljcygpLmxlbmd0aCwgMCk7XG5cdFx0fSk7XG5cblx0XHRpdCgnc2hvdWxkIGFsbG93IGZsYXQgYW5kIG5hbWVzcGFjZWQgY29tcG9uZW50cyB3aXRoIHNhbWUgbG9jYWwgbmFtZScsICgpID0+IHtcblx0XHRcdC8vIEZsYXQgY29tcG9uZW50XG5cdFx0XHRyZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRcdG5hbWU6ICdjb2RlLXJldmlldycsXG5cdFx0XHRcdG5hbWVzcGFjZTogdW5kZWZpbmVkLFxuXHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRmaWxlUGF0aDogJy9mbGF0L2NvZGUtcmV2aWV3Lm1kJyxcblx0XHRcdFx0c291cmNlOiAndXNlcicsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiB1bmRlZmluZWQsXG5cdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdH0pO1xuXG5cdFx0XHQvLyBOYW1lc3BhY2VkIGNvbXBvbmVudCB3aXRoIHNhbWUgbG9jYWwgbmFtZVxuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRuYW1lOiAnY29kZS1yZXZpZXcnLFxuXHRcdFx0XHRuYW1lc3BhY2U6ICdwbHVnaW4nLFxuXHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRmaWxlUGF0aDogJy9wbHVnaW4vY29kZS1yZXZpZXcubWQnLFxuXHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46cGx1Z2luJyxcblx0XHRcdFx0ZGVzY3JpcHRpb246IHVuZGVmaW5lZCxcblx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0fSk7XG5cblx0XHRcdC8vIEJvdGggc2hvdWxkIGJlIGFjY2Vzc2libGVcblx0XHRcdGNvbnN0IGZsYXQgPSByZWdpc3RyeS5nZXRCeUNhbm9uaWNhbCgnY29kZS1yZXZpZXcnKTtcblx0XHRcdGNvbnN0IG5hbWVzcGFjZWQgPSByZWdpc3RyeS5nZXRCeUNhbm9uaWNhbCgncGx1Z2luOmNvZGUtcmV2aWV3Jyk7XG5cblx0XHRcdGFzc2VydC5vayhmbGF0ICE9PSB1bmRlZmluZWQpO1xuXHRcdFx0YXNzZXJ0Lm9rKG5hbWVzcGFjZWQgIT09IHVuZGVmaW5lZCk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoZmxhdC5uYW1lc3BhY2UsIHVuZGVmaW5lZCk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwobmFtZXNwYWNlZC5uYW1lc3BhY2UsICdwbHVnaW4nKTtcblxuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlZ2lzdHJ5LmdldERpYWdub3N0aWNzKCkubGVuZ3RoLCAwKTtcblx0XHR9KTtcblx0fSk7XG5cblx0ZGVzY3JpYmUoJ25hbWVzcGFjZSBsaXN0aW5nJywgKCkgPT4ge1xuXHRcdGl0KCdzaG91bGQgbGlzdCBhbGwgY29tcG9uZW50cyBpbiBhIG5hbWVzcGFjZSB2aWEgZ2V0QnlOYW1lc3BhY2UnLCAoKSA9PiB7XG5cdFx0XHQvLyBSZWdpc3RlciBtdWx0aXBsZSBjb21wb25lbnRzIGluIHBsdWdpbi1hXG5cdFx0XHRyZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRcdG5hbWU6ICdza2lsbC0xJyxcblx0XHRcdFx0bmFtZXNwYWNlOiAncGx1Z2luLWEnLFxuXHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRmaWxlUGF0aDogJy9hL3NraWxsLTEubWQnLFxuXHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46cGx1Z2luLWEnLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogdW5kZWZpbmVkLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0bmFtZTogJ3NraWxsLTInLFxuXHRcdFx0XHRuYW1lc3BhY2U6ICdwbHVnaW4tYScsXG5cdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdGZpbGVQYXRoOiAnL2Evc2tpbGwtMi5tZCcsXG5cdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjpwbHVnaW4tYScsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiB1bmRlZmluZWQsXG5cdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdH0pO1xuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRuYW1lOiAnYWdlbnQtMScsXG5cdFx0XHRcdG5hbWVzcGFjZTogJ3BsdWdpbi1hJyxcblx0XHRcdFx0dHlwZTogJ2FnZW50Jyxcblx0XHRcdFx0ZmlsZVBhdGg6ICcvYS9hZ2VudC0xLm1kJyxcblx0XHRcdFx0c291cmNlOiAncGx1Z2luOnBsdWdpbi1hJyxcblx0XHRcdFx0ZGVzY3JpcHRpb246IHVuZGVmaW5lZCxcblx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0fSk7XG5cblx0XHRcdC8vIFJlZ2lzdGVyIGNvbXBvbmVudCBpbiBkaWZmZXJlbnQgbmFtZXNwYWNlXG5cdFx0XHRyZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRcdG5hbWU6ICdza2lsbC0zJyxcblx0XHRcdFx0bmFtZXNwYWNlOiAncGx1Z2luLWInLFxuXHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRmaWxlUGF0aDogJy9iL3NraWxsLTMubWQnLFxuXHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46cGx1Z2luLWInLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogdW5kZWZpbmVkLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblxuXHRcdFx0Y29uc3QgcGx1Z2luQUNvbXBvbmVudHMgPSByZWdpc3RyeS5nZXRCeU5hbWVzcGFjZSgncGx1Z2luLWEnKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChwbHVnaW5BQ29tcG9uZW50cy5sZW5ndGgsIDMpO1xuXG5cdFx0XHRjb25zdCBuYW1lcyA9IHBsdWdpbkFDb21wb25lbnRzLm1hcCgoYykgPT4gYy5uYW1lKS5zb3J0KCk7XG5cdFx0XHRhc3NlcnQuZGVlcFN0cmljdEVxdWFsKG5hbWVzLCBbJ2FnZW50LTEnLCAnc2tpbGwtMScsICdza2lsbC0yJ10pO1xuXG5cdFx0XHQvLyBBbGwgc2hvdWxkIGhhdmUgY29ycmVjdCBuYW1lc3BhY2Vcblx0XHRcdGFzc2VydC5vayhwbHVnaW5BQ29tcG9uZW50cy5ldmVyeSgoYykgPT4gYy5uYW1lc3BhY2UgPT09ICdwbHVnaW4tYScpKTtcblx0XHR9KTtcblxuXHRcdGl0KCdzaG91bGQgcmV0dXJuIGVtcHR5IGFycmF5IGZvciBub24tZXhpc3RlbnQgbmFtZXNwYWNlJywgKCkgPT4ge1xuXHRcdFx0Y29uc3QgcmVzdWx0ID0gcmVnaXN0cnkuZ2V0QnlOYW1lc3BhY2UoJ25vbmV4aXN0ZW50Jyk7XG5cdFx0XHRhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdCwgW10pO1xuXHRcdH0pO1xuXG5cdFx0aXQoJ3Nob3VsZCBub3QgaW5jbHVkZSBmbGF0IGNvbXBvbmVudHMgaW4gbmFtZXNwYWNlIGxpc3RpbmcnLCAoKSA9PiB7XG5cdFx0XHQvLyBGbGF0IGNvbXBvbmVudFxuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRuYW1lOiAnZmxhdC1za2lsbCcsXG5cdFx0XHRcdG5hbWVzcGFjZTogdW5kZWZpbmVkLFxuXHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRmaWxlUGF0aDogJy9mbGF0Lm1kJyxcblx0XHRcdFx0c291cmNlOiAndXNlcicsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiB1bmRlZmluZWQsXG5cdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdH0pO1xuXG5cdFx0XHQvLyBOYW1lc3BhY2VkIGNvbXBvbmVudFxuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRuYW1lOiAnbnMtc2tpbGwnLFxuXHRcdFx0XHRuYW1lc3BhY2U6ICdwbHVnaW4nLFxuXHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRmaWxlUGF0aDogJy9wbHVnaW4vbnMtc2tpbGwubWQnLFxuXHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46cGx1Z2luJyxcblx0XHRcdFx0ZGVzY3JpcHRpb246IHVuZGVmaW5lZCxcblx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0fSk7XG5cblx0XHRcdC8vIEZsYXQgY29tcG9uZW50cyBoYXZlIG5hbWVzcGFjZT11bmRlZmluZWQsIG5vdCBpbmNsdWRlZFxuXHRcdFx0Y29uc3QgcGx1Z2luQ29tcG9uZW50cyA9IHJlZ2lzdHJ5LmdldEJ5TmFtZXNwYWNlKCdwbHVnaW4nKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChwbHVnaW5Db21wb25lbnRzLmxlbmd0aCwgMSk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocGx1Z2luQ29tcG9uZW50c1swXS5uYW1lLCAnbnMtc2tpbGwnKTtcblx0XHR9KTtcblx0fSk7XG5cblx0ZGVzY3JpYmUoJ21peGVkIGNvZXhpc3RlbmNlJywgKCkgPT4ge1xuXHRcdGl0KCdzaG91bGQgYWxsb3cgYm90aCBuYW1lc3BhY2VkIGFuZCBmbGF0IGNvbXBvbmVudHMgd2l0aG91dCBpbnRlcmZlcmVuY2UnLCAoKSA9PiB7XG5cdFx0XHQvLyBGbGF0IHNraWxsXG5cdFx0XHRyZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRcdG5hbWU6ICdyZXZpZXcnLFxuXHRcdFx0XHRuYW1lc3BhY2U6IHVuZGVmaW5lZCxcblx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0ZmlsZVBhdGg6ICcvc2tpbGxzL3Jldmlldy9TS0lMTC5tZCcsXG5cdFx0XHRcdHNvdXJjZTogJ3VzZXInLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogJ1VzZXIgc2tpbGwnLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblxuXHRcdFx0Ly8gTmFtZXNwYWNlZCBza2lsbFxuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRuYW1lOiAncmV2aWV3Jyxcblx0XHRcdFx0bmFtZXNwYWNlOiAnbXktcGx1Z2luJyxcblx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0ZmlsZVBhdGg6ICcvcGx1Z2lucy9teS1wbHVnaW4vc2tpbGxzL3Jldmlldy9TS0lMTC5tZCcsXG5cdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjpteS1wbHVnaW4nLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogJ1BsdWdpbiBza2lsbCcsXG5cdFx0XHRcdG1ldGFkYXRhOiB7IHBsdWdpblZlcnNpb246ICcxLjAuMCcgfSxcblx0XHRcdH0pO1xuXG5cdFx0XHQvLyBOYW1lc3BhY2VkIGFnZW50XG5cdFx0XHRyZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRcdG5hbWU6ICdidWlsZGVyJyxcblx0XHRcdFx0bmFtZXNwYWNlOiAnbXktcGx1Z2luJyxcblx0XHRcdFx0dHlwZTogJ2FnZW50Jyxcblx0XHRcdFx0ZmlsZVBhdGg6ICcvcGx1Z2lucy9teS1wbHVnaW4vYWdlbnRzL2J1aWxkZXIvQUdFTlQubWQnLFxuXHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46bXktcGx1Z2luJyxcblx0XHRcdFx0ZGVzY3JpcHRpb246ICdQbHVnaW4gYWdlbnQnLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblxuXHRcdFx0Ly8gRmxhdCBhZ2VudFxuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRuYW1lOiAnYXNzaXN0YW50Jyxcblx0XHRcdFx0bmFtZXNwYWNlOiB1bmRlZmluZWQsXG5cdFx0XHRcdHR5cGU6ICdhZ2VudCcsXG5cdFx0XHRcdGZpbGVQYXRoOiAnL2FnZW50cy9hc3Npc3RhbnQvQUdFTlQubWQnLFxuXHRcdFx0XHRzb3VyY2U6ICdwcm9qZWN0Jyxcblx0XHRcdFx0ZGVzY3JpcHRpb246ICdQcm9qZWN0IGFnZW50Jyxcblx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0fSk7XG5cblx0XHRcdC8vIFZlcmlmeSB0b3RhbCBjb3VudFxuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlZ2lzdHJ5LnNpemUsIDQpO1xuXG5cdFx0XHQvLyBGbGF0IHNraWxsXG5cdFx0XHRjb25zdCBmbGF0U2tpbGwgPSByZWdpc3RyeS5nZXRCeUNhbm9uaWNhbCgncmV2aWV3Jyk7XG5cdFx0XHRhc3NlcnQub2soZmxhdFNraWxsICE9PSB1bmRlZmluZWQpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKGZsYXRTa2lsbC5uYW1lc3BhY2UsIHVuZGVmaW5lZCk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoZmxhdFNraWxsLnR5cGUsICdza2lsbCcpO1xuXG5cdFx0XHQvLyBOYW1lc3BhY2VkIHNraWxsXG5cdFx0XHRjb25zdCBuc1NraWxsID0gcmVnaXN0cnkuZ2V0QnlDYW5vbmljYWwoJ215LXBsdWdpbjpyZXZpZXcnKTtcblx0XHRcdGFzc2VydC5vayhuc1NraWxsICE9PSB1bmRlZmluZWQpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKG5zU2tpbGwubmFtZXNwYWNlLCAnbXktcGx1Z2luJyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwobnNTa2lsbC50eXBlLCAnc2tpbGwnKTtcblxuXHRcdFx0Ly8gTmFtZXNwYWNlZCBhZ2VudFxuXHRcdFx0Y29uc3QgbnNBZ2VudCA9IHJlZ2lzdHJ5LmdldEJ5Q2Fub25pY2FsKCdteS1wbHVnaW46YnVpbGRlcicpO1xuXHRcdFx0YXNzZXJ0Lm9rKG5zQWdlbnQgIT09IHVuZGVmaW5lZCk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwobnNBZ2VudC5uYW1lc3BhY2UsICdteS1wbHVnaW4nKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChuc0FnZW50LnR5cGUsICdhZ2VudCcpO1xuXG5cdFx0XHQvLyBGbGF0IGFnZW50XG5cdFx0XHRjb25zdCBmbGF0QWdlbnQgPSByZWdpc3RyeS5nZXRCeUNhbm9uaWNhbCgnYXNzaXN0YW50Jyk7XG5cdFx0XHRhc3NlcnQub2soZmxhdEFnZW50ICE9PSB1bmRlZmluZWQpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKGZsYXRBZ2VudC5uYW1lc3BhY2UsIHVuZGVmaW5lZCk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoZmxhdEFnZW50LnR5cGUsICdhZ2VudCcpO1xuXG5cdFx0XHQvLyBOYW1lc3BhY2UgbGlzdGluZ1xuXHRcdFx0Y29uc3QgbXlQbHVnaW5Db21wb25lbnRzID0gcmVnaXN0cnkuZ2V0QnlOYW1lc3BhY2UoJ215LXBsdWdpbicpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKG15UGx1Z2luQ29tcG9uZW50cy5sZW5ndGgsIDIpO1xuXG5cdFx0XHQvLyBObyBjb2xsaXNpb25zXG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVnaXN0cnkuZ2V0RGlhZ25vc3RpY3MoKS5sZW5ndGgsIDApO1xuXHRcdH0pO1xuXHR9KTtcblxuXHRkZXNjcmliZSgnZ2V0QWxsIGFuZCBoYXMnLCAoKSA9PiB7XG5cdFx0aXQoJ3Nob3VsZCByZXR1cm4gYWxsIGNvbXBvbmVudHMgdmlhIGdldEFsbCcsICgpID0+IHtcblx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0bmFtZTogJ3NraWxsLTEnLFxuXHRcdFx0XHRuYW1lc3BhY2U6ICdwbHVnaW4tYScsXG5cdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdGZpbGVQYXRoOiAnL2EvczEubWQnLFxuXHRcdFx0XHRzb3VyY2U6ICdhJyxcblx0XHRcdFx0ZGVzY3JpcHRpb246IHVuZGVmaW5lZCxcblx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0fSk7XG5cdFx0XHRyZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRcdG5hbWU6ICdza2lsbC0yJyxcblx0XHRcdFx0bmFtZXNwYWNlOiB1bmRlZmluZWQsXG5cdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdGZpbGVQYXRoOiAnL3MyLm1kJyxcblx0XHRcdFx0c291cmNlOiAndXNlcicsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiB1bmRlZmluZWQsXG5cdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdH0pO1xuXG5cdFx0XHRjb25zdCBhbGwgPSByZWdpc3RyeS5nZXRBbGwoKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChhbGwubGVuZ3RoLCAyKTtcblxuXHRcdFx0Y29uc3QgY2Fub25pY2FsTmFtZXMgPSBhbGwubWFwKChjKSA9PiBjLmNhbm9uaWNhbE5hbWUpLnNvcnQoKTtcblx0XHRcdGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoY2Fub25pY2FsTmFtZXMsIFsncGx1Z2luLWE6c2tpbGwtMScsICdza2lsbC0yJ10pO1xuXHRcdH0pO1xuXG5cdFx0aXQoJ3Nob3VsZCBjaGVjayBleGlzdGVuY2UgdmlhIGhhcycsICgpID0+IHtcblx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0bmFtZTogJ3Rlc3QnLFxuXHRcdFx0XHRuYW1lc3BhY2U6ICducycsXG5cdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdGZpbGVQYXRoOiAnL3Rlc3QubWQnLFxuXHRcdFx0XHRzb3VyY2U6ICd0ZXN0Jyxcblx0XHRcdFx0ZGVzY3JpcHRpb246IHVuZGVmaW5lZCxcblx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0fSk7XG5cblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZWdpc3RyeS5oYXMoJ25zOnRlc3QnKSwgdHJ1ZSk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVnaXN0cnkuaGFzKCduczpvdGhlcicpLCBmYWxzZSk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVnaXN0cnkuaGFzKCd0ZXN0JyksIGZhbHNlKTtcblx0XHR9KTtcblx0fSk7XG59KTtcblxuZGVzY3JpYmUoJ2NvbXBvbmVudHNGcm9tRGlzY292ZXJ5JywgKCkgPT4ge1xuXHRpdCgnc2hvdWxkIGNvbnZlcnQgRGlzY292ZXJlZFBsdWdpbiB0byByZWdpc3RlcmFibGUgY29tcG9uZW50cycsICgpID0+IHtcblx0XHRjb25zdCBtb2NrUGx1Z2luOiBEaXNjb3ZlcmVkUGx1Z2luID0ge1xuXHRcdFx0bmFtZTogJ3Rlc3QtcGx1Z2luJyxcblx0XHRcdGNhbm9uaWNhbE5hbWU6ICd0ZXN0LXBsdWdpbicsXG5cdFx0XHRzb3VyY2U6ICcuL3BsdWdpbnMvdGVzdC1wbHVnaW4nLFxuXHRcdFx0cmVzb2x2ZWRQYXRoOiAnL3BsdWdpbnMvdGVzdC1wbHVnaW4nLFxuXHRcdFx0c3RhdHVzOiAnb2snLFxuXHRcdFx0bWFuaWZlc3RTb3VyY2U6ICdwbHVnaW4uanNvbicsXG5cdFx0XHRkZXNjcmlwdGlvbjogJ0EgdGVzdCBwbHVnaW4nLFxuXHRcdFx0dmVyc2lvbjogJzEuMC4wJyxcblx0XHRcdGF1dGhvcjogeyBuYW1lOiAnVGVzdCBBdXRob3InIH0sXG5cdFx0XHRjYXRlZ29yeTogJ3Rlc3RpbmcnLFxuXHRcdFx0aG9tZXBhZ2U6ICdodHRwczovL2V4YW1wbGUuY29tL3Rlc3QtcGx1Z2luJyxcblx0XHRcdGludmVudG9yeToge1xuXHRcdFx0XHRza2lsbHM6IFsnc2tpbGwtYScsICdza2lsbC1iJ10sXG5cdFx0XHRcdGFnZW50czogWydhZ2VudC14J10sXG5cdFx0XHRcdGNvbW1hbmRzOiBbXSxcblx0XHRcdFx0bWNwU2VydmVyczoge30sXG5cdFx0XHRcdGxzcFNlcnZlcnM6IHt9LFxuXHRcdFx0XHRob29rczogW10sXG5cdFx0XHR9LFxuXHRcdH07XG5cblx0XHRjb25zdCBjb21wb25lbnRzID0gY29tcG9uZW50c0Zyb21EaXNjb3ZlcnkobW9ja1BsdWdpbik7XG5cblx0XHQvLyBTaG91bGQgaGF2ZSAzIGNvbXBvbmVudHMgKDIgc2tpbGxzICsgMSBhZ2VudClcblx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoY29tcG9uZW50cy5sZW5ndGgsIDMpO1xuXG5cdFx0Ly8gQWxsIHNob3VsZCBoYXZlIHRoZSBwbHVnaW4ncyBjYW5vbmljYWwgbmFtZSBhcyBuYW1lc3BhY2Vcblx0XHRhc3NlcnQub2soY29tcG9uZW50cy5ldmVyeSgoYykgPT4gYy5uYW1lc3BhY2UgPT09ICd0ZXN0LXBsdWdpbicpKTtcblxuXHRcdC8vIFZlcmlmeSBza2lsbHNcblx0XHRjb25zdCBza2lsbHMgPSBjb21wb25lbnRzLmZpbHRlcigoYykgPT4gYy50eXBlID09PSAnc2tpbGwnKTtcblx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoc2tpbGxzLmxlbmd0aCwgMik7XG5cblx0XHRjb25zdCBza2lsbE5hbWVzID0gc2tpbGxzLm1hcCgoYykgPT4gYy5uYW1lKS5zb3J0KCk7XG5cdFx0YXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChza2lsbE5hbWVzLCBbJ3NraWxsLWEnLCAnc2tpbGwtYiddKTtcblxuXHRcdC8vIFZlcmlmeSBhZ2VudHNcblx0XHRjb25zdCBhZ2VudHMgPSBjb21wb25lbnRzLmZpbHRlcigoYykgPT4gYy50eXBlID09PSAnYWdlbnQnKTtcblx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoYWdlbnRzLmxlbmd0aCwgMSk7XG5cdFx0YXNzZXJ0LnN0cmljdEVxdWFsKGFnZW50c1swXS5uYW1lLCAnYWdlbnQteCcpO1xuXG5cdFx0Ly8gVmVyaWZ5IG1ldGFkYXRhIHByb3BhZ2F0aW9uXG5cdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHNraWxsc1swXS5tZXRhZGF0YS5wbHVnaW5WZXJzaW9uLCAnMS4wLjAnKTtcblx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoc2tpbGxzWzBdLm1ldGFkYXRhLnBsdWdpbkF1dGhvciwgJ1Rlc3QgQXV0aG9yJyk7XG5cdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHNraWxsc1swXS5tZXRhZGF0YS5wbHVnaW5Ib21lcGFnZSwgJ2h0dHBzOi8vZXhhbXBsZS5jb20vdGVzdC1wbHVnaW4nKTtcblx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoc2tpbGxzWzBdLm1ldGFkYXRhLnBsdWdpbkNhdGVnb3J5LCAndGVzdGluZycpO1xuXG5cdFx0Ly8gVmVyaWZ5IHNvdXJjZSBmb3JtYXRcblx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoc2tpbGxzWzBdLnNvdXJjZSwgJ3BsdWdpbjp0ZXN0LXBsdWdpbicpO1xuXHR9KTtcblxuXHRpdCgnc2hvdWxkIGhhbmRsZSBwbHVnaW4gd2l0aG91dCByZXNvbHZlZFBhdGggKGV4dGVybmFsIHBsdWdpbiknLCAoKSA9PiB7XG5cdFx0Y29uc3QgZXh0ZXJuYWxQbHVnaW46IERpc2NvdmVyZWRQbHVnaW4gPSB7XG5cdFx0XHRuYW1lOiAnZXh0ZXJuYWwtcGx1Z2luJyxcblx0XHRcdGNhbm9uaWNhbE5hbWU6ICdleHRlcm5hbC1wbHVnaW4nLFxuXHRcdFx0c291cmNlOiB7IHNvdXJjZTogJ2dpdGh1YicsIHJlcG86ICdleGFtcGxlL3BsdWdpbicgfSxcblx0XHRcdHJlc29sdmVkUGF0aDogbnVsbCwgLy8gRXh0ZXJuYWwgLSBub3QgbG9jYWxseSByZXNvbHZlZFxuXHRcdFx0c3RhdHVzOiAnb2snLFxuXHRcdFx0bWFuaWZlc3RTb3VyY2U6ICdtYXJrZXRwbGFjZS1pbmxpbmUnLFxuXHRcdFx0ZGVzY3JpcHRpb246ICdBbiBleHRlcm5hbCBwbHVnaW4nLFxuXHRcdFx0aW52ZW50b3J5OiB7XG5cdFx0XHRcdHNraWxsczogWydyZW1vdGUtc2tpbGwnXSxcblx0XHRcdFx0YWdlbnRzOiBbXSxcblx0XHRcdFx0Y29tbWFuZHM6IFtdLFxuXHRcdFx0XHRtY3BTZXJ2ZXJzOiB7fSxcblx0XHRcdFx0bHNwU2VydmVyczoge30sXG5cdFx0XHRcdGhvb2tzOiBbXSxcblx0XHRcdH0sXG5cdFx0fTtcblxuXHRcdGNvbnN0IGNvbXBvbmVudHMgPSBjb21wb25lbnRzRnJvbURpc2NvdmVyeShleHRlcm5hbFBsdWdpbik7XG5cblx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoY29tcG9uZW50cy5sZW5ndGgsIDEpO1xuXHRcdGFzc2VydC5zdHJpY3RFcXVhbChjb21wb25lbnRzWzBdLm5hbWUsICdyZW1vdGUtc2tpbGwnKTtcblx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoY29tcG9uZW50c1swXS5uYW1lc3BhY2UsICdleHRlcm5hbC1wbHVnaW4nKTtcblx0XHRhc3NlcnQub2soY29tcG9uZW50c1swXS5maWxlUGF0aC5pbmNsdWRlcygnPGV4dGVybmFsPicpKTtcblx0fSk7XG5cblx0aXQoJ3Nob3VsZCBwcm9kdWNlIGNvbXBvbmVudHMgdGhhdCBjYW4gYmUgcmVnaXN0ZXJlZCBpbiBOYW1lc3BhY2VkUmVnaXN0cnknLCAoKSA9PiB7XG5cdFx0Y29uc3QgbW9ja1BsdWdpbjogRGlzY292ZXJlZFBsdWdpbiA9IHtcblx0XHRcdG5hbWU6ICdpbnRlZ3JhdGlvbi1wbHVnaW4nLFxuXHRcdFx0Y2Fub25pY2FsTmFtZTogJ2ludGVncmF0aW9uLXBsdWdpbicsXG5cdFx0XHRzb3VyY2U6ICcuL3BsdWdpbnMvaW50ZWdyYXRpb24nLFxuXHRcdFx0cmVzb2x2ZWRQYXRoOiAnL3BsdWdpbnMvaW50ZWdyYXRpb24nLFxuXHRcdFx0c3RhdHVzOiAnb2snLFxuXHRcdFx0bWFuaWZlc3RTb3VyY2U6ICdwbHVnaW4uanNvbicsXG5cdFx0XHRpbnZlbnRvcnk6IHtcblx0XHRcdFx0c2tpbGxzOiBbJ2ludC1za2lsbCddLFxuXHRcdFx0XHRhZ2VudHM6IFsnaW50LWFnZW50J10sXG5cdFx0XHRcdGNvbW1hbmRzOiBbXSxcblx0XHRcdFx0bWNwU2VydmVyczoge30sXG5cdFx0XHRcdGxzcFNlcnZlcnM6IHt9LFxuXHRcdFx0XHRob29rczogW10sXG5cdFx0XHR9LFxuXHRcdH07XG5cblx0XHRjb25zdCByZWdpc3RyeSA9IG5ldyBOYW1lc3BhY2VkUmVnaXN0cnkoKTtcblx0XHRjb25zdCBjb21wb25lbnRzID0gY29tcG9uZW50c0Zyb21EaXNjb3ZlcnkobW9ja1BsdWdpbik7XG5cblx0XHQvLyBSZWdpc3RlciBhbGwgY29tcG9uZW50c1xuXHRcdGZvciAoY29uc3QgY29tcG9uZW50IG9mIGNvbXBvbmVudHMpIHtcblx0XHRcdGNvbnN0IGRpYWcgPSByZWdpc3RyeS5yZWdpc3Rlcihjb21wb25lbnQpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKGRpYWcsIHVuZGVmaW5lZCwgJ05vIGNvbGxpc2lvbiBleHBlY3RlZCcpO1xuXHRcdH1cblxuXHRcdC8vIFZlcmlmeSByZWdpc3RyYXRpb25cblx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVnaXN0cnkuc2l6ZSwgMik7XG5cdFx0YXNzZXJ0Lm9rKHJlZ2lzdHJ5LmhhcygnaW50ZWdyYXRpb24tcGx1Z2luOmludC1za2lsbCcpKTtcblx0XHRhc3NlcnQub2socmVnaXN0cnkuaGFzKCdpbnRlZ3JhdGlvbi1wbHVnaW46aW50LWFnZW50JykpO1xuXG5cdFx0Ly8gTG9va3VwIGFuZCB2ZXJpZnlcblx0XHRjb25zdCBza2lsbCA9IHJlZ2lzdHJ5LmdldEJ5Q2Fub25pY2FsKCdpbnRlZ3JhdGlvbi1wbHVnaW46aW50LXNraWxsJyk7XG5cdFx0YXNzZXJ0Lm9rKHNraWxsICE9PSB1bmRlZmluZWQpO1xuXHRcdGFzc2VydC5zdHJpY3RFcXVhbChza2lsbC50eXBlLCAnc2tpbGwnKTtcblxuXHRcdGNvbnN0IGFnZW50ID0gcmVnaXN0cnkuZ2V0QnlDYW5vbmljYWwoJ2ludGVncmF0aW9uLXBsdWdpbjppbnQtYWdlbnQnKTtcblx0XHRhc3NlcnQub2soYWdlbnQgIT09IHVuZGVmaW5lZCk7XG5cdFx0YXNzZXJ0LnN0cmljdEVxdWFsKGFnZW50LnR5cGUsICdhZ2VudCcpO1xuXHR9KTtcblxuXHRpdCgnc2hvdWxkIHN0cmlwIC5tZCBleHRlbnNpb24gZnJvbSBza2lsbC9hZ2VudCBuYW1lcyBpZiBwcmVzZW50JywgKCkgPT4ge1xuXHRcdGNvbnN0IHBsdWdpbldpdGhNZDogRGlzY292ZXJlZFBsdWdpbiA9IHtcblx0XHRcdG5hbWU6ICdtZC1wbHVnaW4nLFxuXHRcdFx0Y2Fub25pY2FsTmFtZTogJ21kLXBsdWdpbicsXG5cdFx0XHRzb3VyY2U6ICcuL3BsdWdpbnMvbWQnLFxuXHRcdFx0cmVzb2x2ZWRQYXRoOiAnL3BsdWdpbnMvbWQnLFxuXHRcdFx0c3RhdHVzOiAnb2snLFxuXHRcdFx0bWFuaWZlc3RTb3VyY2U6ICdkZXJpdmVkJyxcblx0XHRcdGludmVudG9yeToge1xuXHRcdFx0XHRza2lsbHM6IFsnc2tpbGwubWQnXSwgLy8gLm1kIGV4dGVuc2lvbiBpbiBpbnZlbnRvcnlcblx0XHRcdFx0YWdlbnRzOiBbJ2FnZW50Lm1kJ10sXG5cdFx0XHRcdGNvbW1hbmRzOiBbXSxcblx0XHRcdFx0bWNwU2VydmVyczoge30sXG5cdFx0XHRcdGxzcFNlcnZlcnM6IHt9LFxuXHRcdFx0XHRob29rczogW10sXG5cdFx0XHR9LFxuXHRcdH07XG5cblx0XHRjb25zdCBjb21wb25lbnRzID0gY29tcG9uZW50c0Zyb21EaXNjb3ZlcnkocGx1Z2luV2l0aE1kKTtcblxuXHRcdGNvbnN0IHNraWxsID0gY29tcG9uZW50cy5maW5kKChjKSA9PiBjLnR5cGUgPT09ICdza2lsbCcpO1xuXHRcdGNvbnN0IGFnZW50ID0gY29tcG9uZW50cy5maW5kKChjKSA9PiBjLnR5cGUgPT09ICdhZ2VudCcpO1xuXG5cdFx0YXNzZXJ0Lm9rKHNraWxsICE9PSB1bmRlZmluZWQpO1xuXHRcdGFzc2VydC5vayhhZ2VudCAhPT0gdW5kZWZpbmVkKTtcblx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoc2tpbGwubmFtZSwgJ3NraWxsJyk7IC8vIC5tZCBzdHJpcHBlZFxuXHRcdGFzc2VydC5zdHJpY3RFcXVhbChhZ2VudC5uYW1lLCAnYWdlbnQnKTsgLy8gLm1kIHN0cmlwcGVkXG5cdH0pO1xufSk7XG5cbmRlc2NyaWJlKCdkaWFnbm9zdGljIHN0cnVjdHVyZSB2ZXJpZmljYXRpb24nLCAoKSA9PiB7XG5cdGl0KCdzaG91bGQgZW1pdCBkaWFnbm9zdGljIHdpdGggY29ycmVjdCBSZWdpc3RyeUNvbGxpc2lvbiBzaGFwZScsICgpID0+IHtcblx0XHRjb25zdCByZWdpc3RyeSA9IG5ldyBOYW1lc3BhY2VkUmVnaXN0cnkoKTtcblxuXHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdG5hbWU6ICdkdXAnLFxuXHRcdFx0bmFtZXNwYWNlOiAnbnMnLFxuXHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdGZpbGVQYXRoOiAnL2ZpcnN0L2R1cC5tZCcsXG5cdFx0XHRzb3VyY2U6ICdmaXJzdC1zb3VyY2UnLFxuXHRcdFx0ZGVzY3JpcHRpb246IHVuZGVmaW5lZCxcblx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHR9KTtcblxuXHRcdGNvbnN0IGRpYWcgPSByZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRuYW1lOiAnZHVwJyxcblx0XHRcdG5hbWVzcGFjZTogJ25zJyxcblx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRmaWxlUGF0aDogJy9zZWNvbmQvZHVwLm1kJyxcblx0XHRcdHNvdXJjZTogJ3NlY29uZC1zb3VyY2UnLFxuXHRcdFx0ZGVzY3JpcHRpb246IHVuZGVmaW5lZCxcblx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHR9KTtcblxuXHRcdGFzc2VydC5vayhkaWFnICE9PSB1bmRlZmluZWQpO1xuXG5cdFx0Ly8gVmVyaWZ5IGRpYWdub3N0aWMgdHlwZVxuXHRcdGFzc2VydC5zdHJpY3RFcXVhbChkaWFnLnR5cGUsICdjb2xsaXNpb24nKTtcblxuXHRcdC8vIFZlcmlmeSBtZXNzYWdlIGZvcm1hdFxuXHRcdGFzc2VydC5vayhkaWFnLm1lc3NhZ2UuaW5jbHVkZXMoJ25zOmR1cCcpKTtcblx0XHRhc3NlcnQub2soZGlhZy5tZXNzYWdlLmluY2x1ZGVzKCdjb2xsaXNpb24nKSk7XG5cblx0XHQvLyBWZXJpZnkgY29sbGlzaW9uIG9iamVjdCBzdHJ1Y3R1cmVcblx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoZGlhZy5jb2xsaXNpb24uY2Fub25pY2FsTmFtZSwgJ25zOmR1cCcpO1xuXHRcdGFzc2VydC5zdHJpY3RFcXVhbChkaWFnLmNvbGxpc2lvbi53aW5uZXJQYXRoLCAnL2ZpcnN0L2R1cC5tZCcpO1xuXHRcdGFzc2VydC5zdHJpY3RFcXVhbChkaWFnLmNvbGxpc2lvbi5sb3NlclBhdGgsICcvc2Vjb25kL2R1cC5tZCcpO1xuXHRcdGFzc2VydC5zdHJpY3RFcXVhbChkaWFnLmNvbGxpc2lvbi53aW5uZXJTb3VyY2UsICdmaXJzdC1zb3VyY2UnKTtcblx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoZGlhZy5jb2xsaXNpb24ubG9zZXJTb3VyY2UsICdzZWNvbmQtc291cmNlJyk7XG5cdH0pO1xuXG5cdGl0KCdzaG91bGQgcHJvdmlkZSBpbnNwZWN0YWJsZSBkaWFnbm9zdGljcyB2aWEgZ2V0RGlhZ25vc3RpY3MnLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVnaXN0cnkgPSBuZXcgTmFtZXNwYWNlZFJlZ2lzdHJ5KCk7XG5cblx0XHQvLyBDcmVhdGUgY29sbGlzaW9uXG5cdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0bmFtZTogJ3NraWxsJyxcblx0XHRcdG5hbWVzcGFjZTogJ3BsdWdpbicsXG5cdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0ZmlsZVBhdGg6ICcvYS9za2lsbC5tZCcsXG5cdFx0XHRzb3VyY2U6ICdhJyxcblx0XHRcdGRlc2NyaXB0aW9uOiB1bmRlZmluZWQsXG5cdFx0XHRtZXRhZGF0YToge30sXG5cdFx0fSk7XG5cdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0bmFtZTogJ3NraWxsJyxcblx0XHRcdG5hbWVzcGFjZTogJ3BsdWdpbicsXG5cdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0ZmlsZVBhdGg6ICcvYi9za2lsbC5tZCcsXG5cdFx0XHRzb3VyY2U6ICdiJyxcblx0XHRcdGRlc2NyaXB0aW9uOiB1bmRlZmluZWQsXG5cdFx0XHRtZXRhZGF0YToge30sXG5cdFx0fSk7XG5cblx0XHRjb25zdCBkaWFnbm9zdGljcyA9IHJlZ2lzdHJ5LmdldERpYWdub3N0aWNzKCk7XG5cblx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoZGlhZ25vc3RpY3MubGVuZ3RoLCAxKTtcblxuXHRcdC8vIFZlcmlmeSBkaWFnbm9zdGljIGlzIGEgY29weSAobm90IG11dGFibGUgcmVmZXJlbmNlKVxuXHRcdGRpYWdub3N0aWNzWzBdLm1lc3NhZ2UgPSAnbW9kaWZpZWQnO1xuXHRcdGNvbnN0IGZyZXNoRGlhZ25vc3RpY3MgPSByZWdpc3RyeS5nZXREaWFnbm9zdGljcygpO1xuXHRcdGFzc2VydC5zdHJpY3RFcXVhbChmcmVzaERpYWdub3N0aWNzWzBdLm1lc3NhZ2UsICdjYW5vbmljYWwgbmFtZSBcInBsdWdpbjpza2lsbFwiIGNvbGxpc2lvbicpO1xuXHR9KTtcbn0pO1xuXG5kZXNjcmliZSgnYWxpYXMgbWFuYWdlbWVudCcsICgpID0+IHtcblx0bGV0IHJlZ2lzdHJ5OiBOYW1lc3BhY2VkUmVnaXN0cnk7XG5cblx0YmVmb3JlRWFjaCgoKSA9PiB7XG5cdFx0cmVnaXN0cnkgPSBuZXcgTmFtZXNwYWNlZFJlZ2lzdHJ5KCk7XG5cdH0pO1xuXG5cdGRlc2NyaWJlKCdyZWdpc3RlckFsaWFzJywgKCkgPT4ge1xuXHRcdGl0KCdzaG91bGQgcmVnaXN0ZXIgYW4gYWxpYXMgZm9yIGFuIGV4aXN0aW5nIGNhbm9uaWNhbCBuYW1lJywgKCkgPT4ge1xuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRuYW1lOiAnM2QtdmlzdWFsaXplcicsXG5cdFx0XHRcdG5hbWVzcGFjZTogJ3B5dGhvbi10b29scycsXG5cdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdGZpbGVQYXRoOiAnL3B5dGhvbi10b29scy8zZC12aXN1YWxpemVyL1NLSUxMLm1kJyxcblx0XHRcdFx0c291cmNlOiAncGx1Z2luOnB5dGhvbi10b29scycsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiAnM0QgdmlzdWFsaXphdGlvbicsXG5cdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdH0pO1xuXG5cdFx0XHRjb25zdCByZXN1bHQgPSByZWdpc3RyeS5yZWdpc3RlckFsaWFzKCdweTNkJywgJ3B5dGhvbi10b29sczozZC12aXN1YWxpemVyJyk7XG5cblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuc3VjY2VzcywgdHJ1ZSk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVnaXN0cnkuaGFzQWxpYXMoJ3B5M2QnKSwgdHJ1ZSk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVnaXN0cnkucmVzb2x2ZUFsaWFzKCdweTNkJyksICdweXRob24tdG9vbHM6M2QtdmlzdWFsaXplcicpO1xuXHRcdH0pO1xuXG5cdFx0aXQoJ3Nob3VsZCByZWplY3QgYWxpYXMgaWYgdGFyZ2V0IGNhbm9uaWNhbCBuYW1lIGRvZXMgbm90IGV4aXN0JywgKCkgPT4ge1xuXHRcdFx0Y29uc3QgcmVzdWx0ID0gcmVnaXN0cnkucmVnaXN0ZXJBbGlhcygncHkzZCcsICdub25leGlzdGVudDpza2lsbCcpO1xuXG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LnN1Y2Nlc3MsIGZhbHNlKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQucmVhc29uLCAnY2Fub25pY2FsLW5vdC1mb3VuZCcpO1xuXHRcdFx0YXNzZXJ0Lm9rKHJlc3VsdC5tZXNzYWdlPy5pbmNsdWRlcygnZG9lcyBub3QgZXhpc3QnKSk7XG5cdFx0fSk7XG5cblx0XHRpdCgnc2hvdWxkIHJlamVjdCBhbGlhcyB0aGF0IHNoYWRvd3MgYW4gZXhpc3RpbmcgY2Fub25pY2FsIG5hbWUnLCAoKSA9PiB7XG5cdFx0XHRyZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRcdG5hbWU6ICdleGlzdGluZycsXG5cdFx0XHRcdG5hbWVzcGFjZTogJ3BsdWdpbicsXG5cdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdGZpbGVQYXRoOiAnL3BsdWdpbi9leGlzdGluZy9TS0lMTC5tZCcsXG5cdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjpwbHVnaW4nLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogJ0V4aXN0aW5nIHNraWxsJyxcblx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0fSk7XG5cdFx0XHRyZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRcdG5hbWU6ICdvdGhlcicsXG5cdFx0XHRcdG5hbWVzcGFjZTogJ3BsdWdpbicsXG5cdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdGZpbGVQYXRoOiAnL3BsdWdpbi9vdGhlci9TS0lMTC5tZCcsXG5cdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjpwbHVnaW4nLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogJ090aGVyIHNraWxsJyxcblx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0fSk7XG5cblx0XHRcdC8vIFRyeSB0byBjcmVhdGUgYWxpYXMgdGhhdCBtYXRjaGVzIGFuIGV4aXN0aW5nIGNhbm9uaWNhbCBuYW1lXG5cdFx0XHRjb25zdCByZXN1bHQgPSByZWdpc3RyeS5yZWdpc3RlckFsaWFzKCdwbHVnaW46ZXhpc3RpbmcnLCAncGx1Z2luOm90aGVyJyk7XG5cblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuc3VjY2VzcywgZmFsc2UpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5yZWFzb24sICdzaGFkb3dzLWNhbm9uaWNhbCcpO1xuXHRcdFx0YXNzZXJ0Lm9rKHJlc3VsdC5tZXNzYWdlPy5pbmNsdWRlcygnc2hhZG93cyBhbiBleGlzdGluZyBjYW5vbmljYWwgbmFtZScpKTtcblx0XHR9KTtcblxuXHRcdGl0KCdzaG91bGQgcmVqZWN0IGR1cGxpY2F0ZSBhbGlhcyBwb2ludGluZyB0byBkaWZmZXJlbnQgdGFyZ2V0JywgKCkgPT4ge1xuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRuYW1lOiAnc2tpbGwtYScsXG5cdFx0XHRcdG5hbWVzcGFjZTogJ3BsdWdpbicsXG5cdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdGZpbGVQYXRoOiAnL3BsdWdpbi9za2lsbC1hL1NLSUxMLm1kJyxcblx0XHRcdFx0c291cmNlOiAncGx1Z2luOnBsdWdpbicsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiAnU2tpbGwgQScsXG5cdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdH0pO1xuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRuYW1lOiAnc2tpbGwtYicsXG5cdFx0XHRcdG5hbWVzcGFjZTogJ3BsdWdpbicsXG5cdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdGZpbGVQYXRoOiAnL3BsdWdpbi9za2lsbC1iL1NLSUxMLm1kJyxcblx0XHRcdFx0c291cmNlOiAncGx1Z2luOnBsdWdpbicsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiAnU2tpbGwgQicsXG5cdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdH0pO1xuXG5cdFx0XHQvLyBGaXJzdCBhbGlhcyBzdWNjZWVkc1xuXHRcdFx0Y29uc3QgZmlyc3QgPSByZWdpc3RyeS5yZWdpc3RlckFsaWFzKCdzaG9ydGN1dCcsICdwbHVnaW46c2tpbGwtYScpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKGZpcnN0LnN1Y2Nlc3MsIHRydWUpO1xuXG5cdFx0XHQvLyBTZWNvbmQgYWxpYXMgd2l0aCBzYW1lIG5hbWUgYnV0IGRpZmZlcmVudCB0YXJnZXQgZmFpbHNcblx0XHRcdGNvbnN0IHNlY29uZCA9IHJlZ2lzdHJ5LnJlZ2lzdGVyQWxpYXMoJ3Nob3J0Y3V0JywgJ3BsdWdpbjpza2lsbC1iJyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoc2Vjb25kLnN1Y2Nlc3MsIGZhbHNlKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChzZWNvbmQucmVhc29uLCAnZHVwbGljYXRlLWFsaWFzJyk7XG5cdFx0XHRhc3NlcnQub2soc2Vjb25kLm1lc3NhZ2U/LmluY2x1ZGVzKCdhbHJlYWR5IGV4aXN0cycpKTtcblx0XHR9KTtcblxuXHRcdGl0KCdzaG91bGQgYmUgaWRlbXBvdGVudCBmb3Igc2FtZSBhbGlhcyBhbmQgdGFyZ2V0JywgKCkgPT4ge1xuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRuYW1lOiAnc2tpbGwnLFxuXHRcdFx0XHRuYW1lc3BhY2U6ICdwbHVnaW4nLFxuXHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRmaWxlUGF0aDogJy9wbHVnaW4vc2tpbGwvU0tJTEwubWQnLFxuXHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46cGx1Z2luJyxcblx0XHRcdFx0ZGVzY3JpcHRpb246ICdTa2lsbCcsXG5cdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdH0pO1xuXG5cdFx0XHQvLyBSZWdpc3RlciBhbGlhcyB0d2ljZSB3aXRoIHNhbWUgdGFyZ2V0XG5cdFx0XHRjb25zdCBmaXJzdCA9IHJlZ2lzdHJ5LnJlZ2lzdGVyQWxpYXMoJ3MnLCAncGx1Z2luOnNraWxsJyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoZmlyc3Quc3VjY2VzcywgdHJ1ZSk7XG5cblx0XHRcdGNvbnN0IHNlY29uZCA9IHJlZ2lzdHJ5LnJlZ2lzdGVyQWxpYXMoJ3MnLCAncGx1Z2luOnNraWxsJyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoc2Vjb25kLnN1Y2Nlc3MsIHRydWUpO1xuXHRcdH0pO1xuXG5cdFx0aXQoJ3Nob3VsZCBhbGxvdyBtdWx0aXBsZSBhbGlhc2VzIGZvciBzYW1lIGNhbm9uaWNhbCBuYW1lJywgKCkgPT4ge1xuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRuYW1lOiAndmlzdWFsaXplcicsXG5cdFx0XHRcdG5hbWVzcGFjZTogJ3B5dGhvbi10b29scycsXG5cdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdGZpbGVQYXRoOiAnL3B5dGhvbi10b29scy92aXN1YWxpemVyL1NLSUxMLm1kJyxcblx0XHRcdFx0c291cmNlOiAncGx1Z2luOnB5dGhvbi10b29scycsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiAnVmlzdWFsaXplcicsXG5cdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdH0pO1xuXG5cdFx0XHRjb25zdCByMSA9IHJlZ2lzdHJ5LnJlZ2lzdGVyQWxpYXMoJ3B5dml6JywgJ3B5dGhvbi10b29sczp2aXN1YWxpemVyJyk7XG5cdFx0XHRjb25zdCByMiA9IHJlZ2lzdHJ5LnJlZ2lzdGVyQWxpYXMoJ3ZpeicsICdweXRob24tdG9vbHM6dmlzdWFsaXplcicpO1xuXHRcdFx0Y29uc3QgcjMgPSByZWdpc3RyeS5yZWdpc3RlckFsaWFzKCdweTNkJywgJ3B5dGhvbi10b29sczp2aXN1YWxpemVyJyk7XG5cblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyMS5zdWNjZXNzLCB0cnVlKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyMi5zdWNjZXNzLCB0cnVlKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyMy5zdWNjZXNzLCB0cnVlKTtcblxuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlZ2lzdHJ5LnJlc29sdmVBbGlhcygncHl2aXonKSwgJ3B5dGhvbi10b29sczp2aXN1YWxpemVyJyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVnaXN0cnkucmVzb2x2ZUFsaWFzKCd2aXonKSwgJ3B5dGhvbi10b29sczp2aXN1YWxpemVyJyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVnaXN0cnkucmVzb2x2ZUFsaWFzKCdweTNkJyksICdweXRob24tdG9vbHM6dmlzdWFsaXplcicpO1xuXHRcdH0pO1xuXHR9KTtcblxuXHRkZXNjcmliZSgncmVzb2x2ZUFsaWFzJywgKCkgPT4ge1xuXHRcdGl0KCdzaG91bGQgcmVzb2x2ZSByZWdpc3RlcmVkIGFsaWFzIHRvIGNhbm9uaWNhbCBuYW1lJywgKCkgPT4ge1xuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRuYW1lOiAnc2tpbGwnLFxuXHRcdFx0XHRuYW1lc3BhY2U6ICducycsXG5cdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdGZpbGVQYXRoOiAnL25zL3NraWxsL1NLSUxMLm1kJyxcblx0XHRcdFx0c291cmNlOiAncGx1Z2luOm5zJyxcblx0XHRcdFx0ZGVzY3JpcHRpb246ICdTa2lsbCcsXG5cdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdH0pO1xuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXJBbGlhcygncycsICduczpza2lsbCcpO1xuXG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVnaXN0cnkucmVzb2x2ZUFsaWFzKCdzJyksICduczpza2lsbCcpO1xuXHRcdH0pO1xuXG5cdFx0aXQoJ3Nob3VsZCByZXR1cm4gdW5kZWZpbmVkIGZvciBub24tZXhpc3RlbnQgYWxpYXMnLCAoKSA9PiB7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVnaXN0cnkucmVzb2x2ZUFsaWFzKCdub25leGlzdGVudCcpLCB1bmRlZmluZWQpO1xuXHRcdH0pO1xuXHR9KTtcblxuXHRkZXNjcmliZSgncmVtb3ZlQWxpYXMnLCAoKSA9PiB7XG5cdFx0aXQoJ3Nob3VsZCByZW1vdmUgYW4gZXhpc3RpbmcgYWxpYXMnLCAoKSA9PiB7XG5cdFx0XHRyZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRcdG5hbWU6ICdza2lsbCcsXG5cdFx0XHRcdG5hbWVzcGFjZTogJ25zJyxcblx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0ZmlsZVBhdGg6ICcvbnMvc2tpbGwvU0tJTEwubWQnLFxuXHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46bnMnLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogJ1NraWxsJyxcblx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0fSk7XG5cdFx0XHRyZWdpc3RyeS5yZWdpc3RlckFsaWFzKCdzJywgJ25zOnNraWxsJyk7XG5cblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZWdpc3RyeS5oYXNBbGlhcygncycpLCB0cnVlKTtcblxuXHRcdFx0Y29uc3QgcmVtb3ZlZCA9IHJlZ2lzdHJ5LnJlbW92ZUFsaWFzKCdzJyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVtb3ZlZCwgdHJ1ZSk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVnaXN0cnkuaGFzQWxpYXMoJ3MnKSwgZmFsc2UpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlZ2lzdHJ5LnJlc29sdmVBbGlhcygncycpLCB1bmRlZmluZWQpO1xuXHRcdH0pO1xuXG5cdFx0aXQoJ3Nob3VsZCByZXR1cm4gZmFsc2UgZm9yIG5vbi1leGlzdGVudCBhbGlhcycsICgpID0+IHtcblx0XHRcdGNvbnN0IHJlbW92ZWQgPSByZWdpc3RyeS5yZW1vdmVBbGlhcygnbm9uZXhpc3RlbnQnKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZW1vdmVkLCBmYWxzZSk7XG5cdFx0fSk7XG5cdH0pO1xuXG5cdGRlc2NyaWJlKCdnZXRBbGlhc2VzJywgKCkgPT4ge1xuXHRcdGl0KCdzaG91bGQgcmV0dXJuIGVtcHR5IG1hcCB3aGVuIG5vIGFsaWFzZXMgcmVnaXN0ZXJlZCcsICgpID0+IHtcblx0XHRcdGNvbnN0IGFsaWFzZXMgPSByZWdpc3RyeS5nZXRBbGlhc2VzKCk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoYWxpYXNlcy5zaXplLCAwKTtcblx0XHR9KTtcblxuXHRcdGl0KCdzaG91bGQgcmV0dXJuIGNvcHkgb2YgYWxpYXMgbWFwJywgKCkgPT4ge1xuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRuYW1lOiAnc2tpbGwnLFxuXHRcdFx0XHRuYW1lc3BhY2U6ICducycsXG5cdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdGZpbGVQYXRoOiAnL25zL3NraWxsL1NLSUxMLm1kJyxcblx0XHRcdFx0c291cmNlOiAncGx1Z2luOm5zJyxcblx0XHRcdFx0ZGVzY3JpcHRpb246ICdTa2lsbCcsXG5cdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdH0pO1xuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXJBbGlhcygncycsICduczpza2lsbCcpO1xuXG5cdFx0XHRjb25zdCBhbGlhc2VzID0gcmVnaXN0cnkuZ2V0QWxpYXNlcygpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKGFsaWFzZXMuc2l6ZSwgMSk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoYWxpYXNlcy5nZXQoJ3MnKSwgJ25zOnNraWxsJyk7XG5cblx0XHRcdC8vIE11dGF0aW5nIHJldHVybmVkIG1hcCBzaG91bGQgbm90IGFmZmVjdCByZWdpc3RyeVxuXHRcdFx0YWxpYXNlcy5zZXQoJ290aGVyJywgJ25zOm90aGVyJyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVnaXN0cnkuaGFzQWxpYXMoJ290aGVyJyksIGZhbHNlKTtcblx0XHR9KTtcblxuXHRcdGl0KCdzaG91bGQgaW5jbHVkZSBhbGwgcmVnaXN0ZXJlZCBhbGlhc2VzJywgKCkgPT4ge1xuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRuYW1lOiAnc2tpbGwtYScsXG5cdFx0XHRcdG5hbWVzcGFjZTogJ25zJyxcblx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0ZmlsZVBhdGg6ICcvbnMvYS9TS0lMTC5tZCcsXG5cdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjpucycsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiAnQScsXG5cdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdH0pO1xuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRuYW1lOiAnc2tpbGwtYicsXG5cdFx0XHRcdG5hbWVzcGFjZTogJ25zJyxcblx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0ZmlsZVBhdGg6ICcvbnMvYi9TS0lMTC5tZCcsXG5cdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjpucycsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiAnQicsXG5cdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdH0pO1xuXG5cdFx0XHRyZWdpc3RyeS5yZWdpc3RlckFsaWFzKCdzYScsICduczpza2lsbC1hJyk7XG5cdFx0XHRyZWdpc3RyeS5yZWdpc3RlckFsaWFzKCdzYicsICduczpza2lsbC1iJyk7XG5cblx0XHRcdGNvbnN0IGFsaWFzZXMgPSByZWdpc3RyeS5nZXRBbGlhc2VzKCk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoYWxpYXNlcy5zaXplLCAyKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChhbGlhc2VzLmdldCgnc2EnKSwgJ25zOnNraWxsLWEnKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChhbGlhc2VzLmdldCgnc2InKSwgJ25zOnNraWxsLWInKTtcblx0XHR9KTtcblx0fSk7XG5cblx0ZGVzY3JpYmUoJ2hhc0FsaWFzJywgKCkgPT4ge1xuXHRcdGl0KCdzaG91bGQgcmV0dXJuIHRydWUgZm9yIHJlZ2lzdGVyZWQgYWxpYXMnLCAoKSA9PiB7XG5cdFx0XHRyZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRcdG5hbWU6ICdza2lsbCcsXG5cdFx0XHRcdG5hbWVzcGFjZTogJ25zJyxcblx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0ZmlsZVBhdGg6ICcvbnMvc2tpbGwvU0tJTEwubWQnLFxuXHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46bnMnLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogJ1NraWxsJyxcblx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0fSk7XG5cdFx0XHRyZWdpc3RyeS5yZWdpc3RlckFsaWFzKCdzJywgJ25zOnNraWxsJyk7XG5cblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZWdpc3RyeS5oYXNBbGlhcygncycpLCB0cnVlKTtcblx0XHR9KTtcblxuXHRcdGl0KCdzaG91bGQgcmV0dXJuIGZhbHNlIGZvciBub24tZXhpc3RlbnQgYWxpYXMnLCAoKSA9PiB7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVnaXN0cnkuaGFzQWxpYXMoJ25vbmV4aXN0ZW50JyksIGZhbHNlKTtcblx0XHR9KTtcblx0fSk7XG59KTsiXSwKICAibWFwcGluZ3MiOiAiQUFhQSxTQUFTLFVBQVUsSUFBSSxrQkFBa0I7QUFDekMsT0FBTyxZQUFZO0FBQ25CO0FBQUEsRUFDQztBQUFBLEVBQ0E7QUFBQSxPQUNNO0FBR1AsU0FBUyxzQkFBc0IsTUFBTTtBQUNwQyxNQUFJO0FBRUosYUFBVyxNQUFNO0FBQ2hCLGVBQVcsSUFBSSxtQkFBbUI7QUFBQSxFQUNuQyxDQUFDO0FBRUQsV0FBUyxxQ0FBcUMsTUFBTTtBQUNuRCxPQUFHLDhFQUE4RSxNQUFNO0FBQ3RGLFlBQU0sYUFBYSxTQUFTLFNBQVM7QUFBQSxRQUNwQyxNQUFNO0FBQUEsUUFDTixXQUFXO0FBQUEsUUFDWCxNQUFNO0FBQUEsUUFDTixVQUFVO0FBQUEsUUFDVixRQUFRO0FBQUEsUUFDUixhQUFhO0FBQUEsUUFDYixVQUFVLEVBQUUsZUFBZSxRQUFRO0FBQUEsTUFDcEMsQ0FBQztBQUdELGFBQU8sWUFBWSxZQUFZLE1BQVM7QUFHeEMsYUFBTyxZQUFZLFNBQVMsTUFBTSxDQUFDO0FBQ25DLGFB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
