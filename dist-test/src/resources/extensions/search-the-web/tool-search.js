import { truncateHead, formatSize, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@gsd/pi-coding-agent";
import { Text } from "@gsd/pi-tui";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@gsd/pi-ai";
import { LRUTTLCache } from "./cache.js";
import { fetchWithRetryTimed, fetchWithRetry, classifyError } from "./http.js";
import { normalizeQuery, toDedupeKey, detectFreshness } from "./url-utils.js";
import { formatSearchResults } from "./format.js";
import { getTavilyApiKey, getOllamaApiKey, braveHeaders, resolveSearchProvider } from "./provider.js";
import { normalizeTavilyResult, mapFreshnessToTavily } from "./tavily.js";
const searchCache = new LRUTTLCache({ max: 100, ttlMs: 6e5 });
searchCache.startPurgeInterval(6e4);
const MAX_CONSECUTIVE_DUPES = 1;
let lastSearchKey = "";
let consecutiveDupeCount = 0;
const MAX_SEARCHES_PER_SESSION = 15;
let sessionTotalSearches = 0;
function resetSearchLoopGuardState() {
  lastSearchKey = "";
  consecutiveDupeCount = 0;
  sessionTotalSearches = 0;
}
const summarizerCache = new LRUTTLCache({ max: 50, ttlMs: 9e5 });
function normalizeBraveResult(r) {
  return {
    title: r.title || "(untitled)",
    url: r.url,
    description: r.description || "",
    age: r.age || r.page_age || void 0,
    extra_snippets: r.extra_snippets || void 0
  };
}
function deduplicateResults(results) {
  const seen = /* @__PURE__ */ new Map();
  for (const result of results) {
    const key = toDedupeKey(result.url);
    if (key !== null && !seen.has(key)) {
      seen.set(key, result);
    }
  }
  return Array.from(seen.values());
}
async function fetchSummary(summarizerKey, signal) {
  const cached = summarizerCache.get(summarizerKey);
  if (cached !== void 0) return cached;
  try {
    const url = `https://api.search.brave.com/res/v1/summarizer/search?key=${encodeURIComponent(summarizerKey)}&entity_info=false`;
    const response = await fetchWithRetry(url, {
      method: "GET",
      headers: braveHeaders(),
      signal
    }, 1);
    const data = await response.json();
    let summaryText = "";
    if (data.summary && Array.isArray(data.summary)) {
      summaryText = data.summary.filter((s) => s.type === "token" || s.type === "text").map((s) => s.data).join("");
    }
    if (summaryText) {
      summarizerCache.set(summarizerKey, summaryText);
      return summaryText;
    }
    return null;
  } catch {
    return null;
  }
}
async function executeTavilySearch(params, signal) {
  const requestBody = {
    query: params.query,
    max_results: 10,
    search_depth: "basic"
  };
  const tavilyTimeRange = mapFreshnessToTavily(params.freshness);
  if (tavilyTimeRange) {
    requestBody.time_range = tavilyTimeRange;
  }
  if (params.domain) {
    requestBody.include_domains = [params.domain];
  }
  if (params.wantSummary) {
    requestBody.include_answer = true;
  }
  const timed = await fetchWithRetryTimed("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${getTavilyApiKey()}`
    },
    body: JSON.stringify(requestBody),
    signal
  }, 2);
  const data = await timed.response.json();
  const normalized = data.results.map(normalizeTavilyResult);
  const deduplicated = deduplicateResults(normalized);
  return {
    results: {
      results: deduplicated,
      summaryText: data.answer || void 0,
      queryCorrected: false,
      moreResultsAvailable: false
    },
    latencyMs: timed.latencyMs,
    rateLimit: timed.rateLimit
  };
}
async function executeOllamaSearch(params, signal) {
  const timed = await fetchWithRetryTimed("https://ollama.com/api/web_search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${getOllamaApiKey()}`
    },
    body: JSON.stringify({ query: params.query, max_results: params.count }),
    signal
  }, 2);
  const data = await timed.response.json();
  const normalized = (data.results || []).map((r) => ({
    title: r.title || "(untitled)",
    url: r.url,
    description: r.content || ""
  }));
  const deduplicated = deduplicateResults(normalized);
  return {
    results: {
      results: deduplicated,
      queryCorrected: false,
      moreResultsAvailable: false
    },
    latencyMs: timed.latencyMs,
    rateLimit: timed.rateLimit
  };
}
function registerSearchTool(pi) {
  pi.registerTool({
    name: "search-the-web",
    label: "Web Search",
    description: "Search the web using Brave Search API. Returns top results with titles, URLs, descriptions, extra contextual snippets, result ages, and optional AI summary. Supports freshness filtering, domain filtering, and auto-detects recency-sensitive queries.",
    promptSnippet: "Search the web for information",
    promptGuidelines: [
      "Use this tool when the user asks about current events, facts, or external knowledge not in the codebase.",
      "Always provide the search query to the user in your response.",
      "Limit to 3-5 results unless more context is needed.",
      "Use freshness='week' or 'month' for queries about recent events, releases, or updates.",
      "Use the fetch_page tool to read the full content of promising URLs from search results."
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query (e.g., 'latest AI news')" }),
      count: Type.Optional(
        Type.Number({ minimum: 1, maximum: 10, default: 5, description: "Number of results to return (default: 5)" })
      ),
      freshness: Type.Optional(
        StringEnum(["auto", "day", "week", "month", "year"], {
          description: "Filter by recency. 'auto' (default) detects from query. 'day'=past 24h, 'week'=past 7d, 'month'=past 30d, 'year'=past 365d."
        })
      ),
      domain: Type.Optional(
        Type.String({
          description: "Limit results to a specific domain (e.g., 'stackoverflow.com', 'github.com')"
        })
      ),
      summary: Type.Optional(
        Type.Boolean({
          description: "Request an AI-generated summary of the search results (default: false). Adds latency but provides a concise answer.",
          default: false
        })
      )
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Search cancelled." }], details: void 0 };
      }
      const provider = resolveSearchProvider();
      if (!provider) {
        return {
          content: [{ type: "text", text: "Web search unavailable: No search API key is set. Use secure_env_collect to set TAVILY_API_KEY, BRAVE_API_KEY, or OLLAMA_API_KEY." }],
          isError: true,
          details: { errorKind: "auth_error", error: "No search API key set" }
        };
      }
      if (sessionTotalSearches >= MAX_SEARCHES_PER_SESSION) {
        return {
          content: [{ type: "text", text: `\u26A0\uFE0F Search budget exhausted: ${sessionTotalSearches}/${MAX_SEARCHES_PER_SESSION} searches used this session. The information you need should already be in previous search results. Stop searching and use those results to proceed with your task.` }],
          isError: true,
          details: { errorKind: "budget_exhausted", error: `Session search budget exhausted (${MAX_SEARCHES_PER_SESSION})` }
        };
      }
      const count = params.count ?? 5;
      const wantSummary = params.summary ?? false;
      let freshness = null;
      if (params.freshness && params.freshness !== "auto") {
        const freshnessMap = {
          day: "pd",
          week: "pw",
          month: "pm",
          year: "py"
        };
        freshness = freshnessMap[params.freshness] || null;
      } else {
        freshness = detectFreshness(params.query);
      }
      let effectiveQuery = params.query;
      if (provider === "brave" && params.domain) {
        if (!effectiveQuery.toLowerCase().includes("site:")) {
          effectiveQuery = `site:${params.domain} ${effectiveQuery}`;
        }
      }
      const cacheKey = normalizeQuery(effectiveQuery) + `|f:${freshness || ""}|s:${wantSummary}|p:${provider}`;
      if (cacheKey === lastSearchKey) {
        consecutiveDupeCount++;
        if (consecutiveDupeCount > MAX_CONSECUTIVE_DUPES) {
          return {
            content: [{ type: "text", text: `\u26A0\uFE0F Search loop detected: the query "${params.query}" has been searched ${consecutiveDupeCount} times consecutively with identical results. The information you need is already in the previous search results above. Stop searching and use those results to proceed with your task.` }],
            isError: true,
            details: { errorKind: "search_loop", error: "Consecutive duplicate search detected" }
          };
        }
      } else {
        lastSearchKey = cacheKey;
        consecutiveDupeCount = 1;
      }
      sessionTotalSearches++;
      const cached = searchCache.get(cacheKey);
      if (cached) {
        const limited = cached.results.slice(0, count);
        let summaryText;
        if (wantSummary) {
          if (cached.summaryText) {
            summaryText = cached.summaryText;
          } else if (cached.summarizerKey) {
            summaryText = await fetchSummary(cached.summarizerKey, signal) ?? void 0;
          }
        }
        const formatOpts = {
          cached: true,
          summary: summaryText,
          queryCorrected: cached.queryCorrected,
          originalQuery: cached.originalQuery,
          correctedQuery: cached.correctedQuery,
          moreResultsAvailable: cached.moreResultsAvailable
        };
        const output = formatSearchResults(params.query, limited, formatOpts);
        const truncation = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
        let content = truncation.content;
        if (truncation.truncated) {
          const tempFile = await pi.writeTempFile(output, { prefix: "web-search-" });
          content += `

[Truncated: ${truncation.outputLines}/${truncation.totalLines} lines (${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}). Full results: ${tempFile}]`;
        }
        const details = {
          query: params.query,
          effectiveQuery,
          results: limited,
          count: limited.length,
          cached: true,
          freshness: freshness || "none",
          hasSummary: !!summaryText,
          queryCorrected: cached.queryCorrected,
          originalQuery: cached.originalQuery,
          correctedQuery: cached.correctedQuery,
          moreResultsAvailable: cached.moreResultsAvailable,
          provider
        };
        return { content: [{ type: "text", text: content }], details };
      }
      onUpdate?.({ content: [{ type: "text", text: `Searching for "${params.query}"...` }], details: void 0 });
      try {
        let searchResult;
        let latencyMs;
        let rateLimit;
        if (provider === "tavily") {
          const tavilyResult = await executeTavilySearch(
            { query: params.query, freshness, domain: params.domain, wantSummary },
            signal
          );
          searchResult = tavilyResult.results;
          latencyMs = tavilyResult.latencyMs;
          rateLimit = tavilyResult.rateLimit;
        } else if (provider === "ollama") {
          const ollamaResult = await executeOllamaSearch(
            { query: params.query, count: 10 },
            signal
          );
          searchResult = ollamaResult.results;
          latencyMs = ollamaResult.latencyMs;
          rateLimit = ollamaResult.rateLimit;
        } else {
          const url = new URL("https://api.search.brave.com/res/v1/web/search");
          url.searchParams.append("q", effectiveQuery);
          url.searchParams.append("count", "10");
          url.searchParams.append("extra_snippets", "true");
          url.searchParams.append("text_decorations", "false");
          if (freshness) {
            url.searchParams.append("freshness", freshness);
          }
          if (wantSummary) {
            url.searchParams.append("summary", "1");
          }
          const timed = await fetchWithRetryTimed(url.toString(), {
            method: "GET",
            headers: braveHeaders(),
            signal
          }, 2);
          const data = await timed.response.json();
          const rawResults = data.web?.results ?? [];
          const summarizerKey = data.summarizer?.key;
          const queryInfo = data.query;
          const queryCorrected = !!(queryInfo?.altered && queryInfo.altered !== queryInfo.original);
          const originalQuery = queryCorrected ? queryInfo?.original ?? params.query : void 0;
          const correctedQuery = queryCorrected ? queryInfo?.altered : void 0;
          const moreResultsAvailable = queryInfo?.more_results_available ?? false;
          const normalized = rawResults.map(normalizeBraveResult);
          const deduplicated = deduplicateResults(normalized);
          searchResult = {
            results: deduplicated,
            summarizerKey,
            queryCorrected,
            originalQuery,
            correctedQuery,
            moreResultsAvailable
          };
          latencyMs = timed.latencyMs;
          rateLimit = timed.rateLimit;
        }
        searchCache.set(cacheKey, searchResult);
        const results = searchResult.results.slice(0, count);
        let summaryText;
        if (wantSummary) {
          if (searchResult.summaryText) {
            summaryText = searchResult.summaryText;
          } else if (searchResult.summarizerKey) {
            summaryText = await fetchSummary(searchResult.summarizerKey, signal) ?? void 0;
          }
        }
        const formatOpts = {
          summary: summaryText,
          queryCorrected: searchResult.queryCorrected,
          originalQuery: searchResult.originalQuery,
          correctedQuery: searchResult.correctedQuery,
          moreResultsAvailable: searchResult.moreResultsAvailable
        };
        const output = formatSearchResults(params.query, results, formatOpts);
        const truncation = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
        let content = truncation.content;
        if (truncation.truncated) {
          const tempFile = await pi.writeTempFile(output, { prefix: "web-search-" });
          content += `

[Truncated: ${truncation.outputLines}/${truncation.totalLines} lines (${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}). Full results: ${tempFile}]`;
        }
        const details = {
          query: params.query,
          effectiveQuery,
          results,
          count: results.length,
          cached: false,
          freshness: freshness || "none",
          hasSummary: !!summaryText,
          latencyMs,
          rateLimit,
          queryCorrected: searchResult.queryCorrected,
          originalQuery: searchResult.originalQuery,
          correctedQuery: searchResult.correctedQuery,
          moreResultsAvailable: searchResult.moreResultsAvailable,
          provider
        };
        return { content: [{ type: "text", text: content }], details };
      } catch (error) {
        const classified = classifyError(error);
        return {
          content: [{ type: "text", text: `Search failed: ${classified.message}` }],
          details: {
            errorKind: classified.kind,
            error: classified.message,
            retryAfterMs: classified.retryAfterMs,
            query: params.query,
            provider
          },
          isError: true
        };
      }
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("search-the-web "));
      text += theme.fg("muted", `"${args.query}"`);
      const meta = [];
      if (args.count && args.count !== 5) meta.push(`${args.count} results`);
      if (args.freshness && args.freshness !== "auto") meta.push(`freshness:${args.freshness}`);
      if (args.domain) meta.push(`site:${args.domain}`);
      if (args.summary) meta.push("+ summary");
      if (meta.length > 0) {
        text += " " + theme.fg("dim", `(${meta.join(", ")})`);
      }
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details;
      if (details?.errorKind || details?.error) {
        const kindTag = details.errorKind ? theme.fg("dim", ` [${details.errorKind}]`) : "";
        return new Text(theme.fg("error", `\u2717 ${details.error ?? "Search failed"}`) + kindTag, 0, 0);
      }
      const providerTag = details?.provider ? theme.fg("dim", ` [${details.provider}]`) : "";
      const cacheTag = details?.cached ? theme.fg("dim", " [cached]") : "";
      const freshTag = details?.freshness && details.freshness !== "none" ? theme.fg("dim", ` [${details.freshness}]`) : "";
      const summaryTag = details?.hasSummary ? theme.fg("dim", " [+summary]") : "";
      const latencyTag = details?.latencyMs ? theme.fg("dim", ` ${details.latencyMs}ms`) : "";
      const correctedTag = details?.queryCorrected ? theme.fg("warning", ` [corrected\u2192"${details.correctedQuery}"]`) : "";
      let text = theme.fg("success", `\u2713 ${details?.count ?? 0} results for "${details?.query}"`) + providerTag + cacheTag + freshTag + summaryTag + latencyTag + correctedTag;
      if (expanded && details?.results) {
        text += "\n\n";
        for (const r of details.results.slice(0, 3)) {
          const age = r.age ? theme.fg("dim", ` (${r.age})`) : "";
          text += `${theme.bold(r.title)}${age}
${r.url}
${r.description}

`;
        }
        if (details.results.length > 3) {
          text += theme.fg("dim", `... and ${details.results.length - 3} more`);
        }
      }
      return new Text(text, 0, 0);
    }
  });
}
export {
  registerSearchTool,
  resetSearchLoopGuardState
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL3NlYXJjaC10aGUtd2ViL3Rvb2wtc2VhcmNoLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIHNlYXJjaC10aGUtd2ViIHRvb2wgXHUyMDE0IFJpY2ggd2ViIHNlYXJjaCB3aXRoIGZ1bGwgQnJhdmUgQVBJIHN1cHBvcnQuXG4gKlxuICogdjMgaW1wcm92ZW1lbnRzOlxuICogLSBTdHJ1Y3R1cmVkIGVycm9yIHRheG9ub215IChhdXRoX2Vycm9yLCByYXRlX2xpbWl0ZWQsIG5ldHdvcmtfZXJyb3IsIGV0Yy4pXG4gKiAtIFNwZWxsY2hlY2svcXVlcnkgY29ycmVjdGlvbiBzdXJmYWNpbmdcbiAqIC0gTGF0ZW5jeSB0cmFja2luZyBpbiBkZXRhaWxzXG4gKiAtIG1vcmVfcmVzdWx0c19hdmFpbGFibGUgZnJvbSBCcmF2ZSByZXNwb25zZVxuICogLSBBZGFwdGl2ZSBzbmlwcGV0IGJ1ZGdldCAoZmV3ZXIgcmVzdWx0cyA9IG1vcmUgc25pcHBldHMgZWFjaClcbiAqIC0gUmF0ZSBsaW1pdCBpbmZvIGluIGRldGFpbHNcbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEV4dGVuc2lvbkFQSSB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuaW1wb3J0IHsgdHJ1bmNhdGVIZWFkLCBmb3JtYXRTaXplLCBERUZBVUxUX01BWF9CWVRFUywgREVGQVVMVF9NQVhfTElORVMgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7IFRleHQgfSBmcm9tIFwiQGdzZC9waS10dWlcIjtcbmltcG9ydCB7IFR5cGUgfSBmcm9tIFwiQHNpbmNsYWlyL3R5cGVib3hcIjtcbmltcG9ydCB7IFN0cmluZ0VudW0gfSBmcm9tIFwiQGdzZC9waS1haVwiO1xuXG5pbXBvcnQgeyBMUlVUVExDYWNoZSB9IGZyb20gXCIuL2NhY2hlLmpzXCI7XG5pbXBvcnQgeyBmZXRjaFdpdGhSZXRyeVRpbWVkLCBmZXRjaFdpdGhSZXRyeSwgY2xhc3NpZnlFcnJvciwgdHlwZSBSYXRlTGltaXRJbmZvIH0gZnJvbSBcIi4vaHR0cC5qc1wiO1xuaW1wb3J0IHsgbm9ybWFsaXplUXVlcnksIHRvRGVkdXBlS2V5LCBkZXRlY3RGcmVzaG5lc3MgfSBmcm9tIFwiLi91cmwtdXRpbHMuanNcIjtcbmltcG9ydCB7IGZvcm1hdFNlYXJjaFJlc3VsdHMsIHR5cGUgU2VhcmNoUmVzdWx0Rm9ybWF0dGVkLCB0eXBlIEZvcm1hdFNlYXJjaE9wdGlvbnMgfSBmcm9tIFwiLi9mb3JtYXQuanNcIjtcbmltcG9ydCB7IGdldFRhdmlseUFwaUtleSwgZ2V0T2xsYW1hQXBpS2V5LCBnZXRCcmF2ZUFwaUtleSwgYnJhdmVIZWFkZXJzLCByZXNvbHZlU2VhcmNoUHJvdmlkZXIgfSBmcm9tIFwiLi9wcm92aWRlci5qc1wiO1xuaW1wb3J0IHsgbm9ybWFsaXplVGF2aWx5UmVzdWx0LCBtYXBGcmVzaG5lc3NUb1RhdmlseSwgdHlwZSBUYXZpbHlTZWFyY2hSZXNwb25zZSB9IGZyb20gXCIuL3RhdmlseS5qc1wiO1xuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gVHlwZXNcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmludGVyZmFjZSBCcmF2ZVdlYlJlc3VsdCB7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIHVybDogc3RyaW5nO1xuICBkZXNjcmlwdGlvbjogc3RyaW5nO1xuICBhZ2U/OiBzdHJpbmc7XG4gIHBhZ2VfYWdlPzogc3RyaW5nO1xuICBsYW5ndWFnZT86IHN0cmluZztcbiAgZXh0cmFfc25pcHBldHM/OiBzdHJpbmdbXTtcbiAgbWV0YV91cmw/OiB7IHNjaGVtZT86IHN0cmluZzsgbmV0bG9jPzogc3RyaW5nOyBob3N0bmFtZT86IHN0cmluZzsgcGF0aD86IHN0cmluZyB9O1xuICBba2V5OiBzdHJpbmddOiB1bmtub3duO1xufVxuXG5pbnRlcmZhY2UgQnJhdmVTdW1tYXJpemVyUmVzcG9uc2Uge1xuICB0eXBlPzogc3RyaW5nO1xuICBzdGF0dXM/OiBudW1iZXI7XG4gIHRpdGxlPzogc3RyaW5nO1xuICBzdW1tYXJ5PzogQXJyYXk8eyB0eXBlOiBzdHJpbmc7IGRhdGE6IHN0cmluZyB9PjtcbiAgZW5yaWNobWVudHM/OiB1bmtub3duO1xuICBba2V5OiBzdHJpbmddOiB1bmtub3duO1xufVxuXG5pbnRlcmZhY2UgQnJhdmVTZWFyY2hSZXNwb25zZSB7XG4gIHF1ZXJ5Pzoge1xuICAgIG9yaWdpbmFsPzogc3RyaW5nO1xuICAgIGFsdGVyZWQ/OiBzdHJpbmc7XG4gICAgc2hvd19zdHJpY3Rfd2FybmluZz86IGJvb2xlYW47XG4gICAgbW9yZV9yZXN1bHRzX2F2YWlsYWJsZT86IGJvb2xlYW47XG4gICAgc3BlbGxjaGVja19vZmY/OiBib29sZWFuO1xuICB9O1xuICB3ZWI/OiB7XG4gICAgcmVzdWx0cz86IEJyYXZlV2ViUmVzdWx0W107XG4gIH07XG4gIHN1bW1hcml6ZXI/OiB7XG4gICAga2V5Pzogc3RyaW5nO1xuICB9O1xuICBba2V5OiBzdHJpbmddOiB1bmtub3duO1xufVxuXG5pbnRlcmZhY2UgQ2FjaGVkU2VhcmNoUmVzdWx0IHtcbiAgcmVzdWx0czogU2VhcmNoUmVzdWx0Rm9ybWF0dGVkW107XG4gIHN1bW1hcml6ZXJLZXk/OiBzdHJpbmc7XG4gIHN1bW1hcnlUZXh0Pzogc3RyaW5nO1xuICBxdWVyeUNvcnJlY3RlZD86IGJvb2xlYW47XG4gIG9yaWdpbmFsUXVlcnk/OiBzdHJpbmc7XG4gIGNvcnJlY3RlZFF1ZXJ5Pzogc3RyaW5nO1xuICBtb3JlUmVzdWx0c0F2YWlsYWJsZT86IGJvb2xlYW47XG59XG5cbi8qKiBTdHJ1Y3R1cmVkIGRldGFpbHMgcmV0dXJuZWQgZnJvbSB0aGUgc2VhcmNoIHRvb2wuICovXG5pbnRlcmZhY2UgU2VhcmNoRGV0YWlscyB7XG4gIHF1ZXJ5OiBzdHJpbmc7XG4gIGVmZmVjdGl2ZVF1ZXJ5OiBzdHJpbmc7XG4gIHJlc3VsdHM6IFNlYXJjaFJlc3VsdEZvcm1hdHRlZFtdO1xuICBjb3VudDogbnVtYmVyO1xuICBjYWNoZWQ6IGJvb2xlYW47XG4gIGZyZXNobmVzczogc3RyaW5nO1xuICBoYXNTdW1tYXJ5OiBib29sZWFuO1xuICBsYXRlbmN5TXM/OiBudW1iZXI7XG4gIHJhdGVMaW1pdD86IFJhdGVMaW1pdEluZm87XG4gIHF1ZXJ5Q29ycmVjdGVkPzogYm9vbGVhbjtcbiAgb3JpZ2luYWxRdWVyeT86IHN0cmluZztcbiAgY29ycmVjdGVkUXVlcnk/OiBzdHJpbmc7XG4gIG1vcmVSZXN1bHRzQXZhaWxhYmxlPzogYm9vbGVhbjtcbiAgZXJyb3JLaW5kPzogc3RyaW5nO1xuICBlcnJvcj86IHN0cmluZztcbiAgcmV0cnlBZnRlck1zPzogbnVtYmVyO1xuICBwcm92aWRlcj86ICd0YXZpbHknIHwgJ2JyYXZlJyB8ICdvbGxhbWEnO1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gQ2FjaGVzXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4vLyBTZWFyY2ggcmVzdWx0czogbWF4IDEwMCBlbnRyaWVzLCAxMC1taW51dGUgVFRMXG5jb25zdCBzZWFyY2hDYWNoZSA9IG5ldyBMUlVUVExDYWNoZTxDYWNoZWRTZWFyY2hSZXN1bHQ+KHsgbWF4OiAxMDAsIHR0bE1zOiA2MDBfMDAwIH0pO1xuc2VhcmNoQ2FjaGUuc3RhcnRQdXJnZUludGVydmFsKDYwXzAwMCk7XG5cbi8vIENvbnNlY3V0aXZlIGR1cGxpY2F0ZSBzZWFyY2ggZ3VhcmQgKCM5NDkpXG4vLyBUcmFja3MgcmVjZW50IHF1ZXJ5IGtleXMgdG8gZGV0ZWN0IGFuZCBicmVhayBzZWFyY2ggbG9vcHMuXG5jb25zdCBNQVhfQ09OU0VDVVRJVkVfRFVQRVMgPSAxO1xubGV0IGxhc3RTZWFyY2hLZXkgPSBcIlwiO1xubGV0IGNvbnNlY3V0aXZlRHVwZUNvdW50ID0gMDtcblxuLy8gU2Vzc2lvbi1sZXZlbCB0b3RhbCBzZWFyY2ggYnVkZ2V0IChhbGwgcXVlcmllcywgbm90IGp1c3QgZHVwbGljYXRlcykuXG4vLyBQcmV2ZW50cyB1bmJvdW5kZWQgc2VhcmNoIGFjY3VtdWxhdGlvbiBhY3Jvc3MgdmFyaWVkIHF1ZXJpZXMuXG5jb25zdCBNQVhfU0VBUkNIRVNfUEVSX1NFU1NJT04gPSAxNTtcbmxldCBzZXNzaW9uVG90YWxTZWFyY2hlcyA9IDA7XG5cbi8qKiBSZXNldCBzZXNzaW9uLXNjb3BlZCBzZWFyY2ggZ3VhcmQgc3RhdGUgKGJvdGggZHVwbGljYXRlIGFuZCBidWRnZXQpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc2V0U2VhcmNoTG9vcEd1YXJkU3RhdGUoKTogdm9pZCB7XG4gIGxhc3RTZWFyY2hLZXkgPSBcIlwiO1xuICBjb25zZWN1dGl2ZUR1cGVDb3VudCA9IDA7XG4gIHNlc3Npb25Ub3RhbFNlYXJjaGVzID0gMDtcbn1cblxuLy8gU3VtbWFyaXplciByZXNwb25zZXM6IG1heCA1MCBlbnRyaWVzLCAxNS1taW51dGUgVFRMXG5jb25zdCBzdW1tYXJpemVyQ2FjaGUgPSBuZXcgTFJVVFRMQ2FjaGU8c3RyaW5nPih7IG1heDogNTAsIHR0bE1zOiA5MDBfMDAwIH0pO1xuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gQnJhdmUgQVBJIGhlbHBlcnNcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogTm9ybWFsaXplIGEgQnJhdmUgcmVzdWx0IGludG8gb3VyIGZvcm1hdHRlZCByZXN1bHQgdHlwZS5cbiAqL1xuZnVuY3Rpb24gbm9ybWFsaXplQnJhdmVSZXN1bHQocjogQnJhdmVXZWJSZXN1bHQpOiBTZWFyY2hSZXN1bHRGb3JtYXR0ZWQge1xuICByZXR1cm4ge1xuICAgIHRpdGxlOiByLnRpdGxlIHx8IFwiKHVudGl0bGVkKVwiLFxuICAgIHVybDogci51cmwsXG4gICAgZGVzY3JpcHRpb246IHIuZGVzY3JpcHRpb24gfHwgXCJcIixcbiAgICBhZ2U6IHIuYWdlIHx8IHIucGFnZV9hZ2UgfHwgdW5kZWZpbmVkLFxuICAgIGV4dHJhX3NuaXBwZXRzOiByLmV4dHJhX3NuaXBwZXRzIHx8IHVuZGVmaW5lZCxcbiAgfTtcbn1cblxuLyoqXG4gKiBEZWR1cGxpY2F0ZSByZXN1bHRzIGJ5IFVSTCAoZmlyc3Qgb2NjdXJyZW5jZSB3aW5zKS5cbiAqL1xuZnVuY3Rpb24gZGVkdXBsaWNhdGVSZXN1bHRzKHJlc3VsdHM6IFNlYXJjaFJlc3VsdEZvcm1hdHRlZFtdKTogU2VhcmNoUmVzdWx0Rm9ybWF0dGVkW10ge1xuICBjb25zdCBzZWVuID0gbmV3IE1hcDxzdHJpbmcsIFNlYXJjaFJlc3VsdEZvcm1hdHRlZD4oKTtcbiAgZm9yIChjb25zdCByZXN1bHQgb2YgcmVzdWx0cykge1xuICAgIGNvbnN0IGtleSA9IHRvRGVkdXBlS2V5KHJlc3VsdC51cmwpO1xuICAgIGlmIChrZXkgIT09IG51bGwgJiYgIXNlZW4uaGFzKGtleSkpIHtcbiAgICAgIHNlZW4uc2V0KGtleSwgcmVzdWx0KTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIEFycmF5LmZyb20oc2Vlbi52YWx1ZXMoKSk7XG59XG5cbi8qKlxuICogRmV0Y2ggQUkgc3VtbWFyeSBmcm9tIEJyYXZlIFN1bW1hcml6ZXIgQVBJIChiZXN0LWVmZm9ydCwgZnJlZSkuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGZldGNoU3VtbWFyeShcbiAgc3VtbWFyaXplcktleTogc3RyaW5nLFxuICBzaWduYWw/OiBBYm9ydFNpZ25hbFxuKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG4gIGNvbnN0IGNhY2hlZCA9IHN1bW1hcml6ZXJDYWNoZS5nZXQoc3VtbWFyaXplcktleSk7XG4gIGlmIChjYWNoZWQgIT09IHVuZGVmaW5lZCkgcmV0dXJuIGNhY2hlZDtcblxuICB0cnkge1xuICAgIGNvbnN0IHVybCA9IGBodHRwczovL2FwaS5zZWFyY2guYnJhdmUuY29tL3Jlcy92MS9zdW1tYXJpemVyL3NlYXJjaD9rZXk9JHtlbmNvZGVVUklDb21wb25lbnQoc3VtbWFyaXplcktleSl9JmVudGl0eV9pbmZvPWZhbHNlYDtcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoV2l0aFJldHJ5KHVybCwge1xuICAgICAgbWV0aG9kOiBcIkdFVFwiLFxuICAgICAgaGVhZGVyczogYnJhdmVIZWFkZXJzKCksXG4gICAgICBzaWduYWwsXG4gICAgfSwgMSk7XG5cbiAgICBjb25zdCBkYXRhOiBCcmF2ZVN1bW1hcml6ZXJSZXNwb25zZSA9IGF3YWl0IHJlc3BvbnNlLmpzb24oKTtcblxuICAgIGxldCBzdW1tYXJ5VGV4dCA9IFwiXCI7XG4gICAgaWYgKGRhdGEuc3VtbWFyeSAmJiBBcnJheS5pc0FycmF5KGRhdGEuc3VtbWFyeSkpIHtcbiAgICAgIHN1bW1hcnlUZXh0ID0gZGF0YS5zdW1tYXJ5XG4gICAgICAgIC5maWx0ZXIoKHMpID0+IHMudHlwZSA9PT0gXCJ0b2tlblwiIHx8IHMudHlwZSA9PT0gXCJ0ZXh0XCIpXG4gICAgICAgIC5tYXAoKHMpID0+IHMuZGF0YSlcbiAgICAgICAgLmpvaW4oXCJcIik7XG4gICAgfVxuXG4gICAgaWYgKHN1bW1hcnlUZXh0KSB7XG4gICAgICBzdW1tYXJpemVyQ2FjaGUuc2V0KHN1bW1hcml6ZXJLZXksIHN1bW1hcnlUZXh0KTtcbiAgICAgIHJldHVybiBzdW1tYXJ5VGV4dDtcbiAgICB9XG4gICAgcmV0dXJuIG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBUYXZpbHkgQVBJIGV4ZWN1dGlvblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBFeGVjdXRlIGEgc2VhcmNoIGFnYWluc3QgdGhlIFRhdmlseSBBUEkuXG4gKiBSZXR1cm5zIGEgQ2FjaGVkU2VhcmNoUmVzdWx0IHdpdGggbm9ybWFsaXplZCwgZGVkdXBsaWNhdGVkIHJlc3VsdHMuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGV4ZWN1dGVUYXZpbHlTZWFyY2goXG4gIHBhcmFtczogeyBxdWVyeTogc3RyaW5nOyBmcmVzaG5lc3M6IHN0cmluZyB8IG51bGw7IGRvbWFpbj86IHN0cmluZzsgd2FudFN1bW1hcnk6IGJvb2xlYW4gfSxcbiAgc2lnbmFsPzogQWJvcnRTaWduYWxcbik6IFByb21pc2U8eyByZXN1bHRzOiBDYWNoZWRTZWFyY2hSZXN1bHQ7IGxhdGVuY3lNczogbnVtYmVyOyByYXRlTGltaXQ/OiBSYXRlTGltaXRJbmZvIH0+IHtcbiAgY29uc3QgcmVxdWVzdEJvZHk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgIHF1ZXJ5OiBwYXJhbXMucXVlcnksXG4gICAgbWF4X3Jlc3VsdHM6IDEwLFxuICAgIHNlYXJjaF9kZXB0aDogXCJiYXNpY1wiLFxuICB9O1xuXG4gIGNvbnN0IHRhdmlseVRpbWVSYW5nZSA9IG1hcEZyZXNobmVzc1RvVGF2aWx5KHBhcmFtcy5mcmVzaG5lc3MpO1xuICBpZiAodGF2aWx5VGltZVJhbmdlKSB7XG4gICAgcmVxdWVzdEJvZHkudGltZV9yYW5nZSA9IHRhdmlseVRpbWVSYW5nZTtcbiAgfVxuXG4gIGlmIChwYXJhbXMuZG9tYWluKSB7XG4gICAgcmVxdWVzdEJvZHkuaW5jbHVkZV9kb21haW5zID0gW3BhcmFtcy5kb21haW5dO1xuICB9XG5cbiAgaWYgKHBhcmFtcy53YW50U3VtbWFyeSkge1xuICAgIHJlcXVlc3RCb2R5LmluY2x1ZGVfYW5zd2VyID0gdHJ1ZTtcbiAgfVxuXG4gIGNvbnN0IHRpbWVkID0gYXdhaXQgZmV0Y2hXaXRoUmV0cnlUaW1lZChcImh0dHBzOi8vYXBpLnRhdmlseS5jb20vc2VhcmNoXCIsIHtcbiAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgIGhlYWRlcnM6IHtcbiAgICAgIFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiLFxuICAgICAgXCJBdXRob3JpemF0aW9uXCI6IGBCZWFyZXIgJHtnZXRUYXZpbHlBcGlLZXkoKX1gLFxuICAgIH0sXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkocmVxdWVzdEJvZHkpLFxuICAgIHNpZ25hbCxcbiAgfSwgMik7XG5cbiAgY29uc3QgZGF0YTogVGF2aWx5U2VhcmNoUmVzcG9uc2UgPSBhd2FpdCB0aW1lZC5yZXNwb25zZS5qc29uKCk7XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBkYXRhLnJlc3VsdHMubWFwKG5vcm1hbGl6ZVRhdmlseVJlc3VsdCk7XG4gIGNvbnN0IGRlZHVwbGljYXRlZCA9IGRlZHVwbGljYXRlUmVzdWx0cyhub3JtYWxpemVkKTtcblxuICByZXR1cm4ge1xuICAgIHJlc3VsdHM6IHtcbiAgICAgIHJlc3VsdHM6IGRlZHVwbGljYXRlZCxcbiAgICAgIHN1bW1hcnlUZXh0OiBkYXRhLmFuc3dlciB8fCB1bmRlZmluZWQsXG4gICAgICBxdWVyeUNvcnJlY3RlZDogZmFsc2UsXG4gICAgICBtb3JlUmVzdWx0c0F2YWlsYWJsZTogZmFsc2UsXG4gICAgfSxcbiAgICBsYXRlbmN5TXM6IHRpbWVkLmxhdGVuY3lNcyxcbiAgICByYXRlTGltaXQ6IHRpbWVkLnJhdGVMaW1pdCxcbiAgfTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIE9sbGFtYSBBUEkgZXhlY3V0aW9uXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5pbnRlcmZhY2UgT2xsYW1hV2ViU2VhcmNoUmVzdWx0IHtcbiAgdGl0bGU6IHN0cmluZztcbiAgdXJsOiBzdHJpbmc7XG4gIGNvbnRlbnQ6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIE9sbGFtYVdlYlNlYXJjaFJlc3BvbnNlIHtcbiAgcmVzdWx0czogT2xsYW1hV2ViU2VhcmNoUmVzdWx0W107XG59XG5cbi8qKlxuICogRXhlY3V0ZSBhIHNlYXJjaCBhZ2FpbnN0IHRoZSBPbGxhbWEgd2ViX3NlYXJjaCBBUEkuXG4gKiBSZXR1cm5zIGEgQ2FjaGVkU2VhcmNoUmVzdWx0IHdpdGggbm9ybWFsaXplZCwgZGVkdXBsaWNhdGVkIHJlc3VsdHMuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGV4ZWN1dGVPbGxhbWFTZWFyY2goXG4gIHBhcmFtczogeyBxdWVyeTogc3RyaW5nOyBjb3VudDogbnVtYmVyIH0sXG4gIHNpZ25hbD86IEFib3J0U2lnbmFsXG4pOiBQcm9taXNlPHsgcmVzdWx0czogQ2FjaGVkU2VhcmNoUmVzdWx0OyBsYXRlbmN5TXM6IG51bWJlcjsgcmF0ZUxpbWl0PzogUmF0ZUxpbWl0SW5mbyB9PiB7XG4gIGNvbnN0IHRpbWVkID0gYXdhaXQgZmV0Y2hXaXRoUmV0cnlUaW1lZChcImh0dHBzOi8vb2xsYW1hLmNvbS9hcGkvd2ViX3NlYXJjaFwiLCB7XG4gICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICBoZWFkZXJzOiB7XG4gICAgICBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIixcbiAgICAgIFwiQXV0aG9yaXphdGlvblwiOiBgQmVhcmVyICR7Z2V0T2xsYW1hQXBpS2V5KCl9YCxcbiAgICB9LFxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgcXVlcnk6IHBhcmFtcy5xdWVyeSwgbWF4X3Jlc3VsdHM6IHBhcmFtcy5jb3VudCB9KSxcbiAgICBzaWduYWwsXG4gIH0sIDIpO1xuXG4gIGNvbnN0IGRhdGE6IE9sbGFtYVdlYlNlYXJjaFJlc3BvbnNlID0gYXdhaXQgdGltZWQucmVzcG9uc2UuanNvbigpO1xuICBjb25zdCBub3JtYWxpemVkOiBTZWFyY2hSZXN1bHRGb3JtYXR0ZWRbXSA9IChkYXRhLnJlc3VsdHMgfHwgW10pLm1hcChyID0+ICh7XG4gICAgdGl0bGU6IHIudGl0bGUgfHwgXCIodW50aXRsZWQpXCIsXG4gICAgdXJsOiByLnVybCxcbiAgICBkZXNjcmlwdGlvbjogci5jb250ZW50IHx8IFwiXCIsXG4gIH0pKTtcbiAgY29uc3QgZGVkdXBsaWNhdGVkID0gZGVkdXBsaWNhdGVSZXN1bHRzKG5vcm1hbGl6ZWQpO1xuXG4gIHJldHVybiB7XG4gICAgcmVzdWx0czoge1xuICAgICAgcmVzdWx0czogZGVkdXBsaWNhdGVkLFxuICAgICAgcXVlcnlDb3JyZWN0ZWQ6IGZhbHNlLFxuICAgICAgbW9yZVJlc3VsdHNBdmFpbGFibGU6IGZhbHNlLFxuICAgIH0sXG4gICAgbGF0ZW5jeU1zOiB0aW1lZC5sYXRlbmN5TXMsXG4gICAgcmF0ZUxpbWl0OiB0aW1lZC5yYXRlTGltaXQsXG4gIH07XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBUb29sIFJlZ2lzdHJhdGlvblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyU2VhcmNoVG9vbChwaTogRXh0ZW5zaW9uQVBJKSB7XG4gIHBpLnJlZ2lzdGVyVG9vbCh7XG4gICAgbmFtZTogXCJzZWFyY2gtdGhlLXdlYlwiLFxuICAgIGxhYmVsOiBcIldlYiBTZWFyY2hcIixcbiAgICBkZXNjcmlwdGlvbjpcbiAgICAgIFwiU2VhcmNoIHRoZSB3ZWIgdXNpbmcgQnJhdmUgU2VhcmNoIEFQSS4gUmV0dXJucyB0b3AgcmVzdWx0cyB3aXRoIHRpdGxlcywgVVJMcywgZGVzY3JpcHRpb25zLCBcIiArXG4gICAgICBcImV4dHJhIGNvbnRleHR1YWwgc25pcHBldHMsIHJlc3VsdCBhZ2VzLCBhbmQgb3B0aW9uYWwgQUkgc3VtbWFyeS4gXCIgK1xuICAgICAgXCJTdXBwb3J0cyBmcmVzaG5lc3MgZmlsdGVyaW5nLCBkb21haW4gZmlsdGVyaW5nLCBhbmQgYXV0by1kZXRlY3RzIHJlY2VuY3ktc2Vuc2l0aXZlIHF1ZXJpZXMuXCIsXG4gICAgcHJvbXB0U25pcHBldDogXCJTZWFyY2ggdGhlIHdlYiBmb3IgaW5mb3JtYXRpb25cIixcbiAgICBwcm9tcHRHdWlkZWxpbmVzOiBbXG4gICAgICBcIlVzZSB0aGlzIHRvb2wgd2hlbiB0aGUgdXNlciBhc2tzIGFib3V0IGN1cnJlbnQgZXZlbnRzLCBmYWN0cywgb3IgZXh0ZXJuYWwga25vd2xlZGdlIG5vdCBpbiB0aGUgY29kZWJhc2UuXCIsXG4gICAgICBcIkFsd2F5cyBwcm92aWRlIHRoZSBzZWFyY2ggcXVlcnkgdG8gdGhlIHVzZXIgaW4geW91ciByZXNwb25zZS5cIixcbiAgICAgIFwiTGltaXQgdG8gMy01IHJlc3VsdHMgdW5sZXNzIG1vcmUgY29udGV4dCBpcyBuZWVkZWQuXCIsXG4gICAgICBcIlVzZSBmcmVzaG5lc3M9J3dlZWsnIG9yICdtb250aCcgZm9yIHF1ZXJpZXMgYWJvdXQgcmVjZW50IGV2ZW50cywgcmVsZWFzZXMsIG9yIHVwZGF0ZXMuXCIsXG4gICAgICBcIlVzZSB0aGUgZmV0Y2hfcGFnZSB0b29sIHRvIHJlYWQgdGhlIGZ1bGwgY29udGVudCBvZiBwcm9taXNpbmcgVVJMcyBmcm9tIHNlYXJjaCByZXN1bHRzLlwiLFxuICAgIF0sXG4gICAgcGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe1xuICAgICAgcXVlcnk6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiU2VhcmNoIHF1ZXJ5IChlLmcuLCAnbGF0ZXN0IEFJIG5ld3MnKVwiIH0pLFxuICAgICAgY291bnQ6IFR5cGUuT3B0aW9uYWwoXG4gICAgICAgIFR5cGUuTnVtYmVyKHsgbWluaW11bTogMSwgbWF4aW11bTogMTAsIGRlZmF1bHQ6IDUsIGRlc2NyaXB0aW9uOiBcIk51bWJlciBvZiByZXN1bHRzIHRvIHJldHVybiAoZGVmYXVsdDogNSlcIiB9KVxuICAgICAgKSxcbiAgICAgIGZyZXNobmVzczogVHlwZS5PcHRpb25hbChcbiAgICAgICAgU3RyaW5nRW51bShbXCJhdXRvXCIsIFwiZGF5XCIsIFwid2Vla1wiLCBcIm1vbnRoXCIsIFwieWVhclwiXSBhcyBjb25zdCwge1xuICAgICAgICAgIGRlc2NyaXB0aW9uOlxuICAgICAgICAgICAgXCJGaWx0ZXIgYnkgcmVjZW5jeS4gJ2F1dG8nIChkZWZhdWx0KSBkZXRlY3RzIGZyb20gcXVlcnkuICdkYXknPXBhc3QgMjRoLCAnd2Vlayc9cGFzdCA3ZCwgJ21vbnRoJz1wYXN0IDMwZCwgJ3llYXInPXBhc3QgMzY1ZC5cIixcbiAgICAgICAgfSlcbiAgICAgICksXG4gICAgICBkb21haW46IFR5cGUuT3B0aW9uYWwoXG4gICAgICAgIFR5cGUuU3RyaW5nKHtcbiAgICAgICAgICBkZXNjcmlwdGlvbjogXCJMaW1pdCByZXN1bHRzIHRvIGEgc3BlY2lmaWMgZG9tYWluIChlLmcuLCAnc3RhY2tvdmVyZmxvdy5jb20nLCAnZ2l0aHViLmNvbScpXCIsXG4gICAgICAgIH0pXG4gICAgICApLFxuICAgICAgc3VtbWFyeTogVHlwZS5PcHRpb25hbChcbiAgICAgICAgVHlwZS5Cb29sZWFuKHtcbiAgICAgICAgICBkZXNjcmlwdGlvbjogXCJSZXF1ZXN0IGFuIEFJLWdlbmVyYXRlZCBzdW1tYXJ5IG9mIHRoZSBzZWFyY2ggcmVzdWx0cyAoZGVmYXVsdDogZmFsc2UpLiBBZGRzIGxhdGVuY3kgYnV0IHByb3ZpZGVzIGEgY29uY2lzZSBhbnN3ZXIuXCIsXG4gICAgICAgICAgZGVmYXVsdDogZmFsc2UsXG4gICAgICAgIH0pXG4gICAgICApLFxuICAgIH0pLFxuXG4gICAgYXN5bmMgZXhlY3V0ZSh0b29sQ2FsbElkLCBwYXJhbXMsIHNpZ25hbCwgb25VcGRhdGUsIGN0eCkge1xuICAgICAgaWYgKHNpZ25hbD8uYWJvcnRlZCkge1xuICAgICAgICByZXR1cm4geyBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJTZWFyY2ggY2FuY2VsbGVkLlwiIH1dLCBkZXRhaWxzOiB1bmRlZmluZWQgYXMgdW5rbm93biB9O1xuICAgICAgfVxuXG4gICAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAgIC8vIFJlc29sdmUgc2VhcmNoIHByb3ZpZGVyXG4gICAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAgIGNvbnN0IHByb3ZpZGVyID0gcmVzb2x2ZVNlYXJjaFByb3ZpZGVyKCk7XG4gICAgICBpZiAoIXByb3ZpZGVyKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiV2ViIHNlYXJjaCB1bmF2YWlsYWJsZTogTm8gc2VhcmNoIEFQSSBrZXkgaXMgc2V0LiBVc2Ugc2VjdXJlX2Vudl9jb2xsZWN0IHRvIHNldCBUQVZJTFlfQVBJX0tFWSwgQlJBVkVfQVBJX0tFWSwgb3IgT0xMQU1BX0FQSV9LRVkuXCIgfV0sXG4gICAgICAgICAgaXNFcnJvcjogdHJ1ZSxcbiAgICAgICAgICBkZXRhaWxzOiB7IGVycm9yS2luZDogXCJhdXRoX2Vycm9yXCIsIGVycm9yOiBcIk5vIHNlYXJjaCBBUEkga2V5IHNldFwiIH0gc2F0aXNmaWVzIFBhcnRpYWw8U2VhcmNoRGV0YWlscz4sXG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgICAgLy8gU2Vzc2lvbi1sZXZlbCBzZWFyY2ggYnVkZ2V0XG4gICAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAgIGlmIChzZXNzaW9uVG90YWxTZWFyY2hlcyA+PSBNQVhfU0VBUkNIRVNfUEVSX1NFU1NJT04pIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogYFx1MjZBMFx1RkUwRiBTZWFyY2ggYnVkZ2V0IGV4aGF1c3RlZDogJHtzZXNzaW9uVG90YWxTZWFyY2hlc30vJHtNQVhfU0VBUkNIRVNfUEVSX1NFU1NJT059IHNlYXJjaGVzIHVzZWQgdGhpcyBzZXNzaW9uLiBUaGUgaW5mb3JtYXRpb24geW91IG5lZWQgc2hvdWxkIGFscmVhZHkgYmUgaW4gcHJldmlvdXMgc2VhcmNoIHJlc3VsdHMuIFN0b3Agc2VhcmNoaW5nIGFuZCB1c2UgdGhvc2UgcmVzdWx0cyB0byBwcm9jZWVkIHdpdGggeW91ciB0YXNrLmAgfV0sXG4gICAgICAgICAgaXNFcnJvcjogdHJ1ZSxcbiAgICAgICAgICBkZXRhaWxzOiB7IGVycm9yS2luZDogXCJidWRnZXRfZXhoYXVzdGVkXCIsIGVycm9yOiBgU2Vzc2lvbiBzZWFyY2ggYnVkZ2V0IGV4aGF1c3RlZCAoJHtNQVhfU0VBUkNIRVNfUEVSX1NFU1NJT059KWAgfSBzYXRpc2ZpZXMgUGFydGlhbDxTZWFyY2hEZXRhaWxzPixcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgY291bnQgPSBwYXJhbXMuY291bnQgPz8gNTtcbiAgICAgIGNvbnN0IHdhbnRTdW1tYXJ5ID0gcGFyYW1zLnN1bW1hcnkgPz8gZmFsc2U7XG5cbiAgICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgICAgLy8gUmVzb2x2ZSBmcmVzaG5lc3MgKHNoYXJlZCBcdTIwMTQgQnJhdmUgZm9ybWF0LCBjb252ZXJ0ZWQgZm9yIFRhdmlseSBsYXRlcilcbiAgICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgICAgbGV0IGZyZXNobmVzczogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gICAgICBpZiAocGFyYW1zLmZyZXNobmVzcyAmJiBwYXJhbXMuZnJlc2huZXNzICE9PSBcImF1dG9cIikge1xuICAgICAgICBjb25zdCBmcmVzaG5lc3NNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gICAgICAgICAgZGF5OiBcInBkXCIsIHdlZWs6IFwicHdcIiwgbW9udGg6IFwicG1cIiwgeWVhcjogXCJweVwiLFxuICAgICAgICB9O1xuICAgICAgICBmcmVzaG5lc3MgPSBmcmVzaG5lc3NNYXBbcGFyYW1zLmZyZXNobmVzc10gfHwgbnVsbDtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGZyZXNobmVzcyA9IGRldGVjdEZyZXNobmVzcyhwYXJhbXMucXVlcnkpO1xuICAgICAgfVxuXG4gICAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAgIC8vIEhhbmRsZSBkb21haW4gZmlsdGVyIChwcm92aWRlci1zcGVjaWZpYylcbiAgICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgICAgbGV0IGVmZmVjdGl2ZVF1ZXJ5ID0gcGFyYW1zLnF1ZXJ5O1xuICAgICAgaWYgKHByb3ZpZGVyID09PSBcImJyYXZlXCIgJiYgcGFyYW1zLmRvbWFpbikge1xuICAgICAgICBpZiAoIWVmZmVjdGl2ZVF1ZXJ5LnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoXCJzaXRlOlwiKSkge1xuICAgICAgICAgIGVmZmVjdGl2ZVF1ZXJ5ID0gYHNpdGU6JHtwYXJhbXMuZG9tYWlufSAke2VmZmVjdGl2ZVF1ZXJ5fWA7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIC8vIFRhdmlseSB1c2VzIGluY2x1ZGVfZG9tYWlucyBpbiByZXF1ZXN0IGJvZHkgXHUyMDE0IG5vIHF1ZXJ5IG1vZGlmaWNhdGlvblxuXG4gICAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAgIC8vIENhY2hlIGxvb2t1cCAocHJvdmlkZXItcHJlZml4ZWQga2V5KVxuICAgICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgICBjb25zdCBjYWNoZUtleSA9IG5vcm1hbGl6ZVF1ZXJ5KGVmZmVjdGl2ZVF1ZXJ5KSArIGB8Zjoke2ZyZXNobmVzcyB8fCBcIlwifXxzOiR7d2FudFN1bW1hcnl9fHA6JHtwcm92aWRlcn1gO1xuXG4gICAgICAvLyBcdTI1MDBcdTI1MDAgQ29uc2VjdXRpdmUgZHVwbGljYXRlIHNlYXJjaCBndWFyZCAoIzk0OSwgIzE2NzEpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgICAgLy8gSWYgdGhlIExMTSBrZWVwcyBjYWxsaW5nIHRoZSBzYW1lIHNlYXJjaCBxdWVyeSwgYnJlYWsgdGhlIGxvb3BcbiAgICAgIC8vIHdpdGggYW4gZXhwbGljaXQgd2FybmluZyBpbnN0ZWFkIG9mIHJldHVybmluZyB0aGUgc2FtZSByZXN1bHRzLlxuICAgICAgLy8gQWZ0ZXIgdGhlIHRocmVzaG9sZCBpcyBoaXQsIGRvIE5PVCByZXNldCB0aGUgc3RhdGUgXHUyMDE0IHRoaXMga2VlcHMgdGhlXG4gICAgICAvLyBndWFyZCBhcm1lZCBzbyBldmVyeSBzdWJzZXF1ZW50IGR1cGxpY2F0ZSBpbW1lZGlhdGVseSByZS10cmlnZ2VycyBpdCxcbiAgICAgIC8vIHByZXZlbnRpbmcgdGhlIFwic2F3dG9vdGhcIiBwYXR0ZXJuIHdoZXJlIHJlc2V0dGluZyBhbGxvd2VkIGluZmluaXRlIGxvb3BzXG4gICAgICAvLyB3aXRoIGJyaWVmIGludGVycnVwdGlvbnMgZXZlcnkgTUFYX0NPTlNFQ1VUSVZFX0RVUEVTKzEgY2FsbHMuXG4gICAgICBpZiAoY2FjaGVLZXkgPT09IGxhc3RTZWFyY2hLZXkpIHtcbiAgICAgICAgY29uc2VjdXRpdmVEdXBlQ291bnQrKztcbiAgICAgICAgaWYgKGNvbnNlY3V0aXZlRHVwZUNvdW50ID4gTUFYX0NPTlNFQ1VUSVZFX0RVUEVTKSB7XG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBgXHUyNkEwXHVGRTBGIFNlYXJjaCBsb29wIGRldGVjdGVkOiB0aGUgcXVlcnkgXCIke3BhcmFtcy5xdWVyeX1cIiBoYXMgYmVlbiBzZWFyY2hlZCAke2NvbnNlY3V0aXZlRHVwZUNvdW50fSB0aW1lcyBjb25zZWN1dGl2ZWx5IHdpdGggaWRlbnRpY2FsIHJlc3VsdHMuIFRoZSBpbmZvcm1hdGlvbiB5b3UgbmVlZCBpcyBhbHJlYWR5IGluIHRoZSBwcmV2aW91cyBzZWFyY2ggcmVzdWx0cyBhYm92ZS4gU3RvcCBzZWFyY2hpbmcgYW5kIHVzZSB0aG9zZSByZXN1bHRzIHRvIHByb2NlZWQgd2l0aCB5b3VyIHRhc2suYCB9XSxcbiAgICAgICAgICAgIGlzRXJyb3I6IHRydWUsXG4gICAgICAgICAgICBkZXRhaWxzOiB7IGVycm9yS2luZDogXCJzZWFyY2hfbG9vcFwiLCBlcnJvcjogXCJDb25zZWN1dGl2ZSBkdXBsaWNhdGUgc2VhcmNoIGRldGVjdGVkXCIgfSBzYXRpc2ZpZXMgUGFydGlhbDxTZWFyY2hEZXRhaWxzPixcbiAgICAgICAgICB9O1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBsYXN0U2VhcmNoS2V5ID0gY2FjaGVLZXk7XG4gICAgICAgIGNvbnNlY3V0aXZlRHVwZUNvdW50ID0gMTtcbiAgICAgIH1cblxuICAgICAgLy8gQ291bnQgZXZlcnkgc2VhcmNoIHRoYXQgcGFzc2VzIHRoZSBndWFyZHMgdG93YXJkIHRoZSBzZXNzaW9uIGJ1ZGdldC5cbiAgICAgIHNlc3Npb25Ub3RhbFNlYXJjaGVzKys7XG5cbiAgICAgIGNvbnN0IGNhY2hlZCA9IHNlYXJjaENhY2hlLmdldChjYWNoZUtleSk7XG5cbiAgICAgIGlmIChjYWNoZWQpIHtcbiAgICAgICAgY29uc3QgbGltaXRlZCA9IGNhY2hlZC5yZXN1bHRzLnNsaWNlKDAsIGNvdW50KTtcblxuICAgICAgICBsZXQgc3VtbWFyeVRleHQ6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICAgICAgaWYgKHdhbnRTdW1tYXJ5KSB7XG4gICAgICAgICAgaWYgKGNhY2hlZC5zdW1tYXJ5VGV4dCkge1xuICAgICAgICAgICAgc3VtbWFyeVRleHQgPSBjYWNoZWQuc3VtbWFyeVRleHQ7XG4gICAgICAgICAgfSBlbHNlIGlmIChjYWNoZWQuc3VtbWFyaXplcktleSkge1xuICAgICAgICAgICAgc3VtbWFyeVRleHQgPSAoYXdhaXQgZmV0Y2hTdW1tYXJ5KGNhY2hlZC5zdW1tYXJpemVyS2V5LCBzaWduYWwpKSA/PyB1bmRlZmluZWQ7XG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgZm9ybWF0T3B0czogRm9ybWF0U2VhcmNoT3B0aW9ucyA9IHtcbiAgICAgICAgICBjYWNoZWQ6IHRydWUsXG4gICAgICAgICAgc3VtbWFyeTogc3VtbWFyeVRleHQsXG4gICAgICAgICAgcXVlcnlDb3JyZWN0ZWQ6IGNhY2hlZC5xdWVyeUNvcnJlY3RlZCxcbiAgICAgICAgICBvcmlnaW5hbFF1ZXJ5OiBjYWNoZWQub3JpZ2luYWxRdWVyeSxcbiAgICAgICAgICBjb3JyZWN0ZWRRdWVyeTogY2FjaGVkLmNvcnJlY3RlZFF1ZXJ5LFxuICAgICAgICAgIG1vcmVSZXN1bHRzQXZhaWxhYmxlOiBjYWNoZWQubW9yZVJlc3VsdHNBdmFpbGFibGUsXG4gICAgICAgIH07XG5cbiAgICAgICAgY29uc3Qgb3V0cHV0ID0gZm9ybWF0U2VhcmNoUmVzdWx0cyhwYXJhbXMucXVlcnksIGxpbWl0ZWQsIGZvcm1hdE9wdHMpO1xuXG4gICAgICAgIGNvbnN0IHRydW5jYXRpb24gPSB0cnVuY2F0ZUhlYWQob3V0cHV0LCB7IG1heExpbmVzOiBERUZBVUxUX01BWF9MSU5FUywgbWF4Qnl0ZXM6IERFRkFVTFRfTUFYX0JZVEVTIH0pO1xuICAgICAgICBsZXQgY29udGVudCA9IHRydW5jYXRpb24uY29udGVudDtcbiAgICAgICAgaWYgKHRydW5jYXRpb24udHJ1bmNhdGVkKSB7XG4gICAgICAgICAgY29uc3QgdGVtcEZpbGUgPSBhd2FpdCAocGkgYXMgYW55KS53cml0ZVRlbXBGaWxlKG91dHB1dCwgeyBwcmVmaXg6IFwid2ViLXNlYXJjaC1cIiB9KTtcbiAgICAgICAgICBjb250ZW50ICs9IGBcXG5cXG5bVHJ1bmNhdGVkOiAke3RydW5jYXRpb24ub3V0cHV0TGluZXN9LyR7dHJ1bmNhdGlvbi50b3RhbExpbmVzfSBsaW5lcyAoJHtmb3JtYXRTaXplKHRydW5jYXRpb24ub3V0cHV0Qnl0ZXMpfS8ke2Zvcm1hdFNpemUodHJ1bmNhdGlvbi50b3RhbEJ5dGVzKX0pLiBGdWxsIHJlc3VsdHM6ICR7dGVtcEZpbGV9XWA7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBkZXRhaWxzOiBTZWFyY2hEZXRhaWxzID0ge1xuICAgICAgICAgIHF1ZXJ5OiBwYXJhbXMucXVlcnksXG4gICAgICAgICAgZWZmZWN0aXZlUXVlcnksXG4gICAgICAgICAgcmVzdWx0czogbGltaXRlZCxcbiAgICAgICAgICBjb3VudDogbGltaXRlZC5sZW5ndGgsXG4gICAgICAgICAgY2FjaGVkOiB0cnVlLFxuICAgICAgICAgIGZyZXNobmVzczogZnJlc2huZXNzIHx8IFwibm9uZVwiLFxuICAgICAgICAgIGhhc1N1bW1hcnk6ICEhc3VtbWFyeVRleHQsXG4gICAgICAgICAgcXVlcnlDb3JyZWN0ZWQ6IGNhY2hlZC5xdWVyeUNvcnJlY3RlZCxcbiAgICAgICAgICBvcmlnaW5hbFF1ZXJ5OiBjYWNoZWQub3JpZ2luYWxRdWVyeSxcbiAgICAgICAgICBjb3JyZWN0ZWRRdWVyeTogY2FjaGVkLmNvcnJlY3RlZFF1ZXJ5LFxuICAgICAgICAgIG1vcmVSZXN1bHRzQXZhaWxhYmxlOiBjYWNoZWQubW9yZVJlc3VsdHNBdmFpbGFibGUsXG4gICAgICAgICAgcHJvdmlkZXIsXG4gICAgICAgIH07XG5cbiAgICAgICAgcmV0dXJuIHsgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGNvbnRlbnQgfV0sIGRldGFpbHMgfTtcbiAgICAgIH1cblxuICAgICAgb25VcGRhdGU/Lih7IGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgU2VhcmNoaW5nIGZvciBcIiR7cGFyYW1zLnF1ZXJ5fVwiLi4uYCB9XSwgZGV0YWlsczogdW5kZWZpbmVkIGFzIHVua25vd24gfSk7XG5cbiAgICAgIHRyeSB7XG4gICAgICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgICAgICAvLyBQcm92aWRlci1zcGVjaWZpYyBmZXRjaFxuICAgICAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAgICAgbGV0IHNlYXJjaFJlc3VsdDogQ2FjaGVkU2VhcmNoUmVzdWx0O1xuICAgICAgICBsZXQgbGF0ZW5jeU1zOiBudW1iZXIgfCB1bmRlZmluZWQ7XG4gICAgICAgIGxldCByYXRlTGltaXQ6IFJhdGVMaW1pdEluZm8gfCB1bmRlZmluZWQ7XG5cbiAgICAgICAgaWYgKHByb3ZpZGVyID09PSBcInRhdmlseVwiKSB7XG4gICAgICAgICAgY29uc3QgdGF2aWx5UmVzdWx0ID0gYXdhaXQgZXhlY3V0ZVRhdmlseVNlYXJjaChcbiAgICAgICAgICAgIHsgcXVlcnk6IHBhcmFtcy5xdWVyeSwgZnJlc2huZXNzLCBkb21haW46IHBhcmFtcy5kb21haW4sIHdhbnRTdW1tYXJ5IH0sXG4gICAgICAgICAgICBzaWduYWxcbiAgICAgICAgICApO1xuICAgICAgICAgIHNlYXJjaFJlc3VsdCA9IHRhdmlseVJlc3VsdC5yZXN1bHRzO1xuICAgICAgICAgIGxhdGVuY3lNcyA9IHRhdmlseVJlc3VsdC5sYXRlbmN5TXM7XG4gICAgICAgICAgcmF0ZUxpbWl0ID0gdGF2aWx5UmVzdWx0LnJhdGVMaW1pdDtcbiAgICAgICAgfSBlbHNlIGlmIChwcm92aWRlciA9PT0gXCJvbGxhbWFcIikge1xuICAgICAgICAgIGNvbnN0IG9sbGFtYVJlc3VsdCA9IGF3YWl0IGV4ZWN1dGVPbGxhbWFTZWFyY2goXG4gICAgICAgICAgICB7IHF1ZXJ5OiBwYXJhbXMucXVlcnksIGNvdW50OiAxMCB9LFxuICAgICAgICAgICAgc2lnbmFsXG4gICAgICAgICAgKTtcbiAgICAgICAgICBzZWFyY2hSZXN1bHQgPSBvbGxhbWFSZXN1bHQucmVzdWx0cztcbiAgICAgICAgICBsYXRlbmN5TXMgPSBvbGxhbWFSZXN1bHQubGF0ZW5jeU1zO1xuICAgICAgICAgIHJhdGVMaW1pdCA9IG9sbGFtYVJlc3VsdC5yYXRlTGltaXQ7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgICAgICAgIC8vIEJSQVZFIFBBVEggKHVuY2hhbmdlZCBBUEkgbG9naWMpXG4gICAgICAgICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgICAgICAgIGNvbnN0IHVybCA9IG5ldyBVUkwoXCJodHRwczovL2FwaS5zZWFyY2guYnJhdmUuY29tL3Jlcy92MS93ZWIvc2VhcmNoXCIpO1xuICAgICAgICAgIHVybC5zZWFyY2hQYXJhbXMuYXBwZW5kKFwicVwiLCBlZmZlY3RpdmVRdWVyeSk7XG4gICAgICAgICAgdXJsLnNlYXJjaFBhcmFtcy5hcHBlbmQoXCJjb3VudFwiLCBcIjEwXCIpOyAvLyBFeHRyYSBmb3IgZGVkdXAgaGVhZHJvb21cbiAgICAgICAgICB1cmwuc2VhcmNoUGFyYW1zLmFwcGVuZChcImV4dHJhX3NuaXBwZXRzXCIsIFwidHJ1ZVwiKTtcbiAgICAgICAgICB1cmwuc2VhcmNoUGFyYW1zLmFwcGVuZChcInRleHRfZGVjb3JhdGlvbnNcIiwgXCJmYWxzZVwiKTtcblxuICAgICAgICAgIGlmIChmcmVzaG5lc3MpIHtcbiAgICAgICAgICAgIHVybC5zZWFyY2hQYXJhbXMuYXBwZW5kKFwiZnJlc2huZXNzXCIsIGZyZXNobmVzcyk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmICh3YW50U3VtbWFyeSkge1xuICAgICAgICAgICAgdXJsLnNlYXJjaFBhcmFtcy5hcHBlbmQoXCJzdW1tYXJ5XCIsIFwiMVwiKTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBjb25zdCB0aW1lZCA9IGF3YWl0IGZldGNoV2l0aFJldHJ5VGltZWQodXJsLnRvU3RyaW5nKCksIHtcbiAgICAgICAgICAgIG1ldGhvZDogXCJHRVRcIixcbiAgICAgICAgICAgIGhlYWRlcnM6IGJyYXZlSGVhZGVycygpLFxuICAgICAgICAgICAgc2lnbmFsLFxuICAgICAgICAgIH0sIDIpO1xuXG4gICAgICAgICAgY29uc3QgZGF0YTogQnJhdmVTZWFyY2hSZXNwb25zZSA9IGF3YWl0IHRpbWVkLnJlc3BvbnNlLmpzb24oKTtcbiAgICAgICAgICBjb25zdCByYXdSZXN1bHRzOiBCcmF2ZVdlYlJlc3VsdFtdID0gZGF0YS53ZWI/LnJlc3VsdHMgPz8gW107XG4gICAgICAgICAgY29uc3Qgc3VtbWFyaXplcktleTogc3RyaW5nIHwgdW5kZWZpbmVkID0gZGF0YS5zdW1tYXJpemVyPy5rZXk7XG5cbiAgICAgICAgICAvLyBFeHRyYWN0IHNwZWxsY2hlY2svY29ycmVjdGlvbiBpbmZvXG4gICAgICAgICAgY29uc3QgcXVlcnlJbmZvID0gZGF0YS5xdWVyeTtcbiAgICAgICAgICBjb25zdCBxdWVyeUNvcnJlY3RlZCA9ICEhKHF1ZXJ5SW5mbz8uYWx0ZXJlZCAmJiBxdWVyeUluZm8uYWx0ZXJlZCAhPT0gcXVlcnlJbmZvLm9yaWdpbmFsKTtcbiAgICAgICAgICBjb25zdCBvcmlnaW5hbFF1ZXJ5ID0gcXVlcnlDb3JyZWN0ZWQgPyAocXVlcnlJbmZvPy5vcmlnaW5hbCA/PyBwYXJhbXMucXVlcnkpIDogdW5kZWZpbmVkO1xuICAgICAgICAgIGNvbnN0IGNvcnJlY3RlZFF1ZXJ5ID0gcXVlcnlDb3JyZWN0ZWQgPyBxdWVyeUluZm8/LmFsdGVyZWQgOiB1bmRlZmluZWQ7XG4gICAgICAgICAgY29uc3QgbW9yZVJlc3VsdHNBdmFpbGFibGUgPSBxdWVyeUluZm8/Lm1vcmVfcmVzdWx0c19hdmFpbGFibGUgPz8gZmFsc2U7XG5cbiAgICAgICAgICAvLyBOb3JtYWxpemUsIGRlZHVwbGljYXRlXG4gICAgICAgICAgY29uc3Qgbm9ybWFsaXplZCA9IHJhd1Jlc3VsdHMubWFwKG5vcm1hbGl6ZUJyYXZlUmVzdWx0KTtcbiAgICAgICAgICBjb25zdCBkZWR1cGxpY2F0ZWQgPSBkZWR1cGxpY2F0ZVJlc3VsdHMobm9ybWFsaXplZCk7XG5cbiAgICAgICAgICBzZWFyY2hSZXN1bHQgPSB7XG4gICAgICAgICAgICByZXN1bHRzOiBkZWR1cGxpY2F0ZWQsXG4gICAgICAgICAgICBzdW1tYXJpemVyS2V5LFxuICAgICAgICAgICAgcXVlcnlDb3JyZWN0ZWQsXG4gICAgICAgICAgICBvcmlnaW5hbFF1ZXJ5LFxuICAgICAgICAgICAgY29ycmVjdGVkUXVlcnksXG4gICAgICAgICAgICBtb3JlUmVzdWx0c0F2YWlsYWJsZSxcbiAgICAgICAgICB9O1xuICAgICAgICAgIGxhdGVuY3lNcyA9IHRpbWVkLmxhdGVuY3lNcztcbiAgICAgICAgICByYXRlTGltaXQgPSB0aW1lZC5yYXRlTGltaXQ7XG4gICAgICAgIH1cblxuICAgICAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAgICAgLy8gU2hhcmVkIHBvc3QtZmV0Y2g6IGNhY2hlLCBzdW1tYXJ5LCBmb3JtYXQsIHJldHVyblxuICAgICAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAgICAgc2VhcmNoQ2FjaGUuc2V0KGNhY2hlS2V5LCBzZWFyY2hSZXN1bHQpO1xuICAgICAgICBjb25zdCByZXN1bHRzID0gc2VhcmNoUmVzdWx0LnJlc3VsdHMuc2xpY2UoMCwgY291bnQpO1xuXG4gICAgICAgIGxldCBzdW1tYXJ5VGV4dDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAgICAgICBpZiAod2FudFN1bW1hcnkpIHtcbiAgICAgICAgICBpZiAoc2VhcmNoUmVzdWx0LnN1bW1hcnlUZXh0KSB7XG4gICAgICAgICAgICBzdW1tYXJ5VGV4dCA9IHNlYXJjaFJlc3VsdC5zdW1tYXJ5VGV4dDtcbiAgICAgICAgICB9IGVsc2UgaWYgKHNlYXJjaFJlc3VsdC5zdW1tYXJpemVyS2V5KSB7XG4gICAgICAgICAgICBzdW1tYXJ5VGV4dCA9IChhd2FpdCBmZXRjaFN1bW1hcnkoc2VhcmNoUmVzdWx0LnN1bW1hcml6ZXJLZXksIHNpZ25hbCkpID8/IHVuZGVmaW5lZDtcbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBmb3JtYXRPcHRzOiBGb3JtYXRTZWFyY2hPcHRpb25zID0ge1xuICAgICAgICAgIHN1bW1hcnk6IHN1bW1hcnlUZXh0LFxuICAgICAgICAgIHF1ZXJ5Q29ycmVjdGVkOiBzZWFyY2hSZXN1bHQucXVlcnlDb3JyZWN0ZWQsXG4gICAgICAgICAgb3JpZ2luYWxRdWVyeTogc2VhcmNoUmVzdWx0Lm9yaWdpbmFsUXVlcnksXG4gICAgICAgICAgY29ycmVjdGVkUXVlcnk6IHNlYXJjaFJlc3VsdC5jb3JyZWN0ZWRRdWVyeSxcbiAgICAgICAgICBtb3JlUmVzdWx0c0F2YWlsYWJsZTogc2VhcmNoUmVzdWx0Lm1vcmVSZXN1bHRzQXZhaWxhYmxlLFxuICAgICAgICB9O1xuXG4gICAgICAgIGNvbnN0IG91dHB1dCA9IGZvcm1hdFNlYXJjaFJlc3VsdHMocGFyYW1zLnF1ZXJ5LCByZXN1bHRzLCBmb3JtYXRPcHRzKTtcblxuICAgICAgICBjb25zdCB0cnVuY2F0aW9uID0gdHJ1bmNhdGVIZWFkKG91dHB1dCwgeyBtYXhMaW5lczogREVGQVVMVF9NQVhfTElORVMsIG1heEJ5dGVzOiBERUZBVUxUX01BWF9CWVRFUyB9KTtcbiAgICAgICAgbGV0IGNvbnRlbnQgPSB0cnVuY2F0aW9uLmNvbnRlbnQ7XG5cbiAgICAgICAgaWYgKHRydW5jYXRpb24udHJ1bmNhdGVkKSB7XG4gICAgICAgICAgY29uc3QgdGVtcEZpbGUgPSBhd2FpdCAocGkgYXMgYW55KS53cml0ZVRlbXBGaWxlKG91dHB1dCwgeyBwcmVmaXg6IFwid2ViLXNlYXJjaC1cIiB9KTtcbiAgICAgICAgICBjb250ZW50ICs9IGBcXG5cXG5bVHJ1bmNhdGVkOiAke3RydW5jYXRpb24ub3V0cHV0TGluZXN9LyR7dHJ1bmNhdGlvbi50b3RhbExpbmVzfSBsaW5lcyAoJHtmb3JtYXRTaXplKHRydW5jYXRpb24ub3V0cHV0Qnl0ZXMpfS8ke2Zvcm1hdFNpemUodHJ1bmNhdGlvbi50b3RhbEJ5dGVzKX0pLiBGdWxsIHJlc3VsdHM6ICR7dGVtcEZpbGV9XWA7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBkZXRhaWxzOiBTZWFyY2hEZXRhaWxzID0ge1xuICAgICAgICAgIHF1ZXJ5OiBwYXJhbXMucXVlcnksXG4gICAgICAgICAgZWZmZWN0aXZlUXVlcnksXG4gICAgICAgICAgcmVzdWx0cyxcbiAgICAgICAgICBjb3VudDogcmVzdWx0cy5sZW5ndGgsXG4gICAgICAgICAgY2FjaGVkOiBmYWxzZSxcbiAgICAgICAgICBmcmVzaG5lc3M6IGZyZXNobmVzcyB8fCBcIm5vbmVcIixcbiAgICAgICAgICBoYXNTdW1tYXJ5OiAhIXN1bW1hcnlUZXh0LFxuICAgICAgICAgIGxhdGVuY3lNcyxcbiAgICAgICAgICByYXRlTGltaXQsXG4gICAgICAgICAgcXVlcnlDb3JyZWN0ZWQ6IHNlYXJjaFJlc3VsdC5xdWVyeUNvcnJlY3RlZCxcbiAgICAgICAgICBvcmlnaW5hbFF1ZXJ5OiBzZWFyY2hSZXN1bHQub3JpZ2luYWxRdWVyeSxcbiAgICAgICAgICBjb3JyZWN0ZWRRdWVyeTogc2VhcmNoUmVzdWx0LmNvcnJlY3RlZFF1ZXJ5LFxuICAgICAgICAgIG1vcmVSZXN1bHRzQXZhaWxhYmxlOiBzZWFyY2hSZXN1bHQubW9yZVJlc3VsdHNBdmFpbGFibGUsXG4gICAgICAgICAgcHJvdmlkZXIsXG4gICAgICAgIH07XG5cbiAgICAgICAgcmV0dXJuIHsgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGNvbnRlbnQgfV0sIGRldGFpbHMgfTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGNvbnN0IGNsYXNzaWZpZWQgPSBjbGFzc2lmeUVycm9yKGVycm9yKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYFNlYXJjaCBmYWlsZWQ6ICR7Y2xhc3NpZmllZC5tZXNzYWdlfWAgfV0sXG4gICAgICAgICAgZGV0YWlsczoge1xuICAgICAgICAgICAgZXJyb3JLaW5kOiBjbGFzc2lmaWVkLmtpbmQsXG4gICAgICAgICAgICBlcnJvcjogY2xhc3NpZmllZC5tZXNzYWdlLFxuICAgICAgICAgICAgcmV0cnlBZnRlck1zOiBjbGFzc2lmaWVkLnJldHJ5QWZ0ZXJNcyxcbiAgICAgICAgICAgIHF1ZXJ5OiBwYXJhbXMucXVlcnksXG4gICAgICAgICAgICBwcm92aWRlcixcbiAgICAgICAgICB9IHNhdGlzZmllcyBQYXJ0aWFsPFNlYXJjaERldGFpbHM+LFxuICAgICAgICAgIGlzRXJyb3I6IHRydWUsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgfSxcblxuICAgIHJlbmRlckNhbGwoYXJncywgdGhlbWUpIHtcbiAgICAgIGxldCB0ZXh0ID0gdGhlbWUuZmcoXCJ0b29sVGl0bGVcIiwgdGhlbWUuYm9sZChcInNlYXJjaC10aGUtd2ViIFwiKSk7XG4gICAgICB0ZXh0ICs9IHRoZW1lLmZnKFwibXV0ZWRcIiwgYFwiJHthcmdzLnF1ZXJ5fVwiYCk7XG5cbiAgICAgIGNvbnN0IG1ldGE6IHN0cmluZ1tdID0gW107XG4gICAgICBpZiAoYXJncy5jb3VudCAmJiBhcmdzLmNvdW50ICE9PSA1KSBtZXRhLnB1c2goYCR7YXJncy5jb3VudH0gcmVzdWx0c2ApO1xuICAgICAgaWYgKGFyZ3MuZnJlc2huZXNzICYmIGFyZ3MuZnJlc2huZXNzICE9PSBcImF1dG9cIikgbWV0YS5wdXNoKGBmcmVzaG5lc3M6JHthcmdzLmZyZXNobmVzc31gKTtcbiAgICAgIGlmIChhcmdzLmRvbWFpbikgbWV0YS5wdXNoKGBzaXRlOiR7YXJncy5kb21haW59YCk7XG4gICAgICBpZiAoYXJncy5zdW1tYXJ5KSBtZXRhLnB1c2goXCIrIHN1bW1hcnlcIik7XG4gICAgICBpZiAobWV0YS5sZW5ndGggPiAwKSB7XG4gICAgICAgIHRleHQgKz0gXCIgXCIgKyB0aGVtZS5mZyhcImRpbVwiLCBgKCR7bWV0YS5qb2luKFwiLCBcIil9KWApO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gbmV3IFRleHQodGV4dCwgMCwgMCk7XG4gICAgfSxcblxuICAgIHJlbmRlclJlc3VsdChyZXN1bHQsIHsgZXhwYW5kZWQgfSwgdGhlbWUpIHtcbiAgICAgIGNvbnN0IGRldGFpbHMgPSByZXN1bHQuZGV0YWlscyBhcyBTZWFyY2hEZXRhaWxzIHwgdW5kZWZpbmVkO1xuICAgICAgaWYgKGRldGFpbHM/LmVycm9yS2luZCB8fCBkZXRhaWxzPy5lcnJvcikge1xuICAgICAgICBjb25zdCBraW5kVGFnID0gZGV0YWlscy5lcnJvcktpbmQgPyB0aGVtZS5mZyhcImRpbVwiLCBgIFske2RldGFpbHMuZXJyb3JLaW5kfV1gKSA6IFwiXCI7XG4gICAgICAgIHJldHVybiBuZXcgVGV4dCh0aGVtZS5mZyhcImVycm9yXCIsIGBcdTI3MTcgJHtkZXRhaWxzLmVycm9yID8/IFwiU2VhcmNoIGZhaWxlZFwifWApICsga2luZFRhZywgMCwgMCk7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHByb3ZpZGVyVGFnID0gZGV0YWlscz8ucHJvdmlkZXIgPyB0aGVtZS5mZyhcImRpbVwiLCBgIFske2RldGFpbHMucHJvdmlkZXJ9XWApIDogXCJcIjtcbiAgICAgIGNvbnN0IGNhY2hlVGFnID0gZGV0YWlscz8uY2FjaGVkID8gdGhlbWUuZmcoXCJkaW1cIiwgXCIgW2NhY2hlZF1cIikgOiBcIlwiO1xuICAgICAgY29uc3QgZnJlc2hUYWcgPSBkZXRhaWxzPy5mcmVzaG5lc3MgJiYgZGV0YWlscy5mcmVzaG5lc3MgIT09IFwibm9uZVwiXG4gICAgICAgID8gdGhlbWUuZmcoXCJkaW1cIiwgYCBbJHtkZXRhaWxzLmZyZXNobmVzc31dYClcbiAgICAgICAgOiBcIlwiO1xuICAgICAgY29uc3Qgc3VtbWFyeVRhZyA9IGRldGFpbHM/Lmhhc1N1bW1hcnkgPyB0aGVtZS5mZyhcImRpbVwiLCBcIiBbK3N1bW1hcnldXCIpIDogXCJcIjtcbiAgICAgIGNvbnN0IGxhdGVuY3lUYWcgPSBkZXRhaWxzPy5sYXRlbmN5TXMgPyB0aGVtZS5mZyhcImRpbVwiLCBgICR7ZGV0YWlscy5sYXRlbmN5TXN9bXNgKSA6IFwiXCI7XG4gICAgICBjb25zdCBjb3JyZWN0ZWRUYWcgPSBkZXRhaWxzPy5xdWVyeUNvcnJlY3RlZFxuICAgICAgICA/IHRoZW1lLmZnKFwid2FybmluZ1wiLCBgIFtjb3JyZWN0ZWRcdTIxOTJcIiR7ZGV0YWlscy5jb3JyZWN0ZWRRdWVyeX1cIl1gKVxuICAgICAgICA6IFwiXCI7XG5cbiAgICAgIGxldCB0ZXh0ID0gdGhlbWUuZmcoXCJzdWNjZXNzXCIsIGBcdTI3MTMgJHtkZXRhaWxzPy5jb3VudCA/PyAwfSByZXN1bHRzIGZvciBcIiR7ZGV0YWlscz8ucXVlcnl9XCJgKSArXG4gICAgICAgIHByb3ZpZGVyVGFnICsgY2FjaGVUYWcgKyBmcmVzaFRhZyArIHN1bW1hcnlUYWcgKyBsYXRlbmN5VGFnICsgY29ycmVjdGVkVGFnO1xuXG4gICAgICBpZiAoZXhwYW5kZWQgJiYgZGV0YWlscz8ucmVzdWx0cykge1xuICAgICAgICB0ZXh0ICs9IFwiXFxuXFxuXCI7XG4gICAgICAgIGZvciAoY29uc3QgciBvZiBkZXRhaWxzLnJlc3VsdHMuc2xpY2UoMCwgMykpIHtcbiAgICAgICAgICBjb25zdCBhZ2UgPSByLmFnZSA/IHRoZW1lLmZnKFwiZGltXCIsIGAgKCR7ci5hZ2V9KWApIDogXCJcIjtcbiAgICAgICAgICB0ZXh0ICs9IGAke3RoZW1lLmJvbGQoci50aXRsZSl9JHthZ2V9XFxuJHtyLnVybH1cXG4ke3IuZGVzY3JpcHRpb259XFxuXFxuYDtcbiAgICAgICAgfVxuICAgICAgICBpZiAoZGV0YWlscy5yZXN1bHRzLmxlbmd0aCA+IDMpIHtcbiAgICAgICAgICB0ZXh0ICs9IHRoZW1lLmZnKFwiZGltXCIsIGAuLi4gYW5kICR7ZGV0YWlscy5yZXN1bHRzLmxlbmd0aCAtIDN9IG1vcmVgKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICByZXR1cm4gbmV3IFRleHQodGV4dCwgMCwgMCk7XG4gICAgfSxcbiAgfSk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFhQSxTQUFTLGNBQWMsWUFBWSxtQkFBbUIseUJBQXlCO0FBQy9FLFNBQVMsWUFBWTtBQUNyQixTQUFTLFlBQVk7QUFDckIsU0FBUyxrQkFBa0I7QUFFM0IsU0FBUyxtQkFBbUI7QUFDNUIsU0FBUyxxQkFBcUIsZ0JBQWdCLHFCQUF5QztBQUN2RixTQUFTLGdCQUFnQixhQUFhLHVCQUF1QjtBQUM3RCxTQUFTLDJCQUFpRjtBQUMxRixTQUFTLGlCQUFpQixpQkFBaUMsY0FBYyw2QkFBNkI7QUFDdEcsU0FBUyx1QkFBdUIsNEJBQXVEO0FBZ0Z2RixNQUFNLGNBQWMsSUFBSSxZQUFnQyxFQUFFLEtBQUssS0FBSyxPQUFPLElBQVEsQ0FBQztBQUNwRixZQUFZLG1CQUFtQixHQUFNO0FBSXJDLE1BQU0sd0JBQXdCO0FBQzlCLElBQUksZ0JBQWdCO0FBQ3BCLElBQUksdUJBQXVCO0FBSTNCLE1BQU0sMkJBQTJCO0FBQ2pDLElBQUksdUJBQXVCO0FBR3BCLFNBQVMsNEJBQWtDO0FBQ2hELGtCQUFnQjtBQUNoQix5QkFBdUI7QUFDdkIseUJBQXVCO0FBQ3pCO0FBR0EsTUFBTSxrQkFBa0IsSUFBSSxZQUFvQixFQUFFLEtBQUssSUFBSSxPQUFPLElBQVEsQ0FBQztBQVMzRSxTQUFTLHFCQUFxQixHQUEwQztBQUN0RSxTQUFPO0FBQUEsSUFDTCxPQUFPLEVBQUUsU0FBUztBQUFBLElBQ2xCLEtBQUssRUFBRTtBQUFBLElBQ1AsYUFBYSxFQUFFLGVBQWU7QUFBQSxJQUM5QixLQUFLLEVBQUUsT0FBTyxFQUFFLFlBQVk7QUFBQSxJQUM1QixnQkFBZ0IsRUFBRSxrQkFBa0I7QUFBQSxFQUN0QztBQUNGO0FBS0EsU0FBUyxtQkFBbUIsU0FBMkQ7QUFDckYsUUFBTSxPQUFPLG9CQUFJLElBQW1DO0FBQ3BELGFBQVcsVUFBVSxTQUFT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
