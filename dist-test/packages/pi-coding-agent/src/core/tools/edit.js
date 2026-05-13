import { Type } from "@sinclair/typebox";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import {
  detectLineEnding,
  fuzzyFindText,
  generateDiffString,
  normalizeForFuzzyMatch,
  normalizeToLF,
  restoreLineEndings,
  stripBom
} from "./edit-diff.js";
import { notifyFileChanged } from "../lsp/client.js";
import { resolveToCwd } from "./path-utils.js";
import { createToolTarget } from "./tool-target.js";
const editSchema = Type.Object({
  path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
  oldText: Type.String({ description: "Exact text to find and replace (must match exactly)" }),
  newText: Type.String({ description: "New text to replace the old text with" })
});
const defaultEditOperations = {
  readFile: (path) => fsReadFile(path),
  writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
  access: (path) => fsAccess(path, constants.R_OK | constants.W_OK)
};
function createEditTool(cwd, options) {
  const ops = options?.operations ?? defaultEditOperations;
  return {
    name: "edit",
    label: "edit",
    description: "Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.",
    parameters: editSchema,
    execute: async (_toolCallId, { path, oldText, newText }, signal) => {
      const absolutePath = resolveToCwd(path, cwd);
      return new Promise((resolve, reject) => {
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
            try {
              await ops.access(absolutePath);
            } catch {
              if (signal) {
                signal.removeEventListener("abort", onAbort);
              }
              reject(new Error(`File not found: ${path}`));
              return;
            }
            if (aborted) {
              return;
            }
            const buffer = await ops.readFile(absolutePath);
            const rawContent = buffer.toString("utf-8");
            if (aborted) {
              return;
            }
            const { bom, text: content } = stripBom(rawContent);
            const originalEnding = detectLineEnding(content);
            const normalizedContent = normalizeToLF(content);
            const normalizedOldText = normalizeToLF(oldText);
            const normalizedNewText = normalizeToLF(newText);
            const matchResult = fuzzyFindText(normalizedContent, normalizedOldText);
            if (!matchResult.found) {
              if (signal) {
                signal.removeEventListener("abort", onAbort);
              }
              reject(
                new Error(
                  `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`
                )
              );
              return;
            }
            const fuzzyContent = normalizeForFuzzyMatch(normalizedContent);
            const fuzzyOldText = normalizeForFuzzyMatch(normalizedOldText);
            const occurrences = fuzzyContent.split(fuzzyOldText).length - 1;
            if (occurrences > 1) {
              if (signal) {
                signal.removeEventListener("abort", onAbort);
              }
              reject(
                new Error(
                  `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`
                )
              );
              return;
            }
            if (aborted) {
              return;
            }
            const baseContent = matchResult.contentForReplacement;
            const newContent = baseContent.substring(0, matchResult.index) + normalizedNewText + baseContent.substring(matchResult.index + matchResult.matchLength);
            if (baseContent === newContent) {
              if (signal) {
                signal.removeEventListener("abort", onAbort);
              }
              reject(
                new Error(
                  `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`
                )
              );
              return;
            }
            const finalContent = bom + restoreLineEndings(newContent, originalEnding);
            await ops.writeFile(absolutePath, finalContent);
            try {
              notifyFileChanged(absolutePath);
            } catch {
            }
            if (aborted) {
              return;
            }
            if (signal) {
              signal.removeEventListener("abort", onAbort);
            }
            const diffResult = generateDiffString(baseContent, newContent);
            resolve({
              content: [
                {
                  type: "text",
                  text: `Successfully replaced text in ${path}.`
                }
              ],
              details: {
                diff: diffResult.diff,
                firstChangedLine: diffResult.firstChangedLine,
                target: createToolTarget({
                  kind: "file",
                  action: "edit",
                  inputPath: path,
                  resolvedPath: absolutePath,
                  line: diffResult.firstChangedLine
                })
              }
            });
          } catch (error) {
            if (signal) {
              signal.removeEventListener("abort", onAbort);
            }
            if (!aborted) {
              reject(error);
            }
          }
        })();
      });
    }
  };
}
const editTool = createEditTool(process.cwd());
export {
  createEditTool,
  editTool
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL3Rvb2xzL2VkaXQudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0eXBlIHsgQWdlbnRUb29sIH0gZnJvbSBcIkBnc2QvcGktYWdlbnQtY29yZVwiO1xuaW1wb3J0IHsgdHlwZSBTdGF0aWMsIFR5cGUgfSBmcm9tIFwiQHNpbmNsYWlyL3R5cGVib3hcIjtcbmltcG9ydCB7IGNvbnN0YW50cyB9IGZyb20gXCJmc1wiO1xuaW1wb3J0IHsgYWNjZXNzIGFzIGZzQWNjZXNzLCByZWFkRmlsZSBhcyBmc1JlYWRGaWxlLCB3cml0ZUZpbGUgYXMgZnNXcml0ZUZpbGUgfSBmcm9tIFwiZnMvcHJvbWlzZXNcIjtcbmltcG9ydCB7XG5cdGRldGVjdExpbmVFbmRpbmcsXG5cdGZ1enp5RmluZFRleHQsXG5cdGdlbmVyYXRlRGlmZlN0cmluZyxcblx0bm9ybWFsaXplRm9yRnV6enlNYXRjaCxcblx0bm9ybWFsaXplVG9MRixcblx0cmVzdG9yZUxpbmVFbmRpbmdzLFxuXHRzdHJpcEJvbSxcbn0gZnJvbSBcIi4vZWRpdC1kaWZmLmpzXCI7XG5pbXBvcnQgeyBub3RpZnlGaWxlQ2hhbmdlZCB9IGZyb20gXCIuLi9sc3AvY2xpZW50LmpzXCI7XG5pbXBvcnQgeyByZXNvbHZlVG9Dd2QgfSBmcm9tIFwiLi9wYXRoLXV0aWxzLmpzXCI7XG5pbXBvcnQgeyBjcmVhdGVUb29sVGFyZ2V0LCB0eXBlIFRvb2xUYXJnZXRNZXRhZGF0YSB9IGZyb20gXCIuL3Rvb2wtdGFyZ2V0LmpzXCI7XG5cbmNvbnN0IGVkaXRTY2hlbWEgPSBUeXBlLk9iamVjdCh7XG5cdHBhdGg6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiUGF0aCB0byB0aGUgZmlsZSB0byBlZGl0IChyZWxhdGl2ZSBvciBhYnNvbHV0ZSlcIiB9KSxcblx0b2xkVGV4dDogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJFeGFjdCB0ZXh0IHRvIGZpbmQgYW5kIHJlcGxhY2UgKG11c3QgbWF0Y2ggZXhhY3RseSlcIiB9KSxcblx0bmV3VGV4dDogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJOZXcgdGV4dCB0byByZXBsYWNlIHRoZSBvbGQgdGV4dCB3aXRoXCIgfSksXG59KTtcblxuZXhwb3J0IHR5cGUgRWRpdFRvb2xJbnB1dCA9IFN0YXRpYzx0eXBlb2YgZWRpdFNjaGVtYT47XG5cbmV4cG9ydCBpbnRlcmZhY2UgRWRpdFRvb2xEZXRhaWxzIHtcblx0LyoqIFVuaWZpZWQgZGlmZiBvZiB0aGUgY2hhbmdlcyBtYWRlICovXG5cdGRpZmY6IHN0cmluZztcblx0LyoqIExpbmUgbnVtYmVyIG9mIHRoZSBmaXJzdCBjaGFuZ2UgaW4gdGhlIG5ldyBmaWxlIChmb3IgZWRpdG9yIG5hdmlnYXRpb24pICovXG5cdGZpcnN0Q2hhbmdlZExpbmU/OiBudW1iZXI7XG5cdHRhcmdldD86IFRvb2xUYXJnZXRNZXRhZGF0YTtcbn1cblxuLyoqXG4gKiBQbHVnZ2FibGUgb3BlcmF0aW9ucyBmb3IgdGhlIGVkaXQgdG9vbC5cbiAqIE92ZXJyaWRlIHRoZXNlIHRvIGRlbGVnYXRlIGZpbGUgZWRpdGluZyB0byByZW1vdGUgc3lzdGVtcyAoZS5nLiwgU1NIKS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBFZGl0T3BlcmF0aW9ucyB7XG5cdC8qKiBSZWFkIGZpbGUgY29udGVudHMgYXMgYSBCdWZmZXIgKi9cblx0cmVhZEZpbGU6IChhYnNvbHV0ZVBhdGg6IHN0cmluZykgPT4gUHJvbWlzZTxCdWZmZXI+O1xuXHQvKiogV3JpdGUgY29udGVudCB0byBhIGZpbGUgKi9cblx0d3JpdGVGaWxlOiAoYWJzb2x1dGVQYXRoOiBzdHJpbmcsIGNvbnRlbnQ6IHN0cmluZykgPT4gUHJvbWlzZTx2b2lkPjtcblx0LyoqIENoZWNrIGlmIGZpbGUgaXMgcmVhZGFibGUgYW5kIHdyaXRhYmxlICh0aHJvdyBpZiBub3QpICovXG5cdGFjY2VzczogKGFic29sdXRlUGF0aDogc3RyaW5nKSA9PiBQcm9taXNlPHZvaWQ+O1xufVxuXG5jb25zdCBkZWZhdWx0RWRpdE9wZXJhdGlvbnM6IEVkaXRPcGVyYXRpb25zID0ge1xuXHRyZWFkRmlsZTogKHBhdGgpID0+IGZzUmVhZEZpbGUocGF0aCksXG5cdHdyaXRlRmlsZTogKHBhdGgsIGNvbnRlbnQpID0+IGZzV3JpdGVGaWxlKHBhdGgsIGNvbnRlbnQsIFwidXRmLThcIiksXG5cdGFjY2VzczogKHBhdGgpID0+IGZzQWNjZXNzKHBhdGgsIGNvbnN0YW50cy5SX09LIHwgY29uc3RhbnRzLldfT0spLFxufTtcblxuZXhwb3J0IGludGVyZmFjZSBFZGl0VG9vbE9wdGlvbnMge1xuXHQvKiogQ3VzdG9tIG9wZXJhdGlvbnMgZm9yIGZpbGUgZWRpdGluZy4gRGVmYXVsdDogbG9jYWwgZmlsZXN5c3RlbSAqL1xuXHRvcGVyYXRpb25zPzogRWRpdE9wZXJhdGlvbnM7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVFZGl0VG9vbChjd2Q6IHN0cmluZywgb3B0aW9ucz86IEVkaXRUb29sT3B0aW9ucyk6IEFnZW50VG9vbDx0eXBlb2YgZWRpdFNjaGVtYT4ge1xuXHRjb25zdCBvcHMgPSBvcHRpb25zPy5vcGVyYXRpb25zID8/IGRlZmF1bHRFZGl0T3BlcmF0aW9ucztcblxuXHRyZXR1cm4ge1xuXHRcdG5hbWU6IFwiZWRpdFwiLFxuXHRcdGxhYmVsOiBcImVkaXRcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiRWRpdCBhIGZpbGUgYnkgcmVwbGFjaW5nIGV4YWN0IHRleHQuIFRoZSBvbGRUZXh0IG11c3QgbWF0Y2ggZXhhY3RseSAoaW5jbHVkaW5nIHdoaXRlc3BhY2UpLiBVc2UgdGhpcyBmb3IgcHJlY2lzZSwgc3VyZ2ljYWwgZWRpdHMuXCIsXG5cdFx0cGFyYW1ldGVyczogZWRpdFNjaGVtYSxcblx0XHRleGVjdXRlOiBhc3luYyAoXG5cdFx0XHRfdG9vbENhbGxJZDogc3RyaW5nLFxuXHRcdFx0eyBwYXRoLCBvbGRUZXh0LCBuZXdUZXh0IH06IHsgcGF0aDogc3RyaW5nOyBvbGRUZXh0OiBzdHJpbmc7IG5ld1RleHQ6IHN0cmluZyB9LFxuXHRcdFx0c2lnbmFsPzogQWJvcnRTaWduYWwsXG5cdFx0KSA9PiB7XG5cdFx0XHRjb25zdCBhYnNvbHV0ZVBhdGggPSByZXNvbHZlVG9Dd2QocGF0aCwgY3dkKTtcblxuXHRcdFx0cmV0dXJuIG5ldyBQcm9taXNlPHtcblx0XHRcdFx0Y29udGVudDogQXJyYXk8eyB0eXBlOiBcInRleHRcIjsgdGV4dDogc3RyaW5nIH0+O1xuXHRcdFx0XHRkZXRhaWxzOiBFZGl0VG9vbERldGFpbHMgfCB1bmRlZmluZWQ7XG5cdFx0XHR9PigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG5cdFx0XHRcdC8vIENoZWNrIGlmIGFscmVhZHkgYWJvcnRlZFxuXHRcdFx0XHRpZiAoc2lnbmFsPy5hYm9ydGVkKSB7XG5cdFx0XHRcdFx0cmVqZWN0KG5ldyBFcnJvcihcIk9wZXJhdGlvbiBhYm9ydGVkXCIpKTtcblx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRsZXQgYWJvcnRlZCA9IGZhbHNlO1xuXG5cdFx0XHRcdC8vIFNldCB1cCBhYm9ydCBoYW5kbGVyXG5cdFx0XHRcdGNvbnN0IG9uQWJvcnQgPSAoKSA9PiB7XG5cdFx0XHRcdFx0YWJvcnRlZCA9IHRydWU7XG5cdFx0XHRcdFx0cmVqZWN0KG5ldyBFcnJvcihcIk9wZXJhdGlvbiBhYm9ydGVkXCIpKTtcblx0XHRcdFx0fTtcblxuXHRcdFx0XHRpZiAoc2lnbmFsKSB7XG5cdFx0XHRcdFx0c2lnbmFsLmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkFib3J0LCB7IG9uY2U6IHRydWUgfSk7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHQvLyBQZXJmb3JtIHRoZSBlZGl0IG9wZXJhdGlvblxuXHRcdFx0XHQoYXN5bmMgKCkgPT4ge1xuXHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHQvLyBDaGVjayBpZiBmaWxlIGV4aXN0c1xuXHRcdFx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRcdFx0YXdhaXQgb3BzLmFjY2VzcyhhYnNvbHV0ZVBhdGgpO1xuXHRcdFx0XHRcdFx0fSBjYXRjaCB7XG5cdFx0XHRcdFx0XHRcdGlmIChzaWduYWwpIHtcblx0XHRcdFx0XHRcdFx0XHRzaWduYWwucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQWJvcnQpO1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdHJlamVjdChuZXcgRXJyb3IoYEZpbGUgbm90IGZvdW5kOiAke3BhdGh9YCkpO1xuXHRcdFx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdC8vIENoZWNrIGlmIGFib3J0ZWQgYmVmb3JlIHJlYWRpbmdcblx0XHRcdFx0XHRcdGlmIChhYm9ydGVkKSB7XG5cdFx0XHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0Ly8gUmVhZCB0aGUgZmlsZVxuXHRcdFx0XHRcdFx0Y29uc3QgYnVmZmVyID0gYXdhaXQgb3BzLnJlYWRGaWxlKGFic29sdXRlUGF0aCk7XG5cdFx0XHRcdFx0XHRjb25zdCByYXdDb250ZW50ID0gYnVmZmVyLnRvU3RyaW5nKFwidXRmLThcIik7XG5cblx0XHRcdFx0XHRcdC8vIENoZWNrIGlmIGFib3J0ZWQgYWZ0ZXIgcmVhZGluZ1xuXHRcdFx0XHRcdFx0aWYgKGFib3J0ZWQpIHtcblx0XHRcdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHQvLyBTdHJpcCBCT00gYmVmb3JlIG1hdGNoaW5nIChMTE0gd29uJ3QgaW5jbHVkZSBpbnZpc2libGUgQk9NIGluIG9sZFRleHQpXG5cdFx0XHRcdFx0XHRjb25zdCB7IGJvbSwgdGV4dDogY29udGVudCB9ID0gc3RyaXBCb20ocmF3Q29udGVudCk7XG5cblx0XHRcdFx0XHRcdGNvbnN0IG9yaWdpbmFsRW5kaW5nID0gZGV0ZWN0TGluZUVuZGluZyhjb250ZW50KTtcblx0XHRcdFx0XHRcdGNvbnN0IG5vcm1hbGl6ZWRDb250ZW50ID0gbm9ybWFsaXplVG9MRihjb250ZW50KTtcblx0XHRcdFx0XHRcdGNvbnN0IG5vcm1hbGl6ZWRPbGRUZXh0ID0gbm9ybWFsaXplVG9MRihvbGRUZXh0KTtcblx0XHRcdFx0XHRcdGNvbnN0IG5vcm1hbGl6ZWROZXdUZXh0ID0gbm9ybWFsaXplVG9MRihuZXdUZXh0KTtcblxuXHRcdFx0XHRcdFx0Ly8gRmluZCB0aGUgb2xkIHRleHQgdXNpbmcgZnV6enkgbWF0Y2hpbmcgKHRyaWVzIGV4YWN0IG1hdGNoIGZpcnN0LCB0aGVuIGZ1enp5KVxuXHRcdFx0XHRcdFx0Y29uc3QgbWF0Y2hSZXN1bHQgPSBmdXp6eUZpbmRUZXh0KG5vcm1hbGl6ZWRDb250ZW50LCBub3JtYWxpemVkT2xkVGV4dCk7XG5cblx0XHRcdFx0XHRcdGlmICghbWF0Y2hSZXN1bHQuZm91bmQpIHtcblx0XHRcdFx0XHRcdFx0aWYgKHNpZ25hbCkge1xuXHRcdFx0XHRcdFx0XHRcdHNpZ25hbC5yZW1vdmVFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25BYm9ydCk7XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0cmVqZWN0KFxuXHRcdFx0XHRcdFx0XHRcdG5ldyBFcnJvcihcblx0XHRcdFx0XHRcdFx0XHRcdGBDb3VsZCBub3QgZmluZCB0aGUgZXhhY3QgdGV4dCBpbiAke3BhdGh9LiBUaGUgb2xkIHRleHQgbXVzdCBtYXRjaCBleGFjdGx5IGluY2x1ZGluZyBhbGwgd2hpdGVzcGFjZSBhbmQgbmV3bGluZXMuYCxcblx0XHRcdFx0XHRcdFx0XHQpLFxuXHRcdFx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdC8vIENvdW50IG9jY3VycmVuY2VzIHVzaW5nIGZ1enp5LW5vcm1hbGl6ZWQgY29udGVudCBmb3IgY29uc2lzdGVuY3lcblx0XHRcdFx0XHRcdGNvbnN0IGZ1enp5Q29udGVudCA9IG5vcm1hbGl6ZUZvckZ1enp5TWF0Y2gobm9ybWFsaXplZENvbnRlbnQpO1xuXHRcdFx0XHRcdFx0Y29uc3QgZnV6enlPbGRUZXh0ID0gbm9ybWFsaXplRm9yRnV6enlNYXRjaChub3JtYWxpemVkT2xkVGV4dCk7XG5cdFx0XHRcdFx0XHRjb25zdCBvY2N1cnJlbmNlcyA9IGZ1enp5Q29udGVudC5zcGxpdChmdXp6eU9sZFRleHQpLmxlbmd0aCAtIDE7XG5cblx0XHRcdFx0XHRcdGlmIChvY2N1cnJlbmNlcyA+IDEpIHtcblx0XHRcdFx0XHRcdFx0aWYgKHNpZ25hbCkge1xuXHRcdFx0XHRcdFx0XHRcdHNpZ25hbC5yZW1vdmVFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25BYm9ydCk7XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0cmVqZWN0KFxuXHRcdFx0XHRcdFx0XHRcdG5ldyBFcnJvcihcblx0XHRcdFx0XHRcdFx0XHRcdGBGb3VuZCAke29jY3VycmVuY2VzfSBvY2N1cnJlbmNlcyBvZiB0aGUgdGV4dCBpbiAke3BhdGh9LiBUaGUgdGV4dCBtdXN0IGJlIHVuaXF1ZS4gUGxlYXNlIHByb3ZpZGUgbW9yZSBjb250ZXh0IHRvIG1ha2UgaXQgdW5pcXVlLmAsXG5cdFx0XHRcdFx0XHRcdFx0KSxcblx0XHRcdFx0XHRcdFx0KTtcblx0XHRcdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHQvLyBDaGVjayBpZiBhYm9ydGVkIGJlZm9yZSB3cml0aW5nXG5cdFx0XHRcdFx0XHRpZiAoYWJvcnRlZCkge1xuXHRcdFx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdC8vIFBlcmZvcm0gcmVwbGFjZW1lbnQgdXNpbmcgdGhlIG1hdGNoZWQgdGV4dCBwb3NpdGlvblxuXHRcdFx0XHRcdFx0Ly8gV2hlbiBmdXp6eSBtYXRjaGluZyB3YXMgdXNlZCwgY29udGVudEZvclJlcGxhY2VtZW50IGlzIHRoZSBub3JtYWxpemVkIHZlcnNpb25cblx0XHRcdFx0XHRcdGNvbnN0IGJhc2VDb250ZW50ID0gbWF0Y2hSZXN1bHQuY29udGVudEZvclJlcGxhY2VtZW50O1xuXHRcdFx0XHRcdFx0Y29uc3QgbmV3Q29udGVudCA9XG5cdFx0XHRcdFx0XHRcdGJhc2VDb250ZW50LnN1YnN0cmluZygwLCBtYXRjaFJlc3VsdC5pbmRleCkgK1xuXHRcdFx0XHRcdFx0XHRub3JtYWxpemVkTmV3VGV4dCArXG5cdFx0XHRcdFx0XHRcdGJhc2VDb250ZW50LnN1YnN0cmluZyhtYXRjaFJlc3VsdC5pbmRleCArIG1hdGNoUmVzdWx0Lm1hdGNoTGVuZ3RoKTtcblxuXHRcdFx0XHRcdFx0Ly8gVmVyaWZ5IHRoZSByZXBsYWNlbWVudCBhY3R1YWxseSBjaGFuZ2VkIHNvbWV0aGluZ1xuXHRcdFx0XHRcdFx0aWYgKGJhc2VDb250ZW50ID09PSBuZXdDb250ZW50KSB7XG5cdFx0XHRcdFx0XHRcdGlmIChzaWduYWwpIHtcblx0XHRcdFx0XHRcdFx0XHRzaWduYWwucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQWJvcnQpO1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdHJlamVjdChcblx0XHRcdFx0XHRcdFx0XHRuZXcgRXJyb3IoXG5cdFx0XHRcdFx0XHRcdFx0XHRgTm8gY2hhbmdlcyBtYWRlIHRvICR7cGF0aH0uIFRoZSByZXBsYWNlbWVudCBwcm9kdWNlZCBpZGVudGljYWwgY29udGVudC4gVGhpcyBtaWdodCBpbmRpY2F0ZSBhbiBpc3N1ZSB3aXRoIHNwZWNpYWwgY2hhcmFjdGVycyBvciB0aGUgdGV4dCBub3QgZXhpc3RpbmcgYXMgZXhwZWN0ZWQuYCxcblx0XHRcdFx0XHRcdFx0XHQpLFxuXHRcdFx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdGNvbnN0IGZpbmFsQ29udGVudCA9IGJvbSArIHJlc3RvcmVMaW5lRW5kaW5ncyhuZXdDb250ZW50LCBvcmlnaW5hbEVuZGluZyk7XG5cdFx0XHRcdFx0XHRhd2FpdCBvcHMud3JpdGVGaWxlKGFic29sdXRlUGF0aCwgZmluYWxDb250ZW50KTtcblxuXHRcdFx0XHRcdFx0dHJ5IHsgbm90aWZ5RmlsZUNoYW5nZWQoYWJzb2x1dGVQYXRoKTsgfSBjYXRjaCB7IC8qIGJlc3QtZWZmb3J0ICovIH1cblxuXHRcdFx0XHRcdFx0Ly8gQ2hlY2sgaWYgYWJvcnRlZCBhZnRlciB3cml0aW5nXG5cdFx0XHRcdFx0XHRpZiAoYWJvcnRlZCkge1xuXHRcdFx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdC8vIENsZWFuIHVwIGFib3J0IGhhbmRsZXJcblx0XHRcdFx0XHRcdGlmIChzaWduYWwpIHtcblx0XHRcdFx0XHRcdFx0c2lnbmFsLnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkFib3J0KTtcblx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0Y29uc3QgZGlmZlJlc3VsdCA9IGdlbmVyYXRlRGlmZlN0cmluZyhiYXNlQ29udGVudCwgbmV3Q29udGVudCk7XG5cdFx0XHRcdFx0XHRyZXNvbHZlKHtcblx0XHRcdFx0XHRcdFx0Y29udGVudDogW1xuXHRcdFx0XHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdFx0XHRcdHR5cGU6IFwidGV4dFwiLFxuXHRcdFx0XHRcdFx0XHRcdFx0dGV4dDogYFN1Y2Nlc3NmdWxseSByZXBsYWNlZCB0ZXh0IGluICR7cGF0aH0uYCxcblx0XHRcdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdFx0XHRdLFxuXHRcdFx0XHRcdFx0XHRkZXRhaWxzOiB7XG5cdFx0XHRcdFx0XHRcdFx0ZGlmZjogZGlmZlJlc3VsdC5kaWZmLFxuXHRcdFx0XHRcdFx0XHRcdGZpcnN0Q2hhbmdlZExpbmU6IGRpZmZSZXN1bHQuZmlyc3RDaGFuZ2VkTGluZSxcblx0XHRcdFx0XHRcdFx0XHR0YXJnZXQ6IGNyZWF0ZVRvb2xUYXJnZXQoe1xuXHRcdFx0XHRcdFx0XHRcdFx0a2luZDogXCJmaWxlXCIsXG5cdFx0XHRcdFx0XHRcdFx0XHRhY3Rpb246IFwiZWRpdFwiLFxuXHRcdFx0XHRcdFx0XHRcdFx0aW5wdXRQYXRoOiBwYXRoLFxuXHRcdFx0XHRcdFx0XHRcdFx0cmVzb2x2ZWRQYXRoOiBhYnNvbHV0ZVBhdGgsXG5cdFx0XHRcdFx0XHRcdFx0XHRsaW5lOiBkaWZmUmVzdWx0LmZpcnN0Q2hhbmdlZExpbmUsXG5cdFx0XHRcdFx0XHRcdFx0fSksXG5cdFx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHR9IGNhdGNoIChlcnJvcjogYW55KSB7XG5cdFx0XHRcdFx0XHQvLyBDbGVhbiB1cCBhYm9ydCBoYW5kbGVyXG5cdFx0XHRcdFx0XHRpZiAoc2lnbmFsKSB7XG5cdFx0XHRcdFx0XHRcdHNpZ25hbC5yZW1vdmVFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25BYm9ydCk7XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdGlmICghYWJvcnRlZCkge1xuXHRcdFx0XHRcdFx0XHRyZWplY3QoZXJyb3IpO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH1cblx0XHRcdFx0fSkoKTtcblx0XHRcdH0pO1xuXHRcdH0sXG5cdH07XG59XG5cbi8qKiBEZWZhdWx0IGVkaXQgdG9vbCB1c2luZyBwcm9jZXNzLmN3ZCgpIC0gZm9yIGJhY2t3YXJkcyBjb21wYXRpYmlsaXR5ICovXG5leHBvcnQgY29uc3QgZWRpdFRvb2wgPSBjcmVhdGVFZGl0VG9vbChwcm9jZXNzLmN3ZCgpKTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUNBLFNBQXNCLFlBQVk7QUFDbEMsU0FBUyxpQkFBaUI7QUFDMUIsU0FBUyxVQUFVLFVBQVUsWUFBWSxZQUFZLGFBQWEsbUJBQW1CO0FBQ3JGO0FBQUEsRUFDQztBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ007QUFD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
