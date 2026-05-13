import { describe, test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runPostUnitVerification } from "../auto-verification.js";
import { AutoSession } from "../auto/session.js";
import { openDatabase, closeDatabase, insertMilestone, insertSlice, insertTask, _getAdapter } from "../gsd-db.js";
import { invalidateAllCaches } from "../cache.js";
import { _clearGsdRootCache } from "../paths.js";
let tempDir;
let dbPath;
let originalCwd;
function makeMockCtx() {
  return {
    ui: {
      notify: mock.fn(),
      setStatus: () => {
      },
      setWidget: () => {
      },
      setFooter: () => {
      }
    },
    model: { id: "test-model" }
  };
}
function makeMockPi() {
  return {
    sendMessage: mock.fn(),
    setModel: mock.fn(async () => true)
  };
}
function makeMockSession(basePath, currentUnit) {
  const s = new AutoSession();
  s.basePath = basePath;
  s.active = true;
  s.pendingVerificationRetry = null;
  if (currentUnit) {
    s.currentUnit = {
      type: currentUnit.type,
      id: currentUnit.id,
      startedAt: Date.now()
    };
  }
  return s;
}
function setupTestEnvironment() {
  originalCwd = process.cwd();
  tempDir = join(tmpdir(), `post-exec-retry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  const gsdDir = join(tempDir, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  const milestonesDir = join(gsdDir, "milestones", "M001", "slices", "S01", "tasks");
  mkdirSync(milestonesDir, { recursive: true });
  process.chdir(tempDir);
  invalidateAllCaches();
  _clearGsdRootCache();
  dbPath = join(gsdDir, "gsd.db");
  openDatabase(dbPath);
}
function cleanupTestEnvironment() {
  try {
    process.chdir(originalCwd);
  } catch {
  }
  try {
    closeDatabase();
  } catch {
  }
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
  }
}
function writePreferences(prefs) {
  const yamlLines = Object.entries(prefs).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  const prefsContent = `---
${yamlLines.join("\n")}
---

# GSD Preferences
`;
  writeFileSync(join(tempDir, ".gsd", "PREFERENCES.md"), prefsContent);
  invalidateAllCaches();
  _clearGsdRootCache();
}
function createBasicTask() {
  insertMilestone({ id: "M001" });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Test Slice",
    risk: "low"
  });
  insertTask({
    id: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    title: "Basic task",
    status: "pending",
    planning: {
      description: "A basic task for testing",
      estimate: "1h",
      files: [],
      verify: "echo pass",
      // Simple verification that always passes
      inputs: [],
      expectedOutput: ["output.ts"],
      observabilityImpact: ""
    },
    sequence: 0
  });
}
function createTaskWithoutVerify() {
  insertMilestone({ id: "M001" });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Test Slice",
    risk: "low"
  });
  insertTask({
    id: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    title: "Task without host verification",
    status: "pending",
    planning: {
      description: "Task intentionally missing runnable verification",
      estimate: "1h",
      files: [],
      verify: "",
      inputs: [],
      expectedOutput: [],
      observabilityImpact: ""
    },
    sequence: 0
  });
}
function createPostExecFailureTask() {
  insertMilestone({ id: "M001" });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Test Slice",
    risk: "low"
  });
  const srcDir = join(tempDir, "src");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(
    join(srcDir, "broken.ts"),
    "import { missing } from './does-not-exist.js';\nexport const ok = 1;\n",
    "utf-8"
  );
  insertTask({
    id: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    title: "Task with broken import",
    status: "pending",
    keyFiles: ["src/broken.ts"],
    planning: {
      description: "Task that introduces an unresolved import in key files",
      estimate: "1h",
      files: ["src/broken.ts"],
      verify: "echo pass",
      inputs: [],
      expectedOutput: [],
      observabilityImpact: ""
    },
    sequence: 0
  });
}
describe("Post-execution blocking failure retry bypass", () => {
  beforeEach(() => {
    setupTestEnvironment();
  });
  afterEach(() => {
    cleanupTestEnvironment();
  });
  test("skips verification when unit type is not execute-task", async () => {
    createBasicTask();
    writePreferences({
      enhanced_verification: true,
      enhanced_verification_post: true,
      verification_auto_fix: true,
      verification_max_retries: 3
    });
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {
    });
    const s = makeMockSession(tempDir, { type: "plan-slice", id: "M001/S01" });
    const vctx = { s, ctx, pi };
    const result = await runPostUnitVerification(vctx, pauseAutoMock);
    assert.equal(result, "continue");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
  });
  test("returns continue when verification passes", async () => {
    createBasicTask();
    writePreferences({
      enhanced_verification: true,
      enhanced_verification_post: true,
      verification_auto_fix: true,
      verification_max_retries: 3
    });
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {
    });
    const s = makeMockSession(tempDir, { type: "execute-task", id: "M001/S01/T01" });
    const vctx = { s, ctx, pi };
    const result = await runPostUnitVerification(vctx, pauseAutoMock);
    assert.equal(result, "continue");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
    assert.equal(s.pendingVerificationRetry, null);
  });
  test("verification retry count is cleared on success", async () => {
    createBasicTask();
    writePreferences({
      enhanced_verification: true,
      enhanced_verification_post: true,
      verification_auto_fix: true,
      verification_max_retries: 3
    });
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {
    });
    const s = makeMockSession(tempDir, { type: "execute-task", id: "M001/S01/T01" });
    s.verificationRetryCount.set("execute-task:M001/S01/T01", 2);
    const vctx = { s, ctx, pi };
    const result = await runPostUnitVerification(vctx, pauseAutoMock);
    assert.equal(result, "continue");
    assert.equal(s.verificationRetryCount.has("execute-task:M001/S01/T01"), false);
  });
  test("post-exec failure notification mentions cross-task consistency", async () => {
    createBasicTask();
    writePreferences({
      enhanced_verification: true,
      enhanced_verification_post: true,
      verification_auto_fix: true,
      verification_max_retries: 3
    });
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {
    });
    const s = makeMockSession(tempDir, { type: "execute-task", id: "M001/S01/T01" });
    const vctx = { s, ctx, pi };
    const result = await runPostUnitVerification(vctx, pauseAutoMock);
    assert.equal(result, "continue");
  });
  test("uok gate runner persists post-execution gate failures when enabled", async () => {
    createPostExecFailureTask();
    writePreferences({
      enhanced_verification: true,
      enhanced_verification_post: true,
      verification_auto_fix: true,
      verification_max_retries: 2,
      uok: {
        enabled: true,
        gates: { enabled: true }
      }
    });
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {
    });
    const s = makeMockSession(tempDir, { type: "execute-task", id: "M001/S01/T01" });
    const vctx = { s, ctx, pi };
    const result = await runPostUnitVerification(vctx, pauseAutoMock);
    assert.equal(result, "pause");
    assert.equal(pauseAutoMock.mock.callCount(), 1);
    const adapter = _getAdapter();
    const row = adapter?.prepare(
      `SELECT gate_id, outcome, failure_class
         FROM gate_runs
         WHERE gate_id = 'post-execution-checks'
         ORDER BY id DESC
         LIMIT 1`
    ).get();
    assert.ok(row, "post-execution gate run should be persisted when uok.gates is enabled");
    assert.equal(row?.gate_id, "post-execution-checks");
    assert.equal(row?.outcome, "fail");
    assert.equal(row?.failure_class, "artifact");
  });
  test("execute-task with no host-owned verification pauses fail-closed", async () => {
    createTaskWithoutVerify();
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {
    });
    const s = makeMockSession(tempDir, { type: "execute-task", id: "M001/S01/T01" });
    const result = await runPostUnitVerification({ s, ctx, pi }, pauseAutoMock);
    assert.equal(result, "pause");
    assert.equal(pauseAutoMock.mock.callCount(), 1);
    assert.equal(s.pendingVerificationRetry, null);
    const evidencePath = join(tempDir, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-VERIFY.json");
    const evidence = JSON.parse(readFileSync(evidencePath, "utf-8"));
    assert.equal(evidence.passed, false);
    assert.equal(evidence.discoverySource, "none");
    assert.ok(!("retryAttempt" in evidence), "no-host-checks evidence must not include retryAttempt");
    assert.ok(!("maxRetries" in evidence), "no-host-checks evidence must not include maxRetries");
  });
  test("auto-discovered package.json verification failure retries instead of continuing", async () => {
    createTaskWithoutVerify();
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({ scripts: { test: "exit 1" } }),
      "utf-8"
    );
    writePreferences({
      verification_auto_fix: true,
      verification_max_retries: 2
    });
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {
    });
    const s = makeMockSession(tempDir, { type: "execute-task", id: "M001/S01/T01" });
    const result = await runPostUnitVerification({ s, ctx, pi }, pauseAutoMock);
    assert.equal(result, "retry");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
    assert.equal(s.pendingVerificationRetry?.unitId, "M001/S01/T01");
    assert.match(s.pendingVerificationRetry?.failureContext ?? "", /npm run test/);
  });
});
describe("Post-execution retry behavior", () => {
  beforeEach(() => {
    setupTestEnvironment();
  });
  afterEach(() => {
    cleanupTestEnvironment();
  });
  test("when autofix is disabled, failure pauses immediately without retry", async () => {
    insertMilestone({ id: "M001" });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      title: "Test Slice",
      risk: "low"
    });
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Failing task",
      status: "pending",
      planning: {
        description: "Task with failing verification",
        estimate: "1h",
        files: [],
        verify: "exit 1",
        // This will fail
        inputs: [],
        expectedOutput: [],
        observabilityImpact: ""
      },
      sequence: 0
    });
    writePreferences({
      enhanced_verification: true,
      enhanced_verification_post: true,
      verification_auto_fix: false,
      // Autofix disabled
      verification_max_retries: 3
    });
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {
    });
    const s = makeMockSession(tempDir, { type: "execute-task", id: "M001/S01/T01" });
    const vctx = { s, ctx, pi };
    const result = await runPostUnitVerification(vctx, pauseAutoMock);
    assert.equal(result, "pause");
    assert.equal(pauseAutoMock.mock.callCount(), 1);
    assert.equal(s.pendingVerificationRetry, null);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wb3N0LWV4ZWMtcmV0cnktYnlwYXNzLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFByb2plY3QvQXBwOiBHU0QtMlxuLy8gRmlsZSBQdXJwb3NlOiBUZXN0cyBmb3IgcG9zdC1leGVjdXRpb24gcmV0cnkgYnlwYXNzIGFuZCB2ZXJpZmljYXRpb24gZ2F0ZSBmYWlsdXJlIGhhbmRsaW5nLlxuLyoqXG4gKiBwb3N0LWV4ZWMtcmV0cnktYnlwYXNzLnRlc3QudHMgXHUyMDE0IFRlc3RzIGZvciBwb3N0LWV4ZWN1dGlvbiBibG9ja2luZyBmYWlsdXJlIHJldHJ5IGJ5cGFzcy5cbiAqXG4gKiBWZXJpZmllcyB0aGF0IHdoZW4gcG9zdC1leGVjdXRpb24gY2hlY2tzIGZhaWwgKHBvc3RFeGVjQmxvY2tpbmdGYWlsdXJlIGlzIHRydWUpLFxuICogdGhlIHJldHJ5IHN5c3RlbSBpcyBieXBhc3NlZCBhbmQgYXV0by1tb2RlIHBhdXNlcyBpbW1lZGlhdGVseS4gUG9zdC1leGVjdXRpb25cbiAqIGZhaWx1cmVzIGFyZSBjcm9zcy10YXNrIGNvbnNpc3RlbmN5IGlzc3VlcyBcdTIwMTQgcmV0cnlpbmcgdGhlIHNhbWUgdGFzayB3b24ndCBmaXggdGhlbS5cbiAqL1xuXG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCwgbW9jaywgYmVmb3JlRWFjaCwgYWZ0ZXJFYWNoIH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgbWtkaXJTeW5jLCByZWFkRmlsZVN5bmMsIHdyaXRlRmlsZVN5bmMsIHJtU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuXG5pbXBvcnQgeyBydW5Qb3N0VW5pdFZlcmlmaWNhdGlvbiwgdHlwZSBWZXJpZmljYXRpb25Db250ZXh0IH0gZnJvbSBcIi4uL2F1dG8tdmVyaWZpY2F0aW9uLnRzXCI7XG5pbXBvcnQgeyBBdXRvU2Vzc2lvbiB9IGZyb20gXCIuLi9hdXRvL3Nlc3Npb24udHNcIjtcbmltcG9ydCB7IG9wZW5EYXRhYmFzZSwgY2xvc2VEYXRhYmFzZSwgaW5zZXJ0TWlsZXN0b25lLCBpbnNlcnRTbGljZSwgaW5zZXJ0VGFzaywgX2dldEFkYXB0ZXIgfSBmcm9tIFwiLi4vZ3NkLWRiLnRzXCI7XG5pbXBvcnQgeyBpbnZhbGlkYXRlQWxsQ2FjaGVzIH0gZnJvbSBcIi4uL2NhY2hlLnRzXCI7XG5pbXBvcnQgeyBfY2xlYXJHc2RSb290Q2FjaGUgfSBmcm9tIFwiLi4vcGF0aHMudHNcIjtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRlc3QgRml4dHVyZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmxldCB0ZW1wRGlyOiBzdHJpbmc7XG5sZXQgZGJQYXRoOiBzdHJpbmc7XG5sZXQgb3JpZ2luYWxDd2Q6IHN0cmluZztcblxuZnVuY3Rpb24gbWFrZU1vY2tDdHgoKSB7XG4gIHJldHVybiB7XG4gICAgdWk6IHtcbiAgICAgIG5vdGlmeTogbW9jay5mbigpLFxuICAgICAgc2V0U3RhdHVzOiAoKSA9PiB7fSxcbiAgICAgIHNldFdpZGdldDogKCkgPT4ge30sXG4gICAgICBzZXRGb290ZXI6ICgpID0+IHt9LFxuICAgIH0sXG4gICAgbW9kZWw6IHsgaWQ6IFwidGVzdC1tb2RlbFwiIH0sXG4gIH0gYXMgYW55O1xufVxuXG5mdW5jdGlvbiBtYWtlTW9ja1BpKCkge1xuICByZXR1cm4ge1xuICAgIHNlbmRNZXNzYWdlOiBtb2NrLmZuKCksXG4gICAgc2V0TW9kZWw6IG1vY2suZm4oYXN5bmMgKCkgPT4gdHJ1ZSksXG4gIH0gYXMgYW55O1xufVxuXG5mdW5jdGlvbiBtYWtlTW9ja1Nlc3Npb24oYmFzZVBhdGg6IHN0cmluZywgY3VycmVudFVuaXQ/OiB7IHR5cGU6IHN0cmluZzsgaWQ6IHN0cmluZyB9KTogQXV0b1Nlc3Npb24ge1xuICBjb25zdCBzID0gbmV3IEF1dG9TZXNzaW9uKCk7XG4gIHMuYmFzZVBhdGggPSBiYXNlUGF0aDtcbiAgcy5hY3RpdmUgPSB0cnVlO1xuICAvLyB2ZXJpZmljYXRpb25SZXRyeUNvdW50IGlzIHJlYWRvbmx5IGJ1dCBpbml0aWFsaXplZCBhcyBhbiBlbXB0eSBNYXAgaW4gQXV0b1Nlc3Npb25cbiAgcy5wZW5kaW5nVmVyaWZpY2F0aW9uUmV0cnkgPSBudWxsO1xuICBpZiAoY3VycmVudFVuaXQpIHtcbiAgICBzLmN1cnJlbnRVbml0ID0ge1xuICAgICAgdHlwZTogY3VycmVudFVuaXQudHlwZSxcbiAgICAgIGlkOiBjdXJyZW50VW5pdC5pZCxcbiAgICAgIHN0YXJ0ZWRBdDogRGF0ZS5ub3coKSxcbiAgICB9O1xuICB9XG4gIHJldHVybiBzO1xufVxuXG5mdW5jdGlvbiBzZXR1cFRlc3RFbnZpcm9ubWVudCgpOiB2b2lkIHtcbiAgb3JpZ2luYWxDd2QgPSBwcm9jZXNzLmN3ZCgpO1xuICB0ZW1wRGlyID0gam9pbih0bXBkaXIoKSwgYHBvc3QtZXhlYy1yZXRyeS10ZXN0LSR7RGF0ZS5ub3coKX0tJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyKX1gKTtcbiAgbWtkaXJTeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gIGNvbnN0IGdzZERpciA9IGpvaW4odGVtcERpciwgXCIuZ3NkXCIpO1xuICBta2RpclN5bmMoZ3NkRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICBjb25zdCBtaWxlc3RvbmVzRGlyID0gam9pbihnc2REaXIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIiwgXCJ0YXNrc1wiKTtcbiAgbWtkaXJTeW5jKG1pbGVzdG9uZXNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gIHByb2Nlc3MuY2hkaXIodGVtcERpcik7XG4gIGludmFsaWRhdGVBbGxDYWNoZXMoKTtcbiAgX2NsZWFyR3NkUm9vdENhY2hlKCk7XG5cbiAgZGJQYXRoID0gam9pbihnc2REaXIsIFwiZ3NkLmRiXCIpO1xuICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcbn1cblxuZnVuY3Rpb24gY2xlYW51cFRlc3RFbnZpcm9ubWVudCgpOiB2b2lkIHtcbiAgdHJ5IHtcbiAgICBwcm9jZXNzLmNoZGlyKG9yaWdpbmFsQ3dkKTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gSWdub3JlXG4gIH1cbiAgdHJ5IHtcbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gIH0gY2F0Y2gge1xuICAgIC8vIElnbm9yZVxuICB9XG4gIHRyeSB7XG4gICAgcm1TeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gSWdub3JlXG4gIH1cbn1cblxuZnVuY3Rpb24gd3JpdGVQcmVmZXJlbmNlcyhwcmVmczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiB2b2lkIHtcbiAgY29uc3QgeWFtbExpbmVzID0gT2JqZWN0LmVudHJpZXMocHJlZnMpLm1hcCgoW2ssIHZdKSA9PiBgJHtrfTogJHtKU09OLnN0cmluZ2lmeSh2KX1gKTtcbiAgY29uc3QgcHJlZnNDb250ZW50ID0gYC0tLVxuJHt5YW1sTGluZXMuam9pbihcIlxcblwiKX1cbi0tLVxuXG4jIEdTRCBQcmVmZXJlbmNlc1xuYDtcbiAgd3JpdGVGaWxlU3luYyhqb2luKHRlbXBEaXIsIFwiLmdzZFwiLCBcIlBSRUZFUkVOQ0VTLm1kXCIpLCBwcmVmc0NvbnRlbnQpO1xuICBpbnZhbGlkYXRlQWxsQ2FjaGVzKCk7XG4gIF9jbGVhckdzZFJvb3RDYWNoZSgpO1xufVxuXG4vKipcbiAqIENyZWF0ZSBhIHRhc2sgaW4gREIgdGhhdCB3aWxsIHBhc3MgYmFzaWMgdmVyaWZpY2F0aW9uIGJ1dCBhbGxvd3MgdXMgdG8gdGVzdCB0aGUgZmxvdy5cbiAqL1xuZnVuY3Rpb24gY3JlYXRlQmFzaWNUYXNrKCk6IHZvaWQge1xuICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIgfSk7XG4gIGluc2VydFNsaWNlKHtcbiAgICBpZDogXCJTMDFcIixcbiAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgdGl0bGU6IFwiVGVzdCBTbGljZVwiLFxuICAgIHJpc2s6IFwibG93XCIsXG4gIH0pO1xuXG4gIC8vIENyZWF0ZSBhIHNpbXBsZSB0YXNrXG4gIGluc2VydFRhc2soe1xuICAgIGlkOiBcIlQwMVwiLFxuICAgIHNsaWNlSWQ6IFwiUzAxXCIsXG4gICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgIHRpdGxlOiBcIkJhc2ljIHRhc2tcIixcbiAgICBzdGF0dXM6IFwicGVuZGluZ1wiLFxuICAgIHBsYW5uaW5nOiB7XG4gICAgICBkZXNjcmlwdGlvbjogXCJBIGJhc2ljIHRhc2sgZm9yIHRlc3RpbmdcIixcbiAgICAgIGVzdGltYXRlOiBcIjFoXCIsXG4gICAgICBmaWxlczogW10sXG4gICAgICB2ZXJpZnk6IFwiZWNobyBwYXNzXCIsIC8vIFNpbXBsZSB2ZXJpZmljYXRpb24gdGhhdCBhbHdheXMgcGFzc2VzXG4gICAgICBpbnB1dHM6IFtdLFxuICAgICAgZXhwZWN0ZWRPdXRwdXQ6IFtcIm91dHB1dC50c1wiXSxcbiAgICAgIG9ic2VydmFiaWxpdHlJbXBhY3Q6IFwiXCIsXG4gICAgfSxcbiAgICBzZXF1ZW5jZTogMCxcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZVRhc2tXaXRob3V0VmVyaWZ5KCk6IHZvaWQge1xuICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIgfSk7XG4gIGluc2VydFNsaWNlKHtcbiAgICBpZDogXCJTMDFcIixcbiAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgdGl0bGU6IFwiVGVzdCBTbGljZVwiLFxuICAgIHJpc2s6IFwibG93XCIsXG4gIH0pO1xuXG4gIGluc2VydFRhc2soe1xuICAgIGlkOiBcIlQwMVwiLFxuICAgIHNsaWNlSWQ6IFwiUzAxXCIsXG4gICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgIHRpdGxlOiBcIlRhc2sgd2l0aG91dCBob3N0IHZlcmlmaWNhdGlvblwiLFxuICAgIHN0YXR1czogXCJwZW5kaW5nXCIsXG4gICAgcGxhbm5pbmc6IHtcbiAgICAgIGRlc2NyaXB0aW9uOiBcIlRhc2sgaW50ZW50aW9uYWxseSBtaXNzaW5nIHJ1bm5hYmxlIHZlcmlmaWNhdGlvblwiLFxuICAgICAgZXN0aW1hdGU6IFwiMWhcIixcbiAgICAgIGZpbGVzOiBbXSxcbiAgICAgIHZlcmlmeTogXCJcIixcbiAgICAgIGlucHV0czogW10sXG4gICAgICBleHBlY3RlZE91dHB1dDogW10sXG4gICAgICBvYnNlcnZhYmlsaXR5SW1wYWN0OiBcIlwiLFxuICAgIH0sXG4gICAgc2VxdWVuY2U6IDAsXG4gIH0pO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVQb3N0RXhlY0ZhaWx1cmVUYXNrKCk6IHZvaWQge1xuICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIgfSk7XG4gIGluc2VydFNsaWNlKHtcbiAgICBpZDogXCJTMDFcIixcbiAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgdGl0bGU6IFwiVGVzdCBTbGljZVwiLFxuICAgIHJpc2s6IFwibG93XCIsXG4gIH0pO1xuXG4gIGNvbnN0IHNyY0RpciA9IGpvaW4odGVtcERpciwgXCJzcmNcIik7XG4gIG1rZGlyU3luYyhzcmNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4oc3JjRGlyLCBcImJyb2tlbi50c1wiKSxcbiAgICBcImltcG9ydCB7IG1pc3NpbmcgfSBmcm9tICcuL2RvZXMtbm90LWV4aXN0LmpzJztcXG5leHBvcnQgY29uc3Qgb2sgPSAxO1xcblwiLFxuICAgIFwidXRmLThcIixcbiAgKTtcblxuICBpbnNlcnRUYXNrKHtcbiAgICBpZDogXCJUMDFcIixcbiAgICBzbGljZUlkOiBcIlMwMVwiLFxuICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICB0aXRsZTogXCJUYXNrIHdpdGggYnJva2VuIGltcG9ydFwiLFxuICAgIHN0YXR1czogXCJwZW5kaW5nXCIsXG4gICAga2V5RmlsZXM6IFtcInNyYy9icm9rZW4udHNcIl0sXG4gICAgcGxhbm5pbmc6IHtcbiAgICAgIGRlc2NyaXB0aW9uOiBcIlRhc2sgdGhhdCBpbnRyb2R1Y2VzIGFuIHVucmVzb2x2ZWQgaW1wb3J0IGluIGtleSBmaWxlc1wiLFxuICAgICAgZXN0aW1hdGU6IFwiMWhcIixcbiAgICAgIGZpbGVzOiBbXCJzcmMvYnJva2VuLnRzXCJdLFxuICAgICAgdmVyaWZ5OiBcImVjaG8gcGFzc1wiLFxuICAgICAgaW5wdXRzOiBbXSxcbiAgICAgIGV4cGVjdGVkT3V0cHV0OiBbXSxcbiAgICAgIG9ic2VydmFiaWxpdHlJbXBhY3Q6IFwiXCIsXG4gICAgfSxcbiAgICBzZXF1ZW5jZTogMCxcbiAgfSk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJQb3N0LWV4ZWN1dGlvbiBibG9ja2luZyBmYWlsdXJlIHJldHJ5IGJ5cGFzc1wiLCAoKSA9PiB7XG4gIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgIHNldHVwVGVzdEVudmlyb25tZW50KCk7XG4gIH0pO1xuXG4gIGFmdGVyRWFjaCgoKSA9PiB7XG4gICAgY2xlYW51cFRlc3RFbnZpcm9ubWVudCgpO1xuICB9KTtcblxuICB0ZXN0KFwic2tpcHMgdmVyaWZpY2F0aW9uIHdoZW4gdW5pdCB0eXBlIGlzIG5vdCBleGVjdXRlLXRhc2tcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNyZWF0ZUJhc2ljVGFzaygpO1xuICAgIHdyaXRlUHJlZmVyZW5jZXMoe1xuICAgICAgZW5oYW5jZWRfdmVyaWZpY2F0aW9uOiB0cnVlLFxuICAgICAgZW5oYW5jZWRfdmVyaWZpY2F0aW9uX3Bvc3Q6IHRydWUsXG4gICAgICB2ZXJpZmljYXRpb25fYXV0b19maXg6IHRydWUsXG4gICAgICB2ZXJpZmljYXRpb25fbWF4X3JldHJpZXM6IDMsXG4gICAgfSk7XG5cbiAgICBjb25zdCBjdHggPSBtYWtlTW9ja0N0eCgpO1xuICAgIGNvbnN0IHBpID0gbWFrZU1vY2tQaSgpO1xuICAgIGNvbnN0IHBhdXNlQXV0b01vY2sgPSBtb2NrLmZuKGFzeW5jICgpID0+IHt9KTtcbiAgICBjb25zdCBzID0gbWFrZU1vY2tTZXNzaW9uKHRlbXBEaXIsIHsgdHlwZTogXCJwbGFuLXNsaWNlXCIsIGlkOiBcIk0wMDEvUzAxXCIgfSk7XG5cbiAgICBjb25zdCB2Y3R4OiBWZXJpZmljYXRpb25Db250ZXh0ID0geyBzLCBjdHgsIHBpIH07XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuUG9zdFVuaXRWZXJpZmljYXRpb24odmN0eCwgcGF1c2VBdXRvTW9jayk7XG5cbiAgICAvLyBOb24tZXhlY3V0ZS10YXNrIHVuaXRzIHNob3VsZCByZXR1cm4gXCJjb250aW51ZVwiIGltbWVkaWF0ZWx5XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgXCJjb250aW51ZVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocGF1c2VBdXRvTW9jay5tb2NrLmNhbGxDb3VudCgpLCAwKTtcbiAgfSk7XG5cbiAgdGVzdChcInJldHVybnMgY29udGludWUgd2hlbiB2ZXJpZmljYXRpb24gcGFzc2VzXCIsIGFzeW5jICgpID0+IHtcbiAgICBjcmVhdGVCYXNpY1Rhc2soKTtcbiAgICB3cml0ZVByZWZlcmVuY2VzKHtcbiAgICAgIGVuaGFuY2VkX3ZlcmlmaWNhdGlvbjogdHJ1ZSxcbiAgICAgIGVuaGFuY2VkX3ZlcmlmaWNhdGlvbl9wb3N0OiB0cnVlLFxuICAgICAgdmVyaWZpY2F0aW9uX2F1dG9fZml4OiB0cnVlLFxuICAgICAgdmVyaWZpY2F0aW9uX21heF9yZXRyaWVzOiAzLFxuICAgIH0pO1xuXG4gICAgY29uc3QgY3R4ID0gbWFrZU1vY2tDdHgoKTtcbiAgICBjb25zdCBwaSA9IG1ha2VNb2NrUGkoKTtcbiAgICBjb25zdCBwYXVzZUF1dG9Nb2NrID0gbW9jay5mbihhc3luYyAoKSA9PiB7fSk7XG4gICAgY29uc3QgcyA9IG1ha2VNb2NrU2Vzc2lvbih0ZW1wRGlyLCB7IHR5cGU6IFwiZXhlY3V0ZS10YXNrXCIsIGlkOiBcIk0wMDEvUzAxL1QwMVwiIH0pO1xuXG4gICAgY29uc3QgdmN0eDogVmVyaWZpY2F0aW9uQ29udGV4dCA9IHsgcywgY3R4LCBwaSB9O1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1blBvc3RVbml0VmVyaWZpY2F0aW9uKHZjdHgsIHBhdXNlQXV0b01vY2spO1xuXG4gICAgLy8gV2hlbiB2ZXJpZmljYXRpb24gcGFzc2VzLCBzaG91bGQgcmV0dXJuIFwiY29udGludWVcIiBhbmQgbm90IGNhbGwgcGF1c2VBdXRvXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgXCJjb250aW51ZVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocGF1c2VBdXRvTW9jay5tb2NrLmNhbGxDb3VudCgpLCAwKTtcbiAgICBcbiAgICAvLyBSZXRyeSBzdGF0ZSBzaG91bGQgYmUgY2xlYXJlZFxuICAgIGFzc2VydC5lcXVhbChzLnBlbmRpbmdWZXJpZmljYXRpb25SZXRyeSwgbnVsbCk7XG4gIH0pO1xuXG4gIHRlc3QoXCJ2ZXJpZmljYXRpb24gcmV0cnkgY291bnQgaXMgY2xlYXJlZCBvbiBzdWNjZXNzXCIsIGFzeW5jICgpID0+IHtcbiAgICBjcmVhdGVCYXNpY1Rhc2soKTtcbiAgICB3cml0ZVByZWZlcmVuY2VzKHtcbiAgICAgIGVuaGFuY2VkX3ZlcmlmaWNhdGlvbjogdHJ1ZSxcbiAgICAgIGVuaGFuY2VkX3ZlcmlmaWNhdGlvbl9wb3N0OiB0cnVlLFxuICAgICAgdmVyaWZpY2F0aW9uX2F1dG9fZml4OiB0cnVlLFxuICAgICAgdmVyaWZpY2F0aW9uX21heF9yZXRyaWVzOiAzLFxuICAgIH0pO1xuXG4gICAgY29uc3QgY3R4ID0gbWFrZU1vY2tDdHgoKTtcbiAgICBjb25zdCBwaSA9IG1ha2VNb2NrUGkoKTtcbiAgICBjb25zdCBwYXVzZUF1dG9Nb2NrID0gbW9jay5mbihhc3luYyAoKSA9PiB7fSk7XG4gICAgY29uc3QgcyA9IG1ha2VNb2NrU2Vzc2lvbih0ZW1wRGlyLCB7IHR5cGU6IFwiZXhlY3V0ZS10YXNrXCIsIGlkOiBcIk0wMDEvUzAxL1QwMVwiIH0pO1xuICAgIFxuICAgIC8vIFByZS1zZXQgc29tZSByZXRyeSBzdGF0ZVxuICAgIHMudmVyaWZpY2F0aW9uUmV0cnlDb3VudC5zZXQoXCJleGVjdXRlLXRhc2s6TTAwMS9TMDEvVDAxXCIsIDIpO1xuXG4gICAgY29uc3QgdmN0eDogVmVyaWZpY2F0aW9uQ29udGV4dCA9IHsgcywgY3R4LCBwaSB9O1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1blBvc3RVbml0VmVyaWZpY2F0aW9uKHZjdHgsIHBhdXNlQXV0b01vY2spO1xuXG4gICAgLy8gT24gc3VjY2VzcywgcmV0cnkgY291bnQgc2hvdWxkIGJlIGNsZWFyZWRcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCBcImNvbnRpbnVlXCIpO1xuICAgIGFzc2VydC5lcXVhbChzLnZlcmlmaWNhdGlvblJldHJ5Q291bnQuaGFzKFwiZXhlY3V0ZS10YXNrOk0wMDEvUzAxL1QwMVwiKSwgZmFsc2UpO1xuICB9KTtcblxuICB0ZXN0KFwicG9zdC1leGVjIGZhaWx1cmUgbm90aWZpY2F0aW9uIG1lbnRpb25zIGNyb3NzLXRhc2sgY29uc2lzdGVuY3lcIiwgYXN5bmMgKCkgPT4ge1xuICAgIC8vIFRoaXMgdGVzdCB2ZXJpZmllcyB0aGF0IHRoZSBub3RpZmljYXRpb24gZm9yIHBvc3QtZXhlYyBmYWlsdXJlcyBpbmNsdWRlc1xuICAgIC8vIHRoZSBhcHByb3ByaWF0ZSBtZXNzYWdlIGFib3V0IGNyb3NzLXRhc2sgY29uc2lzdGVuY3kgaXNzdWVzLlxuICAgIC8vIFRoZSBhY3R1YWwgcG9zdC1leGVjIGZhaWx1cmUgd291bGQgcmVxdWlyZSBzcGVjaWZpYyBmaWxlL291dHB1dCBzdGF0ZVxuICAgIC8vIHRoYXQncyBoYXJkZXIgdG8gc2V0IHVwIGluIGEgdW5pdCB0ZXN0LCBidXQgd2UgY2FuIHZlcmlmeSB0aGUgY29kZSBwYXRoIGV4aXN0cy5cbiAgICBcbiAgICBjcmVhdGVCYXNpY1Rhc2soKTtcbiAgICB3cml0ZVByZWZlcmVuY2VzKHtcbiAgICAgIGVuaGFuY2VkX3ZlcmlmaWNhdGlvbjogdHJ1ZSxcbiAgICAgIGVuaGFuY2VkX3ZlcmlmaWNhdGlvbl9wb3N0OiB0cnVlLFxuICAgICAgdmVyaWZpY2F0aW9uX2F1dG9fZml4OiB0cnVlLFxuICAgICAgdmVyaWZpY2F0aW9uX21heF9yZXRyaWVzOiAzLFxuICAgIH0pO1xuXG4gICAgY29uc3QgY3R4ID0gbWFrZU1vY2tDdHgoKTtcbiAgICBjb25zdCBwaSA9IG1ha2VNb2NrUGkoKTtcbiAgICBjb25zdCBwYXVzZUF1dG9Nb2NrID0gbW9jay5mbihhc3luYyAoKSA9PiB7fSk7XG4gICAgY29uc3QgcyA9IG1ha2VNb2NrU2Vzc2lvbih0ZW1wRGlyLCB7IHR5cGU6IFwiZXhlY3V0ZS10YXNrXCIsIGlkOiBcIk0wMDEvUzAxL1QwMVwiIH0pO1xuXG4gICAgY29uc3QgdmN0eDogVmVyaWZpY2F0aW9uQ29udGV4dCA9IHsgcywgY3R4LCBwaSB9O1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1blBvc3RVbml0VmVyaWZpY2F0aW9uKHZjdHgsIHBhdXNlQXV0b01vY2spO1xuXG4gICAgLy8gVGhlIHZlcmlmaWNhdGlvbiBzaG91bGQgcGFzcyB3aXRoIG91ciBzaW1wbGUgXCJlY2hvIHBhc3NcIiB0YXNrXG4gICAgLy8gVGhpcyB0ZXN0IG1haW5seSBjb25maXJtcyB0aGUgd2lyaW5nIGlzIGNvcnJlY3RcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCBcImNvbnRpbnVlXCIpO1xuICB9KTtcblxuICB0ZXN0KFwidW9rIGdhdGUgcnVubmVyIHBlcnNpc3RzIHBvc3QtZXhlY3V0aW9uIGdhdGUgZmFpbHVyZXMgd2hlbiBlbmFibGVkXCIsIGFzeW5jICgpID0+IHtcbiAgICBjcmVhdGVQb3N0RXhlY0ZhaWx1cmVUYXNrKCk7XG4gICAgd3JpdGVQcmVmZXJlbmNlcyh7XG4gICAgICBlbmhhbmNlZF92ZXJpZmljYXRpb246IHRydWUsXG4gICAgICBlbmhhbmNlZF92ZXJpZmljYXRpb25fcG9zdDogdHJ1ZSxcbiAgICAgIHZlcmlmaWNhdGlvbl9hdXRvX2ZpeDogdHJ1ZSxcbiAgICAgIHZlcmlmaWNhdGlvbl9tYXhfcmV0cmllczogMixcbiAgICAgIHVvazoge1xuICAgICAgICBlbmFibGVkOiB0cnVlLFxuICAgICAgICBnYXRlczogeyBlbmFibGVkOiB0cnVlIH0sXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgY29uc3QgY3R4ID0gbWFrZU1vY2tDdHgoKTtcbiAgICBjb25zdCBwaSA9IG1ha2VNb2NrUGkoKTtcbiAgICBjb25zdCBwYXVzZUF1dG9Nb2NrID0gbW9jay5mbihhc3luYyAoKSA9PiB7fSk7XG4gICAgY29uc3QgcyA9IG1ha2VNb2NrU2Vzc2lvbih0ZW1wRGlyLCB7IHR5cGU6IFwiZXhlY3V0ZS10YXNrXCIsIGlkOiBcIk0wMDEvUzAxL1QwMVwiIH0pO1xuICAgIGNvbnN0IHZjdHg6IFZlcmlmaWNhdGlvbkNvbnRleHQgPSB7IHMsIGN0eCwgcGkgfTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1blBvc3RVbml0VmVyaWZpY2F0aW9uKHZjdHgsIHBhdXNlQXV0b01vY2spO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgXCJwYXVzZVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocGF1c2VBdXRvTW9jay5tb2NrLmNhbGxDb3VudCgpLCAxKTtcblxuICAgIGNvbnN0IGFkYXB0ZXIgPSBfZ2V0QWRhcHRlcigpO1xuICAgIGNvbnN0IHJvdyA9IGFkYXB0ZXJcbiAgICAgID8ucHJlcGFyZShcbiAgICAgICAgYFNFTEVDVCBnYXRlX2lkLCBvdXRjb21lLCBmYWlsdXJlX2NsYXNzXG4gICAgICAgICBGUk9NIGdhdGVfcnVuc1xuICAgICAgICAgV0hFUkUgZ2F0ZV9pZCA9ICdwb3N0LWV4ZWN1dGlvbi1jaGVja3MnXG4gICAgICAgICBPUkRFUiBCWSBpZCBERVNDXG4gICAgICAgICBMSU1JVCAxYCxcbiAgICAgIClcbiAgICAgIC5nZXQoKSBhcyB7IGdhdGVfaWQ6IHN0cmluZzsgb3V0Y29tZTogc3RyaW5nOyBmYWlsdXJlX2NsYXNzOiBzdHJpbmcgfSB8IHVuZGVmaW5lZDtcblxuICAgIGFzc2VydC5vayhyb3csIFwicG9zdC1leGVjdXRpb24gZ2F0ZSBydW4gc2hvdWxkIGJlIHBlcnNpc3RlZCB3aGVuIHVvay5nYXRlcyBpcyBlbmFibGVkXCIpO1xuICAgIGFzc2VydC5lcXVhbChyb3c/LmdhdGVfaWQsIFwicG9zdC1leGVjdXRpb24tY2hlY2tzXCIpO1xuICAgIGFzc2VydC5lcXVhbChyb3c/Lm91dGNvbWUsIFwiZmFpbFwiKTtcbiAgICBhc3NlcnQuZXF1YWwocm93Py5mYWlsdXJlX2NsYXNzLCBcImFydGlmYWN0XCIpO1xuICB9KTtcblxuICB0ZXN0KFwiZXhlY3V0ZS10YXNrIHdpdGggbm8gaG9zdC1vd25lZCB2ZXJpZmljYXRpb24gcGF1c2VzIGZhaWwtY2xvc2VkXCIsIGFzeW5jICgpID0+IHtcbiAgICBjcmVhdGVUYXNrV2l0aG91dFZlcmlmeSgpO1xuXG4gICAgY29uc3QgY3R4ID0gbWFrZU1vY2tDdHgoKTtcbiAgICBjb25zdCBwaSA9IG1ha2VNb2NrUGkoKTtcbiAgICBjb25zdCBwYXVzZUF1dG9Nb2NrID0gbW9jay5mbihhc3luYyAoKSA9PiB7fSk7XG4gICAgY29uc3QgcyA9IG1ha2VNb2NrU2Vzc2lvbih0ZW1wRGlyLCB7IHR5cGU6IFwiZXhlY3V0ZS10YXNrXCIsIGlkOiBcIk0wMDEvUzAxL1QwMVwiIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuUG9zdFVuaXRWZXJpZmljYXRpb24oeyBzLCBjdHgsIHBpIH0sIHBhdXNlQXV0b01vY2spO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgXCJwYXVzZVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocGF1c2VBdXRvTW9jay5tb2NrLmNhbGxDb3VudCgpLCAxKTtcbiAgICBhc3NlcnQuZXF1YWwocy5wZW5kaW5nVmVyaWZpY2F0aW9uUmV0cnksIG51bGwpO1xuXG4gICAgY29uc3QgZXZpZGVuY2VQYXRoID0gam9pbih0ZW1wRGlyLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiLCBcInRhc2tzXCIsIFwiVDAxLVZFUklGWS5qc29uXCIpO1xuICAgIGNvbnN0IGV2aWRlbmNlID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoZXZpZGVuY2VQYXRoLCBcInV0Zi04XCIpKTtcbiAgICBhc3NlcnQuZXF1YWwoZXZpZGVuY2UucGFzc2VkLCBmYWxzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKGV2aWRlbmNlLmRpc2NvdmVyeVNvdXJjZSwgXCJub25lXCIpO1xuICAgIGFzc2VydC5vayghKFwicmV0cnlBdHRlbXB0XCIgaW4gZXZpZGVuY2UpLCBcIm5vLWhvc3QtY2hlY2tzIGV2aWRlbmNlIG11c3Qgbm90IGluY2x1ZGUgcmV0cnlBdHRlbXB0XCIpO1xuICAgIGFzc2VydC5vayghKFwibWF4UmV0cmllc1wiIGluIGV2aWRlbmNlKSwgXCJuby1ob3N0LWNoZWNrcyBldmlkZW5jZSBtdXN0IG5vdCBpbmNsdWRlIG1heFJldHJpZXNcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJhdXRvLWRpc2NvdmVyZWQgcGFja2FnZS5qc29uIHZlcmlmaWNhdGlvbiBmYWlsdXJlIHJldHJpZXMgaW5zdGVhZCBvZiBjb250aW51aW5nXCIsIGFzeW5jICgpID0+IHtcbiAgICBjcmVhdGVUYXNrV2l0aG91dFZlcmlmeSgpO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKHRlbXBEaXIsIFwicGFja2FnZS5qc29uXCIpLFxuICAgICAgSlNPTi5zdHJpbmdpZnkoeyBzY3JpcHRzOiB7IHRlc3Q6IFwiZXhpdCAxXCIgfSB9KSxcbiAgICAgIFwidXRmLThcIixcbiAgICApO1xuICAgIHdyaXRlUHJlZmVyZW5jZXMoe1xuICAgICAgdmVyaWZpY2F0aW9uX2F1dG9fZml4OiB0cnVlLFxuICAgICAgdmVyaWZpY2F0aW9uX21heF9yZXRyaWVzOiAyLFxuICAgIH0pO1xuXG4gICAgY29uc3QgY3R4ID0gbWFrZU1vY2tDdHgoKTtcbiAgICBjb25zdCBwaSA9IG1ha2VNb2NrUGkoKTtcbiAgICBjb25zdCBwYXVzZUF1dG9Nb2NrID0gbW9jay5mbihhc3luYyAoKSA9PiB7fSk7XG4gICAgY29uc3QgcyA9IG1ha2VNb2NrU2Vzc2lvbih0ZW1wRGlyLCB7IHR5cGU6IFwiZXhlY3V0ZS10YXNrXCIsIGlkOiBcIk0wMDEvUzAxL1QwMVwiIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuUG9zdFVuaXRWZXJpZmljYXRpb24oeyBzLCBjdHgsIHBpIH0sIHBhdXNlQXV0b01vY2spO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgXCJyZXRyeVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocGF1c2VBdXRvTW9jay5tb2NrLmNhbGxDb3VudCgpLCAwKTtcbiAgICBhc3NlcnQuZXF1YWwocy5wZW5kaW5nVmVyaWZpY2F0aW9uUmV0cnk/LnVuaXRJZCwgXCJNMDAxL1MwMS9UMDFcIik7XG4gICAgYXNzZXJ0Lm1hdGNoKHMucGVuZGluZ1ZlcmlmaWNhdGlvblJldHJ5Py5mYWlsdXJlQ29udGV4dCA/PyBcIlwiLCAvbnBtIHJ1biB0ZXN0Lyk7XG4gIH0pO1xufSk7XG5cbmRlc2NyaWJlKFwiUG9zdC1leGVjdXRpb24gcmV0cnkgYmVoYXZpb3JcIiwgKCkgPT4ge1xuICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICBzZXR1cFRlc3RFbnZpcm9ubWVudCgpO1xuICB9KTtcblxuICBhZnRlckVhY2goKCkgPT4ge1xuICAgIGNsZWFudXBUZXN0RW52aXJvbm1lbnQoKTtcbiAgfSk7XG5cbiAgdGVzdChcIndoZW4gYXV0b2ZpeCBpcyBkaXNhYmxlZCwgZmFpbHVyZSBwYXVzZXMgaW1tZWRpYXRlbHkgd2l0aG91dCByZXRyeVwiLCBhc3luYyAoKSA9PiB7XG4gICAgLy8gQ3JlYXRlIGEgdGFzayB3aXRoIGEgdmVyaWZ5IGNvbW1hbmQgdGhhdCB3aWxsIGZhaWxcbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIgfSk7XG4gICAgaW5zZXJ0U2xpY2Uoe1xuICAgICAgaWQ6IFwiUzAxXCIsXG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICB0aXRsZTogXCJUZXN0IFNsaWNlXCIsXG4gICAgICByaXNrOiBcImxvd1wiLFxuICAgIH0pO1xuICAgIGluc2VydFRhc2soe1xuICAgICAgaWQ6IFwiVDAxXCIsXG4gICAgICBzbGljZUlkOiBcIlMwMVwiLFxuICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgdGl0bGU6IFwiRmFpbGluZyB0YXNrXCIsXG4gICAgICBzdGF0dXM6IFwicGVuZGluZ1wiLFxuICAgICAgcGxhbm5pbmc6IHtcbiAgICAgICAgZGVzY3JpcHRpb246IFwiVGFzayB3aXRoIGZhaWxpbmcgdmVyaWZpY2F0aW9uXCIsXG4gICAgICAgIGVzdGltYXRlOiBcIjFoXCIsXG4gICAgICAgIGZpbGVzOiBbXSxcbiAgICAgICAgdmVyaWZ5OiBcImV4aXQgMVwiLCAvLyBUaGlzIHdpbGwgZmFpbFxuICAgICAgICBpbnB1dHM6IFtdLFxuICAgICAgICBleHBlY3RlZE91dHB1dDogW10sXG4gICAgICAgIG9ic2VydmFiaWxpdHlJbXBhY3Q6IFwiXCIsXG4gICAgICB9LFxuICAgICAgc2VxdWVuY2U6IDAsXG4gICAgfSk7XG5cbiAgICB3cml0ZVByZWZlcmVuY2VzKHtcbiAgICAgIGVuaGFuY2VkX3ZlcmlmaWNhdGlvbjogdHJ1ZSxcbiAgICAgIGVuaGFuY2VkX3ZlcmlmaWNhdGlvbl9wb3N0OiB0cnVlLFxuICAgICAgdmVyaWZpY2F0aW9uX2F1dG9fZml4OiBmYWxzZSwgLy8gQXV0b2ZpeCBkaXNhYmxlZFxuICAgICAgdmVyaWZpY2F0aW9uX21heF9yZXRyaWVzOiAzLFxuICAgIH0pO1xuXG4gICAgY29uc3QgY3R4ID0gbWFrZU1vY2tDdHgoKTtcbiAgICBjb25zdCBwaSA9IG1ha2VNb2NrUGkoKTtcbiAgICBjb25zdCBwYXVzZUF1dG9Nb2NrID0gbW9jay5mbihhc3luYyAoKSA9PiB7fSk7XG4gICAgY29uc3QgcyA9IG1ha2VNb2NrU2Vzc2lvbih0ZW1wRGlyLCB7IHR5cGU6IFwiZXhlY3V0ZS10YXNrXCIsIGlkOiBcIk0wMDEvUzAxL1QwMVwiIH0pO1xuXG4gICAgY29uc3QgdmN0eDogVmVyaWZpY2F0aW9uQ29udGV4dCA9IHsgcywgY3R4LCBwaSB9O1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1blBvc3RVbml0VmVyaWZpY2F0aW9uKHZjdHgsIHBhdXNlQXV0b01vY2spO1xuXG4gICAgLy8gV2hlbiBhdXRvZml4IGlzIGRpc2FibGVkIGFuZCB2ZXJpZmljYXRpb24gZmFpbHMsIHNob3VsZCBwYXVzZVxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIFwicGF1c2VcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHBhdXNlQXV0b01vY2subW9jay5jYWxsQ291bnQoKSwgMSk7XG4gICAgXG4gICAgLy8gU2hvdWxkIE5PVCBzZXQgdXAgYSByZXRyeVxuICAgIGFzc2VydC5lcXVhbChzLnBlbmRpbmdWZXJpZmljYXRpb25SZXRyeSwgbnVsbCk7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFVQSxTQUFTLFVBQVUsTUFBTSxNQUFNLFlBQVksaUJBQWlCO0FBQzVELE9BQU8sWUFBWTtBQUNuQixTQUFTLGNBQWM7QUFDdkIsU0FBUyxXQUFXLGNBQWMsZUFBZSxjQUFjO0FBQy9ELFNBQVMsWUFBWTtBQUVyQixTQUFTLCtCQUF5RDtBQUNsRSxTQUFTLG1CQUFtQjtBQUM1QixTQUFTLGNBQWMsZUFBZSxpQkFBaUIsYUFBYSxZQUFZLG1CQUFtQjtBQUNuRyxTQUFTLDJCQUEyQjtBQUNwQyxTQUFTLDBCQUEwQjtBQUluQyxJQUFJO0FBQ0osSUFBSTtBQUNKLElBQUk7QUFFSixTQUFTLGNBQWM7QUFDckIsU0FBTztBQUFBLElBQ0wsSUFBSTtBQUFBLE1BQ0YsUUFBUSxLQUFLLEdBQUc7QUFBQSxNQUNoQixXQUFXLE1BQU07QUFBQSxNQUFDO0FBQUEsTUFDbEIsV0FBVyxNQUFNO0FBQUEsTUFBQztBQUFBLE1BQ2xCLFdBQVcs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
