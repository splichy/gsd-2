import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead
} from "@gsd/pi-coding-agent";
import { Text } from "@gsd/pi-tui";
import { Type } from "@sinclair/typebox";
let client = null;
async function getClient() {
  if (!client) {
    const { GoogleGenAI } = await import("@google/genai");
    client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return client;
}
async function searchWithOAuth(query, accessToken, projectId, signal) {
  const model = process.env.GEMINI_SEARCH_MODEL || "gemini-2.5-flash";
  const url = `https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse`;
  const GEMINI_CLI_HEADERS = {
    ideType: "IDE_UNSPECIFIED",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI"
  };
  const executeFetch = async (retries = 3) => {
    const response2 = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": "google-cloud-sdk vscode_cloudshelleditor/0.1",
        "X-Goog-Api-Client": "gl-node/22.17.0",
        "Client-Metadata": JSON.stringify(GEMINI_CLI_HEADERS)
      },
      body: JSON.stringify({
        project: projectId,
        model,
        request: {
          contents: [{ parts: [{ text: query }] }],
          tools: [{ googleSearch: {} }]
        },
        userAgent: "pi-coding-agent"
      }),
      signal
    });
    if (!response2.ok && retries > 0 && (response2.status === 429 || response2.status >= 500)) {
      await new Promise((resolve) => setTimeout(resolve, 1e3 * (4 - retries)));
      return executeFetch(retries - 1);
    }
    return response2;
  };
  const response = await executeFetch();
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Cloud Code Assist API error (${response.status}): ${errorText}`);
  }
  const text = await response.text();
  const jsonLines = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter((l) => l.length > 0);
  let data;
  if (jsonLines.length > 0) {
    data = JSON.parse(jsonLines[jsonLines.length - 1]);
  } else {
    data = JSON.parse(text);
  }
  const candidate = data.response?.candidates?.[0];
  const answer = candidate?.content?.parts?.find((p) => p.text)?.text ?? "";
  const grounding = candidate?.groundingMetadata;
  const sources = [];
  const seenTitles = /* @__PURE__ */ new Set();
  if (grounding?.groundingChunks) {
    for (const chunk of grounding.groundingChunks) {
      if (chunk.web) {
        const title = chunk.web.title ?? "Untitled";
        if (seenTitles.has(title)) continue;
        seenTitles.add(title);
        const domain = chunk.web.domain ?? title;
        sources.push({
          title,
          uri: chunk.web.uri ?? "",
          domain
        });
      }
    }
  }
  const searchQueries = grounding?.webSearchQueries ?? [];
  return { answer, sources, searchQueries, cached: false };
}
const resultCache = /* @__PURE__ */ new Map();
function cacheKey(query) {
  return query.toLowerCase().trim();
}
function google_search_default(pi) {
  pi.registerTool({
    name: "google_search",
    label: "Google Search",
    description: "Search the web using Google Search via Gemini. Returns an AI-synthesized answer grounded in Google Search results, plus source URLs. Use this when you need current information from the web: recent events, documentation, product details, technical references, news, etc. Requires GEMINI_API_KEY or Google login. Alternative to Brave-based search tools.",
    promptSnippet: "Search the web via Google Search to get current information with sources",
    promptGuidelines: [
      "Use google_search when you need up-to-date web information that isn't in your training data.",
      "Be specific with queries for better results, e.g. 'Next.js 15 app router migration guide' not just 'Next.js'.",
      "The tool returns both an answer and source URLs. Cite sources when sharing results with the user.",
      "Results are cached per-session, so repeated identical queries are free.",
      "You can still use fetch_page to read a specific URL if needed after getting results from google_search."
    ],
    parameters: Type.Object({
      query: Type.String({
        description: "The search query, e.g. 'latest Node.js LTS version' or 'how to configure Tailwind v4'"
      }),
      maxSources: Type.Optional(
        Type.Number({
          description: "Maximum number of source URLs to include (default 5, max 10).",
          minimum: 1,
          maximum: 10
        })
      )
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const startTime = Date.now();
      const maxSources = Math.min(Math.max(params.maxSources ?? 5, 1), 10);
      let oauthToken;
      let projectId;
      if (!process.env.GEMINI_API_KEY) {
        const oauthRaw = await ctx.modelRegistry.getApiKeyForProvider("google-gemini-cli");
        if (oauthRaw) {
          try {
            const parsed = JSON.parse(oauthRaw);
            oauthToken = parsed.token;
            projectId = parsed.projectId;
          } catch {
          }
        }
      }
      if (!process.env.GEMINI_API_KEY && (!oauthToken || !projectId)) {
        return {
          content: [
            {
              type: "text",
              text: "Error: No authentication found for Google Search. Please set GEMINI_API_KEY or log in via Google.\n\nExample: export GEMINI_API_KEY=your_key or use /login google"
            }
          ],
          isError: true,
          details: {
            query: params.query,
            sourceCount: 0,
            cached: false,
            durationMs: Date.now() - startTime,
            error: "auth_error: No credentials set"
          }
        };
      }
      const key = cacheKey(params.query);
      if (resultCache.has(key)) {
        const cached = resultCache.get(key);
        const output = formatOutput(cached, maxSources);
        return {
          content: [{ type: "text", text: output }],
          details: {
            query: params.query,
            sourceCount: cached.sources.length,
            cached: true,
            durationMs: Date.now() - startTime
          }
        };
      }
      let result;
      try {
        if (process.env.GEMINI_API_KEY) {
          const ai = await getClient();
          const timeoutController = new AbortController();
          const timeoutId = setTimeout(() => timeoutController.abort(), 3e4);
          const combinedSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
          let response;
          try {
            response = await ai.models.generateContent({
              model: process.env.GEMINI_SEARCH_MODEL || "gemini-2.5-flash",
              contents: params.query,
              config: {
                tools: [{ googleSearch: {} }],
                abortSignal: combinedSignal
              }
            });
          } finally {
            clearTimeout(timeoutId);
          }
          const answer = response.text ?? "";
          const candidate = response.candidates?.[0];
          const grounding = candidate?.groundingMetadata;
          const sources = [];
          const seenTitles = /* @__PURE__ */ new Set();
          if (grounding?.groundingChunks) {
            for (const chunk of grounding.groundingChunks) {
              if (chunk.web) {
                const title = chunk.web.title ?? "Untitled";
                if (seenTitles.has(title)) continue;
                seenTitles.add(title);
                const domain = chunk.web.domain ?? title;
                sources.push({
                  title,
                  uri: chunk.web.uri ?? "",
                  domain
                });
              }
            }
          }
          const searchQueries = grounding?.webSearchQueries ?? [];
          result = { answer, sources, searchQueries, cached: false };
        } else {
          result = await searchWithOAuth(params.query, oauthToken, projectId, signal);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        let errorType = "api_error";
        if (msg.includes("401") || msg.includes("UNAUTHENTICATED")) {
          errorType = "auth_error";
        } else if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("quota")) {
          errorType = "rate_limit";
        }
        return {
          content: [
            {
              type: "text",
              text: `Google Search failed (${errorType}): ${msg}`
            }
          ],
          isError: true,
          details: {
            query: params.query,
            sourceCount: 0,
            cached: false,
            durationMs: Date.now() - startTime,
            error: `${errorType}: ${msg}`
          }
        };
      }
      resultCache.set(key, result);
      const rawOutput = formatOutput(result, maxSources);
      const truncation = truncateHead(rawOutput, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES
      });
      let finalText = truncation.content;
      if (truncation.truncated) {
        finalText += `

