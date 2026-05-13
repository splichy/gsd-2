import {
  isDbAvailable,
  _getAdapter,
  transaction,
  isInTransaction,
  insertMemoryRow,
  rewriteMemoryId,
  updateMemoryContentRow,
  incrementMemoryHitCount,
  supersedeMemoryRow,
  markMemoryUnitProcessed,
  decayMemoriesBefore,
  supersedeLowestRankedMemories,
  deleteMemoryEmbedding,
  deleteMemoryRelationsFor
} from "./gsd-db.js";
import { createMemoryRelation, isValidRelation } from "./memory-relations.js";
import { logWarning } from "./workflow-logger.js";
const CATEGORY_PRIORITY = {
  gotcha: 0,
  convention: 1,
  architecture: 2,
  pattern: 3,
  environment: 4,
  preference: 5
};
function memoryDecayFactor(lastHitAt) {
  if (!lastHitAt) return 1;
  const ts = Date.parse(lastHitAt);
  if (!Number.isFinite(ts)) return 1;
  const daysAgo = Math.max(0, (Date.now() - ts) / 864e5);
  return Math.max(0.7, 1 - 0.3 * Math.min(1, daysAgo / 90));
}
function rowToMemory(row) {
  return {
    seq: row["seq"],
    id: row["id"],
    category: row["category"],
    content: row["content"],
    confidence: row["confidence"],
    source_unit_type: row["source_unit_type"] ?? null,
    source_unit_id: row["source_unit_id"] ?? null,
    created_at: row["created_at"],
    updated_at: row["updated_at"],
    superseded_by: row["superseded_by"] ?? null,
    hit_count: row["hit_count"],
    scope: row["scope"] ?? "project",
    tags: parseTags(row["tags"]),
    structured_fields: parseStructuredFields(row["structured_fields"]),
    last_hit_at: row["last_hit_at"] ?? null
  };
}
function parseStructuredFields(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function parseTags(raw) {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
}
function getActiveMemories() {
  if (!isDbAvailable()) return [];
  const adapter = _getAdapter();
  if (!adapter) return [];
  try {
    const rows = adapter.prepare("SELECT * FROM memories WHERE superseded_by IS NULL").all();
    return rows.map(rowToMemory);
  } catch {
    return [];
  }
}
function getActiveMemoriesRanked(limit = 30) {
  if (!isDbAvailable()) return [];
  const adapter = _getAdapter();
  if (!adapter) return [];
  try {
    const rows = adapter.prepare(
      `SELECT * FROM memories
       WHERE superseded_by IS NULL
       ORDER BY (confidence * (1.0 + hit_count * 0.1)) DESC
       LIMIT :limit`
    ).all({ ":limit": limit });
    return rows.map(rowToMemory);
  } catch {
    return [];
  }
}
function queryMemoriesRanked(opts) {
  if (!isDbAvailable()) return [];
  const adapter = _getAdapter();
  if (!adapter) return [];
  const k = clampLimit(opts.k, 10);
  const rrfK = opts.rrfK ?? 60;
  const activeClause = opts.include_superseded === true ? "" : "WHERE superseded_by IS NULL";
  const trimmedQuery = (opts.query ?? "").trim();
  const keywordHits = trimmedQuery ? keywordSearch(adapter, trimmedQuery, activeClause, 50) : [];
  const semanticHits = opts.queryVector ? semanticSearch(adapter, opts.queryVector, activeClause, 50) : [];
  if (keywordHits.length === 0 && semanticHits.length === 0 && !trimmedQuery) {
    const candidatePool = Math.min(Math.max(k * 5, 50), 500);
    const rows = adapter.prepare(
      `SELECT * FROM memories ${activeClause}
         ORDER BY (confidence * (1.0 + hit_count * 0.1)) DESC
         LIMIT :limit`
    ).all({ ":limit": candidatePool });
    const ranked2 = [];
    for (const row of rows) {
      const memory = rowToMemory(row);
      if (!passesFilters(memory, opts)) continue;
      const decay = memoryDecayFactor(memory.last_hit_at);
      const score = memory.confidence * (1 + memory.hit_count * 0.1) * decay;
      ranked2.push({
        memory,
        score,
        keywordRank: null,
        semanticRank: null,
        confidenceBoost: score,
        reason: "ranked"
      });
    }
    ranked2.sort((a, b) => b.score - a.score);
    return ranked2.slice(0, k);
  }
  const fused = /* @__PURE__ */ new Map();
  for (let i = 0; i < keywordHits.length; i++) {
    const hit = keywordHits[i];
    const existing = fused.get(hit.id);
    const rrf = 1 / (rrfK + i + 1);
    if (existing) {
      existing.kwRank = i + 1;
      existing.score += rrf;
    } else {
      fused.set(hit.id, { memory: hit, kwRank: i + 1, semRank: null, score: rrf });
    }
  }
  for (let i = 0; i < semanticHits.length; i++) {
    const hit = semanticHits[i];
    const existing = fused.get(hit.id);
    const rrf = 1 / (rrfK + i + 1);
    if (existing) {
      existing.semRank = i + 1;
      existing.score += rrf;
    } else {
      fused.set(hit.id, { memory: hit, kwRank: null, semRank: i + 1, score: rrf });
    }
  }
  const ranked = [];
  for (const entry of fused.values()) {
    if (!passesFilters(entry.memory, opts)) continue;
    const boost = entry.memory.confidence * (1 + entry.memory.hit_count * 0.1) * memoryDecayFactor(entry.memory.last_hit_at);
    const reason = entry.kwRank != null && entry.semRank != null ? "both" : entry.kwRank != null ? "keyword" : "semantic";
    ranked.push({
      memory: entry.memory,
      score: entry.score * boost,
      keywordRank: entry.kwRank,
      semanticRank: entry.semRank,
      confidenceBoost: boost,
      reason
    });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, k);
}
function clampLimit(value, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < 1) return 1;
  if (value > 100) return 100;
  return Math.floor(value);
}
function passesFilters(memory, filters) {
  if (filters.category && memory.category.toLowerCase() !== filters.category.toLowerCase()) return false;
  if (filters.scope && memory.scope !== filters.scope) return false;
  if (filters.tag) {
    const needle = filters.tag.toLowerCase();
    if (!memory.tags.map((t) => t.toLowerCase()).includes(needle)) return false;
  }
  return true;
}
let ftsWarningEmitted = false;
function keywordSearch(adapter, rawQuery, activeClause, limit) {
  const ftsAvailable = isFtsAvailable(adapter);
  if (ftsAvailable) {
    try {
      const matchExpr = toFtsMatchExpr(rawQuery);
      if (!matchExpr) return [];
      const activePart = activeClause ? `AND m.${activeClause.replace(/^WHERE\s+/i, "")}` : "";
      const rows2 = adapter.prepare(
        `SELECT m.*
         FROM memories_fts f
         JOIN memories m ON m.seq = f.rowid
         WHERE memories_fts MATCH :match
         ${activePart}
         ORDER BY bm25(memories_fts)
         LIMIT :limit`
      ).all({ ":match": matchExpr, ":limit": limit });
      return rows2.map(rowToMemory);
    } catch {
    }
  }
  if (!ftsWarningEmitted) {
    ftsWarningEmitted = true;
    logWarning("memory-store", "FTS5 unavailable \u2014 using LIKE fallback scan (consider enabling FTS5)");
  }
  const terms = rawQuery.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length >= 2);
  if (terms.length === 0) return [];
  const preScanCap = Math.min(limit * 20, 2e3);
  const rows = adapter.prepare(
    `SELECT * FROM memories ${activeClause}
       ORDER BY (confidence * (1.0 + hit_count * 0.1)) DESC
       LIMIT :preScanCap`
  ).all({ ":preScanCap": preScanCap });
  const scored = [];
  for (const row of rows) {
    const memory = rowToMemory(row);
    const lower = memory.content.toLowerCase();
    let score = 0;
    for (const term of terms) {
      const idx = lower.indexOf(term);
      if (idx === -1) continue;
      score += 1 + (term.length >= 5 ? 0.5 : 0);
    }
    if (score > 0) scored.push({ memory, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.memory);
}
function isFtsAvailable(adapter) {
  try {
    const row = adapter.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'").get();
    return !!row;
  } catch {
    return false;
  }
}
function toFtsMatchExpr(query) {
  const tokens = query.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length >= 2).slice(0, 8);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" OR ");
}
function semanticSearch(adapter, queryVector, activeClause, limit) {
  try {
    const rows = adapter.prepare(
      `SELECT m.*, e.vector as embedding_vector, e.dim as embedding_dim
         FROM memories m
         JOIN memory_embeddings e ON e.memory_id = m.id
         ${activeClause}`
    ).all();
    const scored = [];
    for (const row of rows) {
      const dim = row["embedding_dim"];
      if (dim !== queryVector.length) continue;
      const vector = unpackVector(row["embedding_vector"], dim);
      if (!vector) continue;
      const sim = cosine(queryVector, vector);
      if (sim <= 0) continue;
      scored.push({ memory: rowToMemory(row), sim });
    }
    scored.sort((a, b) => b.sim - a.sim);
    return scored.slice(0, limit).map((s) => s.memory);
  } catch {
    return [];
  }
}
function unpackVector(blob, dim) {
  if (!blob) return null;
  try {
    let view = null;
    if (blob instanceof Float32Array) return blob;
    if (blob instanceof Uint8Array) view = blob;
    else if (blob instanceof ArrayBuffer) view = new Uint8Array(blob);
    else if (blob.buffer && blob.byteLength != null) {
      const buf = blob;
      view = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } else if (Array.isArray(blob)) {
      return new Float32Array(blob);
    }
    if (!view || view.byteLength % 4 !== 0) return null;
    const aligned = new ArrayBuffer(view.byteLength);
    new Uint8Array(aligned).set(view);
    const f32 = new Float32Array(aligned);
    return f32.length === dim ? f32 : null;
  } catch {
    return null;
  }
}
function cosine(a, b) {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
function nextMemoryId() {
  if (!isDbAvailable()) return "MEM001";
  const adapter = _getAdapter();
  if (!adapter) return "MEM001";
  try {
    const row = adapter.prepare("SELECT MAX(seq) as max_seq FROM memories").get();
    const maxSeq = row ? row["max_seq"] : null;
    if (maxSeq == null || isNaN(maxSeq)) return "MEM001";
    const next = maxSeq + 1;
    return `MEM${String(next).padStart(3, "0")}`;
  } catch {
    return "MEM001";
  }
}
function createMemory(fields) {
  if (!isDbAvailable()) return null;
  const adapter = _getAdapter();
  if (!adapter) return null;
  try {
    return transaction(() => doCreateMemory(adapter, fields));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.toLowerCase().includes("malformed") && !isInTransaction()) {
      try {
        adapter.prepare("VACUUM").run();
        const recoveryMessage = "recovered malformed memory store via VACUUM";
        process.stderr.write(`memory-store: ${recoveryMessage}
`);
        logWarning("memory-store", recoveryMessage);
        return transaction(() => doCreateMemory(adapter, fields));
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        logWarning("memory-store", `VACUUM recovery for memory store failed: ${retryMsg}`);
        throw err;
      }
    }
    throw err;
  }
}
function doCreateMemory(adapter, fields) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const placeholder = `_TMP_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  insertMemoryRow({
    id: placeholder,
    category: fields.category,
    content: fields.content,
    confidence: fields.confidence ?? 0.8,
    sourceUnitType: fields.source_unit_type ?? null,
    sourceUnitId: fields.source_unit_id ?? null,
    createdAt: now,
    updatedAt: now,
    scope: fields.scope ?? "project",
    tags: fields.tags ?? [],
    structuredFields: fields.structuredFields ?? null
  });
  const row = adapter.prepare("SELECT seq FROM memories WHERE id = :id").get({ ":id": placeholder });
  if (!row) return placeholder;
  const seq = row["seq"];
  const realId = `MEM${String(seq).padStart(3, "0")}`;
  rewriteMemoryId(placeholder, realId);
  return realId;
}
function updateMemoryContent(id, content, confidence) {
  if (!isDbAvailable()) return false;
  try {
    updateMemoryContentRow(id, content, confidence, (/* @__PURE__ */ new Date()).toISOString());
    return true;
  } catch {
    return false;
  }
}
function reinforceMemory(id) {
  if (!isDbAvailable()) return false;
  try {
    incrementMemoryHitCount(id, (/* @__PURE__ */ new Date()).toISOString());
    return true;
  } catch {
    return false;
  }
}
function supersedeMemory(oldId, newId) {
  if (!isDbAvailable()) return false;
  try {
    supersedeMemoryRow(oldId, newId, (/* @__PURE__ */ new Date()).toISOString());
    return true;
  } catch {
    return false;
  }
}
function isUnitProcessed(unitKey) {
  if (!isDbAvailable()) return false;
  const adapter = _getAdapter();
  if (!adapter) return false;
  try {
    const row = adapter.prepare(
      "SELECT 1 FROM memory_processed_units WHERE unit_key = :key"
    ).get({ ":key": unitKey });
    return row != null;
  } catch {
    return false;
  }
}
function markUnitProcessed(unitKey, activityFile) {
  if (!isDbAvailable()) return false;
  try {
    markMemoryUnitProcessed(unitKey, activityFile, (/* @__PURE__ */ new Date()).toISOString());
    return true;
  } catch {
    return false;
  }
}
function decayStaleMemories(thresholdUnits = 20) {
  if (!isDbAvailable()) return [];
  const adapter = _getAdapter();
  if (!adapter) return [];
  try {
    const row = adapter.prepare(
      `SELECT processed_at FROM memory_processed_units
       ORDER BY processed_at DESC
       LIMIT 1 OFFSET :offset`
    ).get({ ":offset": thresholdUnits - 1 });
    if (!row) return [];
    const cutoff = row["processed_at"];
    const affected = adapter.prepare(
      `SELECT id FROM memories
       WHERE superseded_by IS NULL AND updated_at < :cutoff AND confidence > 0.1`
    ).all({ ":cutoff": cutoff }).map((r) => r["id"]);
    decayMemoriesBefore(cutoff, (/* @__PURE__ */ new Date()).toISOString());
    return affected;
  } catch {
    return [];
  }
}
function enforceMemoryCap(max = 50) {
  if (!isDbAvailable()) return;
  const adapter = _getAdapter();
  if (!adapter) return;
  try {
    const countRow = adapter.prepare(
      "SELECT count(*) as cnt FROM memories WHERE superseded_by IS NULL"
    ).get();
    const count = countRow?.["cnt"] ?? 0;
    if (count <= max) return;
    const excess = count - max;
    const victims = adapter.prepare(
      `SELECT id FROM memories
       WHERE superseded_by IS NULL
       ORDER BY (confidence * (1.0 + hit_count * 0.1)) ASC
       LIMIT :limit`
    ).all({ ":limit": excess }).map((row) => row["id"]);
    supersedeLowestRankedMemories(excess, (/* @__PURE__ */ new Date()).toISOString());
    if (victims.length === 0) return;
    for (const id of victims) {
      try {
        deleteMemoryEmbedding(id);
      } catch {
      }
      try {
        deleteMemoryRelationsFor(id);
      } catch {
      }
    }
  } catch {
  }
}
function applyMemoryActions(actions, unitType, unitId) {
  if (!isDbAvailable() || actions.length === 0) return;
  try {
    transaction(() => {
      for (const action of actions) {
        switch (action.action) {
          case "CREATE":
            createMemory({
              category: action.category,
              content: action.content,
              confidence: action.confidence,
              source_unit_type: unitType,
              source_unit_id: unitId,
              scope: action.scope,
              tags: action.tags,
              // ADR-013: forward structured payload through the action layer so
              // bulk applyMemoryActions callers (extraction, ingestion) don't
              // silently drop it.
              structuredFields: action.structuredFields ?? null
            });
            break;
          case "UPDATE":
            updateMemoryContent(action.id, action.content, action.confidence);
            break;
          case "REINFORCE":
            reinforceMemory(action.id);
            break;
          case "SUPERSEDE":
            supersedeMemory(action.id, action.superseded_by);
            break;
          case "LINK":
            applyLinkAction(action);
            break;
        }
      }
      enforceMemoryCap();
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logWarning(
      "memory-store",
      `applyMemoryActions failed (memory subsystem degraded): ${message}`
    );
  }
}
function applyLinkAction(action) {
  try {
    if (!isValidRelation(action.rel)) return;
    createMemoryRelation(action.from, action.to, action.rel, action.confidence);
  } catch {
  }
}
function formatMemoriesForPrompt(memories, tokenBudget = 2e3) {
  if (memories.length === 0) return "";
  const charBudget = tokenBudget * 4;
  const header = "## Project Memory (auto-learned)\n";
  let output = header;
  let remaining = charBudget - header.length;
  const grouped = /* @__PURE__ */ new Map();
  for (const m of memories) {
    const list = grouped.get(m.category) ?? [];
    list.push(m);
    grouped.set(m.category, list);
  }
  const sortedCategories = [...grouped.keys()].sort(
    (a, b) => (CATEGORY_PRIORITY[a] ?? 99) - (CATEGORY_PRIORITY[b] ?? 99)
  );
  for (const category of sortedCategories) {
    const items = grouped.get(category);
    const catHeader = `
