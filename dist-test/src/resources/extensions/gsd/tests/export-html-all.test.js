import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
test("handleExport --html --all generates reports for milestones missing from the index", async () => {
  const { loadReportsIndex } = await import("../reports.js");
  const tmp = join(tmpdir(), `gsd-export-all-test-${Date.now()}`);
  const gsdDir = join(tmp, ".gsd");
  const reportsDir = join(gsdDir, "reports");
  mkdirSync(reportsDir, { recursive: true });
  const noIndex = loadReportsIndex(tmp);
  assert.equal(noIndex, null, "empty reports dir should return null index");
  const index = {
    version: 1,
    projectName: "test-project",
    projectPath: tmp,
    gsdVersion: "2.27.0",
    entries: [
      {
        filename: "M001-2026-01-01T00-00-00.html",
        generatedAt: "2026-01-01T00:00:00.000Z",
        milestoneId: "M001",
        milestoneTitle: "First Milestone",
        label: "M001: First Milestone",
        kind: "milestone",
        totalCost: 0.5,
        totalTokens: 1e4,
        totalDuration: 6e4,
        doneSlices: 3,
        totalSlices: 3,
        doneMilestones: 1,
        totalMilestones: 3,
        phase: "complete"
      }
    ]
  };
  writeFileSync(join(reportsDir, "reports.json"), JSON.stringify(index), "utf-8");
  const loaded = loadReportsIndex(tmp);
  assert.ok(loaded, "should load existing reports index");
  assert.equal(loaded.entries.length, 1);
  assert.equal(loaded.entries[0].milestoneId, "M001");
  const existingIds = new Set(loaded.entries.map((e) => e.milestoneId));
  const allMilestones = [
    { id: "M001", title: "First Milestone", status: "complete" },
    { id: "M002", title: "Second Milestone", status: "complete" },
    { id: "M003", title: "Third Milestone", status: "active" }
  ];
  const targets = allMilestones.filter((m) => !existingIds.has(m.id));
  assert.equal(targets.length, 2, "should skip M001 and target M002 + M003");
  assert.equal(targets[0].id, "M002");
  assert.equal(targets[1].id, "M003");
  rmSync(tmp, { recursive: true, force: true });
});
test("handleExport --html --all sets milestone kind based on status", async () => {
  const completeMilestone = { id: "M001", status: "complete" };
  const activeMilestone = { id: "M002", status: "active" };
  const completeKind = completeMilestone.status === "complete" ? "milestone" : "manual";
  const activeKind = activeMilestone.status === "complete" ? "milestone" : "manual";
  assert.equal(completeKind, "milestone", "completed milestones get kind 'milestone'");
  assert.equal(activeKind, "manual", "active milestones get kind 'manual'");
});
test("export completions include --html and --html --all", async () => {
  const { registerGSDCommand } = await import("../commands.js");
  const commands = /* @__PURE__ */ new Map();
  const pi = {
    registerCommand(name, options) {
      commands.set(name, options);
    },
    registerTool() {
    },
    registerShortcut() {
    },
    on() {
    },
    sendMessage() {
    }
  };
  registerGSDCommand(pi);
  const gsd = commands.get("gsd");
  assert.ok(gsd, "should register /gsd command");
  const completions = gsd.getArgumentCompletions("export --");
  const labels = completions.map((c) => c.label);
  assert.ok(labels.includes("--html"), "completions should include --html");
  assert.ok(labels.includes("--html --all"), "completions should include --html --all");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9leHBvcnQtaHRtbC1hbGwudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2RpclN5bmMsIHdyaXRlRmlsZVN5bmMsIHJlYWRGaWxlU3luYywgcm1TeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuXG4vLyBUZXN0OiAtLWFsbCBmbGFnIGdlbmVyYXRlcyBzbmFwc2hvdHMgZm9yIG1pbGVzdG9uZXMgbm90IHlldCBpbiB0aGUgaW5kZXhcblxudGVzdChcImhhbmRsZUV4cG9ydCAtLWh0bWwgLS1hbGwgZ2VuZXJhdGVzIHJlcG9ydHMgZm9yIG1pbGVzdG9uZXMgbWlzc2luZyBmcm9tIHRoZSBpbmRleFwiLCBhc3luYyAoKSA9PiB7XG4gIC8vIFdlIHRlc3QgdGhlIGV4cG9ydCBsb2dpYyBpbmRpcmVjdGx5IGJ5IHZlcmlmeWluZyB0aGUgZmxhZyBwYXJzaW5nXG4gIC8vIGFuZCB0aGUgZGVkdXBsaWNhdGlvbiBsb2dpYyB2aWEgbG9hZFJlcG9ydHNJbmRleCArIG1pbGVzdG9uZSBmaWx0ZXJpbmdcbiAgY29uc3QgeyBsb2FkUmVwb3J0c0luZGV4IH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9yZXBvcnRzLmpzXCIpO1xuXG4gIGNvbnN0IHRtcCA9IGpvaW4odG1wZGlyKCksIGBnc2QtZXhwb3J0LWFsbC10ZXN0LSR7RGF0ZS5ub3coKX1gKTtcbiAgY29uc3QgZ3NkRGlyID0gam9pbih0bXAsIFwiLmdzZFwiKTtcbiAgY29uc3QgcmVwb3J0c0RpciA9IGpvaW4oZ3NkRGlyLCBcInJlcG9ydHNcIik7XG4gIG1rZGlyU3luYyhyZXBvcnRzRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAvLyBObyBleGlzdGluZyByZXBvcnRzIFx1MjAxNCBsb2FkUmVwb3J0c0luZGV4IHJldHVybnMgbnVsbFxuICBjb25zdCBub0luZGV4ID0gbG9hZFJlcG9ydHNJbmRleCh0bXApO1xuICBhc3NlcnQuZXF1YWwobm9JbmRleCwgbnVsbCwgXCJlbXB0eSByZXBvcnRzIGRpciBzaG91bGQgcmV0dXJuIG51bGwgaW5kZXhcIik7XG5cbiAgLy8gV3JpdGUgYSByZXBvcnRzLmpzb24gd2l0aCBNMDAxIGFscmVhZHkgcHJlc2VudFxuICBjb25zdCBpbmRleCA9IHtcbiAgICB2ZXJzaW9uOiAxLFxuICAgIHByb2plY3ROYW1lOiBcInRlc3QtcHJvamVjdFwiLFxuICAgIHByb2plY3RQYXRoOiB0bXAsXG4gICAgZ3NkVmVyc2lvbjogXCIyLjI3LjBcIixcbiAgICBlbnRyaWVzOiBbXG4gICAgICB7XG4gICAgICAgIGZpbGVuYW1lOiBcIk0wMDEtMjAyNi0wMS0wMVQwMC0wMC0wMC5odG1sXCIsXG4gICAgICAgIGdlbmVyYXRlZEF0OiBcIjIwMjYtMDEtMDFUMDA6MDA6MDAuMDAwWlwiLFxuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICAgIG1pbGVzdG9uZVRpdGxlOiBcIkZpcnN0IE1pbGVzdG9uZVwiLFxuICAgICAgICBsYWJlbDogXCJNMDAxOiBGaXJzdCBNaWxlc3RvbmVcIixcbiAgICAgICAga2luZDogXCJtaWxlc3RvbmVcIixcbiAgICAgICAgdG90YWxDb3N0OiAwLjUsXG4gICAgICAgIHRvdGFsVG9rZW5zOiAxMDAwMCxcbiAgICAgICAgdG90YWxEdXJhdGlvbjogNjAwMDAsXG4gICAgICAgIGRvbmVTbGljZXM6IDMsXG4gICAgICAgIHRvdGFsU2xpY2VzOiAzLFxuICAgICAgICBkb25lTWlsZXN0b25lczogMSxcbiAgICAgICAgdG90YWxNaWxlc3RvbmVzOiAzLFxuICAgICAgICBwaGFzZTogXCJjb21wbGV0ZVwiLFxuICAgICAgfSxcbiAgICBdLFxuICB9O1xuICB3cml0ZUZpbGVTeW5jKGpvaW4ocmVwb3J0c0RpciwgXCJyZXBvcnRzLmpzb25cIiksIEpTT04uc3RyaW5naWZ5KGluZGV4KSwgXCJ1dGYtOFwiKTtcblxuICAvLyBOb3cgbG9hZFJlcG9ydHNJbmRleCBzaG91bGQgZmluZCBNMDAxXG4gIGNvbnN0IGxvYWRlZCA9IGxvYWRSZXBvcnRzSW5kZXgodG1wKTtcbiAgYXNzZXJ0Lm9rKGxvYWRlZCwgXCJzaG91bGQgbG9hZCBleGlzdGluZyByZXBvcnRzIGluZGV4XCIpO1xuICBhc3NlcnQuZXF1YWwobG9hZGVkLmVudHJpZXMubGVuZ3RoLCAxKTtcbiAgYXNzZXJ0LmVxdWFsKGxvYWRlZC5lbnRyaWVzWzBdLm1pbGVzdG9uZUlkLCBcIk0wMDFcIik7XG5cbiAgLy8gU2ltdWxhdGUgdGhlIGRlZHVwbGljYXRpb24gbG9naWMgZnJvbSBoYW5kbGVFeHBvcnQgLS1hbGxcbiAgY29uc3QgZXhpc3RpbmdJZHMgPSBuZXcgU2V0KGxvYWRlZC5lbnRyaWVzLm1hcChlID0+IGUubWlsZXN0b25lSWQpKTtcbiAgY29uc3QgYWxsTWlsZXN0b25lcyA9IFtcbiAgICB7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiRmlyc3QgTWlsZXN0b25lXCIsIHN0YXR1czogXCJjb21wbGV0ZVwiIH0sXG4gICAgeyBpZDogXCJNMDAyXCIsIHRpdGxlOiBcIlNlY29uZCBNaWxlc3RvbmVcIiwgc3RhdHVzOiBcImNvbXBsZXRlXCIgfSxcbiAgICB7IGlkOiBcIk0wMDNcIiwgdGl0bGU6IFwiVGhpcmQgTWlsZXN0b25lXCIsIHN0YXR1czogXCJhY3RpdmVcIiB9LFxuICBdO1xuXG4gIGNvbnN0IHRhcmdldHMgPSBhbGxNaWxlc3RvbmVzLmZpbHRlcihtID0+ICFleGlzdGluZ0lkcy5oYXMobS5pZCkpO1xuICBhc3NlcnQuZXF1YWwodGFyZ2V0cy5sZW5ndGgsIDIsIFwic2hvdWxkIHNraXAgTTAwMSBhbmQgdGFyZ2V0IE0wMDIgKyBNMDAzXCIpO1xuICBhc3NlcnQuZXF1YWwodGFyZ2V0c1swXS5pZCwgXCJNMDAyXCIpO1xuICBhc3NlcnQuZXF1YWwodGFyZ2V0c1sxXS5pZCwgXCJNMDAzXCIpO1xuXG4gIC8vIENsZWFudXBcbiAgcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xufSk7XG5cbnRlc3QoXCJoYW5kbGVFeHBvcnQgLS1odG1sIC0tYWxsIHNldHMgbWlsZXN0b25lIGtpbmQgYmFzZWQgb24gc3RhdHVzXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgY29tcGxldGVNaWxlc3RvbmUgPSB7IGlkOiBcIk0wMDFcIiwgc3RhdHVzOiBcImNvbXBsZXRlXCIgfTtcbiAgY29uc3QgYWN0aXZlTWlsZXN0b25lID0geyBpZDogXCJNMDAyXCIsIHN0YXR1czogXCJhY3RpdmVcIiB9O1xuXG4gIC8vIExvZ2ljIGZyb20gdGhlIGltcGxlbWVudGF0aW9uXG4gIGNvbnN0IGNvbXBsZXRlS2luZCA9IGNvbXBsZXRlTWlsZXN0b25lLnN0YXR1cyA9PT0gXCJjb21wbGV0ZVwiID8gXCJtaWxlc3RvbmVcIiA6IFwibWFudWFsXCI7XG4gIGNvbnN0IGFjdGl2ZUtpbmQgPSBhY3RpdmVNaWxlc3RvbmUuc3RhdHVzID09PSBcImNvbXBsZXRlXCIgPyBcIm1pbGVzdG9uZVwiIDogXCJtYW51YWxcIjtcblxuICBhc3NlcnQuZXF1YWwoY29tcGxldGVLaW5kLCBcIm1pbGVzdG9uZVwiLCBcImNvbXBsZXRlZCBtaWxlc3RvbmVzIGdldCBraW5kICdtaWxlc3RvbmUnXCIpO1xuICBhc3NlcnQuZXF1YWwoYWN0aXZlS2luZCwgXCJtYW51YWxcIiwgXCJhY3RpdmUgbWlsZXN0b25lcyBnZXQga2luZCAnbWFudWFsJ1wiKTtcbn0pO1xuXG50ZXN0KFwiZXhwb3J0IGNvbXBsZXRpb25zIGluY2x1ZGUgLS1odG1sIGFuZCAtLWh0bWwgLS1hbGxcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IHJlZ2lzdGVyR1NEQ29tbWFuZCB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vY29tbWFuZHMuanNcIik7XG5cbiAgY29uc3QgY29tbWFuZHMgPSBuZXcgTWFwPHN0cmluZywgYW55PigpO1xuICBjb25zdCBwaSA9IHtcbiAgICByZWdpc3RlckNvbW1hbmQobmFtZTogc3RyaW5nLCBvcHRpb25zOiBhbnkpIHsgY29tbWFuZHMuc2V0KG5hbWUsIG9wdGlvbnMpOyB9LFxuICAgIHJlZ2lzdGVyVG9vbCgpIHt9LFxuICAgIHJlZ2lzdGVyU2hvcnRjdXQoKSB7fSxcbiAgICBvbigpIHt9LFxuICAgIHNlbmRNZXNzYWdlKCkge30sXG4gIH07XG5cbiAgcmVnaXN0ZXJHU0RDb21tYW5kKHBpIGFzIGFueSk7XG4gIGNvbnN0IGdzZCA9IGNvbW1hbmRzLmdldChcImdzZFwiKTtcbiAgYXNzZXJ0Lm9rKGdzZCwgXCJzaG91bGQgcmVnaXN0ZXIgL2dzZCBjb21tYW5kXCIpO1xuXG4gIGNvbnN0IGNvbXBsZXRpb25zID0gZ3NkLmdldEFyZ3VtZW50Q29tcGxldGlvbnMoXCJleHBvcnQgLS1cIik7XG4gIGNvbnN0IGxhYmVscyA9IGNvbXBsZXRpb25zLm1hcCgoYzogYW55KSA9PiBjLmxhYmVsKTtcbiAgYXNzZXJ0Lm9rKGxhYmVscy5pbmNsdWRlcyhcIi0taHRtbFwiKSwgXCJjb21wbGV0aW9ucyBzaG91bGQgaW5jbHVkZSAtLWh0bWxcIik7XG4gIGFzc2VydC5vayhsYWJlbHMuaW5jbHVkZXMoXCItLWh0bWwgLS1hbGxcIiksIFwiY29tcGxldGlvbnMgc2hvdWxkIGluY2x1ZGUgLS1odG1sIC0tYWxsXCIpO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsV0FBVyxlQUE2QixjQUFjO0FBQy9ELFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFJdkIsS0FBSyxxRkFBcUYsWUFBWTtBQUdwRyxRQUFNLEVBQUUsaUJBQWlCLElBQUksTUFBTSxPQUFPLGVBQWU7QUFFekQsUUFBTSxNQUFNLEtBQUssT0FBTyxHQUFHLHVCQUF1QixLQUFLLElBQUksQ0FBQyxFQUFFO0FBQzlELFFBQU0sU0FBUyxLQUFLLEtBQUssTUFBTTtBQUMvQixRQUFNLGFBQWEsS0FBSyxRQUFRLFNBQVM7QUFDekMsWUFBVSxZQUFZLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFHekMsUUFBTSxVQUFVLGlCQUFpQixHQUFHO0FBQ3BDLFNBQU8sTUFBTSxTQUFTLE1BQU0sNENBQTRDO0FBR3hFLFFBQU0sUUFBUTtBQUFBLElBQ1osU0FBUztBQUFBLElBQ1QsYUFBYTtBQUFBLElBQ2IsYUFBYTtBQUFBLElBQ2IsWUFBWTtBQUFBLElBQ1osU0FBUztBQUFBLE1BQ1A7QUFBQSxRQUNFLFVBQVU7QUFBQSxRQUNWLGFBQWE7QUFBQSxRQUNiLGFBQWE7QUFBQSxRQUNiLGdCQUFnQjtBQUFBLFFBQ2hCLE9BQU87QUFBQSxRQUNQLE1BQU07QUFBQSxRQUNOLFdBQVc7QUFBQSxRQUNYLGFBQWE7QUFBQSxRQUNiLGVBQWU7QUFBQSxRQUNmLFlBQVk7QUFBQSxRQUNaLGFBQWE7QUFBQSxRQUNiLGdCQUFnQjtBQUFBLFFBQ2hCLGlCQUFpQjtBQUFBLFFBQ2pCLE9BQU87QUFBQSxNQUNUO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFDQSxnQkFBYyxLQUFLLFlBQVksY0FBYyxHQUFHLEtBQUssVUFBVSxLQUFLLEdBQUcsT0FBTztBQUc5RSxRQUFNLFNBQVMsaUJBQWlCLEdBQUc7QUFDbkMsU0FBTyxHQUFHLFFBQVEsb0NBQW9DO0FBQ3RELFNBQU8sTUFBTSxPQUFPLFFBQVEsUUFBUSxDQUFDO0FBQ3JDLFNBQU8sTUFBTSxPQUFPLFFBQVEsQ0FBQyxFQUFFLGFBQWEsTUFBTTtBQUdsRCxRQUFNLGNBQWMsSUFBSSxJQUFJLE9BQU8sUUFBUSxJQUFJLE9BQUssRUFBRSxXQUFXLENBQUM7QUFDbEUsUUFBTSxnQkFBZ0I7QUFBQSxJQUNwQixFQUFFLElBQUksUUFBUSxPQUFPLG1CQUFtQixRQUFRLFdBQVc7QUFBQSxJQUMzRCxFQUFFLElBQUksUUFBUSxPQUFPLG9CQUFvQixRQUFRLFdBQVc7QUFBQSxJQUM1RCxFQUFFLElBQUksUUFBUSxPQUFPLG1CQUFtQixRQUFRLFNBQVM7QUFBQSxFQUMzRDtBQUVBLFFBQU0sVUFBVSxjQUFjLE9BQU8sT0FBSyxDQUFDLFlBQVksSUFBSSxFQUFFLEVBQUUsQ0FBQztBQUNoRSxTQUFPLE1BQU0sUUFBUSxRQUFRLEdBQUcseUNBQXlDO0FBQ3pFLFNBQU8sTUFBTSxRQUFRLENBQUMsRUFBRSxJQUFJLE1BQU07QUFDbEMsU0FBTyxNQUFNLFFBQVEsQ0FBQyxFQUFFLElBQUksTUFBTTtBQUdsQyxTQUFPLEtBQUssRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFDOUMsQ0FBQztBQUVELEtBQUssaUVBQWlFLFlBQVk7QUFDaEYsUUFBTSxvQkFBb0IsRUFBRSxJQUFJLFFBQVEsUUFBUSxXQUFXO0FBQzNELFFBQU0sa0JBQWtCLEVBQUUsSUFBSSxRQUFRLFFBQVEsU0FBUztBQUd2RCxRQUFNLGVBQWUsa0JBQWtCLFdBQVcsYUFBYSxjQUFjO0FBQzdFLFFBQU0sYUFBYSxnQkFBZ0IsV0FBVyxhQUFhLGNBQWM7QUFFekUsU0FBTyxNQUFNLGNBQWMsYUFBYSwyQ0FBMkM7QUFDbkYsU0FBTyxNQUFNLFlBQVksVUFBVSxxQ0FBcUM7QUFDMUUsQ0FBQztBQUVELEtBQUssc0RBQXNELFlBQVk7QUFDckUsUUFBTSxFQUFFLG1CQUFtQixJQUFJLE1BQU0sT0FBTyxnQkFBZ0I7QUFFNUQsUUFBTSxXQUFXLG9CQUFJLElBQWlCO0FBQ3RDLFFBQU0sS0FBSztBQUFBLElBQ1QsZ0JBQWdCLE1BQWMsU0FBYztBQUFFLGVBQVMsSUFBSSxNQUFNLE9BQU87QUFBQSxJQUFHO0FBQUEsSUFDM0UsZUFBZTtBQUFBLElBQUM7QUFBQSxJQUNoQixtQkFBbUI7QUFBQSxJQUFDO0FBQUEsSUFDcEIsS0FBSztBQUFBLElBQUM7QUFBQSxJQUNOLGNBQWM7QUFBQSxJQUFDO0FBQUEsRUFDakI7QUFFQSxxQkFBbUIsRUFBUztBQUM1QixRQUFNLE1BQU0sU0FBUyxJQUFJLEtBQUs7QUFDOUIsU0FBTyxHQUFHLEtBQUssOEJBQThCO0FBRTdDLFFBQU0sY0FBYyxJQUFJLHVCQUF1QixXQUFXO0FBQzFELFFBQU0sU0FBUyxZQUFZLElBQUksQ0FBQyxNQUFXLEVBQUUsS0FBSztBQUNsRCxTQUFPLEdBQUcsT0FBTyxTQUFTLFFBQVEsR0FBRyxtQ0FBbUM7QUFDeEUsU0FBTyxHQUFHLE9BQU8sU0FBUyxjQUFjLEdBQUcseUNBQXlDO0FBQ3RGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
