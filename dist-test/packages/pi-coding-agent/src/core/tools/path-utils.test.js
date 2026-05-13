import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolve as resolvePath } from "node:path";
import { resolveToCwd } from "./path-utils.js";
describe("resolveToCwd", () => {
  it("resolves relative paths against cwd", () => {
    const result = resolveToCwd("foo/bar.txt", "/home/user/project");
    assert.equal(result, resolvePath("/home/user/project", "foo/bar.txt"));
  });
  it("returns absolute paths unchanged", () => {
    const result = resolveToCwd("/absolute/path.txt", "/home/user/project");
    assert.equal(result, "/absolute/path.txt");
  });
  it("expands ~ to home directory", () => {
    const result = resolveToCwd("~/file.txt", "/home/user/project");
    assert.ok(result.endsWith("/file.txt"));
    assert.ok(!result.includes("~"));
  });
});
describe("normalizeMsysPath (via resolveToCwd on win32)", () => {
  const originalPlatform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });
  it("converts /c/Users/... to C:\\Users\\... on win32", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const msysPath = "/c/Users/test/project";
    const msysRegex = /^\/[a-zA-Z]\//;
    assert.ok(msysRegex.test(msysPath), "MSYS path pattern matches");
    const converted = `${msysPath[1].toUpperCase()}:\\${msysPath.slice(3).replace(/\//g, "\\")}`;
    assert.equal(converted, "C:\\Users\\test\\project");
  });
  it("converts /f/Projects to F:\\Projects on win32", () => {
    const msysPath = "/f/Projects";
    const converted = `${msysPath[1].toUpperCase()}:\\${msysPath.slice(3).replace(/\//g, "\\")}`;
    assert.equal(converted, "F:\\Projects");
  });
  it("does not convert regular Unix paths", () => {
    const regularPath = "/usr/local/bin";
    const msysRegex = /^\/[a-zA-Z]\//;
    assert.ok(!msysRegex.test("/usr/local/bin"), "/usr/... is not an MSYS path");
    assert.ok(msysRegex.test("/u/local/bin"), "/u/... would match (single letter)");
  });
  it("does not convert paths without leading slash", () => {
    const msysRegex = /^\/[a-zA-Z]\//;
    assert.ok(!msysRegex.test("c/Users/test"), "no leading slash \u2014 not MSYS");
    assert.ok(!msysRegex.test("relative/path"), "relative path \u2014 not MSYS");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL3Rvb2xzL3BhdGgtdXRpbHMudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgZGVzY3JpYmUsIGl0LCBtb2NrLCBhZnRlckVhY2ggfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IHJlc29sdmUgYXMgcmVzb2x2ZVBhdGggfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyByZXNvbHZlVG9Dd2QsIGV4cGFuZFBhdGggfSBmcm9tIFwiLi9wYXRoLXV0aWxzLmpzXCI7XG5cbmRlc2NyaWJlKFwicmVzb2x2ZVRvQ3dkXCIsICgpID0+IHtcblx0aXQoXCJyZXNvbHZlcyByZWxhdGl2ZSBwYXRocyBhZ2FpbnN0IGN3ZFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVzdWx0ID0gcmVzb2x2ZVRvQ3dkKFwiZm9vL2Jhci50eHRcIiwgXCIvaG9tZS91c2VyL3Byb2plY3RcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdCwgcmVzb2x2ZVBhdGgoXCIvaG9tZS91c2VyL3Byb2plY3RcIiwgXCJmb28vYmFyLnR4dFwiKSk7XG5cdH0pO1xuXG5cdGl0KFwicmV0dXJucyBhYnNvbHV0ZSBwYXRocyB1bmNoYW5nZWRcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlc3VsdCA9IHJlc29sdmVUb0N3ZChcIi9hYnNvbHV0ZS9wYXRoLnR4dFwiLCBcIi9ob21lL3VzZXIvcHJvamVjdFwiKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0LCBcIi9hYnNvbHV0ZS9wYXRoLnR4dFwiKTtcblx0fSk7XG5cblx0aXQoXCJleHBhbmRzIH4gdG8gaG9tZSBkaXJlY3RvcnlcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlc3VsdCA9IHJlc29sdmVUb0N3ZChcIn4vZmlsZS50eHRcIiwgXCIvaG9tZS91c2VyL3Byb2plY3RcIik7XG5cdFx0YXNzZXJ0Lm9rKHJlc3VsdC5lbmRzV2l0aChcIi9maWxlLnR4dFwiKSk7XG5cdFx0YXNzZXJ0Lm9rKCFyZXN1bHQuaW5jbHVkZXMoXCJ+XCIpKTtcblx0fSk7XG59KTtcblxuZGVzY3JpYmUoXCJub3JtYWxpemVNc3lzUGF0aCAodmlhIHJlc29sdmVUb0N3ZCBvbiB3aW4zMilcIiwgKCkgPT4ge1xuXHRjb25zdCBvcmlnaW5hbFBsYXRmb3JtID0gcHJvY2Vzcy5wbGF0Zm9ybTtcblxuXHRhZnRlckVhY2goKCkgPT4ge1xuXHRcdE9iamVjdC5kZWZpbmVQcm9wZXJ0eShwcm9jZXNzLCBcInBsYXRmb3JtXCIsIHsgdmFsdWU6IG9yaWdpbmFsUGxhdGZvcm0gfSk7XG5cdH0pO1xuXG5cdGl0KFwiY29udmVydHMgL2MvVXNlcnMvLi4uIHRvIEM6XFxcXFVzZXJzXFxcXC4uLiBvbiB3aW4zMlwiLCAoKSA9PiB7XG5cdFx0T2JqZWN0LmRlZmluZVByb3BlcnR5KHByb2Nlc3MsIFwicGxhdGZvcm1cIiwgeyB2YWx1ZTogXCJ3aW4zMlwiIH0pO1xuXHRcdC8vIFJlLWltcG9ydCB0byBwaWNrIHVwIHBsYXRmb3JtIGNoYW5nZSBcdTIwMTQgYnV0IHNpbmNlIG5vcm1hbGl6ZU1zeXNQYXRoXG5cdFx0Ly8gcmVhZHMgcHJvY2Vzcy5wbGF0Zm9ybSBhdCBjYWxsIHRpbWUsIHdlIGNhbiB0ZXN0IGRpcmVjdGx5LlxuXHRcdC8vIE9uIG5vbi1XaW5kb3dzLCByZXNvbHZlVG9Dd2QgdHJlYXRzIC9jL1VzZXJzIGFzIGFic29sdXRlLCBzbyB3ZVxuXHRcdC8vIHRlc3QgdGhlIG5vcm1hbGl6YXRpb24gbG9naWMgYnkgY2hlY2tpbmcgdGhlIE1TWVMgcmVnZXggYmVoYXZpb3IuXG5cdFx0Y29uc3QgbXN5c1BhdGggPSBcIi9jL1VzZXJzL3Rlc3QvcHJvamVjdFwiO1xuXHRcdGNvbnN0IG1zeXNSZWdleCA9IC9eXFwvW2EtekEtWl1cXC8vO1xuXHRcdGFzc2VydC5vayhtc3lzUmVnZXgudGVzdChtc3lzUGF0aCksIFwiTVNZUyBwYXRoIHBhdHRlcm4gbWF0Y2hlc1wiKTtcblxuXHRcdC8vIFNpbXVsYXRlIHRoZSBjb252ZXJzaW9uXG5cdFx0Y29uc3QgY29udmVydGVkID0gYCR7bXN5c1BhdGhbMV0udG9VcHBlckNhc2UoKX06XFxcXCR7bXN5c1BhdGguc2xpY2UoMykucmVwbGFjZSgvXFwvL2csIFwiXFxcXFwiKX1gO1xuXHRcdGFzc2VydC5lcXVhbChjb252ZXJ0ZWQsIFwiQzpcXFxcVXNlcnNcXFxcdGVzdFxcXFxwcm9qZWN0XCIpO1xuXHR9KTtcblxuXHRpdChcImNvbnZlcnRzIC9mL1Byb2plY3RzIHRvIEY6XFxcXFByb2plY3RzIG9uIHdpbjMyXCIsICgpID0+IHtcblx0XHRjb25zdCBtc3lzUGF0aCA9IFwiL2YvUHJvamVjdHNcIjtcblx0XHRjb25zdCBjb252ZXJ0ZWQgPSBgJHttc3lzUGF0aFsxXS50b1VwcGVyQ2FzZSgpfTpcXFxcJHttc3lzUGF0aC5zbGljZSgzKS5yZXBsYWNlKC9cXC8vZywgXCJcXFxcXCIpfWA7XG5cdFx0YXNzZXJ0LmVxdWFsKGNvbnZlcnRlZCwgXCJGOlxcXFxQcm9qZWN0c1wiKTtcblx0fSk7XG5cblx0aXQoXCJkb2VzIG5vdCBjb252ZXJ0IHJlZ3VsYXIgVW5peCBwYXRoc1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVndWxhclBhdGggPSBcIi91c3IvbG9jYWwvYmluXCI7XG5cdFx0Y29uc3QgbXN5c1JlZ2V4ID0gL15cXC9bYS16QS1aXVxcLy87XG5cdFx0Ly8gL3UvbG9jYWwvYmluIHdvdWxkIG1hdGNoLCBidXQgL3Vzci9sb2NhbC9iaW4gaGFzIDMrIGNoYXJzIGJlZm9yZSAvXG5cdFx0Ly8gQWN0dWFsbHkgL3UvIHdvdWxkIG1hdGNoIFx1MjAxNCBidXQgL3Vzci8gd29uJ3QgYmVjYXVzZSAndXMnIGlzIDIgY2hhcnMuXG5cdFx0Ly8gVGhlIHJlZ2V4IGNoZWNrcyBzaW5nbGUgbGV0dGVyIGFmdGVyIGxlYWRpbmcgc2xhc2guXG5cdFx0YXNzZXJ0Lm9rKCFtc3lzUmVnZXgudGVzdChcIi91c3IvbG9jYWwvYmluXCIpLCBcIi91c3IvLi4uIGlzIG5vdCBhbiBNU1lTIHBhdGhcIik7XG5cdFx0YXNzZXJ0Lm9rKG1zeXNSZWdleC50ZXN0KFwiL3UvbG9jYWwvYmluXCIpLCBcIi91Ly4uLiB3b3VsZCBtYXRjaCAoc2luZ2xlIGxldHRlcilcIik7XG5cdH0pO1xuXG5cdGl0KFwiZG9lcyBub3QgY29udmVydCBwYXRocyB3aXRob3V0IGxlYWRpbmcgc2xhc2hcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IG1zeXNSZWdleCA9IC9eXFwvW2EtekEtWl1cXC8vO1xuXHRcdGFzc2VydC5vayghbXN5c1JlZ2V4LnRlc3QoXCJjL1VzZXJzL3Rlc3RcIiksIFwibm8gbGVhZGluZyBzbGFzaCBcdTIwMTQgbm90IE1TWVNcIik7XG5cdFx0YXNzZXJ0Lm9rKCFtc3lzUmVnZXgudGVzdChcInJlbGF0aXZlL3BhdGhcIiksIFwicmVsYXRpdmUgcGF0aCBcdTIwMTQgbm90IE1TWVNcIik7XG5cdH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxTQUFTLFVBQVUsSUFBVSxpQkFBaUI7QUFDOUMsT0FBTyxZQUFZO0FBQ25CLFNBQVMsV0FBVyxtQkFBbUI7QUFDdkMsU0FBUyxvQkFBZ0M7QUFFekMsU0FBUyxnQkFBZ0IsTUFBTTtBQUM5QixLQUFHLHVDQUF1QyxNQUFNO0FBQy9DLFVBQU0sU0FBUyxhQUFhLGVBQWUsb0JBQW9CO0FBQy9ELFdBQU8sTUFBTSxRQUFRLFlBQVksc0JBQXNCLGFBQWEsQ0FBQztBQUFBLEVBQ3RFLENBQUM7QUFFRCxLQUFHLG9DQUFvQyxNQUFNO0FBQzVDLFVBQU0sU0FBUyxhQUFhLHNCQUFzQixvQkFBb0I7QUFDdEUsV0FBTyxNQUFNLFFBQVEsb0JBQW9CO0FBQUEsRUFDMUMsQ0FBQztBQUVELEtBQUcsK0JBQStCLE1BQU07QUFDdkMsVUFBTSxTQUFTLGFBQWEsY0FBYyxvQkFBb0I7QUFDOUQsV0FBTyxHQUFHLE9BQU8sU0FBUyxXQUFXLENBQUM7QUFDdEMsV0FBTyxHQUFHLENBQUMsT0FBTyxTQUFTLEdBQUcsQ0FBQztBQUFBLEVBQ2hDLENBQUM7QUFDRixDQUFDO0FBRUQsU0FBUyxpREFBaUQsTUFBTTtBQUMvRCxRQUFNLG1CQUFtQixRQUFRO0FBRWpDLFlBQVUsTUFBTTtBQUNmLFdBQU8sZUFBZSxTQUFTLFlBQVksRUFBRSxPQUFPLGlCQUFpQixDQUFDO0FBQUEsRUFDdkUsQ0FBQztBQUVELEtBQUcsb0RBQW9ELE1BQU07QUFDNUQsV0FBTyxlQUFlLFNBQVMsWUFBWSxFQUFFLE9BQU8sUUFBUSxDQUFDO0FBSzdELFVBQU0sV0FBVztBQUNqQixVQUFNLFlBQVk7QUFDbEIsV0FBTyxHQUFHLFVBQVUsS0FBSyxRQUFRLEdBQUcsMkJBQTJCO0FBRy9ELFVBQU0sWUFBWSxHQUFHLFNBQVMsQ0FBQyxFQUFFLFlBQVksQ0FBQyxNQUFNLFNBQVMsTUFBTSxDQUFDLEVBQUUsUUFBUSxPQUFPLElBQUksQ0FBQztBQUMxRixXQUFPLE1BQU0sV0FBVywwQkFBMEI7QUFBQSxFQUNuRCxDQUFDO0FBRUQsS0FBRyxpREFBaUQsTUFBTTtBQUN6RCxVQUFNLFdBQVc7QUFDakIsVUFBTSxZQUFZLEdBQUcsU0FBUyxDQUFDLEVBQUUsWUFBWSxDQUFDLE1BQU0sU0FBUyxNQUFNLENBQUMsRUFBRSxRQUFRLE9BQU8sSUFBSSxDQUFDO0FBQzFGLFdBQU8sTUFBTSxXQUFXLGNBQWM7QUFBQSxFQUN2QyxDQUFDO0FBRUQsS0FBRyx1Q0FBdUMsTUFBTTtBQUMvQyxVQUFNLGNBQWM7QUFDcEIsVUFBTSxZQUFZO0FBSWxCLFdBQU8sR0FBRyxDQUFDLFVBQVUsS0FBSyxnQkFBZ0IsR0FBRyw4QkFBOEI7QUFDM0UsV0FBTyxHQUFHLFVBQVUsS0FBSyxjQUFjLEdBQUcsb0NBQW9DO0FBQUEsRUFDL0UsQ0FBQztBQUVELEtBQUcsZ0RBQWdELE1BQU07QUFDeEQsVUFBTSxZQUFZO0FBQ2xCLFdBQU8sR0FBRyxDQUFDLFVBQVUsS0FBSyxjQUFjLEdBQUcsa0NBQTZCO0FBQ3hFLFdBQU8sR0FBRyxDQUFDLFVBQVUsS0FBSyxlQUFlLEdBQUcsK0JBQTBCO0FBQUEsRUFDdkUsQ0FBQztBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
