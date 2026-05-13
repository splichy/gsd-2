import { Type } from "@sinclair/typebox";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile } from "fs/promises";
import { formatDimensionNote, resizeImage } from "../../utils/image-resize.js";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.js";
import { resolveReadPath } from "./path-utils.js";
import { createReadFileTarget } from "./tool-target.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "./truncate.js";
const readSchema = Type.Object({
  path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
  offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" }))
});
const defaultReadOperations = {
  readFile: (path) => fsReadFile(path),
  access: (path) => fsAccess(path, constants.R_OK),
  detectImageMimeType: detectSupportedImageMimeTypeFromFile
};
function createReadTool(cwd, options) {
  const autoResizeImages = options?.autoResizeImages ?? true;
  const ops = options?.operations ?? defaultReadOperations;
  return {
    name: "read",
    label: "read",
    description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    parameters: readSchema,
    execute: async (_toolCallId, { path, offset, limit }, signal) => {
      const absolutePath = resolveReadPath(path, cwd);
      const target = createReadFileTarget(path, absolutePath, offset, limit);
      return new Promise(
        (resolve, reject) => {
          if (signal?.aborted) {
            reject(new Error("Operation aborted"));
            return;
          }
          let aborted = false;
          const onAbort = () => {
            aborted = true;
            reject(new Error("Operation aborted"));
          };
          if (signal) {
            signal.addEventListener("abort", onAbort, { once: true });
          }
          (async () => {
            try {
              await ops.access(absolutePath);
              if (aborted) {
                return;
              }
              const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : void 0;
              let content;
              let details;
              if (mimeType) {
                const buffer = await ops.readFile(absolutePath);
                const base64 = buffer.toString("base64");
                if (autoResizeImages) {
                  const resized = await resizeImage({ type: "image", data: base64, mimeType });
                  const dimensionNote = formatDimensionNote(resized);
                  let textNote = `Read image file [${resized.mimeType}]`;
                  if (dimensionNote) {
                    textNote += `
${dimensionNote}`;
                  }
                  content = [
                    { type: "text", text: textNote },
                    { type: "image", data: resized.data, mimeType: resized.mimeType }
                  ];
                } else {
                  const textNote = `Read image file [${mimeType}]`;
                  content = [
                    { type: "text", text: textNote },
                    { type: "image", data: base64, mimeType }
                  ];
                }
              } else {
                const buffer = await ops.readFile(absolutePath);
                const textContent = buffer.toString("utf-8");
                const allLines = textContent.split("\n");
                const totalFileLines = allLines.length;
                let startLine = offset ? Math.max(0, offset - 1) : 0;
                let offsetClamped = false;
                if (startLine >= allLines.length) {
                  startLine = Math.max(0, allLines.length - 1);
                  offsetClamped = true;
                }
                const startLineDisplay = startLine + 1;
                let selectedContent;
                let userLimitedLines;
                if (limit !== void 0) {
                  const endLine = Math.min(startLine + limit, allLines.length);
                  selectedContent = allLines.slice(startLine, endLine).join("\n");
                  userLimitedLines = endLine - startLine;
                } else {
                  selectedContent = allLines.slice(startLine).join("\n");
                }
                const truncation = truncateHead(selectedContent);
                let outputText;
                if (truncation.firstLineExceedsLimit) {
                  const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
                  outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
                  details = { truncation };
                } else if (truncation.truncated) {
                  const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
                  const nextOffset = endLineDisplay + 1;
                  outputText = truncation.content;
                  if (truncation.truncatedBy === "lines") {
                    outputText += `

[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
                  } else {
                    outputText += `

[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
                  }
                  details = { truncation };
                } else if (userLimitedLines !== void 0 && startLine + userLimitedLines < allLines.length) {
                  const remaining = allLines.length - (startLine + userLimitedLines);
                  const nextOffset = startLine + userLimitedLines + 1;
                  outputText = truncation.content;
                  outputText += `

[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
                } else {
                  outputText = truncation.content;
                }
                if (offsetClamped) {
                  outputText = `[Offset ${offset} beyond end of file (${totalFileLines} lines). Clamped to line ${startLineDisplay}.]

${outputText}`;
                }
                content = [{ type: "text", text: outputText }];
              }
              if (aborted) {
                return;
              }
              if (signal) {
                signal.removeEventListener("abort", onAbort);
              }
              resolve({ content, details: { ...details, target } });
            } catch (error) {
              if (signal) {
                signal.removeEventListener("abort", onAbort);
              }
              if (!aborted) {
                reject(error);
              }
            }
          })();
        }
      );
    }
  };
}
const readTool = createReadTool(process.cwd());
export {
  createReadTool,
  readTool
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL3Rvb2xzL3JlYWQudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0eXBlIHsgQWdlbnRUb29sIH0gZnJvbSBcIkBnc2QvcGktYWdlbnQtY29yZVwiO1xuaW1wb3J0IHR5cGUgeyBJbWFnZUNvbnRlbnQsIFRleHRDb250ZW50IH0gZnJvbSBcIkBnc2QvcGktYWlcIjtcbmltcG9ydCB7IHR5cGUgU3RhdGljLCBUeXBlIH0gZnJvbSBcIkBzaW5jbGFpci90eXBlYm94XCI7XG5pbXBvcnQgeyBjb25zdGFudHMgfSBmcm9tIFwiZnNcIjtcbmltcG9ydCB7IGFjY2VzcyBhcyBmc0FjY2VzcywgcmVhZEZpbGUgYXMgZnNSZWFkRmlsZSB9IGZyb20gXCJmcy9wcm9taXNlc1wiO1xuaW1wb3J0IHsgZm9ybWF0RGltZW5zaW9uTm90ZSwgcmVzaXplSW1hZ2UgfSBmcm9tIFwiLi4vLi4vdXRpbHMvaW1hZ2UtcmVzaXplLmpzXCI7XG5pbXBvcnQgeyBkZXRlY3RTdXBwb3J0ZWRJbWFnZU1pbWVUeXBlRnJvbUZpbGUgfSBmcm9tIFwiLi4vLi4vdXRpbHMvbWltZS5qc1wiO1xuaW1wb3J0IHsgcmVzb2x2ZVJlYWRQYXRoIH0gZnJvbSBcIi4vcGF0aC11dGlscy5qc1wiO1xuaW1wb3J0IHsgY3JlYXRlUmVhZEZpbGVUYXJnZXQsIHR5cGUgVG9vbFRhcmdldE1ldGFkYXRhIH0gZnJvbSBcIi4vdG9vbC10YXJnZXQuanNcIjtcbmltcG9ydCB7IERFRkFVTFRfTUFYX0JZVEVTLCBERUZBVUxUX01BWF9MSU5FUywgZm9ybWF0U2l6ZSwgdHlwZSBUcnVuY2F0aW9uUmVzdWx0LCB0cnVuY2F0ZUhlYWQgfSBmcm9tIFwiLi90cnVuY2F0ZS5qc1wiO1xuXG5jb25zdCByZWFkU2NoZW1hID0gVHlwZS5PYmplY3Qoe1xuXHRwYXRoOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIlBhdGggdG8gdGhlIGZpbGUgdG8gcmVhZCAocmVsYXRpdmUgb3IgYWJzb2x1dGUpXCIgfSksXG5cdG9mZnNldDogVHlwZS5PcHRpb25hbChUeXBlLk51bWJlcih7IGRlc2NyaXB0aW9uOiBcIkxpbmUgbnVtYmVyIHRvIHN0YXJ0IHJlYWRpbmcgZnJvbSAoMS1pbmRleGVkKVwiIH0pKSxcblx0bGltaXQ6IFR5cGUuT3B0aW9uYWwoVHlwZS5OdW1iZXIoeyBkZXNjcmlwdGlvbjogXCJNYXhpbXVtIG51bWJlciBvZiBsaW5lcyB0byByZWFkXCIgfSkpLFxufSk7XG5cbmV4cG9ydCB0eXBlIFJlYWRUb29sSW5wdXQgPSBTdGF0aWM8dHlwZW9mIHJlYWRTY2hlbWE+O1xuXG5leHBvcnQgaW50ZXJmYWNlIFJlYWRUb29sRGV0YWlscyB7XG5cdHRhcmdldD86IFRvb2xUYXJnZXRNZXRhZGF0YTtcblx0dHJ1bmNhdGlvbj86IFRydW5jYXRpb25SZXN1bHQ7XG59XG5cbi8qKlxuICogUGx1Z2dhYmxlIG9wZXJhdGlvbnMgZm9yIHRoZSByZWFkIHRvb2wuXG4gKiBPdmVycmlkZSB0aGVzZSB0byBkZWxlZ2F0ZSBmaWxlIHJlYWRpbmcgdG8gcmVtb3RlIHN5c3RlbXMgKGUuZy4sIFNTSCkuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUmVhZE9wZXJhdGlvbnMge1xuXHQvKiogUmVhZCBmaWxlIGNvbnRlbnRzIGFzIGEgQnVmZmVyICovXG5cdHJlYWRGaWxlOiAoYWJzb2x1dGVQYXRoOiBzdHJpbmcpID0+IFByb21pc2U8QnVmZmVyPjtcblx0LyoqIENoZWNrIGlmIGZpbGUgaXMgcmVhZGFibGUgKHRocm93IGlmIG5vdCkgKi9cblx0YWNjZXNzOiAoYWJzb2x1dGVQYXRoOiBzdHJpbmcpID0+IFByb21pc2U8dm9pZD47XG5cdC8qKiBEZXRlY3QgaW1hZ2UgTUlNRSB0eXBlLCByZXR1cm4gbnVsbC91bmRlZmluZWQgZm9yIG5vbi1pbWFnZXMgKi9cblx0ZGV0ZWN0SW1hZ2VNaW1lVHlwZT86IChhYnNvbHV0ZVBhdGg6IHN0cmluZykgPT4gUHJvbWlzZTxzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkPjtcbn1cblxuY29uc3QgZGVmYXVsdFJlYWRPcGVyYXRpb25zOiBSZWFkT3BlcmF0aW9ucyA9IHtcblx0cmVhZEZpbGU6IChwYXRoKSA9PiBmc1JlYWRGaWxlKHBhdGgpLFxuXHRhY2Nlc3M6IChwYXRoKSA9PiBmc0FjY2VzcyhwYXRoLCBjb25zdGFudHMuUl9PSyksXG5cdGRldGVjdEltYWdlTWltZVR5cGU6IGRldGVjdFN1cHBvcnRlZEltYWdlTWltZVR5cGVGcm9tRmlsZSxcbn07XG5cbmV4cG9ydCBpbnRlcmZhY2UgUmVhZFRvb2xPcHRpb25zIHtcblx0LyoqIFdoZXRoZXIgdG8gYXV0by1yZXNpemUgaW1hZ2VzIHRvIDIwMDB4MjAwMCBtYXguIERlZmF1bHQ6IHRydWUgKi9cblx0YXV0b1Jlc2l6ZUltYWdlcz86IGJvb2xlYW47XG5cdC8qKiBDdXN0b20gb3BlcmF0aW9ucyBmb3IgZmlsZSByZWFkaW5nLiBEZWZhdWx0OiBsb2NhbCBmaWxlc3lzdGVtICovXG5cdG9wZXJhdGlvbnM/OiBSZWFkT3BlcmF0aW9ucztcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVJlYWRUb29sKGN3ZDogc3RyaW5nLCBvcHRpb25zPzogUmVhZFRvb2xPcHRpb25zKTogQWdlbnRUb29sPHR5cGVvZiByZWFkU2NoZW1hPiB7XG5cdGNvbnN0IGF1dG9SZXNpemVJbWFnZXMgPSBvcHRpb25zPy5hdXRvUmVzaXplSW1hZ2VzID8/IHRydWU7XG5cdGNvbnN0IG9wcyA9IG9wdGlvbnM/Lm9wZXJhdGlvbnMgPz8gZGVmYXVsdFJlYWRPcGVyYXRpb25zO1xuXG5cdHJldHVybiB7XG5cdFx0bmFtZTogXCJyZWFkXCIsXG5cdFx0bGFiZWw6IFwicmVhZFwiLFxuXHRcdGRlc2NyaXB0aW9uOiBgUmVhZCB0aGUgY29udGVudHMgb2YgYSBmaWxlLiBTdXBwb3J0cyB0ZXh0IGZpbGVzIGFuZCBpbWFnZXMgKGpwZywgcG5nLCBnaWYsIHdlYnApLiBJbWFnZXMgYXJlIHNlbnQgYXMgYXR0YWNobWVudHMuIEZvciB0ZXh0IGZpbGVzLCBvdXRwdXQgaXMgdHJ1bmNhdGVkIHRvICR7REVGQVVMVF9NQVhfTElORVN9IGxpbmVzIG9yICR7REVGQVVMVF9NQVhfQllURVMgLyAxMDI0fUtCICh3aGljaGV2ZXIgaXMgaGl0IGZpcnN0KS4gVXNlIG9mZnNldC9saW1pdCBmb3IgbGFyZ2UgZmlsZXMuIFdoZW4geW91IG5lZWQgdGhlIGZ1bGwgZmlsZSwgY29udGludWUgd2l0aCBvZmZzZXQgdW50aWwgY29tcGxldGUuYCxcblx0XHRwYXJhbWV0ZXJzOiByZWFkU2NoZW1hLFxuXHRcdGV4ZWN1dGU6IGFzeW5jIChcblx0XHRcdF90b29sQ2FsbElkOiBzdHJpbmcsXG5cdFx0XHR7IHBhdGgsIG9mZnNldCwgbGltaXQgfTogeyBwYXRoOiBzdHJpbmc7IG9mZnNldD86IG51bWJlcjsgbGltaXQ/OiBudW1iZXIgfSxcblx0XHRcdHNpZ25hbD86IEFib3J0U2lnbmFsLFxuXHRcdCkgPT4ge1xuXHRcdFx0Y29uc3QgYWJzb2x1dGVQYXRoID0gcmVzb2x2ZVJlYWRQYXRoKHBhdGgsIGN3ZCk7XG5cdFx0XHRjb25zdCB0YXJnZXQgPSBjcmVhdGVSZWFkRmlsZVRhcmdldChwYXRoLCBhYnNvbHV0ZVBhdGgsIG9mZnNldCwgbGltaXQpO1xuXG5cdFx0XHRyZXR1cm4gbmV3IFByb21pc2U8eyBjb250ZW50OiAoVGV4dENvbnRlbnQgfCBJbWFnZUNvbnRlbnQpW107IGRldGFpbHM6IFJlYWRUb29sRGV0YWlscyB8IHVuZGVmaW5lZCB9Pihcblx0XHRcdFx0KHJlc29sdmUsIHJlamVjdCkgPT4ge1xuXHRcdFx0XHRcdC8vIENoZWNrIGlmIGFscmVhZHkgYWJvcnRlZFxuXHRcdFx0XHRcdGlmIChzaWduYWw/LmFib3J0ZWQpIHtcblx0XHRcdFx0XHRcdHJlamVjdChuZXcgRXJyb3IoXCJPcGVyYXRpb24gYWJvcnRlZFwiKSk7XG5cdFx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0bGV0IGFib3J0ZWQgPSBmYWxzZTtcblxuXHRcdFx0XHRcdC8vIFNldCB1cCBhYm9ydCBoYW5kbGVyXG5cdFx0XHRcdFx0Y29uc3Qgb25BYm9ydCA9ICgpID0+IHtcblx0XHRcdFx0XHRcdGFib3J0ZWQgPSB0cnVlO1xuXHRcdFx0XHRcdFx0cmVqZWN0KG5ldyBFcnJvcihcIk9wZXJhdGlvbiBhYm9ydGVkXCIpKTtcblx0XHRcdFx0XHR9O1xuXG5cdFx0XHRcdFx0aWYgKHNpZ25hbCkge1xuXHRcdFx0XHRcdFx0c2lnbmFsLmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkFib3J0LCB7IG9uY2U6IHRydWUgfSk7XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Ly8gUGVyZm9ybSB0aGUgcmVhZCBvcGVyYXRpb25cblx0XHRcdFx0XHQoYXN5bmMgKCkgPT4ge1xuXHRcdFx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRcdFx0Ly8gQ2hlY2sgaWYgZmlsZSBleGlzdHNcblx0XHRcdFx0XHRcdFx0YXdhaXQgb3BzLmFjY2VzcyhhYnNvbHV0ZVBhdGgpO1xuXG5cdFx0XHRcdFx0XHRcdC8vIENoZWNrIGlmIGFib3J0ZWQgYmVmb3JlIHJlYWRpbmdcblx0XHRcdFx0XHRcdFx0aWYgKGFib3J0ZWQpIHtcblx0XHRcdFx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0XHRjb25zdCBtaW1lVHlwZSA9IG9wcy5kZXRlY3RJbWFnZU1pbWVUeXBlID8gYXdhaXQgb3BzLmRldGVjdEltYWdlTWltZVR5cGUoYWJzb2x1dGVQYXRoKSA6IHVuZGVmaW5lZDtcblxuXHRcdFx0XHRcdFx0XHQvLyBSZWFkIHRoZSBmaWxlIGJhc2VkIG9uIHR5cGVcblx0XHRcdFx0XHRcdFx0bGV0IGNvbnRlbnQ6IChUZXh0Q29udGVudCB8IEltYWdlQ29udGVudClbXTtcblx0XHRcdFx0XHRcdFx0bGV0IGRldGFpbHM6IFJlYWRUb29sRGV0YWlscyB8IHVuZGVmaW5lZDtcblxuXHRcdFx0XHRcdFx0XHRpZiAobWltZVR5cGUpIHtcblx0XHRcdFx0XHRcdFx0XHQvLyBSZWFkIGFzIGltYWdlIChiaW5hcnkpXG5cdFx0XHRcdFx0XHRcdFx0Y29uc3QgYnVmZmVyID0gYXdhaXQgb3BzLnJlYWRGaWxlKGFic29sdXRlUGF0aCk7XG5cdFx0XHRcdFx0XHRcdFx0Y29uc3QgYmFzZTY0ID0gYnVmZmVyLnRvU3RyaW5nKFwiYmFzZTY0XCIpO1xuXG5cdFx0XHRcdFx0XHRcdFx0aWYgKGF1dG9SZXNpemVJbWFnZXMpIHtcblx0XHRcdFx0XHRcdFx0XHRcdC8vIFJlc2l6ZSBpbWFnZSBpZiBuZWVkZWRcblx0XHRcdFx0XHRcdFx0XHRcdGNvbnN0IHJlc2l6ZWQgPSBhd2FpdCByZXNpemVJbWFnZSh7IHR5cGU6IFwiaW1hZ2VcIiwgZGF0YTogYmFzZTY0LCBtaW1lVHlwZSB9KTtcblx0XHRcdFx0XHRcdFx0XHRcdGNvbnN0IGRpbWVuc2lvbk5vdGUgPSBmb3JtYXREaW1lbnNpb25Ob3RlKHJlc2l6ZWQpO1xuXG5cdFx0XHRcdFx0XHRcdFx0XHRsZXQgdGV4dE5vdGUgPSBgUmVhZCBpbWFnZSBmaWxlIFske3Jlc2l6ZWQubWltZVR5cGV9XWA7XG5cdFx0XHRcdFx0XHRcdFx0XHRpZiAoZGltZW5zaW9uTm90ZSkge1xuXHRcdFx0XHRcdFx0XHRcdFx0XHR0ZXh0Tm90ZSArPSBgXFxuJHtkaW1lbnNpb25Ob3RlfWA7XG5cdFx0XHRcdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdFx0XHRcdGNvbnRlbnQgPSBbXG5cdFx0XHRcdFx0XHRcdFx0XHRcdHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IHRleHROb3RlIH0sXG5cdFx0XHRcdFx0XHRcdFx0XHRcdHsgdHlwZTogXCJpbWFnZVwiLCBkYXRhOiByZXNpemVkLmRhdGEsIG1pbWVUeXBlOiByZXNpemVkLm1pbWVUeXBlIH0sXG5cdFx0XHRcdFx0XHRcdFx0XHRdO1xuXHRcdFx0XHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRjb25zdCB0ZXh0Tm90ZSA9IGBSZWFkIGltYWdlIGZpbGUgWyR7bWltZVR5cGV9XWA7XG5cdFx0XHRcdFx0XHRcdFx0XHRjb250ZW50ID0gW1xuXHRcdFx0XHRcdFx0XHRcdFx0XHR7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiB0ZXh0Tm90ZSB9LFxuXHRcdFx0XHRcdFx0XHRcdFx0XHR7IHR5cGU6IFwiaW1hZ2VcIiwgZGF0YTogYmFzZTY0LCBtaW1lVHlwZSB9LFxuXHRcdFx0XHRcdFx0XHRcdFx0XTtcblx0XHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRcdFx0Ly8gUmVhZCBhcyB0ZXh0XG5cdFx0XHRcdFx0XHRcdFx0Y29uc3QgYnVmZmVyID0gYXdhaXQgb3BzLnJlYWRGaWxlKGFic29sdXRlUGF0aCk7XG5cdFx0XHRcdFx0XHRcdFx0Y29uc3QgdGV4dENvbnRlbnQgPSBidWZmZXIudG9TdHJpbmcoXCJ1dGYtOFwiKTtcblx0XHRcdFx0XHRcdFx0XHRjb25zdCBhbGxMaW5lcyA9IHRleHRDb250ZW50LnNwbGl0KFwiXFxuXCIpO1xuXHRcdFx0XHRcdFx0XHRcdGNvbnN0IHRvdGFsRmlsZUxpbmVzID0gYWxsTGluZXMubGVuZ3RoO1xuXG5cdFx0XHRcdFx0XHRcdFx0Ly8gQXBwbHkgb2Zmc2V0IGlmIHNwZWNpZmllZCAoMS1pbmRleGVkIHRvIDAtaW5kZXhlZClcblx0XHRcdFx0XHRcdFx0XHRsZXQgc3RhcnRMaW5lID0gb2Zmc2V0ID8gTWF0aC5tYXgoMCwgb2Zmc2V0IC0gMSkgOiAwO1xuXG5cdFx0XHRcdFx0XHRcdFx0Ly8gQ2xhbXAgb2Zmc2V0IHRvIGZpbGUgYm91bmRzIGluc3RlYWQgb2YgdGhyb3dpbmcgKCMzMDA3KS5cblx0XHRcdFx0XHRcdFx0XHQvLyBXaGVuIGFuIGFnZW50IHJlcXVlc3RzIG9mZnNldDozMCBvbiBhIDEzLWxpbmUgZmlsZSwgcmV0dXJuXG5cdFx0XHRcdFx0XHRcdFx0Ly8gdGhlIGxhc3QgbGluZSB3aXRoIGEgbm90aWNlIHJhdGhlciB0aGFuIGFuIGVycm9yIHRoYXRcblx0XHRcdFx0XHRcdFx0XHQvLyBwcm9wYWdhdGVzIGFzIGludmFsaWQgSlNPTiBkb3duc3RyZWFtLlxuXHRcdFx0XHRcdFx0XHRcdGxldCBvZmZzZXRDbGFtcGVkID0gZmFsc2U7XG5cdFx0XHRcdFx0XHRcdFx0aWYgKHN0YXJ0TGluZSA+PSBhbGxMaW5lcy5sZW5ndGgpIHtcblx0XHRcdFx0XHRcdFx0XHRcdHN0YXJ0TGluZSA9IE1hdGgubWF4KDAsIGFsbExpbmVzLmxlbmd0aCAtIDEpO1xuXHRcdFx0XHRcdFx0XHRcdFx0b2Zmc2V0Q2xhbXBlZCA9IHRydWU7XG5cdFx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHRcdGNvbnN0IHN0YXJ0TGluZURpc3BsYXkgPSBzdGFydExpbmUgKyAxOyAvLyBGb3IgZGlzcGxheSAoMS1pbmRleGVkKVxuXG5cdFx0XHRcdFx0XHRcdFx0Ly8gSWYgbGltaXQgaXMgc3BlY2lmaWVkIGJ5IHVzZXIsIHVzZSBpdDsgb3RoZXJ3aXNlIHdlJ2xsIGxldCB0cnVuY2F0ZUhlYWQgZGVjaWRlXG5cdFx0XHRcdFx0XHRcdFx0bGV0IHNlbGVjdGVkQ29udGVudDogc3RyaW5nO1xuXHRcdFx0XHRcdFx0XHRcdGxldCB1c2VyTGltaXRlZExpbmVzOiBudW1iZXIgfCB1bmRlZmluZWQ7XG5cdFx0XHRcdFx0XHRcdFx0aWYgKGxpbWl0ICE9PSB1bmRlZmluZWQpIHtcblx0XHRcdFx0XHRcdFx0XHRcdGNvbnN0IGVuZExpbmUgPSBNYXRoLm1pbihzdGFydExpbmUgKyBsaW1pdCwgYWxsTGluZXMubGVuZ3RoKTtcblx0XHRcdFx0XHRcdFx0XHRcdHNlbGVjdGVkQ29udGVudCA9IGFsbExpbmVzLnNsaWNlKHN0YXJ0TGluZSwgZW5kTGluZSkuam9pbihcIlxcblwiKTtcblx0XHRcdFx0XHRcdFx0XHRcdHVzZXJMaW1pdGVkTGluZXMgPSBlbmRMaW5lIC0gc3RhcnRMaW5lO1xuXHRcdFx0XHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRzZWxlY3RlZENvbnRlbnQgPSBhbGxMaW5lcy5zbGljZShzdGFydExpbmUpLmpvaW4oXCJcXG5cIik7XG5cdFx0XHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHRcdFx0Ly8gQXBwbHkgdHJ1bmNhdGlvbiAocmVzcGVjdHMgYm90aCBsaW5lIGFuZCBieXRlIGxpbWl0cylcblx0XHRcdFx0XHRcdFx0XHRjb25zdCB0cnVuY2F0aW9uID0gdHJ1bmNhdGVIZWFkKHNlbGVjdGVkQ29udGVudCk7XG5cblx0XHRcdFx0XHRcdFx0XHRsZXQgb3V0cHV0VGV4dDogc3RyaW5nO1xuXG5cdFx0XHRcdFx0XHRcdFx0aWYgKHRydW5jYXRpb24uZmlyc3RMaW5lRXhjZWVkc0xpbWl0KSB7XG5cdFx0XHRcdFx0XHRcdFx0XHQvLyBGaXJzdCBsaW5lIGF0IG9mZnNldCBleGNlZWRzIDMwS0IgLSB0ZWxsIG1vZGVsIHRvIHVzZSBiYXNoXG5cdFx0XHRcdFx0XHRcdFx0XHRjb25zdCBmaXJzdExpbmVTaXplID0gZm9ybWF0U2l6ZShCdWZmZXIuYnl0ZUxlbmd0aChhbGxMaW5lc1tzdGFydExpbmVdLCBcInV0Zi04XCIpKTtcblx0XHRcdFx0XHRcdFx0XHRcdG91dHB1dFRleHQgPSBgW0xpbmUgJHtzdGFydExpbmVEaXNwbGF5fSBpcyAke2ZpcnN0TGluZVNpemV9LCBleGNlZWRzICR7Zm9ybWF0U2l6ZShERUZBVUxUX01BWF9CWVRFUyl9IGxpbWl0LiBVc2UgYmFzaDogc2VkIC1uICcke3N0YXJ0TGluZURpc3BsYXl9cCcgJHtwYXRofSB8IGhlYWQgLWMgJHtERUZBVUxUX01BWF9CWVRFU31dYDtcblx0XHRcdFx0XHRcdFx0XHRcdGRldGFpbHMgPSB7IHRydW5jYXRpb24gfTtcblx0XHRcdFx0XHRcdFx0XHR9IGVsc2UgaWYgKHRydW5jYXRpb24udHJ1bmNhdGVkKSB7XG5cdFx0XHRcdFx0XHRcdFx0XHQvLyBUcnVuY2F0aW9uIG9jY3VycmVkIC0gYnVpbGQgYWN0aW9uYWJsZSBub3RpY2Vcblx0XHRcdFx0XHRcdFx0XHRcdGNvbnN0IGVuZExpbmVEaXNwbGF5ID0gc3RhcnRMaW5lRGlzcGxheSArIHRydW5jYXRpb24ub3V0cHV0TGluZXMgLSAxO1xuXHRcdFx0XHRcdFx0XHRcdFx0Y29uc3QgbmV4dE9mZnNldCA9IGVuZExpbmVEaXNwbGF5ICsgMTtcblxuXHRcdFx0XHRcdFx0XHRcdFx0b3V0cHV0VGV4dCA9IHRydW5jYXRpb24uY29udGVudDtcblxuXHRcdFx0XHRcdFx0XHRcdFx0aWYgKHRydW5jYXRpb24udHJ1bmNhdGVkQnkgPT09IFwibGluZXNcIikge1xuXHRcdFx0XHRcdFx0XHRcdFx0XHRvdXRwdXRUZXh0ICs9IGBcXG5cXG5bU2hvd2luZyBsaW5lcyAke3N0YXJ0TGluZURpc3BsYXl9LSR7ZW5kTGluZURpc3BsYXl9IG9mICR7dG90YWxGaWxlTGluZXN9LiBVc2Ugb2Zmc2V0PSR7bmV4dE9mZnNldH0gdG8gY29udGludWUuXWA7XG5cdFx0XHRcdFx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0XHRcdFx0XHRvdXRwdXRUZXh0ICs9IGBcXG5cXG5bU2hvd2luZyBsaW5lcyAke3N0YXJ0TGluZURpc3BsYXl9LSR7ZW5kTGluZURpc3BsYXl9IG9mICR7dG90YWxGaWxlTGluZXN9ICgke2Zvcm1hdFNpemUoREVGQVVMVF9NQVhfQllURVMpfSBsaW1pdCkuIFVzZSBvZmZzZXQ9JHtuZXh0T2Zmc2V0fSB0byBjb250aW51ZS5dYDtcblx0XHRcdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0XHRcdGRldGFpbHMgPSB7IHRydW5jYXRpb24gfTtcblx0XHRcdFx0XHRcdFx0XHR9IGVsc2UgaWYgKHVzZXJMaW1pdGVkTGluZXMgIT09IHVuZGVmaW5lZCAmJiBzdGFydExpbmUgKyB1c2VyTGltaXRlZExpbmVzIDwgYWxsTGluZXMubGVuZ3RoKSB7XG5cdFx0XHRcdFx0XHRcdFx0XHQvLyBVc2VyIHNwZWNpZmllZCBsaW1pdCwgdGhlcmUncyBtb3JlIGNvbnRlbnQsIGJ1dCBubyB0cnVuY2F0aW9uXG5cdFx0XHRcdFx0XHRcdFx0XHRjb25zdCByZW1haW5pbmcgPSBhbGxMaW5lcy5sZW5ndGggLSAoc3RhcnRMaW5lICsgdXNlckxpbWl0ZWRMaW5lcyk7XG5cdFx0XHRcdFx0XHRcdFx0XHRjb25zdCBuZXh0T2Zmc2V0ID0gc3RhcnRMaW5lICsgdXNlckxpbWl0ZWRMaW5lcyArIDE7XG5cblx0XHRcdFx0XHRcdFx0XHRcdG91dHB1dFRleHQgPSB0cnVuY2F0aW9uLmNvbnRlbnQ7XG5cdFx0XHRcdFx0XHRcdFx0XHRvdXRwdXRUZXh0ICs9IGBcXG5cXG5bJHtyZW1haW5pbmd9IG1vcmUgbGluZXMgaW4gZmlsZS4gVXNlIG9mZnNldD0ke25leHRPZmZzZXR9IHRvIGNvbnRpbnVlLl1gO1xuXHRcdFx0XHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRcdFx0XHQvLyBObyB0cnVuY2F0aW9uLCBubyB1c2VyIGxpbWl0IGV4Y2VlZGVkXG5cdFx0XHRcdFx0XHRcdFx0XHRvdXRwdXRUZXh0ID0gdHJ1bmNhdGlvbi5jb250ZW50O1xuXHRcdFx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0XHRcdC8vIFByZXBlbmQgY2xhbXAgbm90aWNlIHNvIHRoZSBhZ2VudCBrbm93cyBvZmZzZXQgd2FzIGFkanVzdGVkXG5cdFx0XHRcdFx0XHRcdFx0aWYgKG9mZnNldENsYW1wZWQpIHtcblx0XHRcdFx0XHRcdFx0XHRcdG91dHB1dFRleHQgPSBgW09mZnNldCAke29mZnNldH0gYmV5b25kIGVuZCBvZiBmaWxlICgke3RvdGFsRmlsZUxpbmVzfSBsaW5lcykuIENsYW1wZWQgdG8gbGluZSAke3N0YXJ0TGluZURpc3BsYXl9Ll1cXG5cXG4ke291dHB1dFRleHR9YDtcblx0XHRcdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdFx0XHRjb250ZW50ID0gW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IG91dHB1dFRleHQgfV07XG5cdFx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0XHQvLyBDaGVjayBpZiBhYm9ydGVkIGFmdGVyIHJlYWRpbmdcblx0XHRcdFx0XHRcdFx0aWYgKGFib3J0ZWQpIHtcblx0XHRcdFx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0XHQvLyBDbGVhbiB1cCBhYm9ydCBoYW5kbGVyXG5cdFx0XHRcdFx0XHRcdGlmIChzaWduYWwpIHtcblx0XHRcdFx0XHRcdFx0XHRzaWduYWwucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQWJvcnQpO1xuXHRcdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdFx0cmVzb2x2ZSh7IGNvbnRlbnQsIGRldGFpbHM6IHsgLi4uZGV0YWlscywgdGFyZ2V0IH0gfSk7XG5cdFx0XHRcdFx0XHR9IGNhdGNoIChlcnJvcjogYW55KSB7XG5cdFx0XHRcdFx0XHRcdC8vIENsZWFuIHVwIGFib3J0IGhhbmRsZXJcblx0XHRcdFx0XHRcdFx0aWYgKHNpZ25hbCkge1xuXHRcdFx0XHRcdFx0XHRcdHNpZ25hbC5yZW1vdmVFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25BYm9ydCk7XG5cdFx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0XHRpZiAoIWFib3J0ZWQpIHtcblx0XHRcdFx0XHRcdFx0XHRyZWplY3QoZXJyb3IpO1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fSkoKTtcblx0XHRcdFx0fSxcblx0XHRcdCk7XG5cdFx0fSxcblx0fTtcbn1cblxuLyoqIERlZmF1bHQgcmVhZCB0b29sIHVzaW5nIHByb2Nlc3MuY3dkKCkgLSBmb3IgYmFja3dhcmRzIGNvbXBhdGliaWxpdHkgKi9cbmV4cG9ydCBjb25zdCByZWFkVG9vbCA9IGNyZWF0ZVJlYWRUb29sKHByb2Nlc3MuY3dkKCkpO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBRUEsU0FBc0IsWUFBWTtBQUNsQyxTQUFTLGlCQUFpQjtBQUMxQixTQUFTLFVBQVUsVUFBVSxZQUFZLGtCQUFrQjtB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
