import { readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { projectRoot } from "./commands/context.js";
import { ingestFile, ingestNote, ingestUrl, summarizeIngest } from "./memory-ingest.js";
import { getMemorySource, listMemorySources } from "./memory-source-store.js";
import {
  createMemory,
  decayStaleMemories,
  enforceMemoryCap,
  getActiveMemories,
  getActiveMemoriesRanked,
  supersedeMemory
} from "./memory-store.js";
import { _getAdapter, isDbAvailable } from "./gsd-db.js";
import { createMemoryRelation, listRelationsFor } from "./memory-relations.js";
function parseArgs(raw) {
  const tokens = splitArgs(raw);
  const sub = (tokens.shift() ?? "list").toLowerCase();
  const positional = [];
  const tags = [];
  let scope;
  let extract = false;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "--tag" && i + 1 < tokens.length) {
      tags.push(...tokens[++i].split(",").map((t) => t.trim()).filter(Boolean));
      continue;
    }
    if (tok.startsWith("--tag=")) {
      tags.push(...tok.slice("--tag=".length).split(",").map((t) => t.trim()).filter(Boolean));
      continue;
    }
    if (tok === "--scope" && i + 1 < tokens.length) {
      scope = tokens[++i];
      continue;
    }
    if (tok.startsWith("--scope=")) {
      scope = tok.slice("--scope=".length);
      continue;
    }
    if (tok === "--extract") {
      extract = true;
      continue;
    }
    if (tok === "--no-extract") {
      extract = false;
      continue;
    }
    positional.push(tok);
  }
  return { sub, positional, tags, scope, extract };
}
function splitArgs(raw) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(raw)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}
function truncate(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}\u2026`;
}
async function handleMemory(args, ctx, pi) {
  const parsed = parseArgs(args);
  if (parsed.sub === "" || parsed.sub === "help") {
    ctx.ui.notify(usage(), "info");
    return;
  }
  await ensureDb();
  switch (parsed.sub) {
    case "list":
      handleList(ctx);
      return;
    case "show":
      handleShow(ctx, parsed.positional[0]);
      return;
    case "forget":
      handleForget(ctx, parsed.positional[0]);
      return;
    case "stats":
      handleStats(ctx);
      return;
    case "sources":
      handleSources(ctx);
      return;
    case "note":
      await handleNote(ctx, parsed);
      return;
    case "ingest":
      await handleIngest(ctx, parsed);
      return;
    case "extract":
      handleExtractSource(ctx, pi, parsed.positional[0]);
      return;
    case "export":
      handleExport(ctx, parsed.positional[0]);
      return;
    case "import":
      handleImport(ctx, parsed.positional[0]);
      return;
    case "decay":
      handleDecay(ctx);
      return;
    case "cap":
      handleCap(ctx, parsed.positional[0]);
      return;
    default:
      ctx.ui.notify(`Unknown subcommand "${parsed.sub}". ${usage()}`, "warning");
      return;
  }
}
function usage() {
  return [
    "Usage: /gsd memory <subcommand>",
    "  list                    list recent active memories",
    "  show <MEM###>           print one memory",
    "  forget <MEM###>         supersede a memory",
    "  stats                   counts by category / scope / sources / edges",
    "  sources                 list recent memory_sources",
    '  note "<text>"           ingest an inline note as a source',
    "  ingest <path|url>       ingest a local file path or URL",
    "  extract <SRC-xxx>       dispatch an LLM turn to extract memories from a source",
    "  export <path.json>      dump memories + relations + sources to JSON",
    "  import <path.json>      load a previous export (idempotent)",
    "  decay                   run the stale-memory decay pass immediately",
    "  cap [N]                 enforce the memory cap (default 50)",
    "",
    "Options: --tag a,b   --scope project|global|<custom>   --extract"
  ].join("\n");
}
async function ensureDb() {
  if (isDbAvailable()) return;
  const { ensureDbOpen } = await import("./bootstrap/dynamic-tools.js");
  await ensureDbOpen();
}
function handleList(ctx) {
  if (!isDbAvailable()) {
    ctx.ui.notify("No GSD database available.", "warning");
    return;
  }
  const memories = getActiveMemoriesRanked(50);
  if (memories.length === 0) {
    ctx.ui.notify("No active memories.", "info");
    return;
  }
  const lines = memories.map(
    (m) => `- [${m.id}] (${m.category}, conf ${m.confidence.toFixed(2)}, hits ${m.hit_count}${m.scope && m.scope !== "project" ? `, ${m.scope}` : ""}) ${truncate(m.content, 100)}`
  );
  ctx.ui.notify(lines.join("\n"), "info");
}
function handleShow(ctx, id) {
  if (!id) {
    ctx.ui.notify("Usage: /gsd memory show <MEM###>", "warning");
    return;
  }
  const adapter = _getAdapter();
  if (!adapter) {
    ctx.ui.notify("No GSD database available.", "warning");
    return;
  }
  const row = adapter.prepare("SELECT * FROM memories WHERE id = :id").get({ ":id": id });
  if (!row) {
    ctx.ui.notify(`Memory not found: ${id}`, "warning");
    return;
  }
  const tags = row["tags"] ? safeJsonArray(row["tags"]) : [];
  const lines = [
    `ID: ${row["id"]}`,
    `Category: ${row["category"]}`,
    `Scope: ${row["scope"] ?? "project"}`,
    `Confidence: ${Number(row["confidence"]).toFixed(2)}`,
    `Hits: ${row["hit_count"]}`,
    `Created: ${row["created_at"]}`,
    `Updated: ${row["updated_at"]}`,
    tags.length > 0 ? `Tags: ${tags.join(", ")}` : null,
    row["superseded_by"] ? `Superseded by: ${row["superseded_by"]}` : null,
    row["source_unit_type"] ? `Source: ${row["source_unit_type"]}/${row["source_unit_id"]}` : null,
    "",
    String(row["content"])
  ].filter((line) => line !== null).join("\n");
  ctx.ui.notify(lines, "info");
}
function handleForget(ctx, id) {
  if (!id) {
    ctx.ui.notify("Usage: /gsd memory forget <MEM###>", "warning");
    return;
  }
  const ok = supersedeMemory(id, "CAP_EXCEEDED");
  if (!ok) {
    ctx.ui.notify(`Failed to forget ${id}.`, "warning");
    return;
  }
  ctx.ui.notify(`Forgot ${id}.`, "info");
}
function handleStats(ctx) {
  const adapter = _getAdapter();
  if (!adapter) {
    ctx.ui.notify("No GSD database available.", "warning");
    return;
  }
  try {
    const activeRow = adapter.prepare("SELECT count(*) as cnt FROM memories WHERE superseded_by IS NULL").get();
    const supersededRow = adapter.prepare("SELECT count(*) as cnt FROM memories WHERE superseded_by IS NOT NULL").get();
    const byCategory = adapter.prepare(
      "SELECT category, count(*) as cnt FROM memories WHERE superseded_by IS NULL GROUP BY category ORDER BY cnt DESC"
    ).all();
    const byScope = adapter.prepare(
      "SELECT scope, count(*) as cnt FROM memories WHERE superseded_by IS NULL GROUP BY scope ORDER BY cnt DESC"
    ).all();
    const sourcesRow = adapter.prepare("SELECT count(*) as cnt FROM memory_sources").get();
    const sourcesByKind = adapter.prepare("SELECT kind, count(*) as cnt FROM memory_sources GROUP BY kind ORDER BY cnt DESC").all();
    const relationsRow = adapter.prepare("SELECT count(*) as cnt FROM memory_relations").get();
    const relationsByRel = adapter.prepare("SELECT rel, count(*) as cnt FROM memory_relations GROUP BY rel ORDER BY cnt DESC").all();
    const embeddingsRow = adapter.prepare("SELECT count(*) as cnt FROM memory_embeddings").get();
    const embeddedActiveRow = adapter.prepare(
      `SELECT count(*) as cnt FROM memory_embeddings e
         JOIN memories m ON m.id = e.memory_id
         WHERE m.superseded_by IS NULL`
    ).get();
    const activeCount = activeRow?.["cnt"] ?? 0;
    const embeddedActive = embeddedActiveRow?.["cnt"] ?? 0;
    const coverage = activeCount > 0 ? `${Math.round(embeddedActive / activeCount * 100)}%` : "n/a";
    const out = [
      `Active memories: ${activeCount}`,
      `Superseded: ${supersededRow?.["cnt"] ?? 0}`,
      "",
      "By category:",
      ...byCategory.map((row) => `  ${row["category"]}: ${row["cnt"]}`),
      "",
      "By scope:",
      ...byScope.map((row) => `  ${row["scope"]}: ${row["cnt"]}`),
      "",
      `Memory sources: ${sourcesRow?.["cnt"] ?? 0}`,
      ...sourcesByKind.map((row) => `  ${row["kind"]}: ${row["cnt"]}`),
      "",
      `Relations: ${relationsRow?.["cnt"] ?? 0}`,
      ...relationsByRel.map((row) => `  ${row["rel"]}: ${row["cnt"]}`),
      "",
      `Embeddings: ${embeddingsRow?.["cnt"] ?? 0} total, ${embeddedActive} active (coverage ${coverage})`
    ].join("\n");
    ctx.ui.notify(out, "info");
  } catch (err) {
    ctx.ui.notify(`Stats failed: ${err.message}`, "warning");
  }
}
function handleExport(ctx, target) {
  if (!target) {
    ctx.ui.notify("Usage: /gsd memory export <path.json>", "warning");
    return;
  }
  try {
    const active = getActiveMemories();
    const relations = active.flatMap(
      (m) => listRelationsFor(m.id).filter((r) => r.from === m.id)
    );
    const sources = listMemorySources(500);
    const payload = {
      version: 1,
      exported_at: (/* @__PURE__ */ new Date()).toISOString(),
      memories: active.map((m) => ({
        id: m.id,
        category: m.category,
        content: m.content,
        confidence: m.confidence,
        hit_count: m.hit_count,
        scope: m.scope,
        tags: m.tags,
        source_unit_type: m.source_unit_type,
        source_unit_id: m.source_unit_id,
        created_at: m.created_at,
        updated_at: m.updated_at
      })),
      relations: relations.map((r) => ({
        from: r.from,
        to: r.to,
        rel: r.rel,
        confidence: r.confidence
      })),
      sources
    };
    const abs = resolvePath(process.cwd(), target);
    writeFileSync(abs, JSON.stringify(payload, null, 2), "utf-8");
    ctx.ui.notify(
      `Exported ${payload.memories.length} memories, ${payload.relations.length} relations, ${payload.sources.length} sources \u2192 ${abs}`,
      "info"
    );
  } catch (err) {
    ctx.ui.notify(`Export failed: ${err.message}`, "error");
  }
}
function handleImport(ctx, target) {
  if (!target) {
    ctx.ui.notify("Usage: /gsd memory import <path.json>", "warning");
    return;
  }
  try {
    const abs = resolvePath(process.cwd(), target);
    const raw = readFileSync(abs, "utf-8");
    const parsed = JSON.parse(raw);
    let memoryCount = 0;
    let relationCount = 0;
    for (const mem of parsed.memories ?? []) {
      if (!mem.category || !mem.content) continue;
      const id = createMemory({
        category: mem.category,
        content: mem.content,
        confidence: mem.confidence,
        scope: mem.scope,
        tags: mem.tags
      });
      if (id) memoryCount++;
    }
    for (const rel of parsed.relations ?? []) {
      if (!rel.from || !rel.to || !rel.rel) continue;
      if (createMemoryRelation(rel.from, rel.to, rel.rel, rel.confidence)) {
        relationCount++;
      }
    }
    ctx.ui.notify(`Imported ${memoryCount} memories and ${relationCount} relations.`, "info");
  } catch (err) {
    ctx.ui.notify(`Import failed: ${err.message}`, "error");
  }
}
function handleDecay(ctx) {
  const decayed = decayStaleMemories(20);
  if (decayed.length === 0) {
    ctx.ui.notify("Decay pass: no stale memories found.", "info");
    return;
  }
  ctx.ui.notify(`Decayed ${decayed.length} stale memor${decayed.length === 1 ? "y" : "ies"}: ${decayed.join(", ")}`, "info");
}
function handleCap(ctx, arg) {
  const max = arg ? Number.parseInt(arg, 10) : 50;
  if (!Number.isFinite(max) || max < 1) {
    ctx.ui.notify("Usage: /gsd memory cap <max>  (default 50)", "warning");
    return;
  }
  enforceMemoryCap(max);
  ctx.ui.notify(`Enforced memory cap of ${max}.`, "info");
}
function handleSources(ctx) {
  const sources = listMemorySources(30);
  if (sources.length === 0) {
    ctx.ui.notify("No memory sources yet. Use `/gsd memory ingest <path|url>` to add one.", "info");
    return;
  }
  const lines = sources.map(
    (s) => `- ${s.id} [${s.kind}${s.scope !== "project" ? `/${s.scope}` : ""}] ${truncate(s.title ?? s.uri ?? s.content, 100)}`
  );
  ctx.ui.notify(lines.join("\n"), "info");
}
async function handleNote(ctx, args) {
  const text = args.positional.join(" ").trim();
  if (!text) {
    ctx.ui.notify('Usage: /gsd memory note "your note"', "warning");
    return;
  }
  try {
    const result = await ingestNote(text, null, {
      scope: args.scope,
      tags: args.tags,
      extract: false
    });
    ctx.ui.notify(summarizeIngest(result), "info");
  } catch (err) {
    ctx.ui.notify(`Note ingest failed: ${err.message}`, "error");
  }
}
async function handleIngest(ctx, args) {
  const target = args.positional[0];
  if (!target) {
    ctx.ui.notify("Usage: /gsd memory ingest <path|url> [--tag a,b] [--scope project|global]", "warning");
    return;
  }
  try {
    const isUrl = /^https?:\/\//i.test(target);
    const result = isUrl ? await ingestUrl(target, null, { scope: args.scope, tags: args.tags, extract: false }) : await ingestFile(target, null, { scope: args.scope, tags: args.tags, extract: false });
    ctx.ui.notify(summarizeIngest(result), "info");
    if (args.extract && result.sourceId) {
      ctx.ui.notify(
        `(Dispatching extraction turn \u2014 use \`/gsd memory extract ${result.sourceId}\` to trigger manually.)`,
        "info"
      );
    }
  } catch (err) {
    ctx.ui.notify(`Ingest failed: ${err.message}`, "error");
  }
}
function handleExtractSource(ctx, pi, id) {
  if (!id) {
    ctx.ui.notify("Usage: /gsd memory extract <SRC-xxx>", "warning");
    return;
  }
  const source = getMemorySource(id);
  if (!source) {
    ctx.ui.notify(`Source not found: ${id}`, "warning");
    return;
  }
  const prompt = buildExtractPrompt(source);
  ctx.ui.notify(`Dispatching extraction turn for ${id}...`, "info");
  pi.sendMessage(
    { customType: "gsd-memory-extract", content: prompt, display: false },
    { triggerTurn: true }
  );
}
function buildExtractPrompt(source) {
  const header = [
    `## Memory extraction request`,
    ``,
    `Source: ${source.id} (${source.kind})`,
    source.title ? `Title: ${source.title}` : null,
    source.uri ? `URI: ${source.uri}` : null
  ].filter(Boolean).join("\n");
  return [
    header,
    "",
    "Read the content below and call the `capture_thought` tool once per durable insight",
    "(architecture, convention, gotcha, preference, environment, pattern). Skip one-off details,",
    "temporary state, and anything secret. Keep each memory to 1\u20133 sentences.",
    "",
    "---",
    "",
    source.content
  ].join("\n");
}
function safeJsonArray(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
}
const _internals = { projectRoot };
export {
  _internals,
  handleMemory
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9jb21tYW5kcy1tZW1vcnkudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogR1NEIENvbW1hbmQgXHUyMDE0IGAvZ3NkIG1lbW9yeWBcbiAqXG4gKiBTdWJjb21tYW5kczpcbiAqICAgbGlzdCAgICAgICAgICAgIFx1MjAxNCBzaG93IHJlY2VudCBhY3RpdmUgbWVtb3JpZXNcbiAqICAgc2hvdyA8aWQ+ICAgICAgIFx1MjAxNCBwcmludCBvbmUgbWVtb3J5XG4gKiAgIGluZ2VzdCA8dXJpPiAgICBcdTIwMTQgcGVyc2lzdCBhIHNvdXJjZSByb3cgKGZpbGUgcGF0aCwgVVJMLCBvciBcIi1cIiBmb3Igc3RkaW4tcGlwZWQgbm90ZSlcbiAqICAgbm90ZSBcIjx0ZXh0PlwiICAgXHUyMDE0IHBlcnNpc3QgYW4gaW5saW5lIG5vdGUgYXMgYSBzb3VyY2VcbiAqICAgZm9yZ2V0IDxpZD4gICAgIFx1MjAxNCBzdXBlcnNlZGUgYSBtZW1vcnkgKENBUF9FWENFRURFRCBzZW50aW5lbClcbiAqICAgc3RhdHMgICAgICAgICAgIFx1MjAxNCBjYXRlZ29yeSAvIHNjb3BlIGNvdW50cyArIHNvdXJjZSBjb3VudFxuICogICBzb3VyY2VzICAgICAgICAgXHUyMDE0IGxpc3QgcmVjZW50IG1lbW9yeV9zb3VyY2VzIHJvd3NcbiAqICAgZXh0cmFjdCA8c3JjPiAgIFx1MjAxNCBkaXNwYXRjaCBhbiBhZ2VudCB0dXJuIHRoYXQgZGlzdGlscyBhIHNvdXJjZSBpbnRvIG1lbW9yaWVzXG4gKi9cblxuaW1wb3J0IHsgcmVhZEZpbGVTeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IHJlc29sdmUgYXMgcmVzb2x2ZVBhdGggfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbmltcG9ydCB0eXBlIHsgRXh0ZW5zaW9uQVBJLCBFeHRlbnNpb25Db21tYW5kQ29udGV4dCB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuXG5pbXBvcnQgeyBwcm9qZWN0Um9vdCB9IGZyb20gXCIuL2NvbW1hbmRzL2NvbnRleHQuanNcIjtcbmltcG9ydCB7IGluZ2VzdEZpbGUsIGluZ2VzdE5vdGUsIGluZ2VzdFVybCwgc3VtbWFyaXplSW5nZXN0IH0gZnJvbSBcIi4vbWVtb3J5LWluZ2VzdC5qc1wiO1xuaW1wb3J0IHsgZ2V0TWVtb3J5U291cmNlLCBsaXN0TWVtb3J5U291cmNlcyB9IGZyb20gXCIuL21lbW9yeS1zb3VyY2Utc3RvcmUuanNcIjtcbmltcG9ydCB7XG4gIGNyZWF0ZU1lbW9yeSxcbiAgZGVjYXlTdGFsZU1lbW9yaWVzLFxuICBlbmZvcmNlTWVtb3J5Q2FwLFxuICBnZXRBY3RpdmVNZW1vcmllcyxcbiAgZ2V0QWN0aXZlTWVtb3JpZXNSYW5rZWQsXG4gIHN1cGVyc2VkZU1lbW9yeSxcbn0gZnJvbSBcIi4vbWVtb3J5LXN0b3JlLmpzXCI7XG5pbXBvcnQgeyBfZ2V0QWRhcHRlciwgaXNEYkF2YWlsYWJsZSB9IGZyb20gXCIuL2dzZC1kYi5qc1wiO1xuaW1wb3J0IHsgY3JlYXRlTWVtb3J5UmVsYXRpb24sIGxpc3RSZWxhdGlvbnNGb3IgfSBmcm9tIFwiLi9tZW1vcnktcmVsYXRpb25zLmpzXCI7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBBcmcgcGFyc2luZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuaW50ZXJmYWNlIE1lbW9yeUNtZEFyZ3Mge1xuICBzdWI6IHN0cmluZztcbiAgcG9zaXRpb25hbDogc3RyaW5nW107XG4gIHRhZ3M6IHN0cmluZ1tdO1xuICBzY29wZT86IHN0cmluZztcbiAgZXh0cmFjdDogYm9vbGVhbjtcbn1cblxuZnVuY3Rpb24gcGFyc2VBcmdzKHJhdzogc3RyaW5nKTogTWVtb3J5Q21kQXJncyB7XG4gIGNvbnN0IHRva2VucyA9IHNwbGl0QXJncyhyYXcpO1xuICBjb25zdCBzdWIgPSAodG9rZW5zLnNoaWZ0KCkgPz8gXCJsaXN0XCIpLnRvTG93ZXJDYXNlKCk7XG4gIGNvbnN0IHBvc2l0aW9uYWw6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHRhZ3M6IHN0cmluZ1tdID0gW107XG4gIGxldCBzY29wZTogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBsZXQgZXh0cmFjdCA9IGZhbHNlO1xuXG4gIGZvciAobGV0IGkgPSAwOyBpIDwgdG9rZW5zLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgdG9rID0gdG9rZW5zW2ldO1xuICAgIGlmICh0b2sgPT09IFwiLS10YWdcIiAmJiBpICsgMSA8IHRva2Vucy5sZW5ndGgpIHtcbiAgICAgIHRhZ3MucHVzaCguLi50b2tlbnNbKytpXS5zcGxpdChcIixcIikubWFwKCh0KSA9PiB0LnRyaW0oKSkuZmlsdGVyKEJvb2xlYW4pKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAodG9rLnN0YXJ0c1dpdGgoXCItLXRhZz1cIikpIHtcbiAgICAgIHRhZ3MucHVzaCguLi50b2suc2xpY2UoXCItLXRhZz1cIi5sZW5ndGgpLnNwbGl0KFwiLFwiKS5tYXAoKHQpID0+IHQudHJpbSgpKS5maWx0ZXIoQm9vbGVhbikpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmICh0b2sgPT09IFwiLS1zY29wZVwiICYmIGkgKyAxIDwgdG9rZW5zLmxlbmd0aCkge1xuICAgICAgc2NvcGUgPSB0b2tlbnNbKytpXTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAodG9rLnN0YXJ0c1dpdGgoXCItLXNjb3BlPVwiKSkge1xuICAgICAgc2NvcGUgPSB0b2suc2xpY2UoXCItLXNjb3BlPVwiLmxlbmd0aCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKHRvayA9PT0gXCItLWV4dHJhY3RcIikge1xuICAgICAgZXh0cmFjdCA9IHRydWU7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKHRvayA9PT0gXCItLW5vLWV4dHJhY3RcIikge1xuICAgICAgZXh0cmFjdCA9IGZhbHNlO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIHBvc2l0aW9uYWwucHVzaCh0b2spO1xuICB9XG4gIHJldHVybiB7IHN1YiwgcG9zaXRpb25hbCwgdGFncywgc2NvcGUsIGV4dHJhY3QgfTtcbn1cblxuZnVuY3Rpb24gc3BsaXRBcmdzKHJhdzogc3RyaW5nKTogc3RyaW5nW10ge1xuICBjb25zdCB0b2tlbnM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHJlID0gL1wiKFteXCJdKilcInwnKFteJ10qKSd8KFxcUyspL2c7XG4gIGxldCBtYXRjaDogUmVnRXhwRXhlY0FycmF5IHwgbnVsbDtcbiAgd2hpbGUgKChtYXRjaCA9IHJlLmV4ZWMocmF3KSkgIT09IG51bGwpIHtcbiAgICB0b2tlbnMucHVzaChtYXRjaFsxXSA/PyBtYXRjaFsyXSA/PyBtYXRjaFszXSk7XG4gIH1cbiAgcmV0dXJuIHRva2Vucztcbn1cblxuZnVuY3Rpb24gdHJ1bmNhdGUodGV4dDogc3RyaW5nLCBtYXg6IG51bWJlcik6IHN0cmluZyB7XG4gIGlmICh0ZXh0Lmxlbmd0aCA8PSBtYXgpIHJldHVybiB0ZXh0O1xuICByZXR1cm4gYCR7dGV4dC5zbGljZSgwLCBtYXggLSAxKX1cdTIwMjZgO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgSGFuZGxlciBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZU1lbW9yeShcbiAgYXJnczogc3RyaW5nLFxuICBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LFxuICBwaTogRXh0ZW5zaW9uQVBJLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHBhcnNlZCA9IHBhcnNlQXJncyhhcmdzKTtcblxuICAvLyBgL2dzZCBtZW1vcnlgIG9yIGAvZ3NkIG1lbW9yeSBoZWxwYFxuICBpZiAocGFyc2VkLnN1YiA9PT0gXCJcIiB8fCBwYXJzZWQuc3ViID09PSBcImhlbHBcIikge1xuICAgIGN0eC51aS5ub3RpZnkodXNhZ2UoKSwgXCJpbmZvXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIE1vc3Qgc3ViY29tbWFuZHMgbmVlZCB0aGUgREIuXG4gIGF3YWl0IGVuc3VyZURiKCk7XG5cbiAgc3dpdGNoIChwYXJzZWQuc3ViKSB7XG4gICAgY2FzZSBcImxpc3RcIjpcbiAgICAgIGhhbmRsZUxpc3QoY3R4KTtcbiAgICAgIHJldHVybjtcbiAgICBjYXNlIFwic2hvd1wiOlxuICAgICAgaGFuZGxlU2hvdyhjdHgsIHBhcnNlZC5wb3NpdGlvbmFsWzBdKTtcbiAgICAgIHJldHVybjtcbiAgICBjYXNlIFwiZm9yZ2V0XCI6XG4gICAgICBoYW5kbGVGb3JnZXQoY3R4LCBwYXJzZWQucG9zaXRpb25hbFswXSk7XG4gICAgICByZXR1cm47XG4gICAgY2FzZSBcInN0YXRzXCI6XG4gICAgICBoYW5kbGVTdGF0cyhjdHgpO1xuICAgICAgcmV0dXJuO1xuICAgIGNhc2UgXCJzb3VyY2VzXCI6XG4gICAgICBoYW5kbGVTb3VyY2VzKGN0eCk7XG4gICAgICByZXR1cm47XG4gICAgY2FzZSBcIm5vdGVcIjpcbiAgICAgIGF3YWl0IGhhbmRsZU5vdGUoY3R4LCBwYXJzZWQpO1xuICAgICAgcmV0dXJuO1xuICAgIGNhc2UgXCJpbmdlc3RcIjpcbiAgICAgIGF3YWl0IGhhbmRsZUluZ2VzdChjdHgsIHBhcnNlZCk7XG4gICAgICByZXR1cm47XG4gICAgY2FzZSBcImV4dHJhY3RcIjpcbiAgICAgIGhhbmRsZUV4dHJhY3RTb3VyY2UoY3R4LCBwaSwgcGFyc2VkLnBvc2l0aW9uYWxbMF0pO1xuICAgICAgcmV0dXJuO1xuICAgIGNhc2UgXCJleHBvcnRcIjpcbiAgICAgIGhhbmRsZUV4cG9ydChjdHgsIHBhcnNlZC5wb3NpdGlvbmFsWzBdKTtcbiAgICAgIHJldHVybjtcbiAgICBjYXNlIFwiaW1wb3J0XCI6XG4gICAgICBoYW5kbGVJbXBvcnQoY3R4LCBwYXJzZWQucG9zaXRpb25hbFswXSk7XG4gICAgICByZXR1cm47XG4gICAgY2FzZSBcImRlY2F5XCI6XG4gICAgICBoYW5kbGVEZWNheShjdHgpO1xuICAgICAgcmV0dXJuO1xuICAgIGNhc2UgXCJjYXBcIjpcbiAgICAgIGhhbmRsZUNhcChjdHgsIHBhcnNlZC5wb3NpdGlvbmFsWzBdKTtcbiAgICAgIHJldHVybjtcbiAgICBkZWZhdWx0OlxuICAgICAgY3R4LnVpLm5vdGlmeShgVW5rbm93biBzdWJjb21tYW5kIFwiJHtwYXJzZWQuc3VifVwiLiAke3VzYWdlKCl9YCwgXCJ3YXJuaW5nXCIpO1xuICAgICAgcmV0dXJuO1xuICB9XG59XG5cbmZ1bmN0aW9uIHVzYWdlKCk6IHN0cmluZyB7XG4gIHJldHVybiBbXG4gICAgXCJVc2FnZTogL2dzZCBtZW1vcnkgPHN1YmNvbW1hbmQ+XCIsXG4gICAgXCIgIGxpc3QgICAgICAgICAgICAgICAgICAgIGxpc3QgcmVjZW50IGFjdGl2ZSBtZW1vcmllc1wiLFxuICAgIFwiICBzaG93IDxNRU0jIyM+ICAgICAgICAgICBwcmludCBvbmUgbWVtb3J5XCIsXG4gICAgXCIgIGZvcmdldCA8TUVNIyMjPiAgICAgICAgIHN1cGVyc2VkZSBhIG1lbW9yeVwiLFxuICAgIFwiICBzdGF0cyAgICAgICAgICAgICAgICAgICBjb3VudHMgYnkgY2F0ZWdvcnkgLyBzY29wZSAvIHNvdXJjZXMgLyBlZGdlc1wiLFxuICAgIFwiICBzb3VyY2VzICAgICAgICAgICAgICAgICBsaXN0IHJlY2VudCBtZW1vcnlfc291cmNlc1wiLFxuICAgICcgIG5vdGUgXCI8dGV4dD5cIiAgICAgICAgICAgaW5nZXN0IGFuIGlubGluZSBub3RlIGFzIGEgc291cmNlJyxcbiAgICBcIiAgaW5nZXN0IDxwYXRofHVybD4gICAgICAgaW5nZXN0IGEgbG9jYWwgZmlsZSBwYXRoIG9yIFVSTFwiLFxuICAgIFwiICBleHRyYWN0IDxTUkMteHh4PiAgICAgICBkaXNwYXRjaCBhbiBMTE0gdHVybiB0byBleHRyYWN0IG1lbW9yaWVzIGZyb20gYSBzb3VyY2VcIixcbiAgICBcIiAgZXhwb3J0IDxwYXRoLmpzb24+ICAgICAgZHVtcCBtZW1vcmllcyArIHJlbGF0aW9ucyArIHNvdXJjZXMgdG8gSlNPTlwiLFxuICAgIFwiICBpbXBvcnQgPHBhdGguanNvbj4gICAgICBsb2FkIGEgcHJldmlvdXMgZXhwb3J0IChpZGVtcG90ZW50KVwiLFxuICAgIFwiICBkZWNheSAgICAgICAgICAgICAgICAgICBydW4gdGhlIHN0YWxlLW1lbW9yeSBkZWNheSBwYXNzIGltbWVkaWF0ZWx5XCIsXG4gICAgXCIgIGNhcCBbTl0gICAgICAgICAgICAgICAgIGVuZm9yY2UgdGhlIG1lbW9yeSBjYXAgKGRlZmF1bHQgNTApXCIsXG4gICAgXCJcIixcbiAgICBcIk9wdGlvbnM6IC0tdGFnIGEsYiAgIC0tc2NvcGUgcHJvamVjdHxnbG9iYWx8PGN1c3RvbT4gICAtLWV4dHJhY3RcIixcbiAgXS5qb2luKFwiXFxuXCIpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBlbnN1cmVEYigpOiBQcm9taXNlPHZvaWQ+IHtcbiAgaWYgKGlzRGJBdmFpbGFibGUoKSkgcmV0dXJuO1xuICBjb25zdCB7IGVuc3VyZURiT3BlbiB9ID0gYXdhaXQgaW1wb3J0KFwiLi9ib290c3RyYXAvZHluYW1pYy10b29scy5qc1wiKTtcbiAgYXdhaXQgZW5zdXJlRGJPcGVuKCk7XG59XG5cbmZ1bmN0aW9uIGhhbmRsZUxpc3QoY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCk6IHZvaWQge1xuICBpZiAoIWlzRGJBdmFpbGFibGUoKSkge1xuICAgIGN0eC51aS5ub3RpZnkoXCJObyBHU0QgZGF0YWJhc2UgYXZhaWxhYmxlLlwiLCBcIndhcm5pbmdcIik7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IG1lbW9yaWVzID0gZ2V0QWN0aXZlTWVtb3JpZXNSYW5rZWQoNTApO1xuICBpZiAobWVtb3JpZXMubGVuZ3RoID09PSAwKSB7XG4gICAgY3R4LnVpLm5vdGlmeShcIk5vIGFjdGl2ZSBtZW1vcmllcy5cIiwgXCJpbmZvXCIpO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBsaW5lcyA9IG1lbW9yaWVzLm1hcChcbiAgICAobSkgPT5cbiAgICAgIGAtIFske20uaWR9XSAoJHttLmNhdGVnb3J5fSwgY29uZiAke20uY29uZmlkZW5jZS50b0ZpeGVkKDIpfSwgaGl0cyAke20uaGl0X2NvdW50fSR7bS5zY29wZSAmJiBtLnNjb3BlICE9PSBcInByb2plY3RcIiA/IGAsICR7bS5zY29wZX1gIDogXCJcIn0pICR7dHJ1bmNhdGUobS5jb250ZW50LCAxMDApfWAsXG4gICk7XG4gIGN0eC51aS5ub3RpZnkobGluZXMuam9pbihcIlxcblwiKSwgXCJpbmZvXCIpO1xufVxuXG5mdW5jdGlvbiBoYW5kbGVTaG93KGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsIGlkOiBzdHJpbmcgfCB1bmRlZmluZWQpOiB2b2lkIHtcbiAgaWYgKCFpZCkge1xuICAgIGN0eC51aS5ub3RpZnkoXCJVc2FnZTogL2dzZCBtZW1vcnkgc2hvdyA8TUVNIyMjPlwiLCBcIndhcm5pbmdcIik7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IGFkYXB0ZXIgPSBfZ2V0QWRhcHRlcigpO1xuICBpZiAoIWFkYXB0ZXIpIHtcbiAgICBjdHgudWkubm90aWZ5KFwiTm8gR1NEIGRhdGFiYXNlIGF2YWlsYWJsZS5cIiwgXCJ3YXJuaW5nXCIpO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCByb3cgPSBhZGFwdGVyLnByZXBhcmUoXCJTRUxFQ1QgKiBGUk9NIG1lbW9yaWVzIFdIRVJFIGlkID0gOmlkXCIpLmdldCh7IFwiOmlkXCI6IGlkIH0pO1xuICBpZiAoIXJvdykge1xuICAgIGN0eC51aS5ub3RpZnkoYE1lbW9yeSBub3QgZm91bmQ6ICR7aWR9YCwgXCJ3YXJuaW5nXCIpO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCB0YWdzID0gcm93W1widGFnc1wiXSA/IHNhZmVKc29uQXJyYXkocm93W1widGFnc1wiXSBhcyBzdHJpbmcpIDogW107XG4gIGNvbnN0IGxpbmVzID0gW1xuICAgIGBJRDogJHtyb3dbXCJpZFwiXX1gLFxuICAgIGBDYXRlZ29yeTogJHtyb3dbXCJjYXRlZ29yeVwiXX1gLFxuICAgIGBTY29wZTogJHtyb3dbXCJzY29wZVwiXSA/PyBcInByb2plY3RcIn1gLFxuICAgIGBDb25maWRlbmNlOiAke051bWJlcihyb3dbXCJjb25maWRlbmNlXCJdKS50b0ZpeGVkKDIpfWAsXG4gICAgYEhpdHM6ICR7cm93W1wiaGl0X2NvdW50XCJdfWAsXG4gICAgYENyZWF0ZWQ6ICR7cm93W1wiY3JlYXRlZF9hdFwiXX1gLFxuICAgIGBVcGRhdGVkOiAke3Jvd1tcInVwZGF0ZWRfYXRcIl19YCxcbiAgICB0YWdzLmxlbmd0aCA+IDAgPyBgVGFnczogJHt0YWdzLmpvaW4oXCIsIFwiKX1gIDogbnVsbCxcbiAgICByb3dbXCJzdXBlcnNlZGVkX2J5XCJdID8gYFN1cGVyc2VkZWQgYnk6ICR7cm93W1wic3VwZXJzZWRlZF9ieVwiXX1gIDogbnVsbCxcbiAgICByb3dbXCJzb3VyY2VfdW5pdF90eXBlXCJdID8gYFNvdXJjZTogJHtyb3dbXCJzb3VyY2VfdW5pdF90eXBlXCJdfS8ke3Jvd1tcInNvdXJjZV91bml0X2lkXCJdfWAgOiBudWxsLFxuICAgIFwiXCIsXG4gICAgU3RyaW5nKHJvd1tcImNvbnRlbnRcIl0pLFxuICBdXG4gICAgLmZpbHRlcigobGluZSk6IGxpbmUgaXMgc3RyaW5nID0+IGxpbmUgIT09IG51bGwpXG4gICAgLmpvaW4oXCJcXG5cIik7XG4gIGN0eC51aS5ub3RpZnkobGluZXMsIFwiaW5mb1wiKTtcbn1cblxuZnVuY3Rpb24gaGFuZGxlRm9yZ2V0KGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsIGlkOiBzdHJpbmcgfCB1bmRlZmluZWQpOiB2b2lkIHtcbiAgaWYgKCFpZCkge1xuICAgIGN0eC51aS5ub3RpZnkoXCJVc2FnZTogL2dzZCBtZW1vcnkgZm9yZ2V0IDxNRU0jIyM+XCIsIFwid2FybmluZ1wiKTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3Qgb2sgPSBzdXBlcnNlZGVNZW1vcnkoaWQsIFwiQ0FQX0VYQ0VFREVEXCIpO1xuICBpZiAoIW9rKSB7XG4gICAgY3R4LnVpLm5vdGlmeShgRmFpbGVkIHRvIGZvcmdldCAke2lkfS5gLCBcIndhcm5pbmdcIik7XG4gICAgcmV0dXJuO1xuICB9XG4gIGN0eC51aS5ub3RpZnkoYEZvcmdvdCAke2lkfS5gLCBcImluZm9cIik7XG59XG5cbmZ1bmN0aW9uIGhhbmRsZVN0YXRzKGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQpOiB2b2lkIHtcbiAgY29uc3QgYWRhcHRlciA9IF9nZXRBZGFwdGVyKCk7XG4gIGlmICghYWRhcHRlcikge1xuICAgIGN0eC51aS5ub3RpZnkoXCJObyBHU0QgZGF0YWJhc2UgYXZhaWxhYmxlLlwiLCBcIndhcm5pbmdcIik7XG4gICAgcmV0dXJuO1xuICB9XG4gIHRyeSB7XG4gICAgY29uc3QgYWN0aXZlUm93ID0gYWRhcHRlclxuICAgICAgLnByZXBhcmUoXCJTRUxFQ1QgY291bnQoKikgYXMgY250IEZST00gbWVtb3JpZXMgV0hFUkUgc3VwZXJzZWRlZF9ieSBJUyBOVUxMXCIpXG4gICAgICAuZ2V0KCk7XG4gICAgY29uc3Qgc3VwZXJzZWRlZFJvdyA9IGFkYXB0ZXJcbiAgICAgIC5wcmVwYXJlKFwiU0VMRUNUIGNvdW50KCopIGFzIGNudCBGUk9NIG1lbW9yaWVzIFdIRVJFIHN1cGVyc2VkZWRfYnkgSVMgTk9UIE5VTExcIilcbiAgICAgIC5nZXQoKTtcbiAgICBjb25zdCBieUNhdGVnb3J5ID0gYWRhcHRlclxuICAgICAgLnByZXBhcmUoXG4gICAgICAgIFwiU0VMRUNUIGNhdGVnb3J5LCBjb3VudCgqKSBhcyBjbnQgRlJPTSBtZW1vcmllcyBXSEVSRSBzdXBlcnNlZGVkX2J5IElTIE5VTEwgR1JPVVAgQlkgY2F0ZWdvcnkgT1JERVIgQlkgY250IERFU0NcIixcbiAgICAgIClcbiAgICAgIC5hbGwoKTtcbiAgICBjb25zdCBieVNjb3BlID0gYWRhcHRlclxuICAgICAgLnByZXBhcmUoXG4gICAgICAgIFwiU0VMRUNUIHNjb3BlLCBjb3VudCgqKSBhcyBjbnQgRlJPTSBtZW1vcmllcyBXSEVSRSBzdXBlcnNlZGVkX2J5IElTIE5VTEwgR1JPVVAgQlkgc2NvcGUgT1JERVIgQlkgY250IERFU0NcIixcbiAgICAgIClcbiAgICAgIC5hbGwoKTtcbiAgICBjb25zdCBzb3VyY2VzUm93ID0gYWRhcHRlci5wcmVwYXJlKFwiU0VMRUNUIGNvdW50KCopIGFzIGNudCBGUk9NIG1lbW9yeV9zb3VyY2VzXCIpLmdldCgpO1xuICAgIGNvbnN0IHNvdXJjZXNCeUtpbmQgPSBhZGFwdGVyXG4gICAgICAucHJlcGFyZShcIlNFTEVDVCBraW5kLCBjb3VudCgqKSBhcyBjbnQgRlJPTSBtZW1vcnlfc291cmNlcyBHUk9VUCBCWSBraW5kIE9SREVSIEJZIGNudCBERVNDXCIpXG4gICAgICAuYWxsKCk7XG4gICAgY29uc3QgcmVsYXRpb25zUm93ID0gYWRhcHRlci5wcmVwYXJlKFwiU0VMRUNUIGNvdW50KCopIGFzIGNudCBGUk9NIG1lbW9yeV9yZWxhdGlvbnNcIikuZ2V0KCk7XG4gICAgY29uc3QgcmVsYXRpb25zQnlSZWwgPSBhZGFwdGVyXG4gICAgICAucHJlcGFyZShcIlNFTEVDVCByZWwsIGNvdW50KCopIGFzIGNudCBGUk9NIG1lbW9yeV9yZWxhdGlvbnMgR1JPVVAgQlkgcmVsIE9SREVSIEJZIGNudCBERVNDXCIpXG4gICAgICAuYWxsKCk7XG4gICAgY29uc3QgZW1iZWRkaW5nc1JvdyA9IGFkYXB0ZXIucHJlcGFyZShcIlNFTEVDVCBjb3VudCgqKSBhcyBjbnQgRlJPTSBtZW1vcnlfZW1iZWRkaW5nc1wiKS5nZXQoKTtcbiAgICBjb25zdCBlbWJlZGRlZEFjdGl2ZVJvdyA9IGFkYXB0ZXJcbiAgICAgIC5wcmVwYXJlKFxuICAgICAgICBgU0VMRUNUIGNvdW50KCopIGFzIGNudCBGUk9NIG1lbW9yeV9lbWJlZGRpbmdzIGVcbiAgICAgICAgIEpPSU4gbWVtb3JpZXMgbSBPTiBtLmlkID0gZS5tZW1vcnlfaWRcbiAgICAgICAgIFdIRVJFIG0uc3VwZXJzZWRlZF9ieSBJUyBOVUxMYCxcbiAgICAgIClcbiAgICAgIC5nZXQoKTtcbiAgICBjb25zdCBhY3RpdmVDb3VudCA9IChhY3RpdmVSb3c/LltcImNudFwiXSBhcyBudW1iZXIpID8/IDA7XG4gICAgY29uc3QgZW1iZWRkZWRBY3RpdmUgPSAoZW1iZWRkZWRBY3RpdmVSb3c/LltcImNudFwiXSBhcyBudW1iZXIpID8/IDA7XG4gICAgY29uc3QgY292ZXJhZ2UgPSBhY3RpdmVDb3VudCA+IDAgPyBgJHtNYXRoLnJvdW5kKChlbWJlZGRlZEFjdGl2ZSAvIGFjdGl2ZUNvdW50KSAqIDEwMCl9JWAgOiBcIm4vYVwiO1xuXG4gICAgY29uc3Qgb3V0ID0gW1xuICAgICAgYEFjdGl2ZSBtZW1vcmllczogJHthY3RpdmVDb3VudH1gLFxuICAgICAgYFN1cGVyc2VkZWQ6ICR7c3VwZXJzZWRlZFJvdz8uW1wiY250XCJdID8/IDB9YCxcbiAgICAgIFwiXCIsXG4gICAgICBcIkJ5IGNhdGVnb3J5OlwiLFxuICAgICAgLi4uYnlDYXRlZ29yeS5tYXAoKHJvdykgPT4gYCAgJHtyb3dbXCJjYXRlZ29yeVwiXX06ICR7cm93W1wiY250XCJdfWApLFxuICAgICAgXCJcIixcbiAgICAgIFwiQnkgc2NvcGU6XCIsXG4gICAgICAuLi5ieVNjb3BlLm1hcCgocm93KSA9PiBgICAke3Jvd1tcInNjb3BlXCJdfTogJHtyb3dbXCJjbnRcIl19YCksXG4gICAgICBcIlwiLFxuICAgICAgYE1lbW9yeSBzb3VyY2VzOiAke3NvdXJjZXNSb3c/LltcImNudFwiXSA/PyAwfWAsXG4gICAgICAuLi5zb3VyY2VzQnlLaW5kLm1hcCgocm93KSA9PiBgICAke3Jvd1tcImtpbmRcIl19OiAke3Jvd1tcImNudFwiXX1gKSxcbiAgICAgIFwiXCIsXG4gICAgICBgUmVsYXRpb25zOiAke3JlbGF0aW9uc1Jvdz8uW1wiY250XCJdID8/IDB9YCxcbiAgICAgIC4uLnJlbGF0aW9uc0J5UmVsLm1hcCgocm93KSA9PiBgICAke3Jvd1tcInJlbFwiXX06ICR7cm93W1wiY250XCJdfWApLFxuICAgICAgXCJcIixcbiAgICAgIGBFbWJlZGRpbmdzOiAke2VtYmVkZGluZ3NSb3c/LltcImNudFwiXSA/PyAwfSB0b3RhbCwgJHtlbWJlZGRlZEFjdGl2ZX0gYWN0aXZlIChjb3ZlcmFnZSAke2NvdmVyYWdlfSlgLFxuICAgIF0uam9pbihcIlxcblwiKTtcbiAgICBjdHgudWkubm90aWZ5KG91dCwgXCJpbmZvXCIpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBjdHgudWkubm90aWZ5KGBTdGF0cyBmYWlsZWQ6ICR7KGVyciBhcyBFcnJvcikubWVzc2FnZX1gLCBcIndhcm5pbmdcIik7XG4gIH1cbn1cblxuZnVuY3Rpb24gaGFuZGxlRXhwb3J0KGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsIHRhcmdldDogc3RyaW5nIHwgdW5kZWZpbmVkKTogdm9pZCB7XG4gIGlmICghdGFyZ2V0KSB7XG4gICAgY3R4LnVpLm5vdGlmeShcIlVzYWdlOiAvZ3NkIG1lbW9yeSBleHBvcnQgPHBhdGguanNvbj5cIiwgXCJ3YXJuaW5nXCIpO1xuICAgIHJldHVybjtcbiAgfVxuICB0cnkge1xuICAgIGNvbnN0IGFjdGl2ZSA9IGdldEFjdGl2ZU1lbW9yaWVzKCk7XG4gICAgY29uc3QgcmVsYXRpb25zID0gYWN0aXZlLmZsYXRNYXAoKG0pID0+XG4gICAgICBsaXN0UmVsYXRpb25zRm9yKG0uaWQpLmZpbHRlcigocikgPT4gci5mcm9tID09PSBtLmlkKSxcbiAgICApO1xuICAgIGNvbnN0IHNvdXJjZXMgPSBsaXN0TWVtb3J5U291cmNlcyg1MDApO1xuICAgIGNvbnN0IHBheWxvYWQgPSB7XG4gICAgICB2ZXJzaW9uOiAxLFxuICAgICAgZXhwb3J0ZWRfYXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgIG1lbW9yaWVzOiBhY3RpdmUubWFwKChtKSA9PiAoe1xuICAgICAgICBpZDogbS5pZCxcbiAgICAgICAgY2F0ZWdvcnk6IG0uY2F0ZWdvcnksXG4gICAgICAgIGNvbnRlbnQ6IG0uY29udGVudCxcbiAgICAgICAgY29uZmlkZW5jZTogbS5jb25maWRlbmNlLFxuICAgICAgICBoaXRfY291bnQ6IG0uaGl0X2NvdW50LFxuICAgICAgICBzY29wZTogbS5zY29wZSxcbiAgICAgICAgdGFnczogbS50YWdzLFxuICAgICAgICBzb3VyY2VfdW5pdF90eXBlOiBtLnNvdXJjZV91bml0X3R5cGUsXG4gICAgICAgIHNvdXJjZV91bml0X2lkOiBtLnNvdXJjZV91bml0X2lkLFxuICAgICAgICBjcmVhdGVkX2F0OiBtLmNyZWF0ZWRfYXQsXG4gICAgICAgIHVwZGF0ZWRfYXQ6IG0udXBkYXRlZF9hdCxcbiAgICAgIH0pKSxcbiAgICAgIHJlbGF0aW9uczogcmVsYXRpb25zLm1hcCgocikgPT4gKHtcbiAgICAgICAgZnJvbTogci5mcm9tLFxuICAgICAgICB0bzogci50byxcbiAgICAgICAgcmVsOiByLnJlbCxcbiAgICAgICAgY29uZmlkZW5jZTogci5jb25maWRlbmNlLFxuICAgICAgfSkpLFxuICAgICAgc291cmNlcyxcbiAgICB9O1xuICAgIGNvbnN0IGFicyA9IHJlc29sdmVQYXRoKHByb2Nlc3MuY3dkKCksIHRhcmdldCk7XG4gICAgd3JpdGVGaWxlU3luYyhhYnMsIEpTT04uc3RyaW5naWZ5KHBheWxvYWQsIG51bGwsIDIpLCBcInV0Zi04XCIpO1xuICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICBgRXhwb3J0ZWQgJHtwYXlsb2FkLm1lbW9yaWVzLmxlbmd0aH0gbWVtb3JpZXMsICR7cGF5bG9hZC5yZWxhdGlvbnMubGVuZ3RofSByZWxhdGlvbnMsICR7cGF5bG9hZC5zb3VyY2VzLmxlbmd0aH0gc291cmNlcyBcdTIxOTIgJHthYnN9YCxcbiAgICAgIFwiaW5mb1wiLFxuICAgICk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGN0eC51aS5ub3RpZnkoYEV4cG9ydCBmYWlsZWQ6ICR7KGVyciBhcyBFcnJvcikubWVzc2FnZX1gLCBcImVycm9yXCIpO1xuICB9XG59XG5cbmludGVyZmFjZSBFeHBvcnRlZE1lbW9yeSB7XG4gIGlkPzogc3RyaW5nO1xuICBjYXRlZ29yeTogc3RyaW5nO1xuICBjb250ZW50OiBzdHJpbmc7XG4gIGNvbmZpZGVuY2U/OiBudW1iZXI7XG4gIHNjb3BlPzogc3RyaW5nO1xuICB0YWdzPzogc3RyaW5nW107XG59XG5cbmludGVyZmFjZSBFeHBvcnRlZFJlbGF0aW9uIHtcbiAgZnJvbTogc3RyaW5nO1xuICB0bzogc3RyaW5nO1xuICByZWw6IHN0cmluZztcbiAgY29uZmlkZW5jZT86IG51bWJlcjtcbn1cblxuZnVuY3Rpb24gaGFuZGxlSW1wb3J0KGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsIHRhcmdldDogc3RyaW5nIHwgdW5kZWZpbmVkKTogdm9pZCB7XG4gIGlmICghdGFyZ2V0KSB7XG4gICAgY3R4LnVpLm5vdGlmeShcIlVzYWdlOiAvZ3NkIG1lbW9yeSBpbXBvcnQgPHBhdGguanNvbj5cIiwgXCJ3YXJuaW5nXCIpO1xuICAgIHJldHVybjtcbiAgfVxuICB0cnkge1xuICAgIGNvbnN0IGFicyA9IHJlc29sdmVQYXRoKHByb2Nlc3MuY3dkKCksIHRhcmdldCk7XG4gICAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKGFicywgXCJ1dGYtOFwiKTtcbiAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHJhdykgYXMgeyBtZW1vcmllcz86IEV4cG9ydGVkTWVtb3J5W107IHJlbGF0aW9ucz86IEV4cG9ydGVkUmVsYXRpb25bXSB9O1xuXG4gICAgbGV0IG1lbW9yeUNvdW50ID0gMDtcbiAgICBsZXQgcmVsYXRpb25Db3VudCA9IDA7XG5cbiAgICBmb3IgKGNvbnN0IG1lbSBvZiBwYXJzZWQubWVtb3JpZXMgPz8gW10pIHtcbiAgICAgIGlmICghbWVtLmNhdGVnb3J5IHx8ICFtZW0uY29udGVudCkgY29udGludWU7XG4gICAgICAvLyBjcmVhdGVNZW1vcnkgYWxsb2NhdGVzIGEgZnJlc2ggc2VxIFx1MjE5MiBuZXcgTUVNIyMjIGlkOyBpbXBvcnRzIHJlcGxheVxuICAgICAgLy8gY29udGVudCByYXRoZXIgdGhhbiBwcmVzZXJ2aW5nIHRoZSBvbGQgSUQuIFJlbGF0aW9ucyBmcm9tIHRoZSBleHBvcnRcbiAgICAgIC8vIGZpbGUgc3RpbGwgcmVmZXJlbmNlIHRoZSBvbGQgSURzLCBzbyBvbmx5IGxvc3NsZXNzIHJvdW5kLXRyaXBzIGludG9cbiAgICAgIC8vIGFuIGVtcHR5IERCIHByZXNlcnZlIHRoZSBncmFwaC5cbiAgICAgIGNvbnN0IGlkID0gY3JlYXRlTWVtb3J5KHtcbiAgICAgICAgY2F0ZWdvcnk6IG1lbS5jYXRlZ29yeSxcbiAgICAgICAgY29udGVudDogbWVtLmNvbnRlbnQsXG4gICAgICAgIGNvbmZpZGVuY2U6IG1lbS5jb25maWRlbmNlLFxuICAgICAgICBzY29wZTogbWVtLnNjb3BlLFxuICAgICAgICB0YWdzOiBtZW0udGFncyxcbiAgICAgIH0pO1xuICAgICAgaWYgKGlkKSBtZW1vcnlDb3VudCsrO1xuICAgIH1cblxuICAgIGZvciAoY29uc3QgcmVsIG9mIHBhcnNlZC5yZWxhdGlvbnMgPz8gW10pIHtcbiAgICAgIGlmICghcmVsLmZyb20gfHwgIXJlbC50byB8fCAhcmVsLnJlbCkgY29udGludWU7XG4gICAgICBpZiAoY3JlYXRlTWVtb3J5UmVsYXRpb24ocmVsLmZyb20sIHJlbC50bywgcmVsLnJlbCBhcyBuZXZlciwgcmVsLmNvbmZpZGVuY2UpKSB7XG4gICAgICAgIHJlbGF0aW9uQ291bnQrKztcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjdHgudWkubm90aWZ5KGBJbXBvcnRlZCAke21lbW9yeUNvdW50fSBtZW1vcmllcyBhbmQgJHtyZWxhdGlvbkNvdW50fSByZWxhdGlvbnMuYCwgXCJpbmZvXCIpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBjdHgudWkubm90aWZ5KGBJbXBvcnQgZmFpbGVkOiAkeyhlcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YCwgXCJlcnJvclwiKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBoYW5kbGVEZWNheShjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0KTogdm9pZCB7XG4gIGNvbnN0IGRlY2F5ZWQgPSBkZWNheVN0YWxlTWVtb3JpZXMoMjApO1xuICBpZiAoZGVjYXllZC5sZW5ndGggPT09IDApIHtcbiAgICBjdHgudWkubm90aWZ5KFwiRGVjYXkgcGFzczogbm8gc3RhbGUgbWVtb3JpZXMgZm91bmQuXCIsIFwiaW5mb1wiKTtcbiAgICByZXR1cm47XG4gIH1cbiAgY3R4LnVpLm5vdGlmeShgRGVjYXllZCAke2RlY2F5ZWQubGVuZ3RofSBzdGFsZSBtZW1vciR7ZGVjYXllZC5sZW5ndGggPT09IDEgPyBcInlcIiA6IFwiaWVzXCJ9OiAke2RlY2F5ZWQuam9pbihcIiwgXCIpfWAsIFwiaW5mb1wiKTtcbn1cblxuZnVuY3Rpb24gaGFuZGxlQ2FwKGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsIGFyZzogc3RyaW5nIHwgdW5kZWZpbmVkKTogdm9pZCB7XG4gIGNvbnN0IG1heCA9IGFyZyA/IE51bWJlci5wYXJzZUludChhcmcsIDEwKSA6IDUwO1xuICBpZiAoIU51bWJlci5pc0Zpbml0ZShtYXgpIHx8IG1heCA8IDEpIHtcbiAgICBjdHgudWkubm90aWZ5KFwiVXNhZ2U6IC9nc2QgbWVtb3J5IGNhcCA8bWF4PiAgKGRlZmF1bHQgNTApXCIsIFwid2FybmluZ1wiKTtcbiAgICByZXR1cm47XG4gIH1cbiAgZW5mb3JjZU1lbW9yeUNhcChtYXgpO1xuICBjdHgudWkubm90aWZ5KGBFbmZvcmNlZCBtZW1vcnkgY2FwIG9mICR7bWF4fS5gLCBcImluZm9cIik7XG59XG5cbmZ1bmN0aW9uIGhhbmRsZVNvdXJjZXMoY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCk6IHZvaWQge1xuICBjb25zdCBzb3VyY2VzID0gbGlzdE1lbW9yeVNvdXJjZXMoMzApO1xuICBpZiAoc291cmNlcy5sZW5ndGggPT09IDApIHtcbiAgICBjdHgudWkubm90aWZ5KFwiTm8gbWVtb3J5IHNvdXJjZXMgeWV0LiBVc2UgYC9nc2QgbWVtb3J5IGluZ2VzdCA8cGF0aHx1cmw+YCB0byBhZGQgb25lLlwiLCBcImluZm9cIik7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IGxpbmVzID0gc291cmNlcy5tYXAoXG4gICAgKHMpID0+XG4gICAgICBgLSAke3MuaWR9IFske3Mua2luZH0ke3Muc2NvcGUgIT09IFwicHJvamVjdFwiID8gYC8ke3Muc2NvcGV9YCA6IFwiXCJ9XSAke3RydW5jYXRlKHMudGl0bGUgPz8gcy51cmkgPz8gcy5jb250ZW50LCAxMDApfWAsXG4gICk7XG4gIGN0eC51aS5ub3RpZnkobGluZXMuam9pbihcIlxcblwiKSwgXCJpbmZvXCIpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVOb3RlKGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsIGFyZ3M6IE1lbW9yeUNtZEFyZ3MpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgdGV4dCA9IGFyZ3MucG9zaXRpb25hbC5qb2luKFwiIFwiKS50cmltKCk7XG4gIGlmICghdGV4dCkge1xuICAgIGN0eC51aS5ub3RpZnkoJ1VzYWdlOiAvZ3NkIG1lbW9yeSBub3RlIFwieW91ciBub3RlXCInLCBcIndhcm5pbmdcIik7XG4gICAgcmV0dXJuO1xuICB9XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaW5nZXN0Tm90ZSh0ZXh0LCBudWxsLCB7XG4gICAgICBzY29wZTogYXJncy5zY29wZSxcbiAgICAgIHRhZ3M6IGFyZ3MudGFncyxcbiAgICAgIGV4dHJhY3Q6IGZhbHNlLFxuICAgIH0pO1xuICAgIGN0eC51aS5ub3RpZnkoc3VtbWFyaXplSW5nZXN0KHJlc3VsdCksIFwiaW5mb1wiKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY3R4LnVpLm5vdGlmeShgTm90ZSBpbmdlc3QgZmFpbGVkOiAkeyhlcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YCwgXCJlcnJvclwiKTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVJbmdlc3QoY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCwgYXJnczogTWVtb3J5Q21kQXJncyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB0YXJnZXQgPSBhcmdzLnBvc2l0aW9uYWxbMF07XG4gIGlmICghdGFyZ2V0KSB7XG4gICAgY3R4LnVpLm5vdGlmeShcIlVzYWdlOiAvZ3NkIG1lbW9yeSBpbmdlc3QgPHBhdGh8dXJsPiBbLS10YWcgYSxiXSBbLS1zY29wZSBwcm9qZWN0fGdsb2JhbF1cIiwgXCJ3YXJuaW5nXCIpO1xuICAgIHJldHVybjtcbiAgfVxuICB0cnkge1xuICAgIGNvbnN0IGlzVXJsID0gL15odHRwcz86XFwvXFwvL2kudGVzdCh0YXJnZXQpO1xuICAgIGNvbnN0IHJlc3VsdCA9IGlzVXJsXG4gICAgICA/IGF3YWl0IGluZ2VzdFVybCh0YXJnZXQsIG51bGwsIHsgc2NvcGU6IGFyZ3Muc2NvcGUsIHRhZ3M6IGFyZ3MudGFncywgZXh0cmFjdDogZmFsc2UgfSlcbiAgICAgIDogYXdhaXQgaW5nZXN0RmlsZSh0YXJnZXQsIG51bGwsIHsgc2NvcGU6IGFyZ3Muc2NvcGUsIHRhZ3M6IGFyZ3MudGFncywgZXh0cmFjdDogZmFsc2UgfSk7XG4gICAgY3R4LnVpLm5vdGlmeShzdW1tYXJpemVJbmdlc3QocmVzdWx0KSwgXCJpbmZvXCIpO1xuICAgIGlmIChhcmdzLmV4dHJhY3QgJiYgcmVzdWx0LnNvdXJjZUlkKSB7XG4gICAgICAvLyBUT0RPIChQMyk6IGRpc3BhdGNoIGFnZW50IHR1cm4gdG8gZXh0cmFjdCBtZW1vcmllcyBvbmNlIHNvdXJjZSBpcyBzdG9yZWQuXG4gICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICBgKERpc3BhdGNoaW5nIGV4dHJhY3Rpb24gdHVybiBcdTIwMTQgdXNlIFxcYC9nc2QgbWVtb3J5IGV4dHJhY3QgJHtyZXN1bHQuc291cmNlSWR9XFxgIHRvIHRyaWdnZXIgbWFudWFsbHkuKWAsXG4gICAgICAgIFwiaW5mb1wiLFxuICAgICAgKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGN0eC51aS5ub3RpZnkoYEluZ2VzdCBmYWlsZWQ6ICR7KGVyciBhcyBFcnJvcikubWVzc2FnZX1gLCBcImVycm9yXCIpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGhhbmRsZUV4dHJhY3RTb3VyY2UoXG4gIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsXG4gIHBpOiBFeHRlbnNpb25BUEksXG4gIGlkOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4pOiB2b2lkIHtcbiAgaWYgKCFpZCkge1xuICAgIGN0eC51aS5ub3RpZnkoXCJVc2FnZTogL2dzZCBtZW1vcnkgZXh0cmFjdCA8U1JDLXh4eD5cIiwgXCJ3YXJuaW5nXCIpO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBzb3VyY2UgPSBnZXRNZW1vcnlTb3VyY2UoaWQpO1xuICBpZiAoIXNvdXJjZSkge1xuICAgIGN0eC51aS5ub3RpZnkoYFNvdXJjZSBub3QgZm91bmQ6ICR7aWR9YCwgXCJ3YXJuaW5nXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHByb21wdCA9IGJ1aWxkRXh0cmFjdFByb21wdChzb3VyY2UpO1xuICBjdHgudWkubm90aWZ5KGBEaXNwYXRjaGluZyBleHRyYWN0aW9uIHR1cm4gZm9yICR7aWR9Li4uYCwgXCJpbmZvXCIpO1xuICBwaS5zZW5kTWVzc2FnZShcbiAgICB7IGN1c3RvbVR5cGU6IFwiZ3NkLW1lbW9yeS1leHRyYWN0XCIsIGNvbnRlbnQ6IHByb21wdCwgZGlzcGxheTogZmFsc2UgfSxcbiAgICB7IHRyaWdnZXJUdXJuOiB0cnVlIH0sXG4gICk7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkRXh0cmFjdFByb21wdChzb3VyY2U6IHsgaWQ6IHN0cmluZzsga2luZDogc3RyaW5nOyB0aXRsZTogc3RyaW5nIHwgbnVsbDsgdXJpOiBzdHJpbmcgfCBudWxsOyBjb250ZW50OiBzdHJpbmcgfSk6IHN0cmluZyB7XG4gIGNvbnN0IGhlYWRlciA9IFtcbiAgICBgIyMgTWVtb3J5IGV4dHJhY3Rpb24gcmVxdWVzdGAsXG4gICAgYGAsXG4gICAgYFNvdXJjZTogJHtzb3VyY2UuaWR9ICgke3NvdXJjZS5raW5kfSlgLFxuICAgIHNvdXJjZS50aXRsZSA/IGBUaXRsZTogJHtzb3VyY2UudGl0bGV9YCA6IG51bGwsXG4gICAgc291cmNlLnVyaSA/IGBVUkk6ICR7c291cmNlLnVyaX1gIDogbnVsbCxcbiAgXVxuICAgIC5maWx0ZXIoQm9vbGVhbilcbiAgICAuam9pbihcIlxcblwiKTtcbiAgcmV0dXJuIFtcbiAgICBoZWFkZXIsXG4gICAgXCJcIixcbiAgICBcIlJlYWQgdGhlIGNvbnRlbnQgYmVsb3cgYW5kIGNhbGwgdGhlIGBjYXB0dXJlX3Rob3VnaHRgIHRvb2wgb25jZSBwZXIgZHVyYWJsZSBpbnNpZ2h0XCIsXG4gICAgXCIoYXJjaGl0ZWN0dXJlLCBjb252ZW50aW9uLCBnb3RjaGEsIHByZWZlcmVuY2UsIGVudmlyb25tZW50LCBwYXR0ZXJuKS4gU2tpcCBvbmUtb2ZmIGRldGFpbHMsXCIsXG4gICAgXCJ0ZW1wb3Jhcnkgc3RhdGUsIGFuZCBhbnl0aGluZyBzZWNyZXQuIEtlZXAgZWFjaCBtZW1vcnkgdG8gMVx1MjAxMzMgc2VudGVuY2VzLlwiLFxuICAgIFwiXCIsXG4gICAgXCItLS1cIixcbiAgICBcIlwiLFxuICAgIHNvdXJjZS5jb250ZW50LFxuICBdLmpvaW4oXCJcXG5cIik7XG59XG5cbmZ1bmN0aW9uIHNhZmVKc29uQXJyYXkocmF3OiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIHRyeSB7XG4gICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShyYXcpO1xuICAgIHJldHVybiBBcnJheS5pc0FycmF5KHBhcnNlZCkgPyBwYXJzZWQuZmlsdGVyKCh0KTogdCBpcyBzdHJpbmcgPT4gdHlwZW9mIHQgPT09IFwic3RyaW5nXCIpIDogW107XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBbXTtcbiAgfVxufVxuXG4vLyBwcm9qZWN0Um9vdCBpcyBpbXBvcnRlZCBzbyB0ZXN0cyBjYW4gbW9jayBpdCB2aWEgdGhlIHNhbWUgcGF0aCBhcyBvdGhlciBjb21tYW5kcy5cbmV4cG9ydCBjb25zdCBfaW50ZXJuYWxzID0geyBwcm9qZWN0Um9vdCB9O1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBY0EsU0FBUyxjQUFjLHFCQUFxQjtBQUM1QyxTQUFTLFdBQVcsbUJBQW1CO0FBSXZDLFNBQVMsbUJBQW1C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
