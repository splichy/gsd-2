import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AutoSession } from "../auto/session.js";
import { postUnitPreVerification } from "../auto-post-unit.js";
test("postUnitPreVerification rebuilds STATE.md after a completed unit", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-post-unit-state-"));
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(sliceDir, { recursive: true });
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
      "# Roadmap\n\n## Slices\n\n- [ ] **S01: Discussed slice** `risk:low` `depends:[]`\n"
    );
    writeFileSync(join(sliceDir, "S01-CONTEXT.md"), "# Slice Context\n\nReady.\n");
    const s = new AutoSession();
    s.basePath = base;
    s.originalBasePath = base;
    s.currentMilestoneId = "M001";
    s.currentUnit = { type: "discuss-slice", id: "M001/S01", startedAt: Date.now() };
    const result = await postUnitPreVerification({
      s,
      ctx: { ui: { notify() {
      } } },
      pi: {},
      buildSnapshotOpts: () => ({}),
      lockBase: () => base,
      stopAuto: async () => {
      },
      pauseAuto: async () => {
      },
      updateProgressWidget: () => {
      }
    }, { skipSettleDelay: true, skipWorktreeSync: true });
    assert.equal(result, "continue");
    const statePath = join(base, ".gsd", "STATE.md");
    assert.equal(existsSync(statePath), true);
    assert.ok(readFileSync(statePath, "utf-8").includes("M001"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wb3N0LXVuaXQtc3RhdGUtcmVidWlsZC50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFJlZ3Jlc3Npb24gdGVzdCBmb3IgIzM4Njk6IG5vcm1hbCBwb3N0LXVuaXQgZmxvdyBzaG91bGQgcmVidWlsZCBTVEFURS5tZFxuICogYmVmb3JlIHN5bmNpbmcgd29ya3RyZWUgc3RhdGUgYmFjayB0byB0aGUgcHJvamVjdCByb290LlxuICovXG5cbmltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgZXhpc3RzU3luYywgbWtkaXJTeW5jLCBta2R0ZW1wU3luYywgcmVhZEZpbGVTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBBdXRvU2Vzc2lvbiB9IGZyb20gXCIuLi9hdXRvL3Nlc3Npb24udHNcIjtcbmltcG9ydCB7IHBvc3RVbml0UHJlVmVyaWZpY2F0aW9uIH0gZnJvbSBcIi4uL2F1dG8tcG9zdC11bml0LnRzXCI7XG5cbnRlc3QoXCJwb3N0VW5pdFByZVZlcmlmaWNhdGlvbiByZWJ1aWxkcyBTVEFURS5tZCBhZnRlciBhIGNvbXBsZXRlZCB1bml0XCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXBvc3QtdW5pdC1zdGF0ZS1cIikpO1xuICB0cnkge1xuICAgIGNvbnN0IHNsaWNlRGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiKTtcbiAgICBta2RpclN5bmMoc2xpY2VEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwiTTAwMS1ST0FETUFQLm1kXCIpLFxuICAgICAgXCIjIFJvYWRtYXBcXG5cXG4jIyBTbGljZXNcXG5cXG4tIFsgXSAqKlMwMTogRGlzY3Vzc2VkIHNsaWNlKiogYHJpc2s6bG93YCBgZGVwZW5kczpbXWBcXG5cIixcbiAgICApO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihzbGljZURpciwgXCJTMDEtQ09OVEVYVC5tZFwiKSwgXCIjIFNsaWNlIENvbnRleHRcXG5cXG5SZWFkeS5cXG5cIik7XG5cbiAgICBjb25zdCBzID0gbmV3IEF1dG9TZXNzaW9uKCk7XG4gICAgcy5iYXNlUGF0aCA9IGJhc2U7XG4gICAgcy5vcmlnaW5hbEJhc2VQYXRoID0gYmFzZTtcbiAgICBzLmN1cnJlbnRNaWxlc3RvbmVJZCA9IFwiTTAwMVwiO1xuICAgIHMuY3VycmVudFVuaXQgPSB7IHR5cGU6IFwiZGlzY3Vzcy1zbGljZVwiLCBpZDogXCJNMDAxL1MwMVwiLCBzdGFydGVkQXQ6IERhdGUubm93KCkgfTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHBvc3RVbml0UHJlVmVyaWZpY2F0aW9uKHtcbiAgICAgIHMsXG4gICAgICBjdHg6IHsgdWk6IHsgbm90aWZ5KCkge30gfSB9IGFzIGFueSxcbiAgICAgIHBpOiB7fSBhcyBhbnksXG4gICAgICBidWlsZFNuYXBzaG90T3B0czogKCkgPT4gKHt9KSxcbiAgICAgIGxvY2tCYXNlOiAoKSA9PiBiYXNlLFxuICAgICAgc3RvcEF1dG86IGFzeW5jICgpID0+IHt9LFxuICAgICAgcGF1c2VBdXRvOiBhc3luYyAoKSA9PiB7fSxcbiAgICAgIHVwZGF0ZVByb2dyZXNzV2lkZ2V0OiAoKSA9PiB7fSxcbiAgICB9LCB7IHNraXBTZXR0bGVEZWxheTogdHJ1ZSwgc2tpcFdvcmt0cmVlU3luYzogdHJ1ZSB9KTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIFwiY29udGludWVcIik7XG4gICAgY29uc3Qgc3RhdGVQYXRoID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJTVEFURS5tZFwiKTtcbiAgICBhc3NlcnQuZXF1YWwoZXhpc3RzU3luYyhzdGF0ZVBhdGgpLCB0cnVlKTtcbiAgICBhc3NlcnQub2socmVhZEZpbGVTeW5jKHN0YXRlUGF0aCwgXCJ1dGYtOFwiKS5pbmNsdWRlcyhcIk0wMDFcIikpO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBS0EsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUNuQixTQUFTLFlBQVksV0FBVyxhQUFhLGNBQWMsUUFBUSxxQkFBcUI7QUFDeEYsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUN2QixTQUFTLG1CQUFtQjtBQUM1QixTQUFTLCtCQUErQjtBQUV4QyxLQUFLLG9FQUFvRSxZQUFZO0FBQ25GLFFBQU0sT0FBTyxZQUFZLEtBQUssT0FBTyxHQUFHLHNCQUFzQixDQUFDO0FBQy9ELE1BQUk7QUFDRixVQUFNLFdBQVcsS0FBSyxNQUFNLFFBQVEsY0FBYyxRQUFRLFVBQVUsS0FBSztBQUN6RSxjQUFVLFVBQVUsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUN2QztBQUFBLE1BQ0UsS0FBSyxNQUFNLFFBQVEsY0FBYyxRQUFRLGlCQUFpQjtBQUFBLE1BQzFEO0FBQUEsSUFDRjtBQUNBLGtCQUFjLEtBQUssVUFBVSxnQkFBZ0IsR0FBRyw2QkFBNkI7QUFFN0UsVUFBTSxJQUFJLElBQUksWUFBWTtBQUMxQixNQUFFLFdBQVc7QUFDYixNQUFFLG1CQUFtQjtBQUNyQixNQUFFLHFCQUFxQjtBQUN2QixNQUFFLGNBQWMsRUFBRSxNQUFNLGlCQUFpQixJQUFJLFlBQVksV0FBVyxLQUFLLElBQUksRUFBRTtBQUUvRSxVQUFNLFNBQVMsTUFBTSx3QkFBd0I7QUFBQSxNQUMzQztBQUFBLE1BQ0EsS0FBSyxFQUFFLElBQUksRUFBRSxTQUFTO0FBQUEsTUFBQyxFQUFFLEVBQUU7QUFBQSxNQUMzQixJQUFJLENBQUM7QUFBQSxNQUNMLG1CQUFtQixPQUFPLENBQUM7QUFBQSxNQUMzQixVQUFVLE1BQU07QUFBQSxNQUNoQixVQUFVLFlBQVk7QUFBQSxNQUFDO0FBQUEsTUFDdkIsV0FBVyxZQUFZO0FBQUEsTUFBQztBQUFBLE1BQ3hCLHNCQUFzQixNQUFNO0FBQUEsTUFBQztBQUFBLElBQy9CLEdBQUcsRUFBRSxpQkFBaUIsTUFBTSxrQkFBa0IsS0FBSyxDQUFDO0FBRXBELFdBQU8sTUFBTSxRQUFRLFVBQVU7QUFDL0IsVUFBTSxZQUFZLEtBQUssTUFBTSxRQUFRLFVBQVU7QUFDL0MsV0FBTyxNQUFNLFdBQVcsU0FBUyxHQUFHLElBQUk7QUFDeEMsV0FBTyxHQUFHLGFBQWEsV0FBVyxPQUFPLEVBQUUsU0FBUyxNQUFNLENBQUM7QUFBQSxFQUM3RCxVQUFFO0FBQ0EsV0FBTyxNQUFNLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsRUFDL0M7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