### ${category.charAt(0).toUpperCase() + category.slice(1)}
`;
    if (remaining < catHeader.length + 10) break;
    output += catHeader;
    remaining -= catHeader.length;
    for (const item of items) {
      const bullet = `- ${item.content}
`;
      if (remaining < bullet.length) break;
      output += bullet;
      remaining -= bullet.length;
    }
  }
  return output.trimEnd();
}
export {
  applyMemoryActions,
  createMemory,
  decayStaleMemories,
  enforceMemoryCap,
  formatMemoriesForPrompt,
  getActiveMemories,
  getActiveMemoriesRanked,
  isUnitProcessed,
  markUnitProcessed,
  memoryDecayFactor,
  nextMemoryId,
  queryMemoriesRanked,
  reinforceMemory,
  supersedeMemory,
  updateMemoryContent
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9tZW1vcnktc3RvcmUudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRCBNZW1vcnkgU3RvcmUgXHUyMDE0IENSVUQsIHJhbmtlZCBxdWVyaWVzLCBtYWludGVuYW5jZSwgYW5kIHByb21wdCBmb3JtYXR0aW5nXG4vL1xuLy8gU3RvcmFnZSBsYXllciBmb3IgYXV0by1sZWFybmVkIHByb2plY3QgbWVtb3JpZXMuIEZvbGxvd3MgY29udGV4dC1zdG9yZS50cyBwYXR0ZXJucy5cbi8vIEFsbCBmdW5jdGlvbnMgZGVncmFkZSBncmFjZWZ1bGx5OiByZXR1cm4gZW1wdHkgcmVzdWx0cyB3aGVuIERCIHVuYXZhaWxhYmxlLCBuZXZlciB0aHJvdy5cblxuaW1wb3J0IHtcbiAgaXNEYkF2YWlsYWJsZSxcbiAgX2dldEFkYXB0ZXIsXG4gIHRyYW5zYWN0aW9uLFxuICBpc0luVHJhbnNhY3Rpb24sXG4gIGluc2VydE1lbW9yeVJvdyxcbiAgcmV3cml0ZU1lbW9yeUlkLFxuICB1cGRhdGVNZW1vcnlDb250ZW50Um93LFxuICBpbmNyZW1lbnRNZW1vcnlIaXRDb3VudCxcbiAgc3VwZXJzZWRlTWVtb3J5Um93LFxuICBtYXJrTWVtb3J5VW5pdFByb2Nlc3NlZCxcbiAgZGVjYXlNZW1vcmllc0JlZm9yZSxcbiAgc3VwZXJzZWRlTG93ZXN0UmFua2VkTWVtb3JpZXMsXG4gIGRlbGV0ZU1lbW9yeUVtYmVkZGluZyxcbiAgZGVsZXRlTWVtb3J5UmVsYXRpb25zRm9yLFxufSBmcm9tICcuL2dzZC1kYi5qcyc7XG5pbXBvcnQgeyBjcmVhdGVNZW1vcnlSZWxhdGlvbiwgaXNWYWxpZFJlbGF0aW9uIH0gZnJvbSAnLi9tZW1vcnktcmVsYXRpb25zLmpzJztcbmltcG9ydCB7IGxvZ1dhcm5pbmcgfSBmcm9tICcuL3dvcmtmbG93LWxvZ2dlci5qcyc7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUeXBlcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGludGVyZmFjZSBNZW1vcnkge1xuICBzZXE6IG51bWJlcjtcbiAgaWQ6IHN0cmluZztcbiAgY2F0ZWdvcnk6IHN0cmluZztcbiAgY29udGVudDogc3RyaW5nO1xuICBjb25maWRlbmNlOiBudW1iZXI7XG4gIHNvdXJjZV91bml0X3R5cGU6IHN0cmluZyB8IG51bGw7XG4gIHNvdXJjZV91bml0X2lkOiBzdHJpbmcgfCBudWxsO1xuICBjcmVhdGVkX2F0OiBzdHJpbmc7XG4gIHVwZGF0ZWRfYXQ6IHN0cmluZztcbiAgc3VwZXJzZWRlZF9ieTogc3RyaW5nIHwgbnVsbDtcbiAgaGl0X2NvdW50OiBudW1iZXI7XG4gIHNjb3BlOiBzdHJpbmc7XG4gIHRhZ3M6IHN0cmluZ1tdO1xuICAvKipcbiAgICogQURSLTAxMyBTdGVwIDI6IG9wdGlvbmFsIHN0cnVjdHVyZWQgcGF5bG9hZC4gTlVMTCBmb3IgbWVtb3JpZXMgY2FwdHVyZWRcbiAgICogdmlhIHBsYWluIGNhcHR1cmVfdGhvdWdodC4gUG9wdWxhdGVkIG9uIG1lbW9yaWVzIGJhY2tmaWxsZWQgZnJvbSB0aGVcbiAgICogZGVjaXNpb25zIHRhYmxlIChTdGVwIDUpIHdpdGggdGhlIG9yaWdpbmFsIHNjb3BlL2RlY2lzaW9uL2Nob2ljZS9ldGMuXG4gICAqL1xuICBzdHJ1Y3R1cmVkX2ZpZWxkczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCBudWxsO1xuICAvKiogSVNPIHRpbWVzdGFtcCBvZiB0aGUgbW9zdCByZWNlbnQgbWVtb3J5X3F1ZXJ5IGhpdC4gTlVMTCB1bnRpbCBmaXJzdCBoaXQuICovXG4gIGxhc3RfaGl0X2F0OiBzdHJpbmcgfCBudWxsO1xufVxuXG5leHBvcnQgdHlwZSBNZW1vcnlBY3Rpb25DcmVhdGUgPSB7XG4gIGFjdGlvbjogJ0NSRUFURSc7XG4gIGNhdGVnb3J5OiBzdHJpbmc7XG4gIGNvbnRlbnQ6IHN0cmluZztcbiAgY29uZmlkZW5jZT86IG51bWJlcjtcbiAgc2NvcGU/OiBzdHJpbmc7XG4gIHRhZ3M/OiBzdHJpbmdbXTtcbiAgc3RydWN0dXJlZEZpZWxkcz86IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbDtcbn07XG5cbmV4cG9ydCB0eXBlIE1lbW9yeUFjdGlvblVwZGF0ZSA9IHtcbiAgYWN0aW9uOiAnVVBEQVRFJztcbiAgaWQ6IHN0cmluZztcbiAgY29udGVudDogc3RyaW5nO1xuICBjb25maWRlbmNlPzogbnVtYmVyO1xufTtcblxuZXhwb3J0IHR5cGUgTWVtb3J5QWN0aW9uUmVpbmZvcmNlID0ge1xuICBhY3Rpb246ICdSRUlORk9SQ0UnO1xuICBpZDogc3RyaW5nO1xufTtcblxuZXhwb3J0IHR5cGUgTWVtb3J5QWN0aW9uU3VwZXJzZWRlID0ge1xuICBhY3Rpb246ICdTVVBFUlNFREUnO1xuICBpZDogc3RyaW5nO1xuICBzdXBlcnNlZGVkX2J5OiBzdHJpbmc7XG59O1xuXG5leHBvcnQgdHlwZSBNZW1vcnlBY3Rpb25MaW5rID0ge1xuICBhY3Rpb246ICdMSU5LJztcbiAgZnJvbTogc3RyaW5nO1xuICB0bzogc3RyaW5nO1xuICByZWw6IHN0cmluZztcbiAgY29uZmlkZW5jZT86IG51bWJlcjtcbn07XG5cbmV4cG9ydCB0eXBlIE1lbW9yeUFjdGlvbiA9XG4gIHwgTWVtb3J5QWN0aW9uQ3JlYXRlXG4gIHwgTWVtb3J5QWN0aW9uVXBkYXRlXG4gIHwgTWVtb3J5QWN0aW9uUmVpbmZvcmNlXG4gIHwgTWVtb3J5QWN0aW9uU3VwZXJzZWRlXG4gIHwgTWVtb3J5QWN0aW9uTGluaztcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIENhdGVnb3J5IERpc3BsYXkgT3JkZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmNvbnN0IENBVEVHT1JZX1BSSU9SSVRZOiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+ID0ge1xuICBnb3RjaGE6IDAsXG4gIGNvbnZlbnRpb246IDEsXG4gIGFyY2hpdGVjdHVyZTogMixcbiAgcGF0dGVybjogMyxcbiAgZW52aXJvbm1lbnQ6IDQsXG4gIHByZWZlcmVuY2U6IDUsXG59O1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU2NvcmluZyBIZWxwZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFRpbWUtZGVjYXkgZmFjdG9yIGZvciBtZW1vcnkgcmVsZXZhbmNlIHNjb3JpbmcuXG4gKiBSZXR1cm5zIDEuMCBmb3IgbmV2ZXItaGl0IG9yIHJlY2VudGx5LWhpdCBtZW1vcmllcywgZGVjYXlpbmcgbGluZWFybHkgdG9cbiAqIDAuNyBmb3IgbWVtb3JpZXMgbm90IGFjY2Vzc2VkIGluIDkwKyBkYXlzLiBGbG9vciBhdCAwLjcga2VlcHMgb2xkLWJ1dC12YWxpZFxuICoga25vd2xlZGdlIGZyb20gYmVpbmcgZnVsbHkgc3VwcHJlc3NlZC5cbiAqXG4gKiBEZWZlbnNpdmUgcGFyc2luZzogaW52YWxpZCB0aW1lc3RhbXAgc3RyaW5ncyAoTmFOIGZyb20gRGF0ZS5wYXJzZSkgYXJlXG4gKiB0cmVhdGVkIGFzIFwibm8gZGVjYXlcIiByYXRoZXIgdGhhbiBwcm9wYWdhdGluZyBOYU4gaW50byBzY29yZSBhcml0aG1ldGljLlxuICogRnV0dXJlIHRpbWVzdGFtcHMgKGNsb2NrIHNrZXcsIG1hbnVhbCBEQiBlZGl0cykgY2xhbXAgdG8gZGF5c0Fnbz0wIHNvIHRoZVxuICogZmFjdG9yIHN0YXlzIGluIHRoZSBkb2N1bWVudGVkIFswLjcsIDEuMF0gY29udHJhY3QuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtZW1vcnlEZWNheUZhY3RvcihsYXN0SGl0QXQ6IHN0cmluZyB8IG51bGwpOiBudW1iZXIge1xuICBpZiAoIWxhc3RIaXRBdCkgcmV0dXJuIDEuMDtcbiAgY29uc3QgdHMgPSBEYXRlLnBhcnNlKGxhc3RIaXRBdCk7XG4gIGlmICghTnVtYmVyLmlzRmluaXRlKHRzKSkgcmV0dXJuIDEuMDtcbiAgY29uc3QgZGF5c0FnbyA9IE1hdGgubWF4KDAsIChEYXRlLm5vdygpIC0gdHMpIC8gODZfNDAwXzAwMCk7XG4gIHJldHVybiBNYXRoLm1heCgwLjcsIDEuMCAtIDAuMyAqIE1hdGgubWluKDEuMCwgZGF5c0FnbyAvIDkwKSk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBSb3cgTWFwcGluZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gcm93VG9NZW1vcnkocm93OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IE1lbW9yeSB7XG4gIHJldHVybiB7XG4gICAgc2VxOiByb3dbJ3NlcSddIGFzIG51bWJlcixcbiAgICBpZDogcm93WydpZCddIGFzIHN0cmluZyxcbiAgICBjYXRlZ29yeTogcm93WydjYXRlZ29yeSddIGFzIHN0cmluZyxcbiAgICBjb250ZW50OiByb3dbJ2NvbnRlbnQnXSBhcyBzdHJpbmcsXG4gICAgY29uZmlkZW5jZTogcm93Wydjb25maWRlbmNlJ10gYXMgbnVtYmVyLFxuICAgIHNvdXJjZV91bml0X3R5cGU6IChyb3dbJ3NvdXJjZV91bml0X3R5cGUnXSBhcyBzdHJpbmcpID8/IG51bGwsXG4gICAgc291cmNlX3VuaXRfaWQ6IChyb3dbJ3NvdXJjZV91bml0X2lkJ10gYXMgc3RyaW5nKSA/PyBudWxsLFxuICAgIGNyZWF0ZWRfYXQ6IHJvd1snY3JlYXRlZF9hdCddIGFzIHN0cmluZyxcbiAgICB1cGRhdGVkX2F0OiByb3dbJ3VwZGF0ZWRfYXQnXSBhcyBzdHJpbmcsXG4gICAgc3VwZXJzZWRlZF9ieTogKHJvd1snc3VwZXJzZWRlZF9ieSddIGFzIHN0cmluZykgPz8gbnVsbCxcbiAgICBoaXRfY291bnQ6IHJvd1snaGl0X2NvdW50J10gYXMgbnVtYmVyLFxuICAgIHNjb3BlOiAocm93WydzY29wZSddIGFzIHN0cmluZykgPz8gJ3Byb2plY3QnLFxuICAgIHRhZ3M6IHBhcnNlVGFncyhyb3dbJ3RhZ3MnXSksXG4gICAgc3RydWN0dXJlZF9maWVsZHM6IHBhcnNlU3RydWN0dXJlZEZpZWxkcyhyb3dbJ3N0cnVjdHVyZWRfZmllbGRzJ10pLFxuICAgIGxhc3RfaGl0X2F0OiAocm93WydsYXN0X2hpdF9hdCddIGFzIHN0cmluZyB8IG51bGwpID8/IG51bGwsXG4gIH07XG59XG5cbmZ1bmN0aW9uIHBhcnNlU3RydWN0dXJlZEZpZWxkcyhyYXc6IHVua25vd24pOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGwge1xuICBpZiAodHlwZW9mIHJhdyAhPT0gJ3N0cmluZycgfHwgcmF3Lmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG4gIHRyeSB7XG4gICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShyYXcpO1xuICAgIHJldHVybiBwYXJzZWQgJiYgdHlwZW9mIHBhcnNlZCA9PT0gJ29iamVjdCcgJiYgIUFycmF5LmlzQXJyYXkocGFyc2VkKVxuICAgICAgPyAocGFyc2VkIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KVxuICAgICAgOiBudWxsO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5mdW5jdGlvbiBwYXJzZVRhZ3MocmF3OiB1bmtub3duKTogc3RyaW5nW10ge1xuICBpZiAodHlwZW9mIHJhdyAhPT0gJ3N0cmluZycgfHwgcmF3Lmxlbmd0aCA9PT0gMCkgcmV0dXJuIFtdO1xuICB0cnkge1xuICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocmF3KTtcbiAgICByZXR1cm4gQXJyYXkuaXNBcnJheShwYXJzZWQpID8gcGFyc2VkLmZpbHRlcigodCk6IHQgaXMgc3RyaW5nID0+IHR5cGVvZiB0ID09PSAnc3RyaW5nJykgOiBbXTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBRdWVyeSBGdW5jdGlvbnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogR2V0IGFsbCBtZW1vcmllcyB3aGVyZSBzdXBlcnNlZGVkX2J5IElTIE5VTEwuXG4gKiBSZXR1cm5zIFtdIGlmIERCIGlzIG5vdCBhdmFpbGFibGUuIE5ldmVyIHRocm93cy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldEFjdGl2ZU1lbW9yaWVzKCk6IE1lbW9yeVtdIHtcbiAgaWYgKCFpc0RiQXZhaWxhYmxlKCkpIHJldHVybiBbXTtcbiAgY29uc3QgYWRhcHRlciA9IF9nZXRBZGFwdGVyKCk7XG4gIGlmICghYWRhcHRlcikgcmV0dXJuIFtdO1xuXG4gIHRyeSB7XG4gICAgY29uc3Qgcm93cyA9IGFkYXB0ZXIucHJlcGFyZSgnU0VMRUNUICogRlJPTSBtZW1vcmllcyBXSEVSRSBzdXBlcnNlZGVkX2J5IElTIE5VTEwnKS5hbGwoKTtcbiAgICByZXR1cm4gcm93cy5tYXAocm93VG9NZW1vcnkpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gW107XG4gIH1cbn1cblxuLyoqXG4gKiBHZXQgYWN0aXZlIG1lbW9yaWVzIG9yZGVyZWQgYnkgcmFua2luZyBzY29yZTogY29uZmlkZW5jZSAqICgxICsgaGl0X2NvdW50ICogMC4xKS5cbiAqIEhpZ2hlci1zY29yZWQgbWVtb3JpZXMgYXJlIG1vcmUgcmVsZXZhbnQgYW5kIGZyZXF1ZW50bHkgY29uZmlybWVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0QWN0aXZlTWVtb3JpZXNSYW5rZWQobGltaXQgPSAzMCk6IE1lbW9yeVtdIHtcbiAgaWYgKCFpc0RiQXZhaWxhYmxlKCkpIHJldHVybiBbXTtcbiAgY29uc3QgYWRhcHRlciA9IF9nZXRBZGFwdGVyKCk7XG4gIGlmICghYWRhcHRlcikgcmV0dXJuIFtdO1xuXG4gIHRyeSB7XG4gICAgY29uc3Qgcm93cyA9IGFkYXB0ZXIucHJlcGFyZShcbiAgICAgIGBTRUxFQ1QgKiBGUk9NIG1lbW9yaWVzXG4gICAgICAgV0hFUkUgc3VwZXJzZWRlZF9ieSBJUyBOVUxMXG4gICAgICAgT1JERVIgQlkgKGNvbmZpZGVuY2UgKiAoMS4wICsgaGl0X2NvdW50ICogMC4xKSkgREVTQ1xuICAgICAgIExJTUlUIDpsaW1pdGAsXG4gICAgKS5hbGwoeyAnOmxpbWl0JzogbGltaXQgfSk7XG4gICAgcmV0dXJuIHJvd3MubWFwKHJvd1RvTWVtb3J5KTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBIeWJyaWQgcXVlcnkgKGtleXdvcmQgRlRTICsgb3B0aW9uYWwgc2VtYW50aWMpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgaW50ZXJmYWNlIFF1ZXJ5TWVtb3JpZXNGaWx0ZXJzIHtcbiAgY2F0ZWdvcnk/OiBzdHJpbmc7XG4gIHNjb3BlPzogc3RyaW5nO1xuICB0YWc/OiBzdHJpbmc7XG4gIGluY2x1ZGVfc3VwZXJzZWRlZD86IGJvb2xlYW47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUXVlcnlNZW1vcmllc09wdGlvbnMgZXh0ZW5kcyBRdWVyeU1lbW9yaWVzRmlsdGVycyB7XG4gIHF1ZXJ5OiBzdHJpbmc7XG4gIGs/OiBudW1iZXI7XG4gIC8qKlxuICAgKiBPcHRpb25hbCBxdWVyeS1zaWRlIGVtYmVkZGluZy4gV2hlbiBwcm92aWRlZCBhbmQgZW1iZWRkaW5ncyBleGlzdCBpbiB0aGVcbiAgICogREIsIHJlc3VsdHMgYXJlIGZ1c2VkIHdpdGggY29zaW5lIHNpbWlsYXJpdHkgdmlhIHJlY2lwcm9jYWwtcmFuay1mdXNpb24uXG4gICAqL1xuICBxdWVyeVZlY3Rvcj86IEZsb2F0MzJBcnJheSB8IG51bGw7XG4gIC8qKiBSUkYgZnVzaW9uIGNvbnN0YW50IChkZWZhdWx0IDYwKS4gKi9cbiAgcnJmSz86IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBSYW5rZWRNZW1vcnkge1xuICBtZW1vcnk6IE1lbW9yeTtcbiAgc2NvcmU6IG51bWJlcjtcbiAga2V5d29yZFJhbms6IG51bWJlciB8IG51bGw7XG4gIHNlbWFudGljUmFuazogbnVtYmVyIHwgbnVsbDtcbiAgY29uZmlkZW5jZUJvb3N0OiBudW1iZXI7XG4gIHJlYXNvbjogJ2tleXdvcmQnIHwgJ3NlbWFudGljJyB8ICdib3RoJyB8ICdyYW5rZWQnO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcXVlcnlNZW1vcmllc1JhbmtlZChvcHRzOiBRdWVyeU1lbW9yaWVzT3B0aW9ucyk6IFJhbmtlZE1lbW9yeVtdIHtcbiAgaWYgKCFpc0RiQXZhaWxhYmxlKCkpIHJldHVybiBbXTtcbiAgY29uc3QgYWRhcHRlciA9IF9nZXRBZGFwdGVyKCk7XG4gIGlmICghYWRhcHRlcikgcmV0dXJuIFtdO1xuXG4gIGNvbnN0IGsgPSBjbGFtcExpbWl0KG9wdHMuaywgMTApO1xuICBjb25zdCBycmZLID0gb3B0cy5ycmZLID8/IDYwO1xuICBjb25zdCBhY3RpdmVDbGF1c2UgPSBvcHRzLmluY2x1ZGVfc3VwZXJzZWRlZCA9PT0gdHJ1ZSA/ICcnIDogJ1dIRVJFIHN1cGVyc2VkZWRfYnkgSVMgTlVMTCc7XG4gIGNvbnN0IHRyaW1tZWRRdWVyeSA9IChvcHRzLnF1ZXJ5ID8/ICcnKS50cmltKCk7XG5cbiAgLy8gMSkgS2V5d29yZCBoaXRzIFx1MjAxNCB0cnkgRlRTNSBmaXJzdCwgZmFsbCBiYWNrIHRvIExJS0Ugd2hlbiB1bmF2YWlsYWJsZS5cbiAgY29uc3Qga2V5d29yZEhpdHMgPSB0cmltbWVkUXVlcnkgPyBrZXl3b3JkU2VhcmNoKGFkYXB0ZXIsIHRyaW1tZWRRdWVyeSwgYWN0aXZlQ2xhdXNlLCA1MCkgOiBbXTtcblxuICAvLyAyKSBTZW1hbnRpYyBoaXRzIFx1MjAxNCBjb3NpbmUgb3ZlciBtZW1vcnlfZW1iZWRkaW5ncy4gUmVxdWlyZXMgb3B0cy5xdWVyeVZlY3Rvci5cbiAgY29uc3Qgc2VtYW50aWNIaXRzID0gb3B0cy5xdWVyeVZlY3RvclxuICAgID8gc2VtYW50aWNTZWFyY2goYWRhcHRlciwgb3B0cy5xdWVyeVZlY3RvciwgYWN0aXZlQ2xhdXNlLCA1MClcbiAgICA6IFtdO1xuXG4gIGlmIChrZXl3b3JkSGl0cy5sZW5ndGggPT09IDAgJiYgc2VtYW50aWNIaXRzLmxlbmd0aCA9PT0gMCAmJiAhdHJpbW1lZFF1ZXJ5KSB7XG4gICAgLy8gTm8gcXVlcnkgYXQgYWxsIFx1MjAxNCByZXR1cm4gdG9wLWsgYnkgZGVjYXktYXdhcmUgcmFua2VkIHNjb3JlLlxuICAgIC8vXG4gICAgLy8gQnVpbGQgdGhlIGNhbmRpZGF0ZSBwb29sIGZyb20gYSBkaXJlY3QgU1FMIHF1ZXJ5IHRoYXQgaG9ub3JzIHRoZVxuICAgIC8vIHJlcXVlc3QncyBhY3RpdmVDbGF1c2UgKGkuZS4gaW5jbHVkZV9zdXBlcnNlZGVkKS4gVXNpbmdcbiAgICAvLyBnZXRBY3RpdmVNZW1vcmllc1JhbmtlZCBoZXJlIHdvdWxkIHNpbGVudGx5IGRyb3Agc3VwZXJzZWRlZCByb3dzIGV2ZW5cbiAgICAvLyB3aGVuIHRoZSBjYWxsZXIgZXhwbGljaXRseSBvcHRlZCBpbiwgYW5kIHdvdWxkIHNsaWNlIGJ5IHJhdyBzY29yZVxuICAgIC8vIGJlZm9yZSBkZWNheS9maWx0ZXJzIGhhZCBhIGNoYW5jZSB0byByZW9yZGVyLlxuICAgIGNvbnN0IGNhbmRpZGF0ZVBvb2wgPSBNYXRoLm1pbihNYXRoLm1heChrICogNSwgNTApLCA1MDApO1xuICAgIGNvbnN0IHJvd3MgPSBhZGFwdGVyXG4gICAgICAucHJlcGFyZShcbiAgICAgICAgYFNFTEVDVCAqIEZST00gbWVtb3JpZXMgJHthY3RpdmVDbGF1c2V9XG4gICAgICAgICBPUkRFUiBCWSAoY29uZmlkZW5jZSAqICgxLjAgKyBoaXRfY291bnQgKiAwLjEpKSBERVNDXG4gICAgICAgICBMSU1JVCA6bGltaXRgLFxuICAgICAgKVxuICAgICAgLmFsbCh7ICc6bGltaXQnOiBjYW5kaWRhdGVQb29sIH0pO1xuXG4gICAgY29uc3QgcmFua2VkOiBSYW5rZWRNZW1vcnlbXSA9IFtdO1xuICAgIGZvciAoY29uc3Qgcm93IG9mIHJvd3MpIHtcbiAgICAgIGNvbnN0IG1lbW9yeSA9IHJvd1RvTWVtb3J5KHJvdyk7XG4gICAgICBpZiAoIXBhc3Nlc0ZpbHRlcnMobWVtb3J5LCBvcHRzKSkgY29udGludWU7XG4gICAgICBjb25zdCBkZWNheSA9IG1lbW9yeURlY2F5RmFjdG9yKG1lbW9yeS5sYXN0X2hpdF9hdCk7XG4gICAgICBjb25zdCBzY29yZSA9IG1lbW9yeS5jb25maWRlbmNlICogKDEgKyBtZW1vcnkuaGl0X2NvdW50ICogMC4xKSAqIGRlY2F5O1xuICAgICAgcmFua2VkLnB1c2goe1xuICAgICAgICBtZW1vcnksXG4gICAgICAgIHNjb3JlLFxuICAgICAgICBrZXl3b3JkUmFuazogbnVsbCxcbiAgICAgICAgc2VtYW50aWNSYW5rOiBudWxsLFxuICAgICAgICBjb25maWRlbmNlQm9vc3Q6IHNjb3JlLFxuICAgICAgICByZWFzb246ICdyYW5rZWQnIGFzIGNvbnN0LFxuICAgICAgfSk7XG4gICAgfVxuICAgIHJhbmtlZC5zb3J0KChhLCBiKSA9PiBiLnNjb3JlIC0gYS5zY29yZSk7XG4gICAgcmV0dXJuIHJhbmtlZC5zbGljZSgwLCBrKTtcbiAgfVxuXG4gIC8vIDMpIFJlY2lwcm9jYWwgcmFuayBmdXNpb24gXHUyMDE0IGVhY2ggaGl0IGNvbnRyaWJ1dGVzIDEvKHJyZksgKyByYW5rKS5cbiAgY29uc3QgZnVzZWQgPSBuZXcgTWFwPHN0cmluZywgeyBtZW1vcnk6IE1lbW9yeTsga3dSYW5rOiBudW1iZXIgfCBudWxsOyBzZW1SYW5rOiBudW1iZXIgfCBudWxsOyBzY29yZTogbnVtYmVyIH0+KCk7XG5cbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBrZXl3b3JkSGl0cy5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IGhpdCA9IGtleXdvcmRIaXRzW2ldO1xuICAgIGNvbnN0IGV4aXN0aW5nID0gZnVzZWQuZ2V0KGhpdC5pZCk7XG4gICAgY29uc3QgcnJmID0gMSAvIChycmZLICsgaSArIDEpO1xuICAgIGlmIChleGlzdGluZykge1xuICAgICAgZXhpc3Rpbmcua3dSYW5rID0gaSArIDE7XG4gICAgICBleGlzdGluZy5zY29yZSArPSBycmY7XG4gICAgfSBlbHNlIHtcbiAgICAgIGZ1c2VkLnNldChoaXQuaWQsIHsgbWVtb3J5OiBoaXQsIGt3UmFuazogaSArIDEsIHNlbVJhbms6IG51bGwsIHNjb3JlOiBycmYgfSk7XG4gICAgfVxuICB9XG5cbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBzZW1hbnRpY0hpdHMubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBoaXQgPSBzZW1hbnRpY0hpdHNbaV07XG4gICAgY29uc3QgZXhpc3RpbmcgPSBmdXNlZC5nZXQoaGl0LmlkKTtcbiAgICBjb25zdCBycmYgPSAxIC8gKHJyZksgKyBpICsgMSk7XG4gICAgaWYgKGV4aXN0aW5nKSB7XG4gICAgICBleGlzdGluZy5zZW1SYW5rID0gaSArIDE7XG4gICAgICBleGlzdGluZy5zY29yZSArPSBycmY7XG4gICAgfSBlbHNlIHtcbiAgICAgIGZ1c2VkLnNldChoaXQuaWQsIHsgbWVtb3J5OiBoaXQsIGt3UmFuazogbnVsbCwgc2VtUmFuazogaSArIDEsIHNjb3JlOiBycmYgfSk7XG4gICAgfVxuICB9XG5cbiAgLy8gNCkgQXBwbHkgZmlsdGVycyArIGNvbmZpZGVuY2UgYm9vc3QsIHRoZW4gc29ydC5cbiAgY29uc3QgcmFua2VkOiBSYW5rZWRNZW1vcnlbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGVudHJ5IG9mIGZ1c2VkLnZhbHVlcygpKSB7XG4gICAgaWYgKCFwYXNzZXNGaWx0ZXJzKGVudHJ5Lm1lbW9yeSwgb3B0cykpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGJvb3N0ID0gZW50cnkubWVtb3J5LmNvbmZpZGVuY2UgKiAoMSArIGVudHJ5Lm1lbW9yeS5oaXRfY291bnQgKiAwLjEpICogbWVtb3J5RGVjYXlGYWN0b3IoZW50cnkubWVtb3J5Lmxhc3RfaGl0X2F0KTtcbiAgICBjb25zdCByZWFzb246IFJhbmtlZE1lbW9yeVsncmVhc29uJ10gPVxuICAgICAgZW50cnkua3dSYW5rICE9IG51bGwgJiYgZW50cnkuc2VtUmFuayAhPSBudWxsXG4gICAgICAgID8gJ2JvdGgnXG4gICAgICAgIDogZW50cnkua3dSYW5rICE9IG51bGxcbiAgICAgICAgICA/ICdrZXl3b3JkJ1xuICAgICAgICAgIDogJ3NlbWFudGljJztcbiAgICByYW5rZWQucHVzaCh7XG4gICAgICBtZW1vcnk6IGVudHJ5Lm1lbW9yeSxcbiAgICAgIHNjb3JlOiBlbnRyeS5zY29yZSAqIGJvb3N0LFxuICAgICAga2V5d29yZFJhbms6IGVudHJ5Lmt3UmFuayxcbiAgICAgIHNlbWFudGljUmFuazogZW50cnkuc2VtUmFuayxcbiAgICAgIGNvbmZpZGVuY2VCb29zdDogYm9vc3QsXG4gICAgICByZWFzb24sXG4gICAgfSk7XG4gIH1cblxuICByYW5rZWQuc29ydCgoYSwgYikgPT4gYi5zY29yZSAtIGEuc2NvcmUpO1xuICByZXR1cm4gcmFua2VkLnNsaWNlKDAsIGspO1xufVxuXG5mdW5jdGlvbiBjbGFtcExpbWl0KHZhbHVlOiB1bmtub3duLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gJ251bWJlcicgfHwgIU51bWJlci5pc0Zpbml0ZSh2YWx1ZSkpIHJldHVybiBmYWxsYmFjaztcbiAgaWYgKHZhbHVlIDwgMSkgcmV0dXJuIDE7XG4gIGlmICh2YWx1ZSA+IDEwMCkgcmV0dXJuIDEwMDtcbiAgcmV0dXJuIE1hdGguZmxvb3IodmFsdWUpO1xufVxuXG5mdW5jdGlvbiBwYXNzZXNGaWx0ZXJzKG1lbW9yeTogTWVtb3J5LCBmaWx0ZXJzOiBRdWVyeU1lbW9yaWVzRmlsdGVycyk6IGJvb2xlYW4ge1xuICBpZiAoZmlsdGVycy5jYXRlZ29yeSAmJiBtZW1vcnkuY2F0ZWdvcnkudG9Mb3dlckNhc2UoKSAhPT0gZmlsdGVycy5jYXRlZ29yeS50b0xvd2VyQ2FzZSgpKSByZXR1cm4gZmFsc2U7XG4gIGlmIChmaWx0ZXJzLnNjb3BlICYmIG1lbW9yeS5zY29wZSAhPT0gZmlsdGVycy5zY29wZSkgcmV0dXJuIGZhbHNlO1xuICBpZiAoZmlsdGVycy50YWcpIHtcbiAgICBjb25zdCBuZWVkbGUgPSBmaWx0ZXJzLnRhZy50b0xvd2VyQ2FzZSgpO1xuICAgIGlmICghbWVtb3J5LnRhZ3MubWFwKCh0KSA9PiB0LnRvTG93ZXJDYXNlKCkpLmluY2x1ZGVzKG5lZWRsZSkpIHJldHVybiBmYWxzZTtcbiAgfVxuICByZXR1cm4gdHJ1ZTtcbn1cblxubGV0IGZ0c1dhcm5pbmdFbWl0dGVkID0gZmFsc2U7XG5cbmZ1bmN0aW9uIGtleXdvcmRTZWFyY2goXG4gIGFkYXB0ZXI6IE5vbk51bGxhYmxlPFJldHVyblR5cGU8dHlwZW9mIF9nZXRBZGFwdGVyPj4sXG4gIHJhd1F1ZXJ5OiBzdHJpbmcsXG4gIGFjdGl2ZUNsYXVzZTogc3RyaW5nLFxuICBsaW1pdDogbnVtYmVyLFxuKTogTWVtb3J5W10ge1xuICBjb25zdCBmdHNBdmFpbGFibGUgPSBpc0Z0c0F2YWlsYWJsZShhZGFwdGVyKTtcbiAgaWYgKGZ0c0F2YWlsYWJsZSkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBtYXRjaEV4cHIgPSB0b0Z0c01hdGNoRXhwcihyYXdRdWVyeSk7XG4gICAgICBpZiAoIW1hdGNoRXhwcikgcmV0dXJuIFtdO1xuICAgICAgY29uc3QgYWN0aXZlUGFydCA9IGFjdGl2ZUNsYXVzZSA/IGBBTkQgbS4ke2FjdGl2ZUNsYXVzZS5yZXBsYWNlKC9eV0hFUkVcXHMrL2ksICcnKX1gIDogJyc7XG4gICAgICBjb25zdCByb3dzID0gYWRhcHRlci5wcmVwYXJlKFxuICAgICAgICBgU0VMRUNUIG0uKlxuICAgICAgICAgRlJPTSBtZW1vcmllc19mdHMgZlxuICAgICAgICAgSk9JTiBtZW1vcmllcyBtIE9OIG0uc2VxID0gZi5yb3dpZFxuICAgICAgICAgV0hFUkUgbWVtb3JpZXNfZnRzIE1BVENIIDptYXRjaFxuICAgICAgICAgJHthY3RpdmVQYXJ0fVxuICAgICAgICAgT1JERVIgQlkgYm0yNShtZW1vcmllc19mdHMpXG4gICAgICAgICBMSU1JVCA6bGltaXRgLFxuICAgICAgKS5hbGwoeyAnOm1hdGNoJzogbWF0Y2hFeHByLCAnOmxpbWl0JzogbGltaXQgfSk7XG4gICAgICByZXR1cm4gcm93cy5tYXAocm93VG9NZW1vcnkpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gZmFsbCB0aHJvdWdoIHRvIExJS0VcbiAgICB9XG4gIH1cblxuICAvLyBMSUtFIGZhbGxiYWNrIFx1MjAxNCBzY2FucyBhIGNhcHBlZCBjYW5kaWRhdGUgcG9vbC5cbiAgaWYgKCFmdHNXYXJuaW5nRW1pdHRlZCkge1xuICAgIGZ0c1dhcm5pbmdFbWl0dGVkID0gdHJ1ZTtcbiAgICBsb2dXYXJuaW5nKCdtZW1vcnktc3RvcmUnLCAnRlRTNSB1bmF2YWlsYWJsZSBcdTIwMTQgdXNpbmcgTElLRSBmYWxsYmFjayBzY2FuIChjb25zaWRlciBlbmFibGluZyBGVFM1KScpO1xuICB9XG5cbiAgY29uc3QgdGVybXMgPSByYXdRdWVyeVxuICAgIC50b0xvd2VyQ2FzZSgpXG4gICAgLnNwbGl0KC9bXmEtejAtOV9dKy8pXG4gICAgLmZpbHRlcigodCkgPT4gdC5sZW5ndGggPj0gMik7XG4gIGlmICh0ZXJtcy5sZW5ndGggPT09IDApIHJldHVybiBbXTtcblxuICBjb25zdCBwcmVTY2FuQ2FwID0gTWF0aC5taW4obGltaXQgKiAyMCwgMjAwMCk7XG4gIC8vIE9SREVSIEJZIGNvbmZpZGVuY2Utd2VpZ2h0ZWQgaGl0X2NvdW50IERFU0Mgc28gdGhlIGNhcCBrZWVwcyB0aGUgbW9zdFxuICAvLyB2YWx1YWJsZSBjYW5kaWRhdGVzIGluc3RlYWQgb2YgdGhlIG9sZGVzdC1ieS1yb3dpZCAod2hpY2ggd291bGQgc2lsZW50bHlcbiAgLy8gZXhjbHVkZSByZWNlbnRseS1zdG9yZWQgbWVtb3JpZXMgb24gdGFibGVzIGxhcmdlciB0aGFuIHByZVNjYW5DYXApLlxuICBjb25zdCByb3dzID0gYWRhcHRlclxuICAgIC5wcmVwYXJlKFxuICAgICAgYFNFTEVDVCAqIEZST00gbWVtb3JpZXMgJHthY3RpdmVDbGF1c2V9XG4gICAgICAgT1JERVIgQlkgKGNvbmZpZGVuY2UgKiAoMS4wICsgaGl0X2NvdW50ICogMC4xKSkgREVTQ1xuICAgICAgIExJTUlUIDpwcmVTY2FuQ2FwYCxcbiAgICApXG4gICAgLmFsbCh7ICc6cHJlU2NhbkNhcCc6IHByZVNjYW5DYXAgfSk7XG4gIGNvbnN0IHNjb3JlZDogQXJyYXk8eyBtZW1vcnk6IE1lbW9yeTsgc2NvcmU6IG51bWJlciB9PiA9IFtdO1xuICBmb3IgKGNvbnN0IHJvdyBvZiByb3dzKSB7XG4gICAgY29uc3QgbWVtb3J5ID0gcm93VG9NZW1vcnkocm93KTtcbiAgICBjb25zdCBsb3dlciA9IG1lbW9yeS5jb250ZW50LnRvTG93ZXJDYXNlKCk7XG4gICAgbGV0IHNjb3JlID0gMDtcbiAgICBmb3IgKGNvbnN0IHRlcm0gb2YgdGVybXMpIHtcbiAgICAgIGNvbnN0IGlkeCA9IGxvd2VyLmluZGV4T2YodGVybSk7XG4gICAgICBpZiAoaWR4ID09PSAtMSkgY29udGludWU7XG4gICAgICBzY29yZSArPSAxICsgKHRlcm0ubGVuZ3RoID49IDUgPyAwLjUgOiAwKTtcbiAgICB9XG4gICAgaWYgKHNjb3JlID4gMCkgc2NvcmVkLnB1c2goeyBtZW1vcnksIHNjb3JlIH0pO1xuICB9XG4gIHNjb3JlZC5zb3J0KChhLCBiKSA9PiBiLnNjb3JlIC0gYS5zY29yZSk7XG4gIHJldHVybiBzY29yZWQuc2xpY2UoMCwgbGltaXQpLm1hcCgocykgPT4gcy5tZW1vcnkpO1xufVxuXG5mdW5jdGlvbiBpc0Z0c0F2YWlsYWJsZShhZGFwdGVyOiBOb25OdWxsYWJsZTxSZXR1cm5UeXBlPHR5cGVvZiBfZ2V0QWRhcHRlcj4+KTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgY29uc3Qgcm93ID0gYWRhcHRlclxuICAgICAgLnByZXBhcmUoXCJTRUxFQ1QgbmFtZSBGUk9NIHNxbGl0ZV9tYXN0ZXIgV0hFUkUgdHlwZT0ndGFibGUnIEFORCBuYW1lPSdtZW1vcmllc19mdHMnXCIpXG4gICAgICAuZ2V0KCk7XG4gICAgcmV0dXJuICEhcm93O1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuZnVuY3Rpb24gdG9GdHNNYXRjaEV4cHIocXVlcnk6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICAvLyBCdWlsZCBhIHRvbGVyYW50IEFORCBleHByZXNzaW9uOiBxdW90ZSBlYWNoIGJhcmUgdGVybSB3aXRoIGEgdHJhaWxpbmcgKi5cbiAgY29uc3QgdG9rZW5zID0gcXVlcnlcbiAgICAudG9Mb3dlckNhc2UoKVxuICAgIC5zcGxpdCgvW15hLXowLTlfXSsvKVxuICAgIC5maWx0ZXIoKHQpID0+IHQubGVuZ3RoID49IDIpXG4gICAgLnNsaWNlKDAsIDgpO1xuICBpZiAodG9rZW5zLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG4gIHJldHVybiB0b2tlbnMubWFwKCh0KSA9PiBgXCIke3QucmVwbGFjZSgvXCIvZywgJ1wiXCInKX1cIipgKS5qb2luKCcgT1IgJyk7XG59XG5cbmZ1bmN0aW9uIHNlbWFudGljU2VhcmNoKFxuICBhZGFwdGVyOiBOb25OdWxsYWJsZTxSZXR1cm5UeXBlPHR5cGVvZiBfZ2V0QWRhcHRlcj4+LFxuICBxdWVyeVZlY3RvcjogRmxvYXQzMkFycmF5LFxuICBhY3RpdmVDbGF1c2U6IHN0cmluZyxcbiAgbGltaXQ6IG51bWJlcixcbik6IE1lbW9yeVtdIHtcbiAgdHJ5IHtcbiAgICBjb25zdCByb3dzID0gYWRhcHRlclxuICAgICAgLnByZXBhcmUoXG4gICAgICAgIGBTRUxFQ1QgbS4qLCBlLnZlY3RvciBhcyBlbWJlZGRpbmdfdmVjdG9yLCBlLmRpbSBhcyBlbWJlZGRpbmdfZGltXG4gICAgICAgICBGUk9NIG1lbW9yaWVzIG1cbiAgICAgICAgIEpPSU4gbWVtb3J5X2VtYmVkZGluZ3MgZSBPTiBlLm1lbW9yeV9pZCA9IG0uaWRcbiAgICAgICAgICR7YWN0aXZlQ2xhdXNlfWAsXG4gICAgICApXG4gICAgICAuYWxsKCk7XG5cbiAgICBjb25zdCBzY29yZWQ6IEFycmF5PHsgbWVtb3J5OiBNZW1vcnk7IHNpbTogbnVtYmVyIH0+ID0gW107XG4gICAgZm9yIChjb25zdCByb3cgb2Ygcm93cykge1xuICAgICAgY29uc3QgZGltID0gcm93WydlbWJlZGRpbmdfZGltJ10gYXMgbnVtYmVyO1xuICAgICAgaWYgKGRpbSAhPT0gcXVlcnlWZWN0b3IubGVuZ3RoKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IHZlY3RvciA9IHVucGFja1ZlY3Rvcihyb3dbJ2VtYmVkZGluZ192ZWN0b3InXSwgZGltKTtcbiAgICAgIGlmICghdmVjdG9yKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IHNpbSA9IGNvc2luZShxdWVyeVZlY3RvciwgdmVjdG9yKTtcbiAgICAgIGlmIChzaW0gPD0gMCkgY29udGludWU7XG4gICAgICBzY29yZWQucHVzaCh7IG1lbW9yeTogcm93VG9NZW1vcnkocm93KSwgc2ltIH0pO1xuICAgIH1cbiAgICBzY29yZWQuc29ydCgoYSwgYikgPT4gYi5zaW0gLSBhLnNpbSk7XG4gICAgcmV0dXJuIHNjb3JlZC5zbGljZSgwLCBsaW1pdCkubWFwKChzKSA9PiBzLm1lbW9yeSk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBbXTtcbiAgfVxufVxuXG5mdW5jdGlvbiB1bnBhY2tWZWN0b3IoYmxvYjogdW5rbm93biwgZGltOiBudW1iZXIpOiBGbG9hdDMyQXJyYXkgfCBudWxsIHtcbiAgaWYgKCFibG9iKSByZXR1cm4gbnVsbDtcbiAgdHJ5IHtcbiAgICBsZXQgdmlldzogVWludDhBcnJheSB8IG51bGwgPSBudWxsO1xuICAgIGlmIChibG9iIGluc3RhbmNlb2YgRmxvYXQzMkFycmF5KSByZXR1cm4gYmxvYjtcbiAgICBpZiAoYmxvYiBpbnN0YW5jZW9mIFVpbnQ4QXJyYXkpIHZpZXcgPSBibG9iO1xuICAgIGVsc2UgaWYgKGJsb2IgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikgdmlldyA9IG5ldyBVaW50OEFycmF5KGJsb2IpO1xuICAgIGVsc2UgaWYgKChibG9iIGFzIEJ1ZmZlcikuYnVmZmVyICYmIChibG9iIGFzIEJ1ZmZlcikuYnl0ZUxlbmd0aCAhPSBudWxsKSB7XG4gICAgICBjb25zdCBidWYgPSBibG9iIGFzIEJ1ZmZlcjtcbiAgICAgIHZpZXcgPSBuZXcgVWludDhBcnJheShidWYuYnVmZmVyLCBidWYuYnl0ZU9mZnNldCwgYnVmLmJ5dGVMZW5ndGgpO1xuICAgIH0gZWxzZSBpZiAoQXJyYXkuaXNBcnJheShibG9iKSkge1xuICAgICAgcmV0dXJuIG5ldyBGbG9hdDMyQXJyYXkoYmxvYiBhcyBudW1iZXJbXSk7XG4gICAgfVxuICAgIGlmICghdmlldyB8fCB2aWV3LmJ5dGVMZW5ndGggJSA0ICE9PSAwKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCBhbGlnbmVkID0gbmV3IEFycmF5QnVmZmVyKHZpZXcuYnl0ZUxlbmd0aCk7XG4gICAgbmV3IFVpbnQ4QXJyYXkoYWxpZ25lZCkuc2V0KHZpZXcpO1xuICAgIGNvbnN0IGYzMiA9IG5ldyBGbG9hdDMyQXJyYXkoYWxpZ25lZCk7XG4gICAgcmV0dXJuIGYzMi5sZW5ndGggPT09IGRpbSA/IGYzMiA6IG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmZ1bmN0aW9uIGNvc2luZShhOiBGbG9hdDMyQXJyYXksIGI6IEZsb2F0MzJBcnJheSk6IG51bWJlciB7XG4gIGlmIChhLmxlbmd0aCA9PT0gMCB8fCBhLmxlbmd0aCAhPT0gYi5sZW5ndGgpIHJldHVybiAwO1xuICBsZXQgZG90ID0gMDtcbiAgbGV0IG5hID0gMDtcbiAgbGV0IG5iID0gMDtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBhLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgeCA9IGFbaV07XG4gICAgY29uc3QgeSA9IGJbaV07XG4gICAgZG90ICs9IHggKiB5O1xuICAgIG5hICs9IHggKiB4O1xuICAgIG5iICs9IHkgKiB5O1xuICB9XG4gIGlmIChuYSA9PT0gMCB8fCBuYiA9PT0gMCkgcmV0dXJuIDA7XG4gIHJldHVybiBkb3QgLyAoTWF0aC5zcXJ0KG5hKSAqIE1hdGguc3FydChuYikpO1xufVxuXG4vKipcbiAqIEdlbmVyYXRlIHRoZSBuZXh0IG1lbW9yeSBJRDogTUVNICsgemVyby1wYWRkZWQgMy1kaWdpdCBmcm9tIE1BWChzZXEpLlxuICogUmV0dXJucyBNRU0wMDEgaWYgbm8gbWVtb3JpZXMgZXhpc3QuXG4gKlxuICogTk9URTogRm9yIHJhY2Utc2FmZSBjcmVhdGlvbiwgcHJlZmVyIGNyZWF0ZU1lbW9yeSgpIHdoaWNoIGluc2VydHMgd2l0aCBhXG4gKiBwbGFjZWhvbGRlciBJRCB0aGVuIHVwZGF0ZXMgdG8gdGhlIHNlcS1kZXJpdmVkIElEIGF0b21pY2FsbHkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBuZXh0TWVtb3J5SWQoKTogc3RyaW5nIHtcbiAgaWYgKCFpc0RiQXZhaWxhYmxlKCkpIHJldHVybiAnTUVNMDAxJztcbiAgY29uc3QgYWRhcHRlciA9IF9nZXRBZGFwdGVyKCk7XG4gIGlmICghYWRhcHRlcikgcmV0dXJuICdNRU0wMDEnO1xuXG4gIHRyeSB7XG4gICAgY29uc3Qgcm93ID0gYWRhcHRlclxuICAgICAgLnByZXBhcmUoJ1NFTEVDVCBNQVgoc2VxKSBhcyBtYXhfc2VxIEZST00gbWVtb3JpZXMnKVxuICAgICAgLmdldCgpO1xuICAgIGNvbnN0IG1heFNlcSA9IHJvdyA/IChyb3dbJ21heF9zZXEnXSBhcyBudW1iZXIgfCBudWxsKSA6IG51bGw7XG4gICAgaWYgKG1heFNlcSA9PSBudWxsIHx8IGlzTmFOKG1heFNlcSkpIHJldHVybiAnTUVNMDAxJztcbiAgICBjb25zdCBuZXh0ID0gbWF4U2VxICsgMTtcbiAgICByZXR1cm4gYE1FTSR7U3RyaW5nKG5leHQpLnBhZFN0YXJ0KDMsICcwJyl9YDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuICdNRU0wMDEnO1xuICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBNdXRhdGlvbiBGdW5jdGlvbnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogSW5zZXJ0IGEgbmV3IG1lbW9yeSB3aXRoIGEgcmFjZS1zYWZlIGF1dG8tYXNzaWduZWQgSUQuXG4gKiBVc2VzIEFVVE9JTkNSRU1FTlQgc2VxIHRvIGRlcml2ZSB0aGUgSUQgYWZ0ZXIgaW5zZXJ0LCBhdm9pZGluZ1xuICogdGhlIHJlYWQtdGhlbi13cml0ZSByYWNlIGluIGNvbmN1cnJlbnQgc2NlbmFyaW9zIChlLmcuIHdvcmt0cmVlcykuXG4gKiBSZXR1cm5zIHRoZSBhc3NpZ25lZCBJRCwgb3IgbnVsbCB3aGVuIHRoZSBEQiBpcyB1bmF2YWlsYWJsZS5cbiAqXG4gKiBUaHJvd3Mgb24gZ2VudWluZSBTUUwgZXJyb3JzIChjb3JydXB0aW9uLCBtaXNzaW5nIHRhYmxlcywgY29uc3RyYWludFxuICogdmlvbGF0aW9ucykgc28gY2FsbGVycyBjYW4gc3VyZmFjZSB0aGUgdW5kZXJseWluZyBtZXNzYWdlIGluc3RlYWQgb2ZcbiAqIGNvbGxhcHNpbmcgdGhlIGZhaWx1cmUgdG8gYSBnZW5lcmljIFwiY3JlYXRlX2ZhaWxlZFwiLiBTZWUgaXNzdWUgIzQ5NjcgXHUyMDE0XG4gKiB0aGUgcHJldmlvdXMgYmFyZS1jYXRjaCBzd2FsbG93ZWQgXCJkYXRhYmFzZSBkaXNrIGltYWdlIGlzIG1hbGZvcm1lZFwiXG4gKiBlcnJvcnMsIGxlYXZpbmcgdGhlIG1lbW9yeSBzdWJzeXN0ZW0gYnJva2VuIHdpdGhvdXQgYW55IHNpZ25hbC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZU1lbW9yeShmaWVsZHM6IHtcbiAgY2F0ZWdvcnk6IHN0cmluZztcbiAgY29udGVudDogc3RyaW5nO1xuICBjb25maWRlbmNlPzogbnVtYmVyO1xuICBzb3VyY2VfdW5pdF90eXBlPzogc3RyaW5nO1xuICBzb3VyY2VfdW5pdF9pZD86IHN0cmluZztcbiAgc2NvcGU/OiBzdHJpbmc7XG4gIHRhZ3M/OiBzdHJpbmdbXTtcbiAgc3RydWN0dXJlZEZpZWxkcz86IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbDtcbn0pOiBzdHJpbmcgfCBudWxsIHtcbiAgaWYgKCFpc0RiQXZhaWxhYmxlKCkpIHJldHVybiBudWxsO1xuICBjb25zdCBhZGFwdGVyID0gX2dldEFkYXB0ZXIoKTtcbiAgaWYgKCFhZGFwdGVyKSByZXR1cm4gbnVsbDtcblxuICB0cnkge1xuICAgIHJldHVybiB0cmFuc2FjdGlvbigoKSA9PiBkb0NyZWF0ZU1lbW9yeShhZGFwdGVyLCBmaWVsZHMpKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcblxuICAgIC8vIFRhcmdldGVkIHJlY292ZXJ5OiBhIG1hbGZvcm1lZCBtZW1vcnkgc3RvcmUgY2FuIHNvbWV0aW1lcyBiZSByZWJ1aWx0XG4gICAgLy8gYnkgVkFDVVVNLiBTa2lwIHdoZW4gaW5zaWRlIGEgdHJhbnNhY3Rpb24gXHUyMDE0IFNRTGl0ZSByZWZ1c2VzIFZBQ1VVTVxuICAgIC8vIHRoZXJlIGFuZCBhIHNlY29uZGFyeSB0aHJvdyB3b3VsZCBtYXNrIHRoZSByZWFsIGZhdWx0LlxuICAgIGlmIChtZXNzYWdlLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoJ21hbGZvcm1lZCcpICYmICFpc0luVHJhbnNhY3Rpb24oKSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYWRhcHRlci5wcmVwYXJlKCdWQUNVVU0nKS5ydW4oKTtcbiAgICAgICAgY29uc3QgcmVjb3ZlcnlNZXNzYWdlID0gJ3JlY292ZXJlZCBtYWxmb3JtZWQgbWVtb3J5IHN0b3JlIHZpYSBWQUNVVU0nO1xuICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgbWVtb3J5LXN0b3JlOiAke3JlY292ZXJ5TWVzc2FnZX1cXG5gKTtcbiAgICAgICAgbG9nV2FybmluZygnbWVtb3J5LXN0b3JlJywgcmVjb3ZlcnlNZXNzYWdlKTtcbiAgICAgICAgcmV0dXJuIHRyYW5zYWN0aW9uKCgpID0+IGRvQ3JlYXRlTWVtb3J5KGFkYXB0ZXIsIGZpZWxkcykpO1xuICAgICAgfSBjYXRjaCAocmV0cnlFcnIpIHtcbiAgICAgICAgY29uc3QgcmV0cnlNc2cgPSByZXRyeUVyciBpbnN0YW5jZW9mIEVycm9yID8gcmV0cnlFcnIubWVzc2FnZSA6IFN0cmluZyhyZXRyeUVycik7XG4gICAgICAgIGxvZ1dhcm5pbmcoJ21lbW9yeS1zdG9yZScsIGBWQUNVVU0gcmVjb3ZlcnkgZm9yIG1lbW9yeSBzdG9yZSBmYWlsZWQ6ICR7cmV0cnlNc2d9YCk7XG4gICAgICAgIC8vIFN1cmZhY2UgdGhlICpvcmlnaW5hbCogbWFsZm9ybWVkIGVycm9yIFx1MjAxNCBpdCdzIHRoZSBhY3Rpb25hYmxlIHNpZ25hbC5cbiAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgfVxuICAgIH1cblxuICAgIHRocm93IGVycjtcbiAgfVxufVxuXG5mdW5jdGlvbiBkb0NyZWF0ZU1lbW9yeShcbiAgYWRhcHRlcjogTm9uTnVsbGFibGU8UmV0dXJuVHlwZTx0eXBlb2YgX2dldEFkYXB0ZXI+PixcbiAgZmllbGRzOiB7XG4gICAgY2F0ZWdvcnk6IHN0cmluZztcbiAgICBjb250ZW50OiBzdHJpbmc7XG4gICAgY29uZmlkZW5jZT86IG51bWJlcjtcbiAgICBzb3VyY2VfdW5pdF90eXBlPzogc3RyaW5nO1xuICAgIHNvdXJjZV91bml0X2lkPzogc3RyaW5nO1xuICAgIHNjb3BlPzogc3RyaW5nO1xuICAgIHRhZ3M/OiBzdHJpbmdbXTtcbiAgICBzdHJ1Y3R1cmVkRmllbGRzPzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCBudWxsO1xuICB9LFxuKTogc3RyaW5nIHtcbiAgY29uc3Qgbm93ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuICAvLyBJbnNlcnQgd2l0aCBhIHRlbXBvcmFyeSBwbGFjZWhvbGRlciBJRCBcdTIwMTQgc2VxIGlzIGF1dG8tYXNzaWduZWRcbiAgY29uc3QgcGxhY2Vob2xkZXIgPSBgX1RNUF8ke0RhdGUubm93KCl9XyR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgOCl9YDtcbiAgaW5zZXJ0TWVtb3J5Um93KHtcbiAgICBpZDogcGxhY2Vob2xkZXIsXG4gICAgY2F0ZWdvcnk6IGZpZWxkcy5jYXRlZ29yeSxcbiAgICBjb250ZW50OiBmaWVsZHMuY29udGVudCxcbiAgICBjb25maWRlbmNlOiBmaWVsZHMuY29uZmlkZW5jZSA/PyAwLjgsXG4gICAgc291cmNlVW5pdFR5cGU6IGZpZWxkcy5zb3VyY2VfdW5pdF90eXBlID8/IG51bGwsXG4gICAgc291cmNlVW5pdElkOiBmaWVsZHMuc291cmNlX3VuaXRfaWQgPz8gbnVsbCxcbiAgICBjcmVhdGVkQXQ6IG5vdyxcbiAgICB1cGRhdGVkQXQ6IG5vdyxcbiAgICBzY29wZTogZmllbGRzLnNjb3BlID8/ICdwcm9qZWN0JyxcbiAgICB0YWdzOiBmaWVsZHMudGFncyA/PyBbXSxcbiAgICBzdHJ1Y3R1cmVkRmllbGRzOiBmaWVsZHMuc3RydWN0dXJlZEZpZWxkcyA/PyBudWxsLFxuICB9KTtcbiAgLy8gRGVyaXZlIHRoZSByZWFsIElEIGZyb20gdGhlIGFzc2lnbmVkIHNlcSAoU0VMRUNUIGlzIHN0aWxsIGZpbmUgdmlhIGFkYXB0ZXIpXG4gIGNvbnN0IHJvdyA9IGFkYXB0ZXIucHJlcGFyZSgnU0VMRUNUIHNlcSBGUk9NIG1lbW9yaWVzIFdIRVJFIGlkID0gOmlkJykuZ2V0KHsgJzppZCc6IHBsYWNlaG9sZGVyIH0pO1xuICBpZiAoIXJvdykgcmV0dXJuIHBsYWNlaG9sZGVyOyAvLyBmYWxsYmFjayBcdTIwMTQgc2hvdWxkIG5vdCBoYXBwZW5cbiAgY29uc3Qgc2VxID0gcm93WydzZXEnXSBhcyBudW1iZXI7XG4gIGNvbnN0IHJlYWxJZCA9IGBNRU0ke1N0cmluZyhzZXEpLnBhZFN0YXJ0KDMsICcwJyl9YDtcbiAgcmV3cml0ZU1lbW9yeUlkKHBsYWNlaG9sZGVyLCByZWFsSWQpO1xuICByZXR1cm4gcmVhbElkO1xufVxuXG4vKipcbiAqIFVwZGF0ZSBhIG1lbW9yeSdzIGNvbnRlbnQgYW5kIG9wdGlvbmFsbHkgaXRzIGNvbmZpZGVuY2UuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVNZW1vcnlDb250ZW50KGlkOiBzdHJpbmcsIGNvbnRlbnQ6IHN0cmluZywgY29uZmlkZW5jZT86IG51bWJlcik6IGJvb2xlYW4ge1xuICBpZiAoIWlzRGJBdmFpbGFibGUoKSkgcmV0dXJuIGZhbHNlO1xuXG4gIHRyeSB7XG4gICAgdXBkYXRlTWVtb3J5Q29udGVudFJvdyhpZCwgY29udGVudCwgY29uZmlkZW5jZSwgbmV3IERhdGUoKS50b0lTT1N0cmluZygpKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbi8qKlxuICogUmVpbmZvcmNlIGEgbWVtb3J5OiBpbmNyZW1lbnQgaGl0X2NvdW50LCB1cGRhdGUgdGltZXN0YW1wLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVpbmZvcmNlTWVtb3J5KGlkOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgaWYgKCFpc0RiQXZhaWxhYmxlKCkpIHJldHVybiBmYWxzZTtcblxuICB0cnkge1xuICAgIGluY3JlbWVudE1lbW9yeUhpdENvdW50KGlkLCBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkpO1xuICAgIHJldHVybiB0cnVlO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuLyoqXG4gKiBNYXJrIGEgbWVtb3J5IGFzIHN1cGVyc2VkZWQgYnkgYW5vdGhlci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN1cGVyc2VkZU1lbW9yeShvbGRJZDogc3RyaW5nLCBuZXdJZDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGlmICghaXNEYkF2YWlsYWJsZSgpKSByZXR1cm4gZmFsc2U7XG5cbiAgdHJ5IHtcbiAgICBzdXBlcnNlZGVNZW1vcnlSb3cob2xkSWQsIG5ld0lkLCBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkpO1xuICAgIHJldHVybiB0cnVlO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFByb2Nlc3NlZCBVbml0IFRyYWNraW5nIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIENoZWNrIGlmIGEgdW5pdCBoYXMgYWxyZWFkeSBiZWVuIHByb2Nlc3NlZCBmb3IgbWVtb3J5IGV4dHJhY3Rpb24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc1VuaXRQcm9jZXNzZWQodW5pdEtleTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGlmICghaXNEYkF2YWlsYWJsZSgpKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGFkYXB0ZXIgPSBfZ2V0QWRhcHRlcigpO1xuICBpZiAoIWFkYXB0ZXIpIHJldHVybiBmYWxzZTtcblxuICB0cnkge1xuICAgIGNvbnN0IHJvdyA9IGFkYXB0ZXIucHJlcGFyZShcbiAgICAgICdTRUxFQ1QgMSBGUk9NIG1lbW9yeV9wcm9jZXNzZWRfdW5pdHMgV0hFUkUgdW5pdF9rZXkgPSA6a2V5JyxcbiAgICApLmdldCh7ICc6a2V5JzogdW5pdEtleSB9KTtcbiAgICByZXR1cm4gcm93ICE9IG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuXG4vKipcbiAqIFJlY29yZCB0aGF0IGEgdW5pdCBoYXMgYmVlbiBwcm9jZXNzZWQgZm9yIG1lbW9yeSBleHRyYWN0aW9uLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbWFya1VuaXRQcm9jZXNzZWQodW5pdEtleTogc3RyaW5nLCBhY3Rpdml0eUZpbGU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBpZiAoIWlzRGJBdmFpbGFibGUoKSkgcmV0dXJuIGZhbHNlO1xuXG4gIHRyeSB7XG4gICAgbWFya01lbW9yeVVuaXRQcm9jZXNzZWQodW5pdEtleSwgYWN0aXZpdHlGaWxlLCBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkpO1xuICAgIHJldHVybiB0cnVlO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIE1haW50ZW5hbmNlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFJlZHVjZSBjb25maWRlbmNlIGZvciBtZW1vcmllcyBub3QgdXBkYXRlZCB3aXRoaW4gdGhlIGxhc3QgTiBwcm9jZXNzZWQgdW5pdHMuXG4gKiBcIlN0YWxlXCIgPSB1cGRhdGVkX2F0IGlzIG9sZGVyIHRoYW4gdGhlIE50aCBtb3N0IHJlY2VudCBwcm9jZXNzZWRfYXQuXG4gKiBSZXR1cm5zIHRoZSBudW1iZXIgb2YgZGVjYXllZCBtZW1vcnkgSURzIGZvciBvYnNlcnZhYmlsaXR5LlxuICovXG5leHBvcnQgZnVuY3Rpb24gZGVjYXlTdGFsZU1lbW9yaWVzKHRocmVzaG9sZFVuaXRzID0gMjApOiBzdHJpbmdbXSB7XG4gIGlmICghaXNEYkF2YWlsYWJsZSgpKSByZXR1cm4gW107XG4gIGNvbnN0IGFkYXB0ZXIgPSBfZ2V0QWRhcHRlcigpO1xuICBpZiAoIWFkYXB0ZXIpIHJldHVybiBbXTtcblxuICB0cnkge1xuICAgIC8vIEZpbmQgdGhlIHRpbWVzdGFtcCBvZiB0aGUgTnRoIG1vc3QgcmVjZW50IHByb2Nlc3NlZCB1bml0IChyZWFkLW9ubHkgU0VMRUNUKVxuICAgIGNvbnN0IHJvdyA9IGFkYXB0ZXIucHJlcGFyZShcbiAgICAgIGBTRUxFQ1QgcHJvY2Vzc2VkX2F0IEZST00gbWVtb3J5X3Byb2Nlc3NlZF91bml0c1xuICAgICAgIE9SREVSIEJZIHByb2Nlc3NlZF9hdCBERVNDXG4gICAgICAgTElNSVQgMSBPRkZTRVQgOm9mZnNldGAsXG4gICAgKS5nZXQoeyAnOm9mZnNldCc6IHRocmVzaG9sZFVuaXRzIC0gMSB9KTtcblxuICAgIGlmICghcm93KSByZXR1cm4gW107IC8vIG5vdCBlbm91Z2ggcHJvY2Vzc2VkIHVuaXRzIHlldFxuXG4gICAgY29uc3QgY3V0b2ZmID0gcm93Wydwcm9jZXNzZWRfYXQnXSBhcyBzdHJpbmc7XG4gICAgY29uc3QgYWZmZWN0ZWQgPSBhZGFwdGVyLnByZXBhcmUoXG4gICAgICBgU0VMRUNUIGlkIEZST00gbWVtb3JpZXNcbiAgICAgICBXSEVSRSBzdXBlcnNlZGVkX2J5IElTIE5VTEwgQU5EIHVwZGF0ZWRfYXQgPCA6Y3V0b2ZmIEFORCBjb25maWRlbmNlID4gMC4xYCxcbiAgICApLmFsbCh7ICc6Y3V0b2ZmJzogY3V0b2ZmIH0pLm1hcCgocikgPT4gclsnaWQnXSBhcyBzdHJpbmcpO1xuXG4gICAgZGVjYXlNZW1vcmllc0JlZm9yZShjdXRvZmYsIG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSk7XG4gICAgcmV0dXJuIGFmZmVjdGVkO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gW107XG4gIH1cbn1cblxuLyoqXG4gKiBTdXBlcnNlZGUgbG93ZXN0LXJhbmtlZCBtZW1vcmllcyB3aGVuIGNvdW50IGV4Y2VlZHMgY2FwLiBDYXNjYWRlcyB0byB0aGVcbiAqIGVtYmVkZGluZyBhbmQgcmVsYXRpb24gcm93cyBzbyB0aG9zZSB0YWJsZXMgZG9uJ3QgZ3JvdyB1bmJvdW5kZWRseS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVuZm9yY2VNZW1vcnlDYXAobWF4ID0gNTApOiB2b2lkIHtcbiAgaWYgKCFpc0RiQXZhaWxhYmxlKCkpIHJldHVybjtcbiAgY29uc3QgYWRhcHRlciA9IF9nZXRBZGFwdGVyKCk7XG4gIGlmICghYWRhcHRlcikgcmV0dXJuO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgY291bnRSb3cgPSBhZGFwdGVyLnByZXBhcmUoXG4gICAgICAnU0VMRUNUIGNvdW50KCopIGFzIGNudCBGUk9NIG1lbW9yaWVzIFdIRVJFIHN1cGVyc2VkZWRfYnkgSVMgTlVMTCcsXG4gICAgKS5nZXQoKTtcbiAgICBjb25zdCBjb3VudCA9IChjb3VudFJvdz8uWydjbnQnXSBhcyBudW1iZXIpID8/IDA7XG4gICAgaWYgKGNvdW50IDw9IG1heCkgcmV0dXJuO1xuXG4gICAgY29uc3QgZXhjZXNzID0gY291bnQgLSBtYXg7XG4gICAgLy8gQ2FwdHVyZSB0aGUgYWJvdXQtdG8tYmUtc3VwZXJzZWRlZCBJRHMgZmlyc3Qgc28gd2UgY2FuIGNhc2NhZGUgY2xlYW51cC5cbiAgICBjb25zdCB2aWN0aW1zID0gYWRhcHRlci5wcmVwYXJlKFxuICAgICAgYFNFTEVDVCBpZCBGUk9NIG1lbW9yaWVzXG4gICAgICAgV0hFUkUgc3VwZXJzZWRlZF9ieSBJUyBOVUxMXG4gICAgICAgT1JERVIgQlkgKGNvbmZpZGVuY2UgKiAoMS4wICsgaGl0X2NvdW50ICogMC4xKSkgQVNDXG4gICAgICAgTElNSVQgOmxpbWl0YCxcbiAgICApLmFsbCh7ICc6bGltaXQnOiBleGNlc3MgfSkubWFwKChyb3cpID0+IHJvd1snaWQnXSBhcyBzdHJpbmcpO1xuXG4gICAgc3VwZXJzZWRlTG93ZXN0UmFua2VkTWVtb3JpZXMoZXhjZXNzLCBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkpO1xuXG4gICAgaWYgKHZpY3RpbXMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgZm9yIChjb25zdCBpZCBvZiB2aWN0aW1zKSB7XG4gICAgICB0cnkgeyBkZWxldGVNZW1vcnlFbWJlZGRpbmcoaWQpOyB9IGNhdGNoIHsgLyogbm9uLWZhdGFsICovIH1cbiAgICAgIHRyeSB7IGRlbGV0ZU1lbW9yeVJlbGF0aW9uc0ZvcihpZCk7IH0gY2F0Y2ggeyAvKiBub24tZmF0YWwgKi8gfVxuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gbm9uLWZhdGFsXG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEFjdGlvbiBBcHBsaWNhdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBQcm9jZXNzIGFuIGFycmF5IG9mIG1lbW9yeSBhY3Rpb25zIGluIGEgdHJhbnNhY3Rpb24uXG4gKiBDYWxscyBlbmZvcmNlTWVtb3J5Q2FwIGF0IHRoZSBlbmQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhcHBseU1lbW9yeUFjdGlvbnMoXG4gIGFjdGlvbnM6IE1lbW9yeUFjdGlvbltdLFxuICB1bml0VHlwZT86IHN0cmluZyxcbiAgdW5pdElkPzogc3RyaW5nLFxuKTogdm9pZCB7XG4gIGlmICghaXNEYkF2YWlsYWJsZSgpIHx8IGFjdGlvbnMubGVuZ3RoID09PSAwKSByZXR1cm47XG5cbiAgdHJ5IHtcbiAgICB0cmFuc2FjdGlvbigoKSA9PiB7XG4gICAgICBmb3IgKGNvbnN0IGFjdGlvbiBvZiBhY3Rpb25zKSB7XG4gICAgICAgIHN3aXRjaCAoYWN0aW9uLmFjdGlvbikge1xuICAgICAgICAgIGNhc2UgJ0NSRUFURSc6XG4gICAgICAgICAgICBjcmVhdGVNZW1vcnkoe1xuICAgICAgICAgICAgICBjYXRlZ29yeTogYWN0aW9uLmNhdGVnb3J5LFxuICAgICAgICAgICAgICBjb250ZW50OiBhY3Rpb24uY29udGVudCxcbiAgICAgICAgICAgICAgY29uZmlkZW5jZTogYWN0aW9uLmNvbmZpZGVuY2UsXG4gICAgICAgICAgICAgIHNvdXJjZV91bml0X3R5cGU6IHVuaXRUeXBlLFxuICAgICAgICAgICAgICBzb3VyY2VfdW5pdF9pZDogdW5pdElkLFxuICAgICAgICAgICAgICBzY29wZTogYWN0aW9uLnNjb3BlLFxuICAgICAgICAgICAgICB0YWdzOiBhY3Rpb24udGFncyxcbiAgICAgICAgICAgICAgLy8gQURSLTAxMzogZm9yd2FyZCBzdHJ1Y3R1cmVkIHBheWxvYWQgdGhyb3VnaCB0aGUgYWN0aW9uIGxheWVyIHNvXG4gICAgICAgICAgICAgIC8vIGJ1bGsgYXBwbHlNZW1vcnlBY3Rpb25zIGNhbGxlcnMgKGV4dHJhY3Rpb24sIGluZ2VzdGlvbikgZG9uJ3RcbiAgICAgICAgICAgICAgLy8gc2lsZW50bHkgZHJvcCBpdC5cbiAgICAgICAgICAgICAgc3RydWN0dXJlZEZpZWxkczogYWN0aW9uLnN0cnVjdHVyZWRGaWVsZHMgPz8gbnVsbCxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgY2FzZSAnVVBEQVRFJzpcbiAgICAgICAgICAgIHVwZGF0ZU1lbW9yeUNvbnRlbnQoYWN0aW9uLmlkLCBhY3Rpb24uY29udGVudCwgYWN0aW9uLmNvbmZpZGVuY2UpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgY2FzZSAnUkVJTkZPUkNFJzpcbiAgICAgICAgICAgIHJlaW5mb3JjZU1lbW9yeShhY3Rpb24uaWQpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgY2FzZSAnU1VQRVJTRURFJzpcbiAgICAgICAgICAgIHN1cGVyc2VkZU1lbW9yeShhY3Rpb24uaWQsIGFjdGlvbi5zdXBlcnNlZGVkX2J5KTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIGNhc2UgJ0xJTksnOlxuICAgICAgICAgICAgYXBwbHlMaW5rQWN0aW9uKGFjdGlvbik7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgZW5mb3JjZU1lbW9yeUNhcCgpO1xuICAgIH0pO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICAvLyBOb24tZmF0YWwgXHUyMDE0IHRoZSB0cmFuc2FjdGlvbiBoYXMgcm9sbGVkIGJhY2suIFdlIGxvZyBhIHdhcm5pbmcgc28gYVxuICAgIC8vIGRlZ3JhZGVkIG1lbW9yeSBzdWJzeXN0ZW0gKGUuZy4gbWFsZm9ybWVkIHN0b3JlLCBtaXNzaW5nIHRhYmxlcykgaXNcbiAgICAvLyB2aXNpYmxlIHRvIGZvcmVuc2ljcyBpbnN0ZWFkIG9mIHNpbGVudGx5IGRyb3BwaW5nIGV2ZXJ5IENSRUFURSBcdTIwMTQgc2VlXG4gICAgLy8gaXNzdWUgIzQ5NjcsIHdoZXJlIHRoaXMgc3dhbGxvdyBjb21iaW5lZCB3aXRoIGNyZWF0ZU1lbW9yeSdzIGJhcmVcbiAgICAvLyBjYXRjaCBoaWQgU1FMaXRlIGNvcnJ1cHRpb24gZnJvbSB0aGUgYXV0by1tb2RlIGZsb3cgZW50aXJlbHkuXG4gICAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICBsb2dXYXJuaW5nKFxuICAgICAgJ21lbW9yeS1zdG9yZScsXG4gICAgICBgYXBwbHlNZW1vcnlBY3Rpb25zIGZhaWxlZCAobWVtb3J5IHN1YnN5c3RlbSBkZWdyYWRlZCk6ICR7bWVzc2FnZX1gLFxuICAgICk7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIExJTksgYWN0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBhcHBseUxpbmtBY3Rpb24oYWN0aW9uOiBNZW1vcnlBY3Rpb25MaW5rKTogdm9pZCB7XG4gIHRyeSB7XG4gICAgaWYgKCFpc1ZhbGlkUmVsYXRpb24oYWN0aW9uLnJlbCkpIHJldHVybjtcbiAgICBjcmVhdGVNZW1vcnlSZWxhdGlvbihhY3Rpb24uZnJvbSwgYWN0aW9uLnRvLCBhY3Rpb24ucmVsLCBhY3Rpb24uY29uZmlkZW5jZSk7XG4gIH0gY2F0Y2gge1xuICAgIC8vIExpbmsgZmFpbHVyZXMgc2hvdWxkIG5ldmVyIGJyZWFrIG1lbW9yeSBleHRyYWN0aW9uLlxuICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBQcm9tcHQgRm9ybWF0dGluZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBGb3JtYXQgbWVtb3JpZXMgYXMgY2F0ZWdvcml6ZWQgbWFya2Rvd24gZm9yIHN5c3RlbSBwcm9tcHQgaW5qZWN0aW9uLlxuICogVHJ1bmNhdGVzIHRvIHRva2VuIGJ1ZGdldCAofjQgY2hhcnMgcGVyIHRva2VuKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdE1lbW9yaWVzRm9yUHJvbXB0KG1lbW9yaWVzOiBNZW1vcnlbXSwgdG9rZW5CdWRnZXQgPSAyMDAwKTogc3RyaW5nIHtcbiAgaWYgKG1lbW9yaWVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuICcnO1xuXG4gIGNvbnN0IGNoYXJCdWRnZXQgPSB0b2tlbkJ1ZGdldCAqIDQ7XG4gIGNvbnN0IGhlYWRlciA9ICcjIyBQcm9qZWN0IE1lbW9yeSAoYXV0by1sZWFybmVkKVxcbic7XG4gIGxldCBvdXRwdXQgPSBoZWFkZXI7XG4gIGxldCByZW1haW5pbmcgPSBjaGFyQnVkZ2V0IC0gaGVhZGVyLmxlbmd0aDtcblxuICAvLyBHcm91cCBieSBjYXRlZ29yeVxuICBjb25zdCBncm91cGVkID0gbmV3IE1hcDxzdHJpbmcsIE1lbW9yeVtdPigpO1xuICBmb3IgKGNvbnN0IG0gb2YgbWVtb3JpZXMpIHtcbiAgICBjb25zdCBsaXN0ID0gZ3JvdXBlZC5nZXQobS5jYXRlZ29yeSkgPz8gW107XG4gICAgbGlzdC5wdXNoKG0pO1xuICAgIGdyb3VwZWQuc2V0KG0uY2F0ZWdvcnksIGxpc3QpO1xuICB9XG5cbiAgLy8gU29ydCBjYXRlZ29yaWVzIGJ5IHByaW9yaXR5XG4gIGNvbnN0IHNvcnRlZENhdGVnb3JpZXMgPSBbLi4uZ3JvdXBlZC5rZXlzKCldLnNvcnQoXG4gICAgKGEsIGIpID0+IChDQVRFR09SWV9QUklPUklUWVthXSA/PyA5OSkgLSAoQ0FURUdPUllfUFJJT1JJVFlbYl0gPz8gOTkpLFxuICApO1xuXG4gIGZvciAoY29uc3QgY2F0ZWdvcnkgb2Ygc29ydGVkQ2F0ZWdvcmllcykge1xuICAgIGNvbnN0IGl0ZW1zID0gZ3JvdXBlZC5nZXQoY2F0ZWdvcnkpITtcbiAgICBjb25zdCBjYXRIZWFkZXIgPSBgXFxuIyMjICR7Y2F0ZWdvcnkuY2hhckF0KDApLnRvVXBwZXJDYXNlKCkgKyBjYXRlZ29yeS5zbGljZSgxKX1cXG5gO1xuXG4gICAgaWYgKHJlbWFpbmluZyA8IGNhdEhlYWRlci5sZW5ndGggKyAxMCkgYnJlYWs7XG4gICAgb3V0cHV0ICs9IGNhdEhlYWRlcjtcbiAgICByZW1haW5pbmcgLT0gY2F0SGVhZGVyLmxlbmd0aDtcblxuICAgIGZvciAoY29uc3QgaXRlbSBvZiBpdGVtcykge1xuICAgICAgY29uc3QgYnVsbGV0ID0gYC0gJHtpdGVtLmNvbnRlbnR9XFxuYDtcbiAgICAgIGlmIChyZW1haW5pbmcgPCBidWxsZXQubGVuZ3RoKSBicmVhaztcbiAgICAgIG91dHB1dCArPSBidWxsZXQ7XG4gICAgICByZW1haW5pbmcgLT0gYnVsbGV0Lmxlbmd0aDtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gb3V0cHV0LnRyaW1FbmQoKTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUtBO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNB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QUFNO0FBQ3RCO0FBQUEsUUFDSjtBQUFBLE1BQ0Y7QUFDQSx1QkFBaUI7QUFBQSxJQUNuQixDQUFDO0FBQUEsRUFDSCxTQUFTLEtBQUs7QUFNWixVQUFNLFVBQVUsZUFBZSxRQUFRLElBQUksVUFBVSxPQUFPLEdBQUc7QUFDL0Q7QUFBQSxNQUNFO0FBQUEsTUFDQSwwREFBMEQsT0FBTztBQUFBLElBQ25FO0FBQUEsRUFDRjtBQUNGO0FBSUEsU0FBUyxnQkFBZ0IsUUFBZ0M7QUFDdkQsTUFBSTtBQUNGLFFBQUksQ0FBQyxnQkFBZ0IsT0FBTyxHQUFHLEVBQUc7QUFDbEMseUJBQXFCLE9BQU8sTUFBTSxPQUFPLElBQUksT0FBTyxLQUFLLE9BQU8sVUFBVTtBQUFBLEVBQzVFLFFBQVE7QUFBQSxFQUVSO0FBQ0Y7QUFRTyxTQUFTLHdCQUF3QixVQUFvQixjQUFjLEtBQWM7QUFDdEYsTUFBSSxTQUFTLFdBQVcsRUFBRyxRQUFPO0FBRWxDLFFBQU0sYUFBYSxjQUFjO0FBQ2pDLFFBQU0sU0FBUztBQUNmLE1BQUksU0FBUztBQUNiLE1BQUksWUFBWSxhQUFhLE9BQU87QUFHcEMsUUFBTSxVQUFVLG9CQUFJLElBQXNCO0FBQzFDLGFBQVcsS0FBSyxVQUFVO0FBQ3hCLFVBQU0sT0FBTyxRQUFRLElBQUksRUFBRSxRQUFRLEtBQUssQ0FBQztBQUN6QyxTQUFLLEtBQUssQ0FBQztBQUNYLFlBQVEsSUFBSSxFQUFFLFVBQVUsSUFBSTtBQUFBLEVBQzlCO0FBR0EsUUFBTSxtQkFBbUIsQ0FBQyxHQUFHLFFBQVEsS0FBSyxDQUFDLEVBQUU7QUFBQSxJQUMzQyxDQUFDLEdBQUcsT0FBTyxrQkFBa0IsQ0FBQyxLQUFLLE9BQU8sa0JBQWtCLENBQUMsS0FBSztBQUFBLEVBQ3BFO0FBRUEsYUFBVyxZQUFZLGtCQUFrQjtBQUN2QyxVQUFNLFFBQVEsUUFBUSxJQUFJLFFBQVE7QUFDbEMsVUFBTSxZQUFZO0FBQUEsTUFBUyxTQUFTLE9BQU8sQ0FBQyxFQUFFLFlBQVksSUFBSSxTQUFTLE1BQU0sQ0FBQyxDQUFDO0FBQUE7QUFFL0UsUUFBSSxZQUFZLFVBQVUsU0FBUyxHQUFJO0FBQ3ZDLGNBQVU7QUFDVixpQkFBYSxVQUFVO0FBRXZCLGVBQVcsUUFBUSxPQUFPO0FBQ3hCLFlBQU0sU0FBUyxLQUFLLEtBQUssT0FBTztBQUFBO0FBQ2hDLFVBQUksWUFBWSxPQUFPLE9BQVE7QUFDL0IsZ0JBQVU7QUFDVixtQkFBYSxPQUFPO0FBQUEsSUFDdEI7QUFBQSxFQUNGO0FBRUEsU0FBTyxPQUFPLFFBQVE7QUFDeEI7IiwKICAibmFtZXMiOiBbInJhbmtlZCIsICJyb3dzIl0KfQo=
