import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitJournalEvent } from "../journal.js";
import { saveActivityLog } from "../activity-log.js";
import { initMetrics, resetMetrics, snapshotUnitMetrics } from "../metrics.js";
import { setLogBasePath, logWarning } from "../workflow-logger.js";
import { setUnifiedAuditEnabled } from "../uok/audit-toggle.js";
function readAuditEvents(basePath) {
  const file = join(basePath, ".gsd", "audit", "events.jsonl");
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf-8");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
function makeMockContext(entries) {
  return {
    sessionManager: {
      getEntries: () => entries
    }
  };
}
test("unified audit plane bridges journal/activity/metrics/workflow logger into audit envelope log", () => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-uok-audit-"));
  setUnifiedAuditEnabled(true);
  try {
    emitJournalEvent(basePath, {
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      flowId: "trace-123",
      seq: 1,
      eventType: "iteration-start",
      data: { turnId: "turn-123", unitId: "M001/S01/T01" }
    });
    const activityCtx = makeMockContext([
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }
    ]);
    const activityPath = saveActivityLog(activityCtx, basePath, "execute-task", "M001/S01/T01");
    assert.ok(activityPath);
    initMetrics(basePath);
    const metricsCtx = makeMockContext([
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: 0.01 },
          content: []
        }
      }
    ]);
    const unit = snapshotUnitMetrics(
      metricsCtx,
      "execute-task",
      "M001/S01/T01",
      Date.now() - 1e3,
      "openai/gpt-5.4",
      { traceId: "trace-123", turnId: "turn-123" }
    );
    assert.ok(unit);
    resetMetrics();
    setLogBasePath(basePath);
    logWarning("engine", "audit bridge check", { id: "turn-123" });
    const events = readAuditEvents(basePath);
    const types = new Set(events.map((event) => String(event.type ?? "")));
    assert.ok(types.has("journal-iteration-start"));
    assert.ok(types.has("activity-log-saved"));
    assert.ok(types.has("unit-metrics-snapshot"));
    assert.ok(types.has("workflow-log-warn"));
  } finally {
    setUnifiedAuditEnabled(false);
    resetMetrics();
    rmSync(basePath, { recursive: true, force: true });
  }
});
test("unified audit bridge is disabled when toggle is off", () => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-uok-audit-off-"));
  setUnifiedAuditEnabled(false);
  try {
    emitJournalEvent(basePath, {
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      flowId: "trace-off",
      seq: 1,
      eventType: "iteration-start"
    });
    const events = readAuditEvents(basePath);
    assert.equal(events.length, 0);
  } finally {
    rmSync(basePath, { recursive: true, force: true });
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy91b2stYXVkaXQtdW5pZmllZC50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCByZWFkRmlsZVN5bmMsIHJtU3luYywgZXhpc3RzU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGVtaXRKb3VybmFsRXZlbnQgfSBmcm9tIFwiLi4vam91cm5hbC50c1wiO1xuaW1wb3J0IHsgc2F2ZUFjdGl2aXR5TG9nIH0gZnJvbSBcIi4uL2FjdGl2aXR5LWxvZy50c1wiO1xuaW1wb3J0IHsgaW5pdE1ldHJpY3MsIHJlc2V0TWV0cmljcywgc25hcHNob3RVbml0TWV0cmljcyB9IGZyb20gXCIuLi9tZXRyaWNzLnRzXCI7XG5pbXBvcnQgeyBzZXRMb2dCYXNlUGF0aCwgbG9nV2FybmluZyB9IGZyb20gXCIuLi93b3JrZmxvdy1sb2dnZXIudHNcIjtcbmltcG9ydCB7IHNldFVuaWZpZWRBdWRpdEVuYWJsZWQgfSBmcm9tIFwiLi4vdW9rL2F1ZGl0LXRvZ2dsZS50c1wiO1xuXG5mdW5jdGlvbiByZWFkQXVkaXRFdmVudHMoYmFzZVBhdGg6IHN0cmluZyk6IEFycmF5PFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gIGNvbnN0IGZpbGUgPSBqb2luKGJhc2VQYXRoLCBcIi5nc2RcIiwgXCJhdWRpdFwiLCBcImV2ZW50cy5qc29ubFwiKTtcbiAgaWYgKCFleGlzdHNTeW5jKGZpbGUpKSByZXR1cm4gW107XG4gIGNvbnN0IHJhdyA9IHJlYWRGaWxlU3luYyhmaWxlLCBcInV0Zi04XCIpO1xuICByZXR1cm4gcmF3XG4gICAgLnNwbGl0KFwiXFxuXCIpXG4gICAgLmZpbHRlcihCb29sZWFuKVxuICAgIC5tYXAoKGxpbmUpID0+IEpTT04ucGFyc2UobGluZSkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pO1xufVxuXG5mdW5jdGlvbiBtYWtlTW9ja0NvbnRleHQoZW50cmllczogdW5rbm93bltdKTogYW55IHtcbiAgcmV0dXJuIHtcbiAgICBzZXNzaW9uTWFuYWdlcjoge1xuICAgICAgZ2V0RW50cmllczogKCkgPT4gZW50cmllcyxcbiAgICB9LFxuICB9O1xufVxuXG50ZXN0KFwidW5pZmllZCBhdWRpdCBwbGFuZSBicmlkZ2VzIGpvdXJuYWwvYWN0aXZpdHkvbWV0cmljcy93b3JrZmxvdyBsb2dnZXIgaW50byBhdWRpdCBlbnZlbG9wZSBsb2dcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlUGF0aCA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXVvay1hdWRpdC1cIikpO1xuICBzZXRVbmlmaWVkQXVkaXRFbmFibGVkKHRydWUpO1xuICB0cnkge1xuICAgIGVtaXRKb3VybmFsRXZlbnQoYmFzZVBhdGgsIHtcbiAgICAgIHRzOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICBmbG93SWQ6IFwidHJhY2UtMTIzXCIsXG4gICAgICBzZXE6IDEsXG4gICAgICBldmVudFR5cGU6IFwiaXRlcmF0aW9uLXN0YXJ0XCIsXG4gICAgICBkYXRhOiB7IHR1cm5JZDogXCJ0dXJuLTEyM1wiLCB1bml0SWQ6IFwiTTAwMS9TMDEvVDAxXCIgfSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGFjdGl2aXR5Q3R4ID0gbWFrZU1vY2tDb250ZXh0KFtcbiAgICAgIHsgdHlwZTogXCJtZXNzYWdlXCIsIG1lc3NhZ2U6IHsgcm9sZTogXCJhc3Npc3RhbnRcIiwgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiaGVsbG9cIiB9XSB9IH0sXG4gICAgXSk7XG4gICAgY29uc3QgYWN0aXZpdHlQYXRoID0gc2F2ZUFjdGl2aXR5TG9nKGFjdGl2aXR5Q3R4LCBiYXNlUGF0aCwgXCJleGVjdXRlLXRhc2tcIiwgXCJNMDAxL1MwMS9UMDFcIik7XG4gICAgYXNzZXJ0Lm9rKGFjdGl2aXR5UGF0aCk7XG5cbiAgICBpbml0TWV0cmljcyhiYXNlUGF0aCk7XG4gICAgY29uc3QgbWV0cmljc0N0eCA9IG1ha2VNb2NrQ29udGV4dChbXG4gICAgICB7XG4gICAgICAgIHR5cGU6IFwibWVzc2FnZVwiLFxuICAgICAgICBtZXNzYWdlOiB7XG4gICAgICAgICAgcm9sZTogXCJhc3Npc3RhbnRcIixcbiAgICAgICAgICB1c2FnZTogeyBpbnB1dDogMTAsIG91dHB1dDogNSwgY2FjaGVSZWFkOiAwLCBjYWNoZVdyaXRlOiAwLCB0b3RhbFRva2VuczogMTUsIGNvc3Q6IDAuMDEgfSxcbiAgICAgICAgICBjb250ZW50OiBbXSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgXSk7XG4gICAgY29uc3QgdW5pdCA9IHNuYXBzaG90VW5pdE1ldHJpY3MoXG4gICAgICBtZXRyaWNzQ3R4LFxuICAgICAgXCJleGVjdXRlLXRhc2tcIixcbiAgICAgIFwiTTAwMS9TMDEvVDAxXCIsXG4gICAgICBEYXRlLm5vdygpIC0gMTAwMCxcbiAgICAgIFwib3BlbmFpL2dwdC01LjRcIixcbiAgICAgIHsgdHJhY2VJZDogXCJ0cmFjZS0xMjNcIiwgdHVybklkOiBcInR1cm4tMTIzXCIgfSxcbiAgICApO1xuICAgIGFzc2VydC5vayh1bml0KTtcbiAgICByZXNldE1ldHJpY3MoKTtcblxuICAgIHNldExvZ0Jhc2VQYXRoKGJhc2VQYXRoKTtcbiAgICBsb2dXYXJuaW5nKFwiZW5naW5lXCIsIFwiYXVkaXQgYnJpZGdlIGNoZWNrXCIsIHsgaWQ6IFwidHVybi0xMjNcIiB9KTtcblxuICAgIGNvbnN0IGV2ZW50cyA9IHJlYWRBdWRpdEV2ZW50cyhiYXNlUGF0aCk7XG4gICAgY29uc3QgdHlwZXMgPSBuZXcgU2V0KGV2ZW50cy5tYXAoKGV2ZW50KSA9PiBTdHJpbmcoZXZlbnQudHlwZSA/PyBcIlwiKSkpO1xuICAgIGFzc2VydC5vayh0eXBlcy5oYXMoXCJqb3VybmFsLWl0ZXJhdGlvbi1zdGFydFwiKSk7XG4gICAgYXNzZXJ0Lm9rKHR5cGVzLmhhcyhcImFjdGl2aXR5LWxvZy1zYXZlZFwiKSk7XG4gICAgYXNzZXJ0Lm9rKHR5cGVzLmhhcyhcInVuaXQtbWV0cmljcy1zbmFwc2hvdFwiKSk7XG4gICAgYXNzZXJ0Lm9rKHR5cGVzLmhhcyhcIndvcmtmbG93LWxvZy13YXJuXCIpKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBzZXRVbmlmaWVkQXVkaXRFbmFibGVkKGZhbHNlKTtcbiAgICByZXNldE1ldHJpY3MoKTtcbiAgICBybVN5bmMoYmFzZVBhdGgsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJ1bmlmaWVkIGF1ZGl0IGJyaWRnZSBpcyBkaXNhYmxlZCB3aGVuIHRvZ2dsZSBpcyBvZmZcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlUGF0aCA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXVvay1hdWRpdC1vZmYtXCIpKTtcbiAgc2V0VW5pZmllZEF1ZGl0RW5hYmxlZChmYWxzZSk7XG4gIHRyeSB7XG4gICAgZW1pdEpvdXJuYWxFdmVudChiYXNlUGF0aCwge1xuICAgICAgdHM6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgIGZsb3dJZDogXCJ0cmFjZS1vZmZcIixcbiAgICAgIHNlcTogMSxcbiAgICAgIGV2ZW50VHlwZTogXCJpdGVyYXRpb24tc3RhcnRcIixcbiAgICB9KTtcbiAgICBjb25zdCBldmVudHMgPSByZWFkQXVkaXRFdmVudHMoYmFzZVBhdGgpO1xuICAgIGFzc2VydC5lcXVhbChldmVudHMubGVuZ3RoLCAwKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmMoYmFzZVBhdGgsIHsgcmVj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
