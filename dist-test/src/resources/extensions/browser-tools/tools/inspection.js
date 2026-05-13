import { Type } from "@sinclair/typebox";
import { StringEnum } from "@gsd/pi-ai";
import {
  getConsoleLogs,
  setConsoleLogs,
  getNetworkLogs,
  setNetworkLogs,
  getDialogLogs,
  setDialogLogs
} from "../state.js";
function registerInspectionTools(pi, deps) {
  pi.registerTool({
    name: "browser_get_console_logs",
    label: "Browser Console Logs",
    description: "Get all buffered browser console logs and JavaScript errors captured since the last clear. Each entry includes timestamp and page URL. Note: JS errors are also auto-surfaced in interaction tool responses \u2014 use this for the full log.",
    parameters: Type.Object({
      clear: Type.Optional(
        Type.Boolean({
          description: "Clear the buffer after returning logs (default: true)"
        })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const shouldClear = params.clear !== false;
      const logs = [...getConsoleLogs()];
      if (shouldClear) {
        setConsoleLogs([]);
      }
      if (logs.length === 0) {
        return {
          content: [{ type: "text", text: "No console logs captured." }],
          details: { logs: [], count: 0 }
        };
      }
      const formatted = logs.map((entry) => {
        const time = new Date(entry.timestamp).toISOString().slice(11, 23);
        return `[${time}] [${entry.type.toUpperCase()}] ${entry.text}`;
      }).join("\n");
      const truncated = deps.truncateText(formatted);
      return {
        content: [
          {
            type: "text",
            text: `${logs.length} console log(s):

${truncated}`
          }
        ],
        details: { logs, count: logs.length }
      };
    }
  });
  pi.registerTool({
    name: "browser_get_network_logs",
    label: "Browser Network Logs",
    description: "Get buffered network requests and responses. Shows method, URL, status code, and resource type for all requests. Includes response body for failed requests (4xx/5xx). Use to debug API failures, CORS issues, missing resources, and auth problems.",
    parameters: Type.Object({
      clear: Type.Optional(
        Type.Boolean({
          description: "Clear the buffer after returning logs (default: true)"
        })
      ),
      filter: Type.Optional(
        StringEnum(["all", "errors", "fetch-xhr"])
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const shouldClear = params.clear !== false;
      let logs = [...getNetworkLogs()];
      if (shouldClear) {
        setNetworkLogs([]);
      }
      if (params.filter === "errors") {
        logs = logs.filter((e) => e.failed || e.status !== null && e.status >= 400);
      } else if (params.filter === "fetch-xhr") {
        logs = logs.filter((e) => e.resourceType === "fetch" || e.resourceType === "xhr");
      }
      if (logs.length === 0) {
        return {
          content: [{ type: "text", text: "No network requests captured." }],
          details: { logs: [], count: 0 }
        };
      }
      const formatted = logs.map((entry) => {
        const time = new Date(entry.timestamp).toISOString().slice(11, 23);
        const status = entry.failed ? `FAILED (${entry.failureText})` : `${entry.status}`;
        let line = `[${time}] ${entry.method} ${entry.url} \u2192 ${status} (${entry.resourceType})`;
        if (entry.responseBody) {
          line += `
  Response: ${entry.responseBody}`;
        }
        return line;
      }).join("\n");
      const truncated = deps.truncateText(formatted);
      return {
        content: [
          {
            type: "text",
            text: `${logs.length} network request(s):

${truncated}`
          }
        ],
        details: { count: logs.length }
      };
    }
  });
  pi.registerTool({
    name: "browser_get_dialog_logs",
    label: "Browser Dialog Logs",
    description: "Get buffered JavaScript dialog events (alert, confirm, prompt, beforeunload). Dialogs are auto-accepted to prevent page freezes. Use this to see what dialogs appeared and their messages.",
    parameters: Type.Object({
      clear: Type.Optional(
        Type.Boolean({
          description: "Clear the buffer after returning logs (default: true)"
        })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const shouldClear = params.clear !== false;
      const logs = [...getDialogLogs()];
      if (shouldClear) {
        setDialogLogs([]);
      }
      if (logs.length === 0) {
        return {
          content: [{ type: "text", text: "No dialog events captured." }],
          details: { logs: [], count: 0 }
        };
      }
      const formatted = logs.map((entry) => {
        const time = new Date(entry.timestamp).toISOString().slice(11, 23);
        let line = `[${time}] ${entry.type}: "${entry.message}"`;
        if (entry.defaultValue) {
          line += ` (default: "${entry.defaultValue}")`;
        }
        line += ` \u2192 auto-accepted`;
        return line;
      }).join("\n");
      const truncated = deps.truncateText(formatted);
      return {
        content: [
          {
            type: "text",
            text: `${logs.length} dialog(s):

${truncated}`
          }
        ],
        details: { logs, count: logs.length }
      };
    }
  });
  pi.registerTool({
    name: "browser_evaluate",
    label: "Browser Evaluate",
    description: "Execute a JavaScript expression in the browser context and return the result. Useful for reading DOM state, checking values, etc.",
    parameters: Type.Object({
      expression: Type.String({
        description: "JavaScript expression to evaluate in the page context"
      })
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        await deps.ensureBrowser();
        const target = deps.getActiveTarget();
        const result = await target.evaluate(params.expression);
        let serialized;
        if (result === void 0) {
          serialized = "undefined";
        } else {
          try {
            serialized = JSON.stringify(result, null, 2) ?? "undefined";
          } catch {
            serialized = `[non-serializable: ${typeof result}]`;
          }
        }
        const truncated = deps.truncateText(serialized);
        return {
          content: [{ type: "text", text: truncated }],
          details: { expression: params.expression }
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Evaluation failed: ${err.message}`
            }
          ],
          details: { error: err.message },
          isError: true
        };
      }
    }
  });
  pi.registerTool({
    name: "browser_get_accessibility_tree",
    label: "Browser Accessibility Tree",
    description: "Get the accessibility tree of the current page as structured text. Shows roles, names, labels, values, and states of all interactive elements. Use this to understand page structure before clicking \u2014 it reveals buttons, inputs, links, and their labels without needing to guess CSS selectors or coordinates. Much more reliable than inspecting the DOM directly.",
    parameters: Type.Object({
      selector: Type.Optional(
        Type.String({
          description: "Scope the accessibility tree to a specific element by CSS selector (e.g. 'main', 'form', '#modal'). If omitted, returns the full page tree."
        })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const { page: p } = await deps.ensureBrowser();
        const target = deps.getActiveTarget();
        let snapshot;
        if (params.selector) {
          const locator = target.locator(params.selector).first();
          snapshot = await locator.ariaSnapshot();
        } else {
          snapshot = await target.locator("body").ariaSnapshot();
        }
        const truncated = deps.truncateText(snapshot);
        const scope = params.selector ? `element "${params.selector}"` : "full page";
        const viewport = p.viewportSize();
        const vpText = viewport ? `${viewport.width}x${viewport.height}` : "unknown";
        return {
          content: [
            {
              type: "text",
              text: `Accessibility tree for ${scope} (viewport: ${vpText}):

${truncated}`
            }
          ],
          details: { scope, snapshot, viewport: vpText }
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Accessibility tree failed: ${err.message}`
            }
          ],
          details: { error: err.message },
          isError: true
        };
      }
    }
  });
  pi.registerTool({
    name: "browser_find",
    label: "Browser Find",
    description: "Find elements on the page by text content, ARIA role, or CSS selector. Returns only the matched nodes as a compact accessibility snapshot \u2014 far cheaper than browser_get_accessibility_tree. Use this after any action to locate a specific button, input, heading, or link before clicking it.",
    promptGuidelines: [
      "Use browser_find for cheap targeted discovery before requesting the full accessibility tree.",
      "Prefer browser_find when you need one button, input, heading, dialog, or alert rather than a full-page structure dump."
    ],
    parameters: Type.Object({
      text: Type.Optional(
        Type.String({
          description: "Find elements whose visible text contains this string (case-insensitive)."
        })
      ),
      role: Type.Optional(
        Type.String({
          description: "ARIA role to filter by, e.g. 'button', 'link', 'heading', 'textbox', 'dialog', 'alert'."
        })
      ),
      selector: Type.Optional(
        Type.String({
          description: "CSS selector to scope the search. If omitted, searches the full page."
        })
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Maximum number of results to return (default: 20)."
        })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        await deps.ensureBrowser();
        const target = deps.getActiveTarget();
        const limit = params.limit ?? 20;
        const results = await target.evaluate(({ text, role, selector, limit: limit2 }) => {
          const root = selector ? document.querySelector(selector) : document.body;
          if (!root) return [];
          let candidates;
          if (role) {
            const roleMap = {
              button: 'button,[role="button"]',
              link: 'a[href],[role="link"]',
              heading: 'h1,h2,h3,h4,h5,h6,[role="heading"]',
              textbox: 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]),textarea,[role="textbox"]',
              checkbox: 'input[type="checkbox"],[role="checkbox"]',
              radio: 'input[type="radio"],[role="radio"]',
              combobox: 'select,[role="combobox"]',
              dialog: 'dialog,[role="dialog"]',
              alert: '[role="alert"]',
              navigation: 'nav,[role="navigation"]',
              listitem: 'li,[role="listitem"]'
            };
            const cssForRole = roleMap[role.toLowerCase()] ?? `[role="${role}"]`;
            candidates = Array.from(root.querySelectorAll(cssForRole));
          } else {
            candidates = Array.from(root.querySelectorAll("*"));
          }
          if (text) {
            const lower = text.toLowerCase();
            candidates = candidates.filter(
              (el) => (el.textContent ?? "").toLowerCase().includes(lower) || (el.getAttribute("aria-label") ?? "").toLowerCase().includes(lower) || (el.getAttribute("placeholder") ?? "").toLowerCase().includes(lower) || (el.getAttribute("value") ?? "").toLowerCase().includes(lower)
            );
          }
          return candidates.slice(0, limit2).map((el) => {
            const tag = el.tagName.toLowerCase();
            const id = el.id ? `#${el.id}` : "";
            const classes = Array.from(el.classList).slice(0, 2).map((c) => `.${c}`).join("");
            const ariaLabel = el.getAttribute("aria-label") ?? "";
            const placeholder = el.getAttribute("placeholder") ?? "";
            const textContent = (el.textContent ?? "").trim().slice(0, 80);
            const role2 = el.getAttribute("role") ?? "";
            const type = el.getAttribute("type") ?? "";
            const href = el.getAttribute("href") ?? "";
            const value = el.value ?? "";
            return { tag, id, classes, ariaLabel, placeholder, textContent, role: role2, type, href, value };
          });
        }, { text: params.text, role: params.role, selector: params.selector, limit });
        if (results.length === 0) {
          return {
            content: [{ type: "text", text: "No elements found matching the criteria." }],
            details: { count: 0 }
          };
        }
        const lines = results.map((r) => {
          const parts = [`${r.tag}${r.id}${r.classes}`];
          if (r.role) parts.push(`role="${r.role}"`);
          if (r.type) parts.push(`type="${r.type}"`);
          if (r.ariaLabel) parts.push(`aria-label="${r.ariaLabel}"`);
          if (r.placeholder) parts.push(`placeholder="${r.placeholder}"`);
          if (r.href) parts.push(`href="${r.href.slice(0, 60)}"`);
          if (r.value) parts.push(`value="${r.value.slice(0, 40)}"`);
          if (r.textContent && !r.ariaLabel) parts.push(`"${r.textContent}"`);
          return "  " + parts.join(" ");
        });
        const criteria = [];
        if (params.role) criteria.push(`role="${params.role}"`);
        if (params.text) criteria.push(`text="${params.text}"`);
        if (params.selector) criteria.push(`within="${params.selector}"`);
        return {
          content: [
            {
              type: "text",
              text: `Found ${results.length} element(s) [${criteria.join(", ")}]:
${lines.join("\n")}`
            }
          ],
          details: { count: results.length, results }
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Find failed: ${err.message}` }],
          details: { error: err.message },
          isError: true
        };
      }
    }
  });
  pi.registerTool({
    name: "browser_get_page_source",
    label: "Browser Page Source",
    description: "Get the current HTML source of the page (or a specific element). Use when you need to inspect the actual DOM structure \u2014 verify semantic HTML, check that elements rendered correctly, debug why a selector isn't matching, or audit accessibility markup. Output is truncated for large pages.",
    parameters: Type.Object({
      selector: Type.Optional(
        Type.String({
          description: "CSS selector to scope the output to a specific element (e.g. 'main', 'form', '#app'). If omitted, returns the full page HTML."
        })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        await deps.ensureBrowser();
        const target = deps.getActiveTarget();
        let html;
        if (params.selector) {
          html = await target.locator(params.selector).first().evaluate((el) => el.outerHTML);
        } else {
          html = await target.content();
        }
        const truncated = deps.truncateText(html);
        const scope = params.selector ? `element "${params.selector}"` : "full page";
        return {
          content: [
            {
              type: "text",
              text: `HTML source of ${scope}:

${truncated}`
            }
          ],
          details: { scope }
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Get page source failed: ${err.message}`
            }
          ],
          details: { error: err.message },
          isError: true
        };
      }
    }
  });
}
export {
  registerInspectionTools
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2Jyb3dzZXItdG9vbHMvdG9vbHMvaW5zcGVjdGlvbi50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHR5cGUgeyBFeHRlbnNpb25BUEkgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7IFR5cGUgfSBmcm9tIFwiQHNpbmNsYWlyL3R5cGVib3hcIjtcbmltcG9ydCB7IFN0cmluZ0VudW0gfSBmcm9tIFwiQGdzZC9waS1haVwiO1xuaW1wb3J0IHR5cGUgeyBUb29sRGVwcyB9IGZyb20gXCIuLi9zdGF0ZS5qc1wiO1xuaW1wb3J0IHtcblx0Z2V0Q29uc29sZUxvZ3MsXG5cdHNldENvbnNvbGVMb2dzLFxuXHRnZXROZXR3b3JrTG9ncyxcblx0c2V0TmV0d29ya0xvZ3MsXG5cdGdldERpYWxvZ0xvZ3MsXG5cdHNldERpYWxvZ0xvZ3MsXG59IGZyb20gXCIuLi9zdGF0ZS5qc1wiO1xuXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJJbnNwZWN0aW9uVG9vbHMocGk6IEV4dGVuc2lvbkFQSSwgZGVwczogVG9vbERlcHMpOiB2b2lkIHtcblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHQvLyBicm93c2VyX2dldF9jb25zb2xlX2xvZ3Ncblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHRwaS5yZWdpc3RlclRvb2woe1xuXHRcdG5hbWU6IFwiYnJvd3Nlcl9nZXRfY29uc29sZV9sb2dzXCIsXG5cdFx0bGFiZWw6IFwiQnJvd3NlciBDb25zb2xlIExvZ3NcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiR2V0IGFsbCBidWZmZXJlZCBicm93c2VyIGNvbnNvbGUgbG9ncyBhbmQgSmF2YVNjcmlwdCBlcnJvcnMgY2FwdHVyZWQgc2luY2UgdGhlIGxhc3QgY2xlYXIuIEVhY2ggZW50cnkgaW5jbHVkZXMgdGltZXN0YW1wIGFuZCBwYWdlIFVSTC4gTm90ZTogSlMgZXJyb3JzIGFyZSBhbHNvIGF1dG8tc3VyZmFjZWQgaW4gaW50ZXJhY3Rpb24gdG9vbCByZXNwb25zZXMgXHUyMDE0IHVzZSB0aGlzIGZvciB0aGUgZnVsbCBsb2cuXCIsXG5cdFx0cGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe1xuXHRcdFx0Y2xlYXI6IFR5cGUuT3B0aW9uYWwoXG5cdFx0XHRcdFR5cGUuQm9vbGVhbih7XG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246IFwiQ2xlYXIgdGhlIGJ1ZmZlciBhZnRlciByZXR1cm5pbmcgbG9ncyAoZGVmYXVsdDogdHJ1ZSlcIixcblx0XHRcdFx0fSlcblx0XHRcdCksXG5cdFx0fSksXG5cblx0XHRhc3luYyBleGVjdXRlKF90b29sQ2FsbElkLCBwYXJhbXMsIF9zaWduYWwsIF9vblVwZGF0ZSwgX2N0eCkge1xuXHRcdFx0Y29uc3Qgc2hvdWxkQ2xlYXIgPSBwYXJhbXMuY2xlYXIgIT09IGZhbHNlO1xuXHRcdFx0Y29uc3QgbG9ncyA9IFsuLi5nZXRDb25zb2xlTG9ncygpXTtcblxuXHRcdFx0aWYgKHNob3VsZENsZWFyKSB7XG5cdFx0XHRcdHNldENvbnNvbGVMb2dzKFtdKTtcblx0XHRcdH1cblxuXHRcdFx0aWYgKGxvZ3MubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiTm8gY29uc29sZSBsb2dzIGNhcHR1cmVkLlwiIH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgbG9nczogW10sIGNvdW50OiAwIH0sXG5cdFx0XHRcdH07XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IGZvcm1hdHRlZCA9IGxvZ3Ncblx0XHRcdFx0Lm1hcCgoZW50cnkpID0+IHtcblx0XHRcdFx0XHRjb25zdCB0aW1lID0gbmV3IERhdGUoZW50cnkudGltZXN0YW1wKS50b0lTT1N0cmluZygpLnNsaWNlKDExLCAyMyk7XG5cdFx0XHRcdFx0cmV0dXJuIGBbJHt0aW1lfV0gWyR7ZW50cnkudHlwZS50b1VwcGVyQ2FzZSgpfV0gJHtlbnRyeS50ZXh0fWA7XG5cdFx0XHRcdH0pXG5cdFx0XHRcdC5qb2luKFwiXFxuXCIpO1xuXG5cdFx0XHRjb25zdCB0cnVuY2F0ZWQgPSBkZXBzLnRydW5jYXRlVGV4dChmb3JtYXR0ZWQpO1xuXG5cdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRjb250ZW50OiBbXG5cdFx0XHRcdFx0e1xuXHRcdFx0XHRcdFx0dHlwZTogXCJ0ZXh0XCIsXG5cdFx0XHRcdFx0XHR0ZXh0OiBgJHtsb2dzLmxlbmd0aH0gY29uc29sZSBsb2cocyk6XFxuXFxuJHt0cnVuY2F0ZWR9YCxcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHRdLFxuXHRcdFx0XHRkZXRhaWxzOiB7IGxvZ3MsIGNvdW50OiBsb2dzLmxlbmd0aCB9LFxuXHRcdFx0fTtcblx0XHR9LFxuXHR9KTtcblxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdC8vIGJyb3dzZXJfZ2V0X25ldHdvcmtfbG9nc1xuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdHBpLnJlZ2lzdGVyVG9vbCh7XG5cdFx0bmFtZTogXCJicm93c2VyX2dldF9uZXR3b3JrX2xvZ3NcIixcblx0XHRsYWJlbDogXCJCcm93c2VyIE5ldHdvcmsgTG9nc1wiLFxuXHRcdGRlc2NyaXB0aW9uOlxuXHRcdFx0XCJHZXQgYnVmZmVyZWQgbmV0d29yayByZXF1ZXN0cyBhbmQgcmVzcG9uc2VzLiBTaG93cyBtZXRob2QsIFVSTCwgc3RhdHVzIGNvZGUsIGFuZCByZXNvdXJjZSB0eXBlIGZvciBhbGwgcmVxdWVzdHMuIEluY2x1ZGVzIHJlc3BvbnNlIGJvZHkgZm9yIGZhaWxlZCByZXF1ZXN0cyAoNHh4LzV4eCkuIFVzZSB0byBkZWJ1ZyBBUEkgZmFpbHVyZXMsIENPUlMgaXNzdWVzLCBtaXNzaW5nIHJlc291cmNlcywgYW5kIGF1dGggcHJvYmxlbXMuXCIsXG5cdFx0cGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe1xuXHRcdFx0Y2xlYXI6IFR5cGUuT3B0aW9uYWwoXG5cdFx0XHRcdFR5cGUuQm9vbGVhbih7XG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246IFwiQ2xlYXIgdGhlIGJ1ZmZlciBhZnRlciByZXR1cm5pbmcgbG9ncyAoZGVmYXVsdDogdHJ1ZSlcIixcblx0XHRcdFx0fSlcblx0XHRcdCksXG5cdFx0XHRmaWx0ZXI6IFR5cGUuT3B0aW9uYWwoXG5cdFx0XHRcdFN0cmluZ0VudW0oW1wiYWxsXCIsIFwiZXJyb3JzXCIsIFwiZmV0Y2gteGhyXCJdIGFzIGNvbnN0KVxuXHRcdFx0KSxcblx0XHR9KSxcblxuXHRcdGFzeW5jIGV4ZWN1dGUoX3Rvb2xDYWxsSWQsIHBhcmFtcywgX3NpZ25hbCwgX29uVXBkYXRlLCBfY3R4KSB7XG5cdFx0XHRjb25zdCBzaG91bGRDbGVhciA9IHBhcmFtcy5jbGVhciAhPT0gZmFsc2U7XG5cdFx0XHRsZXQgbG9ncyA9IFsuLi5nZXROZXR3b3JrTG9ncygpXTtcblxuXHRcdFx0aWYgKHNob3VsZENsZWFyKSB7XG5cdFx0XHRcdHNldE5ldHdvcmtMb2dzKFtdKTtcblx0XHRcdH1cblxuXHRcdFx0aWYgKHBhcmFtcy5maWx0ZXIgPT09IFwiZXJyb3JzXCIpIHtcblx0XHRcdFx0bG9ncyA9IGxvZ3MuZmlsdGVyKGUgPT4gZS5mYWlsZWQgfHwgKGUuc3RhdHVzICE9PSBudWxsICYmIGUuc3RhdHVzID49IDQwMCkpO1xuXHRcdFx0fSBlbHNlIGlmIChwYXJhbXMuZmlsdGVyID09PSBcImZldGNoLXhoclwiKSB7XG5cdFx0XHRcdGxvZ3MgPSBsb2dzLmZpbHRlcihlID0+IGUucmVzb3VyY2VUeXBlID09PSBcImZldGNoXCIgfHwgZS5yZXNvdXJjZVR5cGUgPT09IFwieGhyXCIpO1xuXHRcdFx0fVxuXG5cdFx0XHRpZiAobG9ncy5sZW5ndGggPT09IDApIHtcblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJObyBuZXR3b3JrIHJlcXVlc3RzIGNhcHR1cmVkLlwiIH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgbG9nczogW10sIGNvdW50OiAwIH0sXG5cdFx0XHRcdH07XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IGZvcm1hdHRlZCA9IGxvZ3Ncblx0XHRcdFx0Lm1hcCgoZW50cnkpID0+IHtcblx0XHRcdFx0XHRjb25zdCB0aW1lID0gbmV3IERhdGUoZW50cnkudGltZXN0YW1wKS50b0lTT1N0cmluZygpLnNsaWNlKDExLCAyMyk7XG5cdFx0XHRcdFx0Y29uc3Qgc3RhdHVzID0gZW50cnkuZmFpbGVkXG5cdFx0XHRcdFx0XHQ/IGBGQUlMRUQgKCR7ZW50cnkuZmFpbHVyZVRleHR9KWBcblx0XHRcdFx0XHRcdDogYCR7ZW50cnkuc3RhdHVzfWA7XG5cdFx0XHRcdFx0bGV0IGxpbmUgPSBgWyR7dGltZX1dICR7ZW50cnkubWV0aG9kfSAke2VudHJ5LnVybH0gXHUyMTkyICR7c3RhdHVzfSAoJHtlbnRyeS5yZXNvdXJjZVR5cGV9KWA7XG5cdFx0XHRcdFx0aWYgKGVudHJ5LnJlc3BvbnNlQm9keSkge1xuXHRcdFx0XHRcdFx0bGluZSArPSBgXFxuICBSZXNwb25zZTogJHtlbnRyeS5yZXNwb25zZUJvZHl9YDtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0cmV0dXJuIGxpbmU7XG5cdFx0XHRcdH0pXG5cdFx0XHRcdC5qb2luKFwiXFxuXCIpO1xuXG5cdFx0XHRjb25zdCB0cnVuY2F0ZWQgPSBkZXBzLnRydW5jYXRlVGV4dChmb3JtYXR0ZWQpO1xuXG5cdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRjb250ZW50OiBbXG5cdFx0XHRcdFx0e1xuXHRcdFx0XHRcdFx0dHlwZTogXCJ0ZXh0XCIsXG5cdFx0XHRcdFx0XHR0ZXh0OiBgJHtsb2dzLmxlbmd0aH0gbmV0d29yayByZXF1ZXN0KHMpOlxcblxcbiR7dHJ1bmNhdGVkfWAsXG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0XSxcblx0XHRcdFx0ZGV0YWlsczogeyBjb3VudDogbG9ncy5sZW5ndGggfSxcblx0XHRcdH07XG5cdFx0fSxcblx0fSk7XG5cblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHQvLyBicm93c2VyX2dldF9kaWFsb2dfbG9nc1xuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdHBpLnJlZ2lzdGVyVG9vbCh7XG5cdFx0bmFtZTogXCJicm93c2VyX2dldF9kaWFsb2dfbG9nc1wiLFxuXHRcdGxhYmVsOiBcIkJyb3dzZXIgRGlhbG9nIExvZ3NcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiR2V0IGJ1ZmZlcmVkIEphdmFTY3JpcHQgZGlhbG9nIGV2ZW50cyAoYWxlcnQsIGNvbmZpcm0sIHByb21wdCwgYmVmb3JldW5sb2FkKS4gRGlhbG9ncyBhcmUgYXV0by1hY2NlcHRlZCB0byBwcmV2ZW50IHBhZ2UgZnJlZXplcy4gVXNlIHRoaXMgdG8gc2VlIHdoYXQgZGlhbG9ncyBhcHBlYXJlZCBhbmQgdGhlaXIgbWVzc2FnZXMuXCIsXG5cdFx0cGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe1xuXHRcdFx0Y2xlYXI6IFR5cGUuT3B0aW9uYWwoXG5cdFx0XHRcdFR5cGUuQm9vbGVhbih7XG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246IFwiQ2xlYXIgdGhlIGJ1ZmZlciBhZnRlciByZXR1cm5pbmcgbG9ncyAoZGVmYXVsdDogdHJ1ZSlcIixcblx0XHRcdFx0fSlcblx0XHRcdCksXG5cdFx0fSksXG5cblx0XHRhc3luYyBleGVjdXRlKF90b29sQ2FsbElkLCBwYXJhbXMsIF9zaWduYWwsIF9vblVwZGF0ZSwgX2N0eCkge1xuXHRcdFx0Y29uc3Qgc2hvdWxkQ2xlYXIgPSBwYXJhbXMuY2xlYXIgIT09IGZhbHNlO1xuXHRcdFx0Y29uc3QgbG9ncyA9IFsuLi5nZXREaWFsb2dMb2dzKCldO1xuXG5cdFx0XHRpZiAoc2hvdWxkQ2xlYXIpIHtcblx0XHRcdFx0c2V0RGlhbG9nTG9ncyhbXSk7XG5cdFx0XHR9XG5cblx0XHRcdGlmIChsb2dzLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIk5vIGRpYWxvZyBldmVudHMgY2FwdHVyZWQuXCIgfV0sXG5cdFx0XHRcdFx0ZGV0YWlsczogeyBsb2dzOiBbXSwgY291bnQ6IDAgfSxcblx0XHRcdFx0fTtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgZm9ybWF0dGVkID0gbG9nc1xuXHRcdFx0XHQubWFwKChlbnRyeSkgPT4ge1xuXHRcdFx0XHRcdGNvbnN0IHRpbWUgPSBuZXcgRGF0ZShlbnRyeS50aW1lc3RhbXApLnRvSVNPU3RyaW5nKCkuc2xpY2UoMTEsIDIzKTtcblx0XHRcdFx0XHRsZXQgbGluZSA9IGBbJHt0aW1lfV0gJHtlbnRyeS50eXBlfTogXCIke2VudHJ5Lm1lc3NhZ2V9XCJgO1xuXHRcdFx0XHRcdGlmIChlbnRyeS5kZWZhdWx0VmFsdWUpIHtcblx0XHRcdFx0XHRcdGxpbmUgKz0gYCAoZGVmYXVsdDogXCIke2VudHJ5LmRlZmF1bHRWYWx1ZX1cIilgO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRsaW5lICs9IGAgXHUyMTkyIGF1dG8tYWNjZXB0ZWRgO1xuXHRcdFx0XHRcdHJldHVybiBsaW5lO1xuXHRcdFx0XHR9KVxuXHRcdFx0XHQuam9pbihcIlxcblwiKTtcblxuXHRcdFx0Y29uc3QgdHJ1bmNhdGVkID0gZGVwcy50cnVuY2F0ZVRleHQoZm9ybWF0dGVkKTtcblxuXHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0Y29udGVudDogW1xuXHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdHR5cGU6IFwidGV4dFwiLFxuXHRcdFx0XHRcdFx0dGV4dDogYCR7bG9ncy5sZW5ndGh9IGRpYWxvZyhzKTpcXG5cXG4ke3RydW5jYXRlZH1gLFxuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdF0sXG5cdFx0XHRcdGRldGFpbHM6IHsgbG9ncywgY291bnQ6IGxvZ3MubGVuZ3RoIH0sXG5cdFx0XHR9O1xuXHRcdH0sXG5cdH0pO1xuXG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblx0Ly8gYnJvd3Nlcl9ldmFsdWF0ZVxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdHBpLnJlZ2lzdGVyVG9vbCh7XG5cdFx0bmFtZTogXCJicm93c2VyX2V2YWx1YXRlXCIsXG5cdFx0bGFiZWw6IFwiQnJvd3NlciBFdmFsdWF0ZVwiLFxuXHRcdGRlc2NyaXB0aW9uOlxuXHRcdFx0XCJFeGVjdXRlIGEgSmF2YVNjcmlwdCBleHByZXNzaW9uIGluIHRoZSBicm93c2VyIGNvbnRleHQgYW5kIHJldHVybiB0aGUgcmVzdWx0LiBVc2VmdWwgZm9yIHJlYWRpbmcgRE9NIHN0YXRlLCBjaGVja2luZyB2YWx1ZXMsIGV0Yy5cIixcblx0XHRwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG5cdFx0XHRleHByZXNzaW9uOiBUeXBlLlN0cmluZyh7XG5cdFx0XHRcdGRlc2NyaXB0aW9uOiBcIkphdmFTY3JpcHQgZXhwcmVzc2lvbiB0byBldmFsdWF0ZSBpbiB0aGUgcGFnZSBjb250ZXh0XCIsXG5cdFx0XHR9KSxcblx0XHR9KSxcblxuXHRcdGFzeW5jIGV4ZWN1dGUoX3Rvb2xDYWxsSWQsIHBhcmFtcywgX3NpZ25hbCwgX29uVXBkYXRlLCBfY3R4KSB7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRhd2FpdCBkZXBzLmVuc3VyZUJyb3dzZXIoKTtcblx0XHRcdFx0Y29uc3QgdGFyZ2V0ID0gZGVwcy5nZXRBY3RpdmVUYXJnZXQoKTtcblx0XHRcdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgdGFyZ2V0LmV2YWx1YXRlKHBhcmFtcy5leHByZXNzaW9uKTtcblxuXHRcdFx0XHRsZXQgc2VyaWFsaXplZDogc3RyaW5nO1xuXHRcdFx0XHRpZiAocmVzdWx0ID09PSB1bmRlZmluZWQpIHtcblx0XHRcdFx0XHRzZXJpYWxpemVkID0gXCJ1bmRlZmluZWRcIjtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdFx0c2VyaWFsaXplZCA9IEpTT04uc3RyaW5naWZ5KHJlc3VsdCwgbnVsbCwgMikgPz8gXCJ1bmRlZmluZWRcIjtcblx0XHRcdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0XHRcdHNlcmlhbGl6ZWQgPSBgW25vbi1zZXJpYWxpemFibGU6ICR7dHlwZW9mIHJlc3VsdH1dYDtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRjb25zdCB0cnVuY2F0ZWQgPSBkZXBzLnRydW5jYXRlVGV4dChzZXJpYWxpemVkKTtcblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogdHJ1bmNhdGVkIH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgZXhwcmVzc2lvbjogcGFyYW1zLmV4cHJlc3Npb24gfSxcblx0XHRcdFx0fTtcblx0XHRcdH0gY2F0Y2ggKGVycjogYW55KSB7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW1xuXHRcdFx0XHRcdFx0e1xuXHRcdFx0XHRcdFx0XHR0eXBlOiBcInRleHRcIixcblx0XHRcdFx0XHRcdFx0dGV4dDogYEV2YWx1YXRpb24gZmFpbGVkOiAke2Vyci5tZXNzYWdlfWAsXG5cdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdF0sXG5cdFx0XHRcdFx0ZGV0YWlsczogeyBlcnJvcjogZXJyLm1lc3NhZ2UgfSxcblx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHR9O1xuXHRcdFx0fVxuXHRcdH0sXG5cdH0pO1xuXG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblx0Ly8gYnJvd3Nlcl9nZXRfYWNjZXNzaWJpbGl0eV90cmVlXG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblx0cGkucmVnaXN0ZXJUb29sKHtcblx0XHRuYW1lOiBcImJyb3dzZXJfZ2V0X2FjY2Vzc2liaWxpdHlfdHJlZVwiLFxuXHRcdGxhYmVsOiBcIkJyb3dzZXIgQWNjZXNzaWJpbGl0eSBUcmVlXCIsXG5cdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcIkdldCB0aGUgYWNjZXNzaWJpbGl0eSB0cmVlIG9mIHRoZSBjdXJyZW50IHBhZ2UgYXMgc3RydWN0dXJlZCB0ZXh0LiBTaG93cyByb2xlcywgbmFtZXMsIGxhYmVscywgdmFsdWVzLCBhbmQgc3RhdGVzIG9mIGFsbCBpbnRlcmFjdGl2ZSBlbGVtZW50cy4gVXNlIHRoaXMgdG8gdW5kZXJzdGFuZCBwYWdlIHN0cnVjdHVyZSBiZWZvcmUgY2xpY2tpbmcgXHUyMDE0IGl0IHJldmVhbHMgYnV0dG9ucywgaW5wdXRzLCBsaW5rcywgYW5kIHRoZWlyIGxhYmVscyB3aXRob3V0IG5lZWRpbmcgdG8gZ3Vlc3MgQ1NTIHNlbGVjdG9ycyBvciBjb29yZGluYXRlcy4gTXVjaCBtb3JlIHJlbGlhYmxlIHRoYW4gaW5zcGVjdGluZyB0aGUgRE9NIGRpcmVjdGx5LlwiLFxuXHRcdHBhcmFtZXRlcnM6IFR5cGUuT2JqZWN0KHtcblx0XHRcdHNlbGVjdG9yOiBUeXBlLk9wdGlvbmFsKFxuXHRcdFx0XHRUeXBlLlN0cmluZyh7XG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcdFx0XHRcIlNjb3BlIHRoZSBhY2Nlc3NpYmlsaXR5IHRyZWUgdG8gYSBzcGVjaWZpYyBlbGVtZW50IGJ5IENTUyBzZWxlY3RvciAoZS5nLiAnbWFpbicsICdmb3JtJywgJyNtb2RhbCcpLiBJZiBvbWl0dGVkLCByZXR1cm5zIHRoZSBmdWxsIHBhZ2UgdHJlZS5cIixcblx0XHRcdFx0fSlcblx0XHRcdCksXG5cdFx0fSksXG5cblx0XHRhc3luYyBleGVjdXRlKF90b29sQ2FsbElkLCBwYXJhbXMsIF9zaWduYWwsIF9vblVwZGF0ZSwgX2N0eCkge1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0Y29uc3QgeyBwYWdlOiBwIH0gPSBhd2FpdCBkZXBzLmVuc3VyZUJyb3dzZXIoKTtcblx0XHRcdFx0Y29uc3QgdGFyZ2V0ID0gZGVwcy5nZXRBY3RpdmVUYXJnZXQoKTtcblxuXHRcdFx0XHRsZXQgc25hcHNob3Q6IHN0cmluZztcblx0XHRcdFx0aWYgKHBhcmFtcy5zZWxlY3Rvcikge1xuXHRcdFx0XHRcdGNvbnN0IGxvY2F0b3IgPSB0YXJnZXQubG9jYXRvcihwYXJhbXMuc2VsZWN0b3IpLmZpcnN0KCk7XG5cdFx0XHRcdFx0c25hcHNob3QgPSBhd2FpdCBsb2NhdG9yLmFyaWFTbmFwc2hvdCgpO1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdHNuYXBzaG90ID0gYXdhaXQgdGFyZ2V0LmxvY2F0b3IoXCJib2R5XCIpLmFyaWFTbmFwc2hvdCgpO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Y29uc3QgdHJ1bmNhdGVkID0gZGVwcy50cnVuY2F0ZVRleHQoc25hcHNob3QpO1xuXHRcdFx0XHRjb25zdCBzY29wZSA9IHBhcmFtcy5zZWxlY3RvciA/IGBlbGVtZW50IFwiJHtwYXJhbXMuc2VsZWN0b3J9XCJgIDogXCJmdWxsIHBhZ2VcIjtcblx0XHRcdFx0Y29uc3Qgdmlld3BvcnQgPSBwLnZpZXdwb3J0U2l6ZSgpO1xuXHRcdFx0XHRjb25zdCB2cFRleHQgPSB2aWV3cG9ydCA/IGAke3ZpZXdwb3J0LndpZHRofXgke3ZpZXdwb3J0LmhlaWdodH1gIDogXCJ1bmtub3duXCI7XG5cblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbXG5cdFx0XHRcdFx0XHR7XG5cdFx0XHRcdFx0XHRcdHR5cGU6IFwidGV4dFwiLFxuXHRcdFx0XHRcdFx0XHR0ZXh0OiBgQWNjZXNzaWJpbGl0eSB0cmVlIGZvciAke3Njb3BlfSAodmlld3BvcnQ6ICR7dnBUZXh0fSk6XFxuXFxuJHt0cnVuY2F0ZWR9YCxcblx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7IHNjb3BlLCBzbmFwc2hvdCwgdmlld3BvcnQ6IHZwVGV4dCB9LFxuXHRcdFx0XHR9O1xuXHRcdFx0fSBjYXRjaCAoZXJyOiBhbnkpIHtcblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbXG5cdFx0XHRcdFx0XHR7XG5cdFx0XHRcdFx0XHRcdHR5cGU6IFwidGV4dFwiLFxuXHRcdFx0XHRcdFx0XHR0ZXh0OiBgQWNjZXNzaWJpbGl0eSB0cmVlIGZhaWxlZDogJHtlcnIubWVzc2FnZX1gLFxuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRdLFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgZXJyb3I6IGVyci5tZXNzYWdlIH0sXG5cdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0fTtcblx0XHRcdH1cblx0XHR9LFxuXHR9KTtcblxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdC8vIGJyb3dzZXJfZmluZFxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdHBpLnJlZ2lzdGVyVG9vbCh7XG5cdFx0bmFtZTogXCJicm93c2VyX2ZpbmRcIixcblx0XHRsYWJlbDogXCJCcm93c2VyIEZpbmRcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiRmluZCBlbGVtZW50cyBvbiB0aGUgcGFnZSBieSB0ZXh0IGNvbnRlbnQsIEFSSUEgcm9sZSwgb3IgQ1NTIHNlbGVjdG9yLiBSZXR1cm5zIG9ubHkgdGhlIG1hdGNoZWQgbm9kZXMgYXMgYSBjb21wYWN0IGFjY2Vzc2liaWxpdHkgc25hcHNob3QgXHUyMDE0IGZhciBjaGVhcGVyIHRoYW4gYnJvd3Nlcl9nZXRfYWNjZXNzaWJpbGl0eV90cmVlLiBVc2UgdGhpcyBhZnRlciBhbnkgYWN0aW9uIHRvIGxvY2F0ZSBhIHNwZWNpZmljIGJ1dHRvbiwgaW5wdXQsIGhlYWRpbmcsIG9yIGxpbmsgYmVmb3JlIGNsaWNraW5nIGl0LlwiLFxuXHRcdHByb21wdEd1aWRlbGluZXM6IFtcblx0XHRcdFwiVXNlIGJyb3dzZXJfZmluZCBmb3IgY2hlYXAgdGFyZ2V0ZWQgZGlzY292ZXJ5IGJlZm9yZSByZXF1ZXN0aW5nIHRoZSBmdWxsIGFjY2Vzc2liaWxpdHkgdHJlZS5cIixcblx0XHRcdFwiUHJlZmVyIGJyb3dzZXJfZmluZCB3aGVuIHlvdSBuZWVkIG9uZSBidXR0b24sIGlucHV0LCBoZWFkaW5nLCBkaWFsb2csIG9yIGFsZXJ0IHJhdGhlciB0aGFuIGEgZnVsbC1wYWdlIHN0cnVjdHVyZSBkdW1wLlwiLFxuXHRcdF0sXG5cdFx0cGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe1xuXHRcdFx0dGV4dDogVHlwZS5PcHRpb25hbChcblx0XHRcdFx0VHlwZS5TdHJpbmcoe1xuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOiBcIkZpbmQgZWxlbWVudHMgd2hvc2UgdmlzaWJsZSB0ZXh0IGNvbnRhaW5zIHRoaXMgc3RyaW5nIChjYXNlLWluc2Vuc2l0aXZlKS5cIixcblx0XHRcdFx0fSlcblx0XHRcdCksXG5cdFx0XHRyb2xlOiBUeXBlLk9wdGlvbmFsKFxuXHRcdFx0XHRUeXBlLlN0cmluZyh7XG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246IFwiQVJJQSByb2xlIHRvIGZpbHRlciBieSwgZS5nLiAnYnV0dG9uJywgJ2xpbmsnLCAnaGVhZGluZycsICd0ZXh0Ym94JywgJ2RpYWxvZycsICdhbGVydCcuXCIsXG5cdFx0XHRcdH0pXG5cdFx0XHQpLFxuXHRcdFx0c2VsZWN0b3I6IFR5cGUuT3B0aW9uYWwoXG5cdFx0XHRcdFR5cGUuU3RyaW5nKHtcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjogXCJDU1Mgc2VsZWN0b3IgdG8gc2NvcGUgdGhlIHNlYXJjaC4gSWYgb21pdHRlZCwgc2VhcmNoZXMgdGhlIGZ1bGwgcGFnZS5cIixcblx0XHRcdFx0fSlcblx0XHRcdCksXG5cdFx0XHRsaW1pdDogVHlwZS5PcHRpb25hbChcblx0XHRcdFx0VHlwZS5OdW1iZXIoe1xuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOiBcIk1heGltdW0gbnVtYmVyIG9mIHJlc3VsdHMgdG8gcmV0dXJuIChkZWZhdWx0OiAyMCkuXCIsXG5cdFx0XHRcdH0pXG5cdFx0XHQpLFxuXHRcdH0pLFxuXG5cdFx0YXN5bmMgZXhlY3V0ZShfdG9vbENhbGxJZCwgcGFyYW1zLCBfc2lnbmFsLCBfb25VcGRhdGUsIF9jdHgpIHtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGF3YWl0IGRlcHMuZW5zdXJlQnJvd3NlcigpO1xuXHRcdFx0XHRjb25zdCB0YXJnZXQgPSBkZXBzLmdldEFjdGl2ZVRhcmdldCgpO1xuXHRcdFx0XHRjb25zdCBsaW1pdCA9IHBhcmFtcy5saW1pdCA/PyAyMDtcblxuXHRcdFx0XHRjb25zdCByZXN1bHRzID0gYXdhaXQgdGFyZ2V0LmV2YWx1YXRlKCh7IHRleHQsIHJvbGUsIHNlbGVjdG9yLCBsaW1pdCB9KSA9PiB7XG5cdFx0XHRcdFx0Y29uc3Qgcm9vdCA9IHNlbGVjdG9yID8gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihzZWxlY3RvcikgOiBkb2N1bWVudC5ib2R5O1xuXHRcdFx0XHRcdGlmICghcm9vdCkgcmV0dXJuIFtdO1xuXG5cdFx0XHRcdFx0bGV0IGNhbmRpZGF0ZXM6IEVsZW1lbnRbXTtcblx0XHRcdFx0XHRpZiAocm9sZSkge1xuXHRcdFx0XHRcdFx0Y29uc3Qgcm9sZU1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcblx0XHRcdFx0XHRcdFx0YnV0dG9uOiAnYnV0dG9uLFtyb2xlPVwiYnV0dG9uXCJdJyxcblx0XHRcdFx0XHRcdFx0bGluazogJ2FbaHJlZl0sW3JvbGU9XCJsaW5rXCJdJyxcblx0XHRcdFx0XHRcdFx0aGVhZGluZzogJ2gxLGgyLGgzLGg0LGg1LGg2LFtyb2xlPVwiaGVhZGluZ1wiXScsXG5cdFx0XHRcdFx0XHRcdHRleHRib3g6ICdpbnB1dDpub3QoW3R5cGU9XCJoaWRkZW5cIl0pOm5vdChbdHlwZT1cImNoZWNrYm94XCJdKTpub3QoW3R5cGU9XCJyYWRpb1wiXSk6bm90KFt0eXBlPVwic3VibWl0XCJdKTpub3QoW3R5cGU9XCJidXR0b25cIl0pLHRleHRhcmVhLFtyb2xlPVwidGV4dGJveFwiXScsXG5cdFx0XHRcdFx0XHRcdGNoZWNrYm94OiAnaW5wdXRbdHlwZT1cImNoZWNrYm94XCJdLFtyb2xlPVwiY2hlY2tib3hcIl0nLFxuXHRcdFx0XHRcdFx0XHRyYWRpbzogJ2lucHV0W3R5cGU9XCJyYWRpb1wiXSxbcm9sZT1cInJhZGlvXCJdJyxcblx0XHRcdFx0XHRcdFx0Y29tYm9ib3g6ICdzZWxlY3QsW3JvbGU9XCJjb21ib2JveFwiXScsXG5cdFx0XHRcdFx0XHRcdGRpYWxvZzogJ2RpYWxvZyxbcm9sZT1cImRpYWxvZ1wiXScsXG5cdFx0XHRcdFx0XHRcdGFsZXJ0OiAnW3JvbGU9XCJhbGVydFwiXScsXG5cdFx0XHRcdFx0XHRcdG5hdmlnYXRpb246ICduYXYsW3JvbGU9XCJuYXZpZ2F0aW9uXCJdJyxcblx0XHRcdFx0XHRcdFx0bGlzdGl0ZW06ICdsaSxbcm9sZT1cImxpc3RpdGVtXCJdJyxcblx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0XHRjb25zdCBjc3NGb3JSb2xlID0gcm9sZU1hcFtyb2xlLnRvTG93ZXJDYXNlKCldID8/IGBbcm9sZT1cIiR7cm9sZX1cIl1gO1xuXHRcdFx0XHRcdFx0Y2FuZGlkYXRlcyA9IEFycmF5LmZyb20ocm9vdC5xdWVyeVNlbGVjdG9yQWxsKGNzc0ZvclJvbGUpKTtcblx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0Y2FuZGlkYXRlcyA9IEFycmF5LmZyb20ocm9vdC5xdWVyeVNlbGVjdG9yQWxsKCcqJykpO1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGlmICh0ZXh0KSB7XG5cdFx0XHRcdFx0XHRjb25zdCBsb3dlciA9IHRleHQudG9Mb3dlckNhc2UoKTtcblx0XHRcdFx0XHRcdGNhbmRpZGF0ZXMgPSBjYW5kaWRhdGVzLmZpbHRlcihlbCA9PlxuXHRcdFx0XHRcdFx0XHQoZWwudGV4dENvbnRlbnQgPz8gXCJcIikudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhsb3dlcikgfHxcblx0XHRcdFx0XHRcdFx0KGVsLmdldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIikgPz8gXCJcIikudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhsb3dlcikgfHxcblx0XHRcdFx0XHRcdFx0KGVsLmdldEF0dHJpYnV0ZShcInBsYWNlaG9sZGVyXCIpID8/IFwiXCIpLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMobG93ZXIpIHx8XG5cdFx0XHRcdFx0XHRcdChlbC5nZXRBdHRyaWJ1dGUoXCJ2YWx1ZVwiKSA/PyBcIlwiKS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKGxvd2VyKVxuXHRcdFx0XHRcdFx0KTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRyZXR1cm4gY2FuZGlkYXRlcy5zbGljZSgwLCBsaW1pdCkubWFwKGVsID0+IHtcblx0XHRcdFx0XHRcdGNvbnN0IHRhZyA9IGVsLnRhZ05hbWUudG9Mb3dlckNhc2UoKTtcblx0XHRcdFx0XHRcdGNvbnN0IGlkID0gZWwuaWQgPyBgIyR7ZWwuaWR9YCA6IFwiXCI7XG5cdFx0XHRcdFx0XHRjb25zdCBjbGFzc2VzID0gQXJyYXkuZnJvbShlbC5jbGFzc0xpc3QpLnNsaWNlKDAsIDIpLm1hcChjID0+IGAuJHtjfWApLmpvaW4oXCJcIik7XG5cdFx0XHRcdFx0XHRjb25zdCBhcmlhTGFiZWwgPSBlbC5nZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIpID8/IFwiXCI7XG5cdFx0XHRcdFx0XHRjb25zdCBwbGFjZWhvbGRlciA9IGVsLmdldEF0dHJpYnV0ZShcInBsYWNlaG9sZGVyXCIpID8/IFwiXCI7XG5cdFx0XHRcdFx0XHRjb25zdCB0ZXh0Q29udGVudCA9IChlbC50ZXh0Q29udGVudCA/PyBcIlwiKS50cmltKCkuc2xpY2UoMCwgODApO1xuXHRcdFx0XHRcdFx0Y29uc3Qgcm9sZSA9IGVsLmdldEF0dHJpYnV0ZShcInJvbGVcIikgPz8gXCJcIjtcblx0XHRcdFx0XHRcdGNvbnN0IHR5cGUgPSBlbC5nZXRBdHRyaWJ1dGUoXCJ0eXBlXCIpID8/IFwiXCI7XG5cdFx0XHRcdFx0XHRjb25zdCBocmVmID0gZWwuZ2V0QXR0cmlidXRlKFwiaHJlZlwiKSA/PyBcIlwiO1xuXHRcdFx0XHRcdFx0Y29uc3QgdmFsdWUgPSAoZWwgYXMgSFRNTElucHV0RWxlbWVudCkudmFsdWUgPz8gXCJcIjtcblxuXHRcdFx0XHRcdFx0cmV0dXJuIHsgdGFnLCBpZCwgY2xhc3NlcywgYXJpYUxhYmVsLCBwbGFjZWhvbGRlciwgdGV4dENvbnRlbnQsIHJvbGUsIHR5cGUsIGhyZWYsIHZhbHVlIH07XG5cdFx0XHRcdFx0fSk7XG5cdFx0XHRcdH0sIHsgdGV4dDogcGFyYW1zLnRleHQsIHJvbGU6IHBhcmFtcy5yb2xlLCBzZWxlY3RvcjogcGFyYW1zLnNlbGVjdG9yLCBsaW1pdCB9KTtcblxuXHRcdFx0XHRpZiAocmVzdWx0cy5sZW5ndGggPT09IDApIHtcblx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiTm8gZWxlbWVudHMgZm91bmQgbWF0Y2hpbmcgdGhlIGNyaXRlcmlhLlwiIH1dLFxuXHRcdFx0XHRcdFx0ZGV0YWlsczogeyBjb3VudDogMCB9LFxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRjb25zdCBsaW5lcyA9IHJlc3VsdHMubWFwKChyOiBhbnkpID0+IHtcblx0XHRcdFx0XHRjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbYCR7ci50YWd9JHtyLmlkfSR7ci5jbGFzc2VzfWBdO1xuXHRcdFx0XHRcdGlmIChyLnJvbGUpIHBhcnRzLnB1c2goYHJvbGU9XCIke3Iucm9sZX1cImApO1xuXHRcdFx0XHRcdGlmIChyLnR5cGUpIHBhcnRzLnB1c2goYHR5cGU9XCIke3IudHlwZX1cImApO1xuXHRcdFx0XHRcdGlmIChyLmFyaWFMYWJlbCkgcGFydHMucHVzaChgYXJpYS1sYWJlbD1cIiR7ci5hcmlhTGFiZWx9XCJgKTtcblx0XHRcdFx0XHRpZiAoci5wbGFjZWhvbGRlcikgcGFydHMucHVzaChgcGxhY2Vob2xkZXI9XCIke3IucGxhY2Vob2xkZXJ9XCJgKTtcblx0XHRcdFx0XHRpZiAoci5ocmVmKSBwYXJ0cy5wdXNoKGBocmVmPVwiJHtyLmhyZWYuc2xpY2UoMCwgNjApfVwiYCk7XG5cdFx0XHRcdFx0aWYgKHIudmFsdWUpIHBhcnRzLnB1c2goYHZhbHVlPVwiJHtyLnZhbHVlLnNsaWNlKDAsIDQwKX1cImApO1xuXHRcdFx0XHRcdGlmIChyLnRleHRDb250ZW50ICYmICFyLmFyaWFMYWJlbCkgcGFydHMucHVzaChgXCIke3IudGV4dENvbnRlbnR9XCJgKTtcblx0XHRcdFx0XHRyZXR1cm4gXCIgIFwiICsgcGFydHMuam9pbihcIiBcIik7XG5cdFx0XHRcdH0pO1xuXG5cdFx0XHRcdGNvbnN0IGNyaXRlcmlhOiBzdHJpbmdbXSA9IFtdO1xuXHRcdFx0XHRpZiAocGFyYW1zLnJvbGUpIGNyaXRlcmlhLnB1c2goYHJvbGU9XCIke3BhcmFtcy5yb2xlfVwiYCk7XG5cdFx0XHRcdGlmIChwYXJhbXMudGV4dCkgY3JpdGVyaWEucHVzaChgdGV4dD1cIiR7cGFyYW1zLnRleHR9XCJgKTtcblx0XHRcdFx0aWYgKHBhcmFtcy5zZWxlY3RvcikgY3JpdGVyaWEucHVzaChgd2l0aGluPVwiJHtwYXJhbXMuc2VsZWN0b3J9XCJgKTtcblxuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFtcblx0XHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdFx0dHlwZTogXCJ0ZXh0XCIsXG5cdFx0XHRcdFx0XHRcdHRleHQ6IGBGb3VuZCAke3Jlc3VsdHMubGVuZ3RofSBlbGVtZW50KHMpIFske2NyaXRlcmlhLmpvaW4oXCIsIFwiKX1dOlxcbiR7bGluZXMuam9pbihcIlxcblwiKX1gLFxuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRdLFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgY291bnQ6IHJlc3VsdHMubGVuZ3RoLCByZXN1bHRzIH0sXG5cdFx0XHRcdH07XG5cdFx0XHR9IGNhdGNoIChlcnI6IGFueSkge1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgRmluZCBmYWlsZWQ6ICR7ZXJyLm1lc3NhZ2V9YCB9XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7IGVycm9yOiBlcnIubWVzc2FnZSB9LFxuXHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsXG5cdFx0XHRcdH07XG5cdFx0XHR9XG5cdFx0fSxcblx0fSk7XG5cblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHQvLyBicm93c2VyX2dldF9wYWdlX3NvdXJjZVxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdHBpLnJlZ2lzdGVyVG9vbCh7XG5cdFx0bmFtZTogXCJicm93c2VyX2dldF9wYWdlX3NvdXJjZVwiLFxuXHRcdGxhYmVsOiBcIkJyb3dzZXIgUGFnZSBTb3VyY2VcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiR2V0IHRoZSBjdXJyZW50IEhUTUwgc291cmNlIG9mIHRoZSBwYWdlIChvciBhIHNwZWNpZmljIGVsZW1lbnQpLiBVc2Ugd2hlbiB5b3UgbmVlZCB0byBpbnNwZWN0IHRoZSBhY3R1YWwgRE9NIHN0cnVjdHVyZSBcdTIwMTQgdmVyaWZ5IHNlbWFudGljIEhUTUwsIGNoZWNrIHRoYXQgZWxlbWVudHMgcmVuZGVyZWQgY29ycmVjdGx5LCBkZWJ1ZyB3aHkgYSBzZWxlY3RvciBpc24ndCBtYXRjaGluZywgb3IgYXVkaXQgYWNjZXNzaWJpbGl0eSBtYXJrdXAuIE91dHB1dCBpcyB0cnVuY2F0ZWQgZm9yIGxhcmdlIHBhZ2VzLlwiLFxuXHRcdHBhcmFtZXRlcnM6IFR5cGUuT2JqZWN0KHtcblx0XHRcdHNlbGVjdG9yOiBUeXBlLk9wdGlvbmFsKFxuXHRcdFx0XHRUeXBlLlN0cmluZyh7XG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcdFx0XHRcIkNTUyBzZWxlY3RvciB0byBzY29wZSB0aGUgb3V0cHV0IHRvIGEgc3BlY2lmaWMgZWxlbWVudCAoZS5nLiAnbWFpbicsICdmb3JtJywgJyNhcHAnKS4gSWYgb21pdHRlZCwgcmV0dXJucyB0aGUgZnVsbCBwYWdlIEhUTUwuXCIsXG5cdFx0XHRcdH0pXG5cdFx0XHQpLFxuXHRcdH0pLFxuXG5cdFx0YXN5bmMgZXhlY3V0ZShfdG9vbENhbGxJZCwgcGFyYW1zLCBfc2lnbmFsLCBfb25VcGRhdGUsIF9jdHgpIHtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGF3YWl0IGRlcHMuZW5zdXJlQnJvd3NlcigpO1xuXHRcdFx0XHRjb25zdCB0YXJnZXQgPSBkZXBzLmdldEFjdGl2ZVRhcmdldCgpO1xuXG5cdFx0XHRcdGxldCBodG1sOiBzdHJpbmc7XG5cdFx0XHRcdGlmIChwYXJhbXMuc2VsZWN0b3IpIHtcblx0XHRcdFx0XHRodG1sID0gYXdhaXQgdGFyZ2V0LmxvY2F0b3IocGFyYW1zLnNlbGVjdG9yKS5maXJzdCgpLmV2YWx1YXRlKChlbDogRWxlbWVudCkgPT4gZWwub3V0ZXJIVE1MKTtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRodG1sID0gYXdhaXQgdGFyZ2V0LmNvbnRlbnQoKTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNvbnN0IHRydW5jYXRlZCA9IGRlcHMudHJ1bmNhdGVUZXh0KGh0bWwpO1xuXHRcdFx0XHRjb25zdCBzY29wZSA9IHBhcmFtcy5zZWxlY3RvciA/IGBlbGVtZW50IFwiJHtwYXJhbXMuc2VsZWN0b3J9XCJgIDogXCJmdWxsIHBhZ2VcIjtcblxuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFtcblx0XHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdFx0dHlwZTogXCJ0ZXh0XCIsXG5cdFx0XHRcdFx0XHRcdHRleHQ6IGBIVE1MIHNvdXJjZSBvZiAke3Njb3BlfTpcXG5cXG4ke3RydW5jYXRlZH1gLFxuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRdLFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgc2NvcGUgfSxcblx0XHRcdFx0fTtcblx0XHRcdH0gY2F0Y2ggKGVycjogYW55KSB7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW1xuXHRcdFx0XHRcdFx0e1xuXHRcdFx0XHRcdFx0XHR0eXBlOiBcInRleHRcIixcblx0XHRcdFx0XHRcdFx0dGV4dDogYEdldCBwYWdlIHNvdXJjZSBmYWlsZWQ6ICR7ZXJyLm1lc3NhZ2V9YCxcblx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7IGVycm9yOiBlcnIubWVzc2FnZSB9LFxuXHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsXG5cdFx0XHRcdH07XG5cdFx0XHR9XG5cdFx0fSxcblx0fSk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFDQSxTQUFTLFlBQVk7QUFDckIsU0FBUyxrQkFBa0I7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
