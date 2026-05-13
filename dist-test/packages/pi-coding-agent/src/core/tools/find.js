import { glob as nativeGlob } from "@gsd/native/glob";
import { Type } from "@sinclair/typebox";
import { existsSync } from "fs";
import path from "path";
import { FIND_DEFAULT_LIMIT } from "../constants.js";
import { resolveToCwd } from "./path-utils.js";
import { createToolTarget } from "./tool-target.js";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.js";
const findSchema = Type.Object({
  pattern: Type.String({
    description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'"
  }),
  path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" }))
});
const DEFAULT_LIMIT = FIND_DEFAULT_LIMIT;
const defaultFindOperations = {
  exists: existsSync,
  glob: (_pattern, _searchCwd, _options) => {
    return [];
  }
};
function createFindTool(cwd, options) {
  const customOps = options?.operations;
  return {
    name: "find",
    label: "find",
    description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
    parameters: findSchema,
    execute: async (_toolCallId, { pattern, path: searchDir, limit }, signal) => {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("Operation aborted"));
          return;
        }
        const onAbort = () => reject(new Error("Operation aborted"));
        signal?.addEventListener("abort", onAbort, { once: true });
        (async () => {
          try {
            const searchPath = resolveToCwd(searchDir || ".", cwd);
            const target = createToolTarget({
              kind: "search",
              action: "find",
              inputPath: searchDir || ".",
              resolvedPath: searchPath,
              pattern
            });
            const effectiveLimit = limit ?? DEFAULT_LIMIT;
            const ops = customOps ?? defaultFindOperations;
            if (customOps?.glob) {
              if (!await ops.exists(searchPath)) {
                reject(new Error(`Path not found: ${searchPath}`));
                return;
              }
              const results = await ops.glob(pattern, searchPath, {
                ignore: ["**/node_modules/**", "**/.git/**"],
                limit: effectiveLimit
              });
              signal?.removeEventListener("abort", onAbort);
              if (results.length === 0) {
                resolve({
                  content: [{ type: "text", text: "No files found matching pattern" }],
                  details: { target }
                });
                return;
              }
              const relativized2 = results.map((p) => {
                if (p.startsWith(searchPath)) {
                  return p.slice(searchPath.length + 1);
                }
                return path.relative(searchPath, p);
              });
              const resultLimitReached2 = relativized2.length >= effectiveLimit;
              const rawOutput2 = relativized2.join("\n");
              const truncation2 = truncateHead(rawOutput2, { maxLines: Number.MAX_SAFE_INTEGER });
              let resultOutput2 = truncation2.content;
              const details2 = { target };
              const notices2 = [];
              if (resultLimitReached2) {
                notices2.push(`${effectiveLimit} results limit reached`);
                details2.resultLimitReached = effectiveLimit;
              }
              if (truncation2.truncated) {
                notices2.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
                details2.truncation = truncation2;
              }
              if (notices2.length > 0) {
                resultOutput2 += `

[${notices2.join(". ")}]`;
              }
              resolve({
                content: [{ type: "text", text: resultOutput2 }],
                details: details2
              });
              return;
            }
            const globResult = await nativeGlob({
              pattern,
              path: searchPath,
              hidden: true,
              gitignore: true,
              cache: true,
              maxResults: effectiveLimit
            });
            signal?.removeEventListener("abort", onAbort);
            if (globResult.matches.length === 0) {
              resolve({
                content: [{ type: "text", text: "No files found matching pattern" }],
                details: { target }
              });
              return;
            }
            const relativized = globResult.matches.map((m) => m.path);
            const resultLimitReached = relativized.length >= effectiveLimit;
            const rawOutput = relativized.join("\n");
            const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
            let resultOutput = truncation.content;
            const details = { target };
            const notices = [];
            if (resultLimitReached) {
              notices.push(
                `${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`
              );
              details.resultLimitReached = effectiveLimit;
            }
            if (truncation.truncated) {
              notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
              details.truncation = truncation;
            }
            if (notices.length > 0) {
              resultOutput += `

[${notices.join(". ")}]`;
            }
            resolve({
              content: [{ type: "text", text: resultOutput }],
              details
            });
          } catch (e) {
            signal?.removeEventListener("abort", onAbort);
            reject(e);
          }
        })();
      });
    }
  };
}
const findTool = createFindTool(process.cwd());
export {
  createFindTool,
  findTool
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL3Rvb2xzL2ZpbmQudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0eXBlIHsgQWdlbnRUb29sIH0gZnJvbSBcIkBnc2QvcGktYWdlbnQtY29yZVwiO1xuaW1wb3J0IHsgZ2xvYiBhcyBuYXRpdmVHbG9iIH0gZnJvbSBcIkBnc2QvbmF0aXZlL2dsb2JcIjtcbmltcG9ydCB7IHR5cGUgU3RhdGljLCBUeXBlIH0gZnJvbSBcIkBzaW5jbGFpci90eXBlYm94XCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jIH0gZnJvbSBcImZzXCI7XG5pbXBvcnQgcGF0aCBmcm9tIFwicGF0aFwiO1xuaW1wb3J0IHsgRklORF9ERUZBVUxUX0xJTUlUIH0gZnJvbSBcIi4uL2NvbnN0YW50cy5qc1wiO1xuaW1wb3J0IHsgcmVzb2x2ZVRvQ3dkIH0gZnJvbSBcIi4vcGF0aC11dGlscy5qc1wiO1xuaW1wb3J0IHsgY3JlYXRlVG9vbFRhcmdldCwgdHlwZSBUb29sVGFyZ2V0TWV0YWRhdGEgfSBmcm9tIFwiLi90b29sLXRhcmdldC5qc1wiO1xuaW1wb3J0IHsgREVGQVVMVF9NQVhfQllURVMsIGZvcm1hdFNpemUsIHR5cGUgVHJ1bmNhdGlvblJlc3VsdCwgdHJ1bmNhdGVIZWFkIH0gZnJvbSBcIi4vdHJ1bmNhdGUuanNcIjtcblxuY29uc3QgZmluZFNjaGVtYSA9IFR5cGUuT2JqZWN0KHtcblx0cGF0dGVybjogVHlwZS5TdHJpbmcoe1xuXHRcdGRlc2NyaXB0aW9uOiBcIkdsb2IgcGF0dGVybiB0byBtYXRjaCBmaWxlcywgZS5nLiAnKi50cycsICcqKi8qLmpzb24nLCBvciAnc3JjLyoqLyouc3BlYy50cydcIixcblx0fSksXG5cdHBhdGg6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJEaXJlY3RvcnkgdG8gc2VhcmNoIGluIChkZWZhdWx0OiBjdXJyZW50IGRpcmVjdG9yeSlcIiB9KSksXG5cdGxpbWl0OiBUeXBlLk9wdGlvbmFsKFR5cGUuTnVtYmVyKHsgZGVzY3JpcHRpb246IFwiTWF4aW11bSBudW1iZXIgb2YgcmVzdWx0cyAoZGVmYXVsdDogMTAwMClcIiB9KSksXG59KTtcblxuZXhwb3J0IHR5cGUgRmluZFRvb2xJbnB1dCA9IFN0YXRpYzx0eXBlb2YgZmluZFNjaGVtYT47XG5cbmNvbnN0IERFRkFVTFRfTElNSVQgPSBGSU5EX0RFRkFVTFRfTElNSVQ7XG5cbmV4cG9ydCBpbnRlcmZhY2UgRmluZFRvb2xEZXRhaWxzIHtcblx0dGFyZ2V0PzogVG9vbFRhcmdldE1ldGFkYXRhO1xuXHR0cnVuY2F0aW9uPzogVHJ1bmNhdGlvblJlc3VsdDtcblx0cmVzdWx0TGltaXRSZWFjaGVkPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIFBsdWdnYWJsZSBvcGVyYXRpb25zIGZvciB0aGUgZmluZCB0b29sLlxuICogT3ZlcnJpZGUgdGhlc2UgdG8gZGVsZWdhdGUgZmlsZSBzZWFyY2ggdG8gcmVtb3RlIHN5c3RlbXMgKGUuZy4sIFNTSCkuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgRmluZE9wZXJhdGlvbnMge1xuXHQvKiogQ2hlY2sgaWYgcGF0aCBleGlzdHMgKi9cblx0ZXhpc3RzOiAoYWJzb2x1dGVQYXRoOiBzdHJpbmcpID0+IFByb21pc2U8Ym9vbGVhbj4gfCBib29sZWFuO1xuXHQvKiogRmluZCBmaWxlcyBtYXRjaGluZyBnbG9iIHBhdHRlcm4uIFJldHVybnMgcmVsYXRpdmUgcGF0aHMuICovXG5cdGdsb2I6IChwYXR0ZXJuOiBzdHJpbmcsIGN3ZDogc3RyaW5nLCBvcHRpb25zOiB7IGlnbm9yZTogc3RyaW5nW107IGxpbWl0OiBudW1iZXIgfSkgPT4gUHJvbWlzZTxzdHJpbmdbXT4gfCBzdHJpbmdbXTtcbn1cblxuY29uc3QgZGVmYXVsdEZpbmRPcGVyYXRpb25zOiBGaW5kT3BlcmF0aW9ucyA9IHtcblx0ZXhpc3RzOiBleGlzdHNTeW5jLFxuXHRnbG9iOiAoX3BhdHRlcm4sIF9zZWFyY2hDd2QsIF9vcHRpb25zKSA9PiB7XG5cdFx0Ly8gUGxhY2Vob2xkZXIgXHUyMDE0IGFjdHVhbCBuYXRpdmUgZ2xvYiBleGVjdXRpb24gaGFwcGVucyBpbiBleGVjdXRlXG5cdFx0cmV0dXJuIFtdO1xuXHR9LFxufTtcblxuZXhwb3J0IGludGVyZmFjZSBGaW5kVG9vbE9wdGlvbnMge1xuXHQvKiogQ3VzdG9tIG9wZXJhdGlvbnMgZm9yIGZpbmQuIERlZmF1bHQ6IGxvY2FsIGZpbGVzeXN0ZW0gKyBuYXRpdmUgZ2xvYiAqL1xuXHRvcGVyYXRpb25zPzogRmluZE9wZXJhdGlvbnM7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVGaW5kVG9vbChjd2Q6IHN0cmluZywgb3B0aW9ucz86IEZpbmRUb29sT3B0aW9ucyk6IEFnZW50VG9vbDx0eXBlb2YgZmluZFNjaGVtYT4ge1xuXHRjb25zdCBjdXN0b21PcHMgPSBvcHRpb25zPy5vcGVyYXRpb25zO1xuXG5cdHJldHVybiB7XG5cdFx0bmFtZTogXCJmaW5kXCIsXG5cdFx0bGFiZWw6IFwiZmluZFwiLFxuXHRcdGRlc2NyaXB0aW9uOiBgU2VhcmNoIGZvciBmaWxlcyBieSBnbG9iIHBhdHRlcm4uIFJldHVybnMgbWF0Y2hpbmcgZmlsZSBwYXRocyByZWxhdGl2ZSB0byB0aGUgc2VhcmNoIGRpcmVjdG9yeS4gUmVzcGVjdHMgLmdpdGlnbm9yZS4gT3V0cHV0IGlzIHRydW5jYXRlZCB0byAke0RFRkFVTFRfTElNSVR9IHJlc3VsdHMgb3IgJHtERUZBVUxUX01BWF9CWVRFUyAvIDEwMjR9S0IgKHdoaWNoZXZlciBpcyBoaXQgZmlyc3QpLmAsXG5cdFx0cGFyYW1ldGVyczogZmluZFNjaGVtYSxcblx0XHRleGVjdXRlOiBhc3luYyAoXG5cdFx0XHRfdG9vbENhbGxJZDogc3RyaW5nLFxuXHRcdFx0eyBwYXR0ZXJuLCBwYXRoOiBzZWFyY2hEaXIsIGxpbWl0IH06IHsgcGF0dGVybjogc3RyaW5nOyBwYXRoPzogc3RyaW5nOyBsaW1pdD86IG51bWJlciB9LFxuXHRcdFx0c2lnbmFsPzogQWJvcnRTaWduYWwsXG5cdFx0KSA9PiB7XG5cdFx0XHRyZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuXHRcdFx0XHRpZiAoc2lnbmFsPy5hYm9ydGVkKSB7XG5cdFx0XHRcdFx0cmVqZWN0KG5ldyBFcnJvcihcIk9wZXJhdGlvbiBhYm9ydGVkXCIpKTtcblx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRjb25zdCBvbkFib3J0ID0gKCkgPT4gcmVqZWN0KG5ldyBFcnJvcihcIk9wZXJhdGlvbiBhYm9ydGVkXCIpKTtcblx0XHRcdFx0c2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25BYm9ydCwgeyBvbmNlOiB0cnVlIH0pO1xuXG5cdFx0XHRcdChhc3luYyAoKSA9PiB7XG5cdFx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRcdGNvbnN0IHNlYXJjaFBhdGggPSByZXNvbHZlVG9Dd2Qoc2VhcmNoRGlyIHx8IFwiLlwiLCBjd2QpO1xuXHRcdFx0XHRcdFx0Y29uc3QgdGFyZ2V0ID0gY3JlYXRlVG9vbFRhcmdldCh7XG5cdFx0XHRcdFx0XHRcdGtpbmQ6IFwic2VhcmNoXCIsXG5cdFx0XHRcdFx0XHRcdGFjdGlvbjogXCJmaW5kXCIsXG5cdFx0XHRcdFx0XHRcdGlucHV0UGF0aDogc2VhcmNoRGlyIHx8IFwiLlwiLFxuXHRcdFx0XHRcdFx0XHRyZXNvbHZlZFBhdGg6IHNlYXJjaFBhdGgsXG5cdFx0XHRcdFx0XHRcdHBhdHRlcm4sXG5cdFx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHRcdGNvbnN0IGVmZmVjdGl2ZUxpbWl0ID0gbGltaXQgPz8gREVGQVVMVF9MSU1JVDtcblx0XHRcdFx0XHRcdGNvbnN0IG9wcyA9IGN1c3RvbU9wcyA/PyBkZWZhdWx0RmluZE9wZXJhdGlvbnM7XG5cblx0XHRcdFx0XHRcdC8vIElmIGN1c3RvbSBvcGVyYXRpb25zIHByb3ZpZGVkIHdpdGggZ2xvYiwgdXNlIHRoYXRcblx0XHRcdFx0XHRcdGlmIChjdXN0b21PcHM/Lmdsb2IpIHtcblx0XHRcdFx0XHRcdFx0aWYgKCEoYXdhaXQgb3BzLmV4aXN0cyhzZWFyY2hQYXRoKSkpIHtcblx0XHRcdFx0XHRcdFx0XHRyZWplY3QobmV3IEVycm9yKGBQYXRoIG5vdCBmb3VuZDogJHtzZWFyY2hQYXRofWApKTtcblx0XHRcdFx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0XHRjb25zdCByZXN1bHRzID0gYXdhaXQgb3BzLmdsb2IocGF0dGVybiwgc2VhcmNoUGF0aCwge1xuXHRcdFx0XHRcdFx0XHRcdGlnbm9yZTogW1wiKiovbm9kZV9tb2R1bGVzLyoqXCIsIFwiKiovLmdpdC8qKlwiXSxcblx0XHRcdFx0XHRcdFx0XHRsaW1pdDogZWZmZWN0aXZlTGltaXQsXG5cdFx0XHRcdFx0XHRcdH0pO1xuXG5cdFx0XHRcdFx0XHRcdHNpZ25hbD8ucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQWJvcnQpO1xuXG5cdFx0XHRcdFx0XHRcdGlmIChyZXN1bHRzLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0XHRcdFx0XHRcdHJlc29sdmUoe1xuXHRcdFx0XHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiTm8gZmlsZXMgZm91bmQgbWF0Y2hpbmcgcGF0dGVyblwiIH1dLFxuXHRcdFx0XHRcdFx0XHRcdFx0ZGV0YWlsczogeyB0YXJnZXQgfSxcblx0XHRcdFx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0XHQvLyBSZWxhdGl2aXplIHBhdGhzXG5cdFx0XHRcdFx0XHRcdGNvbnN0IHJlbGF0aXZpemVkID0gcmVzdWx0cy5tYXAoKHApID0+IHtcblx0XHRcdFx0XHRcdFx0XHRpZiAocC5zdGFydHNXaXRoKHNlYXJjaFBhdGgpKSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRyZXR1cm4gcC5zbGljZShzZWFyY2hQYXRoLmxlbmd0aCArIDEpO1xuXHRcdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0XHRyZXR1cm4gcGF0aC5yZWxhdGl2ZShzZWFyY2hQYXRoLCBwKTtcblx0XHRcdFx0XHRcdFx0fSk7XG5cblx0XHRcdFx0XHRcdFx0Y29uc3QgcmVzdWx0TGltaXRSZWFjaGVkID0gcmVsYXRpdml6ZWQubGVuZ3RoID49IGVmZmVjdGl2ZUxpbWl0O1xuXHRcdFx0XHRcdFx0XHRjb25zdCByYXdPdXRwdXQgPSByZWxhdGl2aXplZC5qb2luKFwiXFxuXCIpO1xuXHRcdFx0XHRcdFx0XHRjb25zdCB0cnVuY2F0aW9uID0gdHJ1bmNhdGVIZWFkKHJhd091dHB1dCwgeyBtYXhMaW5lczogTnVtYmVyLk1BWF9TQUZFX0lOVEVHRVIgfSk7XG5cblx0XHRcdFx0XHRcdFx0bGV0IHJlc3VsdE91dHB1dCA9IHRydW5jYXRpb24uY29udGVudDtcblx0XHRcdFx0XHRcdFx0Y29uc3QgZGV0YWlsczogRmluZFRvb2xEZXRhaWxzID0geyB0YXJnZXQgfTtcblx0XHRcdFx0XHRcdFx0Y29uc3Qgbm90aWNlczogc3RyaW5nW10gPSBbXTtcblxuXHRcdFx0XHRcdFx0XHRpZiAocmVzdWx0TGltaXRSZWFjaGVkKSB7XG5cdFx0XHRcdFx0XHRcdFx0bm90aWNlcy5wdXNoKGAke2VmZmVjdGl2ZUxpbWl0fSByZXN1bHRzIGxpbWl0IHJlYWNoZWRgKTtcblx0XHRcdFx0XHRcdFx0XHRkZXRhaWxzLnJlc3VsdExpbWl0UmVhY2hlZCA9IGVmZmVjdGl2ZUxpbWl0O1xuXHRcdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdFx0aWYgKHRydW5jYXRpb24udHJ1bmNhdGVkKSB7XG5cdFx0XHRcdFx0XHRcdFx0bm90aWNlcy5wdXNoKGAke2Zvcm1hdFNpemUoREVGQVVMVF9NQVhfQllURVMpfSBsaW1pdCByZWFjaGVkYCk7XG5cdFx0XHRcdFx0XHRcdFx0ZGV0YWlscy50cnVuY2F0aW9uID0gdHJ1bmNhdGlvbjtcblx0XHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHRcdGlmIChub3RpY2VzLmxlbmd0aCA+IDApIHtcblx0XHRcdFx0XHRcdFx0XHRyZXN1bHRPdXRwdXQgKz0gYFxcblxcblske25vdGljZXMuam9pbihcIi4gXCIpfV1gO1xuXHRcdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdFx0cmVzb2x2ZSh7XG5cdFx0XHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IHJlc3VsdE91dHB1dCB9XSxcblx0XHRcdFx0XHRcdFx0XHRkZXRhaWxzLFxuXHRcdFx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHQvLyBEZWZhdWx0OiB1c2UgbmF0aXZlIFJ1c3QgZ2xvYlxuXHRcdFx0XHRcdFx0Y29uc3QgZ2xvYlJlc3VsdCA9IGF3YWl0IG5hdGl2ZUdsb2Ioe1xuXHRcdFx0XHRcdFx0XHRwYXR0ZXJuLFxuXHRcdFx0XHRcdFx0XHRwYXRoOiBzZWFyY2hQYXRoLFxuXHRcdFx0XHRcdFx0XHRoaWRkZW46IHRydWUsXG5cdFx0XHRcdFx0XHRcdGdpdGlnbm9yZTogdHJ1ZSxcblx0XHRcdFx0XHRcdFx0Y2FjaGU6IHRydWUsXG5cdFx0XHRcdFx0XHRcdG1heFJlc3VsdHM6IGVmZmVjdGl2ZUxpbWl0LFxuXHRcdFx0XHRcdFx0fSk7XG5cblx0XHRcdFx0XHRcdHNpZ25hbD8ucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQWJvcnQpO1xuXG5cdFx0XHRcdFx0XHRpZiAoZ2xvYlJlc3VsdC5tYXRjaGVzLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0XHRcdFx0XHRyZXNvbHZlKHtcblx0XHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJObyBmaWxlcyBmb3VuZCBtYXRjaGluZyBwYXR0ZXJuXCIgfV0sXG5cdFx0XHRcdFx0XHRcdFx0ZGV0YWlsczogeyB0YXJnZXQgfSxcblx0XHRcdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0Ly8gTmF0aXZlIGdsb2IgcmV0dXJucyBwYXRocyByZWxhdGl2ZSB0byB0aGUgc2VhcmNoIHJvb3Rcblx0XHRcdFx0XHRcdGNvbnN0IHJlbGF0aXZpemVkID0gZ2xvYlJlc3VsdC5tYXRjaGVzLm1hcCgobTogeyBwYXRoOiBzdHJpbmcgfSkgPT4gbS5wYXRoKTtcblxuXHRcdFx0XHRcdFx0Y29uc3QgcmVzdWx0TGltaXRSZWFjaGVkID0gcmVsYXRpdml6ZWQubGVuZ3RoID49IGVmZmVjdGl2ZUxpbWl0O1xuXHRcdFx0XHRcdFx0Y29uc3QgcmF3T3V0cHV0ID0gcmVsYXRpdml6ZWQuam9pbihcIlxcblwiKTtcblx0XHRcdFx0XHRcdGNvbnN0IHRydW5jYXRpb24gPSB0cnVuY2F0ZUhlYWQocmF3T3V0cHV0LCB7IG1heExpbmVzOiBOdW1iZXIuTUFYX1NBRkVfSU5URUdFUiB9KTtcblxuXHRcdFx0XHRcdFx0bGV0IHJlc3VsdE91dHB1dCA9IHRydW5jYXRpb24uY29udGVudDtcblx0XHRcdFx0XHRcdGNvbnN0IGRldGFpbHM6IEZpbmRUb29sRGV0YWlscyA9IHsgdGFyZ2V0IH07XG5cdFx0XHRcdFx0XHRjb25zdCBub3RpY2VzOiBzdHJpbmdbXSA9IFtdO1xuXG5cdFx0XHRcdFx0XHRpZiAocmVzdWx0TGltaXRSZWFjaGVkKSB7XG5cdFx0XHRcdFx0XHRcdG5vdGljZXMucHVzaChcblx0XHRcdFx0XHRcdFx0XHRgJHtlZmZlY3RpdmVMaW1pdH0gcmVzdWx0cyBsaW1pdCByZWFjaGVkLiBVc2UgbGltaXQ9JHtlZmZlY3RpdmVMaW1pdCAqIDJ9IGZvciBtb3JlLCBvciByZWZpbmUgcGF0dGVybmAsXG5cdFx0XHRcdFx0XHRcdCk7XG5cdFx0XHRcdFx0XHRcdGRldGFpbHMucmVzdWx0TGltaXRSZWFjaGVkID0gZWZmZWN0aXZlTGltaXQ7XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdGlmICh0cnVuY2F0aW9uLnRydW5jYXRlZCkge1xuXHRcdFx0XHRcdFx0XHRub3RpY2VzLnB1c2goYCR7Zm9ybWF0U2l6ZShERUZBVUxUX01BWF9CWVRFUyl9IGxpbWl0IHJlYWNoZWRgKTtcblx0XHRcdFx0XHRcdFx0ZGV0YWlscy50cnVuY2F0aW9uID0gdHJ1bmNhdGlvbjtcblx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0aWYgKG5vdGljZXMubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRcdFx0XHRyZXN1bHRPdXRwdXQgKz0gYFxcblxcblske25vdGljZXMuam9pbihcIi4gXCIpfV1gO1xuXHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHRyZXNvbHZlKHtcblx0XHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IHJlc3VsdE91dHB1dCB9XSxcblx0XHRcdFx0XHRcdFx0ZGV0YWlscyxcblx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdH0gY2F0Y2ggKGU6IGFueSkge1xuXHRcdFx0XHRcdFx0c2lnbmFsPy5yZW1vdmVFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25BYm9ydCk7XG5cdFx0XHRcdFx0XHRyZWplY3QoZSk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9KSgpO1xuXHRcdFx0fSk7XG5cdFx0fSxcblx0fTtcbn1cblxuLyoqIERlZmF1bHQgZmluZCB0b29sIHVzaW5nIHByb2Nlc3MuY3dkKCkgLSBmb3IgYmFja3dhcmRzIGNvbXBhdGliaWxpdHkgKi9cbmV4cG9ydCBjb25zdCBmaW5kVG9vbCA9IGNyZWF0ZUZpbmRUb29sKHByb2Nlc3MuY3dkKCkpO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQ0EsU0FBUyxRQUFRLGtCQUFrQjtBQUNuQyxTQUFzQixZQUFZO0FBQ2xDLFNBQVMsa0JBQWtCO0FBQzNCLE9BQU8sVUFBVTtBQUNqQixTQUFTLDBCQUEwQjtBQUNuQyxTQUFTLG9CQUFvQjtBQUM3QixTQUFTLHdC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LFVBQTJCLEVBQUUsT0FBTztBQUMxQyxrQkFBTSxVQUFvQixDQUFDO0FBRTNCLGdCQUFJLG9CQUFvQjtBQUN2QixzQkFBUTtBQUFBLGdCQUNQLEdBQUcsY0FBYyxxQ0FBcUMsaUJBQWlCLENBQUM7QUFBQSxjQUN6RTtBQUNBLHNCQUFRLHFCQUFxQjtBQUFBLFlBQzlCO0FBRUEsZ0JBQUksV0FBVyxXQUFXO0FBQ3pCLHNCQUFRLEtBQUssR0FBRyxXQUFXLGlCQUFpQixDQUFDLGdCQUFnQjtBQUM3RCxzQkFBUSxhQUFhO0FBQUEsWUFDdEI7QUFFQSxnQkFBSSxRQUFRLFNBQVMsR0FBRztBQUN2Qiw4QkFBZ0I7QUFBQTtBQUFBLEdBQVEsUUFBUSxLQUFLLElBQUksQ0FBQztBQUFBLFlBQzNDO0FBRUEsb0JBQVE7QUFBQSxjQUNQLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBUSxNQUFNLGFBQWEsQ0FBQztBQUFBLGNBQzlDO0FBQUEsWUFDRCxDQUFDO0FBQUEsVUFDRixTQUFTLEdBQVE7QUFDaEIsb0JBQVEsb0JBQW9CLFNBQVMsT0FBTztBQUM1QyxtQkFBTyxDQUFDO0FBQUEsVUFDVDtBQUFBLFFBQ0QsR0FBRztBQUFBLE1BQ0osQ0FBQztBQUFBLElBQ0Y7QUFBQSxFQUNEO0FBQ0Q7QUFHTyxNQUFNLFdBQVcsZUFBZSxRQUFRLElBQUksQ0FBQzsiLAogICJuYW1lcyI6IFsicmVsYXRpdml6ZWQiLCAicmVzdWx0TGltaXRSZWFjaGVkIiwgInJhd091dHB1dCIsICJ0cnVuY2F0aW9uIiwgInJlc3VsdE91dHB1dCIsICJkZXRhaWxzIiwgIm5vdGljZXMiXQp9Cg==
