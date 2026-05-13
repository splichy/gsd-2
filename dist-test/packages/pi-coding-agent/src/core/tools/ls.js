import { Type } from "@sinclair/typebox";
import { existsSync, readdirSync, statSync } from "fs";
import nodePath from "path";
import { resolveToCwd } from "./path-utils.js";
import { createToolTarget } from "./tool-target.js";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.js";
const lsSchema = Type.Object({
  path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" }))
});
const DEFAULT_LIMIT = 500;
const defaultLsOperations = {
  exists: existsSync,
  stat: statSync,
  readdir: readdirSync
};
function createLsTool(cwd, options) {
  const ops = options?.operations ?? defaultLsOperations;
  return {
    name: "ls",
    label: "ls",
    description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
    parameters: lsSchema,
    execute: async (_toolCallId, { path, limit }, signal) => {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("Operation aborted"));
          return;
        }
        const onAbort = () => reject(new Error("Operation aborted"));
        signal?.addEventListener("abort", onAbort, { once: true });
        (async () => {
          try {
            const dirPath = resolveToCwd(path || ".", cwd);
            const target = createToolTarget({
              kind: "directory",
              action: "list",
              inputPath: path || ".",
              resolvedPath: dirPath
            });
            const effectiveLimit = limit ?? DEFAULT_LIMIT;
            if (!await ops.exists(dirPath)) {
              reject(new Error(`Path not found: ${dirPath}`));
              return;
            }
            const stat = await ops.stat(dirPath);
            if (!stat.isDirectory()) {
              reject(new Error(`Not a directory: ${dirPath}`));
              return;
            }
            let entries;
            try {
              entries = await ops.readdir(dirPath);
            } catch (e) {
              reject(new Error(`Cannot read directory: ${e.message}`));
              return;
            }
            entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
            const results = [];
            let entryLimitReached = false;
            for (const entry of entries) {
              if (results.length >= effectiveLimit) {
                entryLimitReached = true;
                break;
              }
              const fullPath = nodePath.join(dirPath, entry);
              let suffix = "";
              try {
                const entryStat = await ops.stat(fullPath);
                if (entryStat.isDirectory()) {
                  suffix = "/";
                }
              } catch {
                continue;
              }
              results.push(entry + suffix);
            }
            signal?.removeEventListener("abort", onAbort);
            if (results.length === 0) {
              resolve({ content: [{ type: "text", text: "(empty directory)" }], details: { target } });
              return;
            }
            const rawOutput = results.join("\n");
            const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
            let output = truncation.content;
            const details = { target };
            const notices = [];
            if (entryLimitReached) {
              notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
              details.entryLimitReached = effectiveLimit;
            }
            if (truncation.truncated) {
              notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
              details.truncation = truncation;
            }
            if (notices.length > 0) {
              output += `

[${notices.join(". ")}]`;
            }
            resolve({
              content: [{ type: "text", text: output }],
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
const lsTool = createLsTool(process.cwd());
export {
  createLsTool,
  lsTool
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL3Rvb2xzL2xzLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdHlwZSB7IEFnZW50VG9vbCB9IGZyb20gXCJAZ3NkL3BpLWFnZW50LWNvcmVcIjtcbmltcG9ydCB7IHR5cGUgU3RhdGljLCBUeXBlIH0gZnJvbSBcIkBzaW5jbGFpci90eXBlYm94XCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkZGlyU3luYywgc3RhdFN5bmMgfSBmcm9tIFwiZnNcIjtcbmltcG9ydCBub2RlUGF0aCBmcm9tIFwicGF0aFwiO1xuaW1wb3J0IHsgcmVzb2x2ZVRvQ3dkIH0gZnJvbSBcIi4vcGF0aC11dGlscy5qc1wiO1xuaW1wb3J0IHsgY3JlYXRlVG9vbFRhcmdldCwgdHlwZSBUb29sVGFyZ2V0TWV0YWRhdGEgfSBmcm9tIFwiLi90b29sLXRhcmdldC5qc1wiO1xuaW1wb3J0IHsgREVGQVVMVF9NQVhfQllURVMsIGZvcm1hdFNpemUsIHR5cGUgVHJ1bmNhdGlvblJlc3VsdCwgdHJ1bmNhdGVIZWFkIH0gZnJvbSBcIi4vdHJ1bmNhdGUuanNcIjtcblxuY29uc3QgbHNTY2hlbWEgPSBUeXBlLk9iamVjdCh7XG5cdHBhdGg6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJEaXJlY3RvcnkgdG8gbGlzdCAoZGVmYXVsdDogY3VycmVudCBkaXJlY3RvcnkpXCIgfSkpLFxuXHRsaW1pdDogVHlwZS5PcHRpb25hbChUeXBlLk51bWJlcih7IGRlc2NyaXB0aW9uOiBcIk1heGltdW0gbnVtYmVyIG9mIGVudHJpZXMgdG8gcmV0dXJuIChkZWZhdWx0OiA1MDApXCIgfSkpLFxufSk7XG5cbmV4cG9ydCB0eXBlIExzVG9vbElucHV0ID0gU3RhdGljPHR5cGVvZiBsc1NjaGVtYT47XG5cbmNvbnN0IERFRkFVTFRfTElNSVQgPSA1MDA7XG5cbmV4cG9ydCBpbnRlcmZhY2UgTHNUb29sRGV0YWlscyB7XG5cdHRhcmdldD86IFRvb2xUYXJnZXRNZXRhZGF0YTtcblx0dHJ1bmNhdGlvbj86IFRydW5jYXRpb25SZXN1bHQ7XG5cdGVudHJ5TGltaXRSZWFjaGVkPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIFBsdWdnYWJsZSBvcGVyYXRpb25zIGZvciB0aGUgbHMgdG9vbC5cbiAqIE92ZXJyaWRlIHRoZXNlIHRvIGRlbGVnYXRlIGRpcmVjdG9yeSBsaXN0aW5nIHRvIHJlbW90ZSBzeXN0ZW1zIChlLmcuLCBTU0gpLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIExzT3BlcmF0aW9ucyB7XG5cdC8qKiBDaGVjayBpZiBwYXRoIGV4aXN0cyAqL1xuXHRleGlzdHM6IChhYnNvbHV0ZVBhdGg6IHN0cmluZykgPT4gUHJvbWlzZTxib29sZWFuPiB8IGJvb2xlYW47XG5cdC8qKiBHZXQgZmlsZS9kaXJlY3Rvcnkgc3RhdHMuIFRocm93cyBpZiBub3QgZm91bmQuICovXG5cdHN0YXQ6IChhYnNvbHV0ZVBhdGg6IHN0cmluZykgPT4gUHJvbWlzZTx7IGlzRGlyZWN0b3J5OiAoKSA9PiBib29sZWFuIH0+IHwgeyBpc0RpcmVjdG9yeTogKCkgPT4gYm9vbGVhbiB9O1xuXHQvKiogUmVhZCBkaXJlY3RvcnkgZW50cmllcyAqL1xuXHRyZWFkZGlyOiAoYWJzb2x1dGVQYXRoOiBzdHJpbmcpID0+IFByb21pc2U8c3RyaW5nW10+IHwgc3RyaW5nW107XG59XG5cbmNvbnN0IGRlZmF1bHRMc09wZXJhdGlvbnM6IExzT3BlcmF0aW9ucyA9IHtcblx0ZXhpc3RzOiBleGlzdHNTeW5jLFxuXHRzdGF0OiBzdGF0U3luYyxcblx0cmVhZGRpcjogcmVhZGRpclN5bmMsXG59O1xuXG5leHBvcnQgaW50ZXJmYWNlIExzVG9vbE9wdGlvbnMge1xuXHQvKiogQ3VzdG9tIG9wZXJhdGlvbnMgZm9yIGRpcmVjdG9yeSBsaXN0aW5nLiBEZWZhdWx0OiBsb2NhbCBmaWxlc3lzdGVtICovXG5cdG9wZXJhdGlvbnM/OiBMc09wZXJhdGlvbnM7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVMc1Rvb2woY3dkOiBzdHJpbmcsIG9wdGlvbnM/OiBMc1Rvb2xPcHRpb25zKTogQWdlbnRUb29sPHR5cGVvZiBsc1NjaGVtYT4ge1xuXHRjb25zdCBvcHMgPSBvcHRpb25zPy5vcGVyYXRpb25zID8/IGRlZmF1bHRMc09wZXJhdGlvbnM7XG5cblx0cmV0dXJuIHtcblx0XHRuYW1lOiBcImxzXCIsXG5cdFx0bGFiZWw6IFwibHNcIixcblx0XHRkZXNjcmlwdGlvbjogYExpc3QgZGlyZWN0b3J5IGNvbnRlbnRzLiBSZXR1cm5zIGVudHJpZXMgc29ydGVkIGFscGhhYmV0aWNhbGx5LCB3aXRoICcvJyBzdWZmaXggZm9yIGRpcmVjdG9yaWVzLiBJbmNsdWRlcyBkb3RmaWxlcy4gT3V0cHV0IGlzIHRydW5jYXRlZCB0byAke0RFRkFVTFRfTElNSVR9IGVudHJpZXMgb3IgJHtERUZBVUxUX01BWF9CWVRFUyAvIDEwMjR9S0IgKHdoaWNoZXZlciBpcyBoaXQgZmlyc3QpLmAsXG5cdFx0cGFyYW1ldGVyczogbHNTY2hlbWEsXG5cdFx0ZXhlY3V0ZTogYXN5bmMgKFxuXHRcdFx0X3Rvb2xDYWxsSWQ6IHN0cmluZyxcblx0XHRcdHsgcGF0aCwgbGltaXQgfTogeyBwYXRoPzogc3RyaW5nOyBsaW1pdD86IG51bWJlciB9LFxuXHRcdFx0c2lnbmFsPzogQWJvcnRTaWduYWwsXG5cdFx0KSA9PiB7XG5cdFx0XHRyZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuXHRcdFx0XHRpZiAoc2lnbmFsPy5hYm9ydGVkKSB7XG5cdFx0XHRcdFx0cmVqZWN0KG5ldyBFcnJvcihcIk9wZXJhdGlvbiBhYm9ydGVkXCIpKTtcblx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRjb25zdCBvbkFib3J0ID0gKCkgPT4gcmVqZWN0KG5ldyBFcnJvcihcIk9wZXJhdGlvbiBhYm9ydGVkXCIpKTtcblx0XHRcdFx0c2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25BYm9ydCwgeyBvbmNlOiB0cnVlIH0pO1xuXG5cdFx0XHRcdChhc3luYyAoKSA9PiB7XG5cdFx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRcdGNvbnN0IGRpclBhdGggPSByZXNvbHZlVG9Dd2QocGF0aCB8fCBcIi5cIiwgY3dkKTtcblx0XHRcdFx0XHRcdGNvbnN0IHRhcmdldCA9IGNyZWF0ZVRvb2xUYXJnZXQoe1xuXHRcdFx0XHRcdFx0XHRraW5kOiBcImRpcmVjdG9yeVwiLFxuXHRcdFx0XHRcdFx0XHRhY3Rpb246IFwibGlzdFwiLFxuXHRcdFx0XHRcdFx0XHRpbnB1dFBhdGg6IHBhdGggfHwgXCIuXCIsXG5cdFx0XHRcdFx0XHRcdHJlc29sdmVkUGF0aDogZGlyUGF0aCxcblx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdFx0Y29uc3QgZWZmZWN0aXZlTGltaXQgPSBsaW1pdCA/PyBERUZBVUxUX0xJTUlUO1xuXG5cdFx0XHRcdFx0XHQvLyBDaGVjayBpZiBwYXRoIGV4aXN0c1xuXHRcdFx0XHRcdFx0aWYgKCEoYXdhaXQgb3BzLmV4aXN0cyhkaXJQYXRoKSkpIHtcblx0XHRcdFx0XHRcdFx0cmVqZWN0KG5ldyBFcnJvcihgUGF0aCBub3QgZm91bmQ6ICR7ZGlyUGF0aH1gKSk7XG5cdFx0XHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0Ly8gQ2hlY2sgaWYgcGF0aCBpcyBhIGRpcmVjdG9yeVxuXHRcdFx0XHRcdFx0Y29uc3Qgc3RhdCA9IGF3YWl0IG9wcy5zdGF0KGRpclBhdGgpO1xuXHRcdFx0XHRcdFx0aWYgKCFzdGF0LmlzRGlyZWN0b3J5KCkpIHtcblx0XHRcdFx0XHRcdFx0cmVqZWN0KG5ldyBFcnJvcihgTm90IGEgZGlyZWN0b3J5OiAke2RpclBhdGh9YCkpO1xuXHRcdFx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdC8vIFJlYWQgZGlyZWN0b3J5IGVudHJpZXNcblx0XHRcdFx0XHRcdGxldCBlbnRyaWVzOiBzdHJpbmdbXTtcblx0XHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHRcdGVudHJpZXMgPSBhd2FpdCBvcHMucmVhZGRpcihkaXJQYXRoKTtcblx0XHRcdFx0XHRcdH0gY2F0Y2ggKGU6IGFueSkge1xuXHRcdFx0XHRcdFx0XHRyZWplY3QobmV3IEVycm9yKGBDYW5ub3QgcmVhZCBkaXJlY3Rvcnk6ICR7ZS5tZXNzYWdlfWApKTtcblx0XHRcdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHQvLyBTb3J0IGFscGhhYmV0aWNhbGx5IChjYXNlLWluc2Vuc2l0aXZlKVxuXHRcdFx0XHRcdFx0ZW50cmllcy5zb3J0KChhLCBiKSA9PiBhLnRvTG93ZXJDYXNlKCkubG9jYWxlQ29tcGFyZShiLnRvTG93ZXJDYXNlKCkpKTtcblxuXHRcdFx0XHRcdFx0Ly8gRm9ybWF0IGVudHJpZXMgd2l0aCBkaXJlY3RvcnkgaW5kaWNhdG9yc1xuXHRcdFx0XHRcdFx0Y29uc3QgcmVzdWx0czogc3RyaW5nW10gPSBbXTtcblx0XHRcdFx0XHRcdGxldCBlbnRyeUxpbWl0UmVhY2hlZCA9IGZhbHNlO1xuXG5cdFx0XHRcdFx0XHRmb3IgKGNvbnN0IGVudHJ5IG9mIGVudHJpZXMpIHtcblx0XHRcdFx0XHRcdFx0aWYgKHJlc3VsdHMubGVuZ3RoID49IGVmZmVjdGl2ZUxpbWl0KSB7XG5cdFx0XHRcdFx0XHRcdFx0ZW50cnlMaW1pdFJlYWNoZWQgPSB0cnVlO1xuXHRcdFx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdFx0Y29uc3QgZnVsbFBhdGggPSBub2RlUGF0aC5qb2luKGRpclBhdGgsIGVudHJ5KTtcblx0XHRcdFx0XHRcdFx0bGV0IHN1ZmZpeCA9IFwiXCI7XG5cblx0XHRcdFx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRcdFx0XHRjb25zdCBlbnRyeVN0YXQgPSBhd2FpdCBvcHMuc3RhdChmdWxsUGF0aCk7XG5cdFx0XHRcdFx0XHRcdFx0aWYgKGVudHJ5U3RhdC5pc0RpcmVjdG9yeSgpKSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRzdWZmaXggPSBcIi9cIjtcblx0XHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHRcdFx0XHRcdC8vIFNraXAgZW50cmllcyB3ZSBjYW4ndCBzdGF0XG5cdFx0XHRcdFx0XHRcdFx0Y29udGludWU7XG5cdFx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0XHRyZXN1bHRzLnB1c2goZW50cnkgKyBzdWZmaXgpO1xuXHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHRzaWduYWw/LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkFib3J0KTtcblxuXHRcdFx0XHRcdFx0aWYgKHJlc3VsdHMubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRcdFx0XHRcdHJlc29sdmUoeyBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCIoZW1wdHkgZGlyZWN0b3J5KVwiIH1dLCBkZXRhaWxzOiB7IHRhcmdldCB9IH0pO1xuXHRcdFx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdC8vIEFwcGx5IGJ5dGUgdHJ1bmNhdGlvbiAobm8gbGluZSBsaW1pdCBzaW5jZSB3ZSBhbHJlYWR5IGhhdmUgZW50cnkgbGltaXQpXG5cdFx0XHRcdFx0XHRjb25zdCByYXdPdXRwdXQgPSByZXN1bHRzLmpvaW4oXCJcXG5cIik7XG5cdFx0XHRcdFx0XHRjb25zdCB0cnVuY2F0aW9uID0gdHJ1bmNhdGVIZWFkKHJhd091dHB1dCwgeyBtYXhMaW5lczogTnVtYmVyLk1BWF9TQUZFX0lOVEVHRVIgfSk7XG5cblx0XHRcdFx0XHRcdGxldCBvdXRwdXQgPSB0cnVuY2F0aW9uLmNvbnRlbnQ7XG5cdFx0XHRcdFx0XHRjb25zdCBkZXRhaWxzOiBMc1Rvb2xEZXRhaWxzID0geyB0YXJnZXQgfTtcblxuXHRcdFx0XHRcdFx0Ly8gQnVpbGQgbm90aWNlc1xuXHRcdFx0XHRcdFx0Y29uc3Qgbm90aWNlczogc3RyaW5nW10gPSBbXTtcblxuXHRcdFx0XHRcdFx0aWYgKGVudHJ5TGltaXRSZWFjaGVkKSB7XG5cdFx0XHRcdFx0XHRcdG5vdGljZXMucHVzaChgJHtlZmZlY3RpdmVMaW1pdH0gZW50cmllcyBsaW1pdCByZWFjaGVkLiBVc2UgbGltaXQ9JHtlZmZlY3RpdmVMaW1pdCAqIDJ9IGZvciBtb3JlYCk7XG5cdFx0XHRcdFx0XHRcdGRldGFpbHMuZW50cnlMaW1pdFJlYWNoZWQgPSBlZmZlY3RpdmVMaW1pdDtcblx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0aWYgKHRydW5jYXRpb24udHJ1bmNhdGVkKSB7XG5cdFx0XHRcdFx0XHRcdG5vdGljZXMucHVzaChgJHtmb3JtYXRTaXplKERFRkFVTFRfTUFYX0JZVEVTKX0gbGltaXQgcmVhY2hlZGApO1xuXHRcdFx0XHRcdFx0XHRkZXRhaWxzLnRydW5jYXRpb24gPSB0cnVuY2F0aW9uO1xuXHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHRpZiAobm90aWNlcy5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdFx0XHRcdG91dHB1dCArPSBgXFxuXFxuWyR7bm90aWNlcy5qb2luKFwiLiBcIil9XWA7XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdHJlc29sdmUoe1xuXHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogb3V0cHV0IH1dLFxuXHRcdFx0XHRcdFx0XHRkZXRhaWxzLFxuXHRcdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0fSBjYXRjaCAoZTogYW55KSB7XG5cdFx0XHRcdFx0XHRzaWduYWw/LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkFib3J0KTtcblx0XHRcdFx0XHRcdHJlamVjdChlKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH0pKCk7XG5cdFx0XHR9KTtcblx0XHR9LFxuXHR9O1xufVxuXG4vKiogRGVmYXVsdCBscyB0b29sIHVzaW5nIHByb2Nlc3MuY3dkKCkgLSBmb3IgYmFja3dhcmRzIGNvbXBhdGliaWxpdHkgKi9cbmV4cG9ydCBjb25zdCBsc1Rvb2wgPSBjcmVhdGVMc1Rvb2wocHJvY2Vzcy5jd2QoKSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFDQSxTQUFzQixZQUFZO0FBQ2xDLFNBQVMsWUFBWSxhQUFhLGdCQUFnQjtBQUNsRCxPQUFPLGNBQWM7QUFDckIsU0FBUyxvQkFBb0I7QUFDN0IsU0FBUyx3QkFBaUQ7QUFDMUQsU0FBUyxtQkFBbUIsWUFBbUMsb0JBQW9CO0FBRW5GLE1BQU0sV0FBVyxLQUFLLE9BQU87QUFBQSxFQUM1QixNQUFNLEtBQUssU0FBUyxLQUFLLE9BQU8sRUFBRSxhQUFhLGlEQUFpRCxDQUFDLENBQUM7QUFBQSxFQUNsRyxPQUFPLEtBQUssU0FBUyxLQUFLLE9BQU8sRUFBRSxhQUFhLHFEQUFxRCxDQUFDLENBQUM7QUFDeEcsQ0FBQztBQUlELE1BQU0sZ0JBQWdCO0FBcUJ0QixNQUFNLHNCQUFvQztBQUFBLEVBQ3pDLFFBQVE7QUFBQSxFQUNSLE1BQU07QUFBQSxFQUNOLFNBQVM7QUFDVjtBQU9PLFNBQVMsYUFBYSxLQUFhLFNBQXFEO0FBQzlGLFFBQU0sTUFBTSxTQUFTLGNBQWM7QUFFbkMsU0FBTztBQUFBLElBQ04sTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsYUFBYSw4SUFBOEksYUFBYSxlQUFlLG9CQUFvQixJQUFJO0FBQUEsSUFDL00sWUFBWTtBQUFBLElBQ1osU0FBUyxPQUNSLGFBQ0EsRUFBRSxNQUFNLE1BQU0sR0FDZCxXQUNJO0FBQ0osYUFBTyxJQUFJLFFBQVEsQ0FBQyxTQUFTLFdBQVc7QUFDdkMsWUFBSSxRQUFRLFNBQVM7QUFDcEIsaUJBQU8sSUFBSSxNQUFNLG1CQUFtQixDQUFDO0FBQ3JDO0FBQUEsUUFDRDtBQUVBLGNBQU0sVUFBVSxNQUFNLE9BQU8sSUFBSSxNQUFNLG1CQUFtQixDQUFDO0FBQzNE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
