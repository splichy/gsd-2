import test from "node:test";
import assert from "node:assert/strict";
import {
  getBgShellLiveCwd,
  resolveBgShellPersistenceCwd
} from "../resources/extensions/bg-shell/utilities.js";
test("keeps non-worktree cwd unchanged", () => {
  const cached = "/repo";
  const live = "/repo";
  assert.equal(resolveBgShellPersistenceCwd(cached, live, () => true), cached);
});
test("rewrites stale auto-worktree cwd to live cwd after exit", () => {
  const cached = "/repo/.gsd/worktrees/M001";
  const live = "/repo";
  assert.equal(
    resolveBgShellPersistenceCwd(cached, live, (path) => path === live),
    live
  );
});
test("rewrites mismatched auto-worktree cwd to live cwd even if old path still exists", () => {
  const cached = "/repo/.gsd/worktrees/M001";
  const live = "/repo";
  assert.equal(
    resolveBgShellPersistenceCwd(cached, live, () => true),
    live
  );
});
test("rewrites Windows-style auto-worktree cwd to live cwd", () => {
  const cached = "C:\\repo\\.gsd\\worktrees\\M001";
  const live = "C:\\repo";
  assert.equal(
    resolveBgShellPersistenceCwd(cached, live, () => true),
    live
  );
});
test("keeps current auto-worktree cwd when it still matches process cwd", () => {
  const cached = "/repo/.gsd/worktrees/M001";
  assert.equal(
    resolveBgShellPersistenceCwd(cached, cached, () => true),
    cached
  );
});
test("falls back to project root when process.cwd throws inside a stale auto-worktree", () => {
  const cached = "/repo/.gsd/worktrees/M001";
  const live = getBgShellLiveCwd(
    cached,
    (path) => path === "/repo",
    () => {
      throw Object.assign(new Error("uv_cwd"), { code: "ENOENT", syscall: "uv_cwd" });
    },
    () => {
    }
  );
  assert.equal(live, "/repo");
  assert.equal(resolveBgShellPersistenceCwd(cached, live, (path) => path === "/repo"), "/repo");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3Rlc3RzL2JnLXNoZWxsLXBlcnNpc3RlbmNlLWN3ZC50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcblxuaW1wb3J0IHtcbiAgZ2V0QmdTaGVsbExpdmVDd2QsXG4gIHJlc29sdmVCZ1NoZWxsUGVyc2lzdGVuY2VDd2QsXG59IGZyb20gXCIuLi9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9iZy1zaGVsbC91dGlsaXRpZXMudHNcIjtcblxudGVzdChcImtlZXBzIG5vbi13b3JrdHJlZSBjd2QgdW5jaGFuZ2VkXCIsICgpID0+IHtcbiAgY29uc3QgY2FjaGVkID0gXCIvcmVwb1wiO1xuICBjb25zdCBsaXZlID0gXCIvcmVwb1wiO1xuICBhc3NlcnQuZXF1YWwocmVzb2x2ZUJnU2hlbGxQZXJzaXN0ZW5jZUN3ZChjYWNoZWQsIGxpdmUsICgpID0+IHRydWUpLCBjYWNoZWQpO1xufSk7XG5cbnRlc3QoXCJyZXdyaXRlcyBzdGFsZSBhdXRvLXdvcmt0cmVlIGN3ZCB0byBsaXZlIGN3ZCBhZnRlciBleGl0XCIsICgpID0+IHtcbiAgY29uc3QgY2FjaGVkID0gXCIvcmVwby8uZ3NkL3dvcmt0cmVlcy9NMDAxXCI7XG4gIGNvbnN0IGxpdmUgPSBcIi9yZXBvXCI7XG4gIGFzc2VydC5lcXVhbChcbiAgICByZXNvbHZlQmdTaGVsbFBlcnNpc3RlbmNlQ3dkKGNhY2hlZCwgbGl2ZSwgKHBhdGgpID0+IHBhdGggPT09IGxpdmUpLFxuICAgIGxpdmUsXG4gICk7XG59KTtcblxudGVzdChcInJld3JpdGVzIG1pc21hdGNoZWQgYXV0by13b3JrdHJlZSBjd2QgdG8gbGl2ZSBjd2QgZXZlbiBpZiBvbGQgcGF0aCBzdGlsbCBleGlzdHNcIiwgKCkgPT4ge1xuICBjb25zdCBjYWNoZWQgPSBcIi9yZXBvLy5nc2Qvd29ya3RyZWVzL00wMDFcIjtcbiAgY29uc3QgbGl2ZSA9IFwiL3JlcG9cIjtcbiAgYXNzZXJ0LmVxdWFsKFxuICAgIHJlc29sdmVCZ1NoZWxsUGVyc2lzdGVuY2VDd2QoY2FjaGVkLCBsaXZlLCAoKSA9PiB0cnVlKSxcbiAgICBsaXZlLFxuICApO1xufSk7XG5cbnRlc3QoXCJyZXdyaXRlcyBXaW5kb3dzLXN0eWxlIGF1dG8td29ya3RyZWUgY3dkIHRvIGxpdmUgY3dkXCIsICgpID0+IHtcbiAgY29uc3QgY2FjaGVkID0gXCJDOlxcXFxyZXBvXFxcXC5nc2RcXFxcd29ya3RyZWVzXFxcXE0wMDFcIjtcbiAgY29uc3QgbGl2ZSA9IFwiQzpcXFxccmVwb1wiO1xuICBhc3NlcnQuZXF1YWwoXG4gICAgcmVzb2x2ZUJnU2hlbGxQZXJzaXN0ZW5jZUN3ZChjYWNoZWQsIGxpdmUsICgpID0+IHRydWUpLFxuICAgIGxpdmUsXG4gICk7XG59KTtcblxudGVzdChcImtlZXBzIGN1cnJlbnQgYXV0by13b3JrdHJlZSBjd2Qgd2hlbiBpdCBzdGlsbCBtYXRjaGVzIHByb2Nlc3MgY3dkXCIsICgpID0+IHtcbiAgY29uc3QgY2FjaGVkID0gXCIvcmVwby8uZ3NkL3dvcmt0cmVlcy9NMDAxXCI7XG4gIGFzc2VydC5lcXVhbChcbiAgICByZXNvbHZlQmdTaGVsbFBlcnNpc3RlbmNlQ3dkKGNhY2hlZCwgY2FjaGVkLCAoKSA9PiB0cnVlKSxcbiAgICBjYWNoZWQsXG4gICk7XG59KTtcblxudGVzdChcImZhbGxzIGJhY2sgdG8gcHJvamVjdCByb290IHdoZW4gcHJvY2Vzcy5jd2QgdGhyb3dzIGluc2lkZSBhIHN0YWxlIGF1dG8td29ya3RyZWVcIiwgKCkgPT4ge1xuICBjb25zdCBjYWNoZWQgPSBcIi9yZXBvLy5nc2Qvd29ya3RyZWVzL00wMDFcIjtcbiAgY29uc3QgbGl2ZSA9IGdldEJnU2hlbGxMaXZlQ3dkKFxuICAgIGNhY2hlZCxcbiAgICAocGF0aCkgPT4gcGF0aCA9PT0gXCIvcmVwb1wiLFxuICAgICgpID0+IHtcbiAgICAgIHRocm93IE9iamVjdC5hc3NpZ24obmV3IEVycm9yKFwidXZfY3dkXCIpLCB7IGNvZGU6IFwiRU5PRU5UXCIsIHN5c2NhbGw6IFwidXZfY3dkXCIgfSk7XG4gICAgfSxcbiAgICAoKSA9PiB7fSxcbiAgKTtcblxuICBhc3NlcnQuZXF1YWwobGl2ZSwgXCIvcmVwb1wiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc29sdmVCZ1NoZWxsUGVyc2lzdGVuY2VDd2QoY2FjaGVkLCBsaXZlLCAocGF0aCkgPT4gcGF0aCA9PT0gXCIvcmVwb1wiKSwgXCIvcmVwb1wiKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUVuQjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUVQLEtBQUssb0NBQW9DLE1BQU07QUFDN0MsUUFBTSxTQUFTO0FBQ2YsUUFBTSxPQUFPO0FBQ2IsU0FBTyxNQUFNLDZCQUE2QixRQUFRLE1BQU0sTUFBTSxJQUFJLEdBQUcsTUFBTTtBQUM3RSxDQUFDO0FBRUQsS0FBSywyREFBMkQsTUFBTTtBQUNwRSxRQUFNLFNBQVM7QUFDZixRQUFNLE9BQU87QUFDYixTQUFPO0FBQUEsSUFDTCw2QkFBNkIsUUFBUSxNQUFNLENBQUMsU0FBUyxTQUFTLElBQUk7QUFBQSxJQUNsRTtBQUFBLEVBQ0Y7QUFDRixDQUFDO0FBRUQsS0FBSyxtRkFBbUYsTUFBTTtBQUM1RixRQUFNLFNBQVM7QUFDZixRQUFNLE9BQU87QUFDYixTQUFPO0FBQUEsSUFDTCw2QkFBNkIsUUFBUSxNQUFNLE1BQU0sSUFBSTtBQUFBLElBQ3JEO0FBQUEsRUFDRjtBQUNGLENBQUM7QUFFRCxLQUFLLHdEQUF3RCxNQUFNO0FBQ2pFLFFBQU0sU0FBUztBQUNmLFFBQU0sT0FBTztBQUNiLFNBQU87QUFBQSxJQUNMLDZCQUE2QixRQUFRLE1BQU0sTUFBTSxJQUFJO0FBQUEsSUFDckQ7QUFBQSxFQUNGO0FBQ0YsQ0FBQztBQUVELEtBQUsscUVBQXFFLE1BQU07QUFDOUUsUUFBTSxTQUFTO0FBQ2YsU0FBTztBQUFBLElBQ0wsNkJBQTZCLFFBQVEsUUFBUSxNQUFNLElBQUk7QUFBQSxJQUN2RDtBQUFBLEVBQ0Y7QUFDRixDQUFDO0FBRUQsS0FBSyxtRkFBbUYsTUFBTTtBQUM1RixRQUFNLFNBQVM7QUFDZixRQUFNLE9BQU87QUFBQSxJQUNYO0FBQUEsSUFDQSxDQUFDLFNBQVMsU0FBUztBQUFBLElBQ25CLE1BQU07QUFDSixZQUFNLE9BQU8sT0FBTyxJQUFJLE1BQU0sUUFBUSxHQUFHLEVBQUUsTUFBTSxVQUFVLFNBQVMsU0FBUyxDQUFDO0FBQUEsSUFDaEY7QUFBQSxJQUNBLE1BQU07QUFBQSxJQUFDO0FBQUEsRUFDVDtBQUVBLFNBQU8sTUFBTSxNQUFNLE9BQU87QUFDMUIsU0FBTyxNQUFNLDZCQUE2QixRQUFRLE1BQU0sQ0FBQyxTQUFTLFNBQVMsT0FBTyxHQUFHLE9BQU87QUFDOUYsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
