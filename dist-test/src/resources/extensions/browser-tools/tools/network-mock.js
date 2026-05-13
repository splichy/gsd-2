import { Type } from "@sinclair/typebox";
let nextRouteId = 1;
const activeRoutes = [];
const routeCleanups = /* @__PURE__ */ new Map();
function registerNetworkMockTools(pi, deps) {
  pi.registerTool({
    name: "browser_mock_route",
    label: "Browser Mock Route",
    description: "Intercept network requests matching a URL pattern and respond with custom status, body, and headers. Supports simulating slow responses via delay parameter. Routes survive page navigation within the same context. Use browser_clear_routes to remove all mocks.",
    parameters: Type.Object({
      url: Type.String({
        description: "URL pattern to intercept. Supports glob patterns (e.g., '**/api/users*') or exact URLs."
      }),
      status: Type.Optional(
        Type.Number({ description: "HTTP status code for the mock response (default: 200)." })
      ),
      body: Type.Optional(
        Type.String({ description: "Response body string. For JSON responses, pass a JSON string." })
      ),
      contentType: Type.Optional(
        Type.String({ description: "Content-Type header (default: 'application/json' if body looks like JSON, else 'text/plain')." })
      ),
      headers: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description: "Additional response headers as key-value pairs."
        })
      ),
      delay: Type.Optional(
        Type.Number({ description: "Delay in milliseconds before sending the response. Simulates slow responses." })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const { page: p } = await deps.ensureBrowser();
        const routeId = nextRouteId++;
        const status = params.status ?? 200;
        const body = params.body ?? "";
        const delay = params.delay ?? 0;
        let contentType = params.contentType;
        if (!contentType) {
          try {
            JSON.parse(body);
            contentType = "application/json";
          } catch {
            contentType = "text/plain";
          }
        }
        const headers = {
          "content-type": contentType,
          "access-control-allow-origin": "*",
          ...params.headers ?? {}
        };
        const handler = async (route) => {
          if (delay > 0) {
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
          await route.fulfill({
            status,
            body,
            headers
          });
        };
        await p.route(params.url, handler);
        const cleanup = async () => {
          try {
            await p.unroute(params.url, handler);
          } catch {
          }
        };
        const routeInfo = {
          id: routeId,
          pattern: params.url,
          type: "mock",
          status,
          delay: delay > 0 ? delay : void 0,
          description: `Mock ${params.url} \u2192 ${status}${delay > 0 ? ` (${delay}ms delay)` : ""}`
        };
        activeRoutes.push(routeInfo);
        routeCleanups.set(routeId, cleanup);
        return {
          content: [{
            type: "text",
            text: `Route mocked: ${routeInfo.description}
Route ID: ${routeId}
Active routes: ${activeRoutes.length}`
          }],
          details: { routeId, ...routeInfo, activeRouteCount: activeRoutes.length }
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Mock route failed: ${err.message}` }],
          details: { error: err.message },
          isError: true
        };
      }
    }
  });
  pi.registerTool({
    name: "browser_block_urls",
    label: "Browser Block URLs",
    description: "Block network requests matching URL patterns. Useful for blocking analytics, ads, or third-party scripts. Accepts glob patterns. Routes survive page navigation.",
    parameters: Type.Object({
      patterns: Type.Array(Type.String(), {
        description: "URL patterns to block (glob syntax, e.g., ['**/analytics*', '**/ads*'])."
      })
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const { page: p } = await deps.ensureBrowser();
        const results = [];
        for (const pattern of params.patterns) {
          const routeId = nextRouteId++;
          const handler = async (route) => {
            await route.abort("blockedbyclient");
          };
          await p.route(pattern, handler);
          const cleanup = async () => {
            try {
              await p.unroute(pattern, handler);
            } catch {
            }
          };
          const routeInfo = {
            id: routeId,
            pattern,
            type: "block",
            description: `Block ${pattern}`
          };
          activeRoutes.push(routeInfo);
          routeCleanups.set(routeId, cleanup);
          results.push(routeInfo);
        }
        return {
          content: [{
            type: "text",
            text: `Blocked ${results.length} URL pattern(s):
${results.map((r) => `  - ${r.description} (ID: ${r.id})`).join("\n")}
Active routes: ${activeRoutes.length}`
          }],
          details: { blocked: results, activeRouteCount: activeRoutes.length }
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Block URLs failed: ${err.message}` }],
          details: { error: err.message },
          isError: true
        };
      }
    }
  });
  pi.registerTool({
    name: "browser_clear_routes",
    label: "Browser Clear Routes",
    description: "Remove all active route mocks and URL blocks. Also lists currently active routes if called with no routes active.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      try {
        await deps.ensureBrowser();
        const count = activeRoutes.length;
        if (count === 0) {
          return {
            content: [{ type: "text", text: "No active routes to clear." }],
            details: { cleared: 0 }
          };
        }
        const routeDescriptions = activeRoutes.map((r) => r.description);
        for (const [id, cleanup] of routeCleanups) {
          await cleanup();
        }
        activeRoutes.length = 0;
        routeCleanups.clear();
        return {
          content: [{
            type: "text",
            text: `Cleared ${count} route(s):
${routeDescriptions.map((d) => `  - ${d}`).join("\n")}`
          }],
          details: { cleared: count, routes: routeDescriptions }
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Clear routes failed: ${err.message}` }],
          details: { error: err.message },
          isError: true
        };
      }
    }
  });
}
export {
  registerNetworkMockTools
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2Jyb3dzZXItdG9vbHMvdG9vbHMvbmV0d29yay1tb2NrLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdHlwZSB7IEV4dGVuc2lvbkFQSSB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuaW1wb3J0IHsgVHlwZSB9IGZyb20gXCJAc2luY2xhaXIvdHlwZWJveFwiO1xuaW1wb3J0IHR5cGUgeyBUb29sRGVwcyB9IGZyb20gXCIuLi9zdGF0ZS5qc1wiO1xuXG4vKipcbiAqIE5ldHdvcmsgaW50ZXJjZXB0aW9uICYgbW9ja2luZyB0b29scyBcdTIwMTQgbW9jayBBUEkgcmVzcG9uc2VzLCBibG9jayBVUkxzLCBzaW11bGF0ZSBlcnJvcnMuXG4gKi9cblxuaW50ZXJmYWNlIEFjdGl2ZVJvdXRlIHtcblx0aWQ6IG51bWJlcjtcblx0cGF0dGVybjogc3RyaW5nO1xuXHR0eXBlOiBcIm1vY2tcIiB8IFwiYmxvY2tcIjtcblx0c3RhdHVzPzogbnVtYmVyO1xuXHRkZWxheT86IG51bWJlcjtcblx0ZGVzY3JpcHRpb246IHN0cmluZztcbn1cblxubGV0IG5leHRSb3V0ZUlkID0gMTtcbmNvbnN0IGFjdGl2ZVJvdXRlczogQWN0aXZlUm91dGVbXSA9IFtdO1xuY29uc3Qgcm91dGVDbGVhbnVwczogTWFwPG51bWJlciwgKCkgPT4gUHJvbWlzZTx2b2lkPj4gPSBuZXcgTWFwKCk7XG5cbmV4cG9ydCBmdW5jdGlvbiByZWdpc3Rlck5ldHdvcmtNb2NrVG9vbHMocGk6IEV4dGVuc2lvbkFQSSwgZGVwczogVG9vbERlcHMpOiB2b2lkIHtcblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHQvLyBicm93c2VyX21vY2tfcm91dGVcblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHRwaS5yZWdpc3RlclRvb2woe1xuXHRcdG5hbWU6IFwiYnJvd3Nlcl9tb2NrX3JvdXRlXCIsXG5cdFx0bGFiZWw6IFwiQnJvd3NlciBNb2NrIFJvdXRlXCIsXG5cdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcIkludGVyY2VwdCBuZXR3b3JrIHJlcXVlc3RzIG1hdGNoaW5nIGEgVVJMIHBhdHRlcm4gYW5kIHJlc3BvbmQgd2l0aCBjdXN0b20gc3RhdHVzLCBib2R5LCBhbmQgaGVhZGVycy4gXCIgK1xuXHRcdFx0XCJTdXBwb3J0cyBzaW11bGF0aW5nIHNsb3cgcmVzcG9uc2VzIHZpYSBkZWxheSBwYXJhbWV0ZXIuIFwiICtcblx0XHRcdFwiUm91dGVzIHN1cnZpdmUgcGFnZSBuYXZpZ2F0aW9uIHdpdGhpbiB0aGUgc2FtZSBjb250ZXh0LiBVc2UgYnJvd3Nlcl9jbGVhcl9yb3V0ZXMgdG8gcmVtb3ZlIGFsbCBtb2Nrcy5cIixcblx0XHRwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG5cdFx0XHR1cmw6IFR5cGUuU3RyaW5nKHtcblx0XHRcdFx0ZGVzY3JpcHRpb246IFwiVVJMIHBhdHRlcm4gdG8gaW50ZXJjZXB0LiBTdXBwb3J0cyBnbG9iIHBhdHRlcm5zIChlLmcuLCAnKiovYXBpL3VzZXJzKicpIG9yIGV4YWN0IFVSTHMuXCIsXG5cdFx0XHR9KSxcblx0XHRcdHN0YXR1czogVHlwZS5PcHRpb25hbChcblx0XHRcdFx0VHlwZS5OdW1iZXIoeyBkZXNjcmlwdGlvbjogXCJIVFRQIHN0YXR1cyBjb2RlIGZvciB0aGUgbW9jayByZXNwb25zZSAoZGVmYXVsdDogMjAwKS5cIiB9KSxcblx0XHRcdCksXG5cdFx0XHRib2R5OiBUeXBlLk9wdGlvbmFsKFxuXHRcdFx0XHRUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIlJlc3BvbnNlIGJvZHkgc3RyaW5nLiBGb3IgSlNPTiByZXNwb25zZXMsIHBhc3MgYSBKU09OIHN0cmluZy5cIiB9KSxcblx0XHRcdCksXG5cdFx0XHRjb250ZW50VHlwZTogVHlwZS5PcHRpb25hbChcblx0XHRcdFx0VHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJDb250ZW50LVR5cGUgaGVhZGVyIChkZWZhdWx0OiAnYXBwbGljYXRpb24vanNvbicgaWYgYm9keSBsb29rcyBsaWtlIEpTT04sIGVsc2UgJ3RleHQvcGxhaW4nKS5cIiB9KSxcblx0XHRcdCksXG5cdFx0XHRoZWFkZXJzOiBUeXBlLk9wdGlvbmFsKFxuXHRcdFx0XHRUeXBlLlJlY29yZChUeXBlLlN0cmluZygpLCBUeXBlLlN0cmluZygpLCB7XG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246IFwiQWRkaXRpb25hbCByZXNwb25zZSBoZWFkZXJzIGFzIGtleS12YWx1ZSBwYWlycy5cIixcblx0XHRcdFx0fSksXG5cdFx0XHQpLFxuXHRcdFx0ZGVsYXk6IFR5cGUuT3B0aW9uYWwoXG5cdFx0XHRcdFR5cGUuTnVtYmVyKHsgZGVzY3JpcHRpb246IFwiRGVsYXkgaW4gbWlsbGlzZWNvbmRzIGJlZm9yZSBzZW5kaW5nIHRoZSByZXNwb25zZS4gU2ltdWxhdGVzIHNsb3cgcmVzcG9uc2VzLlwiIH0pLFxuXHRcdFx0KSxcblx0XHR9KSxcblxuXHRcdGFzeW5jIGV4ZWN1dGUoX3Rvb2xDYWxsSWQsIHBhcmFtcywgX3NpZ25hbCwgX29uVXBkYXRlLCBfY3R4KSB7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCB7IHBhZ2U6IHAgfSA9IGF3YWl0IGRlcHMuZW5zdXJlQnJvd3NlcigpO1xuXHRcdFx0XHRjb25zdCByb3V0ZUlkID0gbmV4dFJvdXRlSWQrKztcblxuXHRcdFx0XHRjb25zdCBzdGF0dXMgPSBwYXJhbXMuc3RhdHVzID8/IDIwMDtcblx0XHRcdFx0Y29uc3QgYm9keSA9IHBhcmFtcy5ib2R5ID8/IFwiXCI7XG5cdFx0XHRcdGNvbnN0IGRlbGF5ID0gcGFyYW1zLmRlbGF5ID8/IDA7XG5cblx0XHRcdFx0Ly8gQXV0by1kZXRlY3QgY29udGVudCB0eXBlXG5cdFx0XHRcdGxldCBjb250ZW50VHlwZSA9IHBhcmFtcy5jb250ZW50VHlwZTtcblx0XHRcdFx0aWYgKCFjb250ZW50VHlwZSkge1xuXHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHRKU09OLnBhcnNlKGJvZHkpO1xuXHRcdFx0XHRcdFx0Y29udGVudFR5cGUgPSBcImFwcGxpY2F0aW9uL2pzb25cIjtcblx0XHRcdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0XHRcdGNvbnRlbnRUeXBlID0gXCJ0ZXh0L3BsYWluXCI7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cblx0XHRcdFx0Y29uc3QgaGVhZGVyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcblx0XHRcdFx0XHRcImNvbnRlbnQtdHlwZVwiOiBjb250ZW50VHlwZSxcblx0XHRcdFx0XHRcImFjY2Vzcy1jb250cm9sLWFsbG93LW9yaWdpblwiOiBcIipcIixcblx0XHRcdFx0XHQuLi4ocGFyYW1zLmhlYWRlcnMgPz8ge30pLFxuXHRcdFx0XHR9O1xuXG5cdFx0XHRcdGNvbnN0IGhhbmRsZXIgPSBhc3luYyAocm91dGU6IGFueSkgPT4ge1xuXHRcdFx0XHRcdGlmIChkZWxheSA+IDApIHtcblx0XHRcdFx0XHRcdGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIGRlbGF5KSk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdGF3YWl0IHJvdXRlLmZ1bGZpbGwoe1xuXHRcdFx0XHRcdFx0c3RhdHVzLFxuXHRcdFx0XHRcdFx0Ym9keSxcblx0XHRcdFx0XHRcdGhlYWRlcnMsXG5cdFx0XHRcdFx0fSk7XG5cdFx0XHRcdH07XG5cblx0XHRcdFx0YXdhaXQgcC5yb3V0ZShwYXJhbXMudXJsLCBoYW5kbGVyKTtcblxuXHRcdFx0XHRjb25zdCBjbGVhbnVwID0gYXN5bmMgKCkgPT4ge1xuXHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHRhd2FpdCBwLnVucm91dGUocGFyYW1zLnVybCwgaGFuZGxlcik7XG5cdFx0XHRcdFx0fSBjYXRjaCB7XG5cdFx0XHRcdFx0XHQvLyBQYWdlIG1heSBiZSBjbG9zZWRcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH07XG5cblx0XHRcdFx0Y29uc3Qgcm91dGVJbmZvOiBBY3RpdmVSb3V0ZSA9IHtcblx0XHRcdFx0XHRpZDogcm91dGVJZCxcblx0XHRcdFx0XHRwYXR0ZXJuOiBwYXJhbXMudXJsLFxuXHRcdFx0XHRcdHR5cGU6IFwibW9ja1wiLFxuXHRcdFx0XHRcdHN0YXR1cyxcblx0XHRcdFx0XHRkZWxheTogZGVsYXkgPiAwID8gZGVsYXkgOiB1bmRlZmluZWQsXG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246IGBNb2NrICR7cGFyYW1zLnVybH0gXHUyMTkyICR7c3RhdHVzfSR7ZGVsYXkgPiAwID8gYCAoJHtkZWxheX1tcyBkZWxheSlgIDogXCJcIn1gLFxuXHRcdFx0XHR9O1xuXG5cdFx0XHRcdGFjdGl2ZVJvdXRlcy5wdXNoKHJvdXRlSW5mbyk7XG5cdFx0XHRcdHJvdXRlQ2xlYW51cHMuc2V0KHJvdXRlSWQsIGNsZWFudXApO1xuXG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3tcblx0XHRcdFx0XHRcdHR5cGU6IFwidGV4dFwiLFxuXHRcdFx0XHRcdFx0dGV4dDogYFJvdXRlIG1vY2tlZDogJHtyb3V0ZUluZm8uZGVzY3JpcHRpb259XFxuUm91dGUgSUQ6ICR7cm91dGVJZH1cXG5BY3RpdmUgcm91dGVzOiAke2FjdGl2ZVJvdXRlcy5sZW5ndGh9YCxcblx0XHRcdFx0XHR9XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7IHJvdXRlSWQsIC4uLnJvdXRlSW5mbywgYWN0aXZlUm91dGVDb3VudDogYWN0aXZlUm91dGVzLmxlbmd0aCB9LFxuXHRcdFx0XHR9O1xuXHRcdFx0fSBjYXRjaCAoZXJyOiBhbnkpIHtcblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYE1vY2sgcm91dGUgZmFpbGVkOiAke2Vyci5tZXNzYWdlfWAgfV0sXG5cdFx0XHRcdFx0ZGV0YWlsczogeyBlcnJvcjogZXJyLm1lc3NhZ2UgfSxcblx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHR9O1xuXHRcdFx0fVxuXHRcdH0sXG5cdH0pO1xuXG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblx0Ly8gYnJvd3Nlcl9ibG9ja191cmxzXG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblx0cGkucmVnaXN0ZXJUb29sKHtcblx0XHRuYW1lOiBcImJyb3dzZXJfYmxvY2tfdXJsc1wiLFxuXHRcdGxhYmVsOiBcIkJyb3dzZXIgQmxvY2sgVVJMc1wiLFxuXHRcdGRlc2NyaXB0aW9uOlxuXHRcdFx0XCJCbG9jayBuZXR3b3JrIHJlcXVlc3RzIG1hdGNoaW5nIFVSTCBwYXR0ZXJucy4gVXNlZnVsIGZvciBibG9ja2luZyBhbmFseXRpY3MsIGFkcywgb3IgdGhpcmQtcGFydHkgc2NyaXB0cy4gXCIgK1xuXHRcdFx0XCJBY2NlcHRzIGdsb2IgcGF0dGVybnMuIFJvdXRlcyBzdXJ2aXZlIHBhZ2UgbmF2aWdhdGlvbi5cIixcblx0XHRwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG5cdFx0XHRwYXR0ZXJuczogVHlwZS5BcnJheShUeXBlLlN0cmluZygpLCB7XG5cdFx0XHRcdGRlc2NyaXB0aW9uOiBcIlVSTCBwYXR0ZXJucyB0byBibG9jayAoZ2xvYiBzeW50YXgsIGUuZy4sIFsnKiovYW5hbHl0aWNzKicsICcqKi9hZHMqJ10pLlwiLFxuXHRcdFx0fSksXG5cdFx0fSksXG5cblx0XHRhc3luYyBleGVjdXRlKF90b29sQ2FsbElkLCBwYXJhbXMsIF9zaWduYWwsIF9vblVwZGF0ZSwgX2N0eCkge1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0Y29uc3QgeyBwYWdlOiBwIH0gPSBhd2FpdCBkZXBzLmVuc3VyZUJyb3dzZXIoKTtcblx0XHRcdFx0Y29uc3QgcmVzdWx0czogQWN0aXZlUm91dGVbXSA9IFtdO1xuXG5cdFx0XHRcdGZvciAoY29uc3QgcGF0dGVybiBvZiBwYXJhbXMucGF0dGVybnMpIHtcblx0XHRcdFx0XHRjb25zdCByb3V0ZUlkID0gbmV4dFJvdXRlSWQrKztcblxuXHRcdFx0XHRcdGNvbnN0IGhhbmRsZXIgPSBhc3luYyAocm91dGU6IGFueSkgPT4ge1xuXHRcdFx0XHRcdFx0YXdhaXQgcm91dGUuYWJvcnQoXCJibG9ja2VkYnljbGllbnRcIik7XG5cdFx0XHRcdFx0fTtcblxuXHRcdFx0XHRcdGF3YWl0IHAucm91dGUocGF0dGVybiwgaGFuZGxlcik7XG5cblx0XHRcdFx0XHRjb25zdCBjbGVhbnVwID0gYXN5bmMgKCkgPT4ge1xuXHRcdFx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRcdFx0YXdhaXQgcC51bnJvdXRlKHBhdHRlcm4sIGhhbmRsZXIpO1xuXHRcdFx0XHRcdFx0fSBjYXRjaCB7IC8qIGNsZWFudXAgXHUyMDE0IHJvdXRlIG1heSBhbHJlYWR5IGJlIHJlbW92ZWQgb3IgcGFnZSBjbG9zZWQgKi8gfVxuXHRcdFx0XHRcdH07XG5cblx0XHRcdFx0XHRjb25zdCByb3V0ZUluZm86IEFjdGl2ZVJvdXRlID0ge1xuXHRcdFx0XHRcdFx0aWQ6IHJvdXRlSWQsXG5cdFx0XHRcdFx0XHRwYXR0ZXJuLFxuXHRcdFx0XHRcdFx0dHlwZTogXCJibG9ja1wiLFxuXHRcdFx0XHRcdFx0ZGVzY3JpcHRpb246IGBCbG9jayAke3BhdHRlcm59YCxcblx0XHRcdFx0XHR9O1xuXG5cdFx0XHRcdFx0YWN0aXZlUm91dGVzLnB1c2gocm91dGVJbmZvKTtcblx0XHRcdFx0XHRyb3V0ZUNsZWFudXBzLnNldChyb3V0ZUlkLCBjbGVhbnVwKTtcblx0XHRcdFx0XHRyZXN1bHRzLnB1c2gocm91dGVJbmZvKTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3tcblx0XHRcdFx0XHRcdHR5cGU6IFwidGV4dFwiLFxuXHRcdFx0XHRcdFx0dGV4dDogYEJsb2NrZWQgJHtyZXN1bHRzLmxlbmd0aH0gVVJMIHBhdHRlcm4ocyk6XFxuJHtyZXN1bHRzLm1hcCgocikgPT4gYCAgLSAke3IuZGVzY3JpcHRpb259IChJRDogJHtyLmlkfSlgKS5qb2luKFwiXFxuXCIpfVxcbkFjdGl2ZSByb3V0ZXM6ICR7YWN0aXZlUm91dGVzLmxlbmd0aH1gLFxuXHRcdFx0XHRcdH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgYmxvY2tlZDogcmVzdWx0cywgYWN0aXZlUm91dGVDb3VudDogYWN0aXZlUm91dGVzLmxlbmd0aCB9LFxuXHRcdFx0XHR9O1xuXHRcdFx0fSBjYXRjaCAoZXJyOiBhbnkpIHtcblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYEJsb2NrIFVSTHMgZmFpbGVkOiAke2Vyci5tZXNzYWdlfWAgfV0sXG5cdFx0XHRcdFx0ZGV0YWlsczogeyBlcnJvcjogZXJyLm1lc3NhZ2UgfSxcblx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHR9O1xuXHRcdFx0fVxuXHRcdH0sXG5cdH0pO1xuXG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblx0Ly8gYnJvd3Nlcl9jbGVhcl9yb3V0ZXNcblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHRwaS5yZWdpc3RlclRvb2woe1xuXHRcdG5hbWU6IFwiYnJvd3Nlcl9jbGVhcl9yb3V0ZXNcIixcblx0XHRsYWJlbDogXCJCcm93c2VyIENsZWFyIFJvdXRlc1wiLFxuXHRcdGRlc2NyaXB0aW9uOlxuXHRcdFx0XCJSZW1vdmUgYWxsIGFjdGl2ZSByb3V0ZSBtb2NrcyBhbmQgVVJMIGJsb2Nrcy4gQWxzbyBsaXN0cyBjdXJyZW50bHkgYWN0aXZlIHJvdXRlcyBpZiBjYWxsZWQgd2l0aCBubyByb3V0ZXMgYWN0aXZlLlwiLFxuXHRcdHBhcmFtZXRlcnM6IFR5cGUuT2JqZWN0KHt9KSxcblxuXHRcdGFzeW5jIGV4ZWN1dGUoX3Rvb2xDYWxsSWQsIF9wYXJhbXMsIF9zaWduYWwsIF9vblVwZGF0ZSwgX2N0eCkge1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0YXdhaXQgZGVwcy5lbnN1cmVCcm93c2VyKCk7XG5cdFx0XHRcdGNvbnN0IGNvdW50ID0gYWN0aXZlUm91dGVzLmxlbmd0aDtcblxuXHRcdFx0XHRpZiAoY291bnQgPT09IDApIHtcblx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiTm8gYWN0aXZlIHJvdXRlcyB0byBjbGVhci5cIiB9XSxcblx0XHRcdFx0XHRcdGRldGFpbHM6IHsgY2xlYXJlZDogMCB9LFxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRjb25zdCByb3V0ZURlc2NyaXB0aW9ucyA9IGFjdGl2ZVJvdXRlcy5tYXAoKHIpID0+IHIuZGVzY3JpcHRpb24pO1xuXG5cdFx0XHRcdC8vIENsZWFuIHVwIGFsbCByb3V0ZXNcblx0XHRcdFx0Zm9yIChjb25zdCBbaWQsIGNsZWFudXBdIG9mIHJvdXRlQ2xlYW51cHMpIHtcblx0XHRcdFx0XHRhd2FpdCBjbGVhbnVwKCk7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRhY3RpdmVSb3V0ZXMubGVuZ3RoID0gMDtcblx0XHRcdFx0cm91dGVDbGVhbnVwcy5jbGVhcigpO1xuXG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3tcblx0XHRcdFx0XHRcdHR5cGU6IFwidGV4dFwiLFxuXHRcdFx0XHRcdFx0dGV4dDogYENsZWFyZWQgJHtjb3VudH0gcm91dGUocyk6XFxuJHtyb3V0ZURlc2NyaXB0aW9ucy5tYXAoKGQpID0+IGAgIC0gJHtkfWApLmpvaW4oXCJcXG5cIil9YCxcblx0XHRcdFx0XHR9XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7IGNsZWFyZWQ6IGNvdW50LCByb3V0ZXM6IHJvdXRlRGVzY3JpcHRpb25zIH0sXG5cdFx0XHRcdH07XG5cdFx0XHR9IGNhdGNoIChlcnI6IGFueSkge1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgQ2xlYXIgcm91dGVzIGZhaWxlZDogJHtlcnIubWVzc2FnZX1gIH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgZXJyb3I6IGVyci5tZXNzYWdlIH0sXG5cdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0fTtcblx0XHRcdH1cblx0XHR9LFxuXHR9KTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUNBLFNBQVMsWUFBWTtBQWdCckIsSUFBSSxjQUFjO0FBQ2xCLE1BQU0sZUFBOEIsQ0FBQztBQUNyQyxNQUFNLGdCQUFrRCxvQkFBSSxJQUFJO0FBRXpELFNBQVMseUJBQXlCLElBQWtCLE1BQXNCO0FBSWhGLEtBQUcsYUFBYTtBQUFBLElBQ2YsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsYUFDQztBQUFBLElBR0QsWUFBWSxLQUFLLE9BQU87QUFBQSxNQUN2QixLQUFLLEtBQUssT0FBTztBQUFBLFFBQ2hCLGFBQWE7QUFBQSxNQUNkLENBQUM7QUFBQSxNQUNELFFBQVEsS0FBSztBQUFBLFFBQ1osS0FBSyxPQUFPLEVBQUUsYUFBYSx5REFBeUQsQ0FBQztBQUFBLE1BQ3RGO0FBQUEsTUFDQSxNQUFNLEtBQUs7QUFBQSxRQUNWLEtBQUssT0FBTyxFQUFFLGFBQWEsZ0VBQWdFLENBQUM7QUFBQSxNQUM3RjtBQUFBLE1BQ0EsYUFBYSxLQUFLO0FBQUEsUUFDakIsS0FBSyxPQUFPLEVBQUUsYUFBYSxnR0FB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
