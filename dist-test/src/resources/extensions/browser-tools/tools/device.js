import { Type } from "@sinclair/typebox";
function registerDeviceTools(pi, deps) {
  pi.registerTool({
    name: "browser_emulate_device",
    label: "Browser Emulate Device",
    description: "Simulate a specific device by setting viewport, user agent, device scale factor, touch, and mobile flag. Uses Playwright's built-in device descriptors (~143 devices). Accepts fuzzy matching on device name. Note: Full emulation (user agent, isMobile) requires a context restart \u2014 the current page state will be lost. The tool recreates the context with the device profile applied.",
    parameters: Type.Object({
      device: Type.String({
        description: "Device name (e.g., 'iPhone 15', 'Pixel 7', 'iPad Pro 11'). Case-insensitive fuzzy matching. Use 'list' to see all available devices."
      })
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const { chromium, devices } = await import("playwright");
        const allDeviceNames = Object.keys(devices);
        if (params.device.toLowerCase() === "list") {
          const baseNames = allDeviceNames.filter((n) => !n.endsWith(" landscape"));
          return {
            content: [{
              type: "text",
              text: `Available devices (${allDeviceNames.length} total, ${baseNames.length} base):
${baseNames.join("\n")}`
            }],
            details: { devices: baseNames, total: allDeviceNames.length }
          };
        }
        const needle = params.device.toLowerCase();
        let exactMatch = allDeviceNames.find((n) => n.toLowerCase() === needle);
        if (!exactMatch) {
          const containsMatches = allDeviceNames.filter((n) => n.toLowerCase().includes(needle));
          if (containsMatches.length === 1) {
            exactMatch = containsMatches[0];
          } else if (containsMatches.length > 1) {
            containsMatches.sort((a, b) => a.length - b.length);
            exactMatch = containsMatches[0];
            const suggestions = containsMatches.slice(0, 5).join(", ");
          } else {
            const suggestions = allDeviceNames.map((n) => ({ name: n, score: fuzzyScore(needle, n.toLowerCase()) })).sort((a, b) => b.score - a.score).slice(0, 5).map((s) => s.name);
            return {
              content: [{
                type: "text",
                text: `No device matching "${params.device}". Did you mean:
${suggestions.map((s) => `  - ${s}`).join("\n")}`
              }],
              details: { error: "no_match", suggestions },
              isError: true
            };
          }
        }
        const deviceDescriptor = devices[exactMatch];
        if (!deviceDescriptor) {
          return {
            content: [{ type: "text", text: `Device descriptor not found for "${exactMatch}"` }],
            details: { error: "descriptor_not_found" },
            isError: true
          };
        }
        const { page: currentPage, context: currentCtx } = await deps.ensureBrowser();
        const currentUrl = currentPage.url();
        await deps.closeBrowser();
        const needsHeadless = process.platform === "linux" && !process.env.DISPLAY;
        const launchOptions = {
          headless: needsHeadless || process.env.FORCE_HEADLESS === "true"
        };
        const customPath = process.env.BROWSER_PATH;
        if (customPath) launchOptions.executablePath = customPath;
        const browser = await chromium.launch(launchOptions);
        const context = await browser.newContext({
          ...deviceDescriptor
        });
        const { EVALUATE_HELPERS_SOURCE } = await import("../evaluate-helpers.js");
        await context.addInitScript(EVALUATE_HELPERS_SOURCE);
        const {
          setBrowser,
          setContext,
          pageRegistry,
          setSessionStartedAt,
          setSessionArtifactDir,
          resetAllState
        } = await import("../state.js");
        const { registryAddPage, registrySetActive } = await import("../core.js");
        resetAllState();
        setBrowser(browser);
        setContext(context);
        setSessionStartedAt(Date.now());
        const page = await context.newPage();
        const entry = registryAddPage(pageRegistry, {
          page,
          title: "",
          url: "about:blank",
          opener: null
        });
        registrySetActive(pageRegistry, entry.id);
        deps.attachPageListeners(page, entry.id);
        if (currentUrl && currentUrl !== "about:blank") {
          await page.goto(currentUrl, { waitUntil: "domcontentloaded", timeout: 15e3 }).catch((e) => {
            if (process.env.GSD_DEBUG) console.error("[browser-tools] device goto restore failed:", e.message);
          });
        }
        const viewport = deviceDescriptor.viewport;
        const vpText = viewport ? `${viewport.width}x${viewport.height}` : "unknown";
        return {
          content: [{
            type: "text",
            text: `Device emulation active: ${exactMatch}
Viewport: ${vpText}
User Agent: ${deviceDescriptor.userAgent?.slice(0, 80) ?? "default"}...
Mobile: ${deviceDescriptor.isMobile ?? false}
Touch: ${deviceDescriptor.hasTouch ?? false}
Scale Factor: ${deviceDescriptor.deviceScaleFactor ?? 1}

Context was restarted for full emulation. Page state was reset.`
          }],
          details: {
            device: exactMatch,
            viewport: vpText,
            isMobile: deviceDescriptor.isMobile ?? false,
            hasTouch: deviceDescriptor.hasTouch ?? false,
            deviceScaleFactor: deviceDescriptor.deviceScaleFactor ?? 1,
            userAgent: deviceDescriptor.userAgent,
            restoredUrl: currentUrl
          }
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Device emulation failed: ${err.message}` }],
          details: { error: err.message },
          isError: true
        };
      }
    }
  });
}
function fuzzyScore(needle, haystack) {
  let score = 0;
  let hi = 0;
  for (let ni = 0; ni < needle.length && hi < haystack.length; ni++) {
    const idx = haystack.indexOf(needle[ni], hi);
    if (idx >= 0) {
      score++;
      hi = idx + 1;
    }
  }
  return score / Math.max(needle.length, 1);
}
export {
  registerDeviceTools
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2Jyb3dzZXItdG9vbHMvdG9vbHMvZGV2aWNlLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdHlwZSB7IEV4dGVuc2lvbkFQSSB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuaW1wb3J0IHsgVHlwZSB9IGZyb20gXCJAc2luY2xhaXIvdHlwZWJveFwiO1xuaW1wb3J0IHR5cGUgeyBUb29sRGVwcyB9IGZyb20gXCIuLi9zdGF0ZS5qc1wiO1xuXG4vKipcbiAqIERldmljZSBlbXVsYXRpb24gdG9vbCBcdTIwMTQgZnVsbCBkZXZpY2Ugc2ltdWxhdGlvbiB1c2luZyBQbGF5d3JpZ2h0J3MgYnVpbHQtaW4gZGV2aWNlIGRlc2NyaXB0b3JzLlxuICovXG5cbmV4cG9ydCBmdW5jdGlvbiByZWdpc3RlckRldmljZVRvb2xzKHBpOiBFeHRlbnNpb25BUEksIGRlcHM6IFRvb2xEZXBzKTogdm9pZCB7XG5cdHBpLnJlZ2lzdGVyVG9vbCh7XG5cdFx0bmFtZTogXCJicm93c2VyX2VtdWxhdGVfZGV2aWNlXCIsXG5cdFx0bGFiZWw6IFwiQnJvd3NlciBFbXVsYXRlIERldmljZVwiLFxuXHRcdGRlc2NyaXB0aW9uOlxuXHRcdFx0XCJTaW11bGF0ZSBhIHNwZWNpZmljIGRldmljZSBieSBzZXR0aW5nIHZpZXdwb3J0LCB1c2VyIGFnZW50LCBkZXZpY2Ugc2NhbGUgZmFjdG9yLCB0b3VjaCwgYW5kIG1vYmlsZSBmbGFnLiBcIiArXG5cdFx0XHRcIlVzZXMgUGxheXdyaWdodCdzIGJ1aWx0LWluIGRldmljZSBkZXNjcmlwdG9ycyAofjE0MyBkZXZpY2VzKS4gQWNjZXB0cyBmdXp6eSBtYXRjaGluZyBvbiBkZXZpY2UgbmFtZS4gXCIgK1xuXHRcdFx0XCJOb3RlOiBGdWxsIGVtdWxhdGlvbiAodXNlciBhZ2VudCwgaXNNb2JpbGUpIHJlcXVpcmVzIGEgY29udGV4dCByZXN0YXJ0IFx1MjAxNCB0aGUgY3VycmVudCBwYWdlIHN0YXRlIHdpbGwgYmUgbG9zdC4gXCIgK1xuXHRcdFx0XCJUaGUgdG9vbCByZWNyZWF0ZXMgdGhlIGNvbnRleHQgd2l0aCB0aGUgZGV2aWNlIHByb2ZpbGUgYXBwbGllZC5cIixcblx0XHRwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG5cdFx0XHRkZXZpY2U6IFR5cGUuU3RyaW5nKHtcblx0XHRcdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcdFx0XCJEZXZpY2UgbmFtZSAoZS5nLiwgJ2lQaG9uZSAxNScsICdQaXhlbCA3JywgJ2lQYWQgUHJvIDExJykuIFwiICtcblx0XHRcdFx0XHRcIkNhc2UtaW5zZW5zaXRpdmUgZnV6enkgbWF0Y2hpbmcuIFVzZSAnbGlzdCcgdG8gc2VlIGFsbCBhdmFpbGFibGUgZGV2aWNlcy5cIixcblx0XHRcdH0pLFxuXHRcdH0pLFxuXG5cdFx0YXN5bmMgZXhlY3V0ZShfdG9vbENhbGxJZCwgcGFyYW1zLCBfc2lnbmFsLCBfb25VcGRhdGUsIF9jdHgpIHtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IHsgY2hyb21pdW0sIGRldmljZXMgfSA9IGF3YWl0IGltcG9ydChcInBsYXl3cmlnaHRcIik7XG5cdFx0XHRcdGNvbnN0IGFsbERldmljZU5hbWVzID0gT2JqZWN0LmtleXMoZGV2aWNlcyk7XG5cblx0XHRcdFx0Ly8gSGFuZGxlICdsaXN0JyByZXF1ZXN0XG5cdFx0XHRcdGlmIChwYXJhbXMuZGV2aWNlLnRvTG93ZXJDYXNlKCkgPT09IFwibGlzdFwiKSB7XG5cdFx0XHRcdFx0Ly8gR3JvdXAgYnkgYmFzZSBkZXZpY2UgbmFtZSAocmVtb3ZlIGxhbmRzY2FwZSB2YXJpYW50cyBmb3IgY2xlYW5lciBkaXNwbGF5KVxuXHRcdFx0XHRcdGNvbnN0IGJhc2VOYW1lcyA9IGFsbERldmljZU5hbWVzLmZpbHRlcigobikgPT4gIW4uZW5kc1dpdGgoXCIgbGFuZHNjYXBlXCIpKTtcblx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0Y29udGVudDogW3tcblx0XHRcdFx0XHRcdFx0dHlwZTogXCJ0ZXh0XCIsXG5cdFx0XHRcdFx0XHRcdHRleHQ6IGBBdmFpbGFibGUgZGV2aWNlcyAoJHthbGxEZXZpY2VOYW1lcy5sZW5ndGh9IHRvdGFsLCAke2Jhc2VOYW1lcy5sZW5ndGh9IGJhc2UpOlxcbiR7YmFzZU5hbWVzLmpvaW4oXCJcXG5cIil9YCxcblx0XHRcdFx0XHRcdH1dLFxuXHRcdFx0XHRcdFx0ZGV0YWlsczogeyBkZXZpY2VzOiBiYXNlTmFtZXMsIHRvdGFsOiBhbGxEZXZpY2VOYW1lcy5sZW5ndGggfSxcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gRnV6enkgbWF0Y2ggZGV2aWNlIG5hbWVcblx0XHRcdFx0Y29uc3QgbmVlZGxlID0gcGFyYW1zLmRldmljZS50b0xvd2VyQ2FzZSgpO1xuXHRcdFx0XHRsZXQgZXhhY3RNYXRjaCA9IGFsbERldmljZU5hbWVzLmZpbmQoKG4pID0+IG4udG9Mb3dlckNhc2UoKSA9PT0gbmVlZGxlKTtcblx0XHRcdFx0aWYgKCFleGFjdE1hdGNoKSB7XG5cdFx0XHRcdFx0Ly8gVHJ5IGNvbnRhaW5zIG1hdGNoXG5cdFx0XHRcdFx0Y29uc3QgY29udGFpbnNNYXRjaGVzID0gYWxsRGV2aWNlTmFtZXMuZmlsdGVyKChuKSA9PiBuLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMobmVlZGxlKSk7XG5cdFx0XHRcdFx0aWYgKGNvbnRhaW5zTWF0Y2hlcy5sZW5ndGggPT09IDEpIHtcblx0XHRcdFx0XHRcdGV4YWN0TWF0Y2ggPSBjb250YWluc01hdGNoZXNbMF07XG5cdFx0XHRcdFx0fSBlbHNlIGlmIChjb250YWluc01hdGNoZXMubGVuZ3RoID4gMSkge1xuXHRcdFx0XHRcdFx0Ly8gUGljayB0aGUgc2hvcnRlc3QgbWF0Y2ggKG1vc3Qgc3BlY2lmaWMpXG5cdFx0XHRcdFx0XHRjb250YWluc01hdGNoZXMuc29ydCgoYSwgYikgPT4gYS5sZW5ndGggLSBiLmxlbmd0aCk7XG5cdFx0XHRcdFx0XHRleGFjdE1hdGNoID0gY29udGFpbnNNYXRjaGVzWzBdO1xuXHRcdFx0XHRcdFx0Y29uc3Qgc3VnZ2VzdGlvbnMgPSBjb250YWluc01hdGNoZXMuc2xpY2UoMCwgNSkuam9pbihcIiwgXCIpO1xuXHRcdFx0XHRcdFx0Ly8gQ29udGludWUgd2l0aCBiZXN0IG1hdGNoIGJ1dCBtZW50aW9uIGFsdGVybmF0aXZlc1xuXHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHQvLyBObyBtYXRjaCBhdCBhbGwgXHUyMDE0IHN1Z2dlc3QgY2xvc2VzdFxuXHRcdFx0XHRcdFx0Y29uc3Qgc3VnZ2VzdGlvbnMgPSBhbGxEZXZpY2VOYW1lc1xuXHRcdFx0XHRcdFx0XHQubWFwKChuKSA9PiAoeyBuYW1lOiBuLCBzY29yZTogZnV6enlTY29yZShuZWVkbGUsIG4udG9Mb3dlckNhc2UoKSkgfSkpXG5cdFx0XHRcdFx0XHRcdC5zb3J0KChhLCBiKSA9PiBiLnNjb3JlIC0gYS5zY29yZSlcblx0XHRcdFx0XHRcdFx0LnNsaWNlKDAsIDUpXG5cdFx0XHRcdFx0XHRcdC5tYXAoKHMpID0+IHMubmFtZSk7XG5cblx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7XG5cdFx0XHRcdFx0XHRcdFx0dHlwZTogXCJ0ZXh0XCIsXG5cdFx0XHRcdFx0XHRcdFx0dGV4dDogYE5vIGRldmljZSBtYXRjaGluZyBcIiR7cGFyYW1zLmRldmljZX1cIi4gRGlkIHlvdSBtZWFuOlxcbiR7c3VnZ2VzdGlvbnMubWFwKChzKSA9PiBgICAtICR7c31gKS5qb2luKFwiXFxuXCIpfWAsXG5cdFx0XHRcdFx0XHRcdH1dLFxuXHRcdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGVycm9yOiBcIm5vX21hdGNoXCIsIHN1Z2dlc3Rpb25zIH0sXG5cdFx0XHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsXG5cdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNvbnN0IGRldmljZURlc2NyaXB0b3IgPSBkZXZpY2VzW2V4YWN0TWF0Y2ghXTtcblx0XHRcdFx0aWYgKCFkZXZpY2VEZXNjcmlwdG9yKSB7XG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgRGV2aWNlIGRlc2NyaXB0b3Igbm90IGZvdW5kIGZvciBcIiR7ZXhhY3RNYXRjaH1cImAgfV0sXG5cdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGVycm9yOiBcImRlc2NyaXB0b3Jfbm90X2ZvdW5kXCIgfSxcblx0XHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsXG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdC8vIENvbnRleHQgcmVzdGFydCByZXF1aXJlZCBmb3IgZnVsbCBlbXVsYXRpb24uXG5cdFx0XHRcdC8vIFNhdmUgY3VycmVudCBVUkwgdG8gbmF2aWdhdGUgYmFjayBhZnRlciByZXN0YXJ0LlxuXHRcdFx0XHRjb25zdCB7IHBhZ2U6IGN1cnJlbnRQYWdlLCBjb250ZXh0OiBjdXJyZW50Q3R4IH0gPSBhd2FpdCBkZXBzLmVuc3VyZUJyb3dzZXIoKTtcblx0XHRcdFx0Y29uc3QgY3VycmVudFVybCA9IGN1cnJlbnRQYWdlLnVybCgpO1xuXG5cdFx0XHRcdC8vIENsb3NlIGV4aXN0aW5nIGJyb3dzZXIgYW5kIHJlbGF1bmNoIHdpdGggZGV2aWNlIHByb2ZpbGVcblx0XHRcdFx0YXdhaXQgZGVwcy5jbG9zZUJyb3dzZXIoKTtcblxuXHRcdFx0XHQvLyBSZS1sYXVuY2ggXHUyMDE0IGVuc3VyZUJyb3dzZXIgZG9lc24ndCBhY2NlcHQgZGV2aWNlIHBhcmFtcywgc28gd2UgZG8gaXQgbWFudWFsbHkuXG5cdFx0XHRcdC8vIFRoaXMgaXMgYSBvbmUtb2ZmIGNvbnRleHQgY3JlYXRpb24gd2l0aCBkZXZpY2UgZW11bGF0aW9uLlxuXHRcdFx0XHRjb25zdCBuZWVkc0hlYWRsZXNzID0gcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJsaW51eFwiICYmICFwcm9jZXNzLmVudi5ESVNQTEFZO1xuXHRcdFx0XHRjb25zdCBsYXVuY2hPcHRpb25zOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcblx0XHRcdFx0XHRoZWFkbGVzczogbmVlZHNIZWFkbGVzcyB8fCBwcm9jZXNzLmVudi5GT1JDRV9IRUFETEVTUyA9PT0gXCJ0cnVlXCIsXG5cdFx0XHRcdH07XG5cdFx0XHRcdGNvbnN0IGN1c3RvbVBhdGggPSBwcm9jZXNzLmVudi5CUk9XU0VSX1BBVEg7XG5cdFx0XHRcdGlmIChjdXN0b21QYXRoKSBsYXVuY2hPcHRpb25zLmV4ZWN1dGFibGVQYXRoID0gY3VzdG9tUGF0aDtcblxuXHRcdFx0XHRjb25zdCBicm93c2VyID0gYXdhaXQgY2hyb21pdW0ubGF1bmNoKGxhdW5jaE9wdGlvbnMpO1xuXHRcdFx0XHRjb25zdCBjb250ZXh0ID0gYXdhaXQgYnJvd3Nlci5uZXdDb250ZXh0KHtcblx0XHRcdFx0XHQuLi5kZXZpY2VEZXNjcmlwdG9yLFxuXHRcdFx0XHR9KTtcblxuXHRcdFx0XHQvLyBJbmplY3QgZXZhbHVhdGUgaGVscGVyc1xuXHRcdFx0XHRjb25zdCB7IEVWQUxVQVRFX0hFTFBFUlNfU09VUkNFIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9ldmFsdWF0ZS1oZWxwZXJzLmpzXCIpO1xuXHRcdFx0XHRhd2FpdCBjb250ZXh0LmFkZEluaXRTY3JpcHQoRVZBTFVBVEVfSEVMUEVSU19TT1VSQ0UpO1xuXG5cdFx0XHRcdC8vIFdpcmUgdXAgc3RhdGVcblx0XHRcdFx0Y29uc3Qge1xuXHRcdFx0XHRcdHNldEJyb3dzZXIsIHNldENvbnRleHQsIHBhZ2VSZWdpc3RyeSwgc2V0U2Vzc2lvblN0YXJ0ZWRBdCxcblx0XHRcdFx0XHRzZXRTZXNzaW9uQXJ0aWZhY3REaXIsIHJlc2V0QWxsU3RhdGUsXG5cdFx0XHRcdH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9zdGF0ZS5qc1wiKTtcblx0XHRcdFx0Y29uc3QgeyByZWdpc3RyeUFkZFBhZ2UsIHJlZ2lzdHJ5U2V0QWN0aXZlIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9jb3JlLmpzXCIpO1xuXG5cdFx0XHRcdC8vIFJlc2V0IHN0YXRlIGZvciBuZXcgc2Vzc2lvblxuXHRcdFx0XHRyZXNldEFsbFN0YXRlKCk7XG5cdFx0XHRcdHNldEJyb3dzZXIoYnJvd3Nlcik7XG5cdFx0XHRcdHNldENvbnRleHQoY29udGV4dCk7XG5cdFx0XHRcdHNldFNlc3Npb25TdGFydGVkQXQoRGF0ZS5ub3coKSk7XG5cblx0XHRcdFx0Y29uc3QgcGFnZSA9IGF3YWl0IGNvbnRleHQubmV3UGFnZSgpO1xuXHRcdFx0XHRjb25zdCBlbnRyeSA9IHJlZ2lzdHJ5QWRkUGFnZShwYWdlUmVnaXN0cnksIHtcblx0XHRcdFx0XHRwYWdlLFxuXHRcdFx0XHRcdHRpdGxlOiBcIlwiLFxuXHRcdFx0XHRcdHVybDogXCJhYm91dDpibGFua1wiLFxuXHRcdFx0XHRcdG9wZW5lcjogbnVsbCxcblx0XHRcdFx0fSk7XG5cdFx0XHRcdHJlZ2lzdHJ5U2V0QWN0aXZlKHBhZ2VSZWdpc3RyeSwgZW50cnkuaWQpO1xuXHRcdFx0XHRkZXBzLmF0dGFjaFBhZ2VMaXN0ZW5lcnMocGFnZSwgZW50cnkuaWQpO1xuXG5cdFx0XHRcdC8vIE5hdmlnYXRlIGJhY2sgdG8gcHJldmlvdXMgVVJMIGlmIGl0IHdhc24ndCBhYm91dDpibGFua1xuXHRcdFx0XHRpZiAoY3VycmVudFVybCAmJiBjdXJyZW50VXJsICE9PSBcImFib3V0OmJsYW5rXCIpIHtcblx0XHRcdFx0XHRhd2FpdCBwYWdlLmdvdG8oY3VycmVudFVybCwgeyB3YWl0VW50aWw6IFwiZG9tY29udGVudGxvYWRlZFwiLCB0aW1lb3V0OiAxNTAwMCB9KS5jYXRjaCgoZSkgPT4geyBpZiAocHJvY2Vzcy5lbnYuR1NEX0RFQlVHKSBjb25zb2xlLmVycm9yKFwiW2Jyb3dzZXItdG9vbHNdIGRldmljZSBnb3RvIHJlc3RvcmUgZmFpbGVkOlwiLCBlLm1lc3NhZ2UpOyB9KTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNvbnN0IHZpZXdwb3J0ID0gZGV2aWNlRGVzY3JpcHRvci52aWV3cG9ydDtcblx0XHRcdFx0Y29uc3QgdnBUZXh0ID0gdmlld3BvcnQgPyBgJHt2aWV3cG9ydC53aWR0aH14JHt2aWV3cG9ydC5oZWlnaHR9YCA6IFwidW5rbm93blwiO1xuXG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3tcblx0XHRcdFx0XHRcdHR5cGU6IFwidGV4dFwiLFxuXHRcdFx0XHRcdFx0dGV4dDogYERldmljZSBlbXVsYXRpb24gYWN0aXZlOiAke2V4YWN0TWF0Y2h9XFxuVmlld3BvcnQ6ICR7dnBUZXh0fVxcblVzZXIgQWdlbnQ6ICR7ZGV2aWNlRGVzY3JpcHRvci51c2VyQWdlbnQ/LnNsaWNlKDAsIDgwKSA/PyBcImRlZmF1bHRcIn0uLi5cXG5Nb2JpbGU6ICR7ZGV2aWNlRGVzY3JpcHRvci5pc01vYmlsZSA/PyBmYWxzZX1cXG5Ub3VjaDogJHtkZXZpY2VEZXNjcmlwdG9yLmhhc1RvdWNoID8/IGZhbHNlfVxcblNjYWxlIEZhY3RvcjogJHtkZXZpY2VEZXNjcmlwdG9yLmRldmljZVNjYWxlRmFjdG9yID8/IDF9XFxuXFxuQ29udGV4dCB3YXMgcmVzdGFydGVkIGZvciBmdWxsIGVtdWxhdGlvbi4gUGFnZSBzdGF0ZSB3YXMgcmVzZXQuYCxcblx0XHRcdFx0XHR9XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7XG5cdFx0XHRcdFx0XHRkZXZpY2U6IGV4YWN0TWF0Y2gsXG5cdFx0XHRcdFx0XHR2aWV3cG9ydDogdnBUZXh0LFxuXHRcdFx0XHRcdFx0aXNNb2JpbGU6IGRldmljZURlc2NyaXB0b3IuaXNNb2JpbGUgPz8gZmFsc2UsXG5cdFx0XHRcdFx0XHRoYXNUb3VjaDogZGV2aWNlRGVzY3JpcHRvci5oYXNUb3VjaCA/PyBmYWxzZSxcblx0XHRcdFx0XHRcdGRldmljZVNjYWxlRmFjdG9yOiBkZXZpY2VEZXNjcmlwdG9yLmRldmljZVNjYWxlRmFjdG9yID8/IDEsXG5cdFx0XHRcdFx0XHR1c2VyQWdlbnQ6IGRldmljZURlc2NyaXB0b3IudXNlckFnZW50LFxuXHRcdFx0XHRcdFx0cmVzdG9yZWRVcmw6IGN1cnJlbnRVcmwsXG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0fTtcblx0XHRcdH0gY2F0Y2ggKGVycjogYW55KSB7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBEZXZpY2UgZW11bGF0aW9uIGZhaWxlZDogJHtlcnIubWVzc2FnZX1gIH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgZXJyb3I6IGVyci5tZXNzYWdlIH0sXG5cdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0fTtcblx0XHRcdH1cblx0XHR9LFxuXHR9KTtcbn1cblxuLyoqXG4gKiBTaW1wbGUgZnV6enkgc2NvcmluZyBcdTIwMTQgY291bnRzIG1hdGNoaW5nIGNoYXJhY3RlcnMgaW4gb3JkZXIuXG4gKi9cbmZ1bmN0aW9uIGZ1enp5U2NvcmUobmVlZGxlOiBzdHJpbmcsIGhheXN0YWNrOiBzdHJpbmcpOiBudW1iZXIge1xuXHRsZXQgc2NvcmUgPSAwO1xuXHRsZXQgaGkgPSAwO1xuXHRmb3IgKGxldCBuaSA9IDA7IG5pIDwgbmVlZGxlLmxlbmd0aCAmJiBoaSA8IGhheXN0YWNrLmxlbmd0aDsgbmkrKykge1xuXHRcdGNvbnN0IGlkeCA9IGhheXN0YWNrLmluZGV4T2YobmVlZGxlW25pXSwgaGkpO1xuXHRcdGlmIChpZHggPj0gMCkge1xuXHRcdFx0c2NvcmUrKztcblx0XHRcdGhpID0gaWR4ICsgMTtcblx0XHR9XG5cdH1cblx0cmV0dXJuIHNjb3JlIC8gTWF0aC5tYXgobmVlZGxlLmxlbmd0aCwgMSk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFDQSxTQUFTLFlBQVk7QUFPZCxTQUFTLG9CQUFvQixJQUFrQixNQUFzQjtBQUMzRSxLQUFHLGFBQWE7QUFBQSxJQUNmLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLGFBQ0M7QUFBQSxJQUlELFlBQVks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
