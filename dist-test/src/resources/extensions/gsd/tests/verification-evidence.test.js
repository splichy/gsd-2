import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  writeVerificationJSON,
  formatEvidenceTable
} from "../verification-evidence.js";
function makeTempDir(prefix) {
  const dir = join(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}
function makeResult(overrides) {
  return {
    passed: true,
    checks: [],
    discoverySource: "package-json",
    timestamp: 171e10,
    ...overrides
  };
}
test("verification-evidence: writeVerificationJSON writes correct JSON shape", () => {
  const tmp = makeTempDir("ve-shape");
  try {
    const result = makeResult({
      passed: true,
      checks: [
        {
          command: "npm run typecheck",
          exitCode: 0,
          stdout: "all good",
          stderr: "",
          durationMs: 2340
        }
      ]
    });
    writeVerificationJSON(result, tmp, "T03");
    const filePath = join(tmp, "T03-VERIFY.json");
    assert.ok(existsSync(filePath), "JSON file should exist");
    const json = JSON.parse(readFileSync(filePath, "utf-8"));
    assert.equal(json.schemaVersion, 1);
    assert.equal(json.taskId, "T03");
    assert.equal(json.unitId, "T03");
    assert.equal(json.timestamp, 171e10);
    assert.equal(json.passed, true);
    assert.equal(json.discoverySource, "package-json");
    assert.equal(json.checks.length, 1);
    assert.equal(json.checks[0].command, "npm run typecheck");
    assert.equal(json.checks[0].exitCode, 0);
    assert.equal(json.checks[0].durationMs, 2340);
    assert.equal(json.checks[0].verdict, "pass");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("verification-evidence: writeVerificationJSON creates directory if it doesn't exist", () => {
  const tmp = makeTempDir("ve-mkdir");
  const nested = join(tmp, "deep", "nested", "tasks");
  try {
    assert.ok(!existsSync(nested), "directory should not exist yet");
    writeVerificationJSON(makeResult(), nested, "T01");
    assert.ok(existsSync(nested), "directory should be created");
    assert.ok(existsSync(join(nested, "T01-VERIFY.json")), "JSON file should exist");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("verification-evidence: writeVerificationJSON maps exitCode to verdict correctly", () => {
  const tmp = makeTempDir("ve-verdict");
  try {
    const result = makeResult({
      passed: false,
      checks: [
        { command: "lint", exitCode: 0, stdout: "", stderr: "", durationMs: 100 },
        { command: "test", exitCode: 1, stdout: "", stderr: "fail", durationMs: 200 },
        { command: "audit", exitCode: 2, stdout: "", stderr: "err", durationMs: 300 }
      ]
    });
    writeVerificationJSON(result, tmp, "T02");
    const json = JSON.parse(readFileSync(join(tmp, "T02-VERIFY.json"), "utf-8"));
    assert.equal(json.checks[0].verdict, "pass");
    assert.equal(json.checks[1].verdict, "fail");
    assert.equal(json.checks[2].verdict, "fail");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("verification-evidence: writeVerificationJSON excludes stdout/stderr from output", () => {
  const tmp = makeTempDir("ve-no-stdio");
  try {
    const result = makeResult({
      checks: [
        {
          command: "echo hello",
          exitCode: 0,
          stdout: "hello\n",
          stderr: "some warning",
          durationMs: 50
        }
      ]
    });
    writeVerificationJSON(result, tmp, "T01");
    const raw = readFileSync(join(tmp, "T01-VERIFY.json"), "utf-8");
    assert.ok(!raw.includes('"stdout"'), "JSON should not contain stdout key");
    assert.ok(!raw.includes('"stderr"'), "JSON should not contain stderr key");
    assert.ok(!raw.includes("hello\\n"), "JSON should not contain stdout value");
    assert.ok(!raw.includes("some warning"), "JSON should not contain stderr value");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("verification-evidence: writeVerificationJSON handles empty checks array", () => {
  const tmp = makeTempDir("ve-empty");
  try {
    writeVerificationJSON(makeResult({ checks: [] }), tmp, "T01");
    const json = JSON.parse(readFileSync(join(tmp, "T01-VERIFY.json"), "utf-8"));
    assert.equal(json.schemaVersion, 1);
    assert.equal(json.passed, true);
    assert.deepStrictEqual(json.checks, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("verification-evidence: writeVerificationJSON uses optional unitId when provided", () => {
  const tmp = makeTempDir("ve-unitid");
  try {
    writeVerificationJSON(makeResult(), tmp, "T03", "M001/S01/T03");
    const json = JSON.parse(readFileSync(join(tmp, "T03-VERIFY.json"), "utf-8"));
    assert.equal(json.taskId, "T03");
    assert.equal(json.unitId, "M001/S01/T03");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("verification-evidence: formatEvidenceTable returns markdown table with correct columns", () => {
  const result = makeResult({
    checks: [
      { command: "npm run typecheck", exitCode: 0, stdout: "", stderr: "", durationMs: 2340 },
      { command: "npm run lint", exitCode: 1, stdout: "", stderr: "err", durationMs: 1100 }
    ]
  });
  const table = formatEvidenceTable(result);
  const lines = table.split("\n");
  assert.ok(lines[0].includes("# |"), "header should have # column");
  assert.ok(lines[0].includes("Command"), "header should have Command column");
  assert.ok(lines[0].includes("Exit Code"), "header should have Exit Code column");
  assert.ok(lines[0].includes("Verdict"), "header should have Verdict column");
  assert.ok(lines[0].includes("Duration"), "header should have Duration column");
  assert.ok(lines[1].includes("---|"), "should have separator row");
  assert.equal(lines.length, 4, "header + separator + 2 data rows");
  assert.ok(lines[2].includes("npm run typecheck"), "first row command");
  assert.ok(lines[3].includes("npm run lint"), "second row command");
});
test("verification-evidence: formatEvidenceTable returns no-checks message for empty checks", () => {
  const result = makeResult({ checks: [] });
  const output = formatEvidenceTable(result);
  assert.equal(output, "_No verification checks discovered._");
});
test("verification-evidence: formatEvidenceTable formats duration as seconds with 1 decimal", () => {
  const result = makeResult({
    checks: [
      { command: "fast", exitCode: 0, stdout: "", stderr: "", durationMs: 150 },
      { command: "slow", exitCode: 0, stdout: "", stderr: "", durationMs: 2340 },
      { command: "zero", exitCode: 0, stdout: "", stderr: "", durationMs: 0 }
    ]
  });
  const table = formatEvidenceTable(result);
  assert.ok(table.includes("0.1s"), "150ms \u2192 0.1s");
  assert.ok(table.includes("2.3s"), "2340ms \u2192 2.3s");
  assert.ok(table.includes("0.0s"), "0ms \u2192 0.0s");
});
test("verification-evidence: formatEvidenceTable uses \u2705/\u274C emoji for pass/fail verdict", () => {
  const result = makeResult({
    passed: false,
    checks: [
      { command: "pass-cmd", exitCode: 0, stdout: "", stderr: "", durationMs: 100 },
      { command: "fail-cmd", exitCode: 1, stdout: "", stderr: "", durationMs: 200 }
    ]
  });
  const table = formatEvidenceTable(result);
  assert.ok(table.includes("\u2705 pass"), "passing check should have \u2705 pass");
  assert.ok(table.includes("\u274C fail"), "failing check should have \u274C fail");
});
test("verification-evidence: writeVerificationJSON with retryAttempt and maxRetries includes them in output", () => {
  const tmp = makeTempDir("ve-retry-fields");
  try {
    const result = makeResult({
      passed: false,
      checks: [
        { command: "npm run lint", exitCode: 1, stdout: "", stderr: "error", durationMs: 300 }
      ]
    });
    writeVerificationJSON(result, tmp, "T01", "M001/S03/T01", 1, 2);
    const json = JSON.parse(readFileSync(join(tmp, "T01-VERIFY.json"), "utf-8"));
    assert.equal(json.retryAttempt, 1, "retryAttempt should be 1");
    assert.equal(json.maxRetries, 2, "maxRetries should be 2");
    assert.equal(json.schemaVersion, 1);
    assert.equal(json.taskId, "T01");
    assert.equal(json.unitId, "M001/S03/T01");
    assert.equal(json.passed, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("verification-evidence: writeVerificationJSON without retry params omits retryAttempt/maxRetries keys", () => {
  const tmp = makeTempDir("ve-no-retry");
  try {
    const result = makeResult({
      passed: true,
      checks: [
        { command: "npm run test", exitCode: 0, stdout: "ok", stderr: "", durationMs: 100 }
      ]
    });
    writeVerificationJSON(result, tmp, "T02");
    const raw = readFileSync(join(tmp, "T02-VERIFY.json"), "utf-8");
    const json = JSON.parse(raw);
    assert.ok(!("retryAttempt" in json), "retryAttempt key should not be present");
    assert.ok(!("maxRetries" in json), "maxRetries key should not be present");
    assert.ok(!raw.includes('"retryAttempt"'), "raw JSON should not contain retryAttempt");
    assert.ok(!raw.includes('"maxRetries"'), "raw JSON should not contain maxRetries");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("verification-evidence: writeVerificationJSON includes runtimeErrors when present", () => {
  const tmp = makeTempDir("ve-rt-present");
  try {
    const result = makeResult({
      passed: false,
      checks: [
        { command: "npm run test", exitCode: 0, stdout: "ok", stderr: "", durationMs: 100 }
      ],
      runtimeErrors: [
        { source: "bg-shell", severity: "crash", message: "Server crashed", blocking: true },
        { source: "browser", severity: "error", message: "Uncaught TypeError", blocking: false }
      ]
    });
    writeVerificationJSON(result, tmp, "T01");
    const json = JSON.parse(readFileSync(join(tmp, "T01-VERIFY.json"), "utf-8"));
    assert.ok(Array.isArray(json.runtimeErrors), "runtimeErrors should be an array");
    assert.equal(json.runtimeErrors.length, 2, "should have 2 runtime errors");
    assert.equal(json.runtimeErrors[0].source, "bg-shell");
    assert.equal(json.runtimeErrors[0].severity, "crash");
    assert.equal(json.runtimeErrors[0].message, "Server crashed");
    assert.equal(json.runtimeErrors[0].blocking, true);
    assert.equal(json.runtimeErrors[1].source, "browser");
    assert.equal(json.runtimeErrors[1].severity, "error");
    assert.equal(json.runtimeErrors[1].message, "Uncaught TypeError");
    assert.equal(json.runtimeErrors[1].blocking, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("verification-evidence: writeVerificationJSON omits runtimeErrors when absent", () => {
  const tmp = makeTempDir("ve-rt-absent");
  try {
    const result = makeResult({
      passed: true,
      checks: [
        { command: "npm run lint", exitCode: 0, stdout: "", stderr: "", durationMs: 50 }
      ]
    });
    writeVerificationJSON(result, tmp, "T01");
    const raw = readFileSync(join(tmp, "T01-VERIFY.json"), "utf-8");
    assert.ok(!raw.includes('"runtimeErrors"'), "raw JSON should not contain runtimeErrors key");
    const json = JSON.parse(raw);
    assert.ok(!("runtimeErrors" in json), "runtimeErrors key should not be present in parsed JSON");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("verification-evidence: writeVerificationJSON omits runtimeErrors when empty array", () => {
  const tmp = makeTempDir("ve-rt-empty");
  try {
    const result = makeResult({
      passed: true,
      checks: [],
      runtimeErrors: []
    });
    writeVerificationJSON(result, tmp, "T01");
    const raw = readFileSync(join(tmp, "T01-VERIFY.json"), "utf-8");
    assert.ok(!raw.includes('"runtimeErrors"'), "raw JSON should not contain runtimeErrors key when empty array");
    const json = JSON.parse(raw);
    assert.ok(!("runtimeErrors" in json), "runtimeErrors key should not be present for empty array");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("verification-evidence: formatEvidenceTable appends runtime errors section", () => {
  const result = makeResult({
    passed: false,
    checks: [
      { command: "npm run test", exitCode: 0, stdout: "", stderr: "", durationMs: 100 }
    ],
    runtimeErrors: [
      { source: "bg-shell", severity: "crash", message: "Server crashed with SIGKILL", blocking: true },
      { source: "browser", severity: "warning", message: "Deprecated API usage", blocking: false }
    ]
  });
  const table = formatEvidenceTable(result);
  assert.ok(table.includes("**Runtime Errors**"), "should have Runtime Errors heading");
  assert.ok(table.includes("| # | Source | Severity | Blocking | Message |"), "should have runtime errors column headers");
  assert.ok(table.includes("bg-shell"), "should contain bg-shell source");
  assert.ok(table.includes("crash"), "should contain crash severity");
  assert.ok(table.includes("\u{1F6AB} yes"), "blocking error should show \u{1F6AB} yes");
  assert.ok(table.includes("\u2139\uFE0F no"), "non-blocking error should show \u2139\uFE0F no");
  assert.ok(table.includes("Server crashed with SIGKILL"), "should contain error message");
  assert.ok(table.includes("Deprecated API usage"), "should contain warning message");
});
test("verification-evidence: formatEvidenceTable omits runtime errors section when none", () => {
  const result = makeResult({
    passed: true,
    checks: [
      { command: "npm run lint", exitCode: 0, stdout: "", stderr: "", durationMs: 200 }
    ]
  });
  const table = formatEvidenceTable(result);
  assert.ok(!table.includes("Runtime Errors"), "should not contain Runtime Errors heading");
  assert.ok(table.includes("npm run lint"), "should still contain the check table");
});
test("verification-evidence: formatEvidenceTable truncates runtime error message to 100 chars", () => {
  const longMessage = "A".repeat(150);
  const result = makeResult({
    passed: false,
    checks: [
      { command: "npm run test", exitCode: 0, stdout: "", stderr: "", durationMs: 100 }
    ],
    runtimeErrors: [
      { source: "bg-shell", severity: "error", message: longMessage, blocking: false }
    ]
  });
  const table = formatEvidenceTable(result);
  assert.ok(table.includes("A".repeat(100)), "should contain 100 A's");
  assert.ok(!table.includes("A".repeat(101)), "should not contain 101 A's (truncated)");
});
const SAMPLE_AUDIT_WARNINGS = [
  {
    name: "lodash",
    severity: "critical",
    title: "Prototype Pollution",
    url: "https://github.com/advisories/GHSA-1234",
    fixAvailable: true
  },
  {
    name: "express",
    severity: "high",
    title: "Open Redirect",
    url: "https://github.com/advisories/GHSA-5678",
    fixAvailable: false
  },
  {
    name: "minimist",
    severity: "moderate",
    title: "Prototype Pollution",
    url: "https://github.com/advisories/GHSA-9012",
    fixAvailable: true
  }
];
test("verification-evidence: writeVerificationJSON includes auditWarnings when present", () => {
  const tmp = makeTempDir("ve-audit-present");
  try {
    const result = makeResult({
      passed: true,
      checks: [
        { command: "npm run test", exitCode: 0, stdout: "ok", stderr: "", durationMs: 100 }
      ],
      auditWarnings: SAMPLE_AUDIT_WARNINGS
    });
    writeVerificationJSON(result, tmp, "T01");
    const json = JSON.parse(readFileSync(join(tmp, "T01-VERIFY.json"), "utf-8"));
    assert.ok(Array.isArray(json.auditWarnings), "auditWarnings should be an array");
    assert.equal(json.auditWarnings.length, 3, "should have 3 audit warnings");
    assert.equal(json.auditWarnings[0].name, "lodash");
    assert.equal(json.auditWarnings[0].severity, "critical");
    assert.equal(json.auditWarnings[0].title, "Prototype Pollution");
    assert.equal(json.auditWarnings[0].url, "https://github.com/advisories/GHSA-1234");
    assert.equal(json.auditWarnings[0].fixAvailable, true);
    assert.equal(json.auditWarnings[1].name, "express");
    assert.equal(json.auditWarnings[1].severity, "high");
    assert.equal(json.auditWarnings[1].fixAvailable, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("verification-evidence: writeVerificationJSON omits auditWarnings when absent", () => {
  const tmp = makeTempDir("ve-audit-absent");
  try {
    const result = makeResult({
      passed: true,
      checks: [
        { command: "npm run lint", exitCode: 0, stdout: "", stderr: "", durationMs: 50 }
      ]
    });
    writeVerificationJSON(result, tmp, "T01");
    const raw = readFileSync(join(tmp, "T01-VERIFY.json"), "utf-8");
    assert.ok(!raw.includes('"auditWarnings"'), "raw JSON should not contain auditWarnings key");
    const json = JSON.parse(raw);
    assert.ok(!("auditWarnings" in json), "auditWarnings key should not be present in parsed JSON");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("verification-evidence: writeVerificationJSON omits auditWarnings when empty array", () => {
  const tmp = makeTempDir("ve-audit-empty");
  try {
    const result = makeResult({
      passed: true,
      checks: [],
      auditWarnings: []
    });
    writeVerificationJSON(result, tmp, "T01");
    const raw = readFileSync(join(tmp, "T01-VERIFY.json"), "utf-8");
    assert.ok(!raw.includes('"auditWarnings"'), "raw JSON should not contain auditWarnings key when empty array");
    const json = JSON.parse(raw);
    assert.ok(!("auditWarnings" in json), "auditWarnings key should not be present for empty array");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("verification-evidence: formatEvidenceTable appends audit warnings section", () => {
  const result = makeResult({
    passed: true,
    checks: [
      { command: "npm run test", exitCode: 0, stdout: "", stderr: "", durationMs: 100 }
    ],
    auditWarnings: SAMPLE_AUDIT_WARNINGS
  });
  const table = formatEvidenceTable(result);
  assert.ok(table.includes("**Audit Warnings**"), "should have Audit Warnings heading");
  assert.ok(table.includes("| # | Package | Severity | Title | Fix Available |"), "should have audit warnings column headers");
  assert.ok(table.includes("lodash"), "should contain lodash package");
  assert.ok(table.includes("\u{1F534} critical"), "should show critical emoji");
  assert.ok(table.includes("\u{1F7E0} high"), "should show high emoji");
  assert.ok(table.includes("\u{1F7E1} moderate"), "should show moderate emoji");
  assert.ok(table.includes("Prototype Pollution"), "should contain vulnerability title");
  assert.ok(table.includes("Open Redirect"), "should contain vulnerability title");
  assert.ok(table.includes("\u2705 yes"), "fixAvailable true should show \u2705 yes");
  assert.ok(table.includes("\u274C no"), "fixAvailable false should show \u274C no");
});
test("verification-evidence: formatEvidenceTable omits audit warnings section when none", () => {
  const result = makeResult({
    passed: true,
    checks: [
      { command: "npm run lint", exitCode: 0, stdout: "", stderr: "", durationMs: 200 }
    ]
  });
  const table = formatEvidenceTable(result);
  assert.ok(!table.includes("Audit Warnings"), "should not contain Audit Warnings heading");
  assert.ok(table.includes("npm run lint"), "should still contain the check table");
});
test("verification-evidence: integration \u2014 VerificationResult with auditWarnings \u2192 JSON \u2192 table", () => {
  const tmp = makeTempDir("ve-audit-integration");
  try {
    const result = makeResult({
      passed: true,
      checks: [
        { command: "npm run typecheck", exitCode: 0, stdout: "ok", stderr: "", durationMs: 1500 }
      ],
      auditWarnings: [
        {
          name: "got",
          severity: "moderate",
          title: "Redirect bypass",
          url: "https://github.com/advisories/GHSA-abcd",
          fixAvailable: true
        }
      ]
    });
    writeVerificationJSON(result, tmp, "T05");
    const json = JSON.parse(readFileSync(join(tmp, "T05-VERIFY.json"), "utf-8"));
    assert.equal(json.auditWarnings.length, 1, "JSON should have 1 audit warning");
    assert.equal(json.auditWarnings[0].name, "got");
    assert.equal(json.auditWarnings[0].severity, "moderate");
    assert.equal(json.auditWarnings[0].fixAvailable, true);
    assert.equal(json.passed, true, "passed should remain true despite audit warnings");
    const table = formatEvidenceTable(result);
    assert.ok(table.includes("**Audit Warnings**"), "table should have Audit Warnings section");
    assert.ok(table.includes("got"), "table should contain package name");
    assert.ok(table.includes("\u{1F7E1} moderate"), "table should show moderate severity with emoji");
    assert.ok(table.includes("Redirect bypass"), "table should contain vulnerability title");
    assert.ok(table.includes("\u2705 yes"), "table should show fix available");
    assert.ok(table.includes("npm run typecheck"), "table should still have main check");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy92ZXJpZmljYXRpb24tZXZpZGVuY2UudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBVbml0IHRlc3RzIGZvciB0aGUgdmVyaWZpY2F0aW9uIGV2aWRlbmNlIG1vZHVsZSBcdTIwMTQgSlNPTiBwZXJzaXN0ZW5jZSBhbmQgbWFya2Rvd24gdGFibGUgZm9ybWF0dGluZy5cbiAqXG4gKiBUZXN0cyBjb3ZlcjpcbiAqICAgMS4gd3JpdGVWZXJpZmljYXRpb25KU09OIHdyaXRlcyBjb3JyZWN0IEpTT04gc2hhcGUgKHNjaGVtYVZlcnNpb24sIHRhc2tJZCwgdGltZXN0YW1wLCBwYXNzZWQsIGRpc2NvdmVyeVNvdXJjZSwgY2hlY2tzKVxuICogICAyLiB3cml0ZVZlcmlmaWNhdGlvbkpTT04gY3JlYXRlcyBkaXJlY3RvcnkgaWYgaXQgZG9lc24ndCBleGlzdFxuICogICAzLiB3cml0ZVZlcmlmaWNhdGlvbkpTT04gbWFwcyBleGl0Q29kZSB0byB2ZXJkaWN0IGNvcnJlY3RseSAoMCA9IHBhc3MsIG5vbi16ZXJvID0gZmFpbClcbiAqICAgNC4gd3JpdGVWZXJpZmljYXRpb25KU09OIGV4Y2x1ZGVzIHN0ZG91dC9zdGRlcnIgZnJvbSBvdXRwdXRcbiAqICAgNS4gd3JpdGVWZXJpZmljYXRpb25KU09OIGhhbmRsZXMgZW1wdHkgY2hlY2tzIGFycmF5XG4gKiAgIDYuIHdyaXRlVmVyaWZpY2F0aW9uSlNPTiBhY2NlcHRzIG9wdGlvbmFsIHVuaXRJZFxuICogICA3LiBmb3JtYXRFdmlkZW5jZVRhYmxlIHJldHVybnMgbWFya2Rvd24gdGFibGUgd2l0aCBjb3JyZWN0IGNvbHVtbnMgZm9yIGNoZWNrc1xuICogICA4LiBmb3JtYXRFdmlkZW5jZVRhYmxlIHJldHVybnMgXCJubyBjaGVja3NcIiBtZXNzYWdlIGZvciBlbXB0eSBjaGVja3NcbiAqICAgOS4gZm9ybWF0RXZpZGVuY2VUYWJsZSBmb3JtYXRzIGR1cmF0aW9uIGFzIHNlY29uZHMgd2l0aCAxIGRlY2ltYWxcbiAqICAxMC4gZm9ybWF0RXZpZGVuY2VUYWJsZSB1c2VzIFx1MjcwNS9cdTI3NEMgZW1vamkgZm9yIHBhc3MvZmFpbCB2ZXJkaWN0XG4gKi9cblxuaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2RpclN5bmMsIHJlYWRGaWxlU3luYywgcm1TeW5jLCBleGlzdHNTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHtcbiAgd3JpdGVWZXJpZmljYXRpb25KU09OLFxuICBmb3JtYXRFdmlkZW5jZVRhYmxlLFxufSBmcm9tIFwiLi4vdmVyaWZpY2F0aW9uLWV2aWRlbmNlLnRzXCI7XG5pbXBvcnQgdHlwZSB7IFZlcmlmaWNhdGlvblJlc3VsdCB9IGZyb20gXCIuLi90eXBlcy50c1wiO1xuXG5mdW5jdGlvbiBtYWtlVGVtcERpcihwcmVmaXg6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGRpciA9IGpvaW4oXG4gICAgdG1wZGlyKCksXG4gICAgYCR7cHJlZml4fS0ke0RhdGUubm93KCl9LSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMil9YCxcbiAgKTtcbiAgbWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHJldHVybiBkaXI7XG59XG5cbmZ1bmN0aW9uIG1ha2VSZXN1bHQob3ZlcnJpZGVzPzogUGFydGlhbDxWZXJpZmljYXRpb25SZXN1bHQ+KTogVmVyaWZpY2F0aW9uUmVzdWx0IHtcbiAgcmV0dXJuIHtcbiAgICBwYXNzZWQ6IHRydWUsXG4gICAgY2hlY2tzOiBbXSxcbiAgICBkaXNjb3ZlcnlTb3VyY2U6IFwicGFja2FnZS1qc29uXCIsXG4gICAgdGltZXN0YW1wOiAxNzEwMDAwMDAwMDAwLFxuICAgIC4uLm92ZXJyaWRlcyxcbiAgfTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHdyaXRlVmVyaWZpY2F0aW9uSlNPTiBUZXN0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcInZlcmlmaWNhdGlvbi1ldmlkZW5jZTogd3JpdGVWZXJpZmljYXRpb25KU09OIHdyaXRlcyBjb3JyZWN0IEpTT04gc2hhcGVcIiwgKCkgPT4ge1xuICBjb25zdCB0bXAgPSBtYWtlVGVtcERpcihcInZlLXNoYXBlXCIpO1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IG1ha2VSZXN1bHQoe1xuICAgICAgcGFzc2VkOiB0cnVlLFxuICAgICAgY2hlY2tzOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBjb21tYW5kOiBcIm5wbSBydW4gdHlwZWNoZWNrXCIsXG4gICAgICAgICAgZXhpdENvZGU6IDAsXG4gICAgICAgICAgc3Rkb3V0OiBcImFsbCBnb29kXCIsXG4gICAgICAgICAgc3RkZXJyOiBcIlwiLFxuICAgICAgICAgIGR1cmF0aW9uTXM6IDIzNDAsXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgIH0pO1xuXG4gICAgd3JpdGVWZXJpZmljYXRpb25KU09OKHJlc3VsdCwgdG1wLCBcIlQwM1wiKTtcblxuICAgIGNvbnN0IGZpbGVQYXRoID0gam9pbih0bXAsIFwiVDAzLVZFUklGWS5qc29uXCIpO1xuICAgIGFzc2VydC5vayhleGlzdHNTeW5jKGZpbGVQYXRoKSwgXCJKU09OIGZpbGUgc2hvdWxkIGV4aXN0XCIpO1xuXG4gICAgY29uc3QganNvbiA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGZpbGVQYXRoLCBcInV0Zi04XCIpKTtcbiAgICBhc3NlcnQuZXF1YWwoanNvbi5zY2hlbWFWZXJzaW9uLCAxKTtcbiAgICBhc3NlcnQuZXF1YWwoanNvbi50YXNrSWQsIFwiVDAzXCIpO1xuICAgIGFzc2VydC5lcXVhbChqc29uLnVuaXRJZCwgXCJUMDNcIik7IC8vIGRlZmF1bHRzIHRvIHRhc2tJZCB3aGVuIHVuaXRJZCBub3QgcHJvdmlkZWRcbiAgICBhc3NlcnQuZXF1YWwoanNvbi50aW1lc3RhbXAsIDE3MTAwMDAwMDAwMDApO1xuICAgIGFzc2VydC5lcXVhbChqc29uLnBhc3NlZCwgdHJ1ZSk7XG4gICAgYXNzZXJ0LmVxdWFsKGpzb24uZGlzY292ZXJ5U291cmNlLCBcInBhY2thZ2UtanNvblwiKTtcbiAgICBhc3NlcnQuZXF1YWwoanNvbi5jaGVja3MubGVuZ3RoLCAxKTtcbiAgICBhc3NlcnQuZXF1YWwoanNvbi5jaGVja3NbMF0uY29tbWFuZCwgXCJucG0gcnVuIHR5cGVjaGVja1wiKTtcbiAgICBhc3NlcnQuZXF1YWwoanNvbi5jaGVja3NbMF0uZXhpdENvZGUsIDApO1xuICAgIGFzc2VydC5lcXVhbChqc29uLmNoZWNrc1swXS5kdXJhdGlvbk1zLCAyMzQwKTtcbiAgICBhc3NlcnQuZXF1YWwoanNvbi5jaGVja3NbMF0udmVyZGljdCwgXCJwYXNzXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJ2ZXJpZmljYXRpb24tZXZpZGVuY2U6IHdyaXRlVmVyaWZpY2F0aW9uSlNPTiBjcmVhdGVzIGRpcmVjdG9yeSBpZiBpdCBkb2Vzbid0IGV4aXN0XCIsICgpID0+IHtcbiAgY29uc3QgdG1wID0gbWFrZVRlbXBEaXIoXCJ2ZS1ta2RpclwiKTtcbiAgY29uc3QgbmVzdGVkID0gam9pbih0bXAsIFwiZGVlcFwiLCBcIm5lc3RlZFwiLCBcInRhc2tzXCIpO1xuICB0cnkge1xuICAgIGFzc2VydC5vayghZXhpc3RzU3luYyhuZXN0ZWQpLCBcImRpcmVjdG9yeSBzaG91bGQgbm90IGV4aXN0IHlldFwiKTtcblxuICAgIHdyaXRlVmVyaWZpY2F0aW9uSlNPTihtYWtlUmVzdWx0KCksIG5lc3RlZCwgXCJUMDFcIik7XG5cbiAgICBhc3NlcnQub2soZXhpc3RzU3luYyhuZXN0ZWQpLCBcImRpcmVjdG9yeSBzaG91bGQgYmUgY3JlYXRlZFwiKTtcbiAgICBhc3NlcnQub2soZXhpc3RzU3luYyhqb2luKG5lc3RlZCwgXCJUMDEtVkVSSUZZLmpzb25cIikpLCBcIkpTT04gZmlsZSBzaG91bGQgZXhpc3RcIik7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcInZlcmlmaWNhdGlvbi1ldmlkZW5jZTogd3JpdGVWZXJpZmljYXRpb25KU09OIG1hcHMgZXhpdENvZGUgdG8gdmVyZGljdCBjb3JyZWN0bHlcIiwgKCkgPT4ge1xuICBjb25zdCB0bXAgPSBtYWtlVGVtcERpcihcInZlLXZlcmRpY3RcIik7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gbWFrZVJlc3VsdCh7XG4gICAgICBwYXNzZWQ6IGZhbHNlLFxuICAgICAgY2hlY2tzOiBbXG4gICAgICAgIHsgY29tbWFuZDogXCJsaW50XCIsIGV4aXRDb2RlOiAwLCBzdGRvdXQ6IFwiXCIsIHN0ZGVycjogXCJcIiwgZHVyYXRpb25NczogMTAwIH0sXG4gICAgICAgIHsgY29tbWFuZDogXCJ0ZXN0XCIsIGV4aXRDb2RlOiAxLCBzdGRvdXQ6IFwiXCIsIHN0ZGVycjogXCJmYWlsXCIsIGR1cmF0aW9uTXM6IDIwMCB9LFxuICAgICAgICB7IGNvbW1hbmQ6IFwiYXVkaXRcIiwgZXhpdENvZGU6IDIsIHN0ZG91dDogXCJcIiwgc3RkZXJyOiBcImVyclwiLCBkdXJhdGlvbk1zOiAzMDAgfSxcbiAgICAgIF0sXG4gICAgfSk7XG5cbiAgICB3cml0ZVZlcmlmaWNhdGlvbkpTT04ocmVzdWx0LCB0bXAsIFwiVDAyXCIpO1xuXG4gICAgY29uc3QganNvbiA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGpvaW4odG1wLCBcIlQwMi1WRVJJRlkuanNvblwiKSwgXCJ1dGYtOFwiKSk7XG4gICAgYXNzZXJ0LmVxdWFsKGpzb24uY2hlY2tzWzBdLnZlcmRpY3QsIFwicGFzc1wiKTtcbiAgICBhc3NlcnQuZXF1YWwoanNvbi5jaGVja3NbMV0udmVyZGljdCwgXCJmYWlsXCIpO1xuICAgIGFzc2VydC5lcXVhbChqc29uLmNoZWNrc1syXS52ZXJkaWN0LCBcImZhaWxcIik7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcInZlcmlmaWNhdGlvbi1ldmlkZW5jZTogd3JpdGVWZXJpZmljYXRpb25KU09OIGV4Y2x1ZGVzIHN0ZG91dC9zdGRlcnIgZnJvbSBvdXRwdXRcIiwgKCkgPT4ge1xuICBjb25zdCB0bXAgPSBtYWtlVGVtcERpcihcInZlLW5vLXN0ZGlvXCIpO1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IG1ha2VSZXN1bHQoe1xuICAgICAgY2hlY2tzOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBjb21tYW5kOiBcImVjaG8gaGVsbG9cIixcbiAgICAgICAgICBleGl0Q29kZTogMCxcbiAgICAgICAgICBzdGRvdXQ6IFwiaGVsbG9cXG5cIixcbiAgICAgICAgICBzdGRlcnI6IFwic29tZSB3YXJuaW5nXCIsXG4gICAgICAgICAgZHVyYXRpb25NczogNTAsXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgIH0pO1xuXG4gICAgd3JpdGVWZXJpZmljYXRpb25KU09OKHJlc3VsdCwgdG1wLCBcIlQwMVwiKTtcblxuICAgIGNvbnN0IHJhdyA9IHJlYWRGaWxlU3luYyhqb2luKHRtcCwgXCJUMDEtVkVSSUZZLmpzb25cIiksIFwidXRmLThcIik7XG4gICAgYXNzZXJ0Lm9rKCFyYXcuaW5jbHVkZXMoJ1wic3Rkb3V0XCInKSwgXCJKU09OIHNob3VsZCBub3QgY29udGFpbiBzdGRvdXQga2V5XCIpO1xuICAgIGFzc2VydC5vayghcmF3LmluY2x1ZGVzKCdcInN0ZGVyclwiJyksIFwiSlNPTiBzaG91bGQgbm90IGNvbnRhaW4gc3RkZXJyIGtleVwiKTtcbiAgICBhc3NlcnQub2soIXJhdy5pbmNsdWRlcyhcImhlbGxvXFxcXG5cIiksIFwiSlNPTiBzaG91bGQgbm90IGNvbnRhaW4gc3Rkb3V0IHZhbHVlXCIpO1xuICAgIGFzc2VydC5vayghcmF3LmluY2x1ZGVzKFwic29tZSB3YXJuaW5nXCIpLCBcIkpTT04gc2hvdWxkIG5vdCBjb250YWluIHN0ZGVyciB2YWx1ZVwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwidmVyaWZpY2F0aW9uLWV2aWRlbmNlOiB3cml0ZVZlcmlmaWNhdGlvbkpTT04gaGFuZGxlcyBlbXB0eSBjaGVja3MgYXJyYXlcIiwgKCkgPT4ge1xuICBjb25zdCB0bXAgPSBtYWtlVGVtcERpcihcInZlLWVtcHR5XCIpO1xuICB0cnkge1xuICAgIHdyaXRlVmVyaWZpY2F0aW9uSlNPTihtYWtlUmVzdWx0KHsgY2hlY2tzOiBbXSB9KSwgdG1wLCBcIlQwMVwiKTtcblxuICAgIGNvbnN0IGpzb24gPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKHRtcCwgXCJUMDEtVkVSSUZZLmpzb25cIiksIFwidXRmLThcIikpO1xuICAgIGFzc2VydC5lcXVhbChqc29uLnNjaGVtYVZlcnNpb24sIDEpO1xuICAgIGFzc2VydC5lcXVhbChqc29uLnBhc3NlZCwgdHJ1ZSk7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChqc29uLmNoZWNrcywgW10pO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJ2ZXJpZmljYXRpb24tZXZpZGVuY2U6IHdyaXRlVmVyaWZpY2F0aW9uSlNPTiB1c2VzIG9wdGlvbmFsIHVuaXRJZCB3aGVuIHByb3ZpZGVkXCIsICgpID0+IHtcbiAgY29uc3QgdG1wID0gbWFrZVRlbXBEaXIoXCJ2ZS11bml0aWRcIik7XG4gIHRyeSB7XG4gICAgd3JpdGVWZXJpZmljYXRpb25KU09OKG1ha2VSZXN1bHQoKSwgdG1wLCBcIlQwM1wiLCBcIk0wMDEvUzAxL1QwM1wiKTtcblxuICAgIGNvbnN0IGpzb24gPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKHRtcCwgXCJUMDMtVkVSSUZZLmpzb25cIiksIFwidXRmLThcIikpO1xuICAgIGFzc2VydC5lcXVhbChqc29uLnRhc2tJZCwgXCJUMDNcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGpzb24udW5pdElkLCBcIk0wMDEvUzAxL1QwM1wiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgZm9ybWF0RXZpZGVuY2VUYWJsZSBUZXN0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcInZlcmlmaWNhdGlvbi1ldmlkZW5jZTogZm9ybWF0RXZpZGVuY2VUYWJsZSByZXR1cm5zIG1hcmtkb3duIHRhYmxlIHdpdGggY29ycmVjdCBjb2x1bW5zXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gbWFrZVJlc3VsdCh7XG4gICAgY2hlY2tzOiBbXG4gICAgICB7IGNvbW1hbmQ6IFwibnBtIHJ1biB0eXBlY2hlY2tcIiwgZXhpdENvZGU6IDAsIHN0ZG91dDogXCJcIiwgc3RkZXJyOiBcIlwiLCBkdXJhdGlvbk1zOiAyMzQwIH0sXG4gICAgICB7IGNvbW1hbmQ6IFwibnBtIHJ1biBsaW50XCIsIGV4aXRDb2RlOiAxLCBzdGRvdXQ6IFwiXCIsIHN0ZGVycjogXCJlcnJcIiwgZHVyYXRpb25NczogMTEwMCB9LFxuICAgIF0sXG4gIH0pO1xuXG4gIGNvbnN0IHRhYmxlID0gZm9ybWF0RXZpZGVuY2VUYWJsZShyZXN1bHQpO1xuICBjb25zdCBsaW5lcyA9IHRhYmxlLnNwbGl0KFwiXFxuXCIpO1xuXG4gIC8vIEhlYWRlciByb3dcbiAgYXNzZXJ0Lm9rKGxpbmVzWzBdLmluY2x1ZGVzKFwiIyB8XCIpLCBcImhlYWRlciBzaG91bGQgaGF2ZSAjIGNvbHVtblwiKTtcbiAgYXNzZXJ0Lm9rKGxpbmVzWzBdLmluY2x1ZGVzKFwiQ29tbWFuZFwiKSwgXCJoZWFkZXIgc2hvdWxkIGhhdmUgQ29tbWFuZCBjb2x1bW5cIik7XG4gIGFzc2VydC5vayhsaW5lc1swXS5pbmNsdWRlcyhcIkV4aXQgQ29kZVwiKSwgXCJoZWFkZXIgc2hvdWxkIGhhdmUgRXhpdCBDb2RlIGNvbHVtblwiKTtcbiAgYXNzZXJ0Lm9rKGxpbmVzWzBdLmluY2x1ZGVzKFwiVmVyZGljdFwiKSwgXCJoZWFkZXIgc2hvdWxkIGhhdmUgVmVyZGljdCBjb2x1bW5cIik7XG4gIGFzc2VydC5vayhsaW5lc1swXS5pbmNsdWRlcyhcIkR1cmF0aW9uXCIpLCBcImhlYWRlciBzaG91bGQgaGF2ZSBEdXJhdGlvbiBjb2x1bW5cIik7XG5cbiAgLy8gU2VwYXJhdG9yIHJvd1xuICBhc3NlcnQub2sobGluZXNbMV0uaW5jbHVkZXMoXCItLS18XCIpLCBcInNob3VsZCBoYXZlIHNlcGFyYXRvciByb3dcIik7XG5cbiAgLy8gRGF0YSByb3dzXG4gIGFzc2VydC5lcXVhbChsaW5lcy5sZW5ndGgsIDQsIFwiaGVhZGVyICsgc2VwYXJhdG9yICsgMiBkYXRhIHJvd3NcIik7XG4gIGFzc2VydC5vayhsaW5lc1syXS5pbmNsdWRlcyhcIm5wbSBydW4gdHlwZWNoZWNrXCIpLCBcImZpcnN0IHJvdyBjb21tYW5kXCIpO1xuICBhc3NlcnQub2sobGluZXNbM10uaW5jbHVkZXMoXCJucG0gcnVuIGxpbnRcIiksIFwic2Vjb25kIHJvdyBjb21tYW5kXCIpO1xufSk7XG5cbnRlc3QoXCJ2ZXJpZmljYXRpb24tZXZpZGVuY2U6IGZvcm1hdEV2aWRlbmNlVGFibGUgcmV0dXJucyBuby1jaGVja3MgbWVzc2FnZSBmb3IgZW1wdHkgY2hlY2tzXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gbWFrZVJlc3VsdCh7IGNoZWNrczogW10gfSk7XG4gIGNvbnN0IG91dHB1dCA9IGZvcm1hdEV2aWRlbmNlVGFibGUocmVzdWx0KTtcbiAgYXNzZXJ0LmVxdWFsKG91dHB1dCwgXCJfTm8gdmVyaWZpY2F0aW9uIGNoZWNrcyBkaXNjb3ZlcmVkLl9cIik7XG59KTtcblxudGVzdChcInZlcmlmaWNhdGlvbi1ldmlkZW5jZTogZm9ybWF0RXZpZGVuY2VUYWJsZSBmb3JtYXRzIGR1cmF0aW9uIGFzIHNlY29uZHMgd2l0aCAxIGRlY2ltYWxcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBtYWtlUmVzdWx0KHtcbiAgICBjaGVja3M6IFtcbiAgICAgIHsgY29tbWFuZDogXCJmYXN0XCIsIGV4aXRDb2RlOiAwLCBzdGRvdXQ6IFwiXCIsIHN0ZGVycjogXCJcIiwgZHVyYXRpb25NczogMTUwIH0sXG4gICAgICB7IGNvbW1hbmQ6IFwic2xvd1wiLCBleGl0Q29kZTogMCwgc3Rkb3V0OiBcIlwiLCBzdGRlcnI6IFwiXCIsIGR1cmF0aW9uTXM6IDIzNDAgfSxcbiAgICAgIHsgY29tbWFuZDogXCJ6ZXJvXCIsIGV4aXRDb2RlOiAwLCBzdGRvdXQ6IFwiXCIsIHN0ZGVycjogXCJcIiwgZHVyYXRpb25NczogMCB9LFxuICAgIF0sXG4gIH0pO1xuXG4gIGNvbnN0IHRhYmxlID0gZm9ybWF0RXZpZGVuY2VUYWJsZShyZXN1bHQpO1xuICBhc3NlcnQub2sodGFibGUuaW5jbHVkZXMoXCIwLjFzXCIpLCBcIjE1MG1zIFx1MjE5MiAwLjFzXCIpO1xuICBhc3NlcnQub2sodGFibGUuaW5jbHVkZXMoXCIyLjNzXCIpLCBcIjIzNDBtcyBcdTIxOTIgMi4zc1wiKTtcbiAgYXNzZXJ0Lm9rKHRhYmxlLmluY2x1ZGVzKFwiMC4wc1wiKSwgXCIwbXMgXHUyMTkyIDAuMHNcIik7XG59KTtcblxudGVzdChcInZlcmlmaWNhdGlvbi1ldmlkZW5jZTogZm9ybWF0RXZpZGVuY2VUYWJsZSB1c2VzIFx1MjcwNS9cdTI3NEMgZW1vamkgZm9yIHBhc3MvZmFpbCB2ZXJkaWN0XCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gbWFrZVJlc3VsdCh7XG4gICAgcGFzc2VkOiBmYWxzZSxcbiAgICBjaGVja3M6IFtcbiAgICAgIHsgY29tbWFuZDogXCJwYXNzLWNtZFwiLCBleGl0Q29kZTogMCwgc3Rkb3V0OiBcIlwiLCBzdGRlcnI6IFwiXCIsIGR1cmF0aW9uTXM6IDEwMCB9LFxuICAgICAgeyBjb21tYW5kOiBcImZhaWwtY21kXCIsIGV4aXRDb2RlOiAxLCBzdGRvdXQ6IFwiXCIsIHN0ZGVycjogXCJcIiwgZHVyYXRpb25NczogMjAwIH0sXG4gICAgXSxcbiAgfSk7XG5cbiAgY29uc3QgdGFibGUgPSBmb3JtYXRFdmlkZW5jZVRhYmxlKHJlc3VsdCk7XG4gIGFzc2VydC5vayh0YWJsZS5pbmNsdWRlcyhcIlx1MjcwNSBwYXNzXCIpLCBcInBhc3NpbmcgY2hlY2sgc2hvdWxkIGhhdmUgXHUyNzA1IHBhc3NcIik7XG4gIGFzc2VydC5vayh0YWJsZS5pbmNsdWRlcyhcIlx1Mjc0QyBmYWlsXCIpLCBcImZhaWxpbmcgY2hlY2sgc2hvdWxkIGhhdmUgXHUyNzRDIGZhaWxcIik7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFJldHJ5IEV2aWRlbmNlIEZpZWxkIFRlc3RzIChTMDMvVDAxKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcInZlcmlmaWNhdGlvbi1ldmlkZW5jZTogd3JpdGVWZXJpZmljYXRpb25KU09OIHdpdGggcmV0cnlBdHRlbXB0IGFuZCBtYXhSZXRyaWVzIGluY2x1ZGVzIHRoZW0gaW4gb3V0cHV0XCIsICgpID0+IHtcbiAgY29uc3QgdG1wID0gbWFrZVRlbXBEaXIoXCJ2ZS1yZXRyeS1maWVsZHNcIik7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gbWFrZVJlc3VsdCh7XG4gICAgICBwYXNzZWQ6IGZhbHNlLFxuICAgICAgY2hlY2tzOiBbXG4gICAgICAgIHsgY29tbWFuZDogXCJucG0gcnVuIGxpbnRcIiwgZXhpdENvZGU6IDEsIHN0ZG91dDogXCJcIiwgc3RkZXJyOiBcImVycm9yXCIsIGR1cmF0aW9uTXM6IDMwMCB9LFxuICAgICAgXSxcbiAgICB9KTtcblxuICAgIHdyaXRlVmVyaWZpY2F0aW9uSlNPTihyZXN1bHQsIHRtcCwgXCJUMDFcIiwgXCJNMDAxL1MwMy9UMDFcIiwgMSwgMik7XG5cbiAgICBjb25zdCBqc29uID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoam9pbih0bXAsIFwiVDAxLVZFUklGWS5qc29uXCIpLCBcInV0Zi04XCIpKTtcbiAgICBhc3NlcnQuZXF1YWwoanNvbi5yZXRyeUF0dGVtcHQsIDEsIFwicmV0cnlBdHRlbXB0IHNob3VsZCBiZSAxXCIpO1xuICAgIGFzc2VydC5lcXVhbChqc29uLm1heFJldHJpZXMsIDIsIFwibWF4UmV0cmllcyBzaG91bGQgYmUgMlwiKTtcbiAgICAvLyBPdGhlciBmaWVsZHMgc2hvdWxkIHN0aWxsIGJlIGNvcnJlY3RcbiAgICBhc3NlcnQuZXF1YWwoanNvbi5zY2hlbWFWZXJzaW9uLCAxKTtcbiAgICBhc3NlcnQuZXF1YWwoanNvbi50YXNrSWQsIFwiVDAxXCIpO1xuICAgIGFzc2VydC5lcXVhbChqc29uLnVuaXRJZCwgXCJNMDAxL1MwMy9UMDFcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGpzb24ucGFzc2VkLCBmYWxzZSk7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcInZlcmlmaWNhdGlvbi1ldmlkZW5jZTogd3JpdGVWZXJpZmljYXRpb25KU09OIHdpdGhvdXQgcmV0cnkgcGFyYW1zIG9taXRzIHJldHJ5QXR0ZW1wdC9tYXhSZXRyaWVzIGtleXNcIiwgKCkgPT4ge1xuICBjb25zdCB0bXAgPSBtYWtlVGVtcERpcihcInZlLW5vLXJldHJ5XCIpO1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IG1ha2VSZXN1bHQoe1xuICAgICAgcGFzc2VkOiB0cnVlLFxuICAgICAgY2hlY2tzOiBbXG4gICAgICAgIHsgY29tbWFuZDogXCJucG0gcnVuIHRlc3RcIiwgZXhpdENvZGU6IDAsIHN0ZG91dDogXCJva1wiLCBzdGRlcnI6IFwiXCIsIGR1cmF0aW9uTXM6IDEwMCB9LFxuICAgICAgXSxcbiAgICB9KTtcblxuICAgIHdyaXRlVmVyaWZpY2F0aW9uSlNPTihyZXN1bHQsIHRtcCwgXCJUMDJcIik7XG5cbiAgICBjb25zdCByYXcgPSByZWFkRmlsZVN5bmMoam9pbih0bXAsIFwiVDAyLVZFUklGWS5qc29uXCIpLCBcInV0Zi04XCIpO1xuICAgIGNvbnN0IGpzb24gPSBKU09OLnBhcnNlKHJhdyk7XG4gICAgYXNzZXJ0Lm9rKCEoXCJyZXRyeUF0dGVtcHRcIiBpbiBqc29uKSwgXCJyZXRyeUF0dGVtcHQga2V5IHNob3VsZCBub3QgYmUgcHJlc2VudFwiKTtcbiAgICBhc3NlcnQub2soIShcIm1heFJldHJpZXNcIiBpbiBqc29uKSwgXCJtYXhSZXRyaWVzIGtleSBzaG91bGQgbm90IGJlIHByZXNlbnRcIik7XG4gICAgLy8gQ29uZmlybSB0aGUgSlNPTiBzdHJpbmcgZG9lcyBub3QgY29udGFpbiB0aGVzZSBrZXlzIGF0IGFsbFxuICAgIGFzc2VydC5vayghcmF3LmluY2x1ZGVzKCdcInJldHJ5QXR0ZW1wdFwiJyksIFwicmF3IEpTT04gc2hvdWxkIG5vdCBjb250YWluIHJldHJ5QXR0ZW1wdFwiKTtcbiAgICBhc3NlcnQub2soIXJhdy5pbmNsdWRlcygnXCJtYXhSZXRyaWVzXCInKSwgXCJyYXcgSlNPTiBzaG91bGQgbm90IGNvbnRhaW4gbWF4UmV0cmllc1wiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUnVudGltZSBFcnJvciBFdmlkZW5jZSBUZXN0cyAoUzA0L1QwMikgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJ2ZXJpZmljYXRpb24tZXZpZGVuY2U6IHdyaXRlVmVyaWZpY2F0aW9uSlNPTiBpbmNsdWRlcyBydW50aW1lRXJyb3JzIHdoZW4gcHJlc2VudFwiLCAoKSA9PiB7XG4gIGNvbnN0IHRtcCA9IG1ha2VUZW1wRGlyKFwidmUtcnQtcHJlc2VudFwiKTtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXN1bHQgPSBtYWtlUmVzdWx0KHtcbiAgICAgIHBhc3NlZDogZmFsc2UsXG4gICAgICBjaGVja3M6IFtcbiAgICAgICAgeyBjb21tYW5kOiBcIm5wbSBydW4gdGVzdFwiLCBleGl0Q29kZTogMCwgc3Rkb3V0OiBcIm9rXCIsIHN0ZGVycjogXCJcIiwgZHVyYXRpb25NczogMTAwIH0sXG4gICAgICBdLFxuICAgICAgcnVudGltZUVycm9yczogW1xuICAgICAgICB7IHNvdXJjZTogXCJiZy1zaGVsbFwiLCBzZXZlcml0eTogXCJjcmFzaFwiLCBtZXNzYWdlOiBcIlNlcnZlciBjcmFzaGVkXCIsIGJsb2NraW5nOiB0cnVlIH0sXG4gICAgICAgIHsgc291cmNlOiBcImJyb3dzZXJcIiwgc2V2ZXJpdHk6IFwiZXJyb3JcIiwgbWVzc2FnZTogXCJVbmNhdWdodCBUeXBlRXJyb3JcIiwgYmxvY2tpbmc6IGZhbHNlIH0sXG4gICAgICBdLFxuICAgIH0pO1xuXG4gICAgd3JpdGVWZXJpZmljYXRpb25KU09OKHJlc3VsdCwgdG1wLCBcIlQwMVwiKTtcblxuICAgIGNvbnN0IGpzb24gPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKHRtcCwgXCJUMDEtVkVSSUZZLmpzb25cIiksIFwidXRmLThcIikpO1xuICAgIGFzc2VydC5vayhBcnJheS5pc0FycmF5KGpzb24ucnVudGltZUVycm9ycyksIFwicnVudGltZUVycm9ycyBzaG91bGQgYmUgYW4gYXJyYXlcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGpzb24ucnVudGltZUVycm9ycy5sZW5ndGgsIDIsIFwic2hvdWxkIGhhdmUgMiBydW50aW1lIGVycm9yc1wiKTtcbiAgICBhc3NlcnQuZXF1YWwoanNvbi5ydW50aW1lRXJyb3JzWzBdLnNvdXJjZSwgXCJiZy1zaGVsbFwiKTtcbiAgICBhc3NlcnQuZXF1YWwoanNvbi5ydW50aW1lRXJyb3JzWzBdLnNldmVyaXR5LCBcImNyYXNoXCIpO1xuICAgIGFzc2VydC5lcXVhbChqc29uLnJ1bnRpbWVFcnJvcnNbMF0ubWVzc2FnZSwgXCJTZXJ2ZXIgY3Jhc2hlZFwiKTtcbiAgICBhc3NlcnQuZXF1YWwoanNvbi5ydW50aW1lRXJyb3JzWzBdLmJsb2NraW5nLCB0cnVlKTtcbiAgICBhc3NlcnQuZXF1YWwoanNvbi5ydW50aW1lRXJyb3JzWzFdLnNvdXJjZSwgXCJicm93c2VyXCIpO1xuICAgIGFzc2VydC5lcXVhbChqc29uLnJ1bnRpbWVFcnJvcnNbMV0uc2V2ZXJpdHksIFwiZXJyb3JcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGpzb24ucnVudGltZUVycm9yc1sxXS5tZXNzYWdlLCBcIlVuY2F1Z2h0IFR5cGVFcnJvclwiKTtcbiAgICBhc3NlcnQuZXF1YWwoanNvbi5ydW50aW1lRXJyb3JzWzFdLmJsb2NraW5nLCBmYWxzZSk7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcInZlcmlmaWNhdGlvbi1ldmlkZW5jZTogd3JpdGVWZXJpZmljYXRpb25KU09OIG9taXRzIHJ1bnRpbWVFcnJvcnMgd2hlbiBhYnNlbnRcIiwgKCkgPT4ge1xuICBjb25zdCB0bXAgPSBtYWtlVGVtcERpcihcInZlLXJ0LWFic2VudFwiKTtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXN1bHQgPSBtYWtlUmVzdWx0KHtcbiAgICAgIHBhc3NlZDogdHJ1ZSxcbiAgICAgIGNoZWNrczogW1xuICAgICAgICB7IGNvbW1hbmQ6IFwibnBtIHJ1biBsaW50XCIsIGV4aXRDb2RlOiAwLCBzdGRvdXQ6IFwiXCIsIHN0ZGVycjogXCJcIiwgZHVyYXRpb25NczogNTAgfSxcbiAgICAgIF0sXG4gICAgfSk7XG5cbiAgICB3cml0ZVZlcmlmaWNhdGlvbkpTT04ocmVzdWx0LCB0bXAsIFwiVDAxXCIpO1xuXG4gICAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKGpvaW4odG1wLCBcIlQwMS1WRVJJRlkuanNvblwiKSwgXCJ1dGYtOFwiKTtcbiAgICBhc3NlcnQub2soIXJhdy5pbmNsdWRlcygnXCJydW50aW1lRXJyb3JzXCInKSwgXCJyYXcgSlNPTiBzaG91bGQgbm90IGNvbnRhaW4gcnVudGltZUVycm9ycyBrZXlcIik7XG4gICAgY29uc3QganNvbiA9IEpTT04ucGFyc2UocmF3KTtcbiAgICBhc3NlcnQub2soIShcInJ1bnRpbWVFcnJvcnNcIiBpbiBqc29uKSwgXCJydW50aW1lRXJyb3JzIGtleSBzaG91bGQgbm90IGJlIHByZXNlbnQgaW4gcGFyc2VkIEpTT05cIik7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcInZlcmlmaWNhdGlvbi1ldmlkZW5jZTogd3JpdGVWZXJpZmljYXRpb25KU09OIG9taXRzIHJ1bnRpbWVFcnJvcnMgd2hlbiBlbXB0eSBhcnJheVwiLCAoKSA9PiB7XG4gIGNvbnN0IHRtcCA9IG1ha2VUZW1wRGlyKFwidmUtcnQtZW1wdHlcIik7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gbWFrZVJlc3VsdCh7XG4gICAgICBwYXNzZWQ6IHRydWUsXG4gICAgICBjaGVja3M6IFtdLFxuICAgICAgcnVudGltZUVycm9yczogW10sXG4gICAgfSk7XG5cbiAgICB3cml0ZVZlcmlmaWNhdGlvbkpTT04ocmVzdWx0LCB0bXAsIFwiVDAxXCIpO1xuXG4gICAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKGpvaW4odG1wLCBcIlQwMS1WRVJJRlkuanNvblwiKSwgXCJ1dGYtOFwiKTtcbiAgICBhc3NlcnQub2soIXJhdy5pbmNsdWRlcygnXCJydW50aW1lRXJyb3JzXCInKSwgXCJyYXcgSlNPTiBzaG91bGQgbm90IGNvbnRhaW4gcnVudGltZUVycm9ycyBrZXkgd2hlbiBlbXB0eSBhcnJheVwiKTtcbiAgICBjb25zdCBqc29uID0gSlNPTi5wYXJzZShyYXcpO1xuICAgIGFzc2VydC5vayghKFwicnVudGltZUVycm9yc1wiIGluIGpzb24pLCBcInJ1bnRpbWVFcnJvcnMga2V5IHNob3VsZCBub3QgYmUgcHJlc2VudCBmb3IgZW1wdHkgYXJyYXlcIik7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcInZlcmlmaWNhdGlvbi1ldmlkZW5jZTogZm9ybWF0RXZpZGVuY2VUYWJsZSBhcHBlbmRzIHJ1bnRpbWUgZXJyb3JzIHNlY3Rpb25cIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBtYWtlUmVzdWx0KHtcbiAgICBwYXNzZWQ6IGZhbHNlLFxuICAgIGNoZWNrczogW1xuICAgICAgeyBjb21tYW5kOiBcIm5wbSBydW4gdGVzdFwiLCBleGl0Q29kZTogMCwgc3Rkb3V0OiBcIlwiLCBzdGRlcnI6IFwiXCIsIGR1cmF0aW9uTXM6IDEwMCB9LFxuICAgIF0sXG4gICAgcnVudGltZUVycm9yczogW1xuICAgICAgeyBzb3VyY2U6IFwiYmctc2hlbGxcIiwgc2V2ZXJpdHk6IFwiY3Jhc2hcIiwgbWVzc2FnZTogXCJTZXJ2ZXIgY3Jhc2hlZCB3aXRoIFNJR0tJTExcIiwgYmxvY2tpbmc6IHRydWUgfSxcbiAgICAgIHsgc291cmNlOiBcImJyb3dzZXJcIiwgc2V2ZXJpdHk6IFwid2FybmluZ1wiLCBtZXNzYWdlOiBcIkRlcHJlY2F0ZWQgQVBJIHVzYWdlXCIsIGJsb2NraW5nOiBmYWxzZSB9LFxuICAgIF0sXG4gIH0pO1xuXG4gIGNvbnN0IHRhYmxlID0gZm9ybWF0RXZpZGVuY2VUYWJsZShyZXN1bHQpO1xuXG4gIC8vIFNob3VsZCBjb250YWluIHJ1bnRpbWUgZXJyb3JzIHNlY3Rpb25cbiAgYXNzZXJ0Lm9rKHRhYmxlLmluY2x1ZGVzKFwiKipSdW50aW1lIEVycm9ycyoqXCIpLCBcInNob3VsZCBoYXZlIFJ1bnRpbWUgRXJyb3JzIGhlYWRpbmdcIik7XG4gIGFzc2VydC5vayh0YWJsZS5pbmNsdWRlcyhcInwgIyB8IFNvdXJjZSB8IFNldmVyaXR5IHwgQmxvY2tpbmcgfCBNZXNzYWdlIHxcIiksIFwic2hvdWxkIGhhdmUgcnVudGltZSBlcnJvcnMgY29sdW1uIGhlYWRlcnNcIik7XG4gIGFzc2VydC5vayh0YWJsZS5pbmNsdWRlcyhcImJnLXNoZWxsXCIpLCBcInNob3VsZCBjb250YWluIGJnLXNoZWxsIHNvdXJjZVwiKTtcbiAgYXNzZXJ0Lm9rKHRhYmxlLmluY2x1ZGVzKFwiY3Jhc2hcIiksIFwic2hvdWxkIGNvbnRhaW4gY3Jhc2ggc2V2ZXJpdHlcIik7XG4gIGFzc2VydC5vayh0YWJsZS5pbmNsdWRlcyhcIlx1RDgzRFx1REVBQiB5ZXNcIiksIFwiYmxvY2tpbmcgZXJyb3Igc2hvdWxkIHNob3cgXHVEODNEXHVERUFCIHllc1wiKTtcbiAgYXNzZXJ0Lm9rKHRhYmxlLmluY2x1ZGVzKFwiXHUyMTM5XHVGRTBGIG5vXCIpLCBcIm5vbi1ibG9ja2luZyBlcnJvciBzaG91bGQgc2hvdyBcdTIxMzlcdUZFMEYgbm9cIik7XG4gIGFzc2VydC5vayh0YWJsZS5pbmNsdWRlcyhcIlNlcnZlciBjcmFzaGVkIHdpdGggU0lHS0lMTFwiKSwgXCJzaG91bGQgY29udGFpbiBlcnJvciBtZXNzYWdlXCIpO1xuICBhc3NlcnQub2sodGFibGUuaW5jbHVkZXMoXCJEZXByZWNhdGVkIEFQSSB1c2FnZVwiKSwgXCJzaG91bGQgY29udGFpbiB3YXJuaW5nIG1lc3NhZ2VcIik7XG59KTtcblxudGVzdChcInZlcmlmaWNhdGlvbi1ldmlkZW5jZTogZm9ybWF0RXZpZGVuY2VUYWJsZSBvbWl0cyBydW50aW1lIGVycm9ycyBzZWN0aW9uIHdoZW4gbm9uZVwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IG1ha2VSZXN1bHQoe1xuICAgIHBhc3NlZDogdHJ1ZSxcbiAgICBjaGVja3M6IFtcbiAgICAgIHsgY29tbWFuZDogXCJucG0gcnVuIGxpbnRcIiwgZXhpdENvZGU6IDAsIHN0ZG91dDogXCJcIiwgc3RkZXJyOiBcIlwiLCBkdXJhdGlvbk1zOiAyMDAgfSxcbiAgICBdLFxuICB9KTtcblxuICBjb25zdCB0YWJsZSA9IGZvcm1hdEV2aWRlbmNlVGFibGUocmVzdWx0KTtcblxuICBhc3NlcnQub2soIXRhYmxlLmluY2x1ZGVzKFwiUnVudGltZSBFcnJvcnNcIiksIFwic2hvdWxkIG5vdCBjb250YWluIFJ1bnRpbWUgRXJyb3JzIGhlYWRpbmdcIik7XG4gIGFzc2VydC5vayh0YWJsZS5pbmNsdWRlcyhcIm5wbSBydW4gbGludFwiKSwgXCJzaG91bGQgc3RpbGwgY29udGFpbiB0aGUgY2hlY2sgdGFibGVcIik7XG59KTtcblxudGVzdChcInZlcmlmaWNhdGlvbi1ldmlkZW5jZTogZm9ybWF0RXZpZGVuY2VUYWJsZSB0cnVuY2F0ZXMgcnVudGltZSBlcnJvciBtZXNzYWdlIHRvIDEwMCBjaGFyc1wiLCAoKSA9PiB7XG4gIGNvbnN0IGxvbmdNZXNzYWdlID0gXCJBXCIucmVwZWF0KDE1MCk7XG4gIGNvbnN0IHJlc3VsdCA9IG1ha2VSZXN1bHQoe1xuICAgIHBhc3NlZDogZmFsc2UsXG4gICAgY2hlY2tzOiBbXG4gICAgICB7IGNvbW1hbmQ6IFwibnBtIHJ1biB0ZXN0XCIsIGV4aXRDb2RlOiAwLCBzdGRvdXQ6IFwiXCIsIHN0ZGVycjogXCJcIiwgZHVyYXRpb25NczogMTAwIH0sXG4gICAgXSxcbiAgICBydW50aW1lRXJyb3JzOiBbXG4gICAgICB7IHNvdXJjZTogXCJiZy1zaGVsbFwiLCBzZXZlcml0eTogXCJlcnJvclwiLCBtZXNzYWdlOiBsb25nTWVzc2FnZSwgYmxvY2tpbmc6IGZhbHNlIH0sXG4gICAgXSxcbiAgfSk7XG5cbiAgY29uc3QgdGFibGUgPSBmb3JtYXRFdmlkZW5jZVRhYmxlKHJlc3VsdCk7XG5cbiAgLy8gVGhlIHRhYmxlIHNob3VsZCBjb250YWluIHRoZSB0cnVuY2F0ZWQgbWVzc2FnZSAoMTAwIGNoYXJzKSwgbm90IHRoZSBmdWxsIDE1MFxuICBhc3NlcnQub2sodGFibGUuaW5jbHVkZXMoXCJBXCIucmVwZWF0KDEwMCkpLCBcInNob3VsZCBjb250YWluIDEwMCBBJ3NcIik7XG4gIGFzc2VydC5vayghdGFibGUuaW5jbHVkZXMoXCJBXCIucmVwZWF0KDEwMSkpLCBcInNob3VsZCBub3QgY29udGFpbiAxMDEgQSdzICh0cnVuY2F0ZWQpXCIpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBBdWRpdCBXYXJuaW5nIEV2aWRlbmNlIFRlc3RzIChTMDUvVDAyKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuY29uc3QgU0FNUExFX0FVRElUX1dBUk5JTkdTID0gW1xuICB7XG4gICAgbmFtZTogXCJsb2Rhc2hcIixcbiAgICBzZXZlcml0eTogXCJjcml0aWNhbFwiIGFzIGNvbnN0LFxuICAgIHRpdGxlOiBcIlByb3RvdHlwZSBQb2xsdXRpb25cIixcbiAgICB1cmw6IFwiaHR0cHM6Ly9naXRodWIuY29tL2Fkdmlzb3JpZXMvR0hTQS0xMjM0XCIsXG4gICAgZml4QXZhaWxhYmxlOiB0cnVlLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJleHByZXNzXCIsXG4gICAgc2V2ZXJpdHk6IFwiaGlnaFwiIGFzIGNvbnN0LFxuICAgIHRpdGxlOiBcIk9wZW4gUmVkaXJlY3RcIixcbiAgICB1cmw6IFwiaHR0cHM6Ly9naXRodWIuY29tL2Fkdmlzb3JpZXMvR0hTQS01Njc4XCIsXG4gICAgZml4QXZhaWxhYmxlOiBmYWxzZSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibWluaW1pc3RcIixcbiAgICBzZXZlcml0eTogXCJtb2RlcmF0ZVwiIGFzIGNvbnN0LFxuICAgIHRpdGxlOiBcIlByb3RvdHlwZSBQb2xsdXRpb25cIixcbiAgICB1cmw6IFwiaHR0cHM6Ly9naXRodWIuY29tL2Fkdmlzb3JpZXMvR0hTQS05MDEyXCIsXG4gICAgZml4QXZhaWxhYmxlOiB0cnVlLFxuICB9LFxuXTtcblxudGVzdChcInZlcmlmaWNhdGlvbi1ldmlkZW5jZTogd3JpdGVWZXJpZmljYXRpb25KU09OIGluY2x1ZGVzIGF1ZGl0V2FybmluZ3Mgd2hlbiBwcmVzZW50XCIsICgpID0+IHtcbiAgY29uc3QgdG1wID0gbWFrZVRlbXBEaXIoXCJ2ZS1hdWRpdC1wcmVzZW50XCIpO1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IG1ha2VSZXN1bHQoe1xuICAgICAgcGFzc2VkOiB0cnVlLFxuICAgICAgY2hlY2tzOiBbXG4gICAgICAgIHsgY29tbWFuZDogXCJucG0gcnVuIHRlc3RcIiwgZXhpdENvZGU6IDAsIHN0ZG91dDogXCJva1wiLCBzdGRlcnI6IFwiXCIsIGR1cmF0aW9uTXM6IDEwMCB9LFxuICAgICAgXSxcbiAgICAgIGF1ZGl0V2FybmluZ3M6IFNBTVBMRV9BVURJVF9XQVJOSU5HUyxcbiAgICB9KTtcblxuICAgIHdyaXRlVmVyaWZpY2F0aW9uSlNPTihyZXN1bHQsIHRtcCwgXCJUMDFcIik7XG5cbiAgICBjb25zdCBqc29uID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoam9pbih0bXAsIFwiVDAxLVZFUklGWS5qc29uXCIpLCBcInV0Zi04XCIpKTtcbiAgICBhc3NlcnQub2soQXJyYXkuaXNBcnJheShqc29uLmF1ZGl0V2FybmluZ3MpLCBcImF1ZGl0V2FybmluZ3Mgc2hvdWxkIGJlIGFuIGFycmF5XCIpO1xuICAgIGFzc2VydC5lcXVhbChqc29uLmF1ZGl0V2FybmluZ3MubGVuZ3RoLCAzLCBcInNob3VsZCBoYXZlIDMgYXVkaXQgd2FybmluZ3NcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGpzb24uYXVkaXRXYXJuaW5nc1swXS5uYW1lLCBcImxvZGFzaFwiKTtcbiAgICBhc3NlcnQuZXF1YWwoanNvbi5hdWRpdFdhcm5pbmdzWzBdLnNldmVyaXR5LCBcImNyaXRpY2FsXCIpO1xuICAgIGFzc2VydC5lcXVhbChqc29uLmF1ZGl0V2FybmluZ3NbMF0udGl0bGUsIFwiUHJvdG90eXBlIFBvbGx1dGlvblwiKTtcbiAgICBhc3NlcnQuZXF1YWwoanNvbi5hdWRpdFdhcm5pbmdzWzBdLnVybCwgXCJodHRwczovL2dpdGh1Yi5jb20vYWR2aXNvcmllcy9HSFNBLTEyMzRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGpzb24uYXVkaXRXYXJuaW5nc1swXS5maXhBdmFpbGFibGUsIHRydWUpO1xuICAgIGFzc2VydC5lcXVhbChqc29uLmF1ZGl0V2FybmluZ3NbMV0ubmFtZSwgXCJleHByZXNzXCIpO1xuICAgIGFzc2VydC5lcXVhbChqc29uLmF1ZGl0V2FybmluZ3NbMV0uc2V2ZXJpdHksIFwiaGlnaFwiKTtcbiAgICBhc3NlcnQuZXF1YWwoanNvbi5hdWRpdFdhcm5pbmdzWzFdLmZpeEF2YWlsYWJsZSwgZmFsc2UpO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJ2ZXJpZmljYXRpb24tZXZpZGVuY2U6IHdyaXRlVmVyaWZpY2F0aW9uSlNPTiBvbWl0cyBhdWRpdFdhcm5pbmdzIHdoZW4gYWJzZW50XCIsICgpID0+IHtcbiAgY29uc3QgdG1wID0gbWFrZVRlbXBEaXIoXCJ2ZS1hdWRpdC1hYnNlbnRcIik7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gbWFrZVJlc3VsdCh7XG4gICAgICBwYXNzZWQ6IHRydWUsXG4gICAgICBjaGVja3M6IFtcbiAgICAgICAgeyBjb21tYW5kOiBcIm5wbSBydW4gbGludFwiLCBleGl0Q29kZTogMCwgc3Rkb3V0OiBcIlwiLCBzdGRlcnI6IFwiXCIsIGR1cmF0aW9uTXM6IDUwIH0sXG4gICAgICBdLFxuICAgIH0pO1xuXG4gICAgd3JpdGVWZXJpZmljYXRpb25KU09OKHJlc3VsdCwgdG1wLCBcIlQwMVwiKTtcblxuICAgIGNvbnN0IHJhdyA9IHJlYWRGaWxlU3luYyhqb2luKHRtcCwgXCJUMDEtVkVSSUZZLmpzb25cIiksIFwidXRmLThcIik7XG4gICAgYXNzZXJ0Lm9rKCFyYXcuaW5jbHVkZXMoJ1wiYXVkaXRXYXJuaW5nc1wiJyksIFwicmF3IEpTT04gc2hvdWxkIG5vdCBjb250YWluIGF1ZGl0V2FybmluZ3Mga2V5XCIpO1xuICAgIGNvbnN0IGpzb24gPSBKU09OLnBhcnNlKHJhdyk7XG4gICAgYXNzZXJ0Lm9rKCEoXCJhdWRpdFdhcm5pbmdzXCIgaW4ganNvbiksIFwiYXVkaXRXYXJuaW5ncyBrZXkgc2hvdWxkIG5vdCBiZSBwcmVzZW50IGluIHBhcnNlZCBKU09OXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJ2ZXJpZmljYXRpb24tZXZpZGVuY2U6IHdyaXRlVmVyaWZpY2F0aW9uSlNPTiBvbWl0cyBhdWRpdFdhcm5pbmdzIHdoZW4gZW1wdHkgYXJyYXlcIiwgKCkgPT4ge1xuICBjb25zdCB0bXAgPSBtYWtlVGVtcERpcihcInZlLWF1ZGl0LWVtcHR5XCIpO1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IG1ha2VSZXN1bHQoe1xuICAgICAgcGFzc2VkOiB0cnVlLFxuICAgICAgY2hlY2tzOiBbXSxcbiAgICAgIGF1ZGl0V2FybmluZ3M6IFtdLFxuICAgIH0pO1xuXG4gICAgd3JpdGVWZXJpZmljYXRpb25KU09OKHJlc3VsdCwgdG1wLCBcIlQwMVwiKTtcblxuICAgIGNvbnN0IHJhdyA9IHJlYWRGaWxlU3luYyhqb2luKHRtcCwgXCJUMDEtVkVSSUZZLmpzb25cIiksIFwidXRmLThcIik7XG4gICAgYXNzZXJ0Lm9rKCFyYXcuaW5jbHVkZXMoJ1wiYXVkaXRXYXJuaW5nc1wiJyksIFwicmF3IEpTT04gc2hvdWxkIG5vdCBjb250YWluIGF1ZGl0V2FybmluZ3Mga2V5IHdoZW4gZW1wdHkgYXJyYXlcIik7XG4gICAgY29uc3QganNvbiA9IEpTT04ucGFyc2UocmF3KTtcbiAgICBhc3NlcnQub2soIShcImF1ZGl0V2FybmluZ3NcIiBpbiBqc29uKSwgXCJhdWRpdFdhcm5pbmdzIGtleSBzaG91bGQgbm90IGJlIHByZXNlbnQgZm9yIGVtcHR5IGFycmF5XCIpO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJ2ZXJpZmljYXRpb24tZXZpZGVuY2U6IGZvcm1hdEV2aWRlbmNlVGFibGUgYXBwZW5kcyBhdWRpdCB3YXJuaW5ncyBzZWN0aW9uXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gbWFrZVJlc3VsdCh7XG4gICAgcGFzc2VkOiB0cnVlLFxuICAgIGNoZWNrczogW1xuICAgICAgeyBjb21tYW5kOiBcIm5wbSBydW4gdGVzdFwiLCBleGl0Q29kZTogMCwgc3Rkb3V0OiBcIlwiLCBzdGRlcnI6IFwiXCIsIGR1cmF0aW9uTXM6IDEwMCB9LFxuICAgIF0sXG4gICAgYXVkaXRXYXJuaW5nczogU0FNUExFX0FVRElUX1dBUk5JTkdTLFxuICB9KTtcblxuICBjb25zdCB0YWJsZSA9IGZvcm1hdEV2aWRlbmNlVGFibGUocmVzdWx0KTtcblxuICBhc3NlcnQub2sodGFibGUuaW5jbHVkZXMoXCIqKkF1ZGl0IFdhcm5pbmdzKipcIiksIFwic2hvdWxkIGhhdmUgQXVkaXQgV2FybmluZ3MgaGVhZGluZ1wiKTtcbiAgYXNzZXJ0Lm9rKHRhYmxlLmluY2x1ZGVzKFwifCAjIHwgUGFja2FnZSB8IFNldmVyaXR5IHwgVGl0bGUgfCBGaXggQXZhaWxhYmxlIHxcIiksIFwic2hvdWxkIGhhdmUgYXVkaXQgd2FybmluZ3MgY29sdW1uIGhlYWRlcnNcIik7XG4gIGFzc2VydC5vayh0YWJsZS5pbmNsdWRlcyhcImxvZGFzaFwiKSwgXCJzaG91bGQgY29udGFpbiBsb2Rhc2ggcGFja2FnZVwiKTtcbiAgYXNzZXJ0Lm9rKHRhYmxlLmluY2x1ZGVzKFwiXHVEODNEXHVERDM0IGNyaXRpY2FsXCIpLCBcInNob3VsZCBzaG93IGNyaXRpY2FsIGVtb2ppXCIpO1xuICBhc3NlcnQub2sodGFibGUuaW5jbHVkZXMoXCJcdUQ4M0RcdURGRTAgaGlnaFwiKSwgXCJzaG91bGQgc2hvdyBoaWdoIGVtb2ppXCIpO1xuICBhc3NlcnQub2sodGFibGUuaW5jbHVkZXMoXCJcdUQ4M0RcdURGRTEgbW9kZXJhdGVcIiksIFwic2hvdWxkIHNob3cgbW9kZXJhdGUgZW1vamlcIik7XG4gIGFzc2VydC5vayh0YWJsZS5pbmNsdWRlcyhcIlByb3RvdHlwZSBQb2xsdXRpb25cIiksIFwic2hvdWxkIGNvbnRhaW4gdnVsbmVyYWJpbGl0eSB0aXRsZVwiKTtcbiAgYXNzZXJ0Lm9rKHRhYmxlLmluY2x1ZGVzKFwiT3BlbiBSZWRpcmVjdFwiKSwgXCJzaG91bGQgY29udGFpbiB2dWxuZXJhYmlsaXR5IHRpdGxlXCIpO1xuICBhc3NlcnQub2sodGFibGUuaW5jbHVkZXMoXCJcdTI3MDUgeWVzXCIpLCBcImZpeEF2YWlsYWJsZSB0cnVlIHNob3VsZCBzaG93IFx1MjcwNSB5ZXNcIik7XG4gIGFzc2VydC5vayh0YWJsZS5pbmNsdWRlcyhcIlx1Mjc0QyBub1wiKSwgXCJmaXhBdmFpbGFibGUgZmFsc2Ugc2hvdWxkIHNob3cgXHUyNzRDIG5vXCIpO1xufSk7XG5cbnRlc3QoXCJ2ZXJpZmljYXRpb24tZXZpZGVuY2U6IGZvcm1hdEV2aWRlbmNlVGFibGUgb21pdHMgYXVkaXQgd2FybmluZ3Mgc2VjdGlvbiB3aGVuIG5vbmVcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBtYWtlUmVzdWx0KHtcbiAgICBwYXNzZWQ6IHRydWUsXG4gICAgY2hlY2tzOiBbXG4gICAgICB7IGNvbW1hbmQ6IFwibnBtIHJ1biBsaW50XCIsIGV4aXRDb2RlOiAwLCBzdGRvdXQ6IFwiXCIsIHN0ZGVycjogXCJcIiwgZHVyYXRpb25NczogMjAwIH0sXG4gICAgXSxcbiAgfSk7XG5cbiAgY29uc3QgdGFibGUgPSBmb3JtYXRFdmlkZW5jZVRhYmxlKHJlc3VsdCk7XG5cbiAgYXNzZXJ0Lm9rKCF0YWJsZS5pbmNsdWRlcyhcIkF1ZGl0IFdhcm5pbmdzXCIpLCBcInNob3VsZCBub3QgY29udGFpbiBBdWRpdCBXYXJuaW5ncyBoZWFkaW5nXCIpO1xuICBhc3NlcnQub2sodGFibGUuaW5jbHVkZXMoXCJucG0gcnVuIGxpbnRcIiksIFwic2hvdWxkIHN0aWxsIGNvbnRhaW4gdGhlIGNoZWNrIHRhYmxlXCIpO1xufSk7XG5cbnRlc3QoXCJ2ZXJpZmljYXRpb24tZXZpZGVuY2U6IGludGVncmF0aW9uIFx1MjAxNCBWZXJpZmljYXRpb25SZXN1bHQgd2l0aCBhdWRpdFdhcm5pbmdzIFx1MjE5MiBKU09OIFx1MjE5MiB0YWJsZVwiLCAoKSA9PiB7XG4gIGNvbnN0IHRtcCA9IG1ha2VUZW1wRGlyKFwidmUtYXVkaXQtaW50ZWdyYXRpb25cIik7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gbWFrZVJlc3VsdCh7XG4gICAgICBwYXNzZWQ6IHRydWUsXG4gICAgICBjaGVja3M6IFtcbiAgICAgICAgeyBjb21tYW5kOiBcIm5wbSBydW4gdHlwZWNoZWNrXCIsIGV4aXRDb2RlOiAwLCBzdGRvdXQ6IFwib2tcIiwgc3RkZXJyOiBcIlwiLCBkdXJhdGlvbk1zOiAxNTAwIH0sXG4gICAgICBdLFxuICAgICAgYXVkaXRXYXJuaW5nczogW1xuICAgICAgICB7XG4gICAgICAgICAgbmFtZTogXCJnb3RcIixcbiAgICAgICAgICBzZXZlcml0eTogXCJtb2RlcmF0ZVwiIGFzIGNvbnN0LFxuICAgICAgICAgIHRpdGxlOiBcIlJlZGlyZWN0IGJ5cGFzc1wiLFxuICAgICAgICAgIHVybDogXCJodHRwczovL2dpdGh1Yi5jb20vYWR2aXNvcmllcy9HSFNBLWFiY2RcIixcbiAgICAgICAgICBmaXhBdmFpbGFibGU6IHRydWUsXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgIH0pO1xuXG4gICAgLy8gMS4gV3JpdGUgSlNPTiBhbmQgdmVyaWZ5XG4gICAgd3JpdGVWZXJpZmljYXRpb25KU09OKHJlc3VsdCwgdG1wLCBcIlQwNVwiKTtcbiAgICBjb25zdCBqc29uID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoam9pbih0bXAsIFwiVDA1LVZFUklGWS5qc29uXCIpLCBcInV0Zi04XCIpKTtcbiAgICBhc3NlcnQuZXF1YWwoanNvbi5hdWRpdFdhcm5pbmdzLmxlbmd0aCwgMSwgXCJKU09OIHNob3VsZCBoYXZlIDEgYXVkaXQgd2FybmluZ1wiKTtcbiAgICBhc3NlcnQuZXF1YWwoanNvbi5hdWRpdFdhcm5pbmdzWzBdLm5hbWUsIFwiZ290XCIpO1xuICAgIGFzc2VydC5lcXVhbChqc29uLmF1ZGl0V2FybmluZ3NbMF0uc2V2ZXJpdHksIFwibW9kZXJhdGVcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGpzb24uYXVkaXRXYXJuaW5nc1swXS5maXhBdmFpbGFibGUsIHRydWUpO1xuICAgIC8vIHBhc3NlZCBzaG91bGQgc3RpbGwgYmUgdHJ1ZSBcdTIwMTQgYXVkaXQgd2FybmluZ3MgYXJlIG5vbi1ibG9ja2luZ1xuICAgIGFzc2VydC5lcXVhbChqc29uLnBhc3NlZCwgdHJ1ZSwgXCJwYXNzZWQgc2hvdWxkIHJlbWFpbiB0cnVlIGRlc3BpdGUgYXVkaXQgd2FybmluZ3NcIik7XG5cbiAgICAvLyAyLiBGb3JtYXQgdGFibGUgYW5kIHZlcmlmeVxuICAgIGNvbnN0IHRhYmxlID0gZm9ybWF0RXZpZGVuY2VUYWJsZShyZXN1bHQpO1xuICAgIGFzc2VydC5vayh0YWJsZS5pbmNsdWRlcyhcIioqQXVkaXQgV2FybmluZ3MqKlwiKSwgXCJ0YWJsZSBzaG91bGQgaGF2ZSBBdWRpdCBXYXJuaW5ncyBzZWN0aW9uXCIpO1xuICAgIGFzc2VydC5vayh0YWJsZS5pbmNsdWRlcyhcImdvdFwiKSwgXCJ0YWJsZSBzaG91bGQgY29udGFpbiBwYWNrYWdlIG5hbWVcIik7XG4gICAgYXNzZXJ0Lm9rKHRhYmxlLmluY2x1ZGVzKFwiXHVEODNEXHVERkUxIG1vZGVyYXRlXCIpLCBcInRhYmxlIHNob3VsZCBzaG93IG1vZGVyYXRlIHNldmVyaXR5IHdpdGggZW1vamlcIik7XG4gICAgYXNzZXJ0Lm9rKHRhYmxlLmluY2x1ZGVzKFwiUmVkaXJlY3QgYnlwYXNzXCIpLCBcInRhYmxlIHNob3VsZCBjb250YWluIHZ1bG5lcmFiaWxpdHkgdGl0bGVcIik7XG4gICAgYXNzZXJ0Lm9rKHRhYmxlLmluY2x1ZGVzKFwiXHUyNzA1IHllc1wiKSwgXCJ0YWJsZSBzaG91bGQgc2hvdyBmaXggYXZhaWxhYmxlXCIpO1xuICAgIC8vIENoZWNrIHRhYmxlIHN0aWxsIGhhcyB0aGUgbWFpbiB2ZXJpZmljYXRpb24gY2hlY2tzXG4gICAgYXNzZXJ0Lm9rKHRhYmxlLmluY2x1ZGVzKFwibnBtIHJ1biB0eXBlY2hlY2tcIiksIFwidGFibGUgc2hvdWxkIHN0aWxsIGhhdmUgbWFpbiBjaGVja1wiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBZ0JBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxXQUFXLGNBQWMsUUFBUSxrQkFBa0I7QUFDNUQsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUN2QjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUdQLFNBQVMsWUFBWSxRQUF3QjtBQUMzQyxRQUFN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
