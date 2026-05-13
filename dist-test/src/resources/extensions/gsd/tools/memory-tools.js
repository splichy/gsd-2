import { _getAdapter, isDbAvailable } from "../gsd-db.js";
import {
  createMemory,
  getActiveMemoriesRanked,
  queryMemoriesRanked,
  reinforceMemory
} from "../memory-store.js";
import { traverseGraph } from "../memory-relations.js";
function dbUnavailable(operation) {
  return {
    content: [
      {
        type: "text",
        text: "Error: GSD database is not available. Memory tools require an initialized .gsd/ project."
      }
    ],
    details: { operation, error: "db_unavailable" },
    isError: true
  };
}
const VALID_CATEGORIES = /* @__PURE__ */ new Set([
  "architecture",
  "convention",
  "gotcha",
  "preference",
  "environment",
  "pattern"
]);
function executeMemoryCapture(params) {
  if (!isDbAvailable()) return dbUnavailable("memory_capture");
  const category = (params.category ?? "").trim().toLowerCase();
  const content = (params.content ?? "").trim();
  if (!category || !content) {
    return {
      content: [{ type: "text", text: "Error: category and content are required." }],
      details: { operation: "memory_capture", error: "missing_fields" },
      isError: true
    };
  }
  if (!VALID_CATEGORIES.has(category)) {
    return {
      content: [
        {
          type: "text",
          text: `Error: invalid category "${category}". Must be one of: ${[...VALID_CATEGORIES].join(", ")}.`
        }
      ],
      details: { operation: "memory_capture", error: "invalid_category" },
      isError: true
    };
  }
  const confidence = clampConfidence(params.confidence);
  const scope = normalizeScope(params.scope);
  const tags = normalizeTags(params.tags);
  const structuredFields = normalizeStructuredFields(params.structuredFields);
  let id;
  try {
    id = createMemory({ category, content, confidence, scope, tags, structuredFields });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: failed to create memory: ${message}` }],
      details: { operation: "memory_capture", error: message },
      isError: true
    };
  }
  if (!id) {
    return {
      content: [{ type: "text", text: "Error: failed to create memory." }],
      details: { operation: "memory_capture", error: "create_failed" },
      isError: true
    };
  }
  return {
    content: [{ type: "text", text: `Captured ${id} (${category}): ${content}` }],
    details: { operation: "memory_capture", id, category, confidence, scope, tags }
  };
}
function normalizeScope(value) {
  if (typeof value !== "string") return "project";
  const trimmed = value.trim();
  return trimmed.length === 0 ? "project" : trimmed;
}
function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((t) => typeof t === "string" && t.trim().length > 0).slice(0, 10);
}
function normalizeStructuredFields(value) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return null;
  return value;
}
function clampConfidence(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.8;
  if (value < 0.1) return 0.1;
  if (value > 0.99) return 0.99;
  return value;
}
function executeMemoryQuery(params) {
  if (!isDbAvailable()) return dbUnavailable("memory_query");
  const query = (params.query ?? "").trim();
  const k = clampTopK(params.k, 10);
  const includeSuperseded = params.include_superseded === true;
  const category = params.category?.trim().toLowerCase() || void 0;
  const scopeFilter = params.scope?.trim() || void 0;
  const tagFilter = params.tag?.trim().toLowerCase() || void 0;
  try {
    let ranked = [];
    if (query) {
      ranked = queryMemoriesRanked({
        query,
        k,
        category,
        scope: scopeFilter,
        tag: tagFilter,
        include_superseded: includeSuperseded
      });
    } else {
      const candidates = includeSuperseded ? includeSupersededMemories(getActiveMemoriesRanked(200)) : getActiveMemoriesRanked(200);
      ranked = candidates.filter((m) => {
        if (category && m.category.toLowerCase() !== category) return false;
        if (scopeFilter && m.scope !== scopeFilter) return false;
        if (tagFilter && !m.tags.map((t) => t.toLowerCase()).includes(tagFilter)) return false;
        return true;
      }).slice(0, k).map((memory) => ({
        memory,
        score: memory.confidence * (1 + memory.hit_count * 0.1),
        keywordRank: null,
        semanticRank: null,
        confidenceBoost: memory.confidence * (1 + memory.hit_count * 0.1),
        reason: "ranked"
      }));
    }
    const hits = ranked.map((r) => ({
      id: r.memory.id,
      category: r.memory.category,
      content: r.memory.content,
      confidence: r.memory.confidence,
      hit_count: r.memory.hit_count,
      score: r.score,
      reason: r.reason,
      keyword_rank: r.keywordRank,
      semantic_rank: r.semanticRank
    }));
    if (params.reinforce_hits) {
      for (const h of hits) reinforceMemory(h.id);
    }
    const summary = hits.length === 0 ? "No matching memories." : hits.map((h) => `- [${h.id}] (${h.category}) ${h.content}`).join("\n");
    return {
      content: [{ type: "text", text: summary }],
      details: {
        operation: "memory_query",
        query,
        k,
        returned: hits.length,
        hits
      }
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: memory query failed: ${err.message}` }],
      details: { operation: "memory_query", error: err.message },
      isError: true
    };
  }
}
function clampTopK(value, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < 1) return 1;
  if (value > 50) return 50;
  return Math.floor(value);
}
function includeSupersededMemories(rankedActive) {
  const adapter = _getAdapter();
  if (!adapter) return rankedActive;
  try {
    const rows = adapter.prepare("SELECT * FROM memories").all();
    return rows.map((row) => {
      let tags = [];
      if (typeof row["tags"] === "string") {
        try {
          const parsed = JSON.parse(row["tags"]);
          if (Array.isArray(parsed)) tags = parsed.filter((t) => typeof t === "string");
        } catch {
        }
      }
      let structuredFields = null;
      if (typeof row["structured_fields"] === "string" && row["structured_fields"].length > 0) {
        try {
          const parsed = JSON.parse(row["structured_fields"]);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            structuredFields = parsed;
          }
        } catch {
        }
      }
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
        tags,
        structured_fields: structuredFields,
        last_hit_at: row["last_hit_at"] ?? null
      };
    });
  } catch {
    return rankedActive;
  }
}
function executeGsdGraph(params) {
  if (!isDbAvailable()) return dbUnavailable("gsd_graph");
  if (params.mode === "build") {
    return {
      content: [
        {
          type: "text",
          text: "gsd_graph build acknowledged. Graph edges are populated incrementally by memory extraction (including LINK actions). Use `/gsd memory extract <SRC-...>` to trigger extraction against a specific ingested source."
        }
      ],
      details: { operation: "gsd_graph", mode: "build", built: 0 }
    };
  }
  if (params.mode !== "query") {
    return {
      content: [{ type: "text", text: `Error: unknown mode "${params.mode}". Must be "build" or "query".` }],
      details: { operation: "gsd_graph", error: "invalid_mode" },
      isError: true
    };
  }
  const memoryId = params.memoryId?.trim();
  if (!memoryId) {
    return {
      content: [{ type: "text", text: "Error: memoryId is required for mode=query." }],
      details: { operation: "gsd_graph", error: "missing_memory_id" },
      isError: true
    };
  }
  try {
    const graph = traverseGraph(memoryId, clampDepth(params.depth));
    const rel = params.rel?.trim().toLowerCase() || null;
    const edges = rel ? graph.edges.filter((e) => e.rel === rel) : graph.edges;
    const relevantIds = /* @__PURE__ */ new Set([memoryId]);
    for (const e of edges) {
      relevantIds.add(e.from);
      relevantIds.add(e.to);
    }
    const nodes = graph.nodes.filter((n) => relevantIds.has(n.id));
    if (nodes.length === 0) {
      return {
        content: [{ type: "text", text: `No memory found with id ${memoryId}.` }],
        details: { operation: "gsd_graph", mode: "query", memoryId, nodes: [], edges: [] }
      };
    }
    const summary = [
      `Memory ${memoryId} \u2014 ${nodes.length} node(s), ${edges.length} edge(s).`,
      ...nodes.map((n) => `  [${n.id}] (${n.category}) ${n.content}`),
      ...edges.map((e) => `  ${e.from} --${e.rel}-> ${e.to}`)
    ].join("\n");
    return {
      content: [{ type: "text", text: summary }],
      details: {
        operation: "gsd_graph",
        mode: "query",
        memoryId,
        nodes: nodes.map((n) => ({ id: n.id, category: n.category, content: n.content })),
        edges: edges.map((e) => ({ from: e.from, to: e.to, rel: e.rel }))
      }
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: graph query failed: ${err.message}` }],
      details: { operation: "gsd_graph", error: err.message },
      isError: true
    };
  }
}
function clampDepth(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  if (value < 0) return 0;
  if (value > 5) return 5;
  return Math.floor(value);
}
export {
  executeGsdGraph,
  executeMemoryCapture,
  executeMemoryQuery
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90b29scy9tZW1vcnktdG9vbHMudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRCBNZW1vcnkgVG9vbHMgXHUyMDE0IFBoYXNlIDEgZXhlY3V0b3JzIGZvciBjYXB0dXJlX3Rob3VnaHQsIG1lbW9yeV9xdWVyeSwgZ3NkX2dyYXBoXG4vL1xuLy8gVGhlc2UgZXhlY3V0b3JzIGJhY2sgdGhlIHRocmVlIG1lbW9yeS1sYXllciB0b29scyB0aGUgTExNIGNhbiBjYWxsIGF0IGFueVxuLy8gcG9pbnQgaW4gYSBzZXNzaW9uLiBUaGV5IGJ1aWxkIG9uIHRoZSBleGlzdGluZyBgbWVtb3J5LXN0b3JlLnRzYCBsYXllclxuLy8gKFNRTGl0ZSBtZW1vcmllcyB0YWJsZSkgYW5kIGRlZ3JhZGUgZ3JhY2VmdWxseSB3aGVuIHRoZSBEQiBpcyB1bmF2YWlsYWJsZS5cbi8vXG4vLyBQaGFzZSAxIHNjb3BlOlxuLy8gICAtIGNhcHR1cmVfdGhvdWdodCBcdTIxOTIgY3JlYXRlIGEgbWVtb3J5IHdpdGggdGhlIGNhbGxlci1zdXBwbGllZCBjYXRlZ29yeS9jb250ZW50XG4vLyAgIC0gbWVtb3J5X3F1ZXJ5ICAgIFx1MjE5MiBrZXl3b3JkLWZpbHRlcmVkLCBzY29yZS1yYW5rZWQgbGlzdGluZyBvZiBhY3RpdmUgbWVtb3JpZXNcbi8vICAgLSBnc2RfZ3JhcGggICAgICAgXHUyMTkyIHJldHVybnMgYSBtZW1vcnkgYW5kIGl0cyBzdXBlcnNlZGVzIGVkZ2VzIG9ubHkgKFBoYXNlIDQgYWRkcyBtZW1vcnlfcmVsYXRpb25zKVxuXG5pbXBvcnQgeyBfZ2V0QWRhcHRlciwgaXNEYkF2YWlsYWJsZSB9IGZyb20gXCIuLi9nc2QtZGIuanNcIjtcbmltcG9ydCB7XG4gIGNyZWF0ZU1lbW9yeSxcbiAgZ2V0QWN0aXZlTWVtb3JpZXNSYW5rZWQsXG4gIHF1ZXJ5TWVtb3JpZXNSYW5rZWQsXG4gIHJlaW5mb3JjZU1lbW9yeSxcbn0gZnJvbSBcIi4uL21lbW9yeS1zdG9yZS5qc1wiO1xuaW1wb3J0IHR5cGUgeyBNZW1vcnksIFJhbmtlZE1lbW9yeSB9IGZyb20gXCIuLi9tZW1vcnktc3RvcmUuanNcIjtcbmltcG9ydCB7IHRyYXZlcnNlR3JhcGggfSBmcm9tIFwiLi4vbWVtb3J5LXJlbGF0aW9ucy5qc1wiO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU2hhcmVkIHJlc3VsdCBzaGFwZSAobWF0Y2hlcyB0b29scy93b3JrZmxvdy10b29sLWV4ZWN1dG9ycy50cykgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBpbnRlcmZhY2UgVG9vbEV4ZWN1dGlvblJlc3VsdCB7XG4gIGNvbnRlbnQ6IEFycmF5PHsgdHlwZTogXCJ0ZXh0XCI7IHRleHQ6IHN0cmluZyB9PjtcbiAgZGV0YWlsczogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIGlzRXJyb3I/OiBib29sZWFuO1xufVxuXG5mdW5jdGlvbiBkYlVuYXZhaWxhYmxlKG9wZXJhdGlvbjogc3RyaW5nKTogVG9vbEV4ZWN1dGlvblJlc3VsdCB7XG4gIHJldHVybiB7XG4gICAgY29udGVudDogW1xuICAgICAge1xuICAgICAgICB0eXBlOiBcInRleHRcIixcbiAgICAgICAgdGV4dDogXCJFcnJvcjogR1NEIGRhdGFiYXNlIGlzIG5vdCBhdmFpbGFibGUuIE1lbW9yeSB0b29scyByZXF1aXJlIGFuIGluaXRpYWxpemVkIC5nc2QvIHByb2plY3QuXCIsXG4gICAgICB9LFxuICAgIF0sXG4gICAgZGV0YWlsczogeyBvcGVyYXRpb24sIGVycm9yOiBcImRiX3VuYXZhaWxhYmxlXCIgfSxcbiAgICBpc0Vycm9yOiB0cnVlLFxuICB9O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgY2FwdHVyZV90aG91Z2h0IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgaW50ZXJmYWNlIE1lbW9yeUNhcHR1cmVQYXJhbXMge1xuICBjYXRlZ29yeTogc3RyaW5nO1xuICBjb250ZW50OiBzdHJpbmc7XG4gIGNvbmZpZGVuY2U/OiBudW1iZXI7XG4gIHRhZ3M/OiBzdHJpbmdbXTtcbiAgc2NvcGU/OiBzdHJpbmc7XG4gIC8qKlxuICAgKiBBRFItMDEzIFN0ZXAgMjogb3B0aW9uYWwgc3RydWN0dXJlZCBwYXlsb2FkIHByZXNlcnZlZCB2ZXJiYXRpbSBvbiB0aGVcbiAgICogbWVtb3JpZXMgcm93LiBVc2VkIHdoZW4gY2FwdHVyaW5nIGRlY2lzaW9ucyB0aGF0IG5lZWQgdG8gcmV0YWluXG4gICAqIGdzZF9zYXZlX2RlY2lzaW9uLXN0eWxlIGZpZWxkcyAoc2NvcGUsIGRlY2lzaW9uLCBjaG9pY2UsIHJhdGlvbmFsZSxcbiAgICogbWFkZV9ieSwgcmV2aXNhYmxlKSBzbyB0aGUgZXZlbnR1YWwgY3V0b3ZlciAoU3RlcCA2KSBpcyBsb3NzbGVzcy5cbiAgICogUGxhaW4gcGF0dGVybi9nb3RjaGEvY29udmVudGlvbiBjYXB0dXJlcyBtYXkgb21pdCB0aGlzIGVudGlyZWx5LlxuICAgKi9cbiAgc3RydWN0dXJlZEZpZWxkcz86IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbDtcbn1cblxuY29uc3QgVkFMSURfQ0FURUdPUklFUyA9IG5ldyBTZXQoW1xuICBcImFyY2hpdGVjdHVyZVwiLFxuICBcImNvbnZlbnRpb25cIixcbiAgXCJnb3RjaGFcIixcbiAgXCJwcmVmZXJlbmNlXCIsXG4gIFwiZW52aXJvbm1lbnRcIixcbiAgXCJwYXR0ZXJuXCIsXG5dKTtcblxuZXhwb3J0IGZ1bmN0aW9uIGV4ZWN1dGVNZW1vcnlDYXB0dXJlKHBhcmFtczogTWVtb3J5Q2FwdHVyZVBhcmFtcyk6IFRvb2xFeGVjdXRpb25SZXN1bHQge1xuICBpZiAoIWlzRGJBdmFpbGFibGUoKSkgcmV0dXJuIGRiVW5hdmFpbGFibGUoXCJtZW1vcnlfY2FwdHVyZVwiKTtcblxuICBjb25zdCBjYXRlZ29yeSA9IChwYXJhbXMuY2F0ZWdvcnkgPz8gXCJcIikudHJpbSgpLnRvTG93ZXJDYXNlKCk7XG4gIGNvbnN0IGNvbnRlbnQgPSAocGFyYW1zLmNvbnRlbnQgPz8gXCJcIikudHJpbSgpO1xuICBpZiAoIWNhdGVnb3J5IHx8ICFjb250ZW50KSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkVycm9yOiBjYXRlZ29yeSBhbmQgY29udGVudCBhcmUgcmVxdWlyZWQuXCIgfV0sXG4gICAgICBkZXRhaWxzOiB7IG9wZXJhdGlvbjogXCJtZW1vcnlfY2FwdHVyZVwiLCBlcnJvcjogXCJtaXNzaW5nX2ZpZWxkc1wiIH0sXG4gICAgICBpc0Vycm9yOiB0cnVlLFxuICAgIH07XG4gIH1cbiAgaWYgKCFWQUxJRF9DQVRFR09SSUVTLmhhcyhjYXRlZ29yeSkpIHtcbiAgICByZXR1cm4ge1xuICAgICAgY29udGVudDogW1xuICAgICAgICB7XG4gICAgICAgICAgdHlwZTogXCJ0ZXh0XCIsXG4gICAgICAgICAgdGV4dDogYEVycm9yOiBpbnZhbGlkIGNhdGVnb3J5IFwiJHtjYXRlZ29yeX1cIi4gTXVzdCBiZSBvbmUgb2Y6ICR7Wy4uLlZBTElEX0NBVEVHT1JJRVNdLmpvaW4oXCIsIFwiKX0uYCxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgICBkZXRhaWxzOiB7IG9wZXJhdGlvbjogXCJtZW1vcnlfY2FwdHVyZVwiLCBlcnJvcjogXCJpbnZhbGlkX2NhdGVnb3J5XCIgfSxcbiAgICAgIGlzRXJyb3I6IHRydWUsXG4gICAgfTtcbiAgfVxuICBjb25zdCBjb25maWRlbmNlID0gY2xhbXBDb25maWRlbmNlKHBhcmFtcy5jb25maWRlbmNlKTtcbiAgY29uc3Qgc2NvcGUgPSBub3JtYWxpemVTY29wZShwYXJhbXMuc2NvcGUpO1xuICBjb25zdCB0YWdzID0gbm9ybWFsaXplVGFncyhwYXJhbXMudGFncyk7XG5cbiAgY29uc3Qgc3RydWN0dXJlZEZpZWxkcyA9IG5vcm1hbGl6ZVN0cnVjdHVyZWRGaWVsZHMocGFyYW1zLnN0cnVjdHVyZWRGaWVsZHMpO1xuICBsZXQgaWQ6IHN0cmluZyB8IG51bGw7XG4gIHRyeSB7XG4gICAgaWQgPSBjcmVhdGVNZW1vcnkoeyBjYXRlZ29yeSwgY29udGVudCwgY29uZmlkZW5jZSwgc2NvcGUsIHRhZ3MsIHN0cnVjdHVyZWRGaWVsZHMgfSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIC8vIFN1cmZhY2UgdGhlIHVuZGVybHlpbmcgU1FMIG1lc3NhZ2UgKGUuZy4gXCJkYXRhYmFzZSBkaXNrIGltYWdlIGlzXG4gICAgLy8gbWFsZm9ybWVkXCIsIFwibm8gc3VjaCB0YWJsZTogbWVtb3JpZXNcIikgc28gdGhlIG9wZXJhdG9yIGdldHMgdGhlXG4gICAgLy8gYWN0aW9uYWJsZSBzaWduYWwgaW5zdGVhZCBvZiBhbiBvcGFxdWUgXCJjcmVhdGVfZmFpbGVkXCIuIFNlZSAjNDk2Ny5cbiAgICBjb25zdCBtZXNzYWdlID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgIHJldHVybiB7XG4gICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYEVycm9yOiBmYWlsZWQgdG8gY3JlYXRlIG1lbW9yeTogJHttZXNzYWdlfWAgfV0sXG4gICAgICBkZXRhaWxzOiB7IG9wZXJhdGlvbjogXCJtZW1vcnlfY2FwdHVyZVwiLCBlcnJvcjogbWVzc2FnZSB9LFxuICAgICAgaXNFcnJvcjogdHJ1ZSxcbiAgICB9O1xuICB9XG4gIGlmICghaWQpIHtcbiAgICAvLyBEQiB1bmF2YWlsYWJsZSBvciBhZGFwdGVyIG1pc3NpbmcgXHUyMDE0IGRpc3RpbmN0IGZyb20gdGhlIFNRTC1lcnJvciBwYXRoXG4gICAgLy8gYWJvdmUuIEtlZXAgdGhlIGxlZ2FjeSBjcmVhdGVfZmFpbGVkIHRva2VuIGhlcmUgc28gYW55IGNvbnN1bWVycyB0aGF0XG4gICAgLy8gZXhwbGljaXRseSBrZXkgb24gdGhlIHVuYXZhaWxhYmxlIGNhc2UgY29udGludWUgdG8gd29yay5cbiAgICByZXR1cm4ge1xuICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiRXJyb3I6IGZhaWxlZCB0byBjcmVhdGUgbWVtb3J5LlwiIH1dLFxuICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwibWVtb3J5X2NhcHR1cmVcIiwgZXJyb3I6IFwiY3JlYXRlX2ZhaWxlZFwiIH0sXG4gICAgICBpc0Vycm9yOiB0cnVlLFxuICAgIH07XG4gIH1cblxuICByZXR1cm4ge1xuICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgQ2FwdHVyZWQgJHtpZH0gKCR7Y2F0ZWdvcnl9KTogJHtjb250ZW50fWAgfV0sXG4gICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwibWVtb3J5X2NhcHR1cmVcIiwgaWQsIGNhdGVnb3J5LCBjb25maWRlbmNlLCBzY29wZSwgdGFncyB9LFxuICB9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVTY29wZSh2YWx1ZTogdW5rbm93bik6IHN0cmluZyB7XG4gIGlmICh0eXBlb2YgdmFsdWUgIT09IFwic3RyaW5nXCIpIHJldHVybiBcInByb2plY3RcIjtcbiAgY29uc3QgdHJpbW1lZCA9IHZhbHVlLnRyaW0oKTtcbiAgcmV0dXJuIHRyaW1tZWQubGVuZ3RoID09PSAwID8gXCJwcm9qZWN0XCIgOiB0cmltbWVkO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVUYWdzKHZhbHVlOiB1bmtub3duKTogc3RyaW5nW10ge1xuICBpZiAoIUFycmF5LmlzQXJyYXkodmFsdWUpKSByZXR1cm4gW107XG4gIHJldHVybiB2YWx1ZS5maWx0ZXIoKHQpOiB0IGlzIHN0cmluZyA9PiB0eXBlb2YgdCA9PT0gXCJzdHJpbmdcIiAmJiB0LnRyaW0oKS5sZW5ndGggPiAwKS5zbGljZSgwLCAxMCk7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVN0cnVjdHVyZWRGaWVsZHModmFsdWU6IHVua25vd24pOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGwge1xuICBpZiAodmFsdWUgPT0gbnVsbCkgcmV0dXJuIG51bGw7XG4gIGlmICh0eXBlb2YgdmFsdWUgIT09IFwib2JqZWN0XCIgfHwgQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHJldHVybiBudWxsO1xuICAvLyBPbmx5IGFjY2VwdCBwbGFpbiBvYmplY3RzIChPYmplY3QucHJvdG90eXBlIG9yIG51bGwgcHJvdG90eXBlKS4gQ2xhc3NcbiAgLy8gaW5zdGFuY2VzIGFuZCBleG90aWMgb2JqZWN0cyB3b24ndCByb3VuZC10cmlwIGNsZWFubHkgdGhyb3VnaCBKU09OLCBzb1xuICAvLyByZWplY3QgdGhlbSBoZXJlIGluc3RlYWQgb2YgcHJvZHVjaW5nIGEgcGFydGlhbGx5LXNlcmlhbGl6ZWQgcGF5bG9hZC5cbiAgY29uc3QgcHJvdG8gPSBPYmplY3QuZ2V0UHJvdG90eXBlT2YodmFsdWUpO1xuICBpZiAocHJvdG8gIT09IG51bGwgJiYgcHJvdG8gIT09IE9iamVjdC5wcm90b3R5cGUpIHJldHVybiBudWxsO1xuICByZXR1cm4gdmFsdWUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG59XG5cbmZ1bmN0aW9uIGNsYW1wQ29uZmlkZW5jZSh2YWx1ZTogdW5rbm93bik6IG51bWJlciB7XG4gIGlmICh0eXBlb2YgdmFsdWUgIT09IFwibnVtYmVyXCIgfHwgIU51bWJlci5pc0Zpbml0ZSh2YWx1ZSkpIHJldHVybiAwLjg7XG4gIGlmICh2YWx1ZSA8IDAuMSkgcmV0dXJuIDAuMTtcbiAgaWYgKHZhbHVlID4gMC45OSkgcmV0dXJuIDAuOTk7XG4gIHJldHVybiB2YWx1ZTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIG1lbW9yeV9xdWVyeSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGludGVyZmFjZSBNZW1vcnlRdWVyeVBhcmFtcyB7XG4gIHF1ZXJ5OiBzdHJpbmc7XG4gIGs/OiBudW1iZXI7XG4gIGNhdGVnb3J5Pzogc3RyaW5nO1xuICBzY29wZT86IHN0cmluZztcbiAgdGFnPzogc3RyaW5nO1xuICBpbmNsdWRlX3N1cGVyc2VkZWQ/OiBib29sZWFuO1xuICByZWluZm9yY2VfaGl0cz86IGJvb2xlYW47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgTWVtb3J5UXVlcnlIaXQge1xuICBpZDogc3RyaW5nO1xuICBjYXRlZ29yeTogc3RyaW5nO1xuICBjb250ZW50OiBzdHJpbmc7XG4gIGNvbmZpZGVuY2U6IG51bWJlcjtcbiAgaGl0X2NvdW50OiBudW1iZXI7XG4gIHNjb3JlOiBudW1iZXI7XG4gIHJlYXNvbjogXCJrZXl3b3JkXCIgfCBcInNlbWFudGljXCIgfCBcImJvdGhcIiB8IFwicmFua2VkXCI7XG4gIGtleXdvcmRfcmFuazogbnVtYmVyIHwgbnVsbDtcbiAgc2VtYW50aWNfcmFuazogbnVtYmVyIHwgbnVsbDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGV4ZWN1dGVNZW1vcnlRdWVyeShwYXJhbXM6IE1lbW9yeVF1ZXJ5UGFyYW1zKTogVG9vbEV4ZWN1dGlvblJlc3VsdCB7XG4gIGlmICghaXNEYkF2YWlsYWJsZSgpKSByZXR1cm4gZGJVbmF2YWlsYWJsZShcIm1lbW9yeV9xdWVyeVwiKTtcblxuICBjb25zdCBxdWVyeSA9IChwYXJhbXMucXVlcnkgPz8gXCJcIikudHJpbSgpO1xuICBjb25zdCBrID0gY2xhbXBUb3BLKHBhcmFtcy5rLCAxMCk7XG4gIGNvbnN0IGluY2x1ZGVTdXBlcnNlZGVkID0gcGFyYW1zLmluY2x1ZGVfc3VwZXJzZWRlZCA9PT0gdHJ1ZTtcbiAgY29uc3QgY2F0ZWdvcnkgPSBwYXJhbXMuY2F0ZWdvcnk/LnRyaW0oKS50b0xvd2VyQ2FzZSgpIHx8IHVuZGVmaW5lZDtcbiAgY29uc3Qgc2NvcGVGaWx0ZXIgPSBwYXJhbXMuc2NvcGU/LnRyaW0oKSB8fCB1bmRlZmluZWQ7XG4gIGNvbnN0IHRhZ0ZpbHRlciA9IHBhcmFtcy50YWc/LnRyaW0oKS50b0xvd2VyQ2FzZSgpIHx8IHVuZGVmaW5lZDtcblxuICB0cnkge1xuICAgIGxldCByYW5rZWQ6IFJhbmtlZE1lbW9yeVtdID0gW107XG4gICAgaWYgKHF1ZXJ5KSB7XG4gICAgICByYW5rZWQgPSBxdWVyeU1lbW9yaWVzUmFua2VkKHtcbiAgICAgICAgcXVlcnksXG4gICAgICAgIGssXG4gICAgICAgIGNhdGVnb3J5LFxuICAgICAgICBzY29wZTogc2NvcGVGaWx0ZXIsXG4gICAgICAgIHRhZzogdGFnRmlsdGVyLFxuICAgICAgICBpbmNsdWRlX3N1cGVyc2VkZWQ6IGluY2x1ZGVTdXBlcnNlZGVkLFxuICAgICAgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IGNhbmRpZGF0ZXM6IE1lbW9yeVtdID0gaW5jbHVkZVN1cGVyc2VkZWRcbiAgICAgICAgPyBpbmNsdWRlU3VwZXJzZWRlZE1lbW9yaWVzKGdldEFjdGl2ZU1lbW9yaWVzUmFua2VkKDIwMCkpXG4gICAgICAgIDogZ2V0QWN0aXZlTWVtb3JpZXNSYW5rZWQoMjAwKTtcbiAgICAgIHJhbmtlZCA9IGNhbmRpZGF0ZXNcbiAgICAgICAgLmZpbHRlcigobSkgPT4ge1xuICAgICAgICAgIGlmIChjYXRlZ29yeSAmJiBtLmNhdGVnb3J5LnRvTG93ZXJDYXNlKCkgIT09IGNhdGVnb3J5KSByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgaWYgKHNjb3BlRmlsdGVyICYmIG0uc2NvcGUgIT09IHNjb3BlRmlsdGVyKSByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgaWYgKHRhZ0ZpbHRlciAmJiAhbS50YWdzLm1hcCgodCkgPT4gdC50b0xvd2VyQ2FzZSgpKS5pbmNsdWRlcyh0YWdGaWx0ZXIpKSByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0pXG4gICAgICAgIC5zbGljZSgwLCBrKVxuICAgICAgICAubWFwKChtZW1vcnkpID0+ICh7XG4gICAgICAgICAgbWVtb3J5LFxuICAgICAgICAgIHNjb3JlOiBtZW1vcnkuY29uZmlkZW5jZSAqICgxICsgbWVtb3J5LmhpdF9jb3VudCAqIDAuMSksXG4gICAgICAgICAga2V5d29yZFJhbms6IG51bGwsXG4gICAgICAgICAgc2VtYW50aWNSYW5rOiBudWxsLFxuICAgICAgICAgIGNvbmZpZGVuY2VCb29zdDogbWVtb3J5LmNvbmZpZGVuY2UgKiAoMSArIG1lbW9yeS5oaXRfY291bnQgKiAwLjEpLFxuICAgICAgICAgIHJlYXNvbjogXCJyYW5rZWRcIiBhcyBjb25zdCxcbiAgICAgICAgfSkpO1xuICAgIH1cblxuICAgIGNvbnN0IGhpdHM6IE1lbW9yeVF1ZXJ5SGl0W10gPSByYW5rZWQubWFwKChyKSA9PiAoe1xuICAgICAgaWQ6IHIubWVtb3J5LmlkLFxuICAgICAgY2F0ZWdvcnk6IHIubWVtb3J5LmNhdGVnb3J5LFxuICAgICAgY29udGVudDogci5tZW1vcnkuY29udGVudCxcbiAgICAgIGNvbmZpZGVuY2U6IHIubWVtb3J5LmNvbmZpZGVuY2UsXG4gICAgICBoaXRfY291bnQ6IHIubWVtb3J5LmhpdF9jb3VudCxcbiAgICAgIHNjb3JlOiByLnNjb3JlLFxuICAgICAgcmVhc29uOiByLnJlYXNvbixcbiAgICAgIGtleXdvcmRfcmFuazogci5rZXl3b3JkUmFuayxcbiAgICAgIHNlbWFudGljX3Jhbms6IHIuc2VtYW50aWNSYW5rLFxuICAgIH0pKTtcblxuICAgIGlmIChwYXJhbXMucmVpbmZvcmNlX2hpdHMpIHtcbiAgICAgIGZvciAoY29uc3QgaCBvZiBoaXRzKSByZWluZm9yY2VNZW1vcnkoaC5pZCk7XG4gICAgfVxuXG4gICAgY29uc3Qgc3VtbWFyeSA9IGhpdHMubGVuZ3RoID09PSAwXG4gICAgICA/IFwiTm8gbWF0Y2hpbmcgbWVtb3JpZXMuXCJcbiAgICAgIDogaGl0cy5tYXAoKGgpID0+IGAtIFske2guaWR9XSAoJHtoLmNhdGVnb3J5fSkgJHtoLmNvbnRlbnR9YCkuam9pbihcIlxcblwiKTtcblxuICAgIHJldHVybiB7XG4gICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogc3VtbWFyeSB9XSxcbiAgICAgIGRldGFpbHM6IHtcbiAgICAgICAgb3BlcmF0aW9uOiBcIm1lbW9yeV9xdWVyeVwiLFxuICAgICAgICBxdWVyeSxcbiAgICAgICAgayxcbiAgICAgICAgcmV0dXJuZWQ6IGhpdHMubGVuZ3RoLFxuICAgICAgICBoaXRzLFxuICAgICAgfSxcbiAgICB9O1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBFcnJvcjogbWVtb3J5IHF1ZXJ5IGZhaWxlZDogJHsoZXJyIGFzIEVycm9yKS5tZXNzYWdlfWAgfV0sXG4gICAgICBkZXRhaWxzOiB7IG9wZXJhdGlvbjogXCJtZW1vcnlfcXVlcnlcIiwgZXJyb3I6IChlcnIgYXMgRXJyb3IpLm1lc3NhZ2UgfSxcbiAgICAgIGlzRXJyb3I6IHRydWUsXG4gICAgfTtcbiAgfVxufVxuXG5mdW5jdGlvbiBjbGFtcFRvcEsodmFsdWU6IHVua25vd24sIGZhbGxiYWNrOiBudW1iZXIpOiBudW1iZXIge1xuICBpZiAodHlwZW9mIHZhbHVlICE9PSBcIm51bWJlclwiIHx8ICFOdW1iZXIuaXNGaW5pdGUodmFsdWUpKSByZXR1cm4gZmFsbGJhY2s7XG4gIGlmICh2YWx1ZSA8IDEpIHJldHVybiAxO1xuICBpZiAodmFsdWUgPiA1MCkgcmV0dXJuIDUwO1xuICByZXR1cm4gTWF0aC5mbG9vcih2YWx1ZSk7XG59XG5cbmZ1bmN0aW9uIGluY2x1ZGVTdXBlcnNlZGVkTWVtb3JpZXMocmFua2VkQWN0aXZlOiBNZW1vcnlbXSk6IE1lbW9yeVtdIHtcbiAgY29uc3QgYWRhcHRlciA9IF9nZXRBZGFwdGVyKCk7XG4gIGlmICghYWRhcHRlcikgcmV0dXJuIHJhbmtlZEFjdGl2ZTtcbiAgdHJ5IHtcbiAgICBjb25zdCByb3dzID0gYWRhcHRlci5wcmVwYXJlKFwiU0VMRUNUICogRlJPTSBtZW1vcmllc1wiKS5hbGwoKTtcbiAgICByZXR1cm4gcm93cy5tYXAoKHJvdykgPT4ge1xuICAgICAgbGV0IHRhZ3M6IHN0cmluZ1tdID0gW107XG4gICAgICBpZiAodHlwZW9mIHJvd1tcInRhZ3NcIl0gPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHJvd1tcInRhZ3NcIl0gYXMgc3RyaW5nKTtcbiAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShwYXJzZWQpKSB0YWdzID0gcGFyc2VkLmZpbHRlcigodCk6IHQgaXMgc3RyaW5nID0+IHR5cGVvZiB0ID09PSBcInN0cmluZ1wiKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgLyogbGVhdmUgZW1wdHkgKi9cbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgbGV0IHN0cnVjdHVyZWRGaWVsZHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCA9IG51bGw7XG4gICAgICBpZiAodHlwZW9mIHJvd1tcInN0cnVjdHVyZWRfZmllbGRzXCJdID09PSBcInN0cmluZ1wiICYmIChyb3dbXCJzdHJ1Y3R1cmVkX2ZpZWxkc1wiXSBhcyBzdHJpbmcpLmxlbmd0aCA+IDApIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHJvd1tcInN0cnVjdHVyZWRfZmllbGRzXCJdIGFzIHN0cmluZyk7XG4gICAgICAgICAgaWYgKHBhcnNlZCAmJiB0eXBlb2YgcGFyc2VkID09PSBcIm9iamVjdFwiICYmICFBcnJheS5pc0FycmF5KHBhcnNlZCkpIHtcbiAgICAgICAgICAgIHN0cnVjdHVyZWRGaWVsZHMgPSBwYXJzZWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICAgICAgfVxuICAgICAgICB9IGNhdGNoIHsgLyogbGVhdmUgbnVsbCAqLyB9XG4gICAgICB9XG4gICAgICByZXR1cm4ge1xuICAgICAgICBzZXE6IHJvd1tcInNlcVwiXSBhcyBudW1iZXIsXG4gICAgICAgIGlkOiByb3dbXCJpZFwiXSBhcyBzdHJpbmcsXG4gICAgICAgIGNhdGVnb3J5OiByb3dbXCJjYXRlZ29yeVwiXSBhcyBzdHJpbmcsXG4gICAgICAgIGNvbnRlbnQ6IHJvd1tcImNvbnRlbnRcIl0gYXMgc3RyaW5nLFxuICAgICAgICBjb25maWRlbmNlOiByb3dbXCJjb25maWRlbmNlXCJdIGFzIG51bWJlcixcbiAgICAgICAgc291cmNlX3VuaXRfdHlwZTogKHJvd1tcInNvdXJjZV91bml0X3R5cGVcIl0gYXMgc3RyaW5nKSA/PyBudWxsLFxuICAgICAgICBzb3VyY2VfdW5pdF9pZDogKHJvd1tcInNvdXJjZV91bml0X2lkXCJdIGFzIHN0cmluZykgPz8gbnVsbCxcbiAgICAgICAgY3JlYXRlZF9hdDogcm93W1wiY3JlYXRlZF9hdFwiXSBhcyBzdHJpbmcsXG4gICAgICAgIHVwZGF0ZWRfYXQ6IHJvd1tcInVwZGF0ZWRfYXRcIl0gYXMgc3RyaW5nLFxuICAgICAgICBzdXBlcnNlZGVkX2J5OiAocm93W1wic3VwZXJzZWRlZF9ieVwiXSBhcyBzdHJpbmcpID8/IG51bGwsXG4gICAgICAgIGhpdF9jb3VudDogcm93W1wiaGl0X2NvdW50XCJdIGFzIG51bWJlcixcbiAgICAgICAgc2NvcGU6IChyb3dbXCJzY29wZVwiXSBhcyBzdHJpbmcpID8/IFwicHJvamVjdFwiLFxuICAgICAgICB0YWdzLFxuICAgICAgICBzdHJ1Y3R1cmVkX2ZpZWxkczogc3RydWN0dXJlZEZpZWxkcyxcbiAgICAgICAgbGFzdF9oaXRfYXQ6IChyb3dbXCJsYXN0X2hpdF9hdFwiXSBhcyBzdHJpbmcgfCBudWxsKSA/PyBudWxsLFxuICAgICAgfTtcbiAgICB9KTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHJhbmtlZEFjdGl2ZTtcbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgZ3NkX2dyYXBoIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgaW50ZXJmYWNlIEdzZEdyYXBoUGFyYW1zIHtcbiAgbW9kZTogXCJidWlsZFwiIHwgXCJxdWVyeVwiO1xuICBtZW1vcnlJZD86IHN0cmluZztcbiAgZGVwdGg/OiBudW1iZXI7XG4gIHJlbD86IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBHcmFwaE5vZGUge1xuICBpZDogc3RyaW5nO1xuICBjYXRlZ29yeTogc3RyaW5nO1xuICBjb250ZW50OiBzdHJpbmc7XG4gIGNvbmZpZGVuY2U6IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBHcmFwaEVkZ2Uge1xuICBmcm9tOiBzdHJpbmc7XG4gIHRvOiBzdHJpbmc7XG4gIHJlbDogc3RyaW5nO1xuICBjb25maWRlbmNlOiBudW1iZXI7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBleGVjdXRlR3NkR3JhcGgocGFyYW1zOiBHc2RHcmFwaFBhcmFtcyk6IFRvb2xFeGVjdXRpb25SZXN1bHQge1xuICBpZiAoIWlzRGJBdmFpbGFibGUoKSkgcmV0dXJuIGRiVW5hdmFpbGFibGUoXCJnc2RfZ3JhcGhcIik7XG5cbiAgaWYgKHBhcmFtcy5tb2RlID09PSBcImJ1aWxkXCIpIHtcbiAgICAvLyBUaGUgZXh0cmFjdG9yIGVtaXRzIExJTksgYWN0aW9ucyBpbmNyZW1lbnRhbGx5IChQaGFzZSA0KS4gVGhlcmUgaXMgbm9cbiAgICAvLyBiYXRjaCByZWJ1aWxkIHN0ZXAgdG8gcnVuIHRvZGF5IFx1MjAxNCBpbmdlc3QgYXJ0aWZhY3RzIHZpYSBgL2dzZCBtZW1vcnlcbiAgICAvLyBleHRyYWN0IDxTUkMtLi4uPmAgYW5kIHRoZSBuZXh0IGV4dHJhY3Rpb24gdHVybiB3aWxsIGFkZCBlZGdlcy5cbiAgICByZXR1cm4ge1xuICAgICAgY29udGVudDogW1xuICAgICAgICB7XG4gICAgICAgICAgdHlwZTogXCJ0ZXh0XCIsXG4gICAgICAgICAgdGV4dDpcbiAgICAgICAgICAgIFwiZ3NkX2dyYXBoIGJ1aWxkIGFja25vd2xlZGdlZC4gR3JhcGggZWRnZXMgYXJlIHBvcHVsYXRlZCBpbmNyZW1lbnRhbGx5IGJ5IG1lbW9yeSBcIiArXG4gICAgICAgICAgICBcImV4dHJhY3Rpb24gKGluY2x1ZGluZyBMSU5LIGFjdGlvbnMpLiBVc2UgYC9nc2QgbWVtb3J5IGV4dHJhY3QgPFNSQy0uLi4+YCB0byB0cmlnZ2VyIFwiICtcbiAgICAgICAgICAgIFwiZXh0cmFjdGlvbiBhZ2FpbnN0IGEgc3BlY2lmaWMgaW5nZXN0ZWQgc291cmNlLlwiLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICAgIGRldGFpbHM6IHsgb3BlcmF0aW9uOiBcImdzZF9ncmFwaFwiLCBtb2RlOiBcImJ1aWxkXCIsIGJ1aWx0OiAwIH0sXG4gICAgfTtcbiAgfVxuXG4gIGlmIChwYXJhbXMubW9kZSAhPT0gXCJxdWVyeVwiKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgRXJyb3I6IHVua25vd24gbW9kZSBcIiR7cGFyYW1zLm1vZGV9XCIuIE11c3QgYmUgXCJidWlsZFwiIG9yIFwicXVlcnlcIi5gIH1dLFxuICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwiZ3NkX2dyYXBoXCIsIGVycm9yOiBcImludmFsaWRfbW9kZVwiIH0sXG4gICAgICBpc0Vycm9yOiB0cnVlLFxuICAgIH07XG4gIH1cblxuICBjb25zdCBtZW1vcnlJZCA9IHBhcmFtcy5tZW1vcnlJZD8udHJpbSgpO1xuICBpZiAoIW1lbW9yeUlkKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkVycm9yOiBtZW1vcnlJZCBpcyByZXF1aXJlZCBmb3IgbW9kZT1xdWVyeS5cIiB9XSxcbiAgICAgIGRldGFpbHM6IHsgb3BlcmF0aW9uOiBcImdzZF9ncmFwaFwiLCBlcnJvcjogXCJtaXNzaW5nX21lbW9yeV9pZFwiIH0sXG4gICAgICBpc0Vycm9yOiB0cnVlLFxuICAgIH07XG4gIH1cblxuICB0cnkge1xuICAgIGNvbnN0IGdyYXBoID0gdHJhdmVyc2VHcmFwaChtZW1vcnlJZCwgY2xhbXBEZXB0aChwYXJhbXMuZGVwdGgpKTtcbiAgICBjb25zdCByZWwgPSBwYXJhbXMucmVsPy50cmltKCkudG9Mb3dlckNhc2UoKSB8fCBudWxsO1xuICAgIGNvbnN0IGVkZ2VzID0gcmVsID8gZ3JhcGguZWRnZXMuZmlsdGVyKChlKSA9PiBlLnJlbCA9PT0gcmVsKSA6IGdyYXBoLmVkZ2VzO1xuICAgIGNvbnN0IHJlbGV2YW50SWRzID0gbmV3IFNldDxzdHJpbmc+KFttZW1vcnlJZF0pO1xuICAgIGZvciAoY29uc3QgZSBvZiBlZGdlcykge1xuICAgICAgcmVsZXZhbnRJZHMuYWRkKGUuZnJvbSk7XG4gICAgICByZWxldmFudElkcy5hZGQoZS50byk7XG4gICAgfVxuICAgIGNvbnN0IG5vZGVzID0gZ3JhcGgubm9kZXMuZmlsdGVyKChuKSA9PiByZWxldmFudElkcy5oYXMobi5pZCkpO1xuXG4gICAgaWYgKG5vZGVzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBObyBtZW1vcnkgZm91bmQgd2l0aCBpZCAke21lbW9yeUlkfS5gIH1dLFxuICAgICAgICBkZXRhaWxzOiB7IG9wZXJhdGlvbjogXCJnc2RfZ3JhcGhcIiwgbW9kZTogXCJxdWVyeVwiLCBtZW1vcnlJZCwgbm9kZXM6IFtdLCBlZGdlczogW10gfSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgY29uc3Qgc3VtbWFyeSA9IFtcbiAgICAgIGBNZW1vcnkgJHttZW1vcnlJZH0gXHUyMDE0ICR7bm9kZXMubGVuZ3RofSBub2RlKHMpLCAke2VkZ2VzLmxlbmd0aH0gZWRnZShzKS5gLFxuICAgICAgLi4ubm9kZXMubWFwKChuKSA9PiBgICBbJHtuLmlkfV0gKCR7bi5jYXRlZ29yeX0pICR7bi5jb250ZW50fWApLFxuICAgICAgLi4uZWRnZXMubWFwKChlKSA9PiBgICAke2UuZnJvbX0gLS0ke2UucmVsfS0+ICR7ZS50b31gKSxcbiAgICBdLmpvaW4oXCJcXG5cIik7XG4gICAgcmV0dXJuIHtcbiAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBzdW1tYXJ5IH1dLFxuICAgICAgZGV0YWlsczoge1xuICAgICAgICBvcGVyYXRpb246IFwiZ3NkX2dyYXBoXCIsXG4gICAgICAgIG1vZGU6IFwicXVlcnlcIixcbiAgICAgICAgbWVtb3J5SWQsXG4gICAgICAgIG5vZGVzOiBub2Rlcy5tYXAoKG4pID0+ICh7IGlkOiBuLmlkLCBjYXRlZ29yeTogbi5jYXRlZ29yeSwgY29udGVudDogbi5jb250ZW50IH0pKSxcbiAgICAgICAgZWRnZXM6IGVkZ2VzLm1hcCgoZSkgPT4gKHsgZnJvbTogZS5mcm9tLCB0bzogZS50bywgcmVsOiBlLnJlbCB9KSksXG4gICAgICB9LFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHJldHVybiB7XG4gICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYEVycm9yOiBncmFwaCBxdWVyeSBmYWlsZWQ6ICR7KGVyciBhcyBFcnJvcikubWVzc2FnZX1gIH1dLFxuICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwiZ3NkX2dyYXBoXCIsIGVycm9yOiAoZXJyIGFzIEVycm9yKS5tZXNzYWdlIH0sXG4gICAgICBpc0Vycm9yOiB0cnVlLFxuICAgIH07XG4gIH1cbn1cblxuZnVuY3Rpb24gY2xhbXBEZXB0aCh2YWx1ZTogdW5rbm93bik6IG51bWJlciB7XG4gIGlmICh0eXBlb2YgdmFsdWUgIT09IFwibnVtYmVyXCIgfHwgIU51bWJlci5pc0Zpbml0ZSh2YWx1ZSkpIHJldHVybiAxO1xuICBpZiAodmFsdWUgPCAwKSByZXR1cm4gMDtcbiAgaWYgKHZhbHVlID4gNSkgcmV0dXJuIDU7XG4gIHJldHVybiBNYXRoLmZsb29yKHZhbHVlKTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJB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
