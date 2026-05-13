import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolvePreferredModelConfig } from "../auto-model-selection.js";
function withRoutingPrefs(fn) {
  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;
  const tempProject = mkdtempSync(join(tmpdir(), "gsd-interactive-routing-"));
  const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-interactive-routing-home-"));
  try {
    mkdirSync(join(tempProject, ".gsd"), { recursive: true });
    writeFileSync(
      join(tempProject, ".gsd", "PREFERENCES.md"),
      [
        "---",
        "dynamic_routing:",
        "  enabled: true",
        "  tier_models:",
        "    light: gpt-4o-mini",
        "    standard: claude-sonnet-4-6",
        "    heavy: claude-opus-4-6",
        "---"
      ].join("\n"),
      "utf-8"
    );
    process.env.GSD_HOME = tempGsdHome;
    process.chdir(tempProject);
    return fn();
  } finally {
    process.chdir(originalCwd);
    if (originalGsdHome === void 0) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempGsdHome, { recursive: true, force: true });
  }
}
describe("interactive routing bypass (#3962)", () => {
  test("interactive dispatch does not synthesize dynamic routing config", () => {
    withRoutingPrefs(() => {
      const result = resolvePreferredModelConfig(
        "execute-task",
        { provider: "anthropic", id: "claude-sonnet-4-6" },
        false
      );
      assert.equal(result, void 0);
    });
  });
  test("auto-mode dispatch still synthesizes dynamic routing config", () => {
    withRoutingPrefs(() => {
      const result = resolvePreferredModelConfig(
        "execute-task",
        { provider: "anthropic", id: "claude-sonnet-4-6" },
        true
      );
      assert.ok(result);
      assert.equal(result.primary, "claude-opus-4-6");
      assert.equal(result.source, "synthesized");
    });
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9pbnRlcmFjdGl2ZS1yb3V0aW5nLWJ5cGFzcy50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBHU0QgRXh0ZW5zaW9uIFx1MjAxNCBJbnRlcmFjdGl2ZSBSb3V0aW5nIEJ5cGFzcyBUZXN0c1xuXG5pbXBvcnQgdGVzdCwgeyBkZXNjcmliZSB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuXG5pbXBvcnQgeyByZXNvbHZlUHJlZmVycmVkTW9kZWxDb25maWcgfSBmcm9tIFwiLi4vYXV0by1tb2RlbC1zZWxlY3Rpb24udHNcIjtcblxuZnVuY3Rpb24gd2l0aFJvdXRpbmdQcmVmczxUPihmbjogKCkgPT4gVCk6IFQge1xuICBjb25zdCBvcmlnaW5hbEN3ZCA9IHByb2Nlc3MuY3dkKCk7XG4gIGNvbnN0IG9yaWdpbmFsR3NkSG9tZSA9IHByb2Nlc3MuZW52LkdTRF9IT01FO1xuICBjb25zdCB0ZW1wUHJvamVjdCA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLWludGVyYWN0aXZlLXJvdXRpbmctXCIpKTtcbiAgY29uc3QgdGVtcEdzZEhvbWUgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1pbnRlcmFjdGl2ZS1yb3V0aW5nLWhvbWUtXCIpKTtcblxuICB0cnkge1xuICAgIG1rZGlyU3luYyhqb2luKHRlbXBQcm9qZWN0LCBcIi5nc2RcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKHRlbXBQcm9qZWN0LCBcIi5nc2RcIiwgXCJQUkVGRVJFTkNFUy5tZFwiKSxcbiAgICAgIFtcbiAgICAgICAgXCItLS1cIixcbiAgICAgICAgXCJkeW5hbWljX3JvdXRpbmc6XCIsXG4gICAgICAgIFwiICBlbmFibGVkOiB0cnVlXCIsXG4gICAgICAgIFwiICB0aWVyX21vZGVsczpcIixcbiAgICAgICAgXCIgICAgbGlnaHQ6IGdwdC00by1taW5pXCIsXG4gICAgICAgIFwiICAgIHN0YW5kYXJkOiBjbGF1ZGUtc29ubmV0LTQtNlwiLFxuICAgICAgICBcIiAgICBoZWF2eTogY2xhdWRlLW9wdXMtNC02XCIsXG4gICAgICAgIFwiLS0tXCIsXG4gICAgICBdLmpvaW4oXCJcXG5cIiksXG4gICAgICBcInV0Zi04XCIsXG4gICAgKTtcbiAgICBwcm9jZXNzLmVudi5HU0RfSE9NRSA9IHRlbXBHc2RIb21lO1xuICAgIHByb2Nlc3MuY2hkaXIodGVtcFByb2plY3QpO1xuICAgIHJldHVybiBmbigpO1xuICB9IGZpbmFsbHkge1xuICAgIHByb2Nlc3MuY2hkaXIob3JpZ2luYWxDd2QpO1xuICAgIGlmIChvcmlnaW5hbEdzZEhvbWUgPT09IHVuZGVmaW5lZCkgZGVsZXRlIHByb2Nlc3MuZW52LkdTRF9IT01FO1xuICAgIGVsc2UgcHJvY2Vzcy5lbnYuR1NEX0hPTUUgPSBvcmlnaW5hbEdzZEhvbWU7XG4gICAgcm1TeW5jKHRlbXBQcm9qZWN0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgcm1TeW5jKHRlbXBHc2RIb21lLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn1cblxuZGVzY3JpYmUoXCJpbnRlcmFjdGl2ZSByb3V0aW5nIGJ5cGFzcyAoIzM5NjIpXCIsICgpID0+IHtcbiAgdGVzdChcImludGVyYWN0aXZlIGRpc3BhdGNoIGRvZXMgbm90IHN5bnRoZXNpemUgZHluYW1pYyByb3V0aW5nIGNvbmZpZ1wiLCAoKSA9PiB7XG4gICAgd2l0aFJvdXRpbmdQcmVmcygoKSA9PiB7XG4gICAgICBjb25zdCByZXN1bHQgPSByZXNvbHZlUHJlZmVycmVkTW9kZWxDb25maWcoXG4gICAgICAgIFwiZXhlY3V0ZS10YXNrXCIsXG4gICAgICAgIHsgcHJvdmlkZXI6IFwiYW50aHJvcGljXCIsIGlkOiBcImNsYXVkZS1zb25uZXQtNC02XCIgfSxcbiAgICAgICAgZmFsc2UsXG4gICAgICApO1xuXG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCB1bmRlZmluZWQpO1xuICAgIH0pO1xuICB9KTtcblxuICB0ZXN0KFwiYXV0by1tb2RlIGRpc3BhdGNoIHN0aWxsIHN5bnRoZXNpemVzIGR5bmFtaWMgcm91dGluZyBjb25maWdcIiwgKCkgPT4ge1xuICAgIHdpdGhSb3V0aW5nUHJlZnMoKCkgPT4ge1xuICAgICAgY29uc3QgcmVzdWx0ID0gcmVzb2x2ZVByZWZlcnJlZE1vZGVsQ29uZmlnKFxuICAgICAgICBcImV4ZWN1dGUtdGFza1wiLFxuICAgICAgICB7IHByb3ZpZGVyOiBcImFudGhyb3BpY1wiLCBpZDogXCJjbGF1ZGUtc29ubmV0LTQtNlwiIH0sXG4gICAgICAgIHRydWUsXG4gICAgICApO1xuXG4gICAgICBhc3NlcnQub2socmVzdWx0KTtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHQhLnByaW1hcnksIFwiY2xhdWRlLW9wdXMtNC02XCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCEuc291cmNlLCBcInN5bnRoZXNpemVkXCIpO1xuICAgIH0pO1xuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBRUEsT0FBTyxRQUFRLGdCQUFnQjtBQUMvQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhLFdBQVcsUUFBUSxxQkFBcUI7QUFDOUQsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUV2QixTQUFTLG1DQUFtQztBQUU1QyxTQUFTLGlCQUFvQixJQUFnQjtBQUMzQyxRQUFNLGNBQWMsUUFBUSxJQUFJO0FBQ2hDLFFBQU0sa0JBQWtCLFFBQVEsSUFBSTtBQUNwQyxRQUFNLGNBQWMsWUFBWSxLQUFLLE9BQU8sR0FBRywwQkFBMEIsQ0FBQztBQUMxRSxRQUFNLGNBQWMsWUFBWSxLQUFLLE9BQU8sR0FBRywrQkFBK0IsQ0FBQztBQUUvRSxNQUFJO0FBQ0YsY0FBVSxLQUFLLGFBQWEsTUFBTSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDeEQ7QUFBQSxNQUNFLEtBQUssYUFBYSxRQUFRLGdCQUFnQjtBQUFBLE1BQzFDO0FBQUEsUUFDRTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxNQUNGLEVBQUUsS0FBSyxJQUFJO0FBQUEsTUFDWDtBQUFBLElBQ0Y7QUFDQSxZQUFRLElBQUksV0FBVztBQUN2QixZQUFRLE1BQU0sV0FBVztBQUN6QixXQUFPLEdBQUc7QUFBQSxFQUNaLFVBQUU7QUFDQSxZQUFRLE1BQU0sV0FBVztBQUN6QixRQUFJLG9CQUFvQixPQUFXLFFBQU8sUUFBUSxJQUFJO0FBQUEsUUFDakQsU0FBUSxJQUFJLFdBQVc7QUFDNUIsV0FBTyxhQUFhLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQ3BELFdBQU8sYUFBYSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQ3REO0FBQ0Y7QUFFQSxTQUFTLHNDQUFzQyxNQUFNO0FBQ25ELE9BQUssbUVBQW1FLE1BQU07QUFDNUUscUJBQWlCLE1BQU07QUFDckIsWUFBTSxTQUFTO0FBQUEsUUFDYjtBQUFBLFFBQ0EsRUFBRSxVQUFVLGFBQWEsSUFBSSxvQkFBb0I7QUFBQSxRQUNqRDtBQUFBLE1BQ0Y7QUFFQSxhQUFPLE1BQU0sUUFBUSxNQUFTO0FBQUEsSUFDaEMsQ0FBQztBQUFBLEVBQ0gsQ0FBQztBQUVELE9BQUssK0RBQStELE1BQU07QUFDeEUscUJBQWlCLE1BQU07QUFDckIsWUFBTSxTQUFTO0FBQUEsUUFDYjtBQUFBLFFBQ0EsRUFBRSxVQUFVLGFBQWEsSUFBSSxvQkFBb0I7QUFBQSxRQUNqRDtBQUFBLE1BQ0Y7QUFFQSxhQUFPLEdBQUcsTUFBTTtBQUNoQixhQUFPLE1BQU0sT0FBUSxTQUFTLGlCQUFpQjtBQUMvQyxhQUFPLE1BQU0sT0FBUSxRQUFRLGFBQWE7QUFBQSxJQUM1QyxDQUFDO0FBQUEsRUFDSCxDQUFDO0FBQ0gsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
