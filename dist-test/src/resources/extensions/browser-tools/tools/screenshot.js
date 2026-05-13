import { Type } from "@sinclair/typebox";
import { getScreenshotFormatOverride, getScreenshotQualityDefault } from "../capture.js";
function registerScreenshotTools(pi, deps) {
  pi.registerTool({
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description: "Take a screenshot of the current browser page and return it as an inline image. Uses JPEG for viewport/fullpage (smaller, configurable quality) and PNG for element crops (preserves transparency). Optionally crop to a specific element by CSS selector.",
    compatibility: { producesImages: true },
    parameters: Type.Object({
      fullPage: Type.Optional(
        Type.Boolean({ description: "Capture the full scrollable page (default: false)" })
      ),
      selector: Type.Optional(
        Type.String({
          description: "CSS selector of a specific element to screenshot (crops to that element's bounding box). If omitted, screenshots the entire viewport."
        })
      ),
      quality: Type.Optional(
        Type.Number({
          description: "JPEG quality 1-100 (default: 80). Only applies to viewport/fullpage screenshots, not element crops. Lower = smaller image."
        })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const { page: p } = await deps.ensureBrowser();
        let screenshotBuffer;
        let mimeType;
        const formatOverride = getScreenshotFormatOverride();
        const quality = params.quality ?? getScreenshotQualityDefault(80);
        if (params.selector) {
          const fmt = formatOverride ?? "png";
          const locator = p.locator(params.selector).first();
          if (fmt === "jpeg") {
            screenshotBuffer = await locator.screenshot({ type: "jpeg", quality, scale: "css" });
            mimeType = "image/jpeg";
          } else {
            screenshotBuffer = await locator.screenshot({ type: "png", scale: "css" });
            mimeType = "image/png";
          }
        } else {
          const fmt = formatOverride ?? "jpeg";
          if (fmt === "png") {
            screenshotBuffer = await p.screenshot({
              fullPage: params.fullPage ?? false,
              type: "png",
              scale: "css"
            });
            mimeType = "image/png";
          } else {
            screenshotBuffer = await p.screenshot({
              fullPage: params.fullPage ?? false,
              type: "jpeg",
              quality,
              scale: "css"
            });
            mimeType = "image/jpeg";
          }
        }
        screenshotBuffer = await deps.constrainScreenshot(p, screenshotBuffer, mimeType, quality);
        const base64Data = screenshotBuffer.toString("base64");
        const title = await p.title();
        const url = p.url();
        const viewport = p.viewportSize();
        const vpText = viewport ? `${viewport.width}x${viewport.height}` : "unknown";
        const scope = params.selector ? `element "${params.selector}"` : params.fullPage ? "full page" : "viewport";
        return {
          content: [
            {
              type: "text",
              text: `Screenshot of ${scope}.
Page: ${title}
URL: ${url}
Viewport: ${vpText}`
            },
            {
              type: "image",
              data: base64Data,
              mimeType
            }
          ],
          details: { title, url, scope, viewport: vpText }
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Screenshot failed: ${err.message}` }],
          details: { error: err.message },
          isError: true
        };
      }
    }
  });
}
export {
  registerScreenshotTools
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2Jyb3dzZXItdG9vbHMvdG9vbHMvc2NyZWVuc2hvdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHR5cGUgeyBFeHRlbnNpb25BUEkgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7IFR5cGUgfSBmcm9tIFwiQHNpbmNsYWlyL3R5cGVib3hcIjtcbmltcG9ydCB0eXBlIHsgVG9vbERlcHMgfSBmcm9tIFwiLi4vc3RhdGUuanNcIjtcbmltcG9ydCB7IGdldFNjcmVlbnNob3RGb3JtYXRPdmVycmlkZSwgZ2V0U2NyZWVuc2hvdFF1YWxpdHlEZWZhdWx0IH0gZnJvbSBcIi4uL2NhcHR1cmUuanNcIjtcblxuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyU2NyZWVuc2hvdFRvb2xzKHBpOiBFeHRlbnNpb25BUEksIGRlcHM6IFRvb2xEZXBzKTogdm9pZCB7XG5cdHBpLnJlZ2lzdGVyVG9vbCh7XG5cdFx0bmFtZTogXCJicm93c2VyX3NjcmVlbnNob3RcIixcblx0XHRsYWJlbDogXCJCcm93c2VyIFNjcmVlbnNob3RcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiVGFrZSBhIHNjcmVlbnNob3Qgb2YgdGhlIGN1cnJlbnQgYnJvd3NlciBwYWdlIGFuZCByZXR1cm4gaXQgYXMgYW4gaW5saW5lIGltYWdlLiBVc2VzIEpQRUcgZm9yIHZpZXdwb3J0L2Z1bGxwYWdlIChzbWFsbGVyLCBjb25maWd1cmFibGUgcXVhbGl0eSkgYW5kIFBORyBmb3IgZWxlbWVudCBjcm9wcyAocHJlc2VydmVzIHRyYW5zcGFyZW5jeSkuIE9wdGlvbmFsbHkgY3JvcCB0byBhIHNwZWNpZmljIGVsZW1lbnQgYnkgQ1NTIHNlbGVjdG9yLlwiLFxuXHRcdGNvbXBhdGliaWxpdHk6IHsgcHJvZHVjZXNJbWFnZXM6IHRydWUgfSxcblx0XHRwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG5cdFx0XHRmdWxsUGFnZTogVHlwZS5PcHRpb25hbChcblx0XHRcdFx0VHlwZS5Cb29sZWFuKHsgZGVzY3JpcHRpb246IFwiQ2FwdHVyZSB0aGUgZnVsbCBzY3JvbGxhYmxlIHBhZ2UgKGRlZmF1bHQ6IGZhbHNlKVwiIH0pXG5cdFx0XHQpLFxuXHRcdFx0c2VsZWN0b3I6IFR5cGUuT3B0aW9uYWwoXG5cdFx0XHRcdFR5cGUuU3RyaW5nKHtcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFx0XHRcdFwiQ1NTIHNlbGVjdG9yIG9mIGEgc3BlY2lmaWMgZWxlbWVudCB0byBzY3JlZW5zaG90IChjcm9wcyB0byB0aGF0IGVsZW1lbnQncyBib3VuZGluZyBib3gpLiBJZiBvbWl0dGVkLCBzY3JlZW5zaG90cyB0aGUgZW50aXJlIHZpZXdwb3J0LlwiLFxuXHRcdFx0XHR9KVxuXHRcdFx0KSxcblx0XHRcdHF1YWxpdHk6IFR5cGUuT3B0aW9uYWwoXG5cdFx0XHRcdFR5cGUuTnVtYmVyKHtcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFx0XHRcdFwiSlBFRyBxdWFsaXR5IDEtMTAwIChkZWZhdWx0OiA4MCkuIE9ubHkgYXBwbGllcyB0byB2aWV3cG9ydC9mdWxscGFnZSBzY3JlZW5zaG90cywgbm90IGVsZW1lbnQgY3JvcHMuIExvd2VyID0gc21hbGxlciBpbWFnZS5cIixcblx0XHRcdFx0fSlcblx0XHRcdCksXG5cdFx0fSksXG5cblx0XHRhc3luYyBleGVjdXRlKF90b29sQ2FsbElkLCBwYXJhbXMsIF9zaWduYWwsIF9vblVwZGF0ZSwgX2N0eCkge1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0Y29uc3QgeyBwYWdlOiBwIH0gPSBhd2FpdCBkZXBzLmVuc3VyZUJyb3dzZXIoKTtcblxuXHRcdFx0XHRsZXQgc2NyZWVuc2hvdEJ1ZmZlcjogQnVmZmVyO1xuXHRcdFx0XHRsZXQgbWltZVR5cGU6IHN0cmluZztcblx0XHRcdFx0Y29uc3QgZm9ybWF0T3ZlcnJpZGUgPSBnZXRTY3JlZW5zaG90Rm9ybWF0T3ZlcnJpZGUoKTtcblx0XHRcdFx0Y29uc3QgcXVhbGl0eSA9IHBhcmFtcy5xdWFsaXR5ID8/IGdldFNjcmVlbnNob3RRdWFsaXR5RGVmYXVsdCg4MCk7XG5cblx0XHRcdFx0aWYgKHBhcmFtcy5zZWxlY3Rvcikge1xuXHRcdFx0XHRcdGNvbnN0IGZtdCA9IGZvcm1hdE92ZXJyaWRlID8/IFwicG5nXCI7XG5cdFx0XHRcdFx0Y29uc3QgbG9jYXRvciA9IHAubG9jYXRvcihwYXJhbXMuc2VsZWN0b3IpLmZpcnN0KCk7XG5cdFx0XHRcdFx0aWYgKGZtdCA9PT0gXCJqcGVnXCIpIHtcblx0XHRcdFx0XHRcdHNjcmVlbnNob3RCdWZmZXIgPSBhd2FpdCBsb2NhdG9yLnNjcmVlbnNob3QoeyB0eXBlOiBcImpwZWdcIiwgcXVhbGl0eSwgc2NhbGU6IFwiY3NzXCIgfSk7XG5cdFx0XHRcdFx0XHRtaW1lVHlwZSA9IFwiaW1hZ2UvanBlZ1wiO1xuXHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRzY3JlZW5zaG90QnVmZmVyID0gYXdhaXQgbG9jYXRvci5zY3JlZW5zaG90KHsgdHlwZTogXCJwbmdcIiwgc2NhbGU6IFwiY3NzXCIgfSk7XG5cdFx0XHRcdFx0XHRtaW1lVHlwZSA9IFwiaW1hZ2UvcG5nXCI7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdGNvbnN0IGZtdCA9IGZvcm1hdE92ZXJyaWRlID8/IFwianBlZ1wiO1xuXHRcdFx0XHRcdGlmIChmbXQgPT09IFwicG5nXCIpIHtcblx0XHRcdFx0XHRcdHNjcmVlbnNob3RCdWZmZXIgPSBhd2FpdCBwLnNjcmVlbnNob3Qoe1xuXHRcdFx0XHRcdFx0XHRmdWxsUGFnZTogcGFyYW1zLmZ1bGxQYWdlID8/IGZhbHNlLFxuXHRcdFx0XHRcdFx0XHR0eXBlOiBcInBuZ1wiLFxuXHRcdFx0XHRcdFx0XHRzY2FsZTogXCJjc3NcIixcblx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdFx0bWltZVR5cGUgPSBcImltYWdlL3BuZ1wiO1xuXHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRzY3JlZW5zaG90QnVmZmVyID0gYXdhaXQgcC5zY3JlZW5zaG90KHtcblx0XHRcdFx0XHRcdFx0ZnVsbFBhZ2U6IHBhcmFtcy5mdWxsUGFnZSA/PyBmYWxzZSxcblx0XHRcdFx0XHRcdFx0dHlwZTogXCJqcGVnXCIsXG5cdFx0XHRcdFx0XHRcdHF1YWxpdHksXG5cdFx0XHRcdFx0XHRcdHNjYWxlOiBcImNzc1wiLFxuXHRcdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0XHRtaW1lVHlwZSA9IFwiaW1hZ2UvanBlZ1wiO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXG5cdFx0XHRcdHNjcmVlbnNob3RCdWZmZXIgPSBhd2FpdCBkZXBzLmNvbnN0cmFpblNjcmVlbnNob3QocCwgc2NyZWVuc2hvdEJ1ZmZlciwgbWltZVR5cGUsIHF1YWxpdHkpO1xuXG5cdFx0XHRcdGNvbnN0IGJhc2U2NERhdGEgPSBzY3JlZW5zaG90QnVmZmVyLnRvU3RyaW5nKFwiYmFzZTY0XCIpO1xuXHRcdFx0XHRjb25zdCB0aXRsZSA9IGF3YWl0IHAudGl0bGUoKTtcblx0XHRcdFx0Y29uc3QgdXJsID0gcC51cmwoKTtcblx0XHRcdFx0Y29uc3Qgdmlld3BvcnQgPSBwLnZpZXdwb3J0U2l6ZSgpO1xuXHRcdFx0XHRjb25zdCB2cFRleHQgPSB2aWV3cG9ydCA/IGAke3ZpZXdwb3J0LndpZHRofXgke3ZpZXdwb3J0LmhlaWdodH1gIDogXCJ1bmtub3duXCI7XG5cdFx0XHRcdGNvbnN0IHNjb3BlID0gcGFyYW1zLnNlbGVjdG9yID8gYGVsZW1lbnQgXCIke3BhcmFtcy5zZWxlY3Rvcn1cImAgOiBwYXJhbXMuZnVsbFBhZ2UgPyBcImZ1bGwgcGFnZVwiIDogXCJ2aWV3cG9ydFwiO1xuXG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW1xuXHRcdFx0XHRcdFx0e1xuXHRcdFx0XHRcdFx0XHR0eXBlOiBcInRleHRcIixcblx0XHRcdFx0XHRcdFx0dGV4dDogYFNjcmVlbnNob3Qgb2YgJHtzY29wZX0uXFxuUGFnZTogJHt0aXRsZX1cXG5VUkw6ICR7dXJsfVxcblZpZXdwb3J0OiAke3ZwVGV4dH1gLFxuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdFx0dHlwZTogXCJpbWFnZVwiLFxuXHRcdFx0XHRcdFx0XHRkYXRhOiBiYXNlNjREYXRhLFxuXHRcdFx0XHRcdFx0XHRtaW1lVHlwZSxcblx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7IHRpdGxlLCB1cmwsIHNjb3BlLCB2aWV3cG9ydDogdnBUZXh0IH0sXG5cdFx0XHRcdH07XG5cdFx0XHR9IGNhdGNoIChlcnI6IGFueSkge1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgU2NyZWVuc2hvdCBmYWlsZWQ6ICR7ZXJyLm1lc3NhZ2V9YCB9XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7IGVycm9yOiBlcnIubWVzc2FnZSB9LFxuXHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsXG5cdFx0XHRcdH07XG5cdFx0XHR9XG5cdFx0fSxcblx0fSk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFDQSxTQUFTLFlBQVk7QUFFckIsU0FBUyw2QkFBNkIsbUNBQW1DO0FBRWxFLFNBQVMsd0JBQXdCLElBQWtCLE1BQXNCO0FBQy9FLEtBQUcsYUFBYTtBQUFBLElBQ2YsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsYUFDQztBQUFBLElBQ0QsZUFBZSxFQUFFLGdCQUFnQixLQUFLO0FBQUEsSUFDdEMsWUFBWSxLQUFLLE9BQU87QUFBQSxNQUN2QixVQUFVLEtBQUs7QUFBQSxRQUNkLEtBQUssUUFBUSxFQUFFLGFBQWEsb0RBQW9ELENBQUM7QUFBQSxNQUNsRjtBQUFBLE1BQ0EsVUFBVSxLQUFLO0FBQUEsUUFDZCxLQUFLLE9BQU87QUFBQSxVQUNYLGFBQ0M7QUFBQSxRQUNGLENBQUM7QUFBQSxNQUNGO0FBQUEsTUFDQSxTQUFTLEtBQUs7QUFBQSxRQUNiLEtBQUssT0FBTztBQUFBLFVBQ1gsYUFDQztBQUFBLFFBQ0YsQ0FBQztBQUFBLE1BQ0Y7QUFBQSxJQUNELENBQUM7QUFBQSxJQUVELE1BQU0sUUFBUSxhQUFhLFFBQVEsU0FBUyxXQUFXLE1BQU07QUFDNUQsVUFBSTtBQUNILGNBQU0sRUFBRSxNQUFNLEVBQUUsSUFBSSxNQUFNLEtBQUssY0FBYztBQUU3QyxZQUFJO0FBQ0osWUFBSTtBQUNKLGNBQU0saUJBQWlCLDRCQUE0QjtBQUNuRCxjQUFNLFVBQVUsT0FBTyxXQUFXLDRCQUE0QixFQUFFO0FBRWhFLFlBQUksT0FBTyxVQUFVO0FBQ3BCLGdCQUFNLE1BQU0sa0JBQWtCO0FBQzlCLGdCQUFNLFVBQVUsRUFBRSxRQUFRLE9BQU8sUUFBUSxFQUFFLE1BQU07QUFDakQsY0FBSSxRQUFRLFFBQVE7QUFDbkIsK0JBQW1CLE1BQU0sUUFBUSxXQUFXLEVBQUUsTUFBTSxRQUFRLFNBQVMsT0FBTyxNQUFNLENBQUM7QUFDbkYsdUJBQVc7QUFBQSxVQUNaLE9BQU87QUFDTiwrQkFBbUIsTUFBTSxRQUFRLFdBQVcsRUFBRSxNQUFNLE9BQU8sT0FBTyxNQUFNLENBQUM7QUFDekUsdUJBQVc7QUFBQSxVQUNaO0FBQUEsUUFDRCxPQUFPO0FBQ04sZ0JBQU0sTUFBTSxrQkFBa0I7QUFDOUIsY0FBSSxRQUFRLE9BQU87QUFDbEIsK0JBQW1CLE1BQU0sRUFBRSxXQUFXO0FBQUEsY0FDckMsVUFBVSxPQUFPLFlBQVk7QUFBQSxjQUM3QixNQUFNO0FBQUEsY0FDTixPQUFPO0FBQUEsWUFDUixDQUFDO0FBQ0QsdUJBQVc7QUFBQSxVQUNaLE9BQU87QUFDTiwrQkFBbUIsTUFBTSxFQUFFLFdBQVc7QUFBQSxjQUNyQyxVQUFVLE9BQU8sWUFBWTtBQUFBLGNBQzdCLE1BQU07QUFBQSxjQUNOO0FBQUEsY0FDQSxPQUFPO0FBQUEsWUFDUixDQUFDO0FBQ0QsdUJBQVc7QUFBQSxVQUNaO0FBQUEsUUFDRDtBQUVBLDJCQUFtQixNQUFNLEtBQUssb0JBQW9CLEdBQUcsa0JBQWtCLFVBQVUsT0FBTztBQUV4RixjQUFNLGFBQWEsaUJBQWlCLFNBQVMsUUFBUTtBQUNyRCxjQUFNLFFBQVEsTUFBTSxFQUFFLE1BQU07QUFDNUIsY0FBTSxNQUFNLEVBQUUsSUFBSTtBQUNsQixjQUFNLFdBQVcsRUFBRSxhQUFhO0FBQ2hDLGNBQU0sU0FBUyxXQUFXLEdBQUcsU0FBUyxLQUFLLElBQUksU0FBUyxNQUFNLEtBQUs7QUFDbkUsY0FBTSxRQUFRLE9BQU8sV0FBVyxZQUFZLE9BQU8sUUFBUSxNQUFNLE9BQU8sV0FBVyxjQUFjO0FBRWpHLGVBQU87QUFBQSxVQUNOLFNBQVM7QUFBQSxZQUNSO0FBQUEsY0FDQyxNQUFNO0FBQUEsY0FDTixNQUFNLGlCQUFpQixLQUFLO0FBQUEsUUFBWSxLQUFLO0FBQUEsT0FBVSxHQUFHO0FBQUEsWUFBZSxNQUFNO0FBQUEsWUFDaEY7QUFBQSxZQUNBO0FBQUEsY0FDQyxNQUFNO0FBQUEsY0FDTixNQUFNO0FBQUEsY0FDTjtBQUFBLFlBQ0Q7QUFBQSxVQUNEO0FBQUEsVUFDQSxTQUFTLEVBQUUsT0FBTyxLQUFLLE9BQU8sVUFBVSxPQUFPO0FBQUEsUUFDaEQ7QUFBQSxNQUNELFNBQVMsS0FBVTtBQUNsQixlQUFPO0FBQUEsVUFDTixTQUFTLENBQUMsRUFBRSxNQUFNLFFBQVEsTUFBTSxzQkFBc0IsSUFBSSxPQUFPLEdBQUcsQ0FBQztBQUFBLFVBQ3JFLFNBQVMsRUFBRSxPQUFPLElBQUksUUFBUTtBQUFBLFVBQzlCLFNBQVM7QUFBQSxRQUNWO0FBQUEsTUFDRDtBQUFBLElBQ0Q7QUFBQSxFQUNELENBQUM7QUFDRjsiLAogICJuYW1lcyI6IFtdCn0K
