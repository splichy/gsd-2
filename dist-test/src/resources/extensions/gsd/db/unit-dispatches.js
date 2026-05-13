import { randomUUID } from "node:crypto";
import {
  _getAdapter,
  isDbAvailable,
  transaction,
  insertAuditEvent
} from "../gsd-db.js";
function isAlreadyActiveConstraintError(err) {
  const code = err && typeof err === "object" && "code" in err ? String(err.code ?? "") : "";
  const msg = err instanceof Error ? err.message : String(err);
  if (/\bFOREIGN KEY\b/i.test(msg)) {
    return false;
  }
  if (code === "SQLITE_CONSTRAINT" || code === "SQLITE_CONSTRAINT_UNIQUE") {
    return true;
  }
  return /\bUNIQUE\b|\bconstraint failed\b/i.test(msg);
}
function settleStaleActiveDispatchForUnit(input, now) {
  const db = _getAdapter();
  const active = db.prepare(
    `SELECT id, status, worker_id, milestone_lease_token
     FROM unit_dispatches
     WHERE unit_id = :unit_id
       AND status IN ('claimed','running')
     ORDER BY id DESC
     LIMIT 1`
  ).get({ ":unit_id": input.unitId });
  if (!active) return;
  if (active.worker_id === input.workerId && active.milestone_lease_token === input.milestoneLeaseToken) {
    return;
  }
  const reason = "stale-dispatch-lease-takeover";
  const result = db.prepare(
    `UPDATE unit_dispatches
     SET status = 'canceled',
         ended_at = :ended_at,
         exit_reason = :reason
     WHERE id = :id
       AND status IN ('claimed','running')
       AND (worker_id != :worker_id OR milestone_lease_token != :token)`
  ).run({
    ":id": active.id,
    ":ended_at": now,
    ":reason": reason,
    ":worker_id": input.workerId,
    ":token": input.milestoneLeaseToken
  });
  const changes = typeof result.changes === "number" ? result.changes : 0;
  if (changes < 1) return;
  insertAuditEvent({
    eventId: randomUUID(),
    traceId: input.traceId,
    turnId: input.turnId ?? void 0,
    category: "orchestration",
    type: "dispatch-stale-canceled",
    ts: now,
    payload: {
      dispatchId: active.id,
      unitId: input.unitId,
      priorStatus: active.status,
      priorWorkerId: active.worker_id,
      priorMilestoneLeaseToken: active.milestone_lease_token,
      takeoverWorkerId: input.workerId,
      takeoverMilestoneLeaseToken: input.milestoneLeaseToken,
      reason
    }
  });
}
function recordDispatchClaim(input) {
  if (!isDbAvailable()) {
    throw new Error("recordDispatchClaim: DB unavailable");
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  return transaction(() => {
    const db = _getAdapter();
    const lease = db.prepare(
      `SELECT fencing_token
       FROM milestone_leases
       WHERE milestone_id = :milestone_id
         AND worker_id = :worker_id
         AND fencing_token = :token
         AND status = 'held'`
    ).get({
      ":milestone_id": input.milestoneId,
      ":worker_id": input.workerId,
      ":token": input.milestoneLeaseToken
    });
    if (!lease) {
      return {
        ok: false,
        error: "stale_lease",
        milestoneId: input.milestoneId,
        workerId: input.workerId,
        milestoneLeaseToken: input.milestoneLeaseToken
      };
    }
    settleStaleActiveDispatchForUnit(input, now);
    try {
      const result = db.prepare(
        `INSERT INTO unit_dispatches (
          trace_id, turn_id, worker_id, milestone_lease_token,
          milestone_id, slice_id, task_id,
          unit_type, unit_id, status, attempt_n,
          started_at, max_attempts
        ) VALUES (
          :trace_id, :turn_id, :worker_id, :milestone_lease_token,
          :milestone_id, :slice_id, :task_id,
          :unit_type, :unit_id, 'claimed', :attempt_n,
          :started_at, :max_attempts
        )`
      ).run({
        ":trace_id": input.traceId,
        ":turn_id": input.turnId ?? null,
        ":worker_id": input.workerId,
        ":milestone_lease_token": input.milestoneLeaseToken,
        ":milestone_id": input.milestoneId,
        ":slice_id": input.sliceId ?? null,
        ":task_id": input.taskId ?? null,
        ":unit_type": input.unitType,
        ":unit_id": input.unitId,
        ":attempt_n": input.attemptN ?? 1,
        ":started_at": now,
        ":max_attempts": input.maxAttempts ?? 3
      });
      const id = Number(result.lastInsertRowid ?? 0);
      insertAuditEvent({
        eventId: randomUUID(),
        traceId: input.traceId,
        turnId: input.turnId ?? void 0,
        category: "orchestration",
        type: "dispatch-claimed",
        ts: now,
        payload: {
          dispatchId: id,
          unitId: input.unitId,
          unitType: input.unitType,
          workerId: input.workerId,
          attemptN: input.attemptN ?? 1
        }
      });
      return { ok: true, dispatchId: id };
    } catch (err) {
      if (!isAlreadyActiveConstraintError(err)) throw err;
      const existing = db.prepare(
        `SELECT id, status, worker_id FROM unit_dispatches
         WHERE unit_id = :unit_id AND status IN ('claimed','running')
         ORDER BY id DESC LIMIT 1`
      ).get({ ":unit_id": input.unitId });
      return {
        ok: false,
        error: "already_active",
        existingId: existing?.id ?? 0,
        existingStatus: existing?.status ?? "claimed",
        existingWorker: existing?.worker_id ?? "unknown"
      };
    }
  });
}
function markRunning(dispatchId) {
  if (!isDbAvailable()) return;
  const db = _getAdapter();
  db.prepare(
    `UPDATE unit_dispatches SET status = 'running'
     WHERE id = :id AND status = 'claimed'`
  ).run({ ":id": dispatchId });
}
function markCompleted(dispatchId, opts) {
  if (!isDbAvailable()) return;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const db = _getAdapter();
  let changes = 0;
  transaction(() => {
    const result = db.prepare(
      `UPDATE unit_dispatches
       SET status = 'completed', ended_at = :ended_at,
           exit_reason = :exit_reason,
           verification_evidence_id = :evidence_id
       WHERE id = :id
         AND status IN ('claimed','running')`
    ).run({
      ":id": dispatchId,
      ":ended_at": now,
      ":exit_reason": opts?.exitReason ?? null,
      ":evidence_id": opts?.verificationEvidenceId ?? null
    });
    changes = typeof result.changes === "number" ? result.changes : 0;
  });
  if (changes < 1) return;
  insertAuditEvent({
    eventId: randomUUID(),
    traceId: dispatchId.toString(),
    category: "orchestration",
    type: "dispatch-completed",
    ts: now,
    payload: { dispatchId }
  });
}
function markFailed(dispatchId, opts) {
  if (!isDbAvailable()) return;
  const now = /* @__PURE__ */ new Date();
  const nowIso = now.toISOString();
  const nextRunIso = opts.retryAfterMs ? new Date(now.getTime() + opts.retryAfterMs).toISOString() : null;
  const db = _getAdapter();
  let changes = 0;
  transaction(() => {
    const result = db.prepare(
      `UPDATE unit_dispatches
       SET status = 'failed', ended_at = :ended_at,
           error_summary = :error_summary,
           last_error_code = :last_error_code,
           last_error_at = :last_error_at,
           retry_after_ms = :retry_after_ms,
           next_run_at = :next_run_at
       WHERE id = :id
         AND status IN ('claimed','running')`
    ).run({
      ":id": dispatchId,
      ":ended_at": nowIso,
      ":error_summary": opts.errorSummary,
      ":last_error_code": opts.errorCode ?? null,
      ":last_error_at": nowIso,
      ":retry_after_ms": opts.retryAfterMs ?? null,
      ":next_run_at": nextRunIso
    });
    changes = typeof result.changes === "number" ? result.changes : 0;
  });
  if (changes < 1) return;
  insertAuditEvent({
    eventId: randomUUID(),
    traceId: dispatchId.toString(),
    category: "orchestration",
    type: "dispatch-failed",
    ts: nowIso,
    payload: { dispatchId, errorSummary: opts.errorSummary, retryAfterMs: opts.retryAfterMs ?? null }
  });
}
function markStuck(dispatchId, reason) {
  if (!isDbAvailable()) return;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const db = _getAdapter();
  const result = transaction(() => {
    return db.prepare(
      `UPDATE unit_dispatches
       SET status = 'stuck', ended_at = :ended_at, exit_reason = :reason
       WHERE id = :id
         AND status IN ('claimed','running')`
    ).run({ ":id": dispatchId, ":ended_at": now, ":reason": reason });
  });
  const changes = typeof result.changes === "number" ? result.changes : 0;
  if (changes <= 0) return;
  insertAuditEvent({
    eventId: randomUUID(),
    traceId: dispatchId.toString(),
    category: "orchestration",
    type: "dispatch-stuck",
    ts: now,
    payload: { dispatchId, reason }
  });
}
function markPaused(dispatchId) {
  if (!isDbAvailable()) return;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const db = _getAdapter();
  db.prepare(
    `UPDATE unit_dispatches
     SET status = 'paused', ended_at = :ended_at
     WHERE id = :id AND status IN ('claimed','running')`
  ).run({ ":id": dispatchId, ":ended_at": now });
}
function markCanceled(dispatchId, reason) {
  if (!isDbAvailable()) return;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const db = _getAdapter();
  db.prepare(
    `UPDATE unit_dispatches
     SET status = 'canceled', ended_at = :ended_at, exit_reason = :reason
     WHERE id = :id AND status IN ('pending','claimed','running')`
  ).run({ ":id": dispatchId, ":ended_at": now, ":reason": reason });
}
function markLatestActiveForWorkerCanceled(workerId, reason) {
  if (!isDbAvailable()) return false;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const db = _getAdapter();
  const result = transaction(() => {
    return db.prepare(
      `UPDATE unit_dispatches
       SET status = 'canceled', ended_at = :ended_at, exit_reason = :reason
       WHERE id = (
         SELECT id FROM unit_dispatches
         WHERE worker_id = :worker_id
           AND status IN ('pending','claimed','running')
         ORDER BY id DESC
         LIMIT 1
       )`
    ).run({
      ":ended_at": now,
      ":reason": reason,
      ":worker_id": workerId
    });
  });
  const changes = typeof result.changes === "number" ? result.changes : 0;
  if (changes <= 0) return false;
  insertAuditEvent({
    eventId: randomUUID(),
    traceId: workerId,
    category: "orchestration",
    type: "dispatch-canceled",
    ts: now,
    payload: { workerId, reason }
  });
  return true;
}
function getRecentForUnit(unitId, limit = 10) {
  if (!isDbAvailable()) return [];
  const db = _getAdapter();
  return db.prepare(
    `SELECT * FROM unit_dispatches WHERE unit_id = :unit_id ORDER BY id DESC LIMIT :limit`
  ).all({ ":unit_id": unitId, ":limit": limit });
}
function getLatestForUnit(unitId) {
  if (!isDbAvailable()) return null;
  const db = _getAdapter();
  const row = db.prepare(
    `SELECT * FROM unit_dispatches WHERE unit_id = :unit_id ORDER BY id DESC LIMIT 1`
  ).get({ ":unit_id": unitId });
  return row ?? null;
}
function getRecentUnitKeysForWorker(workerId, limit = 20) {
  if (!isDbAvailable()) return [];
  const db = _getAdapter();
  const rows = db.prepare(
    `SELECT unit_id FROM unit_dispatches
     WHERE worker_id = :worker_id
     ORDER BY started_at DESC, id DESC
     LIMIT :limit`
  ).all({ ":worker_id": workerId, ":limit": limit });
  return rows.reverse().map((r) => ({ key: r.unit_id }));
}
function getRecentUnitKeysForProjectRoot(projectRootRealpath, limit = 20) {
  if (!isDbAvailable()) return [];
  const db = _getAdapter();
  const rows = db.prepare(
    `SELECT ud.unit_type, ud.unit_id
     FROM unit_dispatches ud
     INNER JOIN workers w ON w.worker_id = ud.worker_id
     WHERE w.project_root_realpath = :project_root_realpath
       AND w.status != 'crashed'
     ORDER BY ud.started_at DESC, ud.id DESC
     LIMIT :limit`
  ).all({
    ":project_root_realpath": projectRootRealpath,
    ":limit": limit
  });
  return rows.reverse().map((r) => ({ key: `${r.unit_type}/${r.unit_id}` }));
}
function getDispatchesByStatus(milestoneId, status) {
  if (!isDbAvailable()) return [];
  const db = _getAdapter();
  return db.prepare(
    `SELECT * FROM unit_dispatches WHERE milestone_id = :mid AND status = :status ORDER BY id`
  ).all({ ":mid": milestoneId, ":status": status });
}
export {
  getDispatchesByStatus,
  getLatestForUnit,
  getRecentForUnit,
  getRecentUnitKeysForProjectRoot,
  getRecentUnitKeysForWorker,
  markCanceled,
  markCompleted,
  markFailed,
  markLatestActiveForWorkerCanceled,
  markPaused,
  markRunning,
  markStuck,
  recordDispatchClaim
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9kYi91bml0LWRpc3BhdGNoZXMudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIGdzZC0yICsgVW5pdCBkaXNwYXRjaCBsZWRnZXIgKERCLWJhY2tlZCBjb29yZGluYXRpb24sIFBoYXNlIEIpXG4vL1xuLy8gUmVjb3JkcyBldmVyeSBhdXRvLW1vZGUgdW5pdCBkaXNwYXRjaCAocGxhbi1zbGljZSwgcnVuLXRhc2ssIHN1bW1hcml6ZSwgXHUyMDI2KVxuLy8gd2l0aCB3b3JrZXJfaWQsIGZlbmNpbmcgdG9rZW4sIHN0YXR1cyBsaWZlY3ljbGUsIGFuZCByZXRyeSBtZXRhZGF0YS4gVGhlXG4vLyBsZWRnZXIgaXMgdGhlIHN1YnN0cmF0ZSBQaGFzZSBDIHdpbGwgY29uc3VtZSB0byBtaWdyYXRlIHN0dWNrLXN0YXRlLmpzb25cbi8vIGFuZCBwYXVzZWQtc2Vzc2lvbi5qc29uIG91dCBvZiB0aGUgcnVudGltZS8gZGlyZWN0b3J5LlxuLy9cbi8vIENvZGV4IHJldmlldyBNRURJVU0gQjI6IHBhcnRpYWwgdW5pcXVlIGluZGV4XG4vLyAgIGlkeF91bml0X2Rpc3BhdGNoZXNfYWN0aXZlX3Blcl91bml0IE9OIHVuaXRfZGlzcGF0Y2hlcyh1bml0X2lkKVxuLy8gICBXSEVSRSBzdGF0dXMgSU4gKCdjbGFpbWVkJywncnVubmluZycpXG4vLyBlbmZvcmNlcyB0aGF0IHR3byB3b3JrZXJzIGNhbm5vdCBzaW11bHRhbmVvdXNseSBjbGFpbSB0aGUgc2FtZSB1bml0LlxuLy8gcmVjb3JkRGlzcGF0Y2hDbGFpbSByZWxpZXMgb24gdGhlIGluZGV4IHRvIGZhaWwgZmFzdCBhdCBJTlNFUlQgdGltZVxuLy8gcmF0aGVyIHRoYW4gcmFjaW5nIGluIGFwcGxpY2F0aW9uIGNvZGUuXG5cbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcblxuaW1wb3J0IHtcbiAgX2dldEFkYXB0ZXIsXG4gIGlzRGJBdmFpbGFibGUsXG4gIHRyYW5zYWN0aW9uLFxuICBpbnNlcnRBdWRpdEV2ZW50LFxufSBmcm9tIFwiLi4vZ3NkLWRiLmpzXCI7XG5cbmV4cG9ydCB0eXBlIERpc3BhdGNoU3RhdHVzID1cbiAgfCBcInBlbmRpbmdcIlxuICB8IFwiY2xhaW1lZFwiXG4gIHwgXCJydW5uaW5nXCJcbiAgfCBcImNvbXBsZXRlZFwiXG4gIHwgXCJmYWlsZWRcIlxuICB8IFwic3R1Y2tcIlxuICB8IFwiY2FuY2VsZWRcIlxuICB8IFwicGF1c2VkXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgVW5pdERpc3BhdGNoUm93IHtcbiAgaWQ6IG51bWJlcjtcbiAgdHJhY2VfaWQ6IHN0cmluZztcbiAgdHVybl9pZDogc3RyaW5nIHwgbnVsbDtcbiAgd29ya2VyX2lkOiBzdHJpbmc7XG4gIG1pbGVzdG9uZV9sZWFzZV90b2tlbjogbnVtYmVyO1xuICBtaWxlc3RvbmVfaWQ6IHN0cmluZztcbiAgc2xpY2VfaWQ6IHN0cmluZyB8IG51bGw7XG4gIHRhc2tfaWQ6IHN0cmluZyB8IG51bGw7XG4gIHVuaXRfdHlwZTogc3RyaW5nO1xuICB1bml0X2lkOiBzdHJpbmc7XG4gIHN0YXR1czogRGlzcGF0Y2hTdGF0dXM7XG4gIGF0dGVtcHRfbjogbnVtYmVyO1xuICBzdGFydGVkX2F0OiBzdHJpbmc7XG4gIGVuZGVkX2F0OiBzdHJpbmcgfCBudWxsO1xuICBleGl0X3JlYXNvbjogc3RyaW5nIHwgbnVsbDtcbiAgZXJyb3Jfc3VtbWFyeTogc3RyaW5nIHwgbnVsbDtcbiAgdmVyaWZpY2F0aW9uX2V2aWRlbmNlX2lkOiBudW1iZXIgfCBudWxsO1xuICBuZXh0X3J1bl9hdDogc3RyaW5nIHwgbnVsbDtcbiAgcmV0cnlfYWZ0ZXJfbXM6IG51bWJlciB8IG51bGw7XG4gIG1heF9hdHRlbXB0czogbnVtYmVyO1xuICBsYXN0X2Vycm9yX2NvZGU6IHN0cmluZyB8IG51bGw7XG4gIGxhc3RfZXJyb3JfYXQ6IHN0cmluZyB8IG51bGw7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUmVjb3JkQ2xhaW1JbnB1dCB7XG4gIHRyYWNlSWQ6IHN0cmluZztcbiAgdHVybklkPzogc3RyaW5nIHwgbnVsbDtcbiAgd29ya2VySWQ6IHN0cmluZztcbiAgbWlsZXN0b25lTGVhc2VUb2tlbjogbnVtYmVyO1xuICBtaWxlc3RvbmVJZDogc3RyaW5nO1xuICBzbGljZUlkPzogc3RyaW5nIHwgbnVsbDtcbiAgdGFza0lkPzogc3RyaW5nIHwgbnVsbDtcbiAgdW5pdFR5cGU6IHN0cmluZztcbiAgdW5pdElkOiBzdHJpbmc7XG4gIC8qKlxuICAgKiBBdHRlbXB0IG51bWJlciBmb3IgdGhpcyB1bml0LiBDYWxsZXJzIHNob3VsZCBjb21wdXRlIHRoaXMgZnJvbSB0aGVcbiAgICogbW9zdCByZWNlbnQgcHJpb3IgZGlzcGF0Y2ggZm9yIHRoZSBzYW1lIHVuaXRfaWQgKHVzZVxuICAgKiBnZXRSZWNlbnRGb3JVbml0KCkgdGhlbiBhZGQgMSkuIERlZmF1bHRzIHRvIDEgZm9yIGZyZXNoIGNsYWltcy5cbiAgICovXG4gIGF0dGVtcHROPzogbnVtYmVyO1xuICAvKiogUGVyLWF0dGVtcHQgY2FwOyBkZWZhdWx0cyB0byAzLiAqL1xuICBtYXhBdHRlbXB0cz86IG51bWJlcjtcbn1cblxuZXhwb3J0IHR5cGUgUmVjb3JkQ2xhaW1SZXN1bHQgPVxuICB8IHsgb2s6IHRydWU7IGRpc3BhdGNoSWQ6IG51bWJlciB9XG4gIHwgeyBvazogZmFsc2U7IGVycm9yOiBcImFscmVhZHlfYWN0aXZlXCI7IGV4aXN0aW5nSWQ6IG51bWJlcjsgZXhpc3RpbmdTdGF0dXM6IERpc3BhdGNoU3RhdHVzOyBleGlzdGluZ1dvcmtlcjogc3RyaW5nIH1cbiAgfCB7IG9rOiBmYWxzZTsgZXJyb3I6IFwic3RhbGVfbGVhc2VcIjsgbWlsZXN0b25lSWQ6IHN0cmluZzsgd29ya2VySWQ6IHN0cmluZzsgbWlsZXN0b25lTGVhc2VUb2tlbjogbnVtYmVyIH07XG5cbmZ1bmN0aW9uIGlzQWxyZWFkeUFjdGl2ZUNvbnN0cmFpbnRFcnJvcihlcnI6IHVua25vd24pOiBib29sZWFuIHtcbiAgY29uc3QgY29kZSA9XG4gICAgZXJyICYmIHR5cGVvZiBlcnIgPT09IFwib2JqZWN0XCIgJiYgXCJjb2RlXCIgaW4gZXJyXG4gICAgICA/IFN0cmluZygoZXJyIGFzIHsgY29kZT86IHVua25vd24gfSkuY29kZSA/PyBcIlwiKVxuICAgICAgOiBcIlwiO1xuICBjb25zdCBtc2cgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gIGlmICgvXFxiRk9SRUlHTiBLRVlcXGIvaS50ZXN0KG1zZykpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICBpZiAoY29kZSA9PT0gXCJTUUxJVEVfQ09OU1RSQUlOVFwiIHx8IGNvZGUgPT09IFwiU1FMSVRFX0NPTlNUUkFJTlRfVU5JUVVFXCIpIHtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIHJldHVybiAvXFxiVU5JUVVFXFxifFxcYmNvbnN0cmFpbnQgZmFpbGVkXFxiL2kudGVzdChtc2cpO1xufVxuXG5mdW5jdGlvbiBzZXR0bGVTdGFsZUFjdGl2ZURpc3BhdGNoRm9yVW5pdChpbnB1dDogUmVjb3JkQ2xhaW1JbnB1dCwgbm93OiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgZGIgPSBfZ2V0QWRhcHRlcigpITtcbiAgY29uc3QgYWN0aXZlID0gZGIucHJlcGFyZShcbiAgICBgU0VMRUNUIGlkLCBzdGF0dXMsIHdvcmtlcl9pZCwgbWlsZXN0b25lX2xlYXNlX3Rva2VuXG4gICAgIEZST00gdW5pdF9kaXNwYXRjaGVzXG4gICAgIFdIRVJFIHVuaXRfaWQgPSA6dW5pdF9pZFxuICAgICAgIEFORCBzdGF0dXMgSU4gKCdjbGFpbWVkJywncnVubmluZycpXG4gICAgIE9SREVSIEJZIGlkIERFU0NcbiAgICAgTElNSVQgMWAsXG4gICkuZ2V0KHsgXCI6dW5pdF9pZFwiOiBpbnB1dC51bml0SWQgfSkgYXNcbiAgICB8IHsgaWQ6IG51bWJlcjsgc3RhdHVzOiBEaXNwYXRjaFN0YXR1czsgd29ya2VyX2lkOiBzdHJpbmc7IG1pbGVzdG9uZV9sZWFzZV90b2tlbjogbnVtYmVyIH1cbiAgICB8IHVuZGVmaW5lZDtcblxuICBpZiAoIWFjdGl2ZSkgcmV0dXJuO1xuICBpZiAoXG4gICAgYWN0aXZlLndvcmtlcl9pZCA9PT0gaW5wdXQud29ya2VySWQgJiZcbiAgICBhY3RpdmUubWlsZXN0b25lX2xlYXNlX3Rva2VuID09PSBpbnB1dC5taWxlc3RvbmVMZWFzZVRva2VuXG4gICkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHJlYXNvbiA9IFwic3RhbGUtZGlzcGF0Y2gtbGVhc2UtdGFrZW92ZXJcIjtcbiAgY29uc3QgcmVzdWx0ID0gZGIucHJlcGFyZShcbiAgICBgVVBEQVRFIHVuaXRfZGlzcGF0Y2hlc1xuICAgICBTRVQgc3RhdHVzID0gJ2NhbmNlbGVkJyxcbiAgICAgICAgIGVuZGVkX2F0ID0gOmVuZGVkX2F0LFxuICAgICAgICAgZXhpdF9yZWFzb24gPSA6cmVhc29uXG4gICAgIFdIRVJFIGlkID0gOmlkXG4gICAgICAgQU5EIHN0YXR1cyBJTiAoJ2NsYWltZWQnLCdydW5uaW5nJylcbiAgICAgICBBTkQgKHdvcmtlcl9pZCAhPSA6d29ya2VyX2lkIE9SIG1pbGVzdG9uZV9sZWFzZV90b2tlbiAhPSA6dG9rZW4pYCxcbiAgKS5ydW4oe1xuICAgIFwiOmlkXCI6IGFjdGl2ZS5pZCxcbiAgICBcIjplbmRlZF9hdFwiOiBub3csXG4gICAgXCI6cmVhc29uXCI6IHJlYXNvbixcbiAgICBcIjp3b3JrZXJfaWRcIjogaW5wdXQud29ya2VySWQsXG4gICAgXCI6dG9rZW5cIjogaW5wdXQubWlsZXN0b25lTGVhc2VUb2tlbixcbiAgfSk7XG5cbiAgY29uc3QgY2hhbmdlcyA9XG4gICAgdHlwZW9mIChyZXN1bHQgYXMgeyBjaGFuZ2VzPzogdW5rbm93biB9KS5jaGFuZ2VzID09PSBcIm51bWJlclwiXG4gICAgICA/IChyZXN1bHQgYXMgeyBjaGFuZ2VzOiBudW1iZXIgfSkuY2hhbmdlc1xuICAgICAgOiAwO1xuICBpZiAoY2hhbmdlcyA8IDEpIHJldHVybjtcblxuICBpbnNlcnRBdWRpdEV2ZW50KHtcbiAgICBldmVudElkOiByYW5kb21VVUlEKCksXG4gICAgdHJhY2VJZDogaW5wdXQudHJhY2VJZCxcbiAgICB0dXJuSWQ6IGlucHV0LnR1cm5JZCA/PyB1bmRlZmluZWQsXG4gICAgY2F0ZWdvcnk6IFwib3JjaGVzdHJhdGlvblwiLFxuICAgIHR5cGU6IFwiZGlzcGF0Y2gtc3RhbGUtY2FuY2VsZWRcIixcbiAgICB0czogbm93LFxuICAgIHBheWxvYWQ6IHtcbiAgICAgIGRpc3BhdGNoSWQ6IGFjdGl2ZS5pZCxcbiAgICAgIHVuaXRJZDogaW5wdXQudW5pdElkLFxuICAgICAgcHJpb3JTdGF0dXM6IGFjdGl2ZS5zdGF0dXMsXG4gICAgICBwcmlvcldvcmtlcklkOiBhY3RpdmUud29ya2VyX2lkLFxuICAgICAgcHJpb3JNaWxlc3RvbmVMZWFzZVRva2VuOiBhY3RpdmUubWlsZXN0b25lX2xlYXNlX3Rva2VuLFxuICAgICAgdGFrZW92ZXJXb3JrZXJJZDogaW5wdXQud29ya2VySWQsXG4gICAgICB0YWtlb3Zlck1pbGVzdG9uZUxlYXNlVG9rZW46IGlucHV0Lm1pbGVzdG9uZUxlYXNlVG9rZW4sXG4gICAgICByZWFzb24sXG4gICAgfSxcbiAgfSk7XG59XG5cbi8qKlxuICogSW5zZXJ0IGEgbmV3IGRpc3BhdGNoIHJvdyBpbiBgY2xhaW1lZGAgc3RhdGUuIEF0b21pYyBndWFyZCBhZ2FpbnN0XG4gKiBkb3VibGUtY2xhaW0gKEIyKTogdGhlIHBhcnRpYWwgdW5pcXVlIGluZGV4XG4gKiBpZHhfdW5pdF9kaXNwYXRjaGVzX2FjdGl2ZV9wZXJfdW5pdCByZWZ1c2VzIHRoZSBJTlNFUlQgaWYgYW55IHJvdyBmb3JcbiAqIHRoZSBzYW1lIHVuaXRfaWQgYWxyZWFkeSBoYXMgc3RhdHVzIElOICgnY2xhaW1lZCcsJ3J1bm5pbmcnKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlY29yZERpc3BhdGNoQ2xhaW0oaW5wdXQ6IFJlY29yZENsYWltSW5wdXQpOiBSZWNvcmRDbGFpbVJlc3VsdCB7XG4gIGlmICghaXNEYkF2YWlsYWJsZSgpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwicmVjb3JkRGlzcGF0Y2hDbGFpbTogREIgdW5hdmFpbGFibGVcIik7XG4gIH1cbiAgY29uc3Qgbm93ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuXG4gIHJldHVybiB0cmFuc2FjdGlvbigoKTogUmVjb3JkQ2xhaW1SZXN1bHQgPT4ge1xuICAgIGNvbnN0IGRiID0gX2dldEFkYXB0ZXIoKSE7XG5cbiAgICBjb25zdCBsZWFzZSA9IGRiLnByZXBhcmUoXG4gICAgICBgU0VMRUNUIGZlbmNpbmdfdG9rZW5cbiAgICAgICBGUk9NIG1pbGVzdG9uZV9sZWFzZXNcbiAgICAgICBXSEVSRSBtaWxlc3RvbmVfaWQgPSA6bWlsZXN0b25lX2lkXG4gICAgICAgICBBTkQgd29ya2VyX2lkID0gOndvcmtlcl9pZFxuICAgICAgICAgQU5EIGZlbmNpbmdfdG9rZW4gPSA6dG9rZW5cbiAgICAgICAgIEFORCBzdGF0dXMgPSAnaGVsZCdgLFxuICAgICkuZ2V0KHtcbiAgICAgIFwiOm1pbGVzdG9uZV9pZFwiOiBpbnB1dC5taWxlc3RvbmVJZCxcbiAgICAgIFwiOndvcmtlcl9pZFwiOiBpbnB1dC53b3JrZXJJZCxcbiAgICAgIFwiOnRva2VuXCI6IGlucHV0Lm1pbGVzdG9uZUxlYXNlVG9rZW4sXG4gICAgfSkgYXMgeyBmZW5jaW5nX3Rva2VuOiBudW1iZXIgfSB8IHVuZGVmaW5lZDtcbiAgICBpZiAoIWxlYXNlKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogZmFsc2UsXG4gICAgICAgIGVycm9yOiBcInN0YWxlX2xlYXNlXCIsXG4gICAgICAgIG1pbGVzdG9uZUlkOiBpbnB1dC5taWxlc3RvbmVJZCxcbiAgICAgICAgd29ya2VySWQ6IGlucHV0LndvcmtlcklkLFxuICAgICAgICBtaWxlc3RvbmVMZWFzZVRva2VuOiBpbnB1dC5taWxlc3RvbmVMZWFzZVRva2VuLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICBzZXR0bGVTdGFsZUFjdGl2ZURpc3BhdGNoRm9yVW5pdChpbnB1dCwgbm93KTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCByZXN1bHQgPSBkYi5wcmVwYXJlKFxuICAgICAgICBgSU5TRVJUIElOVE8gdW5pdF9kaXNwYXRjaGVzIChcbiAgICAgICAgICB0cmFjZV9pZCwgdHVybl9pZCwgd29ya2VyX2lkLCBtaWxlc3RvbmVfbGVhc2VfdG9rZW4sXG4gICAgICAgICAgbWlsZXN0b25lX2lkLCBzbGljZV9pZCwgdGFza19pZCxcbiAgICAgICAgICB1bml0X3R5cGUsIHVuaXRfaWQsIHN0YXR1cywgYXR0ZW1wdF9uLFxuICAgICAgICAgIHN0YXJ0ZWRfYXQsIG1heF9hdHRlbXB0c1xuICAgICAgICApIFZBTFVFUyAoXG4gICAgICAgICAgOnRyYWNlX2lkLCA6dHVybl9pZCwgOndvcmtlcl9pZCwgOm1pbGVzdG9uZV9sZWFzZV90b2tlbixcbiAgICAgICAgICA6bWlsZXN0b25lX2lkLCA6c2xpY2VfaWQsIDp0YXNrX2lkLFxuICAgICAgICAgIDp1bml0X3R5cGUsIDp1bml0X2lkLCAnY2xhaW1lZCcsIDphdHRlbXB0X24sXG4gICAgICAgICAgOnN0YXJ0ZWRfYXQsIDptYXhfYXR0ZW1wdHNcbiAgICAgICAgKWAsXG4gICAgICApLnJ1bih7XG4gICAgICAgIFwiOnRyYWNlX2lkXCI6IGlucHV0LnRyYWNlSWQsXG4gICAgICAgIFwiOnR1cm5faWRcIjogaW5wdXQudHVybklkID8/IG51bGwsXG4gICAgICAgIFwiOndvcmtlcl9pZFwiOiBpbnB1dC53b3JrZXJJZCxcbiAgICAgICAgXCI6bWlsZXN0b25lX2xlYXNlX3Rva2VuXCI6IGlucHV0Lm1pbGVzdG9uZUxlYXNlVG9rZW4sXG4gICAgICAgIFwiOm1pbGVzdG9uZV9pZFwiOiBpbnB1dC5taWxlc3RvbmVJZCxcbiAgICAgICAgXCI6c2xpY2VfaWRcIjogaW5wdXQuc2xpY2VJZCA/PyBudWxsLFxuICAgICAgICBcIjp0YXNrX2lkXCI6IGlucHV0LnRhc2tJZCA/PyBudWxsLFxuICAgICAgICBcIjp1bml0X3R5cGVcIjogaW5wdXQudW5pdFR5cGUsXG4gICAgICAgIFwiOnVuaXRfaWRcIjogaW5wdXQudW5pdElkLFxuICAgICAgICBcIjphdHRlbXB0X25cIjogaW5wdXQuYXR0ZW1wdE4gPz8gMSxcbiAgICAgICAgXCI6c3RhcnRlZF9hdFwiOiBub3csXG4gICAgICAgIFwiOm1heF9hdHRlbXB0c1wiOiBpbnB1dC5tYXhBdHRlbXB0cyA/PyAzLFxuICAgICAgfSk7XG4gICAgICBjb25zdCBpZCA9IE51bWJlcigocmVzdWx0IGFzIHsgbGFzdEluc2VydFJvd2lkPzogbnVtYmVyIHwgYmlnaW50IH0pLmxhc3RJbnNlcnRSb3dpZCA/PyAwKTtcblxuICAgICAgaW5zZXJ0QXVkaXRFdmVudCh7XG4gICAgICAgIGV2ZW50SWQ6IHJhbmRvbVVVSUQoKSxcbiAgICAgICAgdHJhY2VJZDogaW5wdXQudHJhY2VJZCxcbiAgICAgICAgdHVybklkOiBpbnB1dC50dXJuSWQgPz8gdW5kZWZpbmVkLFxuICAgICAgICBjYXRlZ29yeTogXCJvcmNoZXN0cmF0aW9uXCIsXG4gICAgICAgIHR5cGU6IFwiZGlzcGF0Y2gtY2xhaW1lZFwiLFxuICAgICAgICB0czogbm93LFxuICAgICAgICBwYXlsb2FkOiB7XG4gICAgICAgICAgZGlzcGF0Y2hJZDogaWQsXG4gICAgICAgICAgdW5pdElkOiBpbnB1dC51bml0SWQsXG4gICAgICAgICAgdW5pdFR5cGU6IGlucHV0LnVuaXRUeXBlLFxuICAgICAgICAgIHdvcmtlcklkOiBpbnB1dC53b3JrZXJJZCxcbiAgICAgICAgICBhdHRlbXB0TjogaW5wdXQuYXR0ZW1wdE4gPz8gMSxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgZGlzcGF0Y2hJZDogaWQgfTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGlmICghaXNBbHJlYWR5QWN0aXZlQ29uc3RyYWludEVycm9yKGVycikpIHRocm93IGVycjtcblxuICAgICAgLy8gUGFydGlhbCB1bmlxdWUgaW5kZXggcmVqZWN0ZWQgdGhlIElOU0VSVCBcdTIwMTQgc3VyZmFjZSB0aGUgZXhpc3RpbmdcbiAgICAgIC8vIGFjdGl2ZSBkaXNwYXRjaCBzbyBjYWxsZXJzIGNhbiBkZWNpZGUgd2hhdCB0byBkby5cbiAgICAgIGNvbnN0IGV4aXN0aW5nID0gZGIucHJlcGFyZShcbiAgICAgICAgYFNFTEVDVCBpZCwgc3RhdHVzLCB3b3JrZXJfaWQgRlJPTSB1bml0X2Rpc3BhdGNoZXNcbiAgICAgICAgIFdIRVJFIHVuaXRfaWQgPSA6dW5pdF9pZCBBTkQgc3RhdHVzIElOICgnY2xhaW1lZCcsJ3J1bm5pbmcnKVxuICAgICAgICAgT1JERVIgQlkgaWQgREVTQyBMSU1JVCAxYCxcbiAgICAgICkuZ2V0KHsgXCI6dW5pdF9pZFwiOiBpbnB1dC51bml0SWQgfSkgYXMgeyBpZDogbnVtYmVyOyBzdGF0dXM6IERpc3BhdGNoU3RhdHVzOyB3b3JrZXJfaWQ6IHN0cmluZyB9IHwgdW5kZWZpbmVkO1xuXG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogZmFsc2UsXG4gICAgICAgIGVycm9yOiBcImFscmVhZHlfYWN0aXZlXCIsXG4gICAgICAgIGV4aXN0aW5nSWQ6IGV4aXN0aW5nPy5pZCA/PyAwLFxuICAgICAgICBleGlzdGluZ1N0YXR1czogZXhpc3Rpbmc/LnN0YXR1cyA/PyBcImNsYWltZWRcIixcbiAgICAgICAgZXhpc3RpbmdXb3JrZXI6IGV4aXN0aW5nPy53b3JrZXJfaWQgPz8gXCJ1bmtub3duXCIsXG4gICAgICB9O1xuICAgIH1cbiAgfSk7XG59XG5cbi8qKiBUcmFuc2l0aW9uIGEgYGNsYWltZWRgIGRpc3BhdGNoIGludG8gYHJ1bm5pbmdgLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1hcmtSdW5uaW5nKGRpc3BhdGNoSWQ6IG51bWJlcik6IHZvaWQge1xuICBpZiAoIWlzRGJBdmFpbGFibGUoKSkgcmV0dXJuO1xuICBjb25zdCBkYiA9IF9nZXRBZGFwdGVyKCkhO1xuICBkYi5wcmVwYXJlKFxuICAgIGBVUERBVEUgdW5pdF9kaXNwYXRjaGVzIFNFVCBzdGF0dXMgPSAncnVubmluZydcbiAgICAgV0hFUkUgaWQgPSA6aWQgQU5EIHN0YXR1cyA9ICdjbGFpbWVkJ2AsXG4gICkucnVuKHsgXCI6aWRcIjogZGlzcGF0Y2hJZCB9KTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDb21wbGV0ZU9wdHMge1xuICB2ZXJpZmljYXRpb25FdmlkZW5jZUlkPzogbnVtYmVyIHwgbnVsbDtcbiAgZXhpdFJlYXNvbj86IHN0cmluZztcbn1cblxuLyoqIFRyYW5zaXRpb24gYSBkaXNwYXRjaCBpbnRvIGBjb21wbGV0ZWRgLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1hcmtDb21wbGV0ZWQoZGlzcGF0Y2hJZDogbnVtYmVyLCBvcHRzPzogQ29tcGxldGVPcHRzKTogdm9pZCB7XG4gIGlmICghaXNEYkF2YWlsYWJsZSgpKSByZXR1cm47XG4gIGNvbnN0IG5vdyA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcbiAgY29uc3QgZGIgPSBfZ2V0QWRhcHRlcigpITtcbiAgbGV0IGNoYW5nZXMgPSAwO1xuICB0cmFuc2FjdGlvbigoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gZGIucHJlcGFyZShcbiAgICAgIGBVUERBVEUgdW5pdF9kaXNwYXRjaGVzXG4gICAgICAgU0VUIHN0YXR1cyA9ICdjb21wbGV0ZWQnLCBlbmRlZF9hdCA9IDplbmRlZF9hdCxcbiAgICAgICAgICAgZXhpdF9yZWFzb24gPSA6ZXhpdF9yZWFzb24sXG4gICAgICAgICAgIHZlcmlmaWNhdGlvbl9ldmlkZW5jZV9pZCA9IDpldmlkZW5jZV9pZFxuICAgICAgIFdIRVJFIGlkID0gOmlkXG4gICAgICAgICBBTkQgc3RhdHVzIElOICgnY2xhaW1lZCcsJ3J1bm5pbmcnKWAsXG4gICAgKS5ydW4oe1xuICAgICAgXCI6aWRcIjogZGlzcGF0Y2hJZCxcbiAgICAgIFwiOmVuZGVkX2F0XCI6IG5vdyxcbiAgICAgIFwiOmV4aXRfcmVhc29uXCI6IG9wdHM/LmV4aXRSZWFzb24gPz8gbnVsbCxcbiAgICAgIFwiOmV2aWRlbmNlX2lkXCI6IG9wdHM/LnZlcmlmaWNhdGlvbkV2aWRlbmNlSWQgPz8gbnVsbCxcbiAgICB9KTtcbiAgICBjaGFuZ2VzID1cbiAgICAgIHR5cGVvZiAocmVzdWx0IGFzIHsgY2hhbmdlcz86IHVua25vd24gfSkuY2hhbmdlcyA9PT0gXCJudW1iZXJcIlxuICAgICAgICA/IChyZXN1bHQgYXMgeyBjaGFuZ2VzOiBudW1iZXIgfSkuY2hhbmdlc1xuICAgICAgICA6IDA7XG4gIH0pO1xuICBpZiAoY2hhbmdlcyA8IDEpIHJldHVybjtcbiAgaW5zZXJ0QXVkaXRFdmVudCh7XG4gICAgZXZlbnRJZDogcmFuZG9tVVVJRCgpLFxuICAgIHRyYWNlSWQ6IGRpc3BhdGNoSWQudG9TdHJpbmcoKSxcbiAgICBjYXRlZ29yeTogXCJvcmNoZXN0cmF0aW9uXCIsXG4gICAgdHlwZTogXCJkaXNwYXRjaC1jb21wbGV0ZWRcIixcbiAgICB0czogbm93LFxuICAgIHBheWxvYWQ6IHsgZGlzcGF0Y2hJZCB9LFxuICB9KTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBGYWlsdXJlT3B0cyB7XG4gIGVycm9yU3VtbWFyeTogc3RyaW5nO1xuICBlcnJvckNvZGU/OiBzdHJpbmc7XG4gIC8qKiBCYWNrb2ZmIGJlZm9yZSBuZXh0IGF0dGVtcHQgKHVzZWQgYnkgc3R1Y2stZGV0ZWN0b3IgcmV0cnkgc3VwcHJlc3Npb24pLiAqL1xuICByZXRyeUFmdGVyTXM/OiBudW1iZXI7XG59XG5cbi8qKiBUcmFuc2l0aW9uIGEgZGlzcGF0Y2ggaW50byBgZmFpbGVkYCwgb3B0aW9uYWxseSBzY2hlZHVsaW5nIGEgcmV0cnkuICovXG5leHBvcnQgZnVuY3Rpb24gbWFya0ZhaWxlZChkaXNwYXRjaElkOiBudW1iZXIsIG9wdHM6IEZhaWx1cmVPcHRzKTogdm9pZCB7XG4gIGlmICghaXNEYkF2YWlsYWJsZSgpKSByZXR1cm47XG4gIGNvbnN0IG5vdyA9IG5ldyBEYXRlKCk7XG4gIGNvbnN0IG5vd0lzbyA9IG5vdy50b0lTT1N0cmluZygpO1xuICBjb25zdCBuZXh0UnVuSXNvID0gb3B0cy5yZXRyeUFmdGVyTXNcbiAgICA/IG5ldyBEYXRlKG5vdy5nZXRUaW1lKCkgKyBvcHRzLnJldHJ5QWZ0ZXJNcykudG9JU09TdHJpbmcoKVxuICAgIDogbnVsbDtcbiAgY29uc3QgZGIgPSBfZ2V0QWRhcHRlcigpITtcbiAgbGV0IGNoYW5nZXMgPSAwO1xuICB0cmFuc2FjdGlvbigoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gZGIucHJlcGFyZShcbiAgICAgIGBVUERBVEUgdW5pdF9kaXNwYXRjaGVzXG4gICAgICAgU0VUIHN0YXR1cyA9ICdmYWlsZWQnLCBlbmRlZF9hdCA9IDplbmRlZF9hdCxcbiAgICAgICAgICAgZXJyb3Jfc3VtbWFyeSA9IDplcnJvcl9zdW1tYXJ5LFxuICAgICAgICAgICBsYXN0X2Vycm9yX2NvZGUgPSA6bGFzdF9lcnJvcl9jb2RlLFxuICAgICAgICAgICBsYXN0X2Vycm9yX2F0ID0gOmxhc3RfZXJyb3JfYXQsXG4gICAgICAgICAgIHJldHJ5X2FmdGVyX21zID0gOnJldHJ5X2FmdGVyX21zLFxuICAgICAgICAgICBuZXh0X3J1bl9hdCA9IDpuZXh0X3J1bl9hdFxuICAgICAgIFdIRVJFIGlkID0gOmlkXG4gICAgICAgICBBTkQgc3RhdHVzIElOICgnY2xhaW1lZCcsJ3J1bm5pbmcnKWAsXG4gICAgKS5ydW4oe1xuICAgICAgXCI6aWRcIjogZGlzcGF0Y2hJZCxcbiAgICAgIFwiOmVuZGVkX2F0XCI6IG5vd0lzbyxcbiAgICAgIFwiOmVycm9yX3N1bW1hcnlcIjogb3B0cy5lcnJvclN1bW1hcnksXG4gICAgICBcIjpsYXN0X2Vycm9yX2NvZGVcIjogb3B0cy5lcnJvckNvZGUgPz8gbnVsbCxcbiAgICAgIFwiOmxhc3RfZXJyb3JfYXRcIjogbm93SXNvLFxuICAgICAgXCI6cmV0cnlfYWZ0ZXJfbXNcIjogb3B0cy5yZXRyeUFmdGVyTXMgPz8gbnVsbCxcbiAgICAgIFwiOm5leHRfcnVuX2F0XCI6IG5leHRSdW5Jc28sXG4gICAgfSk7XG4gICAgY2hhbmdlcyA9XG4gICAgICB0eXBlb2YgKHJlc3VsdCBhcyB7IGNoYW5nZXM/OiB1bmtub3duIH0pLmNoYW5nZXMgPT09IFwibnVtYmVyXCJcbiAgICAgICAgPyAocmVzdWx0IGFzIHsgY2hhbmdlczogbnVtYmVyIH0pLmNoYW5nZXNcbiAgICAgICAgOiAwO1xuICB9KTtcbiAgaWYgKGNoYW5nZXMgPCAxKSByZXR1cm47XG4gIGluc2VydEF1ZGl0RXZlbnQoe1xuICAgIGV2ZW50SWQ6IHJhbmRvbVVVSUQoKSxcbiAgICB0cmFjZUlkOiBkaXNwYXRjaElkLnRvU3RyaW5nKCksXG4gICAgY2F0ZWdvcnk6IFwib3JjaGVzdHJhdGlvblwiLFxuICAgIHR5cGU6IFwiZGlzcGF0Y2gtZmFpbGVkXCIsXG4gICAgdHM6IG5vd0lzbyxcbiAgICBwYXlsb2FkOiB7IGRpc3BhdGNoSWQsIGVycm9yU3VtbWFyeTogb3B0cy5lcnJvclN1bW1hcnksIHJldHJ5QWZ0ZXJNczogb3B0cy5yZXRyeUFmdGVyTXMgPz8gbnVsbCB9LFxuICB9KTtcbn1cblxuLyoqIFRyYW5zaXRpb24gYSBkaXNwYXRjaCBpbnRvIGBzdHVja2AuICovXG5leHBvcnQgZnVuY3Rpb24gbWFya1N0dWNrKGRpc3BhdGNoSWQ6IG51bWJlciwgcmVhc29uOiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKCFpc0RiQXZhaWxhYmxlKCkpIHJldHVybjtcbiAgY29uc3Qgbm93ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuICBjb25zdCBkYiA9IF9nZXRBZGFwdGVyKCkhO1xuICBjb25zdCByZXN1bHQgPSB0cmFuc2FjdGlvbigoKSA9PiB7XG4gICAgcmV0dXJuIGRiLnByZXBhcmUoXG4gICAgICBgVVBEQVRFIHVuaXRfZGlzcGF0Y2hlc1xuICAgICAgIFNFVCBzdGF0dXMgPSAnc3R1Y2snLCBlbmRlZF9hdCA9IDplbmRlZF9hdCwgZXhpdF9yZWFzb24gPSA6cmVhc29uXG4gICAgICAgV0hFUkUgaWQgPSA6aWRcbiAgICAgICAgIEFORCBzdGF0dXMgSU4gKCdjbGFpbWVkJywncnVubmluZycpYCxcbiAgICApLnJ1bih7IFwiOmlkXCI6IGRpc3BhdGNoSWQsIFwiOmVuZGVkX2F0XCI6IG5vdywgXCI6cmVhc29uXCI6IHJlYXNvbiB9KTtcbiAgfSk7XG4gIGNvbnN0IGNoYW5nZXMgPVxuICAgIHR5cGVvZiAocmVzdWx0IGFzIHsgY2hhbmdlcz86IHVua25vd24gfSkuY2hhbmdlcyA9PT0gXCJudW1iZXJcIlxuICAgICAgPyAocmVzdWx0IGFzIHsgY2hhbmdlczogbnVtYmVyIH0pLmNoYW5nZXNcbiAgICAgIDogMDtcbiAgaWYgKGNoYW5nZXMgPD0gMCkgcmV0dXJuO1xuICBpbnNlcnRBdWRpdEV2ZW50KHtcbiAgICBldmVudElkOiByYW5kb21VVUlEKCksXG4gICAgdHJhY2VJZDogZGlzcGF0Y2hJZC50b1N0cmluZygpLFxuICAgIGNhdGVnb3J5OiBcIm9yY2hlc3RyYXRpb25cIixcbiAgICB0eXBlOiBcImRpc3BhdGNoLXN0dWNrXCIsXG4gICAgdHM6IG5vdyxcbiAgICBwYXlsb2FkOiB7IGRpc3BhdGNoSWQsIHJlYXNvbiB9LFxuICB9KTtcbn1cblxuLyoqIFRyYW5zaXRpb24gYSBkaXNwYXRjaCBpbnRvIGBwYXVzZWRgLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1hcmtQYXVzZWQoZGlzcGF0Y2hJZDogbnVtYmVyKTogdm9pZCB7XG4gIGlmICghaXNEYkF2YWlsYWJsZSgpKSByZXR1cm47XG4gIGNvbnN0IG5vdyA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcbiAgY29uc3QgZGIgPSBfZ2V0QWRhcHRlcigpITtcbiAgZGIucHJlcGFyZShcbiAgICBgVVBEQVRFIHVuaXRfZGlzcGF0Y2hlc1xuICAgICBTRVQgc3RhdHVzID0gJ3BhdXNlZCcsIGVuZGVkX2F0ID0gOmVuZGVkX2F0XG4gICAgIFdIRVJFIGlkID0gOmlkIEFORCBzdGF0dXMgSU4gKCdjbGFpbWVkJywncnVubmluZycpYCxcbiAgKS5ydW4oeyBcIjppZFwiOiBkaXNwYXRjaElkLCBcIjplbmRlZF9hdFwiOiBub3cgfSk7XG59XG5cbi8qKiBUcmFuc2l0aW9uIGEgZGlzcGF0Y2ggaW50byBgY2FuY2VsZWRgLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1hcmtDYW5jZWxlZChkaXNwYXRjaElkOiBudW1iZXIsIHJlYXNvbjogc3RyaW5nKTogdm9pZCB7XG4gIGlmICghaXNEYkF2YWlsYWJsZSgpKSByZXR1cm47XG4gIGNvbnN0IG5vdyA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcbiAgY29uc3QgZGIgPSBfZ2V0QWRhcHRlcigpITtcbiAgZGIucHJlcGFyZShcbiAgICBgVVBEQVRFIHVuaXRfZGlzcGF0Y2hlc1xuICAgICBTRVQgc3RhdHVzID0gJ2NhbmNlbGVkJywgZW5kZWRfYXQgPSA6ZW5kZWRfYXQsIGV4aXRfcmVhc29uID0gOnJlYXNvblxuICAgICBXSEVSRSBpZCA9IDppZCBBTkQgc3RhdHVzIElOICgncGVuZGluZycsJ2NsYWltZWQnLCdydW5uaW5nJylgLFxuICApLnJ1bih7IFwiOmlkXCI6IGRpc3BhdGNoSWQsIFwiOmVuZGVkX2F0XCI6IG5vdywgXCI6cmVhc29uXCI6IHJlYXNvbiB9KTtcbn1cblxuLyoqXG4gKiBCZXN0LWVmZm9ydCBzaWduYWwvY3Jhc2ggY2xlYW51cDogY2FuY2VsIHRoZSBsYXRlc3QgYWN0aXZlIGRpc3BhdGNoIG93bmVkIGJ5XG4gKiBhIHdvcmtlciB3aGVuIHRoZSBwcm9jZXNzIGlzIGV4aXRpbmcgYmVmb3JlIHRoZSBub3JtYWwgbG9vcCBjYW4gc2V0dGxlIGl0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gbWFya0xhdGVzdEFjdGl2ZUZvcldvcmtlckNhbmNlbGVkKHdvcmtlcklkOiBzdHJpbmcsIHJlYXNvbjogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGlmICghaXNEYkF2YWlsYWJsZSgpKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IG5vdyA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcbiAgY29uc3QgZGIgPSBfZ2V0QWRhcHRlcigpITtcbiAgY29uc3QgcmVzdWx0ID0gdHJhbnNhY3Rpb24oKCkgPT4ge1xuICAgIHJldHVybiBkYi5wcmVwYXJlKFxuICAgICAgYFVQREFURSB1bml0X2Rpc3BhdGNoZXNcbiAgICAgICBTRVQgc3RhdHVzID0gJ2NhbmNlbGVkJywgZW5kZWRfYXQgPSA6ZW5kZWRfYXQsIGV4aXRfcmVhc29uID0gOnJlYXNvblxuICAgICAgIFdIRVJFIGlkID0gKFxuICAgICAgICAgU0VMRUNUIGlkIEZST00gdW5pdF9kaXNwYXRjaGVzXG4gICAgICAgICBXSEVSRSB3b3JrZXJfaWQgPSA6d29ya2VyX2lkXG4gICAgICAgICAgIEFORCBzdGF0dXMgSU4gKCdwZW5kaW5nJywnY2xhaW1lZCcsJ3J1bm5pbmcnKVxuICAgICAgICAgT1JERVIgQlkgaWQgREVTQ1xuICAgICAgICAgTElNSVQgMVxuICAgICAgIClgLFxuICAgICkucnVuKHtcbiAgICAgIFwiOmVuZGVkX2F0XCI6IG5vdyxcbiAgICAgIFwiOnJlYXNvblwiOiByZWFzb24sXG4gICAgICBcIjp3b3JrZXJfaWRcIjogd29ya2VySWQsXG4gICAgfSk7XG4gIH0pO1xuICBjb25zdCBjaGFuZ2VzID1cbiAgICB0eXBlb2YgKHJlc3VsdCBhcyB7IGNoYW5nZXM/OiB1bmtub3duIH0pLmNoYW5nZXMgPT09IFwibnVtYmVyXCJcbiAgICAgID8gKHJlc3VsdCBhcyB7IGNoYW5nZXM6IG51bWJlciB9KS5jaGFuZ2VzXG4gICAgICA6IDA7XG4gIGlmIChjaGFuZ2VzIDw9IDApIHJldHVybiBmYWxzZTtcbiAgaW5zZXJ0QXVkaXRFdmVudCh7XG4gICAgZXZlbnRJZDogcmFuZG9tVVVJRCgpLFxuICAgIHRyYWNlSWQ6IHdvcmtlcklkLFxuICAgIGNhdGVnb3J5OiBcIm9yY2hlc3RyYXRpb25cIixcbiAgICB0eXBlOiBcImRpc3BhdGNoLWNhbmNlbGVkXCIsXG4gICAgdHM6IG5vdyxcbiAgICBwYXlsb2FkOiB7IHdvcmtlcklkLCByZWFzb24gfSxcbiAgfSk7XG4gIHJldHVybiB0cnVlO1xufVxuXG4vKipcbiAqIEZldGNoIHRoZSBtb3N0IHJlY2VudCBOIGRpc3BhdGNoZXMgZm9yIGEgdW5pdC4gVXNlZCBieSByZWNvcmREaXNwYXRjaENsYWltXG4gKiBjYWxsZXJzIHRvIGNvbXB1dGUgYXR0ZW1wdF9uIGFuZCBieSBkZXRlY3Qtc3R1Y2sudHMgKEIzKSB0byBjb25zdWx0XG4gKiByZXRyeSBidWRnZXQgYmVmb3JlIHRyaXBwaW5nIHRoZSBzdHVjayB2ZXJkaWN0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0UmVjZW50Rm9yVW5pdCh1bml0SWQ6IHN0cmluZywgbGltaXQgPSAxMCk6IFVuaXREaXNwYXRjaFJvd1tdIHtcbiAgaWYgKCFpc0RiQXZhaWxhYmxlKCkpIHJldHVybiBbXTtcbiAgY29uc3QgZGIgPSBfZ2V0QWRhcHRlcigpITtcbiAgcmV0dXJuIGRiLnByZXBhcmUoXG4gICAgYFNFTEVDVCAqIEZST00gdW5pdF9kaXNwYXRjaGVzIFdIRVJFIHVuaXRfaWQgPSA6dW5pdF9pZCBPUkRFUiBCWSBpZCBERVNDIExJTUlUIDpsaW1pdGAsXG4gICkuYWxsKHsgXCI6dW5pdF9pZFwiOiB1bml0SWQsIFwiOmxpbWl0XCI6IGxpbWl0IH0pIGFzIHVua25vd24gYXMgVW5pdERpc3BhdGNoUm93W107XG59XG5cbi8qKlxuICogRmV0Y2ggdGhlIGxhdGVzdCBkaXNwYXRjaCBmb3IgYSB1bml0LCByZWdhcmRsZXNzIG9mIHN0YXR1cy4gUmV0dXJucyBudWxsXG4gKiBpZiB0aGUgdW5pdCBoYXMgbmV2ZXIgYmVlbiBkaXNwYXRjaGVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0TGF0ZXN0Rm9yVW5pdCh1bml0SWQ6IHN0cmluZyk6IFVuaXREaXNwYXRjaFJvdyB8IG51bGwge1xuICBpZiAoIWlzRGJBdmFpbGFibGUoKSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGRiID0gX2dldEFkYXB0ZXIoKSE7XG4gIGNvbnN0IHJvdyA9IGRiLnByZXBhcmUoXG4gICAgYFNFTEVDVCAqIEZST00gdW5pdF9kaXNwYXRjaGVzIFdIRVJFIHVuaXRfaWQgPSA6dW5pdF9pZCBPUkRFUiBCWSBpZCBERVNDIExJTUlUIDFgLFxuICApLmdldCh7IFwiOnVuaXRfaWRcIjogdW5pdElkIH0pIGFzIFVuaXREaXNwYXRjaFJvdyB8IHVuZGVmaW5lZDtcbiAgcmV0dXJuIHJvdyA/PyBudWxsO1xufVxuXG4vKipcbiAqIFBoYXNlIEMgXHUyMDE0IHJldHVybiB0aGUgbW9zdCByZWNlbnQgdW5pdF9pZCB2YWx1ZXMgZm9yIGEgd29ya2VyLCBvbGRlc3QtZmlyc3QuXG4gKlxuICogRHJvcC1pbiByZXBsYWNlbWVudCBmb3IgdGhlIHBlcnNpc3RlbmNlIHNpZGUgb2Ygc3R1Y2stc3RhdGUuanNvbidzXG4gKiBgcmVjZW50VW5pdHNgIGZpZWxkLiBUaGUgYXV0by1sb29wIHVzZXMgdGhpcyB0byBzZWVkIGxvb3BTdGF0ZS5yZWNlbnRVbml0c1xuICogb24gc2Vzc2lvbiBzdGFydCBzbyB0aGUgc3R1Y2stZGV0ZWN0b3Igd2luZG93IHN1cnZpdmVzIGEgc2Vzc2lvbiByZXN0YXJ0XG4gKiAoIzM3MDQpLiBSZXR1cm5lZCBpbiBvbGRlc3QtZmlyc3Qgb3JkZXIgdG8gbWF0Y2ggdGhlIGluLW1lbW9yeSB3aW5kb3dcbiAqIHNoYXBlIHRoYXQgZGV0ZWN0LXN0dWNrLnRzIGV4cGVjdHMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRSZWNlbnRVbml0S2V5c0ZvcldvcmtlcihcbiAgd29ya2VySWQ6IHN0cmluZyxcbiAgbGltaXQgPSAyMCxcbik6IEFycmF5PHsga2V5OiBzdHJpbmcgfT4ge1xuICBpZiAoIWlzRGJBdmFpbGFibGUoKSkgcmV0dXJuIFtdO1xuICBjb25zdCBkYiA9IF9nZXRBZGFwdGVyKCkhO1xuICBjb25zdCByb3dzID0gZGIucHJlcGFyZShcbiAgICBgU0VMRUNUIHVuaXRfaWQgRlJPTSB1bml0X2Rpc3BhdGNoZXNcbiAgICAgV0hFUkUgd29ya2VyX2lkID0gOndvcmtlcl9pZFxuICAgICBPUkRFUiBCWSBzdGFydGVkX2F0IERFU0MsIGlkIERFU0NcbiAgICAgTElNSVQgOmxpbWl0YCxcbiAgKS5hbGwoeyBcIjp3b3JrZXJfaWRcIjogd29ya2VySWQsIFwiOmxpbWl0XCI6IGxpbWl0IH0pIGFzIEFycmF5PHsgdW5pdF9pZDogc3RyaW5nIH0+O1xuICAvLyBSZXZlcnNlIHNvIGNhbGxlcnMgY29uc3VtZSBvbGRlc3QtZmlyc3QgKHNsaWRpbmctd2luZG93IHNlbWFudGljcykuXG4gIHJldHVybiByb3dzLnJldmVyc2UoKS5tYXAoKHIpID0+ICh7IGtleTogci51bml0X2lkIH0pKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldFJlY2VudFVuaXRLZXlzRm9yUHJvamVjdFJvb3QoXG4gIHByb2plY3RSb290UmVhbHBhdGg6IHN0cmluZyxcbiAgbGltaXQgPSAyMCxcbik6IEFycmF5PHsga2V5OiBzdHJpbmcgfT4ge1xuICBpZiAoIWlzRGJBdmFpbGFibGUoKSkgcmV0dXJuIFtdO1xuICBjb25zdCBkYiA9IF9nZXRBZGFwdGVyKCkhO1xuICBjb25zdCByb3dzID0gZGIucHJlcGFyZShcbiAgICBgU0VMRUNUIHVkLnVuaXRfdHlwZSwgdWQudW5pdF9pZFxuICAgICBGUk9NIHVuaXRfZGlzcGF0Y2hlcyB1ZFxuICAgICBJTk5FUiBKT0lOIHdvcmtlcnMgdyBPTiB3Lndvcmtlcl9pZCA9IHVkLndvcmtlcl9pZFxuICAgICBXSEVSRSB3LnByb2plY3Rfcm9vdF9yZWFscGF0aCA9IDpwcm9qZWN0X3Jvb3RfcmVhbHBhdGhcbiAgICAgICBBTkQgdy5zdGF0dXMgIT0gJ2NyYXNoZWQnXG4gICAgIE9SREVSIEJZIHVkLnN0YXJ0ZWRfYXQgREVTQywgdWQuaWQgREVTQ1xuICAgICBMSU1JVCA6bGltaXRgLFxuICApLmFsbCh7XG4gICAgXCI6cHJvamVjdF9yb290X3JlYWxwYXRoXCI6IHByb2plY3RSb290UmVhbHBhdGgsXG4gICAgXCI6bGltaXRcIjogbGltaXQsXG4gIH0pIGFzIEFycmF5PHsgdW5pdF90eXBlOiBzdHJpbmc7IHVuaXRfaWQ6IHN0cmluZyB9PjtcbiAgcmV0dXJuIHJvd3MucmV2ZXJzZSgpLm1hcCgocikgPT4gKHsga2V5OiBgJHtyLnVuaXRfdHlwZX0vJHtyLnVuaXRfaWR9YCB9KSk7XG59XG5cbi8qKlxuICogRmV0Y2ggZGlzcGF0Y2hlcyBmb3IgYSBtaWxlc3RvbmUgZmlsdGVyZWQgYnkgc3RhdHVzLiBVc2VmdWwgZm9yIGphbml0b3JzXG4gKiArIGRhc2hib2FyZHMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXREaXNwYXRjaGVzQnlTdGF0dXMoXG4gIG1pbGVzdG9uZUlkOiBzdHJpbmcsXG4gIHN0YXR1czogRGlzcGF0Y2hTdGF0dXMsXG4pOiBVbml0RGlzcGF0Y2hSb3dbXSB7XG4gIGlmICghaXNEYkF2YWlsYWJsZSgpKSByZXR1cm4gW107XG4gIGNvbnN0IGRiID0gX2dldEFkYXB0ZXIoKSE7XG4gIHJldHVybiBkYi5wcmVwYXJlKFxuICAgIGBTRUxFQ1QgKiBGUk9NIHVuaXRfZGlzcGF0Y2hlcyBXSEVSRSBtaWxlc3RvbmVfaWQgPSA6bWlkIEFORCBzdGF0dXMgPSA6c3RhdHVzIE9SREVSIEJZIGlkYCxcbiAgKS5hbGwoeyBcIjptaWRcIjogbWlsZXN0b25lSWQsIFwiOnN0YXR1c1wiOiBzdGF0dXMgfSkgYXMgdW5rbm93biBhcyBVbml0RGlzcGF0Y2hSb3dbXTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQWNBLFNBQVMsa0JBQWtCO0FBRTNCO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUE4RFAsU0FBUywrQkFBK0IsS0FBdUI7QUFDN0QsUUFBTSxPQUNKLE9BQU8sT0FBTyxR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
