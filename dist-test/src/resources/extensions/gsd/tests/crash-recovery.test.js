import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  writeLock,
  clearLock,
  readCrashLock,
  isLockProcessAlive,
  formatCrashInfo
} from "../crash-recovery.js";
import {
  assessInterruptedSession,
  hasResumableDerivedState,
  isBootstrapCrashLock,
  readPausedSessionMetadata,
  PAUSED_SESSION_KV_KEY
} from "../interrupted-session.js";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  _getAdapter
} from "../gsd-db.js";
import { registerAutoWorker } from "../db/auto-workers.js";
import { claimMilestoneLease } from "../db/milestone-leases.js";
import { recordDispatchClaim } from "../db/unit-dispatches.js";
import { setRuntimeKv } from "../db/runtime-kv.js";
import { normalizeRealPath } from "../paths.js";
import { _synthesizePausedSessionRecoveryForTest } from "../auto.js";
function makeTmpBase() {
  const base = join(tmpdir(), `gsd-test-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  return base;
}
function cleanup(base) {
  try {
    closeDatabase();
  } catch {
  }
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
  }
}
function writeTestLock(base, unitType, unitId, sessionFile) {
  const projectRoot = normalizeRealPath(base);
  const workerId = `test-fake-${randomUUID().slice(0, 8)}`;
  const fakePid = 999999999;
  const stalePast = "1970-01-01T00:00:00.000Z";
  const db = _getAdapter();
  db.prepare(
    `INSERT INTO workers (
      worker_id, host, pid, started_at, version,
      last_heartbeat_at, status, project_root_realpath
    ) VALUES (
      :w, 'test-host', :pid, :started_at, 'test',
      :stale, 'active', :project_root
    )`
  ).run({
    ":w": workerId,
    ":pid": fakePid,
    ":started_at": (/* @__PURE__ */ new Date()).toISOString(),
    ":stale": stalePast,
    ":project_root": projectRoot
  });
  const midMatch = unitId.match(/^(M\d+)/);
  if (midMatch && unitType !== "starting") {
    const mid = midMatch[1];
    try {
      insertMilestone({ id: mid, title: `Test ${mid}`, status: "active" });
    } catch {
    }
    try {
      const lease = claimMilestoneLease(workerId, mid);
      recordDispatchClaim({
        traceId: randomUUID(),
        workerId,
        milestoneLeaseToken: lease.ok ? lease.token : 0,
        milestoneId: mid,
        unitType,
        unitId
      });
    } catch {
    }
  }
  if (sessionFile) {
    setRuntimeKv("worker", workerId, "session_file", sessionFile);
  }
}
function writeRoadmap(base, checked = false) {
  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(join(milestoneDir, "slices", "S01", "tasks"), { recursive: true });
  writeFileSync(
    join(milestoneDir, "M001-ROADMAP.md"),
    [
      "# M001: Test Milestone",
      "",
      "## Vision",
      "",
      "Test milestone.",
      "",
      "## Success Criteria",
      "",
      "- It works.",
      "",
      "## Slices",
      "",
      `- [${checked ? "x" : " "}] **S01: Test slice** \`risk:low\``,
      "  After this: Demo",
      "",
      "## Boundary Map",
      "",
      "- S01 \u2192 terminal",
      "  - Produces: done",
      "  - Consumes: nothing"
    ].join("\n"),
    "utf-8"
  );
  const status = checked ? "complete" : "active";
  const adapter = _getAdapter();
  if (adapter) {
    adapter.prepare(
      `INSERT INTO milestones (id, title, status, created_at)
       VALUES (:id, :title, :status, :now)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, title = excluded.title`
    ).run({ ":id": "M001", ":title": "Test Milestone", ":status": status, ":now": (/* @__PURE__ */ new Date()).toISOString() });
    adapter.prepare(
      `INSERT INTO slices (milestone_id, id, title, status, created_at)
       VALUES (:mid, :sid, :title, :status, :now)
       ON CONFLICT(milestone_id, id) DO UPDATE SET status = excluded.status, title = excluded.title`
    ).run({ ":mid": "M001", ":sid": "S01", ":title": "Test slice", ":status": status, ":now": (/* @__PURE__ */ new Date()).toISOString() });
  }
}
function writeCompleteSliceArtifacts(base) {
  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  mkdirSync(sliceDir, { recursive: true });
  writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# Summary\nDone.\n", "utf-8");
  writeFileSync(join(sliceDir, "S01-UAT.md"), "# UAT\nPassed.\n", "utf-8");
}
function writeCompleteMilestoneSummary(base) {
  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(join(milestoneDir, "M001-SUMMARY.md"), "# Milestone Summary\nDone.\n", "utf-8");
}
function writePausedSession(base, milestoneId = "M001", stepMode = false, worktreePath, unitType, unitId) {
  setRuntimeKv("global", "", PAUSED_SESSION_KV_KEY, {
    milestoneId,
    originalBasePath: base,
    stepMode,
    worktreePath,
    unitType,
    unitId
  });
}
function writeActivityLog(base, entries) {
  const activityDir = join(base, ".gsd", "activity");
  mkdirSync(activityDir, { recursive: true });
  writeFileSync(
    join(activityDir, "001-execute-task-M001-S01-T01.jsonl"),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    "utf-8"
  );
}
function makeState(phase, activeMilestone = true) {
  return {
    activeMilestone: activeMilestone ? { id: "M001", title: "Test" } : null,
    activeSlice: null,
    activeTask: null,
    phase,
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: []
  };
}
test("hasResumableDerivedState treats only unfinished active work as resumable", () => {
  assert.equal(hasResumableDerivedState(makeState("executing")), true);
  assert.equal(hasResumableDerivedState(makeState("complete")), false);
  assert.equal(hasResumableDerivedState(makeState("pre-planning", false)), false);
});
test("isBootstrapCrashLock detects starting/bootstrap special case", () => {
  const bootstrap = {
    pid: 999999999,
    startedAt: (/* @__PURE__ */ new Date()).toISOString(),
    unitType: "starting",
    unitId: "bootstrap",
    unitStartedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  assert.equal(isBootstrapCrashLock(bootstrap), true);
  assert.equal(isBootstrapCrashLock({ ...bootstrap, unitType: "execute-task" }), false);
});
test("readPausedSessionMetadata reads paused-session metadata when present", () => {
  const base = makeTmpBase();
  try {
    writePausedSession(base, "M009");
    const meta = readPausedSessionMetadata(base);
    assert.equal(meta?.milestoneId, "M009");
  } finally {
    cleanup(base);
  }
});
test("paused session recovery consumes JSONL without deleting the evidence file", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));
  const sessionFile = join(base, "paused-session.jsonl");
  writeFileSync(
    sessionFile,
    [
      JSON.stringify({ type: "session", id: "session-1" }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "bash",
              id: "tool-1",
              arguments: { command: "echo paused" }
            }
          ]
        }
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "bash",
          isError: false,
          content: "paused\n"
        }
      })
    ].join("\n"),
    "utf-8"
  );
  const recovery = _synthesizePausedSessionRecoveryForTest(
    base,
    "execute-task",
    "M001/S01/T01",
    sessionFile
  );
  assert.equal(recovery?.trace.toolCallCount, 1);
  assert.equal(existsSync(sessionFile), true, "paused JSONL must remain available after synthesis");
});
test("readPausedSessionMetadata preserves unitType and unitId through round-trip", () => {
  const base = makeTmpBase();
  try {
    writePausedSession(base, "M001", false, void 0, "execute-task", "M001/S01/T02");
    const meta = readPausedSessionMetadata(base);
    assert.equal(meta?.unitType, "execute-task");
    assert.equal(meta?.unitId, "M001/S01/T02");
  } finally {
    cleanup(base);
  }
});
test("readPausedSessionMetadata handles legacy metadata without unitType/unitId", () => {
  const base = makeTmpBase();
  try {
    setRuntimeKv("global", "", PAUSED_SESSION_KV_KEY, {
      milestoneId: "M001",
      originalBasePath: base
    });
    const meta = readPausedSessionMetadata(base);
    assert.equal(meta?.milestoneId, "M001");
    assert.equal(meta?.unitType, void 0);
    assert.equal(meta?.unitId, void 0);
  } finally {
    cleanup(base);
  }
});
test("readPausedSessionMetadata drops stale discuss-milestone pseudo PROJECT metadata", () => {
  const base = makeTmpBase();
  try {
    setRuntimeKv("global", "", PAUSED_SESSION_KV_KEY, {
      milestoneId: null,
      originalBasePath: base,
      unitType: "discuss-milestone",
      unitId: "PROJECT"
    });
    const meta = readPausedSessionMetadata(base);
    assert.equal(meta, null);
    const adapter = _getAdapter();
    const row = adapter.prepare(
      `SELECT 1 FROM runtime_kv WHERE scope = 'global' AND scope_id = '' AND key = :k`
    ).get({ ":k": PAUSED_SESSION_KV_KEY });
    assert.equal(row, void 0);
  } finally {
    cleanup(base);
  }
});
test("readPausedSessionMetadata drops stale deep setup pseudo-unit metadata", () => {
  const base = makeTmpBase();
  try {
    setRuntimeKv("global", "", PAUSED_SESSION_KV_KEY, {
      milestoneId: "WORKFLOW-PREFS",
      originalBasePath: base,
      unitType: "workflow-preferences",
      unitId: "WORKFLOW-PREFS"
    });
    const meta = readPausedSessionMetadata(base);
    assert.equal(meta, null);
    const adapter = _getAdapter();
    const row = adapter.prepare(
      `SELECT 1 FROM runtime_kv WHERE scope = 'global' AND scope_id = '' AND key = :k`
    ).get({ ":k": PAUSED_SESSION_KV_KEY });
    assert.equal(row, void 0);
  } finally {
    cleanup(base);
  }
});
test("assessInterruptedSession returns none when no lock and no paused session exist", async () => {
  const base = makeTmpBase();
  try {
    const assessment = await assessInterruptedSession(base);
    assert.equal(assessment.classification, "none");
    assert.equal(assessment.lock, null);
    assert.equal(assessment.pausedSession, null);
    assert.equal(assessment.state, null);
    assert.equal(assessment.recovery, null);
    assert.equal(assessment.recoveryPrompt, null);
    assert.equal(assessment.recoveryToolCallCount, 0);
    assert.equal(assessment.artifactSatisfied, false);
    assert.equal(assessment.hasResumableDiskState, false);
    assert.equal(assessment.isBootstrapCrash, false);
  } finally {
    cleanup(base);
  }
});
test("assessInterruptedSession classifies stale complete repo as stale and suppresses recovery", async () => {
  const base = makeTmpBase();
  try {
    writeRoadmap(base, true);
    writeCompleteSliceArtifacts(base);
    writeCompleteMilestoneSummary(base);
    writeTestLock(base, "execute-task", "M001/S01/T01");
    const assessment = await assessInterruptedSession(base);
    assert.equal(assessment.classification, "stale");
    assert.equal(assessment.hasResumableDiskState, false);
    assert.equal(assessment.recoveryPrompt, null);
  } finally {
    cleanup(base);
  }
});
test("assessInterruptedSession suppresses prompt when expected artifact already exists and no resumable state remains", async () => {
  const base = makeTmpBase();
  try {
    writeRoadmap(base, true);
    writeCompleteSliceArtifacts(base);
    writeCompleteMilestoneSummary(base);
    writeTestLock(base, "complete-slice", "M001/S01");
    const assessment = await assessInterruptedSession(base);
    assert.equal(assessment.classification, "stale");
    assert.equal(assessment.artifactSatisfied, true);
  } finally {
    cleanup(base);
  }
});
test("assessInterruptedSession keeps paused-session resume recoverable when disk state is unfinished", async () => {
  const base = makeTmpBase();
  try {
    writeRoadmap(base, false);
    writePausedSession(base);
    writeTestLock(base, "execute-task", "M001/S01/T01");
    const assessment = await assessInterruptedSession(base);
    assert.equal(assessment.classification, "recoverable");
    assert.equal(assessment.pausedSession?.milestoneId, "M001");
  } finally {
    cleanup(base);
  }
});
test("assessInterruptedSession marks stale paused-session metadata as stale when no work remains", async () => {
  const base = makeTmpBase();
  try {
    writeRoadmap(base, true);
    writeCompleteSliceArtifacts(base);
    writeCompleteMilestoneSummary(base);
    writePausedSession(base, "M999");
    const assessment = await assessInterruptedSession(base);
    assert.equal(assessment.classification, "stale");
    assert.equal(assessment.hasResumableDiskState, false);
  } finally {
    cleanup(base);
  }
});
test("assessInterruptedSession classifies paused session without lock as recoverable when disk state is resumable", async () => {
  const base = makeTmpBase();
  try {
    writeRoadmap(base, false);
    writePausedSession(base, "M001", true);
    const assessment = await assessInterruptedSession(base);
    assert.equal(assessment.classification, "recoverable");
    assert.equal(assessment.lock, null);
    assert.equal(assessment.pausedSession?.milestoneId, "M001");
    assert.equal(assessment.hasResumableDiskState, true);
    assert.equal(assessment.isBootstrapCrash, false);
  } finally {
    cleanup(base);
  }
});
test("assessInterruptedSession falls back to basePath when worktreePath no longer exists", async () => {
  const base = makeTmpBase();
  try {
    writeRoadmap(base, false);
    writePausedSession(base, "M001", false, "/nonexistent/worktree");
    const assessment = await assessInterruptedSession(base);
    assert.equal(assessment.classification, "recoverable");
    assert.equal(assessment.hasResumableDiskState, true);
  } finally {
    cleanup(base);
  }
});
test("assessInterruptedSession prefers paused worktree state when worktreePath is recorded", async () => {
  const base = makeTmpBase();
  const worktree = join(base, "worktree-copy");
  try {
    writeRoadmap(base, false);
    writeRoadmap(worktree, true);
    writeCompleteSliceArtifacts(worktree);
    writeCompleteMilestoneSummary(worktree);
    writePausedSession(base, "M001", false, worktree);
    const assessment = await assessInterruptedSession(base);
    assert.equal(assessment.classification, "stale");
    assert.equal(assessment.hasResumableDiskState, false);
  } finally {
    cleanup(base);
  }
});
test("assessInterruptedSession keeps unfinished derived state recoverable without trace", async () => {
  const base = makeTmpBase();
  try {
    writeRoadmap(base, false);
    writeTestLock(base, "plan-slice", "M001/S01");
    const assessment = await assessInterruptedSession(base);
    assert.equal(assessment.classification, "recoverable");
    assert.equal(assessment.hasResumableDiskState, true);
    assert.equal(assessment.recoveryPrompt, null);
  } finally {
    cleanup(base);
  }
});
test("assessInterruptedSession preserves crash trace when activity log has tool calls", async () => {
  const base = makeTmpBase();
  try {
    writeRoadmap(base, false);
    writeTestLock(base, "execute-task", "M001/S01/T01");
    writeActivityLog(base, [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "1",
              name: "bash",
              arguments: { command: "npm test" }
            }
          ]
        }
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "1",
          toolName: "bash",
          isError: false,
          content: [{ type: "text", text: "ok" }]
        }
      }
    ]);
    const assessment = await assessInterruptedSession(base);
    assert.equal(assessment.classification, "recoverable");
    assert.ok(assessment.recoveryToolCallCount > 0);
    assert.ok(assessment.recoveryPrompt?.includes("Recovery Briefing"));
  } finally {
    cleanup(base);
  }
});
test("assessInterruptedSession treats bootstrap crash as stale without paused metadata", async () => {
  const base = makeTmpBase();
  try {
    writeTestLock(base, "starting", "bootstrap");
    const assessment = await assessInterruptedSession(base);
    assert.equal(assessment.classification, "stale");
    assert.equal(assessment.isBootstrapCrash, true);
  } finally {
    cleanup(base);
  }
});
test("writeLock creates lock file and readCrashLock reads it", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  const projectRoot = normalizeRealPath(base);
  const workerId = registerAutoWorker({ projectRootRealpath: projectRoot });
  const lease = claimMilestoneLease(workerId, "M001");
  assert.equal(lease.ok, true);
  if (!lease.ok) return;
  recordDispatchClaim({
    traceId: "t1",
    workerId,
    milestoneLeaseToken: lease.token,
    milestoneId: "M001",
    unitType: "execute-task",
    unitId: "M001/S01/T01"
  });
  writeLock(base, "execute-task", "M001/S01/T01", "/tmp/session.jsonl");
  _getAdapter().prepare(
    `UPDATE workers SET last_heartbeat_at = '1970-01-01T00:00:00.000Z' WHERE worker_id = :w`
  ).run({ ":w": workerId });
  const lock = readCrashLock(base);
  assert.ok(lock, "lock should exist");
  assert.equal(lock.unitType, "execute-task");
  assert.equal(lock.unitId, "M001/S01/T01");
  assert.equal(lock.sessionFile, "/tmp/session.jsonl");
  assert.equal(lock.pid, process.pid);
});
test("readCrashLock returns null when no lock exists", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));
  const lock = readCrashLock(base);
  assert.equal(lock, null);
});
test("clearLock removes existing lock file", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));
  const projectRoot = normalizeRealPath(base);
  const workerId = registerAutoWorker({ projectRootRealpath: projectRoot });
  writeLock(base, "plan-slice", "M001/S01", "/tmp/session.jsonl");
  const adapter = _getAdapter();
  const before = adapter.prepare(
    `SELECT 1 FROM runtime_kv WHERE scope = 'worker' AND scope_id = :w AND key = 'session_file'`
  ).get({ ":w": workerId });
  assert.ok(before, "session_file row exists before clear");
  clearLock(base);
  const after = adapter.prepare(
    `SELECT 1 FROM runtime_kv WHERE scope = 'worker' AND scope_id = :w AND key = 'session_file'`
  ).get({ ":w": workerId });
  assert.equal(after, void 0, "session_file row gone after clearLock");
});
test("clearLock is safe when no lock exists", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));
  assert.doesNotThrow(() => clearLock(base));
});
test("#2470: isLockProcessAlive returns true for own PID (we hold the lock)", () => {
  const lock = {
    pid: process.pid,
    startedAt: (/* @__PURE__ */ new Date()).toISOString(),
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    unitStartedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  assert.equal(isLockProcessAlive(lock), true, "own PID should return true \u2014 we are alive");
});
test("isLockProcessAlive returns false for dead PID", () => {
  const lock = {
    pid: 999999999,
    startedAt: (/* @__PURE__ */ new Date()).toISOString(),
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    unitStartedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  assert.equal(isLockProcessAlive(lock), false);
});
test("isLockProcessAlive returns false for invalid PIDs", () => {
  const base = {
    startedAt: (/* @__PURE__ */ new Date()).toISOString(),
    unitType: "x",
    unitId: "x",
    unitStartedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  assert.equal(isLockProcessAlive({ ...base, pid: 0 }), false);
  assert.equal(isLockProcessAlive({ ...base, pid: -1 }), false);
  assert.equal(isLockProcessAlive({ ...base, pid: 1.5 }), false);
});
test("formatCrashInfo includes unit type, id, and PID", () => {
  const lock = {
    pid: 12345,
    startedAt: "2025-01-01T00:00:00.000Z",
    unitType: "complete-slice",
    unitId: "M002/S03",
    unitStartedAt: "2025-01-01T00:01:00.000Z"
  };
  const info = formatCrashInfo(lock);
  assert.ok(info.includes("complete-slice"));
  assert.ok(info.includes("M002/S03"));
  assert.ok(info.includes("12345"));
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jcmFzaC1yZWNvdmVyeS50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMsIG1rZGlyU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gXCJub2RlOmNyeXB0b1wiO1xuXG5pbXBvcnQge1xuICB3cml0ZUxvY2ssXG4gIGNsZWFyTG9jayxcbiAgcmVhZENyYXNoTG9jayxcbiAgaXNMb2NrUHJvY2Vzc0FsaXZlLFxuICBmb3JtYXRDcmFzaEluZm8sXG4gIHR5cGUgTG9ja0RhdGEsXG59IGZyb20gXCIuLi9jcmFzaC1yZWNvdmVyeS50c1wiO1xuaW1wb3J0IHtcbiAgYXNzZXNzSW50ZXJydXB0ZWRTZXNzaW9uLFxuICBoYXNSZXN1bWFibGVEZXJpdmVkU3RhdGUsXG4gIGlzQm9vdHN0cmFwQ3Jhc2hMb2NrLFxuICByZWFkUGF1c2VkU2Vzc2lvbk1ldGFkYXRhLFxuICBQQVVTRURfU0VTU0lPTl9LVl9LRVksXG59IGZyb20gXCIuLi9pbnRlcnJ1cHRlZC1zZXNzaW9uLnRzXCI7XG5pbXBvcnQge1xuICBvcGVuRGF0YWJhc2UsXG4gIGNsb3NlRGF0YWJhc2UsXG4gIGluc2VydE1pbGVzdG9uZSxcbiAgX2dldEFkYXB0ZXIsXG59IGZyb20gXCIuLi9nc2QtZGIudHNcIjtcbmltcG9ydCB7IHJlZ2lzdGVyQXV0b1dvcmtlciB9IGZyb20gXCIuLi9kYi9hdXRvLXdvcmtlcnMudHNcIjtcbmltcG9ydCB7IGNsYWltTWlsZXN0b25lTGVhc2UgfSBmcm9tIFwiLi4vZGIvbWlsZXN0b25lLWxlYXNlcy50c1wiO1xuaW1wb3J0IHsgcmVjb3JkRGlzcGF0Y2hDbGFpbSB9IGZyb20gXCIuLi9kYi91bml0LWRpc3BhdGNoZXMudHNcIjtcbmltcG9ydCB7IGluc2VydFNsaWNlLCBpbnNlcnRUYXNrIH0gZnJvbSBcIi4uL2dzZC1kYi50c1wiO1xuaW1wb3J0IHsgc2V0UnVudGltZUt2IH0gZnJvbSBcIi4uL2RiL3J1bnRpbWUta3YudHNcIjtcbmltcG9ydCB7IG5vcm1hbGl6ZVJlYWxQYXRoIH0gZnJvbSBcIi4uL3BhdGhzLnRzXCI7XG5pbXBvcnQgdHlwZSB7IEdTRFN0YXRlIH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5pbXBvcnQgeyBfc3ludGhlc2l6ZVBhdXNlZFNlc3Npb25SZWNvdmVyeUZvclRlc3QgfSBmcm9tIFwiLi4vYXV0by50c1wiO1xuXG5mdW5jdGlvbiBtYWtlVG1wQmFzZSgpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gam9pbih0bXBkaXIoKSwgYGdzZC10ZXN0LSR7cmFuZG9tVVVJRCgpfWApO1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAvLyBQaGFzZSBDIHB0IDI6IGxvY2sgYW5kIHBhdXNlZC1zZXNzaW9uIGxpdmUgaW4gdGhlIERCIG5vdy4gT3BlbiBpdFxuICAvLyBmb3IgZXZlcnkgdGVzdCBiYXNlIHNvIHRoZSBoZWxwZXJzIGJlbG93IGNhbiB3cml0ZSB0aHJvdWdoLlxuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJnc2QuZGJcIikpO1xuICByZXR1cm4gYmFzZTtcbn1cblxuZnVuY3Rpb24gY2xlYW51cChiYXNlOiBzdHJpbmcpOiB2b2lkIHtcbiAgdHJ5IHsgY2xvc2VEYXRhYmFzZSgpOyB9IGNhdGNoIHsgLyogKi8gfVxuICB0cnkgeyBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pOyB9IGNhdGNoIHsgLyogKi8gfVxufVxuXG4vKipcbiAqIFBoYXNlIEMgcHQgMiBmaXh0dXJlOiBpbnNlcnQgYSBzdGFsZSB3b3JrZXIgcm93ICsgZGlzcGF0Y2ggKyBzZXNzaW9uX2ZpbGVcbiAqIGRpcmVjdGx5IHZpYSBTUUwgc28gaXQgYXBwZWFycyBhcyBhIGNyYXNoZWQgUEVFUiBwcm9jZXNzLCBub3QgYXMgdGhlXG4gKiBjdXJyZW50IHRlc3QgcHJvY2Vzcy4gYXNzZXNzSW50ZXJydXB0ZWRTZXNzaW9uIGZpbHRlcnMgb3V0XG4gKiBgcmF3TG9jay5waWQgPT09IHByb2Nlc3MucGlkYCB0byBhdm9pZCBjbGFzc2lmeWluZyBpdHMgb3duIHByb2Nlc3MgYXNcbiAqIGEgcHJldmlvdXMgY3Jhc2g7IHVzaW5nIFBJRCA5OTk5OTk5OTkgKGZ1bmN0aW9uYWxseSBndWFyYW50ZWVkIGRlYWQpXG4gKiBieXBhc3NlcyB0aGF0IGd1YXJkIGV4YWN0bHkgdGhlIHdheSB0aGUgb2xkIGZpbGUtYmFzZWQgd3JpdGVUZXN0TG9ja1xuICogZGlkIHdpdGggdGhlIHNhbWUgUElELlxuICovXG5mdW5jdGlvbiB3cml0ZVRlc3RMb2NrKFxuICBiYXNlOiBzdHJpbmcsXG4gIHVuaXRUeXBlOiBzdHJpbmcsXG4gIHVuaXRJZDogc3RyaW5nLFxuICBzZXNzaW9uRmlsZT86IHN0cmluZyxcbik6IHZvaWQge1xuICBjb25zdCBwcm9qZWN0Um9vdCA9IG5vcm1hbGl6ZVJlYWxQYXRoKGJhc2UpO1xuICBjb25zdCB3b3JrZXJJZCA9IGB0ZXN0LWZha2UtJHtyYW5kb21VVUlEKCkuc2xpY2UoMCwgOCl9YDtcbiAgY29uc3QgZmFrZVBpZCA9IDk5OTk5OTk5OTtcbiAgY29uc3Qgc3RhbGVQYXN0ID0gXCIxOTcwLTAxLTAxVDAwOjAwOjAwLjAwMFpcIjtcbiAgY29uc3QgZGIgPSBfZ2V0QWRhcHRlcigpITtcbiAgZGIucHJlcGFyZShcbiAgICBgSU5TRVJUIElOVE8gd29ya2VycyAoXG4gICAgICB3b3JrZXJfaWQsIGhvc3QsIHBpZCwgc3RhcnRlZF9hdCwgdmVyc2lvbixcbiAgICAgIGxhc3RfaGVhcnRiZWF0X2F0LCBzdGF0dXMsIHByb2plY3Rfcm9vdF9yZWFscGF0aFxuICAgICkgVkFMVUVTIChcbiAgICAgIDp3LCAndGVzdC1ob3N0JywgOnBpZCwgOnN0YXJ0ZWRfYXQsICd0ZXN0JyxcbiAgICAgIDpzdGFsZSwgJ2FjdGl2ZScsIDpwcm9qZWN0X3Jvb3RcbiAgICApYCxcbiAgKS5ydW4oe1xuICAgIFwiOndcIjogd29ya2VySWQsXG4gICAgXCI6cGlkXCI6IGZha2VQaWQsXG4gICAgXCI6c3RhcnRlZF9hdFwiOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgXCI6c3RhbGVcIjogc3RhbGVQYXN0LFxuICAgIFwiOnByb2plY3Rfcm9vdFwiOiBwcm9qZWN0Um9vdCxcbiAgfSk7XG5cbiAgLy8gRW5zdXJlIG1pbGVzdG9uZXMgcmVmZXJlbmNlZCBieSB0aGUgdW5pdElkIGV4aXN0IHNvIHRoZSBkaXNwYXRjaFxuICAvLyBGSyBpcyBzYXRpc2ZpZWQuIFBhcnNlIFwiTSMjIy9TIyNcIiBvciBcIk0jIyNcIiBvciBcInN0YXJ0aW5nXCIgLyBldGMuXG4gIGNvbnN0IG1pZE1hdGNoID0gdW5pdElkLm1hdGNoKC9eKE1cXGQrKS8pO1xuICBpZiAobWlkTWF0Y2ggJiYgdW5pdFR5cGUgIT09IFwic3RhcnRpbmdcIikge1xuICAgIGNvbnN0IG1pZCA9IG1pZE1hdGNoWzFdO1xuICAgIHRyeSB7IGluc2VydE1pbGVzdG9uZSh7IGlkOiBtaWQsIHRpdGxlOiBgVGVzdCAke21pZH1gLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSk7IH1cbiAgICBjYXRjaCB7IC8qIG1heSBhbHJlYWR5IGV4aXN0ICovIH1cbiAgICB0cnkge1xuICAgICAgY29uc3QgbGVhc2UgPSBjbGFpbU1pbGVzdG9uZUxlYXNlKHdvcmtlcklkLCBtaWQpO1xuICAgICAgcmVjb3JkRGlzcGF0Y2hDbGFpbSh7XG4gICAgICAgIHRyYWNlSWQ6IHJhbmRvbVVVSUQoKSxcbiAgICAgICAgd29ya2VySWQsXG4gICAgICAgIG1pbGVzdG9uZUxlYXNlVG9rZW46IGxlYXNlLm9rID8gbGVhc2UudG9rZW4gOiAwLFxuICAgICAgICBtaWxlc3RvbmVJZDogbWlkLFxuICAgICAgICB1bml0VHlwZSxcbiAgICAgICAgdW5pdElkLFxuICAgICAgfSk7XG4gICAgfSBjYXRjaCB7IC8qIGlnbm9yZSBcdTIwMTQgYmVzdC1lZmZvcnQgKi8gfVxuICB9XG5cbiAgaWYgKHNlc3Npb25GaWxlKSB7XG4gICAgc2V0UnVudGltZUt2KFwid29ya2VyXCIsIHdvcmtlcklkLCBcInNlc3Npb25fZmlsZVwiLCBzZXNzaW9uRmlsZSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gd3JpdGVSb2FkbWFwKGJhc2U6IHN0cmluZywgY2hlY2tlZCA9IGZhbHNlKTogdm9pZCB7XG4gIGNvbnN0IG1pbGVzdG9uZURpciA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIik7XG4gIG1rZGlyU3luYyhqb2luKG1pbGVzdG9uZURpciwgXCJzbGljZXNcIiwgXCJTMDFcIiwgXCJ0YXNrc1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihtaWxlc3RvbmVEaXIsIFwiTTAwMS1ST0FETUFQLm1kXCIpLFxuICAgIFtcbiAgICAgIFwiIyBNMDAxOiBUZXN0IE1pbGVzdG9uZVwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMgVmlzaW9uXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCJUZXN0IG1pbGVzdG9uZS5cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFN1Y2Nlc3MgQ3JpdGVyaWFcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIi0gSXQgd29ya3MuXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBTbGljZXNcIixcbiAgICAgIFwiXCIsXG4gICAgICBgLSBbJHtjaGVja2VkID8gXCJ4XCIgOiBcIiBcIn1dICoqUzAxOiBUZXN0IHNsaWNlKiogXFxgcmlzazpsb3dcXGBgLFxuICAgICAgXCIgIEFmdGVyIHRoaXM6IERlbW9cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIEJvdW5kYXJ5IE1hcFwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiLSBTMDEgXHUyMTkyIHRlcm1pbmFsXCIsXG4gICAgICBcIiAgLSBQcm9kdWNlczogZG9uZVwiLFxuICAgICAgXCIgIC0gQ29uc3VtZXM6IG5vdGhpbmdcIixcbiAgICBdLmpvaW4oXCJcXG5cIiksXG4gICAgXCJ1dGYtOFwiLFxuICApO1xuICAvLyBQaGFzZSBDIHB0IDI6IG1ha2VUbXBCYXNlKCkgb3BlbnMgdGhlIERCIHNvIHdyaXRlVGVzdExvY2sgY2FuIHdyaXRlXG4gIC8vIHRoZSB3b3JrZXJzIHJvdy4gZGVyaXZlU3RhdGUgdGhlbiBnb2VzIERCLWZpcnN0OyBtaXJyb3IgdGhlIG1hcmtkb3duXG4gIC8vIGZpeHR1cmUgaW50byB0aGUgREIgc28gdGhlIGFzc2Vzc21lbnQgc2VlcyB0aGUgc2FtZSBtaWxlc3RvbmUgc3RhdGUuXG4gIC8vIFVzZSBkaXJlY3QgdXBzZXJ0IFNRTCBzbyBjYWxsaW5nIHdyaXRlUm9hZG1hcCB0d2ljZSAoZS5nLiBvbmNlIGZvclxuICAvLyBiYXNlICsgb25jZSBmb3IgYSBwYXVzZWQgd29ya3RyZWUpIGFjdHVhbGx5IGZsaXBzIHRoZSBzdGF0dXMuXG4gIGNvbnN0IHN0YXR1cyA9IGNoZWNrZWQgPyBcImNvbXBsZXRlXCIgOiBcImFjdGl2ZVwiO1xuICBjb25zdCBhZGFwdGVyID0gX2dldEFkYXB0ZXIoKTtcbiAgaWYgKGFkYXB0ZXIpIHtcbiAgICBhZGFwdGVyLnByZXBhcmUoXG4gICAgICBgSU5TRVJUIElOVE8gbWlsZXN0b25lcyAoaWQsIHRpdGxlLCBzdGF0dXMsIGNyZWF0ZWRfYXQpXG4gICAgICAgVkFMVUVTICg6aWQsIDp0aXRsZSwgOnN0YXR1cywgOm5vdylcbiAgICAgICBPTiBDT05GTElDVChpZCkgRE8gVVBEQVRFIFNFVCBzdGF0dXMgPSBleGNsdWRlZC5zdGF0dXMsIHRpdGxlID0gZXhjbHVkZWQudGl0bGVgLFxuICAgICkucnVuKHsgXCI6aWRcIjogXCJNMDAxXCIsIFwiOnRpdGxlXCI6IFwiVGVzdCBNaWxlc3RvbmVcIiwgXCI6c3RhdHVzXCI6IHN0YXR1cywgXCI6bm93XCI6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSB9KTtcbiAgICBhZGFwdGVyLnByZXBhcmUoXG4gICAgICBgSU5TRVJUIElOVE8gc2xpY2VzIChtaWxlc3RvbmVfaWQsIGlkLCB0aXRsZSwgc3RhdHVzLCBjcmVhdGVkX2F0KVxuICAgICAgIFZBTFVFUyAoOm1pZCwgOnNpZCwgOnRpdGxlLCA6c3RhdHVzLCA6bm93KVxuICAgICAgIE9OIENPTkZMSUNUKG1pbGVzdG9uZV9pZCwgaWQpIERPIFVQREFURSBTRVQgc3RhdHVzID0gZXhjbHVkZWQuc3RhdHVzLCB0aXRsZSA9IGV4Y2x1ZGVkLnRpdGxlYCxcbiAgICApLnJ1bih7IFwiOm1pZFwiOiBcIk0wMDFcIiwgXCI6c2lkXCI6IFwiUzAxXCIsIFwiOnRpdGxlXCI6IFwiVGVzdCBzbGljZVwiLCBcIjpzdGF0dXNcIjogc3RhdHVzLCBcIjpub3dcIjogbmV3IERhdGUoKS50b0lTT1N0cmluZygpIH0pO1xuICB9XG59XG5cbmZ1bmN0aW9uIHdyaXRlQ29tcGxldGVTbGljZUFydGlmYWN0cyhiYXNlOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3Qgc2xpY2VEaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIpO1xuICBta2RpclN5bmMoc2xpY2VEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oc2xpY2VEaXIsIFwiUzAxLVNVTU1BUlkubWRcIiksIFwiIyBTdW1tYXJ5XFxuRG9uZS5cXG5cIiwgXCJ1dGYtOFwiKTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKHNsaWNlRGlyLCBcIlMwMS1VQVQubWRcIiksIFwiIyBVQVRcXG5QYXNzZWQuXFxuXCIsIFwidXRmLThcIik7XG59XG5cbmZ1bmN0aW9uIHdyaXRlQ29tcGxldGVNaWxlc3RvbmVTdW1tYXJ5KGJhc2U6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBtaWxlc3RvbmVEaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIpO1xuICBta2RpclN5bmMobWlsZXN0b25lRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKG1pbGVzdG9uZURpciwgXCJNMDAxLVNVTU1BUlkubWRcIiksIFwiIyBNaWxlc3RvbmUgU3VtbWFyeVxcbkRvbmUuXFxuXCIsIFwidXRmLThcIik7XG59XG5cbmZ1bmN0aW9uIHdyaXRlUGF1c2VkU2Vzc2lvbihcbiAgYmFzZTogc3RyaW5nLFxuICBtaWxlc3RvbmVJZCA9IFwiTTAwMVwiLFxuICBzdGVwTW9kZSA9IGZhbHNlLFxuICB3b3JrdHJlZVBhdGg/OiBzdHJpbmcsXG4gIHVuaXRUeXBlPzogc3RyaW5nLFxuICB1bml0SWQ/OiBzdHJpbmcsXG4pOiB2b2lkIHtcbiAgLy8gUGhhc2UgQyBwdCAyOiBwYXVzZWQtc2Vzc2lvbi5qc29uIG1pZ3JhdGVkIHRvIHJ1bnRpbWVfa3ZcbiAgLy8gKGdsb2JhbCBzY29wZSwga2V5IFBBVVNFRF9TRVNTSU9OX0tWX0tFWSkuXG4gIHNldFJ1bnRpbWVLdihcImdsb2JhbFwiLCBcIlwiLCBQQVVTRURfU0VTU0lPTl9LVl9LRVksIHtcbiAgICBtaWxlc3RvbmVJZCxcbiAgICBvcmlnaW5hbEJhc2VQYXRoOiBiYXNlLFxuICAgIHN0ZXBNb2RlLFxuICAgIHdvcmt0cmVlUGF0aCxcbiAgICB1bml0VHlwZSxcbiAgICB1bml0SWQsXG4gIH0pO1xufVxuXG5mdW5jdGlvbiB3cml0ZUFjdGl2aXR5TG9nKGJhc2U6IHN0cmluZywgZW50cmllczogUmVjb3JkPHN0cmluZywgdW5rbm93bj5bXSk6IHZvaWQge1xuICBjb25zdCBhY3Rpdml0eURpciA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiYWN0aXZpdHlcIik7XG4gIG1rZGlyU3luYyhhY3Rpdml0eURpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihhY3Rpdml0eURpciwgXCIwMDEtZXhlY3V0ZS10YXNrLU0wMDEtUzAxLVQwMS5qc29ubFwiKSxcbiAgICBlbnRyaWVzLm1hcCgoZW50cnkpID0+IEpTT04uc3RyaW5naWZ5KGVudHJ5KSkuam9pbihcIlxcblwiKSArIFwiXFxuXCIsXG4gICAgXCJ1dGYtOFwiLFxuICApO1xufVxuXG5mdW5jdGlvbiBtYWtlU3RhdGUocGhhc2U6IEdTRFN0YXRlW1wicGhhc2VcIl0sIGFjdGl2ZU1pbGVzdG9uZSA9IHRydWUpOiBHU0RTdGF0ZSB7XG4gIHJldHVybiB7XG4gICAgYWN0aXZlTWlsZXN0b25lOiBhY3RpdmVNaWxlc3RvbmUgPyB7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdFwiIH0gOiBudWxsLFxuICAgIGFjdGl2ZVNsaWNlOiBudWxsLFxuICAgIGFjdGl2ZVRhc2s6IG51bGwsXG4gICAgcGhhc2UsXG4gICAgcmVjZW50RGVjaXNpb25zOiBbXSxcbiAgICBibG9ja2VyczogW10sXG4gICAgbmV4dEFjdGlvbjogXCJcIixcbiAgICByZWdpc3RyeTogW10sXG4gIH07XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBpbnRlcnJ1cHRlZC1zZXNzaW9uIGhlbHBlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJoYXNSZXN1bWFibGVEZXJpdmVkU3RhdGUgdHJlYXRzIG9ubHkgdW5maW5pc2hlZCBhY3RpdmUgd29yayBhcyByZXN1bWFibGVcIiwgKCkgPT4ge1xuICBhc3NlcnQuZXF1YWwoaGFzUmVzdW1hYmxlRGVyaXZlZFN0YXRlKG1ha2VTdGF0ZShcImV4ZWN1dGluZ1wiKSksIHRydWUpO1xuICBhc3NlcnQuZXF1YWwoaGFzUmVzdW1hYmxlRGVyaXZlZFN0YXRlKG1ha2VTdGF0ZShcImNvbXBsZXRlXCIpKSwgZmFsc2UpO1xuICBhc3NlcnQuZXF1YWwoaGFzUmVzdW1hYmxlRGVyaXZlZFN0YXRlKG1ha2VTdGF0ZShcInByZS1wbGFubmluZ1wiLCBmYWxzZSkpLCBmYWxzZSk7XG59KTtcblxudGVzdChcImlzQm9vdHN0cmFwQ3Jhc2hMb2NrIGRldGVjdHMgc3RhcnRpbmcvYm9vdHN0cmFwIHNwZWNpYWwgY2FzZVwiLCAoKSA9PiB7XG4gIGNvbnN0IGJvb3RzdHJhcDogTG9ja0RhdGEgPSB7XG4gICAgcGlkOiA5OTk5OTk5OTksXG4gICAgc3RhcnRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgdW5pdFR5cGU6IFwic3RhcnRpbmdcIixcbiAgICB1bml0SWQ6IFwiYm9vdHN0cmFwXCIsXG4gICAgdW5pdFN0YXJ0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICB9O1xuICBhc3NlcnQuZXF1YWwoaXNCb290c3RyYXBDcmFzaExvY2soYm9vdHN0cmFwKSwgdHJ1ZSk7XG4gIGFzc2VydC5lcXVhbChpc0Jvb3RzdHJhcENyYXNoTG9jayh7IC4uLmJvb3RzdHJhcCwgdW5pdFR5cGU6IFwiZXhlY3V0ZS10YXNrXCIgfSksIGZhbHNlKTtcbn0pO1xuXG50ZXN0KFwicmVhZFBhdXNlZFNlc3Npb25NZXRhZGF0YSByZWFkcyBwYXVzZWQtc2Vzc2lvbiBtZXRhZGF0YSB3aGVuIHByZXNlbnRcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICB3cml0ZVBhdXNlZFNlc3Npb24oYmFzZSwgXCJNMDA5XCIpO1xuICAgIGNvbnN0IG1ldGEgPSByZWFkUGF1c2VkU2Vzc2lvbk1ldGFkYXRhKGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChtZXRhPy5taWxlc3RvbmVJZCwgXCJNMDA5XCIpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwicGF1c2VkIHNlc3Npb24gcmVjb3ZlcnkgY29uc3VtZXMgSlNPTkwgd2l0aG91dCBkZWxldGluZyB0aGUgZXZpZGVuY2UgZmlsZVwiLCAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdC5hZnRlcigoKSA9PiBjbGVhbnVwKGJhc2UpKTtcblxuICBjb25zdCBzZXNzaW9uRmlsZSA9IGpvaW4oYmFzZSwgXCJwYXVzZWQtc2Vzc2lvbi5qc29ubFwiKTtcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBzZXNzaW9uRmlsZSxcbiAgICBbXG4gICAgICBKU09OLnN0cmluZ2lmeSh7IHR5cGU6IFwic2Vzc2lvblwiLCBpZDogXCJzZXNzaW9uLTFcIiB9KSxcbiAgICAgIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgdHlwZTogXCJtZXNzYWdlXCIsXG4gICAgICAgIG1lc3NhZ2U6IHtcbiAgICAgICAgICByb2xlOiBcImFzc2lzdGFudFwiLFxuICAgICAgICAgIGNvbnRlbnQ6IFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgdHlwZTogXCJ0b29sQ2FsbFwiLFxuICAgICAgICAgICAgICBuYW1lOiBcImJhc2hcIixcbiAgICAgICAgICAgICAgaWQ6IFwidG9vbC0xXCIsXG4gICAgICAgICAgICAgIGFyZ3VtZW50czogeyBjb21tYW5kOiBcImVjaG8gcGF1c2VkXCIgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICAgIH0pLFxuICAgICAgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICB0eXBlOiBcIm1lc3NhZ2VcIixcbiAgICAgICAgbWVzc2FnZToge1xuICAgICAgICAgIHJvbGU6IFwidG9vbFJlc3VsdFwiLFxuICAgICAgICAgIHRvb2xDYWxsSWQ6IFwidG9vbC0xXCIsXG4gICAgICAgICAgdG9vbE5hbWU6IFwiYmFzaFwiLFxuICAgICAgICAgIGlzRXJyb3I6IGZhbHNlLFxuICAgICAgICAgIGNvbnRlbnQ6IFwicGF1c2VkXFxuXCIsXG4gICAgICAgIH0sXG4gICAgICB9KSxcbiAgICBdLmpvaW4oXCJcXG5cIiksXG4gICAgXCJ1dGYtOFwiLFxuICApO1xuXG4gIGNvbnN0IHJlY292ZXJ5ID0gX3N5bnRoZXNpemVQYXVzZWRTZXNzaW9uUmVjb3ZlcnlGb3JUZXN0KFxuICAgIGJhc2UsXG4gICAgXCJleGVjdXRlLXRhc2tcIixcbiAgICBcIk0wMDEvUzAxL1QwMVwiLFxuICAgIHNlc3Npb25GaWxlLFxuICApO1xuXG4gIGFzc2VydC5lcXVhbChyZWNvdmVyeT8udHJhY2UudG9vbENhbGxDb3VudCwgMSk7XG4gIGFzc2VydC5lcXVhbChleGlzdHNTeW5jKHNlc3Npb25GaWxlKSwgdHJ1ZSwgXCJwYXVzZWQgSlNPTkwgbXVzdCByZW1haW4gYXZhaWxhYmxlIGFmdGVyIHN5bnRoZXNpc1wiKTtcbn0pO1xuXG50ZXN0KFwicmVhZFBhdXNlZFNlc3Npb25NZXRhZGF0YSBwcmVzZXJ2ZXMgdW5pdFR5cGUgYW5kIHVuaXRJZCB0aHJvdWdoIHJvdW5kLXRyaXBcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICB3cml0ZVBhdXNlZFNlc3Npb24oYmFzZSwgXCJNMDAxXCIsIGZhbHNlLCB1bmRlZmluZWQsIFwiZXhlY3V0ZS10YXNrXCIsIFwiTTAwMS9TMDEvVDAyXCIpO1xuICAgIGNvbnN0IG1ldGEgPSByZWFkUGF1c2VkU2Vzc2lvbk1ldGFkYXRhKGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChtZXRhPy51bml0VHlwZSwgXCJleGVjdXRlLXRhc2tcIik7XG4gICAgYXNzZXJ0LmVxdWFsKG1ldGE/LnVuaXRJZCwgXCJNMDAxL1MwMS9UMDJcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJyZWFkUGF1c2VkU2Vzc2lvbk1ldGFkYXRhIGhhbmRsZXMgbGVnYWN5IG1ldGFkYXRhIHdpdGhvdXQgdW5pdFR5cGUvdW5pdElkXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgLy8gUGhhc2UgQyBwdCAyOiB3cml0ZSBkaXJlY3RseSB0byBydW50aW1lX2t2IChzaW11bGF0ZXMgb2xkZXIgcGF5bG9hZFxuICAgIC8vIG1pc3NpbmcgdGhlIG5vdy1jYW5vbmljYWwgdW5pdFR5cGUvdW5pdElkIGZpZWxkcykuXG4gICAgc2V0UnVudGltZUt2KFwiZ2xvYmFsXCIsIFwiXCIsIFBBVVNFRF9TRVNTSU9OX0tWX0tFWSwge1xuICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgb3JpZ2luYWxCYXNlUGF0aDogYmFzZSxcbiAgICB9KTtcbiAgICBjb25zdCBtZXRhID0gcmVhZFBhdXNlZFNlc3Npb25NZXRhZGF0YShiYXNlKTtcbiAgICBhc3NlcnQuZXF1YWwobWV0YT8ubWlsZXN0b25lSWQsIFwiTTAwMVwiKTtcbiAgICBhc3NlcnQuZXF1YWwobWV0YT8udW5pdFR5cGUsIHVuZGVmaW5lZCk7XG4gICAgYXNzZXJ0LmVxdWFsKG1ldGE/LnVuaXRJZCwgdW5kZWZpbmVkKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcInJlYWRQYXVzZWRTZXNzaW9uTWV0YWRhdGEgZHJvcHMgc3RhbGUgZGlzY3Vzcy1taWxlc3RvbmUgcHNldWRvIFBST0pFQ1QgbWV0YWRhdGFcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICAvLyBQaGFzZSBDIHB0IDI6IHdyaXRlIGRpcmVjdGx5IHRvIHJ1bnRpbWVfa3YgKHRoZSBmaWxlIGxvY2F0aW9uIGlzIGdvbmUpXG4gICAgc2V0UnVudGltZUt2KFwiZ2xvYmFsXCIsIFwiXCIsIFBBVVNFRF9TRVNTSU9OX0tWX0tFWSwge1xuICAgICAgbWlsZXN0b25lSWQ6IG51bGwsXG4gICAgICBvcmlnaW5hbEJhc2VQYXRoOiBiYXNlLFxuICAgICAgdW5pdFR5cGU6IFwiZGlzY3Vzcy1taWxlc3RvbmVcIixcbiAgICAgIHVuaXRJZDogXCJQUk9KRUNUXCIsXG4gICAgfSk7XG5cbiAgICBjb25zdCBtZXRhID0gcmVhZFBhdXNlZFNlc3Npb25NZXRhZGF0YShiYXNlKTtcbiAgICBhc3NlcnQuZXF1YWwobWV0YSwgbnVsbCk7XG4gICAgLy8gQ29uZmlybSB0aGUgcm93IHdhcyBkZWxldGVkIGJ5IHJlYWRQYXVzZWRTZXNzaW9uTWV0YWRhdGEnc1xuICAgIC8vIGlzU3RhbGVQc2V1ZG9NaWxlc3RvbmVQYXVzZSBicmFuY2guXG4gICAgY29uc3QgYWRhcHRlciA9IF9nZXRBZGFwdGVyKCkhO1xuICAgIGNvbnN0IHJvdyA9IGFkYXB0ZXIucHJlcGFyZShcbiAgICAgIGBTRUxFQ1QgMSBGUk9NIHJ1bnRpbWVfa3YgV0hFUkUgc2NvcGUgPSAnZ2xvYmFsJyBBTkQgc2NvcGVfaWQgPSAnJyBBTkQga2V5ID0gOmtgLFxuICAgICkuZ2V0KHsgXCI6a1wiOiBQQVVTRURfU0VTU0lPTl9LVl9LRVkgfSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJvdywgdW5kZWZpbmVkKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcInJlYWRQYXVzZWRTZXNzaW9uTWV0YWRhdGEgZHJvcHMgc3RhbGUgZGVlcCBzZXR1cCBwc2V1ZG8tdW5pdCBtZXRhZGF0YVwiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIHNldFJ1bnRpbWVLdihcImdsb2JhbFwiLCBcIlwiLCBQQVVTRURfU0VTU0lPTl9LVl9LRVksIHtcbiAgICAgIG1pbGVzdG9uZUlkOiBcIldPUktGTE9XLVBSRUZTXCIsXG4gICAgICBvcmlnaW5hbEJhc2VQYXRoOiBiYXNlLFxuICAgICAgdW5pdFR5cGU6IFwid29ya2Zsb3ctcHJlZmVyZW5jZXNcIixcbiAgICAgIHVuaXRJZDogXCJXT1JLRkxPVy1QUkVGU1wiLFxuICAgIH0pO1xuXG4gICAgY29uc3QgbWV0YSA9IHJlYWRQYXVzZWRTZXNzaW9uTWV0YWRhdGEoYmFzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKG1ldGEsIG51bGwpO1xuICAgIGNvbnN0IGFkYXB0ZXIgPSBfZ2V0QWRhcHRlcigpITtcbiAgICBjb25zdCByb3cgPSBhZGFwdGVyLnByZXBhcmUoXG4gICAgICBgU0VMRUNUIDEgRlJPTSBydW50aW1lX2t2IFdIRVJFIHNjb3BlID0gJ2dsb2JhbCcgQU5EIHNjb3BlX2lkID0gJycgQU5EIGtleSA9IDprYCxcbiAgICApLmdldCh7IFwiOmtcIjogUEFVU0VEX1NFU1NJT05fS1ZfS0VZIH0pO1xuICAgIGFzc2VydC5lcXVhbChyb3csIHVuZGVmaW5lZCk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJhc3Nlc3NJbnRlcnJ1cHRlZFNlc3Npb24gcmV0dXJucyBub25lIHdoZW4gbm8gbG9jayBhbmQgbm8gcGF1c2VkIHNlc3Npb24gZXhpc3RcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBjb25zdCBhc3Nlc3NtZW50ID0gYXdhaXQgYXNzZXNzSW50ZXJydXB0ZWRTZXNzaW9uKGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChhc3Nlc3NtZW50LmNsYXNzaWZpY2F0aW9uLCBcIm5vbmVcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGFzc2Vzc21lbnQubG9jaywgbnVsbCk7XG4gICAgYXNzZXJ0LmVxdWFsKGFzc2Vzc21lbnQucGF1c2VkU2Vzc2lvbiwgbnVsbCk7XG4gICAgYXNzZXJ0LmVxdWFsKGFzc2Vzc21lbnQuc3RhdGUsIG51bGwpO1xuICAgIGFzc2VydC5lcXVhbChhc3Nlc3NtZW50LnJlY292ZXJ5LCBudWxsKTtcbiAgICBhc3NlcnQuZXF1YWwoYXNzZXNzbWVudC5yZWNvdmVyeVByb21wdCwgbnVsbCk7XG4gICAgYXNzZXJ0LmVxdWFsKGFzc2Vzc21lbnQucmVjb3ZlcnlUb29sQ2FsbENvdW50LCAwKTtcbiAgICBhc3NlcnQuZXF1YWwoYXNzZXNzbWVudC5hcnRpZmFjdFNhdGlzZmllZCwgZmFsc2UpO1xuICAgIGFzc2VydC5lcXVhbChhc3Nlc3NtZW50Lmhhc1Jlc3VtYWJsZURpc2tTdGF0ZSwgZmFsc2UpO1xuICAgIGFzc2VydC5lcXVhbChhc3Nlc3NtZW50LmlzQm9vdHN0cmFwQ3Jhc2gsIGZhbHNlKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcImFzc2Vzc0ludGVycnVwdGVkU2Vzc2lvbiBjbGFzc2lmaWVzIHN0YWxlIGNvbXBsZXRlIHJlcG8gYXMgc3RhbGUgYW5kIHN1cHByZXNzZXMgcmVjb3ZlcnlcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICB3cml0ZVJvYWRtYXAoYmFzZSwgdHJ1ZSk7XG4gICAgd3JpdGVDb21wbGV0ZVNsaWNlQXJ0aWZhY3RzKGJhc2UpO1xuICAgIHdyaXRlQ29tcGxldGVNaWxlc3RvbmVTdW1tYXJ5KGJhc2UpO1xuICAgIHdyaXRlVGVzdExvY2soYmFzZSwgXCJleGVjdXRlLXRhc2tcIiwgXCJNMDAxL1MwMS9UMDFcIik7XG5cbiAgICBjb25zdCBhc3Nlc3NtZW50ID0gYXdhaXQgYXNzZXNzSW50ZXJydXB0ZWRTZXNzaW9uKGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChhc3Nlc3NtZW50LmNsYXNzaWZpY2F0aW9uLCBcInN0YWxlXCIpO1xuICAgIGFzc2VydC5lcXVhbChhc3Nlc3NtZW50Lmhhc1Jlc3VtYWJsZURpc2tTdGF0ZSwgZmFsc2UpO1xuICAgIGFzc2VydC5lcXVhbChhc3Nlc3NtZW50LnJlY292ZXJ5UHJvbXB0LCBudWxsKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcImFzc2Vzc0ludGVycnVwdGVkU2Vzc2lvbiBzdXBwcmVzc2VzIHByb21wdCB3aGVuIGV4cGVjdGVkIGFydGlmYWN0IGFscmVhZHkgZXhpc3RzIGFuZCBubyByZXN1bWFibGUgc3RhdGUgcmVtYWluc1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIHdyaXRlUm9hZG1hcChiYXNlLCB0cnVlKTtcbiAgICB3cml0ZUNvbXBsZXRlU2xpY2VBcnRpZmFjdHMoYmFzZSk7XG4gICAgd3JpdGVDb21wbGV0ZU1pbGVzdG9uZVN1bW1hcnkoYmFzZSk7XG4gICAgd3JpdGVUZXN0TG9jayhiYXNlLCBcImNvbXBsZXRlLXNsaWNlXCIsIFwiTTAwMS9TMDFcIik7XG5cbiAgICBjb25zdCBhc3Nlc3NtZW50ID0gYXdhaXQgYXNzZXNzSW50ZXJydXB0ZWRTZXNzaW9uKGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChhc3Nlc3NtZW50LmNsYXNzaWZpY2F0aW9uLCBcInN0YWxlXCIpO1xuICAgIGFzc2VydC5lcXVhbChhc3Nlc3NtZW50LmFydGlmYWN0U2F0aXNmaWVkLCB0cnVlKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcImFzc2Vzc0ludGVycnVwdGVkU2Vzc2lvbiBrZWVwcyBwYXVzZWQtc2Vzc2lvbiByZXN1bWUgcmVjb3ZlcmFibGUgd2hlbiBkaXNrIHN0YXRlIGlzIHVuZmluaXNoZWRcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICB3cml0ZVJvYWRtYXAoYmFzZSwgZmFsc2UpO1xuICAgIHdyaXRlUGF1c2VkU2Vzc2lvbihiYXNlKTtcbiAgICB3cml0ZVRlc3RMb2NrKGJhc2UsIFwiZXhlY3V0ZS10YXNrXCIsIFwiTTAwMS9TMDEvVDAxXCIpO1xuXG4gICAgY29uc3QgYXNzZXNzbWVudCA9IGF3YWl0IGFzc2Vzc0ludGVycnVwdGVkU2Vzc2lvbihiYXNlKTtcbiAgICBhc3NlcnQuZXF1YWwoYXNzZXNzbWVudC5jbGFzc2lmaWNhdGlvbiwgXCJyZWNvdmVyYWJsZVwiKTtcbiAgICBhc3NlcnQuZXF1YWwoYXNzZXNzbWVudC5wYXVzZWRTZXNzaW9uPy5taWxlc3RvbmVJZCwgXCJNMDAxXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiYXNzZXNzSW50ZXJydXB0ZWRTZXNzaW9uIG1hcmtzIHN0YWxlIHBhdXNlZC1zZXNzaW9uIG1ldGFkYXRhIGFzIHN0YWxlIHdoZW4gbm8gd29yayByZW1haW5zXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgd3JpdGVSb2FkbWFwKGJhc2UsIHRydWUpO1xuICAgIHdyaXRlQ29tcGxldGVTbGljZUFydGlmYWN0cyhiYXNlKTtcbiAgICB3cml0ZUNvbXBsZXRlTWlsZXN0b25lU3VtbWFyeShiYXNlKTtcbiAgICB3cml0ZVBhdXNlZFNlc3Npb24oYmFzZSwgXCJNOTk5XCIpO1xuXG4gICAgY29uc3QgYXNzZXNzbWVudCA9IGF3YWl0IGFzc2Vzc0ludGVycnVwdGVkU2Vzc2lvbihiYXNlKTtcbiAgICBhc3NlcnQuZXF1YWwoYXNzZXNzbWVudC5jbGFzc2lmaWNhdGlvbiwgXCJzdGFsZVwiKTtcbiAgICBhc3NlcnQuZXF1YWwoYXNzZXNzbWVudC5oYXNSZXN1bWFibGVEaXNrU3RhdGUsIGZhbHNlKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcImFzc2Vzc0ludGVycnVwdGVkU2Vzc2lvbiBjbGFzc2lmaWVzIHBhdXNlZCBzZXNzaW9uIHdpdGhvdXQgbG9jayBhcyByZWNvdmVyYWJsZSB3aGVuIGRpc2sgc3RhdGUgaXMgcmVzdW1hYmxlXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgd3JpdGVSb2FkbWFwKGJhc2UsIGZhbHNlKTtcbiAgICB3cml0ZVBhdXNlZFNlc3Npb24oYmFzZSwgXCJNMDAxXCIsIHRydWUpO1xuXG4gICAgY29uc3QgYXNzZXNzbWVudCA9IGF3YWl0IGFzc2Vzc0ludGVycnVwdGVkU2Vzc2lvbihiYXNlKTtcbiAgICBhc3NlcnQuZXF1YWwoYXNzZXNzbWVudC5jbGFzc2lmaWNhdGlvbiwgXCJyZWNvdmVyYWJsZVwiKTtcbiAgICBhc3NlcnQuZXF1YWwoYXNzZXNzbWVudC5sb2NrLCBudWxsKTtcbiAgICBhc3NlcnQuZXF1YWwoYXNzZXNzbWVudC5wYXVzZWRTZXNzaW9uPy5taWxlc3RvbmVJZCwgXCJNMDAxXCIpO1xuICAgIGFzc2VydC5lcXVhbChhc3Nlc3NtZW50Lmhhc1Jlc3VtYWJsZURpc2tTdGF0ZSwgdHJ1ZSk7XG4gICAgYXNzZXJ0LmVxdWFsKGFzc2Vzc21lbnQuaXNCb290c3RyYXBDcmFzaCwgZmFsc2UpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiYXNzZXNzSW50ZXJydXB0ZWRTZXNzaW9uIGZhbGxzIGJhY2sgdG8gYmFzZVBhdGggd2hlbiB3b3JrdHJlZVBhdGggbm8gbG9uZ2VyIGV4aXN0c1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIHdyaXRlUm9hZG1hcChiYXNlLCBmYWxzZSk7XG4gICAgLy8gUmVmZXJlbmNlIGEgd29ya3RyZWUgdGhhdCBkb2Vzbid0IGV4aXN0IG9uIGRpc2tcbiAgICB3cml0ZVBhdXNlZFNlc3Npb24oYmFzZSwgXCJNMDAxXCIsIGZhbHNlLCBcIi9ub25leGlzdGVudC93b3JrdHJlZVwiKTtcblxuICAgIGNvbnN0IGFzc2Vzc21lbnQgPSBhd2FpdCBhc3Nlc3NJbnRlcnJ1cHRlZFNlc3Npb24oYmFzZSk7XG4gICAgLy8gU2hvdWxkIHVzZSBiYXNlUGF0aCAod2hpY2ggaGFzIGFuIHVuZmluaXNoZWQgcm9hZG1hcCkgaW5zdGVhZCBvZiB0aGUgbWlzc2luZyB3b3JrdHJlZVxuICAgIGFzc2VydC5lcXVhbChhc3Nlc3NtZW50LmNsYXNzaWZpY2F0aW9uLCBcInJlY292ZXJhYmxlXCIpO1xuICAgIGFzc2VydC5lcXVhbChhc3Nlc3NtZW50Lmhhc1Jlc3VtYWJsZURpc2tTdGF0ZSwgdHJ1ZSk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJhc3Nlc3NJbnRlcnJ1cHRlZFNlc3Npb24gcHJlZmVycyBwYXVzZWQgd29ya3RyZWUgc3RhdGUgd2hlbiB3b3JrdHJlZVBhdGggaXMgcmVjb3JkZWRcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgY29uc3Qgd29ya3RyZWUgPSBqb2luKGJhc2UsIFwid29ya3RyZWUtY29weVwiKTtcbiAgdHJ5IHtcbiAgICB3cml0ZVJvYWRtYXAoYmFzZSwgZmFsc2UpO1xuICAgIHdyaXRlUm9hZG1hcCh3b3JrdHJlZSwgdHJ1ZSk7XG4gICAgd3JpdGVDb21wbGV0ZVNsaWNlQXJ0aWZhY3RzKHdvcmt0cmVlKTtcbiAgICB3cml0ZUNvbXBsZXRlTWlsZXN0b25lU3VtbWFyeSh3b3JrdHJlZSk7XG4gICAgd3JpdGVQYXVzZWRTZXNzaW9uKGJhc2UsIFwiTTAwMVwiLCBmYWxzZSwgd29ya3RyZWUpO1xuXG4gICAgY29uc3QgYXNzZXNzbWVudCA9IGF3YWl0IGFzc2Vzc0ludGVycnVwdGVkU2Vzc2lvbihiYXNlKTtcbiAgICBhc3NlcnQuZXF1YWwoYXNzZXNzbWVudC5jbGFzc2lmaWNhdGlvbiwgXCJzdGFsZVwiKTtcbiAgICBhc3NlcnQuZXF1YWwoYXNzZXNzbWVudC5oYXNSZXN1bWFibGVEaXNrU3RhdGUsIGZhbHNlKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcImFzc2Vzc0ludGVycnVwdGVkU2Vzc2lvbiBrZWVwcyB1bmZpbmlzaGVkIGRlcml2ZWQgc3RhdGUgcmVjb3ZlcmFibGUgd2l0aG91dCB0cmFjZVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIHdyaXRlUm9hZG1hcChiYXNlLCBmYWxzZSk7XG4gICAgd3JpdGVUZXN0TG9jayhiYXNlLCBcInBsYW4tc2xpY2VcIiwgXCJNMDAxL1MwMVwiKTtcblxuICAgIGNvbnN0IGFzc2Vzc21lbnQgPSBhd2FpdCBhc3Nlc3NJbnRlcnJ1cHRlZFNlc3Npb24oYmFzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKGFzc2Vzc21lbnQuY2xhc3NpZmljYXRpb24sIFwicmVjb3ZlcmFibGVcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGFzc2Vzc21lbnQuaGFzUmVzdW1hYmxlRGlza1N0YXRlLCB0cnVlKTtcbiAgICBhc3NlcnQuZXF1YWwoYXNzZXNzbWVudC5yZWNvdmVyeVByb21wdCwgbnVsbCk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJhc3Nlc3NJbnRlcnJ1cHRlZFNlc3Npb24gcHJlc2VydmVzIGNyYXNoIHRyYWNlIHdoZW4gYWN0aXZpdHkgbG9nIGhhcyB0b29sIGNhbGxzXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgd3JpdGVSb2FkbWFwKGJhc2UsIGZhbHNlKTtcbiAgICB3cml0ZVRlc3RMb2NrKGJhc2UsIFwiZXhlY3V0ZS10YXNrXCIsIFwiTTAwMS9TMDEvVDAxXCIpO1xuICAgIHdyaXRlQWN0aXZpdHlMb2coYmFzZSwgW1xuICAgICAge1xuICAgICAgICB0eXBlOiBcIm1lc3NhZ2VcIixcbiAgICAgICAgbWVzc2FnZToge1xuICAgICAgICAgIHJvbGU6IFwiYXNzaXN0YW50XCIsXG4gICAgICAgICAgY29udGVudDogW1xuICAgICAgICAgICAge1xuICAgICAgICAgICAgICB0eXBlOiBcInRvb2xDYWxsXCIsXG4gICAgICAgICAgICAgIGlkOiBcIjFcIixcbiAgICAgICAgICAgICAgbmFtZTogXCJiYXNoXCIsXG4gICAgICAgICAgICAgIGFyZ3VtZW50czogeyBjb21tYW5kOiBcIm5wbSB0ZXN0XCIgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIHR5cGU6IFwibWVzc2FnZVwiLFxuICAgICAgICBtZXNzYWdlOiB7XG4gICAgICAgICAgcm9sZTogXCJ0b29sUmVzdWx0XCIsXG4gICAgICAgICAgdG9vbENhbGxJZDogXCIxXCIsXG4gICAgICAgICAgdG9vbE5hbWU6IFwiYmFzaFwiLFxuICAgICAgICAgIGlzRXJyb3I6IGZhbHNlLFxuICAgICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIm9rXCIgfV0sXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgIF0pO1xuXG4gICAgY29uc3QgYXNzZXNzbWVudCA9IGF3YWl0IGFzc2Vzc0ludGVycnVwdGVkU2Vzc2lvbihiYXNlKTtcbiAgICBhc3NlcnQuZXF1YWwoYXNzZXNzbWVudC5jbGFzc2lmaWNhdGlvbiwgXCJyZWNvdmVyYWJsZVwiKTtcbiAgICBhc3NlcnQub2soYXNzZXNzbWVudC5yZWNvdmVyeVRvb2xDYWxsQ291bnQgPiAwKTtcbiAgICBhc3NlcnQub2soYXNzZXNzbWVudC5yZWNvdmVyeVByb21wdD8uaW5jbHVkZXMoXCJSZWNvdmVyeSBCcmllZmluZ1wiKSk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJhc3Nlc3NJbnRlcnJ1cHRlZFNlc3Npb24gdHJlYXRzIGJvb3RzdHJhcCBjcmFzaCBhcyBzdGFsZSB3aXRob3V0IHBhdXNlZCBtZXRhZGF0YVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0cnkge1xuICAgIHdyaXRlVGVzdExvY2soYmFzZSwgXCJzdGFydGluZ1wiLCBcImJvb3RzdHJhcFwiKTtcblxuICAgIGNvbnN0IGFzc2Vzc21lbnQgPSBhd2FpdCBhc3Nlc3NJbnRlcnJ1cHRlZFNlc3Npb24oYmFzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKGFzc2Vzc21lbnQuY2xhc3NpZmljYXRpb24sIFwic3RhbGVcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGFzc2Vzc21lbnQuaXNCb290c3RyYXBDcmFzaCwgdHJ1ZSk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCB3cml0ZUxvY2sgLyByZWFkQ3Jhc2hMb2NrIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwid3JpdGVMb2NrIGNyZWF0ZXMgbG9jayBmaWxlIGFuZCByZWFkQ3Jhc2hMb2NrIHJlYWRzIGl0XCIsICh0KSA9PiB7XG4gIC8vIFBoYXNlIEMgcHQgMjogbG9jayBzdGF0ZSBpcyByZWNvbnN0cnVjdGVkIGZyb20gd29ya2VycyArIHVuaXRfZGlzcGF0Y2hlc1xuICAvLyArIHJ1bnRpbWVfa3YuIFRoZSBmcmVzaCB3b3JrZXIgaXMgbm90IHN0YWxlIHlldCBcdTIwMTQgd2UgcmVnaXN0ZXIsIGRpc3BhdGNoLFxuICAvLyB3cml0ZSB0aGUgc2Vzc2lvbl9maWxlLCB0aGVuIGV4cGlyZSB0aGUgaGVhcnRiZWF0IHRvIHNpbXVsYXRlIGEgY3Jhc2guXG4gIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXAoYmFzZSkpO1xuXG4gIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdFwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSk7XG4gIGNvbnN0IHByb2plY3RSb290ID0gbm9ybWFsaXplUmVhbFBhdGgoYmFzZSk7XG4gIGNvbnN0IHdvcmtlcklkID0gcmVnaXN0ZXJBdXRvV29ya2VyKHsgcHJvamVjdFJvb3RSZWFscGF0aDogcHJvamVjdFJvb3QgfSk7XG4gIGNvbnN0IGxlYXNlID0gY2xhaW1NaWxlc3RvbmVMZWFzZSh3b3JrZXJJZCwgXCJNMDAxXCIpO1xuICBhc3NlcnQuZXF1YWwobGVhc2Uub2ssIHRydWUpO1xuICBpZiAoIWxlYXNlLm9rKSByZXR1cm47XG4gIHJlY29yZERpc3BhdGNoQ2xhaW0oe1xuICAgIHRyYWNlSWQ6IFwidDFcIiwgd29ya2VySWQsIG1pbGVzdG9uZUxlYXNlVG9rZW46IGxlYXNlLnRva2VuLFxuICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdW5pdFR5cGU6IFwiZXhlY3V0ZS10YXNrXCIsIHVuaXRJZDogXCJNMDAxL1MwMS9UMDFcIixcbiAgfSk7XG4gIHdyaXRlTG9jayhiYXNlLCBcImV4ZWN1dGUtdGFza1wiLCBcIk0wMDEvUzAxL1QwMVwiLCBcIi90bXAvc2Vzc2lvbi5qc29ubFwiKTtcblxuICAvLyBGb3JjZSBzdGFsZSBzbyByZWFkQ3Jhc2hMb2NrIHN1cmZhY2VzIGl0LlxuICBfZ2V0QWRhcHRlcigpIS5wcmVwYXJlKFxuICAgIGBVUERBVEUgd29ya2VycyBTRVQgbGFzdF9oZWFydGJlYXRfYXQgPSAnMTk3MC0wMS0wMVQwMDowMDowMC4wMDBaJyBXSEVSRSB3b3JrZXJfaWQgPSA6d2AsXG4gICkucnVuKHsgXCI6d1wiOiB3b3JrZXJJZCB9KTtcblxuICBjb25zdCBsb2NrID0gcmVhZENyYXNoTG9jayhiYXNlKTtcbiAgYXNzZXJ0Lm9rKGxvY2ssIFwibG9jayBzaG91bGQgZXhpc3RcIik7XG4gIGFzc2VydC5lcXVhbChsb2NrIS51bml0VHlwZSwgXCJleGVjdXRlLXRhc2tcIik7XG4gIGFzc2VydC5lcXVhbChsb2NrIS51bml0SWQsIFwiTTAwMS9TMDEvVDAxXCIpO1xuICBhc3NlcnQuZXF1YWwobG9jayEuc2Vzc2lvbkZpbGUsIFwiL3RtcC9zZXNzaW9uLmpzb25sXCIpO1xuICBhc3NlcnQuZXF1YWwobG9jayEucGlkLCBwcm9jZXNzLnBpZCk7XG59KTtcblxudGVzdChcInJlYWRDcmFzaExvY2sgcmV0dXJucyBudWxsIHdoZW4gbm8gbG9jayBleGlzdHNcIiwgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChiYXNlKSk7XG5cbiAgY29uc3QgbG9jayA9IHJlYWRDcmFzaExvY2soYmFzZSk7XG4gIGFzc2VydC5lcXVhbChsb2NrLCBudWxsKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgY2xlYXJMb2NrIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiY2xlYXJMb2NrIHJlbW92ZXMgZXhpc3RpbmcgbG9jayBmaWxlXCIsICh0KSA9PiB7XG4gIC8vIFBoYXNlIEMgcHQgMjogY2xlYXJMb2NrIG5vdyBkcm9wcyB0aGUgc2Vzc2lvbl9maWxlIHJ1bnRpbWVfa3Ygcm93XG4gIC8vIGZvciB0aGUgTElWRSB3b3JrZXIgKG5vdCB0aGUgc3RhbGUgb25lKS4gVGhlIFwibG9jayBzdGF0ZVwiIGl0c2VsZlxuICAvLyAocGlkLCB1bml0VHlwZSwgZXRjLikgbGl2ZXMgaW4gd29ya2VycyArIHVuaXRfZGlzcGF0Y2hlczsgdGhvc2UgYXJlXG4gIC8vIG1hbmFnZWQgYnkgbWFya1dvcmtlclN0b3BwaW5nIChjYWxsZWQgZnJvbSBzdG9wQXV0bywgbm90IGhlcmUpLlxuICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgdC5hZnRlcigoKSA9PiBjbGVhbnVwKGJhc2UpKTtcblxuICBjb25zdCBwcm9qZWN0Um9vdCA9IG5vcm1hbGl6ZVJlYWxQYXRoKGJhc2UpO1xuICBjb25zdCB3b3JrZXJJZCA9IHJlZ2lzdGVyQXV0b1dvcmtlcih7IHByb2plY3RSb290UmVhbHBhdGg6IHByb2plY3RSb290IH0pO1xuXG4gIHdyaXRlTG9jayhiYXNlLCBcInBsYW4tc2xpY2VcIiwgXCJNMDAxL1MwMVwiLCBcIi90bXAvc2Vzc2lvbi5qc29ubFwiKTtcbiAgLy8gQ29uZmlybSB0aGUgc2Vzc2lvbl9maWxlIHJvdyBsYW5kZWQgZm9yIHRoZSBsaXZlIHdvcmtlci5cbiAgY29uc3QgYWRhcHRlciA9IF9nZXRBZGFwdGVyKCkhO1xuICBjb25zdCBiZWZvcmUgPSBhZGFwdGVyLnByZXBhcmUoXG4gICAgYFNFTEVDVCAxIEZST00gcnVudGltZV9rdiBXSEVSRSBzY29wZSA9ICd3b3JrZXInIEFORCBzY29wZV9pZCA9IDp3IEFORCBrZXkgPSAnc2Vzc2lvbl9maWxlJ2AsXG4gICkuZ2V0KHsgXCI6d1wiOiB3b3JrZXJJZCB9KTtcbiAgYXNzZXJ0Lm9rKGJlZm9yZSwgXCJzZXNzaW9uX2ZpbGUgcm93IGV4aXN0cyBiZWZvcmUgY2xlYXJcIik7XG5cbiAgY2xlYXJMb2NrKGJhc2UpO1xuXG4gIGNvbnN0IGFmdGVyID0gYWRhcHRlci5wcmVwYXJlKFxuICAgIGBTRUxFQ1QgMSBGUk9NIHJ1bnRpbWVfa3YgV0hFUkUgc2NvcGUgPSAnd29ya2VyJyBBTkQgc2NvcGVfaWQgPSA6dyBBTkQga2V5ID0gJ3Nlc3Npb25fZmlsZSdgLFxuICApLmdldCh7IFwiOndcIjogd29ya2VySWQgfSk7XG4gIGFzc2VydC5lcXVhbChhZnRlciwgdW5kZWZpbmVkLCBcInNlc3Npb25fZmlsZSByb3cgZ29uZSBhZnRlciBjbGVhckxvY2tcIik7XG59KTtcblxudGVzdChcImNsZWFyTG9jayBpcyBzYWZlIHdoZW4gbm8gbG9jayBleGlzdHNcIiwgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChiYXNlKSk7XG5cbiAgYXNzZXJ0LmRvZXNOb3RUaHJvdygoKSA9PiBjbGVhckxvY2soYmFzZSkpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBpc0xvY2tQcm9jZXNzQWxpdmUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCIjMjQ3MDogaXNMb2NrUHJvY2Vzc0FsaXZlIHJldHVybnMgdHJ1ZSBmb3Igb3duIFBJRCAod2UgaG9sZCB0aGUgbG9jaylcIiwgKCkgPT4ge1xuICAvLyBPd24gUElEIG1lYW5zIHdlIEFSRSB0aGUgbG9jayBob2xkZXIgXHUyMDE0IGFsaXZlLCBub3Qgc3RhbGUuICgjMjQ3MClcbiAgLy8gQ2FsbGVycyB0aGF0IG5lZWQgcmVjeWNsZWQtUElEIGRldGVjdGlvbiAoZS5nLiBzdGFydEF1dG8pIGFscmVhZHlcbiAgLy8gZ3VhcmQgd2l0aCBgY3Jhc2hMb2NrLnBpZCAhPT0gcHJvY2Vzcy5waWRgIGJlZm9yZSBjYWxsaW5nIHVzLlxuICBjb25zdCBsb2NrOiBMb2NrRGF0YSA9IHtcbiAgICBwaWQ6IHByb2Nlc3MucGlkLFxuICAgIHN0YXJ0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgIHVuaXRUeXBlOiBcImV4ZWN1dGUtdGFza1wiLFxuICAgIHVuaXRJZDogXCJNMDAxL1MwMS9UMDFcIixcbiAgICB1bml0U3RhcnRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gIH07XG4gIGFzc2VydC5lcXVhbChpc0xvY2tQcm9jZXNzQWxpdmUobG9jayksIHRydWUsIFwib3duIFBJRCBzaG91bGQgcmV0dXJuIHRydWUgXHUyMDE0IHdlIGFyZSBhbGl2ZVwiKTtcbn0pO1xuXG50ZXN0KFwiaXNMb2NrUHJvY2Vzc0FsaXZlIHJldHVybnMgZmFsc2UgZm9yIGRlYWQgUElEXCIsICgpID0+IHtcbiAgY29uc3QgbG9jazogTG9ja0RhdGEgPSB7XG4gICAgcGlkOiA5OTk5OTk5OTksXG4gICAgc3RhcnRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgdW5pdFR5cGU6IFwiZXhlY3V0ZS10YXNrXCIsXG4gICAgdW5pdElkOiBcIk0wMDEvUzAxL1QwMVwiLFxuICAgIHVuaXRTdGFydGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgfTtcbiAgYXNzZXJ0LmVxdWFsKGlzTG9ja1Byb2Nlc3NBbGl2ZShsb2NrKSwgZmFsc2UpO1xufSk7XG5cbnRlc3QoXCJpc0xvY2tQcm9jZXNzQWxpdmUgcmV0dXJucyBmYWxzZSBmb3IgaW52YWxpZCBQSURzXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZTogT21pdDxMb2NrRGF0YSwgXCJwaWRcIj4gPSB7XG4gICAgc3RhcnRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgdW5pdFR5cGU6IFwieFwiLFxuICAgIHVuaXRJZDogXCJ4XCIsXG4gICAgdW5pdFN0YXJ0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICB9O1xuICBhc3NlcnQuZXF1YWwoaXNMb2NrUHJvY2Vzc0FsaXZlKHsgLi4uYmFzZSwgcGlkOiAwIH0gYXMgTG9ja0RhdGEpLCBmYWxzZSk7XG4gIGFzc2VydC5lcXVhbChpc0xvY2tQcm9jZXNzQWxpdmUoeyAuLi5iYXNlLCBwaWQ6IC0xIH0gYXMgTG9ja0RhdGEpLCBmYWxzZSk7XG4gIGFzc2VydC5lcXVhbChpc0xvY2tQcm9jZXNzQWxpdmUoeyAuLi5iYXNlLCBwaWQ6IDEuNSB9IGFzIExvY2tEYXRhKSwgZmFsc2UpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBmb3JtYXRDcmFzaEluZm8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJmb3JtYXRDcmFzaEluZm8gaW5jbHVkZXMgdW5pdCB0eXBlLCBpZCwgYW5kIFBJRFwiLCAoKSA9PiB7XG4gIGNvbnN0IGxvY2s6IExvY2tEYXRhID0ge1xuICAgIHBpZDogMTIzNDUsXG4gICAgc3RhcnRlZEF0OiBcIjIwMjUtMDEtMDFUMDA6MDA6MDAuMDAwWlwiLFxuICAgIHVuaXRUeXBlOiBcImNvbXBsZXRlLXNsaWNlXCIsXG4gICAgdW5pdElkOiBcIk0wMDIvUzAzXCIsXG4gICAgdW5pdFN0YXJ0ZWRBdDogXCIyMDI1LTAxLTAxVDAwOjAxOjAwLjAwMFpcIixcbiAgfTtcbiAgY29uc3QgaW5mbyA9IGZvcm1hdENyYXNoSW5mbyhsb2NrKTtcbiAgYXNzZXJ0Lm9rKGluZm8uaW5jbHVkZXMoXCJjb21wbGV0ZS1zbGljZVwiKSk7XG4gIGFzc2VydC5vayhpbmZvLmluY2x1ZGVzKFwiTTAwMi9TMDNcIikpO1xuICBhc3NlcnQub2soaW5mby5pbmNsdWRlcyhcIjEyMzQ1XCIpKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUNuQixTQUFTLFlBQVksV0FBVyxRQUFRLHFCQUFxQjtBQUM3RCxTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsa0JBQWtCO0FBRTNCO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUVLO0FBQ1A7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFDUDtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1AsU0FBUywwQkFBMEI7QUFDbkMsU0FBUywyQkFBMkI7QUFDcEMsU0FB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
