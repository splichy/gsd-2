import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead
} from "@gsd/pi-coding-agent";
import { Text } from "@gsd/pi-tui";
import { Type } from "@sinclair/typebox";
const searchCache = /* @__PURE__ */ new Map();
const docCache = /* @__PURE__ */ new Map();
const BASE_URL = "https://context7.com/api/v2";
function getApiKey() {
  return process.env.CONTEXT7_API_KEY;
}
function buildHeaders() {
  const headers = {
    "User-Agent": "pi-coding-agent/context7-extension"
  };
  const key = getApiKey();
  if (key) headers["Authorization"] = `Bearer ${key}`;
  return headers;
}
async function apiFetchJson(url, signal) {
  const res = await fetch(url, { headers: { ...buildHeaders(), Accept: "application/json" }, signal });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Context7 API ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}
async function apiFetchText(url, signal) {
  const res = await fetch(url, { headers: { ...buildHeaders(), Accept: "text/plain" }, signal });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Context7 API ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.text();
}
function formatLibraryList(libs, query) {
  if (libs.length === 0) {
    return `No libraries found for "${query}". Try a different name or spelling.`;
  }
  const lines = [
    `Found ${libs.length} ${libs.length === 1 ? "library" : "libraries"} matching "${query}":
`
  ];
  for (const lib of libs) {
    let line = `\u2022 ${lib.title}  (ID: ${lib.id})`;
    if (lib.description) line += `
  ${lib.description}`;
    const meta = [];
    if (lib.trustScore !== void 0) meta.push(`trust: ${lib.trustScore}/10`);
    if (lib.benchmarkScore !== void 0) meta.push(`benchmark: ${lib.benchmarkScore.toFixed(1)}`);
    if (lib.totalSnippets !== void 0) meta.push(`${lib.totalSnippets.toLocaleString()} snippets`);
    if (lib.totalTokens !== void 0) meta.push(`${(lib.totalTokens / 1e3).toFixed(0)}k tokens`);
    if (lib.lastUpdateDate) meta.push(`updated: ${lib.lastUpdateDate.split("T")[0]}`);
    if (meta.length > 0) line += `
  ${meta.join(" \xB7 ")}`;
    lines.push(line);
  }
  lines.push(
    "\nUse the ID (e.g. /websites/react_dev) with get_library_docs to fetch documentation."
  );
  return lines.join("\n");
}
function context7_default(pi) {
  pi.registerTool({
    name: "resolve_library",
    label: "Resolve Library",
    description: "Search the Context7 library catalogue by name and return matching libraries with metadata. Use this to find the correct library ID before fetching documentation. Results are ranked by trustScore (0\u201310) and benchmarkScore \u2014 prefer the highest. If you already have a library ID (e.g. /vercel/next.js), skip this and call get_library_docs directly.",
    promptSnippet: "Search Context7 for a library by name to get its ID for documentation lookup",
    promptGuidelines: [
      "Call resolve_library first when the user asks about a library, package, or framework you need current docs for.",
      "Choose the result with the highest trustScore and benchmarkScore when multiple matches appear.",
      "Pass the user's question as the query parameter \u2014 it improves result ranking."
    ],
    parameters: Type.Object({
      libraryName: Type.String({
        description: "Library or framework name to search for, e.g. 'react', 'next.js', 'tailwindcss', 'prisma', 'langchain'"
      }),
      query: Type.Optional(
        Type.String({
          description: "Optional: the user's question or topic. Improves search ranking. E.g. 'how do I use server actions?'"
        })
      )
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const cacheKey = params.libraryName.toLowerCase().trim();
      if (searchCache.has(cacheKey)) {
        const cached = searchCache.get(cacheKey);
        return {
          content: [{ type: "text", text: formatLibraryList(cached, params.libraryName) }],
          details: {
            query: params.libraryName,
            resultCount: cached.length,
            cached: true
          }
        };
      }
      const url = new URL(`${BASE_URL}/libs/search`);
      url.searchParams.set("libraryName", params.libraryName);
      if (params.query) url.searchParams.set("query", params.query);
      let libs;
      try {
        const data = await apiFetchJson(url.toString(), signal);
        libs = Array.isArray(data?.results) ? data.results : [];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Context7 search failed: ${msg}` }],
          isError: true,
          details: { query: params.libraryName, resultCount: 0, cached: false, error: msg }
        };
      }
      searchCache.set(cacheKey, libs);
      return {
        content: [{ type: "text", text: formatLibraryList(libs, params.libraryName) }],
        details: { query: params.libraryName, resultCount: libs.length, cached: false }
      };
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("resolve_library "));
      text += theme.fg("accent", `"${args.libraryName}"`);
      if (args.query) text += theme.fg("muted", ` \u2014 "${args.query}"`);
      return new Text(text, 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      const d = result.details;
      if (isPartial) return new Text(theme.fg("warning", "Searching Context7..."), 0, 0);
      if (result.isError || d?.error) {
        return new Text(theme.fg("error", `Error: ${d?.error ?? "unknown"}`), 0, 0);
      }
      let text = theme.fg("success", `${d?.resultCount ?? 0} ${d?.resultCount === 1 ? "library" : "libraries"} found`);
      if (d?.cached) text += theme.fg("dim", " (cached)");
      text += theme.fg("dim", ` for "${d?.query}"`);
      return new Text(text, 0, 0);
    }
  });
  pi.registerTool({
    name: "get_library_docs",
    label: "Get Library Docs",
    description: "Fetch up-to-date documentation from Context7 for a specific library. Pass the library ID from resolve_library (e.g. /websites/react_dev) and a focused topic query to get the most relevant snippets. The tokens parameter controls how much documentation to retrieve (default 5000, max 10000). A specific query (e.g. 'server actions form submission') returns better results than a broad one.",
    promptSnippet: "Fetch up-to-date, version-specific documentation for a library from Context7",
    promptGuidelines: [
      "Use a specific topic query for best results \u2014 e.g. 'useEffect cleanup' not just 'hooks'.",
      "Start with tokens=5000. Increase to 10000 only if the first response lacks the detail you need.",
      "Results are cached per-session \u2014 repeated calls for the same library+query have no API cost."
    ],
    parameters: Type.Object({
      libraryId: Type.String({
        description: "Context7 library ID from resolve_library, e.g. /websites/react_dev or /vercel/next.js"
      }),
      query: Type.Optional(
        Type.String({
          description: "Specific topic to focus the docs on, e.g. 'server actions', 'useEffect cleanup', 'authentication middleware'. More specific = better results."
        })
      ),
      tokens: Type.Optional(
        Type.Number({
          description: "Max tokens of documentation to return (default 5000, max 10000).",
          minimum: 500,
          maximum: 1e4
        })
      )
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const tokens = Math.min(Math.max(params.tokens ?? 5e3, 500), 1e4);
      const libraryId = params.libraryId.startsWith("@") ? params.libraryId.slice(1) : params.libraryId;
      const query = params.query?.trim() || void 0;
      const cacheKey = `${libraryId}::${query ?? ""}::${tokens}`;
      if (docCache.has(cacheKey)) {
        const cached = docCache.get(cacheKey);
        return {
          content: [{ type: "text", text: cached }],
          details: {
            libraryId,
            query,
            tokens,
            cached: true,
            truncated: false,
            charCount: cached.length
          }
        };
      }
      const url = new URL(`${BASE_URL}/context`);
      url.searchParams.set("libraryId", libraryId);
      if (query) url.searchParams.set("query", query);
      url.searchParams.set("tokens", String(tokens));
      let rawText;
      try {
        rawText = await apiFetchText(url.toString(), signal);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Context7 doc fetch failed: ${msg}` }],
          isError: true,
          details: {
            libraryId,
            query,
            tokens,
            cached: false,
            truncated: false,
            charCount: 0,
            error: msg
          }
        };
      }
      if (!rawText.trim()) {
        const notFound = query ? `No documentation found for "${query}" in ${libraryId}. Try a broader query or different library ID.` : `No documentation found for ${libraryId}. Try resolve_library to verify the library ID.`;
        return {
          content: [{ type: "text", text: notFound }],
          details: {
            libraryId,
            query,
            tokens,
            cached: false,
            truncated: false,
            charCount: 0
          }
        };
      }
      const truncation = truncateHead(rawText, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES
      });
      let finalText = truncation.content;
      if (truncation.truncated) {
        finalText += `

[Truncated: showing ${truncation.outputLines}/${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Use a more specific query to reduce output size.]`;
      }
      docCache.set(cacheKey, finalText);
      return {
        content: [{ type: "text", text: finalText }],
        details: {
          libraryId,
          query,
          tokens,
          cached: false,
          truncated: truncation.truncated,
          charCount: finalText.length
        }
      };
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("get_library_docs "));
      text += theme.fg("accent", args.libraryId);
      if (args.query) text += theme.fg("muted", ` \u2014 "${args.query}"`);
      if (args.tokens && args.tokens !== 5e3) text += theme.fg("dim", ` (${args.tokens} tokens)`);
      return new Text(text, 0, 0);
    },
    renderResult(result, { isPartial, expanded }, theme) {
      const d = result.details;
      if (isPartial) return new Text(theme.fg("warning", "Fetching documentation..."), 0, 0);
      if (result.isError || d?.error) {
        return new Text(theme.fg("error", `Error: ${d?.error ?? "unknown"}`), 0, 0);
      }
      let text = theme.fg("success", `${(d?.charCount ?? 0).toLocaleString()} chars`);
      text += theme.fg("dim", ` \xB7 ${d?.tokens ?? 5e3} token budget`);
      if (d?.cached) text += theme.fg("dim", " \xB7 cached");
      if (d?.truncated) text += theme.fg("warning", " \xB7 truncated");
      text += theme.fg("dim", ` \xB7 ${d?.libraryId}`);
      if (d?.query) text += theme.fg("dim", ` \u2014 "${d.query}"`);
      if (expanded) {
        const content = result.content[0];
        if (content?.type === "text") {
          const preview = content.text.split("\n").slice(0, 12).join("\n");
          text += "\n\n" + theme.fg("dim", preview);
          if (content.text.split("\n").length > 12) {
            text += "\n" + theme.fg("muted", "\u2026 (Ctrl+O to collapse)");
          }
        }
      }
      return new Text(text, 0, 0);
    }
  });
  pi.on("session_shutdown", async () => {
    searchCache.clear();
    docCache.clear();
  });
  pi.on("session_start", async (_event, ctx) => {
    if (!getApiKey()) {
      ctx.ui.notify(
        "Context7: No CONTEXT7_API_KEY set. Using free tier (1000 req/month limit). Set CONTEXT7_API_KEY for higher limits.",
        "warning"
      );
    }
  });
}
export {
  context7_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2NvbnRleHQ3L2luZGV4LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIENvbnRleHQ3IERvY3VtZW50YXRpb24gRXh0ZW5zaW9uXG4gKlxuICogUmVwbGFjZXMgdGhlIGNvbnRleHQ3IE1DUCBzZXJ2ZXIgd2l0aCBhIG5hdGl2ZSBwaSBleHRlbnNpb24uXG4gKiBQcm92aWRlcyB0d28gdG9vbHMgZm9yIHRoZSBMTE06XG4gKlxuICogICByZXNvbHZlX2xpYnJhcnkgICAtIFNlYXJjaCBmb3IgYSBsaWJyYXJ5IGJ5IG5hbWUsIHJldHVybnMgY2FuZGlkYXRlcyB3aXRoIG1ldGFkYXRhXG4gKiAgIGdldF9saWJyYXJ5X2RvY3MgIC0gRmV0Y2ggZG9jcyBmb3IgYSBsaWJyYXJ5IElELCBzY29wZWQgdG8gYW4gb3B0aW9uYWwgcXVlcnkvdG9waWNcbiAqXG4gKiBBUEkgY29udHJhY3QgKHZlcmlmaWVkIGFnYWluc3QgbGl2ZSBBUEkgMjAyNi0wMy0wNCk6XG4gKiAgIFNlYXJjaDogIEdFVCAvYXBpL3YyL2xpYnMvc2VhcmNoP2xpYnJhcnlOYW1lPSZxdWVyeT0gIFx1MjE5MiB7IHJlc3VsdHM6IEM3TGlicmFyeVtdIH1cbiAqICAgQ29udGV4dDogR0VUIC9hcGkvdjIvY29udGV4dD9saWJyYXJ5SWQ9JnF1ZXJ5PSZ0b2tlbnM9IFx1MjE5MiB0ZXh0L3BsYWluIChtYXJrZG93bilcbiAqXG4gKiBGZWF0dXJlczpcbiAqICAgLSBCZWFyZXIgYXV0aCB2aWEgQ09OVEVYVDdfQVBJX0tFWSBlbnYgdmFyIChvcHRpb25hbCwgaW5jcmVhc2VzIHJhdGUgbGltaXRzKVxuICogICAtIEluLXNlc3Npb24gY2FjaGluZyBvZiBzZWFyY2ggcmVzdWx0cyBhbmQgZG9jIHBhZ2VzXG4gKiAgIC0gU21hcnQgdG9rZW4gYnVkZ2V0aW5nIChkZWZhdWx0IDUwMDAsIGNvbmZpZ3VyYWJsZSBwZXIgY2FsbCwgbWF4IDEwMDAwKVxuICogICAtIFByb3BlciB0cnVuY2F0aW9uIGd1YXJkIHNvIGNvbnRleHQgaXMgbmV2ZXIgb3ZlcndoZWxtZWRcbiAqICAgLSBDdXN0b20gVFVJIHJlbmRlcmluZyBmb3IgY2xlYW4gZGlzcGxheSBpbiBwaVxuICpcbiAqIFNldHVwOlxuICogICBleHBvcnQgQ09OVEVYVDdfQVBJX0tFWT15b3VyX2tleSAgIChnZXQgb25lIGF0IGNvbnRleHQ3LmNvbS9kYXNoYm9hcmQpXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBFeHRlbnNpb25BUEkgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7XG5cdERFRkFVTFRfTUFYX0JZVEVTLFxuXHRERUZBVUxUX01BWF9MSU5FUyxcblx0Zm9ybWF0U2l6ZSxcblx0dHJ1bmNhdGVIZWFkLFxufSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7IFRleHQgfSBmcm9tIFwiQGdzZC9waS10dWlcIjtcbmltcG9ydCB7IFR5cGUgfSBmcm9tIFwiQHNpbmNsYWlyL3R5cGVib3hcIjtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEFQSSB0eXBlcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqIFNoYXBlIHJldHVybmVkIGJ5IEdFVCAvYXBpL3YyL2xpYnMvc2VhcmNoICovXG5pbnRlcmZhY2UgQzdTZWFyY2hSZXNwb25zZSB7XG5cdHJlc3VsdHM6IEM3TGlicmFyeVtdO1xufVxuXG5pbnRlcmZhY2UgQzdMaWJyYXJ5IHtcblx0aWQ6IHN0cmluZztcblx0dGl0bGU6IHN0cmluZztcblx0ZGVzY3JpcHRpb24/OiBzdHJpbmc7XG5cdGJyYW5jaD86IHN0cmluZztcblx0bGFzdFVwZGF0ZURhdGU/OiBzdHJpbmc7XG5cdHN0YXRlPzogc3RyaW5nO1xuXHR0b3RhbFRva2Vucz86IG51bWJlcjtcblx0dG90YWxTbmlwcGV0cz86IG51bWJlcjtcblx0c3RhcnM/OiBudW1iZXI7XG5cdHRydXN0U2NvcmU/OiBudW1iZXI7XG5cdGJlbmNobWFya1Njb3JlPzogbnVtYmVyO1xuXHR2ZXJzaW9ucz86IHN0cmluZ1tdO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgSW4tc2Vzc2lvbiBjYWNoZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLy8gS2V5ZWQgYnkgbG93ZXJjYXNlZCBxdWVyeSBzdHJpbmdcbmNvbnN0IHNlYXJjaENhY2hlID0gbmV3IE1hcDxzdHJpbmcsIEM3TGlicmFyeVtdPigpO1xuXG4vLyBLZXllZCBieSBgJHtsaWJyYXJ5SWR9Ojoke3F1ZXJ5ID8/IFwiXCJ9Ojoke3Rva2Vuc31gXG5jb25zdCBkb2NDYWNoZSA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBIZWxwZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5jb25zdCBCQVNFX1VSTCA9IFwiaHR0cHM6Ly9jb250ZXh0Ny5jb20vYXBpL3YyXCI7XG5cbmZ1bmN0aW9uIGdldEFwaUtleSgpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuXHRyZXR1cm4gcHJvY2Vzcy5lbnYuQ09OVEVYVDdfQVBJX0tFWTtcbn1cblxuZnVuY3Rpb24gYnVpbGRIZWFkZXJzKCk6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4ge1xuXHRjb25zdCBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuXHRcdFwiVXNlci1BZ2VudFwiOiBcInBpLWNvZGluZy1hZ2VudC9jb250ZXh0Ny1leHRlbnNpb25cIixcblx0fTtcblx0Y29uc3Qga2V5ID0gZ2V0QXBpS2V5KCk7XG5cdGlmIChrZXkpIGhlYWRlcnNbXCJBdXRob3JpemF0aW9uXCJdID0gYEJlYXJlciAke2tleX1gO1xuXHRyZXR1cm4gaGVhZGVycztcbn1cblxuYXN5bmMgZnVuY3Rpb24gYXBpRmV0Y2hKc29uKHVybDogc3RyaW5nLCBzaWduYWw/OiBBYm9ydFNpZ25hbCk6IFByb21pc2U8dW5rbm93bj4ge1xuXHRjb25zdCByZXMgPSBhd2FpdCBmZXRjaCh1cmwsIHsgaGVhZGVyczogeyAuLi5idWlsZEhlYWRlcnMoKSwgQWNjZXB0OiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LCBzaWduYWwgfSk7XG5cdGlmICghcmVzLm9rKSB7XG5cdFx0Y29uc3QgYm9keSA9IGF3YWl0IHJlcy50ZXh0KCkuY2F0Y2goKCkgPT4gXCJcIik7XG5cdFx0dGhyb3cgbmV3IEVycm9yKGBDb250ZXh0NyBBUEkgJHtyZXMuc3RhdHVzfTogJHtib2R5LnNsaWNlKDAsIDMwMCl9YCk7XG5cdH1cblx0cmV0dXJuIHJlcy5qc29uKCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGFwaUZldGNoVGV4dCh1cmw6IHN0cmluZywgc2lnbmFsPzogQWJvcnRTaWduYWwpOiBQcm9taXNlPHN0cmluZz4ge1xuXHRjb25zdCByZXMgPSBhd2FpdCBmZXRjaCh1cmwsIHsgaGVhZGVyczogeyAuLi5idWlsZEhlYWRlcnMoKSwgQWNjZXB0OiBcInRleHQvcGxhaW5cIiB9LCBzaWduYWwgfSk7XG5cdGlmICghcmVzLm9rKSB7XG5cdFx0Y29uc3QgYm9keSA9IGF3YWl0IHJlcy50ZXh0KCkuY2F0Y2goKCkgPT4gXCJcIik7XG5cdFx0dGhyb3cgbmV3IEVycm9yKGBDb250ZXh0NyBBUEkgJHtyZXMuc3RhdHVzfTogJHtib2R5LnNsaWNlKDAsIDMwMCl9YCk7XG5cdH1cblx0cmV0dXJuIHJlcy50ZXh0KCk7XG59XG5cbi8qKlxuICogRm9ybWF0IGxpYnJhcnkgc2VhcmNoIHJlc3VsdHMgaW50byBhIGNvbXBhY3QsIExMTS1yZWFkYWJsZSBzdHJpbmcuXG4gKiBFYWNoIGxpYnJhcnkgZ2V0cyBhIGJsb2NrIHdpdGggdGhlIGtleSBzaWduYWxzIGZvciBwaWNraW5nIHRoZSBiZXN0IG1hdGNoLlxuICovXG5mdW5jdGlvbiBmb3JtYXRMaWJyYXJ5TGlzdChsaWJzOiBDN0xpYnJhcnlbXSwgcXVlcnk6IHN0cmluZyk6IHN0cmluZyB7XG5cdGlmIChsaWJzLmxlbmd0aCA9PT0gMCkge1xuXHRcdHJldHVybiBgTm8gbGlicmFyaWVzIGZvdW5kIGZvciBcIiR7cXVlcnl9XCIuIFRyeSBhIGRpZmZlcmVudCBuYW1lIG9yIHNwZWxsaW5nLmA7XG5cdH1cblxuXHRjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXG5cdFx0YEZvdW5kICR7bGlicy5sZW5ndGh9ICR7bGlicy5sZW5ndGggPT09IDEgPyBcImxpYnJhcnlcIiA6IFwibGlicmFyaWVzXCJ9IG1hdGNoaW5nIFwiJHtxdWVyeX1cIjpcXG5gLFxuXHRdO1xuXG5cdGZvciAoY29uc3QgbGliIG9mIGxpYnMpIHtcblx0XHRsZXQgbGluZSA9IGBcdTIwMjIgJHtsaWIudGl0bGV9ICAoSUQ6ICR7bGliLmlkfSlgO1xuXHRcdGlmIChsaWIuZGVzY3JpcHRpb24pIGxpbmUgKz0gYFxcbiAgJHtsaWIuZGVzY3JpcHRpb259YDtcblxuXHRcdGNvbnN0IG1ldGE6IHN0cmluZ1tdID0gW107XG5cdFx0aWYgKGxpYi50cnVzdFNjb3JlICE9PSB1bmRlZmluZWQpIG1ldGEucHVzaChgdHJ1c3Q6ICR7bGliLnRydXN0U2NvcmV9LzEwYCk7XG5cdFx0aWYgKGxpYi5iZW5jaG1hcmtTY29yZSAhPT0gdW5kZWZpbmVkKSBtZXRhLnB1c2goYGJlbmNobWFyazogJHtsaWIuYmVuY2htYXJrU2NvcmUudG9GaXhlZCgxKX1gKTtcblx0XHRpZiAobGliLnRvdGFsU25pcHBldHMgIT09IHVuZGVmaW5lZCkgbWV0YS5wdXNoKGAke2xpYi50b3RhbFNuaXBwZXRzLnRvTG9jYWxlU3RyaW5nKCl9IHNuaXBwZXRzYCk7XG5cdFx0aWYgKGxpYi50b3RhbFRva2VucyAhPT0gdW5kZWZpbmVkKSBtZXRhLnB1c2goYCR7KGxpYi50b3RhbFRva2VucyAvIDEwMDApLnRvRml4ZWQoMCl9ayB0b2tlbnNgKTtcblx0XHRpZiAobGliLmxhc3RVcGRhdGVEYXRlKSBtZXRhLnB1c2goYHVwZGF0ZWQ6ICR7bGliLmxhc3RVcGRhdGVEYXRlLnNwbGl0KFwiVFwiKVswXX1gKTtcblx0XHRpZiAobWV0YS5sZW5ndGggPiAwKSBsaW5lICs9IGBcXG4gICR7bWV0YS5qb2luKFwiIFx1MDBCNyBcIil9YDtcblxuXHRcdGxpbmVzLnB1c2gobGluZSk7XG5cdH1cblxuXHRsaW5lcy5wdXNoKFxuXHRcdFwiXFxuVXNlIHRoZSBJRCAoZS5nLiAvd2Vic2l0ZXMvcmVhY3RfZGV2KSB3aXRoIGdldF9saWJyYXJ5X2RvY3MgdG8gZmV0Y2ggZG9jdW1lbnRhdGlvbi5cIixcblx0KTtcblxuXHRyZXR1cm4gbGluZXMuam9pbihcIlxcblwiKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRvb2wgZGV0YWlscyB0eXBlcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuaW50ZXJmYWNlIFJlc29sdmVEZXRhaWxzIHtcblx0cXVlcnk6IHN0cmluZztcblx0cmVzdWx0Q291bnQ6IG51bWJlcjtcblx0Y2FjaGVkOiBib29sZWFuO1xuXHRlcnJvcj86IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIERvY3NEZXRhaWxzIHtcblx0bGlicmFyeUlkOiBzdHJpbmc7XG5cdHF1ZXJ5Pzogc3RyaW5nO1xuXHR0b2tlbnM6IG51bWJlcjtcblx0Y2FjaGVkOiBib29sZWFuO1xuXHR0cnVuY2F0ZWQ6IGJvb2xlYW47XG5cdGNoYXJDb3VudDogbnVtYmVyO1xuXHRlcnJvcj86IHN0cmluZztcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEV4dGVuc2lvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGRlZmF1bHQgZnVuY3Rpb24gKHBpOiBFeHRlbnNpb25BUEkpIHtcblx0Ly8gXHUyNTAwXHUyNTAwIHJlc29sdmVfbGlicmFyeSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuXHRwaS5yZWdpc3RlclRvb2woe1xuXHRcdG5hbWU6IFwicmVzb2x2ZV9saWJyYXJ5XCIsXG5cdFx0bGFiZWw6IFwiUmVzb2x2ZSBMaWJyYXJ5XCIsXG5cdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcIlNlYXJjaCB0aGUgQ29udGV4dDcgbGlicmFyeSBjYXRhbG9ndWUgYnkgbmFtZSBhbmQgcmV0dXJuIG1hdGNoaW5nIGxpYnJhcmllcyB3aXRoIG1ldGFkYXRhLiBcIiArXG5cdFx0XHRcIlVzZSB0aGlzIHRvIGZpbmQgdGhlIGNvcnJlY3QgbGlicmFyeSBJRCBiZWZvcmUgZmV0Y2hpbmcgZG9jdW1lbnRhdGlvbi4gXCIgK1xuXHRcdFx0XCJSZXN1bHRzIGFyZSByYW5rZWQgYnkgdHJ1c3RTY29yZSAoMFx1MjAxMzEwKSBhbmQgYmVuY2htYXJrU2NvcmUgXHUyMDE0IHByZWZlciB0aGUgaGlnaGVzdC4gXCIgK1xuXHRcdFx0XCJJZiB5b3UgYWxyZWFkeSBoYXZlIGEgbGlicmFyeSBJRCAoZS5nLiAvdmVyY2VsL25leHQuanMpLCBza2lwIHRoaXMgYW5kIGNhbGwgZ2V0X2xpYnJhcnlfZG9jcyBkaXJlY3RseS5cIixcblx0XHRwcm9tcHRTbmlwcGV0OiBcIlNlYXJjaCBDb250ZXh0NyBmb3IgYSBsaWJyYXJ5IGJ5IG5hbWUgdG8gZ2V0IGl0cyBJRCBmb3IgZG9jdW1lbnRhdGlvbiBsb29rdXBcIixcblx0XHRwcm9tcHRHdWlkZWxpbmVzOiBbXG5cdFx0XHRcIkNhbGwgcmVzb2x2ZV9saWJyYXJ5IGZpcnN0IHdoZW4gdGhlIHVzZXIgYXNrcyBhYm91dCBhIGxpYnJhcnksIHBhY2thZ2UsIG9yIGZyYW1ld29yayB5b3UgbmVlZCBjdXJyZW50IGRvY3MgZm9yLlwiLFxuXHRcdFx0XCJDaG9vc2UgdGhlIHJlc3VsdCB3aXRoIHRoZSBoaWdoZXN0IHRydXN0U2NvcmUgYW5kIGJlbmNobWFya1Njb3JlIHdoZW4gbXVsdGlwbGUgbWF0Y2hlcyBhcHBlYXIuXCIsXG5cdFx0XHRcIlBhc3MgdGhlIHVzZXIncyBxdWVzdGlvbiBhcyB0aGUgcXVlcnkgcGFyYW1ldGVyIFx1MjAxNCBpdCBpbXByb3ZlcyByZXN1bHQgcmFua2luZy5cIixcblx0XHRdLFxuXHRcdHBhcmFtZXRlcnM6IFR5cGUuT2JqZWN0KHtcblx0XHRcdGxpYnJhcnlOYW1lOiBUeXBlLlN0cmluZyh7XG5cdFx0XHRcdGRlc2NyaXB0aW9uOlxuXHRcdFx0XHRcdFwiTGlicmFyeSBvciBmcmFtZXdvcmsgbmFtZSB0byBzZWFyY2ggZm9yLCBlLmcuICdyZWFjdCcsICduZXh0LmpzJywgJ3RhaWx3aW5kY3NzJywgJ3ByaXNtYScsICdsYW5nY2hhaW4nXCIsXG5cdFx0XHR9KSxcblx0XHRcdHF1ZXJ5OiBUeXBlLk9wdGlvbmFsKFxuXHRcdFx0XHRUeXBlLlN0cmluZyh7XG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcdFx0XHRcIk9wdGlvbmFsOiB0aGUgdXNlcidzIHF1ZXN0aW9uIG9yIHRvcGljLiBJbXByb3ZlcyBzZWFyY2ggcmFua2luZy4gRS5nLiAnaG93IGRvIEkgdXNlIHNlcnZlciBhY3Rpb25zPydcIixcblx0XHRcdFx0fSksXG5cdFx0XHQpLFxuXHRcdH0pLFxuXG5cdFx0YXN5bmMgZXhlY3V0ZShfdG9vbENhbGxJZCwgcGFyYW1zLCBzaWduYWwsIF9vblVwZGF0ZSwgX2N0eCkge1xuXHRcdFx0Y29uc3QgY2FjaGVLZXkgPSBwYXJhbXMubGlicmFyeU5hbWUudG9Mb3dlckNhc2UoKS50cmltKCk7XG5cblx0XHRcdGlmIChzZWFyY2hDYWNoZS5oYXMoY2FjaGVLZXkpKSB7XG5cdFx0XHRcdGNvbnN0IGNhY2hlZCA9IHNlYXJjaENhY2hlLmdldChjYWNoZUtleSkhO1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBmb3JtYXRMaWJyYXJ5TGlzdChjYWNoZWQsIHBhcmFtcy5saWJyYXJ5TmFtZSkgfV0sXG5cdFx0XHRcdFx0ZGV0YWlsczoge1xuXHRcdFx0XHRcdFx0cXVlcnk6IHBhcmFtcy5saWJyYXJ5TmFtZSxcblx0XHRcdFx0XHRcdHJlc3VsdENvdW50OiBjYWNoZWQubGVuZ3RoLFxuXHRcdFx0XHRcdFx0Y2FjaGVkOiB0cnVlLFxuXHRcdFx0XHRcdH0gYXMgUmVzb2x2ZURldGFpbHMsXG5cdFx0XHRcdH07XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IHVybCA9IG5ldyBVUkwoYCR7QkFTRV9VUkx9L2xpYnMvc2VhcmNoYCk7XG5cdFx0XHR1cmwuc2VhcmNoUGFyYW1zLnNldChcImxpYnJhcnlOYW1lXCIsIHBhcmFtcy5saWJyYXJ5TmFtZSk7XG5cdFx0XHRpZiAocGFyYW1zLnF1ZXJ5KSB1cmwuc2VhcmNoUGFyYW1zLnNldChcInF1ZXJ5XCIsIHBhcmFtcy5xdWVyeSk7XG5cblx0XHRcdGxldCBsaWJzOiBDN0xpYnJhcnlbXTtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IGRhdGEgPSAoYXdhaXQgYXBpRmV0Y2hKc29uKHVybC50b1N0cmluZygpLCBzaWduYWwpKSBhcyBDN1NlYXJjaFJlc3BvbnNlO1xuXHRcdFx0XHRsaWJzID0gQXJyYXkuaXNBcnJheShkYXRhPy5yZXN1bHRzKSA/IGRhdGEucmVzdWx0cyA6IFtdO1xuXHRcdFx0fSBjYXRjaCAoZXJyOiB1bmtub3duKSB7XG5cdFx0XHRcdGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYENvbnRleHQ3IHNlYXJjaCBmYWlsZWQ6ICR7bXNnfWAgfV0sXG5cdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7IHF1ZXJ5OiBwYXJhbXMubGlicmFyeU5hbWUsIHJlc3VsdENvdW50OiAwLCBjYWNoZWQ6IGZhbHNlLCBlcnJvcjogbXNnIH0gYXMgUmVzb2x2ZURldGFpbHMsXG5cdFx0XHRcdH07XG5cdFx0XHR9XG5cblx0XHRcdHNlYXJjaENhY2hlLnNldChjYWNoZUtleSwgbGlicyk7XG5cblx0XHRcdHJldHVybiB7XG5cdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBmb3JtYXRMaWJyYXJ5TGlzdChsaWJzLCBwYXJhbXMubGlicmFyeU5hbWUpIH1dLFxuXHRcdFx0XHRkZXRhaWxzOiB7IHF1ZXJ5OiBwYXJhbXMubGlicmFyeU5hbWUsIHJlc3VsdENvdW50OiBsaWJzLmxlbmd0aCwgY2FjaGVkOiBmYWxzZSB9IGFzIFJlc29sdmVEZXRhaWxzLFxuXHRcdFx0fTtcblx0XHR9LFxuXG5cdFx0cmVuZGVyQ2FsbChhcmdzLCB0aGVtZSkge1xuXHRcdFx0bGV0IHRleHQgPSB0aGVtZS5mZyhcInRvb2xUaXRsZVwiLCB0aGVtZS5ib2xkKFwicmVzb2x2ZV9saWJyYXJ5IFwiKSk7XG5cdFx0XHR0ZXh0ICs9IHRoZW1lLmZnKFwiYWNjZW50XCIsIGBcIiR7YXJncy5saWJyYXJ5TmFtZX1cImApO1xuXHRcdFx0aWYgKGFyZ3MucXVlcnkpIHRleHQgKz0gdGhlbWUuZmcoXCJtdXRlZFwiLCBgIFx1MjAxNCBcIiR7YXJncy5xdWVyeX1cImApO1xuXHRcdFx0cmV0dXJuIG5ldyBUZXh0KHRleHQsIDAsIDApO1xuXHRcdH0sXG5cblx0XHRyZW5kZXJSZXN1bHQocmVzdWx0LCB7IGlzUGFydGlhbCB9LCB0aGVtZSkge1xuXHRcdFx0Y29uc3QgZCA9IHJlc3VsdC5kZXRhaWxzIGFzIFJlc29sdmVEZXRhaWxzIHwgdW5kZWZpbmVkO1xuXHRcdFx0aWYgKGlzUGFydGlhbCkgcmV0dXJuIG5ldyBUZXh0KHRoZW1lLmZnKFwid2FybmluZ1wiLCBcIlNlYXJjaGluZyBDb250ZXh0Ny4uLlwiKSwgMCwgMCk7XG5cdFx0XHRpZiAoKHJlc3VsdCBhcyBhbnkpLmlzRXJyb3IgfHwgZD8uZXJyb3IpIHtcblx0XHRcdFx0cmV0dXJuIG5ldyBUZXh0KHRoZW1lLmZnKFwiZXJyb3JcIiwgYEVycm9yOiAke2Q/LmVycm9yID8/IFwidW5rbm93blwifWApLCAwLCAwKTtcblx0XHRcdH1cblx0XHRcdGxldCB0ZXh0ID0gdGhlbWUuZmcoXCJzdWNjZXNzXCIsIGAke2Q/LnJlc3VsdENvdW50ID8/IDB9ICR7ZD8ucmVzdWx0Q291bnQgPT09IDEgPyBcImxpYnJhcnlcIiA6IFwibGlicmFyaWVzXCJ9IGZvdW5kYCk7XG5cdFx0XHRpZiAoZD8uY2FjaGVkKSB0ZXh0ICs9IHRoZW1lLmZnKFwiZGltXCIsIFwiIChjYWNoZWQpXCIpO1xuXHRcdFx0dGV4dCArPSB0aGVtZS5mZyhcImRpbVwiLCBgIGZvciBcIiR7ZD8ucXVlcnl9XCJgKTtcblx0XHRcdHJldHVybiBuZXcgVGV4dCh0ZXh0LCAwLCAwKTtcblx0XHR9LFxuXHR9KTtcblxuXHQvLyBcdTI1MDBcdTI1MDAgZ2V0X2xpYnJhcnlfZG9jcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuXHRwaS5yZWdpc3RlclRvb2woe1xuXHRcdG5hbWU6IFwiZ2V0X2xpYnJhcnlfZG9jc1wiLFxuXHRcdGxhYmVsOiBcIkdldCBMaWJyYXJ5IERvY3NcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiRmV0Y2ggdXAtdG8tZGF0ZSBkb2N1bWVudGF0aW9uIGZyb20gQ29udGV4dDcgZm9yIGEgc3BlY2lmaWMgbGlicmFyeS4gXCIgK1xuXHRcdFx0XCJQYXNzIHRoZSBsaWJyYXJ5IElEIGZyb20gcmVzb2x2ZV9saWJyYXJ5IChlLmcuIC93ZWJzaXRlcy9yZWFjdF9kZXYpIGFuZCBhIGZvY3VzZWQgdG9waWMgcXVlcnkgXCIgK1xuXHRcdFx0XCJ0byBnZXQgdGhlIG1vc3QgcmVsZXZhbnQgc25pcHBldHMuIFwiICtcblx0XHRcdFwiVGhlIHRva2VucyBwYXJhbWV0ZXIgY29udHJvbHMgaG93IG11Y2ggZG9jdW1lbnRhdGlvbiB0byByZXRyaWV2ZSAoZGVmYXVsdCA1MDAwLCBtYXggMTAwMDApLiBcIiArXG5cdFx0XHRcIkEgc3BlY2lmaWMgcXVlcnkgKGUuZy4gJ3NlcnZlciBhY3Rpb25zIGZvcm0gc3VibWlzc2lvbicpIHJldHVybnMgYmV0dGVyIHJlc3VsdHMgdGhhbiBhIGJyb2FkIG9uZS5cIixcblx0XHRwcm9tcHRTbmlwcGV0OiBcIkZldGNoIHVwLXRvLWRhdGUsIHZlcnNpb24tc3BlY2lmaWMgZG9jdW1lbnRhdGlvbiBmb3IgYSBsaWJyYXJ5IGZyb20gQ29udGV4dDdcIixcblx0XHRwcm9tcHRHdWlkZWxpbmVzOiBbXG5cdFx0XHRcIlVzZSBhIHNwZWNpZmljIHRvcGljIHF1ZXJ5IGZvciBiZXN0IHJlc3VsdHMgXHUyMDE0IGUuZy4gJ3VzZUVmZmVjdCBjbGVhbnVwJyBub3QganVzdCAnaG9va3MnLlwiLFxuXHRcdFx0XCJTdGFydCB3aXRoIHRva2Vucz01MDAwLiBJbmNyZWFzZSB0byAxMDAwMCBvbmx5IGlmIHRoZSBmaXJzdCByZXNwb25zZSBsYWNrcyB0aGUgZGV0YWlsIHlvdSBuZWVkLlwiLFxuXHRcdFx0XCJSZXN1bHRzIGFyZSBjYWNoZWQgcGVyLXNlc3Npb24gXHUyMDE0IHJlcGVhdGVkIGNhbGxzIGZvciB0aGUgc2FtZSBsaWJyYXJ5K3F1ZXJ5IGhhdmUgbm8gQVBJIGNvc3QuXCIsXG5cdFx0XSxcblx0XHRwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG5cdFx0XHRsaWJyYXJ5SWQ6IFR5cGUuU3RyaW5nKHtcblx0XHRcdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcdFx0XCJDb250ZXh0NyBsaWJyYXJ5IElEIGZyb20gcmVzb2x2ZV9saWJyYXJ5LCBlLmcuIC93ZWJzaXRlcy9yZWFjdF9kZXYgb3IgL3ZlcmNlbC9uZXh0LmpzXCIsXG5cdFx0XHR9KSxcblx0XHRcdHF1ZXJ5OiBUeXBlLk9wdGlvbmFsKFxuXHRcdFx0XHRUeXBlLlN0cmluZyh7XG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcdFx0XHRcIlNwZWNpZmljIHRvcGljIHRvIGZvY3VzIHRoZSBkb2NzIG9uLCBlLmcuICdzZXJ2ZXIgYWN0aW9ucycsICd1c2VFZmZlY3QgY2xlYW51cCcsICdhdXRoZW50aWNhdGlvbiBtaWRkbGV3YXJlJy4gTW9yZSBzcGVjaWZpYyA9IGJldHRlciByZXN1bHRzLlwiLFxuXHRcdFx0XHR9KSxcblx0XHRcdCksXG5cdFx0XHR0b2tlbnM6IFR5cGUuT3B0aW9uYWwoXG5cdFx0XHRcdFR5cGUuTnVtYmVyKHtcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjogXCJNYXggdG9rZW5zIG9mIGRvY3VtZW50YXRpb24gdG8gcmV0dXJuIChkZWZhdWx0IDUwMDAsIG1heCAxMDAwMCkuXCIsXG5cdFx0XHRcdFx0bWluaW11bTogNTAwLFxuXHRcdFx0XHRcdG1heGltdW06IDEwMDAwLFxuXHRcdFx0XHR9KSxcblx0XHRcdCksXG5cdFx0fSksXG5cblx0XHRhc3luYyBleGVjdXRlKF90b29sQ2FsbElkLCBwYXJhbXMsIHNpZ25hbCwgX29uVXBkYXRlLCBfY3R4KSB7XG5cdFx0XHRjb25zdCB0b2tlbnMgPSBNYXRoLm1pbihNYXRoLm1heChwYXJhbXMudG9rZW5zID8/IDUwMDAsIDUwMCksIDEwMDAwKTtcblx0XHRcdC8vIFN0cmlwIGFjY2lkZW50YWwgbGVhZGluZyBAIHRoYXQgc29tZSBtb2RlbHMgaW5qZWN0XG5cdFx0XHRjb25zdCBsaWJyYXJ5SWQgPSBwYXJhbXMubGlicmFyeUlkLnN0YXJ0c1dpdGgoXCJAXCIpXG5cdFx0XHRcdD8gcGFyYW1zLmxpYnJhcnlJZC5zbGljZSgxKVxuXHRcdFx0XHQ6IHBhcmFtcy5saWJyYXJ5SWQ7XG5cdFx0XHRjb25zdCBxdWVyeSA9IHBhcmFtcy5xdWVyeT8udHJpbSgpIHx8IHVuZGVmaW5lZDtcblxuXHRcdFx0Y29uc3QgY2FjaGVLZXkgPSBgJHtsaWJyYXJ5SWR9Ojoke3F1ZXJ5ID8/IFwiXCJ9Ojoke3Rva2Vuc31gO1xuXG5cdFx0XHRpZiAoZG9jQ2FjaGUuaGFzKGNhY2hlS2V5KSkge1xuXHRcdFx0XHRjb25zdCBjYWNoZWQgPSBkb2NDYWNoZS5nZXQoY2FjaGVLZXkpITtcblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogY2FjaGVkIH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHtcblx0XHRcdFx0XHRcdGxpYnJhcnlJZCxcblx0XHRcdFx0XHRcdHF1ZXJ5LFxuXHRcdFx0XHRcdFx0dG9rZW5zLFxuXHRcdFx0XHRcdFx0Y2FjaGVkOiB0cnVlLFxuXHRcdFx0XHRcdFx0dHJ1bmNhdGVkOiBmYWxzZSxcblx0XHRcdFx0XHRcdGNoYXJDb3VudDogY2FjaGVkLmxlbmd0aCxcblx0XHRcdFx0XHR9IGFzIERvY3NEZXRhaWxzLFxuXHRcdFx0XHR9O1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCB1cmwgPSBuZXcgVVJMKGAke0JBU0VfVVJMfS9jb250ZXh0YCk7XG5cdFx0XHR1cmwuc2VhcmNoUGFyYW1zLnNldChcImxpYnJhcnlJZFwiLCBsaWJyYXJ5SWQpO1xuXHRcdFx0aWYgKHF1ZXJ5KSB1cmwuc2VhcmNoUGFyYW1zLnNldChcInF1ZXJ5XCIsIHF1ZXJ5KTtcblx0XHRcdHVybC5zZWFyY2hQYXJhbXMuc2V0KFwidG9rZW5zXCIsIFN0cmluZyh0b2tlbnMpKTtcblxuXHRcdFx0bGV0IHJhd1RleHQ6IHN0cmluZztcblx0XHRcdHRyeSB7XG5cdFx0XHRcdHJhd1RleHQgPSBhd2FpdCBhcGlGZXRjaFRleHQodXJsLnRvU3RyaW5nKCksIHNpZ25hbCk7XG5cdFx0XHR9IGNhdGNoIChlcnI6IHVua25vd24pIHtcblx0XHRcdFx0Y29uc3QgbXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgQ29udGV4dDcgZG9jIGZldGNoIGZhaWxlZDogJHttc2d9YCB9XSxcblx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHRcdGRldGFpbHM6IHtcblx0XHRcdFx0XHRcdGxpYnJhcnlJZCxcblx0XHRcdFx0XHRcdHF1ZXJ5LFxuXHRcdFx0XHRcdFx0dG9rZW5zLFxuXHRcdFx0XHRcdFx0Y2FjaGVkOiBmYWxzZSxcblx0XHRcdFx0XHRcdHRydW5jYXRlZDogZmFsc2UsXG5cdFx0XHRcdFx0XHRjaGFyQ291bnQ6IDAsXG5cdFx0XHRcdFx0XHRlcnJvcjogbXNnLFxuXHRcdFx0XHRcdH0gYXMgRG9jc0RldGFpbHMsXG5cdFx0XHRcdH07XG5cdFx0XHR9XG5cblx0XHRcdGlmICghcmF3VGV4dC50cmltKCkpIHtcblx0XHRcdFx0Y29uc3Qgbm90Rm91bmQgPSBxdWVyeVxuXHRcdFx0XHRcdD8gYE5vIGRvY3VtZW50YXRpb24gZm91bmQgZm9yIFwiJHtxdWVyeX1cIiBpbiAke2xpYnJhcnlJZH0uIFRyeSBhIGJyb2FkZXIgcXVlcnkgb3IgZGlmZmVyZW50IGxpYnJhcnkgSUQuYFxuXHRcdFx0XHRcdDogYE5vIGRvY3VtZW50YXRpb24gZm91bmQgZm9yICR7bGlicmFyeUlkfS4gVHJ5IHJlc29sdmVfbGlicmFyeSB0byB2ZXJpZnkgdGhlIGxpYnJhcnkgSUQuYDtcblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogbm90Rm91bmQgfV0sXG5cdFx0XHRcdFx0ZGV0YWlsczoge1xuXHRcdFx0XHRcdFx0bGlicmFyeUlkLFxuXHRcdFx0XHRcdFx0cXVlcnksXG5cdFx0XHRcdFx0XHR0b2tlbnMsXG5cdFx0XHRcdFx0XHRjYWNoZWQ6IGZhbHNlLFxuXHRcdFx0XHRcdFx0dHJ1bmNhdGVkOiBmYWxzZSxcblx0XHRcdFx0XHRcdGNoYXJDb3VudDogMCxcblx0XHRcdFx0XHR9IGFzIERvY3NEZXRhaWxzLFxuXHRcdFx0XHR9O1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBUcnVuY2F0aW9uIGd1YXJkIFx1MjAxNCBDb250ZXh0NyBhbHJlYWR5IHJlc3BlY3RzIHRoZSB0b2tlbiBidWRnZXQsIGJ1dCBiZSBkZWZlbnNpdmVcblx0XHRcdGNvbnN0IHRydW5jYXRpb24gPSB0cnVuY2F0ZUhlYWQocmF3VGV4dCwge1xuXHRcdFx0XHRtYXhMaW5lczogREVGQVVMVF9NQVhfTElORVMsXG5cdFx0XHRcdG1heEJ5dGVzOiBERUZBVUxUX01BWF9CWVRFUyxcblx0XHRcdH0pO1xuXG5cdFx0XHRsZXQgZmluYWxUZXh0ID0gdHJ1bmNhdGlvbi5jb250ZW50O1xuXHRcdFx0aWYgKHRydW5jYXRpb24udHJ1bmNhdGVkKSB7XG5cdFx0XHRcdGZpbmFsVGV4dCArPVxuXHRcdFx0XHRcdGBcXG5cXG5bVHJ1bmNhdGVkOiBzaG93aW5nICR7dHJ1bmNhdGlvbi5vdXRwdXRMaW5lc30vJHt0cnVuY2F0aW9uLnRvdGFsTGluZXN9IGxpbmVzYCArXG5cdFx0XHRcdFx0YCAoJHtmb3JtYXRTaXplKHRydW5jYXRpb24ub3V0cHV0Qnl0ZXMpfSBvZiAke2Zvcm1hdFNpemUodHJ1bmNhdGlvbi50b3RhbEJ5dGVzKX0pLmAgK1xuXHRcdFx0XHRcdGAgVXNlIGEgbW9yZSBzcGVjaWZpYyBxdWVyeSB0byByZWR1Y2Ugb3V0cHV0IHNpemUuXWA7XG5cdFx0XHR9XG5cblx0XHRcdGRvY0NhY2hlLnNldChjYWNoZUtleSwgZmluYWxUZXh0KTtcblxuXHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGZpbmFsVGV4dCB9XSxcblx0XHRcdFx0ZGV0YWlsczoge1xuXHRcdFx0XHRcdGxpYnJhcnlJZCxcblx0XHRcdFx0XHRxdWVyeSxcblx0XHRcdFx0XHR0b2tlbnMsXG5cdFx0XHRcdFx0Y2FjaGVkOiBmYWxzZSxcblx0XHRcdFx0XHR0cnVuY2F0ZWQ6IHRydW5jYXRpb24udHJ1bmNhdGVkLFxuXHRcdFx0XHRcdGNoYXJDb3VudDogZmluYWxUZXh0Lmxlbmd0aCxcblx0XHRcdFx0fSBhcyBEb2NzRGV0YWlscyxcblx0XHRcdH07XG5cdFx0fSxcblxuXHRcdHJlbmRlckNhbGwoYXJncywgdGhlbWUpIHtcblx0XHRcdGxldCB0ZXh0ID0gdGhlbWUuZmcoXCJ0b29sVGl0bGVcIiwgdGhlbWUuYm9sZChcImdldF9saWJyYXJ5X2RvY3MgXCIpKTtcblx0XHRcdHRleHQgKz0gdGhlbWUuZmcoXCJhY2NlbnRcIiwgYXJncy5saWJyYXJ5SWQpO1xuXHRcdFx0aWYgKGFyZ3MucXVlcnkpIHRleHQgKz0gdGhlbWUuZmcoXCJtdXRlZFwiLCBgIFx1MjAxNCBcIiR7YXJncy5xdWVyeX1cImApO1xuXHRcdFx0aWYgKGFyZ3MudG9rZW5zICYmIGFyZ3MudG9rZW5zICE9PSA1MDAwKSB0ZXh0ICs9IHRoZW1lLmZnKFwiZGltXCIsIGAgKCR7YXJncy50b2tlbnN9IHRva2VucylgKTtcblx0XHRcdHJldHVybiBuZXcgVGV4dCh0ZXh0LCAwLCAwKTtcblx0XHR9LFxuXG5cdFx0cmVuZGVyUmVzdWx0KHJlc3VsdCwgeyBpc1BhcnRpYWwsIGV4cGFuZGVkIH0sIHRoZW1lKSB7XG5cdFx0XHRjb25zdCBkID0gcmVzdWx0LmRldGFpbHMgYXMgRG9jc0RldGFpbHMgfCB1bmRlZmluZWQ7XG5cblx0XHRcdGlmIChpc1BhcnRpYWwpIHJldHVybiBuZXcgVGV4dCh0aGVtZS5mZyhcIndhcm5pbmdcIiwgXCJGZXRjaGluZyBkb2N1bWVudGF0aW9uLi4uXCIpLCAwLCAwKTtcblx0XHRcdGlmICgocmVzdWx0IGFzIGFueSkuaXNFcnJvciB8fCBkPy5lcnJvcikge1xuXHRcdFx0XHRyZXR1cm4gbmV3IFRleHQodGhlbWUuZmcoXCJlcnJvclwiLCBgRXJyb3I6ICR7ZD8uZXJyb3IgPz8gXCJ1bmtub3duXCJ9YCksIDAsIDApO1xuXHRcdFx0fVxuXG5cdFx0XHRsZXQgdGV4dCA9IHRoZW1lLmZnKFwic3VjY2Vzc1wiLCBgJHsoZD8uY2hhckNvdW50ID8/IDApLnRvTG9jYWxlU3RyaW5nKCl9IGNoYXJzYCk7XG5cdFx0XHR0ZXh0ICs9IHRoZW1lLmZnKFwiZGltXCIsIGAgXHUwMEI3ICR7ZD8udG9rZW5zID8/IDUwMDB9IHRva2VuIGJ1ZGdldGApO1xuXHRcdFx0aWYgKGQ/LmNhY2hlZCkgdGV4dCArPSB0aGVtZS5mZyhcImRpbVwiLCBcIiBcdTAwQjcgY2FjaGVkXCIpO1xuXHRcdFx0aWYgKGQ/LnRydW5jYXRlZCkgdGV4dCArPSB0aGVtZS5mZyhcIndhcm5pbmdcIiwgXCIgXHUwMEI3IHRydW5jYXRlZFwiKTtcblx0XHRcdHRleHQgKz0gdGhlbWUuZmcoXCJkaW1cIiwgYCBcdTAwQjcgJHtkPy5saWJyYXJ5SWR9YCk7XG5cdFx0XHRpZiAoZD8ucXVlcnkpIHRleHQgKz0gdGhlbWUuZmcoXCJkaW1cIiwgYCBcdTIwMTQgXCIke2QucXVlcnl9XCJgKTtcblxuXHRcdFx0aWYgKGV4cGFuZGVkKSB7XG5cdFx0XHRcdGNvbnN0IGNvbnRlbnQgPSByZXN1bHQuY29udGVudFswXTtcblx0XHRcdFx0aWYgKGNvbnRlbnQ/LnR5cGUgPT09IFwidGV4dFwiKSB7XG5cdFx0XHRcdFx0Y29uc3QgcHJldmlldyA9IGNvbnRlbnQudGV4dC5zcGxpdChcIlxcblwiKS5zbGljZSgwLCAxMikuam9pbihcIlxcblwiKTtcblx0XHRcdFx0XHR0ZXh0ICs9IFwiXFxuXFxuXCIgKyB0aGVtZS5mZyhcImRpbVwiLCBwcmV2aWV3KTtcblx0XHRcdFx0XHRpZiAoY29udGVudC50ZXh0LnNwbGl0KFwiXFxuXCIpLmxlbmd0aCA+IDEyKSB7XG5cdFx0XHRcdFx0XHR0ZXh0ICs9IFwiXFxuXCIgKyB0aGVtZS5mZyhcIm11dGVkXCIsIFwiXHUyMDI2IChDdHJsK08gdG8gY29sbGFwc2UpXCIpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHRyZXR1cm4gbmV3IFRleHQodGV4dCwgMCwgMCk7XG5cdFx0fSxcblx0fSk7XG5cblx0Ly8gXHUyNTAwXHUyNTAwIFNlc3Npb24gY2xlYW51cCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuXHRwaS5vbihcInNlc3Npb25fc2h1dGRvd25cIiwgYXN5bmMgKCkgPT4ge1xuXHRcdHNlYXJjaENhY2hlLmNsZWFyKCk7XG5cdFx0ZG9jQ2FjaGUuY2xlYXIoKTtcblx0fSk7XG5cblx0Ly8gXHUyNTAwXHUyNTAwIFN0YXJ0dXAgbm90aWZpY2F0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5cdHBpLm9uKFwic2Vzc2lvbl9zdGFydFwiLCBhc3luYyAoX2V2ZW50LCBjdHgpID0+IHtcblx0XHRpZiAoIWdldEFwaUtleSgpKSB7XG5cdFx0XHRjdHgudWkubm90aWZ5KFxuXHRcdFx0XHRcIkNvbnRleHQ3OiBObyBDT05URVhUN19BUElfS0VZIHNldC4gVXNpbmcgZnJlZSB0aWVyICgxMDAwIHJlcS9tb250aCBsaW1pdCkuIFwiICtcblx0XHRcdFx0XCJTZXQgQ09OVEVYVDdfQVBJX0tFWSBmb3IgaGlnaGVyIGxpbWl0cy5cIixcblx0XHRcdFx0XCJ3YXJuaW5nXCIsXG5cdFx0XHQpO1xuXHRcdH1cblx0fSk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUF5QkE7QUFBQSxFQUNDO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDTTtBQUNQLFNBQVMsWUFBWTtBQUNyQixTQUFTLFlBQVk7QUEyQnJCLE1BQU0sY0FBYyxvQkFBSSxJQUF5QjtBQUdqRCxNQUFNLFdBQVcsb0JBQUksSUFBb0I7QUFJekMsTUFBTSxXQUFXO0FBRWpCLFNBQVMsWUFBZ0M7QUFDeEMsU0FBTyxRQUFRLElBQUk7QUFDcEI7QUFFQSxTQUFTLGVBQXVDO0FBQy9DLFFBQU0sVUFBa0M7QUFBQSxJQUN2QyxjQUFjO0FBQUEsRUFDZjtBQUNBLFFBQU0sTUFBTSxVQUFVO0FBQ3RCLE1BQUksSUFBSyxTQUFRLGVBQWUsSUFBSSxVQUFVLEdBQUc7QUFDakQsU0FBTztBQUNSO0FBRUEsZUFBZSxhQUFhLEtBQWEsUUFBd0M7QUFDaEYsUUFBTSxNQUFNLE1BQU0sTUFBTSxLQUFLLEVBQUUsU0FBUyxFQUFFLEdBQUcsYUFBYSxHQUFHLFFBQVEsbUJBQW1CLEdBQUcsT0FBTyxDQUFDO0FBQ25HLE1BQUksQ0FBQyxJQUFJLElBQUk7QUFDWixVQUFNLE9B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
