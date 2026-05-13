import { Type } from "@sinclair/typebox";
import { mkdir as fsMkdir, writeFile as fsWriteFile } from "fs/promises";
import { dirname } from "path";
import { notifyFileChanged } from "../lsp/client.js";
import { resolveToCwd } from "./path-utils.js";
import { createToolTarget } from "./tool-target.js";
const writeSchema = Type.Object({
  path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
  content: Type.String({ description: "Content to write to the file" })
});
const defaultWriteOperations = {
  writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
  mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {
  })
};
function createWriteTool(cwd, options) {
  const ops = options?.operations ?? defaultWriteOperations;
  return {
    name: "write",
    label: "write",
    description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    parameters: writeSchema,
    execute: async (_toolCallId, { path, content }, signal) => {
      const absolutePath = resolveToCwd(path, cwd);
      const dir = dirname(absolutePath);
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
              await ops.mkdir(dir);
              if (aborted) {
                return;
              }
              await ops.writeFile(absolutePath, content);
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
              resolve({
                content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` }],
                details: {
                  target: createToolTarget({
                    kind: "file",
                    action: "write",
                    inputPath: path,
                    resolvedPath: absolutePath
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
        }
      );
    }
  };
}
const writeTool = createWriteTool(process.cwd());
export {
  createWriteTool,
  writeTool
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL3Rvb2xzL3dyaXRlLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdHlwZSB7IEFnZW50VG9vbCB9IGZyb20gXCJAZ3NkL3BpLWFnZW50LWNvcmVcIjtcbmltcG9ydCB7IHR5cGUgU3RhdGljLCBUeXBlIH0gZnJvbSBcIkBzaW5jbGFpci90eXBlYm94XCI7XG5pbXBvcnQgeyBta2RpciBhcyBmc01rZGlyLCB3cml0ZUZpbGUgYXMgZnNXcml0ZUZpbGUgfSBmcm9tIFwiZnMvcHJvbWlzZXNcIjtcbmltcG9ydCB7IGRpcm5hbWUgfSBmcm9tIFwicGF0aFwiO1xuaW1wb3J0IHsgbm90aWZ5RmlsZUNoYW5nZWQgfSBmcm9tIFwiLi4vbHNwL2NsaWVudC5qc1wiO1xuaW1wb3J0IHsgcmVzb2x2ZVRvQ3dkIH0gZnJvbSBcIi4vcGF0aC11dGlscy5qc1wiO1xuaW1wb3J0IHsgY3JlYXRlVG9vbFRhcmdldCwgdHlwZSBUb29sVGFyZ2V0TWV0YWRhdGEgfSBmcm9tIFwiLi90b29sLXRhcmdldC5qc1wiO1xuXG5jb25zdCB3cml0ZVNjaGVtYSA9IFR5cGUuT2JqZWN0KHtcblx0cGF0aDogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJQYXRoIHRvIHRoZSBmaWxlIHRvIHdyaXRlIChyZWxhdGl2ZSBvciBhYnNvbHV0ZSlcIiB9KSxcblx0Y29udGVudDogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJDb250ZW50IHRvIHdyaXRlIHRvIHRoZSBmaWxlXCIgfSksXG59KTtcblxuZXhwb3J0IHR5cGUgV3JpdGVUb29sSW5wdXQgPSBTdGF0aWM8dHlwZW9mIHdyaXRlU2NoZW1hPjtcblxuZXhwb3J0IGludGVyZmFjZSBXcml0ZVRvb2xEZXRhaWxzIHtcblx0dGFyZ2V0PzogVG9vbFRhcmdldE1ldGFkYXRhO1xufVxuXG4vKipcbiAqIFBsdWdnYWJsZSBvcGVyYXRpb25zIGZvciB0aGUgd3JpdGUgdG9vbC5cbiAqIE92ZXJyaWRlIHRoZXNlIHRvIGRlbGVnYXRlIGZpbGUgd3JpdGluZyB0byByZW1vdGUgc3lzdGVtcyAoZS5nLiwgU1NIKS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBXcml0ZU9wZXJhdGlvbnMge1xuXHQvKiogV3JpdGUgY29udGVudCB0byBhIGZpbGUgKi9cblx0d3JpdGVGaWxlOiAoYWJzb2x1dGVQYXRoOiBzdHJpbmcsIGNvbnRlbnQ6IHN0cmluZykgPT4gUHJvbWlzZTx2b2lkPjtcblx0LyoqIENyZWF0ZSBkaXJlY3RvcnkgKHJlY3Vyc2l2ZWx5KSAqL1xuXHRta2RpcjogKGRpcjogc3RyaW5nKSA9PiBQcm9taXNlPHZvaWQ+O1xufVxuXG5jb25zdCBkZWZhdWx0V3JpdGVPcGVyYXRpb25zOiBXcml0ZU9wZXJhdGlvbnMgPSB7XG5cdHdyaXRlRmlsZTogKHBhdGgsIGNvbnRlbnQpID0+IGZzV3JpdGVGaWxlKHBhdGgsIGNvbnRlbnQsIFwidXRmLThcIiksXG5cdG1rZGlyOiAoZGlyKSA9PiBmc01rZGlyKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSkudGhlbigoKSA9PiB7fSksXG59O1xuXG5leHBvcnQgaW50ZXJmYWNlIFdyaXRlVG9vbE9wdGlvbnMge1xuXHQvKiogQ3VzdG9tIG9wZXJhdGlvbnMgZm9yIGZpbGUgd3JpdGluZy4gRGVmYXVsdDogbG9jYWwgZmlsZXN5c3RlbSAqL1xuXHRvcGVyYXRpb25zPzogV3JpdGVPcGVyYXRpb25zO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlV3JpdGVUb29sKGN3ZDogc3RyaW5nLCBvcHRpb25zPzogV3JpdGVUb29sT3B0aW9ucyk6IEFnZW50VG9vbDx0eXBlb2Ygd3JpdGVTY2hlbWE+IHtcblx0Y29uc3Qgb3BzID0gb3B0aW9ucz8ub3BlcmF0aW9ucyA/PyBkZWZhdWx0V3JpdGVPcGVyYXRpb25zO1xuXG5cdHJldHVybiB7XG5cdFx0bmFtZTogXCJ3cml0ZVwiLFxuXHRcdGxhYmVsOiBcIndyaXRlXCIsXG5cdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcIldyaXRlIGNvbnRlbnQgdG8gYSBmaWxlLiBDcmVhdGVzIHRoZSBmaWxlIGlmIGl0IGRvZXNuJ3QgZXhpc3QsIG92ZXJ3cml0ZXMgaWYgaXQgZG9lcy4gQXV0b21hdGljYWxseSBjcmVhdGVzIHBhcmVudCBkaXJlY3Rvcmllcy5cIixcblx0XHRwYXJhbWV0ZXJzOiB3cml0ZVNjaGVtYSxcblx0XHRleGVjdXRlOiBhc3luYyAoXG5cdFx0XHRfdG9vbENhbGxJZDogc3RyaW5nLFxuXHRcdFx0eyBwYXRoLCBjb250ZW50IH06IHsgcGF0aDogc3RyaW5nOyBjb250ZW50OiBzdHJpbmcgfSxcblx0XHRcdHNpZ25hbD86IEFib3J0U2lnbmFsLFxuXHRcdCkgPT4ge1xuXHRcdFx0Y29uc3QgYWJzb2x1dGVQYXRoID0gcmVzb2x2ZVRvQ3dkKHBhdGgsIGN3ZCk7XG5cdFx0XHRjb25zdCBkaXIgPSBkaXJuYW1lKGFic29sdXRlUGF0aCk7XG5cblx0XHRcdHJldHVybiBuZXcgUHJvbWlzZTx7IGNvbnRlbnQ6IEFycmF5PHsgdHlwZTogXCJ0ZXh0XCI7IHRleHQ6IHN0cmluZyB9PjsgZGV0YWlsczogV3JpdGVUb29sRGV0YWlscyB8IHVuZGVmaW5lZCB9Pihcblx0XHRcdFx0KHJlc29sdmUsIHJlamVjdCkgPT4ge1xuXHRcdFx0XHRcdC8vIENoZWNrIGlmIGFscmVhZHkgYWJvcnRlZFxuXHRcdFx0XHRcdGlmIChzaWduYWw/LmFib3J0ZWQpIHtcblx0XHRcdFx0XHRcdHJlamVjdChuZXcgRXJyb3IoXCJPcGVyYXRpb24gYWJvcnRlZFwiKSk7XG5cdFx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0bGV0IGFib3J0ZWQgPSBmYWxzZTtcblxuXHRcdFx0XHRcdC8vIFNldCB1cCBhYm9ydCBoYW5kbGVyXG5cdFx0XHRcdFx0Y29uc3Qgb25BYm9ydCA9ICgpID0+IHtcblx0XHRcdFx0XHRcdGFib3J0ZWQgPSB0cnVlO1xuXHRcdFx0XHRcdFx0cmVqZWN0KG5ldyBFcnJvcihcIk9wZXJhdGlvbiBhYm9ydGVkXCIpKTtcblx0XHRcdFx0XHR9O1xuXG5cdFx0XHRcdFx0aWYgKHNpZ25hbCkge1xuXHRcdFx0XHRcdFx0c2lnbmFsLmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkFib3J0LCB7IG9uY2U6IHRydWUgfSk7XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Ly8gUGVyZm9ybSB0aGUgd3JpdGUgb3BlcmF0aW9uXG5cdFx0XHRcdFx0KGFzeW5jICgpID0+IHtcblx0XHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHRcdC8vIENyZWF0ZSBwYXJlbnQgZGlyZWN0b3JpZXMgaWYgbmVlZGVkXG5cdFx0XHRcdFx0XHRcdGF3YWl0IG9wcy5ta2RpcihkaXIpO1xuXG5cdFx0XHRcdFx0XHRcdC8vIENoZWNrIGlmIGFib3J0ZWQgYmVmb3JlIHdyaXRpbmdcblx0XHRcdFx0XHRcdFx0aWYgKGFib3J0ZWQpIHtcblx0XHRcdFx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0XHQvLyBXcml0ZSB0aGUgZmlsZVxuXHRcdFx0XHRcdFx0XHRhd2FpdCBvcHMud3JpdGVGaWxlKGFic29sdXRlUGF0aCwgY29udGVudCk7XG5cblx0XHRcdFx0XHRcdFx0dHJ5IHsgbm90aWZ5RmlsZUNoYW5nZWQoYWJzb2x1dGVQYXRoKTsgfSBjYXRjaCB7IC8qIGJlc3QtZWZmb3J0ICovIH1cblxuXHRcdFx0XHRcdFx0XHQvLyBDaGVjayBpZiBhYm9ydGVkIGFmdGVyIHdyaXRpbmdcblx0XHRcdFx0XHRcdFx0aWYgKGFib3J0ZWQpIHtcblx0XHRcdFx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0XHQvLyBDbGVhbiB1cCBhYm9ydCBoYW5kbGVyXG5cdFx0XHRcdFx0XHRcdGlmIChzaWduYWwpIHtcblx0XHRcdFx0XHRcdFx0XHRzaWduYWwucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQWJvcnQpO1xuXHRcdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdFx0cmVzb2x2ZSh7XG5cdFx0XHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBTdWNjZXNzZnVsbHkgd3JvdGUgJHtjb250ZW50Lmxlbmd0aH0gYnl0ZXMgdG8gJHtwYXRofWAgfV0sXG5cdFx0XHRcdFx0XHRcdFx0ZGV0YWlsczoge1xuXHRcdFx0XHRcdFx0XHRcdFx0dGFyZ2V0OiBjcmVhdGVUb29sVGFyZ2V0KHtcblx0XHRcdFx0XHRcdFx0XHRcdFx0a2luZDogXCJmaWxlXCIsXG5cdFx0XHRcdFx0XHRcdFx0XHRcdGFjdGlvbjogXCJ3cml0ZVwiLFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRpbnB1dFBhdGg6IHBhdGgsXG5cdFx0XHRcdFx0XHRcdFx0XHRcdHJlc29sdmVkUGF0aDogYWJzb2x1dGVQYXRoLFxuXHRcdFx0XHRcdFx0XHRcdFx0fSksXG5cdFx0XHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0XHR9IGNhdGNoIChlcnJvcjogYW55KSB7XG5cdFx0XHRcdFx0XHRcdC8vIENsZWFuIHVwIGFib3J0IGhhbmRsZXJcblx0XHRcdFx0XHRcdFx0aWYgKHNpZ25hbCkge1xuXHRcdFx0XHRcdFx0XHRcdHNpZ25hbC5yZW1vdmVFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25BYm9ydCk7XG5cdFx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0XHRpZiAoIWFib3J0ZWQpIHtcblx0XHRcdFx0XHRcdFx0XHRyZWplY3QoZXJyb3IpO1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fSkoKTtcblx0XHRcdFx0fSxcblx0XHRcdCk7XG5cdFx0fSxcblx0fTtcbn1cblxuLyoqIERlZmF1bHQgd3JpdGUgdG9vbCB1c2luZyBwcm9jZXNzLmN3ZCgpIC0gZm9yIGJhY2t3YXJkcyBjb21wYXRpYmlsaXR5ICovXG5leHBvcnQgY29uc3Qgd3JpdGVUb29sID0gY3JlYXRlV3JpdGVUb29sKHByb2Nlc3MuY3dkKCkpO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQ0EsU0FBc0IsWUFBWTtBQUNsQyxTQUFTLFNBQVMsU0FBUyxhQUFhLG1CQUFtQjtBQUMzRCxTQUFTLGVBQWU7QUFDeEIsU0FBUyx5QkFBeUI7QUFDbEMsU0FBUyxvQkFBb0I7QUFDN0IsU0FBUyx3QkFBaUQ7QUFFMUQsTUFBTSxjQUFjLEtBQUssT0FBTztBQUFBLEVBQy9CLE1BQU0sS0FBSyxPQUFPLEVBQUUsYUFBYSxtREFBbUQsQ0FBQztBQUFBLEVBQ3JGLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSwrQkFBK0IsQ0FBQztBQUNyRSxDQUFDO0FBbUJELE1BQU0seUJBQTBDO0FBQUEsRUFDL0MsV0FBVyxDQUFDLE1BQU0sWUFBWSxZQUFZLE1BQU0sU0FBUyxPQUFPO0FBQUEsRUFDaEUsT0FBTyxDQUFDLFFBQVEsUUFBUSxLQUFLLEVBQUUsV0FBVyxLQUFLLENBQUMsRUFBRSxLQUFLLE1BQU07QUFBQSxFQUFDLENBQUM7QUFDaEU7QUFPTyxTQUFTLGdCQUFnQixLQUFhLFNBQTJEO0FBQ3ZHLFFBQU0sTUFBTSxTQUFTLGNBQWM7QUFFbkMsU0FBTztBQUFBLElBQ04sTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsYUFDQztBQUFBLElBQ0QsWUFBWTtBQUFBLElBQ1osU0FBUyxPQUNSLGFBQ0EsRUFBRSxNQUFNLFFBQVEsR0FDaEIsV0FDSTtBQUNKLFlBQU0sZUFBZSxhQUFhLE1BQU0sR0FBRztBQUMzQyxZQUFNLE1BQU0sUUFBUSxZQUFZO0FBRWhDLGFBQU8sSUFBSTtBQUFBLFFBQ1YsQ0FBQyxTQUFTLFdBQVc7QUFFcEIsY0FBSSxRQUFRLFNBQVM7QUFDcEIsbUJBQU8sSUFBSSxNQUFNLG1CQUFtQixDQUFDO0FBQ3JDO0FBQUEsVUFDRDtBQUVBLGNBQUksVUFBVTtBQUdkLGdCQUFNLFVBQVUsTUFBTTtBQUNyQixzQkFBVTtBQUNWLG1CQUFPLElBQUksTUFBTSxtQkFBbUIsQ0FBQztBQUFBLFVBQ3RDO0FBRUEsY0FBSSxRQUFRO0FBQ1gsbUJBQU8saUJBQWlCLFNBQVMsU0FBUyxFQUFFLE1BQU0sS0FBSyxDQUFDO0FBQUEsVUFDekQ7QUFHQSxXQUFDLFlBQVk7QUFDWixnQkFBSTtBQUVILG9CQUFNLElBQUksTUFBTSxHQUFHO0FBR25CLGtCQUFJLFNBQVM7QUFDWjtBQUFBLGNBQ0Q7QUFHQSxvQkFBTSxJQUFJLFVBQVUsY0FBYyxPQUFPO0FBRXpDLGtCQUFJO0FBQUUsa0NBQWtCLFlBQVk7QUFBQSxjQUFHLFFBQVE7QUFBQSxjQUFvQjtBQUduRSxrQkFBSSxTQUFTO0FBQ1o7QUFBQSxjQUNEO0FBR0Esa0JBQUksUUFBUTtBQUNYLHVCQUFPLG9CQUFvQixTQUFTLE9BQU87QUFBQSxjQUM1QztBQUVBLHNCQUFRO0FBQUEsZ0JBQ1AsU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFRLE1BQU0sc0JBQXNCLFFBQVEsTUFBTSxhQUFhLElBQUksR0FBRyxDQUFDO0FBQUEsZ0JBQ3pGLFNBQVM7QUFBQSxrQkFDUixRQUFRLGlCQUFpQjtBQUFBLG9CQUN4QixNQUFNO0FBQUEsb0JBQ04sUUFBUTtBQUFBLG9CQUNSLFdBQVc7QUFBQSxvQkFDWCxjQUFjO0FBQUEsa0JBQ2YsQ0FBQztBQUFBLGdCQUNGO0FBQUEsY0FDRCxDQUFDO0FBQUEsWUFDRixTQUFTLE9BQVk7QUFFcEIsa0JBQUksUUFBUTtBQUNYLHVCQUFPLG9CQUFvQixTQUFTLE9BQU87QUFBQSxjQUM1QztBQUVBLGtCQUFJLENBQUMsU0FBUztBQUNiLHVCQUFPLEtBQUs7QUFBQSxjQUNiO0FBQUEsWUFDRDtBQUFBLFVBQ0QsR0FBRztBQUFBLFFBQ0o7QUFBQSxNQUNEO0FBQUEsSUFDRDtBQUFBLEVBQ0Q7QUFDRDtBQUdPLE1BQU0sWUFBWSxnQkFBZ0IsUUFBUSxJQUFJLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
