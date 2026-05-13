import { Type } from "@sinclair/typebox";
import {
  diffCompactStates
} from "../core.js";
import {
  setLastActionBeforeState,
  setLastActionAfterState
} from "../state.js";
function registerNavigationTools(pi, deps) {
  pi.registerTool({
    name: "browser_navigate",
    label: "Browser Navigate",
    description: "Open the browser (if not already open) and navigate to a URL. Waits for network idle. Returns page title and current URL. Use ONLY for visually verifying locally-running web apps (e.g. http://localhost:3000). Do NOT use for documentation sites, GitHub, search results, or any external URL \u2014 use web_search instead. Screenshots are only captured when the `screenshot` parameter is set to true.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to navigate to, e.g. http://localhost:3000" }),
      screenshot: Type.Optional(Type.Boolean({ description: "Capture and return a screenshot (default: false)", default: false }))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      let actionId = null;
      let beforeState = null;
      try {
        const { page: p } = await deps.ensureBrowser();
        beforeState = await deps.captureCompactPageState(p, { includeBodyText: true });
        actionId = deps.beginTrackedAction("browser_navigate", params, beforeState.url).id;
        await p.goto(params.url, { waitUntil: "domcontentloaded", timeout: 3e4 });
        await p.waitForLoadState("networkidle", { timeout: 5e3 }).catch(() => {
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        const title = await p.title();
        const url = p.url();
        const viewport = p.viewportSize();
        const vpText = viewport ? `${viewport.width}x${viewport.height}` : "unknown";
        const afterState = await deps.captureCompactPageState(p, { includeBodyText: true });
        const summary = deps.formatCompactStateSummary(afterState);
        const jsErrors = deps.getRecentErrors(p.url());
        const diff = diffCompactStates(beforeState, afterState);
        setLastActionBeforeState(beforeState);
        setLastActionAfterState(afterState);
        deps.finishTrackedAction(actionId, {
          status: "success",
          afterUrl: afterState.url,
          warningSummary: jsErrors.trim() || void 0,
          diffSummary: diff.summary,
          changed: diff.changed,
          beforeState,
          afterState
        });
        let screenshotContent = [];
        if (params.screenshot) {
          try {
            let buf = await p.screenshot({ type: "jpeg", quality: 80, scale: "css" });
            buf = await deps.constrainScreenshot(p, buf, "image/jpeg", 80);
            screenshotContent = [{ type: "image", data: buf.toString("base64"), mimeType: "image/jpeg" }];
          } catch {
          }
        }
        return {
          content: [
            { type: "text", text: `Navigated to: ${url}
Title: ${title}
Viewport: ${vpText}
Action: ${actionId}${jsErrors}

Diff:
${deps.formatDiffText(diff)}

Page summary:
${summary}` },
            ...screenshotContent
          ],
          details: { title, url, status: "loaded", viewport: vpText, actionId, diff }
        };
      } catch (err) {
        if (actionId !== null) {
          deps.finishTrackedAction(actionId, { status: "error", afterUrl: deps.getActivePageOrNull()?.url() ?? "", error: err.message, beforeState: beforeState ?? void 0 });
        }
        const errorShot = await deps.captureErrorScreenshot(deps.getActivePageOrNull());
        const content = [{ type: "text", text: `Navigation failed: ${err.message}` }];
        if (errorShot) {
          content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
        }
        return {
          content,
          details: { status: "error", error: err.message, actionId },
          isError: true
        };
      }
    }
  });
  pi.registerTool({
    name: "browser_go_back",
    label: "Browser Go Back",
    description: "Navigate back in browser history. Returns a compact page summary after navigation.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      try {
        const { page: p } = await deps.ensureBrowser();
        const response = await p.goBack({ waitUntil: "domcontentloaded", timeout: 1e4 });
        if (!response) {
          return {
            content: [{ type: "text", text: "No previous page in history." }],
            details: {},
            isError: true
          };
        }
        await p.waitForLoadState("networkidle", { timeout: 5e3 }).catch(() => {
        });
        const title = await p.title();
        const url = p.url();
        const summary = await deps.postActionSummary(p);
        const jsErrors = deps.getRecentErrors(p.url());
        return {
          content: [{ type: "text", text: `Navigated back to: ${url}
Title: ${title}${jsErrors}

Page summary:
${summary}` }],
          details: { title, url }
        };
      } catch (err) {
        const errorShot = await deps.captureErrorScreenshot(deps.getActivePageOrNull());
        const content = [{ type: "text", text: `Go back failed: ${err.message}` }];
        if (errorShot) {
          content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
        }
        return { content, details: { error: err.message }, isError: true };
      }
    }
  });
  pi.registerTool({
    name: "browser_go_forward",
    label: "Browser Go Forward",
    description: "Navigate forward in browser history. Returns a compact page summary after navigation.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      try {
        const { page: p } = await deps.ensureBrowser();
        const response = await p.goForward({ waitUntil: "domcontentloaded", timeout: 1e4 });
        if (!response) {
          return {
            content: [{ type: "text", text: "No forward page in history." }],
            details: {},
            isError: true
          };
        }
        await p.waitForLoadState("networkidle", { timeout: 5e3 }).catch(() => {
        });
        const title = await p.title();
        const url = p.url();
        const summary = await deps.postActionSummary(p);
        const jsErrors = deps.getRecentErrors(p.url());
        return {
          content: [{ type: "text", text: `Navigated forward to: ${url}
Title: ${title}${jsErrors}

Page summary:
${summary}` }],
          details: { title, url }
        };
      } catch (err) {
        const errorShot = await deps.captureErrorScreenshot(deps.getActivePageOrNull());
        const content = [{ type: "text", text: `Go forward failed: ${err.message}` }];
        if (errorShot) {
          content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
        }
        return { content, details: { error: err.message }, isError: true };
      }
    }
  });
  pi.registerTool({
    name: "browser_reload",
    label: "Browser Reload",
    description: "Reload the current page. Returns a screenshot, compact page summary, and page metadata (same shape as browser_navigate).",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      try {
        const { page: p } = await deps.ensureBrowser();
        await p.reload({ waitUntil: "domcontentloaded", timeout: 3e4 });
        await p.waitForLoadState("networkidle", { timeout: 5e3 }).catch(() => {
        });
        const title = await p.title();
        const url = p.url();
        const viewport = p.viewportSize();
        const vpText = viewport ? `${viewport.width}x${viewport.height}` : "unknown";
        const summary = await deps.postActionSummary(p);
        const jsErrors = deps.getRecentErrors(p.url());
        let screenshotContent = [];
        try {
          let buf = await p.screenshot({ type: "jpeg", quality: 80, scale: "css" });
          buf = await deps.constrainScreenshot(p, buf, "image/jpeg", 80);
          screenshotContent = [{
            type: "image",
            data: buf.toString("base64"),
            mimeType: "image/jpeg"
          }];
        } catch {
        }
        return {
          content: [
            {
              type: "text",
              text: `Reloaded: ${url}
Title: ${title}
Viewport: ${vpText}${jsErrors}

Page summary:
${summary}`
            },
            ...screenshotContent
          ],
          details: { title, url, viewport: vpText }
        };
      } catch (err) {
        const errorShot = await deps.captureErrorScreenshot(deps.getActivePageOrNull());
        const content = [{ type: "text", text: `Reload failed: ${err.message}` }];
        if (errorShot) {
          content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
        }
        return { content, details: { error: err.message }, isError: true };
      }
    }
  });
}
export {
  registerNavigationTools
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2Jyb3dzZXItdG9vbHMvdG9vbHMvbmF2aWdhdGlvbi50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHR5cGUgeyBFeHRlbnNpb25BUEkgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7IFR5cGUgfSBmcm9tIFwiQHNpbmNsYWlyL3R5cGVib3hcIjtcbmltcG9ydCB7XG5cdGRpZmZDb21wYWN0U3RhdGVzLFxufSBmcm9tIFwiLi4vY29yZS5qc1wiO1xuaW1wb3J0IHR5cGUgeyBUb29sRGVwcywgQ29tcGFjdFBhZ2VTdGF0ZSB9IGZyb20gXCIuLi9zdGF0ZS5qc1wiO1xuaW1wb3J0IHtcblx0c2V0TGFzdEFjdGlvbkJlZm9yZVN0YXRlLFxuXHRzZXRMYXN0QWN0aW9uQWZ0ZXJTdGF0ZSxcbn0gZnJvbSBcIi4uL3N0YXRlLmpzXCI7XG5cbmV4cG9ydCBmdW5jdGlvbiByZWdpc3Rlck5hdmlnYXRpb25Ub29scyhwaTogRXh0ZW5zaW9uQVBJLCBkZXBzOiBUb29sRGVwcyk6IHZvaWQge1xuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdC8vIGJyb3dzZXJfbmF2aWdhdGVcblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHRwaS5yZWdpc3RlclRvb2woe1xuXHRcdG5hbWU6IFwiYnJvd3Nlcl9uYXZpZ2F0ZVwiLFxuXHRcdGxhYmVsOiBcIkJyb3dzZXIgTmF2aWdhdGVcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiT3BlbiB0aGUgYnJvd3NlciAoaWYgbm90IGFscmVhZHkgb3BlbikgYW5kIG5hdmlnYXRlIHRvIGEgVVJMLiBXYWl0cyBmb3IgbmV0d29yayBpZGxlLiBSZXR1cm5zIHBhZ2UgdGl0bGUgYW5kIGN1cnJlbnQgVVJMLiBVc2UgT05MWSBmb3IgdmlzdWFsbHkgdmVyaWZ5aW5nIGxvY2FsbHktcnVubmluZyB3ZWIgYXBwcyAoZS5nLiBodHRwOi8vbG9jYWxob3N0OjMwMDApLiBEbyBOT1QgdXNlIGZvciBkb2N1bWVudGF0aW9uIHNpdGVzLCBHaXRIdWIsIHNlYXJjaCByZXN1bHRzLCBvciBhbnkgZXh0ZXJuYWwgVVJMIFx1MjAxNCB1c2Ugd2ViX3NlYXJjaCBpbnN0ZWFkLiBTY3JlZW5zaG90cyBhcmUgb25seSBjYXB0dXJlZCB3aGVuIHRoZSBgc2NyZWVuc2hvdGAgcGFyYW1ldGVyIGlzIHNldCB0byB0cnVlLlwiLFxuXHRcdHBhcmFtZXRlcnM6IFR5cGUuT2JqZWN0KHtcblx0XHRcdHVybDogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJVUkwgdG8gbmF2aWdhdGUgdG8sIGUuZy4gaHR0cDovL2xvY2FsaG9zdDozMDAwXCIgfSksXG5cdFx0XHRzY3JlZW5zaG90OiBUeXBlLk9wdGlvbmFsKFR5cGUuQm9vbGVhbih7IGRlc2NyaXB0aW9uOiBcIkNhcHR1cmUgYW5kIHJldHVybiBhIHNjcmVlbnNob3QgKGRlZmF1bHQ6IGZhbHNlKVwiLCBkZWZhdWx0OiBmYWxzZSB9KSksXG5cdFx0fSksXG5cblx0XHRhc3luYyBleGVjdXRlKF90b29sQ2FsbElkLCBwYXJhbXMsIF9zaWduYWwsIF9vblVwZGF0ZSwgX2N0eCkge1xuXHRcdFx0bGV0IGFjdGlvbklkOiBudW1iZXIgfCBudWxsID0gbnVsbDtcblx0XHRcdGxldCBiZWZvcmVTdGF0ZTogQ29tcGFjdFBhZ2VTdGF0ZSB8IG51bGwgPSBudWxsO1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0Y29uc3QgeyBwYWdlOiBwIH0gPSBhd2FpdCBkZXBzLmVuc3VyZUJyb3dzZXIoKTtcblx0XHRcdFx0YmVmb3JlU3RhdGUgPSBhd2FpdCBkZXBzLmNhcHR1cmVDb21wYWN0UGFnZVN0YXRlKHAsIHsgaW5jbHVkZUJvZHlUZXh0OiB0cnVlIH0pO1xuXHRcdFx0XHRhY3Rpb25JZCA9IGRlcHMuYmVnaW5UcmFja2VkQWN0aW9uKFwiYnJvd3Nlcl9uYXZpZ2F0ZVwiLCBwYXJhbXMsIGJlZm9yZVN0YXRlLnVybCkuaWQ7XG5cdFx0XHRcdGF3YWl0IHAuZ290byhwYXJhbXMudXJsLCB7IHdhaXRVbnRpbDogXCJkb21jb250ZW50bG9hZGVkXCIsIHRpbWVvdXQ6IDMwMDAwIH0pO1xuXHRcdFx0XHRhd2FpdCBwLndhaXRGb3JMb2FkU3RhdGUoXCJuZXR3b3JraWRsZVwiLCB7IHRpbWVvdXQ6IDUwMDAgfSkuY2F0Y2goKCkgPT4geyAvKiBuZXR3b3JraWRsZSB0aW1lb3V0IFx1MjAxNCBub24tZmF0YWwsIHBhZ2UgbWF5IHN0aWxsIGJlIHVzYWJsZSAqLyB9KTtcblx0XHRcdFx0YXdhaXQgbmV3IFByb21pc2UocmVzb2x2ZSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIDMwMCkpO1xuXG5cdFx0XHRcdGNvbnN0IHRpdGxlID0gYXdhaXQgcC50aXRsZSgpO1xuXHRcdFx0XHRjb25zdCB1cmwgPSBwLnVybCgpO1xuXHRcdFx0XHRjb25zdCB2aWV3cG9ydCA9IHAudmlld3BvcnRTaXplKCk7XG5cdFx0XHRcdGNvbnN0IHZwVGV4dCA9IHZpZXdwb3J0ID8gYCR7dmlld3BvcnQud2lkdGh9eCR7dmlld3BvcnQuaGVpZ2h0fWAgOiBcInVua25vd25cIjtcblx0XHRcdFx0Y29uc3QgYWZ0ZXJTdGF0ZSA9IGF3YWl0IGRlcHMuY2FwdHVyZUNvbXBhY3RQYWdlU3RhdGUocCwgeyBpbmNsdWRlQm9keVRleHQ6IHRydWUgfSk7XG5cdFx0XHRcdGNvbnN0IHN1bW1hcnkgPSBkZXBzLmZvcm1hdENvbXBhY3RTdGF0ZVN1bW1hcnkoYWZ0ZXJTdGF0ZSk7XG5cdFx0XHRcdGNvbnN0IGpzRXJyb3JzID0gZGVwcy5nZXRSZWNlbnRFcnJvcnMocC51cmwoKSk7XG5cdFx0XHRcdGNvbnN0IGRpZmYgPSBkaWZmQ29tcGFjdFN0YXRlcyhiZWZvcmVTdGF0ZSwgYWZ0ZXJTdGF0ZSk7XG5cdFx0XHRcdHNldExhc3RBY3Rpb25CZWZvcmVTdGF0ZShiZWZvcmVTdGF0ZSk7XG5cdFx0XHRcdHNldExhc3RBY3Rpb25BZnRlclN0YXRlKGFmdGVyU3RhdGUpO1xuXHRcdFx0XHRkZXBzLmZpbmlzaFRyYWNrZWRBY3Rpb24oYWN0aW9uSWQsIHtcblx0XHRcdFx0XHRzdGF0dXM6IFwic3VjY2Vzc1wiLFxuXHRcdFx0XHRcdGFmdGVyVXJsOiBhZnRlclN0YXRlLnVybCxcblx0XHRcdFx0XHR3YXJuaW5nU3VtbWFyeToganNFcnJvcnMudHJpbSgpIHx8IHVuZGVmaW5lZCxcblx0XHRcdFx0XHRkaWZmU3VtbWFyeTogZGlmZi5zdW1tYXJ5LFxuXHRcdFx0XHRcdGNoYW5nZWQ6IGRpZmYuY2hhbmdlZCxcblx0XHRcdFx0XHRiZWZvcmVTdGF0ZSxcblx0XHRcdFx0XHRhZnRlclN0YXRlLFxuXHRcdFx0XHR9KTtcblxuXHRcdFx0XHRsZXQgc2NyZWVuc2hvdENvbnRlbnQ6IGFueVtdID0gW107XG5cdFx0XHRcdGlmIChwYXJhbXMuc2NyZWVuc2hvdCkge1xuXHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHRsZXQgYnVmID0gYXdhaXQgcC5zY3JlZW5zaG90KHsgdHlwZTogXCJqcGVnXCIsIHF1YWxpdHk6IDgwLCBzY2FsZTogXCJjc3NcIiB9KTtcblx0XHRcdFx0XHRcdGJ1ZiA9IGF3YWl0IGRlcHMuY29uc3RyYWluU2NyZWVuc2hvdChwLCBidWYsIFwiaW1hZ2UvanBlZ1wiLCA4MCk7XG5cdFx0XHRcdFx0XHRzY3JlZW5zaG90Q29udGVudCA9IFt7IHR5cGU6IFwiaW1hZ2VcIiwgZGF0YTogYnVmLnRvU3RyaW5nKFwiYmFzZTY0XCIpLCBtaW1lVHlwZTogXCJpbWFnZS9qcGVnXCIgfV07XG5cdFx0XHRcdFx0fSBjYXRjaCB7IC8qIG5vbi1mYXRhbCBcdTIwMTQgc2NyZWVuc2hvdCBpcyBvcHRpb25hbCwgbmF2aWdhdGlvbiByZXN1bHQgaXMgc3RpbGwgdmFsaWQgKi8gfVxuXHRcdFx0XHR9XG5cblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbXG5cdFx0XHRcdFx0XHR7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgTmF2aWdhdGVkIHRvOiAke3VybH1cXG5UaXRsZTogJHt0aXRsZX1cXG5WaWV3cG9ydDogJHt2cFRleHR9XFxuQWN0aW9uOiAke2FjdGlvbklkfSR7anNFcnJvcnN9XFxuXFxuRGlmZjpcXG4ke2RlcHMuZm9ybWF0RGlmZlRleHQoZGlmZil9XFxuXFxuUGFnZSBzdW1tYXJ5OlxcbiR7c3VtbWFyeX1gIH0sXG5cdFx0XHRcdFx0XHQuLi5zY3JlZW5zaG90Q29udGVudCxcblx0XHRcdFx0XHRdLFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgdGl0bGUsIHVybCwgc3RhdHVzOiBcImxvYWRlZFwiLCB2aWV3cG9ydDogdnBUZXh0LCBhY3Rpb25JZCwgZGlmZiB9LFxuXHRcdFx0XHR9O1xuXHRcdFx0fSBjYXRjaCAoZXJyOiBhbnkpIHtcblx0XHRcdFx0aWYgKGFjdGlvbklkICE9PSBudWxsKSB7XG5cdFx0XHRcdFx0ZGVwcy5maW5pc2hUcmFja2VkQWN0aW9uKGFjdGlvbklkLCB7IHN0YXR1czogXCJlcnJvclwiLCBhZnRlclVybDogZGVwcy5nZXRBY3RpdmVQYWdlT3JOdWxsKCk/LnVybCgpID8/IFwiXCIsIGVycm9yOiBlcnIubWVzc2FnZSwgYmVmb3JlU3RhdGU6IGJlZm9yZVN0YXRlID8/IHVuZGVmaW5lZCB9KTtcblx0XHRcdFx0fVxuXHRcdFx0XHRjb25zdCBlcnJvclNob3QgPSBhd2FpdCBkZXBzLmNhcHR1cmVFcnJvclNjcmVlbnNob3QoZGVwcy5nZXRBY3RpdmVQYWdlT3JOdWxsKCkpO1xuXHRcdFx0XHRjb25zdCBjb250ZW50OiBhbnlbXSA9IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgTmF2aWdhdGlvbiBmYWlsZWQ6ICR7ZXJyLm1lc3NhZ2V9YCB9XTtcblx0XHRcdFx0aWYgKGVycm9yU2hvdCkge1xuXHRcdFx0XHRcdGNvbnRlbnQucHVzaCh7IHR5cGU6IFwiaW1hZ2VcIiwgZGF0YTogZXJyb3JTaG90LmRhdGEsIG1pbWVUeXBlOiBlcnJvclNob3QubWltZVR5cGUgfSk7XG5cdFx0XHRcdH1cblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50LFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgc3RhdHVzOiBcImVycm9yXCIsIGVycm9yOiBlcnIubWVzc2FnZSwgYWN0aW9uSWQgfSxcblx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHR9O1xuXHRcdFx0fVxuXHRcdH0sXG5cdH0pO1xuXG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblx0Ly8gYnJvd3Nlcl9nb19iYWNrXG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblx0cGkucmVnaXN0ZXJUb29sKHtcblx0XHRuYW1lOiBcImJyb3dzZXJfZ29fYmFja1wiLFxuXHRcdGxhYmVsOiBcIkJyb3dzZXIgR28gQmFja1wiLFxuXHRcdGRlc2NyaXB0aW9uOiBcIk5hdmlnYXRlIGJhY2sgaW4gYnJvd3NlciBoaXN0b3J5LiBSZXR1cm5zIGEgY29tcGFjdCBwYWdlIHN1bW1hcnkgYWZ0ZXIgbmF2aWdhdGlvbi5cIixcblx0XHRwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7fSksXG5cblx0XHRhc3luYyBleGVjdXRlKF90b29sQ2FsbElkLCBfcGFyYW1zLCBfc2lnbmFsLCBfb25VcGRhdGUsIF9jdHgpIHtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IHsgcGFnZTogcCB9ID0gYXdhaXQgZGVwcy5lbnN1cmVCcm93c2VyKCk7XG5cdFx0XHRcdGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgcC5nb0JhY2soeyB3YWl0VW50aWw6IFwiZG9tY29udGVudGxvYWRlZFwiLCB0aW1lb3V0OiAxMDAwMCB9KTtcblxuXHRcdFx0XHRpZiAoIXJlc3BvbnNlKSB7XG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIk5vIHByZXZpb3VzIHBhZ2UgaW4gaGlzdG9yeS5cIiB9XSxcblx0XHRcdFx0XHRcdGRldGFpbHM6IHt9LFxuXHRcdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0YXdhaXQgcC53YWl0Rm9yTG9hZFN0YXRlKFwibmV0d29ya2lkbGVcIiwgeyB0aW1lb3V0OiA1MDAwIH0pLmNhdGNoKCgpID0+IHsgLyogbmV0d29ya2lkbGUgdGltZW91dCBcdTIwMTQgbm9uLWZhdGFsLCBwYWdlIG1heSBzdGlsbCBiZSB1c2FibGUgKi8gfSk7XG5cblx0XHRcdFx0Y29uc3QgdGl0bGUgPSBhd2FpdCBwLnRpdGxlKCk7XG5cdFx0XHRcdGNvbnN0IHVybCA9IHAudXJsKCk7XG5cdFx0XHRcdGNvbnN0IHN1bW1hcnkgPSBhd2FpdCBkZXBzLnBvc3RBY3Rpb25TdW1tYXJ5KHApO1xuXHRcdFx0XHRjb25zdCBqc0Vycm9ycyA9IGRlcHMuZ2V0UmVjZW50RXJyb3JzKHAudXJsKCkpO1xuXG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBOYXZpZ2F0ZWQgYmFjayB0bzogJHt1cmx9XFxuVGl0bGU6ICR7dGl0bGV9JHtqc0Vycm9yc31cXG5cXG5QYWdlIHN1bW1hcnk6XFxuJHtzdW1tYXJ5fWAgfV0sXG5cdFx0XHRcdFx0ZGV0YWlsczogeyB0aXRsZSwgdXJsIH0sXG5cdFx0XHRcdH07XG5cdFx0XHR9IGNhdGNoIChlcnI6IGFueSkge1xuXHRcdFx0XHRjb25zdCBlcnJvclNob3QgPSBhd2FpdCBkZXBzLmNhcHR1cmVFcnJvclNjcmVlbnNob3QoZGVwcy5nZXRBY3RpdmVQYWdlT3JOdWxsKCkpO1xuXHRcdFx0XHRjb25zdCBjb250ZW50OiBhbnlbXSA9IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgR28gYmFjayBmYWlsZWQ6ICR7ZXJyLm1lc3NhZ2V9YCB9XTtcblx0XHRcdFx0aWYgKGVycm9yU2hvdCkge1xuXHRcdFx0XHRcdGNvbnRlbnQucHVzaCh7IHR5cGU6IFwiaW1hZ2VcIiwgZGF0YTogZXJyb3JTaG90LmRhdGEsIG1pbWVUeXBlOiBlcnJvclNob3QubWltZVR5cGUgfSk7XG5cdFx0XHRcdH1cblx0XHRcdFx0cmV0dXJuIHsgY29udGVudCwgZGV0YWlsczogeyBlcnJvcjogZXJyLm1lc3NhZ2UgfSwgaXNFcnJvcjogdHJ1ZSB9O1xuXHRcdFx0fVxuXHRcdH0sXG5cdH0pO1xuXG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblx0Ly8gYnJvd3Nlcl9nb19mb3J3YXJkXG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblx0cGkucmVnaXN0ZXJUb29sKHtcblx0XHRuYW1lOiBcImJyb3dzZXJfZ29fZm9yd2FyZFwiLFxuXHRcdGxhYmVsOiBcIkJyb3dzZXIgR28gRm9yd2FyZFwiLFxuXHRcdGRlc2NyaXB0aW9uOiBcIk5hdmlnYXRlIGZvcndhcmQgaW4gYnJvd3NlciBoaXN0b3J5LiBSZXR1cm5zIGEgY29tcGFjdCBwYWdlIHN1bW1hcnkgYWZ0ZXIgbmF2aWdhdGlvbi5cIixcblx0XHRwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7fSksXG5cblx0XHRhc3luYyBleGVjdXRlKF90b29sQ2FsbElkLCBfcGFyYW1zLCBfc2lnbmFsLCBfb25VcGRhdGUsIF9jdHgpIHtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IHsgcGFnZTogcCB9ID0gYXdhaXQgZGVwcy5lbnN1cmVCcm93c2VyKCk7XG5cdFx0XHRcdGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgcC5nb0ZvcndhcmQoeyB3YWl0VW50aWw6IFwiZG9tY29udGVudGxvYWRlZFwiLCB0aW1lb3V0OiAxMDAwMCB9KTtcblxuXHRcdFx0XHRpZiAoIXJlc3BvbnNlKSB7XG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIk5vIGZvcndhcmQgcGFnZSBpbiBoaXN0b3J5LlwiIH1dLFxuXHRcdFx0XHRcdFx0ZGV0YWlsczoge30sXG5cdFx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRhd2FpdCBwLndhaXRGb3JMb2FkU3RhdGUoXCJuZXR3b3JraWRsZVwiLCB7IHRpbWVvdXQ6IDUwMDAgfSkuY2F0Y2goKCkgPT4geyAvKiBuZXR3b3JraWRsZSB0aW1lb3V0IFx1MjAxNCBub24tZmF0YWwsIHBhZ2UgbWF5IHN0aWxsIGJlIHVzYWJsZSAqLyB9KTtcblxuXHRcdFx0XHRjb25zdCB0aXRsZSA9IGF3YWl0IHAudGl0bGUoKTtcblx0XHRcdFx0Y29uc3QgdXJsID0gcC51cmwoKTtcblx0XHRcdFx0Y29uc3Qgc3VtbWFyeSA9IGF3YWl0IGRlcHMucG9zdEFjdGlvblN1bW1hcnkocCk7XG5cdFx0XHRcdGNvbnN0IGpzRXJyb3JzID0gZGVwcy5nZXRSZWNlbnRFcnJvcnMocC51cmwoKSk7XG5cblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYE5hdmlnYXRlZCBmb3J3YXJkIHRvOiAke3VybH1cXG5UaXRsZTogJHt0aXRsZX0ke2pzRXJyb3JzfVxcblxcblBhZ2Ugc3VtbWFyeTpcXG4ke3N1bW1hcnl9YCB9XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7IHRpdGxlLCB1cmwgfSxcblx0XHRcdFx0fTtcblx0XHRcdH0gY2F0Y2ggKGVycjogYW55KSB7XG5cdFx0XHRcdGNvbnN0IGVycm9yU2hvdCA9IGF3YWl0IGRlcHMuY2FwdHVyZUVycm9yU2NyZWVuc2hvdChkZXBzLmdldEFjdGl2ZVBhZ2VPck51bGwoKSk7XG5cdFx0XHRcdGNvbnN0IGNvbnRlbnQ6IGFueVtdID0gW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBHbyBmb3J3YXJkIGZhaWxlZDogJHtlcnIubWVzc2FnZX1gIH1dO1xuXHRcdFx0XHRpZiAoZXJyb3JTaG90KSB7XG5cdFx0XHRcdFx0Y29udGVudC5wdXNoKHsgdHlwZTogXCJpbWFnZVwiLCBkYXRhOiBlcnJvclNob3QuZGF0YSwgbWltZVR5cGU6IGVycm9yU2hvdC5taW1lVHlwZSB9KTtcblx0XHRcdFx0fVxuXHRcdFx0XHRyZXR1cm4geyBjb250ZW50LCBkZXRhaWxzOiB7IGVycm9yOiBlcnIubWVzc2FnZSB9LCBpc0Vycm9yOiB0cnVlIH07XG5cdFx0XHR9XG5cdFx0fSxcblx0fSk7XG5cblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHQvLyBicm93c2VyX3JlbG9hZFxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdHBpLnJlZ2lzdGVyVG9vbCh7XG5cdFx0bmFtZTogXCJicm93c2VyX3JlbG9hZFwiLFxuXHRcdGxhYmVsOiBcIkJyb3dzZXIgUmVsb2FkXCIsXG5cdFx0ZGVzY3JpcHRpb246IFwiUmVsb2FkIHRoZSBjdXJyZW50IHBhZ2UuIFJldHVybnMgYSBzY3JlZW5zaG90LCBjb21wYWN0IHBhZ2Ugc3VtbWFyeSwgYW5kIHBhZ2UgbWV0YWRhdGEgKHNhbWUgc2hhcGUgYXMgYnJvd3Nlcl9uYXZpZ2F0ZSkuXCIsXG5cdFx0cGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe30pLFxuXG5cdFx0YXN5bmMgZXhlY3V0ZShfdG9vbENhbGxJZCwgX3BhcmFtcywgX3NpZ25hbCwgX29uVXBkYXRlLCBfY3R4KSB7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCB7IHBhZ2U6IHAgfSA9IGF3YWl0IGRlcHMuZW5zdXJlQnJvd3NlcigpO1xuXHRcdFx0XHRhd2FpdCBwLnJlbG9hZCh7IHdhaXRVbnRpbDogXCJkb21jb250ZW50bG9hZGVkXCIsIHRpbWVvdXQ6IDMwMDAwIH0pO1xuXHRcdFx0XHRhd2FpdCBwLndhaXRGb3JMb2FkU3RhdGUoXCJuZXR3b3JraWRsZVwiLCB7IHRpbWVvdXQ6IDUwMDAgfSkuY2F0Y2goKCkgPT4geyAvKiBuZXR3b3JraWRsZSB0aW1lb3V0IFx1MjAxNCBub24tZmF0YWwsIHBhZ2UgbWF5IHN0aWxsIGJlIHVzYWJsZSAqLyB9KTtcblxuXHRcdFx0XHRjb25zdCB0aXRsZSA9IGF3YWl0IHAudGl0bGUoKTtcblx0XHRcdFx0Y29uc3QgdXJsID0gcC51cmwoKTtcblx0XHRcdFx0Y29uc3Qgdmlld3BvcnQgPSBwLnZpZXdwb3J0U2l6ZSgpO1xuXHRcdFx0XHRjb25zdCB2cFRleHQgPSB2aWV3cG9ydCA/IGAke3ZpZXdwb3J0LndpZHRofXgke3ZpZXdwb3J0LmhlaWdodH1gIDogXCJ1bmtub3duXCI7XG5cdFx0XHRcdGNvbnN0IHN1bW1hcnkgPSBhd2FpdCBkZXBzLnBvc3RBY3Rpb25TdW1tYXJ5KHApO1xuXHRcdFx0XHRjb25zdCBqc0Vycm9ycyA9IGRlcHMuZ2V0UmVjZW50RXJyb3JzKHAudXJsKCkpO1xuXG5cdFx0XHRcdGxldCBzY3JlZW5zaG90Q29udGVudDogYW55W10gPSBbXTtcblx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRsZXQgYnVmID0gYXdhaXQgcC5zY3JlZW5zaG90KHsgdHlwZTogXCJqcGVnXCIsIHF1YWxpdHk6IDgwLCBzY2FsZTogXCJjc3NcIiB9KTtcblx0XHRcdFx0XHRidWYgPSBhd2FpdCBkZXBzLmNvbnN0cmFpblNjcmVlbnNob3QocCwgYnVmLCBcImltYWdlL2pwZWdcIiwgODApO1xuXHRcdFx0XHRcdHNjcmVlbnNob3RDb250ZW50ID0gW3tcblx0XHRcdFx0XHRcdHR5cGU6IFwiaW1hZ2VcIixcblx0XHRcdFx0XHRcdGRhdGE6IGJ1Zi50b1N0cmluZyhcImJhc2U2NFwiKSxcblx0XHRcdFx0XHRcdG1pbWVUeXBlOiBcImltYWdlL2pwZWdcIixcblx0XHRcdFx0XHR9XTtcblx0XHRcdFx0fSBjYXRjaCB7IC8qIG5vbi1mYXRhbCBcdTIwMTQgc2NyZWVuc2hvdCBpcyBvcHRpb25hbCwgcmVsb2FkIHJlc3VsdCBpcyBzdGlsbCB2YWxpZCAqLyB9XG5cblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbXG5cdFx0XHRcdFx0XHR7XG5cdFx0XHRcdFx0XHRcdHR5cGU6IFwidGV4dFwiLFxuXHRcdFx0XHRcdFx0XHR0ZXh0OiBgUmVsb2FkZWQ6ICR7dXJsfVxcblRpdGxlOiAke3RpdGxlfVxcblZpZXdwb3J0OiAke3ZwVGV4dH0ke2pzRXJyb3JzfVxcblxcblBhZ2Ugc3VtbWFyeTpcXG4ke3N1bW1hcnl9YCxcblx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHQuLi5zY3JlZW5zaG90Q29udGVudCxcblx0XHRcdFx0XHRdLFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgdGl0bGUsIHVybCwgdmlld3BvcnQ6IHZwVGV4dCB9LFxuXHRcdFx0XHR9O1xuXHRcdFx0fSBjYXRjaCAoZXJyOiBhbnkpIHtcblx0XHRcdFx0Y29uc3QgZXJyb3JTaG90ID0gYXdhaXQgZGVwcy5jYXB0dXJlRXJyb3JTY3JlZW5zaG90KGRlcHMuZ2V0QWN0aXZlUGFnZU9yTnVsbCgpKTtcblx0XHRcdFx0Y29uc3QgY29udGVudDogYW55W10gPSBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYFJlbG9hZCBmYWlsZWQ6ICR7ZXJyLm1lc3NhZ2V9YCB9XTtcblx0XHRcdFx0aWYgKGVycm9yU2hvdCkge1xuXHRcdFx0XHRcdGNvbnRlbnQucHVzaCh7IHR5cGU6IFwiaW1hZ2VcIiwgZGF0YTogZXJyb3JTaG90LmRhdGEsIG1pbWVUeXBlOiBlcnJvclNob3QubWltZVR5cGUgfSk7XG5cdFx0XHRcdH1cblx0XHRcdFx0cmV0dXJuIHsgY29udGVudCwgZGV0YWlsczogeyBlcnJvcjogZXJyLm1lc3NhZ2UgfSwgaXNFcnJvcjogdHJ1ZSB9O1xuXHRcdFx0fVxuXHRcdH0sXG5cdH0pO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQ0EsU0FBUyxZQUFZO0FBQ3JCO0FBQUEsRUFDQztBQUFBLE9BQ007QUFFUDtBQUFBLEVBQ0M7QUFBQSxFQUNBO0FBQUEsT0FDTTtBQUVBLFNBQVMsd0JBQXdCLElBQWtCLE1BQXNCO0FBSS9FLEtBQUcsYUFBYTtBQUFBLElBQ2YsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsYUFDQztBQUFBLElBQ0QsWUFBWSxLQUFLLE9BQU87QUFBQSxNQUN2QixLQUFLLEtBQUssT0FBTyxFQUFFLGFBQWEsaURBQWlELENBQUM7QUFBQSxNQUNsRixZQUFZLEtBQUssU0FBUyxLQUFLLFFBQVEsRUFBRSxhQUFhLG9EQUFvRCxTQUFTLE1BQU0sQ0FBQyxDQUFDO0FBQUEsSUFDNUgsQ0FBQztBQUFBLElBRUQsTUFBTSxRQUFRLGFBQWEsUUFBUSxTQUFTLFdBQVcsTUFBTTtBQUM1RCxVQUFJLFdBQTBCO0FBQzlCLFVBQUksY0FBdUM7QUFDM0MsVUFBSTtBQUNILGNBQU0sRUFBRSxNQUFNLEVBQUUsSUFBSSxNQUFNLEtBQUssY0FBYztBQUM3QyxzQkFBYyxNQUFNLEtBQUssd0JBQXdCLEdBQUcsRUFBRSxpQkFBaUIsS0FBSyxDQUFDO0FBQzdFLG1CQUFXLEtBQUssbUJBQW1CLG9CQUFvQixRQUFRLFlBQVksR0FBRyxFQUFFO0FBQ2hGLGNBQU0sRUFBRSxLQUFLLE9BQU8sS0FBSyxFQUFFLFdBQVcsb0JBQW9CLFNBQVMsSUFBTSxDQUFDO0FBQzFFLGNBQU0sRUFBRSxpQkFBaUIsZUFBZSxFQUFFLFNBQVMsSUFBSyxDQUFDLEVBQUUsTUFBTSxNQUFNO0FBQUEsUUFBa0UsQ0FBQztBQUMxSSxjQUFNLElBQUksUUFBUSxhQUFXLFdBQVcsU0FB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
