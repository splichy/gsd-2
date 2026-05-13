import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
const baselineModule = await import("../../scripts/refactor-baseline.mjs");
const {
  BASELINE_REQUIRED_METRICS,
  buildMetricIndex,
  collectBaseline,
  collectContractsMetrics,
  collectDirectoryMetrics,
  collectPromptMetrics,
  collectProcessMetrics,
  collectTestCompileMetrics,
  compareReports,
  formatDelta,
  formatDeltaPercent,
  countMatches,
  countLegacyContractImports,
  hasProcessDocConflict,
  metricSafeLabel,
  numberOrZero,
  parseArgs,
  parseCommandSpec,
  renderSummary,
  writeJsonFile
} = baselineModule;
test("parseArgs accepts json, root, command, compare, and output options", () => {
  const opts = parseArgs([
    "--json",
    "--root",
    "/tmp/example",
    "--command",
    "noop=node -e 1",
    "--compare",
    "/tmp/before.json",
    "--output",
    "/tmp/after.json"
  ]);
  assert.equal(opts.json, true);
  assert.equal(opts.root, "/tmp/example");
  assert.deepEqual(opts.commands, [{ label: "noop", command: "node -e 1" }]);
  assert.equal(opts.compare, "/tmp/before.json");
  assert.equal(opts.output, "/tmp/after.json");
});
test("parseCommandSpec rejects unlabeled commands", () => {
  assert.throws(() => parseCommandSpec("npm test"), /label=command/);
  assert.throws(() => parseCommandSpec("missing="), /label=command/);
});
test("collectPromptMetrics reports prompt file size and hash data", async () => {
  const root = await makeFixtureRoot();
  await writeFile(
    join(root, "src/resources/extensions/gsd/prompts/execute-task.md"),
    "Run the task.\nVerify the result.\n"
  );
  await writeFile(
    join(root, "src/resources/extensions/gsd/prompts/plan-slice.md"),
    "Plan carefully.\n"
  );
  const metrics = await collectPromptMetrics(root);
  assert.equal(metrics.fileCount, 2);
  assert.equal(metrics.totalChars, "Run the task.\nVerify the result.\nPlan carefully.\n".length);
  assert.equal(metrics.largestFiles[0].path, "src/resources/extensions/gsd/prompts/execute-task.md");
  assert.match(metrics.files[0].sha256, /^[a-f0-9]{64}$/);
});
test("collectDirectoryMetrics returns empty data for missing directories", async () => {
  const root = await makeFixtureRoot();
  const metrics = await collectDirectoryMetrics(join(root, "dist-test"));
  assert.deepEqual(metrics, {
    exists: false,
    fileCount: 0,
    bytes: 0
  });
});
test("collectBaseline returns the phase-zero report shape", async () => {
  const root = await makeFixtureRoot();
  await writeFile(join(root, "CONTRIBUTING.md"), "# Contributing\n");
  await writeFile(join(root, "VISION.md"), "# Vision\n");
  await writeFile(join(root, "src/resources/extensions/gsd/prompts/system.md"), "System prompt\n");
  await writeContractsSurfaceFixtures(root);
  await writeProcessMetricFixtures(root);
  await writeFile(join(root, "src/tests/fixtures/contracts-golden-fixtures.ts"), "export const fixtures = [];\n");
  await mkdir(join(root, "dist-test"), { recursive: true });
  await writeFile(join(root, "dist-test/example.js"), "console.log('ok')\n");
  await writeTestCompileCache(root);
  const report = await collectBaseline(root);
  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(report.schema.requiredMetrics, BASELINE_REQUIRED_METRICS);
  assert.equal(report.prompt.fileCount, 1);
  assert.equal(report.context.fileCount, 2);
  assert.equal(report.distTest.exists, true);
  assert.equal(report.distTest.fileCount, 2);
  assert.equal(report.testCompile.cacheFileExists, true);
  assert.equal(report.metrics["testCompile.cacheHit"], 1);
  assert.equal(report.contracts.fixtures.total, 1);
  assert.equal(report.metrics["contracts.fixtures.sharedBySurface"], 6);
  assert.equal(report.process.prGeneratorConsumers, 3);
  assert.equal(report.metrics["process.prGeneratorConsumers"], 3);
  assert.equal(report.metrics["process.prBodiesMissingIssue"], 0);
  assert.equal(report.metrics["process.prBodiesMissingTests"], 0);
  assert.equal(report.metrics["process.docsConflictCount"], 0);
  assert.equal(report.metrics["process.shipPathCount"], 3);
  assert.equal(report.metrics["legacy.markdownFallbackUsed"], 0);
  assert.equal(report.metrics["legacy.workflowEngineUsed"], 0);
  assert.equal(report.metrics["legacy.uokFallbackUsed"], 0);
  assert.equal(report.metrics["legacy.mcpAliasUsed"], 0);
  assert.equal(report.metrics["legacy.componentFormatUsed"], 0);
  assert.equal(report.metrics["legacy.providerDefaultUsed"], 0);
  assert.equal(report.commands.length, 0);
  for (const metricName of BASELINE_REQUIRED_METRICS) {
    assert.equal(typeof report.metrics[metricName], "number", `${metricName} should be indexed as a number`);
  }
  assert.equal(report.workspace.areas.some((area) => area.area === "src"), true);
  assert.equal(report.startup.timingEnv, "GSD_STARTUP_TIMING=1");
});
test("buildMetricIndex includes workspace and command metrics", () => {
  const metrics = buildMetricIndex({
    prompt: { fileCount: 1, totalChars: 2, totalBytes: 3, totalLines: 4 },
    context: { fileCount: 5, totalChars: 6, totalBytes: 7, totalLines: 8 },
    distTest: { exists: true, fileCount: 9, bytes: 10 },
    contracts: {
      fixtures: { total: 16, sharedBySurface: 4 },
      surfaceDriftFailures: 1,
      legacyTypeImportsRemaining: 2
    },
    testCompile: {
      cacheFileExists: true,
      cacheHit: true,
      fileCount: 17,
      bytesCopied: 18,
      inputBytes: 19,
      wallMs: 20
    },
    process: {
      prGeneratorConsumers: 3,
      prBodiesMissingIssue: 0,
      prBodiesMissingTests: 0,
      docsConflictCount: 0,
      shipPathCount: 3
    },
    legacy: {
      markdownFallbackUsed: 1,
      workflowEngineUsed: 2,
      uokFallbackUsed: 3,
      mcpAliasUsed: 4,
      componentFormatUsed: 5,
      providerDefaultUsed: 6
    },
    workspace: {
      areas: [
        { area: "src", exists: true, fileCount: 11, bytes: 12 }
      ]
    },
    commands: [
      { label: "test compile", wallMs: 13, exitCode: 0, stdoutBytes: 14, stderrBytes: 15 },
      { label: "changed-src", wallMs: 21, exitCode: 0, stdoutBytes: 22, stderrBytes: 23 },
      { label: "verify-pr", wallMs: 24, exitCode: 0, stdoutBytes: 25, stderrBytes: 26 },
      { label: "test-compile-cold", wallMs: 27, exitCode: 0, stdoutBytes: 28, stderrBytes: 29 }
    ]
  });
  assert.equal(metrics["distTest.exists"], 1);
  assert.equal(metrics["contracts.fixtures.total"], 16);
  assert.equal(metrics["contracts.surfaceDriftFailures"], 1);
  assert.equal(metrics["workspace.src.fileCount"], 11);
  assert.equal(metrics["testCompile.cacheHit"], 1);
  assert.equal(metrics["testCompile.fileCount"], 17);
  assert.equal(metrics["process.prGeneratorConsumers"], 3);
  assert.equal(metrics["process.shipPathCount"], 3);
  assert.equal(metrics["legacy.markdownFallbackUsed"], 1);
  assert.equal(metrics["legacy.workflowEngineUsed"], 2);
  assert.equal(metrics["legacy.uokFallbackUsed"], 3);
  assert.equal(metrics["legacy.mcpAliasUsed"], 4);
  assert.equal(metrics["legacy.componentFormatUsed"], 5);
  assert.equal(metrics["legacy.providerDefaultUsed"], 6);
  assert.equal(metrics["command.test-compile.wallMs"], 13);
  assert.equal(metrics["verify.changedWallMs"], 21);
  assert.equal(metrics["verify.fullWallMs"], 24);
  assert.equal(metrics["testCompile.warmWallMs"], 13);
  assert.equal(metrics["testCompile.coldWallMs"], 27);
});
test("collectTestCompileMetrics reads stale-aware test compile cache metrics", async () => {
  const root = await makeFixtureRoot();
  await writeTestCompileCache(root);
  const metrics = await collectTestCompileMetrics(root);
  assert.deepEqual(metrics, {
    cacheFileExists: true,
    cacheHit: true,
    fileCount: 42,
    bytesCopied: 0,
    inputBytes: 1234,
    wallMs: 150
  });
});
test("collectTestCompileMetrics returns defaults when cache file is absent", async () => {
  const root = await makeFixtureRoot();
  const metrics = await collectTestCompileMetrics(root);
  assert.deepEqual(metrics, {
    cacheFileExists: false,
    cacheHit: null,
    fileCount: 0,
    bytesCopied: 0,
    inputBytes: 0,
    wallMs: 0
  });
});
test("collectContractsMetrics reports fixture coverage and surface drift", async () => {
  const root = await makeFixtureRoot();
  await writeContractsSurfaceFixtures(root);
  await writeFile(
    join(root, "src/tests/fixtures/contracts-golden-fixtures.ts"),
    "export const fixtures = [];\n"
  );
  const metrics = await collectContractsMetrics(root);
  assert.equal(metrics.fixtures.total, 1);
  assert.deepEqual(metrics.fixtures.files, ["src/tests/fixtures/contracts-golden-fixtures.ts"]);
  assert.equal(metrics.fixtures.sharedBySurface, 6);
  assert.equal(metrics.surfaceDriftFailures, 0);
  assert.equal(metrics.legacyTypeImportsRemaining, 0);
});
test("collectProcessMetrics reports Phase 7 process dashboard fields", async () => {
  const root = await makeFixtureRoot();
  await writeProcessMetricFixtures(root);
  await writeFile(
    join(root, "docs/dev/conflict.md"),
    "Markdown files are the authoritative state model.\n"
  );
  const metrics = await collectProcessMetrics(root);
  assert.equal(metrics.prGeneratorConsumers, 3);
  assert.deepEqual(metrics.prGeneratorConsumerFiles, [
    "src/resources/extensions/github-sync/templates.ts",
    "src/resources/extensions/gsd/auto-worktree.ts",
    "src/resources/extensions/gsd/commands-ship.ts"
  ]);
  assert.equal(metrics.prBodiesMissingIssue, 0);
  assert.equal(metrics.prBodiesMissingTests, 0);
  assert.equal(metrics.docsConflictCount, 1);
  assert.deepEqual(metrics.docsConflictFiles, ["docs/dev/conflict.md"]);
  assert.equal(metrics.shipPathCount, 3);
});
test("compareReports computes scalar metric deltas", () => {
  const previous = {
    generatedAt: "2026-05-03T00:00:00.000Z",
    metrics: {
      "prompt.totalChars": 100,
      "distTest.exists": 0,
      "only.before": 5
    }
  };
  const current = {
    generatedAt: "2026-05-03T01:00:00.000Z",
    metrics: {
      "prompt.totalChars": 80,
      "distTest.exists": 1,
      "only.after": 7
    }
  };
  const comparison = compareReports(previous, current);
  assert.equal(comparison.metricCount, 4);
  assert.deepEqual(comparison.deltas["prompt.totalChars"], {
    before: 100,
    after: 80,
    delta: -20,
    deltaPercent: -20
  });
  assert.equal(comparison.deltas["distTest.exists"].delta, 1);
  assert.equal(comparison.deltas["only.before"].after, null);
  assert.equal(comparison.deltas["only.after"].before, null);
});
test("formatDelta helpers render signed and unavailable values", () => {
  assert.equal(formatDelta(5), "+5");
  assert.equal(formatDelta(-2), "-2");
  assert.equal(formatDelta(null), "n/a");
  assert.equal(formatDeltaPercent(12.5), "+12.5%");
  assert.equal(formatDeltaPercent(-1), "-1%");
  assert.equal(formatDeltaPercent(null), "n/a");
});
test("numberOrZero normalizes invalid metric values", () => {
  assert.equal(numberOrZero(5), 5);
  assert.equal(numberOrZero(Number.NaN), 0);
  assert.equal(numberOrZero("5"), 0);
  assert.equal(numberOrZero(void 0), 0);
});
test("metricSafeLabel normalizes arbitrary command labels", () => {
  assert.equal(metricSafeLabel(" test compile "), "test-compile");
  assert.equal(metricSafeLabel("build:core"), "build-core");
  assert.equal(metricSafeLabel(""), "command");
});
test("countMatches counts non-overlapping pattern matches", () => {
  assert.equal(countMatches("one two one", /one/g), 2);
  assert.equal(countMatches("none", /missing/g), 0);
});
test("countLegacyContractImports ignores rpc-client implementation types", () => {
  assert.equal(
    countLegacyContractImports(`
      import type { RpcClient } from "@gsd-build/rpc-client";
      import type { SdkAgentEvent, RpcCostUpdateEvent } from "@gsd-build/rpc-client";
    `),
    2
  );
  assert.equal(
    countLegacyContractImports('import type { RpcClientOptions } from "@gsd-build/rpc-client";'),
    0
  );
});
test("hasProcessDocConflict flags obsolete state-authority language", () => {
  assert.equal(hasProcessDocConflict("DB is authoritative; markdown is a projection."), false);
  assert.equal(hasProcessDocConflict("Markdown files are the authoritative runtime state."), true);
  assert.equal(hasProcessDocConflict("The filesystem-authoritative model owns status."), true);
  assert.equal(hasProcessDocConflict(".gsd/ROADMAP.md is the source of truth."), true);
});
test("renderSummary includes key sections for human inspection", async () => {
  const root = await makeFixtureRoot();
  await writeFile(join(root, "src/resources/extensions/gsd/prompts/system.md"), "System prompt\n");
  const report = await collectBaseline(root);
  const summary = renderSummary(report);
  assert.match(summary, /GSD-2 Refactor Baseline/);
  assert.match(summary, /Schema version: 1/);
  assert.match(summary, /Prompt metrics/);
  assert.match(summary, /dist-test metrics/);
  assert.match(summary, /Test compile metrics/);
  assert.match(summary, /Contracts metrics/);
  assert.match(summary, /Process metrics/);
  assert.match(summary, /Legacy metrics/);
  assert.match(summary, /Largest prompt files/);
});
test("renderSummary includes comparison deltas when present", async () => {
  const root = await makeFixtureRoot();
  await writeFile(join(root, "src/resources/extensions/gsd/prompts/system.md"), "System prompt\n");
  const report = await collectBaseline(root);
  report.comparison = compareReports(
    { generatedAt: "before", metrics: { "prompt.totalChars": report.metrics["prompt.totalChars"] + 10 } },
    report
  );
  const summary = renderSummary(report);
  assert.match(summary, /Baseline comparison/);
  assert.match(summary, /prompt\.totalChars: 24 -> 14 \(-10, -41\.67%\)/);
});
test("writeJsonFile creates parent directories and writes parseable JSON", async () => {
  const root = await makeFixtureRoot();
  const outputPath = join(root, "nested", "baseline.json");
  await writeJsonFile(outputPath, { ok: true });
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), { ok: true });
});
async function makeFixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "gsd-refactor-baseline-"));
  await mkdir(join(root, "src/resources/extensions/gsd/prompts"), { recursive: true });
  await mkdir(join(root, "src/tests/fixtures"), { recursive: true });
  return root;
}
async function writeProcessMetricFixtures(root) {
  await mkdir(join(root, "src/resources/extensions/github-sync"), { recursive: true });
  await mkdir(join(root, "src/resources/extensions/gsd"), { recursive: true });
  await mkdir(join(root, "src/resources/extensions/gsd/docs"), { recursive: true });
  await mkdir(join(root, "docs/dev"), { recursive: true });
  await writeFile(
    join(root, "src/resources/extensions/gsd/pr-evidence.ts"),
    'export function buildPrEvidence() { return "## Linked Issue\\n## Tests Run"; }\n'
  );
  await writeFile(
    join(root, "src/resources/extensions/gsd/commands-ship.ts"),
    'import { buildPrEvidence } from "./pr-evidence.js"; buildPrEvidence(); ghCreatePR();\n'
  );
  await writeFile(
    join(root, "src/resources/extensions/gsd/auto-worktree.ts"),
    'import { buildPrEvidence } from "./pr-evidence.js"; buildPrEvidence(); createDraftPR();\n'
  );
  await writeFile(
    join(root, "src/resources/extensions/github-sync/templates.ts"),
    'import { buildPrEvidence } from "../gsd/pr-evidence.js"; buildPrEvidence(); ghCreatePR();\n'
  );
  await writeFile(
    join(root, "src/resources/extensions/gsd/docs/state.md"),
    "DB is authoritative. Markdown is a projection for humans.\n"
  );
}
async function writeContractsSurfaceFixtures(root) {
  const files = [
    "packages/pi-coding-agent/src/modes/rpc/rpc-types.ts",
    "packages/rpc-client/src/rpc-types.ts",
    "packages/mcp-server/src/types.ts",
    "src/web/bridge-service.ts",
    "web/lib/gsd-workspace-store.tsx",
    "vscode-extension/src/gsd-client.ts"
  ];
  for (const file of files) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), 'import type { RpcCommand } from "@gsd-build/contracts";\n');
  }
}
async function writeTestCompileCache(root) {
  await mkdir(join(root, "dist-test"), { recursive: true });
  await writeFile(
    join(root, "dist-test", ".compile-tests-cache.json"),
    JSON.stringify({
      schemaVersion: 1,
      hash: "abc",
      fileCount: 42,
      bytes: 1234,
      metrics: {
        cacheHit: true,
        fileCount: 42,
        bytesCopied: 0,
        inputBytes: 1234,
        wallMs: 150
      }
    })
  );
}
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3Rlc3RzL3JlZmFjdG9yLWJhc2VsaW5lLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFByb2plY3QvQXBwOiBHU0QtMlxuLy8gRmlsZSBQdXJwb3NlOiBUZXN0cyBmb3IgdGhlIGxvbmctcnVubmluZyByZWZhY3RvciBiYXNlbGluZSBtZXRyaWNzIGhhcm5lc3MuXG5cbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkaXIsIG1rZHRlbXAsIHJlYWRGaWxlLCB3cml0ZUZpbGUgfSBmcm9tIFwibm9kZTpmcy9wcm9taXNlc1wiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGRpcm5hbWUsIGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5cbmNvbnN0IGJhc2VsaW5lTW9kdWxlID0gYXdhaXQgaW1wb3J0KFwiLi4vLi4vc2NyaXB0cy9yZWZhY3Rvci1iYXNlbGluZS5tanNcIik7XG5cbmNvbnN0IHtcbiAgQkFTRUxJTkVfUkVRVUlSRURfTUVUUklDUyxcbiAgYnVpbGRNZXRyaWNJbmRleCxcbiAgY29sbGVjdEJhc2VsaW5lLFxuICBjb2xsZWN0Q29udHJhY3RzTWV0cmljcyxcbiAgY29sbGVjdERpcmVjdG9yeU1ldHJpY3MsXG4gIGNvbGxlY3RQcm9tcHRNZXRyaWNzLFxuICBjb2xsZWN0UHJvY2Vzc01ldHJpY3MsXG4gIGNvbGxlY3RUZXN0Q29tcGlsZU1ldHJpY3MsXG4gIGNvbXBhcmVSZXBvcnRzLFxuICBmb3JtYXREZWx0YSxcbiAgZm9ybWF0RGVsdGFQZXJjZW50LFxuICBjb3VudE1hdGNoZXMsXG4gIGNvdW50TGVnYWN5Q29udHJhY3RJbXBvcnRzLFxuICBoYXNQcm9jZXNzRG9jQ29uZmxpY3QsXG4gIG1ldHJpY1NhZmVMYWJlbCxcbiAgbnVtYmVyT3JaZXJvLFxuICBwYXJzZUFyZ3MsXG4gIHBhcnNlQ29tbWFuZFNwZWMsXG4gIHJlbmRlclN1bW1hcnksXG4gIHdyaXRlSnNvbkZpbGUsXG59ID0gYmFzZWxpbmVNb2R1bGU7XG5cbnRlc3QoXCJwYXJzZUFyZ3MgYWNjZXB0cyBqc29uLCByb290LCBjb21tYW5kLCBjb21wYXJlLCBhbmQgb3V0cHV0IG9wdGlvbnNcIiwgKCkgPT4ge1xuICBjb25zdCBvcHRzID0gcGFyc2VBcmdzKFtcbiAgICBcIi0tanNvblwiLFxuICAgIFwiLS1yb290XCIsXG4gICAgXCIvdG1wL2V4YW1wbGVcIixcbiAgICBcIi0tY29tbWFuZFwiLFxuICAgIFwibm9vcD1ub2RlIC1lIDFcIixcbiAgICBcIi0tY29tcGFyZVwiLFxuICAgIFwiL3RtcC9iZWZvcmUuanNvblwiLFxuICAgIFwiLS1vdXRwdXRcIixcbiAgICBcIi90bXAvYWZ0ZXIuanNvblwiLFxuICBdKTtcblxuICBhc3NlcnQuZXF1YWwob3B0cy5qc29uLCB0cnVlKTtcbiAgYXNzZXJ0LmVxdWFsKG9wdHMucm9vdCwgXCIvdG1wL2V4YW1wbGVcIik7XG4gIGFzc2VydC5kZWVwRXF1YWwob3B0cy5jb21tYW5kcywgW3sgbGFiZWw6IFwibm9vcFwiLCBjb21tYW5kOiBcIm5vZGUgLWUgMVwiIH1dKTtcbiAgYXNzZXJ0LmVxdWFsKG9wdHMuY29tcGFyZSwgXCIvdG1wL2JlZm9yZS5qc29uXCIpO1xuICBhc3NlcnQuZXF1YWwob3B0cy5vdXRwdXQsIFwiL3RtcC9hZnRlci5qc29uXCIpO1xufSk7XG5cbnRlc3QoXCJwYXJzZUNvbW1hbmRTcGVjIHJlamVjdHMgdW5sYWJlbGVkIGNvbW1hbmRzXCIsICgpID0+IHtcbiAgYXNzZXJ0LnRocm93cygoKSA9PiBwYXJzZUNvbW1hbmRTcGVjKFwibnBtIHRlc3RcIiksIC9sYWJlbD1jb21tYW5kLyk7XG4gIGFzc2VydC50aHJvd3MoKCkgPT4gcGFyc2VDb21tYW5kU3BlYyhcIm1pc3Npbmc9XCIpLCAvbGFiZWw9Y29tbWFuZC8pO1xufSk7XG5cbnRlc3QoXCJjb2xsZWN0UHJvbXB0TWV0cmljcyByZXBvcnRzIHByb21wdCBmaWxlIHNpemUgYW5kIGhhc2ggZGF0YVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHJvb3QgPSBhd2FpdCBtYWtlRml4dHVyZVJvb3QoKTtcbiAgYXdhaXQgd3JpdGVGaWxlKFxuICAgIGpvaW4ocm9vdCwgXCJzcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL3Byb21wdHMvZXhlY3V0ZS10YXNrLm1kXCIpLFxuICAgIFwiUnVuIHRoZSB0YXNrLlxcblZlcmlmeSB0aGUgcmVzdWx0LlxcblwiLFxuICApO1xuICBhd2FpdCB3cml0ZUZpbGUoXG4gICAgam9pbihyb290LCBcInNyYy9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvcHJvbXB0cy9wbGFuLXNsaWNlLm1kXCIpLFxuICAgIFwiUGxhbiBjYXJlZnVsbHkuXFxuXCIsXG4gICk7XG5cbiAgY29uc3QgbWV0cmljcyA9IGF3YWl0IGNvbGxlY3RQcm9tcHRNZXRyaWNzKHJvb3QpO1xuXG4gIGFzc2VydC5lcXVhbChtZXRyaWNzLmZpbGVDb3VudCwgMik7XG4gIGFzc2VydC5lcXVhbChtZXRyaWNzLnRvdGFsQ2hhcnMsIFwiUnVuIHRoZSB0YXNrLlxcblZlcmlmeSB0aGUgcmVzdWx0LlxcblBsYW4gY2FyZWZ1bGx5LlxcblwiLmxlbmd0aCk7XG4gIGFzc2VydC5lcXVhbChtZXRyaWNzLmxhcmdlc3RGaWxlc1swXS5wYXRoLCBcInNyYy9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvcHJvbXB0cy9leGVjdXRlLXRhc2subWRcIik7XG4gIGFzc2VydC5tYXRjaChtZXRyaWNzLmZpbGVzWzBdLnNoYTI1NiwgL15bYS1mMC05XXs2NH0kLyk7XG59KTtcblxudGVzdChcImNvbGxlY3REaXJlY3RvcnlNZXRyaWNzIHJldHVybnMgZW1wdHkgZGF0YSBmb3IgbWlzc2luZyBkaXJlY3Rvcmllc1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHJvb3QgPSBhd2FpdCBtYWtlRml4dHVyZVJvb3QoKTtcbiAgY29uc3QgbWV0cmljcyA9IGF3YWl0IGNvbGxlY3REaXJlY3RvcnlNZXRyaWNzKGpvaW4ocm9vdCwgXCJkaXN0LXRlc3RcIikpO1xuXG4gIGFzc2VydC5kZWVwRXF1YWwobWV0cmljcywge1xuICAgIGV4aXN0czogZmFsc2UsXG4gICAgZmlsZUNvdW50OiAwLFxuICAgIGJ5dGVzOiAwLFxuICB9KTtcbn0pO1xuXG50ZXN0KFwiY29sbGVjdEJhc2VsaW5lIHJldHVybnMgdGhlIHBoYXNlLXplcm8gcmVwb3J0IHNoYXBlXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3Qgcm9vdCA9IGF3YWl0IG1ha2VGaXh0dXJlUm9vdCgpO1xuICBhd2FpdCB3cml0ZUZpbGUoam9pbihyb290LCBcIkNPTlRSSUJVVElORy5tZFwiKSwgXCIjIENvbnRyaWJ1dGluZ1xcblwiKTtcbiAgYXdhaXQgd3JpdGVGaWxlKGpvaW4ocm9vdCwgXCJWSVNJT04ubWRcIiksIFwiIyBWaXNpb25cXG5cIik7XG4gIGF3YWl0IHdyaXRlRmlsZShqb2luKHJvb3QsIFwic3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9wcm9tcHRzL3N5c3RlbS5tZFwiKSwgXCJTeXN0ZW0gcHJvbXB0XFxuXCIpO1xuICBhd2FpdCB3cml0ZUNvbnRyYWN0c1N1cmZhY2VGaXh0dXJlcyhyb290KTtcbiAgYXdhaXQgd3JpdGVQcm9jZXNzTWV0cmljRml4dHVyZXMocm9vdCk7XG4gIGF3YWl0IHdyaXRlRmlsZShqb2luKHJvb3QsIFwic3JjL3Rlc3RzL2ZpeHR1cmVzL2NvbnRyYWN0cy1nb2xkZW4tZml4dHVyZXMudHNcIiksIFwiZXhwb3J0IGNvbnN0IGZpeHR1cmVzID0gW107XFxuXCIpO1xuICBhd2FpdCBta2Rpcihqb2luKHJvb3QsIFwiZGlzdC10ZXN0XCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgYXdhaXQgd3JpdGVGaWxlKGpvaW4ocm9vdCwgXCJkaXN0LXRlc3QvZXhhbXBsZS5qc1wiKSwgXCJjb25zb2xlLmxvZygnb2snKVxcblwiKTtcbiAgYXdhaXQgd3JpdGVUZXN0Q29tcGlsZUNhY2hlKHJvb3QpO1xuXG4gIGNvbnN0IHJlcG9ydCA9IGF3YWl0IGNvbGxlY3RCYXNlbGluZShyb290KTtcblxuICBhc3NlcnQuZXF1YWwocmVwb3J0LnNjaGVtYVZlcnNpb24sIDEpO1xuICBhc3NlcnQuZGVlcEVxdWFsKHJlcG9ydC5zY2hlbWEucmVxdWlyZWRNZXRyaWNzLCBCQVNFTElORV9SRVFVSVJFRF9NRVRSSUNTKTtcbiAgYXNzZXJ0LmVxdWFsKHJlcG9ydC5wcm9tcHQuZmlsZUNvdW50LCAxKTtcbiAgYXNzZXJ0LmVxdWFsKHJlcG9ydC5jb250ZXh0LmZpbGVDb3VudCwgMik7XG4gIGFzc2VydC5lcXVhbChyZXBvcnQuZGlzdFRlc3QuZXhpc3RzLCB0cnVlKTtcbiAgYXNzZXJ0LmVxdWFsKHJlcG9ydC5kaXN0VGVzdC5maWxlQ291bnQsIDIpO1xuICBhc3NlcnQuZXF1YWwocmVwb3J0LnRlc3RDb21waWxlLmNhY2hlRmlsZUV4aXN0cywgdHJ1ZSk7XG4gIGFzc2VydC5lcXVhbChyZXBvcnQubWV0cmljc1tcInRlc3RDb21waWxlLmNhY2hlSGl0XCJdLCAxKTtcbiAgYXNzZXJ0LmVxdWFsKHJlcG9ydC5jb250cmFjdHMuZml4dHVyZXMudG90YWwsIDEpO1xuICBhc3NlcnQuZXF1YWwocmVwb3J0Lm1ldHJpY3NbXCJjb250cmFjdHMuZml4dHVyZXMuc2hhcmVkQnlTdXJmYWNlXCJdLCA2KTtcbiAgYXNzZXJ0LmVxdWFsKHJlcG9ydC5wcm9jZXNzLnByR2VuZXJhdG9yQ29uc3VtZXJzLCAzKTtcbiAgYXNzZXJ0LmVxdWFsKHJlcG9ydC5tZXRyaWNzW1wicHJvY2Vzcy5wckdlbmVyYXRvckNvbnN1bWVyc1wiXSwgMyk7XG4gIGFzc2VydC5lcXVhbChyZXBvcnQubWV0cmljc1tcInByb2Nlc3MucHJCb2RpZXNNaXNzaW5nSXNzdWVcIl0sIDApO1xuICBhc3NlcnQuZXF1YWwocmVwb3J0Lm1ldHJpY3NbXCJwcm9jZXNzLnByQm9kaWVzTWlzc2luZ1Rlc3RzXCJdLCAwKTtcbiAgYXNzZXJ0LmVxdWFsKHJlcG9ydC5tZXRyaWNzW1wicHJvY2Vzcy5kb2NzQ29uZmxpY3RDb3VudFwiXSwgMCk7XG4gIGFzc2VydC5lcXVhbChyZXBvcnQubWV0cmljc1tcInByb2Nlc3Muc2hpcFBhdGhDb3VudFwiXSwgMyk7XG4gIGFzc2VydC5lcXVhbChyZXBvcnQubWV0cmljc1tcImxlZ2FjeS5tYXJrZG93bkZhbGxiYWNrVXNlZFwiXSwgMCk7XG4gIGFzc2VydC5lcXVhbChyZXBvcnQubWV0cmljc1tcImxlZ2FjeS53b3JrZmxvd0VuZ2luZVVzZWRcIl0sIDApO1xuICBhc3NlcnQuZXF1YWwocmVwb3J0Lm1ldHJpY3NbXCJsZWdhY3kudW9rRmFsbGJhY2tVc2VkXCJdLCAwKTtcbiAgYXNzZXJ0LmVxdWFsKHJlcG9ydC5tZXRyaWNzW1wibGVnYWN5Lm1jcEFsaWFzVXNlZFwiXSwgMCk7XG4gIGFzc2VydC5lcXVhbChyZXBvcnQubWV0cmljc1tcImxlZ2FjeS5jb21wb25lbnRGb3JtYXRVc2VkXCJdLCAwKTtcbiAgYXNzZXJ0LmVxdWFsKHJlcG9ydC5tZXRyaWNzW1wibGVnYWN5LnByb3ZpZGVyRGVmYXVsdFVzZWRcIl0sIDApO1xuICBhc3NlcnQuZXF1YWwocmVwb3J0LmNvbW1hbmRzLmxlbmd0aCwgMCk7XG4gIGZvciAoY29uc3QgbWV0cmljTmFtZSBvZiBCQVNFTElORV9SRVFVSVJFRF9NRVRSSUNTKSB7XG4gICAgYXNzZXJ0LmVxdWFsKHR5cGVvZiByZXBvcnQubWV0cmljc1ttZXRyaWNOYW1lXSwgXCJudW1iZXJcIiwgYCR7bWV0cmljTmFtZX0gc2hvdWxkIGJlIGluZGV4ZWQgYXMgYSBudW1iZXJgKTtcbiAgfVxuICBhc3NlcnQuZXF1YWwocmVwb3J0LndvcmtzcGFjZS5hcmVhcy5zb21lKChhcmVhOiB7IGFyZWE6IHN0cmluZyB9KSA9PiBhcmVhLmFyZWEgPT09IFwic3JjXCIpLCB0cnVlKTtcbiAgYXNzZXJ0LmVxdWFsKHJlcG9ydC5zdGFydHVwLnRpbWluZ0VudiwgXCJHU0RfU1RBUlRVUF9USU1JTkc9MVwiKTtcbn0pO1xuXG50ZXN0KFwiYnVpbGRNZXRyaWNJbmRleCBpbmNsdWRlcyB3b3Jrc3BhY2UgYW5kIGNvbW1hbmQgbWV0cmljc1wiLCAoKSA9PiB7XG4gIGNvbnN0IG1ldHJpY3MgPSBidWlsZE1ldHJpY0luZGV4KHtcbiAgICBwcm9tcHQ6IHsgZmlsZUNvdW50OiAxLCB0b3RhbENoYXJzOiAyLCB0b3RhbEJ5dGVzOiAzLCB0b3RhbExpbmVzOiA0IH0sXG4gICAgY29udGV4dDogeyBmaWxlQ291bnQ6IDUsIHRvdGFsQ2hhcnM6IDYsIHRvdGFsQnl0ZXM6IDcsIHRvdGFsTGluZXM6IDggfSxcbiAgICBkaXN0VGVzdDogeyBleGlzdHM6IHRydWUsIGZpbGVDb3VudDogOSwgYnl0ZXM6IDEwIH0sXG4gICAgY29udHJhY3RzOiB7XG4gICAgICBmaXh0dXJlczogeyB0b3RhbDogMTYsIHNoYXJlZEJ5U3VyZmFjZTogNCB9LFxuICAgICAgc3VyZmFjZURyaWZ0RmFpbHVyZXM6IDEsXG4gICAgICBsZWdhY3lUeXBlSW1wb3J0c1JlbWFpbmluZzogMixcbiAgICB9LFxuICAgIHRlc3RDb21waWxlOiB7XG4gICAgICBjYWNoZUZpbGVFeGlzdHM6IHRydWUsXG4gICAgICBjYWNoZUhpdDogdHJ1ZSxcbiAgICAgIGZpbGVDb3VudDogMTcsXG4gICAgICBieXRlc0NvcGllZDogMTgsXG4gICAgICBpbnB1dEJ5dGVzOiAxOSxcbiAgICAgIHdhbGxNczogMjAsXG4gICAgfSxcbiAgICBwcm9jZXNzOiB7XG4gICAgICBwckdlbmVyYXRvckNvbnN1bWVyczogMyxcbiAgICAgIHByQm9kaWVzTWlzc2luZ0lzc3VlOiAwLFxuICAgICAgcHJCb2RpZXNNaXNzaW5nVGVzdHM6IDAsXG4gICAgICBkb2NzQ29uZmxpY3RDb3VudDogMCxcbiAgICAgIHNoaXBQYXRoQ291bnQ6IDMsXG4gICAgfSxcbiAgICBsZWdhY3k6IHtcbiAgICAgIG1hcmtkb3duRmFsbGJhY2tVc2VkOiAxLFxuICAgICAgd29ya2Zsb3dFbmdpbmVVc2VkOiAyLFxuICAgICAgdW9rRmFsbGJhY2tVc2VkOiAzLFxuICAgICAgbWNwQWxpYXNVc2VkOiA0LFxuICAgICAgY29tcG9uZW50Rm9ybWF0VXNlZDogNSxcbiAgICAgIHByb3ZpZGVyRGVmYXVsdFVzZWQ6IDYsXG4gICAgfSxcbiAgICB3b3Jrc3BhY2U6IHtcbiAgICAgIGFyZWFzOiBbXG4gICAgICAgIHsgYXJlYTogXCJzcmNcIiwgZXhpc3RzOiB0cnVlLCBmaWxlQ291bnQ6IDExLCBieXRlczogMTIgfSxcbiAgICAgIF0sXG4gICAgfSxcbiAgICBjb21tYW5kczogW1xuICAgICAgeyBsYWJlbDogXCJ0ZXN0IGNvbXBpbGVcIiwgd2FsbE1zOiAxMywgZXhpdENvZGU6IDAsIHN0ZG91dEJ5dGVzOiAxNCwgc3RkZXJyQnl0ZXM6IDE1IH0sXG4gICAgICB7IGxhYmVsOiBcImNoYW5nZWQtc3JjXCIsIHdhbGxNczogMjEsIGV4aXRDb2RlOiAwLCBzdGRvdXRCeXRlczogMjIsIHN0ZGVyckJ5dGVzOiAyMyB9LFxuICAgICAgeyBsYWJlbDogXCJ2ZXJpZnktcHJcIiwgd2FsbE1zOiAyNCwgZXhpdENvZGU6IDAsIHN0ZG91dEJ5dGVzOiAyNSwgc3RkZXJyQnl0ZXM6IDI2IH0sXG4gICAgICB7IGxhYmVsOiBcInRlc3QtY29tcGlsZS1jb2xkXCIsIHdhbGxNczogMjcsIGV4aXRDb2RlOiAwLCBzdGRvdXRCeXRlczogMjgsIHN0ZGVyckJ5dGVzOiAyOSB9LFxuICAgIF0sXG4gIH0pO1xuXG4gIGFzc2VydC5lcXVhbChtZXRyaWNzW1wiZGlzdFRlc3QuZXhpc3RzXCJdLCAxKTtcbiAgYXNzZXJ0LmVxdWFsKG1ldHJpY3NbXCJjb250cmFjdHMuZml4dHVyZXMudG90YWxcIl0sIDE2KTtcbiAgYXNzZXJ0LmVxdWFsKG1ldHJpY3NbXCJjb250cmFjdHMuc3VyZmFjZURyaWZ0RmFpbHVyZXNcIl0sIDEpO1xuICBhc3NlcnQuZXF1YWwobWV0cmljc1tcIndvcmtzcGFjZS5zcmMuZmlsZUNvdW50XCJdLCAxMSk7XG4gIGFzc2VydC5lcXVhbChtZXRyaWNzW1widGVzdENvbXBpbGUuY2FjaGVIaXRcIl0sIDEpO1xuICBhc3NlcnQuZXF1YWwobWV0cmljc1tcInRlc3RDb21waWxlLmZpbGVDb3VudFwiXSwgMTcpO1xuICBhc3NlcnQuZXF1YWwobWV0cmljc1tcInByb2Nlc3MucHJHZW5lcmF0b3JDb25zdW1lcnNcIl0sIDMpO1xuICBhc3NlcnQuZXF1YWwobWV0cmljc1tcInByb2Nlc3Muc2hpcFBhdGhDb3VudFwiXSwgMyk7XG4gIGFzc2VydC5lcXVhbChtZXRyaWNzW1wibGVnYWN5Lm1hcmtkb3duRmFsbGJhY2tVc2VkXCJdLCAxKTtcbiAgYXNzZXJ0LmVxdWFsKG1ldHJpY3NbXCJsZWdhY3kud29ya2Zsb3dFbmdpbmVVc2VkXCJdLCAyKTtcbiAgYXNzZXJ0LmVxdWFsKG1ldHJpY3NbXCJsZWdhY3kudW9rRmFsbGJhY2tVc2VkXCJdLCAzKTtcbiAgYXNzZXJ0LmVxdWFsKG1ldHJpY3NbXCJsZWdhY3kubWNwQWxpYXNVc2VkXCJdLCA0KTtcbiAgYXNzZXJ0LmVxdWFsKG1ldHJpY3NbXCJsZWdhY3kuY29tcG9uZW50Rm9ybWF0VXNlZFwiXSwgNSk7XG4gIGFzc2VydC5lcXVhbChtZXRyaWNzW1wibGVnYWN5LnByb3ZpZGVyRGVmYXVsdFVzZWRcIl0sIDYpO1xuICBhc3NlcnQuZXF1YWwobWV0cmljc1tcImNvbW1hbmQudGVzdC1jb21waWxlLndhbGxNc1wiXSwgMTMpO1xuICBhc3NlcnQuZXF1YWwobWV0cmljc1tcInZlcmlmeS5jaGFuZ2VkV2FsbE1zXCJdLCAyMSk7XG4gIGFzc2VydC5lcXVhbChtZXRyaWNzW1widmVyaWZ5LmZ1bGxXYWxsTXNcIl0sIDI0KTtcbiAgYXNzZXJ0LmVxdWFsKG1ldHJpY3NbXCJ0ZXN0Q29tcGlsZS53YXJtV2FsbE1zXCJdLCAxMyk7XG4gIGFzc2VydC5lcXVhbChtZXRyaWNzW1widGVzdENvbXBpbGUuY29sZFdhbGxNc1wiXSwgMjcpO1xufSk7XG5cbnRlc3QoXCJjb2xsZWN0VGVzdENvbXBpbGVNZXRyaWNzIHJlYWRzIHN0YWxlLWF3YXJlIHRlc3QgY29tcGlsZSBjYWNoZSBtZXRyaWNzXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3Qgcm9vdCA9IGF3YWl0IG1ha2VGaXh0dXJlUm9vdCgpO1xuICBhd2FpdCB3cml0ZVRlc3RDb21waWxlQ2FjaGUocm9vdCk7XG5cbiAgY29uc3QgbWV0cmljcyA9IGF3YWl0IGNvbGxlY3RUZXN0Q29tcGlsZU1ldHJpY3Mocm9vdCk7XG5cbiAgYXNzZXJ0LmRlZXBFcXVhbChtZXRyaWNzLCB7XG4gICAgY2FjaGVGaWxlRXhpc3RzOiB0cnVlLFxuICAgIGNhY2hlSGl0OiB0cnVlLFxuICAgIGZpbGVDb3VudDogNDIsXG4gICAgYnl0ZXNDb3BpZWQ6IDAsXG4gICAgaW5wdXRCeXRlczogMTIzNCxcbiAgICB3YWxsTXM6IDE1MCxcbiAgfSk7XG59KTtcblxudGVzdChcImNvbGxlY3RUZXN0Q29tcGlsZU1ldHJpY3MgcmV0dXJucyBkZWZhdWx0cyB3aGVuIGNhY2hlIGZpbGUgaXMgYWJzZW50XCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3Qgcm9vdCA9IGF3YWl0IG1ha2VGaXh0dXJlUm9vdCgpO1xuXG4gIGNvbnN0IG1ldHJpY3MgPSBhd2FpdCBjb2xsZWN0VGVzdENvbXBpbGVNZXRyaWNzKHJvb3QpO1xuXG4gIGFzc2VydC5kZWVwRXF1YWwobWV0cmljcywge1xuICAgIGNhY2hlRmlsZUV4aXN0czogZmFsc2UsXG4gICAgY2FjaGVIaXQ6IG51bGwsXG4gICAgZmlsZUNvdW50OiAwLFxuICAgIGJ5dGVzQ29waWVkOiAwLFxuICAgIGlucHV0Qnl0ZXM6IDAsXG4gICAgd2FsbE1zOiAwLFxuICB9KTtcbn0pO1xuXG50ZXN0KFwiY29sbGVjdENvbnRyYWN0c01ldHJpY3MgcmVwb3J0cyBmaXh0dXJlIGNvdmVyYWdlIGFuZCBzdXJmYWNlIGRyaWZ0XCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3Qgcm9vdCA9IGF3YWl0IG1ha2VGaXh0dXJlUm9vdCgpO1xuICBhd2FpdCB3cml0ZUNvbnRyYWN0c1N1cmZhY2VGaXh0dXJlcyhyb290KTtcbiAgYXdhaXQgd3JpdGVGaWxlKFxuICAgIGpvaW4ocm9vdCwgXCJzcmMvdGVzdHMvZml4dHVyZXMvY29udHJhY3RzLWdvbGRlbi1maXh0dXJlcy50c1wiKSxcbiAgICBcImV4cG9ydCBjb25zdCBmaXh0dXJlcyA9IFtdO1xcblwiLFxuICApO1xuXG4gIGNvbnN0IG1ldHJpY3MgPSBhd2FpdCBjb2xsZWN0Q29udHJhY3RzTWV0cmljcyhyb290KTtcblxuICBhc3NlcnQuZXF1YWwobWV0cmljcy5maXh0dXJlcy50b3RhbCwgMSk7XG4gIGFzc2VydC5kZWVwRXF1YWwobWV0cmljcy5maXh0dXJlcy5maWxlcywgW1wic3JjL3Rlc3RzL2ZpeHR1cmVzL2NvbnRyYWN0cy1nb2xkZW4tZml4dHVyZXMudHNcIl0pO1xuICBhc3NlcnQuZXF1YWwobWV0cmljcy5maXh0dXJlcy5zaGFyZWRCeVN1cmZhY2UsIDYpO1xuICBhc3NlcnQuZXF1YWwobWV0cmljcy5zdXJmYWNlRHJpZnRGYWlsdXJlcywgMCk7XG4gIGFzc2VydC5lcXVhbChtZXRyaWNzLmxlZ2FjeVR5cGVJbXBvcnRzUmVtYWluaW5nLCAwKTtcbn0pO1xuXG50ZXN0KFwiY29sbGVjdFByb2Nlc3NNZXRyaWNzIHJlcG9ydHMgUGhhc2UgNyBwcm9jZXNzIGRhc2hib2FyZCBmaWVsZHNcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCByb290ID0gYXdhaXQgbWFrZUZpeHR1cmVSb290KCk7XG4gIGF3YWl0IHdyaXRlUHJvY2Vzc01ldHJpY0ZpeHR1cmVzKHJvb3QpO1xuICBhd2FpdCB3cml0ZUZpbGUoXG4gICAgam9pbihyb290LCBcImRvY3MvZGV2L2NvbmZsaWN0Lm1kXCIpLFxuICAgIFwiTWFya2Rvd24gZmlsZXMgYXJlIHRoZSBhdXRob3JpdGF0aXZlIHN0YXRlIG1vZGVsLlxcblwiLFxuICApO1xuXG4gIGNvbnN0IG1ldHJpY3MgPSBhd2FpdCBjb2xsZWN0UHJvY2Vzc01ldHJpY3Mocm9vdCk7XG5cbiAgYXNzZXJ0LmVxdWFsKG1ldHJpY3MucHJHZW5lcmF0b3JDb25zdW1lcnMsIDMpO1xuICBhc3NlcnQuZGVlcEVxdWFsKG1ldHJpY3MucHJHZW5lcmF0b3JDb25zdW1lckZpbGVzLCBbXG4gICAgXCJzcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ2l0aHViLXN5bmMvdGVtcGxhdGVzLnRzXCIsXG4gICAgXCJzcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL2F1dG8td29ya3RyZWUudHNcIixcbiAgICBcInNyYy9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvY29tbWFuZHMtc2hpcC50c1wiLFxuICBdKTtcbiAgYXNzZXJ0LmVxdWFsKG1ldHJpY3MucHJCb2RpZXNNaXNzaW5nSXNzdWUsIDApO1xuICBhc3NlcnQuZXF1YWwobWV0cmljcy5wckJvZGllc01pc3NpbmdUZXN0cywgMCk7XG4gIGFzc2VydC5lcXVhbChtZXRyaWNzLmRvY3NDb25mbGljdENvdW50LCAxKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChtZXRyaWNzLmRvY3NDb25mbGljdEZpbGVzLCBbXCJkb2NzL2Rldi9jb25mbGljdC5tZFwiXSk7XG4gIGFzc2VydC5lcXVhbChtZXRyaWNzLnNoaXBQYXRoQ291bnQsIDMpO1xufSk7XG5cbnRlc3QoXCJjb21wYXJlUmVwb3J0cyBjb21wdXRlcyBzY2FsYXIgbWV0cmljIGRlbHRhc1wiLCAoKSA9PiB7XG4gIGNvbnN0IHByZXZpb3VzID0ge1xuICAgIGdlbmVyYXRlZEF0OiBcIjIwMjYtMDUtMDNUMDA6MDA6MDAuMDAwWlwiLFxuICAgIG1ldHJpY3M6IHtcbiAgICAgIFwicHJvbXB0LnRvdGFsQ2hhcnNcIjogMTAwLFxuICAgICAgXCJkaXN0VGVzdC5leGlzdHNcIjogMCxcbiAgICAgIFwib25seS5iZWZvcmVcIjogNSxcbiAgICB9LFxuICB9O1xuICBjb25zdCBjdXJyZW50ID0ge1xuICAgIGdlbmVyYXRlZEF0OiBcIjIwMjYtMDUtMDNUMDE6MDA6MDAuMDAwWlwiLFxuICAgIG1ldHJpY3M6IHtcbiAgICAgIFwicHJvbXB0LnRvdGFsQ2hhcnNcIjogODAsXG4gICAgICBcImRpc3RUZXN0LmV4aXN0c1wiOiAxLFxuICAgICAgXCJvbmx5LmFmdGVyXCI6IDcsXG4gICAgfSxcbiAgfTtcblxuICBjb25zdCBjb21wYXJpc29uID0gY29tcGFyZVJlcG9ydHMocHJldmlvdXMsIGN1cnJlbnQpO1xuXG4gIGFzc2VydC5lcXVhbChjb21wYXJpc29uLm1ldHJpY0NvdW50LCA0KTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChjb21wYXJpc29uLmRlbHRhc1tcInByb21wdC50b3RhbENoYXJzXCJdLCB7XG4gICAgYmVmb3JlOiAxMDAsXG4gICAgYWZ0ZXI6IDgwLFxuICAgIGRlbHRhOiAtMjAsXG4gICAgZGVsdGFQZXJjZW50OiAtMjAsXG4gIH0pO1xuICBhc3NlcnQuZXF1YWwoY29tcGFyaXNvbi5kZWx0YXNbXCJkaXN0VGVzdC5leGlzdHNcIl0uZGVsdGEsIDEpO1xuICBhc3NlcnQuZXF1YWwoY29tcGFyaXNvbi5kZWx0YXNbXCJvbmx5LmJlZm9yZVwiXS5hZnRlciwgbnVsbCk7XG4gIGFzc2VydC5lcXVhbChjb21wYXJpc29uLmRlbHRhc1tcIm9ubHkuYWZ0ZXJcIl0uYmVmb3JlLCBudWxsKTtcbn0pO1xuXG50ZXN0KFwiZm9ybWF0RGVsdGEgaGVscGVycyByZW5kZXIgc2lnbmVkIGFuZCB1bmF2YWlsYWJsZSB2YWx1ZXNcIiwgKCkgPT4ge1xuICBhc3NlcnQuZXF1YWwoZm9ybWF0RGVsdGEoNSksIFwiKzVcIik7XG4gIGFzc2VydC5lcXVhbChmb3JtYXREZWx0YSgtMiksIFwiLTJcIik7XG4gIGFzc2VydC5lcXVhbChmb3JtYXREZWx0YShudWxsKSwgXCJuL2FcIik7XG4gIGFzc2VydC5lcXVhbChmb3JtYXREZWx0YVBlcmNlbnQoMTIuNSksIFwiKzEyLjUlXCIpO1xuICBhc3NlcnQuZXF1YWwoZm9ybWF0RGVsdGFQZXJjZW50KC0xKSwgXCItMSVcIik7XG4gIGFzc2VydC5lcXVhbChmb3JtYXREZWx0YVBlcmNlbnQobnVsbCksIFwibi9hXCIpO1xufSk7XG5cbnRlc3QoXCJudW1iZXJPclplcm8gbm9ybWFsaXplcyBpbnZhbGlkIG1ldHJpYyB2YWx1ZXNcIiwgKCkgPT4ge1xuICBhc3NlcnQuZXF1YWwobnVtYmVyT3JaZXJvKDUpLCA1KTtcbiAgYXNzZXJ0LmVxdWFsKG51bWJlck9yWmVybyhOdW1iZXIuTmFOKSwgMCk7XG4gIGFzc2VydC5lcXVhbChudW1iZXJPclplcm8oXCI1XCIpLCAwKTtcbiAgYXNzZXJ0LmVxdWFsKG51bWJlck9yWmVybyh1bmRlZmluZWQpLCAwKTtcbn0pO1xuXG50ZXN0KFwibWV0cmljU2FmZUxhYmVsIG5vcm1hbGl6ZXMgYXJiaXRyYXJ5IGNvbW1hbmQgbGFiZWxzXCIsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKG1ldHJpY1NhZmVMYWJlbChcIiB0ZXN0IGNvbXBpbGUgXCIpLCBcInRlc3QtY29tcGlsZVwiKTtcbiAgYXNzZXJ0LmVxdWFsKG1ldHJpY1NhZmVMYWJlbChcImJ1aWxkOmNvcmVcIiksIFwiYnVpbGQtY29yZVwiKTtcbiAgYXNzZXJ0LmVxdWFsKG1ldHJpY1NhZmVMYWJlbChcIlwiKSwgXCJjb21tYW5kXCIpO1xufSk7XG5cbnRlc3QoXCJjb3VudE1hdGNoZXMgY291bnRzIG5vbi1vdmVybGFwcGluZyBwYXR0ZXJuIG1hdGNoZXNcIiwgKCkgPT4ge1xuICBhc3NlcnQuZXF1YWwoY291bnRNYXRjaGVzKFwib25lIHR3byBvbmVcIiwgL29uZS9nKSwgMik7XG4gIGFzc2VydC5lcXVhbChjb3VudE1hdGNoZXMoXCJub25lXCIsIC9taXNzaW5nL2cpLCAwKTtcbn0pO1xuXG50ZXN0KFwiY291bnRMZWdhY3lDb250cmFjdEltcG9ydHMgaWdub3JlcyBycGMtY2xpZW50IGltcGxlbWVudGF0aW9uIHR5cGVzXCIsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKFxuICAgIGNvdW50TGVnYWN5Q29udHJhY3RJbXBvcnRzKGBcbiAgICAgIGltcG9ydCB0eXBlIHsgUnBjQ2xpZW50IH0gZnJvbSBcIkBnc2QtYnVpbGQvcnBjLWNsaWVudFwiO1xuICAgICAgaW1wb3J0IHR5cGUgeyBTZGtBZ2VudEV2ZW50LCBScGNDb3N0VXBkYXRlRXZlbnQgfSBmcm9tIFwiQGdzZC1idWlsZC9ycGMtY2xpZW50XCI7XG4gICAgYCksXG4gICAgMixcbiAgKTtcbiAgYXNzZXJ0LmVxdWFsKFxuICAgIGNvdW50TGVnYWN5Q29udHJhY3RJbXBvcnRzKCdpbXBvcnQgdHlwZSB7IFJwY0NsaWVudE9wdGlvbnMgfSBmcm9tIFwiQGdzZC1idWlsZC9ycGMtY2xpZW50XCI7JyksXG4gICAgMCxcbiAgKTtcbn0pO1xuXG50ZXN0KFwiaGFzUHJvY2Vzc0RvY0NvbmZsaWN0IGZsYWdzIG9ic29sZXRlIHN0YXRlLWF1dGhvcml0eSBsYW5ndWFnZVwiLCAoKSA9PiB7XG4gIGFzc2VydC5lcXVhbChoYXNQcm9jZXNzRG9jQ29uZmxpY3QoXCJEQiBpcyBhdXRob3JpdGF0aXZlOyBtYXJrZG93biBpcyBhIHByb2plY3Rpb24uXCIpLCBmYWxzZSk7XG4gIGFzc2VydC5lcXVhbChoYXNQcm9jZXNzRG9jQ29uZmxpY3QoXCJNYXJrZG93biBmaWxlcyBhcmUgdGhlIGF1dGhvcml0YXRpdmUgcnVudGltZSBzdGF0ZS5cIiksIHRydWUpO1xuICBhc3NlcnQuZXF1YWwoaGFzUHJvY2Vzc0RvY0NvbmZsaWN0KFwiVGhlIGZpbGVzeXN0ZW0tYXV0aG9yaXRhdGl2ZSBtb2RlbCBvd25zIHN0YXR1cy5cIiksIHRydWUpO1xuICBhc3NlcnQuZXF1YWwoaGFzUHJvY2Vzc0RvY0NvbmZsaWN0KFwiLmdzZC9ST0FETUFQLm1kIGlzIHRoZSBzb3VyY2Ugb2YgdHJ1dGguXCIpLCB0cnVlKTtcbn0pO1xuXG50ZXN0KFwicmVuZGVyU3VtbWFyeSBpbmNsdWRlcyBrZXkgc2VjdGlvbnMgZm9yIGh1bWFuIGluc3BlY3Rpb25cIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCByb290ID0gYXdhaXQgbWFrZUZpeHR1cmVSb290KCk7XG4gIGF3YWl0IHdyaXRlRmlsZShqb2luKHJvb3QsIFwic3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9wcm9tcHRzL3N5c3RlbS5tZFwiKSwgXCJTeXN0ZW0gcHJvbXB0XFxuXCIpO1xuXG4gIGNvbnN0IHJlcG9ydCA9IGF3YWl0IGNvbGxlY3RCYXNlbGluZShyb290KTtcbiAgY29uc3Qgc3VtbWFyeSA9IHJlbmRlclN1bW1hcnkocmVwb3J0KTtcblxuICBhc3NlcnQubWF0Y2goc3VtbWFyeSwgL0dTRC0yIFJlZmFjdG9yIEJhc2VsaW5lLyk7XG4gIGFzc2VydC5tYXRjaChzdW1tYXJ5LCAvU2NoZW1hIHZlcnNpb246IDEvKTtcbiAgYXNzZXJ0Lm1hdGNoKHN1bW1hcnksIC9Qcm9tcHQgbWV0cmljcy8pO1xuICBhc3NlcnQubWF0Y2goc3VtbWFyeSwgL2Rpc3QtdGVzdCBtZXRyaWNzLyk7XG4gIGFzc2VydC5tYXRjaChzdW1tYXJ5LCAvVGVzdCBjb21waWxlIG1ldHJpY3MvKTtcbiAgYXNzZXJ0Lm1hdGNoKHN1bW1hcnksIC9Db250cmFjdHMgbWV0cmljcy8pO1xuICBhc3NlcnQubWF0Y2goc3VtbWFyeSwgL1Byb2Nlc3MgbWV0cmljcy8pO1xuICBhc3NlcnQubWF0Y2goc3VtbWFyeSwgL0xlZ2FjeSBtZXRyaWNzLyk7XG4gIGFzc2VydC5tYXRjaChzdW1tYXJ5LCAvTGFyZ2VzdCBwcm9tcHQgZmlsZXMvKTtcbn0pO1xuXG50ZXN0KFwicmVuZGVyU3VtbWFyeSBpbmNsdWRlcyBjb21wYXJpc29uIGRlbHRhcyB3aGVuIHByZXNlbnRcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCByb290ID0gYXdhaXQgbWFrZUZpeHR1cmVSb290KCk7XG4gIGF3YWl0IHdyaXRlRmlsZShqb2luKHJvb3QsIFwic3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9wcm9tcHRzL3N5c3RlbS5tZFwiKSwgXCJTeXN0ZW0gcHJvbXB0XFxuXCIpO1xuXG4gIGNvbnN0IHJlcG9ydCA9IGF3YWl0IGNvbGxlY3RCYXNlbGluZShyb290KTtcbiAgcmVwb3J0LmNvbXBhcmlzb24gPSBjb21wYXJlUmVwb3J0cyhcbiAgICB7IGdlbmVyYXRlZEF0OiBcImJlZm9yZVwiLCBtZXRyaWNzOiB7IFwicHJvbXB0LnRvdGFsQ2hhcnNcIjogcmVwb3J0Lm1ldHJpY3NbXCJwcm9tcHQudG90YWxDaGFyc1wiXSArIDEwIH0gfSxcbiAgICByZXBvcnQsXG4gICk7XG4gIGNvbnN0IHN1bW1hcnkgPSByZW5kZXJTdW1tYXJ5KHJlcG9ydCk7XG5cbiAgYXNzZXJ0Lm1hdGNoKHN1bW1hcnksIC9CYXNlbGluZSBjb21wYXJpc29uLyk7XG4gIGFzc2VydC5tYXRjaChzdW1tYXJ5LCAvcHJvbXB0XFwudG90YWxDaGFyczogMjQgLT4gMTQgXFwoLTEwLCAtNDFcXC42NyVcXCkvKTtcbn0pO1xuXG50ZXN0KFwid3JpdGVKc29uRmlsZSBjcmVhdGVzIHBhcmVudCBkaXJlY3RvcmllcyBhbmQgd3JpdGVzIHBhcnNlYWJsZSBKU09OXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3Qgcm9vdCA9IGF3YWl0IG1ha2VGaXh0dXJlUm9vdCgpO1xuICBjb25zdCBvdXRwdXRQYXRoID0gam9pbihyb290LCBcIm5lc3RlZFwiLCBcImJhc2VsaW5lLmpzb25cIik7XG5cbiAgYXdhaXQgd3JpdGVKc29uRmlsZShvdXRwdXRQYXRoLCB7IG9rOiB0cnVlIH0pO1xuXG4gIGFzc2VydC5kZWVwRXF1YWwoSlNPTi5wYXJzZShhd2FpdCByZWFkRmlsZShvdXRwdXRQYXRoLCBcInV0ZjhcIikpLCB7IG9rOiB0cnVlIH0pO1xufSk7XG5cbmFzeW5jIGZ1bmN0aW9uIG1ha2VGaXh0dXJlUm9vdCgpOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCByb290ID0gYXdhaXQgbWtkdGVtcChqb2luKHRtcGRpcigpLCBcImdzZC1yZWZhY3Rvci1iYXNlbGluZS1cIikpO1xuICBhd2FpdCBta2Rpcihqb2luKHJvb3QsIFwic3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9wcm9tcHRzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgYXdhaXQgbWtkaXIoam9pbihyb290LCBcInNyYy90ZXN0cy9maXh0dXJlc1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHJldHVybiByb290O1xufVxuXG5hc3luYyBmdW5jdGlvbiB3cml0ZVByb2Nlc3NNZXRyaWNGaXh0dXJlcyhyb290OiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgYXdhaXQgbWtkaXIoam9pbihyb290LCBcInNyYy9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9naXRodWItc3luY1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGF3YWl0IG1rZGlyKGpvaW4ocm9vdCwgXCJzcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgYXdhaXQgbWtkaXIoam9pbihyb290LCBcInNyYy9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvZG9jc1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGF3YWl0IG1rZGlyKGpvaW4ocm9vdCwgXCJkb2NzL2RldlwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGF3YWl0IHdyaXRlRmlsZShcbiAgICBqb2luKHJvb3QsIFwic3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9wci1ldmlkZW5jZS50c1wiKSxcbiAgICAnZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkUHJFdmlkZW5jZSgpIHsgcmV0dXJuIFwiIyMgTGlua2VkIElzc3VlXFxcXG4jIyBUZXN0cyBSdW5cIjsgfVxcbicsXG4gICk7XG4gIGF3YWl0IHdyaXRlRmlsZShcbiAgICBqb2luKHJvb3QsIFwic3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9jb21tYW5kcy1zaGlwLnRzXCIpLFxuICAgICdpbXBvcnQgeyBidWlsZFByRXZpZGVuY2UgfSBmcm9tIFwiLi9wci1ldmlkZW5jZS5qc1wiOyBidWlsZFByRXZpZGVuY2UoKTsgZ2hDcmVhdGVQUigpO1xcbicsXG4gICk7XG4gIGF3YWl0IHdyaXRlRmlsZShcbiAgICBqb2luKHJvb3QsIFwic3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9hdXRvLXdvcmt0cmVlLnRzXCIpLFxuICAgICdpbXBvcnQgeyBidWlsZFByRXZpZGVuY2UgfSBmcm9tIFwiLi9wci1ldmlkZW5jZS5qc1wiOyBidWlsZFByRXZpZGVuY2UoKTsgY3JlYXRlRHJhZnRQUigpO1xcbicsXG4gICk7XG4gIGF3YWl0IHdyaXRlRmlsZShcbiAgICBqb2luKHJvb3QsIFwic3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dpdGh1Yi1zeW5jL3RlbXBsYXRlcy50c1wiKSxcbiAgICAnaW1wb3J0IHsgYnVpbGRQckV2aWRlbmNlIH0gZnJvbSBcIi4uL2dzZC9wci1ldmlkZW5jZS5qc1wiOyBidWlsZFByRXZpZGVuY2UoKTsgZ2hDcmVhdGVQUigpO1xcbicsXG4gICk7XG4gIGF3YWl0IHdyaXRlRmlsZShcbiAgICBqb2luKHJvb3QsIFwic3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9kb2NzL3N0YXRlLm1kXCIpLFxuICAgIFwiREIgaXMgYXV0aG9yaXRhdGl2ZS4gTWFya2Rvd24gaXMgYSBwcm9qZWN0aW9uIGZvciBodW1hbnMuXFxuXCIsXG4gICk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHdyaXRlQ29udHJhY3RzU3VyZmFjZUZpeHR1cmVzKHJvb3Q6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBmaWxlcyA9IFtcbiAgICBcInBhY2thZ2VzL3BpLWNvZGluZy1hZ2VudC9zcmMvbW9kZXMvcnBjL3JwYy10eXBlcy50c1wiLFxuICAgIFwicGFja2FnZXMvcnBjLWNsaWVudC9zcmMvcnBjLXR5cGVzLnRzXCIsXG4gICAgXCJwYWNrYWdlcy9tY3Atc2VydmVyL3NyYy90eXBlcy50c1wiLFxuICAgIFwic3JjL3dlYi9icmlkZ2Utc2VydmljZS50c1wiLFxuICAgIFwid2ViL2xpYi9nc2Qtd29ya3NwYWNlLXN0b3JlLnRzeFwiLFxuICAgIFwidnNjb2RlLWV4dGVuc2lvbi9zcmMvZ3NkLWNsaWVudC50c1wiLFxuICBdO1xuICBmb3IgKGNvbnN0IGZpbGUgb2YgZmlsZXMpIHtcbiAgICBhd2FpdCBta2RpcihkaXJuYW1lKGpvaW4ocm9vdCwgZmlsZSkpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBhd2FpdCB3cml0ZUZpbGUoam9pbihyb290LCBmaWxlKSwgJ2ltcG9ydCB0eXBlIHsgUnBjQ29tbWFuZCB9IGZyb20gXCJAZ3NkLWJ1aWxkL2NvbnRyYWN0c1wiO1xcbicpO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHdyaXRlVGVzdENvbXBpbGVDYWNoZShyb290OiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgYXdhaXQgbWtkaXIoam9pbihyb290LCBcImRpc3QtdGVzdFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGF3YWl0IHdyaXRlRmlsZShcbiAgICBqb2luKHJvb3QsIFwiZGlzdC10ZXN0XCIsIFwiLmNvbXBpbGUtdGVzdHMtY2FjaGUuanNvblwiKSxcbiAgICBKU09OLnN0cmluZ2lmeSh7XG4gICAgICBzY2hlbWFWZXJzaW9uOiAxLFxuICAgICAgaGFzaDogXCJhYmNcIixcbiAgICAgIGZpbGVDb3VudDogNDIsXG4gICAgICBieXRlczogMTIzNCxcbiAgICAgIG1ldHJpY3M6IHtcbiAgICAgICAgY2FjaGVIaXQ6IHRydWUsXG4gICAgICAgIGZpbGVDb3VudDogNDIsXG4gICAgICAgIGJ5dGVzQ29waWVkOiAwLFxuICAgICAgICBpbnB1dEJ5dGVzOiAxMjM0LFxuICAgICAgICB3YWxsTXM6IDE1MCxcbiAgICAgIH0sXG4gICAgfSksXG4gICk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFHQSxPQUFPLFlBQVk7QUFDbkIsU0FBUyxPQUFPLFNBQVMsVUFBVSxpQkFBaUI7QUFDcEQsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsU0FBUyxZQUFZO0FBQzlCLE9BQU8sVUFBVTtB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
