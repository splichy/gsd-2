import { Type } from "@sinclair/typebox";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, unlink as fsUnlink, writeFile as fsWriteFile } from "fs/promises";
import {
  detectLineEnding,
  generateDiffString,
  normalizeToLF,
  restoreLineEndings,
  stripBom
} from "./edit-diff.js";
import {
  applyHashlineEdits,
  parseHashlineText,
  parseTag
} from "./hashline.js";
import { resolveToCwd } from "./path-utils.js";
const hashlineEditItemSchema = Type.Object(
  {
    op: Type.Union([Type.Literal("replace"), Type.Literal("append"), Type.Literal("prepend")]),
    pos: Type.Optional(Type.String({ description: 'Anchor tag (e.g. "5#QQ")' })),
    end: Type.Optional(Type.String({ description: "End anchor for range replace" })),
    lines: Type.Union([
      Type.Array(Type.String(), { description: "Replacement content lines" }),
      Type.String(),
      Type.Null()
    ])
  },
  { additionalProperties: false }
);
const hashlineEditSchema = Type.Object(
  {
    path: Type.String({ description: "Path to the file to edit" }),
    edits: Type.Array(hashlineEditItemSchema, { description: "Edits to apply (referenced by LINE#ID tags from read output)" }),
    delete: Type.Optional(Type.Boolean({ description: "If true, delete the file" })),
    move: Type.Optional(Type.String({ description: "If set, move/rename the file to this path" }))
  },
  { additionalProperties: false }
);
const defaultHashlineEditOperations = {
  readFile: (path) => fsReadFile(path),
  writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
  access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
  unlink: (path) => fsUnlink(path)
};
function tryParseTag(raw) {
  try {
    return parseTag(raw);
  } catch {
    return void 0;
  }
}
function resolveEditAnchors(edits) {
  const result = [];
  for (const edit of edits) {
    const lines = parseHashlineText(edit.lines);
    const tag = edit.pos ? tryParseTag(edit.pos) : void 0;
    const end = edit.end ? tryParseTag(edit.end) : void 0;
    const op = edit.op === "append" || edit.op === "prepend" ? edit.op : "replace";
    switch (op) {
      case "replace": {
        if (tag && end) {
          result.push({ op: "replace", pos: tag, end, lines });
        } else if (tag || end) {
          result.push({ op: "replace", pos: tag || end, lines });
        } else {
          throw new Error("Replace requires at least one anchor (pos or end).");
        }
        break;
      }
      case "append": {
        result.push({ op: "append", pos: tag ?? end, lines });
        break;
      }
      case "prepend": {
        result.push({ op: "prepend", pos: end ?? tag, lines });
        break;
      }
    }
  }
  return result;
}
const HASHLINE_EDIT_DESCRIPTION = `Edit a file by referencing LINE#ID tags from read output. Each tag uniquely identifies a line via content hash, so edits remain stable even when lines shift.

Read the file first to get fresh tags. Submit one edit call per file with all operations batched.

Operations:
- replace: Replace line(s) at pos (and optionally through end) with lines content
- append: Insert lines after pos (omit pos for end of file)
- prepend: Insert lines before pos (omit pos for beginning of file)

Set lines to null or [] to delete lines. Set delete:true to delete the file.`;
function createHashlineEditTool(cwd, options) {
  const ops = options?.operations ?? defaultHashlineEditOperations;
  return {
    name: "hashline_edit",
    label: "hashline_edit",
    description: HASHLINE_EDIT_DESCRIPTION,
    parameters: hashlineEditSchema,
    execute: async (_toolCallId, params, signal) => {
      const { path, edits, delete: deleteFile, move } = params;
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
            if (deleteFile) {
              let fileExists2 = true;
              try {
                await ops.access(absolutePath);
              } catch {
                fileExists2 = false;
              }
              if (fileExists2) {
                await ops.unlink(absolutePath);
              }
              if (signal) signal.removeEventListener("abort", onAbort);
              resolve({
                content: [{ type: "text", text: fileExists2 ? `Deleted ${path}` : `File not found, nothing to delete: ${path}` }],
                details: { diff: "" }
              });
              return;
            }
            let fileExists = true;
            try {
              await ops.access(absolutePath);
            } catch {
              fileExists = false;
            }
            if (!fileExists) {
              const lines = [];
              for (const edit of edits) {
                if ((edit.op === "append" || edit.op === "prepend") && !edit.pos && !edit.end) {
                  if (edit.op === "prepend") {
                    lines.unshift(...parseHashlineText(edit.lines));
                  } else {
                    lines.push(...parseHashlineText(edit.lines));
                  }
                } else {
                  throw new Error(`File not found: ${path}`);
                }
              }
              await ops.writeFile(absolutePath, lines.join("\n"));
              if (signal) signal.removeEventListener("abort", onAbort);
              resolve({
                content: [{ type: "text", text: `Created ${path}` }],
                details: { diff: "" }
              });
              return;
            }
            if (aborted) return;
            const rawContent = (await ops.readFile(absolutePath)).toString("utf-8");
            const { bom, text } = stripBom(rawContent);
            const originalEnding = detectLineEnding(text);
            const originalNormalized = normalizeToLF(text);
            if (aborted) return;
            const anchorEdits = resolveEditAnchors(edits);
            const result = applyHashlineEdits(originalNormalized, anchorEdits);
            if (originalNormalized === result.lines && !move) {
              let diagnostic = `No changes made to ${path}. The edits produced identical content.`;
              if (result.noopEdits && result.noopEdits.length > 0) {
                const details = result.noopEdits.map(
                  (e) => `Edit ${e.editIndex}: replacement for ${e.loc} is identical to current content:
  ${e.loc}| ${e.current}`
                ).join("\n");
                diagnostic += `
${details}`;
                diagnostic += "\nYour content must differ from what the file already contains. Re-read the file to see the current state.";
              }
              throw new Error(diagnostic);
            }
            if (aborted) return;
            const finalContent = bom + restoreLineEndings(result.lines, originalEnding);
            const writePath = move ? resolveToCwd(move, cwd) : absolutePath;
            if (move && writePath !== absolutePath) {
              try {
                await ops.access(writePath);
                throw new Error(`Destination file already exists: ${writePath}. Use a different path or delete the existing file first.`);
              } catch (err) {
                if (err.message?.startsWith("Destination file already exists:")) throw err;
              }
            }
            await ops.writeFile(writePath, finalContent);
            if (move && writePath !== absolutePath) {
              await ops.unlink(absolutePath);
            }
            if (aborted) return;
            if (signal) signal.removeEventListener("abort", onAbort);
            const diffResult = generateDiffString(originalNormalized, result.lines);
            const resultText = move ? `Moved ${path} to ${move}` : `Updated ${path}`;
            const warningsBlock = result.warnings?.length ? `
Warnings:
${result.warnings.join("\n")}` : "";
            resolve({
              content: [
                {
                  type: "text",
                  text: `${resultText}${warningsBlock}`
                }
              ],
              details: {
                diff: diffResult.diff,
                firstChangedLine: result.firstChangedLine ?? diffResult.firstChangedLine
              }
            });
          } catch (error) {
            if (signal) signal.removeEventListener("abort", onAbort);
            if (!aborted) {
              reject(error);
            }
          }
        })();
      });
    }
  };
}
const hashlineEditTool = createHashlineEditTool(process.cwd());
export {
  createHashlineEditTool,
  hashlineEditTool
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL3Rvb2xzL2hhc2hsaW5lLWVkaXQudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogSGFzaGxpbmUgZWRpdCB0b29sIFx1MjAxNCBhcHBsaWVzIGZpbGUgZWRpdHMgdXNpbmcgbGluZS1oYXNoIGFuY2hvcnMuXG4gKlxuICogVGhlIG1vZGVsIHJlZmVyZW5jZXMgbGluZXMgYnkgYExJTkUjSURgIHRhZ3MgZnJvbSByZWFkIG91dHB1dC5cbiAqIEVhY2ggdGFnIHVuaXF1ZWx5IGlkZW50aWZpZXMgYSBsaW5lLCBzbyBlZGl0cyByZW1haW4gc3RhYmxlIGV2ZW4gd2hlbiBsaW5lcyBzaGlmdC5cbiAqL1xuaW1wb3J0IHR5cGUgeyBBZ2VudFRvb2wgfSBmcm9tIFwiQGdzZC9waS1hZ2VudC1jb3JlXCI7XG5pbXBvcnQgeyB0eXBlIFN0YXRpYywgVHlwZSB9IGZyb20gXCJAc2luY2xhaXIvdHlwZWJveFwiO1xuaW1wb3J0IHsgY29uc3RhbnRzIH0gZnJvbSBcImZzXCI7XG5pbXBvcnQgeyBhY2Nlc3MgYXMgZnNBY2Nlc3MsIHJlYWRGaWxlIGFzIGZzUmVhZEZpbGUsIHVubGluayBhcyBmc1VubGluaywgd3JpdGVGaWxlIGFzIGZzV3JpdGVGaWxlIH0gZnJvbSBcImZzL3Byb21pc2VzXCI7XG5pbXBvcnQge1xuXHRkZXRlY3RMaW5lRW5kaW5nLFxuXHRnZW5lcmF0ZURpZmZTdHJpbmcsXG5cdG5vcm1hbGl6ZVRvTEYsXG5cdHJlc3RvcmVMaW5lRW5kaW5ncyxcblx0c3RyaXBCb20sXG59IGZyb20gXCIuL2VkaXQtZGlmZi5qc1wiO1xuaW1wb3J0IHtcblx0dHlwZSBBbmNob3IsXG5cdGFwcGx5SGFzaGxpbmVFZGl0cyxcblx0Y29tcHV0ZUxpbmVIYXNoLFxuXHR0eXBlIEhhc2hsaW5lRWRpdCxcblx0cGFyc2VIYXNobGluZVRleHQsXG5cdHBhcnNlVGFnLFxufSBmcm9tIFwiLi9oYXNobGluZS5qc1wiO1xuaW1wb3J0IHsgcmVzb2x2ZVRvQ3dkIH0gZnJvbSBcIi4vcGF0aC11dGlscy5qc1wiO1xuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIFNjaGVtYVxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbmNvbnN0IGhhc2hsaW5lRWRpdEl0ZW1TY2hlbWEgPSBUeXBlLk9iamVjdChcblx0e1xuXHRcdG9wOiBUeXBlLlVuaW9uKFtUeXBlLkxpdGVyYWwoXCJyZXBsYWNlXCIpLCBUeXBlLkxpdGVyYWwoXCJhcHBlbmRcIiksIFR5cGUuTGl0ZXJhbChcInByZXBlbmRcIildKSxcblx0XHRwb3M6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJBbmNob3IgdGFnIChlLmcuIFxcXCI1I1FRXFxcIilcIiB9KSksXG5cdFx0ZW5kOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiRW5kIGFuY2hvciBmb3IgcmFuZ2UgcmVwbGFjZVwiIH0pKSxcblx0XHRsaW5lczogVHlwZS5VbmlvbihbXG5cdFx0XHRUeXBlLkFycmF5KFR5cGUuU3RyaW5nKCksIHsgZGVzY3JpcHRpb246IFwiUmVwbGFjZW1lbnQgY29udGVudCBsaW5lc1wiIH0pLFxuXHRcdFx0VHlwZS5TdHJpbmcoKSxcblx0XHRcdFR5cGUuTnVsbCgpLFxuXHRcdF0pLFxuXHR9LFxuXHR7IGFkZGl0aW9uYWxQcm9wZXJ0aWVzOiBmYWxzZSB9LFxuKTtcblxuY29uc3QgaGFzaGxpbmVFZGl0U2NoZW1hID0gVHlwZS5PYmplY3QoXG5cdHtcblx0XHRwYXRoOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIlBhdGggdG8gdGhlIGZpbGUgdG8gZWRpdFwiIH0pLFxuXHRcdGVkaXRzOiBUeXBlLkFycmF5KGhhc2hsaW5lRWRpdEl0ZW1TY2hlbWEsIHsgZGVzY3JpcHRpb246IFwiRWRpdHMgdG8gYXBwbHkgKHJlZmVyZW5jZWQgYnkgTElORSNJRCB0YWdzIGZyb20gcmVhZCBvdXRwdXQpXCIgfSksXG5cdFx0ZGVsZXRlOiBUeXBlLk9wdGlvbmFsKFR5cGUuQm9vbGVhbih7IGRlc2NyaXB0aW9uOiBcIklmIHRydWUsIGRlbGV0ZSB0aGUgZmlsZVwiIH0pKSxcblx0XHRtb3ZlOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiSWYgc2V0LCBtb3ZlL3JlbmFtZSB0aGUgZmlsZSB0byB0aGlzIHBhdGhcIiB9KSksXG5cdH0sXG5cdHsgYWRkaXRpb25hbFByb3BlcnRpZXM6IGZhbHNlIH0sXG4pO1xuXG5leHBvcnQgdHlwZSBIYXNobGluZUVkaXRJbnB1dCA9IFN0YXRpYzx0eXBlb2YgaGFzaGxpbmVFZGl0U2NoZW1hPjtcbmV4cG9ydCB0eXBlIEhhc2hsaW5lRWRpdEl0ZW0gPSBTdGF0aWM8dHlwZW9mIGhhc2hsaW5lRWRpdEl0ZW1TY2hlbWE+O1xuXG5leHBvcnQgaW50ZXJmYWNlIEhhc2hsaW5lRWRpdFRvb2xEZXRhaWxzIHtcblx0LyoqIFVuaWZpZWQgZGlmZiBvZiB0aGUgY2hhbmdlcyBtYWRlICovXG5cdGRpZmY6IHN0cmluZztcblx0LyoqIExpbmUgbnVtYmVyIG9mIHRoZSBmaXJzdCBjaGFuZ2UgaW4gdGhlIG5ldyBmaWxlICovXG5cdGZpcnN0Q2hhbmdlZExpbmU/OiBudW1iZXI7XG59XG5cbi8qKlxuICogUGx1Z2dhYmxlIG9wZXJhdGlvbnMgZm9yIHRoZSBoYXNobGluZSBlZGl0IHRvb2wuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgSGFzaGxpbmVFZGl0T3BlcmF0aW9ucyB7XG5cdHJlYWRGaWxlOiAoYWJzb2x1dGVQYXRoOiBzdHJpbmcpID0+IFByb21pc2U8QnVmZmVyPjtcblx0d3JpdGVGaWxlOiAoYWJzb2x1dGVQYXRoOiBzdHJpbmcsIGNvbnRlbnQ6IHN0cmluZykgPT4gUHJvbWlzZTx2b2lkPjtcblx0YWNjZXNzOiAoYWJzb2x1dGVQYXRoOiBzdHJpbmcpID0+IFByb21pc2U8dm9pZD47XG5cdHVubGluazogKGFic29sdXRlUGF0aDogc3RyaW5nKSA9PiBQcm9taXNlPHZvaWQ+O1xufVxuXG5jb25zdCBkZWZhdWx0SGFzaGxpbmVFZGl0T3BlcmF0aW9uczogSGFzaGxpbmVFZGl0T3BlcmF0aW9ucyA9IHtcblx0cmVhZEZpbGU6IChwYXRoKSA9PiBmc1JlYWRGaWxlKHBhdGgpLFxuXHR3cml0ZUZpbGU6IChwYXRoLCBjb250ZW50KSA9PiBmc1dyaXRlRmlsZShwYXRoLCBjb250ZW50LCBcInV0Zi04XCIpLFxuXHRhY2Nlc3M6IChwYXRoKSA9PiBmc0FjY2VzcyhwYXRoLCBjb25zdGFudHMuUl9PSyB8IGNvbnN0YW50cy5XX09LKSxcblx0dW5saW5rOiAocGF0aCkgPT4gZnNVbmxpbmsocGF0aCksXG59O1xuXG5leHBvcnQgaW50ZXJmYWNlIEhhc2hsaW5lRWRpdFRvb2xPcHRpb25zIHtcblx0b3BlcmF0aW9ucz86IEhhc2hsaW5lRWRpdE9wZXJhdGlvbnM7XG59XG5cbi8qKiBQYXJzZSBhIHRhZywgcmV0dXJuaW5nIHVuZGVmaW5lZCBpbnN0ZWFkIG9mIHRocm93aW5nIG9uIGdhcmJhZ2UuICovXG5mdW5jdGlvbiB0cnlQYXJzZVRhZyhyYXc6IHN0cmluZyk6IEFuY2hvciB8IHVuZGVmaW5lZCB7XG5cdHRyeSB7XG5cdFx0cmV0dXJuIHBhcnNlVGFnKHJhdyk7XG5cdH0gY2F0Y2gge1xuXHRcdHJldHVybiB1bmRlZmluZWQ7XG5cdH1cbn1cblxuLyoqXG4gKiBNYXAgZmxhdCB0b29sLXNjaGVtYSBlZGl0cyBpbnRvIHR5cGVkIEhhc2hsaW5lRWRpdCBvYmplY3RzLlxuICovXG5mdW5jdGlvbiByZXNvbHZlRWRpdEFuY2hvcnMoZWRpdHM6IEhhc2hsaW5lRWRpdEl0ZW1bXSk6IEhhc2hsaW5lRWRpdFtdIHtcblx0Y29uc3QgcmVzdWx0OiBIYXNobGluZUVkaXRbXSA9IFtdO1xuXHRmb3IgKGNvbnN0IGVkaXQgb2YgZWRpdHMpIHtcblx0XHRjb25zdCBsaW5lcyA9IHBhcnNlSGFzaGxpbmVUZXh0KGVkaXQubGluZXMpO1xuXHRcdGNvbnN0IHRhZyA9IGVkaXQucG9zID8gdHJ5UGFyc2VUYWcoZWRpdC5wb3MpIDogdW5kZWZpbmVkO1xuXHRcdGNvbnN0IGVuZCA9IGVkaXQuZW5kID8gdHJ5UGFyc2VUYWcoZWRpdC5lbmQpIDogdW5kZWZpbmVkO1xuXG5cdFx0Y29uc3Qgb3AgPSBlZGl0Lm9wID09PSBcImFwcGVuZFwiIHx8IGVkaXQub3AgPT09IFwicHJlcGVuZFwiID8gZWRpdC5vcCA6IFwicmVwbGFjZVwiO1xuXHRcdHN3aXRjaCAob3ApIHtcblx0XHRcdGNhc2UgXCJyZXBsYWNlXCI6IHtcblx0XHRcdFx0aWYgKHRhZyAmJiBlbmQpIHtcblx0XHRcdFx0XHRyZXN1bHQucHVzaCh7IG9wOiBcInJlcGxhY2VcIiwgcG9zOiB0YWcsIGVuZCwgbGluZXMgfSk7XG5cdFx0XHRcdH0gZWxzZSBpZiAodGFnIHx8IGVuZCkge1xuXHRcdFx0XHRcdHJlc3VsdC5wdXNoKHsgb3A6IFwicmVwbGFjZVwiLCBwb3M6IHRhZyB8fCBlbmQhLCBsaW5lcyB9KTtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoXCJSZXBsYWNlIHJlcXVpcmVzIGF0IGxlYXN0IG9uZSBhbmNob3IgKHBvcyBvciBlbmQpLlwiKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRicmVhaztcblx0XHRcdH1cblx0XHRcdGNhc2UgXCJhcHBlbmRcIjoge1xuXHRcdFx0XHRyZXN1bHQucHVzaCh7IG9wOiBcImFwcGVuZFwiLCBwb3M6IHRhZyA/PyBlbmQsIGxpbmVzIH0pO1xuXHRcdFx0XHRicmVhaztcblx0XHRcdH1cblx0XHRcdGNhc2UgXCJwcmVwZW5kXCI6IHtcblx0XHRcdFx0cmVzdWx0LnB1c2goeyBvcDogXCJwcmVwZW5kXCIsIHBvczogZW5kID8/IHRhZywgbGluZXMgfSk7XG5cdFx0XHRcdGJyZWFrO1xuXHRcdFx0fVxuXHRcdH1cblx0fVxuXHRyZXR1cm4gcmVzdWx0O1xufVxuXG5jb25zdCBIQVNITElORV9FRElUX0RFU0NSSVBUSU9OID0gYEVkaXQgYSBmaWxlIGJ5IHJlZmVyZW5jaW5nIExJTkUjSUQgdGFncyBmcm9tIHJlYWQgb3V0cHV0LiBFYWNoIHRhZyB1bmlxdWVseSBpZGVudGlmaWVzIGEgbGluZSB2aWEgY29udGVudCBoYXNoLCBzbyBlZGl0cyByZW1haW4gc3RhYmxlIGV2ZW4gd2hlbiBsaW5lcyBzaGlmdC5cblxuUmVhZCB0aGUgZmlsZSBmaXJzdCB0byBnZXQgZnJlc2ggdGFncy4gU3VibWl0IG9uZSBlZGl0IGNhbGwgcGVyIGZpbGUgd2l0aCBhbGwgb3BlcmF0aW9ucyBiYXRjaGVkLlxuXG5PcGVyYXRpb25zOlxuLSByZXBsYWNlOiBSZXBsYWNlIGxpbmUocykgYXQgcG9zIChhbmQgb3B0aW9uYWxseSB0aHJvdWdoIGVuZCkgd2l0aCBsaW5lcyBjb250ZW50XG4tIGFwcGVuZDogSW5zZXJ0IGxpbmVzIGFmdGVyIHBvcyAob21pdCBwb3MgZm9yIGVuZCBvZiBmaWxlKVxuLSBwcmVwZW5kOiBJbnNlcnQgbGluZXMgYmVmb3JlIHBvcyAob21pdCBwb3MgZm9yIGJlZ2lubmluZyBvZiBmaWxlKVxuXG5TZXQgbGluZXMgdG8gbnVsbCBvciBbXSB0byBkZWxldGUgbGluZXMuIFNldCBkZWxldGU6dHJ1ZSB0byBkZWxldGUgdGhlIGZpbGUuYDtcblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZUhhc2hsaW5lRWRpdFRvb2woY3dkOiBzdHJpbmcsIG9wdGlvbnM/OiBIYXNobGluZUVkaXRUb29sT3B0aW9ucyk6IEFnZW50VG9vbDx0eXBlb2YgaGFzaGxpbmVFZGl0U2NoZW1hPiB7XG5cdGNvbnN0IG9wcyA9IG9wdGlvbnM/Lm9wZXJhdGlvbnMgPz8gZGVmYXVsdEhhc2hsaW5lRWRpdE9wZXJhdGlvbnM7XG5cblx0cmV0dXJuIHtcblx0XHRuYW1lOiBcImhhc2hsaW5lX2VkaXRcIixcblx0XHRsYWJlbDogXCJoYXNobGluZV9lZGl0XCIsXG5cdFx0ZGVzY3JpcHRpb246IEhBU0hMSU5FX0VESVRfREVTQ1JJUFRJT04sXG5cdFx0cGFyYW1ldGVyczogaGFzaGxpbmVFZGl0U2NoZW1hLFxuXHRcdGV4ZWN1dGU6IGFzeW5jIChcblx0XHRcdF90b29sQ2FsbElkOiBzdHJpbmcsXG5cdFx0XHRwYXJhbXM6IEhhc2hsaW5lRWRpdElucHV0LFxuXHRcdFx0c2lnbmFsPzogQWJvcnRTaWduYWwsXG5cdFx0KSA9PiB7XG5cdFx0XHRjb25zdCB7IHBhdGgsIGVkaXRzLCBkZWxldGU6IGRlbGV0ZUZpbGUsIG1vdmUgfSA9IHBhcmFtcztcblx0XHRcdGNvbnN0IGFic29sdXRlUGF0aCA9IHJlc29sdmVUb0N3ZChwYXRoLCBjd2QpO1xuXG5cdFx0XHRyZXR1cm4gbmV3IFByb21pc2U8e1xuXHRcdFx0XHRjb250ZW50OiBBcnJheTx7IHR5cGU6IFwidGV4dFwiOyB0ZXh0OiBzdHJpbmcgfT47XG5cdFx0XHRcdGRldGFpbHM6IEhhc2hsaW5lRWRpdFRvb2xEZXRhaWxzIHwgdW5kZWZpbmVkO1xuXHRcdFx0fT4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuXHRcdFx0XHRpZiAoc2lnbmFsPy5hYm9ydGVkKSB7XG5cdFx0XHRcdFx0cmVqZWN0KG5ldyBFcnJvcihcIk9wZXJhdGlvbiBhYm9ydGVkXCIpKTtcblx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRsZXQgYWJvcnRlZCA9IGZhbHNlO1xuXHRcdFx0XHRjb25zdCBvbkFib3J0ID0gKCkgPT4ge1xuXHRcdFx0XHRcdGFib3J0ZWQgPSB0cnVlO1xuXHRcdFx0XHRcdHJlamVjdChuZXcgRXJyb3IoXCJPcGVyYXRpb24gYWJvcnRlZFwiKSk7XG5cdFx0XHRcdH07XG5cdFx0XHRcdGlmIChzaWduYWwpIHtcblx0XHRcdFx0XHRzaWduYWwuYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQWJvcnQsIHsgb25jZTogdHJ1ZSB9KTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdChhc3luYyAoKSA9PiB7XG5cdFx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRcdC8vIEhhbmRsZSBkZWxldGVcblx0XHRcdFx0XHRcdGlmIChkZWxldGVGaWxlKSB7XG5cdFx0XHRcdFx0XHRcdGxldCBmaWxlRXhpc3RzID0gdHJ1ZTtcblx0XHRcdFx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRcdFx0XHRhd2FpdCBvcHMuYWNjZXNzKGFic29sdXRlUGF0aCk7XG5cdFx0XHRcdFx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHRcdFx0XHRcdGZpbGVFeGlzdHMgPSBmYWxzZTtcblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHRpZiAoZmlsZUV4aXN0cykge1xuXHRcdFx0XHRcdFx0XHRcdGF3YWl0IG9wcy51bmxpbmsoYWJzb2x1dGVQYXRoKTtcblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHRpZiAoc2lnbmFsKSBzaWduYWwucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQWJvcnQpO1xuXHRcdFx0XHRcdFx0XHRyZXNvbHZlKHtcblx0XHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogZmlsZUV4aXN0cyA/IGBEZWxldGVkICR7cGF0aH1gIDogYEZpbGUgbm90IGZvdW5kLCBub3RoaW5nIHRvIGRlbGV0ZTogJHtwYXRofWAgfV0sXG5cdFx0XHRcdFx0XHRcdFx0ZGV0YWlsczogeyBkaWZmOiBcIlwiIH0sXG5cdFx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdC8vIEhhbmRsZSBmaWxlIGNyZWF0aW9uIChubyBleGlzdGluZyBmaWxlLCBhbmNob3JsZXNzIGFwcGVuZHMvcHJlcGVuZHMpXG5cdFx0XHRcdFx0XHRsZXQgZmlsZUV4aXN0cyA9IHRydWU7XG5cdFx0XHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdFx0XHRhd2FpdCBvcHMuYWNjZXNzKGFic29sdXRlUGF0aCk7XG5cdFx0XHRcdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0XHRcdFx0ZmlsZUV4aXN0cyA9IGZhbHNlO1xuXHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHRpZiAoIWZpbGVFeGlzdHMpIHtcblx0XHRcdFx0XHRcdFx0Y29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG5cdFx0XHRcdFx0XHRcdGZvciAoY29uc3QgZWRpdCBvZiBlZGl0cykge1xuXHRcdFx0XHRcdFx0XHRcdGlmICgoZWRpdC5vcCA9PT0gXCJhcHBlbmRcIiB8fCBlZGl0Lm9wID09PSBcInByZXBlbmRcIikgJiYgIWVkaXQucG9zICYmICFlZGl0LmVuZCkge1xuXHRcdFx0XHRcdFx0XHRcdFx0aWYgKGVkaXQub3AgPT09IFwicHJlcGVuZFwiKSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRcdGxpbmVzLnVuc2hpZnQoLi4ucGFyc2VIYXNobGluZVRleHQoZWRpdC5saW5lcykpO1xuXHRcdFx0XHRcdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdFx0XHRcdFx0bGluZXMucHVzaCguLi5wYXJzZUhhc2hsaW5lVGV4dChlZGl0LmxpbmVzKSk7XG5cdFx0XHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcihgRmlsZSBub3QgZm91bmQ6ICR7cGF0aH1gKTtcblx0XHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0YXdhaXQgb3BzLndyaXRlRmlsZShhYnNvbHV0ZVBhdGgsIGxpbmVzLmpvaW4oXCJcXG5cIikpO1xuXHRcdFx0XHRcdFx0XHRpZiAoc2lnbmFsKSBzaWduYWwucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQWJvcnQpO1xuXHRcdFx0XHRcdFx0XHRyZXNvbHZlKHtcblx0XHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYENyZWF0ZWQgJHtwYXRofWAgfV0sXG5cdFx0XHRcdFx0XHRcdFx0ZGV0YWlsczogeyBkaWZmOiBcIlwiIH0sXG5cdFx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdGlmIChhYm9ydGVkKSByZXR1cm47XG5cblx0XHRcdFx0XHRcdC8vIFJlYWQgZmlsZVxuXHRcdFx0XHRcdFx0Y29uc3QgcmF3Q29udGVudCA9IChhd2FpdCBvcHMucmVhZEZpbGUoYWJzb2x1dGVQYXRoKSkudG9TdHJpbmcoXCJ1dGYtOFwiKTtcblx0XHRcdFx0XHRcdGNvbnN0IHsgYm9tLCB0ZXh0IH0gPSBzdHJpcEJvbShyYXdDb250ZW50KTtcblx0XHRcdFx0XHRcdGNvbnN0IG9yaWdpbmFsRW5kaW5nID0gZGV0ZWN0TGluZUVuZGluZyh0ZXh0KTtcblx0XHRcdFx0XHRcdGNvbnN0IG9yaWdpbmFsTm9ybWFsaXplZCA9IG5vcm1hbGl6ZVRvTEYodGV4dCk7XG5cblx0XHRcdFx0XHRcdGlmIChhYm9ydGVkKSByZXR1cm47XG5cblx0XHRcdFx0XHRcdC8vIFJlc29sdmUgYW5kIGFwcGx5IGVkaXRzXG5cdFx0XHRcdFx0XHRjb25zdCBhbmNob3JFZGl0cyA9IHJlc29sdmVFZGl0QW5jaG9ycyhlZGl0cyk7XG5cdFx0XHRcdFx0XHRjb25zdCByZXN1bHQgPSBhcHBseUhhc2hsaW5lRWRpdHMob3JpZ2luYWxOb3JtYWxpemVkLCBhbmNob3JFZGl0cyk7XG5cblx0XHRcdFx0XHRcdGlmIChvcmlnaW5hbE5vcm1hbGl6ZWQgPT09IHJlc3VsdC5saW5lcyAmJiAhbW92ZSkge1xuXHRcdFx0XHRcdFx0XHRsZXQgZGlhZ25vc3RpYyA9IGBObyBjaGFuZ2VzIG1hZGUgdG8gJHtwYXRofS4gVGhlIGVkaXRzIHByb2R1Y2VkIGlkZW50aWNhbCBjb250ZW50LmA7XG5cdFx0XHRcdFx0XHRcdGlmIChyZXN1bHQubm9vcEVkaXRzICYmIHJlc3VsdC5ub29wRWRpdHMubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRcdFx0XHRcdGNvbnN0IGRldGFpbHMgPSByZXN1bHQubm9vcEVkaXRzXG5cdFx0XHRcdFx0XHRcdFx0XHQubWFwKFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRlID0+XG5cdFx0XHRcdFx0XHRcdFx0XHRcdFx0YEVkaXQgJHtlLmVkaXRJbmRleH06IHJlcGxhY2VtZW50IGZvciAke2UubG9jfSBpcyBpZGVudGljYWwgdG8gY3VycmVudCBjb250ZW50OlxcbiAgJHtlLmxvY318ICR7ZS5jdXJyZW50fWAsXG5cdFx0XHRcdFx0XHRcdFx0XHQpXG5cdFx0XHRcdFx0XHRcdFx0XHQuam9pbihcIlxcblwiKTtcblx0XHRcdFx0XHRcdFx0XHRkaWFnbm9zdGljICs9IGBcXG4ke2RldGFpbHN9YDtcblx0XHRcdFx0XHRcdFx0XHRkaWFnbm9zdGljICs9XG5cdFx0XHRcdFx0XHRcdFx0XHRcIlxcbllvdXIgY29udGVudCBtdXN0IGRpZmZlciBmcm9tIHdoYXQgdGhlIGZpbGUgYWxyZWFkeSBjb250YWlucy4gUmUtcmVhZCB0aGUgZmlsZSB0byBzZWUgdGhlIGN1cnJlbnQgc3RhdGUuXCI7XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKGRpYWdub3N0aWMpO1xuXHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHRpZiAoYWJvcnRlZCkgcmV0dXJuO1xuXG5cdFx0XHRcdFx0XHQvLyBXcml0ZSByZXN1bHRcblx0XHRcdFx0XHRcdGNvbnN0IGZpbmFsQ29udGVudCA9IGJvbSArIHJlc3RvcmVMaW5lRW5kaW5ncyhyZXN1bHQubGluZXMsIG9yaWdpbmFsRW5kaW5nKTtcblx0XHRcdFx0XHRcdGNvbnN0IHdyaXRlUGF0aCA9IG1vdmUgPyByZXNvbHZlVG9Dd2QobW92ZSwgY3dkKSA6IGFic29sdXRlUGF0aDtcblxuXHRcdFx0XHRcdFx0Ly8gUHJldmVudCBzaWxlbnQgb3ZlcndyaXRlIHdoZW4gbW92aW5nIHRvIGFuIGV4aXN0aW5nIGZpbGVcblx0XHRcdFx0XHRcdGlmIChtb3ZlICYmIHdyaXRlUGF0aCAhPT0gYWJzb2x1dGVQYXRoKSB7XG5cdFx0XHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHRcdFx0YXdhaXQgb3BzLmFjY2Vzcyh3cml0ZVBhdGgpO1xuXHRcdFx0XHRcdFx0XHRcdC8vIElmIGFjY2VzcyBzdWNjZWVkcywgdGhlIGZpbGUgZXhpc3RzIFx1MjAxNCByZWZ1c2UgdGhlIG1vdmVcblx0XHRcdFx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoYERlc3RpbmF0aW9uIGZpbGUgYWxyZWFkeSBleGlzdHM6ICR7d3JpdGVQYXRofS4gVXNlIGEgZGlmZmVyZW50IHBhdGggb3IgZGVsZXRlIHRoZSBleGlzdGluZyBmaWxlIGZpcnN0LmApO1xuXHRcdFx0XHRcdFx0XHR9IGNhdGNoIChlcnI6IGFueSkge1xuXHRcdFx0XHRcdFx0XHRcdC8vIFJlLXRocm93IG91ciBvd24gZXJyb3I7IHN3YWxsb3cgb25seSBcImZpbGUgbm90IGZvdW5kXCJcblx0XHRcdFx0XHRcdFx0XHRpZiAoZXJyLm1lc3NhZ2U/LnN0YXJ0c1dpdGgoXCJEZXN0aW5hdGlvbiBmaWxlIGFscmVhZHkgZXhpc3RzOlwiKSkgdGhyb3cgZXJyO1xuXHRcdFx0XHRcdFx0XHRcdC8vIEZpbGUgZG9lc24ndCBleGlzdCBcdTIwMTQgc2FmZSB0byBwcm9jZWVkXG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0YXdhaXQgb3BzLndyaXRlRmlsZSh3cml0ZVBhdGgsIGZpbmFsQ29udGVudCk7XG5cblx0XHRcdFx0XHRcdC8vIElmIG1vdmVkLCBkZWxldGUgb3JpZ2luYWxcblx0XHRcdFx0XHRcdGlmIChtb3ZlICYmIHdyaXRlUGF0aCAhPT0gYWJzb2x1dGVQYXRoKSB7XG5cdFx0XHRcdFx0XHRcdGF3YWl0IG9wcy51bmxpbmsoYWJzb2x1dGVQYXRoKTtcblx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0aWYgKGFib3J0ZWQpIHJldHVybjtcblxuXHRcdFx0XHRcdFx0aWYgKHNpZ25hbCkgc2lnbmFsLnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkFib3J0KTtcblxuXHRcdFx0XHRcdFx0Y29uc3QgZGlmZlJlc3VsdCA9IGdlbmVyYXRlRGlmZlN0cmluZyhvcmlnaW5hbE5vcm1hbGl6ZWQsIHJlc3VsdC5saW5lcyk7XG5cdFx0XHRcdFx0XHRjb25zdCByZXN1bHRUZXh0ID0gbW92ZSA/IGBNb3ZlZCAke3BhdGh9IHRvICR7bW92ZX1gIDogYFVwZGF0ZWQgJHtwYXRofWA7XG5cdFx0XHRcdFx0XHRjb25zdCB3YXJuaW5nc0Jsb2NrID0gcmVzdWx0Lndhcm5pbmdzPy5sZW5ndGhcblx0XHRcdFx0XHRcdFx0PyBgXFxuV2FybmluZ3M6XFxuJHtyZXN1bHQud2FybmluZ3Muam9pbihcIlxcblwiKX1gXG5cdFx0XHRcdFx0XHRcdDogXCJcIjtcblxuXHRcdFx0XHRcdFx0cmVzb2x2ZSh7XG5cdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFtcblx0XHRcdFx0XHRcdFx0XHR7XG5cdFx0XHRcdFx0XHRcdFx0XHR0eXBlOiBcInRleHRcIixcblx0XHRcdFx0XHRcdFx0XHRcdHRleHQ6IGAke3Jlc3VsdFRleHR9JHt3YXJuaW5nc0Jsb2NrfWAsXG5cdFx0XHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRcdFx0XSxcblx0XHRcdFx0XHRcdFx0ZGV0YWlsczoge1xuXHRcdFx0XHRcdFx0XHRcdGRpZmY6IGRpZmZSZXN1bHQuZGlmZixcblx0XHRcdFx0XHRcdFx0XHRmaXJzdENoYW5nZWRMaW5lOiByZXN1bHQuZmlyc3RDaGFuZ2VkTGluZSA/PyBkaWZmUmVzdWx0LmZpcnN0Q2hhbmdlZExpbmUsXG5cdFx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHR9IGNhdGNoIChlcnJvcjogYW55KSB7XG5cdFx0XHRcdFx0XHRpZiAoc2lnbmFsKSBzaWduYWwucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQWJvcnQpO1xuXHRcdFx0XHRcdFx0aWYgKCFhYm9ydGVkKSB7XG5cdFx0XHRcdFx0XHRcdHJlamVjdChlcnJvcik7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9KSgpO1xuXHRcdFx0fSk7XG5cdFx0fSxcblx0fTtcbn1cblxuLyoqIERlZmF1bHQgaGFzaGxpbmUgZWRpdCB0b29sIHVzaW5nIHByb2Nlc3MuY3dkKCkgKi9cbmV4cG9ydCBjb25zdCBoYXNobGluZUVkaXRUb29sID0gY3JlYXRlSGFzaGxpbmVFZGl0VG9vbChwcm9jZXNzLmN3ZCgpKTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQU9BLFNBQXNCLFlBQVk7QUFDbEMsU0FBUyxpQkFBaUI7QUFDMUIsU0FBUyxVQUFVLFVBQVUsWUFBWSxZQUFZLFVBQVUsVUFBVSxhQUFhLG1CQUFtQjtBQUN6RztBQUFBLEVBQ0M7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDTTtBQUNQO0FBQUEsRUFFQztBQUFBLEVBR0E7QUFBQSxFQUNBO0FBQUEsT0FDTTtBQUNQLFNBQVMsb0JBQW9CO0FBTTdCLE1BQU0seUJBQXlCLEtBQUs7QUFBQSxFQUNuQztBQUFBLElBQ0MsSUFBSSxLQUFLLE1BQU0sQ0FBQyxLQUFLLFFBQVEsU0FBUyxHQUFHLEtBQUssUUFBUSxRQUFRLEdBQUcsS0FBSyxRQUFRLFNBQVMsQ0FBQyxDQUFDO0FBQUEsSUFDekYsS0FBSyxLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSwyQkFBNkIsQ0FBQyxDQUFDO0FBQUEsSUFDN0UsS0FBSyxLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSwrQkFBK0IsQ0FBQyxDQUFDO0FBQUEsSUFDL0UsT0FBTyxLQUFLLE1BQU07QUFBQSxNQUNqQixLQUFLLE1BQU0sS0FBSyxPQUFPLEdBQUcsRUFBRSxhQUFhLDRCQUE0QixDQUFDO0FBQUEsTUFDdEUsS0FBSyxPQUFPO0FBQUEsTUFDWixLQUFLLEtBQUs7QUFBQSxJQUNYLENBQUM7QUFBQSxFQUNGO0FBQUEsRUFDQSxFQUFFLHNCQUFzQixNQUFNO0FBQy9CO0FBRUEsTUFBTSxxQkFBcUIsS0FBSztBQUFBLEVBQy9CO0FBQUEsSUFDQyxNQUFNLEtBQUssT0FBTyxFQUFFLGFBQWEsMkJBQTJCLENB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
