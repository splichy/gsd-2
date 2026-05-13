import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readManifest, readManifestFromEntryPath } from "./extension-manifest.js";
describe("readManifest", () => {
  it("returns null for missing directory", () => {
    assert.equal(readManifest("/nonexistent/path"), null);
  });
  it("returns null for directory without manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "ext-manifest-"));
    assert.equal(readManifest(dir), null);
  });
  it("returns null for invalid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "ext-manifest-"));
    writeFileSync(join(dir, "extension-manifest.json"), "not json{{{", "utf-8");
    assert.equal(readManifest(dir), null);
  });
  it("returns null for manifest missing required fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "ext-manifest-"));
    writeFileSync(
      join(dir, "extension-manifest.json"),
      JSON.stringify({ id: "test", name: "test" })
    );
    assert.equal(readManifest(dir), null);
  });
  it("returns valid manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "ext-manifest-"));
    const manifest = {
      id: "test-ext",
      name: "Test Extension",
      version: "1.0.0",
      tier: "bundled",
      requires: { platform: ">=2.29.0" }
    };
    writeFileSync(join(dir, "extension-manifest.json"), JSON.stringify(manifest));
    const result = readManifest(dir);
    assert.equal(result?.id, "test-ext");
    assert.equal(result?.tier, "bundled");
  });
});
describe("readManifestFromEntryPath", () => {
  it("reads manifest from parent of entry path", () => {
    const dir = mkdtempSync(join(tmpdir(), "ext-manifest-"));
    const extDir = join(dir, "my-ext");
    mkdirSync(extDir);
    writeFileSync(
      join(extDir, "extension-manifest.json"),
      JSON.stringify({
        id: "my-ext",
        name: "My Extension",
        version: "1.0.0",
        tier: "community"
      })
    );
    writeFileSync(join(extDir, "index.ts"), "");
    const result = readManifestFromEntryPath(join(extDir, "index.ts"));
    assert.equal(result?.id, "my-ext");
    assert.equal(result?.tier, "community");
  });
  it("returns null when entry path parent has no manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "ext-manifest-"));
    assert.equal(readManifestFromEntryPath(join(dir, "index.ts")), null);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL2V4dGVuc2lvbnMvZXh0ZW5zaW9uLW1hbmlmZXN0LnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRC0yIFx1MjAxNCBFeHRlbnNpb24gTWFuaWZlc3QgVGVzdHNcbi8vIENvcHlyaWdodCAoYykgMjAyNiBKZXJlbXkgTWNTcGFkZGVuIDxqZXJlbXlAZmx1eGxhYnMubmV0PlxuXG5pbXBvcnQgeyBkZXNjcmliZSwgaXQgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBta2RpclN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyByZWFkTWFuaWZlc3QsIHJlYWRNYW5pZmVzdEZyb21FbnRyeVBhdGggfSBmcm9tIFwiLi9leHRlbnNpb24tbWFuaWZlc3QuanNcIjtcblxuZGVzY3JpYmUoXCJyZWFkTWFuaWZlc3RcIiwgKCkgPT4ge1xuXHRpdChcInJldHVybnMgbnVsbCBmb3IgbWlzc2luZyBkaXJlY3RvcnlcIiwgKCkgPT4ge1xuXHRcdGFzc2VydC5lcXVhbChyZWFkTWFuaWZlc3QoXCIvbm9uZXhpc3RlbnQvcGF0aFwiKSwgbnVsbCk7XG5cdH0pO1xuXG5cdGl0KFwicmV0dXJucyBudWxsIGZvciBkaXJlY3Rvcnkgd2l0aG91dCBtYW5pZmVzdFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgZGlyID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJleHQtbWFuaWZlc3QtXCIpKTtcblx0XHRhc3NlcnQuZXF1YWwocmVhZE1hbmlmZXN0KGRpciksIG51bGwpO1xuXHR9KTtcblxuXHRpdChcInJldHVybnMgbnVsbCBmb3IgaW52YWxpZCBKU09OXCIsICgpID0+IHtcblx0XHRjb25zdCBkaXIgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImV4dC1tYW5pZmVzdC1cIikpO1xuXHRcdHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiZXh0ZW5zaW9uLW1hbmlmZXN0Lmpzb25cIiksIFwibm90IGpzb257e3tcIiwgXCJ1dGYtOFwiKTtcblx0XHRhc3NlcnQuZXF1YWwocmVhZE1hbmlmZXN0KGRpciksIG51bGwpO1xuXHR9KTtcblxuXHRpdChcInJldHVybnMgbnVsbCBmb3IgbWFuaWZlc3QgbWlzc2luZyByZXF1aXJlZCBmaWVsZHNcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGRpciA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZXh0LW1hbmlmZXN0LVwiKSk7XG5cdFx0d3JpdGVGaWxlU3luYyhcblx0XHRcdGpvaW4oZGlyLCBcImV4dGVuc2lvbi1tYW5pZmVzdC5qc29uXCIpLFxuXHRcdFx0SlNPTi5zdHJpbmdpZnkoeyBpZDogXCJ0ZXN0XCIsIG5hbWU6IFwidGVzdFwiIH0pLFxuXHRcdCk7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlYWRNYW5pZmVzdChkaXIpLCBudWxsKTtcblx0fSk7XG5cblx0aXQoXCJyZXR1cm5zIHZhbGlkIG1hbmlmZXN0XCIsICgpID0+IHtcblx0XHRjb25zdCBkaXIgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImV4dC1tYW5pZmVzdC1cIikpO1xuXHRcdGNvbnN0IG1hbmlmZXN0ID0ge1xuXHRcdFx0aWQ6IFwidGVzdC1leHRcIixcblx0XHRcdG5hbWU6IFwiVGVzdCBFeHRlbnNpb25cIixcblx0XHRcdHZlcnNpb246IFwiMS4wLjBcIixcblx0XHRcdHRpZXI6IFwiYnVuZGxlZFwiLFxuXHRcdFx0cmVxdWlyZXM6IHsgcGxhdGZvcm06IFwiPj0yLjI5LjBcIiB9LFxuXHRcdH07XG5cdFx0d3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJleHRlbnNpb24tbWFuaWZlc3QuanNvblwiKSwgSlNPTi5zdHJpbmdpZnkobWFuaWZlc3QpKTtcblx0XHRjb25zdCByZXN1bHQgPSByZWFkTWFuaWZlc3QoZGlyKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0Py5pZCwgXCJ0ZXN0LWV4dFwiKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0Py50aWVyLCBcImJ1bmRsZWRcIik7XG5cdH0pO1xufSk7XG5cbmRlc2NyaWJlKFwicmVhZE1hbmlmZXN0RnJvbUVudHJ5UGF0aFwiLCAoKSA9PiB7XG5cdGl0KFwicmVhZHMgbWFuaWZlc3QgZnJvbSBwYXJlbnQgb2YgZW50cnkgcGF0aFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgZGlyID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJleHQtbWFuaWZlc3QtXCIpKTtcblx0XHRjb25zdCBleHREaXIgPSBqb2luKGRpciwgXCJteS1leHRcIik7XG5cdFx0bWtkaXJTeW5jKGV4dERpcik7XG5cdFx0d3JpdGVGaWxlU3luYyhcblx0XHRcdGpvaW4oZXh0RGlyLCBcImV4dGVuc2lvbi1tYW5pZmVzdC5qc29uXCIpLFxuXHRcdFx0SlNPTi5zdHJpbmdpZnkoe1xuXHRcdFx0XHRpZDogXCJteS1leHRcIixcblx0XHRcdFx0bmFtZTogXCJNeSBFeHRlbnNpb25cIixcblx0XHRcdFx0dmVyc2lvbjogXCIxLjAuMFwiLFxuXHRcdFx0XHR0aWVyOiBcImNvbW11bml0eVwiLFxuXHRcdFx0fSksXG5cdFx0KTtcblx0XHR3cml0ZUZpbGVTeW5jKGpvaW4oZXh0RGlyLCBcImluZGV4LnRzXCIpLCBcIlwiKTtcblxuXHRcdGNvbnN0IHJlc3VsdCA9IHJlYWRNYW5pZmVzdEZyb21FbnRyeVBhdGgoam9pbihleHREaXIsIFwiaW5kZXgudHNcIikpO1xuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQ/LmlkLCBcIm15LWV4dFwiKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0Py50aWVyLCBcImNvbW11bml0eVwiKTtcblx0fSk7XG5cblx0aXQoXCJyZXR1cm5zIG51bGwgd2hlbiBlbnRyeSBwYXRoIHBhcmVudCBoYXMgbm8gbWFuaWZlc3RcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGRpciA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZXh0LW1hbmlmZXN0LVwiKSk7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlYWRNYW5pZmVzdEZyb21FbnRyeVBhdGgoam9pbihkaXIsIFwiaW5kZXgudHNcIikpLCBudWxsKTtcblx0fSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUdBLFNBQVMsVUFBVSxVQUFVO0FBQzdCLE9BQU8sWUFBWTtBQUNuQixTQUFTLGFBQWEsV0FBVyxxQkFBcUI7QUFDdEQsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUN2QixTQUFTLGNBQWMsaUNBQWlDO0FBRXhELFNBQVMsZ0JBQWdCLE1BQU07QUFDOUIsS0FBRyxzQ0FBc0MsTUFBTTtBQUM5QyxXQUFPLE1BQU0sYUFBYSxtQkFBbUIsR0FBRyxJQUFJO0FBQUEsRUFDckQsQ0FBQztBQUVELEtBQUcsK0NBQStDLE1BQU07QUFDdkQsVUFBTSxNQUFNLFlBQVksS0FBSyxPQUFPLEdBQUcsZUFBZSxDQUFDO0FBQ3ZELFdBQU8sTUFBTSxhQUFhLEdBQUcsR0FBRyxJQUFJO0FBQUEsRUFDckMsQ0FBQztBQUVELEtBQUcsaUNBQWlDLE1BQU07QUFDekMsVUFBTSxNQUFNLFlBQVksS0FBSyxPQUFPLEdBQUcsZUFBZSxDQUFDO0FBQ3ZELGtCQUFjLEtBQUssS0FBSyx5QkFBeUIsR0FBRyxlQUFlLE9BQU87QUFDMUUsV0FBTyxNQUFNLGFBQWEsR0FBRyxHQUFHLElBQUk7QUFBQSxFQUNyQyxDQUFDO0FBRUQsS0FBRyxxREFBcUQsTUFBTTtBQUM3RCxVQUFNLE1BQU0sWUFBWSxLQUFLLE9BQU8sR0FBRyxlQUFlLENBQUM7QUFDdkQ7QUFBQSxNQUNDLEtBQUssS0FBSyx5QkFBeUI7QUFBQSxNQUNuQyxLQUFLLFVBQVUsRUFBRSxJQUFJLFFBQVEsTUFBTSxPQUFPLENBQUM7QUFBQSxJQUM1QztBQUNBLFdBQU8sTUFBTSxhQUFhLEdBQUcsR0FBRyxJQUFJO0FBQUEsRUFDckMsQ0FBQztBQUVELEtBQUcsMEJBQTBCLE1BQU07QUFDbEMsVUFBTSxNQUFNLFlBQVksS0FBSyxPQUFPLEdBQUcsZUFBZSxDQUFDO0FBQ3ZELFVBQU0sV0FBVztBQUFBLE1BQ2hCLElBQUk7QUFBQSxNQUNKLE1BQU07QUFBQSxNQUNOLFNBQVM7QUFBQSxNQUNULE1BQU07QUFBQSxNQUNOLFVBQVUsRUFBRSxVQUFVLFdBQVc7QUFBQSxJQUNsQztBQUNBLGtCQUFjLEtBQUssS0FBSyx5QkFBeUIsR0FBRyxLQUFLLFVBQVUsUUFBUSxDQUFDO0FBQzVFLFVBQU0sU0FBUyxhQUFhLEdBQUc7QUFDL0IsV0FBTyxNQUFNLFFBQVEsSUFBSSxVQUFVO0FBQ25DLFdBQU8sTUFBTSxRQUFRLE1BQU0sU0FBUztBQUFBLEVBQ3JDLENBQUM7QUFDRixDQUFDO0FBRUQsU0FBUyw2QkFBNkIsTUFBTTtBQUMzQyxLQUFHLDRDQUE0QyxNQUFNO0FBQ3BELFVBQU0sTUFBTSxZQUFZLEtBQUssT0FBTyxHQUFHLGVBQWUsQ0FBQztBQUN2RCxVQUFNLFNBQVMsS0FBSyxLQUFLLFFBQVE7QUFDakMsY0FBVSxNQUFNO0FBQ2hCO0FBQUEsTUFDQyxLQUFLLFFBQVEseUJBQXlCO0FBQUEsTUFDdEMsS0FBSyxVQUFVO0FBQUEsUUFDZCxJQUFJO0FBQUEsUUFDSixNQUFNO0FBQUEsUUFDTixTQUFTO0FBQUEsUUFDVCxNQUFNO0FBQUEsTUFDUCxDQUFDO0FBQUEsSUFDRjtBQUNBLGtCQUFjLEtBQUssUUFBUSxVQUFVLEdBQUcsRUFBRTtBQUUxQyxVQUFNLFNBQVMsMEJBQTBCLEtBQUssUUFBUSxVQUFVLENBQUM7QUFDakUsV0FBTyxNQUFNLFFBQVEsSUFBSSxRQUFRO0FBQ2pDLFdBQU8sTUFBTSxRQUFRLE1BQU0sV0FBVztBQUFBLEVBQ3ZDLENBQUM7QUFFRCxLQUFHLHVEQUF1RCxNQUFNO0FBQy9ELFVBQU0sTUFBTSxZQUFZLEtBQUssT0FBTyxHQUFHLGVBQWUsQ0FBQztBQUN2RCxXQUFPLE1BQU0sMEJBQTBCLEtBQUssS0FBSyxVQUFVLENBQUMsR0FBRyxJQUFJO0FBQUEsRUFDcEUsQ0FBQztBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
