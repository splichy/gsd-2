import { describe, test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { postUnitPostVerification } from "../auto-post-unit.js";
import { AutoSession } from "../auto/session.js";
import { openDatabase, closeDatabase, insertMilestone, insertSlice, insertTask, _getAdapter } from "../gsd-db.js";
import { invalidateAllCaches } from "../cache.js";
import { _clearGsdRootCache } from "../paths.js";
let tempDir;
let dbPath;
let originalCwd;
function resetAllCaches() {
  invalidateAllCaches();
  _clearGsdRootCache();
}
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
  if (currentUnit) {
    s.currentUnit = {
      type: currentUnit.type,
      id: currentUnit.id,
      startedAt: Date.now()
    };
  }
  return s;
}
function makePostUnitContext(s, ctx, pi, pauseAutoMock) {
  return {
    s,
    ctx,
    pi,
    buildSnapshotOpts: () => ({}),
    lockBase: () => tempDir,
    stopAuto: mock.fn(async () => {
    }),
    pauseAuto: pauseAutoMock,
    updateProgressWidget: () => {
    }
  };
}
function setupTestEnvironment() {
  originalCwd = process.cwd();
  tempDir = join(tmpdir(), `pre-exec-pause-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  const gsdDir = join(tempDir, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  const milestonesDir = join(gsdDir, "milestones", "M001", "slices", "S01", "tasks");
  mkdirSync(milestonesDir, { recursive: true });
  process.chdir(tempDir);
  resetAllCaches();
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
  resetAllCaches();
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
  resetAllCaches();
}
function createFailingTasks() {
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
    title: "Task with missing file",
    status: "pending",
    planning: {
      description: "This task references a non-existent file",
      estimate: "1h",
      files: [],
      verify: "npm test",
      inputs: [
        "nonexistent-file-that-does-not-exist.ts",
        "missing-second-file.ts",
        "missing-third-file.ts",
        "missing-fourth-file.ts"
      ],
      expectedOutput: [],
      observabilityImpact: ""
    },
    sequence: 0
  });
}
function createWarningOnlyTasks() {
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
    title: "Task 1 with function signature",
    status: "pending",
    planning: {
      description: `
\`\`\`typescript
function processData(input: string): boolean
\`\`\`
      `.trim(),
      estimate: "1h",
      files: [],
      verify: "npm test",
      inputs: [],
      expectedOutput: [],
      observabilityImpact: ""
    },
    sequence: 0
  });
  insertTask({
    id: "T02",
    sliceId: "S01",
    milestoneId: "M001",
    title: "Task 2 with mismatched signature",
    status: "pending",
    planning: {
      description: `
\`\`\`typescript
function processData(input: number): string
\`\`\`
      `.trim(),
      estimate: "1h",
      files: [],
      verify: "npm test",
      inputs: [],
      expectedOutput: [],
      observabilityImpact: ""
    },
    sequence: 1
  });
}
describe("Pre-execution checks \u2192 pauseAuto wiring", () => {
  beforeEach(() => {
    setupTestEnvironment();
  });
  afterEach(() => {
    cleanupTestEnvironment();
  });
  test("pauseAuto is called when pre-execution checks return status: fail with blocking: true", async () => {
    createFailingTasks();
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {
    });
    const s = makeMockSession(tempDir, { type: "plan-slice", id: "M001/S01" });
    const pctx = makePostUnitContext(s, ctx, pi, pauseAutoMock);
    const result = await postUnitPostVerification(pctx);
    assert.equal(
      pauseAutoMock.mock.callCount(),
      1,
      "pauseAuto should be called exactly once when pre-execution checks fail with blocking issues"
    );
    assert.equal(
      result,
      "stopped",
      "postUnitPostVerification should return 'stopped' when pre-execution checks fail"
    );
    const notifyCalls = ctx.ui.notify.mock.calls;
    const errorNotify = notifyCalls.find(
      (call) => call.arguments[1] === "error" && String(call.arguments[0]).includes("Pre-execution checks failed")
    );
    assert.ok(errorNotify, "Should show error notification about pre-execution check failure");
    const errorMessage = String(errorNotify.arguments[0]);
    assert.match(
      errorMessage,
      /Pre-execution checks failed: \d+ blocking issue/,
      "failure notification should include the blocking issue count"
    );
    assert.ok(
      errorMessage.includes("[file] nonexistent-file-that-does-not-exist.ts: Task T01 references"),
      "failure notification should include category, target, and message details"
    );
    assert.ok(
      errorMessage.includes("[file] missing-third-file.ts: Task T01 references"),
      "failure notification should include up to three actionable check details"
    );
    assert.ok(
      !errorMessage.includes("missing-fourth-file.ts"),
      "failure notification should truncate details beyond the display limit"
    );
    assert.ok(
      errorMessage.includes("...and 1 more"),
      "failure notification should summarize truncated blocking checks"
    );
    assert.ok(
      errorMessage.includes(join(".gsd", "milestones", "M001", "slices", "S01", "S01-PRE-EXEC-VERIFY.json")),
      "failure notification should point to the relative pre-exec evidence file path"
    );
  });
  test("pauseAuto is called when enhanced_verification_strict: true and pre-execution returns warn", async () => {
    writePreferences({
      enhanced_verification: true,
      enhanced_verification_pre: true,
      enhanced_verification_strict: true
    });
    createWarningOnlyTasks();
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {
    });
    const s = makeMockSession(tempDir, { type: "plan-slice", id: "M001/S01" });
    const pctx = makePostUnitContext(s, ctx, pi, pauseAutoMock);
    const result = await postUnitPostVerification(pctx);
    assert.equal(
      pauseAutoMock.mock.callCount(),
      1,
      "pauseAuto should be called when strict mode is enabled and pre-execution returns warn"
    );
    assert.equal(
      result,
      "stopped",
      "postUnitPostVerification should return 'stopped' when strict mode treats warnings as blocking"
    );
    const notifyCalls = ctx.ui.notify.mock.calls;
    const warnNotify = notifyCalls.find(
      (call) => call.arguments[1] === "warning" && String(call.arguments[0]).includes("Pre-execution checks passed with warnings")
    );
    assert.ok(warnNotify, "Should show warning notification about pre-execution check warnings");
  });
  test("pauseAuto is NOT called when enhanced_verification_strict: false and pre-execution returns warn", async () => {
    writePreferences({
      enhanced_verification: true,
      enhanced_verification_pre: true,
      enhanced_verification_strict: false
    });
    createWarningOnlyTasks();
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {
    });
    const s = makeMockSession(tempDir, { type: "plan-slice", id: "M001/S01" });
    const pctx = makePostUnitContext(s, ctx, pi, pauseAutoMock);
    const result = await postUnitPostVerification(pctx);
    assert.equal(
      pauseAutoMock.mock.callCount(),
      0,
      "pauseAuto should NOT be called when strict mode is disabled and only warnings exist"
    );
    assert.equal(
      result,
      "continue",
      "postUnitPostVerification should return 'continue' when warnings don't block in non-strict mode"
    );
  });
  test("pre-execution checks are skipped when unit type is not plan-slice", async () => {
    createFailingTasks();
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {
    });
    const s = makeMockSession(tempDir, { type: "execute-task", id: "M001/S01/T01" });
    const pctx = makePostUnitContext(s, ctx, pi, pauseAutoMock);
    const result = await postUnitPostVerification(pctx);
    assert.equal(
      pauseAutoMock.mock.callCount(),
      0,
      "pauseAuto should NOT be called for non-plan-slice unit types"
    );
    assert.equal(
      result,
      "continue",
      "postUnitPostVerification should return 'continue' for non-plan-slice unit types"
    );
  });
  test("pre-execution checks are skipped when enhanced_verification_pre: false", async () => {
    writePreferences({
      enhanced_verification: true,
      enhanced_verification_pre: false
    });
    createFailingTasks();
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {
    });
    const s = makeMockSession(tempDir, { type: "plan-slice", id: "M001/S01" });
    const pctx = makePostUnitContext(s, ctx, pi, pauseAutoMock);
    const result = await postUnitPostVerification(pctx);
    assert.equal(
      pauseAutoMock.mock.callCount(),
      0,
      "pauseAuto should NOT be called when enhanced_verification_pre is disabled"
    );
    assert.equal(
      result,
      "continue",
      "postUnitPostVerification should return 'continue' when pre-execution checks are disabled"
    );
  });
  test("files present in s.basePath (worktree) but absent from canonicalProjectRoot do not block", async () => {
    writePreferences({
      enhanced_verification: true,
      enhanced_verification_pre: true,
      enhanced_verification_strict: false
    });
    const worktreeDir = join(tempDir, "worktree");
    mkdirSync(join(worktreeDir, "lib"), { recursive: true });
    mkdirSync(join(worktreeDir, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
    writeFileSync(join(worktreeDir, "lib", "types.ts"), "export type Habit = { id: string; name: string; };");
    writeFileSync(join(worktreeDir, "lib", "useLocalStorage.ts"), "export function useLocalStorage() {}");
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Test Slice", risk: "low" });
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Task that reads prior-slice files",
      status: "pending",
      planning: {
        description: "Reads lib/types.ts and lib/useLocalStorage.ts from prior slice",
        estimate: "1h",
        files: [],
        verify: "npm test",
        inputs: ["lib/types.ts", "lib/useLocalStorage.ts"],
        expectedOutput: ["lib/utils.ts"],
        observabilityImpact: ""
      },
      sequence: 0
    });
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {
    });
    const s = makeMockSession(worktreeDir, { type: "plan-slice", id: "M001/S01" });
    Object.defineProperty(s, "canonicalProjectRoot", { get: () => tempDir });
    const pctx = makePostUnitContext(s, ctx, pi, pauseAutoMock);
    const result = await postUnitPostVerification(pctx);
    assert.equal(
      pauseAutoMock.mock.callCount(),
      0,
      "pauseAuto should NOT be called when referenced files exist in s.basePath (worktree)"
    );
    assert.equal(
      result,
      "continue",
      "postUnitPostVerification should return 'continue' when worktree files satisfy pre-exec inputs"
    );
  });
  test("uok gate runner persists pre-execution gate outcomes when enabled", async () => {
    writePreferences({
      enhanced_verification: true,
      enhanced_verification_pre: true,
      enhanced_verification_strict: true,
      uok: {
        enabled: true,
        gates: { enabled: true }
      }
    });
    createFailingTasks();
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {
    });
    const s = makeMockSession(tempDir, { type: "plan-slice", id: "M001/S01" });
    const pctx = makePostUnitContext(s, ctx, pi, pauseAutoMock);
    const result = await postUnitPostVerification(pctx);
    assert.equal(result, "stopped");
    const adapter = _getAdapter();
    const row = adapter?.prepare(
      `SELECT gate_id, outcome, failure_class
         FROM gate_runs
         WHERE gate_id = 'pre-execution-checks'
         ORDER BY id DESC
         LIMIT 1`
    ).get();
    assert.ok(row, "pre-execution gate run should be persisted when uok.gates is enabled");
    assert.equal(row?.gate_id, "pre-execution-checks");
    assert.equal(row?.outcome, "fail");
    assert.equal(row?.failure_class, "input");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wcmUtZXhlY3V0aW9uLXBhdXNlLXdpcmluZy50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBQcm9qZWN0L0FwcDogR1NELTJcbi8vIEZpbGUgUHVycG9zZTogSW50ZWdyYXRpb24gdGVzdHMgZm9yIHByZS1leGVjdXRpb24gY2hlY2sgcGF1c2Ugd2lyaW5nLlxuLyoqXG4gKiBwcmUtZXhlY3V0aW9uLXBhdXNlLXdpcmluZy50ZXN0LnRzIFx1MjAxNCBJbnRlZ3JhdGlvbiB0ZXN0cyBmb3IgcHJlLWV4ZWN1dGlvbiBjaGVjayBcdTIxOTIgcGF1c2VBdXRvIHdpcmluZy5cbiAqXG4gKiBUZXN0cyB0aGF0IHZlcmlmeSB0aGUgY29udHJvbCBmbG93IGZyb20gcHJlLWV4ZWN1dGlvbiBjaGVja3MgdGhyb3VnaCB0byBwYXVzZUF1dG86XG4gKiAgIDEuIFdoZW4gcnVuUHJlRXhlY3V0aW9uQ2hlY2tzIHJldHVybnMgc3RhdHVzOiBcImZhaWxcIiB3aXRoIGJsb2NraW5nOiB0cnVlLCBwYXVzZUF1dG8gaXMgY2FsbGVkXG4gKiAgIDIuIFdoZW4gZW5oYW5jZWRfdmVyaWZpY2F0aW9uX3N0cmljdDogdHJ1ZSBhbmQgc3RhdHVzOiBcIndhcm5cIiwgcGF1c2VBdXRvIGlzIGFsc28gY2FsbGVkXG4gKlxuICogVGhlc2UgYXJlIGludGVncmF0aW9uLWxldmVsIHRlc3RzIHRoYXQgZXhlcmNpc2UgdGhlIGFjdHVhbCBwb3N0VW5pdFBvc3RWZXJpZmljYXRpb24gZnVuY3Rpb25cbiAqIHdpdGggY29udHJvbGxlZCBtb2NrcyBmb3IgZXh0ZXJuYWwgZGVwZW5kZW5jaWVzLlxuICovXG5cbmltcG9ydCB7IGRlc2NyaWJlLCB0ZXN0LCBtb2NrLCBiZWZvcmVFYWNoLCBhZnRlckVhY2ggfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBta2RpclN5bmMsIHdyaXRlRmlsZVN5bmMsIHJtU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuXG5pbXBvcnQgeyBwb3N0VW5pdFBvc3RWZXJpZmljYXRpb24sIHR5cGUgUG9zdFVuaXRDb250ZXh0IH0gZnJvbSBcIi4uL2F1dG8tcG9zdC11bml0LnRzXCI7XG5pbXBvcnQgeyBBdXRvU2Vzc2lvbiB9IGZyb20gXCIuLi9hdXRvL3Nlc3Npb24udHNcIjtcbmltcG9ydCB7IG9wZW5EYXRhYmFzZSwgY2xvc2VEYXRhYmFzZSwgaW5zZXJ0TWlsZXN0b25lLCBpbnNlcnRTbGljZSwgaW5zZXJ0VGFzaywgX2dldEFkYXB0ZXIgfSBmcm9tIFwiLi4vZ3NkLWRiLnRzXCI7XG5pbXBvcnQgeyBpbnZhbGlkYXRlQWxsQ2FjaGVzIH0gZnJvbSBcIi4uL2NhY2hlLnRzXCI7XG5pbXBvcnQgeyBfY2xlYXJHc2RSb290Q2FjaGUgfSBmcm9tIFwiLi4vcGF0aHMudHNcIjtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRlc3QgRml4dHVyZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmxldCB0ZW1wRGlyOiBzdHJpbmc7XG5sZXQgZGJQYXRoOiBzdHJpbmc7XG5sZXQgb3JpZ2luYWxDd2Q6IHN0cmluZztcblxuZnVuY3Rpb24gcmVzZXRBbGxDYWNoZXMoKTogdm9pZCB7XG4gIGludmFsaWRhdGVBbGxDYWNoZXMoKTtcbiAgX2NsZWFyR3NkUm9vdENhY2hlKCk7XG59XG5cbi8qKlxuICogQ3JlYXRlIGEgbWluaW1hbCBtb2NrIEV4dGVuc2lvbkNvbnRleHQuXG4gKi9cbmZ1bmN0aW9uIG1ha2VNb2NrQ3R4KCkge1xuICByZXR1cm4ge1xuICAgIHVpOiB7XG4gICAgICBub3RpZnk6IG1vY2suZm4oKSxcbiAgICAgIHNldFN0YXR1czogKCkgPT4ge30sXG4gICAgICBzZXRXaWRnZXQ6ICgpID0+IHt9LFxuICAgICAgc2V0Rm9vdGVyOiAoKSA9PiB7fSxcbiAgICB9LFxuICAgIG1vZGVsOiB7IGlkOiBcInRlc3QtbW9kZWxcIiB9LFxuICB9IGFzIGFueTtcbn1cblxuLyoqXG4gKiBDcmVhdGUgYSBtaW5pbWFsIG1vY2sgRXh0ZW5zaW9uQVBJLlxuICovXG5mdW5jdGlvbiBtYWtlTW9ja1BpKCkge1xuICByZXR1cm4ge1xuICAgIHNlbmRNZXNzYWdlOiBtb2NrLmZuKCksXG4gICAgc2V0TW9kZWw6IG1vY2suZm4oYXN5bmMgKCkgPT4gdHJ1ZSksXG4gIH0gYXMgYW55O1xufVxuXG4vKipcbiAqIENyZWF0ZSBhIG1pbmltYWwgQXV0b1Nlc3Npb24gZm9yIHRlc3RpbmcuXG4gKi9cbmZ1bmN0aW9uIG1ha2VNb2NrU2Vzc2lvbihiYXNlUGF0aDogc3RyaW5nLCBjdXJyZW50VW5pdD86IHsgdHlwZTogc3RyaW5nOyBpZDogc3RyaW5nIH0pOiBBdXRvU2Vzc2lvbiB7XG4gIGNvbnN0IHMgPSBuZXcgQXV0b1Nlc3Npb24oKTtcbiAgcy5iYXNlUGF0aCA9IGJhc2VQYXRoO1xuICBzLmFjdGl2ZSA9IHRydWU7XG4gIGlmIChjdXJyZW50VW5pdCkge1xuICAgIHMuY3VycmVudFVuaXQgPSB7XG4gICAgICB0eXBlOiBjdXJyZW50VW5pdC50eXBlLFxuICAgICAgaWQ6IGN1cnJlbnRVbml0LmlkLFxuICAgICAgc3RhcnRlZEF0OiBEYXRlLm5vdygpLFxuICAgIH07XG4gIH1cbiAgcmV0dXJuIHM7XG59XG5cbi8qKlxuICogQ3JlYXRlIGEgUG9zdFVuaXRDb250ZXh0IHdpdGggYSBtb2NrYWJsZSBwYXVzZUF1dG8uXG4gKi9cbmZ1bmN0aW9uIG1ha2VQb3N0VW5pdENvbnRleHQoXG4gIHM6IEF1dG9TZXNzaW9uLFxuICBjdHg6IFJldHVyblR5cGU8dHlwZW9mIG1ha2VNb2NrQ3R4PixcbiAgcGk6IFJldHVyblR5cGU8dHlwZW9mIG1ha2VNb2NrUGk+LFxuICBwYXVzZUF1dG9Nb2NrOiBSZXR1cm5UeXBlPHR5cGVvZiBtb2NrLmZuPixcbik6IFBvc3RVbml0Q29udGV4dCB7XG4gIHJldHVybiB7XG4gICAgcyxcbiAgICBjdHgsXG4gICAgcGksXG4gICAgYnVpbGRTbmFwc2hvdE9wdHM6ICgpID0+ICh7fSksXG4gICAgbG9ja0Jhc2U6ICgpID0+IHRlbXBEaXIsXG4gICAgc3RvcEF1dG86IG1vY2suZm4oYXN5bmMgKCkgPT4ge30pIGFzIHVua25vd24gYXMgUG9zdFVuaXRDb250ZXh0W1wic3RvcEF1dG9cIl0sXG4gICAgcGF1c2VBdXRvOiBwYXVzZUF1dG9Nb2NrIGFzIHVua25vd24gYXMgUG9zdFVuaXRDb250ZXh0W1wicGF1c2VBdXRvXCJdLFxuICAgIHVwZGF0ZVByb2dyZXNzV2lkZ2V0OiAoKSA9PiB7fSxcbiAgfTtcbn1cblxuLyoqXG4gKiBTZXQgdXAgYSB0ZW1wIGRpcmVjdG9yeSB3aXRoIEdTRCBzdHJ1Y3R1cmUgYW5kIERCLlxuICogQWxzbyBjaGFuZ2VzIGN3ZCBzbyBwcmVmZXJlbmNlcyBsb2FkaW5nIGZpbmRzIHRoZSByaWdodCBQUkVGRVJFTkNFUy5tZC5cbiAqL1xuZnVuY3Rpb24gc2V0dXBUZXN0RW52aXJvbm1lbnQoKTogdm9pZCB7XG4gIC8vIFNhdmUgb3JpZ2luYWwgY3dkIHNvIHdlIGNhbiByZXN0b3JlIGl0XG4gIG9yaWdpbmFsQ3dkID0gcHJvY2Vzcy5jd2QoKTtcbiAgXG4gIHRlbXBEaXIgPSBqb2luKHRtcGRpcigpLCBgcHJlLWV4ZWMtcGF1c2UtdGVzdC0ke0RhdGUubm93KCl9LSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMil9YCk7XG4gIG1rZGlyU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgXG4gIC8vIENyZWF0ZSAuZ3NkIGRpcmVjdG9yeSBzdHJ1Y3R1cmVcbiAgY29uc3QgZ3NkRGlyID0gam9pbih0ZW1wRGlyLCBcIi5nc2RcIik7XG4gIG1rZGlyU3luYyhnc2REaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBcbiAgLy8gQ3JlYXRlIG1pbGVzdG9uZXMgZGlyZWN0b3J5IHN0cnVjdHVyZVxuICBjb25zdCBtaWxlc3RvbmVzRGlyID0gam9pbihnc2REaXIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIiwgXCJ0YXNrc1wiKTtcbiAgbWtkaXJTeW5jKG1pbGVzdG9uZXNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBcbiAgLy8gQ2hhbmdlIGN3ZCBzbyBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMgZmluZHMgb3VyIFBSRUZFUkVOQ0VTLm1kXG4gIHByb2Nlc3MuY2hkaXIodGVtcERpcik7XG4gIFxuICAvLyBDbGVhciBjYWNoZXMgc28gaXQgZmluZHMgdGhlIG5ldyAuZ3NkIGRpcmVjdG9yeSBhbmQgcHJlZmVyZW5jZXMuXG4gIHJlc2V0QWxsQ2FjaGVzKCk7XG4gIFxuICAvLyBJbml0aWFsaXplIERCXG4gIGRiUGF0aCA9IGpvaW4oZ3NkRGlyLCBcImdzZC5kYlwiKTtcbiAgb3BlbkRhdGFiYXNlKGRiUGF0aCk7XG59XG5cbi8qKlxuICogQ2xlYW4gdXAgdGVzdCBlbnZpcm9ubWVudC5cbiAqL1xuZnVuY3Rpb24gY2xlYW51cFRlc3RFbnZpcm9ubWVudCgpOiB2b2lkIHtcbiAgLy8gUmVzdG9yZSBvcmlnaW5hbCBjd2QgYmVmb3JlIGNsZWFudXBcbiAgdHJ5IHtcbiAgICBwcm9jZXNzLmNoZGlyKG9yaWdpbmFsQ3dkKTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gSWdub3JlIGlmIG9yaWdpbmFsIGN3ZCBkb2Vzbid0IGV4aXN0XG4gIH1cbiAgXG4gIHRyeSB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICB9IGNhdGNoIHtcbiAgICAvLyBJZ25vcmUgY2xvc2UgZXJyb3JzXG4gIH1cbiAgcmVzZXRBbGxDYWNoZXMoKTtcbiAgdHJ5IHtcbiAgICBybVN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9IGNhdGNoIHtcbiAgICAvLyBJZ25vcmUgY2xlYW51cCBlcnJvcnNcbiAgfVxufVxuXG4vKipcbiAqIENyZWF0ZSBhIFBSRUZFUkVOQ0VTLm1kIGZpbGUgd2l0aCBzcGVjaWZpZWQgcHJlZmVyZW5jZXMuXG4gKiBVc2VzIFlBTUwgZnJvbnRtYXR0ZXIgZm9ybWF0ICgtLS1cXG5rZXk6IHZhbHVlXFxuLS0tKS5cbiAqIEFsc28gaW52YWxpZGF0ZXMgY2FjaGVzIHNvIHRoZSBwcmVmZXJlbmNlcyBhcmUgcmUtcmVhZC5cbiAqL1xuZnVuY3Rpb24gd3JpdGVQcmVmZXJlbmNlcyhwcmVmczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiB2b2lkIHtcbiAgY29uc3QgeWFtbExpbmVzID0gT2JqZWN0LmVudHJpZXMocHJlZnMpLm1hcCgoW2ssIHZdKSA9PiBgJHtrfTogJHtKU09OLnN0cmluZ2lmeSh2KX1gKTtcbiAgY29uc3QgcHJlZnNDb250ZW50ID0gYC0tLVxuJHt5YW1sTGluZXMuam9pbihcIlxcblwiKX1cbi0tLVxuXG4jIEdTRCBQcmVmZXJlbmNlc1xuYDtcbiAgd3JpdGVGaWxlU3luYyhqb2luKHRlbXBEaXIsIFwiLmdzZFwiLCBcIlBSRUZFUkVOQ0VTLm1kXCIpLCBwcmVmc0NvbnRlbnQpO1xuICAvLyBJbnZhbGlkYXRlIGNhY2hlcyBzbyB0aGUgbmV3IHByZWZlcmVuY2VzIGZpbGUgaXMgZm91bmRcbiAgcmVzZXRBbGxDYWNoZXMoKTtcbn1cblxuLyoqXG4gKiBDcmVhdGUgdGFza3MgaW4gREIgdGhhdCB3aWxsIGNhdXNlIHByZS1leGVjdXRpb24gY2hlY2tzIHRvIGZhaWwuXG4gKiBBIHRhc2sgdGhhdCByZWZlcmVuY2VzIGEgbm9uLWV4aXN0ZW50IGZpbGUgd2lsbCBwcm9kdWNlIGEgYmxvY2tpbmcgZmFpbHVyZS5cbiAqL1xuZnVuY3Rpb24gY3JlYXRlRmFpbGluZ1Rhc2tzKCk6IHZvaWQge1xuICAvLyBJbnNlcnQgbWlsZXN0b25lIGZpcnN0XG4gIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiB9KTtcblxuICAvLyBJbnNlcnQgc2xpY2VcbiAgaW5zZXJ0U2xpY2Uoe1xuICAgIGlkOiBcIlMwMVwiLFxuICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICB0aXRsZTogXCJUZXN0IFNsaWNlXCIsXG4gICAgcmlzazogXCJsb3dcIixcbiAgfSk7XG5cbiAgLy8gQ3JlYXRlIGEgdGFzayB0aGF0IHJlZmVyZW5jZXMgYSBmaWxlIHRoYXQgZG9lc24ndCBleGlzdFxuICAvLyBUaGlzIHdpbGwgY2F1c2UgY2hlY2tGaWxlUGF0aENvbnNpc3RlbmN5IHRvIHByb2R1Y2UgYSBibG9ja2luZyBmYWlsdXJlXG4gIGluc2VydFRhc2soe1xuICAgIGlkOiBcIlQwMVwiLFxuICAgIHNsaWNlSWQ6IFwiUzAxXCIsXG4gICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgIHRpdGxlOiBcIlRhc2sgd2l0aCBtaXNzaW5nIGZpbGVcIixcbiAgICBzdGF0dXM6IFwicGVuZGluZ1wiLFxuICAgIHBsYW5uaW5nOiB7XG4gICAgICBkZXNjcmlwdGlvbjogXCJUaGlzIHRhc2sgcmVmZXJlbmNlcyBhIG5vbi1leGlzdGVudCBmaWxlXCIsXG4gICAgICBlc3RpbWF0ZTogXCIxaFwiLFxuICAgICAgZmlsZXM6IFtdLFxuICAgICAgdmVyaWZ5OiBcIm5wbSB0ZXN0XCIsXG4gICAgICBpbnB1dHM6IFtcbiAgICAgICAgXCJub25leGlzdGVudC1maWxlLXRoYXQtZG9lcy1ub3QtZXhpc3QudHNcIixcbiAgICAgICAgXCJtaXNzaW5nLXNlY29uZC1maWxlLnRzXCIsXG4gICAgICAgIFwibWlzc2luZy10aGlyZC1maWxlLnRzXCIsXG4gICAgICAgIFwibWlzc2luZy1mb3VydGgtZmlsZS50c1wiLFxuICAgICAgXSxcbiAgICAgIGV4cGVjdGVkT3V0cHV0OiBbXSxcbiAgICAgIG9ic2VydmFiaWxpdHlJbXBhY3Q6IFwiXCIsXG4gICAgfSxcbiAgICBzZXF1ZW5jZTogMCxcbiAgfSk7XG59XG5cbi8qKlxuICogQ3JlYXRlIHRhc2tzIGluIERCIHRoYXQgd2lsbCBwcm9kdWNlIG9ubHkgd2FybmluZ3MgKG5vbi1ibG9ja2luZyBpc3N1ZXMpLlxuICogSW50ZXJmYWNlIGNvbnRyYWN0IG1pc21hdGNoZXMgcHJvZHVjZSB3YXJuaW5ncywgbm90IGJsb2NraW5nIGZhaWx1cmVzLlxuICovXG5mdW5jdGlvbiBjcmVhdGVXYXJuaW5nT25seVRhc2tzKCk6IHZvaWQge1xuICAvLyBJbnNlcnQgbWlsZXN0b25lIGZpcnN0XG4gIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiB9KTtcblxuICAvLyBJbnNlcnQgc2xpY2VcbiAgaW5zZXJ0U2xpY2Uoe1xuICAgIGlkOiBcIlMwMVwiLFxuICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICB0aXRsZTogXCJUZXN0IFNsaWNlXCIsXG4gICAgcmlzazogXCJsb3dcIixcbiAgfSk7XG5cbiAgLy8gQ3JlYXRlIHRhc2tzIHdpdGggaW50ZXJmYWNlIGNvbnRyYWN0IG1pc21hdGNoIChwcm9kdWNlcyB3YXJuLCBub3QgZmFpbClcbiAgaW5zZXJ0VGFzayh7XG4gICAgaWQ6IFwiVDAxXCIsXG4gICAgc2xpY2VJZDogXCJTMDFcIixcbiAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgdGl0bGU6IFwiVGFzayAxIHdpdGggZnVuY3Rpb24gc2lnbmF0dXJlXCIsXG4gICAgc3RhdHVzOiBcInBlbmRpbmdcIixcbiAgICBwbGFubmluZzoge1xuICAgICAgZGVzY3JpcHRpb246IGBcblxcYFxcYFxcYHR5cGVzY3JpcHRcbmZ1bmN0aW9uIHByb2Nlc3NEYXRhKGlucHV0OiBzdHJpbmcpOiBib29sZWFuXG5cXGBcXGBcXGBcbiAgICAgIGAudHJpbSgpLFxuICAgICAgZXN0aW1hdGU6IFwiMWhcIixcbiAgICAgIGZpbGVzOiBbXSxcbiAgICAgIHZlcmlmeTogXCJucG0gdGVzdFwiLFxuICAgICAgaW5wdXRzOiBbXSxcbiAgICAgIGV4cGVjdGVkT3V0cHV0OiBbXSxcbiAgICAgIG9ic2VydmFiaWxpdHlJbXBhY3Q6IFwiXCIsXG4gICAgfSxcbiAgICBzZXF1ZW5jZTogMCxcbiAgfSk7XG5cbiAgaW5zZXJ0VGFzayh7XG4gICAgaWQ6IFwiVDAyXCIsXG4gICAgc2xpY2VJZDogXCJTMDFcIixcbiAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgdGl0bGU6IFwiVGFzayAyIHdpdGggbWlzbWF0Y2hlZCBzaWduYXR1cmVcIixcbiAgICBzdGF0dXM6IFwicGVuZGluZ1wiLFxuICAgIHBsYW5uaW5nOiB7XG4gICAgICBkZXNjcmlwdGlvbjogYFxuXFxgXFxgXFxgdHlwZXNjcmlwdFxuZnVuY3Rpb24gcHJvY2Vzc0RhdGEoaW5wdXQ6IG51bWJlcik6IHN0cmluZ1xuXFxgXFxgXFxgXG4gICAgICBgLnRyaW0oKSxcbiAgICAgIGVzdGltYXRlOiBcIjFoXCIsXG4gICAgICBmaWxlczogW10sXG4gICAgICB2ZXJpZnk6IFwibnBtIHRlc3RcIixcbiAgICAgIGlucHV0czogW10sXG4gICAgICBleHBlY3RlZE91dHB1dDogW10sXG4gICAgICBvYnNlcnZhYmlsaXR5SW1wYWN0OiBcIlwiLFxuICAgIH0sXG4gICAgc2VxdWVuY2U6IDEsXG4gIH0pO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiUHJlLWV4ZWN1dGlvbiBjaGVja3MgXHUyMTkyIHBhdXNlQXV0byB3aXJpbmdcIiwgKCkgPT4ge1xuICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICBzZXR1cFRlc3RFbnZpcm9ubWVudCgpO1xuICB9KTtcblxuICBhZnRlckVhY2goKCkgPT4ge1xuICAgIGNsZWFudXBUZXN0RW52aXJvbm1lbnQoKTtcbiAgfSk7XG5cbiAgdGVzdChcInBhdXNlQXV0byBpcyBjYWxsZWQgd2hlbiBwcmUtZXhlY3V0aW9uIGNoZWNrcyByZXR1cm4gc3RhdHVzOiBmYWlsIHdpdGggYmxvY2tpbmc6IHRydWVcIiwgYXN5bmMgKCkgPT4ge1xuICAgIC8vIFNldCB1cCB0YXNrcyB0aGF0IHdpbGwgY2F1c2UgYSBibG9ja2luZyBmYWlsdXJlXG4gICAgY3JlYXRlRmFpbGluZ1Rhc2tzKCk7XG5cbiAgICAvLyBDcmVhdGUgbW9ja3NcbiAgICBjb25zdCBjdHggPSBtYWtlTW9ja0N0eCgpO1xuICAgIGNvbnN0IHBpID0gbWFrZU1vY2tQaSgpO1xuICAgIGNvbnN0IHBhdXNlQXV0b01vY2sgPSBtb2NrLmZuKGFzeW5jICgpID0+IHt9KTtcbiAgICBjb25zdCBzID0gbWFrZU1vY2tTZXNzaW9uKHRlbXBEaXIsIHsgdHlwZTogXCJwbGFuLXNsaWNlXCIsIGlkOiBcIk0wMDEvUzAxXCIgfSk7XG4gICAgY29uc3QgcGN0eCA9IG1ha2VQb3N0VW5pdENvbnRleHQocywgY3R4LCBwaSwgcGF1c2VBdXRvTW9jayk7XG5cbiAgICAvLyBDYWxsIHBvc3RVbml0UG9zdFZlcmlmaWNhdGlvblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHBvc3RVbml0UG9zdFZlcmlmaWNhdGlvbihwY3R4KTtcblxuICAgIC8vIFZlcmlmeSBwYXVzZUF1dG8gd2FzIGNhbGxlZFxuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIHBhdXNlQXV0b01vY2subW9jay5jYWxsQ291bnQoKSxcbiAgICAgIDEsXG4gICAgICBcInBhdXNlQXV0byBzaG91bGQgYmUgY2FsbGVkIGV4YWN0bHkgb25jZSB3aGVuIHByZS1leGVjdXRpb24gY2hlY2tzIGZhaWwgd2l0aCBibG9ja2luZyBpc3N1ZXNcIlxuICAgICk7XG5cbiAgICAvLyBWZXJpZnkgcmV0dXJuIHZhbHVlIGlzIFwic3RvcHBlZFwiXG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgcmVzdWx0LFxuICAgICAgXCJzdG9wcGVkXCIsXG4gICAgICBcInBvc3RVbml0UG9zdFZlcmlmaWNhdGlvbiBzaG91bGQgcmV0dXJuICdzdG9wcGVkJyB3aGVuIHByZS1leGVjdXRpb24gY2hlY2tzIGZhaWxcIlxuICAgICk7XG5cbiAgICAvLyBWZXJpZnkgVUkgd2FzIG5vdGlmaWVkIG9mIHRoZSBmYWlsdXJlXG4gICAgY29uc3Qgbm90aWZ5Q2FsbHMgPSBjdHgudWkubm90aWZ5Lm1vY2suY2FsbHM7XG4gICAgY29uc3QgZXJyb3JOb3RpZnkgPSBub3RpZnlDYWxscy5maW5kKFxuICAgICAgKGNhbGw6IHsgYXJndW1lbnRzOiB1bmtub3duW10gfSkgPT5cbiAgICAgICAgY2FsbC5hcmd1bWVudHNbMV0gPT09IFwiZXJyb3JcIiAmJlxuICAgICAgICBTdHJpbmcoY2FsbC5hcmd1bWVudHNbMF0pLmluY2x1ZGVzKFwiUHJlLWV4ZWN1dGlvbiBjaGVja3MgZmFpbGVkXCIpXG4gICAgKTtcbiAgICBhc3NlcnQub2soZXJyb3JOb3RpZnksIFwiU2hvdWxkIHNob3cgZXJyb3Igbm90aWZpY2F0aW9uIGFib3V0IHByZS1leGVjdXRpb24gY2hlY2sgZmFpbHVyZVwiKTtcbiAgICBjb25zdCBlcnJvck1lc3NhZ2UgPSBTdHJpbmcoZXJyb3JOb3RpZnkuYXJndW1lbnRzWzBdKTtcbiAgICBhc3NlcnQubWF0Y2goXG4gICAgICBlcnJvck1lc3NhZ2UsXG4gICAgICAvUHJlLWV4ZWN1dGlvbiBjaGVja3MgZmFpbGVkOiBcXGQrIGJsb2NraW5nIGlzc3VlLyxcbiAgICAgIFwiZmFpbHVyZSBub3RpZmljYXRpb24gc2hvdWxkIGluY2x1ZGUgdGhlIGJsb2NraW5nIGlzc3VlIGNvdW50XCIsXG4gICAgKTtcbiAgICBhc3NlcnQub2soXG4gICAgICBlcnJvck1lc3NhZ2UuaW5jbHVkZXMoXCJbZmlsZV0gbm9uZXhpc3RlbnQtZmlsZS10aGF0LWRvZXMtbm90LWV4aXN0LnRzOiBUYXNrIFQwMSByZWZlcmVuY2VzXCIpLFxuICAgICAgXCJmYWlsdXJlIG5vdGlmaWNhdGlvbiBzaG91bGQgaW5jbHVkZSBjYXRlZ29yeSwgdGFyZ2V0LCBhbmQgbWVzc2FnZSBkZXRhaWxzXCIsXG4gICAgKTtcbiAgICBhc3NlcnQub2soXG4gICAgICBlcnJvck1lc3NhZ2UuaW5jbHVkZXMoXCJbZmlsZV0gbWlzc2luZy10aGlyZC1maWxlLnRzOiBUYXNrIFQwMSByZWZlcmVuY2VzXCIpLFxuICAgICAgXCJmYWlsdXJlIG5vdGlmaWNhdGlvbiBzaG91bGQgaW5jbHVkZSB1cCB0byB0aHJlZSBhY3Rpb25hYmxlIGNoZWNrIGRldGFpbHNcIixcbiAgICApO1xuICAgIGFzc2VydC5vayhcbiAgICAgICFlcnJvck1lc3NhZ2UuaW5jbHVkZXMoXCJtaXNzaW5nLWZvdXJ0aC1maWxlLnRzXCIpLFxuICAgICAgXCJmYWlsdXJlIG5vdGlmaWNhdGlvbiBzaG91bGQgdHJ1bmNhdGUgZGV0YWlscyBiZXlvbmQgdGhlIGRpc3BsYXkgbGltaXRcIixcbiAgICApO1xuICAgIGFzc2VydC5vayhcbiAgICAgIGVycm9yTWVzc2FnZS5pbmNsdWRlcyhcIi4uLmFuZCAxIG1vcmVcIiksXG4gICAgICBcImZhaWx1cmUgbm90aWZpY2F0aW9uIHNob3VsZCBzdW1tYXJpemUgdHJ1bmNhdGVkIGJsb2NraW5nIGNoZWNrc1wiLFxuICAgICk7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgZXJyb3JNZXNzYWdlLmluY2x1ZGVzKGpvaW4oXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIiwgXCJTMDEtUFJFLUVYRUMtVkVSSUZZLmpzb25cIikpLFxuICAgICAgXCJmYWlsdXJlIG5vdGlmaWNhdGlvbiBzaG91bGQgcG9pbnQgdG8gdGhlIHJlbGF0aXZlIHByZS1leGVjIGV2aWRlbmNlIGZpbGUgcGF0aFwiLFxuICAgICk7XG4gIH0pO1xuXG4gIHRlc3QoXCJwYXVzZUF1dG8gaXMgY2FsbGVkIHdoZW4gZW5oYW5jZWRfdmVyaWZpY2F0aW9uX3N0cmljdDogdHJ1ZSBhbmQgcHJlLWV4ZWN1dGlvbiByZXR1cm5zIHdhcm5cIiwgYXN5bmMgKCkgPT4ge1xuICAgIC8vIFdyaXRlIHByZWZlcmVuY2VzIHdpdGggc3RyaWN0IG1vZGUgZW5hYmxlZFxuICAgIHdyaXRlUHJlZmVyZW5jZXMoe1xuICAgICAgZW5oYW5jZWRfdmVyaWZpY2F0aW9uOiB0cnVlLFxuICAgICAgZW5oYW5jZWRfdmVyaWZpY2F0aW9uX3ByZTogdHJ1ZSxcbiAgICAgIGVuaGFuY2VkX3ZlcmlmaWNhdGlvbl9zdHJpY3Q6IHRydWUsXG4gICAgfSk7XG5cbiAgICAvLyBTZXQgdXAgdGFza3MgdGhhdCB3aWxsIHByb2R1Y2Ugb25seSB3YXJuaW5ncyAoaW50ZXJmYWNlIGNvbnRyYWN0IG1pc21hdGNoKVxuICAgIGNyZWF0ZVdhcm5pbmdPbmx5VGFza3MoKTtcblxuICAgIC8vIENyZWF0ZSBtb2Nrc1xuICAgIGNvbnN0IGN0eCA9IG1ha2VNb2NrQ3R4KCk7XG4gICAgY29uc3QgcGkgPSBtYWtlTW9ja1BpKCk7XG4gICAgY29uc3QgcGF1c2VBdXRvTW9jayA9IG1vY2suZm4oYXN5bmMgKCkgPT4ge30pO1xuICAgIGNvbnN0IHMgPSBtYWtlTW9ja1Nlc3Npb24odGVtcERpciwgeyB0eXBlOiBcInBsYW4tc2xpY2VcIiwgaWQ6IFwiTTAwMS9TMDFcIiB9KTtcbiAgICBjb25zdCBwY3R4ID0gbWFrZVBvc3RVbml0Q29udGV4dChzLCBjdHgsIHBpLCBwYXVzZUF1dG9Nb2NrKTtcblxuICAgIC8vIENhbGwgcG9zdFVuaXRQb3N0VmVyaWZpY2F0aW9uXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcG9zdFVuaXRQb3N0VmVyaWZpY2F0aW9uKHBjdHgpO1xuXG4gICAgLy8gVmVyaWZ5IHBhdXNlQXV0byB3YXMgY2FsbGVkIChzdHJpY3QgbW9kZSBwcm9tb3RlcyB3YXJuaW5ncyB0byBibG9ja2luZylcbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICBwYXVzZUF1dG9Nb2NrLm1vY2suY2FsbENvdW50KCksXG4gICAgICAxLFxuICAgICAgXCJwYXVzZUF1dG8gc2hvdWxkIGJlIGNhbGxlZCB3aGVuIHN0cmljdCBtb2RlIGlzIGVuYWJsZWQgYW5kIHByZS1leGVjdXRpb24gcmV0dXJucyB3YXJuXCJcbiAgICApO1xuXG4gICAgLy8gVmVyaWZ5IHJldHVybiB2YWx1ZSBpcyBcInN0b3BwZWRcIlxuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIHJlc3VsdCxcbiAgICAgIFwic3RvcHBlZFwiLFxuICAgICAgXCJwb3N0VW5pdFBvc3RWZXJpZmljYXRpb24gc2hvdWxkIHJldHVybiAnc3RvcHBlZCcgd2hlbiBzdHJpY3QgbW9kZSB0cmVhdHMgd2FybmluZ3MgYXMgYmxvY2tpbmdcIlxuICAgICk7XG5cbiAgICAvLyBWZXJpZnkgVUkgd2FzIG5vdGlmaWVkIG9mIHRoZSB3YXJuaW5nXG4gICAgY29uc3Qgbm90aWZ5Q2FsbHMgPSBjdHgudWkubm90aWZ5Lm1vY2suY2FsbHM7XG4gICAgY29uc3Qgd2Fybk5vdGlmeSA9IG5vdGlmeUNhbGxzLmZpbmQoXG4gICAgICAoY2FsbDogeyBhcmd1bWVudHM6IHVua25vd25bXSB9KSA9PlxuICAgICAgICBjYWxsLmFyZ3VtZW50c1sxXSA9PT0gXCJ3YXJuaW5nXCIgJiZcbiAgICAgICAgU3RyaW5nKGNhbGwuYXJndW1lbnRzWzBdKS5pbmNsdWRlcyhcIlByZS1leGVjdXRpb24gY2hlY2tzIHBhc3NlZCB3aXRoIHdhcm5pbmdzXCIpXG4gICAgKTtcbiAgICBhc3NlcnQub2sod2Fybk5vdGlmeSwgXCJTaG91bGQgc2hvdyB3YXJuaW5nIG5vdGlmaWNhdGlvbiBhYm91dCBwcmUtZXhlY3V0aW9uIGNoZWNrIHdhcm5pbmdzXCIpO1xuICB9KTtcblxuICB0ZXN0KFwicGF1c2VBdXRvIGlzIE5PVCBjYWxsZWQgd2hlbiBlbmhhbmNlZF92ZXJpZmljYXRpb25fc3RyaWN0OiBmYWxzZSBhbmQgcHJlLWV4ZWN1dGlvbiByZXR1cm5zIHdhcm5cIiwgYXN5bmMgKCkgPT4ge1xuICAgIC8vIFdyaXRlIHByZWZlcmVuY2VzIHdpdGggc3RyaWN0IG1vZGUgZGlzYWJsZWQgKGRlZmF1bHQgYmVoYXZpb3IpXG4gICAgd3JpdGVQcmVmZXJlbmNlcyh7XG4gICAgICBlbmhhbmNlZF92ZXJpZmljYXRpb246IHRydWUsXG4gICAgICBlbmhhbmNlZF92ZXJpZmljYXRpb25fcHJlOiB0cnVlLFxuICAgICAgZW5oYW5jZWRfdmVyaWZpY2F0aW9uX3N0cmljdDogZmFsc2UsXG4gICAgfSk7XG5cbiAgICAvLyBTZXQgdXAgdGFza3MgdGhhdCB3aWxsIHByb2R1Y2Ugb25seSB3YXJuaW5nc1xuICAgIGNyZWF0ZVdhcm5pbmdPbmx5VGFza3MoKTtcblxuICAgIC8vIENyZWF0ZSBtb2Nrc1xuICAgIGNvbnN0IGN0eCA9IG1ha2VNb2NrQ3R4KCk7XG4gICAgY29uc3QgcGkgPSBtYWtlTW9ja1BpKCk7XG4gICAgY29uc3QgcGF1c2VBdXRvTW9jayA9IG1vY2suZm4oYXN5bmMgKCkgPT4ge30pO1xuICAgIGNvbnN0IHMgPSBtYWtlTW9ja1Nlc3Npb24odGVtcERpciwgeyB0eXBlOiBcInBsYW4tc2xpY2VcIiwgaWQ6IFwiTTAwMS9TMDFcIiB9KTtcbiAgICBjb25zdCBwY3R4ID0gbWFrZVBvc3RVbml0Q29udGV4dChzLCBjdHgsIHBpLCBwYXVzZUF1dG9Nb2NrKTtcblxuICAgIC8vIENhbGwgcG9zdFVuaXRQb3N0VmVyaWZpY2F0aW9uXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcG9zdFVuaXRQb3N0VmVyaWZpY2F0aW9uKHBjdHgpO1xuXG4gICAgLy8gVmVyaWZ5IHBhdXNlQXV0byB3YXMgTk9UIGNhbGxlZCAod2FybmluZ3MgZG9uJ3QgYmxvY2sgaW4gbm9uLXN0cmljdCBtb2RlKVxuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIHBhdXNlQXV0b01vY2subW9jay5jYWxsQ291bnQoKSxcbiAgICAgIDAsXG4gICAgICBcInBhdXNlQXV0byBzaG91bGQgTk9UIGJlIGNhbGxlZCB3aGVuIHN0cmljdCBtb2RlIGlzIGRpc2FibGVkIGFuZCBvbmx5IHdhcm5pbmdzIGV4aXN0XCJcbiAgICApO1xuXG4gICAgLy8gVmVyaWZ5IHJldHVybiB2YWx1ZSBpcyBcImNvbnRpbnVlXCIgKG5vdCBcInN0b3BwZWRcIilcbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICByZXN1bHQsXG4gICAgICBcImNvbnRpbnVlXCIsXG4gICAgICBcInBvc3RVbml0UG9zdFZlcmlmaWNhdGlvbiBzaG91bGQgcmV0dXJuICdjb250aW51ZScgd2hlbiB3YXJuaW5ncyBkb24ndCBibG9jayBpbiBub24tc3RyaWN0IG1vZGVcIlxuICAgICk7XG4gIH0pO1xuXG4gIHRlc3QoXCJwcmUtZXhlY3V0aW9uIGNoZWNrcyBhcmUgc2tpcHBlZCB3aGVuIHVuaXQgdHlwZSBpcyBub3QgcGxhbi1zbGljZVwiLCBhc3luYyAoKSA9PiB7XG4gICAgLy8gU2V0IHVwIHRhc2tzIHRoYXQgd291bGQgZmFpbCBpZiBjaGVja2VkXG4gICAgY3JlYXRlRmFpbGluZ1Rhc2tzKCk7XG5cbiAgICAvLyBDcmVhdGUgbW9ja3Mgd2l0aCBleGVjdXRlLXRhc2sgdW5pdCAobm90IHBsYW4tc2xpY2UpXG4gICAgY29uc3QgY3R4ID0gbWFrZU1vY2tDdHgoKTtcbiAgICBjb25zdCBwaSA9IG1ha2VNb2NrUGkoKTtcbiAgICBjb25zdCBwYXVzZUF1dG9Nb2NrID0gbW9jay5mbihhc3luYyAoKSA9PiB7fSk7XG4gICAgY29uc3QgcyA9IG1ha2VNb2NrU2Vzc2lvbih0ZW1wRGlyLCB7IHR5cGU6IFwiZXhlY3V0ZS10YXNrXCIsIGlkOiBcIk0wMDEvUzAxL1QwMVwiIH0pO1xuICAgIGNvbnN0IHBjdHggPSBtYWtlUG9zdFVuaXRDb250ZXh0KHMsIGN0eCwgcGksIHBhdXNlQXV0b01vY2spO1xuXG4gICAgLy8gQ2FsbCBwb3N0VW5pdFBvc3RWZXJpZmljYXRpb25cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBwb3N0VW5pdFBvc3RWZXJpZmljYXRpb24ocGN0eCk7XG5cbiAgICAvLyBWZXJpZnkgcGF1c2VBdXRvIHdhcyBOT1QgY2FsbGVkIChwcmUtZXhlY3V0aW9uIGNoZWNrcyBvbmx5IHJ1biBmb3IgcGxhbi1zbGljZSlcbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICBwYXVzZUF1dG9Nb2NrLm1vY2suY2FsbENvdW50KCksXG4gICAgICAwLFxuICAgICAgXCJwYXVzZUF1dG8gc2hvdWxkIE5PVCBiZSBjYWxsZWQgZm9yIG5vbi1wbGFuLXNsaWNlIHVuaXQgdHlwZXNcIlxuICAgICk7XG5cbiAgICAvLyBWZXJpZnkgcmV0dXJuIHZhbHVlIGlzIFwiY29udGludWVcIlxuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIHJlc3VsdCxcbiAgICAgIFwiY29udGludWVcIixcbiAgICAgIFwicG9zdFVuaXRQb3N0VmVyaWZpY2F0aW9uIHNob3VsZCByZXR1cm4gJ2NvbnRpbnVlJyBmb3Igbm9uLXBsYW4tc2xpY2UgdW5pdCB0eXBlc1wiXG4gICAgKTtcbiAgfSk7XG5cbiAgdGVzdChcInByZS1leGVjdXRpb24gY2hlY2tzIGFyZSBza2lwcGVkIHdoZW4gZW5oYW5jZWRfdmVyaWZpY2F0aW9uX3ByZTogZmFsc2VcIiwgYXN5bmMgKCkgPT4ge1xuICAgIC8vIFdyaXRlIHByZWZlcmVuY2VzIHdpdGggcHJlLWV4ZWN1dGlvbiBjaGVja3MgZGlzYWJsZWRcbiAgICB3cml0ZVByZWZlcmVuY2VzKHtcbiAgICAgIGVuaGFuY2VkX3ZlcmlmaWNhdGlvbjogdHJ1ZSxcbiAgICAgIGVuaGFuY2VkX3ZlcmlmaWNhdGlvbl9wcmU6IGZhbHNlLFxuICAgIH0pO1xuXG4gICAgLy8gU2V0IHVwIHRhc2tzIHRoYXQgd291bGQgZmFpbCBpZiBjaGVja2VkXG4gICAgY3JlYXRlRmFpbGluZ1Rhc2tzKCk7XG5cbiAgICAvLyBDcmVhdGUgbW9ja3NcbiAgICBjb25zdCBjdHggPSBtYWtlTW9ja0N0eCgpO1xuICAgIGNvbnN0IHBpID0gbWFrZU1vY2tQaSgpO1xuICAgIGNvbnN0IHBhdXNlQXV0b01vY2sgPSBtb2NrLmZuKGFzeW5jICgpID0+IHt9KTtcbiAgICBjb25zdCBzID0gbWFrZU1vY2tTZXNzaW9uKHRlbXBEaXIsIHsgdHlwZTogXCJwbGFuLXNsaWNlXCIsIGlkOiBcIk0wMDEvUzAxXCIgfSk7XG4gICAgY29uc3QgcGN0eCA9IG1ha2VQb3N0VW5pdENvbnRleHQocywgY3R4LCBwaSwgcGF1c2VBdXRvTW9jayk7XG5cbiAgICAvLyBDYWxsIHBvc3RVbml0UG9zdFZlcmlmaWNhdGlvblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHBvc3RVbml0UG9zdFZlcmlmaWNhdGlvbihwY3R4KTtcblxuICAgIC8vIFZlcmlmeSBwYXVzZUF1dG8gd2FzIE5PVCBjYWxsZWQgKHByZS1leGVjdXRpb24gY2hlY2tzIGRpc2FibGVkKVxuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIHBhdXNlQXV0b01vY2subW9jay5jYWxsQ291bnQoKSxcbiAgICAgIDAsXG4gICAgICBcInBhdXNlQXV0byBzaG91bGQgTk9UIGJlIGNhbGxlZCB3aGVuIGVuaGFuY2VkX3ZlcmlmaWNhdGlvbl9wcmUgaXMgZGlzYWJsZWRcIlxuICAgICk7XG5cbiAgICAvLyBWZXJpZnkgcmV0dXJuIHZhbHVlIGlzIFwiY29udGludWVcIlxuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIHJlc3VsdCxcbiAgICAgIFwiY29udGludWVcIixcbiAgICAgIFwicG9zdFVuaXRQb3N0VmVyaWZpY2F0aW9uIHNob3VsZCByZXR1cm4gJ2NvbnRpbnVlJyB3aGVuIHByZS1leGVjdXRpb24gY2hlY2tzIGFyZSBkaXNhYmxlZFwiXG4gICAgKTtcbiAgfSk7XG5cbiAgdGVzdChcImZpbGVzIHByZXNlbnQgaW4gcy5iYXNlUGF0aCAod29ya3RyZWUpIGJ1dCBhYnNlbnQgZnJvbSBjYW5vbmljYWxQcm9qZWN0Um9vdCBkbyBub3QgYmxvY2tcIiwgYXN5bmMgKCkgPT4ge1xuICAgIHdyaXRlUHJlZmVyZW5jZXMoe1xuICAgICAgZW5oYW5jZWRfdmVyaWZpY2F0aW9uOiB0cnVlLFxuICAgICAgZW5oYW5jZWRfdmVyaWZpY2F0aW9uX3ByZTogdHJ1ZSxcbiAgICAgIGVuaGFuY2VkX3ZlcmlmaWNhdGlvbl9zdHJpY3Q6IGZhbHNlLFxuICAgIH0pO1xuXG4gICAgLy8gUmVncmVzc2lvbjogcHJlLWV4ZWMgY2hlY2tzIHVzZWQgY2Fub25pY2FsUHJvamVjdFJvb3QgKHByb2plY3Qgcm9vdCksIHNvXG4gICAgLy8gZmlsZXMgdGhhdCBhIHByaW9yIHNsaWNlIGNyZWF0ZWQgaW4gdGhlIHdvcmt0cmVlIHdlcmUgZmFsc2VseSBmbGFnZ2VkIGFzXG4gICAgLy8gbWlzc2luZyBiZWNhdXNlIHRoZXkgaGFkbid0IG1lcmdlZCB0byBtYWluIHlldC4gRml4OiB1c2Ugcy5iYXNlUGF0aC5cblxuICAgIC8vIENyZWF0ZSBhIHNlcGFyYXRlIFwid29ya3RyZWVcIiBkaXJlY3Rvcnkgd2l0aCB0aGUgcmVmZXJlbmNlZCBmaWxlcyBwcmVzZW50LlxuICAgIGNvbnN0IHdvcmt0cmVlRGlyID0gam9pbih0ZW1wRGlyLCBcIndvcmt0cmVlXCIpO1xuICAgIG1rZGlyU3luYyhqb2luKHdvcmt0cmVlRGlyLCBcImxpYlwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgbWtkaXJTeW5jKGpvaW4od29ya3RyZWVEaXIsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIsIFwidGFza3NcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbih3b3JrdHJlZURpciwgXCJsaWJcIiwgXCJ0eXBlcy50c1wiKSwgXCJleHBvcnQgdHlwZSBIYWJpdCA9IHsgaWQ6IHN0cmluZzsgbmFtZTogc3RyaW5nOyB9O1wiKTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4od29ya3RyZWVEaXIsIFwibGliXCIsIFwidXNlTG9jYWxTdG9yYWdlLnRzXCIpLCBcImV4cG9ydCBmdW5jdGlvbiB1c2VMb2NhbFN0b3JhZ2UoKSB7fVwiKTtcblxuICAgIC8vIFRoZSBEQiBsaXZlcyB1bmRlciB0ZW1wRGlyICh0aGUgXCJwcm9qZWN0IHJvb3RcIikuIEluc2VydCBzbGljZSArIHRhc2tzLlxuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiB9KTtcbiAgICBpbnNlcnRTbGljZSh7IGlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3QgU2xpY2VcIiwgcmlzazogXCJsb3dcIiB9KTtcbiAgICBpbnNlcnRUYXNrKHtcbiAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgc2xpY2VJZDogXCJTMDFcIixcbiAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICAgIHRpdGxlOiBcIlRhc2sgdGhhdCByZWFkcyBwcmlvci1zbGljZSBmaWxlc1wiLFxuICAgICAgc3RhdHVzOiBcInBlbmRpbmdcIixcbiAgICAgIHBsYW5uaW5nOiB7XG4gICAgICAgIGRlc2NyaXB0aW9uOiBcIlJlYWRzIGxpYi90eXBlcy50cyBhbmQgbGliL3VzZUxvY2FsU3RvcmFnZS50cyBmcm9tIHByaW9yIHNsaWNlXCIsXG4gICAgICAgIGVzdGltYXRlOiBcIjFoXCIsXG4gICAgICAgIGZpbGVzOiBbXSxcbiAgICAgICAgdmVyaWZ5OiBcIm5wbSB0ZXN0XCIsXG4gICAgICAgIGlucHV0czogW1wibGliL3R5cGVzLnRzXCIsIFwibGliL3VzZUxvY2FsU3RvcmFnZS50c1wiXSxcbiAgICAgICAgZXhwZWN0ZWRPdXRwdXQ6IFtcImxpYi91dGlscy50c1wiXSxcbiAgICAgICAgb2JzZXJ2YWJpbGl0eUltcGFjdDogXCJcIixcbiAgICAgIH0sXG4gICAgICBzZXF1ZW5jZTogMCxcbiAgICB9KTtcblxuICAgIGNvbnN0IGN0eCA9IG1ha2VNb2NrQ3R4KCk7XG4gICAgY29uc3QgcGkgPSBtYWtlTW9ja1BpKCk7XG4gICAgY29uc3QgcGF1c2VBdXRvTW9jayA9IG1vY2suZm4oYXN5bmMgKCkgPT4ge30pO1xuXG4gICAgLy8gcy5iYXNlUGF0aCA9IHdvcmt0cmVlRGlyIChmaWxlcyBleGlzdCBoZXJlKVxuICAgIC8vIE92ZXJyaWRlIGNhbm9uaWNhbFByb2plY3RSb290IFx1MjE5MiB0ZW1wRGlyIChmaWxlcyBkbyBOT1QgZXhpc3QgdGhlcmUpXG4gICAgY29uc3QgcyA9IG1ha2VNb2NrU2Vzc2lvbih3b3JrdHJlZURpciwgeyB0eXBlOiBcInBsYW4tc2xpY2VcIiwgaWQ6IFwiTTAwMS9TMDFcIiB9KTtcbiAgICBPYmplY3QuZGVmaW5lUHJvcGVydHkocywgXCJjYW5vbmljYWxQcm9qZWN0Um9vdFwiLCB7IGdldDogKCkgPT4gdGVtcERpciB9KTtcblxuICAgIGNvbnN0IHBjdHggPSBtYWtlUG9zdFVuaXRDb250ZXh0KHMsIGN0eCwgcGksIHBhdXNlQXV0b01vY2spO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHBvc3RVbml0UG9zdFZlcmlmaWNhdGlvbihwY3R4KTtcblxuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIHBhdXNlQXV0b01vY2subW9jay5jYWxsQ291bnQoKSxcbiAgICAgIDAsXG4gICAgICBcInBhdXNlQXV0byBzaG91bGQgTk9UIGJlIGNhbGxlZCB3aGVuIHJlZmVyZW5jZWQgZmlsZXMgZXhpc3QgaW4gcy5iYXNlUGF0aCAod29ya3RyZWUpXCIsXG4gICAgKTtcbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICByZXN1bHQsXG4gICAgICBcImNvbnRpbnVlXCIsXG4gICAgICBcInBvc3RVbml0UG9zdFZlcmlmaWNhdGlvbiBzaG91bGQgcmV0dXJuICdjb250aW51ZScgd2hlbiB3b3JrdHJlZSBmaWxlcyBzYXRpc2Z5IHByZS1leGVjIGlucHV0c1wiLFxuICAgICk7XG4gIH0pO1xuXG4gIHRlc3QoXCJ1b2sgZ2F0ZSBydW5uZXIgcGVyc2lzdHMgcHJlLWV4ZWN1dGlvbiBnYXRlIG91dGNvbWVzIHdoZW4gZW5hYmxlZFwiLCBhc3luYyAoKSA9PiB7XG4gICAgd3JpdGVQcmVmZXJlbmNlcyh7XG4gICAgICBlbmhhbmNlZF92ZXJpZmljYXRpb246IHRydWUsXG4gICAgICBlbmhhbmNlZF92ZXJpZmljYXRpb25fcHJlOiB0cnVlLFxuICAgICAgZW5oYW5jZWRfdmVyaWZpY2F0aW9uX3N0cmljdDogdHJ1ZSxcbiAgICAgIHVvazoge1xuICAgICAgICBlbmFibGVkOiB0cnVlLFxuICAgICAgICBnYXRlczogeyBlbmFibGVkOiB0cnVlIH0sXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgY3JlYXRlRmFpbGluZ1Rhc2tzKCk7XG5cbiAgICBjb25zdCBjdHggPSBtYWtlTW9ja0N0eCgpO1xuICAgIGNvbnN0IHBpID0gbWFrZU1vY2tQaSgpO1xuICAgIGNvbnN0IHBhdXNlQXV0b01vY2sgPSBtb2NrLmZuKGFzeW5jICgpID0+IHt9KTtcbiAgICBjb25zdCBzID0gbWFrZU1vY2tTZXNzaW9uKHRlbXBEaXIsIHsgdHlwZTogXCJwbGFuLXNsaWNlXCIsIGlkOiBcIk0wMDEvUzAxXCIgfSk7XG4gICAgY29uc3QgcGN0eCA9IG1ha2VQb3N0VW5pdENvbnRleHQocywgY3R4LCBwaSwgcGF1c2VBdXRvTW9jayk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBwb3N0VW5pdFBvc3RWZXJpZmljYXRpb24ocGN0eCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgXCJzdG9wcGVkXCIpO1xuXG4gICAgY29uc3QgYWRhcHRlciA9IF9nZXRBZGFwdGVyKCk7XG4gICAgY29uc3Qgcm93ID0gYWRhcHRlclxuICAgICAgPy5wcmVwYXJlKFxuICAgICAgICBgU0VMRUNUIGdhdGVfaWQsIG91dGNvbWUsIGZhaWx1cmVfY2xhc3NcbiAgICAgICAgIEZST00gZ2F0ZV9ydW5zXG4gICAgICAgICBXSEVSRSBnYXRlX2lkID0gJ3ByZS1leGVjdXRpb24tY2hlY2tzJ1xuICAgICAgICAgT1JERVIgQlkgaWQgREVTQ1xuICAgICAgICAgTElNSVQgMWAsXG4gICAgICApXG4gICAgICAuZ2V0KCkgYXMgeyBnYXRlX2lkOiBzdHJpbmc7IG91dGNvbWU6IHN0cmluZzsgZmFpbHVyZV9jbGFzczogc3RyaW5nIH0gfCB1bmRlZmluZWQ7XG5cbiAgICBhc3NlcnQub2socm93LCBcInByZS1leGVjdXRpb24gZ2F0ZSBydW4gc2hvdWxkIGJlIHBlcnNpc3RlZCB3aGVuIHVvay5nYXRlcyBpcyBlbmFibGVkXCIpO1xuICAgIGFzc2VydC5lcXVhbChyb3c/LmdhdGVfaWQsIFwicHJlLWV4ZWN1dGlvbi1jaGVja3NcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJvdz8ub3V0Y29tZSwgXCJmYWlsXCIpO1xuICAgIGFzc2VydC5lcXVhbChyb3c/LmZhaWx1cmVfY2xhc3MsIFwiaW5wdXRcIik7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAi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
