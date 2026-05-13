import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { NamespacedRegistry } from "../namespaced-registry.js";
import { NamespacedResolver } from "../namespaced-resolver.js";
describe("NamespacedResolver", () => {
  let registry;
  let resolver;
  beforeEach(() => {
    registry = new NamespacedRegistry();
    resolver = new NamespacedResolver(registry);
  });
  describe("canonical lookup (R007, R008)", () => {
    it("should resolve canonical skill name with canonical result (R007)", () => {
      registry.register({
        name: "call-horse",
        namespace: "farm",
        type: "skill",
        filePath: "/farm/call-horse/SKILL.md",
        source: "plugin:farm",
        description: "Calls a horse",
        metadata: {}
      });
      const result = resolver.resolve("farm:call-horse");
      assert.strictEqual(result.resolution, "canonical");
      if (result.resolution !== "canonical") throw new Error("Type guard");
      assert.strictEqual(result.requestedName, "farm:call-horse");
      assert.strictEqual(result.component.canonicalName, "farm:call-horse");
      assert.strictEqual(result.component.type, "skill");
    });
    it("should resolve canonical agent name with canonical result (R008)", () => {
      registry.register({
        name: "rancher",
        namespace: "farm",
        type: "agent",
        filePath: "/farm/rancher/AGENT.md",
        source: "plugin:farm",
        description: "Farm agent",
        metadata: {}
      });
      const result = resolver.resolve("farm:rancher");
      assert.strictEqual(result.resolution, "canonical");
      if (result.resolution !== "canonical") throw new Error("Type guard");
      assert.strictEqual(result.component.canonicalName, "farm:rancher");
      assert.strictEqual(result.component.type, "agent");
    });
    it("should return not-found for non-existent canonical name", () => {
      const result = resolver.resolve("nonexistent:skill");
      assert.strictEqual(result.resolution, "not-found");
    });
    it("should return not-found for canonical name with wrong type filter", () => {
      registry.register({
        name: "call-horse",
        namespace: "farm",
        type: "skill",
        filePath: "/farm/call-horse/SKILL.md",
        source: "plugin:farm",
        description: "Calls a horse",
        metadata: {}
      });
      const result = resolver.resolve("farm:call-horse", void 0, "agent");
      assert.strictEqual(result.resolution, "not-found");
    });
  });
  describe("local-first resolution (D003)", () => {
    it("should resolve bare name local-first when caller namespace has match", () => {
      registry.register({
        name: "call-horse",
        namespace: "farm",
        type: "skill",
        filePath: "/farm/call-horse/SKILL.md",
        source: "plugin:farm",
        description: "Farm horse caller",
        metadata: {}
      });
      registry.register({
        name: "call-horse",
        namespace: "zoo",
        type: "skill",
        filePath: "/zoo/call-horse/SKILL.md",
        source: "plugin:zoo",
        description: "Zoo horse caller",
        metadata: {}
      });
      const result = resolver.resolve("call-horse", { callerNamespace: "farm" });
      assert.strictEqual(result.resolution, "local-first");
      if (result.resolution !== "local-first") throw new Error("Type guard");
      assert.strictEqual(result.requestedName, "call-horse");
      assert.strictEqual(result.component.canonicalName, "farm:call-horse");
      assert.strictEqual(result.matchedNamespace, "farm");
    });
    it("should resolve local-first from zoo namespace context", () => {
      registry.register({
        name: "call-horse",
        namespace: "farm",
        type: "skill",
        filePath: "/farm/call-horse/SKILL.md",
        source: "plugin:farm",
        description: "Farm horse caller",
        metadata: {}
      });
      registry.register({
        name: "call-horse",
        namespace: "zoo",
        type: "skill",
        filePath: "/zoo/call-horse/SKILL.md",
        source: "plugin:zoo",
        description: "Zoo horse caller",
        metadata: {}
      });
      const result = resolver.resolve("call-horse", { callerNamespace: "zoo" });
      assert.strictEqual(result.resolution, "local-first");
      if (result.resolution !== "local-first") throw new Error("Type guard");
      assert.strictEqual(result.component.canonicalName, "zoo:call-horse");
    });
    it("should fall through to shorthand when local namespace has no match", () => {
      registry.register({
        name: "feed-chickens",
        namespace: "farm",
        type: "skill",
        filePath: "/farm/feed-chickens/SKILL.md",
        source: "plugin:farm",
        description: "Feed chickens",
        metadata: {}
      });
      const result = resolver.resolve("feed-chickens", { callerNamespace: "zoo" });
      assert.strictEqual(result.resolution, "shorthand");
      if (result.resolution !== "shorthand") throw new Error("Type guard");
      assert.strictEqual(result.component.canonicalName, "farm:feed-chickens");
    });
    it("should respect type filter in local-first resolution", () => {
      registry.register({
        name: "helper-skill",
        namespace: "farm",
        type: "skill",
        filePath: "/farm/helper-skill/SKILL.md",
        source: "plugin:farm",
        description: "Helper skill",
        metadata: {}
      });
      registry.register({
        name: "helper-agent",
        namespace: "farm",
        type: "agent",
        filePath: "/farm/helper-agent/AGENT.md",
        source: "plugin:farm",
        description: "Helper agent",
        metadata: {}
      });
      const skillResult = resolver.resolve("helper-skill", { callerNamespace: "farm" }, "skill");
      assert.strictEqual(skillResult.resolution, "local-first");
      if (skillResult.resolution !== "local-first") throw new Error("Type guard");
      assert.strictEqual(skillResult.component.type, "skill");
      assert.strictEqual(skillResult.component.name, "helper-skill");
      const agentResult = resolver.resolve("helper-agent", { callerNamespace: "farm" }, "agent");
      assert.strictEqual(agentResult.resolution, "local-first");
      if (agentResult.resolution !== "local-first") throw new Error("Type guard");
      assert.strictEqual(agentResult.component.type, "agent");
      assert.strictEqual(agentResult.component.name, "helper-agent");
    });
  });
  describe("shorthand resolution (R009)", () => {
    it("should resolve unambiguous shorthand with single match", () => {
      registry.register({
        name: "feed-chickens",
        namespace: "farm",
        type: "skill",
        filePath: "/farm/feed-chickens/SKILL.md",
        source: "plugin:farm",
        description: "Feed chickens",
        metadata: {}
      });
      const result = resolver.resolve("feed-chickens");
      assert.strictEqual(result.resolution, "shorthand");
      if (result.resolution !== "shorthand") throw new Error("Type guard");
      assert.strictEqual(result.requestedName, "feed-chickens");
      assert.strictEqual(result.component.canonicalName, "farm:feed-chickens");
    });
    it("should return ambiguous with candidates for multiple matches", () => {
      registry.register({
        name: "call-horse",
        namespace: "farm",
        type: "skill",
        filePath: "/farm/call-horse/SKILL.md",
        source: "plugin:farm",
        description: "Farm horse caller",
        metadata: {}
      });
      registry.register({
        name: "call-horse",
        namespace: "zoo",
        type: "skill",
        filePath: "/zoo/call-horse/SKILL.md",
        source: "plugin:zoo",
        description: "Zoo horse caller",
        metadata: {}
      });
      const result = resolver.resolve("call-horse");
      assert.strictEqual(result.resolution, "ambiguous");
      if (result.resolution !== "ambiguous") throw new Error("Type guard");
      assert.strictEqual(result.requestedName, "call-horse");
      assert.strictEqual(result.candidates.length, 2);
      const canonicalNames = result.candidates.map((c) => c.canonicalName).sort();
      assert.deepStrictEqual(canonicalNames, ["farm:call-horse", "zoo:call-horse"]);
    });
    it("should return not-found for non-existent bare name", () => {
      const result = resolver.resolve("nonexistent");
      assert.strictEqual(result.resolution, "not-found");
    });
    it("should return not-found when type filter eliminates all matches", () => {
      registry.register({
        name: "helper",
        namespace: "farm",
        type: "skill",
        filePath: "/farm/helper/SKILL.md",
        source: "plugin:farm",
        description: "Helper skill",
        metadata: {}
      });
      const result = resolver.resolve("helper", void 0, "agent");
      assert.strictEqual(result.resolution, "not-found");
    });
  });
  describe("flat component compatibility", () => {
    it("should resolve flat component by bare name (no namespace)", () => {
      registry.register({
        name: "code-review",
        namespace: void 0,
        type: "skill",
        filePath: "/skills/code-review/SKILL.md",
        source: "user",
        description: "Code review skill",
        metadata: {}
      });
      const result = resolver.resolve("code-review");
      assert.strictEqual(result.resolution, "shorthand");
      if (result.resolution !== "shorthand") throw new Error("Type guard");
      assert.strictEqual(result.component.canonicalName, "code-review");
      assert.strictEqual(result.component.namespace, void 0);
    });
    it("should include flat component in ambiguous candidates", () => {
      registry.register({
        name: "helper",
        namespace: void 0,
        type: "skill",
        filePath: "/skills/helper/SKILL.md",
        source: "user",
        description: "User helper",
        metadata: {}
      });
      registry.register({
        name: "helper",
        namespace: "farm",
        type: "skill",
        filePath: "/farm/helper/SKILL.md",
        source: "plugin:farm",
        description: "Farm helper",
        metadata: {}
      });
      const result = resolver.resolve("helper");
      assert.strictEqual(result.resolution, "ambiguous");
      if (result.resolution !== "ambiguous") throw new Error("Type guard");
      assert.strictEqual(result.candidates.length, 2);
      const canonicalNames = result.candidates.map((c) => c.canonicalName).sort();
      assert.deepStrictEqual(canonicalNames, ["farm:helper", "helper"]);
    });
  });
  describe("type filtering", () => {
    it("should filter by skill type across namespaces", () => {
      registry.register({
        name: "review",
        namespace: "tools",
        type: "skill",
        filePath: "/tools/review/SKILL.md",
        source: "plugin:tools",
        description: "Review skill",
        metadata: {}
      });
      registry.register({
        name: "review",
        namespace: "agents",
        type: "agent",
        filePath: "/agents/review/AGENT.md",
        source: "plugin:agents",
        description: "Review agent",
        metadata: {}
      });
      const skillResult = resolver.resolve("review", void 0, "skill");
      assert.strictEqual(skillResult.resolution, "shorthand");
      if (skillResult.resolution !== "shorthand") throw new Error("Type guard");
      assert.strictEqual(skillResult.component.type, "skill");
      assert.strictEqual(skillResult.component.namespace, "tools");
      const agentResult = resolver.resolve("review", void 0, "agent");
      assert.strictEqual(agentResult.resolution, "shorthand");
      if (agentResult.resolution !== "shorthand") throw new Error("Type guard");
      assert.strictEqual(agentResult.component.type, "agent");
      assert.strictEqual(agentResult.component.namespace, "agents");
    });
    it("should resolve unique skill among multiple agents with same name", () => {
      registry.register({
        name: "assistant",
        namespace: "tools",
        type: "skill",
        filePath: "/tools/assistant/SKILL.md",
        source: "plugin:tools",
        description: "Assistant skill",
        metadata: {}
      });
      registry.register({
        name: "assistant",
        namespace: "other",
        type: "agent",
        filePath: "/other/assistant/AGENT.md",
        source: "plugin:other",
        description: "Assistant agent",
        metadata: {}
      });
      const result = resolver.resolve("assistant", void 0, "skill");
      assert.strictEqual(result.resolution, "shorthand");
      if (result.resolution !== "shorthand") throw new Error("Type guard");
      assert.strictEqual(result.component.canonicalName, "tools:assistant");
    });
  });
  describe("resolution path diagnostics", () => {
    it("should include requestedName in all result types", () => {
      registry.register({
        name: "skill",
        namespace: "ns",
        type: "skill",
        filePath: "/skill/SKILL.md",
        source: "test",
        description: void 0,
        metadata: {}
      });
      const canon = resolver.resolve("ns:skill");
      assert.strictEqual(canon.requestedName, "ns:skill");
      const local = resolver.resolve("skill", { callerNamespace: "ns" });
      assert.strictEqual(local.requestedName, "skill");
      const short = resolver.resolve("skill");
      assert.strictEqual(short.requestedName, "skill");
      const notFound = resolver.resolve("missing");
      assert.strictEqual(notFound.requestedName, "missing");
    });
    it("should provide matchedNamespace in local-first results", () => {
      registry.register({
        name: "skill",
        namespace: "my-ns",
        type: "skill",
        filePath: "/skill/SKILL.md",
        source: "test",
        description: void 0,
        metadata: {}
      });
      const result = resolver.resolve("skill", { callerNamespace: "my-ns" });
      assert.strictEqual(result.resolution, "local-first");
      if (result.resolution === "local-first") {
        assert.strictEqual(result.matchedNamespace, "my-ns");
      }
    });
    it("should provide full candidate list in ambiguous results", () => {
      registry.register({
        name: "dup",
        namespace: "a",
        type: "skill",
        filePath: "/a/dup/SKILL.md",
        source: "a",
        description: "A dup",
        metadata: {}
      });
      registry.register({
        name: "dup",
        namespace: "b",
        type: "skill",
        filePath: "/b/dup/SKILL.md",
        source: "b",
        description: "B dup",
        metadata: {}
      });
      const result = resolver.resolve("dup");
      assert.strictEqual(result.resolution, "ambiguous");
      if (result.resolution === "ambiguous") {
        assert.strictEqual(result.candidates.length, 2);
        for (const candidate of result.candidates) {
          assert.ok(candidate.canonicalName);
          assert.ok(candidate.filePath);
          assert.strictEqual(candidate.name, "dup");
        }
      }
    });
  });
  describe("edge cases", () => {
    it("should handle empty registry gracefully", () => {
      const result = resolver.resolve("anything");
      assert.strictEqual(result.resolution, "not-found");
    });
    it("should handle empty caller namespace string", () => {
      registry.register({
        name: "skill",
        namespace: "ns",
        type: "skill",
        filePath: "/skill/SKILL.md",
        source: "test",
        description: void 0,
        metadata: {}
      });
      const result = resolver.resolve("skill", { callerNamespace: "" });
      assert.strictEqual(result.resolution, "shorthand");
    });
  });
  describe("alias resolution", () => {
    it("should resolve alias with alias result type", () => {
      registry.register({
        name: "3d-visualizer",
        namespace: "python-tools",
        type: "skill",
        filePath: "/python-tools/3d-visualizer/SKILL.md",
        source: "plugin:python-tools",
        description: "3D visualization",
        metadata: {}
      });
      registry.registerAlias("py3d", "python-tools:3d-visualizer");
      const result = resolver.resolve("py3d");
      assert.strictEqual(result.resolution, "alias");
      if (result.resolution !== "alias") throw new Error("Type guard");
      assert.strictEqual(result.requestedName, "py3d");
      assert.strictEqual(result.alias, "py3d");
      assert.strictEqual(result.canonicalName, "python-tools:3d-visualizer");
      assert.strictEqual(result.component.canonicalName, "python-tools:3d-visualizer");
      assert.strictEqual(result.component.type, "skill");
    });
    it("should respect type filter in alias resolution", () => {
      registry.register({
        name: "visualizer",
        namespace: "tools",
        type: "skill",
        filePath: "/tools/visualizer/SKILL.md",
        source: "plugin:tools",
        description: "Visualizer skill",
        metadata: {}
      });
      registry.registerAlias("viz", "tools:visualizer");
      const skillResult = resolver.resolve("viz", void 0, "skill");
      assert.strictEqual(skillResult.resolution, "alias");
      if (skillResult.resolution !== "alias") throw new Error("Type guard");
      assert.strictEqual(skillResult.component.type, "skill");
      const agentResult = resolver.resolve("viz", void 0, "agent");
      assert.strictEqual(agentResult.resolution, "not-found");
    });
    it("should prioritize alias over shorthand (alias checked first)", () => {
      registry.register({
        name: "shortcut",
        namespace: "other-plugin",
        type: "skill",
        filePath: "/other/shortcut/SKILL.md",
        source: "plugin:other-plugin",
        description: "Other shortcut",
        metadata: {}
      });
      registry.register({
        name: "aliased-skill",
        namespace: "main-plugin",
        type: "skill",
        filePath: "/main/aliased-skill/SKILL.md",
        source: "plugin:main-plugin",
        description: "Main skill",
        metadata: {}
      });
      registry.registerAlias("shortcut", "main-plugin:aliased-skill");
      const result = resolver.resolve("shortcut");
      assert.strictEqual(result.resolution, "alias");
      if (result.resolution !== "alias") throw new Error("Type guard");
      assert.strictEqual(result.canonicalName, "main-plugin:aliased-skill");
    });
    it("should prioritize alias over local-first (alias checked first)", () => {
      registry.register({
        name: "helper",
        namespace: "local-ns",
        type: "skill",
        filePath: "/local-ns/helper/SKILL.md",
        source: "plugin:local-ns",
        description: "Local helper",
        metadata: {}
      });
      registry.register({
        name: "aliased-helper",
        namespace: "alias-ns",
        type: "skill",
        filePath: "/alias-ns/aliased-helper/SKILL.md",
        source: "plugin:alias-ns",
        description: "Aliased helper",
        metadata: {}
      });
      registry.registerAlias("helper", "alias-ns:aliased-helper");
      const result = resolver.resolve("helper", { callerNamespace: "local-ns" });
      assert.strictEqual(result.resolution, "alias");
      if (result.resolution !== "alias") throw new Error("Type guard");
      assert.strictEqual(result.canonicalName, "alias-ns:aliased-helper");
    });
    it("should include alias and canonicalName in result", () => {
      registry.register({
        name: "code-review",
        namespace: "tools",
        type: "agent",
        filePath: "/tools/code-review/AGENT.md",
        source: "plugin:tools",
        description: "Code review agent",
        metadata: {}
      });
      registry.registerAlias("review", "tools:code-review");
      const result = resolver.resolve("review");
      assert.strictEqual(result.resolution, "alias");
      if (result.resolution !== "alias") throw new Error("Type guard");
      assert.strictEqual(result.alias, "review");
      assert.strictEqual(result.canonicalName, "tools:code-review");
      assert.strictEqual(result.component.canonicalName, "tools:code-review");
    });
    it("should fall through to local-first/shorthand when alias does not exist", () => {
      registry.register({
        name: "existing",
        namespace: "ns",
        type: "skill",
        filePath: "/ns/existing/SKILL.md",
        source: "plugin:ns",
        description: "Existing skill",
        metadata: {}
      });
      const result = resolver.resolve("existing", { callerNamespace: "ns" });
      assert.strictEqual(result.resolution, "local-first");
      if (result.resolution !== "local-first") throw new Error("Type guard");
      assert.strictEqual(result.component.canonicalName, "ns:existing");
    });
    it("should fall through to shorthand when alias does not exist and no local match", () => {
      registry.register({
        name: "unique",
        namespace: "plugin-a",
        type: "skill",
        filePath: "/plugin-a/unique/SKILL.md",
        source: "plugin:plugin-a",
        description: "Unique skill",
        metadata: {}
      });
      const result = resolver.resolve("unique", { callerNamespace: "other-ns" });
      assert.strictEqual(result.resolution, "shorthand");
      if (result.resolution !== "shorthand") throw new Error("Type guard");
      assert.strictEqual(result.component.canonicalName, "plugin-a:unique");
    });
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9uYW1lc3BhY2VkLXJlc29sdmVyLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogTmFtZXNwYWNlZCBSZXNvbHZlciBDb250cmFjdCBUZXN0c1xuICpcbiAqIFRlc3RzIHRoYXQgcHJvdmUgdGhlIHJlc29sdmVyIGNvcnJlY3RseSBoYW5kbGVzOlxuICogLSBSMDA3OiBDYW5vbmljYWwgc2tpbGwgbG9va3VwXG4gKiAtIFIwMDg6IENhbm9uaWNhbCBhZ2VudCBsb29rdXBcbiAqIC0gRDAwMzogU2FtZS1wbHVnaW4gbG9jYWwtZmlyc3QgcmVzb2x1dGlvblxuICogLSBSMDA5OiBTaG9ydGhhbmQgcmVzb2x1dGlvbiAodW5hbWJpZ3VvdXMgYW5kIGFtYmlndW91cylcbiAqIC0gRmxhdCBjb21wb25lbnQgY29tcGF0aWJpbGl0eVxuICogLSBUeXBlIGZpbHRlcmluZyAoc2tpbGwgdnMgYWdlbnQpXG4gKi9cblxuaW1wb3J0IHsgZGVzY3JpYmUsIGl0LCBiZWZvcmVFYWNoIH0gZnJvbSAnbm9kZTp0ZXN0JztcbmltcG9ydCBhc3NlcnQgZnJvbSAnbm9kZTphc3NlcnQnO1xuaW1wb3J0IHsgTmFtZXNwYWNlZFJlZ2lzdHJ5IH0gZnJvbSAnLi4vbmFtZXNwYWNlZC1yZWdpc3RyeS5qcyc7XG5pbXBvcnQgeyBOYW1lc3BhY2VkUmVzb2x2ZXIgfSBmcm9tICcuLi9uYW1lc3BhY2VkLXJlc29sdmVyLmpzJztcblxuZGVzY3JpYmUoJ05hbWVzcGFjZWRSZXNvbHZlcicsICgpID0+IHtcblx0bGV0IHJlZ2lzdHJ5OiBOYW1lc3BhY2VkUmVnaXN0cnk7XG5cdGxldCByZXNvbHZlcjogTmFtZXNwYWNlZFJlc29sdmVyO1xuXG5cdGJlZm9yZUVhY2goKCkgPT4ge1xuXHRcdHJlZ2lzdHJ5ID0gbmV3IE5hbWVzcGFjZWRSZWdpc3RyeSgpO1xuXHRcdHJlc29sdmVyID0gbmV3IE5hbWVzcGFjZWRSZXNvbHZlcihyZWdpc3RyeSk7XG5cdH0pO1xuXG5cdGRlc2NyaWJlKCdjYW5vbmljYWwgbG9va3VwIChSMDA3LCBSMDA4KScsICgpID0+IHtcblx0XHRpdCgnc2hvdWxkIHJlc29sdmUgY2Fub25pY2FsIHNraWxsIG5hbWUgd2l0aCBjYW5vbmljYWwgcmVzdWx0IChSMDA3KScsICgpID0+IHtcblx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0bmFtZTogJ2NhbGwtaG9yc2UnLFxuXHRcdFx0XHRuYW1lc3BhY2U6ICdmYXJtJyxcblx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0ZmlsZVBhdGg6ICcvZmFybS9jYWxsLWhvcnNlL1NLSUxMLm1kJyxcblx0XHRcdFx0c291cmNlOiAncGx1Z2luOmZhcm0nLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogJ0NhbGxzIGEgaG9yc2UnLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblxuXHRcdFx0Y29uc3QgcmVzdWx0ID0gcmVzb2x2ZXIucmVzb2x2ZSgnZmFybTpjYWxsLWhvcnNlJyk7XG5cblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQucmVzb2x1dGlvbiwgJ2Nhbm9uaWNhbCcpO1xuXHRcdFx0aWYgKHJlc3VsdC5yZXNvbHV0aW9uICE9PSAnY2Fub25pY2FsJykgdGhyb3cgbmV3IEVycm9yKCdUeXBlIGd1YXJkJyk7XG5cblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQucmVxdWVzdGVkTmFtZSwgJ2Zhcm06Y2FsbC1ob3JzZScpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5jb21wb25lbnQuY2Fub25pY2FsTmFtZSwgJ2Zhcm06Y2FsbC1ob3JzZScpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5jb21wb25lbnQudHlwZSwgJ3NraWxsJyk7XG5cdFx0fSk7XG5cblx0XHRpdCgnc2hvdWxkIHJlc29sdmUgY2Fub25pY2FsIGFnZW50IG5hbWUgd2l0aCBjYW5vbmljYWwgcmVzdWx0IChSMDA4KScsICgpID0+IHtcblx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0bmFtZTogJ3JhbmNoZXInLFxuXHRcdFx0XHRuYW1lc3BhY2U6ICdmYXJtJyxcblx0XHRcdFx0dHlwZTogJ2FnZW50Jyxcblx0XHRcdFx0ZmlsZVBhdGg6ICcvZmFybS9yYW5jaGVyL0FHRU5ULm1kJyxcblx0XHRcdFx0c291cmNlOiAncGx1Z2luOmZhcm0nLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogJ0Zhcm0gYWdlbnQnLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblxuXHRcdFx0Y29uc3QgcmVzdWx0ID0gcmVzb2x2ZXIucmVzb2x2ZSgnZmFybTpyYW5jaGVyJyk7XG5cblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQucmVzb2x1dGlvbiwgJ2Nhbm9uaWNhbCcpO1xuXHRcdFx0aWYgKHJlc3VsdC5yZXNvbHV0aW9uICE9PSAnY2Fub25pY2FsJykgdGhyb3cgbmV3IEVycm9yKCdUeXBlIGd1YXJkJyk7XG5cblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuY29tcG9uZW50LmNhbm9uaWNhbE5hbWUsICdmYXJtOnJhbmNoZXInKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuY29tcG9uZW50LnR5cGUsICdhZ2VudCcpO1xuXHRcdH0pO1xuXG5cdFx0aXQoJ3Nob3VsZCByZXR1cm4gbm90LWZvdW5kIGZvciBub24tZXhpc3RlbnQgY2Fub25pY2FsIG5hbWUnLCAoKSA9PiB7XG5cdFx0XHRjb25zdCByZXN1bHQgPSByZXNvbHZlci5yZXNvbHZlKCdub25leGlzdGVudDpza2lsbCcpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5yZXNvbHV0aW9uLCAnbm90LWZvdW5kJyk7XG5cdFx0fSk7XG5cblx0XHRpdCgnc2hvdWxkIHJldHVybiBub3QtZm91bmQgZm9yIGNhbm9uaWNhbCBuYW1lIHdpdGggd3JvbmcgdHlwZSBmaWx0ZXInLCAoKSA9PiB7XG5cdFx0XHRyZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRcdG5hbWU6ICdjYWxsLWhvcnNlJyxcblx0XHRcdFx0bmFtZXNwYWNlOiAnZmFybScsXG5cdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdGZpbGVQYXRoOiAnL2Zhcm0vY2FsbC1ob3JzZS9TS0lMTC5tZCcsXG5cdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjpmYXJtJyxcblx0XHRcdFx0ZGVzY3JpcHRpb246ICdDYWxscyBhIGhvcnNlJyxcblx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0fSk7XG5cblx0XHRcdGNvbnN0IHJlc3VsdCA9IHJlc29sdmVyLnJlc29sdmUoJ2Zhcm06Y2FsbC1ob3JzZScsIHVuZGVmaW5lZCwgJ2FnZW50Jyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LnJlc29sdXRpb24sICdub3QtZm91bmQnKTtcblx0XHR9KTtcblx0fSk7XG5cblx0ZGVzY3JpYmUoJ2xvY2FsLWZpcnN0IHJlc29sdXRpb24gKEQwMDMpJywgKCkgPT4ge1xuXHRcdGl0KCdzaG91bGQgcmVzb2x2ZSBiYXJlIG5hbWUgbG9jYWwtZmlyc3Qgd2hlbiBjYWxsZXIgbmFtZXNwYWNlIGhhcyBtYXRjaCcsICgpID0+IHtcblx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0bmFtZTogJ2NhbGwtaG9yc2UnLFxuXHRcdFx0XHRuYW1lc3BhY2U6ICdmYXJtJyxcblx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0ZmlsZVBhdGg6ICcvZmFybS9jYWxsLWhvcnNlL1NLSUxMLm1kJyxcblx0XHRcdFx0c291cmNlOiAncGx1Z2luOmZhcm0nLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogJ0Zhcm0gaG9yc2UgY2FsbGVyJyxcblx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0fSk7XG5cdFx0XHRyZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRcdG5hbWU6ICdjYWxsLWhvcnNlJyxcblx0XHRcdFx0bmFtZXNwYWNlOiAnem9vJyxcblx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0ZmlsZVBhdGg6ICcvem9vL2NhbGwtaG9yc2UvU0tJTEwubWQnLFxuXHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46em9vJyxcblx0XHRcdFx0ZGVzY3JpcHRpb246ICdab28gaG9yc2UgY2FsbGVyJyxcblx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0fSk7XG5cblx0XHRcdGNvbnN0IHJlc3VsdCA9IHJlc29sdmVyLnJlc29sdmUoJ2NhbGwtaG9yc2UnLCB7IGNhbGxlck5hbWVzcGFjZTogJ2Zhcm0nIH0pO1xuXG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LnJlc29sdXRpb24sICdsb2NhbC1maXJzdCcpO1xuXHRcdFx0aWYgKHJlc3VsdC5yZXNvbHV0aW9uICE9PSAnbG9jYWwtZmlyc3QnKSB0aHJvdyBuZXcgRXJyb3IoJ1R5cGUgZ3VhcmQnKTtcblxuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5yZXF1ZXN0ZWROYW1lLCAnY2FsbC1ob3JzZScpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5jb21wb25lbnQuY2Fub25pY2FsTmFtZSwgJ2Zhcm06Y2FsbC1ob3JzZScpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5tYXRjaGVkTmFtZXNwYWNlLCAnZmFybScpO1xuXHRcdH0pO1xuXG5cdFx0aXQoJ3Nob3VsZCByZXNvbHZlIGxvY2FsLWZpcnN0IGZyb20gem9vIG5hbWVzcGFjZSBjb250ZXh0JywgKCkgPT4ge1xuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRuYW1lOiAnY2FsbC1ob3JzZScsXG5cdFx0XHRcdG5hbWVzcGFjZTogJ2Zhcm0nLFxuXHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRmaWxlUGF0aDogJy9mYXJtL2NhbGwtaG9yc2UvU0tJTEwubWQnLFxuXHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46ZmFybScsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiAnRmFybSBob3JzZSBjYWxsZXInLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0bmFtZTogJ2NhbGwtaG9yc2UnLFxuXHRcdFx0XHRuYW1lc3BhY2U6ICd6b28nLFxuXHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRmaWxlUGF0aDogJy96b28vY2FsbC1ob3JzZS9TS0lMTC5tZCcsXG5cdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjp6b28nLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogJ1pvbyBob3JzZSBjYWxsZXInLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblxuXHRcdFx0Y29uc3QgcmVzdWx0ID0gcmVzb2x2ZXIucmVzb2x2ZSgnY2FsbC1ob3JzZScsIHsgY2FsbGVyTmFtZXNwYWNlOiAnem9vJyB9KTtcblxuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5yZXNvbHV0aW9uLCAnbG9jYWwtZmlyc3QnKTtcblx0XHRcdGlmIChyZXN1bHQucmVzb2x1dGlvbiAhPT0gJ2xvY2FsLWZpcnN0JykgdGhyb3cgbmV3IEVycm9yKCdUeXBlIGd1YXJkJyk7XG5cblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuY29tcG9uZW50LmNhbm9uaWNhbE5hbWUsICd6b286Y2FsbC1ob3JzZScpO1xuXHRcdH0pO1xuXG5cdFx0aXQoJ3Nob3VsZCBmYWxsIHRocm91Z2ggdG8gc2hvcnRoYW5kIHdoZW4gbG9jYWwgbmFtZXNwYWNlIGhhcyBubyBtYXRjaCcsICgpID0+IHtcblx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0bmFtZTogJ2ZlZWQtY2hpY2tlbnMnLFxuXHRcdFx0XHRuYW1lc3BhY2U6ICdmYXJtJyxcblx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0ZmlsZVBhdGg6ICcvZmFybS9mZWVkLWNoaWNrZW5zL1NLSUxMLm1kJyxcblx0XHRcdFx0c291cmNlOiAncGx1Z2luOmZhcm0nLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogJ0ZlZWQgY2hpY2tlbnMnLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblxuXHRcdFx0Y29uc3QgcmVzdWx0ID0gcmVzb2x2ZXIucmVzb2x2ZSgnZmVlZC1jaGlja2VucycsIHsgY2FsbGVyTmFtZXNwYWNlOiAnem9vJyB9KTtcblxuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5yZXNvbHV0aW9uLCAnc2hvcnRoYW5kJyk7XG5cdFx0XHRpZiAocmVzdWx0LnJlc29sdXRpb24gIT09ICdzaG9ydGhhbmQnKSB0aHJvdyBuZXcgRXJyb3IoJ1R5cGUgZ3VhcmQnKTtcblxuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5jb21wb25lbnQuY2Fub25pY2FsTmFtZSwgJ2Zhcm06ZmVlZC1jaGlja2VucycpO1xuXHRcdH0pO1xuXG5cdFx0aXQoJ3Nob3VsZCByZXNwZWN0IHR5cGUgZmlsdGVyIGluIGxvY2FsLWZpcnN0IHJlc29sdXRpb24nLCAoKSA9PiB7XG5cdFx0XHQvLyBSZWdpc3RlciB0d28gZGlmZmVyZW50IG5hbWVzIC0gb25lIHNraWxsLCBvbmUgYWdlbnRcblx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0bmFtZTogJ2hlbHBlci1za2lsbCcsXG5cdFx0XHRcdG5hbWVzcGFjZTogJ2Zhcm0nLFxuXHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRmaWxlUGF0aDogJy9mYXJtL2hlbHBlci1za2lsbC9TS0lMTC5tZCcsXG5cdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjpmYXJtJyxcblx0XHRcdFx0ZGVzY3JpcHRpb246ICdIZWxwZXIgc2tpbGwnLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0bmFtZTogJ2hlbHBlci1hZ2VudCcsXG5cdFx0XHRcdG5hbWVzcGFjZTogJ2Zhcm0nLFxuXHRcdFx0XHR0eXBlOiAnYWdlbnQnLFxuXHRcdFx0XHRmaWxlUGF0aDogJy9mYXJtL2hlbHBlci1hZ2VudC9BR0VOVC5tZCcsXG5cdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjpmYXJtJyxcblx0XHRcdFx0ZGVzY3JpcHRpb246ICdIZWxwZXIgYWdlbnQnLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblxuXHRcdFx0Ly8gUmVxdWVzdCBza2lsbCAtIHNob3VsZCBmaW5kIGhlbHBlci1za2lsbFxuXHRcdFx0Y29uc3Qgc2tpbGxSZXN1bHQgPSByZXNvbHZlci5yZXNvbHZlKCdoZWxwZXItc2tpbGwnLCB7IGNhbGxlck5hbWVzcGFjZTogJ2Zhcm0nIH0sICdza2lsbCcpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHNraWxsUmVzdWx0LnJlc29sdXRpb24sICdsb2NhbC1maXJzdCcpO1xuXHRcdFx0aWYgKHNraWxsUmVzdWx0LnJlc29sdXRpb24gIT09ICdsb2NhbC1maXJzdCcpIHRocm93IG5ldyBFcnJvcignVHlwZSBndWFyZCcpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHNraWxsUmVzdWx0LmNvbXBvbmVudC50eXBlLCAnc2tpbGwnKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChza2lsbFJlc3VsdC5jb21wb25lbnQubmFtZSwgJ2hlbHBlci1za2lsbCcpO1xuXG5cdFx0XHQvLyBSZXF1ZXN0IGFnZW50IC0gc2hvdWxkIGZpbmQgaGVscGVyLWFnZW50XG5cdFx0XHRjb25zdCBhZ2VudFJlc3VsdCA9IHJlc29sdmVyLnJlc29sdmUoJ2hlbHBlci1hZ2VudCcsIHsgY2FsbGVyTmFtZXNwYWNlOiAnZmFybScgfSwgJ2FnZW50Jyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoYWdlbnRSZXN1bHQucmVzb2x1dGlvbiwgJ2xvY2FsLWZpcnN0Jyk7XG5cdFx0XHRpZiAoYWdlbnRSZXN1bHQucmVzb2x1dGlvbiAhPT0gJ2xvY2FsLWZpcnN0JykgdGhyb3cgbmV3IEVycm9yKCdUeXBlIGd1YXJkJyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoYWdlbnRSZXN1bHQuY29tcG9uZW50LnR5cGUsICdhZ2VudCcpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKGFnZW50UmVzdWx0LmNvbXBvbmVudC5uYW1lLCAnaGVscGVyLWFnZW50Jyk7XG5cdFx0fSk7XG5cdH0pO1xuXG5cdGRlc2NyaWJlKCdzaG9ydGhhbmQgcmVzb2x1dGlvbiAoUjAwOSknLCAoKSA9PiB7XG5cdFx0aXQoJ3Nob3VsZCByZXNvbHZlIHVuYW1iaWd1b3VzIHNob3J0aGFuZCB3aXRoIHNpbmdsZSBtYXRjaCcsICgpID0+IHtcblx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0bmFtZTogJ2ZlZWQtY2hpY2tlbnMnLFxuXHRcdFx0XHRuYW1lc3BhY2U6ICdmYXJtJyxcblx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0ZmlsZVBhdGg6ICcvZmFybS9mZWVkLWNoaWNrZW5zL1NLSUxMLm1kJyxcblx0XHRcdFx0c291cmNlOiAncGx1Z2luOmZhcm0nLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogJ0ZlZWQgY2hpY2tlbnMnLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblxuXHRcdFx0Y29uc3QgcmVzdWx0ID0gcmVzb2x2ZXIucmVzb2x2ZSgnZmVlZC1jaGlja2VucycpO1xuXG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LnJlc29sdXRpb24sICdzaG9ydGhhbmQnKTtcblx0XHRcdGlmIChyZXN1bHQucmVzb2x1dGlvbiAhPT0gJ3Nob3J0aGFuZCcpIHRocm93IG5ldyBFcnJvcignVHlwZSBndWFyZCcpO1xuXG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LnJlcXVlc3RlZE5hbWUsICdmZWVkLWNoaWNrZW5zJyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LmNvbXBvbmVudC5jYW5vbmljYWxOYW1lLCAnZmFybTpmZWVkLWNoaWNrZW5zJyk7XG5cdFx0fSk7XG5cblx0XHRpdCgnc2hvdWxkIHJldHVybiBhbWJpZ3VvdXMgd2l0aCBjYW5kaWRhdGVzIGZvciBtdWx0aXBsZSBtYXRjaGVzJywgKCkgPT4ge1xuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRuYW1lOiAnY2FsbC1ob3JzZScsXG5cdFx0XHRcdG5hbWVzcGFjZTogJ2Zhcm0nLFxuXHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRmaWxlUGF0aDogJy9mYXJtL2NhbGwtaG9yc2UvU0tJTEwubWQnLFxuXHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46ZmFybScsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiAnRmFybSBob3JzZSBjYWxsZXInLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0bmFtZTogJ2NhbGwtaG9yc2UnLFxuXHRcdFx0XHRuYW1lc3BhY2U6ICd6b28nLFxuXHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRmaWxlUGF0aDogJy96b28vY2FsbC1ob3JzZS9TS0lMTC5tZCcsXG5cdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjp6b28nLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogJ1pvbyBob3JzZSBjYWxsZXInLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblxuXHRcdFx0Y29uc3QgcmVzdWx0ID0gcmVzb2x2ZXIucmVzb2x2ZSgnY2FsbC1ob3JzZScpO1xuXG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LnJlc29sdXRpb24sICdhbWJpZ3VvdXMnKTtcblx0XHRcdGlmIChyZXN1bHQucmVzb2x1dGlvbiAhPT0gJ2FtYmlndW91cycpIHRocm93IG5ldyBFcnJvcignVHlwZSBndWFyZCcpO1xuXG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LnJlcXVlc3RlZE5hbWUsICdjYWxsLWhvcnNlJyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LmNhbmRpZGF0ZXMubGVuZ3RoLCAyKTtcblxuXHRcdFx0Y29uc3QgY2Fub25pY2FsTmFtZXMgPSByZXN1bHQuY2FuZGlkYXRlcy5tYXAoKGMpID0+IGMuY2Fub25pY2FsTmFtZSkuc29ydCgpO1xuXHRcdFx0YXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChjYW5vbmljYWxOYW1lcywgWydmYXJtOmNhbGwtaG9yc2UnLCAnem9vOmNhbGwtaG9yc2UnXSk7XG5cdFx0fSk7XG5cblx0XHRpdCgnc2hvdWxkIHJldHVybiBub3QtZm91bmQgZm9yIG5vbi1leGlzdGVudCBiYXJlIG5hbWUnLCAoKSA9PiB7XG5cdFx0XHRjb25zdCByZXN1bHQgPSByZXNvbHZlci5yZXNvbHZlKCdub25leGlzdGVudCcpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5yZXNvbHV0aW9uLCAnbm90LWZvdW5kJyk7XG5cdFx0fSk7XG5cblx0XHRpdCgnc2hvdWxkIHJldHVybiBub3QtZm91bmQgd2hlbiB0eXBlIGZpbHRlciBlbGltaW5hdGVzIGFsbCBtYXRjaGVzJywgKCkgPT4ge1xuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRuYW1lOiAnaGVscGVyJyxcblx0XHRcdFx0bmFtZXNwYWNlOiAnZmFybScsXG5cdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdGZpbGVQYXRoOiAnL2Zhcm0vaGVscGVyL1NLSUxMLm1kJyxcblx0XHRcdFx0c291cmNlOiAncGx1Z2luOmZhcm0nLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogJ0hlbHBlciBza2lsbCcsXG5cdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdH0pO1xuXG5cdFx0XHRjb25zdCByZXN1bHQgPSByZXNvbHZlci5yZXNvbHZlKCdoZWxwZXInLCB1bmRlZmluZWQsICdhZ2VudCcpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5yZXNvbHV0aW9uLCAnbm90LWZvdW5kJyk7XG5cdFx0fSk7XG5cdH0pO1xuXG5cdGRlc2NyaWJlKCdmbGF0IGNvbXBvbmVudCBjb21wYXRpYmlsaXR5JywgKCkgPT4ge1xuXHRcdGl0KCdzaG91bGQgcmVzb2x2ZSBmbGF0IGNvbXBvbmVudCBieSBiYXJlIG5hbWUgKG5vIG5hbWVzcGFjZSknLCAoKSA9PiB7XG5cdFx0XHRyZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRcdG5hbWU6ICdjb2RlLXJldmlldycsXG5cdFx0XHRcdG5hbWVzcGFjZTogdW5kZWZpbmVkLFxuXHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRmaWxlUGF0aDogJy9za2lsbHMvY29kZS1yZXZpZXcvU0tJTEwubWQnLFxuXHRcdFx0XHRzb3VyY2U6ICd1c2VyJyxcblx0XHRcdFx0ZGVzY3JpcHRpb246ICdDb2RlIHJldmlldyBza2lsbCcsXG5cdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdH0pO1xuXG5cdFx0XHRjb25zdCByZXN1bHQgPSByZXNvbHZlci5yZXNvbHZlKCdjb2RlLXJldmlldycpO1xuXG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LnJlc29sdXRpb24sICdzaG9ydGhhbmQnKTtcblx0XHRcdGlmIChyZXN1bHQucmVzb2x1dGlvbiAhPT0gJ3Nob3J0aGFuZCcpIHRocm93IG5ldyBFcnJvcignVHlwZSBndWFyZCcpO1xuXG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LmNvbXBvbmVudC5jYW5vbmljYWxOYW1lLCAnY29kZS1yZXZpZXcnKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuY29tcG9uZW50Lm5hbWVzcGFjZSwgdW5kZWZpbmVkKTtcblx0XHR9KTtcblxuXHRcdGl0KCdzaG91bGQgaW5jbHVkZSBmbGF0IGNvbXBvbmVudCBpbiBhbWJpZ3VvdXMgY2FuZGlkYXRlcycsICgpID0+IHtcblx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0bmFtZTogJ2hlbHBlcicsXG5cdFx0XHRcdG5hbWVzcGFjZTogdW5kZWZpbmVkLFxuXHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRmaWxlUGF0aDogJy9za2lsbHMvaGVscGVyL1NLSUxMLm1kJyxcblx0XHRcdFx0c291cmNlOiAndXNlcicsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiAnVXNlciBoZWxwZXInLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0bmFtZTogJ2hlbHBlcicsXG5cdFx0XHRcdG5hbWVzcGFjZTogJ2Zhcm0nLFxuXHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRmaWxlUGF0aDogJy9mYXJtL2hlbHBlci9TS0lMTC5tZCcsXG5cdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjpmYXJtJyxcblx0XHRcdFx0ZGVzY3JpcHRpb246ICdGYXJtIGhlbHBlcicsXG5cdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdH0pO1xuXG5cdFx0XHRjb25zdCByZXN1bHQgPSByZXNvbHZlci5yZXNvbHZlKCdoZWxwZXInKTtcblxuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5yZXNvbHV0aW9uLCAnYW1iaWd1b3VzJyk7XG5cdFx0XHRpZiAocmVzdWx0LnJlc29sdXRpb24gIT09ICdhbWJpZ3VvdXMnKSB0aHJvdyBuZXcgRXJyb3IoJ1R5cGUgZ3VhcmQnKTtcblxuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5jYW5kaWRhdGVzLmxlbmd0aCwgMik7XG5cdFx0XHRjb25zdCBjYW5vbmljYWxOYW1lcyA9IHJlc3VsdC5jYW5kaWRhdGVzLm1hcCgoYykgPT4gYy5jYW5vbmljYWxOYW1lKS5zb3J0KCk7XG5cdFx0XHRhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGNhbm9uaWNhbE5hbWVzLCBbJ2Zhcm06aGVscGVyJywgJ2hlbHBlciddKTtcblx0XHR9KTtcblx0fSk7XG5cblx0ZGVzY3JpYmUoJ3R5cGUgZmlsdGVyaW5nJywgKCkgPT4ge1xuXHRcdGl0KCdzaG91bGQgZmlsdGVyIGJ5IHNraWxsIHR5cGUgYWNyb3NzIG5hbWVzcGFjZXMnLCAoKSA9PiB7XG5cdFx0XHQvLyBSZWdpc3RlciBza2lsbCBpbiBvbmUgbmFtZXNwYWNlXG5cdFx0XHRyZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRcdG5hbWU6ICdyZXZpZXcnLFxuXHRcdFx0XHRuYW1lc3BhY2U6ICd0b29scycsXG5cdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdGZpbGVQYXRoOiAnL3Rvb2xzL3Jldmlldy9TS0lMTC5tZCcsXG5cdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjp0b29scycsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiAnUmV2aWV3IHNraWxsJyxcblx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0fSk7XG5cdFx0XHQvLyBSZWdpc3RlciBhZ2VudCBpbiBhbm90aGVyIG5hbWVzcGFjZSAoZGlmZmVyZW50IGNhbm9uaWNhbCBuYW1lKVxuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRuYW1lOiAncmV2aWV3Jyxcblx0XHRcdFx0bmFtZXNwYWNlOiAnYWdlbnRzJyxcblx0XHRcdFx0dHlwZTogJ2FnZW50Jyxcblx0XHRcdFx0ZmlsZVBhdGg6ICcvYWdlbnRzL3Jldmlldy9BR0VOVC5tZCcsXG5cdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjphZ2VudHMnLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogJ1JldmlldyBhZ2VudCcsXG5cdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdH0pO1xuXG5cdFx0XHQvLyBCb3RoIGhhdmUgc2FtZSBiYXJlIG5hbWUsIGZpbHRlcmluZyBieSB0eXBlIGRpc2FtYmlndWF0ZXNcblx0XHRcdGNvbnN0IHNraWxsUmVzdWx0ID0gcmVzb2x2ZXIucmVzb2x2ZSgncmV2aWV3JywgdW5kZWZpbmVkLCAnc2tpbGwnKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChza2lsbFJlc3VsdC5yZXNvbHV0aW9uLCAnc2hvcnRoYW5kJyk7XG5cdFx0XHRpZiAoc2tpbGxSZXN1bHQucmVzb2x1dGlvbiAhPT0gJ3Nob3J0aGFuZCcpIHRocm93IG5ldyBFcnJvcignVHlwZSBndWFyZCcpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHNraWxsUmVzdWx0LmNvbXBvbmVudC50eXBlLCAnc2tpbGwnKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChza2lsbFJlc3VsdC5jb21wb25lbnQubmFtZXNwYWNlLCAndG9vbHMnKTtcblxuXHRcdFx0Y29uc3QgYWdlbnRSZXN1bHQgPSByZXNvbHZlci5yZXNvbHZlKCdyZXZpZXcnLCB1bmRlZmluZWQsICdhZ2VudCcpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKGFnZW50UmVzdWx0LnJlc29sdXRpb24sICdzaG9ydGhhbmQnKTtcblx0XHRcdGlmIChhZ2VudFJlc3VsdC5yZXNvbHV0aW9uICE9PSAnc2hvcnRoYW5kJykgdGhyb3cgbmV3IEVycm9yKCdUeXBlIGd1YXJkJyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoYWdlbnRSZXN1bHQuY29tcG9uZW50LnR5cGUsICdhZ2VudCcpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKGFnZW50UmVzdWx0LmNvbXBvbmVudC5uYW1lc3BhY2UsICdhZ2VudHMnKTtcblx0XHR9KTtcblxuXHRcdGl0KCdzaG91bGQgcmVzb2x2ZSB1bmlxdWUgc2tpbGwgYW1vbmcgbXVsdGlwbGUgYWdlbnRzIHdpdGggc2FtZSBuYW1lJywgKCkgPT4ge1xuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRuYW1lOiAnYXNzaXN0YW50Jyxcblx0XHRcdFx0bmFtZXNwYWNlOiAndG9vbHMnLFxuXHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRmaWxlUGF0aDogJy90b29scy9hc3Npc3RhbnQvU0tJTEwubWQnLFxuXHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46dG9vbHMnLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogJ0Fzc2lzdGFudCBza2lsbCcsXG5cdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdH0pO1xuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRuYW1lOiAnYXNzaXN0YW50Jyxcblx0XHRcdFx0bmFtZXNwYWNlOiAnb3RoZXInLFxuXHRcdFx0XHR0eXBlOiAnYWdlbnQnLFxuXHRcdFx0XHRmaWxlUGF0aDogJy9vdGhlci9hc3Npc3RhbnQvQUdFTlQubWQnLFxuXHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46b3RoZXInLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogJ0Fzc2lzdGFudCBhZ2VudCcsXG5cdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdH0pO1xuXG5cdFx0XHRjb25zdCByZXN1bHQgPSByZXNvbHZlci5yZXNvbHZlKCdhc3Npc3RhbnQnLCB1bmRlZmluZWQsICdza2lsbCcpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5yZXNvbHV0aW9uLCAnc2hvcnRoYW5kJyk7XG5cdFx0XHRpZiAocmVzdWx0LnJlc29sdXRpb24gIT09ICdzaG9ydGhhbmQnKSB0aHJvdyBuZXcgRXJyb3IoJ1R5cGUgZ3VhcmQnKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuY29tcG9uZW50LmNhbm9uaWNhbE5hbWUsICd0b29sczphc3Npc3RhbnQnKTtcblx0XHR9KTtcblx0fSk7XG5cblx0ZGVzY3JpYmUoJ3Jlc29sdXRpb24gcGF0aCBkaWFnbm9zdGljcycsICgpID0+IHtcblx0XHRpdCgnc2hvdWxkIGluY2x1ZGUgcmVxdWVzdGVkTmFtZSBpbiBhbGwgcmVzdWx0IHR5cGVzJywgKCkgPT4ge1xuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRuYW1lOiAnc2tpbGwnLFxuXHRcdFx0XHRuYW1lc3BhY2U6ICducycsXG5cdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdGZpbGVQYXRoOiAnL3NraWxsL1NLSUxMLm1kJyxcblx0XHRcdFx0c291cmNlOiAndGVzdCcsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiB1bmRlZmluZWQsXG5cdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdH0pO1xuXG5cdFx0XHRjb25zdCBjYW5vbiA9IHJlc29sdmVyLnJlc29sdmUoJ25zOnNraWxsJyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoY2Fub24ucmVxdWVzdGVkTmFtZSwgJ25zOnNraWxsJyk7XG5cblx0XHRcdGNvbnN0IGxvY2FsID0gcmVzb2x2ZXIucmVzb2x2ZSgnc2tpbGwnLCB7IGNhbGxlck5hbWVzcGFjZTogJ25zJyB9KTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChsb2NhbC5yZXF1ZXN0ZWROYW1lLCAnc2tpbGwnKTtcblxuXHRcdFx0Y29uc3Qgc2hvcnQgPSByZXNvbHZlci5yZXNvbHZlKCdza2lsbCcpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHNob3J0LnJlcXVlc3RlZE5hbWUsICdza2lsbCcpO1xuXG5cdFx0XHRjb25zdCBub3RGb3VuZCA9IHJlc29sdmVyLnJlc29sdmUoJ21pc3NpbmcnKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChub3RGb3VuZC5yZXF1ZXN0ZWROYW1lLCAnbWlzc2luZycpO1xuXHRcdH0pO1xuXG5cdFx0aXQoJ3Nob3VsZCBwcm92aWRlIG1hdGNoZWROYW1lc3BhY2UgaW4gbG9jYWwtZmlyc3QgcmVzdWx0cycsICgpID0+IHtcblx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0bmFtZTogJ3NraWxsJyxcblx0XHRcdFx0bmFtZXNwYWNlOiAnbXktbnMnLFxuXHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRmaWxlUGF0aDogJy9za2lsbC9TS0lMTC5tZCcsXG5cdFx0XHRcdHNvdXJjZTogJ3Rlc3QnLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogdW5kZWZpbmVkLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblxuXHRcdFx0Y29uc3QgcmVzdWx0ID0gcmVzb2x2ZXIucmVzb2x2ZSgnc2tpbGwnLCB7IGNhbGxlck5hbWVzcGFjZTogJ215LW5zJyB9KTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQucmVzb2x1dGlvbiwgJ2xvY2FsLWZpcnN0Jyk7XG5cblx0XHRcdGlmIChyZXN1bHQucmVzb2x1dGlvbiA9PT0gJ2xvY2FsLWZpcnN0Jykge1xuXHRcdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0Lm1hdGNoZWROYW1lc3BhY2UsICdteS1ucycpO1xuXHRcdFx0fVxuXHRcdH0pO1xuXG5cdFx0aXQoJ3Nob3VsZCBwcm92aWRlIGZ1bGwgY2FuZGlkYXRlIGxpc3QgaW4gYW1iaWd1b3VzIHJlc3VsdHMnLCAoKSA9PiB7XG5cdFx0XHRyZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRcdG5hbWU6ICdkdXAnLFxuXHRcdFx0XHRuYW1lc3BhY2U6ICdhJyxcblx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0ZmlsZVBhdGg6ICcvYS9kdXAvU0tJTEwubWQnLFxuXHRcdFx0XHRzb3VyY2U6ICdhJyxcblx0XHRcdFx0ZGVzY3JpcHRpb246ICdBIGR1cCcsXG5cdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdH0pO1xuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRuYW1lOiAnZHVwJyxcblx0XHRcdFx0bmFtZXNwYWNlOiAnYicsXG5cdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdGZpbGVQYXRoOiAnL2IvZHVwL1NLSUxMLm1kJyxcblx0XHRcdFx0c291cmNlOiAnYicsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiAnQiBkdXAnLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblxuXHRcdFx0Y29uc3QgcmVzdWx0ID0gcmVzb2x2ZXIucmVzb2x2ZSgnZHVwJyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LnJlc29sdXRpb24sICdhbWJpZ3VvdXMnKTtcblxuXHRcdFx0aWYgKHJlc3VsdC5yZXNvbHV0aW9uID09PSAnYW1iaWd1b3VzJykge1xuXHRcdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LmNhbmRpZGF0ZXMubGVuZ3RoLCAyKTtcblx0XHRcdFx0Zm9yIChjb25zdCBjYW5kaWRhdGUgb2YgcmVzdWx0LmNhbmRpZGF0ZXMpIHtcblx0XHRcdFx0XHRhc3NlcnQub2soY2FuZGlkYXRlLmNhbm9uaWNhbE5hbWUpO1xuXHRcdFx0XHRcdGFzc2VydC5vayhjYW5kaWRhdGUuZmlsZVBhdGgpO1xuXHRcdFx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChjYW5kaWRhdGUubmFtZSwgJ2R1cCcpO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fSk7XG5cdH0pO1xuXG5cdGRlc2NyaWJlKCdlZGdlIGNhc2VzJywgKCkgPT4ge1xuXHRcdGl0KCdzaG91bGQgaGFuZGxlIGVtcHR5IHJlZ2lzdHJ5IGdyYWNlZnVsbHknLCAoKSA9PiB7XG5cdFx0XHRjb25zdCByZXN1bHQgPSByZXNvbHZlci5yZXNvbHZlKCdhbnl0aGluZycpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5yZXNvbHV0aW9uLCAnbm90LWZvdW5kJyk7XG5cdFx0fSk7XG5cblx0XHRpdCgnc2hvdWxkIGhhbmRsZSBlbXB0eSBjYWxsZXIgbmFtZXNwYWNlIHN0cmluZycsICgpID0+IHtcblx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0bmFtZTogJ3NraWxsJyxcblx0XHRcdFx0bmFtZXNwYWNlOiAnbnMnLFxuXHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRmaWxlUGF0aDogJy9za2lsbC9TS0lMTC5tZCcsXG5cdFx0XHRcdHNvdXJjZTogJ3Rlc3QnLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogdW5kZWZpbmVkLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblxuXHRcdFx0Ly8gRW1wdHkgc3RyaW5nIGlzIGZhbHN5LCBzaG91bGQgZmFsbCB0aHJvdWdoIHRvIHNob3J0aGFuZFxuXHRcdFx0Y29uc3QgcmVzdWx0ID0gcmVzb2x2ZXIucmVzb2x2ZSgnc2tpbGwnLCB7IGNhbGxlck5hbWVzcGFjZTogJycgfSk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LnJlc29sdXRpb24sICdzaG9ydGhhbmQnKTtcblx0XHR9KTtcblx0fSk7XG5cblx0ZGVzY3JpYmUoJ2FsaWFzIHJlc29sdXRpb24nLCAoKSA9PiB7XG5cdFx0aXQoJ3Nob3VsZCByZXNvbHZlIGFsaWFzIHdpdGggYWxpYXMgcmVzdWx0IHR5cGUnLCAoKSA9PiB7XG5cdFx0XHRyZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRcdG5hbWU6ICczZC12aXN1YWxpemVyJyxcblx0XHRcdFx0bmFtZXNwYWNlOiAncHl0aG9uLXRvb2xzJyxcblx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0ZmlsZVBhdGg6ICcvcHl0aG9uLXRvb2xzLzNkLXZpc3VhbGl6ZXIvU0tJTEwubWQnLFxuXHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46cHl0aG9uLXRvb2xzJyxcblx0XHRcdFx0ZGVzY3JpcHRpb246ICczRCB2aXN1YWxpemF0aW9uJyxcblx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0fSk7XG5cdFx0XHRyZWdpc3RyeS5yZWdpc3RlckFsaWFzKCdweTNkJywgJ3B5dGhvbi10b29sczozZC12aXN1YWxpemVyJyk7XG5cblx0XHRcdGNvbnN0IHJlc3VsdCA9IHJlc29sdmVyLnJlc29sdmUoJ3B5M2QnKTtcblxuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5yZXNvbHV0aW9uLCAnYWxpYXMnKTtcblx0XHRcdGlmIChyZXN1bHQucmVzb2x1dGlvbiAhPT0gJ2FsaWFzJykgdGhyb3cgbmV3IEVycm9yKCdUeXBlIGd1YXJkJyk7XG5cblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQucmVxdWVzdGVkTmFtZSwgJ3B5M2QnKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuYWxpYXMsICdweTNkJyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LmNhbm9uaWNhbE5hbWUsICdweXRob24tdG9vbHM6M2QtdmlzdWFsaXplcicpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5jb21wb25lbnQuY2Fub25pY2FsTmFtZSwgJ3B5dGhvbi10b29sczozZC12aXN1YWxpemVyJyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LmNvbXBvbmVudC50eXBlLCAnc2tpbGwnKTtcblx0XHR9KTtcblxuXHRcdGl0KCdzaG91bGQgcmVzcGVjdCB0eXBlIGZpbHRlciBpbiBhbGlhcyByZXNvbHV0aW9uJywgKCkgPT4ge1xuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRuYW1lOiAndmlzdWFsaXplcicsXG5cdFx0XHRcdG5hbWVzcGFjZTogJ3Rvb2xzJyxcblx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0ZmlsZVBhdGg6ICcvdG9vbHMvdmlzdWFsaXplci9TS0lMTC5tZCcsXG5cdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjp0b29scycsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiAnVmlzdWFsaXplciBza2lsbCcsXG5cdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdH0pO1xuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXJBbGlhcygndml6JywgJ3Rvb2xzOnZpc3VhbGl6ZXInKTtcblxuXHRcdFx0Ly8gVHlwZSBmaWx0ZXIgbWF0Y2hlcyAtIHNob3VsZCByZXNvbHZlXG5cdFx0XHRjb25zdCBza2lsbFJlc3VsdCA9IHJlc29sdmVyLnJlc29sdmUoJ3ZpeicsIHVuZGVmaW5lZCwgJ3NraWxsJyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoc2tpbGxSZXN1bHQucmVzb2x1dGlvbiwgJ2FsaWFzJyk7XG5cdFx0XHRpZiAoc2tpbGxSZXN1bHQucmVzb2x1dGlvbiAhPT0gJ2FsaWFzJykgdGhyb3cgbmV3IEVycm9yKCdUeXBlIGd1YXJkJyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoc2tpbGxSZXN1bHQuY29tcG9uZW50LnR5cGUsICdza2lsbCcpO1xuXG5cdFx0XHQvLyBUeXBlIGZpbHRlciBkb2Vzbid0IG1hdGNoIC0gc2hvdWxkIG5vdCByZXNvbHZlIGFsaWFzXG5cdFx0XHRjb25zdCBhZ2VudFJlc3VsdCA9IHJlc29sdmVyLnJlc29sdmUoJ3ZpeicsIHVuZGVmaW5lZCwgJ2FnZW50Jyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoYWdlbnRSZXN1bHQucmVzb2x1dGlvbiwgJ25vdC1mb3VuZCcpO1xuXHRcdH0pO1xuXG5cdFx0aXQoJ3Nob3VsZCBwcmlvcml0aXplIGFsaWFzIG92ZXIgc2hvcnRoYW5kIChhbGlhcyBjaGVja2VkIGZpcnN0KScsICgpID0+IHtcblx0XHRcdC8vIFJlZ2lzdGVyIGEgY29tcG9uZW50IHRoYXQgY291bGQgbWF0Y2ggYXMgc2hvcnRoYW5kXG5cdFx0XHRyZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRcdG5hbWU6ICdzaG9ydGN1dCcsXG5cdFx0XHRcdG5hbWVzcGFjZTogJ290aGVyLXBsdWdpbicsXG5cdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdGZpbGVQYXRoOiAnL290aGVyL3Nob3J0Y3V0L1NLSUxMLm1kJyxcblx0XHRcdFx0c291cmNlOiAncGx1Z2luOm90aGVyLXBsdWdpbicsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiAnT3RoZXIgc2hvcnRjdXQnLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblxuXHRcdFx0Ly8gUmVnaXN0ZXIgYSBkaWZmZXJlbnQgY29tcG9uZW50IHdpdGggYW4gYWxpYXMgdXNpbmcgdGhlIHNhbWUgYmFyZSBuYW1lXG5cdFx0XHRyZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRcdG5hbWU6ICdhbGlhc2VkLXNraWxsJyxcblx0XHRcdFx0bmFtZXNwYWNlOiAnbWFpbi1wbHVnaW4nLFxuXHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRmaWxlUGF0aDogJy9tYWluL2FsaWFzZWQtc2tpbGwvU0tJTEwubWQnLFxuXHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46bWFpbi1wbHVnaW4nLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogJ01haW4gc2tpbGwnLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyQWxpYXMoJ3Nob3J0Y3V0JywgJ21haW4tcGx1Z2luOmFsaWFzZWQtc2tpbGwnKTtcblxuXHRcdFx0Ly8gJ3Nob3J0Y3V0JyBzaG91bGQgcmVzb2x2ZSB2aWEgYWxpYXMsIG5vdCBzaG9ydGhhbmRcblx0XHRcdGNvbnN0IHJlc3VsdCA9IHJlc29sdmVyLnJlc29sdmUoJ3Nob3J0Y3V0Jyk7XG5cblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQucmVzb2x1dGlvbiwgJ2FsaWFzJyk7XG5cdFx0XHRpZiAocmVzdWx0LnJlc29sdXRpb24gIT09ICdhbGlhcycpIHRocm93IG5ldyBFcnJvcignVHlwZSBndWFyZCcpO1xuXG5cdFx0XHQvLyBTaG91bGQgcG9pbnQgdG8gdGhlIGFsaWFzZWQgdGFyZ2V0LCBub3QgdGhlIHNob3J0aGFuZCBtYXRjaFxuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5jYW5vbmljYWxOYW1lLCAnbWFpbi1wbHVnaW46YWxpYXNlZC1za2lsbCcpO1xuXHRcdH0pO1xuXG5cdFx0aXQoJ3Nob3VsZCBwcmlvcml0aXplIGFsaWFzIG92ZXIgbG9jYWwtZmlyc3QgKGFsaWFzIGNoZWNrZWQgZmlyc3QpJywgKCkgPT4ge1xuXHRcdFx0Ly8gUmVnaXN0ZXIgY29tcG9uZW50cyBpbiB0d28gbmFtZXNwYWNlc1xuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRuYW1lOiAnaGVscGVyJyxcblx0XHRcdFx0bmFtZXNwYWNlOiAnbG9jYWwtbnMnLFxuXHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRmaWxlUGF0aDogJy9sb2NhbC1ucy9oZWxwZXIvU0tJTEwubWQnLFxuXHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46bG9jYWwtbnMnLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogJ0xvY2FsIGhlbHBlcicsXG5cdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdH0pO1xuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRuYW1lOiAnYWxpYXNlZC1oZWxwZXInLFxuXHRcdFx0XHRuYW1lc3BhY2U6ICdhbGlhcy1ucycsXG5cdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdGZpbGVQYXRoOiAnL2FsaWFzLW5zL2FsaWFzZWQtaGVscGVyL1NLSUxMLm1kJyxcblx0XHRcdFx0c291cmNlOiAncGx1Z2luOmFsaWFzLW5zJyxcblx0XHRcdFx0ZGVzY3JpcHRpb246ICdBbGlhc2VkIGhlbHBlcicsXG5cdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdH0pO1xuXG5cdFx0XHQvLyBDcmVhdGUgYWxpYXMgdGhhdCBzaGFkb3dzIGxvY2FsIG5hbWVzcGFjZSBuYW1lXG5cdFx0XHRyZWdpc3RyeS5yZWdpc3RlckFsaWFzKCdoZWxwZXInLCAnYWxpYXMtbnM6YWxpYXNlZC1oZWxwZXInKTtcblxuXHRcdFx0Ly8gRXZlbiB3aXRoIGNhbGxlck5hbWVzcGFjZT0nbG9jYWwtbnMnLCBhbGlhcyBzaG91bGQgd2luXG5cdFx0XHRjb25zdCByZXN1bHQgPSByZXNvbHZlci5yZXNvbHZlKCdoZWxwZXInLCB7IGNhbGxlck5hbWVzcGFjZTogJ2xvY2FsLW5zJyB9KTtcblxuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5yZXNvbHV0aW9uLCAnYWxpYXMnKTtcblx0XHRcdGlmIChyZXN1bHQucmVzb2x1dGlvbiAhPT0gJ2FsaWFzJykgdGhyb3cgbmV3IEVycm9yKCdUeXBlIGd1YXJkJyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LmNhbm9uaWNhbE5hbWUsICdhbGlhcy1uczphbGlhc2VkLWhlbHBlcicpO1xuXHRcdH0pO1xuXG5cdFx0aXQoJ3Nob3VsZCBpbmNsdWRlIGFsaWFzIGFuZCBjYW5vbmljYWxOYW1lIGluIHJlc3VsdCcsICgpID0+IHtcblx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0bmFtZTogJ2NvZGUtcmV2aWV3Jyxcblx0XHRcdFx0bmFtZXNwYWNlOiAndG9vbHMnLFxuXHRcdFx0XHR0eXBlOiAnYWdlbnQnLFxuXHRcdFx0XHRmaWxlUGF0aDogJy90b29scy9jb2RlLXJldmlldy9BR0VOVC5tZCcsXG5cdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjp0b29scycsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiAnQ29kZSByZXZpZXcgYWdlbnQnLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyQWxpYXMoJ3JldmlldycsICd0b29sczpjb2RlLXJldmlldycpO1xuXG5cdFx0XHRjb25zdCByZXN1bHQgPSByZXNvbHZlci5yZXNvbHZlKCdyZXZpZXcnKTtcblxuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5yZXNvbHV0aW9uLCAnYWxpYXMnKTtcblx0XHRcdGlmIChyZXN1bHQucmVzb2x1dGlvbiAhPT0gJ2FsaWFzJykgdGhyb3cgbmV3IEVycm9yKCdUeXBlIGd1YXJkJyk7XG5cblx0XHRcdC8vIEJvdGggYWxpYXMgYW5kIGNhbm9uaWNhbE5hbWUgc2hvdWxkIGJlIHByZXNlbnRcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuYWxpYXMsICdyZXZpZXcnKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuY2Fub25pY2FsTmFtZSwgJ3Rvb2xzOmNvZGUtcmV2aWV3Jyk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LmNvbXBvbmVudC5jYW5vbmljYWxOYW1lLCAndG9vbHM6Y29kZS1yZXZpZXcnKTtcblx0XHR9KTtcblxuXHRcdGl0KCdzaG91bGQgZmFsbCB0aHJvdWdoIHRvIGxvY2FsLWZpcnN0L3Nob3J0aGFuZCB3aGVuIGFsaWFzIGRvZXMgbm90IGV4aXN0JywgKCkgPT4ge1xuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRuYW1lOiAnZXhpc3RpbmcnLFxuXHRcdFx0XHRuYW1lc3BhY2U6ICducycsXG5cdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdGZpbGVQYXRoOiAnL25zL2V4aXN0aW5nL1NLSUxMLm1kJyxcblx0XHRcdFx0c291cmNlOiAncGx1Z2luOm5zJyxcblx0XHRcdFx0ZGVzY3JpcHRpb246ICdFeGlzdGluZyBza2lsbCcsXG5cdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdH0pO1xuXG5cdFx0XHQvLyBObyBhbGlhcyByZWdpc3RlcmVkLCBzaG91bGQgZmFsbCB0aHJvdWdoIHRvIGxvY2FsLWZpcnN0XG5cdFx0XHRjb25zdCByZXN1bHQgPSByZXNvbHZlci5yZXNvbHZlKCdleGlzdGluZycsIHsgY2FsbGVyTmFtZXNwYWNlOiAnbnMnIH0pO1xuXG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LnJlc29sdXRpb24sICdsb2NhbC1maXJzdCcpO1xuXHRcdFx0aWYgKHJlc3VsdC5yZXNvbHV0aW9uICE9PSAnbG9jYWwtZmlyc3QnKSB0aHJvdyBuZXcgRXJyb3IoJ1R5cGUgZ3VhcmQnKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuY29tcG9uZW50LmNhbm9uaWNhbE5hbWUsICduczpleGlzdGluZycpO1xuXHRcdH0pO1xuXG5cdFx0aXQoJ3Nob3VsZCBmYWxsIHRocm91Z2ggdG8gc2hvcnRoYW5kIHdoZW4gYWxpYXMgZG9lcyBub3QgZXhpc3QgYW5kIG5vIGxvY2FsIG1hdGNoJywgKCkgPT4ge1xuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRuYW1lOiAndW5pcXVlJyxcblx0XHRcdFx0bmFtZXNwYWNlOiAncGx1Z2luLWEnLFxuXHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRmaWxlUGF0aDogJy9wbHVnaW4tYS91bmlxdWUvU0tJTEwubWQnLFxuXHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46cGx1Z2luLWEnLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogJ1VuaXF1ZSBza2lsbCcsXG5cdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdH0pO1xuXG5cdFx0XHQvLyBObyBhbGlhcyByZWdpc3RlcmVkLCBubyBsb2NhbCBtYXRjaCwgc2hvdWxkIGZhbGwgdGhyb3VnaCB0byBzaG9ydGhhbmRcblx0XHRcdGNvbnN0IHJlc3VsdCA9IHJlc29sdmVyLnJlc29sdmUoJ3VuaXF1ZScsIHsgY2FsbGVyTmFtZXNwYWNlOiAnb3RoZXItbnMnIH0pO1xuXG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LnJlc29sdXRpb24sICdzaG9ydGhhbmQnKTtcblx0XHRcdGlmIChyZXN1bHQucmVzb2x1dGlvbiAhPT0gJ3Nob3J0aGFuZCcpIHRocm93IG5ldyBFcnJvcignVHlwZSBndWFyZCcpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5jb21wb25lbnQuY2Fub25pY2FsTmFtZSwgJ3BsdWdpbi1hOnVuaXF1ZScpO1xuXHRcdH0pO1xuXHR9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBWUEsU0FBUyxVQUFVLElBQUksa0JBQWtCO0FBQ3pDLE9BQU8sWUFBWTtBQUNuQixTQUFTLDBCQUEwQjtBQUNuQyxTQUFTLDBCQUEwQjtBQUVuQyxTQUFTLHNCQUFzQixNQUFNO0FBQ3BDLE1BQUk7QUFDSixNQUFJO0FBRUosYUFBVyxNQUFNO0FBQ2hCLGVBQVcsSUFBSSxtQkFBbUI7QUFDbEMsZUFBVyxJQUFJLG1CQUFtQixRQUFRO0FBQUEsRUFDM0MsQ0FBQztBQUVELFdBQVMsaUNBQWlDLE1BQU07QUFDL0MsT0FBRyxvRUFBb0UsTUFBTTtBQUM1RSxlQUFTLFNBQVM7QUFBQSxRQUNqQixNQUFNO0FBQUEsUUFDTixXQUFXO0FBQUEsUUFDWCxNQUFNO0FBQUEsUUFDTixVQUFVO0FBQUEsUUFDVixRQUFRO0FBQUEsUUFDUixhQUFhO0FBQUEsUUFD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
