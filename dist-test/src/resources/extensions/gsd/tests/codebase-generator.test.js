import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import {
  parseCodebaseMap,
  parseCodebaseMapMetadata,
  generateCodebaseMap,
  updateCodebaseMap,
  writeCodebaseMap,
  readCodebaseMap,
  getCodebaseMapStats,
  ensureCodebaseMapFresh
} from "../codebase-generator.js";
function makeTmpRepo() {
  const base = join(tmpdir(), `gsd-codebase-test-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  execSync("git init", { cwd: base, stdio: "ignore" });
  return base;
}
function addFile(base, path, content = "") {
  const fullPath = join(base, path);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content || `// ${path}
`, "utf-8");
  execSync(`git add "${path}"`, { cwd: base, stdio: "ignore" });
}
function cleanup(base) {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
  }
}
test("parseCodebaseMap: parses file with description", () => {
  const content = `# Codebase Map

### src/
- \`main.ts\` \u2014 Application entry point
- \`utils.ts\` \u2014 Shared utilities
`;
  const map = parseCodebaseMap(content);
  assert.equal(map.size, 2);
  assert.equal(map.get("main.ts"), "Application entry point");
  assert.equal(map.get("utils.ts"), "Shared utilities");
});
test("parseCodebaseMap: parses file without description", () => {
  const content = `- \`config.ts\`
- \`index.ts\` \u2014 Entry
`;
  const map = parseCodebaseMap(content);
  assert.equal(map.size, 2);
  assert.equal(map.get("config.ts"), "");
  assert.equal(map.get("index.ts"), "Entry");
});
test("parseCodebaseMap: empty content returns empty map", () => {
  const map = parseCodebaseMap("");
  assert.equal(map.size, 0);
});
test("parseCodebaseMap: ignores non-matching lines", () => {
  const content = `# Codebase Map

Generated: 2026-03-23

### src/
- \`file.ts\` \u2014 desc
`;
  const map = parseCodebaseMap(content);
  assert.equal(map.size, 1);
});
test("parseCodebaseMap: recovers descriptions from collapsed-description comments", () => {
  const content = `# Codebase Map

### src/components/
- *(25 files: 25 .ts)*
<!-- gsd:collapsed-descriptions
- \`src/components/Foo.ts\` \u2014 The Foo component
- \`src/components/Bar.ts\` \u2014 The Bar component
-->
`;
  const map = parseCodebaseMap(content);
  assert.equal(map.get("src/components/Foo.ts"), "The Foo component");
  assert.equal(map.get("src/components/Bar.ts"), "The Bar component");
  assert.ok(!map.has("*(25 files: 25 .ts)*"));
});
test("parseCodebaseMap: handles corrupted/malformed input gracefully", () => {
  const content = [
    "- `unclosed backtick",
    "- `` \u2014 empty filename",
    "- `valid.ts` \u2014 ok",
    "random garbage line",
    "- `a.ts` \u2014 desc with other text"
  ].join("\n");
  const map = parseCodebaseMap(content);
  assert.ok(map.has("valid.ts"));
  assert.ok(map.has("a.ts"));
  assert.equal(map.size, 2);
});
test("generateCodebaseMap: generates from git ls-files", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    addFile(base, "src/utils.ts");
    addFile(base, "README.md");
    const result = generateCodebaseMap(base);
    assert.ok(result.content.includes("# Codebase Map"));
    assert.ok(result.content.includes("`src/main.ts`"));
    assert.ok(result.content.includes("`src/utils.ts`"));
    assert.ok(result.content.includes("README.md"));
    assert.equal(result.fileCount, 3);
    assert.equal(result.truncated, false);
    assert.equal(result.files.length, 3);
  } finally {
    cleanup(base);
  }
});
test("generateCodebaseMap: excludes .gsd/ files", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    addFile(base, ".gsd/PROJECT.md");
    const result = generateCodebaseMap(base);
    assert.ok(result.content.includes("`src/main.ts`"));
    assert.ok(!result.content.includes("PROJECT.md"));
  } finally {
    cleanup(base);
  }
});
test("generateCodebaseMap: excludes .claude/ and other tool directories", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    addFile(base, ".claude/CLAUDE.md");
    addFile(base, ".claude/memory/user.md");
    addFile(base, ".plans/plan.md");
    addFile(base, ".cursor/settings.json");
    addFile(base, ".vscode/settings.json");
    const result = generateCodebaseMap(base);
    assert.ok(result.content.includes("`src/main.ts`"), "should include src/main.ts");
    assert.ok(!result.content.includes("CLAUDE.md"), "should exclude .claude/ files");
    assert.ok(!result.content.includes("user.md"), "should exclude .claude/memory/ files");
    assert.ok(!result.content.includes(".plans"), "should exclude .plans/ files");
    assert.ok(!result.content.includes(".cursor"), "should exclude .cursor/ files");
    assert.ok(!result.content.includes(".vscode"), "should exclude .vscode/ files");
  } finally {
    cleanup(base);
  }
});
test("generateCodebaseMap: excludes .agents/ and other tooling directories", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    addFile(base, ".agents/skills/pdf/SKILL.md");
    addFile(base, ".agents/skills/find-skills/SKILL.md");
    addFile(base, ".bg-shell/session.json");
    addFile(base, ".idea/workspace.xml");
    addFile(base, ".cache/data.bin");
    addFile(base, "tmp/scratch.ts");
    addFile(base, "target/debug/build.rs");
    addFile(base, "venv/lib/site.py");
    const result = generateCodebaseMap(base);
    assert.ok(result.content.includes("`src/main.ts`"), "should include src/main.ts");
    assert.ok(!result.content.includes("SKILL.md"), "should exclude .agents/ files");
    assert.ok(!result.content.includes(".bg-shell"), "should exclude .bg-shell/ files");
    assert.ok(!result.content.includes(".idea"), "should exclude .idea/ files");
    assert.ok(!result.content.includes(".cache"), "should exclude .cache/ files");
    assert.ok(!result.content.includes("tmp/"), "should exclude tmp/ files");
    assert.ok(!result.content.includes("target"), "should exclude target/ files");
    assert.ok(!result.content.includes("venv"), "should exclude venv/ files");
    assert.equal(result.fileCount, 1);
  } finally {
    cleanup(base);
  }
});
test("generateCodebaseMap: excludes binary and lock files", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    addFile(base, "package-lock.json");
    addFile(base, "yarn.lock");
    addFile(base, "assets/logo.png");
    const result = generateCodebaseMap(base);
    assert.ok(result.content.includes("`src/main.ts`"));
    assert.ok(result.content.includes("package-lock.json"));
    assert.ok(!result.content.includes("yarn.lock"));
    assert.ok(!result.content.includes("logo.png"));
  } finally {
    cleanup(base);
  }
});
test("generateCodebaseMap: respects custom excludePatterns", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    addFile(base, "docs/guide.md");
    addFile(base, "docs/api.md");
    const result = generateCodebaseMap(base, { excludePatterns: ["docs/"] });
    assert.ok(result.content.includes("`src/main.ts`"));
    assert.ok(!result.content.includes("guide.md"));
    assert.ok(!result.content.includes("api.md"));
    assert.equal(result.fileCount, 1);
  } finally {
    cleanup(base);
  }
});
test("generateCodebaseMap: preserves existing descriptions", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    addFile(base, "src/utils.ts");
    const descriptions = /* @__PURE__ */ new Map();
    descriptions.set("src/main.ts", "App entry point");
    const result = generateCodebaseMap(base, void 0, descriptions);
    assert.ok(result.content.includes("`src/main.ts` \u2014 App entry point"));
    assert.ok(result.content.includes("`src/utils.ts`"));
  } finally {
    cleanup(base);
  }
});
test("generateCodebaseMap: writes freshness metadata comment", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    const result = generateCodebaseMap(base);
    const metadata = parseCodebaseMapMetadata(result.content);
    assert.ok(metadata, "metadata comment should be present");
    assert.equal(metadata?.fileCount, 1);
    assert.equal(metadata?.truncated, false);
    assert.equal(typeof metadata?.fingerprint, "string");
    assert.ok(metadata?.generatedAt?.endsWith("Z"));
  } finally {
    cleanup(base);
  }
});
test("generateCodebaseMap: collapses large directories", () => {
  const base = makeTmpRepo();
  try {
    for (let i = 0; i < 25; i++) {
      addFile(base, `src/components/comp${String(i).padStart(2, "0")}.ts`);
    }
    const result = generateCodebaseMap(base);
    assert.ok(result.content.includes("*(25 files: 25 .ts)*"));
    assert.ok(!result.content.includes("`src/components/comp00.ts`\n"));
  } finally {
    cleanup(base);
  }
});
test("generateCodebaseMap: respects custom collapseThreshold", () => {
  const base = makeTmpRepo();
  try {
    for (let i = 0; i < 5; i++) addFile(base, `src/comp${i}.ts`);
    const collapsed = generateCodebaseMap(base, { collapseThreshold: 3 });
    assert.ok(collapsed.content.includes("5 files"));
    const expanded = generateCodebaseMap(base, { collapseThreshold: 10 });
    assert.ok(expanded.content.includes("`src/comp0.ts`"));
  } finally {
    cleanup(base);
  }
});
test("generateCodebaseMap: truncated=false when file count is below maxFiles", () => {
  const base = makeTmpRepo();
  try {
    for (let i = 0; i < 4; i++) addFile(base, `file${i}.ts`);
    const result = generateCodebaseMap(base, { maxFiles: 5 });
    assert.equal(result.fileCount, 4);
    assert.equal(result.truncated, false);
  } finally {
    cleanup(base);
  }
});
test("generateCodebaseMap: truncated=false when file count equals maxFiles exactly", () => {
  const base = makeTmpRepo();
  try {
    for (let i = 0; i < 5; i++) addFile(base, `file${i}.ts`);
    const result = generateCodebaseMap(base, { maxFiles: 5 });
    assert.equal(result.fileCount, 5);
    assert.equal(result.truncated, false);
  } finally {
    cleanup(base);
  }
});
test("generateCodebaseMap: truncated=true when file count exceeds maxFiles", () => {
  const base = makeTmpRepo();
  try {
    for (let i = 0; i < 10; i++) addFile(base, `file${i}.ts`);
    const result = generateCodebaseMap(base, { maxFiles: 5 });
    assert.equal(result.fileCount, 5);
    assert.equal(result.truncated, true);
    assert.ok(result.content.includes("Truncated"));
  } finally {
    cleanup(base);
  }
});
test("generateCodebaseMap: returns empty map for non-git directory", () => {
  const base = join(tmpdir(), `gsd-codebase-test-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  try {
    const result = generateCodebaseMap(base);
    assert.equal(result.fileCount, 0);
    assert.equal(result.truncated, false);
    assert.ok(result.content.includes("# Codebase Map"));
    assert.equal(result.files.length, 0);
  } finally {
    cleanup(base);
  }
});
test("generateCodebaseMap: handles empty repository (no committed files)", () => {
  const base = makeTmpRepo();
  try {
    const result = generateCodebaseMap(base);
    assert.equal(result.fileCount, 0);
    assert.equal(result.truncated, false);
    assert.ok(result.content.includes("Files: 0"));
  } finally {
    cleanup(base);
  }
});
test("generateCodebaseMap: collapsed directories preserve descriptions in hidden comment", () => {
  const base = makeTmpRepo();
  try {
    for (let i = 0; i < 25; i++) {
      addFile(base, `src/components/comp${String(i).padStart(2, "0")}.ts`);
    }
    const descriptions = /* @__PURE__ */ new Map([["src/components/comp00.ts", "The first component"]]);
    const result = generateCodebaseMap(base, void 0, descriptions);
    assert.ok(result.content.includes("<!-- gsd:collapsed-descriptions"));
    assert.ok(result.content.includes("`src/components/comp00.ts` \u2014 The first component"));
    const recovered = parseCodebaseMap(result.content);
    assert.equal(recovered.get("src/components/comp00.ts"), "The first component");
  } finally {
    cleanup(base);
  }
});
test("updateCodebaseMap: preserves descriptions on update", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    addFile(base, "src/utils.ts");
    const initial = generateCodebaseMap(base, void 0, /* @__PURE__ */ new Map([["src/main.ts", "Entry point"]]));
    writeCodebaseMap(base, initial.content);
    addFile(base, "src/new.ts");
    const result = updateCodebaseMap(base);
    assert.ok(result.content.includes("`src/main.ts` \u2014 Entry point"));
    assert.equal(result.added, 1);
    assert.equal(result.fileCount, 3);
  } finally {
    cleanup(base);
  }
});
test("updateCodebaseMap: tracks removed files", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/keep.ts");
    addFile(base, "src/remove.ts");
    execSync("git -c user.email=t@t.com -c user.name=T commit -m init", { cwd: base, stdio: "ignore" });
    const initial = generateCodebaseMap(base);
    writeCodebaseMap(base, initial.content);
    execSync("git rm src/remove.ts", { cwd: base, stdio: "ignore" });
    const result = updateCodebaseMap(base);
    assert.equal(result.removed, 1);
    assert.equal(result.unchanged, 1);
    assert.equal(result.fileCount, 1);
    assert.ok(!result.content.includes("remove.ts"));
  } finally {
    cleanup(base);
  }
});
test("updateCodebaseMap: propagates truncated flag", () => {
  const base = makeTmpRepo();
  try {
    for (let i = 0; i < 10; i++) addFile(base, `file${i}.ts`);
    const initial = generateCodebaseMap(base, { maxFiles: 5 });
    writeCodebaseMap(base, initial.content);
    const result = updateCodebaseMap(base, { maxFiles: 5 });
    assert.equal(result.truncated, true);
  } finally {
    cleanup(base);
  }
});
test("updateCodebaseMap: preserves descriptions from collapsed directories", () => {
  const base = makeTmpRepo();
  try {
    for (let i = 0; i < 25; i++) {
      addFile(base, `src/components/comp${String(i).padStart(2, "0")}.ts`);
    }
    const descriptions = /* @__PURE__ */ new Map([["src/components/comp00.ts", "The first component"]]);
    const initial = generateCodebaseMap(base, void 0, descriptions);
    writeCodebaseMap(base, initial.content);
    const result = updateCodebaseMap(base);
    const recovered = parseCodebaseMap(result.content);
    assert.equal(recovered.get("src/components/comp00.ts"), "The first component");
  } finally {
    cleanup(base);
  }
});
test("writeCodebaseMap + readCodebaseMap roundtrip", () => {
  const base = makeTmpRepo();
  try {
    const content = "# Codebase Map\n\n- `test.ts` \u2014 A test file\n";
    const outPath = writeCodebaseMap(base, content);
    assert.ok(existsSync(outPath));
    const read = readCodebaseMap(base);
    assert.equal(read, content);
  } finally {
    cleanup(base);
  }
});
test("readCodebaseMap: returns null when file missing", () => {
  const base = makeTmpRepo();
  try {
    const result = readCodebaseMap(base);
    assert.equal(result, null);
  } finally {
    cleanup(base);
  }
});
test("writeCodebaseMap: creates .gsd/ directory if missing", () => {
  const base = join(tmpdir(), `gsd-codebase-test-${randomUUID()}`);
  mkdirSync(base, { recursive: true });
  try {
    const outPath = writeCodebaseMap(base, "# Codebase Map\n");
    assert.ok(existsSync(outPath));
  } finally {
    cleanup(base);
  }
});
test("getCodebaseMapStats: no map returns exists=false", () => {
  const base = makeTmpRepo();
  try {
    const stats = getCodebaseMapStats(base);
    assert.equal(stats.exists, false);
    assert.equal(stats.fileCount, 0);
  } finally {
    cleanup(base);
  }
});
test("getCodebaseMapStats: reports coverage", () => {
  const base = makeTmpRepo();
  try {
    const content = `# Codebase Map

Generated: 2026-03-23T14:00:00Z | Files: 3 | Described: 2/3

- \`a.ts\` \u2014 Has desc
- \`b.ts\`
- \`c.ts\` \u2014 Also has
`;
    writeCodebaseMap(base, content);
    const stats = getCodebaseMapStats(base);
    assert.equal(stats.exists, true);
    assert.equal(stats.fileCount, 3);
    assert.equal(stats.describedCount, 2);
    assert.equal(stats.undescribedCount, 1);
    assert.equal(stats.generatedAt, "2026-03-23T14:00:00Z");
  } finally {
    cleanup(base);
  }
});
test("getCodebaseMapStats: reads total file count from header for accuracy with collapsed dirs", () => {
  const base = makeTmpRepo();
  try {
    const content = [
      "# Codebase Map",
      "",
      "Generated: 2026-03-23T14:00:00Z | Files: 30 | Described: 2/30",
      "",
      "### src/components/",
      "- *(28 files: 28 .ts)*",
      "",
      "### src/",
      "- `main.ts` \u2014 Entry point",
      "- `utils.ts` \u2014 Utilities"
    ].join("\n");
    writeCodebaseMap(base, content);
    const stats = getCodebaseMapStats(base);
    assert.equal(stats.fileCount, 30);
    assert.equal(stats.describedCount, 2);
    assert.equal(stats.undescribedCount, 28);
  } finally {
    cleanup(base);
  }
});
test("generateCodebaseMap: custom excludePatterns filters additional directories", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    addFile(base, "src/utils.ts");
    addFile(base, ".cache-data/data/index.lance");
    addFile(base, "docs/guide.md");
    const result = generateCodebaseMap(base, {
      excludePatterns: [".cache-data/", "docs/"]
    });
    assert.ok(result.content.includes("`src/main.ts`"));
    assert.ok(result.content.includes("`src/utils.ts`"));
    assert.ok(!result.content.includes(".cache-data"));
    assert.ok(!result.content.includes("guide.md"));
    assert.equal(result.fileCount, 2);
  } finally {
    cleanup(base);
  }
});
test("generateCodebaseMap: collapseThreshold option overrides default", () => {
  const base = makeTmpRepo();
  try {
    for (let i = 0; i < 10; i++) {
      addFile(base, `src/comp${i}.ts`);
    }
    const expanded = generateCodebaseMap(base);
    assert.ok(expanded.content.includes("`src/comp0.ts`"));
    const collapsed = generateCodebaseMap(base, { collapseThreshold: 5 });
    assert.ok(collapsed.content.includes("10 files"));
    assert.ok(!collapsed.content.includes("`src/comp0.ts`\n"));
  } finally {
    cleanup(base);
  }
});
test("updateCodebaseMap: respects excludePatterns option", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    addFile(base, "vendor-extra/lib.js");
    const initial = generateCodebaseMap(base);
    writeCodebaseMap(base, initial.content);
    const result = updateCodebaseMap(base, { excludePatterns: ["vendor-extra/"] });
    assert.ok(result.content.includes("`src/main.ts`"));
    assert.ok(!result.content.includes("vendor-extra"));
  } finally {
    cleanup(base);
  }
});
test("ensureCodebaseMapFresh: generates CODEBASE.md when missing", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    const result = ensureCodebaseMapFresh(base, void 0, { ttlMs: 0, force: true });
    const written = readCodebaseMap(base);
    assert.equal(result.status, "generated");
    assert.ok(written?.includes("`src/main.ts`"));
  } finally {
    cleanup(base);
  }
});
test("ensureCodebaseMapFresh: updates CODEBASE.md when tracked files change", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    const initial = ensureCodebaseMapFresh(base, void 0, { ttlMs: 0, force: true });
    assert.equal(initial.status, "generated");
    addFile(base, "src/new.ts");
    const refreshed = ensureCodebaseMapFresh(base, void 0, { ttlMs: 0, force: true });
    const written = readCodebaseMap(base);
    assert.equal(refreshed.status, "updated");
    assert.equal(refreshed.reason, "files-changed");
    assert.ok(written?.includes("`src/new.ts`"));
  } finally {
    cleanup(base);
  }
});
test("ensureCodebaseMapFresh: returns fresh when metadata matches repository state", () => {
  const base = makeTmpRepo();
  try {
    addFile(base, "src/main.ts");
    ensureCodebaseMapFresh(base, void 0, { ttlMs: 0, force: true });
    const refreshed = ensureCodebaseMapFresh(base, void 0, { ttlMs: 0, force: true });
    assert.equal(refreshed.status, "fresh");
    assert.equal(refreshed.fileCount, 1);
  } finally {
    cleanup(base);
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jb2RlYmFzZS1nZW5lcmF0b3IudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2RpclN5bmMsIHdyaXRlRmlsZVN5bmMsIHJlYWRGaWxlU3luYywgZXhpc3RzU3luYywgcm1TeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gXCJub2RlOmNyeXB0b1wiO1xuaW1wb3J0IHsgZXhlY1N5bmMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5cbmltcG9ydCB7XG4gIHBhcnNlQ29kZWJhc2VNYXAsXG4gIHBhcnNlQ29kZWJhc2VNYXBNZXRhZGF0YSxcbiAgZ2VuZXJhdGVDb2RlYmFzZU1hcCxcbiAgdXBkYXRlQ29kZWJhc2VNYXAsXG4gIHdyaXRlQ29kZWJhc2VNYXAsXG4gIHJlYWRDb2RlYmFzZU1hcCxcbiAgZ2V0Q29kZWJhc2VNYXBTdGF0cyxcbiAgZW5zdXJlQ29kZWJhc2VNYXBGcmVzaCxcbn0gZnJvbSBcIi4uL2NvZGViYXNlLWdlbmVyYXRvci50c1wiO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgSGVscGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gbWFrZVRtcFJlcG8oKTogc3RyaW5nIHtcbiAgY29uc3QgYmFzZSA9IGpvaW4odG1wZGlyKCksIGBnc2QtY29kZWJhc2UtdGVzdC0ke3JhbmRvbVVVSUQoKX1gKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgZXhlY1N5bmMoXCJnaXQgaW5pdFwiLCB7IGN3ZDogYmFzZSwgc3RkaW86IFwiaWdub3JlXCIgfSk7XG4gIHJldHVybiBiYXNlO1xufVxuXG5mdW5jdGlvbiBhZGRGaWxlKGJhc2U6IHN0cmluZywgcGF0aDogc3RyaW5nLCBjb250ZW50ID0gXCJcIik6IHZvaWQge1xuICBjb25zdCBmdWxsUGF0aCA9IGpvaW4oYmFzZSwgcGF0aCk7XG4gIG1rZGlyU3luYyhqb2luKGZ1bGxQYXRoLCBcIi4uXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhmdWxsUGF0aCwgY29udGVudCB8fCBgLy8gJHtwYXRofVxcbmAsIFwidXRmLThcIik7XG4gIGV4ZWNTeW5jKGBnaXQgYWRkIFwiJHtwYXRofVwiYCwgeyBjd2Q6IGJhc2UsIHN0ZGlvOiBcImlnbm9yZVwiIH0pO1xufVxuXG5mdW5jdGlvbiBjbGVhbnVwKGJhc2U6IHN0cmluZyk6IHZvaWQge1xuICB0cnkgeyBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pOyB9IGNhdGNoIHsgLyogKi8gfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgcGFyc2VDb2RlYmFzZU1hcCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcInBhcnNlQ29kZWJhc2VNYXA6IHBhcnNlcyBmaWxlIHdpdGggZGVzY3JpcHRpb25cIiwgKCkgPT4ge1xuICBjb25zdCBjb250ZW50ID0gYCMgQ29kZWJhc2UgTWFwXG5cbiMjIyBzcmMvXG4tIFxcYG1haW4udHNcXGAgXHUyMDE0IEFwcGxpY2F0aW9uIGVudHJ5IHBvaW50XG4tIFxcYHV0aWxzLnRzXFxgIFx1MjAxNCBTaGFyZWQgdXRpbGl0aWVzXG5gO1xuXG4gIGNvbnN0IG1hcCA9IHBhcnNlQ29kZWJhc2VNYXAoY29udGVudCk7XG4gIGFzc2VydC5lcXVhbChtYXAuc2l6ZSwgMik7XG4gIGFzc2VydC5lcXVhbChtYXAuZ2V0KFwibWFpbi50c1wiKSwgXCJBcHBsaWNhdGlvbiBlbnRyeSBwb2ludFwiKTtcbiAgYXNzZXJ0LmVxdWFsKG1hcC5nZXQoXCJ1dGlscy50c1wiKSwgXCJTaGFyZWQgdXRpbGl0aWVzXCIpO1xufSk7XG5cbnRlc3QoXCJwYXJzZUNvZGViYXNlTWFwOiBwYXJzZXMgZmlsZSB3aXRob3V0IGRlc2NyaXB0aW9uXCIsICgpID0+IHtcbiAgY29uc3QgY29udGVudCA9IGAtIFxcYGNvbmZpZy50c1xcYFxcbi0gXFxgaW5kZXgudHNcXGAgXHUyMDE0IEVudHJ5XFxuYDtcbiAgY29uc3QgbWFwID0gcGFyc2VDb2RlYmFzZU1hcChjb250ZW50KTtcbiAgYXNzZXJ0LmVxdWFsKG1hcC5zaXplLCAyKTtcbiAgYXNzZXJ0LmVxdWFsKG1hcC5nZXQoXCJjb25maWcudHNcIiksIFwiXCIpO1xuICBhc3NlcnQuZXF1YWwobWFwLmdldChcImluZGV4LnRzXCIpLCBcIkVudHJ5XCIpO1xufSk7XG5cbnRlc3QoXCJwYXJzZUNvZGViYXNlTWFwOiBlbXB0eSBjb250ZW50IHJldHVybnMgZW1wdHkgbWFwXCIsICgpID0+IHtcbiAgY29uc3QgbWFwID0gcGFyc2VDb2RlYmFzZU1hcChcIlwiKTtcbiAgYXNzZXJ0LmVxdWFsKG1hcC5zaXplLCAwKTtcbn0pO1xuXG50ZXN0KFwicGFyc2VDb2RlYmFzZU1hcDogaWdub3JlcyBub24tbWF0Y2hpbmcgbGluZXNcIiwgKCkgPT4ge1xuICBjb25zdCBjb250ZW50ID0gYCMgQ29kZWJhc2UgTWFwXFxuXFxuR2VuZXJhdGVkOiAyMDI2LTAzLTIzXFxuXFxuIyMjIHNyYy9cXG4tIFxcYGZpbGUudHNcXGAgXHUyMDE0IGRlc2NcXG5gO1xuICBjb25zdCBtYXAgPSBwYXJzZUNvZGViYXNlTWFwKGNvbnRlbnQpO1xuICBhc3NlcnQuZXF1YWwobWFwLnNpemUsIDEpO1xufSk7XG5cbnRlc3QoXCJwYXJzZUNvZGViYXNlTWFwOiByZWNvdmVycyBkZXNjcmlwdGlvbnMgZnJvbSBjb2xsYXBzZWQtZGVzY3JpcHRpb24gY29tbWVudHNcIiwgKCkgPT4ge1xuICBjb25zdCBjb250ZW50ID0gYCMgQ29kZWJhc2UgTWFwXG5cbiMjIyBzcmMvY29tcG9uZW50cy9cbi0gKigyNSBmaWxlczogMjUgLnRzKSpcbjwhLS0gZ3NkOmNvbGxhcHNlZC1kZXNjcmlwdGlvbnNcbi0gXFxgc3JjL2NvbXBvbmVudHMvRm9vLnRzXFxgIFx1MjAxNCBUaGUgRm9vIGNvbXBvbmVudFxuLSBcXGBzcmMvY29tcG9uZW50cy9CYXIudHNcXGAgXHUyMDE0IFRoZSBCYXIgY29tcG9uZW50XG4tLT5cbmA7XG4gIGNvbnN0IG1hcCA9IHBhcnNlQ29kZWJhc2VNYXAoY29udGVudCk7XG4gIGFzc2VydC5lcXVhbChtYXAuZ2V0KFwic3JjL2NvbXBvbmVudHMvRm9vLnRzXCIpLCBcIlRoZSBGb28gY29tcG9uZW50XCIpO1xuICBhc3NlcnQuZXF1YWwobWFwLmdldChcInNyYy9jb21wb25lbnRzL0Jhci50c1wiKSwgXCJUaGUgQmFyIGNvbXBvbmVudFwiKTtcbiAgLy8gVGhlIGNvbGxhcHNlZCBzdW1tYXJ5IGxpbmUgaXRzZWxmIHNob3VsZCBub3QgYmUgcGFyc2VkIGFzIGEgZmlsZVxuICBhc3NlcnQub2soIW1hcC5oYXMoXCIqKDI1IGZpbGVzOiAyNSAudHMpKlwiKSk7XG59KTtcblxudGVzdChcInBhcnNlQ29kZWJhc2VNYXA6IGhhbmRsZXMgY29ycnVwdGVkL21hbGZvcm1lZCBpbnB1dCBncmFjZWZ1bGx5XCIsICgpID0+IHtcbiAgY29uc3QgY29udGVudCA9IFtcbiAgICBcIi0gYHVuY2xvc2VkIGJhY2t0aWNrXCIsXG4gICAgXCItIGBgIFx1MjAxNCBlbXB0eSBmaWxlbmFtZVwiLFxuICAgIFwiLSBgdmFsaWQudHNgIFx1MjAxNCBva1wiLFxuICAgIFwicmFuZG9tIGdhcmJhZ2UgbGluZVwiLFxuICAgIFwiLSBgYS50c2AgXHUyMDE0IGRlc2Mgd2l0aCBvdGhlciB0ZXh0XCIsXG4gIF0uam9pbihcIlxcblwiKTtcbiAgY29uc3QgbWFwID0gcGFyc2VDb2RlYmFzZU1hcChjb250ZW50KTtcbiAgYXNzZXJ0Lm9rKG1hcC5oYXMoXCJ2YWxpZC50c1wiKSk7XG4gIGFzc2VydC5vayhtYXAuaGFzKFwiYS50c1wiKSk7XG4gIC8vIE1hbGZvcm1lZCBsaW5lcyBzaG91bGQgYmUgc2lsZW50bHkgc2tpcHBlZFxuICBhc3NlcnQuZXF1YWwobWFwLnNpemUsIDIpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBnZW5lcmF0ZUNvZGViYXNlTWFwIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiZ2VuZXJhdGVDb2RlYmFzZU1hcDogZ2VuZXJhdGVzIGZyb20gZ2l0IGxzLWZpbGVzXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBSZXBvKCk7XG4gIHRyeSB7XG4gICAgYWRkRmlsZShiYXNlLCBcInNyYy9tYWluLnRzXCIpO1xuICAgIGFkZEZpbGUoYmFzZSwgXCJzcmMvdXRpbHMudHNcIik7XG4gICAgYWRkRmlsZShiYXNlLCBcIlJFQURNRS5tZFwiKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGdlbmVyYXRlQ29kZWJhc2VNYXAoYmFzZSk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5jb250ZW50LmluY2x1ZGVzKFwiIyBDb2RlYmFzZSBNYXBcIikpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuY29udGVudC5pbmNsdWRlcyhcImBzcmMvbWFpbi50c2BcIikpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuY29udGVudC5pbmNsdWRlcyhcImBzcmMvdXRpbHMudHNgXCIpKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmNvbnRlbnQuaW5jbHVkZXMoXCJSRUFETUUubWRcIikpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuZmlsZUNvdW50LCAzKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnRydW5jYXRlZCwgZmFsc2UpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuZmlsZXMubGVuZ3RoLCAzKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcImdlbmVyYXRlQ29kZWJhc2VNYXA6IGV4Y2x1ZGVzIC5nc2QvIGZpbGVzXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBSZXBvKCk7XG4gIHRyeSB7XG4gICAgYWRkRmlsZShiYXNlLCBcInNyYy9tYWluLnRzXCIpO1xuICAgIGFkZEZpbGUoYmFzZSwgXCIuZ3NkL1BST0pFQ1QubWRcIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSBnZW5lcmF0ZUNvZGViYXNlTWFwKGJhc2UpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuY29udGVudC5pbmNsdWRlcyhcImBzcmMvbWFpbi50c2BcIikpO1xuICAgIGFzc2VydC5vayghcmVzdWx0LmNvbnRlbnQuaW5jbHVkZXMoXCJQUk9KRUNULm1kXCIpKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcImdlbmVyYXRlQ29kZWJhc2VNYXA6IGV4Y2x1ZGVzIC5jbGF1ZGUvIGFuZCBvdGhlciB0b29sIGRpcmVjdG9yaWVzXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBSZXBvKCk7XG4gIHRyeSB7XG4gICAgYWRkRmlsZShiYXNlLCBcInNyYy9tYWluLnRzXCIpO1xuICAgIGFkZEZpbGUoYmFzZSwgXCIuY2xhdWRlL0NMQVVERS5tZFwiKTtcbiAgICBhZGRGaWxlKGJhc2UsIFwiLmNsYXVkZS9tZW1vcnkvdXNlci5tZFwiKTtcbiAgICBhZGRGaWxlKGJhc2UsIFwiLnBsYW5zL3BsYW4ubWRcIik7XG4gICAgYWRkRmlsZShiYXNlLCBcIi5jdXJzb3Ivc2V0dGluZ3MuanNvblwiKTtcbiAgICBhZGRGaWxlKGJhc2UsIFwiLnZzY29kZS9zZXR0aW5ncy5qc29uXCIpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gZ2VuZXJhdGVDb2RlYmFzZU1hcChiYXNlKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmNvbnRlbnQuaW5jbHVkZXMoXCJgc3JjL21haW4udHNgXCIpLCBcInNob3VsZCBpbmNsdWRlIHNyYy9tYWluLnRzXCIpO1xuICAgIGFzc2VydC5vayghcmVzdWx0LmNvbnRlbnQuaW5jbHVkZXMoXCJDTEFVREUubWRcIiksIFwic2hvdWxkIGV4Y2x1ZGUgLmNsYXVkZS8gZmlsZXNcIik7XG4gICAgYXNzZXJ0Lm9rKCFyZXN1bHQuY29udGVudC5pbmNsdWRlcyhcInVzZXIubWRcIiksIFwic2hvdWxkIGV4Y2x1ZGUgLmNsYXVkZS9tZW1vcnkvIGZpbGVzXCIpO1xuICAgIGFzc2VydC5vayghcmVzdWx0LmNvbnRlbnQuaW5jbHVkZXMoXCIucGxhbnNcIiksIFwic2hvdWxkIGV4Y2x1ZGUgLnBsYW5zLyBmaWxlc1wiKTtcbiAgICBhc3NlcnQub2soIXJlc3VsdC5jb250ZW50LmluY2x1ZGVzKFwiLmN1cnNvclwiKSwgXCJzaG91bGQgZXhjbHVkZSAuY3Vyc29yLyBmaWxlc1wiKTtcbiAgICBhc3NlcnQub2soIXJlc3VsdC5jb250ZW50LmluY2x1ZGVzKFwiLnZzY29kZVwiKSwgXCJzaG91bGQgZXhjbHVkZSAudnNjb2RlLyBmaWxlc1wiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcImdlbmVyYXRlQ29kZWJhc2VNYXA6IGV4Y2x1ZGVzIC5hZ2VudHMvIGFuZCBvdGhlciB0b29saW5nIGRpcmVjdG9yaWVzXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBSZXBvKCk7XG4gIHRyeSB7XG4gICAgYWRkRmlsZShiYXNlLCBcInNyYy9tYWluLnRzXCIpO1xuICAgIGFkZEZpbGUoYmFzZSwgXCIuYWdlbnRzL3NraWxscy9wZGYvU0tJTEwubWRcIik7XG4gICAgYWRkRmlsZShiYXNlLCBcIi5hZ2VudHMvc2tpbGxzL2ZpbmQtc2tpbGxzL1NLSUxMLm1kXCIpO1xuICAgIGFkZEZpbGUoYmFzZSwgXCIuYmctc2hlbGwvc2Vzc2lvbi5qc29uXCIpO1xuICAgIGFkZEZpbGUoYmFzZSwgXCIuaWRlYS93b3Jrc3BhY2UueG1sXCIpO1xuICAgIGFkZEZpbGUoYmFzZSwgXCIuY2FjaGUvZGF0YS5iaW5cIik7XG4gICAgYWRkRmlsZShiYXNlLCBcInRtcC9zY3JhdGNoLnRzXCIpO1xuICAgIGFkZEZpbGUoYmFzZSwgXCJ0YXJnZXQvZGVidWcvYnVpbGQucnNcIik7XG4gICAgYWRkRmlsZShiYXNlLCBcInZlbnYvbGliL3NpdGUucHlcIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSBnZW5lcmF0ZUNvZGViYXNlTWFwKGJhc2UpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuY29udGVudC5pbmNsdWRlcyhcImBzcmMvbWFpbi50c2BcIiksIFwic2hvdWxkIGluY2x1ZGUgc3JjL21haW4udHNcIik7XG4gICAgYXNzZXJ0Lm9rKCFyZXN1bHQuY29udGVudC5pbmNsdWRlcyhcIlNLSUxMLm1kXCIpLCBcInNob3VsZCBleGNsdWRlIC5hZ2VudHMvIGZpbGVzXCIpO1xuICAgIGFzc2VydC5vayghcmVzdWx0LmNvbnRlbnQuaW5jbHVkZXMoXCIuYmctc2hlbGxcIiksIFwic2hvdWxkIGV4Y2x1ZGUgLmJnLXNoZWxsLyBmaWxlc1wiKTtcbiAgICBhc3NlcnQub2soIXJlc3VsdC5jb250ZW50LmluY2x1ZGVzKFwiLmlkZWFcIiksIFwic2hvdWxkIGV4Y2x1ZGUgLmlkZWEvIGZpbGVzXCIpO1xuICAgIGFzc2VydC5vayghcmVzdWx0LmNvbnRlbnQuaW5jbHVkZXMoXCIuY2FjaGVcIiksIFwic2hvdWxkIGV4Y2x1ZGUgLmNhY2hlLyBmaWxlc1wiKTtcbiAgICBhc3NlcnQub2soIXJlc3VsdC5jb250ZW50LmluY2x1ZGVzKFwidG1wL1wiKSwgXCJzaG91bGQgZXhjbHVkZSB0bXAvIGZpbGVzXCIpO1xuICAgIGFzc2VydC5vayghcmVzdWx0LmNvbnRlbnQuaW5jbHVkZXMoXCJ0YXJnZXRcIiksIFwic2hvdWxkIGV4Y2x1ZGUgdGFyZ2V0LyBmaWxlc1wiKTtcbiAgICBhc3NlcnQub2soIXJlc3VsdC5jb250ZW50LmluY2x1ZGVzKFwidmVudlwiKSwgXCJzaG91bGQgZXhjbHVkZSB2ZW52LyBmaWxlc1wiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmZpbGVDb3VudCwgMSk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJnZW5lcmF0ZUNvZGViYXNlTWFwOiBleGNsdWRlcyBiaW5hcnkgYW5kIGxvY2sgZmlsZXNcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcFJlcG8oKTtcbiAgdHJ5IHtcbiAgICBhZGRGaWxlKGJhc2UsIFwic3JjL21haW4udHNcIik7XG4gICAgYWRkRmlsZShiYXNlLCBcInBhY2thZ2UtbG9jay5qc29uXCIpOyAvLyAuanNvbiBub3QgZXhjbHVkZWRcbiAgICBhZGRGaWxlKGJhc2UsIFwieWFybi5sb2NrXCIpOyAgICAgICAgIC8vIC5sb2NrIGV4Y2x1ZGVkXG4gICAgYWRkRmlsZShiYXNlLCBcImFzc2V0cy9sb2dvLnBuZ1wiKTsgICAvLyAucG5nIGV4Y2x1ZGVkXG5cbiAgICBjb25zdCByZXN1bHQgPSBnZW5lcmF0ZUNvZGViYXNlTWFwKGJhc2UpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuY29udGVudC5pbmNsdWRlcyhcImBzcmMvbWFpbi50c2BcIikpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuY29udGVudC5pbmNsdWRlcyhcInBhY2thZ2UtbG9jay5qc29uXCIpKTtcbiAgICBhc3NlcnQub2soIXJlc3VsdC5jb250ZW50LmluY2x1ZGVzKFwieWFybi5sb2NrXCIpKTtcbiAgICBhc3NlcnQub2soIXJlc3VsdC5jb250ZW50LmluY2x1ZGVzKFwibG9nby5wbmdcIikpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZ2VuZXJhdGVDb2RlYmFzZU1hcDogcmVzcGVjdHMgY3VzdG9tIGV4Y2x1ZGVQYXR0ZXJuc1wiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wUmVwbygpO1xuICB0cnkge1xuICAgIGFkZEZpbGUoYmFzZSwgXCJzcmMvbWFpbi50c1wiKTtcbiAgICBhZGRGaWxlKGJhc2UsIFwiZG9jcy9ndWlkZS5tZFwiKTtcbiAgICBhZGRGaWxlKGJhc2UsIFwiZG9jcy9hcGkubWRcIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSBnZW5lcmF0ZUNvZGViYXNlTWFwKGJhc2UsIHsgZXhjbHVkZVBhdHRlcm5zOiBbXCJkb2NzL1wiXSB9KTtcbiAgICBhc3NlcnQub2socmVzdWx0LmNvbnRlbnQuaW5jbHVkZXMoXCJgc3JjL21haW4udHNgXCIpKTtcbiAgICBhc3NlcnQub2soIXJlc3VsdC5jb250ZW50LmluY2x1ZGVzKFwiZ3VpZGUubWRcIikpO1xuICAgIGFzc2VydC5vayghcmVzdWx0LmNvbnRlbnQuaW5jbHVkZXMoXCJhcGkubWRcIikpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuZmlsZUNvdW50LCAxKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcImdlbmVyYXRlQ29kZWJhc2VNYXA6IHByZXNlcnZlcyBleGlzdGluZyBkZXNjcmlwdGlvbnNcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcFJlcG8oKTtcbiAgdHJ5IHtcbiAgICBhZGRGaWxlKGJhc2UsIFwic3JjL21haW4udHNcIik7XG4gICAgYWRkRmlsZShiYXNlLCBcInNyYy91dGlscy50c1wiKTtcblxuICAgIGNvbnN0IGRlc2NyaXB0aW9ucyA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gICAgZGVzY3JpcHRpb25zLnNldChcInNyYy9tYWluLnRzXCIsIFwiQXBwIGVudHJ5IHBvaW50XCIpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gZ2VuZXJhdGVDb2RlYmFzZU1hcChiYXNlLCB1bmRlZmluZWQsIGRlc2NyaXB0aW9ucyk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5jb250ZW50LmluY2x1ZGVzKFwiYHNyYy9tYWluLnRzYCBcdTIwMTQgQXBwIGVudHJ5IHBvaW50XCIpKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmNvbnRlbnQuaW5jbHVkZXMoXCJgc3JjL3V0aWxzLnRzYFwiKSk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJnZW5lcmF0ZUNvZGViYXNlTWFwOiB3cml0ZXMgZnJlc2huZXNzIG1ldGFkYXRhIGNvbW1lbnRcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcFJlcG8oKTtcbiAgdHJ5IHtcbiAgICBhZGRGaWxlKGJhc2UsIFwic3JjL21haW4udHNcIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSBnZW5lcmF0ZUNvZGViYXNlTWFwKGJhc2UpO1xuICAgIGNvbnN0IG1ldGFkYXRhID0gcGFyc2VDb2RlYmFzZU1hcE1ldGFkYXRhKHJlc3VsdC5jb250ZW50KTtcblxuICAgIGFzc2VydC5vayhtZXRhZGF0YSwgXCJtZXRhZGF0YSBjb21tZW50IHNob3VsZCBiZSBwcmVzZW50XCIpO1xuICAgIGFzc2VydC5lcXVhbChtZXRhZGF0YT8uZmlsZUNvdW50LCAxKTtcbiAgICBhc3NlcnQuZXF1YWwobWV0YWRhdGE/LnRydW5jYXRlZCwgZmFsc2UpO1xuICAgIGFzc2VydC5lcXVhbCh0eXBlb2YgbWV0YWRhdGE/LmZpbmdlcnByaW50LCBcInN0cmluZ1wiKTtcbiAgICBhc3NlcnQub2sobWV0YWRhdGE/LmdlbmVyYXRlZEF0Py5lbmRzV2l0aChcIlpcIikpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZ2VuZXJhdGVDb2RlYmFzZU1hcDogY29sbGFwc2VzIGxhcmdlIGRpcmVjdG9yaWVzXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBSZXBvKCk7XG4gIHRyeSB7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCAyNTsgaSsrKSB7XG4gICAgICBhZGRGaWxlKGJhc2UsIGBzcmMvY29tcG9uZW50cy9jb21wJHtTdHJpbmcoaSkucGFkU3RhcnQoMiwgXCIwXCIpfS50c2ApO1xuICAgIH1cblxuICAgIGNvbnN0IHJlc3VsdCA9IGdlbmVyYXRlQ29kZWJhc2VNYXAoYmFzZSk7XG4gICAgLy8gQ29sbGFwc2VkIHN1bW1hcnkgc2hvdWxkIGFwcGVhclxuICAgIGFzc2VydC5vayhyZXN1bHQuY29udGVudC5pbmNsdWRlcyhcIiooMjUgZmlsZXM6IDI1IC50cykqXCIpKTtcbiAgICAvLyBJbmRpdmlkdWFsIGZpbGUgZW50cmllcyBzaG91bGQgTk9UIGFwcGVhciBpbiBtYWluIGJvZHlcbiAgICBhc3NlcnQub2soIXJlc3VsdC5jb250ZW50LmluY2x1ZGVzKFwiYHNyYy9jb21wb25lbnRzL2NvbXAwMC50c2BcXG5cIikpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZ2VuZXJhdGVDb2RlYmFzZU1hcDogcmVzcGVjdHMgY3VzdG9tIGNvbGxhcHNlVGhyZXNob2xkXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBSZXBvKCk7XG4gIHRyeSB7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCA1OyBpKyspIGFkZEZpbGUoYmFzZSwgYHNyYy9jb21wJHtpfS50c2ApO1xuXG4gICAgLy8gTG93IHRocmVzaG9sZDogNSBmaWxlcyBzaG91bGQgY29sbGFwc2VcbiAgICBjb25zdCBjb2xsYXBzZWQgPSBnZW5lcmF0ZUNvZGViYXNlTWFwKGJhc2UsIHsgY29sbGFwc2VUaHJlc2hvbGQ6IDMgfSk7XG4gICAgYXNzZXJ0Lm9rKGNvbGxhcHNlZC5jb250ZW50LmluY2x1ZGVzKFwiNSBmaWxlc1wiKSk7XG5cbiAgICAvLyBIaWdoIHRocmVzaG9sZDogNSBmaWxlcyBzaG91bGQgZXhwYW5kXG4gICAgY29uc3QgZXhwYW5kZWQgPSBnZW5lcmF0ZUNvZGViYXNlTWFwKGJhc2UsIHsgY29sbGFwc2VUaHJlc2hvbGQ6IDEwIH0pO1xuICAgIGFzc2VydC5vayhleHBhbmRlZC5jb250ZW50LmluY2x1ZGVzKFwiYHNyYy9jb21wMC50c2BcIikpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZ2VuZXJhdGVDb2RlYmFzZU1hcDogdHJ1bmNhdGVkPWZhbHNlIHdoZW4gZmlsZSBjb3VudCBpcyBiZWxvdyBtYXhGaWxlc1wiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wUmVwbygpO1xuICB0cnkge1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgNDsgaSsrKSBhZGRGaWxlKGJhc2UsIGBmaWxlJHtpfS50c2ApO1xuICAgIGNvbnN0IHJlc3VsdCA9IGdlbmVyYXRlQ29kZWJhc2VNYXAoYmFzZSwgeyBtYXhGaWxlczogNSB9KTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmZpbGVDb3VudCwgNCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC50cnVuY2F0ZWQsIGZhbHNlKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcImdlbmVyYXRlQ29kZWJhc2VNYXA6IHRydW5jYXRlZD1mYWxzZSB3aGVuIGZpbGUgY291bnQgZXF1YWxzIG1heEZpbGVzIGV4YWN0bHlcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcFJlcG8oKTtcbiAgdHJ5IHtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IDU7IGkrKykgYWRkRmlsZShiYXNlLCBgZmlsZSR7aX0udHNgKTtcbiAgICBjb25zdCByZXN1bHQgPSBnZW5lcmF0ZUNvZGViYXNlTWFwKGJhc2UsIHsgbWF4RmlsZXM6IDUgfSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5maWxlQ291bnQsIDUpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQudHJ1bmNhdGVkLCBmYWxzZSk7IC8vIGV4YWN0bHkgYXQgbGltaXQgXHUyMDE0IG5vdGhpbmcgd2FzIHRydW5jYXRlZFxuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZ2VuZXJhdGVDb2RlYmFzZU1hcDogdHJ1bmNhdGVkPXRydWUgd2hlbiBmaWxlIGNvdW50IGV4Y2VlZHMgbWF4RmlsZXNcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcFJlcG8oKTtcbiAgdHJ5IHtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IDEwOyBpKyspIGFkZEZpbGUoYmFzZSwgYGZpbGUke2l9LnRzYCk7XG4gICAgY29uc3QgcmVzdWx0ID0gZ2VuZXJhdGVDb2RlYmFzZU1hcChiYXNlLCB7IG1heEZpbGVzOiA1IH0pO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuZmlsZUNvdW50LCA1KTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnRydW5jYXRlZCwgdHJ1ZSk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5jb250ZW50LmluY2x1ZGVzKFwiVHJ1bmNhdGVkXCIpKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcImdlbmVyYXRlQ29kZWJhc2VNYXA6IHJldHVybnMgZW1wdHkgbWFwIGZvciBub24tZ2l0IGRpcmVjdG9yeVwiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBqb2luKHRtcGRpcigpLCBgZ3NkLWNvZGViYXNlLXRlc3QtJHtyYW5kb21VVUlEKCl9YCk7XG4gIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIC8vIE5vIGdpdCBpbml0XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gZ2VuZXJhdGVDb2RlYmFzZU1hcChiYXNlKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmZpbGVDb3VudCwgMCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC50cnVuY2F0ZWQsIGZhbHNlKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmNvbnRlbnQuaW5jbHVkZXMoXCIjIENvZGViYXNlIE1hcFwiKSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5maWxlcy5sZW5ndGgsIDApO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZ2VuZXJhdGVDb2RlYmFzZU1hcDogaGFuZGxlcyBlbXB0eSByZXBvc2l0b3J5IChubyBjb21taXR0ZWQgZmlsZXMpXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBSZXBvKCk7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gZ2VuZXJhdGVDb2RlYmFzZU1hcChiYXNlKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmZpbGVDb3VudCwgMCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC50cnVuY2F0ZWQsIGZhbHNlKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmNvbnRlbnQuaW5jbHVkZXMoXCJGaWxlczogMFwiKSk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJnZW5lcmF0ZUNvZGViYXNlTWFwOiBjb2xsYXBzZWQgZGlyZWN0b3JpZXMgcHJlc2VydmUgZGVzY3JpcHRpb25zIGluIGhpZGRlbiBjb21tZW50XCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBSZXBvKCk7XG4gIHRyeSB7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCAyNTsgaSsrKSB7XG4gICAgICBhZGRGaWxlKGJhc2UsIGBzcmMvY29tcG9uZW50cy9jb21wJHtTdHJpbmcoaSkucGFkU3RhcnQoMiwgXCIwXCIpfS50c2ApO1xuICAgIH1cblxuICAgIC8vIEdlbmVyYXRlIHdpdGggYSBkZXNjcmlwdGlvbiBmb3Igb25lIGZpbGUgaW4gdGhlIGNvbGxhcHNlZCBkaXJcbiAgICBjb25zdCBkZXNjcmlwdGlvbnMgPSBuZXcgTWFwKFtbXCJzcmMvY29tcG9uZW50cy9jb21wMDAudHNcIiwgXCJUaGUgZmlyc3QgY29tcG9uZW50XCJdXSk7XG4gICAgY29uc3QgcmVzdWx0ID0gZ2VuZXJhdGVDb2RlYmFzZU1hcChiYXNlLCB1bmRlZmluZWQsIGRlc2NyaXB0aW9ucyk7XG5cbiAgICAvLyBUaGUgZGVzY3JpcHRpb24gc2hvdWxkIGJlIGluIHRoZSBoaWRkZW4gY29tbWVudCBibG9ja1xuICAgIGFzc2VydC5vayhyZXN1bHQuY29udGVudC5pbmNsdWRlcyhcIjwhLS0gZ3NkOmNvbGxhcHNlZC1kZXNjcmlwdGlvbnNcIikpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuY29udGVudC5pbmNsdWRlcyhcImBzcmMvY29tcG9uZW50cy9jb21wMDAudHNgIFx1MjAxNCBUaGUgZmlyc3QgY29tcG9uZW50XCIpKTtcblxuICAgIC8vIFJlLXBhcnNpbmcgc2hvdWxkIHJlY292ZXIgdGhlIGRlc2NyaXB0aW9uXG4gICAgY29uc3QgcmVjb3ZlcmVkID0gcGFyc2VDb2RlYmFzZU1hcChyZXN1bHQuY29udGVudCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlY292ZXJlZC5nZXQoXCJzcmMvY29tcG9uZW50cy9jb21wMDAudHNcIiksIFwiVGhlIGZpcnN0IGNvbXBvbmVudFwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHVwZGF0ZUNvZGViYXNlTWFwIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwidXBkYXRlQ29kZWJhc2VNYXA6IHByZXNlcnZlcyBkZXNjcmlwdGlvbnMgb24gdXBkYXRlXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBSZXBvKCk7XG4gIHRyeSB7XG4gICAgYWRkRmlsZShiYXNlLCBcInNyYy9tYWluLnRzXCIpO1xuICAgIGFkZEZpbGUoYmFzZSwgXCJzcmMvdXRpbHMudHNcIik7XG5cbiAgICBjb25zdCBpbml0aWFsID0gZ2VuZXJhdGVDb2RlYmFzZU1hcChiYXNlLCB1bmRlZmluZWQsIG5ldyBNYXAoW1tcInNyYy9tYWluLnRzXCIsIFwiRW50cnkgcG9pbnRcIl1dKSk7XG4gICAgd3JpdGVDb2RlYmFzZU1hcChiYXNlLCBpbml0aWFsLmNvbnRlbnQpO1xuXG4gICAgYWRkRmlsZShiYXNlLCBcInNyYy9uZXcudHNcIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSB1cGRhdGVDb2RlYmFzZU1hcChiYXNlKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmNvbnRlbnQuaW5jbHVkZXMoXCJgc3JjL21haW4udHNgIFx1MjAxNCBFbnRyeSBwb2ludFwiKSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5hZGRlZCwgMSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5maWxlQ291bnQsIDMpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwidXBkYXRlQ29kZWJhc2VNYXA6IHRyYWNrcyByZW1vdmVkIGZpbGVzXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBSZXBvKCk7XG4gIHRyeSB7XG4gICAgYWRkRmlsZShiYXNlLCBcInNyYy9rZWVwLnRzXCIpO1xuICAgIGFkZEZpbGUoYmFzZSwgXCJzcmMvcmVtb3ZlLnRzXCIpO1xuICAgIC8vIENvbW1pdCBzbyBnaXQgcm0gY2FuIG9wZXJhdGVcbiAgICBleGVjU3luYyhcImdpdCAtYyB1c2VyLmVtYWlsPXRAdC5jb20gLWMgdXNlci5uYW1lPVQgY29tbWl0IC1tIGluaXRcIiwgeyBjd2Q6IGJhc2UsIHN0ZGlvOiBcImlnbm9yZVwiIH0pO1xuXG4gICAgY29uc3QgaW5pdGlhbCA9IGdlbmVyYXRlQ29kZWJhc2VNYXAoYmFzZSk7XG4gICAgd3JpdGVDb2RlYmFzZU1hcChiYXNlLCBpbml0aWFsLmNvbnRlbnQpO1xuXG4gICAgZXhlY1N5bmMoXCJnaXQgcm0gc3JjL3JlbW92ZS50c1wiLCB7IGN3ZDogYmFzZSwgc3RkaW86IFwiaWdub3JlXCIgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSB1cGRhdGVDb2RlYmFzZU1hcChiYXNlKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnJlbW92ZWQsIDEpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQudW5jaGFuZ2VkLCAxKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmZpbGVDb3VudCwgMSk7XG4gICAgYXNzZXJ0Lm9rKCFyZXN1bHQuY29udGVudC5pbmNsdWRlcyhcInJlbW92ZS50c1wiKSk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJ1cGRhdGVDb2RlYmFzZU1hcDogcHJvcGFnYXRlcyB0cnVuY2F0ZWQgZmxhZ1wiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wUmVwbygpO1xuICB0cnkge1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgMTA7IGkrKykgYWRkRmlsZShiYXNlLCBgZmlsZSR7aX0udHNgKTtcblxuICAgIGNvbnN0IGluaXRpYWwgPSBnZW5lcmF0ZUNvZGViYXNlTWFwKGJhc2UsIHsgbWF4RmlsZXM6IDUgfSk7XG4gICAgd3JpdGVDb2RlYmFzZU1hcChiYXNlLCBpbml0aWFsLmNvbnRlbnQpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gdXBkYXRlQ29kZWJhc2VNYXAoYmFzZSwgeyBtYXhGaWxlczogNSB9KTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnRydW5jYXRlZCwgdHJ1ZSk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJ1cGRhdGVDb2RlYmFzZU1hcDogcHJlc2VydmVzIGRlc2NyaXB0aW9ucyBmcm9tIGNvbGxhcHNlZCBkaXJlY3Rvcmllc1wiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wUmVwbygpO1xuICB0cnkge1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgMjU7IGkrKykge1xuICAgICAgYWRkRmlsZShiYXNlLCBgc3JjL2NvbXBvbmVudHMvY29tcCR7U3RyaW5nKGkpLnBhZFN0YXJ0KDIsIFwiMFwiKX0udHNgKTtcbiAgICB9XG5cbiAgICAvLyBHZW5lcmF0ZSB3aXRoIGEgZGVzY3JpcHRpb24gaW4gdGhlIChjb2xsYXBzZWQpIGNvbXBvbmVudHMgZGlyXG4gICAgY29uc3QgZGVzY3JpcHRpb25zID0gbmV3IE1hcChbW1wic3JjL2NvbXBvbmVudHMvY29tcDAwLnRzXCIsIFwiVGhlIGZpcnN0IGNvbXBvbmVudFwiXV0pO1xuICAgIGNvbnN0IGluaXRpYWwgPSBnZW5lcmF0ZUNvZGViYXNlTWFwKGJhc2UsIHVuZGVmaW5lZCwgZGVzY3JpcHRpb25zKTtcbiAgICB3cml0ZUNvZGViYXNlTWFwKGJhc2UsIGluaXRpYWwuY29udGVudCk7XG5cbiAgICAvLyBVcGRhdGUgc2hvdWxkIHJlY292ZXIgZGVzY3JpcHRpb24gZnJvbSB0aGUgaGlkZGVuIGNvbW1lbnRcbiAgICBjb25zdCByZXN1bHQgPSB1cGRhdGVDb2RlYmFzZU1hcChiYXNlKTtcbiAgICBjb25zdCByZWNvdmVyZWQgPSBwYXJzZUNvZGViYXNlTWFwKHJlc3VsdC5jb250ZW50KTtcbiAgICBhc3NlcnQuZXF1YWwocmVjb3ZlcmVkLmdldChcInNyYy9jb21wb25lbnRzL2NvbXAwMC50c1wiKSwgXCJUaGUgZmlyc3QgY29tcG9uZW50XCIpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgd3JpdGVDb2RlYmFzZU1hcCAvIHJlYWRDb2RlYmFzZU1hcCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcIndyaXRlQ29kZWJhc2VNYXAgKyByZWFkQ29kZWJhc2VNYXAgcm91bmR0cmlwXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBSZXBvKCk7XG4gIHRyeSB7XG4gICAgY29uc3QgY29udGVudCA9IFwiIyBDb2RlYmFzZSBNYXBcXG5cXG4tIGB0ZXN0LnRzYCBcdTIwMTQgQSB0ZXN0IGZpbGVcXG5cIjtcbiAgICBjb25zdCBvdXRQYXRoID0gd3JpdGVDb2RlYmFzZU1hcChiYXNlLCBjb250ZW50KTtcbiAgICBhc3NlcnQub2soZXhpc3RzU3luYyhvdXRQYXRoKSk7XG5cbiAgICBjb25zdCByZWFkID0gcmVhZENvZGViYXNlTWFwKGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChyZWFkLCBjb250ZW50KTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcInJlYWRDb2RlYmFzZU1hcDogcmV0dXJucyBudWxsIHdoZW4gZmlsZSBtaXNzaW5nXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBSZXBvKCk7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gcmVhZENvZGViYXNlTWFwKGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIG51bGwpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwid3JpdGVDb2RlYmFzZU1hcDogY3JlYXRlcyAuZ3NkLyBkaXJlY3RvcnkgaWYgbWlzc2luZ1wiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBqb2luKHRtcGRpcigpLCBgZ3NkLWNvZGViYXNlLXRlc3QtJHtyYW5kb21VVUlEKCl9YCk7XG4gIG1rZGlyU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgLy8gSW50ZW50aW9uYWxseSBkbyBOT1QgcHJlLWNyZWF0ZSAuZ3NkL1xuICB0cnkge1xuICAgIGNvbnN0IG91dFBhdGggPSB3cml0ZUNvZGViYXNlTWFwKGJhc2UsIFwiIyBDb2RlYmFzZSBNYXBcXG5cIik7XG4gICAgYXNzZXJ0Lm9rKGV4aXN0c1N5bmMob3V0UGF0aCkpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgZ2V0Q29kZWJhc2VNYXBTdGF0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcImdldENvZGViYXNlTWFwU3RhdHM6IG5vIG1hcCByZXR1cm5zIGV4aXN0cz1mYWxzZVwiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wUmVwbygpO1xuICB0cnkge1xuICAgIGNvbnN0IHN0YXRzID0gZ2V0Q29kZWJhc2VNYXBTdGF0cyhiYXNlKTtcbiAgICBhc3NlcnQuZXF1YWwoc3RhdHMuZXhpc3RzLCBmYWxzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHN0YXRzLmZpbGVDb3VudCwgMCk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJnZXRDb2RlYmFzZU1hcFN0YXRzOiByZXBvcnRzIGNvdmVyYWdlXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBSZXBvKCk7XG4gIHRyeSB7XG4gICAgY29uc3QgY29udGVudCA9IGAjIENvZGViYXNlIE1hcFxcblxcbkdlbmVyYXRlZDogMjAyNi0wMy0yM1QxNDowMDowMFogfCBGaWxlczogMyB8IERlc2NyaWJlZDogMi8zXFxuXFxuLSBcXGBhLnRzXFxgIFx1MjAxNCBIYXMgZGVzY1xcbi0gXFxgYi50c1xcYFxcbi0gXFxgYy50c1xcYCBcdTIwMTQgQWxzbyBoYXNcXG5gO1xuICAgIHdyaXRlQ29kZWJhc2VNYXAoYmFzZSwgY29udGVudCk7XG5cbiAgICBjb25zdCBzdGF0cyA9IGdldENvZGViYXNlTWFwU3RhdHMoYmFzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHN0YXRzLmV4aXN0cywgdHJ1ZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHN0YXRzLmZpbGVDb3VudCwgMyk7IC8vIGZyb20gaGVhZGVyLCBub3QgcGFyc2UgY291bnRcbiAgICBhc3NlcnQuZXF1YWwoc3RhdHMuZGVzY3JpYmVkQ291bnQsIDIpO1xuICAgIGFzc2VydC5lcXVhbChzdGF0cy51bmRlc2NyaWJlZENvdW50LCAxKTtcbiAgICBhc3NlcnQuZXF1YWwoc3RhdHMuZ2VuZXJhdGVkQXQsIFwiMjAyNi0wMy0yM1QxNDowMDowMFpcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJnZXRDb2RlYmFzZU1hcFN0YXRzOiByZWFkcyB0b3RhbCBmaWxlIGNvdW50IGZyb20gaGVhZGVyIGZvciBhY2N1cmFjeSB3aXRoIGNvbGxhcHNlZCBkaXJzXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBSZXBvKCk7XG4gIHRyeSB7XG4gICAgLy8gU2ltdWxhdGUgYSBtYXAgd2l0aCBhIGNvbGxhcHNlZCBkaXI6IGhlYWRlciBzYXlzIDMwIGZpbGVzIGJ1dCBwYXJzZXIgb25seSBzZWVzIDJcbiAgICBjb25zdCBjb250ZW50ID0gW1xuICAgICAgXCIjIENvZGViYXNlIE1hcFwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiR2VuZXJhdGVkOiAyMDI2LTAzLTIzVDE0OjAwOjAwWiB8IEZpbGVzOiAzMCB8IERlc2NyaWJlZDogMi8zMFwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMjIHNyYy9jb21wb25lbnRzL1wiLFxuICAgICAgXCItICooMjggZmlsZXM6IDI4IC50cykqXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyMgc3JjL1wiLFxuICAgICAgXCItIGBtYWluLnRzYCBcdTIwMTQgRW50cnkgcG9pbnRcIixcbiAgICAgIFwiLSBgdXRpbHMudHNgIFx1MjAxNCBVdGlsaXRpZXNcIixcbiAgICBdLmpvaW4oXCJcXG5cIik7XG4gICAgd3JpdGVDb2RlYmFzZU1hcChiYXNlLCBjb250ZW50KTtcblxuICAgIGNvbnN0IHN0YXRzID0gZ2V0Q29kZWJhc2VNYXBTdGF0cyhiYXNlKTtcbiAgICBhc3NlcnQuZXF1YWwoc3RhdHMuZmlsZUNvdW50LCAzMCk7IC8vIGZyb20gaGVhZGVyLCBub3QgZnJvbSBwYXJzZUNvZGViYXNlTWFwXG4gICAgYXNzZXJ0LmVxdWFsKHN0YXRzLmRlc2NyaWJlZENvdW50LCAyKTtcbiAgICBhc3NlcnQuZXF1YWwoc3RhdHMudW5kZXNjcmliZWRDb3VudCwgMjgpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgZXhjbHVkZVBhdHRlcm5zIGZyb20gb3B0aW9ucyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcImdlbmVyYXRlQ29kZWJhc2VNYXA6IGN1c3RvbSBleGNsdWRlUGF0dGVybnMgZmlsdGVycyBhZGRpdGlvbmFsIGRpcmVjdG9yaWVzXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBSZXBvKCk7XG4gIHRyeSB7XG4gICAgYWRkRmlsZShiYXNlLCBcInNyYy9tYWluLnRzXCIpO1xuICAgIGFkZEZpbGUoYmFzZSwgXCJzcmMvdXRpbHMudHNcIik7XG4gICAgYWRkRmlsZShiYXNlLCBcIi5jYWNoZS1kYXRhL2RhdGEvaW5kZXgubGFuY2VcIik7XG4gICAgYWRkRmlsZShiYXNlLCBcImRvY3MvZ3VpZGUubWRcIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSBnZW5lcmF0ZUNvZGViYXNlTWFwKGJhc2UsIHtcbiAgICAgIGV4Y2x1ZGVQYXR0ZXJuczogW1wiLmNhY2hlLWRhdGEvXCIsIFwiZG9jcy9cIl0sXG4gICAgfSk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5jb250ZW50LmluY2x1ZGVzKFwiYHNyYy9tYWluLnRzYFwiKSk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5jb250ZW50LmluY2x1ZGVzKFwiYHNyYy91dGlscy50c2BcIikpO1xuICAgIGFzc2VydC5vayghcmVzdWx0LmNvbnRlbnQuaW5jbHVkZXMoXCIuY2FjaGUtZGF0YVwiKSk7XG4gICAgYXNzZXJ0Lm9rKCFyZXN1bHQuY29udGVudC5pbmNsdWRlcyhcImd1aWRlLm1kXCIpKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmZpbGVDb3VudCwgMik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJnZW5lcmF0ZUNvZGViYXNlTWFwOiBjb2xsYXBzZVRocmVzaG9sZCBvcHRpb24gb3ZlcnJpZGVzIGRlZmF1bHRcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcFJlcG8oKTtcbiAgdHJ5IHtcbiAgICAvLyBDcmVhdGUgMTAgZmlsZXMgaW4gb25lIGRpcmVjdG9yeSBcdTIwMTQgYmVsb3cgZGVmYXVsdCB0aHJlc2hvbGQgKDIwKVxuICAgIC8vIGJ1dCBhYm92ZSBhIGN1c3RvbSB0aHJlc2hvbGQgb2YgNVxuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgMTA7IGkrKykge1xuICAgICAgYWRkRmlsZShiYXNlLCBgc3JjL2NvbXAke2l9LnRzYCk7XG4gICAgfVxuXG4gICAgLy8gV2l0aCBkZWZhdWx0IHRocmVzaG9sZCAoMjApLCBmaWxlcyBzaG91bGQgTk9UIGNvbGxhcHNlXG4gICAgY29uc3QgZXhwYW5kZWQgPSBnZW5lcmF0ZUNvZGViYXNlTWFwKGJhc2UpO1xuICAgIGFzc2VydC5vayhleHBhbmRlZC5jb250ZW50LmluY2x1ZGVzKFwiYHNyYy9jb21wMC50c2BcIikpO1xuXG4gICAgLy8gV2l0aCBjdXN0b20gdGhyZXNob2xkICg1KSwgZmlsZXMgU0hPVUxEIGNvbGxhcHNlXG4gICAgY29uc3QgY29sbGFwc2VkID0gZ2VuZXJhdGVDb2RlYmFzZU1hcChiYXNlLCB7IGNvbGxhcHNlVGhyZXNob2xkOiA1IH0pO1xuICAgIGFzc2VydC5vayhjb2xsYXBzZWQuY29udGVudC5pbmNsdWRlcyhcIjEwIGZpbGVzXCIpKTtcbiAgICBhc3NlcnQub2soIWNvbGxhcHNlZC5jb250ZW50LmluY2x1ZGVzKFwiYHNyYy9jb21wMC50c2BcXG5cIikpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwidXBkYXRlQ29kZWJhc2VNYXA6IHJlc3BlY3RzIGV4Y2x1ZGVQYXR0ZXJucyBvcHRpb25cIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcFJlcG8oKTtcbiAgdHJ5IHtcbiAgICBhZGRGaWxlKGJhc2UsIFwic3JjL21haW4udHNcIik7XG4gICAgYWRkRmlsZShiYXNlLCBcInZlbmRvci1leHRyYS9saWIuanNcIik7XG5cbiAgICBjb25zdCBpbml0aWFsID0gZ2VuZXJhdGVDb2RlYmFzZU1hcChiYXNlKTtcbiAgICB3cml0ZUNvZGViYXNlTWFwKGJhc2UsIGluaXRpYWwuY29udGVudCk7XG5cbiAgICAvLyBVcGRhdGUgd2l0aCBleGNsdXNpb24gc2hvdWxkIHJlbW92ZSB2ZW5kb3ItZXh0cmEgZmlsZXNcbiAgICBjb25zdCByZXN1bHQgPSB1cGRhdGVDb2RlYmFzZU1hcChiYXNlLCB7IGV4Y2x1ZGVQYXR0ZXJuczogW1widmVuZG9yLWV4dHJhL1wiXSB9KTtcbiAgICBhc3NlcnQub2socmVzdWx0LmNvbnRlbnQuaW5jbHVkZXMoXCJgc3JjL21haW4udHNgXCIpKTtcbiAgICBhc3NlcnQub2soIXJlc3VsdC5jb250ZW50LmluY2x1ZGVzKFwidmVuZG9yLWV4dHJhXCIpKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcImVuc3VyZUNvZGViYXNlTWFwRnJlc2g6IGdlbmVyYXRlcyBDT0RFQkFTRS5tZCB3aGVuIG1pc3NpbmdcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcFJlcG8oKTtcbiAgdHJ5IHtcbiAgICBhZGRGaWxlKGJhc2UsIFwic3JjL21haW4udHNcIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSBlbnN1cmVDb2RlYmFzZU1hcEZyZXNoKGJhc2UsIHVuZGVmaW5lZCwgeyB0dGxNczogMCwgZm9yY2U6IHRydWUgfSk7XG4gICAgY29uc3Qgd3JpdHRlbiA9IHJlYWRDb2RlYmFzZU1hcChiYXNlKTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc3RhdHVzLCBcImdlbmVyYXRlZFwiKTtcbiAgICBhc3NlcnQub2sod3JpdHRlbj8uaW5jbHVkZXMoXCJgc3JjL21haW4udHNgXCIpKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcImVuc3VyZUNvZGViYXNlTWFwRnJlc2g6IHVwZGF0ZXMgQ09ERUJBU0UubWQgd2hlbiB0cmFja2VkIGZpbGVzIGNoYW5nZVwiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wUmVwbygpO1xuICB0cnkge1xuICAgIGFkZEZpbGUoYmFzZSwgXCJzcmMvbWFpbi50c1wiKTtcbiAgICBjb25zdCBpbml0aWFsID0gZW5zdXJlQ29kZWJhc2VNYXBGcmVzaChiYXNlLCB1bmRlZmluZWQsIHsgdHRsTXM6IDAsIGZvcmNlOiB0cnVlIH0pO1xuICAgIGFzc2VydC5lcXVhbChpbml0aWFsLnN0YXR1cywgXCJnZW5lcmF0ZWRcIik7XG5cbiAgICBhZGRGaWxlKGJhc2UsIFwic3JjL25ldy50c1wiKTtcbiAgICBjb25zdCByZWZyZXNoZWQgPSBlbnN1cmVDb2RlYmFzZU1hcEZyZXNoKGJhc2UsIHVuZGVmaW5lZCwgeyB0dGxNczogMCwgZm9yY2U6IHRydWUgfSk7XG4gICAgY29uc3Qgd3JpdHRlbiA9IHJlYWRDb2RlYmFzZU1hcChiYXNlKTtcblxuICAgIGFzc2VydC5lcXVhbChyZWZyZXNoZWQuc3RhdHVzLCBcInVwZGF0ZWRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlZnJlc2hlZC5yZWFzb24sIFwiZmlsZXMtY2hhbmdlZFwiKTtcbiAgICBhc3NlcnQub2sod3JpdHRlbj8uaW5jbHVkZXMoXCJgc3JjL25ldy50c2BcIikpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZW5zdXJlQ29kZWJhc2VNYXBGcmVzaDogcmV0dXJucyBmcmVzaCB3aGVuIG1ldGFkYXRhIG1hdGNoZXMgcmVwb3NpdG9yeSBzdGF0ZVwiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wUmVwbygpO1xuICB0cnkge1xuICAgIGFkZEZpbGUoYmFzZSwgXCJzcmMvbWFpbi50c1wiKTtcbiAgICBlbnN1cmVDb2RlYmFzZU1hcEZyZXNoKGJhc2UsIHVuZGVmaW5lZCwgeyB0dGxNczogMCwgZm9yY2U6IHRydWUgfSk7XG5cbiAgICBjb25zdCByZWZyZXNoZWQgPSBlbnN1cmVDb2RlYmFzZU1hcEZyZXNoKGJhc2UsIHVuZGVmaW5lZCwgeyB0dGxNczogMCwgZm9yY2U6IHRydWUgfSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlZnJlc2hlZC5zdGF0dXMsIFwiZnJlc2hcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlZnJlc2hlZC5maWxlQ291bnQsIDEpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUNuQixTQUFTLFdBQVcsZUFBNkIsWUFBWSxjQUFjO0FBQzNFLFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFDdkIsU0FBUyxrQkFBa0I7QUFDM0IsU0FBUyxnQkFBZ0I7QUFFekI7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFJUCxTQUFTLGNBQXNCO0FBQzdCLFFBQU0sT0FBTyxLQUFLLE9BQU8sR0FBRyxxQkFBcUIsV0FBVyxDQUFDLEVBQUU7QUFDL0QsWUFBVSxLQUFLLE1BQU0sTUFBTSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDakQsV0FBUyxZQUFZLEVBQUUsS0FBSyxNQUFNLE9BQU8sU0FBUyxDQUFDO0FBQ25ELFNBQU87QUFDVDtBQUVBLFNBQVMsUUFBUSxNQUFjLE1BQWMsVUFBVSxJQUFVO0FBQy9ELFFBQU0sV0FBVyxLQUFLLE1BQU0sSUFBSTtBQUNoQyxZQUFVLEtBQUssVUFBVSxJQUFJLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNuRCxnQkFBYyxVQUFVLFdBQVcsTUFBTSxJQUFJO0FBQUEsR0FBTSxPQUFP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
