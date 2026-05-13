import { Type } from "@sinclair/typebox";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile } from "fs/promises";
import { formatDimensionNote, resizeImage } from "../../utils/image-resize.js";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.js";
import { formatHashLines } from "./hashline.js";
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
function createHashlineReadTool(cwd, options) {
  const autoResizeImages = options?.autoResizeImages ?? true;
  const ops = options?.operations ?? defaultReadOperations;
  return {
    name: "read",
    label: "read",
    description: `Read a file with LINE#ID hash anchors on each line. These anchors are used by hashline_edit for precise edits. Output format: LINENUM#HASH:CONTENT. Supports text files and images. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB. Use offset/limit for large files.`,
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
              if (aborted) return;
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
                  content = [
                    { type: "text", text: `Read image file [${mimeType}]` },
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
                  outputText = formatHashLines(truncation.content, startLineDisplay);
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
                  outputText = formatHashLines(truncation.content, startLineDisplay);
                  outputText += `

[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
                } else {
                  outputText = formatHashLines(truncation.content, startLineDisplay);
                }
                if (offsetClamped) {
                  outputText = `[Offset ${offset} beyond end of file (${totalFileLines} lines). Clamped to line ${startLineDisplay}.]

${outputText}`;
                }
                content = [{ type: "text", text: outputText }];
              }
              if (aborted) return;
              if (signal) signal.removeEventListener("abort", onAbort);
              resolve({ content, details: { ...details, target } });
            } catch (error) {
              if (signal) signal.removeEventListener("abort", onAbort);
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
const hashlineReadTool = createHashlineReadTool(process.cwd());
export {
  createHashlineReadTool,
  hashlineReadTool
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL3Rvb2xzL2hhc2hsaW5lLXJlYWQudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogSGFzaGxpbmUgcmVhZCB0b29sIFx1MjAxNCByZWFkcyBmaWxlcyB3aXRoIExJTkUjSUQgcHJlZml4IG9uIGVhY2ggbGluZS5cbiAqXG4gKiBQcm9kdWNlcyBvdXRwdXQgbGlrZTpcbiAqICAgMSNRUTpmdW5jdGlvbiBoZWxsbygpIHtcbiAqICAgMiNLWDogIHJldHVybiA0MjtcbiAqICAgMyNOVzp9XG4gKlxuICogVGhlc2UgdGFncyBhcmUgdXNlZCBieSB0aGUgaGFzaGxpbmVfZWRpdCB0b29sIHRvIGFkZHJlc3MgbGluZXMgcHJlY2lzZWx5LlxuICovXG5pbXBvcnQgdHlwZSB7IEFnZW50VG9vbCB9IGZyb20gXCJAZ3NkL3BpLWFnZW50LWNvcmVcIjtcbmltcG9ydCB0eXBlIHsgSW1hZ2VDb250ZW50LCBUZXh0Q29udGVudCB9IGZyb20gXCJAZ3NkL3BpLWFpXCI7XG5pbXBvcnQgeyB0eXBlIFN0YXRpYywgVHlwZSB9IGZyb20gXCJAc2luY2xhaXIvdHlwZWJveFwiO1xuaW1wb3J0IHsgY29uc3RhbnRzIH0gZnJvbSBcImZzXCI7XG5pbXBvcnQgeyBhY2Nlc3MgYXMgZnNBY2Nlc3MsIHJlYWRGaWxlIGFzIGZzUmVhZEZpbGUgfSBmcm9tIFwiZnMvcHJvbWlzZXNcIjtcbmltcG9ydCB7IGZvcm1hdERpbWVuc2lvbk5vdGUsIHJlc2l6ZUltYWdlIH0gZnJvbSBcIi4uLy4uL3V0aWxzL2ltYWdlLXJlc2l6ZS5qc1wiO1xuaW1wb3J0IHsgZGV0ZWN0U3VwcG9ydGVkSW1hZ2VNaW1lVHlwZUZyb21GaWxlIH0gZnJvbSBcIi4uLy4uL3V0aWxzL21pbWUuanNcIjtcbmltcG9ydCB7IGZvcm1hdEhhc2hMaW5lcyB9IGZyb20gXCIuL2hhc2hsaW5lLmpzXCI7XG5pbXBvcnQgeyByZXNvbHZlUmVhZFBhdGggfSBmcm9tIFwiLi9wYXRoLXV0aWxzLmpzXCI7XG5pbXBvcnQgeyBjcmVhdGVSZWFkRmlsZVRhcmdldCwgdHlwZSBUb29sVGFyZ2V0TWV0YWRhdGEgfSBmcm9tIFwiLi90b29sLXRhcmdldC5qc1wiO1xuaW1wb3J0IHsgREVGQVVMVF9NQVhfQllURVMsIERFRkFVTFRfTUFYX0xJTkVTLCBmb3JtYXRTaXplLCB0eXBlIFRydW5jYXRpb25SZXN1bHQsIHRydW5jYXRlSGVhZCB9IGZyb20gXCIuL3RydW5jYXRlLmpzXCI7XG5cbmNvbnN0IHJlYWRTY2hlbWEgPSBUeXBlLk9iamVjdCh7XG5cdHBhdGg6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiUGF0aCB0byB0aGUgZmlsZSB0byByZWFkIChyZWxhdGl2ZSBvciBhYnNvbHV0ZSlcIiB9KSxcblx0b2Zmc2V0OiBUeXBlLk9wdGlvbmFsKFR5cGUuTnVtYmVyKHsgZGVzY3JpcHRpb246IFwiTGluZSBudW1iZXIgdG8gc3RhcnQgcmVhZGluZyBmcm9tICgxLWluZGV4ZWQpXCIgfSkpLFxuXHRsaW1pdDogVHlwZS5PcHRpb25hbChUeXBlLk51bWJlcih7IGRlc2NyaXB0aW9uOiBcIk1heGltdW0gbnVtYmVyIG9mIGxpbmVzIHRvIHJlYWRcIiB9KSksXG59KTtcblxuZXhwb3J0IHR5cGUgSGFzaGxpbmVSZWFkVG9vbElucHV0ID0gU3RhdGljPHR5cGVvZiByZWFkU2NoZW1hPjtcblxuZXhwb3J0IGludGVyZmFjZSBIYXNobGluZVJlYWRUb29sRGV0YWlscyB7XG5cdHRhcmdldD86IFRvb2xUYXJnZXRNZXRhZGF0YTtcblx0dHJ1bmNhdGlvbj86IFRydW5jYXRpb25SZXN1bHQ7XG59XG5cbi8qKlxuICogUGx1Z2dhYmxlIG9wZXJhdGlvbnMgZm9yIHRoZSBoYXNobGluZSByZWFkIHRvb2wuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgSGFzaGxpbmVSZWFkT3BlcmF0aW9ucyB7XG5cdHJlYWRGaWxlOiAoYWJzb2x1dGVQYXRoOiBzdHJpbmcpID0+IFByb21pc2U8QnVmZmVyPjtcblx0YWNjZXNzOiAoYWJzb2x1dGVQYXRoOiBzdHJpbmcpID0+IFByb21pc2U8dm9pZD47XG5cdGRldGVjdEltYWdlTWltZVR5cGU/OiAoYWJzb2x1dGVQYXRoOiBzdHJpbmcpID0+IFByb21pc2U8c3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZD47XG59XG5cbmNvbnN0IGRlZmF1bHRSZWFkT3BlcmF0aW9uczogSGFzaGxpbmVSZWFkT3BlcmF0aW9ucyA9IHtcblx0cmVhZEZpbGU6IChwYXRoKSA9PiBmc1JlYWRGaWxlKHBhdGgpLFxuXHRhY2Nlc3M6IChwYXRoKSA9PiBmc0FjY2VzcyhwYXRoLCBjb25zdGFudHMuUl9PSyksXG5cdGRldGVjdEltYWdlTWltZVR5cGU6IGRldGVjdFN1cHBvcnRlZEltYWdlTWltZVR5cGVGcm9tRmlsZSxcbn07XG5cbmV4cG9ydCBpbnRlcmZhY2UgSGFzaGxpbmVSZWFkVG9vbE9wdGlvbnMge1xuXHRhdXRvUmVzaXplSW1hZ2VzPzogYm9vbGVhbjtcblx0b3BlcmF0aW9ucz86IEhhc2hsaW5lUmVhZE9wZXJhdGlvbnM7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVIYXNobGluZVJlYWRUb29sKGN3ZDogc3RyaW5nLCBvcHRpb25zPzogSGFzaGxpbmVSZWFkVG9vbE9wdGlvbnMpOiBBZ2VudFRvb2w8dHlwZW9mIHJlYWRTY2hlbWE+IHtcblx0Y29uc3QgYXV0b1Jlc2l6ZUltYWdlcyA9IG9wdGlvbnM/LmF1dG9SZXNpemVJbWFnZXMgPz8gdHJ1ZTtcblx0Y29uc3Qgb3BzID0gb3B0aW9ucz8ub3BlcmF0aW9ucyA/PyBkZWZhdWx0UmVhZE9wZXJhdGlvbnM7XG5cblx0cmV0dXJuIHtcblx0XHRuYW1lOiBcInJlYWRcIixcblx0XHRsYWJlbDogXCJyZWFkXCIsXG5cdFx0ZGVzY3JpcHRpb246IGBSZWFkIGEgZmlsZSB3aXRoIExJTkUjSUQgaGFzaCBhbmNob3JzIG9uIGVhY2ggbGluZS4gVGhlc2UgYW5jaG9ycyBhcmUgdXNlZCBieSBoYXNobGluZV9lZGl0IGZvciBwcmVjaXNlIGVkaXRzLiBPdXRwdXQgZm9ybWF0OiBMSU5FTlVNI0hBU0g6Q09OVEVOVC4gU3VwcG9ydHMgdGV4dCBmaWxlcyBhbmQgaW1hZ2VzLiBGb3IgdGV4dCBmaWxlcywgb3V0cHV0IGlzIHRydW5jYXRlZCB0byAke0RFRkFVTFRfTUFYX0xJTkVTfSBsaW5lcyBvciAke0RFRkFVTFRfTUFYX0JZVEVTIC8gMTAyNH1LQi4gVXNlIG9mZnNldC9saW1pdCBmb3IgbGFyZ2UgZmlsZXMuYCxcblx0XHRwYXJhbWV0ZXJzOiByZWFkU2NoZW1hLFxuXHRcdGV4ZWN1dGU6IGFzeW5jIChcblx0XHRcdF90b29sQ2FsbElkOiBzdHJpbmcsXG5cdFx0XHR7IHBhdGgsIG9mZnNldCwgbGltaXQgfTogeyBwYXRoOiBzdHJpbmc7IG9mZnNldD86IG51bWJlcjsgbGltaXQ/OiBudW1iZXIgfSxcblx0XHRcdHNpZ25hbD86IEFib3J0U2lnbmFsLFxuXHRcdCkgPT4ge1xuXHRcdFx0Y29uc3QgYWJzb2x1dGVQYXRoID0gcmVzb2x2ZVJlYWRQYXRoKHBhdGgsIGN3ZCk7XG5cdFx0XHRjb25zdCB0YXJnZXQgPSBjcmVhdGVSZWFkRmlsZVRhcmdldChwYXRoLCBhYnNvbHV0ZVBhdGgsIG9mZnNldCwgbGltaXQpO1xuXG5cdFx0XHRyZXR1cm4gbmV3IFByb21pc2U8eyBjb250ZW50OiAoVGV4dENvbnRlbnQgfCBJbWFnZUNvbnRlbnQpW107IGRldGFpbHM6IEhhc2hsaW5lUmVhZFRvb2xEZXRhaWxzIHwgdW5kZWZpbmVkIH0+KFxuXHRcdFx0XHQocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG5cdFx0XHRcdFx0aWYgKHNpZ25hbD8uYWJvcnRlZCkge1xuXHRcdFx0XHRcdFx0cmVqZWN0KG5ldyBFcnJvcihcIk9wZXJhdGlvbiBhYm9ydGVkXCIpKTtcblx0XHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRsZXQgYWJvcnRlZCA9IGZhbHNlO1xuXHRcdFx0XHRcdGNvbnN0IG9uQWJvcnQgPSAoKSA9PiB7XG5cdFx0XHRcdFx0XHRhYm9ydGVkID0gdHJ1ZTtcblx0XHRcdFx0XHRcdHJlamVjdChuZXcgRXJyb3IoXCJPcGVyYXRpb24gYWJvcnRlZFwiKSk7XG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0XHRpZiAoc2lnbmFsKSB7XG5cdFx0XHRcdFx0XHRzaWduYWwuYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQWJvcnQsIHsgb25jZTogdHJ1ZSB9KTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHQoYXN5bmMgKCkgPT4ge1xuXHRcdFx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRcdFx0YXdhaXQgb3BzLmFjY2VzcyhhYnNvbHV0ZVBhdGgpO1xuXG5cdFx0XHRcdFx0XHRcdGlmIChhYm9ydGVkKSByZXR1cm47XG5cblx0XHRcdFx0XHRcdFx0Y29uc3QgbWltZVR5cGUgPSBvcHMuZGV0ZWN0SW1hZ2VNaW1lVHlwZSA/IGF3YWl0IG9wcy5kZXRlY3RJbWFnZU1pbWVUeXBlKGFic29sdXRlUGF0aCkgOiB1bmRlZmluZWQ7XG5cblx0XHRcdFx0XHRcdFx0bGV0IGNvbnRlbnQ6IChUZXh0Q29udGVudCB8IEltYWdlQ29udGVudClbXTtcblx0XHRcdFx0XHRcdFx0bGV0IGRldGFpbHM6IEhhc2hsaW5lUmVhZFRvb2xEZXRhaWxzIHwgdW5kZWZpbmVkO1xuXG5cdFx0XHRcdFx0XHRcdGlmIChtaW1lVHlwZSkge1xuXHRcdFx0XHRcdFx0XHRcdC8vIEltYWdlIGhhbmRsaW5nIChpZGVudGljYWwgdG8gc3RhbmRhcmQgcmVhZCB0b29sKVxuXHRcdFx0XHRcdFx0XHRcdGNvbnN0IGJ1ZmZlciA9IGF3YWl0IG9wcy5yZWFkRmlsZShhYnNvbHV0ZVBhdGgpO1xuXHRcdFx0XHRcdFx0XHRcdGNvbnN0IGJhc2U2NCA9IGJ1ZmZlci50b1N0cmluZyhcImJhc2U2NFwiKTtcblxuXHRcdFx0XHRcdFx0XHRcdGlmIChhdXRvUmVzaXplSW1hZ2VzKSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRjb25zdCByZXNpemVkID0gYXdhaXQgcmVzaXplSW1hZ2UoeyB0eXBlOiBcImltYWdlXCIsIGRhdGE6IGJhc2U2NCwgbWltZVR5cGUgfSk7XG5cdFx0XHRcdFx0XHRcdFx0XHRjb25zdCBkaW1lbnNpb25Ob3RlID0gZm9ybWF0RGltZW5zaW9uTm90ZShyZXNpemVkKTtcblx0XHRcdFx0XHRcdFx0XHRcdGxldCB0ZXh0Tm90ZSA9IGBSZWFkIGltYWdlIGZpbGUgWyR7cmVzaXplZC5taW1lVHlwZX1dYDtcblx0XHRcdFx0XHRcdFx0XHRcdGlmIChkaW1lbnNpb25Ob3RlKSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRcdHRleHROb3RlICs9IGBcXG4ke2RpbWVuc2lvbk5vdGV9YDtcblx0XHRcdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0XHRcdGNvbnRlbnQgPSBbXG5cdFx0XHRcdFx0XHRcdFx0XHRcdHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IHRleHROb3RlIH0sXG5cdFx0XHRcdFx0XHRcdFx0XHRcdHsgdHlwZTogXCJpbWFnZVwiLCBkYXRhOiByZXNpemVkLmRhdGEsIG1pbWVUeXBlOiByZXNpemVkLm1pbWVUeXBlIH0sXG5cdFx0XHRcdFx0XHRcdFx0XHRdO1xuXHRcdFx0XHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRjb250ZW50ID0gW1xuXHRcdFx0XHRcdFx0XHRcdFx0XHR7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgUmVhZCBpbWFnZSBmaWxlIFske21pbWVUeXBlfV1gIH0sXG5cdFx0XHRcdFx0XHRcdFx0XHRcdHsgdHlwZTogXCJpbWFnZVwiLCBkYXRhOiBiYXNlNjQsIG1pbWVUeXBlIH0sXG5cdFx0XHRcdFx0XHRcdFx0XHRdO1xuXHRcdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdFx0XHQvLyBUZXh0IGZpbGUgXHUyMDE0IGZvcm1hdCB3aXRoIGhhc2hsaW5lIHByZWZpeGVzXG5cdFx0XHRcdFx0XHRcdFx0Y29uc3QgYnVmZmVyID0gYXdhaXQgb3BzLnJlYWRGaWxlKGFic29sdXRlUGF0aCk7XG5cdFx0XHRcdFx0XHRcdFx0Y29uc3QgdGV4dENvbnRlbnQgPSBidWZmZXIudG9TdHJpbmcoXCJ1dGYtOFwiKTtcblx0XHRcdFx0XHRcdFx0XHRjb25zdCBhbGxMaW5lcyA9IHRleHRDb250ZW50LnNwbGl0KFwiXFxuXCIpO1xuXHRcdFx0XHRcdFx0XHRcdGNvbnN0IHRvdGFsRmlsZUxpbmVzID0gYWxsTGluZXMubGVuZ3RoO1xuXG5cdFx0XHRcdFx0XHRcdFx0bGV0IHN0YXJ0TGluZSA9IG9mZnNldCA/IE1hdGgubWF4KDAsIG9mZnNldCAtIDEpIDogMDtcblxuXHRcdFx0XHRcdFx0XHRcdC8vIENsYW1wIG9mZnNldCB0byBmaWxlIGJvdW5kcyBpbnN0ZWFkIG9mIHRocm93aW5nICgjMzAwNylcblx0XHRcdFx0XHRcdFx0XHRsZXQgb2Zmc2V0Q2xhbXBlZCA9IGZhbHNlO1xuXHRcdFx0XHRcdFx0XHRcdGlmIChzdGFydExpbmUgPj0gYWxsTGluZXMubGVuZ3RoKSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRzdGFydExpbmUgPSBNYXRoLm1heCgwLCBhbGxMaW5lcy5sZW5ndGggLSAxKTtcblx0XHRcdFx0XHRcdFx0XHRcdG9mZnNldENsYW1wZWQgPSB0cnVlO1xuXHRcdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0XHRjb25zdCBzdGFydExpbmVEaXNwbGF5ID0gc3RhcnRMaW5lICsgMTtcblxuXHRcdFx0XHRcdFx0XHRcdGxldCBzZWxlY3RlZENvbnRlbnQ6IHN0cmluZztcblx0XHRcdFx0XHRcdFx0XHRsZXQgdXNlckxpbWl0ZWRMaW5lczogbnVtYmVyIHwgdW5kZWZpbmVkO1xuXHRcdFx0XHRcdFx0XHRcdGlmIChsaW1pdCAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRjb25zdCBlbmRMaW5lID0gTWF0aC5taW4oc3RhcnRMaW5lICsgbGltaXQsIGFsbExpbmVzLmxlbmd0aCk7XG5cdFx0XHRcdFx0XHRcdFx0XHRzZWxlY3RlZENvbnRlbnQgPSBhbGxMaW5lcy5zbGljZShzdGFydExpbmUsIGVuZExpbmUpLmpvaW4oXCJcXG5cIik7XG5cdFx0XHRcdFx0XHRcdFx0XHR1c2VyTGltaXRlZExpbmVzID0gZW5kTGluZSAtIHN0YXJ0TGluZTtcblx0XHRcdFx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0XHRcdFx0c2VsZWN0ZWRDb250ZW50ID0gYWxsTGluZXMuc2xpY2Uoc3RhcnRMaW5lKS5qb2luKFwiXFxuXCIpO1xuXHRcdFx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0XHRcdC8vIEFwcGx5IHRydW5jYXRpb25cblx0XHRcdFx0XHRcdFx0XHRjb25zdCB0cnVuY2F0aW9uID0gdHJ1bmNhdGVIZWFkKHNlbGVjdGVkQ29udGVudCk7XG5cblx0XHRcdFx0XHRcdFx0XHRsZXQgb3V0cHV0VGV4dDogc3RyaW5nO1xuXG5cdFx0XHRcdFx0XHRcdFx0aWYgKHRydW5jYXRpb24uZmlyc3RMaW5lRXhjZWVkc0xpbWl0KSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRjb25zdCBmaXJzdExpbmVTaXplID0gZm9ybWF0U2l6ZShCdWZmZXIuYnl0ZUxlbmd0aChhbGxMaW5lc1tzdGFydExpbmVdLCBcInV0Zi04XCIpKTtcblx0XHRcdFx0XHRcdFx0XHRcdG91dHB1dFRleHQgPSBgW0xpbmUgJHtzdGFydExpbmVEaXNwbGF5fSBpcyAke2ZpcnN0TGluZVNpemV9LCBleGNlZWRzICR7Zm9ybWF0U2l6ZShERUZBVUxUX01BWF9CWVRFUyl9IGxpbWl0LiBVc2UgYmFzaDogc2VkIC1uICcke3N0YXJ0TGluZURpc3BsYXl9cCcgJHtwYXRofSB8IGhlYWQgLWMgJHtERUZBVUxUX01BWF9CWVRFU31dYDtcblx0XHRcdFx0XHRcdFx0XHRcdGRldGFpbHMgPSB7IHRydW5jYXRpb24gfTtcblx0XHRcdFx0XHRcdFx0XHR9IGVsc2UgaWYgKHRydW5jYXRpb24udHJ1bmNhdGVkKSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRjb25zdCBlbmRMaW5lRGlzcGxheSA9IHN0YXJ0TGluZURpc3BsYXkgKyB0cnVuY2F0aW9uLm91dHB1dExpbmVzIC0gMTtcblx0XHRcdFx0XHRcdFx0XHRcdGNvbnN0IG5leHRPZmZzZXQgPSBlbmRMaW5lRGlzcGxheSArIDE7XG5cblx0XHRcdFx0XHRcdFx0XHRcdC8vIEZvcm1hdCB3aXRoIGhhc2hsaW5lIHByZWZpeGVzXG5cdFx0XHRcdFx0XHRcdFx0XHRvdXRwdXRUZXh0ID0gZm9ybWF0SGFzaExpbmVzKHRydW5jYXRpb24uY29udGVudCwgc3RhcnRMaW5lRGlzcGxheSk7XG5cblx0XHRcdFx0XHRcdFx0XHRcdGlmICh0cnVuY2F0aW9uLnRydW5jYXRlZEJ5ID09PSBcImxpbmVzXCIpIHtcblx0XHRcdFx0XHRcdFx0XHRcdFx0b3V0cHV0VGV4dCArPSBgXFxuXFxuW1Nob3dpbmcgbGluZXMgJHtzdGFydExpbmVEaXNwbGF5fS0ke2VuZExpbmVEaXNwbGF5fSBvZiAke3RvdGFsRmlsZUxpbmVzfS4gVXNlIG9mZnNldD0ke25leHRPZmZzZXR9IHRvIGNvbnRpbnVlLl1gO1xuXHRcdFx0XHRcdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdFx0XHRcdFx0b3V0cHV0VGV4dCArPSBgXFxuXFxuW1Nob3dpbmcgbGluZXMgJHtzdGFydExpbmVEaXNwbGF5fS0ke2VuZExpbmVEaXNwbGF5fSBvZiAke3RvdGFsRmlsZUxpbmVzfSAoJHtmb3JtYXRTaXplKERFRkFVTFRfTUFYX0JZVEVTKX0gbGltaXQpLiBVc2Ugb2Zmc2V0PSR7bmV4dE9mZnNldH0gdG8gY29udGludWUuXWA7XG5cdFx0XHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdFx0XHRkZXRhaWxzID0geyB0cnVuY2F0aW9uIH07XG5cdFx0XHRcdFx0XHRcdFx0fSBlbHNlIGlmICh1c2VyTGltaXRlZExpbmVzICE9PSB1bmRlZmluZWQgJiYgc3RhcnRMaW5lICsgdXNlckxpbWl0ZWRMaW5lcyA8IGFsbExpbmVzLmxlbmd0aCkge1xuXHRcdFx0XHRcdFx0XHRcdFx0Y29uc3QgcmVtYWluaW5nID0gYWxsTGluZXMubGVuZ3RoIC0gKHN0YXJ0TGluZSArIHVzZXJMaW1pdGVkTGluZXMpO1xuXHRcdFx0XHRcdFx0XHRcdFx0Y29uc3QgbmV4dE9mZnNldCA9IHN0YXJ0TGluZSArIHVzZXJMaW1pdGVkTGluZXMgKyAxO1xuXG5cdFx0XHRcdFx0XHRcdFx0XHRvdXRwdXRUZXh0ID0gZm9ybWF0SGFzaExpbmVzKHRydW5jYXRpb24uY29udGVudCwgc3RhcnRMaW5lRGlzcGxheSk7XG5cdFx0XHRcdFx0XHRcdFx0XHRvdXRwdXRUZXh0ICs9IGBcXG5cXG5bJHtyZW1haW5pbmd9IG1vcmUgbGluZXMgaW4gZmlsZS4gVXNlIG9mZnNldD0ke25leHRPZmZzZXR9IHRvIGNvbnRpbnVlLl1gO1xuXHRcdFx0XHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRvdXRwdXRUZXh0ID0gZm9ybWF0SGFzaExpbmVzKHRydW5jYXRpb24uY29udGVudCwgc3RhcnRMaW5lRGlzcGxheSk7XG5cdFx0XHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHRcdFx0Ly8gUHJlcGVuZCBjbGFtcCBub3RpY2Ugc28gdGhlIGFnZW50IGtub3dzIG9mZnNldCB3YXMgYWRqdXN0ZWRcblx0XHRcdFx0XHRcdFx0XHRpZiAob2Zmc2V0Q2xhbXBlZCkge1xuXHRcdFx0XHRcdFx0XHRcdFx0b3V0cHV0VGV4dCA9IGBbT2Zmc2V0ICR7b2Zmc2V0fSBiZXlvbmQgZW5kIG9mIGZpbGUgKCR7dG90YWxGaWxlTGluZXN9IGxpbmVzKS4gQ2xhbXBlZCB0byBsaW5lICR7c3RhcnRMaW5lRGlzcGxheX0uXVxcblxcbiR7b3V0cHV0VGV4dH1gO1xuXHRcdFx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0XHRcdGNvbnRlbnQgPSBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogb3V0cHV0VGV4dCB9XTtcblx0XHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHRcdGlmIChhYm9ydGVkKSByZXR1cm47XG5cblx0XHRcdFx0XHRcdFx0aWYgKHNpZ25hbCkgc2lnbmFsLnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkFib3J0KTtcblx0XHRcdFx0XHRcdFx0cmVzb2x2ZSh7IGNvbnRlbnQsIGRldGFpbHM6IHsgLi4uZGV0YWlscywgdGFyZ2V0IH0gfSk7XG5cdFx0XHRcdFx0XHR9IGNhdGNoIChlcnJvcjogYW55KSB7XG5cdFx0XHRcdFx0XHRcdGlmIChzaWduYWwpIHNpZ25hbC5yZW1vdmVFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25BYm9ydCk7XG5cdFx0XHRcdFx0XHRcdGlmICghYWJvcnRlZCkge1xuXHRcdFx0XHRcdFx0XHRcdHJlamVjdChlcnJvcik7XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9KSgpO1xuXHRcdFx0XHR9LFxuXHRcdFx0KTtcblx0XHR9LFxuXHR9O1xufVxuXG4vKiogRGVmYXVsdCBoYXNobGluZSByZWFkIHRvb2wgdXNpbmcgcHJvY2Vzcy5jd2QoKSAqL1xuZXhwb3J0IGNvbnN0IGhhc2hsaW5lUmVhZFRvb2wgPSBjcmVhdGVIYXNobGluZVJlYWRUb29sKHByb2Nlc3MuY3dkKCkpO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBWUEsU0FBc0IsWUFBWTtBQUNsQyxTQUFTLGlCQUFpQjtBQUMxQixTQUFTLFVBQVUsVUFBVSxZQUFZLGtCQUFrQjtBQUMzRCxTQUFTLHFCQUFxQixtQkFBbUI7QUFDakQsU0FBUyw0Q0FBNEM7QUFDckQsU0FBUyx1QkFBdUI7QUFDaEMsU0FBUyx1QkFBdUI7QUFDaEMsU0FBUyw0QkFBcUQ7QUFDOUQsU0FBUyxtQkFBbUIsbUJBQW1CLFlBQW1DLG9CQUFvQjtBQUV0RyxNQUFNLGFBQWEsS0FBSyxPQUFPO0FBQUEsRUFDOUIsTUFBTSxLQUFLLE9BQU8sRUFBRSxhQUFhLGtEQUFrRCxDQUFDO0FBQUEsRUFDcEYsUUFBUSxLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUs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
