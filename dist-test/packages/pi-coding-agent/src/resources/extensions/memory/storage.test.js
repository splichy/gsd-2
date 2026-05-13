import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStorage } from "./storage.js";
function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), "gsd-memory-storage-test-"));
}
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
describe("MemoryStorage debounced persistence", () => {
  let dir;
  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("multiple rapid mutations only trigger one persist write", async () => {
    dir = makeTmpDir();
    const dbPath = join(dir, "test.db");
    const storage = await MemoryStorage.create(dbPath);
    const initialStat = readFileSync(dbPath);
    const initialMtime = initialStat.length;
    storage.upsertThreads([
      { threadId: "t1", filePath: "/a.txt", fileSize: 100, fileMtime: 1e3, cwd: "/proj" }
    ]);
    storage.upsertThreads([
      { threadId: "t2", filePath: "/b.txt", fileSize: 200, fileMtime: 2e3, cwd: "/proj" }
    ]);
    storage.upsertThreads([
      { threadId: "t3", filePath: "/c.txt", fileSize: 300, fileMtime: 3e3, cwd: "/proj" }
    ]);
    const afterMutationsBuf = readFileSync(dbPath);
    assert.deepEqual(
      afterMutationsBuf,
      initialStat,
      "File should not have been written yet (debounce window has not elapsed)"
    );
    await wait(700);
    const afterDebounceBuf = readFileSync(dbPath);
    assert.notDeepEqual(
      afterDebounceBuf,
      initialStat,
      "File should have been written after debounce window elapsed"
    );
    const stats = storage.getStats();
    assert.equal(stats.totalThreads, 3);
    storage.close();
  });
  it("close() flushes pending changes immediately without waiting for debounce", async () => {
    dir = makeTmpDir();
    const dbPath = join(dir, "test.db");
    const storage = await MemoryStorage.create(dbPath);
    const initialBuf = readFileSync(dbPath);
    storage.upsertThreads([
      { threadId: "t1", filePath: "/a.txt", fileSize: 100, fileMtime: 1e3, cwd: "/proj" }
    ]);
    const beforeCloseBuf = readFileSync(dbPath);
    assert.deepEqual(
      beforeCloseBuf,
      initialBuf,
      "File should not have been written yet (debounce window has not elapsed)"
    );
    storage.close();
    const afterCloseBuf = readFileSync(dbPath);
    assert.notDeepEqual(
      afterCloseBuf,
      initialBuf,
      "File should have been written immediately on close()"
    );
    const reopened = await MemoryStorage.create(dbPath);
    const stats = reopened.getStats();
    assert.equal(stats.totalThreads, 1, "Data should be persisted and readable after close");
    reopened.close();
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9tZW1vcnkvc3RvcmFnZS50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IGRlc2NyaWJlLCBpdCwgYWZ0ZXJFYWNoIH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIHJtU3luYywgcmVhZEZpbGVTeW5jLCBleGlzdHNTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuXG5pbXBvcnQgeyBNZW1vcnlTdG9yYWdlIH0gZnJvbSBcIi4vc3RvcmFnZS5qc1wiO1xuXG5mdW5jdGlvbiBtYWtlVG1wRGlyKCk6IHN0cmluZyB7XG5cdHJldHVybiBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1tZW1vcnktc3RvcmFnZS10ZXN0LVwiKSk7XG59XG5cbmZ1bmN0aW9uIHdhaXQobXM6IG51bWJlcik6IFByb21pc2U8dm9pZD4ge1xuXHRyZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgbXMpKTtcbn1cblxuZGVzY3JpYmUoXCJNZW1vcnlTdG9yYWdlIGRlYm91bmNlZCBwZXJzaXN0ZW5jZVwiLCAoKSA9PiB7XG5cdGxldCBkaXI6IHN0cmluZztcblxuXHRhZnRlckVhY2goKCkgPT4ge1xuXHRcdGlmIChkaXIpIHtcblx0XHRcdHJtU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcblx0XHR9XG5cdH0pO1xuXG5cdGl0KFwibXVsdGlwbGUgcmFwaWQgbXV0YXRpb25zIG9ubHkgdHJpZ2dlciBvbmUgcGVyc2lzdCB3cml0ZVwiLCBhc3luYyAoKSA9PiB7XG5cdFx0ZGlyID0gbWFrZVRtcERpcigpO1xuXHRcdGNvbnN0IGRiUGF0aCA9IGpvaW4oZGlyLCBcInRlc3QuZGJcIik7XG5cdFx0Y29uc3Qgc3RvcmFnZSA9IGF3YWl0IE1lbW9yeVN0b3JhZ2UuY3JlYXRlKGRiUGF0aCk7XG5cblx0XHRjb25zdCBpbml0aWFsU3RhdCA9IHJlYWRGaWxlU3luYyhkYlBhdGgpO1xuXHRcdGNvbnN0IGluaXRpYWxNdGltZSA9IGluaXRpYWxTdGF0Lmxlbmd0aDtcblxuXHRcdHN0b3JhZ2UudXBzZXJ0VGhyZWFkcyhbXG5cdFx0XHR7IHRocmVhZElkOiBcInQxXCIsIGZpbGVQYXRoOiBcIi9hLnR4dFwiLCBmaWxlU2l6ZTogMTAwLCBmaWxlTXRpbWU6IDEwMDAsIGN3ZDogXCIvcHJvalwiIH0sXG5cdFx0XSk7XG5cdFx0c3RvcmFnZS51cHNlcnRUaHJlYWRzKFtcblx0XHRcdHsgdGhyZWFkSWQ6IFwidDJcIiwgZmlsZVBhdGg6IFwiL2IudHh0XCIsIGZpbGVTaXplOiAyMDAsIGZpbGVNdGltZTogMjAwMCwgY3dkOiBcIi9wcm9qXCIgfSxcblx0XHRdKTtcblx0XHRzdG9yYWdlLnVwc2VydFRocmVhZHMoW1xuXHRcdFx0eyB0aHJlYWRJZDogXCJ0M1wiLCBmaWxlUGF0aDogXCIvYy50eHRcIiwgZmlsZVNpemU6IDMwMCwgZmlsZU10aW1lOiAzMDAwLCBjd2Q6IFwiL3Byb2pcIiB9LFxuXHRcdF0pO1xuXG5cdFx0Y29uc3QgYWZ0ZXJNdXRhdGlvbnNCdWYgPSByZWFkRmlsZVN5bmMoZGJQYXRoKTtcblx0XHRhc3NlcnQuZGVlcEVxdWFsKFxuXHRcdFx0YWZ0ZXJNdXRhdGlvbnNCdWYsXG5cdFx0XHRpbml0aWFsU3RhdCxcblx0XHRcdFwiRmlsZSBzaG91bGQgbm90IGhhdmUgYmVlbiB3cml0dGVuIHlldCAoZGVib3VuY2Ugd2luZG93IGhhcyBub3QgZWxhcHNlZClcIixcblx0XHQpO1xuXG5cdFx0YXdhaXQgd2FpdCg3MDApO1xuXG5cdFx0Y29uc3QgYWZ0ZXJEZWJvdW5jZUJ1ZiA9IHJlYWRGaWxlU3luYyhkYlBhdGgpO1xuXHRcdGFzc2VydC5ub3REZWVwRXF1YWwoXG5cdFx0XHRhZnRlckRlYm91bmNlQnVmLFxuXHRcdFx0aW5pdGlhbFN0YXQsXG5cdFx0XHRcIkZpbGUgc2hvdWxkIGhhdmUgYmVlbiB3cml0dGVuIGFmdGVyIGRlYm91bmNlIHdpbmRvdyBlbGFwc2VkXCIsXG5cdFx0KTtcblxuXHRcdGNvbnN0IHN0YXRzID0gc3RvcmFnZS5nZXRTdGF0cygpO1xuXHRcdGFzc2VydC5lcXVhbChzdGF0cy50b3RhbFRocmVhZHMsIDMpO1xuXG5cdFx0c3RvcmFnZS5jbG9zZSgpO1xuXHR9KTtcblxuXHRpdChcImNsb3NlKCkgZmx1c2hlcyBwZW5kaW5nIGNoYW5nZXMgaW1tZWRpYXRlbHkgd2l0aG91dCB3YWl0aW5nIGZvciBkZWJvdW5jZVwiLCBhc3luYyAoKSA9PiB7XG5cdFx0ZGlyID0gbWFrZVRtcERpcigpO1xuXHRcdGNvbnN0IGRiUGF0aCA9IGpvaW4oZGlyLCBcInRlc3QuZGJcIik7XG5cdFx0Y29uc3Qgc3RvcmFnZSA9IGF3YWl0IE1lbW9yeVN0b3JhZ2UuY3JlYXRlKGRiUGF0aCk7XG5cblx0XHRjb25zdCBpbml0aWFsQnVmID0gcmVhZEZpbGVTeW5jKGRiUGF0aCk7XG5cblx0XHRzdG9yYWdlLnVwc2VydFRocmVhZHMoW1xuXHRcdFx0eyB0aHJlYWRJZDogXCJ0MVwiLCBmaWxlUGF0aDogXCIvYS50eHRcIiwgZmlsZVNpemU6IDEwMCwgZmlsZU10aW1lOiAxMDAwLCBjd2Q6IFwiL3Byb2pcIiB9LFxuXHRcdF0pO1xuXG5cdFx0Y29uc3QgYmVmb3JlQ2xvc2VCdWYgPSByZWFkRmlsZVN5bmMoZGJQYXRoKTtcblx0XHRhc3NlcnQuZGVlcEVxdWFsKFxuXHRcdFx0YmVmb3JlQ2xvc2VCdWYsXG5cdFx0XHRpbml0aWFsQnVmLFxuXHRcdFx0XCJGaWxlIHNob3VsZCBub3QgaGF2ZSBiZWVuIHdyaXR0ZW4geWV0IChkZWJvdW5jZSB3aW5kb3cgaGFzIG5vdCBlbGFwc2VkKVwiLFxuXHRcdCk7XG5cblx0XHRzdG9yYWdlLmNsb3NlKCk7XG5cblx0XHRjb25zdCBhZnRlckNsb3NlQnVmID0gcmVhZEZpbGVTeW5jKGRiUGF0aCk7XG5cdFx0YXNzZXJ0Lm5vdERlZXBFcXVhbChcblx0XHRcdGFmdGVyQ2xvc2VCdWYsXG5cdFx0XHRpbml0aWFsQnVmLFxuXHRcdFx0XCJGaWxlIHNob3VsZCBoYXZlIGJlZW4gd3JpdHRlbiBpbW1lZGlhdGVseSBvbiBjbG9zZSgpXCIsXG5cdFx0KTtcblxuXHRcdGNvbnN0IHJlb3BlbmVkID0gYXdhaXQgTWVtb3J5U3RvcmFnZS5jcmVhdGUoZGJQYXRoKTtcblx0XHRjb25zdCBzdGF0cyA9IHJlb3BlbmVkLmdldFN0YXRzKCk7XG5cdFx0YXNzZXJ0LmVxdWFsKHN0YXRzLnRvdGFsVGhyZWFkcywgMSwgXCJEYXRhIHNob3VsZCBiZSBwZXJzaXN0ZWQgYW5kIHJlYWRhYmxlIGFmdGVyIGNsb3NlXCIpO1xuXHRcdHJlb3BlbmVkLmNsb3NlKCk7XG5cdH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxPQUFPLFlBQVk7QUFDbkIsU0FBUyxVQUFVLElBQUksaUJBQWlCO0FBQ3hDLFNBQVMsYUFBYSxRQUFRLG9CQUFnQztBQUM5RCxTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBRXZCLFNBQVMscUJBQXFCO0FBRTlCLFNBQVMsYUFBcUI7QUFDN0IsU0FBTyxZQUFZLEtBQUssT0FBTyxHQUFHLDBCQUEwQixDQUFDO0FBQzlEO0FBRUEsU0FBUyxLQUFLLElBQTJCO0FBQ3hDLFNBQU8sSUFBSSxRQUFRLENBQUMsWUFBWSxXQUFXLFNBQVMsRUFBRSxDQUFDO0FBQ3hEO0FBRUEsU0FBUyx1Q0FBdUMsTUFBTTtBQUNyRCxNQUFJO0FBRUosWUFBVSxNQUFNO0FBQ2YsUUFBSSxLQUFLO0FBQ1IsYUFBTyxLQUFLLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDN0M7QUFBQSxFQUNELENBQUM7QUFFRCxLQUFHLDJEQUEyRCxZQUFZO0FBQ3pFLFVBQU0sV0FBVztBQUNqQixVQUFNLFNBQVMsS0FBSyxLQUFLLFNBQVM7QUFDbEMsVUFBTSxVQUFVLE1BQU0sY0FBYyxPQUFPLE1BQU07QUFFakQsVUFBTSxjQUFjLGFBQWEsTUFBTTtBQUN2QyxVQUFNLGVBQWUsWUFBWTtBQUVqQyxZQUFRLGNBQWM7QUFBQSxNQUNyQixFQUFFLFVBQVUsTUFBTSxVQUFVLFVBQVUsVUFBVSxLQUFLLFdBQVcsS0FBTSxLQUFLLFFBQVE7QUFBQSxJQUNwRixDQUFDO0FBQ0QsWUFBUSxjQUFjO0FBQUEsTUFDckIsRUFBRSxVQUFVLE1BQU0sVUFBVSxVQUFVLFVBQVUsS0FBSyxXQUFXLEtBQU0sS0FBSyxRQUFRO0FBQUEsSUFDcEYsQ0FBQztBQUNELFlBQVEsY0FBYztBQUFBLE1BQ3JCLEVBQUUsVUFBVSxNQUFNLFVBQVUsVUFBVSxVQUFVLEtBQUssV0FBVyxLQUFNLEtBQUssUUFBUTtBQUFBLElBQ3BGLENBQUM7QUFFRCxVQUFNLG9CQUFvQixhQUFhLE1BQU07QUFDN0MsV0FBTztBQUFBLE1BQ047QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLElBQ0Q7QUFFQSxVQUFNLEtBQUssR0FBRztBQUVkLFVBQU0sbUJBQW1CLGFBQWEsTUFBTTtBQUM1QyxXQUFPO0FBQUEsTUFDTjtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRDtBQUVBLFVBQU0sUUFBUSxRQUFRLFNBQVM7QUFDL0IsV0FBTyxNQUFNLE1BQU0sY0FBYyxDQUFDO0FBRWxDLFlBQVEsTUFBTTtBQUFBLEVBQ2YsQ0FBQztBQUVELEtBQUcsNEVBQTRFLFlBQVk7QUFDMUYsVUFBTSxXQUFXO0FBQ2pCLFVBQU0sU0FBUyxLQUFLLEtBQUssU0FBUztBQUNsQyxVQUFNLFVBQVUsTUFBTSxjQUFjLE9BQU8sTUFBTTtBQUVqRCxVQUFNLGFBQWEsYUFBYSxNQUFNO0FBRXRDLFlBQVEsY0FBYztBQUFBLE1BQ3JCLEVBQUUsVUFBVSxNQUFNLFVBQVUsVUFBVSxVQUFVLEtBQUssV0FBVyxLQUFNLEtBQUssUUFBUTtBQUFBLElBQ3BGLENBQUM7QUFFRCxVQUFNLGlCQUFpQixhQUFhLE1BQU07QUFDMUMsV0FBTztBQUFBLE1BQ047QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLElBQ0Q7QUFFQSxZQUFRLE1BQU07QUFFZCxVQUFNLGdCQUFnQixhQUFhLE1BQU07QUFDekMsV0FBTztBQUFBLE1BQ047QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLElBQ0Q7QUFFQSxVQUFNLFdBQVcsTUFBTSxjQUFjLE9BQU8sTUFBTTtBQUNsRCxVQUFNLFFBQVEsU0FBUyxTQUFTO0FBQ2hDLFdBQU8sTUFBTSxNQUFNLGNBQWMsR0FBRyxtREFBbUQ7QUFDdkYsYUFBUyxNQUFNO0FBQUEsRUFDaEIsQ0FBQztBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
