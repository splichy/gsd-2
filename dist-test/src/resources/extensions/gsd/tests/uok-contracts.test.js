import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CURRENT_UOK_CONTRACT_VERSION,
  normalizeAuditEvent,
  validateAuditEvent,
  validateDispatchEnvelope,
  validateTurnResult
} from "../uok/contracts.js";
import { buildAuditEnvelope, emitUokAuditEvent } from "../uok/audit.js";
import { buildDispatchEnvelope, explainDispatch } from "../uok/dispatch-envelope.js";
import { buildTurnTimeline } from "../uok/timeline.js";
import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.js";
test("uok contracts serialize/deserialize turn envelopes", () => {
  const contract = {
    traceId: "trace-1",
    turnId: "turn-1",
    iteration: 1,
    basePath: "/tmp/project",
    unitType: "execute-task",
    unitId: "M001.S01.T01",
    startedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  const gate = {
    gateId: "Q3",
    gateType: "policy",
    outcome: "pass",
    failureClass: "none",
    attempt: 1,
    maxAttempts: 1,
    retryable: false,
    evaluatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  const result = {
    version: CURRENT_UOK_CONTRACT_VERSION,
    traceId: contract.traceId,
    turnId: contract.turnId,
    iteration: contract.iteration,
    unitType: contract.unitType,
    unitId: contract.unitId,
    status: "completed",
    failureClass: "none",
    phaseResults: [
      { phase: "dispatch", action: "next", ts: (/* @__PURE__ */ new Date()).toISOString() },
      { phase: "unit", action: "continue", ts: (/* @__PURE__ */ new Date()).toISOString() },
      { phase: "finalize", action: "next", ts: (/* @__PURE__ */ new Date()).toISOString() }
    ],
    gateResults: [gate],
    startedAt: contract.startedAt,
    finishedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  const roundTrip = JSON.parse(JSON.stringify(result));
  assert.equal(roundTrip.turnId, "turn-1");
  assert.equal(roundTrip.version, CURRENT_UOK_CONTRACT_VERSION);
  assert.equal(roundTrip.gateResults?.[0]?.gateId, "Q3");
  assert.equal(roundTrip.phaseResults.length, 3);
  assert.equal(validateTurnResult(roundTrip).ok, true);
});
test("uok contracts include required DAG node kinds", () => {
  const required = [
    "unit",
    "hook",
    "subagent",
    "team-worker",
    "verification",
    "reprocess",
    "refine"
  ];
  assert.deepEqual(required.length, 7);
});
test("uok audit envelope includes trace/turn/causality fields", () => {
  const event = buildAuditEnvelope({
    traceId: "trace-xyz",
    turnId: "turn-xyz",
    causedBy: "turn-start",
    category: "orchestration",
    type: "turn-result",
    payload: { status: "completed" }
  });
  assert.equal(event.traceId, "trace-xyz");
  assert.equal(event.version, CURRENT_UOK_CONTRACT_VERSION);
  assert.equal(event.turnId, "turn-xyz");
  assert.equal(event.causedBy, "turn-start");
  assert.equal(event.payload.status, "completed");
  assert.equal(validateAuditEvent(event).ok, true);
});
test("uok dispatch envelope carries scheduler reason and constraints", () => {
  const envelope = buildDispatchEnvelope({
    action: "dispatch",
    node: {
      kind: "unit",
      dependsOn: ["plan-gate"],
      reads: ["M001-ROADMAP.md"],
      writes: ["M001/S01/T01-SUMMARY.md"]
    },
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    prompt: "do work",
    reasonCode: "dependency",
    summary: "all dependencies are closed and output path is available",
    evidence: { readyTaskCount: 1 }
  });
  assert.equal(envelope.nodeKind, "unit");
  assert.equal(envelope.version, CURRENT_UOK_CONTRACT_VERSION);
  assert.equal(envelope.reason.reasonCode, "dependency");
  assert.deepEqual(envelope.constraints?.dependsOn, ["plan-gate"]);
  assert.ok(explainDispatch(envelope).includes("execute-task M001/S01/T01"));
  assert.equal(validateDispatchEnvelope(envelope).ok, true);
});
test("uok contracts normalize legacy records without losing payload fields", () => {
  const legacy = {
    eventId: "event-legacy",
    traceId: "trace-legacy",
    category: "orchestration",
    type: "turn-result",
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    payload: { status: "completed", extra: "preserved" }
  };
  const normalized = normalizeAuditEvent(legacy);
  assert.equal(normalized.version, "0");
  assert.equal(normalized.payload.extra, "preserved");
  assert.equal(validateAuditEvent(legacy).ok, true);
});
test("uok audit emission writes DB as authoritative before jsonl projection", (t) => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-uok-db-audit-"));
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  t.after(() => {
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  });
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  emitUokAuditEvent(
    basePath,
    buildAuditEnvelope({
      traceId: "trace-db",
      turnId: "turn-db",
      category: "orchestration",
      type: "turn-start",
      payload: { unitType: "execute-task" }
    })
  );
  const row = _getAdapter().prepare(
    "SELECT payload_json FROM audit_events WHERE trace_id = 'trace-db' AND turn_id = 'turn-db'"
  ).get();
  assert.ok(row, "DB audit row should be written");
  assert.equal(JSON.parse(row.payload_json).contractVersion, CURRENT_UOK_CONTRACT_VERSION);
  const projection = readFileSync(join(basePath, ".gsd", "audit", "events.jsonl"), "utf-8");
  assert.ok(projection.includes("trace-db"), "jsonl projection should still be written");
});
test("uok timeline prefers DB records over jsonl projection when DB is available", (t) => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-uok-timeline-"));
  const auditDir = join(basePath, ".gsd", "audit");
  mkdirSync(auditDir, { recursive: true });
  writeFileSync(
    join(auditDir, "events.jsonl"),
    `${JSON.stringify({
      version: CURRENT_UOK_CONTRACT_VERSION,
      eventId: "jsonl-only",
      traceId: "trace-timeline",
      turnId: "turn-timeline",
      category: "orchestration",
      type: "jsonl-projection",
      ts: "2026-01-01T00:00:00.000Z",
      payload: {}
    })}
`
  );
  t.after(() => {
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  });
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  emitUokAuditEvent(
    basePath,
    buildAuditEnvelope({
      traceId: "trace-timeline",
      turnId: "turn-timeline",
      category: "orchestration",
      type: "db-authoritative",
      payload: {}
    })
  );
  const timeline = buildTurnTimeline(basePath, { traceId: "trace-timeline", turnId: "turn-timeline" });
  assert.equal(timeline.authoritative, "db");
  assert.equal(timeline.degraded, false);
  assert.ok(timeline.entries.some((entry) => entry.type === "db-authoritative"));
  assert.equal(timeline.entries.some((entry) => entry.type === "jsonl-projection"), false);
});
test("uok writer records serialize sequence metadata", () => {
  const token = {
    tokenId: "token-1",
    traceId: "trace-1",
    turnId: "turn-1",
    acquiredAt: (/* @__PURE__ */ new Date()).toISOString(),
    owner: "uok"
  };
  const record = {
    writerToken: token,
    sequence: { traceId: token.traceId, turnId: token.turnId, sequence: 7 },
    category: "audit",
    operation: "append",
    path: ".gsd/audit/events.jsonl",
    ts: (/* @__PURE__ */ new Date()).toISOString()
  };
  const roundTrip = JSON.parse(JSON.stringify(record));
  assert.equal(roundTrip.writerToken.tokenId, "token-1");
  assert.equal(roundTrip.sequence.sequence, 7);
  assert.equal(roundTrip.category, "audit");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy91b2stY29udHJhY3RzLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRDIgVU9LIENvbnRyYWN0IFZlcnNpb25pbmcgYW5kIERCIEF1dGhvcml0eSBUZXN0c1xuXG5pbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZGlyU3luYywgbWtkdGVtcFN5bmMsIHJlYWRGaWxlU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuXG5pbXBvcnQgdHlwZSB7XG4gIEF1ZGl0RXZlbnRFbnZlbG9wZSxcbiAgVW9rRGlzcGF0Y2hFbnZlbG9wZSxcbiAgR2F0ZVJlc3VsdCxcbiAgVHVybkNvbnRyYWN0LFxuICBUdXJuUmVzdWx0LFxuICBVb2tOb2RlS2luZCxcbiAgV3JpdGVSZWNvcmQsXG4gIFdyaXRlclRva2VuLFxufSBmcm9tIFwiLi4vdW9rL2NvbnRyYWN0cy50c1wiO1xuaW1wb3J0IHtcbiAgQ1VSUkVOVF9VT0tfQ09OVFJBQ1RfVkVSU0lPTixcbiAgbm9ybWFsaXplQXVkaXRFdmVudCxcbiAgdmFsaWRhdGVBdWRpdEV2ZW50LFxuICB2YWxpZGF0ZURpc3BhdGNoRW52ZWxvcGUsXG4gIHZhbGlkYXRlVHVyblJlc3VsdCxcbn0gZnJvbSBcIi4uL3Vvay9jb250cmFjdHMudHNcIjtcbmltcG9ydCB7IGJ1aWxkQXVkaXRFbnZlbG9wZSwgZW1pdFVva0F1ZGl0RXZlbnQgfSBmcm9tIFwiLi4vdW9rL2F1ZGl0LnRzXCI7XG5pbXBvcnQgeyBidWlsZERpc3BhdGNoRW52ZWxvcGUsIGV4cGxhaW5EaXNwYXRjaCB9IGZyb20gXCIuLi91b2svZGlzcGF0Y2gtZW52ZWxvcGUudHNcIjtcbmltcG9ydCB7IGJ1aWxkVHVyblRpbWVsaW5lIH0gZnJvbSBcIi4uL3Vvay90aW1lbGluZS50c1wiO1xuaW1wb3J0IHsgX2dldEFkYXB0ZXIsIGNsb3NlRGF0YWJhc2UsIG9wZW5EYXRhYmFzZSB9IGZyb20gXCIuLi9nc2QtZGIudHNcIjtcblxudGVzdChcInVvayBjb250cmFjdHMgc2VyaWFsaXplL2Rlc2VyaWFsaXplIHR1cm4gZW52ZWxvcGVzXCIsICgpID0+IHtcbiAgY29uc3QgY29udHJhY3Q6IFR1cm5Db250cmFjdCA9IHtcbiAgICB0cmFjZUlkOiBcInRyYWNlLTFcIixcbiAgICB0dXJuSWQ6IFwidHVybi0xXCIsXG4gICAgaXRlcmF0aW9uOiAxLFxuICAgIGJhc2VQYXRoOiBcIi90bXAvcHJvamVjdFwiLFxuICAgIHVuaXRUeXBlOiBcImV4ZWN1dGUtdGFza1wiLFxuICAgIHVuaXRJZDogXCJNMDAxLlMwMS5UMDFcIixcbiAgICBzdGFydGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgfTtcblxuICBjb25zdCBnYXRlOiBHYXRlUmVzdWx0ID0ge1xuICAgIGdhdGVJZDogXCJRM1wiLFxuICAgIGdhdGVUeXBlOiBcInBvbGljeVwiLFxuICAgIG91dGNvbWU6IFwicGFzc1wiLFxuICAgIGZhaWx1cmVDbGFzczogXCJub25lXCIsXG4gICAgYXR0ZW1wdDogMSxcbiAgICBtYXhBdHRlbXB0czogMSxcbiAgICByZXRyeWFibGU6IGZhbHNlLFxuICAgIGV2YWx1YXRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gIH07XG5cbiAgY29uc3QgcmVzdWx0OiBUdXJuUmVzdWx0ID0ge1xuICAgIHZlcnNpb246IENVUlJFTlRfVU9LX0NPTlRSQUNUX1ZFUlNJT04sXG4gICAgdHJhY2VJZDogY29udHJhY3QudHJhY2VJZCxcbiAgICB0dXJuSWQ6IGNvbnRyYWN0LnR1cm5JZCxcbiAgICBpdGVyYXRpb246IGNvbnRyYWN0Lml0ZXJhdGlvbixcbiAgICB1bml0VHlwZTogY29udHJhY3QudW5pdFR5cGUsXG4gICAgdW5pdElkOiBjb250cmFjdC51bml0SWQsXG4gICAgc3RhdHVzOiBcImNvbXBsZXRlZFwiLFxuICAgIGZhaWx1cmVDbGFzczogXCJub25lXCIsXG4gICAgcGhhc2VSZXN1bHRzOiBbXG4gICAgICB7IHBoYXNlOiBcImRpc3BhdGNoXCIsIGFjdGlvbjogXCJuZXh0XCIsIHRzOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkgfSxcbiAgICAgIHsgcGhhc2U6IFwidW5pdFwiLCBhY3Rpb246IFwiY29udGludWVcIiwgdHM6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSB9LFxuICAgICAgeyBwaGFzZTogXCJmaW5hbGl6ZVwiLCBhY3Rpb246IFwibmV4dFwiLCB0czogbmV3IERhdGUoKS50b0lTT1N0cmluZygpIH0sXG4gICAgXSxcbiAgICBnYXRlUmVzdWx0czogW2dhdGVdLFxuICAgIHN0YXJ0ZWRBdDogY29udHJhY3Quc3RhcnRlZEF0LFxuICAgIGZpbmlzaGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgfTtcblxuICBjb25zdCByb3VuZFRyaXAgPSBKU09OLnBhcnNlKEpTT04uc3RyaW5naWZ5KHJlc3VsdCkpIGFzIFR1cm5SZXN1bHQ7XG4gIGFzc2VydC5lcXVhbChyb3VuZFRyaXAudHVybklkLCBcInR1cm4tMVwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJvdW5kVHJpcC52ZXJzaW9uLCBDVVJSRU5UX1VPS19DT05UUkFDVF9WRVJTSU9OKTtcbiAgYXNzZXJ0LmVxdWFsKHJvdW5kVHJpcC5nYXRlUmVzdWx0cz8uWzBdPy5nYXRlSWQsIFwiUTNcIik7XG4gIGFzc2VydC5lcXVhbChyb3VuZFRyaXAucGhhc2VSZXN1bHRzLmxlbmd0aCwgMyk7XG4gIGFzc2VydC5lcXVhbCh2YWxpZGF0ZVR1cm5SZXN1bHQocm91bmRUcmlwKS5vaywgdHJ1ZSk7XG59KTtcblxudGVzdChcInVvayBjb250cmFjdHMgaW5jbHVkZSByZXF1aXJlZCBEQUcgbm9kZSBraW5kc1wiLCAoKSA9PiB7XG4gIGNvbnN0IHJlcXVpcmVkOiBVb2tOb2RlS2luZFtdID0gW1xuICAgIFwidW5pdFwiLFxuICAgIFwiaG9va1wiLFxuICAgIFwic3ViYWdlbnRcIixcbiAgICBcInRlYW0td29ya2VyXCIsXG4gICAgXCJ2ZXJpZmljYXRpb25cIixcbiAgICBcInJlcHJvY2Vzc1wiLFxuICAgIFwicmVmaW5lXCIsXG4gIF07XG4gIGFzc2VydC5kZWVwRXF1YWwocmVxdWlyZWQubGVuZ3RoLCA3KTtcbn0pO1xuXG50ZXN0KFwidW9rIGF1ZGl0IGVudmVsb3BlIGluY2x1ZGVzIHRyYWNlL3R1cm4vY2F1c2FsaXR5IGZpZWxkc1wiLCAoKSA9PiB7XG4gIGNvbnN0IGV2ZW50OiBBdWRpdEV2ZW50RW52ZWxvcGUgPSBidWlsZEF1ZGl0RW52ZWxvcGUoe1xuICAgIHRyYWNlSWQ6IFwidHJhY2UteHl6XCIsXG4gICAgdHVybklkOiBcInR1cm4teHl6XCIsXG4gICAgY2F1c2VkQnk6IFwidHVybi1zdGFydFwiLFxuICAgIGNhdGVnb3J5OiBcIm9yY2hlc3RyYXRpb25cIixcbiAgICB0eXBlOiBcInR1cm4tcmVzdWx0XCIsXG4gICAgcGF5bG9hZDogeyBzdGF0dXM6IFwiY29tcGxldGVkXCIgfSxcbiAgfSk7XG5cbiAgYXNzZXJ0LmVxdWFsKGV2ZW50LnRyYWNlSWQsIFwidHJhY2UteHl6XCIpO1xuICBhc3NlcnQuZXF1YWwoZXZlbnQudmVyc2lvbiwgQ1VSUkVOVF9VT0tfQ09OVFJBQ1RfVkVSU0lPTik7XG4gIGFzc2VydC5lcXVhbChldmVudC50dXJuSWQsIFwidHVybi14eXpcIik7XG4gIGFzc2VydC5lcXVhbChldmVudC5jYXVzZWRCeSwgXCJ0dXJuLXN0YXJ0XCIpO1xuICBhc3NlcnQuZXF1YWwoZXZlbnQucGF5bG9hZC5zdGF0dXMsIFwiY29tcGxldGVkXCIpO1xuICBhc3NlcnQuZXF1YWwodmFsaWRhdGVBdWRpdEV2ZW50KGV2ZW50KS5vaywgdHJ1ZSk7XG59KTtcblxudGVzdChcInVvayBkaXNwYXRjaCBlbnZlbG9wZSBjYXJyaWVzIHNjaGVkdWxlciByZWFzb24gYW5kIGNvbnN0cmFpbnRzXCIsICgpID0+IHtcbiAgY29uc3QgZW52ZWxvcGU6IFVva0Rpc3BhdGNoRW52ZWxvcGUgPSBidWlsZERpc3BhdGNoRW52ZWxvcGUoe1xuICAgIGFjdGlvbjogXCJkaXNwYXRjaFwiLFxuICAgIG5vZGU6IHtcbiAgICAgIGtpbmQ6IFwidW5pdFwiLFxuICAgICAgZGVwZW5kc09uOiBbXCJwbGFuLWdhdGVcIl0sXG4gICAgICByZWFkczogW1wiTTAwMS1ST0FETUFQLm1kXCJdLFxuICAgICAgd3JpdGVzOiBbXCJNMDAxL1MwMS9UMDEtU1VNTUFSWS5tZFwiXSxcbiAgICB9LFxuICAgIHVuaXRUeXBlOiBcImV4ZWN1dGUtdGFza1wiLFxuICAgIHVuaXRJZDogXCJNMDAxL1MwMS9UMDFcIixcbiAgICBwcm9tcHQ6IFwiZG8gd29ya1wiLFxuICAgIHJlYXNvbkNvZGU6IFwiZGVwZW5kZW5jeVwiLFxuICAgIHN1bW1hcnk6IFwiYWxsIGRlcGVuZGVuY2llcyBhcmUgY2xvc2VkIGFuZCBvdXRwdXQgcGF0aCBpcyBhdmFpbGFibGVcIixcbiAgICBldmlkZW5jZTogeyByZWFkeVRhc2tDb3VudDogMSB9LFxuICB9KTtcblxuICBhc3NlcnQuZXF1YWwoZW52ZWxvcGUubm9kZUtpbmQsIFwidW5pdFwiKTtcbiAgYXNzZXJ0LmVxdWFsKGVudmVsb3BlLnZlcnNpb24sIENVUlJFTlRfVU9LX0NPTlRSQUNUX1ZFUlNJT04pO1xuICBhc3NlcnQuZXF1YWwoZW52ZWxvcGUucmVhc29uLnJlYXNvbkNvZGUsIFwiZGVwZW5kZW5jeVwiKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChlbnZlbG9wZS5jb25zdHJhaW50cz8uZGVwZW5kc09uLCBbXCJwbGFuLWdhdGVcIl0pO1xuICBhc3NlcnQub2soZXhwbGFpbkRpc3BhdGNoKGVudmVsb3BlKS5pbmNsdWRlcyhcImV4ZWN1dGUtdGFzayBNMDAxL1MwMS9UMDFcIikpO1xuICBhc3NlcnQuZXF1YWwodmFsaWRhdGVEaXNwYXRjaEVudmVsb3BlKGVudmVsb3BlKS5vaywgdHJ1ZSk7XG59KTtcblxudGVzdChcInVvayBjb250cmFjdHMgbm9ybWFsaXplIGxlZ2FjeSByZWNvcmRzIHdpdGhvdXQgbG9zaW5nIHBheWxvYWQgZmllbGRzXCIsICgpID0+IHtcbiAgY29uc3QgbGVnYWN5ID0ge1xuICAgIGV2ZW50SWQ6IFwiZXZlbnQtbGVnYWN5XCIsXG4gICAgdHJhY2VJZDogXCJ0cmFjZS1sZWdhY3lcIixcbiAgICBjYXRlZ29yeTogXCJvcmNoZXN0cmF0aW9uXCIsXG4gICAgdHlwZTogXCJ0dXJuLXJlc3VsdFwiLFxuICAgIHRzOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgcGF5bG9hZDogeyBzdGF0dXM6IFwiY29tcGxldGVkXCIsIGV4dHJhOiBcInByZXNlcnZlZFwiIH0sXG4gIH0gYXMgQXVkaXRFdmVudEVudmVsb3BlO1xuXG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVBdWRpdEV2ZW50KGxlZ2FjeSk7XG4gIGFzc2VydC5lcXVhbChub3JtYWxpemVkLnZlcnNpb24sIFwiMFwiKTtcbiAgYXNzZXJ0LmVxdWFsKG5vcm1hbGl6ZWQucGF5bG9hZC5leHRyYSwgXCJwcmVzZXJ2ZWRcIik7XG4gIGFzc2VydC5lcXVhbCh2YWxpZGF0ZUF1ZGl0RXZlbnQobGVnYWN5KS5vaywgdHJ1ZSk7XG59KTtcblxudGVzdChcInVvayBhdWRpdCBlbWlzc2lvbiB3cml0ZXMgREIgYXMgYXV0aG9yaXRhdGl2ZSBiZWZvcmUganNvbmwgcHJvamVjdGlvblwiLCAodCkgPT4ge1xuICBjb25zdCBiYXNlUGF0aCA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXVvay1kYi1hdWRpdC1cIikpO1xuICBta2RpclN5bmMoam9pbihiYXNlUGF0aCwgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgdC5hZnRlcigoKSA9PiB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIHJtU3luYyhiYXNlUGF0aCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcblxuICBhc3NlcnQuZXF1YWwob3BlbkRhdGFiYXNlKGpvaW4oYmFzZVBhdGgsIFwiLmdzZFwiLCBcImdzZC5kYlwiKSksIHRydWUpO1xuICBlbWl0VW9rQXVkaXRFdmVudChcbiAgICBiYXNlUGF0aCxcbiAgICBidWlsZEF1ZGl0RW52ZWxvcGUoe1xuICAgICAgdHJhY2VJZDogXCJ0cmFjZS1kYlwiLFxuICAgICAgdHVybklkOiBcInR1cm4tZGJcIixcbiAgICAgIGNhdGVnb3J5OiBcIm9yY2hlc3RyYXRpb25cIixcbiAgICAgIHR5cGU6IFwidHVybi1zdGFydFwiLFxuICAgICAgcGF5bG9hZDogeyB1bml0VHlwZTogXCJleGVjdXRlLXRhc2tcIiB9LFxuICAgIH0pLFxuICApO1xuXG4gIGNvbnN0IHJvdyA9IF9nZXRBZGFwdGVyKCkhLnByZXBhcmUoXG4gICAgXCJTRUxFQ1QgcGF5bG9hZF9qc29uIEZST00gYXVkaXRfZXZlbnRzIFdIRVJFIHRyYWNlX2lkID0gJ3RyYWNlLWRiJyBBTkQgdHVybl9pZCA9ICd0dXJuLWRiJ1wiLFxuICApLmdldCgpIGFzIHsgcGF5bG9hZF9qc29uOiBzdHJpbmcgfSB8IHVuZGVmaW5lZDtcbiAgYXNzZXJ0Lm9rKHJvdywgXCJEQiBhdWRpdCByb3cgc2hvdWxkIGJlIHdyaXR0ZW5cIik7XG4gIGFzc2VydC5lcXVhbChKU09OLnBhcnNlKHJvdy5wYXlsb2FkX2pzb24pLmNvbnRyYWN0VmVyc2lvbiwgQ1VSUkVOVF9VT0tfQ09OVFJBQ1RfVkVSU0lPTik7XG5cbiAgY29uc3QgcHJvamVjdGlvbiA9IHJlYWRGaWxlU3luYyhqb2luKGJhc2VQYXRoLCBcIi5nc2RcIiwgXCJhdWRpdFwiLCBcImV2ZW50cy5qc29ubFwiKSwgXCJ1dGYtOFwiKTtcbiAgYXNzZXJ0Lm9rKHByb2plY3Rpb24uaW5jbHVkZXMoXCJ0cmFjZS1kYlwiKSwgXCJqc29ubCBwcm9qZWN0aW9uIHNob3VsZCBzdGlsbCBiZSB3cml0dGVuXCIpO1xufSk7XG5cbnRlc3QoXCJ1b2sgdGltZWxpbmUgcHJlZmVycyBEQiByZWNvcmRzIG92ZXIganNvbmwgcHJvamVjdGlvbiB3aGVuIERCIGlzIGF2YWlsYWJsZVwiLCAodCkgPT4ge1xuICBjb25zdCBiYXNlUGF0aCA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXVvay10aW1lbGluZS1cIikpO1xuICBjb25zdCBhdWRpdERpciA9IGpvaW4oYmFzZVBhdGgsIFwiLmdzZFwiLCBcImF1ZGl0XCIpO1xuICBta2RpclN5bmMoYXVkaXREaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4oYXVkaXREaXIsIFwiZXZlbnRzLmpzb25sXCIpLFxuICAgIGAke0pTT04uc3RyaW5naWZ5KHtcbiAgICAgIHZlcnNpb246IENVUlJFTlRfVU9LX0NPTlRSQUNUX1ZFUlNJT04sXG4gICAgICBldmVudElkOiBcImpzb25sLW9ubHlcIixcbiAgICAgIHRyYWNlSWQ6IFwidHJhY2UtdGltZWxpbmVcIixcbiAgICAgIHR1cm5JZDogXCJ0dXJuLXRpbWVsaW5lXCIsXG4gICAgICBjYXRlZ29yeTogXCJvcmNoZXN0cmF0aW9uXCIsXG4gICAgICB0eXBlOiBcImpzb25sLXByb2plY3Rpb25cIixcbiAgICAgIHRzOiBcIjIwMjYtMDEtMDFUMDA6MDA6MDAuMDAwWlwiLFxuICAgICAgcGF5bG9hZDoge30sXG4gICAgfSl9XFxuYCxcbiAgKTtcbiAgdC5hZnRlcigoKSA9PiB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIHJtU3luYyhiYXNlUGF0aCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcblxuICBhc3NlcnQuZXF1YWwob3BlbkRhdGFiYXNlKGpvaW4oYmFzZVBhdGgsIFwiLmdzZFwiLCBcImdzZC5kYlwiKSksIHRydWUpO1xuICBlbWl0VW9rQXVkaXRFdmVudChcbiAgICBiYXNlUGF0aCxcbiAgICBidWlsZEF1ZGl0RW52ZWxvcGUoe1xuICAgICAgdHJhY2VJZDogXCJ0cmFjZS10aW1lbGluZVwiLFxuICAgICAgdHVybklkOiBcInR1cm4tdGltZWxpbmVcIixcbiAgICAgIGNhdGVnb3J5OiBcIm9yY2hlc3RyYXRpb25cIixcbiAgICAgIHR5cGU6IFwiZGItYXV0aG9yaXRhdGl2ZVwiLFxuICAgICAgcGF5bG9hZDoge30sXG4gICAgfSksXG4gICk7XG5cbiAgY29uc3QgdGltZWxpbmUgPSBidWlsZFR1cm5UaW1lbGluZShiYXNlUGF0aCwgeyB0cmFjZUlkOiBcInRyYWNlLXRpbWVsaW5lXCIsIHR1cm5JZDogXCJ0dXJuLXRpbWVsaW5lXCIgfSk7XG4gIGFzc2VydC5lcXVhbCh0aW1lbGluZS5hdXRob3JpdGF0aXZlLCBcImRiXCIpO1xuICBhc3NlcnQuZXF1YWwodGltZWxpbmUuZGVncmFkZWQsIGZhbHNlKTtcbiAgYXNzZXJ0Lm9rKHRpbWVsaW5lLmVudHJpZXMuc29tZSgoZW50cnkpID0+IGVudHJ5LnR5cGUgPT09IFwiZGItYXV0aG9yaXRhdGl2ZVwiKSk7XG4gIGFzc2VydC5lcXVhbCh0aW1lbGluZS5lbnRyaWVzLnNvbWUoKGVudHJ5KSA9PiBlbnRyeS50eXBlID09PSBcImpzb25sLXByb2plY3Rpb25cIiksIGZhbHNlKTtcbn0pO1xuXG50ZXN0KFwidW9rIHdyaXRlciByZWNvcmRzIHNlcmlhbGl6ZSBzZXF1ZW5jZSBtZXRhZGF0YVwiLCAoKSA9PiB7XG4gIGNvbnN0IHRva2VuOiBXcml0ZXJUb2tlbiA9IHtcbiAgICB0b2tlbklkOiBcInRva2VuLTFcIixcbiAgICB0cmFjZUlkOiBcInRyYWNlLTFcIixcbiAgICB0dXJuSWQ6IFwidHVybi0xXCIsXG4gICAgYWNxdWlyZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgIG93bmVyOiBcInVva1wiLFxuICB9O1xuXG4gIGNvbnN0IHJlY29yZDogV3JpdGVSZWNvcmQgPSB7XG4gICAgd3JpdGVyVG9rZW46IHRva2VuLFxuICAgIHNlcXVlbmNlOiB7IHRyYWNlSWQ6IHRva2VuLnRyYWNlSWQsIHR1cm5JZDogdG9rZW4udHVybklkLCBzZXF1ZW5jZTogNyB9LFxuICAgIGNhdGVnb3J5OiBcImF1ZGl0XCIsXG4gICAgb3BlcmF0aW9uOiBcImFwcGVuZFwiLFxuICAgIHBhdGg6IFwiLmdzZC9hdWRpdC9ldmVudHMuanNvbmxcIixcbiAgICB0czogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICB9O1xuXG4gIGNvbnN0IHJvdW5kVHJpcCA9IEpTT04ucGFyc2UoSlNPTi5zdHJpbmdpZnkocmVjb3JkKSkgYXMgV3JpdGVSZWNvcmQ7XG4gIGFzc2VydC5lcXVhbChyb3VuZFRyaXAud3JpdGVyVG9rZW4udG9rZW5JZCwgXCJ0b2tlbi0xXCIpO1xuICBhc3NlcnQuZXF1YWwocm91bmRUcmlwLnNlcXVlbmNlLnNlcXVlbmNlLCA3KTtcbiAgYXNzZXJ0LmVxdWFsKHJvdW5kVHJpcC5jYXRlZ29yeSwgXCJhdWRpdFwiKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBRUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUNuQixTQUFTLFdBQVcsYUFBYSxjQUFjLFFBQVEscUJBQXFCO0FBQzVFLFNBQVMsY0FBYztBQUN2QixTQUFTLFlBQVk7QUFZckI7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFDUCxTQUFTLG9CQUFvQix5QkFBeUI7QUFDdEQsU0FBUyx1QkFBdUIsdUJBQXVCO0FBQ3ZELFNBQVMseUJBQXlCO0FBQ2xDLFNBQVMsYUFBYSxlQUFlLG9CQUFvQjtBQUV6RCxLQUFLLHNEQUFzRCxNQUFNO0FBQy9ELFFBQU0sV0FBeUI7QUFBQSxJQUM3QixTQUFTO0FBQUEsSUFDVCxRQUFRO0FBQUEsSUFDUixXQUFXO0FBQUEsSUFDWCxVQUFVO0FBQUEs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
