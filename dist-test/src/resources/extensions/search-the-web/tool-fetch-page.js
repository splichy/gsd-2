import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@gsd/pi-coding-agent";
import { Text } from "@gsd/pi-tui";
import { Type } from "@sinclair/typebox";
import { LRUTTLCache } from "./cache.js";
import { fetchSimple, HttpError } from "./http.js";
import { extractDomain, isBlockedUrl } from "./url-utils.js";
import { formatPageContent } from "./format.js";
import { getOllamaApiKey } from "./provider.js";
const pageCache = new LRUTTLCache({ max: 30, ttlMs: 9e5 });
pageCache.startPurgeInterval(12e4);
async function fetchViaJina(url, options = {}) {
  const jinaUrl = `https://r.jina.ai/${url}`;
  const headers = {
    "Accept": "text/plain",
    "X-Return-Format": "markdown",
    "X-No-Cache": "false"
  };
  const jinaKey = process.env.JINA_API_KEY;
  if (jinaKey) {
    headers["Authorization"] = `Bearer ${jinaKey}`;
  }
  if (options.selector) {
    headers["X-Target-Selector"] = options.selector;
  }
  const response = await fetchSimple(jinaUrl, {
    method: "GET",
    headers,
    signal: options.signal,
    timeoutMs: 2e4
  });
  const text = await response.text();
  let title;
  let content = text;
  const titleMatch = text.match(/^Title:\s*(.+)\n/);
  if (titleMatch) {
    title = titleMatch[1].trim();
    content = text.replace(/^Title:\s*.+\n/, "");
  }
  content = content.replace(/^URL Source:\s*.+\n\n?/, "");
  content = content.replace(/!\[([^\]]*)\]\([^)]+\)/g, "");
  content = content.replace(/\n{4,}/g, "\n\n\n");
  return { content: content.trim(), title };
}
async function fetchDirectFallback(url, signal) {
  const response = await fetchSimple(url, {
    method: "GET",
    headers: {
      "Accept": "text/html,application/xhtml+xml,application/json,text/plain",
      "User-Agent": "Mozilla/5.0 (compatible; pi-coding-agent/1.0)"
    },
    signal,
    timeoutMs: 15e3
  });
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const text2 = await response.text();
    try {
      const parsed = JSON.parse(text2);
      return {
        content: "```json\n" + JSON.stringify(parsed, null, 2) + "\n```",
        title: void 0,
        contentType: "application/json"
      };
    } catch {
      return { content: text2, title: void 0, contentType };
    }
  }
  if (contentType.includes("text/plain")) {
    const text2 = await response.text();
    return { content: text2, title: void 0, contentType: "text/plain" };
  }
  if (contentType.includes("application/pdf")) {
    return {
      content: "[This URL is a PDF document. Content extraction is not supported for PDFs.]",
      title: void 0,
      contentType: "application/pdf"
    };
  }
  const html = await response.text();
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : void 0;
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<nav[\s\S]*?<\/nav>/gi, "").replace(/<header[\s\S]*?<\/header>/gi, "").replace(/<footer[\s\S]*?<\/footer>/gi, "").replace(/<\/?(p|div|br|h[1-6]|li|tr|blockquote|pre|section|article)[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/[ \t]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { content: text, title, contentType };
}
async function fetchViaOllama(url, signal) {
  const response = await fetchSimple("https://ollama.com/api/web_fetch", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${getOllamaApiKey()}`
    },
    body: JSON.stringify({ url }),
    signal,
    timeoutMs: 2e4
  });
  const data = await response.json();
  const content = (data.content || "").trim();
  const title = data.title?.trim() || void 0;
  return { content, title };
}
function smartTruncate(content, maxChars, offset = 0) {
  const sliced = offset > 0 ? content.slice(offset) : content;
  if (sliced.length <= maxChars) {
    return { content: sliced, truncated: false, hasMore: false };
  }
  const window = sliced.slice(0, maxChars);
  const lastParagraph = window.lastIndexOf("\n\n");
  const lastSentence = window.lastIndexOf(". ");
  const lastNewline = window.lastIndexOf("\n");
  let cutPoint = maxChars;
  if (lastParagraph > maxChars * 0.6) {
    cutPoint = lastParagraph;
  } else if (lastSentence > maxChars * 0.6) {
    cutPoint = lastSentence + 1;
  } else if (lastNewline > maxChars * 0.6) {
    cutPoint = lastNewline;
  }
  const nextOffset = offset + cutPoint;
  const hasMore = nextOffset < content.length;
  return {
    content: sliced.slice(0, cutPoint).trim() + "\n\n[... content truncated]",
    truncated: true,
    hasMore,
    nextOffset: hasMore ? nextOffset : void 0
  };
}
async function fetchOnePage(url, options) {
  let pageContent;
  let pageTitle;
  let source = "jina";
  let jinaError;
  let contentType;
  try {
    const result = await fetchViaJina(url, options);
    pageContent = result.content;
    pageTitle = result.title;
  } catch (err) {
    jinaError = err instanceof HttpError ? `Jina HTTP ${err.statusCode}` : err.message ?? String(err);
    const ollamaKey = getOllamaApiKey();
    if (ollamaKey) {
      try {
        const ollamaResult = await fetchViaOllama(url, options.signal);
        if (ollamaResult.content && ollamaResult.content.length >= 50) {
          pageContent = ollamaResult.content;
          pageTitle = ollamaResult.title;
          source = "direct";
          return {
            content: pageContent,
            title: pageTitle,
            source,
            jinaError,
            contentType,
            originalChars: pageContent.length
          };
        }
      } catch {
      }
    }
    source = "direct";
    const result = await fetchDirectFallback(url, options.signal);
    pageContent = result.content;
    pageTitle = result.title;
    contentType = result.contentType;
  }
  return {
    content: pageContent,
    title: pageTitle,
    source,
    jinaError,
    contentType,
    originalChars: pageContent.length
  };
}
function registerFetchPageTool(pi) {
  pi.registerTool({
    name: "fetch_page",
    label: "Fetch Page",
    description: "Fetch a web page and extract its content as clean markdown. Use this to read the full content of URLs found via search-the-web. Uses Jina Reader for high-quality markdown extraction. Control the amount of content returned with maxChars (default: 8000, max: 30000).",
    promptSnippet: "Fetch and extract clean content from a web page URL as markdown",
    promptGuidelines: [
      "Use fetch_page to read the content of URLs found via search-the-web when you need more detail than snippets provide.",
      "Start with the default maxChars (8000). Increase only if the first fetch lacks the detail you need.",
      "For very long pages, use a smaller maxChars and increase if needed \u2014 this saves context tokens.",
      "The extracted content is already clean markdown \u2014 no HTML tags, no navigation, no ads."
    ],
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch and extract content from" }),
      maxChars: Type.Optional(
        Type.Number({
          minimum: 1e3,
          maximum: 3e4,
          default: 8e3,
          description: "Maximum characters of content to return (default: 8000, max: 30000). Controls context token usage."
        })
      ),
      offset: Type.Optional(
        Type.Number({
          minimum: 0,
          description: "Character offset to start reading from (for continuation of truncated pages). Use the nextOffset value from a previous fetch_page result."
        })
      ),
      selector: Type.Optional(
        Type.String({
          description: "CSS selector to extract only a specific section of the page (e.g., 'main', 'article', '.api-docs'). Reduces noise and token usage."
        })
      )
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Fetch cancelled." }], details: void 0 };
      }
      const maxChars = params.maxChars ?? 8e3;
      const offset = params.offset ?? 0;
      const url = params.url.trim();
      try {
        new URL(url);
      } catch {
        return {
          content: [{ type: "text", text: `Invalid URL: ${url}` }],
          isError: true,
          details: { error: "Invalid URL", url }
        };
      }
      if (isBlockedUrl(url)) {
        return {
          content: [{ type: "text", text: `Blocked URL: requests to private/internal addresses are not allowed.` }],
          isError: true,
          details: { error: "SSRF blocked", url }
        };
      }
      const cacheKey = params.selector ? `${url}|sel:${params.selector}` : url;
      const cached = pageCache.get(cacheKey);
      if (cached) {
        const trunc2 = smartTruncate(cached.content, maxChars, offset);
        const opts2 = {
          title: cached.title,
          charCount: trunc2.content.length,
          truncated: trunc2.truncated,
          originalChars: trunc2.truncated ? cached.content.length : void 0,
          hasMore: trunc2.hasMore,
          nextOffset: trunc2.nextOffset
        };
        const output2 = formatPageContent(url, trunc2.content, opts2);
        const finalTruncation2 = truncateHead(output2, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
        const details2 = {
          url,
          title: cached.title,
          charCount: trunc2.content.length,
          originalChars: cached.content.length,
          truncated: trunc2.truncated,
          cached: true,
          source: cached.source,
          hasMore: trunc2.hasMore,
          nextOffset: trunc2.nextOffset,
          offset: offset || void 0
        };
        return {
          content: [{ type: "text", text: finalTruncation2.content }],
          details: details2
        };
      }
      const domain = extractDomain(url);
      onUpdate?.({ content: [{ type: "text", text: `Fetching ${domain}...` }], details: void 0 });
      let result;
      try {
        result = await fetchOnePage(url, { signal, selector: params.selector });
      } catch (err) {
        const message = err instanceof HttpError ? `HTTP ${err.statusCode}` : err.message ?? String(err);
        return {
          content: [{ type: "text", text: `Failed to fetch ${domain}: ${message}` }],
          isError: true,
          details: { error: message, url }
        };
      }
      if (!result.content || result.content.length < 50) {
        return {
          content: [{ type: "text", text: `Page at ${domain} returned no extractable content.` }],
          details: { url, charCount: 0, source: result.source, cached: false, truncated: false, jinaError: result.jinaError }
        };
      }
      pageCache.set(cacheKey, { content: result.content, title: result.title, source: result.source });
      const trunc = smartTruncate(result.content, maxChars, offset);
      const opts = {
        title: result.title,
        charCount: trunc.content.length,
        truncated: trunc.truncated,
        originalChars: trunc.truncated ? result.originalChars : void 0,
        hasMore: trunc.hasMore,
        nextOffset: trunc.nextOffset
      };
      const output = formatPageContent(url, trunc.content, opts);
      const finalTruncation = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
      let content = finalTruncation.content;
      if (finalTruncation.truncated) {
        const tempFile = await pi.writeTempFile(output, { prefix: "fetch-page-" });
        content += `

[Truncated to fit context. Full content: ${tempFile}]`;
      }
      const details = {
        url,
        title: result.title,
        charCount: trunc.content.length,
        originalChars: result.originalChars,
        truncated: trunc.truncated,
        cached: false,
        source: result.source,
        jinaError: result.jinaError,
        contentType: result.contentType,
        hasMore: trunc.hasMore,
        nextOffset: trunc.nextOffset,
        offset: offset || void 0,
        selector: params.selector
      };
      return {
        content: [{ type: "text", text: content }],
        details
      };
    },
    renderCall(args, theme) {
      const domain = extractDomain(args.url);
      let text = theme.fg("toolTitle", theme.bold("fetch_page "));
      text += theme.fg("accent", domain);
      const meta = [];
      if (args.maxChars && args.maxChars !== 8e3) meta.push(`max ${(args.maxChars / 1e3).toFixed(0)}k`);
      if (args.offset) meta.push(`offset:${args.offset}`);
      if (args.selector) meta.push(`sel:"${args.selector}"`);
      if (meta.length > 0) {
        text += " " + theme.fg("dim", `(${meta.join(", ")})`);
      }
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details;
      if (details?.error) {
        return new Text(theme.fg("error", `\u2717 ${details.error}`), 0, 0);
      }
      const domain = extractDomain(details?.url || "");
      const title = details?.title ? ` \u2014 ${details.title}` : "";
      const chars = details?.charCount ? `${(details.charCount / 1e3).toFixed(1)}k chars` : "";
      const cacheTag = details?.cached ? theme.fg("dim", " [cached]") : "";
      const sourceTag = details?.source === "direct" ? theme.fg("dim", " [direct]") : "";
      const truncTag = details?.truncated && details?.originalChars ? theme.fg("dim", ` [${(details.originalChars / 1e3).toFixed(0)}k total]`) : "";
      const moreTag = details?.hasMore && details?.nextOffset ? theme.fg("accent", ` [more\u2192offset:${details.nextOffset}]`) : "";
      const jinaTag = details?.jinaError ? theme.fg("warning", ` [jina failed: ${details.jinaError}]`) : "";
      let text = theme.fg("success", `\u2713 ${domain}${title}`) + ` ${chars}` + cacheTag + sourceTag + truncTag + moreTag + jinaTag;
      if (expanded) {
        const content = result.content[0];
        if (content?.type === "text") {
          const preview = content.text.split("\n").slice(0, 8).join("\n");
          text += "\n\n" + theme.fg("dim", preview);
        }
      }
      return new Text(text, 0, 0);
    }
  });
}
export {
  registerFetchPageTool
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL3NlYXJjaC10aGUtd2ViL3Rvb2wtZmV0Y2gtcGFnZS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBmZXRjaF9wYWdlIHRvb2wgXHUyMDE0IEV4dHJhY3QgY2xlYW4gbWFya2Rvd24gZnJvbSBhbnkgVVJMLlxuICpcbiAqIHYzIGltcHJvdmVtZW50czpcbiAqIC0gb2Zmc2V0IHBhcmFtZXRlciBmb3IgY29udGludWF0aW9uIHJlYWRpbmcgKGxpa2UgZmlsZSByZWFkIG9mZnNldHMpXG4gKiAtIHNlbGVjdG9yIHBhcmFtZXRlciBmb3IgSmluYSdzIFgtVGFyZ2V0LVNlbGVjdG9yIChleHRyYWN0IHNwZWNpZmljIHNlY3Rpb25zKVxuICogLSBKaW5hIGZhaWx1cmUgZGlhZ25vc3RpY3Mgc3VyZmFjZWQgaW4gZGV0YWlsc1xuICogLSBDb250ZW50LXR5cGUgYXdhcmVuZXNzIChKU09OIHBhc3N0aHJvdWdoLCBQREYgZGV0ZWN0aW9uKVxuICovXG5cbmltcG9ydCB0eXBlIHsgRXh0ZW5zaW9uQVBJIH0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XG5pbXBvcnQgeyB0cnVuY2F0ZUhlYWQsIERFRkFVTFRfTUFYX0JZVEVTLCBERUZBVUxUX01BWF9MSU5FUyB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuaW1wb3J0IHsgVGV4dCB9IGZyb20gXCJAZ3NkL3BpLXR1aVwiO1xuaW1wb3J0IHsgVHlwZSB9IGZyb20gXCJAc2luY2xhaXIvdHlwZWJveFwiO1xuXG5pbXBvcnQgeyBMUlVUVExDYWNoZSB9IGZyb20gXCIuL2NhY2hlLmpzXCI7XG5pbXBvcnQgeyBmZXRjaFNpbXBsZSwgSHR0cEVycm9yIH0gZnJvbSBcIi4vaHR0cC5qc1wiO1xuaW1wb3J0IHsgZXh0cmFjdERvbWFpbiwgaXNCbG9ja2VkVXJsIH0gZnJvbSBcIi4vdXJsLXV0aWxzLmpzXCI7XG5pbXBvcnQgeyBmb3JtYXRQYWdlQ29udGVudCwgdHlwZSBGb3JtYXRQYWdlT3B0aW9ucyB9IGZyb20gXCIuL2Zvcm1hdC5qc1wiO1xuaW1wb3J0IHsgZ2V0T2xsYW1hQXBpS2V5IH0gZnJvbSBcIi4vcHJvdmlkZXIuanNcIjtcblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIENhY2hlXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5pbnRlcmZhY2UgQ2FjaGVkUGFnZSB7XG4gIGNvbnRlbnQ6IHN0cmluZztcbiAgdGl0bGU/OiBzdHJpbmc7XG4gIHNvdXJjZTogXCJqaW5hXCIgfCBcImRpcmVjdFwiO1xufVxuXG4vLyBQYWdlIGNvbnRlbnQgY2FjaGU6IG1heCAzMCBlbnRyaWVzLCAxNS1taW51dGUgVFRMXG5jb25zdCBwYWdlQ2FjaGUgPSBuZXcgTFJVVFRMQ2FjaGU8Q2FjaGVkUGFnZT4oeyBtYXg6IDMwLCB0dGxNczogOTAwXzAwMCB9KTtcbnBhZ2VDYWNoZS5zdGFydFB1cmdlSW50ZXJ2YWwoMTIwXzAwMCk7XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBKaW5hIFJlYWRlclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBGZXRjaCBwYWdlIGNvbnRlbnQgdmlhIEppbmEgUmVhZGVyIEFQSS5cbiAqIFJldHVybnMgY29udGVudCArIG1ldGFkYXRhLCBvciB0aHJvd3Mgd2l0aCBhIGRlc2NyaXB0aXZlIGVycm9yLlxuICovXG5hc3luYyBmdW5jdGlvbiBmZXRjaFZpYUppbmEoXG4gIHVybDogc3RyaW5nLFxuICBvcHRpb25zOiB7IHNpZ25hbD86IEFib3J0U2lnbmFsOyBzZWxlY3Rvcj86IHN0cmluZyB9ID0ge31cbik6IFByb21pc2U8eyBjb250ZW50OiBzdHJpbmc7IHRpdGxlPzogc3RyaW5nIH0+IHtcbiAgY29uc3QgamluYVVybCA9IGBodHRwczovL3IuamluYS5haS8ke3VybH1gO1xuXG4gIGNvbnN0IGhlYWRlcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gICAgXCJBY2NlcHRcIjogXCJ0ZXh0L3BsYWluXCIsXG4gICAgXCJYLVJldHVybi1Gb3JtYXRcIjogXCJtYXJrZG93blwiLFxuICAgIFwiWC1Oby1DYWNoZVwiOiBcImZhbHNlXCIsXG4gIH07XG5cbiAgLy8gVXNlIEppbmEgQVBJIGtleSBpZiBhdmFpbGFibGUgZm9yIGhpZ2hlciByYXRlIGxpbWl0c1xuICBjb25zdCBqaW5hS2V5ID0gcHJvY2Vzcy5lbnYuSklOQV9BUElfS0VZO1xuICBpZiAoamluYUtleSkge1xuICAgIGhlYWRlcnNbXCJBdXRob3JpemF0aW9uXCJdID0gYEJlYXJlciAke2ppbmFLZXl9YDtcbiAgfVxuXG4gIC8vIFRhcmdldCBzcGVjaWZpYyBDU1Mgc2VsZWN0b3Igb24gdGhlIHBhZ2VcbiAgaWYgKG9wdGlvbnMuc2VsZWN0b3IpIHtcbiAgICBoZWFkZXJzW1wiWC1UYXJnZXQtU2VsZWN0b3JcIl0gPSBvcHRpb25zLnNlbGVjdG9yO1xuICB9XG5cbiAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaFNpbXBsZShqaW5hVXJsLCB7XG4gICAgbWV0aG9kOiBcIkdFVFwiLFxuICAgIGhlYWRlcnMsXG4gICAgc2lnbmFsOiBvcHRpb25zLnNpZ25hbCxcbiAgICB0aW1lb3V0TXM6IDIwXzAwMCxcbiAgfSk7XG5cbiAgY29uc3QgdGV4dCA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKTtcblxuICAvLyBKaW5hIHJldHVybnMgbWFya2Rvd24gd2l0aCBhIHRpdGxlIGxpbmUgYXQgdGhlIHRvcFxuICAvLyBGb3JtYXQ6IFwiVGl0bGU6IDx0aXRsZT5cXG5VUkwgU291cmNlOiA8dXJsPlxcblxcbjxjb250ZW50PlwiXG4gIGxldCB0aXRsZTogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBsZXQgY29udGVudCA9IHRleHQ7XG5cbiAgY29uc3QgdGl0bGVNYXRjaCA9IHRleHQubWF0Y2goL15UaXRsZTpcXHMqKC4rKVxcbi8pO1xuICBpZiAodGl0bGVNYXRjaCkge1xuICAgIHRpdGxlID0gdGl0bGVNYXRjaFsxXS50cmltKCk7XG4gICAgY29udGVudCA9IHRleHQucmVwbGFjZSgvXlRpdGxlOlxccyouK1xcbi8sIFwiXCIpO1xuICB9XG5cbiAgLy8gU3RyaXAgdGhlIFVSTCBTb3VyY2UgbGluZVxuICBjb250ZW50ID0gY29udGVudC5yZXBsYWNlKC9eVVJMIFNvdXJjZTpcXHMqLitcXG5cXG4/LywgXCJcIik7XG5cbiAgLy8gU3RyaXAgTWFya2Rvd24gaW1hZ2VzIHRvIHNhdmUgdG9rZW5zXG4gIGNvbnRlbnQgPSBjb250ZW50LnJlcGxhY2UoLyFcXFsoW15cXF1dKilcXF1cXChbXildK1xcKS9nLCBcIlwiKTtcblxuICAvLyBDb2xsYXBzZSBleGNlc3NpdmUgd2hpdGVzcGFjZVxuICBjb250ZW50ID0gY29udGVudC5yZXBsYWNlKC9cXG57NCx9L2csIFwiXFxuXFxuXFxuXCIpO1xuXG4gIHJldHVybiB7IGNvbnRlbnQ6IGNvbnRlbnQudHJpbSgpLCB0aXRsZSB9O1xufVxuXG4vKipcbiAqIEJhc2ljIGZhbGxiYWNrOiBmZXRjaCByYXcgSFRNTCBhbmQgZG8gY3J1ZGUgdGV4dCBleHRyYWN0aW9uLlxuICovXG5hc3luYyBmdW5jdGlvbiBmZXRjaERpcmVjdEZhbGxiYWNrKFxuICB1cmw6IHN0cmluZyxcbiAgc2lnbmFsPzogQWJvcnRTaWduYWxcbik6IFByb21pc2U8eyBjb250ZW50OiBzdHJpbmc7IHRpdGxlPzogc3RyaW5nOyBjb250ZW50VHlwZT86IHN0cmluZyB9PiB7XG4gIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2hTaW1wbGUodXJsLCB7XG4gICAgbWV0aG9kOiBcIkdFVFwiLFxuICAgIGhlYWRlcnM6IHtcbiAgICAgIFwiQWNjZXB0XCI6IFwidGV4dC9odG1sLGFwcGxpY2F0aW9uL3hodG1sK3htbCxhcHBsaWNhdGlvbi9qc29uLHRleHQvcGxhaW5cIixcbiAgICAgIFwiVXNlci1BZ2VudFwiOiBcIk1vemlsbGEvNS4wIChjb21wYXRpYmxlOyBwaS1jb2RpbmctYWdlbnQvMS4wKVwiLFxuICAgIH0sXG4gICAgc2lnbmFsLFxuICAgIHRpbWVvdXRNczogMTVfMDAwLFxuICB9KTtcblxuICBjb25zdCBjb250ZW50VHlwZSA9IHJlc3BvbnNlLmhlYWRlcnMuZ2V0KFwiY29udGVudC10eXBlXCIpIHx8IFwiXCI7XG5cbiAgLy8gSlNPTiBwYXNzdGhyb3VnaCBcdTIwMTQgcmV0dXJuIGZvcm1hdHRlZCBKU09OIGRpcmVjdGx5XG4gIGlmIChjb250ZW50VHlwZS5pbmNsdWRlcyhcImFwcGxpY2F0aW9uL2pzb25cIikpIHtcbiAgICBjb25zdCB0ZXh0ID0gYXdhaXQgcmVzcG9uc2UudGV4dCgpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHRleHQpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgY29udGVudDogXCJgYGBqc29uXFxuXCIgKyBKU09OLnN0cmluZ2lmeShwYXJzZWQsIG51bGwsIDIpICsgXCJcXG5gYGBcIixcbiAgICAgICAgdGl0bGU6IHVuZGVmaW5lZCxcbiAgICAgICAgY29udGVudFR5cGU6IFwiYXBwbGljYXRpb24vanNvblwiLFxuICAgICAgfTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiB7IGNvbnRlbnQ6IHRleHQsIHRpdGxlOiB1bmRlZmluZWQsIGNvbnRlbnRUeXBlIH07XG4gICAgfVxuICB9XG5cbiAgLy8gUGxhaW4gdGV4dCBwYXNzdGhyb3VnaFxuICBpZiAoY29udGVudFR5cGUuaW5jbHVkZXMoXCJ0ZXh0L3BsYWluXCIpKSB7XG4gICAgY29uc3QgdGV4dCA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKTtcbiAgICByZXR1cm4geyBjb250ZW50OiB0ZXh0LCB0aXRsZTogdW5kZWZpbmVkLCBjb250ZW50VHlwZTogXCJ0ZXh0L3BsYWluXCIgfTtcbiAgfVxuXG4gIC8vIFBERiBkZXRlY3Rpb24gXHUyMDE0IGNhbid0IGV4dHJhY3QsIGJ1dCB0ZWxsIHRoZSBhZ2VudFxuICBpZiAoY29udGVudFR5cGUuaW5jbHVkZXMoXCJhcHBsaWNhdGlvbi9wZGZcIikpIHtcbiAgICByZXR1cm4ge1xuICAgICAgY29udGVudDogXCJbVGhpcyBVUkwgaXMgYSBQREYgZG9jdW1lbnQuIENvbnRlbnQgZXh0cmFjdGlvbiBpcyBub3Qgc3VwcG9ydGVkIGZvciBQREZzLl1cIixcbiAgICAgIHRpdGxlOiB1bmRlZmluZWQsXG4gICAgICBjb250ZW50VHlwZTogXCJhcHBsaWNhdGlvbi9wZGZcIixcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgaHRtbCA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKTtcblxuICAvLyBFeHRyYWN0IHRpdGxlXG4gIGNvbnN0IHRpdGxlTWF0Y2ggPSBodG1sLm1hdGNoKC88dGl0bGVbXj5dKj4oW148XSspPFxcL3RpdGxlPi9pKTtcbiAgY29uc3QgdGl0bGUgPSB0aXRsZU1hdGNoID8gdGl0bGVNYXRjaFsxXS50cmltKCkgOiB1bmRlZmluZWQ7XG5cbiAgLy8gU3RyaXAgdGFncywgZGVjb2RlIGVudGl0aWVzLCBjb2xsYXBzZSB3aGl0ZXNwYWNlXG4gIGxldCB0ZXh0ID0gaHRtbFxuICAgIC5yZXBsYWNlKC88c2NyaXB0W1xcc1xcU10qPzxcXC9zY3JpcHQ+L2dpLCBcIlwiKVxuICAgIC5yZXBsYWNlKC88c3R5bGVbXFxzXFxTXSo/PFxcL3N0eWxlPi9naSwgXCJcIilcbiAgICAucmVwbGFjZSgvPG5hdltcXHNcXFNdKj88XFwvbmF2Pi9naSwgXCJcIilcbiAgICAucmVwbGFjZSgvPGhlYWRlcltcXHNcXFNdKj88XFwvaGVhZGVyPi9naSwgXCJcIilcbiAgICAucmVwbGFjZSgvPGZvb3RlcltcXHNcXFNdKj88XFwvZm9vdGVyPi9naSwgXCJcIilcbiAgICAucmVwbGFjZSgvPFxcLz8ocHxkaXZ8YnJ8aFsxLTZdfGxpfHRyfGJsb2NrcXVvdGV8cHJlfHNlY3Rpb258YXJ0aWNsZSlbXj5dKj4vZ2ksIFwiXFxuXCIpXG4gICAgLnJlcGxhY2UoLzxbXj5dKz4vZywgXCIgXCIpXG4gICAgLnJlcGxhY2UoLyZhbXA7L2csIFwiJlwiKVxuICAgIC5yZXBsYWNlKC8mbHQ7L2csIFwiPFwiKVxuICAgIC5yZXBsYWNlKC8mZ3Q7L2csIFwiPlwiKVxuICAgIC5yZXBsYWNlKC8mcXVvdDsvZywgJ1wiJylcbiAgICAucmVwbGFjZSgvJiMzOTsvZywgXCInXCIpXG4gICAgLnJlcGxhY2UoLyZuYnNwOy9nLCBcIiBcIilcbiAgICAucmVwbGFjZSgvWyBcXHRdKy9nLCBcIiBcIilcbiAgICAucmVwbGFjZSgvXFxuWyBcXHRdKy9nLCBcIlxcblwiKVxuICAgIC5yZXBsYWNlKC9cXG57Myx9L2csIFwiXFxuXFxuXCIpXG4gICAgLnRyaW0oKTtcblxuICByZXR1cm4geyBjb250ZW50OiB0ZXh0LCB0aXRsZSwgY29udGVudFR5cGUgfTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIE9sbGFtYSBXZWIgRmV0Y2hcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmludGVyZmFjZSBPbGxhbWFXZWJGZXRjaFJlc3BvbnNlIHtcbiAgdGl0bGU/OiBzdHJpbmc7XG4gIGNvbnRlbnQ/OiBzdHJpbmc7XG4gIGxpbmtzPzogc3RyaW5nW107XG59XG5cbi8qKlxuICogRmV0Y2ggcGFnZSBjb250ZW50IHZpYSBPbGxhbWEgd2ViX2ZldGNoIEFQSS5cbiAqIFJldHVybnMgY29udGVudCArIG1ldGFkYXRhLCBvciB0aHJvd3Mgb24gZmFpbHVyZS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gZmV0Y2hWaWFPbGxhbWEoXG4gIHVybDogc3RyaW5nLFxuICBzaWduYWw/OiBBYm9ydFNpZ25hbCxcbik6IFByb21pc2U8eyBjb250ZW50OiBzdHJpbmc7IHRpdGxlPzogc3RyaW5nIH0+IHtcbiAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaFNpbXBsZShcImh0dHBzOi8vb2xsYW1hLmNvbS9hcGkvd2ViX2ZldGNoXCIsIHtcbiAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgIGhlYWRlcnM6IHtcbiAgICAgIFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiLFxuICAgICAgXCJBdXRob3JpemF0aW9uXCI6IGBCZWFyZXIgJHtnZXRPbGxhbWFBcGlLZXkoKX1gLFxuICAgIH0sXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyB1cmwgfSksXG4gICAgc2lnbmFsLFxuICAgIHRpbWVvdXRNczogMjBfMDAwLFxuICB9KTtcblxuICBjb25zdCBkYXRhOiBPbGxhbWFXZWJGZXRjaFJlc3BvbnNlID0gYXdhaXQgcmVzcG9uc2UuanNvbigpO1xuXG4gIGNvbnN0IGNvbnRlbnQgPSAoZGF0YS5jb250ZW50IHx8IFwiXCIpLnRyaW0oKTtcbiAgY29uc3QgdGl0bGUgPSBkYXRhLnRpdGxlPy50cmltKCkgfHwgdW5kZWZpbmVkO1xuXG4gIHJldHVybiB7IGNvbnRlbnQsIHRpdGxlIH07XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBTbWFydCBUcnVuY2F0aW9uXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4vKipcbiAqIFRydW5jYXRlIHBhZ2UgY29udGVudCB0byBhIHRhcmdldCBjaGFyYWN0ZXIgY291bnQsIHRyeWluZyB0byBicmVha1xuICogYXQgcGFyYWdyYXBoIGJvdW5kYXJpZXMgcmF0aGVyIHRoYW4gbWlkLXNlbnRlbmNlLlxuICovXG5mdW5jdGlvbiBzbWFydFRydW5jYXRlKFxuICBjb250ZW50OiBzdHJpbmcsXG4gIG1heENoYXJzOiBudW1iZXIsXG4gIG9mZnNldDogbnVtYmVyID0gMFxuKTogeyBjb250ZW50OiBzdHJpbmc7IHRydW5jYXRlZDogYm9vbGVhbjsgaGFzTW9yZTogYm9vbGVhbjsgbmV4dE9mZnNldD86IG51bWJlciB9IHtcbiAgLy8gQXBwbHkgb2Zmc2V0IGZpcnN0XG4gIGNvbnN0IHNsaWNlZCA9IG9mZnNldCA+IDAgPyBjb250ZW50LnNsaWNlKG9mZnNldCkgOiBjb250ZW50O1xuXG4gIGlmIChzbGljZWQubGVuZ3RoIDw9IG1heENoYXJzKSB7XG4gICAgcmV0dXJuIHsgY29udGVudDogc2xpY2VkLCB0cnVuY2F0ZWQ6IGZhbHNlLCBoYXNNb3JlOiBmYWxzZSB9O1xuICB9XG5cbiAgLy8gRmluZCB0aGUgbGFzdCBwYXJhZ3JhcGggYnJlYWsgYmVmb3JlIG1heENoYXJzXG4gIGNvbnN0IHdpbmRvdyA9IHNsaWNlZC5zbGljZSgwLCBtYXhDaGFycyk7XG4gIGNvbnN0IGxhc3RQYXJhZ3JhcGggPSB3aW5kb3cubGFzdEluZGV4T2YoXCJcXG5cXG5cIik7XG4gIGNvbnN0IGxhc3RTZW50ZW5jZSA9IHdpbmRvdy5sYXN0SW5kZXhPZihcIi4gXCIpO1xuICBjb25zdCBsYXN0TmV3bGluZSA9IHdpbmRvdy5sYXN0SW5kZXhPZihcIlxcblwiKTtcblxuICAvLyBQcmVmZXIgcGFyYWdyYXBoID4gc2VudGVuY2UgPiBuZXdsaW5lID4gaGFyZCBjdXRcbiAgbGV0IGN1dFBvaW50ID0gbWF4Q2hhcnM7XG4gIGlmIChsYXN0UGFyYWdyYXBoID4gbWF4Q2hhcnMgKiAwLjYpIHtcbiAgICBjdXRQb2ludCA9IGxhc3RQYXJhZ3JhcGg7XG4gIH0gZWxzZSBpZiAobGFzdFNlbnRlbmNlID4gbWF4Q2hhcnMgKiAwLjYpIHtcbiAgICBjdXRQb2ludCA9IGxhc3RTZW50ZW5jZSArIDE7XG4gIH0gZWxzZSBpZiAobGFzdE5ld2xpbmUgPiBtYXhDaGFycyAqIDAuNikge1xuICAgIGN1dFBvaW50ID0gbGFzdE5ld2xpbmU7XG4gIH1cblxuICBjb25zdCBuZXh0T2Zmc2V0ID0gb2Zmc2V0ICsgY3V0UG9pbnQ7XG4gIGNvbnN0IGhhc01vcmUgPSBuZXh0T2Zmc2V0IDwgY29udGVudC5sZW5ndGg7XG5cbiAgcmV0dXJuIHtcbiAgICBjb250ZW50OiBzbGljZWQuc2xpY2UoMCwgY3V0UG9pbnQpLnRyaW0oKSArIFwiXFxuXFxuWy4uLiBjb250ZW50IHRydW5jYXRlZF1cIixcbiAgICB0cnVuY2F0ZWQ6IHRydWUsXG4gICAgaGFzTW9yZSxcbiAgICBuZXh0T2Zmc2V0OiBoYXNNb3JlID8gbmV4dE9mZnNldCA6IHVuZGVmaW5lZCxcbiAgfTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFNpbmdsZSBwYWdlIGZldGNoIChzaGFyZWQgYmV0d2VlbiBzaW5nbGUgYW5kIG11bHRpIG1vZGVzKVxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuaW50ZXJmYWNlIEZldGNoUGFnZVJlc3VsdCB7XG4gIGNvbnRlbnQ6IHN0cmluZztcbiAgdGl0bGU/OiBzdHJpbmc7XG4gIHNvdXJjZTogXCJqaW5hXCIgfCBcImRpcmVjdFwiO1xuICBqaW5hRXJyb3I/OiBzdHJpbmc7XG4gIGNvbnRlbnRUeXBlPzogc3RyaW5nO1xuICBvcmlnaW5hbENoYXJzOiBudW1iZXI7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGZldGNoT25lUGFnZShcbiAgdXJsOiBzdHJpbmcsXG4gIG9wdGlvbnM6IHsgc2lnbmFsPzogQWJvcnRTaWduYWw7IHNlbGVjdG9yPzogc3RyaW5nIH1cbik6IFByb21pc2U8RmV0Y2hQYWdlUmVzdWx0PiB7XG4gIGxldCBwYWdlQ29udGVudDogc3RyaW5nO1xuICBsZXQgcGFnZVRpdGxlOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGxldCBzb3VyY2U6IFwiamluYVwiIHwgXCJkaXJlY3RcIiA9IFwiamluYVwiO1xuICBsZXQgamluYUVycm9yOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGxldCBjb250ZW50VHlwZTogc3RyaW5nIHwgdW5kZWZpbmVkO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZmV0Y2hWaWFKaW5hKHVybCwgb3B0aW9ucyk7XG4gICAgcGFnZUNvbnRlbnQgPSByZXN1bHQuY29udGVudDtcbiAgICBwYWdlVGl0bGUgPSByZXN1bHQudGl0bGU7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIC8vIENhcHR1cmUgSmluYSBmYWlsdXJlIHJlYXNvbiBmb3IgZGlhZ25vc3RpY3NcbiAgICBqaW5hRXJyb3IgPSBlcnIgaW5zdGFuY2VvZiBIdHRwRXJyb3JcbiAgICAgID8gYEppbmEgSFRUUCAke2Vyci5zdGF0dXNDb2RlfWBcbiAgICAgIDogKGVyciBhcyBFcnJvcikubWVzc2FnZSA/PyBTdHJpbmcoZXJyKTtcblxuICAgIC8vIFRyeSBPbGxhbWEgd2ViX2ZldGNoIGFzIGludGVybWVkaWF0ZSBmYWxsYmFjayBpZiBBUEkga2V5IGlzIGF2YWlsYWJsZVxuICAgIGNvbnN0IG9sbGFtYUtleSA9IGdldE9sbGFtYUFwaUtleSgpO1xuICAgIGlmIChvbGxhbWFLZXkpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IG9sbGFtYVJlc3VsdCA9IGF3YWl0IGZldGNoVmlhT2xsYW1hKHVybCwgb3B0aW9ucy5zaWduYWwpO1xuICAgICAgICBpZiAob2xsYW1hUmVzdWx0LmNvbnRlbnQgJiYgb2xsYW1hUmVzdWx0LmNvbnRlbnQubGVuZ3RoID49IDUwKSB7XG4gICAgICAgICAgcGFnZUNvbnRlbnQgPSBvbGxhbWFSZXN1bHQuY29udGVudDtcbiAgICAgICAgICBwYWdlVGl0bGUgPSBvbGxhbWFSZXN1bHQudGl0bGU7XG4gICAgICAgICAgc291cmNlID0gXCJkaXJlY3RcIjtcbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgY29udGVudDogcGFnZUNvbnRlbnQsXG4gICAgICAgICAgICB0aXRsZTogcGFnZVRpdGxlLFxuICAgICAgICAgICAgc291cmNlLFxuICAgICAgICAgICAgamluYUVycm9yLFxuICAgICAgICAgICAgY29udGVudFR5cGUsXG4gICAgICAgICAgICBvcmlnaW5hbENoYXJzOiBwYWdlQ29udGVudC5sZW5ndGgsXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIE9sbGFtYSBmZXRjaCBmYWlsZWQgdG9vIFx1MjAxNCBmYWxsIHRocm91Z2ggdG8gZGlyZWN0XG4gICAgICB9XG4gICAgfVxuXG4gICAgc291cmNlID0gXCJkaXJlY3RcIjtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGZldGNoRGlyZWN0RmFsbGJhY2sodXJsLCBvcHRpb25zLnNpZ25hbCk7XG4gICAgcGFnZUNvbnRlbnQgPSByZXN1bHQuY29udGVudDtcbiAgICBwYWdlVGl0bGUgPSByZXN1bHQudGl0bGU7XG4gICAgY29udGVudFR5cGUgPSByZXN1bHQuY29udGVudFR5cGU7XG4gIH1cblxuICByZXR1cm4ge1xuICAgIGNvbnRlbnQ6IHBhZ2VDb250ZW50LFxuICAgIHRpdGxlOiBwYWdlVGl0bGUsXG4gICAgc291cmNlLFxuICAgIGppbmFFcnJvcixcbiAgICBjb250ZW50VHlwZSxcbiAgICBvcmlnaW5hbENoYXJzOiBwYWdlQ29udGVudC5sZW5ndGgsXG4gIH07XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBEZXRhaWxzIEludGVyZmFjZVxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuaW50ZXJmYWNlIEZldGNoUGFnZURldGFpbHMge1xuICB1cmw6IHN0cmluZztcbiAgdGl0bGU/OiBzdHJpbmc7XG4gIGNoYXJDb3VudDogbnVtYmVyO1xuICBvcmlnaW5hbENoYXJzPzogbnVtYmVyO1xuICB0cnVuY2F0ZWQ6IGJvb2xlYW47XG4gIGNhY2hlZDogYm9vbGVhbjtcbiAgc291cmNlPzogXCJqaW5hXCIgfCBcImRpcmVjdFwiO1xuICBqaW5hRXJyb3I/OiBzdHJpbmc7XG4gIGNvbnRlbnRUeXBlPzogc3RyaW5nO1xuICBoYXNNb3JlPzogYm9vbGVhbjtcbiAgbmV4dE9mZnNldD86IG51bWJlcjtcbiAgb2Zmc2V0PzogbnVtYmVyO1xuICBzZWxlY3Rvcj86IHN0cmluZztcbiAgZXJyb3I/OiBzdHJpbmc7XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBUb29sIFJlZ2lzdHJhdGlvblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyRmV0Y2hQYWdlVG9vbChwaTogRXh0ZW5zaW9uQVBJKSB7XG4gIHBpLnJlZ2lzdGVyVG9vbCh7XG4gICAgbmFtZTogXCJmZXRjaF9wYWdlXCIsXG4gICAgbGFiZWw6IFwiRmV0Y2ggUGFnZVwiLFxuICAgIGRlc2NyaXB0aW9uOlxuICAgICAgXCJGZXRjaCBhIHdlYiBwYWdlIGFuZCBleHRyYWN0IGl0cyBjb250ZW50IGFzIGNsZWFuIG1hcmtkb3duLiBcIiArXG4gICAgICBcIlVzZSB0aGlzIHRvIHJlYWQgdGhlIGZ1bGwgY29udGVudCBvZiBVUkxzIGZvdW5kIHZpYSBzZWFyY2gtdGhlLXdlYi4gXCIgK1xuICAgICAgXCJVc2VzIEppbmEgUmVhZGVyIGZvciBoaWdoLXF1YWxpdHkgbWFya2Rvd24gZXh0cmFjdGlvbi4gXCIgK1xuICAgICAgXCJDb250cm9sIHRoZSBhbW91bnQgb2YgY29udGVudCByZXR1cm5lZCB3aXRoIG1heENoYXJzIChkZWZhdWx0OiA4MDAwLCBtYXg6IDMwMDAwKS5cIixcbiAgICBwcm9tcHRTbmlwcGV0OiBcIkZldGNoIGFuZCBleHRyYWN0IGNsZWFuIGNvbnRlbnQgZnJvbSBhIHdlYiBwYWdlIFVSTCBhcyBtYXJrZG93blwiLFxuICAgIHByb21wdEd1aWRlbGluZXM6IFtcbiAgICAgIFwiVXNlIGZldGNoX3BhZ2UgdG8gcmVhZCB0aGUgY29udGVudCBvZiBVUkxzIGZvdW5kIHZpYSBzZWFyY2gtdGhlLXdlYiB3aGVuIHlvdSBuZWVkIG1vcmUgZGV0YWlsIHRoYW4gc25pcHBldHMgcHJvdmlkZS5cIixcbiAgICAgIFwiU3RhcnQgd2l0aCB0aGUgZGVmYXVsdCBtYXhDaGFycyAoODAwMCkuIEluY3JlYXNlIG9ubHkgaWYgdGhlIGZpcnN0IGZldGNoIGxhY2tzIHRoZSBkZXRhaWwgeW91IG5lZWQuXCIsXG4gICAgICBcIkZvciB2ZXJ5IGxvbmcgcGFnZXMsIHVzZSBhIHNtYWxsZXIgbWF4Q2hhcnMgYW5kIGluY3JlYXNlIGlmIG5lZWRlZCBcdTIwMTQgdGhpcyBzYXZlcyBjb250ZXh0IHRva2Vucy5cIixcbiAgICAgIFwiVGhlIGV4dHJhY3RlZCBjb250ZW50IGlzIGFscmVhZHkgY2xlYW4gbWFya2Rvd24gXHUyMDE0IG5vIEhUTUwgdGFncywgbm8gbmF2aWdhdGlvbiwgbm8gYWRzLlwiLFxuICAgIF0sXG4gICAgcGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe1xuICAgICAgdXJsOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIlVSTCB0byBmZXRjaCBhbmQgZXh0cmFjdCBjb250ZW50IGZyb21cIiB9KSxcbiAgICAgIG1heENoYXJzOiBUeXBlLk9wdGlvbmFsKFxuICAgICAgICBUeXBlLk51bWJlcih7XG4gICAgICAgICAgbWluaW11bTogMTAwMCxcbiAgICAgICAgICBtYXhpbXVtOiAzMDAwMCxcbiAgICAgICAgICBkZWZhdWx0OiA4MDAwLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiBcIk1heGltdW0gY2hhcmFjdGVycyBvZiBjb250ZW50IHRvIHJldHVybiAoZGVmYXVsdDogODAwMCwgbWF4OiAzMDAwMCkuIENvbnRyb2xzIGNvbnRleHQgdG9rZW4gdXNhZ2UuXCIsXG4gICAgICAgIH0pXG4gICAgICApLFxuICAgICAgb2Zmc2V0OiBUeXBlLk9wdGlvbmFsKFxuICAgICAgICBUeXBlLk51bWJlcih7XG4gICAgICAgICAgbWluaW11bTogMCxcbiAgICAgICAgICBkZXNjcmlwdGlvbjogXCJDaGFyYWN0ZXIgb2Zmc2V0IHRvIHN0YXJ0IHJlYWRpbmcgZnJvbSAoZm9yIGNvbnRpbnVhdGlvbiBvZiB0cnVuY2F0ZWQgcGFnZXMpLiBVc2UgdGhlIG5leHRPZmZzZXQgdmFsdWUgZnJvbSBhIHByZXZpb3VzIGZldGNoX3BhZ2UgcmVzdWx0LlwiLFxuICAgICAgICB9KVxuICAgICAgKSxcbiAgICAgIHNlbGVjdG9yOiBUeXBlLk9wdGlvbmFsKFxuICAgICAgICBUeXBlLlN0cmluZyh7XG4gICAgICAgICAgZGVzY3JpcHRpb246IFwiQ1NTIHNlbGVjdG9yIHRvIGV4dHJhY3Qgb25seSBhIHNwZWNpZmljIHNlY3Rpb24gb2YgdGhlIHBhZ2UgKGUuZy4sICdtYWluJywgJ2FydGljbGUnLCAnLmFwaS1kb2NzJykuIFJlZHVjZXMgbm9pc2UgYW5kIHRva2VuIHVzYWdlLlwiLFxuICAgICAgICB9KVxuICAgICAgKSxcbiAgICB9KSxcblxuICAgIGFzeW5jIGV4ZWN1dGUodG9vbENhbGxJZCwgcGFyYW1zLCBzaWduYWwsIG9uVXBkYXRlLCBjdHgpIHtcbiAgICAgIGlmIChzaWduYWw/LmFib3J0ZWQpIHtcbiAgICAgICAgcmV0dXJuIHsgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiRmV0Y2ggY2FuY2VsbGVkLlwiIH1dLCBkZXRhaWxzOiB1bmRlZmluZWQgYXMgdW5rbm93biB9O1xuICAgICAgfVxuXG4gICAgICBjb25zdCBtYXhDaGFycyA9IHBhcmFtcy5tYXhDaGFycyA/PyA4MDAwO1xuICAgICAgY29uc3Qgb2Zmc2V0ID0gcGFyYW1zLm9mZnNldCA/PyAwO1xuICAgICAgY29uc3QgdXJsID0gcGFyYW1zLnVybC50cmltKCk7XG5cbiAgICAgIC8vIFZhbGlkYXRlIFVSTFxuICAgICAgdHJ5IHtcbiAgICAgICAgbmV3IFVSTCh1cmwpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBJbnZhbGlkIFVSTDogJHt1cmx9YCB9XSxcbiAgICAgICAgICBpc0Vycm9yOiB0cnVlLFxuICAgICAgICAgIGRldGFpbHM6IHsgZXJyb3I6IFwiSW52YWxpZCBVUkxcIiwgdXJsIH0gc2F0aXNmaWVzIFBhcnRpYWw8RmV0Y2hQYWdlRGV0YWlscz4sXG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIGlmIChpc0Jsb2NrZWRVcmwodXJsKSkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgQmxvY2tlZCBVUkw6IHJlcXVlc3RzIHRvIHByaXZhdGUvaW50ZXJuYWwgYWRkcmVzc2VzIGFyZSBub3QgYWxsb3dlZC5gIH1dLFxuICAgICAgICAgIGlzRXJyb3I6IHRydWUsXG4gICAgICAgICAgZGV0YWlsczogeyBlcnJvcjogXCJTU1JGIGJsb2NrZWRcIiwgdXJsIH0gc2F0aXNmaWVzIFBhcnRpYWw8RmV0Y2hQYWdlRGV0YWlscz4sXG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgICAgLy8gQ2FjaGUgbG9va3VwIChmdWxsIGNvbnRlbnQgY2FjaGVkLCBvZmZzZXQvdHJ1bmNhdGlvbiBhcHBsaWVkIGFmdGVyKVxuICAgICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgICBjb25zdCBjYWNoZUtleSA9IHBhcmFtcy5zZWxlY3RvciA/IGAke3VybH18c2VsOiR7cGFyYW1zLnNlbGVjdG9yfWAgOiB1cmw7XG4gICAgICBjb25zdCBjYWNoZWQgPSBwYWdlQ2FjaGUuZ2V0KGNhY2hlS2V5KTtcblxuICAgICAgaWYgKGNhY2hlZCkge1xuICAgICAgICBjb25zdCB0cnVuYyA9IHNtYXJ0VHJ1bmNhdGUoY2FjaGVkLmNvbnRlbnQsIG1heENoYXJzLCBvZmZzZXQpO1xuICAgICAgICBjb25zdCBvcHRzOiBGb3JtYXRQYWdlT3B0aW9ucyA9IHtcbiAgICAgICAgICB0aXRsZTogY2FjaGVkLnRpdGxlLFxuICAgICAgICAgIGNoYXJDb3VudDogdHJ1bmMuY29udGVudC5sZW5ndGgsXG4gICAgICAgICAgdHJ1bmNhdGVkOiB0cnVuYy50cnVuY2F0ZWQsXG4gICAgICAgICAgb3JpZ2luYWxDaGFyczogdHJ1bmMudHJ1bmNhdGVkID8gY2FjaGVkLmNvbnRlbnQubGVuZ3RoIDogdW5kZWZpbmVkLFxuICAgICAgICAgIGhhc01vcmU6IHRydW5jLmhhc01vcmUsXG4gICAgICAgICAgbmV4dE9mZnNldDogdHJ1bmMubmV4dE9mZnNldCxcbiAgICAgICAgfTtcbiAgICAgICAgY29uc3Qgb3V0cHV0ID0gZm9ybWF0UGFnZUNvbnRlbnQodXJsLCB0cnVuYy5jb250ZW50LCBvcHRzKTtcblxuICAgICAgICBjb25zdCBmaW5hbFRydW5jYXRpb24gPSB0cnVuY2F0ZUhlYWQob3V0cHV0LCB7IG1heExpbmVzOiBERUZBVUxUX01BWF9MSU5FUywgbWF4Qnl0ZXM6IERFRkFVTFRfTUFYX0JZVEVTIH0pO1xuICAgICAgICBjb25zdCBkZXRhaWxzOiBGZXRjaFBhZ2VEZXRhaWxzID0ge1xuICAgICAgICAgIHVybCxcbiAgICAgICAgICB0aXRsZTogY2FjaGVkLnRpdGxlLFxuICAgICAgICAgIGNoYXJDb3VudDogdHJ1bmMuY29udGVudC5sZW5ndGgsXG4gICAgICAgICAgb3JpZ2luYWxDaGFyczogY2FjaGVkLmNvbnRlbnQubGVuZ3RoLFxuICAgICAgICAgIHRydW5jYXRlZDogdHJ1bmMudHJ1bmNhdGVkLFxuICAgICAgICAgIGNhY2hlZDogdHJ1ZSxcbiAgICAgICAgICBzb3VyY2U6IGNhY2hlZC5zb3VyY2UsXG4gICAgICAgICAgaGFzTW9yZTogdHJ1bmMuaGFzTW9yZSxcbiAgICAgICAgICBuZXh0T2Zmc2V0OiB0cnVuYy5uZXh0T2Zmc2V0LFxuICAgICAgICAgIG9mZnNldDogb2Zmc2V0IHx8IHVuZGVmaW5lZCxcbiAgICAgICAgfTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogZmluYWxUcnVuY2F0aW9uLmNvbnRlbnQgfV0sXG4gICAgICAgICAgZGV0YWlscyxcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgZG9tYWluID0gZXh0cmFjdERvbWFpbih1cmwpO1xuICAgICAgb25VcGRhdGU/Lih7IGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgRmV0Y2hpbmcgJHtkb21haW59Li4uYCB9XSwgZGV0YWlsczogdW5kZWZpbmVkIGFzIHVua25vd24gfSk7XG5cbiAgICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgICAgLy8gRmV0Y2ggcGFnZSBjb250ZW50XG4gICAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAgIGxldCByZXN1bHQ6IEZldGNoUGFnZVJlc3VsdDtcbiAgICAgIHRyeSB7XG4gICAgICAgIHJlc3VsdCA9IGF3YWl0IGZldGNoT25lUGFnZSh1cmwsIHsgc2lnbmFsLCBzZWxlY3RvcjogcGFyYW1zLnNlbGVjdG9yIH0pO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnIgaW5zdGFuY2VvZiBIdHRwRXJyb3JcbiAgICAgICAgICA/IGBIVFRQICR7ZXJyLnN0YXR1c0NvZGV9YFxuICAgICAgICAgIDogKGVyciBhcyBFcnJvcikubWVzc2FnZSA/PyBTdHJpbmcoZXJyKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYEZhaWxlZCB0byBmZXRjaCAke2RvbWFpbn06ICR7bWVzc2FnZX1gIH1dLFxuICAgICAgICAgIGlzRXJyb3I6IHRydWUsXG4gICAgICAgICAgZGV0YWlsczogeyBlcnJvcjogbWVzc2FnZSwgdXJsIH0gc2F0aXNmaWVzIFBhcnRpYWw8RmV0Y2hQYWdlRGV0YWlscz4sXG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIC8vIENoZWNrIGZvciBlbXB0eSBjb250ZW50XG4gICAgICBpZiAoIXJlc3VsdC5jb250ZW50IHx8IHJlc3VsdC5jb250ZW50Lmxlbmd0aCA8IDUwKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBQYWdlIGF0ICR7ZG9tYWlufSByZXR1cm5lZCBubyBleHRyYWN0YWJsZSBjb250ZW50LmAgfV0sXG4gICAgICAgICAgZGV0YWlsczogeyB1cmwsIGNoYXJDb3VudDogMCwgc291cmNlOiByZXN1bHQuc291cmNlLCBjYWNoZWQ6IGZhbHNlLCB0cnVuY2F0ZWQ6IGZhbHNlLCBqaW5hRXJyb3I6IHJlc3VsdC5qaW5hRXJyb3IgfSBzYXRpc2ZpZXMgRmV0Y2hQYWdlRGV0YWlscyxcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgLy8gQ2FjaGUgdGhlIGZ1bGwgY29udGVudFxuICAgICAgcGFnZUNhY2hlLnNldChjYWNoZUtleSwgeyBjb250ZW50OiByZXN1bHQuY29udGVudCwgdGl0bGU6IHJlc3VsdC50aXRsZSwgc291cmNlOiByZXN1bHQuc291cmNlIH0pO1xuXG4gICAgICAvLyBTbWFydCB0cnVuY2F0ZSB3aXRoIG9mZnNldFxuICAgICAgY29uc3QgdHJ1bmMgPSBzbWFydFRydW5jYXRlKHJlc3VsdC5jb250ZW50LCBtYXhDaGFycywgb2Zmc2V0KTtcblxuICAgICAgY29uc3Qgb3B0czogRm9ybWF0UGFnZU9wdGlvbnMgPSB7XG4gICAgICAgIHRpdGxlOiByZXN1bHQudGl0bGUsXG4gICAgICAgIGNoYXJDb3VudDogdHJ1bmMuY29udGVudC5sZW5ndGgsXG4gICAgICAgIHRydW5jYXRlZDogdHJ1bmMudHJ1bmNhdGVkLFxuICAgICAgICBvcmlnaW5hbENoYXJzOiB0cnVuYy50cnVuY2F0ZWQgPyByZXN1bHQub3JpZ2luYWxDaGFycyA6IHVuZGVmaW5lZCxcbiAgICAgICAgaGFzTW9yZTogdHJ1bmMuaGFzTW9yZSxcbiAgICAgICAgbmV4dE9mZnNldDogdHJ1bmMubmV4dE9mZnNldCxcbiAgICAgIH07XG5cbiAgICAgIGNvbnN0IG91dHB1dCA9IGZvcm1hdFBhZ2VDb250ZW50KHVybCwgdHJ1bmMuY29udGVudCwgb3B0cyk7XG5cbiAgICAgIGNvbnN0IGZpbmFsVHJ1bmNhdGlvbiA9IHRydW5jYXRlSGVhZChvdXRwdXQsIHsgbWF4TGluZXM6IERFRkFVTFRfTUFYX0xJTkVTLCBtYXhCeXRlczogREVGQVVMVF9NQVhfQllURVMgfSk7XG4gICAgICBsZXQgY29udGVudCA9IGZpbmFsVHJ1bmNhdGlvbi5jb250ZW50O1xuICAgICAgaWYgKGZpbmFsVHJ1bmNhdGlvbi50cnVuY2F0ZWQpIHtcbiAgICAgICAgY29uc3QgdGVtcEZpbGUgPSBhd2FpdCAocGkgYXMgYW55KS53cml0ZVRlbXBGaWxlKG91dHB1dCwgeyBwcmVmaXg6IFwiZmV0Y2gtcGFnZS1cIiB9KTtcbiAgICAgICAgY29udGVudCArPSBgXFxuXFxuW1RydW5jYXRlZCB0byBmaXQgY29udGV4dC4gRnVsbCBjb250ZW50OiAke3RlbXBGaWxlfV1gO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBkZXRhaWxzOiBGZXRjaFBhZ2VEZXRhaWxzID0ge1xuICAgICAgICB1cmwsXG4gICAgICAgIHRpdGxlOiByZXN1bHQudGl0bGUsXG4gICAgICAgIGNoYXJDb3VudDogdHJ1bmMuY29udGVudC5sZW5ndGgsXG4gICAgICAgIG9yaWdpbmFsQ2hhcnM6IHJlc3VsdC5vcmlnaW5hbENoYXJzLFxuICAgICAgICB0cnVuY2F0ZWQ6IHRydW5jLnRydW5jYXRlZCxcbiAgICAgICAgY2FjaGVkOiBmYWxzZSxcbiAgICAgICAgc291cmNlOiByZXN1bHQuc291cmNlLFxuICAgICAgICBqaW5hRXJyb3I6IHJlc3VsdC5qaW5hRXJyb3IsXG4gICAgICAgIGNvbnRlbnRUeXBlOiByZXN1bHQuY29udGVudFR5cGUsXG4gICAgICAgIGhhc01vcmU6IHRydW5jLmhhc01vcmUsXG4gICAgICAgIG5leHRPZmZzZXQ6IHRydW5jLm5leHRPZmZzZXQsXG4gICAgICAgIG9mZnNldDogb2Zmc2V0IHx8IHVuZGVmaW5lZCxcbiAgICAgICAgc2VsZWN0b3I6IHBhcmFtcy5zZWxlY3RvcixcbiAgICAgIH07XG5cbiAgICAgIHJldHVybiB7XG4gICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBjb250ZW50IH1dLFxuICAgICAgICBkZXRhaWxzLFxuICAgICAgfTtcbiAgICB9LFxuXG4gICAgcmVuZGVyQ2FsbChhcmdzLCB0aGVtZSkge1xuICAgICAgY29uc3QgZG9tYWluID0gZXh0cmFjdERvbWFpbihhcmdzLnVybCk7XG4gICAgICBsZXQgdGV4dCA9IHRoZW1lLmZnKFwidG9vbFRpdGxlXCIsIHRoZW1lLmJvbGQoXCJmZXRjaF9wYWdlIFwiKSk7XG4gICAgICB0ZXh0ICs9IHRoZW1lLmZnKFwiYWNjZW50XCIsIGRvbWFpbik7XG5cbiAgICAgIGNvbnN0IG1ldGE6IHN0cmluZ1tdID0gW107XG4gICAgICBpZiAoYXJncy5tYXhDaGFycyAmJiBhcmdzLm1heENoYXJzICE9PSA4MDAwKSBtZXRhLnB1c2goYG1heCAkeyhhcmdzLm1heENoYXJzIC8gMTAwMCkudG9GaXhlZCgwKX1rYCk7XG4gICAgICBpZiAoYXJncy5vZmZzZXQpIG1ldGEucHVzaChgb2Zmc2V0OiR7YXJncy5vZmZzZXR9YCk7XG4gICAgICBpZiAoYXJncy5zZWxlY3RvcikgbWV0YS5wdXNoKGBzZWw6XCIke2FyZ3Muc2VsZWN0b3J9XCJgKTtcbiAgICAgIGlmIChtZXRhLmxlbmd0aCA+IDApIHtcbiAgICAgICAgdGV4dCArPSBcIiBcIiArIHRoZW1lLmZnKFwiZGltXCIsIGAoJHttZXRhLmpvaW4oXCIsIFwiKX0pYCk7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiBuZXcgVGV4dCh0ZXh0LCAwLCAwKTtcbiAgICB9LFxuXG4gICAgcmVuZGVyUmVzdWx0KHJlc3VsdCwgeyBleHBhbmRlZCB9LCB0aGVtZSkge1xuICAgICAgY29uc3QgZGV0YWlscyA9IHJlc3VsdC5kZXRhaWxzIGFzIEZldGNoUGFnZURldGFpbHMgfCB1bmRlZmluZWQ7XG4gICAgICBpZiAoZGV0YWlscz8uZXJyb3IpIHtcbiAgICAgICAgcmV0dXJuIG5ldyBUZXh0KHRoZW1lLmZnKFwiZXJyb3JcIiwgYFx1MjcxNyAke2RldGFpbHMuZXJyb3J9YCksIDAsIDApO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBkb21haW4gPSBleHRyYWN0RG9tYWluKGRldGFpbHM/LnVybCB8fCBcIlwiKTtcbiAgICAgIGNvbnN0IHRpdGxlID0gZGV0YWlscz8udGl0bGUgPyBgIFx1MjAxNCAke2RldGFpbHMudGl0bGV9YCA6IFwiXCI7XG4gICAgICBjb25zdCBjaGFycyA9IGRldGFpbHM/LmNoYXJDb3VudCA/IGAkeyhkZXRhaWxzLmNoYXJDb3VudCAvIDEwMDApLnRvRml4ZWQoMSl9ayBjaGFyc2AgOiBcIlwiO1xuICAgICAgY29uc3QgY2FjaGVUYWcgPSBkZXRhaWxzPy5jYWNoZWQgPyB0aGVtZS5mZyhcImRpbVwiLCBcIiBbY2FjaGVkXVwiKSA6IFwiXCI7XG4gICAgICBjb25zdCBzb3VyY2VUYWcgPSBkZXRhaWxzPy5zb3VyY2UgPT09IFwiZGlyZWN0XCIgPyB0aGVtZS5mZyhcImRpbVwiLCBcIiBbZGlyZWN0XVwiKSA6IFwiXCI7XG4gICAgICBjb25zdCB0cnVuY1RhZyA9IGRldGFpbHM/LnRydW5jYXRlZCAmJiBkZXRhaWxzPy5vcmlnaW5hbENoYXJzXG4gICAgICAgID8gdGhlbWUuZmcoXCJkaW1cIiwgYCBbJHsoZGV0YWlscy5vcmlnaW5hbENoYXJzIC8gMTAwMCkudG9GaXhlZCgwKX1rIHRvdGFsXWApXG4gICAgICAgIDogXCJcIjtcbiAgICAgIGNvbnN0IG1vcmVUYWcgPSBkZXRhaWxzPy5oYXNNb3JlICYmIGRldGFpbHM/Lm5leHRPZmZzZXRcbiAgICAgICAgPyB0aGVtZS5mZyhcImFjY2VudFwiLCBgIFttb3JlXHUyMTkyb2Zmc2V0OiR7ZGV0YWlscy5uZXh0T2Zmc2V0fV1gKVxuICAgICAgICA6IFwiXCI7XG4gICAgICBjb25zdCBqaW5hVGFnID0gZGV0YWlscz8uamluYUVycm9yXG4gICAgICAgID8gdGhlbWUuZmcoXCJ3YXJuaW5nXCIsIGAgW2ppbmEgZmFpbGVkOiAke2RldGFpbHMuamluYUVycm9yfV1gKVxuICAgICAgICA6IFwiXCI7XG5cbiAgICAgIGxldCB0ZXh0ID0gdGhlbWUuZmcoXCJzdWNjZXNzXCIsIGBcdTI3MTMgJHtkb21haW59JHt0aXRsZX1gKSArIGAgJHtjaGFyc31gICtcbiAgICAgICAgY2FjaGVUYWcgKyBzb3VyY2VUYWcgKyB0cnVuY1RhZyArIG1vcmVUYWcgKyBqaW5hVGFnO1xuXG4gICAgICBpZiAoZXhwYW5kZWQpIHtcbiAgICAgICAgY29uc3QgY29udGVudCA9IHJlc3VsdC5jb250ZW50WzBdO1xuICAgICAgICBpZiAoY29udGVudD8udHlwZSA9PT0gXCJ0ZXh0XCIpIHtcbiAgICAgICAgICBjb25zdCBwcmV2aWV3ID0gY29udGVudC50ZXh0LnNwbGl0KFwiXFxuXCIpLnNsaWNlKDAsIDgpLmpvaW4oXCJcXG5cIik7XG4gICAgICAgICAgdGV4dCArPSBcIlxcblxcblwiICsgdGhlbWUuZmcoXCJkaW1cIiwgcHJldmlldyk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgcmV0dXJuIG5ldyBUZXh0KHRleHQsIDAsIDApO1xuICAgIH0sXG4gIH0pO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBV0EsU0FBUyxjQUFjLG1CQUFtQix5QkFBeUI7QUFDbkUsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsWUFBWTtBQUVyQixTQUFTLG1CQUFtQjtBQUM1QixTQUFTLGFBQWEsaUJBQWlCO0FBQ3ZDLFNBQVMsZUFBZSxvQkFBb0I7QUFDNUMsU0FBUyx5QkFBaUQ7QUFDMUQsU0FBUyx1QkFBdUI7QUFhaEMsTUFBTSxZQUFZLElBQUksWUFBd0IsRUFBRSxLQUFLLElBQUksT0FBTyxJQUFRLENBQUM7QUFDekUsVUFBVSxtQkFBbUIsSUFBTztBQVVwQyxlQUFlLGFBQ2IsS0FDQSxVQUF1RCxDQUFDLEdBQ1Y7QUFDOUMsUUFBTSxVQUFVLHFCQUFxQixHQUFHO0FBRXhDLFFBQU0sVUFBa0M7QUFBQSxJQUN0QyxVQUFVO0FBQUEsSUFDVixtQkFBbUI7QUFBQSxJQUNuQixjQUFjO0FBQUEsRUFDaEI7QUFHQSxRQUFNLFVBQVUsUUFBUSxJQUFJO0FBQzVCLE1BQUksU0FBUztBQUNYLFlBQVEsZUFBZSxJQUFJLFVBQVUsT0FBTztBQUFBLEVBQzlDO0FBR0EsTUFBSSxRQUFRLFVBQVU7QUFDcEIsWUFBUSxtQkFBbUIsSUFBSSxRQUFRO0FBQUEsRUFDekM7QUFFQSxR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MUQ7QUFFSixVQUFJLE9BQU8sTUFBTSxHQUFHLFdBQVcsVUFBSyxNQUFNLEdBQUcsS0FBSyxFQUFFLElBQUksSUFBSSxLQUFLLEtBQy9ELFdBQVcsWUFBWSxXQUFXLFVBQVU7QUFFOUMsVUFBSSxVQUFVO0FBQ1osY0FBTSxVQUFVLE9BQU8sUUFBUSxDQUFDO0FBQ2hDLFlBQUksU0FBUyxTQUFTLFFBQVE7QUFDNUIsZ0JBQU0sVUFBVSxRQUFRLEtBQUssTUFBTSxJQUFJLEVBQUUsTUFBTSxHQUFHLENBQUMsRUFBRSxLQUFLLElBQUk7QUFDOUQsa0JBQVEsU0FBUyxNQUFNLEdBQUcsT0FBTyxPQUFPO0FBQUEsUUFDMUM7QUFBQSxNQUNGO0FBRUEsYUFBTyxJQUFJLEtBQUssTUFBTSxHQUFHLENBQUM7QUFBQSxJQUM1QjtBQUFBLEVBQ0YsQ0FBQztBQUNIOyIsCiAgIm5hbWVzIjogWyJ0ZXh0IiwgInRydW5jIiwgIm9wdHMiLCAib3V0cHV0IiwgImZpbmFsVHJ1bmNhdGlvbiIsICJkZXRhaWxzIl0KfQo=
