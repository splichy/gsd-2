import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  extractRelativeImports,
  resolveImportPath,
  checkImportResolution,
  checkCrossTaskSignatures,
  checkPatternConsistency,
  runPostExecutionChecks
} from "../post-execution-checks.js";
function createTask(overrides = {}) {
  return {
    milestone_id: "M001",
    slice_id: "S01",
    id: overrides.id ?? "T01",
    title: "Test Task",
    status: "complete",
    one_liner: "",
    narrative: "",
    verification_result: "",
    duration: "",
    completed_at: (/* @__PURE__ */ new Date()).toISOString(),
    blocker_discovered: false,
    deviations: "",
    known_issues: "",
    key_files: overrides.key_files ?? [],
    key_decisions: [],
    full_summary_md: "",
    description: overrides.description ?? "",
    estimate: "",
    files: overrides.files ?? [],
    verify: "",
    inputs: overrides.inputs ?? [],
    expected_output: overrides.expected_output ?? [],
    observability_impact: "",
    full_plan_md: "",
    sequence: overrides.sequence ?? 0,
    blocker_source: "",
    escalation_pending: 0,
    escalation_awaiting_review: 0,
    escalation_artifact_path: null,
    escalation_override_applied_at: null,
    ...overrides
  };
}
describe("extractRelativeImports", () => {
  test("extracts import ... from statements", () => {
    const source = `
import { foo } from './utils';
import bar from "../helpers/bar";
    `;
    const imports = extractRelativeImports(source);
    assert.equal(imports.length, 2);
    assert.ok(imports.some((i) => i.importPath === "./utils"));
    assert.ok(imports.some((i) => i.importPath === "../helpers/bar"));
  });
  test("extracts side-effect imports", () => {
    const source = `import './polyfill';`;
    const imports = extractRelativeImports(source);
    assert.equal(imports.length, 1);
    assert.equal(imports[0].importPath, "./polyfill");
  });
  test("extracts require statements", () => {
    const source = `
const utils = require('./utils');
const { bar } = require("../helpers/bar");
    `;
    const imports = extractRelativeImports(source);
    assert.equal(imports.length, 2);
    assert.ok(imports.some((i) => i.importPath === "./utils"));
    assert.ok(imports.some((i) => i.importPath === "../helpers/bar"));
  });
  test("ignores non-relative imports", () => {
    const source = `
import express from 'express';
import { readFile } from 'node:fs';
const lodash = require('lodash');
    `;
    const imports = extractRelativeImports(source);
    assert.equal(imports.length, 0);
  });
  test("reports correct line numbers", () => {
    const source = `// comment
import { a } from './a';
// another comment
import { b } from './b';
`;
    const imports = extractRelativeImports(source);
    assert.equal(imports.length, 2);
    const importA = imports.find((i) => i.importPath === "./a");
    const importB = imports.find((i) => i.importPath === "./b");
    assert.equal(importA?.lineNum, 2);
    assert.equal(importB?.lineNum, 4);
  });
  test("handles multiple imports on same line", () => {
    const source = `import a from './a'; import b from './b';`;
    const imports = extractRelativeImports(source);
    assert.equal(imports.length, 2);
  });
  test("ignores import-looking string literals in test fixtures", () => {
    const source = `
const rewritten = source.replace(
  'import { normalizeZagrebBusinessDeadline } from "./cutoff";',
  'const helper = true;'
);

import realThing from "./real-thing";
`;
    const imports = extractRelativeImports(source);
    assert.deepEqual(imports, [
      { importPath: "./real-thing", lineNum: 7 }
    ]);
  });
  test("ignores import-looking lines inside template literals", () => {
    const source = [
      "const fixture = `",
      "import missingThing from './missing-thing';",
      "`;",
      "",
      "import realThing from './real-thing';"
    ].join("\n");
    const imports = extractRelativeImports(source);
    assert.deepEqual(imports, [
      { importPath: "./real-thing", lineNum: 5 }
    ]);
  });
  test("ignores require() inside string literals", () => {
    const source = [
      `const fixture = "const x = require('./missing');";`,
      `const otherFixture = 'const y = require("./also-missing");';`,
      "const real = require('./real');"
    ].join("\n");
    const imports = extractRelativeImports(source);
    assert.deepEqual(imports, [
      { importPath: "./real", lineNum: 3 }
    ]);
  });
  test("ignores require() inside template literals", () => {
    const source = [
      "const fixture = `",
      "const x = require('./missing');",
      "`;",
      "",
      "const real = require('./real');"
    ].join("\n");
    const imports = extractRelativeImports(source);
    assert.deepEqual(imports, [
      { importPath: "./real", lineNum: 5 }
    ]);
  });
  test("handles empty source", () => {
    const imports = extractRelativeImports("");
    assert.deepEqual(imports, []);
  });
});
describe("resolveImportPath", () => {
  let tempDir;
  test("resolves file with exact extension", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src", "utils.ts"), "export const a = 1;");
    writeFileSync(join(tempDir, "src", "main.ts"), "import { a } from './utils';");
    try {
      const result = resolveImportPath("./utils", "src/main.ts", tempDir);
      assert.ok(result.exists);
      assert.ok(result.resolvedPath?.endsWith("utils.ts"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("resolves file without extension", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src", "helpers.js"), "module.exports = {};");
    writeFileSync(join(tempDir, "src", "index.ts"), "");
    try {
      const result = resolveImportPath("./helpers", "src/index.ts", tempDir);
      assert.ok(result.exists);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("resolves directory index file", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src", "utils"), { recursive: true });
    writeFileSync(join(tempDir, "src", "utils", "index.ts"), "export {};");
    writeFileSync(join(tempDir, "src", "main.ts"), "");
    try {
      const result = resolveImportPath("./utils", "src/main.ts", tempDir);
      assert.ok(result.exists);
      assert.ok(result.resolvedPath?.endsWith("index.ts"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("resolves parent directory imports", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src", "nested"), { recursive: true });
    writeFileSync(join(tempDir, "src", "utils.ts"), "export {};");
    writeFileSync(join(tempDir, "src", "nested", "child.ts"), "");
    try {
      const result = resolveImportPath("../utils", "src/nested/child.ts", tempDir);
      assert.ok(result.exists);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("fails for non-existent file", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src", "main.ts"), "");
    try {
      const result = resolveImportPath("./nonexistent", "src/main.ts", tempDir);
      assert.ok(!result.exists);
      assert.equal(result.resolvedPath, null);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("handles explicit extension in import", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src", "data.json"), "{}");
    writeFileSync(join(tempDir, "src", "main.ts"), "");
    try {
      const result = resolveImportPath("./data.json", "src/main.ts", tempDir);
      assert.ok(result.exists);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("resolves side-effect CSS import with explicit extension", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "post-exec-test-css-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "frontend", "src", "routes"), { recursive: true });
    mkdirSync(join(dir, "frontend", "styles"), { recursive: true });
    writeFileSync(join(dir, "frontend", "styles", "globals.css"), "");
    writeFileSync(
      join(dir, "frontend", "src", "routes", "root.tsx"),
      "import '../../styles/globals.css';"
    );
    const result = resolveImportPath(
      "../../styles/globals.css",
      "frontend/src/routes/root.tsx",
      dir
    );
    assert.ok(result.exists, "CSS side-effect import should resolve");
    assert.ok(result.resolvedPath?.endsWith("globals.css"));
  });
  test("resolves SCSS asset import", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "post-exec-test-scss-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "theme.scss"), "");
    writeFileSync(join(dir, "src", "main.ts"), "");
    const result = resolveImportPath("./theme.scss", "src/main.ts", dir);
    assert.ok(result.exists);
  });
  test("still fails for missing asset import", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "post-exec-test-missing-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "main.ts"), "");
    const result = resolveImportPath("./missing.css", "src/main.ts", dir);
    assert.ok(!result.exists);
    assert.equal(result.resolvedPath, null);
  });
  test("resolves .js import to sibling .ts (TS ESM convention)", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "post-exec-test-tsesm-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "types.ts"), "export {};");
    writeFileSync(join(dir, "src", "main.ts"), "");
    const result = resolveImportPath("./types.js", "src/main.ts", dir);
    assert.ok(result.exists);
    assert.ok(result.resolvedPath?.endsWith("types.ts"));
  });
  test("missing asset import does not match code-extension shadow", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "post-exec-test-shadow-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "missing.css.ts"), "export {};");
    writeFileSync(join(dir, "src", "main.ts"), "");
    const result = resolveImportPath("./missing.css", "src/main.ts", dir);
    assert.ok(!result.exists);
    assert.equal(result.resolvedPath, null);
  });
  test("resolves dotted TS module stem like .server via extension probing", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "post-exec-test-server-dot-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "route.server.ts"), "export {};\n");
    writeFileSync(join(dir, "src", "main.ts"), "");
    const result = resolveImportPath("./route.server", "src/main.ts", dir);
    assert.ok(result.exists);
    assert.ok(result.resolvedPath?.endsWith("route.server.ts"));
  });
  test("missing unknown explicit extension does not match code-extension shadow", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "post-exec-test-unknown-shadow-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "video.mp4.ts"), "export {};\n");
    writeFileSync(join(dir, "src", "main.ts"), "");
    const result = resolveImportPath("./video.mp4", "src/main.ts", dir);
    assert.ok(!result.exists);
    assert.equal(result.resolvedPath, null);
  });
});
describe("checkImportResolution", () => {
  let tempDir;
  test("passes when all imports resolve", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src", "utils.ts"), "export const a = 1;");
    writeFileSync(
      join(tempDir, "src", "main.ts"),
      "import { a } from './utils';"
    );
    try {
      const task = createTask({
        id: "T01",
        key_files: ["src/main.ts"]
      });
      const results = checkImportResolution(task, [], tempDir);
      assert.deepEqual(results, []);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("ignores generated React Router +types imports", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "app", "routes"), { recursive: true });
    writeFileSync(
      join(tempDir, "app", "routes", "root.tsx"),
      "import type { Route } from './+types/root';\nexport default function Root() { return null; }"
    );
    try {
      const task = createTask({
        id: "T01",
        key_files: ["app/routes/root.tsx"]
      });
      const results = checkImportResolution(task, [], tempDir);
      assert.deepEqual(results, []);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("fails when import doesn't resolve", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(
      join(tempDir, "src", "main.ts"),
      "import { a } from './nonexistent';"
    );
    try {
      const task = createTask({
        id: "T01",
        key_files: ["src/main.ts"]
      });
      const results = checkImportResolution(task, [], tempDir);
      assert.equal(results.length, 1);
      assert.equal(results[0].category, "import");
      assert.equal(results[0].passed, false);
      assert.equal(results[0].blocking, true);
      assert.ok(results[0].message.includes("nonexistent"));
      assert.ok(results[0].target.includes("src/main.ts"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("skips non-JS/TS files", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, "README.md"), "# Docs");
    try {
      const task = createTask({
        id: "T01",
        key_files: ["README.md"]
      });
      const results = checkImportResolution(task, [], tempDir);
      assert.deepEqual(results, []);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("handles multiple files with multiple imports", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src", "utils.ts"), "export const a = 1;");
    writeFileSync(
      join(tempDir, "src", "a.ts"),
      "import { a } from './utils';\nimport { b } from './missing';"
    );
    writeFileSync(
      join(tempDir, "src", "b.ts"),
      "import { x } from './also-missing';"
    );
    try {
      const task = createTask({
        id: "T01",
        key_files: ["src/a.ts", "src/b.ts"]
      });
      const results = checkImportResolution(task, [], tempDir);
      assert.equal(results.length, 2);
      assert.ok(results.some((r) => r.message.includes("missing")));
      assert.ok(results.some((r) => r.message.includes("also-missing")));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("skips if key_file doesn't exist", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    try {
      const task = createTask({
        id: "T01",
        key_files: ["src/deleted.ts"]
      });
      const results = checkImportResolution(task, [], tempDir);
      assert.deepEqual(results, []);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("does not block on valid CSS side-effect import in .tsx key_file", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "post-exec-test-asset-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "frontend", "src", "routes"), { recursive: true });
    mkdirSync(join(dir, "frontend", "styles"), { recursive: true });
    writeFileSync(join(dir, "frontend", "styles", "globals.css"), "");
    writeFileSync(
      join(dir, "frontend", "src", "routes", "root.tsx"),
      "import '../../styles/globals.css';\nexport default function Root() { return null; }"
    );
    const task = createTask({
      id: "T03",
      key_files: ["frontend/src/routes/root.tsx"]
    });
    const results = checkImportResolution(task, [], dir);
    assert.deepEqual(results, [], "valid CSS import must not be flagged");
  });
});
describe("checkCrossTaskSignatures", () => {
  let tempDir;
  test("passes when no prior tasks exist", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(
      join(tempDir, "src", "api.ts"),
      "export function getData(): string { return ''; }"
    );
    try {
      const task = createTask({
        id: "T02",
        key_files: ["src/api.ts"]
      });
      const results = checkCrossTaskSignatures(task, [], tempDir);
      assert.deepEqual(results, []);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("passes when signatures match", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(
      join(tempDir, "src", "utils.ts"),
      "export function process(data: string): boolean { return true; }"
    );
    writeFileSync(
      join(tempDir, "src", "api.ts"),
      "export function process(data: string): boolean { return false; }"
    );
    try {
      const priorTask = createTask({
        id: "T01",
        key_files: ["src/utils.ts"]
      });
      const currentTask = createTask({
        id: "T02",
        key_files: ["src/api.ts"]
      });
      const results = checkCrossTaskSignatures(currentTask, [priorTask], tempDir);
      assert.deepEqual(results, []);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("warns on parameter mismatch (non-blocking)", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(
      join(tempDir, "src", "utils.ts"),
      "export function save(name: string): void {}"
    );
    writeFileSync(
      join(tempDir, "src", "api.ts"),
      "export function save(name: string, id: number): void {}"
    );
    try {
      const priorTask = createTask({
        id: "T01",
        key_files: ["src/utils.ts"]
      });
      const currentTask = createTask({
        id: "T02",
        key_files: ["src/api.ts"]
      });
      const results = checkCrossTaskSignatures(currentTask, [priorTask], tempDir);
      assert.equal(results.length, 1);
      assert.equal(results[0].category, "signature");
      assert.equal(results[0].target, "save");
      assert.equal(results[0].passed, false);
      assert.equal(results[0].blocking, false);
      assert.ok(results[0].message.includes("parameters"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("warns on return type mismatch (non-blocking)", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(
      join(tempDir, "src", "utils.ts"),
      "export function fetch(): string { return ''; }"
    );
    writeFileSync(
      join(tempDir, "src", "api.ts"),
      "export function fetch(): number { return 0; }"
    );
    try {
      const priorTask = createTask({
        id: "T01",
        key_files: ["src/utils.ts"]
      });
      const currentTask = createTask({
        id: "T02",
        key_files: ["src/api.ts"]
      });
      const results = checkCrossTaskSignatures(currentTask, [priorTask], tempDir);
      assert.equal(results.length, 1);
      assert.ok(results[0].message.includes("return"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("handles multiple prior tasks", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(
      join(tempDir, "src", "types.ts"),
      "export function parse(s: string): object { return {}; }"
    );
    writeFileSync(
      join(tempDir, "src", "utils.ts"),
      "export function validate(x: object): boolean { return true; }"
    );
    writeFileSync(
      join(tempDir, "src", "api.ts"),
      `export function parse(s: number): object { return {}; }
       export function validate(x: object): boolean { return true; }`
    );
    try {
      const priorTask1 = createTask({ id: "T01", key_files: ["src/types.ts"] });
      const priorTask2 = createTask({ id: "T02", key_files: ["src/utils.ts"] });
      const currentTask = createTask({ id: "T03", key_files: ["src/api.ts"] });
      const results = checkCrossTaskSignatures(
        currentTask,
        [priorTask1, priorTask2],
        tempDir
      );
      assert.equal(results.length, 1);
      assert.ok(results[0].message.includes("parse"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
describe("checkPatternConsistency", () => {
  let tempDir;
  test("passes when async style is consistent (await only)", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(
      join(tempDir, "api.ts"),
      `async function getData(): Promise<string> {
        const result = await fetch('/api');
        return await result.text();
      }`
    );
    try {
      const task = createTask({ id: "T01", key_files: ["api.ts"] });
      const results = checkPatternConsistency(task, [], tempDir);
      const asyncResults = results.filter((r) => r.message.includes("async"));
      assert.equal(asyncResults.length, 0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("passes when async style is consistent (.then only)", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(
      join(tempDir, "api.ts"),
      `function getData(): Promise<string> {
        return fetch('/api').then(r => r.text());
      }`
    );
    try {
      const task = createTask({ id: "T01", key_files: ["api.ts"] });
      const results = checkPatternConsistency(task, [], tempDir);
      const asyncResults = results.filter((r) => r.message.includes("async"));
      assert.equal(asyncResults.length, 0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("warns when mixing async/await with .then()", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(
      join(tempDir, "api.ts"),
      `async function getData(): Promise<string> {
        const result = await fetch('/api');
        return result.text().then(t => t.toUpperCase());
      }`
    );
    try {
      const task = createTask({ id: "T01", key_files: ["api.ts"] });
      const results = checkPatternConsistency(task, [], tempDir);
      const asyncResults = results.filter((r) => r.message.includes("async"));
      assert.equal(asyncResults.length, 1);
      assert.equal(asyncResults[0].category, "pattern");
      assert.equal(asyncResults[0].passed, true);
      assert.equal(asyncResults[0].blocking, false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("passes when naming is consistent (camelCase only)", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(
      join(tempDir, "api.ts"),
      `function getUserData() {}
       const processItems = () => {};
       function validateInput() {}`
    );
    try {
      const task = createTask({ id: "T01", key_files: ["api.ts"] });
      const results = checkPatternConsistency(task, [], tempDir);
      const namingResults = results.filter((r) => r.message.includes("naming") || r.message.includes("Case"));
      assert.equal(namingResults.length, 0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("warns when mixing camelCase and snake_case", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(
      join(tempDir, "api.ts"),
      `function getUserData() {}
       function process_items() {}
       const validate_input = () => {};`
    );
    try {
      const task = createTask({ id: "T01", key_files: ["api.ts"] });
      const results = checkPatternConsistency(task, [], tempDir);
      const namingResults = results.filter((r) => r.message.includes("camelCase") || r.message.includes("snake_case"));
      assert.equal(namingResults.length, 1);
      assert.equal(namingResults[0].category, "pattern");
      assert.equal(namingResults[0].blocking, false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("skips non-JS/TS files", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, "config.json"), '{"key": "value"}');
    try {
      const task = createTask({ id: "T01", key_files: ["config.json"] });
      const results = checkPatternConsistency(task, [], tempDir);
      assert.deepEqual(results, []);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
describe("runPostExecutionChecks", () => {
  let tempDir;
  test("returns pass status when all checks pass", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src", "utils.ts"), "export const a = 1;");
    writeFileSync(
      join(tempDir, "src", "main.ts"),
      `import { a } from './utils';
       function processData(): void {}`
    );
    try {
      const task = createTask({ id: "T01", key_files: ["src/main.ts"] });
      const result = runPostExecutionChecks(task, [], tempDir);
      assert.equal(result.status, "pass");
      assert.equal(result.checks.length, 0);
      assert.ok(result.durationMs >= 0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("does not fail on import-looking strings in task key files", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "tests"), { recursive: true });
    writeFileSync(join(tempDir, "tests", "real-thing.ts"), "export default true;");
    writeFileSync(
      join(tempDir, "tests", "source-verifier.test.ts"),
      `
const rewritten = source.replace(
  'import { normalizeZagrebBusinessDeadline } from "./cutoff";',
  'const helper = true;'
);

import realThing from "./real-thing";
assert.ok(realThing);
`
    );
    try {
      const task = createTask({
        id: "T03",
        key_files: ["tests/source-verifier.test.ts"]
      });
      const result = runPostExecutionChecks(task, [], tempDir);
      assert.equal(result.status, "pass");
      assert.deepEqual(result.checks, []);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("returns fail status when blocking failure exists", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(
      join(tempDir, "src", "main.ts"),
      "import { a } from './nonexistent';"
    );
    try {
      const task = createTask({ id: "T01", key_files: ["src/main.ts"] });
      const result = runPostExecutionChecks(task, [], tempDir);
      assert.equal(result.status, "fail");
      assert.ok(result.checks.length > 0);
      assert.ok(result.checks.some((c) => c.blocking === true));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("returns warn status for non-blocking issues only", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(
      join(tempDir, "src", "api.ts"),
      `async function getData() {
        const result = await fetch('/api');
        return result.text().then(t => t);
      }`
    );
    try {
      const task = createTask({ id: "T01", key_files: ["src/api.ts"] });
      const result = runPostExecutionChecks(task, [], tempDir);
      assert.equal(result.status, "warn");
      assert.ok(result.checks.some((c) => c.category === "pattern"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("combines results from all check types", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(
      join(tempDir, "src", "utils.ts"),
      "export function process(s: string): void {}"
    );
    writeFileSync(
      join(tempDir, "src", "api.ts"),
      `import { x } from './missing';
       async function getData() {
         await fetch('/api');
         return fetch('/api2').then(r => r);
       }
       export function process(n: number): void {}`
    );
    try {
      const priorTask = createTask({ id: "T01", key_files: ["src/utils.ts"] });
      const currentTask = createTask({ id: "T02", key_files: ["src/api.ts"] });
      const result = runPostExecutionChecks(currentTask, [priorTask], tempDir);
      assert.equal(result.status, "fail");
      const categories = new Set(result.checks.map((c) => c.category));
      assert.ok(categories.has("import"));
      assert.ok(categories.has("signature"));
      assert.ok(categories.has("pattern"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("reports duration in milliseconds", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    try {
      const task = createTask({ id: "T01", key_files: [] });
      const result = runPostExecutionChecks(task, [], tempDir);
      assert.ok(typeof result.durationMs === "number");
      assert.ok(result.durationMs >= 0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("handles empty key_files array", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    try {
      const task = createTask({ id: "T01", key_files: [] });
      const result = runPostExecutionChecks(task, [], tempDir);
      assert.equal(result.status, "pass");
      assert.deepEqual(result.checks, []);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
describe("PostExecutionResult type", () => {
  test("status is one of pass, warn, fail", () => {
    const tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    try {
      const task = createTask({ id: "T01", key_files: [] });
      const result = runPostExecutionChecks(task, [], tempDir);
      assert.ok(["pass", "warn", "fail"].includes(result.status));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("checks array matches PostExecutionCheckJSON schema", () => {
    const tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(
      join(tempDir, "src", "main.ts"),
      "import { a } from './missing';"
    );
    try {
      const task = createTask({ id: "T01", key_files: ["src/main.ts"] });
      const result = runPostExecutionChecks(task, [], tempDir);
      for (const check of result.checks) {
        assert.ok(
          ["import", "signature", "pattern"].includes(check.category),
          `Invalid category: ${check.category}`
        );
        assert.ok(typeof check.target === "string");
        assert.ok(typeof check.passed === "boolean");
        assert.ok(typeof check.message === "string");
        if (check.blocking !== void 0) {
          assert.ok(typeof check.blocking === "boolean");
        }
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wb3N0LWV4ZWN1dGlvbi1jaGVja3MudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBwb3N0LWV4ZWN1dGlvbi1jaGVja3MudGVzdC50cyBcdTIwMTQgVW5pdCB0ZXN0cyBmb3IgcG9zdC1leGVjdXRpb24gdmFsaWRhdGlvbiBjaGVja3MuXG4gKlxuICogVGVzdHMgYWxsIDMgY2hlY2sgdHlwZXM6XG4gKiAgIDEuIEltcG9ydCByZXNvbHV0aW9uIFx1MjAxNCB2ZXJpZnkgcmVsYXRpdmUgaW1wb3J0cyByZXNvbHZlIHRvIGV4aXN0aW5nIGZpbGVzXG4gKiAgIDIuIENyb3NzLXRhc2sgc2lnbmF0dXJlcyBcdTIwMTQgZGV0ZWN0IHNpZ25hdHVyZSBkcmlmdCBhbmQgaGFsbHVjaW5hdGlvbiBjYXNjYWRlc1xuICogICAzLiBQYXR0ZXJuIGNvbnNpc3RlbmN5IFx1MjAxNCBhc3luYyBzdHlsZSBkcmlmdCwgbmFtaW5nIGNvbnZlbnRpb24gd2FybmluZ3NcbiAqL1xuXG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IG1rZGlyU3luYywgbWtkdGVtcFN5bmMsIHdyaXRlRmlsZVN5bmMsIHJtU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuXG5pbXBvcnQge1xuICBleHRyYWN0UmVsYXRpdmVJbXBvcnRzLFxuICByZXNvbHZlSW1wb3J0UGF0aCxcbiAgY2hlY2tJbXBvcnRSZXNvbHV0aW9uLFxuICBjaGVja0Nyb3NzVGFza1NpZ25hdHVyZXMsXG4gIGNoZWNrUGF0dGVybkNvbnNpc3RlbmN5LFxuICBydW5Qb3N0RXhlY3V0aW9uQ2hlY2tzLFxuICB0eXBlIFBvc3RFeGVjdXRpb25SZXN1bHQsXG59IGZyb20gXCIuLi9wb3N0LWV4ZWN1dGlvbi1jaGVja3MudHNcIjtcbmltcG9ydCB0eXBlIHsgVGFza1JvdyB9IGZyb20gXCIuLi9nc2QtZGIudHNcIjtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRlc3QgRml4dHVyZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogQ3JlYXRlIGEgbWluaW1hbCBUYXNrUm93IGZvciB0ZXN0aW5nLlxuICovXG5mdW5jdGlvbiBjcmVhdGVUYXNrKG92ZXJyaWRlczogUGFydGlhbDxUYXNrUm93PiA9IHt9KTogVGFza1JvdyB7XG4gIHJldHVybiB7XG4gICAgbWlsZXN0b25lX2lkOiBcIk0wMDFcIixcbiAgICBzbGljZV9pZDogXCJTMDFcIixcbiAgICBpZDogb3ZlcnJpZGVzLmlkID8/IFwiVDAxXCIsXG4gICAgdGl0bGU6IFwiVGVzdCBUYXNrXCIsXG4gICAgc3RhdHVzOiBcImNvbXBsZXRlXCIsXG4gICAgb25lX2xpbmVyOiBcIlwiLFxuICAgIG5hcnJhdGl2ZTogXCJcIixcbiAgICB2ZXJpZmljYXRpb25fcmVzdWx0OiBcIlwiLFxuICAgIGR1cmF0aW9uOiBcIlwiLFxuICAgIGNvbXBsZXRlZF9hdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgIGJsb2NrZXJfZGlzY292ZXJlZDogZmFsc2UsXG4gICAgZGV2aWF0aW9uczogXCJcIixcbiAgICBrbm93bl9pc3N1ZXM6IFwiXCIsXG4gICAga2V5X2ZpbGVzOiBvdmVycmlkZXMua2V5X2ZpbGVzID8/IFtdLFxuICAgIGtleV9kZWNpc2lvbnM6IFtdLFxuICAgIGZ1bGxfc3VtbWFyeV9tZDogXCJcIixcbiAgICBkZXNjcmlwdGlvbjogb3ZlcnJpZGVzLmRlc2NyaXB0aW9uID8/IFwiXCIsXG4gICAgZXN0aW1hdGU6IFwiXCIsXG4gICAgZmlsZXM6IG92ZXJyaWRlcy5maWxlcyA/PyBbXSxcbiAgICB2ZXJpZnk6IFwiXCIsXG4gICAgaW5wdXRzOiBvdmVycmlkZXMuaW5wdXRzID8/IFtdLFxuICAgIGV4cGVjdGVkX291dHB1dDogb3ZlcnJpZGVzLmV4cGVjdGVkX291dHB1dCA/PyBbXSxcbiAgICBvYnNlcnZhYmlsaXR5X2ltcGFjdDogXCJcIixcbiAgICBmdWxsX3BsYW5fbWQ6IFwiXCIsXG4gICAgc2VxdWVuY2U6IG92ZXJyaWRlcy5zZXF1ZW5jZSA/PyAwLFxuICAgIGJsb2NrZXJfc291cmNlOiBcIlwiLFxuICAgIGVzY2FsYXRpb25fcGVuZGluZzogMCxcbiAgICBlc2NhbGF0aW9uX2F3YWl0aW5nX3JldmlldzogMCxcbiAgICBlc2NhbGF0aW9uX2FydGlmYWN0X3BhdGg6IG51bGwsXG4gICAgZXNjYWxhdGlvbl9vdmVycmlkZV9hcHBsaWVkX2F0OiBudWxsLFxuICAgIC4uLm92ZXJyaWRlcyxcbiAgfTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEltcG9ydCBFeHRyYWN0aW9uIFRlc3RzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcImV4dHJhY3RSZWxhdGl2ZUltcG9ydHNcIiwgKCkgPT4ge1xuICB0ZXN0KFwiZXh0cmFjdHMgaW1wb3J0IC4uLiBmcm9tIHN0YXRlbWVudHNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHNvdXJjZSA9IGBcbmltcG9ydCB7IGZvbyB9IGZyb20gJy4vdXRpbHMnO1xuaW1wb3J0IGJhciBmcm9tIFwiLi4vaGVscGVycy9iYXJcIjtcbiAgICBgO1xuICAgIGNvbnN0IGltcG9ydHMgPSBleHRyYWN0UmVsYXRpdmVJbXBvcnRzKHNvdXJjZSk7XG4gICAgYXNzZXJ0LmVxdWFsKGltcG9ydHMubGVuZ3RoLCAyKTtcbiAgICBhc3NlcnQub2soaW1wb3J0cy5zb21lKChpKSA9PiBpLmltcG9ydFBhdGggPT09IFwiLi91dGlsc1wiKSk7XG4gICAgYXNzZXJ0Lm9rKGltcG9ydHMuc29tZSgoaSkgPT4gaS5pbXBvcnRQYXRoID09PSBcIi4uL2hlbHBlcnMvYmFyXCIpKTtcbiAgfSk7XG5cbiAgdGVzdChcImV4dHJhY3RzIHNpZGUtZWZmZWN0IGltcG9ydHNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHNvdXJjZSA9IGBpbXBvcnQgJy4vcG9seWZpbGwnO2A7XG4gICAgY29uc3QgaW1wb3J0cyA9IGV4dHJhY3RSZWxhdGl2ZUltcG9ydHMoc291cmNlKTtcbiAgICBhc3NlcnQuZXF1YWwoaW1wb3J0cy5sZW5ndGgsIDEpO1xuICAgIGFzc2VydC5lcXVhbChpbXBvcnRzWzBdLmltcG9ydFBhdGgsIFwiLi9wb2x5ZmlsbFwiKTtcbiAgfSk7XG5cbiAgdGVzdChcImV4dHJhY3RzIHJlcXVpcmUgc3RhdGVtZW50c1wiLCAoKSA9PiB7XG4gICAgY29uc3Qgc291cmNlID0gYFxuY29uc3QgdXRpbHMgPSByZXF1aXJlKCcuL3V0aWxzJyk7XG5jb25zdCB7IGJhciB9ID0gcmVxdWlyZShcIi4uL2hlbHBlcnMvYmFyXCIpO1xuICAgIGA7XG4gICAgY29uc3QgaW1wb3J0cyA9IGV4dHJhY3RSZWxhdGl2ZUltcG9ydHMoc291cmNlKTtcbiAgICBhc3NlcnQuZXF1YWwoaW1wb3J0cy5sZW5ndGgsIDIpO1xuICAgIGFzc2VydC5vayhpbXBvcnRzLnNvbWUoKGkpID0+IGkuaW1wb3J0UGF0aCA9PT0gXCIuL3V0aWxzXCIpKTtcbiAgICBhc3NlcnQub2soaW1wb3J0cy5zb21lKChpKSA9PiBpLmltcG9ydFBhdGggPT09IFwiLi4vaGVscGVycy9iYXJcIikpO1xuICB9KTtcblxuICB0ZXN0KFwiaWdub3JlcyBub24tcmVsYXRpdmUgaW1wb3J0c1wiLCAoKSA9PiB7XG4gICAgY29uc3Qgc291cmNlID0gYFxuaW1wb3J0IGV4cHJlc3MgZnJvbSAnZXhwcmVzcyc7XG5pbXBvcnQgeyByZWFkRmlsZSB9IGZyb20gJ25vZGU6ZnMnO1xuY29uc3QgbG9kYXNoID0gcmVxdWlyZSgnbG9kYXNoJyk7XG4gICAgYDtcbiAgICBjb25zdCBpbXBvcnRzID0gZXh0cmFjdFJlbGF0aXZlSW1wb3J0cyhzb3VyY2UpO1xuICAgIGFzc2VydC5lcXVhbChpbXBvcnRzLmxlbmd0aCwgMCk7XG4gIH0pO1xuXG4gIHRlc3QoXCJyZXBvcnRzIGNvcnJlY3QgbGluZSBudW1iZXJzXCIsICgpID0+IHtcbiAgICBjb25zdCBzb3VyY2UgPSBgLy8gY29tbWVudFxuaW1wb3J0IHsgYSB9IGZyb20gJy4vYSc7XG4vLyBhbm90aGVyIGNvbW1lbnRcbmltcG9ydCB7IGIgfSBmcm9tICcuL2InO1xuYDtcbiAgICBjb25zdCBpbXBvcnRzID0gZXh0cmFjdFJlbGF0aXZlSW1wb3J0cyhzb3VyY2UpO1xuICAgIGFzc2VydC5lcXVhbChpbXBvcnRzLmxlbmd0aCwgMik7XG4gICAgY29uc3QgaW1wb3J0QSA9IGltcG9ydHMuZmluZCgoaSkgPT4gaS5pbXBvcnRQYXRoID09PSBcIi4vYVwiKTtcbiAgICBjb25zdCBpbXBvcnRCID0gaW1wb3J0cy5maW5kKChpKSA9PiBpLmltcG9ydFBhdGggPT09IFwiLi9iXCIpO1xuICAgIGFzc2VydC5lcXVhbChpbXBvcnRBPy5saW5lTnVtLCAyKTtcbiAgICBhc3NlcnQuZXF1YWwoaW1wb3J0Qj8ubGluZU51bSwgNCk7XG4gIH0pO1xuXG4gIHRlc3QoXCJoYW5kbGVzIG11bHRpcGxlIGltcG9ydHMgb24gc2FtZSBsaW5lXCIsICgpID0+IHtcbiAgICBjb25zdCBzb3VyY2UgPSBgaW1wb3J0IGEgZnJvbSAnLi9hJzsgaW1wb3J0IGIgZnJvbSAnLi9iJztgO1xuICAgIGNvbnN0IGltcG9ydHMgPSBleHRyYWN0UmVsYXRpdmVJbXBvcnRzKHNvdXJjZSk7XG4gICAgYXNzZXJ0LmVxdWFsKGltcG9ydHMubGVuZ3RoLCAyKTtcbiAgfSk7XG5cbiAgdGVzdChcImlnbm9yZXMgaW1wb3J0LWxvb2tpbmcgc3RyaW5nIGxpdGVyYWxzIGluIHRlc3QgZml4dHVyZXNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHNvdXJjZSA9IGBcbmNvbnN0IHJld3JpdHRlbiA9IHNvdXJjZS5yZXBsYWNlKFxuICAnaW1wb3J0IHsgbm9ybWFsaXplWmFncmViQnVzaW5lc3NEZWFkbGluZSB9IGZyb20gXCIuL2N1dG9mZlwiOycsXG4gICdjb25zdCBoZWxwZXIgPSB0cnVlOydcbik7XG5cbmltcG9ydCByZWFsVGhpbmcgZnJvbSBcIi4vcmVhbC10aGluZ1wiO1xuYDtcbiAgICBjb25zdCBpbXBvcnRzID0gZXh0cmFjdFJlbGF0aXZlSW1wb3J0cyhzb3VyY2UpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwoaW1wb3J0cywgW1xuICAgICAgeyBpbXBvcnRQYXRoOiBcIi4vcmVhbC10aGluZ1wiLCBsaW5lTnVtOiA3IH0sXG4gICAgXSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJpZ25vcmVzIGltcG9ydC1sb29raW5nIGxpbmVzIGluc2lkZSB0ZW1wbGF0ZSBsaXRlcmFsc1wiLCAoKSA9PiB7XG4gICAgY29uc3Qgc291cmNlID0gW1xuICAgICAgXCJjb25zdCBmaXh0dXJlID0gYFwiLFxuICAgICAgXCJpbXBvcnQgbWlzc2luZ1RoaW5nIGZyb20gJy4vbWlzc2luZy10aGluZyc7XCIsXG4gICAgICBcImA7XCIsXG4gICAgICBcIlwiLFxuICAgICAgXCJpbXBvcnQgcmVhbFRoaW5nIGZyb20gJy4vcmVhbC10aGluZyc7XCIsXG4gICAgXS5qb2luKFwiXFxuXCIpO1xuICAgIGNvbnN0IGltcG9ydHMgPSBleHRyYWN0UmVsYXRpdmVJbXBvcnRzKHNvdXJjZSk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChpbXBvcnRzLCBbXG4gICAgICB7IGltcG9ydFBhdGg6IFwiLi9yZWFsLXRoaW5nXCIsIGxpbmVOdW06IDUgfSxcbiAgICBdKTtcbiAgfSk7XG5cbiAgdGVzdChcImlnbm9yZXMgcmVxdWlyZSgpIGluc2lkZSBzdHJpbmcgbGl0ZXJhbHNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHNvdXJjZSA9IFtcbiAgICAgICdjb25zdCBmaXh0dXJlID0gXCJjb25zdCB4ID0gcmVxdWlyZShcXCcuL21pc3NpbmdcXCcpO1wiOycsXG4gICAgICBcImNvbnN0IG90aGVyRml4dHVyZSA9ICdjb25zdCB5ID0gcmVxdWlyZShcXFwiLi9hbHNvLW1pc3NpbmdcXFwiKTsnO1wiLFxuICAgICAgXCJjb25zdCByZWFsID0gcmVxdWlyZSgnLi9yZWFsJyk7XCIsXG4gICAgXS5qb2luKFwiXFxuXCIpO1xuICAgIGNvbnN0IGltcG9ydHMgPSBleHRyYWN0UmVsYXRpdmVJbXBvcnRzKHNvdXJjZSk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChpbXBvcnRzLCBbXG4gICAgICB7IGltcG9ydFBhdGg6IFwiLi9yZWFsXCIsIGxpbmVOdW06IDMgfSxcbiAgICBdKTtcbiAgfSk7XG5cbiAgdGVzdChcImlnbm9yZXMgcmVxdWlyZSgpIGluc2lkZSB0ZW1wbGF0ZSBsaXRlcmFsc1wiLCAoKSA9PiB7XG4gICAgY29uc3Qgc291cmNlID0gW1xuICAgICAgXCJjb25zdCBmaXh0dXJlID0gYFwiLFxuICAgICAgXCJjb25zdCB4ID0gcmVxdWlyZSgnLi9taXNzaW5nJyk7XCIsXG4gICAgICBcImA7XCIsXG4gICAgICBcIlwiLFxuICAgICAgXCJjb25zdCByZWFsID0gcmVxdWlyZSgnLi9yZWFsJyk7XCIsXG4gICAgXS5qb2luKFwiXFxuXCIpO1xuICAgIGNvbnN0IGltcG9ydHMgPSBleHRyYWN0UmVsYXRpdmVJbXBvcnRzKHNvdXJjZSk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChpbXBvcnRzLCBbXG4gICAgICB7IGltcG9ydFBhdGg6IFwiLi9yZWFsXCIsIGxpbmVOdW06IDUgfSxcbiAgICBdKTtcbiAgfSk7XG5cbiAgdGVzdChcImhhbmRsZXMgZW1wdHkgc291cmNlXCIsICgpID0+IHtcbiAgICBjb25zdCBpbXBvcnRzID0gZXh0cmFjdFJlbGF0aXZlSW1wb3J0cyhcIlwiKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKGltcG9ydHMsIFtdKTtcbiAgfSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEltcG9ydCBSZXNvbHV0aW9uIFRlc3RzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcInJlc29sdmVJbXBvcnRQYXRoXCIsICgpID0+IHtcbiAgbGV0IHRlbXBEaXI6IHN0cmluZztcblxuICB0ZXN0KFwicmVzb2x2ZXMgZmlsZSB3aXRoIGV4YWN0IGV4dGVuc2lvblwiLCAoKSA9PiB7XG4gICAgdGVtcERpciA9IGpvaW4odG1wZGlyKCksIGBwb3N0LWV4ZWMtdGVzdC0ke0RhdGUubm93KCl9YCk7XG4gICAgbWtkaXJTeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIG1rZGlyU3luYyhqb2luKHRlbXBEaXIsIFwic3JjXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4odGVtcERpciwgXCJzcmNcIiwgXCJ1dGlscy50c1wiKSwgXCJleHBvcnQgY29uc3QgYSA9IDE7XCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbih0ZW1wRGlyLCBcInNyY1wiLCBcIm1haW4udHNcIiksIFwiaW1wb3J0IHsgYSB9IGZyb20gJy4vdXRpbHMnO1wiKTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCByZXN1bHQgPSByZXNvbHZlSW1wb3J0UGF0aChcIi4vdXRpbHNcIiwgXCJzcmMvbWFpbi50c1wiLCB0ZW1wRGlyKTtcbiAgICAgIGFzc2VydC5vayhyZXN1bHQuZXhpc3RzKTtcbiAgICAgIGFzc2VydC5vayhyZXN1bHQucmVzb2x2ZWRQYXRoPy5lbmRzV2l0aChcInV0aWxzLnRzXCIpKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJyZXNvbHZlcyBmaWxlIHdpdGhvdXQgZXh0ZW5zaW9uXCIsICgpID0+IHtcbiAgICB0ZW1wRGlyID0gam9pbih0bXBkaXIoKSwgYHBvc3QtZXhlYy10ZXN0LSR7RGF0ZS5ub3coKX1gKTtcbiAgICBta2RpclN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgbWtkaXJTeW5jKGpvaW4odGVtcERpciwgXCJzcmNcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbih0ZW1wRGlyLCBcInNyY1wiLCBcImhlbHBlcnMuanNcIiksIFwibW9kdWxlLmV4cG9ydHMgPSB7fTtcIik7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHRlbXBEaXIsIFwic3JjXCIsIFwiaW5kZXgudHNcIiksIFwiXCIpO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVJbXBvcnRQYXRoKFwiLi9oZWxwZXJzXCIsIFwic3JjL2luZGV4LnRzXCIsIHRlbXBEaXIpO1xuICAgICAgYXNzZXJ0Lm9rKHJlc3VsdC5leGlzdHMpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcInJlc29sdmVzIGRpcmVjdG9yeSBpbmRleCBmaWxlXCIsICgpID0+IHtcbiAgICB0ZW1wRGlyID0gam9pbih0bXBkaXIoKSwgYHBvc3QtZXhlYy10ZXN0LSR7RGF0ZS5ub3coKX1gKTtcbiAgICBta2RpclN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgbWtkaXJTeW5jKGpvaW4odGVtcERpciwgXCJzcmNcIiwgXCJ1dGlsc1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHRlbXBEaXIsIFwic3JjXCIsIFwidXRpbHNcIiwgXCJpbmRleC50c1wiKSwgXCJleHBvcnQge307XCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbih0ZW1wRGlyLCBcInNyY1wiLCBcIm1haW4udHNcIiksIFwiXCIpO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVJbXBvcnRQYXRoKFwiLi91dGlsc1wiLCBcInNyYy9tYWluLnRzXCIsIHRlbXBEaXIpO1xuICAgICAgYXNzZXJ0Lm9rKHJlc3VsdC5leGlzdHMpO1xuICAgICAgYXNzZXJ0Lm9rKHJlc3VsdC5yZXNvbHZlZFBhdGg/LmVuZHNXaXRoKFwiaW5kZXgudHNcIikpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcInJlc29sdmVzIHBhcmVudCBkaXJlY3RvcnkgaW1wb3J0c1wiLCAoKSA9PiB7XG4gICAgdGVtcERpciA9IGpvaW4odG1wZGlyKCksIGBwb3N0LWV4ZWMtdGVzdC0ke0RhdGUubm93KCl9YCk7XG4gICAgbWtkaXJTeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIG1rZGlyU3luYyhqb2luKHRlbXBEaXIsIFwic3JjXCIsIFwibmVzdGVkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4odGVtcERpciwgXCJzcmNcIiwgXCJ1dGlscy50c1wiKSwgXCJleHBvcnQge307XCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbih0ZW1wRGlyLCBcInNyY1wiLCBcIm5lc3RlZFwiLCBcImNoaWxkLnRzXCIpLCBcIlwiKTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCByZXN1bHQgPSByZXNvbHZlSW1wb3J0UGF0aChcIi4uL3V0aWxzXCIsIFwic3JjL25lc3RlZC9jaGlsZC50c1wiLCB0ZW1wRGlyKTtcbiAgICAgIGFzc2VydC5vayhyZXN1bHQuZXhpc3RzKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJmYWlscyBmb3Igbm9uLWV4aXN0ZW50IGZpbGVcIiwgKCkgPT4ge1xuICAgIHRlbXBEaXIgPSBqb2luKHRtcGRpcigpLCBgcG9zdC1leGVjLXRlc3QtJHtEYXRlLm5vdygpfWApO1xuICAgIG1rZGlyU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBta2RpclN5bmMoam9pbih0ZW1wRGlyLCBcInNyY1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHRlbXBEaXIsIFwic3JjXCIsIFwibWFpbi50c1wiKSwgXCJcIik7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVzdWx0ID0gcmVzb2x2ZUltcG9ydFBhdGgoXCIuL25vbmV4aXN0ZW50XCIsIFwic3JjL21haW4udHNcIiwgdGVtcERpcik7XG4gICAgICBhc3NlcnQub2soIXJlc3VsdC5leGlzdHMpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5yZXNvbHZlZFBhdGgsIG51bGwpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcImhhbmRsZXMgZXhwbGljaXQgZXh0ZW5zaW9uIGluIGltcG9ydFwiLCAoKSA9PiB7XG4gICAgdGVtcERpciA9IGpvaW4odG1wZGlyKCksIGBwb3N0LWV4ZWMtdGVzdC0ke0RhdGUubm93KCl9YCk7XG4gICAgbWtkaXJTeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIG1rZGlyU3luYyhqb2luKHRlbXBEaXIsIFwic3JjXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4odGVtcERpciwgXCJzcmNcIiwgXCJkYXRhLmpzb25cIiksIFwie31cIik7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHRlbXBEaXIsIFwic3JjXCIsIFwibWFpbi50c1wiKSwgXCJcIik7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVzdWx0ID0gcmVzb2x2ZUltcG9ydFBhdGgoXCIuL2RhdGEuanNvblwiLCBcInNyYy9tYWluLnRzXCIsIHRlbXBEaXIpO1xuICAgICAgYXNzZXJ0Lm9rKHJlc3VsdC5leGlzdHMpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gUmVncmVzc2lvbjogaXNzdWUgIzQ0MTEgXHUyMDE0IHNpZGUtZWZmZWN0IGFzc2V0IGltcG9ydHMgKENTUy9TQ1NTL2ltYWdlcy9mb250cylcbiAgLy8gd2VyZSBtaXNjbGFzc2lmaWVkIGFzIHVucmVzb2x2ZWQgYmVjYXVzZSBvbmx5IGNvZGUgZXh0ZW5zaW9ucyB3ZXJlIHRyaWVkLlxuICB0ZXN0KFwicmVzb2x2ZXMgc2lkZS1lZmZlY3QgQ1NTIGltcG9ydCB3aXRoIGV4cGxpY2l0IGV4dGVuc2lvblwiLCAodCkgPT4ge1xuICAgIGNvbnN0IGRpciA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwicG9zdC1leGVjLXRlc3QtY3NzLVwiKSk7XG4gICAgdC5hZnRlcigoKSA9PiBybVN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuICAgIC8vIGZyb250ZW5kL3NyYy9yb3V0ZXMvcm9vdC50c3ggaW1wb3J0cyAnLi4vLi4vc3R5bGVzL2dsb2JhbHMuY3NzJyBcdTIxOTJcbiAgICAvLyByZXNvbHZlcyB0byBmcm9udGVuZC9zdHlsZXMvZ2xvYmFscy5jc3MuXG4gICAgbWtkaXJTeW5jKGpvaW4oZGlyLCBcImZyb250ZW5kXCIsIFwic3JjXCIsIFwicm91dGVzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBta2RpclN5bmMoam9pbihkaXIsIFwiZnJvbnRlbmRcIiwgXCJzdHlsZXNcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiZnJvbnRlbmRcIiwgXCJzdHlsZXNcIiwgXCJnbG9iYWxzLmNzc1wiKSwgXCJcIik7XG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4oZGlyLCBcImZyb250ZW5kXCIsIFwic3JjXCIsIFwicm91dGVzXCIsIFwicm9vdC50c3hcIiksXG4gICAgICBcImltcG9ydCAnLi4vLi4vc3R5bGVzL2dsb2JhbHMuY3NzJztcIlxuICAgICk7XG5cbiAgICBjb25zdCByZXN1bHQgPSByZXNvbHZlSW1wb3J0UGF0aChcbiAgICAgIFwiLi4vLi4vc3R5bGVzL2dsb2JhbHMuY3NzXCIsXG4gICAgICBcImZyb250ZW5kL3NyYy9yb3V0ZXMvcm9vdC50c3hcIixcbiAgICAgIGRpclxuICAgICk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5leGlzdHMsIFwiQ1NTIHNpZGUtZWZmZWN0IGltcG9ydCBzaG91bGQgcmVzb2x2ZVwiKTtcbiAgICBhc3NlcnQub2socmVzdWx0LnJlc29sdmVkUGF0aD8uZW5kc1dpdGgoXCJnbG9iYWxzLmNzc1wiKSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJyZXNvbHZlcyBTQ1NTIGFzc2V0IGltcG9ydFwiLCAodCkgPT4ge1xuICAgIGNvbnN0IGRpciA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwicG9zdC1leGVjLXRlc3Qtc2Nzcy1cIikpO1xuICAgIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcbiAgICBta2RpclN5bmMoam9pbihkaXIsIFwic3JjXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcInNyY1wiLCBcInRoZW1lLnNjc3NcIiksIFwiXCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwic3JjXCIsIFwibWFpbi50c1wiKSwgXCJcIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSByZXNvbHZlSW1wb3J0UGF0aChcIi4vdGhlbWUuc2Nzc1wiLCBcInNyYy9tYWluLnRzXCIsIGRpcik7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5leGlzdHMpO1xuICB9KTtcblxuICB0ZXN0KFwic3RpbGwgZmFpbHMgZm9yIG1pc3NpbmcgYXNzZXQgaW1wb3J0XCIsICh0KSA9PiB7XG4gICAgY29uc3QgZGlyID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJwb3N0LWV4ZWMtdGVzdC1taXNzaW5nLVwiKSk7XG4gICAgdC5hZnRlcigoKSA9PiBybVN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuICAgIG1rZGlyU3luYyhqb2luKGRpciwgXCJzcmNcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwic3JjXCIsIFwibWFpbi50c1wiKSwgXCJcIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSByZXNvbHZlSW1wb3J0UGF0aChcIi4vbWlzc2luZy5jc3NcIiwgXCJzcmMvbWFpbi50c1wiLCBkaXIpO1xuICAgIGFzc2VydC5vayghcmVzdWx0LmV4aXN0cyk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5yZXNvbHZlZFBhdGgsIG51bGwpO1xuICB9KTtcblxuICAvLyBQaW4gVFMgRVNNIGNvbnZlbnRpb246IGV4cGxpY2l0IC5qcyBpbXBvcnQgbXVzdCBzdGlsbCByZXNvbHZlIHRvIHRoZVxuICAvLyBzaWJsaW5nIC50cyBmaWxlIHdoZW4gb25seSB0aGUgLnRzIGV4aXN0cy5cbiAgdGVzdChcInJlc29sdmVzIC5qcyBpbXBvcnQgdG8gc2libGluZyAudHMgKFRTIEVTTSBjb252ZW50aW9uKVwiLCAodCkgPT4ge1xuICAgIGNvbnN0IGRpciA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwicG9zdC1leGVjLXRlc3QtdHNlc20tXCIpKTtcbiAgICB0LmFmdGVyKCgpID0+IHJtU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG4gICAgbWtkaXJTeW5jKGpvaW4oZGlyLCBcInNyY1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJzcmNcIiwgXCJ0eXBlcy50c1wiKSwgXCJleHBvcnQge307XCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwic3JjXCIsIFwibWFpbi50c1wiKSwgXCJcIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSByZXNvbHZlSW1wb3J0UGF0aChcIi4vdHlwZXMuanNcIiwgXCJzcmMvbWFpbi50c1wiLCBkaXIpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuZXhpc3RzKTtcbiAgICBhc3NlcnQub2socmVzdWx0LnJlc29sdmVkUGF0aD8uZW5kc1dpdGgoXCJ0eXBlcy50c1wiKSk7XG4gIH0pO1xuXG4gIC8vIE5vbi1jb2RlIGV4cGxpY2l0IGV4dGVuc2lvbnMgbXVzdCBub3QgZmFsbCB0aHJvdWdoIHRvIGNvZGUtZXh0ZW5zaW9uXG4gIC8vIHNoYWRvd3M6IGEgbWlzc2luZyAuL21pc3NpbmcuY3NzIG11c3Qgc3RheSB1bnJlc29sdmVkIGV2ZW4gaWYgYSBzdHJheVxuICAvLyAuL21pc3NpbmcuY3NzLnRzIGhhcHBlbnMgdG8gZXhpc3QuXG4gIHRlc3QoXCJtaXNzaW5nIGFzc2V0IGltcG9ydCBkb2VzIG5vdCBtYXRjaCBjb2RlLWV4dGVuc2lvbiBzaGFkb3dcIiwgKHQpID0+IHtcbiAgICBjb25zdCBkaXIgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcInBvc3QtZXhlYy10ZXN0LXNoYWRvdy1cIikpO1xuICAgIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcbiAgICBta2RpclN5bmMoam9pbihkaXIsIFwic3JjXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcInNyY1wiLCBcIm1pc3NpbmcuY3NzLnRzXCIpLCBcImV4cG9ydCB7fTtcIik7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJzcmNcIiwgXCJtYWluLnRzXCIpLCBcIlwiKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVJbXBvcnRQYXRoKFwiLi9taXNzaW5nLmNzc1wiLCBcInNyYy9tYWluLnRzXCIsIGRpcik7XG4gICAgYXNzZXJ0Lm9rKCFyZXN1bHQuZXhpc3RzKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnJlc29sdmVkUGF0aCwgbnVsbCk7XG4gIH0pO1xuXG4gIHRlc3QoXCJyZXNvbHZlcyBkb3R0ZWQgVFMgbW9kdWxlIHN0ZW0gbGlrZSAuc2VydmVyIHZpYSBleHRlbnNpb24gcHJvYmluZ1wiLCAodCkgPT4ge1xuICAgIGNvbnN0IGRpciA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwicG9zdC1leGVjLXRlc3Qtc2VydmVyLWRvdC1cIikpO1xuICAgIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcbiAgICBta2RpclN5bmMoam9pbihkaXIsIFwic3JjXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcInNyY1wiLCBcInJvdXRlLnNlcnZlci50c1wiKSwgXCJleHBvcnQge307XFxuXCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwic3JjXCIsIFwibWFpbi50c1wiKSwgXCJcIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSByZXNvbHZlSW1wb3J0UGF0aChcIi4vcm91dGUuc2VydmVyXCIsIFwic3JjL21haW4udHNcIiwgZGlyKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmV4aXN0cyk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5yZXNvbHZlZFBhdGg/LmVuZHNXaXRoKFwicm91dGUuc2VydmVyLnRzXCIpKTtcbiAgfSk7XG5cbiAgdGVzdChcIm1pc3NpbmcgdW5rbm93biBleHBsaWNpdCBleHRlbnNpb24gZG9lcyBub3QgbWF0Y2ggY29kZS1leHRlbnNpb24gc2hhZG93XCIsICh0KSA9PiB7XG4gICAgY29uc3QgZGlyID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJwb3N0LWV4ZWMtdGVzdC11bmtub3duLXNoYWRvdy1cIikpO1xuICAgIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcbiAgICBta2RpclN5bmMoam9pbihkaXIsIFwic3JjXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcInNyY1wiLCBcInZpZGVvLm1wNC50c1wiKSwgXCJleHBvcnQge307XFxuXCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwic3JjXCIsIFwibWFpbi50c1wiKSwgXCJcIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSByZXNvbHZlSW1wb3J0UGF0aChcIi4vdmlkZW8ubXA0XCIsIFwic3JjL21haW4udHNcIiwgZGlyKTtcbiAgICBhc3NlcnQub2soIXJlc3VsdC5leGlzdHMpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQucmVzb2x2ZWRQYXRoLCBudWxsKTtcbiAgfSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEltcG9ydCBSZXNvbHV0aW9uIENoZWNrIFRlc3RzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcImNoZWNrSW1wb3J0UmVzb2x1dGlvblwiLCAoKSA9PiB7XG4gIGxldCB0ZW1wRGlyOiBzdHJpbmc7XG5cbiAgdGVzdChcInBhc3NlcyB3aGVuIGFsbCBpbXBvcnRzIHJlc29sdmVcIiwgKCkgPT4ge1xuICAgIHRlbXBEaXIgPSBqb2luKHRtcGRpcigpLCBgcG9zdC1leGVjLXRlc3QtJHtEYXRlLm5vdygpfWApO1xuICAgIG1rZGlyU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBta2RpclN5bmMoam9pbih0ZW1wRGlyLCBcInNyY1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHRlbXBEaXIsIFwic3JjXCIsIFwidXRpbHMudHNcIiksIFwiZXhwb3J0IGNvbnN0IGEgPSAxO1wiKTtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbih0ZW1wRGlyLCBcInNyY1wiLCBcIm1haW4udHNcIiksXG4gICAgICBcImltcG9ydCB7IGEgfSBmcm9tICcuL3V0aWxzJztcIlxuICAgICk7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgdGFzayA9IGNyZWF0ZVRhc2soe1xuICAgICAgICBpZDogXCJUMDFcIixcbiAgICAgICAga2V5X2ZpbGVzOiBbXCJzcmMvbWFpbi50c1wiXSxcbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCByZXN1bHRzID0gY2hlY2tJbXBvcnRSZXNvbHV0aW9uKHRhc2ssIFtdLCB0ZW1wRGlyKTtcbiAgICAgIGFzc2VydC5kZWVwRXF1YWwocmVzdWx0cywgW10pO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcImlnbm9yZXMgZ2VuZXJhdGVkIFJlYWN0IFJvdXRlciArdHlwZXMgaW1wb3J0c1wiLCAoKSA9PiB7XG4gICAgdGVtcERpciA9IGpvaW4odG1wZGlyKCksIGBwb3N0LWV4ZWMtdGVzdC0ke0RhdGUubm93KCl9YCk7XG4gICAgbWtkaXJTeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIG1rZGlyU3luYyhqb2luKHRlbXBEaXIsIFwiYXBwXCIsIFwicm91dGVzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbih0ZW1wRGlyLCBcImFwcFwiLCBcInJvdXRlc1wiLCBcInJvb3QudHN4XCIpLFxuICAgICAgXCJpbXBvcnQgdHlwZSB7IFJvdXRlIH0gZnJvbSAnLi8rdHlwZXMvcm9vdCc7XFxuZXhwb3J0IGRlZmF1bHQgZnVuY3Rpb24gUm9vdCgpIHsgcmV0dXJuIG51bGw7IH1cIlxuICAgICk7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgdGFzayA9IGNyZWF0ZVRhc2soe1xuICAgICAgICBpZDogXCJUMDFcIixcbiAgICAgICAga2V5X2ZpbGVzOiBbXCJhcHAvcm91dGVzL3Jvb3QudHN4XCJdLFxuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IHJlc3VsdHMgPSBjaGVja0ltcG9ydFJlc29sdXRpb24odGFzaywgW10sIHRlbXBEaXIpO1xuICAgICAgYXNzZXJ0LmRlZXBFcXVhbChyZXN1bHRzLCBbXSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwiZmFpbHMgd2hlbiBpbXBvcnQgZG9lc24ndCByZXNvbHZlXCIsICgpID0+IHtcbiAgICB0ZW1wRGlyID0gam9pbih0bXBkaXIoKSwgYHBvc3QtZXhlYy10ZXN0LSR7RGF0ZS5ub3coKX1gKTtcbiAgICBta2RpclN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgbWtkaXJTeW5jKGpvaW4odGVtcERpciwgXCJzcmNcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKHRlbXBEaXIsIFwic3JjXCIsIFwibWFpbi50c1wiKSxcbiAgICAgIFwiaW1wb3J0IHsgYSB9IGZyb20gJy4vbm9uZXhpc3RlbnQnO1wiXG4gICAgKTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCB0YXNrID0gY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgICBrZXlfZmlsZXM6IFtcInNyYy9tYWluLnRzXCJdLFxuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IHJlc3VsdHMgPSBjaGVja0ltcG9ydFJlc29sdXRpb24odGFzaywgW10sIHRlbXBEaXIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHJlc3VsdHMubGVuZ3RoLCAxKTtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHRzWzBdLmNhdGVnb3J5LCBcImltcG9ydFwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHRzWzBdLnBhc3NlZCwgZmFsc2UpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHJlc3VsdHNbMF0uYmxvY2tpbmcsIHRydWUpO1xuICAgICAgYXNzZXJ0Lm9rKHJlc3VsdHNbMF0ubWVzc2FnZS5pbmNsdWRlcyhcIm5vbmV4aXN0ZW50XCIpKTtcbiAgICAgIGFzc2VydC5vayhyZXN1bHRzWzBdLnRhcmdldC5pbmNsdWRlcyhcInNyYy9tYWluLnRzXCIpKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJza2lwcyBub24tSlMvVFMgZmlsZXNcIiwgKCkgPT4ge1xuICAgIHRlbXBEaXIgPSBqb2luKHRtcGRpcigpLCBgcG9zdC1leGVjLXRlc3QtJHtEYXRlLm5vdygpfWApO1xuICAgIG1rZGlyU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4odGVtcERpciwgXCJSRUFETUUubWRcIiksIFwiIyBEb2NzXCIpO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHRhc2sgPSBjcmVhdGVUYXNrKHtcbiAgICAgICAgaWQ6IFwiVDAxXCIsXG4gICAgICAgIGtleV9maWxlczogW1wiUkVBRE1FLm1kXCJdLFxuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IHJlc3VsdHMgPSBjaGVja0ltcG9ydFJlc29sdXRpb24odGFzaywgW10sIHRlbXBEaXIpO1xuICAgICAgYXNzZXJ0LmRlZXBFcXVhbChyZXN1bHRzLCBbXSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwiaGFuZGxlcyBtdWx0aXBsZSBmaWxlcyB3aXRoIG11bHRpcGxlIGltcG9ydHNcIiwgKCkgPT4ge1xuICAgIHRlbXBEaXIgPSBqb2luKHRtcGRpcigpLCBgcG9zdC1leGVjLXRlc3QtJHtEYXRlLm5vdygpfWApO1xuICAgIG1rZGlyU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBta2RpclN5bmMoam9pbih0ZW1wRGlyLCBcInNyY1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHRlbXBEaXIsIFwic3JjXCIsIFwidXRpbHMudHNcIiksIFwiZXhwb3J0IGNvbnN0IGEgPSAxO1wiKTtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbih0ZW1wRGlyLCBcInNyY1wiLCBcImEudHNcIiksXG4gICAgICBcImltcG9ydCB7IGEgfSBmcm9tICcuL3V0aWxzJztcXG5pbXBvcnQgeyBiIH0gZnJvbSAnLi9taXNzaW5nJztcIlxuICAgICk7XG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4odGVtcERpciwgXCJzcmNcIiwgXCJiLnRzXCIpLFxuICAgICAgXCJpbXBvcnQgeyB4IH0gZnJvbSAnLi9hbHNvLW1pc3NpbmcnO1wiXG4gICAgKTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCB0YXNrID0gY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgICBrZXlfZmlsZXM6IFtcInNyYy9hLnRzXCIsIFwic3JjL2IudHNcIl0sXG4gICAgICB9KTtcblxuICAgICAgY29uc3QgcmVzdWx0cyA9IGNoZWNrSW1wb3J0UmVzb2x1dGlvbih0YXNrLCBbXSwgdGVtcERpcik7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0cy5sZW5ndGgsIDIpO1xuICAgICAgYXNzZXJ0Lm9rKHJlc3VsdHMuc29tZSgocikgPT4gci5tZXNzYWdlLmluY2x1ZGVzKFwibWlzc2luZ1wiKSkpO1xuICAgICAgYXNzZXJ0Lm9rKHJlc3VsdHMuc29tZSgocikgPT4gci5tZXNzYWdlLmluY2x1ZGVzKFwiYWxzby1taXNzaW5nXCIpKSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwic2tpcHMgaWYga2V5X2ZpbGUgZG9lc24ndCBleGlzdFwiLCAoKSA9PiB7XG4gICAgdGVtcERpciA9IGpvaW4odG1wZGlyKCksIGBwb3N0LWV4ZWMtdGVzdC0ke0RhdGUubm93KCl9YCk7XG4gICAgbWtkaXJTeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHRhc2sgPSBjcmVhdGVUYXNrKHtcbiAgICAgICAgaWQ6IFwiVDAxXCIsXG4gICAgICAgIGtleV9maWxlczogW1wic3JjL2RlbGV0ZWQudHNcIl0sXG4gICAgICB9KTtcblxuICAgICAgY29uc3QgcmVzdWx0cyA9IGNoZWNrSW1wb3J0UmVzb2x1dGlvbih0YXNrLCBbXSwgdGVtcERpcik7XG4gICAgICBhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdHMsIFtdKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIC8vIFJlZ3Jlc3Npb246IGlzc3VlICM0NDExIFx1MjAxNCBDU1Mgc2lkZS1lZmZlY3QgaW1wb3J0IGluc2lkZSBhIC50c3gga2V5X2ZpbGVcbiAgLy8gbXVzdCBub3QgcHJvZHVjZSBhIGJsb2NraW5nIHBvc3QtZXhlY3V0aW9uIGZhaWx1cmUuXG4gIHRlc3QoXCJkb2VzIG5vdCBibG9jayBvbiB2YWxpZCBDU1Mgc2lkZS1lZmZlY3QgaW1wb3J0IGluIC50c3gga2V5X2ZpbGVcIiwgKHQpID0+IHtcbiAgICBjb25zdCBkaXIgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcInBvc3QtZXhlYy10ZXN0LWFzc2V0LVwiKSk7XG4gICAgdC5hZnRlcigoKSA9PiBybVN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuICAgIC8vIGZyb250ZW5kL3NyYy9yb3V0ZXMvcm9vdC50c3ggaW1wb3J0cyAnLi4vLi4vc3R5bGVzL2dsb2JhbHMuY3NzJyBcdTIxOTJcbiAgICAvLyByZXNvbHZlcyB0byBmcm9udGVuZC9zdHlsZXMvZ2xvYmFscy5jc3MuXG4gICAgbWtkaXJTeW5jKGpvaW4oZGlyLCBcImZyb250ZW5kXCIsIFwic3JjXCIsIFwicm91dGVzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBta2RpclN5bmMoam9pbihkaXIsIFwiZnJvbnRlbmRcIiwgXCJzdHlsZXNcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiZnJvbnRlbmRcIiwgXCJzdHlsZXNcIiwgXCJnbG9iYWxzLmNzc1wiKSwgXCJcIik7XG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4oZGlyLCBcImZyb250ZW5kXCIsIFwic3JjXCIsIFwicm91dGVzXCIsIFwicm9vdC50c3hcIiksXG4gICAgICBcImltcG9ydCAnLi4vLi4vc3R5bGVzL2dsb2JhbHMuY3NzJztcXG5leHBvcnQgZGVmYXVsdCBmdW5jdGlvbiBSb290KCkgeyByZXR1cm4gbnVsbDsgfVwiXG4gICAgKTtcblxuICAgIGNvbnN0IHRhc2sgPSBjcmVhdGVUYXNrKHtcbiAgICAgIGlkOiBcIlQwM1wiLFxuICAgICAga2V5X2ZpbGVzOiBbXCJmcm9udGVuZC9zcmMvcm91dGVzL3Jvb3QudHN4XCJdLFxuICAgIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0cyA9IGNoZWNrSW1wb3J0UmVzb2x1dGlvbih0YXNrLCBbXSwgZGlyKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdHMsIFtdLCBcInZhbGlkIENTUyBpbXBvcnQgbXVzdCBub3QgYmUgZmxhZ2dlZFwiKTtcbiAgfSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIENyb3NzLVRhc2sgU2lnbmF0dXJlIFRlc3RzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcImNoZWNrQ3Jvc3NUYXNrU2lnbmF0dXJlc1wiLCAoKSA9PiB7XG4gIGxldCB0ZW1wRGlyOiBzdHJpbmc7XG5cbiAgdGVzdChcInBhc3NlcyB3aGVuIG5vIHByaW9yIHRhc2tzIGV4aXN0XCIsICgpID0+IHtcbiAgICB0ZW1wRGlyID0gam9pbih0bXBkaXIoKSwgYHBvc3QtZXhlYy10ZXN0LSR7RGF0ZS5ub3coKX1gKTtcbiAgICBta2RpclN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgbWtkaXJTeW5jKGpvaW4odGVtcERpciwgXCJzcmNcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKHRlbXBEaXIsIFwic3JjXCIsIFwiYXBpLnRzXCIpLFxuICAgICAgXCJleHBvcnQgZnVuY3Rpb24gZ2V0RGF0YSgpOiBzdHJpbmcgeyByZXR1cm4gJyc7IH1cIlxuICAgICk7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgdGFzayA9IGNyZWF0ZVRhc2soe1xuICAgICAgICBpZDogXCJUMDJcIixcbiAgICAgICAga2V5X2ZpbGVzOiBbXCJzcmMvYXBpLnRzXCJdLFxuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IHJlc3VsdHMgPSBjaGVja0Nyb3NzVGFza1NpZ25hdHVyZXModGFzaywgW10sIHRlbXBEaXIpO1xuICAgICAgYXNzZXJ0LmRlZXBFcXVhbChyZXN1bHRzLCBbXSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwicGFzc2VzIHdoZW4gc2lnbmF0dXJlcyBtYXRjaFwiLCAoKSA9PiB7XG4gICAgdGVtcERpciA9IGpvaW4odG1wZGlyKCksIGBwb3N0LWV4ZWMtdGVzdC0ke0RhdGUubm93KCl9YCk7XG4gICAgbWtkaXJTeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIG1rZGlyU3luYyhqb2luKHRlbXBEaXIsIFwic3JjXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbih0ZW1wRGlyLCBcInNyY1wiLCBcInV0aWxzLnRzXCIpLFxuICAgICAgXCJleHBvcnQgZnVuY3Rpb24gcHJvY2VzcyhkYXRhOiBzdHJpbmcpOiBib29sZWFuIHsgcmV0dXJuIHRydWU7IH1cIlxuICAgICk7XG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4odGVtcERpciwgXCJzcmNcIiwgXCJhcGkudHNcIiksXG4gICAgICBcImV4cG9ydCBmdW5jdGlvbiBwcm9jZXNzKGRhdGE6IHN0cmluZyk6IGJvb2xlYW4geyByZXR1cm4gZmFsc2U7IH1cIlxuICAgICk7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgcHJpb3JUYXNrID0gY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgICBrZXlfZmlsZXM6IFtcInNyYy91dGlscy50c1wiXSxcbiAgICAgIH0pO1xuICAgICAgY29uc3QgY3VycmVudFRhc2sgPSBjcmVhdGVUYXNrKHtcbiAgICAgICAgaWQ6IFwiVDAyXCIsXG4gICAgICAgIGtleV9maWxlczogW1wic3JjL2FwaS50c1wiXSxcbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCByZXN1bHRzID0gY2hlY2tDcm9zc1Rhc2tTaWduYXR1cmVzKGN1cnJlbnRUYXNrLCBbcHJpb3JUYXNrXSwgdGVtcERpcik7XG4gICAgICBhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdHMsIFtdKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJ3YXJucyBvbiBwYXJhbWV0ZXIgbWlzbWF0Y2ggKG5vbi1ibG9ja2luZylcIiwgKCkgPT4ge1xuICAgIHRlbXBEaXIgPSBqb2luKHRtcGRpcigpLCBgcG9zdC1leGVjLXRlc3QtJHtEYXRlLm5vdygpfWApO1xuICAgIG1rZGlyU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBta2RpclN5bmMoam9pbih0ZW1wRGlyLCBcInNyY1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4odGVtcERpciwgXCJzcmNcIiwgXCJ1dGlscy50c1wiKSxcbiAgICAgIFwiZXhwb3J0IGZ1bmN0aW9uIHNhdmUobmFtZTogc3RyaW5nKTogdm9pZCB7fVwiXG4gICAgKTtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbih0ZW1wRGlyLCBcInNyY1wiLCBcImFwaS50c1wiKSxcbiAgICAgIFwiZXhwb3J0IGZ1bmN0aW9uIHNhdmUobmFtZTogc3RyaW5nLCBpZDogbnVtYmVyKTogdm9pZCB7fVwiXG4gICAgKTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCBwcmlvclRhc2sgPSBjcmVhdGVUYXNrKHtcbiAgICAgICAgaWQ6IFwiVDAxXCIsXG4gICAgICAgIGtleV9maWxlczogW1wic3JjL3V0aWxzLnRzXCJdLFxuICAgICAgfSk7XG4gICAgICBjb25zdCBjdXJyZW50VGFzayA9IGNyZWF0ZVRhc2soe1xuICAgICAgICBpZDogXCJUMDJcIixcbiAgICAgICAga2V5X2ZpbGVzOiBbXCJzcmMvYXBpLnRzXCJdLFxuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IHJlc3VsdHMgPSBjaGVja0Nyb3NzVGFza1NpZ25hdHVyZXMoY3VycmVudFRhc2ssIFtwcmlvclRhc2tdLCB0ZW1wRGlyKTtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHRzLmxlbmd0aCwgMSk7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0c1swXS5jYXRlZ29yeSwgXCJzaWduYXR1cmVcIik7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0c1swXS50YXJnZXQsIFwic2F2ZVwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHRzWzBdLnBhc3NlZCwgZmFsc2UpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHJlc3VsdHNbMF0uYmxvY2tpbmcsIGZhbHNlKTtcbiAgICAgIGFzc2VydC5vayhyZXN1bHRzWzBdLm1lc3NhZ2UuaW5jbHVkZXMoXCJwYXJhbWV0ZXJzXCIpKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJ3YXJucyBvbiByZXR1cm4gdHlwZSBtaXNtYXRjaCAobm9uLWJsb2NraW5nKVwiLCAoKSA9PiB7XG4gICAgdGVtcERpciA9IGpvaW4odG1wZGlyKCksIGBwb3N0LWV4ZWMtdGVzdC0ke0RhdGUubm93KCl9YCk7XG4gICAgbWtkaXJTeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIG1rZGlyU3luYyhqb2luKHRlbXBEaXIsIFwic3JjXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbih0ZW1wRGlyLCBcInNyY1wiLCBcInV0aWxzLnRzXCIpLFxuICAgICAgXCJleHBvcnQgZnVuY3Rpb24gZmV0Y2goKTogc3RyaW5nIHsgcmV0dXJuICcnOyB9XCJcbiAgICApO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKHRlbXBEaXIsIFwic3JjXCIsIFwiYXBpLnRzXCIpLFxuICAgICAgXCJleHBvcnQgZnVuY3Rpb24gZmV0Y2goKTogbnVtYmVyIHsgcmV0dXJuIDA7IH1cIlxuICAgICk7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgcHJpb3JUYXNrID0gY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgICBrZXlfZmlsZXM6IFtcInNyYy91dGlscy50c1wiXSxcbiAgICAgIH0pO1xuICAgICAgY29uc3QgY3VycmVudFRhc2sgPSBjcmVhdGVUYXNrKHtcbiAgICAgICAgaWQ6IFwiVDAyXCIsXG4gICAgICAgIGtleV9maWxlczogW1wic3JjL2FwaS50c1wiXSxcbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCByZXN1bHRzID0gY2hlY2tDcm9zc1Rhc2tTaWduYXR1cmVzKGN1cnJlbnRUYXNrLCBbcHJpb3JUYXNrXSwgdGVtcERpcik7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0cy5sZW5ndGgsIDEpO1xuICAgICAgYXNzZXJ0Lm9rKHJlc3VsdHNbMF0ubWVzc2FnZS5pbmNsdWRlcyhcInJldHVyblwiKSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwiaGFuZGxlcyBtdWx0aXBsZSBwcmlvciB0YXNrc1wiLCAoKSA9PiB7XG4gICAgdGVtcERpciA9IGpvaW4odG1wZGlyKCksIGBwb3N0LWV4ZWMtdGVzdC0ke0RhdGUubm93KCl9YCk7XG4gICAgbWtkaXJTeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIG1rZGlyU3luYyhqb2luKHRlbXBEaXIsIFwic3JjXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbih0ZW1wRGlyLCBcInNyY1wiLCBcInR5cGVzLnRzXCIpLFxuICAgICAgXCJleHBvcnQgZnVuY3Rpb24gcGFyc2Uoczogc3RyaW5nKTogb2JqZWN0IHsgcmV0dXJuIHt9OyB9XCJcbiAgICApO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKHRlbXBEaXIsIFwic3JjXCIsIFwidXRpbHMudHNcIiksXG4gICAgICBcImV4cG9ydCBmdW5jdGlvbiB2YWxpZGF0ZSh4OiBvYmplY3QpOiBib29sZWFuIHsgcmV0dXJuIHRydWU7IH1cIlxuICAgICk7XG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4odGVtcERpciwgXCJzcmNcIiwgXCJhcGkudHNcIiksXG4gICAgICBgZXhwb3J0IGZ1bmN0aW9uIHBhcnNlKHM6IG51bWJlcik6IG9iamVjdCB7IHJldHVybiB7fTsgfVxuICAgICAgIGV4cG9ydCBmdW5jdGlvbiB2YWxpZGF0ZSh4OiBvYmplY3QpOiBib29sZWFuIHsgcmV0dXJuIHRydWU7IH1gXG4gICAgKTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCBwcmlvclRhc2sxID0gY3JlYXRlVGFzayh7IGlkOiBcIlQwMVwiLCBrZXlfZmlsZXM6IFtcInNyYy90eXBlcy50c1wiXSB9KTtcbiAgICAgIGNvbnN0IHByaW9yVGFzazIgPSBjcmVhdGVUYXNrKHsgaWQ6IFwiVDAyXCIsIGtleV9maWxlczogW1wic3JjL3V0aWxzLnRzXCJdIH0pO1xuICAgICAgY29uc3QgY3VycmVudFRhc2sgPSBjcmVhdGVUYXNrKHsgaWQ6IFwiVDAzXCIsIGtleV9maWxlczogW1wic3JjL2FwaS50c1wiXSB9KTtcblxuICAgICAgY29uc3QgcmVzdWx0cyA9IGNoZWNrQ3Jvc3NUYXNrU2lnbmF0dXJlcyhcbiAgICAgICAgY3VycmVudFRhc2ssXG4gICAgICAgIFtwcmlvclRhc2sxLCBwcmlvclRhc2syXSxcbiAgICAgICAgdGVtcERpclxuICAgICAgKTtcbiAgICAgIC8vIFNob3VsZCBoYXZlIDEgd2FybmluZyBmb3IgcGFyc2UoKSBwYXJhbWV0ZXIgbWlzbWF0Y2hcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHRzLmxlbmd0aCwgMSk7XG4gICAgICBhc3NlcnQub2socmVzdWx0c1swXS5tZXNzYWdlLmluY2x1ZGVzKFwicGFyc2VcIikpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFBhdHRlcm4gQ29uc2lzdGVuY3kgVGVzdHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiY2hlY2tQYXR0ZXJuQ29uc2lzdGVuY3lcIiwgKCkgPT4ge1xuICBsZXQgdGVtcERpcjogc3RyaW5nO1xuXG4gIHRlc3QoXCJwYXNzZXMgd2hlbiBhc3luYyBzdHlsZSBpcyBjb25zaXN0ZW50IChhd2FpdCBvbmx5KVwiLCAoKSA9PiB7XG4gICAgdGVtcERpciA9IGpvaW4odG1wZGlyKCksIGBwb3N0LWV4ZWMtdGVzdC0ke0RhdGUubm93KCl9YCk7XG4gICAgbWtkaXJTeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKHRlbXBEaXIsIFwiYXBpLnRzXCIpLFxuICAgICAgYGFzeW5jIGZ1bmN0aW9uIGdldERhdGEoKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZmV0Y2goJy9hcGknKTtcbiAgICAgICAgcmV0dXJuIGF3YWl0IHJlc3VsdC50ZXh0KCk7XG4gICAgICB9YFxuICAgICk7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgdGFzayA9IGNyZWF0ZVRhc2soeyBpZDogXCJUMDFcIiwga2V5X2ZpbGVzOiBbXCJhcGkudHNcIl0gfSk7XG4gICAgICBjb25zdCByZXN1bHRzID0gY2hlY2tQYXR0ZXJuQ29uc2lzdGVuY3kodGFzaywgW10sIHRlbXBEaXIpO1xuICAgICAgY29uc3QgYXN5bmNSZXN1bHRzID0gcmVzdWx0cy5maWx0ZXIoKHIpID0+IHIubWVzc2FnZS5pbmNsdWRlcyhcImFzeW5jXCIpKTtcbiAgICAgIGFzc2VydC5lcXVhbChhc3luY1Jlc3VsdHMubGVuZ3RoLCAwKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJwYXNzZXMgd2hlbiBhc3luYyBzdHlsZSBpcyBjb25zaXN0ZW50ICgudGhlbiBvbmx5KVwiLCAoKSA9PiB7XG4gICAgdGVtcERpciA9IGpvaW4odG1wZGlyKCksIGBwb3N0LWV4ZWMtdGVzdC0ke0RhdGUubm93KCl9YCk7XG4gICAgbWtkaXJTeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKHRlbXBEaXIsIFwiYXBpLnRzXCIpLFxuICAgICAgYGZ1bmN0aW9uIGdldERhdGEoKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgICAgICAgcmV0dXJuIGZldGNoKCcvYXBpJykudGhlbihyID0+IHIudGV4dCgpKTtcbiAgICAgIH1gXG4gICAgKTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCB0YXNrID0gY3JlYXRlVGFzayh7IGlkOiBcIlQwMVwiLCBrZXlfZmlsZXM6IFtcImFwaS50c1wiXSB9KTtcbiAgICAgIGNvbnN0IHJlc3VsdHMgPSBjaGVja1BhdHRlcm5Db25zaXN0ZW5jeSh0YXNrLCBbXSwgdGVtcERpcik7XG4gICAgICBjb25zdCBhc3luY1Jlc3VsdHMgPSByZXN1bHRzLmZpbHRlcigocikgPT4gci5tZXNzYWdlLmluY2x1ZGVzKFwiYXN5bmNcIikpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGFzeW5jUmVzdWx0cy5sZW5ndGgsIDApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcIndhcm5zIHdoZW4gbWl4aW5nIGFzeW5jL2F3YWl0IHdpdGggLnRoZW4oKVwiLCAoKSA9PiB7XG4gICAgdGVtcERpciA9IGpvaW4odG1wZGlyKCksIGBwb3N0LWV4ZWMtdGVzdC0ke0RhdGUubm93KCl9YCk7XG4gICAgbWtkaXJTeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKHRlbXBEaXIsIFwiYXBpLnRzXCIpLFxuICAgICAgYGFzeW5jIGZ1bmN0aW9uIGdldERhdGEoKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZmV0Y2goJy9hcGknKTtcbiAgICAgICAgcmV0dXJuIHJlc3VsdC50ZXh0KCkudGhlbih0ID0+IHQudG9VcHBlckNhc2UoKSk7XG4gICAgICB9YFxuICAgICk7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgdGFzayA9IGNyZWF0ZVRhc2soeyBpZDogXCJUMDFcIiwga2V5X2ZpbGVzOiBbXCJhcGkudHNcIl0gfSk7XG4gICAgICBjb25zdCByZXN1bHRzID0gY2hlY2tQYXR0ZXJuQ29uc2lzdGVuY3kodGFzaywgW10sIHRlbXBEaXIpO1xuICAgICAgY29uc3QgYXN5bmNSZXN1bHRzID0gcmVzdWx0cy5maWx0ZXIoKHIpID0+IHIubWVzc2FnZS5pbmNsdWRlcyhcImFzeW5jXCIpKTtcbiAgICAgIGFzc2VydC5lcXVhbChhc3luY1Jlc3VsdHMubGVuZ3RoLCAxKTtcbiAgICAgIGFzc2VydC5lcXVhbChhc3luY1Jlc3VsdHNbMF0uY2F0ZWdvcnksIFwicGF0dGVyblwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChhc3luY1Jlc3VsdHNbMF0ucGFzc2VkLCB0cnVlKTsgLy8gV2FybmluZyBvbmx5XG4gICAgICBhc3NlcnQuZXF1YWwoYXN5bmNSZXN1bHRzWzBdLmJsb2NraW5nLCBmYWxzZSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwicGFzc2VzIHdoZW4gbmFtaW5nIGlzIGNvbnNpc3RlbnQgKGNhbWVsQ2FzZSBvbmx5KVwiLCAoKSA9PiB7XG4gICAgdGVtcERpciA9IGpvaW4odG1wZGlyKCksIGBwb3N0LWV4ZWMtdGVzdC0ke0RhdGUubm93KCl9YCk7XG4gICAgbWtkaXJTeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKHRlbXBEaXIsIFwiYXBpLnRzXCIpLFxuICAgICAgYGZ1bmN0aW9uIGdldFVzZXJEYXRhKCkge31cbiAgICAgICBjb25zdCBwcm9jZXNzSXRlbXMgPSAoKSA9PiB7fTtcbiAgICAgICBmdW5jdGlvbiB2YWxpZGF0ZUlucHV0KCkge31gXG4gICAgKTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCB0YXNrID0gY3JlYXRlVGFzayh7IGlkOiBcIlQwMVwiLCBrZXlfZmlsZXM6IFtcImFwaS50c1wiXSB9KTtcbiAgICAgIGNvbnN0IHJlc3VsdHMgPSBjaGVja1BhdHRlcm5Db25zaXN0ZW5jeSh0YXNrLCBbXSwgdGVtcERpcik7XG4gICAgICBjb25zdCBuYW1pbmdSZXN1bHRzID0gcmVzdWx0cy5maWx0ZXIoKHIpID0+IHIubWVzc2FnZS5pbmNsdWRlcyhcIm5hbWluZ1wiKSB8fCByLm1lc3NhZ2UuaW5jbHVkZXMoXCJDYXNlXCIpKTtcbiAgICAgIGFzc2VydC5lcXVhbChuYW1pbmdSZXN1bHRzLmxlbmd0aCwgMCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwid2FybnMgd2hlbiBtaXhpbmcgY2FtZWxDYXNlIGFuZCBzbmFrZV9jYXNlXCIsICgpID0+IHtcbiAgICB0ZW1wRGlyID0gam9pbih0bXBkaXIoKSwgYHBvc3QtZXhlYy10ZXN0LSR7RGF0ZS5ub3coKX1gKTtcbiAgICBta2RpclN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4odGVtcERpciwgXCJhcGkudHNcIiksXG4gICAgICBgZnVuY3Rpb24gZ2V0VXNlckRhdGEoKSB7fVxuICAgICAgIGZ1bmN0aW9uIHByb2Nlc3NfaXRlbXMoKSB7fVxuICAgICAgIGNvbnN0IHZhbGlkYXRlX2lucHV0ID0gKCkgPT4ge307YFxuICAgICk7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgdGFzayA9IGNyZWF0ZVRhc2soeyBpZDogXCJUMDFcIiwga2V5X2ZpbGVzOiBbXCJhcGkudHNcIl0gfSk7XG4gICAgICBjb25zdCByZXN1bHRzID0gY2hlY2tQYXR0ZXJuQ29uc2lzdGVuY3kodGFzaywgW10sIHRlbXBEaXIpO1xuICAgICAgY29uc3QgbmFtaW5nUmVzdWx0cyA9IHJlc3VsdHMuZmlsdGVyKChyKSA9PiByLm1lc3NhZ2UuaW5jbHVkZXMoXCJjYW1lbENhc2VcIikgfHwgci5tZXNzYWdlLmluY2x1ZGVzKFwic25ha2VfY2FzZVwiKSk7XG4gICAgICBhc3NlcnQuZXF1YWwobmFtaW5nUmVzdWx0cy5sZW5ndGgsIDEpO1xuICAgICAgYXNzZXJ0LmVxdWFsKG5hbWluZ1Jlc3VsdHNbMF0uY2F0ZWdvcnksIFwicGF0dGVyblwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChuYW1pbmdSZXN1bHRzWzBdLmJsb2NraW5nLCBmYWxzZSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwic2tpcHMgbm9uLUpTL1RTIGZpbGVzXCIsICgpID0+IHtcbiAgICB0ZW1wRGlyID0gam9pbih0bXBkaXIoKSwgYHBvc3QtZXhlYy10ZXN0LSR7RGF0ZS5ub3coKX1gKTtcbiAgICBta2RpclN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHRlbXBEaXIsIFwiY29uZmlnLmpzb25cIiksICd7XCJrZXlcIjogXCJ2YWx1ZVwifScpO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHRhc2sgPSBjcmVhdGVUYXNrKHsgaWQ6IFwiVDAxXCIsIGtleV9maWxlczogW1wiY29uZmlnLmpzb25cIl0gfSk7XG4gICAgICBjb25zdCByZXN1bHRzID0gY2hlY2tQYXR0ZXJuQ29uc2lzdGVuY3kodGFzaywgW10sIHRlbXBEaXIpO1xuICAgICAgYXNzZXJ0LmRlZXBFcXVhbChyZXN1bHRzLCBbXSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgcnVuUG9zdEV4ZWN1dGlvbkNoZWNrcyBJbnRlZ3JhdGlvbiBUZXN0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJydW5Qb3N0RXhlY3V0aW9uQ2hlY2tzXCIsICgpID0+IHtcbiAgbGV0IHRlbXBEaXI6IHN0cmluZztcblxuICB0ZXN0KFwicmV0dXJucyBwYXNzIHN0YXR1cyB3aGVuIGFsbCBjaGVja3MgcGFzc1wiLCAoKSA9PiB7XG4gICAgdGVtcERpciA9IGpvaW4odG1wZGlyKCksIGBwb3N0LWV4ZWMtdGVzdC0ke0RhdGUubm93KCl9YCk7XG4gICAgbWtkaXJTeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIG1rZGlyU3luYyhqb2luKHRlbXBEaXIsIFwic3JjXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4odGVtcERpciwgXCJzcmNcIiwgXCJ1dGlscy50c1wiKSwgXCJleHBvcnQgY29uc3QgYSA9IDE7XCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKHRlbXBEaXIsIFwic3JjXCIsIFwibWFpbi50c1wiKSxcbiAgICAgIGBpbXBvcnQgeyBhIH0gZnJvbSAnLi91dGlscyc7XG4gICAgICAgZnVuY3Rpb24gcHJvY2Vzc0RhdGEoKTogdm9pZCB7fWBcbiAgICApO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHRhc2sgPSBjcmVhdGVUYXNrKHsgaWQ6IFwiVDAxXCIsIGtleV9maWxlczogW1wic3JjL21haW4udHNcIl0gfSk7XG4gICAgICBjb25zdCByZXN1bHQgPSBydW5Qb3N0RXhlY3V0aW9uQ2hlY2tzKHRhc2ssIFtdLCB0ZW1wRGlyKTtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc3RhdHVzLCBcInBhc3NcIik7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmNoZWNrcy5sZW5ndGgsIDApO1xuICAgICAgYXNzZXJ0Lm9rKHJlc3VsdC5kdXJhdGlvbk1zID49IDApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcImRvZXMgbm90IGZhaWwgb24gaW1wb3J0LWxvb2tpbmcgc3RyaW5ncyBpbiB0YXNrIGtleSBmaWxlc1wiLCAoKSA9PiB7XG4gICAgdGVtcERpciA9IGpvaW4odG1wZGlyKCksIGBwb3N0LWV4ZWMtdGVzdC0ke0RhdGUubm93KCl9YCk7XG4gICAgbWtkaXJTeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIG1rZGlyU3luYyhqb2luKHRlbXBEaXIsIFwidGVzdHNcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbih0ZW1wRGlyLCBcInRlc3RzXCIsIFwicmVhbC10aGluZy50c1wiKSwgXCJleHBvcnQgZGVmYXVsdCB0cnVlO1wiKTtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbih0ZW1wRGlyLCBcInRlc3RzXCIsIFwic291cmNlLXZlcmlmaWVyLnRlc3QudHNcIiksXG4gICAgICBgXG5jb25zdCByZXdyaXR0ZW4gPSBzb3VyY2UucmVwbGFjZShcbiAgJ2ltcG9ydCB7IG5vcm1hbGl6ZVphZ3JlYkJ1c2luZXNzRGVhZGxpbmUgfSBmcm9tIFwiLi9jdXRvZmZcIjsnLFxuICAnY29uc3QgaGVscGVyID0gdHJ1ZTsnXG4pO1xuXG5pbXBvcnQgcmVhbFRoaW5nIGZyb20gXCIuL3JlYWwtdGhpbmdcIjtcbmFzc2VydC5vayhyZWFsVGhpbmcpO1xuYFxuICAgICk7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgdGFzayA9IGNyZWF0ZVRhc2soe1xuICAgICAgICBpZDogXCJUMDNcIixcbiAgICAgICAga2V5X2ZpbGVzOiBbXCJ0ZXN0cy9zb3VyY2UtdmVyaWZpZXIudGVzdC50c1wiXSxcbiAgICAgIH0pO1xuICAgICAgY29uc3QgcmVzdWx0ID0gcnVuUG9zdEV4ZWN1dGlvbkNoZWNrcyh0YXNrLCBbXSwgdGVtcERpcik7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnN0YXR1cywgXCJwYXNzXCIpO1xuICAgICAgYXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQuY2hlY2tzLCBbXSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwicmV0dXJucyBmYWlsIHN0YXR1cyB3aGVuIGJsb2NraW5nIGZhaWx1cmUgZXhpc3RzXCIsICgpID0+IHtcbiAgICB0ZW1wRGlyID0gam9pbih0bXBkaXIoKSwgYHBvc3QtZXhlYy10ZXN0LSR7RGF0ZS5ub3coKX1gKTtcbiAgICBta2RpclN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgbWtkaXJTeW5jKGpvaW4odGVtcERpciwgXCJzcmNcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKHRlbXBEaXIsIFwic3JjXCIsIFwibWFpbi50c1wiKSxcbiAgICAgIFwiaW1wb3J0IHsgYSB9IGZyb20gJy4vbm9uZXhpc3RlbnQnO1wiXG4gICAgKTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCB0YXNrID0gY3JlYXRlVGFzayh7IGlkOiBcIlQwMVwiLCBrZXlfZmlsZXM6IFtcInNyYy9tYWluLnRzXCJdIH0pO1xuICAgICAgY29uc3QgcmVzdWx0ID0gcnVuUG9zdEV4ZWN1dGlvbkNoZWNrcyh0YXNrLCBbXSwgdGVtcERpcik7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnN0YXR1cywgXCJmYWlsXCIpO1xuICAgICAgYXNzZXJ0Lm9rKHJlc3VsdC5jaGVja3MubGVuZ3RoID4gMCk7XG4gICAgICBhc3NlcnQub2socmVzdWx0LmNoZWNrcy5zb21lKChjKSA9PiBjLmJsb2NraW5nID09PSB0cnVlKSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwicmV0dXJucyB3YXJuIHN0YXR1cyBmb3Igbm9uLWJsb2NraW5nIGlzc3VlcyBvbmx5XCIsICgpID0+IHtcbiAgICB0ZW1wRGlyID0gam9pbih0bXBkaXIoKSwgYHBvc3QtZXhlYy10ZXN0LSR7RGF0ZS5ub3coKX1gKTtcbiAgICBta2RpclN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgbWtkaXJTeW5jKGpvaW4odGVtcERpciwgXCJzcmNcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKHRlbXBEaXIsIFwic3JjXCIsIFwiYXBpLnRzXCIpLFxuICAgICAgYGFzeW5jIGZ1bmN0aW9uIGdldERhdGEoKSB7XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGZldGNoKCcvYXBpJyk7XG4gICAgICAgIHJldHVybiByZXN1bHQudGV4dCgpLnRoZW4odCA9PiB0KTtcbiAgICAgIH1gXG4gICAgKTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCB0YXNrID0gY3JlYXRlVGFzayh7IGlkOiBcIlQwMVwiLCBrZXlfZmlsZXM6IFtcInNyYy9hcGkudHNcIl0gfSk7XG4gICAgICBjb25zdCByZXN1bHQgPSBydW5Qb3N0RXhlY3V0aW9uQ2hlY2tzKHRhc2ssIFtdLCB0ZW1wRGlyKTtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc3RhdHVzLCBcIndhcm5cIik7XG4gICAgICBhc3NlcnQub2socmVzdWx0LmNoZWNrcy5zb21lKChjKSA9PiBjLmNhdGVnb3J5ID09PSBcInBhdHRlcm5cIikpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcImNvbWJpbmVzIHJlc3VsdHMgZnJvbSBhbGwgY2hlY2sgdHlwZXNcIiwgKCkgPT4ge1xuICAgIHRlbXBEaXIgPSBqb2luKHRtcGRpcigpLCBgcG9zdC1leGVjLXRlc3QtJHtEYXRlLm5vdygpfWApO1xuICAgIG1rZGlyU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBta2RpclN5bmMoam9pbih0ZW1wRGlyLCBcInNyY1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4odGVtcERpciwgXCJzcmNcIiwgXCJ1dGlscy50c1wiKSxcbiAgICAgIFwiZXhwb3J0IGZ1bmN0aW9uIHByb2Nlc3Moczogc3RyaW5nKTogdm9pZCB7fVwiXG4gICAgKTtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbih0ZW1wRGlyLCBcInNyY1wiLCBcImFwaS50c1wiKSxcbiAgICAgIGBpbXBvcnQgeyB4IH0gZnJvbSAnLi9taXNzaW5nJztcbiAgICAgICBhc3luYyBmdW5jdGlvbiBnZXREYXRhKCkge1xuICAgICAgICAgYXdhaXQgZmV0Y2goJy9hcGknKTtcbiAgICAgICAgIHJldHVybiBmZXRjaCgnL2FwaTInKS50aGVuKHIgPT4gcik7XG4gICAgICAgfVxuICAgICAgIGV4cG9ydCBmdW5jdGlvbiBwcm9jZXNzKG46IG51bWJlcik6IHZvaWQge31gXG4gICAgKTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCBwcmlvclRhc2sgPSBjcmVhdGVUYXNrKHsgaWQ6IFwiVDAxXCIsIGtleV9maWxlczogW1wic3JjL3V0aWxzLnRzXCJdIH0pO1xuICAgICAgY29uc3QgY3VycmVudFRhc2sgPSBjcmVhdGVUYXNrKHsgaWQ6IFwiVDAyXCIsIGtleV9maWxlczogW1wic3JjL2FwaS50c1wiXSB9KTtcblxuICAgICAgY29uc3QgcmVzdWx0ID0gcnVuUG9zdEV4ZWN1dGlvbkNoZWNrcyhjdXJyZW50VGFzaywgW3ByaW9yVGFza10sIHRlbXBEaXIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zdGF0dXMsIFwiZmFpbFwiKTsgLy8gSW1wb3J0IGZhaWx1cmUgaXMgYmxvY2tpbmdcblxuICAgICAgY29uc3QgY2F0ZWdvcmllcyA9IG5ldyBTZXQocmVzdWx0LmNoZWNrcy5tYXAoKGMpID0+IGMuY2F0ZWdvcnkpKTtcbiAgICAgIGFzc2VydC5vayhjYXRlZ29yaWVzLmhhcyhcImltcG9ydFwiKSk7IC8vIEZyb20gdW5yZXNvbHZlZCBpbXBvcnRcbiAgICAgIGFzc2VydC5vayhjYXRlZ29yaWVzLmhhcyhcInNpZ25hdHVyZVwiKSk7IC8vIEZyb20gc2lnbmF0dXJlIG1pc21hdGNoXG4gICAgICBhc3NlcnQub2soY2F0ZWdvcmllcy5oYXMoXCJwYXR0ZXJuXCIpKTsgLy8gRnJvbSBhc3luYyBzdHlsZSBkcmlmdFxuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcInJlcG9ydHMgZHVyYXRpb24gaW4gbWlsbGlzZWNvbmRzXCIsICgpID0+IHtcbiAgICB0ZW1wRGlyID0gam9pbih0bXBkaXIoKSwgYHBvc3QtZXhlYy10ZXN0LSR7RGF0ZS5ub3coKX1gKTtcbiAgICBta2RpclN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgdGFzayA9IGNyZWF0ZVRhc2soeyBpZDogXCJUMDFcIiwga2V5X2ZpbGVzOiBbXSB9KTtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IHJ1blBvc3RFeGVjdXRpb25DaGVja3ModGFzaywgW10sIHRlbXBEaXIpO1xuICAgICAgYXNzZXJ0Lm9rKHR5cGVvZiByZXN1bHQuZHVyYXRpb25NcyA9PT0gXCJudW1iZXJcIik7XG4gICAgICBhc3NlcnQub2socmVzdWx0LmR1cmF0aW9uTXMgPj0gMCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwiaGFuZGxlcyBlbXB0eSBrZXlfZmlsZXMgYXJyYXlcIiwgKCkgPT4ge1xuICAgIHRlbXBEaXIgPSBqb2luKHRtcGRpcigpLCBgcG9zdC1leGVjLXRlc3QtJHtEYXRlLm5vdygpfWApO1xuICAgIG1rZGlyU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCB0YXNrID0gY3JlYXRlVGFzayh7IGlkOiBcIlQwMVwiLCBrZXlfZmlsZXM6IFtdIH0pO1xuICAgICAgY29uc3QgcmVzdWx0ID0gcnVuUG9zdEV4ZWN1dGlvbkNoZWNrcyh0YXNrLCBbXSwgdGVtcERpcik7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnN0YXR1cywgXCJwYXNzXCIpO1xuICAgICAgYXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQuY2hlY2tzLCBbXSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUG9zdEV4ZWN1dGlvblJlc3VsdCBUeXBlIFRlc3RzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcIlBvc3RFeGVjdXRpb25SZXN1bHQgdHlwZVwiLCAoKSA9PiB7XG4gIHRlc3QoXCJzdGF0dXMgaXMgb25lIG9mIHBhc3MsIHdhcm4sIGZhaWxcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHRlbXBEaXIgPSBqb2luKHRtcGRpcigpLCBgcG9zdC1leGVjLXRlc3QtJHtEYXRlLm5vdygpfWApO1xuICAgIG1rZGlyU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCB0YXNrID0gY3JlYXRlVGFzayh7IGlkOiBcIlQwMVwiLCBrZXlfZmlsZXM6IFtdIH0pO1xuICAgICAgY29uc3QgcmVzdWx0ID0gcnVuUG9zdEV4ZWN1dGlvbkNoZWNrcyh0YXNrLCBbXSwgdGVtcERpcik7XG4gICAgICBhc3NlcnQub2soW1wicGFzc1wiLCBcIndhcm5cIiwgXCJmYWlsXCJdLmluY2x1ZGVzKHJlc3VsdC5zdGF0dXMpKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJjaGVja3MgYXJyYXkgbWF0Y2hlcyBQb3N0RXhlY3V0aW9uQ2hlY2tKU09OIHNjaGVtYVwiLCAoKSA9PiB7XG4gICAgY29uc3QgdGVtcERpciA9IGpvaW4odG1wZGlyKCksIGBwb3N0LWV4ZWMtdGVzdC0ke0RhdGUubm93KCl9YCk7XG4gICAgbWtkaXJTeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIG1rZGlyU3luYyhqb2luKHRlbXBEaXIsIFwic3JjXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbih0ZW1wRGlyLCBcInNyY1wiLCBcIm1haW4udHNcIiksXG4gICAgICBcImltcG9ydCB7IGEgfSBmcm9tICcuL21pc3NpbmcnO1wiXG4gICAgKTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCB0YXNrID0gY3JlYXRlVGFzayh7IGlkOiBcIlQwMVwiLCBrZXlfZmlsZXM6IFtcInNyYy9tYWluLnRzXCJdIH0pO1xuICAgICAgY29uc3QgcmVzdWx0ID0gcnVuUG9zdEV4ZWN1dGlvbkNoZWNrcyh0YXNrLCBbXSwgdGVtcERpcik7XG5cbiAgICAgIGZvciAoY29uc3QgY2hlY2sgb2YgcmVzdWx0LmNoZWNrcykge1xuICAgICAgICBhc3NlcnQub2soXG4gICAgICAgICAgW1wiaW1wb3J0XCIsIFwic2lnbmF0dXJlXCIsIFwicGF0dGVyblwiXS5pbmNsdWRlcyhjaGVjay5jYXRlZ29yeSksXG4gICAgICAgICAgYEludmFsaWQgY2F0ZWdvcnk6ICR7Y2hlY2suY2F0ZWdvcnl9YFxuICAgICAgICApO1xuICAgICAgICBhc3NlcnQub2sodHlwZW9mIGNoZWNrLnRhcmdldCA9PT0gXCJzdHJpbmdcIik7XG4gICAgICAgIGFzc2VydC5vayh0eXBlb2YgY2hlY2sucGFzc2VkID09PSBcImJvb2xlYW5cIik7XG4gICAgICAgIGFzc2VydC5vayh0eXBlb2YgY2hlY2subWVzc2FnZSA9PT0gXCJzdHJpbmdcIik7XG4gICAgICAgIGlmIChjaGVjay5ibG9ja2luZyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgYXNzZXJ0Lm9rKHR5cGVvZiBjaGVjay5ibG9ja2luZyA9PT0gXCJib29sZWFuXCIpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBU0EsU0FBUyxVQUFVLFlBQVk7QUFDL0IsT0FBTyxZQUFZO0FBQ25CLFNBQVMsY0FBYztBQUN2QixTQUFTLFdBQVcsYUFBYSxlQUFlLGNBQWM7QUFDOUQsU0FBUyxZQUFZO0FBRXJCO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FFSztBQVFQLFNBQVMsV0FBVyxZQUE4QixDQUFDLEdBQVk7QUFDN0QsU0FBTztBQUFBLElBQ0wsY0FBYztBQUFBLElBQ2QsVUFBVTtBQUFBLElBQ1YsSUFBSSxVQUFVLE1BQU07QUFBQSxJQUNwQixPQUFPO0FBQUEsSUFDUCxRQUFRO0FBQUEsSUFDUixXQUFXO0FBQUEsSUFDWCxXQUFXO0FBQUEsSUFDWCxxQkFBcUI7QUFBQSxJQUNyQixVQUFVO0FBQUEsSUFDVixlQUFjLG9CQUFJLEtBQUssR0FBRSxZQUFZO0FBQUEsSUFDckMsb0JBQW9CO0FBQUEsSUFDcEIsWUFBWTtBQUFBLElBQ1osY0FBYztBQUFBLElBQ2QsV0FBVyxVQUFVLGFBQWEsQ0FBQztBQUFBLElBQ25DLGVBQWUsQ0FBQztBQUFBLElBQ2hCLGlCQUFpQjtBQUFBLElBQ2pCLGFBQWEsVUFBVSxlQUFlO0FBQUEsSUFDdEMsVUFBVTtBQUFBLElBQ1YsT0FBTyxVQUFVLFNBQVMsQ0FBQztBQUFBLElBQzNCLFFBQVE7QUFBQSxJQUNSLFFBQVEsVUFBVSxVQUFVLENBQUM7QUFBQSxJQUM3QixpQkFBaUIsVUFBVSxtQkFBbUIsQ0FBQztBQUFBLElBQy9DLHNCQUFzQjtBQUFBLElBQ3RCLGNBQWM7QUFBQSxJQUNkLFVBQVUsVUFBVSxZQUFZO0FBQUEsSUFDaEMsZ0JBQWdCO0FBQUEsSUFDaEIsb0JBQW9CO0FBQUEsSUFDcEIsNEJBQTRCO0FBQUEsSUFDNUIsMEJBQTBCO0FBQUEsSUFDMUIsZ0NBQWdDO0FBQUEsSUFDaEMsR0FBRztBQUFBLEVBQ0w7QUFDRjtBQUlBLFNBQVMsMEJBQTBCLE1BQU07QUFDdkMsT0FBSyx1Q0FBdUMsTUFBTTtBQUNoRCxVQUFNLFNBQVM7QUFBQTtBQUFBO0FBQUE7QUFJZixVQUFNLFVBQVUsdUJBQXVCLE1BQU07QUFDN0MsV0FBTyxNQUFNLFFBQVEsUUFBUSxDQUFDO0FBQzlCLFdBQU8sR0FBRyxRQUFRLEtBQUssQ0FBQyxNQUFNLEVBQUUsZUFBZSxTQUFTLENBQUM7QUFDekQsV0FBTyxHQUFHLFFBQVEsS0FBSyxDQUFDLE1BQU0sRUFBRSxlQUFlLGdCQUFnQixDQUFDO0FBQUEsRUFDbEUsQ0FBQztBQUVELE9BQUssZ0NBQWdDLE1BQU07QUFDekMsVUFBTSxTQUFTO0FBQ2YsVUFBTSxVQUFVLHVCQUF1QixNQUFNO0FBQzdDLFdBQU8sTUFBTSxRQUFRLFFBQVEsQ0FBQztBQUM5QixXQUFPLE1BQU0sUUFBUSxDQUFDLEVBQUUsWUFBWSxZQUFZO0FBQUEsRUFDbEQsQ0FBQztBQUVELE9BQUssK0JBQStCLE1BQU07QUFDeEMsVUFBTSxTQUFTO0FBQUE7QUFBQTtBQUFBO0FBSWYsVUFBTSxVQUFVLHVCQUF1QixNQUFNO0FBQzdDLFdBQU8sTUFBTSxRQUFRLFFBQVEsQ0FBQztBQUM5QixXQUFPLEdBQUcsUUFBUSxLQUFLLENBQUMsTUFBTSxFQUFFLGVBQWUsU0FBUyxDQUFDO0FBQ3pELFdBQU8sR0FBRyxRQUFRLEtBQUssQ0FBQyxNQUFNLEVBQUUsZUFBZSxnQkFBZ0IsQ0FBQztBQUFBLEVBQ2xFLENBQUM7QUFFRCxPQUFLLGdDQUFnQyxNQUFNO0FBQ3pDLFVBQU0sU0FBUztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBS2YsVUFBTSxVQUFVLHVCQUF1QixNQUFNO0FBQzdDLFdBQU8sTUFBTSxRQUFRLFFBQVEsQ0FBQztBQUFBLEVBQ2hDLENBQUM7QUFFRCxPQUFLLGdDQUFnQyxNQUFNO0FBQ3pDLFVBQU0sU0FBUztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBS2YsVUFBTSxVQUFVLHVCQUF1QixNQUFNO0FBQzdDLFdBQU8sTUFBTSxRQUFRLFFBQVEsQ0FBQztBQUM5QixVQUFNLFVBQVUsUUFBUSxLQUFLLENBQUMsTUFBTSxFQUFFLGVBQWUsS0FBSztBQUMxRCxVQUFNLFVBQVUsUUFBUSxLQUFLLENBQUMsTUFBTSxFQUFFLGVBQWUsS0FBSztBQUMxRCxXQUFPLE1BQU0sU0FBUyxTQUFTLENBQUM7QUFDaEMsV0FBTyxNQUFNLFNBQVMsU0FBUyxDQUFDO0FBQUEsRUFDbEMsQ0FBQztBQUVELE9BQUsseUNBQXlDLE1BQU07QUFDbEQsVUFBTSxTQUFTO0FBQ2YsVUFBTSxVQUFVLHVCQUF1QixNQUFNO0FBQzdDLFdBQU8sTUFBTSxRQUFRLFFBQVEsQ0FBQztBQUFBLEVBQ2hDLENBQUM7QUFFRCxPQUFLLDJEQUEyRCxNQUFNO0FBQ3BFLFVBQU0sU0FBUztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBUWYsVUFBTSxVQUFVLHVCQUF1QixNQUFNO0FBQzdDLFdBQU8sVUFBVSxTQUFTO0FBQUEsTUFDeEIsRUFBRSxZQUFZLGdCQUFnQixTQUFTLEVBQUU7QUFBQSxJQUMzQyxDQUFDO0FBQUEsRUFDSCxDQUFDO0FBRUQsT0FBSyx5REFBeUQsTUFBTTtBQUNsRSxVQUFNLFNBQVM7QUFBQSxNQUNiO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLElBQ0YsRUFBRSxLQUFLLElBQUk7QUFDWCxVQUFNLFVBQVUsdUJBQXVCLE1BQU07QUFDN0MsV0FBTyxVQUFVLFNBQVM7QUFBQSxNQUN4QixFQUFFLFlBQVksZ0JBQWdCLFNBQVMsRUFBRTtBQUFBLElBQzNDLENBQUM7QUFBQSxFQUNILENBQUM7QUFFRCxPQUFLLDRDQUE0QyxNQUFNO0FBQ3JELFVBQU0sU0FBUztBQUFBLE1BQ2I7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLElBQ0YsRUFBRSxLQUFLLElBQUk7QUFDWCxVQUFNLFVBQVUsdUJBQXVCLE1BQU07QUFDN0MsV0FBTyxVQUFVLFNBQVM7QUFBQSxNQUN4QixFQUFFLFlBQVksVUFBVSxTQUFTLEVBQUU7QUFBQSxJQUNyQyxDQUFDO0FBQUEsRUFDSCxDQUFDO0FBRUQsT0FBSyw4Q0FBOEMsTUFBTTtBQUN2RCxVQUFNLFNBQVM7QUFBQSxNQUNiO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLElBQ0YsRUFBRSxLQUFLLElBQUk7QUFDWCxVQUFNLFVBQVUsdUJBQXVCLE1BQU07QUFDN0MsV0FBTyxVQUFVLFNBQVM7QUFBQSxNQUN4QixFQUFFLFlBQVksVUFBVSxTQUFTLEVBQUU7QUFBQSxJQUNyQyxDQUFDO0FBQUEsRUFDSCxDQUFDO0FBRUQsT0FBSyx3QkFBd0IsTUFBTTtBQUNqQyxVQUFNLFVBQVUsdUJBQXVCLEVBQUU7QUFDekMsV0FBTyxVQUFVLFNBQVMsQ0FBQyxDQUFDO0FBQUEsRUFDOUIsQ0FBQztBQUNILENBQUM7QUFJRCxTQUFTLHFCQUFxQixNQUFNO0FBQ2xDLE1BQUk7QUFFSixPQUFLLHNDQUFzQyxNQUFNO0FBQy9DLGNBQVUsS0FBSyxPQUFPLEdBQUcsa0JBQWtCLEtBQUssSUFBSSxDQUFDLEVBQUU7QUFDdkQsY0FBVSxTQUFTLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDdEMsY0FBVSxLQUFLLFNBQVMsS0FBSyxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDbkQsa0JBQWMsS0FBSyxTQUFTLE9BQU8sVUFBVSxHQUFHLHFCQUFxQjtBQUNyRSxrQkFBYyxLQUFLLFNBQVMsT0FBTyxTQUFTLEdBQUcsOEJBQThCO0FBRTdFLFFBQUk7QUFDRixZQUFNLFNBQVMsa0JBQWtCLFdBQVcsZUFBZSxPQUFPO0FBQ2xFLGFBQU8sR0FBRyxPQUFPLE1BQU07QUFDdkIsYUFBTyxHQUFHLE9BQU8sY0FBYyxTQUFTLFVBQVUsQ0FBQztBQUFBLElBQ3JELFVBQUU7QUFDQSxhQUFPLFNBQVMsRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUNsRDtBQUFBLEVBQ0YsQ0FBQztBQUVELE9BQUssbUNBQW1DLE1BQU07QUFDNUMsY0FBVSxLQUFLLE9BQU8sR0FBRyxrQkFBa0IsS0FBSyxJQUFJLENBQUMsRUFBRTtBQUN2RCxjQUFVLFNBQVMsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUN0QyxjQUFVLEtBQUssU0FBUyxLQUFLLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNuRCxrQkFBYyxLQUFLLFNBQVMsT0FBTyxZQUFZLEdBQUcsc0JBQXNCO0FBQ3hFLGtCQUFjLEtBQUssU0FBUyxPQUFPLFVBQVUsR0FBRyxFQUFFO0FBRWxELFFBQUk7QUFDRixZQUFNLFNBQVMsa0JBQWtCLGFBQWEsZ0JBQWdCLE9BQU87QUFDckUsYUFBTyxHQUFHLE9BQU8sTUFBTTtBQUFBLElBQ3pCLFVBQUU7QUFDQSxhQUFPLFNBQVMsRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUNsRDtBQUFBLEVBQ0YsQ0FBQztBQUVELE9BQUssaUNBQWlDLE1BQU07QUFDMUMsY0FBVSxLQUFLLE9BQU8sR0FBRyxrQkFBa0IsS0FBSyxJQUFJLENBQUMsRUFBRTtBQUN2RCxjQUFVLFNBQVMsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUN0QyxjQUFVLEtBQUssU0FBUyxPQUFPLE9BQU8sR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQzVELGtCQUFjLEtBQUssU0FBUyxPQUFPLFNBQVMsVUFBVSxHQUFHLFlBQVk7QUFDckUsa0JBQWMsS0FBSyxTQUFTLE9BQU8sU0FBUyxHQUFHLEVBQUU7QUFFakQsUUFBSTtBQUNGLFlBQU0sU0FBUyxrQkFBa0IsV0FBVyxlQUFlLE9BQU87QUFDbEUsYUFBTyxHQUFHLE9BQU8sTUFBTTtBQUN2QixhQUFPLEdBQUcsT0FBTyxjQUFjLFNBQVMsVUFBVSxDQUFDO0FBQUEsSUFDckQsVUFBRTtBQUNBLGFBQU8sU0FBUyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQ2xEO0FBQUEsRUFDRixDQUFDO0FBRUQsT0FBSyxxQ0FBcUMsTUFBTTtBQUM5QyxjQUFVLEtBQUssT0FBTyxHQUFHLGtCQUFrQixLQUFLLElBQUksQ0FBQyxFQUFFO0FBQ3ZELGNBQVUsU0FBUyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3RDLGNBQVUsS0FBSyxTQUFTLE9BQU8sUUFBUSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDN0Qsa0JBQWMsS0FBSyxTQUFTLE9BQU8sVUFBVSxHQUFHLFlBQVk7QUFDNUQsa0JBQWMsS0FBSyxTQUFTLE9BQU8sVUFBVSxVQUFVLEdBQUcsRUFBRTtBQUU1RCxRQUFJO0FBQ0YsWUFBTSxTQUFTLGtCQUFrQixZQUFZLHVCQUF1QixPQUFPO0FBQzNFLGFBQU8sR0FBRyxPQUFPLE1BQU07QUFBQSxJQUN6QixVQUFFO0FBQ0EsYUFBTyxTQUFTLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDbEQ7QUFBQSxFQUNGLENBQUM7QUFFRCxPQUFLLCtCQUErQixNQUFNO0FBQ3hDLGNBQVUsS0FBSyxPQUFPLEdBQUcsa0JBQWtCLEtBQUssSUFBSSxDQUFDLEVBQUU7QUFDdkQsY0FBVSxTQUFTLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDdEMsY0FBVSxLQUFLLFNBQVMsS0FBSyxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDbkQsa0JBQWMsS0FBSyxTQUFTLE9BQU8sU0FBUyxHQUFHLEVBQUU7QUFFakQsUUFBSTtBQUNGLFlBQU0sU0FBUyxrQkFBa0IsaUJBQWlCLGVBQWUsT0FBTztBQUN4RSxhQUFPLEdBQUcsQ0FBQyxPQUFPLE1BQU07QUFDeEIsYUFBTyxNQUFNLE9BQU8sY0FBYyxJQUFJO0FBQUEsSUFDeEMsVUFBRTtBQUNBLGFBQU8sU0FBUyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQ2xEO0FBQUEsRUFDRixDQUFDO0FBRUQsT0FBSyx3Q0FBd0MsTUFBTTtBQUNqRCxjQUFVLEtBQUssT0FBTyxHQUFHLGtCQUFrQixLQUFLLElBQUksQ0FBQyxFQUFFO0FBQ3ZELGNBQVUsU0FBUyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3RDLGNBQVUsS0FBSyxTQUFTLEtBQUssR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ25ELGtCQUFjLEtBQUssU0FBUyxPQUFPLFdBQVcsR0FBRyxJQUFJO0FBQ3JELGtCQUFjLEtBQUssU0FBUyxPQUFPLFNBQVMsR0FBRyxFQUFFO0FBRWpELFFBQUk7QUFDRixZQUFNLFNBQVMsa0JBQWtCLGVBQWUsZUFBZSxPQUFPO0FBQ3RFLGFBQU8sR0FBRyxPQUFPLE1BQU07QUFBQSxJQUN6QixVQUFFO0FBQ0EsYUFBTyxTQUFTLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDbEQ7QUFBQSxFQUNGLENBQUM7QUFJRCxPQUFLLDJEQUEyRCxDQUFDLE1BQU07QUFDckUsVUFBTSxNQUFNLFlBQVksS0FBSyxPQUFPLEdBQUcscUJBQXFCLENBQUM7QUFDN0QsTUFBRSxNQUFNLE1BQU0sT0FBTyxLQUFLLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDLENBQUM7QUFHM0QsY0FBVSxLQUFLLEtBQUssWUFBWSxPQUFPLFFBQVEsR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3JFLGNBQVUsS0FBSyxLQUFLLFlBQVksUUFBUSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDOUQsa0JBQWMsS0FBSyxLQUFLLFlBQVksVUFBVSxhQUFhLEdBQUcsRUFBRTtBQUNoRTtBQUFBLE1BQ0UsS0FBSyxLQUFLLFlBQVksT0FBTyxVQUFVLFVBQVU7QUFBQSxNQUNqRDtBQUFBLElBQ0Y7QUFFQSxVQUFNLFNBQVM7QUFBQSxNQUNiO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxJQUNGO0FBQ0EsV0FBTyxHQUFHLE9BQU8sUUFBUSx1Q0FBdUM7QUFDaEUsV0FBTyxHQUFHLE9BQU8sY0FBYyxTQUFTLGFBQWEsQ0FBQztBQUFBLEVBQ3hELENBQUM7QUFFRCxPQUFLLDhCQUE4QixDQUFDLE1BQU07QUFDeEMsVUFBTSxNQUFNLFlBQVksS0FBSyxPQUFPLEdBQUcsc0JBQXNCLENBQUM7QUFDOUQsTUFBRSxNQUFNLE1BQU0sT0FBTyxLQUFLLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDLENBQUM7QUFDM0QsY0FBVSxLQUFLLEtBQUssS0FBSyxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDL0Msa0JBQWMsS0FBSyxLQUFLLE9BQU8sWUFBWSxHQUFHLEVBQUU7QUFDaEQsa0JBQWMsS0FBSyxLQUFLLE9BQU8sU0FBUyxHQUFHLEVBQUU7QUFFN0MsVUFBTSxTQUFTLGtCQUFrQixnQkFBZ0IsZUFBZSxHQUFHO0FBQ25FLFdBQU8sR0FBRyxPQUFPLE1BQU07QUFBQSxFQUN6QixDQUFDO0FBRUQsT0FBSyx3Q0FBd0MsQ0FBQyxNQUFNO0FBQ2xELFVBQU0sTUFBTSxZQUFZLEtBQUssT0FBTyxHQUFHLHlCQUF5QixDQUFDO0FBQ2pFLE1BQUUsTUFBTSxNQUFNLE9BQU8sS0FBSyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQyxDQUFDO0FBQzNELGNBQVUsS0FBSyxLQUFLLEtBQUssR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQy9DLGtCQUFjLEtBQUssS0FBSyxPQUFPLFNBQVMsR0FBRyxFQUFFO0FBRTdDLFVBQU0sU0FBUyxrQkFBa0IsaUJBQWlCLGVBQWUsR0FBRztBQUNwRSxXQUFPLEdBQUcsQ0FBQyxPQUFPLE1BQU07QUFDeEIsV0FBTyxNQUFNLE9BQU8sY0FBYyxJQUFJO0FBQUEsRUFDeEMsQ0FBQztBQUlELE9BQUssMERBQTBELENBQUMsTUFBTTtBQUNwRSxVQUFNLE1BQU0sWUFBWSxLQUFLLE9BQU8sR0FBRyx1QkFBdUIsQ0FBQztBQUMvRCxNQUFFLE1BQU0sTUFBTSxPQUFPLEtBQUssRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUMsQ0FBQztBQUMzRCxjQUFVLEtBQUssS0FBSyxLQUFLLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUMvQyxrQkFBYyxLQUFLLEtBQUssT0FBTyxVQUFVLEdBQUcsWUFBWTtBQUN4RCxrQkFBYyxLQUFLLEtBQUssT0FBTyxTQUFTLEdBQUcsRUFBRTtBQUU3QyxVQUFNLFNBQVMsa0JBQWtCLGNBQWMsZUFBZSxHQUFHO0FBQ2pFLFdBQU8sR0FBRyxPQUFPLE1BQU07QUFDdkIsV0FBTyxHQUFHLE9BQU8sY0FBYyxTQUFTLFVBQVUsQ0FBQztBQUFBLEVBQ3JELENBQUM7QUFLRCxPQUFLLDZEQUE2RCxDQUFDLE1BQU07QUFDdkUsVUFBTSxNQUFNLFlBQVksS0FBSyxPQUFPLEdBQUcsd0JBQXdCLENBQUM7QUFDaEUsTUFBRSxNQUFNLE1BQU0sT0FBTyxLQUFLLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDLENBQUM7QUFDM0QsY0FBVSxLQUFLLEtBQUssS0FBSyxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDL0Msa0JBQWMsS0FBSyxLQUFLLE9BQU8sZ0JBQWdCLEdBQUcsWUFBWTtBQUM5RCxrQkFBYyxLQUFLLEtBQUssT0FBTyxTQUFTLEdBQUcsRUFBRTtBQUU3QyxVQUFNLFNBQVMsa0JBQWtCLGlCQUFpQixlQUFlLEdBQUc7QUFDcEUsV0FBTyxHQUFHLENBQUMsT0FBTyxNQUFNO0FBQ3hCLFdBQU8sTUFBTSxPQUFPLGNBQWMsSUFBSTtBQUFBLEVBQ3hDLENBQUM7QUFFRCxPQUFLLHFFQUFxRSxDQUFDLE1BQU07QUFDL0UsVUFBTSxNQUFNLFlBQVksS0FBSyxPQUFPLEdBQUcsNEJBQTRCLENBQUM7QUFDcEUsTUFBRSxNQUFNLE1BQU0sT0FBTyxLQUFLLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDLENBQUM7QUFDM0QsY0FBVSxLQUFLLEtBQUssS0FBSyxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDL0Msa0JBQWMsS0FBSyxLQUFLLE9BQU8saUJBQWlCLEdBQUcsY0FBYztBQUNqRSxrQkFBYyxLQUFLLEtBQUssT0FBTyxTQUFTLEdBQUcsRUFBRTtBQUU3QyxVQUFNLFNBQVMsa0JBQWtCLGtCQUFrQixlQUFlLEdBQUc7QUFDckUsV0FBTyxHQUFHLE9BQU8sTUFBTTtBQUN2QixXQUFPLEdBQUcsT0FBTyxjQUFjLFNBQVMsaUJBQWlCLENBQUM7QUFBQSxFQUM1RCxDQUFDO0FBRUQsT0FBSywyRUFBMkUsQ0FBQyxNQUFNO0FBQ3JGLFVBQU0sTUFBTSxZQUFZLEtBQUssT0FBTyxHQUFHLGdDQUFnQyxDQUFDO0FBQ3hFLE1BQUUsTUFBTSxNQUFNLE9BQU8sS0FBSyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQyxDQUFDO0FBQzNELGNBQVUsS0FBSyxLQUFLLEtBQUssR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQy9DLGtCQUFjLEtBQUssS0FBSyxPQUFPLGNBQWMsR0FBRyxjQUFjO0FBQzlELGtCQUFjLEtBQUssS0FBSyxPQUFPLFNBQVMsR0FBRyxFQUFFO0FBRTdDLFVBQU0sU0FBUyxrQkFBa0IsZUFBZSxlQUFlLEdBQUc7QUFDbEUsV0FBTyxHQUFHLENBQUMsT0FBTyxNQUFNO0FBQ3hCLFdBQU8sTUFBTSxPQUFPLGNBQWMsSUFBSTtBQUFBLEVBQ3hDLENBQUM7QUFDSCxDQUFDO0FBSUQsU0FBUyx5QkFBeUIsTUFBTTtBQUN0QyxNQUFJO0FBRUosT0FBSyxtQ0FBbUMsTUFBTTtBQUM1QyxjQUFVLEtBQUssT0FBTyxHQUFHLGtCQUFrQixLQUFLLElBQUksQ0FBQyxFQUFFO0FBQ3ZELGNBQVUsU0FBUyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3RDLGNBQVUsS0FBSyxTQUFTLEtBQUssR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ25ELGtCQUFjLEtBQUssU0FBUyxPQUFPLFVBQVUsR0FBRyxxQkFBcUI7QUFDckU7QUFBQSxNQUNFLEtBQUssU0FBUyxPQUFPLFNBQVM7QUFBQSxNQUM5QjtBQUFBLElBQ0Y7QUFFQSxRQUFJO0FBQ0YsWUFBTSxPQUFPLFdBQVc7QUFBQSxRQUN0QixJQUFJO0FBQUEsUUFDSixXQUFXLENBQUMsYUFBYTtBQUFBLE1BQzNCLENBQUM7QUFFRCxZQUFNLFVBQVUsc0JBQXNCLE1BQU0sQ0FBQyxHQUFHLE9BQU87QUFDdkQsYUFBTyxVQUFVLFNBQVMsQ0FBQyxDQUFDO0FBQUEsSUFDOUIsVUFBRTtBQUNBLGFBQU8sU0FBUyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQ2xEO0FBQUEsRUFDRixDQUFDO0FBRUQsT0FBSyxpREFBaUQsTUFBTTtBQUMxRCxjQUFVLEtBQUssT0FBTyxHQUFHLGtCQUFrQixLQUFLLElBQUksQ0FBQyxFQUFFO0FBQ3ZELGNBQVUsU0FBUyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3RDLGNBQVUsS0FBSyxTQUFTLE9BQU8sUUFBUSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDN0Q7QUFBQSxNQUNFLEtBQUssU0FBUyxPQUFPLFVBQVUsVUFBVTtBQUFBLE1BQ3pDO0FBQUEsSUFDRjtBQUVBLFFBQUk7QUFDRixZQUFNLE9BQU8sV0FBVztBQUFBLFFBQ3RCLElBQUk7QUFBQSxRQUNKLFdBQVcsQ0FBQyxxQkFBcUI7QUFBQSxNQUNuQyxDQUFDO0FBRUQsWUFBTSxVQUFVLHNCQUFzQixNQUFNLENBQUMsR0FBRyxPQUFPO0FBQ3ZELGFBQU8sVUFBVSxTQUFTLENBQUMsQ0FBQztBQUFBLElBQzlCLFVBQUU7QUFDQSxhQUFPLFNBQVMsRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUNsRDtBQUFBLEVBQ0YsQ0FBQztBQUVELE9BQUsscUNBQXFDLE1BQU07QUFDOUMsY0FBVSxLQUFLLE9BQU8sR0FBRyxrQkFBa0IsS0FBSyxJQUFJLENBQUMsRUFBRTtBQUN2RCxjQUFVLFNBQVMsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUN0QyxjQUFVLEtBQUssU0FBUyxLQUFLLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNuRDtBQUFBLE1BQ0UsS0FBSyxTQUFTLE9BQU8sU0FBUztBQUFBLE1BQzlCO0FBQUEsSUFDRjtBQUVBLFFBQUk7QUFDRixZQUFNLE9BQU8sV0FBVztBQUFBLFFBQ3RCLElBQUk7QUFBQSxRQUNKLFdBQVcsQ0FBQyxhQUFhO0FBQUEsTUFDM0IsQ0FBQztBQUVELFlBQU0sVUFBVSxzQkFBc0IsTUFBTSxDQUFDLEdBQUcsT0FBTztBQUN2RCxhQUFPLE1BQU0sUUFBUSxRQUFRLENBQUM7QUFDOUIsYUFBTyxNQUFNLFFBQVEsQ0FBQyxFQUFFLFVBQVUsUUFBUTtBQUMxQyxhQUFPLE1BQU0sUUFBUSxDQUFDLEVBQUUsUUFBUSxLQUFLO0FBQ3JDLGFBQU8sTUFBTSxRQUFRLENBQUMsRUFBRSxVQUFVLElBQUk7QUFDdEMsYUFBTyxHQUFHLFFBQVEsQ0FBQyxFQUFFLFFBQVEsU0FBUyxhQUFhLENBQUM7QUFDcEQsYUFBTyxHQUFHLFFBQVEsQ0FBQyxFQUFFLE9BQU8sU0FBUyxhQUFhLENBQUM7QUFBQSxJQUNyRCxVQUFFO0FBQ0EsYUFBTyxTQUFTLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDbEQ7QUFBQSxFQUNGLENBQUM7QUFFRCxPQUFLLHlCQUF5QixNQUFNO0FBQ2xDLGNBQVUsS0FBSyxPQUFPLEdBQUcsa0JBQWtCLEtBQUssSUFBSSxDQUFDLEVBQUU7QUFDdkQsY0FBVSxTQUFTLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDdEMsa0JBQWMsS0FBSyxTQUFTLFdBQVcsR0FBRyxRQUFRO0FBRWxELFFBQUk7QUFDRixZQUFNLE9BQU8sV0FBVztBQUFBLFFBQ3RCLElBQUk7QUFBQSxRQUNKLFdBQVcsQ0FBQyxXQUFXO0FBQUEsTUFDekIsQ0FBQztBQUVELFlBQU0sVUFBVSxzQkFBc0IsTUFBTSxDQUFDLEdBQUcsT0FBTztBQUN2RCxhQUFPLFVBQVUsU0FBUyxDQUFDLENBQUM7QUFBQSxJQUM5QixVQUFFO0FBQ0EsYUFBTyxTQUFTLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDbEQ7QUFBQSxFQUNGLENBQUM7QUFFRCxPQUFLLGdEQUFnRCxNQUFNO0FBQ3pELGNBQVUsS0FBSyxPQUFPLEdBQUcsa0JBQWtCLEtBQUssSUFBSSxDQUFDLEVBQUU7QUFDdkQsY0FBVSxTQUFTLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDdEMsY0FBVSxLQUFLLFNBQVMsS0FBSyxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDbkQsa0JBQWMsS0FBSyxTQUFTLE9BQU8sVUFBVSxHQUFHLHFCQUFxQjtBQUNyRTtBQUFBLE1BQ0UsS0FBSyxTQUFTLE9BQU8sTUFBTTtBQUFBLE1BQzNCO0FBQUEsSUFDRjtBQUNBO0FBQUEsTUFDRSxLQUFLLFNBQVMsT0FBTyxNQUFNO0FBQUEsTUFDM0I7QUFBQSxJQUNGO0FBRUEsUUFBSTtBQUNGLFlBQU0sT0FBTyxXQUFXO0FBQUEsUUFDdEIsSUFBSTtBQUFBLFFBQ0osV0FBVyxDQUFDLFlBQVksVUFBVTtBQUFBLE1BQ3BDLENBQUM7QUFFRCxZQUFNLFVBQVUsc0JBQXNCLE1BQU0sQ0FBQyxHQUFHLE9BQU87QUFDdkQsYUFBTyxNQUFNLFFBQVEsUUFBUSxDQUFDO0FBQzlCLGFBQU8sR0FBRyxRQUFRLEtBQUssQ0FBQyxNQUFNLEVBQUUsUUFBUSxTQUFTLFNBQVMsQ0FBQyxDQUFDO0FBQzVELGFBQU8sR0FBRyxRQUFRLEtBQUssQ0FBQyxNQUFNLEVBQUUsUUFBUSxTQUFTLGNBQWMsQ0FBQyxDQUFDO0FBQUEsSUFDbkUsVUFBRTtBQUNBLGFBQU8sU0FBUyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQ2xEO0FBQUEsRUFDRixDQUFDO0FBRUQsT0FBSyxtQ0FBbUMsTUFBTTtBQUM1QyxjQUFVLEtBQUssT0FBTyxHQUFHLGtCQUFrQixLQUFLLElBQUksQ0FBQyxFQUFFO0FBQ3ZELGNBQVUsU0FBUyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBRXRDLFFBQUk7QUFDRixZQUFNLE9BQU8sV0FBVztBQUFBLFFBQ3RCLElBQUk7QUFBQSxRQUNKLFdBQVcsQ0FBQyxnQkFBZ0I7QUFBQSxNQUM5QixDQUFDO0FBRUQsWUFBTSxVQUFVLHNCQUFzQixNQUFNLENBQUMsR0FBRyxPQUFPO0FBQ3ZELGFBQU8sVUFBVSxTQUFTLENBQUMsQ0FBQztBQUFBLElBQzlCLFVBQUU7QUFDQSxhQUFPLFNBQVMsRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUNsRDtBQUFBLEVBQ0YsQ0FBQztBQUlELE9BQUssbUVBQW1FLENBQUMsTUFBTTtBQUM3RSxVQUFNLE1BQU0sWUFBWSxLQUFLLE9BQU8sR0FBRyx1QkFBdUIsQ0FBQztBQUMvRCxNQUFFLE1BQU0sTUFBTSxPQUFPLEtBQUssRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUMsQ0FBQztBQUczRCxjQUFVLEtBQUssS0FBSyxZQUFZLE9BQU8sUUFBUSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDckUsY0FBVSxLQUFLLEtBQUssWUFBWSxRQUFRLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUM5RCxrQkFBYyxLQUFLLEtBQUssWUFBWSxVQUFVLGFBQWEsR0FBRyxFQUFFO0FBQ2hFO0FBQUEsTUFDRSxLQUFLLEtBQUssWUFBWSxPQUFPLFVBQVUsVUFBVTtBQUFBLE1BQ2pEO0FBQUEsSUFDRjtBQUVBLFVBQU0sT0FBTyxXQUFXO0FBQUEsTUFDdEIsSUFBSTtBQUFBLE1BQ0osV0FBVyxDQUFDLDhCQUE4QjtBQUFBLElBQzVDLENBQUM7QUFFRCxVQUFNLFVBQVUsc0JBQXNCLE1BQU0sQ0FBQyxHQUFHLEdBQUc7QUFDbkQsV0FBTyxVQUFVLFNBQVMsQ0FBQyxHQUFHLHNDQUFzQztBQUFBLEVBQ3RFLENBQUM7QUFDSCxDQUFDO0FBSUQsU0FBUyw0QkFBNEIsTUFBTTtBQUN6QyxNQUFJO0FBRUosT0FBSyxvQ0FBb0MsTUFBTTtBQUM3QyxjQUFVLEtBQUssT0FBTyxHQUFHLGtCQUFrQixLQUFLLElBQUksQ0FBQyxFQUFFO0FBQ3ZELGNBQVUsU0FBUyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3RDLGNBQVUsS0FBSyxTQUFTLEtBQUssR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ25EO0FBQUEsTUFDRSxLQUFLLFNBQVMsT0FBTyxRQUFRO0FBQUEsTUFDN0I7QUFBQSxJQUNGO0FBRUEsUUFBSTtBQUNGLFlBQU0sT0FBTyxXQUFXO0FBQUEsUUFDdEIsSUFBSTtBQUFBLFFBQ0osV0FBVyxDQUFDLFlBQVk7QUFBQSxNQUMxQixDQUFDO0FBRUQsWUFBTSxVQUFVLHlCQUF5QixNQUFNLENBQUMsR0FBRyxPQUFPO0FBQzFELGFBQU8sVUFBVSxTQUFTLENBQUMsQ0FBQztBQUFBLElBQzlCLFVBQUU7QUFDQSxhQUFPLFNBQVMsRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUNsRDtBQUFBLEVBQ0YsQ0FBQztBQUVELE9BQUssZ0NBQWdDLE1BQU07QUFDekMsY0FBVSxLQUFLLE9BQU8sR0FBRyxrQkFBa0IsS0FBSyxJQUFJLENBQUMsRUFBRTtBQUN2RCxjQUFVLFNBQVMsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUN0QyxjQUFVLEtBQUssU0FBUyxLQUFLLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNuRDtBQUFBLE1BQ0UsS0FBSyxTQUFTLE9BQU8sVUFBVTtBQUFBLE1BQy9CO0FBQUEsSUFDRjtBQUNBO0FBQUEsTUFDRSxLQUFLLFNBQVMsT0FBTyxRQUFRO0FBQUEsTUFDN0I7QUFBQSxJQUNGO0FBRUEsUUFBSTtBQUNGLFlBQU0sWUFBWSxXQUFXO0FBQUEsUUFDM0IsSUFBSTtBQUFBLFFBQ0osV0FBVyxDQUFDLGNBQWM7QUFBQSxNQUM1QixDQUFDO0FBQ0QsWUFBTSxjQUFjLFdBQVc7QUFBQSxRQUM3QixJQUFJO0FBQUEsUUFDSixXQUFXLENBQUMsWUFBWTtBQUFBLE1BQzFCLENBQUM7QUFFRCxZQUFNLFVBQVUseUJBQXlCLGFBQWEsQ0FBQyxTQUFTLEdBQUcsT0FBTztBQUMxRSxhQUFPLFVBQVUsU0FBUyxDQUFDLENBQUM7QUFBQSxJQUM5QixVQUFFO0FBQ0EsYUFBTyxTQUFTLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDbEQ7QUFBQSxFQUNGLENBQUM7QUFFRCxPQUFLLDhDQUE4QyxNQUFNO0FBQ3ZELGNBQVUsS0FBSyxPQUFPLEdBQUcsa0JBQWtCLEtBQUssSUFBSSxDQUFDLEVBQUU7QUFDdkQsY0FBVSxTQUFTLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDdEMsY0FBVSxLQUFLLFNBQVMsS0FBSyxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDbkQ7QUFBQSxNQUNFLEtBQUssU0FBUyxPQUFPLFVBQVU7QUFBQSxNQUMvQjtBQUFBLElBQ0Y7QUFDQTtBQUFBLE1BQ0UsS0FBSyxTQUFTLE9BQU8sUUFBUTtBQUFBLE1BQzdCO0FBQUEsSUFDRjtBQUVBLFFBQUk7QUFDRixZQUFNLFlBQVksV0FBVztBQUFBLFFBQzNCLElBQUk7QUFBQSxRQUNKLFdBQVcsQ0FBQyxjQUFjO0FBQUEsTUFDNUIsQ0FBQztBQUNELFlBQU0sY0FBYyxXQUFXO0FBQUEsUUFDN0IsSUFBSTtBQUFBLFFBQ0osV0FBVyxDQUFDLFlBQVk7QUFBQSxNQUMxQixDQUFDO0FBRUQsWUFBTSxVQUFVLHlCQUF5QixhQUFhLENBQUMsU0FBUyxHQUFHLE9BQU87QUFDMUUsYUFBTyxNQUFNLFFBQVEsUUFBUSxDQUFDO0FBQzlCLGFBQU8sTUFBTSxRQUFRLENBQUMsRUFBRSxVQUFVLFdBQVc7QUFDN0MsYUFBTyxNQUFNLFFBQVEsQ0FBQyxFQUFFLFFBQVEsTUFBTTtBQUN0QyxhQUFPLE1BQU0sUUFBUSxDQUFDLEVBQUUsUUFBUSxLQUFLO0FBQ3JDLGFBQU8sTUFBTSxRQUFRLENBQUMsRUFBRSxVQUFVLEtBQUs7QUFDdkMsYUFBTyxHQUFHLFFBQVEsQ0FBQyxFQUFFLFFBQVEsU0FBUyxZQUFZLENBQUM7QUFBQSxJQUNyRCxVQUFFO0FBQ0EsYUFBTyxTQUFTLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDbEQ7QUFBQSxFQUNGLENBQUM7QUFFRCxPQUFLLGdEQUFnRCxNQUFNO0FBQ3pELGNBQVUsS0FBSyxPQUFPLEdBQUcsa0JBQWtCLEtBQUssSUFBSSxDQUFDLEVBQUU7QUFDdkQsY0FBVSxTQUFTLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDdEMsY0FBVSxLQUFLLFNBQVMsS0FBSyxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDbkQ7QUFBQSxNQUNFLEtBQUssU0FBUyxPQUFPLFVBQVU7QUFBQSxNQUMvQjtBQUFBLElBQ0Y7QUFDQTtBQUFBLE1BQ0UsS0FBSyxTQUFTLE9BQU8sUUFBUTtBQUFBLE1BQzdCO0FBQUEsSUFDRjtBQUVBLFFBQUk7QUFDRixZQUFNLFlBQVksV0FBVztBQUFBLFFBQzNCLElBQUk7QUFBQSxRQUNKLFdBQVcsQ0FBQyxjQUFjO0FBQUEsTUFDNUIsQ0FBQztBQUNELFlBQU0sY0FBYyxXQUFXO0FBQUEsUUFDN0IsSUFBSTtBQUFBLFFBQ0osV0FBVyxDQUFDLFlBQVk7QUFBQSxNQUMxQixDQUFDO0FBRUQsWUFBTSxVQUFVLHlCQUF5QixhQUFhLENBQUMsU0FBUyxHQUFHLE9BQU87QUFDMUUsYUFBTyxNQUFNLFFBQVEsUUFBUSxDQUFDO0FBQzlCLGFBQU8sR0FBRyxRQUFRLENBQUMsRUFBRSxRQUFRLFNBQVMsUUFBUSxDQUFDO0FBQUEsSUFDakQsVUFBRTtBQUNBLGFBQU8sU0FBUyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQ2xEO0FBQUEsRUFDRixDQUFDO0FBRUQsT0FBSyxnQ0FBZ0MsTUFBTTtBQUN6QyxjQUFVLEtBQUssT0FBTyxHQUFHLGtCQUFrQixLQUFLLElBQUksQ0FBQyxFQUFFO0FBQ3ZELGNBQVUsU0FBUyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3RDLGNBQVUsS0FBSyxTQUFTLEtBQUssR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ25EO0FBQUEsTUFDRSxLQUFLLFNBQVMsT0FBTyxVQUFVO0FBQUEsTUFDL0I7QUFBQSxJQUNGO0FBQ0E7QUFBQSxNQUNFLEtBQUssU0FBUyxPQUFPLFVBQVU7QUFBQSxNQUMvQjtBQUFBLElBQ0Y7QUFDQTtBQUFBLE1BQ0UsS0FBSyxTQUFTLE9BQU8sUUFBUTtBQUFBLE1BQzdCO0FBQUE7QUFBQSxJQUVGO0FBRUEsUUFBSTtBQUNGLFlBQU0sYUFBYSxXQUFXLEVBQUUsSUFBSSxPQUFPLFdBQVcsQ0FBQyxjQUFjLEVBQUUsQ0FBQztBQUN4RSxZQUFNLGFBQWEsV0FBVyxFQUFFLElBQUksT0FBTyxXQUFXLENBQUMsY0FBYyxFQUFFLENBQUM7QUFDeEUsWUFBTSxjQUFjLFdBQVcsRUFBRSxJQUFJLE9BQU8sV0FBVyxDQUFDLFlBQVksRUFBRSxDQUFDO0FBRXZFLFlBQU0sVUFBVTtBQUFBLFFBQ2Q7QUFBQSxRQUNBLENBQUMsWUFBWSxVQUFVO0FBQUEsUUFDdkI7QUFBQSxNQUNGO0FBRUEsYUFBTyxNQUFNLFFBQVEsUUFBUSxDQUFDO0FBQzlCLGFBQU8sR0FBRyxRQUFRLENBQUMsRUFBRSxRQUFRLFNBQVMsT0FBTyxDQUFDO0FBQUEsSUFDaEQsVUFBRTtBQUNBLGFBQU8sU0FBUyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQ2xEO0FBQUEsRUFDRixDQUFDO0FBQ0gsQ0FBQztBQUlELFNBQVMsMkJBQTJCLE1BQU07QUFDeEMsTUFBSTtBQUVKLE9BQUssc0RBQXNELE1BQU07QUFDL0QsY0FBVSxLQUFLLE9BQU8sR0FBRyxrQkFBa0IsS0FBSyxJQUFJLENBQUMsRUFBRTtBQUN2RCxjQUFVLFNBQVMsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUN0QztBQUFBLE1BQ0UsS0FBSyxTQUFTLFFBQVE7QUFBQSxNQUN0QjtBQUFBO0FBQUE7QUFBQTtBQUFBLElBSUY7QUFFQSxRQUFJO0FBQ0YsWUFBTSxPQUFPLFdBQVcsRUFBRSxJQUFJLE9BQU8sV0FBVyxDQUFDLFFBQVEsRUFBRSxDQUFDO0FBQzVELFlBQU0sVUFBVSx3QkFBd0IsTUFBTSxDQUFDLEdBQUcsT0FBTztBQUN6RCxZQUFNLGVBQWUsUUFBUSxPQUFPLENBQUMsTUFBTSxFQUFFLFFBQVEsU0FBUyxPQUFPLENBQUM7QUFDdEUsYUFBTyxNQUFNLGFBQWEsUUFBUSxDQUFDO0FBQUEsSUFDckMsVUFBRTtBQUNBLGFBQU8sU0FBUyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQ2xEO0FBQUEsRUFDRixDQUFDO0FBRUQsT0FBSyxzREFBc0QsTUFBTTtBQUMvRCxjQUFVLEtBQUssT0FBTyxHQUFHLGtCQUFrQixLQUFLLElBQUksQ0FBQyxFQUFFO0FBQ3ZELGNBQVUsU0FBUyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3RDO0FBQUEsTUFDRSxLQUFLLFNBQVMsUUFBUTtBQUFBLE1BQ3RCO0FBQUE7QUFBQTtBQUFBLElBR0Y7QUFFQSxRQUFJO0FBQ0YsWUFBTSxPQUFPLFdBQVcsRUFBRSxJQUFJLE9BQU8sV0FBVyxDQUFDLFFBQVEsRUFBRSxDQUFDO0FBQzVELFlBQU0sVUFBVSx3QkFBd0IsTUFBTSxDQUFDLEdBQUcsT0FBTztBQUN6RCxZQUFNLGVBQWUsUUFBUSxPQUFPLENBQUMsTUFBTSxFQUFFLFFBQVEsU0FBUyxPQUFPLENBQUM7QUFDdEUsYUFBTyxNQUFNLGFBQWEsUUFBUSxDQUFDO0FBQUEsSUFDckMsVUFBRTtBQUNBLGFBQU8sU0FBUyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQ2xEO0FBQUEsRUFDRixDQUFDO0FBRUQsT0FBSyw4Q0FBOEMsTUFBTTtBQUN2RCxjQUFVLEtBQUssT0FBTyxHQUFHLGtCQUFrQixLQUFLLElBQUksQ0FBQyxFQUFFO0FBQ3ZELGNBQVUsU0FBUyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3RDO0FBQUEsTUFDRSxLQUFLLFNBQVMsUUFBUTtBQUFBLE1BQ3RCO0FBQUE7QUFBQTtBQUFBO0FBQUEsSUFJRjtBQUVBLFFBQUk7QUFDRixZQUFNLE9BQU8sV0FBVyxFQUFFLElBQUksT0FBTyxXQUFXLENBQUMsUUFBUSxFQUFFLENBQUM7QUFDNUQsWUFBTSxVQUFVLHdCQUF3QixNQUFNLENBQUMsR0FBRyxPQUFPO0FBQ3pELFlBQU0sZUFBZSxRQUFRLE9BQU8sQ0FBQyxNQUFNLEVBQUUsUUFBUSxTQUFTLE9BQU8sQ0FBQztBQUN0RSxhQUFPLE1BQU0sYUFBYSxRQUFRLENBQUM7QUFDbkMsYUFBTyxNQUFNLGFBQWEsQ0FBQyxFQUFFLFVBQVUsU0FBUztBQUNoRCxhQUFPLE1BQU0sYUFBYSxDQUFDLEVBQUUsUUFBUSxJQUFJO0FBQ3pDLGFBQU8sTUFBTSxhQUFhLENBQUMsRUFBRSxVQUFVLEtBQUs7QUFBQSxJQUM5QyxVQUFFO0FBQ0EsYUFBTyxTQUFTLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDbEQ7QUFBQSxFQUNGLENBQUM7QUFFRCxPQUFLLHFEQUFxRCxNQUFNO0FBQzlELGNBQVUsS0FBSyxPQUFPLEdBQUcsa0JBQWtCLEtBQUssSUFBSSxDQUFDLEVBQUU7QUFDdkQsY0FBVSxTQUFTLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDdEM7QUFBQSxNQUNFLEtBQUssU0FBUyxRQUFRO0FBQUEsTUFDdEI7QUFBQTtBQUFBO0FBQUEsSUFHRjtBQUVBLFFBQUk7QUFDRixZQUFNLE9BQU8sV0FBVyxFQUFFLElBQUksT0FBTyxXQUFXLENBQUMsUUFBUSxFQUFFLENBQUM7QUFDNUQsWUFBTSxVQUFVLHdCQUF3QixNQUFNLENBQUMsR0FBRyxPQUFPO0FBQ3pELFlBQU0sZ0JBQWdCLFFBQVEsT0FBTyxDQUFDLE1BQU0sRUFBRSxRQUFRLFNBQVMsUUFBUSxLQUFLLEVBQUUsUUFBUSxTQUFTLE1BQU0sQ0FBQztBQUN0RyxhQUFPLE1BQU0sY0FBYyxRQUFRLENBQUM7QUFBQSxJQUN0QyxVQUFFO0FBQ0EsYUFBTyxTQUFTLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDbEQ7QUFBQSxFQUNGLENBQUM7QUFFRCxPQUFLLDhDQUE4QyxNQUFNO0FBQ3ZELGNBQVUsS0FBSyxPQUFPLEdBQUcsa0JBQWtCLEtBQUssSUFBSSxDQUFDLEVBQUU7QUFDdkQsY0FBVSxTQUFTLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDdEM7QUFBQSxNQUNFLEtBQUssU0FBUyxRQUFRO0FBQUEsTUFDdEI7QUFBQTtBQUFBO0FBQUEsSUFHRjtBQUVBLFFBQUk7QUFDRixZQUFNLE9BQU8sV0FBVyxFQUFFLElBQUksT0FBTyxXQUFXLENBQUMsUUFBUSxFQUFFLENBQUM7QUFDNUQsWUFBTSxVQUFVLHdCQUF3QixNQUFNLENBQUMsR0FBRyxPQUFPO0FBQ3pELFlBQU0sZ0JBQWdCLFFBQVEsT0FBTyxDQUFDLE1BQU0sRUFBRSxRQUFRLFNBQVMsV0FBVyxLQUFLLEVBQUUsUUFBUSxTQUFTLFlBQVksQ0FBQztBQUMvRyxhQUFPLE1BQU0sY0FBYyxRQUFRLENBQUM7QUFDcEMsYUFBTyxNQUFNLGNBQWMsQ0FBQyxFQUFFLFVBQVUsU0FBUztBQUNqRCxhQUFPLE1BQU0sY0FBYyxDQUFDLEVBQUUsVUFBVSxLQUFLO0FBQUEsSUFDL0MsVUFBRTtBQUNBLGFBQU8sU0FBUyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQ2xEO0FBQUEsRUFDRixDQUFDO0FBRUQsT0FBSyx5QkFBeUIsTUFBTTtBQUNsQyxjQUFVLEtBQUssT0FBTyxHQUFHLGtCQUFrQixLQUFLLElBQUksQ0FBQyxFQUFFO0FBQ3ZELGNBQVUsU0FBUyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3RDLGtCQUFjLEtBQUssU0FBUyxhQUFhLEdBQUcsa0JBQWtCO0FBRTlELFFBQUk7QUFDRixZQUFNLE9BQU8sV0FBVyxFQUFFLElBQUksT0FBTyxXQUFXLENBQUMsYUFBYSxFQUFFLENBQUM7QUFDakUsWUFBTSxVQUFVLHdCQUF3QixNQUFNLENBQUMsR0FBRyxPQUFPO0FBQ3pELGFBQU8sVUFBVSxTQUFTLENBQUMsQ0FBQztBQUFBLElBQzlCLFVBQUU7QUFDQSxhQUFPLFNBQVMsRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUNsRDtBQUFBLEVBQ0YsQ0FBQztBQUNILENBQUM7QUFJRCxTQUFTLDBCQUEwQixNQUFNO0FBQ3ZDLE1BQUk7QUFFSixPQUFLLDRDQUE0QyxNQUFNO0FBQ3JELGNBQVUsS0FBSyxPQUFPLEdBQUcsa0JBQWtCLEtBQUssSUFBSSxDQUFDLEVBQUU7QUFDdkQsY0FBVSxTQUFTLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDdEMsY0FBVSxLQUFLLFNBQVMsS0FBSyxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDbkQsa0JBQWMsS0FBSyxTQUFTLE9BQU8sVUFBVSxHQUFHLHFCQUFxQjtBQUNyRTtBQUFBLE1BQ0UsS0FBSyxTQUFTLE9BQU8sU0FBUztBQUFBLE1BQzlCO0FBQUE7QUFBQSxJQUVGO0FBRUEsUUFBSTtBQUNGLFlBQU0sT0FBTyxXQUFXLEVBQUUsSUFBSSxPQUFPLFdBQVcsQ0FBQyxhQUFhLEVBQUUsQ0FBQztBQUNqRSxZQUFNLFNBQVMsdUJBQXVCLE1BQU0sQ0FBQyxHQUFHLE9BQU87QUFDdkQsYUFBTyxNQUFNLE9BQU8sUUFBUSxNQUFNO0FBQ2xDLGFBQU8sTUFBTSxPQUFPLE9BQU8sUUFBUSxDQUFDO0FBQ3BDLGFBQU8sR0FBRyxPQUFPLGNBQWMsQ0FBQztBQUFBLElBQ2xDLFVBQUU7QUFDQSxhQUFPLFNBQVMsRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUNsRDtBQUFBLEVBQ0YsQ0FBQztBQUVELE9BQUssNkRBQTZELE1BQU07QUFDdEUsY0FBVSxLQUFLLE9BQU8sR0FBRyxrQkFBa0IsS0FBSyxJQUFJLENBQUMsRUFBRTtBQUN2RCxjQUFVLFNBQVMsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUN0QyxjQUFVLEtBQUssU0FBUyxPQUFPLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNyRCxrQkFBYyxLQUFLLFNBQVMsU0FBUyxlQUFlLEdBQUcsc0JBQXNCO0FBQzdFO0FBQUEsTUFDRSxLQUFLLFNBQVMsU0FBUyx5QkFBeUI7QUFBQSxNQUNoRDtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxJQVNGO0FBRUEsUUFBSTtBQUNGLFlBQU0sT0FBTyxXQUFXO0FBQUEsUUFDdEIsSUFBSTtBQUFBLFFBQ0osV0FBVyxDQUFDLCtCQUErQjtBQUFBLE1BQzdDLENBQUM7QUFDRCxZQUFNLFNBQVMsdUJBQXVCLE1BQU0sQ0FBQyxHQUFHLE9BQU87QUFDdkQsYUFBTyxNQUFNLE9BQU8sUUFBUSxNQUFNO0FBQ2xDLGFBQU8sVUFBVSxPQUFPLFFBQVEsQ0FBQyxDQUFDO0FBQUEsSUFDcEMsVUFBRTtBQUNBLGFBQU8sU0FBUyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQ2xEO0FBQUEsRUFDRixDQUFDO0FBRUQsT0FBSyxvREFBb0QsTUFBTTtBQUM3RCxjQUFVLEtBQUssT0FBTyxHQUFHLGtCQUFrQixLQUFLLElBQUksQ0FBQyxFQUFFO0FBQ3ZELGNBQVUsU0FBUyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3RDLGNBQVUsS0FBSyxTQUFTLEtBQUssR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ25EO0FBQUEsTUFDRSxLQUFLLFNBQVMsT0FBTyxTQUFTO0FBQUEsTUFDOUI7QUFBQSxJQUNGO0FBRUEsUUFBSTtBQUNGLFlBQU0sT0FBTyxXQUFXLEVBQUUsSUFBSSxPQUFPLFdBQVcsQ0FBQyxhQUFhLEVBQUUsQ0FBQztBQUNqRSxZQUFNLFNBQVMsdUJBQXVCLE1BQU0sQ0FBQyxHQUFHLE9BQU87QUFDdkQsYUFBTyxNQUFNLE9BQU8sUUFBUSxNQUFNO0FBQ2xDLGFBQU8sR0FBRyxPQUFPLE9BQU8sU0FBUyxDQUFDO0FBQ2xDLGFBQU8sR0FBRyxPQUFPLE9BQU8sS0FBSyxDQUFDLE1BQU0sRUFBRSxhQUFhLElBQUksQ0FBQztBQUFBLElBQzFELFVBQUU7QUFDQSxhQUFPLFNBQVMsRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUNsRDtBQUFBLEVBQ0YsQ0FBQztBQUVELE9BQUssb0RBQW9ELE1BQU07QUFDN0QsY0FBVSxLQUFLLE9BQU8sR0FBRyxrQkFBa0IsS0FBSyxJQUFJLENBQUMsRUFBRTtBQUN2RCxjQUFVLFNBQVMsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUN0QyxjQUFVLEtBQUssU0FBUyxLQUFLLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNuRDtBQUFBLE1BQ0UsS0FBSyxTQUFTLE9BQU8sUUFBUTtBQUFBLE1BQzdCO0FBQUE7QUFBQTtBQUFBO0FBQUEsSUFJRjtBQUVBLFFBQUk7QUFDRixZQUFNLE9BQU8sV0FBVyxFQUFFLElBQUksT0FBTyxXQUFXLENBQUMsWUFBWSxFQUFFLENBQUM7QUFDaEUsWUFBTSxTQUFTLHVCQUF1QixNQUFNLENBQUMsR0FBRyxPQUFPO0FBQ3ZELGFBQU8sTUFBTSxPQUFPLFFBQVEsTUFBTTtBQUNsQyxhQUFPLEdBQUcsT0FBTyxPQUFPLEtBQUssQ0FBQyxNQUFNLEVBQUUsYUFBYSxTQUFTLENBQUM7QUFBQSxJQUMvRCxVQUFFO0FBQ0EsYUFBTyxTQUFTLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDbEQ7QUFBQSxFQUNGLENBQUM7QUFFRCxPQUFLLHlDQUF5QyxNQUFNO0FBQ2xELGNBQVUsS0FBSyxPQUFPLEdBQUcsa0JBQWtCLEtBQUssSUFBSSxDQUFDLEVBQUU7QUFDdkQsY0FBVSxTQUFTLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDdEMsY0FBVSxLQUFLLFNBQVMsS0FBSyxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDbkQ7QUFBQSxNQUNFLEtBQUssU0FBUyxPQUFPLFVBQVU7QUFBQSxNQUMvQjtBQUFBLElBQ0Y7QUFDQTtBQUFBLE1BQ0UsS0FBSyxTQUFTLE9BQU8sUUFBUTtBQUFBLE1BQzdCO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLElBTUY7QUFFQSxRQUFJO0FBQ0YsWUFBTSxZQUFZLFdBQVcsRUFBRSxJQUFJLE9BQU8sV0FBVyxDQUFDLGNBQWMsRUFBRSxDQUFDO0FBQ3ZFLFlBQU0sY0FBYyxXQUFXLEVBQUUsSUFBSSxPQUFPLFdBQVcsQ0FBQyxZQUFZLEVBQUUsQ0FBQztBQUV2RSxZQUFNLFNBQVMsdUJBQXVCLGFBQWEsQ0FBQyxTQUFTLEdBQUcsT0FBTztBQUN2RSxhQUFPLE1BQU0sT0FBTyxRQUFRLE1BQU07QUFFbEMsWUFBTSxhQUFhLElBQUksSUFBSSxPQUFPLE9BQU8sSUFBSSxDQUFDLE1BQU0sRUFBRSxRQUFRLENBQUM7QUFDL0QsYUFBTyxHQUFHLFdBQVcsSUFBSSxRQUFRLENBQUM7QUFDbEMsYUFBTyxHQUFHLFdBQVcsSUFBSSxXQUFXLENBQUM7QUFDckMsYUFBTyxHQUFHLFdBQVcsSUFBSSxTQUFTLENBQUM7QUFBQSxJQUNyQyxVQUFFO0FBQ0EsYUFBTyxTQUFTLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDbEQ7QUFBQSxFQUNGLENBQUM7QUFFRCxPQUFLLG9DQUFvQyxNQUFNO0FBQzdDLGNBQVUsS0FBSyxPQUFPLEdBQUcsa0JBQWtCLEtBQUssSUFBSSxDQUFDLEVBQUU7QUFDdkQsY0FBVSxTQUFTLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFFdEMsUUFBSTtBQUNGLFlBQU0sT0FBTyxXQUFXLEVBQUUsSUFBSSxPQUFPLFdBQVcsQ0FBQyxFQUFFLENBQUM7QUFDcEQsWUFBTSxTQUFTLHVCQUF1QixNQUFNLENBQUMsR0FBRyxPQUFPO0FBQ3ZELGFBQU8sR0FBRyxPQUFPLE9BQU8sZUFBZSxRQUFRO0FBQy9DLGFBQU8sR0FBRyxPQUFPLGNBQWMsQ0FBQztBQUFBLElBQ2xDLFVBQUU7QUFDQSxhQUFPLFNBQVMsRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUNsRDtBQUFBLEVBQ0YsQ0FBQztBQUVELE9BQUssaUNBQWlDLE1BQU07QUFDMUMsY0FBVSxLQUFLLE9BQU8sR0FBRyxrQkFBa0IsS0FBSyxJQUFJLENBQUMsRUFBRTtBQUN2RCxjQUFVLFNBQVMsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUV0QyxRQUFJO0FBQ0YsWUFBTSxPQUFPLFdBQVcsRUFBRSxJQUFJLE9BQU8sV0FBVyxDQUFDLEVBQUUsQ0FBQztBQUNwRCxZQUFNLFNBQVMsdUJBQXVCLE1BQU0sQ0FBQyxHQUFHLE9BQU87QUFDdkQsYUFBTyxNQUFNLE9BQU8sUUFBUSxNQUFNO0FBQ2xDLGFBQU8sVUFBVSxPQUFPLFFBQVEsQ0FBQyxDQUFDO0FBQUEsSUFDcEMsVUFBRTtBQUNBLGFBQU8sU0FBUyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQ2xEO0FBQUEsRUFDRixDQUFDO0FBQ0gsQ0FBQztBQUlELFNBQVMsNEJBQTRCLE1BQU07QUFDekMsT0FBSyxxQ0FBcUMsTUFBTTtBQUM5QyxVQUFNLFVBQVUsS0FBSyxPQUFPLEdBQUcsa0JBQWtCLEtBQUssSUFBSSxDQUFDLEVBQUU7QUFDN0QsY0FBVSxTQUFTLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFFdEMsUUFBSTtBQUNGLFlBQU0sT0FBTyxXQUFXLEVBQUUsSUFBSSxPQUFPLFdBQVcsQ0FBQyxFQUFFLENBQUM7QUFDcEQsWUFBTSxTQUFTLHVCQUF1QixNQUFNLENBQUMsR0FBRyxPQUFPO0FBQ3ZELGFBQU8sR0FBRyxDQUFDLFFBQVEsUUFBUSxNQUFNLEVBQUUsU0FBUyxPQUFPLE1BQU0sQ0FBQztBQUFBLElBQzVELFVBQUU7QUFDQSxhQUFPLFNBQVMsRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUNsRDtBQUFBLEVBQ0YsQ0FBQztBQUVELE9BQUssc0RBQXNELE1BQU07QUFDL0QsVUFBTSxVQUFVLEtBQUssT0FBTyxHQUFHLGtCQUFrQixLQUFLLElBQUksQ0FBQyxFQUFFO0FBQzdELGNBQVUsU0FBUyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3RDLGNBQVUsS0FBSyxTQUFTLEtBQUssR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ25EO0FBQUEsTUFDRSxLQUFLLFNBQVMsT0FBTyxTQUFTO0FBQUEsTUFDOUI7QUFBQSxJQUNGO0FBRUEsUUFBSTtBQUNGLFlBQU0sT0FBTyxXQUFXLEVBQUUsSUFBSSxPQUFPLFdBQVcsQ0FBQyxhQUFhLEVBQUUsQ0FBQztBQUNqRSxZQUFNLFNBQVMsdUJBQXVCLE1BQU0sQ0FBQyxHQUFHLE9BQU87QUFFdkQsaUJBQVcsU0FBUyxPQUFPLFFBQVE7QUFDakMsZUFBTztBQUFBLFVBQ0wsQ0FBQyxVQUFVLGFBQWEsU0FBUyxFQUFFLFNBQVMsTUFBTSxRQUFRO0FBQUEsVUFDMUQscUJBQXFCLE1BQU0sUUFBUTtBQUFBLFFBQ3JDO0FBQ0EsZUFBTyxHQUFHLE9BQU8sTUFBTSxXQUFXLFFBQVE7QUFDMUMsZUFBTyxHQUFHLE9BQU8sTUFBTSxXQUFXLFNBQVM7QUFDM0MsZUFBTyxHQUFHLE9BQU8sTUFBTSxZQUFZLFFBQVE7QUFDM0MsWUFBSSxNQUFNLGFBQWEsUUFBVztBQUNoQyxpQkFBTyxHQUFHLE9BQU8sTUFBTSxhQUFhLFNBQVM7QUFBQSxRQUMvQztBQUFBLE1BQ0Y7QUFBQSxJQUNGLFVBQUU7QUFDQSxhQUFPLFNBQVMsRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUNsRDtBQUFBLEVBQ0YsQ0FBQztBQUNILENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
