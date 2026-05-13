import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isClosedStatus } from "../status-guards.js";
import { openDatabase, closeDatabase, upsertDecision, _getAdapter } from "../gsd-db.js";
import { extractEntityKey } from "../workflow-reconcile.js";
describe("isClosedStatus used by projections", () => {
  test("skipped is closed (projections now show checked)", () => {
    assert.ok(isClosedStatus("skipped"));
  });
  test("complete is closed", () => {
    assert.ok(isClosedStatus("complete"));
  });
  test("done is closed", () => {
    assert.ok(isClosedStatus("done"));
  });
  test("in-progress is not closed", () => {
    assert.ok(!isClosedStatus("in-progress"));
  });
});
describe("upsertDecision preserves seq column", () => {
  test("seq is preserved when decision is re-upserted", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gsd-upsert-test-"));
    const dbPath = join(tmp, "gsd.db");
    try {
      openDatabase(dbPath);
      const adapter = _getAdapter();
      assert.ok(adapter, "adapter must be available");
      upsertDecision({
        id: "D001",
        when_context: "ctx1",
        scope: "s1",
        decision: "d1",
        choice: "c1",
        rationale: "r1",
        revisable: "yes",
        made_by: "agent",
        superseded_by: null
      });
      upsertDecision({
        id: "D002",
        when_context: "ctx2",
        scope: "s2",
        decision: "d2",
        choice: "c2",
        rationale: "r2",
        revisable: "yes",
        made_by: "agent",
        superseded_by: null
      });
      const rows1 = adapter.prepare("SELECT id, seq FROM decisions ORDER BY seq").all();
      assert.strictEqual(rows1[0].id, "D001");
      assert.strictEqual(rows1[1].id, "D002");
      const d001OriginalSeq = rows1[0].seq;
      upsertDecision({
        id: "D001",
        when_context: "updated",
        scope: "s1",
        decision: "d1-updated",
        choice: "c1",
        rationale: "r1",
        revisable: "yes",
        made_by: "agent",
        superseded_by: null
      });
      const rows2 = adapter.prepare("SELECT id, seq FROM decisions ORDER BY seq").all();
      assert.strictEqual(rows2[0].id, "D001", "D001 should still be first by seq");
      assert.strictEqual(rows2[0].seq, d001OriginalSeq, "D001 seq should be preserved");
      assert.strictEqual(rows2[1].id, "D002", "D002 should still be second");
      const updated = adapter.prepare("SELECT decision FROM decisions WHERE id = 'D001'").get();
      assert.strictEqual(updated.decision, "d1-updated");
      closeDatabase();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
describe("WorkflowEvent v field", () => {
  test("appendEvent includes v:2 in output", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "gsd-event-v-test-"));
    try {
      const { appendEvent } = await import("../workflow-events.js");
      appendEvent(tmp, {
        cmd: "test-event",
        params: { foo: "bar" },
        ts: (/* @__PURE__ */ new Date()).toISOString(),
        actor: "system"
      });
      const logPath = join(tmp, ".gsd", "event-log.jsonl");
      const line = readFileSync(logPath, "utf-8").trim();
      const event = JSON.parse(line);
      assert.strictEqual(event.v, 2, "New events should have v:2");
      assert.strictEqual(event.cmd, "test-event");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
describe("isClosedStatus drives projection checkbox logic", () => {
  test("skipped task produces checked checkbox via isClosedStatus", () => {
    const statuses = ["complete", "done", "skipped"];
    for (const status of statuses) {
      assert.ok(
        isClosedStatus(status),
        `status "${status}" must be closed so projections render [x]`
      );
    }
    for (const status of ["pending", "in-progress", "blocked", "active"]) {
      assert.ok(
        !isClosedStatus(status),
        `status "${status}" must NOT be closed so projections render [ ]`
      );
    }
  });
});
describe("extractEntityKey recognizes underscored cmds", () => {
  const base = { cmd: "", params: {}, ts: "", hash: "", actor: "agent", session_id: "" };
  test("complete_task \u2192 task entity", () => {
    const key = extractEntityKey({ ...base, cmd: "complete_task", params: { taskId: "T01" } });
    assert.deepStrictEqual(key, { type: "task", id: "T01" });
  });
  test("complete_slice \u2192 slice entity", () => {
    const key = extractEntityKey({ ...base, cmd: "complete_slice", params: { sliceId: "S01" } });
    assert.deepStrictEqual(key, { type: "slice", id: "S01" });
  });
  test("plan_slice \u2192 slice_plan entity (distinct from complete)", () => {
    const key = extractEntityKey({ ...base, cmd: "plan_slice", params: { sliceId: "S01" } });
    assert.deepStrictEqual(key, { type: "slice_plan", id: "S01" });
  });
  test("save_decision \u2192 decision entity", () => {
    const key = extractEntityKey({ ...base, cmd: "save_decision", params: { scope: "s", decision: "d" } });
    assert.deepStrictEqual(key, { type: "decision", id: "s:d" });
  });
  test("unknown cmd returns null (not crash)", () => {
    const key = extractEntityKey({ ...base, cmd: "future_unknown_cmd", params: {} });
    assert.strictEqual(key, null);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy93YXZlNS1jb25zaXN0ZW5jeS1yZWdyZXNzaW9ucy50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBHU0QgU3RhdGUgTWFjaGluZSBcdTIwMTQgV2F2ZSA1IENvbnNpc3RlbmN5IFJlZ3Jlc3Npb24gVGVzdHNcbi8vIFZhbGlkYXRlcyBpc0Nsb3NlZFN0YXR1cyB1c2FnZSBpbiBwcm9qZWN0aW9ucywgdXBzZXJ0RGVjaXNpb24gc2VxIHByZXNlcnZhdGlvbixcbi8vIGV2ZW50IHNjaGVtYSB2ZXJzaW9uaW5nLCBhbmQgcmVwbGF5IHJvdW5kLXRyaXAgd2l0aCBtaXhlZCBjbWQgZm9ybWF0cy5cblxuaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCByZWFkRmlsZVN5bmMsIHJtU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGlzQ2xvc2VkU3RhdHVzIH0gZnJvbSBcIi4uL3N0YXR1cy1ndWFyZHMuanNcIjtcbmltcG9ydCB7IG9wZW5EYXRhYmFzZSwgY2xvc2VEYXRhYmFzZSwgdXBzZXJ0RGVjaXNpb24sIF9nZXRBZGFwdGVyLCBpbnNlcnRNaWxlc3RvbmUsIGluc2VydFNsaWNlLCBpbnNlcnRUYXNrLCBnZXRUYXNrIH0gZnJvbSBcIi4uL2dzZC1kYi5qc1wiO1xuaW1wb3J0IHsgZXh0cmFjdEVudGl0eUtleSB9IGZyb20gXCIuLi93b3JrZmxvdy1yZWNvbmNpbGUuanNcIjtcbmltcG9ydCB0eXBlIHsgV29ya2Zsb3dFdmVudCB9IGZyb20gXCIuLi93b3JrZmxvdy1ldmVudHMuanNcIjtcblxuLy8gXHUyNTAwXHUyNTAwIEZpeCAxOTogaXNDbG9zZWRTdGF0dXMgY292ZXJzIGFsbCBjbG9zZWQgc3RhdHVzZXMgXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiaXNDbG9zZWRTdGF0dXMgdXNlZCBieSBwcm9qZWN0aW9uc1wiLCAoKSA9PiB7XG4gIHRlc3QoXCJza2lwcGVkIGlzIGNsb3NlZCAocHJvamVjdGlvbnMgbm93IHNob3cgY2hlY2tlZClcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5vayhpc0Nsb3NlZFN0YXR1cyhcInNraXBwZWRcIikpO1xuICB9KTtcbiAgdGVzdChcImNvbXBsZXRlIGlzIGNsb3NlZFwiLCAoKSA9PiB7XG4gICAgYXNzZXJ0Lm9rKGlzQ2xvc2VkU3RhdHVzKFwiY29tcGxldGVcIikpO1xuICB9KTtcbiAgdGVzdChcImRvbmUgaXMgY2xvc2VkXCIsICgpID0+IHtcbiAgICBhc3NlcnQub2soaXNDbG9zZWRTdGF0dXMoXCJkb25lXCIpKTtcbiAgfSk7XG4gIHRlc3QoXCJpbi1wcm9ncmVzcyBpcyBub3QgY2xvc2VkXCIsICgpID0+IHtcbiAgICBhc3NlcnQub2soIWlzQ2xvc2VkU3RhdHVzKFwiaW4tcHJvZ3Jlc3NcIikpO1xuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDAgRml4IDIwOiB1cHNlcnREZWNpc2lvbiBwcmVzZXJ2ZXMgc2VxIG9uIHVwZGF0ZSBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJ1cHNlcnREZWNpc2lvbiBwcmVzZXJ2ZXMgc2VxIGNvbHVtblwiLCAoKSA9PiB7XG4gIHRlc3QoXCJzZXEgaXMgcHJlc2VydmVkIHdoZW4gZGVjaXNpb24gaXMgcmUtdXBzZXJ0ZWRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHRtcCA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXVwc2VydC10ZXN0LVwiKSk7XG4gICAgY29uc3QgZGJQYXRoID0gam9pbih0bXAsIFwiZ3NkLmRiXCIpO1xuICAgIHRyeSB7XG4gICAgICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcbiAgICAgIGNvbnN0IGFkYXB0ZXIgPSBfZ2V0QWRhcHRlcigpO1xuICAgICAgYXNzZXJ0Lm9rKGFkYXB0ZXIsIFwiYWRhcHRlciBtdXN0IGJlIGF2YWlsYWJsZVwiKTtcblxuICAgICAgLy8gSW5zZXJ0IHR3byBkZWNpc2lvbnNcbiAgICAgIHVwc2VydERlY2lzaW9uKHtcbiAgICAgICAgaWQ6IFwiRDAwMVwiLCB3aGVuX2NvbnRleHQ6IFwiY3R4MVwiLCBzY29wZTogXCJzMVwiLFxuICAgICAgICBkZWNpc2lvbjogXCJkMVwiLCBjaG9pY2U6IFwiYzFcIiwgcmF0aW9uYWxlOiBcInIxXCIsXG4gICAgICAgIHJldmlzYWJsZTogXCJ5ZXNcIiwgbWFkZV9ieTogXCJhZ2VudFwiLCBzdXBlcnNlZGVkX2J5OiBudWxsLFxuICAgICAgfSk7XG4gICAgICB1cHNlcnREZWNpc2lvbih7XG4gICAgICAgIGlkOiBcIkQwMDJcIiwgd2hlbl9jb250ZXh0OiBcImN0eDJcIiwgc2NvcGU6IFwiczJcIixcbiAgICAgICAgZGVjaXNpb246IFwiZDJcIiwgY2hvaWNlOiBcImMyXCIsIHJhdGlvbmFsZTogXCJyMlwiLFxuICAgICAgICByZXZpc2FibGU6IFwieWVzXCIsIG1hZGVfYnk6IFwiYWdlbnRcIiwgc3VwZXJzZWRlZF9ieTogbnVsbCxcbiAgICAgIH0pO1xuXG4gICAgICAvLyBHZXQgb3JpZ2luYWwgc2VxIHZhbHVlc1xuICAgICAgY29uc3Qgcm93czEgPSBhZGFwdGVyLnByZXBhcmUoXCJTRUxFQ1QgaWQsIHNlcSBGUk9NIGRlY2lzaW9ucyBPUkRFUiBCWSBzZXFcIikuYWxsKCkgYXMgQXJyYXk8eyBpZDogc3RyaW5nOyBzZXE6IG51bWJlciB9PjtcbiAgICAgIGFzc2VydC5zdHJpY3RFcXVhbChyb3dzMVswXS5pZCwgXCJEMDAxXCIpO1xuICAgICAgYXNzZXJ0LnN0cmljdEVxdWFsKHJvd3MxWzFdLmlkLCBcIkQwMDJcIik7XG4gICAgICBjb25zdCBkMDAxT3JpZ2luYWxTZXEgPSByb3dzMVswXS5zZXE7XG5cbiAgICAgIC8vIFJlLXVwc2VydCBEMDAxIHdpdGggdXBkYXRlZCBjb250ZW50XG4gICAgICB1cHNlcnREZWNpc2lvbih7XG4gICAgICAgIGlkOiBcIkQwMDFcIiwgd2hlbl9jb250ZXh0OiBcInVwZGF0ZWRcIiwgc2NvcGU6IFwiczFcIixcbiAgICAgICAgZGVjaXNpb246IFwiZDEtdXBkYXRlZFwiLCBjaG9pY2U6IFwiYzFcIiwgcmF0aW9uYWxlOiBcInIxXCIsXG4gICAgICAgIHJldmlzYWJsZTogXCJ5ZXNcIiwgbWFkZV9ieTogXCJhZ2VudFwiLCBzdXBlcnNlZGVkX2J5OiBudWxsLFxuICAgICAgfSk7XG5cbiAgICAgIC8vIFZlcmlmeSBzZXEgaXMgcHJlc2VydmVkIChub3QgbW92ZWQgdG8gZW5kKVxuICAgICAgY29uc3Qgcm93czIgPSBhZGFwdGVyLnByZXBhcmUoXCJTRUxFQ1QgaWQsIHNlcSBGUk9NIGRlY2lzaW9ucyBPUkRFUiBCWSBzZXFcIikuYWxsKCkgYXMgQXJyYXk8eyBpZDogc3RyaW5nOyBzZXE6IG51bWJlciB9PjtcbiAgICAgIGFzc2VydC5zdHJpY3RFcXVhbChyb3dzMlswXS5pZCwgXCJEMDAxXCIsIFwiRDAwMSBzaG91bGQgc3RpbGwgYmUgZmlyc3QgYnkgc2VxXCIpO1xuICAgICAgYXNzZXJ0LnN0cmljdEVxdWFsKHJvd3MyWzBdLnNlcSwgZDAwMU9yaWdpbmFsU2VxLCBcIkQwMDEgc2VxIHNob3VsZCBiZSBwcmVzZXJ2ZWRcIik7XG4gICAgICBhc3NlcnQuc3RyaWN0RXF1YWwocm93czJbMV0uaWQsIFwiRDAwMlwiLCBcIkQwMDIgc2hvdWxkIHN0aWxsIGJlIHNlY29uZFwiKTtcblxuICAgICAgLy8gVmVyaWZ5IGNvbnRlbnQgd2FzIHVwZGF0ZWRcbiAgICAgIGNvbnN0IHVwZGF0ZWQgPSBhZGFwdGVyLnByZXBhcmUoXCJTRUxFQ1QgZGVjaXNpb24gRlJPTSBkZWNpc2lvbnMgV0hFUkUgaWQgPSAnRDAwMSdcIikuZ2V0KCkgYXMgeyBkZWNpc2lvbjogc3RyaW5nIH07XG4gICAgICBhc3NlcnQuc3RyaWN0RXF1YWwodXBkYXRlZC5kZWNpc2lvbiwgXCJkMS11cGRhdGVkXCIpO1xuXG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMCBGaXggMjM6IEV2ZW50IHNjaGVtYSB2ZXJzaW9uaW5nIFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcIldvcmtmbG93RXZlbnQgdiBmaWVsZFwiLCAoKSA9PiB7XG4gIHRlc3QoXCJhcHBlbmRFdmVudCBpbmNsdWRlcyB2OjIgaW4gb3V0cHV0XCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB0bXAgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1ldmVudC12LXRlc3QtXCIpKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgeyBhcHBlbmRFdmVudCB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vd29ya2Zsb3ctZXZlbnRzLmpzXCIpO1xuICAgICAgYXBwZW5kRXZlbnQodG1wLCB7XG4gICAgICAgIGNtZDogXCJ0ZXN0LWV2ZW50XCIsXG4gICAgICAgIHBhcmFtczogeyBmb286IFwiYmFyXCIgfSxcbiAgICAgICAgdHM6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgYWN0b3I6IFwic3lzdGVtXCIsXG4gICAgICB9KTtcblxuICAgICAgY29uc3QgbG9nUGF0aCA9IGpvaW4odG1wLCBcIi5nc2RcIiwgXCJldmVudC1sb2cuanNvbmxcIik7XG4gICAgICBjb25zdCBsaW5lID0gcmVhZEZpbGVTeW5jKGxvZ1BhdGgsIFwidXRmLThcIikudHJpbSgpO1xuICAgICAgY29uc3QgZXZlbnQgPSBKU09OLnBhcnNlKGxpbmUpO1xuICAgICAgYXNzZXJ0LnN0cmljdEVxdWFsKGV2ZW50LnYsIDIsIFwiTmV3IGV2ZW50cyBzaG91bGQgaGF2ZSB2OjJcIik7XG4gICAgICBhc3NlcnQuc3RyaWN0RXF1YWwoZXZlbnQuY21kLCBcInRlc3QtZXZlbnRcIik7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMCBGaXggMTkgKGJlaGF2aW9yLWxldmVsKTogUHJvamVjdGlvbiByZW5kZXJpbmcgd2l0aCBza2lwcGVkIHRhc2tzIFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcImlzQ2xvc2VkU3RhdHVzIGRyaXZlcyBwcm9qZWN0aW9uIGNoZWNrYm94IGxvZ2ljXCIsICgpID0+IHtcbiAgdGVzdChcInNraXBwZWQgdGFzayBwcm9kdWNlcyBjaGVja2VkIGNoZWNrYm94IHZpYSBpc0Nsb3NlZFN0YXR1c1wiLCAoKSA9PiB7XG4gICAgLy8gVGhpcyB0ZXN0cyB0aGUgYmVoYXZpb3IgY29udHJhY3QgdGhhdCBwcm9qZWN0aW9ucyByZWx5IG9uOlxuICAgIC8vIHdvcmtmbG93LXByb2plY3Rpb25zLnRzIHVzZXMgaXNDbG9zZWRTdGF0dXMoKSB0byBkZXRlcm1pbmUgY2hlY2tib3ggc3RhdGUuXG4gICAgLy8gXCJza2lwcGVkXCIgdGFza3MgbXVzdCByZW5kZXIgYXMgW3hdLCBub3QgWyBdLlxuICAgIGNvbnN0IHN0YXR1c2VzID0gW1wiY29tcGxldGVcIiwgXCJkb25lXCIsIFwic2tpcHBlZFwiXTtcbiAgICBmb3IgKGNvbnN0IHN0YXR1cyBvZiBzdGF0dXNlcykge1xuICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICBpc0Nsb3NlZFN0YXR1cyhzdGF0dXMpLFxuICAgICAgICBgc3RhdHVzIFwiJHtzdGF0dXN9XCIgbXVzdCBiZSBjbG9zZWQgc28gcHJvamVjdGlvbnMgcmVuZGVyIFt4XWAsXG4gICAgICApO1xuICAgIH1cbiAgICAvLyBOb24tY2xvc2VkIHN0YXR1c2VzIG11c3QgcmVuZGVyIGFzIFsgXVxuICAgIGZvciAoY29uc3Qgc3RhdHVzIG9mIFtcInBlbmRpbmdcIiwgXCJpbi1wcm9ncmVzc1wiLCBcImJsb2NrZWRcIiwgXCJhY3RpdmVcIl0pIHtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgIWlzQ2xvc2VkU3RhdHVzKHN0YXR1cyksXG4gICAgICAgIGBzdGF0dXMgXCIke3N0YXR1c31cIiBtdXN0IE5PVCBiZSBjbG9zZWQgc28gcHJvamVjdGlvbnMgcmVuZGVyIFsgXWAsXG4gICAgICApO1xuICAgIH1cbiAgfSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwIGV4dHJhY3RFbnRpdHlLZXk6IHVuZGVyc2NvcmVkIGNtZHMgYXJlIHJlY29nbml6ZWQgKFdhdmUgNSBzY29wZSkgXHUyNTAwXHUyNTAwXG4vLyBOb3RlOiBoeXBoZW5hdGVkIGNtZCBub3JtYWxpemF0aW9uIGlzIGluIFdhdmUgMS4gVGhlc2UgdGVzdHMgdmFsaWRhdGVcbi8vIHRoZSB1bmRlcnNjb3JlZCBmb3JtYXQgdGhhdCBXYXZlIDUncyBleHRyYWN0RW50aXR5S2V5IGhhbmRsZXMgZGlyZWN0bHkuXG5cbmRlc2NyaWJlKFwiZXh0cmFjdEVudGl0eUtleSByZWNvZ25pemVzIHVuZGVyc2NvcmVkIGNtZHNcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlOiBXb3JrZmxvd0V2ZW50ID0geyBjbWQ6IFwiXCIsIHBhcmFtczoge30sIHRzOiBcIlwiLCBoYXNoOiBcIlwiLCBhY3RvcjogXCJhZ2VudFwiLCBzZXNzaW9uX2lkOiBcIlwiIH07XG5cbiAgdGVzdChcImNvbXBsZXRlX3Rhc2sgXHUyMTkyIHRhc2sgZW50aXR5XCIsICgpID0+IHtcbiAgICBjb25zdCBrZXkgPSBleHRyYWN0RW50aXR5S2V5KHsgLi4uYmFzZSwgY21kOiBcImNvbXBsZXRlX3Rhc2tcIiwgcGFyYW1zOiB7IHRhc2tJZDogXCJUMDFcIiB9IH0pO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoa2V5LCB7IHR5cGU6IFwidGFza1wiLCBpZDogXCJUMDFcIiB9KTtcbiAgfSk7XG5cbiAgdGVzdChcImNvbXBsZXRlX3NsaWNlIFx1MjE5MiBzbGljZSBlbnRpdHlcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGtleSA9IGV4dHJhY3RFbnRpdHlLZXkoeyAuLi5iYXNlLCBjbWQ6IFwiY29tcGxldGVfc2xpY2VcIiwgcGFyYW1zOiB7IHNsaWNlSWQ6IFwiUzAxXCIgfSB9KTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGtleSwgeyB0eXBlOiBcInNsaWNlXCIsIGlkOiBcIlMwMVwiIH0pO1xuICB9KTtcblxuICB0ZXN0KFwicGxhbl9zbGljZSBcdTIxOTIgc2xpY2VfcGxhbiBlbnRpdHkgKGRpc3RpbmN0IGZyb20gY29tcGxldGUpXCIsICgpID0+IHtcbiAgICBjb25zdCBrZXkgPSBleHRyYWN0RW50aXR5S2V5KHsgLi4uYmFzZSwgY21kOiBcInBsYW5fc2xpY2VcIiwgcGFyYW1zOiB7IHNsaWNlSWQ6IFwiUzAxXCIgfSB9KTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGtleSwgeyB0eXBlOiBcInNsaWNlX3BsYW5cIiwgaWQ6IFwiUzAxXCIgfSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJzYXZlX2RlY2lzaW9uIFx1MjE5MiBkZWNpc2lvbiBlbnRpdHlcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGtleSA9IGV4dHJhY3RFbnRpdHlLZXkoeyAuLi5iYXNlLCBjbWQ6IFwic2F2ZV9kZWNpc2lvblwiLCBwYXJhbXM6IHsgc2NvcGU6IFwic1wiLCBkZWNpc2lvbjogXCJkXCIgfSB9KTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGtleSwgeyB0eXBlOiBcImRlY2lzaW9uXCIsIGlkOiBcInM6ZFwiIH0pO1xuICB9KTtcblxuICB0ZXN0KFwidW5rbm93biBjbWQgcmV0dXJucyBudWxsIChub3QgY3Jhc2gpXCIsICgpID0+IHtcbiAgICBjb25zdCBrZXkgPSBleHRyYWN0RW50aXR5S2V5KHsgLi4uYmFzZSwgY21kOiBcImZ1dHVyZV91bmtub3duX2NtZFwiLCBwYXJhbXM6IHt9IH0pO1xuICAgIGFzc2VydC5zdHJpY3RFcXVhbChrZXksIG51bGwpO1xuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBSUEsU0FBUyxVQUFVLFlBQVk7QUFDL0IsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxjQUFjLGNBQWM7QUFDbEQsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUN2QixTQUFTLHNCQUFzQjtBQUMvQixTQUFTLGNBQWMsZUFBZSxnQkFBZ0IsbUJBQXNFO0FBQzVILFNBQVMsd0JBQXdCO0FBS2pDLFNBQVMsc0NBQXNDLE1BQU07QUFDbkQsT0FBSyxvREFBb0QsTUFBTTtBQUM3RCxXQUFPLEdBQUcsZUFBZSxTQUFTLENBQUM7QUFBQSxFQUNyQyxDQUFDO0FBQ0QsT0FBSyxzQkFBc0IsTUFBTTtBQUMvQixXQUFPLEdBQUcsZUFBZSxVQUFVLENBQUM7QUFBQSxFQUN0QyxDQUFDO0FBQ0QsT0FBSyxrQkFBa0IsTUFBTTtBQUMzQixXQUFPLEdBQUcsZUFBZSxNQUFNLENBQUM7QUFBQSxFQUNsQyxDQUFDO0FBQ0QsT0FBSyw2QkFBNkIsTUFBTTtBQUN0QyxXQUFPLEdBQUcsQ0FBQyxlQUFlLGFBQWEsQ0FBQztBQUFBLEVBQzFDLENBQUM7QUFDSCxDQUFDO0FBSUQsU0FBUyx1Q0FBdUMsTUFBTTtBQUNwRCxPQUFLLGlEQUFpRCxNQUFNO0FBQzFELFVBQU0sTUFBTSxZQUFZLEtBQUssT0FBTyxHQUFHLGtCQUFrQixDQUFDO0FBQzFELFVBQU0sU0FBUyxLQUFLLEtBQUssUUFBUTtBQUNqQyxRQUFJO0FBQ0YsbUJBQWEsTUFBTTtBQUNuQixZQUFNLFVBQVUsWUFBWTtBQUM1QixhQUFPLEdBQUcsU0FBUywyQkFBMkI7QUFHOUMscUJBQWU7QUFBQSxRQUNiLElBQUk7QUFBQSxRQUFRLGNBQWM7QUFBQSxRQUFRLE9BQU87QUFBQSxRQUN6QyxVQUFVO0FBQUEsUUFBTSxRQUFRO0FBQUEsUUFBTSxXQUFXO0FBQUEsUUFD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
