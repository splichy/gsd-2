import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDatabase, insertMilestone, insertSlice, openDatabase } from "../gsd-db.js";
import { renderAllProjections } from "../workflow-projections.js";
describe("renderAllProjections must not overwrite PLAN.md (#3651)", () => {
  it("preserves authoritative PLAN.md while rendering other projections", async () => {
    const base = mkdtempSync(join(tmpdir(), "gsd-projection-plan-"));
    const msDir = join(base, ".gsd", "milestones", "M001");
    const sliceDir = join(msDir, "slices", "S01");
    const planPath = join(sliceDir, "S01-PLAN.md");
    const planContent = [
      "# S01 Plan",
      "",
      "## Must-Haves",
      "",
      "- preserve this authoritative section",
      ""
    ].join("\n");
    try {
      mkdirSync(sliceDir, { recursive: true });
      writeFileSync(join(msDir, "M001-ROADMAP.md"), "# Roadmap\n\n## Slices\n\n- [ ] **S01: Slice** `risk:low` `depends:[]`\n");
      writeFileSync(planPath, planContent);
      openDatabase(join(base, ".gsd", "gsd.db"));
      insertMilestone({ id: "M001", title: "Milestone", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
      await renderAllProjections(base, "M001");
      assert.equal(readFileSync(planPath, "utf-8"), planContent);
      assert.ok(readFileSync(join(base, ".gsd", "STATE.md"), "utf-8").includes("M001"));
    } finally {
      closeDatabase();
      rmSync(base, { recursive: true, force: true });
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wcm9qZWN0aW9uLW5vLXBsYW4tb3ZlcndyaXRlLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogUmVncmVzc2lvbiB0ZXN0IGZvciAjMzY1MSBcdTIwMTQgcmVuZGVyQWxsUHJvamVjdGlvbnMgbXVzdCBOT1QgY2FsbCByZW5kZXJQbGFuUHJvamVjdGlvblxuICpcbiAqIHJlbmRlckFsbFByb2plY3Rpb25zIHByZXZpb3VzbHkgY2FsbGVkIHJlbmRlclBsYW5Qcm9qZWN0aW9uIGluc2lkZSB0aGUgc2xpY2VcbiAqIGxvb3AsIHdoaWNoIG92ZXJ3cm90ZSB0aGUgYXV0aG9yaXRhdGl2ZSBQTEFOLm1kIChwcm9kdWNlZCBieSBtYXJrZG93bi1yZW5kZXJlci5qc1xuICogaW4gcGxhbi1zbGljZS9yZXBsYW4tc2xpY2UgdG9vbHMpIHdpdGggYSBzaW1wbGlmaWVkIHByb2plY3Rpb24gdGhhdCB3YXMgbWlzc2luZ1xuICoga2V5IHNlY3Rpb25zIChNdXN0LUhhdmVzLCBWZXJpZmljYXRpb24sIEZpbGVzIExpa2VseSBUb3VjaGVkKSBhbmQgY29ycnVwdGVkXG4gKiBtdWx0aS1saW5lIHRhc2sgZGVzY3JpcHRpb25zLlxuICpcbiAqIFRoZSBmaXggcmVtb3ZlcyB0aGUgcmVuZGVyUGxhblByb2plY3Rpb24gY2FsbCBmcm9tIHRoZSByZW5kZXJBbGxQcm9qZWN0aW9uc1xuICogbG9vcC4gVGhlIHJlbmRlcklmTWlzc2luZyByZWNvdmVyeSBwYXRoIGlzIHByZXNlcnZlZC5cbiAqL1xuXG5pbXBvcnQgeyBkZXNjcmliZSwgaXQgfSBmcm9tICdub2RlOnRlc3QnXG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCdcbmltcG9ydCB7IG1rZGlyU3luYywgbWtkdGVtcFN5bmMsIHJlYWRGaWxlU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSAnbm9kZTpmcydcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdub2RlOnBhdGgnXG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tICdub2RlOm9zJ1xuaW1wb3J0IHsgY2xvc2VEYXRhYmFzZSwgaW5zZXJ0TWlsZXN0b25lLCBpbnNlcnRTbGljZSwgb3BlbkRhdGFiYXNlIH0gZnJvbSAnLi4vZ3NkLWRiLnRzJ1xuaW1wb3J0IHsgcmVuZGVyQWxsUHJvamVjdGlvbnMgfSBmcm9tICcuLi93b3JrZmxvdy1wcm9qZWN0aW9ucy50cydcblxuZGVzY3JpYmUoJ3JlbmRlckFsbFByb2plY3Rpb25zIG11c3Qgbm90IG92ZXJ3cml0ZSBQTEFOLm1kICgjMzY1MSknLCAoKSA9PiB7XG4gIGl0KCdwcmVzZXJ2ZXMgYXV0aG9yaXRhdGl2ZSBQTEFOLm1kIHdoaWxlIHJlbmRlcmluZyBvdGhlciBwcm9qZWN0aW9ucycsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgJ2dzZC1wcm9qZWN0aW9uLXBsYW4tJykpXG4gICAgY29uc3QgbXNEaXIgPSBqb2luKGJhc2UsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScpXG4gICAgY29uc3Qgc2xpY2VEaXIgPSBqb2luKG1zRGlyLCAnc2xpY2VzJywgJ1MwMScpXG4gICAgY29uc3QgcGxhblBhdGggPSBqb2luKHNsaWNlRGlyLCAnUzAxLVBMQU4ubWQnKVxuICAgIGNvbnN0IHBsYW5Db250ZW50ID0gW1xuICAgICAgJyMgUzAxIFBsYW4nLFxuICAgICAgJycsXG4gICAgICAnIyMgTXVzdC1IYXZlcycsXG4gICAgICAnJyxcbiAgICAgICctIHByZXNlcnZlIHRoaXMgYXV0aG9yaXRhdGl2ZSBzZWN0aW9uJyxcbiAgICAgICcnLFxuICAgIF0uam9pbignXFxuJylcblxuICAgIHRyeSB7XG4gICAgICBta2RpclN5bmMoc2xpY2VEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pXG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4obXNEaXIsICdNMDAxLVJPQURNQVAubWQnKSwgJyMgUm9hZG1hcFxcblxcbiMjIFNsaWNlc1xcblxcbi0gWyBdICoqUzAxOiBTbGljZSoqIGByaXNrOmxvd2AgYGRlcGVuZHM6W11gXFxuJylcbiAgICAgIHdyaXRlRmlsZVN5bmMocGxhblBhdGgsIHBsYW5Db250ZW50KVxuICAgICAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgJy5nc2QnLCAnZ3NkLmRiJykpXG4gICAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogJ00wMDEnLCB0aXRsZTogJ01pbGVzdG9uZScsIHN0YXR1czogJ2FjdGl2ZScgfSlcbiAgICAgIGluc2VydFNsaWNlKHsgaWQ6ICdTMDEnLCBtaWxlc3RvbmVJZDogJ00wMDEnLCB0aXRsZTogJ1NsaWNlJywgc3RhdHVzOiAncGVuZGluZycgfSlcblxuICAgICAgYXdhaXQgcmVuZGVyQWxsUHJvamVjdGlvbnMoYmFzZSwgJ00wMDEnKVxuXG4gICAgICBhc3NlcnQuZXF1YWwocmVhZEZpbGVTeW5jKHBsYW5QYXRoLCAndXRmLTgnKSwgcGxhbkNvbnRlbnQpXG4gICAgICBhc3NlcnQub2socmVhZEZpbGVTeW5jKGpvaW4oYmFzZSwgJy5nc2QnLCAnU1RBVEUubWQnKSwgJ3V0Zi04JykuaW5jbHVkZXMoJ00wMDEnKSlcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xvc2VEYXRhYmFzZSgpXG4gICAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pXG4gICAgfVxuICB9KVxufSlcbiJdLAogICJtYXBwaW5ncyI6ICJBQWFBLFNBQVMsVUFBVSxVQUFVO0FBQzdCLE9BQU8sWUFBWTtBQUNuQixTQUFTLFdBQVcsYUFBYSxjQUFjLFFBQVEscUJBQXFCO0FBQzVFLFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFDdkIsU0FBUyxlQUFlLGlCQUFpQixhQUFhLG9CQUFvQjtBQUMxRSxTQUFTLDRCQUE0QjtBQUVyQyxTQUFTLDJEQUEyRCxNQUFNO0FBQ3hFLEtBQUcscUVBQXFFLFlBQVk7QUFDbEYsVUFBTSxPQUFPLFlBQVksS0FBSyxPQUFPLEdBQUcsc0JBQXNCLENBQUM7QUFDL0QsVUFBTSxRQUFRLEtBQUssTUFBTSxRQUFRLGNBQWMsTUFBTTtBQUNyRCxVQUFNLFdBQVcsS0FBSyxPQUFPLFVBQVUsS0FBSztBQUM1QyxVQUFNLFdBQVcsS0FBSyxVQUFVLGFBQWE7QUFDN0MsVUFBTSxjQUFjO0FBQUEsTUFDbEI7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLElBQ0YsRUFBRSxLQUFLLElBQUk7QUFFWCxRQUFJO0FBQ0YsZ0JBQVUsVUFBVSxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3ZDLG9CQUFjLEtBQUssT0FBTyxpQkFBaUIsR0FBRywwRUFBMEU7QUFDeEgsb0JBQWMsVUFBVSxXQUFXO0FBQ25DLG1CQUFhLEtBQUssTUFBTSxRQUFRLFFBQVEsQ0FBQztBQUN6QyxzQkFBZ0IsRUFBRSxJQUFJLFFBQVEsT0FBTyxhQUFhLFFBQVEsU0FBUyxDQUFDO0FBQ3BFLGtCQUFZLEVBQUUsSUFBSSxPQUFPLGFBQWEsUUFBUSxPQUFPLFNBQVMsUUFBUSxVQUFVLENBQUM7QUFFakYsWUFBTSxxQkFBcUIsTUFBTSxNQUFNO0FBRXZDLGFBQU8sTUFBTSxhQUFhLFVBQVUsT0FBTyxHQUFHLFdBQVc7QUFDekQsYUFBTyxHQUFHLGFBQWEsS0FBSyxNQUFNLFFBQVEsVUFBVSxHQUFHLE9BQU8sRUFBRSxTQUFTLE1BQU0sQ0FBQztBQUFBLElBQ2xGLFVBQUU7QUFDQSxvQkFBYztBQUNkLGFBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQy9DO0FBQUEsRUFDRixDQUFDO0FBQ0gsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
