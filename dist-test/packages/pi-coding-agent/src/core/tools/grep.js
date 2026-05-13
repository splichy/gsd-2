import { createInterface } from "node:readline";
import { Type } from "@sinclair/typebox";
import { spawn } from "child_process";
import { readFileSync, statSync } from "fs";
import path from "path";
import { ensureTool } from "../../utils/tools-manager.js";
import { resolveToCwd } from "./path-utils.js";
import { createToolTarget } from "./tool-target.js";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  GREP_MAX_LINE_LENGTH,
  truncateHead,
  truncateLine
} from "./truncate.js";
const grepSchema = Type.Object({
  pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
  path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
  glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
  literal: Type.Optional(
    Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" })
  ),
  context: Type.Optional(
    Type.Number({ description: "Number of lines to show before and after each match (default: 0)" })
  ),
  limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" }))
});
const DEFAULT_LIMIT = 100;
const defaultGrepOperations = {
  isDirectory: (p) => statSync(p).isDirectory(),
  readFile: (p) => readFileSync(p, "utf-8")
};
function createGrepTool(cwd, options) {
  const customOps = options?.operations;
  return {
    name: "grep",
    label: "grep",
    description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
    parameters: grepSchema,
    execute: async (_toolCallId, {
      pattern,
      path: searchDir,
      glob,
      ignoreCase,
      literal,
      context,
      limit
    }, signal) => {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("Operation aborted"));
          return;
        }
        let settled = false;
        const settle = (fn) => {
          if (!settled) {
            settled = true;
            fn();
          }
        };
        (async () => {
          try {
            const rgPath = await ensureTool("rg", true);
            if (!rgPath) {
              settle(() => reject(new Error("ripgrep (rg) is not available and could not be downloaded")));
              return;
            }
            const searchPath = resolveToCwd(searchDir || ".", cwd);
            const target = createToolTarget({
              kind: "search",
              action: "grep",
              inputPath: searchDir || ".",
              resolvedPath: searchPath,
              pattern,
              glob
            });
            const ops = customOps ?? defaultGrepOperations;
            let isDirectory;
            try {
              isDirectory = await ops.isDirectory(searchPath);
            } catch (_err) {
              settle(() => reject(new Error(`Path not found: ${searchPath}`)));
              return;
            }
            const contextValue = context && context > 0 ? context : 0;
            const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
            const formatPath = (filePath) => {
              if (isDirectory) {
                const relative = path.relative(searchPath, filePath);
                if (relative && !relative.startsWith("..")) {
                  return relative.replace(/\\/g, "/");
                }
              }
              return path.basename(filePath);
            };
            const fileCache = /* @__PURE__ */ new Map();
            const getFileLines = async (filePath) => {
              let lines = fileCache.get(filePath);
              if (!lines) {
                try {
                  const content = await ops.readFile(filePath);
                  lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
                } catch {
                  lines = [];
                }
                fileCache.set(filePath, lines);
              }
              return lines;
            };
            const args = ["--json", "--line-number", "--color=never", "--hidden"];
            if (ignoreCase) {
              args.push("--ignore-case");
            }
            if (literal) {
              args.push("--fixed-strings");
            }
            if (glob) {
              args.push("--glob", glob);
            }
            args.push(pattern, searchPath);
            const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
            const rl = createInterface({ input: child.stdout });
            let stderr = "";
            let matchCount = 0;
            let matchLimitReached = false;
            let linesTruncated = false;
            let aborted = false;
            let killedDueToLimit = false;
            const outputLines = [];
            const cleanup = () => {
              rl.close();
              signal?.removeEventListener("abort", onAbort);
            };
            const stopChild = (dueToLimit = false) => {
              if (!child.killed) {
                killedDueToLimit = dueToLimit;
                child.kill();
              }
            };
            const onAbort = () => {
              aborted = true;
              stopChild();
            };
            signal?.addEventListener("abort", onAbort, { once: true });
            child.stderr?.on("data", (chunk) => {
              stderr += chunk.toString();
            });
            const formatBlock = async (filePath, lineNumber) => {
              const relativePath = formatPath(filePath);
              const lines = await getFileLines(filePath);
              if (!lines.length) {
                return [`${relativePath}:${lineNumber}: (unable to read file)`];
              }
              const block = [];
              const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
              const end = contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber;
              for (let current = start; current <= end; current++) {
                const lineText = lines[current - 1] ?? "";
                const sanitized = lineText.replace(/\r/g, "");
                const isMatchLine = current === lineNumber;
                const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
                if (wasTruncated) {
                  linesTruncated = true;
                }
                if (isMatchLine) {
                  block.push(`${relativePath}:${current}: ${truncatedText}`);
                } else {
                  block.push(`${relativePath}-${current}- ${truncatedText}`);
                }
              }
              return block;
            };
            const matches = [];
            rl.on("line", (line) => {
              if (!line.trim() || matchCount >= effectiveLimit) {
                return;
              }
              let event;
              try {
                event = JSON.parse(line);
              } catch {
                return;
              }
              if (event.type === "match") {
                matchCount++;
                const filePath = event.data?.path?.text;
                const lineNumber = event.data?.line_number;
                if (filePath && typeof lineNumber === "number") {
                  matches.push({ filePath, lineNumber });
                }
                if (matchCount >= effectiveLimit) {
                  matchLimitReached = true;
                  stopChild(true);
                }
              }
            });
            child.on("error", (error) => {
              cleanup();
              settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
            });
            child.on("close", async (code) => {
              cleanup();
              if (aborted) {
                settle(() => reject(new Error("Operation aborted")));
                return;
              }
              if (!killedDueToLimit && code !== 0 && code !== 1) {
                const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`;
                settle(() => reject(new Error(errorMsg)));
                return;
              }
              if (matchCount === 0) {
                settle(
                  () => resolve({ content: [{ type: "text", text: "No matches found" }], details: { target } })
                );
                return;
              }
              for (const match of matches) {
                const block = await formatBlock(match.filePath, match.lineNumber);
                outputLines.push(...block);
              }
              const rawOutput = outputLines.join("\n");
              const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
              let output = truncation.content;
              const details = { target };
              const notices = [];
              if (matchLimitReached) {
                notices.push(
                  `${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`
                );
                details.matchLimitReached = effectiveLimit;
              }
              if (truncation.truncated) {
                notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
                details.truncation = truncation;
              }
              if (linesTruncated) {
                notices.push(
                  `Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`
                );
                details.linesTruncated = true;
              }
              if (notices.length > 0) {
                output += `

[${notices.join(". ")}]`;
              }
              settle(
                () => resolve({
                  content: [{ type: "text", text: output }],
                  details
                })
              );
            });
          } catch (err) {
            settle(() => reject(err));
          }
        })();
      });
    }
  };
}
const grepTool = createGrepTool(process.cwd());
export {
  createGrepTool,
  grepTool
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL3Rvb2xzL2dyZXAudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IGNyZWF0ZUludGVyZmFjZSB9IGZyb20gXCJub2RlOnJlYWRsaW5lXCI7XG5pbXBvcnQgdHlwZSB7IEFnZW50VG9vbCB9IGZyb20gXCJAZ3NkL3BpLWFnZW50LWNvcmVcIjtcbmltcG9ydCB7IHR5cGUgU3RhdGljLCBUeXBlIH0gZnJvbSBcIkBzaW5jbGFpci90eXBlYm94XCI7XG5pbXBvcnQgeyBzcGF3biB9IGZyb20gXCJjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgeyByZWFkRmlsZVN5bmMsIHN0YXRTeW5jIH0gZnJvbSBcImZzXCI7XG5pbXBvcnQgcGF0aCBmcm9tIFwicGF0aFwiO1xuaW1wb3J0IHsgZW5zdXJlVG9vbCB9IGZyb20gXCIuLi8uLi91dGlscy90b29scy1tYW5hZ2VyLmpzXCI7XG5pbXBvcnQgeyByZXNvbHZlVG9Dd2QgfSBmcm9tIFwiLi9wYXRoLXV0aWxzLmpzXCI7XG5pbXBvcnQgeyBjcmVhdGVUb29sVGFyZ2V0LCB0eXBlIFRvb2xUYXJnZXRNZXRhZGF0YSB9IGZyb20gXCIuL3Rvb2wtdGFyZ2V0LmpzXCI7XG5pbXBvcnQge1xuXHRERUZBVUxUX01BWF9CWVRFUyxcblx0Zm9ybWF0U2l6ZSxcblx0R1JFUF9NQVhfTElORV9MRU5HVEgsXG5cdHR5cGUgVHJ1bmNhdGlvblJlc3VsdCxcblx0dHJ1bmNhdGVIZWFkLFxuXHR0cnVuY2F0ZUxpbmUsXG59IGZyb20gXCIuL3RydW5jYXRlLmpzXCI7XG5cbmNvbnN0IGdyZXBTY2hlbWEgPSBUeXBlLk9iamVjdCh7XG5cdHBhdHRlcm46IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiU2VhcmNoIHBhdHRlcm4gKHJlZ2V4IG9yIGxpdGVyYWwgc3RyaW5nKVwiIH0pLFxuXHRwYXRoOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiRGlyZWN0b3J5IG9yIGZpbGUgdG8gc2VhcmNoIChkZWZhdWx0OiBjdXJyZW50IGRpcmVjdG9yeSlcIiB9KSksXG5cdGdsb2I6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJGaWx0ZXIgZmlsZXMgYnkgZ2xvYiBwYXR0ZXJuLCBlLmcuICcqLnRzJyBvciAnKiovKi5zcGVjLnRzJ1wiIH0pKSxcblx0aWdub3JlQ2FzZTogVHlwZS5PcHRpb25hbChUeXBlLkJvb2xlYW4oeyBkZXNjcmlwdGlvbjogXCJDYXNlLWluc2Vuc2l0aXZlIHNlYXJjaCAoZGVmYXVsdDogZmFsc2UpXCIgfSkpLFxuXHRsaXRlcmFsOiBUeXBlLk9wdGlvbmFsKFxuXHRcdFR5cGUuQm9vbGVhbih7IGRlc2NyaXB0aW9uOiBcIlRyZWF0IHBhdHRlcm4gYXMgbGl0ZXJhbCBzdHJpbmcgaW5zdGVhZCBvZiByZWdleCAoZGVmYXVsdDogZmFsc2UpXCIgfSksXG5cdCksXG5cdGNvbnRleHQ6IFR5cGUuT3B0aW9uYWwoXG5cdFx0VHlwZS5OdW1iZXIoeyBkZXNjcmlwdGlvbjogXCJOdW1iZXIgb2YgbGluZXMgdG8gc2hvdyBiZWZvcmUgYW5kIGFmdGVyIGVhY2ggbWF0Y2ggKGRlZmF1bHQ6IDApXCIgfSksXG5cdCksXG5cdGxpbWl0OiBUeXBlLk9wdGlvbmFsKFR5cGUuTnVtYmVyKHsgZGVzY3JpcHRpb246IFwiTWF4aW11bSBudW1iZXIgb2YgbWF0Y2hlcyB0byByZXR1cm4gKGRlZmF1bHQ6IDEwMClcIiB9KSksXG59KTtcblxuZXhwb3J0IHR5cGUgR3JlcFRvb2xJbnB1dCA9IFN0YXRpYzx0eXBlb2YgZ3JlcFNjaGVtYT47XG5cbmNvbnN0IERFRkFVTFRfTElNSVQgPSAxMDA7XG5cbmV4cG9ydCBpbnRlcmZhY2UgR3JlcFRvb2xEZXRhaWxzIHtcblx0dGFyZ2V0PzogVG9vbFRhcmdldE1ldGFkYXRhO1xuXHR0cnVuY2F0aW9uPzogVHJ1bmNhdGlvblJlc3VsdDtcblx0bWF0Y2hMaW1pdFJlYWNoZWQ/OiBudW1iZXI7XG5cdGxpbmVzVHJ1bmNhdGVkPzogYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBQbHVnZ2FibGUgb3BlcmF0aW9ucyBmb3IgdGhlIGdyZXAgdG9vbC5cbiAqIE92ZXJyaWRlIHRoZXNlIHRvIGRlbGVnYXRlIHNlYXJjaCB0byByZW1vdGUgc3lzdGVtcyAoZS5nLiwgU1NIKS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBHcmVwT3BlcmF0aW9ucyB7XG5cdC8qKiBDaGVjayBpZiBwYXRoIGlzIGEgZGlyZWN0b3J5LiBUaHJvd3MgaWYgcGF0aCBkb2Vzbid0IGV4aXN0LiAqL1xuXHRpc0RpcmVjdG9yeTogKGFic29sdXRlUGF0aDogc3RyaW5nKSA9PiBQcm9taXNlPGJvb2xlYW4+IHwgYm9vbGVhbjtcblx0LyoqIFJlYWQgZmlsZSBjb250ZW50cyBmb3IgY29udGV4dCBsaW5lcyAqL1xuXHRyZWFkRmlsZTogKGFic29sdXRlUGF0aDogc3RyaW5nKSA9PiBQcm9taXNlPHN0cmluZz4gfCBzdHJpbmc7XG59XG5cbmNvbnN0IGRlZmF1bHRHcmVwT3BlcmF0aW9uczogR3JlcE9wZXJhdGlvbnMgPSB7XG5cdGlzRGlyZWN0b3J5OiAocCkgPT4gc3RhdFN5bmMocCkuaXNEaXJlY3RvcnkoKSxcblx0cmVhZEZpbGU6IChwKSA9PiByZWFkRmlsZVN5bmMocCwgXCJ1dGYtOFwiKSxcbn07XG5cbmV4cG9ydCBpbnRlcmZhY2UgR3JlcFRvb2xPcHRpb25zIHtcblx0LyoqIEN1c3RvbSBvcGVyYXRpb25zIGZvciBncmVwLiBEZWZhdWx0OiBsb2NhbCBmaWxlc3lzdGVtICsgcmlwZ3JlcCAqL1xuXHRvcGVyYXRpb25zPzogR3JlcE9wZXJhdGlvbnM7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVHcmVwVG9vbChjd2Q6IHN0cmluZywgb3B0aW9ucz86IEdyZXBUb29sT3B0aW9ucyk6IEFnZW50VG9vbDx0eXBlb2YgZ3JlcFNjaGVtYT4ge1xuXHRjb25zdCBjdXN0b21PcHMgPSBvcHRpb25zPy5vcGVyYXRpb25zO1xuXG5cdHJldHVybiB7XG5cdFx0bmFtZTogXCJncmVwXCIsXG5cdFx0bGFiZWw6IFwiZ3JlcFwiLFxuXHRcdGRlc2NyaXB0aW9uOiBgU2VhcmNoIGZpbGUgY29udGVudHMgZm9yIGEgcGF0dGVybi4gUmV0dXJucyBtYXRjaGluZyBsaW5lcyB3aXRoIGZpbGUgcGF0aHMgYW5kIGxpbmUgbnVtYmVycy4gUmVzcGVjdHMgLmdpdGlnbm9yZS4gT3V0cHV0IGlzIHRydW5jYXRlZCB0byAke0RFRkFVTFRfTElNSVR9IG1hdGNoZXMgb3IgJHtERUZBVUxUX01BWF9CWVRFUyAvIDEwMjR9S0IgKHdoaWNoZXZlciBpcyBoaXQgZmlyc3QpLiBMb25nIGxpbmVzIGFyZSB0cnVuY2F0ZWQgdG8gJHtHUkVQX01BWF9MSU5FX0xFTkdUSH0gY2hhcnMuYCxcblx0XHRwYXJhbWV0ZXJzOiBncmVwU2NoZW1hLFxuXHRcdGV4ZWN1dGU6IGFzeW5jIChcblx0XHRcdF90b29sQ2FsbElkOiBzdHJpbmcsXG5cdFx0XHR7XG5cdFx0XHRcdHBhdHRlcm4sXG5cdFx0XHRcdHBhdGg6IHNlYXJjaERpcixcblx0XHRcdFx0Z2xvYixcblx0XHRcdFx0aWdub3JlQ2FzZSxcblx0XHRcdFx0bGl0ZXJhbCxcblx0XHRcdFx0Y29udGV4dCxcblx0XHRcdFx0bGltaXQsXG5cdFx0XHR9OiB7XG5cdFx0XHRcdHBhdHRlcm46IHN0cmluZztcblx0XHRcdFx0cGF0aD86IHN0cmluZztcblx0XHRcdFx0Z2xvYj86IHN0cmluZztcblx0XHRcdFx0aWdub3JlQ2FzZT86IGJvb2xlYW47XG5cdFx0XHRcdGxpdGVyYWw/OiBib29sZWFuO1xuXHRcdFx0XHRjb250ZXh0PzogbnVtYmVyO1xuXHRcdFx0XHRsaW1pdD86IG51bWJlcjtcblx0XHRcdH0sXG5cdFx0XHRzaWduYWw/OiBBYm9ydFNpZ25hbCxcblx0XHQpID0+IHtcblx0XHRcdHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG5cdFx0XHRcdGlmIChzaWduYWw/LmFib3J0ZWQpIHtcblx0XHRcdFx0XHRyZWplY3QobmV3IEVycm9yKFwiT3BlcmF0aW9uIGFib3J0ZWRcIikpO1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGxldCBzZXR0bGVkID0gZmFsc2U7XG5cdFx0XHRcdGNvbnN0IHNldHRsZSA9IChmbjogKCkgPT4gdm9pZCkgPT4ge1xuXHRcdFx0XHRcdGlmICghc2V0dGxlZCkge1xuXHRcdFx0XHRcdFx0c2V0dGxlZCA9IHRydWU7XG5cdFx0XHRcdFx0XHRmbigpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fTtcblxuXHRcdFx0XHQoYXN5bmMgKCkgPT4ge1xuXHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHRjb25zdCByZ1BhdGggPSBhd2FpdCBlbnN1cmVUb29sKFwicmdcIiwgdHJ1ZSk7XG5cdFx0XHRcdFx0XHRpZiAoIXJnUGF0aCkge1xuXHRcdFx0XHRcdFx0XHRzZXR0bGUoKCkgPT4gcmVqZWN0KG5ldyBFcnJvcihcInJpcGdyZXAgKHJnKSBpcyBub3QgYXZhaWxhYmxlIGFuZCBjb3VsZCBub3QgYmUgZG93bmxvYWRlZFwiKSkpO1xuXHRcdFx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdGNvbnN0IHNlYXJjaFBhdGggPSByZXNvbHZlVG9Dd2Qoc2VhcmNoRGlyIHx8IFwiLlwiLCBjd2QpO1xuXHRcdFx0XHRcdFx0Y29uc3QgdGFyZ2V0ID0gY3JlYXRlVG9vbFRhcmdldCh7XG5cdFx0XHRcdFx0XHRcdGtpbmQ6IFwic2VhcmNoXCIsXG5cdFx0XHRcdFx0XHRcdGFjdGlvbjogXCJncmVwXCIsXG5cdFx0XHRcdFx0XHRcdGlucHV0UGF0aDogc2VhcmNoRGlyIHx8IFwiLlwiLFxuXHRcdFx0XHRcdFx0XHRyZXNvbHZlZFBhdGg6IHNlYXJjaFBhdGgsXG5cdFx0XHRcdFx0XHRcdHBhdHRlcm4sXG5cdFx0XHRcdFx0XHRcdGdsb2IsXG5cdFx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHRcdGNvbnN0IG9wcyA9IGN1c3RvbU9wcyA/PyBkZWZhdWx0R3JlcE9wZXJhdGlvbnM7XG5cblx0XHRcdFx0XHRcdGxldCBpc0RpcmVjdG9yeTogYm9vbGVhbjtcblx0XHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHRcdGlzRGlyZWN0b3J5ID0gYXdhaXQgb3BzLmlzRGlyZWN0b3J5KHNlYXJjaFBhdGgpO1xuXHRcdFx0XHRcdFx0fSBjYXRjaCAoX2Vycikge1xuXHRcdFx0XHRcdFx0XHRzZXR0bGUoKCkgPT4gcmVqZWN0KG5ldyBFcnJvcihgUGF0aCBub3QgZm91bmQ6ICR7c2VhcmNoUGF0aH1gKSkpO1xuXHRcdFx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRjb25zdCBjb250ZXh0VmFsdWUgPSBjb250ZXh0ICYmIGNvbnRleHQgPiAwID8gY29udGV4dCA6IDA7XG5cdFx0XHRcdFx0XHRjb25zdCBlZmZlY3RpdmVMaW1pdCA9IE1hdGgubWF4KDEsIGxpbWl0ID8/IERFRkFVTFRfTElNSVQpO1xuXG5cdFx0XHRcdFx0XHRjb25zdCBmb3JtYXRQYXRoID0gKGZpbGVQYXRoOiBzdHJpbmcpOiBzdHJpbmcgPT4ge1xuXHRcdFx0XHRcdFx0XHRpZiAoaXNEaXJlY3RvcnkpIHtcblx0XHRcdFx0XHRcdFx0XHRjb25zdCByZWxhdGl2ZSA9IHBhdGgucmVsYXRpdmUoc2VhcmNoUGF0aCwgZmlsZVBhdGgpO1xuXHRcdFx0XHRcdFx0XHRcdGlmIChyZWxhdGl2ZSAmJiAhcmVsYXRpdmUuc3RhcnRzV2l0aChcIi4uXCIpKSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRyZXR1cm4gcmVsYXRpdmUucmVwbGFjZSgvXFxcXC9nLCBcIi9cIik7XG5cdFx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdHJldHVybiBwYXRoLmJhc2VuYW1lKGZpbGVQYXRoKTtcblx0XHRcdFx0XHRcdH07XG5cblx0XHRcdFx0XHRcdGNvbnN0IGZpbGVDYWNoZSA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmdbXT4oKTtcblx0XHRcdFx0XHRcdGNvbnN0IGdldEZpbGVMaW5lcyA9IGFzeW5jIChmaWxlUGF0aDogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmdbXT4gPT4ge1xuXHRcdFx0XHRcdFx0XHRsZXQgbGluZXMgPSBmaWxlQ2FjaGUuZ2V0KGZpbGVQYXRoKTtcblx0XHRcdFx0XHRcdFx0aWYgKCFsaW5lcykge1xuXHRcdFx0XHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRjb25zdCBjb250ZW50ID0gYXdhaXQgb3BzLnJlYWRGaWxlKGZpbGVQYXRoKTtcblx0XHRcdFx0XHRcdFx0XHRcdGxpbmVzID0gY29udGVudC5yZXBsYWNlKC9cXHJcXG4vZywgXCJcXG5cIikucmVwbGFjZSgvXFxyL2csIFwiXFxuXCIpLnNwbGl0KFwiXFxuXCIpO1xuXHRcdFx0XHRcdFx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHRcdFx0XHRcdFx0bGluZXMgPSBbXTtcblx0XHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdFx0ZmlsZUNhY2hlLnNldChmaWxlUGF0aCwgbGluZXMpO1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdHJldHVybiBsaW5lcztcblx0XHRcdFx0XHRcdH07XG5cblx0XHRcdFx0XHRcdGNvbnN0IGFyZ3M6IHN0cmluZ1tdID0gW1wiLS1qc29uXCIsIFwiLS1saW5lLW51bWJlclwiLCBcIi0tY29sb3I9bmV2ZXJcIiwgXCItLWhpZGRlblwiXTtcblxuXHRcdFx0XHRcdFx0aWYgKGlnbm9yZUNhc2UpIHtcblx0XHRcdFx0XHRcdFx0YXJncy5wdXNoKFwiLS1pZ25vcmUtY2FzZVwiKTtcblx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0aWYgKGxpdGVyYWwpIHtcblx0XHRcdFx0XHRcdFx0YXJncy5wdXNoKFwiLS1maXhlZC1zdHJpbmdzXCIpO1xuXHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHRpZiAoZ2xvYikge1xuXHRcdFx0XHRcdFx0XHRhcmdzLnB1c2goXCItLWdsb2JcIiwgZ2xvYik7XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdGFyZ3MucHVzaChwYXR0ZXJuLCBzZWFyY2hQYXRoKTtcblxuXHRcdFx0XHRcdFx0Y29uc3QgY2hpbGQgPSBzcGF3bihyZ1BhdGgsIGFyZ3MsIHsgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdIH0pO1xuXHRcdFx0XHRcdFx0Y29uc3QgcmwgPSBjcmVhdGVJbnRlcmZhY2UoeyBpbnB1dDogY2hpbGQuc3Rkb3V0IH0pO1xuXHRcdFx0XHRcdFx0bGV0IHN0ZGVyciA9IFwiXCI7XG5cdFx0XHRcdFx0XHRsZXQgbWF0Y2hDb3VudCA9IDA7XG5cdFx0XHRcdFx0XHRsZXQgbWF0Y2hMaW1pdFJlYWNoZWQgPSBmYWxzZTtcblx0XHRcdFx0XHRcdGxldCBsaW5lc1RydW5jYXRlZCA9IGZhbHNlO1xuXHRcdFx0XHRcdFx0bGV0IGFib3J0ZWQgPSBmYWxzZTtcblx0XHRcdFx0XHRcdGxldCBraWxsZWREdWVUb0xpbWl0ID0gZmFsc2U7XG5cdFx0XHRcdFx0XHRjb25zdCBvdXRwdXRMaW5lczogc3RyaW5nW10gPSBbXTtcblxuXHRcdFx0XHRcdFx0Y29uc3QgY2xlYW51cCA9ICgpID0+IHtcblx0XHRcdFx0XHRcdFx0cmwuY2xvc2UoKTtcblx0XHRcdFx0XHRcdFx0c2lnbmFsPy5yZW1vdmVFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25BYm9ydCk7XG5cdFx0XHRcdFx0XHR9O1xuXG5cdFx0XHRcdFx0XHRjb25zdCBzdG9wQ2hpbGQgPSAoZHVlVG9MaW1pdDogYm9vbGVhbiA9IGZhbHNlKSA9PiB7XG5cdFx0XHRcdFx0XHRcdGlmICghY2hpbGQua2lsbGVkKSB7XG5cdFx0XHRcdFx0XHRcdFx0a2lsbGVkRHVlVG9MaW1pdCA9IGR1ZVRvTGltaXQ7XG5cdFx0XHRcdFx0XHRcdFx0Y2hpbGQua2lsbCgpO1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHR9O1xuXG5cdFx0XHRcdFx0XHRjb25zdCBvbkFib3J0ID0gKCkgPT4ge1xuXHRcdFx0XHRcdFx0XHRhYm9ydGVkID0gdHJ1ZTtcblx0XHRcdFx0XHRcdFx0c3RvcENoaWxkKCk7XG5cdFx0XHRcdFx0XHR9O1xuXG5cdFx0XHRcdFx0XHRzaWduYWw/LmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkFib3J0LCB7IG9uY2U6IHRydWUgfSk7XG5cblx0XHRcdFx0XHRcdGNoaWxkLnN0ZGVycj8ub24oXCJkYXRhXCIsIChjaHVuaykgPT4ge1xuXHRcdFx0XHRcdFx0XHRzdGRlcnIgKz0gY2h1bmsudG9TdHJpbmcoKTtcblx0XHRcdFx0XHRcdH0pO1xuXG5cdFx0XHRcdFx0XHRjb25zdCBmb3JtYXRCbG9jayA9IGFzeW5jIChmaWxlUGF0aDogc3RyaW5nLCBsaW5lTnVtYmVyOiBudW1iZXIpOiBQcm9taXNlPHN0cmluZ1tdPiA9PiB7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IHJlbGF0aXZlUGF0aCA9IGZvcm1hdFBhdGgoZmlsZVBhdGgpO1xuXHRcdFx0XHRcdFx0XHRjb25zdCBsaW5lcyA9IGF3YWl0IGdldEZpbGVMaW5lcyhmaWxlUGF0aCk7XG5cdFx0XHRcdFx0XHRcdGlmICghbGluZXMubGVuZ3RoKSB7XG5cdFx0XHRcdFx0XHRcdFx0cmV0dXJuIFtgJHtyZWxhdGl2ZVBhdGh9OiR7bGluZU51bWJlcn06ICh1bmFibGUgdG8gcmVhZCBmaWxlKWBdO1xuXHRcdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdFx0Y29uc3QgYmxvY2s6IHN0cmluZ1tdID0gW107XG5cdFx0XHRcdFx0XHRcdGNvbnN0IHN0YXJ0ID0gY29udGV4dFZhbHVlID4gMCA/IE1hdGgubWF4KDEsIGxpbmVOdW1iZXIgLSBjb250ZXh0VmFsdWUpIDogbGluZU51bWJlcjtcblx0XHRcdFx0XHRcdFx0Y29uc3QgZW5kID0gY29udGV4dFZhbHVlID4gMCA/IE1hdGgubWluKGxpbmVzLmxlbmd0aCwgbGluZU51bWJlciArIGNvbnRleHRWYWx1ZSkgOiBsaW5lTnVtYmVyO1xuXG5cdFx0XHRcdFx0XHRcdGZvciAobGV0IGN1cnJlbnQgPSBzdGFydDsgY3VycmVudCA8PSBlbmQ7IGN1cnJlbnQrKykge1xuXHRcdFx0XHRcdFx0XHRcdGNvbnN0IGxpbmVUZXh0ID0gbGluZXNbY3VycmVudCAtIDFdID8/IFwiXCI7XG5cdFx0XHRcdFx0XHRcdFx0Y29uc3Qgc2FuaXRpemVkID0gbGluZVRleHQucmVwbGFjZSgvXFxyL2csIFwiXCIpO1xuXHRcdFx0XHRcdFx0XHRcdGNvbnN0IGlzTWF0Y2hMaW5lID0gY3VycmVudCA9PT0gbGluZU51bWJlcjtcblxuXHRcdFx0XHRcdFx0XHRcdC8vIFRydW5jYXRlIGxvbmcgbGluZXNcblx0XHRcdFx0XHRcdFx0XHRjb25zdCB7IHRleHQ6IHRydW5jYXRlZFRleHQsIHdhc1RydW5jYXRlZCB9ID0gdHJ1bmNhdGVMaW5lKHNhbml0aXplZCk7XG5cdFx0XHRcdFx0XHRcdFx0aWYgKHdhc1RydW5jYXRlZCkge1xuXHRcdFx0XHRcdFx0XHRcdFx0bGluZXNUcnVuY2F0ZWQgPSB0cnVlO1xuXHRcdFx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0XHRcdGlmIChpc01hdGNoTGluZSkge1xuXHRcdFx0XHRcdFx0XHRcdFx0YmxvY2sucHVzaChgJHtyZWxhdGl2ZVBhdGh9OiR7Y3VycmVudH06ICR7dHJ1bmNhdGVkVGV4dH1gKTtcblx0XHRcdFx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0XHRcdFx0YmxvY2sucHVzaChgJHtyZWxhdGl2ZVBhdGh9LSR7Y3VycmVudH0tICR7dHJ1bmNhdGVkVGV4dH1gKTtcblx0XHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0XHRyZXR1cm4gYmxvY2s7XG5cdFx0XHRcdFx0XHR9O1xuXG5cdFx0XHRcdFx0XHQvLyBDb2xsZWN0IG1hdGNoZXMgZHVyaW5nIHN0cmVhbWluZywgZm9ybWF0IGFmdGVyXG5cdFx0XHRcdFx0XHRjb25zdCBtYXRjaGVzOiBBcnJheTx7IGZpbGVQYXRoOiBzdHJpbmc7IGxpbmVOdW1iZXI6IG51bWJlciB9PiA9IFtdO1xuXG5cdFx0XHRcdFx0XHRybC5vbihcImxpbmVcIiwgKGxpbmUpID0+IHtcblx0XHRcdFx0XHRcdFx0aWYgKCFsaW5lLnRyaW0oKSB8fCBtYXRjaENvdW50ID49IGVmZmVjdGl2ZUxpbWl0KSB7XG5cdFx0XHRcdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdFx0bGV0IGV2ZW50OiBhbnk7XG5cdFx0XHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHRcdFx0ZXZlbnQgPSBKU09OLnBhcnNlKGxpbmUpO1xuXHRcdFx0XHRcdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0XHRpZiAoZXZlbnQudHlwZSA9PT0gXCJtYXRjaFwiKSB7XG5cdFx0XHRcdFx0XHRcdFx0bWF0Y2hDb3VudCsrO1xuXHRcdFx0XHRcdFx0XHRcdGNvbnN0IGZpbGVQYXRoID0gZXZlbnQuZGF0YT8ucGF0aD8udGV4dDtcblx0XHRcdFx0XHRcdFx0XHRjb25zdCBsaW5lTnVtYmVyID0gZXZlbnQuZGF0YT8ubGluZV9udW1iZXI7XG5cblx0XHRcdFx0XHRcdFx0XHRpZiAoZmlsZVBhdGggJiYgdHlwZW9mIGxpbmVOdW1iZXIgPT09IFwibnVtYmVyXCIpIHtcblx0XHRcdFx0XHRcdFx0XHRcdG1hdGNoZXMucHVzaCh7IGZpbGVQYXRoLCBsaW5lTnVtYmVyIH0pO1xuXHRcdFx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0XHRcdGlmIChtYXRjaENvdW50ID49IGVmZmVjdGl2ZUxpbWl0KSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRtYXRjaExpbWl0UmVhY2hlZCA9IHRydWU7XG5cdFx0XHRcdFx0XHRcdFx0XHRzdG9wQ2hpbGQodHJ1ZSk7XG5cdFx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHR9KTtcblxuXHRcdFx0XHRcdFx0Y2hpbGQub24oXCJlcnJvclwiLCAoZXJyb3IpID0+IHtcblx0XHRcdFx0XHRcdFx0Y2xlYW51cCgpO1xuXHRcdFx0XHRcdFx0XHRzZXR0bGUoKCkgPT4gcmVqZWN0KG5ldyBFcnJvcihgRmFpbGVkIHRvIHJ1biByaXBncmVwOiAke2Vycm9yLm1lc3NhZ2V9YCkpKTtcblx0XHRcdFx0XHRcdH0pO1xuXG5cdFx0XHRcdFx0XHRjaGlsZC5vbihcImNsb3NlXCIsIGFzeW5jIChjb2RlKSA9PiB7XG5cdFx0XHRcdFx0XHRcdGNsZWFudXAoKTtcblxuXHRcdFx0XHRcdFx0XHRpZiAoYWJvcnRlZCkge1xuXHRcdFx0XHRcdFx0XHRcdHNldHRsZSgoKSA9PiByZWplY3QobmV3IEVycm9yKFwiT3BlcmF0aW9uIGFib3J0ZWRcIikpKTtcblx0XHRcdFx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0XHRpZiAoIWtpbGxlZER1ZVRvTGltaXQgJiYgY29kZSAhPT0gMCAmJiBjb2RlICE9PSAxKSB7XG5cdFx0XHRcdFx0XHRcdFx0Y29uc3QgZXJyb3JNc2cgPSBzdGRlcnIudHJpbSgpIHx8IGByaXBncmVwIGV4aXRlZCB3aXRoIGNvZGUgJHtjb2RlfWA7XG5cdFx0XHRcdFx0XHRcdFx0c2V0dGxlKCgpID0+IHJlamVjdChuZXcgRXJyb3IoZXJyb3JNc2cpKSk7XG5cdFx0XHRcdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdFx0aWYgKG1hdGNoQ291bnQgPT09IDApIHtcblx0XHRcdFx0XHRcdFx0XHRzZXR0bGUoKCkgPT5cblx0XHRcdFx0XHRcdFx0XHRcdHJlc29sdmUoeyBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJObyBtYXRjaGVzIGZvdW5kXCIgfV0sIGRldGFpbHM6IHsgdGFyZ2V0IH0gfSksXG5cdFx0XHRcdFx0XHRcdFx0KTtcblx0XHRcdFx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0XHQvLyBGb3JtYXQgbWF0Y2hlcyAoYXN5bmMgdG8gc3VwcG9ydCByZW1vdGUgZmlsZSByZWFkaW5nKVxuXHRcdFx0XHRcdFx0XHRmb3IgKGNvbnN0IG1hdGNoIG9mIG1hdGNoZXMpIHtcblx0XHRcdFx0XHRcdFx0XHRjb25zdCBibG9jayA9IGF3YWl0IGZvcm1hdEJsb2NrKG1hdGNoLmZpbGVQYXRoLCBtYXRjaC5saW5lTnVtYmVyKTtcblx0XHRcdFx0XHRcdFx0XHRvdXRwdXRMaW5lcy5wdXNoKC4uLmJsb2NrKTtcblx0XHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHRcdC8vIEFwcGx5IGJ5dGUgdHJ1bmNhdGlvbiAobm8gbGluZSBsaW1pdCBzaW5jZSB3ZSBhbHJlYWR5IGhhdmUgbWF0Y2ggbGltaXQpXG5cdFx0XHRcdFx0XHRcdGNvbnN0IHJhd091dHB1dCA9IG91dHB1dExpbmVzLmpvaW4oXCJcXG5cIik7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IHRydW5jYXRpb24gPSB0cnVuY2F0ZUhlYWQocmF3T3V0cHV0LCB7IG1heExpbmVzOiBOdW1iZXIuTUFYX1NBRkVfSU5URUdFUiB9KTtcblxuXHRcdFx0XHRcdFx0XHRsZXQgb3V0cHV0ID0gdHJ1bmNhdGlvbi5jb250ZW50O1xuXHRcdFx0XHRcdFx0XHRjb25zdCBkZXRhaWxzOiBHcmVwVG9vbERldGFpbHMgPSB7IHRhcmdldCB9O1xuXG5cdFx0XHRcdFx0XHRcdC8vIEJ1aWxkIG5vdGljZXNcblx0XHRcdFx0XHRcdFx0Y29uc3Qgbm90aWNlczogc3RyaW5nW10gPSBbXTtcblxuXHRcdFx0XHRcdFx0XHRpZiAobWF0Y2hMaW1pdFJlYWNoZWQpIHtcblx0XHRcdFx0XHRcdFx0XHRub3RpY2VzLnB1c2goXG5cdFx0XHRcdFx0XHRcdFx0XHRgJHtlZmZlY3RpdmVMaW1pdH0gbWF0Y2hlcyBsaW1pdCByZWFjaGVkLiBVc2UgbGltaXQ9JHtlZmZlY3RpdmVMaW1pdCAqIDJ9IGZvciBtb3JlLCBvciByZWZpbmUgcGF0dGVybmAsXG5cdFx0XHRcdFx0XHRcdFx0KTtcblx0XHRcdFx0XHRcdFx0XHRkZXRhaWxzLm1hdGNoTGltaXRSZWFjaGVkID0gZWZmZWN0aXZlTGltaXQ7XG5cdFx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0XHRpZiAodHJ1bmNhdGlvbi50cnVuY2F0ZWQpIHtcblx0XHRcdFx0XHRcdFx0XHRub3RpY2VzLnB1c2goYCR7Zm9ybWF0U2l6ZShERUZBVUxUX01BWF9CWVRFUyl9IGxpbWl0IHJlYWNoZWRgKTtcblx0XHRcdFx0XHRcdFx0XHRkZXRhaWxzLnRydW5jYXRpb24gPSB0cnVuY2F0aW9uO1xuXHRcdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdFx0aWYgKGxpbmVzVHJ1bmNhdGVkKSB7XG5cdFx0XHRcdFx0XHRcdFx0bm90aWNlcy5wdXNoKFxuXHRcdFx0XHRcdFx0XHRcdFx0YFNvbWUgbGluZXMgdHJ1bmNhdGVkIHRvICR7R1JFUF9NQVhfTElORV9MRU5HVEh9IGNoYXJzLiBVc2UgcmVhZCB0b29sIHRvIHNlZSBmdWxsIGxpbmVzYCxcblx0XHRcdFx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdFx0XHRcdGRldGFpbHMubGluZXNUcnVuY2F0ZWQgPSB0cnVlO1xuXHRcdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdFx0aWYgKG5vdGljZXMubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRcdFx0XHRcdG91dHB1dCArPSBgXFxuXFxuWyR7bm90aWNlcy5qb2luKFwiLiBcIil9XWA7XG5cdFx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0XHRzZXR0bGUoKCkgPT5cblx0XHRcdFx0XHRcdFx0XHRyZXNvbHZlKHtcblx0XHRcdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBvdXRwdXQgfV0sXG5cdFx0XHRcdFx0XHRcdFx0XHRkZXRhaWxzLFxuXHRcdFx0XHRcdFx0XHRcdH0pLFxuXHRcdFx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHRcdFx0XHRzZXR0bGUoKCkgPT4gcmVqZWN0KGVyciBhcyBFcnJvcikpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fSkoKTtcblx0XHRcdH0pO1xuXHRcdH0sXG5cdH07XG59XG5cbi8qKiBEZWZhdWx0IGdyZXAgdG9vbCB1c2luZyBwcm9jZXNzLmN3ZCgpIC0gZm9yIGJhY2t3YXJkcyBjb21wYXRpYmlsaXR5ICovXG5leHBvcnQgY29uc3QgZ3JlcFRvb2wgPSBjcmVhdGVHcmVwVG9vbChwcm9jZXNzLmN3ZCgpKTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsdUJBQXVCO0FBRWhDLFNBQXNCLFlBQVk7QUFDbEMsU0FBUyxhQUFhO0FBQ3RCLFNBQVMsY0FBYyxnQkFBZ0I7QUFDdkMsT0FBTyxVQUFVO0FBQ2pCLFNBQVMsa0JBQWtCO0FBQzNCLFNBQVMsb0JBQW9CO0FBQzdCLFNBQVMsd0JBQWlEO0FBQzFEO0FBQUEsRUFDQztBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFFQTtBQUFBLEVBQ0E7QUFBQSxPQUNNO0FBRVAsTUFBTSxhQUFhLEtBQUssT0FBTztBQUFBLEVBQzlCLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSwyQ0FBMkMsQ0FBQztBQUFBLEVBQ2hGLE1BQU0sS0FBSyxTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEsMkRBQTJELENBQUMsQ0FBQztBQUFBLEVBQzVHLE1BQU0sS0FBSyxTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEsOERBQThELENBQUMsQ0FBQztBQUFBLEVBQy9HLFlBQVksS0FBSyxTQUFTLEtBQUssUUFBUSxFQUFFLGFBQWEsMkNBQTJDLENBQUMsQ0FBQztBQUFBLEVBQ25HLFNBQVMsS0FBSztBQUFBLElBQ2IsS0FBSyxRQUFRLEVBQUUsYUFBYSxvRUFBb0UsQ0FBQztBQUFBLEVBQ2xHO0FBQUEsRUFDQSxTQUFTLEtBQUs7QUFBQSxJQUNiLEtBQUssT0FBTyxF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
