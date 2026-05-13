import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { NamespacedRegistry } from "../namespaced-registry.js";
import { NamespacedResolver } from "../namespaced-resolver.js";
import {
  analyzeCollisions,
  doctorReport
} from "../collision-diagnostics.js";
describe("collision-diagnostics", () => {
  let registry;
  let resolver;
  beforeEach(() => {
    registry = new NamespacedRegistry();
    resolver = new NamespacedResolver(registry);
  });
  describe("analyzeCollisions", () => {
    describe("canonical-conflict detection", () => {
      it("should detect canonical conflict when same canonical name registered twice", () => {
        registry.register({
          name: "code-review",
          namespace: "my-plugin",
          type: "skill",
          filePath: "/plugins/my-plugin/skills/code-review/SKILL.md",
          source: "plugin:my-plugin",
          description: "Reviews code",
          metadata: {}
        });
        registry.register({
          name: "code-review",
          namespace: "my-plugin",
          type: "skill",
          filePath: "/plugins/other/skills/code-review/SKILL.md",
          source: "plugin:other",
          description: "Another code review",
          metadata: {}
        });
        const diagnostics = analyzeCollisions(registry, resolver);
        assert.strictEqual(diagnostics.length, 1);
        assert.strictEqual(diagnostics[0].class, "canonical-conflict");
        assert.strictEqual(diagnostics[0].severity, "error");
        assert.strictEqual(diagnostics[0].involvedCanonicalNames[0], "my-plugin:code-review");
        assert.ok(diagnostics[0].filePaths.includes("/plugins/my-plugin/skills/code-review/SKILL.md"));
        assert.ok(diagnostics[0].filePaths.includes("/plugins/other/skills/code-review/SKILL.md"));
      });
      it("should include remediation advice for canonical conflict", () => {
        registry.register({
          name: "test-skill",
          namespace: "plugin-a",
          type: "skill",
          filePath: "/a/test-skill/SKILL.md",
          source: "plugin:plugin-a",
          description: "Test",
          metadata: {}
        });
        registry.register({
          name: "test-skill",
          namespace: "plugin-a",
          type: "skill",
          filePath: "/b/test-skill/SKILL.md",
          source: "plugin:plugin-b",
          description: "Test duplicate",
          metadata: {}
        });
        const diagnostics = analyzeCollisions(registry, resolver);
        assert.ok(diagnostics[0].remediation.includes("Rename one of the conflicting components"));
      });
    });
    describe("shorthand-overlap detection", () => {
      it("should detect shorthand overlap when bare name matches multiple namespaces", () => {
        registry.register({
          name: "common-skill",
          namespace: "plugin-a",
          type: "skill",
          filePath: "/a/common-skill/SKILL.md",
          source: "plugin:plugin-a",
          description: "A common skill",
          metadata: {}
        });
        registry.register({
          name: "common-skill",
          namespace: "plugin-b",
          type: "skill",
          filePath: "/b/common-skill/SKILL.md",
          source: "plugin:plugin-b",
          description: "B common skill",
          metadata: {}
        });
        const diagnostics = analyzeCollisions(registry, resolver);
        assert.strictEqual(diagnostics.length, 1);
        assert.strictEqual(diagnostics[0].class, "shorthand-overlap");
        assert.strictEqual(diagnostics[0].severity, "warning");
        assert.strictEqual(diagnostics[0].ambiguousBareName, "common-skill");
        assert.ok(diagnostics[0].involvedCanonicalNames.includes("plugin-a:common-skill"));
        assert.ok(diagnostics[0].involvedCanonicalNames.includes("plugin-b:common-skill"));
      });
      it("should NOT warn when only one component has a given bare name", () => {
        registry.register({
          name: "unique-skill",
          namespace: "plugin-a",
          type: "skill",
          filePath: "/a/unique-skill/SKILL.md",
          source: "plugin:plugin-a",
          description: "Unique",
          metadata: {}
        });
        registry.register({
          name: "other-skill",
          namespace: "plugin-b",
          type: "skill",
          filePath: "/b/other-skill/SKILL.md",
          source: "plugin:plugin-b",
          description: "Other",
          metadata: {}
        });
        const diagnostics = analyzeCollisions(registry, resolver);
        assert.strictEqual(diagnostics.length, 0);
      });
      it("should include canonical name suggestions in remediation for shorthand overlap", () => {
        registry.register({
          name: "ambiguous",
          namespace: "alpha",
          type: "skill",
          filePath: "/alpha/ambiguous/SKILL.md",
          source: "plugin:alpha",
          description: "Alpha ambiguous",
          metadata: {}
        });
        registry.register({
          name: "ambiguous",
          namespace: "beta",
          type: "skill",
          filePath: "/beta/ambiguous/SKILL.md",
          source: "plugin:beta",
          description: "Beta ambiguous",
          metadata: {}
        });
        const diagnostics = analyzeCollisions(registry, resolver);
        assert.ok(diagnostics[0].remediation.includes("`alpha:ambiguous`"));
        assert.ok(diagnostics[0].remediation.includes("`beta:ambiguous`"));
        assert.ok(diagnostics[0].remediation.includes("Use a canonical name"));
      });
    });
    describe("clean registry", () => {
      it("should return no diagnostics for empty registry", () => {
        const diagnostics = analyzeCollisions(registry, resolver);
        assert.strictEqual(diagnostics.length, 0);
      });
      it("should return no diagnostics for registry with unique bare names", () => {
        registry.register({
          name: "skill-a",
          namespace: "plugin-x",
          type: "skill",
          filePath: "/x/skill-a/SKILL.md",
          source: "plugin:plugin-x",
          description: "Skill A",
          metadata: {}
        });
        registry.register({
          name: "skill-b",
          namespace: "plugin-y",
          type: "skill",
          filePath: "/y/skill-b/SKILL.md",
          source: "plugin:plugin-y",
          description: "Skill B",
          metadata: {}
        });
        const diagnostics = analyzeCollisions(registry, resolver);
        assert.strictEqual(diagnostics.length, 0);
      });
    });
    describe("mixed scenarios", () => {
      it("should report both canonical conflict and shorthand overlap in mixed scenario", () => {
        registry.register({
          name: "duplicate",
          namespace: "shared",
          type: "skill",
          filePath: "/first/duplicate/SKILL.md",
          source: "plugin:first",
          description: "First duplicate",
          metadata: {}
        });
        registry.register({
          name: "duplicate",
          namespace: "shared",
          type: "skill",
          filePath: "/second/duplicate/SKILL.md",
          source: "plugin:second",
          description: "Second duplicate",
          metadata: {}
        });
        registry.register({
          name: "overlap",
          namespace: "ns-a",
          type: "skill",
          filePath: "/a/overlap/SKILL.md",
          source: "plugin:ns-a",
          description: "A overlap",
          metadata: {}
        });
        registry.register({
          name: "overlap",
          namespace: "ns-b",
          type: "skill",
          filePath: "/b/overlap/SKILL.md",
          source: "plugin:ns-b",
          description: "B overlap",
          metadata: {}
        });
        const diagnostics = analyzeCollisions(registry, resolver);
        assert.strictEqual(diagnostics.length, 2);
        const canonicalConflict = diagnostics.find((d) => d.class === "canonical-conflict");
        const shorthandOverlap = diagnostics.find((d) => d.class === "shorthand-overlap");
        assert.ok(canonicalConflict, "Should have canonical conflict");
        assert.ok(shorthandOverlap, "Should have shorthand overlap");
        assert.strictEqual(canonicalConflict.severity, "error");
        assert.strictEqual(shorthandOverlap.severity, "warning");
      });
    });
    describe("alias-conflict detection", () => {
      it("should detect alias that shadows an existing canonical name", () => {
        registry.register({
          name: "utility",
          namespace: "core",
          type: "skill",
          filePath: "/core/utility/SKILL.md",
          source: "plugin:core",
          description: "Utility skill",
          metadata: {}
        });
        registry.registerAlias("tools:helper", "core:utility");
        registry.register({
          name: "helper",
          namespace: "tools",
          type: "skill",
          filePath: "/tools/helper/SKILL.md",
          source: "plugin:tools",
          description: "Helper skill",
          metadata: {}
        });
        const diagnostics = analyzeCollisions(registry, resolver);
        const aliasConflict = diagnostics.find((d) => d.class === "alias-conflict");
        assert.ok(aliasConflict, "Should detect alias-conflict");
        assert.strictEqual(aliasConflict.alias, "tools:helper");
        assert.strictEqual(aliasConflict.aliasTarget, "core:utility");
        assert.strictEqual(aliasConflict.aliasConflictType, "shadows-canonical");
        assert.strictEqual(aliasConflict.severity, "warning");
      });
      it("should detect alias that shadows a bare component name", () => {
        registry.register({
          name: "helper",
          namespace: "tools",
          type: "skill",
          filePath: "/tools/helper/SKILL.md",
          source: "plugin:tools",
          description: "Helper skill",
          metadata: {}
        });
        registry.register({
          name: "utility",
          namespace: "core",
          type: "skill",
          filePath: "/core/utility/SKILL.md",
          source: "plugin:core",
          description: "Utility skill",
          metadata: {}
        });
        registry.registerAlias("helper", "core:utility");
        const diagnostics = analyzeCollisions(registry, resolver);
        const aliasConflict = diagnostics.find((d) => d.class === "alias-conflict");
        assert.ok(aliasConflict, "Should detect alias-conflict");
        assert.strictEqual(aliasConflict.alias, "helper");
        assert.strictEqual(aliasConflict.aliasTarget, "core:utility");
        assert.strictEqual(aliasConflict.aliasConflictType, "shadows-bare-name");
        assert.strictEqual(aliasConflict.severity, "warning");
      });
      it("should NOT warn when alias does not conflict", () => {
        registry.register({
          name: "unique-skill",
          namespace: "plugin-a",
          type: "skill",
          filePath: "/a/unique-skill/SKILL.md",
          source: "plugin:plugin-a",
          description: "Unique skill",
          metadata: {}
        });
        registry.register({
          name: "other-skill",
          namespace: "plugin-b",
          type: "skill",
          filePath: "/b/other-skill/SKILL.md",
          source: "plugin:plugin-b",
          description: "Other skill",
          metadata: {}
        });
        registry.registerAlias("short", "plugin-a:unique-skill");
        const diagnostics = analyzeCollisions(registry, resolver);
        const aliasConflict = diagnostics.find((d) => d.class === "alias-conflict");
        assert.strictEqual(aliasConflict, void 0, "Should not have alias-conflict for clean alias");
      });
      it("should include remediation advice for alias shadowing canonical", () => {
        registry.register({
          name: "target",
          namespace: "my-plugin",
          type: "skill",
          filePath: "/my-plugin/target/SKILL.md",
          source: "plugin:my-plugin",
          description: "Target skill",
          metadata: {}
        });
        registry.registerAlias("other:conflicting", "my-plugin:target");
        registry.register({
          name: "conflicting",
          namespace: "other",
          type: "skill",
          filePath: "/other/conflicting/SKILL.md",
          source: "plugin:other",
          description: "Conflicting skill",
          metadata: {}
        });
        const diagnostics = analyzeCollisions(registry, resolver);
        const aliasConflict = diagnostics.find((d) => d.class === "alias-conflict");
        assert.ok(aliasConflict, "Should have alias conflict");
        assert.ok(aliasConflict.remediation.includes("shadows an existing canonical name"));
        assert.ok(aliasConflict.remediation.includes("rename or remove the alias"));
      });
      it("should distinguish alias conflicts from shorthand overlap", () => {
        registry.register({
          name: "common",
          namespace: "plugin-a",
          type: "skill",
          filePath: "/a/common/SKILL.md",
          source: "plugin:plugin-a",
          description: "Common A",
          metadata: {}
        });
        registry.register({
          name: "common",
          namespace: "plugin-b",
          type: "skill",
          filePath: "/b/common/SKILL.md",
          source: "plugin:plugin-b",
          description: "Common B",
          metadata: {}
        });
        registry.register({
          name: "unique",
          namespace: "plugin-c",
          type: "skill",
          filePath: "/c/unique/SKILL.md",
          source: "plugin:plugin-c",
          description: "Unique C",
          metadata: {}
        });
        registry.registerAlias("unique", "plugin-c:unique");
        const diagnostics = analyzeCollisions(registry, resolver);
        const shorthandOverlap = diagnostics.find((d) => d.class === "shorthand-overlap");
        const aliasConflict = diagnostics.find((d) => d.class === "alias-conflict");
        assert.ok(shorthandOverlap, "Should have shorthand overlap");
        assert.ok(aliasConflict, "Should have alias conflict");
        assert.strictEqual(shorthandOverlap.ambiguousBareName, "common");
        assert.strictEqual(aliasConflict.alias, "unique");
      });
    });
  });
  describe("doctorReport", () => {
    it("should format report with correct summary counts", () => {
      registry.register({
        name: "conflict",
        namespace: "ns",
        type: "skill",
        filePath: "/a/conflict/SKILL.md",
        source: "plugin:a",
        description: "A",
        metadata: {}
      });
      registry.register({
        name: "conflict",
        namespace: "ns",
        type: "skill",
        filePath: "/b/conflict/SKILL.md",
        source: "plugin:b",
        description: "B",
        metadata: {}
      });
      registry.register({
        name: "overlap",
        namespace: "x",
        type: "skill",
        filePath: "/x/overlap/SKILL.md",
        source: "plugin:x",
        description: "X",
        metadata: {}
      });
      registry.register({
        name: "overlap",
        namespace: "y",
        type: "skill",
        filePath: "/y/overlap/SKILL.md",
        source: "plugin:y",
        description: "Y",
        metadata: {}
      });
      const diagnostics = analyzeCollisions(registry, resolver);
      const report = doctorReport(diagnostics);
      assert.strictEqual(report.summary.total, 2);
      assert.strictEqual(report.summary.canonicalConflicts, 1);
      assert.strictEqual(report.summary.shorthandOverlaps, 1);
      assert.strictEqual(report.entries.length, 2);
    });
    it("should include error icon for canonical conflicts", () => {
      registry.register({
        name: "dup",
        namespace: "ns",
        type: "skill",
        filePath: "/a/dup/SKILL.md",
        source: "plugin:a",
        description: "A",
        metadata: {}
      });
      registry.register({
        name: "dup",
        namespace: "ns",
        type: "skill",
        filePath: "/b/dup/SKILL.md",
        source: "plugin:b",
        description: "B",
        metadata: {}
      });
      const diagnostics = analyzeCollisions(registry, resolver);
      const report = doctorReport(diagnostics);
      assert.ok(report.entries[0].includes("\u274C"));
    });
    it("should include warning icon for shorthand overlaps", () => {
      registry.register({
        name: "overlap",
        namespace: "a",
        type: "skill",
        filePath: "/a/overlap/SKILL.md",
        source: "plugin:a",
        description: "A",
        metadata: {}
      });
      registry.register({
        name: "overlap",
        namespace: "b",
        type: "skill",
        filePath: "/b/overlap/SKILL.md",
        source: "plugin:b",
        description: "B",
        metadata: {}
      });
      const diagnostics = analyzeCollisions(registry, resolver);
      const report = doctorReport(diagnostics);
      assert.ok(report.entries[0].includes("\u26A0\uFE0F"));
    });
    it("should include file paths in formatted output", () => {
      registry.register({
        name: "overlap",
        namespace: "a",
        type: "skill",
        filePath: "/path/a/overlap/SKILL.md",
        source: "plugin:a",
        description: "A",
        metadata: {}
      });
      registry.register({
        name: "overlap",
        namespace: "b",
        type: "skill",
        filePath: "/path/b/overlap/SKILL.md",
        source: "plugin:b",
        description: "B",
        metadata: {}
      });
      const diagnostics = analyzeCollisions(registry, resolver);
      const report = doctorReport(diagnostics);
      assert.ok(report.entries[0].includes("/path/a/overlap/SKILL.md"));
      assert.ok(report.entries[0].includes("/path/b/overlap/SKILL.md"));
    });
    it("should include canonical name suggestions for ambiguous shorthand", () => {
      registry.register({
        name: "common",
        namespace: "plugin-1",
        type: "skill",
        filePath: "/1/common/SKILL.md",
        source: "plugin:plugin-1",
        description: "Common 1",
        metadata: {}
      });
      registry.register({
        name: "common",
        namespace: "plugin-2",
        type: "skill",
        filePath: "/2/common/SKILL.md",
        source: "plugin:plugin-2",
        description: "Common 2",
        metadata: {}
      });
      const diagnostics = analyzeCollisions(registry, resolver);
      const report = doctorReport(diagnostics);
      assert.ok(report.entries[0].includes("`plugin-1:common`"));
      assert.ok(report.entries[0].includes("`plugin-2:common`"));
    });
    it("should return empty arrays for clean registry", () => {
      const diagnostics = analyzeCollisions(registry, resolver);
      const report = doctorReport(diagnostics);
      assert.strictEqual(report.summary.total, 0);
      assert.strictEqual(report.summary.canonicalConflicts, 0);
      assert.strictEqual(report.summary.shorthandOverlaps, 0);
      assert.strictEqual(report.summary.aliasConflicts, 0);
      assert.deepStrictEqual(report.entries, []);
    });
    it("should include alias conflicts in summary counts", () => {
      registry.register({
        name: "target",
        namespace: "my-plugin",
        type: "skill",
        filePath: "/my-plugin/target/SKILL.md",
        source: "plugin:my-plugin",
        description: "Target skill",
        metadata: {}
      });
      registry.register({
        name: "helper",
        namespace: "other",
        type: "skill",
        filePath: "/other/helper/SKILL.md",
        source: "plugin:other",
        description: "Helper skill",
        metadata: {}
      });
      registry.registerAlias("helper", "my-plugin:target");
      const diagnostics = analyzeCollisions(registry, resolver);
      const report = doctorReport(diagnostics);
      assert.strictEqual(report.summary.aliasConflicts, 1);
      assert.strictEqual(report.summary.total, 1);
    });
    it("should include warning icon for alias conflicts", () => {
      registry.register({
        name: "target",
        namespace: "my-plugin",
        type: "skill",
        filePath: "/my-plugin/target/SKILL.md",
        source: "plugin:my-plugin",
        description: "Target skill",
        metadata: {}
      });
      registry.register({
        name: "shadowed",
        namespace: "other",
        type: "skill",
        filePath: "/other/shadowed/SKILL.md",
        source: "plugin:other",
        description: "Shadowed skill",
        metadata: {}
      });
      registry.registerAlias("shadowed", "my-plugin:target");
      const diagnostics = analyzeCollisions(registry, resolver);
      const report = doctorReport(diagnostics);
      assert.ok(report.entries[0].includes("\u26A0\uFE0F"));
      assert.ok(report.entries[0].includes("ALIAS-CONFLICT"));
    });
    it("should include alias details in formatted output", () => {
      registry.register({
        name: "target",
        namespace: "my-plugin",
        type: "skill",
        filePath: "/my-plugin/target/SKILL.md",
        source: "plugin:my-plugin",
        description: "Target skill",
        metadata: {}
      });
      registry.register({
        name: "shadowed",
        namespace: "other",
        type: "skill",
        filePath: "/other/shadowed/SKILL.md",
        source: "plugin:other",
        description: "Shadowed skill",
        metadata: {}
      });
      registry.registerAlias("shadowed", "my-plugin:target");
      const diagnostics = analyzeCollisions(registry, resolver);
      const report = doctorReport(diagnostics);
      assert.ok(report.entries[0].includes("shadowed"));
      assert.ok(report.entries[0].includes("my-plugin:target"));
    });
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jb2xsaXNpb24tZGlhZ25vc3RpY3MudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBDb2xsaXNpb24gRGlhZ25vc3RpY3MgQ29udHJhY3QgVGVzdHNcbiAqXG4gKiBUZXN0cyB0aGF0IHByb3ZlOlxuICogLSBSMDEwOiBDb2xsaXNpb24gcmVwb3J0aW5nIGRpc3Rpbmd1aXNoZXMgY2Fub25pY2FsLWNvbmZsaWN0IGZyb20gc2hvcnRoYW5kLW92ZXJsYXBcbiAqIC0gUjAxMTogRG9jdG9yIHByb3ZpZGVzIGFjdGlvbmFibGUgYWR2aWNlIHdpdGggY2Fub25pY2FsIG5hbWUgc3VnZ2VzdGlvbnNcbiAqL1xuXG5pbXBvcnQgeyBkZXNjcmliZSwgaXQsIGJlZm9yZUVhY2ggfSBmcm9tICdub2RlOnRlc3QnO1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydCc7XG5pbXBvcnQgeyBOYW1lc3BhY2VkUmVnaXN0cnkgfSBmcm9tICcuLi9uYW1lc3BhY2VkLXJlZ2lzdHJ5LmpzJztcbmltcG9ydCB7IE5hbWVzcGFjZWRSZXNvbHZlciB9IGZyb20gJy4uL25hbWVzcGFjZWQtcmVzb2x2ZXIuanMnO1xuaW1wb3J0IHtcblx0YW5hbHl6ZUNvbGxpc2lvbnMsXG5cdGRvY3RvclJlcG9ydCxcblx0dHlwZSBDbGFzc2lmaWVkRGlhZ25vc3RpYyxcblx0dHlwZSBEb2N0b3JSZXBvcnQsXG59IGZyb20gJy4uL2NvbGxpc2lvbi1kaWFnbm9zdGljcy5qcyc7XG5cbmRlc2NyaWJlKCdjb2xsaXNpb24tZGlhZ25vc3RpY3MnLCAoKSA9PiB7XG5cdGxldCByZWdpc3RyeTogTmFtZXNwYWNlZFJlZ2lzdHJ5O1xuXHRsZXQgcmVzb2x2ZXI6IE5hbWVzcGFjZWRSZXNvbHZlcjtcblxuXHRiZWZvcmVFYWNoKCgpID0+IHtcblx0XHRyZWdpc3RyeSA9IG5ldyBOYW1lc3BhY2VkUmVnaXN0cnkoKTtcblx0XHRyZXNvbHZlciA9IG5ldyBOYW1lc3BhY2VkUmVzb2x2ZXIocmVnaXN0cnkpO1xuXHR9KTtcblxuXHRkZXNjcmliZSgnYW5hbHl6ZUNvbGxpc2lvbnMnLCAoKSA9PiB7XG5cdFx0ZGVzY3JpYmUoJ2Nhbm9uaWNhbC1jb25mbGljdCBkZXRlY3Rpb24nLCAoKSA9PiB7XG5cdFx0XHRpdCgnc2hvdWxkIGRldGVjdCBjYW5vbmljYWwgY29uZmxpY3Qgd2hlbiBzYW1lIGNhbm9uaWNhbCBuYW1lIHJlZ2lzdGVyZWQgdHdpY2UnLCAoKSA9PiB7XG5cdFx0XHRcdC8vIEZpcnN0IHJlZ2lzdHJhdGlvbiB3aW5zXG5cdFx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0XHRuYW1lOiAnY29kZS1yZXZpZXcnLFxuXHRcdFx0XHRcdG5hbWVzcGFjZTogJ215LXBsdWdpbicsXG5cdFx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0XHRmaWxlUGF0aDogJy9wbHVnaW5zL215LXBsdWdpbi9za2lsbHMvY29kZS1yZXZpZXcvU0tJTEwubWQnLFxuXHRcdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjpteS1wbHVnaW4nLFxuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOiAnUmV2aWV3cyBjb2RlJyxcblx0XHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHRcdH0pO1xuXG5cdFx0XHRcdC8vIFNlY29uZCByZWdpc3RyYXRpb24gd2l0aCBzYW1lIGNhbm9uaWNhbCBuYW1lIGxvc2VzXG5cdFx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0XHRuYW1lOiAnY29kZS1yZXZpZXcnLFxuXHRcdFx0XHRcdG5hbWVzcGFjZTogJ215LXBsdWdpbicsXG5cdFx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0XHRmaWxlUGF0aDogJy9wbHVnaW5zL290aGVyL3NraWxscy9jb2RlLXJldmlldy9TS0lMTC5tZCcsXG5cdFx0XHRcdFx0c291cmNlOiAncGx1Z2luOm90aGVyJyxcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjogJ0Fub3RoZXIgY29kZSByZXZpZXcnLFxuXHRcdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdFx0fSk7XG5cblx0XHRcdFx0Y29uc3QgZGlhZ25vc3RpY3MgPSBhbmFseXplQ29sbGlzaW9ucyhyZWdpc3RyeSwgcmVzb2x2ZXIpO1xuXG5cdFx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChkaWFnbm9zdGljcy5sZW5ndGgsIDEpO1xuXHRcdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoZGlhZ25vc3RpY3NbMF0uY2xhc3MsICdjYW5vbmljYWwtY29uZmxpY3QnKTtcblx0XHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKGRpYWdub3N0aWNzWzBdLnNldmVyaXR5LCAnZXJyb3InKTtcblx0XHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKGRpYWdub3N0aWNzWzBdLmludm9sdmVkQ2Fub25pY2FsTmFtZXNbMF0sICdteS1wbHVnaW46Y29kZS1yZXZpZXcnKTtcblx0XHRcdFx0YXNzZXJ0Lm9rKGRpYWdub3N0aWNzWzBdLmZpbGVQYXRocy5pbmNsdWRlcygnL3BsdWdpbnMvbXktcGx1Z2luL3NraWxscy9jb2RlLXJldmlldy9TS0lMTC5tZCcpKTtcblx0XHRcdFx0YXNzZXJ0Lm9rKGRpYWdub3N0aWNzWzBdLmZpbGVQYXRocy5pbmNsdWRlcygnL3BsdWdpbnMvb3RoZXIvc2tpbGxzL2NvZGUtcmV2aWV3L1NLSUxMLm1kJykpO1xuXHRcdFx0fSk7XG5cblx0XHRcdGl0KCdzaG91bGQgaW5jbHVkZSByZW1lZGlhdGlvbiBhZHZpY2UgZm9yIGNhbm9uaWNhbCBjb25mbGljdCcsICgpID0+IHtcblx0XHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRcdG5hbWU6ICd0ZXN0LXNraWxsJyxcblx0XHRcdFx0XHRuYW1lc3BhY2U6ICdwbHVnaW4tYScsXG5cdFx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0XHRmaWxlUGF0aDogJy9hL3Rlc3Qtc2tpbGwvU0tJTEwubWQnLFxuXHRcdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjpwbHVnaW4tYScsXG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246ICdUZXN0Jyxcblx0XHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHRcdH0pO1xuXHRcdFx0XHRyZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRcdFx0bmFtZTogJ3Rlc3Qtc2tpbGwnLFxuXHRcdFx0XHRcdG5hbWVzcGFjZTogJ3BsdWdpbi1hJyxcblx0XHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRcdGZpbGVQYXRoOiAnL2IvdGVzdC1za2lsbC9TS0lMTC5tZCcsXG5cdFx0XHRcdFx0c291cmNlOiAncGx1Z2luOnBsdWdpbi1iJyxcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjogJ1Rlc3QgZHVwbGljYXRlJyxcblx0XHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHRcdH0pO1xuXG5cdFx0XHRcdGNvbnN0IGRpYWdub3N0aWNzID0gYW5hbHl6ZUNvbGxpc2lvbnMocmVnaXN0cnksIHJlc29sdmVyKTtcblxuXHRcdFx0XHRhc3NlcnQub2soZGlhZ25vc3RpY3NbMF0ucmVtZWRpYXRpb24uaW5jbHVkZXMoJ1JlbmFtZSBvbmUgb2YgdGhlIGNvbmZsaWN0aW5nIGNvbXBvbmVudHMnKSk7XG5cdFx0XHR9KTtcblx0XHR9KTtcblxuXHRcdGRlc2NyaWJlKCdzaG9ydGhhbmQtb3ZlcmxhcCBkZXRlY3Rpb24nLCAoKSA9PiB7XG5cdFx0XHRpdCgnc2hvdWxkIGRldGVjdCBzaG9ydGhhbmQgb3ZlcmxhcCB3aGVuIGJhcmUgbmFtZSBtYXRjaGVzIG11bHRpcGxlIG5hbWVzcGFjZXMnLCAoKSA9PiB7XG5cdFx0XHRcdC8vIFNhbWUgYmFyZSBuYW1lIGluIGRpZmZlcmVudCBuYW1lc3BhY2VzXG5cdFx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0XHRuYW1lOiAnY29tbW9uLXNraWxsJyxcblx0XHRcdFx0XHRuYW1lc3BhY2U6ICdwbHVnaW4tYScsXG5cdFx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0XHRmaWxlUGF0aDogJy9hL2NvbW1vbi1za2lsbC9TS0lMTC5tZCcsXG5cdFx0XHRcdFx0c291cmNlOiAncGx1Z2luOnBsdWdpbi1hJyxcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjogJ0EgY29tbW9uIHNraWxsJyxcblx0XHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHRcdH0pO1xuXHRcdFx0XHRyZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRcdFx0bmFtZTogJ2NvbW1vbi1za2lsbCcsXG5cdFx0XHRcdFx0bmFtZXNwYWNlOiAncGx1Z2luLWInLFxuXHRcdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdFx0ZmlsZVBhdGg6ICcvYi9jb21tb24tc2tpbGwvU0tJTEwubWQnLFxuXHRcdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjpwbHVnaW4tYicsXG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246ICdCIGNvbW1vbiBza2lsbCcsXG5cdFx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0XHR9KTtcblxuXHRcdFx0XHRjb25zdCBkaWFnbm9zdGljcyA9IGFuYWx5emVDb2xsaXNpb25zKHJlZ2lzdHJ5LCByZXNvbHZlcik7XG5cblx0XHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKGRpYWdub3N0aWNzLmxlbmd0aCwgMSk7XG5cdFx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChkaWFnbm9zdGljc1swXS5jbGFzcywgJ3Nob3J0aGFuZC1vdmVybGFwJyk7XG5cdFx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChkaWFnbm9zdGljc1swXS5zZXZlcml0eSwgJ3dhcm5pbmcnKTtcblx0XHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKGRpYWdub3N0aWNzWzBdLmFtYmlndW91c0JhcmVOYW1lLCAnY29tbW9uLXNraWxsJyk7XG5cdFx0XHRcdGFzc2VydC5vayhkaWFnbm9zdGljc1swXS5pbnZvbHZlZENhbm9uaWNhbE5hbWVzLmluY2x1ZGVzKCdwbHVnaW4tYTpjb21tb24tc2tpbGwnKSk7XG5cdFx0XHRcdGFzc2VydC5vayhkaWFnbm9zdGljc1swXS5pbnZvbHZlZENhbm9uaWNhbE5hbWVzLmluY2x1ZGVzKCdwbHVnaW4tYjpjb21tb24tc2tpbGwnKSk7XG5cdFx0XHR9KTtcblxuXHRcdFx0aXQoJ3Nob3VsZCBOT1Qgd2FybiB3aGVuIG9ubHkgb25lIGNvbXBvbmVudCBoYXMgYSBnaXZlbiBiYXJlIG5hbWUnLCAoKSA9PiB7XG5cdFx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0XHRuYW1lOiAndW5pcXVlLXNraWxsJyxcblx0XHRcdFx0XHRuYW1lc3BhY2U6ICdwbHVnaW4tYScsXG5cdFx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0XHRmaWxlUGF0aDogJy9hL3VuaXF1ZS1za2lsbC9TS0lMTC5tZCcsXG5cdFx0XHRcdFx0c291cmNlOiAncGx1Z2luOnBsdWdpbi1hJyxcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjogJ1VuaXF1ZScsXG5cdFx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0XHR9KTtcblx0XHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRcdG5hbWU6ICdvdGhlci1za2lsbCcsXG5cdFx0XHRcdFx0bmFtZXNwYWNlOiAncGx1Z2luLWInLFxuXHRcdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdFx0ZmlsZVBhdGg6ICcvYi9vdGhlci1za2lsbC9TS0lMTC5tZCcsXG5cdFx0XHRcdFx0c291cmNlOiAncGx1Z2luOnBsdWdpbi1iJyxcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjogJ090aGVyJyxcblx0XHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHRcdH0pO1xuXG5cdFx0XHRcdGNvbnN0IGRpYWdub3N0aWNzID0gYW5hbHl6ZUNvbGxpc2lvbnMocmVnaXN0cnksIHJlc29sdmVyKTtcblxuXHRcdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoZGlhZ25vc3RpY3MubGVuZ3RoLCAwKTtcblx0XHRcdH0pO1xuXG5cdFx0XHRpdCgnc2hvdWxkIGluY2x1ZGUgY2Fub25pY2FsIG5hbWUgc3VnZ2VzdGlvbnMgaW4gcmVtZWRpYXRpb24gZm9yIHNob3J0aGFuZCBvdmVybGFwJywgKCkgPT4ge1xuXHRcdFx0XHRyZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRcdFx0bmFtZTogJ2FtYmlndW91cycsXG5cdFx0XHRcdFx0bmFtZXNwYWNlOiAnYWxwaGEnLFxuXHRcdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdFx0ZmlsZVBhdGg6ICcvYWxwaGEvYW1iaWd1b3VzL1NLSUxMLm1kJyxcblx0XHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46YWxwaGEnLFxuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOiAnQWxwaGEgYW1iaWd1b3VzJyxcblx0XHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHRcdH0pO1xuXHRcdFx0XHRyZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRcdFx0bmFtZTogJ2FtYmlndW91cycsXG5cdFx0XHRcdFx0bmFtZXNwYWNlOiAnYmV0YScsXG5cdFx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0XHRmaWxlUGF0aDogJy9iZXRhL2FtYmlndW91cy9TS0lMTC5tZCcsXG5cdFx0XHRcdFx0c291cmNlOiAncGx1Z2luOmJldGEnLFxuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOiAnQmV0YSBhbWJpZ3VvdXMnLFxuXHRcdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdFx0fSk7XG5cblx0XHRcdFx0Y29uc3QgZGlhZ25vc3RpY3MgPSBhbmFseXplQ29sbGlzaW9ucyhyZWdpc3RyeSwgcmVzb2x2ZXIpO1xuXG5cdFx0XHRcdGFzc2VydC5vayhkaWFnbm9zdGljc1swXS5yZW1lZGlhdGlvbi5pbmNsdWRlcygnYGFscGhhOmFtYmlndW91c2AnKSk7XG5cdFx0XHRcdGFzc2VydC5vayhkaWFnbm9zdGljc1swXS5yZW1lZGlhdGlvbi5pbmNsdWRlcygnYGJldGE6YW1iaWd1b3VzYCcpKTtcblx0XHRcdFx0YXNzZXJ0Lm9rKGRpYWdub3N0aWNzWzBdLnJlbWVkaWF0aW9uLmluY2x1ZGVzKCdVc2UgYSBjYW5vbmljYWwgbmFtZScpKTtcblx0XHRcdH0pO1xuXHRcdH0pO1xuXG5cdFx0ZGVzY3JpYmUoJ2NsZWFuIHJlZ2lzdHJ5JywgKCkgPT4ge1xuXHRcdFx0aXQoJ3Nob3VsZCByZXR1cm4gbm8gZGlhZ25vc3RpY3MgZm9yIGVtcHR5IHJlZ2lzdHJ5JywgKCkgPT4ge1xuXHRcdFx0XHRjb25zdCBkaWFnbm9zdGljcyA9IGFuYWx5emVDb2xsaXNpb25zKHJlZ2lzdHJ5LCByZXNvbHZlcik7XG5cdFx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChkaWFnbm9zdGljcy5sZW5ndGgsIDApO1xuXHRcdFx0fSk7XG5cblx0XHRcdGl0KCdzaG91bGQgcmV0dXJuIG5vIGRpYWdub3N0aWNzIGZvciByZWdpc3RyeSB3aXRoIHVuaXF1ZSBiYXJlIG5hbWVzJywgKCkgPT4ge1xuXHRcdFx0XHRyZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRcdFx0bmFtZTogJ3NraWxsLWEnLFxuXHRcdFx0XHRcdG5hbWVzcGFjZTogJ3BsdWdpbi14Jyxcblx0XHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRcdGZpbGVQYXRoOiAnL3gvc2tpbGwtYS9TS0lMTC5tZCcsXG5cdFx0XHRcdFx0c291cmNlOiAncGx1Z2luOnBsdWdpbi14Jyxcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjogJ1NraWxsIEEnLFxuXHRcdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdFx0fSk7XG5cdFx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0XHRuYW1lOiAnc2tpbGwtYicsXG5cdFx0XHRcdFx0bmFtZXNwYWNlOiAncGx1Z2luLXknLFxuXHRcdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdFx0ZmlsZVBhdGg6ICcveS9za2lsbC1iL1NLSUxMLm1kJyxcblx0XHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46cGx1Z2luLXknLFxuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOiAnU2tpbGwgQicsXG5cdFx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0XHR9KTtcblxuXHRcdFx0XHRjb25zdCBkaWFnbm9zdGljcyA9IGFuYWx5emVDb2xsaXNpb25zKHJlZ2lzdHJ5LCByZXNvbHZlcik7XG5cdFx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChkaWFnbm9zdGljcy5sZW5ndGgsIDApO1xuXHRcdFx0fSk7XG5cdFx0fSk7XG5cblx0XHRkZXNjcmliZSgnbWl4ZWQgc2NlbmFyaW9zJywgKCkgPT4ge1xuXHRcdFx0aXQoJ3Nob3VsZCByZXBvcnQgYm90aCBjYW5vbmljYWwgY29uZmxpY3QgYW5kIHNob3J0aGFuZCBvdmVybGFwIGluIG1peGVkIHNjZW5hcmlvJywgKCkgPT4ge1xuXHRcdFx0XHQvLyBDYW5vbmljYWwgY29uZmxpY3Q6IHNhbWUgY2Fub25pY2FsIG5hbWUgdHdpY2Vcblx0XHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRcdG5hbWU6ICdkdXBsaWNhdGUnLFxuXHRcdFx0XHRcdG5hbWVzcGFjZTogJ3NoYXJlZCcsXG5cdFx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0XHRmaWxlUGF0aDogJy9maXJzdC9kdXBsaWNhdGUvU0tJTEwubWQnLFxuXHRcdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjpmaXJzdCcsXG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246ICdGaXJzdCBkdXBsaWNhdGUnLFxuXHRcdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdFx0fSk7XG5cdFx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0XHRuYW1lOiAnZHVwbGljYXRlJyxcblx0XHRcdFx0XHRuYW1lc3BhY2U6ICdzaGFyZWQnLFxuXHRcdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdFx0ZmlsZVBhdGg6ICcvc2Vjb25kL2R1cGxpY2F0ZS9TS0lMTC5tZCcsXG5cdFx0XHRcdFx0c291cmNlOiAncGx1Z2luOnNlY29uZCcsXG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246ICdTZWNvbmQgZHVwbGljYXRlJyxcblx0XHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHRcdH0pO1xuXG5cdFx0XHRcdC8vIFNob3J0aGFuZCBvdmVybGFwOiBzYW1lIGJhcmUgbmFtZSBpbiBkaWZmZXJlbnQgbmFtZXNwYWNlc1xuXHRcdFx0XHRyZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRcdFx0bmFtZTogJ292ZXJsYXAnLFxuXHRcdFx0XHRcdG5hbWVzcGFjZTogJ25zLWEnLFxuXHRcdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdFx0ZmlsZVBhdGg6ICcvYS9vdmVybGFwL1NLSUxMLm1kJyxcblx0XHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46bnMtYScsXG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246ICdBIG92ZXJsYXAnLFxuXHRcdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdFx0fSk7XG5cdFx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0XHRuYW1lOiAnb3ZlcmxhcCcsXG5cdFx0XHRcdFx0bmFtZXNwYWNlOiAnbnMtYicsXG5cdFx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0XHRmaWxlUGF0aDogJy9iL292ZXJsYXAvU0tJTEwubWQnLFxuXHRcdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjpucy1iJyxcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjogJ0Igb3ZlcmxhcCcsXG5cdFx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0XHR9KTtcblxuXHRcdFx0XHRjb25zdCBkaWFnbm9zdGljcyA9IGFuYWx5emVDb2xsaXNpb25zKHJlZ2lzdHJ5LCByZXNvbHZlcik7XG5cblx0XHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKGRpYWdub3N0aWNzLmxlbmd0aCwgMik7XG5cblx0XHRcdFx0Y29uc3QgY2Fub25pY2FsQ29uZmxpY3QgPSBkaWFnbm9zdGljcy5maW5kKGQgPT4gZC5jbGFzcyA9PT0gJ2Nhbm9uaWNhbC1jb25mbGljdCcpO1xuXHRcdFx0XHRjb25zdCBzaG9ydGhhbmRPdmVybGFwID0gZGlhZ25vc3RpY3MuZmluZChkID0+IGQuY2xhc3MgPT09ICdzaG9ydGhhbmQtb3ZlcmxhcCcpO1xuXG5cdFx0XHRcdGFzc2VydC5vayhjYW5vbmljYWxDb25mbGljdCwgJ1Nob3VsZCBoYXZlIGNhbm9uaWNhbCBjb25mbGljdCcpO1xuXHRcdFx0XHRhc3NlcnQub2soc2hvcnRoYW5kT3ZlcmxhcCwgJ1Nob3VsZCBoYXZlIHNob3J0aGFuZCBvdmVybGFwJyk7XG5cblx0XHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKGNhbm9uaWNhbENvbmZsaWN0IS5zZXZlcml0eSwgJ2Vycm9yJyk7XG5cdFx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChzaG9ydGhhbmRPdmVybGFwIS5zZXZlcml0eSwgJ3dhcm5pbmcnKTtcblx0XHRcdH0pO1xuXHRcdH0pO1xuXG5cdFx0ZGVzY3JpYmUoJ2FsaWFzLWNvbmZsaWN0IGRldGVjdGlvbicsICgpID0+IHtcblx0XHRcdGl0KCdzaG91bGQgZGV0ZWN0IGFsaWFzIHRoYXQgc2hhZG93cyBhbiBleGlzdGluZyBjYW5vbmljYWwgbmFtZScsICgpID0+IHtcblx0XHRcdFx0Ly8gUmVnaXN0ZXIgY29tcG9uZW50IHRoYXQgd2lsbCBiZSBhbGlhc2VkIHRvXG5cdFx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0XHRuYW1lOiAndXRpbGl0eScsXG5cdFx0XHRcdFx0bmFtZXNwYWNlOiAnY29yZScsXG5cdFx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0XHRmaWxlUGF0aDogJy9jb3JlL3V0aWxpdHkvU0tJTEwubWQnLFxuXHRcdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjpjb3JlJyxcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjogJ1V0aWxpdHkgc2tpbGwnLFxuXHRcdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdFx0fSk7XG5cblx0XHRcdFx0Ly8gUmVnaXN0ZXIgYWxpYXMgZm9yIGEgbm9uLWV4aXN0ZW50IGNhbm9uaWNhbCBuYW1lICh3aWxsIHN1Y2NlZWQpXG5cdFx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyQWxpYXMoJ3Rvb2xzOmhlbHBlcicsICdjb3JlOnV0aWxpdHknKTtcblxuXHRcdFx0XHQvLyBOb3cgcmVnaXN0ZXIgdGhlIGNvbXBvbmVudCB0aGF0IGNyZWF0ZXMgdGhlIGNvbmZsaWN0XG5cdFx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0XHRuYW1lOiAnaGVscGVyJyxcblx0XHRcdFx0XHRuYW1lc3BhY2U6ICd0b29scycsXG5cdFx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0XHRmaWxlUGF0aDogJy90b29scy9oZWxwZXIvU0tJTEwubWQnLFxuXHRcdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjp0b29scycsXG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246ICdIZWxwZXIgc2tpbGwnLFxuXHRcdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdFx0fSk7XG5cblx0XHRcdFx0Y29uc3QgZGlhZ25vc3RpY3MgPSBhbmFseXplQ29sbGlzaW9ucyhyZWdpc3RyeSwgcmVzb2x2ZXIpO1xuXG5cdFx0XHRcdGNvbnN0IGFsaWFzQ29uZmxpY3QgPSBkaWFnbm9zdGljcy5maW5kKGQgPT4gZC5jbGFzcyA9PT0gJ2FsaWFzLWNvbmZsaWN0Jyk7XG5cdFx0XHRcdGFzc2VydC5vayhhbGlhc0NvbmZsaWN0LCAnU2hvdWxkIGRldGVjdCBhbGlhcy1jb25mbGljdCcpO1xuXHRcdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoYWxpYXNDb25mbGljdCEuYWxpYXMsICd0b29sczpoZWxwZXInKTtcblx0XHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKGFsaWFzQ29uZmxpY3QhLmFsaWFzVGFyZ2V0LCAnY29yZTp1dGlsaXR5Jyk7XG5cdFx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChhbGlhc0NvbmZsaWN0IS5hbGlhc0NvbmZsaWN0VHlwZSwgJ3NoYWRvd3MtY2Fub25pY2FsJyk7XG5cdFx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChhbGlhc0NvbmZsaWN0IS5zZXZlcml0eSwgJ3dhcm5pbmcnKTtcblx0XHRcdH0pO1xuXG5cdFx0XHRpdCgnc2hvdWxkIGRldGVjdCBhbGlhcyB0aGF0IHNoYWRvd3MgYSBiYXJlIGNvbXBvbmVudCBuYW1lJywgKCkgPT4ge1xuXHRcdFx0XHQvLyBSZWdpc3RlciBjb21wb25lbnQgd2l0aCBiYXJlIG5hbWUgXCJoZWxwZXJcIlxuXHRcdFx0XHRyZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRcdFx0bmFtZTogJ2hlbHBlcicsXG5cdFx0XHRcdFx0bmFtZXNwYWNlOiAndG9vbHMnLFxuXHRcdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdFx0ZmlsZVBhdGg6ICcvdG9vbHMvaGVscGVyL1NLSUxMLm1kJyxcblx0XHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46dG9vbHMnLFxuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOiAnSGVscGVyIHNraWxsJyxcblx0XHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHRcdH0pO1xuXG5cdFx0XHRcdC8vIFJlZ2lzdGVyIGFub3RoZXIgY29tcG9uZW50IHRvIGFsaWFzIHRvXG5cdFx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0XHRuYW1lOiAndXRpbGl0eScsXG5cdFx0XHRcdFx0bmFtZXNwYWNlOiAnY29yZScsXG5cdFx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0XHRmaWxlUGF0aDogJy9jb3JlL3V0aWxpdHkvU0tJTEwubWQnLFxuXHRcdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjpjb3JlJyxcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjogJ1V0aWxpdHkgc2tpbGwnLFxuXHRcdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdFx0fSk7XG5cblx0XHRcdFx0Ly8gQ3JlYXRlIGFsaWFzIFwiaGVscGVyXCIgdGhhdCBzaGFkb3dzIHRoZSBiYXJlIG5hbWVcblx0XHRcdFx0cmVnaXN0cnkucmVnaXN0ZXJBbGlhcygnaGVscGVyJywgJ2NvcmU6dXRpbGl0eScpO1xuXG5cdFx0XHRcdGNvbnN0IGRpYWdub3N0aWNzID0gYW5hbHl6ZUNvbGxpc2lvbnMocmVnaXN0cnksIHJlc29sdmVyKTtcblxuXHRcdFx0XHRjb25zdCBhbGlhc0NvbmZsaWN0ID0gZGlhZ25vc3RpY3MuZmluZChkID0+IGQuY2xhc3MgPT09ICdhbGlhcy1jb25mbGljdCcpO1xuXHRcdFx0XHRhc3NlcnQub2soYWxpYXNDb25mbGljdCwgJ1Nob3VsZCBkZXRlY3QgYWxpYXMtY29uZmxpY3QnKTtcblx0XHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKGFsaWFzQ29uZmxpY3QhLmFsaWFzLCAnaGVscGVyJyk7XG5cdFx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChhbGlhc0NvbmZsaWN0IS5hbGlhc1RhcmdldCwgJ2NvcmU6dXRpbGl0eScpO1xuXHRcdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoYWxpYXNDb25mbGljdCEuYWxpYXNDb25mbGljdFR5cGUsICdzaGFkb3dzLWJhcmUtbmFtZScpO1xuXHRcdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoYWxpYXNDb25mbGljdCEuc2V2ZXJpdHksICd3YXJuaW5nJyk7XG5cdFx0XHR9KTtcblxuXHRcdFx0aXQoJ3Nob3VsZCBOT1Qgd2FybiB3aGVuIGFsaWFzIGRvZXMgbm90IGNvbmZsaWN0JywgKCkgPT4ge1xuXHRcdFx0XHRyZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRcdFx0bmFtZTogJ3VuaXF1ZS1za2lsbCcsXG5cdFx0XHRcdFx0bmFtZXNwYWNlOiAncGx1Z2luLWEnLFxuXHRcdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdFx0ZmlsZVBhdGg6ICcvYS91bmlxdWUtc2tpbGwvU0tJTEwubWQnLFxuXHRcdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjpwbHVnaW4tYScsXG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246ICdVbmlxdWUgc2tpbGwnLFxuXHRcdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdFx0fSk7XG5cblx0XHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRcdG5hbWU6ICdvdGhlci1za2lsbCcsXG5cdFx0XHRcdFx0bmFtZXNwYWNlOiAncGx1Z2luLWInLFxuXHRcdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdFx0ZmlsZVBhdGg6ICcvYi9vdGhlci1za2lsbC9TS0lMTC5tZCcsXG5cdFx0XHRcdFx0c291cmNlOiAncGx1Z2luOnBsdWdpbi1iJyxcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjogJ090aGVyIHNraWxsJyxcblx0XHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHRcdH0pO1xuXG5cdFx0XHRcdC8vIENyZWF0ZSBhIG5vbi1jb25mbGljdGluZyBhbGlhc1xuXHRcdFx0XHRyZWdpc3RyeS5yZWdpc3RlckFsaWFzKCdzaG9ydCcsICdwbHVnaW4tYTp1bmlxdWUtc2tpbGwnKTtcblxuXHRcdFx0XHRjb25zdCBkaWFnbm9zdGljcyA9IGFuYWx5emVDb2xsaXNpb25zKHJlZ2lzdHJ5LCByZXNvbHZlcik7XG5cblx0XHRcdFx0Y29uc3QgYWxpYXNDb25mbGljdCA9IGRpYWdub3N0aWNzLmZpbmQoZCA9PiBkLmNsYXNzID09PSAnYWxpYXMtY29uZmxpY3QnKTtcblx0XHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKGFsaWFzQ29uZmxpY3QsIHVuZGVmaW5lZCwgJ1Nob3VsZCBub3QgaGF2ZSBhbGlhcy1jb25mbGljdCBmb3IgY2xlYW4gYWxpYXMnKTtcblx0XHRcdH0pO1xuXG5cdFx0XHRpdCgnc2hvdWxkIGluY2x1ZGUgcmVtZWRpYXRpb24gYWR2aWNlIGZvciBhbGlhcyBzaGFkb3dpbmcgY2Fub25pY2FsJywgKCkgPT4ge1xuXHRcdFx0XHQvLyBSZWdpc3RlciB0aGUgdGFyZ2V0IGNvbXBvbmVudCBmaXJzdFxuXHRcdFx0XHRyZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRcdFx0bmFtZTogJ3RhcmdldCcsXG5cdFx0XHRcdFx0bmFtZXNwYWNlOiAnbXktcGx1Z2luJyxcblx0XHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRcdGZpbGVQYXRoOiAnL215LXBsdWdpbi90YXJnZXQvU0tJTEwubWQnLFxuXHRcdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjpteS1wbHVnaW4nLFxuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOiAnVGFyZ2V0IHNraWxsJyxcblx0XHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHRcdH0pO1xuXG5cdFx0XHRcdC8vIFJlZ2lzdGVyIGFsaWFzIGZvciBhIG5vbi1leGlzdGVudCBjYW5vbmljYWwgbmFtZSAod2lsbCBzdWNjZWVkIGJlY2F1c2UgaXQgZG9lc24ndCBleGlzdCB5ZXQpXG5cdFx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyQWxpYXMoJ290aGVyOmNvbmZsaWN0aW5nJywgJ215LXBsdWdpbjp0YXJnZXQnKTtcblxuXHRcdFx0XHQvLyBOb3cgcmVnaXN0ZXIgdGhlIGNvbXBvbmVudCB0aGF0IHRoZSBhbGlhcyB3b3VsZCBzaGFkb3dcblx0XHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRcdG5hbWU6ICdjb25mbGljdGluZycsXG5cdFx0XHRcdFx0bmFtZXNwYWNlOiAnb3RoZXInLFxuXHRcdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdFx0ZmlsZVBhdGg6ICcvb3RoZXIvY29uZmxpY3RpbmcvU0tJTEwubWQnLFxuXHRcdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjpvdGhlcicsXG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246ICdDb25mbGljdGluZyBza2lsbCcsXG5cdFx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0XHR9KTtcblxuXHRcdFx0XHRjb25zdCBkaWFnbm9zdGljcyA9IGFuYWx5emVDb2xsaXNpb25zKHJlZ2lzdHJ5LCByZXNvbHZlcik7XG5cblx0XHRcdFx0Y29uc3QgYWxpYXNDb25mbGljdCA9IGRpYWdub3N0aWNzLmZpbmQoZCA9PiBkLmNsYXNzID09PSAnYWxpYXMtY29uZmxpY3QnKTtcblx0XHRcdFx0YXNzZXJ0Lm9rKGFsaWFzQ29uZmxpY3QsICdTaG91bGQgaGF2ZSBhbGlhcyBjb25mbGljdCcpO1xuXHRcdFx0XHRhc3NlcnQub2soYWxpYXNDb25mbGljdCEucmVtZWRpYXRpb24uaW5jbHVkZXMoJ3NoYWRvd3MgYW4gZXhpc3RpbmcgY2Fub25pY2FsIG5hbWUnKSk7XG5cdFx0XHRcdGFzc2VydC5vayhhbGlhc0NvbmZsaWN0IS5yZW1lZGlhdGlvbi5pbmNsdWRlcygncmVuYW1lIG9yIHJlbW92ZSB0aGUgYWxpYXMnKSk7XG5cdFx0XHR9KTtcblxuXHRcdFx0aXQoJ3Nob3VsZCBkaXN0aW5ndWlzaCBhbGlhcyBjb25mbGljdHMgZnJvbSBzaG9ydGhhbmQgb3ZlcmxhcCcsICgpID0+IHtcblx0XHRcdFx0Ly8gU2hvcnRoYW5kIG92ZXJsYXAgc2NlbmFyaW9cblx0XHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRcdG5hbWU6ICdjb21tb24nLFxuXHRcdFx0XHRcdG5hbWVzcGFjZTogJ3BsdWdpbi1hJyxcblx0XHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRcdGZpbGVQYXRoOiAnL2EvY29tbW9uL1NLSUxMLm1kJyxcblx0XHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46cGx1Z2luLWEnLFxuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOiAnQ29tbW9uIEEnLFxuXHRcdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdFx0fSk7XG5cdFx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0XHRuYW1lOiAnY29tbW9uJyxcblx0XHRcdFx0XHRuYW1lc3BhY2U6ICdwbHVnaW4tYicsXG5cdFx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0XHRmaWxlUGF0aDogJy9iL2NvbW1vbi9TS0lMTC5tZCcsXG5cdFx0XHRcdFx0c291cmNlOiAncGx1Z2luOnBsdWdpbi1iJyxcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjogJ0NvbW1vbiBCJyxcblx0XHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHRcdH0pO1xuXG5cdFx0XHRcdC8vIEFsaWFzIGNvbmZsaWN0IHNjZW5hcmlvIChzZXBhcmF0ZSBmcm9tIHNob3J0aGFuZClcblx0XHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRcdG5hbWU6ICd1bmlxdWUnLFxuXHRcdFx0XHRcdG5hbWVzcGFjZTogJ3BsdWdpbi1jJyxcblx0XHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRcdGZpbGVQYXRoOiAnL2MvdW5pcXVlL1NLSUxMLm1kJyxcblx0XHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46cGx1Z2luLWMnLFxuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOiAnVW5pcXVlIEMnLFxuXHRcdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdFx0fSk7XG5cdFx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyQWxpYXMoJ3VuaXF1ZScsICdwbHVnaW4tYzp1bmlxdWUnKTtcblxuXHRcdFx0XHRjb25zdCBkaWFnbm9zdGljcyA9IGFuYWx5emVDb2xsaXNpb25zKHJlZ2lzdHJ5LCByZXNvbHZlcik7XG5cblx0XHRcdFx0Y29uc3Qgc2hvcnRoYW5kT3ZlcmxhcCA9IGRpYWdub3N0aWNzLmZpbmQoZCA9PiBkLmNsYXNzID09PSAnc2hvcnRoYW5kLW92ZXJsYXAnKTtcblx0XHRcdFx0Y29uc3QgYWxpYXNDb25mbGljdCA9IGRpYWdub3N0aWNzLmZpbmQoZCA9PiBkLmNsYXNzID09PSAnYWxpYXMtY29uZmxpY3QnKTtcblxuXHRcdFx0XHRhc3NlcnQub2soc2hvcnRoYW5kT3ZlcmxhcCwgJ1Nob3VsZCBoYXZlIHNob3J0aGFuZCBvdmVybGFwJyk7XG5cdFx0XHRcdGFzc2VydC5vayhhbGlhc0NvbmZsaWN0LCAnU2hvdWxkIGhhdmUgYWxpYXMgY29uZmxpY3QnKTtcblx0XHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHNob3J0aGFuZE92ZXJsYXAhLmFtYmlndW91c0JhcmVOYW1lLCAnY29tbW9uJyk7XG5cdFx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChhbGlhc0NvbmZsaWN0IS5hbGlhcywgJ3VuaXF1ZScpO1xuXHRcdFx0fSk7XG5cdFx0fSk7XG5cdH0pO1xuXG5cdGRlc2NyaWJlKCdkb2N0b3JSZXBvcnQnLCAoKSA9PiB7XG5cdFx0aXQoJ3Nob3VsZCBmb3JtYXQgcmVwb3J0IHdpdGggY29ycmVjdCBzdW1tYXJ5IGNvdW50cycsICgpID0+IHtcblx0XHRcdC8vIENyZWF0ZSBzY2VuYXJpbyB3aXRoIDEgZXJyb3IgYW5kIDIgd2FybmluZ3Ncblx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0bmFtZTogJ2NvbmZsaWN0Jyxcblx0XHRcdFx0bmFtZXNwYWNlOiAnbnMnLFxuXHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRmaWxlUGF0aDogJy9hL2NvbmZsaWN0L1NLSUxMLm1kJyxcblx0XHRcdFx0c291cmNlOiAncGx1Z2luOmEnLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogJ0EnLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0bmFtZTogJ2NvbmZsaWN0Jyxcblx0XHRcdFx0bmFtZXNwYWNlOiAnbnMnLFxuXHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRmaWxlUGF0aDogJy9iL2NvbmZsaWN0L1NLSUxMLm1kJyxcblx0XHRcdFx0c291cmNlOiAncGx1Z2luOmInLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogJ0InLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0bmFtZTogJ292ZXJsYXAnLFxuXHRcdFx0XHRuYW1lc3BhY2U6ICd4Jyxcblx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0ZmlsZVBhdGg6ICcveC9vdmVybGFwL1NLSUxMLm1kJyxcblx0XHRcdFx0c291cmNlOiAncGx1Z2luOngnLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogJ1gnLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0bmFtZTogJ292ZXJsYXAnLFxuXHRcdFx0XHRuYW1lc3BhY2U6ICd5Jyxcblx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0ZmlsZVBhdGg6ICcveS9vdmVybGFwL1NLSUxMLm1kJyxcblx0XHRcdFx0c291cmNlOiAncGx1Z2luOnknLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogJ1knLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblxuXHRcdFx0Y29uc3QgZGlhZ25vc3RpY3MgPSBhbmFseXplQ29sbGlzaW9ucyhyZWdpc3RyeSwgcmVzb2x2ZXIpO1xuXHRcdFx0Y29uc3QgcmVwb3J0ID0gZG9jdG9yUmVwb3J0KGRpYWdub3N0aWNzKTtcblxuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlcG9ydC5zdW1tYXJ5LnRvdGFsLCAyKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXBvcnQuc3VtbWFyeS5jYW5vbmljYWxDb25mbGljdHMsIDEpO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlcG9ydC5zdW1tYXJ5LnNob3J0aGFuZE92ZXJsYXBzLCAxKTtcblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXBvcnQuZW50cmllcy5sZW5ndGgsIDIpO1xuXHRcdH0pO1xuXG5cdFx0aXQoJ3Nob3VsZCBpbmNsdWRlIGVycm9yIGljb24gZm9yIGNhbm9uaWNhbCBjb25mbGljdHMnLCAoKSA9PiB7XG5cdFx0XHRyZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRcdG5hbWU6ICdkdXAnLFxuXHRcdFx0XHRuYW1lc3BhY2U6ICducycsXG5cdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdGZpbGVQYXRoOiAnL2EvZHVwL1NLSUxMLm1kJyxcblx0XHRcdFx0c291cmNlOiAncGx1Z2luOmEnLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogJ0EnLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0bmFtZTogJ2R1cCcsXG5cdFx0XHRcdG5hbWVzcGFjZTogJ25zJyxcblx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0ZmlsZVBhdGg6ICcvYi9kdXAvU0tJTEwubWQnLFxuXHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46YicsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiAnQicsXG5cdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdH0pO1xuXG5cdFx0XHRjb25zdCBkaWFnbm9zdGljcyA9IGFuYWx5emVDb2xsaXNpb25zKHJlZ2lzdHJ5LCByZXNvbHZlcik7XG5cdFx0XHRjb25zdCByZXBvcnQgPSBkb2N0b3JSZXBvcnQoZGlhZ25vc3RpY3MpO1xuXG5cdFx0XHRhc3NlcnQub2socmVwb3J0LmVudHJpZXNbMF0uaW5jbHVkZXMoJ1x1Mjc0QycpKTtcblx0XHR9KTtcblxuXHRcdGl0KCdzaG91bGQgaW5jbHVkZSB3YXJuaW5nIGljb24gZm9yIHNob3J0aGFuZCBvdmVybGFwcycsICgpID0+IHtcblx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0bmFtZTogJ292ZXJsYXAnLFxuXHRcdFx0XHRuYW1lc3BhY2U6ICdhJyxcblx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0ZmlsZVBhdGg6ICcvYS9vdmVybGFwL1NLSUxMLm1kJyxcblx0XHRcdFx0c291cmNlOiAncGx1Z2luOmEnLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogJ0EnLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0bmFtZTogJ292ZXJsYXAnLFxuXHRcdFx0XHRuYW1lc3BhY2U6ICdiJyxcblx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0ZmlsZVBhdGg6ICcvYi9vdmVybGFwL1NLSUxMLm1kJyxcblx0XHRcdFx0c291cmNlOiAncGx1Z2luOmInLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogJ0InLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblxuXHRcdFx0Y29uc3QgZGlhZ25vc3RpY3MgPSBhbmFseXplQ29sbGlzaW9ucyhyZWdpc3RyeSwgcmVzb2x2ZXIpO1xuXHRcdFx0Y29uc3QgcmVwb3J0ID0gZG9jdG9yUmVwb3J0KGRpYWdub3N0aWNzKTtcblxuXHRcdFx0YXNzZXJ0Lm9rKHJlcG9ydC5lbnRyaWVzWzBdLmluY2x1ZGVzKCdcdTI2QTBcdUZFMEYnKSk7XG5cdFx0fSk7XG5cblx0XHRpdCgnc2hvdWxkIGluY2x1ZGUgZmlsZSBwYXRocyBpbiBmb3JtYXR0ZWQgb3V0cHV0JywgKCkgPT4ge1xuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRuYW1lOiAnb3ZlcmxhcCcsXG5cdFx0XHRcdG5hbWVzcGFjZTogJ2EnLFxuXHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRmaWxlUGF0aDogJy9wYXRoL2Evb3ZlcmxhcC9TS0lMTC5tZCcsXG5cdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjphJyxcblx0XHRcdFx0ZGVzY3JpcHRpb246ICdBJyxcblx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0fSk7XG5cdFx0XHRyZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRcdG5hbWU6ICdvdmVybGFwJyxcblx0XHRcdFx0bmFtZXNwYWNlOiAnYicsXG5cdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdGZpbGVQYXRoOiAnL3BhdGgvYi9vdmVybGFwL1NLSUxMLm1kJyxcblx0XHRcdFx0c291cmNlOiAncGx1Z2luOmInLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogJ0InLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblxuXHRcdFx0Y29uc3QgZGlhZ25vc3RpY3MgPSBhbmFseXplQ29sbGlzaW9ucyhyZWdpc3RyeSwgcmVzb2x2ZXIpO1xuXHRcdFx0Y29uc3QgcmVwb3J0ID0gZG9jdG9yUmVwb3J0KGRpYWdub3N0aWNzKTtcblxuXHRcdFx0YXNzZXJ0Lm9rKHJlcG9ydC5lbnRyaWVzWzBdLmluY2x1ZGVzKCcvcGF0aC9hL292ZXJsYXAvU0tJTEwubWQnKSk7XG5cdFx0XHRhc3NlcnQub2socmVwb3J0LmVudHJpZXNbMF0uaW5jbHVkZXMoJy9wYXRoL2Ivb3ZlcmxhcC9TS0lMTC5tZCcpKTtcblx0XHR9KTtcblxuXHRcdGl0KCdzaG91bGQgaW5jbHVkZSBjYW5vbmljYWwgbmFtZSBzdWdnZXN0aW9ucyBmb3IgYW1iaWd1b3VzIHNob3J0aGFuZCcsICgpID0+IHtcblx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0bmFtZTogJ2NvbW1vbicsXG5cdFx0XHRcdG5hbWVzcGFjZTogJ3BsdWdpbi0xJyxcblx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0ZmlsZVBhdGg6ICcvMS9jb21tb24vU0tJTEwubWQnLFxuXHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46cGx1Z2luLTEnLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogJ0NvbW1vbiAxJyxcblx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0fSk7XG5cdFx0XHRyZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRcdG5hbWU6ICdjb21tb24nLFxuXHRcdFx0XHRuYW1lc3BhY2U6ICdwbHVnaW4tMicsXG5cdFx0XHRcdHR5cGU6ICdza2lsbCcsXG5cdFx0XHRcdGZpbGVQYXRoOiAnLzIvY29tbW9uL1NLSUxMLm1kJyxcblx0XHRcdFx0c291cmNlOiAncGx1Z2luOnBsdWdpbi0yJyxcblx0XHRcdFx0ZGVzY3JpcHRpb246ICdDb21tb24gMicsXG5cdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdH0pO1xuXG5cdFx0XHRjb25zdCBkaWFnbm9zdGljcyA9IGFuYWx5emVDb2xsaXNpb25zKHJlZ2lzdHJ5LCByZXNvbHZlcik7XG5cdFx0XHRjb25zdCByZXBvcnQgPSBkb2N0b3JSZXBvcnQoZGlhZ25vc3RpY3MpO1xuXG5cdFx0XHRhc3NlcnQub2socmVwb3J0LmVudHJpZXNbMF0uaW5jbHVkZXMoJ2BwbHVnaW4tMTpjb21tb25gJykpO1xuXHRcdFx0YXNzZXJ0Lm9rKHJlcG9ydC5lbnRyaWVzWzBdLmluY2x1ZGVzKCdgcGx1Z2luLTI6Y29tbW9uYCcpKTtcblx0XHR9KTtcblxuXHRcdGl0KCdzaG91bGQgcmV0dXJuIGVtcHR5IGFycmF5cyBmb3IgY2xlYW4gcmVnaXN0cnknLCAoKSA9PiB7XG5cdFx0XHRjb25zdCBkaWFnbm9zdGljcyA9IGFuYWx5emVDb2xsaXNpb25zKHJlZ2lzdHJ5LCByZXNvbHZlcik7XG5cdFx0XHRjb25zdCByZXBvcnQgPSBkb2N0b3JSZXBvcnQoZGlhZ25vc3RpY3MpO1xuXG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVwb3J0LnN1bW1hcnkudG90YWwsIDApO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlcG9ydC5zdW1tYXJ5LmNhbm9uaWNhbENvbmZsaWN0cywgMCk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVwb3J0LnN1bW1hcnkuc2hvcnRoYW5kT3ZlcmxhcHMsIDApO1xuXHRcdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlcG9ydC5zdW1tYXJ5LmFsaWFzQ29uZmxpY3RzLCAwKTtcblx0XHRcdGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVwb3J0LmVudHJpZXMsIFtdKTtcblx0XHR9KTtcblxuXHRcdGl0KCdzaG91bGQgaW5jbHVkZSBhbGlhcyBjb25mbGljdHMgaW4gc3VtbWFyeSBjb3VudHMnLCAoKSA9PiB7XG5cdFx0XHRyZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRcdG5hbWU6ICd0YXJnZXQnLFxuXHRcdFx0XHRuYW1lc3BhY2U6ICdteS1wbHVnaW4nLFxuXHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRmaWxlUGF0aDogJy9teS1wbHVnaW4vdGFyZ2V0L1NLSUxMLm1kJyxcblx0XHRcdFx0c291cmNlOiAncGx1Z2luOm15LXBsdWdpbicsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiAnVGFyZ2V0IHNraWxsJyxcblx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0fSk7XG5cblx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0bmFtZTogJ2hlbHBlcicsXG5cdFx0XHRcdG5hbWVzcGFjZTogJ290aGVyJyxcblx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0ZmlsZVBhdGg6ICcvb3RoZXIvaGVscGVyL1NLSUxMLm1kJyxcblx0XHRcdFx0c291cmNlOiAncGx1Z2luOm90aGVyJyxcblx0XHRcdFx0ZGVzY3JpcHRpb246ICdIZWxwZXIgc2tpbGwnLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblxuXHRcdFx0Ly8gQ3JlYXRlIGFsaWFzIHRoYXQgc2hhZG93cyBiYXJlIG5hbWVcblx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyQWxpYXMoJ2hlbHBlcicsICdteS1wbHVnaW46dGFyZ2V0Jyk7XG5cblx0XHRcdGNvbnN0IGRpYWdub3N0aWNzID0gYW5hbHl6ZUNvbGxpc2lvbnMocmVnaXN0cnksIHJlc29sdmVyKTtcblx0XHRcdGNvbnN0IHJlcG9ydCA9IGRvY3RvclJlcG9ydChkaWFnbm9zdGljcyk7XG5cblx0XHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXBvcnQuc3VtbWFyeS5hbGlhc0NvbmZsaWN0cywgMSk7XG5cdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVwb3J0LnN1bW1hcnkudG90YWwsIDEpO1xuXHRcdH0pO1xuXG5cdFx0aXQoJ3Nob3VsZCBpbmNsdWRlIHdhcm5pbmcgaWNvbiBmb3IgYWxpYXMgY29uZmxpY3RzJywgKCkgPT4ge1xuXHRcdFx0cmVnaXN0cnkucmVnaXN0ZXIoe1xuXHRcdFx0XHRuYW1lOiAndGFyZ2V0Jyxcblx0XHRcdFx0bmFtZXNwYWNlOiAnbXktcGx1Z2luJyxcblx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0ZmlsZVBhdGg6ICcvbXktcGx1Z2luL3RhcmdldC9TS0lMTC5tZCcsXG5cdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjpteS1wbHVnaW4nLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogJ1RhcmdldCBza2lsbCcsXG5cdFx0XHRcdG1ldGFkYXRhOiB7fSxcblx0XHRcdH0pO1xuXG5cdFx0XHRyZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRcdG5hbWU6ICdzaGFkb3dlZCcsXG5cdFx0XHRcdG5hbWVzcGFjZTogJ290aGVyJyxcblx0XHRcdFx0dHlwZTogJ3NraWxsJyxcblx0XHRcdFx0ZmlsZVBhdGg6ICcvb3RoZXIvc2hhZG93ZWQvU0tJTEwubWQnLFxuXHRcdFx0XHRzb3VyY2U6ICdwbHVnaW46b3RoZXInLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogJ1NoYWRvd2VkIHNraWxsJyxcblx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0fSk7XG5cblx0XHRcdC8vIENyZWF0ZSBhbGlhcyB0aGF0IHNoYWRvd3MgYmFyZSBuYW1lXG5cdFx0XHRyZWdpc3RyeS5yZWdpc3RlckFsaWFzKCdzaGFkb3dlZCcsICdteS1wbHVnaW46dGFyZ2V0Jyk7XG5cblx0XHRcdGNvbnN0IGRpYWdub3N0aWNzID0gYW5hbHl6ZUNvbGxpc2lvbnMocmVnaXN0cnksIHJlc29sdmVyKTtcblx0XHRcdGNvbnN0IHJlcG9ydCA9IGRvY3RvclJlcG9ydChkaWFnbm9zdGljcyk7XG5cblx0XHRcdGFzc2VydC5vayhyZXBvcnQuZW50cmllc1swXS5pbmNsdWRlcygnXHUyNkEwXHVGRTBGJykpO1xuXHRcdFx0YXNzZXJ0Lm9rKHJlcG9ydC5lbnRyaWVzWzBdLmluY2x1ZGVzKCdBTElBUy1DT05GTElDVCcpKTtcblx0XHR9KTtcblxuXHRcdGl0KCdzaG91bGQgaW5jbHVkZSBhbGlhcyBkZXRhaWxzIGluIGZvcm1hdHRlZCBvdXRwdXQnLCAoKSA9PiB7XG5cdFx0XHRyZWdpc3RyeS5yZWdpc3Rlcih7XG5cdFx0XHRcdG5hbWU6ICd0YXJnZXQnLFxuXHRcdFx0XHRuYW1lc3BhY2U6ICdteS1wbHVnaW4nLFxuXHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRmaWxlUGF0aDogJy9teS1wbHVnaW4vdGFyZ2V0L1NLSUxMLm1kJyxcblx0XHRcdFx0c291cmNlOiAncGx1Z2luOm15LXBsdWdpbicsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiAnVGFyZ2V0IHNraWxsJyxcblx0XHRcdFx0bWV0YWRhdGE6IHt9LFxuXHRcdFx0fSk7XG5cblx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyKHtcblx0XHRcdFx0bmFtZTogJ3NoYWRvd2VkJyxcblx0XHRcdFx0bmFtZXNwYWNlOiAnb3RoZXInLFxuXHRcdFx0XHR0eXBlOiAnc2tpbGwnLFxuXHRcdFx0XHRmaWxlUGF0aDogJy9vdGhlci9zaGFkb3dlZC9TS0lMTC5tZCcsXG5cdFx0XHRcdHNvdXJjZTogJ3BsdWdpbjpvdGhlcicsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiAnU2hhZG93ZWQgc2tpbGwnLFxuXHRcdFx0XHRtZXRhZGF0YToge30sXG5cdFx0XHR9KTtcblxuXHRcdFx0Ly8gQ3JlYXRlIGFsaWFzIHRoYXQgc2hhZG93cyBiYXJlIG5hbWVcblx0XHRcdHJlZ2lzdHJ5LnJlZ2lzdGVyQWxpYXMoJ3NoYWRvd2VkJywgJ215LXBsdWdpbjp0YXJnZXQnKTtcblxuXHRcdFx0Y29uc3QgZGlhZ25vc3RpY3MgPSBhbmFseXplQ29sbGlzaW9ucyhyZWdpc3RyeSwgcmVzb2x2ZXIpO1xuXHRcdFx0Y29uc3QgcmVwb3J0ID0gZG9jdG9yUmVwb3J0KGRpYWdub3N0aWNzKTtcblxuXHRcdFx0YXNzZXJ0Lm9rKHJlcG9ydC5lbnRyaWVzWzBdLmluY2x1ZGVzKCdzaGFkb3dlZCcpKTtcblx0XHRcdGFzc2VydC5vayhyZXBvcnQuZW50cmllc1swXS5pbmNsdWRlcygnbXktcGx1Z2luOnRhcmdldCcpKTtcblx0XHR9KTtcblx0fSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQVFBLFNBQVMsVUFBVSxJQUFJLGtCQUFrQjtBQUN6QyxPQUFPLFlBQVk7QUFDbkIsU0FBUywwQkFBMEI7QUFDbkMsU0FBUywwQkFBMEI7QUFDbkM7QUFBQSxFQUND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
