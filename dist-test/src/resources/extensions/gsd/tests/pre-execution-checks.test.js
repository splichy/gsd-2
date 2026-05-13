import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  extractPackageReferences,
  checkFilePathConsistency,
  checkTaskOrdering,
  checkInterfaceContracts,
  checkVerificationCommands,
  runPreExecutionChecks,
  normalizeFilePath
} from "../pre-execution-checks.js";
function createTask(overrides = {}) {
  return {
    milestone_id: "M001",
    slice_id: "S01",
    id: overrides.id ?? "T01",
    title: "Test Task",
    status: "pending",
    one_liner: "",
    narrative: "",
    verification_result: "",
    duration: "",
    completed_at: null,
    blocker_discovered: false,
    deviations: "",
    known_issues: "",
    key_files: [],
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
describe("extractPackageReferences", () => {
  test("extracts npm install patterns", () => {
    const desc = "Run npm install lodash then npm i axios";
    const packages = extractPackageReferences(desc);
    assert.deepEqual(packages.sort(), ["axios", "lodash"]);
  });
  test("extracts yarn add patterns", () => {
    const desc = "yarn add react-dom";
    const packages = extractPackageReferences(desc);
    assert.deepEqual(packages, ["react-dom"]);
  });
  test("extracts scoped packages", () => {
    const desc = "npm install @types/node @babel/core";
    const packages = extractPackageReferences(desc);
    assert.ok(packages.includes("@types/node"));
    assert.ok(packages.includes("@babel/core"));
  });
  test("extracts require statements from code blocks", () => {
    const desc = `
\`\`\`javascript
const fs = require('fs-extra');
const path = require('path');
\`\`\`
    `;
    const packages = extractPackageReferences(desc);
    assert.ok(packages.includes("fs-extra"));
  });
  test("extracts import statements from code blocks", () => {
    const desc = `
\`\`\`typescript
import express from 'express';
import { Router } from 'express';
import type { Request } from 'express';
\`\`\`
    `;
    const packages = extractPackageReferences(desc);
    assert.ok(packages.includes("express"));
  });
  test("ignores relative imports", () => {
    const desc = `import { foo } from './local-file';`;
    const packages = extractPackageReferences(desc);
    assert.deepEqual(packages, []);
  });
  test("ignores node builtins", () => {
    const desc = `import fs from 'node:fs';`;
    const packages = extractPackageReferences(desc);
    assert.deepEqual(packages, []);
  });
  test("normalizes package subpaths", () => {
    const desc = "npm install lodash/get";
    const packages = extractPackageReferences(desc);
    assert.deepEqual(packages, ["lodash"]);
  });
  test("handles empty description", () => {
    const packages = extractPackageReferences("");
    assert.deepEqual(packages, []);
  });
  test("ignores flags in npm install", () => {
    const desc = "npm install -D typescript";
    const packages = extractPackageReferences(desc);
    assert.ok(packages.includes("typescript"));
    assert.ok(!packages.includes("-D"));
  });
  test(`does not treat prose 'from "What's Next"' as a package name (#4388)`, () => {
    const desc = `Build the feature described from "What's Next" in the roadmap`;
    const packages = extractPackageReferences(desc);
    assert.deepEqual(packages, [], `prose 'from "What\\'s Next"' must not produce package names, got: ${JSON.stringify(packages)}`);
  });
  test(`does not treat prose "from 'master'" as a package name (#4388)`, () => {
    const desc = "Review changes from 'master' branch before merging";
    const packages = extractPackageReferences(desc);
    assert.deepEqual(packages, [], `prose "from 'master'" must not produce package names, got: ${JSON.stringify(packages)}`);
  });
  test("still extracts import statements in code blocks after #4388 fix", () => {
    const desc = "```typescript\nimport express from 'express';\nimport { Router } from 'express';\n```";
    const packages = extractPackageReferences(desc);
    assert.ok(packages.includes("express"), "import...from in code blocks must still be recognized");
  });
});
describe("checkFilePathConsistency", () => {
  let tempDir;
  test("passes when files exist on disk", () => {
    tempDir = join(tmpdir(), `pre-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, "existing.ts"), "// content");
    try {
      const tasks = [
        createTask({
          id: "T01",
          files: ["existing.ts"],
          inputs: [],
          expected_output: []
        })
      ];
      const results = checkFilePathConsistency(tasks, tempDir);
      assert.deepEqual(results, []);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("passes when files are in prior expected_output", () => {
    tempDir = join(tmpdir(), `pre-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    try {
      const tasks = [
        createTask({
          id: "T01",
          sequence: 0,
          files: [],
          inputs: [],
          expected_output: ["generated.ts"]
        }),
        createTask({
          id: "T02",
          sequence: 1,
          files: ["generated.ts"],
          inputs: [],
          expected_output: []
        })
      ];
      const results = checkFilePathConsistency(tasks, tempDir);
      assert.deepEqual(results, []);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("fails when inputs don't exist and not in prior outputs", () => {
    tempDir = join(tmpdir(), `pre-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    try {
      const tasks = [
        createTask({
          id: "T01",
          files: [],
          inputs: ["nonexistent.ts"],
          expected_output: []
        })
      ];
      const results = checkFilePathConsistency(tasks, tempDir);
      assert.equal(results.length, 1);
      assert.equal(results[0].category, "file");
      assert.equal(results[0].passed, false);
      assert.equal(results[0].blocking, true);
      assert.ok(results[0].message.includes("nonexistent.ts"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("checks only inputs array, not files array", () => {
    tempDir = join(tmpdir(), `pre-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    try {
      const tasks = [
        createTask({
          id: "T01",
          files: ["missing-file.ts"],
          inputs: ["missing-input.ts"],
          expected_output: []
        })
      ];
      const results = checkFilePathConsistency(tasks, tempDir);
      assert.equal(results.length, 1);
      assert.ok(results.some((r) => r.target === "missing-input.ts"));
      assert.ok(!results.some((r) => r.target === "missing-file.ts"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("skips empty file strings", () => {
    tempDir = join(tmpdir(), `pre-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    try {
      const tasks = [
        createTask({
          id: "T01",
          files: ["", "  "],
          inputs: [],
          expected_output: []
        })
      ];
      const results = checkFilePathConsistency(tasks, tempDir);
      assert.deepEqual(results, []);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
describe("normalizeFilePath", () => {
  test("strips leading ./", () => {
    assert.equal(normalizeFilePath("./src/a.ts"), "src/a.ts");
    assert.equal(normalizeFilePath("././foo.ts"), "foo.ts");
  });
  test("normalizes backslashes to forward slashes", () => {
    assert.equal(normalizeFilePath("src\\a.ts"), "src/a.ts");
    assert.equal(normalizeFilePath("src\\sub\\file.ts"), "src/sub/file.ts");
  });
  test("removes duplicate slashes", () => {
    assert.equal(normalizeFilePath("src//a.ts"), "src/a.ts");
    assert.equal(normalizeFilePath("src///sub//file.ts"), "src/sub/file.ts");
  });
  test("handles empty string", () => {
    assert.equal(normalizeFilePath(""), "");
  });
  test("removes trailing slash", () => {
    assert.equal(normalizeFilePath("src/"), "src");
    assert.equal(normalizeFilePath("src/sub/"), "src/sub");
  });
  test("handles paths without any normalization needed", () => {
    assert.equal(normalizeFilePath("src/a.ts"), "src/a.ts");
    assert.equal(normalizeFilePath("index.ts"), "index.ts");
  });
});
describe("checkFilePathConsistency with path normalization", () => {
  let tempDir;
  test("./path matches path in prior expected_output", () => {
    tempDir = join(tmpdir(), `pre-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    try {
      const tasks = [
        createTask({
          id: "T01",
          sequence: 0,
          files: [],
          inputs: [],
          expected_output: ["src/generated.ts"]
          // Output without ./
        }),
        createTask({
          id: "T02",
          sequence: 1,
          files: ["./src/generated.ts"],
          // Input with ./
          inputs: [],
          expected_output: []
        })
      ];
      const results = checkFilePathConsistency(tasks, tempDir);
      assert.deepEqual(results, [], "Should pass because ./src/generated.ts matches src/generated.ts");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("path matches ./path in prior expected_output", () => {
    tempDir = join(tmpdir(), `pre-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    try {
      const tasks = [
        createTask({
          id: "T01",
          sequence: 0,
          files: [],
          inputs: [],
          expected_output: ["./src/generated.ts"]
          // Output with ./
        }),
        createTask({
          id: "T02",
          sequence: 1,
          files: ["src/generated.ts"],
          // Input without ./
          inputs: [],
          expected_output: []
        })
      ];
      const results = checkFilePathConsistency(tasks, tempDir);
      assert.deepEqual(results, [], "Should pass because src/generated.ts matches ./src/generated.ts");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("paths with mixed separators match", () => {
    tempDir = join(tmpdir(), `pre-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    try {
      const tasks = [
        createTask({
          id: "T01",
          sequence: 0,
          files: [],
          inputs: [],
          expected_output: ["src/sub/file.ts"]
        }),
        createTask({
          id: "T02",
          sequence: 1,
          files: ["src\\sub\\file.ts"],
          // Backslash separators
          inputs: [],
          expected_output: []
        })
      ];
      const results = checkFilePathConsistency(tasks, tempDir);
      assert.deepEqual(results, [], "Should pass because backslash paths normalize to forward slash");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
describe("checkTaskOrdering with path normalization", () => {
  test("./path in inputs triggers ordering check for path in expected_output", () => {
    const tasks = [
      createTask({
        id: "T01",
        sequence: 0,
        files: [],
        inputs: ["./generated.ts"],
        // Reads with ./
        expected_output: []
      }),
      createTask({
        id: "T02",
        sequence: 1,
        files: [],
        inputs: [],
        expected_output: ["generated.ts"]
        // Creates without ./
      })
    ];
    const results = checkTaskOrdering(tasks, "/tmp");
    assert.equal(results.length, 1, "Should detect ordering violation despite ./");
    assert.ok(results[0].message.includes("T01"));
    assert.ok(results[0].message.includes("T02"));
  });
  test("path in inputs triggers ordering check for ./path in expected_output", () => {
    const tasks = [
      createTask({
        id: "T01",
        sequence: 0,
        files: [],
        inputs: ["generated.ts"],
        // Reads without ./
        expected_output: []
      }),
      createTask({
        id: "T02",
        sequence: 1,
        files: [],
        inputs: [],
        expected_output: ["./generated.ts"]
        // Creates with ./
      })
    ];
    const results = checkTaskOrdering(tasks, "/tmp");
    assert.equal(results.length, 1, "Should detect ordering violation despite ./ on creator");
    assert.ok(results[0].message.includes("sequence violation"));
  });
  test("no false positive when correctly ordered with mixed paths", () => {
    const tasks = [
      createTask({
        id: "T01",
        sequence: 0,
        files: [],
        inputs: [],
        expected_output: ["./src/api.ts"]
      }),
      createTask({
        id: "T02",
        sequence: 1,
        files: ["src/api.ts"],
        // Same file, different notation
        inputs: [],
        expected_output: []
      })
    ];
    const results = checkTaskOrdering(tasks, "/tmp");
    assert.deepEqual(results, [], "Should pass - T02 reads file that T01 already created");
  });
});
describe("checkTaskOrdering", () => {
  test("passes when tasks are correctly ordered", () => {
    const tasks = [
      createTask({
        id: "T01",
        sequence: 0,
        files: [],
        inputs: [],
        expected_output: ["api.ts"]
      }),
      createTask({
        id: "T02",
        sequence: 1,
        files: ["api.ts"],
        inputs: [],
        expected_output: []
      })
    ];
    const results = checkTaskOrdering(tasks, "/tmp");
    assert.deepEqual(results, []);
  });
  test("fails when task inputs reference file created by later task", () => {
    const tasks = [
      createTask({
        id: "T01",
        sequence: 0,
        files: [],
        inputs: ["generated.ts"],
        // Reads file that doesn't exist yet
        expected_output: []
      }),
      createTask({
        id: "T02",
        sequence: 1,
        files: [],
        inputs: [],
        expected_output: ["generated.ts"]
        // Creates the file
      })
    ];
    const results = checkTaskOrdering(tasks, "/tmp");
    assert.equal(results.length, 1);
    assert.equal(results[0].category, "file");
    assert.equal(results[0].passed, false);
    assert.equal(results[0].blocking, true);
    assert.ok(results[0].message.includes("T01"));
    assert.ok(results[0].message.includes("T02"));
    assert.ok(results[0].message.includes("sequence violation"));
  });
  test("detects ordering violation in inputs array", () => {
    const tasks = [
      createTask({
        id: "T01",
        sequence: 0,
        files: [],
        inputs: ["schema.json"],
        expected_output: []
      }),
      createTask({
        id: "T02",
        sequence: 1,
        files: [],
        inputs: [],
        expected_output: ["schema.json"]
      })
    ];
    const results = checkTaskOrdering(tasks, "/tmp");
    assert.equal(results.length, 1);
    assert.ok(results[0].message.includes("schema.json"));
  });
  test("handles multiple ordering violations via inputs", () => {
    const tasks = [
      createTask({
        id: "T01",
        sequence: 0,
        files: [],
        inputs: ["a.ts", "b.ts"],
        expected_output: []
      }),
      createTask({
        id: "T02",
        sequence: 1,
        files: [],
        inputs: [],
        expected_output: ["a.ts"]
      }),
      createTask({
        id: "T03",
        sequence: 2,
        files: [],
        inputs: [],
        expected_output: ["b.ts"]
      })
    ];
    const results = checkTaskOrdering(tasks, "/tmp");
    assert.equal(results.length, 2);
  });
  test("passes when no dependencies between tasks", () => {
    const tasks = [
      createTask({
        id: "T01",
        sequence: 0,
        files: [],
        inputs: [],
        expected_output: ["a.ts"]
      }),
      createTask({
        id: "T02",
        sequence: 1,
        files: [],
        inputs: [],
        expected_output: ["b.ts"]
      })
    ];
    const results = checkTaskOrdering(tasks, "/tmp");
    assert.deepEqual(results, []);
  });
});
describe("checkInterfaceContracts", () => {
  test("passes when function signatures match", () => {
    const tasks = [
      createTask({
        id: "T01",
        description: `
\`\`\`typescript
function processData(input: string): boolean
\`\`\`
        `
      }),
      createTask({
        id: "T02",
        description: `
\`\`\`typescript
function processData(input: string): boolean
\`\`\`
        `
      })
    ];
    const results = checkInterfaceContracts(tasks, "/tmp");
    assert.deepEqual(results, []);
  });
  test("warns on parameter mismatch (non-blocking)", () => {
    const tasks = [
      createTask({
        id: "T01",
        description: `
\`\`\`typescript
function saveUser(name: string): void
\`\`\`
        `
      }),
      createTask({
        id: "T02",
        description: `
\`\`\`typescript
function saveUser(name: string, email: string): void
\`\`\`
        `
      })
    ];
    const results = checkInterfaceContracts(tasks, "/tmp");
    assert.equal(results.length, 1);
    assert.equal(results[0].category, "schema");
    assert.equal(results[0].target, "saveUser");
    assert.equal(results[0].passed, true);
    assert.equal(results[0].blocking, false);
    assert.ok(results[0].message.includes("different parameters"));
  });
  test("warns on return type mismatch (non-blocking)", () => {
    const tasks = [
      createTask({
        id: "T01",
        description: `
\`\`\`typescript
function getData(): string
\`\`\`
        `
      }),
      createTask({
        id: "T02",
        description: `
\`\`\`typescript
function getData(): number
\`\`\`
        `
      })
    ];
    const results = checkInterfaceContracts(tasks, "/tmp");
    assert.equal(results.length, 1);
    assert.ok(results[0].message.includes("different return types"));
  });
  test("handles export function syntax", () => {
    const tasks = [
      createTask({
        id: "T01",
        description: `
\`\`\`typescript
export function validate(data: object): boolean
\`\`\`
        `
      }),
      createTask({
        id: "T02",
        description: `
\`\`\`typescript
export function validate(data: string): boolean
\`\`\`
        `
      })
    ];
    const results = checkInterfaceContracts(tasks, "/tmp");
    assert.equal(results.length, 1);
    assert.ok(results[0].message.includes("validate"));
  });
  test("handles async function syntax", () => {
    const tasks = [
      createTask({
        id: "T01",
        description: `
\`\`\`typescript
export async function fetchData(): Promise<string>
\`\`\`
        `
      }),
      createTask({
        id: "T02",
        description: `
\`\`\`typescript
export async function fetchData(): Promise<number>
\`\`\`
        `
      })
    ];
    const results = checkInterfaceContracts(tasks, "/tmp");
    assert.equal(results.length, 1);
  });
  test("handles const arrow function syntax", () => {
    const tasks = [
      createTask({
        id: "T01",
        description: `
\`\`\`typescript
const handler = (req: Request): Response =>
\`\`\`
        `
      }),
      createTask({
        id: "T02",
        description: `
\`\`\`typescript
const handler = (req: Request, res: Response): void =>
\`\`\`
        `
      })
    ];
    const results = checkInterfaceContracts(tasks, "/tmp");
    assert.equal(results.length, 2);
    assert.ok(results.some((r) => r.message.includes("handler")));
    assert.ok(results.some((r) => r.message.includes("parameters")));
    assert.ok(results.some((r) => r.message.includes("return types")));
  });
  test("passes when no code blocks present", () => {
    const tasks = [
      createTask({
        id: "T01",
        description: "Just some text without code blocks"
      })
    ];
    const results = checkInterfaceContracts(tasks, "/tmp");
    assert.deepEqual(results, []);
  });
  test("handles multiple mismatches for same function", () => {
    const tasks = [
      createTask({
        id: "T01",
        description: `
\`\`\`typescript
function process(a: string): string
\`\`\`
        `
      }),
      createTask({
        id: "T02",
        description: `
\`\`\`typescript
function process(a: number): number
\`\`\`
        `
      })
    ];
    const results = checkInterfaceContracts(tasks, "/tmp");
    assert.equal(results.length, 2);
  });
});
describe("checkVerificationCommands", () => {
  test("accepts pipe-free pytest Verify command", () => {
    const results = checkVerificationCommands([
      createTask({
        id: "T01",
        verify: "python3 -m pytest tests/ -q --tb=short"
      })
    ]);
    assert.deepEqual(results, []);
  });
  test("rejects piped pytest Verify command", () => {
    const results = checkVerificationCommands([
      createTask({
        id: "T01",
        verify: "python3 -m pytest tests/ -q --tb=short 2>&1 | tail -5"
      })
    ]);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.category, "tool");
    assert.equal(results[0]?.blocking, true);
    assert.match(results[0]?.message ?? "", /shell control syntax/);
  });
});
describe("runPreExecutionChecks", () => {
  let tempDir;
  test("returns pass status when all checks pass", async () => {
    tempDir = join(tmpdir(), `pre-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, "existing.ts"), "// content");
    try {
      const tasks = [
        createTask({
          id: "T01",
          files: ["existing.ts"],
          inputs: [],
          expected_output: ["output.ts"]
        }),
        createTask({
          id: "T02",
          files: ["output.ts"],
          inputs: [],
          expected_output: []
        })
      ];
      const result = await runPreExecutionChecks(tasks, tempDir);
      assert.equal(result.status, "pass");
      assert.equal(result.checks.length, 0);
      assert.ok(result.durationMs >= 0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("returns fail status for unsafe Verify command before execution", async () => {
    tempDir = join(tmpdir(), `pre-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    try {
      const tasks = [
        createTask({
          id: "T01",
          verify: "python3 -m pytest tests/ -q --tb=short 2>&1 | tail -5"
        })
      ];
      const result = await runPreExecutionChecks(tasks, tempDir);
      assert.equal(result.status, "fail");
      assert.equal(result.checks.length, 1);
      assert.equal(result.checks[0]?.category, "tool");
      assert.equal(result.checks[0]?.blocking, true);
      assert.match(result.checks[0]?.message ?? "", /Unsafe or non-runnable Verify command/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("returns fail status when blocking failure exists", async () => {
    tempDir = join(tmpdir(), `pre-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    try {
      const tasks = [
        createTask({
          id: "T01",
          files: [],
          inputs: ["nonexistent.ts"],
          expected_output: []
        })
      ];
      const result = await runPreExecutionChecks(tasks, tempDir);
      assert.equal(result.status, "fail");
      assert.ok(result.checks.length > 0);
      assert.ok(result.checks.some((c) => c.blocking === true));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("returns warn status for non-blocking issues", async () => {
    tempDir = join(tmpdir(), `pre-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    try {
      const tasks = [
        createTask({
          id: "T01",
          files: [],
          inputs: [],
          expected_output: [],
          description: `
\`\`\`typescript
function foo(a: string): void
\`\`\`
          `
        }),
        createTask({
          id: "T02",
          files: [],
          inputs: [],
          expected_output: [],
          description: `
\`\`\`typescript
function foo(a: number): void
\`\`\`
          `
        })
      ];
      const result = await runPreExecutionChecks(tasks, tempDir);
      assert.equal(result.status, "warn");
      assert.ok(result.checks.some((c) => c.blocking === false));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("combines results from all check types", async () => {
    tempDir = join(tmpdir(), `pre-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    try {
      const tasks = [
        createTask({
          id: "T01",
          sequence: 0,
          files: ["will-be-created.ts"],
          // Ordering violation
          inputs: ["missing.ts"],
          // Missing file
          expected_output: [],
          description: `
\`\`\`typescript
function check(a: string): void
\`\`\`
          `
        }),
        createTask({
          id: "T02",
          sequence: 1,
          files: [],
          inputs: [],
          expected_output: ["will-be-created.ts"],
          description: `
\`\`\`typescript
function check(a: number): void
\`\`\`
          `
        })
      ];
      const result = await runPreExecutionChecks(tasks, tempDir);
      assert.equal(result.status, "fail");
      const categories = new Set(result.checks.map((c) => c.category));
      assert.ok(categories.has("file"));
      assert.ok(categories.has("schema"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("reports duration in milliseconds", async () => {
    tempDir = join(tmpdir(), `pre-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    try {
      const tasks = [createTask({ id: "T01" })];
      const result = await runPreExecutionChecks(tasks, tempDir);
      assert.ok(typeof result.durationMs === "number");
      assert.ok(result.durationMs >= 0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("handles empty task array", async () => {
    tempDir = join(tmpdir(), `pre-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    try {
      const result = await runPreExecutionChecks([], tempDir);
      assert.equal(result.status, "pass");
      assert.deepEqual(result.checks, []);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
describe("checkTaskOrdering false positive regression (#3677)", () => {
  test("task.files should not trigger ordering violation when file is in later expected_output", () => {
    const tasks = [
      createTask({
        id: "T01",
        sequence: 0,
        files: ["component.tsx"],
        inputs: [],
        expected_output: []
      }),
      createTask({
        id: "T02",
        sequence: 1,
        files: [],
        inputs: [],
        expected_output: ["component.tsx"]
      })
    ];
    const results = checkTaskOrdering(tasks, "/tmp");
    assert.equal(results.length, 0, "task.files should not be checked for ordering violations");
  });
  test("task.files with multiple files should not trigger false positives", () => {
    const tasks = [
      createTask({
        id: "T01",
        sequence: 0,
        files: ["a.ts", "b.ts", "c.ts"],
        inputs: [],
        expected_output: []
      }),
      createTask({
        id: "T02",
        sequence: 1,
        files: [],
        inputs: [],
        expected_output: ["b.ts"]
      })
    ];
    const results = checkTaskOrdering(tasks, "/tmp");
    assert.equal(results.length, 0, "Multiple task.files should not generate false positive violations");
  });
  test("task.inputs SHOULD still trigger ordering violation", () => {
    const tasks = [
      createTask({
        id: "T01",
        sequence: 0,
        files: [],
        inputs: ["config.json"],
        expected_output: []
      }),
      createTask({
        id: "T02",
        sequence: 1,
        files: [],
        inputs: [],
        expected_output: ["config.json"]
      })
    ];
    const results = checkTaskOrdering(tasks, "/tmp");
    assert.equal(results.length, 1, "task.inputs ordering violation must still be detected");
    assert.equal(results[0].blocking, true);
    assert.ok(results[0].message.includes("T01"));
    assert.ok(results[0].message.includes("T02"));
    assert.ok(results[0].message.includes("sequence violation"));
  });
  test("mixed files and inputs \u2014 only inputs trigger ordering violation", () => {
    const tasks = [
      createTask({
        id: "T01",
        sequence: 0,
        files: ["created.ts"],
        inputs: ["needed.json"],
        expected_output: []
      }),
      createTask({
        id: "T02",
        sequence: 1,
        files: [],
        inputs: [],
        expected_output: ["created.ts", "needed.json"]
      })
    ];
    const results = checkTaskOrdering(tasks, "/tmp");
    assert.equal(results.length, 1, "Only the inputs entry should produce a violation, not files");
    assert.ok(results[0].target === "needed.json", "Violation target should be the input, not the file");
  });
  test("task.files with normalized paths should not false-positive", () => {
    const tasks = [
      createTask({
        id: "T01",
        sequence: 0,
        files: ["./src/new-file.ts"],
        inputs: [],
        expected_output: []
      }),
      createTask({
        id: "T02",
        sequence: 1,
        files: [],
        inputs: [],
        expected_output: ["src/new-file.ts"]
      })
    ];
    const results = checkTaskOrdering(tasks, "/tmp");
    assert.equal(results.length, 0, "Normalized task.files path should not trigger a false positive");
  });
  test("annotated inputs still trigger ordering violations against later plain outputs", () => {
    const tasks = [
      createTask({
        id: "T01",
        sequence: 0,
        files: [],
        inputs: ["`later.ts` \u2014 needed first"],
        expected_output: []
      }),
      createTask({
        id: "T02",
        sequence: 1,
        files: [],
        inputs: [],
        expected_output: ["later.ts"]
      })
    ];
    const results = checkTaskOrdering(tasks, "/tmp");
    assert.equal(results.length, 1, "Annotated inputs should still match later plain expected_output entries");
    assert.equal(results[0].target, "`later.ts` \u2014 needed first");
    assert.ok(results[0].message.includes("sequence violation"));
  });
  test("existing on-disk files do not trigger ordering violations just because a later task modifies them", () => {
    const tempDir = join(tmpdir(), `pre-exec-ordering-existing-file-${Date.now()}`);
    const existingFile = "frontend/src/__tests__/ProcurementPage29.test.tsx";
    mkdirSync(join(tempDir, "frontend", "src", "__tests__"), { recursive: true });
    writeFileSync(join(tempDir, existingFile), "// existing file");
    try {
      const tasks = [
        createTask({
          id: "T01",
          sequence: 0,
          files: [],
          inputs: ["`frontend/src/__tests__/ProcurementPage29.test.tsx` \u2014 contains matchMedia stub to remove"],
          expected_output: []
        }),
        createTask({
          id: "T03",
          sequence: 2,
          files: [],
          inputs: [],
          expected_output: ["frontend/src/__tests__/ProcurementPage29.test.tsx"]
        })
      ];
      const results = checkTaskOrdering(tasks, tempDir);
      assert.equal(results.length, 0, "Pre-existing files should not be treated as created by later tasks");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("glob-like inputs do not trigger ordering violations against later concrete outputs", () => {
    const tasks = [
      createTask({
        id: "T01",
        sequence: 0,
        files: [],
        inputs: ["Artifacts/pruned_networks/cell_line=*/"],
        expected_output: []
      }),
      createTask({
        id: "T02",
        sequence: 1,
        files: [],
        inputs: [],
        expected_output: ["Artifacts/pruned_networks/cell_line=HT-29/"]
      })
    ];
    const results = checkTaskOrdering(tasks, "/tmp");
    assert.equal(results.length, 0, "Glob-pattern inputs should not be treated as literal read-before-create dependencies");
  });
});
describe("checkFilePathConsistency additional edge cases", () => {
  test("annotated inputs match files that already exist on disk", () => {
    const tempDir = join(tmpdir(), `pre-exec-test-annotated-input-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, "existing.ts"), "// content");
    try {
      const tasks = [
        createTask({
          id: "T01",
          files: [],
          inputs: ["`existing.ts` \u2014 file already on disk"],
          expected_output: []
        })
      ];
      const results = checkFilePathConsistency(tasks, tempDir);
      assert.equal(results.length, 0, "Annotated inputs should resolve to the on-disk file path");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("plain inputs match prior annotated expected outputs", () => {
    const tasks = [
      createTask({
        id: "T01",
        files: [],
        inputs: [],
        expected_output: ["`generated.ts` \u2014 created earlier"]
      }),
      createTask({
        id: "T02",
        files: [],
        inputs: ["generated.ts"],
        expected_output: []
      })
    ];
    const results = checkFilePathConsistency(tasks, "/tmp");
    assert.equal(results.length, 0, "Prior annotated expected_output entries should satisfy later plain inputs");
  });
  test("inputs referencing glob-like patterns are skipped by path consistency checks", () => {
    const tasks = [
      createTask({
        id: "T01",
        files: [],
        inputs: ["src/**/*.ts"],
        expected_output: []
      })
    ];
    let results;
    assert.doesNotThrow(() => {
      results = checkFilePathConsistency(tasks, "/tmp");
    });
    assert.equal(results.length, 0, "Glob-pattern inputs should not produce false blocking failures");
  });
  test("multi-word prose inputs are ignored by path consistency checks", () => {
    const tasks = [
      createTask({
        id: "T01",
        files: [],
        inputs: [
          "Current WIZARD_PRODUCTS enum",
          "Existing test patterns in wizard.test.ts"
        ],
        expected_output: []
      })
    ];
    const results = checkFilePathConsistency(tasks, "/tmp");
    assert.equal(results.length, 0, "Prose planning hints should not be treated as missing file paths");
  });
  test("empty inputs array produces no results", () => {
    const tasks = [
      createTask({
        id: "T01",
        files: ["anything.ts"],
        inputs: [],
        expected_output: []
      })
    ];
    const results = checkFilePathConsistency(tasks, "/tmp");
    assert.equal(results.length, 0, "Empty inputs should produce no consistency check results");
  });
  test("inputs with absolute paths are checked correctly", () => {
    const tempDir = join(tmpdir(), `pre-exec-test-abs-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    const absFilePath = join(tempDir, "real-file.ts");
    writeFileSync(absFilePath, "// content");
    try {
      const tasks = [
        createTask({
          id: "T01",
          files: [],
          inputs: [absFilePath],
          expected_output: []
        })
      ];
      const results = checkFilePathConsistency(tasks, tempDir);
      assert.equal(results.length, 0, "Absolute path to an existing file should pass consistency check");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("backticked path with trailing prose and parens resolves to the path", () => {
    const tempDir = join(tmpdir(), `pre-exec-test-4421-case1-${Date.now()}`);
    const dirPath = join(tempDir, "assets");
    mkdirSync(dirPath, { recursive: true });
    try {
      const tasks = [
        createTask({
          id: "T01",
          inputs: [`\`${dirPath}/\` directory listing (shows the items that will match during the run)`]
        })
      ];
      const results = checkFilePathConsistency(tasks, tempDir);
      assert.equal(results.length, 0, "Backticked dir path annotated with prose + parens should be recognized");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("backticked URL with paren annotation is skipped (not a filesystem path)", () => {
    const tasks = [
      createTask({
        id: "T01",
        inputs: ["`https://example.com` (live HTTP target)"]
      })
    ];
    const results = checkFilePathConsistency(tasks, "/tmp");
    assert.equal(results.length, 0, "Backticked URL should not be validated as a filesystem path");
  });
  test("URL embedded mid-sentence with prefix prose is skipped", () => {
    const tasks = [
      createTask({
        id: "T01",
        inputs: ["Live `https://example.com/docs` pages (reviewer WebFetches these)"]
      })
    ];
    const results = checkFilePathConsistency(tasks, "/tmp");
    assert.equal(results.length, 0, "URLs cited mid-sentence should not be validated as filesystem paths");
  });
  test("backticked path cited mid-sentence resolves to the path", () => {
    const tempDir = join(tmpdir(), `pre-exec-test-4421-case4-${Date.now()}`);
    mkdirSync(join(tempDir, ".gsd"), { recursive: true });
    writeFileSync(join(tempDir, ".gsd/REQUIREMENTS.md"), "# Requirements");
    try {
      const tasks = [
        createTask({
          id: "T01",
          inputs: ["R014 verbatim text from `.gsd/REQUIREMENTS.md` (the owned requirement statement)"]
        })
      ];
      const results = checkFilePathConsistency(tasks, tempDir);
      assert.equal(results.length, 0, "Backticked path cited mid-sentence should be recognized");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("multi-backtick input picks the path-like token over non-path tokens", () => {
    const tempDir = join(tmpdir(), `pre-exec-test-4421-multi-${Date.now()}`);
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src/a.ts"), "// content");
    try {
      const tasks = [
        createTask({
          id: "T01",
          inputs: ["`note` use `src/a.ts` for edits"]
        })
      ];
      const results = checkFilePathConsistency(tasks, tempDir);
      assert.equal(results.length, 0, "Should extract src/a.ts, not the leading `note` token");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("multi-backtick input with command-like leading token picks the path", () => {
    const tempDir = join(tmpdir(), `pre-exec-test-4421-cmd-${Date.now()}`);
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src/a.ts"), "// content");
    try {
      const tasks = [
        createTask({
          id: "T01",
          inputs: ["Run `npm test` against `src/a.ts`"]
        })
      ];
      const results = checkFilePathConsistency(tasks, tempDir);
      assert.equal(results.length, 0, "Should extract src/a.ts, not the `npm test` command token");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
describe("PreExecutionResult type", () => {
  test("status is one of pass, warn, fail", async () => {
    const tempDir = join(tmpdir(), `pre-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    try {
      const tasks = [createTask({ id: "T01" })];
      const result = await runPreExecutionChecks(tasks, tempDir);
      assert.ok(["pass", "warn", "fail"].includes(result.status));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("checks array matches PreExecutionCheckJSON schema", async () => {
    const tempDir = join(tmpdir(), `pre-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    try {
      const tasks = [
        createTask({
          id: "T01",
          files: ["missing.ts"]
        })
      ];
      const result = await runPreExecutionChecks(tasks, tempDir);
      for (const check of result.checks) {
        assert.ok(["package", "file", "tool", "endpoint", "schema"].includes(check.category));
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
describe("normalizeFilePath tilde expansion (#4446)", () => {
  test("expands standalone ~ to homedir", () => {
    assert.equal(normalizeFilePath("~"), homedir());
  });
  test("expands ~/ prefixed paths to homedir", () => {
    assert.equal(
      normalizeFilePath("~/.gsd/agent/extensions/gsd/native-git-bridge.js"),
      join(homedir(), ".gsd/agent/extensions/gsd/native-git-bridge.js")
    );
  });
});
describe("checkFilePathConsistency directory inputs (#4446)", () => {
  test("directory input is satisfied by prior task's output under it", (t) => {
    const tempDir = join(tmpdir(), `pre-exec-dir-prior-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    t.after(() => rmSync(tempDir, { recursive: true, force: true }));
    const tasks = [
      createTask({
        id: "T01",
        sequence: 0,
        inputs: [],
        expected_output: ["artifacts/M009-S03/summary.json"]
      }),
      createTask({
        id: "T02",
        sequence: 1,
        inputs: ["artifacts/M009-S03/"],
        expected_output: []
      })
    ];
    const results = checkFilePathConsistency(tasks, tempDir);
    assert.deepEqual(results, [], "Directory input with prior output beneath it should not be blocking");
  });
  test("directory input is satisfied by same task's output under it", (t) => {
    const tempDir = join(tmpdir(), `pre-exec-dir-same-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    t.after(() => rmSync(tempDir, { recursive: true, force: true }));
    const tasks = [
      createTask({
        id: "T06",
        sequence: 0,
        inputs: ["artifacts/M009-S03/"],
        expected_output: [
          "artifacts/M009-S03/summary.json",
          "artifacts/M009-S03/VERIFICATION.md"
        ]
      })
    ];
    const results = checkFilePathConsistency(tasks, tempDir);
    assert.deepEqual(
      results,
      [],
      "Directory input whose children are produced by the same task should not be blocking (M009-S03/T06 case)"
    );
  });
  test("directory input still fails when nothing creates anything under it", (t) => {
    const tempDir = join(tmpdir(), `pre-exec-dir-missing-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    t.after(() => rmSync(tempDir, { recursive: true, force: true }));
    const tasks = [
      createTask({
        id: "T01",
        inputs: ["artifacts/missing/"],
        expected_output: []
      })
    ];
    const results = checkFilePathConsistency(tasks, tempDir);
    assert.equal(results.length, 1, "Unknown directory input must still be reported");
    assert.equal(results[0].blocking, true);
  });
  test("runtime directory annotation is skipped as a pre-execution file dependency", (t) => {
    const tempDir = join(tmpdir(), `pre-exec-dir-runtime-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    t.after(() => rmSync(tempDir, { recursive: true, force: true }));
    const tasks = [
      createTask({
        id: "T02",
        inputs: ["entries/ directory (runtime)"],
        expected_output: ["src/commands/delete.ts", "src/index.ts"]
      })
    ];
    const results = checkFilePathConsistency(tasks, tempDir);
    assert.deepEqual(
      results,
      [],
      "Runtime-only directory inputs are created during command execution, not required before the task starts"
    );
  });
  test("tilde-prefixed input is matched against $HOME, not the project basePath", (t) => {
    const fakeHome = join(tmpdir(), `pre-exec-tilde-home-${Date.now()}`);
    const projectDir = join(tmpdir(), `pre-exec-tilde-proj-${Date.now()}`);
    mkdirSync(join(fakeHome, ".gsd"), { recursive: true });
    writeFileSync(join(fakeHome, ".gsd/tool.js"), "// present");
    mkdirSync(projectDir, { recursive: true });
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    t.after(() => {
      if (originalHome === void 0) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === void 0) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    });
    const tasks = [
      createTask({
        id: "T01",
        inputs: ["~/.gsd/tool.js"],
        expected_output: []
      })
    ];
    const results = checkFilePathConsistency(tasks, projectDir);
    assert.deepEqual(results, [], "~/-prefixed input should resolve against $HOME and pass when present");
  });
});
describe("checkTaskOrdering directory inputs (#4446)", () => {
  test("directory input with a same-task output under it does not produce a sequence violation", () => {
    const tasks = [
      createTask({
        id: "T06",
        sequence: 0,
        inputs: ["artifacts/M009-S03/"],
        expected_output: [
          "artifacts/M009-S03/summary.json",
          "artifacts/M009-S03/VERIFICATION.md"
        ]
      })
    ];
    const results = checkTaskOrdering(tasks, "/tmp");
    assert.deepEqual(
      results,
      [],
      "Directory reference should not be treated as reading a file created later"
    );
  });
  test("runtime directory annotation does not produce an ordering violation", () => {
    const tasks = [
      createTask({
        id: "T02",
        sequence: 0,
        inputs: ["entries/ directory (runtime)"],
        expected_output: []
      })
    ];
    const results = checkTaskOrdering(tasks, "/tmp");
    assert.deepEqual(results, []);
  });
});
describe("checkTaskOrdering false positive for pre-execution refs (#4071)", () => {
  test("completed task at higher index does not trigger ordering violation for its outputs", () => {
    const tasks = [
      createTask({
        id: "T_NEW",
        sequence: 1,
        status: "pending",
        inputs: ["artifacts/setup.json"],
        expected_output: []
      }),
      createTask({
        id: "T_SETUP",
        sequence: 5,
        status: "completed",
        inputs: [],
        expected_output: ["artifacts/setup.json"]
      })
    ];
    const results = checkTaskOrdering(tasks, "/tmp");
    assert.equal(
      results.length,
      0,
      "completed task outputs must not trigger ordering violations for earlier-sequence tasks that read them"
    );
  });
  test("pending task at higher index still triggers ordering violation", () => {
    const tasks = [
      createTask({
        id: "T01",
        sequence: 1,
        status: "pending",
        inputs: ["artifacts/output.json"],
        expected_output: []
      }),
      createTask({
        id: "T02",
        sequence: 5,
        status: "pending",
        inputs: [],
        expected_output: ["artifacts/output.json"]
      })
    ];
    const results = checkTaskOrdering(tasks, "/tmp");
    assert.equal(
      results.length,
      1,
      "pending task at higher index must still be flagged as ordering violation"
    );
    assert.equal(results[0].blocking, true);
    assert.ok(results[0].message.includes("T01"));
    assert.ok(results[0].message.includes("T02"));
    assert.ok(results[0].message.includes("sequence violation"));
  });
  test("pending-first then completed-later: completed replaces pending in fileCreators (#4572)", () => {
    const tasks = [
      // array index 0 — reads the shared path
      createTask({
        id: "T_READER",
        sequence: 1,
        status: "pending",
        inputs: ["shared/artifact.json"],
        expected_output: []
      }),
      // array index 1 — pending producer (visited first during map build)
      createTask({
        id: "T_PENDING_PRODUCER",
        sequence: 5,
        status: "pending",
        inputs: [],
        expected_output: ["shared/artifact.json"]
      }),
      // array index 2 — completed producer (visited second; must replace pending entry)
      createTask({
        id: "T_COMPLETED_PRODUCER",
        sequence: 2,
        status: "completed",
        inputs: [],
        expected_output: ["shared/artifact.json"]
      })
    ];
    const results = checkTaskOrdering(tasks, "/tmp");
    assert.equal(
      results.length,
      0,
      "completed producer must replace pending producer in fileCreators and suppress false violation"
    );
  });
  test("completed task output exemption applies regardless of whether file exists on disk", (t) => {
    const tempDir = join(tmpdir(), `pre-exec-completed-task-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    t.after(() => rmSync(tempDir, { recursive: true, force: true }));
    const tasks = [
      createTask({
        id: "T_MAIN",
        sequence: 0,
        status: "pending",
        inputs: ["generated/config.json"],
        expected_output: []
      }),
      createTask({
        id: "T_INIT",
        sequence: 10,
        status: "completed",
        inputs: [],
        expected_output: ["generated/config.json"]
      })
    ];
    const results = checkTaskOrdering(tasks, tempDir);
    assert.equal(
      results.length,
      0,
      "completed task exemption must apply even when file is absent from disk"
    );
  });
});
describe("checkFilePathConsistency completed-task output exemption (#4071)", () => {
  test("completed task at higher index does not cause false positive for file it produced", (t) => {
    const tempDir = join(tmpdir(), `pre-exec-fc-completed-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    t.after(() => rmSync(tempDir, { recursive: true, force: true }));
    const tasks = [
      createTask({
        id: "T_MAIN",
        sequence: 1,
        status: "pending",
        inputs: ["artifacts/config.json"],
        expected_output: []
      }),
      createTask({
        id: "T_SETUP",
        sequence: 10,
        status: "completed",
        inputs: [],
        expected_output: ["artifacts/config.json"]
      })
    ];
    const results = checkFilePathConsistency(tasks, tempDir);
    assert.equal(
      results.length,
      0,
      "completed task at higher index should satisfy inputs of pending tasks that read its outputs"
    );
  });
  test("pending task at higher index does NOT cause a duplicate consistency error (ordering check handles it)", (t) => {
    const tempDir = join(tmpdir(), `pre-exec-fc-pending-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    t.after(() => rmSync(tempDir, { recursive: true, force: true }));
    const tasks = [
      createTask({
        id: "T01",
        sequence: 1,
        status: "pending",
        inputs: ["artifacts/output.json"],
        expected_output: []
      }),
      createTask({
        id: "T02",
        sequence: 10,
        status: "pending",
        inputs: [],
        expected_output: ["artifacts/output.json"]
      })
    ];
    const results = checkFilePathConsistency(tasks, tempDir);
    assert.equal(
      results.length,
      0,
      "consistency check must not duplicate what the ordering check already reports"
    );
  });
});
describe("checkFilePathConsistency self-referential inputs (#4459)", () => {
  test("input that is also in the same task's expected_output is not blocking when missing on disk", (t) => {
    const tempDir = join(tmpdir(), `pre-exec-self-output-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    t.after(() => rmSync(tempDir, { recursive: true, force: true }));
    const tasks = [
      createTask({
        id: "T02",
        sequence: 0,
        inputs: ["src/components/email/SnoozePopover.jsx"],
        expected_output: ["src/components/email/SnoozePopover.jsx"]
      })
    ];
    const results = checkFilePathConsistency(tasks, tempDir);
    assert.deepEqual(
      results,
      [],
      "File declared as both input and expected_output of the same task should not block \u2014 the task itself produces it"
    );
  });
  test("input missing from disk, missing from prior outputs, and missing from own expected_output still blocks", (t) => {
    const tempDir = join(tmpdir(), `pre-exec-self-output-missing-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    t.after(() => rmSync(tempDir, { recursive: true, force: true }));
    const tasks = [
      createTask({
        id: "T02",
        sequence: 0,
        inputs: ["src/components/email/SnoozePopover.jsx"],
        expected_output: ["src/other/unrelated.jsx"]
      })
    ];
    const results = checkFilePathConsistency(tasks, tempDir);
    assert.equal(results.length, 1, "Genuinely missing input should still be reported");
    assert.equal(results[0].blocking, true);
    assert.equal(results[0].target, "src/components/email/SnoozePopover.jsx");
  });
  test("self-output exemption matches across path normalization (./ prefix)", (t) => {
    const tempDir = join(tmpdir(), `pre-exec-self-output-norm-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    t.after(() => rmSync(tempDir, { recursive: true, force: true }));
    const tasks = [
      createTask({
        id: "T02",
        sequence: 0,
        inputs: ["./src/generated.ts"],
        expected_output: ["src/generated.ts"]
      })
    ];
    const results = checkFilePathConsistency(tasks, tempDir);
    assert.deepEqual(
      results,
      [],
      "./src/generated.ts and src/generated.ts should compare equal after normalization"
    );
  });
});
describe("checkFilePathConsistency quote-wrapped annotation (#3747)", () => {
  test("double-quoted path annotation is stripped before path check", (t) => {
    const tempDir = join(tmpdir(), `pre-exec-quote-${Date.now()}`);
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src/foo.ts"), "// content");
    t.after(() => rmSync(tempDir, { recursive: true, force: true }));
    const tasks = [
      createTask({
        id: "T01",
        inputs: ['"src/foo.ts"'],
        expected_output: []
      })
    ];
    const results = checkFilePathConsistency(tasks, tempDir);
    assert.equal(
      results.length,
      0,
      "Double-quoted path should be stripped and resolved to the real file"
    );
  });
  test("single-quoted path annotation is stripped before path check", (t) => {
    const tempDir = join(tmpdir(), `pre-exec-squote-${Date.now()}`);
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src/bar.ts"), "// content");
    t.after(() => rmSync(tempDir, { recursive: true, force: true }));
    const tasks = [
      createTask({
        id: "T01",
        inputs: ["'src/bar.ts'"],
        expected_output: []
      })
    ];
    const results = checkFilePathConsistency(tasks, tempDir);
    assert.equal(
      results.length,
      0,
      "Single-quoted path should be stripped and resolved to the real file"
    );
  });
  test("backtick-only wrapped path without annotation resolves correctly", (t) => {
    const tempDir = join(tmpdir(), `pre-exec-backtick-bare-${Date.now()}`);
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src/baz.ts"), "// content");
    t.after(() => rmSync(tempDir, { recursive: true, force: true }));
    const tasks = [
      createTask({
        id: "T01",
        inputs: ["`src/baz.ts`"],
        expected_output: []
      })
    ];
    const results = checkFilePathConsistency(tasks, tempDir);
    assert.equal(
      results.length,
      0,
      "Bare backtick-wrapped path should resolve to the real file"
    );
  });
  test("prose value with spaces inside quotes is skipped (not a path)", () => {
    const tasks = [
      createTask({
        id: "T01",
        inputs: ['"some description text"'],
        expected_output: []
      })
    ];
    const results = checkFilePathConsistency(tasks, "/tmp");
    assert.equal(
      results.length,
      0,
      "Quoted prose with spaces should not be treated as a file path"
    );
  });
  test("17-error scenario: mixed annotated inputs produce 0 blocking errors", (t) => {
    const tempDir = join(tmpdir(), `pre-exec-3747-scenario-${Date.now()}`);
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src/foo.ts"), "// content");
    writeFileSync(join(tempDir, "src/bar.ts"), "// content");
    t.after(() => rmSync(tempDir, { recursive: true, force: true }));
    const tasks = [
      createTask({
        id: "T01",
        inputs: [
          "`src/foo.ts`",
          '"src/bar.ts"',
          "some description text",
          "Existing enum definition"
        ],
        expected_output: []
      })
    ];
    const results = checkFilePathConsistency(tasks, tempDir);
    assert.equal(
      results.length,
      0,
      "Annotated file paths and prose inputs should produce zero blocking errors"
    );
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wcmUtZXhlY3V0aW9uLWNoZWNrcy50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBQcm9qZWN0L0FwcDogR1NELTJcbi8vIEZpbGUgUHVycG9zZTogVW5pdCB0ZXN0cyBmb3IgcHJlLWV4ZWN1dGlvbiB2YWxpZGF0aW9uIGNoZWNrcy5cblxuLyoqXG4gKiBwcmUtZXhlY3V0aW9uLWNoZWNrcy50ZXN0LnRzIFx1MjAxNCBVbml0IHRlc3RzIGZvciBwcmUtZXhlY3V0aW9uIHZhbGlkYXRpb24gY2hlY2tzLlxuICpcbiAqIFRlc3RzIGFsbCA0IGNoZWNrIHR5cGVzOlxuICogICAxLiBQYWNrYWdlIGV4aXN0ZW5jZSBcdTIwMTQgbnBtIHZpZXcgbW9ja2luZywgdGltZW91dCBoYW5kbGluZ1xuICogICAyLiBGaWxlIHBhdGggY29uc2lzdGVuY3kgXHUyMDE0IGZpbGVzIGV4aXN0IHZzIHByaW9yIGV4cGVjdGVkX291dHB1dFxuICogICAzLiBUYXNrIG9yZGVyaW5nIFx1MjAxNCBkZXRlY3QgaW1wb3NzaWJsZSByZWFkLWJlZm9yZS1jcmVhdGVcbiAqICAgNC4gSW50ZXJmYWNlIGNvbnRyYWN0cyBcdTIwMTQgY29udHJhZGljdG9yeSBmdW5jdGlvbiBzaWduYXR1cmVzXG4gKiAgIDUuIFZlcmlmeSBjb21tYW5kcyBcdTIwMTQgcmVqZWN0IHVuc2FmZSBvciBub24tcnVubmFibGUgdGFzayB2ZXJpZmljYXRpb25cbiAqL1xuXG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCwgbW9jayB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgaG9tZWRpciwgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IG1rZGlyU3luYywgd3JpdGVGaWxlU3luYywgcm1TeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbmltcG9ydCB7XG4gIGV4dHJhY3RQYWNrYWdlUmVmZXJlbmNlcyxcbiAgY2hlY2tGaWxlUGF0aENvbnNpc3RlbmN5LFxuICBjaGVja1Rhc2tPcmRlcmluZyxcbiAgY2hlY2tJbnRlcmZhY2VDb250cmFjdHMsXG4gIGNoZWNrVmVyaWZpY2F0aW9uQ29tbWFuZHMsXG4gIHJ1blByZUV4ZWN1dGlvbkNoZWNrcyxcbiAgbm9ybWFsaXplRmlsZVBhdGgsXG4gIHR5cGUgUHJlRXhlY3V0aW9uUmVzdWx0LFxufSBmcm9tIFwiLi4vcHJlLWV4ZWN1dGlvbi1jaGVja3MudHNcIjtcbmltcG9ydCB0eXBlIHsgVGFza1JvdyB9IGZyb20gXCIuLi9nc2QtZGIudHNcIjtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRlc3QgRml4dHVyZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogQ3JlYXRlIGEgbWluaW1hbCBUYXNrUm93IGZvciB0ZXN0aW5nLlxuICovXG5mdW5jdGlvbiBjcmVhdGVUYXNrKG92ZXJyaWRlczogUGFydGlhbDxUYXNrUm93PiA9IHt9KTogVGFza1JvdyB7XG4gIHJldHVybiB7XG4gICAgbWlsZXN0b25lX2lkOiBcIk0wMDFcIixcbiAgICBzbGljZV9pZDogXCJTMDFcIixcbiAgICBpZDogb3ZlcnJpZGVzLmlkID8/IFwiVDAxXCIsXG4gICAgdGl0bGU6IFwiVGVzdCBUYXNrXCIsXG4gICAgc3RhdHVzOiBcInBlbmRpbmdcIixcbiAgICBvbmVfbGluZXI6IFwiXCIsXG4gICAgbmFycmF0aXZlOiBcIlwiLFxuICAgIHZlcmlmaWNhdGlvbl9yZXN1bHQ6IFwiXCIsXG4gICAgZHVyYXRpb246IFwiXCIsXG4gICAgY29tcGxldGVkX2F0OiBudWxsLFxuICAgIGJsb2NrZXJfZGlzY292ZXJlZDogZmFsc2UsXG4gICAgZGV2aWF0aW9uczogXCJcIixcbiAgICBrbm93bl9pc3N1ZXM6IFwiXCIsXG4gICAga2V5X2ZpbGVzOiBbXSxcbiAgICBrZXlfZGVjaXNpb25zOiBbXSxcbiAgICBmdWxsX3N1bW1hcnlfbWQ6IFwiXCIsXG4gICAgZGVzY3JpcHRpb246IG92ZXJyaWRlcy5kZXNjcmlwdGlvbiA/PyBcIlwiLFxuICAgIGVzdGltYXRlOiBcIlwiLFxuICAgIGZpbGVzOiBvdmVycmlkZXMuZmlsZXMgPz8gW10sXG4gICAgdmVyaWZ5OiBcIlwiLFxuICAgIGlucHV0czogb3ZlcnJpZGVzLmlucHV0cyA/PyBbXSxcbiAgICBleHBlY3RlZF9vdXRwdXQ6IG92ZXJyaWRlcy5leHBlY3RlZF9vdXRwdXQgPz8gW10sXG4gICAgb2JzZXJ2YWJpbGl0eV9pbXBhY3Q6IFwiXCIsXG4gICAgZnVsbF9wbGFuX21kOiBcIlwiLFxuICAgIHNlcXVlbmNlOiBvdmVycmlkZXMuc2VxdWVuY2UgPz8gMCxcbiAgICBibG9ja2VyX3NvdXJjZTogXCJcIixcbiAgICBlc2NhbGF0aW9uX3BlbmRpbmc6IDAsXG4gICAgZXNjYWxhdGlvbl9hd2FpdGluZ19yZXZpZXc6IDAsXG4gICAgZXNjYWxhdGlvbl9hcnRpZmFjdF9wYXRoOiBudWxsLFxuICAgIGVzY2FsYXRpb25fb3ZlcnJpZGVfYXBwbGllZF9hdDogbnVsbCxcbiAgICAuLi5vdmVycmlkZXMsXG4gIH07XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBQYWNrYWdlIFJlZmVyZW5jZSBFeHRyYWN0aW9uIFRlc3RzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcImV4dHJhY3RQYWNrYWdlUmVmZXJlbmNlc1wiLCAoKSA9PiB7XG4gIHRlc3QoXCJleHRyYWN0cyBucG0gaW5zdGFsbCBwYXR0ZXJuc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgZGVzYyA9IFwiUnVuIG5wbSBpbnN0YWxsIGxvZGFzaCB0aGVuIG5wbSBpIGF4aW9zXCI7XG4gICAgY29uc3QgcGFja2FnZXMgPSBleHRyYWN0UGFja2FnZVJlZmVyZW5jZXMoZGVzYyk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChwYWNrYWdlcy5zb3J0KCksIFtcImF4aW9zXCIsIFwibG9kYXNoXCJdKTtcbiAgfSk7XG5cbiAgdGVzdChcImV4dHJhY3RzIHlhcm4gYWRkIHBhdHRlcm5zXCIsICgpID0+IHtcbiAgICBjb25zdCBkZXNjID0gXCJ5YXJuIGFkZCByZWFjdC1kb21cIjtcbiAgICBjb25zdCBwYWNrYWdlcyA9IGV4dHJhY3RQYWNrYWdlUmVmZXJlbmNlcyhkZXNjKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHBhY2thZ2VzLCBbXCJyZWFjdC1kb21cIl0pO1xuICB9KTtcblxuICB0ZXN0KFwiZXh0cmFjdHMgc2NvcGVkIHBhY2thZ2VzXCIsICgpID0+IHtcbiAgICBjb25zdCBkZXNjID0gXCJucG0gaW5zdGFsbCBAdHlwZXMvbm9kZSBAYmFiZWwvY29yZVwiO1xuICAgIGNvbnN0IHBhY2thZ2VzID0gZXh0cmFjdFBhY2thZ2VSZWZlcmVuY2VzKGRlc2MpO1xuICAgIGFzc2VydC5vayhwYWNrYWdlcy5pbmNsdWRlcyhcIkB0eXBlcy9ub2RlXCIpKTtcbiAgICBhc3NlcnQub2socGFja2FnZXMuaW5jbHVkZXMoXCJAYmFiZWwvY29yZVwiKSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJleHRyYWN0cyByZXF1aXJlIHN0YXRlbWVudHMgZnJvbSBjb2RlIGJsb2Nrc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgZGVzYyA9IGBcblxcYFxcYFxcYGphdmFzY3JpcHRcbmNvbnN0IGZzID0gcmVxdWlyZSgnZnMtZXh0cmEnKTtcbmNvbnN0IHBhdGggPSByZXF1aXJlKCdwYXRoJyk7XG5cXGBcXGBcXGBcbiAgICBgO1xuICAgIGNvbnN0IHBhY2thZ2VzID0gZXh0cmFjdFBhY2thZ2VSZWZlcmVuY2VzKGRlc2MpO1xuICAgIGFzc2VydC5vayhwYWNrYWdlcy5pbmNsdWRlcyhcImZzLWV4dHJhXCIpKTtcbiAgfSk7XG5cbiAgdGVzdChcImV4dHJhY3RzIGltcG9ydCBzdGF0ZW1lbnRzIGZyb20gY29kZSBibG9ja3NcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGRlc2MgPSBgXG5cXGBcXGBcXGB0eXBlc2NyaXB0XG5pbXBvcnQgZXhwcmVzcyBmcm9tICdleHByZXNzJztcbmltcG9ydCB7IFJvdXRlciB9IGZyb20gJ2V4cHJlc3MnO1xuaW1wb3J0IHR5cGUgeyBSZXF1ZXN0IH0gZnJvbSAnZXhwcmVzcyc7XG5cXGBcXGBcXGBcbiAgICBgO1xuICAgIGNvbnN0IHBhY2thZ2VzID0gZXh0cmFjdFBhY2thZ2VSZWZlcmVuY2VzKGRlc2MpO1xuICAgIGFzc2VydC5vayhwYWNrYWdlcy5pbmNsdWRlcyhcImV4cHJlc3NcIikpO1xuICB9KTtcblxuICB0ZXN0KFwiaWdub3JlcyByZWxhdGl2ZSBpbXBvcnRzXCIsICgpID0+IHtcbiAgICBjb25zdCBkZXNjID0gYGltcG9ydCB7IGZvbyB9IGZyb20gJy4vbG9jYWwtZmlsZSc7YDtcbiAgICBjb25zdCBwYWNrYWdlcyA9IGV4dHJhY3RQYWNrYWdlUmVmZXJlbmNlcyhkZXNjKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHBhY2thZ2VzLCBbXSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJpZ25vcmVzIG5vZGUgYnVpbHRpbnNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGRlc2MgPSBgaW1wb3J0IGZzIGZyb20gJ25vZGU6ZnMnO2A7XG4gICAgY29uc3QgcGFja2FnZXMgPSBleHRyYWN0UGFja2FnZVJlZmVyZW5jZXMoZGVzYyk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChwYWNrYWdlcywgW10pO1xuICB9KTtcblxuICB0ZXN0KFwibm9ybWFsaXplcyBwYWNrYWdlIHN1YnBhdGhzXCIsICgpID0+IHtcbiAgICBjb25zdCBkZXNjID0gXCJucG0gaW5zdGFsbCBsb2Rhc2gvZ2V0XCI7XG4gICAgY29uc3QgcGFja2FnZXMgPSBleHRyYWN0UGFja2FnZVJlZmVyZW5jZXMoZGVzYyk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChwYWNrYWdlcywgW1wibG9kYXNoXCJdKTtcbiAgfSk7XG5cbiAgdGVzdChcImhhbmRsZXMgZW1wdHkgZGVzY3JpcHRpb25cIiwgKCkgPT4ge1xuICAgIGNvbnN0IHBhY2thZ2VzID0gZXh0cmFjdFBhY2thZ2VSZWZlcmVuY2VzKFwiXCIpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwocGFja2FnZXMsIFtdKTtcbiAgfSk7XG5cbiAgdGVzdChcImlnbm9yZXMgZmxhZ3MgaW4gbnBtIGluc3RhbGxcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGRlc2MgPSBcIm5wbSBpbnN0YWxsIC1EIHR5cGVzY3JpcHRcIjtcbiAgICBjb25zdCBwYWNrYWdlcyA9IGV4dHJhY3RQYWNrYWdlUmVmZXJlbmNlcyhkZXNjKTtcbiAgICBhc3NlcnQub2socGFja2FnZXMuaW5jbHVkZXMoXCJ0eXBlc2NyaXB0XCIpKTtcbiAgICBhc3NlcnQub2soIXBhY2thZ2VzLmluY2x1ZGVzKFwiLURcIikpO1xuICB9KTtcblxuICAvLyBSZWdyZXNzaW9uIHRlc3RzIGZvciAjNDM4ODogcHJvc2UgY29udGFpbmluZyBgZnJvbSBcIi4uLlwiYCBtdXN0IG5vdCBwcm9kdWNlIGZhbHNlLXBvc2l0aXZlIHBhY2thZ2VzXG4gIHRlc3QoXCJkb2VzIG5vdCB0cmVhdCBwcm9zZSAnZnJvbSBcXFwiV2hhdCdzIE5leHRcXFwiJyBhcyBhIHBhY2thZ2UgbmFtZSAoIzQzODgpXCIsICgpID0+IHtcbiAgICBjb25zdCBkZXNjID0gJ0J1aWxkIHRoZSBmZWF0dXJlIGRlc2NyaWJlZCBmcm9tIFwiV2hhdFxcJ3MgTmV4dFwiIGluIHRoZSByb2FkbWFwJztcbiAgICBjb25zdCBwYWNrYWdlcyA9IGV4dHJhY3RQYWNrYWdlUmVmZXJlbmNlcyhkZXNjKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHBhY2thZ2VzLCBbXSwgYHByb3NlICdmcm9tIFwiV2hhdFxcXFwncyBOZXh0XCInIG11c3Qgbm90IHByb2R1Y2UgcGFja2FnZSBuYW1lcywgZ290OiAke0pTT04uc3RyaW5naWZ5KHBhY2thZ2VzKX1gKTtcbiAgfSk7XG5cbiAgdGVzdChcImRvZXMgbm90IHRyZWF0IHByb3NlIFxcXCJmcm9tICdtYXN0ZXInXFxcIiBhcyBhIHBhY2thZ2UgbmFtZSAoIzQzODgpXCIsICgpID0+IHtcbiAgICBjb25zdCBkZXNjID0gXCJSZXZpZXcgY2hhbmdlcyBmcm9tICdtYXN0ZXInIGJyYW5jaCBiZWZvcmUgbWVyZ2luZ1wiO1xuICAgIGNvbnN0IHBhY2thZ2VzID0gZXh0cmFjdFBhY2thZ2VSZWZlcmVuY2VzKGRlc2MpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwocGFja2FnZXMsIFtdLCBgcHJvc2UgXCJmcm9tICdtYXN0ZXInXCIgbXVzdCBub3QgcHJvZHVjZSBwYWNrYWdlIG5hbWVzLCBnb3Q6ICR7SlNPTi5zdHJpbmdpZnkocGFja2FnZXMpfWApO1xuICB9KTtcblxuICB0ZXN0KFwic3RpbGwgZXh0cmFjdHMgaW1wb3J0IHN0YXRlbWVudHMgaW4gY29kZSBibG9ja3MgYWZ0ZXIgIzQzODggZml4XCIsICgpID0+IHtcbiAgICBjb25zdCBkZXNjID0gXCJgYGB0eXBlc2NyaXB0XFxuaW1wb3J0IGV4cHJlc3MgZnJvbSAnZXhwcmVzcyc7XFxuaW1wb3J0IHsgUm91dGVyIH0gZnJvbSAnZXhwcmVzcyc7XFxuYGBgXCI7XG4gICAgY29uc3QgcGFja2FnZXMgPSBleHRyYWN0UGFja2FnZVJlZmVyZW5jZXMoZGVzYyk7XG4gICAgYXNzZXJ0Lm9rKHBhY2thZ2VzLmluY2x1ZGVzKFwiZXhwcmVzc1wiKSwgXCJpbXBvcnQuLi5mcm9tIGluIGNvZGUgYmxvY2tzIG11c3Qgc3RpbGwgYmUgcmVjb2duaXplZFwiKTtcbiAgfSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEZpbGUgUGF0aCBDb25zaXN0ZW5jeSBUZXN0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJjaGVja0ZpbGVQYXRoQ29uc2lzdGVuY3lcIiwgKCkgPT4ge1xuICBsZXQgdGVtcERpcjogc3RyaW5nO1xuXG4gIHRlc3QoXCJwYXNzZXMgd2hlbiBmaWxlcyBleGlzdCBvbiBkaXNrXCIsICgpID0+IHtcbiAgICB0ZW1wRGlyID0gam9pbih0bXBkaXIoKSwgYHByZS1leGVjLXRlc3QtJHtEYXRlLm5vdygpfWApO1xuICAgIG1rZGlyU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4odGVtcERpciwgXCJleGlzdGluZy50c1wiKSwgXCIvLyBjb250ZW50XCIpO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHRhc2tzID0gW1xuICAgICAgICBjcmVhdGVUYXNrKHtcbiAgICAgICAgICBpZDogXCJUMDFcIixcbiAgICAgICAgICBmaWxlczogW1wiZXhpc3RpbmcudHNcIl0sXG4gICAgICAgICAgaW5wdXRzOiBbXSxcbiAgICAgICAgICBleHBlY3RlZF9vdXRwdXQ6IFtdLFxuICAgICAgICB9KSxcbiAgICAgIF07XG5cbiAgICAgIGNvbnN0IHJlc3VsdHMgPSBjaGVja0ZpbGVQYXRoQ29uc2lzdGVuY3kodGFza3MsIHRlbXBEaXIpO1xuICAgICAgYXNzZXJ0LmRlZXBFcXVhbChyZXN1bHRzLCBbXSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwicGFzc2VzIHdoZW4gZmlsZXMgYXJlIGluIHByaW9yIGV4cGVjdGVkX291dHB1dFwiLCAoKSA9PiB7XG4gICAgdGVtcERpciA9IGpvaW4odG1wZGlyKCksIGBwcmUtZXhlYy10ZXN0LSR7RGF0ZS5ub3coKX1gKTtcbiAgICBta2RpclN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgdGFza3MgPSBbXG4gICAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgICAgIHNlcXVlbmNlOiAwLFxuICAgICAgICAgIGZpbGVzOiBbXSxcbiAgICAgICAgICBpbnB1dHM6IFtdLFxuICAgICAgICAgIGV4cGVjdGVkX291dHB1dDogW1wiZ2VuZXJhdGVkLnRzXCJdLFxuICAgICAgICB9KSxcbiAgICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgICAgaWQ6IFwiVDAyXCIsXG4gICAgICAgICAgc2VxdWVuY2U6IDEsXG4gICAgICAgICAgZmlsZXM6IFtcImdlbmVyYXRlZC50c1wiXSxcbiAgICAgICAgICBpbnB1dHM6IFtdLFxuICAgICAgICAgIGV4cGVjdGVkX291dHB1dDogW10sXG4gICAgICAgIH0pLFxuICAgICAgXTtcblxuICAgICAgY29uc3QgcmVzdWx0cyA9IGNoZWNrRmlsZVBhdGhDb25zaXN0ZW5jeSh0YXNrcywgdGVtcERpcik7XG4gICAgICBhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdHMsIFtdKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJmYWlscyB3aGVuIGlucHV0cyBkb24ndCBleGlzdCBhbmQgbm90IGluIHByaW9yIG91dHB1dHNcIiwgKCkgPT4ge1xuICAgIHRlbXBEaXIgPSBqb2luKHRtcGRpcigpLCBgcHJlLWV4ZWMtdGVzdC0ke0RhdGUubm93KCl9YCk7XG4gICAgbWtkaXJTeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHRhc2tzID0gW1xuICAgICAgICBjcmVhdGVUYXNrKHtcbiAgICAgICAgICBpZDogXCJUMDFcIixcbiAgICAgICAgICBmaWxlczogW10sXG4gICAgICAgICAgaW5wdXRzOiBbXCJub25leGlzdGVudC50c1wiXSxcbiAgICAgICAgICBleHBlY3RlZF9vdXRwdXQ6IFtdLFxuICAgICAgICB9KSxcbiAgICAgIF07XG5cbiAgICAgIGNvbnN0IHJlc3VsdHMgPSBjaGVja0ZpbGVQYXRoQ29uc2lzdGVuY3kodGFza3MsIHRlbXBEaXIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHJlc3VsdHMubGVuZ3RoLCAxKTtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHRzWzBdLmNhdGVnb3J5LCBcImZpbGVcIik7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0c1swXS5wYXNzZWQsIGZhbHNlKTtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHRzWzBdLmJsb2NraW5nLCB0cnVlKTtcbiAgICAgIGFzc2VydC5vayhyZXN1bHRzWzBdLm1lc3NhZ2UuaW5jbHVkZXMoXCJub25leGlzdGVudC50c1wiKSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwiY2hlY2tzIG9ubHkgaW5wdXRzIGFycmF5LCBub3QgZmlsZXMgYXJyYXlcIiwgKCkgPT4ge1xuICAgIHRlbXBEaXIgPSBqb2luKHRtcGRpcigpLCBgcHJlLWV4ZWMtdGVzdC0ke0RhdGUubm93KCl9YCk7XG4gICAgbWtkaXJTeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHRhc2tzID0gW1xuICAgICAgICBjcmVhdGVUYXNrKHtcbiAgICAgICAgICBpZDogXCJUMDFcIixcbiAgICAgICAgICBmaWxlczogW1wibWlzc2luZy1maWxlLnRzXCJdLFxuICAgICAgICAgIGlucHV0czogW1wibWlzc2luZy1pbnB1dC50c1wiXSxcbiAgICAgICAgICBleHBlY3RlZF9vdXRwdXQ6IFtdLFxuICAgICAgICB9KSxcbiAgICAgIF07XG5cbiAgICAgIC8vIE9ubHkgaW5wdXRzIGFyZSBjaGVja2VkIFx1MjAxNCBmaWxlcyAoXCJmaWxlcyBsaWtlbHkgdG91Y2hlZFwiKSBhcmUgZXhjbHVkZWRcbiAgICAgIC8vIGJlY2F1c2UgdGhleSBtYXkgaW5jbHVkZSBmaWxlcyB0aGUgdGFzayB3aWxsIGNyZWF0ZSAoIzM2MjYpXG4gICAgICBjb25zdCByZXN1bHRzID0gY2hlY2tGaWxlUGF0aENvbnNpc3RlbmN5KHRhc2tzLCB0ZW1wRGlyKTtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHRzLmxlbmd0aCwgMSk7XG4gICAgICBhc3NlcnQub2socmVzdWx0cy5zb21lKChyKSA9PiByLnRhcmdldCA9PT0gXCJtaXNzaW5nLWlucHV0LnRzXCIpKTtcbiAgICAgIC8vIG1pc3NpbmctZmlsZS50cyBzaG91bGQgTk9UIHByb2R1Y2UgYSBmYWlsdXJlXG4gICAgICBhc3NlcnQub2soIXJlc3VsdHMuc29tZSgocikgPT4gci50YXJnZXQgPT09IFwibWlzc2luZy1maWxlLnRzXCIpKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJza2lwcyBlbXB0eSBmaWxlIHN0cmluZ3NcIiwgKCkgPT4ge1xuICAgIHRlbXBEaXIgPSBqb2luKHRtcGRpcigpLCBgcHJlLWV4ZWMtdGVzdC0ke0RhdGUubm93KCl9YCk7XG4gICAgbWtkaXJTeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHRhc2tzID0gW1xuICAgICAgICBjcmVhdGVUYXNrKHtcbiAgICAgICAgICBpZDogXCJUMDFcIixcbiAgICAgICAgICBmaWxlczogW1wiXCIsIFwiICBcIl0sXG4gICAgICAgICAgaW5wdXRzOiBbXSxcbiAgICAgICAgICBleHBlY3RlZF9vdXRwdXQ6IFtdLFxuICAgICAgICB9KSxcbiAgICAgIF07XG5cbiAgICAgIGNvbnN0IHJlc3VsdHMgPSBjaGVja0ZpbGVQYXRoQ29uc2lzdGVuY3kodGFza3MsIHRlbXBEaXIpO1xuICAgICAgYXNzZXJ0LmRlZXBFcXVhbChyZXN1bHRzLCBbXSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUGF0aCBOb3JtYWxpemF0aW9uIFRlc3RzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcIm5vcm1hbGl6ZUZpbGVQYXRoXCIsICgpID0+IHtcbiAgdGVzdChcInN0cmlwcyBsZWFkaW5nIC4vXCIsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwobm9ybWFsaXplRmlsZVBhdGgoXCIuL3NyYy9hLnRzXCIpLCBcInNyYy9hLnRzXCIpO1xuICAgIGFzc2VydC5lcXVhbChub3JtYWxpemVGaWxlUGF0aChcIi4vLi9mb28udHNcIiksIFwiZm9vLnRzXCIpO1xuICB9KTtcblxuICB0ZXN0KFwibm9ybWFsaXplcyBiYWNrc2xhc2hlcyB0byBmb3J3YXJkIHNsYXNoZXNcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChub3JtYWxpemVGaWxlUGF0aChcInNyY1xcXFxhLnRzXCIpLCBcInNyYy9hLnRzXCIpO1xuICAgIGFzc2VydC5lcXVhbChub3JtYWxpemVGaWxlUGF0aChcInNyY1xcXFxzdWJcXFxcZmlsZS50c1wiKSwgXCJzcmMvc3ViL2ZpbGUudHNcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJyZW1vdmVzIGR1cGxpY2F0ZSBzbGFzaGVzXCIsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwobm9ybWFsaXplRmlsZVBhdGgoXCJzcmMvL2EudHNcIiksIFwic3JjL2EudHNcIik7XG4gICAgYXNzZXJ0LmVxdWFsKG5vcm1hbGl6ZUZpbGVQYXRoKFwic3JjLy8vc3ViLy9maWxlLnRzXCIpLCBcInNyYy9zdWIvZmlsZS50c1wiKTtcbiAgfSk7XG5cbiAgdGVzdChcImhhbmRsZXMgZW1wdHkgc3RyaW5nXCIsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwobm9ybWFsaXplRmlsZVBhdGgoXCJcIiksIFwiXCIpO1xuICB9KTtcblxuICB0ZXN0KFwicmVtb3ZlcyB0cmFpbGluZyBzbGFzaFwiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKG5vcm1hbGl6ZUZpbGVQYXRoKFwic3JjL1wiKSwgXCJzcmNcIik7XG4gICAgYXNzZXJ0LmVxdWFsKG5vcm1hbGl6ZUZpbGVQYXRoKFwic3JjL3N1Yi9cIiksIFwic3JjL3N1YlwiKTtcbiAgfSk7XG5cbiAgdGVzdChcImhhbmRsZXMgcGF0aHMgd2l0aG91dCBhbnkgbm9ybWFsaXphdGlvbiBuZWVkZWRcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChub3JtYWxpemVGaWxlUGF0aChcInNyYy9hLnRzXCIpLCBcInNyYy9hLnRzXCIpO1xuICAgIGFzc2VydC5lcXVhbChub3JtYWxpemVGaWxlUGF0aChcImluZGV4LnRzXCIpLCBcImluZGV4LnRzXCIpO1xuICB9KTtcbn0pO1xuXG5kZXNjcmliZShcImNoZWNrRmlsZVBhdGhDb25zaXN0ZW5jeSB3aXRoIHBhdGggbm9ybWFsaXphdGlvblwiLCAoKSA9PiB7XG4gIGxldCB0ZW1wRGlyOiBzdHJpbmc7XG5cbiAgdGVzdChcIi4vcGF0aCBtYXRjaGVzIHBhdGggaW4gcHJpb3IgZXhwZWN0ZWRfb3V0cHV0XCIsICgpID0+IHtcbiAgICB0ZW1wRGlyID0gam9pbih0bXBkaXIoKSwgYHByZS1leGVjLXRlc3QtJHtEYXRlLm5vdygpfWApO1xuICAgIG1rZGlyU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCB0YXNrcyA9IFtcbiAgICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgICAgaWQ6IFwiVDAxXCIsXG4gICAgICAgICAgc2VxdWVuY2U6IDAsXG4gICAgICAgICAgZmlsZXM6IFtdLFxuICAgICAgICAgIGlucHV0czogW10sXG4gICAgICAgICAgZXhwZWN0ZWRfb3V0cHV0OiBbXCJzcmMvZ2VuZXJhdGVkLnRzXCJdLCAvLyBPdXRwdXQgd2l0aG91dCAuL1xuICAgICAgICB9KSxcbiAgICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgICAgaWQ6IFwiVDAyXCIsXG4gICAgICAgICAgc2VxdWVuY2U6IDEsXG4gICAgICAgICAgZmlsZXM6IFtcIi4vc3JjL2dlbmVyYXRlZC50c1wiXSwgLy8gSW5wdXQgd2l0aCAuL1xuICAgICAgICAgIGlucHV0czogW10sXG4gICAgICAgICAgZXhwZWN0ZWRfb3V0cHV0OiBbXSxcbiAgICAgICAgfSksXG4gICAgICBdO1xuXG4gICAgICBjb25zdCByZXN1bHRzID0gY2hlY2tGaWxlUGF0aENvbnNpc3RlbmN5KHRhc2tzLCB0ZW1wRGlyKTtcbiAgICAgIGFzc2VydC5kZWVwRXF1YWwocmVzdWx0cywgW10sIFwiU2hvdWxkIHBhc3MgYmVjYXVzZSAuL3NyYy9nZW5lcmF0ZWQudHMgbWF0Y2hlcyBzcmMvZ2VuZXJhdGVkLnRzXCIpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcInBhdGggbWF0Y2hlcyAuL3BhdGggaW4gcHJpb3IgZXhwZWN0ZWRfb3V0cHV0XCIsICgpID0+IHtcbiAgICB0ZW1wRGlyID0gam9pbih0bXBkaXIoKSwgYHByZS1leGVjLXRlc3QtJHtEYXRlLm5vdygpfWApO1xuICAgIG1rZGlyU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCB0YXNrcyA9IFtcbiAgICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgICAgaWQ6IFwiVDAxXCIsXG4gICAgICAgICAgc2VxdWVuY2U6IDAsXG4gICAgICAgICAgZmlsZXM6IFtdLFxuICAgICAgICAgIGlucHV0czogW10sXG4gICAgICAgICAgZXhwZWN0ZWRfb3V0cHV0OiBbXCIuL3NyYy9nZW5lcmF0ZWQudHNcIl0sIC8vIE91dHB1dCB3aXRoIC4vXG4gICAgICAgIH0pLFxuICAgICAgICBjcmVhdGVUYXNrKHtcbiAgICAgICAgICBpZDogXCJUMDJcIixcbiAgICAgICAgICBzZXF1ZW5jZTogMSxcbiAgICAgICAgICBmaWxlczogW1wic3JjL2dlbmVyYXRlZC50c1wiXSwgLy8gSW5wdXQgd2l0aG91dCAuL1xuICAgICAgICAgIGlucHV0czogW10sXG4gICAgICAgICAgZXhwZWN0ZWRfb3V0cHV0OiBbXSxcbiAgICAgICAgfSksXG4gICAgICBdO1xuXG4gICAgICBjb25zdCByZXN1bHRzID0gY2hlY2tGaWxlUGF0aENvbnNpc3RlbmN5KHRhc2tzLCB0ZW1wRGlyKTtcbiAgICAgIGFzc2VydC5kZWVwRXF1YWwocmVzdWx0cywgW10sIFwiU2hvdWxkIHBhc3MgYmVjYXVzZSBzcmMvZ2VuZXJhdGVkLnRzIG1hdGNoZXMgLi9zcmMvZ2VuZXJhdGVkLnRzXCIpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcInBhdGhzIHdpdGggbWl4ZWQgc2VwYXJhdG9ycyBtYXRjaFwiLCAoKSA9PiB7XG4gICAgdGVtcERpciA9IGpvaW4odG1wZGlyKCksIGBwcmUtZXhlYy10ZXN0LSR7RGF0ZS5ub3coKX1gKTtcbiAgICBta2RpclN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgdGFza3MgPSBbXG4gICAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgICAgIHNlcXVlbmNlOiAwLFxuICAgICAgICAgIGZpbGVzOiBbXSxcbiAgICAgICAgICBpbnB1dHM6IFtdLFxuICAgICAgICAgIGV4cGVjdGVkX291dHB1dDogW1wic3JjL3N1Yi9maWxlLnRzXCJdLFxuICAgICAgICB9KSxcbiAgICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgICAgaWQ6IFwiVDAyXCIsXG4gICAgICAgICAgc2VxdWVuY2U6IDEsXG4gICAgICAgICAgZmlsZXM6IFtcInNyY1xcXFxzdWJcXFxcZmlsZS50c1wiXSwgLy8gQmFja3NsYXNoIHNlcGFyYXRvcnNcbiAgICAgICAgICBpbnB1dHM6IFtdLFxuICAgICAgICAgIGV4cGVjdGVkX291dHB1dDogW10sXG4gICAgICAgIH0pLFxuICAgICAgXTtcblxuICAgICAgY29uc3QgcmVzdWx0cyA9IGNoZWNrRmlsZVBhdGhDb25zaXN0ZW5jeSh0YXNrcywgdGVtcERpcik7XG4gICAgICBhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdHMsIFtdLCBcIlNob3VsZCBwYXNzIGJlY2F1c2UgYmFja3NsYXNoIHBhdGhzIG5vcm1hbGl6ZSB0byBmb3J3YXJkIHNsYXNoXCIpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoXCJjaGVja1Rhc2tPcmRlcmluZyB3aXRoIHBhdGggbm9ybWFsaXphdGlvblwiLCAoKSA9PiB7XG4gIHRlc3QoXCIuL3BhdGggaW4gaW5wdXRzIHRyaWdnZXJzIG9yZGVyaW5nIGNoZWNrIGZvciBwYXRoIGluIGV4cGVjdGVkX291dHB1dFwiLCAoKSA9PiB7XG4gICAgY29uc3QgdGFza3MgPSBbXG4gICAgICBjcmVhdGVUYXNrKHtcbiAgICAgICAgaWQ6IFwiVDAxXCIsXG4gICAgICAgIHNlcXVlbmNlOiAwLFxuICAgICAgICBmaWxlczogW10sXG4gICAgICAgIGlucHV0czogW1wiLi9nZW5lcmF0ZWQudHNcIl0sIC8vIFJlYWRzIHdpdGggLi9cbiAgICAgICAgZXhwZWN0ZWRfb3V0cHV0OiBbXSxcbiAgICAgIH0pLFxuICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlQwMlwiLFxuICAgICAgICBzZXF1ZW5jZTogMSxcbiAgICAgICAgZmlsZXM6IFtdLFxuICAgICAgICBpbnB1dHM6IFtdLFxuICAgICAgICBleHBlY3RlZF9vdXRwdXQ6IFtcImdlbmVyYXRlZC50c1wiXSwgLy8gQ3JlYXRlcyB3aXRob3V0IC4vXG4gICAgICB9KSxcbiAgICBdO1xuXG4gICAgY29uc3QgcmVzdWx0cyA9IGNoZWNrVGFza09yZGVyaW5nKHRhc2tzLCBcIi90bXBcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdHMubGVuZ3RoLCAxLCBcIlNob3VsZCBkZXRlY3Qgb3JkZXJpbmcgdmlvbGF0aW9uIGRlc3BpdGUgLi9cIik7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdHNbMF0ubWVzc2FnZS5pbmNsdWRlcyhcIlQwMVwiKSk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdHNbMF0ubWVzc2FnZS5pbmNsdWRlcyhcIlQwMlwiKSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJwYXRoIGluIGlucHV0cyB0cmlnZ2VycyBvcmRlcmluZyBjaGVjayBmb3IgLi9wYXRoIGluIGV4cGVjdGVkX291dHB1dFwiLCAoKSA9PiB7XG4gICAgY29uc3QgdGFza3MgPSBbXG4gICAgICBjcmVhdGVUYXNrKHtcbiAgICAgICAgaWQ6IFwiVDAxXCIsXG4gICAgICAgIHNlcXVlbmNlOiAwLFxuICAgICAgICBmaWxlczogW10sXG4gICAgICAgIGlucHV0czogW1wiZ2VuZXJhdGVkLnRzXCJdLCAvLyBSZWFkcyB3aXRob3V0IC4vXG4gICAgICAgIGV4cGVjdGVkX291dHB1dDogW10sXG4gICAgICB9KSxcbiAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICBpZDogXCJUMDJcIixcbiAgICAgICAgc2VxdWVuY2U6IDEsXG4gICAgICAgIGZpbGVzOiBbXSxcbiAgICAgICAgaW5wdXRzOiBbXSxcbiAgICAgICAgZXhwZWN0ZWRfb3V0cHV0OiBbXCIuL2dlbmVyYXRlZC50c1wiXSwgLy8gQ3JlYXRlcyB3aXRoIC4vXG4gICAgICB9KSxcbiAgICBdO1xuXG4gICAgY29uc3QgcmVzdWx0cyA9IGNoZWNrVGFza09yZGVyaW5nKHRhc2tzLCBcIi90bXBcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdHMubGVuZ3RoLCAxLCBcIlNob3VsZCBkZXRlY3Qgb3JkZXJpbmcgdmlvbGF0aW9uIGRlc3BpdGUgLi8gb24gY3JlYXRvclwiKTtcbiAgICBhc3NlcnQub2socmVzdWx0c1swXS5tZXNzYWdlLmluY2x1ZGVzKFwic2VxdWVuY2UgdmlvbGF0aW9uXCIpKTtcbiAgfSk7XG5cbiAgdGVzdChcIm5vIGZhbHNlIHBvc2l0aXZlIHdoZW4gY29ycmVjdGx5IG9yZGVyZWQgd2l0aCBtaXhlZCBwYXRoc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgdGFza3MgPSBbXG4gICAgICBjcmVhdGVUYXNrKHtcbiAgICAgICAgaWQ6IFwiVDAxXCIsXG4gICAgICAgIHNlcXVlbmNlOiAwLFxuICAgICAgICBmaWxlczogW10sXG4gICAgICAgIGlucHV0czogW10sXG4gICAgICAgIGV4cGVjdGVkX291dHB1dDogW1wiLi9zcmMvYXBpLnRzXCJdLFxuICAgICAgfSksXG4gICAgICBjcmVhdGVUYXNrKHtcbiAgICAgICAgaWQ6IFwiVDAyXCIsXG4gICAgICAgIHNlcXVlbmNlOiAxLFxuICAgICAgICBmaWxlczogW1wic3JjL2FwaS50c1wiXSwgLy8gU2FtZSBmaWxlLCBkaWZmZXJlbnQgbm90YXRpb25cbiAgICAgICAgaW5wdXRzOiBbXSxcbiAgICAgICAgZXhwZWN0ZWRfb3V0cHV0OiBbXSxcbiAgICAgIH0pLFxuICAgIF07XG5cbiAgICBjb25zdCByZXN1bHRzID0gY2hlY2tUYXNrT3JkZXJpbmcodGFza3MsIFwiL3RtcFwiKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdHMsIFtdLCBcIlNob3VsZCBwYXNzIC0gVDAyIHJlYWRzIGZpbGUgdGhhdCBUMDEgYWxyZWFkeSBjcmVhdGVkXCIpO1xuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGFzayBPcmRlcmluZyBUZXN0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJjaGVja1Rhc2tPcmRlcmluZ1wiLCAoKSA9PiB7XG4gIHRlc3QoXCJwYXNzZXMgd2hlbiB0YXNrcyBhcmUgY29ycmVjdGx5IG9yZGVyZWRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHRhc2tzID0gW1xuICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgICBzZXF1ZW5jZTogMCxcbiAgICAgICAgZmlsZXM6IFtdLFxuICAgICAgICBpbnB1dHM6IFtdLFxuICAgICAgICBleHBlY3RlZF9vdXRwdXQ6IFtcImFwaS50c1wiXSxcbiAgICAgIH0pLFxuICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlQwMlwiLFxuICAgICAgICBzZXF1ZW5jZTogMSxcbiAgICAgICAgZmlsZXM6IFtcImFwaS50c1wiXSxcbiAgICAgICAgaW5wdXRzOiBbXSxcbiAgICAgICAgZXhwZWN0ZWRfb3V0cHV0OiBbXSxcbiAgICAgIH0pLFxuICAgIF07XG5cbiAgICBjb25zdCByZXN1bHRzID0gY2hlY2tUYXNrT3JkZXJpbmcodGFza3MsIFwiL3RtcFwiKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdHMsIFtdKTtcbiAgfSk7XG5cbiAgdGVzdChcImZhaWxzIHdoZW4gdGFzayBpbnB1dHMgcmVmZXJlbmNlIGZpbGUgY3JlYXRlZCBieSBsYXRlciB0YXNrXCIsICgpID0+IHtcbiAgICBjb25zdCB0YXNrcyA9IFtcbiAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICBpZDogXCJUMDFcIixcbiAgICAgICAgc2VxdWVuY2U6IDAsXG4gICAgICAgIGZpbGVzOiBbXSxcbiAgICAgICAgaW5wdXRzOiBbXCJnZW5lcmF0ZWQudHNcIl0sIC8vIFJlYWRzIGZpbGUgdGhhdCBkb2Vzbid0IGV4aXN0IHlldFxuICAgICAgICBleHBlY3RlZF9vdXRwdXQ6IFtdLFxuICAgICAgfSksXG4gICAgICBjcmVhdGVUYXNrKHtcbiAgICAgICAgaWQ6IFwiVDAyXCIsXG4gICAgICAgIHNlcXVlbmNlOiAxLFxuICAgICAgICBmaWxlczogW10sXG4gICAgICAgIGlucHV0czogW10sXG4gICAgICAgIGV4cGVjdGVkX291dHB1dDogW1wiZ2VuZXJhdGVkLnRzXCJdLCAvLyBDcmVhdGVzIHRoZSBmaWxlXG4gICAgICB9KSxcbiAgICBdO1xuXG4gICAgY29uc3QgcmVzdWx0cyA9IGNoZWNrVGFza09yZGVyaW5nKHRhc2tzLCBcIi90bXBcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdHMubGVuZ3RoLCAxKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0c1swXS5jYXRlZ29yeSwgXCJmaWxlXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHRzWzBdLnBhc3NlZCwgZmFsc2UpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHRzWzBdLmJsb2NraW5nLCB0cnVlKTtcbiAgICBhc3NlcnQub2socmVzdWx0c1swXS5tZXNzYWdlLmluY2x1ZGVzKFwiVDAxXCIpKTtcbiAgICBhc3NlcnQub2socmVzdWx0c1swXS5tZXNzYWdlLmluY2x1ZGVzKFwiVDAyXCIpKTtcbiAgICBhc3NlcnQub2socmVzdWx0c1swXS5tZXNzYWdlLmluY2x1ZGVzKFwic2VxdWVuY2UgdmlvbGF0aW9uXCIpKTtcbiAgfSk7XG5cbiAgdGVzdChcImRldGVjdHMgb3JkZXJpbmcgdmlvbGF0aW9uIGluIGlucHV0cyBhcnJheVwiLCAoKSA9PiB7XG4gICAgY29uc3QgdGFza3MgPSBbXG4gICAgICBjcmVhdGVUYXNrKHtcbiAgICAgICAgaWQ6IFwiVDAxXCIsXG4gICAgICAgIHNlcXVlbmNlOiAwLFxuICAgICAgICBmaWxlczogW10sXG4gICAgICAgIGlucHV0czogW1wic2NoZW1hLmpzb25cIl0sXG4gICAgICAgIGV4cGVjdGVkX291dHB1dDogW10sXG4gICAgICB9KSxcbiAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICBpZDogXCJUMDJcIixcbiAgICAgICAgc2VxdWVuY2U6IDEsXG4gICAgICAgIGZpbGVzOiBbXSxcbiAgICAgICAgaW5wdXRzOiBbXSxcbiAgICAgICAgZXhwZWN0ZWRfb3V0cHV0OiBbXCJzY2hlbWEuanNvblwiXSxcbiAgICAgIH0pLFxuICAgIF07XG5cbiAgICBjb25zdCByZXN1bHRzID0gY2hlY2tUYXNrT3JkZXJpbmcodGFza3MsIFwiL3RtcFwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0cy5sZW5ndGgsIDEpO1xuICAgIGFzc2VydC5vayhyZXN1bHRzWzBdLm1lc3NhZ2UuaW5jbHVkZXMoXCJzY2hlbWEuanNvblwiKSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJoYW5kbGVzIG11bHRpcGxlIG9yZGVyaW5nIHZpb2xhdGlvbnMgdmlhIGlucHV0c1wiLCAoKSA9PiB7XG4gICAgY29uc3QgdGFza3MgPSBbXG4gICAgICBjcmVhdGVUYXNrKHtcbiAgICAgICAgaWQ6IFwiVDAxXCIsXG4gICAgICAgIHNlcXVlbmNlOiAwLFxuICAgICAgICBmaWxlczogW10sXG4gICAgICAgIGlucHV0czogW1wiYS50c1wiLCBcImIudHNcIl0sXG4gICAgICAgIGV4cGVjdGVkX291dHB1dDogW10sXG4gICAgICB9KSxcbiAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICBpZDogXCJUMDJcIixcbiAgICAgICAgc2VxdWVuY2U6IDEsXG4gICAgICAgIGZpbGVzOiBbXSxcbiAgICAgICAgaW5wdXRzOiBbXSxcbiAgICAgICAgZXhwZWN0ZWRfb3V0cHV0OiBbXCJhLnRzXCJdLFxuICAgICAgfSksXG4gICAgICBjcmVhdGVUYXNrKHtcbiAgICAgICAgaWQ6IFwiVDAzXCIsXG4gICAgICAgIHNlcXVlbmNlOiAyLFxuICAgICAgICBmaWxlczogW10sXG4gICAgICAgIGlucHV0czogW10sXG4gICAgICAgIGV4cGVjdGVkX291dHB1dDogW1wiYi50c1wiXSxcbiAgICAgIH0pLFxuICAgIF07XG5cbiAgICBjb25zdCByZXN1bHRzID0gY2hlY2tUYXNrT3JkZXJpbmcodGFza3MsIFwiL3RtcFwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0cy5sZW5ndGgsIDIpO1xuICB9KTtcblxuICB0ZXN0KFwicGFzc2VzIHdoZW4gbm8gZGVwZW5kZW5jaWVzIGJldHdlZW4gdGFza3NcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHRhc2tzID0gW1xuICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgICBzZXF1ZW5jZTogMCxcbiAgICAgICAgZmlsZXM6IFtdLFxuICAgICAgICBpbnB1dHM6IFtdLFxuICAgICAgICBleHBlY3RlZF9vdXRwdXQ6IFtcImEudHNcIl0sXG4gICAgICB9KSxcbiAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICBpZDogXCJUMDJcIixcbiAgICAgICAgc2VxdWVuY2U6IDEsXG4gICAgICAgIGZpbGVzOiBbXSxcbiAgICAgICAgaW5wdXRzOiBbXSxcbiAgICAgICAgZXhwZWN0ZWRfb3V0cHV0OiBbXCJiLnRzXCJdLFxuICAgICAgfSksXG4gICAgXTtcblxuICAgIGNvbnN0IHJlc3VsdHMgPSBjaGVja1Rhc2tPcmRlcmluZyh0YXNrcywgXCIvdG1wXCIpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwocmVzdWx0cywgW10pO1xuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgSW50ZXJmYWNlIENvbnRyYWN0IFRlc3RzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcImNoZWNrSW50ZXJmYWNlQ29udHJhY3RzXCIsICgpID0+IHtcbiAgdGVzdChcInBhc3NlcyB3aGVuIGZ1bmN0aW9uIHNpZ25hdHVyZXMgbWF0Y2hcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHRhc2tzID0gW1xuICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgICBkZXNjcmlwdGlvbjogYFxuXFxgXFxgXFxgdHlwZXNjcmlwdFxuZnVuY3Rpb24gcHJvY2Vzc0RhdGEoaW5wdXQ6IHN0cmluZyk6IGJvb2xlYW5cblxcYFxcYFxcYFxuICAgICAgICBgLFxuICAgICAgfSksXG4gICAgICBjcmVhdGVUYXNrKHtcbiAgICAgICAgaWQ6IFwiVDAyXCIsXG4gICAgICAgIGRlc2NyaXB0aW9uOiBgXG5cXGBcXGBcXGB0eXBlc2NyaXB0XG5mdW5jdGlvbiBwcm9jZXNzRGF0YShpbnB1dDogc3RyaW5nKTogYm9vbGVhblxuXFxgXFxgXFxgXG4gICAgICAgIGAsXG4gICAgICB9KSxcbiAgICBdO1xuXG4gICAgY29uc3QgcmVzdWx0cyA9IGNoZWNrSW50ZXJmYWNlQ29udHJhY3RzKHRhc2tzLCBcIi90bXBcIik7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChyZXN1bHRzLCBbXSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJ3YXJucyBvbiBwYXJhbWV0ZXIgbWlzbWF0Y2ggKG5vbi1ibG9ja2luZylcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHRhc2tzID0gW1xuICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgICBkZXNjcmlwdGlvbjogYFxuXFxgXFxgXFxgdHlwZXNjcmlwdFxuZnVuY3Rpb24gc2F2ZVVzZXIobmFtZTogc3RyaW5nKTogdm9pZFxuXFxgXFxgXFxgXG4gICAgICAgIGAsXG4gICAgICB9KSxcbiAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICBpZDogXCJUMDJcIixcbiAgICAgICAgZGVzY3JpcHRpb246IGBcblxcYFxcYFxcYHR5cGVzY3JpcHRcbmZ1bmN0aW9uIHNhdmVVc2VyKG5hbWU6IHN0cmluZywgZW1haWw6IHN0cmluZyk6IHZvaWRcblxcYFxcYFxcYFxuICAgICAgICBgLFxuICAgICAgfSksXG4gICAgXTtcblxuICAgIGNvbnN0IHJlc3VsdHMgPSBjaGVja0ludGVyZmFjZUNvbnRyYWN0cyh0YXNrcywgXCIvdG1wXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHRzLmxlbmd0aCwgMSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdHNbMF0uY2F0ZWdvcnksIFwic2NoZW1hXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHRzWzBdLnRhcmdldCwgXCJzYXZlVXNlclwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0c1swXS5wYXNzZWQsIHRydWUpOyAvLyBXYXJuaW5nLCBub3QgZmFpbHVyZVxuICAgIGFzc2VydC5lcXVhbChyZXN1bHRzWzBdLmJsb2NraW5nLCBmYWxzZSk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdHNbMF0ubWVzc2FnZS5pbmNsdWRlcyhcImRpZmZlcmVudCBwYXJhbWV0ZXJzXCIpKTtcbiAgfSk7XG5cbiAgdGVzdChcIndhcm5zIG9uIHJldHVybiB0eXBlIG1pc21hdGNoIChub24tYmxvY2tpbmcpXCIsICgpID0+IHtcbiAgICBjb25zdCB0YXNrcyA9IFtcbiAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICBpZDogXCJUMDFcIixcbiAgICAgICAgZGVzY3JpcHRpb246IGBcblxcYFxcYFxcYHR5cGVzY3JpcHRcbmZ1bmN0aW9uIGdldERhdGEoKTogc3RyaW5nXG5cXGBcXGBcXGBcbiAgICAgICAgYCxcbiAgICAgIH0pLFxuICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlQwMlwiLFxuICAgICAgICBkZXNjcmlwdGlvbjogYFxuXFxgXFxgXFxgdHlwZXNjcmlwdFxuZnVuY3Rpb24gZ2V0RGF0YSgpOiBudW1iZXJcblxcYFxcYFxcYFxuICAgICAgICBgLFxuICAgICAgfSksXG4gICAgXTtcblxuICAgIGNvbnN0IHJlc3VsdHMgPSBjaGVja0ludGVyZmFjZUNvbnRyYWN0cyh0YXNrcywgXCIvdG1wXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHRzLmxlbmd0aCwgMSk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdHNbMF0ubWVzc2FnZS5pbmNsdWRlcyhcImRpZmZlcmVudCByZXR1cm4gdHlwZXNcIikpO1xuICB9KTtcblxuICB0ZXN0KFwiaGFuZGxlcyBleHBvcnQgZnVuY3Rpb24gc3ludGF4XCIsICgpID0+IHtcbiAgICBjb25zdCB0YXNrcyA9IFtcbiAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICBpZDogXCJUMDFcIixcbiAgICAgICAgZGVzY3JpcHRpb246IGBcblxcYFxcYFxcYHR5cGVzY3JpcHRcbmV4cG9ydCBmdW5jdGlvbiB2YWxpZGF0ZShkYXRhOiBvYmplY3QpOiBib29sZWFuXG5cXGBcXGBcXGBcbiAgICAgICAgYCxcbiAgICAgIH0pLFxuICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlQwMlwiLFxuICAgICAgICBkZXNjcmlwdGlvbjogYFxuXFxgXFxgXFxgdHlwZXNjcmlwdFxuZXhwb3J0IGZ1bmN0aW9uIHZhbGlkYXRlKGRhdGE6IHN0cmluZyk6IGJvb2xlYW5cblxcYFxcYFxcYFxuICAgICAgICBgLFxuICAgICAgfSksXG4gICAgXTtcblxuICAgIGNvbnN0IHJlc3VsdHMgPSBjaGVja0ludGVyZmFjZUNvbnRyYWN0cyh0YXNrcywgXCIvdG1wXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHRzLmxlbmd0aCwgMSk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdHNbMF0ubWVzc2FnZS5pbmNsdWRlcyhcInZhbGlkYXRlXCIpKTtcbiAgfSk7XG5cbiAgdGVzdChcImhhbmRsZXMgYXN5bmMgZnVuY3Rpb24gc3ludGF4XCIsICgpID0+IHtcbiAgICBjb25zdCB0YXNrcyA9IFtcbiAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICBpZDogXCJUMDFcIixcbiAgICAgICAgZGVzY3JpcHRpb246IGBcblxcYFxcYFxcYHR5cGVzY3JpcHRcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmZXRjaERhdGEoKTogUHJvbWlzZTxzdHJpbmc+XG5cXGBcXGBcXGBcbiAgICAgICAgYCxcbiAgICAgIH0pLFxuICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlQwMlwiLFxuICAgICAgICBkZXNjcmlwdGlvbjogYFxuXFxgXFxgXFxgdHlwZXNjcmlwdFxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZldGNoRGF0YSgpOiBQcm9taXNlPG51bWJlcj5cblxcYFxcYFxcYFxuICAgICAgICBgLFxuICAgICAgfSksXG4gICAgXTtcblxuICAgIGNvbnN0IHJlc3VsdHMgPSBjaGVja0ludGVyZmFjZUNvbnRyYWN0cyh0YXNrcywgXCIvdG1wXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHRzLmxlbmd0aCwgMSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJoYW5kbGVzIGNvbnN0IGFycm93IGZ1bmN0aW9uIHN5bnRheFwiLCAoKSA9PiB7XG4gICAgY29uc3QgdGFza3MgPSBbXG4gICAgICBjcmVhdGVUYXNrKHtcbiAgICAgICAgaWQ6IFwiVDAxXCIsXG4gICAgICAgIGRlc2NyaXB0aW9uOiBgXG5cXGBcXGBcXGB0eXBlc2NyaXB0XG5jb25zdCBoYW5kbGVyID0gKHJlcTogUmVxdWVzdCk6IFJlc3BvbnNlID0+XG5cXGBcXGBcXGBcbiAgICAgICAgYCxcbiAgICAgIH0pLFxuICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlQwMlwiLFxuICAgICAgICBkZXNjcmlwdGlvbjogYFxuXFxgXFxgXFxgdHlwZXNjcmlwdFxuY29uc3QgaGFuZGxlciA9IChyZXE6IFJlcXVlc3QsIHJlczogUmVzcG9uc2UpOiB2b2lkID0+XG5cXGBcXGBcXGBcbiAgICAgICAgYCxcbiAgICAgIH0pLFxuICAgIF07XG5cbiAgICBjb25zdCByZXN1bHRzID0gY2hlY2tJbnRlcmZhY2VDb250cmFjdHModGFza3MsIFwiL3RtcFwiKTtcbiAgICAvLyBTaG91bGQgaGF2ZSAyIHJlc3VsdHM6IHBhcmFtZXRlciBtaXNtYXRjaCBBTkQgcmV0dXJuIHR5cGUgbWlzbWF0Y2hcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0cy5sZW5ndGgsIDIpO1xuICAgIGFzc2VydC5vayhyZXN1bHRzLnNvbWUoKHIpID0+IHIubWVzc2FnZS5pbmNsdWRlcyhcImhhbmRsZXJcIikpKTtcbiAgICBhc3NlcnQub2socmVzdWx0cy5zb21lKChyKSA9PiByLm1lc3NhZ2UuaW5jbHVkZXMoXCJwYXJhbWV0ZXJzXCIpKSk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdHMuc29tZSgocikgPT4gci5tZXNzYWdlLmluY2x1ZGVzKFwicmV0dXJuIHR5cGVzXCIpKSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJwYXNzZXMgd2hlbiBubyBjb2RlIGJsb2NrcyBwcmVzZW50XCIsICgpID0+IHtcbiAgICBjb25zdCB0YXNrcyA9IFtcbiAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICBpZDogXCJUMDFcIixcbiAgICAgICAgZGVzY3JpcHRpb246IFwiSnVzdCBzb21lIHRleHQgd2l0aG91dCBjb2RlIGJsb2Nrc1wiLFxuICAgICAgfSksXG4gICAgXTtcblxuICAgIGNvbnN0IHJlc3VsdHMgPSBjaGVja0ludGVyZmFjZUNvbnRyYWN0cyh0YXNrcywgXCIvdG1wXCIpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwocmVzdWx0cywgW10pO1xuICB9KTtcblxuICB0ZXN0KFwiaGFuZGxlcyBtdWx0aXBsZSBtaXNtYXRjaGVzIGZvciBzYW1lIGZ1bmN0aW9uXCIsICgpID0+IHtcbiAgICBjb25zdCB0YXNrcyA9IFtcbiAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICBpZDogXCJUMDFcIixcbiAgICAgICAgZGVzY3JpcHRpb246IGBcblxcYFxcYFxcYHR5cGVzY3JpcHRcbmZ1bmN0aW9uIHByb2Nlc3MoYTogc3RyaW5nKTogc3RyaW5nXG5cXGBcXGBcXGBcbiAgICAgICAgYCxcbiAgICAgIH0pLFxuICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlQwMlwiLFxuICAgICAgICBkZXNjcmlwdGlvbjogYFxuXFxgXFxgXFxgdHlwZXNjcmlwdFxuZnVuY3Rpb24gcHJvY2VzcyhhOiBudW1iZXIpOiBudW1iZXJcblxcYFxcYFxcYFxuICAgICAgICBgLFxuICAgICAgfSksXG4gICAgXTtcblxuICAgIGNvbnN0IHJlc3VsdHMgPSBjaGVja0ludGVyZmFjZUNvbnRyYWN0cyh0YXNrcywgXCIvdG1wXCIpO1xuICAgIC8vIFNob3VsZCBoYXZlIGJvdGggcGFyYW1ldGVyIGFuZCByZXR1cm4gdHlwZSBtaXNtYXRjaGVzXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdHMubGVuZ3RoLCAyKTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoXCJjaGVja1ZlcmlmaWNhdGlvbkNvbW1hbmRzXCIsICgpID0+IHtcbiAgdGVzdChcImFjY2VwdHMgcGlwZS1mcmVlIHB5dGVzdCBWZXJpZnkgY29tbWFuZFwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0cyA9IGNoZWNrVmVyaWZpY2F0aW9uQ29tbWFuZHMoW1xuICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgICB2ZXJpZnk6IFwicHl0aG9uMyAtbSBweXRlc3QgdGVzdHMvIC1xIC0tdGI9c2hvcnRcIixcbiAgICAgIH0pLFxuICAgIF0pO1xuXG4gICAgYXNzZXJ0LmRlZXBFcXVhbChyZXN1bHRzLCBbXSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJyZWplY3RzIHBpcGVkIHB5dGVzdCBWZXJpZnkgY29tbWFuZFwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0cyA9IGNoZWNrVmVyaWZpY2F0aW9uQ29tbWFuZHMoW1xuICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgICB2ZXJpZnk6IFwicHl0aG9uMyAtbSBweXRlc3QgdGVzdHMvIC1xIC0tdGI9c2hvcnQgMj4mMSB8IHRhaWwgLTVcIixcbiAgICAgIH0pLFxuICAgIF0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdHMubGVuZ3RoLCAxKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0c1swXT8uY2F0ZWdvcnksIFwidG9vbFwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0c1swXT8uYmxvY2tpbmcsIHRydWUpO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHRzWzBdPy5tZXNzYWdlID8/IFwiXCIsIC9zaGVsbCBjb250cm9sIHN5bnRheC8pO1xuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgcnVuUHJlRXhlY3V0aW9uQ2hlY2tzIEludGVncmF0aW9uIFRlc3RzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcInJ1blByZUV4ZWN1dGlvbkNoZWNrc1wiLCAoKSA9PiB7XG4gIGxldCB0ZW1wRGlyOiBzdHJpbmc7XG5cbiAgdGVzdChcInJldHVybnMgcGFzcyBzdGF0dXMgd2hlbiBhbGwgY2hlY2tzIHBhc3NcIiwgYXN5bmMgKCkgPT4ge1xuICAgIHRlbXBEaXIgPSBqb2luKHRtcGRpcigpLCBgcHJlLWV4ZWMtdGVzdC0ke0RhdGUubm93KCl9YCk7XG4gICAgbWtkaXJTeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbih0ZW1wRGlyLCBcImV4aXN0aW5nLnRzXCIpLCBcIi8vIGNvbnRlbnRcIik7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgdGFza3MgPSBbXG4gICAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgICAgIGZpbGVzOiBbXCJleGlzdGluZy50c1wiXSxcbiAgICAgICAgICBpbnB1dHM6IFtdLFxuICAgICAgICAgIGV4cGVjdGVkX291dHB1dDogW1wib3V0cHV0LnRzXCJdLFxuICAgICAgICB9KSxcbiAgICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgICAgaWQ6IFwiVDAyXCIsXG4gICAgICAgICAgZmlsZXM6IFtcIm91dHB1dC50c1wiXSxcbiAgICAgICAgICBpbnB1dHM6IFtdLFxuICAgICAgICAgIGV4cGVjdGVkX291dHB1dDogW10sXG4gICAgICAgIH0pLFxuICAgICAgXTtcblxuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuUHJlRXhlY3V0aW9uQ2hlY2tzKHRhc2tzLCB0ZW1wRGlyKTtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc3RhdHVzLCBcInBhc3NcIik7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmNoZWNrcy5sZW5ndGgsIDApO1xuICAgICAgYXNzZXJ0Lm9rKHJlc3VsdC5kdXJhdGlvbk1zID49IDApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcInJldHVybnMgZmFpbCBzdGF0dXMgZm9yIHVuc2FmZSBWZXJpZnkgY29tbWFuZCBiZWZvcmUgZXhlY3V0aW9uXCIsIGFzeW5jICgpID0+IHtcbiAgICB0ZW1wRGlyID0gam9pbih0bXBkaXIoKSwgYHByZS1leGVjLXRlc3QtJHtEYXRlLm5vdygpfWApO1xuICAgIG1rZGlyU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCB0YXNrcyA9IFtcbiAgICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgICAgaWQ6IFwiVDAxXCIsXG4gICAgICAgICAgdmVyaWZ5OiBcInB5dGhvbjMgLW0gcHl0ZXN0IHRlc3RzLyAtcSAtLXRiPXNob3J0IDI+JjEgfCB0YWlsIC01XCIsXG4gICAgICAgIH0pLFxuICAgICAgXTtcblxuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuUHJlRXhlY3V0aW9uQ2hlY2tzKHRhc2tzLCB0ZW1wRGlyKTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zdGF0dXMsIFwiZmFpbFwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHQuY2hlY2tzLmxlbmd0aCwgMSk7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmNoZWNrc1swXT8uY2F0ZWdvcnksIFwidG9vbFwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHQuY2hlY2tzWzBdPy5ibG9ja2luZywgdHJ1ZSk7XG4gICAgICBhc3NlcnQubWF0Y2gocmVzdWx0LmNoZWNrc1swXT8ubWVzc2FnZSA/PyBcIlwiLCAvVW5zYWZlIG9yIG5vbi1ydW5uYWJsZSBWZXJpZnkgY29tbWFuZC8pO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcInJldHVybnMgZmFpbCBzdGF0dXMgd2hlbiBibG9ja2luZyBmYWlsdXJlIGV4aXN0c1wiLCBhc3luYyAoKSA9PiB7XG4gICAgdGVtcERpciA9IGpvaW4odG1wZGlyKCksIGBwcmUtZXhlYy10ZXN0LSR7RGF0ZS5ub3coKX1gKTtcbiAgICBta2RpclN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgdGFza3MgPSBbXG4gICAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgICAgIGZpbGVzOiBbXSxcbiAgICAgICAgICBpbnB1dHM6IFtcIm5vbmV4aXN0ZW50LnRzXCJdLFxuICAgICAgICAgIGV4cGVjdGVkX291dHB1dDogW10sXG4gICAgICAgIH0pLFxuICAgICAgXTtcblxuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuUHJlRXhlY3V0aW9uQ2hlY2tzKHRhc2tzLCB0ZW1wRGlyKTtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc3RhdHVzLCBcImZhaWxcIik7XG4gICAgICBhc3NlcnQub2socmVzdWx0LmNoZWNrcy5sZW5ndGggPiAwKTtcbiAgICAgIGFzc2VydC5vayhyZXN1bHQuY2hlY2tzLnNvbWUoKGMpID0+IGMuYmxvY2tpbmcgPT09IHRydWUpKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJyZXR1cm5zIHdhcm4gc3RhdHVzIGZvciBub24tYmxvY2tpbmcgaXNzdWVzXCIsIGFzeW5jICgpID0+IHtcbiAgICB0ZW1wRGlyID0gam9pbih0bXBkaXIoKSwgYHByZS1leGVjLXRlc3QtJHtEYXRlLm5vdygpfWApO1xuICAgIG1rZGlyU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAgIHRyeSB7XG4gICAgICAvLyBDcmVhdGUgdGFza3Mgd2l0aCBvbmx5IGludGVyZmFjZSBjb250cmFjdCB3YXJuaW5nc1xuICAgICAgY29uc3QgdGFza3MgPSBbXG4gICAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgICAgIGZpbGVzOiBbXSxcbiAgICAgICAgICBpbnB1dHM6IFtdLFxuICAgICAgICAgIGV4cGVjdGVkX291dHB1dDogW10sXG4gICAgICAgICAgZGVzY3JpcHRpb246IGBcblxcYFxcYFxcYHR5cGVzY3JpcHRcbmZ1bmN0aW9uIGZvbyhhOiBzdHJpbmcpOiB2b2lkXG5cXGBcXGBcXGBcbiAgICAgICAgICBgLFxuICAgICAgICB9KSxcbiAgICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgICAgaWQ6IFwiVDAyXCIsXG4gICAgICAgICAgZmlsZXM6IFtdLFxuICAgICAgICAgIGlucHV0czogW10sXG4gICAgICAgICAgZXhwZWN0ZWRfb3V0cHV0OiBbXSxcbiAgICAgICAgICBkZXNjcmlwdGlvbjogYFxuXFxgXFxgXFxgdHlwZXNjcmlwdFxuZnVuY3Rpb24gZm9vKGE6IG51bWJlcik6IHZvaWRcblxcYFxcYFxcYFxuICAgICAgICAgIGAsXG4gICAgICAgIH0pLFxuICAgICAgXTtcblxuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuUHJlRXhlY3V0aW9uQ2hlY2tzKHRhc2tzLCB0ZW1wRGlyKTtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc3RhdHVzLCBcIndhcm5cIik7XG4gICAgICBhc3NlcnQub2socmVzdWx0LmNoZWNrcy5zb21lKChjKSA9PiBjLmJsb2NraW5nID09PSBmYWxzZSkpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcImNvbWJpbmVzIHJlc3VsdHMgZnJvbSBhbGwgY2hlY2sgdHlwZXNcIiwgYXN5bmMgKCkgPT4ge1xuICAgIHRlbXBEaXIgPSBqb2luKHRtcGRpcigpLCBgcHJlLWV4ZWMtdGVzdC0ke0RhdGUubm93KCl9YCk7XG4gICAgbWtkaXJTeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHRhc2tzID0gW1xuICAgICAgICBjcmVhdGVUYXNrKHtcbiAgICAgICAgICBpZDogXCJUMDFcIixcbiAgICAgICAgICBzZXF1ZW5jZTogMCxcbiAgICAgICAgICBmaWxlczogW1wid2lsbC1iZS1jcmVhdGVkLnRzXCJdLCAvLyBPcmRlcmluZyB2aW9sYXRpb25cbiAgICAgICAgICBpbnB1dHM6IFtcIm1pc3NpbmcudHNcIl0sICAgICAgICAvLyBNaXNzaW5nIGZpbGVcbiAgICAgICAgICBleHBlY3RlZF9vdXRwdXQ6IFtdLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiBgXG5cXGBcXGBcXGB0eXBlc2NyaXB0XG5mdW5jdGlvbiBjaGVjayhhOiBzdHJpbmcpOiB2b2lkXG5cXGBcXGBcXGBcbiAgICAgICAgICBgLFxuICAgICAgICB9KSxcbiAgICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgICAgaWQ6IFwiVDAyXCIsXG4gICAgICAgICAgc2VxdWVuY2U6IDEsXG4gICAgICAgICAgZmlsZXM6IFtdLFxuICAgICAgICAgIGlucHV0czogW10sXG4gICAgICAgICAgZXhwZWN0ZWRfb3V0cHV0OiBbXCJ3aWxsLWJlLWNyZWF0ZWQudHNcIl0sXG4gICAgICAgICAgZGVzY3JpcHRpb246IGBcblxcYFxcYFxcYHR5cGVzY3JpcHRcbmZ1bmN0aW9uIGNoZWNrKGE6IG51bWJlcik6IHZvaWRcblxcYFxcYFxcYFxuICAgICAgICAgIGAsXG4gICAgICAgIH0pLFxuICAgICAgXTtcblxuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuUHJlRXhlY3V0aW9uQ2hlY2tzKHRhc2tzLCB0ZW1wRGlyKTtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc3RhdHVzLCBcImZhaWxcIik7XG5cbiAgICAgIC8vIFNob3VsZCBoYXZlIG11bHRpcGxlIHR5cGVzIG9mIGlzc3Vlc1xuICAgICAgY29uc3QgY2F0ZWdvcmllcyA9IG5ldyBTZXQocmVzdWx0LmNoZWNrcy5tYXAoKGMpID0+IGMuY2F0ZWdvcnkpKTtcbiAgICAgIGFzc2VydC5vayhjYXRlZ29yaWVzLmhhcyhcImZpbGVcIikpOyAgLy8gRnJvbSBjb25zaXN0ZW5jeSBhbmQgb3JkZXJpbmdcbiAgICAgIGFzc2VydC5vayhjYXRlZ29yaWVzLmhhcyhcInNjaGVtYVwiKSk7IC8vIEZyb20gaW50ZXJmYWNlIGNoZWNrXG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwicmVwb3J0cyBkdXJhdGlvbiBpbiBtaWxsaXNlY29uZHNcIiwgYXN5bmMgKCkgPT4ge1xuICAgIHRlbXBEaXIgPSBqb2luKHRtcGRpcigpLCBgcHJlLWV4ZWMtdGVzdC0ke0RhdGUubm93KCl9YCk7XG4gICAgbWtkaXJTeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHRhc2tzID0gW2NyZWF0ZVRhc2soeyBpZDogXCJUMDFcIiB9KV07XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5QcmVFeGVjdXRpb25DaGVja3ModGFza3MsIHRlbXBEaXIpO1xuXG4gICAgICBhc3NlcnQub2sodHlwZW9mIHJlc3VsdC5kdXJhdGlvbk1zID09PSBcIm51bWJlclwiKTtcbiAgICAgIGFzc2VydC5vayhyZXN1bHQuZHVyYXRpb25NcyA+PSAwKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJoYW5kbGVzIGVtcHR5IHRhc2sgYXJyYXlcIiwgYXN5bmMgKCkgPT4ge1xuICAgIHRlbXBEaXIgPSBqb2luKHRtcGRpcigpLCBgcHJlLWV4ZWMtdGVzdC0ke0RhdGUubm93KCl9YCk7XG4gICAgbWtkaXJTeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1blByZUV4ZWN1dGlvbkNoZWNrcyhbXSwgdGVtcERpcik7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnN0YXR1cywgXCJwYXNzXCIpO1xuICAgICAgYXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQuY2hlY2tzLCBbXSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUmVncmVzc2lvbiBUZXN0czogY2hlY2tUYXNrT3JkZXJpbmcgZmFsc2UgcG9zaXRpdmUgKCMzNjc3KSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJjaGVja1Rhc2tPcmRlcmluZyBmYWxzZSBwb3NpdGl2ZSByZWdyZXNzaW9uICgjMzY3NylcIiwgKCkgPT4ge1xuICB0ZXN0KFwidGFzay5maWxlcyBzaG91bGQgbm90IHRyaWdnZXIgb3JkZXJpbmcgdmlvbGF0aW9uIHdoZW4gZmlsZSBpcyBpbiBsYXRlciBleHBlY3RlZF9vdXRwdXRcIiwgKCkgPT4ge1xuICAgIC8vIFQwMSBoYXMgZmlsZXM6IFtcImNvbXBvbmVudC50c3hcIl0gXHUyMDE0IHRoaXMgaXMgYSBmaWxlIHRoZSB0YXNrIHdpbGwgQ1JFQVRFLFxuICAgIC8vIG5vdCByZWFkLiBJbmNsdWRpbmcgdGFzay5maWxlcyBpbiB0aGUgb3JkZXJpbmcgY2hlY2sgY2F1c2VzIGEgZmFsc2UgcG9zaXRpdmUuXG4gICAgLy8gQWZ0ZXIgZml4IChjaGVjayBvbmx5IHRhc2suaW5wdXRzKSwgdGhpcyBzaG91bGQgcmV0dXJuIDAgcmVzdWx0cy5cbiAgICBjb25zdCB0YXNrcyA9IFtcbiAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICBpZDogXCJUMDFcIixcbiAgICAgICAgc2VxdWVuY2U6IDAsXG4gICAgICAgIGZpbGVzOiBbXCJjb21wb25lbnQudHN4XCJdLFxuICAgICAgICBpbnB1dHM6IFtdLFxuICAgICAgICBleHBlY3RlZF9vdXRwdXQ6IFtdLFxuICAgICAgfSksXG4gICAgICBjcmVhdGVUYXNrKHtcbiAgICAgICAgaWQ6IFwiVDAyXCIsXG4gICAgICAgIHNlcXVlbmNlOiAxLFxuICAgICAgICBmaWxlczogW10sXG4gICAgICAgIGlucHV0czogW10sXG4gICAgICAgIGV4cGVjdGVkX291dHB1dDogW1wiY29tcG9uZW50LnRzeFwiXSxcbiAgICAgIH0pLFxuICAgIF07XG5cbiAgICBjb25zdCByZXN1bHRzID0gY2hlY2tUYXNrT3JkZXJpbmcodGFza3MsIFwiL3RtcFwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0cy5sZW5ndGgsIDAsIFwidGFzay5maWxlcyBzaG91bGQgbm90IGJlIGNoZWNrZWQgZm9yIG9yZGVyaW5nIHZpb2xhdGlvbnNcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJ0YXNrLmZpbGVzIHdpdGggbXVsdGlwbGUgZmlsZXMgc2hvdWxkIG5vdCB0cmlnZ2VyIGZhbHNlIHBvc2l0aXZlc1wiLCAoKSA9PiB7XG4gICAgLy8gVDAxIGxpc3RzIHNldmVyYWwgZmlsZXMgaXQgd2lsbCB0b3VjaC9jcmVhdGUgXHUyMDE0IG5vbmUgc2hvdWxkIHRyaWdnZXIgb3JkZXJpbmdcbiAgICAvLyB2aW9sYXRpb25zIGp1c3QgYmVjYXVzZSBUMDIgZGVjbGFyZXMgb25lIG9mIHRoZW0gYXMgZXhwZWN0ZWRfb3V0cHV0LlxuICAgIGNvbnN0IHRhc2tzID0gW1xuICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgICBzZXF1ZW5jZTogMCxcbiAgICAgICAgZmlsZXM6IFtcImEudHNcIiwgXCJiLnRzXCIsIFwiYy50c1wiXSxcbiAgICAgICAgaW5wdXRzOiBbXSxcbiAgICAgICAgZXhwZWN0ZWRfb3V0cHV0OiBbXSxcbiAgICAgIH0pLFxuICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlQwMlwiLFxuICAgICAgICBzZXF1ZW5jZTogMSxcbiAgICAgICAgZmlsZXM6IFtdLFxuICAgICAgICBpbnB1dHM6IFtdLFxuICAgICAgICBleHBlY3RlZF9vdXRwdXQ6IFtcImIudHNcIl0sXG4gICAgICB9KSxcbiAgICBdO1xuXG4gICAgY29uc3QgcmVzdWx0cyA9IGNoZWNrVGFza09yZGVyaW5nKHRhc2tzLCBcIi90bXBcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdHMubGVuZ3RoLCAwLCBcIk11bHRpcGxlIHRhc2suZmlsZXMgc2hvdWxkIG5vdCBnZW5lcmF0ZSBmYWxzZSBwb3NpdGl2ZSB2aW9sYXRpb25zXCIpO1xuICB9KTtcblxuICB0ZXN0KFwidGFzay5pbnB1dHMgU0hPVUxEIHN0aWxsIHRyaWdnZXIgb3JkZXJpbmcgdmlvbGF0aW9uXCIsICgpID0+IHtcbiAgICAvLyB0YXNrLmlucHV0cyByZXByZXNlbnRzIGZpbGVzIGEgdGFzayBnZW51aW5lbHkgbmVlZHMgdG8gUkVBRCwgc28gYSBzZXF1ZW5jZVxuICAgIC8vIHZpb2xhdGlvbiBoZXJlIGlzIGEgcmVhbCBlcnJvciBhbmQgbXVzdCBzdGlsbCBiZSBkZXRlY3RlZC5cbiAgICBjb25zdCB0YXNrcyA9IFtcbiAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICBpZDogXCJUMDFcIixcbiAgICAgICAgc2VxdWVuY2U6IDAsXG4gICAgICAgIGZpbGVzOiBbXSxcbiAgICAgICAgaW5wdXRzOiBbXCJjb25maWcuanNvblwiXSxcbiAgICAgICAgZXhwZWN0ZWRfb3V0cHV0OiBbXSxcbiAgICAgIH0pLFxuICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlQwMlwiLFxuICAgICAgICBzZXF1ZW5jZTogMSxcbiAgICAgICAgZmlsZXM6IFtdLFxuICAgICAgICBpbnB1dHM6IFtdLFxuICAgICAgICBleHBlY3RlZF9vdXRwdXQ6IFtcImNvbmZpZy5qc29uXCJdLFxuICAgICAgfSksXG4gICAgXTtcblxuICAgIGNvbnN0IHJlc3VsdHMgPSBjaGVja1Rhc2tPcmRlcmluZyh0YXNrcywgXCIvdG1wXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHRzLmxlbmd0aCwgMSwgXCJ0YXNrLmlucHV0cyBvcmRlcmluZyB2aW9sYXRpb24gbXVzdCBzdGlsbCBiZSBkZXRlY3RlZFwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0c1swXS5ibG9ja2luZywgdHJ1ZSk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdHNbMF0ubWVzc2FnZS5pbmNsdWRlcyhcIlQwMVwiKSk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdHNbMF0ubWVzc2FnZS5pbmNsdWRlcyhcIlQwMlwiKSk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdHNbMF0ubWVzc2FnZS5pbmNsdWRlcyhcInNlcXVlbmNlIHZpb2xhdGlvblwiKSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJtaXhlZCBmaWxlcyBhbmQgaW5wdXRzIFx1MjAxNCBvbmx5IGlucHV0cyB0cmlnZ2VyIG9yZGVyaW5nIHZpb2xhdGlvblwiLCAoKSA9PiB7XG4gICAgLy8gVDAxIHdpbGwgY3JlYXRlIFwiY3JlYXRlZC50c1wiIChmaWxlcykgYW5kIGFsc28gbmVlZHMgdG8gUkVBRCBcIm5lZWRlZC5qc29uXCIgKGlucHV0cykuXG4gICAgLy8gVDAyIGNyZWF0ZXMgYm90aC4gT25seSB0aGUgaW5wdXRzIGRlcGVuZGVuY3kgaXMgYSByZWFsIHZpb2xhdGlvbi5cbiAgICBjb25zdCB0YXNrcyA9IFtcbiAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICBpZDogXCJUMDFcIixcbiAgICAgICAgc2VxdWVuY2U6IDAsXG4gICAgICAgIGZpbGVzOiBbXCJjcmVhdGVkLnRzXCJdLFxuICAgICAgICBpbnB1dHM6IFtcIm5lZWRlZC5qc29uXCJdLFxuICAgICAgICBleHBlY3RlZF9vdXRwdXQ6IFtdLFxuICAgICAgfSksXG4gICAgICBjcmVhdGVUYXNrKHtcbiAgICAgICAgaWQ6IFwiVDAyXCIsXG4gICAgICAgIHNlcXVlbmNlOiAxLFxuICAgICAgICBmaWxlczogW10sXG4gICAgICAgIGlucHV0czogW10sXG4gICAgICAgIGV4cGVjdGVkX291dHB1dDogW1wiY3JlYXRlZC50c1wiLCBcIm5lZWRlZC5qc29uXCJdLFxuICAgICAgfSksXG4gICAgXTtcblxuICAgIGNvbnN0IHJlc3VsdHMgPSBjaGVja1Rhc2tPcmRlcmluZyh0YXNrcywgXCIvdG1wXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHRzLmxlbmd0aCwgMSwgXCJPbmx5IHRoZSBpbnB1dHMgZW50cnkgc2hvdWxkIHByb2R1Y2UgYSB2aW9sYXRpb24sIG5vdCBmaWxlc1wiKTtcbiAgICBhc3NlcnQub2socmVzdWx0c1swXS50YXJnZXQgPT09IFwibmVlZGVkLmpzb25cIiwgXCJWaW9sYXRpb24gdGFyZ2V0IHNob3VsZCBiZSB0aGUgaW5wdXQsIG5vdCB0aGUgZmlsZVwiKTtcbiAgfSk7XG5cbiAgdGVzdChcInRhc2suZmlsZXMgd2l0aCBub3JtYWxpemVkIHBhdGhzIHNob3VsZCBub3QgZmFsc2UtcG9zaXRpdmVcIiwgKCkgPT4ge1xuICAgIC8vIFBhdGggbm9ybWFsaXphdGlvbiAoLi9zcmMvbmV3LWZpbGUudHMgXHUyMTkyIHNyYy9uZXctZmlsZS50cykgc2hvdWxkIG5vdCBjYXVzZVxuICAgIC8vIHRhc2suZmlsZXMgdG8gbWF0Y2ggYWdhaW5zdCBleHBlY3RlZF9vdXRwdXQgYW5kIHByb2R1Y2UgYSBmYWxzZSBwb3NpdGl2ZS5cbiAgICBjb25zdCB0YXNrcyA9IFtcbiAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICBpZDogXCJUMDFcIixcbiAgICAgICAgc2VxdWVuY2U6IDAsXG4gICAgICAgIGZpbGVzOiBbXCIuL3NyYy9uZXctZmlsZS50c1wiXSxcbiAgICAgICAgaW5wdXRzOiBbXSxcbiAgICAgICAgZXhwZWN0ZWRfb3V0cHV0OiBbXSxcbiAgICAgIH0pLFxuICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlQwMlwiLFxuICAgICAgICBzZXF1ZW5jZTogMSxcbiAgICAgICAgZmlsZXM6IFtdLFxuICAgICAgICBpbnB1dHM6IFtdLFxuICAgICAgICBleHBlY3RlZF9vdXRwdXQ6IFtcInNyYy9uZXctZmlsZS50c1wiXSxcbiAgICAgIH0pLFxuICAgIF07XG5cbiAgICBjb25zdCByZXN1bHRzID0gY2hlY2tUYXNrT3JkZXJpbmcodGFza3MsIFwiL3RtcFwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0cy5sZW5ndGgsIDAsIFwiTm9ybWFsaXplZCB0YXNrLmZpbGVzIHBhdGggc2hvdWxkIG5vdCB0cmlnZ2VyIGEgZmFsc2UgcG9zaXRpdmVcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJhbm5vdGF0ZWQgaW5wdXRzIHN0aWxsIHRyaWdnZXIgb3JkZXJpbmcgdmlvbGF0aW9ucyBhZ2FpbnN0IGxhdGVyIHBsYWluIG91dHB1dHNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHRhc2tzID0gW1xuICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgICBzZXF1ZW5jZTogMCxcbiAgICAgICAgZmlsZXM6IFtdLFxuICAgICAgICBpbnB1dHM6IFtcImBsYXRlci50c2AgXHUyMDE0IG5lZWRlZCBmaXJzdFwiXSxcbiAgICAgICAgZXhwZWN0ZWRfb3V0cHV0OiBbXSxcbiAgICAgIH0pLFxuICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlQwMlwiLFxuICAgICAgICBzZXF1ZW5jZTogMSxcbiAgICAgICAgZmlsZXM6IFtdLFxuICAgICAgICBpbnB1dHM6IFtdLFxuICAgICAgICBleHBlY3RlZF9vdXRwdXQ6IFtcImxhdGVyLnRzXCJdLFxuICAgICAgfSksXG4gICAgXTtcblxuICAgIGNvbnN0IHJlc3VsdHMgPSBjaGVja1Rhc2tPcmRlcmluZyh0YXNrcywgXCIvdG1wXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHRzLmxlbmd0aCwgMSwgXCJBbm5vdGF0ZWQgaW5wdXRzIHNob3VsZCBzdGlsbCBtYXRjaCBsYXRlciBwbGFpbiBleHBlY3RlZF9vdXRwdXQgZW50cmllc1wiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0c1swXS50YXJnZXQsIFwiYGxhdGVyLnRzYCBcdTIwMTQgbmVlZGVkIGZpcnN0XCIpO1xuICAgIGFzc2VydC5vayhyZXN1bHRzWzBdLm1lc3NhZ2UuaW5jbHVkZXMoXCJzZXF1ZW5jZSB2aW9sYXRpb25cIikpO1xuICB9KTtcblxuICB0ZXN0KFwiZXhpc3Rpbmcgb24tZGlzayBmaWxlcyBkbyBub3QgdHJpZ2dlciBvcmRlcmluZyB2aW9sYXRpb25zIGp1c3QgYmVjYXVzZSBhIGxhdGVyIHRhc2sgbW9kaWZpZXMgdGhlbVwiLCAoKSA9PiB7XG4gICAgY29uc3QgdGVtcERpciA9IGpvaW4odG1wZGlyKCksIGBwcmUtZXhlYy1vcmRlcmluZy1leGlzdGluZy1maWxlLSR7RGF0ZS5ub3coKX1gKTtcbiAgICBjb25zdCBleGlzdGluZ0ZpbGUgPSBcImZyb250ZW5kL3NyYy9fX3Rlc3RzX18vUHJvY3VyZW1lbnRQYWdlMjkudGVzdC50c3hcIjtcblxuICAgIG1rZGlyU3luYyhqb2luKHRlbXBEaXIsIFwiZnJvbnRlbmRcIiwgXCJzcmNcIiwgXCJfX3Rlc3RzX19cIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbih0ZW1wRGlyLCBleGlzdGluZ0ZpbGUpLCBcIi8vIGV4aXN0aW5nIGZpbGVcIik7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgdGFza3MgPSBbXG4gICAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgICAgIHNlcXVlbmNlOiAwLFxuICAgICAgICAgIGZpbGVzOiBbXSxcbiAgICAgICAgICBpbnB1dHM6IFtcImBmcm9udGVuZC9zcmMvX190ZXN0c19fL1Byb2N1cmVtZW50UGFnZTI5LnRlc3QudHN4YCBcdTIwMTQgY29udGFpbnMgbWF0Y2hNZWRpYSBzdHViIHRvIHJlbW92ZVwiXSxcbiAgICAgICAgICBleHBlY3RlZF9vdXRwdXQ6IFtdLFxuICAgICAgICB9KSxcbiAgICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgICAgaWQ6IFwiVDAzXCIsXG4gICAgICAgICAgc2VxdWVuY2U6IDIsXG4gICAgICAgICAgZmlsZXM6IFtdLFxuICAgICAgICAgIGlucHV0czogW10sXG4gICAgICAgICAgZXhwZWN0ZWRfb3V0cHV0OiBbXCJmcm9udGVuZC9zcmMvX190ZXN0c19fL1Byb2N1cmVtZW50UGFnZTI5LnRlc3QudHN4XCJdLFxuICAgICAgICB9KSxcbiAgICAgIF07XG5cbiAgICAgIGNvbnN0IHJlc3VsdHMgPSBjaGVja1Rhc2tPcmRlcmluZyh0YXNrcywgdGVtcERpcik7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0cy5sZW5ndGgsIDAsIFwiUHJlLWV4aXN0aW5nIGZpbGVzIHNob3VsZCBub3QgYmUgdHJlYXRlZCBhcyBjcmVhdGVkIGJ5IGxhdGVyIHRhc2tzXCIpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcImdsb2ItbGlrZSBpbnB1dHMgZG8gbm90IHRyaWdnZXIgb3JkZXJpbmcgdmlvbGF0aW9ucyBhZ2FpbnN0IGxhdGVyIGNvbmNyZXRlIG91dHB1dHNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHRhc2tzID0gW1xuICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgICBzZXF1ZW5jZTogMCxcbiAgICAgICAgZmlsZXM6IFtdLFxuICAgICAgICBpbnB1dHM6IFtcIkFydGlmYWN0cy9wcnVuZWRfbmV0d29ya3MvY2VsbF9saW5lPSovXCJdLFxuICAgICAgICBleHBlY3RlZF9vdXRwdXQ6IFtdLFxuICAgICAgfSksXG4gICAgICBjcmVhdGVUYXNrKHtcbiAgICAgICAgaWQ6IFwiVDAyXCIsXG4gICAgICAgIHNlcXVlbmNlOiAxLFxuICAgICAgICBmaWxlczogW10sXG4gICAgICAgIGlucHV0czogW10sXG4gICAgICAgIGV4cGVjdGVkX291dHB1dDogW1wiQXJ0aWZhY3RzL3BydW5lZF9uZXR3b3Jrcy9jZWxsX2xpbmU9SFQtMjkvXCJdLFxuICAgICAgfSksXG4gICAgXTtcblxuICAgIGNvbnN0IHJlc3VsdHMgPSBjaGVja1Rhc2tPcmRlcmluZyh0YXNrcywgXCIvdG1wXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHRzLmxlbmd0aCwgMCwgXCJHbG9iLXBhdHRlcm4gaW5wdXRzIHNob3VsZCBub3QgYmUgdHJlYXRlZCBhcyBsaXRlcmFsIHJlYWQtYmVmb3JlLWNyZWF0ZSBkZXBlbmRlbmNpZXNcIik7XG4gIH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBjaGVja0ZpbGVQYXRoQ29uc2lzdGVuY3kgYWRkaXRpb25hbCBlZGdlIGNhc2VzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcImNoZWNrRmlsZVBhdGhDb25zaXN0ZW5jeSBhZGRpdGlvbmFsIGVkZ2UgY2FzZXNcIiwgKCkgPT4ge1xuICB0ZXN0KFwiYW5ub3RhdGVkIGlucHV0cyBtYXRjaCBmaWxlcyB0aGF0IGFscmVhZHkgZXhpc3Qgb24gZGlza1wiLCAoKSA9PiB7XG4gICAgY29uc3QgdGVtcERpciA9IGpvaW4odG1wZGlyKCksIGBwcmUtZXhlYy10ZXN0LWFubm90YXRlZC1pbnB1dC0ke0RhdGUubm93KCl9YCk7XG4gICAgbWtkaXJTeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbih0ZW1wRGlyLCBcImV4aXN0aW5nLnRzXCIpLCBcIi8vIGNvbnRlbnRcIik7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgdGFza3MgPSBbXG4gICAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgICAgIGZpbGVzOiBbXSxcbiAgICAgICAgICBpbnB1dHM6IFtcImBleGlzdGluZy50c2AgXHUyMDE0IGZpbGUgYWxyZWFkeSBvbiBkaXNrXCJdLFxuICAgICAgICAgIGV4cGVjdGVkX291dHB1dDogW10sXG4gICAgICAgIH0pLFxuICAgICAgXTtcblxuICAgICAgY29uc3QgcmVzdWx0cyA9IGNoZWNrRmlsZVBhdGhDb25zaXN0ZW5jeSh0YXNrcywgdGVtcERpcik7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0cy5sZW5ndGgsIDAsIFwiQW5ub3RhdGVkIGlucHV0cyBzaG91bGQgcmVzb2x2ZSB0byB0aGUgb24tZGlzayBmaWxlIHBhdGhcIik7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwicGxhaW4gaW5wdXRzIG1hdGNoIHByaW9yIGFubm90YXRlZCBleHBlY3RlZCBvdXRwdXRzXCIsICgpID0+IHtcbiAgICBjb25zdCB0YXNrcyA9IFtcbiAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICBpZDogXCJUMDFcIixcbiAgICAgICAgZmlsZXM6IFtdLFxuICAgICAgICBpbnB1dHM6IFtdLFxuICAgICAgICBleHBlY3RlZF9vdXRwdXQ6IFtcImBnZW5lcmF0ZWQudHNgIFx1MjAxNCBjcmVhdGVkIGVhcmxpZXJcIl0sXG4gICAgICB9KSxcbiAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICBpZDogXCJUMDJcIixcbiAgICAgICAgZmlsZXM6IFtdLFxuICAgICAgICBpbnB1dHM6IFtcImdlbmVyYXRlZC50c1wiXSxcbiAgICAgICAgZXhwZWN0ZWRfb3V0cHV0OiBbXSxcbiAgICAgIH0pLFxuICAgIF07XG5cbiAgICBjb25zdCByZXN1bHRzID0gY2hlY2tGaWxlUGF0aENvbnNpc3RlbmN5KHRhc2tzLCBcIi90bXBcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdHMubGVuZ3RoLCAwLCBcIlByaW9yIGFubm90YXRlZCBleHBlY3RlZF9vdXRwdXQgZW50cmllcyBzaG91bGQgc2F0aXNmeSBsYXRlciBwbGFpbiBpbnB1dHNcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJpbnB1dHMgcmVmZXJlbmNpbmcgZ2xvYi1saWtlIHBhdHRlcm5zIGFyZSBza2lwcGVkIGJ5IHBhdGggY29uc2lzdGVuY3kgY2hlY2tzXCIsICgpID0+IHtcbiAgICBjb25zdCB0YXNrcyA9IFtcbiAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICBpZDogXCJUMDFcIixcbiAgICAgICAgZmlsZXM6IFtdLFxuICAgICAgICBpbnB1dHM6IFtcInNyYy8qKi8qLnRzXCJdLFxuICAgICAgICBleHBlY3RlZF9vdXRwdXQ6IFtdLFxuICAgICAgfSksXG4gICAgXTtcblxuICAgIC8vIFNob3VsZCBub3QgdGhyb3dcbiAgICBsZXQgcmVzdWx0czogUmV0dXJuVHlwZTx0eXBlb2YgY2hlY2tGaWxlUGF0aENvbnNpc3RlbmN5PjtcbiAgICBhc3NlcnQuZG9lc05vdFRocm93KCgpID0+IHtcbiAgICAgIHJlc3VsdHMgPSBjaGVja0ZpbGVQYXRoQ29uc2lzdGVuY3kodGFza3MsIFwiL3RtcFwiKTtcbiAgICB9KTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0cyEubGVuZ3RoLCAwLCBcIkdsb2ItcGF0dGVybiBpbnB1dHMgc2hvdWxkIG5vdCBwcm9kdWNlIGZhbHNlIGJsb2NraW5nIGZhaWx1cmVzXCIpO1xuICB9KTtcblxuICB0ZXN0KFwibXVsdGktd29yZCBwcm9zZSBpbnB1dHMgYXJlIGlnbm9yZWQgYnkgcGF0aCBjb25zaXN0ZW5jeSBjaGVja3NcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHRhc2tzID0gW1xuICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgICBmaWxlczogW10sXG4gICAgICAgIGlucHV0czogW1xuICAgICAgICAgIFwiQ3VycmVudCBXSVpBUkRfUFJPRFVDVFMgZW51bVwiLFxuICAgICAgICAgIFwiRXhpc3RpbmcgdGVzdCBwYXR0ZXJucyBpbiB3aXphcmQudGVzdC50c1wiLFxuICAgICAgICBdLFxuICAgICAgICBleHBlY3RlZF9vdXRwdXQ6IFtdLFxuICAgICAgfSksXG4gICAgXTtcblxuICAgIGNvbnN0IHJlc3VsdHMgPSBjaGVja0ZpbGVQYXRoQ29uc2lzdGVuY3kodGFza3MsIFwiL3RtcFwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0cy5sZW5ndGgsIDAsIFwiUHJvc2UgcGxhbm5pbmcgaGludHMgc2hvdWxkIG5vdCBiZSB0cmVhdGVkIGFzIG1pc3NpbmcgZmlsZSBwYXRoc1wiKTtcbiAgfSk7XG5cbiAgdGVzdChcImVtcHR5IGlucHV0cyBhcnJheSBwcm9kdWNlcyBubyByZXN1bHRzXCIsICgpID0+IHtcbiAgICAvLyBBIHRhc2sgd2l0aCBubyBpbnB1dHMgYW5kIG9ubHkgZmlsZXMgc2hvdWxkIHByb2R1Y2UgemVybyByZXN1bHRzIGZyb21cbiAgICAvLyBjb25zaXN0ZW5jeSBjaGVjayBcdTIwMTQgZmlsZXMgYXJlIG5vdCBjaGVja2VkICgjMzYyNikuXG4gICAgY29uc3QgdGFza3MgPSBbXG4gICAgICBjcmVhdGVUYXNrKHtcbiAgICAgICAgaWQ6IFwiVDAxXCIsXG4gICAgICAgIGZpbGVzOiBbXCJhbnl0aGluZy50c1wiXSxcbiAgICAgICAgaW5wdXRzOiBbXSxcbiAgICAgICAgZXhwZWN0ZWRfb3V0cHV0OiBbXSxcbiAgICAgIH0pLFxuICAgIF07XG5cbiAgICBjb25zdCByZXN1bHRzID0gY2hlY2tGaWxlUGF0aENvbnNpc3RlbmN5KHRhc2tzLCBcIi90bXBcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdHMubGVuZ3RoLCAwLCBcIkVtcHR5IGlucHV0cyBzaG91bGQgcHJvZHVjZSBubyBjb25zaXN0ZW5jeSBjaGVjayByZXN1bHRzXCIpO1xuICB9KTtcblxuICB0ZXN0KFwiaW5wdXRzIHdpdGggYWJzb2x1dGUgcGF0aHMgYXJlIGNoZWNrZWQgY29ycmVjdGx5XCIsICgpID0+IHtcbiAgICAvLyBBbiBhYnNvbHV0ZSBwYXRoIGluIGlucHV0cyBzaG91bGQgcmVzb2x2ZSB0byBpdHNlbGYgYW5kIHBhc3Mgd2hlbiB0aGUgZmlsZSBleGlzdHMuXG4gICAgY29uc3QgdGVtcERpciA9IGpvaW4odG1wZGlyKCksIGBwcmUtZXhlYy10ZXN0LWFicy0ke0RhdGUubm93KCl9YCk7XG4gICAgbWtkaXJTeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIGNvbnN0IGFic0ZpbGVQYXRoID0gam9pbih0ZW1wRGlyLCBcInJlYWwtZmlsZS50c1wiKTtcbiAgICB3cml0ZUZpbGVTeW5jKGFic0ZpbGVQYXRoLCBcIi8vIGNvbnRlbnRcIik7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgdGFza3MgPSBbXG4gICAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgICAgIGZpbGVzOiBbXSxcbiAgICAgICAgICBpbnB1dHM6IFthYnNGaWxlUGF0aF0sXG4gICAgICAgICAgZXhwZWN0ZWRfb3V0cHV0OiBbXSxcbiAgICAgICAgfSksXG4gICAgICBdO1xuXG4gICAgICBjb25zdCByZXN1bHRzID0gY2hlY2tGaWxlUGF0aENvbnNpc3RlbmN5KHRhc2tzLCB0ZW1wRGlyKTtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHRzLmxlbmd0aCwgMCwgXCJBYnNvbHV0ZSBwYXRoIHRvIGFuIGV4aXN0aW5nIGZpbGUgc2hvdWxkIHBhc3MgY29uc2lzdGVuY3kgY2hlY2tcIik7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICAvLyBSZWdyZXNzaW9uIHRlc3RzIGZvciBpc3N1ZSAjNDQyMVxuICB0ZXN0KFwiYmFja3RpY2tlZCBwYXRoIHdpdGggdHJhaWxpbmcgcHJvc2UgYW5kIHBhcmVucyByZXNvbHZlcyB0byB0aGUgcGF0aFwiLCAoKSA9PiB7XG4gICAgY29uc3QgdGVtcERpciA9IGpvaW4odG1wZGlyKCksIGBwcmUtZXhlYy10ZXN0LTQ0MjEtY2FzZTEtJHtEYXRlLm5vdygpfWApO1xuICAgIGNvbnN0IGRpclBhdGggPSBqb2luKHRlbXBEaXIsIFwiYXNzZXRzXCIpO1xuICAgIG1rZGlyU3luYyhkaXJQYXRoLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCB0YXNrcyA9IFtcbiAgICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgICAgaWQ6IFwiVDAxXCIsXG4gICAgICAgICAgaW5wdXRzOiBbYFxcYCR7ZGlyUGF0aH0vXFxgIGRpcmVjdG9yeSBsaXN0aW5nIChzaG93cyB0aGUgaXRlbXMgdGhhdCB3aWxsIG1hdGNoIGR1cmluZyB0aGUgcnVuKWBdLFxuICAgICAgICB9KSxcbiAgICAgIF07XG5cbiAgICAgIGNvbnN0IHJlc3VsdHMgPSBjaGVja0ZpbGVQYXRoQ29uc2lzdGVuY3kodGFza3MsIHRlbXBEaXIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHJlc3VsdHMubGVuZ3RoLCAwLCBcIkJhY2t0aWNrZWQgZGlyIHBhdGggYW5ub3RhdGVkIHdpdGggcHJvc2UgKyBwYXJlbnMgc2hvdWxkIGJlIHJlY29nbml6ZWRcIik7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwiYmFja3RpY2tlZCBVUkwgd2l0aCBwYXJlbiBhbm5vdGF0aW9uIGlzIHNraXBwZWQgKG5vdCBhIGZpbGVzeXN0ZW0gcGF0aClcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHRhc2tzID0gW1xuICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgICBpbnB1dHM6IFtcImBodHRwczovL2V4YW1wbGUuY29tYCAobGl2ZSBIVFRQIHRhcmdldClcIl0sXG4gICAgICB9KSxcbiAgICBdO1xuXG4gICAgY29uc3QgcmVzdWx0cyA9IGNoZWNrRmlsZVBhdGhDb25zaXN0ZW5jeSh0YXNrcywgXCIvdG1wXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHRzLmxlbmd0aCwgMCwgXCJCYWNrdGlja2VkIFVSTCBzaG91bGQgbm90IGJlIHZhbGlkYXRlZCBhcyBhIGZpbGVzeXN0ZW0gcGF0aFwiKTtcbiAgfSk7XG5cbiAgdGVzdChcIlVSTCBlbWJlZGRlZCBtaWQtc2VudGVuY2Ugd2l0aCBwcmVmaXggcHJvc2UgaXMgc2tpcHBlZFwiLCAoKSA9PiB7XG4gICAgY29uc3QgdGFza3MgPSBbXG4gICAgICBjcmVhdGVUYXNrKHtcbiAgICAgICAgaWQ6IFwiVDAxXCIsXG4gICAgICAgIGlucHV0czogW1wiTGl2ZSBgaHR0cHM6Ly9leGFtcGxlLmNvbS9kb2NzYCBwYWdlcyAocmV2aWV3ZXIgV2ViRmV0Y2hlcyB0aGVzZSlcIl0sXG4gICAgICB9KSxcbiAgICBdO1xuXG4gICAgY29uc3QgcmVzdWx0cyA9IGNoZWNrRmlsZVBhdGhDb25zaXN0ZW5jeSh0YXNrcywgXCIvdG1wXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHRzLmxlbmd0aCwgMCwgXCJVUkxzIGNpdGVkIG1pZC1zZW50ZW5jZSBzaG91bGQgbm90IGJlIHZhbGlkYXRlZCBhcyBmaWxlc3lzdGVtIHBhdGhzXCIpO1xuICB9KTtcblxuICB0ZXN0KFwiYmFja3RpY2tlZCBwYXRoIGNpdGVkIG1pZC1zZW50ZW5jZSByZXNvbHZlcyB0byB0aGUgcGF0aFwiLCAoKSA9PiB7XG4gICAgY29uc3QgdGVtcERpciA9IGpvaW4odG1wZGlyKCksIGBwcmUtZXhlYy10ZXN0LTQ0MjEtY2FzZTQtJHtEYXRlLm5vdygpfWApO1xuICAgIG1rZGlyU3luYyhqb2luKHRlbXBEaXIsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHRlbXBEaXIsIFwiLmdzZC9SRVFVSVJFTUVOVFMubWRcIiksIFwiIyBSZXF1aXJlbWVudHNcIik7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgdGFza3MgPSBbXG4gICAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgICAgIGlucHV0czogW1wiUjAxNCB2ZXJiYXRpbSB0ZXh0IGZyb20gYC5nc2QvUkVRVUlSRU1FTlRTLm1kYCAodGhlIG93bmVkIHJlcXVpcmVtZW50IHN0YXRlbWVudClcIl0sXG4gICAgICAgIH0pLFxuICAgICAgXTtcblxuICAgICAgY29uc3QgcmVzdWx0cyA9IGNoZWNrRmlsZVBhdGhDb25zaXN0ZW5jeSh0YXNrcywgdGVtcERpcik7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0cy5sZW5ndGgsIDAsIFwiQmFja3RpY2tlZCBwYXRoIGNpdGVkIG1pZC1zZW50ZW5jZSBzaG91bGQgYmUgcmVjb2duaXplZFwiKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJtdWx0aS1iYWNrdGljayBpbnB1dCBwaWNrcyB0aGUgcGF0aC1saWtlIHRva2VuIG92ZXIgbm9uLXBhdGggdG9rZW5zXCIsICgpID0+IHtcbiAgICBjb25zdCB0ZW1wRGlyID0gam9pbih0bXBkaXIoKSwgYHByZS1leGVjLXRlc3QtNDQyMS1tdWx0aS0ke0RhdGUubm93KCl9YCk7XG4gICAgbWtkaXJTeW5jKGpvaW4odGVtcERpciwgXCJzcmNcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbih0ZW1wRGlyLCBcInNyYy9hLnRzXCIpLCBcIi8vIGNvbnRlbnRcIik7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgdGFza3MgPSBbXG4gICAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgICAgIGlucHV0czogW1wiYG5vdGVgIHVzZSBgc3JjL2EudHNgIGZvciBlZGl0c1wiXSxcbiAgICAgICAgfSksXG4gICAgICBdO1xuXG4gICAgICBjb25zdCByZXN1bHRzID0gY2hlY2tGaWxlUGF0aENvbnNpc3RlbmN5KHRhc2tzLCB0ZW1wRGlyKTtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHRzLmxlbmd0aCwgMCwgXCJTaG91bGQgZXh0cmFjdCBzcmMvYS50cywgbm90IHRoZSBsZWFkaW5nIGBub3RlYCB0b2tlblwiKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJtdWx0aS1iYWNrdGljayBpbnB1dCB3aXRoIGNvbW1hbmQtbGlrZSBsZWFkaW5nIHRva2VuIHBpY2tzIHRoZSBwYXRoXCIsICgpID0+IHtcbiAgICBjb25zdCB0ZW1wRGlyID0gam9pbih0bXBkaXIoKSwgYHByZS1leGVjLXRlc3QtNDQyMS1jbWQtJHtEYXRlLm5vdygpfWApO1xuICAgIG1rZGlyU3luYyhqb2luKHRlbXBEaXIsIFwic3JjXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4odGVtcERpciwgXCJzcmMvYS50c1wiKSwgXCIvLyBjb250ZW50XCIpO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHRhc2tzID0gW1xuICAgICAgICBjcmVhdGVUYXNrKHtcbiAgICAgICAgICBpZDogXCJUMDFcIixcbiAgICAgICAgICBpbnB1dHM6IFtcIlJ1biBgbnBtIHRlc3RgIGFnYWluc3QgYHNyYy9hLnRzYFwiXSxcbiAgICAgICAgfSksXG4gICAgICBdO1xuXG4gICAgICBjb25zdCByZXN1bHRzID0gY2hlY2tGaWxlUGF0aENvbnNpc3RlbmN5KHRhc2tzLCB0ZW1wRGlyKTtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHRzLmxlbmd0aCwgMCwgXCJTaG91bGQgZXh0cmFjdCBzcmMvYS50cywgbm90IHRoZSBgbnBtIHRlc3RgIGNvbW1hbmQgdG9rZW5cIik7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUHJlRXhlY3V0aW9uUmVzdWx0IFR5cGUgVGVzdHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiUHJlRXhlY3V0aW9uUmVzdWx0IHR5cGVcIiwgKCkgPT4ge1xuICB0ZXN0KFwic3RhdHVzIGlzIG9uZSBvZiBwYXNzLCB3YXJuLCBmYWlsXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB0ZW1wRGlyID0gam9pbih0bXBkaXIoKSwgYHByZS1leGVjLXRlc3QtJHtEYXRlLm5vdygpfWApO1xuICAgIG1rZGlyU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCB0YXNrcyA9IFtjcmVhdGVUYXNrKHsgaWQ6IFwiVDAxXCIgfSldO1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuUHJlRXhlY3V0aW9uQ2hlY2tzKHRhc2tzLCB0ZW1wRGlyKTtcblxuICAgICAgYXNzZXJ0Lm9rKFtcInBhc3NcIiwgXCJ3YXJuXCIsIFwiZmFpbFwiXS5pbmNsdWRlcyhyZXN1bHQuc3RhdHVzKSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwiY2hlY2tzIGFycmF5IG1hdGNoZXMgUHJlRXhlY3V0aW9uQ2hlY2tKU09OIHNjaGVtYVwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgdGVtcERpciA9IGpvaW4odG1wZGlyKCksIGBwcmUtZXhlYy10ZXN0LSR7RGF0ZS5ub3coKX1gKTtcbiAgICBta2RpclN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgdGFza3MgPSBbXG4gICAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgICAgIGZpbGVzOiBbXCJtaXNzaW5nLnRzXCJdLFxuICAgICAgICB9KSxcbiAgICAgIF07XG5cbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1blByZUV4ZWN1dGlvbkNoZWNrcyh0YXNrcywgdGVtcERpcik7XG5cbiAgICAgIGZvciAoY29uc3QgY2hlY2sgb2YgcmVzdWx0LmNoZWNrcykge1xuICAgICAgICBhc3NlcnQub2soW1wicGFja2FnZVwiLCBcImZpbGVcIiwgXCJ0b29sXCIsIFwiZW5kcG9pbnRcIiwgXCJzY2hlbWFcIl0uaW5jbHVkZXMoY2hlY2suY2F0ZWdvcnkpKTtcbiAgICAgICAgYXNzZXJ0Lm9rKHR5cGVvZiBjaGVjay50YXJnZXQgPT09IFwic3RyaW5nXCIpO1xuICAgICAgICBhc3NlcnQub2sodHlwZW9mIGNoZWNrLnBhc3NlZCA9PT0gXCJib29sZWFuXCIpO1xuICAgICAgICBhc3NlcnQub2sodHlwZW9mIGNoZWNrLm1lc3NhZ2UgPT09IFwic3RyaW5nXCIpO1xuICAgICAgICBpZiAoY2hlY2suYmxvY2tpbmcgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIGFzc2VydC5vayh0eXBlb2YgY2hlY2suYmxvY2tpbmcgPT09IFwiYm9vbGVhblwiKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFJlZ3Jlc3Npb24gVGVzdHM6IGRpcmVjdG9yeSBpbnB1dHMgYW5kIHRpbGRlIHBhdGhzICgjNDQ0NikgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwibm9ybWFsaXplRmlsZVBhdGggdGlsZGUgZXhwYW5zaW9uICgjNDQ0NilcIiwgKCkgPT4ge1xuICB0ZXN0KFwiZXhwYW5kcyBzdGFuZGFsb25lIH4gdG8gaG9tZWRpclwiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKG5vcm1hbGl6ZUZpbGVQYXRoKFwiflwiKSwgaG9tZWRpcigpKTtcbiAgfSk7XG5cbiAgdGVzdChcImV4cGFuZHMgfi8gcHJlZml4ZWQgcGF0aHMgdG8gaG9tZWRpclwiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgbm9ybWFsaXplRmlsZVBhdGgoXCJ+Ly5nc2QvYWdlbnQvZXh0ZW5zaW9ucy9nc2QvbmF0aXZlLWdpdC1icmlkZ2UuanNcIiksXG4gICAgICBqb2luKGhvbWVkaXIoKSwgXCIuZ3NkL2FnZW50L2V4dGVuc2lvbnMvZ3NkL25hdGl2ZS1naXQtYnJpZGdlLmpzXCIpLFxuICAgICk7XG4gIH0pO1xufSk7XG5cbmRlc2NyaWJlKFwiY2hlY2tGaWxlUGF0aENvbnNpc3RlbmN5IGRpcmVjdG9yeSBpbnB1dHMgKCM0NDQ2KVwiLCAoKSA9PiB7XG4gIHRlc3QoXCJkaXJlY3RvcnkgaW5wdXQgaXMgc2F0aXNmaWVkIGJ5IHByaW9yIHRhc2sncyBvdXRwdXQgdW5kZXIgaXRcIiwgKHQpID0+IHtcbiAgICBjb25zdCB0ZW1wRGlyID0gam9pbih0bXBkaXIoKSwgYHByZS1leGVjLWRpci1wcmlvci0ke0RhdGUubm93KCl9YCk7XG4gICAgbWtkaXJTeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG5cbiAgICBjb25zdCB0YXNrcyA9IFtcbiAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICBpZDogXCJUMDFcIixcbiAgICAgICAgc2VxdWVuY2U6IDAsXG4gICAgICAgIGlucHV0czogW10sXG4gICAgICAgIGV4cGVjdGVkX291dHB1dDogW1wiYXJ0aWZhY3RzL00wMDktUzAzL3N1bW1hcnkuanNvblwiXSxcbiAgICAgIH0pLFxuICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlQwMlwiLFxuICAgICAgICBzZXF1ZW5jZTogMSxcbiAgICAgICAgaW5wdXRzOiBbXCJhcnRpZmFjdHMvTTAwOS1TMDMvXCJdLFxuICAgICAgICBleHBlY3RlZF9vdXRwdXQ6IFtdLFxuICAgICAgfSksXG4gICAgXTtcblxuICAgIGNvbnN0IHJlc3VsdHMgPSBjaGVja0ZpbGVQYXRoQ29uc2lzdGVuY3kodGFza3MsIHRlbXBEaXIpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwocmVzdWx0cywgW10sIFwiRGlyZWN0b3J5IGlucHV0IHdpdGggcHJpb3Igb3V0cHV0IGJlbmVhdGggaXQgc2hvdWxkIG5vdCBiZSBibG9ja2luZ1wiKTtcbiAgfSk7XG5cbiAgdGVzdChcImRpcmVjdG9yeSBpbnB1dCBpcyBzYXRpc2ZpZWQgYnkgc2FtZSB0YXNrJ3Mgb3V0cHV0IHVuZGVyIGl0XCIsICh0KSA9PiB7XG4gICAgY29uc3QgdGVtcERpciA9IGpvaW4odG1wZGlyKCksIGBwcmUtZXhlYy1kaXItc2FtZS0ke0RhdGUubm93KCl9YCk7XG4gICAgbWtkaXJTeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG5cbiAgICBjb25zdCB0YXNrcyA9IFtcbiAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICBpZDogXCJUMDZcIixcbiAgICAgICAgc2VxdWVuY2U6IDAsXG4gICAgICAgIGlucHV0czogW1wiYXJ0aWZhY3RzL00wMDktUzAzL1wiXSxcbiAgICAgICAgZXhwZWN0ZWRfb3V0cHV0OiBbXG4gICAgICAgICAgXCJhcnRpZmFjdHMvTTAwOS1TMDMvc3VtbWFyeS5qc29uXCIsXG4gICAgICAgICAgXCJhcnRpZmFjdHMvTTAwOS1TMDMvVkVSSUZJQ0FUSU9OLm1kXCIsXG4gICAgICAgIF0sXG4gICAgICB9KSxcbiAgICBdO1xuXG4gICAgY29uc3QgcmVzdWx0cyA9IGNoZWNrRmlsZVBhdGhDb25zaXN0ZW5jeSh0YXNrcywgdGVtcERpcik7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICAgIHJlc3VsdHMsXG4gICAgICBbXSxcbiAgICAgIFwiRGlyZWN0b3J5IGlucHV0IHdob3NlIGNoaWxkcmVuIGFyZSBwcm9kdWNlZCBieSB0aGUgc2FtZSB0YXNrIHNob3VsZCBub3QgYmUgYmxvY2tpbmcgKE0wMDktUzAzL1QwNiBjYXNlKVwiLFxuICAgICk7XG4gIH0pO1xuXG4gIHRlc3QoXCJkaXJlY3RvcnkgaW5wdXQgc3RpbGwgZmFpbHMgd2hlbiBub3RoaW5nIGNyZWF0ZXMgYW55dGhpbmcgdW5kZXIgaXRcIiwgKHQpID0+IHtcbiAgICBjb25zdCB0ZW1wRGlyID0gam9pbih0bXBkaXIoKSwgYHByZS1leGVjLWRpci1taXNzaW5nLSR7RGF0ZS5ub3coKX1gKTtcbiAgICBta2RpclN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgdC5hZnRlcigoKSA9PiBybVN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcblxuICAgIGNvbnN0IHRhc2tzID0gW1xuICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgICBpbnB1dHM6IFtcImFydGlmYWN0cy9taXNzaW5nL1wiXSxcbiAgICAgICAgZXhwZWN0ZWRfb3V0cHV0OiBbXSxcbiAgICAgIH0pLFxuICAgIF07XG5cbiAgICBjb25zdCByZXN1bHRzID0gY2hlY2tGaWxlUGF0aENvbnNpc3RlbmN5KHRhc2tzLCB0ZW1wRGlyKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0cy5sZW5ndGgsIDEsIFwiVW5rbm93biBkaXJlY3RvcnkgaW5wdXQgbXVzdCBzdGlsbCBiZSByZXBvcnRlZFwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0c1swXS5ibG9ja2luZywgdHJ1ZSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJydW50aW1lIGRpcmVjdG9yeSBhbm5vdGF0aW9uIGlzIHNraXBwZWQgYXMgYSBwcmUtZXhlY3V0aW9uIGZpbGUgZGVwZW5kZW5jeVwiLCAodCkgPT4ge1xuICAgIGNvbnN0IHRlbXBEaXIgPSBqb2luKHRtcGRpcigpLCBgcHJlLWV4ZWMtZGlyLXJ1bnRpbWUtJHtEYXRlLm5vdygpfWApO1xuICAgIG1rZGlyU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB0LmFmdGVyKCgpID0+IHJtU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuXG4gICAgY29uc3QgdGFza3MgPSBbXG4gICAgICBjcmVhdGVUYXNrKHtcbiAgICAgICAgaWQ6IFwiVDAyXCIsXG4gICAgICAgIGlucHV0czogW1wiZW50cmllcy8gZGlyZWN0b3J5IChydW50aW1lKVwiXSxcbiAgICAgICAgZXhwZWN0ZWRfb3V0cHV0OiBbXCJzcmMvY29tbWFuZHMvZGVsZXRlLnRzXCIsIFwic3JjL2luZGV4LnRzXCJdLFxuICAgICAgfSksXG4gICAgXTtcblxuICAgIGNvbnN0IHJlc3VsdHMgPSBjaGVja0ZpbGVQYXRoQ29uc2lzdGVuY3kodGFza3MsIHRlbXBEaXIpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwoXG4gICAgICByZXN1bHRzLFxuICAgICAgW10sXG4gICAgICBcIlJ1bnRpbWUtb25seSBkaXJlY3RvcnkgaW5wdXRzIGFyZSBjcmVhdGVkIGR1cmluZyBjb21tYW5kIGV4ZWN1dGlvbiwgbm90IHJlcXVpcmVkIGJlZm9yZSB0aGUgdGFzayBzdGFydHNcIixcbiAgICApO1xuICB9KTtcblxuICB0ZXN0KFwidGlsZGUtcHJlZml4ZWQgaW5wdXQgaXMgbWF0Y2hlZCBhZ2FpbnN0ICRIT01FLCBub3QgdGhlIHByb2plY3QgYmFzZVBhdGhcIiwgKHQpID0+IHtcbiAgICBjb25zdCBmYWtlSG9tZSA9IGpvaW4odG1wZGlyKCksIGBwcmUtZXhlYy10aWxkZS1ob21lLSR7RGF0ZS5ub3coKX1gKTtcbiAgICBjb25zdCBwcm9qZWN0RGlyID0gam9pbih0bXBkaXIoKSwgYHByZS1leGVjLXRpbGRlLXByb2otJHtEYXRlLm5vdygpfWApO1xuICAgIG1rZGlyU3luYyhqb2luKGZha2VIb21lLCBcIi5nc2RcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihmYWtlSG9tZSwgXCIuZ3NkL3Rvb2wuanNcIiksIFwiLy8gcHJlc2VudFwiKTtcbiAgICBta2RpclN5bmMocHJvamVjdERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgICBjb25zdCBvcmlnaW5hbEhvbWUgPSBwcm9jZXNzLmVudi5IT01FO1xuICAgIGNvbnN0IG9yaWdpbmFsVXNlclByb2ZpbGUgPSBwcm9jZXNzLmVudi5VU0VSUFJPRklMRTtcbiAgICBwcm9jZXNzLmVudi5IT01FID0gZmFrZUhvbWU7XG4gICAgcHJvY2Vzcy5lbnYuVVNFUlBST0ZJTEUgPSBmYWtlSG9tZTtcblxuICAgIHQuYWZ0ZXIoKCkgPT4ge1xuICAgICAgaWYgKG9yaWdpbmFsSG9tZSA9PT0gdW5kZWZpbmVkKSBkZWxldGUgcHJvY2Vzcy5lbnYuSE9NRTtcbiAgICAgIGVsc2UgcHJvY2Vzcy5lbnYuSE9NRSA9IG9yaWdpbmFsSG9tZTtcbiAgICAgIGlmIChvcmlnaW5hbFVzZXJQcm9maWxlID09PSB1bmRlZmluZWQpIGRlbGV0ZSBwcm9jZXNzLmVudi5VU0VSUFJPRklMRTtcbiAgICAgIGVsc2UgcHJvY2Vzcy5lbnYuVVNFUlBST0ZJTEUgPSBvcmlnaW5hbFVzZXJQcm9maWxlO1xuICAgICAgcm1TeW5jKGZha2VIb21lLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgICBybVN5bmMocHJvamVjdERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH0pO1xuXG4gICAgY29uc3QgdGFza3MgPSBbXG4gICAgICBjcmVhdGVUYXNrKHtcbiAgICAgICAgaWQ6IFwiVDAxXCIsXG4gICAgICAgIGlucHV0czogW1wifi8uZ3NkL3Rvb2wuanNcIl0sXG4gICAgICAgIGV4cGVjdGVkX291dHB1dDogW10sXG4gICAgICB9KSxcbiAgICBdO1xuXG4gICAgY29uc3QgcmVzdWx0cyA9IGNoZWNrRmlsZVBhdGhDb25zaXN0ZW5jeSh0YXNrcywgcHJvamVjdERpcik7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChyZXN1bHRzLCBbXSwgXCJ+Ly1wcmVmaXhlZCBpbnB1dCBzaG91bGQgcmVzb2x2ZSBhZ2FpbnN0ICRIT01FIGFuZCBwYXNzIHdoZW4gcHJlc2VudFwiKTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoXCJjaGVja1Rhc2tPcmRlcmluZyBkaXJlY3RvcnkgaW5wdXRzICgjNDQ0NilcIiwgKCkgPT4ge1xuICB0ZXN0KFwiZGlyZWN0b3J5IGlucHV0IHdpdGggYSBzYW1lLXRhc2sgb3V0cHV0IHVuZGVyIGl0IGRvZXMgbm90IHByb2R1Y2UgYSBzZXF1ZW5jZSB2aW9sYXRpb25cIiwgKCkgPT4ge1xuICAgIGNvbnN0IHRhc2tzID0gW1xuICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlQwNlwiLFxuICAgICAgICBzZXF1ZW5jZTogMCxcbiAgICAgICAgaW5wdXRzOiBbXCJhcnRpZmFjdHMvTTAwOS1TMDMvXCJdLFxuICAgICAgICBleHBlY3RlZF9vdXRwdXQ6IFtcbiAgICAgICAgICBcImFydGlmYWN0cy9NMDA5LVMwMy9zdW1tYXJ5Lmpzb25cIixcbiAgICAgICAgICBcImFydGlmYWN0cy9NMDA5LVMwMy9WRVJJRklDQVRJT04ubWRcIixcbiAgICAgICAgXSxcbiAgICAgIH0pLFxuICAgIF07XG5cbiAgICBjb25zdCByZXN1bHRzID0gY2hlY2tUYXNrT3JkZXJpbmcodGFza3MsIFwiL3RtcFwiKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgICAgcmVzdWx0cyxcbiAgICAgIFtdLFxuICAgICAgXCJEaXJlY3RvcnkgcmVmZXJlbmNlIHNob3VsZCBub3QgYmUgdHJlYXRlZCBhcyByZWFkaW5nIGEgZmlsZSBjcmVhdGVkIGxhdGVyXCIsXG4gICAgKTtcbiAgfSk7XG5cbiAgdGVzdChcInJ1bnRpbWUgZGlyZWN0b3J5IGFubm90YXRpb24gZG9lcyBub3QgcHJvZHVjZSBhbiBvcmRlcmluZyB2aW9sYXRpb25cIiwgKCkgPT4ge1xuICAgIGNvbnN0IHRhc2tzID0gW1xuICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlQwMlwiLFxuICAgICAgICBzZXF1ZW5jZTogMCxcbiAgICAgICAgaW5wdXRzOiBbXCJlbnRyaWVzLyBkaXJlY3RvcnkgKHJ1bnRpbWUpXCJdLFxuICAgICAgICBleHBlY3RlZF9vdXRwdXQ6IFtdLFxuICAgICAgfSksXG4gICAgXTtcblxuICAgIGNvbnN0IHJlc3VsdHMgPSBjaGVja1Rhc2tPcmRlcmluZyh0YXNrcywgXCIvdG1wXCIpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwocmVzdWx0cywgW10pO1xuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUmVncmVzc2lvbiBUZXN0czogY2hlY2tUYXNrT3JkZXJpbmcgZmFsc2UgcG9zaXRpdmUgZm9yIHByZS1leGVjdXRpb24gcmVmcyAoIzQwNzEpIFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcImNoZWNrVGFza09yZGVyaW5nIGZhbHNlIHBvc2l0aXZlIGZvciBwcmUtZXhlY3V0aW9uIHJlZnMgKCM0MDcxKVwiLCAoKSA9PiB7XG4gIHRlc3QoXCJjb21wbGV0ZWQgdGFzayBhdCBoaWdoZXIgaW5kZXggZG9lcyBub3QgdHJpZ2dlciBvcmRlcmluZyB2aW9sYXRpb24gZm9yIGl0cyBvdXRwdXRzXCIsICgpID0+IHtcbiAgICAvLyBTY2VuYXJpbzogYWZ0ZXIgYSByZXBsYW4sIGEgY29tcGxldGVkIHRhc2sgYXQgaGlnaGVyIGFycmF5IGluZGV4IGhhcyBhbHJlYWR5XG4gICAgLy8gY3JlYXRlZCBhIGZpbGUuIEEgbmV3IGVhcmxpZXItc2VxdWVuY2UgdGFzayByZWFkcyB0aGF0IGZpbGUuIFNpbmNlIHRoZVxuICAgIC8vIGNvbXBsZXRlZCB0YXNrIGFscmVhZHkgcmFuLCBpdHMgb3V0cHV0IGlzIGF2YWlsYWJsZSByZWdhcmRsZXNzIG9mIGRpc2sgc3RhdGUuXG4gICAgLy8gY2hlY2tUYXNrT3JkZXJpbmcgbXVzdCBub3QgZmxhZyB0aGlzIGFzIGEgc2VxdWVuY2UgdmlvbGF0aW9uLlxuICAgIGNvbnN0IHRhc2tzID0gW1xuICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlRfTkVXXCIsXG4gICAgICAgIHNlcXVlbmNlOiAxLFxuICAgICAgICBzdGF0dXM6IFwicGVuZGluZ1wiLFxuICAgICAgICBpbnB1dHM6IFtcImFydGlmYWN0cy9zZXR1cC5qc29uXCJdLFxuICAgICAgICBleHBlY3RlZF9vdXRwdXQ6IFtdLFxuICAgICAgfSksXG4gICAgICBjcmVhdGVUYXNrKHtcbiAgICAgICAgaWQ6IFwiVF9TRVRVUFwiLFxuICAgICAgICBzZXF1ZW5jZTogNSxcbiAgICAgICAgc3RhdHVzOiBcImNvbXBsZXRlZFwiLFxuICAgICAgICBpbnB1dHM6IFtdLFxuICAgICAgICBleHBlY3RlZF9vdXRwdXQ6IFtcImFydGlmYWN0cy9zZXR1cC5qc29uXCJdLFxuICAgICAgfSksXG4gICAgXTtcblxuICAgIGNvbnN0IHJlc3VsdHMgPSBjaGVja1Rhc2tPcmRlcmluZyh0YXNrcywgXCIvdG1wXCIpO1xuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIHJlc3VsdHMubGVuZ3RoLFxuICAgICAgMCxcbiAgICAgIFwiY29tcGxldGVkIHRhc2sgb3V0cHV0cyBtdXN0IG5vdCB0cmlnZ2VyIG9yZGVyaW5nIHZpb2xhdGlvbnMgZm9yIGVhcmxpZXItc2VxdWVuY2UgdGFza3MgdGhhdCByZWFkIHRoZW1cIixcbiAgICApO1xuICB9KTtcblxuICB0ZXN0KFwicGVuZGluZyB0YXNrIGF0IGhpZ2hlciBpbmRleCBzdGlsbCB0cmlnZ2VycyBvcmRlcmluZyB2aW9sYXRpb25cIiwgKCkgPT4ge1xuICAgIC8vIEEgUEVORElORyB0YXNrIGF0IGhpZ2hlciBpbmRleCBjcmVhdGluZyBhIGZpbGUgaXMgYSByZWFsIHZpb2xhdGlvbi5cbiAgICAvLyBPbmx5IGNvbXBsZXRlZCB0YXNrcyBnZXQgdGhlIGV4ZW1wdGlvbi5cbiAgICBjb25zdCB0YXNrcyA9IFtcbiAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICBpZDogXCJUMDFcIixcbiAgICAgICAgc2VxdWVuY2U6IDEsXG4gICAgICAgIHN0YXR1czogXCJwZW5kaW5nXCIsXG4gICAgICAgIGlucHV0czogW1wiYXJ0aWZhY3RzL291dHB1dC5qc29uXCJdLFxuICAgICAgICBleHBlY3RlZF9vdXRwdXQ6IFtdLFxuICAgICAgfSksXG4gICAgICBjcmVhdGVUYXNrKHtcbiAgICAgICAgaWQ6IFwiVDAyXCIsXG4gICAgICAgIHNlcXVlbmNlOiA1LFxuICAgICAgICBzdGF0dXM6IFwicGVuZGluZ1wiLFxuICAgICAgICBpbnB1dHM6IFtdLFxuICAgICAgICBleHBlY3RlZF9vdXRwdXQ6IFtcImFydGlmYWN0cy9vdXRwdXQuanNvblwiXSxcbiAgICAgIH0pLFxuICAgIF07XG5cbiAgICBjb25zdCByZXN1bHRzID0gY2hlY2tUYXNrT3JkZXJpbmcodGFza3MsIFwiL3RtcFwiKTtcbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICByZXN1bHRzLmxlbmd0aCxcbiAgICAgIDEsXG4gICAgICBcInBlbmRpbmcgdGFzayBhdCBoaWdoZXIgaW5kZXggbXVzdCBzdGlsbCBiZSBmbGFnZ2VkIGFzIG9yZGVyaW5nIHZpb2xhdGlvblwiLFxuICAgICk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdHNbMF0uYmxvY2tpbmcsIHRydWUpO1xuICAgIGFzc2VydC5vayhyZXN1bHRzWzBdLm1lc3NhZ2UuaW5jbHVkZXMoXCJUMDFcIikpO1xuICAgIGFzc2VydC5vayhyZXN1bHRzWzBdLm1lc3NhZ2UuaW5jbHVkZXMoXCJUMDJcIikpO1xuICAgIGFzc2VydC5vayhyZXN1bHRzWzBdLm1lc3NhZ2UuaW5jbHVkZXMoXCJzZXF1ZW5jZSB2aW9sYXRpb25cIikpO1xuICB9KTtcblxuICB0ZXN0KFwicGVuZGluZy1maXJzdCB0aGVuIGNvbXBsZXRlZC1sYXRlcjogY29tcGxldGVkIHJlcGxhY2VzIHBlbmRpbmcgaW4gZmlsZUNyZWF0b3JzICgjNDU3MilcIiwgKCkgPT4ge1xuICAgIC8vIFJlZ3Jlc3Npb24gZm9yIENvZGVSYWJiaXQgTWFqb3IgZmluZGluZyBvbiBQUiAjNDU3MjpcbiAgICAvLyBmaWxlQ3JlYXRvcnMgb25seSBzdG9yZWQgdGhlIEZJUlNUIHRhc2sgZm9yIGEgZ2l2ZW4gcGF0aC4gSWYgYSBQRU5ESU5HIHRhc2sgYXRcbiAgICAvLyBhcnJheSBpbmRleCAxIHdhcyByZWdpc3RlcmVkIGZpcnN0LCBhbmQgYSBDT01QTEVURUQgdGFzayBhdCBhcnJheSBpbmRleCAyIGFsc29cbiAgICAvLyBkZWNsYXJlZCB0aGUgc2FtZSBvdXRwdXQgcGF0aCwgdGhlIGNvbXBsZXRlZCBlbnRyeSB3YXMgZGlzY2FyZGVkLiBMaW5lIH41MjkgdGhlblxuICAgIC8vIHNhdyBhIHBlbmRpbmcgY3JlYXRvciB3aXRoIGluZGV4ID4gaSBhbmQgaW5jb3JyZWN0bHkgZmlyZWQgYSBzZXF1ZW5jZSB2aW9sYXRpb25cbiAgICAvLyBmb3IgdGhlIHJlYWRlciBhdCBhcnJheSBpbmRleCAwLlxuICAgIC8vXG4gICAgLy8gU2NlbmFyaW86IHBhdGggZmlyc3QgZGVjbGFyZWQgYnkgcGVuZGluZyB0YXNrIChpbmRleCAxKSwgdGhlbiBieSBjb21wbGV0ZWQgdGFza1xuICAgIC8vIChpbmRleCAyKS4gUmVhZGVyIGlzIGF0IGluZGV4IDAuIFdpdGhvdXQgdGhlIGZpeCBhIHZpb2xhdGlvbiBmaXJlczsgd2l0aCB0aGUgZml4XG4gICAgLy8gdGhlIGNvbXBsZXRlZCBlbnRyeSByZXBsYWNlcyB0aGUgcGVuZGluZyBlbnRyeSBhbmQgZ3JhbnRzIHRoZSBleGVtcHRpb24uXG4gICAgY29uc3QgdGFza3MgPSBbXG4gICAgICAvLyBhcnJheSBpbmRleCAwIFx1MjAxNCByZWFkcyB0aGUgc2hhcmVkIHBhdGhcbiAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICBpZDogXCJUX1JFQURFUlwiLFxuICAgICAgICBzZXF1ZW5jZTogMSxcbiAgICAgICAgc3RhdHVzOiBcInBlbmRpbmdcIixcbiAgICAgICAgaW5wdXRzOiBbXCJzaGFyZWQvYXJ0aWZhY3QuanNvblwiXSxcbiAgICAgICAgZXhwZWN0ZWRfb3V0cHV0OiBbXSxcbiAgICAgIH0pLFxuICAgICAgLy8gYXJyYXkgaW5kZXggMSBcdTIwMTQgcGVuZGluZyBwcm9kdWNlciAodmlzaXRlZCBmaXJzdCBkdXJpbmcgbWFwIGJ1aWxkKVxuICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlRfUEVORElOR19QUk9EVUNFUlwiLFxuICAgICAgICBzZXF1ZW5jZTogNSxcbiAgICAgICAgc3RhdHVzOiBcInBlbmRpbmdcIixcbiAgICAgICAgaW5wdXRzOiBbXSxcbiAgICAgICAgZXhwZWN0ZWRfb3V0cHV0OiBbXCJzaGFyZWQvYXJ0aWZhY3QuanNvblwiXSxcbiAgICAgIH0pLFxuICAgICAgLy8gYXJyYXkgaW5kZXggMiBcdTIwMTQgY29tcGxldGVkIHByb2R1Y2VyICh2aXNpdGVkIHNlY29uZDsgbXVzdCByZXBsYWNlIHBlbmRpbmcgZW50cnkpXG4gICAgICBjcmVhdGVUYXNrKHtcbiAgICAgICAgaWQ6IFwiVF9DT01QTEVURURfUFJPRFVDRVJcIixcbiAgICAgICAgc2VxdWVuY2U6IDIsXG4gICAgICAgIHN0YXR1czogXCJjb21wbGV0ZWRcIixcbiAgICAgICAgaW5wdXRzOiBbXSxcbiAgICAgICAgZXhwZWN0ZWRfb3V0cHV0OiBbXCJzaGFyZWQvYXJ0aWZhY3QuanNvblwiXSxcbiAgICAgIH0pLFxuICAgIF07XG5cbiAgICAvLyBXaXRob3V0IHRoZSBmaXg6IGNyZWF0b3IgPSBUX1BFTkRJTkdfUFJPRFVDRVIgKGluZGV4IDEpLCAhY3JlYXRvci5jb21wbGV0ZWQgJiYgMSA+IDAgXHUyMTkyIHZpb2xhdGlvbi5cbiAgICAvLyBXaXRoIHRoZSBmaXg6ICAgIGNyZWF0b3IgPSBUX0NPTVBMRVRFRF9QUk9EVUNFUiAoaW5kZXggMiksIGNyZWF0b3IuY29tcGxldGVkIFx1MjE5MiBubyB2aW9sYXRpb24uXG4gICAgY29uc3QgcmVzdWx0cyA9IGNoZWNrVGFza09yZGVyaW5nKHRhc2tzLCBcIi90bXBcIik7XG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgcmVzdWx0cy5sZW5ndGgsXG4gICAgICAwLFxuICAgICAgXCJjb21wbGV0ZWQgcHJvZHVjZXIgbXVzdCByZXBsYWNlIHBlbmRpbmcgcHJvZHVjZXIgaW4gZmlsZUNyZWF0b3JzIGFuZCBzdXBwcmVzcyBmYWxzZSB2aW9sYXRpb25cIixcbiAgICApO1xuICB9KTtcblxuICB0ZXN0KFwiY29tcGxldGVkIHRhc2sgb3V0cHV0IGV4ZW1wdGlvbiBhcHBsaWVzIHJlZ2FyZGxlc3Mgb2Ygd2hldGhlciBmaWxlIGV4aXN0cyBvbiBkaXNrXCIsICh0KSA9PiB7XG4gICAgLy8gVGhlIGNvbXBsZXRlZC10YXNrIGV4ZW1wdGlvbiBtdXN0IHdvcmsgZXZlbiB3aGVuIHRoZSBmaWxlIGlzIG5vdCBvbiBkaXNrXG4gICAgLy8gKGUuZy4sIHRoZSBmaWxlIHdhcyBhIHRlbXBvcmFyeSBhcnRpZmFjdCB0aGF0IHdhcyBjbGVhbmVkIHVwIGFmdGVyIHRoZSB0YXNrIHJhbikuXG4gICAgY29uc3QgdGVtcERpciA9IGpvaW4odG1wZGlyKCksIGBwcmUtZXhlYy1jb21wbGV0ZWQtdGFzay0ke0RhdGUubm93KCl9YCk7XG4gICAgbWtkaXJTeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG5cbiAgICAvLyBGaWxlIGRlbGliZXJhdGVseSBOT1QgY3JlYXRlZCBvbiBkaXNrIFx1MjAxNCBjb21wbGV0ZWQgdGFzayByYW4gaW4gYSBwcmlvciBzZXNzaW9uXG4gICAgY29uc3QgdGFza3MgPSBbXG4gICAgICBjcmVhdGVUYXNrKHtcbiAgICAgICAgaWQ6IFwiVF9NQUlOXCIsXG4gICAgICAgIHNlcXVlbmNlOiAwLFxuICAgICAgICBzdGF0dXM6IFwicGVuZGluZ1wiLFxuICAgICAgICBpbnB1dHM6IFtcImdlbmVyYXRlZC9jb25maWcuanNvblwiXSxcbiAgICAgICAgZXhwZWN0ZWRfb3V0cHV0OiBbXSxcbiAgICAgIH0pLFxuICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlRfSU5JVFwiLFxuICAgICAgICBzZXF1ZW5jZTogMTAsXG4gICAgICAgIHN0YXR1czogXCJjb21wbGV0ZWRcIixcbiAgICAgICAgaW5wdXRzOiBbXSxcbiAgICAgICAgZXhwZWN0ZWRfb3V0cHV0OiBbXCJnZW5lcmF0ZWQvY29uZmlnLmpzb25cIl0sXG4gICAgICB9KSxcbiAgICBdO1xuXG4gICAgY29uc3QgcmVzdWx0cyA9IGNoZWNrVGFza09yZGVyaW5nKHRhc2tzLCB0ZW1wRGlyKTtcbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICByZXN1bHRzLmxlbmd0aCxcbiAgICAgIDAsXG4gICAgICBcImNvbXBsZXRlZCB0YXNrIGV4ZW1wdGlvbiBtdXN0IGFwcGx5IGV2ZW4gd2hlbiBmaWxlIGlzIGFic2VudCBmcm9tIGRpc2tcIixcbiAgICApO1xuICB9KTtcbn0pO1xuXG5kZXNjcmliZShcImNoZWNrRmlsZVBhdGhDb25zaXN0ZW5jeSBjb21wbGV0ZWQtdGFzayBvdXRwdXQgZXhlbXB0aW9uICgjNDA3MSlcIiwgKCkgPT4ge1xuICB0ZXN0KFwiY29tcGxldGVkIHRhc2sgYXQgaGlnaGVyIGluZGV4IGRvZXMgbm90IGNhdXNlIGZhbHNlIHBvc2l0aXZlIGZvciBmaWxlIGl0IHByb2R1Y2VkXCIsICh0KSA9PiB7XG4gICAgLy8gUGFyYWxsZWwgdG8gdGhlIGNoZWNrVGFza09yZGVyaW5nIGZpeDogY2hlY2tGaWxlUGF0aENvbnNpc3RlbmN5IGFsc28gdXNlc1xuICAgIC8vIGdldEV4cGVjdGVkT3V0cHV0c1VwVG8gd2hpY2ggaGlzdG9yaWNhbGx5IG9ubHkgbG9va2VkIGF0IHByaW9yLWluZGV4IHRhc2tzLlxuICAgIC8vIEEgY29tcGxldGVkIHRhc2sgYXQgYSBoaWdoZXIgaW5kZXggaGFzIGFscmVhZHkgcnVuIGFuZCBpdHMgb3V0cHV0cyBhcmUgYXZhaWxhYmxlLlxuICAgIGNvbnN0IHRlbXBEaXIgPSBqb2luKHRtcGRpcigpLCBgcHJlLWV4ZWMtZmMtY29tcGxldGVkLSR7RGF0ZS5ub3coKX1gKTtcbiAgICBta2RpclN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgdC5hZnRlcigoKSA9PiBybVN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcblxuICAgIC8vIEZpbGUgaXMgTk9UIG9uIGRpc2sgXHUyMDE0IGNvbXBsZXRlZCB0YXNrIHJhbiBpbiBhIHByaW9yIHNlc3Npb24gYW5kIGZpbGUgd2FzIGNsZWFuZWRcbiAgICBjb25zdCB0YXNrcyA9IFtcbiAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICBpZDogXCJUX01BSU5cIixcbiAgICAgICAgc2VxdWVuY2U6IDEsXG4gICAgICAgIHN0YXR1czogXCJwZW5kaW5nXCIsXG4gICAgICAgIGlucHV0czogW1wiYXJ0aWZhY3RzL2NvbmZpZy5qc29uXCJdLFxuICAgICAgICBleHBlY3RlZF9vdXRwdXQ6IFtdLFxuICAgICAgfSksXG4gICAgICBjcmVhdGVUYXNrKHtcbiAgICAgICAgaWQ6IFwiVF9TRVRVUFwiLFxuICAgICAgICBzZXF1ZW5jZTogMTAsXG4gICAgICAgIHN0YXR1czogXCJjb21wbGV0ZWRcIixcbiAgICAgICAgaW5wdXRzOiBbXSxcbiAgICAgICAgZXhwZWN0ZWRfb3V0cHV0OiBbXCJhcnRpZmFjdHMvY29uZmlnLmpzb25cIl0sXG4gICAgICB9KSxcbiAgICBdO1xuXG4gICAgY29uc3QgcmVzdWx0cyA9IGNoZWNrRmlsZVBhdGhDb25zaXN0ZW5jeSh0YXNrcywgdGVtcERpcik7XG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgcmVzdWx0cy5sZW5ndGgsXG4gICAgICAwLFxuICAgICAgXCJjb21wbGV0ZWQgdGFzayBhdCBoaWdoZXIgaW5kZXggc2hvdWxkIHNhdGlzZnkgaW5wdXRzIG9mIHBlbmRpbmcgdGFza3MgdGhhdCByZWFkIGl0cyBvdXRwdXRzXCIsXG4gICAgKTtcbiAgfSk7XG5cbiAgdGVzdChcInBlbmRpbmcgdGFzayBhdCBoaWdoZXIgaW5kZXggZG9lcyBOT1QgY2F1c2UgYSBkdXBsaWNhdGUgY29uc2lzdGVuY3kgZXJyb3IgKG9yZGVyaW5nIGNoZWNrIGhhbmRsZXMgaXQpXCIsICh0KSA9PiB7XG4gICAgY29uc3QgdGVtcERpciA9IGpvaW4odG1wZGlyKCksIGBwcmUtZXhlYy1mYy1wZW5kaW5nLSR7RGF0ZS5ub3coKX1gKTtcbiAgICBta2RpclN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgdC5hZnRlcigoKSA9PiBybVN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcblxuICAgIGNvbnN0IHRhc2tzID0gW1xuICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgICBzZXF1ZW5jZTogMSxcbiAgICAgICAgc3RhdHVzOiBcInBlbmRpbmdcIixcbiAgICAgICAgaW5wdXRzOiBbXCJhcnRpZmFjdHMvb3V0cHV0Lmpzb25cIl0sXG4gICAgICAgIGV4cGVjdGVkX291dHB1dDogW10sXG4gICAgICB9KSxcbiAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICBpZDogXCJUMDJcIixcbiAgICAgICAgc2VxdWVuY2U6IDEwLFxuICAgICAgICBzdGF0dXM6IFwicGVuZGluZ1wiLFxuICAgICAgICBpbnB1dHM6IFtdLFxuICAgICAgICBleHBlY3RlZF9vdXRwdXQ6IFtcImFydGlmYWN0cy9vdXRwdXQuanNvblwiXSxcbiAgICAgIH0pLFxuICAgIF07XG5cbiAgICAvLyBjaGVja0ZpbGVQYXRoQ29uc2lzdGVuY3kgc3VwcHJlc3NlcyB0aGUgZXJyb3IgaGVyZSBiZWNhdXNlIGNoZWNrVGFza09yZGVyaW5nXG4gICAgLy8gd2lsbCBmaXJlIGEgbW9yZSBwcmVjaXNlIFwic2VxdWVuY2UgdmlvbGF0aW9uXCIgZXJyb3IgZm9yIHRoZSBzYW1lIGZpbGUuXG4gICAgLy8gVGhlIGNvbWJpbmVkIG91dHB1dCBvZiBydW5QcmVFeGVjdXRpb25DaGVja3Mgc3RpbGwgZmxhZ3MgdGhlIGlzc3VlIFx1MjAxNCBqdXN0XG4gICAgLy8gb25jZSwgdmlhIHRoZSBvcmRlcmluZyBjaGVjaywgaW5zdGVhZCBvZiB0d2ljZS5cbiAgICBjb25zdCByZXN1bHRzID0gY2hlY2tGaWxlUGF0aENvbnNpc3RlbmN5KHRhc2tzLCB0ZW1wRGlyKTtcbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICByZXN1bHRzLmxlbmd0aCxcbiAgICAgIDAsXG4gICAgICBcImNvbnNpc3RlbmN5IGNoZWNrIG11c3Qgbm90IGR1cGxpY2F0ZSB3aGF0IHRoZSBvcmRlcmluZyBjaGVjayBhbHJlYWR5IHJlcG9ydHNcIixcbiAgICApO1xuICB9KTtcbn0pO1xuXG5kZXNjcmliZShcImNoZWNrRmlsZVBhdGhDb25zaXN0ZW5jeSBzZWxmLXJlZmVyZW50aWFsIGlucHV0cyAoIzQ0NTkpXCIsICgpID0+IHtcbiAgdGVzdChcImlucHV0IHRoYXQgaXMgYWxzbyBpbiB0aGUgc2FtZSB0YXNrJ3MgZXhwZWN0ZWRfb3V0cHV0IGlzIG5vdCBibG9ja2luZyB3aGVuIG1pc3Npbmcgb24gZGlza1wiLCAodCkgPT4ge1xuICAgIGNvbnN0IHRlbXBEaXIgPSBqb2luKHRtcGRpcigpLCBgcHJlLWV4ZWMtc2VsZi1vdXRwdXQtJHtEYXRlLm5vdygpfWApO1xuICAgIG1rZGlyU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB0LmFmdGVyKCgpID0+IHJtU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuXG4gICAgY29uc3QgdGFza3MgPSBbXG4gICAgICBjcmVhdGVUYXNrKHtcbiAgICAgICAgaWQ6IFwiVDAyXCIsXG4gICAgICAgIHNlcXVlbmNlOiAwLFxuICAgICAgICBpbnB1dHM6IFtcInNyYy9jb21wb25lbnRzL2VtYWlsL1Nub296ZVBvcG92ZXIuanN4XCJdLFxuICAgICAgICBleHBlY3RlZF9vdXRwdXQ6IFtcInNyYy9jb21wb25lbnRzL2VtYWlsL1Nub296ZVBvcG92ZXIuanN4XCJdLFxuICAgICAgfSksXG4gICAgXTtcblxuICAgIGNvbnN0IHJlc3VsdHMgPSBjaGVja0ZpbGVQYXRoQ29uc2lzdGVuY3kodGFza3MsIHRlbXBEaXIpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwoXG4gICAgICByZXN1bHRzLFxuICAgICAgW10sXG4gICAgICBcIkZpbGUgZGVjbGFyZWQgYXMgYm90aCBpbnB1dCBhbmQgZXhwZWN0ZWRfb3V0cHV0IG9mIHRoZSBzYW1lIHRhc2sgc2hvdWxkIG5vdCBibG9jayBcdTIwMTQgdGhlIHRhc2sgaXRzZWxmIHByb2R1Y2VzIGl0XCIsXG4gICAgKTtcbiAgfSk7XG5cbiAgdGVzdChcImlucHV0IG1pc3NpbmcgZnJvbSBkaXNrLCBtaXNzaW5nIGZyb20gcHJpb3Igb3V0cHV0cywgYW5kIG1pc3NpbmcgZnJvbSBvd24gZXhwZWN0ZWRfb3V0cHV0IHN0aWxsIGJsb2Nrc1wiLCAodCkgPT4ge1xuICAgIGNvbnN0IHRlbXBEaXIgPSBqb2luKHRtcGRpcigpLCBgcHJlLWV4ZWMtc2VsZi1vdXRwdXQtbWlzc2luZy0ke0RhdGUubm93KCl9YCk7XG4gICAgbWtkaXJTeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG5cbiAgICBjb25zdCB0YXNrcyA9IFtcbiAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICBpZDogXCJUMDJcIixcbiAgICAgICAgc2VxdWVuY2U6IDAsXG4gICAgICAgIGlucHV0czogW1wic3JjL2NvbXBvbmVudHMvZW1haWwvU25vb3plUG9wb3Zlci5qc3hcIl0sXG4gICAgICAgIGV4cGVjdGVkX291dHB1dDogW1wic3JjL290aGVyL3VucmVsYXRlZC5qc3hcIl0sXG4gICAgICB9KSxcbiAgICBdO1xuXG4gICAgY29uc3QgcmVzdWx0cyA9IGNoZWNrRmlsZVBhdGhDb25zaXN0ZW5jeSh0YXNrcywgdGVtcERpcik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdHMubGVuZ3RoLCAxLCBcIkdlbnVpbmVseSBtaXNzaW5nIGlucHV0IHNob3VsZCBzdGlsbCBiZSByZXBvcnRlZFwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0c1swXS5ibG9ja2luZywgdHJ1ZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdHNbMF0udGFyZ2V0LCBcInNyYy9jb21wb25lbnRzL2VtYWlsL1Nub296ZVBvcG92ZXIuanN4XCIpO1xuICB9KTtcblxuICB0ZXN0KFwic2VsZi1vdXRwdXQgZXhlbXB0aW9uIG1hdGNoZXMgYWNyb3NzIHBhdGggbm9ybWFsaXphdGlvbiAoLi8gcHJlZml4KVwiLCAodCkgPT4ge1xuICAgIGNvbnN0IHRlbXBEaXIgPSBqb2luKHRtcGRpcigpLCBgcHJlLWV4ZWMtc2VsZi1vdXRwdXQtbm9ybS0ke0RhdGUubm93KCl9YCk7XG4gICAgbWtkaXJTeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG5cbiAgICBjb25zdCB0YXNrcyA9IFtcbiAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICBpZDogXCJUMDJcIixcbiAgICAgICAgc2VxdWVuY2U6IDAsXG4gICAgICAgIGlucHV0czogW1wiLi9zcmMvZ2VuZXJhdGVkLnRzXCJdLFxuICAgICAgICBleHBlY3RlZF9vdXRwdXQ6IFtcInNyYy9nZW5lcmF0ZWQudHNcIl0sXG4gICAgICB9KSxcbiAgICBdO1xuXG4gICAgY29uc3QgcmVzdWx0cyA9IGNoZWNrRmlsZVBhdGhDb25zaXN0ZW5jeSh0YXNrcywgdGVtcERpcik7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICAgIHJlc3VsdHMsXG4gICAgICBbXSxcbiAgICAgIFwiLi9zcmMvZ2VuZXJhdGVkLnRzIGFuZCBzcmMvZ2VuZXJhdGVkLnRzIHNob3VsZCBjb21wYXJlIGVxdWFsIGFmdGVyIG5vcm1hbGl6YXRpb25cIixcbiAgICApO1xuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUmVncmVzc2lvbiBUZXN0czogcXVvdGUtd3JhcHBlZCBpbnB1dHMgdHJlYXRlZCBhcyBsaXRlcmFsIHBhdGhzICgjMzc0NykgXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiY2hlY2tGaWxlUGF0aENvbnNpc3RlbmN5IHF1b3RlLXdyYXBwZWQgYW5ub3RhdGlvbiAoIzM3NDcpXCIsICgpID0+IHtcbiAgdGVzdChcImRvdWJsZS1xdW90ZWQgcGF0aCBhbm5vdGF0aW9uIGlzIHN0cmlwcGVkIGJlZm9yZSBwYXRoIGNoZWNrXCIsICh0KSA9PiB7XG4gICAgLy8gUGxhbiBkb2N1bWVudHMgc29tZXRpbWVzIGVtaXQgYFwic3JjL2Zvby50c1wiYCAoZG91YmxlLXF1b3RlIHdyYXBwZWQpIGFzIGFuXG4gICAgLy8gaW5wdXQgdmFsdWUuIFRoZSBjaGVja2VyIG11c3Qgc3RyaXAgdGhlIHF1b3RlcyBiZWZvcmUgY2hlY2tpbmcgZXhpc3RlbmNlIHNvXG4gICAgLy8gaXQgZG9lc24ndCBwcm9kdWNlIGEgZmFsc2UtcG9zaXRpdmUgXCJmaWxlIG5vdCBmb3VuZFwiIGVycm9yLlxuICAgIGNvbnN0IHRlbXBEaXIgPSBqb2luKHRtcGRpcigpLCBgcHJlLWV4ZWMtcXVvdGUtJHtEYXRlLm5vdygpfWApO1xuICAgIG1rZGlyU3luYyhqb2luKHRlbXBEaXIsIFwic3JjXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4odGVtcERpciwgXCJzcmMvZm9vLnRzXCIpLCBcIi8vIGNvbnRlbnRcIik7XG4gICAgdC5hZnRlcigoKSA9PiBybVN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcblxuICAgIGNvbnN0IHRhc2tzID0gW1xuICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgICBpbnB1dHM6IFsnXCJzcmMvZm9vLnRzXCInXSxcbiAgICAgICAgZXhwZWN0ZWRfb3V0cHV0OiBbXSxcbiAgICAgIH0pLFxuICAgIF07XG5cbiAgICBjb25zdCByZXN1bHRzID0gY2hlY2tGaWxlUGF0aENvbnNpc3RlbmN5KHRhc2tzLCB0ZW1wRGlyKTtcbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICByZXN1bHRzLmxlbmd0aCxcbiAgICAgIDAsXG4gICAgICBcIkRvdWJsZS1xdW90ZWQgcGF0aCBzaG91bGQgYmUgc3RyaXBwZWQgYW5kIHJlc29sdmVkIHRvIHRoZSByZWFsIGZpbGVcIixcbiAgICApO1xuICB9KTtcblxuICB0ZXN0KFwic2luZ2xlLXF1b3RlZCBwYXRoIGFubm90YXRpb24gaXMgc3RyaXBwZWQgYmVmb3JlIHBhdGggY2hlY2tcIiwgKHQpID0+IHtcbiAgICBjb25zdCB0ZW1wRGlyID0gam9pbih0bXBkaXIoKSwgYHByZS1leGVjLXNxdW90ZS0ke0RhdGUubm93KCl9YCk7XG4gICAgbWtkaXJTeW5jKGpvaW4odGVtcERpciwgXCJzcmNcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbih0ZW1wRGlyLCBcInNyYy9iYXIudHNcIiksIFwiLy8gY29udGVudFwiKTtcbiAgICB0LmFmdGVyKCgpID0+IHJtU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuXG4gICAgY29uc3QgdGFza3MgPSBbXG4gICAgICBjcmVhdGVUYXNrKHtcbiAgICAgICAgaWQ6IFwiVDAxXCIsXG4gICAgICAgIGlucHV0czogW1wiJ3NyYy9iYXIudHMnXCJdLFxuICAgICAgICBleHBlY3RlZF9vdXRwdXQ6IFtdLFxuICAgICAgfSksXG4gICAgXTtcblxuICAgIGNvbnN0IHJlc3VsdHMgPSBjaGVja0ZpbGVQYXRoQ29uc2lzdGVuY3kodGFza3MsIHRlbXBEaXIpO1xuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIHJlc3VsdHMubGVuZ3RoLFxuICAgICAgMCxcbiAgICAgIFwiU2luZ2xlLXF1b3RlZCBwYXRoIHNob3VsZCBiZSBzdHJpcHBlZCBhbmQgcmVzb2x2ZWQgdG8gdGhlIHJlYWwgZmlsZVwiLFxuICAgICk7XG4gIH0pO1xuXG4gIHRlc3QoXCJiYWNrdGljay1vbmx5IHdyYXBwZWQgcGF0aCB3aXRob3V0IGFubm90YXRpb24gcmVzb2x2ZXMgY29ycmVjdGx5XCIsICh0KSA9PiB7XG4gICAgLy8gVGhlIGJhcmUgZm9ybSBgc3JjL2Zvby50c2AgKG5vIGRhc2ggYW5ub3RhdGlvbikgbXVzdCBhbHNvIHdvcmtcbiAgICBjb25zdCB0ZW1wRGlyID0gam9pbih0bXBkaXIoKSwgYHByZS1leGVjLWJhY2t0aWNrLWJhcmUtJHtEYXRlLm5vdygpfWApO1xuICAgIG1rZGlyU3luYyhqb2luKHRlbXBEaXIsIFwic3JjXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4odGVtcERpciwgXCJzcmMvYmF6LnRzXCIpLCBcIi8vIGNvbnRlbnRcIik7XG4gICAgdC5hZnRlcigoKSA9PiBybVN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcblxuICAgIGNvbnN0IHRhc2tzID0gW1xuICAgICAgY3JlYXRlVGFzayh7XG4gICAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgICBpbnB1dHM6IFtcImBzcmMvYmF6LnRzYFwiXSxcbiAgICAgICAgZXhwZWN0ZWRfb3V0cHV0OiBbXSxcbiAgICAgIH0pLFxuICAgIF07XG5cbiAgICBjb25zdCByZXN1bHRzID0gY2hlY2tGaWxlUGF0aENvbnNpc3RlbmN5KHRhc2tzLCB0ZW1wRGlyKTtcbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICByZXN1bHRzLmxlbmd0aCxcbiAgICAgIDAsXG4gICAgICBcIkJhcmUgYmFja3RpY2std3JhcHBlZCBwYXRoIHNob3VsZCByZXNvbHZlIHRvIHRoZSByZWFsIGZpbGVcIixcbiAgICApO1xuICB9KTtcblxuICB0ZXN0KFwicHJvc2UgdmFsdWUgd2l0aCBzcGFjZXMgaW5zaWRlIHF1b3RlcyBpcyBza2lwcGVkIChub3QgYSBwYXRoKVwiLCAoKSA9PiB7XG4gICAgLy8gXCJzb21lIGRlc2NyaXB0aW9uIHRleHRcIiBjb250YWlucyBzcGFjZXMgXHUyMDE0IHNob3VsZCBub3QgYmUgY2hlY2tlZCBhcyBhIHBhdGhcbiAgICBjb25zdCB0YXNrcyA9IFtcbiAgICAgIGNyZWF0ZVRhc2soe1xuICAgICAgICBpZDogXCJUMDFcIixcbiAgICAgICAgaW5wdXRzOiBbJ1wic29tZSBkZXNjcmlwdGlvbiB0ZXh0XCInXSxcbiAgICAgICAgZXhwZWN0ZWRfb3V0cHV0OiBbXSxcbiAgICAgIH0pLFxuICAgIF07XG5cbiAgICBjb25zdCByZXN1bHRzID0gY2hlY2tGaWxlUGF0aENvbnNpc3RlbmN5KHRhc2tzLCBcIi90bXBcIik7XG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgcmVzdWx0cy5sZW5ndGgsXG4gICAgICAwLFxuICAgICAgXCJRdW90ZWQgcHJvc2Ugd2l0aCBzcGFjZXMgc2hvdWxkIG5vdCBiZSB0cmVhdGVkIGFzIGEgZmlsZSBwYXRoXCIsXG4gICAgKTtcbiAgfSk7XG5cbiAgdGVzdChcIjE3LWVycm9yIHNjZW5hcmlvOiBtaXhlZCBhbm5vdGF0ZWQgaW5wdXRzIHByb2R1Y2UgMCBibG9ja2luZyBlcnJvcnNcIiwgKHQpID0+IHtcbiAgICAvLyBSZXByb2R1Y2VzIHRoZSBNMDA0LWVqNmo4OC9TMDcgc2NlbmFyaW8gZnJvbSBpc3N1ZSAjMzc0NyB3aGVyZSBhIHBsYW4gd2l0aFxuICAgIC8vIG11bHRpcGxlIGJhY2t0aWNrLSBhbmQgcXVvdGUtd3JhcHBlZCBpbnB1dCBzdHJpbmdzIGNhdXNlcyAxNyBmYWxzZSBibG9ja2luZyBlcnJvcnMuXG4gICAgY29uc3QgdGVtcERpciA9IGpvaW4odG1wZGlyKCksIGBwcmUtZXhlYy0zNzQ3LXNjZW5hcmlvLSR7RGF0ZS5ub3coKX1gKTtcbiAgICBta2RpclN5bmMoam9pbih0ZW1wRGlyLCBcInNyY1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHRlbXBEaXIsIFwic3JjL2Zvby50c1wiKSwgXCIvLyBjb250ZW50XCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbih0ZW1wRGlyLCBcInNyYy9iYXIudHNcIiksIFwiLy8gY29udGVudFwiKTtcbiAgICB0LmFmdGVyKCgpID0+IHJtU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuXG4gICAgY29uc3QgdGFza3MgPSBbXG4gICAgICBjcmVhdGVUYXNrKHtcbiAgICAgICAgaWQ6IFwiVDAxXCIsXG4gICAgICAgIGlucHV0czogW1xuICAgICAgICAgIFwiYHNyYy9mb28udHNgXCIsXG4gICAgICAgICAgJ1wic3JjL2Jhci50c1wiJyxcbiAgICAgICAgICBcInNvbWUgZGVzY3JpcHRpb24gdGV4dFwiLFxuICAgICAgICAgIFwiRXhpc3RpbmcgZW51bSBkZWZpbml0aW9uXCIsXG4gICAgICAgIF0sXG4gICAgICAgIGV4cGVjdGVkX291dHB1dDogW10sXG4gICAgICB9KSxcbiAgICBdO1xuXG4gICAgY29uc3QgcmVzdWx0cyA9IGNoZWNrRmlsZVBhdGhDb25zaXN0ZW5jeSh0YXNrcywgdGVtcERpcik7XG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgcmVzdWx0cy5sZW5ndGgsXG4gICAgICAwLFxuICAgICAgXCJBbm5vdGF0ZWQgZmlsZSBwYXRocyBhbmQgcHJvc2UgaW5wdXRzIHNob3VsZCBwcm9kdWNlIHplcm8gYmxvY2tpbmcgZXJyb3JzXCIsXG4gICAgKTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQWNBLFNBQVMsVUFBVSxZQUFrQjtBQUNyQyxPQUFPLFlBQVk7QUFDbkIsU0FBUyxTQUFTLGNBQWM7QUFDaEMsU0FBUyxXQUFXLGVBQWUsY0FBYztBQUNqRCxTQUFTLFlBQVk7QUFFckI7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtB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
