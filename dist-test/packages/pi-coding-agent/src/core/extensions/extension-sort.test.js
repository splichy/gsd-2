import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sortExtensionPaths } from "./extension-sort.js";
function createExtDir(base, id, deps) {
  const dir = join(base, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "extension-manifest.json"),
    JSON.stringify({
      id,
      name: id,
      version: "1.0.0",
      tier: "bundled",
      requires: { platform: ">=2.29.0" },
      ...deps ? { dependencies: { extensions: deps } } : {}
    })
  );
  writeFileSync(join(dir, "index.ts"), `export default function() {}`);
  return join(dir, "index.ts");
}
describe("sortExtensionPaths", () => {
  it("returns empty for empty input", () => {
    const result = sortExtensionPaths([]);
    assert.deepEqual(result.sortedPaths, []);
    assert.deepEqual(result.warnings, []);
  });
  it("sorts independent extensions alphabetically", () => {
    const base = mkdtempSync(join(tmpdir(), "ext-sort-"));
    const pathC = createExtDir(base, "charlie");
    const pathA = createExtDir(base, "alpha");
    const pathB = createExtDir(base, "bravo");
    const result = sortExtensionPaths([pathC, pathA, pathB]);
    assert.deepEqual(result.sortedPaths, [pathA, pathB, pathC]);
    assert.equal(result.warnings.length, 0);
  });
  it("sorts dependencies before dependents", () => {
    const base = mkdtempSync(join(tmpdir(), "ext-sort-"));
    const pathBase = createExtDir(base, "base-ext");
    const pathDependent = createExtDir(base, "dependent-ext", ["base-ext"]);
    const result = sortExtensionPaths([pathDependent, pathBase]);
    assert.deepEqual(result.sortedPaths, [pathBase, pathDependent]);
    assert.equal(result.warnings.length, 0);
  });
  it("handles deep dependency chains", () => {
    const base = mkdtempSync(join(tmpdir(), "ext-sort-"));
    const pathA = createExtDir(base, "a");
    const pathB = createExtDir(base, "b", ["a"]);
    const pathC = createExtDir(base, "c", ["b"]);
    const result = sortExtensionPaths([pathC, pathB, pathA]);
    assert.deepEqual(result.sortedPaths, [pathA, pathB, pathC]);
    assert.equal(result.warnings.length, 0);
  });
  it("warns about missing dependencies but still loads", () => {
    const base = mkdtempSync(join(tmpdir(), "ext-sort-"));
    const pathExt = createExtDir(base, "my-ext", ["nonexistent"]);
    const result = sortExtensionPaths([pathExt]);
    assert.equal(result.sortedPaths.length, 1);
    assert.equal(result.sortedPaths[0], pathExt);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0].message, /nonexistent.*not installed/);
  });
  it("warns about cycles but still loads both", () => {
    const base = mkdtempSync(join(tmpdir(), "ext-sort-"));
    const pathA = createExtDir(base, "cycle-a", ["cycle-b"]);
    const pathB = createExtDir(base, "cycle-b", ["cycle-a"]);
    const result = sortExtensionPaths([pathA, pathB]);
    assert.equal(result.sortedPaths.length, 2);
    assert.ok(result.warnings.length > 0);
    assert.ok(result.warnings.some((w) => w.message.includes("cycle")));
  });
  it("silently ignores self-dependencies", () => {
    const base = mkdtempSync(join(tmpdir(), "ext-sort-"));
    const pathExt = createExtDir(base, "self-dep", ["self-dep"]);
    const result = sortExtensionPaths([pathExt]);
    assert.deepEqual(result.sortedPaths, [pathExt]);
    assert.equal(result.warnings.length, 0);
  });
  it("prepends extensions without manifests", () => {
    const base = mkdtempSync(join(tmpdir(), "ext-sort-"));
    const noManifestDir = join(base, "no-manifest");
    mkdirSync(noManifestDir, { recursive: true });
    writeFileSync(join(noManifestDir, "index.ts"), `export default function() {}`);
    const noManifestPath = join(noManifestDir, "index.ts");
    const pathWithManifest = createExtDir(base, "with-manifest");
    const result = sortExtensionPaths([pathWithManifest, noManifestPath]);
    assert.equal(result.sortedPaths[0], noManifestPath);
    assert.equal(result.sortedPaths[1], pathWithManifest);
  });
  it("handles non-array dependencies gracefully", () => {
    const base = mkdtempSync(join(tmpdir(), "ext-sort-"));
    const dir = join(base, "bad-deps");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "extension-manifest.json"),
      JSON.stringify({
        id: "bad-deps",
        name: "bad-deps",
        version: "1.0.0",
        tier: "bundled",
        dependencies: { extensions: "not-an-array" }
      })
    );
    writeFileSync(join(dir, "index.ts"), `export default function() {}`);
    const result = sortExtensionPaths([join(dir, "index.ts")]);
    assert.equal(result.sortedPaths.length, 1);
    assert.equal(result.warnings.length, 0);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL2V4dGVuc2lvbnMvZXh0ZW5zaW9uLXNvcnQudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NELTIgXHUyMDE0IEV4dGVuc2lvbiBTb3J0IFRlc3RzXG4vLyBDb3B5cmlnaHQgKGMpIDIwMjYgSmVyZW15IE1jU3BhZGRlbiA8amVyZW15QGZsdXhsYWJzLm5ldD5cblxuaW1wb3J0IHsgZGVzY3JpYmUsIGl0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgc29ydEV4dGVuc2lvblBhdGhzIH0gZnJvbSBcIi4vZXh0ZW5zaW9uLXNvcnQuanNcIjtcblxuZnVuY3Rpb24gY3JlYXRlRXh0RGlyKGJhc2U6IHN0cmluZywgaWQ6IHN0cmluZywgZGVwcz86IHN0cmluZ1tdKTogc3RyaW5nIHtcblx0Y29uc3QgZGlyID0gam9pbihiYXNlLCBpZCk7XG5cdG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXHR3cml0ZUZpbGVTeW5jKFxuXHRcdGpvaW4oZGlyLCBcImV4dGVuc2lvbi1tYW5pZmVzdC5qc29uXCIpLFxuXHRcdEpTT04uc3RyaW5naWZ5KHtcblx0XHRcdGlkLFxuXHRcdFx0bmFtZTogaWQsXG5cdFx0XHR2ZXJzaW9uOiBcIjEuMC4wXCIsXG5cdFx0XHR0aWVyOiBcImJ1bmRsZWRcIixcblx0XHRcdHJlcXVpcmVzOiB7IHBsYXRmb3JtOiBcIj49Mi4yOS4wXCIgfSxcblx0XHRcdC4uLihkZXBzID8geyBkZXBlbmRlbmNpZXM6IHsgZXh0ZW5zaW9uczogZGVwcyB9IH0gOiB7fSksXG5cdFx0fSksXG5cdCk7XG5cdHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiaW5kZXgudHNcIiksIGBleHBvcnQgZGVmYXVsdCBmdW5jdGlvbigpIHt9YCk7XG5cdHJldHVybiBqb2luKGRpciwgXCJpbmRleC50c1wiKTtcbn1cblxuZGVzY3JpYmUoXCJzb3J0RXh0ZW5zaW9uUGF0aHNcIiwgKCkgPT4ge1xuXHRpdChcInJldHVybnMgZW1wdHkgZm9yIGVtcHR5IGlucHV0XCIsICgpID0+IHtcblx0XHRjb25zdCByZXN1bHQgPSBzb3J0RXh0ZW5zaW9uUGF0aHMoW10pO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwocmVzdWx0LnNvcnRlZFBhdGhzLCBbXSk7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQud2FybmluZ3MsIFtdKTtcblx0fSk7XG5cblx0aXQoXCJzb3J0cyBpbmRlcGVuZGVudCBleHRlbnNpb25zIGFscGhhYmV0aWNhbGx5XCIsICgpID0+IHtcblx0XHRjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJleHQtc29ydC1cIikpO1xuXHRcdGNvbnN0IHBhdGhDID0gY3JlYXRlRXh0RGlyKGJhc2UsIFwiY2hhcmxpZVwiKTtcblx0XHRjb25zdCBwYXRoQSA9IGNyZWF0ZUV4dERpcihiYXNlLCBcImFscGhhXCIpO1xuXHRcdGNvbnN0IHBhdGhCID0gY3JlYXRlRXh0RGlyKGJhc2UsIFwiYnJhdm9cIik7XG5cblx0XHRjb25zdCByZXN1bHQgPSBzb3J0RXh0ZW5zaW9uUGF0aHMoW3BhdGhDLCBwYXRoQSwgcGF0aEJdKTtcblx0XHRhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdC5zb3J0ZWRQYXRocywgW3BhdGhBLCBwYXRoQiwgcGF0aENdKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0Lndhcm5pbmdzLmxlbmd0aCwgMCk7XG5cdH0pO1xuXG5cdGl0KFwic29ydHMgZGVwZW5kZW5jaWVzIGJlZm9yZSBkZXBlbmRlbnRzXCIsICgpID0+IHtcblx0XHRjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJleHQtc29ydC1cIikpO1xuXHRcdGNvbnN0IHBhdGhCYXNlID0gY3JlYXRlRXh0RGlyKGJhc2UsIFwiYmFzZS1leHRcIik7XG5cdFx0Y29uc3QgcGF0aERlcGVuZGVudCA9IGNyZWF0ZUV4dERpcihiYXNlLCBcImRlcGVuZGVudC1leHRcIiwgW1wiYmFzZS1leHRcIl0pO1xuXG5cdFx0Ly8gUGFzcyBkZXBlbmRlbnQgZmlyc3QgXHUyMDE0IHNvcnQgc2hvdWxkIHJlb3JkZXJcblx0XHRjb25zdCByZXN1bHQgPSBzb3J0RXh0ZW5zaW9uUGF0aHMoW3BhdGhEZXBlbmRlbnQsIHBhdGhCYXNlXSk7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQuc29ydGVkUGF0aHMsIFtwYXRoQmFzZSwgcGF0aERlcGVuZGVudF0pO1xuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQud2FybmluZ3MubGVuZ3RoLCAwKTtcblx0fSk7XG5cblx0aXQoXCJoYW5kbGVzIGRlZXAgZGVwZW5kZW5jeSBjaGFpbnNcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImV4dC1zb3J0LVwiKSk7XG5cdFx0Y29uc3QgcGF0aEEgPSBjcmVhdGVFeHREaXIoYmFzZSwgXCJhXCIpO1xuXHRcdGNvbnN0IHBhdGhCID0gY3JlYXRlRXh0RGlyKGJhc2UsIFwiYlwiLCBbXCJhXCJdKTtcblx0XHRjb25zdCBwYXRoQyA9IGNyZWF0ZUV4dERpcihiYXNlLCBcImNcIiwgW1wiYlwiXSk7XG5cblx0XHRjb25zdCByZXN1bHQgPSBzb3J0RXh0ZW5zaW9uUGF0aHMoW3BhdGhDLCBwYXRoQiwgcGF0aEFdKTtcblx0XHRhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdC5zb3J0ZWRQYXRocywgW3BhdGhBLCBwYXRoQiwgcGF0aENdKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0Lndhcm5pbmdzLmxlbmd0aCwgMCk7XG5cdH0pO1xuXG5cdGl0KFwid2FybnMgYWJvdXQgbWlzc2luZyBkZXBlbmRlbmNpZXMgYnV0IHN0aWxsIGxvYWRzXCIsICgpID0+IHtcblx0XHRjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJleHQtc29ydC1cIikpO1xuXHRcdGNvbnN0IHBhdGhFeHQgPSBjcmVhdGVFeHREaXIoYmFzZSwgXCJteS1leHRcIiwgW1wibm9uZXhpc3RlbnRcIl0pO1xuXG5cdFx0Y29uc3QgcmVzdWx0ID0gc29ydEV4dGVuc2lvblBhdGhzKFtwYXRoRXh0XSk7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zb3J0ZWRQYXRocy5sZW5ndGgsIDEpO1xuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQuc29ydGVkUGF0aHNbMF0sIHBhdGhFeHQpO1xuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQud2FybmluZ3MubGVuZ3RoLCAxKTtcblx0XHRhc3NlcnQubWF0Y2gocmVzdWx0Lndhcm5pbmdzWzBdLm1lc3NhZ2UsIC9ub25leGlzdGVudC4qbm90IGluc3RhbGxlZC8pO1xuXHR9KTtcblxuXHRpdChcIndhcm5zIGFib3V0IGN5Y2xlcyBidXQgc3RpbGwgbG9hZHMgYm90aFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgYmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZXh0LXNvcnQtXCIpKTtcblx0XHRjb25zdCBwYXRoQSA9IGNyZWF0ZUV4dERpcihiYXNlLCBcImN5Y2xlLWFcIiwgW1wiY3ljbGUtYlwiXSk7XG5cdFx0Y29uc3QgcGF0aEIgPSBjcmVhdGVFeHREaXIoYmFzZSwgXCJjeWNsZS1iXCIsIFtcImN5Y2xlLWFcIl0pO1xuXG5cdFx0Y29uc3QgcmVzdWx0ID0gc29ydEV4dGVuc2lvblBhdGhzKFtwYXRoQSwgcGF0aEJdKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0LnNvcnRlZFBhdGhzLmxlbmd0aCwgMik7XG5cdFx0YXNzZXJ0Lm9rKHJlc3VsdC53YXJuaW5ncy5sZW5ndGggPiAwKTtcblx0XHRhc3NlcnQub2socmVzdWx0Lndhcm5pbmdzLnNvbWUoKHcpID0+IHcubWVzc2FnZS5pbmNsdWRlcyhcImN5Y2xlXCIpKSk7XG5cdH0pO1xuXG5cdGl0KFwic2lsZW50bHkgaWdub3JlcyBzZWxmLWRlcGVuZGVuY2llc1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgYmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZXh0LXNvcnQtXCIpKTtcblx0XHRjb25zdCBwYXRoRXh0ID0gY3JlYXRlRXh0RGlyKGJhc2UsIFwic2VsZi1kZXBcIiwgW1wic2VsZi1kZXBcIl0pO1xuXG5cdFx0Y29uc3QgcmVzdWx0ID0gc29ydEV4dGVuc2lvblBhdGhzKFtwYXRoRXh0XSk7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQuc29ydGVkUGF0aHMsIFtwYXRoRXh0XSk7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdC53YXJuaW5ncy5sZW5ndGgsIDApO1xuXHR9KTtcblxuXHRpdChcInByZXBlbmRzIGV4dGVuc2lvbnMgd2l0aG91dCBtYW5pZmVzdHNcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImV4dC1zb3J0LVwiKSk7XG5cdFx0Y29uc3Qgbm9NYW5pZmVzdERpciA9IGpvaW4oYmFzZSwgXCJuby1tYW5pZmVzdFwiKTtcblx0XHRta2RpclN5bmMobm9NYW5pZmVzdERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cdFx0d3JpdGVGaWxlU3luYyhqb2luKG5vTWFuaWZlc3REaXIsIFwiaW5kZXgudHNcIiksIGBleHBvcnQgZGVmYXVsdCBmdW5jdGlvbigpIHt9YCk7XG5cdFx0Y29uc3Qgbm9NYW5pZmVzdFBhdGggPSBqb2luKG5vTWFuaWZlc3REaXIsIFwiaW5kZXgudHNcIik7XG5cblx0XHRjb25zdCBwYXRoV2l0aE1hbmlmZXN0ID0gY3JlYXRlRXh0RGlyKGJhc2UsIFwid2l0aC1tYW5pZmVzdFwiKTtcblxuXHRcdGNvbnN0IHJlc3VsdCA9IHNvcnRFeHRlbnNpb25QYXRocyhbcGF0aFdpdGhNYW5pZmVzdCwgbm9NYW5pZmVzdFBhdGhdKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0LnNvcnRlZFBhdGhzWzBdLCBub01hbmlmZXN0UGF0aCk7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5zb3J0ZWRQYXRoc1sxXSwgcGF0aFdpdGhNYW5pZmVzdCk7XG5cdH0pO1xuXG5cdGl0KFwiaGFuZGxlcyBub24tYXJyYXkgZGVwZW5kZW5jaWVzIGdyYWNlZnVsbHlcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImV4dC1zb3J0LVwiKSk7XG5cdFx0Y29uc3QgZGlyID0gam9pbihiYXNlLCBcImJhZC1kZXBzXCIpO1xuXHRcdG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXHRcdHdyaXRlRmlsZVN5bmMoXG5cdFx0XHRqb2luKGRpciwgXCJleHRlbnNpb24tbWFuaWZlc3QuanNvblwiKSxcblx0XHRcdEpTT04uc3RyaW5naWZ5KHtcblx0XHRcdFx0aWQ6IFwiYmFkLWRlcHNcIixcblx0XHRcdFx0bmFtZTogXCJiYWQtZGVwc1wiLFxuXHRcdFx0XHR2ZXJzaW9uOiBcIjEuMC4wXCIsXG5cdFx0XHRcdHRpZXI6IFwiYnVuZGxlZFwiLFxuXHRcdFx0XHRkZXBlbmRlbmNpZXM6IHsgZXh0ZW5zaW9uczogXCJub3QtYW4tYXJyYXlcIiB9LFxuXHRcdFx0fSksXG5cdFx0KTtcblx0XHR3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcImluZGV4LnRzXCIpLCBgZXhwb3J0IGRlZmF1bHQgZnVuY3Rpb24oKSB7fWApO1xuXG5cdFx0Y29uc3QgcmVzdWx0ID0gc29ydEV4dGVuc2lvblBhdGhzKFtqb2luKGRpciwgXCJpbmRleC50c1wiKV0pO1xuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQuc29ydGVkUGF0aHMubGVuZ3RoLCAxKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0Lndhcm5pbmdzLmxlbmd0aCwgMCk7XG5cdH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFHQSxTQUFTLFVBQVUsVUFBVTtBQUM3QixPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhLFdBQVcscUJBQXFCO0FBQ3RELFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFDdkIsU0FBUywwQkFBMEI7QUFFbkMsU0FBUyxhQUFhLE1BQWMsSUFBWSxNQUF5QjtBQUN4RSxRQUFNLE1BQU0sS0FBSyxNQUFNLEVBQUU7QUFDekIsWUFBVSxLQUFLLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDbEM7QUFBQSxJQUNDLEtBQUssS0FBSyx5QkFBeUI7QUFBQSxJQUNuQyxLQUFLLFVBQVU7QUFBQSxNQUNkO0FBQUEsTUFDQSxNQUFNO0FBQUEsTUFDTixTQUFTO0FBQUEsTUFDVCxNQUFNO0FBQUEsTUFDTixVQUFVLEVBQUUsVUFBVSxXQUFXO0FBQUEsTUFDakMsR0FBSSxPQUFPLEVBQUUsY0FBYyxFQUFFLFlBQVksS0FBSyxFQUFFLElBQUksQ0FBQztBQUFBLElBQ3RELENBQUM7QUFBQSxFQUNGO0FBQ0EsZ0JBQWMsS0FBSyxLQUFLLFVBQVUsR0FBRyw4QkFBOEI7QUFDbkUsU0FBTyxLQUFLLEtBQUssVUFBVTtBQUM1QjtBQUVBLFNBQVMsc0JBQXNCLE1BQU07QUFDcEMsS0FBRyxpQ0FBaUMsTUFBTTtBQUN6QyxVQUFNLFNBQVMsbUJBQW1CLENBQUMsQ0FBQztBQUNwQyxXQUFPLFVBQVUsT0FBTyxhQUFhLENBQUMsQ0FBQztBQUN2QyxXQUFPLFVBQVUsT0FBTyxVQUFVLENBQUMsQ0FBQztBQUFBLEVBQ3JDLENBQUM7QUFFRCxLQUFHLCtDQUErQyxNQUFNO0FBQ3ZELFVBQU0sT0FBTyxZQUFZLEtBQUssT0FBTyxHQUFHLFdBQVcsQ0FBQztBQUNwRCxVQUFNLFFBQVEsYUFBYSxNQUFNLFNBQVM7QUFDMUMsVUFBTSxRQUFRLGFBQWEsTUFBTSxPQUFPO0FBQ3hD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
