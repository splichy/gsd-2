import { Type } from "@sinclair/typebox";
import { StringEnum } from "@gsd/pi-ai";
import {
  validateWaitParams,
  createRegionStableScript,
  parseThreshold,
  includesNeedle
} from "../core.js";
import {
  getConsoleLogs
} from "../state.js";
function registerWaitTools(pi, deps) {
  pi.registerTool({
    name: "browser_wait_for",
    label: "Browser Wait For",
    description: "Wait for a condition before continuing. Use after actions that trigger async updates \u2014 data fetches, route changes, animations, loading spinners. Choose the appropriate condition: 'selector_visible' waits for an element to appear, 'selector_hidden' waits for it to disappear, 'url_contains' waits for the URL to match, 'network_idle' waits for all network requests to finish, 'delay' waits a fixed number of milliseconds, 'text_visible' waits for text to appear in the page body, 'text_hidden' waits for text to disappear from the page body, 'request_completed' waits for a network response whose URL contains the given substring, 'console_message' waits for a console log message containing the given substring, 'element_count' waits for the number of elements matching the CSS selector in 'value' to satisfy the 'threshold' expression (e.g. '>=3', '==0', '<5'), 'region_stable' waits for the DOM region matching the CSS selector in 'value' to stop changing.",
    parameters: Type.Object({
      condition: StringEnum([
        "selector_visible",
        "selector_hidden",
        "url_contains",
        "network_idle",
        "delay",
        "text_visible",
        "text_hidden",
        "request_completed",
        "console_message",
        "element_count",
        "region_stable"
      ]),
      value: Type.Optional(
        Type.String({
          description: "For selector_visible/selector_hidden/element_count/region_stable: CSS selector. For url_contains/request_completed: URL substring. For text_visible/text_hidden/console_message: text substring. For delay: milliseconds as a string (e.g. '1000'). Not used for network_idle."
        })
      ),
      threshold: Type.Optional(
        Type.String({
          description: "Threshold expression for element_count (e.g. '>=3', '==0', '<5', or bare '3' which defaults to >=). Only used with element_count condition."
        })
      ),
      timeout: Type.Optional(
        Type.Number({
          description: "Maximum milliseconds to wait before failing (default: 10000)"
        })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const { page: p } = await deps.ensureBrowser();
        const target = deps.getActiveTarget();
        const timeout = params.timeout ?? 1e4;
        const validation = validateWaitParams({ condition: params.condition, value: params.value, threshold: params.threshold });
        if (validation) {
          return {
            content: [{ type: "text", text: validation.error }],
            details: { error: validation.error, condition: params.condition },
            isError: true
          };
        }
        switch (params.condition) {
          case "selector_visible": {
            if (!params.value) {
              return {
                content: [{ type: "text", text: "selector_visible requires a value (CSS selector)" }],
                details: {},
                isError: true
              };
            }
            await target.waitForSelector(params.value, { state: "visible", timeout });
            return {
              content: [{ type: "text", text: `Element "${params.value}" is now visible` }],
              details: { condition: params.condition, value: params.value }
            };
          }
          case "selector_hidden": {
            if (!params.value) {
              return {
                content: [{ type: "text", text: "selector_hidden requires a value (CSS selector)" }],
                details: {},
                isError: true
              };
            }
            await target.waitForSelector(params.value, { state: "hidden", timeout });
            return {
              content: [{ type: "text", text: `Element "${params.value}" is now hidden` }],
              details: { condition: params.condition, value: params.value }
            };
          }
          case "url_contains": {
            if (!params.value) {
              return {
                content: [{ type: "text", text: "url_contains requires a value (URL substring)" }],
                details: {},
                isError: true
              };
            }
            await p.waitForURL((url) => url.toString().includes(params.value), { timeout });
            return {
              content: [{ type: "text", text: `URL now contains "${params.value}". Current URL: ${p.url()}` }],
              details: { condition: params.condition, value: params.value, url: p.url() }
            };
          }
          case "network_idle": {
            await p.waitForLoadState("networkidle", { timeout });
            return {
              content: [{ type: "text", text: "Network is idle" }],
              details: { condition: params.condition }
            };
          }
          case "delay": {
            const ms = parseInt(params.value ?? "1000", 10);
            if (isNaN(ms)) {
              return {
                content: [{ type: "text", text: "delay requires a numeric value (milliseconds)" }],
                details: {},
                isError: true
              };
            }
            await new Promise((resolve) => setTimeout(resolve, ms));
            return {
              content: [{ type: "text", text: `Waited ${ms}ms` }],
              details: { condition: params.condition, ms }
            };
          }
          case "text_visible": {
            await target.waitForFunction(
              (needle) => {
                const body = document.body?.innerText ?? "";
                return body.toLowerCase().includes(needle.toLowerCase());
              },
              params.value,
              { timeout }
            );
            return {
              content: [{ type: "text", text: `Text "${params.value}" is now visible on the page` }],
              details: { condition: params.condition, value: params.value }
            };
          }
          case "text_hidden": {
            await target.waitForFunction(
              (needle) => {
                const body = document.body?.innerText ?? "";
                return !body.toLowerCase().includes(needle.toLowerCase());
              },
              params.value,
              { timeout }
            );
            return {
              content: [{ type: "text", text: `Text "${params.value}" is no longer visible on the page` }],
              details: { condition: params.condition, value: params.value }
            };
          }
          case "request_completed": {
            const response = await deps.getActivePage().waitForResponse(
              (resp) => resp.url().includes(params.value),
              { timeout }
            );
            return {
              content: [{ type: "text", text: `Request completed: ${response.url()} (status ${response.status()})` }],
              details: { condition: params.condition, value: params.value, url: response.url(), status: response.status() }
            };
          }
          case "console_message": {
            const needle = params.value;
            const startTime = Date.now();
            while (Date.now() - startTime < timeout) {
              const match = getConsoleLogs().find((entry) => includesNeedle(entry.text, needle));
              if (match) {
                return {
                  content: [{ type: "text", text: `Console message matching "${needle}" found: "${match.text}"` }],
                  details: { condition: params.condition, value: needle, matchedText: match.text, matchedType: match.type }
                };
              }
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            throw new Error(`Timed out waiting for console message matching "${needle}" (${timeout}ms)`);
          }
          case "element_count": {
            const threshold = parseThreshold(params.threshold ?? ">=1");
            if (!threshold) {
              return {
                content: [{ type: "text", text: `element_count threshold is malformed: "${params.threshold}"` }],
                details: { error: "malformed threshold", condition: params.condition },
                isError: true
              };
            }
            const selector = params.value;
            const op = threshold.op;
            const n = threshold.n;
            await target.waitForFunction(
              ({ selector: selector2, op: op2, n: n2 }) => {
                const count = document.querySelectorAll(selector2).length;
                switch (op2) {
                  case ">=":
                    return count >= n2;
                  case "<=":
                    return count <= n2;
                  case "==":
                    return count === n2;
                  case ">":
                    return count > n2;
                  case "<":
                    return count < n2;
                  default:
                    return false;
                }
              },
              { selector, op, n },
              { timeout }
            );
            return {
              content: [{ type: "text", text: `Element count for "${selector}" satisfies ${op}${n}` }],
              details: { condition: params.condition, value: selector, threshold: `${op}${n}` }
            };
          }
          case "region_stable": {
            const script = createRegionStableScript(params.value);
            await target.waitForFunction(script, void 0, { timeout, polling: 200 });
            return {
              content: [{ type: "text", text: `Region "${params.value}" is now stable` }],
              details: { condition: params.condition, value: params.value }
            };
          }
        }
      } catch (err) {
        return {
          content: [{ type: "text", text: `Wait failed: ${err.message}` }],
          details: { error: err.message, condition: params.condition, value: params.value },
          isError: true
        };
      }
    }
  });
}
export {
  registerWaitTools
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2Jyb3dzZXItdG9vbHMvdG9vbHMvd2FpdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHR5cGUgeyBFeHRlbnNpb25BUEkgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7IFR5cGUgfSBmcm9tIFwiQHNpbmNsYWlyL3R5cGVib3hcIjtcbmltcG9ydCB7IFN0cmluZ0VudW0gfSBmcm9tIFwiQGdzZC9waS1haVwiO1xuaW1wb3J0IHtcblx0dmFsaWRhdGVXYWl0UGFyYW1zLFxuXHRjcmVhdGVSZWdpb25TdGFibGVTY3JpcHQsXG5cdHBhcnNlVGhyZXNob2xkLFxuXHRpbmNsdWRlc05lZWRsZSxcbn0gZnJvbSBcIi4uL2NvcmUuanNcIjtcbmltcG9ydCB0eXBlIHsgVG9vbERlcHMgfSBmcm9tIFwiLi4vc3RhdGUuanNcIjtcbmltcG9ydCB7XG5cdGdldENvbnNvbGVMb2dzLFxufSBmcm9tIFwiLi4vc3RhdGUuanNcIjtcblxuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyV2FpdFRvb2xzKHBpOiBFeHRlbnNpb25BUEksIGRlcHM6IFRvb2xEZXBzKTogdm9pZCB7XG5cdHBpLnJlZ2lzdGVyVG9vbCh7XG5cdFx0bmFtZTogXCJicm93c2VyX3dhaXRfZm9yXCIsXG5cdFx0bGFiZWw6IFwiQnJvd3NlciBXYWl0IEZvclwiLFxuXHRcdGRlc2NyaXB0aW9uOlxuXHRcdFx0XCJXYWl0IGZvciBhIGNvbmRpdGlvbiBiZWZvcmUgY29udGludWluZy4gVXNlIGFmdGVyIGFjdGlvbnMgdGhhdCB0cmlnZ2VyIGFzeW5jIHVwZGF0ZXMgXHUyMDE0IGRhdGEgZmV0Y2hlcywgcm91dGUgY2hhbmdlcywgYW5pbWF0aW9ucywgbG9hZGluZyBzcGlubmVycy4gQ2hvb3NlIHRoZSBhcHByb3ByaWF0ZSBjb25kaXRpb246ICdzZWxlY3Rvcl92aXNpYmxlJyB3YWl0cyBmb3IgYW4gZWxlbWVudCB0byBhcHBlYXIsICdzZWxlY3Rvcl9oaWRkZW4nIHdhaXRzIGZvciBpdCB0byBkaXNhcHBlYXIsICd1cmxfY29udGFpbnMnIHdhaXRzIGZvciB0aGUgVVJMIHRvIG1hdGNoLCAnbmV0d29ya19pZGxlJyB3YWl0cyBmb3IgYWxsIG5ldHdvcmsgcmVxdWVzdHMgdG8gZmluaXNoLCAnZGVsYXknIHdhaXRzIGEgZml4ZWQgbnVtYmVyIG9mIG1pbGxpc2Vjb25kcywgJ3RleHRfdmlzaWJsZScgd2FpdHMgZm9yIHRleHQgdG8gYXBwZWFyIGluIHRoZSBwYWdlIGJvZHksICd0ZXh0X2hpZGRlbicgd2FpdHMgZm9yIHRleHQgdG8gZGlzYXBwZWFyIGZyb20gdGhlIHBhZ2UgYm9keSwgJ3JlcXVlc3RfY29tcGxldGVkJyB3YWl0cyBmb3IgYSBuZXR3b3JrIHJlc3BvbnNlIHdob3NlIFVSTCBjb250YWlucyB0aGUgZ2l2ZW4gc3Vic3RyaW5nLCAnY29uc29sZV9tZXNzYWdlJyB3YWl0cyBmb3IgYSBjb25zb2xlIGxvZyBtZXNzYWdlIGNvbnRhaW5pbmcgdGhlIGdpdmVuIHN1YnN0cmluZywgJ2VsZW1lbnRfY291bnQnIHdhaXRzIGZvciB0aGUgbnVtYmVyIG9mIGVsZW1lbnRzIG1hdGNoaW5nIHRoZSBDU1Mgc2VsZWN0b3IgaW4gJ3ZhbHVlJyB0byBzYXRpc2Z5IHRoZSAndGhyZXNob2xkJyBleHByZXNzaW9uIChlLmcuICc+PTMnLCAnPT0wJywgJzw1JyksICdyZWdpb25fc3RhYmxlJyB3YWl0cyBmb3IgdGhlIERPTSByZWdpb24gbWF0Y2hpbmcgdGhlIENTUyBzZWxlY3RvciBpbiAndmFsdWUnIHRvIHN0b3AgY2hhbmdpbmcuXCIsXG5cdFx0cGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe1xuXHRcdFx0Y29uZGl0aW9uOiBTdHJpbmdFbnVtKFtcblx0XHRcdFx0XCJzZWxlY3Rvcl92aXNpYmxlXCIsXG5cdFx0XHRcdFwic2VsZWN0b3JfaGlkZGVuXCIsXG5cdFx0XHRcdFwidXJsX2NvbnRhaW5zXCIsXG5cdFx0XHRcdFwibmV0d29ya19pZGxlXCIsXG5cdFx0XHRcdFwiZGVsYXlcIixcblx0XHRcdFx0XCJ0ZXh0X3Zpc2libGVcIixcblx0XHRcdFx0XCJ0ZXh0X2hpZGRlblwiLFxuXHRcdFx0XHRcInJlcXVlc3RfY29tcGxldGVkXCIsXG5cdFx0XHRcdFwiY29uc29sZV9tZXNzYWdlXCIsXG5cdFx0XHRcdFwiZWxlbWVudF9jb3VudFwiLFxuXHRcdFx0XHRcInJlZ2lvbl9zdGFibGVcIixcblx0XHRcdF0gYXMgY29uc3QpLFxuXHRcdFx0dmFsdWU6IFR5cGUuT3B0aW9uYWwoXG5cdFx0XHRcdFR5cGUuU3RyaW5nKHtcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFx0XHRcdFwiRm9yIHNlbGVjdG9yX3Zpc2libGUvc2VsZWN0b3JfaGlkZGVuL2VsZW1lbnRfY291bnQvcmVnaW9uX3N0YWJsZTogQ1NTIHNlbGVjdG9yLiBGb3IgdXJsX2NvbnRhaW5zL3JlcXVlc3RfY29tcGxldGVkOiBVUkwgc3Vic3RyaW5nLiBGb3IgdGV4dF92aXNpYmxlL3RleHRfaGlkZGVuL2NvbnNvbGVfbWVzc2FnZTogdGV4dCBzdWJzdHJpbmcuIEZvciBkZWxheTogbWlsbGlzZWNvbmRzIGFzIGEgc3RyaW5nIChlLmcuICcxMDAwJykuIE5vdCB1c2VkIGZvciBuZXR3b3JrX2lkbGUuXCIsXG5cdFx0XHRcdH0pXG5cdFx0XHQpLFxuXHRcdFx0dGhyZXNob2xkOiBUeXBlLk9wdGlvbmFsKFxuXHRcdFx0XHRUeXBlLlN0cmluZyh7XG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcdFx0XHRcIlRocmVzaG9sZCBleHByZXNzaW9uIGZvciBlbGVtZW50X2NvdW50IChlLmcuICc+PTMnLCAnPT0wJywgJzw1Jywgb3IgYmFyZSAnMycgd2hpY2ggZGVmYXVsdHMgdG8gPj0pLiBPbmx5IHVzZWQgd2l0aCBlbGVtZW50X2NvdW50IGNvbmRpdGlvbi5cIixcblx0XHRcdFx0fSlcblx0XHRcdCksXG5cdFx0XHR0aW1lb3V0OiBUeXBlLk9wdGlvbmFsKFxuXHRcdFx0XHRUeXBlLk51bWJlcih7XG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246IFwiTWF4aW11bSBtaWxsaXNlY29uZHMgdG8gd2FpdCBiZWZvcmUgZmFpbGluZyAoZGVmYXVsdDogMTAwMDApXCIsXG5cdFx0XHRcdH0pXG5cdFx0XHQpLFxuXHRcdH0pLFxuXG5cdFx0YXN5bmMgZXhlY3V0ZShfdG9vbENhbGxJZCwgcGFyYW1zLCBfc2lnbmFsLCBfb25VcGRhdGUsIF9jdHgpIHtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IHsgcGFnZTogcCB9ID0gYXdhaXQgZGVwcy5lbnN1cmVCcm93c2VyKCk7XG5cdFx0XHRcdGNvbnN0IHRhcmdldCA9IGRlcHMuZ2V0QWN0aXZlVGFyZ2V0KCk7XG5cdFx0XHRcdGNvbnN0IHRpbWVvdXQgPSBwYXJhbXMudGltZW91dCA/PyAxMDAwMDtcblxuXHRcdFx0XHRjb25zdCB2YWxpZGF0aW9uID0gdmFsaWRhdGVXYWl0UGFyYW1zKHsgY29uZGl0aW9uOiBwYXJhbXMuY29uZGl0aW9uLCB2YWx1ZTogcGFyYW1zLnZhbHVlLCB0aHJlc2hvbGQ6IChwYXJhbXMgYXMgYW55KS50aHJlc2hvbGQgfSk7XG5cdFx0XHRcdGlmICh2YWxpZGF0aW9uKSB7XG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiB2YWxpZGF0aW9uLmVycm9yIH1dLFxuXHRcdFx0XHRcdFx0ZGV0YWlsczogeyBlcnJvcjogdmFsaWRhdGlvbi5lcnJvciwgY29uZGl0aW9uOiBwYXJhbXMuY29uZGl0aW9uIH0sXG5cdFx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRzd2l0Y2ggKHBhcmFtcy5jb25kaXRpb24pIHtcblx0XHRcdFx0XHRjYXNlIFwic2VsZWN0b3JfdmlzaWJsZVwiOiB7XG5cdFx0XHRcdFx0XHRpZiAoIXBhcmFtcy52YWx1ZSkge1xuXHRcdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcInNlbGVjdG9yX3Zpc2libGUgcmVxdWlyZXMgYSB2YWx1ZSAoQ1NTIHNlbGVjdG9yKVwiIH1dLFxuXHRcdFx0XHRcdFx0XHRcdGRldGFpbHM6IHt9LFxuXHRcdFx0XHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsXG5cdFx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRhd2FpdCB0YXJnZXQud2FpdEZvclNlbGVjdG9yKHBhcmFtcy52YWx1ZSwgeyBzdGF0ZTogXCJ2aXNpYmxlXCIsIHRpbWVvdXQgfSk7XG5cdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYEVsZW1lbnQgXCIke3BhcmFtcy52YWx1ZX1cIiBpcyBub3cgdmlzaWJsZWAgfV0sXG5cdFx0XHRcdFx0XHRcdGRldGFpbHM6IHsgY29uZGl0aW9uOiBwYXJhbXMuY29uZGl0aW9uLCB2YWx1ZTogcGFyYW1zLnZhbHVlIH0sXG5cdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGNhc2UgXCJzZWxlY3Rvcl9oaWRkZW5cIjoge1xuXHRcdFx0XHRcdFx0aWYgKCFwYXJhbXMudmFsdWUpIHtcblx0XHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJzZWxlY3Rvcl9oaWRkZW4gcmVxdWlyZXMgYSB2YWx1ZSAoQ1NTIHNlbGVjdG9yKVwiIH1dLFxuXHRcdFx0XHRcdFx0XHRcdGRldGFpbHM6IHt9LFxuXHRcdFx0XHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsXG5cdFx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRhd2FpdCB0YXJnZXQud2FpdEZvclNlbGVjdG9yKHBhcmFtcy52YWx1ZSwgeyBzdGF0ZTogXCJoaWRkZW5cIiwgdGltZW91dCB9KTtcblx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgRWxlbWVudCBcIiR7cGFyYW1zLnZhbHVlfVwiIGlzIG5vdyBoaWRkZW5gIH1dLFxuXHRcdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGNvbmRpdGlvbjogcGFyYW1zLmNvbmRpdGlvbiwgdmFsdWU6IHBhcmFtcy52YWx1ZSB9LFxuXHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRjYXNlIFwidXJsX2NvbnRhaW5zXCI6IHtcblx0XHRcdFx0XHRcdGlmICghcGFyYW1zLnZhbHVlKSB7XG5cdFx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwidXJsX2NvbnRhaW5zIHJlcXVpcmVzIGEgdmFsdWUgKFVSTCBzdWJzdHJpbmcpXCIgfV0sXG5cdFx0XHRcdFx0XHRcdFx0ZGV0YWlsczoge30sXG5cdFx0XHRcdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdGF3YWl0IHAud2FpdEZvclVSTCgodXJsKSA9PiB1cmwudG9TdHJpbmcoKS5pbmNsdWRlcyhwYXJhbXMudmFsdWUhKSwgeyB0aW1lb3V0IH0pO1xuXHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBVUkwgbm93IGNvbnRhaW5zIFwiJHtwYXJhbXMudmFsdWV9XCIuIEN1cnJlbnQgVVJMOiAke3AudXJsKCl9YCB9XSxcblx0XHRcdFx0XHRcdFx0ZGV0YWlsczogeyBjb25kaXRpb246IHBhcmFtcy5jb25kaXRpb24sIHZhbHVlOiBwYXJhbXMudmFsdWUsIHVybDogcC51cmwoKSB9LFxuXHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRjYXNlIFwibmV0d29ya19pZGxlXCI6IHtcblx0XHRcdFx0XHRcdGF3YWl0IHAud2FpdEZvckxvYWRTdGF0ZShcIm5ldHdvcmtpZGxlXCIsIHsgdGltZW91dCB9KTtcblx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIk5ldHdvcmsgaXMgaWRsZVwiIH1dLFxuXHRcdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGNvbmRpdGlvbjogcGFyYW1zLmNvbmRpdGlvbiB9LFxuXHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRjYXNlIFwiZGVsYXlcIjoge1xuXHRcdFx0XHRcdFx0Y29uc3QgbXMgPSBwYXJzZUludChwYXJhbXMudmFsdWUgPz8gXCIxMDAwXCIsIDEwKTtcblx0XHRcdFx0XHRcdGlmIChpc05hTihtcykpIHtcblx0XHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJkZWxheSByZXF1aXJlcyBhIG51bWVyaWMgdmFsdWUgKG1pbGxpc2Vjb25kcylcIiB9XSxcblx0XHRcdFx0XHRcdFx0XHRkZXRhaWxzOiB7fSxcblx0XHRcdFx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0YXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgbXMpKTtcblx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgV2FpdGVkICR7bXN9bXNgIH1dLFxuXHRcdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGNvbmRpdGlvbjogcGFyYW1zLmNvbmRpdGlvbiwgbXMgfSxcblx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Y2FzZSBcInRleHRfdmlzaWJsZVwiOiB7XG5cdFx0XHRcdFx0XHRhd2FpdCB0YXJnZXQud2FpdEZvckZ1bmN0aW9uKFxuXHRcdFx0XHRcdFx0XHQobmVlZGxlOiBzdHJpbmcpID0+IHtcblx0XHRcdFx0XHRcdFx0XHRjb25zdCBib2R5ID0gZG9jdW1lbnQuYm9keT8uaW5uZXJUZXh0ID8/IFwiXCI7XG5cdFx0XHRcdFx0XHRcdFx0cmV0dXJuIGJvZHkudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhuZWVkbGUudG9Mb3dlckNhc2UoKSk7XG5cdFx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHRcdHBhcmFtcy52YWx1ZSEsXG5cdFx0XHRcdFx0XHRcdHsgdGltZW91dCB9XG5cdFx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBUZXh0IFwiJHtwYXJhbXMudmFsdWV9XCIgaXMgbm93IHZpc2libGUgb24gdGhlIHBhZ2VgIH1dLFxuXHRcdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGNvbmRpdGlvbjogcGFyYW1zLmNvbmRpdGlvbiwgdmFsdWU6IHBhcmFtcy52YWx1ZSB9LFxuXHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRjYXNlIFwidGV4dF9oaWRkZW5cIjoge1xuXHRcdFx0XHRcdFx0YXdhaXQgdGFyZ2V0LndhaXRGb3JGdW5jdGlvbihcblx0XHRcdFx0XHRcdFx0KG5lZWRsZTogc3RyaW5nKSA9PiB7XG5cdFx0XHRcdFx0XHRcdFx0Y29uc3QgYm9keSA9IGRvY3VtZW50LmJvZHk/LmlubmVyVGV4dCA/PyBcIlwiO1xuXHRcdFx0XHRcdFx0XHRcdHJldHVybiAhYm9keS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKG5lZWRsZS50b0xvd2VyQ2FzZSgpKTtcblx0XHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRcdFx0cGFyYW1zLnZhbHVlISxcblx0XHRcdFx0XHRcdFx0eyB0aW1lb3V0IH1cblx0XHRcdFx0XHRcdCk7XG5cdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYFRleHQgXCIke3BhcmFtcy52YWx1ZX1cIiBpcyBubyBsb25nZXIgdmlzaWJsZSBvbiB0aGUgcGFnZWAgfV0sXG5cdFx0XHRcdFx0XHRcdGRldGFpbHM6IHsgY29uZGl0aW9uOiBwYXJhbXMuY29uZGl0aW9uLCB2YWx1ZTogcGFyYW1zLnZhbHVlIH0sXG5cdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGNhc2UgXCJyZXF1ZXN0X2NvbXBsZXRlZFwiOiB7XG5cdFx0XHRcdFx0XHRjb25zdCByZXNwb25zZSA9IGF3YWl0IGRlcHMuZ2V0QWN0aXZlUGFnZSgpLndhaXRGb3JSZXNwb25zZShcblx0XHRcdFx0XHRcdFx0KHJlc3ApID0+IHJlc3AudXJsKCkuaW5jbHVkZXMocGFyYW1zLnZhbHVlISksXG5cdFx0XHRcdFx0XHRcdHsgdGltZW91dCB9XG5cdFx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBSZXF1ZXN0IGNvbXBsZXRlZDogJHtyZXNwb25zZS51cmwoKX0gKHN0YXR1cyAke3Jlc3BvbnNlLnN0YXR1cygpfSlgIH1dLFxuXHRcdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGNvbmRpdGlvbjogcGFyYW1zLmNvbmRpdGlvbiwgdmFsdWU6IHBhcmFtcy52YWx1ZSwgdXJsOiByZXNwb25zZS51cmwoKSwgc3RhdHVzOiByZXNwb25zZS5zdGF0dXMoKSB9LFxuXHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRjYXNlIFwiY29uc29sZV9tZXNzYWdlXCI6IHtcblx0XHRcdFx0XHRcdGNvbnN0IG5lZWRsZSA9IHBhcmFtcy52YWx1ZSE7XG5cdFx0XHRcdFx0XHRjb25zdCBzdGFydFRpbWUgPSBEYXRlLm5vdygpO1xuXHRcdFx0XHRcdFx0d2hpbGUgKERhdGUubm93KCkgLSBzdGFydFRpbWUgPCB0aW1lb3V0KSB7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IG1hdGNoID0gZ2V0Q29uc29sZUxvZ3MoKS5maW5kKChlbnRyeSkgPT4gaW5jbHVkZXNOZWVkbGUoZW50cnkudGV4dCwgbmVlZGxlKSk7XG5cdFx0XHRcdFx0XHRcdGlmIChtYXRjaCkge1xuXHRcdFx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYENvbnNvbGUgbWVzc2FnZSBtYXRjaGluZyBcIiR7bmVlZGxlfVwiIGZvdW5kOiBcIiR7bWF0Y2gudGV4dH1cImAgfV0sXG5cdFx0XHRcdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGNvbmRpdGlvbjogcGFyYW1zLmNvbmRpdGlvbiwgdmFsdWU6IG5lZWRsZSwgbWF0Y2hlZFRleHQ6IG1hdGNoLnRleHQsIG1hdGNoZWRUeXBlOiBtYXRjaC50eXBlIH0sXG5cdFx0XHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHRhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4gc2V0VGltZW91dChyZXNvbHZlLCAxMDApKTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcihgVGltZWQgb3V0IHdhaXRpbmcgZm9yIGNvbnNvbGUgbWVzc2FnZSBtYXRjaGluZyBcIiR7bmVlZGxlfVwiICgke3RpbWVvdXR9bXMpYCk7XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Y2FzZSBcImVsZW1lbnRfY291bnRcIjoge1xuXHRcdFx0XHRcdFx0Y29uc3QgdGhyZXNob2xkID0gcGFyc2VUaHJlc2hvbGQoKHBhcmFtcyBhcyBhbnkpLnRocmVzaG9sZCA/PyBcIj49MVwiKTtcblx0XHRcdFx0XHRcdGlmICghdGhyZXNob2xkKSB7XG5cdFx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBlbGVtZW50X2NvdW50IHRocmVzaG9sZCBpcyBtYWxmb3JtZWQ6IFwiJHsocGFyYW1zIGFzIGFueSkudGhyZXNob2xkfVwiYCB9XSxcblx0XHRcdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGVycm9yOiBcIm1hbGZvcm1lZCB0aHJlc2hvbGRcIiwgY29uZGl0aW9uOiBwYXJhbXMuY29uZGl0aW9uIH0sXG5cdFx0XHRcdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdGNvbnN0IHNlbGVjdG9yID0gcGFyYW1zLnZhbHVlITtcblx0XHRcdFx0XHRcdGNvbnN0IG9wID0gdGhyZXNob2xkLm9wO1xuXHRcdFx0XHRcdFx0Y29uc3QgbiA9IHRocmVzaG9sZC5uO1xuXHRcdFx0XHRcdFx0YXdhaXQgdGFyZ2V0LndhaXRGb3JGdW5jdGlvbihcblx0XHRcdFx0XHRcdFx0KHsgc2VsZWN0b3IsIG9wLCBuIH06IHsgc2VsZWN0b3I6IHN0cmluZzsgb3A6IHN0cmluZzsgbjogbnVtYmVyIH0pID0+IHtcblx0XHRcdFx0XHRcdFx0XHRjb25zdCBjb3VudCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoc2VsZWN0b3IpLmxlbmd0aDtcblx0XHRcdFx0XHRcdFx0XHRzd2l0Y2ggKG9wKSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRjYXNlIFwiPj1cIjogcmV0dXJuIGNvdW50ID49IG47XG5cdFx0XHRcdFx0XHRcdFx0XHRjYXNlIFwiPD1cIjogcmV0dXJuIGNvdW50IDw9IG47XG5cdFx0XHRcdFx0XHRcdFx0XHRjYXNlIFwiPT1cIjogcmV0dXJuIGNvdW50ID09PSBuO1xuXHRcdFx0XHRcdFx0XHRcdFx0Y2FzZSBcIj5cIjogcmV0dXJuIGNvdW50ID4gbjtcblx0XHRcdFx0XHRcdFx0XHRcdGNhc2UgXCI8XCI6IHJldHVybiBjb3VudCA8IG47XG5cdFx0XHRcdFx0XHRcdFx0XHRkZWZhdWx0OiByZXR1cm4gZmFsc2U7XG5cdFx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdFx0XHR7IHNlbGVjdG9yLCBvcCwgbiB9LFxuXHRcdFx0XHRcdFx0XHR7IHRpbWVvdXQgfVxuXHRcdFx0XHRcdFx0KTtcblx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgRWxlbWVudCBjb3VudCBmb3IgXCIke3NlbGVjdG9yfVwiIHNhdGlzZmllcyAke29wfSR7bn1gIH1dLFxuXHRcdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGNvbmRpdGlvbjogcGFyYW1zLmNvbmRpdGlvbiwgdmFsdWU6IHNlbGVjdG9yLCB0aHJlc2hvbGQ6IGAke29wfSR7bn1gIH0sXG5cdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGNhc2UgXCJyZWdpb25fc3RhYmxlXCI6IHtcblx0XHRcdFx0XHRcdGNvbnN0IHNjcmlwdCA9IGNyZWF0ZVJlZ2lvblN0YWJsZVNjcmlwdChwYXJhbXMudmFsdWUhKTtcblx0XHRcdFx0XHRcdGF3YWl0IHRhcmdldC53YWl0Rm9yRnVuY3Rpb24oc2NyaXB0LCB1bmRlZmluZWQsIHsgdGltZW91dCwgcG9sbGluZzogMjAwIH0pO1xuXHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBSZWdpb24gXCIke3BhcmFtcy52YWx1ZX1cIiBpcyBub3cgc3RhYmxlYCB9XSxcblx0XHRcdFx0XHRcdFx0ZGV0YWlsczogeyBjb25kaXRpb246IHBhcmFtcy5jb25kaXRpb24sIHZhbHVlOiBwYXJhbXMudmFsdWUgfSxcblx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHR9IGNhdGNoIChlcnI6IGFueSkge1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgV2FpdCBmYWlsZWQ6ICR7ZXJyLm1lc3NhZ2V9YCB9XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7IGVycm9yOiBlcnIubWVzc2FnZSwgY29uZGl0aW9uOiBwYXJhbXMuY29uZGl0aW9uLCB2YWx1ZTogcGFyYW1zLnZhbHVlIH0sXG5cdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0fTtcblx0XHRcdH1cblx0XHR9LFxuXHR9KTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUNBLFNBQVMsWUFBWTtBQUNyQixTQUFTLGtCQUFrQjtBQUMzQjtBQUFBLEVBQ0M7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNNO0FBRVA7QUFBQSxFQUNDO0FBQUEsT0FDTTtBQUVBLFNBQVMsa0JBQWtCLElBQWtCLE1BQXNCO0FBQ3pFLEtBQUcsYUFBYTtBQUFBLElBQ2YsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsYUFDQztBQUFBLElBQ0QsWUFBWSxLQUFLLE9BQU87QUFBQSxNQUN2QixXQUFXLFdBQVc7QUFBQSxRQUNyQjtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxNQUNELENBQVU7QUFBQSxNQUNWLE9BQU8sS0FBSztBQUFBLFFBQ1gsS0FBSyxPQUFPO0FBQUEsVUFDWCxhQUNDO0FBQUEsUUFDRixDQUFDO0FBQUEsTUFDRjtBQUFBLE1BQ0EsV0FBVyxLQUFLO0FBQUEsUUFDZixLQUFLLE9BQU87QUFBQSxVQUNYLGFBQ0M7QUFBQSxRQUNGLENBQUM7QUFBQSxNQUNGO0FBQUEsTUFDQSxTQUFTLEtBQUs7QUFBQSxRQUNiLEtBQUssT0FBTztBQUFBLFVBQ1gsYUFBYTtBQUFBLFFBQ2QsQ0FBQztBQUFBLE1BQ0Y7QUFBQSxJQUNELENBQUM7QUFB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