[Truncated: showing ${truncation.outputLines}/${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
      }
      return {
        content: [{ type: "text", text: finalText }],
        details: {
          query: params.query,
          sourceCount: result.sources.length,
          cached: false,
          durationMs: Date.now() - startTime
        }
      };
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("google_search "));
      text += theme.fg("accent", `"${args.query}"`);
      return new Text(text, 0, 0);
    },
    renderResult(result, { isPartial, expanded }, theme) {
      const d = result.details;
      if (isPartial) return new Text(theme.fg("warning", "Searching Google..."), 0, 0);
      if (result.isError || d?.error) {
        return new Text(theme.fg("error", `Error: ${d?.error ?? "unknown"}`), 0, 0);
      }
      let text = theme.fg("success", `${d?.sourceCount ?? 0} sources`);
      text += theme.fg("dim", ` (${d?.durationMs ?? 0}ms)`);
      if (d?.cached) text += theme.fg("dim", " \xB7 cached");
      if (expanded) {
        const content = result.content[0];
        if (content?.type === "text") {
          const preview = content.text.split("\n").slice(0, 8).join("\n");
          text += "\n\n" + theme.fg("dim", preview);
          if (content.text.split("\n").length > 8) {
            text += "\n" + theme.fg("muted", "...");
          }
        }
      }
      return new Text(text, 0, 0);
    }
  });
  pi.on("session_shutdown", async () => {
    resultCache.clear();
    client = null;
  });
  pi.on("session_start", async (_event, ctx) => {
    if (process.env.GEMINI_API_KEY) return;
    const hasOAuth = await ctx.modelRegistry.authStorage.hasAuth("google-gemini-cli");
    if (!hasOAuth) {
      ctx.ui.notify(
        "Google Search: No authentication set. Log in via Google or set GEMINI_API_KEY to use google_search.",
        "warning"
      );
    }
  });
}
function formatOutput(result, maxSources) {
  const lines = [];
  if (result.answer) {
    lines.push(result.answer);
  } else {
    lines.push("(No answer text returned from search)");
  }
  if (result.sources.length > 0) {
    lines.push("");
    lines.push("Sources:");
    const sourcesToShow = result.sources.slice(0, maxSources);
    for (let i = 0; i < sourcesToShow.length; i++) {
      const s = sourcesToShow[i];
      lines.push(`[${i + 1}] ${s.title} - ${s.domain}`);
      lines.push(`    ${s.uri}`);
    }
    if (result.sources.length > maxSources) {
      lines.push(`(${result.sources.length - maxSources} more sources omitted)`);
    }
  } else {
    lines.push("");
    lines.push("(No source URLs found in grounding metadata)");
  }
  if (result.searchQueries.length > 0) {
    lines.push("");
    lines.push(`Searches performed: ${result.searchQueries.map((q) => `"${q}"`).join(", ")}`);
  }
  return lines.join("\n");
}
export {
  google_search_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vZXh0ZW5zaW9ucy9nb29nbGUtc2VhcmNoL2luZGV4LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIEdvb2dsZSBTZWFyY2ggRXh0ZW5zaW9uXG4gKlxuICogUHJvdmlkZXMgYSBgZ29vZ2xlX3NlYXJjaGAgdG9vbCB0aGF0IHBlcmZvcm1zIHdlYiBzZWFyY2hlcyB2aWEgR2VtaW5pJ3NcbiAqIEdvb2dsZSBTZWFyY2ggZ3JvdW5kaW5nIGZlYXR1cmUuIFVzZXMgdGhlIHVzZXIncyBleGlzdGluZyBHRU1JTklfQVBJX0tFWVxuICogYW5kIEdvb2dsZSBDbG91ZCBHZW5BSSBjcmVkaXRzLlxuICpcbiAqIFRoZSB0b29sIHNlbmRzIHF1ZXJpZXMgdG8gR2VtaW5pIEZsYXNoIHdpdGggYGdvb2dsZVNlYXJjaDoge31gIGVuYWJsZWQuXG4gKiBHZW1pbmkgaW50ZXJuYWxseSBwZXJmb3JtcyBHb29nbGUgc2VhcmNoZXMsIHN5bnRoZXNpemVzIGFuIGFuc3dlciwgYW5kXG4gKiByZXR1cm5zIGl0IHdpdGggc291cmNlIFVSTHMgZnJvbSBncm91bmRpbmcgbWV0YWRhdGEuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBFeHRlbnNpb25BUEkgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7XG5cdERFRkFVTFRfTUFYX0JZVEVTLFxuXHRERUZBVUxUX01BWF9MSU5FUyxcblx0Zm9ybWF0U2l6ZSxcblx0dHJ1bmNhdGVIZWFkLFxufSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7IFRleHQgfSBmcm9tIFwiQGdzZC9waS10dWlcIjtcbmltcG9ydCB7IFR5cGUgfSBmcm9tIFwiQHNpbmNsYWlyL3R5cGVib3hcIjtcblxuLy8gXHUyNTAwXHUyNTAwIFR5cGVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5pbnRlcmZhY2UgU2VhcmNoU291cmNlIHtcblx0dGl0bGU6IHN0cmluZztcblx0dXJpOiBzdHJpbmc7XG5cdGRvbWFpbjogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgU2VhcmNoUmVzdWx0IHtcblx0YW5zd2VyOiBzdHJpbmc7XG5cdHNvdXJjZXM6IFNlYXJjaFNvdXJjZVtdO1xuXHRzZWFyY2hRdWVyaWVzOiBzdHJpbmdbXTtcblx0Y2FjaGVkOiBib29sZWFuO1xufVxuXG5pbnRlcmZhY2UgU2VhcmNoRGV0YWlscyB7XG5cdHF1ZXJ5OiBzdHJpbmc7XG5cdHNvdXJjZUNvdW50OiBudW1iZXI7XG5cdGNhY2hlZDogYm9vbGVhbjtcblx0ZHVyYXRpb25NczogbnVtYmVyO1xuXHRlcnJvcj86IHN0cmluZztcbn1cblxuLy8gXHUyNTAwXHUyNTAwIExhenkgc2luZ2xldG9uIGNsaWVudCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudHlwZSBHb29nbGVHZW5BSUNsaWVudCA9IHtcblx0bW9kZWxzOiB7XG5cdFx0Z2VuZXJhdGVDb250ZW50OiAoYXJnczoge1xuXHRcdFx0bW9kZWw6IHN0cmluZztcblx0XHRcdGNvbnRlbnRzOiBzdHJpbmc7XG5cdFx0XHRjb25maWc/OiB7XG5cdFx0XHRcdHRvb2xzPzogQXJyYXk8eyBnb29nbGVTZWFyY2g6IFJlY29yZDxzdHJpbmcsIG5ldmVyPiB9Pjtcblx0XHRcdFx0YWJvcnRTaWduYWw/OiBBYm9ydFNpZ25hbDtcblx0XHRcdH07XG5cdFx0fSkgPT4gUHJvbWlzZTxhbnk+O1xuXHR9O1xufTtcblxubGV0IGNsaWVudDogR29vZ2xlR2VuQUlDbGllbnQgfCBudWxsID0gbnVsbDtcblxuYXN5bmMgZnVuY3Rpb24gZ2V0Q2xpZW50KCk6IFByb21pc2U8R29vZ2xlR2VuQUlDbGllbnQ+IHtcblx0aWYgKCFjbGllbnQpIHtcblx0XHRjb25zdCB7IEdvb2dsZUdlbkFJIH0gPSBhd2FpdCBpbXBvcnQoXCJAZ29vZ2xlL2dlbmFpXCIpO1xuXHRcdGNsaWVudCA9IG5ldyBHb29nbGVHZW5BSSh7IGFwaUtleTogcHJvY2Vzcy5lbnYuR0VNSU5JX0FQSV9LRVkhIH0pO1xuXHR9XG5cdHJldHVybiBjbGllbnQ7XG59XG5cbi8qKlxuICogUGVyZm9ybSBhIHNlYXJjaCB1c2luZyBPQXV0aCBjcmVkZW50aWFscyB2aWEgdGhlIENsb3VkIENvZGUgQXNzaXN0IEFQSS5cbiAqIFRoaXMgaXMgdXNlZCBhcyBhIGZhbGxiYWNrIHdoZW4gR0VNSU5JX0FQSV9LRVkgaXMgbm90IHNldC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gc2VhcmNoV2l0aE9BdXRoKFxuXHRxdWVyeTogc3RyaW5nLFxuXHRhY2Nlc3NUb2tlbjogc3RyaW5nLFxuXHRwcm9qZWN0SWQ6IHN0cmluZyxcblx0c2lnbmFsPzogQWJvcnRTaWduYWwsXG4pOiBQcm9taXNlPFNlYXJjaFJlc3VsdD4ge1xuXHRjb25zdCBtb2RlbCA9IHByb2Nlc3MuZW52LkdFTUlOSV9TRUFSQ0hfTU9ERUwgfHwgXCJnZW1pbmktMi41LWZsYXNoXCI7XG5cdGNvbnN0IHVybCA9IGBodHRwczovL2Nsb3VkY29kZS1wYS5nb29nbGVhcGlzLmNvbS92MWludGVybmFsOnN0cmVhbUdlbmVyYXRlQ29udGVudD9hbHQ9c3NlYDtcblxuXHRjb25zdCBHRU1JTklfQ0xJX0hFQURFUlMgPSB7XG5cdCAgICAgICAgaWRlVHlwZTogXCJJREVfVU5TUEVDSUZJRURcIixcblx0ICAgICAgICBwbGF0Zm9ybTogXCJQTEFURk9STV9VTlNQRUNJRklFRFwiLFxuXHQgICAgICAgIHBsdWdpblR5cGU6IFwiR0VNSU5JXCIsXG5cdH07XG5cblx0Y29uc3QgZXhlY3V0ZUZldGNoID0gYXN5bmMgKHJldHJpZXMgPSAzKTogUHJvbWlzZTxSZXNwb25zZT4gPT4ge1xuXHQgICAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2godXJsLCB7XG5cdCAgICAgICAgICAgICAgICBtZXRob2Q6IFwiUE9TVFwiLFxuXHQgICAgICAgICAgICAgICAgaGVhZGVyczoge1xuXHQgICAgICAgICAgICAgICAgICAgICAgICBBdXRob3JpemF0aW9uOiBgQmVhcmVyICR7YWNjZXNzVG9rZW59YCxcblx0ICAgICAgICAgICAgICAgICAgICAgICAgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIsXG5cdCAgICAgICAgICAgICAgICAgICAgICAgIFwiVXNlci1BZ2VudFwiOiBcImdvb2dsZS1jbG91ZC1zZGsgdnNjb2RlX2Nsb3Vkc2hlbGxlZGl0b3IvMC4xXCIsXG5cdCAgICAgICAgICAgICAgICAgICAgICAgIFwiWC1Hb29nLUFwaS1DbGllbnRcIjogXCJnbC1ub2RlLzIyLjE3LjBcIixcblx0ICAgICAgICAgICAgICAgICAgICAgICAgXCJDbGllbnQtTWV0YWRhdGFcIjogSlNPTi5zdHJpbmdpZnkoR0VNSU5JX0NMSV9IRUFERVJTKSxcblx0ICAgICAgICAgICAgICAgIH0sXG5cdCAgICAgICAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG5cdCAgICAgICAgICAgICAgICAgICAgICAgIHByb2plY3Q6IHByb2plY3RJZCxcblx0ICAgICAgICAgICAgICAgICAgICAgICAgbW9kZWwsXG5cdCAgICAgICAgICAgICAgICAgICAgICAgIHJlcXVlc3Q6IHtcblx0ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb250ZW50czogW3sgcGFydHM6IFt7IHRleHQ6IHF1ZXJ5IH1dIH1dLFxuXHQgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRvb2xzOiBbeyBnb29nbGVTZWFyY2g6IHt9IH1dLFxuXHQgICAgICAgICAgICAgICAgICAgICAgICB9LFxuXHQgICAgICAgICAgICAgICAgICAgICAgICB1c2VyQWdlbnQ6IFwicGktY29kaW5nLWFnZW50XCIsXG5cdCAgICAgICAgICAgICAgICB9KSxcblx0ICAgICAgICAgICAgICAgIHNpZ25hbCxcblx0ICAgICAgICB9KTtcblxuXHQgICAgICAgIGlmICghcmVzcG9uc2Uub2sgJiYgcmV0cmllcyA+IDAgJiYgKHJlc3BvbnNlLnN0YXR1cyA9PT0gNDI5IHx8IHJlc3BvbnNlLnN0YXR1cyA+PSA1MDApKSB7XG5cdCAgICAgICAgICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4gc2V0VGltZW91dChyZXNvbHZlLCAxMDAwICogKDQgLSByZXRyaWVzKSkpO1xuXHQgICAgICAgICAgICAgICAgcmV0dXJuIGV4ZWN1dGVGZXRjaChyZXRyaWVzIC0gMSk7XG5cdCAgICAgICAgfVxuXG5cdCAgICAgICAgcmV0dXJuIHJlc3BvbnNlO1xuXHR9O1xuXG5cdGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZXhlY3V0ZUZldGNoKCk7XG5cblx0aWYgKCFyZXNwb25zZS5vaykge1xuXHQgICAgICAgIGNvbnN0IGVycm9yVGV4dCA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKTtcblx0ICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENsb3VkIENvZGUgQXNzaXN0IEFQSSBlcnJvciAoJHtyZXNwb25zZS5zdGF0dXN9KTogJHtlcnJvclRleHR9YCk7XG5cdH1cblxuXHQvLyBOb3RlOiBzdHJlYW1HZW5lcmF0ZUNvbnRlbnQgcmV0dXJucyBTU0U7IGZvciBub3csIHdlIGNvbnN1bWUgYWxsIGNodW5rcy5cblx0Ly8gRm9yIHNpbXBsaWNpdHkgYW5kIHRvIG1hdGNoIHRoZSBwcmV2aW91cyBzdHJ1Y3R1cmUsIHdlJ2xsIHJlYWQgdG8gZW5kLlxuXHRjb25zdCB0ZXh0ID0gYXdhaXQgcmVzcG9uc2UudGV4dCgpO1xuXHRjb25zdCBqc29uTGluZXMgPSB0ZXh0LnNwbGl0KFwiXFxuXCIpXG5cdCAgICAgICAgLmZpbHRlcihsID0+IGwuc3RhcnRzV2l0aChcImRhdGE6XCIpKVxuXHQgICAgICAgIC5tYXAobCA9PiBsLnNsaWNlKDUpLnRyaW0oKSlcblx0ICAgICAgICAuZmlsdGVyKGwgPT4gbC5sZW5ndGggPiAwKTtcblxuXHRsZXQgZGF0YTtcblx0aWYgKGpzb25MaW5lcy5sZW5ndGggPiAwKSB7XG5cdCAgICAvLyBBZ2dyZWdhdGUgY2h1bmtzIGlmIG5lZWRlZCwgYnV0IGZvciBub3cgd2UgdGFrZSB0aGUgbGFzdCBjaHVuayBvciBhc3N1bWUgaXQncyBvbmVcblx0ICAgIGRhdGEgPSBKU09OLnBhcnNlKGpzb25MaW5lc1tqc29uTGluZXMubGVuZ3RoIC0gMV0pO1xuXHR9IGVsc2Uge1xuXHQgICAgZGF0YSA9IEpTT04ucGFyc2UodGV4dCk7XG5cdH1cdGNvbnN0IGNhbmRpZGF0ZSA9IGRhdGEucmVzcG9uc2U/LmNhbmRpZGF0ZXM/LlswXTtcblx0Y29uc3QgYW5zd2VyID0gY2FuZGlkYXRlPy5jb250ZW50Py5wYXJ0cz8uZmluZCgocDogYW55KSA9PiBwLnRleHQpPy50ZXh0ID8/IFwiXCI7XG5cdGNvbnN0IGdyb3VuZGluZyA9IGNhbmRpZGF0ZT8uZ3JvdW5kaW5nTWV0YWRhdGE7XG5cblx0Y29uc3Qgc291cmNlczogU2VhcmNoU291cmNlW10gPSBbXTtcblx0Y29uc3Qgc2VlblRpdGxlcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXHRpZiAoZ3JvdW5kaW5nPy5ncm91bmRpbmdDaHVua3MpIHtcblx0XHRmb3IgKGNvbnN0IGNodW5rIG9mIGdyb3VuZGluZy5ncm91bmRpbmdDaHVua3MpIHtcblx0XHRcdGlmIChjaHVuay53ZWIpIHtcblx0XHRcdFx0Y29uc3QgdGl0bGUgPSBjaHVuay53ZWIudGl0bGUgPz8gXCJVbnRpdGxlZFwiO1xuXHRcdFx0XHRpZiAoc2VlblRpdGxlcy5oYXModGl0bGUpKSBjb250aW51ZTtcblx0XHRcdFx0c2VlblRpdGxlcy5hZGQodGl0bGUpO1xuXHRcdFx0XHRjb25zdCBkb21haW4gPSBjaHVuay53ZWIuZG9tYWluID8/IHRpdGxlO1xuXHRcdFx0XHRzb3VyY2VzLnB1c2goe1xuXHRcdFx0XHRcdHRpdGxlLFxuXHRcdFx0XHRcdHVyaTogY2h1bmsud2ViLnVyaSA/PyBcIlwiLFxuXHRcdFx0XHRcdGRvbWFpbixcblx0XHRcdFx0fSk7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG5cblx0Y29uc3Qgc2VhcmNoUXVlcmllcyA9IGdyb3VuZGluZz8ud2ViU2VhcmNoUXVlcmllcyA/PyBbXTtcblx0cmV0dXJuIHsgYW5zd2VyLCBzb3VyY2VzLCBzZWFyY2hRdWVyaWVzLCBjYWNoZWQ6IGZhbHNlIH07XG59XG5cbi8vIFx1MjUwMFx1MjUwMCBJbi1zZXNzaW9uIGNhY2hlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5jb25zdCByZXN1bHRDYWNoZSA9IG5ldyBNYXA8c3RyaW5nLCBTZWFyY2hSZXN1bHQ+KCk7XG5cbmZ1bmN0aW9uIGNhY2hlS2V5KHF1ZXJ5OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRyZXR1cm4gcXVlcnkudG9Mb3dlckNhc2UoKS50cmltKCk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMCBFeHRlbnNpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBkZWZhdWx0IGZ1bmN0aW9uIChwaTogRXh0ZW5zaW9uQVBJKSB7XG5cdHBpLnJlZ2lzdGVyVG9vbCh7XG5cdFx0bmFtZTogXCJnb29nbGVfc2VhcmNoXCIsXG5cdFx0bGFiZWw6IFwiR29vZ2xlIFNlYXJjaFwiLFxuXHRcdGRlc2NyaXB0aW9uOlxuXHRcdFx0XCJTZWFyY2ggdGhlIHdlYiB1c2luZyBHb29nbGUgU2VhcmNoIHZpYSBHZW1pbmkuIFwiICtcblx0XHRcdFwiUmV0dXJucyBhbiBBSS1zeW50aGVzaXplZCBhbnN3ZXIgZ3JvdW5kZWQgaW4gR29vZ2xlIFNlYXJjaCByZXN1bHRzLCBwbHVzIHNvdXJjZSBVUkxzLiBcIiArXG5cdFx0XHRcIlVzZSB0aGlzIHdoZW4geW91IG5lZWQgY3VycmVudCBpbmZvcm1hdGlvbiBmcm9tIHRoZSB3ZWI6IHJlY2VudCBldmVudHMsIGRvY3VtZW50YXRpb24sIFwiICtcblx0XHRcdFwicHJvZHVjdCBkZXRhaWxzLCB0ZWNobmljYWwgcmVmZXJlbmNlcywgbmV3cywgZXRjLiBcIiArXG5cdFx0XHRcIlJlcXVpcmVzIEdFTUlOSV9BUElfS0VZIG9yIEdvb2dsZSBsb2dpbi4gQWx0ZXJuYXRpdmUgdG8gQnJhdmUtYmFzZWQgc2VhcmNoIHRvb2xzLlwiLFxuXHRcdHByb21wdFNuaXBwZXQ6IFwiU2VhcmNoIHRoZSB3ZWIgdmlhIEdvb2dsZSBTZWFyY2ggdG8gZ2V0IGN1cnJlbnQgaW5mb3JtYXRpb24gd2l0aCBzb3VyY2VzXCIsXG5cdFx0cHJvbXB0R3VpZGVsaW5lczogW1xuXHRcdFx0XCJVc2UgZ29vZ2xlX3NlYXJjaCB3aGVuIHlvdSBuZWVkIHVwLXRvLWRhdGUgd2ViIGluZm9ybWF0aW9uIHRoYXQgaXNuJ3QgaW4geW91ciB0cmFpbmluZyBkYXRhLlwiLFxuXHRcdFx0XCJCZSBzcGVjaWZpYyB3aXRoIHF1ZXJpZXMgZm9yIGJldHRlciByZXN1bHRzLCBlLmcuICdOZXh0LmpzIDE1IGFwcCByb3V0ZXIgbWlncmF0aW9uIGd1aWRlJyBub3QganVzdCAnTmV4dC5qcycuXCIsXG5cdFx0XHRcIlRoZSB0b29sIHJldHVybnMgYm90aCBhbiBhbnN3ZXIgYW5kIHNvdXJjZSBVUkxzLiBDaXRlIHNvdXJjZXMgd2hlbiBzaGFyaW5nIHJlc3VsdHMgd2l0aCB0aGUgdXNlci5cIixcblx0XHRcdFwiUmVzdWx0cyBhcmUgY2FjaGVkIHBlci1zZXNzaW9uLCBzbyByZXBlYXRlZCBpZGVudGljYWwgcXVlcmllcyBhcmUgZnJlZS5cIixcblx0XHRcdFwiWW91IGNhbiBzdGlsbCB1c2UgZmV0Y2hfcGFnZSB0byByZWFkIGEgc3BlY2lmaWMgVVJMIGlmIG5lZWRlZCBhZnRlciBnZXR0aW5nIHJlc3VsdHMgZnJvbSBnb29nbGVfc2VhcmNoLlwiLFxuXHRcdF0sXG5cdFx0cGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe1xuXHRcdFx0cXVlcnk6IFR5cGUuU3RyaW5nKHtcblx0XHRcdFx0ZGVzY3JpcHRpb246IFwiVGhlIHNlYXJjaCBxdWVyeSwgZS5nLiAnbGF0ZXN0IE5vZGUuanMgTFRTIHZlcnNpb24nIG9yICdob3cgdG8gY29uZmlndXJlIFRhaWx3aW5kIHY0J1wiLFxuXHRcdFx0fSksXG5cdFx0XHRtYXhTb3VyY2VzOiBUeXBlLk9wdGlvbmFsKFxuXHRcdFx0XHRUeXBlLk51bWJlcih7XG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246IFwiTWF4aW11bSBudW1iZXIgb2Ygc291cmNlIFVSTHMgdG8gaW5jbHVkZSAoZGVmYXVsdCA1LCBtYXggMTApLlwiLFxuXHRcdFx0XHRcdG1pbmltdW06IDEsXG5cdFx0XHRcdFx0bWF4aW11bTogMTAsXG5cdFx0XHRcdH0pLFxuXHRcdFx0KSxcblx0XHR9KSxcblxuXHRcdGFzeW5jIGV4ZWN1dGUoX3Rvb2xDYWxsSWQsIHBhcmFtcywgc2lnbmFsLCBfb25VcGRhdGUsIGN0eCkge1xuXHRcdFx0Y29uc3Qgc3RhcnRUaW1lID0gRGF0ZS5ub3coKTtcblx0XHRcdGNvbnN0IG1heFNvdXJjZXMgPSBNYXRoLm1pbihNYXRoLm1heChwYXJhbXMubWF4U291cmNlcyA/PyA1LCAxKSwgMTApO1xuXG5cdFx0XHQvLyBDaGVjayBmb3IgY3JlZGVudGlhbHNcblx0XHRcdGxldCBvYXV0aFRva2VuOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG5cdFx0XHRsZXQgcHJvamVjdElkOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG5cblx0XHRcdGlmICghcHJvY2Vzcy5lbnYuR0VNSU5JX0FQSV9LRVkpIHtcblx0XHRcdFx0Y29uc3Qgb2F1dGhSYXcgPSBhd2FpdCBjdHgubW9kZWxSZWdpc3RyeS5nZXRBcGlLZXlGb3JQcm92aWRlcihcImdvb2dsZS1nZW1pbmktY2xpXCIpO1xuXHRcdFx0XHRpZiAob2F1dGhSYXcpIHtcblx0XHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdFx0Y29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShvYXV0aFJhdyk7XG5cdFx0XHRcdFx0XHRvYXV0aFRva2VuID0gcGFyc2VkLnRva2VuO1xuXHRcdFx0XHRcdFx0cHJvamVjdElkID0gcGFyc2VkLnByb2plY3RJZDtcblx0XHRcdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0XHRcdC8vIEZhbGwgdGhyb3VnaCB0byBlcnJvclxuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHRpZiAoIXByb2Nlc3MuZW52LkdFTUlOSV9BUElfS0VZICYmICghb2F1dGhUb2tlbiB8fCAhcHJvamVjdElkKSkge1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFtcblx0XHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdFx0dHlwZTogXCJ0ZXh0XCIsXG5cdFx0XHRcdFx0XHRcdHRleHQ6IFwiRXJyb3I6IE5vIGF1dGhlbnRpY2F0aW9uIGZvdW5kIGZvciBHb29nbGUgU2VhcmNoLiBQbGVhc2Ugc2V0IEdFTUlOSV9BUElfS0VZIG9yIGxvZyBpbiB2aWEgR29vZ2xlLlxcblxcbkV4YW1wbGU6IGV4cG9ydCBHRU1JTklfQVBJX0tFWT15b3VyX2tleSBvciB1c2UgL2xvZ2luIGdvb2dsZVwiLFxuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRdLFxuXHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsXG5cdFx0XHRcdFx0ZGV0YWlsczoge1xuXHRcdFx0XHRcdFx0cXVlcnk6IHBhcmFtcy5xdWVyeSxcblx0XHRcdFx0XHRcdHNvdXJjZUNvdW50OiAwLFxuXHRcdFx0XHRcdFx0Y2FjaGVkOiBmYWxzZSxcblx0XHRcdFx0XHRcdGR1cmF0aW9uTXM6IERhdGUubm93KCkgLSBzdGFydFRpbWUsXG5cdFx0XHRcdFx0XHRlcnJvcjogXCJhdXRoX2Vycm9yOiBObyBjcmVkZW50aWFscyBzZXRcIixcblx0XHRcdFx0XHR9IGFzIFNlYXJjaERldGFpbHMsXG5cdFx0XHRcdH07XG5cdFx0XHR9XG5cblx0XHRcdC8vIENoZWNrIGNhY2hlXG5cdFx0XHRjb25zdCBrZXkgPSBjYWNoZUtleShwYXJhbXMucXVlcnkpO1xuXHRcdFx0aWYgKHJlc3VsdENhY2hlLmhhcyhrZXkpKSB7XG5cdFx0XHRcdGNvbnN0IGNhY2hlZCA9IHJlc3VsdENhY2hlLmdldChrZXkpITtcblx0XHRcdFx0Y29uc3Qgb3V0cHV0ID0gZm9ybWF0T3V0cHV0KGNhY2hlZCwgbWF4U291cmNlcyk7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IG91dHB1dCB9XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7XG5cdFx0XHRcdFx0XHRxdWVyeTogcGFyYW1zLnF1ZXJ5LFxuXHRcdFx0XHRcdFx0c291cmNlQ291bnQ6IGNhY2hlZC5zb3VyY2VzLmxlbmd0aCxcblx0XHRcdFx0XHRcdGNhY2hlZDogdHJ1ZSxcblx0XHRcdFx0XHRcdGR1cmF0aW9uTXM6IERhdGUubm93KCkgLSBzdGFydFRpbWUsXG5cdFx0XHRcdFx0fSBhcyBTZWFyY2hEZXRhaWxzLFxuXHRcdFx0XHR9O1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBDYWxsIEdlbWluaSB3aXRoIEdvb2dsZSBTZWFyY2ggZ3JvdW5kaW5nXG5cdFx0XHRsZXQgcmVzdWx0OiBTZWFyY2hSZXN1bHQ7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRpZiAocHJvY2Vzcy5lbnYuR0VNSU5JX0FQSV9LRVkpIHtcblx0XHRcdFx0XHRjb25zdCBhaSA9IGF3YWl0IGdldENsaWVudCgpO1xuXG5cdFx0XHRcdFx0Ly8gQWRkIGEgMzAtc2Vjb25kIHRpbWVvdXQgdG8gcHJldmVudCBoYW5naW5nICgjMTEwMClcblx0XHRcdFx0XHRjb25zdCB0aW1lb3V0Q29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcblx0XHRcdFx0XHRjb25zdCB0aW1lb3V0SWQgPSBzZXRUaW1lb3V0KCgpID0+IHRpbWVvdXRDb250cm9sbGVyLmFib3J0KCksIDMwXzAwMCk7XG5cdFx0XHRcdFx0Y29uc3QgY29tYmluZWRTaWduYWwgPSBzaWduYWxcblx0XHRcdFx0XHRcdD8gQWJvcnRTaWduYWwuYW55KFtzaWduYWwsIHRpbWVvdXRDb250cm9sbGVyLnNpZ25hbF0pXG5cdFx0XHRcdFx0XHQ6IHRpbWVvdXRDb250cm9sbGVyLnNpZ25hbDtcblxuXHRcdFx0XHRcdGxldCByZXNwb25zZTtcblx0XHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdFx0cmVzcG9uc2UgPSBhd2FpdCBhaS5tb2RlbHMuZ2VuZXJhdGVDb250ZW50KHtcblx0XHRcdFx0XHRcdFx0bW9kZWw6IHByb2Nlc3MuZW52LkdFTUlOSV9TRUFSQ0hfTU9ERUwgfHwgXCJnZW1pbmktMi41LWZsYXNoXCIsXG5cdFx0XHRcdFx0XHRcdGNvbnRlbnRzOiBwYXJhbXMucXVlcnksXG5cdFx0XHRcdFx0XHRcdGNvbmZpZzoge1xuXHRcdFx0XHRcdFx0XHRcdHRvb2xzOiBbeyBnb29nbGVTZWFyY2g6IHt9IH1dLFxuXHRcdFx0XHRcdFx0XHRcdGFib3J0U2lnbmFsOiBjb21iaW5lZFNpZ25hbCxcblx0XHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdH0gZmluYWxseSB7XG5cdFx0XHRcdFx0XHRjbGVhclRpbWVvdXQodGltZW91dElkKTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHQvLyBFeHRyYWN0IGFuc3dlciB0ZXh0XG5cdFx0XHRcdFx0Y29uc3QgYW5zd2VyID0gcmVzcG9uc2UudGV4dCA/PyBcIlwiO1xuXG5cdFx0XHRcdFx0Ly8gRXh0cmFjdCBncm91bmRpbmcgbWV0YWRhdGFcblx0XHRcdFx0XHRjb25zdCBjYW5kaWRhdGUgPSByZXNwb25zZS5jYW5kaWRhdGVzPy5bMF07XG5cdFx0XHRcdFx0Y29uc3QgZ3JvdW5kaW5nID0gY2FuZGlkYXRlPy5ncm91bmRpbmdNZXRhZGF0YTtcblxuXHRcdFx0XHRcdC8vIFBhcnNlIHNvdXJjZXMgZnJvbSBncm91bmRpbmcgY2h1bmtzXG5cdFx0XHRcdFx0Y29uc3Qgc291cmNlczogU2VhcmNoU291cmNlW10gPSBbXTtcblx0XHRcdFx0XHRjb25zdCBzZWVuVGl0bGVzID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cdFx0XHRcdFx0aWYgKGdyb3VuZGluZz8uZ3JvdW5kaW5nQ2h1bmtzKSB7XG5cdFx0XHRcdFx0XHRmb3IgKGNvbnN0IGNodW5rIG9mIGdyb3VuZGluZy5ncm91bmRpbmdDaHVua3MpIHtcblx0XHRcdFx0XHRcdFx0aWYgKGNodW5rLndlYikge1xuXHRcdFx0XHRcdFx0XHRcdGNvbnN0IHRpdGxlID0gY2h1bmsud2ViLnRpdGxlID8/IFwiVW50aXRsZWRcIjtcblx0XHRcdFx0XHRcdFx0XHQvLyBEZWR1cGUgYnkgdGl0bGUgc2luY2UgVVJJcyBhcmUgcmVkaXJlY3QgVVJMcyB0aGF0IGRpZmZlciBwZXIgY2FsbFxuXHRcdFx0XHRcdFx0XHRcdGlmIChzZWVuVGl0bGVzLmhhcyh0aXRsZSkpIGNvbnRpbnVlO1xuXHRcdFx0XHRcdFx0XHRcdHNlZW5UaXRsZXMuYWRkKHRpdGxlKTtcblx0XHRcdFx0XHRcdFx0XHQvLyBkb21haW4gZmllbGQgaXMgbm90IGF2YWlsYWJsZSB2aWEgR2VtaW5pIEFQSSwgdXNlIHRpdGxlIGFzIGZhbGxiYWNrXG5cdFx0XHRcdFx0XHRcdFx0Ly8gKHRpdGxlIGlzIHR5cGljYWxseSB0aGUgZG9tYWluIG5hbWUsIGUuZy4gXCJ3aWtpcGVkaWEub3JnXCIpXG5cdFx0XHRcdFx0XHRcdFx0Y29uc3QgZG9tYWluID0gY2h1bmsud2ViLmRvbWFpbiA/PyB0aXRsZTtcblx0XHRcdFx0XHRcdFx0XHRzb3VyY2VzLnB1c2goe1xuXHRcdFx0XHRcdFx0XHRcdFx0dGl0bGUsXG5cdFx0XHRcdFx0XHRcdFx0XHR1cmk6IGNodW5rLndlYi51cmkgPz8gXCJcIixcblx0XHRcdFx0XHRcdFx0XHRcdGRvbWFpbixcblx0XHRcdFx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdC8vIEV4dHJhY3Qgc2VhcmNoIHF1ZXJpZXMgR2VtaW5pIGFjdHVhbGx5IHBlcmZvcm1lZFxuXHRcdFx0XHRcdGNvbnN0IHNlYXJjaFF1ZXJpZXMgPSBncm91bmRpbmc/LndlYlNlYXJjaFF1ZXJpZXMgPz8gW107XG5cdFx0XHRcdFx0cmVzdWx0ID0geyBhbnN3ZXIsIHNvdXJjZXMsIHNlYXJjaFF1ZXJpZXMsIGNhY2hlZDogZmFsc2UgfTtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRyZXN1bHQgPSBhd2FpdCBzZWFyY2hXaXRoT0F1dGgocGFyYW1zLnF1ZXJ5LCBvYXV0aFRva2VuISwgcHJvamVjdElkISwgc2lnbmFsKTtcblx0XHRcdFx0fVxuXHRcdFx0fSBjYXRjaCAoZXJyOiB1bmtub3duKSB7XG5cdFx0XHRcdGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcblxuXHRcdFx0XHRsZXQgZXJyb3JUeXBlID0gXCJhcGlfZXJyb3JcIjtcblx0XHRcdFx0aWYgKG1zZy5pbmNsdWRlcyhcIjQwMVwiKSB8fCBtc2cuaW5jbHVkZXMoXCJVTkFVVEhFTlRJQ0FURURcIikpIHtcblx0XHRcdFx0XHRlcnJvclR5cGUgPSBcImF1dGhfZXJyb3JcIjtcblx0XHRcdFx0fSBlbHNlIGlmIChtc2cuaW5jbHVkZXMoXCI0MjlcIikgfHwgbXNnLmluY2x1ZGVzKFwiUkVTT1VSQ0VfRVhIQVVTVEVEXCIpIHx8IG1zZy5pbmNsdWRlcyhcInF1b3RhXCIpKSB7XG5cdFx0XHRcdFx0ZXJyb3JUeXBlID0gXCJyYXRlX2xpbWl0XCI7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFtcblx0XHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdFx0dHlwZTogXCJ0ZXh0XCIsXG5cdFx0XHRcdFx0XHRcdHRleHQ6IGBHb29nbGUgU2VhcmNoIGZhaWxlZCAoJHtlcnJvclR5cGV9KTogJHttc2d9YCxcblx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XSxcblx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHRcdGRldGFpbHM6IHtcblx0XHRcdFx0XHRcdHF1ZXJ5OiBwYXJhbXMucXVlcnksXG5cdFx0XHRcdFx0XHRzb3VyY2VDb3VudDogMCxcblx0XHRcdFx0XHRcdGNhY2hlZDogZmFsc2UsXG5cdFx0XHRcdFx0XHRkdXJhdGlvbk1zOiBEYXRlLm5vdygpIC0gc3RhcnRUaW1lLFxuXHRcdFx0XHRcdFx0ZXJyb3I6IGAke2Vycm9yVHlwZX06ICR7bXNnfWAsXG5cdFx0XHRcdFx0fSBhcyBTZWFyY2hEZXRhaWxzLFxuXHRcdFx0XHR9O1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBDYWNoZSB0aGUgcmVzdWx0XG5cdFx0XHRyZXN1bHRDYWNoZS5zZXQoa2V5LCByZXN1bHQpO1xuXG5cdFx0XHQvLyBGb3JtYXQgYW5kIHRydW5jYXRlIG91dHB1dFxuXHRcdFx0Y29uc3QgcmF3T3V0cHV0ID0gZm9ybWF0T3V0cHV0KHJlc3VsdCwgbWF4U291cmNlcyk7XG5cdFx0XHRjb25zdCB0cnVuY2F0aW9uID0gdHJ1bmNhdGVIZWFkKHJhd091dHB1dCwge1xuXHRcdFx0XHRtYXhMaW5lczogREVGQVVMVF9NQVhfTElORVMsXG5cdFx0XHRcdG1heEJ5dGVzOiBERUZBVUxUX01BWF9CWVRFUyxcblx0XHRcdH0pO1xuXG5cdFx0XHRsZXQgZmluYWxUZXh0ID0gdHJ1bmNhdGlvbi5jb250ZW50O1xuXHRcdFx0aWYgKHRydW5jYXRpb24udHJ1bmNhdGVkKSB7XG5cdFx0XHRcdGZpbmFsVGV4dCArPVxuXHRcdFx0XHRcdGBcXG5cXG5bVHJ1bmNhdGVkOiBzaG93aW5nICR7dHJ1bmNhdGlvbi5vdXRwdXRMaW5lc30vJHt0cnVuY2F0aW9uLnRvdGFsTGluZXN9IGxpbmVzYCArXG5cdFx0XHRcdFx0YCAoJHtmb3JtYXRTaXplKHRydW5jYXRpb24ub3V0cHV0Qnl0ZXMpfSBvZiAke2Zvcm1hdFNpemUodHJ1bmNhdGlvbi50b3RhbEJ5dGVzKX0pXWA7XG5cdFx0XHR9XG5cblx0XHRcdHJldHVybiB7XG5cdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBmaW5hbFRleHQgfV0sXG5cdFx0XHRcdGRldGFpbHM6IHtcblx0XHRcdFx0XHRxdWVyeTogcGFyYW1zLnF1ZXJ5LFxuXHRcdFx0XHRcdHNvdXJjZUNvdW50OiByZXN1bHQuc291cmNlcy5sZW5ndGgsXG5cdFx0XHRcdFx0Y2FjaGVkOiBmYWxzZSxcblx0XHRcdFx0XHRkdXJhdGlvbk1zOiBEYXRlLm5vdygpIC0gc3RhcnRUaW1lLFxuXHRcdFx0XHR9IGFzIFNlYXJjaERldGFpbHMsXG5cdFx0XHR9O1xuXHRcdH0sXG5cblx0XHRyZW5kZXJDYWxsKGFyZ3MsIHRoZW1lKSB7XG5cdFx0XHRsZXQgdGV4dCA9IHRoZW1lLmZnKFwidG9vbFRpdGxlXCIsIHRoZW1lLmJvbGQoXCJnb29nbGVfc2VhcmNoIFwiKSk7XG5cdFx0XHR0ZXh0ICs9IHRoZW1lLmZnKFwiYWNjZW50XCIsIGBcIiR7YXJncy5xdWVyeX1cImApO1xuXHRcdFx0cmV0dXJuIG5ldyBUZXh0KHRleHQsIDAsIDApO1xuXHRcdH0sXG5cblx0XHRyZW5kZXJSZXN1bHQocmVzdWx0LCB7IGlzUGFydGlhbCwgZXhwYW5kZWQgfSwgdGhlbWUpIHtcblx0XHRcdGNvbnN0IGQgPSByZXN1bHQuZGV0YWlscyBhcyBTZWFyY2hEZXRhaWxzIHwgdW5kZWZpbmVkO1xuXG5cdFx0XHRpZiAoaXNQYXJ0aWFsKSByZXR1cm4gbmV3IFRleHQodGhlbWUuZmcoXCJ3YXJuaW5nXCIsIFwiU2VhcmNoaW5nIEdvb2dsZS4uLlwiKSwgMCwgMCk7XG5cdFx0XHRpZiAoKHJlc3VsdCBhcyBhbnkpLmlzRXJyb3IgfHwgZD8uZXJyb3IpIHtcblx0XHRcdFx0cmV0dXJuIG5ldyBUZXh0KHRoZW1lLmZnKFwiZXJyb3JcIiwgYEVycm9yOiAke2Q/LmVycm9yID8/IFwidW5rbm93blwifWApLCAwLCAwKTtcblx0XHRcdH1cblxuXHRcdFx0bGV0IHRleHQgPSB0aGVtZS5mZyhcInN1Y2Nlc3NcIiwgYCR7ZD8uc291cmNlQ291bnQgPz8gMH0gc291cmNlc2ApO1xuXHRcdFx0dGV4dCArPSB0aGVtZS5mZyhcImRpbVwiLCBgICgke2Q/LmR1cmF0aW9uTXMgPz8gMH1tcylgKTtcblx0XHRcdGlmIChkPy5jYWNoZWQpIHRleHQgKz0gdGhlbWUuZmcoXCJkaW1cIiwgXCIgXHUwMEI3IGNhY2hlZFwiKTtcblxuXHRcdFx0aWYgKGV4cGFuZGVkKSB7XG5cdFx0XHRcdGNvbnN0IGNvbnRlbnQgPSByZXN1bHQuY29udGVudFswXTtcblx0XHRcdFx0aWYgKGNvbnRlbnQ/LnR5cGUgPT09IFwidGV4dFwiKSB7XG5cdFx0XHRcdFx0Y29uc3QgcHJldmlldyA9IGNvbnRlbnQudGV4dC5zcGxpdChcIlxcblwiKS5zbGljZSgwLCA4KS5qb2luKFwiXFxuXCIpO1xuXHRcdFx0XHRcdHRleHQgKz0gXCJcXG5cXG5cIiArIHRoZW1lLmZnKFwiZGltXCIsIHByZXZpZXcpO1xuXHRcdFx0XHRcdGlmIChjb250ZW50LnRleHQuc3BsaXQoXCJcXG5cIikubGVuZ3RoID4gOCkge1xuXHRcdFx0XHRcdFx0dGV4dCArPSBcIlxcblwiICsgdGhlbWUuZmcoXCJtdXRlZFwiLCBcIi4uLlwiKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0cmV0dXJuIG5ldyBUZXh0KHRleHQsIDAsIDApO1xuXHRcdH0sXG5cdH0pO1xuXG5cdC8vIFx1MjUwMFx1MjUwMCBTZXNzaW9uIGNsZWFudXAgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cblx0cGkub24oXCJzZXNzaW9uX3NodXRkb3duXCIsIGFzeW5jICgpID0+IHtcblx0XHRyZXN1bHRDYWNoZS5jbGVhcigpO1xuXHRcdGNsaWVudCA9IG51bGw7XG5cdH0pO1xuXG5cdC8vIFx1MjUwMFx1MjUwMCBTdGFydHVwIG5vdGlmaWNhdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuXHRwaS5vbihcInNlc3Npb25fc3RhcnRcIiwgYXN5bmMgKF9ldmVudCwgY3R4KSA9PiB7XG5cdFx0aWYgKHByb2Nlc3MuZW52LkdFTUlOSV9BUElfS0VZKSByZXR1cm47XG5cblx0XHRjb25zdCBoYXNPQXV0aCA9IGF3YWl0IGN0eC5tb2RlbFJlZ2lzdHJ5LmF1dGhTdG9yYWdlLmhhc0F1dGgoXCJnb29nbGUtZ2VtaW5pLWNsaVwiKTtcblx0XHRpZiAoIWhhc09BdXRoKSB7XG5cdFx0XHRjdHgudWkubm90aWZ5KFxuXHRcdFx0XHRcIkdvb2dsZSBTZWFyY2g6IE5vIGF1dGhlbnRpY2F0aW9uIHNldC4gTG9nIGluIHZpYSBHb29nbGUgb3Igc2V0IEdFTUlOSV9BUElfS0VZIHRvIHVzZSBnb29nbGVfc2VhcmNoLlwiLFxuXHRcdFx0XHRcIndhcm5pbmdcIixcblx0XHRcdCk7XG5cdFx0fVxuXHR9KTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwIE91dHB1dCBmb3JtYXR0aW5nIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBmb3JtYXRPdXRwdXQocmVzdWx0OiBTZWFyY2hSZXN1bHQsIG1heFNvdXJjZXM6IG51bWJlcik6IHN0cmluZyB7XG5cdGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuXG5cdC8vIEFuc3dlclxuXHRpZiAocmVzdWx0LmFuc3dlcikge1xuXHRcdGxpbmVzLnB1c2gocmVzdWx0LmFuc3dlcik7XG5cdH0gZWxzZSB7XG5cdFx0bGluZXMucHVzaChcIihObyBhbnN3ZXIgdGV4dCByZXR1cm5lZCBmcm9tIHNlYXJjaClcIik7XG5cdH1cblxuXHQvLyBTb3VyY2VzXG5cdGlmIChyZXN1bHQuc291cmNlcy5sZW5ndGggPiAwKSB7XG5cdFx0bGluZXMucHVzaChcIlwiKTtcblx0XHRsaW5lcy5wdXNoKFwiU291cmNlczpcIik7XG5cdFx0Y29uc3Qgc291cmNlc1RvU2hvdyA9IHJlc3VsdC5zb3VyY2VzLnNsaWNlKDAsIG1heFNvdXJjZXMpO1xuXHRcdGZvciAobGV0IGkgPSAwOyBpIDwgc291cmNlc1RvU2hvdy5sZW5ndGg7IGkrKykge1xuXHRcdFx0Y29uc3QgcyA9IHNvdXJjZXNUb1Nob3dbaV07XG5cdFx0XHRsaW5lcy5wdXNoKGBbJHtpICsgMX1dICR7cy50aXRsZX0gLSAke3MuZG9tYWlufWApO1xuXHRcdFx0bGluZXMucHVzaChgICAgICR7cy51cml9YCk7XG5cdFx0fVxuXHRcdGlmIChyZXN1bHQuc291cmNlcy5sZW5ndGggPiBtYXhTb3VyY2VzKSB7XG5cdFx0XHRsaW5lcy5wdXNoKGAoJHtyZXN1bHQuc291cmNlcy5sZW5ndGggLSBtYXhTb3VyY2VzfSBtb3JlIHNvdXJjZXMgb21pdHRlZClgKTtcblx0XHR9XG5cdH0gZWxzZSB7XG5cdFx0bGluZXMucHVzaChcIlwiKTtcblx0XHRsaW5lcy5wdXNoKFwiKE5vIHNvdXJjZSBVUkxzIGZvdW5kIGluIGdyb3VuZGluZyBtZXRhZGF0YSlcIik7XG5cdH1cblxuXHQvLyBTZWFyY2ggcXVlcmllc1xuXHRpZiAocmVzdWx0LnNlYXJjaFF1ZXJpZXMubGVuZ3RoID4gMCkge1xuXHRcdGxpbmVzLnB1c2goXCJcIik7XG5cdFx0bGluZXMucHVzaChgU2VhcmNoZXMgcGVyZm9ybWVkOiAke3Jlc3VsdC5zZWFyY2hRdWVyaWVzLm1hcCgocSkgPT4gYFwiJHtxfVwiYCkuam9pbihcIiwgXCIpfWApO1xuXHR9XG5cblx0cmV0dXJuIGxpbmVzLmpvaW4oXCJcXG5cIik7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFhQTtBQUFBLEVBQ0M7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVB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
