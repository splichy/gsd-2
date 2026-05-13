import { Type } from "@sinclair/typebox";
function registerPdfTools(pi, deps) {
  pi.registerTool({
    name: "browser_save_pdf",
    label: "Browser Save PDF",
    description: "Render current page as PDF artifact via Playwright's page.pdf(). Supports A4/Letter/custom page formats and optional background graphics. Writes to session artifacts directory. Chromium only.",
    parameters: Type.Object({
      filename: Type.Optional(
        Type.String({ description: "Output filename (default: auto-generated from page title + timestamp)." })
      ),
      format: Type.Optional(
        Type.String({
          description: "Page format: 'A4' (default), 'Letter', 'Legal', 'Tabloid', or custom like '8.5in x 11in'. Custom format uses CSS dimension syntax for width x height."
        })
      ),
      printBackground: Type.Optional(
        Type.Boolean({ description: "Include background graphics (default: true)." })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const { page: p } = await deps.ensureBrowser();
        const url = p.url();
        const title = await p.title().catch(() => "untitled");
        const timestamp = deps.formatArtifactTimestamp(Date.now());
        const safeName = deps.sanitizeArtifactName(params.filename || `${title}-${timestamp}`, `pdf-${timestamp}`);
        const filename = safeName.endsWith(".pdf") ? safeName : `${safeName}.pdf`;
        const knownFormats = /* @__PURE__ */ new Set(["A4", "Letter", "Legal", "Tabloid", "Ledger", "A0", "A1", "A2", "A3", "A5", "A6"]);
        const formatInput = params.format ?? "A4";
        let pdfOptions = {};
        if (knownFormats.has(formatInput)) {
          pdfOptions.format = formatInput;
        } else {
          const customMatch = formatInput.match(/^(.+?)\s*[xX×]\s*(.+)$/);
          if (customMatch) {
            pdfOptions.width = customMatch[1].trim();
            pdfOptions.height = customMatch[2].trim();
          } else {
            pdfOptions.format = "A4";
          }
        }
        pdfOptions.printBackground = params.printBackground ?? true;
        await deps.ensureSessionArtifactDir();
        const outputPath = deps.buildSessionArtifactPath(filename);
        pdfOptions.path = outputPath;
        await p.pdf(pdfOptions);
        const { stat } = await import("node:fs/promises");
        const fileStat = await stat(outputPath);
        const sizeBytes = fileStat.size;
        const sizeKB = (sizeBytes / 1024).toFixed(1);
        return {
          content: [
            {
              type: "text",
              text: `PDF saved: ${outputPath}
Size: ${sizeKB} KB
Format: ${formatInput}
Page: ${title}
URL: ${url}`
            }
          ],
          details: { path: outputPath, sizeBytes, format: formatInput, pageUrl: url, pageTitle: title }
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `PDF generation failed: ${err.message}` }],
          details: { error: err.message },
          isError: true
        };
      }
    }
  });
}
export {
  registerPdfTools
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2Jyb3dzZXItdG9vbHMvdG9vbHMvcGRmLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdHlwZSB7IEV4dGVuc2lvbkFQSSB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuaW1wb3J0IHsgVHlwZSB9IGZyb20gXCJAc2luY2xhaXIvdHlwZWJveFwiO1xuaW1wb3J0IHR5cGUgeyBUb29sRGVwcyB9IGZyb20gXCIuLi9zdGF0ZS5qc1wiO1xuXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJQZGZUb29scyhwaTogRXh0ZW5zaW9uQVBJLCBkZXBzOiBUb29sRGVwcyk6IHZvaWQge1xuXHRwaS5yZWdpc3RlclRvb2woe1xuXHRcdG5hbWU6IFwiYnJvd3Nlcl9zYXZlX3BkZlwiLFxuXHRcdGxhYmVsOiBcIkJyb3dzZXIgU2F2ZSBQREZcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiUmVuZGVyIGN1cnJlbnQgcGFnZSBhcyBQREYgYXJ0aWZhY3QgdmlhIFBsYXl3cmlnaHQncyBwYWdlLnBkZigpLiBcIiArXG5cdFx0XHRcIlN1cHBvcnRzIEE0L0xldHRlci9jdXN0b20gcGFnZSBmb3JtYXRzIGFuZCBvcHRpb25hbCBiYWNrZ3JvdW5kIGdyYXBoaWNzLiBcIiArXG5cdFx0XHRcIldyaXRlcyB0byBzZXNzaW9uIGFydGlmYWN0cyBkaXJlY3RvcnkuIENocm9taXVtIG9ubHkuXCIsXG5cdFx0cGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe1xuXHRcdFx0ZmlsZW5hbWU6IFR5cGUuT3B0aW9uYWwoXG5cdFx0XHRcdFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiT3V0cHV0IGZpbGVuYW1lIChkZWZhdWx0OiBhdXRvLWdlbmVyYXRlZCBmcm9tIHBhZ2UgdGl0bGUgKyB0aW1lc3RhbXApLlwiIH0pLFxuXHRcdFx0KSxcblx0XHRcdGZvcm1hdDogVHlwZS5PcHRpb25hbChcblx0XHRcdFx0VHlwZS5TdHJpbmcoe1xuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOlxuXHRcdFx0XHRcdFx0XCJQYWdlIGZvcm1hdDogJ0E0JyAoZGVmYXVsdCksICdMZXR0ZXInLCAnTGVnYWwnLCAnVGFibG9pZCcsIG9yIGN1c3RvbSBsaWtlICc4LjVpbiB4IDExaW4nLiBcIiArXG5cdFx0XHRcdFx0XHRcIkN1c3RvbSBmb3JtYXQgdXNlcyBDU1MgZGltZW5zaW9uIHN5bnRheCBmb3Igd2lkdGggeCBoZWlnaHQuXCIsXG5cdFx0XHRcdH0pLFxuXHRcdFx0KSxcblx0XHRcdHByaW50QmFja2dyb3VuZDogVHlwZS5PcHRpb25hbChcblx0XHRcdFx0VHlwZS5Cb29sZWFuKHsgZGVzY3JpcHRpb246IFwiSW5jbHVkZSBiYWNrZ3JvdW5kIGdyYXBoaWNzIChkZWZhdWx0OiB0cnVlKS5cIiB9KSxcblx0XHRcdCksXG5cdFx0fSksXG5cblx0XHRhc3luYyBleGVjdXRlKF90b29sQ2FsbElkLCBwYXJhbXMsIF9zaWduYWwsIF9vblVwZGF0ZSwgX2N0eCkge1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0Y29uc3QgeyBwYWdlOiBwIH0gPSBhd2FpdCBkZXBzLmVuc3VyZUJyb3dzZXIoKTtcblxuXHRcdFx0XHRjb25zdCB1cmwgPSBwLnVybCgpO1xuXHRcdFx0XHRjb25zdCB0aXRsZSA9IGF3YWl0IHAudGl0bGUoKS5jYXRjaCgoKSA9PiBcInVudGl0bGVkXCIpO1xuXG5cdFx0XHRcdC8vIFJlc29sdmUgZmlsZW5hbWVcblx0XHRcdFx0Y29uc3QgdGltZXN0YW1wID0gZGVwcy5mb3JtYXRBcnRpZmFjdFRpbWVzdGFtcChEYXRlLm5vdygpKTtcblx0XHRcdFx0Y29uc3Qgc2FmZU5hbWUgPSBkZXBzLnNhbml0aXplQXJ0aWZhY3ROYW1lKHBhcmFtcy5maWxlbmFtZSB8fCBgJHt0aXRsZX0tJHt0aW1lc3RhbXB9YCwgYHBkZi0ke3RpbWVzdGFtcH1gKTtcblx0XHRcdFx0Y29uc3QgZmlsZW5hbWUgPSBzYWZlTmFtZS5lbmRzV2l0aChcIi5wZGZcIikgPyBzYWZlTmFtZSA6IGAke3NhZmVOYW1lfS5wZGZgO1xuXG5cdFx0XHRcdC8vIFJlc29sdmUgZm9ybWF0XG5cdFx0XHRcdGNvbnN0IGtub3duRm9ybWF0cyA9IG5ldyBTZXQoW1wiQTRcIiwgXCJMZXR0ZXJcIiwgXCJMZWdhbFwiLCBcIlRhYmxvaWRcIiwgXCJMZWRnZXJcIiwgXCJBMFwiLCBcIkExXCIsIFwiQTJcIiwgXCJBM1wiLCBcIkE1XCIsIFwiQTZcIl0pO1xuXHRcdFx0XHRjb25zdCBmb3JtYXRJbnB1dCA9IHBhcmFtcy5mb3JtYXQgPz8gXCJBNFwiO1xuXHRcdFx0XHRsZXQgcGRmT3B0aW9uczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcblxuXHRcdFx0XHRpZiAoa25vd25Gb3JtYXRzLmhhcyhmb3JtYXRJbnB1dCkpIHtcblx0XHRcdFx0XHRwZGZPcHRpb25zLmZvcm1hdCA9IGZvcm1hdElucHV0O1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdC8vIEN1c3RvbSBmb3JtYXQ6IHBhcnNlIFwiV0lEVEhpbiB4IEhFSUdIVGluXCIgb3IgXCJXSURUSGNtIHggSEVJR0hUY21cIiBldGMuXG5cdFx0XHRcdFx0Y29uc3QgY3VzdG9tTWF0Y2ggPSBmb3JtYXRJbnB1dC5tYXRjaCgvXiguKz8pXFxzKlt4WFx1MDBEN11cXHMqKC4rKSQvKTtcblx0XHRcdFx0XHRpZiAoY3VzdG9tTWF0Y2gpIHtcblx0XHRcdFx0XHRcdHBkZk9wdGlvbnMud2lkdGggPSBjdXN0b21NYXRjaFsxXSEudHJpbSgpO1xuXHRcdFx0XHRcdFx0cGRmT3B0aW9ucy5oZWlnaHQgPSBjdXN0b21NYXRjaFsyXSEudHJpbSgpO1xuXHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRwZGZPcHRpb25zLmZvcm1hdCA9IFwiQTRcIjsgLy8gZmFsbGJhY2tcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRwZGZPcHRpb25zLnByaW50QmFja2dyb3VuZCA9IHBhcmFtcy5wcmludEJhY2tncm91bmQgPz8gdHJ1ZTtcblxuXHRcdFx0XHQvLyBHZW5lcmF0ZSBQREZcblx0XHRcdFx0YXdhaXQgZGVwcy5lbnN1cmVTZXNzaW9uQXJ0aWZhY3REaXIoKTtcblx0XHRcdFx0Y29uc3Qgb3V0cHV0UGF0aCA9IGRlcHMuYnVpbGRTZXNzaW9uQXJ0aWZhY3RQYXRoKGZpbGVuYW1lKTtcblx0XHRcdFx0cGRmT3B0aW9ucy5wYXRoID0gb3V0cHV0UGF0aDtcblxuXHRcdFx0XHRhd2FpdCBwLnBkZihwZGZPcHRpb25zIGFzIGFueSk7XG5cblx0XHRcdFx0Ly8gUmVhZCBmaWxlIHNpemVcblx0XHRcdFx0Y29uc3QgeyBzdGF0IH0gPSBhd2FpdCBpbXBvcnQoXCJub2RlOmZzL3Byb21pc2VzXCIpO1xuXHRcdFx0XHRjb25zdCBmaWxlU3RhdCA9IGF3YWl0IHN0YXQob3V0cHV0UGF0aCk7XG5cdFx0XHRcdGNvbnN0IHNpemVCeXRlcyA9IGZpbGVTdGF0LnNpemU7XG5cdFx0XHRcdGNvbnN0IHNpemVLQiA9IChzaXplQnl0ZXMgLyAxMDI0KS50b0ZpeGVkKDEpO1xuXG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW1xuXHRcdFx0XHRcdFx0e1xuXHRcdFx0XHRcdFx0XHR0eXBlOiBcInRleHRcIixcblx0XHRcdFx0XHRcdFx0dGV4dDogYFBERiBzYXZlZDogJHtvdXRwdXRQYXRofVxcblNpemU6ICR7c2l6ZUtCfSBLQlxcbkZvcm1hdDogJHtmb3JtYXRJbnB1dH1cXG5QYWdlOiAke3RpdGxlfVxcblVSTDogJHt1cmx9YCxcblx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7IHBhdGg6IG91dHB1dFBhdGgsIHNpemVCeXRlcywgZm9ybWF0OiBmb3JtYXRJbnB1dCwgcGFnZVVybDogdXJsLCBwYWdlVGl0bGU6IHRpdGxlIH0sXG5cdFx0XHRcdH07XG5cdFx0XHR9IGNhdGNoIChlcnI6IGFueSkge1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgUERGIGdlbmVyYXRpb24gZmFpbGVkOiAke2Vyci5tZXNzYWdlfWAgfV0sXG5cdFx0XHRcdFx0ZGV0YWlsczogeyBlcnJvcjogZXJyLm1lc3NhZ2UgfSxcblx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHR9O1xuXHRcdFx0fVxuXHRcdH0sXG5cdH0pO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQ0EsU0FBUyxZQUFZO0FBR2QsU0FBUyxpQkFBaUIsSUFBa0IsTUFBc0I7QUFDeEUsS0FBRyxhQUFhO0FBQUEsSUFDZixNQUFNO0FBQUEsSUFDTixPQUFPO0FBQUEsSUFDUCxhQUNDO0FBQUEsSUFHRCxZQUFZLEtBQUssT0FBTztBQUFBLE1BQ3ZCLFVBQVUsS0FBSztBQUFBLFFBQ2QsS0FBSyxPQUFPLEVBQUUsYUFBYSx5RUFBeUUsQ0FBQztBQUFBLE1BQ3RHO0FBQUEsTUFDQSxRQUFRLEtBQUs7QUFBQSxRQUNaLEtBQUssT0FBTztBQUFBLFVBQ1gsYUFDQztBQUFBLFFBRUYsQ0FBQztBQUFBLE1BQ0Y7QUFBQSxNQUNBLGlCQUFpQixLQUFLO0FBQUEsUUFDckIsS0FBSyxRQUFRLEVBQUUsYUFBYSwrQ0FBK0MsQ0FBQztBQUFBLE1BQzdFO0FBQUEsSUFDRCxDQUFDO0FBQUEsSUFFRCxNQUFNLFFBQVEsYUFBYSxRQUFRLFNBQVMsV0FBVyxNQUFNO0FBQzVELFVBQUk7QUFDSCxjQUFNLEVBQUUsTUFBTSxFQUFFLElBQUksTUFBTSxLQUFLLGNBQWM7QUFFN0MsY0FBTSxNQUFNLEVBQUUsSUFBSTtBQUNsQixjQUFNLFFBQVEsTUFBTSxFQUFFLE1BQU0sRUFBRSxNQUFNLE1BQU0sVUFBVTtBQUdwRCxjQUFNLFlBQVksS0FBSyx3QkFBd0IsS0FBSyxJQUFJLENBQUM7QUFDekQsY0FBTSxXQUFXLEtBQUsscUJBQXFCLE9BQU8sWUFBWSxHQUFHLEtBQUssSUFBSSxTQUFTLElBQUksT0FBTyxTQUFTLEVBQUU7QUFDekcsY0FBTSxXQUFXLFNBQVMsU0FBUyxNQUFNLElBQUksV0FBVyxHQUFHLFFBQVE7QUFHbkUsY0FBTSxlQUFlLG9CQUFJLElBQUksQ0FBQyxNQUFNLFVBQVUsU0FBUyxXQUFXLFVBQVUsTUFBTSxNQUFNLE1BQU0sTUFBTSxNQUFNLElBQUksQ0FBQztBQUMvRyxjQUFNLGNBQWMsT0FBTyxVQUFVO0FBQ3JDLFlBQUksYUFBc0MsQ0FBQztBQUUzQyxZQUFJLGFBQWEsSUFBSSxXQUFXLEdBQUc7QUFDbEMscUJBQVcsU0FBUztBQUFBLFFBQ3JCLE9BQU87QUFFTixnQkFBTSxjQUFjLFlBQVksTUFBTSx3QkFBd0I7QUFDOUQsY0FBSSxhQUFhO0FBQ2hCLHVCQUFXLFFBQVEsWUFBWSxDQUFDLEVBQUcsS0FBSztBQUN4Qyx1QkFBVyxTQUFTLFlBQVksQ0FBQyxFQUFHLEtBQUs7QUFBQSxVQUMxQyxPQUFPO0FBQ04sdUJBQVcsU0FBUztBQUFBLFVBQ3JCO0FBQUEsUUFDRDtBQUVBLG1CQUFXLGtCQUFrQixPQUFPLG1CQUFtQjtBQUd2RCxjQUFNLEtBQUsseUJBQXlCO0FBQ3BDLGNBQU0sYUFBYSxLQUFLLHlCQUF5QixRQUFRO0FBQ3pELG1CQUFXLE9BQU87QUFFbEIsY0FBTSxFQUFFLElBQUksVUFBaUI7QUFHN0IsY0FBTSxFQUFFLEtBQUssSUFBSSxNQUFNLE9BQU8sa0JBQWtCO0FBQ2hELGNBQU0sV0FBVyxNQUFNLEtBQUssVUFBVTtBQUN0QyxjQUFNLFlBQVksU0FBUztBQUMzQixjQUFNLFVBQVUsWUFBWSxNQUFNLFFBQVEsQ0FBQztBQUUzQyxlQUFPO0FBQUEsVUFDTixTQUFTO0FBQUEsWUFDUjtBQUFBLGNBQ0MsTUFBTTtBQUFBLGNBQ04sTUFBTSxjQUFjLFVBQVU7QUFBQSxRQUFXLE1BQU07QUFBQSxVQUFnQixXQUFXO0FBQUEsUUFBVyxLQUFLO0FBQUEsT0FBVSxHQUFHO0FBQUEsWUFDeEc7QUFBQSxVQUNEO0FBQUEsVUFDQSxTQUFTLEVBQUUsTUFBTSxZQUFZLFdBQVcsUUFBUSxhQUFhLFNBQVMsS0FBSyxXQUFXLE1BQU07QUFBQSxRQUM3RjtBQUFBLE1BQ0QsU0FBUyxLQUFVO0FBQ2xCLGVBQU87QUFBQSxVQUNOLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBUSxNQUFNLDBCQUEwQixJQUFJLE9BQU8sR0FBRyxDQUFDO0FBQUEsVUFDekUsU0FBUyxFQUFFLE9BQU8sSUFBSSxRQUFRO0FBQUEsVUFDOUIsU0FBUztBQUFBLFFBQ1Y7QUFBQSxNQUNEO0FBQUEsSUFDRDtBQUFBLEVBQ0QsQ0FBQztBQUNGOyIsCiAgIm5hbWVzIjogW10KfQo=
