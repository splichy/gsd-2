import { Type } from "@sinclair/typebox";
const cache = /* @__PURE__ */ new Map();
const MAX_CACHE_SIZE = 200;
function registerActionCacheTools(pi, deps) {
  pi.registerTool({
    name: "browser_action_cache",
    label: "Browser Action Cache",
    description: "Manage the action cache that maps page structure + intent \u2192 resolved selectors. Cache reduces token cost on repeat visits to same pages. Actions: 'stats' (show cache metrics), 'get' (lookup cached selector), 'put' (store a selector mapping), 'clear' (flush cache).",
    parameters: Type.Object({
      action: Type.String({
        description: "Cache action: 'stats', 'get', 'put', or 'clear'."
      }),
      intent: Type.Optional(
        Type.String({ description: "Semantic intent key (for get/put). E.g., 'submit_form', 'close_dialog'." })
      ),
      selector: Type.Optional(
        Type.String({ description: "CSS selector to cache (for put)." })
      ),
      score: Type.Optional(
        Type.Number({ description: "Confidence score 0\u20131 for the cached selector (for put)." })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const { page: p } = await deps.ensureBrowser();
        const url = p.url();
        switch (params.action) {
          case "stats": {
            const entries = [...cache.values()];
            const totalHits = entries.reduce((sum, e) => sum + e.hitCount, 0);
            return {
              content: [{
                type: "text",
                text: `Action cache: ${cache.size} entries, ${totalHits} total hits
Max size: ${MAX_CACHE_SIZE}`
              }],
              details: {
                size: cache.size,
                maxSize: MAX_CACHE_SIZE,
                totalHits,
                entries: entries.map((e) => ({
                  url: e.url,
                  selector: e.selector,
                  hitCount: e.hitCount,
                  score: e.score
                }))
              }
            };
          }
          case "get": {
            if (!params.intent) {
              return {
                content: [{ type: "text", text: "Intent parameter required for 'get' action." }],
                details: { error: "missing_intent" },
                isError: true
              };
            }
            const domHash = await computeDomHash(p);
            const key = buildCacheKey(url, domHash, params.intent);
            const entry = cache.get(key);
            if (!entry) {
              return {
                content: [{ type: "text", text: `Cache miss for intent "${params.intent}" on ${url}` }],
                details: { hit: false, intent: params.intent, url }
              };
            }
            const exists = await p.locator(entry.selector).first().isVisible().catch(() => false);
            if (!exists) {
              cache.delete(key);
              return {
                content: [{ type: "text", text: `Cache entry stale (selector no longer visible): ${entry.selector}` }],
                details: { hit: false, stale: true, selector: entry.selector }
              };
            }
            entry.hitCount++;
            return {
              content: [{
                type: "text",
                text: `Cache hit: "${params.intent}" \u2192 ${entry.selector} (score: ${entry.score}, hits: ${entry.hitCount})`
              }],
              details: { hit: true, ...entry }
            };
          }
          case "put": {
            if (!params.intent || !params.selector) {
              return {
                content: [{ type: "text", text: "Intent and selector parameters required for 'put' action." }],
                details: { error: "missing_params" },
                isError: true
              };
            }
            const domHash = await computeDomHash(p);
            const key = buildCacheKey(url, domHash, params.intent);
            if (cache.size >= MAX_CACHE_SIZE && !cache.has(key)) {
              const oldestKey = [...cache.entries()].sort(([, a], [, b]) => a.timestamp - b.timestamp)[0]?.[0];
              if (oldestKey) cache.delete(oldestKey);
            }
            const entry = {
              selector: params.selector,
              score: params.score ?? 1,
              url,
              domHash,
              timestamp: Date.now(),
              hitCount: 0
            };
            cache.set(key, entry);
            return {
              content: [{
                type: "text",
                text: `Cached: "${params.intent}" \u2192 ${params.selector} (cache size: ${cache.size})`
              }],
              details: { stored: true, key, ...entry, cacheSize: cache.size }
            };
          }
          case "clear": {
            const size = cache.size;
            cache.clear();
            return {
              content: [{ type: "text", text: `Action cache cleared (${size} entries removed).` }],
              details: { cleared: size }
            };
          }
          default:
            return {
              content: [{ type: "text", text: `Unknown action: ${params.action}. Use 'stats', 'get', 'put', or 'clear'.` }],
              details: { error: "unknown_action" },
              isError: true
            };
        }
      } catch (err) {
        return {
          content: [{ type: "text", text: `Action cache error: ${err.message}` }],
          details: { error: err.message },
          isError: true
        };
      }
    }
  });
}
function buildCacheKey(url, domHash, intent) {
  let normalized;
  try {
    const u = new URL(url);
    normalized = `${u.origin}${u.pathname}`;
  } catch {
    normalized = url;
  }
  return `${normalized}|${domHash}|${intent}`;
}
async function computeDomHash(page) {
  try {
    return await page.evaluate(() => {
      const tags = /* @__PURE__ */ new Map();
      const all = document.querySelectorAll("*");
      for (const el of all) {
        const tag = el.tagName;
        tags.set(tag, (tags.get(tag) ?? 0) + 1);
      }
      const entries = [...tags.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const str = entries.map(([t, c]) => `${t}:${c}`).join("|");
      let h = 5381;
      for (let i = 0; i < str.length; i++) {
        h = (h << 5) - h + str.charCodeAt(i) | 0;
      }
      return (h >>> 0).toString(16);
    });
  } catch {
    return "unknown";
  }
}
export {
  registerActionCacheTools
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2Jyb3dzZXItdG9vbHMvdG9vbHMvYWN0aW9uLWNhY2hlLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdHlwZSB7IEV4dGVuc2lvbkFQSSB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuaW1wb3J0IHsgVHlwZSB9IGZyb20gXCJAc2luY2xhaXIvdHlwZWJveFwiO1xuaW1wb3J0IHR5cGUgeyBUb29sRGVwcyB9IGZyb20gXCIuLi9zdGF0ZS5qc1wiO1xuXG4vKipcbiAqIEFjdGlvbiBjYWNoaW5nIFx1MjAxNCBjYWNoZSBzZW1hbnRpYyBpbnRlbnQgXHUyMTkyIHNlbGVjdG9yIG1hcHBpbmdzIHRvIHNraXAgTExNIGluZmVyZW5jZSBvbiByZXBlYXQgdmlzaXRzLlxuICogSW50ZXJuYWwgb3B0aW1pemF0aW9uIHRoYXQgaG9va3MgaW50byBicm93c2VyX2ZpbmRfYmVzdCAvIGJyb3dzZXJfYWN0LlxuICovXG5cbmludGVyZmFjZSBDYWNoZUVudHJ5IHtcblx0c2VsZWN0b3I6IHN0cmluZztcblx0c2NvcmU6IG51bWJlcjtcblx0dXJsOiBzdHJpbmc7XG5cdGRvbUhhc2g6IHN0cmluZztcblx0dGltZXN0YW1wOiBudW1iZXI7XG5cdGhpdENvdW50OiBudW1iZXI7XG59XG5cbmNvbnN0IGNhY2hlID0gbmV3IE1hcDxzdHJpbmcsIENhY2hlRW50cnk+KCk7XG5jb25zdCBNQVhfQ0FDSEVfU0laRSA9IDIwMDtcblxuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyQWN0aW9uQ2FjaGVUb29scyhwaTogRXh0ZW5zaW9uQVBJLCBkZXBzOiBUb29sRGVwcyk6IHZvaWQge1xuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdC8vIGJyb3dzZXJfYWN0aW9uX2NhY2hlXG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblx0cGkucmVnaXN0ZXJUb29sKHtcblx0XHRuYW1lOiBcImJyb3dzZXJfYWN0aW9uX2NhY2hlXCIsXG5cdFx0bGFiZWw6IFwiQnJvd3NlciBBY3Rpb24gQ2FjaGVcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiTWFuYWdlIHRoZSBhY3Rpb24gY2FjaGUgdGhhdCBtYXBzIHBhZ2Ugc3RydWN0dXJlICsgaW50ZW50IFx1MjE5MiByZXNvbHZlZCBzZWxlY3RvcnMuIFwiICtcblx0XHRcdFwiQ2FjaGUgcmVkdWNlcyB0b2tlbiBjb3N0IG9uIHJlcGVhdCB2aXNpdHMgdG8gc2FtZSBwYWdlcy4gXCIgK1xuXHRcdFx0XCJBY3Rpb25zOiAnc3RhdHMnIChzaG93IGNhY2hlIG1ldHJpY3MpLCAnZ2V0JyAobG9va3VwIGNhY2hlZCBzZWxlY3RvciksIFwiICtcblx0XHRcdFwiJ3B1dCcgKHN0b3JlIGEgc2VsZWN0b3IgbWFwcGluZyksICdjbGVhcicgKGZsdXNoIGNhY2hlKS5cIixcblx0XHRwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG5cdFx0XHRhY3Rpb246IFR5cGUuU3RyaW5nKHtcblx0XHRcdFx0ZGVzY3JpcHRpb246IFwiQ2FjaGUgYWN0aW9uOiAnc3RhdHMnLCAnZ2V0JywgJ3B1dCcsIG9yICdjbGVhcicuXCIsXG5cdFx0XHR9KSxcblx0XHRcdGludGVudDogVHlwZS5PcHRpb25hbChcblx0XHRcdFx0VHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJTZW1hbnRpYyBpbnRlbnQga2V5IChmb3IgZ2V0L3B1dCkuIEUuZy4sICdzdWJtaXRfZm9ybScsICdjbG9zZV9kaWFsb2cnLlwiIH0pLFxuXHRcdFx0KSxcblx0XHRcdHNlbGVjdG9yOiBUeXBlLk9wdGlvbmFsKFxuXHRcdFx0XHRUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIkNTUyBzZWxlY3RvciB0byBjYWNoZSAoZm9yIHB1dCkuXCIgfSksXG5cdFx0XHQpLFxuXHRcdFx0c2NvcmU6IFR5cGUuT3B0aW9uYWwoXG5cdFx0XHRcdFR5cGUuTnVtYmVyKHsgZGVzY3JpcHRpb246IFwiQ29uZmlkZW5jZSBzY29yZSAwXHUyMDEzMSBmb3IgdGhlIGNhY2hlZCBzZWxlY3RvciAoZm9yIHB1dCkuXCIgfSksXG5cdFx0XHQpLFxuXHRcdH0pLFxuXG5cdFx0YXN5bmMgZXhlY3V0ZShfdG9vbENhbGxJZCwgcGFyYW1zLCBfc2lnbmFsLCBfb25VcGRhdGUsIF9jdHgpIHtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IHsgcGFnZTogcCB9ID0gYXdhaXQgZGVwcy5lbnN1cmVCcm93c2VyKCk7XG5cdFx0XHRcdGNvbnN0IHVybCA9IHAudXJsKCk7XG5cblx0XHRcdFx0c3dpdGNoIChwYXJhbXMuYWN0aW9uKSB7XG5cdFx0XHRcdFx0Y2FzZSBcInN0YXRzXCI6IHtcblx0XHRcdFx0XHRcdGNvbnN0IGVudHJpZXMgPSBbLi4uY2FjaGUudmFsdWVzKCldO1xuXHRcdFx0XHRcdFx0Y29uc3QgdG90YWxIaXRzID0gZW50cmllcy5yZWR1Y2UoKHN1bSwgZSkgPT4gc3VtICsgZS5oaXRDb3VudCwgMCk7XG5cdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHRjb250ZW50OiBbe1xuXHRcdFx0XHRcdFx0XHRcdHR5cGU6IFwidGV4dFwiLFxuXHRcdFx0XHRcdFx0XHRcdHRleHQ6IGBBY3Rpb24gY2FjaGU6ICR7Y2FjaGUuc2l6ZX0gZW50cmllcywgJHt0b3RhbEhpdHN9IHRvdGFsIGhpdHNcXG5NYXggc2l6ZTogJHtNQVhfQ0FDSEVfU0laRX1gLFxuXHRcdFx0XHRcdFx0XHR9XSxcblx0XHRcdFx0XHRcdFx0ZGV0YWlsczoge1xuXHRcdFx0XHRcdFx0XHRcdHNpemU6IGNhY2hlLnNpemUsXG5cdFx0XHRcdFx0XHRcdFx0bWF4U2l6ZTogTUFYX0NBQ0hFX1NJWkUsXG5cdFx0XHRcdFx0XHRcdFx0dG90YWxIaXRzLFxuXHRcdFx0XHRcdFx0XHRcdGVudHJpZXM6IGVudHJpZXMubWFwKChlKSA9PiAoe1xuXHRcdFx0XHRcdFx0XHRcdFx0dXJsOiBlLnVybCxcblx0XHRcdFx0XHRcdFx0XHRcdHNlbGVjdG9yOiBlLnNlbGVjdG9yLFxuXHRcdFx0XHRcdFx0XHRcdFx0aGl0Q291bnQ6IGUuaGl0Q291bnQsXG5cdFx0XHRcdFx0XHRcdFx0XHRzY29yZTogZS5zY29yZSxcblx0XHRcdFx0XHRcdFx0XHR9KSksXG5cdFx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGNhc2UgXCJnZXRcIjoge1xuXHRcdFx0XHRcdFx0aWYgKCFwYXJhbXMuaW50ZW50KSB7XG5cdFx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiSW50ZW50IHBhcmFtZXRlciByZXF1aXJlZCBmb3IgJ2dldCcgYWN0aW9uLlwiIH1dLFxuXHRcdFx0XHRcdFx0XHRcdGRldGFpbHM6IHsgZXJyb3I6IFwibWlzc2luZ19pbnRlbnRcIiB9LFxuXHRcdFx0XHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsXG5cdFx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdGNvbnN0IGRvbUhhc2ggPSBhd2FpdCBjb21wdXRlRG9tSGFzaChwKTtcblx0XHRcdFx0XHRcdGNvbnN0IGtleSA9IGJ1aWxkQ2FjaGVLZXkodXJsLCBkb21IYXNoLCBwYXJhbXMuaW50ZW50KTtcblx0XHRcdFx0XHRcdGNvbnN0IGVudHJ5ID0gY2FjaGUuZ2V0KGtleSk7XG5cblx0XHRcdFx0XHRcdGlmICghZW50cnkpIHtcblx0XHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYENhY2hlIG1pc3MgZm9yIGludGVudCBcIiR7cGFyYW1zLmludGVudH1cIiBvbiAke3VybH1gIH1dLFxuXHRcdFx0XHRcdFx0XHRcdGRldGFpbHM6IHsgaGl0OiBmYWxzZSwgaW50ZW50OiBwYXJhbXMuaW50ZW50LCB1cmwgfSxcblx0XHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0Ly8gVmFsaWRhdGUgdGhlIGNhY2hlZCBzZWxlY3RvciBzdGlsbCBleGlzdHNcblx0XHRcdFx0XHRcdGNvbnN0IGV4aXN0cyA9IGF3YWl0IHAubG9jYXRvcihlbnRyeS5zZWxlY3RvcikuZmlyc3QoKS5pc1Zpc2libGUoKS5jYXRjaCgoKSA9PiBmYWxzZSk7XG5cdFx0XHRcdFx0XHRpZiAoIWV4aXN0cykge1xuXHRcdFx0XHRcdFx0XHRjYWNoZS5kZWxldGUoa2V5KTtcblx0XHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYENhY2hlIGVudHJ5IHN0YWxlIChzZWxlY3RvciBubyBsb25nZXIgdmlzaWJsZSk6ICR7ZW50cnkuc2VsZWN0b3J9YCB9XSxcblx0XHRcdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGhpdDogZmFsc2UsIHN0YWxlOiB0cnVlLCBzZWxlY3RvcjogZW50cnkuc2VsZWN0b3IgfSxcblx0XHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0ZW50cnkuaGl0Q291bnQrKztcblx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7XG5cdFx0XHRcdFx0XHRcdFx0dHlwZTogXCJ0ZXh0XCIsXG5cdFx0XHRcdFx0XHRcdFx0dGV4dDogYENhY2hlIGhpdDogXCIke3BhcmFtcy5pbnRlbnR9XCIgXHUyMTkyICR7ZW50cnkuc2VsZWN0b3J9IChzY29yZTogJHtlbnRyeS5zY29yZX0sIGhpdHM6ICR7ZW50cnkuaGl0Q291bnR9KWAsXG5cdFx0XHRcdFx0XHRcdH1dLFxuXHRcdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGhpdDogdHJ1ZSwgLi4uZW50cnkgfSxcblx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Y2FzZSBcInB1dFwiOiB7XG5cdFx0XHRcdFx0XHRpZiAoIXBhcmFtcy5pbnRlbnQgfHwgIXBhcmFtcy5zZWxlY3Rvcikge1xuXHRcdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkludGVudCBhbmQgc2VsZWN0b3IgcGFyYW1ldGVycyByZXF1aXJlZCBmb3IgJ3B1dCcgYWN0aW9uLlwiIH1dLFxuXHRcdFx0XHRcdFx0XHRcdGRldGFpbHM6IHsgZXJyb3I6IFwibWlzc2luZ19wYXJhbXNcIiB9LFxuXHRcdFx0XHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsXG5cdFx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdGNvbnN0IGRvbUhhc2ggPSBhd2FpdCBjb21wdXRlRG9tSGFzaChwKTtcblx0XHRcdFx0XHRcdGNvbnN0IGtleSA9IGJ1aWxkQ2FjaGVLZXkodXJsLCBkb21IYXNoLCBwYXJhbXMuaW50ZW50KTtcblxuXHRcdFx0XHRcdFx0Ly8gRXZpY3Qgb2xkZXN0IGVudHJpZXMgaWYgYXQgY2FwYWNpdHlcblx0XHRcdFx0XHRcdGlmIChjYWNoZS5zaXplID49IE1BWF9DQUNIRV9TSVpFICYmICFjYWNoZS5oYXMoa2V5KSkge1xuXHRcdFx0XHRcdFx0XHRjb25zdCBvbGRlc3RLZXkgPSBbLi4uY2FjaGUuZW50cmllcygpXVxuXHRcdFx0XHRcdFx0XHRcdC5zb3J0KChbLCBhXSwgWywgYl0pID0+IGEudGltZXN0YW1wIC0gYi50aW1lc3RhbXApWzBdPy5bMF07XG5cdFx0XHRcdFx0XHRcdGlmIChvbGRlc3RLZXkpIGNhY2hlLmRlbGV0ZShvbGRlc3RLZXkpO1xuXHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHRjb25zdCBlbnRyeTogQ2FjaGVFbnRyeSA9IHtcblx0XHRcdFx0XHRcdFx0c2VsZWN0b3I6IHBhcmFtcy5zZWxlY3Rvcixcblx0XHRcdFx0XHRcdFx0c2NvcmU6IHBhcmFtcy5zY29yZSA/PyAxLjAsXG5cdFx0XHRcdFx0XHRcdHVybCxcblx0XHRcdFx0XHRcdFx0ZG9tSGFzaCxcblx0XHRcdFx0XHRcdFx0dGltZXN0YW1wOiBEYXRlLm5vdygpLFxuXHRcdFx0XHRcdFx0XHRoaXRDb3VudDogMCxcblx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0XHRjYWNoZS5zZXQoa2V5LCBlbnRyeSk7XG5cblx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7XG5cdFx0XHRcdFx0XHRcdFx0dHlwZTogXCJ0ZXh0XCIsXG5cdFx0XHRcdFx0XHRcdFx0dGV4dDogYENhY2hlZDogXCIke3BhcmFtcy5pbnRlbnR9XCIgXHUyMTkyICR7cGFyYW1zLnNlbGVjdG9yfSAoY2FjaGUgc2l6ZTogJHtjYWNoZS5zaXplfSlgLFxuXHRcdFx0XHRcdFx0XHR9XSxcblx0XHRcdFx0XHRcdFx0ZGV0YWlsczogeyBzdG9yZWQ6IHRydWUsIGtleSwgLi4uZW50cnksIGNhY2hlU2l6ZTogY2FjaGUuc2l6ZSB9LFxuXHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRjYXNlIFwiY2xlYXJcIjoge1xuXHRcdFx0XHRcdFx0Y29uc3Qgc2l6ZSA9IGNhY2hlLnNpemU7XG5cdFx0XHRcdFx0XHRjYWNoZS5jbGVhcigpO1xuXHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBBY3Rpb24gY2FjaGUgY2xlYXJlZCAoJHtzaXplfSBlbnRyaWVzIHJlbW92ZWQpLmAgfV0sXG5cdFx0XHRcdFx0XHRcdGRldGFpbHM6IHsgY2xlYXJlZDogc2l6ZSB9LFxuXHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRkZWZhdWx0OlxuXHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBVbmtub3duIGFjdGlvbjogJHtwYXJhbXMuYWN0aW9ufS4gVXNlICdzdGF0cycsICdnZXQnLCAncHV0Jywgb3IgJ2NsZWFyJy5gIH1dLFxuXHRcdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGVycm9yOiBcInVua25vd25fYWN0aW9uXCIgfSxcblx0XHRcdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdH1cblx0XHRcdH0gY2F0Y2ggKGVycjogYW55KSB7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBBY3Rpb24gY2FjaGUgZXJyb3I6ICR7ZXJyLm1lc3NhZ2V9YCB9XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7IGVycm9yOiBlcnIubWVzc2FnZSB9LFxuXHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsXG5cdFx0XHRcdH07XG5cdFx0XHR9XG5cdFx0fSxcblx0fSk7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkQ2FjaGVLZXkodXJsOiBzdHJpbmcsIGRvbUhhc2g6IHN0cmluZywgaW50ZW50OiBzdHJpbmcpOiBzdHJpbmcge1xuXHQvLyBOb3JtYWxpemUgVVJMIFx1MjAxNCBzdHJpcCBoYXNoIGFuZCBxdWVyeSBwYXJhbXMgZm9yIGJyb2FkZXIgbWF0Y2hpbmdcblx0bGV0IG5vcm1hbGl6ZWQ6IHN0cmluZztcblx0dHJ5IHtcblx0XHRjb25zdCB1ID0gbmV3IFVSTCh1cmwpO1xuXHRcdG5vcm1hbGl6ZWQgPSBgJHt1Lm9yaWdpbn0ke3UucGF0aG5hbWV9YDtcblx0fSBjYXRjaCB7XG5cdFx0bm9ybWFsaXplZCA9IHVybDtcblx0fVxuXHRyZXR1cm4gYCR7bm9ybWFsaXplZH18JHtkb21IYXNofXwke2ludGVudH1gO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjb21wdXRlRG9tSGFzaChwYWdlOiBhbnkpOiBQcm9taXNlPHN0cmluZz4ge1xuXHR0cnkge1xuXHRcdHJldHVybiBhd2FpdCBwYWdlLmV2YWx1YXRlKCgpID0+IHtcblx0XHRcdC8vIFN0cnVjdHVyYWwgaGFzaCBiYXNlZCBvbiBlbGVtZW50IGNvdW50ICsgdGFnIGRpc3RyaWJ1dGlvblxuXHRcdFx0Y29uc3QgdGFncyA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG5cdFx0XHRjb25zdCBhbGwgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKFwiKlwiKTtcblx0XHRcdGZvciAoY29uc3QgZWwgb2YgYWxsKSB7XG5cdFx0XHRcdGNvbnN0IHRhZyA9IGVsLnRhZ05hbWU7XG5cdFx0XHRcdHRhZ3Muc2V0KHRhZywgKHRhZ3MuZ2V0KHRhZykgPz8gMCkgKyAxKTtcblx0XHRcdH1cblx0XHRcdGNvbnN0IGVudHJpZXMgPSBbLi4udGFncy5lbnRyaWVzKCldLnNvcnQoKGEsIGIpID0+IGFbMF0ubG9jYWxlQ29tcGFyZShiWzBdKSk7XG5cdFx0XHRjb25zdCBzdHIgPSBlbnRyaWVzLm1hcCgoW3QsIGNdKSA9PiBgJHt0fToke2N9YCkuam9pbihcInxcIik7XG5cdFx0XHQvLyBTaW1wbGUgaGFzaFxuXHRcdFx0bGV0IGggPSA1MzgxO1xuXHRcdFx0Zm9yIChsZXQgaSA9IDA7IGkgPCBzdHIubGVuZ3RoOyBpKyspIHtcblx0XHRcdFx0aCA9ICgoaCA8PCA1KSAtIGggKyBzdHIuY2hhckNvZGVBdChpKSkgfCAwO1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuIChoID4+PiAwKS50b1N0cmluZygxNik7XG5cdFx0fSk7XG5cdH0gY2F0Y2gge1xuXHRcdHJldHVybiBcInVua25vd25cIjtcblx0fVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQ0EsU0FBUyxZQUFZO0FBaUJyQixNQUFNLFFBQVEsb0JBQUksSUFBd0I7QUFDMUMsTUFBTSxpQkFBaUI7QUFFaEIsU0FBUyx5QkFBeUIsSUFBa0IsTUFBc0I7QUFJaEYsS0FBRyxhQUFhO0FBQUEsSUFDZixNQUFNO0FBQUEsSUFDTixPQUFPO0FB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
