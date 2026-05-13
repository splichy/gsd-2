import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveState, invalidateStateCache } from "../state.js";
import { closeDatabase, insertMilestone, insertSlice, openDatabase } from "../gsd-db.js";
let tempBase = null;
afterEach(() => {
  closeDatabase();
  invalidateStateCache();
  if (tempBase) rmSync(tempBase, { recursive: true, force: true });
  tempBase = null;
});
describe("stale slice row DB-authoritative boundary", () => {
  test("a stale SUMMARY.md projection does not make a DB-pending slice complete", async () => {
    tempBase = mkdtempSync(join(tmpdir(), "gsd-stale-slice-"));
    const sliceDir = join(tempBase, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(sliceDir, { recursive: true });
    writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# S01 Summary\n", "utf-8");
    openDatabase(join(tempBase, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "DB authority", status: "active", depends_on: [] });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      title: "Still pending",
      status: "pending",
      risk: "low",
      depends: [],
      demo: "",
      sequence: 1
    });
    const state = await deriveState(tempBase);
    assert.equal(state.activeSlice?.id, "S01");
    assert.equal(state.phase, "planning");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9zdGFsZS1zbGljZS1yb3dzLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogVmVyaWZ5IHRoYXQgc3RhdGUgZGVyaXZhdGlvbiB0cmVhdHMgREIgc2xpY2Ugcm93cyBhcyBhdXRob3JpdGF0aXZlIG92ZXJcbiAqIHN0YWxlIG1hcmtkb3duIHByb2plY3Rpb25zLlxuICovXG5cbmltcG9ydCB7IGRlc2NyaWJlLCB0ZXN0LCBhZnRlckVhY2ggfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZGlyU3luYywgbWtkdGVtcFN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcblxuaW1wb3J0IHsgZGVyaXZlU3RhdGUsIGludmFsaWRhdGVTdGF0ZUNhY2hlIH0gZnJvbSBcIi4uL3N0YXRlLnRzXCI7XG5pbXBvcnQgeyBjbG9zZURhdGFiYXNlLCBpbnNlcnRNaWxlc3RvbmUsIGluc2VydFNsaWNlLCBvcGVuRGF0YWJhc2UgfSBmcm9tIFwiLi4vZ3NkLWRiLnRzXCI7XG5cbmxldCB0ZW1wQmFzZTogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cbmFmdGVyRWFjaCgoKSA9PiB7XG4gIGNsb3NlRGF0YWJhc2UoKTtcbiAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgaWYgKHRlbXBCYXNlKSBybVN5bmModGVtcEJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgdGVtcEJhc2UgPSBudWxsO1xufSk7XG5cbmRlc2NyaWJlKFwic3RhbGUgc2xpY2Ugcm93IERCLWF1dGhvcml0YXRpdmUgYm91bmRhcnlcIiwgKCkgPT4ge1xuICB0ZXN0KFwiYSBzdGFsZSBTVU1NQVJZLm1kIHByb2plY3Rpb24gZG9lcyBub3QgbWFrZSBhIERCLXBlbmRpbmcgc2xpY2UgY29tcGxldGVcIiwgYXN5bmMgKCkgPT4ge1xuICAgIHRlbXBCYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2Qtc3RhbGUtc2xpY2UtXCIpKTtcbiAgICBjb25zdCBzbGljZURpciA9IGpvaW4odGVtcEJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIpO1xuICAgIG1rZGlyU3luYyhzbGljZURpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHNsaWNlRGlyLCBcIlMwMS1TVU1NQVJZLm1kXCIpLCBcIiMgUzAxIFN1bW1hcnlcXG5cIiwgXCJ1dGYtOFwiKTtcblxuICAgIG9wZW5EYXRhYmFzZShqb2luKHRlbXBCYXNlLCBcIi5nc2RcIiwgXCJnc2QuZGJcIikpO1xuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiREIgYXV0aG9yaXR5XCIsIHN0YXR1czogXCJhY3RpdmVcIiwgZGVwZW5kc19vbjogW10gfSk7XG4gICAgaW5zZXJ0U2xpY2Uoe1xuICAgICAgaWQ6IFwiUzAxXCIsXG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICB0aXRsZTogXCJTdGlsbCBwZW5kaW5nXCIsXG4gICAgICBzdGF0dXM6IFwicGVuZGluZ1wiLFxuICAgICAgcmlzazogXCJsb3dcIixcbiAgICAgIGRlcGVuZHM6IFtdLFxuICAgICAgZGVtbzogXCJcIixcbiAgICAgIHNlcXVlbmNlOiAxLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZSh0ZW1wQmFzZSk7XG5cbiAgICBhc3NlcnQuZXF1YWwoc3RhdGUuYWN0aXZlU2xpY2U/LmlkLCBcIlMwMVwiKTtcbiAgICBhc3NlcnQuZXF1YWwoc3RhdGUucGhhc2UsIFwicGxhbm5pbmdcIik7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFLQSxTQUFTLFVBQVUsTUFBTSxpQkFBaUI7QUFDMUMsT0FBTyxZQUFZO0FBQ25CLFNBQVMsV0FBVyxhQUFhLFFBQVEscUJBQXFCO0FBQzlELFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFFdkIsU0FBUyxhQUFhLDRCQUE0QjtBQUNsRCxTQUFTLGVBQWUsaUJBQWlCLGFBQWEsb0JBQW9CO0FBRTFFLElBQUksV0FBMEI7QUFFOUIsVUFBVSxNQUFNO0FBQ2QsZ0JBQWM7QUFDZCx1QkFBcUI7QUFDckIsTUFBSSxTQUFVLFFBQU8sVUFBVSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUMvRCxhQUFXO0FBQ2IsQ0FBQztBQUVELFNBQVMsNkNBQTZDLE1BQU07QUFDMUQsT0FBSywyRUFBMkUsWUFBWTtBQUMxRixlQUFXLFlBQVksS0FBSyxPQUFPLEdBQUcsa0JBQWtCLENBQUM7QUFDekQsVUFBTSxXQUFXLEtBQUssVUFBVSxRQUFRLGNBQWMsUUFBUSxVQUFVLEtBQUs7QUFDN0UsY0FBVSxVQUFVLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDdkMsa0JBQWMsS0FBSyxVQUFVLGdCQUFnQixHQUFHLG1CQUFtQixPQUFPO0FBRTFFLGlCQUFhLEtBQUssVUFBVSxRQUFRLFFBQVEsQ0FBQztBQUM3QyxvQkFBZ0IsRUFBRSxJQUFJLFFBQVEsT0FBTyxnQkFBZ0IsUUFBUSxVQUFVLFlBQVksQ0FBQyxFQUFFLENBQUM7QUFDdkYsZ0JBQVk7QUFBQSxNQUNWLElBQUk7QUFBQSxNQUNKLGFBQWE7QUFBQSxNQUNiLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLE1BQU07QUFBQSxNQUNOLFNBQVMsQ0FBQztBQUFBLE1BQ1YsTUFBTTtBQUFBLE1BQ04sVUFBVTtBQUFBLElBQ1osQ0FBQztBQUVELFVBQU0sUUFBUSxNQUFNLFlBQVksUUFBUTtBQUV4QyxXQUFPLE1BQU0sTUFBTSxhQUFhLElBQUksS0FBSztBQUN6QyxXQUFPLE1BQU0sTUFBTSxPQUFPLFVBQVU7QUFBQSxFQUN0QyxDQUFDO0FBQ0gsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
