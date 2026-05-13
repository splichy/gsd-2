import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { discoverCommands, runVerificationGate, formatFailureContext, captureRuntimeErrors, runDependencyAudit, isLikelyCommand, validateVerificationCommand } from "../verification-gate.js";
import { validatePreferences } from "../preferences.js";
function makeTempDir(prefix) {
  const dir = join(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}
describe("verification-gate: discovery", () => {
  let tmp;
  beforeEach(() => {
    tmp = makeTempDir("vg-discovery");
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
  test("discoverCommands from preference commands", () => {
    const result = discoverCommands({
      preferenceCommands: ["npm run lint", "npm run test"],
      cwd: tmp
    });
    assert.deepStrictEqual(result.commands, ["npm run lint", "npm run test"]);
    assert.equal(result.source, "preference");
  });
  test("discoverCommands from task plan verify field", () => {
    const result = discoverCommands({
      taskPlanVerify: "npm run lint && npm run test",
      cwd: tmp
    });
    assert.deepStrictEqual(result.commands, ["npm run lint", "npm run test"]);
    assert.equal(result.source, "task-plan");
  });
  test("discoverCommands from package.json scripts", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({
        scripts: {
          typecheck: "tsc --noEmit",
          lint: "eslint .",
          test: "vitest",
          build: "tsc"
          // should NOT be included
        }
      })
    );
    const result = discoverCommands({ cwd: tmp });
    assert.deepStrictEqual(result.commands, [
      "npm run typecheck",
      "npm run lint",
      "npm run test"
    ]);
    assert.equal(result.source, "package-json");
  });
  test("first-non-empty-wins \u2014 preference beats task plan and package.json", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint ." } })
    );
    const result = discoverCommands({
      preferenceCommands: ["custom-check"],
      taskPlanVerify: "npm run lint",
      cwd: tmp
    });
    assert.deepStrictEqual(result.commands, ["custom-check"]);
    assert.equal(result.source, "preference");
  });
  test("task plan verify beats package.json", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint ." } })
    );
    const result = discoverCommands({
      taskPlanVerify: "custom-verify",
      cwd: tmp
    });
    assert.deepStrictEqual(result.commands, ["custom-verify"]);
    assert.equal(result.source, "task-plan");
  });
  test("missing package.json \u2192 0 checks, source none", () => {
    const result = discoverCommands({ cwd: tmp });
    assert.deepStrictEqual(result.commands, []);
    assert.equal(result.source, "none");
  });
  test("package.json with no matching scripts \u2192 0 checks", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ scripts: { build: "tsc", start: "node index.js" } })
    );
    const result = discoverCommands({ cwd: tmp });
    assert.deepStrictEqual(result.commands, []);
    assert.equal(result.source, "none");
  });
  test("empty preference array falls through to task plan", () => {
    const result = discoverCommands({
      preferenceCommands: [],
      taskPlanVerify: "echo ok",
      cwd: tmp
    });
    assert.deepStrictEqual(result.commands, ["echo ok"]);
    assert.equal(result.source, "task-plan");
  });
  test("package.json with only test script \u2192 returns only npm run test", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({
        scripts: {
          test: "vitest",
          build: "tsc",
          start: "node index.js"
        }
      })
    );
    const result = discoverCommands({ cwd: tmp });
    assert.deepStrictEqual(result.commands, ["npm run test"]);
    assert.equal(result.source, "package-json");
  });
  test("taskPlanVerify with single command (no &&)", () => {
    const result = discoverCommands({
      taskPlanVerify: "npm test",
      cwd: tmp
    });
    assert.deepStrictEqual(result.commands, ["npm test"]);
    assert.equal(result.source, "task-plan");
  });
  test("whitespace-only preference commands fall through", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint ." } })
    );
    const result = discoverCommands({
      preferenceCommands: ["  ", ""],
      cwd: tmp
    });
    assert.equal(result.source, "package-json");
    assert.deepStrictEqual(result.commands, ["npm run lint"]);
  });
  test("prose taskPlanVerify is rejected, falls through to package.json", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ scripts: { test: "vitest" } })
    );
    const result = discoverCommands({
      taskPlanVerify: "Document exists, contains all 5 scale names, all 14 semantic tokens",
      cwd: tmp
    });
    assert.equal(result.source, "package-json");
    assert.deepStrictEqual(result.commands, ["npm run test"]);
  });
  test("prose taskPlanVerify with no package.json \u2192 source none", () => {
    const result = discoverCommands({
      taskPlanVerify: "Verify the output matches expected format and all fields are present",
      cwd: tmp
    });
    assert.equal(result.source, "none");
    assert.deepStrictEqual(result.commands, []);
  });
  test("valid command in taskPlanVerify still works", () => {
    const result = discoverCommands({
      taskPlanVerify: "npm run lint && npm run test",
      cwd: tmp
    });
    assert.equal(result.source, "task-plan");
    assert.deepStrictEqual(result.commands, ["npm run lint", "npm run test"]);
  });
  test("mixed prose and commands in taskPlanVerify \u2014 only commands kept", () => {
    const result = discoverCommands({
      taskPlanVerify: "Check that everything works && npm run test",
      cwd: tmp
    });
    assert.equal(result.source, "task-plan");
    assert.deepStrictEqual(result.commands, ["npm run test"]);
  });
  test("taskPlanVerify rejects piped pytest command", () => {
    const result = discoverCommands({
      taskPlanVerify: "python3 -m pytest tests/ -q --tb=short 2>&1 | tail -5",
      cwd: tmp
    });
    assert.equal(result.source, "none");
    assert.deepStrictEqual(result.commands, []);
  });
  test("Python project with tests discovers pytest when package.json is absent", () => {
    mkdirSync(join(tmp, "tests"));
    writeFileSync(join(tmp, "tests", "test_sample.py"), "def test_sample():\n    assert True\n");
    writeFileSync(
      join(tmp, "pyproject.toml"),
      `[project]
name = "sample"

[tool.pytest.ini_options]
pythonpath = ["."]
`
    );
    const result = discoverCommands({ cwd: tmp });
    assert.equal(result.source, "python-project");
    assert.deepStrictEqual(result.commands, ["python3 -m pytest"]);
  });
  test("Python project with nested Python test file discovers pytest", () => {
    mkdirSync(join(tmp, "tests", "unit"), { recursive: true });
    writeFileSync(join(tmp, "tests", "unit", "sample_test.py"), "def test_sample():\n    assert True\n");
    const result = discoverCommands({ cwd: tmp });
    assert.equal(result.source, "python-project");
    assert.deepStrictEqual(result.commands, ["python3 -m pytest"]);
  });
  test("Python project with pytest.ini discovers pytest", () => {
    writeFileSync(join(tmp, "pytest.ini"), "[pytest]\npythonpath = .\n");
    const result = discoverCommands({ cwd: tmp });
    assert.equal(result.source, "python-project");
    assert.deepStrictEqual(result.commands, ["python3 -m pytest"]);
  });
  test("Python project with explicit pyproject pytest marker discovers pytest", () => {
    writeFileSync(
      join(tmp, "pyproject.toml"),
      `[tool.pytest]
pythonpath = ["."]
`
    );
    const result = discoverCommands({ cwd: tmp });
    assert.equal(result.source, "python-project");
    assert.deepStrictEqual(result.commands, ["python3 -m pytest"]);
  });
  test("Python project markers without pytest evidence do not discover pytest", () => {
    mkdirSync(join(tmp, "tests"));
    writeFileSync(join(tmp, "tests", "README.md"), "# tests\n");
    writeFileSync(
      join(tmp, "pyproject.toml"),
      `[project]
name = "sample"
dependencies = ["pytest-cov"]
`
    );
    const result = discoverCommands({ cwd: tmp });
    assert.equal(result.source, "none");
    assert.deepStrictEqual(result.commands, []);
  });
  test("Python project with setup.cfg alone does not discover pytest", () => {
    writeFileSync(join(tmp, "setup.cfg"), "[tool:pytest]\npythonpath = .\n");
    const result = discoverCommands({ cwd: tmp });
    assert.equal(result.source, "none");
    assert.deepStrictEqual(result.commands, []);
  });
  test("Python project with tox.ini alone does not discover pytest", () => {
    writeFileSync(join(tmp, "tox.ini"), "[pytest]\npythonpath = .\n");
    const result = discoverCommands({ cwd: tmp });
    assert.equal(result.source, "none");
    assert.deepStrictEqual(result.commands, []);
  });
});
describe("verification-gate: execution", () => {
  let tmp;
  beforeEach(() => {
    tmp = makeTempDir("vg-exec");
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
  test("all commands pass \u2192 gate passes", () => {
    const result = runVerificationGate({
      cwd: tmp,
      preferenceCommands: ["echo hello", "echo world"]
    });
    assert.equal(result.passed, true);
    assert.equal(result.checks.length, 2);
    assert.equal(result.discoverySource, "preference");
    assert.equal(result.checks[0].exitCode, 0);
    assert.equal(result.checks[1].exitCode, 0);
    assert.ok(result.checks[0].stdout.includes("hello"));
    assert.ok(result.checks[1].stdout.includes("world"));
    assert.equal(typeof result.timestamp, "number");
  });
  test("one command fails \u2192 gate fails with exit code + stderr", () => {
    const result = runVerificationGate({
      cwd: tmp,
      preferenceCommands: ["echo ok", "sh -c 'echo err >&2; exit 1'"]
    });
    assert.equal(result.passed, false);
    assert.equal(result.checks.length, 2);
    assert.equal(result.checks[0].exitCode, 0);
    assert.equal(result.checks[1].exitCode, 1);
    assert.ok(result.checks[1].stderr.includes("err"));
  });
  test("no commands discovered \u2192 gate passes with 0 checks", () => {
    const result = runVerificationGate({
      cwd: tmp
    });
    assert.equal(result.passed, true);
    assert.equal(result.checks.length, 0);
    assert.equal(result.discoverySource, "none");
  });
  test("command not found \u2192 exit code 127", () => {
    const result = runVerificationGate({
      cwd: tmp,
      preferenceCommands: ["__nonexistent_command_xyz_42__"]
    });
    assert.equal(result.passed, false);
    assert.equal(result.checks.length, 1);
    assert.ok(result.checks[0].exitCode !== 0, "should have non-zero exit code");
    assert.ok(result.checks[0].durationMs >= 0);
  });
  test("no DEP0190 deprecation warning when running commands", () => {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const gatePath = join(thisDir, "..", "verification-gate.ts");
    const resolverPath = join(thisDir, "resolve-ts.mjs");
    const script = [
      `import { runVerificationGate } from ${JSON.stringify(pathToFileURL(gatePath).href)};`,
      `runVerificationGate({`,
      `  cwd: ${JSON.stringify(tmp)},`,
      `  preferenceCommands: ["echo dep0190-check"],`,
      `});`
    ].join("\n");
    const child = spawnSync(
      process.execPath,
      [
        "--throw-deprecation",
        "--experimental-strip-types",
        "--import",
        pathToFileURL(resolverPath).href,
        "--input-type=module",
        "-e",
        script
      ],
      { encoding: "utf-8", timeout: 15e3 }
    );
    assert.equal(
      child.status,
      0,
      `Expected exit 0 (no deprecation) but got ${child.status}. stderr: ${child.stderr}`
    );
  });
  test("each check has durationMs", () => {
    const result = runVerificationGate({
      cwd: tmp,
      preferenceCommands: ["echo fast"]
    });
    assert.equal(result.checks.length, 1);
    assert.equal(typeof result.checks[0].durationMs, "number");
    assert.ok(result.checks[0].durationMs >= 0);
  });
  test("one command fails \u2014 remaining commands still run (non-short-circuit)", () => {
    const result = runVerificationGate({
      cwd: tmp,
      preferenceCommands: [
        "sh -c 'exit 1'",
        "echo second",
        "echo third"
      ]
    });
    assert.equal(result.passed, false);
    assert.equal(result.checks.length, 3, "all 3 commands should run");
    assert.equal(result.checks[0].exitCode, 1, "first command fails");
    assert.equal(result.checks[1].exitCode, 0, "second command runs and passes");
    assert.ok(result.checks[1].stdout.includes("second"));
    assert.equal(result.checks[2].exitCode, 0, "third command runs and passes");
    assert.ok(result.checks[2].stdout.includes("third"));
  });
  test("gate execution uses cwd for spawnSync", () => {
    const result = runVerificationGate({
      cwd: tmp,
      preferenceCommands: ["pwd"]
    });
    assert.equal(result.passed, true);
    assert.equal(result.checks.length, 1);
    assert.ok(result.checks[0].stdout.trim().length > 0, "pwd should produce output");
  });
});
test("verification-gate: validatePreferences accepts valid verification keys", () => {
  const result = validatePreferences({
    verification_commands: ["npm run lint", "npm run test"],
    verification_auto_fix: true,
    verification_max_retries: 3
  });
  assert.deepStrictEqual(result.preferences.verification_commands, [
    "npm run lint",
    "npm run test"
  ]);
  assert.equal(result.preferences.verification_auto_fix, true);
  assert.equal(result.preferences.verification_max_retries, 3);
  assert.equal(result.errors.length, 0);
});
test("verification-gate: validatePreferences rejects non-array verification_commands", () => {
  const result = validatePreferences({
    verification_commands: "npm run lint"
  });
  assert.ok(result.errors.some((e) => e.includes("verification_commands")));
  assert.equal(result.preferences.verification_commands, void 0);
});
test("verification-gate: validatePreferences rejects non-boolean verification_auto_fix", () => {
  const result = validatePreferences({
    verification_auto_fix: "yes"
  });
  assert.ok(result.errors.some((e) => e.includes("verification_auto_fix")));
  assert.equal(result.preferences.verification_auto_fix, void 0);
});
test("verification-gate: validatePreferences rejects negative verification_max_retries", () => {
  const result = validatePreferences({
    verification_max_retries: -1
  });
  assert.ok(result.errors.some((e) => e.includes("verification_max_retries")));
  assert.equal(result.preferences.verification_max_retries, void 0);
});
test("verification-gate: validatePreferences rejects non-string items in verification_commands", () => {
  const result = validatePreferences({
    verification_commands: ["npm run lint", 42]
  });
  assert.ok(result.errors.some((e) => e.includes("verification_commands")));
  assert.equal(result.preferences.verification_commands, void 0);
});
test("verification-gate: validatePreferences floors verification_max_retries", () => {
  const result = validatePreferences({
    verification_max_retries: 2.7
  });
  assert.equal(result.preferences.verification_max_retries, 2);
  assert.equal(result.errors.length, 0);
});
test("isLikelyCommand: known command prefixes are accepted", () => {
  assert.equal(isLikelyCommand("npm run lint"), true);
  assert.equal(isLikelyCommand("npx vitest"), true);
  assert.equal(isLikelyCommand("yarn test"), true);
  assert.equal(isLikelyCommand("pnpm run typecheck"), true);
  assert.equal(isLikelyCommand("node script.js"), true);
  assert.equal(isLikelyCommand("tsc --noEmit"), true);
  assert.equal(isLikelyCommand("eslint ."), true);
  assert.equal(isLikelyCommand("jest --ci"), true);
  assert.equal(isLikelyCommand("python3 -m pytest"), true);
  assert.equal(isLikelyCommand("cargo test"), true);
  assert.equal(isLikelyCommand("go test ./..."), true);
  assert.equal(isLikelyCommand("make test"), true);
});
test("isLikelyCommand: path-like first tokens are accepted", () => {
  assert.equal(isLikelyCommand("./scripts/verify.sh"), true);
  assert.equal(isLikelyCommand("/usr/local/bin/check"), true);
  assert.equal(isLikelyCommand("../tools/lint.sh"), true);
});
test("isLikelyCommand: flag-like tokens indicate a command", () => {
  assert.equal(isLikelyCommand("custom-tool --check"), true);
  assert.equal(isLikelyCommand("mycheck -v"), true);
});
test("isLikelyCommand: prose descriptions are rejected", () => {
  assert.equal(
    isLikelyCommand("Document exists, contains all 5 scale names, all 14 semantic tokens, Inter assessment, philosophy and competitive citations present"),
    false
  );
  assert.equal(isLikelyCommand("Check that the file has been created with the correct content"), false);
  assert.equal(isLikelyCommand("Verify the output matches expected format"), false);
  assert.equal(isLikelyCommand("All tests pass and coverage is above 80%"), false);
  assert.equal(isLikelyCommand("File should exist in the output directory"), false);
  assert.equal(isLikelyCommand("Build succeeds without errors or warnings"), false);
});
test("isLikelyCommand: non-ASCII prose descriptions are rejected", () => {
  assert.equal(isLikelyCommand("\u6240\u6709 \u547D\u4EE4 \u8F93\u51FA \u4E00\u884C JSONL go test ./... \u901A\u8FC7"), false);
});
test("isLikelyCommand: empty or whitespace-only strings are rejected", () => {
  assert.equal(isLikelyCommand(""), false);
  assert.equal(isLikelyCommand("   "), false);
});
test("isLikelyCommand: short lowercase tokens without flags are accepted (could be custom scripts)", () => {
  assert.equal(isLikelyCommand("custom-verify"), true);
  assert.equal(isLikelyCommand("mycheck"), true);
});
test("validateVerificationCommand rejects shell control syntax", () => {
  assert.deepEqual(validateVerificationCommand("python3 -m pytest tests/ -q --tb=short").ok, true);
  const result = validateVerificationCommand("python3 -m pytest tests/ -q --tb=short 2>&1 | tail -5");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /shell control syntax/);
  }
});
test("verification-gate: verification_commands produces no unknown-key warnings", () => {
  const result = validatePreferences({
    verification_commands: ["npm test"]
  });
  const unknownWarnings = (result.warnings ?? []).filter((w) => w.includes("unknown"));
  assert.equal(unknownWarnings.length, 0, "verification_commands is a known key");
  assert.equal(result.errors.length, 0);
});
test("verification-gate: verification_auto_fix produces no unknown-key warnings", () => {
  const result = validatePreferences({
    verification_auto_fix: true
  });
  const unknownWarnings = (result.warnings ?? []).filter((w) => w.includes("unknown"));
  assert.equal(unknownWarnings.length, 0, "verification_auto_fix is a known key");
  assert.equal(result.errors.length, 0);
});
test("verification-gate: verification_max_retries produces no unknown-key warnings", () => {
  const result = validatePreferences({
    verification_max_retries: 2
  });
  const unknownWarnings = (result.warnings ?? []).filter((w) => w.includes("unknown"));
  assert.equal(unknownWarnings.length, 0, "verification_max_retries is a known key");
  assert.equal(result.errors.length, 0);
});
test("verification-gate: verification_max_retries -1 produces a validation error", () => {
  const result = validatePreferences({
    verification_max_retries: -1
  });
  assert.ok(
    result.errors.some((e) => e.includes("verification_max_retries")),
    "negative max_retries should error"
  );
  assert.equal(result.preferences.verification_max_retries, void 0);
});
test("formatFailureContext: formats a single failure with command, exit code, stderr", () => {
  const result = {
    passed: false,
    checks: [
      { command: "npm run lint", exitCode: 1, stdout: "", stderr: "error: unused var", durationMs: 500 }
    ],
    discoverySource: "preference",
    timestamp: Date.now()
  };
  const output = formatFailureContext(result);
  assert.ok(output.startsWith("## Verification Failures"), "should start with header");
  assert.ok(output.includes("`npm run lint`"), "should include command name");
  assert.ok(output.includes("exit code 1"), "should include exit code");
  assert.ok(output.includes("error: unused var"), "should include stderr content");
  assert.ok(output.includes("```stderr"), "should have stderr code block");
});
test("formatFailureContext: formats multiple failures", () => {
  const result = {
    passed: false,
    checks: [
      { command: "npm run lint", exitCode: 1, stdout: "", stderr: "lint error", durationMs: 100 },
      { command: "npm run test", exitCode: 2, stdout: "", stderr: "test failure", durationMs: 200 },
      { command: "npm run typecheck", exitCode: 0, stdout: "ok", stderr: "", durationMs: 50 }
    ],
    discoverySource: "preference",
    timestamp: Date.now()
  };
  const output = formatFailureContext(result);
  assert.ok(output.includes("`npm run lint`"), "should include first failed command");
  assert.ok(output.includes("exit code 1"), "should include first exit code");
  assert.ok(output.includes("`npm run test`"), "should include second failed command");
  assert.ok(output.includes("exit code 2"), "should include second exit code");
  assert.ok(!output.includes("npm run typecheck"), "should not include passing command");
});
test("formatFailureContext: truncates stderr longer than 2000 chars", () => {
  const longStderr = "x".repeat(3e3);
  const result = {
    passed: false,
    checks: [
      { command: "big-err", exitCode: 1, stdout: "", stderr: longStderr, durationMs: 100 }
    ],
    discoverySource: "preference",
    timestamp: Date.now()
  };
  const output = formatFailureContext(result);
  assert.ok(!output.includes("x".repeat(2001)), "should not contain more than 2000 chars of stderr");
  assert.ok(output.includes("\u2026[truncated]"), "should include truncation marker");
});
test("formatFailureContext: returns empty string when all checks pass", () => {
  const result = {
    passed: true,
    checks: [
      { command: "npm run lint", exitCode: 0, stdout: "ok", stderr: "", durationMs: 100 },
      { command: "npm run test", exitCode: 0, stdout: "ok", stderr: "", durationMs: 200 }
    ],
    discoverySource: "preference",
    timestamp: Date.now()
  };
  assert.equal(formatFailureContext(result), "");
});
test("formatFailureContext: returns empty string for empty checks array", () => {
  const result = {
    passed: true,
    checks: [],
    discoverySource: "none",
    timestamp: Date.now()
  };
  assert.equal(formatFailureContext(result), "");
});
test("formatFailureContext: caps total output at 10,000 chars", () => {
  const checks = [];
  for (let i = 0; i < 20; i++) {
    checks.push({
      command: `failing-command-${i}`,
      exitCode: 1,
      stdout: "",
      stderr: "e".repeat(1e3),
      // 1000 chars each, 20 * ~1050 (with formatting) > 10,000
      durationMs: 100
    });
  }
  const result = {
    passed: false,
    checks,
    discoverySource: "preference",
    timestamp: Date.now()
  };
  const output = formatFailureContext(result);
  assert.ok(output.length <= 10100, `total output should be capped near 10,000 chars, got ${output.length}`);
  assert.ok(output.includes("\u2026[remaining failures truncated]"), "should include total truncation marker");
});
function makeProc(overrides) {
  return {
    id: "p1",
    label: "test-server",
    status: "ready",
    alive: true,
    exitCode: null,
    signal: null,
    recentErrors: [],
    ...overrides
  };
}
function makeLogs(entries) {
  return entries.map((e, i) => ({
    type: e.type,
    text: e.text,
    timestamp: Date.now() + i,
    url: "http://localhost:3000"
  }));
}
test("captureRuntimeErrors: crashed bg-shell process \u2192 blocking crash error", async () => {
  const processes = /* @__PURE__ */ new Map([
    ["p1", makeProc({ status: "crashed", alive: false, exitCode: 1 })]
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => processes,
    getConsoleLogs: () => []
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].source, "bg-shell");
  assert.equal(result[0].severity, "crash");
  assert.equal(result[0].blocking, true);
  assert.ok(result[0].message.includes("test-server"));
});
test("captureRuntimeErrors: bg-shell non-zero exit + not alive \u2192 blocking crash error", async () => {
  const processes = /* @__PURE__ */ new Map([
    ["p1", makeProc({ status: "exited", alive: false, exitCode: 137 })]
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => processes,
    getConsoleLogs: () => []
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].severity, "crash");
  assert.equal(result[0].blocking, true);
  assert.ok(result[0].message.includes("exitCode=137"));
});
test("captureRuntimeErrors: bg-shell SIGABRT/SIGSEGV/SIGBUS \u2192 blocking crash error", async () => {
  for (const sig of ["SIGABRT", "SIGSEGV", "SIGBUS"]) {
    const processes = /* @__PURE__ */ new Map([
      ["p1", makeProc({ signal: sig, alive: false, exitCode: null })]
    ]);
    const result = await captureRuntimeErrors({
      getProcesses: () => processes,
      getConsoleLogs: () => []
    });
    assert.equal(result.length, 1, `${sig} should produce 1 error`);
    assert.equal(result[0].severity, "crash");
    assert.equal(result[0].blocking, true);
    assert.ok(result[0].message.includes(sig), `message should contain ${sig}`);
  }
});
test("captureRuntimeErrors: alive bg-shell process with recentErrors \u2192 non-blocking error", async () => {
  const processes = /* @__PURE__ */ new Map([
    ["p1", makeProc({ alive: true, recentErrors: ["TypeError: foo", "RangeError: bar"] })]
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => processes,
    getConsoleLogs: () => []
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].source, "bg-shell");
  assert.equal(result[0].severity, "error");
  assert.equal(result[0].blocking, false);
  assert.ok(result[0].message.includes("TypeError: foo"));
  assert.ok(result[0].message.includes("RangeError: bar"));
});
test("captureRuntimeErrors: browser unhandled rejection \u2192 blocking crash error", async () => {
  const logs = makeLogs([
    { type: "error", text: "Unhandled promise rejection: some error" }
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => /* @__PURE__ */ new Map(),
    getConsoleLogs: () => logs
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].source, "browser");
  assert.equal(result[0].severity, "crash");
  assert.equal(result[0].blocking, true);
  assert.ok(result[0].message.includes("Unhandled"));
});
test("captureRuntimeErrors: browser UnhandledRejection (case variation) \u2192 blocking crash", async () => {
  const logs = makeLogs([
    { type: "error", text: "UnhandledRejection in module X" }
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => /* @__PURE__ */ new Map(),
    getConsoleLogs: () => logs
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].severity, "crash");
  assert.equal(result[0].blocking, true);
});
test("captureRuntimeErrors: browser console.error (general) \u2192 non-blocking error", async () => {
  const logs = makeLogs([
    { type: "error", text: "Failed to load resource: net::ERR_FAILED" }
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => /* @__PURE__ */ new Map(),
    getConsoleLogs: () => logs
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].source, "browser");
  assert.equal(result[0].severity, "error");
  assert.equal(result[0].blocking, false);
});
test("captureRuntimeErrors: browser deprecation warning \u2192 non-blocking warning", async () => {
  const logs = makeLogs([
    { type: "warning", text: "Event.returnValue is deprecated. Use Event.preventDefault() instead." }
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => /* @__PURE__ */ new Map(),
    getConsoleLogs: () => logs
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].source, "browser");
  assert.equal(result[0].severity, "warning");
  assert.equal(result[0].blocking, false);
  assert.ok(result[0].message.includes("deprecated"));
});
test("captureRuntimeErrors: non-deprecation warning is ignored", async () => {
  const logs = makeLogs([
    { type: "warning", text: "Some general warning about performance" }
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => /* @__PURE__ */ new Map(),
    getConsoleLogs: () => logs
  });
  assert.equal(result.length, 0, "non-deprecation warnings should be ignored");
});
test("captureRuntimeErrors: no processes, no browser logs \u2192 empty array", async () => {
  const result = await captureRuntimeErrors({
    getProcesses: () => /* @__PURE__ */ new Map(),
    getConsoleLogs: () => []
  });
  assert.deepStrictEqual(result, []);
});
test("captureRuntimeErrors: dynamic import failure \u2192 graceful empty array", async () => {
  const result = await captureRuntimeErrors({
    getProcesses: () => {
      throw new Error("module not found");
    },
    getConsoleLogs: () => {
      throw new Error("module not found");
    }
  });
  assert.deepStrictEqual(result, []);
});
test("captureRuntimeErrors: browser text truncated to 500 chars", async () => {
  const longText = "x".repeat(600);
  const logs = makeLogs([
    { type: "error", text: longText }
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => /* @__PURE__ */ new Map(),
    getConsoleLogs: () => logs
  });
  assert.equal(result.length, 1);
  assert.ok(result[0].message.length <= 500 + 20, "message should be truncated near 500 chars");
  assert.ok(result[0].message.includes("\u2026[truncated]"), "should include truncation marker");
  assert.ok(!result[0].message.includes("x".repeat(501)), "should not contain 501+ x's");
});
test("captureRuntimeErrors: bg-shell recentErrors limited to 3 in message", async () => {
  const processes = /* @__PURE__ */ new Map([
    ["p1", makeProc({
      status: "crashed",
      alive: false,
      exitCode: 1,
      recentErrors: ["err1", "err2", "err3", "err4", "err5"]
    })]
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => processes,
    getConsoleLogs: () => []
  });
  assert.equal(result.length, 1);
  assert.ok(result[0].message.includes("err1"));
  assert.ok(result[0].message.includes("err2"));
  assert.ok(result[0].message.includes("err3"));
  assert.ok(!result[0].message.includes("err4"), "should only include first 3 errors");
});
test("captureRuntimeErrors: mixed bg-shell and browser errors", async () => {
  const processes = /* @__PURE__ */ new Map([
    ["p1", makeProc({ status: "crashed", alive: false, exitCode: 1 })]
  ]);
  const logs = makeLogs([
    { type: "error", text: "Unhandled rejection: boom" },
    { type: "error", text: "general error" },
    { type: "warning", text: "deprecated API used" }
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => processes,
    getConsoleLogs: () => logs
  });
  assert.equal(result.length, 4);
  const blocking = result.filter((r) => r.blocking);
  const nonBlocking = result.filter((r) => !r.blocking);
  assert.equal(blocking.length, 2, "should have 2 blocking errors");
  assert.equal(nonBlocking.length, 2, "should have 2 non-blocking errors");
});
function makeAuditJson(vulns) {
  return JSON.stringify({ vulnerabilities: vulns });
}
const SAMPLE_AUDIT_JSON = makeAuditJson({
  "nth-check": {
    severity: "high",
    fixAvailable: true,
    via: [
      {
        title: "Inefficient Regular Expression Complexity in nth-check",
        url: "https://github.com/advisories/GHSA-rp65-9cf3-cjxr",
        severity: "high"
      }
    ]
  }
});
test("dependency-audit: package.json in git diff \u2192 runs npm audit and parses vulnerabilities", () => {
  let npmAuditCalled = false;
  const result = runDependencyAudit("/tmp/test", {
    gitDiff: () => ["package.json", "src/index.ts"],
    npmAudit: () => {
      npmAuditCalled = true;
      return { stdout: SAMPLE_AUDIT_JSON, exitCode: 0 };
    }
  });
  assert.equal(npmAuditCalled, true, "npm audit should be called");
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "nth-check");
  assert.equal(result[0].severity, "high");
  assert.equal(result[0].title, "Inefficient Regular Expression Complexity in nth-check");
  assert.equal(result[0].url, "https://github.com/advisories/GHSA-rp65-9cf3-cjxr");
  assert.equal(result[0].fixAvailable, true);
});
test("dependency-audit: package-lock.json change triggers audit", () => {
  let npmAuditCalled = false;
  const result = runDependencyAudit("/tmp/test", {
    gitDiff: () => ["package-lock.json"],
    npmAudit: () => {
      npmAuditCalled = true;
      return { stdout: SAMPLE_AUDIT_JSON, exitCode: 0 };
    }
  });
  assert.equal(npmAuditCalled, true);
  assert.equal(result.length, 1);
});
test("dependency-audit: pnpm-lock.yaml change triggers audit", () => {
  let npmAuditCalled = false;
  runDependencyAudit("/tmp/test", {
    gitDiff: () => ["pnpm-lock.yaml"],
    npmAudit: () => {
      npmAuditCalled = true;
      return { stdout: SAMPLE_AUDIT_JSON, exitCode: 0 };
    }
  });
  assert.equal(npmAuditCalled, true);
});
test("dependency-audit: yarn.lock change triggers audit", () => {
  let npmAuditCalled = false;
  runDependencyAudit("/tmp/test", {
    gitDiff: () => ["yarn.lock"],
    npmAudit: () => {
      npmAuditCalled = true;
      return { stdout: SAMPLE_AUDIT_JSON, exitCode: 0 };
    }
  });
  assert.equal(npmAuditCalled, true);
});
test("dependency-audit: bun.lockb change triggers audit", () => {
  let npmAuditCalled = false;
  runDependencyAudit("/tmp/test", {
    gitDiff: () => ["bun.lockb"],
    npmAudit: () => {
      npmAuditCalled = true;
      return { stdout: SAMPLE_AUDIT_JSON, exitCode: 0 };
    }
  });
  assert.equal(npmAuditCalled, true);
});
test("dependency-audit: no dependency file changes \u2192 returns empty array, npm audit not called", () => {
  let npmAuditCalled = false;
  const result = runDependencyAudit("/tmp/test", {
    gitDiff: () => ["src/index.ts", "README.md"],
    npmAudit: () => {
      npmAuditCalled = true;
      return { stdout: "{}", exitCode: 0 };
    }
  });
  assert.equal(npmAuditCalled, false, "npm audit should NOT be called when no dependency files changed");
  assert.deepStrictEqual(result, []);
});
test("dependency-audit: git diff returns non-zero exit (not a git repo) \u2192 empty array", () => {
  const result = runDependencyAudit("/tmp/test", {
    gitDiff: () => {
      throw new Error("not a git repo");
    },
    npmAudit: () => {
      throw new Error("should not be called");
    }
  });
  assert.deepStrictEqual(result, []);
});
test("dependency-audit: npm audit returns invalid JSON \u2192 empty array", () => {
  const result = runDependencyAudit("/tmp/test", {
    gitDiff: () => ["package.json"],
    npmAudit: () => ({ stdout: "not json at all", exitCode: 1 })
  });
  assert.deepStrictEqual(result, []);
});
test("dependency-audit: npm audit returns zero vulnerabilities \u2192 empty array", () => {
  const result = runDependencyAudit("/tmp/test", {
    gitDiff: () => ["package.json"],
    npmAudit: () => ({
      stdout: JSON.stringify({ vulnerabilities: {} }),
      exitCode: 0
    })
  });
  assert.deepStrictEqual(result, []);
});
test("dependency-audit: npm audit non-zero exit with valid JSON \u2192 parses correctly", () => {
  const result = runDependencyAudit("/tmp/test", {
    gitDiff: () => ["package-lock.json"],
    npmAudit: () => ({
      stdout: SAMPLE_AUDIT_JSON,
      exitCode: 1
      // non-zero!
    })
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "nth-check");
  assert.equal(result[0].severity, "high");
});
test("dependency-audit: via entries with string-only values are skipped", () => {
  const auditJson = makeAuditJson({
    "postcss": {
      severity: "moderate",
      fixAvailable: false,
      via: ["nth-check", "css-select"]
      // string-only via entries
    }
  });
  const result = runDependencyAudit("/tmp/test", {
    gitDiff: () => ["package.json"],
    npmAudit: () => ({ stdout: auditJson, exitCode: 1 })
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "postcss");
  assert.equal(result[0].title, "postcss");
  assert.equal(result[0].url, "");
});
test("dependency-audit: subdirectory package.json does not trigger audit", () => {
  let npmAuditCalled = false;
  const result = runDependencyAudit("/tmp/test", {
    gitDiff: () => ["packages/foo/package.json", "libs/bar/package-lock.json"],
    npmAudit: () => {
      npmAuditCalled = true;
      return { stdout: SAMPLE_AUDIT_JSON, exitCode: 0 };
    }
  });
  assert.equal(npmAuditCalled, false, "subdirectory dependency files should not trigger audit");
  assert.deepStrictEqual(result, []);
});
describe("verification-gate: python normalization (#4416)", () => {
  let tmp;
  beforeEach(() => {
    tmp = makeTempDir("vg-python");
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
  test("python3 --version command succeeds on this host (gate uses normalized invocation)", () => {
    const result = runVerificationGate({
      cwd: tmp,
      preferenceCommands: ["python3 --version"]
    });
    assert.equal(typeof result.passed, "boolean");
    assert.equal(result.checks.length, 1);
    assert.ok(result.checks[0].durationMs >= 0);
  });
  test("python --version command produces a VerificationResult (not a crash)", () => {
    const result = runVerificationGate({
      cwd: tmp,
      preferenceCommands: ["python --version"]
    });
    assert.equal(typeof result.passed, "boolean");
    assert.equal(result.checks.length, 1);
    assert.ok(result.checks[0].durationMs >= 0);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy92ZXJpZmljYXRpb24tZ2F0ZS50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFVuaXQgdGVzdHMgZm9yIHRoZSB2ZXJpZmljYXRpb24gZ2F0ZSBcdTIwMTQgY29tbWFuZCBkaXNjb3ZlcnkgYW5kIGV4ZWN1dGlvbi5cbiAqXG4gKiBUZXN0cyBjb3ZlcjpcbiAqICAgMS4gRGlzY292ZXJ5IGZyb20gZXhwbGljaXQgcHJlZmVyZW5jZSBjb21tYW5kc1xuICogICAyLiBEaXNjb3ZlcnkgZnJvbSB0YXNrIHBsYW4gdmVyaWZ5IGZpZWxkXG4gKiAgIDMuIERpc2NvdmVyeSBmcm9tIHBhY2thZ2UuanNvbiB0eXBlY2hlY2svbGludC90ZXN0IHNjcmlwdHNcbiAqICAgNC4gRmlyc3Qtbm9uLWVtcHR5LXdpbnMgcHJlY2VkZW5jZVxuICogICA1LiBBbGwgY29tbWFuZHMgcGFzcyBcdTIxOTIgZ2F0ZSBwYXNzZXNcbiAqICAgNi4gT25lIGNvbW1hbmQgZmFpbHMgXHUyMTkyIGdhdGUgZmFpbHMgd2l0aCBleGl0IGNvZGUgKyBzdGRlcnJcbiAqICAgNy4gTWlzc2luZyBwYWNrYWdlLmpzb24gXHUyMTkyIDAgY2hlY2tzIFx1MjE5MiBwYXNzXG4gKiAgIDguIEVtcHR5IHNjcmlwdHMgXHUyMTkyIDAgY2hlY2tzIFx1MjE5MiBwYXNzXG4gKiAgIDkuIFByZWZlcmVuY2UgdmFsaWRhdGlvbiBmb3IgdmVyaWZpY2F0aW9uIGtleXNcbiAqICAxMC4gc3Bhd25TeW5jIGVycm9yIChjb21tYW5kIG5vdCBmb3VuZCkgXHUyMTkyIGZhaWx1cmUgd2l0aCBleGl0IGNvZGUgMTI3XG4gKiAgMTEuIERlcGVuZGVuY3kgYXVkaXQgXHUyMDE0IGdpdCBkaWZmIGRldGVjdGlvbiwgbnBtIGF1ZGl0IHBhcnNpbmcsIGdyYWNlZnVsIGZhaWx1cmVzXG4gKi9cblxuaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QsIGJlZm9yZUVhY2gsIGFmdGVyRWFjaCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkaXJTeW5jLCB3cml0ZUZpbGVTeW5jLCBybVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiwgZGlybmFtZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBzcGF3blN5bmMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgeyBmaWxlVVJMVG9QYXRoLCBwYXRoVG9GaWxlVVJMIH0gZnJvbSBcIm5vZGU6dXJsXCI7XG5pbXBvcnQgeyBkaXNjb3ZlckNvbW1hbmRzLCBydW5WZXJpZmljYXRpb25HYXRlLCBmb3JtYXRGYWlsdXJlQ29udGV4dCwgY2FwdHVyZVJ1bnRpbWVFcnJvcnMsIHJ1bkRlcGVuZGVuY3lBdWRpdCwgaXNMaWtlbHlDb21tYW5kLCB2YWxpZGF0ZVZlcmlmaWNhdGlvbkNvbW1hbmQgfSBmcm9tIFwiLi4vdmVyaWZpY2F0aW9uLWdhdGUudHNcIjtcbmltcG9ydCB0eXBlIHsgQ2FwdHVyZVJ1bnRpbWVFcnJvcnNPcHRpb25zLCBEZXBlbmRlbmN5QXVkaXRPcHRpb25zIH0gZnJvbSBcIi4uL3ZlcmlmaWNhdGlvbi1nYXRlLnRzXCI7XG5pbXBvcnQgeyB2YWxpZGF0ZVByZWZlcmVuY2VzIH0gZnJvbSBcIi4uL3ByZWZlcmVuY2VzLnRzXCI7XG5cbmZ1bmN0aW9uIG1ha2VUZW1wRGlyKHByZWZpeDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgZGlyID0gam9pbihcbiAgICB0bXBkaXIoKSxcbiAgICBgJHtwcmVmaXh9LSR7RGF0ZS5ub3coKX0tJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyKX1gLFxuICApO1xuICBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgcmV0dXJuIGRpcjtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIERpc2NvdmVyeSBUZXN0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJ2ZXJpZmljYXRpb24tZ2F0ZTogZGlzY292ZXJ5XCIsICgpID0+IHtcbiAgbGV0IHRtcDogc3RyaW5nO1xuICBiZWZvcmVFYWNoKCgpID0+IHsgdG1wID0gbWFrZVRlbXBEaXIoXCJ2Zy1kaXNjb3ZlcnlcIik7IH0pO1xuICBhZnRlckVhY2goKCkgPT4geyBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0pO1xuXG4gIHRlc3QoXCJkaXNjb3ZlckNvbW1hbmRzIGZyb20gcHJlZmVyZW5jZSBjb21tYW5kc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gZGlzY292ZXJDb21tYW5kcyh7XG4gICAgICBwcmVmZXJlbmNlQ29tbWFuZHM6IFtcIm5wbSBydW4gbGludFwiLCBcIm5wbSBydW4gdGVzdFwiXSxcbiAgICAgIGN3ZDogdG1wLFxuICAgIH0pO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0LmNvbW1hbmRzLCBbXCJucG0gcnVuIGxpbnRcIiwgXCJucG0gcnVuIHRlc3RcIl0pO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc291cmNlLCBcInByZWZlcmVuY2VcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJkaXNjb3ZlckNvbW1hbmRzIGZyb20gdGFzayBwbGFuIHZlcmlmeSBmaWVsZFwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gZGlzY292ZXJDb21tYW5kcyh7XG4gICAgICB0YXNrUGxhblZlcmlmeTogXCJucG0gcnVuIGxpbnQgJiYgbnBtIHJ1biB0ZXN0XCIsXG4gICAgICBjd2Q6IHRtcCxcbiAgICB9KTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5jb21tYW5kcywgW1wibnBtIHJ1biBsaW50XCIsIFwibnBtIHJ1biB0ZXN0XCJdKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnNvdXJjZSwgXCJ0YXNrLXBsYW5cIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJkaXNjb3ZlckNvbW1hbmRzIGZyb20gcGFja2FnZS5qc29uIHNjcmlwdHNcIiwgKCkgPT4ge1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKHRtcCwgXCJwYWNrYWdlLmpzb25cIiksXG4gICAgICBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIHNjcmlwdHM6IHtcbiAgICAgICAgICB0eXBlY2hlY2s6IFwidHNjIC0tbm9FbWl0XCIsXG4gICAgICAgICAgbGludDogXCJlc2xpbnQgLlwiLFxuICAgICAgICAgIHRlc3Q6IFwidml0ZXN0XCIsXG4gICAgICAgICAgYnVpbGQ6IFwidHNjXCIsIC8vIHNob3VsZCBOT1QgYmUgaW5jbHVkZWRcbiAgICAgICAgfSxcbiAgICAgIH0pLFxuICAgICk7XG4gICAgY29uc3QgcmVzdWx0ID0gZGlzY292ZXJDb21tYW5kcyh7IGN3ZDogdG1wIH0pO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0LmNvbW1hbmRzLCBbXG4gICAgICBcIm5wbSBydW4gdHlwZWNoZWNrXCIsXG4gICAgICBcIm5wbSBydW4gbGludFwiLFxuICAgICAgXCJucG0gcnVuIHRlc3RcIixcbiAgICBdKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnNvdXJjZSwgXCJwYWNrYWdlLWpzb25cIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJmaXJzdC1ub24tZW1wdHktd2lucyBcdTIwMTQgcHJlZmVyZW5jZSBiZWF0cyB0YXNrIHBsYW4gYW5kIHBhY2thZ2UuanNvblwiLCAoKSA9PiB7XG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4odG1wLCBcInBhY2thZ2UuanNvblwiKSxcbiAgICAgIEpTT04uc3RyaW5naWZ5KHsgc2NyaXB0czogeyBsaW50OiBcImVzbGludCAuXCIgfSB9KSxcbiAgICApO1xuICAgIGNvbnN0IHJlc3VsdCA9IGRpc2NvdmVyQ29tbWFuZHMoe1xuICAgICAgcHJlZmVyZW5jZUNvbW1hbmRzOiBbXCJjdXN0b20tY2hlY2tcIl0sXG4gICAgICB0YXNrUGxhblZlcmlmeTogXCJucG0gcnVuIGxpbnRcIixcbiAgICAgIGN3ZDogdG1wLFxuICAgIH0pO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0LmNvbW1hbmRzLCBbXCJjdXN0b20tY2hlY2tcIl0pO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc291cmNlLCBcInByZWZlcmVuY2VcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJ0YXNrIHBsYW4gdmVyaWZ5IGJlYXRzIHBhY2thZ2UuanNvblwiLCAoKSA9PiB7XG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4odG1wLCBcInBhY2thZ2UuanNvblwiKSxcbiAgICAgIEpTT04uc3RyaW5naWZ5KHsgc2NyaXB0czogeyBsaW50OiBcImVzbGludCAuXCIgfSB9KSxcbiAgICApO1xuICAgIGNvbnN0IHJlc3VsdCA9IGRpc2NvdmVyQ29tbWFuZHMoe1xuICAgICAgdGFza1BsYW5WZXJpZnk6IFwiY3VzdG9tLXZlcmlmeVwiLFxuICAgICAgY3dkOiB0bXAsXG4gICAgfSk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQuY29tbWFuZHMsIFtcImN1c3RvbS12ZXJpZnlcIl0pO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc291cmNlLCBcInRhc2stcGxhblwiKTtcbiAgfSk7XG5cbiAgdGVzdChcIm1pc3NpbmcgcGFja2FnZS5qc29uIFx1MjE5MiAwIGNoZWNrcywgc291cmNlIG5vbmVcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGRpc2NvdmVyQ29tbWFuZHMoeyBjd2Q6IHRtcCB9KTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5jb21tYW5kcywgW10pO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc291cmNlLCBcIm5vbmVcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJwYWNrYWdlLmpzb24gd2l0aCBubyBtYXRjaGluZyBzY3JpcHRzIFx1MjE5MiAwIGNoZWNrc1wiLCAoKSA9PiB7XG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4odG1wLCBcInBhY2thZ2UuanNvblwiKSxcbiAgICAgIEpTT04uc3RyaW5naWZ5KHsgc2NyaXB0czogeyBidWlsZDogXCJ0c2NcIiwgc3RhcnQ6IFwibm9kZSBpbmRleC5qc1wiIH0gfSksXG4gICAgKTtcbiAgICBjb25zdCByZXN1bHQgPSBkaXNjb3ZlckNvbW1hbmRzKHsgY3dkOiB0bXAgfSk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQuY29tbWFuZHMsIFtdKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnNvdXJjZSwgXCJub25lXCIpO1xuICB9KTtcblxuICB0ZXN0KFwiZW1wdHkgcHJlZmVyZW5jZSBhcnJheSBmYWxscyB0aHJvdWdoIHRvIHRhc2sgcGxhblwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gZGlzY292ZXJDb21tYW5kcyh7XG4gICAgICBwcmVmZXJlbmNlQ29tbWFuZHM6IFtdLFxuICAgICAgdGFza1BsYW5WZXJpZnk6IFwiZWNobyBva1wiLFxuICAgICAgY3dkOiB0bXAsXG4gICAgfSk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQuY29tbWFuZHMsIFtcImVjaG8gb2tcIl0pO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc291cmNlLCBcInRhc2stcGxhblwiKTtcbiAgfSk7XG5cbiAgdGVzdChcInBhY2thZ2UuanNvbiB3aXRoIG9ubHkgdGVzdCBzY3JpcHQgXHUyMTkyIHJldHVybnMgb25seSBucG0gcnVuIHRlc3RcIiwgKCkgPT4ge1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKHRtcCwgXCJwYWNrYWdlLmpzb25cIiksXG4gICAgICBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIHNjcmlwdHM6IHtcbiAgICAgICAgICB0ZXN0OiBcInZpdGVzdFwiLFxuICAgICAgICAgIGJ1aWxkOiBcInRzY1wiLFxuICAgICAgICAgIHN0YXJ0OiBcIm5vZGUgaW5kZXguanNcIixcbiAgICAgICAgfSxcbiAgICAgIH0pLFxuICAgICk7XG4gICAgY29uc3QgcmVzdWx0ID0gZGlzY292ZXJDb21tYW5kcyh7IGN3ZDogdG1wIH0pO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0LmNvbW1hbmRzLCBbXCJucG0gcnVuIHRlc3RcIl0pO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc291cmNlLCBcInBhY2thZ2UtanNvblwiKTtcbiAgfSk7XG5cbiAgdGVzdChcInRhc2tQbGFuVmVyaWZ5IHdpdGggc2luZ2xlIGNvbW1hbmQgKG5vICYmKVwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gZGlzY292ZXJDb21tYW5kcyh7XG4gICAgICB0YXNrUGxhblZlcmlmeTogXCJucG0gdGVzdFwiLFxuICAgICAgY3dkOiB0bXAsXG4gICAgfSk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQuY29tbWFuZHMsIFtcIm5wbSB0ZXN0XCJdKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnNvdXJjZSwgXCJ0YXNrLXBsYW5cIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJ3aGl0ZXNwYWNlLW9ubHkgcHJlZmVyZW5jZSBjb21tYW5kcyBmYWxsIHRocm91Z2hcIiwgKCkgPT4ge1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKHRtcCwgXCJwYWNrYWdlLmpzb25cIiksXG4gICAgICBKU09OLnN0cmluZ2lmeSh7IHNjcmlwdHM6IHsgbGludDogXCJlc2xpbnQgLlwiIH0gfSksXG4gICAgKTtcbiAgICBjb25zdCByZXN1bHQgPSBkaXNjb3ZlckNvbW1hbmRzKHtcbiAgICAgIHByZWZlcmVuY2VDb21tYW5kczogW1wiICBcIiwgXCJcIl0sXG4gICAgICBjd2Q6IHRtcCxcbiAgICB9KTtcbiAgICAvLyBXaGl0ZXNwYWNlLW9ubHkgc3RyaW5ncyBhcmUgdHJpbW1lZCB0byBlbXB0eSBhbmQgZmlsdGVyZWQgb3V0XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zb3VyY2UsIFwicGFja2FnZS1qc29uXCIpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0LmNvbW1hbmRzLCBbXCJucG0gcnVuIGxpbnRcIl0pO1xuICB9KTtcblxuICB0ZXN0KFwicHJvc2UgdGFza1BsYW5WZXJpZnkgaXMgcmVqZWN0ZWQsIGZhbGxzIHRocm91Z2ggdG8gcGFja2FnZS5qc29uXCIsICgpID0+IHtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbih0bXAsIFwicGFja2FnZS5qc29uXCIpLFxuICAgICAgSlNPTi5zdHJpbmdpZnkoeyBzY3JpcHRzOiB7IHRlc3Q6IFwidml0ZXN0XCIgfSB9KSxcbiAgICApO1xuICAgIGNvbnN0IHJlc3VsdCA9IGRpc2NvdmVyQ29tbWFuZHMoe1xuICAgICAgdGFza1BsYW5WZXJpZnk6IFwiRG9jdW1lbnQgZXhpc3RzLCBjb250YWlucyBhbGwgNSBzY2FsZSBuYW1lcywgYWxsIDE0IHNlbWFudGljIHRva2Vuc1wiLFxuICAgICAgY3dkOiB0bXAsXG4gICAgfSk7XG4gICAgLy8gUHJvc2Ugc2hvdWxkIGJlIHJlamVjdGVkLCBzbyBpdCBmYWxscyB0aHJvdWdoIHRvIHBhY2thZ2UuanNvblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc291cmNlLCBcInBhY2thZ2UtanNvblwiKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5jb21tYW5kcywgW1wibnBtIHJ1biB0ZXN0XCJdKTtcbiAgfSk7XG5cbiAgdGVzdChcInByb3NlIHRhc2tQbGFuVmVyaWZ5IHdpdGggbm8gcGFja2FnZS5qc29uIFx1MjE5MiBzb3VyY2Ugbm9uZVwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gZGlzY292ZXJDb21tYW5kcyh7XG4gICAgICB0YXNrUGxhblZlcmlmeTogXCJWZXJpZnkgdGhlIG91dHB1dCBtYXRjaGVzIGV4cGVjdGVkIGZvcm1hdCBhbmQgYWxsIGZpZWxkcyBhcmUgcHJlc2VudFwiLFxuICAgICAgY3dkOiB0bXAsXG4gICAgfSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zb3VyY2UsIFwibm9uZVwiKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5jb21tYW5kcywgW10pO1xuICB9KTtcblxuICB0ZXN0KFwidmFsaWQgY29tbWFuZCBpbiB0YXNrUGxhblZlcmlmeSBzdGlsbCB3b3Jrc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gZGlzY292ZXJDb21tYW5kcyh7XG4gICAgICB0YXNrUGxhblZlcmlmeTogXCJucG0gcnVuIGxpbnQgJiYgbnBtIHJ1biB0ZXN0XCIsXG4gICAgICBjd2Q6IHRtcCxcbiAgICB9KTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnNvdXJjZSwgXCJ0YXNrLXBsYW5cIik7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQuY29tbWFuZHMsIFtcIm5wbSBydW4gbGludFwiLCBcIm5wbSBydW4gdGVzdFwiXSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJtaXhlZCBwcm9zZSBhbmQgY29tbWFuZHMgaW4gdGFza1BsYW5WZXJpZnkgXHUyMDE0IG9ubHkgY29tbWFuZHMga2VwdFwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gZGlzY292ZXJDb21tYW5kcyh7XG4gICAgICB0YXNrUGxhblZlcmlmeTogXCJDaGVjayB0aGF0IGV2ZXJ5dGhpbmcgd29ya3MgJiYgbnBtIHJ1biB0ZXN0XCIsXG4gICAgICBjd2Q6IHRtcCxcbiAgICB9KTtcbiAgICAvLyBcIkNoZWNrIHRoYXQgZXZlcnl0aGluZyB3b3Jrc1wiIGlzIHByb3NlIChzdGFydHMgd2l0aCBjYXBpdGFsLCA0KyB3b3JkcylcbiAgICAvLyBcIm5wbSBydW4gdGVzdFwiIGlzIGEgdmFsaWQgY29tbWFuZFxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc291cmNlLCBcInRhc2stcGxhblwiKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5jb21tYW5kcywgW1wibnBtIHJ1biB0ZXN0XCJdKTtcbiAgfSk7XG5cbiAgdGVzdChcInRhc2tQbGFuVmVyaWZ5IHJlamVjdHMgcGlwZWQgcHl0ZXN0IGNvbW1hbmRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGRpc2NvdmVyQ29tbWFuZHMoe1xuICAgICAgdGFza1BsYW5WZXJpZnk6IFwicHl0aG9uMyAtbSBweXRlc3QgdGVzdHMvIC1xIC0tdGI9c2hvcnQgMj4mMSB8IHRhaWwgLTVcIixcbiAgICAgIGN3ZDogdG1wLFxuICAgIH0pO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc291cmNlLCBcIm5vbmVcIik7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQuY29tbWFuZHMsIFtdKTtcbiAgfSk7XG5cbiAgdGVzdChcIlB5dGhvbiBwcm9qZWN0IHdpdGggdGVzdHMgZGlzY292ZXJzIHB5dGVzdCB3aGVuIHBhY2thZ2UuanNvbiBpcyBhYnNlbnRcIiwgKCkgPT4ge1xuICAgIG1rZGlyU3luYyhqb2luKHRtcCwgXCJ0ZXN0c1wiKSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHRtcCwgXCJ0ZXN0c1wiLCBcInRlc3Rfc2FtcGxlLnB5XCIpLCBcImRlZiB0ZXN0X3NhbXBsZSgpOlxcbiAgICBhc3NlcnQgVHJ1ZVxcblwiKTtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbih0bXAsIFwicHlwcm9qZWN0LnRvbWxcIiksXG4gICAgICBgW3Byb2plY3RdXG5uYW1lID0gXCJzYW1wbGVcIlxuXG5bdG9vbC5weXRlc3QuaW5pX29wdGlvbnNdXG5weXRob25wYXRoID0gW1wiLlwiXVxuYCxcbiAgICApO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gZGlzY292ZXJDb21tYW5kcyh7IGN3ZDogdG1wIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zb3VyY2UsIFwicHl0aG9uLXByb2plY3RcIik7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQuY29tbWFuZHMsIFtcInB5dGhvbjMgLW0gcHl0ZXN0XCJdKTtcbiAgfSk7XG5cbiAgdGVzdChcIlB5dGhvbiBwcm9qZWN0IHdpdGggbmVzdGVkIFB5dGhvbiB0ZXN0IGZpbGUgZGlzY292ZXJzIHB5dGVzdFwiLCAoKSA9PiB7XG4gICAgbWtkaXJTeW5jKGpvaW4odG1wLCBcInRlc3RzXCIsIFwidW5pdFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHRtcCwgXCJ0ZXN0c1wiLCBcInVuaXRcIiwgXCJzYW1wbGVfdGVzdC5weVwiKSwgXCJkZWYgdGVzdF9zYW1wbGUoKTpcXG4gICAgYXNzZXJ0IFRydWVcXG5cIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSBkaXNjb3ZlckNvbW1hbmRzKHsgY3dkOiB0bXAgfSk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnNvdXJjZSwgXCJweXRob24tcHJvamVjdFwiKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5jb21tYW5kcywgW1wicHl0aG9uMyAtbSBweXRlc3RcIl0pO1xuICB9KTtcblxuICB0ZXN0KFwiUHl0aG9uIHByb2plY3Qgd2l0aCBweXRlc3QuaW5pIGRpc2NvdmVycyBweXRlc3RcIiwgKCkgPT4ge1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbih0bXAsIFwicHl0ZXN0LmluaVwiKSwgXCJbcHl0ZXN0XVxcbnB5dGhvbnBhdGggPSAuXFxuXCIpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gZGlzY292ZXJDb21tYW5kcyh7IGN3ZDogdG1wIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zb3VyY2UsIFwicHl0aG9uLXByb2plY3RcIik7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQuY29tbWFuZHMsIFtcInB5dGhvbjMgLW0gcHl0ZXN0XCJdKTtcbiAgfSk7XG5cbiAgdGVzdChcIlB5dGhvbiBwcm9qZWN0IHdpdGggZXhwbGljaXQgcHlwcm9qZWN0IHB5dGVzdCBtYXJrZXIgZGlzY292ZXJzIHB5dGVzdFwiLCAoKSA9PiB7XG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4odG1wLCBcInB5cHJvamVjdC50b21sXCIpLFxuICAgICAgYFt0b29sLnB5dGVzdF1cbnB5dGhvbnBhdGggPSBbXCIuXCJdXG5gLFxuICAgICk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBkaXNjb3ZlckNvbW1hbmRzKHsgY3dkOiB0bXAgfSk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnNvdXJjZSwgXCJweXRob24tcHJvamVjdFwiKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5jb21tYW5kcywgW1wicHl0aG9uMyAtbSBweXRlc3RcIl0pO1xuICB9KTtcblxuICB0ZXN0KFwiUHl0aG9uIHByb2plY3QgbWFya2VycyB3aXRob3V0IHB5dGVzdCBldmlkZW5jZSBkbyBub3QgZGlzY292ZXIgcHl0ZXN0XCIsICgpID0+IHtcbiAgICBta2RpclN5bmMoam9pbih0bXAsIFwidGVzdHNcIikpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbih0bXAsIFwidGVzdHNcIiwgXCJSRUFETUUubWRcIiksIFwiIyB0ZXN0c1xcblwiKTtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbih0bXAsIFwicHlwcm9qZWN0LnRvbWxcIiksXG4gICAgICBgW3Byb2plY3RdXG5uYW1lID0gXCJzYW1wbGVcIlxuZGVwZW5kZW5jaWVzID0gW1wicHl0ZXN0LWNvdlwiXVxuYCxcbiAgICApO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gZGlzY292ZXJDb21tYW5kcyh7IGN3ZDogdG1wIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zb3VyY2UsIFwibm9uZVwiKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5jb21tYW5kcywgW10pO1xuICB9KTtcblxuICB0ZXN0KFwiUHl0aG9uIHByb2plY3Qgd2l0aCBzZXR1cC5jZmcgYWxvbmUgZG9lcyBub3QgZGlzY292ZXIgcHl0ZXN0XCIsICgpID0+IHtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4odG1wLCBcInNldHVwLmNmZ1wiKSwgXCJbdG9vbDpweXRlc3RdXFxucHl0aG9ucGF0aCA9IC5cXG5cIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSBkaXNjb3ZlckNvbW1hbmRzKHsgY3dkOiB0bXAgfSk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnNvdXJjZSwgXCJub25lXCIpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0LmNvbW1hbmRzLCBbXSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJQeXRob24gcHJvamVjdCB3aXRoIHRveC5pbmkgYWxvbmUgZG9lcyBub3QgZGlzY292ZXIgcHl0ZXN0XCIsICgpID0+IHtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4odG1wLCBcInRveC5pbmlcIiksIFwiW3B5dGVzdF1cXG5weXRob25wYXRoID0gLlxcblwiKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGRpc2NvdmVyQ29tbWFuZHMoeyBjd2Q6IHRtcCB9KTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc291cmNlLCBcIm5vbmVcIik7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQuY29tbWFuZHMsIFtdKTtcbiAgfSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEV4ZWN1dGlvbiBUZXN0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJ2ZXJpZmljYXRpb24tZ2F0ZTogZXhlY3V0aW9uXCIsICgpID0+IHtcbiAgbGV0IHRtcDogc3RyaW5nO1xuICBiZWZvcmVFYWNoKCgpID0+IHsgdG1wID0gbWFrZVRlbXBEaXIoXCJ2Zy1leGVjXCIpOyB9KTtcbiAgYWZ0ZXJFYWNoKCgpID0+IHsgcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pOyB9KTtcblxuICB0ZXN0KFwiYWxsIGNvbW1hbmRzIHBhc3MgXHUyMTkyIGdhdGUgcGFzc2VzXCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBydW5WZXJpZmljYXRpb25HYXRlKHtcbiAgICAgIGN3ZDogdG1wLFxuICAgICAgcHJlZmVyZW5jZUNvbW1hbmRzOiBbXCJlY2hvIGhlbGxvXCIsIFwiZWNobyB3b3JsZFwiXSxcbiAgICB9KTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnBhc3NlZCwgdHJ1ZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5jaGVja3MubGVuZ3RoLCAyKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmRpc2NvdmVyeVNvdXJjZSwgXCJwcmVmZXJlbmNlXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuY2hlY2tzWzBdLmV4aXRDb2RlLCAwKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmNoZWNrc1sxXS5leGl0Q29kZSwgMCk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5jaGVja3NbMF0uc3Rkb3V0LmluY2x1ZGVzKFwiaGVsbG9cIikpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuY2hlY2tzWzFdLnN0ZG91dC5pbmNsdWRlcyhcIndvcmxkXCIpKTtcbiAgICBhc3NlcnQuZXF1YWwodHlwZW9mIHJlc3VsdC50aW1lc3RhbXAsIFwibnVtYmVyXCIpO1xuICB9KTtcblxuICB0ZXN0KFwib25lIGNvbW1hbmQgZmFpbHMgXHUyMTkyIGdhdGUgZmFpbHMgd2l0aCBleGl0IGNvZGUgKyBzdGRlcnJcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IHJ1blZlcmlmaWNhdGlvbkdhdGUoe1xuICAgICAgY3dkOiB0bXAsXG4gICAgICBwcmVmZXJlbmNlQ29tbWFuZHM6IFtcImVjaG8gb2tcIiwgXCJzaCAtYyAnZWNobyBlcnIgPiYyOyBleGl0IDEnXCJdLFxuICAgIH0pO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQucGFzc2VkLCBmYWxzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5jaGVja3MubGVuZ3RoLCAyKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmNoZWNrc1swXS5leGl0Q29kZSwgMCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5jaGVja3NbMV0uZXhpdENvZGUsIDEpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuY2hlY2tzWzFdLnN0ZGVyci5pbmNsdWRlcyhcImVyclwiKSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJubyBjb21tYW5kcyBkaXNjb3ZlcmVkIFx1MjE5MiBnYXRlIHBhc3NlcyB3aXRoIDAgY2hlY2tzXCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBydW5WZXJpZmljYXRpb25HYXRlKHtcbiAgICAgIGN3ZDogdG1wLFxuICAgIH0pO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQucGFzc2VkLCB0cnVlKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmNoZWNrcy5sZW5ndGgsIDApO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuZGlzY292ZXJ5U291cmNlLCBcIm5vbmVcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJjb21tYW5kIG5vdCBmb3VuZCBcdTIxOTIgZXhpdCBjb2RlIDEyN1wiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gcnVuVmVyaWZpY2F0aW9uR2F0ZSh7XG4gICAgICBjd2Q6IHRtcCxcbiAgICAgIHByZWZlcmVuY2VDb21tYW5kczogW1wiX19ub25leGlzdGVudF9jb21tYW5kX3h5el80Ml9fXCJdLFxuICAgIH0pO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQucGFzc2VkLCBmYWxzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5jaGVja3MubGVuZ3RoLCAxKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmNoZWNrc1swXS5leGl0Q29kZSAhPT0gMCwgXCJzaG91bGQgaGF2ZSBub24temVybyBleGl0IGNvZGVcIik7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5jaGVja3NbMF0uZHVyYXRpb25NcyA+PSAwKTtcbiAgfSk7XG5cbiAgdGVzdChcIm5vIERFUDAxOTAgZGVwcmVjYXRpb24gd2FybmluZyB3aGVuIHJ1bm5pbmcgY29tbWFuZHNcIiwgKCkgPT4ge1xuICAgIC8vIFJ1biBhIHN1YnByb2Nlc3Mgd2l0aCAtLXRocm93LWRlcHJlY2F0aW9uIHNvIGFueSBEZXByZWNhdGlvbldhcm5pbmdcbiAgICAvLyBiZWNvbWVzIGEgdGhyb3duIGVycm9yIChub24temVybyBleGl0KS4gVGhlIGZpeCBwYXNzZXMgdGhlIGNvbW1hbmRcbiAgICAvLyBzdHJpbmcgdG8gc2ggLWMgZXhwbGljaXRseSBpbnN0ZWFkIG9mIHVzaW5nIHNwYXduU3luYyhjbWQsIHtzaGVsbDp0cnVlfSkuXG4gICAgY29uc3QgdGhpc0RpciA9IGRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcbiAgICBjb25zdCBnYXRlUGF0aCA9IGpvaW4odGhpc0RpciwgXCIuLlwiLCBcInZlcmlmaWNhdGlvbi1nYXRlLnRzXCIpO1xuICAgIGNvbnN0IHJlc29sdmVyUGF0aCA9IGpvaW4odGhpc0RpciwgXCJyZXNvbHZlLXRzLm1qc1wiKTtcbiAgICBjb25zdCBzY3JpcHQgPSBbXG4gICAgICBgaW1wb3J0IHsgcnVuVmVyaWZpY2F0aW9uR2F0ZSB9IGZyb20gJHtKU09OLnN0cmluZ2lmeShwYXRoVG9GaWxlVVJMKGdhdGVQYXRoKS5ocmVmKX07YCxcbiAgICAgIGBydW5WZXJpZmljYXRpb25HYXRlKHtgLFxuICAgICAgYCAgY3dkOiAke0pTT04uc3RyaW5naWZ5KHRtcCl9LGAsXG4gICAgICBgICBwcmVmZXJlbmNlQ29tbWFuZHM6IFtcImVjaG8gZGVwMDE5MC1jaGVja1wiXSxgLFxuICAgICAgYH0pO2AsXG4gICAgXS5qb2luKFwiXFxuXCIpO1xuICAgIGNvbnN0IGNoaWxkID0gc3Bhd25TeW5jKFxuICAgICAgcHJvY2Vzcy5leGVjUGF0aCxcbiAgICAgIFtcbiAgICAgICAgXCItLXRocm93LWRlcHJlY2F0aW9uXCIsXG4gICAgICAgIFwiLS1leHBlcmltZW50YWwtc3RyaXAtdHlwZXNcIixcbiAgICAgICAgXCItLWltcG9ydFwiLCBwYXRoVG9GaWxlVVJMKHJlc29sdmVyUGF0aCkuaHJlZixcbiAgICAgICAgXCItLWlucHV0LXR5cGU9bW9kdWxlXCIsXG4gICAgICAgIFwiLWVcIiwgc2NyaXB0LFxuICAgICAgXSxcbiAgICAgIHsgZW5jb2Rpbmc6IFwidXRmLThcIiwgdGltZW91dDogMTVfMDAwIH0sXG4gICAgKTtcbiAgICAvLyBXaXRoIC0tdGhyb3ctZGVwcmVjYXRpb24sIGFueSBEZXByZWNhdGlvbldhcm5pbmcgYmVjb21lcyBhIHRocm93biBlcnJvclxuICAgIC8vIGNhdXNpbmcgYSBub24temVybyBleGl0LiBFeGl0IDAgcHJvdmVzIG5vIGRlcHJlY2F0aW9uIHdhcyBlbWl0dGVkLlxuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIGNoaWxkLnN0YXR1cyxcbiAgICAgIDAsXG4gICAgICBgRXhwZWN0ZWQgZXhpdCAwIChubyBkZXByZWNhdGlvbikgYnV0IGdvdCAke2NoaWxkLnN0YXR1c30uIHN0ZGVycjogJHtjaGlsZC5zdGRlcnJ9YCxcbiAgICApO1xuICB9KTtcblxuICB0ZXN0KFwiZWFjaCBjaGVjayBoYXMgZHVyYXRpb25Nc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gcnVuVmVyaWZpY2F0aW9uR2F0ZSh7XG4gICAgICBjd2Q6IHRtcCxcbiAgICAgIHByZWZlcmVuY2VDb21tYW5kczogW1wiZWNobyBmYXN0XCJdLFxuICAgIH0pO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuY2hlY2tzLmxlbmd0aCwgMSk7XG4gICAgYXNzZXJ0LmVxdWFsKHR5cGVvZiByZXN1bHQuY2hlY2tzWzBdLmR1cmF0aW9uTXMsIFwibnVtYmVyXCIpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuY2hlY2tzWzBdLmR1cmF0aW9uTXMgPj0gMCk7XG4gIH0pO1xuXG4gIHRlc3QoXCJvbmUgY29tbWFuZCBmYWlscyBcdTIwMTQgcmVtYWluaW5nIGNvbW1hbmRzIHN0aWxsIHJ1biAobm9uLXNob3J0LWNpcmN1aXQpXCIsICgpID0+IHtcbiAgICAvLyBGaXJzdCBmYWlscywgc2Vjb25kIGFuZCB0aGlyZCBzaG91bGQgc3RpbGwgZXhlY3V0ZVxuICAgIGNvbnN0IHJlc3VsdCA9IHJ1blZlcmlmaWNhdGlvbkdhdGUoe1xuICAgICAgY3dkOiB0bXAsXG4gICAgICBwcmVmZXJlbmNlQ29tbWFuZHM6IFtcbiAgICAgICAgXCJzaCAtYyAnZXhpdCAxJ1wiLFxuICAgICAgICBcImVjaG8gc2Vjb25kXCIsXG4gICAgICAgIFwiZWNobyB0aGlyZFwiLFxuICAgICAgXSxcbiAgICB9KTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnBhc3NlZCwgZmFsc2UpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuY2hlY2tzLmxlbmd0aCwgMywgXCJhbGwgMyBjb21tYW5kcyBzaG91bGQgcnVuXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuY2hlY2tzWzBdLmV4aXRDb2RlLCAxLCBcImZpcnN0IGNvbW1hbmQgZmFpbHNcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5jaGVja3NbMV0uZXhpdENvZGUsIDAsIFwic2Vjb25kIGNvbW1hbmQgcnVucyBhbmQgcGFzc2VzXCIpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuY2hlY2tzWzFdLnN0ZG91dC5pbmNsdWRlcyhcInNlY29uZFwiKSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5jaGVja3NbMl0uZXhpdENvZGUsIDAsIFwidGhpcmQgY29tbWFuZCBydW5zIGFuZCBwYXNzZXNcIik7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5jaGVja3NbMl0uc3Rkb3V0LmluY2x1ZGVzKFwidGhpcmRcIikpO1xuICB9KTtcblxuICB0ZXN0KFwiZ2F0ZSBleGVjdXRpb24gdXNlcyBjd2QgZm9yIHNwYXduU3luY1wiLCAoKSA9PiB7XG4gICAgLy8gcHdkIHNob3VsZCByZXBvcnQgdGhlIHRlbXAgZGlyXG4gICAgY29uc3QgcmVzdWx0ID0gcnVuVmVyaWZpY2F0aW9uR2F0ZSh7XG4gICAgICBjd2Q6IHRtcCxcbiAgICAgIHByZWZlcmVuY2VDb21tYW5kczogW1wicHdkXCJdLFxuICAgIH0pO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQucGFzc2VkLCB0cnVlKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmNoZWNrcy5sZW5ndGgsIDEpO1xuICAgIC8vIFRoZSBzdGRvdXQgc2hvdWxkIGNvbnRhaW4gdGhlIHRtcCBkaXIgcGF0aCAocmVzb2x2aW5nIHN5bWxpbmtzKVxuICAgIGFzc2VydC5vayhyZXN1bHQuY2hlY2tzWzBdLnN0ZG91dC50cmltKCkubGVuZ3RoID4gMCwgXCJwd2Qgc2hvdWxkIHByb2R1Y2Ugb3V0cHV0XCIpO1xuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUHJlZmVyZW5jZSBWYWxpZGF0aW9uIFRlc3RzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwidmVyaWZpY2F0aW9uLWdhdGU6IHZhbGlkYXRlUHJlZmVyZW5jZXMgYWNjZXB0cyB2YWxpZCB2ZXJpZmljYXRpb24ga2V5c1wiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHZhbGlkYXRlUHJlZmVyZW5jZXMoe1xuICAgIHZlcmlmaWNhdGlvbl9jb21tYW5kczogW1wibnBtIHJ1biBsaW50XCIsIFwibnBtIHJ1biB0ZXN0XCJdLFxuICAgIHZlcmlmaWNhdGlvbl9hdXRvX2ZpeDogdHJ1ZSxcbiAgICB2ZXJpZmljYXRpb25fbWF4X3JldHJpZXM6IDMsXG4gIH0pO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5wcmVmZXJlbmNlcy52ZXJpZmljYXRpb25fY29tbWFuZHMsIFtcbiAgICBcIm5wbSBydW4gbGludFwiLFxuICAgIFwibnBtIHJ1biB0ZXN0XCIsXG4gIF0pO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnByZWZlcmVuY2VzLnZlcmlmaWNhdGlvbl9hdXRvX2ZpeCwgdHJ1ZSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQucHJlZmVyZW5jZXMudmVyaWZpY2F0aW9uX21heF9yZXRyaWVzLCAzKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5lcnJvcnMubGVuZ3RoLCAwKTtcbn0pO1xuXG50ZXN0KFwidmVyaWZpY2F0aW9uLWdhdGU6IHZhbGlkYXRlUHJlZmVyZW5jZXMgcmVqZWN0cyBub24tYXJyYXkgdmVyaWZpY2F0aW9uX2NvbW1hbmRzXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gdmFsaWRhdGVQcmVmZXJlbmNlcyh7XG4gICAgdmVyaWZpY2F0aW9uX2NvbW1hbmRzOiBcIm5wbSBydW4gbGludFwiIGFzIHVua25vd24gYXMgc3RyaW5nW10sXG4gIH0pO1xuICBhc3NlcnQub2socmVzdWx0LmVycm9ycy5zb21lKChlKSA9PiBlLmluY2x1ZGVzKFwidmVyaWZpY2F0aW9uX2NvbW1hbmRzXCIpKSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQucHJlZmVyZW5jZXMudmVyaWZpY2F0aW9uX2NvbW1hbmRzLCB1bmRlZmluZWQpO1xufSk7XG5cbnRlc3QoXCJ2ZXJpZmljYXRpb24tZ2F0ZTogdmFsaWRhdGVQcmVmZXJlbmNlcyByZWplY3RzIG5vbi1ib29sZWFuIHZlcmlmaWNhdGlvbl9hdXRvX2ZpeFwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHZhbGlkYXRlUHJlZmVyZW5jZXMoe1xuICAgIHZlcmlmaWNhdGlvbl9hdXRvX2ZpeDogXCJ5ZXNcIiBhcyB1bmtub3duIGFzIGJvb2xlYW4sXG4gIH0pO1xuICBhc3NlcnQub2socmVzdWx0LmVycm9ycy5zb21lKChlKSA9PiBlLmluY2x1ZGVzKFwidmVyaWZpY2F0aW9uX2F1dG9fZml4XCIpKSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQucHJlZmVyZW5jZXMudmVyaWZpY2F0aW9uX2F1dG9fZml4LCB1bmRlZmluZWQpO1xufSk7XG5cbnRlc3QoXCJ2ZXJpZmljYXRpb24tZ2F0ZTogdmFsaWRhdGVQcmVmZXJlbmNlcyByZWplY3RzIG5lZ2F0aXZlIHZlcmlmaWNhdGlvbl9tYXhfcmV0cmllc1wiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHZhbGlkYXRlUHJlZmVyZW5jZXMoe1xuICAgIHZlcmlmaWNhdGlvbl9tYXhfcmV0cmllczogLTEsXG4gIH0pO1xuICBhc3NlcnQub2socmVzdWx0LmVycm9ycy5zb21lKChlKSA9PiBlLmluY2x1ZGVzKFwidmVyaWZpY2F0aW9uX21heF9yZXRyaWVzXCIpKSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQucHJlZmVyZW5jZXMudmVyaWZpY2F0aW9uX21heF9yZXRyaWVzLCB1bmRlZmluZWQpO1xufSk7XG5cbnRlc3QoXCJ2ZXJpZmljYXRpb24tZ2F0ZTogdmFsaWRhdGVQcmVmZXJlbmNlcyByZWplY3RzIG5vbi1zdHJpbmcgaXRlbXMgaW4gdmVyaWZpY2F0aW9uX2NvbW1hbmRzXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gdmFsaWRhdGVQcmVmZXJlbmNlcyh7XG4gICAgdmVyaWZpY2F0aW9uX2NvbW1hbmRzOiBbXCJucG0gcnVuIGxpbnRcIiwgNDIgYXMgdW5rbm93biBhcyBzdHJpbmddLFxuICB9KTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdC5lcnJvcnMuc29tZSgoZSkgPT4gZS5pbmNsdWRlcyhcInZlcmlmaWNhdGlvbl9jb21tYW5kc1wiKSkpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnByZWZlcmVuY2VzLnZlcmlmaWNhdGlvbl9jb21tYW5kcywgdW5kZWZpbmVkKTtcbn0pO1xuXG50ZXN0KFwidmVyaWZpY2F0aW9uLWdhdGU6IHZhbGlkYXRlUHJlZmVyZW5jZXMgZmxvb3JzIHZlcmlmaWNhdGlvbl9tYXhfcmV0cmllc1wiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHZhbGlkYXRlUHJlZmVyZW5jZXMoe1xuICAgIHZlcmlmaWNhdGlvbl9tYXhfcmV0cmllczogMi43LFxuICB9KTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5wcmVmZXJlbmNlcy52ZXJpZmljYXRpb25fbWF4X3JldHJpZXMsIDIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LmVycm9ycy5sZW5ndGgsIDApO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBpc0xpa2VseUNvbW1hbmQgVGVzdHMgKGlzc3VlICMxMDY2KSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcImlzTGlrZWx5Q29tbWFuZDoga25vd24gY29tbWFuZCBwcmVmaXhlcyBhcmUgYWNjZXB0ZWRcIiwgKCkgPT4ge1xuICBhc3NlcnQuZXF1YWwoaXNMaWtlbHlDb21tYW5kKFwibnBtIHJ1biBsaW50XCIpLCB0cnVlKTtcbiAgYXNzZXJ0LmVxdWFsKGlzTGlrZWx5Q29tbWFuZChcIm5weCB2aXRlc3RcIiksIHRydWUpO1xuICBhc3NlcnQuZXF1YWwoaXNMaWtlbHlDb21tYW5kKFwieWFybiB0ZXN0XCIpLCB0cnVlKTtcbiAgYXNzZXJ0LmVxdWFsKGlzTGlrZWx5Q29tbWFuZChcInBucG0gcnVuIHR5cGVjaGVja1wiKSwgdHJ1ZSk7XG4gIGFzc2VydC5lcXVhbChpc0xpa2VseUNvbW1hbmQoXCJub2RlIHNjcmlwdC5qc1wiKSwgdHJ1ZSk7XG4gIGFzc2VydC5lcXVhbChpc0xpa2VseUNvbW1hbmQoXCJ0c2MgLS1ub0VtaXRcIiksIHRydWUpO1xuICBhc3NlcnQuZXF1YWwoaXNMaWtlbHlDb21tYW5kKFwiZXNsaW50IC5cIiksIHRydWUpO1xuICBhc3NlcnQuZXF1YWwoaXNMaWtlbHlDb21tYW5kKFwiamVzdCAtLWNpXCIpLCB0cnVlKTtcbiAgYXNzZXJ0LmVxdWFsKGlzTGlrZWx5Q29tbWFuZChcInB5dGhvbjMgLW0gcHl0ZXN0XCIpLCB0cnVlKTtcbiAgYXNzZXJ0LmVxdWFsKGlzTGlrZWx5Q29tbWFuZChcImNhcmdvIHRlc3RcIiksIHRydWUpO1xuICBhc3NlcnQuZXF1YWwoaXNMaWtlbHlDb21tYW5kKFwiZ28gdGVzdCAuLy4uLlwiKSwgdHJ1ZSk7XG4gIGFzc2VydC5lcXVhbChpc0xpa2VseUNvbW1hbmQoXCJtYWtlIHRlc3RcIiksIHRydWUpO1xufSk7XG5cbnRlc3QoXCJpc0xpa2VseUNvbW1hbmQ6IHBhdGgtbGlrZSBmaXJzdCB0b2tlbnMgYXJlIGFjY2VwdGVkXCIsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKGlzTGlrZWx5Q29tbWFuZChcIi4vc2NyaXB0cy92ZXJpZnkuc2hcIiksIHRydWUpO1xuICBhc3NlcnQuZXF1YWwoaXNMaWtlbHlDb21tYW5kKFwiL3Vzci9sb2NhbC9iaW4vY2hlY2tcIiksIHRydWUpO1xuICBhc3NlcnQuZXF1YWwoaXNMaWtlbHlDb21tYW5kKFwiLi4vdG9vbHMvbGludC5zaFwiKSwgdHJ1ZSk7XG59KTtcblxudGVzdChcImlzTGlrZWx5Q29tbWFuZDogZmxhZy1saWtlIHRva2VucyBpbmRpY2F0ZSBhIGNvbW1hbmRcIiwgKCkgPT4ge1xuICBhc3NlcnQuZXF1YWwoaXNMaWtlbHlDb21tYW5kKFwiY3VzdG9tLXRvb2wgLS1jaGVja1wiKSwgdHJ1ZSk7XG4gIGFzc2VydC5lcXVhbChpc0xpa2VseUNvbW1hbmQoXCJteWNoZWNrIC12XCIpLCB0cnVlKTtcbn0pO1xuXG50ZXN0KFwiaXNMaWtlbHlDb21tYW5kOiBwcm9zZSBkZXNjcmlwdGlvbnMgYXJlIHJlamVjdGVkXCIsICgpID0+IHtcbiAgLy8gVGhlIGV4YWN0IHN0cmluZyBmcm9tIGlzc3VlICMxMDY2XG4gIGFzc2VydC5lcXVhbChcbiAgICBpc0xpa2VseUNvbW1hbmQoXCJEb2N1bWVudCBleGlzdHMsIGNvbnRhaW5zIGFsbCA1IHNjYWxlIG5hbWVzLCBhbGwgMTQgc2VtYW50aWMgdG9rZW5zLCBJbnRlciBhc3Nlc3NtZW50LCBwaGlsb3NvcGh5IGFuZCBjb21wZXRpdGl2ZSBjaXRhdGlvbnMgcHJlc2VudFwiKSxcbiAgICBmYWxzZSxcbiAgKTtcbiAgYXNzZXJ0LmVxdWFsKGlzTGlrZWx5Q29tbWFuZChcIkNoZWNrIHRoYXQgdGhlIGZpbGUgaGFzIGJlZW4gY3JlYXRlZCB3aXRoIHRoZSBjb3JyZWN0IGNvbnRlbnRcIiksIGZhbHNlKTtcbiAgYXNzZXJ0LmVxdWFsKGlzTGlrZWx5Q29tbWFuZChcIlZlcmlmeSB0aGUgb3V0cHV0IG1hdGNoZXMgZXhwZWN0ZWQgZm9ybWF0XCIpLCBmYWxzZSk7XG4gIGFzc2VydC5lcXVhbChpc0xpa2VseUNvbW1hbmQoXCJBbGwgdGVzdHMgcGFzcyBhbmQgY292ZXJhZ2UgaXMgYWJvdmUgODAlXCIpLCBmYWxzZSk7XG4gIGFzc2VydC5lcXVhbChpc0xpa2VseUNvbW1hbmQoXCJGaWxlIHNob3VsZCBleGlzdCBpbiB0aGUgb3V0cHV0IGRpcmVjdG9yeVwiKSwgZmFsc2UpO1xuICBhc3NlcnQuZXF1YWwoaXNMaWtlbHlDb21tYW5kKFwiQnVpbGQgc3VjY2VlZHMgd2l0aG91dCBlcnJvcnMgb3Igd2FybmluZ3NcIiksIGZhbHNlKTtcbn0pO1xuXG50ZXN0KFwiaXNMaWtlbHlDb21tYW5kOiBub24tQVNDSUkgcHJvc2UgZGVzY3JpcHRpb25zIGFyZSByZWplY3RlZFwiLCAoKSA9PiB7XG4gIGFzc2VydC5lcXVhbChpc0xpa2VseUNvbW1hbmQoXCJcdTYyNDBcdTY3MDkgXHU1NDdEXHU0RUU0IFx1OEY5M1x1NTFGQSBcdTRFMDBcdTg4NEMgSlNPTkwgZ28gdGVzdCAuLy4uLiBcdTkwMUFcdThGQzdcIiksIGZhbHNlKTtcbn0pO1xuXG50ZXN0KFwiaXNMaWtlbHlDb21tYW5kOiBlbXB0eSBvciB3aGl0ZXNwYWNlLW9ubHkgc3RyaW5ncyBhcmUgcmVqZWN0ZWRcIiwgKCkgPT4ge1xuICBhc3NlcnQuZXF1YWwoaXNMaWtlbHlDb21tYW5kKFwiXCIpLCBmYWxzZSk7XG4gIGFzc2VydC5lcXVhbChpc0xpa2VseUNvbW1hbmQoXCIgICBcIiksIGZhbHNlKTtcbn0pO1xuXG50ZXN0KFwiaXNMaWtlbHlDb21tYW5kOiBzaG9ydCBsb3dlcmNhc2UgdG9rZW5zIHdpdGhvdXQgZmxhZ3MgYXJlIGFjY2VwdGVkIChjb3VsZCBiZSBjdXN0b20gc2NyaXB0cylcIiwgKCkgPT4ge1xuICBhc3NlcnQuZXF1YWwoaXNMaWtlbHlDb21tYW5kKFwiY3VzdG9tLXZlcmlmeVwiKSwgdHJ1ZSk7XG4gIGFzc2VydC5lcXVhbChpc0xpa2VseUNvbW1hbmQoXCJteWNoZWNrXCIpLCB0cnVlKTtcbn0pO1xuXG50ZXN0KFwidmFsaWRhdGVWZXJpZmljYXRpb25Db21tYW5kIHJlamVjdHMgc2hlbGwgY29udHJvbCBzeW50YXhcIiwgKCkgPT4ge1xuICBhc3NlcnQuZGVlcEVxdWFsKHZhbGlkYXRlVmVyaWZpY2F0aW9uQ29tbWFuZChcInB5dGhvbjMgLW0gcHl0ZXN0IHRlc3RzLyAtcSAtLXRiPXNob3J0XCIpLm9rLCB0cnVlKTtcbiAgY29uc3QgcmVzdWx0ID0gdmFsaWRhdGVWZXJpZmljYXRpb25Db21tYW5kKFwicHl0aG9uMyAtbSBweXRlc3QgdGVzdHMvIC1xIC0tdGI9c2hvcnQgMj4mMSB8IHRhaWwgLTVcIik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQub2ssIGZhbHNlKTtcbiAgaWYgKCFyZXN1bHQub2spIHtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LnJlYXNvbiwgL3NoZWxsIGNvbnRyb2wgc3ludGF4Lyk7XG4gIH1cbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQWRkaXRpb25hbCBQcmVmZXJlbmNlIFZhbGlkYXRpb24gVGVzdHMgKFQwMikgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJ2ZXJpZmljYXRpb24tZ2F0ZTogdmVyaWZpY2F0aW9uX2NvbW1hbmRzIHByb2R1Y2VzIG5vIHVua25vd24ta2V5IHdhcm5pbmdzXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gdmFsaWRhdGVQcmVmZXJlbmNlcyh7XG4gICAgdmVyaWZpY2F0aW9uX2NvbW1hbmRzOiBbXCJucG0gdGVzdFwiXSxcbiAgfSk7XG4gIGNvbnN0IHVua25vd25XYXJuaW5ncyA9IChyZXN1bHQud2FybmluZ3MgPz8gW10pLmZpbHRlcih3ID0+IHcuaW5jbHVkZXMoXCJ1bmtub3duXCIpKTtcbiAgYXNzZXJ0LmVxdWFsKHVua25vd25XYXJuaW5ncy5sZW5ndGgsIDAsIFwidmVyaWZpY2F0aW9uX2NvbW1hbmRzIGlzIGEga25vd24ga2V5XCIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LmVycm9ycy5sZW5ndGgsIDApO1xufSk7XG5cbnRlc3QoXCJ2ZXJpZmljYXRpb24tZ2F0ZTogdmVyaWZpY2F0aW9uX2F1dG9fZml4IHByb2R1Y2VzIG5vIHVua25vd24ta2V5IHdhcm5pbmdzXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gdmFsaWRhdGVQcmVmZXJlbmNlcyh7XG4gICAgdmVyaWZpY2F0aW9uX2F1dG9fZml4OiB0cnVlLFxuICB9KTtcbiAgY29uc3QgdW5rbm93bldhcm5pbmdzID0gKHJlc3VsdC53YXJuaW5ncyA/PyBbXSkuZmlsdGVyKHcgPT4gdy5pbmNsdWRlcyhcInVua25vd25cIikpO1xuICBhc3NlcnQuZXF1YWwodW5rbm93bldhcm5pbmdzLmxlbmd0aCwgMCwgXCJ2ZXJpZmljYXRpb25fYXV0b19maXggaXMgYSBrbm93biBrZXlcIik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQuZXJyb3JzLmxlbmd0aCwgMCk7XG59KTtcblxudGVzdChcInZlcmlmaWNhdGlvbi1nYXRlOiB2ZXJpZmljYXRpb25fbWF4X3JldHJpZXMgcHJvZHVjZXMgbm8gdW5rbm93bi1rZXkgd2FybmluZ3NcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSB2YWxpZGF0ZVByZWZlcmVuY2VzKHtcbiAgICB2ZXJpZmljYXRpb25fbWF4X3JldHJpZXM6IDIsXG4gIH0pO1xuICBjb25zdCB1bmtub3duV2FybmluZ3MgPSAocmVzdWx0Lndhcm5pbmdzID8/IFtdKS5maWx0ZXIodyA9PiB3LmluY2x1ZGVzKFwidW5rbm93blwiKSk7XG4gIGFzc2VydC5lcXVhbCh1bmtub3duV2FybmluZ3MubGVuZ3RoLCAwLCBcInZlcmlmaWNhdGlvbl9tYXhfcmV0cmllcyBpcyBhIGtub3duIGtleVwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5lcnJvcnMubGVuZ3RoLCAwKTtcbn0pO1xuXG50ZXN0KFwidmVyaWZpY2F0aW9uLWdhdGU6IHZlcmlmaWNhdGlvbl9tYXhfcmV0cmllcyAtMSBwcm9kdWNlcyBhIHZhbGlkYXRpb24gZXJyb3JcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSB2YWxpZGF0ZVByZWZlcmVuY2VzKHtcbiAgICB2ZXJpZmljYXRpb25fbWF4X3JldHJpZXM6IC0xLFxuICB9KTtcbiAgYXNzZXJ0Lm9rKFxuICAgIHJlc3VsdC5lcnJvcnMuc29tZShlID0+IGUuaW5jbHVkZXMoXCJ2ZXJpZmljYXRpb25fbWF4X3JldHJpZXNcIikpLFxuICAgIFwibmVnYXRpdmUgbWF4X3JldHJpZXMgc2hvdWxkIGVycm9yXCIsXG4gICk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQucHJlZmVyZW5jZXMudmVyaWZpY2F0aW9uX21heF9yZXRyaWVzLCB1bmRlZmluZWQpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBmb3JtYXRGYWlsdXJlQ29udGV4dCBUZXN0cyAoUzAzL1QwMSkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJmb3JtYXRGYWlsdXJlQ29udGV4dDogZm9ybWF0cyBhIHNpbmdsZSBmYWlsdXJlIHdpdGggY29tbWFuZCwgZXhpdCBjb2RlLCBzdGRlcnJcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQ6IGltcG9ydChcIi4uL3R5cGVzLnRzXCIpLlZlcmlmaWNhdGlvblJlc3VsdCA9IHtcbiAgICBwYXNzZWQ6IGZhbHNlLFxuICAgIGNoZWNrczogW1xuICAgICAgeyBjb21tYW5kOiBcIm5wbSBydW4gbGludFwiLCBleGl0Q29kZTogMSwgc3Rkb3V0OiBcIlwiLCBzdGRlcnI6IFwiZXJyb3I6IHVudXNlZCB2YXJcIiwgZHVyYXRpb25NczogNTAwIH0sXG4gICAgXSxcbiAgICBkaXNjb3ZlcnlTb3VyY2U6IFwicHJlZmVyZW5jZVwiLFxuICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcbiAgfTtcbiAgY29uc3Qgb3V0cHV0ID0gZm9ybWF0RmFpbHVyZUNvbnRleHQocmVzdWx0KTtcbiAgYXNzZXJ0Lm9rKG91dHB1dC5zdGFydHNXaXRoKFwiIyMgVmVyaWZpY2F0aW9uIEZhaWx1cmVzXCIpLCBcInNob3VsZCBzdGFydCB3aXRoIGhlYWRlclwiKTtcbiAgYXNzZXJ0Lm9rKG91dHB1dC5pbmNsdWRlcyhcImBucG0gcnVuIGxpbnRgXCIpLCBcInNob3VsZCBpbmNsdWRlIGNvbW1hbmQgbmFtZVwiKTtcbiAgYXNzZXJ0Lm9rKG91dHB1dC5pbmNsdWRlcyhcImV4aXQgY29kZSAxXCIpLCBcInNob3VsZCBpbmNsdWRlIGV4aXQgY29kZVwiKTtcbiAgYXNzZXJ0Lm9rKG91dHB1dC5pbmNsdWRlcyhcImVycm9yOiB1bnVzZWQgdmFyXCIpLCBcInNob3VsZCBpbmNsdWRlIHN0ZGVyciBjb250ZW50XCIpO1xuICBhc3NlcnQub2sob3V0cHV0LmluY2x1ZGVzKFwiYGBgc3RkZXJyXCIpLCBcInNob3VsZCBoYXZlIHN0ZGVyciBjb2RlIGJsb2NrXCIpO1xufSk7XG5cbnRlc3QoXCJmb3JtYXRGYWlsdXJlQ29udGV4dDogZm9ybWF0cyBtdWx0aXBsZSBmYWlsdXJlc1wiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdDogaW1wb3J0KFwiLi4vdHlwZXMudHNcIikuVmVyaWZpY2F0aW9uUmVzdWx0ID0ge1xuICAgIHBhc3NlZDogZmFsc2UsXG4gICAgY2hlY2tzOiBbXG4gICAgICB7IGNvbW1hbmQ6IFwibnBtIHJ1biBsaW50XCIsIGV4aXRDb2RlOiAxLCBzdGRvdXQ6IFwiXCIsIHN0ZGVycjogXCJsaW50IGVycm9yXCIsIGR1cmF0aW9uTXM6IDEwMCB9LFxuICAgICAgeyBjb21tYW5kOiBcIm5wbSBydW4gdGVzdFwiLCBleGl0Q29kZTogMiwgc3Rkb3V0OiBcIlwiLCBzdGRlcnI6IFwidGVzdCBmYWlsdXJlXCIsIGR1cmF0aW9uTXM6IDIwMCB9LFxuICAgICAgeyBjb21tYW5kOiBcIm5wbSBydW4gdHlwZWNoZWNrXCIsIGV4aXRDb2RlOiAwLCBzdGRvdXQ6IFwib2tcIiwgc3RkZXJyOiBcIlwiLCBkdXJhdGlvbk1zOiA1MCB9LFxuICAgIF0sXG4gICAgZGlzY292ZXJ5U291cmNlOiBcInByZWZlcmVuY2VcIixcbiAgICB0aW1lc3RhbXA6IERhdGUubm93KCksXG4gIH07XG4gIGNvbnN0IG91dHB1dCA9IGZvcm1hdEZhaWx1cmVDb250ZXh0KHJlc3VsdCk7XG4gIGFzc2VydC5vayhvdXRwdXQuaW5jbHVkZXMoXCJgbnBtIHJ1biBsaW50YFwiKSwgXCJzaG91bGQgaW5jbHVkZSBmaXJzdCBmYWlsZWQgY29tbWFuZFwiKTtcbiAgYXNzZXJ0Lm9rKG91dHB1dC5pbmNsdWRlcyhcImV4aXQgY29kZSAxXCIpLCBcInNob3VsZCBpbmNsdWRlIGZpcnN0IGV4aXQgY29kZVwiKTtcbiAgYXNzZXJ0Lm9rKG91dHB1dC5pbmNsdWRlcyhcImBucG0gcnVuIHRlc3RgXCIpLCBcInNob3VsZCBpbmNsdWRlIHNlY29uZCBmYWlsZWQgY29tbWFuZFwiKTtcbiAgYXNzZXJ0Lm9rKG91dHB1dC5pbmNsdWRlcyhcImV4aXQgY29kZSAyXCIpLCBcInNob3VsZCBpbmNsdWRlIHNlY29uZCBleGl0IGNvZGVcIik7XG4gIC8vIFBhc3NpbmcgY2hlY2sgc2hvdWxkIE5PVCBhcHBlYXJcbiAgYXNzZXJ0Lm9rKCFvdXRwdXQuaW5jbHVkZXMoXCJucG0gcnVuIHR5cGVjaGVja1wiKSwgXCJzaG91bGQgbm90IGluY2x1ZGUgcGFzc2luZyBjb21tYW5kXCIpO1xufSk7XG5cbnRlc3QoXCJmb3JtYXRGYWlsdXJlQ29udGV4dDogdHJ1bmNhdGVzIHN0ZGVyciBsb25nZXIgdGhhbiAyMDAwIGNoYXJzXCIsICgpID0+IHtcbiAgY29uc3QgbG9uZ1N0ZGVyciA9IFwieFwiLnJlcGVhdCgzMDAwKTtcbiAgY29uc3QgcmVzdWx0OiBpbXBvcnQoXCIuLi90eXBlcy50c1wiKS5WZXJpZmljYXRpb25SZXN1bHQgPSB7XG4gICAgcGFzc2VkOiBmYWxzZSxcbiAgICBjaGVja3M6IFtcbiAgICAgIHsgY29tbWFuZDogXCJiaWctZXJyXCIsIGV4aXRDb2RlOiAxLCBzdGRvdXQ6IFwiXCIsIHN0ZGVycjogbG9uZ1N0ZGVyciwgZHVyYXRpb25NczogMTAwIH0sXG4gICAgXSxcbiAgICBkaXNjb3ZlcnlTb3VyY2U6IFwicHJlZmVyZW5jZVwiLFxuICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcbiAgfTtcbiAgY29uc3Qgb3V0cHV0ID0gZm9ybWF0RmFpbHVyZUNvbnRleHQocmVzdWx0KTtcbiAgLy8gVGhlIG91dHB1dCBzaG91bGQgY29udGFpbiAyMDAwIHgncyBmb2xsb3dlZCBieSB0cnVuY2F0aW9uIG1hcmtlciwgbm90IDMwMDBcbiAgYXNzZXJ0Lm9rKCFvdXRwdXQuaW5jbHVkZXMoXCJ4XCIucmVwZWF0KDIwMDEpKSwgXCJzaG91bGQgbm90IGNvbnRhaW4gbW9yZSB0aGFuIDIwMDAgY2hhcnMgb2Ygc3RkZXJyXCIpO1xuICBhc3NlcnQub2sob3V0cHV0LmluY2x1ZGVzKFwiXHUyMDI2W3RydW5jYXRlZF1cIiksIFwic2hvdWxkIGluY2x1ZGUgdHJ1bmNhdGlvbiBtYXJrZXJcIik7XG59KTtcblxudGVzdChcImZvcm1hdEZhaWx1cmVDb250ZXh0OiByZXR1cm5zIGVtcHR5IHN0cmluZyB3aGVuIGFsbCBjaGVja3MgcGFzc1wiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdDogaW1wb3J0KFwiLi4vdHlwZXMudHNcIikuVmVyaWZpY2F0aW9uUmVzdWx0ID0ge1xuICAgIHBhc3NlZDogdHJ1ZSxcbiAgICBjaGVja3M6IFtcbiAgICAgIHsgY29tbWFuZDogXCJucG0gcnVuIGxpbnRcIiwgZXhpdENvZGU6IDAsIHN0ZG91dDogXCJva1wiLCBzdGRlcnI6IFwiXCIsIGR1cmF0aW9uTXM6IDEwMCB9LFxuICAgICAgeyBjb21tYW5kOiBcIm5wbSBydW4gdGVzdFwiLCBleGl0Q29kZTogMCwgc3Rkb3V0OiBcIm9rXCIsIHN0ZGVycjogXCJcIiwgZHVyYXRpb25NczogMjAwIH0sXG4gICAgXSxcbiAgICBkaXNjb3ZlcnlTb3VyY2U6IFwicHJlZmVyZW5jZVwiLFxuICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcbiAgfTtcbiAgYXNzZXJ0LmVxdWFsKGZvcm1hdEZhaWx1cmVDb250ZXh0KHJlc3VsdCksIFwiXCIpO1xufSk7XG5cbnRlc3QoXCJmb3JtYXRGYWlsdXJlQ29udGV4dDogcmV0dXJucyBlbXB0eSBzdHJpbmcgZm9yIGVtcHR5IGNoZWNrcyBhcnJheVwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdDogaW1wb3J0KFwiLi4vdHlwZXMudHNcIikuVmVyaWZpY2F0aW9uUmVzdWx0ID0ge1xuICAgIHBhc3NlZDogdHJ1ZSxcbiAgICBjaGVja3M6IFtdLFxuICAgIGRpc2NvdmVyeVNvdXJjZTogXCJub25lXCIsXG4gICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxuICB9O1xuICBhc3NlcnQuZXF1YWwoZm9ybWF0RmFpbHVyZUNvbnRleHQocmVzdWx0KSwgXCJcIik7XG59KTtcblxudGVzdChcImZvcm1hdEZhaWx1cmVDb250ZXh0OiBjYXBzIHRvdGFsIG91dHB1dCBhdCAxMCwwMDAgY2hhcnNcIiwgKCkgPT4ge1xuICAvLyBHZW5lcmF0ZSBtYW55IGZhaWx1cmVzIHRvIGV4Y2VlZCAxMCwwMDAgY2hhcnMgdG90YWxcbiAgY29uc3QgY2hlY2tzOiBpbXBvcnQoXCIuLi90eXBlcy50c1wiKS5WZXJpZmljYXRpb25DaGVja1tdID0gW107XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgMjA7IGkrKykge1xuICAgIGNoZWNrcy5wdXNoKHtcbiAgICAgIGNvbW1hbmQ6IGBmYWlsaW5nLWNvbW1hbmQtJHtpfWAsXG4gICAgICBleGl0Q29kZTogMSxcbiAgICAgIHN0ZG91dDogXCJcIixcbiAgICAgIHN0ZGVycjogXCJlXCIucmVwZWF0KDEwMDApLCAvLyAxMDAwIGNoYXJzIGVhY2gsIDIwICogfjEwNTAgKHdpdGggZm9ybWF0dGluZykgPiAxMCwwMDBcbiAgICAgIGR1cmF0aW9uTXM6IDEwMCxcbiAgICB9KTtcbiAgfVxuICBjb25zdCByZXN1bHQ6IGltcG9ydChcIi4uL3R5cGVzLnRzXCIpLlZlcmlmaWNhdGlvblJlc3VsdCA9IHtcbiAgICBwYXNzZWQ6IGZhbHNlLFxuICAgIGNoZWNrcyxcbiAgICBkaXNjb3ZlcnlTb3VyY2U6IFwicHJlZmVyZW5jZVwiLFxuICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcbiAgfTtcbiAgY29uc3Qgb3V0cHV0ID0gZm9ybWF0RmFpbHVyZUNvbnRleHQocmVzdWx0KTtcbiAgYXNzZXJ0Lm9rKG91dHB1dC5sZW5ndGggPD0gMTBfMTAwLCBgdG90YWwgb3V0cHV0IHNob3VsZCBiZSBjYXBwZWQgbmVhciAxMCwwMDAgY2hhcnMsIGdvdCAke291dHB1dC5sZW5ndGh9YCk7XG4gIGFzc2VydC5vayhvdXRwdXQuaW5jbHVkZXMoXCJcdTIwMjZbcmVtYWluaW5nIGZhaWx1cmVzIHRydW5jYXRlZF1cIiksIFwic2hvdWxkIGluY2x1ZGUgdG90YWwgdHJ1bmNhdGlvbiBtYXJrZXJcIik7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGNhcHR1cmVSdW50aW1lRXJyb3JzIFRlc3RzIChTMDQvVDAxKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gbWFrZVByb2Mob3ZlcnJpZGVzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikge1xuICByZXR1cm4ge1xuICAgIGlkOiBcInAxXCIsXG4gICAgbGFiZWw6IFwidGVzdC1zZXJ2ZXJcIixcbiAgICBzdGF0dXM6IFwicmVhZHlcIixcbiAgICBhbGl2ZTogdHJ1ZSxcbiAgICBleGl0Q29kZTogbnVsbCxcbiAgICBzaWduYWw6IG51bGwsXG4gICAgcmVjZW50RXJyb3JzOiBbXSBhcyBzdHJpbmdbXSxcbiAgICAuLi5vdmVycmlkZXMsXG4gIH07XG59XG5cbmZ1bmN0aW9uIG1ha2VMb2dzKGVudHJpZXM6IEFycmF5PHsgdHlwZTogc3RyaW5nOyB0ZXh0OiBzdHJpbmcgfT4pIHtcbiAgcmV0dXJuIGVudHJpZXMubWFwKChlLCBpKSA9PiAoe1xuICAgIHR5cGU6IGUudHlwZSxcbiAgICB0ZXh0OiBlLnRleHQsXG4gICAgdGltZXN0YW1wOiBEYXRlLm5vdygpICsgaSxcbiAgICB1cmw6IFwiaHR0cDovL2xvY2FsaG9zdDozMDAwXCIsXG4gIH0pKTtcbn1cblxudGVzdChcImNhcHR1cmVSdW50aW1lRXJyb3JzOiBjcmFzaGVkIGJnLXNoZWxsIHByb2Nlc3MgXHUyMTkyIGJsb2NraW5nIGNyYXNoIGVycm9yXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgcHJvY2Vzc2VzID0gbmV3IE1hcDxzdHJpbmcsIHVua25vd24+KFtcbiAgICBbXCJwMVwiLCBtYWtlUHJvYyh7IHN0YXR1czogXCJjcmFzaGVkXCIsIGFsaXZlOiBmYWxzZSwgZXhpdENvZGU6IDEgfSldLFxuICBdKTtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2FwdHVyZVJ1bnRpbWVFcnJvcnMoe1xuICAgIGdldFByb2Nlc3NlczogKCkgPT4gcHJvY2Vzc2VzLFxuICAgIGdldENvbnNvbGVMb2dzOiAoKSA9PiBbXSxcbiAgfSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQubGVuZ3RoLCAxKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdFswXS5zb3VyY2UsIFwiYmctc2hlbGxcIik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHRbMF0uc2V2ZXJpdHksIFwiY3Jhc2hcIik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHRbMF0uYmxvY2tpbmcsIHRydWUpO1xuICBhc3NlcnQub2socmVzdWx0WzBdLm1lc3NhZ2UuaW5jbHVkZXMoXCJ0ZXN0LXNlcnZlclwiKSk7XG59KTtcblxudGVzdChcImNhcHR1cmVSdW50aW1lRXJyb3JzOiBiZy1zaGVsbCBub24temVybyBleGl0ICsgbm90IGFsaXZlIFx1MjE5MiBibG9ja2luZyBjcmFzaCBlcnJvclwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHByb2Nlc3NlcyA9IG5ldyBNYXA8c3RyaW5nLCB1bmtub3duPihbXG4gICAgW1wicDFcIiwgbWFrZVByb2MoeyBzdGF0dXM6IFwiZXhpdGVkXCIsIGFsaXZlOiBmYWxzZSwgZXhpdENvZGU6IDEzNyB9KV0sXG4gIF0pO1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBjYXB0dXJlUnVudGltZUVycm9ycyh7XG4gICAgZ2V0UHJvY2Vzc2VzOiAoKSA9PiBwcm9jZXNzZXMsXG4gICAgZ2V0Q29uc29sZUxvZ3M6ICgpID0+IFtdLFxuICB9KTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5sZW5ndGgsIDEpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0WzBdLnNldmVyaXR5LCBcImNyYXNoXCIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0WzBdLmJsb2NraW5nLCB0cnVlKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdFswXS5tZXNzYWdlLmluY2x1ZGVzKFwiZXhpdENvZGU9MTM3XCIpKTtcbn0pO1xuXG50ZXN0KFwiY2FwdHVyZVJ1bnRpbWVFcnJvcnM6IGJnLXNoZWxsIFNJR0FCUlQvU0lHU0VHVi9TSUdCVVMgXHUyMTkyIGJsb2NraW5nIGNyYXNoIGVycm9yXCIsIGFzeW5jICgpID0+IHtcbiAgZm9yIChjb25zdCBzaWcgb2YgW1wiU0lHQUJSVFwiLCBcIlNJR1NFR1ZcIiwgXCJTSUdCVVNcIl0pIHtcbiAgICBjb25zdCBwcm9jZXNzZXMgPSBuZXcgTWFwPHN0cmluZywgdW5rbm93bj4oW1xuICAgICAgW1wicDFcIiwgbWFrZVByb2MoeyBzaWduYWw6IHNpZywgYWxpdmU6IGZhbHNlLCBleGl0Q29kZTogbnVsbCB9KV0sXG4gICAgXSk7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2FwdHVyZVJ1bnRpbWVFcnJvcnMoe1xuICAgICAgZ2V0UHJvY2Vzc2VzOiAoKSA9PiBwcm9jZXNzZXMsXG4gICAgICBnZXRDb25zb2xlTG9nczogKCkgPT4gW10sXG4gICAgfSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5sZW5ndGgsIDEsIGAke3NpZ30gc2hvdWxkIHByb2R1Y2UgMSBlcnJvcmApO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHRbMF0uc2V2ZXJpdHksIFwiY3Jhc2hcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdFswXS5ibG9ja2luZywgdHJ1ZSk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdFswXS5tZXNzYWdlLmluY2x1ZGVzKHNpZyksIGBtZXNzYWdlIHNob3VsZCBjb250YWluICR7c2lnfWApO1xuICB9XG59KTtcblxudGVzdChcImNhcHR1cmVSdW50aW1lRXJyb3JzOiBhbGl2ZSBiZy1zaGVsbCBwcm9jZXNzIHdpdGggcmVjZW50RXJyb3JzIFx1MjE5MiBub24tYmxvY2tpbmcgZXJyb3JcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBwcm9jZXNzZXMgPSBuZXcgTWFwPHN0cmluZywgdW5rbm93bj4oW1xuICAgIFtcInAxXCIsIG1ha2VQcm9jKHsgYWxpdmU6IHRydWUsIHJlY2VudEVycm9yczogW1wiVHlwZUVycm9yOiBmb29cIiwgXCJSYW5nZUVycm9yOiBiYXJcIl0gfSldLFxuICBdKTtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2FwdHVyZVJ1bnRpbWVFcnJvcnMoe1xuICAgIGdldFByb2Nlc3NlczogKCkgPT4gcHJvY2Vzc2VzLFxuICAgIGdldENvbnNvbGVMb2dzOiAoKSA9PiBbXSxcbiAgfSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQubGVuZ3RoLCAxKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdFswXS5zb3VyY2UsIFwiYmctc2hlbGxcIik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHRbMF0uc2V2ZXJpdHksIFwiZXJyb3JcIik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHRbMF0uYmxvY2tpbmcsIGZhbHNlKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdFswXS5tZXNzYWdlLmluY2x1ZGVzKFwiVHlwZUVycm9yOiBmb29cIikpO1xuICBhc3NlcnQub2socmVzdWx0WzBdLm1lc3NhZ2UuaW5jbHVkZXMoXCJSYW5nZUVycm9yOiBiYXJcIikpO1xufSk7XG5cbnRlc3QoXCJjYXB0dXJlUnVudGltZUVycm9yczogYnJvd3NlciB1bmhhbmRsZWQgcmVqZWN0aW9uIFx1MjE5MiBibG9ja2luZyBjcmFzaCBlcnJvclwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGxvZ3MgPSBtYWtlTG9ncyhbXG4gICAgeyB0eXBlOiBcImVycm9yXCIsIHRleHQ6IFwiVW5oYW5kbGVkIHByb21pc2UgcmVqZWN0aW9uOiBzb21lIGVycm9yXCIgfSxcbiAgXSk7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNhcHR1cmVSdW50aW1lRXJyb3JzKHtcbiAgICBnZXRQcm9jZXNzZXM6ICgpID0+IG5ldyBNYXAoKSxcbiAgICBnZXRDb25zb2xlTG9nczogKCkgPT4gbG9ncyxcbiAgfSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQubGVuZ3RoLCAxKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdFswXS5zb3VyY2UsIFwiYnJvd3NlclwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdFswXS5zZXZlcml0eSwgXCJjcmFzaFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdFswXS5ibG9ja2luZywgdHJ1ZSk7XG4gIGFzc2VydC5vayhyZXN1bHRbMF0ubWVzc2FnZS5pbmNsdWRlcyhcIlVuaGFuZGxlZFwiKSk7XG59KTtcblxudGVzdChcImNhcHR1cmVSdW50aW1lRXJyb3JzOiBicm93c2VyIFVuaGFuZGxlZFJlamVjdGlvbiAoY2FzZSB2YXJpYXRpb24pIFx1MjE5MiBibG9ja2luZyBjcmFzaFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGxvZ3MgPSBtYWtlTG9ncyhbXG4gICAgeyB0eXBlOiBcImVycm9yXCIsIHRleHQ6IFwiVW5oYW5kbGVkUmVqZWN0aW9uIGluIG1vZHVsZSBYXCIgfSxcbiAgXSk7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNhcHR1cmVSdW50aW1lRXJyb3JzKHtcbiAgICBnZXRQcm9jZXNzZXM6ICgpID0+IG5ldyBNYXAoKSxcbiAgICBnZXRDb25zb2xlTG9nczogKCkgPT4gbG9ncyxcbiAgfSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQubGVuZ3RoLCAxKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdFswXS5zZXZlcml0eSwgXCJjcmFzaFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdFswXS5ibG9ja2luZywgdHJ1ZSk7XG59KTtcblxudGVzdChcImNhcHR1cmVSdW50aW1lRXJyb3JzOiBicm93c2VyIGNvbnNvbGUuZXJyb3IgKGdlbmVyYWwpIFx1MjE5MiBub24tYmxvY2tpbmcgZXJyb3JcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBsb2dzID0gbWFrZUxvZ3MoW1xuICAgIHsgdHlwZTogXCJlcnJvclwiLCB0ZXh0OiBcIkZhaWxlZCB0byBsb2FkIHJlc291cmNlOiBuZXQ6OkVSUl9GQUlMRURcIiB9LFxuICBdKTtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2FwdHVyZVJ1bnRpbWVFcnJvcnMoe1xuICAgIGdldFByb2Nlc3NlczogKCkgPT4gbmV3IE1hcCgpLFxuICAgIGdldENvbnNvbGVMb2dzOiAoKSA9PiBsb2dzLFxuICB9KTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5sZW5ndGgsIDEpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0WzBdLnNvdXJjZSwgXCJicm93c2VyXCIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0WzBdLnNldmVyaXR5LCBcImVycm9yXCIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0WzBdLmJsb2NraW5nLCBmYWxzZSk7XG59KTtcblxudGVzdChcImNhcHR1cmVSdW50aW1lRXJyb3JzOiBicm93c2VyIGRlcHJlY2F0aW9uIHdhcm5pbmcgXHUyMTkyIG5vbi1ibG9ja2luZyB3YXJuaW5nXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgbG9ncyA9IG1ha2VMb2dzKFtcbiAgICB7IHR5cGU6IFwid2FybmluZ1wiLCB0ZXh0OiBcIkV2ZW50LnJldHVyblZhbHVlIGlzIGRlcHJlY2F0ZWQuIFVzZSBFdmVudC5wcmV2ZW50RGVmYXVsdCgpIGluc3RlYWQuXCIgfSxcbiAgXSk7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNhcHR1cmVSdW50aW1lRXJyb3JzKHtcbiAgICBnZXRQcm9jZXNzZXM6ICgpID0+IG5ldyBNYXAoKSxcbiAgICBnZXRDb25zb2xlTG9nczogKCkgPT4gbG9ncyxcbiAgfSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQubGVuZ3RoLCAxKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdFswXS5zb3VyY2UsIFwiYnJvd3NlclwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdFswXS5zZXZlcml0eSwgXCJ3YXJuaW5nXCIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0WzBdLmJsb2NraW5nLCBmYWxzZSk7XG4gIGFzc2VydC5vayhyZXN1bHRbMF0ubWVzc2FnZS5pbmNsdWRlcyhcImRlcHJlY2F0ZWRcIikpO1xufSk7XG5cbnRlc3QoXCJjYXB0dXJlUnVudGltZUVycm9yczogbm9uLWRlcHJlY2F0aW9uIHdhcm5pbmcgaXMgaWdub3JlZFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGxvZ3MgPSBtYWtlTG9ncyhbXG4gICAgeyB0eXBlOiBcIndhcm5pbmdcIiwgdGV4dDogXCJTb21lIGdlbmVyYWwgd2FybmluZyBhYm91dCBwZXJmb3JtYW5jZVwiIH0sXG4gIF0pO1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBjYXB0dXJlUnVudGltZUVycm9ycyh7XG4gICAgZ2V0UHJvY2Vzc2VzOiAoKSA9PiBuZXcgTWFwKCksXG4gICAgZ2V0Q29uc29sZUxvZ3M6ICgpID0+IGxvZ3MsXG4gIH0pO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0Lmxlbmd0aCwgMCwgXCJub24tZGVwcmVjYXRpb24gd2FybmluZ3Mgc2hvdWxkIGJlIGlnbm9yZWRcIik7XG59KTtcblxudGVzdChcImNhcHR1cmVSdW50aW1lRXJyb3JzOiBubyBwcm9jZXNzZXMsIG5vIGJyb3dzZXIgbG9ncyBcdTIxOTIgZW1wdHkgYXJyYXlcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBjYXB0dXJlUnVudGltZUVycm9ycyh7XG4gICAgZ2V0UHJvY2Vzc2VzOiAoKSA9PiBuZXcgTWFwKCksXG4gICAgZ2V0Q29uc29sZUxvZ3M6ICgpID0+IFtdLFxuICB9KTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQsIFtdKTtcbn0pO1xuXG50ZXN0KFwiY2FwdHVyZVJ1bnRpbWVFcnJvcnM6IGR5bmFtaWMgaW1wb3J0IGZhaWx1cmUgXHUyMTkyIGdyYWNlZnVsIGVtcHR5IGFycmF5XCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2FwdHVyZVJ1bnRpbWVFcnJvcnMoe1xuICAgIGdldFByb2Nlc3NlczogKCkgPT4geyB0aHJvdyBuZXcgRXJyb3IoXCJtb2R1bGUgbm90IGZvdW5kXCIpOyB9LFxuICAgIGdldENvbnNvbGVMb2dzOiAoKSA9PiB7IHRocm93IG5ldyBFcnJvcihcIm1vZHVsZSBub3QgZm91bmRcIik7IH0sXG4gIH0pO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdCwgW10pO1xufSk7XG5cbnRlc3QoXCJjYXB0dXJlUnVudGltZUVycm9yczogYnJvd3NlciB0ZXh0IHRydW5jYXRlZCB0byA1MDAgY2hhcnNcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBsb25nVGV4dCA9IFwieFwiLnJlcGVhdCg2MDApO1xuICBjb25zdCBsb2dzID0gbWFrZUxvZ3MoW1xuICAgIHsgdHlwZTogXCJlcnJvclwiLCB0ZXh0OiBsb25nVGV4dCB9LFxuICBdKTtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2FwdHVyZVJ1bnRpbWVFcnJvcnMoe1xuICAgIGdldFByb2Nlc3NlczogKCkgPT4gbmV3IE1hcCgpLFxuICAgIGdldENvbnNvbGVMb2dzOiAoKSA9PiBsb2dzLFxuICB9KTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5sZW5ndGgsIDEpO1xuICBhc3NlcnQub2socmVzdWx0WzBdLm1lc3NhZ2UubGVuZ3RoIDw9IDUwMCArIDIwLCBcIm1lc3NhZ2Ugc2hvdWxkIGJlIHRydW5jYXRlZCBuZWFyIDUwMCBjaGFyc1wiKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdFswXS5tZXNzYWdlLmluY2x1ZGVzKFwiXHUyMDI2W3RydW5jYXRlZF1cIiksIFwic2hvdWxkIGluY2x1ZGUgdHJ1bmNhdGlvbiBtYXJrZXJcIik7XG4gIGFzc2VydC5vayghcmVzdWx0WzBdLm1lc3NhZ2UuaW5jbHVkZXMoXCJ4XCIucmVwZWF0KDUwMSkpLCBcInNob3VsZCBub3QgY29udGFpbiA1MDErIHgnc1wiKTtcbn0pO1xuXG50ZXN0KFwiY2FwdHVyZVJ1bnRpbWVFcnJvcnM6IGJnLXNoZWxsIHJlY2VudEVycm9ycyBsaW1pdGVkIHRvIDMgaW4gbWVzc2FnZVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHByb2Nlc3NlcyA9IG5ldyBNYXA8c3RyaW5nLCB1bmtub3duPihbXG4gICAgW1wicDFcIiwgbWFrZVByb2Moe1xuICAgICAgc3RhdHVzOiBcImNyYXNoZWRcIixcbiAgICAgIGFsaXZlOiBmYWxzZSxcbiAgICAgIGV4aXRDb2RlOiAxLFxuICAgICAgcmVjZW50RXJyb3JzOiBbXCJlcnIxXCIsIFwiZXJyMlwiLCBcImVycjNcIiwgXCJlcnI0XCIsIFwiZXJyNVwiXSxcbiAgICB9KV0sXG4gIF0pO1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBjYXB0dXJlUnVudGltZUVycm9ycyh7XG4gICAgZ2V0UHJvY2Vzc2VzOiAoKSA9PiBwcm9jZXNzZXMsXG4gICAgZ2V0Q29uc29sZUxvZ3M6ICgpID0+IFtdLFxuICB9KTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5sZW5ndGgsIDEpO1xuICBhc3NlcnQub2socmVzdWx0WzBdLm1lc3NhZ2UuaW5jbHVkZXMoXCJlcnIxXCIpKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdFswXS5tZXNzYWdlLmluY2x1ZGVzKFwiZXJyMlwiKSk7XG4gIGFzc2VydC5vayhyZXN1bHRbMF0ubWVzc2FnZS5pbmNsdWRlcyhcImVycjNcIikpO1xuICBhc3NlcnQub2soIXJlc3VsdFswXS5tZXNzYWdlLmluY2x1ZGVzKFwiZXJyNFwiKSwgXCJzaG91bGQgb25seSBpbmNsdWRlIGZpcnN0IDMgZXJyb3JzXCIpO1xufSk7XG5cbnRlc3QoXCJjYXB0dXJlUnVudGltZUVycm9yczogbWl4ZWQgYmctc2hlbGwgYW5kIGJyb3dzZXIgZXJyb3JzXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgcHJvY2Vzc2VzID0gbmV3IE1hcDxzdHJpbmcsIHVua25vd24+KFtcbiAgICBbXCJwMVwiLCBtYWtlUHJvYyh7IHN0YXR1czogXCJjcmFzaGVkXCIsIGFsaXZlOiBmYWxzZSwgZXhpdENvZGU6IDEgfSldLFxuICBdKTtcbiAgY29uc3QgbG9ncyA9IG1ha2VMb2dzKFtcbiAgICB7IHR5cGU6IFwiZXJyb3JcIiwgdGV4dDogXCJVbmhhbmRsZWQgcmVqZWN0aW9uOiBib29tXCIgfSxcbiAgICB7IHR5cGU6IFwiZXJyb3JcIiwgdGV4dDogXCJnZW5lcmFsIGVycm9yXCIgfSxcbiAgICB7IHR5cGU6IFwid2FybmluZ1wiLCB0ZXh0OiBcImRlcHJlY2F0ZWQgQVBJIHVzZWRcIiB9LFxuICBdKTtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2FwdHVyZVJ1bnRpbWVFcnJvcnMoe1xuICAgIGdldFByb2Nlc3NlczogKCkgPT4gcHJvY2Vzc2VzLFxuICAgIGdldENvbnNvbGVMb2dzOiAoKSA9PiBsb2dzLFxuICB9KTtcbiAgLy8gMSBiZy1zaGVsbCBjcmFzaCArIDEgYnJvd3NlciBjcmFzaCAodW5oYW5kbGVkKSArIDEgYnJvd3NlciBlcnJvciArIDEgYnJvd3NlciB3YXJuaW5nXG4gIGFzc2VydC5lcXVhbChyZXN1bHQubGVuZ3RoLCA0KTtcbiAgY29uc3QgYmxvY2tpbmcgPSByZXN1bHQuZmlsdGVyKHIgPT4gci5ibG9ja2luZyk7XG4gIGNvbnN0IG5vbkJsb2NraW5nID0gcmVzdWx0LmZpbHRlcihyID0+ICFyLmJsb2NraW5nKTtcbiAgYXNzZXJ0LmVxdWFsKGJsb2NraW5nLmxlbmd0aCwgMiwgXCJzaG91bGQgaGF2ZSAyIGJsb2NraW5nIGVycm9yc1wiKTtcbiAgYXNzZXJ0LmVxdWFsKG5vbkJsb2NraW5nLmxlbmd0aCwgMiwgXCJzaG91bGQgaGF2ZSAyIG5vbi1ibG9ja2luZyBlcnJvcnNcIik7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIERlcGVuZGVuY3kgQXVkaXQgVGVzdHMgKFMwNS9UMDEpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKiogSGVscGVyOiBidWlsZCBhIHJlYWxpc3RpYyBucG0gYXVkaXQgSlNPTiBzdGRvdXQgd2l0aCB2dWxuZXJhYmlsaXRpZXMuICovXG5mdW5jdGlvbiBtYWtlQXVkaXRKc29uKFxuICB2dWxuczogUmVjb3JkPHN0cmluZywgeyBzZXZlcml0eTogc3RyaW5nOyBmaXhBdmFpbGFibGU6IGJvb2xlYW47IHZpYTogdW5rbm93bltdIH0+LFxuKTogc3RyaW5nIHtcbiAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHsgdnVsbmVyYWJpbGl0aWVzOiB2dWxucyB9KTtcbn1cblxuLyoqIFNhbXBsZSBucG0gYXVkaXQgSlNPTiB3aXRoIGEgaGlnaC1zZXZlcml0eSB2dWxuLiAqL1xuY29uc3QgU0FNUExFX0FVRElUX0pTT04gPSBtYWtlQXVkaXRKc29uKHtcbiAgXCJudGgtY2hlY2tcIjoge1xuICAgIHNldmVyaXR5OiBcImhpZ2hcIixcbiAgICBmaXhBdmFpbGFibGU6IHRydWUsXG4gICAgdmlhOiBbXG4gICAgICB7XG4gICAgICAgIHRpdGxlOiBcIkluZWZmaWNpZW50IFJlZ3VsYXIgRXhwcmVzc2lvbiBDb21wbGV4aXR5IGluIG50aC1jaGVja1wiLFxuICAgICAgICB1cmw6IFwiaHR0cHM6Ly9naXRodWIuY29tL2Fkdmlzb3JpZXMvR0hTQS1ycDY1LTljZjMtY2p4clwiLFxuICAgICAgICBzZXZlcml0eTogXCJoaWdoXCIsXG4gICAgICB9LFxuICAgIF0sXG4gIH0sXG59KTtcblxudGVzdChcImRlcGVuZGVuY3ktYXVkaXQ6IHBhY2thZ2UuanNvbiBpbiBnaXQgZGlmZiBcdTIxOTIgcnVucyBucG0gYXVkaXQgYW5kIHBhcnNlcyB2dWxuZXJhYmlsaXRpZXNcIiwgKCkgPT4ge1xuICBsZXQgbnBtQXVkaXRDYWxsZWQgPSBmYWxzZTtcbiAgY29uc3QgcmVzdWx0ID0gcnVuRGVwZW5kZW5jeUF1ZGl0KFwiL3RtcC90ZXN0XCIsIHtcbiAgICBnaXREaWZmOiAoKSA9PiBbXCJwYWNrYWdlLmpzb25cIiwgXCJzcmMvaW5kZXgudHNcIl0sXG4gICAgbnBtQXVkaXQ6ICgpID0+IHtcbiAgICAgIG5wbUF1ZGl0Q2FsbGVkID0gdHJ1ZTtcbiAgICAgIHJldHVybiB7IHN0ZG91dDogU0FNUExFX0FVRElUX0pTT04sIGV4aXRDb2RlOiAwIH07XG4gICAgfSxcbiAgfSk7XG4gIGFzc2VydC5lcXVhbChucG1BdWRpdENhbGxlZCwgdHJ1ZSwgXCJucG0gYXVkaXQgc2hvdWxkIGJlIGNhbGxlZFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5sZW5ndGgsIDEpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0WzBdLm5hbWUsIFwibnRoLWNoZWNrXCIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0WzBdLnNldmVyaXR5LCBcImhpZ2hcIik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHRbMF0udGl0bGUsIFwiSW5lZmZpY2llbnQgUmVndWxhciBFeHByZXNzaW9uIENvbXBsZXhpdHkgaW4gbnRoLWNoZWNrXCIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0WzBdLnVybCwgXCJodHRwczovL2dpdGh1Yi5jb20vYWR2aXNvcmllcy9HSFNBLXJwNjUtOWNmMy1janhyXCIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0WzBdLmZpeEF2YWlsYWJsZSwgdHJ1ZSk7XG59KTtcblxudGVzdChcImRlcGVuZGVuY3ktYXVkaXQ6IHBhY2thZ2UtbG9jay5qc29uIGNoYW5nZSB0cmlnZ2VycyBhdWRpdFwiLCAoKSA9PiB7XG4gIGxldCBucG1BdWRpdENhbGxlZCA9IGZhbHNlO1xuICBjb25zdCByZXN1bHQgPSBydW5EZXBlbmRlbmN5QXVkaXQoXCIvdG1wL3Rlc3RcIiwge1xuICAgIGdpdERpZmY6ICgpID0+IFtcInBhY2thZ2UtbG9jay5qc29uXCJdLFxuICAgIG5wbUF1ZGl0OiAoKSA9PiB7XG4gICAgICBucG1BdWRpdENhbGxlZCA9IHRydWU7XG4gICAgICByZXR1cm4geyBzdGRvdXQ6IFNBTVBMRV9BVURJVF9KU09OLCBleGl0Q29kZTogMCB9O1xuICAgIH0sXG4gIH0pO1xuICBhc3NlcnQuZXF1YWwobnBtQXVkaXRDYWxsZWQsIHRydWUpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0Lmxlbmd0aCwgMSk7XG59KTtcblxudGVzdChcImRlcGVuZGVuY3ktYXVkaXQ6IHBucG0tbG9jay55YW1sIGNoYW5nZSB0cmlnZ2VycyBhdWRpdFwiLCAoKSA9PiB7XG4gIGxldCBucG1BdWRpdENhbGxlZCA9IGZhbHNlO1xuICBydW5EZXBlbmRlbmN5QXVkaXQoXCIvdG1wL3Rlc3RcIiwge1xuICAgIGdpdERpZmY6ICgpID0+IFtcInBucG0tbG9jay55YW1sXCJdLFxuICAgIG5wbUF1ZGl0OiAoKSA9PiB7XG4gICAgICBucG1BdWRpdENhbGxlZCA9IHRydWU7XG4gICAgICByZXR1cm4geyBzdGRvdXQ6IFNBTVBMRV9BVURJVF9KU09OLCBleGl0Q29kZTogMCB9O1xuICAgIH0sXG4gIH0pO1xuICBhc3NlcnQuZXF1YWwobnBtQXVkaXRDYWxsZWQsIHRydWUpO1xufSk7XG5cbnRlc3QoXCJkZXBlbmRlbmN5LWF1ZGl0OiB5YXJuLmxvY2sgY2hhbmdlIHRyaWdnZXJzIGF1ZGl0XCIsICgpID0+IHtcbiAgbGV0IG5wbUF1ZGl0Q2FsbGVkID0gZmFsc2U7XG4gIHJ1bkRlcGVuZGVuY3lBdWRpdChcIi90bXAvdGVzdFwiLCB7XG4gICAgZ2l0RGlmZjogKCkgPT4gW1wieWFybi5sb2NrXCJdLFxuICAgIG5wbUF1ZGl0OiAoKSA9PiB7XG4gICAgICBucG1BdWRpdENhbGxlZCA9IHRydWU7XG4gICAgICByZXR1cm4geyBzdGRvdXQ6IFNBTVBMRV9BVURJVF9KU09OLCBleGl0Q29kZTogMCB9O1xuICAgIH0sXG4gIH0pO1xuICBhc3NlcnQuZXF1YWwobnBtQXVkaXRDYWxsZWQsIHRydWUpO1xufSk7XG5cbnRlc3QoXCJkZXBlbmRlbmN5LWF1ZGl0OiBidW4ubG9ja2IgY2hhbmdlIHRyaWdnZXJzIGF1ZGl0XCIsICgpID0+IHtcbiAgbGV0IG5wbUF1ZGl0Q2FsbGVkID0gZmFsc2U7XG4gIHJ1bkRlcGVuZGVuY3lBdWRpdChcIi90bXAvdGVzdFwiLCB7XG4gICAgZ2l0RGlmZjogKCkgPT4gW1wiYnVuLmxvY2tiXCJdLFxuICAgIG5wbUF1ZGl0OiAoKSA9PiB7XG4gICAgICBucG1BdWRpdENhbGxlZCA9IHRydWU7XG4gICAgICByZXR1cm4geyBzdGRvdXQ6IFNBTVBMRV9BVURJVF9KU09OLCBleGl0Q29kZTogMCB9O1xuICAgIH0sXG4gIH0pO1xuICBhc3NlcnQuZXF1YWwobnBtQXVkaXRDYWxsZWQsIHRydWUpO1xufSk7XG5cbnRlc3QoXCJkZXBlbmRlbmN5LWF1ZGl0OiBubyBkZXBlbmRlbmN5IGZpbGUgY2hhbmdlcyBcdTIxOTIgcmV0dXJucyBlbXB0eSBhcnJheSwgbnBtIGF1ZGl0IG5vdCBjYWxsZWRcIiwgKCkgPT4ge1xuICBsZXQgbnBtQXVkaXRDYWxsZWQgPSBmYWxzZTtcbiAgY29uc3QgcmVzdWx0ID0gcnVuRGVwZW5kZW5jeUF1ZGl0KFwiL3RtcC90ZXN0XCIsIHtcbiAgICBnaXREaWZmOiAoKSA9PiBbXCJzcmMvaW5kZXgudHNcIiwgXCJSRUFETUUubWRcIl0sXG4gICAgbnBtQXVkaXQ6ICgpID0+IHtcbiAgICAgIG5wbUF1ZGl0Q2FsbGVkID0gdHJ1ZTtcbiAgICAgIHJldHVybiB7IHN0ZG91dDogXCJ7fVwiLCBleGl0Q29kZTogMCB9O1xuICAgIH0sXG4gIH0pO1xuICBhc3NlcnQuZXF1YWwobnBtQXVkaXRDYWxsZWQsIGZhbHNlLCBcIm5wbSBhdWRpdCBzaG91bGQgTk9UIGJlIGNhbGxlZCB3aGVuIG5vIGRlcGVuZGVuY3kgZmlsZXMgY2hhbmdlZFwiKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQsIFtdKTtcbn0pO1xuXG50ZXN0KFwiZGVwZW5kZW5jeS1hdWRpdDogZ2l0IGRpZmYgcmV0dXJucyBub24temVybyBleGl0IChub3QgYSBnaXQgcmVwbykgXHUyMTkyIGVtcHR5IGFycmF5XCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gcnVuRGVwZW5kZW5jeUF1ZGl0KFwiL3RtcC90ZXN0XCIsIHtcbiAgICBnaXREaWZmOiAoKSA9PiB7IHRocm93IG5ldyBFcnJvcihcIm5vdCBhIGdpdCByZXBvXCIpOyB9LFxuICAgIG5wbUF1ZGl0OiAoKSA9PiB7IHRocm93IG5ldyBFcnJvcihcInNob3VsZCBub3QgYmUgY2FsbGVkXCIpOyB9LFxuICB9KTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQsIFtdKTtcbn0pO1xuXG50ZXN0KFwiZGVwZW5kZW5jeS1hdWRpdDogbnBtIGF1ZGl0IHJldHVybnMgaW52YWxpZCBKU09OIFx1MjE5MiBlbXB0eSBhcnJheVwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHJ1bkRlcGVuZGVuY3lBdWRpdChcIi90bXAvdGVzdFwiLCB7XG4gICAgZ2l0RGlmZjogKCkgPT4gW1wicGFja2FnZS5qc29uXCJdLFxuICAgIG5wbUF1ZGl0OiAoKSA9PiAoeyBzdGRvdXQ6IFwibm90IGpzb24gYXQgYWxsXCIsIGV4aXRDb2RlOiAxIH0pLFxuICB9KTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQsIFtdKTtcbn0pO1xuXG50ZXN0KFwiZGVwZW5kZW5jeS1hdWRpdDogbnBtIGF1ZGl0IHJldHVybnMgemVybyB2dWxuZXJhYmlsaXRpZXMgXHUyMTkyIGVtcHR5IGFycmF5XCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gcnVuRGVwZW5kZW5jeUF1ZGl0KFwiL3RtcC90ZXN0XCIsIHtcbiAgICBnaXREaWZmOiAoKSA9PiBbXCJwYWNrYWdlLmpzb25cIl0sXG4gICAgbnBtQXVkaXQ6ICgpID0+ICh7XG4gICAgICBzdGRvdXQ6IEpTT04uc3RyaW5naWZ5KHsgdnVsbmVyYWJpbGl0aWVzOiB7fSB9KSxcbiAgICAgIGV4aXRDb2RlOiAwLFxuICAgIH0pLFxuICB9KTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQsIFtdKTtcbn0pO1xuXG50ZXN0KFwiZGVwZW5kZW5jeS1hdWRpdDogbnBtIGF1ZGl0IG5vbi16ZXJvIGV4aXQgd2l0aCB2YWxpZCBKU09OIFx1MjE5MiBwYXJzZXMgY29ycmVjdGx5XCIsICgpID0+IHtcbiAgLy8gbnBtIGF1ZGl0IGV4aXRzIG5vbi16ZXJvIHdoZW4gdnVsbmVyYWJpbGl0aWVzIGV4aXN0IFx1MjAxNCB0aGlzIGlzIGV4cGVjdGVkLCBub3QgYW4gZXJyb3JcbiAgY29uc3QgcmVzdWx0ID0gcnVuRGVwZW5kZW5jeUF1ZGl0KFwiL3RtcC90ZXN0XCIsIHtcbiAgICBnaXREaWZmOiAoKSA9PiBbXCJwYWNrYWdlLWxvY2suanNvblwiXSxcbiAgICBucG1BdWRpdDogKCkgPT4gKHtcbiAgICAgIHN0ZG91dDogU0FNUExFX0FVRElUX0pTT04sXG4gICAgICBleGl0Q29kZTogMSwgLy8gbm9uLXplcm8hXG4gICAgfSksXG4gIH0pO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0Lmxlbmd0aCwgMSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHRbMF0ubmFtZSwgXCJudGgtY2hlY2tcIik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHRbMF0uc2V2ZXJpdHksIFwiaGlnaFwiKTtcbn0pO1xuXG50ZXN0KFwiZGVwZW5kZW5jeS1hdWRpdDogdmlhIGVudHJpZXMgd2l0aCBzdHJpbmctb25seSB2YWx1ZXMgYXJlIHNraXBwZWRcIiwgKCkgPT4ge1xuICBjb25zdCBhdWRpdEpzb24gPSBtYWtlQXVkaXRKc29uKHtcbiAgICBcInBvc3Rjc3NcIjoge1xuICAgICAgc2V2ZXJpdHk6IFwibW9kZXJhdGVcIixcbiAgICAgIGZpeEF2YWlsYWJsZTogZmFsc2UsXG4gICAgICB2aWE6IFtcIm50aC1jaGVja1wiLCBcImNzcy1zZWxlY3RcIl0sIC8vIHN0cmluZy1vbmx5IHZpYSBlbnRyaWVzXG4gICAgfSxcbiAgfSk7XG4gIGNvbnN0IHJlc3VsdCA9IHJ1bkRlcGVuZGVuY3lBdWRpdChcIi90bXAvdGVzdFwiLCB7XG4gICAgZ2l0RGlmZjogKCkgPT4gW1wicGFja2FnZS5qc29uXCJdLFxuICAgIG5wbUF1ZGl0OiAoKSA9PiAoeyBzdGRvdXQ6IGF1ZGl0SnNvbiwgZXhpdENvZGU6IDEgfSksXG4gIH0pO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0Lmxlbmd0aCwgMSk7XG4gIC8vIFdoZW4gbm8gb2JqZWN0IHZpYSBlbnRyeSBpcyBmb3VuZCwgdGl0bGUgZmFsbHMgYmFjayB0byB0aGUgcGFja2FnZSBuYW1lXG4gIGFzc2VydC5lcXVhbChyZXN1bHRbMF0ubmFtZSwgXCJwb3N0Y3NzXCIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0WzBdLnRpdGxlLCBcInBvc3Rjc3NcIik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHRbMF0udXJsLCBcIlwiKTtcbn0pO1xuXG50ZXN0KFwiZGVwZW5kZW5jeS1hdWRpdDogc3ViZGlyZWN0b3J5IHBhY2thZ2UuanNvbiBkb2VzIG5vdCB0cmlnZ2VyIGF1ZGl0XCIsICgpID0+IHtcbiAgbGV0IG5wbUF1ZGl0Q2FsbGVkID0gZmFsc2U7XG4gIGNvbnN0IHJlc3VsdCA9IHJ1bkRlcGVuZGVuY3lBdWRpdChcIi90bXAvdGVzdFwiLCB7XG4gICAgZ2l0RGlmZjogKCkgPT4gW1wicGFja2FnZXMvZm9vL3BhY2thZ2UuanNvblwiLCBcImxpYnMvYmFyL3BhY2thZ2UtbG9jay5qc29uXCJdLFxuICAgIG5wbUF1ZGl0OiAoKSA9PiB7XG4gICAgICBucG1BdWRpdENhbGxlZCA9IHRydWU7XG4gICAgICByZXR1cm4geyBzdGRvdXQ6IFNBTVBMRV9BVURJVF9KU09OLCBleGl0Q29kZTogMCB9O1xuICAgIH0sXG4gIH0pO1xuICBhc3NlcnQuZXF1YWwobnBtQXVkaXRDYWxsZWQsIGZhbHNlLCBcInN1YmRpcmVjdG9yeSBkZXBlbmRlbmN5IGZpbGVzIHNob3VsZCBub3QgdHJpZ2dlciBhdWRpdFwiKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQsIFtdKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUHl0aG9uIG5vcm1hbGl6YXRpb24gKHJlZ3Jlc3Npb246ICM0NDE2KSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbi8vIFZlcmlmaWNhdGlvbiBjb21tYW5kcyB1c2luZyBweXRob24zL3B5dGhvbiBtdXN0IHN1Y2NlZWQgZXZlbiB3aGVuIG9ubHkgdGhlXG4vLyBhbHRlcm5hdGUgaW50ZXJwcmV0ZXIgbmFtZSBpcyBhdmFpbGFibGUuIFRoZSBnYXRlIHJld3JpdGVzIHRoZSBjb21tYW5kIHZpYVxuLy8gbm9ybWFsaXplUHl0aG9uQ29tbWFuZCBiZWZvcmUgc3Bhd25pbmcgXHUyMDE0IHRlc3RlZCBoZXJlIGVuZC10by1lbmQgb24gdGhpcyBob3N0LlxuXG5kZXNjcmliZShcInZlcmlmaWNhdGlvbi1nYXRlOiBweXRob24gbm9ybWFsaXphdGlvbiAoIzQ0MTYpXCIsICgpID0+IHtcbiAgbGV0IHRtcDogc3RyaW5nO1xuICBiZWZvcmVFYWNoKCgpID0+IHsgdG1wID0gbWFrZVRlbXBEaXIoXCJ2Zy1weXRob25cIik7IH0pO1xuICBhZnRlckVhY2goKCkgPT4geyBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0pO1xuXG4gIHRlc3QoXCJweXRob24zIC0tdmVyc2lvbiBjb21tYW5kIHN1Y2NlZWRzIG9uIHRoaXMgaG9zdCAoZ2F0ZSB1c2VzIG5vcm1hbGl6ZWQgaW52b2NhdGlvbilcIiwgKCkgPT4ge1xuICAgIC8vIFRoaXMgdGVzdCB2ZXJpZmllcyB0aGF0IHJ1blZlcmlmaWNhdGlvbkdhdGUgY2FuIGV4ZWN1dGUgYSBweXRob24gY29tbWFuZFxuICAgIC8vIHdpdGhvdXQgaGFyZC1mYWlsaW5nIGR1ZSB0byBpbnRlcnByZXRlciBuYW1lIG1pc21hdGNoLiBPbiBob3N0cyB3aGVyZVxuICAgIC8vIHB5dGhvbjMgaXMgYXZhaWxhYmxlIGl0IHJ1bnMgZGlyZWN0bHk7IG9uIGhvc3RzIHdoZXJlIG9ubHkgcHl0aG9uIG9yIHB5XG4gICAgLy8gZXhpc3RzLCBub3JtYWxpemVQeXRob25Db21tYW5kIHJld3JpdGVzIHRoZSB0b2tlbiBiZWZvcmUgc3Bhd25TeW5jLlxuICAgIGNvbnN0IHJlc3VsdCA9IHJ1blZlcmlmaWNhdGlvbkdhdGUoe1xuICAgICAgY3dkOiB0bXAsXG4gICAgICBwcmVmZXJlbmNlQ29tbWFuZHM6IFtcInB5dGhvbjMgLS12ZXJzaW9uXCJdLFxuICAgIH0pO1xuICAgIGFzc2VydC5lcXVhbCh0eXBlb2YgcmVzdWx0LnBhc3NlZCwgXCJib29sZWFuXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuY2hlY2tzLmxlbmd0aCwgMSk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5jaGVja3NbMF0uZHVyYXRpb25NcyA+PSAwKTtcbiAgfSk7XG5cbiAgdGVzdChcInB5dGhvbiAtLXZlcnNpb24gY29tbWFuZCBwcm9kdWNlcyBhIFZlcmlmaWNhdGlvblJlc3VsdCAobm90IGEgY3Jhc2gpXCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBydW5WZXJpZmljYXRpb25HYXRlKHtcbiAgICAgIGN3ZDogdG1wLFxuICAgICAgcHJlZmVyZW5jZUNvbW1hbmRzOiBbXCJweXRob24gLS12ZXJzaW9uXCJdLFxuICAgIH0pO1xuICAgIGFzc2VydC5lcXVhbCh0eXBlb2YgcmVzdWx0LnBhc3NlZCwgXCJib29sZWFuXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuY2hlY2tzLmxlbmd0aCwgMSk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5jaGVja3NbMF0uZHVyYXRpb25NcyA+PSAwKTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQWlCQSxTQUFTLFVBQVUsTUFBTSxZQUFZLGlCQUFpQjtBQUN0RCxPQUFPLFlBQVk7QUFDbkIsU0FBUyxXQUFXLGVBQWUsY0FBYztBQUNqRCxTQUFTLE1BQU0sZUFBZTtBQUM5QixTQUFTLGNBQWM7QUFDdkIsU0FBUyxpQkFBaUI7QUFDMUIsU0FBUyxlQUFlLHFCQUFxQjtBQUM3QyxTQUFTLGtCQUFrQixxQkFBcUIsc0JBQXNCLHNCQUFzQixvQkFBb0IsaUJBQWlCLG1DQUFtQztBQUVwSyxTQUFTLDJCQUEyQjtBQUVwQyxTQUFTLFlBQVksUUFBd0I7QUFDM0MsUUFBTSxNQUFNO0FBQUEsSUFDVixPQUFPO0FBQUEsSUFDUCxHQUFHLE1BQU0sSUFBSSxLQUFLLElBQUksQ0FBQyxJQUFJLEtBQUssT0FBTyxFQUFFLFNBQVMsRUFBRSxFQUFFLE1BQU0sQ0FBQyxDQUFDO0FBQUEsRUFDaEU7QUFDQSxZQUFVLEtBQUssRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNsQyxTQUFPO0FBQ1Q7QUFJQSxTQUFTLGdDQUFnQyxNQUFNO0FBQzdDLE1BQUk7QUFDSixhQUFXLE1BQU07QUFBRSxVQUFNLFlBQVksY0FBYztBQUFBLEVBQUcsQ0FBQztBQUN2RCxZQUFVLE1BQU07QUFBRSxXQUFPLEtBQUssRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUFHLENBQUM7QUFFbEUsT0FBSyw2Q0FBNkMsTUFBTTtBQUN0RCxVQUFNLFNBQVMsaUJBQWlCO0FBQUEsTUFDOUIsb0JBQW9CLENBQUMsZ0JBQWdCLGNBQWM7QUFBQSxNQUNuRCxLQUFLO0FBQUEsSUFDUCxDQUFDO0FBQ0QsV0FBTyxnQkFBZ0IsT0FBTyxVQUFVLENBQUMsZ0JBQWdCLGNBQWMsQ0FBQztBQUN4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
