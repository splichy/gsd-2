import { Type } from "@sinclair/typebox";
import {
  registryGetActive,
  registryListPages,
  registrySetActive
} from "../core.js";
import {
  getPageRegistry,
  getActiveFrame,
  setActiveFrame
} from "../state.js";
function registerPageTools(pi, deps) {
  pi.registerTool({
    name: "browser_list_pages",
    label: "Browser List Pages",
    description: "List all open browser pages/tabs with their IDs, titles, URLs, and active status. Use to see what pages are available before switching.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      try {
        await deps.ensureBrowser();
        const pageRegistry = getPageRegistry();
        for (const entry of pageRegistry.pages) {
          try {
            entry.title = await entry.page.title();
            entry.url = entry.page.url();
          } catch {
          }
        }
        const pages = registryListPages(pageRegistry);
        if (pages.length === 0) {
          return {
            content: [{ type: "text", text: "No pages open." }],
            details: { pages: [], count: 0 }
          };
        }
        const lines = pages.map((p) => {
          const active = p.isActive ? " \u2190 active" : "";
          const opener = p.opener !== null ? ` (opener: ${p.opener})` : "";
          return `  [${p.id}] ${p.title || "(untitled)"} \u2014 ${p.url}${opener}${active}`;
        });
        return {
          content: [{ type: "text", text: `${pages.length} page(s):
${lines.join("\n")}` }],
          details: { pages, count: pages.length }
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `List pages failed: ${err.message}` }],
          details: { error: err.message },
          isError: true
        };
      }
    }
  });
  pi.registerTool({
    name: "browser_switch_page",
    label: "Browser Switch Page",
    description: "Switch the active browser page/tab by page ID. Use browser_list_pages to see available IDs. Clears any active frame selection.",
    parameters: Type.Object({
      id: Type.Number({ description: "Page ID to switch to (from browser_list_pages)" })
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        await deps.ensureBrowser();
        const pageRegistry = getPageRegistry();
        registrySetActive(pageRegistry, params.id);
        setActiveFrame(null);
        const entry = registryGetActive(pageRegistry);
        await entry.page.bringToFront();
        const title = await entry.page.title().catch(() => "");
        const url = entry.page.url();
        entry.title = title;
        entry.url = url;
        return {
          content: [{ type: "text", text: `Switched to page ${params.id}: ${title || "(untitled)"} \u2014 ${url}` }],
          details: { id: params.id, title, url }
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Switch page failed: ${err.message}` }],
          details: { error: err.message },
          isError: true
        };
      }
    }
  });
  pi.registerTool({
    name: "browser_close_page",
    label: "Browser Close Page",
    description: "Close a specific browser page/tab by ID. Cannot close the last remaining page. The page's close event triggers automatic registry cleanup and active-page fallback.",
    parameters: Type.Object({
      id: Type.Number({ description: "Page ID to close (from browser_list_pages)" })
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        await deps.ensureBrowser();
        const pageRegistry = getPageRegistry();
        if (pageRegistry.pages.length <= 1) {
          return {
            content: [{ type: "text", text: `Cannot close the last remaining page. Use browser_close to close the entire browser.` }],
            details: { error: "last_page", pageCount: pageRegistry.pages.length },
            isError: true
          };
        }
        const entry = pageRegistry.pages.find((e) => e.id === params.id);
        if (!entry) {
          const available = pageRegistry.pages.map((e) => e.id);
          return {
            content: [{ type: "text", text: `Page ${params.id} not found. Available page IDs: [${available.join(", ")}].` }],
            details: { error: "not_found", available },
            isError: true
          };
        }
        await entry.page.close();
        setActiveFrame(null);
        for (const remaining of pageRegistry.pages) {
          try {
            remaining.title = await remaining.page.title();
            remaining.url = remaining.page.url();
          } catch {
          }
        }
        const pages = registryListPages(pageRegistry);
        const lines = pages.map((p) => {
          const active = p.isActive ? " \u2190 active" : "";
          return `  [${p.id}] ${p.title || "(untitled)"} \u2014 ${p.url}${active}`;
        });
        return {
          content: [{ type: "text", text: `Closed page ${params.id}. ${pages.length} page(s) remaining:
${lines.join("\n")}` }],
          details: { closedId: params.id, pages, count: pages.length }
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Close page failed: ${err.message}` }],
          details: { error: err.message },
          isError: true
        };
      }
    }
  });
  pi.registerTool({
    name: "browser_list_frames",
    label: "Browser List Frames",
    description: "List all frames in the active page, including the main frame and any iframes. Shows frame name, URL, and parent frame name. Use before browser_select_frame to identify available frames.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      try {
        await deps.ensureBrowser();
        const p = deps.getActivePage();
        const frames = p.frames();
        const mainFrame = p.mainFrame();
        const activeFrame = getActiveFrame();
        const frameList = frames.map((f, index) => {
          const isMain = f === mainFrame;
          const parentName = f.parentFrame()?.name() || (f.parentFrame() === mainFrame ? "main" : "");
          return {
            index,
            name: f.name() || (isMain ? "main" : `(unnamed-${index})`),
            url: f.url(),
            isMain,
            parentName: isMain ? null : parentName || "main",
            isActive: f === activeFrame
          };
        });
        const lines = frameList.map((f) => {
          const main = f.isMain ? " [main]" : "";
          const active = f.isActive ? " \u2190 selected" : "";
          const parent = f.parentName ? ` (parent: ${f.parentName})` : "";
          return `  [${f.index}] "${f.name}" \u2014 ${f.url}${main}${parent}${active}`;
        });
        const activeInfo = activeFrame ? `Active frame: "${activeFrame.name() || "(unnamed)"}"` : "No frame selected (operating on main page)";
        return {
          content: [{ type: "text", text: `${frameList.length} frame(s) in active page:
${lines.join("\n")}

${activeInfo}` }],
          details: { frames: frameList, count: frameList.length, activeFrame: activeFrame?.name() ?? null }
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `List frames failed: ${err.message}` }],
          details: { error: err.message },
          isError: true
        };
      }
    }
  });
  pi.registerTool({
    name: "browser_select_frame",
    label: "Browser Select Frame",
    description: 'Select a frame within the active page to operate on. Find frames by name, URL pattern, or index. Pass null or "main" to reset back to the main page frame. Once a frame is selected, tools like browser_evaluate, browser_find, and browser_click will operate within that frame (after T03 migration).',
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Frame name to select. Use 'main' or 'null' to reset to main frame." })),
      urlPattern: Type.Optional(Type.String({ description: "URL substring to match against frame URLs." })),
      index: Type.Optional(Type.Number({ description: "Frame index from browser_list_frames." }))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        await deps.ensureBrowser();
        const p = deps.getActivePage();
        const frames = p.frames();
        if (params.name === "main" || params.name === "null" || params.name === null) {
          setActiveFrame(null);
          return {
            content: [{ type: "text", text: "Reset to main page frame. Tools will operate on the main page." }],
            details: { activeFrame: null }
          };
        }
        if (params.name) {
          const frame = frames.find((f) => f.name() === params.name);
          if (!frame) {
            const available = frames.map((f, i) => `[${i}] "${f.name() || "(unnamed)"}" \u2014 ${f.url()}`);
            return {
              content: [{ type: "text", text: `Frame with name "${params.name}" not found.
Available frames:
  ${available.join("\n  ")}` }],
              details: { error: "frame_not_found", available },
              isError: true
            };
          }
          setActiveFrame(frame);
          return {
            content: [{ type: "text", text: `Selected frame "${frame.name()}" \u2014 ${frame.url()}` }],
            details: { name: frame.name(), url: frame.url() }
          };
        }
        if (params.urlPattern) {
          const frame = frames.find((f) => f.url().includes(params.urlPattern));
          if (!frame) {
            const available = frames.map((f, i) => `[${i}] "${f.name() || "(unnamed)"}" \u2014 ${f.url()}`);
            return {
              content: [{ type: "text", text: `No frame URL matches "${params.urlPattern}".
Available frames:
  ${available.join("\n  ")}` }],
              details: { error: "frame_not_found", available },
              isError: true
            };
          }
          setActiveFrame(frame);
          return {
            content: [{ type: "text", text: `Selected frame "${frame.name() || "(unnamed)"}" \u2014 ${frame.url()}` }],
            details: { name: frame.name(), url: frame.url() }
          };
        }
        if (params.index !== void 0) {
          if (params.index < 0 || params.index >= frames.length) {
            return {
              content: [{ type: "text", text: `Frame index ${params.index} out of range. ${frames.length} frame(s) available (0-${frames.length - 1}).` }],
              details: { error: "index_out_of_range", count: frames.length },
              isError: true
            };
          }
          const frame = frames[params.index];
          setActiveFrame(frame);
          return {
            content: [{ type: "text", text: `Selected frame [${params.index}] "${frame.name() || "(unnamed)"}" \u2014 ${frame.url()}` }],
            details: { index: params.index, name: frame.name(), url: frame.url() }
          };
        }
        return {
          content: [{ type: "text", text: "Provide name, urlPattern, or index to select a frame. Use name='main' to reset to main frame." }],
          details: { error: "no_criteria" },
          isError: true
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Select frame failed: ${err.message}` }],
          details: { error: err.message },
          isError: true
        };
      }
    }
  });
}
export {
  registerPageTools
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2Jyb3dzZXItdG9vbHMvdG9vbHMvcGFnZXMudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0eXBlIHsgRXh0ZW5zaW9uQVBJIH0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XG5pbXBvcnQgeyBUeXBlIH0gZnJvbSBcIkBzaW5jbGFpci90eXBlYm94XCI7XG5pbXBvcnQge1xuXHRyZWdpc3RyeUdldEFjdGl2ZSxcblx0cmVnaXN0cnlMaXN0UGFnZXMsXG5cdHJlZ2lzdHJ5U2V0QWN0aXZlLFxufSBmcm9tIFwiLi4vY29yZS5qc1wiO1xuaW1wb3J0IHR5cGUgeyBUb29sRGVwcyB9IGZyb20gXCIuLi9zdGF0ZS5qc1wiO1xuaW1wb3J0IHtcblx0Z2V0UGFnZVJlZ2lzdHJ5LFxuXHRnZXRBY3RpdmVGcmFtZSxcblx0c2V0QWN0aXZlRnJhbWUsXG59IGZyb20gXCIuLi9zdGF0ZS5qc1wiO1xuXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJQYWdlVG9vbHMocGk6IEV4dGVuc2lvbkFQSSwgZGVwczogVG9vbERlcHMpOiB2b2lkIHtcblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHQvLyBicm93c2VyX2xpc3RfcGFnZXNcblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHRwaS5yZWdpc3RlclRvb2woe1xuXHRcdG5hbWU6IFwiYnJvd3Nlcl9saXN0X3BhZ2VzXCIsXG5cdFx0bGFiZWw6IFwiQnJvd3NlciBMaXN0IFBhZ2VzXCIsXG5cdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcIkxpc3QgYWxsIG9wZW4gYnJvd3NlciBwYWdlcy90YWJzIHdpdGggdGhlaXIgSURzLCB0aXRsZXMsIFVSTHMsIGFuZCBhY3RpdmUgc3RhdHVzLiBVc2UgdG8gc2VlIHdoYXQgcGFnZXMgYXJlIGF2YWlsYWJsZSBiZWZvcmUgc3dpdGNoaW5nLlwiLFxuXHRcdHBhcmFtZXRlcnM6IFR5cGUuT2JqZWN0KHt9KSxcblxuXHRcdGFzeW5jIGV4ZWN1dGUoX3Rvb2xDYWxsSWQsIF9wYXJhbXMsIF9zaWduYWwsIF9vblVwZGF0ZSwgX2N0eCkge1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0YXdhaXQgZGVwcy5lbnN1cmVCcm93c2VyKCk7XG5cdFx0XHRcdGNvbnN0IHBhZ2VSZWdpc3RyeSA9IGdldFBhZ2VSZWdpc3RyeSgpO1xuXHRcdFx0XHRmb3IgKGNvbnN0IGVudHJ5IG9mIHBhZ2VSZWdpc3RyeS5wYWdlcykge1xuXHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHRlbnRyeS50aXRsZSA9IGF3YWl0IGVudHJ5LnBhZ2UudGl0bGUoKTtcblx0XHRcdFx0XHRcdGVudHJ5LnVybCA9IGVudHJ5LnBhZ2UudXJsKCk7XG5cdFx0XHRcdFx0fSBjYXRjaCB7XG5cdFx0XHRcdFx0XHQvLyBQYWdlIG1heSBoYXZlIGJlZW4gY2xvc2VkXG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHRcdGNvbnN0IHBhZ2VzID0gcmVnaXN0cnlMaXN0UGFnZXMocGFnZVJlZ2lzdHJ5KTtcblx0XHRcdFx0aWYgKHBhZ2VzLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJObyBwYWdlcyBvcGVuLlwiIH1dLFxuXHRcdFx0XHRcdFx0ZGV0YWlsczogeyBwYWdlczogW10sIGNvdW50OiAwIH0sXG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0fVxuXHRcdFx0XHRjb25zdCBsaW5lcyA9IHBhZ2VzLm1hcCgocDogYW55KSA9PiB7XG5cdFx0XHRcdFx0Y29uc3QgYWN0aXZlID0gcC5pc0FjdGl2ZSA/IFwiIFx1MjE5MCBhY3RpdmVcIiA6IFwiXCI7XG5cdFx0XHRcdFx0Y29uc3Qgb3BlbmVyID0gcC5vcGVuZXIgIT09IG51bGwgPyBgIChvcGVuZXI6ICR7cC5vcGVuZXJ9KWAgOiBcIlwiO1xuXHRcdFx0XHRcdHJldHVybiBgICBbJHtwLmlkfV0gJHtwLnRpdGxlIHx8IFwiKHVudGl0bGVkKVwifSBcdTIwMTQgJHtwLnVybH0ke29wZW5lcn0ke2FjdGl2ZX1gO1xuXHRcdFx0XHR9KTtcblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYCR7cGFnZXMubGVuZ3RofSBwYWdlKHMpOlxcbiR7bGluZXMuam9pbihcIlxcblwiKX1gIH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgcGFnZXMsIGNvdW50OiBwYWdlcy5sZW5ndGggfSxcblx0XHRcdFx0fTtcblx0XHRcdH0gY2F0Y2ggKGVycjogYW55KSB7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBMaXN0IHBhZ2VzIGZhaWxlZDogJHtlcnIubWVzc2FnZX1gIH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgZXJyb3I6IGVyci5tZXNzYWdlIH0sXG5cdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0fTtcblx0XHRcdH1cblx0XHR9LFxuXHR9KTtcblxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdC8vIGJyb3dzZXJfc3dpdGNoX3BhZ2Vcblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHRwaS5yZWdpc3RlclRvb2woe1xuXHRcdG5hbWU6IFwiYnJvd3Nlcl9zd2l0Y2hfcGFnZVwiLFxuXHRcdGxhYmVsOiBcIkJyb3dzZXIgU3dpdGNoIFBhZ2VcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiU3dpdGNoIHRoZSBhY3RpdmUgYnJvd3NlciBwYWdlL3RhYiBieSBwYWdlIElELiBVc2UgYnJvd3Nlcl9saXN0X3BhZ2VzIHRvIHNlZSBhdmFpbGFibGUgSURzLiBDbGVhcnMgYW55IGFjdGl2ZSBmcmFtZSBzZWxlY3Rpb24uXCIsXG5cdFx0cGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe1xuXHRcdFx0aWQ6IFR5cGUuTnVtYmVyKHsgZGVzY3JpcHRpb246IFwiUGFnZSBJRCB0byBzd2l0Y2ggdG8gKGZyb20gYnJvd3Nlcl9saXN0X3BhZ2VzKVwiIH0pLFxuXHRcdH0pLFxuXG5cdFx0YXN5bmMgZXhlY3V0ZShfdG9vbENhbGxJZCwgcGFyYW1zLCBfc2lnbmFsLCBfb25VcGRhdGUsIF9jdHgpIHtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGF3YWl0IGRlcHMuZW5zdXJlQnJvd3NlcigpO1xuXHRcdFx0XHRjb25zdCBwYWdlUmVnaXN0cnkgPSBnZXRQYWdlUmVnaXN0cnkoKTtcblx0XHRcdFx0cmVnaXN0cnlTZXRBY3RpdmUocGFnZVJlZ2lzdHJ5LCBwYXJhbXMuaWQpO1xuXHRcdFx0XHRzZXRBY3RpdmVGcmFtZShudWxsKTtcblx0XHRcdFx0Y29uc3QgZW50cnkgPSByZWdpc3RyeUdldEFjdGl2ZShwYWdlUmVnaXN0cnkpO1xuXHRcdFx0XHRhd2FpdCBlbnRyeS5wYWdlLmJyaW5nVG9Gcm9udCgpO1xuXHRcdFx0XHRjb25zdCB0aXRsZSA9IGF3YWl0IGVudHJ5LnBhZ2UudGl0bGUoKS5jYXRjaCgoKSA9PiBcIlwiKTtcblx0XHRcdFx0Y29uc3QgdXJsID0gZW50cnkucGFnZS51cmwoKTtcblx0XHRcdFx0ZW50cnkudGl0bGUgPSB0aXRsZTtcblx0XHRcdFx0ZW50cnkudXJsID0gdXJsO1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgU3dpdGNoZWQgdG8gcGFnZSAke3BhcmFtcy5pZH06ICR7dGl0bGUgfHwgXCIodW50aXRsZWQpXCJ9IFx1MjAxNCAke3VybH1gIH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgaWQ6IHBhcmFtcy5pZCwgdGl0bGUsIHVybCB9LFxuXHRcdFx0XHR9O1xuXHRcdFx0fSBjYXRjaCAoZXJyOiBhbnkpIHtcblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYFN3aXRjaCBwYWdlIGZhaWxlZDogJHtlcnIubWVzc2FnZX1gIH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgZXJyb3I6IGVyci5tZXNzYWdlIH0sXG5cdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0fTtcblx0XHRcdH1cblx0XHR9LFxuXHR9KTtcblxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdC8vIGJyb3dzZXJfY2xvc2VfcGFnZVxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdHBpLnJlZ2lzdGVyVG9vbCh7XG5cdFx0bmFtZTogXCJicm93c2VyX2Nsb3NlX3BhZ2VcIixcblx0XHRsYWJlbDogXCJCcm93c2VyIENsb3NlIFBhZ2VcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiQ2xvc2UgYSBzcGVjaWZpYyBicm93c2VyIHBhZ2UvdGFiIGJ5IElELiBDYW5ub3QgY2xvc2UgdGhlIGxhc3QgcmVtYWluaW5nIHBhZ2UuIFRoZSBwYWdlJ3MgY2xvc2UgZXZlbnQgdHJpZ2dlcnMgYXV0b21hdGljIHJlZ2lzdHJ5IGNsZWFudXAgYW5kIGFjdGl2ZS1wYWdlIGZhbGxiYWNrLlwiLFxuXHRcdHBhcmFtZXRlcnM6IFR5cGUuT2JqZWN0KHtcblx0XHRcdGlkOiBUeXBlLk51bWJlcih7IGRlc2NyaXB0aW9uOiBcIlBhZ2UgSUQgdG8gY2xvc2UgKGZyb20gYnJvd3Nlcl9saXN0X3BhZ2VzKVwiIH0pLFxuXHRcdH0pLFxuXG5cdFx0YXN5bmMgZXhlY3V0ZShfdG9vbENhbGxJZCwgcGFyYW1zLCBfc2lnbmFsLCBfb25VcGRhdGUsIF9jdHgpIHtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGF3YWl0IGRlcHMuZW5zdXJlQnJvd3NlcigpO1xuXHRcdFx0XHRjb25zdCBwYWdlUmVnaXN0cnkgPSBnZXRQYWdlUmVnaXN0cnkoKTtcblx0XHRcdFx0aWYgKHBhZ2VSZWdpc3RyeS5wYWdlcy5sZW5ndGggPD0gMSkge1xuXHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYENhbm5vdCBjbG9zZSB0aGUgbGFzdCByZW1haW5pbmcgcGFnZS4gVXNlIGJyb3dzZXJfY2xvc2UgdG8gY2xvc2UgdGhlIGVudGlyZSBicm93c2VyLmAgfV0sXG5cdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGVycm9yOiBcImxhc3RfcGFnZVwiLCBwYWdlQ291bnQ6IHBhZ2VSZWdpc3RyeS5wYWdlcy5sZW5ndGggfSxcblx0XHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsXG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0fVxuXHRcdFx0XHRjb25zdCBlbnRyeSA9IHBhZ2VSZWdpc3RyeS5wYWdlcy5maW5kKChlOiBhbnkpID0+IGUuaWQgPT09IHBhcmFtcy5pZCk7XG5cdFx0XHRcdGlmICghZW50cnkpIHtcblx0XHRcdFx0XHRjb25zdCBhdmFpbGFibGUgPSBwYWdlUmVnaXN0cnkucGFnZXMubWFwKChlOiBhbnkpID0+IGUuaWQpO1xuXHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYFBhZ2UgJHtwYXJhbXMuaWR9IG5vdCBmb3VuZC4gQXZhaWxhYmxlIHBhZ2UgSURzOiBbJHthdmFpbGFibGUuam9pbihcIiwgXCIpfV0uYCB9XSxcblx0XHRcdFx0XHRcdGRldGFpbHM6IHsgZXJyb3I6IFwibm90X2ZvdW5kXCIsIGF2YWlsYWJsZSB9LFxuXHRcdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9XG5cdFx0XHRcdGF3YWl0IGVudHJ5LnBhZ2UuY2xvc2UoKTtcblx0XHRcdFx0c2V0QWN0aXZlRnJhbWUobnVsbCk7XG5cdFx0XHRcdGZvciAoY29uc3QgcmVtYWluaW5nIG9mIHBhZ2VSZWdpc3RyeS5wYWdlcykge1xuXHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHRyZW1haW5pbmcudGl0bGUgPSBhd2FpdCByZW1haW5pbmcucGFnZS50aXRsZSgpO1xuXHRcdFx0XHRcdFx0cmVtYWluaW5nLnVybCA9IHJlbWFpbmluZy5wYWdlLnVybCgpO1xuXHRcdFx0XHRcdH0gY2F0Y2ggeyAvKiBub24tZmF0YWwgXHUyMDE0IHBhZ2UgbWF5IGhhdmUgYmVlbiBjbG9zZWQgb3IgbmF2aWdhdGVkIGF3YXkgKi8gfVxuXHRcdFx0XHR9XG5cdFx0XHRcdGNvbnN0IHBhZ2VzID0gcmVnaXN0cnlMaXN0UGFnZXMocGFnZVJlZ2lzdHJ5KTtcblx0XHRcdFx0Y29uc3QgbGluZXMgPSBwYWdlcy5tYXAoKHA6IGFueSkgPT4ge1xuXHRcdFx0XHRcdGNvbnN0IGFjdGl2ZSA9IHAuaXNBY3RpdmUgPyBcIiBcdTIxOTAgYWN0aXZlXCIgOiBcIlwiO1xuXHRcdFx0XHRcdHJldHVybiBgICBbJHtwLmlkfV0gJHtwLnRpdGxlIHx8IFwiKHVudGl0bGVkKVwifSBcdTIwMTQgJHtwLnVybH0ke2FjdGl2ZX1gO1xuXHRcdFx0XHR9KTtcblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYENsb3NlZCBwYWdlICR7cGFyYW1zLmlkfS4gJHtwYWdlcy5sZW5ndGh9IHBhZ2UocykgcmVtYWluaW5nOlxcbiR7bGluZXMuam9pbihcIlxcblwiKX1gIH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgY2xvc2VkSWQ6IHBhcmFtcy5pZCwgcGFnZXMsIGNvdW50OiBwYWdlcy5sZW5ndGggfSxcblx0XHRcdFx0fTtcblx0XHRcdH0gY2F0Y2ggKGVycjogYW55KSB7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBDbG9zZSBwYWdlIGZhaWxlZDogJHtlcnIubWVzc2FnZX1gIH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgZXJyb3I6IGVyci5tZXNzYWdlIH0sXG5cdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0fTtcblx0XHRcdH1cblx0XHR9LFxuXHR9KTtcblxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdC8vIGJyb3dzZXJfbGlzdF9mcmFtZXNcblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHRwaS5yZWdpc3RlclRvb2woe1xuXHRcdG5hbWU6IFwiYnJvd3Nlcl9saXN0X2ZyYW1lc1wiLFxuXHRcdGxhYmVsOiBcIkJyb3dzZXIgTGlzdCBGcmFtZXNcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiTGlzdCBhbGwgZnJhbWVzIGluIHRoZSBhY3RpdmUgcGFnZSwgaW5jbHVkaW5nIHRoZSBtYWluIGZyYW1lIGFuZCBhbnkgaWZyYW1lcy4gU2hvd3MgZnJhbWUgbmFtZSwgVVJMLCBhbmQgcGFyZW50IGZyYW1lIG5hbWUuIFVzZSBiZWZvcmUgYnJvd3Nlcl9zZWxlY3RfZnJhbWUgdG8gaWRlbnRpZnkgYXZhaWxhYmxlIGZyYW1lcy5cIixcblx0XHRwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7fSksXG5cblx0XHRhc3luYyBleGVjdXRlKF90b29sQ2FsbElkLCBfcGFyYW1zLCBfc2lnbmFsLCBfb25VcGRhdGUsIF9jdHgpIHtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGF3YWl0IGRlcHMuZW5zdXJlQnJvd3NlcigpO1xuXHRcdFx0XHRjb25zdCBwID0gZGVwcy5nZXRBY3RpdmVQYWdlKCk7XG5cdFx0XHRcdGNvbnN0IGZyYW1lcyA9IHAuZnJhbWVzKCk7XG5cdFx0XHRcdGNvbnN0IG1haW5GcmFtZSA9IHAubWFpbkZyYW1lKCk7XG5cdFx0XHRcdGNvbnN0IGFjdGl2ZUZyYW1lID0gZ2V0QWN0aXZlRnJhbWUoKTtcblx0XHRcdFx0Y29uc3QgZnJhbWVMaXN0ID0gZnJhbWVzLm1hcCgoZiwgaW5kZXgpID0+IHtcblx0XHRcdFx0XHRjb25zdCBpc01haW4gPSBmID09PSBtYWluRnJhbWU7XG5cdFx0XHRcdFx0Y29uc3QgcGFyZW50TmFtZSA9IGYucGFyZW50RnJhbWUoKT8ubmFtZSgpIHx8IChmLnBhcmVudEZyYW1lKCkgPT09IG1haW5GcmFtZSA/IFwibWFpblwiIDogXCJcIik7XG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdGluZGV4LFxuXHRcdFx0XHRcdFx0bmFtZTogZi5uYW1lKCkgfHwgKGlzTWFpbiA/IFwibWFpblwiIDogYCh1bm5hbWVkLSR7aW5kZXh9KWApLFxuXHRcdFx0XHRcdFx0dXJsOiBmLnVybCgpLFxuXHRcdFx0XHRcdFx0aXNNYWluLFxuXHRcdFx0XHRcdFx0cGFyZW50TmFtZTogaXNNYWluID8gbnVsbCA6IChwYXJlbnROYW1lIHx8IFwibWFpblwiKSxcblx0XHRcdFx0XHRcdGlzQWN0aXZlOiBmID09PSBhY3RpdmVGcmFtZSxcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9KTtcblx0XHRcdFx0Y29uc3QgbGluZXMgPSBmcmFtZUxpc3QubWFwKChmKSA9PiB7XG5cdFx0XHRcdFx0Y29uc3QgbWFpbiA9IGYuaXNNYWluID8gXCIgW21haW5dXCIgOiBcIlwiO1xuXHRcdFx0XHRcdGNvbnN0IGFjdGl2ZSA9IGYuaXNBY3RpdmUgPyBcIiBcdTIxOTAgc2VsZWN0ZWRcIiA6IFwiXCI7XG5cdFx0XHRcdFx0Y29uc3QgcGFyZW50ID0gZi5wYXJlbnROYW1lID8gYCAocGFyZW50OiAke2YucGFyZW50TmFtZX0pYCA6IFwiXCI7XG5cdFx0XHRcdFx0cmV0dXJuIGAgIFske2YuaW5kZXh9XSBcIiR7Zi5uYW1lfVwiIFx1MjAxNCAke2YudXJsfSR7bWFpbn0ke3BhcmVudH0ke2FjdGl2ZX1gO1xuXHRcdFx0XHR9KTtcblx0XHRcdFx0Y29uc3QgYWN0aXZlSW5mbyA9IGFjdGl2ZUZyYW1lID8gYEFjdGl2ZSBmcmFtZTogXCIke2FjdGl2ZUZyYW1lLm5hbWUoKSB8fCBcIih1bm5hbWVkKVwifVwiYCA6IFwiTm8gZnJhbWUgc2VsZWN0ZWQgKG9wZXJhdGluZyBvbiBtYWluIHBhZ2UpXCI7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGAke2ZyYW1lTGlzdC5sZW5ndGh9IGZyYW1lKHMpIGluIGFjdGl2ZSBwYWdlOlxcbiR7bGluZXMuam9pbihcIlxcblwiKX1cXG5cXG4ke2FjdGl2ZUluZm99YCB9XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7IGZyYW1lczogZnJhbWVMaXN0LCBjb3VudDogZnJhbWVMaXN0Lmxlbmd0aCwgYWN0aXZlRnJhbWU6IGFjdGl2ZUZyYW1lPy5uYW1lKCkgPz8gbnVsbCB9LFxuXHRcdFx0XHR9O1xuXHRcdFx0fSBjYXRjaCAoZXJyOiBhbnkpIHtcblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYExpc3QgZnJhbWVzIGZhaWxlZDogJHtlcnIubWVzc2FnZX1gIH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgZXJyb3I6IGVyci5tZXNzYWdlIH0sXG5cdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0fTtcblx0XHRcdH1cblx0XHR9LFxuXHR9KTtcblxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdC8vIGJyb3dzZXJfc2VsZWN0X2ZyYW1lXG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblx0cGkucmVnaXN0ZXJUb29sKHtcblx0XHRuYW1lOiBcImJyb3dzZXJfc2VsZWN0X2ZyYW1lXCIsXG5cdFx0bGFiZWw6IFwiQnJvd3NlciBTZWxlY3QgRnJhbWVcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiU2VsZWN0IGEgZnJhbWUgd2l0aGluIHRoZSBhY3RpdmUgcGFnZSB0byBvcGVyYXRlIG9uLiBGaW5kIGZyYW1lcyBieSBuYW1lLCBVUkwgcGF0dGVybiwgb3IgaW5kZXguIFBhc3MgbnVsbCBvciBcXFwibWFpblxcXCIgdG8gcmVzZXQgYmFjayB0byB0aGUgbWFpbiBwYWdlIGZyYW1lLiBPbmNlIGEgZnJhbWUgaXMgc2VsZWN0ZWQsIHRvb2xzIGxpa2UgYnJvd3Nlcl9ldmFsdWF0ZSwgYnJvd3Nlcl9maW5kLCBhbmQgYnJvd3Nlcl9jbGljayB3aWxsIG9wZXJhdGUgd2l0aGluIHRoYXQgZnJhbWUgKGFmdGVyIFQwMyBtaWdyYXRpb24pLlwiLFxuXHRcdHBhcmFtZXRlcnM6IFR5cGUuT2JqZWN0KHtcblx0XHRcdG5hbWU6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJGcmFtZSBuYW1lIHRvIHNlbGVjdC4gVXNlICdtYWluJyBvciAnbnVsbCcgdG8gcmVzZXQgdG8gbWFpbiBmcmFtZS5cIiB9KSksXG5cdFx0XHR1cmxQYXR0ZXJuOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiVVJMIHN1YnN0cmluZyB0byBtYXRjaCBhZ2FpbnN0IGZyYW1lIFVSTHMuXCIgfSkpLFxuXHRcdFx0aW5kZXg6IFR5cGUuT3B0aW9uYWwoVHlwZS5OdW1iZXIoeyBkZXNjcmlwdGlvbjogXCJGcmFtZSBpbmRleCBmcm9tIGJyb3dzZXJfbGlzdF9mcmFtZXMuXCIgfSkpLFxuXHRcdH0pLFxuXG5cdFx0YXN5bmMgZXhlY3V0ZShfdG9vbENhbGxJZCwgcGFyYW1zLCBfc2lnbmFsLCBfb25VcGRhdGUsIF9jdHgpIHtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGF3YWl0IGRlcHMuZW5zdXJlQnJvd3NlcigpO1xuXHRcdFx0XHRjb25zdCBwID0gZGVwcy5nZXRBY3RpdmVQYWdlKCk7XG5cdFx0XHRcdGNvbnN0IGZyYW1lcyA9IHAuZnJhbWVzKCk7XG5cblx0XHRcdFx0aWYgKHBhcmFtcy5uYW1lID09PSBcIm1haW5cIiB8fCBwYXJhbXMubmFtZSA9PT0gXCJudWxsXCIgfHwgcGFyYW1zLm5hbWUgPT09IG51bGwpIHtcblx0XHRcdFx0XHRzZXRBY3RpdmVGcmFtZShudWxsKTtcblx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiUmVzZXQgdG8gbWFpbiBwYWdlIGZyYW1lLiBUb29scyB3aWxsIG9wZXJhdGUgb24gdGhlIG1haW4gcGFnZS5cIiB9XSxcblx0XHRcdFx0XHRcdGRldGFpbHM6IHsgYWN0aXZlRnJhbWU6IG51bGwgfSxcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0aWYgKHBhcmFtcy5uYW1lKSB7XG5cdFx0XHRcdFx0Y29uc3QgZnJhbWUgPSBmcmFtZXMuZmluZCgoZikgPT4gZi5uYW1lKCkgPT09IHBhcmFtcy5uYW1lKTtcblx0XHRcdFx0XHRpZiAoIWZyYW1lKSB7XG5cdFx0XHRcdFx0XHRjb25zdCBhdmFpbGFibGUgPSBmcmFtZXMubWFwKChmLCBpKSA9PiBgWyR7aX1dIFwiJHtmLm5hbWUoKSB8fCBcIih1bm5hbWVkKVwifVwiIFx1MjAxNCAke2YudXJsKCl9YCk7XG5cdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYEZyYW1lIHdpdGggbmFtZSBcIiR7cGFyYW1zLm5hbWV9XCIgbm90IGZvdW5kLlxcbkF2YWlsYWJsZSBmcmFtZXM6XFxuICAke2F2YWlsYWJsZS5qb2luKFwiXFxuICBcIil9YCB9XSxcblx0XHRcdFx0XHRcdFx0ZGV0YWlsczogeyBlcnJvcjogXCJmcmFtZV9ub3RfZm91bmRcIiwgYXZhaWxhYmxlIH0sXG5cdFx0XHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsXG5cdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRzZXRBY3RpdmVGcmFtZShmcmFtZSk7XG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgU2VsZWN0ZWQgZnJhbWUgXCIke2ZyYW1lLm5hbWUoKX1cIiBcdTIwMTQgJHtmcmFtZS51cmwoKX1gIH1dLFxuXHRcdFx0XHRcdFx0ZGV0YWlsczogeyBuYW1lOiBmcmFtZS5uYW1lKCksIHVybDogZnJhbWUudXJsKCkgfSxcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0aWYgKHBhcmFtcy51cmxQYXR0ZXJuKSB7XG5cdFx0XHRcdFx0Y29uc3QgZnJhbWUgPSBmcmFtZXMuZmluZCgoZikgPT4gZi51cmwoKS5pbmNsdWRlcyhwYXJhbXMudXJsUGF0dGVybiEpKTtcblx0XHRcdFx0XHRpZiAoIWZyYW1lKSB7XG5cdFx0XHRcdFx0XHRjb25zdCBhdmFpbGFibGUgPSBmcmFtZXMubWFwKChmLCBpKSA9PiBgWyR7aX1dIFwiJHtmLm5hbWUoKSB8fCBcIih1bm5hbWVkKVwifVwiIFx1MjAxNCAke2YudXJsKCl9YCk7XG5cdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYE5vIGZyYW1lIFVSTCBtYXRjaGVzIFwiJHtwYXJhbXMudXJsUGF0dGVybn1cIi5cXG5BdmFpbGFibGUgZnJhbWVzOlxcbiAgJHthdmFpbGFibGUuam9pbihcIlxcbiAgXCIpfWAgfV0sXG5cdFx0XHRcdFx0XHRcdGRldGFpbHM6IHsgZXJyb3I6IFwiZnJhbWVfbm90X2ZvdW5kXCIsIGF2YWlsYWJsZSB9LFxuXHRcdFx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0c2V0QWN0aXZlRnJhbWUoZnJhbWUpO1xuXHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYFNlbGVjdGVkIGZyYW1lIFwiJHtmcmFtZS5uYW1lKCkgfHwgXCIodW5uYW1lZClcIn1cIiBcdTIwMTQgJHtmcmFtZS51cmwoKX1gIH1dLFxuXHRcdFx0XHRcdFx0ZGV0YWlsczogeyBuYW1lOiBmcmFtZS5uYW1lKCksIHVybDogZnJhbWUudXJsKCkgfSxcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0aWYgKHBhcmFtcy5pbmRleCAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0XHRcdFx0aWYgKHBhcmFtcy5pbmRleCA8IDAgfHwgcGFyYW1zLmluZGV4ID49IGZyYW1lcy5sZW5ndGgpIHtcblx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgRnJhbWUgaW5kZXggJHtwYXJhbXMuaW5kZXh9IG91dCBvZiByYW5nZS4gJHtmcmFtZXMubGVuZ3RofSBmcmFtZShzKSBhdmFpbGFibGUgKDAtJHtmcmFtZXMubGVuZ3RoIC0gMX0pLmAgfV0sXG5cdFx0XHRcdFx0XHRcdGRldGFpbHM6IHsgZXJyb3I6IFwiaW5kZXhfb3V0X29mX3JhbmdlXCIsIGNvdW50OiBmcmFtZXMubGVuZ3RoIH0sXG5cdFx0XHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsXG5cdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRjb25zdCBmcmFtZSA9IGZyYW1lc1twYXJhbXMuaW5kZXhdO1xuXHRcdFx0XHRcdHNldEFjdGl2ZUZyYW1lKGZyYW1lKTtcblx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBTZWxlY3RlZCBmcmFtZSBbJHtwYXJhbXMuaW5kZXh9XSBcIiR7ZnJhbWUubmFtZSgpIHx8IFwiKHVubmFtZWQpXCJ9XCIgXHUyMDE0ICR7ZnJhbWUudXJsKCl9YCB9XSxcblx0XHRcdFx0XHRcdGRldGFpbHM6IHsgaW5kZXg6IHBhcmFtcy5pbmRleCwgbmFtZTogZnJhbWUubmFtZSgpLCB1cmw6IGZyYW1lLnVybCgpIH0sXG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiUHJvdmlkZSBuYW1lLCB1cmxQYXR0ZXJuLCBvciBpbmRleCB0byBzZWxlY3QgYSBmcmFtZS4gVXNlIG5hbWU9J21haW4nIHRvIHJlc2V0IHRvIG1haW4gZnJhbWUuXCIgfV0sXG5cdFx0XHRcdFx0ZGV0YWlsczogeyBlcnJvcjogXCJub19jcml0ZXJpYVwiIH0sXG5cdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0fTtcblx0XHRcdH0gY2F0Y2ggKGVycjogYW55KSB7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBTZWxlY3QgZnJhbWUgZmFpbGVkOiAke2Vyci5tZXNzYWdlfWAgfV0sXG5cdFx0XHRcdFx0ZGV0YWlsczogeyBlcnJvcjogZXJyLm1lc3NhZ2UgfSxcblx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHR9O1xuXHRcdFx0fVxuXHRcdH0sXG5cdH0pO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQ0EsU0FBUyxZQUFZO0FBQ3JCO0FBQUEsRUFDQztBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDTTtBQUVQO0FBQUEsRUFDQztBQUFBLEVBQ0E7QUFB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
