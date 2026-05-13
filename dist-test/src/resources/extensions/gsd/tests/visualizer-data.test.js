import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  computeCriticalPath,
  loadVisualizerData
} from "../visualizer-data.js";
test("computeCriticalPath follows milestone dependencies", () => {
  const milestones = [
    {
      id: "M001",
      title: "Foundation",
      status: "active",
      dependsOn: [],
      slices: [{ id: "S01", title: "Foundation", done: false, active: false, risk: "low", depends: [], tasks: [] }]
    },
    {
      id: "M002",
      title: "Feature",
      status: "active",
      dependsOn: ["M001"],
      slices: [{ id: "S01", title: "Build", done: false, active: true, risk: "medium", depends: [], tasks: [] }]
    }
  ];
  const path = computeCriticalPath(milestones);
  assert.deepEqual(path.milestonePath, ["M001", "M002"]);
  assert.equal(path.milestoneSlack.has("M001"), true);
  assert.equal(path.milestoneSlack.has("M002"), true);
});
test("loadVisualizerData hydrates milestones, captures, stats, and health fields", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-visualizer-data-"));
  try {
    const msDir = join(base, ".gsd", "milestones", "M001");
    const sliceDir = join(msDir, "slices", "S01");
    mkdirSync(sliceDir, { recursive: true });
    writeFileSync(
      join(msDir, "M001-ROADMAP.md"),
      [
        "# M001: Visualizer",
        "",
        "## Slices",
        "- [ ] **S01: Build UI** `risk:low` `depends:[]`"
      ].join("\n")
    );
    writeFileSync(
      join(sliceDir, "S01-PLAN.md"),
      "# S01 Plan\n\n## Tasks\n- [ ] **T01: Render data** `est:10m`\n"
    );
    writeFileSync(
      join(base, ".gsd", "CAPTURES.md"),
      [
        "# Captures",
        "",
        "### CAP-visual",
        "**Text:** Investigate visualizer state",
        "**Captured:** 2026-01-01T00:00:00.000Z",
        "**Status:** pending",
        ""
      ].join("\n")
    );
    const data = await loadVisualizerData(base);
    assert.equal(data.milestones.length, 1);
    assert.equal(data.milestones[0]?.id, "M001");
    assert.equal(data.milestones[0]?.slices[0]?.id, "S01");
    assert.equal(data.remainingSliceCount, 1);
    assert.equal(data.captures.pendingCount, 1);
    assert.equal(data.stats.missingCount, 1);
    assert.ok(data.health);
    assert.ok(data.criticalPath.milestonePath.length >= 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy92aXN1YWxpemVyLWRhdGEudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NELTIgXHUyMDE0IFZpc3VhbGl6ZXIgZGF0YSBiZWhhdmlvciB0ZXN0cy5cblxuaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5cbmltcG9ydCB7XG4gIGNvbXB1dGVDcml0aWNhbFBhdGgsXG4gIGxvYWRWaXN1YWxpemVyRGF0YSxcbiAgdHlwZSBWaXN1YWxpemVyTWlsZXN0b25lLFxufSBmcm9tIFwiLi4vdmlzdWFsaXplci1kYXRhLnRzXCI7XG5cbnRlc3QoXCJjb21wdXRlQ3JpdGljYWxQYXRoIGZvbGxvd3MgbWlsZXN0b25lIGRlcGVuZGVuY2llc1wiLCAoKSA9PiB7XG4gIGNvbnN0IG1pbGVzdG9uZXM6IFZpc3VhbGl6ZXJNaWxlc3RvbmVbXSA9IFtcbiAgICB7XG4gICAgICBpZDogXCJNMDAxXCIsXG4gICAgICB0aXRsZTogXCJGb3VuZGF0aW9uXCIsXG4gICAgICBzdGF0dXM6IFwiYWN0aXZlXCIsXG4gICAgICBkZXBlbmRzT246IFtdLFxuICAgICAgc2xpY2VzOiBbeyBpZDogXCJTMDFcIiwgdGl0bGU6IFwiRm91bmRhdGlvblwiLCBkb25lOiBmYWxzZSwgYWN0aXZlOiBmYWxzZSwgcmlzazogXCJsb3dcIiwgZGVwZW5kczogW10sIHRhc2tzOiBbXSB9XSxcbiAgICB9LFxuICAgIHtcbiAgICAgIGlkOiBcIk0wMDJcIixcbiAgICAgIHRpdGxlOiBcIkZlYXR1cmVcIixcbiAgICAgIHN0YXR1czogXCJhY3RpdmVcIixcbiAgICAgIGRlcGVuZHNPbjogW1wiTTAwMVwiXSxcbiAgICAgIHNsaWNlczogW3sgaWQ6IFwiUzAxXCIsIHRpdGxlOiBcIkJ1aWxkXCIsIGRvbmU6IGZhbHNlLCBhY3RpdmU6IHRydWUsIHJpc2s6IFwibWVkaXVtXCIsIGRlcGVuZHM6IFtdLCB0YXNrczogW10gfV0sXG4gICAgfSxcbiAgXTtcblxuICBjb25zdCBwYXRoID0gY29tcHV0ZUNyaXRpY2FsUGF0aChtaWxlc3RvbmVzKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChwYXRoLm1pbGVzdG9uZVBhdGgsIFtcIk0wMDFcIiwgXCJNMDAyXCJdKTtcbiAgYXNzZXJ0LmVxdWFsKHBhdGgubWlsZXN0b25lU2xhY2suaGFzKFwiTTAwMVwiKSwgdHJ1ZSk7XG4gIGFzc2VydC5lcXVhbChwYXRoLm1pbGVzdG9uZVNsYWNrLmhhcyhcIk0wMDJcIiksIHRydWUpO1xufSk7XG5cbnRlc3QoXCJsb2FkVmlzdWFsaXplckRhdGEgaHlkcmF0ZXMgbWlsZXN0b25lcywgY2FwdHVyZXMsIHN0YXRzLCBhbmQgaGVhbHRoIGZpZWxkc1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC12aXN1YWxpemVyLWRhdGEtXCIpKTtcbiAgdHJ5IHtcbiAgICBjb25zdCBtc0RpciA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIik7XG4gICAgY29uc3Qgc2xpY2VEaXIgPSBqb2luKG1zRGlyLCBcInNsaWNlc1wiLCBcIlMwMVwiKTtcbiAgICBta2RpclN5bmMoc2xpY2VEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKG1zRGlyLCBcIk0wMDEtUk9BRE1BUC5tZFwiKSxcbiAgICAgIFtcbiAgICAgICAgXCIjIE0wMDE6IFZpc3VhbGl6ZXJcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCIjIyBTbGljZXNcIixcbiAgICAgICAgXCItIFsgXSAqKlMwMTogQnVpbGQgVUkqKiBgcmlzazpsb3dgIGBkZXBlbmRzOltdYFwiLFxuICAgICAgXS5qb2luKFwiXFxuXCIpLFxuICAgICk7XG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4oc2xpY2VEaXIsIFwiUzAxLVBMQU4ubWRcIiksXG4gICAgICBcIiMgUzAxIFBsYW5cXG5cXG4jIyBUYXNrc1xcbi0gWyBdICoqVDAxOiBSZW5kZXIgZGF0YSoqIGBlc3Q6MTBtYFxcblwiLFxuICAgICk7XG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiQ0FQVFVSRVMubWRcIiksXG4gICAgICBbXG4gICAgICAgIFwiIyBDYXB0dXJlc1wiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIiMjIyBDQVAtdmlzdWFsXCIsXG4gICAgICAgIFwiKipUZXh0OioqIEludmVzdGlnYXRlIHZpc3VhbGl6ZXIgc3RhdGVcIixcbiAgICAgICAgXCIqKkNhcHR1cmVkOioqIDIwMjYtMDEtMDFUMDA6MDA6MDAuMDAwWlwiLFxuICAgICAgICBcIioqU3RhdHVzOioqIHBlbmRpbmdcIixcbiAgICAgICAgXCJcIixcbiAgICAgIF0uam9pbihcIlxcblwiKSxcbiAgICApO1xuXG4gICAgY29uc3QgZGF0YSA9IGF3YWl0IGxvYWRWaXN1YWxpemVyRGF0YShiYXNlKTtcblxuICAgIGFzc2VydC5lcXVhbChkYXRhLm1pbGVzdG9uZXMubGVuZ3RoLCAxKTtcbiAgICBhc3NlcnQuZXF1YWwoZGF0YS5taWxlc3RvbmVzWzBdPy5pZCwgXCJNMDAxXCIpO1xuICAgIGFzc2VydC5lcXVhbChkYXRhLm1pbGVzdG9uZXNbMF0/LnNsaWNlc1swXT8uaWQsIFwiUzAxXCIpO1xuICAgIGFzc2VydC5lcXVhbChkYXRhLnJlbWFpbmluZ1NsaWNlQ291bnQsIDEpO1xuICAgIGFzc2VydC5lcXVhbChkYXRhLmNhcHR1cmVzLnBlbmRpbmdDb3VudCwgMSk7XG4gICAgYXNzZXJ0LmVxdWFsKGRhdGEuc3RhdHMubWlzc2luZ0NvdW50LCAxKTtcbiAgICBhc3NlcnQub2soZGF0YS5oZWFsdGgpO1xuICAgIGFzc2VydC5vayhkYXRhLmNyaXRpY2FsUGF0aC5taWxlc3RvbmVQYXRoLmxlbmd0aCA+PSAxKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUVBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhLFdBQVcsUUFBUSxxQkFBcUI7QUFDOUQsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUV2QjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsT0FFSztBQUVQLEtBQUssc0RBQXNELE1BQU07QUFDL0QsUUFBTSxhQUFvQztBQUFBLElBQ3hDO0FBQUEsTUFDRSxJQUFJO0FBQUEsTUFDSixPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXLENBQUM7QUFBQSxNQUNaLFFBQVEsQ0FBQyxFQUFFLElBQUksT0FBTyxPQUFPLGNBQWMsTUFBTSxPQUFPLFFBQVEsT0FBTyxNQUFNLE9BQU8sU0FBUyxDQUFDLEdBQUcsT0FBTyxDQUFDLEVBQUUsQ0FBQztBQUFBLElBQzlHO0FBQUEsSUFDQTtBQUFBLE1BQ0UsSUFBSTtBQUFBLE1BQ0osT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVyxDQUFDLE1BQU07QUFBQSxNQUNsQixRQUFRLENBQUMsRUFBRSxJQUFJLE9BQU8sT0FBTyxTQUFTLE1BQU0sT0FBTyxRQUFRLE1BQU0sTUFBTSxVQUFVLFNBQVMsQ0FBQyxHQUFHLE9BQU8sQ0FBQyxFQUFFLENBQUM7QUFBQSxJQUMzRztBQUFBLEVBQ0Y7QUFFQSxRQUFNLE9BQU8sb0JBQW9CLFVBQVU7QUFDM0MsU0FBTyxVQUFVLEtBQUssZUFBZSxDQUFDLFFBQVEsTUFBTSxDQUFDO0FBQ3JELFNBQU8sTUFBTSxLQUFLLGVBQWUsSUFBSSxNQUFNLEdBQUcsSUFBSTtBQUNsRCxTQUFPLE1BQU0sS0FBSyxlQUFlLElBQUksTUFBTSxHQUFHLElBQUk7QUFDcEQsQ0FBQztBQUVELEtBQUssOEVBQThFLFlBQVk7QUFDN0YsUUFBTSxPQUFPLFlBQVksS0FBSyxPQUFPLEdBQUcsc0JBQXNCLENBQUM7QUFDL0QsTUFBSTtBQUNGLFVBQU0sUUFBUSxLQUFLLE1BQU0sUUFBUSxjQUFjLE1BQU07QUFDckQsVUFBTSxXQUFXLEtBQUssT0FBTyxVQUFVLEtBQUs7QUFDNUMsY0FBVSxVQUFVLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDdkM7QUFBQSxNQUNFLEtBQUssT0FBTyxpQkFBaUI7QUFBQSxNQUM3QjtBQUFBLFFBQ0U7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxNQUNGLEVBQUUsS0FBSyxJQUFJO0FBQUEsSUFDYjtBQUNBO0FBQUEsTUFDRSxLQUFLLFVBQVUsYUFBYTtBQUFBLE1BQzVCO0FBQUEsSUFDRjtBQUNBO0FBQUEsTUFDRSxLQUFLLE1BQU0sUUFBUSxhQUFhO0FBQUEsTUFDaEM7QUFBQSxRQUNFO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsTUFDRixFQUFFLEtBQUssSUFBSTtBQUFBLElBQ2I7QUFFQSxVQUFNLE9BQU8sTUFBTSxtQkFBbUIsSUFBSTtBQUUxQyxXQUFPLE1BQU0sS0FBSyxXQUFXLFFBQVEsQ0FBQztBQUN0QyxXQUFPLE1BQU0sS0FBSyxXQUFXLENBQUMsR0FBRyxJQUFJLE1BQU07QUFDM0MsV0FBTyxNQUFNLEtBQUssV0FBVyxDQUFDLEdBQUcsT0FBTyxDQUFDLEdBQUcsSUFBSSxLQUFLO0FBQ3JELFdBQU8sTUFBTSxLQUFLLHFCQUFxQixDQUFDO0FBQ3hDLFdBQU8sTUFBTSxLQUFLLFNBQVMsY0FBYyxDQUFDO0FBQzFDLFdBQU8sTUFBTSxLQUFLLE1BQU0sY0FBYyxDQUFDO0FBQ3ZDLFdBQU8sR0FBRyxLQUFLLE1BQU07QUFDckIsV0FBTyxHQUFHLEtBQUssYUFBYSxjQUFjLFVBQVUsQ0FBQztBQUFBLEVBQ3ZELFVBQUU7QUFDQSxXQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUMvQztBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
