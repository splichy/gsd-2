import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { atomicWriteFileSync } from "./fs-utils.js";
describe("atomicWriteFileSync", () => {
  let dir;
  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("writes file content atomically", () => {
    dir = mkdtempSync(join(tmpdir(), "fs-utils-test-"));
    const filePath = join(dir, "test.txt");
    atomicWriteFileSync(filePath, "hello world");
    assert.equal(readFileSync(filePath, "utf-8"), "hello world");
  });
  it("overwrites existing file atomically", () => {
    dir = mkdtempSync(join(tmpdir(), "fs-utils-test-"));
    const filePath = join(dir, "test.txt");
    atomicWriteFileSync(filePath, "first");
    atomicWriteFileSync(filePath, "second");
    assert.equal(readFileSync(filePath, "utf-8"), "second");
  });
  it("does not leave .tmp file after successful write", () => {
    dir = mkdtempSync(join(tmpdir(), "fs-utils-test-"));
    const filePath = join(dir, "test.txt");
    atomicWriteFileSync(filePath, "content");
    assert.equal(existsSync(filePath + ".tmp"), false);
  });
  it("supports Buffer content", () => {
    dir = mkdtempSync(join(tmpdir(), "fs-utils-test-"));
    const filePath = join(dir, "test.bin");
    const buf = Buffer.from([0, 1, 2, 255]);
    atomicWriteFileSync(filePath, buf);
    const result = readFileSync(filePath);
    assert.deepEqual(result, buf);
  });
  it("supports encoding parameter", () => {
    dir = mkdtempSync(join(tmpdir(), "fs-utils-test-"));
    const filePath = join(dir, "test.txt");
    atomicWriteFileSync(filePath, "utf8 content", "utf-8");
    assert.equal(readFileSync(filePath, "utf-8"), "utf8 content");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL2ZzLXV0aWxzLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgZGVzY3JpYmUsIGl0LCBhZnRlckVhY2ggfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgcmVhZEZpbGVTeW5jLCBybVN5bmMsIGV4aXN0c1N5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBhdG9taWNXcml0ZUZpbGVTeW5jIH0gZnJvbSBcIi4vZnMtdXRpbHMuanNcIjtcblxuZGVzY3JpYmUoXCJhdG9taWNXcml0ZUZpbGVTeW5jXCIsICgpID0+IHtcblx0bGV0IGRpcjogc3RyaW5nO1xuXG5cdGFmdGVyRWFjaCgoKSA9PiB7XG5cdFx0aWYgKGRpcikge1xuXHRcdFx0cm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuXHRcdH1cblx0fSk7XG5cblx0aXQoXCJ3cml0ZXMgZmlsZSBjb250ZW50IGF0b21pY2FsbHlcIiwgKCkgPT4ge1xuXHRcdGRpciA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZnMtdXRpbHMtdGVzdC1cIikpO1xuXHRcdGNvbnN0IGZpbGVQYXRoID0gam9pbihkaXIsIFwidGVzdC50eHRcIik7XG5cdFx0YXRvbWljV3JpdGVGaWxlU3luYyhmaWxlUGF0aCwgXCJoZWxsbyB3b3JsZFwiKTtcblx0XHRhc3NlcnQuZXF1YWwocmVhZEZpbGVTeW5jKGZpbGVQYXRoLCBcInV0Zi04XCIpLCBcImhlbGxvIHdvcmxkXCIpO1xuXHR9KTtcblxuXHRpdChcIm92ZXJ3cml0ZXMgZXhpc3RpbmcgZmlsZSBhdG9taWNhbGx5XCIsICgpID0+IHtcblx0XHRkaXIgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImZzLXV0aWxzLXRlc3QtXCIpKTtcblx0XHRjb25zdCBmaWxlUGF0aCA9IGpvaW4oZGlyLCBcInRlc3QudHh0XCIpO1xuXHRcdGF0b21pY1dyaXRlRmlsZVN5bmMoZmlsZVBhdGgsIFwiZmlyc3RcIik7XG5cdFx0YXRvbWljV3JpdGVGaWxlU3luYyhmaWxlUGF0aCwgXCJzZWNvbmRcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlYWRGaWxlU3luYyhmaWxlUGF0aCwgXCJ1dGYtOFwiKSwgXCJzZWNvbmRcIik7XG5cdH0pO1xuXG5cdGl0KFwiZG9lcyBub3QgbGVhdmUgLnRtcCBmaWxlIGFmdGVyIHN1Y2Nlc3NmdWwgd3JpdGVcIiwgKCkgPT4ge1xuXHRcdGRpciA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZnMtdXRpbHMtdGVzdC1cIikpO1xuXHRcdGNvbnN0IGZpbGVQYXRoID0gam9pbihkaXIsIFwidGVzdC50eHRcIik7XG5cdFx0YXRvbWljV3JpdGVGaWxlU3luYyhmaWxlUGF0aCwgXCJjb250ZW50XCIpO1xuXHRcdGFzc2VydC5lcXVhbChleGlzdHNTeW5jKGZpbGVQYXRoICsgXCIudG1wXCIpLCBmYWxzZSk7XG5cdH0pO1xuXG5cdGl0KFwic3VwcG9ydHMgQnVmZmVyIGNvbnRlbnRcIiwgKCkgPT4ge1xuXHRcdGRpciA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZnMtdXRpbHMtdGVzdC1cIikpO1xuXHRcdGNvbnN0IGZpbGVQYXRoID0gam9pbihkaXIsIFwidGVzdC5iaW5cIik7XG5cdFx0Y29uc3QgYnVmID0gQnVmZmVyLmZyb20oWzB4MDAsIDB4MDEsIDB4MDIsIDB4ZmZdKTtcblx0XHRhdG9taWNXcml0ZUZpbGVTeW5jKGZpbGVQYXRoLCBidWYpO1xuXHRcdGNvbnN0IHJlc3VsdCA9IHJlYWRGaWxlU3luYyhmaWxlUGF0aCk7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQsIGJ1Zik7XG5cdH0pO1xuXG5cdGl0KFwic3VwcG9ydHMgZW5jb2RpbmcgcGFyYW1ldGVyXCIsICgpID0+IHtcblx0XHRkaXIgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImZzLXV0aWxzLXRlc3QtXCIpKTtcblx0XHRjb25zdCBmaWxlUGF0aCA9IGpvaW4oZGlyLCBcInRlc3QudHh0XCIpO1xuXHRcdGF0b21pY1dyaXRlRmlsZVN5bmMoZmlsZVBhdGgsIFwidXRmOCBjb250ZW50XCIsIFwidXRmLThcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlYWRGaWxlU3luYyhmaWxlUGF0aCwgXCJ1dGYtOFwiKSwgXCJ1dGY4IGNvbnRlbnRcIik7XG5cdH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxPQUFPLFlBQVk7QUFDbkIsU0FBUyxVQUFVLElBQUksaUJBQWlCO0FBQ3hDLFNBQVMsYUFBYSxjQUFjLFFBQVEsa0JBQWtCO0FBQzlELFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFDdkIsU0FBUywyQkFBMkI7QUFFcEMsU0FBUyx1QkFBdUIsTUFBTTtBQUNyQyxNQUFJO0FBRUosWUFBVSxNQUFNO0FBQ2YsUUFBSSxLQUFLO0FBQ1IsYUFBTyxLQUFLLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDN0M7QUFBQSxFQUNELENBQUM7QUFFRCxLQUFHLGtDQUFrQyxNQUFNO0FBQzFDLFVBQU0sWUFBWSxLQUFLLE9BQU8sR0FBRyxnQkFBZ0IsQ0FBQztBQUNsRCxVQUFNLFdBQVcsS0FBSyxLQUFLLFVBQVU7QUFDckMsd0JBQW9CLFVBQVUsYUFBYTtBQUMzQyxXQUFPLE1BQU0sYUFBYSxVQUFVLE9BQU8sR0FBRyxhQUFhO0FBQUEsRUFDNUQsQ0FBQztBQUVELEtBQUcsdUNBQXVDLE1BQU07QUFDL0MsVUFBTSxZQUFZLEtBQUssT0FBTyxHQUFHLGdCQUFnQixDQUFDO0FBQ2xELFVBQU0sV0FBVyxLQUFLLEtBQUssVUFBVTtBQUNyQyx3QkFBb0IsVUFBVSxPQUFPO0FBQ3JDLHdCQUFvQixVQUFVLFFBQVE7QUFDdEMsV0FBTyxNQUFNLGFBQWEsVUFBVSxPQUFPLEdBQUcsUUFBUTtBQUFBLEVBQ3ZELENBQUM7QUFFRCxLQUFHLG1EQUFtRCxNQUFNO0FBQzNELFVBQU0sWUFBWSxLQUFLLE9BQU8sR0FBRyxnQkFBZ0IsQ0FBQztBQUNsRCxVQUFNLFdBQVcsS0FBSyxLQUFLLFVBQVU7QUFDckMsd0JBQW9CLFVBQVUsU0FBUztBQUN2QyxXQUFPLE1BQU0sV0FBVyxXQUFXLE1BQU0sR0FBRyxLQUFLO0FBQUEsRUFDbEQsQ0FBQztBQUVELEtBQUcsMkJBQTJCLE1BQU07QUFDbkMsVUFBTSxZQUFZLEtBQUssT0FBTyxHQUFHLGdCQUFnQixDQUFDO0FBQ2xELFVBQU0sV0FBVyxLQUFLLEtBQUssVUFBVTtBQUNyQyxVQUFNLE1BQU0sT0FBTyxLQUFLLENBQUMsR0FBTSxHQUFNLEdBQU0sR0FBSSxDQUFDO0FBQ2hELHdCQUFvQixVQUFVLEdBQUc7QUFDakMsVUFBTSxTQUFTLGFBQWEsUUFBUTtBQUNwQyxXQUFPLFVBQVUsUUFBUSxHQUFHO0FBQUEsRUFDN0IsQ0FBQztBQUVELEtBQUcsK0JBQStCLE1BQU07QUFDdkMsVUFBTSxZQUFZLEtBQUssT0FBTyxHQUFHLGdCQUFnQixDQUFDO0FBQ2xELFVBQU0sV0FBVyxLQUFLLEtBQUssVUFBVTtBQUNyQyx3QkFBb0IsVUFBVSxnQkFBZ0IsT0FBTztBQUNyRCxXQUFPLE1BQU0sYUFBYSxVQUFVLE9BQU8sR0FBRyxjQUFjO0FBQUEsRUFDN0QsQ0FBQztBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
