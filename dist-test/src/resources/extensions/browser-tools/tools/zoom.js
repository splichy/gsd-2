import { Type } from "@sinclair/typebox";
function registerZoomTools(pi, deps) {
  pi.registerTool({
    name: "browser_zoom_region",
    label: "Browser Zoom Region",
    description: "Capture and optionally upscale a specific rectangular region of the page for detailed inspection. Useful for dense UIs where full-page screenshots have text too small to read. Returns the region as an inline image, same as browser_screenshot.",
    compatibility: { producesImages: true },
    parameters: Type.Object({
      x: Type.Number({ description: "Left coordinate of the region in CSS pixels." }),
      y: Type.Number({ description: "Top coordinate of the region in CSS pixels." }),
      width: Type.Number({ description: "Width of the region in CSS pixels." }),
      height: Type.Number({ description: "Height of the region in CSS pixels." }),
      scale: Type.Optional(
        Type.Number({
          description: "Upscale factor (default: 2). Use 1 for native resolution, 2-4 for zoomed detail."
        })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const { page: p } = await deps.ensureBrowser();
        const { x, y, width, height } = params;
        const scale = params.scale ?? 2;
        if (width <= 0 || height <= 0) {
          return {
            content: [{ type: "text", text: "Width and height must be positive." }],
            details: { error: "invalid_dimensions" },
            isError: true
          };
        }
        const regionBuffer = await p.screenshot({
          type: "png",
          clip: { x, y, width, height }
        });
        let outputBuffer = regionBuffer;
        let outputMime = "image/png";
        if (scale > 1) {
          const sharp = (await import("sharp")).default;
          const targetWidth = Math.round(width * scale);
          const targetHeight = Math.round(height * scale);
          outputBuffer = await sharp(regionBuffer).resize(targetWidth, targetHeight, {
            kernel: "lanczos3",
            fit: "fill"
          }).png().toBuffer();
        }
        const base64Data = outputBuffer.toString("base64");
        const title = await p.title();
        const url = p.url();
        return {
          content: [
            {
              type: "text",
              text: `Region capture: ${width}x${height} at (${x},${y})${scale > 1 ? ` upscaled ${scale}x to ${Math.round(width * scale)}x${Math.round(height * scale)}` : ""}
Page: ${title}
URL: ${url}`
            },
            {
              type: "image",
              data: base64Data,
              mimeType: outputMime
            }
          ],
          details: {
            region: { x, y, width, height },
            scale,
            outputDimensions: {
              width: Math.round(width * scale),
              height: Math.round(height * scale)
            },
            title,
            url
          }
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Region zoom failed: ${err.message}` }],
          details: { error: err.message },
          isError: true
        };
      }
    }
  });
}
export {
  registerZoomTools
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2Jyb3dzZXItdG9vbHMvdG9vbHMvem9vbS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHR5cGUgeyBFeHRlbnNpb25BUEkgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7IFR5cGUgfSBmcm9tIFwiQHNpbmNsYWlyL3R5cGVib3hcIjtcbmltcG9ydCB0eXBlIHsgVG9vbERlcHMgfSBmcm9tIFwiLi4vc3RhdGUuanNcIjtcblxuLyoqXG4gKiBSZWdpb24gem9vbSAvIGhpZ2gtcmVzIGNhcHR1cmUgXHUyMDE0IGNhcHR1cmUgYW5kIHVwc2NhbGUgc3BlY2lmaWMgcGFnZSByZWdpb25zLlxuICovXG5cbmV4cG9ydCBmdW5jdGlvbiByZWdpc3Rlclpvb21Ub29scyhwaTogRXh0ZW5zaW9uQVBJLCBkZXBzOiBUb29sRGVwcyk6IHZvaWQge1xuXHRwaS5yZWdpc3RlclRvb2woe1xuXHRcdG5hbWU6IFwiYnJvd3Nlcl96b29tX3JlZ2lvblwiLFxuXHRcdGxhYmVsOiBcIkJyb3dzZXIgWm9vbSBSZWdpb25cIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiQ2FwdHVyZSBhbmQgb3B0aW9uYWxseSB1cHNjYWxlIGEgc3BlY2lmaWMgcmVjdGFuZ3VsYXIgcmVnaW9uIG9mIHRoZSBwYWdlIGZvciBkZXRhaWxlZCBpbnNwZWN0aW9uLiBcIiArXG5cdFx0XHRcIlVzZWZ1bCBmb3IgZGVuc2UgVUlzIHdoZXJlIGZ1bGwtcGFnZSBzY3JlZW5zaG90cyBoYXZlIHRleHQgdG9vIHNtYWxsIHRvIHJlYWQuIFwiICtcblx0XHRcdFwiUmV0dXJucyB0aGUgcmVnaW9uIGFzIGFuIGlubGluZSBpbWFnZSwgc2FtZSBhcyBicm93c2VyX3NjcmVlbnNob3QuXCIsXG5cdFx0Y29tcGF0aWJpbGl0eTogeyBwcm9kdWNlc0ltYWdlczogdHJ1ZSB9LFxuXHRcdHBhcmFtZXRlcnM6IFR5cGUuT2JqZWN0KHtcblx0XHRcdHg6IFR5cGUuTnVtYmVyKHsgZGVzY3JpcHRpb246IFwiTGVmdCBjb29yZGluYXRlIG9mIHRoZSByZWdpb24gaW4gQ1NTIHBpeGVscy5cIiB9KSxcblx0XHRcdHk6IFR5cGUuTnVtYmVyKHsgZGVzY3JpcHRpb246IFwiVG9wIGNvb3JkaW5hdGUgb2YgdGhlIHJlZ2lvbiBpbiBDU1MgcGl4ZWxzLlwiIH0pLFxuXHRcdFx0d2lkdGg6IFR5cGUuTnVtYmVyKHsgZGVzY3JpcHRpb246IFwiV2lkdGggb2YgdGhlIHJlZ2lvbiBpbiBDU1MgcGl4ZWxzLlwiIH0pLFxuXHRcdFx0aGVpZ2h0OiBUeXBlLk51bWJlcih7IGRlc2NyaXB0aW9uOiBcIkhlaWdodCBvZiB0aGUgcmVnaW9uIGluIENTUyBwaXhlbHMuXCIgfSksXG5cdFx0XHRzY2FsZTogVHlwZS5PcHRpb25hbChcblx0XHRcdFx0VHlwZS5OdW1iZXIoe1xuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOiBcIlVwc2NhbGUgZmFjdG9yIChkZWZhdWx0OiAyKS4gVXNlIDEgZm9yIG5hdGl2ZSByZXNvbHV0aW9uLCAyLTQgZm9yIHpvb21lZCBkZXRhaWwuXCIsXG5cdFx0XHRcdH0pLFxuXHRcdFx0KSxcblx0XHR9KSxcblxuXHRcdGFzeW5jIGV4ZWN1dGUoX3Rvb2xDYWxsSWQsIHBhcmFtcywgX3NpZ25hbCwgX29uVXBkYXRlLCBfY3R4KSB7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCB7IHBhZ2U6IHAgfSA9IGF3YWl0IGRlcHMuZW5zdXJlQnJvd3NlcigpO1xuXHRcdFx0XHRjb25zdCB7IHgsIHksIHdpZHRoLCBoZWlnaHQgfSA9IHBhcmFtcztcblx0XHRcdFx0Y29uc3Qgc2NhbGUgPSBwYXJhbXMuc2NhbGUgPz8gMjtcblxuXHRcdFx0XHQvLyBWYWxpZGF0ZSBkaW1lbnNpb25zXG5cdFx0XHRcdGlmICh3aWR0aCA8PSAwIHx8IGhlaWdodCA8PSAwKSB7XG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIldpZHRoIGFuZCBoZWlnaHQgbXVzdCBiZSBwb3NpdGl2ZS5cIiB9XSxcblx0XHRcdFx0XHRcdGRldGFpbHM6IHsgZXJyb3I6IFwiaW52YWxpZF9kaW1lbnNpb25zXCIgfSxcblx0XHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsXG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdC8vIENhcHR1cmUgdGhlIHJlZ2lvbiB1c2luZyBQbGF5d3JpZ2h0J3MgY2xpcCBvcHRpb25cblx0XHRcdFx0Y29uc3QgcmVnaW9uQnVmZmVyID0gYXdhaXQgcC5zY3JlZW5zaG90KHtcblx0XHRcdFx0XHR0eXBlOiBcInBuZ1wiLFxuXHRcdFx0XHRcdGNsaXA6IHsgeCwgeSwgd2lkdGgsIGhlaWdodCB9LFxuXHRcdFx0XHR9KTtcblxuXHRcdFx0XHRsZXQgb3V0cHV0QnVmZmVyOiBCdWZmZXIgPSByZWdpb25CdWZmZXI7XG5cdFx0XHRcdGxldCBvdXRwdXRNaW1lID0gXCJpbWFnZS9wbmdcIjtcblxuXHRcdFx0XHQvLyBVcHNjYWxlIGlmIHNjYWxlID4gMVxuXHRcdFx0XHRpZiAoc2NhbGUgPiAxKSB7XG5cdFx0XHRcdFx0Y29uc3Qgc2hhcnAgPSAoYXdhaXQgaW1wb3J0KFwic2hhcnBcIikpLmRlZmF1bHQ7XG5cdFx0XHRcdFx0Y29uc3QgdGFyZ2V0V2lkdGggPSBNYXRoLnJvdW5kKHdpZHRoICogc2NhbGUpO1xuXHRcdFx0XHRcdGNvbnN0IHRhcmdldEhlaWdodCA9IE1hdGgucm91bmQoaGVpZ2h0ICogc2NhbGUpO1xuXG5cdFx0XHRcdFx0b3V0cHV0QnVmZmVyID0gYXdhaXQgc2hhcnAocmVnaW9uQnVmZmVyKVxuXHRcdFx0XHRcdFx0LnJlc2l6ZSh0YXJnZXRXaWR0aCwgdGFyZ2V0SGVpZ2h0LCB7XG5cdFx0XHRcdFx0XHRcdGtlcm5lbDogXCJsYW5jem9zM1wiLFxuXHRcdFx0XHRcdFx0XHRmaXQ6IFwiZmlsbFwiLFxuXHRcdFx0XHRcdFx0fSlcblx0XHRcdFx0XHRcdC5wbmcoKVxuXHRcdFx0XHRcdFx0LnRvQnVmZmVyKCk7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRjb25zdCBiYXNlNjREYXRhID0gb3V0cHV0QnVmZmVyLnRvU3RyaW5nKFwiYmFzZTY0XCIpO1xuXHRcdFx0XHRjb25zdCB0aXRsZSA9IGF3YWl0IHAudGl0bGUoKTtcblx0XHRcdFx0Y29uc3QgdXJsID0gcC51cmwoKTtcblxuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFtcblx0XHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdFx0dHlwZTogXCJ0ZXh0XCIsXG5cdFx0XHRcdFx0XHRcdHRleHQ6IGBSZWdpb24gY2FwdHVyZTogJHt3aWR0aH14JHtoZWlnaHR9IGF0ICgke3h9LCR7eX0pJHtzY2FsZSA+IDEgPyBgIHVwc2NhbGVkICR7c2NhbGV9eCB0byAke01hdGgucm91bmQod2lkdGggKiBzY2FsZSl9eCR7TWF0aC5yb3VuZChoZWlnaHQgKiBzY2FsZSl9YCA6IFwiXCJ9XFxuUGFnZTogJHt0aXRsZX1cXG5VUkw6ICR7dXJsfWAsXG5cdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdFx0e1xuXHRcdFx0XHRcdFx0XHR0eXBlOiBcImltYWdlXCIsXG5cdFx0XHRcdFx0XHRcdGRhdGE6IGJhc2U2NERhdGEsXG5cdFx0XHRcdFx0XHRcdG1pbWVUeXBlOiBvdXRwdXRNaW1lLFxuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRdLFxuXHRcdFx0XHRcdGRldGFpbHM6IHtcblx0XHRcdFx0XHRcdHJlZ2lvbjogeyB4LCB5LCB3aWR0aCwgaGVpZ2h0IH0sXG5cdFx0XHRcdFx0XHRzY2FsZSxcblx0XHRcdFx0XHRcdG91dHB1dERpbWVuc2lvbnM6IHtcblx0XHRcdFx0XHRcdFx0d2lkdGg6IE1hdGgucm91bmQod2lkdGggKiBzY2FsZSksXG5cdFx0XHRcdFx0XHRcdGhlaWdodDogTWF0aC5yb3VuZChoZWlnaHQgKiBzY2FsZSksXG5cdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdFx0dGl0bGUsXG5cdFx0XHRcdFx0XHR1cmwsXG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0fTtcblx0XHRcdH0gY2F0Y2ggKGVycjogYW55KSB7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBSZWdpb24gem9vbSBmYWlsZWQ6ICR7ZXJyLm1lc3NhZ2V9YCB9XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7IGVycm9yOiBlcnIubWVzc2FnZSB9LFxuXHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsXG5cdFx0XHRcdH07XG5cdFx0XHR9XG5cdFx0fSxcblx0fSk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFDQSxTQUFTLFlBQVk7QUFPZCxTQUFTLGtCQUFrQixJQUFrQixNQUFzQjtBQUN6RSxLQUFHLGFBQWE7QUFBQSxJQUNmLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLGFBQ0M7QUFBQSxJQUdELGVBQWUsRUFBRSxnQkFBZ0IsS0FBSztBQUFBLElBQ3RDLFlBQVksS0FBSyxPQUFPO0FBQUEsTUFDdkIsR0FBRyxLQUFLLE9BQU8sRUFBRSxhQUFhLCtDQUErQyxDQUFDO0FBQUEsTUFDOUUsR0FBRyxLQUFLLE9BQU8sRUFBRSxhQUFhLDhDQUE4QyxDQUFDO0FBQUEsTUFDN0UsT0FBTyxLQUFLLE9BQU8sRUFBRSxhQUFhLHFDQUFxQyxDQUFDO0FBQUEsTUFDeEUsUUFBUSxLQUFLLE9BQU8sRUFBRSxhQUFhLHNDQUFzQyxDQUFDO0FBQUEsTUFDMUUsT0FBTyxLQUFLO0FBQUEsUUFDWCxLQUFLLE9BQU87QUFBQSxVQUNYLGFBQWE7QUFBQSxRQUNkLENBQUM7QUFBQSxNQUNGO0FBQUEsSUFDRCxDQUFDO0FBQUEsSUFFRCxNQUFNLFFBQVEsYUFBYSxRQUFRLFNBQVMsV0FBVyxNQUFNO0FBQzVELFVBQUk7QUFDSCxjQUFNLEVBQUUsTUFBTSxFQUFFLElBQUksTUFBTSxLQUFLLGNBQWM7QUFDN0MsY0FBTSxFQUFFLEdBQUcsR0FBRyxPQUFPLE9BQU8sSUFBSTtBQUNoQyxjQUFNLFFBQVEsT0FBTyxTQUFTO0FBRzlCLFlBQUksU0FBUyxLQUFLLFVBQVUsR0FBRztBQUM5QixpQkFBTztBQUFBLFlBQ04sU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFRLE1BQU0scUNBQXFDLENBQUM7QUFBQSxZQUN0RSxTQUFTLEVBQUUsT0FBTyxxQkFBcUI7QUFBQSxZQUN2QyxTQUFTO0FBQUEsVUFDVjtBQUFBLFFBQ0Q7QUFHQSxjQUFNLGVBQWUsTUFBTSxFQUFFLFdBQVc7QUFBQSxVQUN2QyxNQUFNO0FBQUEsVUFDTixNQUFNLEVBQUUsR0FBRyxHQUFHLE9BQU8sT0FBTztBQUFBLFFBQzdCLENBQUM7QUFFRCxZQUFJLGVBQXVCO0FBQzNCLFlBQUksYUFBYTtBQUdqQixZQUFJLFFBQVEsR0FBRztBQUNkLGdCQUFNLFNBQVMsTUFBTSxPQUFPLE9BQU8sR0FBRztBQUN0QyxnQkFBTSxjQUFjLEtBQUssTUFBTSxRQUFRLEtBQUs7QUFDNUMsZ0JBQU0sZUFBZSxLQUFLLE1BQU0sU0FBUyxLQUFLO0FBRTlDLHlCQUFlLE1BQU0sTUFBTSxZQUFZLEVBQ3JDLE9BQU8sYUFBYSxjQUFjO0FBQUEsWUFDbEMsUUFBUTtBQUFBLFlBQ1IsS0FBSztBQUFBLFVBQ04sQ0FBQyxFQUNBLElBQUksRUFDSixTQUFTO0FBQUEsUUFDWjtBQUVBLGNBQU0sYUFBYSxhQUFhLFNBQVMsUUFBUTtBQUNqRCxjQUFNLFFBQVEsTUFBTSxFQUFFLE1BQU07QUFDNUIsY0FBTSxNQUFNLEVBQUUsSUFBSTtBQUVsQixlQUFPO0FBQUEsVUFDTixTQUFTO0FBQUEsWUFDUjtBQUFBLGNBQ0MsTUFBTTtBQUFBLGNBQ04sTUFBTSxtQkFBbUIsS0FBSyxJQUFJLE1BQU0sUUFBUSxDQUFDLElBQUksQ0FBQyxJQUFJLFFBQVEsSUFBSSxhQUFhLEtBQUssUUFBUSxLQUFLLE1BQU0sUUFBUSxLQUFLLENBQUMsSUFBSSxLQUFLLE1BQU0sU0FBUyxLQUFLLENBQUMsS0FBSyxFQUFFO0FBQUEsUUFBVyxLQUFLO0FBQUEsT0FBVSxHQUFHO0FBQUEsWUFDNUw7QUFBQSxZQUNBO0FBQUEsY0FDQyxNQUFNO0FBQUEsY0FDTixNQUFNO0FBQUEsY0FDTixVQUFVO0FBQUEsWUFDWDtBQUFBLFVBQ0Q7QUFBQSxVQUNBLFNBQVM7QUFBQSxZQUNSLFFBQVEsRUFBRSxHQUFHLEdBQUcsT0FBTyxPQUFPO0FBQUEsWUFDOUI7QUFBQSxZQUNBLGtCQUFrQjtBQUFBLGNBQ2pCLE9BQU8sS0FBSyxNQUFNLFFBQVEsS0FBSztBQUFBLGNBQy9CLFFBQVEsS0FBSyxNQUFNLFNBQVMsS0FBSztBQUFBLFlBQ2xDO0FBQUEsWUFDQTtBQUFBLFlBQ0E7QUFBQSxVQUNEO0FBQUEsUUFDRDtBQUFBLE1BQ0QsU0FBUyxLQUFVO0FBQ2xCLGVBQU87QUFBQSxVQUNOLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBUSxNQUFNLHVCQUF1QixJQUFJLE9BQU8sR0FBRyxDQUFDO0FBQUEsVUFDdEUsU0FBUyxFQUFFLE9BQU8sSUFBSSxRQUFRO0FBQUEsVUFDOUIsU0FBUztBQUFBLFFBQ1Y7QUFBQSxNQUNEO0FBQUEsSUFDRDtBQUFBLEVBQ0QsQ0FBQztBQUNGOyIsCiAgIm5hbWVzIjogW10KfQo=
