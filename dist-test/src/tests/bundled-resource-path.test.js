import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  resolveBundledGsdExtensionModule,
  resolveBundledResourcesDirFromPackageRoot
} from "../bundled-resource-path.js";
test("partial dist/resources falls back to src/resources", () => {
  const pkg = "/pkg";
  const existing = /* @__PURE__ */ new Set([
    join(pkg, "dist", "resources", "extensions")
  ]);
  const result = resolveBundledResourcesDirFromPackageRoot(pkg, (p) => existing.has(p));
  assert.equal(result, join(pkg, "src", "resources"));
});
test("complete dist/resources is selected when expected roots exist", () => {
  const pkg = "/pkg";
  const existing = /* @__PURE__ */ new Set([
    join(pkg, "dist", "resources", "agents"),
    join(pkg, "dist", "resources", "extensions")
  ]);
  const result = resolveBundledResourcesDirFromPackageRoot(pkg, (p) => existing.has(p));
  assert.equal(result, join(pkg, "dist", "resources"));
});
test("GSD extension module resolution falls back to source when dist module is missing", () => {
  const pkg = "/pkg";
  const fakeImportUrl = `file://${join(pkg, "src", "worktree-cli.ts")}`;
  const existing = /* @__PURE__ */ new Set([
    join(pkg, "dist", "resources", "agents"),
    join(pkg, "dist", "resources", "extensions")
  ]);
  const result = resolveBundledGsdExtensionModule(
    fakeImportUrl,
    "worktree-root.ts",
    (p) => existing.has(p)
  );
  assert.equal(result, join(pkg, "src", "resources", "extensions", "gsd", "worktree-root.ts"));
});
test("GSD extension module resolution uses compiled dist module when available", () => {
  const pkg = "/pkg";
  const fakeImportUrl = `file://${join(pkg, "src", "worktree-cli.ts")}`;
  const existing = /* @__PURE__ */ new Set([
    join(pkg, "dist", "resources", "agents"),
    join(pkg, "dist", "resources", "extensions"),
    join(pkg, "dist", "resources", "extensions", "gsd", "worktree-manager.js")
  ]);
  const result = resolveBundledGsdExtensionModule(
    fakeImportUrl,
    "worktree-manager.ts",
    (p) => existing.has(p)
  );
  assert.equal(result, join(pkg, "dist", "resources", "extensions", "gsd", "worktree-manager.js"));
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3Rlc3RzL2J1bmRsZWQtcmVzb3VyY2UtcGF0aC50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0ZXN0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuXG5pbXBvcnQge1xuICByZXNvbHZlQnVuZGxlZEdzZEV4dGVuc2lvbk1vZHVsZSxcbiAgcmVzb2x2ZUJ1bmRsZWRSZXNvdXJjZXNEaXJGcm9tUGFja2FnZVJvb3QsXG59IGZyb20gXCIuLi9idW5kbGVkLXJlc291cmNlLXBhdGgudHNcIjtcblxudGVzdChcInBhcnRpYWwgZGlzdC9yZXNvdXJjZXMgZmFsbHMgYmFjayB0byBzcmMvcmVzb3VyY2VzXCIsICgpID0+IHtcbiAgY29uc3QgcGtnID0gXCIvcGtnXCI7XG4gIGNvbnN0IGV4aXN0aW5nID0gbmV3IFNldChbXG4gICAgam9pbihwa2csIFwiZGlzdFwiLCBcInJlc291cmNlc1wiLCBcImV4dGVuc2lvbnNcIiksXG4gIF0pO1xuXG4gIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVCdW5kbGVkUmVzb3VyY2VzRGlyRnJvbVBhY2thZ2VSb290KHBrZywgKHApID0+IGV4aXN0aW5nLmhhcyhwKSk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgam9pbihwa2csIFwic3JjXCIsIFwicmVzb3VyY2VzXCIpKTtcbn0pO1xuXG50ZXN0KFwiY29tcGxldGUgZGlzdC9yZXNvdXJjZXMgaXMgc2VsZWN0ZWQgd2hlbiBleHBlY3RlZCByb290cyBleGlzdFwiLCAoKSA9PiB7XG4gIGNvbnN0IHBrZyA9IFwiL3BrZ1wiO1xuICBjb25zdCBleGlzdGluZyA9IG5ldyBTZXQoW1xuICAgIGpvaW4ocGtnLCBcImRpc3RcIiwgXCJyZXNvdXJjZXNcIiwgXCJhZ2VudHNcIiksXG4gICAgam9pbihwa2csIFwiZGlzdFwiLCBcInJlc291cmNlc1wiLCBcImV4dGVuc2lvbnNcIiksXG4gIF0pO1xuXG4gIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVCdW5kbGVkUmVzb3VyY2VzRGlyRnJvbVBhY2thZ2VSb290KHBrZywgKHApID0+IGV4aXN0aW5nLmhhcyhwKSk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgam9pbihwa2csIFwiZGlzdFwiLCBcInJlc291cmNlc1wiKSk7XG59KTtcblxudGVzdChcIkdTRCBleHRlbnNpb24gbW9kdWxlIHJlc29sdXRpb24gZmFsbHMgYmFjayB0byBzb3VyY2Ugd2hlbiBkaXN0IG1vZHVsZSBpcyBtaXNzaW5nXCIsICgpID0+IHtcbiAgY29uc3QgcGtnID0gXCIvcGtnXCI7XG4gIGNvbnN0IGZha2VJbXBvcnRVcmwgPSBgZmlsZTovLyR7am9pbihwa2csIFwic3JjXCIsIFwid29ya3RyZWUtY2xpLnRzXCIpfWA7XG4gIGNvbnN0IGV4aXN0aW5nID0gbmV3IFNldChbXG4gICAgam9pbihwa2csIFwiZGlzdFwiLCBcInJlc291cmNlc1wiLCBcImFnZW50c1wiKSxcbiAgICBqb2luKHBrZywgXCJkaXN0XCIsIFwicmVzb3VyY2VzXCIsIFwiZXh0ZW5zaW9uc1wiKSxcbiAgXSk7XG5cbiAgY29uc3QgcmVzdWx0ID0gcmVzb2x2ZUJ1bmRsZWRHc2RFeHRlbnNpb25Nb2R1bGUoXG4gICAgZmFrZUltcG9ydFVybCxcbiAgICBcIndvcmt0cmVlLXJvb3QudHNcIixcbiAgICAocCkgPT4gZXhpc3RpbmcuaGFzKHApLFxuICApO1xuXG4gIGFzc2VydC5lcXVhbChyZXN1bHQsIGpvaW4ocGtnLCBcInNyY1wiLCBcInJlc291cmNlc1wiLCBcImV4dGVuc2lvbnNcIiwgXCJnc2RcIiwgXCJ3b3JrdHJlZS1yb290LnRzXCIpKTtcbn0pO1xuXG50ZXN0KFwiR1NEIGV4dGVuc2lvbiBtb2R1bGUgcmVzb2x1dGlvbiB1c2VzIGNvbXBpbGVkIGRpc3QgbW9kdWxlIHdoZW4gYXZhaWxhYmxlXCIsICgpID0+IHtcbiAgY29uc3QgcGtnID0gXCIvcGtnXCI7XG4gIGNvbnN0IGZha2VJbXBvcnRVcmwgPSBgZmlsZTovLyR7am9pbihwa2csIFwic3JjXCIsIFwid29ya3RyZWUtY2xpLnRzXCIpfWA7XG4gIGNvbnN0IGV4aXN0aW5nID0gbmV3IFNldChbXG4gICAgam9pbihwa2csIFwiZGlzdFwiLCBcInJlc291cmNlc1wiLCBcImFnZW50c1wiKSxcbiAgICBqb2luKHBrZywgXCJkaXN0XCIsIFwicmVzb3VyY2VzXCIsIFwiZXh0ZW5zaW9uc1wiKSxcbiAgICBqb2luKHBrZywgXCJkaXN0XCIsIFwicmVzb3VyY2VzXCIsIFwiZXh0ZW5zaW9uc1wiLCBcImdzZFwiLCBcIndvcmt0cmVlLW1hbmFnZXIuanNcIiksXG4gIF0pO1xuXG4gIGNvbnN0IHJlc3VsdCA9IHJlc29sdmVCdW5kbGVkR3NkRXh0ZW5zaW9uTW9kdWxlKFxuICAgIGZha2VJbXBvcnRVcmwsXG4gICAgXCJ3b3JrdHJlZS1tYW5hZ2VyLnRzXCIsXG4gICAgKHApID0+IGV4aXN0aW5nLmhhcyhwKSxcbiAgKTtcblxuICBhc3NlcnQuZXF1YWwocmVzdWx0LCBqb2luKHBrZywgXCJkaXN0XCIsIFwicmVzb3VyY2VzXCIsIFwiZXh0ZW5zaW9uc1wiLCBcImdzZFwiLCBcIndvcmt0cmVlLW1hbmFnZXIuanNcIikpO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxPQUFPLFlBQVk7QUFDbkIsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsWUFBWTtBQUVyQjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUVQLEtBQUssc0RBQXNELE1BQU07QUFDL0QsUUFBTSxNQUFNO0FBQ1osUUFBTSxXQUFXLG9CQUFJLElBQUk7QUFBQSxJQUN2QixLQUFLLEtBQUssUUFBUSxhQUFhLFlBQVk7QUFBQSxFQUM3QyxDQUFDO0FBRUQsUUFBTSxTQUFTLDBDQUEwQyxLQUFLLENBQUMsTUFBTSxTQUFTLElBQUksQ0FBQyxDQUFDO0FBRXBGLFNBQU8sTUFBTSxRQUFRLEtBQUssS0FBSyxPQUFPLFdBQVcsQ0FBQztBQUNwRCxDQUFDO0FBRUQsS0FBSyxpRUFBaUUsTUFBTTtBQUMxRSxRQUFNLE1BQU07QUFDWixRQUFNLFdBQVcsb0JBQUksSUFBSTtBQUFBLElBQ3ZCLEtBQUssS0FBSyxRQUFRLGFBQWEsUUFBUTtBQUFBLElBQ3ZDLEtBQUssS0FBSyxRQUFRLGFBQWEsWUFBWTtBQUFBLEVBQzdDLENBQUM7QUFFRCxRQUFNLFNBQVMsMENBQTBDLEtBQUssQ0FBQyxNQUFNLFNBQVMsSUFBSSxDQUFDLENBQUM7QUFFcEYsU0FBTyxNQUFNLFFBQVEsS0FBSyxLQUFLLFFBQVEsV0FBVyxDQUFDO0FBQ3JELENBQUM7QUFFRCxLQUFLLG9GQUFvRixNQUFNO0FBQzdGLFFBQU0sTUFBTTtBQUNaLFFBQU0sZ0JBQWdCLFVBQVUsS0FBSyxLQUFLLE9BQU8saUJBQWlCLENBQUM7QUFDbkUsUUFBTSxXQUFXLG9CQUFJLElBQUk7QUFBQSxJQUN2QixLQUFLLEtBQUssUUFBUSxhQUFhLFFBQVE7QUFBQSxJQUN2QyxLQUFLLEtBQUssUUFBUSxhQUFhLFlBQVk7QUFBQSxFQUM3QyxDQUFDO0FBRUQsUUFBTSxTQUFTO0FBQUEsSUFDYjtBQUFBLElBQ0E7QUFBQSxJQUNBLENBQUMsTUFBTSxTQUFTLElBQUksQ0FBQztBQUFBLEVBQ3ZCO0FBRUEsU0FBTyxNQUFNLFFBQVEsS0FBSyxLQUFLLE9BQU8sYUFBYSxjQUFjLE9BQU8sa0JBQWtCLENBQUM7QUFDN0YsQ0FBQztBQUVELEtBQUssNEVBQTRFLE1BQU07QUFDckYsUUFBTSxNQUFNO0FBQ1osUUFBTSxnQkFBZ0IsVUFBVSxLQUFLLEtBQUssT0FBTyxpQkFBaUIsQ0FBQztBQUNuRSxRQUFNLFdBQVcsb0JBQUksSUFBSTtBQUFBLElBQ3ZCLEtBQUssS0FBSyxRQUFRLGFBQWEsUUFBUTtBQUFBLElBQ3ZDLEtBQUssS0FBSyxRQUFRLGFBQWEsWUFBWTtBQUFBLElBQzNDLEtBQUssS0FBSyxRQUFRLGFBQWEsY0FBYyxPQUFPLHFCQUFxQjtBQUFBLEVBQzNFLENBQUM7QUFFRCxRQUFNLFNBQVM7QUFBQSxJQUNiO0FBQUEsSUFDQTtBQUFBLElBQ0EsQ0FBQyxNQUFNLFNBQVMsSUFBSSxDQUFDO0FBQUEsRUFDdkI7QUFFQSxTQUFPLE1BQU0sUUFBUSxLQUFLLEtBQUssUUFBUSxhQUFhLGNBQWMsT0FBTyxxQkFBcUIsQ0FBQztBQUNqRyxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
