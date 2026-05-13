import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { syncWorktreeStateBack } from "../auto-worktree.js";
describe("syncWorktreeStateBack does not copy worktree milestone projections", () => {
  it("copies root diagnostics but leaves milestone markdown directories behind", () => {
    const root = mkdtempSync(join(tmpdir(), "gsd-sync-back-"));
    const main = join(root, "main");
    const worktree = join(root, "worktree");
    try {
      mkdirSync(join(main, ".gsd", "milestones"), { recursive: true });
      mkdirSync(join(worktree, ".gsd", "milestones", "M001"), { recursive: true });
      writeFileSync(join(worktree, ".gsd", "metrics.json"), "{}\n", "utf-8");
      writeFileSync(
        join(worktree, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
        "# M001: Worktree-only projection\n",
        "utf-8"
      );
      const result = syncWorktreeStateBack(main, worktree, "M001");
      assert.deepEqual(result.synced, ["metrics.json"]);
      assert.equal(existsSync(join(main, ".gsd", "metrics.json")), true);
      assert.equal(
        existsSync(join(main, ".gsd", "milestones", "M001", "M001-ROADMAP.md")),
        false
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9zeW5jLXdvcmt0cmVlLXNraXAtY3VycmVudC50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFJlZ3Jlc3Npb24gdGVzdCBmb3IgREItYXV0aG9yaXRhdGl2ZSBzeW5jV29ya3RyZWVTdGF0ZUJhY2sgYmVoYXZpb3IuXG4gKi9cblxuaW1wb3J0IHsgZGVzY3JpYmUsIGl0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCBta2RpclN5bmMsIG1rZHRlbXBTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5cbmltcG9ydCB7IHN5bmNXb3JrdHJlZVN0YXRlQmFjayB9IGZyb20gXCIuLi9hdXRvLXdvcmt0cmVlLnRzXCI7XG5cbmRlc2NyaWJlKFwic3luY1dvcmt0cmVlU3RhdGVCYWNrIGRvZXMgbm90IGNvcHkgd29ya3RyZWUgbWlsZXN0b25lIHByb2plY3Rpb25zXCIsICgpID0+IHtcbiAgaXQoXCJjb3BpZXMgcm9vdCBkaWFnbm9zdGljcyBidXQgbGVhdmVzIG1pbGVzdG9uZSBtYXJrZG93biBkaXJlY3RvcmllcyBiZWhpbmRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJvb3QgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1zeW5jLWJhY2stXCIpKTtcbiAgICBjb25zdCBtYWluID0gam9pbihyb290LCBcIm1haW5cIik7XG4gICAgY29uc3Qgd29ya3RyZWUgPSBqb2luKHJvb3QsIFwid29ya3RyZWVcIik7XG4gICAgdHJ5IHtcbiAgICAgIG1rZGlyU3luYyhqb2luKG1haW4sIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgbWtkaXJTeW5jKGpvaW4od29ya3RyZWUsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbih3b3JrdHJlZSwgXCIuZ3NkXCIsIFwibWV0cmljcy5qc29uXCIpLCBcInt9XFxuXCIsIFwidXRmLThcIik7XG4gICAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgICBqb2luKHdvcmt0cmVlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcIk0wMDEtUk9BRE1BUC5tZFwiKSxcbiAgICAgICAgXCIjIE0wMDE6IFdvcmt0cmVlLW9ubHkgcHJvamVjdGlvblxcblwiLFxuICAgICAgICBcInV0Zi04XCIsXG4gICAgICApO1xuXG4gICAgICBjb25zdCByZXN1bHQgPSBzeW5jV29ya3RyZWVTdGF0ZUJhY2sobWFpbiwgd29ya3RyZWUsIFwiTTAwMVwiKTtcblxuICAgICAgYXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQuc3luY2VkLCBbXCJtZXRyaWNzLmpzb25cIl0pO1xuICAgICAgYXNzZXJ0LmVxdWFsKGV4aXN0c1N5bmMoam9pbihtYWluLCBcIi5nc2RcIiwgXCJtZXRyaWNzLmpzb25cIikpLCB0cnVlKTtcbiAgICAgIGFzc2VydC5lcXVhbChcbiAgICAgICAgZXhpc3RzU3luYyhqb2luKG1haW4sIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwiTTAwMS1ST0FETUFQLm1kXCIpKSxcbiAgICAgICAgZmFsc2UsXG4gICAgICApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmMocm9vdCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUlBLFNBQVMsVUFBVSxVQUFVO0FBQzdCLE9BQU8sWUFBWTtBQUNuQixTQUFTLFlBQVksV0FBVyxhQUFhLFFBQVEscUJBQXFCO0FBQzFFLFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFFdkIsU0FBUyw2QkFBNkI7QUFFdEMsU0FBUyxzRUFBc0UsTUFBTTtBQUNuRixLQUFHLDRFQUE0RSxNQUFNO0FBQ25GLFVBQU0sT0FBTyxZQUFZLEtBQUssT0FBTyxHQUFHLGdCQUFnQixDQUFDO0FBQ3pELFVBQU0sT0FBTyxLQUFLLE1BQU0sTUFBTTtBQUM5QixVQUFNLFdBQVcsS0FBSyxNQUFNLFVBQVU7QUFDdEMsUUFBSTtBQUNGLGdCQUFVLEtBQUssTUFBTSxRQUFRLFlBQVksR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQy9ELGdCQUFVLEtBQUssVUFBVSxRQUFRLGNBQWMsTUFBTSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDM0Usb0JBQWMsS0FBSyxVQUFVLFFBQVEsY0FBYyxHQUFHLFFBQVEsT0FBTztBQUNyRTtBQUFBLFFBQ0UsS0FBSyxVQUFVLFFBQVEsY0FBYyxRQUFRLGlCQUFpQjtBQUFBLFFBQzlEO0FBQUEsUUFDQTtBQUFBLE1BQ0Y7QUFFQSxZQUFNLFNBQVMsc0JBQXNCLE1BQU0sVUFBVSxNQUFNO0FBRTNELGFBQU8sVUFBVSxPQUFPLFFBQVEsQ0FBQyxjQUFjLENBQUM7QUFDaEQsYUFBTyxNQUFNLFdBQVcsS0FBSyxNQUFNLFFBQVEsY0FBYyxDQUFDLEdBQUcsSUFBSTtBQUNqRSxhQUFPO0FBQUEsUUFDTCxXQUFXLEtBQUssTUFBTSxRQUFRLGNBQWMsUUFBUSxpQkFBaUIsQ0FBQztBQUFBLFFBQ3RFO0FBQUEsTUFDRjtBQUFBLElBQ0YsVUFBRTtBQUNBLGFBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQy9DO0FBQUEsRUFDRixDQUFDO0FBQ0gsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
