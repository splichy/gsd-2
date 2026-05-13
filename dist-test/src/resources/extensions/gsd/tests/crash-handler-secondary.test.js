import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { installEpipeGuard } from "../bootstrap/register-extension.js";
function makeTmpBase() {
  const base = join(tmpdir(), `gsd-test-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}
describe("register-extension crash handler secondary fixes (#3348)", () => {
  test("writeCrashLog is exported and writes a file to the crash directory", async () => {
    const tmpHome = join(tmpdir(), `gsd-crash-test-${randomUUID()}`);
    const origHome = process.env.GSD_HOME;
    process.env.GSD_HOME = tmpHome;
    try {
      const { writeCrashLog } = await import("../bootstrap/crash-log.js");
      const err = new Error("test crash from secondary regression test");
      writeCrashLog(err, "uncaughtException");
      const crashDir = join(tmpHome, "crash");
      assert.ok(existsSync(crashDir), "crash directory should be created");
      const logs = readdirSync(crashDir).filter((f) => f.endsWith(".log"));
      assert.equal(logs.length, 1, "exactly one crash log should be written");
      const content = readFileSync(join(crashDir, logs[0]), "utf-8");
      assert.ok(content.includes("test crash from secondary regression test"), "log should contain error message");
      assert.ok(content.includes("uncaughtException"), "log should identify the source");
      assert.ok(content.includes("pid:"), "log should include process pid");
    } finally {
      process.env.GSD_HOME = origHome;
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
  test("_gsdRejectionGuard is registered for unhandledRejection", () => {
    installEpipeGuard();
    const listener = process.listeners("unhandledRejection").find(
      (candidate) => candidate.name === "_gsdRejectionGuard"
    );
    assert.ok(listener, "installEpipeGuard should register an unhandledRejection handler");
  });
  test("_gsdEpipeGuard writes a crash log and exits for unrecoverable errors", () => {
    installEpipeGuard();
    const listener = process.listeners("uncaughtException").find(
      (candidate) => candidate.name === "_gsdEpipeGuard"
    );
    assert.ok(listener, "_gsdEpipeGuard should be registered");
    const tmpHome = join(tmpdir(), `gsd-crash-exit-test-${randomUUID()}`);
    const origHome = process.env.GSD_HOME;
    const originalExit = process.exit;
    let exitCode;
    process.exit = (code) => {
      exitCode = code;
      throw new Error("process.exit intercepted");
    };
    process.env.GSD_HOME = tmpHome;
    try {
      assert.throws(
        () => listener(new Error("unrecoverable crash guard test"), "uncaughtException"),
        /process\.exit intercepted/
      );
      assert.equal(exitCode, 1);
      const crashDir = join(tmpHome, "crash");
      const logs = readdirSync(crashDir).filter((f) => f.endsWith(".log"));
      assert.equal(logs.length, 1);
      assert.match(readFileSync(join(crashDir, logs[0]), "utf-8"), /unrecoverable crash guard test/);
    } finally {
      process.exit = originalExit;
      process.env.GSD_HOME = origHome;
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
  test("writeCrashLog never throws even when directory is unwritable", async () => {
    const { writeCrashLog } = await import("../bootstrap/crash-log.js");
    const origHome = process.env.GSD_HOME;
    const tmpFile = join(tmpdir(), `gsd-not-a-dir-${randomUUID()}`);
    process.env.GSD_HOME = join(tmpFile, "nested", "deeply");
    try {
      assert.doesNotThrow(() => {
        writeCrashLog(new Error("should not throw"), "test");
      });
    } finally {
      process.env.GSD_HOME = origHome;
    }
  });
});
describe("emitCrashRecoveredUnitEnd (#3348)", () => {
  test("emits synthetic unit-end when unit-start has no matching unit-end", async () => {
    const base = makeTmpBase();
    try {
      const { emitJournalEvent, queryJournal } = await import("../journal.js");
      const { emitCrashRecoveredUnitEnd } = await import("../crash-recovery.js");
      const flowId = randomUUID();
      const unitStartSeq = 5;
      emitJournalEvent(base, {
        ts: (/* @__PURE__ */ new Date()).toISOString(),
        flowId,
        seq: unitStartSeq,
        eventType: "unit-start",
        data: { unitType: "execute-task", unitId: "M001/S01/T01" }
      });
      const lock = {
        pid: 99999,
        startedAt: (/* @__PURE__ */ new Date()).toISOString(),
        unitType: "execute-task",
        unitId: "M001/S01/T01",
        unitStartedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      emitCrashRecoveredUnitEnd(base, lock);
      const events = queryJournal(base);
      const ends = events.filter((e) => e.eventType === "unit-end");
      assert.equal(ends.length, 1, "should emit exactly one unit-end");
      assert.equal(ends[0].data?.unitId, "M001/S01/T01");
      assert.equal(ends[0].data?.status, "crash-recovered");
      assert.equal(ends[0].causedBy?.flowId, flowId);
      assert.equal(ends[0].causedBy?.seq, unitStartSeq);
      assert.ok(ends[0].seq > unitStartSeq, "unit-end seq must be higher than unit-start seq");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("is a no-op when unit-end was already emitted (e.g. hard timeout fired)", async () => {
    const base = makeTmpBase();
    try {
      const { emitJournalEvent, queryJournal } = await import("../journal.js");
      const { emitCrashRecoveredUnitEnd } = await import("../crash-recovery.js");
      const flowId = randomUUID();
      emitJournalEvent(base, {
        ts: (/* @__PURE__ */ new Date()).toISOString(),
        flowId,
        seq: 3,
        eventType: "unit-start",
        data: { unitType: "plan-slice", unitId: "M001/S02" }
      });
      emitJournalEvent(base, {
        ts: (/* @__PURE__ */ new Date()).toISOString(),
        flowId,
        seq: 4,
        eventType: "unit-end",
        data: { unitType: "plan-slice", unitId: "M001/S02", status: "cancelled" },
        causedBy: { flowId, seq: 3 }
      });
      const lock = {
        pid: 99999,
        startedAt: (/* @__PURE__ */ new Date()).toISOString(),
        unitType: "plan-slice",
        unitId: "M001/S02",
        unitStartedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      emitCrashRecoveredUnitEnd(base, lock);
      const ends = queryJournal(base).filter((e) => e.eventType === "unit-end");
      assert.equal(ends.length, 1, "should not emit a duplicate unit-end");
      assert.equal(ends[0].data?.status, "cancelled", "original unit-end should be preserved");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  test('is a no-op for "starting" pseudo-units (bootstrap crash)', async () => {
    const base = makeTmpBase();
    try {
      const { queryJournal } = await import("../journal.js");
      const { emitCrashRecoveredUnitEnd } = await import("../crash-recovery.js");
      const lock = {
        pid: 99999,
        startedAt: (/* @__PURE__ */ new Date()).toISOString(),
        unitType: "starting",
        unitId: "bootstrap",
        unitStartedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      emitCrashRecoveredUnitEnd(base, lock);
      const events = queryJournal(base);
      assert.equal(events.length, 0, "should emit nothing for starting/bootstrap pseudo-units");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("is a no-op when no unit-start exists in the journal", async () => {
    const base = makeTmpBase();
    try {
      const { queryJournal } = await import("../journal.js");
      const { emitCrashRecoveredUnitEnd } = await import("../crash-recovery.js");
      const lock = {
        pid: 99999,
        startedAt: (/* @__PURE__ */ new Date()).toISOString(),
        unitType: "execute-task",
        unitId: "M002/S01/T03",
        unitStartedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      emitCrashRecoveredUnitEnd(base, lock);
      const events = queryJournal(base);
      assert.equal(events.length, 0, "should emit nothing when there is no journal entry to close");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("emitOpenUnitEndForUnit closes the latest open start with error context", async () => {
    const base = makeTmpBase();
    try {
      const { emitJournalEvent, queryJournal } = await import("../journal.js");
      const { emitOpenUnitEndForUnit } = await import("../crash-recovery.js");
      const firstFlowId = randomUUID();
      const secondFlowId = randomUUID();
      emitJournalEvent(base, {
        ts: (/* @__PURE__ */ new Date()).toISOString(),
        flowId: firstFlowId,
        seq: 1,
        eventType: "unit-start",
        data: { unitType: "execute-task", unitId: "M008/S04/T02" }
      });
      emitJournalEvent(base, {
        ts: (/* @__PURE__ */ new Date()).toISOString(),
        flowId: firstFlowId,
        seq: 2,
        eventType: "unit-end",
        data: { unitType: "execute-task", unitId: "M008/S04/T02", status: "completed" },
        causedBy: { flowId: firstFlowId, seq: 1 }
      });
      emitJournalEvent(base, {
        ts: (/* @__PURE__ */ new Date()).toISOString(),
        flowId: secondFlowId,
        seq: 3,
        eventType: "unit-start",
        data: { unitType: "execute-task", unitId: "M008/S04/T02" }
      });
      const emitted = emitOpenUnitEndForUnit(
        base,
        "execute-task",
        "M008/S04/T02",
        "cancelled",
        { message: "runUnitPhase exploded", category: "unit-exception", isTransient: false }
      );
      assert.equal(emitted, true, "open unit should be closed");
      const ends = queryJournal(base).filter((e) => e.eventType === "unit-end");
      assert.equal(ends.length, 2, "should preserve existing end and add one new end");
      const newEnd = ends.find((e) => e.causedBy?.flowId === secondFlowId);
      assert.ok(newEnd, "new end should close the latest open start");
      assert.equal(newEnd.data?.status, "cancelled");
      assert.deepEqual(newEnd.data?.errorContext, {
        message: "runUnitPhase exploded",
        category: "unit-exception",
        isTransient: false
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jcmFzaC1oYW5kbGVyLXNlY29uZGFyeS50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFJlZ3Jlc3Npb24gdGVzdHMgZm9yICMzMzQ4IHNlY29uZGFyeSBpc3N1ZXMgXHUyMDE0IGNyYXNoIGhhbmRsZXIgZ2FwcyBzdXJmYWNlZCBhZnRlciAjMzY5NlxuICpcbiAqIDEuIHJlZ2lzdGVyLWV4dGVuc2lvbi50czogd3JpdGVDcmFzaExvZyB3cml0ZXMgdG8gfi8uZ3NkL2NyYXNoLyBkaXJlY3RvcnlcbiAqIDIuIHJlZ2lzdGVyLWV4dGVuc2lvbi50czogX2dzZFJlamVjdGlvbkd1YXJkIHJlZ2lzdGVyZWQgZm9yIHVuaGFuZGxlZFJlamVjdGlvblxuICogMy4gcmVnaXN0ZXItZXh0ZW5zaW9uLnRzOiBfZ3NkRXBpcGVHdWFyZCBleGl0cyB3aXRoIGNvZGUgMSBmb3IgdW5yZWNvdmVyYWJsZSBlcnJvcnMgKG5vIGxvZy1hbmQtY29udGludWUpXG4gKiA0LiBjcmFzaC1yZWNvdmVyeS50czogZW1pdENyYXNoUmVjb3ZlcmVkVW5pdEVuZCBjbG9zZXMgb3BlbiB1bml0LXN0YXJ0IGpvdXJuYWwgZW50cmllc1xuICovXG5cbmltcG9ydCB7IGRlc2NyaWJlLCB0ZXN0IH0gZnJvbSAnbm9kZTp0ZXN0JztcbmltcG9ydCBhc3NlcnQgZnJvbSAnbm9kZTphc3NlcnQvc3RyaWN0JztcbmltcG9ydCB7IGV4aXN0c1N5bmMsIG1rZGlyU3luYywgcmVhZEZpbGVTeW5jLCByZWFkZGlyU3luYywgcm1TeW5jIH0gZnJvbSAnbm9kZTpmcyc7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJztcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gJ25vZGU6b3MnO1xuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gJ25vZGU6Y3J5cHRvJztcblxuaW1wb3J0IHsgaW5zdGFsbEVwaXBlR3VhcmQgfSBmcm9tIFwiLi4vYm9vdHN0cmFwL3JlZ2lzdGVyLWV4dGVuc2lvbi50c1wiO1xuXG5mdW5jdGlvbiBtYWtlVG1wQmFzZSgpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gam9pbih0bXBkaXIoKSwgYGdzZC10ZXN0LSR7cmFuZG9tVVVJRCgpfWApO1xuICBta2RpclN5bmMoam9pbihiYXNlLCAnLmdzZCcpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgcmV0dXJuIGJhc2U7XG59XG5cbmRlc2NyaWJlKCdyZWdpc3Rlci1leHRlbnNpb24gY3Jhc2ggaGFuZGxlciBzZWNvbmRhcnkgZml4ZXMgKCMzMzQ4KScsICgpID0+IHtcbiAgdGVzdCgnd3JpdGVDcmFzaExvZyBpcyBleHBvcnRlZCBhbmQgd3JpdGVzIGEgZmlsZSB0byB0aGUgY3Jhc2ggZGlyZWN0b3J5JywgYXN5bmMgKCkgPT4ge1xuICAgIC8vIER5bmFtaWMgaW1wb3J0IHNvIEdTRF9IT01FIGNhbiBiZSBwb2ludGVkIGF0IGEgdGVtcCBkaXIgd2l0aG91dCBwb2xsdXRpbmcgfi8uZ3NkXG4gICAgY29uc3QgdG1wSG9tZSA9IGpvaW4odG1wZGlyKCksIGBnc2QtY3Jhc2gtdGVzdC0ke3JhbmRvbVVVSUQoKX1gKTtcbiAgICBjb25zdCBvcmlnSG9tZSA9IHByb2Nlc3MuZW52LkdTRF9IT01FO1xuICAgIHByb2Nlc3MuZW52LkdTRF9IT01FID0gdG1wSG9tZTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgeyB3cml0ZUNyYXNoTG9nIH0gPSBhd2FpdCBpbXBvcnQoJy4uL2Jvb3RzdHJhcC9jcmFzaC1sb2cudHMnKTtcbiAgICAgIGNvbnN0IGVyciA9IG5ldyBFcnJvcigndGVzdCBjcmFzaCBmcm9tIHNlY29uZGFyeSByZWdyZXNzaW9uIHRlc3QnKTtcbiAgICAgIHdyaXRlQ3Jhc2hMb2coZXJyLCAndW5jYXVnaHRFeGNlcHRpb24nKTtcblxuICAgICAgY29uc3QgY3Jhc2hEaXIgPSBqb2luKHRtcEhvbWUsICdjcmFzaCcpO1xuICAgICAgYXNzZXJ0Lm9rKGV4aXN0c1N5bmMoY3Jhc2hEaXIpLCAnY3Jhc2ggZGlyZWN0b3J5IHNob3VsZCBiZSBjcmVhdGVkJyk7XG5cbiAgICAgIGNvbnN0IGxvZ3MgPSByZWFkZGlyU3luYyhjcmFzaERpcikuZmlsdGVyKChmKSA9PiBmLmVuZHNXaXRoKCcubG9nJykpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGxvZ3MubGVuZ3RoLCAxLCAnZXhhY3RseSBvbmUgY3Jhc2ggbG9nIHNob3VsZCBiZSB3cml0dGVuJyk7XG5cbiAgICAgIGNvbnN0IGNvbnRlbnQgPSByZWFkRmlsZVN5bmMoam9pbihjcmFzaERpciwgbG9nc1swXSksICd1dGYtOCcpO1xuICAgICAgYXNzZXJ0Lm9rKGNvbnRlbnQuaW5jbHVkZXMoJ3Rlc3QgY3Jhc2ggZnJvbSBzZWNvbmRhcnkgcmVncmVzc2lvbiB0ZXN0JyksICdsb2cgc2hvdWxkIGNvbnRhaW4gZXJyb3IgbWVzc2FnZScpO1xuICAgICAgYXNzZXJ0Lm9rKGNvbnRlbnQuaW5jbHVkZXMoJ3VuY2F1Z2h0RXhjZXB0aW9uJyksICdsb2cgc2hvdWxkIGlkZW50aWZ5IHRoZSBzb3VyY2UnKTtcbiAgICAgIGFzc2VydC5vayhjb250ZW50LmluY2x1ZGVzKCdwaWQ6JyksICdsb2cgc2hvdWxkIGluY2x1ZGUgcHJvY2VzcyBwaWQnKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcHJvY2Vzcy5lbnYuR1NEX0hPTUUgPSBvcmlnSG9tZTtcbiAgICAgIHJtU3luYyh0bXBIb21lLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KCdfZ3NkUmVqZWN0aW9uR3VhcmQgaXMgcmVnaXN0ZXJlZCBmb3IgdW5oYW5kbGVkUmVqZWN0aW9uJywgKCkgPT4ge1xuICAgIGluc3RhbGxFcGlwZUd1YXJkKCk7XG4gICAgY29uc3QgbGlzdGVuZXIgPSBwcm9jZXNzLmxpc3RlbmVycyhcInVuaGFuZGxlZFJlamVjdGlvblwiKS5maW5kKChjYW5kaWRhdGUpID0+XG4gICAgICBjYW5kaWRhdGUubmFtZSA9PT0gXCJfZ3NkUmVqZWN0aW9uR3VhcmRcIlxuICAgICk7XG4gICAgYXNzZXJ0Lm9rKGxpc3RlbmVyLCAnaW5zdGFsbEVwaXBlR3VhcmQgc2hvdWxkIHJlZ2lzdGVyIGFuIHVuaGFuZGxlZFJlamVjdGlvbiBoYW5kbGVyJyk7XG4gIH0pO1xuXG4gIHRlc3QoJ19nc2RFcGlwZUd1YXJkIHdyaXRlcyBhIGNyYXNoIGxvZyBhbmQgZXhpdHMgZm9yIHVucmVjb3ZlcmFibGUgZXJyb3JzJywgKCkgPT4ge1xuICAgIGluc3RhbGxFcGlwZUd1YXJkKCk7XG4gICAgY29uc3QgbGlzdGVuZXIgPSBwcm9jZXNzLmxpc3RlbmVycyhcInVuY2F1Z2h0RXhjZXB0aW9uXCIpLmZpbmQoKGNhbmRpZGF0ZSkgPT5cbiAgICAgIGNhbmRpZGF0ZS5uYW1lID09PSBcIl9nc2RFcGlwZUd1YXJkXCJcbiAgICApO1xuICAgIGFzc2VydC5vayhsaXN0ZW5lciwgJ19nc2RFcGlwZUd1YXJkIHNob3VsZCBiZSByZWdpc3RlcmVkJyk7XG5cbiAgICBjb25zdCB0bXBIb21lID0gam9pbih0bXBkaXIoKSwgYGdzZC1jcmFzaC1leGl0LXRlc3QtJHtyYW5kb21VVUlEKCl9YCk7XG4gICAgY29uc3Qgb3JpZ0hvbWUgPSBwcm9jZXNzLmVudi5HU0RfSE9NRTtcbiAgICBjb25zdCBvcmlnaW5hbEV4aXQgPSBwcm9jZXNzLmV4aXQ7XG4gICAgbGV0IGV4aXRDb2RlOiBudW1iZXIgfCBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkO1xuICAgIChwcm9jZXNzIGFzIGFueSkuZXhpdCA9IChjb2RlPzogbnVtYmVyIHwgc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCk6IG5ldmVyID0+IHtcbiAgICAgIGV4aXRDb2RlID0gY29kZTtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcInByb2Nlc3MuZXhpdCBpbnRlcmNlcHRlZFwiKTtcbiAgICB9O1xuICAgIHByb2Nlc3MuZW52LkdTRF9IT01FID0gdG1wSG9tZTtcbiAgICB0cnkge1xuICAgICAgYXNzZXJ0LnRocm93cyhcbiAgICAgICAgKCkgPT4gbGlzdGVuZXIobmV3IEVycm9yKFwidW5yZWNvdmVyYWJsZSBjcmFzaCBndWFyZCB0ZXN0XCIpLCBcInVuY2F1Z2h0RXhjZXB0aW9uXCIpLFxuICAgICAgICAvcHJvY2Vzc1xcLmV4aXQgaW50ZXJjZXB0ZWQvLFxuICAgICAgKTtcbiAgICAgIGFzc2VydC5lcXVhbChleGl0Q29kZSwgMSk7XG4gICAgICBjb25zdCBjcmFzaERpciA9IGpvaW4odG1wSG9tZSwgXCJjcmFzaFwiKTtcbiAgICAgIGNvbnN0IGxvZ3MgPSByZWFkZGlyU3luYyhjcmFzaERpcikuZmlsdGVyKChmKSA9PiBmLmVuZHNXaXRoKFwiLmxvZ1wiKSk7XG4gICAgICBhc3NlcnQuZXF1YWwobG9ncy5sZW5ndGgsIDEpO1xuICAgICAgYXNzZXJ0Lm1hdGNoKHJlYWRGaWxlU3luYyhqb2luKGNyYXNoRGlyLCBsb2dzWzBdKSwgXCJ1dGYtOFwiKSwgL3VucmVjb3ZlcmFibGUgY3Jhc2ggZ3VhcmQgdGVzdC8pO1xuICAgIH0gZmluYWxseSB7XG4gICAgICAocHJvY2VzcyBhcyBhbnkpLmV4aXQgPSBvcmlnaW5hbEV4aXQ7XG4gICAgICBwcm9jZXNzLmVudi5HU0RfSE9NRSA9IG9yaWdIb21lO1xuICAgICAgcm1TeW5jKHRtcEhvbWUsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoJ3dyaXRlQ3Jhc2hMb2cgbmV2ZXIgdGhyb3dzIGV2ZW4gd2hlbiBkaXJlY3RvcnkgaXMgdW53cml0YWJsZScsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB7IHdyaXRlQ3Jhc2hMb2cgfSA9IGF3YWl0IGltcG9ydCgnLi4vYm9vdHN0cmFwL2NyYXNoLWxvZy50cycpO1xuICAgIGNvbnN0IG9yaWdIb21lID0gcHJvY2Vzcy5lbnYuR1NEX0hPTUU7XG4gICAgLy8gUG9pbnQgYXQgYSBwYXRoIHRoYXQgd2lsbCBmYWlsIHRvIG1rZGlyIChlLmcuIGEgZmlsZSB0aGF0IGV4aXN0cyBhcyBub24tZGlyKVxuICAgIGNvbnN0IHRtcEZpbGUgPSBqb2luKHRtcGRpcigpLCBgZ3NkLW5vdC1hLWRpci0ke3JhbmRvbVVVSUQoKX1gKTtcbiAgICAvLyBEb24ndCBjcmVhdGUgaXQgXHUyMDE0IG1rZGlyU3luYyB3aXRoIGJhZCBwYXRoIHNob3VsZCBiZSBjYXVnaHQgaW50ZXJuYWxseVxuICAgIHByb2Nlc3MuZW52LkdTRF9IT01FID0gam9pbih0bXBGaWxlLCAnbmVzdGVkJywgJ2RlZXBseScpO1xuICAgIHRyeSB7XG4gICAgICAvLyBTaG91bGQgbm90IHRocm93XG4gICAgICBhc3NlcnQuZG9lc05vdFRocm93KCgpID0+IHtcbiAgICAgICAgd3JpdGVDcmFzaExvZyhuZXcgRXJyb3IoJ3Nob3VsZCBub3QgdGhyb3cnKSwgJ3Rlc3QnKTtcbiAgICAgIH0pO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBwcm9jZXNzLmVudi5HU0RfSE9NRSA9IG9yaWdIb21lO1xuICAgIH1cbiAgfSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGVtaXRDcmFzaFJlY292ZXJlZFVuaXRFbmQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKCdlbWl0Q3Jhc2hSZWNvdmVyZWRVbml0RW5kICgjMzM0OCknLCAoKSA9PiB7XG4gIHRlc3QoJ2VtaXRzIHN5bnRoZXRpYyB1bml0LWVuZCB3aGVuIHVuaXQtc3RhcnQgaGFzIG5vIG1hdGNoaW5nIHVuaXQtZW5kJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB7IGVtaXRKb3VybmFsRXZlbnQsIHF1ZXJ5Sm91cm5hbCB9ID0gYXdhaXQgaW1wb3J0KCcuLi9qb3VybmFsLnRzJyk7XG4gICAgICBjb25zdCB7IGVtaXRDcmFzaFJlY292ZXJlZFVuaXRFbmQgfSA9IGF3YWl0IGltcG9ydCgnLi4vY3Jhc2gtcmVjb3ZlcnkudHMnKTtcblxuICAgICAgY29uc3QgZmxvd0lkID0gcmFuZG9tVVVJRCgpO1xuICAgICAgY29uc3QgdW5pdFN0YXJ0U2VxID0gNTtcblxuICAgICAgLy8gRW1pdCBhIHVuaXQtc3RhcnQgd2l0aCBubyBjb3JyZXNwb25kaW5nIHVuaXQtZW5kIChzaW11bGF0aW5nIGEgY3Jhc2gpXG4gICAgICBlbWl0Sm91cm5hbEV2ZW50KGJhc2UsIHtcbiAgICAgICAgdHM6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgZmxvd0lkLFxuICAgICAgICBzZXE6IHVuaXRTdGFydFNlcSxcbiAgICAgICAgZXZlbnRUeXBlOiAndW5pdC1zdGFydCcsXG4gICAgICAgIGRhdGE6IHsgdW5pdFR5cGU6ICdleGVjdXRlLXRhc2snLCB1bml0SWQ6ICdNMDAxL1MwMS9UMDEnIH0sXG4gICAgICB9KTtcblxuICAgICAgY29uc3QgbG9jayA9IHtcbiAgICAgICAgcGlkOiA5OTk5OSxcbiAgICAgICAgc3RhcnRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICAgIHVuaXRUeXBlOiAnZXhlY3V0ZS10YXNrJyxcbiAgICAgICAgdW5pdElkOiAnTTAwMS9TMDEvVDAxJyxcbiAgICAgICAgdW5pdFN0YXJ0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgfTtcblxuICAgICAgZW1pdENyYXNoUmVjb3ZlcmVkVW5pdEVuZChiYXNlLCBsb2NrKTtcblxuICAgICAgY29uc3QgZXZlbnRzID0gcXVlcnlKb3VybmFsKGJhc2UpO1xuICAgICAgY29uc3QgZW5kcyA9IGV2ZW50cy5maWx0ZXIoKGUpID0+IGUuZXZlbnRUeXBlID09PSAndW5pdC1lbmQnKTtcbiAgICAgIGFzc2VydC5lcXVhbChlbmRzLmxlbmd0aCwgMSwgJ3Nob3VsZCBlbWl0IGV4YWN0bHkgb25lIHVuaXQtZW5kJyk7XG4gICAgICBhc3NlcnQuZXF1YWwoZW5kc1swXS5kYXRhPy51bml0SWQsICdNMDAxL1MwMS9UMDEnKTtcbiAgICAgIGFzc2VydC5lcXVhbChlbmRzWzBdLmRhdGE/LnN0YXR1cywgJ2NyYXNoLXJlY292ZXJlZCcpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGVuZHNbMF0uY2F1c2VkQnk/LmZsb3dJZCwgZmxvd0lkKTtcbiAgICAgIGFzc2VydC5lcXVhbChlbmRzWzBdLmNhdXNlZEJ5Py5zZXEsIHVuaXRTdGFydFNlcSk7XG4gICAgICBhc3NlcnQub2soZW5kc1swXS5zZXEgPiB1bml0U3RhcnRTZXEsICd1bml0LWVuZCBzZXEgbXVzdCBiZSBoaWdoZXIgdGhhbiB1bml0LXN0YXJ0IHNlcScpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdCgnaXMgYSBuby1vcCB3aGVuIHVuaXQtZW5kIHdhcyBhbHJlYWR5IGVtaXR0ZWQgKGUuZy4gaGFyZCB0aW1lb3V0IGZpcmVkKScsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgeyBlbWl0Sm91cm5hbEV2ZW50LCBxdWVyeUpvdXJuYWwgfSA9IGF3YWl0IGltcG9ydCgnLi4vam91cm5hbC50cycpO1xuICAgICAgY29uc3QgeyBlbWl0Q3Jhc2hSZWNvdmVyZWRVbml0RW5kIH0gPSBhd2FpdCBpbXBvcnQoJy4uL2NyYXNoLXJlY292ZXJ5LnRzJyk7XG5cbiAgICAgIGNvbnN0IGZsb3dJZCA9IHJhbmRvbVVVSUQoKTtcbiAgICAgIGVtaXRKb3VybmFsRXZlbnQoYmFzZSwge1xuICAgICAgICB0czogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgICBmbG93SWQsXG4gICAgICAgIHNlcTogMyxcbiAgICAgICAgZXZlbnRUeXBlOiAndW5pdC1zdGFydCcsXG4gICAgICAgIGRhdGE6IHsgdW5pdFR5cGU6ICdwbGFuLXNsaWNlJywgdW5pdElkOiAnTTAwMS9TMDInIH0sXG4gICAgICB9KTtcbiAgICAgIC8vIEhhcmQgdGltZW91dCBhbHJlYWR5IGVtaXR0ZWQgYSB1bml0LWVuZFxuICAgICAgZW1pdEpvdXJuYWxFdmVudChiYXNlLCB7XG4gICAgICAgIHRzOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICAgIGZsb3dJZCxcbiAgICAgICAgc2VxOiA0LFxuICAgICAgICBldmVudFR5cGU6ICd1bml0LWVuZCcsXG4gICAgICAgIGRhdGE6IHsgdW5pdFR5cGU6ICdwbGFuLXNsaWNlJywgdW5pdElkOiAnTTAwMS9TMDInLCBzdGF0dXM6ICdjYW5jZWxsZWQnIH0sXG4gICAgICAgIGNhdXNlZEJ5OiB7IGZsb3dJZCwgc2VxOiAzIH0sXG4gICAgICB9KTtcblxuICAgICAgY29uc3QgbG9jayA9IHtcbiAgICAgICAgcGlkOiA5OTk5OSxcbiAgICAgICAgc3RhcnRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICAgIHVuaXRUeXBlOiAncGxhbi1zbGljZScsXG4gICAgICAgIHVuaXRJZDogJ00wMDEvUzAyJyxcbiAgICAgICAgdW5pdFN0YXJ0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgfTtcbiAgICAgIGVtaXRDcmFzaFJlY292ZXJlZFVuaXRFbmQoYmFzZSwgbG9jayk7XG5cbiAgICAgIGNvbnN0IGVuZHMgPSBxdWVyeUpvdXJuYWwoYmFzZSkuZmlsdGVyKChlKSA9PiBlLmV2ZW50VHlwZSA9PT0gJ3VuaXQtZW5kJyk7XG4gICAgICBhc3NlcnQuZXF1YWwoZW5kcy5sZW5ndGgsIDEsICdzaG91bGQgbm90IGVtaXQgYSBkdXBsaWNhdGUgdW5pdC1lbmQnKTtcbiAgICAgIGFzc2VydC5lcXVhbChlbmRzWzBdLmRhdGE/LnN0YXR1cywgJ2NhbmNlbGxlZCcsICdvcmlnaW5hbCB1bml0LWVuZCBzaG91bGQgYmUgcHJlc2VydmVkJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KCdpcyBhIG5vLW9wIGZvciBcInN0YXJ0aW5nXCIgcHNldWRvLXVuaXRzIChib290c3RyYXAgY3Jhc2gpJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB7IHF1ZXJ5Sm91cm5hbCB9ID0gYXdhaXQgaW1wb3J0KCcuLi9qb3VybmFsLnRzJyk7XG4gICAgICBjb25zdCB7IGVtaXRDcmFzaFJlY292ZXJlZFVuaXRFbmQgfSA9IGF3YWl0IGltcG9ydCgnLi4vY3Jhc2gtcmVjb3ZlcnkudHMnKTtcblxuICAgICAgY29uc3QgbG9jayA9IHtcbiAgICAgICAgcGlkOiA5OTk5OSxcbiAgICAgICAgc3RhcnRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICAgIHVuaXRUeXBlOiAnc3RhcnRpbmcnLFxuICAgICAgICB1bml0SWQ6ICdib290c3RyYXAnLFxuICAgICAgICB1bml0U3RhcnRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICB9O1xuICAgICAgZW1pdENyYXNoUmVjb3ZlcmVkVW5pdEVuZChiYXNlLCBsb2NrKTtcblxuICAgICAgY29uc3QgZXZlbnRzID0gcXVlcnlKb3VybmFsKGJhc2UpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGV2ZW50cy5sZW5ndGgsIDAsICdzaG91bGQgZW1pdCBub3RoaW5nIGZvciBzdGFydGluZy9ib290c3RyYXAgcHNldWRvLXVuaXRzJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KCdpcyBhIG5vLW9wIHdoZW4gbm8gdW5pdC1zdGFydCBleGlzdHMgaW4gdGhlIGpvdXJuYWwnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHsgcXVlcnlKb3VybmFsIH0gPSBhd2FpdCBpbXBvcnQoJy4uL2pvdXJuYWwudHMnKTtcbiAgICAgIGNvbnN0IHsgZW1pdENyYXNoUmVjb3ZlcmVkVW5pdEVuZCB9ID0gYXdhaXQgaW1wb3J0KCcuLi9jcmFzaC1yZWNvdmVyeS50cycpO1xuXG4gICAgICBjb25zdCBsb2NrID0ge1xuICAgICAgICBwaWQ6IDk5OTk5LFxuICAgICAgICBzdGFydGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgdW5pdFR5cGU6ICdleGVjdXRlLXRhc2snLFxuICAgICAgICB1bml0SWQ6ICdNMDAyL1MwMS9UMDMnLFxuICAgICAgICB1bml0U3RhcnRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICB9O1xuICAgICAgZW1pdENyYXNoUmVjb3ZlcmVkVW5pdEVuZChiYXNlLCBsb2NrKTtcblxuICAgICAgY29uc3QgZXZlbnRzID0gcXVlcnlKb3VybmFsKGJhc2UpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGV2ZW50cy5sZW5ndGgsIDAsICdzaG91bGQgZW1pdCBub3RoaW5nIHdoZW4gdGhlcmUgaXMgbm8gam91cm5hbCBlbnRyeSB0byBjbG9zZScpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdCgnZW1pdE9wZW5Vbml0RW5kRm9yVW5pdCBjbG9zZXMgdGhlIGxhdGVzdCBvcGVuIHN0YXJ0IHdpdGggZXJyb3IgY29udGV4dCcsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgeyBlbWl0Sm91cm5hbEV2ZW50LCBxdWVyeUpvdXJuYWwgfSA9IGF3YWl0IGltcG9ydCgnLi4vam91cm5hbC50cycpO1xuICAgICAgY29uc3QgeyBlbWl0T3BlblVuaXRFbmRGb3JVbml0IH0gPSBhd2FpdCBpbXBvcnQoJy4uL2NyYXNoLXJlY292ZXJ5LnRzJyk7XG5cbiAgICAgIGNvbnN0IGZpcnN0Rmxvd0lkID0gcmFuZG9tVVVJRCgpO1xuICAgICAgY29uc3Qgc2Vjb25kRmxvd0lkID0gcmFuZG9tVVVJRCgpO1xuICAgICAgZW1pdEpvdXJuYWxFdmVudChiYXNlLCB7XG4gICAgICAgIHRzOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICAgIGZsb3dJZDogZmlyc3RGbG93SWQsXG4gICAgICAgIHNlcTogMSxcbiAgICAgICAgZXZlbnRUeXBlOiAndW5pdC1zdGFydCcsXG4gICAgICAgIGRhdGE6IHsgdW5pdFR5cGU6ICdleGVjdXRlLXRhc2snLCB1bml0SWQ6ICdNMDA4L1MwNC9UMDInIH0sXG4gICAgICB9KTtcbiAgICAgIGVtaXRKb3VybmFsRXZlbnQoYmFzZSwge1xuICAgICAgICB0czogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgICBmbG93SWQ6IGZpcnN0Rmxvd0lkLFxuICAgICAgICBzZXE6IDIsXG4gICAgICAgIGV2ZW50VHlwZTogJ3VuaXQtZW5kJyxcbiAgICAgICAgZGF0YTogeyB1bml0VHlwZTogJ2V4ZWN1dGUtdGFzaycsIHVuaXRJZDogJ00wMDgvUzA0L1QwMicsIHN0YXR1czogJ2NvbXBsZXRlZCcgfSxcbiAgICAgICAgY2F1c2VkQnk6IHsgZmxvd0lkOiBmaXJzdEZsb3dJZCwgc2VxOiAxIH0sXG4gICAgICB9KTtcbiAgICAgIGVtaXRKb3VybmFsRXZlbnQoYmFzZSwge1xuICAgICAgICB0czogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgICBmbG93SWQ6IHNlY29uZEZsb3dJZCxcbiAgICAgICAgc2VxOiAzLFxuICAgICAgICBldmVudFR5cGU6ICd1bml0LXN0YXJ0JyxcbiAgICAgICAgZGF0YTogeyB1bml0VHlwZTogJ2V4ZWN1dGUtdGFzaycsIHVuaXRJZDogJ00wMDgvUzA0L1QwMicgfSxcbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCBlbWl0dGVkID0gZW1pdE9wZW5Vbml0RW5kRm9yVW5pdChcbiAgICAgICAgYmFzZSxcbiAgICAgICAgJ2V4ZWN1dGUtdGFzaycsXG4gICAgICAgICdNMDA4L1MwNC9UMDInLFxuICAgICAgICAnY2FuY2VsbGVkJyxcbiAgICAgICAgeyBtZXNzYWdlOiAncnVuVW5pdFBoYXNlIGV4cGxvZGVkJywgY2F0ZWdvcnk6ICd1bml0LWV4Y2VwdGlvbicsIGlzVHJhbnNpZW50OiBmYWxzZSB9LFxuICAgICAgKTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKGVtaXR0ZWQsIHRydWUsICdvcGVuIHVuaXQgc2hvdWxkIGJlIGNsb3NlZCcpO1xuICAgICAgY29uc3QgZW5kcyA9IHF1ZXJ5Sm91cm5hbChiYXNlKS5maWx0ZXIoKGUpID0+IGUuZXZlbnRUeXBlID09PSAndW5pdC1lbmQnKTtcbiAgICAgIGFzc2VydC5lcXVhbChlbmRzLmxlbmd0aCwgMiwgJ3Nob3VsZCBwcmVzZXJ2ZSBleGlzdGluZyBlbmQgYW5kIGFkZCBvbmUgbmV3IGVuZCcpO1xuICAgICAgY29uc3QgbmV3RW5kID0gZW5kcy5maW5kKChlKSA9PiBlLmNhdXNlZEJ5Py5mbG93SWQgPT09IHNlY29uZEZsb3dJZCk7XG4gICAgICBhc3NlcnQub2sobmV3RW5kLCAnbmV3IGVuZCBzaG91bGQgY2xvc2UgdGhlIGxhdGVzdCBvcGVuIHN0YXJ0Jyk7XG4gICAgICBhc3NlcnQuZXF1YWwobmV3RW5kIS5kYXRhPy5zdGF0dXMsICdjYW5jZWxsZWQnKTtcbiAgICAgIGFzc2VydC5kZWVwRXF1YWwobmV3RW5kIS5kYXRhPy5lcnJvckNvbnRleHQsIHtcbiAgICAgICAgbWVzc2FnZTogJ3J1blVuaXRQaGFzZSBleHBsb2RlZCcsXG4gICAgICAgIGNhdGVnb3J5OiAndW5pdC1leGNlcHRpb24nLFxuICAgICAgICBpc1RyYW5zaWVudDogZmFsc2UsXG4gICAgICB9KTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFTQSxTQUFTLFVBQVUsWUFBWTtBQUMvQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxZQUFZLFdBQVcsY0FBYyxhQUFhLGNBQWM7QUFDekUsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUN2QixTQUFTLGtCQUFrQjtBQUUzQixTQUFTLHlCQUF5QjtBQUVsQyxTQUFTLGNBQXNCO0FBQzdCLFFBQU0sT0FBTyxLQUFLLE9BQU8sR0FBRyxZQUFZLFdBQVcsQ0FBQyxFQUFFO0FBQ3RELFlBQVUsS0FBSyxNQUFNLE1BQU0sR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ2pELFNBQU87QUFDVDtBQUVBLFNBQVMsNERBQTRELE1BQU07QUFDekUsT0FBSyxzRUFBc0UsWUFBWTtBQUVyRixVQUFNLFVBQVUsS0FBSyxPQUFPLEdBQUcsa0JBQWtCLFdBQVcsQ0FBQyxFQUFFO0FBQy9ELFVBQU0sV0FBVyxRQUFRLElBQUk7QUFDN0IsWUFBUSxJQUFJLFdBQVc7QUFDdkIsUUFBSTtBQUNGLFlBQU0sRUFBRSxjQUFjLElBQUksTUFBTSxPQUFPLDJCQUEyQjtBQUNsRSxZQUFNLE1BQU0sSUFBSSxNQUFNLDJD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
