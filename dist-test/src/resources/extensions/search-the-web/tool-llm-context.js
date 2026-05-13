import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@gsd/pi-coding-agent";
import { Text } from "@gsd/pi-tui";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@gsd/pi-ai";
import { LRUTTLCache } from "./cache.js";
import { fetchWithRetryTimed, HttpError, classifyError } from "./http.js";
import { normalizeQuery, extractDomain } from "./url-utils.js";
import { formatLLMContext } from "./format.js";
import { publishedDateToAge } from "./tavily.js";
import { getTavilyApiKey, getOllamaApiKey, braveHeaders, resolveSearchProvider } from "./provider.js";
const contextCache = new LRUTTLCache({ max: 50, ttlMs: 6e5 });
contextCache.startPurgeInterval(6e4);
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}
function budgetContent(results, maxTokens, threshold) {
  const filtered = results.filter((r) => r.score >= threshold).sort((a, b) => b.score - a.score);
  if (filtered.length === 0) {
    return { grounding: [], sources: {}, estimatedTokens: 0 };
  }
  const effectiveBudget = Math.floor(maxTokens * 0.8);
  const perResultBudget = Math.max(1, Math.floor(effectiveBudget / filtered.length));
  const grounding = [];
  const sources = {};
  let totalTokens = 0;
  for (const result of filtered) {
    if (totalTokens >= effectiveBudget) break;
    const remainingBudget = effectiveBudget - totalTokens;
    const budget = Math.min(perResultBudget, remainingBudget);
    let text = result.raw_content ?? result.content;
    const maxChars = budget * 4;
    if (text.length > maxChars) {
      text = text.slice(0, maxChars);
    }
    const tokens = estimateTokens(text);
    totalTokens += tokens;
    grounding.push({
      url: result.url,
      title: result.title || "(untitled)",
      snippets: [text]
    });
    const ageString = result.published_date ? publishedDateToAge(result.published_date) : void 0;
    sources[result.url] = {
      title: result.title || "(untitled)",
      hostname: extractDomain(result.url),
      age: ageString ? [null, null, ageString] : null
    };
  }
  return { grounding, sources, estimatedTokens: totalTokens };
}
const THRESHOLD_TO_SCORE = {
  strict: 0.7,
  balanced: 0.5,
  lenient: 0.3
};
async function executeTavilyLLMContext(params, signal) {
  const scoreThreshold = THRESHOLD_TO_SCORE[params.threshold] ?? 0.5;
  const requestBody = {
    query: params.query,
    max_results: params.count,
    search_depth: "advanced",
    include_raw_content: true,
    include_answer: true
  };
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
  const cached = budgetContent(data.results, params.maxTokens, scoreThreshold);
  return { cached, latencyMs: timed.latencyMs, rateLimit: timed.rateLimit };
}
async function executeOllamaLLMContext(params, signal) {
  const scoreThreshold = THRESHOLD_TO_SCORE[params.threshold] ?? 0.5;
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
  const tavilyLikeResults = (data.results || []).map((r) => ({
    title: r.title || "(untitled)",
    url: r.url,
    content: r.content || "",
    score: 1
    // Ollama doesn't provide scores, assume all are relevant
  }));
  const cached = budgetContent(tavilyLikeResults, params.maxTokens, scoreThreshold);
  return { cached, latencyMs: timed.latencyMs, rateLimit: timed.rateLimit };
}
function registerLLMContextTool(pi) {
  pi.registerTool({
    name: "search_and_read",
    label: "Search & Read",
    description: "Search the web AND read page content in a single call. Returns pre-extracted, relevance-scored text from multiple pages \u2014 no separate fetch_page needed. Best when you need content, not just links. For selective URL browsing, use search-the-web + fetch_page instead.",
    promptSnippet: "Search and read web page content in one step",
    promptGuidelines: [
      "Use search_and_read when you need actual page content about a topic \u2014 it searches and extracts in one call.",
      "Prefer search_and_read over search-the-web + fetch_page when you just need to learn about something.",
      "Use search-the-web when you need to browse specific URLs, control which pages to read, or want just links.",
      "Start with the default maxTokens (8192). Use smaller values (2048-4096) for simple factual queries.",
      "Use threshold='strict' for focused, high-relevance results. Use 'lenient' for broad coverage."
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query \u2014 what you want to learn about" }),
      maxTokens: Type.Optional(
        Type.Number({
          minimum: 1024,
          maximum: 32768,
          default: 8192,
          description: "Approximate maximum tokens of content to return (default: 8192). Lower = faster + cheaper inference."
        })
      ),
      maxUrls: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 20,
          default: 10,
          description: "Maximum number of source URLs to include (default: 10)."
        })
      ),
      threshold: Type.Optional(
        StringEnum(["strict", "balanced", "lenient"], {
          description: "Relevance threshold. 'strict' = fewer but more relevant. 'balanced' (default). 'lenient' = broader coverage."
        })
      ),
      count: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 50,
          default: 20,
          description: "Maximum search results to consider (default: 20). More = broader but slower."
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
          content: [{ type: "text", text: "search_and_read unavailable: No search API key is set. Use secure_env_collect to set TAVILY_API_KEY, BRAVE_API_KEY, or OLLAMA_API_KEY." }],
          isError: true,
          details: { errorKind: "auth_error", error: "No search API key set" }
        };
      }
      const maxTokens = params.maxTokens ?? 8192;
      const maxUrls = params.maxUrls ?? 10;
      const threshold = params.threshold ?? "balanced";
      const count = params.count ?? 20;
      const cacheKey = normalizeQuery(params.query) + `|t:${maxTokens}|u:${maxUrls}|th:${threshold}|c:${count}|p:${provider}`;
      const cached = contextCache.get(cacheKey);
      if (cached) {
        const output = formatLLMContext(params.query, cached.grounding, cached.sources, {
          cached: true,
          tokenCount: cached.estimatedTokens
        });
        const truncation = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
        let content = truncation.content;
        if (truncation.truncated) {
          const tempFile = await pi.writeTempFile(output, { prefix: "llm-context-" });
          content += `

[Truncated. Full content: ${tempFile}]`;
        }
        const totalSnippets = cached.grounding.reduce((sum, g) => sum + g.snippets.length, 0);
        const details = {
          query: params.query,
          sourceCount: cached.grounding.length,
          snippetCount: totalSnippets,
          estimatedTokens: cached.estimatedTokens,
          cached: true,
          threshold,
          maxTokens,
          provider
        };
        return { content: [{ type: "text", text: content }], details };
      }
      onUpdate?.({ content: [{ type: "text", text: `Searching & reading about "${params.query}"...` }], details: void 0 });
      try {
        let result;
        let latencyMs;
        let rateLimit;
        if (provider === "tavily") {
          const tavilyResult = await executeTavilyLLMContext(
            { query: params.query, maxTokens, maxUrls, threshold, count },
            signal
          );
          result = tavilyResult.cached;
          latencyMs = tavilyResult.latencyMs;
          rateLimit = tavilyResult.rateLimit;
        } else if (provider === "ollama") {
          const ollamaResult = await executeOllamaLLMContext(
            { query: params.query, maxTokens, count, threshold },
            signal
          );
          result = ollamaResult.cached;
          latencyMs = ollamaResult.latencyMs;
          rateLimit = ollamaResult.rateLimit;
        } else {
          const url = new URL("https://api.search.brave.com/res/v1/llm/context");
          url.searchParams.append("q", params.query);
          url.searchParams.append("count", String(count));
          url.searchParams.append("maximum_number_of_tokens", String(maxTokens));
          url.searchParams.append("maximum_number_of_urls", String(maxUrls));
          url.searchParams.append("context_threshold_mode", threshold);
          let timed;
          try {
            timed = await fetchWithRetryTimed(url.toString(), {
              method: "GET",
              headers: braveHeaders(),
              signal
            }, 2);
          } catch (fetchErr) {
            let errorMessage;
            let errorKindOverride;
            if (fetchErr instanceof HttpError && fetchErr.response) {
              try {
                const body = await fetchErr.response.clone().json().catch(() => null);
                if (body?.error?.detail) {
                  errorMessage = body.error.detail;
                  if (body.error.code === "OPTION_NOT_IN_PLAN") {
                    errorKindOverride = "plan_error";
                    errorMessage = `LLM Context API not available on your current Brave plan. ${body.error.detail} Upgrade at https://api-dashboard.search.brave.com/app/subscriptions \u2014 or use search-the-web + fetch_page as an alternative.`;
                  }
                }
              } catch {
              }
            }
            const classified = classifyError(fetchErr);
            const message = errorMessage || classified.message;
            return {
              content: [{ type: "text", text: `search_and_read unavailable: ${message}` }],
              details: {
                errorKind: errorKindOverride || classified.kind,
                error: message,
                retryAfterMs: classified.retryAfterMs,
                query: params.query,
                provider
              },
              isError: true
            };
          }
          const data = await timed.response.json();
          const grounding = [];
          if (data.grounding?.generic) {
            for (const item of data.grounding.generic) {
              if (item.snippets && item.snippets.length > 0) {
                grounding.push({
                  url: item.url,
                  title: item.title,
                  snippets: item.snippets
                });
              }
            }
          }
          if (data.grounding?.poi && data.grounding.poi.snippets?.length) {
            grounding.push({
              url: data.grounding.poi.url,
              title: data.grounding.poi.title || data.grounding.poi.name,
              snippets: data.grounding.poi.snippets
            });
          }
          if (data.grounding?.map) {
            for (const item of data.grounding.map) {
              if (item.snippets?.length) {
                grounding.push({
                  url: item.url,
                  title: item.title || item.name,
                  snippets: item.snippets
                });
              }
            }
          }
          const sources = {};
          if (data.sources) {
            for (const [sourceUrl, sourceInfo] of Object.entries(data.sources)) {
              sources[sourceUrl] = {
                title: sourceInfo.title,
                hostname: sourceInfo.hostname,
                age: sourceInfo.age
              };
            }
          }
          const allText = grounding.map((g) => g.snippets.join(" ")).join(" ");
          const estimatedTokens = estimateTokens(allText);
          result = { grounding, sources, estimatedTokens };
          latencyMs = timed.latencyMs;
          rateLimit = timed.rateLimit;
        }
        contextCache.set(cacheKey, result);
        const output = formatLLMContext(params.query, result.grounding, result.sources, {
          tokenCount: result.estimatedTokens
        });
        const truncation = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
        let content = truncation.content;
        if (truncation.truncated) {
          const tempFile = await pi.writeTempFile(output, { prefix: "llm-context-" });
          content += `

[Truncated. Full content: ${tempFile}]`;
        }
        const totalSnippets = result.grounding.reduce((sum, g) => sum + g.snippets.length, 0);
        const details = {
          query: params.query,
          sourceCount: result.grounding.length,
          snippetCount: totalSnippets,
          estimatedTokens: result.estimatedTokens,
          cached: false,
          latencyMs,
          rateLimit,
          threshold,
          maxTokens,
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
            query: params.query,
            provider
          },
          isError: true
        };
      }
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("search_and_read "));
      text += theme.fg("muted", `"${args.query}"`);
      const meta = [];
      if (args.maxTokens && args.maxTokens !== 8192) meta.push(`${(args.maxTokens / 1e3).toFixed(0)}k tokens`);
      if (args.threshold && args.threshold !== "balanced") meta.push(`threshold:${args.threshold}`);
      if (args.maxUrls && args.maxUrls !== 10) meta.push(`${args.maxUrls} urls`);
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
      const latencyTag = details?.latencyMs ? theme.fg("dim", ` ${details.latencyMs}ms`) : "";
      const tokenTag = details?.estimatedTokens ? theme.fg("dim", ` ~${(details.estimatedTokens / 1e3).toFixed(1)}k tokens`) : "";
      let text = theme.fg(
        "success",
        `\u2713 ${details?.sourceCount ?? 0} sources, ${details?.snippetCount ?? 0} snippets for "${details?.query}"`
      ) + providerTag + tokenTag + cacheTag + latencyTag;
      if (expanded && result.content[0]?.type === "text") {
        const preview = result.content[0].text.split("\n").slice(0, 10).join("\n");
        text += "\n\n" + theme.fg("dim", preview);
      }
      return new Text(text, 0, 0);
    }
  });
}
export {
  budgetContent,
  registerLLMContextTool
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL3NlYXJjaC10aGUtd2ViL3Rvb2wtbGxtLWNvbnRleHQudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogc2VhcmNoX2FuZF9yZWFkIHRvb2wgXHUyMDE0IHdlYiBzZWFyY2ggKyBjb250ZW50IGV4dHJhY3Rpb24gZm9yIEFJIGFnZW50cy5cbiAqXG4gKiBTaW5nbGUtY2FsbCB3ZWIgc2VhcmNoICsgcGFnZSBjb250ZW50IGV4dHJhY3Rpb24gb3B0aW1pemVkIGZvciBBSSBhZ2VudHMuXG4gKiBVbmxpa2Ugc2VhcmNoLXRoZS13ZWIgXHUyMTkyIGZldGNoX3BhZ2UgKHR3byBzdGVwcyksIHRoaXMgcmV0dXJucyBwcmUtZXh0cmFjdGVkLFxuICogcmVsZXZhbmNlLXNjb3JlZCBwYWdlIGNvbnRlbnQgaW4gb25lIEFQSSBjYWxsLlxuICpcbiAqIFN1cHBvcnRzIHR3byBiYWNrZW5kczpcbiAqIC0gVGF2aWx5OiBQT1NULWJhc2VkLCBjbGllbnQtc2lkZSB0b2tlbiBidWRnZXRpbmcgdmlhIGJ1ZGdldENvbnRlbnQoKVxuICogLSBCcmF2ZTogR0VULWJhc2VkIExMTSBDb250ZXh0IEFQSSB3aXRoIHNlcnZlci1zaWRlIGJ1ZGdldGluZ1xuICpcbiAqIFByb3ZpZGVyIGlzIHNlbGVjdGVkIGJ5IHJlc29sdmVTZWFyY2hQcm92aWRlcigpIFx1MjAxNCBzYW1lIGFzIHRvb2wtc2VhcmNoLnRzLlxuICpcbiAqIEJlc3QgZm9yOiBcIkkgbmVlZCB0byBrbm93IGFib3V0IFhcIiBcdTIwMTQgd2hlbiB5b3Ugd2FudCBjb250ZW50LCBub3QganVzdCBsaW5rcy5cbiAqIFVzZSBzZWFyY2gtdGhlLXdlYiB3aGVuIHlvdSB3YW50IGxpbmtzL1VSTHMgdG8gYnJvd3NlIHNlbGVjdGl2ZWx5LlxuICovXG5cbmltcG9ydCB0eXBlIHsgRXh0ZW5zaW9uQVBJIH0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XG5pbXBvcnQgeyB0cnVuY2F0ZUhlYWQsIERFRkFVTFRfTUFYX0JZVEVTLCBERUZBVUxUX01BWF9MSU5FUyB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuaW1wb3J0IHsgVGV4dCB9IGZyb20gXCJAZ3NkL3BpLXR1aVwiO1xuaW1wb3J0IHsgVHlwZSB9IGZyb20gXCJAc2luY2xhaXIvdHlwZWJveFwiO1xuaW1wb3J0IHsgU3RyaW5nRW51bSB9IGZyb20gXCJAZ3NkL3BpLWFpXCI7XG5cbmltcG9ydCB7IExSVVRUTENhY2hlIH0gZnJvbSBcIi4vY2FjaGUuanNcIjtcbmltcG9ydCB7IGZldGNoV2l0aFJldHJ5VGltZWQsIEh0dHBFcnJvciwgY2xhc3NpZnlFcnJvciwgdHlwZSBSYXRlTGltaXRJbmZvIH0gZnJvbSBcIi4vaHR0cC5qc1wiO1xuaW1wb3J0IHsgbm9ybWFsaXplUXVlcnksIGV4dHJhY3REb21haW4gfSBmcm9tIFwiLi91cmwtdXRpbHMuanNcIjtcbmltcG9ydCB7IGZvcm1hdExMTUNvbnRleHQsIHR5cGUgTExNQ29udGV4dFNuaXBwZXQsIHR5cGUgTExNQ29udGV4dFNvdXJjZSB9IGZyb20gXCIuL2Zvcm1hdC5qc1wiO1xuaW1wb3J0IHR5cGUgeyBUYXZpbHlSZXN1bHQsIFRhdmlseVNlYXJjaFJlc3BvbnNlIH0gZnJvbSBcIi4vdGF2aWx5LmpzXCI7XG5pbXBvcnQgeyBwdWJsaXNoZWREYXRlVG9BZ2UgfSBmcm9tIFwiLi90YXZpbHkuanNcIjtcbmltcG9ydCB7IGdldFRhdmlseUFwaUtleSwgZ2V0T2xsYW1hQXBpS2V5LCBnZXRCcmF2ZUFwaUtleSwgYnJhdmVIZWFkZXJzLCByZXNvbHZlU2VhcmNoUHJvdmlkZXIgfSBmcm9tIFwiLi9wcm92aWRlci5qc1wiO1xuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gVHlwZXNcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmludGVyZmFjZSBCcmF2ZUxMTUNvbnRleHRSZXNwb25zZSB7XG4gIGdyb3VuZGluZz86IHtcbiAgICBnZW5lcmljPzogQXJyYXk8e1xuICAgICAgdXJsOiBzdHJpbmc7XG4gICAgICB0aXRsZTogc3RyaW5nO1xuICAgICAgc25pcHBldHM6IHN0cmluZ1tdO1xuICAgIH0+O1xuICAgIHBvaT86IHtcbiAgICAgIG5hbWU6IHN0cmluZztcbiAgICAgIHVybDogc3RyaW5nO1xuICAgICAgdGl0bGU6IHN0cmluZztcbiAgICAgIHNuaXBwZXRzOiBzdHJpbmdbXTtcbiAgICB9IHwgbnVsbDtcbiAgICBtYXA/OiBBcnJheTx7XG4gICAgICBuYW1lOiBzdHJpbmc7XG4gICAgICB1cmw6IHN0cmluZztcbiAgICAgIHRpdGxlOiBzdHJpbmc7XG4gICAgICBzbmlwcGV0czogc3RyaW5nW107XG4gICAgfT47XG4gIH07XG4gIHNvdXJjZXM/OiBSZWNvcmQ8c3RyaW5nLCB7XG4gICAgdGl0bGU6IHN0cmluZztcbiAgICBob3N0bmFtZTogc3RyaW5nO1xuICAgIGFnZTogc3RyaW5nW10gfCBudWxsO1xuICB9Pjtcbn1cblxuaW50ZXJmYWNlIENhY2hlZExMTUNvbnRleHQge1xuICBncm91bmRpbmc6IExMTUNvbnRleHRTbmlwcGV0W107XG4gIHNvdXJjZXM6IFJlY29yZDxzdHJpbmcsIExMTUNvbnRleHRTb3VyY2U+O1xuICBlc3RpbWF0ZWRUb2tlbnM6IG51bWJlcjtcbn1cblxuaW50ZXJmYWNlIExMTUNvbnRleHREZXRhaWxzIHtcbiAgcXVlcnk6IHN0cmluZztcbiAgc291cmNlQ291bnQ6IG51bWJlcjtcbiAgc25pcHBldENvdW50OiBudW1iZXI7XG4gIGVzdGltYXRlZFRva2VuczogbnVtYmVyO1xuICBjYWNoZWQ6IGJvb2xlYW47XG4gIGxhdGVuY3lNcz86IG51bWJlcjtcbiAgcmF0ZUxpbWl0PzogUmF0ZUxpbWl0SW5mbztcbiAgdGhyZXNob2xkPzogc3RyaW5nO1xuICBtYXhUb2tlbnM/OiBudW1iZXI7XG4gIGVycm9yS2luZD86IHN0cmluZztcbiAgZXJyb3I/OiBzdHJpbmc7XG4gIHJldHJ5QWZ0ZXJNcz86IG51bWJlcjtcbiAgcHJvdmlkZXI/OiAndGF2aWx5JyB8ICdicmF2ZScgfCAnb2xsYW1hJztcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIENhY2hlXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4vLyBMTE0gQ29udGV4dCBjYWNoZTogbWF4IDUwIGVudHJpZXMsIDEwLW1pbnV0ZSBUVExcbmNvbnN0IGNvbnRleHRDYWNoZSA9IG5ldyBMUlVUVExDYWNoZTxDYWNoZWRMTE1Db250ZXh0Pih7IG1heDogNTAsIHR0bE1zOiA2MDBfMDAwIH0pO1xuY29udGV4dENhY2hlLnN0YXJ0UHVyZ2VJbnRlcnZhbCg2MF8wMDApO1xuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gSGVscGVyc1xuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqIFJvdWdoIHRva2VuIGVzdGltYXRlOiB+NCBjaGFycyBwZXIgdG9rZW4gZm9yIEVuZ2xpc2ggdGV4dC4gKi9cbmZ1bmN0aW9uIGVzdGltYXRlVG9rZW5zKHRleHQ6IHN0cmluZyk6IG51bWJlciB7XG4gIHJldHVybiBNYXRoLmNlaWwodGV4dC5sZW5ndGggLyA0KTtcbn1cblxuLyoqXG4gKiBEaXN0cmlidXRlIGEgdG9rZW4gYnVkZ2V0IGFjcm9zcyBUYXZpbHkgcmVzdWx0cyB0byBidWlsZCBMTE0gY29udGV4dC5cbiAqXG4gKiBDbGllbnQtc2lkZSBlcXVpdmFsZW50IG9mIEJyYXZlJ3Mgc2VydmVyLXNpZGUgTExNIENvbnRleHQgQVBJIGJ1ZGdldGluZy5cbiAqIEZpbHRlcnMgYnkgc2NvcmUgdGhyZXNob2xkLCBzb3J0cyBieSByZWxldmFuY2UsIGFuZCB0cnVuY2F0ZXMgY29udGVudCB0byBmaXRcbiAqIHdpdGhpbiB0aGUgdG9rZW4gYnVkZ2V0LiBVc2VzIGByYXdfY29udGVudGAgd2hlbiBhdmFpbGFibGUgKHJpY2hlciB0ZXh0IGZyb21cbiAqIFRhdmlseSdzIFwiYWR2YW5jZWRcIiBzZWFyY2ggZGVwdGgpLCBmYWxsaW5nIGJhY2sgdG8gYGNvbnRlbnRgLlxuICpcbiAqIEBwYXJhbSByZXN1bHRzICBcdTIwMTQgUmF3IFRhdmlseSBzZWFyY2ggcmVzdWx0c1xuICogQHBhcmFtIG1heFRva2VucyBcdTIwMTQgQ2FsbGVyLXJlcXVlc3RlZCB0b2tlbiBsaW1pdFxuICogQHBhcmFtIHRocmVzaG9sZCBcdTIwMTQgTWluaW11bSBzY29yZSAoMFx1MjAxMzEpIGZvciBpbmNsdXNpb25cbiAqIEByZXR1cm5zIEdyb3VuZGluZyBzbmlwcGV0cywgc291cmNlIG1ldGFkYXRhLCBhbmQgZXN0aW1hdGVkIHRva2VuIHVzYWdlXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWRnZXRDb250ZW50KFxuICByZXN1bHRzOiBUYXZpbHlSZXN1bHRbXSxcbiAgbWF4VG9rZW5zOiBudW1iZXIsXG4gIHRocmVzaG9sZDogbnVtYmVyLFxuKTogeyBncm91bmRpbmc6IExMTUNvbnRleHRTbmlwcGV0W107IHNvdXJjZXM6IFJlY29yZDxzdHJpbmcsIExMTUNvbnRleHRTb3VyY2U+OyBlc3RpbWF0ZWRUb2tlbnM6IG51bWJlciB9IHtcbiAgLy8gRmlsdGVyIGJ5IHNjb3JlIHRocmVzaG9sZCBhbmQgc29ydCBieSBzY29yZSBkZXNjZW5kaW5nIChoaWdoZXN0IHJlbGV2YW5jZSBmaXJzdClcbiAgY29uc3QgZmlsdGVyZWQgPSByZXN1bHRzXG4gICAgLmZpbHRlcihyID0+IHIuc2NvcmUgPj0gdGhyZXNob2xkKVxuICAgIC5zb3J0KChhLCBiKSA9PiBiLnNjb3JlIC0gYS5zY29yZSk7XG5cbiAgaWYgKGZpbHRlcmVkLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiB7IGdyb3VuZGluZzogW10sIHNvdXJjZXM6IHt9LCBlc3RpbWF0ZWRUb2tlbnM6IDAgfTtcbiAgfVxuXG4gIC8vIFVzZSA4MCUgb2YgbWF4VG9rZW5zIGFzIGVmZmVjdGl2ZSBidWRnZXQgKGNvbnNlcnZhdGl2ZSB0byBhdm9pZCBvdmVyc2hvb3QpXG4gIGNvbnN0IGVmZmVjdGl2ZUJ1ZGdldCA9IE1hdGguZmxvb3IobWF4VG9rZW5zICogMC44KTtcbiAgY29uc3QgcGVyUmVzdWx0QnVkZ2V0ID0gTWF0aC5tYXgoMSwgTWF0aC5mbG9vcihlZmZlY3RpdmVCdWRnZXQgLyBmaWx0ZXJlZC5sZW5ndGgpKTtcblxuICBjb25zdCBncm91bmRpbmc6IExMTUNvbnRleHRTbmlwcGV0W10gPSBbXTtcbiAgY29uc3Qgc291cmNlczogUmVjb3JkPHN0cmluZywgTExNQ29udGV4dFNvdXJjZT4gPSB7fTtcbiAgbGV0IHRvdGFsVG9rZW5zID0gMDtcblxuICBmb3IgKGNvbnN0IHJlc3VsdCBvZiBmaWx0ZXJlZCkge1xuICAgIGlmICh0b3RhbFRva2VucyA+PSBlZmZlY3RpdmVCdWRnZXQpIGJyZWFrO1xuXG4gICAgY29uc3QgcmVtYWluaW5nQnVkZ2V0ID0gZWZmZWN0aXZlQnVkZ2V0IC0gdG90YWxUb2tlbnM7XG4gICAgY29uc3QgYnVkZ2V0ID0gTWF0aC5taW4ocGVyUmVzdWx0QnVkZ2V0LCByZW1haW5pbmdCdWRnZXQpO1xuXG4gICAgLy8gVXNlIHJhd19jb250ZW50IGlmIGF2YWlsYWJsZSwgZmFsbCBiYWNrIHRvIGNvbnRlbnRcbiAgICBsZXQgdGV4dCA9IHJlc3VsdC5yYXdfY29udGVudCA/PyByZXN1bHQuY29udGVudDtcblxuICAgIC8vIFRydW5jYXRlIHRvIHBlci1yZXN1bHQgYnVkZ2V0ICh0b2tlbnMgXHUyMTkyIGNoYXJzIGF0IH40IGNoYXJzL3Rva2VuKVxuICAgIGNvbnN0IG1heENoYXJzID0gYnVkZ2V0ICogNDtcbiAgICBpZiAodGV4dC5sZW5ndGggPiBtYXhDaGFycykge1xuICAgICAgdGV4dCA9IHRleHQuc2xpY2UoMCwgbWF4Q2hhcnMpO1xuICAgIH1cblxuICAgIGNvbnN0IHRva2VucyA9IGVzdGltYXRlVG9rZW5zKHRleHQpO1xuICAgIHRvdGFsVG9rZW5zICs9IHRva2VucztcblxuICAgIGdyb3VuZGluZy5wdXNoKHtcbiAgICAgIHVybDogcmVzdWx0LnVybCxcbiAgICAgIHRpdGxlOiByZXN1bHQudGl0bGUgfHwgXCIodW50aXRsZWQpXCIsXG4gICAgICBzbmlwcGV0czogW3RleHRdLFxuICAgIH0pO1xuXG4gICAgLy8gQnVpbGQgc291cmNlIHdpdGggYWdlIGluIFtudWxsLCBudWxsLCBhZ2VTdHJpbmddIGZvcm1hdCBmb3IgZm9ybWF0TExNQ29udGV4dCBjb21wYXRpYmlsaXR5LlxuICAgIC8vIGZvcm1hdExMTUNvbnRleHQgcmVhZHMgc291cmNlLmFnZT8uWzJdIGZvciB0aGUgaHVtYW4tcmVhZGFibGUgYWdlIGRpc3BsYXkuXG4gICAgY29uc3QgYWdlU3RyaW5nID0gcmVzdWx0LnB1Ymxpc2hlZF9kYXRlID8gcHVibGlzaGVkRGF0ZVRvQWdlKHJlc3VsdC5wdWJsaXNoZWRfZGF0ZSkgOiB1bmRlZmluZWQ7XG4gICAgc291cmNlc1tyZXN1bHQudXJsXSA9IHtcbiAgICAgIHRpdGxlOiByZXN1bHQudGl0bGUgfHwgXCIodW50aXRsZWQpXCIsXG4gICAgICBob3N0bmFtZTogZXh0cmFjdERvbWFpbihyZXN1bHQudXJsKSxcbiAgICAgIGFnZTogYWdlU3RyaW5nID8gW251bGwgYXMgdW5rbm93biBhcyBzdHJpbmcsIG51bGwgYXMgdW5rbm93biBhcyBzdHJpbmcsIGFnZVN0cmluZ10gOiBudWxsLFxuICAgIH07XG4gIH1cblxuICByZXR1cm4geyBncm91bmRpbmcsIHNvdXJjZXMsIGVzdGltYXRlZFRva2VuczogdG90YWxUb2tlbnMgfTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFRhdmlseSBMTE0gQ29udGV4dCBFeGVjdXRpb25cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKiBNYXAgdGhyZXNob2xkIG5hbWVzIHRvIFRhdmlseSBzY29yZSBjdXRvZmZzLiAqL1xuY29uc3QgVEhSRVNIT0xEX1RPX1NDT1JFOiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+ID0ge1xuICBzdHJpY3Q6IDAuNyxcbiAgYmFsYW5jZWQ6IDAuNSxcbiAgbGVuaWVudDogMC4zLFxufTtcblxuLyoqXG4gKiBFeGVjdXRlIGEgc2VhcmNoX2FuZF9yZWFkIHF1ZXJ5IGFnYWluc3QgdGhlIFRhdmlseSBBUEkuXG4gKlxuICogVXNlcyBQT1NUIHdpdGggYWR2YW5jZWQgc2VhcmNoIGRlcHRoICsgcmF3X2NvbnRlbnQgdG8gZ2V0IGZ1bGwgcGFnZSB0ZXh0LFxuICogdGhlbiBmZWVkcyByZXN1bHRzIHRocm91Z2ggYnVkZ2V0Q29udGVudCgpIGZvciBjbGllbnQtc2lkZSB0b2tlbiBidWRnZXRpbmcuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGV4ZWN1dGVUYXZpbHlMTE1Db250ZXh0KFxuICBwYXJhbXM6IHsgcXVlcnk6IHN0cmluZzsgbWF4VG9rZW5zOiBudW1iZXI7IG1heFVybHM6IG51bWJlcjsgdGhyZXNob2xkOiBzdHJpbmc7IGNvdW50OiBudW1iZXIgfSxcbiAgc2lnbmFsPzogQWJvcnRTaWduYWwsXG4pOiBQcm9taXNlPHsgY2FjaGVkOiBDYWNoZWRMTE1Db250ZXh0OyBsYXRlbmN5TXM6IG51bWJlcjsgcmF0ZUxpbWl0PzogUmF0ZUxpbWl0SW5mbyB9PiB7XG4gIGNvbnN0IHNjb3JlVGhyZXNob2xkID0gVEhSRVNIT0xEX1RPX1NDT1JFW3BhcmFtcy50aHJlc2hvbGRdID8/IDAuNTtcblxuICBjb25zdCByZXF1ZXN0Qm9keTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgcXVlcnk6IHBhcmFtcy5xdWVyeSxcbiAgICBtYXhfcmVzdWx0czogcGFyYW1zLmNvdW50LFxuICAgIHNlYXJjaF9kZXB0aDogXCJhZHZhbmNlZFwiLFxuICAgIGluY2x1ZGVfcmF3X2NvbnRlbnQ6IHRydWUsXG4gICAgaW5jbHVkZV9hbnN3ZXI6IHRydWUsXG4gIH07XG5cbiAgY29uc3QgdGltZWQgPSBhd2FpdCBmZXRjaFdpdGhSZXRyeVRpbWVkKFwiaHR0cHM6Ly9hcGkudGF2aWx5LmNvbS9zZWFyY2hcIiwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgaGVhZGVyczoge1xuICAgICAgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIsXG4gICAgICBcIkF1dGhvcml6YXRpb25cIjogYEJlYXJlciAke2dldFRhdmlseUFwaUtleSgpfWAsXG4gICAgfSxcbiAgICBib2R5OiBKU09OLnN0cmluZ2lmeShyZXF1ZXN0Qm9keSksXG4gICAgc2lnbmFsLFxuICB9LCAyKTtcblxuICBjb25zdCBkYXRhOiBUYXZpbHlTZWFyY2hSZXNwb25zZSA9IGF3YWl0IHRpbWVkLnJlc3BvbnNlLmpzb24oKTtcbiAgY29uc3QgY2FjaGVkID0gYnVkZ2V0Q29udGVudChkYXRhLnJlc3VsdHMsIHBhcmFtcy5tYXhUb2tlbnMsIHNjb3JlVGhyZXNob2xkKTtcblxuICByZXR1cm4geyBjYWNoZWQsIGxhdGVuY3lNczogdGltZWQubGF0ZW5jeU1zLCByYXRlTGltaXQ6IHRpbWVkLnJhdGVMaW1pdCB9O1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gT2xsYW1hIExMTSBDb250ZXh0IEV4ZWN1dGlvblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuaW50ZXJmYWNlIE9sbGFtYVdlYlNlYXJjaFJlc3VsdCB7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIHVybDogc3RyaW5nO1xuICBjb250ZW50OiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBPbGxhbWFXZWJTZWFyY2hSZXNwb25zZSB7XG4gIHJlc3VsdHM6IE9sbGFtYVdlYlNlYXJjaFJlc3VsdFtdO1xufVxuXG4vKipcbiAqIEV4ZWN1dGUgYSBzZWFyY2hfYW5kX3JlYWQgcXVlcnkgYWdhaW5zdCB0aGUgT2xsYW1hIHdlYl9zZWFyY2ggQVBJLlxuICpcbiAqIFVzZXMgdGhlIHNhbWUgd2ViX3NlYXJjaCBlbmRwb2ludCBhcyB0b29sLXNlYXJjaCwgdGhlbiBhcHBsaWVzXG4gKiBidWRnZXRDb250ZW50KCkgZm9yIGNsaWVudC1zaWRlIHRva2VuIGJ1ZGdldGluZyAoc2ltaWxhciB0byBUYXZpbHkgcGF0aCkuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGV4ZWN1dGVPbGxhbWFMTE1Db250ZXh0KFxuICBwYXJhbXM6IHsgcXVlcnk6IHN0cmluZzsgbWF4VG9rZW5zOiBudW1iZXI7IGNvdW50OiBudW1iZXI7IHRocmVzaG9sZDogc3RyaW5nIH0sXG4gIHNpZ25hbD86IEFib3J0U2lnbmFsLFxuKTogUHJvbWlzZTx7IGNhY2hlZDogQ2FjaGVkTExNQ29udGV4dDsgbGF0ZW5jeU1zOiBudW1iZXI7IHJhdGVMaW1pdD86IFJhdGVMaW1pdEluZm8gfT4ge1xuICBjb25zdCBzY29yZVRocmVzaG9sZCA9IFRIUkVTSE9MRF9UT19TQ09SRVtwYXJhbXMudGhyZXNob2xkXSA/PyAwLjU7XG5cbiAgY29uc3QgdGltZWQgPSBhd2FpdCBmZXRjaFdpdGhSZXRyeVRpbWVkKFwiaHR0cHM6Ly9vbGxhbWEuY29tL2FwaS93ZWJfc2VhcmNoXCIsIHtcbiAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgIGhlYWRlcnM6IHtcbiAgICAgIFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiLFxuICAgICAgXCJBdXRob3JpemF0aW9uXCI6IGBCZWFyZXIgJHtnZXRPbGxhbWFBcGlLZXkoKX1gLFxuICAgIH0sXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBxdWVyeTogcGFyYW1zLnF1ZXJ5LCBtYXhfcmVzdWx0czogcGFyYW1zLmNvdW50IH0pLFxuICAgIHNpZ25hbCxcbiAgfSwgMik7XG5cbiAgY29uc3QgZGF0YTogT2xsYW1hV2ViU2VhcmNoUmVzcG9uc2UgPSBhd2FpdCB0aW1lZC5yZXNwb25zZS5qc29uKCk7XG5cbiAgLy8gQ29udmVydCBPbGxhbWEgcmVzdWx0cyB0byBUYXZpbHlSZXN1bHQtY29tcGF0aWJsZSBmb3JtYXQgZm9yIGJ1ZGdldENvbnRlbnRcbiAgY29uc3QgdGF2aWx5TGlrZVJlc3VsdHM6IFRhdmlseVJlc3VsdFtdID0gKGRhdGEucmVzdWx0cyB8fCBbXSkubWFwKHIgPT4gKHtcbiAgICB0aXRsZTogci50aXRsZSB8fCBcIih1bnRpdGxlZClcIixcbiAgICB1cmw6IHIudXJsLFxuICAgIGNvbnRlbnQ6IHIuY29udGVudCB8fCBcIlwiLFxuICAgIHNjb3JlOiAxLjAsIC8vIE9sbGFtYSBkb2Vzbid0IHByb3ZpZGUgc2NvcmVzLCBhc3N1bWUgYWxsIGFyZSByZWxldmFudFxuICB9KSk7XG5cbiAgY29uc3QgY2FjaGVkID0gYnVkZ2V0Q29udGVudCh0YXZpbHlMaWtlUmVzdWx0cywgcGFyYW1zLm1heFRva2Vucywgc2NvcmVUaHJlc2hvbGQpO1xuXG4gIHJldHVybiB7IGNhY2hlZCwgbGF0ZW5jeU1zOiB0aW1lZC5sYXRlbmN5TXMsIHJhdGVMaW1pdDogdGltZWQucmF0ZUxpbWl0IH07XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBUb29sIFJlZ2lzdHJhdGlvblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyTExNQ29udGV4dFRvb2wocGk6IEV4dGVuc2lvbkFQSSkge1xuICBwaS5yZWdpc3RlclRvb2woe1xuICAgIG5hbWU6IFwic2VhcmNoX2FuZF9yZWFkXCIsXG4gICAgbGFiZWw6IFwiU2VhcmNoICYgUmVhZFwiLFxuICAgIGRlc2NyaXB0aW9uOlxuICAgICAgXCJTZWFyY2ggdGhlIHdlYiBBTkQgcmVhZCBwYWdlIGNvbnRlbnQgaW4gYSBzaW5nbGUgY2FsbC4gUmV0dXJucyBwcmUtZXh0cmFjdGVkLCBcIiArXG4gICAgICBcInJlbGV2YW5jZS1zY29yZWQgdGV4dCBmcm9tIG11bHRpcGxlIHBhZ2VzIFx1MjAxNCBubyBzZXBhcmF0ZSBmZXRjaF9wYWdlIG5lZWRlZC4gXCIgK1xuICAgICAgXCJCZXN0IHdoZW4geW91IG5lZWQgY29udGVudCwgbm90IGp1c3QgbGlua3MuIFwiICtcbiAgICAgIFwiRm9yIHNlbGVjdGl2ZSBVUkwgYnJvd3NpbmcsIHVzZSBzZWFyY2gtdGhlLXdlYiArIGZldGNoX3BhZ2UgaW5zdGVhZC5cIixcbiAgICBwcm9tcHRTbmlwcGV0OiBcIlNlYXJjaCBhbmQgcmVhZCB3ZWIgcGFnZSBjb250ZW50IGluIG9uZSBzdGVwXCIsXG4gICAgcHJvbXB0R3VpZGVsaW5lczogW1xuICAgICAgXCJVc2Ugc2VhcmNoX2FuZF9yZWFkIHdoZW4geW91IG5lZWQgYWN0dWFsIHBhZ2UgY29udGVudCBhYm91dCBhIHRvcGljIFx1MjAxNCBpdCBzZWFyY2hlcyBhbmQgZXh0cmFjdHMgaW4gb25lIGNhbGwuXCIsXG4gICAgICBcIlByZWZlciBzZWFyY2hfYW5kX3JlYWQgb3ZlciBzZWFyY2gtdGhlLXdlYiArIGZldGNoX3BhZ2Ugd2hlbiB5b3UganVzdCBuZWVkIHRvIGxlYXJuIGFib3V0IHNvbWV0aGluZy5cIixcbiAgICAgIFwiVXNlIHNlYXJjaC10aGUtd2ViIHdoZW4geW91IG5lZWQgdG8gYnJvd3NlIHNwZWNpZmljIFVSTHMsIGNvbnRyb2wgd2hpY2ggcGFnZXMgdG8gcmVhZCwgb3Igd2FudCBqdXN0IGxpbmtzLlwiLFxuICAgICAgXCJTdGFydCB3aXRoIHRoZSBkZWZhdWx0IG1heFRva2VucyAoODE5MikuIFVzZSBzbWFsbGVyIHZhbHVlcyAoMjA0OC00MDk2KSBmb3Igc2ltcGxlIGZhY3R1YWwgcXVlcmllcy5cIixcbiAgICAgIFwiVXNlIHRocmVzaG9sZD0nc3RyaWN0JyBmb3IgZm9jdXNlZCwgaGlnaC1yZWxldmFuY2UgcmVzdWx0cy4gVXNlICdsZW5pZW50JyBmb3IgYnJvYWQgY292ZXJhZ2UuXCIsXG4gICAgXSxcbiAgICBwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG4gICAgICBxdWVyeTogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJTZWFyY2ggcXVlcnkgXHUyMDE0IHdoYXQgeW91IHdhbnQgdG8gbGVhcm4gYWJvdXRcIiB9KSxcbiAgICAgIG1heFRva2VuczogVHlwZS5PcHRpb25hbChcbiAgICAgICAgVHlwZS5OdW1iZXIoe1xuICAgICAgICAgIG1pbmltdW06IDEwMjQsXG4gICAgICAgICAgbWF4aW11bTogMzI3NjgsXG4gICAgICAgICAgZGVmYXVsdDogODE5MixcbiAgICAgICAgICBkZXNjcmlwdGlvbjogXCJBcHByb3hpbWF0ZSBtYXhpbXVtIHRva2VucyBvZiBjb250ZW50IHRvIHJldHVybiAoZGVmYXVsdDogODE5MikuIExvd2VyID0gZmFzdGVyICsgY2hlYXBlciBpbmZlcmVuY2UuXCIsXG4gICAgICAgIH0pXG4gICAgICApLFxuICAgICAgbWF4VXJsczogVHlwZS5PcHRpb25hbChcbiAgICAgICAgVHlwZS5OdW1iZXIoe1xuICAgICAgICAgIG1pbmltdW06IDEsXG4gICAgICAgICAgbWF4aW11bTogMjAsXG4gICAgICAgICAgZGVmYXVsdDogMTAsXG4gICAgICAgICAgZGVzY3JpcHRpb246IFwiTWF4aW11bSBudW1iZXIgb2Ygc291cmNlIFVSTHMgdG8gaW5jbHVkZSAoZGVmYXVsdDogMTApLlwiLFxuICAgICAgICB9KVxuICAgICAgKSxcbiAgICAgIHRocmVzaG9sZDogVHlwZS5PcHRpb25hbChcbiAgICAgICAgU3RyaW5nRW51bShbXCJzdHJpY3RcIiwgXCJiYWxhbmNlZFwiLCBcImxlbmllbnRcIl0gYXMgY29uc3QsIHtcbiAgICAgICAgICBkZXNjcmlwdGlvbjogXCJSZWxldmFuY2UgdGhyZXNob2xkLiAnc3RyaWN0JyA9IGZld2VyIGJ1dCBtb3JlIHJlbGV2YW50LiAnYmFsYW5jZWQnIChkZWZhdWx0KS4gJ2xlbmllbnQnID0gYnJvYWRlciBjb3ZlcmFnZS5cIixcbiAgICAgICAgfSlcbiAgICAgICksXG4gICAgICBjb3VudDogVHlwZS5PcHRpb25hbChcbiAgICAgICAgVHlwZS5OdW1iZXIoe1xuICAgICAgICAgIG1pbmltdW06IDEsXG4gICAgICAgICAgbWF4aW11bTogNTAsXG4gICAgICAgICAgZGVmYXVsdDogMjAsXG4gICAgICAgICAgZGVzY3JpcHRpb246IFwiTWF4aW11bSBzZWFyY2ggcmVzdWx0cyB0byBjb25zaWRlciAoZGVmYXVsdDogMjApLiBNb3JlID0gYnJvYWRlciBidXQgc2xvd2VyLlwiLFxuICAgICAgICB9KVxuICAgICAgKSxcbiAgICB9KSxcblxuICAgIGFzeW5jIGV4ZWN1dGUodG9vbENhbGxJZCwgcGFyYW1zLCBzaWduYWwsIG9uVXBkYXRlLCBjdHgpIHtcbiAgICAgIGlmIChzaWduYWw/LmFib3J0ZWQpIHtcbiAgICAgICAgcmV0dXJuIHsgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiU2VhcmNoIGNhbmNlbGxlZC5cIiB9XSwgZGV0YWlsczogdW5kZWZpbmVkIGFzIHVua25vd24gfTtcbiAgICAgIH1cblxuICAgICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgICAvLyBSZXNvbHZlIHNlYXJjaCBwcm92aWRlclxuICAgICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgICBjb25zdCBwcm92aWRlciA9IHJlc29sdmVTZWFyY2hQcm92aWRlcigpO1xuICAgICAgaWYgKCFwcm92aWRlcikge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcInNlYXJjaF9hbmRfcmVhZCB1bmF2YWlsYWJsZTogTm8gc2VhcmNoIEFQSSBrZXkgaXMgc2V0LiBVc2Ugc2VjdXJlX2Vudl9jb2xsZWN0IHRvIHNldCBUQVZJTFlfQVBJX0tFWSwgQlJBVkVfQVBJX0tFWSwgb3IgT0xMQU1BX0FQSV9LRVkuXCIgfV0sXG4gICAgICAgICAgaXNFcnJvcjogdHJ1ZSxcbiAgICAgICAgICBkZXRhaWxzOiB7IGVycm9yS2luZDogXCJhdXRoX2Vycm9yXCIsIGVycm9yOiBcIk5vIHNlYXJjaCBBUEkga2V5IHNldFwiIH0gc2F0aXNmaWVzIFBhcnRpYWw8TExNQ29udGV4dERldGFpbHM+LFxuICAgICAgICB9O1xuICAgICAgfVxuXG4gICAgICBjb25zdCBtYXhUb2tlbnMgPSBwYXJhbXMubWF4VG9rZW5zID8/IDgxOTI7XG4gICAgICBjb25zdCBtYXhVcmxzID0gcGFyYW1zLm1heFVybHMgPz8gMTA7XG4gICAgICBjb25zdCB0aHJlc2hvbGQgPSBwYXJhbXMudGhyZXNob2xkID8/IFwiYmFsYW5jZWRcIjtcbiAgICAgIGNvbnN0IGNvdW50ID0gcGFyYW1zLmNvdW50ID8/IDIwO1xuXG4gICAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAgIC8vIENhY2hlIGxvb2t1cCAocHJvdmlkZXItcHJlZml4ZWQga2V5KVxuICAgICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgICBjb25zdCBjYWNoZUtleSA9IG5vcm1hbGl6ZVF1ZXJ5KHBhcmFtcy5xdWVyeSkgKyBgfHQ6JHttYXhUb2tlbnN9fHU6JHttYXhVcmxzfXx0aDoke3RocmVzaG9sZH18Yzoke2NvdW50fXxwOiR7cHJvdmlkZXJ9YDtcbiAgICAgIGNvbnN0IGNhY2hlZCA9IGNvbnRleHRDYWNoZS5nZXQoY2FjaGVLZXkpO1xuXG4gICAgICBpZiAoY2FjaGVkKSB7XG4gICAgICAgIGNvbnN0IG91dHB1dCA9IGZvcm1hdExMTUNvbnRleHQocGFyYW1zLnF1ZXJ5LCBjYWNoZWQuZ3JvdW5kaW5nLCBjYWNoZWQuc291cmNlcywge1xuICAgICAgICAgIGNhY2hlZDogdHJ1ZSxcbiAgICAgICAgICB0b2tlbkNvdW50OiBjYWNoZWQuZXN0aW1hdGVkVG9rZW5zLFxuICAgICAgICB9KTtcblxuICAgICAgICBjb25zdCB0cnVuY2F0aW9uID0gdHJ1bmNhdGVIZWFkKG91dHB1dCwgeyBtYXhMaW5lczogREVGQVVMVF9NQVhfTElORVMsIG1heEJ5dGVzOiBERUZBVUxUX01BWF9CWVRFUyB9KTtcbiAgICAgICAgbGV0IGNvbnRlbnQgPSB0cnVuY2F0aW9uLmNvbnRlbnQ7XG4gICAgICAgIGlmICh0cnVuY2F0aW9uLnRydW5jYXRlZCkge1xuICAgICAgICAgIGNvbnN0IHRlbXBGaWxlID0gYXdhaXQgKHBpIGFzIGFueSkud3JpdGVUZW1wRmlsZShvdXRwdXQsIHsgcHJlZml4OiBcImxsbS1jb250ZXh0LVwiIH0pO1xuICAgICAgICAgIGNvbnRlbnQgKz0gYFxcblxcbltUcnVuY2F0ZWQuIEZ1bGwgY29udGVudDogJHt0ZW1wRmlsZX1dYDtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHRvdGFsU25pcHBldHMgPSBjYWNoZWQuZ3JvdW5kaW5nLnJlZHVjZSgoc3VtLCBnKSA9PiBzdW0gKyBnLnNuaXBwZXRzLmxlbmd0aCwgMCk7XG4gICAgICAgIGNvbnN0IGRldGFpbHM6IExMTUNvbnRleHREZXRhaWxzID0ge1xuICAgICAgICAgIHF1ZXJ5OiBwYXJhbXMucXVlcnksXG4gICAgICAgICAgc291cmNlQ291bnQ6IGNhY2hlZC5ncm91bmRpbmcubGVuZ3RoLFxuICAgICAgICAgIHNuaXBwZXRDb3VudDogdG90YWxTbmlwcGV0cyxcbiAgICAgICAgICBlc3RpbWF0ZWRUb2tlbnM6IGNhY2hlZC5lc3RpbWF0ZWRUb2tlbnMsXG4gICAgICAgICAgY2FjaGVkOiB0cnVlLFxuICAgICAgICAgIHRocmVzaG9sZCxcbiAgICAgICAgICBtYXhUb2tlbnMsXG4gICAgICAgICAgcHJvdmlkZXIsXG4gICAgICAgIH07XG5cbiAgICAgICAgcmV0dXJuIHsgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGNvbnRlbnQgfV0sIGRldGFpbHMgfTtcbiAgICAgIH1cblxuICAgICAgb25VcGRhdGU/Lih7IGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgU2VhcmNoaW5nICYgcmVhZGluZyBhYm91dCBcIiR7cGFyYW1zLnF1ZXJ5fVwiLi4uYCB9XSwgZGV0YWlsczogdW5kZWZpbmVkIGFzIHVua25vd24gfSk7XG5cbiAgICAgIHRyeSB7XG4gICAgICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgICAgICAvLyBQcm92aWRlci1zcGVjaWZpYyBmZXRjaFxuICAgICAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAgICAgbGV0IHJlc3VsdDogQ2FjaGVkTExNQ29udGV4dDtcbiAgICAgICAgbGV0IGxhdGVuY3lNczogbnVtYmVyIHwgdW5kZWZpbmVkO1xuICAgICAgICBsZXQgcmF0ZUxpbWl0OiBSYXRlTGltaXRJbmZvIHwgdW5kZWZpbmVkO1xuXG4gICAgICAgIGlmIChwcm92aWRlciA9PT0gXCJ0YXZpbHlcIikge1xuICAgICAgICAgIGNvbnN0IHRhdmlseVJlc3VsdCA9IGF3YWl0IGV4ZWN1dGVUYXZpbHlMTE1Db250ZXh0KFxuICAgICAgICAgICAgeyBxdWVyeTogcGFyYW1zLnF1ZXJ5LCBtYXhUb2tlbnMsIG1heFVybHMsIHRocmVzaG9sZCwgY291bnQgfSxcbiAgICAgICAgICAgIHNpZ25hbCxcbiAgICAgICAgICApO1xuICAgICAgICAgIHJlc3VsdCA9IHRhdmlseVJlc3VsdC5jYWNoZWQ7XG4gICAgICAgICAgbGF0ZW5jeU1zID0gdGF2aWx5UmVzdWx0LmxhdGVuY3lNcztcbiAgICAgICAgICByYXRlTGltaXQgPSB0YXZpbHlSZXN1bHQucmF0ZUxpbWl0O1xuICAgICAgICB9IGVsc2UgaWYgKHByb3ZpZGVyID09PSBcIm9sbGFtYVwiKSB7XG4gICAgICAgICAgY29uc3Qgb2xsYW1hUmVzdWx0ID0gYXdhaXQgZXhlY3V0ZU9sbGFtYUxMTUNvbnRleHQoXG4gICAgICAgICAgICB7IHF1ZXJ5OiBwYXJhbXMucXVlcnksIG1heFRva2VucywgY291bnQsIHRocmVzaG9sZCB9LFxuICAgICAgICAgICAgc2lnbmFsLFxuICAgICAgICAgICk7XG4gICAgICAgICAgcmVzdWx0ID0gb2xsYW1hUmVzdWx0LmNhY2hlZDtcbiAgICAgICAgICBsYXRlbmN5TXMgPSBvbGxhbWFSZXN1bHQubGF0ZW5jeU1zO1xuICAgICAgICAgIHJhdGVMaW1pdCA9IG9sbGFtYVJlc3VsdC5yYXRlTGltaXQ7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgICAgICAgIC8vIEJSQVZFIFBBVEggKHVuY2hhbmdlZCBBUEkgbG9naWMpXG4gICAgICAgICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgICAgICAgIGNvbnN0IHVybCA9IG5ldyBVUkwoXCJodHRwczovL2FwaS5zZWFyY2guYnJhdmUuY29tL3Jlcy92MS9sbG0vY29udGV4dFwiKTtcbiAgICAgICAgICB1cmwuc2VhcmNoUGFyYW1zLmFwcGVuZChcInFcIiwgcGFyYW1zLnF1ZXJ5KTtcbiAgICAgICAgICB1cmwuc2VhcmNoUGFyYW1zLmFwcGVuZChcImNvdW50XCIsIFN0cmluZyhjb3VudCkpO1xuICAgICAgICAgIHVybC5zZWFyY2hQYXJhbXMuYXBwZW5kKFwibWF4aW11bV9udW1iZXJfb2ZfdG9rZW5zXCIsIFN0cmluZyhtYXhUb2tlbnMpKTtcbiAgICAgICAgICB1cmwuc2VhcmNoUGFyYW1zLmFwcGVuZChcIm1heGltdW1fbnVtYmVyX29mX3VybHNcIiwgU3RyaW5nKG1heFVybHMpKTtcbiAgICAgICAgICB1cmwuc2VhcmNoUGFyYW1zLmFwcGVuZChcImNvbnRleHRfdGhyZXNob2xkX21vZGVcIiwgdGhyZXNob2xkKTtcblxuICAgICAgICAgIC8vIFVzZSBhIGN1c3RvbSBmZXRjaCBmbG93IHRvIHJlYWQgZXJyb3IgYm9kaWVzIGZyb20gdGhlIEJyYXZlIEFQSVxuICAgICAgICAgIGxldCB0aW1lZDtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgdGltZWQgPSBhd2FpdCBmZXRjaFdpdGhSZXRyeVRpbWVkKHVybC50b1N0cmluZygpLCB7XG4gICAgICAgICAgICAgIG1ldGhvZDogXCJHRVRcIixcbiAgICAgICAgICAgICAgaGVhZGVyczogYnJhdmVIZWFkZXJzKCksXG4gICAgICAgICAgICAgIHNpZ25hbCxcbiAgICAgICAgICAgIH0sIDIpO1xuICAgICAgICAgIH0gY2F0Y2ggKGZldGNoRXJyKSB7XG4gICAgICAgICAgICAvLyBUcnkgdG8gZXh0cmFjdCBCcmF2ZSdzIHN0cnVjdHVyZWQgZXJyb3IgZGV0YWlsIGZyb20gdGhlIHJlc3BvbnNlIGJvZHkuXG4gICAgICAgICAgICAvLyBUaGlzIGlzIGVzcGVjaWFsbHkgdXNlZnVsIGZvciBwbGFuL3N1YnNjcmlwdGlvbiBlcnJvcnMgKE9QVElPTl9OT1RfSU5fUExBTikuXG4gICAgICAgICAgICBsZXQgZXJyb3JNZXNzYWdlOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gICAgICAgICAgICBsZXQgZXJyb3JLaW5kT3ZlcnJpZGU6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICAgICAgICAgIGlmIChmZXRjaEVyciBpbnN0YW5jZW9mIEh0dHBFcnJvciAmJiBmZXRjaEVyci5yZXNwb25zZSkge1xuICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGNvbnN0IGJvZHkgPSBhd2FpdCBmZXRjaEVyci5yZXNwb25zZS5jbG9uZSgpLmpzb24oKS5jYXRjaCgoKSA9PiBudWxsKTtcbiAgICAgICAgICAgICAgICBpZiAoYm9keT8uZXJyb3I/LmRldGFpbCkge1xuICAgICAgICAgICAgICAgICAgZXJyb3JNZXNzYWdlID0gYm9keS5lcnJvci5kZXRhaWw7XG4gICAgICAgICAgICAgICAgICBpZiAoYm9keS5lcnJvci5jb2RlID09PSBcIk9QVElPTl9OT1RfSU5fUExBTlwiKSB7XG4gICAgICAgICAgICAgICAgICAgIGVycm9yS2luZE92ZXJyaWRlID0gXCJwbGFuX2Vycm9yXCI7XG4gICAgICAgICAgICAgICAgICAgIGVycm9yTWVzc2FnZSA9IGBMTE0gQ29udGV4dCBBUEkgbm90IGF2YWlsYWJsZSBvbiB5b3VyIGN1cnJlbnQgQnJhdmUgcGxhbi4gJHtib2R5LmVycm9yLmRldGFpbH0gVXBncmFkZSBhdCBodHRwczovL2FwaS1kYXNoYm9hcmQuc2VhcmNoLmJyYXZlLmNvbS9hcHAvc3Vic2NyaXB0aW9ucyBcdTIwMTQgb3IgdXNlIHNlYXJjaC10aGUtd2ViICsgZmV0Y2hfcGFnZSBhcyBhbiBhbHRlcm5hdGl2ZS5gO1xuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfSBjYXRjaCB7IC8qIGJvZHkgYWxyZWFkeSBjb25zdW1lZCBvciBwYXJzZSBlcnJvciBcdTIwMTQgdXNlIGdlbmVyaWMgbWVzc2FnZSAqLyB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBjbGFzc2lmaWVkID0gY2xhc3NpZnlFcnJvcihmZXRjaEVycik7XG4gICAgICAgICAgICBjb25zdCBtZXNzYWdlID0gZXJyb3JNZXNzYWdlIHx8IGNsYXNzaWZpZWQubWVzc2FnZTtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgc2VhcmNoX2FuZF9yZWFkIHVuYXZhaWxhYmxlOiAke21lc3NhZ2V9YCB9XSxcbiAgICAgICAgICAgICAgZGV0YWlsczoge1xuICAgICAgICAgICAgICAgIGVycm9yS2luZDogZXJyb3JLaW5kT3ZlcnJpZGUgfHwgY2xhc3NpZmllZC5raW5kLFxuICAgICAgICAgICAgICAgIGVycm9yOiBtZXNzYWdlLFxuICAgICAgICAgICAgICAgIHJldHJ5QWZ0ZXJNczogY2xhc3NpZmllZC5yZXRyeUFmdGVyTXMsXG4gICAgICAgICAgICAgICAgcXVlcnk6IHBhcmFtcy5xdWVyeSxcbiAgICAgICAgICAgICAgICBwcm92aWRlcixcbiAgICAgICAgICAgICAgfSBzYXRpc2ZpZXMgUGFydGlhbDxMTE1Db250ZXh0RGV0YWlscz4sXG4gICAgICAgICAgICAgIGlzRXJyb3I6IHRydWUsXG4gICAgICAgICAgICB9O1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGNvbnN0IGRhdGE6IEJyYXZlTExNQ29udGV4dFJlc3BvbnNlID0gYXdhaXQgdGltZWQucmVzcG9uc2UuanNvbigpO1xuXG4gICAgICAgICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgICAgICAgLy8gTm9ybWFsaXplIEJyYXZlIHJlc3BvbnNlXG4gICAgICAgICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgICAgICAgY29uc3QgZ3JvdW5kaW5nOiBMTE1Db250ZXh0U25pcHBldFtdID0gW107XG5cbiAgICAgICAgICBpZiAoZGF0YS5ncm91bmRpbmc/LmdlbmVyaWMpIHtcbiAgICAgICAgICAgIGZvciAoY29uc3QgaXRlbSBvZiBkYXRhLmdyb3VuZGluZy5nZW5lcmljKSB7XG4gICAgICAgICAgICAgIGlmIChpdGVtLnNuaXBwZXRzICYmIGl0ZW0uc25pcHBldHMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgIGdyb3VuZGluZy5wdXNoKHtcbiAgICAgICAgICAgICAgICAgIHVybDogaXRlbS51cmwsXG4gICAgICAgICAgICAgICAgICB0aXRsZTogaXRlbS50aXRsZSxcbiAgICAgICAgICAgICAgICAgIHNuaXBwZXRzOiBpdGVtLnNuaXBwZXRzLFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gSW5jbHVkZSBQT0kgZGF0YSBpZiBwcmVzZW50XG4gICAgICAgICAgaWYgKGRhdGEuZ3JvdW5kaW5nPy5wb2kgJiYgZGF0YS5ncm91bmRpbmcucG9pLnNuaXBwZXRzPy5sZW5ndGgpIHtcbiAgICAgICAgICAgIGdyb3VuZGluZy5wdXNoKHtcbiAgICAgICAgICAgICAgdXJsOiBkYXRhLmdyb3VuZGluZy5wb2kudXJsLFxuICAgICAgICAgICAgICB0aXRsZTogZGF0YS5ncm91bmRpbmcucG9pLnRpdGxlIHx8IGRhdGEuZ3JvdW5kaW5nLnBvaS5uYW1lLFxuICAgICAgICAgICAgICBzbmlwcGV0czogZGF0YS5ncm91bmRpbmcucG9pLnNuaXBwZXRzLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gSW5jbHVkZSBtYXAgZGF0YSBpZiBwcmVzZW50XG4gICAgICAgICAgaWYgKGRhdGEuZ3JvdW5kaW5nPy5tYXApIHtcbiAgICAgICAgICAgIGZvciAoY29uc3QgaXRlbSBvZiBkYXRhLmdyb3VuZGluZy5tYXApIHtcbiAgICAgICAgICAgICAgaWYgKGl0ZW0uc25pcHBldHM/Lmxlbmd0aCkge1xuICAgICAgICAgICAgICAgIGdyb3VuZGluZy5wdXNoKHtcbiAgICAgICAgICAgICAgICAgIHVybDogaXRlbS51cmwsXG4gICAgICAgICAgICAgICAgICB0aXRsZTogaXRlbS50aXRsZSB8fCBpdGVtLm5hbWUsXG4gICAgICAgICAgICAgICAgICBzbmlwcGV0czogaXRlbS5zbmlwcGV0cyxcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cblxuICAgICAgICAgIGNvbnN0IHNvdXJjZXM6IFJlY29yZDxzdHJpbmcsIExMTUNvbnRleHRTb3VyY2U+ID0ge307XG4gICAgICAgICAgaWYgKGRhdGEuc291cmNlcykge1xuICAgICAgICAgICAgZm9yIChjb25zdCBbc291cmNlVXJsLCBzb3VyY2VJbmZvXSBvZiBPYmplY3QuZW50cmllcyhkYXRhLnNvdXJjZXMpKSB7XG4gICAgICAgICAgICAgIHNvdXJjZXNbc291cmNlVXJsXSA9IHtcbiAgICAgICAgICAgICAgICB0aXRsZTogc291cmNlSW5mby50aXRsZSxcbiAgICAgICAgICAgICAgICBob3N0bmFtZTogc291cmNlSW5mby5ob3N0bmFtZSxcbiAgICAgICAgICAgICAgICBhZ2U6IHNvdXJjZUluZm8uYWdlLFxuICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vIEVzdGltYXRlIHRvdGFsIHRva2VuIGNvdW50IGZyb20gYWxsIHNuaXBwZXRzXG4gICAgICAgICAgY29uc3QgYWxsVGV4dCA9IGdyb3VuZGluZy5tYXAoZyA9PiBnLnNuaXBwZXRzLmpvaW4oXCIgXCIpKS5qb2luKFwiIFwiKTtcbiAgICAgICAgICBjb25zdCBlc3RpbWF0ZWRUb2tlbnMgPSBlc3RpbWF0ZVRva2VucyhhbGxUZXh0KTtcblxuICAgICAgICAgIHJlc3VsdCA9IHsgZ3JvdW5kaW5nLCBzb3VyY2VzLCBlc3RpbWF0ZWRUb2tlbnMgfTtcbiAgICAgICAgICBsYXRlbmN5TXMgPSB0aW1lZC5sYXRlbmN5TXM7XG4gICAgICAgICAgcmF0ZUxpbWl0ID0gdGltZWQucmF0ZUxpbWl0O1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgICAgIC8vIFNoYXJlZCBwb3N0LWZldGNoOiBjYWNoZSwgZm9ybWF0LCB0cnVuY2F0ZSwgcmV0dXJuXG4gICAgICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgICAgICBjb250ZXh0Q2FjaGUuc2V0KGNhY2hlS2V5LCByZXN1bHQpO1xuXG4gICAgICAgIGNvbnN0IG91dHB1dCA9IGZvcm1hdExMTUNvbnRleHQocGFyYW1zLnF1ZXJ5LCByZXN1bHQuZ3JvdW5kaW5nLCByZXN1bHQuc291cmNlcywge1xuICAgICAgICAgIHRva2VuQ291bnQ6IHJlc3VsdC5lc3RpbWF0ZWRUb2tlbnMsXG4gICAgICAgIH0pO1xuXG4gICAgICAgIGNvbnN0IHRydW5jYXRpb24gPSB0cnVuY2F0ZUhlYWQob3V0cHV0LCB7IG1heExpbmVzOiBERUZBVUxUX01BWF9MSU5FUywgbWF4Qnl0ZXM6IERFRkFVTFRfTUFYX0JZVEVTIH0pO1xuICAgICAgICBsZXQgY29udGVudCA9IHRydW5jYXRpb24uY29udGVudDtcblxuICAgICAgICBpZiAodHJ1bmNhdGlvbi50cnVuY2F0ZWQpIHtcbiAgICAgICAgICBjb25zdCB0ZW1wRmlsZSA9IGF3YWl0IChwaSBhcyBhbnkpLndyaXRlVGVtcEZpbGUob3V0cHV0LCB7IHByZWZpeDogXCJsbG0tY29udGV4dC1cIiB9KTtcbiAgICAgICAgICBjb250ZW50ICs9IGBcXG5cXG5bVHJ1bmNhdGVkLiBGdWxsIGNvbnRlbnQ6ICR7dGVtcEZpbGV9XWA7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCB0b3RhbFNuaXBwZXRzID0gcmVzdWx0Lmdyb3VuZGluZy5yZWR1Y2UoKHN1bSwgZykgPT4gc3VtICsgZy5zbmlwcGV0cy5sZW5ndGgsIDApO1xuICAgICAgICBjb25zdCBkZXRhaWxzOiBMTE1Db250ZXh0RGV0YWlscyA9IHtcbiAgICAgICAgICBxdWVyeTogcGFyYW1zLnF1ZXJ5LFxuICAgICAgICAgIHNvdXJjZUNvdW50OiByZXN1bHQuZ3JvdW5kaW5nLmxlbmd0aCxcbiAgICAgICAgICBzbmlwcGV0Q291bnQ6IHRvdGFsU25pcHBldHMsXG4gICAgICAgICAgZXN0aW1hdGVkVG9rZW5zOiByZXN1bHQuZXN0aW1hdGVkVG9rZW5zLFxuICAgICAgICAgIGNhY2hlZDogZmFsc2UsXG4gICAgICAgICAgbGF0ZW5jeU1zLFxuICAgICAgICAgIHJhdGVMaW1pdCxcbiAgICAgICAgICB0aHJlc2hvbGQsXG4gICAgICAgICAgbWF4VG9rZW5zLFxuICAgICAgICAgIHByb3ZpZGVyLFxuICAgICAgICB9O1xuXG4gICAgICAgIHJldHVybiB7IGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBjb250ZW50IH1dLCBkZXRhaWxzIH07XG4gICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBjb25zdCBjbGFzc2lmaWVkID0gY2xhc3NpZnlFcnJvcihlcnJvcik7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBTZWFyY2ggZmFpbGVkOiAke2NsYXNzaWZpZWQubWVzc2FnZX1gIH1dLFxuICAgICAgICAgIGRldGFpbHM6IHtcbiAgICAgICAgICAgIGVycm9yS2luZDogY2xhc3NpZmllZC5raW5kLFxuICAgICAgICAgICAgZXJyb3I6IGNsYXNzaWZpZWQubWVzc2FnZSxcbiAgICAgICAgICAgIHF1ZXJ5OiBwYXJhbXMucXVlcnksXG4gICAgICAgICAgICBwcm92aWRlcixcbiAgICAgICAgICB9IHNhdGlzZmllcyBQYXJ0aWFsPExMTUNvbnRleHREZXRhaWxzPixcbiAgICAgICAgICBpc0Vycm9yOiB0cnVlLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgIH0sXG5cbiAgICByZW5kZXJDYWxsKGFyZ3MsIHRoZW1lKSB7XG4gICAgICBsZXQgdGV4dCA9IHRoZW1lLmZnKFwidG9vbFRpdGxlXCIsIHRoZW1lLmJvbGQoXCJzZWFyY2hfYW5kX3JlYWQgXCIpKTtcbiAgICAgIHRleHQgKz0gdGhlbWUuZmcoXCJtdXRlZFwiLCBgXCIke2FyZ3MucXVlcnl9XCJgKTtcblxuICAgICAgY29uc3QgbWV0YTogc3RyaW5nW10gPSBbXTtcbiAgICAgIGlmIChhcmdzLm1heFRva2VucyAmJiBhcmdzLm1heFRva2VucyAhPT0gODE5MikgbWV0YS5wdXNoKGAkeyhhcmdzLm1heFRva2VucyAvIDEwMDApLnRvRml4ZWQoMCl9ayB0b2tlbnNgKTtcbiAgICAgIGlmIChhcmdzLnRocmVzaG9sZCAmJiBhcmdzLnRocmVzaG9sZCAhPT0gXCJiYWxhbmNlZFwiKSBtZXRhLnB1c2goYHRocmVzaG9sZDoke2FyZ3MudGhyZXNob2xkfWApO1xuICAgICAgaWYgKGFyZ3MubWF4VXJscyAmJiBhcmdzLm1heFVybHMgIT09IDEwKSBtZXRhLnB1c2goYCR7YXJncy5tYXhVcmxzfSB1cmxzYCk7XG4gICAgICBpZiAobWV0YS5sZW5ndGggPiAwKSB7XG4gICAgICAgIHRleHQgKz0gXCIgXCIgKyB0aGVtZS5mZyhcImRpbVwiLCBgKCR7bWV0YS5qb2luKFwiLCBcIil9KWApO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gbmV3IFRleHQodGV4dCwgMCwgMCk7XG4gICAgfSxcblxuICAgIHJlbmRlclJlc3VsdChyZXN1bHQsIHsgZXhwYW5kZWQgfSwgdGhlbWUpIHtcbiAgICAgIGNvbnN0IGRldGFpbHMgPSByZXN1bHQuZGV0YWlscyBhcyBMTE1Db250ZXh0RGV0YWlscyB8IHVuZGVmaW5lZDtcbiAgICAgIGlmIChkZXRhaWxzPy5lcnJvcktpbmQgfHwgZGV0YWlscz8uZXJyb3IpIHtcbiAgICAgICAgY29uc3Qga2luZFRhZyA9IGRldGFpbHMuZXJyb3JLaW5kID8gdGhlbWUuZmcoXCJkaW1cIiwgYCBbJHtkZXRhaWxzLmVycm9yS2luZH1dYCkgOiBcIlwiO1xuICAgICAgICByZXR1cm4gbmV3IFRleHQodGhlbWUuZmcoXCJlcnJvclwiLCBgXHUyNzE3ICR7ZGV0YWlscy5lcnJvciA/PyBcIlNlYXJjaCBmYWlsZWRcIn1gKSArIGtpbmRUYWcsIDAsIDApO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBwcm92aWRlclRhZyA9IGRldGFpbHM/LnByb3ZpZGVyID8gdGhlbWUuZmcoXCJkaW1cIiwgYCBbJHtkZXRhaWxzLnByb3ZpZGVyfV1gKSA6IFwiXCI7XG4gICAgICBjb25zdCBjYWNoZVRhZyA9IGRldGFpbHM/LmNhY2hlZCA/IHRoZW1lLmZnKFwiZGltXCIsIFwiIFtjYWNoZWRdXCIpIDogXCJcIjtcbiAgICAgIGNvbnN0IGxhdGVuY3lUYWcgPSBkZXRhaWxzPy5sYXRlbmN5TXMgPyB0aGVtZS5mZyhcImRpbVwiLCBgICR7ZGV0YWlscy5sYXRlbmN5TXN9bXNgKSA6IFwiXCI7XG4gICAgICBjb25zdCB0b2tlblRhZyA9IGRldGFpbHM/LmVzdGltYXRlZFRva2Vuc1xuICAgICAgICA/IHRoZW1lLmZnKFwiZGltXCIsIGAgfiR7KGRldGFpbHMuZXN0aW1hdGVkVG9rZW5zIC8gMTAwMCkudG9GaXhlZCgxKX1rIHRva2Vuc2ApXG4gICAgICAgIDogXCJcIjtcblxuICAgICAgbGV0IHRleHQgPSB0aGVtZS5mZyhcInN1Y2Nlc3NcIixcbiAgICAgICAgYFx1MjcxMyAke2RldGFpbHM/LnNvdXJjZUNvdW50ID8/IDB9IHNvdXJjZXMsICR7ZGV0YWlscz8uc25pcHBldENvdW50ID8/IDB9IHNuaXBwZXRzIGZvciBcIiR7ZGV0YWlscz8ucXVlcnl9XCJgKSArXG4gICAgICAgIHByb3ZpZGVyVGFnICsgdG9rZW5UYWcgKyBjYWNoZVRhZyArIGxhdGVuY3lUYWc7XG5cbiAgICAgIGlmIChleHBhbmRlZCAmJiByZXN1bHQuY29udGVudFswXT8udHlwZSA9PT0gXCJ0ZXh0XCIpIHtcbiAgICAgICAgY29uc3QgcHJldmlldyA9IHJlc3VsdC5jb250ZW50WzBdLnRleHQuc3BsaXQoXCJcXG5cIikuc2xpY2UoMCwgMTApLmpvaW4oXCJcXG5cIik7XG4gICAgICAgIHRleHQgKz0gXCJcXG5cXG5cIiArIHRoZW1lLmZnKFwiZGltXCIsIHByZXZpZXcpO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gbmV3IFRleHQodGV4dCwgMCwgMCk7XG4gICAgfSxcbiAgfSk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFrQkEsU0FBUyxjQUFjLG1CQUFtQix5QkFBeUI7QUFDbkUsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsWUFBWTtBQUNyQixTQUFTLGtCQUFrQjtBQUUzQixTQUFTLG1CQUFtQjtBQUM1QixTQUFTLHFCQUFxQixXQUFXLHFCQUF5QztBQUNsRixTQUFTLGdCQUFnQixxQkFBcUI7QUFDOUMsU0FBUyx3QkFBdUU7QUFFaEYsU0FBUywwQkFBMEI7QUFDbkMsU0FBUyxpQkFBaUIsaUJBQWlDLGNBQWMsNkJBQTZCO0FBNER0RyxNQUFNLGVBQWUsSUFBSSxZQUE4QixFQUFFLEtBQUssSUFBSSxPQUFPLElBQVEsQ0FBQztBQUNsRixhQUFhLG1CQUFtQixHQUFNO0FBT3RDLFNBQVMsZUFBZSxNQUFzQjtBQUM1QyxTQUFPLEtBQUssS0FB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
