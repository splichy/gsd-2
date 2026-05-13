import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEditTool } from "./edit.js";
import { createFindTool } from "./find.js";
import { createGrepTool } from "./grep.js";
import { createLsTool } from "./ls.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";
test("read metadata records resolved path without changing output text", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gsd-read-target-"));
  try {
    const filePath = join(cwd, "fixture.txt");
    writeFileSync(filePath, "one\ntwo\nthree\n", "utf8");
    const result = await createReadTool(cwd).execute("read-1", {
      path: "fixture.txt",
      offset: 2,
      limit: 1
    });
    assert.equal(result.details?.target?.resolvedPath, filePath);
    assert.deepEqual(result.details?.target?.range, { start: 2, end: 2 });
    assert.equal(result.content[0]?.type, "text");
    assert.match(result.content[0]?.text ?? "", /^two/);
    assert.equal((result.content[0]?.text ?? "").includes(filePath), false);
    const zeroOffsetResult = await createReadTool(cwd).execute("read-zero-offset", {
      path: "fixture.txt",
      offset: 0,
      limit: 1
    });
    assert.deepEqual(zeroOffsetResult.details?.target?.range, { start: 1, end: 1 });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
test("write metadata records resolved path without changing output text", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gsd-write-target-"));
  try {
    const filePath = join(cwd, "out.txt");
    const result = await createWriteTool(cwd).execute("write-1", {
      path: "out.txt",
      content: "hello"
    });
    assert.equal(result.details?.target?.resolvedPath, filePath);
    assert.equal(result.content[0]?.type, "text");
    assert.equal(result.content[0]?.text, "Successfully wrote 5 bytes to out.txt");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
test("edit metadata records first changed line and resolved path", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gsd-edit-target-"));
  try {
    const filePath = join(cwd, "edit.txt");
    writeFileSync(filePath, "alpha\nbeta\ngamma\n", "utf8");
    const result = await createEditTool(cwd).execute("edit-1", {
      path: "edit.txt",
      oldText: "beta",
      newText: "delta"
    });
    assert.equal(result.details?.target?.resolvedPath, filePath);
    assert.equal(result.details?.target?.line, 2);
    assert.equal(result.details?.firstChangedLine, 2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
test("list and find metadata record resolved targets", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gsd-search-target-"));
  try {
    const srcPath = join(cwd, "src");
    const filePath = join(srcPath, "needle.txt");
    mkdirSync(srcPath);
    writeFileSync(filePath, "needle\n", "utf8");
    const lsResult = await createLsTool(cwd).execute("ls-1", { path: "src" });
    assert.equal(lsResult.details?.target?.resolvedPath, srcPath);
    const findResult = await createFindTool(cwd, {
      operations: {
        exists: () => true,
        glob: async () => [filePath]
      }
    }).execute("find-1", { path: "src", pattern: "needle" });
    assert.equal(findResult.details?.target?.resolvedPath, srcPath);
    assert.equal(findResult.details?.target?.pattern, "needle");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
test("grep metadata records resolved search target", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gsd-grep-target-"));
  try {
    const srcPath = join(cwd, "src");
    mkdirSync(srcPath);
    writeFileSync(join(srcPath, "needle.txt"), "needle\n", "utf8");
    const result = await createGrepTool(cwd).execute("grep-1", {
      path: "src",
      pattern: "needle",
      literal: true
    });
    assert.equal(result.details?.target?.resolvedPath, srcPath);
    assert.equal(result.details?.target?.pattern, "needle");
    assert.equal(result.content[0]?.type, "text");
    assert.match(result.content[0]?.text ?? "", /needle\.txt:1: needle/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL3Rvb2xzL3Rvb2wtdGFyZ2V0LW1ldGFkYXRhLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRC0yIC0gQmVoYXZpb3IgY292ZXJhZ2UgZm9yIHRvb2wgdGFyZ2V0IG1ldGFkYXRhLlxuXG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZGlyU3luYywgbWtkdGVtcFN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcblxuaW1wb3J0IHsgY3JlYXRlRWRpdFRvb2wgfSBmcm9tIFwiLi9lZGl0LmpzXCI7XG5pbXBvcnQgeyBjcmVhdGVGaW5kVG9vbCB9IGZyb20gXCIuL2ZpbmQuanNcIjtcbmltcG9ydCB7IGNyZWF0ZUdyZXBUb29sIH0gZnJvbSBcIi4vZ3JlcC5qc1wiO1xuaW1wb3J0IHsgY3JlYXRlTHNUb29sIH0gZnJvbSBcIi4vbHMuanNcIjtcbmltcG9ydCB7IGNyZWF0ZVJlYWRUb29sIH0gZnJvbSBcIi4vcmVhZC5qc1wiO1xuaW1wb3J0IHsgY3JlYXRlV3JpdGVUb29sIH0gZnJvbSBcIi4vd3JpdGUuanNcIjtcblxudGVzdChcInJlYWQgbWV0YWRhdGEgcmVjb3JkcyByZXNvbHZlZCBwYXRoIHdpdGhvdXQgY2hhbmdpbmcgb3V0cHV0IHRleHRcIiwgYXN5bmMgKCkgPT4ge1xuXHRjb25zdCBjd2QgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1yZWFkLXRhcmdldC1cIikpO1xuXHR0cnkge1xuXHRcdGNvbnN0IGZpbGVQYXRoID0gam9pbihjd2QsIFwiZml4dHVyZS50eHRcIik7XG5cdFx0d3JpdGVGaWxlU3luYyhmaWxlUGF0aCwgXCJvbmVcXG50d29cXG50aHJlZVxcblwiLCBcInV0ZjhcIik7XG5cblx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCBjcmVhdGVSZWFkVG9vbChjd2QpLmV4ZWN1dGUoXCJyZWFkLTFcIiwge1xuXHRcdFx0cGF0aDogXCJmaXh0dXJlLnR4dFwiLFxuXHRcdFx0b2Zmc2V0OiAyLFxuXHRcdFx0bGltaXQ6IDEsXG5cdFx0fSk7XG5cblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0LmRldGFpbHM/LnRhcmdldD8ucmVzb2x2ZWRQYXRoLCBmaWxlUGF0aCk7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQuZGV0YWlscz8udGFyZ2V0Py5yYW5nZSwgeyBzdGFydDogMiwgZW5kOiAyIH0pO1xuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQuY29udGVudFswXT8udHlwZSwgXCJ0ZXh0XCIpO1xuXHRcdGFzc2VydC5tYXRjaChyZXN1bHQuY29udGVudFswXT8udGV4dCA/PyBcIlwiLCAvXnR3by8pO1xuXHRcdGFzc2VydC5lcXVhbCgocmVzdWx0LmNvbnRlbnRbMF0/LnRleHQgPz8gXCJcIikuaW5jbHVkZXMoZmlsZVBhdGgpLCBmYWxzZSk7XG5cblx0XHRjb25zdCB6ZXJvT2Zmc2V0UmVzdWx0ID0gYXdhaXQgY3JlYXRlUmVhZFRvb2woY3dkKS5leGVjdXRlKFwicmVhZC16ZXJvLW9mZnNldFwiLCB7XG5cdFx0XHRwYXRoOiBcImZpeHR1cmUudHh0XCIsXG5cdFx0XHRvZmZzZXQ6IDAsXG5cdFx0XHRsaW1pdDogMSxcblx0XHR9KTtcblxuXHRcdGFzc2VydC5kZWVwRXF1YWwoemVyb09mZnNldFJlc3VsdC5kZXRhaWxzPy50YXJnZXQ/LnJhbmdlLCB7IHN0YXJ0OiAxLCBlbmQ6IDEgfSk7XG5cdH0gZmluYWxseSB7XG5cdFx0cm1TeW5jKGN3ZCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuXHR9XG59KTtcblxudGVzdChcIndyaXRlIG1ldGFkYXRhIHJlY29yZHMgcmVzb2x2ZWQgcGF0aCB3aXRob3V0IGNoYW5naW5nIG91dHB1dCB0ZXh0XCIsIGFzeW5jICgpID0+IHtcblx0Y29uc3QgY3dkID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2Qtd3JpdGUtdGFyZ2V0LVwiKSk7XG5cdHRyeSB7XG5cdFx0Y29uc3QgZmlsZVBhdGggPSBqb2luKGN3ZCwgXCJvdXQudHh0XCIpO1xuXHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNyZWF0ZVdyaXRlVG9vbChjd2QpLmV4ZWN1dGUoXCJ3cml0ZS0xXCIsIHtcblx0XHRcdHBhdGg6IFwib3V0LnR4dFwiLFxuXHRcdFx0Y29udGVudDogXCJoZWxsb1wiLFxuXHRcdH0pO1xuXG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5kZXRhaWxzPy50YXJnZXQ/LnJlc29sdmVkUGF0aCwgZmlsZVBhdGgpO1xuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQuY29udGVudFswXT8udHlwZSwgXCJ0ZXh0XCIpO1xuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQuY29udGVudFswXT8udGV4dCwgXCJTdWNjZXNzZnVsbHkgd3JvdGUgNSBieXRlcyB0byBvdXQudHh0XCIpO1xuXHR9IGZpbmFsbHkge1xuXHRcdHJtU3luYyhjd2QsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcblx0fVxufSk7XG5cbnRlc3QoXCJlZGl0IG1ldGFkYXRhIHJlY29yZHMgZmlyc3QgY2hhbmdlZCBsaW5lIGFuZCByZXNvbHZlZCBwYXRoXCIsIGFzeW5jICgpID0+IHtcblx0Y29uc3QgY3dkID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtZWRpdC10YXJnZXQtXCIpKTtcblx0dHJ5IHtcblx0XHRjb25zdCBmaWxlUGF0aCA9IGpvaW4oY3dkLCBcImVkaXQudHh0XCIpO1xuXHRcdHdyaXRlRmlsZVN5bmMoZmlsZVBhdGgsIFwiYWxwaGFcXG5iZXRhXFxuZ2FtbWFcXG5cIiwgXCJ1dGY4XCIpO1xuXG5cdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgY3JlYXRlRWRpdFRvb2woY3dkKS5leGVjdXRlKFwiZWRpdC0xXCIsIHtcblx0XHRcdHBhdGg6IFwiZWRpdC50eHRcIixcblx0XHRcdG9sZFRleHQ6IFwiYmV0YVwiLFxuXHRcdFx0bmV3VGV4dDogXCJkZWx0YVwiLFxuXHRcdH0pO1xuXG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5kZXRhaWxzPy50YXJnZXQ/LnJlc29sdmVkUGF0aCwgZmlsZVBhdGgpO1xuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQuZGV0YWlscz8udGFyZ2V0Py5saW5lLCAyKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0LmRldGFpbHM/LmZpcnN0Q2hhbmdlZExpbmUsIDIpO1xuXHR9IGZpbmFsbHkge1xuXHRcdHJtU3luYyhjd2QsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcblx0fVxufSk7XG5cbnRlc3QoXCJsaXN0IGFuZCBmaW5kIG1ldGFkYXRhIHJlY29yZCByZXNvbHZlZCB0YXJnZXRzXCIsIGFzeW5jICgpID0+IHtcblx0Y29uc3QgY3dkID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2Qtc2VhcmNoLXRhcmdldC1cIikpO1xuXHR0cnkge1xuXHRcdGNvbnN0IHNyY1BhdGggPSBqb2luKGN3ZCwgXCJzcmNcIik7XG5cdFx0Y29uc3QgZmlsZVBhdGggPSBqb2luKHNyY1BhdGgsIFwibmVlZGxlLnR4dFwiKTtcblx0XHRta2RpclN5bmMoc3JjUGF0aCk7XG5cdFx0d3JpdGVGaWxlU3luYyhmaWxlUGF0aCwgXCJuZWVkbGVcXG5cIiwgXCJ1dGY4XCIpO1xuXG5cdFx0Y29uc3QgbHNSZXN1bHQgPSBhd2FpdCBjcmVhdGVMc1Rvb2woY3dkKS5leGVjdXRlKFwibHMtMVwiLCB7IHBhdGg6IFwic3JjXCIgfSk7XG5cdFx0YXNzZXJ0LmVxdWFsKGxzUmVzdWx0LmRldGFpbHM/LnRhcmdldD8ucmVzb2x2ZWRQYXRoLCBzcmNQYXRoKTtcblxuXHRcdGNvbnN0IGZpbmRSZXN1bHQgPSBhd2FpdCBjcmVhdGVGaW5kVG9vbChjd2QsIHtcblx0XHRcdG9wZXJhdGlvbnM6IHtcblx0XHRcdFx0ZXhpc3RzOiAoKSA9PiB0cnVlLFxuXHRcdFx0XHRnbG9iOiBhc3luYyAoKSA9PiBbZmlsZVBhdGhdLFxuXHRcdFx0fSxcblx0XHR9KS5leGVjdXRlKFwiZmluZC0xXCIsIHsgcGF0aDogXCJzcmNcIiwgcGF0dGVybjogXCJuZWVkbGVcIiB9KTtcblx0XHRhc3NlcnQuZXF1YWwoZmluZFJlc3VsdC5kZXRhaWxzPy50YXJnZXQ/LnJlc29sdmVkUGF0aCwgc3JjUGF0aCk7XG5cdFx0YXNzZXJ0LmVxdWFsKGZpbmRSZXN1bHQuZGV0YWlscz8udGFyZ2V0Py5wYXR0ZXJuLCBcIm5lZWRsZVwiKTtcblx0fSBmaW5hbGx5IHtcblx0XHRybVN5bmMoY3dkLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG5cdH1cbn0pO1xuXG50ZXN0KFwiZ3JlcCBtZXRhZGF0YSByZWNvcmRzIHJlc29sdmVkIHNlYXJjaCB0YXJnZXRcIiwgYXN5bmMgKCkgPT4ge1xuXHRjb25zdCBjd2QgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1ncmVwLXRhcmdldC1cIikpO1xuXHR0cnkge1xuXHRcdGNvbnN0IHNyY1BhdGggPSBqb2luKGN3ZCwgXCJzcmNcIik7XG5cdFx0bWtkaXJTeW5jKHNyY1BhdGgpO1xuXHRcdHdyaXRlRmlsZVN5bmMoam9pbihzcmNQYXRoLCBcIm5lZWRsZS50eHRcIiksIFwibmVlZGxlXFxuXCIsIFwidXRmOFwiKTtcblxuXHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNyZWF0ZUdyZXBUb29sKGN3ZCkuZXhlY3V0ZShcImdyZXAtMVwiLCB7XG5cdFx0XHRwYXRoOiBcInNyY1wiLFxuXHRcdFx0cGF0dGVybjogXCJuZWVkbGVcIixcblx0XHRcdGxpdGVyYWw6IHRydWUsXG5cdFx0fSk7XG5cblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0LmRldGFpbHM/LnRhcmdldD8ucmVzb2x2ZWRQYXRoLCBzcmNQYXRoKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0LmRldGFpbHM/LnRhcmdldD8ucGF0dGVybiwgXCJuZWVkbGVcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5jb250ZW50WzBdPy50eXBlLCBcInRleHRcIik7XG5cdFx0YXNzZXJ0Lm1hdGNoKHJlc3VsdC5jb250ZW50WzBdPy50ZXh0ID8/IFwiXCIsIC9uZWVkbGVcXC50eHQ6MTogbmVlZGxlLyk7XG5cdH0gZmluYWxseSB7XG5cdFx0cm1TeW5jKGN3ZCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuXHR9XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUVBLE9BQU8sWUFBWTtBQUNuQixTQUFTLFdBQVcsYUFBYSxRQUFRLHFCQUFxQjtBQUM5RCxTQUFTLGNBQWM7QUFDdkIsU0FBUyxZQUFZO0FBQ3JCLE9BQU8sVUFBVTtBQUVqQixTQUFTLHNCQUFzQjtBQUMvQixTQUFTLHNCQUFzQjtBQUMvQixTQUFTLHNCQUFzQjtBQUMvQixTQUFTLG9CQUFvQjtBQUM3QixTQUFTLHNCQUFzQjtBQUMvQixTQUFTLHVCQUF1QjtBQUVoQyxLQUFLLG9FQUFvRSxZQUFZO0FBQ3BGLFFBQU0sTUFBTSxZQUFZLEtBQUssT0FBTyxHQUFHLGtCQUFrQixDQUFDO0FBQzFELE1BQUk7QUFDSCxVQUFNLFdBQVcsS0FBSyxLQUFLLGFBQWE7QUFDeEMsa0JBQWMsVUFBVSxxQkFBcUIsTUFBTTtBQUVuRCxVQUFNLFNBQVMsTUFBTSxlQUFlLEdBQUcsRUFBRSxRQUFRLFVBQVU7QUFBQSxNQUMxRCxNQUFNO0FBQUEsTUFDTixRQUFRO0FBQUEsTUFDUixPQUFPO0FBQUEsSUFDUixDQUFDO0FBRUQsV0FBTyxNQUFNLE9BQU8sU0FBUyxRQUFRLGNBQWMsUUFBUTtBQUMzRCxXQUFPLFVBQVUsT0FBTyxTQUFTLFFBQVEsT0FBTyxFQUFFLE9BQU8sR0FBRyxLQUFLLEVBQUUs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
